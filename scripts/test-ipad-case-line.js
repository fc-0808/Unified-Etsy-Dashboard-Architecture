'use strict'

/**
 * Tests for the iPad case product line — the shop's first TIER-PRICED product.
 *
 * WHY THIS FILE EXISTS
 * ----------------------------------------------------------------------------
 * The watch band taught the pipeline that a line can be single-axis. The iPad
 * case adds the thing that makes a single axis dangerous: the buyer's ONE choice
 * is also the price carrier, and it is not priced flat. A 13" shell costs more
 * than an 11" one, so an option that lands in the wrong tier sells a large case
 * at the small price on every unit, silently, until someone reconciles a month
 * of orders. It also breaks an assumption the band never touched — that one fit
 * value names one device — because a single option here covers up to three real
 * iPads.
 *
 * So this file pins the facts that cost money or ship the wrong item:
 *
 *   · THE OPTION LIST IS THE STOREFRONT MENU. Nineteen values, spelled exactly
 *     as the buyer sees them, in the order the dropdown renders. These strings
 *     are also the keys the price map and every saved run are matched on, so a
 *     stray space orphans a price rather than failing loudly.
 *   · EVERY OPTION IS PRICED, IN THE RIGHT TIER. Asserted per option against the
 *     11"/13" split, not against a single figure — a flat assertion would pass
 *     while every 13" case sold at the 11" price.
 *   · THE MATRIX IS SINGLE-AXIS. Nineteen offerings on property 514 named "iPad
 *     Model", no property 513 anywhere, and no accessory bundle to cross it with.
 *   · THE COPY SELLS AN IPAD CASE. It may be called a case (unlike a band) but
 *     never a PHONE case; the 24 real iPads it fits are the compatibility list;
 *     no grip, charm or MagSafe is promised.
 *   · FULFILMENT READS AN IPAD ORDER. "iPad Model" is the line's fit, the case is
 *     the one unit to buy (a line with no components is invisible to the shopping
 *     route and would never be bought), the family guard refuses an iPhone model
 *     on an iPad line, and an inch size never leaks into another family.
 *
 * Everything here is pure: no network, no database, no workbook. The one DB-
 * shaped dependency (the shop's cached prices) is a two-line stub, because the
 * behaviour under test is the PRECEDENCE rule, not the SQL.
 *
 * Run: `node scripts/test-ipad-case-line.js`   (exit 0 = pass, 1 = regression)
 */

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const productTypes = require('../src/listings/product-types')
const variationBuilder = require('../src/listings/variation-builder')
const { getPricesForCurrency } = require('../src/listings/pricing')
const { resolveDefaultPrices, getShopCurrentStylePrices } = require('../src/listings/shop-prices')
const aiGenerator = require('../src/listings/ai-generator')
const routeDashboard = require('../src/route/dashboard')
const inventoryHelpers = require('../src/inventory/helpers')
const sourcingCatalog = require('../src/sourcing/catalog')

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m'
let passed = 0, failed = 0
const failures = []
const queue = []
const group = (name) => queue.push({ group: name })
const test = (name, fn) => queue.push({ name, fn })

const IPAD = 'ipad_case'

// The buyer-facing "iPad Model" dropdown, verbatim and in render order. Written
// out longhand rather than read from the registry: this list IS the spec, and a
// test that derives it from the code under test would pass on any typo.
const OPTIONS = [
	'2019/2020/2021 10.2"',
	'iPad 7/8/9 10.2"',
	'10th Gen 10.9" / 11th Gen 2025 11"',
	'Air 6 2024 11" / Air 7 2025 11"',
	'Air 4/5 10.9"',
	'Pro 2020/2021 11"',
	'Pro 2022 11"',
	'Air 6 2024 11"',
	'Air 7 2025 11"',
	'11" Air Category',
	'Pro 2025 11"',
	'Pro 2024 11"',
	'Pro 2024 13" / Air 6 2024 13"',
	'Pro 2020/2021 12.9"',
	'Pro 2022 12.9"',
	'Air 6 2024 13"',
	'13" Air Category',
	'Pro 2025 13"',
	'Pro 2024 13"',
]

