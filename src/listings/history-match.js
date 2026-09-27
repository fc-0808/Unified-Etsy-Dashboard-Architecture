'use strict'

/**
 * Locate the History product folder a photo belongs to.
 *
 * Cascade (same production shape as find-by-photo / Google Lens):
 *
 *   1. dHash — free, local. Exact JPEG reuse and light recodes land at
 *      Hamming 0–12. Decisive; skip paid models.
 *   2. Dense embeddings — one query embed against the History index.
 *      Recovers lifestyle-vs-studio and crop/lighting changes.
 *   3. Chat-vision rerank — ONLY the top handful of folders, and only
 *      when (1)+(2) are not already `exact`/`likely`. This is the
 *      expensive step; never pointed at the whole archive.
 *
 * Shop-root invariant: when the Etsy shop is known (explicit `shop` /
 * `shop_id`, `listing_id`, or listing id in the filename), search is
 * limited to History/<shop>/. An iPhoneCasesDesignArt listing can only
 * resolve under …/History/iPhoneCasesDesignArt — not another shop and
 * not `_Unassigned`.
 *
 * Folder score is the BEST image in that folder (max cosine / min
 * Hamming). Returning a folder, not a JPEG, is the product contract.
 */

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const sharp = require('sharp')
const { PRODUCT_HASH_ALGO, computeDHash, computeDesignHash } = require('../route/product-image-hash')
const { phashDistance } = require('../route/product-similarity')
const embed = require('../route/product-image-embed')
const { decodePhotoData, confidenceFor, HASH_WORKING_EDGE } = require('../route/find-by-photo')
const catalog = require('./history-catalog')
const index = require('./history-index')
const cost = require('./history-cost')
const historyVision = require('./history-vision')

const MAX_RESULTS = 8
const SCAN_CAP = 80
const RERANK_CAP = 6
const CONF_RANK = { exact: 0, likely: 1, possible: 2, weak: 3, distant: 4 }

function sha256(buf) {
	return crypto.createHash('sha256').update(buf).digest('hex')
}

async function computeCenterCropHash(buf) {
	const meta = await sharp(buf, { failOn: 'none' }).metadata()
	const w = Number(meta.width) || 0
	const h = Number(meta.height) || 0
	if (w < 8 || h < 8) return computeDHash(buf)
	const cw = Math.max(8, Math.round(w * 0.7))
	const ch = Math.max(8, Math.round(h * 0.7))
	const left = Math.max(0, Math.floor((w - cw) / 2))
	const top = Math.max(0, Math.floor((h - ch) / 2))
	const width = Math.min(cw, w - left)
	const height = Math.min(ch, h - top)
	if (width < 8 || height < 8) return computeDHash(buf)
	const cropped = await sharp(buf, { failOn: 'none' }).extract({ left, top, width, height }).toBuffer()
	return computeDHash(cropped)
}

async function hashQueryImage(buf) {
	const meta = await sharp(buf, { failOn: 'none' }).metadata()
	const w = Number(meta.width) || 0
	const h = Number(meta.height) || 0
	let working = buf
	if (!w || !h || w > HASH_WORKING_EDGE || h > HASH_WORKING_EDGE || (meta.orientation && meta.orientation > 1)) {
		working = await sharp(buf, { failOn: 'none' })
			.rotate()
			.resize({
				width: HASH_WORKING_EDGE,
				height: HASH_WORKING_EDGE,
				fit: 'inside',
				withoutEnlargement: true,
			})
			.toBuffer()
	}
	const [full, design, crop] = await Promise.all([
		computeDHash(working),
		computeDesignHash(working),
		computeCenterCropHash(working),
	])
	return { full, design, crop }
}

