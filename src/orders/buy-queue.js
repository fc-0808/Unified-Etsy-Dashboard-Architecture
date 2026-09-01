'use strict'

/**
 * buy-queue.js — the single source of truth for the "🛒 Need to purchase" queue
 * scope, and for the charm shopping list ("Charms to buy") derived from it.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------------------------------------------------------------
 * Two surfaces answer the SAME question — "what still has to be bought?" — from
 * two different code paths:
 *
 *   1. GET /api/orders?shipped=needs_purchase  → the Need-to-purchase ORDER list.
 *   2. GET /api/route/charms-to-buy            → the "Charms to buy" SHOPPING list
 *                                                opened from that very tab.
 *
 * They used to derive their scope independently: (1) from the buy-queue SQL +
 * classifyPurchaseState, (2) from the Route dashboard's own 30-day pending scope.
 * The two sets therefore disagreed — the charm list counted pieces from orders
 * that were NOT in the tab at all (already fully purchased, duplicate-suppressed,
 * or outside the route's date window), so its "N pcs total" contradicted what an
 * employee could actually see and act on.
 *
 * Everything that DEFINES the queue now lives here and is imported by both, so
 * the two can never drift again: change the rule once and every consumer plus the
 * regression test (scripts/test-charms-to-buy-scope.js) moves with it. This
 * mirrors the existing pack-queue.js pattern for the Ready-to-pack queue.
 *
 * WHAT "NEED TO PURCHASE" MEANS
 * ----------------------------------------------------------------------------
 * An ORDER belongs in the queue when ALL of these hold:
 *   1. It is PAID (you don't buy stock for an order that hasn't been paid for).
 *   2. It still has to LEAVE the warehouse — Needs-shipping (unshipped) OR
 *      Pre-transit (a label was created early to beat the Etsy ship-by deadline
 *      but the parcel never entered the carrier network) — OR the operator
 *      explicitly flagged it (receipts.needs_purchase_at) regardless of state.
 *   3. It has NOT been physically packaged (packing is terminal and wins).
 *   4. It still has real work: at least one line is outstanding to buy, or the
 *      order is ON HOLD behind an open fulfilment issue.  ← classifyPurchaseState
 *
 * A CHARM LINE inside those orders belongs on the shopping list only when the
 * employee can actually act on it — see isCharmShoppingRow.
 */

const routeDashboard = require('../route/dashboard')
const { getSubstitutionsForReceipts } = require('../db/setup')
const { actionableOrderSql } = require('./dedup')
const lineIdentity = require('./line-identity')

/** Receipts that are cancelled or fully refunded never belong in any work queue. */
const NOT_CANCELLED = "status NOT IN ('Canceled', 'Cancelled', 'Fully Refunded', 'Fully refunded')"

/**
 * Component purchase statuses that still require shopping — the line is buyable
 * and not yet bought. 'Wrong Stall' belongs here: the item still needs sourcing
 * once the stall mapping is corrected.
 */
const OUTSTANDING_STATUSES = new Set(['Pending', 'Out of Stock', 'Wrong Stall'])

/**
 * Terminal component statuses: the piece CANNOT be bought at all (the product is
 * discontinued, or this phone model was never carried). Unlike 'Out of Stock'
 * — which is a "come back later" — these are dead ends awaiting an owner decision
 * (swap / refund), exactly like an open fulfilment issue. They are therefore
 * neither "outstanding" (they can't be shopped) nor "purchased" (we don't hold
 * them), and must never inflate a shopping list an employee is asked to work
 * through.
 */
const UNBUYABLE_STATUSES = new Set(['Out of Production', 'Model Unavailable'])

/** The Need-to-purchase segmented sub-filter values (All / To buy / On hold). */
const NP_FILTERS = ['all', 'tobuy', 'onhold']

/**
 * SQL fragment — the ORDER-level half of the Need-to-purchase scope (rules 1–3
 * above). The "still has work" half (rule 4) cannot be expressed in SQL (it
 * depends on per-line component statuses) and is applied by classifyPurchaseState
 * + resolveNeedsPurchaseSet.
 *
 * @param {object} config - dashboard config (reads `pre_transit_days`, default 30).
 * @param {string} alias  - the `receipts` table alias used by the caller (e.g. 'r').
 * @returns {string} a SQL boolean expression (never contains user input).
 */
