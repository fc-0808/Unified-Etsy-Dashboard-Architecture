'use strict'

/**
 * Visual embeddings for find-supplier-from-a-photo.
 *
 * dHash is the right identity for near-duplicate listing JPEGs. It is the wrong
 * identity for a phone snap of the physical product: Hamming lands in the
 * random band. Chat-vision describe → title search then ranks SEO copy, not
 * pixels.
 *
 * Production visual search (Google Lens, Pinterest, Amazon) stores a dense
 * vector per catalog image and nearest-neighbor searches the query vector.
 * We use the same vision provider already configured for listings
 * (VISION_API_KEY / OpenRouter) through the embeddings endpoint, persist
 * float32 vectors in `listing_vemb`, and cosine-scan in process. After the
 * one-time index, a locate is one embed call plus a few milliseconds of RAM
 * search — not a lexical guess and not a pixel-by-pixel brute force (which
 * no serious system does; it cannot survive lighting, wrap, or crop).
 *
 * Phone snaps still contain table / hand / wrap. The query is embedded as the
 * full frame plus a wood/skin-stripped product crop; each listing keeps the
 * max cosine. Catalog photos stay as a single hero vector.
 */

const crypto = require('crypto')
const sharp = require('sharp')
const { config } = require('../listings/config')
const visual = require('./find-by-photo-visual')

const DEFAULT_EMBED_MODEL = 'google/gemini-embedding-2'
const PROBE_EDGE = 384
const JPEG_QUALITY = 72
const EMBED_TIMEOUT_MS = 45000
const BACKFILL_CONCURRENCY = 3
const BACKFILL_BATCH = 8
const MAX_RESULTS = 8

let _OpenAI = null
let _memIndex = null

function embedModel() {
	return String((config.openai && config.openai.embedModel) || process.env.FIND_BY_PHOTO_EMBED_MODEL || DEFAULT_EMBED_MODEL).trim() || DEFAULT_EMBED_MODEL
}

function embedAlgo() {
	const model = embedModel().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
	return (model || 'vision-embed') + '-v1'
}

function embeddingsEnabled(opts) {
	if (opts && opts.embed === false) return false
	if (opts && typeof opts.embed === 'function') return true
	if (/^(0|false|off)$/i.test(String(process.env.FIND_BY_PHOTO_EMBED || ''))) return false
	return hasEmbedProvider()
}

function hasEmbedProvider() {
	return Boolean(String((config.openai && config.openai.visionApiKey) || '').trim())
}

function liveClient() {
	const key = String((config.openai && config.openai.visionApiKey) || '').trim()
	if (!key) return null
	if (!_OpenAI) _OpenAI = require('openai')
	const opts = { apiKey: key, maxRetries: 1, timeout: EMBED_TIMEOUT_MS }
	const baseURL = String((config.openai && config.openai.visionBaseUrl) || '').trim()
	if (baseURL) opts.baseURL = baseURL
	const extraHeaders = {}
	if (config.openai.visionReferer) extraHeaders['HTTP-Referer'] = config.openai.visionReferer
	if (config.openai.visionTitle) extraHeaders['X-Title'] = config.openai.visionTitle
	if (Object.keys(extraHeaders).length) opts.defaultHeaders = extraHeaders
	return new _OpenAI(opts)
}

async function encodeProbeJpeg(buf) {
	return sharp(buf, { failOn: 'none' })
		.rotate()
		.resize({ width: PROBE_EDGE, height: PROBE_EDGE, fit: 'inside', withoutEnlargement: true })
		.jpeg({ quality: JPEG_QUALITY, mozjpeg: false })
		.toBuffer()
}

async function queryViewJpegs(buf) {
	if (!Buffer.isBuffer(buf) || buf.length < 32) return []
	const full = await encodeProbeJpeg(buf)
	const views = [full]
	let crop = null
	try {
		crop = await visual.cropProductJpeg(buf, { edge: PROBE_EDGE, quality: JPEG_QUALITY })
	} catch {
		crop = null
	}
	if (crop && crop.length >= 32 && !(crop.length === full.length && crop.equals(full))) views.push(crop)
	return views
}

function imageInput(jpeg) {
	return {
		content: [
			{
				type: 'image_url',
				image_url: { url: 'data:image/jpeg;base64,' + jpeg.toString('base64') },
			},
		],
	}
}

