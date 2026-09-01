'use strict'

/**
 * Regression test — the Orders tab must warn about ship-by deadlines BEFORE
 * they are missed.
 *
 * WHY THIS EXISTS
 * ----------------------------------------------------------------------------
 * Etsy grades a shop on dispatching by the date it promised the buyer, and the
 * row-level countdown chip only helps someone already reading that row. With a
 * page of 200 orders nothing said "three of these are due before tonight", so
 * the deadline that mattered was the one nobody happened to scroll past.
 *
 * The fix has two halves and this test covers both:
 *
 *   SERVER  /api/orders returns `shipping_deadlines` — raw ship-by timestamps
 *           for every unshipped order that is overdue or due within 48h,
 *           DATABASE-WIDE, so paging or filtering can never hide one. An
 *           order's deadline is the EARLIEST of its transactions, matching what
 *           the card renders; `first_ship_by` alone is the first line's date and
 *           can be later than that.
 *
 *   PAGE    The banner derives its own counts from those timestamps every
 *           second, so "overdue" and "due within 24h" stay exact as the clock
 *           crosses a threshold, with no refetch. The banner code under test is
 *           extracted from public/index.html — this exercises shipped code.
 *
 * Run: `node scripts/test-ship-deadlines.js` (or `npm run test:ship-deadlines`)
 * Exit code 0 = all assertions pass, 1 = a regression was detected.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { JSDOM, VirtualConsole } = require('jsdom')
const { initDb } = require('../src/db/setup')

let failures = 0
function assert(cond, msg) {
	if (cond) console.log(`  ok  — ${msg}`)
	else {
		failures++
		console.error(`  FAIL — ${msg}`)
	}
}
function section(title) {
	console.log(`\n  ${title}`)
}

const HOUR = 3600
const DAY = 24 * HOUR

// ── The page's banner, extracted from the shipped file ───────────────────────
const PAGE = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8')
const START = '// ══ SHIP-BY DEADLINE ══'
const END = '// ══ END SHIP-BY DEADLINE ══'
const s = PAGE.indexOf(START)
const e = PAGE.indexOf(END)
if (s < 0 || e <= s) {
	console.error('Could not locate the ship-by deadline sentinels in public/index.html.')
	process.exit(1)
}
const BANNER_SRC = PAGE.slice(s, e)

/** A page with just the banner markup, running the real banner code. */
function makeBannerEnv() {
	const virtualConsole = new VirtualConsole()
	virtualConsole.on('jsdomError', () => {})
	const dom = new JSDOM(
		`<!doctype html><html><body>
       <div class="deadline-banner" id="deadlineBanner">
         <div class="dlb-text"><div id="deadlineBannerHead"></div><div id="deadlineBannerSub"></div></div>
       </div>
     </body></html>`,
		{ runScripts: 'dangerously', virtualConsole },
	)
	const { window } = dom
	// Faithful copy of the page's own escaper; the banner is the unit under test.
	window.eval(`function escHtml(x){return String(x==null?'':x).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}`)
	window.eval(BANNER_SRC)
	const el = window.document.getElementById('deadlineBanner')
	return {
		window,
		/** @param {number[]} secs Unix seconds @param {number} nowMs */
		render(secs, nowMs, truncated = false) {
			window.setShippingDeadlines(secs, truncated)
			window.renderDeadlineBanner(nowMs)
			return {
				shown: el.classList.contains('show'),
				overdueStyle: el.classList.contains('is-overdue'),
				head: window.document.getElementById('deadlineBannerHead').textContent,
				sub: window.document.getElementById('deadlineBannerSub').innerHTML,
			}
		},
	}
}

// ── Server harness ───────────────────────────────────────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ued-deadlines-'))
const dbPath = path.join(tmpDir, 'test.db')
const configPath = path.join(tmpDir, 'config.json')
const port = 4400 + (process.pid % 400)
const base = `http://127.0.0.1:${port}`

async function waitForHealth(child, timeoutMs = 40_000) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (child.exitCode != null) throw new Error(`Server exited early (${child.exitCode})`)
		try {
			if ((await fetch(base + '/api/health')).ok) return
		} catch {}
		await new Promise((r) => setTimeout(r, 300))
	}
	throw new Error('Server did not become healthy in time')
}

