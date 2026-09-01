'use strict'

/**
 * line-identity.js — the ONE way to name an order line.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------------------------------------------------------------
 * Every per-line fact we store — purchase status, charm, supplier override,
 * verification, fulfilment issue, model fix, design switch — is keyed by
 * `(receipt_id, item_key)`. So an order line has exactly one correct name, and
 * every surface MUST arrive at the same one. When two surfaces disagree the
 * damage is silent and severe: the shopper marks a charm bought on the mobile
 * route, the Orders tab reads a different key, sees nothing, and reports the
 * line as still to buy. Nobody gets an error; the work is simply invisible.
 *
 * That is exactly what happened. A line's name has TWO possible shapes:
 *
 *   lineItemKey(title, listing_id)                        → `title[:50]#L<listing>`
 *   lineItemKeyWithVariant(title, listing_id, model, style)→ `…#L<listing>#V<model>|<style>`
 *
 * The variant shape exists because a Route-tab manual order may carry the SAME
 * listing twice in different models/styles, which must be independent lines. So
 * "Add Order" mints variant keys and stores them in `route_manual_items` — the
 * AUTHORITY for what those lines are called. The Route tab and mobile Shopping
 * Mode read that stored key, so they were right. But every consumer that starts
 * from `receipts.all_transactions` (the Orders tab, the needs-purchase rollup,
 * the ready-to-pack classifier, the issue/model-fix context helpers) re-derived
 * the UNSUFFIXED key from the title + listing id, and therefore addressed a row
 * that shopping had never written.
 *
 * Deriving the name in eight places was the bug; this module is the single place
 * that answers it, so the two families of key can never split again.
 *
 * HOW IT RESOLVES
 * ----------------------------------------------------------------------------
 * `route_manual_items.item_key` is authoritative when present. Because those
 * keys were minted from the SAME facts that land in `all_transactions` (title,
 * listing id, and the Phone Model / Style variations), we can match a
 * transaction to its stored key by simply re-deriving the candidates and
 * claiming them:
 *
 *   pass 1 — the variant key `…#V<model>|<style>`  (strongest identity)
 *   pass 2 — the plain key   `…#L<listing>`        (pre-variant / legacy lines)
 *   else   — the derived plain key                (Etsy orders; unmatched lines)
 *
 * Claims are consumed, and each pass walks the `~2`, `~3` … dedup family that
 * "Add Order" appends when a cart legitimately repeats an identical line, so N
 * identical transactions map 1:1 onto N stored keys in order.
 *
 * It deliberately NEVER guesses positionally. A transaction we cannot match to a
 * stored key falls back to the derived key — the historical behaviour — because
 * showing a line as "not yet bought" is recoverable, whereas silently binding it
 * to a DIFFERENT product's purchase state is not.
 *
 * The alignment is a pure function (`alignLineKeys`) so it is exhaustively unit
 * tested without a database; the DB layer only supplies the stored keys.
 */

const routeDashboard = require('../route/dashboard')

/**
 * Separator "Add Order" appends when a cart repeats an identical line, so the
 * second copy gets its own row instead of colliding (`key`, `key~2`, `key~3`…).
 * Mirrors POST /api/route/manual-order + createRouteManualOrder.
 */
const DEDUP_SEPARATOR = '~'

/** Stay well below SQLite's host-parameter limit, even on older installations. */
const ID_CHUNK = 500

/**
 * The facts that name a line, normalised out of a transaction record. Handles
 * every shape order data hands us: Etsy transactions, manual `all_transactions`
 * entries, and `transactions` table rows (whose `variations` is a JSON string).
 *
 * @param {object} tx
 * @returns {{ title: string, listingId: (number|null), phoneModel: string, style: string }}
 */
function lineFacts(tx) {
	const title = String(tx?.title ?? '').trim()
	const rawId = tx?.listing_id
	const numId = Number(rawId)
	const listingId = rawId != null && String(rawId).trim() !== '' && Number.isInteger(numId) && numId > 0 ? numId : null
	let phoneModel = ''
	let style = ''
	try {
		const parsed = routeDashboard.parseVariations(tx?.variations)
		phoneModel = parsed.phoneModel || ''
		style = parsed.style || ''
	} catch {
		/* malformed variations only cost us the variant suffix, never the line */
	}
	return { title, listingId, phoneModel, style }
}

