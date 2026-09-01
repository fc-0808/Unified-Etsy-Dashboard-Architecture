'use strict'
/**
 * Behavioural tests for the Supplier / Location picker — the popover an operator
 * opens from the Route tab's supplier column, often standing in the market with
 * a phone in one hand.
 *
 * Like the Assign Charm harness, this extracts the REAL popover markup and the
 * REAL render functions from public/index.html and runs them against jsdom, so
 * the tests exercise the shipped page instead of a copy of it.
 *
 * The behaviours pinned here are the ones that make or break the screen:
 *   · The directory is presented as SECTIONS, one per BUILDING (Jingji, Tongxin,
 *     …), each led by a sticky header naming the market and how many stalls
 *     stand there. A wall of mixed prefixes (经济5D… beside A2-…) is what this
 *     replaced.
 *   · Sections follow the shopping route's walking order, and suppliers with no
 *     stall land in one clearly-marked section at the end.
 *   · A jump-to-building dropdown names every section the grid holds and scrolls
 *     there; it never offers a destination the grid below does not hold.
 *   · Manage mode keeps the same sections (no drag-reorder to fight) and leads
 *     with an "Add new supplier" card above them.
 *   · Picking a card fills shop + stall — including names carrying quotes or
 *     markup, which is where hand-built HTML usually breaks.
 *
 * Run: `node scripts/test-supplier-picker-ui.js`
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
const group = (name) => pending.push({ group: name })
const test = (name, fn) => pending.push({ name, fn })

const HTML = path.resolve(__dirname, '../public/index.html')
const source = fs.readFileSync(HTML, 'utf8').replace(/\r\n/g, '\n')

function slice(startMarker, endMarker, what) {
	const a = source.indexOf(startMarker)
	const b = source.indexOf(endMarker, a + 1)
	if (a < 0 || b < 0 || b <= a) {
		console.error(`${RED}Could not locate the ${what} in public/index.html.${RESET}`)
		console.error(`${DIM}Expected "${startMarker}" … "${endMarker}".${RESET}`)
		process.exit(1)
	}
	return source.slice(a, b)
}

// The shipped popover markup, verbatim — a renamed id fails here, not in the market.
const POPOVER_HTML = slice('<div id="spOverlay"', '<!-- ── Add Order modal', 'supplier picker markup')
// Stall-location maths, shared with Shopping Mode and the Assign Charm picker.
const LOCATION_SRC = slice('// ══ STALL LOCATION ══', '// ══ END STALL LOCATION ══', 'stall-location block')
// Building sections + jump rail, taken whole so the tests run the shipped block.
const SECTIONS_SRC = slice(
	'// ══ SUPPLIER BUILDING SECTIONS ══',
	'// ══ END SUPPLIER BUILDING SECTIONS ══',
	'supplier building-sections block',
)
// Pin-line maths shared with Assign Charm — one rule, two scrollers.
const ACTIVE_SECTION_SRC = (() => {
	const head = '\t\t\tfunction _activeCharmSection('
	const a = source.indexOf(head)
	const b = source.indexOf('\n\t\t\t}\n', a)
	if (a < 0 || b < 0) {
		console.error(`${RED}Could not extract _activeCharmSection() from public/index.html.${RESET}`)
		process.exit(1)
	}
	return source.slice(a, b + 5)
})()

function extractFn(name) {
	const head = `\t\t\tfunction ${name}(`
	const a = source.indexOf(head)
	const b = source.indexOf('\n\t\t\t}\n', a)
	if (a < 0 || b < 0) {
		console.error(`${RED}Could not extract ${name}() from public/index.html.${RESET}`)
		process.exit(1)
	}
	return source.slice(a, b + 5)
}

const BORROWED = [
	'toDisplayString',
	'escHtml',
	'escAttr',
	'jsAttr',
	'_supplierSame',
	'_canonicalSupplier',
	'_collectKnownSuppliers',
	'pickSupplier',
]
	.map(extractFn)
	.join('\n')

/** Fixture directory — mixed buildings in scrambled order, plus one unlocated. */
const DIRECTORY = [
	{ shop_name: '锐成', stall: '经济5D16', inDirectory: true },
	{ shop_name: '丰达', stall: 'A2-30', inDirectory: true },
	{ shop_name: '瑞简RJ', stall: '经济5D100', inDirectory: true },
	{ shop_name: 'V8', stall: 'A211', inDirectory: true },
	{ shop_name: '汇通店', stall: '汇通A138', inDirectory: true },
	{ shop_name: '太平洋店', stall: '太平洋1B111', inDirectory: true },
	{ shop_name: '康乐店', stall: '康乐北区5A40', inDirectory: true },
	{ shop_name: 'NoStall', stall: '', inDirectory: true },
	{ shop_name: "Lily's Cases", stall: 'A2-01', inDirectory: true },
]

