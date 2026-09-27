'use strict'

/**
 * Behavioural contract for Add Order → From product catalog.
 *
 * The picker must classify shops the same way Product Catalog does:
 * a market select, a supplier select, then cards grouped by walking order. The test
 * mounts the shipped modal markup and the shipped grouping/render functions
 * against jsdom, so a renamed chooser or a flat ungrouped grid fails here rather
 * than on the warehouse floor.
 *
 * Run: `node scripts/test-add-order-catalog-ui.js`
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

const MODAL_HTML = slice('<div id="addOrderModal"', '<!-- ── Product Catalog modal', 'Add Order modal markup')
const locationSource = slice('// ══ STALL LOCATION ══', '// ══ END STALL LOCATION ══', 'stall-location helpers')
const catalogSource = slice('// ══ ADD ORDER CATALOG ══', '// ══ END ADD ORDER CATALOG ══', 'add-order catalog sentinels')
const helpers = [
	'toDisplayString',
	'escHtml',
	'escAttr',
	'jsAttr',
	'_productSupplierKey',
	'_productSupplierGroups',
	'_productBuildingGroups',
	'_productMarketName',
	'_productSupplierLabel',
	'_productBuildingLabel',
]
	.map(extractFn)
	.join('\n')

const PRODUCTS = [
	{
		title: 'Tongxin Rabbit Case',
		shop_name: 'Rabbit Lab',
		stall: 'A2-18',
		image_url: 'https://example.test/rabbit.png',
		phone_models: ['iPhone 16'],
		styles: ['Case Only'],
	},
	{
		title: 'Jingji Star Case',
		shop_name: 'Star Lab',
		stall: '经济5D10',
		image_url: 'https://example.test/star.png',
		phone_models: [],
		styles: [],
	},
	{
		title: 'Jingji Star Mirror',
		shop_name: 'Star Lab',
		stall: '经济5D16',
		image_url: 'https://example.test/star-b.png',
		phone_models: [],
		styles: [],
	},
	{
		title: 'Wave Wrap Case',
		shop_name: 'Wave Lab',
		stall: '经济5D08',
		alias_titles: ['alias search target'],
		image_url: 'https://example.test/wave.png',
		phone_models: ['iPhone 15', 'iPhone 16'],
		styles: ['Case+Charm'],
	},
	{
		title: '<img src=x onerror=alert(1)>',
		shop_name: '',
		stall: '',
		image_url: 'https://example.test/unset.png',
		phone_models: [],
		styles: [],
	},
]

function makeEnv(products = PRODUCTS) {
	const dom = new JSDOM(`<!doctype html><body>${MODAL_HTML}</body>`, {
		runScripts: 'dangerously',
		url: 'https://dashboard.test/',
	})
	const { window } = dom
	window.eval(`
		const I18N = { get: () => 'en', t: (s) => s }
		let _aoProducts = ${JSON.stringify(products)}
		let _aoBuildingFilter = ''
		let _aoSupplierFilter = ''
		function _aoCartQtyForProduct() { return 0 }
		${locationSource}
		${helpers}
		${catalogSource}
		window.__renderAo = () => renderAoProducts()
		window.setAoBuilding = setAoBuilding
		window.setAoSupplier = setAoSupplier
		window.renderAoProducts = renderAoProducts
		window.__setQuery = (q) => { document.getElementById('aoProductSearch').value = q; renderAoProducts() }
		window.__setBuilding = (id) => setAoBuilding(id)
		window.__setSupplier = (key) => setAoSupplier(key)
		window.__buildingFilter = () => _aoBuildingFilter
		window.__supplierFilter = () => _aoSupplierFilter
		window.__filtered = () => document.getElementById('aoProductGrid')._aoFiltered || []
	`)
	window.__renderAo()
	return { window, document: window.document }
}

function optionLabels(document, id) {
	return [...document.getElementById(id).options].map((option) => option.textContent.replace(/ \(\d+\)$/, ''))
}

function optionCounts(document, id) {
	return [...document.getElementById(id).options].map((option) => option.getAttribute('data-count'))
}

function selectedOption(document, id) {
	const select = document.getElementById(id)
	const option = select?.options[select.selectedIndex]
	return option ? option.textContent.replace(/ \(\d+\)$/, '') : ''
}

function optionValueByLabel(document, id, label) {
	return [...document.getElementById(id).options].find((option) => option.textContent.replace(/ \(\d+\)$/, '') === label)?.value
}

let passed = 0
function test(name, fn) {
	fn()
	passed++
	console.log(`  ok  — ${name}`)
}

console.log('\nAdd Order catalog shop classification\n')

test('the shipped modal keeps the market and supplier choosers', () => {
	assert.match(MODAL_HTML, /id="aoBuildingSelect"/)
	assert.match(MODAL_HTML, /id="aoSupplierSelect"/)
	assert.match(MODAL_HTML, /id="aoCatalogMeta"/)
	assert.match(MODAL_HTML, /class="ao-filter-select"/)
	assert.match(source, /class="ao-shop-grid"/)
	assert.match(source, /\.ao-filter-select \{/)
	assert.doesNotMatch(source, /ao-facet-rail/)
})

test('cards are grouped by walking-order market, then supplier', () => {
	const { document } = makeEnv()
	const buildings = [...document.querySelectorAll('#aoProductGrid .ao-building')]
	assert.strictEqual(buildings.length, 3)
	assert.deepStrictEqual(
		buildings.map((el) => el.querySelector('.ao-building-name').textContent),
		['Jingji', 'Tongxin', 'Location not set'],
	)
	assert.deepStrictEqual(
		buildings.map((el) => el.getAttribute('data-building')),
		['jingji', 'tongxin', '__unlocated__'],
	)
	const jingjiShops = [...buildings[0].querySelectorAll('.ao-shop-name')].map((el) => el.textContent)
	assert.deepStrictEqual(jingjiShops, ['Wave Lab', 'Star Lab', 'Star Lab'])
	assert.strictEqual(document.querySelectorAll('#aoProductGrid .ao-product-card').length, 5)
	assert.match(document.getElementById('aoCatalogMeta').textContent, /5 products · 5 suppliers · 3 markets/)
})

test('market chooser classifies like Product Catalog and has no swatch on All markets', () => {
	const { document } = makeEnv()
	assert.strictEqual(document.getElementById('aoBuildingRow').hidden, false)
	assert.strictEqual(document.getElementById('aoFilterBar').hidden, false)
	assert.deepStrictEqual(optionLabels(document, 'aoBuildingSelect'), ['All markets', 'Jingji', 'Tongxin', 'Location not set'])
	assert.deepStrictEqual(optionCounts(document, 'aoBuildingSelect'), ['5', '3', '1', '1'])
	assert.strictEqual(selectedOption(document, 'aoBuildingSelect'), 'All markets')
	assert.strictEqual(document.getElementById('aoBuildingSwatch').hidden, true, 'All markets is not a place and must not carry a swatch')
	assert.strictEqual(document.getElementById('aoBuildingRow').hasAttribute('data-building'), false)
	assert.strictEqual(document.getElementById('aoBuildingSelect').querySelector('option[value="jingji"]').getAttribute('data-tone'), 'b-jingji')
})

test('supplier chooser appears after a market is chosen, and same shop at two stalls keeps the stall', () => {
	const { window, document } = makeEnv()
	assert.strictEqual(document.getElementById('aoSupplierRow').hidden, true, 'All markets must not dump every shop into the chooser')
	window.__setBuilding('jingji')
	assert.strictEqual(document.getElementById('aoSupplierRow').hidden, false)
	assert.deepStrictEqual(optionLabels(document, 'aoSupplierSelect'), [
		'All suppliers',
		'Wave Lab · 经济5D08',
		'Star Lab · 经济5D10',
		'Star Lab · 经济5D16',
	])
	assert.deepStrictEqual(optionCounts(document, 'aoSupplierSelect'), ['3', '1', '1', '1'])
	assert.strictEqual(document.getElementById('aoBuildingSwatch').hidden, false)
	assert.strictEqual(document.getElementById('aoBuildingRow').getAttribute('data-building'), 'jingji')
})

test('choosing Jingji hides Tongxin and drops the redundant market headers', () => {
	const { window, document } = makeEnv()
	window.__setBuilding('jingji')
	assert.strictEqual(selectedOption(document, 'aoBuildingSelect'), 'Jingji')
	assert.strictEqual(document.querySelectorAll('#aoProductGrid .ao-building').length, 0)
	assert.ok(document.getElementById('aoProductGrid').classList.contains('is-building-filtered'))
	assert.deepStrictEqual(
		[...document.querySelectorAll('#aoProductGrid .ao-shop-name')].map((el) => el.textContent),
		['Wave Lab', 'Star Lab', 'Star Lab'],
	)
	assert.strictEqual(document.querySelectorAll('#aoProductGrid .ao-product-card').length, 3)
	assert.deepStrictEqual(optionLabels(document, 'aoSupplierSelect'), ['All suppliers', 'Wave Lab · 经济5D08', 'Star Lab · 经济5D10', 'Star Lab · 经济5D16'])
	assert.match(document.getElementById('aoCatalogMeta').textContent, /3 products · 3 suppliers/)
	assert.doesNotMatch(document.getElementById('aoCatalogMeta').textContent, /markets/)
})

test('a true supplier filter keeps one booth after a market is chosen', () => {
	const { window, document } = makeEnv()
	window.__setBuilding('jingji')
	const waveKey = optionValueByLabel(document, 'aoSupplierSelect', 'Wave Lab · 经济5D08')
	assert.ok(waveKey)
	window.__setSupplier(waveKey)
	assert.strictEqual(document.querySelectorAll('#aoProductGrid .ao-product-card').length, 1)
	assert.strictEqual(document.querySelector('.ao-product-title').textContent, 'Wave Wrap Case')
	assert.strictEqual(selectedOption(document, 'aoSupplierSelect'), 'Wave Lab · 经济5D08')
	assert.deepStrictEqual(optionCounts(document, 'aoBuildingSelect'), ['5', '3', '1', '1'])
})

test('search matches a listing alias and a market name, and the choosers recount', () => {
	const { window, document } = makeEnv()
	window.__setQuery('alias search target')
	assert.strictEqual(document.querySelectorAll('#aoProductGrid .ao-product-card').length, 1)
	assert.strictEqual(document.querySelector('.ao-shop-name').textContent, 'Wave Lab')
	assert.deepStrictEqual(optionCounts(document, 'aoBuildingSelect'), ['1', '1', '0', '0'])

	window.__setQuery('jingji')
	assert.strictEqual(document.querySelectorAll('#aoProductGrid .ao-product-card').length, 3)
	assert.deepStrictEqual(optionCounts(document, 'aoBuildingSelect'), ['3', '3', '0', '0'])

	window.__setQuery('经济')
	assert.strictEqual(document.querySelectorAll('#aoProductGrid .ao-product-card').length, 3)
})

test('switching market prunes a supplier that does not belong there', () => {
	const { window, document } = makeEnv()
	window.__setBuilding('jingji')
	const waveKey = optionValueByLabel(document, 'aoSupplierSelect', 'Wave Lab · 经济5D08')
	assert.ok(waveKey)
	window.__setSupplier(waveKey)
	assert.strictEqual(window.__filtered().length, 1)
	window.__setBuilding('tongxin')
	assert.strictEqual(window.__supplierFilter(), '')
	assert.strictEqual(document.getElementById('aoSupplierRow').hidden, true, 'Tongxin has one shop — no supplier chooser')
	assert.strictEqual(document.querySelectorAll('#aoProductGrid .ao-product-card').length, 1)
	assert.strictEqual(document.querySelector('.ao-shop-name').textContent, 'Rabbit Lab')
	window.__setBuilding('')
	assert.strictEqual(document.getElementById('aoSupplierRow').hidden, true)
	assert.strictEqual(document.querySelectorAll('#aoProductGrid .ao-product-card').length, 5)
})

test('shop identity lives on the section header, not on every card, and hostile titles stay text', () => {
	const { document } = makeEnv()
	assert.strictEqual(document.querySelectorAll('#aoProductGrid .ao-product-meta').length, 0)
	assert.ok([...document.querySelectorAll('.ao-shop-stall')].some((el) => el.textContent === '经济5D10'))
	assert.strictEqual(document.querySelectorAll('#aoProductGrid img[src="x"]').length, 0)
	assert.match(document.getElementById('aoProductGrid').textContent, /<img src=x onerror=alert\(1\)>/)
})

test('a single-market catalog hides the market chooser instead of showing one option', () => {
	const { document } = makeEnv(PRODUCTS.filter((product) => product.stall.startsWith('经济')))
	assert.strictEqual(document.getElementById('aoBuildingRow').hidden, true)
	assert.strictEqual(document.querySelectorAll('#aoProductGrid .ao-building').length, 0)
	assert.ok(document.getElementById('aoProductGrid').classList.contains('is-building-filtered'))
	assert.strictEqual(document.getElementById('aoSupplierRow').hidden, false)
	assert.strictEqual(document.getElementById('aoFilterBar').hidden, false)
})

test('the shop grid keeps the card-collapse guards the order panel depends on', () => {
	const scroller = source.slice(source.indexOf('.ao-product-grid {'), source.indexOf('.ao-building-head,'))
	assert.match(scroller, /flex: 1 1 auto;/)
	assert.match(scroller, /min-height: 0;/)
	assert.match(scroller, /max-height: 48vh;/)
	assert.match(scroller, /gap: 0;/)
	assert.match(scroller, /padding: 0;/)
	const cards = source.slice(source.indexOf('.ao-shop-grid {'), source.indexOf('.b-other,'))
	assert.match(cards, /grid-auto-rows: max-content;/)
	assert.match(cards, /align-content: start;/)
	assert.match(source, /\.ao-filter\[hidden\] \{\s*display: none !important;/)
	assert.match(source, /\.ao-catalog-tools \{[\s\S]*position: sticky;/)
	assert.match(source, /\.ao-product-grid > \.ao-shop > \.ao-shop-head \{\s*top: 0;/)
})

console.log(`\nAll ${passed} add-order catalog UI assertions passed.\n`)