function bestHashDistance(query, listing) {
	const candidates = [
		{ kind: 'full', d: phashDistance(query && query.full, listing && listing.phash) },
		{ kind: 'design', d: phashDistance(query && query.design, listing && listing.design_phash) },
		{ kind: 'crop', d: phashDistance(query && query.crop, listing && listing.phash) },
		{ kind: 'full-design', d: phashDistance(query && query.full, listing && listing.design_phash) },
		{ kind: 'crop-design', d: phashDistance(query && query.crop, listing && listing.design_phash) },
		{ kind: 'design-full', d: phashDistance(query && query.design, listing && listing.phash) },
	]
	let best = candidates[0]
	for (const c of candidates) {
		if (c.d < best.d) best = c
	}
	return best
}

function shouldSkipPaidModels(matches) {
	const best = matches && matches[0]
	return Boolean(best && (best.confidence === 'exact' || best.confidence === 'likely'))
}

function marginIsDecisive(matches) {
	if (!matches || matches.length < 2) return Boolean(matches && matches[0] && (matches[0].confidence === 'exact' || matches[0].confidence === 'likely'))
	const a = matches[0]
	const b = matches[1]
	if (a.confidence === 'exact' && CONF_RANK[b.confidence] > 0) return true
	if (a.confidence === 'likely' && CONF_RANK[b.confidence] >= 2) return true
	if (a.match_kind === 'embed' && Number.isFinite(a.score) && Number.isFinite(b.score)) {
		return a.score - b.score >= 0.018 && a.score >= 0.91
	}
	return false
}

function loadFolders(db, ids) {
	const map = new Map()
	const list = [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))]
	if (!list.length) return map
	const placeholders = list.map(() => '?').join(',')
	for (const row of db.prepare(`SELECT * FROM history_folder WHERE id IN (${placeholders})`).all(...list)) {
		map.set(Number(row.id), row)
	}
	return map
}

function hydrate(db, scored, opts = {}) {
	const rows = Array.isArray(scored) ? scored : []
	const folders = loadFolders(
		db,
		rows.map((row) => row.folder_id),
	)
	const out = []
	const seen = new Set()
	for (const row of rows) {
		const folderId = Number(row.folder_id)
		if (seen.has(folderId)) continue
		seen.add(folderId)
		const folder = folders.get(folderId)
		if (!folder || folder.status !== 'active') continue
		if (opts.shop && !catalog.folderBelongsToShop(folder.shop, opts.shop)) continue
		const confidence = row.confidence || confidenceFor(row.distance)
		out.push({
			folder_id: folderId,
			product_key: folder.product_key,
			folder_path: folder.folder_path,
			shop: folder.shop,
			batch: folder.batch,
			product: folder.product,
			product_hint: folder.product_hint,
			hero_filename: folder.hero_filename,
			image_url: `/api/listings/history/image/${folderId}?w=240`,
			distance: Number.isFinite(row.distance) ? row.distance : null,
			score: Number.isFinite(row.score) ? row.score : null,
			confidence,
			match_kind: row.match_kind,
			hero_filename_match: row.filename || folder.hero_filename,
		})
		if (out.length >= MAX_RESULTS * 2) break
	}
	return out
}

function listingShopId(db, listingId) {
	if (!db || listingId == null || listingId === '') return ''
	const id = String(listingId).trim()
	if (!/^\d{6,14}$/.test(id)) return ''
	try {
		const row = db.prepare('SELECT shop_id FROM listings WHERE listing_id = ?').get(Number(id))
		if (row && row.shop_id) return String(row.shop_id)
	} catch {
		/* listings table may be missing in unit tests */
	}
	return ''
}

function resolveQueryShop(db, opts = {}) {
	const explicit = opts.shop || opts.shop_id || ''
	const fromListing = listingShopId(db, opts.listing_id)
	const fromName = catalog.listingIdFromQueryName(opts.name)
	const shopId = explicit || fromListing || listingShopId(db, fromName)
	if (!shopId) return null
	return catalog.resolveHistoryShop(shopId, { root: opts.root, db })
}

