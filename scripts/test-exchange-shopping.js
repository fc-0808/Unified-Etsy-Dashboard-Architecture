'use strict'

/**
 * Regression test — a wrong-model "Fix model" is CASE-ONLY, and the grip/charm on
 * the SAME line must stay in the shopping list to buy while the case is surfaced
 * as an in-person exchange.
 *
 * Reproduces the reported bug: a Case+Grip+Charm order flagged for a model fix
 * dropped its grip AND charm from shopping mode entirely (the whole line was held
 * out as "in hand"). The fix scopes the hold to the swapped component (always the
 * case) so the remaining pieces are still sourced.
 *
 * Guards the SINGLE SOURCE OF TRUTH helpers in src/route/dashboard.js that every
 * consumer (mobile /api/shop/route, Orders rollup, desktop route, Excel export)
 * shares, so shopping visibility and the "case-only" invariant can never drift.
 *
 * Run: `node scripts/test-exchange-shopping.js`
 * Exit code 0 = all assertions pass, 1 = a regression was detected.
 */

const rd = require('../src/route/dashboard')

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

// A Case+Grip+Charm line flagged for a model fix (always case-only).
function comboExchangeRow(overrides = {}) {
	return {
		receipt_id: 1001,
		item_key: 'kawaii case\x00999',
		title: 'Kawaii Case Grip Charm',
		quantity: 1,
		phone_model: 'iPhone 17 Pro Max',
		style: 'Case+Grip+Charm',
		has_case: true,
		has_grip: true,
		has_charm: true,
		status_case: 'Pending',
		status_grip: 'Pending',
		status_charm: 'Pending',
		charm_code: 'CH-1',
		charm_shop: 'CharmCo',
		supplier_shop: 'DingJi',
		supplier_stall: 'A203A',
		needs_exchange: true,
		exchange_id: 77,
		exchange_components: 'case',
		exchange_have_model: 'iPhone 15 Pro Max',
		exchange_need_model: 'iPhone 17 Pro Max',
		...overrides,
	}
}

console.log('Wrong-model exchange × shopping-mode regression test\n')

// ── 1. exchangeHeldComponents — the case is held; grip/charm are not ─────────
console.log('exchangeHeldComponents:')
{
	const held = rd.exchangeHeldComponents(comboExchangeRow())
	assert(held.has('case') && !held.has('grip') && !held.has('charm'), 'a case-only exchange holds ONLY the case')

	// Legacy row that stored multiple pieces is honoured verbatim.
	const legacy = rd.exchangeHeldComponents(comboExchangeRow({ exchange_components: 'case,grip' }))
	assert(legacy.has('case') && legacy.has('grip') && !legacy.has('charm'), 'legacy multi-piece exchange is honoured')

	// A flagged exchange with no explicit pieces defaults to the case.
	const blank = rd.exchangeHeldComponents(comboExchangeRow({ exchange_components: '' }))
	assert(blank.has('case') && blank.size === 1, 'a flagged exchange with no pieces defaults to case-only')

	// No exchange → nothing held.
	const none = rd.exchangeHeldComponents(comboExchangeRow({ needs_exchange: false }))
	assert(none.size === 0, 'a row with no open exchange holds nothing')
}

// ── 2. shoppableComponentFlags — grip/charm remain buyable, case does not ────
console.log('\nshoppableComponentFlags:')
{
	const f = rd.shoppableComponentFlags(comboExchangeRow())
	eq([f.has_case, f.has_grip, f.has_charm], [false, true, true], 'case is masked out; grip + charm stay shoppable')
}

// ── 3. rowShoppingProjection — the projected buy row ─────────────────────────
console.log('\nrowShoppingProjection:')
{
	const view = rd.rowShoppingProjection(comboExchangeRow())
	assert(view, 'a Case+Grip+Charm exchange line survives in the shopping list')
	eq([view.has_case, view.has_grip, view.has_charm], [false, true, true], 'projected row buys grip + charm, not the case')

	// Grip + charm bought → the line is fully purchased FOR SHOPPING (case aside).
	const done = rd.rowShoppingProjection(comboExchangeRow({ status_grip: 'Purchased', status_charm: 'Purchased' }))
	assert(done && done.fully_purchased === true, 'once grip + charm are bought the line reads fully purchased for shopping')

	// A PURE case-only line (no grip/charm) with a case exchange projects to null.
	const pure = rd.rowShoppingProjection(comboExchangeRow({ has_grip: false, has_charm: false, style: 'Case' }))
	assert(pure === null, 'a case-only swap with nothing else to buy drops out of the shopping list')

	// A non-exchange row is returned unchanged.
	const plain = comboExchangeRow({ needs_exchange: false })
	assert(rd.rowShoppingProjection(plain) === plain, 'a normal row is passed through untouched')
}