/**
 * The name a consumer would compute for a line with no stored key — the
 * product-scoped key Etsy orders have always used.
 *
 * @param {object} tx
 * @returns {string}
 */
function derivedLineKey(tx) {
	const { title, listingId } = lineFacts(tx)
	return routeDashboard.lineItemKey(title, listingId)
}

/**
 * The names a line could legitimately be stored under, strongest identity first:
 * the variant key, then the plain product key. Collapses to one entry when the
 * line carries no model/style (the two shapes are then identical).
 *
 * @param {object} tx
 * @returns {string[]}
 */
function lineKeyCandidates(tx) {
	const { title, listingId, phoneModel, style } = lineFacts(tx)
	const plain = routeDashboard.lineItemKey(title, listingId)
	const variant = routeDashboard.lineItemKeyWithVariant(title, listingId, phoneModel, style)
	return variant === plain ? [plain] : [variant, plain]
}

/**
 * Claim the first unclaimed member of a key's dedup family (`base`, `base~2`,
 * `base~3`, …), removing it from the pool so two transactions never share one
 * stored line.
 *
 * @param {string} base
 * @param {Set<string>} pool  unclaimed stored keys (mutated)
 * @returns {string|null} the claimed key, or null when the family is exhausted
 */
function claimFromFamily(base, pool) {
	if (!base) return null
	if (pool.has(base)) {
		pool.delete(base)
		return base
	}
	// Bounded by the pool size: a family can never be longer than the keys left.
	for (let n = 2; n <= pool.size + 1; n++) {
		const candidate = `${base}${DEDUP_SEPARATOR}${n}`
		if (pool.has(candidate)) {
			pool.delete(candidate)
			return candidate
		}
	}
	return null
}

/**
 * Align a receipt's transactions to the line keys stored for it. PURE — this is
 * the whole resolution rule, so it can be unit tested without a database.
 *
 * @param {Array<object>} txs        the receipt's line items, in order
 * @param {Array<string>} storedKeys `route_manual_items.item_key`, in insertion
 *        order. Empty for Etsy orders and for Orders-tab manual orders (which
 *        have no route sidecars), in which case every line keeps its derived key.
 * @returns {string[]} one canonical key per transaction, same order as `txs`
 */
function alignLineKeys(txs, storedKeys) {
	const lines = Array.isArray(txs) ? txs : []
	const resolved = new Array(lines.length).fill(null)
	const pool = new Set((Array.isArray(storedKeys) ? storedKeys : []).filter((k) => typeof k === 'string' && k !== ''))

	if (pool.size > 0) {
		const candidates = lines.map(lineKeyCandidates)
		// Pass 0 claims variant keys, pass 1 the plain product key. Running the
		// strongest identity across ALL lines first stops a model-less line from
		// stealing the plain key that a variant line would otherwise fall back to.
		for (let pass = 0; pass < 2; pass++) {
			for (let i = 0; i < lines.length; i++) {
				if (resolved[i]) continue
				// Undefined on a single-candidate line (no model/style): its one shape
				// was already offered in pass 0, so there is nothing left to try.
				const base = candidates[i][pass]
				if (!base) continue
				const claimed = claimFromFamily(base, pool)
				if (claimed) resolved[i] = claimed
			}
		}
	}

	for (let i = 0; i < lines.length; i++) {
		if (!resolved[i]) resolved[i] = derivedLineKey(lines[i])
	}
	return resolved
}

/**
 * Map a key a client submitted onto the line it actually identifies.
 *
 * Defence in depth for the write path: a browser tab loaded before this fix (or
 * a queued offline mutation minted from a stale render) can still POST the
 * unsuffixed key. Without this it would create a fresh ghost row that no other
 * surface reads — precisely the failure we are eliminating. Only an UNAMBIGUOUS
 * alias is redirected: when the order carries several variants of the same
 * product the submitted key cannot be attributed, so it is left untouched rather
 * than guessed.
 *
 * @param {string} submittedKey
 * @param {Array<string>} storedKeys the receipt's stored line keys
 * @returns {string} the canonical key, or `submittedKey` when it is already
 *          canonical / cannot be safely attributed
 */
