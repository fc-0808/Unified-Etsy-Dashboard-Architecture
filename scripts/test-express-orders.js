'use strict'

/**
 * Regression test — an order the buyer PAID to upgrade must be visible, worked
 * first, and shipped on a lane that actually delivers faster.
 *
 * WHY THIS EXISTS
 * ----------------------------------------------------------------------------
 * When an Etsy buyer picks a shipping upgrade at checkout they pay a real,
 * separate fee for SPEED — Etsy shows it in the seller's order manager as
 * "Express (HKD 119.99)" under "Selected by buyer". Before this feature the
 * dashboard could not see any of it: every card looked identical, so an express
 * parcel could sit behind forty standard ones on the bench and then ship
 * POSTLINK-LW economy for a ~20-day transit. The buyer paid for speed and got
 * none — a refund, a case, and a shop-quality hit.
 *
 * The fix has four halves and this test covers all of them:
 *
 *   CLASSIFIER  src/orders/shipping-upgrade.js turns Etsy's per-transaction
 *               `shipping_upgrade` name into a tier + an `expedited` boolean.
 *               Pure functions, so they are pinned exhaustively.
 *
 *   DATABASE    upsertReceipt persists the rollup, a sparse re-sync cannot wipe
 *               it, removing the upgrade on Etsy clears it, and historical rows
 *               are recovered from raw_json by backfillShippingUpgrades.
 *
 *   SERVER      /api/orders shapes it, filters on it, and sorts on it, so the
 *               express queue is reachable from any view.
 *
 *   4PX         resolveLogisticsProduct picks an EXPRESS lane for an upgraded
 *               order instead of the economy default, and assessExpressChoice
 *               flags a downgrade so the operator is warned before paying for a
 *               label that cannot be cheaply undone.
 *
 *   PAGE        The badge is lifted out of public/index.html and run in a DOM, so
 *               the code under test is the code that ships — including that
 *               seller-entered upgrade names cannot inject HTML.
 *
 * Run: `node scripts/test-express-orders.js` (or `npm run test:express-orders`)
 * Exit code 0 = all assertions pass, 1 = a regression was detected.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { JSDOM, VirtualConsole } = require('jsdom')

const shippingUpgrade = require('../src/orders/shipping-upgrade')
const productPreference = require('../src/fourpx/product-preference')
const { initDb, upsertReceipt, backfillShippingUpgrades } = require('../src/db/setup')

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
const NOW = Math.floor(Date.now() / 1000)
const PAGE = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8')

// ─────────────────────────────────────────────────────────────────────────────
// 1. The classifier
// ─────────────────────────────────────────────────────────────────────────────
function testClassifier() {
	section('Reading Etsy’s shipping_upgrade field')
	const { classifyUpgrade, deriveFromReceipt, normalizeUpgradeName, MAX_UPGRADE_NAME_LEN } = shippingUpgrade

	// Etsy sends null for ordinary shipping. Anything that means "no upgrade"
	// must produce no upgrade at all — a false positive here would badge every
	// order in the shop as express and make the badge worthless.
	for (const empty of [null, undefined, '', '   ', 0, false, {}, []]) {
		const c = classifyUpgrade(empty)
		assert(c.tier === null && c.expedited === false, `${JSON.stringify(empty)} is not an upgrade`)
	}

	// The real order that prompted this feature.
	const express = classifyUpgrade('Express')
	assert(express.tier === 'express' && express.expedited === true, '"Express" is an express upgrade')
	assert(express.label === 'Express' && express.name === 'Express', '…and reports both a label and Etsy’s own wording')

	// Sellers name their own upgrades in Shop Manager, so the same idea arrives
	// in many wordings. Each of these must be recognised as SPEED.
	const speedNames = [
		'Express',
		'EXPRESS SHIPPING',
		'Expedited Shipping (2-4 business days)',
		'Overnight',
		'Next Business Day',
		'1-2 day shipping',
		'DHL Express',
		'FedEx International Priority',
		'UPS Worldwide Saver',
		'EMS',
		'USPS Priority Mail',
		'First Class',
		'Royal Mail Tracked 24',
		'Rush my order',
		'Faster delivery',
		'Quick dispatch',
		'特快专递',
		'加急快递',
		'优先配送',
	]
	for (const n of speedNames) {
		const c = classifyUpgrade(n)
		assert(c.expedited === true, `"${n}" is read as a speed upgrade`)
	}

	// Tier ranking must be exact, because it decides the headline on a
	// multi-line order and which 4PX lane is recommended.
	assert(classifyUpgrade('DHL Express').tier === 'express', 'a courier-brand upgrade ranks as express')
	assert(classifyUpgrade('USPS Priority Mail').tier === 'priority', 'a named priority service ranks as priority')
	assert(classifyUpgrade('Expedited Shipping').tier === 'expedited', 'a generic "expedited" ranks as expedited')

	// A paid upgrade that buys something OTHER than speed must not be badged as
	// express — the badge means "work this first", and diluting it is how a
	// signal stops being read.
	for (const n of ['Insurance', 'Insured shipping', 'Signature required', 'Signed for', 'Gift wrapping', 'Packaging upgrade', 'Extra protection', '保险']) {
		const c = classifyUpgrade(n)
		assert(c.tier === 'service' && c.expedited === false, `"${n}" is a paid upgrade but NOT a speed upgrade`)
	}
	// The compound case: speed wins, so "Insured Express" is still express.
	assert(classifyUpgrade('Insured Express').tier === 'express', '"Insured Express" is read as express, not as insurance')

	// Fail-safe direction. Etsy describes the feature as "an alternate carrier or
	// faster delivery", so an unrecognised PAID upgrade is treated as speed:
	// over-prioritising one parcel costs minutes, under-prioritising costs the
	// sale. The raw name travels with it so a human can correct the impression.
	const unknown = classifyUpgrade('Zoom-o-matic Deluxe')
	assert(unknown.expedited === true && unknown.tier === 'expedited', 'an unrecognised upgrade name fails SAFE — treated as expedited')
	assert(unknown.name === 'Zoom-o-matic Deluxe', '…and carries Etsy’s exact wording through for the operator to read')

	// Storage/display hygiene.
	assert(normalizeUpgradeName('  Express   Shipping  ') === 'Express Shipping', 'whitespace is collapsed before storing')
	assert(normalizeUpgradeName('x'.repeat(500)).length === MAX_UPGRADE_NAME_LEN, 'an absurdly long name is capped so it cannot blow out a badge')

	section('Rolling a whole receipt up into one fact')
	// Etsy attaches upgrades to a LISTING's shipping profile, so a multi-line
	// order can genuinely be half-upgraded. The lines ship in one parcel, so any
	// upgraded line makes the whole parcel express.
	assert(deriveFromReceipt({ transactions: [] }).expedited === false, 'a receipt with no lines has no upgrade')
	assert(deriveFromReceipt({}).expedited === false, 'a malformed receipt does not throw and reports no upgrade')
	assert(deriveFromReceipt({ transactions: [{ shipping_upgrade: null }, { shipping_upgrade: null }] }).expedited === false, 'an ordinary two-line order reports no upgrade')

	const partial = deriveFromReceipt({
		transactions: [{ shipping_upgrade: 'Express', shipping_method: 'Express' }, { shipping_upgrade: null }],
	})
	assert(partial.expedited === true, 'ONE upgraded line makes the whole parcel express — the lines ship together')
	assert(partial.lines === 2 && partial.upgradedLines === 1, '…and the rollup states 1 of 2 lines, so the card can say which')

	const mixed = deriveFromReceipt({
		transactions: [{ shipping_upgrade: 'Expedited Shipping' }, { shipping_upgrade: 'DHL Express' }],
	})
	assert(mixed.tier === 'express', 'the STRONGEST tier is the headline — the fastest promise is the one that must be kept')
	assert(mixed.name.includes('Expedited Shipping') && mixed.name.includes('DHL Express'), '…while both buyer choices remain visible')

	const dedup = deriveFromReceipt({ transactions: [{ shipping_upgrade: 'Express' }, { shipping_upgrade: 'Express' }] })
	assert(dedup.name === 'Express', 'the same upgrade on two lines is not repeated in the headline')

	const serviceOnly = deriveFromReceipt({ transactions: [{ shipping_upgrade: 'Gift wrapping' }] })
	assert(serviceOnly.tier === 'service' && serviceOnly.expedited === false, 'a non-speed upgrade is recorded but does not make the order express')
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Persistence
// ─────────────────────────────────────────────────────────────────────────────
function testPersistence() {
	section('Persisting the upgrade across Etsy re-syncs')
	const db = initDb(':memory:')
	db.prepare('INSERT INTO groups (group_id, label) VALUES (?,?)').run('G1', 'Group 1')
	db.prepare('INSERT INTO shops (shop_id, group_id, shop_name) VALUES (?,?,?)').run('S1', 'G1', 'Y2KASEshop')

	const receipt = (over = {}) => ({
		receipt_id: 5001,
		status: 'Paid',
		is_paid: true,
		is_shipped: false,
		name: 'Minerva H Hernandez',
		create_timestamp: NOW - DAY,
		update_timestamp: NOW,
		transactions: [{ transaction_id: 91, title: 'Kawaii Character Pink Case', listing_id: 700, quantity: 1, expected_ship_date: NOW + DAY, shipping_upgrade: 'Express', shipping_method: 'Express', variations: [] }],
		...over,
	})
	const read = () => db.prepare('SELECT shipping_upgrade, shipping_method, shipping_upgrade_tier, is_expedited, all_transactions FROM receipts WHERE receipt_id = 5001').get()

	upsertReceipt(db, 'S1', 'G1', receipt())
	let row = read()
	assert(row.shipping_upgrade === 'Express', 'the upgrade name is stored on the receipt')
	assert(row.shipping_method === 'Express', 'Etsy’s companion shipping_method is stored too')
	assert(row.shipping_upgrade_tier === 'express', 'the classified tier is stored, so a badge never re-derives it')
	assert(row.is_expedited === 1, 'the flag the SQL filter and sort read is set')
	assert(JSON.parse(row.all_transactions)[0].shipping_upgrade === 'Express', 'the per-line upgrade is kept so a part-upgraded order can name the line')

	// Etsy's receipts endpoint can return a receipt whose transactions array is
	// absent or empty. Letting that null the columns would make an express order
	// silently become standard on the next sync — the exact failure this guards.
	upsertReceipt(db, 'S1', 'G1', receipt({ transactions: [] }))
	row = read()
	assert(row.shipping_upgrade === 'Express' && row.is_expedited === 1, 'a sparse re-sync (no transactions) does NOT wipe the upgrade')

	// …but a real change on Etsy must land. If the seller removes the upgrade,
	// or the buyer's order is edited, the order stops being express.
	upsertReceipt(db, 'S1', 'G1', receipt({ transactions: [{ transaction_id: 91, title: 'Kawaii Character Pink Case', listing_id: 700, quantity: 1, shipping_upgrade: null, shipping_method: null, variations: [] }] }))
	row = read()
	assert(row.shipping_upgrade === null && row.is_expedited === 0, 'an upgrade removed on Etsy clears the flag — the dashboard never keeps a promise nobody bought')

	// Historical rows: the columns did not exist when they were synced, but the
	// raw Etsy payload did. Re-syncing 20 shops of history is not an option, so
	// the truth is recovered from raw_json.
	section('Recovering the upgrade from already-synced history')
	db.prepare('UPDATE receipts SET shipping_upgrade = NULL, shipping_method = NULL, shipping_upgrade_tier = NULL, is_expedited = 0, raw_json = ?, all_transactions = ? WHERE receipt_id = 5001').run(
		JSON.stringify(receipt()),
		JSON.stringify([{ listing_id: 700, title: 'Kawaii Character Pink Case', quantity: 1, variations: [] }]),
	)
	const res = backfillShippingUpgrades(db)
	row = read()
	assert(res.expedited === 1, 'the backfill reports what it recovered')
	assert(row.is_expedited === 1 && row.shipping_upgrade === 'Express', 'a pre-migration order is recovered from its stored Etsy payload')
	assert(row.shipping_upgrade_tier === 'express', '…including its tier')
	assert(JSON.parse(row.all_transactions)[0].shipping_upgrade === 'Express', '…and the per-line detail is merged back into the transaction blob')

	// Idempotency: the backfill runs on migration and must be safe to re-run.
	const again = backfillShippingUpgrades(db)
	assert(again.expedited === 1 && read().is_expedited === 1, 're-running the backfill is idempotent')

	const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_receipts_expedited'").get()
	assert(!!idx, 'express orders are indexed, so the database-wide count stays a cheap lookup')
	db.close()
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. The 4PX lane
// ─────────────────────────────────────────────────────────────────────────────
function testLanes() {
	section('Choosing a 4PX lane that honours the upgrade')
	const { resolveLogisticsProduct, assessExpressChoice, isExpressProduct, expressCandidates, FOURPX_POSTLINK_S5058_CODE } = productPreference

	// The baseline that must not change: an ordinary order still defaults to the
	// cheap POSTLINK-LW lane. Everything below is additive.
	assert(resolveLogisticsProduct({ country: 'US' }) === FOURPX_POSTLINK_S5058_CODE, 'an ordinary US order still defaults to the economy POSTLINK-LW lane')

	// The bug: an express order defaulting to POSTLINK-LW converts a paid few-day
	// promise into a ~20-day economy transit.
	const usExpress = resolveLogisticsProduct({ country: 'US', expedited: true })
	assert(usExpress !== FOURPX_POSTLINK_S5058_CODE, 'an EXPRESS US order does NOT default to the economy lane')
	assert(usExpress === 'S5063', '…it takes the China–US Fast Track, the fastest lane the account holds for the biggest destination')
	assert(resolveLogisticsProduct({ country: 'GB', expedited: true }) === 'PX', 'elsewhere an express order takes the worldwide POSTLINK Priority lane')

	// A live catalogue is authoritative: never pre-select a code the destination
	// cannot actually use.
	const noFastTrack = [{ logistics_product_code: 'PX' }, { logistics_product_code: 'S5058' }]
	assert(resolveLogisticsProduct({ country: 'US', availableProducts: noFastTrack, expedited: true }) === 'PX', 'when the Fast Track is not on offer the next express candidate is used')

	// An uncurated express lane beats silently dropping to economy.
	const onlyUnknownExpress = [{ logistics_product_code: 'ZX9', transport_mode: '1' }, { logistics_product_code: 'S5058' }]
	assert(resolveLogisticsProduct({ country: 'DE', availableProducts: onlyUnknownExpress, expedited: true }) === 'ZX9', 'an express lane we do not curate is still preferred over the economy default')

	// …but a destination with NO express lane must still produce something
	// bookable: refusing to pre-select would leave an empty picker on the most
	// time-critical order in the queue.
	const postalOnly = [{ logistics_product_code: 'S5058', transport_mode: '3' }, { logistics_product_code: 'QC', transport_mode: '3' }]
	assert(resolveLogisticsProduct({ country: 'US', availableProducts: postalOnly, expedited: true }) === 'S5058', 'a destination with no express lane still resolves to a bookable product')

	// Lane classification, by trustworthiness of signal.
	assert(isExpressProduct({ transport_mode: '1' }) === true, '4PX transport_mode 1 (Express/Commercial) is a speed lane')
	assert(isExpressProduct({ transport_mode: '2' }) === true, 'transport_mode 2 (Priority air) is a speed lane')
	assert(isExpressProduct({ transport_mode: '3' }) === false, 'transport_mode 3 (Postal) is NOT a speed lane')
	assert(isExpressProduct({ transport_mode_label: 'postal' }) === false, '…and neither is a postal label')
	assert(isExpressProduct({ tier: 'express' }) === true, 'the curated shortlist’s express tier counts')
	assert(isExpressProduct({ logistics_product_code: 'S5058' }) === false, 'POSTLINK-LW is not an express lane, whatever else is on the entry')
	assert(isExpressProduct(null) === false, 'a missing product is not express')
	assert(expressCandidates('us')[0] === 'S5063', 'candidate lookup is case-insensitive on the country')

	section('Warning before a paid upgrade is downgraded')
	const down = assessExpressChoice({ country: 'US', selectedCode: 'S5058', expedited: true })
	assert(down.downgraded === true, 'booking an express order on POSTLINK-LW is flagged as a downgrade')
	assert(down.recommended === 'S5063', '…and the warning names the lane that would honour it')
	const ok = assessExpressChoice({ country: 'US', selectedCode: 'S5063', expedited: true })
	assert(ok.downgraded === false && ok.express === true, 'an express order on an express lane raises nothing')
	const ordinary = assessExpressChoice({ country: 'US', selectedCode: 'S5058', expedited: false })
	assert(ordinary.downgraded === false, 'an ORDINARY order on the economy lane is not a downgrade — that is the correct default')
	// PX with no catalogue on hand: membership of the curated express list is the
	// only evidence available, and must be enough — otherwise a correctly-chosen
	// express shipment would be flagged as a downgrade.
	assert(assessExpressChoice({ country: 'GB', selectedCode: 'PX', expedited: true }).downgraded === false, 'a curated express code is recognised even with no catalogue loaded')

	// Every express candidate must be a code the dashboard actually offers, or
	// 4PX rejects the order with an opaque DS000110 at create time. This is the
	// drift guard between the two tables.
	const serverSrc = fs.readFileSync(path.resolve(__dirname, '../src/server/index.js'), 'utf8')
	const curated = serverSrc.slice(serverSrc.indexOf('const FOURPX_RECOMMENDED_PRODUCTS = ['), serverSrc.indexOf('function _fpxProductServesCountry'))
	for (const code of new Set([...productPreference.FOURPX_EXPRESS_WORLDWIDE, ...Object.values(productPreference.FOURPX_EXPRESS_BY_COUNTRY).flat()])) {
		assert(new RegExp(`code: '${code}'`).test(curated), `express candidate ${code} exists in the curated 4PX shortlist — not a guessed code`)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. The server
// ─────────────────────────────────────────────────────────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ued-express-'))
const dbPath = path.join(tmpDir, 'test.db')
const configPath = path.join(tmpDir, 'config.json')
const port = 4900 + (process.pid % 400)
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

const TX = (lines) => JSON.stringify(lines.map((l, i) => ({ title: `Line ${i}`, listing_id: 900 + i, quantity: 1, expected_ship_date: l.ship, ...(l.upgrade ? { shipping_upgrade: l.upgrade, shipping_method: l.upgrade } : {}) })))

function seed(db) {
	db.prepare('INSERT INTO groups (group_id, label) VALUES (?,?)').run('G1', 'Group 1')
	db.prepare('INSERT INTO shops (shop_id, group_id, shop_name) VALUES (?,?,?)').run('S1', 'G1', 'Y2KASEshop')
	db.prepare('INSERT INTO shops (shop_id, group_id, shop_name) VALUES (?,?,?)').run('S2', 'G1', 'OtherShop')

	const ins = db.prepare(`
    INSERT INTO receipts
      (receipt_id, shop_id, group_id, name, status, is_paid, is_shipped,
       first_ship_by, all_transactions, etsy_created_at,
       shipping_upgrade, shipping_method, shipping_upgrade_tier, is_expedited)
    VALUES (@receipt_id, @shop_id, 'G1', @name, @status, @is_paid, @is_shipped,
            @first_ship_by, @all_transactions, @etsy_created_at,
            @shipping_upgrade, @shipping_method, @shipping_upgrade_tier, @is_expedited)`)
	const base_ = { shop_id: 'S1', status: 'Paid', is_paid: 1, is_shipped: 0, etsy_created_at: NOW - 3 * DAY, shipping_upgrade: null, shipping_method: null, shipping_upgrade_tier: null, is_expedited: 0 }
	const row = (o) => ins.run({ ...base_, ...o })

	// The order from the screenshot: Express, HKD 119.99, due in 6 days.
	row({ receipt_id: 6001, name: 'Express Soon', first_ship_by: NOW + 3 * HOUR, all_transactions: TX([{ ship: NOW + 3 * HOUR, upgrade: 'Express' }]), shipping_upgrade: 'Express', shipping_method: 'Express', shipping_upgrade_tier: 'express', is_expedited: 1 })
	// Express but with more time left — must sort AFTER the urgent express one.
	row({ receipt_id: 6002, name: 'Express Later', shop_id: 'S2', first_ship_by: NOW + 3 * DAY, all_transactions: TX([{ ship: NOW + 3 * DAY, upgrade: 'DHL Express' }]), shipping_upgrade: 'DHL Express', shipping_method: 'DHL Express', shipping_upgrade_tier: 'express', is_expedited: 1 })
	// Ordinary order due sooner than either — must still sort below both under
	// express_first, because the buyer who paid is served first.
	row({ receipt_id: 6003, name: 'Standard Urgent', first_ship_by: NOW + HOUR, all_transactions: TX([{ ship: NOW + HOUR }]) })
	// Plain standard order.
	row({ receipt_id: 6004, name: 'Standard', first_ship_by: NOW + 5 * DAY, all_transactions: TX([{ ship: NOW + 5 * DAY }]) })
	// Part-upgraded two-line order: one line Express, one standard.
	row({ receipt_id: 6005, name: 'Partly Express', first_ship_by: NOW + 2 * DAY, all_transactions: TX([{ ship: NOW + 2 * DAY, upgrade: 'Express' }, { ship: NOW + 2 * DAY }]), shipping_upgrade: 'Express', shipping_method: 'Express', shipping_upgrade_tier: 'express', is_expedited: 1 })
	// Paid upgrade that is NOT speed — recorded, but never counted as express.
	row({ receipt_id: 6006, name: 'Insured', first_ship_by: NOW + 4 * DAY, all_transactions: TX([{ ship: NOW + 4 * DAY, upgrade: 'Insurance' }]), shipping_upgrade: 'Insurance', shipping_method: 'Insurance', shipping_upgrade_tier: 'service', is_expedited: 0 })
	// Express but already shipped — the promise is kept, so it is not outstanding.
	row({ receipt_id: 6007, name: 'Express Shipped', is_shipped: 1, status: 'Completed', first_ship_by: NOW - DAY, all_transactions: TX([{ ship: NOW - DAY, upgrade: 'Express' }]), shipping_upgrade: 'Express', shipping_method: 'Express', shipping_upgrade_tier: 'express', is_expedited: 1 })
	// Express but cancelled — nothing left to rush.
	row({ receipt_id: 6008, name: 'Express Cancelled', status: 'Canceled', first_ship_by: NOW + DAY, all_transactions: TX([{ ship: NOW + DAY, upgrade: 'Express' }]), shipping_upgrade: 'Express', shipping_method: 'Express', shipping_upgrade_tier: 'express', is_expedited: 1 })
	// A pre-migration row: NULL rather than 0 in is_expedited. It must appear in
	// the Standard-only filter, not vanish from BOTH sides of it.
	row({ receipt_id: 6009, name: 'Legacy Null', first_ship_by: NOW + 6 * DAY, all_transactions: TX([{ ship: NOW + 6 * DAY }]), is_expedited: null })
}

async function getJson(qs) {
	const res = await fetch(base + '/api/orders' + qs)
	return { status: res.status, body: await res.json().catch(() => ({})) }
}

async function testServer() {
	section('What the orders API reports about express work')
	fs.writeFileSync(
		configPath,
		JSON.stringify({
			db_path: dbPath,
			sync_interval_minutes: 1440,
			groups: [{ group_id: 'G1', label: 'Express test', proxy: 'direct', shops: [{ shop_id: 'S1', shop_name: 'Y2KASEshop', api_key: 'expresstestkey0000000001', shared_secret: 'expresstestsecret000001' }] }],
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

		const all = await getJson('?shipped=all&limit=200')
		assert(all.status === 200, 'the orders list responds')
		const byId = new Map((all.body.orders || []).map((o) => [o.receipt_id, o]))

		// ── The shaped payload ────────────────────────────────────────────────
		const exp = byId.get(6001)
		assert(!!exp && !!exp.shipping_upgrade, 'an express order carries a shipping_upgrade object')
		assert(exp.shipping_upgrade.name === 'Express', '…naming exactly what the buyer chose on Etsy')
		assert(exp.shipping_upgrade.tier === 'express' && exp.shipping_upgrade.label === 'Express', '…with a tier and an operator label')
		assert(exp.shipping_upgrade.expedited === true && exp.is_expedited === true, '…and a flat boolean, so a consumer can gate on one field')
		assert(byId.get(6004)?.shipping_upgrade === null, 'an ordinary order carries null — the overwhelming majority stay cheap to render')
		assert(byId.get(6004)?.is_expedited === false, '…and reports false rather than undefined')

		// Raw columns must not leak: `shipping_upgrade` in the payload is the
		// shaped object, and a stray alias beside it invites half-reads.
		assert(!('shipping_upgrade_name' in exp) && !('shipping_upgrade_tier' in exp) && !('shipping_upgrade_method' in exp), 'the raw SQL aliases are stripped, so the shaped object is the only way to read the upgrade')

		// A non-speed upgrade is visible but is NOT express — the badge means
		// "work this first", and diluting it makes it unreadable.
		const insured = byId.get(6006)
		assert(insured.shipping_upgrade?.name === 'Insurance', 'a non-speed paid upgrade is still reported')
		assert(insured.shipping_upgrade.expedited === false && insured.is_expedited === false, '…but never counted as express')

		// Part-upgraded order: the card must be able to say WHICH line.
		const part = byId.get(6005)
		assert(part.shipping_upgrade.lines === 2 && part.shipping_upgrade.upgradedLines === 1, 'a part-upgraded order reports 1 of 2 lines')
		assert(part.transactions[0].shipping_upgrade === 'Express' && part.transactions[1].shipping_upgrade == null, '…and the per-line detail says which product it was')

		// ── The filter ────────────────────────────────────────────────────────
		section('Filtering to the express queue')
		const onlyExpress = await getJson('?shipped=all&expedited=true&limit=200')
		const expIds = (onlyExpress.body.orders || []).map((o) => o.receipt_id).sort()
		assert(JSON.stringify(expIds) === JSON.stringify([6001, 6002, 6005, 6007, 6008]), `expedited=true returns exactly the express orders (got ${expIds.join(',')})`)
		assert((onlyExpress.body.orders || []).every((o) => o.is_expedited === true), '…and every row it returns really is express')

		const onlyStandard = await getJson('?shipped=all&expedited=false&limit=200')
		const stdIds = (onlyStandard.body.orders || []).map((o) => o.receipt_id).sort()
		assert(JSON.stringify(stdIds) === JSON.stringify([6003, 6004, 6006, 6009]), `expedited=false returns exactly the non-express orders (got ${stdIds.join(',')})`)
		assert(stdIds.includes(6009), 'a pre-migration row (NULL, not 0) appears in the Standard filter rather than vanishing from both sides')

		const unfiltered = await getJson('?shipped=all&limit=200')
		assert((unfiltered.body.orders || []).length === 9, 'omitting the filter returns everything')

		// Orthogonality is the point: "what did someone pay to rush, and is it
		// still unshipped?" has to be one question.
		const openExpress = await getJson('?shipped=false&expedited=true&limit=200')
		const openIds = (openExpress.body.orders || []).map((o) => o.receipt_id).sort()
		assert(JSON.stringify(openIds) === JSON.stringify([6001, 6002, 6005]), 'the express filter composes with the Needs-shipping scope')

		// ── The sort ──────────────────────────────────────────────────────────
		section('Working the express queue first')
		const sorted = await getJson('?shipped=false&sort=express_first&limit=200')
		const ids = (sorted.body.orders || []).map((o) => o.receipt_id)
		assert(ids[0] === 6001, 'the most urgent EXPRESS order leads the queue')
		assert(ids[1] === 6005 && ids[2] === 6002, '…then the rest of the express block, in deadline order')
		assert(ids.indexOf(6003) > ids.indexOf(6002), 'a standard order due sooner still sorts BELOW every express one — the buyer who paid is served first')
		assert(ids.indexOf(6009) > ids.indexOf(6002), 'a pre-migration row sorts with the standard block, not above the express one')

		// The pre-existing sorts must be untouched.
		const byDeadline = await getJson('?shipped=false&sort=ship_by_soonest&limit=200')
		assert((byDeadline.body.orders || [])[0]?.receipt_id === 6003, 'the deadline sort is unchanged — it still leads with the soonest deadline regardless of express')

		assert(!/express rollup failed/.test(stderr), 'the express rollup ran without falling back to its error path')
		assert(!/shipping-upgrade/i.test(stderr) || !/error/i.test(stderr), 'no shipping-upgrade errors were logged')
	} finally {
		child.kill()
		await new Promise((r) => setTimeout(r, 200))
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true })
		} catch {
			/* ignore */
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. What the card actually renders
//
// The badge is the whole point of the feature, so it is exercised as SHIPPED
// CODE rather than matched with a regex: the block is lifted out of
// public/index.html and run in a DOM.
// ─────────────────────────────────────────────────────────────────────────────
function makeBadgeEnv() {
	const START = '// ══ EXPRESS / SHIPPING-UPGRADE QUEUE ══'
	const END = '// ══ END EXPRESS ══'
	const s = PAGE.indexOf(START)
	const e = PAGE.indexOf(END)
	if (s < 0 || e <= s) throw new Error('Could not locate the express sentinels in public/index.html')

	const virtualConsole = new VirtualConsole()
	virtualConsole.on('jsdomError', () => {})
	const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'dangerously', virtualConsole })
	const { window } = dom
	// Faithful copies of the page's own escapers; the express block is the unit
	// under test.
	window.eval(`
    function escHtml(x){return String(x==null?'':x).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
    function escAttr(x){return escHtml(x).replace(/'/g,'&#39;')}
  `)
	window.eval(PAGE.slice(s, e))
	return window
}

