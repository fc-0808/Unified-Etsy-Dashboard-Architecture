'use strict';

/**
 * Etsy double-fire / "ghost receipt" de-duplication — single source of truth.
 *
 * Etsy occasionally issues two distinct receipt_ids for what is effectively the
 * same purchase:
 *   • a buyer double-taps "Buy Now"; or
 *   • Etsy's checkout fires a provisional receipt when the buyer starts payment,
 *     that receipt stays "Payment Processing" (unpaid) while the payment clears,
 *     and when it finally clears Etsy issues a SECOND, brand-new receipt_id that
 *     becomes the real "Paid" order.
 *
 * The losing half — the provisional receipt — never clears payment, so Etsy never
 * computes its `expected_ship_date`. It is invisible in the seller's own Etsy
 * order manager, yet it lingers in our mirror and surfaces in "Needs shipping"
 * with NO "Ship by" date. That is the exact bug this module prevents.
 *
 * ── Why a pure module (not a method on the server) ────────────────────────────
 * This logic decides which orders an operator sees. It must be correct and it
 * must stay correct. Extracting it as a pure, dependency-free function lets us
 * unit-test every edge case with synthetic fixtures (see scripts/test-dedup.js)
 * without a live database, so a future refactor can never silently reintroduce a
 * ghost. The server passes in the receipt rows; this file never touches the DB.
 *
 * ── The invariant that makes wide pairing SAFE ────────────────────────────────
 * A PROVISIONAL receipt is unpaid, unshipped, and has no ship-by date. Etsy never
 * committed it, so it can NEVER be legitimately shipped and never carries any
 * fulfilment work. Therefore collapsing a provisional receipt into a real twin of
 * the same buyer+product+shop only ever removes noise — it can never hide a real
 * order — REGARDLESS of how many days of payment-processing lag separate the two.
 * A REAL (paid/shipped) order, by contrast, is only collapsed when it fired within
 * a tight window of the survivor (the rare case where both halves of a double-fire
 * cleared payment); a real order created far from the survivor is treated as a
 * genuine separate re-purchase and is intentionally kept.
 */

// Tight window (seconds) within which two *real* (paid/shipped) same-key receipts
// are treated as a single double-fire rather than two genuine orders. A legitimate
// re-purchase minutes/hours apart is deliberately kept as two orders.
const DEDUP_WINDOW_SEC = 300; // 5 minutes — real-vs-real double-fire only

/**
 * Score how "committed" a receipt is. Shipped beats paid beats has-a-ship-by-date.
 * Used to pick the survivor of a cluster: the most-progressed receipt always wins,
 * so a shipped/paid order can never be collapsed into an unpaid ghost.
 * @param {{is_shipped?: number, is_paid?: number, first_ship_by?: number|null}} r
 * @returns {number}
 */
function score(r) {
	return (r.is_shipped ? 8 : 0) + (r.is_paid ? 4 : 0) + (r.first_ship_by ? 2 : 0);
}

/**
 * A receipt Etsy never committed: unpaid, unshipped, and with no ship-by date.
 * This is the exact fingerprint of the losing half of a double-fire. Because it is
 * unpaid it can never be legitimately shipped, so it is safe to collapse it into a
 * real twin at ANY time distance.
 * @param {{is_paid?: number, is_shipped?: number, first_ship_by?: number|null}} r
 * @returns {boolean}
 */
function isProvisional(r) {
	return !r.is_paid && !r.is_shipped && !r.first_ship_by;
}

/**
 * Cluster key: same shop + same buyer + same product.
 *   buyer   → buyer_user_id when present, else name+zip (guards against a missing
 *             user id on legacy/imported rows).
 *   product → first_listing_id when present, else the normalised first title.
 * @param {object} r
 * @returns {string}
 */
function buildClusterKey(r) {
	const buyerKey = r.buyer_user_id
		? `uid:${r.buyer_user_id}`
		: `name:${(r.buyer_name || '').trim().toLowerCase()}|zip:${(r.shipping_zip || '').trim()}`;
	const productKey = r.first_listing_id
		? `lid:${r.first_listing_id}`
		: `title:${(r.first_product_title || '').trim().toLowerCase().slice(0, 60)}`;
	return `${r.shop_id}|${buyerKey}|${productKey}`;
}

