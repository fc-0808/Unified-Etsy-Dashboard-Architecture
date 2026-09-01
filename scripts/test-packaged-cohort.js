'use strict'

/**
 * Regression test — packaging-day COHORT filter and day-count rollup for the
 * "Recently packaged" day chips.
 *
 * Guards the invariants that let a packer pull up exactly "what I sealed today /
 * yesterday / on Tuesday" instead of the whole rolling review window:
 *   1. packagedCohortSql restricts receipts.packaged_at to a local-day window
 *      (today | yesterday | YYYY-MM-DD | all).
 *   2. listPackagedDayCounts buckets stamps by the SAME local midnight the
 *      cohort uses, so a chip and the list it opens can never disagree about
 *      which day a seal belongs to.
 *
 * The helpers live in src/orders/pack-queue.js and are imported here and by the
 * server, so this test and production can never drift. Runs against the REAL
 * schema (initDb) so a column rename is also caught.
 *
 * Run: `node scripts/test-packaged-cohort.js`   (0 = pass, 1 = regression)
 */

const os = require('os')
const path = require('path')
const fs = require('fs')
const { initDb } = require('../src/db/setup')
const packQueue = require('../src/orders/pack-queue')

let failures = 0
function assert(cond, msg) {
	if (cond) console.log(`  ok  — ${msg}`)
	else {
		failures++
		console.error(`  FAIL — ${msg}`)
	}
}

// Fixed clock: 2026-08-11 15:30 local. Cohort boundaries are computed from this.
const NOW_MS = new Date(2026, 7, 11, 15, 30, 0).getTime()
const startToday = packQueue.startOfLocalDaySec(NOW_MS)
const DAY = 24 * 3600

const tmpPath = path.join(os.tmpdir(), `packaged-cohort-test-${process.pid}-${Date.now()}.db`)
const db = initDb(tmpPath)

console.log('Packaged-day cohort regression test\n')

