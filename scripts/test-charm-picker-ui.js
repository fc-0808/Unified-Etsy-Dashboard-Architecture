'use strict'
/**
 * Behavioural tests for the Assign Charm picker — the sub-menu an operator opens
 * from the Route tab, often standing in the market with a phone in one hand.
 *
 * Like the other UI harnesses, this extracts the REAL modal markup and the REAL
 * render functions from public/index.html and runs them against jsdom, so the
 * tests exercise the shipped page instead of a copy of it.
 *
 * The behaviours pinned here are the ones that make or break the screen:
 *   · The library is presented as SECTIONS, one per charm shop · stall, each led
 *     by a header naming the shop, its stall, its market · floor and how many
 *     charms stand there. A wall of CH-codes is what this replaced.
 *   · Sections follow the shopping route's walking order, and charms with no
 *     supplier land in one clearly-marked section at the end — visible enough to
 *     be fixed, never mixed in with located stock.
 *   · A pick card shows the photo and the code, full stop: it never repeats the
 *     shop its section header already states, and carries no label beside it.
 *   · Picking a charm assigns THAT charm's code and shop — including shop names
 *     carrying quotes or markup, which is where hand-built HTML usually breaks.
 *   · A dropdown above the grid names every supplier in the picker and jumps to
 *     the one chosen, then selects whichever section the operator scrolls into.
 *     It never offers a destination the grid below does not hold.
 *   · Manage-charms mode stays ONE flat grid: sections would fight the drag that
 *     is the whole point of that mode.
 *
 * Run: `node scripts/test-charm-picker-ui.js`
 */

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { JSDOM, VirtualConsole } = require('jsdom')

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m'
let passed = 0, failed = 0
const failures = []
const pending = []
const group = (name) => pending.push({ group: name })
const test = (name, fn) => pending.push({ name, fn })

const HTML = path.resolve(__dirname, '../public/index.html')
// Normalised so the markers below do not depend on the checkout's line endings.
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

// The shipped picker markup, verbatim — a renamed id fails here, not in the market.
const MODAL_HTML = slice('<div id="charmModal"', '<!-- ── Charm Purchase List modal', 'charm picker markup')
// The stall/charm location maths, shared with Shopping Mode and the server.
const LOCATION_SRC =
	slice('// ══ STALL LOCATION ══', '// ══ END STALL LOCATION ══', 'stall-location block') +
	slice('// ══ CHARM LOCATION ══', '// ══ END CHARM LOCATION ══', 'charm-location block')
// The supplier rail, taken whole (state included) rather than function by
// function, so the tests run the shipped block instead of a reassembled copy.
const JUMP_SRC = slice('// ══ CHARM JUMP RAIL ══', '// ══ END CHARM JUMP RAIL ══', 'charm jump rail block')

/** Pull a top-level helper out of the page by name (3-tab indentation). */
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

// Escaping, image URLs and the stall lookup are the page's own: a stub would
// prove nothing about the markup the operator actually gets.
const BORROWED = [
	'toDisplayString',
	'escHtml',
	'escAttr',
	'jsAttr',
	'charmImageUrl',
	'_charmCardImgPlaceholder',
	'_charmShopStall',
	'_filterCharms',
	'_charmMarketName',
	'_charmGroupHeadHtml',
	'_charmCardHtml',
	'renderCharmGrid',
	'_revealSelectedCharm',
].map(extractFn).join('\n')

/**
 * A window holding the real picker with the real render block loaded. Everything
 * the block reaches outside itself is stubbed here and recorded, so a test can
 * see exactly which collaborators ran and with what.
 */
