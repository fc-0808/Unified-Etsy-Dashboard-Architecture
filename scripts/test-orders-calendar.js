'use strict'

/**
 * Orders date-picker calendar — placement counts per day.
 *
 * Pins the invariants that make the popover trustworthy:
 *   1. The SQL rollup buckets etsy_created_at on the SAME local midnight as
 *      GET /api/orders' date_from/date_to filter.
 *   2. Provisional ghost receipts and suppressed duplicates are excluded, so a
 *      cell's number is the list you get by picking that day.
 *   3. The widget paints those counts, selects a day into the existing date
 *      inputs, and never opens the native OS picker.
 *
 * Run: node scripts/test-orders-calendar.js
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('node:assert/strict')
const { JSDOM, VirtualConsole } = require('jsdom')
const { initDb } = require('../src/db/setup')
const calendarCounts = require('../src/orders/calendar-counts')
const cal = require('../public/orders-calendar')
const policy = require('../src/auth/policy')

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const RESET = '\x1b[0m'
let passed = 0
let failed = 0

function test(name, fn) {
	try {
		fn()
		passed++
		console.log(`  ${GREEN}ok${RESET}  — ${name}`)
	} catch (err) {
		failed++
		console.error(`  ${RED}FAIL${RESET} — ${name}`)
		console.error(`         ${err.message}`)
	}
}

async function testAsync(name, fn) {
	try {
		await fn()
		passed++
		console.log(`  ${GREEN}ok${RESET}  — ${name}`)
	} catch (err) {
		failed++
		console.error(`  ${RED}FAIL${RESET} — ${name}`)
		console.error(`         ${err.message}`)
	}
}

const HTML = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8')
const CSS = fs.readFileSync(path.resolve(__dirname, '../public/orders-calendar.css'), 'utf8')
const JS = fs.readFileSync(path.resolve(__dirname, '../public/orders-calendar.js'), 'utf8')

console.log('Orders calendar\n')

test('dashboard hosts the calendar assets', () => {
	assert.match(HTML, /href="\/orders-calendar\.css"/)
	assert.match(HTML, /src="\/orders-calendar\.js"/)
	assert.match(HTML, /id="filterDateFrom"/)
	assert.match(HTML, /id="filterDateTo"/)
})

test('calendar CSS is a dark popover with a reserved count slot', () => {
	assert.match(CSS, /\.orders-cal\b/)
	assert.match(CSS, /\.orders-cal-count/)
	assert.match(CSS, /min-height:\s*11px/)
	assert.match(CSS, /font-variant-numeric:\s*tabular-nums/)
	assert.doesNotMatch(CSS, /background:\s*#fff/)
})

test('widget source never opens a native date picker', () => {
	assert.match(JS, /setAttribute\('readonly'/)
	assert.match(JS, /showPicker/)
	assert.match(JS, /\/api\/orders\/calendar-counts/)
})

test('parseIsoDay rejects overflow dates', () => {
	assert.equal(calendarCounts.parseIsoDay('2026-09-07').iso, '2026-09-07')
	assert.equal(calendarCounts.parseIsoDay('2026-02-31'), null)
	assert.equal(calendarCounts.parseIsoDay('nope'), null)
	assert.equal(cal.parseIsoDay('2026-09-07').iso, '2026-09-07')
	assert.equal(cal.parseIsoDay('2026-02-31'), null)
})

test('a six-week grid is always 42 cells and reports its range', () => {
	const sunday = cal.monthGrid(2026, 9, 0)
	assert.equal(sunday.length, 42)
	assert.equal(sunday[0].iso, '2026-08-30')
	assert.equal(sunday[sunday.length - 1].iso, '2026-10-10')
	assert.equal(sunday.filter((c) => c.inMonth).length, 30)
	const range = cal.gridRange(2026, 9, 0)
	assert.equal(range.from, '2026-08-30')
	assert.equal(range.to, '2026-10-10')
})

test('Monday-start grids shift the leading padding', () => {
	const monday = cal.monthGrid(2026, 9, 1)
	assert.equal(monday[0].iso, '2026-08-31')
	assert.equal(monday[1].iso, '2026-09-01')
})

test('heat and compact labels stay quiet on empty days', () => {
	assert.equal(cal.heatLevel(0, 12), 0)
	assert.equal(cal.heatLevel(1, 12), 1)
	assert.equal(cal.heatLevel(12, 12), 4)
	assert.equal(cal.compactCount(0), '')
	assert.equal(cal.compactCount(12), '12')
	assert.equal(cal.compactCount(100), '99+')
})

test('access policy treats calendar counts as an orders read', () => {
	assert.equal(policy.authorizeApi('owner', 'GET', '/api/orders/calendar-counts').allowed, true)
	assert.equal(policy.authorizeApi('packer', 'GET', '/api/orders/calendar-counts').allowed, true)
	assert.equal(policy.authorizeApi('shopper', 'GET', '/api/orders/calendar-counts').allowed, false)
})

const tmpPath = path.join(os.tmpdir(), `orders-cal-test-${process.pid}-${Date.now()}.db`)
const db = initDb(tmpPath)
const DAY = 24 * 3600
const sept7 = calendarCounts.parseIsoDay('2026-09-07')
const sept7Start = sept7.startSec

db.prepare('INSERT INTO groups (group_id, label) VALUES (?,?)').run('g1', 'Group 1')
db.prepare('INSERT INTO shops (shop_id, group_id, shop_name) VALUES (?,?,?)').run('s1', 'g1', 'Shop One')
db.prepare('INSERT INTO shops (shop_id, group_id, shop_name) VALUES (?,?,?)').run('s2', 'g1', 'Shop Two')

const seed = db.prepare(`
	INSERT INTO receipts (
		receipt_id, shop_id, group_id, name, status, is_paid, is_shipped,
		etsy_created_at, first_ship_by, source
	) VALUES (@receipt_id, @shop_id, 'g1', @name, @status, @is_paid, @is_shipped, @created, @ship_by, @source)
`)

const rows = [
	{ receipt_id: 1, shop_id: 's1', name: 'a', status: 'Paid', is_paid: 1, is_shipped: 0, created: sept7Start + 3600, ship_by: sept7Start + DAY, source: 'etsy' },
	{ receipt_id: 2, shop_id: 's1', name: 'b', status: 'Paid', is_paid: 1, is_shipped: 1, created: sept7Start + 7200, ship_by: sept7Start + DAY, source: 'etsy' },
	{ receipt_id: 3, shop_id: 's1', name: 'c', status: 'Paid', is_paid: 1, is_shipped: 0, created: sept7Start + DAY + 60, ship_by: sept7Start + 2 * DAY, source: 'etsy' },
	{ receipt_id: 4, shop_id: 's2', name: 'other-shop', status: 'Paid', is_paid: 1, is_shipped: 0, created: sept7Start + 1800, ship_by: sept7Start + DAY, source: 'etsy' },
	{ receipt_id: 5, shop_id: 's1', name: 'ghost', status: 'Paid', is_paid: 0, is_shipped: 0, created: sept7Start + 900, ship_by: null, source: 'etsy' },
	{ receipt_id: 6, shop_id: 's1', name: 'dup', status: 'Paid', is_paid: 1, is_shipped: 0, created: sept7Start + 4000, ship_by: sept7Start + DAY, source: 'etsy' },
	{ receipt_id: 7, shop_id: 's1', name: 'null-ts', status: 'Paid', is_paid: 1, is_shipped: 0, created: null, ship_by: sept7Start + DAY, source: 'etsy' },
]
for (const r of rows) seed.run(r)

test('rollup counts local placement days and omits zeros', () => {
	const result = calendarCounts.listOrderDayCounts(db, { from: '2026-09-01', to: '2026-09-30' })
	assert.equal(result.counts['2026-09-07'], 4, 'three s1 + one s2 on the 7th (ghost excluded)')
	assert.equal(result.counts['2026-09-08'], 1)
	assert.equal(result.counts['2026-09-06'], undefined)
	assert.equal(result.total, 5)
})

test('shop filter and suppressed ids match the orders list', () => {
	const shop = calendarCounts.listOrderDayCounts(db, { from: '2026-09-07', to: '2026-09-07', shopId: 's1' })
	assert.equal(shop.counts['2026-09-07'], 3)
	const hidden = calendarCounts.listOrderDayCounts(db, {
		from: '2026-09-07',
		to: '2026-09-07',
		shopId: 's1',
		suppressedIds: new Set([6]),
	})
	assert.equal(hidden.counts['2026-09-07'], 2)
})

test('provisional unpaid receipts never inflate a cell', () => {
	const onlyGhostDay = calendarCounts.listOrderDayCounts(db, { from: '2026-09-07', to: '2026-09-07', shopId: 's1' })
	assert.equal(onlyGhostDay.total, 3)
})

test('bad ranges are rejected with BAD_RANGE', () => {
	assert.throws(() => calendarCounts.listOrderDayCounts(db, { from: '2026-02-31', to: '2026-09-07' }), (err) => err.code === 'BAD_RANGE')
	assert.throws(() => calendarCounts.listOrderDayCounts(db, { from: '2026-09-08', to: '2026-09-07' }), (err) => err.code === 'BAD_RANGE')
	assert.throws(
		() => calendarCounts.listOrderDayCounts(db, { from: '2026-01-01', to: '2026-12-31' }),
		(err) => err.code === 'BAD_RANGE' && /45/.test(err.message),
	)
})

function mountFixture() {
	const virtualConsole = new VirtualConsole()
	const errors = []
	virtualConsole.on('jsdomError', (err) => errors.push(err))
	const dom = new JSDOM(
		`<!doctype html><html><body>
			<div id="ordersFilters">
				<select id="filterShop"><option value="">All shops</option><option value="s1">Shop One</option></select>
				<div class="date-range-wrap">
					<input type="date" id="filterDateFrom" />
					<input type="date" id="filterDateTo" />
				</div>
			</div>
		</body></html>`,
		{ pretendToBeVisual: true, virtualConsole, url: 'http://127.0.0.1/' },
	)
	const { window } = dom
	window.I18N = { t: (s) => s, get: () => 'en' }
	const fetches = []
	const fetchImpl = async (url) => {
		fetches.push(String(url))
		return {
			ok: true,
			json: async () => ({ counts: { '2026-09-07': 12, '2026-09-08': 3 }, total: 15 }),
		}
	}
	const instance = cal.mount({
		window,
		document: window.document,
		fromInput: window.document.getElementById('filterDateFrom'),
		toInput: window.document.getElementById('filterDateTo'),
		shopSelect: window.document.getElementById('filterShop'),
		fetch: fetchImpl,
		now: () => new Date(2026, 8, 7, 15, 0, 0),
		weekStartsOn: 0,
		locale: 'en-US',
	})
	return { window, instance, fetches, errors }
}

async function waitCounts(instance) {
	for (let i = 0; i < 25; i++) {
		const state = instance.getState()
		if (!state.loading && state.counts && state.counts['2026-09-07'] === 12) return
		await new Promise((r) => setImmediate(r))
	}
	throw new Error('calendar counts did not load')
}

;(async () => {
	await testAsync('mount intercepts the native picker and opens a dialog', async () => {
		const { window, instance } = mountFixture()
		const from = window.document.getElementById('filterDateFrom')
		assert.equal(from.getAttribute('readonly'), '')
		assert.equal(from.getAttribute('aria-haspopup'), 'dialog')
		from.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
		assert.equal(instance.isOpen(), true)
		const dialog = window.document.querySelector('.orders-cal')
		assert.ok(dialog)
		assert.equal(dialog.hidden, false)
		assert.equal(dialog.getAttribute('role'), 'dialog')
		assert.equal(window.document.querySelectorAll('.orders-cal-day').length, 42)
		instance.destroy()
	})

	await testAsync('each day paints its order count and heat', async () => {
		const { window, instance } = mountFixture()
		const from = window.document.getElementById('filterDateFrom')
		from.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
		await waitCounts(instance)
		const day = window.document.querySelector('[data-date="2026-09-07"]')
		assert.ok(day, 'September 7 is on the grid')
		assert.equal(day.querySelector('.orders-cal-count').textContent, '12')
		assert.equal(day.getAttribute('data-heat'), '4')
		assert.match(day.getAttribute('aria-label'), /12 orders/)
		const empty = window.document.querySelector('[data-date="2026-09-01"]')
		assert.equal(empty.querySelector('.orders-cal-count').textContent, '')
		assert.equal(empty.getAttribute('data-heat'), '0')
		const summary = window.document.querySelector('[data-cal-summary]')
		assert.match(summary.textContent, /this month/)
		instance.destroy()
	})

	await testAsync('choosing a day writes the active input and closes', async () => {
		const { window, instance } = mountFixture()
		const from = window.document.getElementById('filterDateFrom')
		let changed = 0
		from.addEventListener('change', () => changed++)
		from.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
		await waitCounts(instance)
		window.document.querySelector('[data-date="2026-09-07"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
		assert.equal(from.value, '2026-09-07')
		assert.equal(instance.isOpen(), false)
		assert.equal(changed, 1)
		instance.destroy()
	})

	await testAsync('Today and Clear target the field that opened the popover', async () => {
		const { window, instance } = mountFixture()
		const to = window.document.getElementById('filterDateTo')
		to.value = '2026-09-01'
		to.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
		window.document.querySelector('[data-cal-today]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
		assert.equal(to.value, '2026-09-07')
		to.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
		window.document.querySelector('[data-cal-clear]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
		assert.equal(to.value, '')
		instance.destroy()
	})

	await testAsync('Escape and outside click dismiss the dialog', async () => {
		const { window, instance } = mountFixture()
		const from = window.document.getElementById('filterDateFrom')
		from.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
		assert.equal(instance.isOpen(), true)
		window.document.querySelector('.orders-cal').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
		assert.equal(instance.isOpen(), false)
		from.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
		window.document.body.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }))
		assert.equal(instance.isOpen(), false)
		instance.destroy()
	})

	await testAsync('an inverted range is collapsed to a single day', async () => {
		const { window, instance } = mountFixture()
		const from = window.document.getElementById('filterDateFrom')
		const to = window.document.getElementById('filterDateTo')
		from.value = '2026-09-10'
		to.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
		await waitCounts(instance)
		window.document.querySelector('[data-date="2026-09-03"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
		assert.equal(from.value, '2026-09-03')
		assert.equal(to.value, '2026-09-03')
		instance.destroy()
	})

	try {
		db.close()
		fs.unlinkSync(tmpPath)
	} catch {
		/* temp file */
	}

	if (failed) {
		console.error(`\n${failed} failed, ${passed} passed`)
		process.exit(1)
	}
	console.log(`\n${passed} passed`)
})().catch((err) => {
	console.error(err)
	process.exit(1)
})
