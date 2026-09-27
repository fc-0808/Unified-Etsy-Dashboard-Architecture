'use strict'

/**
 * Shops & Sync density contract.
 *
 * The tab used to dump shop cards, a duplicate API-budget summary, and up to
 * 200 history rows onto the page. These tests pin the compact layout: three
 * labelled sections, grouped/scrolled call history, and shop cards that keep
 * auth + remaining budget on two tight rows.
 *
 * Run: node scripts/test-shops-sync-ui.js
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
let passed = 0
let failed = 0
const failures = []
const pending = []
function group(name) {
	pending.push({ group: name })
}
function test(name, fn) {
	pending.push({ name, fn })
}

const HTML = path.resolve(__dirname, '../public/index.html')
const source = fs.readFileSync(HTML, 'utf8').replace(/\r\n/g, '\n')
const START = '// ══ SHOPS & SYNC UI ══'
const END = '// ══ END SHOPS & SYNC UI ══'
const start = source.indexOf(START)
const end = source.indexOf(END)
if (start < 0 || end < 0 || end <= start) {
	console.error(`${RED}Could not locate the Shops & Sync UI sentinels.${RESET}`)
	process.exit(1)
}
const CONTROLLER = source.slice(start, end)

function shopsMarkup() {
	const from = source.indexOf('id="tab-shops"')
	const to = source.indexOf('id="tab-supplies"', from)
	assert.ok(from >= 0 && to > from, 'Shops & Sync tab markup is missing')
	return source.slice(from, to)
}

function shopsCss() {
	const from = source.indexOf('/* Page shell — same density as Shipping / Route')
	const to = source.indexOf('/* ── Route tab', from)
	assert.ok(from >= 0 && to > from, 'Shops & Sync CSS block is missing')
	return source.slice(from, to)
}

function escHtml(str) {
	return String(str ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
}

function makeEnv() {
	const virtualConsole = new VirtualConsole()
	virtualConsole.on('jsdomError', () => {})
	const dom = new JSDOM(
		`<!doctype html><html><body>
			<span id="slShopCount"></span>
			<div id="slCards"></div>
			<div id="slBudgetSection"></div>
			<span id="slFeedCount"></span>
		</body></html>`,
		{ pretendToBeVisual: true, runScripts: 'dangerously', virtualConsole },
	)
	const { window } = dom
	window._syncingSet = new Set()
	window._slShopMap = {}
	window.escHtml = escHtml
	window.fmt = (n) => (n == null ? '—' : String(n))
	window.fmtDate = (iso) => (iso ? 'TIME' : '—')
	window._syncEsc = escHtml
	window.sortShopsForDisplay = (rows) => rows || []
	window.eval(`${CONTROLLER}
window.__shopsUi = {
	slShortGroup,
	slTokenChip,
	slBudgetTone,
	slBudgetHtml,
	slCardHtml,
	slUpdateShopCount,
	renderSlCards,
	slCoalesceBudgetHistory,
	slBudgetUsedCell,
	slBudgetHistoryTable,
	renderBudgetSection,
};`)
	return { window, ui: window.__shopsUi, document: window.document }
}

group('Markup hierarchy')

test('the tab is three labelled sections with Shipping-style headings', () => {
	const markup = shopsMarkup()
	assert.match(markup, /aria-labelledby="slShopsHeading"/)
	assert.match(markup, /aria-labelledby="slBudgetHeading"/)
	assert.match(markup, /aria-labelledby="slActivityHeading"/)
	assert.match(markup, /<h3 id="slShopsHeading">Shops<\/h3>/)
	assert.match(markup, /<h3 id="slBudgetHeading">API Budget<\/h3>/)
	assert.match(markup, /<h3 id="slActivityHeading">Recent Activity<\/h3>/)
	assert.match(markup, /class="sl-section-heading"/)
	assert.match(markup, /Auth, last sync, and remaining API calls for each shop\./)
	assert.match(markup, /Etsy QPD is shared per API key/)
	assert.match(markup, /Latest sync runs across the fleet\./)
})

test('help is a collapsed disclosure, not a second full-width explainer', () => {
	const markup = shopsMarkup()
	assert.match(markup, /<details class="sl-budget-help">/)
	assert.match(markup, /<summary>How this works<\/summary>/)
	assert.doesNotMatch(markup, /slToggleBudgetExplain/)
	assert.doesNotMatch(markup, /slBudgetExplainBtn/)
	assert.doesNotMatch(markup, /How does this work\?/)
	assert.doesNotMatch(markup, /style="margin-top: 24px"/)
})

test('activity feed is a capped scroller and shop cards keep live IDs', () => {
	const markup = shopsMarkup()
	assert.match(markup, /id="slCards"/)
	assert.match(markup, /id="slBudgetSection"/)
	assert.match(markup, /id="syncLogWrap"/)
	assert.match(markup, /class="table-wrap sl-feed-scroll"/)
	assert.match(markup, /id="syncAllBtn"/)
	assert.match(markup, /id="restartBtn"/)
})

group('CSS density')

test('history and activity cannot expand the page to the ring-buffer length', () => {
	const css = shopsCss()
	assert.match(css, /\.sl-budget-history-scroll[\s\S]*?max-height:\s*min\(28vh,\s*220px\)/)
	assert.match(css, /\.sl-feed-scroll[\s\S]*?max-height:\s*min\(32vh,\s*240px\)/)
	assert.match(css, /#tab-shops \.table-wrap\.sl-feed-scroll[\s\S]*?overflow-y:\s*auto/)
	assert.match(css, /\.sl-budget-history th[\s\S]*?position:\s*sticky/)
})

test('shop cards and key meters are padded like Shipping action tiles, not tall panels', () => {
	const css = shopsCss()
	assert.match(css, /\.sl-card\s*\{[^}]*padding:\s*9px 11px 8px/)
	assert.match(css, /\.sl-cards\s*\{[^}]*gap:\s*8px/)
	assert.match(css, /\.sl-budget-key-block\s*\{[^}]*padding:\s*8px 10px 6px/)
	assert.match(css, /#tab-shops\s*\{[^}]*gap:\s*14px/)
})

group('Budget history')

test('consecutive identical reasons collapse into a counted row', () => {
	const { ui } = makeEnv()
	const coalesced = ui.slCoalesceBudgetHistory([
		{ ts: 3, op: 'Fetch orders', remaining: 4178, delta: 1 },
		{ ts: 2, op: 'Fetch orders', remaining: 4179, delta: 1 },
		{ ts: 1, op: 'Inventory check', remaining: 4180, delta: 1 },
	])
	assert.equal(coalesced.length, 2)
	assert.equal(coalesced[0].op, 'Fetch orders')
	assert.equal(coalesced[0].count, 2)
	assert.equal(coalesced[0].delta, 2)
	assert.equal(coalesced[0].remaining, 4178)
	assert.equal(coalesced[1].op, 'Inventory check')
	assert.equal(coalesced[1].count, 1)
})

test('the key block shows a meter, compact meta, and a folded scroller — not a duplicate summary', () => {
	const { ui, document } = makeEnv()
	ui.renderBudgetSection({
		keys: [
			{
				key_id: 'iajrfh…',
				known: true,
				remaining: 4180,
				max: 5000,
				percent_used: 16,
				blocked_for_ms: 0,
				shops: [
					{ shop_id: '1', shop_name: 'Alpha' },
					{ shop_id: '2', shop_name: 'Beta' },
					{ shop_id: '3', shop_name: 'Gamma' },
					{ shop_id: '4', shop_name: 'Delta' },
				],
				history: [
					{ ts: 1, op: 'Fetch orders', remaining: 4181, delta: 1 },
					{ ts: 2, op: 'Fetch orders', remaining: 4180, delta: 1 },
					{ ts: 3, op: 'Inventory check', remaining: 4179, delta: 1 },
				],
			},
		],
	})
	const wrap = document.getElementById('slBudgetSection')
	assert.match(wrap.innerHTML, /sl-budget-key-header/)
	assert.match(wrap.innerHTML, /4180\/5000/)
	assert.match(wrap.innerHTML, /shared by 4 shops/)
	assert.match(wrap.innerHTML, /16% used/)
	assert.match(wrap.innerHTML, /sl-budget-history-fold/)
	assert.match(wrap.innerHTML, /sl-budget-history-scroll/)
	assert.match(wrap.innerHTML, /Call history/)
	assert.match(wrap.innerHTML, /2 groups · 3 calls/)
	assert.match(wrap.innerHTML, /×2/)
	assert.equal(wrap.querySelectorAll('.sl-budget-history tbody tr').length, 2)
	assert.doesNotMatch(wrap.innerHTML, /calls remaining \(/)
	assert.doesNotMatch(wrap.innerHTML, /style="font-size:11px;color:var\(--muted\);margin-bottom:8px"/)
})

test('collapsing call history survives a budget refresh', () => {
	const { ui, document } = makeEnv()
	const payload = {
		keys: [
			{
				key_id: 'key-a',
				known: true,
				remaining: 4000,
				max: 5000,
				shops: [{ shop_id: '1', shop_name: 'Alpha' }],
				history: [{ ts: 1, op: 'Fetch orders', remaining: 4000, delta: 1 }],
			},
		],
	}
	ui.renderBudgetSection(payload)
	const fold = document.querySelector('.sl-budget-history-fold')
	assert.equal(fold.open, true)
	fold.open = false
	ui.renderBudgetSection(payload)
	assert.equal(document.querySelector('.sl-budget-history-fold').open, false)
})

test('shop names in budget meta are escaped', () => {
	const { ui, document } = makeEnv()
	ui.renderBudgetSection({
		keys: [
			{
				key_id: '<script>',
				known: false,
				shops: [{ shop_id: '1', shop_name: '<b>Hack</b>' }],
				history: [],
			},
		],
	})
	const wrap = document.getElementById('slBudgetSection')
	assert.equal(wrap.querySelectorAll('script').length, 0)
	assert.equal(wrap.querySelectorAll('b').length, 0)
	assert.equal(wrap.querySelector('.sl-budget-key-id').textContent, '<script>')
	assert.equal(wrap.querySelector('.sl-budget-key-meta [title]').getAttribute('title'), '<b>Hack</b>')
})

group('Shop cards')

test('a shop card is three rows: identity, auth, last sync + remaining', () => {
	const { ui } = makeEnv()
	const html = ui.slCardHtml(
		{
			shop_id: 's1',
			shop_name: 'Y2KiPhoneCases',
			group_label: 'Canada Post',
			group_id: 'g1',
			token_status: 'active',
			refresh_token_days_remaining: 8,
			last_synced_at: 1750000000,
			last_sync_status: 'success',
			api_budget: { known: true, remaining: 4180, max: 5000, api_key_id: 'iajrfh…', key_shop_count: 4, percent_used: 16, blocked_for_ms: 0 },
		},
		false,
	)
	assert.match(html, /sl-card-row1/)
	assert.match(html, /sl-card-row2/)
	assert.match(html, /sl-card-foot/)
	assert.doesNotMatch(html, /sl-card-row3/)
	assert.match(html, /Token active/)
	assert.match(html, />8d</)
	assert.match(html, /8d to expiry/)
	assert.match(html, /Y2KiPhoneCases · Canada Post/)
	assert.match(html, /4180\/5000/)
	const visible = html.replace(/ title="[^"]*"/g, '')
	assert.doesNotMatch(visible, /shared by 4 shops/)
	assert.doesNotMatch(visible, />API 4180/)
})

test('unknown budget stays a compact pill and dangerous names are escaped', () => {
	const { ui } = makeEnv()
	const html = ui.slCardHtml(
		{
			shop_id: 's2',
			shop_name: 'Shop <img>',
			group_label: 'HK',
			token_status: 'unknown',
			api_budget: { known: false, api_key_id: 'ab<"x' },
		},
		false,
	)
	assert.match(html, /Shop &lt;img&gt;/)
	assert.match(html, /API unknown/)
	assert.match(html, /ab&lt;&quot;x/)
	assert.doesNotMatch(html, /<img>/)
})

test('tone thresholds match the previous 300 / 800 budget bands', () => {
	const { ui } = makeEnv()
	assert.equal(ui.slBudgetTone(null), 'unknown')
	assert.equal(ui.slBudgetTone(300), 'bad')
	assert.equal(ui.slBudgetTone(301), 'warn')
	assert.equal(ui.slBudgetTone(800), 'warn')
	assert.equal(ui.slBudgetTone(801), 'good')
})

test('renderSlCards writes the fleet count', () => {
	const { ui, document } = makeEnv()
	ui.renderSlCards([
		{ shop_id: 'a', shop_name: 'Alpha', token_status: 'active' },
		{ shop_id: 'b', shop_name: 'Beta', token_status: 'active' },
	])
	assert.equal(document.getElementById('slShopCount').textContent, '2 shops')
	assert.equal(document.querySelectorAll('.sl-card').length, 2)
	ui.renderSlCards([])
	assert.equal(document.getElementById('slShopCount').textContent, '0 shops')
	assert.match(document.getElementById('slCards').innerHTML, /No shops found/)
})

group('i18n')

test('new Shops & Sync phrases are in the Chinese dictionary', () => {
	const dictStart = source.indexOf('const I18N_DICT = {')
	const dictEnd = source.indexOf('const I18N_PATTERNS', dictStart)
	const dict = source.slice(dictStart, dictEnd)
	for (const phrase of [
		'Auth, last sync, and remaining API calls for each shop.',
		'Etsy QPD is shared per API key. Values are last-known from response headers.',
		'Latest sync runs across the fleet.',
		'How this works',
		'Call history',
		'Recent Activity',
		'No calls yet',
	]) {
		assert.ok(dict.includes(`'${phrase}'`), `missing I18N key: ${phrase}`)
	}
	const patterns = source.slice(dictEnd, source.indexOf('const I18N = (() => {', dictEnd))
	assert.match(patterns, /\(\\d\+\) shops\$/)
	assert.match(patterns, /\(\\d\+\) groups · \(\\d\+\) calls/)
})

console.log(`${BOLD}Shops & Sync UI contract${RESET}\n`)
for (const item of pending) {
	if (item.group) {
		console.log(`${DIM}${item.group}${RESET}`)
		continue
	}
	try {
		item.fn()
		passed += 1
		console.log(`  ${GREEN}ok${RESET}  — ${item.name}`)
	} catch (err) {
		failed += 1
		failures.push({ name: item.name, err })
		console.error(`  ${RED}FAIL${RESET} — ${item.name}`)
		console.error(`         ${err.message}`)
	}
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
