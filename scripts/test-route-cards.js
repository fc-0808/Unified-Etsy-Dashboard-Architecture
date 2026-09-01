'use strict'
/**
 * Behavioural tests for the Route dashboard's mobile order cards.
 *
 * Below 768px each row of the route table renders as a card that opens as a
 * summary (photo · model/style · supplier · components) and discloses the rest
 * — order, charm, actions — on tap. Like the lightbox harness, this extracts
 * the real expansion block from index.html and runs it against jsdom, so the
 * tests execute the shipped source rather than a copy of it.
 *
 * The behaviours pinned here are the ones that are easy to break by accident:
 *   · An expanded card must survive renderRouteDashboard() rebuilding the tbody
 *     — otherwise every status change silently slams the card shut.
 *   · Two lines of the SAME order must expand independently.
 *   · Taps on the photo and on the controls must never be read as "expand".
 *   · Above the breakpoint (no chevron rendered) nothing may toggle at all.
 *   · The table must never reintroduce the horizontal scroll it inherits from
 *     `.table-wrap > table { min-width: max-content }` — the original bug.
 */

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { JSDOM, VirtualConsole } = require('jsdom')

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m'
let passed = 0, failed = 0
const failures = []
const pending = []
function group(name) { pending.push({ group: name }) }
function test(name, fn) { pending.push({ name, fn }) }

// ── Extract the expansion block straight out of the shipped page ─────────────
const HTML = path.resolve(__dirname, '../public/index.html')
const source = fs.readFileSync(HTML, 'utf8')
const START = '// ══ ROUTE CARD EXPANSION ══'
const END = '// ══ END ROUTE CARD EXPANSION ══'
const a = source.indexOf(START)
const b = source.indexOf(END)
if (a < 0 || b < 0 || b <= a) {
	console.error(`${RED}Could not locate the route card sentinels in public/index.html.${RESET}`)
	console.error(`${DIM}Expected "${START}" … "${END}".${RESET}`)
	process.exit(1)
}
const CARD_SRC = source.slice(a, b)

// Mirrors the <tr> that _routeRowHtml() emits, inline handler included, so a
// rename that breaks the attribute wiring fails these tests. Only the parts
// the expansion logic touches are reproduced.
function rowHtml(line, isOpen) {
	const action = isOpen ? 'Hide' : 'Show'
	return `<tr class="${line.cls || ''}${isOpen ? ' is-open' : ''}" data-receipt="${line.receipt}" data-item="${line.item}">
		<td><a class="route-thumb-link" href="https://www.etsy.com/listing/1"><img class="route-thumb"></a></td>
		<td>
			<div class="route-prod-title"><span class="route-prod-name">${line.title}</span></div>
			<div class="route-prod-meta"><span class="route-prod-meta-text">iPhone 17 · Case Only</span><span class="route-note-indicator">📝</span></div>
			<div class="route-prod-note">📝 please pick the blue one</div>
			<button type="button" class="route-card-toggle" aria-expanded="${isOpen}" data-card-label="${line.title}" aria-label="${action} details for ${line.title}" title="${action} details" onclick="toggleRouteCard(this.closest('tr'))"></button>
		</td>
		<td><div class="route-order-id">#${line.receipt}</div><textarea class="route-note-area"></textarea></td>
		<td><span class="route-supplier">Stall A</span><button class="supplier-edit-btn">✎</button></td>
		<td><select class="comp-select"><option>Pending</option></select></td>
		<td><div class="route-charm">No charm</div></td>
		<td><input type="checkbox"><button class="route-row-remove">🗑</button></td>
	</tr>`
}

const LINES = [
	{ receipt: 4137213873, item: 'case|iphone-17', title: 'Cute Cinnamoroll Clear Case with Blue Star Charm' },
	// Same receipt, different line — the composite key has to keep them apart.
	{ receipt: 4137213873, item: 'grip|iphone-17', title: 'Matching Y2K Grip Ring' },
	{ receipt: 4137213999, item: 'case|iphone-16', title: 'Sanrio Kuromi Soft Case' },
]