// The options priced in the LARGE tier (12.9" / 13" shells). Everything else is
// standard. Split out so a mis-tiered option fails as itself, by name.
const LARGE_TIER = new Set([
	'Pro 2024 13" / Air 6 2024 13"',
	'Pro 2020/2021 12.9"',
	'Pro 2022 12.9"',
	'Air 6 2024 13"',
	'13" Air Category',
	'Pro 2025 13"',
	'Pro 2024 13"',
])

const PRICE = {
	HKD: { standard: 328.89, large: 349.50 },
	CAD: { standard: 58.12, large: 61.76 },
}
const expectedPrice = (currency, option) => PRICE[currency][LARGE_TIER.has(option) ? 'large' : 'standard']

// Etsy caps a custom variation value at 45 characters.
const ETSY_VALUE_MAX = 45

// ════════════════════════════════════════════════════════════════════════════
// Part 1 · The line as declared
// ════════════════════════════════════════════════════════════════════════════
group('The product line is declared once, in the registry')

test('the nineteen iPad models are spelled exactly as the dropdown shows them', () => {
	assert.deepStrictEqual(productTypes.styleKeysFor(IPAD), OPTIONS)
	assert.deepStrictEqual(productTypes.stylesFor(IPAD).map((s) => s.label), OPTIONS)
})

test('every option fits inside Etsy\'s variation-value limit', () => {
	// Etsy rejects the whole inventory PUT if one value is too long, so a future
	// option that reads well in a spreadsheet must still be publishable.
	for (const option of OPTIONS) {
		assert.ok(option.length <= ETSY_VALUE_MAX, `"${option}" is ${option.length} chars (max ${ETSY_VALUE_MAX})`)
	}
})

test('the line is single-axis: an iPad model, and no bundle to cross it with', () => {
	assert.strictEqual(productTypes.hasDeviceAxis(IPAD), false, 'no separate device-model axis')
	assert.deepStrictEqual(productTypes.getProductType(IPAD).models, [])
	assert.strictEqual(productTypes.stylePropertyFor(IPAD).id, productTypes.PROP_CHOICE)
	assert.strictEqual(productTypes.stylePropertyFor(IPAD).name, 'iPad Model')
	assert.strictEqual(productTypes.styleAxisOf(IPAD), 'size', 'the choice axis is a fit, not a bundle')
})

test('an iPad case sells no accessories, so nothing can offer one', () => {
	const pt = productTypes.getProductType(IPAD)
	assert.strictEqual(!!pt.supportsGrip, false)
	assert.strictEqual(pt.supportsCharm, false)
	assert.strictEqual(!!pt.supportsMagsafe, false)
	assert.ok(productTypes.includedItemsFor(IPAD).length, 'the fixed contents are declared instead')
})

test('every model is offered by default — no photo says which iPads exist', () => {
	const enabled = productTypes.defaultEnabledStyles(IPAD, { hasGrip: false, hasCharm: false })
	assert.deepStrictEqual(enabled, Object.fromEntries(OPTIONS.map((o) => [o, true])))
})

test('one option can stand for several real iPads, and all 24 are covered', () => {
	// A shopper searches for the iPad they own ("iPad Pro 12.9-inch (2021)"),
	// never for the grouping we buy it under, so each option carries the full
	// list of models it fits rather than one name.
	const covered = productTypes.allDescriptionNames(IPAD)
	assert.strictEqual(covered.length, 24, 'the whole supported catalogue is advertised')
	assert.strictEqual(new Set(covered).size, 24, 'and no model is claimed twice')
	for (const model of ['iPad Pro 12.9-inch (2020)', 'iPad Pro 12.9-inch 2018 (Without Home Button)', 'iPad Pro 12.9-inch (2021)']) {
		assert.ok(covered.includes(model), model)
	}
	assert.deepStrictEqual(
		productTypes.styleCompatibilityNames(IPAD, { 'Pro 2020/2021 12.9"': true }),
		['iPad Pro 12.9-inch (2020)', 'iPad Pro 12.9-inch 2018 (Without Home Button)', 'iPad Pro 12.9-inch (2021)'],
		'one option → the three iPads it actually fits',
	)
})

