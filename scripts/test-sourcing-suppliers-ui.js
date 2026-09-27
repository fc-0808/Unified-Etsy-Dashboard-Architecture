'use strict'

/**
 * Behavioural tests for the Sourcing Suppliers workspace — the building chooser
 * and the per-stall product drawer.
 *
 * Like the other UI harnesses, this mounts the REAL public/sourcing.html in
 * jsdom and drives the shipped click handlers, so a renamed rail or a filter
 * that only exists in comments fails here rather than on the warehouse floor.
 *
 * Pinned behaviours:
 *   · Buildings are a scrolling option rail, not a <select> parked on the right.
 *   · Choosing Tongxin hides Jingji stalls; All markets brings them back.
 *   · Unlocated stalls are a first-class option, not something you can only
 *     see by clearing a dropdown.
 *   · Opening a stall with both phone cases and AirPods cases gets a type rail.
 *     Filtering to AirPods hides the iPhone cards. All-types groups by type.
 *   · Missing-price items have their own attention chip.
 *
 * Run: `node scripts/test-sourcing-suppliers-ui.js`
 */

const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { JSDOM, VirtualConsole } = require('jsdom')

const catalog = require('../src/sourcing/catalog')
const stallLocation = require('../src/route/stall-location')

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

const HTML = fs.readFileSync(path.resolve(__dirname, '../public/sourcing.html'), 'utf8')
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

function location(stall, shop) {
	const loc = stallLocation.parseStall(stall)
	return {
		located: loc.located,
		registered: loc.registered,
		is_home: loc.isHome,
		building_id: loc.buildingId,
		building_label: loc.buildingLabel,
		building_order: loc.buildingOrder,
		floor: loc.floor,
		code: loc.code,
		raw: loc.raw,
		sort_key: stallLocation.locationSortKey(stall, shop),
	}
}

function product(row) {
	const gaps = row.gaps || (row.cost_case == null ? ['no_price'] : [])
	const costCase = row.cost_case == null ? null : row.cost_case
	const charmCost = row.charm_cost == null ? null : row.charm_cost
	const parts = [costCase, charmCost].filter((v) => v != null)
	return {
		id: row.id,
		title: row.title,
		product_type: row.type,
		product_type_source: 'derived',
		shop_name: row.shop,
		stall: row.stall,
		stall_effective: row.stall,
		stall_source: 'product',
		supplier_key: row.supplier_key,
		location: location(row.stall, row.shop),
		charm_shop: row.charm_shop || '',
		charm_code: row.charm_code || '',
		charm_stall: row.charm_stall || '',
		charm_cost: charmCost,
		has_charm_image: !!row.has_charm_image,
		charm_image_version: row.charm_image_version || '',
		cost_case: costCase,
		cost_grip: null,
		cost_total: parts.length ? Math.round(parts.reduce((a, b) => a + b, 0) * 100) / 100 : null,
		canonical_product_key: '',
		image_url: PIXEL,
		image_approx: false,
		gaps,
		sort_order: row.id,
		updated_at: 0,
	}
}

function groupFor(p) {
	return {
		key: `row:${p.id}`,
		supplier_key: p.supplier_key,
		representative_id: p.id,
		product_ids: [p.id],
		listing_count: 1,
		priced: !(p.gaps || []).includes('no_price'),
		ready: !(p.gaps || []).length,
		cost_total: p.cost_total,
		product_type: p.product_type,
	}
}

function supplier(row) {
	return {
		key: row.key,
		shop_key: String(row.shop).toLowerCase(),
		shop_name: row.shop,
		stall: row.stall,
		mall: '',
		floor: '',
		address: '',
		notes: '',
		location: location(row.stall, row.shop),
		product_count: 0,
		priced_count: 0,
		ready_count: 0,
		cost_total: null,
		by_type: {},
		unique_product_count: 0,
		unique_priced_count: 0,
		unique_ready_count: 0,
		unique_cost_total: null,
		unique_by_type: {},
	}
}

const HAN = supplier({ key: 'han-a2-29', shop: 'HAN', stall: 'A2-29' })
const V8 = supplier({ key: 'v8-a2-21', shop: 'V8', stall: 'A2-21' })
const JINGJI = supplier({ key: 'jj-5d06', shop: 'Jingji Case', stall: '经济5D06' })
const GHOST = supplier({ key: 'ghost', shop: 'Ghost', stall: '' })

const PRODUCTS = [
	product({
		id: 1,
		title: 'Pink Bunny iPhone Case',
		type: 'iphone_case',
		shop: 'HAN',
		stall: 'A2-29',
		supplier_key: HAN.key,
		cost_case: 9,
		charm_code: 'CH-00003',
		charm_shop: '彩虹',
		charm_stall: '2D21',
		charm_cost: 2.5,
		has_charm_image: true,
		charm_image_version: 'test-v1',
	}),
	product({ id: 2, title: 'Yellow AirPods Case', type: 'airpods_case', shop: 'HAN', stall: 'A2-29', supplier_key: HAN.key, cost_case: 10 }),
	product({ id: 3, title: 'Clear iPhone Case missing price', type: 'iphone_case', shop: 'HAN', stall: 'A2-29', supplier_key: HAN.key, cost_case: null }),
	product({ id: 4, title: 'Kuromi AirPods Case', type: 'airpods_case', shop: 'HAN', stall: 'A2-29', supplier_key: HAN.key, cost_case: 8, charm_code: 'CH-00109', charm_shop: 'HAN', charm_stall: 'A2-29' }),
	product({ id: 5, title: 'Jingji Only iPhone Case', type: 'iphone_case', shop: 'Jingji Case', stall: '经济5D06', supplier_key: JINGJI.key, cost_case: 12 }),
]

