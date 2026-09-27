'use strict'

/**
 * Incremental visual index of Listing History product folders.
 *
 * UPDATE CONTRACT
 * ----------------------------------------------------------------------------
 * Re-running is the point. The operator (or a cron/CLI) calls `updateIndex`
 * whenever History gains a new batch, a photo is replaced, or a folder is
 * moved. The job is content-addressed:
 *
 *   • folder identity = POSIX product_key (shop/batch/product)
 *   • image identity  = size + mtime, then SHA-256 if those moved
 *   • skip hash/embed when sha + algo still match
 *   • folders that vanished from disk are marked `missing`, not deleted,
 *     so a yesterday-match still explains where the product used to live
 *
 * Never embeds the whole 27k-image tree. Each folder contributes its first
 * N natural-sorted photos (default 3: hero + two supporting shots). dHash
 * is always local and free; embeddings reuse the same VISION_API_KEY /
 * google/gemini-embedding-2 stack as find-by-photo.
 *
 * Concurrent updates are serialised in-process. A second call while a job
 * is running returns the live progress instead of starting a second bill.
 */

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const sharp = require('sharp')
const { PRODUCT_HASH_ALGO, computeDHash, computeDesignHash } = require('../route/product-image-hash')
const embed = require('../route/product-image-embed')
const catalog = require('./history-catalog')
const cost = require('./history-cost')

const HASH_WORKING_EDGE = 320
const UPDATE_CONCURRENCY = 4
const EMBED_BATCH = 8
const META_ROOT = 'root'
const META_LAST_RUN = 'last_run'
const META_LAST_ERROR = 'last_error'

let _job = idleJob()
let _memIndex = null

function idleJob() {
	return {
		running: false,
		started_at: null,
		finished_at: null,
		phase: 'idle',
		root: null,
		folders_total: 0,
		folders_done: 0,
		images_hashed: 0,
		images_embedded: 0,
		images_skipped: 0,
		folders_added: 0,
		folders_updated: 0,
		folders_missing: 0,
		error: null,
		embed: true,
	}
}

function cloneJob() {
	return { ..._job }
}

function sha256(buf) {
	return crypto.createHash('sha256').update(buf).digest('hex')
}

function nowSec() {
	return Math.floor(Date.now() / 1000)
}

function readFileSafe(filePath) {
	try {
		return fs.readFileSync(filePath)
	} catch {
		return null
	}
}

async function mapPool(items, concurrency, fn) {
	const list = Array.isArray(items) ? items : []
	if (!list.length) return
	const workers = Math.max(1, Math.min(concurrency, list.length))
	let next = 0
	await Promise.all(
		Array.from({ length: workers }, async () => {
			while (next < list.length) {
				const index = next++
				await fn(list[index], index)
			}
		}),
	)
}