const NOW = Math.floor(Date.now() / 1000)
const TX = (dates) => JSON.stringify(dates.map((d, i) => ({ title: `Line ${i}`, listing_id: 900 + i, quantity: 1, expected_ship_date: d })))

function seed(db) {
	db.prepare('INSERT INTO groups (group_id, label) VALUES (?,?)').run('G1', 'Group 1')
	db.prepare('INSERT INTO shops (shop_id, group_id, shop_name) VALUES (?,?,?)').run('S1', 'G1', 'Y2KASEshop')
	db.prepare('INSERT INTO shops (shop_id, group_id, shop_name) VALUES (?,?,?)').run('S2', 'G1', 'OtherShop')

	const ins = db.prepare(`
    INSERT INTO receipts
      (receipt_id, shop_id, group_id, name, status, is_paid, is_shipped,
       first_ship_by, all_transactions, etsy_created_at)
    VALUES (@receipt_id, @shop_id, 'G1', @name, @status, @is_paid, @is_shipped,
            @first_ship_by, @all_transactions, @etsy_created_at)`)
	const base_ = { shop_id: 'S1', status: 'Paid', is_paid: 1, is_shipped: 0, etsy_created_at: NOW - 3 * DAY }
	const row = (o) => ins.run({ ...base_, ...o })

	// Due in 3h — the case the banner exists for.
	row({ receipt_id: 4001, name: 'Due Soon', first_ship_by: NOW + 3 * HOUR, all_transactions: TX([NOW + 3 * HOUR]) })
	// Due in 30h — inside the 48h payload horizon, but NOT within 24h.
	row({ receipt_id: 4002, name: 'Due Later', first_ship_by: NOW + 30 * HOUR, all_transactions: TX([NOW + 30 * HOUR]) })
	// Two days late.
	row({ receipt_id: 4003, name: 'Overdue', first_ship_by: NOW - 2 * DAY, all_transactions: TX([NOW - 2 * DAY]) })
	// Already shipped — a deadline it has met is not a deadline.
	row({ receipt_id: 4004, name: 'Shipped', is_shipped: 1, status: 'Completed', first_ship_by: NOW + HOUR, all_transactions: TX([NOW + HOUR]) })
	// Cancelled — nothing to dispatch.
	row({ receipt_id: 4005, name: 'Cancelled', status: 'Canceled', first_ship_by: NOW + HOUR, all_transactions: TX([NOW + HOUR]) })
	// Five days out — beyond the horizon, not yet anyone's problem.
	row({ receipt_id: 4006, name: 'Far Off', first_ship_by: NOW + 5 * DAY, all_transactions: TX([NOW + 5 * DAY]) })
	// Multi-line: first_ship_by is the FIRST line (40h), the real deadline is the
	// EARLIEST (2h). Getting this wrong silently under-reports urgent work.
	row({ receipt_id: 4007, name: 'Multi Line', shop_id: 'S2', first_ship_by: NOW + 40 * HOUR, all_transactions: TX([NOW + 40 * HOUR, NOW + 2 * HOUR]) })
	// Malformed transaction blob — must fall back to the column, not throw.
	row({ receipt_id: 4008, name: 'Bad JSON', first_ship_by: NOW + 4 * HOUR, all_transactions: 'not json at all' })
	// Provisional receipt (unpaid, unshipped, no ship-by): never actionable work.
	row({ receipt_id: 4009, name: 'Provisional', is_paid: 0, status: 'Payment processing', first_ship_by: null, all_transactions: null })
	// No deadline at all, but real — must sort last, never counted.
	row({ receipt_id: 4010, name: 'No Deadline', first_ship_by: null, all_transactions: TX([]) })
}

async function getJson(qs) {
	const res = await fetch(base + '/api/orders' + qs)
	return { status: res.status, body: await res.json().catch(() => ({})) }
}