function takeVector(entry) {
	const raw = entry && (entry.embedding || entry.vector)
	if (Array.isArray(raw) && raw.length) return Float32Array.from(raw, (n) => Number(n) || 0)
	if (raw && ArrayBuffer.isView(raw)) return Float32Array.from(raw)
	return null
}

function l2normalize(vec) {
	let n = 0
	for (let i = 0; i < vec.length; i++) n += vec[i] * vec[i]
	n = Math.sqrt(n)
	if (n < 1e-8) return vec
	const out = new Float32Array(vec.length)
	for (let i = 0; i < vec.length; i++) out[i] = vec[i] / n
	return out
}

function isRetryableEmbedError(err) {
	const status = Number(err && (err.status || err.statusCode)) || 0
	const msg = String((err && err.message) || '')
	if (status === 429 || status === 408 || status >= 500) return true
	return /timeout|ECONNRESET|ETIMEDOUT|429|rate limit|temporar/i.test(msg)
}

async function withRetry(fn, attempts = 5) {
	let last
	for (let i = 0; i < attempts; i++) {
		try {
			return await fn()
		} catch (err) {
			last = err
			if (!isRetryableEmbedError(err) || i === attempts - 1) throw err
			const wait = Math.min(20000, 700 * 2 ** i) + Math.round(Math.random() * 300)
			await new Promise((resolve) => setTimeout(resolve, wait))
		}
	}
	throw last
}

async function embedJpegsOnce(list, client) {
	return withRetry(async () => {
		const api = client || liveClient()
		if (!api) throw new Error('Vision embeddings are not configured')
		const model = embedModel()
		const resp = await api.embeddings.create({
			model,
			input: list.map(imageInput),
			encoding_format: 'float',
		})
		const rows = Array.isArray(resp && resp.data) ? [...resp.data] : []
		rows.sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0))
		if (rows.length !== list.length) {
			throw new Error('Embedding provider returned ' + rows.length + ' vectors for ' + list.length + ' images')
		}
		return rows.map((row) => {
			const vec = takeVector(row)
			if (!vec || vec.length < 8) throw new Error('Embedding provider returned an empty vector')
			return l2normalize(vec)
		})
	})
}

async function embedJpegs(jpegs, client) {
	const list = Array.isArray(jpegs) ? jpegs.filter((buf) => Buffer.isBuffer(buf) && buf.length) : []
	if (!list.length) return []
	try {
		return await embedJpegsOnce(list, client)
	} catch (err) {
		if (list.length === 1) throw err
		const mid = Math.ceil(list.length / 2)
		const left = await embedJpegs(list.slice(0, mid), client)
		const right = await embedJpegs(list.slice(mid), client)
		return left.concat(right)
	}
}

async function computeEmbedding(buf, opts = {}) {
	if (opts && typeof opts.embed === 'function') {
		const vec = await opts.embed(buf)
		if (!vec) return null
		return l2normalize(Float32Array.from(vec))
	}
	if (!Buffer.isBuffer(buf) || buf.length < 32) return null
	const jpeg = await encodeProbeJpeg(buf)
	const [vec] = await embedJpegs([jpeg], opts.client)
	return vec || null
}

async function computeQueryEmbeddings(buf, opts = {}) {
	const views = await queryViewJpegs(buf)
	if (!views.length) return []
	if (opts && typeof opts.embed === 'function') {
		const vecs = []
		for (const view of views) {
			const vec = await opts.embed(view)
			if (vec && vec.length) vecs.push(l2normalize(Float32Array.from(vec)))
		}
		return vecs
	}
	return embedJpegs(views, opts.client)
}

function embeddingToBlob(vec) {
	if (!vec || !vec.length) return null
	const arr = vec instanceof Float32Array ? vec : Float32Array.from(vec)
	return Buffer.from(arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength))
}

function blobToEmbedding(buf) {
	if (!Buffer.isBuffer(buf) || buf.length < 8 || buf.length % 4) return null
	const copy = Buffer.from(buf)
	return new Float32Array(copy.buffer, copy.byteOffset, copy.length / 4)
}

function cosine(a, b) {
	if (!a || !b || a.length !== b.length) return 0
	let dot = 0
	for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
	if (!Number.isFinite(dot)) return 0
	if (dot > 1) return 1
	if (dot < 0) return 0
	return dot
}