test('the UI contract names the axis, the models and what is unsupported', () => {
	const meta = productTypes.productMeta(IPAD)
	assert.strictEqual(meta.product_type, IPAD)
	assert.strictEqual(meta.has_device_axis, false)
	assert.deepStrictEqual(meta.models, [])
	assert.strictEqual(meta.style_property_name, 'iPad Model')
	assert.strictEqual(meta.style_axis, 'size')
	assert.deepStrictEqual(meta.style_keys, OPTIONS)
	assert.strictEqual(meta.supports_grip, false)
	assert.strictEqual(meta.supports_charm, false)
	assert.strictEqual(meta.supports_magsafe, false)
	assert.deepStrictEqual(meta.price_book_currencies.sort(), ['CAD', 'HKD'])
})

test('the line is offered to the operator in the Bulk Listings dropdown', () => {
	const listed = productTypes.listProductTypes().find((p) => p.id === IPAD)
	assert.ok(listed, 'the registry lists it')
	assert.strictEqual(listed.label, 'iPad Case')
	assert.strictEqual(listed.hasDeviceAxis, false)
	assert.strictEqual(listed.styleProperty, 'iPad Model')
	assert.deepStrictEqual(listed.styles.map((s) => s.key), OPTIONS)
})

// ════════════════════════════════════════════════════════════════════════════
// Part 2 · Prices
// ════════════════════════════════════════════════════════════════════════════
group('Prices come from the line\'s own two-tier book')

test('an HKD shop pays 328.89 for an 11" and 349.50 for a 13", per option', () => {
	// Asserted option by option. A single flat assertion would pass while every
	// 13" case quietly sold at the 11" price.
	const got = getPricesForCurrency('HKD', { productType: IPAD })
	assert.strictEqual(got.source, 'product_type', 'the workbook is never opened')
	assert.deepStrictEqual(got.missing, [], 'every option is priced')
	for (const option of OPTIONS) assert.strictEqual(got.prices[option], expectedPrice('HKD', option), option)
})

test('a CAD shop pays 58.12 for an 11" and 61.76 for a 13", per option', () => {
	const got = getPricesForCurrency('CAD', { productType: IPAD })
	assert.strictEqual(got.source, 'product_type')
	assert.deepStrictEqual(got.missing, [])
	for (const option of OPTIONS) assert.strictEqual(got.prices[option], expectedPrice('CAD', option), option)
})

test('the two tiers really are two — nothing collapsed into one price', () => {
	for (const currency of ['HKD', 'CAD']) {
		const prices = getPricesForCurrency(currency, { productType: IPAD }).prices
		const distinct = [...new Set(Object.values(prices))].sort((a, b) => a - b)
		assert.deepStrictEqual(distinct, [PRICE[currency].standard, PRICE[currency].large], currency)
		const large = OPTIONS.filter((o) => prices[o] === PRICE[currency].large)
		assert.deepStrictEqual(new Set(large), LARGE_TIER, `${currency}: exactly the 13" options carry the large price`)
	}
})

test('a currency the book does not cover asks the operator instead of guessing', () => {
	const got = getPricesForCurrency('USD', { productType: IPAD })
	assert.strictEqual(got.source, 'product_type')
	assert.deepStrictEqual(got.prices, {})
	assert.deepStrictEqual(got.missing, OPTIONS)
})

test('the book beats a price inferred from the shop\'s other listings', () => {
	// The shop's own median is the best source for a case BUNDLE and the worst
	// for a tiered line: one mispriced legacy listing would flatten both tiers.
	const shopRows = OPTIONS.map((option) => ({
		price_amount: 999.99,
		price_currency: 'HKD',
		listing_id: 1,
		property_values: JSON.stringify([{ property_id: productTypes.PROP_CHOICE, property_name: 'iPad Model', values: [option] }]),
	}))
	const db = { prepare: () => ({ all: () => shopRows }) }

	assert.strictEqual(getShopCurrentStylePrices(db, 'ShopA', IPAD).prices[OPTIONS[0]], 999.99, 'the cache IS read (so this is a real contest)')

	const resolved = resolveDefaultPrices({
		db,
		shopId: 'ShopA',
		sheetPrices: getPricesForCurrency('HKD', { productType: IPAD }).prices,
		productType: IPAD,
	})
	for (const option of OPTIONS) {
		assert.strictEqual(resolved.prices[option], expectedPrice('HKD', option), option)
		assert.strictEqual(resolved.source[option], 'sheet', `${option} is sourced from the book`)
	}
})