function rankHashFolders(db, query, opts = {}) {
	const rows = index.loadHashRows(db)
	const shop = opts.shop
	const bestByFolder = new Map()
	for (const row of rows) {
		if (shop && !catalog.sameHistoryShop(row.shop, shop)) continue
		const best = bestHashDistance(query, row)
		if (best.d > SCAN_CAP) continue
		const prev = bestByFolder.get(row.folder_id)
		if (!prev || best.d < prev.distance) {
			bestByFolder.set(row.folder_id, {
				folder_id: Number(row.folder_id),
				distance: best.d,
				match_kind: 'phash',
				filename: row.filename,
				confidence: confidenceFor(best.d),
			})
		}
	}
	const ranked = [...bestByFolder.values()].sort((a, b) => a.distance - b.distance || a.folder_id - b.folder_id)
	return hydrate(db, ranked, opts)
}

function rankEmbedFolders(db, queryVecs, opts = {}) {
	const items = index.loadEmbeddingIndex(db)
	if (!items.length || !queryVecs || !queryVecs.length) return []
	const dim = queryVecs[0].length
	const shop = opts.shop
	const bestByFolder = new Map()
	for (const item of items) {
		if (shop && !catalog.sameHistoryShop(item.shop, shop)) continue
		if (!item.vec || item.vec.length !== dim) continue
		let best = 0
		for (const q of queryVecs) {
			if (!q || q.length !== dim) continue
			const s = embed.cosine(q, item.vec)
			if (s > best) best = s
		}
		const prev = bestByFolder.get(item.folder_id)
		if (!prev || best > prev.score) {
			bestByFolder.set(item.folder_id, {
				folder_id: Number(item.folder_id),
				score: best,
				distance: 1 - best,
				match_kind: 'embed',
			})
		}
	}
	const ranked = [...bestByFolder.values()].sort((a, b) => b.score - a.score || a.folder_id - b.folder_id)
	const second = ranked[1] ? ranked[1].score : null
	const labelled = ranked.map((row, i) => ({
		...row,
		confidence: embed.confidenceForCosine(row.score, second, i === 0),
	}))
	return hydrate(db, labelled, opts)
}

function mergeMatches(...lists) {
	const combined = lists.flat().filter(Boolean)
	combined.sort((a, b) => {
		const ra = CONF_RANK[a.confidence] ?? 9
		const rb = CONF_RANK[b.confidence] ?? 9
		if (ra !== rb) return ra - rb
		const kindRank = { vision: 0, phash: 1, embed: 2 }
		const ka = kindRank[a.match_kind] ?? 9
		const kb = kindRank[b.match_kind] ?? 9
		if (ka !== kb) return ka - kb
		const sa = Number.isFinite(a.score) ? -a.score : Number.isFinite(a.distance) ? a.distance : 999
		const sb = Number.isFinite(b.score) ? -b.score : Number.isFinite(b.distance) ? b.distance : 999
		return sa - sb
	})
	const seen = new Set()
	const out = []
	for (const row of combined) {
		if (seen.has(row.folder_id)) continue
		seen.add(row.folder_id)
		out.push(row)
		if (out.length >= MAX_RESULTS) break
	}
	return out
}

function matchSource(matches) {
	if (!matches.length) return null
	const kinds = new Set(matches.map((row) => row.match_kind))
	if (kinds.size > 1) return 'hybrid'
	return matches[0].match_kind
}

function wantVisionRerank(opts) {
	if (opts && opts.rerank === false) return false
	if (opts && typeof opts.rerank === 'function') return true
	if (/^(0|false|off)$/i.test(String(process.env.HISTORY_VISION_RERANK || ''))) return false
	return historyVision.visionEnabled()
}

async function encodeThumb(buf) {
	return sharp(buf, { failOn: 'none' })
		.rotate()
		.resize({ width: 256, height: 256, fit: 'inside', withoutEnlargement: true })
		.jpeg({ quality: 62, mozjpeg: false })
		.toBuffer()
}

