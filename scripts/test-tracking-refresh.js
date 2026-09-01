'use strict'

/**
 * Regression tests for the independent 4PX tracking scheduler.
 *
 * Uses a temporary SQLite database and an injected tracking client — no network
 * calls, real credentials or production rows.
 *
 * Run: node scripts/test-tracking-refresh.js
 */

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { initDb, setManualOrderTracking, upsertReceipt, getShipments } = require('../src/db/setup')
const {
	getTrackingPollSettings,
	countTrackingCandidates,
	runTrackingCheckPass,
	startTrackingCycle,
	getTrackingCycleStatus,
} = require('../src/workers/sync')

let failures = 0
async function check(name, fn) {
	try {
		await fn()
		console.log(`  ✓ ${name}`)
	} catch (err) {
		failures++
		console.error(`  ✗ ${name}`)
		console.error(`    ${err.stack || err.message}`)
	}
}

function snapshot(status, extra = {}) {
	return {
		ok: true,
		status,
		firstScanAt: extra.firstScanAt ?? null,
		lastEventAt: extra.lastEventAt ?? Math.floor(Date.now() / 1000),
		lastEvent: extra.lastEvent ?? (status === 'delivered' ? 'Delivered' : 'Parcel information received'),
		lastLocation: extra.lastLocation ?? 'Test facility',
		deliveredAt: status === 'delivered' ? (extra.deliveredAt ?? Math.floor(Date.now() / 1000)) : null,
		health: extra.health ?? { severity: 'ok', reasons: [] },
		events: [],
		source: 'test',
	}
}