;(async () => {
	console.log('Ship-by deadline reminder regression test')

	// ── 1. The banner's own arithmetic ────────────────────────────────────────
	// Pure, clock-driven, and the part that decides whether a human is warned.
	section('What the banner says, second by second')
	{
		const env = makeBannerEnv()
		const t = 1_800_000_000_000 // fixed clock (ms)
		const H = 3600_000

		assert(env.render([], t).shown === false, 'nothing due and nothing late renders no banner at all')

		const soon = env.render([(t + 3 * H) / 1000], t)
		assert(soon.shown === true, 'an order due in 3 hours raises the banner')
		assert(soon.head === '1 order must ship within 24 hours', '…and says exactly how many, in the singular')
		assert(soon.overdueStyle === false, '…in the amber "still time" treatment, not the red one')
		assert(/Next deadline in <span class="dlb-countdown">3h 0m 0s<\/span>/.test(soon.sub), '…with a live countdown to the closest deadline')

		const two = env.render([(t + 3 * H) / 1000, (t + 5 * H) / 1000], t)
		assert(two.head === '2 orders must ship within 24 hours', 'the plural is handled')

		assert(env.render([(t + 25 * H) / 1000], t).shown === false, 'an order due in 25 hours is not yet urgent — the banner stays silent')
		assert(env.render([(t + 23.99 * H) / 1000], t).shown === true, '…and one due in just under 24 hours is')

		const late = env.render([(t - 2 * 24 * H) / 1000], t)
		assert(late.overdueStyle === true, 'a breached deadline switches the banner to red')
		assert(late.head === '1 order is past the ship-by deadline', '…and states the breach rather than a countdown')
		assert(/2d 0h 0m 0s overdue/.test(late.sub), '…reporting how far past it the oldest one is')

		const both = env.render([(t - 1 * H) / 1000, (t + 2 * H) / 1000], t)
		assert(both.head === '1 order is past the ship-by deadline · 1 more due within 24 hours', 'a mixed queue reports the breach AND the work still in hand')
		assert(both.overdueStyle === true, '…and takes the more severe of the two treatments')
		assert(/Oldest is[\s\S]*Next deadline in/.test(both.sub), '…with both the worst breach and the next deadline on the sub-line')

		// The boundary that decides overdue-vs-soon, checked exactly.
		assert(env.render([t / 1000], t).head === '1 order is past the ship-by deadline', 'a deadline landing exactly now counts as overdue, not as time remaining')

		const trunc = env.render([(t + 1 * H) / 1000], t, true)
		assert(/more beyond the first 750/.test(trunc.sub), 'a truncated payload says so instead of quietly under-reporting')

		// Re-rendering the same set must not leave a stale banner behind.
		assert(env.render([], t).shown === false, 'clearing the queue hides the banner again')

		env.window.document.body.classList.add('mode-packer')
		const bench = env.render([(t + 3 * H) / 1000], t)
		assert(bench.shown === false, 'packing mode suppresses the banner even when deadlines are urgent')
		env.window.document.body.classList.remove('mode-packer')
		assert(env.render([(t + 3 * H) / 1000], t).shown === true, '…and the banner returns once packing mode is off')
	}

	// ── 2. The server half ────────────────────────────────────────────────────
	section('Which orders the server reports as urgent')
	fs.writeFileSync(
		configPath,
		JSON.stringify({
			db_path: dbPath,
			sync_interval_minutes: 1440,
			groups: [{ group_id: 'G1', label: 'Deadline test', proxy: 'direct', shops: [{ shop_id: 'S1', shop_name: 'Y2KASEshop', api_key: 'deadlinetestkey000000001', shared_secret: 'deadlinetestsecret000001' }] }],
		}),
		'utf8',
	)
	seed(initDb(dbPath))

	const child = spawn(process.execPath, [path.resolve(__dirname, '../src/server/index.js')], {
		env: { ...process.env, PORT: String(port), DASHBOARD_CONFIG_PATH: configPath, EMBEDDED_SYNC: '0', DASHBOARD_OWNER_PASSWORD: '', DASHBOARD_PACKER_PASSWORD: '', DASHBOARD_SHOPPER_PASSWORD: '' },
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	let stderr = ''
	child.stdout.on('data', () => {})
	child.stderr.on('data', (c) => {
		stderr += c.toString()
	})

	try {
		await waitForHealth(child)

		const { status, body } = await getJson('?shipped=false&limit=200')
		assert(status === 200, 'the orders list responds')
		const got = body.shipping_deadlines || []

		// 4001 (+3h), 4003 (−2d), 4007 (+2h via its earliest line), 4008 (+4h),
		// 4002 (+30h, inside the 48h horizon). Nothing else qualifies.
		assert(got.length === 5, `exactly the five in-horizon unshipped orders are reported (got ${got.length})`)
		assert(got.includes(NOW - 2 * DAY), 'an overdue order is reported')
		assert(got.includes(NOW + 3 * HOUR), 'an order due in hours is reported')
		assert(got.includes(NOW + 2 * HOUR), 'a multi-line order is reported at its EARLIEST line, not its first — the whole order is late if any line is')
		assert(!got.includes(NOW + 40 * HOUR), '…so its later line is not what gets counted')
		assert(got.includes(NOW + 4 * HOUR), 'an order with a malformed transaction blob falls back to its stored date instead of vanishing')
		assert(got.includes(NOW + 30 * HOUR), 'an order due in 30h is sent so the page can count it the moment it crosses 24h')
		assert(!got.includes(NOW + 5 * DAY), 'an order due in five days is beyond the horizon')
		assert(!got.includes(NOW + HOUR), 'neither a shipped nor a cancelled order contributes a deadline')
		assert(
			got.every((v, i) => i === 0 || v >= got[i - 1]),
			'deadlines arrive sorted, so the page can take the worst and the next from the ends',
		)
		assert(body.shipping_deadlines_truncated === false, 'a small queue is not flagged as truncated')

		// Database-wide is the whole point: a deadline does not stop counting
		// because the operator narrowed the view or paged past it.
		const shipped = await getJson('?shipped=true&limit=200')
		assert((shipped.body.shipping_deadlines || []).length === 5, 'the Shipped view still reports them — a deadline is not hidden by the tab you happen to be on')
		const oneShop = await getJson('?shipped=false&shop_id=S2&limit=200')
		assert((oneShop.body.orders || []).length === 1, 'filtering to one shop narrows the LIST')
		assert((oneShop.body.shipping_deadlines || []).length === 5, '…but not the deadline count, which is an obligation across the whole business')
		const paged = await getJson('?shipped=false&limit=1')
		assert((paged.body.orders || []).length === 1 && (paged.body.shipping_deadlines || []).length === 5, 'a one-row page still reports every deadline — pagination cannot hide one')

		section('Sorting by the closest deadline')
		const sorted = await getJson('?shipped=false&sort=ship_by_soonest&limit=200')
		const ids = (sorted.body.orders || []).map((o) => o.receipt_id)
		assert(ids[0] === 4003, 'the most overdue order comes first')
		assert(ids[1] === 4007, '…then the multi-line order, ranked by its earliest line rather than its stored one')
		assert(ids[2] === 4001 && ids[3] === 4008 && ids[4] === 4002, '…then the rest in deadline order')
		assert(ids[ids.length - 1] === 4010, 'an order with no deadline sorts last — it is never the most urgent thing on screen')

		const rev = await getJson('?shipped=false&sort=ship_by_latest&limit=200')
		const revIds = (rev.body.orders || []).map((o) => o.receipt_id)
		assert(revIds[0] === 4006, 'the reverse sort leads with the furthest-away deadline')
		assert(revIds[revIds.length - 1] === 4010, '…and still parks the undated order last, not at the top')

		assert(!/ship-by deadline rollup failed/.test(stderr), 'the rollup ran without falling back to its error path')
	} finally {
		child.kill()
		await new Promise((r) => setTimeout(r, 200))
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true })
		} catch {
			/* ignore */
		}
	}

	// ── 3. Page wiring ────────────────────────────────────────────────────────
	section('The Orders page is actually wired to the rollup')
	{
		assert(/id="deadlineBanner"/.test(PAGE), 'the Orders view carries the deadline banner')
		assert(/setShippingDeadlines\(\s*data\.shipping_deadlines/.test(PAGE), '…fed from the orders response on every fetch')
		assert(/renderDeadlineBanner\(now\)/.test(PAGE), '…and repainted by the one-second countdown engine, so it never goes stale')
		assert(/value="ship_by_soonest"/.test(PAGE), 'the sort dropdown offers deadline order')
		assert(/is-deadline-critical|is-deadline-overdue/.test(PAGE), 'rows carry a deadline accent so the urgent ones can be found by scanning')
		assert(/prefers-reduced-motion/.test(PAGE), 'the pulsing chip is disabled for users who ask for reduced motion')
		assert(/id="deadlineBannerHead" role="status" aria-live="polite"/.test(PAGE), 'the headline announces itself to a screen reader without stealing focus')
		assert(/id="deadlineBannerSub" aria-live="off"/.test(PAGE), '…while the per-second countdown is NOT a live region, so it never talks over the user')
		assert(/body\.mode-packer\s+#deadlineBanner/.test(PAGE), 'packing mode hides the deadline banner on the bench')
	}

	// ── 4. "Show them" actually shows them ────────────────────────────────────
	// Regression coverage for a real bug: the owner Orders view defaults its
	// date range to "placed today" (_initOrdersFilterDefaults), filtered on
	// etsy_created_at. A ship-by deadline has nothing to do with placement
	// date, so a left-over "today" window silently reduced this button to an
	// empty list on any day the most urgent order happened to be placed
	// earlier — which, given normal processing lag, is most days. The button
	// must clear that window (and every other filter that could hide the
	// queue) rather than just changing sort/status and hoping nothing else
	// is pinned.
	section('"Show them" clears every filter that could hide the deadline queue')
	{
		const virtualConsole = new VirtualConsole()
		virtualConsole.on('jsdomError', () => {})
		const dom = new JSDOM(
			`<!doctype html><html><body>
        <select id="filterSort"><option value="newest">Newest first</option><option value="ship_by_soonest">Ship by soonest</option></select>
        <select id="filterShipped"><option value="all">All orders</option><option value="false">Needs shipping</option></select>
        <select id="filterExpedited"><option value="">All shipping</option><option value="true">Express only</option></select>
        <input type="date" id="filterDateFrom" />
        <input type="date" id="filterDateTo" />
        <button id="dateClearBtn" class="visible"></button>
        <div id="packerPresets"><button class="packer-preset-btn active"></button></div>
        <div id="packerPackagedDays" class="is-open">stale markup</div>
      </body></html>`,
			{ runScripts: 'dangerously', virtualConsole },
		)
		const { window } = dom
		window.eval(`function escHtml(x){return String(x==null?'':x).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}`)

		// Minimal stand-ins for the globals showOrdersByDeadline reaches out to.
		let loadOrdersCalls = 0
		window.loadOrders = () => {
			loadOrdersCalls++
		}
		window.ordersOffset = 3
		let closedArchive = false
		window.closePackagedDaysArchive = () => {
			closedArchive = true
		}
		let btnsUpdated = false
		window._updateDeadlineSelectBtns = () => {
			btnsUpdated = true
		}

		window.eval(BANNER_SRC)

		// Simulate the state the owner Orders view is actually in when the
		// banner appears: today's date window pinned (the default), an
		// Express-only filter left on from earlier browsing, and a packer
		// preset marked active.
		const today = new Date().toISOString().slice(0, 10)
		window.document.getElementById('filterDateFrom').value = today
		window.document.getElementById('filterDateTo').value = today
		window.document.getElementById('filterExpedited').value = 'true'
		window.document.getElementById('filterShipped').value = 'all'
		window.document.getElementById('filterSort').value = 'newest'

		window.showOrdersByDeadline()

		assert(window.document.getElementById('filterShipped').value === 'false', 'switches the status scope to Needs shipping')
		assert(window.document.getElementById('filterSort').value === 'ship_by_soonest', 'switches the sort to closest-deadline-first')
		assert(window.document.getElementById('filterExpedited').value === '', 'clears a pinned Express-only filter, which would otherwise hide most of the queue')
		assert(window.document.getElementById('filterDateFrom').value === '', 'clears the "from" date — a ship-by deadline is blind to when the order was PLACED')
		assert(window.document.getElementById('filterDateTo').value === '', 'clears the "to" date for the same reason')
		assert(!window.document.getElementById('dateClearBtn').classList.contains('visible'), 'the date-clear pill is hidden along with the (now empty) date fields')
		assert(!window.document.querySelector('.packer-preset-btn').classList.contains('active'), 'a stale packer preset no longer claims to be the active queue')
		assert(closedArchive === true, 'a stale packaged-days archive popover is closed rather than left dangling')
		assert(window.ordersOffset === 0, 'paging resets to the first page of the deadline queue')
		assert(loadOrdersCalls === 1, 'the (now-correct) filters are fetched exactly once')
		assert(btnsUpdated === true, "the packer's urgent-select button visibility is refreshed for the new scope")
	}

	console.log('')
	if (failures > 0) {
		console.error(`${failures} assertion(s) FAILED`)
		process.exit(1)
	}
	console.log('All assertions passed.')
})().catch((err) => {
	console.error('\nTest harness error:', err)
	process.exit(1)
})
