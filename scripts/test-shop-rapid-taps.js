'use strict'

/**
 * Regression tests for Shopping Mode's rapid-tap guarantees:
 *   1. stale route snapshots cannot overwrite optimistic purchases;
 *   2. an older in-flight ACK cannot delete a newer coalesced write;
 *   3. partial assignment upserts preserve unrelated component fields atomically.
 */

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const ShopSync = require('../public/shop-sync')
const { initDb, upsertRouteAssignment } = require('../src/db/setup')

const GREEN = '\x1b[32m', RED = '\x1b[31m', BOLD = '\x1b[1m', DIM = '\x1b[2m', RESET = '\x1b[0m'
let passed = 0, failed = 0
const failures = []
const pendingTests = []
function group(name) { pendingTests.push({ group: name }) }
function test(name, fn) { pendingTests.push({ name, fn }) }

const SHOP_PATH = path.resolve(__dirname, '../public/shop.html')
const SERVER_PATH = path.resolve(__dirname, '../src/server/index.js')
const DB_PATH = path.resolve(__dirname, '../src/db/setup.js')
const shopSource = fs.readFileSync(SHOP_PATH, 'utf8')
const serverSource = fs.readFileSync(SERVER_PATH, 'utf8')
const dbSource = fs.readFileSync(DB_PATH, 'utf8')

const START = '// ══ SHOP ROUTE SNAPSHOT COORDINATOR ══'
const END = '// ══ END SHOP ROUTE SNAPSHOT COORDINATOR ══'
const blockStart = shopSource.indexOf(START)
const blockEnd = shopSource.indexOf(END)
if (blockStart < 0 || blockEnd < 0 || blockEnd <= blockStart) {
	throw new Error('Shopping snapshot coordinator sentinels are missing')
}

function makeCoordinator() {
	const context = { AbortController }
	vm.createContext(context)
	vm.runInContext(
		shopSource.slice(blockStart, blockEnd) +
			`\nglobalThis.__coordinator = {
				begin: beginRouteFetch,
				current: routeFetchIsCurrent,
				finish: finishRouteFetch,
				invalidate: invalidateRouteFetches,
				mutate: recordLocalMutation,
				state: () => ({
					fetchEpoch: routeFetchEpoch,
					mutationEpoch: routeMutationEpoch,
					active: activeRouteFetch,
					foreground: foregroundRouteFetch,
				}),
			}`,
		context,
	)
	return context.__coordinator
}

group('Stale route snapshots')

test('an untouched snapshot remains current until it finishes', () => {
	const coordinator = makeCoordinator()
	const token = coordinator.begin('reconcile')
	assert.strictEqual(coordinator.current(token), true)
	coordinator.finish(token)
	assert.strictEqual(coordinator.state().active, null)
})

test('a rapid local tap aborts and invalidates an in-flight snapshot', () => {
	const coordinator = makeCoordinator()
	const token = coordinator.begin('reconcile')
	coordinator.mutate()
	assert.strictEqual(token.controller.signal.aborted, true)
	assert.strictEqual(coordinator.current(token), false)
	assert.strictEqual(coordinator.state().mutationEpoch, 1)
})

test('a successful write ACK invalidates GETs that started after the tap', () => {
	const coordinator = makeCoordinator()
	coordinator.mutate()
	const token = coordinator.begin('reconcile')
	assert.strictEqual(coordinator.current(token), true)
	coordinator.invalidate()
	assert.strictEqual(token.controller.signal.aborted, true)
	assert.strictEqual(coordinator.current(token), false)
})

test('a newer route request aborts the older request', () => {
	const coordinator = makeCoordinator()
	const older = coordinator.begin('reconcile')
	const newer = coordinator.begin('load')
	assert.strictEqual(older.controller.signal.aborted, true)
	assert.strictEqual(coordinator.current(older), false)
	assert.strictEqual(coordinator.current(newer), true)
	assert.strictEqual(coordinator.state().foreground, newer)
})