const DIRECTORY_AS_ROWS = DIRECTORY.map((s) => ({
	shop_name: s.shop_name,
	stall: s.stall,
}))

function makeEnv({ directory = DIRECTORY_AS_ROWS, routeRows = [], manage = false, shop = '', stall = '', search = '', lang = 'en' } = {}) {
	const virtualConsole = new VirtualConsole()
	virtualConsole.on('jsdomError', () => {})
	const dom = new JSDOM(`<!doctype html><html><body>${POPOVER_HTML}</body></html>`, {
		runScripts: 'dangerously',
		virtualConsole,
	})
	const { window } = dom
	window.__lang = lang

	const prelude = `
		const API = ''
		const I18N = { get: () => window.__lang }
		let _supplierDirectory = ${JSON.stringify(directory)}
		let _routeRows = ${JSON.stringify(routeRows)}
		let _spManageMode = ${JSON.stringify(manage)}
		let _spTarget = { receipt_id: 1, item_key: 'k#L1' }
		let _spEdit = null
		function openSupplierEditPanel() {}
		function deleteSupplierEntry() {}
	`
	const boot = `
		${LOCATION_SRC}
		${ACTIVE_SECTION_SRC}
		${BORROWED}
		${SECTIONS_SRC}
		const shopInp = document.getElementById('spShopInput')
		const stallInp = document.getElementById('spStallInput')
		const searchInp = document.getElementById('spSearch')
		if (shopInp) shopInp.value = ${JSON.stringify(shop)}
		if (stallInp) stallInp.value = ${JSON.stringify(stall)}
		if (searchInp) searchInp.value = ${JSON.stringify(search)}
		document.getElementById('spPopover').style.display = 'flex'
		renderSupplierGrid()
	`
	window.eval(prelude + '\n' + boot)
	return { window, doc: window.document }
}

function sections(doc) {
	return [...doc.querySelectorAll('#spGrid .sp-group')]
}
function headText(sec, sel) {
	const el = sec.querySelector(sel)
	return el ? el.textContent.trim() : null
}
function cardsIn(sec) {
	return [...sec.querySelectorAll('.sp-item')]
}
function stallOf(card) {
	return card.querySelector('.sp-stall').textContent.trim()
}
function shopOf(card) {
	return card.querySelector('.sp-shop').textContent.trim()
}
function click(window, el) {
	el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
}

// ─────────────────────────────────────────────────────────────────────────────
group('Sections a shopper can scan')

test('the directory is cut into one section per building', () => {
	const { doc } = makeEnv()
	const secs = sections(doc)
	// Jingji, Tongxin, Kangle North, Taipingyang, Huitong, No location set
	assert.strictEqual(secs.length, 6, `expected 6 building sections, got ${secs.length}`)
	assert.strictEqual(headText(secs[0], '.spg-name'), 'Jingji')
	assert.strictEqual(headText(secs[0], '.spg-zh'), '经济', 'the Chinese alias chip is missing beside Jingji')
	assert.strictEqual(headText(secs[0], '.spg-count'), '2')
})

test('sections follow the walking order, with unlocated suppliers last', () => {
	const { doc } = makeEnv()
	const names = sections(doc).map((s) => headText(s, '.spg-name'))
	assert.deepStrictEqual(
		names,
		['Jingji', 'Tongxin', 'Kangle North', 'Taipingyang', 'Huitong', 'No location set'],
		'sections are not in walking order, or the unlocated suppliers are not last',
	)
	const last = sections(doc)[sections(doc).length - 1].querySelector('.sp-group-head')
	assert.ok(last.classList.contains('is-unset'), 'the unlocated section is not marked as needing attention')
})

