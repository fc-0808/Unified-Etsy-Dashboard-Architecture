'use strict'

/**
 * Behavioral and contract tests for the shared mobile disclosure cards used by
 * Orders, Listings, Earnings, and Shipping. The real controller is extracted
 * from public/index.html so this exercises shipped code, not a test copy.
 */

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { JSDOM, VirtualConsole } = require('jsdom')

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

const HTML = path.resolve(__dirname, '../public/index.html')
// Normalised so the multi-line CSS probes below assert on structure rather than
// on whichever line endings the working copy happens to carry. core.autocrlf
// rewrites this file on checkout, so an unnormalised \n probe fails on Windows
// for reasons that have nothing to do with the stylesheet.
const source = fs.readFileSync(HTML, 'utf8').replace(/\r\n/g, '\n')
const START = '// ══ DASHBOARD CARD EXPANSION ══'
const END = '// ══ END DASHBOARD CARD EXPANSION ══'
const start = source.indexOf(START)
const end = source.indexOf(END)
if (start < 0 || end < 0 || end <= start) {
	console.error(`${RED}Could not locate the shared dashboard-card sentinels.${RESET}`)
	process.exit(1)
}
const CONTROLLER = source.slice(start, end)
const FILTER_START = 'const ORDERS_FILTERS = (() => {'
const FILTER_END = '\n\n\t\t\t/**\n\t\t\t * Select all unshipped orders'
const filterStart = source.indexOf(FILTER_START)
const filterEnd = source.indexOf(FILTER_END, filterStart)
if (filterStart < 0 || filterEnd < 0 || filterEnd <= filterStart) {
	console.error(`${RED}Could not locate the mobile Orders-filter controller.${RESET}`)
	process.exit(1)
}
const FILTER_CONTROLLER = source.slice(filterStart, filterEnd)
const MOBILE_CHROME_START = 'const MOBILE_CHROME = (() => {'
const mobileChromeStart = source.indexOf(MOBILE_CHROME_START)
const mobileChromeEnd = source.indexOf('\n\n\t\t\t/* ═', mobileChromeStart)
if (mobileChromeStart < 0 || mobileChromeEnd < 0 || mobileChromeEnd <= mobileChromeStart) {
	console.error(`${RED}Could not locate the mobile application-chrome controller.${RESET}`)
	process.exit(1)
}
const MOBILE_CHROME_CONTROLLER = source.slice(mobileChromeStart, mobileChromeEnd)
const ROLE_REFRESH_START = '\t\t\t\tfunction refreshControls() {'
const ROLE_REFRESH_END = '\n\n\t\t\t\tasync function logout()'
const roleRefreshStart = source.indexOf(ROLE_REFRESH_START)
const roleRefreshEnd = source.indexOf(ROLE_REFRESH_END, roleRefreshStart)
if (roleRefreshStart < 0 || roleRefreshEnd < 0 || roleRefreshEnd <= roleRefreshStart) {
	console.error(`${RED}Could not locate the topbar role-state controller.${RESET}`)
	process.exit(1)
}
const ROLE_REFRESH_CONTROLLER = source.slice(roleRefreshStart, roleRefreshEnd)

function rowHtml({ scope, key, label }, open) {
	const action = open ? 'Hide' : 'Show'
	return `<tr class="fixture-row${open ? ' is-open' : ''}" data-mobile-card-scope="${scope}" data-mobile-card-key="${key}">
		<td data-mobile-card-summary>
			<span class="summary-text">${label}</span>
			<a class="summary-link" href="https://example.com">Link</a>
			<button class="summary-action" type="button">Action</button>
			<span class="summary-role" role="button" tabindex="0">Role action</span>
			<span class="summary-inline" onclick="window.__inlineHit = true">Inline action</span>
			<button type="button" class="mobile-card-toggle" aria-expanded="${open}" data-card-label="${label}" aria-label="${action} details for ${label}" title="${action} details" onclick="toggleDashboardCard(this.closest('tr'))"></button>
		</td>
		<td class="details"><input class="detail-input"><span>Details</span></td>
	</tr>`
}

