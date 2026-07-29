'use strict'

/**
 * pack-queue.js — the single source of truth for the "Ready-to-pack"
 * ("📦 To pack & ship") queue scope.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------------------------------------------------------------
 * The Ready-to-pack scope is built in the /api/orders handler (src/server/index.js)
 * and is ALSO asserted by a regression test (scripts/test-pack-queue-exchange.js).
 * Keeping the SQL predicates here — imported by both — means the two can never
 * silently drift: change the rule in one place and every consumer + the test move
 * together. (Mirrors the codebase's existing "test the pure function" style, e.g.
 * routeDashboard.buildRouteRows and scripts/test-route-shop-filter.js.)
 *
 * WHAT "READY TO PACK" MEANS
 * ----------------------------------------------------------------------------
 * The queue answers exactly one question: "which orders can a packer physically
 * pack and ship right now?" An order qualifies when ALL of these hold:
 *   1. It still has to LEAVE the warehouse — Needs-shipping (unshipped) OR
 *      Pre-transit (a label was created early to beat the Etsy ship-by deadline
 *      but the parcel never actually entered the carrier network).   ← this file
 *   2. It owes NO wrong-model supplier swap (see order_exchanges).    ← this file
 *   3. Every product is fully purchased / in hand.        ← classifyPurchaseState
 *   4. It has not already been physically packaged.       ← the `packaged` filter
 * Halves 3 & 4 are queue-agnostic (reused by other views), so they stay in the
 * handler; halves 1 & 2 are the queue's defining shape and live here.
 *
 * All functions return SQL FRAGMENTS (never run user input) or read-only counts,
 * so they are safe to interpolate directly into a prepared statement's text.
 */

// Receipts that are cancelled or fully refunded never belong in any work queue.
const NOT_CANCELLED = "status NOT IN ('Canceled', 'Cancelled', 'Fully Refunded', 'Fully refunded')"

/**
 * SQL fragment — the ship-state half of the Ready-to-pack scope: the order still
 * has to leave the warehouse (Needs-shipping OR Pre-transit within the
 * pre_transit_days window and not yet carrier-confirmed).
 *
 * @param {object} config - dashboard config (reads `pre_transit_days`, default 30).
 * @param {string} alias  - the `receipts` table alias used by the caller (e.g. 'r').
 */
function readyToPackShipStateSql(config = {}, alias = 'r') {
	const preTransitDays = config.pre_transit_days ?? 30
	const cutoff = Math.floor(Date.now() / 1000) - preTransitDays * 24 * 3600
	const a = alias
	return `(
      (${a}.is_shipped = 0 AND ${a}.${NOT_CANCELLED})
      OR
      (${a}.is_shipped = 1
        AND ${a}.tracking_code IS NOT NULL
        AND ${a}.shipment_notified_at IS NOT NULL
        AND ${a}.shipment_notified_at >= ${cutoff}
        AND ${a}.carrier_confirmed_at IS NULL
        AND ${a}.${NOT_CANCELLED})
    )`
}

/**
 * SQL fragment — TRUE when the receipt aliased `alias` still owes at least one
 * OPEN wrong-model exchange: the item is physically in hand but in the WRONG
 * phone model and must be swapped at the supplier before the parcel can ship.
 */
function openExchangeExistsSql(alias = 'r') {
	return `EXISTS (SELECT 1 FROM order_exchanges oe WHERE oe.receipt_id = ${alias}.receipt_id AND oe.status = 'open')`
}

/**
 * SQL fragment — the exchange-hold half of the Ready-to-pack scope: exclude any
 * order still owing a swap.
 *
 * WHY THIS GUARD IS LOAD-BEARING (not cosmetic): a line awaiting exchange keeps
 * its components marked "Purchased" by design (so it is never re-bought), which
 * means classifyPurchaseState correctly counts the order as fully purchased. With
 * NOTHING else stopping it, that order would surface in the packing queue and a
 * packer could seal + ship the WRONG model — the exact failure the order_exchanges
 * table exists to prevent (see src/db/setup.js). The order re-enters the queue the
 * moment the exchange is marked done (which flips the swapped pieces back to
 * Purchased); meanwhile it stays visible in the "To exchange" bucket, never lost.
 */
