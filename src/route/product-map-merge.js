'use strict'

/**
 * Operator-declared "same product" merge for the Sourcing catalog drawer.
 *
 * The shopping route already has listing-id merges (`product-merges`). The
 * Sourcing supplier drawer shows `product_map` cards — often several Etsy
 * titles for one physical shelf item that the automatic / presentation
 * groupers did not collapse. An employee standing at the stall clicks those
 * cards; this module writes a shared `canonical_product_key` so they become
 * one card, and — when listing ids can be resolved from those titles —
 * also records durable `product_merges` edges so the shopping route agrees.
 */

const productMerges = require('./product-merges')
const routeDashboard = require('./dashboard')

/**
 * Exact title_norm → listing_id map from live listings + most-recent order lines.
 * Never includes fuzzy image matches.
 */
function buildExactListingIndex(db) {
	const byNorm = new Map()
	try {
		const listings = db
			.prepare("SELECT listing_id, title FROM listings WHERE title IS NOT NULL AND title <> ''")
			.all()
		for (const row of listings) {
			const norm = routeDashboard.normalizeTitle(row.title)
			const id = productMerges.normId(row.listing_id)
			if (!norm || id == null || byNorm.has(norm)) continue
			byNorm.set(norm, id)
		}
	} catch {
		/* listings may be absent on a minimal DB */
	}

	try {
		const receipts = db
			.prepare("SELECT all_transactions FROM receipts WHERE all_transactions IS NOT NULL AND all_transactions <> ''")
			.all()
		const bestTip = new Map()
		for (const receipt of receipts) {
			let txs = []
			try {
				txs = JSON.parse(receipt.all_transactions || '[]')
			} catch {
				continue
			}
			if (!Array.isArray(txs)) continue
			for (const tx of txs) {
				const norm = routeDashboard.normalizeTitle(tx.title || '')
				const id = productMerges.normId(tx.listing_id)
				if (!norm || id == null) continue
				const tip = Number(tx.transaction_id) || 0
				const prior = bestTip.get(norm)
				if (prior && tip < prior.tip) continue
				bestTip.set(norm, { id, tip })
			}
		}
		for (const [norm, hit] of bestTip) {
			if (!byNorm.has(norm)) byNorm.set(norm, hit.id)
		}
	} catch {
		/* receipts may be absent */
	}

	return byNorm
}

/**
 * Best-effort listing id for a product_map title.
 */
function resolveListingIdForTitle(db, title, titleNorm, index) {
	const norm = String(titleNorm || routeDashboard.normalizeTitle(title || '') || '').trim()
	if (!norm) return null
	const map = index || buildExactListingIndex(db)
	const id = map.get(norm)
	return id == null ? null : id
}

/**
 * Prefer an existing operator/hash key; otherwise mint a durable manual key
 * anchored on the smallest product_map id in the selection.
 */
function chooseCanonicalKey(rows) {
	const existing = rows
		.map((r) => String(r.canonical_product_key || '').trim())
		.filter(Boolean)
	if (existing.length) {
		const hashed = existing.find((k) => /^P-/i.test(k))
		if (hashed) return hashed
		return existing.sort()[0]
	}
	const minId = Math.min(...rows.map((r) => Number(r.id)))
	return `manual:pm-${minId}`
}

/**
 * Merge two or more active product_map rows into one physical-product identity.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number[]} productIds
 * @param {{ note?: string, createdBy?: string }} [opts]
 * @returns {{ product_ids: number[], canonical_product_key: string, listing_ids: number[], edges_inserted: number }}
 */
function mergeProductMapRows(db, productIds, opts = {}) {
	const ids = [...new Set((Array.isArray(productIds) ? productIds : []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))]
	if (ids.length < 2) {
		throw Object.assign(new Error('Select at least two distinct catalog products to merge.'), { status: 400, code: 'REQUIRED' })
	}

	const placeholders = ids.map(() => '?').join(',')
	const rows = db
		.prepare(`SELECT id, title, title_norm, canonical_product_key, status FROM product_map WHERE id IN (${placeholders})`)
		.all(...ids)

	if (rows.length !== ids.length) {
		throw Object.assign(new Error('One or more selected products were not found.'), { status: 404, code: 'NOT_FOUND' })
	}
	const inactive = rows.find((r) => r.status !== 'active')
	if (inactive) {
		throw Object.assign(new Error('Only active catalog products can be merged.'), { status: 409, code: 'CONFLICT' })
	}

	const canonical = chooseCanonicalKey(rows)
	const listingIndex = buildExactListingIndex(db)
	const listingIds = []
	for (const row of rows) {
		const listingId = resolveListingIdForTitle(db, row.title, row.title_norm, listingIndex)
		if (listingId != null) listingIds.push(listingId)
	}
	const uniqueListings = [...new Set(listingIds)]

	let edgesInserted = 0
	const note = String(opts.note || 'sourcing-drawer').slice(0, 500)
	const createdBy = String(opts.createdBy || '').slice(0, 120)
	const now = Math.floor(Date.now() / 1000)

	const setKey = db.prepare("UPDATE product_map SET canonical_product_key = ?, updated_at = ? WHERE id = ? AND status = 'active'")
	const tx = db.transaction(() => {
		for (const row of rows) setKey.run(canonical, now, row.id)
		if (uniqueListings.length >= 2) {
			edgesInserted = productMerges.linkProducts(db, uniqueListings, { note, createdBy })
		}
	})
	tx()

	return {
		product_ids: ids.sort((a, b) => a - b),
		canonical_product_key: canonical,
		listing_ids: uniqueListings.sort((a, b) => a - b),
		edges_inserted: edgesInserted,
	}
}

module.exports = {
	buildExactListingIndex,
	resolveListingIdForTitle,
	chooseCanonicalKey,
	mergeProductMapRows,
}
