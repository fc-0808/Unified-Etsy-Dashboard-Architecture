'use strict'

/**
 * Behavioural contracts for the Route stale-while-revalidate coordinator plus
 * source-level DOM bounds that are impractical to time reliably in CI.
 */

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m'
let passed = 0, failed = 0
const failures = []
const pending = []
function group(name) { pending.push({ group: name }) }
function test(name, fn) { pending.push({ name, fn }) }

const htmlPath = path.resolve(__dirname, '../public/index.html')
const source = fs.readFileSync(htmlPath, 'utf8')
const START = '// ══ ROUTE LOADING COORDINATOR ══'
const END = '// ══ END ROUTE LOADING COORDINATOR ══'
const start = source.indexOf(START)
const end = source.indexOf(END)
if (start < 0 || end <= start) {
	console.error(`${RED}Could not locate the Route loading coordinator sentinels.${RESET}`)
	process.exit(1)
}

const context = {
	AbortController,
	Date,
	JSON,
	Map,
	Math,
	Object,
	Promise,
	String,
	_routeLoadSeq: 0,
}
vm.createContext(context)
vm.runInContext(
	source.slice(start, end) +
		'\nthis.createRouteCoordinator = _createRouteLoadingCoordinator;' +
		'\nthis.routeSignature = _routeSnapshotSignature;',
	context,
)
const createRouteCoordinator = context.createRouteCoordinator
const routeSignature = context.routeSignature
const tick = () => new Promise((resolve) => setImmediate(resolve))

function makeHarness() {
	const requests = []
	const states = []
	const applies = []
	let firstLoads = 0
	let renders = 0
	let visibleSignature = ''
	let visibleData = null

	const coordinator = createRouteCoordinator({
		keyOf: (request) => request.key,
		fetcher: (request, { signal, requestSeq }) =>
			new Promise((resolve, reject) => {
				const record = { request, signal, requestSeq, resolve, reject }
				requests.push(record)
				signal.addEventListener(
					'abort',
					() => {
						const error = new Error('aborted')
						error.name = 'AbortError'
						reject(error)
					},
					{ once: true },
				)
			}),
		applySnapshot: (snapshot, meta) => {
			applies.push({ snapshot, meta })
			visibleData = snapshot.data
			// Mirrors _applyRouteDashboardSnapshot: an already-painted, equivalent
			// snapshot updates freshness metadata but performs zero DOM render.
			if (!(meta.unchanged && visibleSignature === snapshot.signature)) {
				visibleSignature = snapshot.signature
				renders++
			}
		},
		onFirstLoading: () => {
			firstLoads++
		},
		onState: (state, detail) => states.push({ state, detail }),
	})

	return {
		coordinator,
		requests,
		states,
		applies,
		get firstLoads() {
			return firstLoads
		},
		get renders() {
			return renders
		},
		get visibleData() {
			return visibleData
		},
	}
}

async function resolveRequest(harness, index, data) {
	await tick()
	assert.ok(harness.requests[index], `request ${index} was not started`)
	harness.requests[index].resolve(data)
	await tick()
}

group('Coordinator')

test('the first scope shows loading once and shares one in-flight request', async () => {
	const h = makeHarness()
	const first = h.coordinator.load({ key: 'default' })
	const duplicate = h.coordinator.load({ key: 'default' })
	assert.strictEqual(duplicate, first, 'same-scope callers did not share the Promise')
	assert.strictEqual(h.firstLoads, 1, 'duplicate entry flashed loading again')
	await tick()
	assert.strictEqual(h.requests.length, 1, 'duplicate entry started a second fetch')
	h.requests[0].resolve({ rows: [{ receipt_id: 1, item_key: 'a' }] })
	await first
	assert.strictEqual(h.renders, 1)
})

test('cache re-entry paints synchronously, has no loading flash, and silently revalidates', async () => {
	const h = makeHarness()
	const first = h.coordinator.load({ key: 'scope-a' })
	await resolveRequest(h, 0, { rows: [{ receipt_id: 1, item_key: 'a', status: { a: 1, b: 2 } }] })
	await first
	const renders = h.renders
	const loadingCalls = h.firstLoads

	const refresh = h.coordinator.load({ key: 'scope-a' })
	assert.strictEqual(h.visibleData.rows[0].receipt_id, 1, 'cached data was not retained synchronously')
	assert.strictEqual(h.applies.at(-1).meta.source, 'cache')
	assert.strictEqual(h.firstLoads, loadingCalls, 'cache re-entry flashed the first-load state')
	assert.strictEqual(h.renders, renders, 'cache re-entry rebuilt already-visible DOM')

	await tick()
	assert.strictEqual(h.requests.length, 2, 'SWR did not start a background refresh')
	// Same semantic payload, deliberately shuffled object keys.
	h.requests[1].resolve({ rows: [{ status: { b: 2, a: 1 }, item_key: 'a', receipt_id: 1 }] })
	await refresh
	assert.strictEqual(h.applies.at(-1).meta.unchanged, true)
	assert.strictEqual(h.renders, renders, 'an unchanged snapshot rebuilt the DOM')
	assert.ok(h.states.some((entry) => entry.state === 'refreshing' && entry.detail.stale), 'refresh was not marked as stale-while-revalidate')
})

