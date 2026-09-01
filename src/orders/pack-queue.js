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
 *   2. It owes NO wrong-model supplier SWAP (see order_exchanges).    ← this file
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
 * OPEN wrong-model SWAP: the item is physically in hand but in the WRONG phone
 * model and must be exchanged at the supplier before the parcel can ship.
 *
 * Scoped to SWAPs (`have_model` present) on purpose. The other shape of a model
 * fix — BUY, where we hold nothing and must purchase the corrected model — is
 * already gated by ordinary component statuses: its case sits at Pending until
 * bought, so classifyPurchaseState keeps the order out of the queue on its own.
 * Blocking on BUY records here as well would deadlock the order: the case can be
 * bought and marked Purchased, yet the parcel stays unpackable until someone
 * remembers to tick a second, redundant "mark bought" control.
 */
function openExchangeExistsSql(alias = 'r') {
	return `EXISTS (
      SELECT 1 FROM order_exchanges oe
      WHERE oe.receipt_id = ${alias}.receipt_id
        AND oe.status = 'open'
        AND TRIM(COALESCE(oe.have_model, '')) <> ''
    )`
}

/**
 * SQL fragment — the exchange-hold half of the Ready-to-pack scope: exclude any
 * order still owing a supplier swap.
 *
 * WHY THIS GUARD IS LOAD-BEARING (not cosmetic): a line awaiting a swap keeps
 * its components marked "Purchased" by design (so it is never re-bought), which
 * means classifyPurchaseState correctly counts the order as fully purchased. With
 * NOTHING else stopping it, that order would surface in the packing queue and a
 * packer could seal + ship the WRONG model — the exact failure the order_exchanges
 * table exists to prevent (see src/db/setup.js). The order re-enters the queue the
 * moment the swap is marked done (which flips the swapped pieces back to
 * Purchased); meanwhile it stays visible in the "To exchange" bucket, never lost.
 */
function excludeOpenExchangeSql(alias = 'r') {
	return `NOT ${openExchangeExistsSql(alias)}`
}

/**
 * How many orders are currently HELD OUT of the packing queue purely because they
 * owe a wrong-model swap: they are in the Ready-to-pack ship-state, not yet
 * packaged, and owe a swap. Used by tests and diagnostics; the packing UI no
 * longer surfaces this count. Defensive: returns 0 if the table is missing
 * (fresh DB).
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
 * SQL fragment — restrict a receipts scope to a packaging COHORT, i.e. orders
 * whose parcel was physically marked packaged (receipts.packaged_at) in a given
 * local-day window. Powers the "Recently packaged" day chips so a packer can
 * pull up exactly "what I sealed today / on Tuesday" instead of the whole
 * rolling review window.
 *
 *   'today'       — packaged since local midnight today.
 *   'yesterday'   — packaged during the whole of the previous local day.
 *   'YYYY-MM-DD'  — packaged during that local calendar day.
 *   anything else / '' / 'all' — no cohort restriction (returns TRUE).
 *
 * @param {string} cohort
 * @param {string} alias    the `receipts` table alias used by the caller (e.g. 'r')
 * @param {number} [nowMs]  injectable clock for tests (default Date.now())
 */
function packagedCohortSql(cohort, alias = 'r', nowMs = Date.now()) {
	const a = alias
	const col = `${a}.packaged_at`
	const raw = String(cohort || '').trim()
	if (!raw || raw === 'all') return '1 = 1'

	const DAY = 24 * 3600
	let start
	let end
	if (raw === 'today') {
		start = startOfLocalDaySec(nowMs)
		end = start + DAY
	} else if (raw === 'yesterday') {
		end = startOfLocalDaySec(nowMs)
		start = end - DAY
	} else if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
		const [y, m, d] = raw.split('-').map(Number)
		const local = new Date(y, m - 1, d, 0, 0, 0, 0)
		if (isNaN(local.getTime())) return '1 = 1'
		start = Math.floor(local.getTime() / 1000)
		end = start + DAY
	} else {
		return '1 = 1'
	}
	return `(${col} IS NOT NULL AND ${col} >= ${start} AND ${col} < ${end})`
}

/**
 * Local-calendar-day bucket key (YYYY-MM-DD) for a unix-seconds timestamp.
 * @param {number} epochSec
 * @returns {string}
 */
function localDayKeyFromSec(epochSec) {
	const d = new Date(Number(epochSec) * 1000)
	const y = d.getFullYear()
	const m = String(d.getMonth() + 1).padStart(2, '0')
	const day = String(d.getDate()).padStart(2, '0')
	return `${y}-${m}-${day}`
}

/**
 * Day-by-day counts of parcels sealed inside the recently-packaged scope.
 * Used to render the day chips above that queue. Days with zero packs are omitted
 * so the strip stays short; callers add an "All" chip themselves.
 *
 * Bucketing is done in JS against local midnight (same clock as packagedCohortSql)
 * rather than SQLite's `localtime`, so the chips and the filter can never
 * disagree about which day a stamp belongs to.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object}  [opts]
 * @param {number}  [opts.windowDays=7]  rolling look-back in days; 0 or negative = full history
 * @param {number}  [opts.nowMs]
 * @param {string}  [opts.extraWhere='1=1']  additional SQL AND'd in (alias `r`)
 * @param {object}  [opts.params={}]          bind params for extraWhere
 * @returns {{ date: string, count: number }[]} newest day first
 */
function listPackagedDayCounts(db, opts = {}) {
	const windowDays = Number(opts.windowDays)
	const unlimited = !Number.isFinite(windowDays) || windowDays <= 0
	const boundedDays = unlimited ? 0 : Math.max(1, Math.floor(windowDays))
	const nowMs = opts.nowMs != null ? opts.nowMs : Date.now()
	const cutoff = unlimited ? 0 : Math.floor(nowMs / 1000) - boundedDays * 24 * 3600
	const extraWhere = opts.extraWhere || '1=1'
	const params = opts.params || {}
	const cutoffClause = unlimited ? '' : 'AND r.packaged_at >= @cutoff'
	let rows
	try {
		rows = db
			.prepare(
				`SELECT r.packaged_at AS packaged_at
				   FROM receipts r
				  WHERE r.packaged_at IS NOT NULL
				    ${cutoffClause}
				    AND r.status NOT IN ('Canceled', 'Cancelled', 'Fully Refunded', 'Fully refunded')
				    AND (${extraWhere})`,
			)
			.all(unlimited ? params : { ...params, cutoff })
	} catch {
		return []
	}
	const counts = new Map()
	for (const row of rows) {
		const key = localDayKeyFromSec(row.packaged_at)
		counts.set(key, (counts.get(key) || 0) + 1)
	}
	return [...counts.entries()]
		.sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
		.map(([date, count]) => ({ date, count }))
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
	packagedCohortSql,
	listPackagedDayCounts,
	localDayKeyFromSec,
	requireVerifyBeforePack,
	startOfLocalDaySec,
}
