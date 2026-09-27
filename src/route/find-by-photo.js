'use strict'

/**
 * Find the catalog supplier from a photo an employee took of a physical product.
 *
 * Sourcing catalog tool (`POST /api/sourcing/find-by-photo`). The operator
 * UI lands on the supplier directory: a close match opens that stall. This is
 * not a Shopping Mode action — shoppers on the floor already have the stall
 * in front of them.
 *
 * HOW THIS WORKS
 * ----------------------------------------------------------------------------
 * Three retrieval paths, in order:
 *
 *   1. dHash (`listing_phash`). Same 256-bit fingerprint the route engine uses
 *      for "same product" identity. Near-duplicate listing photos sit at
 *      Hamming 0–16 (`exact` / `likely`). When the best hit is that close we
 *      return immediately — the listing JPEG *is* the query JPEG.
 *
 *   2. Visual embeddings (`listing_vemb`). Every cached listing photo is a
 *      float32 vector from the vision embedding model (same VISION_API_KEY as
 *      listing design analysis). The query is embedded as the full frame plus
 *      a table-stripped product crop; cosine nearest-neighbor (max of those
 *      views) is the locate. Chat-vision titles are not consulted.
 *
 *   3. Vision describe (`find-by-photo-vision`). Fallback when the embedding
 *      index is empty or every cosine is weak. Describes the print, retrieves
 *      over product_map titles, optionally reranks thumbs.
 *
 * Catalog identity is the normalised listing title (`product_map.title_norm`),
 * not a retail SKU. The supplier the employee needs is `product_map.shop_name`
 * plus the stall. Vision does not require `listing_phash` — an unhashed
 * catalog can still be located from a snap.
 */

const sharp = require('sharp')
const { PRODUCT_HASH_ALGO, computeDHash, computeDesignHash } = require('./product-image-hash')
const embed = require('./product-image-embed')
const { phashDistance } = require('./product-similarity')
const { normalizeTitle, itemKey } = require('./dashboard')
const { resolveLocation } = require('../sourcing/catalog-view')
const { safeStoredImageMime } = require('./stored-image-security')
const vision = require('./find-by-photo-vision')

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
const MAX_RESULTS = 8
const SCAN_CAP = 80
const CANDIDATE_JOIN_LIMIT = 40

function httpError(status, message) {
	const err = new Error(message)
	err.status = status
	return err
}

function confidenceFor(distance) {
	const d = Number(distance)
	if (!Number.isFinite(d)) return 'distant'
	if (d <= 6) return 'exact'
	if (d <= 12) return 'likely'
	if (d <= 24) return 'possible'
	if (d <= 48) return 'weak'
	return 'distant'
}