const CARDS = [
	{ scope: 'orders', key: '4137213873', label: 'order #4137213873' },
	{ scope: 'listings', key: '4137213873', label: 'listing 4137213873' },
	{ scope: 'shipping', key: '88', label: 'parcel 4PX3000' },
	{ scope: 'earnings', key: '4137213873', label: 'earnings for order #4137213873' },
]

function makeEnv({ mobile = true, cards = CARDS } = {}) {
	const virtualConsole = new VirtualConsole()
	virtualConsole.on('jsdomError', () => {})
	const dom = new JSDOM('<!doctype html><html><body><table><tbody id="cards"></tbody></table></body></html>', { pretendToBeVisual: true, runScripts: 'dangerously', virtualConsole })
	const { window } = dom
	const rect = { width: 44, height: 44, top: 0, left: 0, bottom: 44, right: 44 }
	window.Element.prototype.getClientRects = function () {
		if (this.classList.contains('mobile-card-toggle') && !mobile) return []
		return [rect]
	}
	window.eval(CONTROLLER + '\nwindow.__cardIsOpen = (scope, key) => dashboardCardIsOpen(scope, key);')
	const render = (next = cards) => {
		window.document.getElementById('cards').innerHTML = next.map((card) => rowHtml(card, window.__cardIsOpen(card.scope, card.key))).join('')
	}
	render()
	return { window, doc: window.document, render }
}

const click = (window, element) => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
const rows = (doc) => Array.from(doc.querySelectorAll('tr.fixture-row'))
const isOpen = (row) => row.classList.contains('is-open')

function makeOrdersFilterEnv() {
	const dom = new JSDOM(
		`<!doctype html><html><body>
			<div id="tab-orders">
				<div class="orders-toolbar">
					<button id="ordersFilterToggle" aria-expanded="false"></button>
					<span id="ordersFilterSummary"></span>
					<span id="ordersFilterCount" hidden></span>
					<div id="ordersFilters">
						<select id="filterShipped"><option value="all" selected>All orders</option><option value="false">Needs shipping</option></select>
						<select id="filterShop"><option value="" selected>All shops</option><option value="7">Shop Seven</option></select>
						<select id="filterSort"><option value="newest" selected>Newest first</option><option value="oldest">Oldest first</option></select>
						<select id="filterPurchase"><option value="" selected>All purchases</option><option value="ready">Fully purchased</option></select>
						<select id="filterPackaged"><option value="" selected>All packaging</option><option value="true">Packaged</option></select>
						<select id="filterExpedited"><option value="" selected>All shipping</option><option value="true">Express only</option></select>
						<input id="filterOrderSearch" value="">
						<input id="filterDateFrom" value="2026-08-26">
						<input id="filterDateTo" value="">
					</div>
				</div>
			</div>
		</body></html>`,
		{ runScripts: 'dangerously', pretendToBeVisual: true },
	)
	const { window } = dom
	window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} })
	window.I18N = { t: (s) => s, get: () => 'en' }
	window._localDayKey = () => '2026-08-26'
	window.__selectCloseCount = 0
	window.__menuCloseCount = 0
	window.OFT_CSEL = { closeAll: () => window.__selectCloseCount++ }
	window.MOBILE_CHROME = { closeMenu: () => window.__menuCloseCount++ }
	window.eval(FILTER_CONTROLLER + '\nwindow.__ordersFilters = ORDERS_FILTERS;')
	window.document.dispatchEvent(new window.Event('DOMContentLoaded'))
	window.__ordersFilters.sync()
	return { window, doc: window.document, filters: window.__ordersFilters }
}

