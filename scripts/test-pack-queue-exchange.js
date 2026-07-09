'use strict'

/**
 * Regression test — wrong-model exchanges must be HELD OUT of the packing queue.
 *
 * Guards the invariant introduced when we stopped letting orders that still owe a
 * supplier swap leak into "📦 To pack & ship". Such an order is physically in hand
 * but in the WRONG phone model; its components stay marked "Purchased" (so it is
 * never re-bought), which means it would otherwise look perfectly packable — and a
 * packer could seal + ship the wrong model. The Ready-to-pack scope therefore
 * excludes any order with an OPEN order_exchanges row, and re-admits it the moment
 * the exchange is marked done.
 *
 * The scope predicates live in src/orders/pack-queue.js and are imported here (and
 * by the server), so this test and production can never drift. The test runs the
 * predicates against the REAL database schema (built by db/setup.initDb) so a
 * column rename or schema change is also caught.
 *
 * Run: `node scripts/test-pack-queue-exchange.js`  (or `npm run test:pack-queue-exchange`)
 * Exit code 0 = all assertions pass, 1 = a regression was detected.
 */

const os = require('os')
const path = require('path')
const fs = require('fs')
const { initDb } = require('../src/db/setup')
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
const DAY = 24 * 3600

// A single, componentless line so classifyPurchaseState would treat every seeded
// order as fully purchased ("ready") by default — this makes the module-composed
// query below equivalent to the real /api/orders?shipped=ready_to_pack scope for
// these fixtures, isolating the behavior under test (the exchange hold) cleanly.
const TX = JSON.stringify([{ title: 'Plain Sticker Pack', listing_id: 555, quantity: 1, variations: [] }])

/** Reproduce the Ready-to-pack scope from the SHARED predicates (single source of truth). */
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

	const ins = db.prepare(`
    INSERT INTO receipts
      (receipt_id, shop_id, group_id, name, status, is_paid, is_shipped,
       tracking_code, shipment_notified_at, carrier_confirmed_at, packaged_at,
       etsy_created_at, all_transactions, source)
    VALUES
      (@receipt_id, @shop_id, @group_id, @name, @status, @is_paid, @is_shipped,
       @tracking_code, @shipment_notified_at, @carrier_confirmed_at, @packaged_at,
       @etsy_created_at, @all_transactions, @source)
  `)
	const base = {
		shop_id: 'SHOP_A', group_id: 'G1', is_paid: 1, is_shipped: 0,
		tracking_code: null, shipment_notified_at: null, carrier_confirmed_at: null,
		packaged_at: null, etsy_created_at: NOW - 3600, all_transactions: TX, source: null,
	}

	// R1 — plain packable order (needs shipping, purchased, not packed, no swap).
	ins.run({ ...base, receipt_id: 1001, name: 'Control', status: 'Paid' })
	// R2 — needs-shipping order that OWES a wrong-model swap.
	ins.run({ ...base, receipt_id: 1002, name: 'ExchangeHold', status: 'Paid' })
	// R3 — already physically packaged → not in the "to pack" queue.
	ins.run({ ...base, receipt_id: 1003, name: 'Packaged', status: 'Paid', packaged_at: NOW - 60 })
	// R4 — cancelled → never packable.
	ins.run({ ...base, receipt_id: 1004, name: 'Cancelled', status: 'Canceled' })
	// R5 — PRE-TRANSIT (label made early) that ALSO owes a swap. Pre-transit is a
	//      packable ship-state, so this proves the exchange hold applies there too.
	ins.run({
		...base, receipt_id: 1005, name: 'PreTransitExchange', status: 'Paid',
		is_shipped: 1, tracking_code: '4PXTESTPT', shipment_notified_at: NOW - DAY, carrier_confirmed_at: null,
	})

	const insEx = db.prepare(`
    INSERT INTO order_exchanges (receipt_id, item_key, title, have_model, need_model, components, status)
    VALUES (?, ?, ?, ?, ?, ?, 'open')
  `)
	insEx.run(1002, 'plain sticker pack\x00555', 'Plain Sticker Pack', 'iPhone 17 Pro', 'iPhone 17 Pro Max', 'case')
	insEx.run(1005, 'plain sticker pack\x00555', 'Plain Sticker Pack', 'iPhone 17 Pro', 'iPhone 17 Pro Max', 'grip')
}

const tmpPath = path.join(os.tmpdir(), `pack-queue-test-${process.pid}-${Date.now()}.db`)
const db = initDb(tmpPath)

console.log('Pack-queue wrong-model exchange regression test\n')

try {
	seed(db)

	// ── While the exchanges are OPEN ──────────────────────────────────────────
	{
		const ids = readyToPackIds(db)
		assert(ids.includes(1001), `control order (1001) IS in the pack queue (got: ${ids.join(', ')})`)
		assert(!ids.includes(1002), `needs-shipping order owing a swap (1002) is HELD OUT of the pack queue`)
		assert(!ids.includes(1005), `pre-transit order owing a swap (1005) is HELD OUT of the pack queue`)
		assert(!ids.includes(1003), `already-packaged order (1003) is not in the pack queue`)
		assert(!ids.includes(1004), `cancelled order (1004) is not in the pack queue`)

		const held = packQueue.openExchangeHoldCount(db, CONFIG)
		assert(held === 2, `hold count reflects BOTH swap-held orders while open (got: ${held}, want 2)`)
	}

	// ── After BOTH exchanges are marked done ──────────────────────────────────
	// Mirrors POST /api/exchanges/:id/done, which flips status 'open' → 'done'
	// (and re-marks the swapped components Purchased — a no-op for these
	// componentless fixtures, which are already "ready").
	db.prepare("UPDATE order_exchanges SET status = 'done', done_at = ? WHERE receipt_id IN (1002, 1005)").run(NOW)

	{
		const ids = readyToPackIds(db)
		assert(ids.includes(1002), `order re-enters the pack queue once its swap is done (1002) (got: ${ids.join(', ')})`)
		assert(ids.includes(1005), `pre-transit order re-enters the pack queue once its swap is done (1005)`)

		const held = packQueue.openExchangeHoldCount(db, CONFIG)
		assert(held === 0, `hold count returns to zero after every swap is done (got: ${held})`)
	}
} finally {
	db.close()
	// Best-effort cleanup of the temp DB (+ WAL/SHM sidecars).
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