// ── 4. rowHasShoppingWork — drives "to shop" vs pure-exchange ────────────────
console.log('\nrowHasShoppingWork:')
{
	assert(rd.rowHasShoppingWork(comboExchangeRow()) === true, 'combo exchange line still has buy work (grip + charm)')
	assert(rd.rowHasShoppingWork(comboExchangeRow({ has_grip: false, has_charm: false })) === false, 'case-only exchange line has NO buy work')
	assert(
		rd.rowHasShoppingWork(comboExchangeRow({ status_grip: 'Purchased', status_charm: 'Purchased' })) === false,
		'combo exchange line with grip + charm bought has no remaining buy work',
	)
}

// ── 5. styleFromComponentFlags — the style handed to the Excel generator ─────
console.log('\nstyleFromComponentFlags:')
{
	eq(rd.styleFromComponentFlags({ has_case: false, has_grip: true, has_charm: true }), 'Grip+Charm', 'case stripped from the generator style')
	eq(rd.styleFromComponentFlags({ has_case: true, has_grip: true, has_charm: true }), 'Case+Grip+Charm', 'full style rebuilt from flags')
	eq(rd.styleFromComponentFlags({ has_case: false, has_grip: false, has_charm: false }), '', 'empty flags → empty style')
}

// ── 6. rowsToImportOrders — batch buy list excludes the swapped case ─────────
console.log('\nrowsToImportOrders (batch Excel export):')
{
	const orders = rd.rowsToImportOrders([comboExchangeRow()])
	assert(orders.length === 1 && orders[0].items.length === 1, 'the combo exchange line is exported (its grip/charm still need buying)')
	eq(orders[0].items[0].style, 'Grip+Charm', 'exported line drops the swapped case from its style')

	// A pure case-only swap must NOT appear in the batch buy list at all.
	const none = rd.rowsToImportOrders([comboExchangeRow({ has_grip: false, has_charm: false, style: 'Case' })])
	assert(none.length === 0, 'a pure case-only swap is excluded from the batch buy list')
}

// ── 7. AirPods Case+Charm — the attached charm travels with the case ─────────
console.log('\nAirPods Case+Charm SWAP (integral charm travels with the case):')
{
	const air = comboExchangeRow({
		title: 'Kawaii Bunny Green AirPods Case with Charm',
		phone_model: 'AirPods Pro',
		style: 'Case+Charm',
		has_grip: false,
		charm_integral: true,
		exchange_components: 'case,charm',
		exchange_have_model: 'AirPods Pro',
		exchange_need_model: 'AirPods Pro 2',
		charm_code: '',
		charm_shop: '',
	})
	const held = rd.exchangeHeldComponents(air)
	assert(held.has('case') && held.has('charm') && !held.has('grip'), 'AirPods SWAP holds case + attached charm')
	eq(rd.shoppableComponentFlags(air), { has_case: false, has_grip: false, has_charm: false }, 'nothing remains to buy — the whole unit is swapped')
	assert(rd.rowHasShoppingWork(air) === false, 'AirPods Case+Charm SWAP has no leftover shopping work')
	assert(rd.rowShoppingProjection(air) === null, 'it drops out of the buy list')
	assert(rd.rowsToImportOrders([air]).length === 0, 'it is excluded from the printed shopping route')

	// Legacy record that only stored "case" must still hold the attached charm,
	// otherwise the shopper is sent to buy a charm dangling from the wrong case.
	const legacy = rd.exchangeHeldComponents(comboExchangeRow({
		title: 'Kawaii Bunny Green AirPods Case with Charm',
		phone_model: 'AirPods Pro 2',
		style: 'Case+Charm',
		has_grip: false,
		charm_integral: true,
		exchange_components: 'case',
		exchange_have_model: 'AirPods Pro',
		exchange_need_model: 'AirPods Pro 2',
	}))
	assert(legacy.has('case') && legacy.has('charm'), 'legacy AirPods "case"-only SWAP self-heals to hold the attached charm')
}

console.log('')
if (failures > 0) {
	console.error(`${failures} assertion(s) FAILED`)
	process.exit(1)
}
console.log('All assertions passed.')