test('a newer scope aborts stale work and only the newest response applies', async () => {
	const h = makeHarness()
	const stale = h.coordinator.load({ key: 'old' })
	await tick()
	const fresh = h.coordinator.load({ key: 'new' })
	assert.strictEqual(h.requests[0].signal.aborted, true, 'superseded request was not aborted')
	await tick()
	assert.strictEqual(h.requests.length, 2)
	h.requests[1].resolve({ rows: [{ receipt_id: 2, item_key: 'new' }] })
	await Promise.all([stale, fresh])
	const networkApplies = h.applies.filter((entry) => entry.meta.source === 'network')
	assert.deepStrictEqual(networkApplies.map((entry) => entry.snapshot.key), ['new'])
	assert.strictEqual(h.visibleData.rows[0].receipt_id, 2)
})

test('an uncached scope never treats another scope as safe stale data', async () => {
	const h = makeHarness()
	const first = h.coordinator.load({ key: 'shop-a' })
	await resolveRequest(h, 0, { rows: [{ receipt_id: 1, item_key: 'a' }] })
	await first

	const next = h.coordinator.load({ key: 'shop-b' })
	await tick()
	assert.strictEqual(h.firstLoads, 2, 'a new uncached scope kept the previous scope actionable')
	const refreshing = h.states.at(-1)
	assert.strictEqual(refreshing.state, 'refreshing')
	assert.strictEqual(refreshing.detail.stale, false, 'another scope was advertised as a stale copy of this one')
	h.requests[1].reject(new Error('offline'))
	await next
	const error = h.states.at(-1)
	assert.strictEqual(error.state, 'error')
	assert.strictEqual(error.detail.stale, false, 'a failed shop change fell back to a different shop snapshot')
})

test('navigation abort detaches immediately so re-entry starts a fresh request', async () => {
	const h = makeHarness()
	const abandoned = h.coordinator.load({ key: 'default' })
	await tick()
	h.coordinator.abort()
	assert.strictEqual(h.requests[0].signal.aborted, true)

	const replacement = h.coordinator.load({ key: 'default' })
	await tick()
	assert.strictEqual(h.requests.length, 2, 're-entry reused the already-aborted request')
	h.requests[1].resolve({ rows: [{ receipt_id: 3, item_key: 'fresh' }] })
	await Promise.all([abandoned, replacement])
	assert.strictEqual(h.visibleData.rows[0].item_key, 'fresh')
})

test('refresh failure keeps old data and exposes a retryable stale error state', async () => {
	const h = makeHarness()
	const first = h.coordinator.load({ key: 'same' })
	await resolveRequest(h, 0, { rows: [{ receipt_id: 9, item_key: 'kept' }] })
	await first
	const refresh = h.coordinator.load({ key: 'same' })
	await tick()
	h.requests[1].reject(new Error('offline'))
	await refresh
	assert.strictEqual(h.visibleData.rows[0].item_key, 'kept')
	const error = h.states.at(-1)
	assert.strictEqual(error.state, 'error')
	assert.strictEqual(error.detail.stale, true)
})

test('stable signatures ignore object property order', () => {
	assert.strictEqual(
		routeSignature({ rows: [{ receipt_id: 1, nested: { a: 1, b: 2 } }] }),
		routeSignature({ rows: [{ nested: { b: 2, a: 1 }, receipt_id: 1 }] }),
	)
})

group('Shipped UI performance contracts')

test('mobile rendering is capped at 40 and grows through Load more in 20-row frames', () => {
	assert.ok(source.includes('const ROUTE_MOBILE_PAGE_SIZE = 40'))
	assert.ok(source.includes('rows.slice(0, _routeMobileLimit)'))
	assert.ok(source.includes('const routeRenderChunk = _compactDataViewport ? 20 : 40'))
	assert.ok(source.includes('function loadMoreRouteRows()'))
	assert.ok(source.includes('_routeMobileLimit += ROUTE_MOBILE_PAGE_SIZE'))
	assert.ok(source.includes('id="routeLoadMoreBtn" onclick="loadMoreRouteRows()"'))
	const sorter = source.slice(source.indexOf('function setRouteSort'), source.indexOf('/** Update the visual state', source.indexOf('function setRouteSort')))
	assert.ok(sorter.includes('_routeMobileLimit = ROUTE_MOBILE_PAGE_SIZE'), 'mobile sorting did not reset the bounded window')
})

test('collapsed cards defer detail hydration and keep the four-part shopping summary', () => {
	assert.ok(source.includes('const deferDetails = _compactDataViewport && !isOpen'))
	for (const kind of ['order', 'charm', 'actions']) {
		assert.ok(source.includes(`data-route-detail="${kind}"`), `${kind} is not deferred`)
	}
	assert.ok(source.includes('_hydrateRouteCardDetails(tr)'))
	assert.ok(source.includes('<td>${_supplierCellHtml(row)}</td>'))
	assert.ok(source.includes('<td>${compsCell}</td>'))
})