try {
	db.prepare('INSERT INTO groups (group_id, label) VALUES (?,?)').run('g1', 'Group 1')
	db.prepare('INSERT INTO shops (shop_id, group_id, shop_name) VALUES (?,?,?)').run('s1', 'g1', 'Shop One')
	db.prepare('INSERT INTO shops (shop_id, group_id, shop_name) VALUES (?,?,?)').run('s2', 'g1', 'Shop Two')

	const seed = db.prepare(`
		INSERT INTO receipts (
			receipt_id, shop_id, group_id, name, status, is_paid, is_shipped,
			etsy_created_at, packaged_at, all_transactions
		) VALUES (@receipt_id, @shop_id, 'g1', @name, @status, 1, 0, @created, @packaged, '[]')
	`)
	const rows = [
		{ receipt_id: 1, shop_id: 's1', name: 'today-a', status: 'Paid', created: startToday - 10 * DAY, packaged: startToday + 3600 },
		{ receipt_id: 2, shop_id: 's1', name: 'today-b', status: 'Paid', created: startToday - 10 * DAY, packaged: startToday + 7200 },
		{ receipt_id: 3, shop_id: 's1', name: 'yest', status: 'Paid', created: startToday - 10 * DAY, packaged: startToday - 3600 },
		{ receipt_id: 4, shop_id: 's1', name: 'older', status: 'Paid', created: startToday - 10 * DAY, packaged: startToday - DAY - 3600 },
		{ receipt_id: 5, shop_id: 's1', name: 'canc', status: 'Cancelled', created: startToday - 10 * DAY, packaged: startToday + 1800 },
		{ receipt_id: 6, shop_id: 's2', name: 'today-other', status: 'Paid', created: startToday - 10 * DAY, packaged: startToday + 900 },
	]
	for (const r of rows) seed.run(r)

	// ── packagedCohortSql ────────────────────────────────────────────────────
	const todaySql = packQueue.packagedCohortSql('today', 'r', NOW_MS)
	assert(todaySql.includes(`${startToday}`), 'today cohort starts at local midnight')
	assert(todaySql.includes(`${startToday + DAY}`), 'today cohort ends at next midnight')

	const ySql = packQueue.packagedCohortSql('yesterday', 'r', NOW_MS)
	assert(ySql.includes(`${startToday - DAY}`), 'yesterday cohort starts at previous midnight')
	assert(ySql.includes(`${startToday}`), 'yesterday cohort ends at today midnight')

	const iso = packQueue.localDayKeyFromSec(startToday - 2 * DAY)
	const dSql = packQueue.packagedCohortSql(iso, 'r', NOW_MS)
	assert(dSql.includes(`${startToday - 2 * DAY}`), `YYYY-MM-DD cohort (${iso}) starts at that local midnight`)
	assert(packQueue.packagedCohortSql('all', 'r', NOW_MS) === '1 = 1', 'all / empty is unrestricted')
	assert(packQueue.packagedCohortSql('', 'r', NOW_MS) === '1 = 1', 'blank cohort is unrestricted')
	assert(packQueue.packagedCohortSql('not-a-day', 'r', NOW_MS) === '1 = 1', 'garbage cohort is unrestricted (never matches nothing)')

	const countWith = (cohort) =>
		db.prepare(`SELECT COUNT(*) AS n FROM receipts r WHERE r.status NOT IN ('Canceled','Cancelled','Fully Refunded','Fully refunded') AND ${packQueue.packagedCohortSql(cohort, 'r', NOW_MS)}`).get().n

	assert(countWith('today') === 3, `today finds 3 seals (got ${countWith('today')})`) // 1,2,6 — cancelled excluded by status in query
	assert(countWith('yesterday') === 1, `yesterday finds 1 seal (got ${countWith('yesterday')})`)
	assert(countWith(iso) === 1, `ISO day finds the 2-days-ago seal (got ${countWith(iso)})`)

	// ── listPackagedDayCounts ────────────────────────────────────────────────
	const days = packQueue.listPackagedDayCounts(db, { windowDays: 7, nowMs: NOW_MS })
	assert(Array.isArray(days) && days.length >= 3, `day list has at least 3 buckets (got ${days.length})`)
	assert(days[0].date >= days[days.length - 1].date, 'days are newest-first')
	const todayKey = packQueue.localDayKeyFromSec(startToday)
	const todayBucket = days.find((d) => d.date === todayKey)
	assert(todayBucket && todayBucket.count === 3, `today chip counts 3 (cancelled omitted); got ${todayBucket && todayBucket.count}`)
	assert(!days.some((d) => d.count === 0), 'empty days are omitted from the strip')

	// Shop-scoped extraWhere — day chips respect the same shop filter as the list.
	const shopDays = packQueue.listPackagedDayCounts(db, {
		windowDays: 7,
		nowMs: NOW_MS,
		extraWhere: 'r.shop_id = @shop_id',
		params: { shop_id: 's1' },
	})
	const shopToday = shopDays.find((d) => d.date === todayKey)
	assert(shopToday && shopToday.count === 2, `shop-scoped today chip drops the other shop (got ${shopToday && shopToday.count})`)

	// Window edge: a seal older than the rolling window does not appear.
	const short = packQueue.listPackagedDayCounts(db, { windowDays: 1, nowMs: NOW_MS })
	assert(!short.some((d) => d.date === iso), 'a seal outside the rolling window never gets a chip')

	// Full history: windowDays <= 0 returns every day, not just the last week.
	const full = packQueue.listPackagedDayCounts(db, { windowDays: 0, nowMs: NOW_MS })
	assert(full.some((d) => d.date === iso), 'unlimited window includes older seals')
	assert(full.length >= days.length, 'unlimited window is at least as wide as a bounded window')
} finally {
	db.close()
	for (const suffix of ['', '-wal', '-shm']) {
		try {
			fs.unlinkSync(tmpPath + suffix)
		} catch {
			/* ignore */
		}
	}
}

console.log('')
if (failures > 0) {
	console.error(`${failures} assertion(s) FAILED`)
	process.exit(1)
}
console.log('All assertions passed.')
