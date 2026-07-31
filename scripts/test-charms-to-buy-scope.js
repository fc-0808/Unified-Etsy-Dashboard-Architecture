'use strict'

/**
 * END-TO-END integration test — the "Charms to buy" shopping list must describe
 * EXACTLY the Need-to-purchase queue it is opened from.
 *
 * THE REGRESSION THIS LOCKS DOWN
 * ----------------------------------------------------------------------------
 * The charm list used to be built from the Route dashboard's own 30-day pending
 * scope, while the tab that launches it is built from the buy queue. The two sets
 * differed, so the header counted pieces from orders that were NOT on screen —
 * most visibly orders that were already fully purchased ("18 pcs total" over a
 * queue that held 13). An employee could not reconcile the list with their work,
 * which is the one thing a shopping list has to allow.
 *
 * THE INVARIANT
 *   charm list ⊆ Need-to-purchase (All), and every charm piece on it is one an
 *   employee can actually walk to a stall and buy.
 *
 * Boots the ACTUAL Express server against an isolated throwaway config + DB (auth
 * disabled) and drives the real endpoints, so the scope SQL, classifyPurchaseState,
 * buildRouteRows and the charm-line predicate are all proven together.
 *
 * Run: `node scripts/test-charms-to-buy-scope.js`   (0 = pass, 1 = regression)
 */

const os = require('os')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const { initDb } = require('../src/db/setup')
const routeDashboard = require('../src/route/dashboard')

let failures = 0
function assert(cond, msg) {
	if (cond) console.log(`  ok  — ${msg}`)
	else {
		failures++
		console.error(`  FAIL — ${msg}`)
	}
}

const PORT = 4600 + (process.pid % 300)
const BASE = `http://127.0.0.1:${PORT}`
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charm-scope-'))
const dbPath = path.join(tmpDir, 'test.db')
const cfgPath = path.join(tmpDir, 'config.json')

const NOW = Math.floor(Date.now() / 1000)

/** A Case+Charm line; `model` drives AirPods (integral-charm) detection. */
function line(title, listingId, qty = 1, model = 'iPhone 15') {
	return {
		title,
		listing_id: listingId,
		quantity: qty,
		variations: [
			{ formatted_name: 'Style', formatted_value: 'Case + Charm' },
			{ formatted_name: 'Phone Model', formatted_value: model },
		],
	}
}

const K = (title, listingId) => routeDashboard.lineItemKey(title, listingId)

