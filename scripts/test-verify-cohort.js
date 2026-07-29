'use strict'

/**
 * Regression test — the purchase-completion COHORT filter and the packer
 * VERIFICATION plumbing (the "shopped yesterday → verify → pack" workflow).
 *
 * Guards two invariants that encode a packer's morning routine:
 *   1. purchasedCohortSql restricts a receipts scope to orders whose shopping was
 *      FINISHED (receipts.purchase_completed_at) in a local-day window — so the
 *      packer can pull up exactly "the orders I shopped yesterday" and a
 *      shopped-but-never-packed order can't hide in the backlog.
 *   2. Verification is a distinct, per-line signal (route_assignments.verified_at /
 *      receipt_item_purchase.verified_at) that setRouteVerified / clearRouteVerified
 *      stamp and clear, and requireVerifyBeforePack reads a config flag off by
 *      default (no behavior change) but enforces the two-person gate when on.
 *
 * The cohort/gate predicates live in src/orders/pack-queue.js and the verify writes
 * in src/db/setup.js, both imported here and by the server, so this test and
 * production can never drift. Runs against the REAL schema (initDb) so a column
 * rename is also caught.
 *
 * Run: `node scripts/test-verify-cohort.js`   (0 = pass, 1 = regression)
 */

const os = require('os')
const path = require('path')
const fs = require('fs')
const { initDb, setRouteVerified, setItemPurchaseVerified, clearRouteVerified } = require('../src/db/setup')
const packQueue = require('../src/orders/pack-queue')

let failures = 0
function assert(cond, msg) {
	if (cond) console.log(`  ok  — ${msg}`)
	else {
		failures++
		console.error(`  FAIL — ${msg}`)
	}
}

// Fixed, deterministic clock: 2026-07-19 12:00 local. Cohort boundaries are
// computed from this, so the test is stable regardless of when it runs.
const NOW_MS = new Date(2026, 6, 19, 12, 0, 0).getTime()
const startToday = packQueue.startOfLocalDaySec(NOW_MS)
const DAY = 24 * 3600

const tmpPath = path.join(os.tmpdir(), `verify-cohort-test-${process.pid}-${Date.now()}.db`)
const db = initDb(tmpPath)

console.log('Purchase-cohort + verification regression test\n')

