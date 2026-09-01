'use strict'

/**
 * Cross-process/in-process Etsy workload coordinator regression tests.
 */

const assert = require('assert')
const { initDb } = require('../src/db/setup')
const {
	startEtsyWork,
	isEtsyWorkRunning,
	getEtsyWorkStatus,
	runInventoryWatchCycle,
} = require('../src/workers/sync')

let passed = 0
let failed = 0
const tests = []
function test(name, fn) { tests.push({ name, fn }) }

test('one in-process workload blocks every other Etsy workload', async () => {
	const db = initDb(':memory:')
	let release
	const blocker = new Promise((resolve) => { release = resolve })
	try {
		const first = startEtsyWork(db, 'manual', async ({ heartbeat }) => {
			heartbeat()
			await blocker
			return 'done'
		})
		assert.strictEqual(first.started, true)
		assert.strictEqual(isEtsyWorkRunning(), true)

		const second = startEtsyWork(db, 'inventory_watch', async () => {})
		assert.strictEqual(second.started, false)
		assert.strictEqual(second.reason, 'running')
		assert.strictEqual(second.kind, 'manual')
		assert.strictEqual(getEtsyWorkStatus(db).in_process, 'manual')

		release()
		assert.strictEqual(await first.promise, 'done')
		assert.strictEqual(isEtsyWorkRunning(), false)
		assert.strictEqual(getEtsyWorkStatus(db).lock_held, false)
	} finally {
		release?.()
		db.close()
	}
})

test('a live lock owned by another process blocks local work', async () => {
	const db = initDb(':memory:')
	try {
		const now = Math.floor(Date.now() / 1000)
		db.prepare('INSERT INTO app_locks (name, owner, acquired_at, heartbeat_at) VALUES (?, ?, ?, ?)')
			.run('sync_cycle', 'other-host:999', now, now)
		const launch = startEtsyWork(db, 'sync', async () => {})
		assert.strictEqual(launch.started, false)
		assert.strictEqual(launch.reason, 'locked')
		assert.strictEqual(getEtsyWorkStatus(db).lock_owner, 'other-host:999')
	} finally {
		db.close()
	}
})

test('the lock is released when work throws', async () => {
	const db = initDb(':memory:')
	try {
		const launch = startEtsyWork(db, 'backfill', async () => {
			throw new Error('boom')
		})
		await assert.rejects(launch.promise, /boom/)
		assert.strictEqual(isEtsyWorkRunning(), false)
		assert.strictEqual(getEtsyWorkStatus(db).lock_held, false)
	} finally {
		db.close()
	}
})

test('losing the advisory lock aborts work with a typed error', async () => {
	const db = initDb(':memory:')
	try {
		const launch = startEtsyWork(db, 'manual', async ({ heartbeat }) => {
			db.prepare("DELETE FROM app_locks WHERE name = 'sync_cycle'").run()
			heartbeat()
		})
		await assert.rejects(
			launch.promise,
			(error) => error && error.code === 'ETSY_LOCK_LOST',
		)
		assert.strictEqual(isEtsyWorkRunning(), false)
	} finally {
		db.close()
	}
})

test('inventory watch participates in the shared coordinator', async () => {
	const db = initDb(':memory:')
	let release
	const blocker = new Promise((resolve) => { release = resolve })
	try {
		const active = startEtsyWork(db, 'sync', async () => blocker)
		const result = await runInventoryWatchCycle(
			{ auto_restock_enabled: false, groups: [] },
			{ hasTokens: () => false },
			db,
		)
		assert.strictEqual(result.started, false)
		assert.strictEqual(result.reason, 'running')
		release()
		await active.promise
	} finally {
		release?.()
		db.close()
	}
})

;(async () => {
	for (const entry of tests) {
		try {
			await entry.fn()
			passed++
			console.log(`  \x1b[32m✓\x1b[0m ${entry.name}`)
		} catch (error) {
			failed++
			console.log(`  \x1b[31m✗\x1b[0m ${entry.name}: ${error.message}`)
		}
	}
	console.log()
	if (failed) {
		console.error(`${failed} failed, ${passed} passed`)
		process.exit(1)
	}
	console.log(`All ${passed} Etsy workload lock tests passed.`)
})()