test('no other line\'s listings can price an iPad variation, or be priced by one', () => {
	const db = {
		prepare: () => ({
			all: () => [
				{ price_amount: 88, price_currency: 'HKD', listing_id: 1, property_values: JSON.stringify([{ property_id: productTypes.PROP_CHOICE, property_name: 'Styles', values: ['Case Only'] }]) },
				{ price_amount: 77, price_currency: 'HKD', listing_id: 2, property_values: JSON.stringify([{ property_id: productTypes.PROP_CHOICE, property_name: 'Band Size', values: ['38/40/41mm'] }]) },
			],
		}),
	}
	assert.deepStrictEqual(getShopCurrentStylePrices(db, 'ShopA', IPAD).prices, {}, 'a bundle or a band size is not an iPad model')
	assert.deepStrictEqual(getShopCurrentStylePrices(db, 'ShopA', 'apple_watch_band').prices, { '38/40/41mm': 77 }, 'and the band line still reads its own')
})

// ════════════════════════════════════════════════════════════════════════════
// Part 3 · The Etsy variation matrix
// ════════════════════════════════════════════════════════════════════════════
group('The variation matrix Etsy receives')

const ipadPrices = Object.fromEntries(OPTIONS.map((o) => [o, expectedPrice('HKD', o)]))

test('nineteen offerings, priced on "iPad Model", with no model axis at all', () => {
	const { body, minPrice, listingQuantity } = variationBuilder.buildInventory({
		productType: IPAD,
		prices: ipadPrices,
		restockQuantity: 3,
	})
	assert.strictEqual(body.products.length, OPTIONS.length, 'one product per option')
	assert.deepStrictEqual(body.price_on_property, [productTypes.PROP_CHOICE])
	assert.deepStrictEqual(body.quantity_on_property, [productTypes.PROP_CHOICE])
	assert.deepStrictEqual(body.products.map((p) => p.property_values[0].values[0]), OPTIONS, 'in registry order')
	for (const p of body.products) {
		const option = p.property_values[0].values[0]
		assert.strictEqual(p.property_values.length, 1, `${option}: exactly one variation dimension`)
		assert.strictEqual(p.property_values[0].property_id, productTypes.PROP_CHOICE)
		assert.strictEqual(p.property_values[0].property_name, 'iPad Model')
		assert.strictEqual(p.offerings[0].price, expectedPrice('HKD', option), `${option}: priced in its own tier`)
		assert.strictEqual(p.offerings[0].is_enabled, true)
		assert.strictEqual(p.offerings[0].quantity, 3)
	}
	assert.ok(!JSON.stringify(body).includes(String(productTypes.PROP_DEVICE)), 'property 513 appears nowhere')
	assert.strictEqual(minPrice, PRICE.HKD.standard, 'the listing advertises its cheapest option')
	assert.strictEqual(listingQuantity, OPTIONS.length * 3)
})

test('an option the operator turned off is offered to nobody', () => {
	const { body } = variationBuilder.buildInventory({
		productType: IPAD,
		prices: ipadPrices,
		enabledStyles: { ...Object.fromEntries(OPTIONS.map((o) => [o, true])), 'Pro 2022 11"': false },
	})
	const off = body.products.find((p) => p.property_values[0].values[0] === 'Pro 2022 11"')
	assert.ok(off, 'the value still exists in the dropdown structure')
	assert.strictEqual(off.offerings[0].is_enabled, false)
	assert.strictEqual(off.offerings[0].quantity, 0)
})

test('turning every option off falls back to an iPad model, never to "Case Only"', () => {
	const { body } = variationBuilder.buildInventory({
		productType: IPAD,
		prices: ipadPrices,
		enabledStyles: Object.fromEntries(OPTIONS.map((o) => [o, false])),
	})
	const enabled = body.products.filter((p) => p.offerings[0].is_enabled)
	assert.strictEqual(enabled.length, 1, 'exactly one value is re-enabled')
	assert.strictEqual(enabled[0].property_values[0].values[0], OPTIONS[0])
	assert.strictEqual(productTypes.fallbackStyleKey(IPAD), OPTIONS[0])
})

