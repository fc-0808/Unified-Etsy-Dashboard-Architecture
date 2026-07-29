'use strict'

/**
 * Regression test — a manual order shipped via 4PX (but NOT yet packaged) must
 * STAY in the "📦 To pack & ship" queue.
 *
 * The bug this guards: the integrated "Ship with 4PX" flow creates a label +
 * tracking number and then flips the manual order's local shipped flag via
 * setManualOrderShipped(). That function used to set is_shipped=1 WITHOUT
 * stamping shipment_notified_at. Because shipping is DECOUPLED from packaging,
 * such an order must remain packable until the operator marks it packaged — but
 * the Ready-to-pack scope only keeps a shipped order when it looks PRE-TRANSIT
 * (is_shipped=1 AND tracking_code IS NOT NULL AND shipment_notified_at IS NOT
 * NULL AND carrier_confirmed_at IS NULL). With a NULL shipment_notified_at the
 * order failed that branch, was misclassified as In-transit, and silently
 * vanished from the pack queue even though it had never been packaged.
 *
 * setManualOrderShipped now mirrors shipEtsyReceipt / setManualOrderTracking and
 * stamps shipment_notified_at on ship (clearing it on un-ship). This test drives
 * the REAL DB helper against the REAL schema and asserts the order behaves like a
 * genuine Pre-transit parcel — using the SHARED pack-queue predicates (single
 * source of truth) so it can never drift from production.
 *
 * Run: `node scripts/test-manual-ship-pack-queue.js`  (or `npm run test:manual-ship-pack-queue`)
 * Exit code 0 = all assertions pass, 1 = a regression was detected.
 */

const os = require('os')
const path = require('path')
const fs = require('fs')
const { initDb, setManualOrderShipped } = require('../src/db/setup')
const packQueue = require('../src/orders/pack-queue')

let failures = 0
function assert(cond, msg) {
	if (cond) {
		console.log(`  ok  — ${msg}`)
	} else {
		failures++
		console.error(`  FAIL — ${msg}`)
	}
}

const CONFIG = { pre_transit_days: 30 }
const NOW = Math.floor(Date.now() / 1000)

// A single componentless line so classifyPurchaseState treats the seeded order
// as fully purchased ("ready") — isolating the ship-state behavior under test.
const TX = JSON.stringify([{ title: 'Plain Sticker Pack', listing_id: 555, quantity: 1, variations: [] }])

/** Reproduce the exact Ready-to-pack scope from the SHARED predicates + the
 *  handler's forced `packaged_at IS NULL` half (see src/server/index.js). */
function readyToPackIds(db) {
	const sql = `SELECT r.receipt_id FROM receipts r
     WHERE ${packQueue.readyToPackShipStateSql(CONFIG, 'r')}
       AND ${packQueue.excludeOpenExchangeSql('r')}
       AND r.packaged_at IS NULL
     ORDER BY r.receipt_id`
	return db.prepare(sql).all().map((x) => x.receipt_id)
}

function seed(db) {
	db.prepare('INSERT INTO groups (group_id, label) VALUES (?,?)').run('G1', 'Group 1')
	db.prepare('INSERT INTO shops (shop_id, group_id, shop_name) VALUES (?,?,?)').run('SHOP_A', 'G1', 'TestShop')

	// A manual order that has just had a 4PX label + tracking created (mirrors
	// create4pxShipmentForReceipt: tracking_code set, is_shipped still 0,
	// shipment_notified_at still NULL) and is NOT yet packaged.
	db.prepare(`
    INSERT INTO receipts
      (receipt_id, shop_id, group_id, name, status, is_paid, is_shipped,
       tracking_code, carrier_name, shipment_notified_at, carrier_confirmed_at,
       packaged_at, etsy_created_at, all_transactions, source)
    VALUES
      (@receipt_id, @shop_id, @group_id, @name, @status, @is_paid, @is_shipped,
       @tracking_code, @carrier_name, @shipment_notified_at, @carrier_confirmed_at,
       @packaged_at, @etsy_created_at, @all_transactions, @source)
  `).run({
		receipt_id: 2001, shop_id: 'SHOP_A', group_id: 'G1', name: 'Manual4pxShip', status: 'Paid',
		is_paid: 1, is_shipped: 0, tracking_code: '4PXMANUAL01', carrier_name: '4PX',
		shipment_notified_at: null, carrier_confirmed_at: null, packaged_at: null,
		etsy_created_at: NOW - 3600, all_transactions: TX, source: 'manual',
	})
}

function row(db) {
	return db.prepare('SELECT is_shipped, shipment_notified_at, carrier_confirmed_at, status FROM receipts WHERE receipt_id = 2001').get()
}

const tmpPath = path.join(os.tmpdir(), `manual-ship-pack-queue-test-${process.pid}-${Date.now()}.db`)
const db = initDb(tmpPath)

console.log('Manual-order 4PX-ship pack-queue regression test\n')

try {
	seed(db)

	// ── Before shipping: a purchased, unpacked, needs-shipping manual order. ──
	assert(readyToPackIds(db).includes(2001), 'unshipped manual order is in the pack queue')

	// ── Mark it shipped (what the 4PX auto-complete step does). ───────────────
	const changed = setManualOrderShipped(db, 2001, true)
	assert(changed, 'setManualOrderShipped reported a change')

	const shipped = row(db)
	assert(shipped.is_shipped === 1, 'order is now flagged shipped')
	assert(shipped.status === 'Completed', "order status is 'Completed'")
	assert(shipped.shipment_notified_at != null, 'shipment_notified_at was stamped (Pre-transit) — the actual fix')
	assert(shipped.carrier_confirmed_at == null, 'carrier_confirmed_at is NULL (parcel not yet scanned)')

	// THE BUG: without the fix this order would vanish here. It must remain,
	// because it was shipped but never packaged.
	assert(
		readyToPackIds(db).includes(2001),
		'SHIPPED-BUT-NOT-PACKAGED manual order STAYS in the pack queue (Pre-transit)',
	)

	// ── Once packaged, it correctly leaves the pack queue. ────────────────────
	db.prepare('UPDATE receipts SET packaged_at = ? WHERE receipt_id = 2001').run(NOW)
	assert(!readyToPackIds(db).includes(2001), 'once packaged, the order leaves the pack queue')
	db.prepare('UPDATE receipts SET packaged_at = NULL WHERE receipt_id = 2001').run()

	// ── Un-shipping reverts cleanly to needs-shipping and clears the stamp. ───
	assert(setManualOrderShipped(db, 2001, false), 'un-ship reported a change')
	const unshipped = row(db)
	assert(unshipped.is_shipped === 0, 'order is back to not-shipped')
	assert(unshipped.status === 'Paid', "order status reverts to 'Paid'")
	assert(unshipped.shipment_notified_at == null, 'shipment_notified_at cleared on un-ship (fresh window on re-ship)')
	assert(readyToPackIds(db).includes(2001), 'un-shipped order is back in the pack queue (needs shipping)')
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
