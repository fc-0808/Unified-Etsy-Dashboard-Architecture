'use strict'

/**
 * Tests for the Apple Watch band product line — fixed buyer-required sizes plus
 * per-listing, vision-grouped and photo-linked Band 1 / Band 2 options.
 *
 * WHY THIS FILE EXISTS
 * ----------------------------------------------------------------------------
 * An Apple Watch band uses the same two-dimensional inventory shape as an
 * iPhone case, but with different semantics: all three Band Size values are a
 * locked fit catalogue, while Band Style values are grouped from this listing's
 * photos and carry price + variation images. Anything that silently swaps those
 * roles can sell an unavailable band or let a buyer omit a size,
 * so each invariant is pinned here:
 *
 *   · BAND SIZE IS FIXED. The three values are emitted on property 513 for every
 *     style even when a stale or hostile payload tries to turn them off.
 *   · BAND STYLE IS VISUAL. A focused classifier groups duplicate photo angles,
 *     supports multicolour designs and materialises only confident options.
 *   · THE PRICE BOOK WINS FOR THIS LINE. A case takes the shop's own current
 *     prices (the truest statement of what it charges) and only falls back to a
 *     sheet. A band's price is a curated decision, so a median inferred from
 *     whatever else the shop lists must never override it.
 *   · THE MATRIX IS TWO-AXIS. Fixed Band Size (513) × numbered Band Style (514),
 *     with price and photos attached only to Style.
 *   · THE COPY SPEAKS ABOUT A BAND. The sizes are a compatibility statement, not
 *     a bundle; no grip, charm or MagSafe paragraph; and the title uses the
 *     exact high-intent phrase "Apple Watch Band" without noun stacking.
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
const bandVariantAnalyzer = require('../src/listings/band-variant-analyzer')
const { getPricesForCurrency } = require('../src/listings/pricing')
const { resolveDefaultPrices, getShopCurrentStylePrices } = require('../src/listings/shop-prices')
const { BulkJobManager } = require('../src/listings/bulk-runner')
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
const STYLE_FALLBACK = 'As Shown'
const BANDS = ['Band 1', 'Band 2', 'Band 3', 'Band 4']
const HKD_PRICE = 350.11
const CAD_PRICE = 63.15

// ════════════════════════════════════════════════════════════════════════════
// Part 1 · The line as declared
// ════════════════════════════════════════════════════════════════════════════
group('The product line is declared once, in the registry')

test('the three mandatory band sizes are spelled exactly as the storefront shows them', () => {
	// These values are the buyer-facing Etsy Band Size dropdown. A stray space
	// would split fulfilment identity and compatibility copy.
	assert.deepStrictEqual(productTypes.getProductType(WATCH).models, SIZES)
	assert.deepStrictEqual(productTypes.canonicalModelsForFamily(productTypes.FAMILY_WATCH), SIZES)
})

test('the line has a fixed Band Size axis and a priced Band Style axis', () => {
	const pt = productTypes.getProductType(WATCH)
	assert.strictEqual(productTypes.hasDeviceAxis(WATCH), true)
	assert.strictEqual(productTypes.isDeviceAxisFixed(WATCH), true)
	assert.deepStrictEqual(pt.deviceProperty, { id: productTypes.PROP_DEVICE, name: 'Band Size' })
	assert.deepStrictEqual(productTypes.stylePropertyFor(WATCH), { id: productTypes.PROP_CHOICE, name: 'Band Style' })
	assert.strictEqual(productTypes.styleAxisOf(WATCH), 'variant')
	assert.strictEqual(pt.visionStyle, 'band_variant')
})

test('a band sells no accessories, so nothing can offer one', () => {
	const pt = productTypes.getProductType(WATCH)
	assert.strictEqual(!!pt.supportsGrip, false)
	assert.strictEqual(pt.supportsCharm, false)
	assert.strictEqual(!!pt.supportsMagsafe, false)
	assert.ok(productTypes.includedItemsFor(WATCH).length, 'the fixed contents are declared instead')
})

test('the fixed size catalogue ignores any attempt to disable a size', () => {
	const hostile = { [SIZES[0]]: false, [SIZES[1]]: true, [SIZES[2]]: false, 'iPhone 17': true }
	assert.deepStrictEqual(
		productTypes.normaliseEnabledModels(WATCH, hostile),
		Object.fromEntries(SIZES.map((size) => [size, true])),
	)
})

test('"As Shown" is the safe style fallback when vision is unavailable', () => {
	assert.deepStrictEqual(productTypes.styleKeysFor(WATCH), [STYLE_FALLBACK])
	assert.deepStrictEqual(productTypes.defaultEnabledStyles(WATCH), { [STYLE_FALLBACK]: true })
	assert.strictEqual(productTypes.fallbackStyleKey(WATCH), STYLE_FALLBACK)
})

test('the UI contract marks sizes fixed and names the visual axis Band Style', () => {
	// One payload describes the line to the setup card, the inspector and the
	// saved-run reopen path, so those three can never disagree.
	const meta = productTypes.productMeta(WATCH)
	assert.strictEqual(meta.product_type, WATCH)
	assert.strictEqual(meta.has_device_axis, true)
	assert.strictEqual(meta.fixed_device_axis, true)
	assert.strictEqual(meta.device_property_name, 'Band Size')
	assert.deepStrictEqual(meta.models, SIZES)
	assert.strictEqual(meta.style_property_name, 'Band Style')
	assert.strictEqual(meta.style_axis, 'variant')
	assert.strictEqual(meta.vision_style, 'band_variant')
	assert.strictEqual(meta.replace_fallback_with_vision_styles, true)
	assert.strictEqual(meta.fallback_style_key, STYLE_FALLBACK)
	assert.deepStrictEqual(meta.style_keys, [STYLE_FALLBACK])
	assert.strictEqual(meta.styles[0].price_label, 'All detected bands')
	assert.strictEqual(meta.supports_grip, false)
	assert.strictEqual(meta.supports_charm, false)
	assert.strictEqual(meta.supports_magsafe, false)
	assert.deepStrictEqual(meta.price_book_currencies.sort(), ['CAD', 'HKD'])
})

test('the line is offered to the operator in the Bulk Listings dropdown', () => {
	const listed = productTypes.listProductTypes().find((p) => p.id === WATCH)
	assert.ok(listed, 'the registry lists it')
	assert.strictEqual(listed.hasDeviceAxis, true)
	assert.strictEqual(listed.fixedDeviceAxis, true)
	assert.strictEqual(listed.styleProperty, 'Band Style')
	assert.deepStrictEqual(listed.styles.map((s) => s.key), [STYLE_FALLBACK])
})

// ════════════════════════════════════════════════════════════════════════════
// Part 2 · Prices
// ════════════════════════════════════════════════════════════════════════════
group('Prices come from the line\'s own book')

test('an HKD shop is priced at 350.11 and a CAD shop at 63.15 for every detected band', () => {
	for (const [currency, expected] of [['HKD', HKD_PRICE], ['CAD', CAD_PRICE]]) {
		const got = getPricesForCurrency(currency, { productType: WATCH })
		assert.strictEqual(got.source, 'product_type', `${currency} never opens the workbook`)
		assert.deepStrictEqual(got.missing, [], `${currency} has a standard band price`)
		assert.strictEqual(got.prices[STYLE_FALLBACK], expected, currency)
	}
})

test('a currency the book does not cover asks the operator instead of guessing', () => {
	// Silently inventing a USD price would publish real listings at a made-up
	// figure. The one standard band-price field is reported missing.
	const got = getPricesForCurrency('USD', { productType: WATCH })
	assert.strictEqual(got.source, 'product_type')
	assert.deepStrictEqual(got.prices, {})
	assert.deepStrictEqual(got.missing, [STYLE_FALLBACK])
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
	const shopRows = BANDS.map((band) => ({
		price_amount: 999.99,
		price_currency: 'HKD',
		listing_id: 1,
		property_values: JSON.stringify([
			{ property_id: productTypes.PROP_DEVICE, property_name: 'Band Size', values: [SIZES[0]] },
			{ property_id: productTypes.PROP_CHOICE, property_name: 'Band Style', values: [band] },
		]),
	}))
	const db = { prepare: () => ({ all: () => shopRows }) }

	const shopSeen = getShopCurrentStylePrices(db, 'ShopA', WATCH)
	assert.strictEqual(shopSeen.prices[STYLE_FALLBACK], 999.99, 'dynamic labels collapse to the standard-price key')

	const resolved = resolveDefaultPrices({
		db,
		shopId: 'ShopA',
		sheetPrices: getPricesForCurrency('HKD', { productType: WATCH }).prices,
		productType: WATCH,
	})
	assert.strictEqual(resolved.prices[STYLE_FALLBACK], HKD_PRICE)
	assert.strictEqual(resolved.source[STYLE_FALLBACK], 'sheet', 'the curated book wins')
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
	assert.deepStrictEqual(getShopCurrentStylePrices(db, 'ShopA', WATCH).prices, {}, 'a case bundle is not a band style')
})

test('changing the standard band price rebases every detected numbered style', () => {
	const mgr = Object.create(BulkJobManager.prototype)
	const preview = {
		enabledStyles: { [STYLE_FALLBACK]: false },
		stylePrices: { [STYLE_FALLBACK]: HKD_PRICE },
		customStyles: detectedBands.map((style, i) => ({ ...style, price: 300 + i })),
	}
	mgr._applyVisionStylePrice(preview, { [STYLE_FALLBACK]: 399.25 }, WATCH)
	assert.deepStrictEqual(preview.customStyles.map((style) => style.price), BANDS.map(() => 399.25))
	assert.strictEqual(mgr._effectiveMinPrice(preview), 399.25, 'a disabled fallback cannot lower the advertised price')
})

// ════════════════════════════════════════════════════════════════════════════
// Part 3 · The Etsy variation matrix
// ════════════════════════════════════════════════════════════════════════════
group('The variation matrix Etsy receives')

const bandPrices = { [STYLE_FALLBACK]: HKD_PRICE }
const detectedBands = BANDS.map((label, i) => ({
	id: `band-${i + 1}`,
	label,
	price: HKD_PRICE,
	imageRank: i + 1,
}))
const fallbackOff = { [STYLE_FALLBACK]: false }

test('fixed sizes cross every numbered band, with price carried by Band Style', () => {
	const { body, minPrice, listingQuantity } = variationBuilder.buildInventory({
		productType: WATCH,
		prices: bandPrices,
		enabledStyles: fallbackOff,
		customStyles: detectedBands,
		restockQuantity: 3,
	})
	assert.strictEqual(body.products.length, SIZES.length * BANDS.length, 'one product per size × band')
	assert.deepStrictEqual(body.price_on_property, [productTypes.PROP_CHOICE])
	assert.deepStrictEqual(body.quantity_on_property, [productTypes.PROP_CHOICE])
	const combinations = body.products.map((p) => p.property_values.map((pv) => pv.values[0]).join('|'))
	assert.deepStrictEqual(
		combinations,
		SIZES.flatMap((size) => BANDS.map((band) => `${size}|${band}`)),
		'in deterministic size-major / band-minor order',
	)
	for (const p of body.products) {
		assert.strictEqual(p.property_values.length, 2, 'exactly two variation dimensions')
		assert.strictEqual(p.property_values[0].property_id, productTypes.PROP_DEVICE)
		assert.strictEqual(p.property_values[0].property_name, 'Band Size')
		assert.strictEqual(p.property_values[1].property_id, productTypes.PROP_CHOICE)
		assert.strictEqual(p.property_values[1].property_name, 'Band Style')
		assert.strictEqual(p.offerings[0].price, HKD_PRICE)
		assert.strictEqual(p.offerings[0].is_enabled, true)
		assert.strictEqual(p.offerings[0].quantity, 3)
	}
	assert.strictEqual(minPrice, HKD_PRICE)
	assert.strictEqual(listingQuantity, SIZES.length * BANDS.length * 3)
})

test('inventory ignores both enabledModels and explicit models overrides for fixed sizes', () => {
	const { body } = variationBuilder.buildInventory({
		productType: WATCH,
		prices: bandPrices,
		enabledModels: Object.fromEntries(SIZES.map((size) => [size, false])),
		models: [SIZES[0]],
	})
	assert.deepStrictEqual(body.products.map((p) => p.property_values[0].values[0]), SIZES)
	assert.ok(body.products.every((p) => p.offerings[0].is_enabled), 'all fixed sizes remain buyer-visible')
})

test('when vision has no confident groups, every size uses the safe As Shown fallback', () => {
	const { body } = variationBuilder.buildInventory({
		productType: WATCH,
		prices: bandPrices,
	})
	assert.strictEqual(body.products.length, SIZES.length)
	assert.deepStrictEqual(body.products.map((p) => p.property_values[1].values[0]), SIZES.map(() => STYLE_FALLBACK))
	assert.ok(body.products.every((p) => p.offerings[0].is_enabled))
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
			assert.ok(/Band Style/.test(err.message), 'names the priced axis')
			assert.ok(/Variation Prices/.test(err.message), 'names where to fix it')
			return true
		},
	)
})

test('the generic style mapper never links a photo to Band Size or Band Style', () => {
	const mapping = aiGenerator.deriveStyleMapping(
		[{ index: 1, has_grip: false, has_charm: true, thumbnail_quality: 9 }, { index: 2, has_grip: false, has_charm: true, thumbnail_quality: 8 }],
		WATCH,
	)
	assert.deepStrictEqual(mapping, {})
})

test('the focused vision normalizer groups duplicate views and supports multicolor bands', () => {
	const analysis = bandVariantAnalyzer.normaliseBandVariantAnalysis({
		variants: [
			{ visual_signature: 'White enamel cross and heart links with gold hardware', image_indexes: [1, 2], primary_image_index: 2, confidence: 96, evidence: 'Same white and gold band from two angles.' },
			{ visual_signature: 'WHITE ENAMEL CROSS AND HEART LINKS WITH GOLD HARDWARE', image_indexes: [3], primary_image_index: 3, confidence: 80, evidence: 'Same band from the clasp side.' },
			{ visual_signature: 'unknown', image_indexes: [4], primary_image_index: 4, confidence: 30, evidence: 'Only the watch face is visible.' },
			{ visual_signature: 'Pink blue and cream checker links with silver clasp', image_indexes: [5, 99], primary_image_index: 5, confidence: 91, evidence: 'One multicolor band, not three color options.' },
		],
		overall_confidence: 94,
		reasoning: 'Two physical variants are shown.',
	}, 5)
	assert.deepStrictEqual(
		analysis.variants.map((v) => v.visualSignature),
		['White enamel cross and heart links with gold hardware', 'Pink blue and cream checker links with silver clasp'],
	)
	assert.deepStrictEqual(analysis.variants[0].imageIndexes, [1, 2, 3], 'alternate views collapse')
	assert.strictEqual(analysis.overallConfidence, 94)
})

test('the vision model cannot invent buyer-facing option names', () => {
	const fields = bandVariantAnalyzer.BAND_VARIANT_SCHEMA.schema.properties.variants.items.properties
	assert.strictEqual(Object.prototype.hasOwnProperty.call(fields, 'label'), false)
	assert.strictEqual(Object.prototype.hasOwnProperty.call(fields, 'band_color'), false)
	assert.ok(fields.visual_signature, 'vision still returns internal grouping evidence')
})

test('only confident groups become sequential, photo-linked Etsy values', () => {
	const styles = bandVariantAnalyzer.materialiseBandVariants({
		variants: [
			{ visualSignature: 'first', imageIndexes: [1, 2], primaryImageIndex: 2, confidence: 95 },
			{ visualSignature: 'uncertain', imageIndexes: [3], primaryImageIndex: 3, confidence: 59 },
			{ visualSignature: 'third accepted', imageIndexes: [4], primaryImageIndex: 4, confidence: 90 },
		],
	}, {
		price: HKD_PRICE,
		imageAnalysis: [{ index: 1, thumbnail_quality: 9 }, { index: 2, thumbnail_quality: 8 }],
	})
	assert.deepStrictEqual(styles.map((s) => s.label), ['Band 1', 'Band 2'], 'the 59% guess is removed without leaving a numbering gap')
	assert.deepStrictEqual(styles.map((s) => s.id), ['band-1', 'band-2'])
	assert.strictEqual(styles[0].price, HKD_PRICE)
	assert.strictEqual(styles[0].imageRank, 2, 'the classifier-selected dedicated image wins')
})

test('direct inventory input is renumbered and any unlinked band is rejected', () => {
	const { customStyles, body } = variationBuilder.buildInventory({
		productType: WATCH,
		prices: bandPrices,
		enabledStyles: fallbackOff,
		customStyles: [
			{ id: 'keep-a', label: 'Rainbow Gold', price: HKD_PRICE, imageRank: 8 },
			{ id: 'drop', label: 'Blue', price: HKD_PRICE, imageRank: null },
			{ id: 'keep-b', label: 'Pink Silver', price: HKD_PRICE, imageRank: 4 },
		],
	})
	assert.deepStrictEqual(customStyles.map((style) => style.label), ['Band 1', 'Band 2'])
	assert.deepStrictEqual(customStyles.map((style) => style.imageRank), [8, 4], 'each buyer value retains its linked image')
	assert.deepStrictEqual(
		[...new Set(body.products.map((product) => product.property_values[1].values[0]))],
		['Band 1', 'Band 2'],
	)
})

test('each numbered band links its Etsy value id to the selected product image', () => {
	const links = variationBuilder.buildCustomVariationImages({
		customStyles: detectedBands,
		rankToImageId: new Map([[1, 9101], [2, 9102], [3, 9103], [4, 9104]]),
		styleLabelToValueId: new Map([['Band 1', 8101], ['Band 2', 8102], ['Band 3', 8103], ['Band 4', 8104]]),
		productType: WATCH,
	})
	assert.deepStrictEqual(
		links,
		BANDS.map((_, index) => ({
			property_id: productTypes.PROP_CHOICE,
			value_id: 8101 + index,
			image_id: 9101 + index,
		})),
	)
})

// ════════════════════════════════════════════════════════════════════════════
// Part 4 · The copy pipeline
// ════════════════════════════════════════════════════════════════════════════
group('The copy speaks about a band, not about a case')

const enabledAllSizes = Object.fromEntries(SIZES.map((s) => [s, true]))
const watchPrompt = aiGenerator.buildPhase2System(
	'Y2KASE',
	['y2kase'],
	true,
	fallbackOff,
	enabledAllSizes,
	{},
	{ isGeneric: true, motifs: ['cherry'] },
	WATCH,
	detectedBands,
	null,
)

test('the title uses the strongest item query once instead of stacking synonyms', () => {
	assert.ok(watchPrompt.includes('exact item/compatibility phrase "Apple Watch Band"'))
	assert.ok(watchPrompt.includes('repeated product synonyms'))
	assert.ok(!watchPrompt.includes('exact item/compatibility phrase "Strap for Apple Watch"'))
})

test('the sizes are a compatibility statement, never a bundle', () => {
	// Listing "38/40/41mm" under "What's Included" would read as three items in
	// the box. The sizes belong in the compatibility section; the contents are
	// the fixed list the descriptor declares.
	assert.ok(watchPrompt.includes('Apple Watch 38mm, 40mm & 41mm'), 'the sizes are advertised as fit')
	assert.ok(watchPrompt.includes('NEVER present the band styles as separate included items'))
	for (const item of productTypes.includedItemsFor(WATCH)) assert.ok(watchPrompt.includes(item), item)
})

test('Band Style is required and numbered values point buyers to their photos', () => {
	assert.ok(watchPrompt.includes('"🎨 Band Style"'))
	for (const band of BANDS) assert.ok(watchPrompt.includes(band), band)
	assert.ok(watchPrompt.includes('use its variation photo'))
	assert.ok(watchPrompt.includes('one "Band Size" and one "Band Style"'))
	assert.ok(watchPrompt.includes('Neither selection is optional'))
})

test('the SEO brief treats field limits as ceilings and optimizes every surface', () => {
	assert.ok(watchPrompt.includes('between 110 and 140 characters'))
	assert.ok(watchPrompt.includes('first 50-60 characters'))
	assert.ok(watchPrompt.includes('usually 250-450 words'))
	assert.ok(!watchPrompt.includes('minimum 500 words'))
	assert.ok(watchPrompt.includes('EXACTLY 13 tags'))
	assert.ok(watchPrompt.includes('Do not cut a word in half'))
	assert.ok(watchPrompt.includes('ATTRIBUTES'))
	assert.ok(watchPrompt.includes('COLORS'))
	assert.ok(watchPrompt.includes('Never say "ready to ship"'))
})

test('no grip, no charm bundle and no MagSafe can be promised', () => {
	assert.ok(watchPrompt.includes('Do NOT write a grip paragraph'))
	assert.ok(watchPrompt.includes('Do NOT promise any separate add-on accessory'))
	assert.ok(/NEVER mention MagSafe/.test(watchPrompt), 'MagSafe is refused even when the caller asks for it')
	assert.ok(watchPrompt.includes('NEVER describe this product as a phone case'))
})

test('a caller cannot suppress a mandatory size from copy or post-processing', () => {
	const oneSize = { [SIZES[0]]: true, [SIZES[1]]: false, [SIZES[2]]: false }
	const prompt = aiGenerator.buildPhase2System('Y2KASE', ['y2kase'], false, fallbackOff, oneSize, {}, {}, WATCH, detectedBands, null)
	assert.ok(prompt.includes('Apple Watch 38mm, 40mm & 41mm'))
	assert.ok(prompt.includes('Apple Watch 42mm (Series 10 & 11)'), 'fixed size was restored')
	assert.ok(prompt.includes('Apple Watch 42mm, 44mm, 45mm, 46mm & 49mm'), 'all fixed sizes are present')

	// The post-process filter likewise retains every mandatory compatibility row.
	const description = ['• Apple Watch 38mm, 40mm & 41mm', '• Apple Watch 42mm (Series 10 & 11)', 'Ships in 3-5 business days.'].join('\n')
	const filtered = aiGenerator.filterModelsInDescription(description, oneSize, WATCH, fallbackOff)
	assert.ok(filtered.includes('Apple Watch 38mm, 40mm & 41mm'), 'the offered size stays')
	assert.ok(filtered.includes('Series 10 & 11'), 'the fixed size cannot be filtered out')
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
const bandVariations = [
	{ property_id: productTypes.PROP_DEVICE, formatted_name: 'Band Size', formatted_value: '42mm [Series 10/11]' },
	{ property_id: productTypes.PROP_CHOICE, formatted_name: 'Band Style', formatted_value: BANDS[0] },
]

test('"Band Size" is the fit and "Band Style" is the selected appearance', () => {
	const parsed = routeDashboard.parseVariations(bandVariations)
	assert.strictEqual(parsed.phoneModel, '42mm [Series 10/11]')
	assert.strictEqual(parsed.style, BANDS[0])
	assert.strictEqual(productTypes.variationPropertyRole('Band Size'), 'fit')
	assert.strictEqual(productTypes.variationPropertyRole('Band Style'), 'choice')
	assert.strictEqual(productTypes.variationPropertyRole('Band Color'), 'choice', 'prior drafts remain readable')
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
	const comps = routeDashboard.styleComponents(BANDS[0], { phoneModel: '42mm [Series 10/11]', title: BAND_TITLE })
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

test('component-bearing bundle strings still win over family fallback', () => {
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

test('a restock groups by Band Style and retains Band Size as its secondary fit', () => {
	const labels = inventoryHelpers.deriveVariationLabels([
		{ property_name: 'Band Size', values: ['38/40/41mm'] },
		{ property_name: 'Band Style', values: [BANDS[0]] },
	])
	assert.deepStrictEqual(labels, { styleVal: BANDS[0], secondaryVal: '38/40/41mm' })
	assert.deepStrictEqual(
		inventoryHelpers.deriveVariationLabels([
			{ property_name: 'Band Size', values: ['38/40/41mm'] },
			{ property_name: 'Band Color', values: ['White + Gold Metal'] },
		]),
		{ styleVal: 'White + Gold Metal', secondaryVal: '38/40/41mm' },
		'the prior schema still groups restocks correctly',
	)
	assert.deepStrictEqual(
		inventoryHelpers.deriveVariationLabels([{ property_name: 'Band Size', values: ['38/40/41mm'] }]),
		{ styleVal: '38/40/41mm', secondaryVal: null },
		'legacy single-axis watch listings remain readable',
	)
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

test('the Inspector hides fixed size rows but explains the required Etsy choice', () => {
	assert.ok(page.includes('fixed_device_axis'))
	assert.ok(page.includes('is added automatically with all ${BULK_MODELS.length} required buyer options'))
	assert.ok(page.includes('these fixed values cannot be removed here'))
	assert.ok(page.includes("vision_style === 'band_variant'"))
	assert.ok(page.includes('+ Add band'))
	assert.ok(page.includes('readonly aria-label="Automatically assigned band option"'))
	assert.ok(page.includes('Every numbered band needs a variation photo'))
	assert.ok(page.includes('no color naming is needed'))
	assert.ok(page.includes('function bulkTitleMetricsText'))
	assert.ok(page.includes('Etsy-recommended length'))
	assert.ok(page.includes('SEO QA passed'))
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
console.log(`\n${BOLD}Apple Watch band — locked sizes × photo-linked numbered bands, end to end${RESET}\n`)
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