function makeEnv({ charms = LIBRARY, shops = SHOPS, assigned = '', manage = false, lang = 'en' } = {}) {
	const virtualConsole = new VirtualConsole()
	virtualConsole.on('jsdomError', () => {})
	const dom = new JSDOM(`<!doctype html><html><body>${MODAL_HTML}</body></html>`, { runScripts: 'dangerously', virtualConsole })
	const { window } = dom
	const calls = { assigned: [], editor: [], deleted: [] }
	window.__calls = calls
	window.__lang = lang

	const prelude = `
		const API = ''
		const I18N = { get: () => window.__lang }
		let _charmList = ${JSON.stringify(charms)}
		let _charmShopDirectory = ${JSON.stringify(shops)}
		let _charmManageMode = ${JSON.stringify(manage)}
		let _charmModalTarget = ${assigned ? "{ receipt_id: 1, item_key: 'k#L1' }" : 'null'}
		let _routeRows = [{ receipt_id: 1, item_key: 'k#L1', charm_code: ${JSON.stringify(assigned)} }]
		let _charmImgVer = 1
		function _charmCardImgError() {}
		function assignCharmFromModal(code, shop) { window.__calls.assigned.push({ code, shop }) }
		function openCharmEditor(mode, code) { window.__calls.editor.push({ mode, code: code || null }) }
		function deleteCharmEntry(code) { window.__calls.deleted.push(code) }
		function onCharmDragStart() {}
		function onCharmDragEnd() {}
		function onCharmDragOver() {}
		function onCharmDragLeave() {}
		function onCharmDrop() {}
	`
	// One eval so the stubs and the block share a scope, exactly as they do on the
	// page — which is also what lets the markup's inline handlers resolve.
	window.eval(`${prelude}\n${LOCATION_SRC}\n${JUMP_SRC}\n${BORROWED}\n` + `
		window.__setManage = (v) => { _charmManageMode = v }
		window.__groups = (list) => _charmGroupsForPicker(list)
		window.__activeSection = (...a) => _activeCharmSection(...a)
		window.__syncSpy = () => _syncCharmJumpSpy()
	`)
	// The picker is opened by the page, which reveals the grid before rendering.
	window.document.getElementById('charmGrid').style.display = 'block'
	window.renderCharmGrid()
	return { window, doc: window.document, calls }
}

// A library shaped like the live one: two charm stalls in the charm market, a
// shop whose stall was never recorded, and charms nobody has sourced yet.
const LIBRARY = [
	{ code: 'CH-00013', default_charm_shop: '一樂潮品', default_charm_shop_stall: '2C666', has_image: true, image_version: 'a' },
	{ code: 'CH-00002', default_charm_shop: '彩虹', default_charm_shop_stall: '2D21', has_image: true, image_version: 'b' },
	{ code: 'CH-00001', default_charm_shop: '一樂潮品', default_charm_shop_stall: '2C666', has_image: false },
	{ code: 'CH-00010', default_charm_shop: '彩虹', default_charm_shop_stall: '2D21', has_image: false },
	{ code: 'CH-00040', default_charm_shop: 'Star Beads', default_charm_shop_stall: '', has_image: false },
	{ code: 'CH-00099', default_charm_shop: '', default_charm_shop_stall: '', has_image: false },
]
const SHOPS = [
	{ shop_name: '一樂潮品', stall: '2C666' },
	{ shop_name: '彩虹', stall: '2D21' },
]

/** jsdom values come from another realm, where deepStrictEqual sees a foreign prototype. */
const plain = (v) => JSON.parse(JSON.stringify(v))
const sections = (doc) => Array.from(doc.querySelectorAll('#charmGrid .charm-group'))
const headText = (sec, sel) => sec.querySelector(sel)?.textContent.trim() ?? null
const codesIn = (sec) => Array.from(sec.querySelectorAll('.charm-card-code')).map((el) => el.textContent.trim())
const allCards = (doc) => Array.from(doc.querySelectorAll('#charmGrid .charm-card'))
const click = (window, el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))

function search(window, value) {
	const box = window.document.getElementById('charmSearch')
	box.value = value
	box.dispatchEvent(new window.window.Event('input', { bubbles: true }))
}

const rail = (doc) => doc.getElementById('charmJump')
const jumpSelect = (doc) => doc.getElementById('charmJumpSelect')
const options = (doc) => Array.from(jumpSelect(doc)?.options || [])
const optionLabels = (doc) => options(doc).map((o) => o.textContent.trim())
const markedIndex = (doc) => {
	const sel = jumpSelect(doc)
	if (!sel || sel.selectedIndex < 0) return -1
	return parseInt(sel.value, 10)
}
const railShown = (doc) => rail(doc).style.display !== 'none'

/** Record what the picker asks the scroller to do — jsdom has no scrolling of its own. */
function watchScroll(doc) {
	const grid = doc.getElementById('charmGrid')
	const asks = []
	grid.scrollTo = (opts) => asks.push(opts)
	return asks
}