function canonicalizeLineKey(submittedKey, storedKeys) {
	const key = String(submittedKey ?? '')
	const stored = Array.isArray(storedKeys) ? storedKeys : []
	if (!key || stored.length === 0 || stored.includes(key)) return key
	const base = routeDashboard.stripLineVariantKey(key)
	const matches = stored.filter((k) => routeDashboard.stripLineVariantKey(k) === base)
	return matches.length === 1 ? matches[0] : key
}

/**
 * Load the stored line keys for a set of receipts, in sidecar insertion order.
 * One indexed, chunked query — never an N+1 per receipt.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Array<number|string>} receiptIds
 * @returns {Map<number, string[]>} receipt_id → stored keys (absent when none)
 */
function storedLineKeysByReceipt(db, receiptIds) {
	const out = new Map()
	const ids = [...new Set((Array.isArray(receiptIds) ? receiptIds : []).map(Number).filter(Number.isInteger))]
	if (!ids.length) return out
	try {
		for (let i = 0; i < ids.length; i += ID_CHUNK) {
			const chunk = ids.slice(i, i + ID_CHUNK)
			const placeholders = chunk.map(() => '?').join(',')
			const rows = db
				.prepare(`SELECT receipt_id, item_key FROM route_manual_items WHERE receipt_id IN (${placeholders}) ORDER BY id ASC`)
				.all(chunk)
			for (const r of rows) {
				if (!out.has(r.receipt_id)) out.set(r.receipt_id, [])
				out.get(r.receipt_id).push(r.item_key)
			}
		}
	} catch {
		// The sidecar table is absent on a fresh database — every line then keeps
		// its derived key, which is exactly right.
	}
	return out
}

/**
 * A resolver for a whole page of receipts: loads the stored keys once, then
 * answers every per-line question from memory.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Array<number|string>} receiptIds
 * @returns {{
 *   storedKeys: (receiptId: number|string) => string[],
 *   keysFor:    (receiptId: number|string, txs: Array<object>) => string[],
 *   canonical:  (receiptId: number|string, itemKey: string) => string,
 * }}
 */
function lineKeyResolver(db, receiptIds) {
	const stored = storedLineKeysByReceipt(db, receiptIds)
	const keysOf = (receiptId) => stored.get(Number(receiptId)) || []
	return {
		storedKeys: keysOf,
		keysFor: (receiptId, txs) => alignLineKeys(txs, keysOf(receiptId)),
		canonical: (receiptId, itemKey) => canonicalizeLineKey(itemKey, keysOf(receiptId)),
	}
}

/**
 * Single-receipt convenience for the many endpoints that handle one order.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number|string} receiptId
 * @param {Array<object>} txs
 * @returns {string[]} one canonical key per transaction
 */
function receiptLineKeys(db, receiptId, txs) {
	return alignLineKeys(txs, storedLineKeysByReceipt(db, [receiptId]).get(Number(receiptId)) || [])
}

/**
 * Single-receipt canonicalisation of a client-submitted key.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number|string} receiptId
 * @param {string} itemKey
 * @returns {string}
 */
function canonicalLineKey(db, receiptId, itemKey) {
	return canonicalizeLineKey(itemKey, storedLineKeysByReceipt(db, [receiptId]).get(Number(receiptId)) || [])
}

/**
 * Find the transaction a stored key names — the reverse lookup used to recover a
 * line's product context (title / model / style / listing id) for the issue,
 * model-fix and design-switch workflows.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number|string} receiptId
 * @param {Array<object>} txs
 * @param {string} itemKey
 * @returns {object|null} the matching transaction, or null
 */
function findTransactionByLineKey(db, receiptId, txs, itemKey) {
	const lines = Array.isArray(txs) ? txs : []
	if (!lines.length || !itemKey) return null
	const keys = receiptLineKeys(db, receiptId, lines)
	const idx = keys.indexOf(String(itemKey))
	return idx === -1 ? null : lines[idx]
}

module.exports = {
	DEDUP_SEPARATOR,
	lineFacts,
	derivedLineKey,
	lineKeyCandidates,
	alignLineKeys,
	canonicalizeLineKey,
	storedLineKeysByReceipt,
	lineKeyResolver,
	receiptLineKeys,
	canonicalLineKey,
	findTransactionByLineKey,
}