test('an unpriced line fails with a sentence, not with an Etsy API error', () => {
	assert.throws(
		() => variationBuilder.buildInventory({ productType: IPAD, prices: {} }),
		(err) => {
			assert.strictEqual(err.status, 400)
			assert.ok(/iPad Case/.test(err.message), 'names the line')
			assert.ok(/iPad Model/.test(err.message), 'names the axis')
			assert.ok(/Variation Prices/.test(err.message), 'names where to fix it')
			return true
		},
	)
})

test('an iPad model carries no variation photo — the design is the same on all', () => {
	const mapping = aiGenerator.deriveStyleMapping(
		[{ index: 1, has_case: true, thumbnail_quality: 9 }, { index: 2, has_case: true, thumbnail_quality: 8 }],
		IPAD,
	)
	assert.deepStrictEqual(mapping, {})
})

// ════════════════════════════════════════════════════════════════════════════
// Part 4 · The copy pipeline
// ════════════════════════════════════════════════════════════════════════════
group('The copy sells an iPad case, not a phone case')

const enabledAll = Object.fromEntries(OPTIONS.map((o) => [o, true]))
const ipadPrompt = aiGenerator.buildPhase2System('Y2KASE', ['y2kase'], true, enabledAll, {}, {}, { isGeneric: true, motifs: ['bunny'] }, IPAD, null, null)

test('the title states the fit as an iPad, and the noun as an iPad case', () => {
	assert.ok(ipadPrompt.includes('Cover for iPad'), 'the device phrase is the line\'s own')
	assert.ok(ipadPrompt.includes('iPad Case'), 'and the head noun is capitalised correctly, never "IPad"')
	assert.ok(!ipadPrompt.includes('IPad'))
})

test('it may be called a case — but never a PHONE case', () => {
	// The opposite of the band rule, and the reason the ban list is per-line
	// rather than derived from the axis shape: banning the word "case" here
	// would make the copy unable to name the product.
	assert.ok(ipadPrompt.includes('NEVER describe this product as a phone case, iPhone case or AirPods case'))
	assert.ok(ipadPrompt.includes('it is an iPad case'), 'and the article is right')
	assert.ok(!/NEVER describe this product as[^.]*\bcover\b/.test(ipadPrompt), 'an iPad case IS a cover')
})

test('the real iPads are a compatibility statement, never a bundle', () => {
	assert.ok(ipadPrompt.includes('iPad Pro 12.9-inch (2021)'), 'the covered models are advertised as fit')
	assert.ok(ipadPrompt.includes('NEVER present the models as separate included items'))
	for (const item of productTypes.includedItemsFor(IPAD)) assert.ok(ipadPrompt.includes(item), item)
	assert.ok(ipadPrompt.includes('the only choice the buyer makes is the "iPad Model"'))
})

test('the models the line does not fit are named as unavailable', () => {
	assert.ok(/NOT available: [^.]*iPad mini/.test(ipadPrompt), 'a mini owner is told before they buy')
})

test('no grip, no charm bundle and no MagSafe can be promised', () => {
	assert.ok(ipadPrompt.includes('Do NOT write a grip paragraph'))
	assert.ok(ipadPrompt.includes('Do NOT promise any separate add-on accessory'))
	assert.ok(/NEVER mention MagSafe/.test(ipadPrompt), 'MagSafe is refused even when the caller asks for it')
})

test('an option the operator turned off is never advertised as compatible', () => {
	const onlyPro11 = { 'Pro 2020/2021 11"': true }
	const prompt = aiGenerator.buildPhase2System('Y2KASE', ['y2kase'], false, onlyPro11, {}, {}, {}, IPAD, null, null)
	const [offered, unavailable] = prompt.split('these models are NOT available:')
	assert.ok(offered.includes('iPad Pro 11-inch (2020)'), 'the offered option\'s iPads are advertised')
	assert.ok(unavailable, 'and the rest are explicitly declared unavailable')
	assert.ok(unavailable.includes('iPad Pro 12.9-inch 2022'), 'including the models behind a disabled option')

	// And the post-process filter strips the bullet even if the model ignores it.
	const description = ['• iPad Pro 11-inch (2020)', '• iPad Pro 12.9-inch 2022', 'Ships in 3-5 business days.'].join('\n')
	const filtered = aiGenerator.filterModelsInDescription(description, {}, IPAD, onlyPro11)
	assert.ok(filtered.includes('iPad Pro 11-inch (2020)'), 'the offered model stays')
	assert.ok(!filtered.includes('12.9-inch 2022'), 'the unoffered model goes')
	assert.ok(filtered.includes('Ships in 3-5 business days.'), 'ordinary prose is untouched')
})

