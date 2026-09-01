'use strict'

/**
 * Behavioural contract for the two active product browsers in public/index.html:
 * Route Product Catalog and Orders → Switch to a new design.
 *
 * The test evaluates the shipped grouping/render functions against jsdom. It
 * pins supplier sections, walking order, true supplier filters, jump controls,
 * canonical alias collapse and selection identity.
 */

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { JSDOM } = require('jsdom')

const source = fs
	.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8')
	.replace(/\r\n/g, '\n')

function slice(startMarker, endMarker, what) {
	const start = source.indexOf(startMarker)
	const end = source.indexOf(endMarker, start + startMarker.length)
	if (start < 0 || end <= start) throw new Error(`Could not extract ${what}`)
	return source.slice(start, end)
}

function extractFn(name) {
	const head = `\t\t\tfunction ${name}(`
	const start = source.indexOf(head)
	const end = source.indexOf('\n\t\t\t}\n', start)
	if (start < 0 || end < 0) throw new Error(`Could not extract ${name}()`)
	return source.slice(start, end + 5)
}

const pmMarkup = slice('<div id="pmModal"', '<!-- ── Charm picker modal', 'Product Catalog markup')
const locationSource = slice('// ══ STALL LOCATION ══', '// ══ END STALL LOCATION ══', 'stall-location helpers')
const helpers = [
	'toDisplayString',
	'escHtml',
	'escAttr',
	'jsAttr',
	'_pmSortBySupplier',
	'_productSupplierKey',
	'_productSupplierGroups',
	'_productBuildingGroups',
	'_productMarketName',
	'_productSupplierLabel',
	'_productBuildingLabel',
	'_renderProductSupplierFilter',
	'_pmPhysicalProducts',
	'_pmGroupHeadHtml',
	'_pmBuildingHeadHtml',
	'_renderPmJumpRail',
	'onPmJumpChange',
	'jumpToPmGroup',
	'_syncPmJumpSpy',
	'_onPmTableScroll',
	'renderPmTable',
	'_activeCharmSection',
	'_switchSelectionFromProduct',
	'_switchSelectionKey',
	'_switchGroupHeadHtml',
	'_renderSwitchJumpRail',
	'onSwitchJumpChange',
	'jumpToSwitchGroup',
	'_syncSwitchJumpSpy',
	'_onSwitchGridScroll',
	'renderSwitchGrid',
].map(extractFn).join('\n')

const rows = [
	{
		id: 1,
		title: 'Tongxin Rabbit Case',
		shop_name: 'Rabbit Lab',
		stall: 'A2-18',
		charm_code: 'CH-00018',
		image_url: 'https://example.test/rabbit-a.png',
		canonical_product_key: 'P-RABBIT',
		sort_order: 2,
	},
	{
		id: 2,
		title: 'Rabbit Alias Search Target',
		shop_name: 'Rabbit Lab',
		stall: 'A2-18',
		charm_code: 'CH-00018',
		image_url: 'https://example.test/rabbit-b.png',
		canonical_product_key: 'P-RABBIT',
		sort_order: 3,
	},
	{
		id: 3,
		title: 'Jingji Star Case',
		shop_name: 'Star Lab',
		stall: '经济5D10',
		image_url: 'https://example.test/star.png',
		sort_order: 1,
	},
	{
		id: 4,
		title: '<img src=x onerror=alert(1)>',
		shop_name: '',
		stall: '',
		image_url: 'https://example.test/unset.png',
		sort_order: 4,
	},
]

function makeEnv() {
	const switchMarkup = `
		<input id="switchSearch">
		<select id="switchSupplierFilter"><option value="">All suppliers</option></select>
		<select id="switchSort"><option value="route">Route order</option><option value="supplier">Supplier A-Z</option></select>
		<div id="switchJump" style="display:none"><select id="switchJumpSelect"></select></div>
		<div id="switchResultCount"></div>
		<div id="switchGrid"></div>
	`
	const dom = new JSDOM(`<!doctype html><body>${pmMarkup}${switchMarkup}</body>`, {
		runScripts: 'dangerously',
		url: 'https://dashboard.test/',
	})
	const { window } = dom
	window.requestAnimationFrame = (fn) => {
		fn()
		return 1
	}
	window.eval(`
		const I18N = { get: () => 'en' }
		let _pmRows = []
		let _pmJumpLock = null
		let _pmJumpTimer = null
		let _pmSpyTick = 0
		let _switchProducts = []
		let _switchSel = null
		let _switchJumpLock = null
		let _switchJumpTimer = null
		let _switchSpyTick = 0
		${locationSource}
		${helpers}
		window.__setPmRows = (rows) => { _pmRows = rows }
		window.__renderPm = () => {
			_renderProductSupplierFilter('pmSupplierFilter', _pmPhysicalProducts(_pmRows), 'All suppliers')
			renderPmTable()
		}
		window.__setSwitchProducts = (products) => {
			_switchProducts = products
			_renderProductSupplierFilter('switchSupplierFilter', products, 'All suppliers')
		}
		window.__setSwitchSelection = (product) => { _switchSel = product }
		window.__renderSwitch = () => renderSwitchGrid()
		window.__jumpPm = (index) => jumpToPmGroup(index)
		window.__jumpSwitch = (index) => jumpToSwitchGroup(index)
	`)
	window.__setPmRows(rows)
	window.__renderPm()
	return { window, document: window.document }
}