/** Choose a supplier from the dropdown the way an operator would. */
function pickSupplier(window, index) {
	const sel = jumpSelect(window.document)
	sel.value = String(index)
	sel.dispatchEvent(new window.window.Event('change', { bubbles: true }))
}

// ─────────────────────────────────────────────────────────────────────────────
group('Sections a shopper can scan')

test('the library is cut into one section per supplier, each headed with its stall', () => {
	const { doc } = makeEnv()
	const secs = sections(doc)
	assert.strictEqual(secs.length, 4, `expected 4 supplier sections, got ${secs.length}`)
	assert.strictEqual(headText(secs[0], '.cgh-shop'), '一樂潮品', 'the first section does not name its shop')
	assert.strictEqual(headText(secs[0], '.cgh-stall'), '2C666', 'the stall code is missing from the header')
	assert.strictEqual(headText(secs[0], '.cgh-market'), 'Longsheng · F2', 'the header does not say which market and floor')
	assert.strictEqual(headText(secs[0], '.cgh-count'), '2', 'the header does not count the charms standing there')
})

test('sections follow the walking order, with unsourced charms last', () => {
	const { doc } = makeEnv()
	const secs = sections(doc)
	assert.deepStrictEqual(
		secs.map((s) => headText(s, '.cgh-shop')),
		['一樂潮品', '彩虹', 'Star Beads', 'No supplier set'],
		'sections are not in walking order, or the unsourced charms are not last',
	)
	const last = secs[secs.length - 1].querySelector('.charm-group-head')
	assert.ok(last.classList.contains('is-unset'), 'the unsourced section is not marked as needing attention')
	assert.deepStrictEqual(codesIn(secs[secs.length - 1]), ['CH-00099'])
})

test('a shop with no stall recorded says so instead of showing a blank chip', () => {
	const { doc } = makeEnv()
	const sec = sections(doc)[2]
	assert.strictEqual(headText(sec, '.cgh-shop'), 'Star Beads')
	assert.strictEqual(sec.querySelector('.cgh-stall'), null, 'an empty stall chip is rendered')
	assert.strictEqual(headText(sec, '.cgh-market'), 'Stall not recorded', 'the missing stall is not called out')
})

test('every charm is rendered exactly once, under its own supplier', () => {
	const { doc } = makeEnv()
	const rendered = allCards(doc).map((c) => c.querySelector('.charm-card-code').textContent.trim())
	assert.strictEqual(rendered.length, LIBRARY.length, 'a charm was dropped or duplicated by the grouping')
	assert.deepStrictEqual([...rendered].sort(), LIBRARY.map((c) => c.code).sort())
	assert.deepStrictEqual(codesIn(sections(doc)[1]), ['CH-00002', 'CH-00010'], 'a section holds the wrong charms, or the wrong order')
})

test('a pick card carries the photo and the code, and nothing else', () => {
	const { doc } = makeEnv()
	assert.strictEqual(doc.querySelectorAll('#charmGrid .charm-card .charm-card-shop').length, 0, 'the shop line the header already states is back on every card')
	for (const card of allCards(doc)) {
		assert.strictEqual(card.children.length, 2, 'a pick card grew a line beyond its photo and code — the noise the operator asked to be rid of')
		assert.ok(card.querySelector('.charm-card-code'), 'the code is missing from the card')
	}
})

test('the market reads in the operator’s language', () => {
	const { doc } = makeEnv({ lang: 'zh' })
	assert.strictEqual(headText(sections(doc)[0], '.cgh-market'), '龙胜 · F2', 'the header is not localised')
})

test('the charm already on the line opens selected, and only that one', () => {
	const { doc } = makeEnv({ assigned: 'CH-00010' })
	const selected = doc.querySelectorAll('#charmGrid .charm-card.selected')
	assert.strictEqual(selected.length, 1, 'the assigned charm is not highlighted, or several are')
	assert.strictEqual(selected[0].querySelector('.charm-card-code').textContent.trim(), 'CH-00010')
})

// ─────────────────────────────────────────────────────────────────────────────
group('Picking a charm')

test('clicking a card assigns that charm’s code and its shop', () => {
	const { window, doc, calls } = makeEnv()
	click(window, allCards(doc)[0])
	assert.deepStrictEqual(plain(calls.assigned), [{ code: 'CH-00001', shop: '一樂潮品' }], 'the wrong charm — or the wrong shop — was assigned')
})