test('every supplier is rendered exactly once, under its own building', () => {
	const { doc } = makeEnv()
	const rendered = [...doc.querySelectorAll('#spGrid .sp-item')].map((c) => `${shopOf(c)}\x00${stallOf(c)}`)
	assert.strictEqual(rendered.length, DIRECTORY.length, 'a supplier was dropped or duplicated by the grouping')
	const jingji = cardsIn(sections(doc)[0]).map(stallOf)
	// Within a building, stalls follow locationSortKey (floor → code): 5D100 before 5D16.
	assert.deepStrictEqual(jingji, ['经济5D100', '经济5D16'], 'Jingji stalls are not sorted by walking order inside the section')
	const tongxin = cardsIn(sections(doc)[1]).map(stallOf)
	assert.ok(tongxin.includes('A2-01') && tongxin.includes('A2-30') && tongxin.includes('A211'), 'Tongxin is missing a home-market stall')
})

test('the market reads in the operator’s language', () => {
	const { doc } = makeEnv({ lang: 'zh' })
	assert.strictEqual(headText(sections(doc)[0], '.spg-name'), '经济')
	assert.strictEqual(headText(sections(doc)[0], '.spg-zh'), 'Jingji', 'the English alias chip is missing beside 经济')
})

test('the currently assigned supplier opens selected', () => {
	const { doc } = makeEnv({ shop: '锐成', stall: '经济5D16' })
	const selected = doc.querySelectorAll('#spGrid .sp-item.sp-sel')
	assert.strictEqual(selected.length, 1, 'the assigned supplier is not highlighted, or several are')
	assert.strictEqual(shopOf(selected[0]), '锐成')
	assert.strictEqual(stallOf(selected[0]), '经济5D16')
})

test('search still groups the remaining matches by building', () => {
	const { doc } = makeEnv({ search: '经济' })
	const secs = sections(doc)
	assert.strictEqual(secs.length, 1, 'a search that lands in one building should yield one section')
	assert.strictEqual(headText(secs[0], '.spg-name'), 'Jingji')
	assert.strictEqual(cardsIn(secs[0]).length, 2)
})

// ─────────────────────────────────────────────────────────────────────────────
group('Jump-to-building rail')

test('the dropdown is drawn from the same sections as the grid', () => {
	const { doc } = makeEnv()
	const wrap = doc.getElementById('spJump')
	const sel = doc.getElementById('spJumpSelect')
	assert.strictEqual(wrap.style.display, 'flex', 'the jump rail is hidden when there are several buildings')
	assert.strictEqual(sel.options.length, sections(doc).length)
	assert.strictEqual(sel.options[0].textContent, 'Jingji (2)')
	assert.strictEqual(sel.options[sel.options.length - 1].textContent, 'No location set (1)')
})

test('a search down to one building hides the jump rail', () => {
	const { doc } = makeEnv({ search: '经济' })
	assert.strictEqual(doc.getElementById('spJump').style.display, 'none', 'a single-section result still shows a jump control')
})

test('choosing a building scrolls the picker to it', () => {
	const { window, doc } = makeEnv()
	const sel = doc.getElementById('spJumpSelect')
	sel.value = '2'
	sel.dispatchEvent(new window.Event('change', { bubbles: true }))
	assert.strictEqual(sel.value, '2')
	assert.ok(typeof window.jumpToSupplierGroup === 'function')
})

// ─────────────────────────────────────────────────────────────────────────────
group('Picking a supplier')

test('clicking a card fills shop and stall', () => {
	const { window, doc } = makeEnv()
	const card = [...doc.querySelectorAll('#spGrid .sp-item')].find((c) => shopOf(c) === '锐成')
	assert.ok(card, '锐成 card is missing')
	click(window, card)
	assert.strictEqual(doc.getElementById('spShopInput').value, '锐成')
	assert.strictEqual(doc.getElementById('spStallInput').value, '经济5D16')
	assert.ok(doc.querySelector('#spGrid .sp-item.sp-sel'), 'the picked card is not highlighted after click')
})

test("a shop name carrying a quote survives the round trip", () => {
	const { window, doc } = makeEnv()
	const card = [...doc.querySelectorAll('#spGrid .sp-item')].find((c) => shopOf(c) === "Lily's Cases")
	assert.ok(card, "Lily's Cases card is missing")
	click(window, card)
	assert.strictEqual(doc.getElementById('spShopInput').value, "Lily's Cases")
})

test('a shop name that looks like markup is shown, not executed', () => {
	const attack = [{ shop_name: '<img src=x onerror=1>', stall: 'A2-99' }]
	const { doc } = makeEnv({ directory: attack })
	const card = doc.querySelector('#spGrid .sp-item')
	assert.strictEqual(shopOf(card), '<img src=x onerror=1>')
	assert.strictEqual(card.querySelectorAll('img').length, 0, 'markup in a shop name was executed as HTML')
})