function confidenceForCosine(score, secondScore, isTop) {
	const s = Number(score) || 0
	if (s >= 0.93 && isTop !== false) return 'exact'
	if (s >= 0.91 && isTop !== false && (secondScore == null || s - Number(secondScore) >= 0.018)) return 'likely'
	if (s >= 0.84) return 'possible'
	if (s >= 0.78) return 'weak'
	return 'distant'
}

function queryVecList(queryVec) {
	if (!queryVec) return []
	if (queryVec instanceof Float32Array) return [queryVec]
	if (Array.isArray(queryVec) && queryVec.length) {
		if (typeof queryVec[0] === 'number') return [Float32Array.from(queryVec)]
		return queryVec.filter((vec) => vec && vec.length)
	}
	return []
}

function sha256(buf) {
	return crypto.createHash('sha256').update(buf).digest('hex')
}

function invalidateEmbeddingCache() {
	_memIndex = null
}

function listingVembCount(db, algo) {
	try {
		return Number(db.prepare('SELECT COUNT(*) AS n FROM listing_vemb WHERE algo = ?').get(algo || embedAlgo()).n) || 0
	} catch {
		return 0
	}
}

function loadEmbeddingIndex(db, algo) {
	const useAlgo = algo || embedAlgo()
	if (_memIndex && _memIndex.algo === useAlgo && _memIndex.db === db) return _memIndex.items
	let rows = []
	try {
		rows = db.prepare('SELECT listing_id, dim, embedding FROM listing_vemb WHERE algo = ?').all(useAlgo)
	} catch {
		_memIndex = { db, algo: useAlgo, items: [] }
		return _memIndex.items
	}
	const items = []
	for (const row of rows) {
		const vec = blobToEmbedding(row.embedding)
		if (!vec || vec.length !== Number(row.dim)) continue
		items.push({ listing_id: Number(row.listing_id), vec })
	}
	_memIndex = { db, algo: useAlgo, items }
	return items
}

function warmEmbeddingIndex(db) {
	invalidateEmbeddingCache()
	return loadEmbeddingIndex(db).length
}

function rankByEmbedding(index, queryVec, { limit = MAX_RESULTS } = {}) {
	const queries = queryVecList(queryVec)
	const items = Array.isArray(index) ? index : []
	if (!queries.length || !items.length) return []
	const dim = queries[0].length
	const scored = []
	for (const item of items) {
		if (!item || !item.vec || item.vec.length !== dim) continue
		let best = 0
		for (const q of queries) {
			if (!q || q.length !== dim) continue
			const s = cosine(q, item.vec)
			if (s > best) best = s
		}
		scored.push({ listing_id: item.listing_id, score: best })
	}
	scored.sort((a, b) => b.score - a.score || a.listing_id - b.listing_id)
	return scored.slice(0, Math.max(1, limit))
}

function upsertEmbeddingRow(db, { listingId, vec, sha, algo }) {
	const blob = embeddingToBlob(vec)
	if (!blob) return
	db.prepare(
		`INSERT INTO listing_vemb (listing_id, algo, dim, sha, embedding, computed_at)
		 VALUES (?, ?, ?, ?, ?, strftime('%s','now'))
		 ON CONFLICT(listing_id) DO UPDATE SET
		   algo=excluded.algo,
		   dim=excluded.dim,
		   sha=excluded.sha,
		   embedding=excluded.embedding,
		   computed_at=excluded.computed_at`,
	).run(listingId, algo, vec.length, sha, blob)
	invalidateEmbeddingCache()
}

async function ensureListingEmbedding(db, listingId, opts = {}) {
	const id = Number(listingId)
	if (!id) return null
	let img
	try {
		img = db.prepare('SELECT data FROM listing_image_data WHERE listing_id = ?').get(id)
	} catch {
		return null
	}
	if (!img || !img.data || !img.data.length) return null
	const sha = sha256(img.data)
	const algo = embedAlgo()
	let existing = null
	try {
		existing = db.prepare('SELECT sha, algo, dim FROM listing_vemb WHERE listing_id = ?').get(id)
	} catch {
		return null
	}
	if (existing && existing.sha === sha && existing.algo === algo && Number(existing.dim) > 0) {
		return existing
	}
	const vec = await computeEmbedding(img.data, opts)
	if (!vec) return null
	upsertEmbeddingRow(db, { listingId: id, vec, sha, algo })
	return { sha, algo, dim: vec.length }
}

