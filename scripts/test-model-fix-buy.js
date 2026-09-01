'use strict'

/**
 * Regression test — a model fix with NOTHING in hand is a PURCHASE, not a swap.
 *
 * Reproduces the reported bug: an order whose buyer needs iPhone 16 (they ordered
 * an iPhone 14/13 case) was flagged via "Fix model" with the need-model set and
 * the have-model left blank — the operator's way of saying "I hold nothing, I'll
 * buy the correct one". The order then VANISHED from the Orders Sorting
 * dashboard, so nobody ever bought the case.
 *
 * Root cause: every consumer treated any open model fix as "the case is in hand,
 * hold it out of buying", which is only true for a SWAP. With nothing in hand
 * there is nothing to hold back — and worse, the line still advertised the
 * buyer's original (known-wrong) model, so even when it was visible a shopper
 * would have re-bought the wrong case.
 *
 * Guards the SINGLE SOURCE OF TRUTH helpers in src/route/dashboard.js shared by
 * the desktop Route tab, mobile /api/shop/route, the Orders rollup and the Excel
 * export, plus the packing-queue predicate in src/orders/pack-queue.js — so the
 * swap/buy boundary can never silently collapse again.
 *
 * Run: `node scripts/test-model-fix-buy.js`
 * Exit code 0 = all assertions pass, 1 = a regression was detected.
 */

const rd = require('../src/route/dashboard')
const packQueue = require('../src/orders/pack-queue')

let failures = 0
function assert(cond, msg) {
	if (cond) {
		console.log(`  ok  — ${msg}`)
	} else {
		failures++
		console.error(`  FAIL — ${msg}`)
	}
}
function eq(a, b, msg) {
	assert(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)
}

// The reported order: a Case-only line the buyer needs in iPhone 16, ordered as
// iPhone 14/13. Nothing is in hand — `exchange_have_model` is blank — so the
// corrected case still has to be bought.
function buyFixRow(overrides = {}) {
	return {
		receipt_id: 3312,
		item_key: 'rainbow stars clear case\x00888',
		title: 'Rainbow Stars Clear Case with Beaded Charm',
		quantity: 1,
		phone_model: 'iPhone 14/13',
		style: 'Case',
		has_case: true,
		has_grip: false,
		has_charm: false,
		status_case: 'Pending',
		status_grip: 'Pending',
		status_charm: 'Pending',
		supplier_shop: 'DingJi',
		supplier_stall: 'A203A',
		needs_exchange: true,
		exchange_id: 91,
		exchange_components: 'case',
		exchange_have_model: '', // ← nothing in hand: this is a BUY
		exchange_need_model: 'iPhone 16',
		...overrides,
	}
}

// The same line as a SWAP: we hold an iPhone 14/13 case to exchange at the stall.
function swapFixRow(overrides = {}) {
	return buyFixRow({ exchange_have_model: 'iPhone 14/13', ...overrides })
}

console.log('Model fix "buy the correct model" regression test\n')

// ── 1. Intent — the one field that decides the two shapes ────────────────────
console.log('exchangeIntent:')
{
	eq(rd.exchangeIntent(buyFixRow()), rd.EXCHANGE_INTENT_BUY, 'a blank have-model is a BUY')
	eq(rd.exchangeIntent(swapFixRow()), rd.EXCHANGE_INTENT_SWAP, 'a filled have-model is a SWAP')
	eq(rd.exchangeIntent(buyFixRow({ exchange_have_model: '   ' })), rd.EXCHANGE_INTENT_BUY, 'a whitespace-only have-model is still a BUY')
	eq(rd.exchangeIntent(buyFixRow({ needs_exchange: false })), null, 'a row with no open fix has no intent')
	eq(rd.exchangeRecordIntent({ have_model: null }), rd.EXCHANGE_INTENT_BUY, 'a raw record with a NULL have_model is a BUY')
	eq(rd.exchangeRecordIntent({ have_model: 'iPhone 14/13' }), rd.EXCHANGE_INTENT_SWAP, 'a raw record with a have_model is a SWAP')
	eq(rd.exchangeRecordIntent(null), null, 'no record → no intent')
}

// ── 2. A BUY withholds nothing from the buy set ──────────────────────────────
console.log('\nexchangeHeldComponents / shoppableComponentFlags:')
{
	assert(rd.exchangeHeldComponents(buyFixRow()).size === 0, 'a BUY holds no components — there is no item in hand')
	assert(rd.exchangeHeldComponents(swapFixRow()).has('case'), 'a SWAP still holds its case')

	const f = rd.shoppableComponentFlags(buyFixRow())
	eq([f.has_case, f.has_grip, f.has_charm], [true, false, false], 'the case of a BUY stays shoppable')

	const combo = rd.shoppableComponentFlags(buyFixRow({ has_grip: true, has_charm: true, style: 'Case+Grip+Charm' }))
	eq([combo.has_case, combo.has_grip, combo.has_charm], [true, true, true], 'a BUY on a combo line keeps every piece shoppable')
}