const CATALOG = {
	ok: true,
	generated_at: 0,
	product_types: catalog.PRODUCT_TYPES,
	gap_types: catalog.GAP_TYPES,
	products: PRODUCTS,
	suppliers: [HAN, V8, JINGJI, GHOST],
	charm_shops: [
		{
			shop_name: '彩虹',
			stall: '2D21',
			notes: '',
			charm_count: 2,
			location: location('2D21', '彩虹'),
		},
		{
			shop_name: '壳引力',
			stall: 'A2-33',
			notes: '',
			charm_count: 0,
			location: location('A2-33', '壳引力'),
		},
	],
	charms: [
		{
			code: 'CH-00003',
			charm_shop: '彩虹',
			charm_stall: '2D21',
			cost: 2.5,
			notes: 'heart bead',
			product_count: 1,
			has_image: true,
			image_version: 'test-v1',
		},
		{
			code: 'CH-00010',
			charm_shop: '彩虹',
			charm_stall: '2D21',
			cost: 3,
			notes: '',
			product_count: 0,
			has_image: false,
			image_version: '',
		},
	],
	supplier_product_groups: PRODUCTS.map(groupFor),
	totals: {
		suppliers: 4,
		buildings: 2,
		products: PRODUCTS.length,
		charm_shops: 2,
		charms: 2,
		by_type: {},
		by_gap: {},
		with_price: 0,
		ready: 0,
	},
}

const META = {
	categories: [],
	statuses: [],
	product_types: catalog.PRODUCT_TYPES,
	gap_types: catalog.GAP_TYPES,
}

function jsonResponse(body) {
	return {
		status: 200,
		ok: true,
		headers: {
			get(name) {
				return String(name).toLowerCase() === 'content-type' ? 'application/json' : null
			},
		},
		json: async () => body,
	}
}

async function waitFor(pred, label, ms = 4000) {
	const start = Date.now()
	while (Date.now() - start < ms) {
		if (pred()) return
		await new Promise((resolve) => setTimeout(resolve, 15))
	}
	throw new Error(`timed out waiting for ${label}`)
}

async function mount() {
	const virtualConsole = new VirtualConsole()
	const errors = []
	virtualConsole.on('jsdomError', (err) => errors.push(err))
	const scriptStart = HTML.lastIndexOf('<script>')
	const scriptEnd = HTML.lastIndexOf('</script>')
	assert.ok(scriptStart >= 0 && scriptEnd > scriptStart, 'sourcing.html has a page script')
	const script = HTML.slice(scriptStart + '<script>'.length, scriptEnd)
	const shell = HTML.slice(0, scriptStart) + HTML.slice(scriptEnd + '</script>'.length)
	const dom = new JSDOM(shell, {
		url: 'http://127.0.0.1/',
		runScripts: 'dangerously',
		pretendToBeVisual: true,
		virtualConsole,
	})
	const { window } = dom
	window.localStorage.setItem('sourcingView', 'suppliers')
	window.EventSource = class {
		close() {}
	}
	window.confirm = () => true
	window.fetch = async (input) => {
		const url = String(input)
		if (url.includes('/api/auth/me')) return jsonResponse({ user: 'tester', authEnabled: false })
		if (url.includes('/api/sourcing/meta')) return jsonResponse(META)
		if (url.includes('/api/sourcing/catalog')) return jsonResponse(CATALOG)
		if (url.includes('/api/sourcing/suppliers')) return jsonResponse({ suppliers: [] })
		return jsonResponse({})
	}
	window.addEventListener('error', (event) => errors.push(event.error || event.message))
	window.eval(script)
	try {
		await waitFor(() => window.document.querySelectorAll('#supArea .srow').length >= 4, 'supplier rows')
	} catch (err) {
		const area = window.document.getElementById('supArea')
		const extra = errors.map((e) => (e && e.stack) || e).join('\n')
		throw new Error(`${err.message}\nsupArea=${area ? area.innerHTML.slice(0, 400) : 'missing'}\njsdom=${extra || '(none)'}`)
	}
	return { window, doc: window.document }
}

function click(window, el) {
	assert.ok(el, 'click target is missing')
	el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
}

function shopNames(doc) {
	return [...doc.querySelectorAll('#supArea .srow .rowlink span')].map((el) => el.textContent.trim())
}

function productTitles(doc) {
	return [...doc.querySelectorAll('#sdBody .prow .title')].map((el) => el.textContent.trim())
}

function railLabels(doc, railId) {
	return [...doc.querySelectorAll(`#${railId} .facet-label`)].map((el) => el.textContent.trim())
}

function selectedRail(doc, railId) {
	return doc.querySelector(`#${railId} .facet.on .facet-label`)?.textContent.trim() || null
}

function typeHeaders(doc) {
	return [...doc.querySelectorAll('#sdBody .sd-type-head .badge')].map((el) => el.textContent.trim())
}

