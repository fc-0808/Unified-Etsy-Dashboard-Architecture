'use strict'

/**
 * Pins the desktop dashboard tab bar's information architecture.
 *
 * The previous flat order mixed catalog, finance, admin, shipping and the
 * shopping route, so related work did not sit together and Route was not last.
 * These assertions fail the build if:
 *
 *   • Route is no longer the last tab;
 *   • a group is split or a tab moves into the wrong workflow;
 *   • empty groups stop collapsing when a role hides their tabs;
 *   • desktop Route pinning or the phone sequential-scroller override regresses;
 *   • the access-policy `data-tab`/`data-cap` adjacency contract breaks.
 *
 * Run: node scripts/test-dashboard-nav.js
 */

const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { JSDOM } = require('jsdom')

const HTML = path.resolve(__dirname, '../public/index.html')
const source = fs.readFileSync(HTML, 'utf8').replace(/\r\n/g, '\n')

const GREEN = '\x1b[32m',
	RED = '\x1b[31m',
	DIM = '\x1b[2m',
	BOLD = '\x1b[1m',
	RESET = '\x1b[0m'
let passed = 0,
	failed = 0
const failures = []
const pending = []
function group(name) {
	pending.push({ group: name })
}
function test(name, fn) {
	pending.push({ name, fn })
}

const EXPECTED_TABS = ['overview', 'orders', 'shipping', 'supplies', 'listings', 'bulk', 'earnings', 'growth', 'news', 'events', 'shops', 'route']
const EXPECTED_GROUPS = [
	{ id: 'home', tabs: ['overview'] },
	{ id: 'fulfillment', tabs: ['orders', 'shipping', 'supplies'] },
	{ id: 'catalog', tabs: ['listings', 'bulk'] },
	{ id: 'performance', tabs: ['earnings', 'growth', 'news'] },
	{ id: 'admin', tabs: ['events', 'shops'] },
	{ id: 'route', tabs: ['route'] },
]

function tabBarSource() {
	const start = source.indexOf('<nav class="tabs"')
	const end = source.indexOf('</nav>', start)
	assert.ok(start >= 0 && end > start, 'dashboard tab bar <nav class="tabs"> is missing')
	return source.slice(start, end + '</nav>'.length)
}

function loadBar() {
	const dom = new JSDOM(tabBarSource())
	return { window: dom.window, bar: dom.window.document.querySelector('.tabs') }
}

function applyGates(bar, allowedCaps) {
	bar.querySelectorAll('.tab[data-tab]').forEach((el) => {
		el.classList.toggle('cap-denied', !allowedCaps.has(el.dataset.cap))
	})
	bar.querySelectorAll('.tab-group').forEach((groupEl) => {
		const visible = [...groupEl.querySelectorAll('.tab[data-tab]')].some((el) => allowedCaps.has(el.dataset.cap))
		groupEl.classList.toggle('tab-group--empty', !visible)
	})
}

group('Order and grouping')

test('Route is the last tab in the bar', () => {
	const { bar } = loadBar()
	const tabs = [...bar.querySelectorAll('.tab[data-tab]')].map((el) => el.dataset.tab)
	assert.equal(tabs.at(-1), 'route')
	assert.deepEqual(tabs, EXPECTED_TABS)
})

test('tabs sit in workflow groups, with Route in the trailing group', () => {
	const { bar } = loadBar()
	const groups = [...bar.querySelectorAll('.tab-group')].map((el) => ({
		id: el.dataset.tabGroup,
		tabs: [...el.querySelectorAll('.tab[data-tab]')].map((tab) => tab.dataset.tab),
		isEnd: el.classList.contains('tab-group--end'),
	}))
	assert.deepEqual(
		groups.map((g) => ({ id: g.id, tabs: g.tabs })),
		EXPECTED_GROUPS,
	)
	assert.equal(groups.filter((g) => g.isEnd).length, 1)
	assert.equal(groups.at(-1).id, 'route')
	assert.equal(groups.at(-1).isEnd, true)
})

