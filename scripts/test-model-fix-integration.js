'use strict'

/**
 * END-TO-END integration test — the "Fix model" workflow over real HTTP.
 *
 * Boots the ACTUAL Express server against an ISOLATED throwaway config + database
 * and drives the real endpoints, proving the whole pipeline agrees on what a model
 * fix means — the dashboard scope, the mobile shopping route, the packing queue
 * and the auto-settlement — rather than each unit agreeing only with itself.
 *
 * The reported bug it locks down: an order whose buyer needs a different phone
 * model was flagged with the need-model set and the have-model left blank ("I hold
 * nothing, I'll buy the correct one") and then DISAPPEARED from the Orders Sorting
 * dashboard, so the case was never bought. The two shapes of a model fix must
 * behave in opposite ways:
 *
 *   BUY  (nothing in hand) — stays in the buy queue, showing the CORRECTED model,
 *        blocks packing only through its ordinary Pending case status, and closes
 *        itself the moment that case is marked Purchased.
 *   SWAP (wrong model in hand) — leaves the buy queue, appears in the swap list,
 *        and blocks packing until the swap is explicitly marked done.
 *
 * Run: `node scripts/test-model-fix-integration.js`   (0 = pass, 1 = regression)
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
function eq(a, b, msg) {
	assert(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)
}

const PORT = 4500 + (process.pid % 400)
const BASE = `http://127.0.0.1:${PORT}`
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-fix-int-'))
const dbPath = path.join(tmpDir, 'test.db')
const cfgPath = path.join(tmpDir, 'config.json')

const NOW = Math.floor(Date.now() / 1000)

// The order from the bug report: a Case-only line ordered as iPhone 14/13 that the
// buyer actually needs in iPhone 16.
const BUY_ID = 6001
const BUY_TITLE = 'Rainbow Stars Clear Case with Beaded Charm'
const BUY_LISTING = 8801
const buyKey = routeDashboard.lineItemKey(BUY_TITLE, BUY_LISTING)

// The control: the same situation but WITH the wrong-model case in hand, so it is
// a swap and must behave in the opposite way at every step.
const SWAP_ID = 6002
const SWAP_TITLE = 'Holographic Starry Cover'
const SWAP_LISTING = 8802
const swapKey = routeDashboard.lineItemKey(SWAP_TITLE, SWAP_LISTING)

// Legacy data an OLDER build could leave behind: a buy-shaped fix still OPEN even
// though its case is already Purchased. Nothing would ever close it, so the order
// would sit in limbo forever — the boot reconcile has to settle it.
const LEGACY_ID = 6003
const LEGACY_TITLE = 'Bubble Heart Clear Case'
const LEGACY_LISTING = 8803
const legacyKey = routeDashboard.lineItemKey(LEGACY_TITLE, LEGACY_LISTING)

// AirPods Case+Charm — the attached charm must travel with the case on a SWAP,
// and a cross-family "correction" into an iPhone model must be refused.
const AIR_ID = 6004
const AIR_TITLE = 'Kawaii Bunny Green AirPods Case with Charm'
const AIR_LISTING = 8804
const airKey = routeDashboard.lineItemKey(AIR_TITLE, AIR_LISTING)

// AirPods Case Only — no attached charm; model fix covers the case alone.
const AIR_ONLY_ID = 6005
const AIR_ONLY_TITLE = 'Kawaii Bunny Green AirPods Case'
const AIR_ONLY_LISTING = 8805
const airOnlyKey = routeDashboard.lineItemKey(AIR_ONLY_TITLE, AIR_ONLY_LISTING)

function caseOnlyTx(title, listingId, model) {
	return JSON.stringify([
		{
			title,
			listing_id: listingId,
			quantity: 1,
			variations: [
				{ formatted_name: 'Style', formatted_value: 'Case Only' },
				{ formatted_name: 'Phone Model', formatted_value: model },
			],
		},
	])
}

function airpodsCaseOnlyTx(title, listingId, model) {
	return JSON.stringify([
		{
			title,
			listing_id: listingId,
			quantity: 1,
			variations: [
				{ formatted_name: 'Style', formatted_value: 'Case Only' },
				{ formatted_name: 'AirPods Model', formatted_value: model },
			],
		},
	])
}

function airpodsCharmTx(title, listingId, model) {
	return JSON.stringify([
		{
			title,
			listing_id: listingId,
			quantity: 1,
			variations: [
				{ formatted_name: 'Style', formatted_value: 'Case+Charm' },
				{ formatted_name: 'AirPods Model', formatted_value: model },
			],
		},
	])
}

function seed() {
	const db = initDb(dbPath)
	db.prepare('INSERT INTO groups (group_id, label) VALUES (?,?)').run('G1', 'Group 1')
	db.prepare('INSERT INTO shops (shop_id, group_id, shop_name) VALUES (?,?,?)').run('S1', 'G1', 'Y2KASEshop')
	const ins = db.prepare(`
    INSERT INTO receipts (receipt_id, shop_id, group_id, name, buyer_user_id, status, is_paid, is_shipped, etsy_created_at, all_transactions, source)
    VALUES (@id, 'S1', 'G1', @name, @buyer, 'Paid', 1, 0, @created, @tx, 'etsy')`)
	ins.run({ id: BUY_ID, name: 'Lizzet Romero', buyer: 111, created: NOW - 7200, tx: caseOnlyTx(BUY_TITLE, BUY_LISTING, 'iPhone 14/13') })
	ins.run({ id: SWAP_ID, name: 'Dana Cole', buyer: 222, created: NOW - 7200, tx: caseOnlyTx(SWAP_TITLE, SWAP_LISTING, 'iPhone 14/13') })

	// Legacy contradiction, written directly as an older build would have left it.
	ins.run({ id: LEGACY_ID, name: 'Mona Reid', buyer: 333, created: NOW - 7200, tx: caseOnlyTx(LEGACY_TITLE, LEGACY_LISTING, 'iPhone 14/13') })
	db.prepare("INSERT INTO route_assignments (receipt_id, item_key, title, status_case) VALUES (?, ?, ?, 'Purchased')").run(LEGACY_ID, legacyKey, LEGACY_TITLE)
	db.prepare("INSERT INTO order_exchanges (receipt_id, item_key, title, have_model, need_model, components, status) VALUES (?, ?, ?, NULL, 'iPhone 16', 'case', 'open')").run(LEGACY_ID, legacyKey, LEGACY_TITLE)

	ins.run({ id: AIR_ID, name: 'Ava Chen', buyer: 444, created: NOW - 7200, tx: airpodsCharmTx(AIR_TITLE, AIR_LISTING, 'AirPods Pro') })
	ins.run({ id: AIR_ONLY_ID, name: 'Ben Wu', buyer: 555, created: NOW - 7200, tx: airpodsCaseOnlyTx(AIR_ONLY_TITLE, AIR_ONLY_LISTING, 'AirPods 3') })
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
					shops: [{ shop_id: 'S1', shop_name: 'Y2KASEshop', api_key: 'integrationtestkey000001', shared_secret: 'integrationsecret0001' }],
				},
			],
		}),
		'utf8',
	)
}

function api(pathAndQuery, opts = {}) {
	return fetch(BASE + pathAndQuery, opts).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
}
function post(p, payload) {
	return api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload ?? {}) })
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

/**
 * Poll `probe` until it returns a truthy value, so a deferred boot task can be
 * asserted on without hard-coding a sleep that is either flaky or wasteful.
 */