group('Rapid coalescing and durable persistence')

test('an old ACK cannot delete a newer same-line desired state', () => {
	const first = ShopSync.makeAssignEntry(
		null,
		{ receipt_id: 7, item_key: 'line', title: 'Case', patch: { status_case: 'Purchased' } },
		1,
	)
	const newer = ShopSync.makeAssignEntry(
		first,
		{ receipt_id: 7, item_key: 'line', title: 'Case', patch: { status_grip: 'Purchased' } },
		2,
	)
	assert.strictEqual(ShopSync.canAcknowledgeEntry(newer, first), false)
	assert.strictEqual(ShopSync.canAcknowledgeEntry(newer, newer), true)
	assert.deepStrictEqual(
		{ case: newer.body.status_case, grip: newer.body.status_grip },
		{ case: 'Purchased', grip: 'Purchased' },
	)
})

test('the page waits for its serialized IndexedDB writes before flushing', () => {
	assert.ok(shopSource.includes('let queuePersistChain = Promise.resolve()'))
	assert.ok(shopSource.includes('queuePersistedVersion < queuePersistVersion'))
	assert.ok(/persistQueuedEntry\(entry\)\.finally\(\(\) => \{[\s\S]{0,120}?flush\(\)/.test(shopSource))
})

test('background replay keeps retryable/auth failures and drops definitive results', async () => {
	const entries = [
		{ id: 'ok', url: '/ok', body: {} },
		{ id: 'auth', url: '/auth', body: {} },
		{ id: 'server', url: '/server', body: {} },
		{ id: 'bad', url: '/bad', body: {} },
	]
	const deleted = new Set()
	const statuses = { '/ok': 200, '/auth': 401, '/server': 503, '/bad': 400 }
	const fetchImpl = async (url) => {
		const status = statuses[url]
		return { status, ok: status >= 200 && status < 300 }
	}
	const storage = {
		getAll: async () => entries,
		deleteEntry: async (id) => deleted.add(id),
		count: async () => entries.length - deleted.size,
	}
	const result = await ShopSync.replayAll(fetchImpl, storage)
	assert.deepStrictEqual([...deleted].sort(), ['bad', 'ok'])
	assert.deepStrictEqual(result, { sent: 1, remaining: 2, authFailed: true })
})

group('Atomic partial assignment writes')

test('sequential partial writes preserve every component', () => {
	const db = initDb(':memory:')
	try {
		upsertRouteAssignment(db, {
			receipt_id: 99,
			item_key: 'combo',
			title: 'Combo',
			status_case: 'Pending',
			status_grip: 'Pending',
			status_charm: 'Pending',
		})
		upsertRouteAssignment(db, {
			receipt_id: 99,
			item_key: 'combo',
			status_case: 'Purchased',
		})
		const row = upsertRouteAssignment(db, {
			receipt_id: 99,
			item_key: 'combo',
			status_grip: 'Purchased',
		})
		assert.strictEqual(row.status_case, 'Purchased')
		assert.strictEqual(row.status_grip, 'Purchased')
		assert.strictEqual(row.status_charm, 'Pending')
		assert.strictEqual(row.title, 'Combo')
	} finally {
		db.close()
	}
})

test('explicit clears work while omitted fields remain untouched', () => {
	const db = initDb(':memory:')
	try {
		upsertRouteAssignment(db, {
			receipt_id: 100,
			item_key: 'charm',
			title: 'Charm case',
			charm_code: 'CH-1',
			charm_shop: 'Shop A',
			status_charm: 'Purchased',
			supplier_shop_override: 'Supplier A',
		})
		const row = upsertRouteAssignment(db, {
			receipt_id: 100,
			item_key: 'charm',
			charm_code: '',
			charm_shop: '',
		})
		assert.strictEqual(row.charm_code, '')
		assert.strictEqual(row.charm_shop, '')
		assert.strictEqual(row.status_charm, 'Purchased')
		assert.strictEqual(row.supplier_shop_override, 'Supplier A')
	} finally {
		db.close()
	}
})

test('an invalid partial status cannot erase a valid stored status', () => {
	const db = initDb(':memory:')
	try {
		upsertRouteAssignment(db, {
			receipt_id: 101,
			item_key: 'case',
			status_case: 'Purchased',
		})
		const row = upsertRouteAssignment(db, {
			receipt_id: 101,
			item_key: 'case',
			status_case: 'not-a-status',
		})
		assert.strictEqual(row.status_case, 'Purchased')
	} finally {
		db.close()
	}
})

test('the DB merge is one atomic UPSERT with column-presence guards', () => {
	const start = dbSource.indexOf('function upsertRouteAssignment')
	const end = dbSource.indexOf('/**', start + 20)
	const fn = dbSource.slice(start, end)
	assert.ok(!fn.includes('SELECT * FROM route_assignments'), 'read-modify-write SELECT returned')
	assert.ok(fn.includes('WHEN @has_status_case = 1 THEN excluded.status_case'))
	assert.ok(fn.includes('WHEN @has_status_grip = 1 THEN excluded.status_grip'))
	assert.ok(fn.includes('RETURNING *'))
})

group('Shipped integration contract')

test('load and reconcile both use cancellable, no-store snapshots', () => {
	assert.ok((shopSource.match(/signal: fetchToken\.controller\.signal/g) || []).length >= 2)
	assert.ok((shopSource.match(/cache: 'no-store'/g) || []).length >= 2)
	assert.ok((shopSource.match(/routeFetchIsCurrent\(fetchToken\)/g) || []).length >= 2)
})

test('a successful flush ACK invalidates any older route snapshot', () => {
	assert.ok(/if \(resp\.ok\) invalidateRouteFetches\(\)/.test(shopSource))
	assert.ok(shopSource.includes('ShopSync.canAcknowledgeEntry(pending.get(id), entry)'))
})

test('foreground return has one ordered drain-and-reconcile path', () => {
	const handlers = shopSource.match(/document\.addEventListener\('visibilitychange'/g) || []
	assert.strictEqual(handlers.length, 1)
	assert.ok(shopSource.includes('Promise.resolve(flush()).finally(() => reconcile())'))
	assert.ok(!/visibilitychange[\s\S]{0,220}?load\(false\)/.test(shopSource))
})

test('mobile assignment side effects are transactionally complete', () => {
	const start = serverSource.indexOf("app.post('/api/shop/assign'")
	const end = serverSource.indexOf("app.post('/api/shop/cost'", start)
	const handler = serverSource.slice(start, end)
	assert.ok(handler.includes('db.transaction(() => {'))
	assert.ok(handler.includes('row = upsertRouteAssignment'))
	assert.ok(handler.includes('settledFixes = settleBoughtModelFixes'))
	assert.ok(handler.includes('settled_model_fixes: settledFixes'))
	assert.ok(serverSource.includes("const SHELL = 'shopping-route-shell-v40'"))
	assert.ok(serverSource.includes("'/shop-supplier-prep.js'"))
})

;(async () => {
	for (const entry of pendingTests) {
		if (entry.group) {
			console.log(`\n${BOLD}${entry.group}${RESET}`)
			continue
		}
		try {
			await entry.fn()
			passed++
			console.log(`${GREEN}  ✓${RESET} ${entry.name}`)
		} catch (error) {
			failed++
			failures.push({ name: entry.name, error })
			console.log(`${RED}  ✗${RESET} ${entry.name}`)
		}
	}
	console.log()
	if (failed) {
		console.log(`${RED}${BOLD}  ${failed} test(s) failed${RESET}, ${passed} passed`)
		for (const failure of failures) {
			console.log(`${DIM}  · ${failure.name}: ${failure.error.message}${RESET}`)
		}
		process.exit(1)
	}
	console.log(`${GREEN}${BOLD}  All ${passed} tests passed.${RESET}\n`)
})()
