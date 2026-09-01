'use strict'

/**
 * Performance regression contracts.
 *
 * These checks pin the architectural guarantees that keep large/mobile datasets
 * responsive. They avoid wall-clock assertions (flaky across CI machines) and
 * instead verify bounded work, scoped SQL, request parallelism, and hot-path
 * caching in the shipped source.
 */

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { initDb } = require('../src/db/setup')
const buyQueue = require('../src/orders/buy-queue')

const GREEN = '\x1b[32m', RED = '\x1b[31m', BOLD = '\x1b[1m', DIM = '\x1b[2m', RESET = '\x1b[0m'
let passed = 0, failed = 0
const failures = []
const pending = []
function group(name) { pending.push({ group: name }) }
function test(name, fn) { pending.push({ name, fn }) }

const read = (relative) =>
	fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8')
const dashboard = read('public/index.html')
const sourcing = read('public/sourcing.html')
const server = read('src/server/index.js')
const syncWorker = read('src/workers/sync.js')
const buyQueueSource = read('src/orders/buy-queue.js')

group('Bounded mobile DOM work')

test('mobile Orders and Listings start with bounded page sizes', () => {
	assert.ok(dashboard.includes('let ordersLimit = _compactDataViewport ? 50 : 200'))
	assert.ok(dashboard.includes('listLimit = _compactDataViewport ? 100 : 500'))
	assert.ok(dashboard.includes("pageSize.value = String(ordersLimit)"))
	assert.ok(dashboard.includes("_compactDataQuery?.addEventListener?.('change'"))
	assert.ok(dashboard.includes("window.__activeDashboardTab === 'listings'"))
})

test('Orders rendering yields between bounded chunks and drops stale work', () => {
	assert.ok(dashboard.includes('const orderRenderChunk = _compactDataViewport ? 20 : 40'))
	assert.ok(dashboard.includes("tbody.insertAdjacentHTML('beforeend', chunkHtml)"))
	assert.ok(dashboard.includes('if (_req !== _ordersReqSeq) return'))
	assert.ok(/orderRenderChunk < data\.orders\.length[\s\S]{0,160}?requestAnimationFrame/.test(dashboard))
})

test('Route rendering is chunked, cancellable, and identity-safe', () => {
	assert.ok(dashboard.includes('let _routeRenderSeq = 0'))
	assert.ok(dashboard.includes('const renderSeq = ++_routeRenderSeq'))
	assert.ok(dashboard.includes('const ROUTE_MOBILE_PAGE_SIZE = 40'))
	assert.ok(dashboard.includes('rows.slice(0, _routeMobileLimit)'))
	assert.ok(dashboard.includes('const routeRenderChunk = _compactDataViewport ? 20 : 40'))
	assert.ok(dashboard.includes('if (renderSeq !== _routeRenderSeq) return'))
	assert.ok(dashboard.includes('function loadMoreRouteRows()'))
	assert.ok(dashboard.includes("const deferDetails = _compactDataViewport && !isOpen"))
	assert.ok(dashboard.includes('_hydrateRouteCardDetails(tr)'))
})

test('offscreen mobile cards can skip layout and image decode is async', () => {
	assert.ok(dashboard.includes('content-visibility: auto'))
	assert.ok(dashboard.includes('contain-intrinsic-size: auto 200px'))
	assert.ok(dashboard.includes('contain-intrinsic-size: auto 100px'))
	assert.ok((dashboard.match(/loading="lazy" decoding="async"/g) || []).length >= 3)
})

test('Listings rendering drops stale responses and stale chunks', () => {
	assert.ok(dashboard.includes('let _listReqSeq = 0'))
	assert.ok(dashboard.includes('const reqSeq = ++_listReqSeq'))
	assert.ok((dashboard.match(/if \(reqSeq !== _listReqSeq\) return/g) || []).length >= 3)
	assert.ok(dashboard.includes('const CHUNK = _compactDataViewport ? 25 : 50'))
})

group('Background and network work')

test('hidden/inactive tabs do not rebuild large tables on timers', () => {
	assert.ok(dashboard.includes("window.__activeDashboardTab = name"))
	assert.ok(dashboard.includes("if (!document.hidden && window.__activeDashboardTab === 'orders') fetchOrders()"))
	assert.ok(dashboard.includes("if (!document.hidden && window.__activeDashboardTab === 'overview') loadOverview()"))
	assert.ok(!dashboard.includes('setInterval(fetchOrders, 2 * 60 * 1000)'))
	assert.ok(!dashboard.includes('setInterval(loadOverview, 2 * 60 * 1000)'))
})

