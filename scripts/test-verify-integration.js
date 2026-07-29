'use strict'

/**
 * END-TO-END integration test — the verify → pack pipeline over real HTTP.
 *
 * Everything else in the suite tests pure functions or the DB layer in isolation.
 * This one boots the ACTUAL Express server (src/server/index.js) against an
 * ISOLATED throwaway config + database (via DASHBOARD_CONFIG_PATH, with auth
 * disabled), seeds orders, and drives the real endpoints — proving that
 * classifyPurchaseState, the `to_verify` / `ready_to_pack` scope branching, the
 * require_verify_before_pack gate, the verify endpoints, and the audit→shift
 * pipeline all work together, not just in unit isolation.
 *
 * Invariant under test: with the gate ON, the fully-purchased/unpackaged set is
 * PARTITIONED — an order is in "Verify purchases" (to_verify) until it is verified,
 * then moves to "To pack & ship" (ready_to_pack). The two never overlap.
 *
 * Run: `node scripts/test-verify-integration.js`   (0 = pass, 1 = regression)
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

const PORT = 4100 + (process.pid % 400)
const BASE = `http://127.0.0.1:${PORT}`
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-int-'))
const dbPath = path.join(tmpDir, 'test.db')
const cfgPath = path.join(tmpDir, 'config.json')

const NOW = Math.floor(Date.now() / 1000)
// Line key of the in-hand product on the partially-blocked order (used by both the
// seed and the per-line verify assertion).
const boughtKey = routeDashboard.lineItemKey('Bought Item', 9010)

function seed() {
	const db = initDb(dbPath)
	db.prepare('INSERT INTO groups (group_id, label) VALUES (?,?)').run('G1', 'Group 1')
	db.prepare('INSERT INTO shops (shop_id, group_id, shop_name) VALUES (?,?,?)').run('S1', 'G1', 'TestShop')
	const ins = db.prepare(`
    INSERT INTO receipts (receipt_id, shop_id, group_id, name, buyer_user_id, status, is_paid, is_shipped, etsy_created_at, all_transactions, source)
    VALUES (@id, 'S1', 'G1', @name, @buyer, 'Paid', 1, 0, @created, @tx, 'etsy')`)
	// Two NO-COMPONENT lines (empty variations). A no-component line with no
	// receipt_item_purchase row is "in hand" (ready) by default → both start fully
	// purchased + unverified, so both belong in to_verify and neither in ready_to_pack.
	ins.run({ id: 5001, name: 'Alice', buyer: 111, created: NOW - 7200, tx: JSON.stringify([{ title: 'Plain Sticker A', listing_id: 9001, quantity: 1, variations: [] }]) })
	ins.run({ id: 5002, name: 'Bob', buyer: 222, created: NOW - 3600, tx: JSON.stringify([{ title: 'Plain Sticker B', listing_id: 9002, quantity: 1, variations: [] }]) })
	// One COMPONENT line (Case + Grip + Charm) whose components are ALL Purchased
	// (in route_assignments) → also "ready" but unverified. Exercises the OTHER
	// storage path of the verify gate (route_assignments.verified_at vs the
	// receipt_item_purchase path above).
	const compTitle = 'Cute MagSafe Case with Grip & Charm'
	const compTx = [{ title: compTitle, listing_id: 9003, quantity: 1, variations: [{ formatted_name: 'Style', formatted_value: 'Case + Grip + Charm' }, { formatted_name: 'Phone Model', formatted_value: 'iPhone 15' }] }]
	ins.run({ id: 5003, name: 'Carol', buyer: 333, created: NOW - 1800, tx: JSON.stringify(compTx) })
	const compKey = routeDashboard.lineItemKey(compTitle, 9003)
	db.prepare("INSERT INTO route_assignments (receipt_id, item_key, title, status_case, status_grip, status_charm) VALUES (5003, ?, ?, 'Purchased', 'Purchased', 'Purchased')").run(compKey, compTitle)

	// A PARTIALLY-BLOCKED multi-product order (the feature under test): line A is
	// purchased & in hand; line B is on hold (out of production). It must appear in
	// Need-to-purchase (so the in-hand line A can be reconciled) but NEVER in the
	// packing queues, since an open issue blocks the whole order.
	const blockedKey = routeDashboard.lineItemKey('Blocked Item', 9011)
	ins.run({
		id: 5010,
		name: 'Dave',
		buyer: 444,
		created: NOW - 900,
		tx: JSON.stringify([
			{ title: 'Bought Item', listing_id: 9010, quantity: 1, variations: [] },
			{ title: 'Blocked Item', listing_id: 9011, quantity: 1, variations: [] },
		]),
	})
	db.prepare('INSERT INTO receipt_item_purchase (receipt_id, item_key, title, needs_purchase) VALUES (5010, ?, ?, 0)').run(boughtKey, 'Bought Item')
	db.prepare("INSERT INTO order_issues (receipt_id, item_key, title, issue_type, status) VALUES (5010, ?, ?, 'out_of_production', 'open')").run(blockedKey, 'Blocked Item')

	// A PACKAGED order that still has an outstanding (to-buy) line. Packing is
	// terminal, so it must NOT appear in Need-to-purchase (the reported bug).
	const packedKey = routeDashboard.lineItemKey('Packed But Unbought', 9020)
	db.prepare(`INSERT INTO receipts (receipt_id, shop_id, group_id, name, buyer_user_id, status, is_paid, is_shipped, packaged_at, etsy_created_at, all_transactions, source)
	           VALUES (5020, 'S1', 'G1', 'Erin', 555, 'Paid', 1, 0, @packed, @created, @tx, 'etsy')`).run({
		packed: NOW - 300,
		created: NOW - 600,
		tx: JSON.stringify([{ title: 'Packed But Unbought', listing_id: 9020, quantity: 1, variations: [] }]),
	})
	db.prepare('INSERT INTO receipt_item_purchase (receipt_id, item_key, title, needs_purchase) VALUES (5020, ?, ?, 1)').run(packedKey, 'Packed But Unbought')

	// An unshipped, unpackaged order that still has a to-buy line (outstanding) —
	// used to prove the seal guard refuses to package it.
	const buyKey30 = routeDashboard.lineItemKey('Still To Buy 30', 9030)
	db.prepare(`INSERT INTO receipts (receipt_id, shop_id, group_id, name, buyer_user_id, status, is_paid, is_shipped, etsy_created_at, all_transactions, source)
	           VALUES (5030, 'S1', 'G1', 'Fred', 666, 'Paid', 1, 0, @created, @tx, 'etsy')`).run({
		created: NOW - 500,
		tx: JSON.stringify([{ title: 'Still To Buy 30', listing_id: 9030, quantity: 1, variations: [] }]),
	})
	db.prepare('INSERT INTO receipt_item_purchase (receipt_id, item_key, title, needs_purchase) VALUES (5030, ?, ?, 1)').run(buyKey30, 'Still To Buy 30')

	// 5040 — OUTSTANDING *and* ON HOLD: a Case+Charm line whose components are still
	// Pending (so it's classifier-"outstanding") AND carries an open issue. It must
	// NOT appear under "To buy" (on hold wins), only under "On hold" / "All".
	const flaggedKey = routeDashboard.lineItemKey('Flagged Pending', 9040)
	ins.run({ id: 5040, name: 'Gwen', buyer: 777, created: NOW - 450, tx: JSON.stringify([{ title: 'Flagged Pending', listing_id: 9040, quantity: 1, variations: [{ formatted_name: 'Style', formatted_value: 'Case + Charm' }] }]) })
	db.prepare("INSERT INTO order_issues (receipt_id, item_key, title, issue_type, status) VALUES (5040, ?, ?, 'other', 'open')").run(flaggedKey, 'Flagged Pending')

	// 5050 — PARTIALLY in hand on a blocked order (mirrors the reported screenshot):
	// line 1 (Case+Charm) has the CASE purchased but the charm still pending; line 2
	// is on hold. The case IS physically in hand, so in_hand_items must be 1 (not 0).
	const partialKey = routeDashboard.lineItemKey('Partial 50', 9050)
	const blocked50Key = routeDashboard.lineItemKey('Blocked 50', 9051)
	ins.run({
		id: 5050,
		name: 'Hank',
		buyer: 888,
		created: NOW - 400,
		tx: JSON.stringify([
			{ title: 'Partial 50', listing_id: 9050, quantity: 1, variations: [{ formatted_name: 'Style', formatted_value: 'Case + Charm' }] },
			{ title: 'Blocked 50', listing_id: 9051, quantity: 1, variations: [] },
		]),
	})
	db.prepare("INSERT INTO route_assignments (receipt_id, item_key, title, status_case, status_charm) VALUES (5050, ?, ?, 'Purchased', 'Pending')").run(partialKey, 'Partial 50')
	db.prepare("INSERT INTO order_issues (receipt_id, item_key, title, issue_type, status) VALUES (5050, ?, ?, 'out_of_production', 'open')").run(blocked50Key, 'Blocked 50')
	db.close()

	fs.writeFileSync(
		cfgPath,
		JSON.stringify({
			db_path: dbPath,
			require_verify_before_pack: true,
			sync_interval_minutes: 999999, // effectively never during the test
			groups: [
				{
					group_id: 'G1',
					label: 'Test Group',
					proxy: 'direct',
					shops: [{ shop_id: 'S1', shop_name: 'TestShop', api_key: 'integrationtestkey000001', shared_secret: 'integrationsecret0001' }],
				},
			],
		}),
		'utf8',
	)
}

function api(pathAndQuery, opts = {}) {
	return fetch(BASE + pathAndQuery, opts).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
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

	// Boot the real server against the isolated config, auth DISABLED (empty owner
	// password + fresh DB with no users → access.js leaves auth off, so we can
	// exercise /api directly). dotenv won't override these explicitly-set vars.
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

		// Gate flag is surfaced to the client.
		const list = await api('/api/orders?limit=1')
		assert(list.body && list.body.require_verify_before_pack === true, `/api/orders reports require_verify_before_pack = true`)

		// Initial partition: all 3 orders fully purchased + unverified → all in
		// to_verify, NONE in ready_to_pack (the exact bug we fixed — no overlap).
		let tv = await api('/api/orders?shipped=to_verify&limit=100')
		let rp = await api('/api/orders?shipped=ready_to_pack&limit=100')
		assert(tv.body.total === 3, `initially 3 orders in "Verify purchases" (got ${tv.body.total})`)
		assert(rp.body.total === 0, `initially 0 orders in "To pack & ship" — gate holds them back (got ${rp.body.total})`)

		// Verify a no-component order (5001) AND a component order (5003) — proving
		// BOTH storage paths of the gate move an order across the pipeline.
		const v1 = await api('/api/orders/5001/verify-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
		const v3 = await api('/api/orders/5003/verify-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
		assert(v1.status === 200 && v1.body.success, `verify-all on no-component order 5001 succeeds`)
		assert(v3.status === 200 && v3.body.success, `verify-all on component order 5003 succeeds`)

		// Partition after verifying: 5001 + 5003 moved to ready_to_pack, 5002 stays.
		tv = await api('/api/orders?shipped=to_verify&limit=100')
		rp = await api('/api/orders?shipped=ready_to_pack&limit=100')
		const tvIds = (tv.body.orders || []).map((o) => o.receipt_id).sort()
		const rpIds = (rp.body.orders || []).map((o) => o.receipt_id).sort()
		assert(tv.body.total === 1 && tvIds.includes(5002), `after verifying, only 5002 remains to verify (got ${tvIds.join(',')})`)
		assert(rp.body.total === 2 && rpIds.includes(5001) && rpIds.includes(5003), `both verified orders (no-comp + component) move to "To pack & ship" (got ${rpIds.join(',')})`)
		assert(!rpIds.includes(5002) && !tvIds.includes(5001) && !tvIds.includes(5003), `NO overlap between the two queues — clean partition`)

		// Unverify the component order → it returns to the verify queue (reversible,
		// and proves route_assignments verification clears correctly).
		await api('/api/orders/5003/verify-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ verified: false }) })
		tv = await api('/api/orders?shipped=to_verify&limit=100')
		assert(tv.body.total === 2, `un-verifying 5003 returns it to "Verify purchases" (got ${tv.body.total})`)

		// The verify actions were recorded in the shift summary (audit → rollup).
		const shift = await api('/api/shift-summary')
		const totalVerified = (shift.body.users || []).reduce((n, u) => n + (u.counts.verified || 0), 0)
		assert(shift.status === 200 && totalVerified >= 2, `shift summary counts the verification actions (got ${totalVerified})`)

		// ── On-hold reconciliation (the new feature) ─────────────────────────────
		// The partially-blocked order 5010 appears in Need-to-purchase with the right
		// in-hand / on-hold breakdown, but is kept OUT of the packing queues.
		const npAll = await api('/api/orders?shipped=needs_purchase&limit=200')
		const o5010 = (npAll.body.orders || []).find((o) => o.receipt_id === 5010)
		assert(!!o5010, `partially-blocked order 5010 appears in Need-to-purchase (default 'all')`)
		assert(o5010 && o5010.in_hand_items === 1 && o5010.open_issues === 1, `5010 reports 1 in hand · 1 on hold (got ${o5010 && o5010.in_hand_items}/${o5010 && o5010.open_issues})`)
		const boughtLine = o5010 && o5010.transactions.find((t) => t.title === 'Bought Item')
		const blockedLine = o5010 && o5010.transactions.find((t) => t.title === 'Blocked Item')
		assert(boughtLine && boughtLine.in_hand === true && boughtLine.verified === false, `the bought line is in-hand and not yet verified`)
		assert(blockedLine && blockedLine.issue && blockedLine.issue.on_hold === true && blockedLine.in_hand === false, `the blocked line is on hold and not in-hand`)

		// np_filter routing.
		const npOnHold = await api('/api/orders?shipped=needs_purchase&np_filter=onhold&limit=200')
		const npToBuy = await api('/api/orders?shipped=needs_purchase&np_filter=tobuy&limit=200')
		assert((npOnHold.body.orders || []).some((o) => o.receipt_id === 5010), `np_filter=onhold includes the blocked order`)
		assert(!(npToBuy.body.orders || []).some((o) => o.receipt_id === 5010), `np_filter=tobuy excludes it (nothing left to buy on it)`)

		// It must NOT leak into the packing queues (an open issue blocks the order).
		const rpAll = await api('/api/orders?shipped=ready_to_pack&limit=200')
		const tvAll = await api('/api/orders?shipped=to_verify&limit=200')
		assert(!(rpAll.body.orders || []).some((o) => o.receipt_id === 5010), `on-hold order never appears in "To pack & ship"`)
		assert(!(tvAll.body.orders || []).some((o) => o.receipt_id === 5010), `on-hold order never appears in "Verify purchases"`)

		// Per-line verify of the in-hand product on the blocked order (reconciliation).
		const vLine = await api('/api/orders/5010/items/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item_key: boughtKey, title: 'Bought Item', verified: true }) })
		assert(vLine.status === 200 && vLine.body.success, `per-line verify of the in-hand product succeeds`)
		const npAfter = await api('/api/orders?shipped=needs_purchase&limit=200')
		const o5010b = (npAfter.body.orders || []).find((o) => o.receipt_id === 5010)
		const boughtLineB = o5010b && o5010b.transactions.find((t) => t.title === 'Bought Item')
		assert(boughtLineB && boughtLineB.verified === true && o5010b.verified_items === 1, `the in-hand line now reads verified, and it STAYS on hold in Need-to-purchase`)
		const rpAfter = await api('/api/orders?shipped=ready_to_pack&limit=200')
		assert(!(rpAfter.body.orders || []).some((o) => o.receipt_id === 5010), `verifying an in-hand line does NOT release a still-blocked order to packing`)

		// ── Packaged orders must NEVER appear in the buy queue (the reported bug) ──
		const npForPacked = await api('/api/orders?shipped=needs_purchase&limit=200')
		assert(!(npForPacked.body.orders || []).some((o) => o.receipt_id === 5020), `a PACKAGED order with an outstanding line is excluded from Need-to-purchase`)
		const npAllFilter = await api('/api/orders?shipped=needs_purchase&np_filter=all&limit=200')
		const npBuyFilter = await api('/api/orders?shipped=needs_purchase&np_filter=tobuy&limit=200')
		assert(!(npAllFilter.body.orders || []).some((o) => o.receipt_id === 5020) && !(npBuyFilter.body.orders || []).some((o) => o.receipt_id === 5020), `packaged order stays out under every np_filter`)

		// ── Seal guard: can't mark-packaged an order that isn't fully in hand ─────
		const sealBad = await api('/api/orders/5030/mark-packaged', { method: 'POST' })
		assert(sealBad.status === 409 && sealBad.body.code === 'NOT_SEALABLE', `mark-packaged is REFUSED for an order that still needs purchase (got ${sealBad.status})`)
		const stillBuying = await api('/api/orders?shipped=needs_purchase&np_filter=tobuy&limit=200')
		assert((stillBuying.body.orders || []).some((o) => o.receipt_id === 5030), `the refused order stays in the buy queue (never got packaged)`)

		const sealHold = await api('/api/orders/5010/mark-packaged', { method: 'POST' })
		assert(sealHold.status === 409, `mark-packaged is REFUSED for an on-hold order (got ${sealHold.status})`)

		const sealGood = await api('/api/orders/5002/mark-packaged', { method: 'POST' })
		assert(sealGood.status === 200 && sealGood.body.success, `mark-packaged SUCCEEDS for an in-hand order`)

		// Bulk: seal the sealable one, skip the two that aren't ready — and report them.
		const bulkSeal = await api('/api/orders/bulk-mark-packaged', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ receipt_ids: [5001, 5030, 5010], packaged: true }) })
		assert(bulkSeal.body.changed === 1, `bulk seals only the 1 sealable order (got ${bulkSeal.body.changed})`)
		assert((bulkSeal.body.skipped || []).length === 2, `bulk reports the 2 un-sealable orders it skipped (got ${(bulkSeal.body.skipped || []).length})`)

		// ── "To buy" must EXCLUDE on-hold orders (even outstanding ones) ──────────
		const tobuy = await api('/api/orders?shipped=needs_purchase&np_filter=tobuy&limit=200')
		const onhold = await api('/api/orders?shipped=needs_purchase&np_filter=onhold&limit=200')
		const tobuyIds = (tobuy.body.orders || []).map((o) => o.receipt_id)
		const onholdIds = (onhold.body.orders || []).map((o) => o.receipt_id)
		assert(!tobuyIds.includes(5040), `an outstanding-but-ON-HOLD order is NOT in "To buy" (got ${tobuyIds.join(',')})`)
		assert(onholdIds.includes(5040), `the outstanding-but-on-hold order IS under "On hold"`)
		assert(!tobuyIds.includes(5050) && onholdIds.includes(5050), `a mixed (partial + blocked) order lives under "On hold", not "To buy"`)

		// ── Partial in-hand must count (case purchased, charm pending) ────────────
		const npForPartial = await api('/api/orders?shipped=needs_purchase&limit=200')
		const o5050 = (npForPartial.body.orders || []).find((o) => o.receipt_id === 5050)
		assert(o5050 && o5050.in_hand_items === 1, `a partially-bought line (case purchased) counts as 1 in hand — NOT 0 (got ${o5050 && o5050.in_hand_items})`)
		assert(o5050 && o5050.on_hold_items === 1, `and the blocked line counts as 1 on hold (got ${o5050 && o5050.on_hold_items})`)
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