try {
	db.prepare('INSERT INTO groups (group_id, label) VALUES (?,?)').run('G1', 'Group 1')
	db.prepare('INSERT INTO shops (shop_id, group_id, shop_name) VALUES (?,?,?)').run('SHOP_A', 'G1', 'TestShop')

	const ins = db.prepare(`
    INSERT INTO receipts (receipt_id, shop_id, group_id, name, status, is_paid, is_shipped, purchase_completed_at, all_transactions)
    VALUES (@receipt_id, 'SHOP_A', 'G1', @name, 'Paid', 1, 0, @pc, '[]')`)

	// Completion times across the cohort boundaries.
	ins.run({ receipt_id: 2001, name: 'today', pc: startToday + 3600 }) // completed today
	ins.run({ receipt_id: 2002, name: 'yesterday', pc: startToday - DAY + 3600 }) // yesterday
	ins.run({ receipt_id: 2003, name: 'threeDaysAgo', pc: startToday - 3 * DAY }) // old
	ins.run({ receipt_id: 2004, name: 'neverCompleted', pc: null }) // still outstanding

	const cohortIds = (cohort) =>
		db
			.prepare(`SELECT receipt_id FROM receipts r WHERE ${packQueue.purchasedCohortSql(cohort, 'r', NOW_MS)} ORDER BY receipt_id`)
			.all()
			.map((x) => x.receipt_id)

	// ── Cohort windows ────────────────────────────────────────────────────────
	assert(JSON.stringify(cohortIds('today')) === JSON.stringify([2001]), `'today' → only today's completion (got ${cohortIds('today')})`)
	assert(JSON.stringify(cohortIds('yesterday')) === JSON.stringify([2002]), `'yesterday' → only yesterday's completion (got ${cohortIds('yesterday')})`)
	assert(JSON.stringify(cohortIds('recent')) === JSON.stringify([2001, 2002]), `'recent' → yesterday + today (got ${cohortIds('recent')})`)
	assert(JSON.stringify(cohortIds('')) === JSON.stringify([2001, 2002, 2003, 2004]), `no cohort → unrestricted (got ${cohortIds('')})`)
	assert(!cohortIds('recent').includes(2004), `an order with NULL completion is never in a cohort`)

	// ── Verify gate config flag ─────────────────────────────────────────────────
	assert(packQueue.requireVerifyBeforePack({}) === false, `verify gate OFF by default (no behavior change)`)
	assert(packQueue.requireVerifyBeforePack({ require_verify_before_pack: true }) === true, `verify gate ON when configured`)

	// ── Verification round-trip (component line) ────────────────────────────────
	db.prepare("INSERT INTO route_assignments (receipt_id, item_key, title, status_case) VALUES (2001, 'k1', 'Case', 'Purchased')").run()
	setRouteVerified(db, { receipt_id: 2001, item_key: 'k1', verified: true, by: 'hope' })
	let ra = db.prepare('SELECT verified_at, verified_by FROM route_assignments WHERE receipt_id = 2001 AND item_key = ?').get('k1')
	assert(!!ra.verified_at && ra.verified_by === 'hope', `setRouteVerified stamps verified_at + who (${ra.verified_by})`)
	clearRouteVerified(db, 2001, 'k1')
	ra = db.prepare('SELECT verified_at, verified_by FROM route_assignments WHERE receipt_id = 2001 AND item_key = ?').get('k1')
	assert(!ra.verified_at && !ra.verified_by, `clearRouteVerified wipes the stamp when stock regresses`)

	// ── Verification round-trip (no-component line) ─────────────────────────────
	db.prepare("INSERT INTO receipt_item_purchase (receipt_id, item_key, title, needs_purchase) VALUES (2002, 'k2', 'Sticker', 0)").run()
	const changed = setItemPurchaseVerified(db, { receipt_id: 2002, item_key: 'k2', verified: true, by: 'hope' })
	const rip = db.prepare('SELECT verified_at, verified_by FROM receipt_item_purchase WHERE receipt_id = 2002 AND item_key = ?').get('k2')
	assert(changed === 1 && !!rip.verified_at && rip.verified_by === 'hope', `setItemPurchaseVerified stamps a no-component line`)

	// ── Upsert: a no-component line with NO prior row can still be verified ──────
	// (regression: previously an UPDATE-only write left such a line unverifiable,
	// which would strand the whole order under require_verify_before_pack.)
	const created = setItemPurchaseVerified(db, { receipt_id: 2003, item_key: 'k3', title: 'Plain Sticker', verified: true, by: 'hope' })
	const ripNew = db.prepare('SELECT needs_purchase, verified_at, verified_by FROM receipt_item_purchase WHERE receipt_id = 2003 AND item_key = ?').get('k3')
	assert(created === 1 && ripNew && !!ripNew.verified_at, `verifying a never-flagged no-component line CREATES its row`)
	assert(ripNew && ripNew.needs_purchase === 0, `the created row is in-hand (needs_purchase = 0), not a buy flag`)

	// ── Upsert preserves an existing needs_purchase flag (only stamps verify) ────
	db.prepare("INSERT INTO receipt_item_purchase (receipt_id, item_key, title, needs_purchase) VALUES (2004, 'k4', 'Still To Buy', 1)").run()
	setItemPurchaseVerified(db, { receipt_id: 2004, item_key: 'k4', verified: true, by: 'hope' })
	const ripKeep = db.prepare('SELECT needs_purchase, verified_at FROM receipt_item_purchase WHERE receipt_id = 2004 AND item_key = ?').get('k4')
	assert(ripKeep.needs_purchase === 1 && !!ripKeep.verified_at, `verifying never clobbers an existing needs_purchase flag`)
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