function seed() {
	const db = initDb(dbPath)
	db.prepare('INSERT INTO groups (group_id, label) VALUES (?,?)').run('G1', 'Group 1')
	db.prepare('INSERT INTO shops (shop_id, group_id, shop_name) VALUES (?,?,?)').run('S1', 'G1', 'TestShop')

	const ins = db.prepare(`
    INSERT INTO receipts (receipt_id, shop_id, group_id, name, buyer_user_id, status, is_paid, is_shipped, packaged_at, etsy_created_at, all_transactions, source)
    VALUES (@id, 'S1', 'G1', @name, @buyer, 'Paid', 1, 0, @packaged, @created, @tx, 'etsy')`)
	const add = (id, name, txs, packaged = null) => ins.run({ id, name, buyer: 1000 + id, packaged, created: NOW - id, tx: JSON.stringify(txs) })
	const status = db.prepare(`
    INSERT INTO route_assignments (receipt_id, item_key, title, charm_code, status_case, status_charm)
    VALUES (@rid, @key, @title, @code, @sCase, @sCharm)`)
	const assign = (rid, title, listingId, code, sCase, sCharm) => status.run({ rid, key: K(title, listingId), title, code, sCase, sCharm })

	// 6001 — the ordinary case: still to buy, one charm, TWO pieces.
	add(6001, 'Anna', [line('Pending Charm', 7001, 2)])
	assign(6001, 'Pending Charm', 7001, 'CH-AAA', 'Pending', 'Pending')

	// 6002 — FULLY purchased: absent from Need-to-purchase, so its charm must not
	// be counted. THIS is the reported bug (inflated "pcs total").
	add(6002, 'Ben', [line('Done Charm', 7002)])
	assign(6002, 'Done Charm', 7002, 'CH-BBB', 'Purchased', 'Purchased')

	// 6003 — PACKAGED although a line still reads outstanding: packing is terminal.
	add(6003, 'Cara', [line('Packed Charm', 7003)], NOW - 100)
	assign(6003, 'Packed Charm', 7003, 'CH-CCC', 'Pending', 'Pending')

	// 6004 — MIXED order: a buyable charm line + a line on hold behind an open
	// fulfilment issue. The order is in the queue; only the buyable charm counts.
	add(6004, 'Dan', [line('Mixed Buyable', 7004), line('Mixed Blocked', 7005)])
	assign(6004, 'Mixed Buyable', 7004, 'CH-DDD', 'Pending', 'Pending')
	assign(6004, 'Mixed Blocked', 7005, 'CH-EEE', 'Pending', 'Pending')
	db.prepare("INSERT INTO order_issues (receipt_id, item_key, title, issue_type, status) VALUES (6004, ?, ?, 'out_of_production', 'open')").run(K('Mixed Blocked', 7005), 'Mixed Blocked')

	// 6005 — charm marked Out of Production: a dead end nobody can shop. The order
	// stays in the queue (its case is still to buy) but the charm must drop out.
	add(6005, 'Ella', [line('Discontinued Charm', 7006)])
	assign(6005, 'Discontinued Charm', 7006, 'CH-FFF', 'Pending', 'Out of Production')

	// 6006 — charm already bought on an order that still needs its case. It stays
	// on the list as PROGRESS (and so the stepper can be wound back).
	add(6006, 'Finn', [line('Charm Already Bought', 7007)])
	assign(6006, 'Charm Already Bought', 7007, 'CH-GGG', 'Pending', 'Purchased')

	// 6007 — AirPods: the charm ships attached to the case, so it is never a
	// charm-stall errand.
	add(6007, 'Gina', [line('AirPods Charm Case', 7008, 1, 'AirPods Pro 2')])
	assign(6007, 'AirPods Charm Case', 7008, '', 'Pending', 'Pending')

	// 6008 — open wrong-model exchange covering the CASE only: the charm on the
	// same line still has to be bought.
	add(6008, 'Hugo', [line('Case Swap', 7009)])
	assign(6008, 'Case Swap', 7009, 'CH-HHH', 'Pending', 'Pending')
	db.prepare("INSERT INTO order_exchanges (receipt_id, item_key, title, have_model, need_model, components, status) VALUES (6008, ?, ?, 'iPhone 14', 'iPhone 15', 'case', 'open')").run(K('Case Swap', 7009), 'Case Swap')

	// 6009 — open exchange that explicitly covers the CHARM: we already hold it, so
	// it must not be re-bought.
	add(6009, 'Iris', [line('Charm Swap', 7010)])
	assign(6009, 'Charm Swap', 7010, 'CH-III', 'Pending', 'Pending')
	db.prepare("INSERT INTO order_exchanges (receipt_id, item_key, title, have_model, need_model, components, status) VALUES (6009, ?, ?, 'iPhone 14', 'iPhone 15', 'charm', 'open')").run(K('Charm Swap', 7010), 'Charm Swap')

	db.close()

	fs.writeFileSync(
		cfgPath,
		JSON.stringify({
			db_path: dbPath,
			sync_interval_minutes: 999999, // effectively never during the test
			groups: [
				{
					group_id: 'G1',
					label: 'Test Group',
					proxy: 'direct',
					shops: [{ shop_id: 'S1', shop_name: 'TestShop', api_key: 'charmscopetestkey000001', shared_secret: 'charmscopesecret0001' }],
				},
			],
		}),
		'utf8',
	)
}