function needsPurchaseScopeSql(config = {}, alias = 'r') {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new TypeError('Invalid SQL alias')
	const preTransitDays = config.pre_transit_days ?? 30
	const cutoff = Math.floor(Date.now() / 1000) - preTransitDays * 24 * 3600
	const a = alias
	return `(
      (
        (${a}.is_shipped = 0 AND ${a}.${NOT_CANCELLED})
        OR
        (${a}.is_shipped = 1
          AND ${a}.tracking_code IS NOT NULL
          AND ${a}.shipment_notified_at IS NOT NULL
          AND ${a}.shipment_notified_at >= ${cutoff}
          AND ${a}.carrier_confirmed_at IS NULL
          AND ${a}.${NOT_CANCELLED})
        OR
        (${a}.needs_purchase_at IS NOT NULL AND ${a}.${NOT_CANCELLED})
      )
      AND ${a}.is_paid = 1
      AND ${a}.packaged_at IS NULL
    )`
}

/**
 * Classify a candidate set of receipts by purchasing progress.
 *
 * A single order line is "to buy" when it has a recognised Case/Grip/Charm
 * component still Pending / Out of Stock / Wrong Stall (components default to
 * Pending until the operator marks them bought), OR — for a line with no
 * components — when its binary receipt_item_purchase flag is set.
 *
 * There are THREE distinct buckets, not two, because the operator can EXCLUDE a
 * line from the next route or DISMISS it from the dashboard. Such a line is out
 * of the active purchasing queue but is NOT therefore purchased — so it must fall
 * out of BOTH the buy queue and the ready-to-pack queue:
 *
 *   • outstanding (Needs purchase)  — at least one line is still to buy AND has
 *                                     NOT been excluded/dismissed. Mirrors the
 *                                     Route dashboard's active shopping list, so
 *                                     the two stay reconciled.
 *   • ready (Ready to pack)         — EVERY line is fully purchased, considering
 *                                     ALL lines INCLUDING excluded/dismissed ones
 *                                     (an excluded line whose product was never
 *                                     bought must never mark an order shippable).
 *   • neither                       — an order with an excluded/dismissed line
 *                                     that is still unpurchased sits in a
 *                                     deliberate limbo until the operator either
 *                                     buys it or re-includes it.
 *
 * `ready` and `outstanding` are mutually exclusive but NOT exhaustive. Loads the
 * route_assignments + receipt_item_purchase tables ONCE and reads each receipt's
 * already-cached `all_transactions`, so filtering a full page never triggers an
 * N+1 query storm.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Array<{receipt_id:number, all_transactions:string}>} candidates
 * @returns {{ ready:Set<number>, outstanding:Set<number>, verified:Set<number>, onHold:Set<number> }}
 *          verified ⊆ ready — fully in hand AND every packable line packer-confirmed.
 *          onHold — has ≥1 open, non-superseded fulfilment issue (buy-queue split).
 */
function _rowsForReceiptIds(db, selectSql, receiptIds, tailSql = '') {
	const out = []
	// Stay well below SQLite's host-parameter limit, even on older installations.
	for (let i = 0; i < receiptIds.length; i += 500) {
		const chunk = receiptIds.slice(i, i + 500)
		const placeholders = chunk.map(() => '?').join(',')
		out.push(...db.prepare(`${selectSql} WHERE receipt_id IN (${placeholders}) ${tailSql}`).all(chunk))
	}
	return out
}