function makeMobileChromeEnv({ mobile = true } = {}) {
	const dom = new JSDOM(
		`<!doctype html><html><body>
			<div class="topbar">
				<button id="mobileHeaderMenuBtn" aria-expanded="false"></button>
				<div class="topbar-right" id="topbarMenu"><button id="teamBtn">Team</button></div>
			</div>
		</body></html>`,
		{ runScripts: 'dangerously', pretendToBeVisual: true },
	)
	const { window } = dom
	window.matchMedia = () => ({ matches: mobile, addEventListener() {}, removeEventListener() {} })
	window.I18N = { t: (s) => s }
	window.__selectCloseCount = 0
	window.__filterCloseCount = 0
	window.OFT_CSEL = { closeAll: () => window.__selectCloseCount++ }
	window.ORDERS_FILTERS = { close: () => window.__filterCloseCount++ }
	window.requestAnimationFrame = (fn) => fn()
	window.eval(MOBILE_CHROME_CONTROLLER + '\nwindow.__mobileChrome = MOBILE_CHROME;')
	window.document.dispatchEvent(new window.Event('DOMContentLoaded'))
	return { window, doc: window.document, chrome: window.__mobileChrome }
}

function makeRoleRefreshEnv({ role = null, preview = false, packer = false, user = 'walter' } = {}) {
	const dom = new JSDOM(
		`<!doctype html><html><body>
			<div id="topbarMenu">
				<span id="whoami" style="display:none"></span>
				<button class="owner-tool" id="teamBtn" style="display:none">Team</button>
				<button class="owner-tool" id="auditBtn" style="display:none">Activity</button>
				<button id="roleToggleBtn" style="display:none" aria-pressed="false"><svg aria-hidden="true"></svg><span id="roleToggleLabel">Packing Mode</span></button>
				<span id="logoutSeparator" style="display:none"></span>
				<button id="logoutBtn" style="display:none">Log out</button>
			</div>
		</body></html>`,
		{ runScripts: 'dangerously' },
	)
	const { window } = dom
	window.serverRole = () => role
	window.readCookie = (name) => (name === 'user' ? user : null)
	window.previewActive = () => preview
	window.isPacker = () => packer
	window.I18N = { t: (text) => text }
	window.eval(ROLE_REFRESH_CONTROLLER + '\nwindow.__refreshControls = refreshControls;')
	window.__refreshControls()
	return { window, doc: window.document }
}

group('Shared disclosure behavior')

test('cards start collapsed with an accessible control', () => {
	const { doc } = makeEnv()
	for (const row of rows(doc)) {
		assert.strictEqual(isOpen(row), false)
		assert.strictEqual(row.querySelector('.mobile-card-toggle').getAttribute('aria-expanded'), 'false')
	}
})

test('the disclosure button opens, closes, and updates its name', () => {
	const { window, doc } = makeEnv()
	const row = rows(doc)[0]
	const button = row.querySelector('.mobile-card-toggle')
	click(window, button)
	assert.ok(isOpen(row))
	assert.strictEqual(button.getAttribute('aria-expanded'), 'true')
	assert.strictEqual(button.getAttribute('aria-label'), `Hide details for ${CARDS[0].label}`)
	assert.strictEqual(button.title, 'Hide details')
	click(window, button)
	assert.strictEqual(isOpen(row), false)
	assert.strictEqual(button.getAttribute('aria-label'), `Show details for ${CARDS[0].label}`)
})

test('a non-interactive summary tap toggles the card', () => {
	const { window, doc } = makeEnv()
	const row = rows(doc)[0]
	click(window, row.querySelector('.summary-text'))
	assert.ok(isOpen(row))
	click(window, row.querySelector('.summary-text'))
	assert.strictEqual(isOpen(row), false)
})

test('links, controls, role buttons, and inline actions never toggle', () => {
	const { window, doc } = makeEnv()
	const row = rows(doc)[0]
	for (const selector of ['.summary-link', '.summary-action', '.summary-role', '.summary-inline']) {
		click(window, row.querySelector(selector))
		assert.strictEqual(isOpen(row), false, `${selector} toggled the card`)
	}
	assert.strictEqual(window.__inlineHit, true)
})

test('detail controls do not collapse an open card', () => {
	const { window, doc } = makeEnv()
	const row = rows(doc)[0]
	click(window, row.querySelector('.mobile-card-toggle'))
	click(window, row.querySelector('.detail-input'))
	assert.ok(isOpen(row))
})