test('showTab panel registry matches the visible tab order and still covers every panel', () => {
	const registry = source.match(/const TAB_IDS = \[([^\]]+)\]/)
	assert.ok(registry, 'showTab TAB_IDS registry is missing')
	const registered = [...registry[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
	assert.deepEqual(registered, EXPECTED_TABS)
})

group('Semantics and policy contract')

test('the bar is a labelled nav of buttons, not anonymous divs', () => {
	const { bar } = loadBar()
	assert.equal(bar.tagName, 'NAV')
	assert.equal(bar.getAttribute('aria-label'), 'Dashboard sections')
	for (const tab of bar.querySelectorAll('.tab[data-tab]')) {
		assert.equal(tab.tagName, 'BUTTON')
		assert.equal(tab.getAttribute('type'), 'button')
		assert.equal(tab.getAttribute('aria-controls'), `tab-${tab.dataset.tab}`)
	}
	const current = bar.querySelector('[aria-current="page"]')
	assert.ok(current, 'the landing tab is not marked aria-current')
	assert.equal(current.dataset.tab, 'orders')
})

test('data-tab still sits immediately before data-cap for the access-policy parser', () => {
	const bar = tabBarSource()
	const pairs = [...bar.matchAll(/data-tab="([^"]+)"\s+data-cap="([^"]+)"/g)].map((m) => m[1])
	assert.deepEqual(pairs, EXPECTED_TABS)
	assert.equal((bar.match(/data-tab="/g) || []).length, EXPECTED_TABS.length)
})

group('Capability gating')

test('denied groups collapse so their hairline does not linger', () => {
	assert.ok(source.includes("group.classList.toggle('tab-group--empty', !visible)"), 'applyCapabilityGates no longer collapses empty groups')
	const { bar } = loadBar()
	applyGates(bar, new Set(['orders:read', 'route:read', 'supplies:manage']))
	const visibleGroups = [...bar.querySelectorAll('.tab-group')].filter((el) => !el.classList.contains('tab-group--empty'))
	assert.deepEqual(
		visibleGroups.map((el) => el.dataset.tabGroup),
		['fulfillment', 'route'],
	)
	const visibleTabs = [...bar.querySelectorAll('.tab[data-tab]:not(.cap-denied)')].map((el) => el.dataset.tab)
	assert.deepEqual(visibleTabs, ['orders', 'supplies', 'route'])
	assert.equal(visibleTabs.at(-1), 'route')
})

test('a surviving middle group does not inherit a leading hairline from a hidden neighbour', () => {
	assert.ok(source.includes('.tab-group:not(.tab-group--empty) ~ .tab-group:not(.tab-group--empty):not(.tab-group--end)'))
	const { bar } = loadBar()
	applyGates(bar, new Set(['listings:manage', 'route:read']))
	const visible = [...bar.querySelectorAll('.tab-group')].filter((el) => !el.classList.contains('tab-group--empty'))
	assert.deepEqual(
		visible.map((el) => el.dataset.tabGroup),
		['catalog', 'route'],
	)
	assert.equal(visible[0].classList.contains('tab-group--end'), false)
})

group('Desktop pin vs phone scroller')

test('desktop pins the Route group to the trailing edge', () => {
	const marker = source.indexOf('/* A rule appears only in front of a group')
	assert.ok(marker > 0, 'desktop group-separator comment is missing')
	const block = source.slice(marker, source.indexOf('@media (max-width: 768px)', marker))
	assert.match(block, /\.tab-group--end:not\(\.tab-group--empty\) \{[\s\S]*?margin-left:\s*auto;/)
})

test('phones keep Route last in the sequential strip instead of inserting a dead gap', () => {
	const marker = source.indexOf("A phone's tab strip is a sequential scroller")
	assert.ok(marker > 0, 'phone scroller comment is missing')
	const nearby = source.slice(marker, marker + 450)
	assert.match(nearby, /\.tab-group--end:not\(\.tab-group--empty\) \{[\s\S]*?margin-left:\s*8px;/)
	assert.ok(!nearby.includes('margin-left: auto'))
})

test('arrow keys walk visible tabs and activate the destination', () => {
	assert.ok(source.includes("e.key === 'ArrowRight' ? 1"))
	assert.ok(source.includes("e.key === 'Home' ? 'start'"))
	assert.ok(source.includes("el.setAttribute('aria-current', 'page')"))
	assert.ok(source.includes('el.tabIndex = on ? 0 : -1'))
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
