'use strict'

/**
 * calendar-counts.js — day-by-day order-placement rollup for the Orders date picker.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------------------------------------------------------------
 * The native `<input type="date">` calendar cannot show extra data. The Orders
 * tab date filter answers "what came in when" (`receipts.etsy_created_at`), so
 * the replacement picker needs a COUNT of orders placed on each local calendar
 * day — the same clock the existing `date_from` / `date_to` filter uses.
 *
 * Bucketing is done in JS against local midnight (same helper as pack-queue's
 * packaged-day chips) rather than SQLite's `localtime`, so a cell, the filter,
 * and this rollup can never disagree about which day a stamp belongs to.
 *
 * Counts are placement-day totals of *actionable* orders (the same predicate as
 * GET /api/orders), optionally scoped to one shop. They deliberately ignore the
 * current date range and fulfilment-status tab: the picker is how you CHOOSE
 * that range, and "orders placed that day" is what the Date control means.
 *
 * The calendar grid is at most six weeks. Callers must pass an inclusive
 * `from`/`to` window; anything wider is rejected so this cannot become a
 * full-table scan.
 *
 * Shared with scripts/test-orders-calendar.js so the test and the server cannot
 * drift.
 */

const { actionableOrderSql } = require('./dedup')
const { localDayKeyFromSec } = require('./pack-queue')

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/
/** Six-week grid is 42 days; a few extra covers week-start differences. */
const MAX_RANGE_DAYS = 45

/**
 * Parse a real local calendar day. Rejects both malformed strings and JS date
 * overflow ("2026-02-31" → March 3).
 *
 * @param {unknown} value
 * @returns {{ iso: string, year: number, month: number, day: number, startSec: number } | null}
 */
function parseIsoDay(value) {
	const m = ISO_DAY.exec(String(value || '').trim())
	if (!m) return null
	const year = Number(m[1])
	const month = Number(m[2])
	const day = Number(m[3])
	const local = new Date(year, month - 1, day, 0, 0, 0, 0)
	if (local.getFullYear() !== year || local.getMonth() !== month - 1 || local.getDate() !== day) return null
	return {
		iso: `${m[1]}-${m[2]}-${m[3]}`,
		year,
		month,
		day,
		startSec: Math.floor(local.getTime() / 1000),
	}
}

/**
 * Inclusive count of calendar days between two parsed days. Uses UTC on the
 * Y-M-D parts so a DST transition cannot change the span.
 *
 * @param {{ year: number, month: number, day: number }} from
 * @param {{ year: number, month: number, day: number }} to
 * @returns {number}
 */
function inclusiveDayCount(from, to) {
	const a = Date.UTC(from.year, from.month - 1, from.day)
	const b = Date.UTC(to.year, to.month - 1, to.day)
	return Math.floor((b - a) / 86400000) + 1
}

/**
 * The local midnight immediately after `parsed`'s calendar day. The exclusive
 * end of a `[startSec, nextStartSec)` query window — DST-safe because it is a
 * real local Date, not start+86400.
 *
 * @param {{ year: number, month: number, day: number }} parsed
 * @returns {number} unix seconds
 */
function nextLocalMidnightSec(parsed) {
	const next = new Date(parsed.year, parsed.month - 1, parsed.day + 1, 0, 0, 0, 0)
	return Math.floor(next.getTime() / 1000)
}

function rangeError(message) {
	const err = new Error(message)
	err.code = 'BAD_RANGE'
	return err
}

/**
 * Day-by-day counts of orders placed inside `[from, to]` (inclusive, local).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object}  [opts]
 * @param {string}  [opts.from]              YYYY-MM-DD (required)
 * @param {string}  [opts.to]                YYYY-MM-DD (required)
 * @param {string}  [opts.shopId]            optional shop filter
 * @param {Iterable<number>|Set<number>} [opts.suppressedIds] ghost receipt ids to hide
 * @returns {{ from: string, to: string, counts: Record<string, number>, total: number }}
 */
function listOrderDayCounts(db, opts = {}) {
	const from = parseIsoDay(opts.from)
	const to = parseIsoDay(opts.to)
	if (!from || !to) throw rangeError('from and to must be real YYYY-MM-DD dates')
	if (from.startSec > to.startSec) throw rangeError('from must be on or before to')
	const span = inclusiveDayCount(from, to)
	if (span > MAX_RANGE_DAYS) throw rangeError(`date range cannot exceed ${MAX_RANGE_DAYS} days`)

	const params = {
		from_sec: from.startSec,
		to_sec: nextLocalMidnightSec(to),
	}
	let shopClause = ''
	const shopId = String(opts.shopId || '').trim()
	if (shopId) {
		shopClause = 'AND r.shop_id = @shop_id'
		params.shop_id = shopId
	}

	let notIn = ''
	const suppressed = opts.suppressedIds
	if (suppressed && typeof suppressed[Symbol.iterator] === 'function') {
		const idList = [...suppressed].map(Number).filter(Number.isInteger).join(',')
		if (idList) notIn = `AND r.receipt_id NOT IN (${idList})`
	}

	let rows
	try {
		rows = db
			.prepare(
				`SELECT r.etsy_created_at AS ts
				   FROM receipts r
				  WHERE r.etsy_created_at IS NOT NULL
				    AND r.etsy_created_at >= @from_sec
				    AND r.etsy_created_at < @to_sec
				    AND ${actionableOrderSql('r')}
				    ${shopClause}
				    ${notIn}`,
			)
			.all(params)
	} catch {
		return { from: from.iso, to: to.iso, counts: {}, total: 0 }
	}

	const counts = Object.create(null)
	let total = 0
	for (const row of rows) {
		const key = localDayKeyFromSec(row.ts)
		if (key < from.iso || key > to.iso) continue
		counts[key] = (counts[key] || 0) + 1
		total += 1
	}
	return { from: from.iso, to: to.iso, counts, total }
}

module.exports = {
	MAX_RANGE_DAYS,
	parseIsoDay,
	inclusiveDayCount,
	nextLocalMidnightSec,
	listOrderDayCounts,
}