test('the same numeric key remains independent across tabs', () => {
	const { window, doc } = makeEnv()
	click(window, rows(doc)[0].querySelector('.mobile-card-toggle'))
	assert.deepStrictEqual(rows(doc).map(isOpen), [true, false, false, false])
})

test('open state survives a tbody rebuild and follows identity', () => {
	const { window, doc, render } = makeEnv()
	click(window, rows(doc)[2].querySelector('.mobile-card-toggle'))
	render([CARDS[2], CARDS[0], CARDS[1]])
	assert.deepStrictEqual(rows(doc).map(isOpen), [true, false, false])
	assert.strictEqual(rows(doc)[0].querySelector('.mobile-card-toggle').getAttribute('aria-expanded'), 'true')
})

test('desktop summary taps are inert when the control is not rendered', () => {
	const { window, doc } = makeEnv({ mobile: false })
	click(window, rows(doc)[0].querySelector('.summary-text'))
	assert.strictEqual(isOpen(rows(doc)[0]), false)
})

group('Mobile Orders filter behavior')

test('filter disclosure starts compact with an accurate default summary', () => {
	const { doc } = makeOrdersFilterEnv()
	assert.strictEqual(doc.querySelector('.orders-toolbar').classList.contains('is-filter-open'), false)
	assert.strictEqual(doc.getElementById('ordersFilterSummary').textContent, 'All orders · All shops · Today')
	assert.strictEqual(doc.getElementById('ordersFilterCount').hidden, true)
	assert.strictEqual(doc.getElementById('ordersFilterToggle').getAttribute('aria-expanded'), 'false')
})

test('filter disclosure opens, closes, and coordinates other overlays', () => {
	const { window, doc, filters } = makeOrdersFilterEnv()
	filters.toggle()
	assert.ok(doc.querySelector('.orders-toolbar').classList.contains('is-filter-open'))
	assert.strictEqual(doc.getElementById('ordersFilterToggle').getAttribute('aria-expanded'), 'true')
	assert.strictEqual(window.__menuCloseCount, 1)
	filters.close()
	assert.strictEqual(doc.querySelector('.orders-toolbar').classList.contains('is-filter-open'), false)
	assert.strictEqual(window.__selectCloseCount, 1)
})

test('filter summary and active count follow the real form values', () => {
	const { window, doc } = makeOrdersFilterEnv()
	const shop = doc.getElementById('filterShop')
	const sort = doc.getElementById('filterSort')
	shop.value = '7'
	sort.value = 'oldest'
	sort.dispatchEvent(new window.Event('change', { bubbles: true }))
	assert.strictEqual(doc.getElementById('ordersFilterSummary').textContent, 'All orders · Shop Seven · Oldest first · Today')
	assert.strictEqual(doc.getElementById('ordersFilterCount').textContent, '2')
	assert.strictEqual(doc.getElementById('ordersFilterCount').hidden, false)
})

group('Mobile application chrome behavior')

test('mobile account menu exposes existing actions and coordinates overlays', () => {
	const { window, doc, chrome } = makeMobileChromeEnv()
	chrome.toggleMenu()
	assert.ok(doc.querySelector('.topbar').classList.contains('mobile-menu-open'))
	assert.strictEqual(doc.getElementById('mobileHeaderMenuBtn').getAttribute('aria-expanded'), 'true')
	assert.strictEqual(doc.getElementById('topbarMenu').getAttribute('aria-hidden'), 'false')
	assert.strictEqual(window.__selectCloseCount, 1)
	assert.strictEqual(window.__filterCloseCount, 1)
	chrome.closeMenu()
	assert.strictEqual(doc.querySelector('.topbar').classList.contains('mobile-menu-open'), false)
	assert.strictEqual(doc.getElementById('topbarMenu').getAttribute('aria-hidden'), 'true')
})