let passed = 0
function test(name, fn) {
	fn()
	passed++
	console.log(`  ok  — ${name}`)
}

console.log('\nProduct Catalog and Design Switch browsers\n')

test('Product Catalog collapses aliases and groups them by building, then supplier', () => {
	const { document } = makeEnv()
	const buildings = [...document.querySelectorAll('#pmTableBody .pm-building-row')]
	const sections = [...document.querySelectorAll('#pmTableBody .pm-group-row')]
	assert.strictEqual(buildings.length, 3)
	assert.deepStrictEqual(
		buildings.map((row) => row.querySelector('.pm-building-name').textContent),
		['Jingji', 'Tongxin', 'Location not set'],
	)
	assert.strictEqual(sections.length, 3)
	assert.strictEqual(sections[0].querySelector('.pm-group-shop').textContent, 'Star Lab')
	assert.strictEqual(sections[1].querySelector('.pm-group-shop').textContent, 'Rabbit Lab')
	assert.strictEqual(sections[2].querySelector('.pm-group-shop').textContent, 'No supplier set')
	assert.strictEqual(document.querySelectorAll('#pmTableBody .pm-product-row').length, 3)
	assert.match(document.getElementById('pmCount').textContent, /3 physical products · 4 listing entries/)
})

test('searching an alias keeps its canonical physical-product card', () => {
	const { window, document } = makeEnv()
	document.getElementById('pmSearch').value = 'alias search target'
	window.__renderPm()
	assert.strictEqual(document.querySelectorAll('#pmTableBody .pm-product-row').length, 1)
	assert.strictEqual(document.querySelector('.pm-group-shop').textContent, 'Rabbit Lab')
	assert.match(document.querySelector('.pm-aliases').textContent, /Rabbit Alias Search Target/)
})

test('supplier filter stays precise while jump destinations are building sections', () => {
	const { window, document } = makeEnv()
	const filter = document.getElementById('pmSupplierFilter')
	assert.deepStrictEqual([...filter.options].map((option) => option.textContent), [
		'All suppliers',
		'Star Lab · 经济5D10 (1)',
		'Rabbit Lab · A2-18 (1)',
		'No supplier set (1)',
	])
	assert.deepStrictEqual(
		[...document.getElementById('pmJumpSelect').options].map((option) => option.textContent),
		['Jingji (1)', 'Tongxin (1)', 'Location not set (1)'],
	)
	filter.value = [...filter.options].find((option) => option.textContent.startsWith('Rabbit Lab')).value
	window.__renderPm()
	assert.strictEqual(document.querySelectorAll('#pmTableBody .pm-group-row').length, 1)
	assert.strictEqual(document.querySelectorAll('#pmTableBody .pm-building-row').length, 1)
	assert.strictEqual(document.getElementById('pmJump').style.display, 'none')
	filter.value = [...filter.options].find((option) => option.textContent.startsWith('No supplier set')).value
	window.__renderPm()
	assert.strictEqual(document.querySelectorAll('#pmTableBody .pm-product-row').length, 1)
	assert.strictEqual(document.querySelector('.pm-group-shop').textContent, 'No supplier set')
})

test('canonical products remain explicitly discontinuable and hostile titles are escaped', () => {
	const { document } = makeEnv()
	const rabbitRow = [...document.querySelectorAll('.pm-product-row')].find((row) =>
		row.textContent.includes('Tongxin Rabbit Case'),
	)
	assert.ok(rabbitRow.querySelector('.pm-btn-icon.danger'))
	assert.strictEqual(document.querySelectorAll('#pmTableBody img[src="x"]').length, 0)
	assert.match(document.getElementById('pmTableBody').textContent, /<img src=x onerror=alert\(1\)>/)
})

test('catalog workflows ship as labelled modal dialogs with keyboard controls', () => {
	assert.match(pmMarkup, /role="dialog" aria-modal="true" aria-labelledby="pmModalTitle"/)
	assert.match(
		source,
		/class="modal-box switch-modal-box" role="dialog" aria-modal="true" aria-labelledby="switchModalTitle"/,
	)
	assert.match(
		source,
		/class="add-order-card add-order-card-wide" role="dialog" aria-modal="true" aria-labelledby="addOrderModalTitle"/,
	)
	assert.match(
		source,
		/class="ao-config-card" role="dialog" aria-modal="true" aria-labelledby="aoConfigTitle"/,
	)
	assert.match(source, /if \(document\.getElementById\('switchModal'\)\?\.classList\.contains\('open'\)\)/)
	assert.match(source, /if \(document\.getElementById\('pmModal'\)\?\.style\.display === 'flex'\)/)
})