function api(pathAndQuery) {
	return fetch(BASE + pathAndQuery).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
}

async function waitForHealth(child, timeoutMs = 20000) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (child.exitCode != null) throw new Error(`server exited early (code ${child.exitCode})`)
		try {
			const r = await fetch(BASE + '/api/health')
			if (r.ok) return true
		} catch {
			/* not up yet */
		}
		await new Promise((res) => setTimeout(res, 400))
	}
	throw new Error('server did not become healthy in time')
}

async function main() {
	seed()

	const child = spawn(process.execPath, [path.resolve(__dirname, '../src/server/index.js')], {
		env: {
			...process.env,
			PORT: String(PORT),
			DASHBOARD_CONFIG_PATH: cfgPath,
			DASHBOARD_OWNER_PASSWORD: '',
			DASHBOARD_PACKER_PASSWORD: '',
			DASHBOARD_SHOPPER_PASSWORD: '',
		},
		stdio: ['ignore', 'ignore', 'pipe'],
	})
	let stderr = ''
	child.stderr.on('data', (d) => (stderr += d.toString()))

	try {
		await waitForHealth(child)

		const np = await api('/api/orders?shipped=needs_purchase&limit=200')
		const npIds = new Set((np.body.orders || []).map((o) => o.receipt_id))
		const charms = await api('/api/route/charms-to-buy')
		const rows = (charms.body && charms.body.rows) || []
		const has = (receiptId, title, listingId) => rows.some((r) => r.receipt_id === receiptId && r.item_key === K(title, listingId))

		// ── The tab itself: everything below is measured against this set ────────
		assert(np.status === 200 && npIds.size === 7, `Need-to-purchase holds the 7 orders with buy work or a hold (got ${npIds.size}: ${[...npIds].join(',')})`)
		assert(!npIds.has(6002) && !npIds.has(6003), `the fully-purchased (6002) and packaged (6003) orders are NOT in the tab`)

		// ── The invariant ────────────────────────────────────────────────────────
		assert(charms.status === 200 && charms.body.ok === true, `GET /api/route/charms-to-buy responds ok`)
		const strays = rows.filter((r) => !npIds.has(r.receipt_id)).map((r) => r.receipt_id)
		assert(strays.length === 0, `every charm line comes from an order the tab is showing (strays: ${strays.join(',') || 'none'})`)
		assert(charms.body.scope && charms.body.scope.orders === np.body.total, `the reported scope matches the tab exactly (${charms.body.scope && charms.body.scope.orders} vs ${np.body.total} orders)`)

		// ── Which charm lines belong on the list ─────────────────────────────────
		assert(has(6001, 'Pending Charm', 7001), `a charm that still needs buying IS listed`)
		assert(!has(6002, 'Done Charm', 7002), `a charm from a FULLY PURCHASED order is NOT listed (the reported bug)`)
		assert(!has(6003, 'Packed Charm', 7003), `a charm from a PACKAGED order is NOT listed`)
		assert(has(6004, 'Mixed Buyable', 7004), `on a partly-blocked order, the buyable charm IS listed`)
		assert(!has(6004, 'Mixed Blocked', 7005), `…while its ON-HOLD sibling line is NOT`)
		assert(!has(6005, 'Discontinued Charm', 7006), `a charm marked Out of Production is NOT listed`)
		assert(has(6006, 'Charm Already Bought', 7007), `an already-purchased charm on an outstanding order stays listed as progress`)
		assert(!has(6007, 'AirPods Charm Case', 7008), `an AirPods integral charm is NOT listed (bought with the case)`)
		assert(has(6008, 'Case Swap', 7009), `a charm on a CASE-only exchange line is still listed (it must be bought)`)
		assert(!has(6009, 'Charm Swap', 7010), `a charm the exchange itself covers is NOT listed (already in hand)`)

		// ── The headline totals an employee reads ────────────────────────────────
		const pcs = rows.reduce((n, r) => n + (r.quantity || 1), 0)
		const purchased = rows.reduce((n, r) => n + (r.status_charm === 'Purchased' ? r.quantity || 1 : 0), 0)
		assert(rows.length === 4, `exactly 4 charm lines qualify (got ${rows.length})`)
		assert(pcs === 5, `"pcs total" counts quantities, not lines — 5 pieces over 4 lines (got ${pcs})`)
		assert(purchased === 1 && pcs - purchased === 4, `1 of 5 pieces purchased → 4 still to buy (got ${purchased}/${pcs})`)

		// ── The sub-filters stay consistent with the same definition ─────────────
		const tobuy = await api('/api/orders?shipped=needs_purchase&np_filter=tobuy&limit=200')
		const onhold = await api('/api/orders?shipped=needs_purchase&np_filter=onhold&limit=200')
		const tobuyIds = (tobuy.body.orders || []).map((o) => o.receipt_id)
		const onholdIds = (onhold.body.orders || []).map((o) => o.receipt_id)
		// 6005 joins 6004 under "On hold": marking a component Out of Production is
		// bridged to a fulfilment issue everywhere in the app, so the charm list and
		// the Issues/on-hold queue agree on what is blocked.
		assert(onholdIds.length === 2 && onholdIds.includes(6004) && onholdIds.includes(6005), `"On hold" holds the flagged order AND the out-of-production one (got ${onholdIds.join(',') || 'none'})`)
		assert(!tobuyIds.includes(6004) && !tobuyIds.includes(6005) && tobuyIds.length === 5, `"To buy" is the rest of the queue, minus both on-hold orders (got ${tobuyIds.length})`)

		// ── The tab's count badge ────────────────────────────────────────────────
		// The badge reads np_counts.tobuy: an on-hold order is waiting on an owner
		// decision, so it is listed but is not work the packer can pick up. The
		// breakdown must be internally consistent AND agree, filter for filter, with
		// the rows each sub-filter actually returns — that is what makes the number
		// on the tab reconcilable with the screen instead of merely plausible.
		const c = np.body.np_counts
		assert(c && c.all === 7 && c.tobuy === 5 && c.onhold === 2, `np_counts splits the queue 5 to-buy + 2 on-hold of 7 (got ${c ? `${c.tobuy}+${c.onhold} of ${c.all}` : 'missing'})`)
		assert(c.all === c.tobuy + c.onhold, `the breakdown adds up — all === tobuy + onhold`)
		assert(c.tobuy === tobuyIds.length && c.onhold === onholdIds.length && c.all === npIds.size, `every count matches the rows its own sub-filter returns`)
		// The breakdown describes the WHOLE queue, so it must not shift when a
		// sub-filter narrows the page — otherwise the badge would change meaning
		// depending on which chip the packer last clicked.
		assert(tobuy.body.np_counts && tobuy.body.np_counts.all === 7 && onhold.body.np_counts.all === 7, `np_counts is filter-independent — the same breakdown under every sub-filter`)
		assert(tobuy.body.total === 5 && onhold.body.total === 2, `…while \`total\` still reports the requested sub-filter's own page count`)
	} catch (e) {
		failures++
		console.error(`  FAIL — ${e.message}`)
		if (stderr.trim()) console.error('  --- server stderr ---\n' + stderr.split('\n').slice(-15).join('\n'))
	} finally {
		child.kill('SIGKILL')
	}
}

main()
	.catch((e) => {
		failures++
		console.error('  FATAL —', e.message)
	})
	.finally(() => {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true })
		} catch {
			/* ignore */
		}
		console.log('')
		if (failures > 0) {
			console.error(`${failures} assertion(s) FAILED`)
			process.exit(1)
		}
		console.log('All assertions passed.')
	})