test('the older lines\' copy is unchanged', () => {
	const casePrompt = aiGenerator.buildPhase2System('Y2KASE', ['y2kase'], true, { 'Case Only': true, 'Case+Charm': true }, {}, {}, {}, 'iphone_case', null, null)
	assert.ok(casePrompt.includes('Cover for iPhone'))
	assert.ok(casePrompt.includes('Case Only'))
	assert.ok(!casePrompt.includes('NEVER describe this product as'), 'a phone case has no confusable noun to ban')

	const bandPrompt = aiGenerator.buildPhase2System('Y2KASE', ['y2kase'], true, { '38/40/41mm': true }, {}, {}, {}, 'apple_watch_band', null, null)
	assert.ok(bandPrompt.includes('Strap for Apple Watch'))
	assert.ok(bandPrompt.includes('NEVER describe this product as a phone case, AirPods case, cover or shell'))
	assert.ok(bandPrompt.includes('NEVER present the sizes as separate included items'), 'a band still has sizes, not models')
})

// ════════════════════════════════════════════════════════════════════════════
// Part 5 · Fulfilment
// ════════════════════════════════════════════════════════════════════════════
group('An iPad order flows through fulfilment')

const IPAD_TITLE = 'Bunny Cloud iPad Case, Magnetic Detachable Flip Cover for iPad Air'
const ipadVariations = [{ formatted_name: 'iPad Model', formatted_value: 'Pro 2022 11"' }]

test('"iPad Model" is read as the line\'s fit — what a shopper matches at the stall', () => {
	const parsed = routeDashboard.parseVariations(ipadVariations)
	assert.strictEqual(parsed.phoneModel, 'Pro 2022 11"')
	assert.strictEqual(parsed.style, '', 'an iPad case has no bundle')
	assert.strictEqual(productTypes.variationPropertyRole('iPad Model'), 'fit')
	assert.strictEqual(productTypes.variationPropertyRole('Band Size'), 'fit')
	assert.strictEqual(productTypes.variationPropertyRole('Styles'), 'choice')
})

test('the case is the one unit to buy, so the line reaches the shopping route', () => {
	// A line with no components is invisible to rowHasShoppingWork — it would
	// never be bought, and the parcel would wait forever for an item nobody was
	// ever told to get.
	const comps = routeDashboard.styleComponents('', { phoneModel: 'Pro 2022 11"', title: IPAD_TITLE })
	assert.deepStrictEqual(comps, { hasCase: true, hasGrip: false, hasCharm: false })
	assert.strictEqual(routeDashboard.rowHasShoppingWork({ has_case: true, has_grip: false, has_charm: false, status_case: 'Pending' }), true)
})

test('the single-unit fallback is asked of the registry, not of a list of families', () => {
	assert.strictEqual(productTypes.familyIsSingleUnit(productTypes.FAMILY_IPAD), true)
	assert.strictEqual(productTypes.familyIsSingleUnit(productTypes.FAMILY_WATCH), true)
	assert.strictEqual(productTypes.familyIsSingleUnit(productTypes.FAMILY_IPHONE), false)
	assert.strictEqual(productTypes.familyIsSingleUnit(productTypes.FAMILY_AIRPODS), false)
	assert.deepStrictEqual(
		routeDashboard.styleComponents('', { phoneModel: 'iPhone 16 Pro', title: 'Cherry Case' }),
		{ hasCase: false, hasGrip: false, hasCharm: false },
		'and a case line with no style is still left exactly as it was',
	)
})

test('the line is classified as an iPad, from the model or from the title', () => {
	for (const option of OPTIONS) {
		assert.strictEqual(productTypes.deviceFamilyOf(option, ''), productTypes.FAMILY_IPAD, option)
	}
	assert.strictEqual(productTypes.deviceFamilyOf('', IPAD_TITLE), productTypes.FAMILY_IPAD)
	assert.strictEqual(routeDashboard.isAirpodsProduct('Pro 2022 11"', IPAD_TITLE), false)
	assert.strictEqual(sourcingCatalog.deriveProductType(IPAD_TITLE), IPAD, 'filed as an iPad case, not a phone case')
})