test('desktop Design Switch is wide and hides nested scrollbars without truncating cards', () => {
	assert.match(source, /#switchModal \.switch-modal-box\s*\{[\s\S]*?max-width:\s*1560px/)
	assert.match(source, /#switchModal \.switch-modal-box\s*\{[\s\S]*?height:\s*min\(94dvh,\s*1040px\)/)
	assert.match(source, /\.modal-box\s*\{[\s\S]*?width:\s*480px/)
	assert.match(source, /#switchModalBody\s*\{[\s\S]*?overflow:\s*hidden/)
	assert.match(source, /\.switch-grid\s*\{[\s\S]*?overflow-x:\s*hidden/)
	assert.match(source, /\.switch-grid::-webkit-scrollbar\s*\{\s*display:\s*none/)
})

test('Design Switch uses the same supplier sections and walking order', () => {
	const { window, document } = makeEnv()
	const products = window
		.eval('_pmPhysicalProducts(' + JSON.stringify(rows) + ')')
		.map((product) => ({
			...product,
			key: product.canonical_product_key ? `C:${product.canonical_product_key}` : `P:${product.id}`,
			catalog_id: product.id,
			listing_count: product._aliases.length,
			alias_titles: product._aliases.map((alias) => alias.title),
			phone_models: [],
			styles: [],
		}))
	window.__setSwitchProducts(products)
	window.__renderSwitch()
	const sections = [...document.querySelectorAll('#switchGrid .switch-group')]
	assert.strictEqual(sections.length, 3)
	assert.deepStrictEqual(
		sections.map((section) => section.querySelector('.switch-group-shop').textContent),
		['Star Lab', 'Rabbit Lab', 'No supplier set'],
	)
	assert.strictEqual(document.querySelectorAll('#switchGrid .switch-card').length, 3)
	assert.strictEqual(document.getElementById('switchJumpSelect').options.length, 3)
})

test('Design Switch filters by supplier and highlights by durable product key', () => {
	const { window, document } = makeEnv()
	const products = [
		{ key: 'P:1', catalog_id: 1, title: 'One', shop_name: 'Alpha', stall: 'A2-1', image_url: 'a', phone_models: [], styles: [] },
		{ key: 'P:2', catalog_id: 2, title: 'Two', shop_name: 'Beta', stall: 'A2-2', image_url: 'b', phone_models: [], styles: [] },
	]
	window.__setSwitchProducts(products)
	window.__setSwitchSelection({ key: 'P:2', title: 'A title can change' })
	const filter = document.getElementById('switchSupplierFilter')
	filter.value = [...filter.options].find((option) => option.textContent.startsWith('Beta')).value
	window.__renderSwitch()
	assert.strictEqual(document.querySelectorAll('#switchGrid .switch-card').length, 1)
	assert.strictEqual(document.querySelectorAll('#switchGrid .switch-card.sel').length, 1)
	assert.strictEqual(document.querySelector('.switch-card-title').textContent, 'Two')
	assert.match(document.getElementById('switchResultCount').textContent, /1 active product · 1 supplier section/)
})

test('both jump controls scroll to the selected supplier section', () => {
	const { window, document } = makeEnv()
	const pmRows = [...document.querySelectorAll('#pmTableBody .pm-building-row')]
	pmRows[1].getBoundingClientRect = () => ({ top: 240 })
	document.getElementById('pmTableWrap').getBoundingClientRect = () => ({ top: 0 })
	const pmScrolls = []
	document.getElementById('pmTableWrap').scrollTo = (options) => pmScrolls.push(options)
	window.__jumpPm(1)
	assert.strictEqual(pmScrolls[0].top, 206)

	const products = [
		{ key: 'P:1', title: 'One', shop_name: 'Alpha', stall: 'A2-1', image_url: 'a', phone_models: [], styles: [] },
		{ key: 'P:2', title: 'Two', shop_name: 'Beta', stall: 'A2-2', image_url: 'b', phone_models: [], styles: [] },
	]
	window.__setSwitchProducts(products)
	window.__renderSwitch()
	const switchSections = [...document.querySelectorAll('#switchGrid .switch-group')]
	switchSections[1].getBoundingClientRect = () => ({ top: 320 })
	document.getElementById('switchGrid').getBoundingClientRect = () => ({ top: 0 })
	const switchScrolls = []
	document.getElementById('switchGrid').scrollTo = (options) => switchScrolls.push(options)
	window.__jumpSwitch(1)
	assert.strictEqual(switchScrolls[0].top, 320)
})

console.log(`\nAll ${passed} product-browser UI assertions passed.\n`)