test('desktop keeps account actions inline and ignores the mobile trigger', () => {
	const { doc, chrome } = makeMobileChromeEnv({ mobile: false })
	chrome.toggleMenu()
	assert.strictEqual(doc.querySelector('.topbar').classList.contains('mobile-menu-open'), false)
	assert.strictEqual(doc.getElementById('topbarMenu').hasAttribute('aria-hidden'), false)
	assert.strictEqual(doc.getElementById('topbarMenu').hasAttribute('role'), false)
})

test('owner role keeps account chrome and packing preview state synchronized', () => {
	const standard = makeRoleRefreshEnv({ role: 'owner' }).doc
	assert.strictEqual(standard.getElementById('whoami').textContent, 'Signed in as walter')
	assert.strictEqual(standard.getElementById('teamBtn').style.display, '')
	assert.strictEqual(standard.getElementById('auditBtn').style.display, '')
	assert.strictEqual(standard.getElementById('logoutBtn').style.display, '')
	assert.strictEqual(standard.getElementById('logoutSeparator').style.display, '')
	assert.strictEqual(standard.getElementById('roleToggleBtn').style.display, '')
	assert.strictEqual(standard.getElementById('roleToggleBtn').getAttribute('aria-pressed'), 'false')
	assert.strictEqual(standard.getElementById('roleToggleLabel').textContent, 'Preview Packing Mode')
	assert.ok(standard.querySelector('#roleToggleBtn svg'), 'refreshing the mode label removed its icon')

	const preview = makeRoleRefreshEnv({ role: 'owner', preview: true }).doc
	assert.strictEqual(preview.getElementById('roleToggleBtn').getAttribute('aria-pressed'), 'true')
	assert.strictEqual(preview.getElementById('roleToggleLabel').textContent, 'Exit Packing Mode')
})

test('packer and auth-off states cannot leak owner or sign-out chrome', () => {
	const employee = makeRoleRefreshEnv({ role: 'packer', packer: true }).doc
	assert.strictEqual(employee.getElementById('teamBtn').style.display, 'none')
	assert.strictEqual(employee.getElementById('auditBtn').style.display, 'none')
	assert.strictEqual(employee.getElementById('roleToggleBtn').style.display, 'none')
	assert.strictEqual(employee.getElementById('roleToggleBtn').getAttribute('aria-pressed'), 'true')
	assert.strictEqual(employee.getElementById('logoutBtn').style.display, '')
	assert.strictEqual(employee.getElementById('logoutSeparator').style.display, '')

	const legacy = makeRoleRefreshEnv({ packer: false }).doc
	assert.strictEqual(legacy.getElementById('whoami').style.display, 'none')
	assert.strictEqual(legacy.getElementById('logoutBtn').style.display, 'none')
	assert.strictEqual(legacy.getElementById('logoutSeparator').style.display, 'none')
	assert.strictEqual(legacy.getElementById('roleToggleBtn').style.display, '')
	assert.strictEqual(legacy.getElementById('roleToggleBtn').getAttribute('aria-pressed'), 'false')
	assert.strictEqual(legacy.getElementById('roleToggleLabel').textContent, 'Packing Mode')
})