;(async () => {
	console.log('Tracking settings')
	await check('normalizes safe defaults and bounds', () => {
		const defaults = getTrackingPollSettings({})
		assert.strictEqual(defaults.enabled, true)
		assert.strictEqual(defaults.intervalMinutes, 15)
		assert.strictEqual(defaults.longTailRecheckHours, 168)
		assert.strictEqual(defaults.preRecheckHours, 2)
		assert.strictEqual(defaults.transitRecheckHours, 6)
		assert.strictEqual(defaults.maxPerCycle, 250)
		assert.strictEqual(defaults.errorRetryMinutes, 15)
		assert.strictEqual(defaults.errorRetryMaxMinutes, 120)

		const bounded = getTrackingPollSettings({
			fourpx_tracking_interval_minutes: 1,
			fourpx_tracking_request_delay_ms: 1,
			fourpx_tracking_max_per_cycle: 50000,
			fourpx_tracking_long_tail_recheck_hours: 1,
		})
		assert.strictEqual(bounded.intervalMinutes, 5)
		assert.strictEqual(bounded.requestDelayMs, 100)
		assert.strictEqual(bounded.maxPerCycle, 1000)
		assert.strictEqual(bounded.longTailRecheckHours, 24)
	})

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ued-track-cycle-'))
	const dbPath = path.join(tmpDir, 'test.db')
	const db = initDb(dbPath)
	const now = Math.floor(Date.now() / 1000)
	const config = {
		fourpx_tracking_sync: true,
		fourpx_tracking_interval_minutes: 15,
		fourpx_tracking_window_days: 120,
		fourpx_tracking_long_tail_recheck_hours: 168,
		fourpx_tracking_pre_recheck_hours: 2,
		fourpx_tracking_transit_recheck_hours: 6,
		fourpx_tracking_max_per_cycle: 20,
		fourpx_tracking_request_delay_ms: 100,
	}

	db.prepare('INSERT INTO groups (group_id, label) VALUES (?, ?)').run('g1', 'Group 1')
	db.prepare('INSERT INTO shops (shop_id, group_id, shop_name) VALUES (?, ?, ?)').run('s1', 'g1', 'Test shop')
	db.prepare(`
		INSERT INTO receipts (
			receipt_id, shop_id, group_id, name, etsy_created_at, etsy_updated_at,
			tracking_code, fourpx_tracking_no, fourpx_consignment_no,
			tracking_status, tracking_checked_at, carrier_confirmed_at,
			tracking_delivered_at, shipment_notified_at
		) VALUES
			(1, 's1', 'g1', 'Never checked', @now, @now,
			 '4PX-NEW', NULL, 'C1', 'pre_transit', NULL, NULL, NULL, @now),
			(2, 's1', 'g1', 'Fallback number', @now, @now,
			 NULL, '4PX-FALLBACK', 'C2', 'in_transit', @old, @old, NULL, @now),
			(3, 's1', 'g1', 'Fresh', @now, @now,
			 '4PX-FRESH', NULL, 'C3', 'in_transit', @fresh, @old, NULL, @now),
			(4, 's1', 'g1', 'Delivered', @now, @now,
			 '4PX-DONE', NULL, 'C4', 'delivered', @old, @old, @old, @now),
			(5, 's1', 'g1', 'Other carrier', @now, @now,
			 'USPS-OTHER', NULL, NULL, 'in_transit', @old, @old, NULL, @now),
			(6, 's1', 'g1', 'Cancelled 4PX', @now, @now,
			 '4PX-CANCELLED', NULL, 'C6', 'in_transit', @old, @old, NULL, @now),
			(7, 's1', 'g1', 'Archived 4PX', @now, @now,
			 '4PX-ARCHIVED', NULL, 'C7', 'in_transit', @old, @old, NULL, @now)
	`).run({
		now,
		old: now - 8 * 3600,
		fresh: now - 60 * 60,
	})
	db.prepare(`UPDATE receipts SET fourpx_order_status = 'cancelled' WHERE receipt_id = 6`).run()
	db.prepare(`UPDATE receipts SET archived_at = @now WHERE receipt_id = 7`).run({ now })

	console.log('Due queue + persistence')
	await check('selects never-checked and stale fallback tracking numbers only', () => {
		const settings = getTrackingPollSettings(config)
		assert.strictEqual(countTrackingCandidates(db, settings, now), 2)
	})

	await check('refresh pass persists phase transitions and returns telemetry', async () => {
		const seen = []
		const summary = await runTrackingCheckPass(db, config, {
			getSnapshot: async (trackingNo) => {
				seen.push(trackingNo)
				if (trackingNo === '4PX-FALLBACK') return snapshot('delivered')
				return snapshot('pre_transit')
			},
		})

		assert.deepStrictEqual(new Set(seen), new Set(['4PX-NEW', '4PX-FALLBACK']))
		assert.strictEqual(summary.candidateCount, 2)
		assert.strictEqual(summary.checkedCount, 2)
		assert.strictEqual(summary.updatedCount, 2)
		assert.strictEqual(summary.preTransit, 1)
		assert.strictEqual(summary.delivered, 1)
		assert.strictEqual(summary.backlogRemaining, 0)

		const delivered = db.prepare('SELECT tracking_status, tracking_delivered_at FROM receipts WHERE receipt_id = 2').get()
		assert.strictEqual(delivered.tracking_status, 'delivered')
		assert.ok(delivered.tracking_delivered_at)
		const fresh = db.prepare('SELECT tracking_checked_at FROM receipts WHERE receipt_id = 3').get()
		assert.strictEqual(fresh.tracking_checked_at, now - 3600)
	})

	await check('continues low-frequency checks for open parcels outside the hot window', async () => {
		db.prepare(`
			INSERT INTO receipts (
				receipt_id, shop_id, group_id, name, etsy_created_at, etsy_updated_at,
				tracking_code, fourpx_tracking_no, fourpx_consignment_no, tracking_status,
				tracking_last_event,
				tracking_checked_at, carrier_confirmed_at, tracking_delivered_at,
				shipment_notified_at
			) VALUES
				(10, 's1', 'g1', 'Long tail due', @oldShip, @oldShip,
				 '4PX-LONG-DUE', NULL, 'C10', 'in_transit',
				 'Shipment in transit',
				 @longStale, @oldShip, NULL, @oldShip),
				(11, 's1', 'g1', 'Long tail fresh', @oldShip, @oldShip,
				 '4PX-LONG-FRESH', NULL, 'C11', 'in_transit',
				 'Shipment in transit',
				 @longFresh, @oldShip, NULL, @oldShip),
				(12, 's1', 'g1', 'Corrupt snapshot', @now, @now,
				 '4PX-CORRUPT', NULL, 'C12', 'in_transit',
				 '????????????????',
				 @corruptStale, @oldShip, NULL, @now),
				(13, 's1', 'g1', 'Numeric 4PX identifier', @now, @now,
				 '1Z8E26Y00366094077', '1234567890123', 'C13', 'in_transit',
				 'Shipment picked up.',
				 @hotStale, @oldShip, NULL, @now)
		`).run({
			now,
			oldShip: now - 200 * 86400,
			longStale: now - 8 * 86400,
			longFresh: now - 2 * 86400,
			corruptStale: now - 3 * 3600,
			hotStale: now - 8 * 3600,
		})

		const settings = getTrackingPollSettings(config)
		assert.strictEqual(countTrackingCandidates(db, settings, now), 3)
		const telemetry = getTrackingCycleStatus(db, config)
		assert.strictEqual(telemetry.long_tail_open_count, 2)
		assert.strictEqual(telemetry.long_tail_recheck_hours, 168)

		const seen = []
		const summary = await runTrackingCheckPass(db, config, {
			getSnapshot: async (trackingNo) => {
				seen.push(trackingNo)
				return snapshot('delivered')
			},
		})
		assert.deepStrictEqual(new Set(seen), new Set(['4PX-LONG-DUE', '4PX-CORRUPT', '1234567890123']))
		assert.strictEqual(summary.delivered, 3)
		assert.strictEqual(countTrackingCandidates(db, settings, now), 0)
		const numeric = getShipments(db, { q: 'Numeric 4PX identifier', limit: 10 }).rows[0]
		assert.strictEqual(numeric.tracking_no, '1234567890123')
		assert.strictEqual(numeric.tracking_lookup_supported, 1)
	})

	console.log('Cycle lock + durable status')
	await check('prevents overlapping cycles and records the completed run', async () => {
		db.prepare(`
			UPDATE receipts SET
				tracking_status = 'pre_transit',
				tracking_checked_at = NULL,
				tracking_delivered_at = NULL,
				carrier_confirmed_at = NULL
			WHERE receipt_id = 1
		`).run()

		let unblock
		const gate = new Promise((resolve) => { unblock = resolve })
		const first = startTrackingCycle(db, config, {
			trigger: 'test',
			getSnapshot: async () => {
				await gate
				return snapshot('in_transit', { firstScanAt: now })
			},
		})
		assert.strictEqual(first.started, true)

		const overlapping = startTrackingCycle(db, config, {
			trigger: 'overlap',
			getSnapshot: async () => snapshot('in_transit'),
		})
		assert.strictEqual(overlapping.started, false)
		assert.strictEqual(overlapping.reason, 'running')

		const running = getTrackingCycleStatus(db, config)
		assert.strictEqual(running.running, true)
		assert.strictEqual(running.latest.status, 'running')

		unblock()
		const result = await first.promise
		assert.strictEqual(result.status, 'success')
		assert.strictEqual(result.checkedCount, 1)

		const done = getTrackingCycleStatus(db, config)
		assert.strictEqual(done.running, false)
		assert.strictEqual(done.latest.status, 'success')
		assert.strictEqual(done.latest.trigger, 'test')
		assert.strictEqual(done.latest.checked_count, 1)
		assert.strictEqual(done.due_count, 0)
	})

	await check('manual one-parcel cycle reports carrier failures without erasing status', async () => {
		const before = db.prepare('SELECT tracking_status FROM receipts WHERE receipt_id = 1').get()
		const launch = startTrackingCycle(db, config, {
			trigger: 'parcel_manual',
			ignoreDisabled: true,
			receiptIds: [1],
			includeResults: true,
			getSnapshot: async () => ({ ok: false, status: 'timeout', source: 'test' }),
		})
		assert.strictEqual(launch.started, true)
		const result = await launch.promise
		assert.strictEqual(result.status, 'partial')
		assert.strictEqual(result.results.length, 1)
		assert.strictEqual(result.results[0].ok, false)
		assert.strictEqual(result.results[0].status, 'timeout')
		const after = db.prepare(`
			SELECT tracking_status, tracking_checked_at, tracking_last_error,
			       tracking_error_count, tracking_next_check_at
			FROM receipts WHERE receipt_id = 1
		`).get()
		assert.strictEqual(after.tracking_status, before.tracking_status)
		assert.ok(after.tracking_checked_at)
		assert.strictEqual(after.tracking_error_count, 1)
		assert.ok(/timeout/i.test(after.tracking_last_error))
		assert.ok(after.tracking_next_check_at > after.tracking_checked_at)
		const settings = getTrackingPollSettings(config)
		assert.strictEqual(countTrackingCandidates(db, settings, after.tracking_checked_at), 0)
		assert.strictEqual(countTrackingCandidates(db, settings, after.tracking_next_check_at + 1), 1)
		assert.strictEqual(getTrackingCycleStatus(db, config).latest.status, 'partial')

		const recovery = startTrackingCycle(db, config, {
			trigger: 'parcel_manual',
			ignoreDisabled: true,
			receiptIds: [1],
			getSnapshot: async () => snapshot('in_transit', { firstScanAt: now }),
		})
		await recovery.promise
		const recovered = db.prepare(`
			SELECT tracking_last_error, tracking_error_count, tracking_next_check_at
			FROM receipts WHERE receipt_id = 1
		`).get()
		assert.strictEqual(recovered.tracking_last_error, null)
		assert.strictEqual(recovered.tracking_error_count, 0)
		assert.strictEqual(recovered.tracking_next_check_at, null)
	})

	await check('aborts before polling when the advisory-lock heartbeat is lost', async () => {
		db.prepare(`
			UPDATE receipts SET tracking_checked_at = NULL, tracking_next_check_at = NULL
			WHERE receipt_id IN (1, 3)
		`).run()
		let called = 0
		let heartbeats = 0
		await assert.rejects(
			() => runTrackingCheckPass(db, config, {
				heartbeat: () => ++heartbeats < 2,
				getSnapshot: async () => {
					called++
					return snapshot('in_transit')
				},
			}),
			(err) => err && err.code === 'TRACKING_LOCK_LOST',
		)
		assert.strictEqual(heartbeats, 2)
		assert.strictEqual(called, 1, 'the second parcel must not be polled after lock loss')
	})

	await check('Etsy sync tracking-number changes also clear stale snapshots', () => {
		db.prepare(`
			UPDATE receipts SET
				tracking_code = '4PX3333333333CN',
				tracking_status = 'delivered',
				tracking_last_event = 'Old delivery',
				tracking_delivered_at = @now,
				tracking_health = 'critical',
				tracking_is_disposed = 1,
				tracking_checked_at = @now,
				carrier_confirmed_at = @now,
				tracking_last_error = 'old error',
				tracking_error_count = 2,
				tracking_next_check_at = @now
			WHERE receipt_id = 3
		`).run({ now })
		upsertReceipt(db, 's1', 'g1', {
			receipt_id: 3,
			status: 'Completed',
			is_shipped: true,
			is_paid: true,
			create_timestamp: now,
			update_timestamp: now,
			transactions: [],
			shipments: [{
				tracking_code: '4PX4444444444CN',
				carrier_name: '4PX',
				shipment_notification_timestamp: now,
			}],
		})
		const row = db.prepare(`
			SELECT tracking_code, tracking_status, tracking_last_event,
			       tracking_delivered_at, tracking_health, tracking_is_disposed,
			       tracking_checked_at, carrier_confirmed_at, tracking_last_error,
			       tracking_error_count, tracking_next_check_at
			FROM receipts WHERE receipt_id = 3
		`).get()
		assert.strictEqual(row.tracking_code, '4PX4444444444CN')
		assert.strictEqual(row.tracking_status, null)
		assert.strictEqual(row.tracking_last_event, null)
		assert.strictEqual(row.tracking_delivered_at, null)
		assert.strictEqual(row.tracking_health, null)
		assert.strictEqual(row.tracking_is_disposed, 0)
		assert.strictEqual(row.tracking_checked_at, null)
		assert.strictEqual(row.carrier_confirmed_at, null)
		assert.strictEqual(row.tracking_last_error, null)
		assert.strictEqual(row.tracking_error_count, 0)
		assert.strictEqual(row.tracking_next_check_at, null)
	})

	await check('consignment-linked 4PX number wins when Etsy tracking diverges', async () => {
		db.prepare(`
			INSERT INTO receipts (
				receipt_id, shop_id, group_id, name, etsy_created_at,
				tracking_code, fourpx_tracking_no, fourpx_consignment_no,
				tracking_status, shipment_notified_at
			) VALUES (
				9, 's1', 'g1', 'Mismatch buyer', @now,
				'4PX5555555555CN', '4PX6666666666CN', 'C9',
				'pre_transit', @now
			)
		`).run({ now })
		let polled = null
		const launch = startTrackingCycle(db, config, {
			trigger: 'parcel_manual',
			ignoreDisabled: true,
			receiptIds: [9],
			getSnapshot: async (trackingNo) => {
				polled = trackingNo
				return snapshot('in_transit', { firstScanAt: now })
			},
		})
		await launch.promise
		assert.strictEqual(polled, '4PX6666666666CN')
		const listed = getShipments(db, { q: 'Mismatch buyer', limit: 10 }).rows[0]
		assert.strictEqual(listed.tracking_no, '4PX6666666666CN')
	})

	await check('manual tracking-number changes clear every cached snapshot field', () => {
		db.prepare(`
			INSERT INTO receipts (
				receipt_id, shop_id, group_id, source, name, etsy_created_at,
				tracking_code, fourpx_tracking_no, tracking_status,
				tracking_last_event, tracking_last_event_at, tracking_health,
				tracking_is_disposed, tracking_delivered_at, carrier_confirmed_at,
				tracking_checked_at, tracking_last_error, tracking_error_count,
				tracking_next_check_at
			) VALUES (
				8, 's1', 'g1', 'manual', 'Manual buyer', @now,
				'4PX1111111111CN', '4PX1111111111CN', 'exception',
				'Old parcel event', @now, 'critical',
				1, @now, @now,
				@now, 'old failure', 3, @now
			)
		`).run({ now })
		assert.strictEqual(setManualOrderTracking(db, 8, {
			tracking_code: '4PX2222222222CN',
			carrier_name: '4PX',
		}), true)
		const row = db.prepare(`
			SELECT tracking_code, tracking_status, tracking_last_event,
			       tracking_health, tracking_is_disposed, tracking_delivered_at,
			       carrier_confirmed_at, tracking_checked_at, tracking_last_error,
			       tracking_error_count, tracking_next_check_at
			FROM receipts WHERE receipt_id = 8
		`).get()
		assert.strictEqual(row.tracking_code, '4PX2222222222CN')
		assert.strictEqual(row.tracking_status, null)
		assert.strictEqual(row.tracking_last_event, null)
		assert.strictEqual(row.tracking_health, null)
		assert.strictEqual(row.tracking_is_disposed, 0)
		assert.strictEqual(row.tracking_delivered_at, null)
		assert.strictEqual(row.carrier_confirmed_at, null)
		assert.strictEqual(row.tracking_checked_at, null)
		assert.strictEqual(row.tracking_last_error, null)
		assert.strictEqual(row.tracking_error_count, 0)
		assert.strictEqual(row.tracking_next_check_at, null)
		assert.throws(
			() => setManualOrderTracking(db, 8, { tracking_code: `4PX');alert(1);//`, carrier_name: '4PX' }),
			/unsupported characters/i,
		)
	})

	try {
		db.close()
		fs.rmSync(tmpDir, { recursive: true, force: true })
	} catch {}

	console.log(`\n${failures ? `${failures} failed` : 'All tracking refresh tests passed.'}`)
	process.exit(failures ? 1 : 0)
})()