function missingEmbeddingIds(db, algo) {
	try {
		return db
			.prepare(
				`SELECT d.listing_id AS id
				 FROM listing_image_data d
				 LEFT JOIN listing_vemb v ON v.listing_id = d.listing_id
				 LEFT JOIN listing_phash p ON p.listing_id = d.listing_id
				 WHERE v.listing_id IS NULL
				    OR v.algo IS NULL
				    OR v.algo <> ?
				    OR v.sha IS NULL
				    OR (p.sha IS NOT NULL AND v.sha <> p.sha)`,
			)
			.all(algo || embedAlgo())
			.map((row) => Number(row.id))
			.filter((id) => id > 0)
	} catch {
		return []
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

async function embedPreparedRows(db, prepared, opts, algo) {
	if (!prepared.length) return 0
	let vecs
	if (opts && typeof opts.embed === 'function') {
		vecs = []
		for (const row of prepared) {
			const vec = await opts.embed(row.jpeg)
			vecs.push(vec && vec.length ? l2normalize(Float32Array.from(vec)) : null)
		}
	} else {
		vecs = await embedJpegs(
			prepared.map((row) => row.jpeg),
			opts && opts.client,
		)
	}
	let ok = 0
	for (let i = 0; i < prepared.length; i++) {
		if (!vecs[i]) continue
		upsertEmbeddingRow(db, { listingId: prepared[i].id, vec: vecs[i], sha: prepared[i].sha, algo })
		ok++
	}
	return ok
}

async function backfillListingEmbeddings(db, opts = {}) {
	if (!embeddingsEnabled(opts) && typeof (opts && opts.embed) !== 'function') {
		if (!hasEmbedProvider()) return 0
	}
	const ids = missingEmbeddingIds(db)
	if (!ids.length) return 0
	const algo = embedAlgo()
	const onProgress = opts && typeof opts.onProgress === 'function' ? opts.onProgress : null
	const chunks = []
	for (let i = 0; i < ids.length; i += BACKFILL_BATCH) chunks.push(ids.slice(i, i + BACKFILL_BATCH))
	let done = 0
	let ok = 0
	await mapPool(chunks, opts.concurrency || BACKFILL_CONCURRENCY, async (chunk) => {
		const prepared = []
		for (const id of chunk) {
			let img
			try {
				img = db.prepare('SELECT data FROM listing_image_data WHERE listing_id = ?').get(id)
			} catch {
				continue
			}
			if (!img || !img.data || !img.data.length) continue
			const sha = sha256(img.data)
			let existing = null
			try {
				existing = db.prepare('SELECT sha, algo, dim FROM listing_vemb WHERE listing_id = ?').get(id)
			} catch {
				existing = null
			}
			if (existing && existing.sha === sha && existing.algo === algo && Number(existing.dim) > 0) continue
			let jpeg
			try {
				jpeg = await encodeProbeJpeg(img.data)
			} catch {
				continue
			}
			prepared.push({ id, sha, jpeg })
		}
		try {
			ok += await embedPreparedRows(db, prepared, opts, algo)
		} catch (err) {
			if (process.env.FIND_BY_PHOTO_DEBUG) {
				console.error('[vemb] batch', prepared.map((row) => row.id).join(','), err && err.message)
			}
		}
		done += chunk.length
		if (onProgress) onProgress(Math.min(done, ids.length), ids.length)
		await new Promise((resolve) => setImmediate(resolve))
	})
	return ok
}

module.exports = {
	DEFAULT_EMBED_MODEL,
	PROBE_EDGE,
	BACKFILL_BATCH,
	embedModel,
	embedAlgo,
	embeddingsEnabled,
	hasEmbedProvider,
	encodeProbeJpeg,
	computeEmbedding,
	computeQueryEmbeddings,
	embeddingToBlob,
	blobToEmbedding,
	cosine,
	confidenceForCosine,
	listingVembCount,
	loadEmbeddingIndex,
	warmEmbeddingIndex,
	rankByEmbedding,
	ensureListingEmbedding,
	backfillListingEmbeddings,
	invalidateEmbeddingCache,
	missingEmbeddingIds,
}