async function loadHeroJpeg(root, folderRow) {
	if (!folderRow) return null
	const filename = folderRow.hero_filename
	if (!filename) return null
	const full = catalog.safeResolveUnder(root, path.join(folderRow.folder_path, filename))
	if (!full) return null
	try {
		const buf = fs.readFileSync(full)
		if (!buf.length) return null
		return encodeThumb(buf)
	} catch {
		return null
	}
}

async function rerankWithVision(db, buf, shortlist, opts) {
	if (!shortlist.length) return shortlist
	const pool = shortlist.slice(0, RERANK_CAP)
	if (typeof opts.rerank === 'function') {
		const decisions = await opts.rerank(pool, buf)
		return applyRerank(pool, decisions)
	}
	const root = opts.root || catalog.defaultHistoryRoot()
	const queryJpeg = opts.queryJpeg || (await encodeThumb(buf))
	const candidates = []
	for (const row of pool) {
		const folder = index.getFolderById(db, row.folder_id)
		const jpeg = await loadHeroJpeg(root, folder)
		candidates.push({ ...row, jpeg })
	}
	const withJpegs = candidates.filter((row) => row.jpeg && row.jpeg.length)
	if (!withJpegs.length) return shortlist
	const decisions = await historyVision.rerankFolders(queryJpeg, withJpegs, opts)
	if (!decisions.length) return shortlist
	return mergeMatches(applyRerank(withJpegs, decisions), shortlist)
}

function applyRerank(shortlist, decisions) {
	const byIndex = new Map()
	for (const d of Array.isArray(decisions) ? decisions : []) {
		const idx = Number(d.index) || 0
		if (idx >= 1) byIndex.set(idx, d)
	}
	if (!byIndex.size) return shortlist
	const out = shortlist.map((row, i) => {
		const d = byIndex.get(i + 1)
		if (!d) return row
		const same = d.same_print === true
		const confNum = Number(d.confidence)
		let confidence = row.confidence
		if (same && confNum >= 88) confidence = 'exact'
		else if (same && confNum >= 72) confidence = 'likely'
		else if (same && confNum >= 55) confidence = 'possible'
		else if (same) confidence = 'weak'
		else if (confNum < 40) confidence = 'distant'
		return {
			...row,
			match_kind: 'vision',
			confidence,
			vision_reason: d.reason || null,
			score: same ? Math.max(Number(row.score) || 0, confNum / 100) : Number(row.score) || 0,
		}
	})
	out.sort((a, b) => (CONF_RANK[a.confidence] ?? 9) - (CONF_RANK[b.confidence] ?? 9) || (Number(b.score) || 0) - (Number(a.score) || 0))
	return out
}

function emptyResult(reason, extra = {}) {
	return {
		matches: [],
		reason,
		source: null,
		query_sha: extra.query_sha || null,
		index: extra.index || null,
		cost: extra.cost || null,
		shop: extra.shop || null,
		shop_root: extra.shop_root || null,
	}
}