function classifyPurchaseState(db, candidates) {
	const receiptIds = [...new Set((candidates || []).map((c) => Number(c.receipt_id)).filter(Number.isInteger))]
	const ra = new Map() // `${receipt_id}\x00${item_key}` → component statuses
	const rip = new Map() // `${receipt_id}\x00${item_key}` → { needs_purchase }
	try {
		_rowsForReceiptIds(db, 'SELECT receipt_id, item_key, status_case, status_grip, status_charm, excluded, dismissed_at, verified_at FROM route_assignments', receiptIds)
			.forEach((x) => ra.set(`${x.receipt_id}\x00${x.item_key}`, x))
	} catch {
		/* table may be missing on first run */
	}
	try {
		_rowsForReceiptIds(db, 'SELECT receipt_id, item_key, needs_purchase, verified_at FROM receipt_item_purchase', receiptIds)
			.forEach((x) => rip.set(`${x.receipt_id}\x00${x.item_key}`, x))
	} catch {
		/* table may be missing on first run */
	}
	// Design switches — a switched line's components come from the REPLACEMENT
	// design's style, so the buy/ready classification reflects what we actually buy.
	let subMap = new Map()
	try {
		const byReceipt = getSubstitutionsForReceipts(db, receiptIds)
		for (const rows of Object.values(byReceipt)) {
			for (const row of rows) subMap.set(`${row.receipt_id}\x00${row.item_key}`, row)
		}
	} catch {
		/* table may be missing on first run */
	}
	// Open fulfilment issues — used to derive the ON-HOLD set. An order is on hold
	// when it has an open issue that is NOT superseded by a newer design switch
	// (the exact rule the per-line `issue.on_hold` flag uses), so the buy-queue
	// sub-filters ("To buy" vs "On hold") agree with the on-hold chip shown on the row.
	const issueMap = new Map() // `${receipt_id}\x00${item_key}` → open issue row
	try {
		_rowsForReceiptIds(db, 'SELECT receipt_id, item_key, status, updated_at FROM order_issues', receiptIds, "AND status = 'open'")
			.forEach((x) => issueMap.set(`${x.receipt_id}\x00${x.item_key}`, x))
	} catch {
		/* table may be missing on first run */
	}

	const ready = new Set()
	const outstanding = new Set()
	// on hold — has ≥1 genuinely-held line (open issue, not superseded by a switch).
	const onHold = new Set()
	// verified ⊆ ready: an order is "verified" when it is fully in hand AND every
	// packable (non-excluded / non-dismissed) line has been physically confirmed by
	// a packer (verified_at set). Drives the morning verification worklist and the
	// optional require_verify_before_pack gate.
	// Canonical line keys for every candidate receipt — one batched lookup so a
	// Route-tab manual order's per-variant `#V…` keys resolve to the same rows
	// Shopping Mode and the Route tab wrote (plain title+listing keys miss them).
	const lineKeys = lineIdentity.lineKeyResolver(db, receiptIds)

	const verified = new Set()
	for (const c of candidates) {
		let txs = []
		try {
			txs = JSON.parse(c.all_transactions || '[]')
		} catch {
			txs = []
		}
		if (!Array.isArray(txs)) txs = []

		const keys = lineKeys.keysFor(c.receipt_id, txs)
		const seen = new Set()
		// buyQueueOutstanding — any NON-excluded / NON-dismissed line still to buy
		//                       (drives the Needs-purchase queue; mirrors the Route).
		// anyNotInHand         — any line at all still to buy, INCLUDING excluded /
		//                        dismissed ones (blocks ready-to-pack: the product is
		//                        not actually in hand just because it was excluded).
		let buyQueueOutstanding = false
		let anyNotInHand = false
		// allVerified — every packable, in-hand line carries a verified_at stamp.
		// Starts true and is cleared the moment a required line is found unverified.
		let allVerified = true
		let orderOnHold = false
		txs.forEach((t, i) => {
			const key = keys[i]
			if (seen.has(key)) return
			seen.add(key)
			const a = ra.get(`${c.receipt_id}\x00${key}`) || {}
			const sub = subMap.get(`${c.receipt_id}\x00${key}`)
			const comps = lineComponents(t, sub)
			// On-hold detection (superseded-aware) — matches the per-line issue.on_hold.
			const iss = issueMap.get(`${c.receipt_id}\x00${key}`)
			if (iss && !routeDashboard.substitutionSupersedesIssue(sub, iss)) orderOnHold = true
			// Two DISTINCT per-line signals:
			//   lineToBuy     — actively buyable but not yet bought (Pending / Out of Stock);
			//                   drives the Needs-purchase / 等待备货 buy queue.
			//   lineNotInHand — the component is anything other than "Purchased" (Pending,
			//                   Out of Stock, OR Out of Production). Blocks Ready-to-pack:
			//                   a product that isn't physically in hand can't be packed —
			//                   an out-of-production item is NOT "purchased/ready" even
			//                   though you can't buy it either.
			let lineToBuy
			let lineNotInHand
			if (comps.length) {
				lineToBuy = comps.some((comp) => OUTSTANDING_STATUSES.has(a[`status_${comp}`] || 'Pending'))
				lineNotInHand = comps.some((comp) => (a[`status_${comp}`] || 'Pending') !== 'Purchased')
			} else {
				const b = rip.get(`${c.receipt_id}\x00${key}`)
				lineToBuy = !!(b && b.needs_purchase === 1)
				lineNotInHand = lineToBuy // no components → the binary buy flag is the only signal
			}
			if (lineNotInHand) anyNotInHand = true
			// Excluded / dismissed lines leave the ACTIVE buy queue (so they don't keep the
			// order in Needs-purchase, matching the Route) but still block ready-to-pack.
			if (lineToBuy && !a.excluded && !a.dismissed_at) buyQueueOutstanding = true
			// Verification is only required for lines that will actually be packed:
			// in hand (not lineNotInHand) and not excluded/dismissed. Component lines
			// carry verified_at on the route_assignments row; no-component lines on the
			// receipt_item_purchase row.
			if (!lineNotInHand && !a.excluded && !a.dismissed_at) {
				const lineVerified = comps.length ? !!a.verified_at : !!(rip.get(`${c.receipt_id}\x00${key}`) || {}).verified_at
				if (!lineVerified) allVerified = false
			}
		})
		if (buyQueueOutstanding) outstanding.add(c.receipt_id)
		if (orderOnHold) onHold.add(c.receipt_id)
		// Ready ⇔ EVERY line is Purchased (physically in hand). Anything not in hand —
		// still to buy OR out of production — keeps the order out of the packing queue.
		if (!anyNotInHand) {
			ready.add(c.receipt_id)
			// An order with no packable lines at all (e.g. everything excluded) is
			// vacuously "verified"; otherwise it needs every packable line confirmed.
			if (allVerified) verified.add(c.receipt_id)
		}
	}
	return { ready, outstanding, verified, onHold }
}