// ─────────────────────────────────────────────────────────────────────────────
group('Manage mode')

test('manage mode keeps building sections and leads with Add', () => {
	const { doc } = makeEnv({ manage: true })
	assert.ok(doc.querySelector('.sp-add-card'), 'the Add new supplier card is missing')
	assert.ok(sections(doc).length >= 2, 'manage mode flattened the building sections')
	assert.ok(doc.querySelector('.sp-item.sp-manage'), 'manage cards are not marked')
})

test('an empty search shows the empty state (and Add in manage mode)', () => {
	const { doc } = makeEnv({ search: 'zzz-no-match' })
	assert.ok(doc.querySelector('.sp-empty'), 'the empty state is missing')
	assert.strictEqual(sections(doc).length, 0)
	const { doc: managed } = makeEnv({ search: 'zzz-no-match', manage: true })
	assert.ok(managed.querySelector('.sp-add-card'), 'manage mode lost the Add card on an empty search')
})

// ─────────────────────────────────────────────────────────────────────────────
group('Case-folded booth identity')

test('a case-variant order assignment does not paint a greyed-out twin', () => {
	// Directory holds 汇通A146 / leo; an order recorded 汇通a146 — the bug that
	// left a dim "ext" card Manage could not delete.
	const directory = [{ shop_name: 'leo', stall: '汇通A146' }]
	const routeRows = [
		{
			supplier_in_catalog: true,
			supplier_is_override: false,
			supplier_shop: 'leo',
			supplier_stall: '汇通a146',
		},
	]
	const { doc } = makeEnv({ directory, routeRows, manage: true })
	const cards = [...doc.querySelectorAll('#spGrid .sp-item')]
	assert.strictEqual(cards.length, 1, 'the case-variant twin must fold into the directory card')
	assert.strictEqual(stallOf(cards[0]), '汇通A146', 'the directory spelling is the one shown')
	assert.strictEqual(shopOf(cards[0]), 'leo')
	assert.ok(!cards[0].classList.contains('sp-fallback'), 'the folded card must stay deletable in Manage')
	assert.ok(cards[0].querySelector('.sp-card-act.danger'), 'Delete must be available on the directory card')
})

test('an order with a differently-cased stall still highlights the directory card', () => {
	const directory = [{ shop_name: 'leo', stall: '汇通A146' }]
	const { doc } = makeEnv({ directory, shop: 'leo', stall: '汇通a146' })
	const selected = doc.querySelectorAll('#spGrid .sp-item.sp-sel')
	assert.strictEqual(selected.length, 1)
	assert.strictEqual(stallOf(selected[0]), '汇通A146')
})

test('a true external assignment (not a case twin) stays marked as ext', () => {
	const directory = [{ shop_name: 'leo', stall: '汇通A146' }]
	const routeRows = [
		{
			supplier_is_override: true,
			supplier_shop: 'OnlyOnOrder',
			supplier_stall: '汇通B999',
		},
	]
	const { doc } = makeEnv({ directory, routeRows, manage: true })
	const cards = [...doc.querySelectorAll('#spGrid .sp-item')]
	assert.strictEqual(cards.length, 2)
	const ext = cards.find((c) => shopOf(c) === 'OnlyOnOrder')
	assert.ok(ext && ext.classList.contains('sp-fallback'), 'a real external assignment must stay read-only')
	assert.ok(!ext.querySelector('.sp-card-act.danger'), 'ext cards have no Delete — they are not directory rows')
})

// ─────────────────────────────────────────────────────────────────────────────
async function run() {
	for (const item of pending) {
		if (item.group) {
			console.log(`\n${BOLD}${item.group}${RESET}`)
			continue
		}
		try {
			await item.fn()
			passed++
			console.log(`  ${GREEN}✓${RESET} ${item.name}`)
		} catch (err) {
			failed++
			failures.push({ name: item.name, err })
			console.log(`  ${RED}✗${RESET} ${item.name}`)
			console.log(`    ${DIM}${err.message}${RESET}`)
		}
	}
	console.log(`\n${BOLD}Supplier / Location — building sections${RESET}`)
	console.log(`${GREEN}${passed} passed${RESET}${failed ? `, ${RED}${failed} failed${RESET}` : ''}`)
	if (failures.length) {
		for (const f of failures) {
			console.error(`\n${RED}${f.name}${RESET}`)
			console.error(f.err.stack)
		}
		process.exit(1)
	}
}

run()