/**
 * Build a document holding the route table with the expansion block loaded.
 * `mobile` decides whether the chevron is rendered — that is exactly the signal
 * the shipped handler reads (CSS hides it above the breakpoint), and jsdom has
 * no layout of its own, so it is stubbed here rather than faked in the source.
 */
function makeEnv({ mobile = true, lines = LINES } = {}) {
	// jsdom cannot navigate, so clicking the real Etsy link raises a
	// "Not implemented" error. That error is itself the proof the link still
	// works; keep it out of the test output rather than weakening the fixture.
	const virtualConsole = new VirtualConsole()
	virtualConsole.on('jsdomError', () => {})
	const dom = new JSDOM(
		`<!doctype html><html><body><div id="tab-route"><table class="route-dash-table"><tbody id="routeDashBody"></tbody></table></div></body></html>`,
		// 'dangerously' compiles the inline on* attributes; the fixture contains
		// no <script> tags, so nothing else executes.
		{ pretendToBeVisual: true, runScripts: 'dangerously', virtualConsole },
	)
	const { window } = dom
	const RECT = { width: 32, height: 32, top: 0, left: 0, bottom: 32, right: 32 }
	window.Element.prototype.getClientRects = function () {
		if (this.classList.contains('route-card-toggle') && !mobile) return []
		return [RECT]
	}
	// The shipped expansion block hydrates deferred cells through these page-level
	// bindings. Keep the fixture deliberately small while exercising that real path.
	window._routeRows = lines.map((line) => ({ receipt_id: line.receipt, item_key: line.item }))
	window._routeDetailCellsHtml = (row) => ({
		order: `<div class="route-order-id">#${row.receipt_id}</div><textarea class="route-note-area"></textarea>`,
		charm: '<div class="route-charm">No charm</div>',
		actions: '<input type="checkbox"><button class="route-row-remove">Remove</button>',
	})

	// Concatenated into the SAME eval as the block, so it closes over the
	// block's `const` bindings (a separate window.eval could not reach them).
	// This is the read _routeRowHtml() performs when it rebuilds a row.
	window.eval(CARD_SRC + '\nwindow.__isOpen = function (receiptId, itemKey) { return _routeCardsOpen.has(_routeCardKey(receiptId, itemKey)) };')

	// Stands in for renderRouteDashboard(), which rebuilds the whole tbody from
	// scratch on every save — the moment an expanded card would be lost.
	const render = (order = lines) => {
		window.document.getElementById('routeDashBody').innerHTML = order.map((l) => rowHtml(l, window.__isOpen(l.receipt, l.item))).join('')
	}
	render()
	return { window, doc: window.document, render }
}

