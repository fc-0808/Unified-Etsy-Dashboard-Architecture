'use strict'

/**
 * Tests for the Apple Watch band product line — the shop's first SINGLE-AXIS
 * product.
 *
 * WHY THIS FILE EXISTS
 * ----------------------------------------------------------------------------
 * Every earlier product (iPhone case, AirPods case) shares one shape: a device
 * model axis crossed with an accessory-bundle axis, priced from the 4-currency
 * master workbook. A watch band breaks all three assumptions at once — it has
 * NO model axis, its priced axis is a FIT (the band size) rather than a bundle,
 * and its price is a fixed figure the workbook has never heard of. Anything that
 * silently assumed the old shape is a real defect with a physical cost, so each
 * assumption is pinned here:
 *
 *   · THE REGISTRY IS THE ONLY PLACE THE LINE IS DECLARED. The sizes, their
 *     spelling, the property name Etsy sees and the price book are asserted
 *     against the descriptor, so a second copy anywhere else shows up as drift.
 *   · THE PRICE BOOK WINS FOR THIS LINE. A case takes the shop's own current
 *     prices (the truest statement of what it charges) and only falls back to a
 *     sheet. A band's price is a curated decision, so a median inferred from
 *     whatever else the shop lists must never override it.
 *   · THE MATRIX IS SINGLE-AXIS. Three offerings on property 514 named "Band
 *     Size", no property 513 anywhere, and a listing with no priced value fails
 *     with a sentence an operator can act on instead of an Etsy API error.
 *   · THE COPY SPEAKS ABOUT A BAND. The sizes are a compatibility statement, not
 *     a bundle; no grip, charm or MagSafe paragraph; and the title says "Strap
 *     for", not "Cover for".
 *   · FULFILMENT READS A BAND ORDER. "Band Size" is the line's fit, the band is
 *     the one physical unit to buy (a line with no components is invisible to
 *     the shopping route — the item would never be bought), the family guard
 *     refuses an iPhone model on a watch line, and the sourcing catalog files it
 *     as a band rather than as the charm its title also mentions.
 *
 * Everything here is pure: no network, no database, no workbook. The one DB-
 * shaped dependency (the shop's cached prices) is a two-line stub, because the
 * behaviour under test is the PRECEDENCE rule, not the SQL.
 *
 * Run: `node scripts/test-watch-band-line.js`   (exit 0 = pass, 1 = regression)
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

const WATCH = 'apple_watch_band'
const SIZES = ['38/40/41mm', '42mm [Series 10/11]', '42/44/45/46/49mm']
const HKD_PRICE = 350.11
const CAD_PRICE = 63.15

// ════════════════════════════════════════════════════════════════════════════
// Part 1 · The line as declared
// ════════════════════════════════════════════════════════════════════════════
group('The product line is declared once, in the registry')

test('the three band sizes are spelled exactly as the storefront shows them', () => {
	// These strings are the buyer-facing Etsy variation values AND the keys the
	// price map, the saved run and the order variations are matched on. A stray
	// space would silently orphan every saved price.
	assert.deepStrictEqual(productTypes.styleKeysFor(WATCH), SIZES)
	assert.deepStrictEqual(productTypes.stylesFor(WATCH).map((s) => s.label), SIZES)
})

test('the line is single-axis: a band size, and nothing else', () => {
	assert.strictEqual(productTypes.hasDeviceAxis(WATCH), false, 'no device-model axis')
	assert.deepStrictEqual(productTypes.getProductType(WATCH).models, [], 'and therefore no models')
	assert.strictEqual(productTypes.stylePropertyFor(WATCH).id, productTypes.PROP_CHOICE)
	assert.strictEqual(productTypes.stylePropertyFor(WATCH).name, 'Band Size')
	assert.strictEqual(productTypes.styleAxisOf(WATCH), 'size', 'the choice axis is a fit, not a bundle')
})

test('a band sells no accessories, so nothing can offer one', () => {
	const pt = productTypes.getProductType(WATCH)
	assert.strictEqual(!!pt.supportsGrip, false)
	assert.strictEqual(pt.supportsCharm, false)
	assert.strictEqual(!!pt.supportsMagsafe, false)
	assert.ok(productTypes.includedItemsFor(WATCH).length, 'the fixed contents are declared instead')
})

test('every size is offered by default — a photo cannot confirm a size', () => {
	// A case only offers a grip bundle when a grip was photographed. Nothing in
	// an image says which watch a band fits, so all three are always on.
	const enabled = productTypes.defaultEnabledStyles(WATCH, { hasGrip: false, hasCharm: false })
	assert.deepStrictEqual(enabled, { [SIZES[0]]: true, [SIZES[1]]: true, [SIZES[2]]: true })
})

test('the UI contract names the axis, the sizes and what is unsupported', () => {
	// One payload describes the line to the setup card, the inspector and the
	// saved-run reopen path, so those three can never disagree.
	const meta = productTypes.productMeta(WATCH)
	assert.strictEqual(meta.product_type, WATCH)
	assert.strictEqual(meta.has_device_axis, false)
	assert.deepStrictEqual(meta.models, [])
	assert.strictEqual(meta.style_property_name, 'Band Size')
	assert.strictEqual(meta.style_axis, 'size')
	assert.deepStrictEqual(meta.style_keys, SIZES)
	assert.deepStrictEqual(meta.styles.map((s) => s.key), SIZES)
	assert.strictEqual(meta.supports_grip, false)
	assert.strictEqual(meta.supports_charm, false)
	assert.strictEqual(meta.supports_magsafe, false)
	assert.deepStrictEqual(meta.price_book_currencies.sort(), ['CAD', 'HKD'])
})

test('the line is offered to the operator in the Bulk Listings dropdown', () => {
	const listed = productTypes.listProductTypes().find((p) => p.id === WATCH)
	assert.ok(listed, 'the registry lists it')
	assert.strictEqual(listed.hasDeviceAxis, false)
	assert.strictEqual(listed.styleProperty, 'Band Size')
	assert.deepStrictEqual(listed.styles.map((s) => s.key), SIZES)
})

// ════════════════════════════════════════════════════════════════════════════
// Part 2 · Prices
// ════════════════════════════════════════════════════════════════════════════
group('Prices come from the line\'s own book')

test('an HKD shop is priced at 350.11 and a CAD shop at 63.15, on every size', () => {
	for (const [currency, expected] of [['HKD', HKD_PRICE], ['CAD', CAD_PRICE]]) {
		const got = getPricesForCurrency(currency, { productType: WATCH })
		assert.strictEqual(got.source, 'product_type', `${currency} never opens the workbook`)
		assert.deepStrictEqual(got.missing, [], `${currency} prices every size`)
		for (const size of SIZES) assert.strictEqual(got.prices[size], expected, `${currency} · ${size}`)
	}
})

test('a currency the book does not cover asks the operator instead of guessing', () => {
	// Silently inventing a USD price would publish real listings at a made-up
	// figure. Every size is reported missing so the Variation Prices card asks.
	const got = getPricesForCurrency('USD', { productType: WATCH })
	assert.strictEqual(got.source, 'product_type')
	assert.deepStrictEqual(got.prices, {})
	assert.deepStrictEqual(got.missing, SIZES)
})

test('the cases still price from the master workbook, not from a book', () => {
	assert.strictEqual(productTypes.hasOwnPriceBook('iphone_case'), false)
	assert.strictEqual(productTypes.hasOwnPriceBook('airpods_case'), false)
	assert.strictEqual(productTypes.hasOwnPriceBook(WATCH), true)
})

test('the book beats a price inferred from the shop\'s other listings', () => {
	// The shop's own median is the best source for a CASE, and the worst for a
	// brand-new line: it would drift with whatever happens to be listed. A stub
	// stands in for the cache because the rule under test is the precedence.
	const shopRows = SIZES.map((size) => ({
		price_amount: 999.99,
		price_currency: 'HKD',
		listing_id: 1,
		property_values: JSON.stringify([{ property_id: productTypes.PROP_CHOICE, property_name: 'Band Size', values: [size] }]),
	}))
	const db = { prepare: () => ({ all: () => shopRows }) }

	const shopSeen = getShopCurrentStylePrices(db, 'ShopA', WATCH)
	assert.strictEqual(shopSeen.prices[SIZES[0]], 999.99, 'the cache IS read (so this is a real contest)')

	const resolved = resolveDefaultPrices({
		db,
		shopId: 'ShopA',
		sheetPrices: getPricesForCurrency('HKD', { productType: WATCH }).prices,
		productType: WATCH,
	})
	for (const size of SIZES) {
		assert.strictEqual(resolved.prices[size], HKD_PRICE, size)
		assert.strictEqual(resolved.source[size], 'sheet', `${size} is sourced from the book`)
	}
})

test('a case still takes the shop\'s own price over the sheet', () => {
	// The same function, the other way round — this is the behaviour the cases
	// have always had and the watch line must not have changed.
	const db = {
		prepare: () => ({
			all: () => [{
				price_amount: 88,
				price_currency: 'HKD',
				listing_id: 1,
				property_values: JSON.stringify([{ property_id: productTypes.PROP_CHOICE, property_name: 'Styles', values: ['Case Only'] }]),
			}],
		}),
	}
	const resolved = resolveDefaultPrices({ db, shopId: 'ShopA', sheetPrices: { 'Case Only': 120 }, productType: 'iphone_case' })
	assert.strictEqual(resolved.prices['Case Only'], 88)
	assert.strictEqual(resolved.source['Case Only'], 'shop')
})

test('one line\'s listings can never price the other line\'s variations', () => {
	// A shop selling both lines has "Case Only" and "38/40/41mm" offerings in the
	// same cache. Resolution is scoped to the type's own vocabulary.
	const db = {
		prepare: () => ({
			all: () => [{
				price_amount: 88,
				price_currency: 'HKD',
				listing_id: 1,
				property_values: JSON.stringify([{ property_id: productTypes.PROP_CHOICE, property_name: 'Styles', values: ['Case Only'] }]),
			}],
		}),
	}
	assert.deepStrictEqual(getShopCurrentStylePrices(db, 'ShopA', WATCH).prices, {}, 'a case bundle is not a band size')
})

// ════════════════════════════════════════════════════════════════════════════
// Part 3 · The Etsy variation matrix
// ════════════════════════════════════════════════════════════════════════════
group('The variation matrix Etsy receives')

const bandPrices = Object.fromEntries(SIZES.map((s) => [s, HKD_PRICE]))

test('three offerings, priced on "Band Size", with no model axis at all', () => {
	const { body, minPrice, listingQuantity } = variationBuilder.buildInventory({
		productType: WATCH,
		prices: bandPrices,
		restockQuantity: 3,
	})
	assert.strictEqual(body.products.length, 3, 'one product per size')
	assert.deepStrictEqual(body.price_on_property, [productTypes.PROP_CHOICE])
	assert.deepStrictEqual(body.quantity_on_property, [productTypes.PROP_CHOICE])
	assert.deepStrictEqual(body.products.map((p) => p.property_values[0].values[0]), SIZES, 'in registry order')
	for (const p of body.products) {
		assert.strictEqual(p.property_values.length, 1, 'exactly one variation dimension')
		assert.strictEqual(p.property_values[0].property_id, productTypes.PROP_CHOICE)
		assert.strictEqual(p.property_values[0].property_name, 'Band Size')
		assert.strictEqual(p.offerings[0].price, HKD_PRICE)
		assert.strictEqual(p.offerings[0].is_enabled, true)
		assert.strictEqual(p.offerings[0].quantity, 3)
	}
	assert.ok(!JSON.stringify(body).includes(String(productTypes.PROP_DEVICE)), 'property 513 appears nowhere')
	assert.strictEqual(minPrice, HKD_PRICE)
	assert.strictEqual(listingQuantity, 9)
})

test('a size the operator turned off is offered to nobody', () => {
	const { body } = variationBuilder.buildInventory({
		productType: WATCH,
		prices: bandPrices,
		enabledStyles: { [SIZES[0]]: true, [SIZES[1]]: false, [SIZES[2]]: true },
	})
	const disabled = body.products.find((p) => p.property_values[0].values[0] === SIZES[1])
	assert.ok(disabled, 'the value still exists in the dropdown structure')
	assert.strictEqual(disabled.offerings[0].is_enabled, false)
	assert.strictEqual(disabled.offerings[0].quantity, 0)
})

test('turning every size off falls back to a band size, never to "Case Only"', () => {
	// The old fallback was hard-coded to "Case Only" — a value this line does not
	// have, which would have produced a listing with zero offerings.
	const { body } = variationBuilder.buildInventory({
		productType: WATCH,
		prices: bandPrices,
		enabledStyles: Object.fromEntries(SIZES.map((s) => [s, false])),
	})
	const enabled = body.products.filter((p) => p.offerings[0].is_enabled)
	assert.strictEqual(enabled.length, 1, 'exactly one value is re-enabled')
	assert.strictEqual(enabled[0].property_values[0].values[0], SIZES[0])
	assert.strictEqual(productTypes.fallbackStyleKey(WATCH), SIZES[0])
	assert.strictEqual(productTypes.fallbackStyleKey('iphone_case'), 'Case Only', 'the cases keep their own fallback')
})

test('an unpriced line fails with a sentence, not with an Etsy API error', () => {
	// The only way to get here is a shop whose currency the price book does not
	// cover. Naming the card to fix is the difference between a 30-second fix and
	// a support thread.
	assert.throws(
		() => variationBuilder.buildInventory({ productType: WATCH, prices: {} }),
		(err) => {
			assert.strictEqual(err.status, 400)
			assert.ok(/Apple Watch Band/.test(err.message), 'names the line')
			assert.ok(/Band Size/.test(err.message), 'names the axis')
			assert.ok(/Variation Prices/.test(err.message), 'names where to fix it')
			return true
		},
	)
})

test('a band size carries no variation photo — nothing in a photo shows a size', () => {
	const mapping = aiGenerator.deriveStyleMapping(
		[{ index: 1, has_grip: false, has_charm: true, thumbnail_quality: 9 }, { index: 2, has_grip: false, has_charm: true, thumbnail_quality: 8 }],
		WATCH,
	)
	assert.deepStrictEqual(mapping, {})
})

// ════════════════════════════════════════════════════════════════════════════
// Part 4 · The copy pipeline
// ════════════════════════════════════════════════════════════════════════════
group('The copy speaks about a band, not about a case')

const enabledAllSizes = Object.fromEntries(SIZES.map((s) => [s, true]))
const watchPrompt = aiGenerator.buildPhase2System('Y2KASE', ['y2kase'], true, enabledAllSizes, {}, {}, { isGeneric: true, motifs: ['cherry'] }, WATCH, null, null)

test('the title states the fit as a strap, not as a cover', () => {
	assert.ok(watchPrompt.includes('Strap for Apple Watch'), 'the title template uses the line\'s own fit phrase')
	assert.ok(!watchPrompt.includes('Cover for Apple Watch'))
})

test('the sizes are a compatibility statement, never a bundle', () => {
	// Listing "38/40/41mm" under "What's Included" would read as three items in
	// the box. The sizes belong in the compatibility section; the contents are
	// the fixed list the descriptor declares.
	assert.ok(watchPrompt.includes('Apple Watch 38mm, 40mm & 41mm'), 'the sizes are advertised as fit')
	assert.ok(watchPrompt.includes('NEVER present the sizes as separate included items'))
	for (const item of productTypes.includedItemsFor(WATCH)) assert.ok(watchPrompt.includes(item), item)
})

test('no grip, no charm bundle and no MagSafe can be promised', () => {
	assert.ok(watchPrompt.includes('Do NOT write a grip paragraph'))
	assert.ok(watchPrompt.includes('Do NOT promise any separate add-on accessory'))
	assert.ok(/NEVER mention MagSafe/.test(watchPrompt), 'MagSafe is refused even when the caller asks for it')
	assert.ok(watchPrompt.includes('NEVER describe this product as a phone case'))
})

test('a size the operator turned off is never advertised as compatible', () => {
	const oneSize = { [SIZES[0]]: true, [SIZES[1]]: false, [SIZES[2]]: false }
	const prompt = aiGenerator.buildPhase2System('Y2KASE', ['y2kase'], false, oneSize, {}, {}, {}, WATCH, null, null)
	assert.ok(prompt.includes('Apple Watch 38mm, 40mm & 41mm'))
	assert.ok(!prompt.includes('list EXACTLY these compatible models as bullets and NO others: Apple Watch 38mm, 40mm & 41mm, Apple Watch 42mm (Series 10 & 11)'))

	// And the post-process filter strips the bullet even if the model ignores it.
	const description = ['• Apple Watch 38mm, 40mm & 41mm', '• Apple Watch 42mm (Series 10 & 11)', 'Ships in 3-5 business days.'].join('\n')
	const filtered = aiGenerator.filterModelsInDescription(description, {}, WATCH, oneSize)
	assert.ok(filtered.includes('Apple Watch 38mm, 40mm & 41mm'), 'the offered size stays')
	assert.ok(!filtered.includes('Series 10 & 11'), 'the unoffered size goes')
	assert.ok(filtered.includes('Ships in 3-5 business days.'), 'ordinary prose is untouched')
})

test('the case copy is unchanged — bundles are still bundles', () => {
	const casePrompt = aiGenerator.buildPhase2System('Y2KASE', ['y2kase'], true, { 'Case Only': true, 'Case+Charm': true }, {}, {}, {}, 'iphone_case', null, null)
	assert.ok(casePrompt.includes('Cover for iPhone'))
	assert.ok(casePrompt.includes('Case Only'))
	assert.ok(!casePrompt.includes('NEVER present the sizes as separate included items'))
})

// ════════════════════════════════════════════════════════════════════════════
// Part 5 · Fulfilment
// ════════════════════════════════════════════════════════════════════════════
group('A band order flows through fulfilment')

const BAND_TITLE = 'Colorful Button Charm Apple Watch Band, Cute Strap for Apple Watch'
const bandVariations = [{ formatted_name: 'Band Size', formatted_value: '42mm [Series 10/11]' }]

test('"Band Size" is read as the line\'s fit — what a shopper matches at the stall', () => {
	const parsed = routeDashboard.parseVariations(bandVariations)
	assert.strictEqual(parsed.phoneModel, '42mm [Series 10/11]')
	assert.strictEqual(parsed.style, '', 'a band has no bundle')
	assert.strictEqual(productTypes.variationPropertyRole('Band Size'), 'fit')
	assert.strictEqual(productTypes.variationPropertyRole('Styles'), 'choice')
	assert.strictEqual(productTypes.variationPropertyRole('Phone Model'), 'fit')
	assert.strictEqual(productTypes.variationPropertyRole('Gift wrap'), null)
})

test('a case order still parses exactly as it always did', () => {
	const parsed = routeDashboard.parseVariations([
		{ formatted_name: 'Phone Model', formatted_value: 'iPhone 16 Pro' },
		{ formatted_name: 'Styles', formatted_value: 'Case+Charm' },
	])
	assert.deepStrictEqual(parsed, { phoneModel: 'iPhone 16 Pro', style: 'Case+Charm' })
})

test('the band is the one unit to buy, so the line reaches the shopping route', () => {
	// A line with no components is invisible to rowHasShoppingWork — it would
	// never be bought, and the parcel would wait forever for an item nobody was
	// ever told to get.
	const comps = routeDashboard.styleComponents('', { phoneModel: '42mm [Series 10/11]', title: BAND_TITLE })
	assert.deepStrictEqual(comps, { hasCase: true, hasGrip: false, hasCharm: false })
	const row = { has_case: true, has_grip: false, has_charm: false, status_case: 'Pending' }
	assert.strictEqual(routeDashboard.rowHasShoppingWork(row), true)
	assert.strictEqual(routeDashboard.rowFullyPurchased({ ...row, status_case: 'Purchased' }), true)
})

test('a band is never mistaken for a charm just because its title says "Charm"', () => {
	assert.strictEqual(routeDashboard.styleComponents('', { title: BAND_TITLE }).hasCharm, false)
	assert.strictEqual(routeDashboard.isAirpodsProduct('42mm [Series 10/11]', BAND_TITLE), false)
	assert.strictEqual(sourcingCatalog.deriveProductType(BAND_TITLE), WATCH)
})

test('a style string still wins wherever there is one', () => {
	// The family fallback only ever fires when the style says nothing at all.
	assert.deepStrictEqual(
		routeDashboard.styleComponents('Case+Grip+Charm', { phoneModel: 'iPhone 16 Pro', title: 'Cherry Case' }),
		{ hasCase: true, hasGrip: true, hasCharm: true },
	)
	assert.deepStrictEqual(
		routeDashboard.styleComponents('', { phoneModel: 'iPhone 16 Pro', title: 'Cherry Case' }),
		{ hasCase: false, hasGrip: false, hasCharm: false },
		'and a case line with no style is left exactly as it was',
	)
})

test('the line is classified as a watch, from the size or from the title', () => {
	assert.strictEqual(productTypes.deviceFamilyOf('42mm [Series 10/11]', BAND_TITLE), productTypes.FAMILY_WATCH)
	assert.strictEqual(productTypes.deviceFamilyOf('', BAND_TITLE), productTypes.FAMILY_WATCH)
	assert.strictEqual(productTypes.deviceFamilyOf('38/40/41mm', ''), productTypes.FAMILY_WATCH)
	assert.strictEqual(productTypes.deviceFamilyOf('iPhone 16 Pro', 'Cherry Case'), productTypes.FAMILY_IPHONE)
	assert.strictEqual(productTypes.deviceFamilyOf('AirPods Pro 2', ''), productTypes.FAMILY_AIRPODS)
})

test('a model fix on a band offers band sizes, and refuses an iPhone', () => {
	assert.deepStrictEqual(productTypes.canonicalModelsForFamily(productTypes.FAMILY_WATCH), SIZES)
	const err = productTypes.crossFamilyModelError(productTypes.FAMILY_WATCH, 'iPhone 17 Pro Max')
	assert.ok(err && /Apple Watch band/.test(err), 'an iPhone model on a band line is refused')
	assert.strictEqual(productTypes.crossFamilyModelError(productTypes.FAMILY_WATCH, '42/44/45/46/49mm'), null, 'another size is fine')
	assert.ok(productTypes.crossFamilyModelError(productTypes.FAMILY_IPHONE, '42mm'), 'and a size on an iPhone line is refused')
})

test('the fix covers the band itself — there is nothing else on the line', () => {
	const covered = routeDashboard.modelFixCoveredComponents({ has_case: true, has_charm: false, phone_model: '42mm [Series 10/11]', title: BAND_TITLE })
	assert.deepStrictEqual(covered, ['case'])
	assert.strictEqual(productTypes.primaryComponentLabel(productTypes.FAMILY_WATCH), 'Band', 'but it is CALLED a band')
	assert.strictEqual(productTypes.primaryComponentLabel(productTypes.FAMILY_IPHONE), 'Case')
})

test('a restock groups by band size, the way it groups by style on a case', () => {
	// The priced dimension is what a restock is about. On a band that is the size.
	const labels = inventoryHelpers.deriveVariationLabels([
		{ property_name: 'Band Size', values: ['38/40/41mm'] },
	])
	assert.deepStrictEqual(labels, { styleVal: '38/40/41mm', secondaryVal: null })
	assert.deepStrictEqual(
		inventoryHelpers.deriveVariationLabels([
			{ property_name: 'Phone Model', values: ['iPhone 16 Pro'] },
			{ property_name: 'Styles', values: ['Case+Charm'] },
		]),
		{ styleVal: 'Case+Charm', secondaryVal: 'iPhone 16 Pro' },
	)
})

// ════════════════════════════════════════════════════════════════════════════
// Part 6 · The clients mirror the server
// ════════════════════════════════════════════════════════════════════════════
group('The dashboard page and the API agree with the registry')

const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'index.js'), 'utf8')

test('the model-fix API serves the band sizes as the watch family\'s values', () => {
	assert.ok(/watch: canonicalModelsForFamily\(FAMILY_WATCH\)/.test(serverSrc), 'the endpoint is fed from the registry')
	assert.ok(!/watch:\s*\[/.test(serverSrc), 'and never from a hard-coded list')
})

test('the page reads a Band Size variation as the line\'s fit', () => {
	const m = /function _isModelVariation\(name\) \{\s*return (\/[^\n]+\/i)\.test/.exec(page)
	assert.ok(m, 'the page declares the fit test')
	const re = new RegExp(m[1].slice(1, -2), 'i')
	assert.ok(re.test('Band Size'), 'and it recognises Band Size')
	assert.ok(re.test('Phone Model'), 'without losing Phone Model')
	assert.ok(!re.test('Styles'), 'and without swallowing the bundle axis')
})

test('the page classifies a watch line the same way the server does', () => {
	// The two patterns are asserted byte-for-byte against the registry's source,
	// so a tweak on one side fails here instead of silently splitting the client
	// and the server's idea of what a watch line is.
	const registrySrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'listings', 'product-types.js'), 'utf8')
	const literalOf = (src, name) => {
		const m = new RegExp(`${name} = (/.+?/i)\\s*;?\\s*$`, 'm').exec(src)
		assert.ok(m, `${name} is declared in ${src === page ? 'the page' : 'the registry'}`)
		return m[1]
	}
	assert.strictEqual(literalOf(page, '_WATCH_MODEL_RE'), literalOf(registrySrc, 'WATCH_MODEL_RE'))
	assert.strictEqual(literalOf(page, '_WATCH_TITLE_RE'), literalOf(registrySrc, 'WATCH_TITLE_RE'))
})

test('the page calls the primary unit a band on a watch line', () => {
	assert.ok(page.includes('function _primaryCompLabel'), 'one helper decides the label')
	assert.ok(/family === 'watch' \? 'Band' : 'Case'/.test(page))
	assert.ok(page.includes("comp === 'case' ? _primaryCompLabel(row)"), 'the route chip uses it')
})

test('the model-fix modal asks for a band size, not for a phone model', () => {
	assert.ok(page.includes('EXCHANGE_FAMILY_COPY'), 'the wording is a table, not a ternary chain')
	assert.ok(/watch: \{[\s\S]*?axisNoun: 'band size'/.test(page))
	assert.ok(/watch: \{[\s\S]*?unit: 'Band'/.test(page))
	assert.ok(page.includes("42mm [Series 10/11]"), 'the offline fallback carries the real sizes')
})

// ── Runner ──────────────────────────────────────────────────────────────────
console.log(`\n${BOLD}Apple Watch band — a single-axis product line, end to end${RESET}\n`)
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
