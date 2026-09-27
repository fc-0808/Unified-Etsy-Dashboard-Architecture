'use strict'

/**
 * Pins the Sourcing → Route charm catalog deep-link contract.
 *
 * Sourcing never duplicates charm photo/supplier CRUD. It hands the operator
 * to `/?tab=route&view=charms&charm=CH-…`, and the dashboard opens the same
 * Manage Charms editor the Route tab already owns.
 *
 * Run: node scripts/test-dashboard-deep-link.js
 */

const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { JSDOM, VirtualConsole } = require('jsdom')

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

const HTML = path.resolve(__dirname, '../public/index.html')
const SOURCE = fs.readFileSync(HTML, 'utf8').replace(/\r\n/g, '\n')
const SOURCING = fs.readFileSync(path.resolve(__dirname, '../public/sourcing.html'), 'utf8')

let passed = 0
let failed = 0
const failures = []
const pending = []
const group = (name) => pending.push({ group: name })
const test = (name, fn) => pending.push({ name, fn })

function slice(startMarker, endMarker, what) {
	const a = SOURCE.indexOf(startMarker)
	const b = SOURCE.indexOf(endMarker, a + 1)
	if (a < 0 || b < 0 || b <= a) {
		throw new Error(`Could not locate the ${what} in public/index.html`)
	}
	return SOURCE.slice(a, b + endMarker.length)
}

group('Contract in the shipped pages')

test('the dashboard owns a marked deep-link block', () => {
	assert.ok(SOURCE.includes('// ══ DASHBOARD DEEP LINKS ══'))
	assert.ok(SOURCE.includes('function parseDashboardDeepLink'))
	assert.ok(SOURCE.includes('function routeCharmHref'))
	assert.ok(SOURCE.includes('function consumeDashboardDeepLink'))
	assert.ok(SOURCE.includes('async function openRouteCharmCatalog'))
	assert.ok(SOURCE.includes("catalog: true"))
	assert.ok(SOURCE.includes("id=\"charmModalTitle\""))
	assert.ok(SOURCE.includes('charm-assign-only'))
	assert.ok(SOURCE.includes('#charmModal.is-catalog .charm-assign-only'))
})

test('Sourcing builds the same Route catalog URL the dashboard parses', () => {
	assert.ok(SOURCING.includes('function routeCharmHref'))
	assert.ok(SOURCING.includes("q.set('tab', 'route')"))
	assert.ok(SOURCING.includes("q.set('view', 'charms')"))
	assert.ok(SOURCING.includes("data-act=\"route-charm\""))
	assert.ok(SOURCING.includes("target=\"${ROUTE_CHARM_WINDOW}\""))
	assert.ok(SOURCING.includes("ued-route-charms"))
})

group('Parser and href')

function loadBlock() {
	const virtualConsole = new VirtualConsole()
	const errors = []
	virtualConsole.on('jsdomError', (err) => errors.push(err))
	const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1/', runScripts: 'dangerously', virtualConsole })
	const calls = { tabs: [], catalogs: [] }
	dom.window.ROLE = { allowedTabs: () => ['orders', 'route'] }
	dom.window.showTab = (name) => calls.tabs.push(name)
	dom.window.openRouteCharmCatalog = async (opts) => {
		calls.catalogs.push({ code: opts.code || '', shop: opts.shop || '' })
	}
	const block = slice('// ══ DASHBOARD DEEP LINKS ══', '// ══ END DASHBOARD DEEP LINKS ══', 'dashboard deep-link block')
	dom.window.eval(
		`${block}
		globalThis.parseDashboardDeepLink = parseDashboardDeepLink
		globalThis.routeCharmHref = routeCharmHref
		globalThis.consumeDashboardDeepLink = consumeDashboardDeepLink
		globalThis.applyDashboardDeepLink = applyDashboardDeepLink
		`,
	)
	if (errors.length) throw errors[0]
	return { window: dom.window, calls }
}

test('parseDashboardDeepLink reads tab, charm, shop and infers Route', () => {
	const { window } = loadBlock()
	assert.equal(window.parseDashboardDeepLink(''), null)
	assert.equal(window.parseDashboardDeepLink('?foo=1'), null)
	const fromQuery = window.parseDashboardDeepLink('?tab=route&view=charms&charm=CH-00109')
	assert.equal(fromQuery.tab, 'route')
	assert.equal(fromQuery.charm, 'CH-00109')
	assert.equal(fromQuery.charmShop, '')
	assert.equal(fromQuery.view, 'charms')
	const inferred = window.parseDashboardDeepLink('charm=CH-00003')
	assert.equal(inferred.tab, 'route')
	assert.equal(inferred.charm, 'CH-00003')
	assert.equal(inferred.view, 'charms')
	assert.equal(window.parseDashboardDeepLink('?charmShop=%E5%BD%A9%E8%99%B9').charmShop, '彩虹')
})

test('routeCharmHref matches what Sourcing emits', () => {
	const { window } = loadBlock()
	assert.equal(window.routeCharmHref({ code: 'CH-00109' }), '/?tab=route&view=charms&charm=CH-00109')
	assert.equal(window.routeCharmHref({ shop: '彩虹' }), '/?tab=route&view=charms&charmShop=%E5%BD%A9%E8%99%B9')
	const parsed = window.parseDashboardDeepLink(window.routeCharmHref({ code: 'CH-00003', shop: '彩虹' }))
	assert.equal(parsed.tab, 'route')
	assert.equal(parsed.view, 'charms')
	assert.equal(parsed.charm, 'CH-00003')
	assert.equal(parsed.charmShop, '彩虹')
})

test('applyDashboardDeepLink opens Route then the charm catalog', async () => {
	const { window, calls } = loadBlock()
	const link = window.parseDashboardDeepLink(window.routeCharmHref({ code: 'CH-00109' }))
	await window.applyDashboardDeepLink(link)
	assert.equal(calls.tabs.join(','), 'route')
	assert.equal(calls.catalogs.length, 1)
	assert.equal(calls.catalogs[0].code, 'CH-00109')
	assert.equal(calls.catalogs[0].shop, '')
})

test('a charmShop-only link opens the shop manager, not a code editor', async () => {
	const { window, calls } = loadBlock()
	await window.consumeDashboardDeepLink('?charmShop=彩虹')
	assert.equal(calls.tabs.join(','), 'route')
	assert.equal(calls.catalogs.length, 1)
	assert.equal(calls.catalogs[0].code, '')
	assert.equal(calls.catalogs[0].shop, '彩虹')
})

test('a role without Route does not force the tab', async () => {
	const { window, calls } = loadBlock()
	window.ROLE.allowedTabs = () => ['orders']
	await window.applyDashboardDeepLink({ tab: 'route', charm: 'CH-00003', charmShop: '', view: 'charms' })
	assert.equal(calls.tabs.join(','), '')
	assert.equal(calls.catalogs[0].code, 'CH-00003')
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
			console.log(`${DIM}    ${error.stack || error.message}${RESET}`)
		}
	}
	console.log()
	if (failed) {
		console.log(`${RED}${BOLD}  ${failed} test(s) failed${RESET}, ${passed} passed`)
		process.exit(1)
	}
	console.log(`${GREEN}${BOLD}  All ${passed} tests passed.${RESET}\n`)
})()