let passed = 0
let failed = 0
const failures = []

async function test(name, fn) {
	try {
		await fn()
		passed++
		console.log(`  ${GREEN}ok${RESET}  — ${name}`)
	} catch (err) {
		failed++
		failures.push({ name, err })
		console.log(`  ${RED}FAIL${RESET} — ${name}`)
		console.log(`         ${err.message}`)
	}
}

;(async () => {
	console.log(`\n${BOLD}Sourcing suppliers UI — building rail + stall drawer${RESET}\n`)

	await test('the market dropdown is gone; a building rail lists every market', async () => {
		const { doc } = await mount()
		assert.equal(doc.getElementById('supBuilding'), null)
		assert.equal(doc.getElementById('supBuildingRow').hidden, false)
		assert.deepEqual(railLabels(doc, 'supBuildingRail'), ['All markets', 'Jingji', 'Tongxin', 'Unlocated'])
		assert.equal(selectedRail(doc, 'supBuildingRail'), 'All markets')
		assert.ok(shopNames(doc).includes('HAN'))
		assert.ok(shopNames(doc).includes('Jingji Case'))
		assert.ok(shopNames(doc).includes('Ghost'))
		assert.deepEqual(
			[...doc.querySelectorAll('#supArea .market-row h3')].map((el) => el.textContent.trim()),
			['Jingji', 'Tongxin', 'Unlocated'],
		)
	})

	await test('every supplier data row spans the same five columns of one table', async () => {
		const { doc } = await mount()
		const rows = [...doc.querySelectorAll('#supArea tr.srow')]
		assert.ok(rows.length >= 4)
		assert.equal(doc.querySelectorAll('#supArea table.supplier-table').length, 1)
		assert.ok(
			rows.every((tr) => tr.cells.length === 5),
			'a wrapped location must not add rows or cells',
		)
		assert.equal(doc.querySelectorAll('#supArea .srow .cellwrap[style]').length, 0)
		assert.ok(rows.every((tr) => !tr.querySelector('.col-mall, .col-address, .col-notes')))
	})

	await test('search and buildings pin in one sticky strip under the chrome', async () => {
		const { window, doc } = await mount()
		const strip = doc.getElementById('supControls')
		assert.ok(strip, 'the sticky controls strip is present')
		assert.ok(strip.contains(doc.getElementById('supSearch')), 'search lives inside the sticky strip')
		assert.ok(strip.contains(doc.getElementById('supBuildingRail')), 'buildings live inside the sticky strip')
		const style = window.getComputedStyle(strip)
		assert.equal(style.position, 'sticky')
		assert.ok(doc.getElementById('viewSuppliers').style.getPropertyValue('--sup-controls-h'), 'table headers know the strip height')
	})

	await test('buildings keep a colour swatch and a walking-order section header', async () => {
		const { window, doc } = await mount()
		assert.ok(doc.querySelector('#supBuildingRail [data-val="jingji"] .facet-swatch.b-jingji'), 'Jingji chip is colour-coded')
		assert.ok(doc.querySelector('#supBuildingRail [data-val="tongxin"] .facet-swatch.b-tongxin'), 'Tongxin chip is colour-coded')
		assert.equal(doc.querySelector('#supBuildingRail [data-val=""] .facet-swatch'), null, 'All markets is not a place and has no swatch')
		const jingji = doc.querySelector('#supArea .market-row[data-building="jingji"]')
		assert.ok(jingji, 'Jingji rows sit under a tagged market band')
		assert.equal(jingji.querySelector('h3')?.textContent.trim(), 'Jingji')
		assert.match(jingji.textContent, /1\s+shop/)
		const table = doc.querySelector('#supArea table.supplier-table')
		assert.ok(table.classList.contains('has-markets'))
		assert.equal(window.getComputedStyle(table.querySelector('thead th')).position, 'static', 'column labels do not pin through a building')
		assert.equal(window.getComputedStyle(jingji.querySelector('td')).position, 'static', 'market bands stay in flow so they cannot cover a shop')
		const bodyRows = [...doc.querySelectorAll('#supArea tbody tr')]
		const jingjiAt = bodyRows.indexOf(jingji)
		assert.ok(jingjiAt >= 0)
		assert.equal(bodyRows[jingjiAt + 1].querySelector('.rowlink span')?.textContent.trim(), 'Jingji Case', 'the first Jingji shop sits under its band, never above it')
		assert.equal(doc.querySelector('#supArea .srow[data-building="jingji"] .rowlink span')?.textContent.trim(), 'Jingji Case')
		assert.ok(doc.querySelector('#supArea .srow[data-building="tongxin"] .stall-code'), 'stall codes render as a compact locator chip')
	})

	await test('a single-market filter keeps a banner and drops the in-table group header', async () => {
		const { window, doc } = await mount()
		click(window, doc.querySelector('#supBuildingRail [data-val="tongxin"]'))
		assert.equal(doc.querySelector('#supArea .market-row'), null)
		const banner = doc.querySelector('#supArea .building-banner')
		assert.ok(banner, 'the filtered market is still named above the list')
		assert.equal(banner.getAttribute('data-building'), 'tongxin')
		assert.match(banner.textContent, /Tongxin/)
		assert.equal(doc.querySelector('#supArea table.supplier-table').classList.contains('has-markets'), false)
	})

	await test('the supplier search placeholder follows the page language', async () => {
		const { window, doc } = await mount()
		assert.match(doc.getElementById('supSearch').placeholder, /shop, stall/i)
		click(window, doc.querySelector('.lang-switch [data-lang="zh"]'))
		assert.match(doc.getElementById('supSearch').placeholder, /店名/)
		assert.deepEqual(
			[...doc.querySelectorAll('#supArea .market-row h3')].map((el) => el.textContent.trim()),
			['经济', '通信', '未定位'],
		)
	})

	await test('choosing Tongxin hides every other building and drops the redundant group header', async () => {
		const { window, doc } = await mount()
		click(window, doc.querySelector('#supBuildingRail [data-val="tongxin"]'))
		assert.equal(selectedRail(doc, 'supBuildingRail'), 'Tongxin')
		assert.deepEqual(shopNames(doc).sort(), ['HAN', 'V8'])
		assert.equal(doc.querySelector('#supArea .market-row'), null)
		assert.equal(window.localStorage.getItem('sourcingSupBuilding'), 'tongxin')
	})

	await test('Unlocated is a chooser option, not something you can only reach by clearing a dropdown', async () => {
		const { window, doc } = await mount()
		click(window, doc.querySelector('#supBuildingRail [data-val="##unlocated##"]'))
		assert.deepEqual(shopNames(doc), ['Ghost'])
		click(window, doc.querySelector('#supBuildingRail [data-val=""]'))
		assert.ok(shopNames(doc).includes('HAN'))
		assert.ok(shopNames(doc).includes('Ghost'))
	})

	await test('opening HAN offers type and attention rails, and All-types groups the mixed catalog', async () => {
		const { window, doc } = await mount()
		const han = [...doc.querySelectorAll('#supArea .rowlink')].find((el) => el.textContent.includes('HAN'))
		click(window, han)
		assert.equal(doc.getElementById('sdShop').textContent, 'HAN')
		assert.equal(doc.getElementById('sdFacets').hidden, false)
		assert.equal(doc.getElementById('sdTypeRow').hidden, false)
		assert.ok(railLabels(doc, 'sdTypeRail').includes('iPhone Case'))
		assert.ok(railLabels(doc, 'sdTypeRail').includes('AirPods Case'))
		assert.deepEqual(typeHeaders(doc), ['iPhone Case', 'AirPods Case'])
		assert.equal(productTitles(doc).length, 4)
		assert.ok(doc.getElementById('sdGapRow').hidden === false)
		assert.ok(railLabels(doc, 'sdGapRail').includes('No price'))
	})

	await test('the type rail isolates AirPods cases from phone cases', async () => {
		const { window, doc } = await mount()
		click(window, [...doc.querySelectorAll('#supArea .rowlink')].find((el) => el.textContent.includes('HAN')))
		click(window, doc.querySelector('#sdTypeRail [data-val="airpods_case"]'))
		assert.equal(selectedRail(doc, 'sdTypeRail'), 'AirPods Case')
		assert.deepEqual(productTitles(doc).sort(), ['Kuromi AirPods Case', 'Yellow AirPods Case'])
		assert.equal(doc.querySelector('#sdBody .sd-type-group'), null, 'a single type does not repeat a section header')
		assert.ok(doc.querySelector('#sdBody .badge.t-airpods_case'), 'the type badge stays on the card when it is the filter')
		click(window, doc.querySelector('#sdTypeRail [data-val="iphone_case"]'))
		assert.deepEqual(productTitles(doc).sort(), ['Clear iPhone Case missing price', 'Pink Bunny iPhone Case'])
	})

	await test('the attention rail isolates products missing a price', async () => {
		const { window, doc } = await mount()
		click(window, [...doc.querySelectorAll('#supArea .rowlink')].find((el) => el.textContent.includes('HAN')))
		click(window, doc.querySelector('#sdGapRail [data-val="no_price"]'))
		assert.deepEqual(productTitles(doc), ['Clear iPhone Case missing price'])
		click(window, doc.querySelector('#sdTypeRail [data-val="airpods_case"]'))
		assert.equal(productTitles(doc).length, 0, 'AirPods at this stall are priced, so the two filters compose')
		assert.match(doc.getElementById('sdBody').textContent, /No products here match your filters/)
	})

	await test('opening a different stall resets the previous type filter', async () => {
		const { window, doc } = await mount()
		click(window, [...doc.querySelectorAll('#supArea .rowlink')].find((el) => el.textContent.includes('HAN')))
		click(window, doc.querySelector('#sdTypeRail [data-val="airpods_case"]'))
		click(window, doc.getElementById('sdClose'))
		click(window, [...doc.querySelectorAll('#supArea .rowlink')].find((el) => el.textContent.includes('HAN')))
		assert.equal(selectedRail(doc, 'sdTypeRail'), 'All types')
		assert.equal(productTitles(doc).length, 4)
	})

	await test('a charm from another stall is marked Separate stall with shop and booth', async () => {
		const { window, doc } = await mount()
		click(window, [...doc.querySelectorAll('#supArea .rowlink')].find((el) => el.textContent.includes('HAN')))
		const line = doc.querySelector('#sdBody .charm-line.elsewhere')
		assert.ok(line, 'off-shop charms get a distinct callout')
		assert.equal(line.tagName, 'A')
		assert.match(line.textContent, /Separate stall/)
		assert.match(line.textContent, /CH-00003/)
		assert.match(line.textContent, /彩虹/)
		assert.match(line.textContent, /2D21/)
		assert.match(line.textContent, /Edit in Route/)
		assert.ok(line.querySelector('.ctrail'), 'shop · stall live in a dedicated trail')
		assert.ok(line.querySelector('.cflag'), 'the stall flag is its own chip')
		assert.equal(line.querySelector('.cflag').textContent, 'Separate stall')
		const style = window.getComputedStyle(line)
		assert.equal(style.flexWrap, 'wrap', 'identity wraps instead of clipping')
		assert.equal(style.overflow, 'visible', 'the stall flag is never clipped')
		assert.match(line.getAttribute('href'), /tab=route/)
		assert.match(line.getAttribute('href'), /view=charms/)
		assert.match(line.getAttribute('href'), /charm=CH-00003/)
		assert.equal(line.getAttribute('data-act'), 'route-charm')
		assert.equal(doc.querySelectorAll('#sdBody .charm-line.elsewhere').length, 1)
		assert.equal(doc.querySelectorAll('#sdBody .prow').length, 4)
		const media = doc.querySelector('#sdBody .prow .charm-line.elsewhere')?.closest('.prow')?.querySelector('.pmedia')
		assert.ok(media, 'drawer rows with a charm use a media stack')
		assert.equal(media.querySelectorAll('.pthumb').length, 2, 'case photo + charm photo')
		assert.ok(media.querySelector('a.pthumb.charm'), 'charm thumb is a Route-catalog control')
		assert.equal(window.getComputedStyle(media.querySelector('.pthumb:not(.charm)')).width, '96px')
		assert.ok(media.querySelector('.pthumb.charm img.charm-img, .pthumb.charm .charm-ph'))
	})

	await test('a same-stall charm keeps the At this stall flag fully visible', async () => {
		const { window, doc } = await mount()
		click(window, [...doc.querySelectorAll('#supArea .rowlink')].find((el) => el.textContent.includes('HAN')))
		const line = [...doc.querySelectorAll('#sdBody .charm-line')].find((el) => el.textContent.includes('CH-00109'))
		assert.ok(line, 'same-stall charms still get an identity chip')
		assert.equal(line.classList.contains('elsewhere'), false)
		assert.equal(line.querySelector('.cflag').textContent, 'At this stall')
		assert.match(line.textContent, /Edit in Route/)
		assert.equal(window.getComputedStyle(line.querySelector('.cflag')).flexShrink, '0')
	})

	await test('clicking a charm chip opens the Route catalog in a dedicated window', async () => {
		const { window, doc } = await mount()
		const opened = []
		window.open = (url, name) => {
			opened.push({ url: String(url), name: String(name) })
			return { closed: false }
		}
		click(window, [...doc.querySelectorAll('#supArea .rowlink')].find((el) => el.textContent.includes('HAN')))
		click(window, doc.querySelector('#sdBody .charm-line.elsewhere'))
		assert.equal(opened.length, 1)
		assert.equal(opened[0].name, 'ued-route-charms')
		assert.match(opened[0].url, /tab=route/)
		assert.match(opened[0].url, /charm=CH-00003/)
		assert.equal(doc.getElementById('supDrawer').classList.contains('open'), true, 'sourcing stays on the stall')
	})

	await test('supplier directory rows stay one line tall even with long mall/notes text', async () => {
		const { window, doc } = await mount()
		const rows = [...doc.querySelectorAll('#supArea tr.srow')]
		assert.ok(rows.length >= 4)
		for (const tr of rows) {
			assert.equal(window.getComputedStyle(tr).height, '44px')
		}
		for (const wrap of doc.querySelectorAll('#supArea .cellwrap')) {
			assert.equal(window.getComputedStyle(wrap).whiteSpace, 'nowrap')
		}
		assert.ok(
			[...doc.querySelectorAll('#supArea tr.srow td')].every((td) => window.getComputedStyle(td).whiteSpace === 'nowrap'),
			'every directory cell refuses to wrap',
		)
	})

	await test('charm shops share the supplier column geometry so Stall and Location line up', async () => {
		const { window, doc } = await mount()
		const supplierTable = doc.querySelector('#supArea table.supplier-table')
		const charmTable = doc.querySelector('#cshopArea table.supplier-table')
		assert.ok(supplierTable, 'suppliers use the shared directory table')
		assert.ok(charmTable, 'charm shops use the same shared directory table')
		const supplierCols = [...supplierTable.querySelectorAll('colgroup col')].map((c) => c.className)
		const charmCols = [...charmTable.querySelectorAll('colgroup col')].map((c) => c.className)
		const shared = ['shop', 'stall', 'location', 'products', 'actions']
		assert.deepEqual(supplierCols, shared)
		assert.deepEqual(charmCols, shared, 'charm shops use the same five-column grid as cases')
		const supplierRow = supplierTable.querySelector('tr.srow')
		const charmRow = charmTable.querySelector('tr.srow')
		assert.equal(supplierRow.cells.length, 5)
		assert.equal(charmRow.cells.length, 5)
		assert.match(charmTable.textContent, /壳引力/)
		assert.match(charmTable.textContent, /A2-33/)
		assert.ok(charmRow.querySelector('.countcell'), 'charm counts use the same count grid as products')
		assert.equal(charmRow.querySelectorAll('.cov.empty').length, 1, 'the coverage slot is reserved so the number shares the product count x-position')
		assert.ok(supplierRow.querySelector('.countcell'), 'suppliers still use the priced-coverage count cell')
		assert.equal(charmRow.querySelectorAll('.col-mall, .col-address, .col-notes').length, 0)
		assert.equal(supplierRow.querySelectorAll('.col-mall, .col-address, .col-notes').length, 0)
		assert.equal(
			window.getComputedStyle(charmTable.querySelector('thead th')).position,
			'static',
			'charm-shop column labels must not pin over the shops',
		)
		assert.equal(
			window.getComputedStyle(doc.getElementById('cshopArea')).overflow,
			'visible',
			'charm shops scroll with the page, not inside a nested pane',
		)
		assert.equal(window.getComputedStyle(doc.getElementById('cshopArea')).overflowY, 'visible')
		const rainbow = [...charmTable.querySelectorAll('tr.srow')].find((tr) => tr.textContent.includes('彩虹'))
		assert.ok(rainbow, '彩虹 is the first charm shop')
		assert.equal(rainbow, charmTable.querySelector('tbody tr.srow'), '彩虹 is the first data row')
		const count = rainbow.querySelector('td.num .n')
		assert.ok(count, '彩虹 has a Charms count cell')
		assert.equal(count.textContent.trim(), '2')
		assert.equal(count.classList.contains('zero'), false)
		const countStyle = window.getComputedStyle(count)
		assert.notEqual(countStyle.visibility, 'hidden')
		assert.notEqual(countStyle.display, 'none')
		assert.notEqual(countStyle.opacity, '0')
		assert.equal(window.getComputedStyle(rainbow.querySelector('td.num')).overflow, 'visible')
		const cell = rainbow.querySelector('.countcell')
		assert.equal(window.getComputedStyle(cell).display, 'grid')
		assert.equal(window.getComputedStyle(cell).gridTemplateColumns, '4ch 62px')
		const empty = [...charmTable.querySelectorAll('tr.srow')].find((tr) => tr.textContent.includes('壳引力'))
		assert.equal(empty.querySelector('td.num .n').textContent.trim(), '0', 'the next shop must not inherit 彩虹’s count')
		assert.equal(empty.querySelector('td.num .n').classList.contains('zero'), true)
	})

	await test('clicking a charm shop opens a drawer of that stall’s charms and photos', async () => {
		const { window, doc } = await mount()
		const rainbow = [...doc.querySelectorAll('#cshopArea tr.srow')].find((tr) => tr.textContent.includes('彩虹'))
		assert.ok(rainbow, '彩虹 is in the charm-shop directory')
		assert.ok(rainbow.querySelector('[data-act="cshop-open"]'), 'the shop name is a real open control')
		click(window, rainbow)
		assert.equal(doc.getElementById('cshopDrawer').classList.contains('open'), true)
		assert.equal(doc.getElementById('cshopDrawerBg').classList.contains('open'), true)
		assert.equal(doc.getElementById('csdShop').textContent, '彩虹')
		assert.match(doc.getElementById('csdLoc').textContent, /2D21|通信/)
		const cards = [...doc.querySelectorAll('#csdBody .ccard')]
		assert.equal(cards.length, 2)
		const codes = cards.map((el) => el.getAttribute('data-charm-code')).sort()
		assert.deepEqual(codes, ['CH-00003', 'CH-00010'])
		const photo = doc.querySelector('#csdBody .ccard[data-charm-code="CH-00003"] img.charm-img')
		assert.ok(photo, 'a charm with a file shows its thumbnail')
		assert.equal(photo.getAttribute('src'), '/api/route/charm-image?code=CH-00003&v=test-v1')
		assert.equal(window.getComputedStyle(photo).objectFit, 'contain', 'the whole charm stays in frame, never cover-cropped')
		assert.match(doc.querySelector('#csdBody .ccard[data-charm-code="CH-00010"] .charm-ph').textContent, /No photo|无照片/)
		const linked = doc.querySelector('#csdBody .ccard[data-charm-code="CH-00003"]')
		assert.equal(linked.tagName, 'A')
		assert.match(linked.getAttribute('href'), /tab=route/)
		assert.match(linked.getAttribute('href'), /charm=CH-00003/)
		assert.match(linked.textContent, /Edit in Route/)
		assert.equal(doc.getElementById('supDrawer').classList.contains('open'), false)
	})

	await test('the charm-shop drawer search filters codes without leaving the stall', async () => {
		const { window, doc } = await mount()
		const rainbow = [...doc.querySelectorAll('#cshopArea tr.srow')].find((tr) => tr.textContent.includes('彩虹'))
		click(window, rainbow)
		const search = doc.getElementById('csdSearch')
		search.value = 'CH-00010'
		search.dispatchEvent(new window.Event('input', { bubbles: true }))
		await waitFor(() => doc.querySelectorAll('#csdBody .ccard').length === 1, 'search to leave one charm')
		assert.equal(doc.querySelector('#csdBody .ccard').getAttribute('data-charm-code'), 'CH-00010')
		assert.equal(doc.getElementById('cshopDrawer').classList.contains('open'), true)
	})

	await test('a charm shop with no library codes still opens, with an empty state', async () => {
		const { window, doc } = await mount()
		const empty = [...doc.querySelectorAll('#cshopArea tr.srow')].find((tr) => tr.textContent.includes('壳引力'))
		click(window, empty)
		assert.equal(doc.getElementById('csdShop').textContent, '壳引力')
		assert.equal(doc.querySelectorAll('#csdBody .ccard').length, 0)
		assert.match(doc.getElementById('csdBody').textContent, /No charms mapped|尚未登记挂件/)
	})

	await test('edit on a charm shop does not open the drawer', async () => {
		const { window, doc } = await mount()
		const edit = doc.querySelector('#cshopArea [data-act="cshop-edit"]')
		assert.ok(edit, 'edit control exists when the catalog is writable')
		click(window, edit)
		assert.equal(doc.getElementById('cshopDrawer').classList.contains('open'), false)
		assert.equal(doc.getElementById('cshopModal').classList.contains('open'), true)
	})

	await test('the suppliers strip has a camera control that locates the stall from a photo', async () => {
		const { window, doc } = await mount()
		assert.ok(doc.getElementById('supFindPhoto'), 'Find shop from photo lives on the directory strip')
		assert.ok(doc.getElementById('supControls').contains(doc.getElementById('supFindPhoto')))
		const origFetch = window.fetch
		window.fetch = async (input, init = {}) => {
			if (String(input).includes('/api/sourcing/find-by-photo')) {
				return jsonResponse({
					matches: [
						{
							catalog_id: 1,
							shop_name: 'HAN',
							stall: 'A2-29',
							title: 'Pink Bunny iPhone Case',
							confidence: 'exact',
							location: HAN.location,
							image_url: PIXEL,
						},
					],
				})
			}
			return origFetch(input, init)
		}
		assert.equal(typeof window.File, 'function', 'jsdom File is available')
		const file = new window.File([Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])], 'case.jpg', { type: 'image/jpeg' })
		const input = doc.getElementById('catFindPhotoFile')
		Object.defineProperty(input, 'files', {
			configurable: true,
			value: [file],
		})
		input.dispatchEvent(new window.Event('change', { bubbles: true }))
		try {
			await waitFor(
				() =>
					doc.querySelector('#supArea tr.srow.is-photo-hit') &&
					doc.getElementById('sdShop').textContent === 'HAN' &&
					doc.querySelector('#sdBody .prow.is-photo-hit'),
				'exact photo match opens HAN and scrolls to the product',
			)
		} catch (err) {
			const modal = doc.getElementById('findPhotoBody')
			throw new Error(
				`${err.message}\nmodal=${modal ? modal.textContent.trim() : 'missing'}\ndrawer=${doc.getElementById('sdShop').textContent}\nhit=${!!doc.querySelector('#supArea tr.srow.is-photo-hit')}\nproduct=${doc.querySelector('#sdBody .prow.is-photo-hit') && doc.querySelector('#sdBody .prow.is-photo-hit').textContent}`,
			)
		}
		assert.equal(doc.querySelector('#supArea tr.srow.is-photo-hit .rowlink span')?.textContent.trim(), 'HAN')
		assert.match(doc.querySelector('#sdBody .prow.is-photo-hit .title').textContent, /Pink Bunny/)
		assert.equal(doc.querySelector('#sdBody .prow.is-photo-hit').getAttribute('data-product-id'), '1')
		assert.equal(selectedRail(doc, 'supBuildingRail'), 'Tongxin')
		assert.equal(doc.getElementById('viewSuppliers').hidden, false)
		assert.equal(doc.getElementById('viewCatalog').hidden, true)
	})

	await test('possible photo matches hydrate the catalog thumbnail and do not auto-open a stall', async () => {
		const { window, doc } = await mount()
		const origFetch = window.fetch
		window.fetch = async (input, init = {}) => {
			if (String(input).includes('/api/sourcing/find-by-photo')) {
				return jsonResponse({
					matches: [
						{
							catalog_id: 1,
							shop_name: 'HAN',
							stall: 'A2-29',
							title: 'Pink Bunny iPhone Case',
							confidence: 'possible',
							match_kind: 'vision',
							location: HAN.location,
							image_url: '',
						},
					],
					query: { subject: 'Polka Dots' },
				})
			}
			return origFetch(input, init)
		}
		const file = new window.File([Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])], 'case.jpg', { type: 'image/jpeg' })
		const input = doc.getElementById('catFindPhotoFile')
		Object.defineProperty(input, 'files', {
			configurable: true,
			value: [file],
		})
		input.dispatchEvent(new window.Event('change', { bubbles: true }))
		await waitFor(() => doc.querySelector('#findPhotoBody .find-hit img'), 'hydrated photo hit thumbnail')
		const img = doc.querySelector('#findPhotoBody .find-hit img')
		assert.equal(img.getAttribute('src'), PIXEL)
		assert.equal(doc.getElementById('findPhotoModal').classList.contains('open'), true)
		assert.equal(doc.querySelector('#sdBody .prow.is-photo-hit'), null)
	})

	await test('employees can select duplicate cards and POST a product-map merge', async () => {
		const { window, doc } = await mount()
		const mergeCalls = []
		const origFetch = window.fetch
		window.fetch = async (input, init = {}) => {
			const url = String(input)
			if (url.includes('/api/route/product-map/merge')) {
				mergeCalls.push(JSON.parse(init.body || '{}'))
				return jsonResponse({ ok: true, product_ids: [1, 3], canonical_product_key: 'manual:pm-1', listing_ids: [], edges_inserted: 0 })
			}
			return origFetch(input, init)
		}
		click(window, [...doc.querySelectorAll('#supArea .rowlink')].find((el) => el.textContent.includes('HAN')))
		const start = [...doc.querySelectorAll('#sdActions [data-act]')].find((el) => el.dataset.act === 'sd-merge-start')
		assert.ok(start, 'Mark duplicates is available when route:merges is held')
		click(window, start)
		assert.equal(doc.getElementById('sdMergeBar').classList.contains('open'), true)
		assert.equal(doc.querySelectorAll('#sdBody .prow.mergeable').length, 4)
		click(window, doc.querySelectorAll('#sdBody .prow.mergeable')[0])
		click(window, doc.querySelectorAll('#sdBody .prow.mergeable')[1])
		assert.equal(doc.querySelectorAll('#sdBody .prow.merge-sel').length, 2)
		assert.equal(doc.getElementById('sdMergeConfirm').disabled, false)
		click(window, doc.getElementById('sdMergeConfirm'))
		await waitFor(() => mergeCalls.length === 1 && !doc.getElementById('sdMergeBar').classList.contains('open'), 'merge POST and exit selection')
		assert.ok(mergeCalls[0].product_ids.length >= 2)
	})

	await test('directory and product CRUD are labeled, and missing the button does not open the stall', async () => {
		const { window, doc } = await mount()
		const han = [...doc.querySelectorAll('#supArea tr.srow')].find((tr) => tr.textContent.includes('HAN'))
		assert.ok(han, 'HAN is in the directory')
		const edit = han.querySelector('[data-act="stall-edit"]')
		const del = han.querySelector('[data-act="stall-del"]')
		assert.ok(edit && del, 'the row still has edit and delete')
		assert.match(edit.textContent, /Edit|编辑/)
		assert.match(del.textContent, /Delete|删除/)
		assert.equal(han.querySelectorAll('td').length, 5, 'the five-column table is intact')
		assert.equal(han.querySelector('td.act').getAttribute('data-act'), 'stop')
		click(window, han.querySelector('td.act'))
		assert.equal(doc.getElementById('supDrawer').classList.contains('open'), false, 'a miss on the CRUD footer does not open the stall')
		click(window, han.querySelector('.rowlink'))
		assert.equal(doc.getElementById('supDrawer').classList.contains('open'), true)
		const bunny = [...doc.querySelectorAll('#sdBody .prow')].find((el) => el.textContent.includes('Pink Bunny iPhone Case'))
		assert.ok(bunny, 'Pink Bunny is in the HAN drawer')
		assert.match(bunny.querySelector('[data-act="product-edit"]').textContent, /Edit|编辑/)
		assert.match(bunny.querySelector('[data-act="product-del"]').textContent, /Delete|删除/)
		click(window, han.querySelector('td.act [data-act="stall-edit"]'))
		assert.equal(doc.getElementById('stallModal').classList.contains('open'), true)
	})

	await test('the product editor lets the operator change the catalog name', async () => {
		const { window, doc } = await mount()
		const puts = []
		const inner = window.fetch
		window.fetch = async (input, init = {}) => {
			if (String(input).includes('/api/route/product-map') && String(init.method || '').toUpperCase() === 'PUT') {
				puts.push(JSON.parse(init.body))
				return jsonResponse({ ok: true, rows: [] })
			}
			return inner(input, init)
		}
		click(window, [...doc.querySelectorAll('#supArea .rowlink')].find((el) => el.textContent.includes('HAN')))
		const bunnyRow = [...doc.querySelectorAll('#sdBody .prow')].find((el) => el.textContent.includes('Pink Bunny iPhone Case'))
		assert.ok(bunnyRow, 'Pink Bunny is in the HAN drawer')
		click(window, bunnyRow.querySelector('[data-act="product-edit"]'))
		const titleInput = doc.getElementById('prTitle')
		assert.equal(titleInput.readOnly, false, 'the name field is editable on an existing product')
		assert.equal(titleInput.value, 'Pink Bunny iPhone Case')
		assert.match(doc.getElementById('prTitleHint').textContent, /rename|修改/i)
		titleInput.value = 'Pink Bunny iPhone Case (warehouse name)'
		click(window, doc.getElementById('prSave'))
		await waitFor(() => puts.length === 1, 'product rename PUT')
		assert.equal(puts[0].id, 1)
		assert.equal(puts[0].title, 'Pink Bunny iPhone Case (warehouse name)')
	})

	if (failures.length) {
		console.log(`\n${RED}${BOLD}Failures${RESET}`)
		for (const f of failures) console.log(`\n  ${RED}${f.name}${RESET}\n  ${DIM}${f.err.stack}${RESET}`)
	}
	console.log(`\n${passed} passed, ${failed} failed\n`)
	process.exit(failed ? 1 : 0)
})().catch((err) => {
	console.error(err)
	process.exit(1)
})