test('the countdown engine uses a render-time cache and sleeps off-tab', () => {
	assert.ok(dashboard.includes('let _countdownEls = []'))
	assert.ok(dashboard.includes("_countdownEls = Array.from(tbody.querySelectorAll('.countdown[data-deadline]'))"))
	assert.ok(dashboard.includes("document.hidden || window.__activeDashboardTab !== 'orders'"))
	assert.ok(!/startCountdownEngine[\s\S]{0,400}?document\.querySelectorAll\('\.countdown/.test(dashboard))
})

test('Route startup and dashboard side reads run in parallel', () => {
	const start = dashboard.indexOf('function loadRouteTab()')
	const end = dashboard.indexOf('/** Load the supplier directory', start)
	const entry = dashboard.slice(start, end)
	assert.ok(entry.indexOf("loadRouteDashboard({ reason: 'entry' })") < entry.indexOf('Promise.allSettled('))
	assert.ok(entry.includes('void Promise.allSettled([loadRouteConfig(), _syncRouteStatus(), loadRouteSuppliers(), loadRouteCharms()])'))
	assert.ok(dashboard.includes('if (controller.signal.aborted || requestSeq !== sequence)'))
	assert.ok(dashboard.includes('if (flight && flight.key === key && !options.force) return flight.promise'))
	assert.ok(dashboard.includes('void fetch(`${API}/api/route/charm-progress`, { signal })'))
})

group('Scoped database hot paths')

test('purchase classification scopes every supporting table by receipt id', () => {
	const queries = []
	const db = {
		prepare(sql) {
			queries.push(sql.replace(/\s+/g, ' ').trim())
			return { all: () => [] }
		},
	}
	buyQueue.classifyPurchaseState(db, [
		{ receipt_id: 11, all_transactions: '[]' },
		{ receipt_id: 12, all_transactions: '[]' },
	])
	assert.ok(queries.length >= 4)
	for (const sql of queries) {
		assert.ok(/WHERE receipt_id IN \(\?,\?\)/.test(sql), `unscoped query: ${sql}`)
	}
	assert.ok(!buyQueueSource.includes("db.prepare('SELECT receipt_id, item_key, status_case, status_grip, status_charm, excluded, dismissed_at, verified_at FROM route_assignments')"))
})

test('purchase classification chunks scopes beyond SQLite parameter limits', () => {
	const queries = []
	const db = {
		prepare(sql) {
			queries.push(sql)
			return { all: () => [] }
		},
	}
	const candidates = Array.from({ length: 501 }, (_, i) => ({
		receipt_id: i + 1,
		all_transactions: '[]',
	}))
	buyQueue.classifyPurchaseState(db, candidates)
	// Counting the queries would only pin how many tables the classifier happens
	// to read today — it grows whenever a legitimate new scope is added. What
	// must hold is the property itself: EVERY scope is receipt-scoped, and every
	// one of them is split, so no statement ever approaches the host-parameter
	// limit that would make the buy queue throw on a busy day.
	const perTable = new Map()
	for (const sql of queries) {
		assert.ok(sql.includes('WHERE receipt_id IN ('), `unscoped query: ${sql}`)
		const placeholders = (sql.match(/\?/g) || []).length
		assert.ok(placeholders <= 500, `a ${placeholders}-parameter scope risks SQLITE_TOOBIG: ${sql.slice(0, 80)}`)
		const table = (/FROM (\w+)/i.exec(sql) || [, sql.slice(0, 40)])[1]
		perTable.set(table, (perTable.get(table) || 0) + 1)
	}
	assert.ok(perTable.size >= 4, `expected the classifier to read at least four scoped tables, saw ${perTable.size}`)
	for (const [table, chunks] of perTable) {
		assert.strictEqual(chunks, 2, `${table} was read in ${chunks} chunk(s) — 501 receipts must be split into 2`)
	}
})

test('hot query indexes are installed by every database initialization', () => {
	const db = initDb(':memory:')
	try {
		const indexes = new Set(
			db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
				.all()
				.map((row) => row.name),
		)
		for (const name of [
			'idx_receipts_shop_created',
			'idx_listings_shop_id',
			'idx_events_listing_type_time',
			'idx_order_issues_receipt_open',
		]) {
			assert.ok(indexes.has(name), `${name} missing`)
		}
	} finally {
		db.close()
	}
})

group('Server and secondary surfaces')

test('health probes reuse one boot fingerprint instead of spawning git', () => {
	assert.ok(server.includes('const BOOT_FINGERPRINT = bootFingerprint()'))
	assert.ok(server.includes('build: BOOT_FINGERPRINT'))
	assert.ok(server.includes('Build       : ${BOOT_FINGERPRINT}'))
	assert.ok(!server.includes('build: bootFingerprint()'))
})

test('legacy disposal repair runs once instead of on every poll', () => {
	assert.ok(server.includes('let _disposedBackfillDone = false'))
	assert.ok(server.includes('function ensureDisposedTrackingFlags()'))
	assert.ok(server.includes('if (_disposedBackfillDone) return'))
	assert.ok(server.includes('_disposedBackfillDone = true'))
	const handlerStart = server.indexOf("app.get('/api/4px/shipping-stats'")
	const handlerEnd = server.indexOf("app.get('/api/4px/shipments'", handlerStart)
	const handler = server.slice(handlerStart, handlerEnd)
	assert.ok(handler.includes('ensureDisposedTrackingFlags()'))
	assert.ok(!handler.includes('backfillDisposedTrackingFlags(db)'))
	assert.ok(handler.includes('/api/4px/shipping-alerts'))
})

test('silent Shipping refreshes preserve every expanded claim editor', () => {
	assert.ok(dashboard.includes("document.querySelector('#shipRows .ship-claim-card[open]')"))
	assert.ok(dashboard.includes('if (silent && _shipClaimEditorActive()) return'))
})

test('desktop Route status writes share the mobile atomic side effects', () => {
	const start = server.indexOf("app.post('/api/route/assign'")
	const end = server.indexOf('// Rewrite an Etsy CDN image URL', start)
	const handler = server.slice(start, end)
	assert.ok(handler.includes('db.transaction(() => {'))
	assert.ok(handler.includes('clearRouteVerified(db, row.receipt_id, row.item_key)'))
	assert.ok(handler.includes('settledFixes = settleBoughtModelFixes'))
	assert.ok(!handler.includes("console.warn('[route] issue sync failed:'"))
})

test('every Sourcing search box is debounced rather than rebuilding per keystroke', () => {
	// The page now renders three lists off one payload — a 700-row product
	// catalog, the supplier directory and the design library — so a synchronous
	// re-render on `input` would rebuild hundreds of cards per keystroke.
	// Debouncing is centralised in one helper rather than a timer per list.
	assert.ok(/function debounce\(fn, ms\) \{[\s\S]{0,200}?clearTimeout\(h\)[\s\S]{0,80}?setTimeout\(fn, ms\)/.test(sourcing), 'the shared debounce helper is gone')
	for (const input of ['catSearch', 'supSearch', 'sdSearch', 'designSearch', 'pkgSearch']) {
		const wiring = new RegExp(`getElementById\\('${input}'\\)\\.addEventListener\\('input', (?:debounce\\(|rerenderCatalog\\))`)
		assert.ok(wiring.test(sourcing), `#${input} re-renders on every keystroke`)
	}
	assert.ok(/const rerenderCatalog = debounce\(/.test(sourcing), 'the catalog search is no longer debounced')
	// A handler in markup bypasses the wiring above entirely, so it is the one
	// way this contract can be reintroduced without any of it failing.
	assert.ok(!/\soninput\s*=/i.test(sourcing), 'an inline oninput handler is back, sidestepping the debounce')
})

test('all Etsy-budget background work shares one cross-process coordinator', () => {
	assert.ok(syncWorker.includes('function startEtsyWork(db, kind, fn)'))
	assert.ok(syncWorker.includes("startEtsyWork(db, 'sync'"))
	assert.ok(syncWorker.includes("startEtsyWork(db, 'inventory_watch'"))
	assert.ok(server.includes("startEtsyWork(db, 'manual'"))
	assert.ok(server.includes("startEtsyWork(db, 'backfill'"))
	assert.ok(server.includes("startEtsyWork(db, 'ledger'"))
})

test('perceptual hashes are single-flight and canonical reconciliation is coalesced', () => {
	assert.ok(server.includes('const _listingPhashInflight = new Map()'))
	assert.ok(server.includes("_productIdentityCoordinator.schedule('backfill'"))
	assert.ok(server.includes("_productIdentityCoordinator.schedule('hydration'"))
	assert.ok(server.includes("_productIdentityCoordinator.schedule('shop-self-heal'"))
	assert.strictEqual((server.match(/reconcileCanonicalProductKeys\(\)/g) || []).length, 2)
})

;(async () => {
	for (const entry of pending) {
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