test('status edits patch one keyed row unless filter membership changes', () => {
	const start = source.indexOf('function _patchRouteRowAfterMutation')
	const end = source.indexOf('/**', start + 20)
	const patcher = source.slice(start, end)
	assert.ok(patcher.includes('if (wasIncluded !== isIncluded)'))
	assert.ok(patcher.includes('current.replaceWith(replacement)'))
	assert.ok(patcher.includes('_routeRenderedPresentationSignature = _routePresentationSignature(signature)'))
	assert.ok(source.includes('data-route-comp="${comp}"'))
})

test('Route controls retain 44px touch targets and the mobile queue cannot scroll sideways', () => {
	assert.ok(/\.route-card-toggle \{[\s\S]{0,360}?width: 44px;[\s\S]{0,40}?height: 44px;/.test(source))
	assert.ok(/\.route-load-more \{[\s\S]{0,80}?min-height: 44px;/.test(source))
	assert.ok(/\.route-table-wrap,[\s\S]{0,260}?overflow-x: visible;/.test(source))
	assert.ok(source.includes('#tab-route {\n\t\t\t\tmin-width: 0;\n\t\t\t\toverflow-x: clip;'))
})

test('secondary tools are accessible details and output files are not fetched on tab entry', () => {
	assert.ok(source.includes('<details class="route-tools" id="routeTools" open>'))
	assert.ok(source.includes('id="routeToolsSummary" aria-expanded="true"'))
	assert.ok(source.includes('id="routeLivePanel" aria-live="polite"'))
	const entryStart = source.indexOf('function loadRouteTab()')
	const entryEnd = source.indexOf('/** Load the supplier directory', entryStart)
	assert.ok(!source.slice(entryStart, entryEnd).includes('loadRouteOutputFiles('), 'tab entry eagerly fetched output files')
	const doneStart = source.indexOf("} else if (job.status === 'done')")
	const doneEnd = source.indexOf("} else if (job.status === 'error')", doneStart)
	assert.ok(source.slice(doneStart, doneEnd).includes('if (_routeJobWasRunning)'))
	assert.ok(source.slice(doneStart, doneEnd).includes('loadRouteOutputFiles()'))
})

test('leaving Route aborts its request and action-card semantics match their behavior', () => {
	const tabs = source.slice(source.indexOf('function showTab(name)'), source.indexOf('// ── Live Route-tab refresh'))
	assert.ok(tabs.includes("const leavingRoute = _routeTabActive && name !== 'route'"))
	assert.ok(tabs.includes('_routeDashboardLoader.abort()'))
	const summary = source.slice(source.indexOf('function _renderRouteSummary'), source.indexOf('function _routeFilterState'))
	assert.ok(summary.includes("typeof pressed === 'boolean'"))
	assert.ok(summary.includes("label: 'To exchange'"))
	assert.ok(summary.includes("label: 'Model corrections'"))
	assert.ok(summary.includes("label: 'Excluded'"))
})

test('desktop sort controls and refresh state expose native keyboard semantics', () => {
	assert.strictEqual((source.match(/class="route-sort-btn"/g) || []).length, 3)
	assert.ok(source.includes("th.setAttribute('aria-sort'"))
	assert.ok(source.includes("table?.setAttribute('aria-busy'"))
	assert.ok(/\.route-sort-btn:focus-visible\s*\{/.test(source))
})

test('route summary and mobile chrome stay vertically compact', () => {
	assert.ok(source.includes('grid-template-columns: repeat(var(--route-metric-count, 5), minmax(140px, 1fr));'))
	assert.ok(source.includes("el.style.setProperty('--route-metric-count'"))
	assert.ok(/\.route-metrics\.route-action-grid \{[\s\S]{0,220}?grid-auto-flow: column;[\s\S]{0,120}?grid-auto-columns: minmax\(142px, 44vw\);/.test(source))
	assert.ok(/\.route-hero-copy p \{\s*display: none;/.test(source))
	assert.ok(/\.route-queue-head \.route-eyebrow \{\s*display: none;/.test(source))
	assert.ok(/\.route-queue-head \.route-dash-actions \{[\s\S]{0,200}?flex-wrap: nowrap;[\s\S]{0,100}?overflow-x: auto;/.test(source))
	assert.ok(/\.route-live-panel \{[\s\S]{0,120}?grid-template-columns: minmax\(0, 1fr\) auto;/.test(source))
	assert.ok(source.includes('@media (min-width: 390px) and (max-width: 768px)'))
	assert.ok(source.includes('grid-template-columns: minmax(0, 2fr) minmax(104px, 0.8fr);'))
	assert.ok(source.includes('if (_compactDataViewport) {'))
	assert.ok(source.includes('`${visible} shown · ${total} total · ${updated}'))
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
		for (const failure of failures) console.log(`${DIM}  · ${failure.name}: ${failure.error.message}${RESET}`)
		process.exit(1)
	}
	console.log(`${GREEN}${BOLD}  All ${passed} tests passed.${RESET}\n`)
})()