test('topbar actions expose a semantic hierarchy without relying on color alone', () => {
	const doc = new JSDOM(source).window.document
	const expected = {
		shoppingModeBtn: 'topbar-action--shopping',
		sourcingBtn: 'topbar-action--sourcing',
		roleToggleBtn: 'role-toggle',
		logoutBtn: 'topbar-action--danger',
	}
	for (const [id, semanticClass] of Object.entries(expected)) {
		const button = doc.getElementById(id)
		assert.ok(button, `${id} is missing`)
		assert.ok(button.classList.contains('topbar-action'), `${id} lost the shared action foundation`)
		assert.ok(button.classList.contains(semanticClass), `${id} lost its semantic visual treatment`)
		assert.ok(button.querySelector('svg[aria-hidden="true"]'), `${id} has no non-color icon cue`)
	}
	assert.deepStrictEqual(
		[...doc.querySelectorAll('#topbarMenu button.role-toggle')].map((button) => button.id),
		['roleToggleBtn'],
		'non-mode actions can inherit the packing state color',
	)
	assert.deepStrictEqual(
		[...doc.querySelectorAll('#topbarMenu > .topbar-action')].map((button) => button.id),
		['sourcingBtn', 'shoppingModeBtn', 'roleToggleBtn', 'logoutBtn'],
		'topbar workflow actions are no longer in the intended source → shop → pack → sign-out order',
	)
	assert.strictEqual(doc.getElementById('roleToggleBtn').getAttribute('aria-pressed'), 'false', 'packing mode lacks initial toggle state')
	assert.strictEqual(doc.getElementById('logoutBtn').previousElementSibling?.id, 'logoutSeparator', 'sign-out is no longer isolated from workspace chrome')
	assert.ok(source.includes("btn.setAttribute('aria-pressed', active ? 'true' : 'false')"), 'packing mode no longer publishes its live state')
	assert.ok(/\.topbar-action:focus-visible \{[\s\S]{0,120}?box-shadow:/.test(source), 'topbar actions lost their keyboard focus ring')
	assert.ok(/\.topbar-action,\s*\n\s*\.topbar-btn \{[\s\S]{0,160}?min-height:\s*44px;/.test(source), 'mobile header actions are smaller than the 44px touch target')
})

test('topbar semantic tones meet WCAG AA contrast on their rendered backgrounds', () => {
	const hexRgb = (value) => [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16))
	const luminance = (rgb) => {
		const linear = rgb.map((channel) => {
			const value = channel / 255
			return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
		})
		return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
	}
	const contrast = (foreground, background) => {
		const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
		return (light + 0.05) / (dark + 0.05)
	}
	const surfaceMatch = source.match(/--surface:\s*(#[0-9a-f]{6});/i)
	assert.ok(surfaceMatch, 'dashboard surface color is missing')
	const surface = hexRgb(surfaceMatch[1])
	const selectors = ['.topbar-action--shopping', '.topbar-action--sourcing', '.role-toggle', 'body.mode-packer .role-toggle', '.topbar-action--danger']
	const foregrounds = new Set()
	for (const selector of selectors) {
		const start = source.indexOf(`\n\t\t\t${selector} {`)
		const end = source.indexOf('\n\t\t\t}', start)
		assert.ok(start >= 0 && end > start, `${selector} style block is missing`)
		const css = source.slice(start, end)
		const foregroundMatch = css.match(/--action-color:\s*(#[0-9a-f]{6});/i)
		const backgroundMatch = css.match(/--action-bg:\s*rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\);/i)
		assert.ok(foregroundMatch && backgroundMatch, `${selector} has no testable foreground/background tone`)
		foregrounds.add(foregroundMatch[1].toLowerCase())
		const overlay = backgroundMatch.slice(1).map(Number)
		const renderedBackground = surface.map((channel, index) => Math.round(overlay[index] * overlay[3] + channel * (1 - overlay[3])))
		const ratio = contrast(hexRgb(foregroundMatch[1]), renderedBackground)
		assert.ok(ratio >= 4.5, `${selector} contrast is ${ratio.toFixed(2)}:1; expected at least 4.5:1`)
	}
	assert.strictEqual(foregrounds.size, selectors.length, 'two semantic action states have collapsed back to the same foreground color')
})

group('Shipped renderer and stylesheet contracts')

test('all dense renderers emit stable scope, key, and summary hooks', () => {
	for (const scope of ['orders', 'listings', 'earnings', 'shipping']) {
		assert.ok(source.includes(`data-mobile-card-scope="${scope}"`), `${scope} rows lack a disclosure scope`)
		assert.ok(source.includes(`dashboardCardIsOpen('${scope}'`), `${scope} rows do not restore disclosure state`)
	}
	assert.ok(source.includes('data-mobile-card-summary'), 'no summary hit-target hook is emitted')
})

test('Orders keeps operational summary data and defers tall details', () => {
	assert.ok(source.includes('order-mobile-signals'), 'multi-product/note summary signals are missing')
	assert.ok(source.includes('.order-row:not(.is-open) .product-item ~ .product-item'), 'additional products no longer collapse')
	assert.ok(source.includes('.order-row:not(.is-open) .address-lines'), 'full postal address no longer collapses')
	assert.ok(source.includes('.order-row:not(.is-open) .ship-cell > button'), 'fulfilment actions no longer collapse')
	assert.ok(source.includes('.order-row:not(.is-open) .product-title-text'), 'SEO title is consuming collapsed cards again')
})

test('the Orders toolbar matches Shipping/Earnings and keeps tidy clusters', () => {
	// Same language as Shipping / Earnings: bordered panel + labelled controls.
	assert.ok(source.includes('id="ordersFilters"') && source.includes('orders-toolbar'), 'Orders toolbar lost its panel chrome')
	assert.ok(source.includes('class="orders-control'), 'Orders filters are no longer labelled like Shipping/Earnings')
	assert.ok(/#ordersFilters select \{[\s\S]{0,280}?padding:\s*6px 34px 6px 12px;/.test(source), 'selects no longer keep balanced left/right padding for the open option list')
	assert.ok(/\.oft-csel-option \{[\s\S]{0,180}?padding:\s*8px 14px;/.test(source), 'custom filter dropdown options lost equal left/right padding')
	assert.ok(source.includes('const OFT_CSEL'), 'Orders filters no longer use the custom select that can pad the open list')
	assert.ok(/#ordersFilters select \{[\s\S]{0,320}?text-overflow: ellipsis;/.test(source), 'a long selected option is no longer ellipsised')
	assert.ok(/\.oft-group \{[\s\S]{0,140}?flex-wrap: nowrap;/.test(source), 'toolbar clusters can break internally again, so a wrap orphans a single control')
	assert.strictEqual((source.match(/<div class="oft-group">/g) || []).length, 3, 'the toolbar is no longer grouped into its three clusters')

	// Manual orders are built in the Route tab, where their products are chosen.
	// A second entry point here only added width to a bar that had none to spare.
	assert.ok(!source.includes('id="newManualOrderBtn"'), 'the Orders toolbar carries a New manual order button again')
	assert.ok(!source.includes('manual-order-btn'), 'dead styling for the removed manual-order button is back')
	assert.ok(source.includes('openAddOrderModal()'), 'the Route tab lost the Add Order flow that manual orders are created from')
	assert.ok(source.includes('openManualOrderModal(receiptId)'), 'a manual order can no longer be edited to add its buyer and address')

	// Phones start with one current-state summary, then flatten the three desktop
	// groups into a two-column disclosure only when the operator asks for it.
	assert.ok(source.includes('id="ordersFilterToggle"') && source.includes('aria-controls="ordersFilters"'), 'mobile Orders filters lack an accessible disclosure control')
	assert.ok(source.includes('const ORDERS_FILTERS'), 'mobile Orders filter summary/disclosure controller is missing')
	assert.ok(/body\.mode-packer \.orders-toolbar \{\s*display:\s*none !important;/.test(source), 'phone filter disclosure leaks into Packing Mode')
	assert.ok(/#tab-orders \.orders-toolbar\.is-filter-open #ordersFilters \{[\s\S]{0,220}?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/.test(source), 'expanded phone filters no longer use the compact two-column grid')
	assert.ok(/#tab-orders #ordersFilters \.oft-group \{\s*display:\s*contents;/.test(source), 'desktop filter groups are not flattened into the phone grid')
	assert.ok(/#tab-orders #ordersFilters \.orders-control--date \{[\s\S]{0,220}?grid-column:\s*1\s*\/\s*-1;/.test(source), 'the Date control is no longer full-width on phones, so the range crushes')
	assert.ok(/#tab-orders #ordersFilters \.order-search-wrap input/.test(source), 'the phone rule for the lookup input lost the specificity it needs to beat the desktop width')
})

test('mobile chrome keeps one app bar and moves secondary actions into a menu', () => {
	assert.ok(source.includes('id="mobileHeaderMenuBtn"') && source.includes('aria-controls="topbarMenu"'), 'mobile header menu trigger is missing or unlabelled')
	assert.ok(source.includes('const MOBILE_CHROME'), 'mobile header menu controller is missing')
	assert.ok(/@media \(max-width: 768px\)[\s\S]{0,500}?\.topbar \{[\s\S]{0,180}?height:\s*52px;/.test(source), 'phone header is no longer a single compact app bar')
	assert.ok(/\.topbar-right \{[\s\S]{0,180}?position:\s*absolute;/.test(source), 'phone account actions are no longer contained in an anchored menu')
	assert.ok(/\.api-disclaimer \{[\s\S]{0,240}?white-space:\s*nowrap;[\s\S]{0,80}?text-overflow:\s*ellipsis;/.test(source), 'phone disclaimer can grow back into a tall multi-line block')
})

test('the shared control keeps its touch and motion accessibility contract', () => {
	const cssStart = source.indexOf('/* Mobile-only disclosure controls')
	const cssEnd = source.indexOf('/* ── Route Dashboard ("Orders Sorting Dashboard")', cssStart)
	const css = source.slice(cssStart, cssEnd)
	assert.ok(/\.mobile-card-toggle \{[\s\S]{0,360}?width: 44px;[\s\S]{0,40}?height: 44px;/.test(css), 'touch target is no longer 44px')
	assert.ok(/prefers-reduced-motion: reduce[\s\S]*?\.mobile-card-toggle::after \{\s*transition: none;/.test(css), 'reduced motion is not honored')
	assert.ok(/\.mobile-card-toggle,\s*\n\s*\.order-mobile-signals[\s\S]{0,180}?display: none;/.test(css), 'desktop controls are no longer hidden by default')
})

test('Shipping parcel table fits all columns without horizontal scroll', () => {
	assert.ok(source.includes('.ship-table-wrap > table {\n\t\t\t\twidth: 100%;\n\t\t\t\ttable-layout: fixed;'), 'shipping table lacks fixed full-width layout')
	assert.ok(source.includes('.ship-table-wrap {\n\t\t\t\toverflow-x: hidden;'), 'shipping table still allows horizontal scroll')
	assert.ok(source.includes('<col class="ship-col-event" />'), 'shipping table lacks column width hints')
	assert.ok(!source.includes('<th>Claim / note</th>'), 'shipping table still shows claim column')
	assert.ok(!source.includes('<col class="ship-col-action" />'), 'shipping table still shows per-row refresh column')
	assert.ok(source.includes('<col class="ship-col-actions" />'), 'shipping table lacks Actions column for Message buyer')
	assert.ok(source.includes("td[data-label='Shop']") && source.includes('white-space: normal') && source.includes('word-break: break-word'), 'shop/buyer wrap rules missing')
})

test('Listings and Shipping are compact disclosures, not scroll tables', () => {
	assert.ok(source.includes('#tab-listings .listing-card-row:not(.is-open) td:nth-child(n + 3)'), 'Listings details are not collapsed')
	assert.ok(source.includes('#tab-listings .listing-card-row.is-open td:nth-child(n + 3)'), 'Listings details cannot expand')
	assert.ok(source.includes('#tab-shipping .ship-row:not(.is-open) td:not(.ship-primary-cell)'), 'Shipping details are not collapsed')
	assert.ok(source.includes('.ship-mobile-summary'), 'Shipping has no compact summary')
})

test('Overview, Events, Earnings, and Bulk tables expose mobile card labels', () => {
	for (const selector of ['#tab-overview .overview-shop-row', '#tab-events .event-row', '#tab-earnings .earn-compact-row', '#tab-bulk .bulk-hist tbody tr']) {
		assert.ok(source.includes(selector), `${selector} mobile cards are missing`)
	}
	assert.ok(source.includes('content: attr(data-label)'), 'labelled mobile cells are missing')
})

test('every dashboard tab has a scoped mobile treatment', () => {
	for (const tab of ['overview', 'orders', 'listings', 'bulk', 'events', 'shops', 'earnings', 'shipping', 'route']) {
		assert.ok(source.includes(`#tab-${tab}`), `#tab-${tab} has no scoped responsive rules`)
	}
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