/**
 * Identify near-duplicate "double-fire" receipts across the whole receipt set and
 * decide, for each same-key group, which single receipt is authoritative.
 *
 * ── Why this is computed GLOBALLY (over every receipt, not per page) ───────────
 * A duplicate's surviving sibling and its ghost routinely land in DIFFERENT tab
 * filters — the real order becomes shipped/Completed while the ghost stays
 * unshipped in "Needs shipping". A dedup pass that only sees one page's rows could
 * never pair them. Computing the suppressed set over every receipt once, then
 * excluding it from every query, hides each duplicate consistently in EVERY view
 * and keeps COUNT(*)/pagination exact.
 *
 * ── The algorithm ─────────────────────────────────────────────────────────────
 * Group by (shop, buyer, product). For each group of 2+ receipts:
 *   1. Pick the SURVIVOR = the most-progressed receipt (highest score), ties broken
 *      by the higher (latest) receipt_id. A shipped/paid order therefore always
 *      beats an unpaid "Payment Processing" ghost.
 *   2. Suppress every OTHER receipt that is EITHER:
 *        • a provisional ghost — collapsed at ANY time distance (safe: it can never
 *          be legitimately shipped); OR
 *        • a real order that fired within DEDUP_WINDOW_SEC of the survivor (a rare
 *          double-fire where both halves cleared payment).
 *      A real order far from the survivor is a genuine separate purchase — kept.
 *
 * This deliberately does NOT time-bucket the group before choosing the survivor.
 * An earlier implementation chained same-key receipts into sub-clusters only when
 * consecutive creations fell within a fixed window, which split a provisional ghost
 * away from its real twin whenever Etsy's payment pipeline left them more than that
 * window apart (observed: 5 DAYS) — so the ghost was never paired and never hidden.
 * Evaluating the whole group against a single survivor removes that failure mode.
 *
 * Manual orders (negative receipt_id, source='manual') are operator-authored, never
 * an Etsy double-fire, and must be filtered out by the caller's query.
 *
 * @param {Array<object>} rows - receipt rows with at least: receipt_id, shop_id,
 *   buyer_user_id, buyer_name, shipping_zip, first_listing_id, first_product_title,
 *   first_ship_by, is_paid, is_shipped, etsy_created_at.
 * @returns {{ suppressed: Set<number>, survivorOf: Map<number, number[]> }}
 *   suppressed — receipt_ids to hide from every view.
 *   survivorOf — survivor receipt_id → list of receipt_ids it absorbed (audit).
 */
function computeDuplicateSuppression(rows) {
	const suppressed = new Set();
	const survivorOf = new Map();
	if (!Array.isArray(rows) || rows.length === 0) return { suppressed, survivorOf };

	const groups = new Map();
	for (const r of rows) {
		const key = buildClusterKey(r);
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(r);
	}

	for (const group of groups.values()) {
		if (group.length < 2) continue;

		// Group-wide survivor: the most-progressed order wins, ties → latest receipt.
		let survivor = group[0];
		for (const c of group) {
			const cs = score(c);
			const ss = score(survivor);
			if (cs > ss || (cs === ss && c.receipt_id > survivor.receipt_id)) survivor = c;
		}

		const absorbed = [];
		for (const c of group) {
			if (c.receipt_id === survivor.receipt_id) continue;
			const gap = Math.abs((c.etsy_created_at || 0) - (survivor.etsy_created_at || 0));
			if (isProvisional(c) || gap <= DEDUP_WINDOW_SEC) {
				suppressed.add(c.receipt_id);
				absorbed.push(c.receipt_id);
			}
		}
		if (absorbed.length) survivorOf.set(survivor.receipt_id, absorbed);
	}

	return { suppressed, survivorOf };
}

module.exports = {
	DEDUP_WINDOW_SEC,
	score,
	isProvisional,
	buildClusterKey,
	computeDuplicateSuppression,
};