test('a shop name carrying a quote survives the round trip', () => {
	const tricky = [{ code: 'CH-00500', default_charm_shop: "Lily's Charms", default_charm_shop_stall: '2A01', has_image: false }]
	const { window, doc, calls } = makeEnv({ charms: tricky, shops: [] })
	click(window, allCards(doc)[0])
	assert.deepStrictEqual(plain(calls.assigned), [{ code: 'CH-00500', shop: "Lily's Charms" }], 'the apostrophe broke the click handler')
})

test('a shop name that looks like markup is shown, not executed', () => {
	const attack = [{ code: 'CH-00600', default_charm_shop: '<img src=x onerror=1>', default_charm_shop_stall: '2A02', has_image: false }]
	const { doc } = makeEnv({ charms: attack, shops: [] })
	const head = doc.querySelector('.charm-group-head')
	assert.strictEqual(head.querySelector('img'), null, 'the shop name was injected as markup')
	assert.strictEqual(headText(sections(doc)[0], '.cgh-shop'), '<img src=x onerror=1>', 'the shop name was mangled instead of escaped')
})

// ─────────────────────────────────────────────────────────────────────────────
group('Finding a charm')

test('searching a stall code narrows the picker to that stall', () => {
	const { window, doc } = makeEnv()
	search(window, '2D21')
	const secs = sections(doc)
	assert.strictEqual(secs.length, 1, 'the search did not narrow to one stall')
	assert.strictEqual(headText(secs[0], '.cgh-shop'), '彩虹')
	assert.deepStrictEqual(codesIn(secs[0]), ['CH-00002', 'CH-00010'])
})

test('searching a charm code narrows to it, and keeps its section', () => {
	const { window, doc } = makeEnv()
	search(window, 'ch-00013')
	assert.strictEqual(sections(doc).length, 1)
	assert.deepStrictEqual(codesIn(sections(doc)[0]), ['CH-00013'], 'the code search lost its charm')
	assert.strictEqual(headText(sections(doc)[0], '.cgh-stall'), '2C666', 'a searched result lost the stall it is bought at')
})

test('no match says so plainly instead of leaving an empty grid', () => {
	const { window, doc } = makeEnv()
	search(window, 'nothing-like-this')
	assert.strictEqual(sections(doc).length, 0)
	const empty = doc.querySelector('#charmGrid .charm-grid-empty')
	assert.ok(empty, 'an empty picker shows nothing at all')
	assert.match(empty.textContent, /No charms match/)
})

// ─────────────────────────────────────────────────────────────────────────────
group('Jumping to a supplier')

test('the dropdown names every section, in the same walking order, with its count', () => {
	const { doc } = makeEnv()
	assert.ok(railShown(doc), 'the dropdown is hidden on a library with four suppliers')
	assert.deepStrictEqual(
		optionLabels(doc),
		['一樂潮品 · 2C666 (2)', '彩虹 · 2D21 (2)', 'Star Beads (1)', 'No supplier set (1)'],
		'the dropdown and the sections disagree about the route',
	)
	assert.strictEqual(options(doc)[0].getAttribute('title'), '2C666 · Longsheng · F2', 'the option does not say where the stall is')
})

test('the dropdown is reachable by keyboard and labelled for assistive tech', () => {
	const { doc } = makeEnv()
	const sel = jumpSelect(doc)
	assert.strictEqual(sel.tagName.toLowerCase(), 'select')
	const label = doc.querySelector('label[for="charmJumpSelect"]')
	assert.ok(label, 'the select has no associated label')
	assert.strictEqual(label.textContent.trim(), 'Jump to supplier')
})

test('the picker opens with the first supplier selected', () => {
	const { doc } = makeEnv()
	assert.strictEqual(markedIndex(doc), 0, 'the dropdown does not say which supplier is on screen')
})

test('choosing a supplier scrolls the picker to it and selects that option', () => {
	const { window, doc } = makeEnv()
	const asks = watchScroll(doc)
	pickSupplier(window, 2)
	assert.strictEqual(markedIndex(doc), 2, 'the chosen supplier is not selected')
	assert.strictEqual(asks.length, 1, 'the picker was not scrolled')
	assert.ok(Number.isFinite(asks[0].top), 'the picker was scrolled to a nonsense offset')
	assert.strictEqual(asks[0].behavior, 'smooth', 'the jump does not carry the operator with it')
})