/**
 * Present Case/Grip/Charm components of an order line, honouring a design switch
 * (we classify what we will actually BUY — the replacement design's style).
 * @param {object} tx - raw Etsy transaction (carries `variations`).
 * @param {object|null} sub - active substitution for the line, if any.
 * @returns {Array<'case'|'grip'|'charm'>}
 */
function lineComponents(tx, sub) {
	const parsed = routeDashboard.parseVariations(tx.variations)
	const style = sub && sub.new_style ? sub.new_style : parsed.style
	// The effective identity of the line also tells styleComponents what a
	// single-axis product (a watch band) physically is, since its size-only
	// variation carries no bundle words to read.
	const phoneModel = (sub && sub.new_phone_model) || parsed.phoneModel || ''
	const title = (sub && sub.new_title) || tx.title || ''
	const sc = routeDashboard.styleComponents(style, { phoneModel, title })
	const out = []
	if (sc.hasCase) out.push('case')
	if (sc.hasGrip) out.push('grip')
	if (sc.hasCharm) out.push('charm')
	return out
}

/**
 * The receipts the Need-to-purchase tab shows, given a classification and the
 * segmented sub-filter:
 *   • onhold → orders genuinely on hold (open, non-superseded issue).
 *   • tobuy  → orders with real buy work that are NOT on hold. On-hold orders are
 *              pending an owner decision (swap/refund), so they are deliberately
 *              kept OUT of the clean buy list — even a mixed order (one line to
 *              buy + one on hold) lives under "On hold" until resolved.
 *   • all    → both, unioned. This is the tab's default and the scope the charm
 *              shopping list is built from.
 *
 * @param {{outstanding:Set<number>, onHold:Set<number>}} classification
 * @param {string} [npFilter] one of NP_FILTERS (anything else behaves as 'all').
 * @returns {Set<number>}
 */
function resolveNeedsPurchaseSet({ outstanding, onHold }, npFilter = 'all') {
	if (npFilter === 'onhold') return new Set(onHold)
	if (npFilter === 'tobuy') return new Set([...outstanding].filter((id) => !onHold.has(id)))
	return new Set([...outstanding, ...onHold])
}

/**
 * Size of each Need-to-purchase sub-filter, from a single classification pass.
 *
 * The tab's COUNT BADGE reports `tobuy`, not `all`: an on-hold order is waiting
 * on an owner decision (message the buyer → swap or refund), so it is not work a
 * packer can pick up. Counting it made the badge overstate the shopping backlog.
 * On-hold orders are still LISTED under the All / On hold sub-filters — a packer
 * has to be able to reconcile the in-hand pieces of a partially-blocked order —
 * they are simply not counted as outstanding work.
 *
 * Derived through resolveNeedsPurchaseSet so the numbers can never disagree with
 * the sets the sub-filters actually produce. Note `all === tobuy + onhold` holds
 * by construction: 'tobuy' is exactly `outstanding` minus `onHold`.
 *
 * @param {{outstanding:Set<number>, onHold:Set<number>}} classification
 * @returns {{all:number, tobuy:number, onhold:number}}
 */