function decodePhotoData(raw) {
	if (raw == null || typeof raw !== 'string' || !raw.trim()) {
		throw httpError(400, 'Upload a JPEG, PNG, or WebP photo')
	}
	const match = /^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/i.exec(raw.trim())
	if (!match) throw httpError(400, 'Upload a JPEG, PNG, or WebP photo')
	const kind = match[1].toLowerCase() === 'jpg' ? 'jpeg' : match[1].toLowerCase()
	if (!safeStoredImageMime('image/' + kind)) throw httpError(400, 'Upload a JPEG, PNG, or WebP photo')
	const b64 = match[2].replace(/\s+/g, '')
	if (!b64) throw httpError(400, 'Photo is empty')
	if (b64.length > MAX_UPLOAD_BYTES * 2) throw httpError(400, 'Photo is too large (max 10 MB)')
	const buf = Buffer.from(b64, 'base64')
	if (!buf.length) throw httpError(400, 'Photo is empty')
	if (buf.length > MAX_UPLOAD_BYTES) throw httpError(400, 'Photo is too large (max 10 MB)')
	return buf
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

const HASH_WORKING_EDGE = 320

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

function bestDistance(query, listing) {
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

function catalogDedupeKey(row) {
	const ck = String((row && row.canonical_product_key) || '').trim()
	if (ck) return 'ck:' + ck
	const tn = String((row && row.title_norm) || '').trim()
	if (tn) return 'tn:' + tn
	return 'lid:' + Number(row && row.listing_id)
}

function loadCatalogIndexes(db) {
	const byNorm = new Map()
	const by50 = new Map()
	const byCanon = new Map()
	let rows = []
	try {
		rows = db.prepare('SELECT id, title, title_norm, shop_name, stall, canonical_product_key, status FROM product_map').all()
	} catch {
		return { byNorm, by50, byCanon }
	}
	const take = (map, key, row) => {
		if (!key) return
		const prev = map.get(key)
		if (!prev) {
			map.set(key, row)
			return
		}
		if (prev.status !== 'active' && row.status === 'active') map.set(key, row)
	}
	for (const row of rows) {
		take(byNorm, String(row.title_norm || ''), row)
		take(by50, String(row.title_norm || '').slice(0, 50), row)
		take(byCanon, String(row.canonical_product_key || '').trim(), row)
	}
	try {
		const aliases = db.prepare('SELECT title_norm, product_id FROM product_map_title_aliases').all()
		const byId = new Map(rows.map((row) => [Number(row.id), row]))
		for (const alias of aliases) {
			const owner = byId.get(Number(alias.product_id))
			if (!owner) continue
			take(byNorm, String(alias.title_norm || ''), owner)
			take(by50, String(alias.title_norm || '').slice(0, 50), owner)
		}
	} catch {
		/* alias table may be absent on stripped schemas */
	}
	return { byNorm, by50, byCanon }
}

function lookupCatalog(indexes, { title, canonicalKey }) {
	const ck = String(canonicalKey || '').trim()
	if (ck && indexes.byCanon.has(ck)) return indexes.byCanon.get(ck)
	const titleNorm = normalizeTitle(title)
	if (titleNorm && indexes.byNorm.has(titleNorm)) return indexes.byNorm.get(titleNorm)
	const key50 = itemKey(title)
	if (key50 && indexes.by50.has(key50)) return indexes.by50.get(key50)
	return null
}

function rankAndJoin(db, query, hashRows) {
	const scored = []
	for (const row of Array.isArray(hashRows) ? hashRows : []) {
		const best = bestDistance(query, row)
		if (best.d > SCAN_CAP) continue
		scored.push({
			listing_id: Number(row.listing_id),
			phash: row.phash,
			design_phash: row.design_phash,
			canonical_key: row.canonical_key,
			distance: best.d,
			match_kind: best.kind,
		})
	}
	scored.sort((a, b) => a.distance - b.distance || a.listing_id - b.listing_id)
	return hydrateCatalogMatches(db, scored)
}

function hydrateCatalogMatches(db, scored) {
	const rows = Array.isArray(scored) ? scored : []
	const joinIds = rows
		.slice(0, CANDIDATE_JOIN_LIMIT)
		.map((r) => Number(r.listing_id))
		.filter((id) => Number.isInteger(id) && id > 0)
	const listings = new Map()
	if (joinIds.length) {
		const placeholders = joinIds.map(() => '?').join(',')
		try {
			for (const row of db.prepare(`SELECT listing_id, title FROM listings WHERE listing_id IN (${placeholders})`).all(...joinIds)) {
				listings.set(Number(row.listing_id), row)
			}
		} catch {
			/* listings table missing in a stripped test db */
		}
	}

	const indexes = loadCatalogIndexes(db)
	const seen = new Set()
	const matches = []
	for (const row of rows) {
		const listing = listings.get(Number(row.listing_id)) || {}
		const catalog = lookupCatalog(indexes, { title: listing.title, canonicalKey: row.canonical_key })
		const shopName = String((catalog && catalog.shop_name) || '').trim()
		const stall = String((catalog && catalog.stall) || '').trim()
		const title = String((catalog && catalog.title) || listing.title || '').trim()
		const titleNorm = String((catalog && catalog.title_norm) || normalizeTitle(title)).trim()
		const canonicalProductKey = String((catalog && catalog.canonical_product_key) || row.canonical_key || '').trim()
		const key = catalogDedupeKey({
			canonical_product_key: canonicalProductKey,
			title_norm: titleNorm,
			listing_id: row.listing_id,
		})
		if (seen.has(key)) continue
		seen.add(key)
		const confidence = row.confidence || confidenceFor(row.distance)
		if (row.match_kind === 'embed' && confidence === 'distant') continue
		matches.push({
			listing_id: Number(row.listing_id),
			title,
			title_norm: titleNorm,
			shop_name: shopName,
			stall,
			location: resolveLocation(stall, shopName),
			image_url: `/api/route/listing-image/${row.listing_id}?w=300`,
			distance: Number.isFinite(row.distance) ? row.distance : null,
			confidence,
			match_kind: row.match_kind,
			canonical_product_key: canonicalProductKey,
			catalog_id: catalog && catalog.id != null ? Number(catalog.id) : null,
			vision_score: Number.isFinite(row.score) ? row.score : undefined,
		})
		if (matches.length >= CANDIDATE_JOIN_LIMIT) break
	}
	const located = matches.filter((row) => row.shop_name || row.stall)
	return (located.length ? located : matches).slice(0, MAX_RESULTS)
}

function relabelEmbedConfidence(matches) {
	if (!Array.isArray(matches) || !matches.length) return matches
	if (matches[0].match_kind !== 'embed') return matches
	const second = matches[1] && matches[1].match_kind === 'embed' ? Number(matches[1].vision_score) : null
	return matches.map((row, i) => {
		if (row.match_kind !== 'embed') return row
		const score = Number(row.vision_score)
		if (!Number.isFinite(score)) return row
		return {
			...row,
			confidence: embed.confidenceForCosine(score, i === 0 ? second : null, i === 0),
		}
	})
}

async function searchEmbeddings(db, buf, opts) {
	if (!embed.embeddingsEnabled(opts)) return []
	const index = embed.loadEmbeddingIndex(db)
	if (!index.length) return []
	let vecs
	try {
		vecs = await embed.computeQueryEmbeddings(buf, opts)
	} catch {
		return []
	}
	if (!vecs || !vecs.length) return []
	const ranked = embed.rankByEmbedding(index, vecs, { limit: CANDIDATE_JOIN_LIMIT })
	if (!ranked.length) return []
	const second = ranked[1] ? ranked[1].score : null
	const rows = ranked.map((row, i) => ({
		listing_id: row.listing_id,
		distance: 1 - row.score,
		score: row.score,
		confidence: embed.confidenceForCosine(row.score, second, i === 0),
		match_kind: 'embed',
	}))
	return relabelEmbedConfidence(hydrateCatalogMatches(db, rows))
}

function listingPhashCount(db) {
	try {
		return Number(db.prepare('SELECT COUNT(*) AS n FROM listing_phash WHERE algo = ?').get(PRODUCT_HASH_ALGO).n) || 0
	} catch {
		return 0
	}
}

function productMapCount(db) {
	try {
		return Number(db.prepare('SELECT COUNT(*) AS n FROM product_map').get().n) || 0
	} catch {
		return 0
	}
}

const CONF_RANK = { exact: 0, likely: 1, possible: 2, weak: 3, distant: 4 }

function shouldSkipVision(matches) {
	const best = matches && matches[0]
	return Boolean(best && (best.confidence === 'exact' || best.confidence === 'likely'))
}

const KIND_RANK = { embed: 0, vision: 1 }

function matchSource(merged) {
	if (!merged.length) return null
	const kinds = new Set(merged.map((row) => (row.match_kind === 'vision' ? 'vision' : row.match_kind === 'embed' ? 'embed' : 'phash')))
	if (kinds.size > 1) return 'hybrid'
	if (kinds.has('embed')) return 'embed'
	if (kinds.has('vision')) return 'vision'
	return 'phash'
}

function mergeMatches(...lists) {
	const combined = lists.flat().filter(Boolean)
	combined.sort((a, b) => {
		const ra = CONF_RANK[a.confidence] ?? 9
		const rb = CONF_RANK[b.confidence] ?? 9
		if (ra !== rb) return ra - rb
		const ka = KIND_RANK[a.match_kind] ?? 9
		const kb = KIND_RANK[b.match_kind] ?? 9
		if (ka !== kb) return ka - kb
		const da = Number.isFinite(a.distance) ? a.distance : 999
		const db = Number.isFinite(b.distance) ? b.distance : 999
		return da - db
	})
	const seen = new Set()
	const out = []
	for (const row of combined) {
		const key = catalogDedupeKey(row)
		if (seen.has(key)) continue
		seen.add(key)
		out.push(row)
		if (out.length >= MAX_RESULTS) break
	}
	return out
}

function emptyResult(reason, indexSize, extra = {}) {
	return {
		matches: [],
		index_size: indexSize,
		reason,
		source: null,
		query: null,
		...extra,
	}
}

async function searchByPhoto(db, body, opts = {}) {
	const raw = body && (body.photo_data || body.image_b64)
	const buf = decodePhotoData(raw)
	const indexSize = listingPhashCount(db)
	const catalogSize = productMapCount(db)
	const embedSize = embed.listingVembCount(db)
	if (!indexSize && !catalogSize && !embedSize) {
		return emptyResult('index_empty', 0)
	}

	let query
	let queryJpeg = null
	try {
		const maybeVision = vision.visionIsEnabled(opts)
		if (maybeVision) {
			;[query, queryJpeg] = await Promise.all([hashQueryImage(buf), vision.prepareQueryJpeg(buf)])
		} else {
			query = await hashQueryImage(buf)
		}
	} catch {
		throw httpError(400, 'Could not read that photo')
	}

	let phashMatches = []
	if (indexSize) {
		let hashRows = []
		try {
			hashRows = db.prepare('SELECT listing_id, phash, design_phash, canonical_key FROM listing_phash WHERE algo = ?').all(PRODUCT_HASH_ALGO)
		} catch {
			hashRows = []
		}
		phashMatches = rankAndJoin(db, query, hashRows)
	}

	if (shouldSkipVision(phashMatches)) {
		return {
			matches: phashMatches,
			index_size: indexSize,
			reason: null,
			source: 'phash',
			query: null,
		}
	}

	const embedMatches = await searchEmbeddings(db, buf, opts)
	if (shouldSkipVision(embedMatches)) {
		return {
			matches: embedMatches,
			index_size: indexSize,
			reason: null,
			source: 'embed',
			query: null,
		}
	}

	const wantVision = vision.visionIsEnabled(opts)
	if (!wantVision) {
		const merged = mergeMatches(embedMatches, phashMatches)
		if (merged.length) {
			return {
				matches: merged,
				index_size: indexSize,
				reason: null,
				source: matchSource(merged),
				query: null,
			}
		}
		const reason = catalogSize && !indexSize ? 'vision_unavailable' : indexSize ? 'no_match' : 'index_empty'
		return emptyResult(reason, indexSize)
	}

	let visionResult = { matches: [], query: null, error: null }
	try {
		visionResult = await vision.searchWithVision(db, buf, opts.vision, { queryJpeg })
	} catch {
		visionResult = { matches: [], query: null, error: 'vision_failed' }
	}

	const merged = mergeMatches(embedMatches, visionResult.matches || [], phashMatches)
	const reason = merged.length
		? null
		: visionResult.error === 'vision_failed'
			? 'vision_failed'
			: 'no_match'
	return {
		matches: merged,
		index_size: indexSize,
		reason,
		source: matchSource(merged),
		query: vision.publicQuery(visionResult.query),
	}
}

function installRoutes(app, { db } = {}) {
	const handler = async (req, res) => {
		try {
			const result = await searchByPhoto(db, req.body || {})
			res.json(result)
		} catch (err) {
			const status = Number(err.status) || 500
			res.status(status).json({ error: err.message || 'Find by photo failed' })
		}
	}
	app.post('/api/sourcing/find-by-photo', handler)
}

module.exports = {
	PRODUCT_HASH_ALGO,
	MAX_UPLOAD_BYTES,
	MAX_RESULTS,
	SCAN_CAP,
	decodePhotoData,
	confidenceFor,
	bestDistance,
	catalogDedupeKey,
	rankAndJoin,
	shouldSkipVision,
	mergeMatches,
	searchByPhoto,
	searchEmbeddings,
	installRoutes,
	HASH_WORKING_EDGE,
}