function excludeOpenExchangeSql(alias = 'r') {
	return `NOT ${openExchangeExistsSql(alias)}`
}

/**
 * How many orders are currently HELD OUT of the packing queue purely because they
 * owe a wrong-model swap: they are in the Ready-to-pack ship-state, not yet
 * packaged, and have an open exchange. Powers the reassurance chip on the packing
 * screen ("🔁 N awaiting a supplier swap") so held orders never feel like they
 * silently vanished. Defensive: returns 0 if the table is missing (fresh DB).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} config - dashboard config (for the pre_transit window).
 * @returns {number}
 */
function openExchangeHoldCount(db, config = {}) {
	try {
		const row = db
			.prepare(
				`SELECT COUNT(DISTINCT r.receipt_id) AS n
         FROM receipts r
         WHERE ${openExchangeExistsSql('r')}
           AND ${readyToPackShipStateSql(config, 'r')}
           AND r.packaged_at IS NULL`,
			)
			.get()
		return (row && row.n) || 0
	} catch {
		return 0
	}
}

/**
 * Start-of-local-day (unix seconds) for the day containing `nowMs`. Cohorts are
 * expressed in the operator's LOCAL day because "shopped yesterday" means the
 * previous *working day* on the packing bench, not a UTC boundary.
 */
function startOfLocalDaySec(nowMs) {
	const d = new Date(nowMs)
	d.setHours(0, 0, 0, 0)
	return Math.floor(d.getTime() / 1000)
}

/**
 * SQL fragment — restrict a receipts scope to a purchase-completion COHORT, i.e.
 * orders whose shopping was FINISHED (receipts.purchase_completed_at stamped) in a
 * given local-day window. This is what lets the packer pull up exactly "the orders
 * I shopped yesterday / on my last trip" the next morning, instead of the whole
 * ever-purchased pile — so a shopped-but-never-packed order can't hide in backlog.
 *
 *   'today'     — completed since local midnight today.
 *   'yesterday' — completed during the whole of the previous local day.
 *   'recent'    — completed since the start of yesterday (yesterday + today; the
 *                 usual "my last shopping trip → this morning's packing" span).
 *   anything else / '' — no cohort restriction (returns TRUE).
 *
 * @param {string} cohort   one of 'today' | 'yesterday' | 'recent'
 * @param {string} alias    the `receipts` table alias used by the caller (e.g. 'r')
 * @param {number} [nowMs]  injectable clock for tests (default Date.now())
 */
function purchasedCohortSql(cohort, alias = 'r', nowMs = Date.now()) {
	const a = alias
	const col = `${a}.purchase_completed_at`
	const startToday = startOfLocalDaySec(nowMs)
	const DAY = 24 * 3600
	switch (String(cohort || '')) {
		case 'today':
			return `(${col} IS NOT NULL AND ${col} >= ${startToday})`
		case 'yesterday':
			return `(${col} IS NOT NULL AND ${col} >= ${startToday - DAY} AND ${col} < ${startToday})`
		case 'recent':
			return `(${col} IS NOT NULL AND ${col} >= ${startToday - DAY})`
		default:
			return '1 = 1'
	}
}

/**
 * Whether the packing queue must require VERIFICATION (packer physically confirmed
 * the item in hand), not merely the shopper's "Purchased" assertion, before an
 * order is packable. Off by default so existing shops see no behavior change; turn
 * on with config.require_verify_before_pack = true to enforce the two-person gate.
 *
 * @param {object} config - dashboard config.
 * @returns {boolean}
 */
function requireVerifyBeforePack(config = {}) {
	return config.require_verify_before_pack === true
}

module.exports = {
	readyToPackShipStateSql,
	openExchangeExistsSql,
	excludeOpenExchangeSql,
	openExchangeHoldCount,
	purchasedCohortSql,
	requireVerifyBeforePack,
	startOfLocalDaySec,
}