function setMeta(db, key, value) {
	db.prepare(
		`INSERT INTO history_index_meta (key, value, updated_at)
		 VALUES (?, ?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
	).run(String(key), value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value), nowSec())
}

function getMeta(db, key) {
	try {
		const row = db.prepare('SELECT value, updated_at FROM history_index_meta WHERE key = ?').get(String(key))
		return row || null
	} catch {
		return null
	}
}

function parseMetaJson(row) {
	if (!row || row.value == null || row.value === '') return null
	try {
		return JSON.parse(row.value)
	} catch {
		return null
	}
}

function invalidateMemIndex() {
	_memIndex = null
}

function loadEmbeddingIndex(db, algo) {
	const useAlgo = algo || embed.embedAlgo()
	if (_memIndex && _memIndex.algo === useAlgo && _memIndex.db === db) return _memIndex.items
	let rows = []
	try {
		rows = db
			.prepare(
				`SELECT i.id AS image_id, i.folder_id, i.dim, i.embedding, f.shop
				 FROM history_image i
				 JOIN history_folder f ON f.id = i.folder_id
				 WHERE i.embed_algo = ? AND i.embedding IS NOT NULL AND f.status = 'active'`,
			)
			.all(useAlgo)
	} catch {
		_memIndex = { db, algo: useAlgo, items: [] }
		return _memIndex.items
	}
	const items = []
	for (const row of rows) {
		const vec = embed.blobToEmbedding(row.embedding)
		if (!vec || vec.length !== Number(row.dim)) continue
		items.push({ image_id: Number(row.image_id), folder_id: Number(row.folder_id), shop: row.shop, vec })
	}
	_memIndex = { db, algo: useAlgo, items }
	return items
}

function loadHashRows(db) {
	try {
		return db
			.prepare(
				`SELECT i.id AS image_id, i.folder_id, i.filename, i.role, i.phash, i.design_phash, f.shop
				 FROM history_image i
				 JOIN history_folder f ON f.id = i.folder_id
				 WHERE i.hash_algo = ? AND i.phash IS NOT NULL AND f.status = 'active'`,
			)
			.all(PRODUCT_HASH_ALGO)
	} catch {
		return []
	}
}

async function prepareWorkingJpeg(buf) {
	const meta = await sharp(buf, { failOn: 'none' }).metadata()
	const w = Number(meta.width) || 0
	const h = Number(meta.height) || 0
	if (!w || !h || (w <= HASH_WORKING_EDGE && h <= HASH_WORKING_EDGE && !(meta.orientation && meta.orientation > 1))) {
		return buf
	}
	return sharp(buf, { failOn: 'none' })
		.rotate()
		.resize({
			width: HASH_WORKING_EDGE,
			height: HASH_WORKING_EDGE,
			fit: 'inside',
			withoutEnlargement: true,
		})
		.toBuffer()
}

async function hashBuffer(buf) {
	const working = await prepareWorkingJpeg(buf)
	const [phash, design] = await Promise.all([computeDHash(working), computeDesignHash(working)])
	return { phash, design_phash: design }
}

function upsertFolder(db, disk) {
	const now = nowSec()
	db.prepare(
		`INSERT INTO history_folder (
			product_key, folder_path, shop, batch, product, product_hint,
			hero_filename, image_count, indexed_images, mtime_ms, status, indexed_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'active', ?)
		ON CONFLICT(product_key) DO UPDATE SET
			folder_path = excluded.folder_path,
			shop = excluded.shop,
			batch = excluded.batch,
			product = excluded.product,
			product_hint = excluded.product_hint,
			hero_filename = excluded.hero_filename,
			image_count = excluded.image_count,
			mtime_ms = excluded.mtime_ms,
			status = 'active'`,
	).run(
		disk.product_key,
		disk.folder_path,
		disk.shop,
		disk.batch || '',
		disk.product,
		disk.product_hint,
		disk.images[0] ? disk.images[0].filename : null,
		disk.image_count,
		disk.mtime_ms,
		now,
	)
	return db.prepare('SELECT * FROM history_folder WHERE product_key = ?').get(disk.product_key)
}

function existingImagesByFilename(db, folderId) {
	const map = new Map()
	for (const row of db.prepare('SELECT * FROM history_image WHERE folder_id = ?').all(folderId)) {
		map.set(row.filename, row)
	}
	return map
}

function imageUnchanged(row, diskImage) {
	if (!row) return false
	if (Number(row.bytes) === Number(diskImage.bytes) && Number(row.mtime_ms) === Number(diskImage.mtime_ms)) {
		return Boolean(row.sha && row.phash && row.hash_algo === PRODUCT_HASH_ALGO)
	}
	return false
}

function needsEmbed(row, algo) {
	if (!row) return true
	if (!row.embedding || !row.embed_algo) return true
	if (row.embed_algo !== algo) return true
	if (!Number(row.dim)) return true
	return false
}

async function indexOneImage(db, folderId, diskImage, role, opts) {
	const existing = opts.existing.get(diskImage.filename)
	const algo = opts.embedAlgo
	const wantEmbed = opts.embed !== false

	if (imageUnchanged(existing, diskImage) && (!wantEmbed || !needsEmbed(existing, algo))) {
		_job.images_skipped++
		return { skipped: true, row: existing }
	}

	const buf = readFileSafe(diskImage.path)
	if (!buf || !buf.length) return { skipped: true, row: existing || null }
	const sha = sha256(buf)
	const sameBytes = Boolean(existing && existing.sha === sha)

	let phash = sameBytes ? existing.phash : null
	let design = sameBytes ? existing.design_phash : null
	if (!phash || !existing || existing.hash_algo !== PRODUCT_HASH_ALGO) {
		try {
			const hashed = opts.hash ? await opts.hash(buf) : await hashBuffer(buf)
			phash = hashed.phash
			design = hashed.design_phash
			_job.images_hashed++
		} catch {
			return { skipped: true, row: existing || null }
		}
	} else {
		_job.images_skipped++
	}

	let dim = sameBytes ? existing.dim : null
	let embedAlgo = sameBytes ? existing.embed_algo : null
	let embedding = sameBytes ? existing.embedding : null
	const haveGoodEmbed = sameBytes && !needsEmbed(existing, algo)
	if (wantEmbed && !haveGoodEmbed) {
		try {
			const vec = opts.embedFn ? await opts.embedFn(buf) : await embed.computeEmbedding(buf, opts.embedOpts || {})
			if (vec && vec.length) {
				embedding = embed.embeddingToBlob(vec)
				dim = vec.length
				embedAlgo = algo
				_job.images_embedded++
			}
		} catch (err) {
			if (process.env.HISTORY_INDEX_DEBUG) {
				console.warn('[history-index] embed failed', diskImage.path, err && err.message)
			}
		}
	}

	db.prepare(
		`INSERT INTO history_image (
			folder_id, filename, bytes, mtime_ms, sha, role,
			phash, design_phash, hash_algo, dim, embed_algo, embedding, computed_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(folder_id, filename) DO UPDATE SET
			bytes = excluded.bytes,
			mtime_ms = excluded.mtime_ms,
			sha = excluded.sha,
			role = excluded.role,
			phash = excluded.phash,
			design_phash = excluded.design_phash,
			hash_algo = excluded.hash_algo,
			dim = excluded.dim,
			embed_algo = excluded.embed_algo,
			embedding = excluded.embedding,
			computed_at = excluded.computed_at`,
	).run(
		folderId,
		diskImage.filename,
		diskImage.bytes,
		diskImage.mtime_ms,
		sha,
		role,
		phash,
		design,
		PRODUCT_HASH_ALGO,
		dim,
		embedAlgo,
		embedding,
		nowSec(),
	)
	invalidateMemIndex()
	return { skipped: false, row: db.prepare('SELECT * FROM history_image WHERE folder_id = ? AND filename = ?').get(folderId, diskImage.filename) }
}

function dropStaleImages(db, folderId, keepNames) {
	const keep = new Set(keepNames)
	const rows = db.prepare('SELECT id, filename FROM history_image WHERE folder_id = ?').all(folderId)
	const del = db.prepare('DELETE FROM history_image WHERE id = ?')
	let n = 0
	for (const row of rows) {
		if (keep.has(row.filename)) continue
		del.run(row.id)
		n++
	}
	if (n) invalidateMemIndex()
	return n
}

async function indexFolder(db, disk, opts) {
	const before = db.prepare('SELECT id, indexed_images FROM history_folder WHERE product_key = ?').get(disk.product_key)
	const folder = upsertFolder(db, disk)
	const folderId = Number(folder.id)
	const existing = existingImagesByFilename(db, folderId)
	const names = []
	for (let i = 0; i < disk.images.length; i++) {
		const img = disk.images[i]
		names.push(img.filename)
		await indexOneImage(db, folderId, img, i === 0 ? 'hero' : 'extra', { ...opts, existing })
	}
	dropStaleImages(db, folderId, names)
	const indexed = db.prepare('SELECT COUNT(*) AS n FROM history_image WHERE folder_id = ?').get(folderId).n
	db.prepare('UPDATE history_folder SET indexed_images = ?, indexed_at = ? WHERE id = ?').run(indexed, nowSec(), folderId)
	if (!before) _job.folders_added++
	else if (Number(before.indexed_images) !== Number(indexed)) _job.folders_updated++
	_job.folders_done++
}

function markMissing(db, seenKeys) {
	const rows = db.prepare("SELECT id, product_key FROM history_folder WHERE status = 'active'").all()
	const gone = db.prepare("UPDATE history_folder SET status = 'missing', indexed_at = ? WHERE id = ?")
	let n = 0
	for (const row of rows) {
		if (seenKeys.has(row.product_key)) continue
		gone.run(nowSec(), row.id)
		n++
	}
	if (n) invalidateMemIndex()
	_job.folders_missing = n
	return n
}

function pendingEmbedCount(db, algo) {
	try {
		return (
			Number(
				db
					.prepare(
						`SELECT COUNT(*) AS n
						 FROM history_image i
						 JOIN history_folder f ON f.id = i.folder_id
						 WHERE f.status = 'active'
						   AND (i.embedding IS NULL OR i.embed_algo IS NULL OR i.embed_algo <> ?)`,
					)
					.get(algo || embed.embedAlgo()).n,
			) || 0
		)
	} catch {
		return 0
	}
}

function folderStats(db) {
	const empty = { folders: 0, missing: 0, images: 0, embedded: 0, hashed: 0 }
	try {
		const folders = db.prepare("SELECT COUNT(*) AS n FROM history_folder WHERE status = 'active'").get().n || 0
		const missing = db.prepare("SELECT COUNT(*) AS n FROM history_folder WHERE status = 'missing'").get().n || 0
		const images = db.prepare(
			`SELECT COUNT(*) AS n FROM history_image i JOIN history_folder f ON f.id = i.folder_id WHERE f.status = 'active'`,
		).get().n || 0
		const hashed = db.prepare(
			`SELECT COUNT(*) AS n FROM history_image i JOIN history_folder f ON f.id = i.folder_id WHERE f.status = 'active' AND i.phash IS NOT NULL`,
		).get().n || 0
		const embedded = db.prepare(
			`SELECT COUNT(*) AS n FROM history_image i JOIN history_folder f ON f.id = i.folder_id WHERE f.status = 'active' AND i.embedding IS NOT NULL`,
		).get().n || 0
		return { folders, missing, images, hashed, embedded }
	} catch {
		return empty
	}
}

function status(db, opts = {}) {
	catalog.ensureSchema(db)
	const root = opts.root || catalog.defaultHistoryRoot()
	const stats = folderStats(db)
	const pending = pendingEmbedCount(db)
	const last = parseMetaJson(getMeta(db, META_LAST_RUN))
	const lastErr = getMeta(db, META_LAST_ERROR)
	const perFolder = catalog.imagesPerFolder(opts.imagesPerFolder)
	return {
		root,
		root_exists: Boolean(fs.existsSync(root)),
		job: cloneJob(),
		folders: stats.folders,
		missing_folders: stats.missing,
		images: stats.images,
		hashed: stats.hashed,
		embedded: stats.embedded,
		pending_embed: pending,
		embed_model: embed.embedAlgo(),
		hash_algo: PRODUCT_HASH_ALGO,
		images_per_folder: perFolder,
		last_run: last,
		last_error: lastErr && lastErr.value ? lastErr.value : null,
		cost: cost.publicEstimate({
			folders: stats.folders,
			pendingEmbed: pending,
			indexedImages: stats.images,
			imagesPerFolder: perFolder,
		}),
	}
}

async function updateIndex(db, opts = {}) {
	catalog.ensureSchema(db)
	if (_job.running) return { accepted: false, job: cloneJob() }

	const root = path.resolve(opts.root || catalog.defaultHistoryRoot())
	const wantEmbed = opts.embed !== false
	_job = idleJob()
	_job.running = true
	_job.started_at = Date.now()
	_job.root = root
	_job.embed = wantEmbed
	_job.phase = 'scan'

	const run = async () => {
		try {
			if (!fs.existsSync(root)) {
				throw Object.assign(new Error('History folder does not exist: ' + root), { status: 400 })
			}
			const diskFolders = catalog.walkProductFolders(root, { imagesPerFolder: opts.imagesPerFolder })
			_job.folders_total = diskFolders.length
			_job.phase = wantEmbed ? 'hash+embed' : 'hash'
			const embedAlgo = embed.embedAlgo()
			const indexOpts = {
				embed: wantEmbed,
				embedAlgo,
				embedFn: typeof opts.embed === 'function' ? opts.embed : null,
				embedOpts: opts.embedOpts || {},
				hash: typeof opts.hash === 'function' ? opts.hash : null,
			}
			const seen = new Set()
			await mapPool(diskFolders, opts.concurrency || UPDATE_CONCURRENCY, async (disk) => {
				if (!_job.running && _job.error) return
				seen.add(disk.product_key)
				await indexFolder(db, disk, indexOpts)
			})
			_job.phase = 'gc'
			markMissing(db, seen)
			try {
				require('./history-locate').syncMissingFolders(db, { root })
				require('./history-locate').invalidateWalkCache()
			} catch {
				/* locate map is optional relative to the visual index */
			}
			const snapshot = {
				root,
				folders: _job.folders_total,
				added: _job.folders_added,
				updated: _job.folders_updated,
				missing: _job.folders_missing,
				hashed: _job.images_hashed,
				embedded: _job.images_embedded,
				skipped: _job.images_skipped,
				embed: wantEmbed,
				finished_at: new Date().toISOString(),
			}
			setMeta(db, META_ROOT, root)
			setMeta(db, META_LAST_RUN, snapshot)
			setMeta(db, META_LAST_ERROR, '')
			_job.phase = 'done'
			return snapshot
		} catch (err) {
			_job.error = err.message || String(err)
			_job.phase = 'error'
			try {
				setMeta(db, META_LAST_ERROR, _job.error)
			} catch {
				/* meta table might be missing in a broken db */
			}
			throw err
		} finally {
			_job.running = false
			_job.finished_at = Date.now()
			invalidateMemIndex()
		}
	}

	if (opts.wait === false) {
		const promise = run()
		promise.catch(() => {})
		return { accepted: true, job: cloneJob(), promise }
	}
	const snapshot = await run()
	return { accepted: true, job: cloneJob(), snapshot }
}

function getFolderById(db, id) {
	const n = Number(id)
	if (!Number.isInteger(n) || n <= 0) return null
	try {
		return db.prepare('SELECT * FROM history_folder WHERE id = ?').get(n) || null
	} catch {
		return null
	}
}

function getFolderByKey(db, key) {
	const productKey = catalog.toPosix(key)
	if (!productKey) return null
	try {
		return db.prepare('SELECT * FROM history_folder WHERE product_key = ?').get(productKey) || null
	} catch {
		return null
	}
}

function heroImage(db, folderId) {
	try {
		return (
			db.prepare("SELECT * FROM history_image WHERE folder_id = ? AND role = 'hero' LIMIT 1").get(folderId) ||
			db.prepare('SELECT * FROM history_image WHERE folder_id = ? ORDER BY id LIMIT 1').get(folderId) ||
			null
		)
	} catch {
		return null
	}
}

function resolveHeroPath(root, folderRow, imageRow) {
	if (!folderRow || !imageRow) return null
	const full = path.join(folderRow.folder_path, imageRow.filename)
	return catalog.safeResolveUnder(root, full)
}

function logMatch(db, entry) {
	db.prepare(
		`INSERT INTO history_match_log (
			created_at, query_sha, query_name, folder_id, product_key,
			confidence, source, score, action, payload_json
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		nowSec(),
		entry.query_sha || null,
		entry.query_name || null,
		entry.folder_id != null ? Number(entry.folder_id) : null,
		entry.product_key || null,
		entry.confidence || null,
		entry.source || null,
		Number.isFinite(entry.score) ? entry.score : null,
		entry.action || 'match',
		entry.payload ? JSON.stringify(entry.payload) : null,
	)
}

module.exports = {
	HASH_WORKING_EDGE,
	UPDATE_CONCURRENCY,
	EMBED_BATCH,
	PRODUCT_HASH_ALGO,
	idleJob,
	cloneJob,
	status,
	updateIndex,
	loadEmbeddingIndex,
	loadHashRows,
	invalidateMemIndex,
	pendingEmbedCount,
	folderStats,
	getFolderById,
	getFolderByKey,
	heroImage,
	resolveHeroPath,
	logMatch,
	hashBuffer,
	sha256,
}