function testRender() {
	section('What an express card actually renders')
	const w = makeBadgeEnv()
	const badge = (u) => w.expressBadgeMarkup(u)
	const upgrade = (o = {}) => ({ name: 'Express', method: '', tier: 'express', label: 'Express', expedited: true, lines: 1, upgradedLines: 1, ...o })

	assert(badge(null) === '', 'an ordinary order renders nothing at all — no empty node, no layout shift')
	assert(badge(undefined) === '' && badge({}) === '', 'a missing or empty upgrade object renders nothing rather than an empty badge')

	// The order from the screenshot.
	const real = badge(upgrade())
	assert(/class="express-badge"/.test(real), 'an express order renders the express badge')
	assert(/>Express</.test(real), '…reading "Express"')
	assert(!/express-badge-note/.test(real), '…with no redundant note, because Etsy’s wording and the tier label agree')
	assert(/paid extra at checkout/.test(real) && /ahead of the standard queue/.test(real), '…and a tooltip that says what to DO about it, not just what it is')

	// A tier label that hides the buyer's actual wording must not lose it.
	const dhl = badge(upgrade({ name: 'DHL Express 2-3 days' }))
	assert(/class="express-badge-note"/.test(dhl) && /DHL Express 2-3 days/.test(dhl), 'a wordier upgrade shows Etsy’s exact wording under the badge')

	// A paid upgrade that is not speed must be visibly DIFFERENT, or the badge
	// stops meaning "work this first".
	const ins = badge({ name: 'Insurance', method: '', tier: 'service', label: 'Shipping upgrade', expedited: false, lines: 1, upgradedLines: 1 })
	assert(!/class="express-badge"/.test(ins), 'a non-speed paid upgrade does NOT get the express badge')
	assert(/class="express-line-chip"/.test(ins) && />Insurance</.test(ins), '…it gets the quiet chip, naming what the buyer actually bought')
	assert(/not a speed upgrade/.test(ins), '…and says so, so nobody rushes it by mistake')

	const partial = badge(upgrade({ lines: 3, upgradedLines: 1 }))
	assert(/on 1 of 3 products/.test(partial), 'a part-upgraded order explains that one line rushes the whole parcel')
	assert(!/on 1 of 1 products/.test(badge(upgrade())), '…and a fully-upgraded order does not state the obvious')

	const withMethod = badge(upgrade({ method: 'USPS Priority Mail Express' }))
	assert(/\(USPS Priority Mail Express\)/.test(withMethod), 'the carrier service Etsy recorded is shown when it says more than the upgrade name')
	assert(!/\(Express\)/.test(badge(upgrade({ method: 'Express' }))), '…and is not repeated when it is the same string')

	// Seller-entered text reaches this unescaped, so a shop naming an upgrade
	// with a tag or a quote must not be able to break out of the badge or its
	// title attribute. Asserted by PARSING the result: escaped markup still
	// contains the literal characters, and only the DOM can say whether they
	// became an element.
	{
		const evil = '<img src=x onerror="alert(1)">'
		const host = w.document.createElement('div')
		host.innerHTML = badge(upgrade({ name: evil, label: 'Express' }))
		assert(host.querySelector('img') === null, 'a seller-entered upgrade name cannot inject an element')
		assert(host.querySelectorAll('*').length === 2, '…and produces exactly the badge and its note, nothing more')
		const note = host.querySelector('.express-badge-note')
		assert(note?.textContent === evil, '…the name is rendered as inert text, verbatim')
		assert(note?.getAttribute('title') === evil, '…and the quotes inside it do not escape the title attribute')
		assert(host.querySelector('.express-badge')?.getAttribute('title')?.includes(evil), '…nor the tooltip that embeds it')
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Page wiring
// ─────────────────────────────────────────────────────────────────────────────
function testPage() {
	section('The Orders page is actually wired to it')
	assert(/class="express-badge"/.test(PAGE), 'an express order gets a badge on its card')
	assert(/\.express-badge \{/.test(PAGE), '…with its own style, not borrowed from another badge')
	assert(/const expressBadgeHtml = expressBadgeMarkup\(_upgrade\)/.test(PAGE), '…built by the one badge function, so the tested code is the rendered code')
	assert(/o\.shipping_upgrade \|\| null/.test(PAGE), '…read from the server’s shaped object rather than re-derived in the browser')
	assert(/expressRowCls/.test(PAGE) && /order-row\.is-express td:first-child/.test(PAGE), 'the row carries a left-edge accent so express work can be found by scanning')
	assert(PAGE.indexOf('.order-row.is-express td:first-child') < PAGE.indexOf('.order-row.is-deadline-overdue td:first-child'), '…declared before the deadline accents, so an overdue order still owns the edge')
	assert(/class="express-line-chip"/.test(PAGE), 'a part-upgraded order marks WHICH line the buyer paid to rush')
	assert(/id="filterExpedited"/.test(PAGE) && /params\.set\('expedited', expeditedFilter\)/.test(PAGE), 'the Express filter exists and is sent to the server')
	assert(/value="express_first"/.test(PAGE), 'the sort dropdown offers express-first order')
	// The express queue is reached through the toolbar. There is deliberately no
	// banner: a standing card above the list cost a row of vertical space on every
	// view, and the filter plus the express-first sort already reach the same
	// queue. This asserts the removal stayed complete, because a half-removed
	// banner is a call to a function that no longer exists.
	assert(!/expressBanner|updateExpressBanner|showExpressOrders|expedited_outstanding/.test(PAGE), 'no express banner remains — the filter and the sort are the way in')

	section('The 4PX drawer is wired to it')
	assert(/id="fpxExpressNotice"/.test(PAGE), 'the drawer states the upgrade before a label is paid for')
	assert(/function _fpxIsExpeditedOrder\(\)/.test(PAGE), '…decided from the server’s shaped object')
	assert(/_fpxPickLogisticsProduct\(countryCode, _fpxProducts, _fpxIsExpeditedOrder\(\)\)/.test(PAGE), 'the pre-selected lane accounts for the upgrade')
	assert(/is-downgrade/.test(PAGE), '…and a non-express choice is called out as a downgrade')
	assert(/_fpxRenderExpressNotice\(\)/.test(PAGE) && /_fpxRenderExpressNotice\(\)\s*\n\s*\/\/ Animate trigger/.test(PAGE), 'the warning tracks the operator’s actual choice, not just the pre-selection')
	assert(/expedited: !!\(o\.shipping_upgrade && o\.shipping_upgrade\.expedited\)/.test(PAGE), 'the bulk ship wizard carries the upgrade per order')
	assert(/_fpxPickLogisticsProduct\(e\.country, products, e\.expedited\)/.test(PAGE), '…so a bulk run cannot silently default a paid upgrade onto the economy lane')
	assert(/fbx-chip express/.test(PAGE) && /expressDowngrade/.test(PAGE), '…and the wizard marks the rows plus warns about the batch as a whole')
	// Express gets the same treatment as multi-product: a filter chip to isolate
	// the subset, a sky row accent so they stand out in All, and a count that
	// drives both. Without the chip an operator shipping 60+ parcels has no way
	// to review only the paid upgrades before committing irreversible labels.
	assert(/chip\('express', 'Express orders'/.test(PAGE), 'the bulk wizard offers an Express orders filter chip')
	assert(/_fbxFilter === 'express'/.test(PAGE) && /e\.expedited/.test(PAGE), '…that filters to expedited rows')
	assert(/\.fbx-row\.express\s*\{/.test(PAGE), '…and express rows are highlighted in All the same way multi-product rows are')
	assert(/if \(e\.expedited\) rowClass \+= ' express'/.test(PAGE), '…by tagging the row when the order carries a paid upgrade')
	assert(/fbx-banner express/.test(PAGE) && /c\.express/.test(PAGE), '…with a presence banner and a live count, parallel to Multiple products')
	assert(/'Express orders': '快递订单'/.test(PAGE), 'the Express orders chip has a Chinese translation')

	section('Every new string can be translated')
	// The dashboard runs bilingual shops; an untranslated operator instruction is
	// an instruction half the bench cannot read.
	for (const key of ['Express', 'Not express', 'Express only', 'Standard only', 'Express first', 'Express orders']) {
		assert(new RegExp(`(^|\\n)\\s*(?:'${key.replace(/[.*+?^${}()|[\]\\—]/g, '\\$&')}'|${key}):`, 'm').test(PAGE), `"${key}" has a Chinese translation`)
	}
}

;(async () => {
	console.log('Express / paid-shipping-upgrade regression test')
	testClassifier()
	testPersistence()
	testLanes()
	await testServer()
	testRender()
	testPage()

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