async function waitFor(probe, timeoutMs, what) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const value = await probe()
		if (value) return value
		await new Promise((res) => setTimeout(res, 400))
	}
	throw new Error(`timed out waiting for ${what}`)
}

/** The dashboard's ACTIVE (still-to-shop) rows — what the operator actually sees. */
function activeRows(dash) {
	return (dash.rows || []).filter((r) => !r.dismissed && !r.excluded && !r.fully_purchased && (!r.needs_exchange || routeDashboard.rowHasShoppingWork(r)))
}
const findRow = (rows, receiptId) => rows.find((r) => r.receipt_id === receiptId)
const readyToPackIds = async () => ((await api('/api/orders?shipped=ready_to_pack&limit=100')).body.orders || []).map((o) => o.receipt_id)

async function main() {
	seed()

	// Auth DISABLED (empty passwords + fresh DB with no users) so the endpoints can
	// be driven directly. dotenv won't override explicitly-set vars.
	const child = spawn(process.execPath, [path.resolve(__dirname, '../src/server/index.js')], {
		env: {
			...process.env,
			PORT: String(PORT),
			DASHBOARD_CONFIG_PATH: cfgPath,
			DASHBOARD_OWNER_PASSWORD: '',
			DASHBOARD_PACKER_PASSWORD: '',
			DASHBOARD_SHOPPER_PASSWORD: '',
			EMBEDDED_SYNC: '0',
		},
		stdio: ['ignore', 'ignore', 'pipe'],
	})
	let stderr = ''
	child.stderr.on('data', (d) => (stderr += d.toString()))

	try {
		await waitForHealth(child)

		// ── Device model catalog (single source of truth for model-fix UI) ─────
		console.log('\nDevice model catalog API:')
		{
			const cat = (await api('/api/fulfilment/device-models')).body
			assert(Array.isArray(cat.iphone) && cat.iphone.includes('iPhone 15 Pro Max'), 'iPhone models are served from product-types')
			assert(Array.isArray(cat.airpods) && cat.airpods.includes('AirPods Pro 2'), 'AirPods generations are served from product-types')
		}

		// ── Baseline ───────────────────────────────────────────────────────────
		console.log('\nBaseline (no model fix yet):')
		let dash = (await api('/api/route/dashboard')).body
		let active = activeRows(dash)
		assert(!!findRow(active, BUY_ID), 'the order starts out in the shopping dashboard')
		eq(findRow(active, BUY_ID).phone_model, 'iPhone 14/13', 'and advertises the model the buyer ordered')

		// ── Flag the fix as a BUY (the reported workflow) ───────────────────────
		console.log('\nAfter "Fix model" with the have-model left BLANK (buy the correct one):')
		const created = await post(`/api/orders/${BUY_ID}/exchanges`, { item_key: buyKey, title: BUY_TITLE, listing_id: BUY_LISTING, need_model: 'iPhone 16', have_model: '' })
		assert(created.status === 200 && created.body.success, 'the model fix is accepted')
		const buyFixId = created.body.exchange.id

		dash = (await api('/api/route/dashboard')).body
		active = activeRows(dash)
		const buyRow = findRow(active, BUY_ID)
		assert(!!buyRow, 'THE REPORTED BUG: the order is STILL in the shopping dashboard — it must be bought')
		eq(buyRow.exchange_intent, 'buy', 'the row is tagged as a buy-shaped fix')
		eq(buyRow.shopping_model, 'iPhone 16', 'the row names the CORRECTED model to buy')
		eq(buyRow.phone_model, 'iPhone 14/13', 'while preserving the ordered model as the audit trail')
		eq(dash.summary.to_buy_model, 1, 'the summary counts it as a model-corrected purchase')
		eq(dash.summary.to_exchange, 0, 'and NOT as a swap owed at a stall')
		eq(dash.summary.orders, 4, 'the iPhone buy, the unfixed iPhone control, and both unfixed AirPods lines still count as shopping work')

		// ── The mobile shopping route sees the same thing ───────────────────────
		console.log('\nMobile shopping route:')
		const shop = (await api('/api/shop/route')).body
		const shopRow = (shop.rows || []).find((r) => r.receipt_id === BUY_ID)
		assert(!!shopRow, 'the line reaches the shopper on the floor')
		eq(shopRow.phone_model, 'iPhone 16', 'the card names the model to actually buy')
		eq(shopRow.ordered_phone_model, 'iPhone 14/13', 'ordered model kept in the payload for audit (never shown to shoppers)')
		assert(!(shop.exchanges || []).some((x) => x.receipt_id === BUY_ID), 'it is NOT also listed as a swap to carry back — there is nothing in hand')

		// ── Packing must wait for the purchase, but must not deadlock ───────────
		console.log('\nPacking queue:')
		assert(!(await readyToPackIds()).includes(BUY_ID), 'the order cannot be packed while the corrected case is unbought')

		// ── Buying the corrected case settles the fix by itself ─────────────────
		console.log('\nAfter the shopper marks the corrected case purchased:')
		const assigned = await post('/api/shop/assign', { receipt_id: BUY_ID, item_key: buyKey, title: BUY_TITLE, status_case: 'Purchased' })
		assert(assigned.status === 200 && assigned.body.ok, 'the mobile shopper assignment endpoint accepts the purchase')
		eq(assigned.body.settled_model_fixes, [buyFixId], 'the mobile purchase settles the model fix — no second confirmation needed')
		const fixes = (await api(`/api/orders/${BUY_ID}/exchanges`)).body.exchanges || []
		eq(fixes.find((x) => x.id === buyFixId).status, 'done', 'and is recorded as done')
		assert((await readyToPackIds()).includes(BUY_ID), 'the order becomes packable')

		// ── The SWAP control behaves in the opposite way at every step ──────────
		console.log('\nControl — the same fix WITH the wrong model in hand (a swap):')
		await post(`/api/orders/${SWAP_ID}/exchanges`, { item_key: swapKey, title: SWAP_TITLE, listing_id: SWAP_LISTING, need_model: 'iPhone 16', have_model: 'iPhone 14/13' })
		dash = (await api('/api/route/dashboard')).body
		assert(!findRow(activeRows(dash), SWAP_ID), 'a swap leaves the buy queue — it is carried back, not bought')
		eq(dash.summary.to_exchange, 1, 'and is counted as a swap owed at a stall')
		eq(dash.summary.to_buy_model, 0, 'never as a purchase')
		const shop2 = (await api('/api/shop/route')).body
		assert((shop2.exchanges || []).some((x) => x.receipt_id === SWAP_ID), 'the shopper gets it as a swap card')
		assert(!(shop2.rows || []).some((r) => r.receipt_id === SWAP_ID), 'and not as something to buy')
		assert(!(await readyToPackIds()).includes(SWAP_ID), 'packing is blocked until the swap is done')

		// ── Changing a swap to a buy must actually take effect ──────────────────
		console.log('\nRe-saving that swap with the have-model CLEARED (we no longer hold it):')
		await post(`/api/orders/${SWAP_ID}/exchanges`, { item_key: swapKey, title: SWAP_TITLE, listing_id: SWAP_LISTING, need_model: 'iPhone 16', have_model: '' })
		dash = (await api('/api/route/dashboard')).body
		const flipped = findRow(activeRows(dash), SWAP_ID)
		assert(!!flipped, 'the line returns to the buy queue')
		eq(flipped.exchange_intent, 'buy', 'the stored fix really switched shape (have_model was cleared, not preserved)')
		eq(flipped.status_case, 'Pending', 'and its case is back to Pending — we do not hold the correct model')
		eq(dash.summary.to_exchange, 0, 'nothing is owed at a stall any more')

		// ── …and back the other way: we DO have a model to swap after all ───────
		// The reported gap. After flagging "buy the corrected model" there was no way
		// to say "we found one in stock" short of deleting the fix and re-flagging
		// it. Changing it in place must move the line out of the buy queue, into the
		// swap list, and keep everything the operator already typed.
		console.log('\nChanging that buy BACK to a swap (a model turned up in stock):')
		const changed = await post(`/api/orders/${SWAP_ID}/exchanges`, {
			item_key: swapKey,
			title: SWAP_TITLE,
			listing_id: SWAP_LISTING,
			need_model: 'iPhone 16',
			have_model: 'iPhone 15',
			supplier_shop: 'Hua Qiang Bei',
			supplier_stall: 'B12',
			note: 'found one in stock',
		})
		assert(changed.status === 200 && changed.body.success, 'the change is accepted')
		eq(changed.body.exchange.have_model, 'iPhone 15', 'the model we now hold is stored')
		eq(changed.body.exchange.need_model, 'iPhone 16', 'and the model to pack is untouched')
		dash = (await api('/api/route/dashboard')).body
		assert(!findRow(activeRows(dash), SWAP_ID), 'the line leaves the buy queue — we hold it now, so it must not be re-bought')
		eq(dash.summary.to_exchange, 1, 'it is owed at a stall again')
		eq(dash.summary.to_buy_model, 0, 'and is no longer counted as a purchase')
		const shop3 = (await api('/api/shop/route')).body
		assert((shop3.exchanges || []).some((x) => x.receipt_id === SWAP_ID), 'the shopper now gets a swap card')
		assert(!(shop3.rows || []).some((r) => r.receipt_id === SWAP_ID), 'and no longer a buy card for the same case')
		assert(!(await readyToPackIds()).includes(SWAP_ID), 'packing stays blocked until the swap is carried out')

		// Changing in place is only worth having if it PRESERVES the fix — the
		// remove-and-re-flag it replaces silently dropped all of this.
		const openSwapFix = ((await api(`/api/orders/${SWAP_ID}/exchanges`)).body.exchanges || []).find((x) => x.status === 'open')
		eq(openSwapFix.supplier_shop, 'Hua Qiang Bei', 'the supplier survives the change')
		eq(openSwapFix.supplier_stall, 'B12', 'including the stall')
		eq(openSwapFix.note, 'found one in stock', 'and so does the note')

		// A field blanked on an edit must CLEAR, not quietly keep its old value — a
		// stale supplier would send the shopper to the wrong stall.
		await post(`/api/orders/${SWAP_ID}/exchanges`, { item_key: swapKey, need_model: 'iPhone 16', have_model: 'iPhone 15', supplier_shop: '', supplier_stall: '', note: '' })
		const clearedFix = ((await api(`/api/orders/${SWAP_ID}/exchanges`)).body.exchanges || []).find((x) => x.status === 'open')
		eq(clearedFix.note, '', 'clearing the note on an edit really clears it')
		eq(clearedFix.supplier_shop, '', 'and clearing the supplier clears it too')
		eq(clearedFix.have_model, 'iPhone 15', 'while the models the edit did not touch are left alone')

		// ── Legacy data left contradictory by an older build ────────────────────
		console.log('\nBoot reconcile of a legacy fix that was open with its case already bought:')
		const legacyFixes = await waitFor(
			async () => {
				const list = (await api(`/api/orders/${LEGACY_ID}/exchanges`)).body.exchanges || []
				return list.length && list.every((x) => x.status === 'done') ? list : null
			},
			15000,
			'the boot reconcile to settle the legacy fix',
		)
		eq(
			legacyFixes.map((x) => x.status),
			['done'],
			'the contradictory fix is closed at boot instead of blocking the order forever',
		)
		assert((await readyToPackIds()).includes(LEGACY_ID), 'and the order is packable again')

		// ── AirPods Case+Charm SWAP covers the attached charm ──────────────────
		console.log('\nAirPods Case+Charm — swap the wrong generation (attached charm travels with the case):')
		const airFlag = await post(`/api/orders/${AIR_ID}/exchanges`, {
			item_key: airKey,
			title: AIR_TITLE,
			listing_id: AIR_LISTING,
			need_model: 'AirPods Pro 2',
			have_model: 'AirPods Pro',
		})
		assert(airFlag.status === 200 && airFlag.body.success, 'the AirPods model fix is accepted')
		eq(airFlag.body.exchange.components, 'case,charm', 'it covers the case AND the attached charm')
		eq(airFlag.body.exchange.need_model, 'AirPods Pro 2', 'and names the corrected generation')
		dash = (await api('/api/route/dashboard')).body
		assert(!findRow(activeRows(dash), AIR_ID), 'the AirPods SWAP leaves the buy queue — the whole unit is carried back')
		eq(dash.summary.to_exchange, 2, 'both open swaps (iPhone control + AirPods) are counted')
		const airShop = (await api('/api/shop/route')).body
		assert((airShop.exchanges || []).some((x) => x.receipt_id === AIR_ID), 'the shopper gets an AirPods swap card')
		assert(!(airShop.rows || []).some((r) => r.receipt_id === AIR_ID), 'and not a buy card for the same case/charm')
		const airExCard = (airShop.exchanges || []).find((x) => x.receipt_id === AIR_ID)
		assert(airExCard && airExCard.charm_integral, 'the swap payload flags the charm as integral so the card can name it')

		console.log('\nCross-family refusal (an AirPods line cannot be "corrected" into an iPhone):')
		const clash = await post(`/api/orders/${AIR_ID}/exchanges`, {
			item_key: airKey,
			title: AIR_TITLE,
			listing_id: AIR_LISTING,
			need_model: 'iPhone 15 Pro Max',
			have_model: 'AirPods Pro',
		})
		assert(clash.status === 400, `cross-family need_model is refused (got ${clash.status})`)
		assert(/iPhone case|AirPods/i.test((clash.body && clash.body.error) || ''), 'the error names the family mismatch')

		// ── AirPods Case Only BUY — corrected generation, nothing in hand ───────
		console.log('\nAirPods Case Only — buy the corrected generation:')
		const airOnlyBuy = await post(`/api/orders/${AIR_ONLY_ID}/exchanges`, {
			item_key: airOnlyKey,
			title: AIR_ONLY_TITLE,
			listing_id: AIR_ONLY_LISTING,
			need_model: 'AirPods 4',
			have_model: '',
		})
		assert(airOnlyBuy.status === 200 && airOnlyBuy.body.success, 'AirPods Case Only BUY is accepted')
		eq(airOnlyBuy.body.exchange.components, 'case', 'only the case is covered (no integral charm)')
		dash = (await api('/api/route/dashboard')).body
		const airOnlyRow = findRow(activeRows(dash), AIR_ONLY_ID)
		assert(!!airOnlyRow, 'AirPods Case Only BUY stays in the shopping dashboard')
		eq(airOnlyRow.shopping_model, 'AirPods 4', 'names the corrected generation to buy')
		eq(airOnlyRow.device_family, 'airpods', 'row is classified as AirPods')
		const ordersAir = (await api('/api/orders?receipt_id=' + AIR_ONLY_ID)).body.orders[0]
		const airTx = (ordersAir.transactions || []).find((t) => t.item_key === airOnlyKey)
		assert(airTx && airTx.device_family === 'airpods', 'Orders API exposes device_family on AirPods lines')
		assert(airTx && airTx.phone_model === 'AirPods 3', 'Orders API exposes resolved phone_model')
	} finally {
		child.kill()
		await new Promise((res) => setTimeout(res, 300))
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true })
		} catch {
			/* best effort */
		}
		if (failures > 0 && stderr) console.error('\n--- server stderr ---\n' + stderr.slice(-3000))
	}

	console.log('')
	if (failures > 0) {
		console.error(`${failures} assertion(s) FAILED`)
		process.exit(1)
	}
	console.log('All assertions passed.')
	process.exit(0)
}

main().catch((err) => {
	console.error('\nintegration test crashed:', err.message)
	process.exit(1)
})