async function matchPhoto(db, buf, opts = {}) {
	catalog.ensureSchema(db)
	if (!Buffer.isBuffer(buf) || buf.length < 32) {
		const err = new Error('Could not read that photo')
		err.status = 400
		throw err
	}
	const stats = index.folderStats(db)
	const querySha = sha256(buf)
	const shopScope = resolveQueryShop(db, opts)
	const scopeOpts = shopScope ? { shop: shopScope.shop, root: opts.root } : { root: opts.root }
	const scoped = {
		query_sha: querySha,
		index: stats,
		shop: shopScope ? shopScope.shop : null,
		shop_root: shopScope ? shopScope.folder_path : null,
	}
	if (!stats.folders) {
		return emptyResult('index_empty', scoped)
	}

	let query
	try {
		query = typeof opts.hashQuery === 'function' ? await opts.hashQuery(buf) : await hashQueryImage(buf)
	} catch {
		const err = new Error('Could not read that photo')
		err.status = 400
		throw err
	}

	const phashMatches = stats.hashed ? rankHashFolders(db, query, scopeOpts) : []
	if (!opts.forceRerank && shouldSkipPaidModels(phashMatches) && marginIsDecisive(phashMatches)) {
		return {
			matches: phashMatches.slice(0, MAX_RESULTS),
			reason: null,
			source: 'phash',
			cost: cost.estimateQueryCost({ rerank: false, catalogImages: stats.images }),
			...scoped,
		}
	}

	let embedMatches = []
	const canEmbed = embed.embeddingsEnabled(opts) || typeof opts.embed === 'function' || stats.embedded
	if (canEmbed && stats.embedded) {
		try {
			const vecs =
				typeof opts.embed === 'function'
					? [await opts.embed(buf)].filter(Boolean)
					: await embed.computeQueryEmbeddings(buf, opts)
			embedMatches = rankEmbedFolders(db, vecs, scopeOpts)
		} catch {
			embedMatches = []
		}
	}

	if (!opts.forceRerank && shouldSkipPaidModels(embedMatches) && marginIsDecisive(embedMatches)) {
		return {
			matches: mergeMatches(embedMatches, phashMatches),
			reason: null,
			source: 'embed',
			cost: cost.estimateQueryCost({ rerank: false, catalogImages: stats.images }),
			...scoped,
		}
	}

	let merged = mergeMatches(embedMatches, phashMatches)
	let source = matchSource(merged)
	let usedRerank = false
	if (merged.length && wantVisionRerank(opts) && (opts.forceRerank || !marginIsDecisive(merged))) {
		try {
			const reranked = await rerankWithVision(db, buf, merged.slice(0, RERANK_CAP), opts)
			merged = mergeMatches(reranked, merged)
			if (shopScope) merged = merged.filter((row) => catalog.folderBelongsToShop(row.shop, shopScope.shop))
			usedRerank = true
			source = matchSource(merged) || source
		} catch {
			usedRerank = false
		}
	}

	return {
		matches: merged.slice(0, MAX_RESULTS),
		reason: merged.length ? null : stats.embedded || stats.hashed ? 'no_match' : 'index_empty',
		source,
		cost: cost.estimateQueryCost({ rerank: usedRerank, catalogImages: stats.images }),
		...scoped,
	}
}

async function matchPhotos(db, items, opts = {}) {
	const list = Array.isArray(items) ? items : []
	const results = []
	for (const item of list) {
		const buf = Buffer.isBuffer(item) ? item : item && item.buf
		const name = Buffer.isBuffer(item) ? null : (item && item.name) || null
		const photoOpts = {
			...opts,
			name,
			shop: (item && (item.shop || item.shop_id)) || opts.shop || opts.shop_id,
			listing_id: (item && item.listing_id) || opts.listing_id,
		}
		try {
			const matched = await matchPhoto(db, buf, photoOpts)
			results.push({ name, ok: true, ...matched })
			const best = matched.matches && matched.matches[0]
			if (best && opts.log !== false) {
				try {
					index.logMatch(db, {
						query_sha: matched.query_sha,
						query_name: name,
						folder_id: best.folder_id,
						product_key: best.product_key,
						confidence: best.confidence,
						source: matched.source,
						score: best.score != null ? best.score : best.distance,
						action: 'match',
						payload: { shop: matched.shop, shop_root: matched.shop_root },
					})
				} catch {
					/* logging must never fail a locate */
				}
			}
		} catch (err) {
			results.push({ name, ok: false, error: err.message || 'Match failed', matches: [] })
		}
	}
	return { results }
}

module.exports = {
	MAX_RESULTS,
	RERANK_CAP,
	SCAN_CAP,
	PRODUCT_HASH_ALGO,
	decodePhotoData,
	hashQueryImage,
	rankHashFolders,
	rankEmbedFolders,
	mergeMatches,
	applyRerank,
	shouldSkipPaidModels,
	marginIsDecisive,
	matchPhoto,
	matchPhotos,
	sha256,
	resolveQueryShop,
	listingShopId,
}