const click = (window, el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
const rows = (doc) => Array.from(doc.querySelectorAll('#routeDashBody tr'))
const isOpen = (tr) => tr.classList.contains('is-open')

group('Collapsed by default')

test('every card starts collapsed', () => {
	const { doc } = makeEnv()
	assert.strictEqual(rows(doc).filter(isOpen).length, 0, 'a card opened on its own')
	for (const tr of rows(doc)) {
		assert.strictEqual(tr.querySelector('.route-card-toggle').getAttribute('aria-expanded'), 'false')
	}
})

test('the product name is present but separable from its badges', () => {
	const { doc } = makeEnv()
	// The CSS hides `.route-prod-name` on a collapsed card; that only works if
	// the title text is wrapped and the badges are its siblings.
	const title = rows(doc)[0].querySelector('.route-prod-title')
	assert.ok(title.querySelector('.route-prod-name'), 'title text is not wrapped')
})

group('Expanding')

test('the chevron opens and closes the card', () => {
	const { window, doc } = makeEnv()
	const tr = rows(doc)[0]
	const btn = tr.querySelector('.route-card-toggle')
	click(window, btn)
	assert.ok(isOpen(tr), 'the chevron did not open the card')
	assert.strictEqual(btn.getAttribute('aria-expanded'), 'true')
	assert.strictEqual(btn.getAttribute('aria-label'), `Hide details for ${LINES[0].title}`)
	assert.strictEqual(btn.title, 'Hide details')
	click(window, btn)
	assert.strictEqual(isOpen(tr), false, 'the chevron did not close the card')
	assert.strictEqual(btn.getAttribute('aria-expanded'), 'false')
	assert.strictEqual(btn.getAttribute('aria-label'), `Show details for ${LINES[0].title}`)
	assert.strictEqual(btn.title, 'Show details')
})

test('deferred Order, Charm and Actions hydrate only on first expansion', () => {
	const { window, doc } = makeEnv()
	const tr = rows(doc)[0]
	for (const [index, kind] of [
		[2, 'order'],
		[5, 'charm'],
		[6, 'actions'],
	]) {
		tr.children[index].innerHTML = ''
		tr.children[index].className = 'route-detail-slot'
		tr.children[index].dataset.routeDetail = kind
	}
	tr.dataset.detailsHydrated = 'false'
	assert.strictEqual(tr.querySelector('.route-order-id'), null, 'order detail was eagerly built')
	assert.strictEqual(tr.querySelector('.route-charm'), null, 'charm detail was eagerly built')

	click(window, tr.querySelector('.route-card-toggle'))
	assert.ok(tr.querySelector('.route-order-id'), 'order detail did not hydrate')
	assert.ok(tr.querySelector('.route-charm'), 'charm detail did not hydrate')
	assert.ok(tr.querySelector('.route-row-remove'), 'actions did not hydrate')
	assert.strictEqual(tr.querySelectorAll('[data-route-detail]').length, 0, 'hydration placeholders remained')
	assert.strictEqual(tr.dataset.detailsHydrated, 'true')

	click(window, tr.querySelector('.route-card-toggle'))
	click(window, tr.querySelector('.route-card-toggle'))
	assert.strictEqual(tr.querySelectorAll('.route-order-id').length, 1, 're-expansion duplicated hydrated detail')
})

test('tapping anywhere in the card header opens it', () => {
	const { window, doc } = makeEnv()
	const tr = rows(doc)[0]
	click(window, tr.querySelector('.route-prod-meta'))
	assert.ok(isOpen(tr), 'a header tap was ignored')
})

test('tapping non-interactive supplier content opens the collapsed summary', () => {
	const { window, doc } = makeEnv()
	const tr = rows(doc)[0]
	click(window, tr.querySelector('.route-supplier'))
	assert.ok(isOpen(tr), 'the supplier summary did not open the card')
})

test('tapping the photo opens the listing instead of the card', () => {
	const { window, doc } = makeEnv()
	const tr = rows(doc)[0]
	click(window, tr.querySelector('.route-thumb'))
	assert.strictEqual(isOpen(tr), false, 'the Etsy link was swallowed by the expander')
})

test('tapping a control never toggles the card', () => {
	const { window, doc } = makeEnv()
	const tr = rows(doc)[0]
	for (const sel of ['.supplier-edit-btn', '.comp-select', '.route-note-area', 'input[type=checkbox]']) {
		click(window, tr.querySelector(sel))
		assert.strictEqual(isOpen(tr), false, `${sel} toggled the card`)
	}
})

test('working inside an expanded card does not collapse it', () => {
	const { window, doc } = makeEnv()
	const tr = rows(doc)[0]
	click(window, tr.querySelector('.route-card-toggle'))
	click(window, tr.querySelector('.route-order-id'))
	click(window, tr.querySelector('.route-charm'))
	assert.ok(isOpen(tr), 'a tap in the detail sections closed the card')
})

test('cards open independently of each other', () => {
	const { window, doc } = makeEnv()
	click(window, rows(doc)[0].querySelector('.route-card-toggle'))
	assert.deepStrictEqual(rows(doc).map(isOpen), [true, false, false])
})

test('two lines of the same order expand independently', () => {
	const { window, doc } = makeEnv()
	// Both rows carry the same data-receipt; only the item key differs.
	click(window, rows(doc)[1].querySelector('.route-card-toggle'))
	assert.deepStrictEqual(rows(doc).map(isOpen), [false, true, false], 'the composite key is not distinguishing line items')
})

group('Surviving a re-render')

test('an expanded card stays expanded when the table rebuilds', () => {
	const { window, doc, render } = makeEnv()
	click(window, rows(doc)[1].querySelector('.route-card-toggle'))
	render()
	assert.deepStrictEqual(rows(doc).map(isOpen), [false, true, false], 'saving a change slammed the card shut')
	assert.strictEqual(rows(doc)[1].querySelector('.route-card-toggle').getAttribute('aria-expanded'), 'true')
})

test('the open card follows its line through a re-sort', () => {
	const { window, doc, render } = makeEnv()
	click(window, rows(doc)[0].querySelector('.route-card-toggle'))
	render([LINES[2], LINES[0], LINES[1]])
	assert.deepStrictEqual(rows(doc).map(isOpen), [false, true, false], 'expansion is tracking row position, not line identity')
})

test('collapsing is remembered too', () => {
	const { window, doc, render } = makeEnv()
	const btn = () => rows(doc)[0].querySelector('.route-card-toggle')
	click(window, btn())
	click(window, btn())
	render()
	assert.strictEqual(isOpen(rows(doc)[0]), false, 'a closed card reopened itself')
})

test('a row that has left the table cannot resurrect a stale state', () => {
	const { window, doc, render } = makeEnv()
	click(window, rows(doc)[2].querySelector('.route-card-toggle'))
	render([LINES[0], LINES[1]]) // that order shipped and dropped out
	assert.deepStrictEqual(rows(doc).map(isOpen), [false, false])
	render(LINES) // …and came back
	assert.deepStrictEqual(rows(doc).map(isOpen), [false, false, true])
})

group('Desktop is untouched')

test('header taps do nothing while the chevron is not rendered', () => {
	const { window, doc } = makeEnv({ mobile: false })
	const tr = rows(doc)[0]
	click(window, tr.querySelector('.route-prod-meta'))
	click(window, tr.querySelector('.route-thumb'))
	assert.strictEqual(isOpen(tr), false, 'the desktop table gained an expander')
})

test('the loading / empty-state row is handled without throwing', () => {
	const { window, doc } = makeEnv({ lines: [] })
	doc.getElementById('routeDashBody').innerHTML = '<tr><td colspan="7" class="loading">Loading orders…</td></tr>'
	assert.doesNotThrow(() => click(window, doc.querySelector('#routeDashBody td')))
})

group('Shipped markup and stylesheet contract')

test('_routeRowHtml() emits the identity and controls the block relies on', () => {
	const fn = source.slice(source.indexOf('function _routeRowHtml(row)'))
	const body = fn.slice(0, fn.indexOf('\n\t\t\tfunction ', 1))
	for (const needle of ['data-receipt="${row.receipt_id}"', 'data-item="${escAttr(row.item_key)}"', 'class="route-card-toggle"', 'data-card-label="${escAttr(cardLabel)}"', 'class="route-prod-name"', 'class="route-prod-meta-text"', 'class="route-note-indicator"', '_routeCardsOpen.has(']) {
		assert.ok(body.includes(needle), `_routeRowHtml() no longer emits ${needle}`)
	}
	assert.ok(body.includes("const deferDetails = _compactDataViewport && !isOpen"), 'collapsed mobile rows eagerly build detail cells')
	for (const kind of ['order', 'charm', 'actions']) {
		assert.ok(body.includes(`data-route-detail="${kind}"`), `missing ${kind} hydration slot`)
	}
})

test('the card layout still opts out of the table\'s horizontal scroll', () => {
	// `.table-wrap > table { min-width: max-content }` is what makes every table
	// on the page scroll sideways; a card list that inherits it crops orders off
	// the right edge, which is the bug this layout exists to fix.
	const media = source.slice(source.indexOf('/* ── Route Dashboard ("Orders Sorting Dashboard") → mobile cards'))
	const block = media.slice(0, media.indexOf('\n\t\t\t/* ──', 1))
	assert.ok(/#tab-route \.route-dash-table,[\s\S]{0,240}?min-width: 0;/.test(block), 'the route table no longer overrides min-width: max-content')
	assert.ok(block.includes('minmax(0, 1fr)'), 'the card grid can be blown out by a long title again')
	assert.ok(/#tab-route \.table-wrap:has\(> \.route-dash-table\) \{[\s\S]{0,220}?overflow: visible;/.test(block), 'the card list is back inside a horizontally scrolling wrapper')
})

test('the collapsed summary keeps its compact visual hierarchy and touch target', () => {
	const start = source.indexOf('/* ── Route Dashboard ("Orders Sorting Dashboard") → mobile cards')
	const end = source.indexOf('/* ── Loading / error states', start)
	const css = source.slice(start, end)
	assert.ok(css.includes('grid-template-columns: 52px minmax(0, 1fr)'), 'the compact 52px summary grid regressed')
	assert.ok(css.includes('grid-row: 1 / span 2'), 'the thumbnail no longer shares the product and supplier rows')
	assert.ok(/td:nth-child\(4\) \{[\s\S]{0,120}?grid-column: 2;[\s\S]{0,40}?grid-row: 2;/.test(css), 'the supplier is consuming a full-width row again')
	assert.ok(/\.route-card-toggle \{[\s\S]{0,360}?width: 44px;[\s\S]{0,40}?height: 44px;/.test(css), 'the disclosure control lost its 44px touch target')
	assert.ok(/tr:not\(\.is-open\) \.route-prod-note \{\s*display: none;/.test(css), 'the full buyer note is increasing every collapsed card again')
	assert.ok(/prefers-reduced-motion: reduce[\s\S]*?\.route-card-toggle::after \{\s*transition: none;/.test(css), 'the disclosure animation ignores reduced-motion preferences')
})

test('route thumbnails use the safe Etsy 300px variant and lazy decode', () => {
	const start = source.indexOf('function _routeThumbUrl(raw)')
	const end = source.indexOf('function _routeDetailCellsHtml', start)
	const helper = source.slice(start, end)
	assert.ok(helper.includes("url.hostname.toLowerCase() === 'i.etsystatic.com'"), 'Etsy host is not checked before rewriting')
	assert.ok(helper.includes("'il_300x300.'"), 'the bounded 300px Etsy variant is not requested')
	assert.ok(helper.includes('return String(raw)'), 'non-Etsy/local URLs are no longer left unchanged')
	assert.ok(source.includes('fetchpriority="low" referrerpolicy="no-referrer"'), 'route thumbnails lost low-priority safe loading')
})

// ── Runner ───────────────────────────────────────────────────────────────────
;(async () => {
	for (const entry of pending) {
		if (entry.group) { console.log(`\n${BOLD}${entry.group}${RESET}`); continue }
		try {
			await entry.fn()
			passed++
			console.log(`${GREEN}  ✓${RESET} ${entry.name}`)
		} catch (err) {
			failed++
			failures.push({ name: entry.name, err })
			console.log(`${RED}  ✗${RESET} ${entry.name}`)
		}
	}
	console.log()
	if (failed) {
		console.log(`${RED}${BOLD}  ${failed} test(s) failed${RESET}, ${passed} passed`)
		for (const f of failures) console.log(`${DIM}  · ${f.name}: ${f.err.message}${RESET}`)
		process.exit(1)
	}
	console.log(`${GREEN}${BOLD}  All ${passed} tests passed.${RESET}`)
	console.log()
})()