function needsPurchaseBreakdown(classification) {
	return {
		all: resolveNeedsPurchaseSet(classification, 'all').size,
		tobuy: resolveNeedsPurchaseSet(classification, 'tobuy').size,
		onhold: resolveNeedsPurchaseSet(classification, 'onhold').size,
	}
}

/**
 * Resolve the EXACT receipt set the Need-to-purchase tab lists, end to end.
 *
 * This is the scope the "Charms to buy" list must be built from: whatever this
 * returns is precisely what an employee sees in the tab, so the charm totals can
 * always be reconciled against the orders on screen.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} config - dashboard config.
 * @param {object} [opts]
 * @param {string} [opts.npFilter='all'] - segmented sub-filter (see NP_FILTERS).
 * @param {Set<number>} [opts.suppressedReceiptIds] - Etsy double-fire "ghost"
 *        receipts hidden from every view. The dedup rule is owned by
 *        src/orders/dedup.js and is DB-read by the caller (that module is
 *        deliberately DB-free), so it must be passed in for the scope to match
 *        the Orders API exactly.
 * @returns {Set<number>}
 */
function needsPurchaseReceiptIds(db, config, opts = {}) {
	const { npFilter = 'all', suppressedReceiptIds = null } = opts
	const conditions = [actionableOrderSql('r'), needsPurchaseScopeSql(config, 'r')]
	if (suppressedReceiptIds && suppressedReceiptIds.size > 0) {
		// receipt_ids are integers from our own DB — inline them directly so we are
		// never bound by SQLite's host-parameter limit on a large queue.
		const idList = [...suppressedReceiptIds].map(Number).filter(Number.isInteger).join(',')
		if (idList) conditions.push(`r.receipt_id NOT IN (${idList})`)
	}
	const candidates = db.prepare(`SELECT r.receipt_id, r.all_transactions FROM receipts r WHERE ${conditions.join(' AND ')}`).all()
	return resolveNeedsPurchaseSet(classifyPurchaseState(db, candidates), npFilter)
}

/**
 * Does this route row belong on the "Charms to buy" shopping list?
 *
 * Given a row from an order ALREADY in the Need-to-purchase scope, the list must
 * contain exactly the charms an employee can walk to a stall and buy — no more,
 * no less. A charm piece is on the list when every one of these holds:
 *
 *   1. The line carries a charm that is separately sourced. AirPods cases ship
 *      with the charm attached (charm_integral) — it is bought WITH the case and
 *      has no code/stall, so it is not a charm-stall errand.
 *   2. The charm is not held by an OPEN wrong-model exchange. An exchange holds
 *      only the pieces listed on it (the case, by default) — the charm on the
 *      same line still has to be bought, which is why we ask
 *      shoppableComponentFlags rather than dropping the whole line.
 *   3. The line is not held out of purchasing by an open fulfilment issue
 *      (out of production / model unavailable). Route rows normally omit these
 *      entirely; the guard keeps the predicate correct for any caller that opted
 *      into include_issues.
 *   4. The line is still live: not excluded from the route, not dismissed, and
 *      the parcel has not already been sealed (packing is terminal).
 *   5. The charm itself is buyable — its status is not a terminal dead end
 *      (see UNBUYABLE_STATUSES). Already-Purchased charms DO stay on the list:
 *      they are the "9 of 18 purchased" progress an employee ticks off, and
 *      keeping them is what makes the stepper reversible.
 *
 * Mirrored client-side by `_charmPurchaseScopeRows()` in public/index.html, which
 * applies the same rules to the owner's Route-tab scope. Keep the two in step.
 *
 * @param {object} row - a row from routeDashboard.buildRouteRows.
 * @returns {boolean}
 */
function isCharmShoppingRow(row) {
	if (!row || !row.has_charm || row.charm_integral) return false
	if (row.excluded || row.dismissed) return false
	if (row.packaged_at) return false
	if (row.has_issue) return false
	if (!routeDashboard.shoppableComponentFlags(row).has_charm) return false
	return !UNBUYABLE_STATUSES.has(row.status_charm || 'Pending')
}

module.exports = {
	NOT_CANCELLED,
	NP_FILTERS,
	OUTSTANDING_STATUSES,
	UNBUYABLE_STATUSES,
	needsPurchaseScopeSql,
	classifyPurchaseState,
	resolveNeedsPurchaseSet,
	needsPurchaseBreakdown,
	needsPurchaseReceiptIds,
	isCharmShoppingRow,
}