test('an inch size never leaks into another family, and no other value into iPad', () => {
	// The inch mark is the discriminator, so the guarantee that matters is that
	// nothing else in the shop's vocabulary carries one.
	for (const model of productTypes.canonicalModelsForFamily(productTypes.FAMILY_IPHONE)) {
		assert.strictEqual(productTypes.deviceFamilyOf(model, ''), productTypes.FAMILY_IPHONE, model)
	}
	for (const model of productTypes.canonicalModelsForFamily(productTypes.FAMILY_AIRPODS)) {
		assert.strictEqual(productTypes.deviceFamilyOf(model, ''), productTypes.FAMILY_AIRPODS, model)
	}
	for (const size of productTypes.canonicalModelsForFamily(productTypes.FAMILY_WATCH)) {
		assert.strictEqual(productTypes.deviceFamilyOf(size, ''), productTypes.FAMILY_WATCH, size)
	}
	assert.strictEqual(productTypes.deviceFamilyOf('', 'Colorful Button Charm Apple Watch Band'), productTypes.FAMILY_WATCH)
	assert.strictEqual(productTypes.deviceFamilyOf('', 'Cherry Bow Clear Case'), productTypes.FAMILY_IPHONE)
})

test('a model fix on an iPad line offers iPad models, and refuses an iPhone', () => {
	assert.deepStrictEqual(productTypes.canonicalModelsForFamily(productTypes.FAMILY_IPAD), OPTIONS)
	const err = productTypes.crossFamilyModelError(productTypes.FAMILY_IPAD, 'iPhone 17 Pro Max')
	assert.ok(err && /an iPad case/.test(err), 'an iPhone model on an iPad line is refused')
	assert.strictEqual(productTypes.crossFamilyModelError(productTypes.FAMILY_IPAD, 'Pro 2024 13"'), null, 'another iPad model is fine')
	const back = productTypes.crossFamilyModelError(productTypes.FAMILY_IPHONE, 'Pro 2024 13"')
	assert.ok(back && /is an iPad value/.test(back), 'and an iPad model on an iPhone line is refused')
})

test('the fix covers the case itself — there is nothing else on the line', () => {
	const covered = routeDashboard.modelFixCoveredComponents({ has_case: true, has_charm: false, phone_model: 'Pro 2022 11"', title: IPAD_TITLE })
	assert.deepStrictEqual(covered, ['case'])
	assert.strictEqual(productTypes.primaryComponentLabel(productTypes.FAMILY_IPAD), 'Case', 'an iPad case really is a case')
	assert.strictEqual(productTypes.primaryComponentLabel(productTypes.FAMILY_WATCH), 'Band')
})

test('a restock groups by iPad model, the way it groups by style on a case', () => {
	assert.deepStrictEqual(
		inventoryHelpers.deriveVariationLabels([{ property_name: 'iPad Model', values: ['Pro 2022 11"'] }]),
		{ styleVal: 'Pro 2022 11"', secondaryVal: null },
	)
	assert.deepStrictEqual(
		inventoryHelpers.deriveVariationLabels([{ property_name: 'Band Size', values: ['38/40/41mm'] }]),
		{ styleVal: '38/40/41mm', secondaryVal: null },
		'the band line is unchanged',
	)
	assert.deepStrictEqual(
		inventoryHelpers.deriveVariationLabels([
			{ property_name: 'Phone Model', values: ['iPhone 16 Pro'] },
			{ property_name: 'Styles', values: ['Case+Charm'] },
		]),
		{ styleVal: 'Case+Charm', secondaryVal: 'iPhone 16 Pro' },
		'and so is a two-axis case',
	)
})

test('the sourcing taxonomy carries the line, priced on the primary unit', () => {
	const type = sourcingCatalog.productType(IPAD)
	assert.strictEqual(type.family, 'ipad')
	assert.strictEqual(type.component, 'case')
	assert.deepStrictEqual(sourcingCatalog.priceFieldsFor(IPAD), ['cost_case'])
	assert.strictEqual(sourcingCatalog.isValidProductType(IPAD), true)
})