// ── 3. The reported symptom: the line must stay in the dashboard ─────────────
console.log('\nrowHasShoppingWork (the reported disappearance):')
{
	assert(rd.rowHasShoppingWork(buyFixRow()) === true, 'a case-only BUY still has shopping work — it must NOT vanish from the dashboard')
	assert(rd.rowHasShoppingWork(swapFixRow()) === false, 'a case-only SWAP has no shopping work (it is carried back, not bought)')
	assert(rd.rowHasShoppingWork(buyFixRow({ status_case: 'Purchased' })) === false, 'once the corrected case is bought there is no shopping work left')
}

// ── 4. The corrected model must reach every human-facing surface ─────────────
console.log('\neffectiveShoppingModel:')
{
	eq(rd.effectiveShoppingModel(buyFixRow()), 'iPhone 16', 'a BUY names the model to actually get')
	eq(rd.effectiveShoppingModel(swapFixRow()), 'iPhone 16', 'a SWAP names the model to end up with')
	eq(rd.effectiveShoppingModel(buyFixRow({ needs_exchange: false })), 'iPhone 14/13', 'an unfixed line keeps the ordered model')
	eq(rd.effectiveShoppingModel(buyFixRow({ exchange_need_model: '' })), 'iPhone 14/13', 'a fix with no need-model falls back to the ordered model')
}

// ── 5. Projection — what the mobile shopping route receives ──────────────────
console.log('\nrowShoppingProjection:')
{
	const view = rd.rowShoppingProjection(buyFixRow())
	assert(view, 'a case-only BUY survives into the shopping route')
	eq([view.has_case, view.has_grip, view.has_charm], [true, false, false], 'the projected BUY row still buys its case')
	eq(view.phone_model, 'iPhone 16', 'the projected row advertises the CORRECTED model')
	eq(view.ordered_phone_model, 'iPhone 14/13', 'the ordered model is preserved so the correction can be shown')
	assert(view.fully_purchased === false, 'an unbought corrected case is not fully purchased')

	const bought = rd.rowShoppingProjection(buyFixRow({ status_case: 'Purchased' }))
	assert(bought && bought.fully_purchased === true, 'buying the corrected case completes the line')
}

// ── 6. The generated Excel must print the corrected model ────────────────────
console.log('\nrowsToImportOrders (batch Excel export):')
{
	const orders = rd.rowsToImportOrders([buyFixRow()])
	assert(orders.length === 1 && orders[0].items.length === 1, 'a case-only BUY IS exported to the printed shopping route')
	eq(orders[0].items[0].phone_model, 'iPhone 16', 'the printed route names the corrected model, never the ordered one')
	eq(orders[0].items[0].style, 'Case', 'the case is kept in the exported style — it still has to be bought')

	// The swap counterpart stays excluded: it is carried back, never re-bought.
	assert(rd.rowsToImportOrders([swapFixRow()]).length === 0, 'a case-only SWAP is still excluded from the printed route')
}

// ── 6b. AirPods BUY names the corrected generation and stays shoppable ───────
console.log('\nAirPods BUY (corrected generation, nothing in hand):')
{
	const airBuy = buyFixRow({
		title: 'Kawaii Bunny Green AirPods Case with Charm',
		phone_model: 'AirPods Pro',
		style: 'Case+Charm',
		has_charm: true,
		charm_integral: true,
		exchange_need_model: 'AirPods Pro 2',
		exchange_components: 'case,charm',
	})
	assert(rd.exchangeHeldComponents(airBuy).size === 0, 'an AirPods BUY holds nothing')
	eq(rd.effectiveShoppingModel(airBuy), 'AirPods Pro 2', 'it names the corrected AirPods generation')
	assert(rd.rowHasShoppingWork(airBuy) === true, 'it stays in the shopping dashboard')
	const view = rd.rowShoppingProjection(airBuy)
	eq([view.has_case, view.has_charm], [true, true], 'case + attached charm stay shoppable')
	eq(view.phone_model, 'AirPods Pro 2', 'the projected card advertises AirPods Pro 2')
}

// ── 7. Packing must not deadlock behind a buy-shaped fix ─────────────────────
console.log('\npack-queue exchange hold:')
{
	const sql = packQueue.openExchangeExistsSql('r')
	assert(/have_model/.test(sql), 'the packing hold is scoped by have_model (SWAPs only)')
	assert(/status = 'open'/.test(sql), 'the packing hold still only considers OPEN fixes')
	assert(/oe\.receipt_id = r\.receipt_id/.test(sql), 'the packing hold is correlated to the receipt under test')
	assert(packQueue.excludeOpenExchangeSql('r').startsWith('NOT '), 'the ready-to-pack scope excludes held orders')
}

console.log('')
if (failures > 0) {
	console.error(`${failures} assertion(s) FAILED`)
	process.exit(1)
}
console.log('All assertions passed.')