test('a supplier whose name is a quote or markup still jumps', () => {
	const nasty = [
		{ code: 'CH-00500', default_charm_shop: "Lily's Charms", default_charm_shop_stall: '2A01', has_image: false },
		{ code: 'CH-00600', default_charm_shop: '<img src=x onerror=1>', default_charm_shop_stall: '2A02', has_image: false },
	]
	const { window, doc } = makeEnv({ charms: nasty, shops: [] })
	assert.strictEqual(rail(doc).querySelector('img'), null, 'a shop name was injected into the dropdown as markup')
	assert.ok(optionLabels(doc)[0].includes("Lily's Charms"), 'an apostrophe broke the option text')
	assert.ok(optionLabels(doc)[1].includes('<img src=x onerror=1>'), 'a shop name was mangled instead of escaped')
	const asks = watchScroll(doc)
	pickSupplier(window, 1)
	assert.strictEqual(markedIndex(doc), 1, 'the apostrophe or the markup broke the change handler')
	assert.strictEqual(asks.length, 1)
})

test('the dropdown tracks the search, and stands down when there is nowhere to jump', () => {
	const { window, doc } = makeEnv()
	search(window, 'ch-0001')
	assert.deepStrictEqual(
		optionLabels(doc),
		['一樂潮品 · 2C666 (1)', '彩虹 · 2D21 (1)'],
		'the dropdown still offers suppliers the search filtered out',
	)
	assert.strictEqual(markedIndex(doc), 0, 'the dropdown kept a selection from before the search')

	search(window, '2d21')
	assert.strictEqual(sections(doc).length, 1)
	assert.ok(!railShown(doc), 'a dropdown with one destination is chrome the charms could have used')

	search(window, 'nothing-like-this')
	assert.ok(!railShown(doc), 'the dropdown outlived the sections it points at')
})

test('a library standing at one stall gets no dropdown at all', () => {
	const { doc } = makeEnv({ charms: [LIBRARY[0], LIBRARY[2]], shops: SHOPS })
	assert.strictEqual(sections(doc).length, 1)
	assert.ok(!railShown(doc), 'the dropdown appeared with nothing to jump between')
})

// The spy decides which option is selected from where the scroller sits. jsdom
// has no layout — every box measures zero — so the rule itself is pinned here
// as maths, and the wiring around it through the DOM tests above.
test('the marked supplier is the last one whose header has reached the top', () => {
	const { window } = makeEnv()
	const at = window.__activeSection
	const tops = [0, 500, 900]
	assert.strictEqual(at(tops, 0, 300, 1200), 0, 'the top of the list is not the first supplier')
	assert.strictEqual(at(tops, 495, 300, 1200), 0, 'a section became current while its header was still below the line')
	assert.strictEqual(at(tops, 500, 300, 1200), 1, 'a section did not become current when its header pinned')
	assert.strictEqual(at(tops, 901, 300, 1200), 2)
	// Fractional rects are the norm at browser zoom levels other than 100%, so a
	// header a fraction of a pixel short of the line still counts as arrived.
	assert.strictEqual(at([0, 500.4], 499.6, 300, 1200), 1, 'sub-pixel rounding left the header forever a hair short')
})

test('a short last section still marks itself once the list is at the bottom', () => {
	const { window } = makeEnv()
	// 900 never reaches the pin line: the scroller stops at 700 (1000 − 300).
	assert.strictEqual(window.__activeSection([0, 500, 900], 700, 300, 1000), 2, 'the last supplier can never be marked by scrolling')
	assert.strictEqual(window.__activeSection([], 0, 300, 1000), -1, 'an empty picker claims to have a current supplier')
})

test('a picker that re-rendered while closed marks its first supplier, not its last', () => {
	// Closed, every box measures zero — the case that decides what the dropdown
	// shows the next time the operator opens it.
	assert.strictEqual(makeEnv().window.__activeSection([0, 0, 0], 0, 0, 0), 0, 'the dropdown would open pointing at the far end of the market')
})