// ════════════════════════════════════════════════════════════════════════════
// Part 6 · The clients mirror the server
// ════════════════════════════════════════════════════════════════════════════
group('The dashboard page and the API agree with the registry')

const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'index.js'), 'utf8')
const registrySrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'listings', 'product-types.js'), 'utf8')

test('the model-fix API serves the iPad models as the iPad family\'s values', () => {
	assert.ok(/ipad: canonicalModelsForFamily\(FAMILY_IPAD\)/.test(serverSrc), 'the endpoint is fed from the registry')
	assert.ok(!/\bipad:\s*\[/.test(serverSrc), 'and never from a hard-coded list')
})

test('the page classifies an iPad line the same way the server does', () => {
	// Asserted byte-for-byte against the registry's source, so a tweak on one
	// side fails here instead of silently splitting the client and the server's
	// idea of what an iPad line is.
	const literalOf = (src, name) => {
		const m = new RegExp(`${name} = (/.+?/i)\\s*;?\\s*$`, 'm').exec(src)
		assert.ok(m, `${name} is declared`)
		return m[1]
	}
	assert.strictEqual(literalOf(page, '_IPAD_MODEL_RE'), literalOf(registrySrc, 'IPAD_MODEL_RE'))
	assert.strictEqual(literalOf(page, '_IPAD_TITLE_RE'), literalOf(registrySrc, 'IPAD_TITLE_RE'))
	assert.strictEqual(literalOf(page, '_WATCH_MODEL_RE'), literalOf(registrySrc, 'WATCH_MODEL_RE'), 'and the watch line still matches too')
})

test('the page reads an iPad Model variation as the line\'s fit', () => {
	const m = /function _isModelVariation\(name\) \{\s*return (\/[^\n]+\/i)\.test/.exec(page)
	assert.ok(m, 'the page declares the fit test')
	const re = new RegExp(m[1].slice(1, -2), 'i')
	assert.ok(re.test('iPad Model'), 'it recognises iPad Model')
	assert.ok(re.test('Band Size'), 'without losing Band Size')
	assert.ok(!re.test('Styles'), 'and without swallowing the bundle axis')
})

test('the offline model picker carries the real iPad models', () => {
	const m = /ipad: \[([^\]]*)\]/.exec(page)
	assert.ok(m, 'the fallback catalogue has an iPad family')
	for (const option of OPTIONS) {
		assert.ok(m[1].includes(`'${option}'`), `${option} is offered offline`)
	}
})

test('the model-fix modal asks for an iPad model, not for a phone model', () => {
	assert.ok(/ipad: \{[\s\S]*?axisNoun: 'iPad model'/.test(page))
	assert.ok(/ipad: \{[\s\S]*?unit: 'Case'/.test(page))
})

test('the page refuses a cross-family model with the server\'s own sentence', () => {
	// Two copies of a rule become two rules. The page builds the message from
	// the same noun table and the same shape, so an operator sees one wording.
	assert.ok(page.includes('function _crossFamilyModelError'), 'the page has one guard, not a ternary per family')
	assert.ok(/ipad: \{ line: 'an iPad case', typed: 'iPad' \}/.test(page), 'and knows the iPad nouns')
	assert.ok(registrySrc.includes(`[FAMILY_IPAD]:    { line: 'an iPad case', typed: 'iPad' }`), 'matching the registry')
})

// ── Runner ──────────────────────────────────────────────────────────────────
console.log(`\n${BOLD}iPad case — a tier-priced, single-axis product line, end to end${RESET}\n`)
for (const item of queue) {
	if (item.group) {
		console.log(`${DIM}${item.group}${RESET}`)
		continue
	}
	try {
		item.fn()
		passed++
		console.log(`  ${GREEN}✓${RESET} ${item.name}`)
	} catch (err) {
		failed++
		failures.push({ name: item.name, err })
		console.log(`  ${RED}✗${RESET} ${item.name}`)
	}
}
if (failures.length) {
	console.log(`\n${RED}${BOLD}Failures${RESET}`)
	for (const f of failures) console.log(`\n  ${RED}${f.name}${RESET}\n  ${f.err.message.split('\n').join('\n  ')}`)
}
console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)