test('scrolling the picker updates the dropdown without throwing', () => {
	const { window, doc } = makeEnv()
	const grid = doc.getElementById('charmGrid')
	assert.doesNotThrow(() => grid.dispatchEvent(new window.window.Event('scroll', { bubbles: false })), 'scrolling the picker throws')
	assert.strictEqual(markedIndex(doc), 0, 'scrolling left the dropdown with no current supplier')
})

// ─────────────────────────────────────────────────────────────────────────────
group('Manage charms stays a flat, draggable library')

test('manage mode is one grid with no supplier headers', () => {
	const { window, doc } = makeEnv({ manage: true })
	assert.strictEqual(doc.querySelectorAll('#charmGrid .charm-group-head').length, 0, 'sections would fight drag-to-reorder')
	assert.ok(!railShown(doc), 'the dropdown promises sections manage mode does not have')
	assert.strictEqual(doc.querySelectorAll('#charmGrid .charm-group-grid').length, 1, 'manage mode is not a single flat grid')
	assert.ok(doc.querySelector('#charmGrid .charm-add-card'), 'the Add charm card is gone')
	assert.ok(doc.querySelector('#charmGrid .charm-manage-hint'), 'the drag hint is gone')
	// Library order, NOT the picker's supplier order.
	assert.deepStrictEqual(
		allCards(doc).map((c) => c.querySelector('.charm-card-code').textContent.trim()),
		LIBRARY.map((c) => c.code),
		'manage mode reordered the library it exists to reorder',
	)
	assert.ok(window.__calls, 'harness sanity')
})

test('manage cards stay draggable and keep the shop line the flat list needs', () => {
	const { doc } = makeEnv({ manage: true })
	const card = doc.querySelector('#charmGrid .charm-card.cm-manage')
	assert.ok(card, 'cards are no longer drag handles')
	assert.strictEqual(card.getAttribute('draggable'), 'true')
	assert.ok(card.querySelector('.charm-card-shop'), 'a flat list with no headers must name the shop on the card')
	assert.ok(card.querySelector('.charm-card-act'), 'the edit/delete actions are gone')
})

test('switching out of manage mode restores the supplier sections', () => {
	const { window, doc } = makeEnv({ manage: true })
	window.__setManage(false)
	window.renderCharmGrid()
	assert.strictEqual(sections(doc).length, 4, 'the picker did not return to its sections')
	assert.ok(railShown(doc), 'the dropdown did not come back with the sections')
	assert.strictEqual(markedIndex(doc), 0, 'the returning dropdown marks nothing')
	assert.strictEqual(doc.querySelectorAll('#charmGrid .charm-add-card').length, 0, 'the Add charm card leaked into the picker')
})

// ─────────────────────────────────────────────────────────────────────────────
group('Opening the picker')

test('the picker scrolls to the assigned charm without throwing on an empty one', () => {
	const { window } = makeEnv({ assigned: 'CH-00010' })
	assert.doesNotThrow(() => window._revealSelectedCharm(), 'revealing the current charm throws')
	const none = makeEnv()
	assert.doesNotThrow(() => none.window._revealSelectedCharm(), 'an unassigned line breaks the open')
})

test('an empty library is an empty state, not a crash', () => {
	const { doc } = makeEnv({ charms: [], shops: [] })
	assert.ok(doc.querySelector('#charmGrid .charm-grid-empty'), 'an empty library renders nothing at all')
})

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${BOLD}Assign Charm — supplier sections${RESET}\n`)
for (const item of pending) {
	if (item.group) {
		console.log(`${DIM}${BOLD}  ${item.group}${RESET}`)
		continue
	}
	try {
		item.fn()
		passed++
		console.log(`${GREEN}  ✓${RESET} ${item.name}`)
	} catch (err) {
		failed++
		failures.push({ name: item.name, err })
		console.log(`${RED}  ✗ ${item.name}${RESET}`)
		console.log(`${DIM}    ${err.message}${RESET}`)
	}
}
console.log('')
if (failed) {
	console.log(`${RED}${BOLD}  ${failed} test(s) failed${RESET}, ${passed} passed`)
	for (const f of failures) console.log(`\n${RED}• ${f.name}${RESET}\n${f.err.stack}`)
	process.exit(1)
}
console.log(`${GREEN}${BOLD}  All ${passed} tests passed.${RESET}`)
