'use strict'

/**
 * Tests for the Sourcing Catalog — the unified view of what we sell, who we buy
 * it from, where they are and what it costs.
 *
 * WHY THIS FILE EXISTS
 * ----------------------------------------------------------------------------
 * The catalog is a PROJECTION, not a table. It joins product_map with the
 * supplier and charm directories and adds four derived facts on top: the product
 * type, the physical location, an inferred stall, and the list of things that
 * stop a row being ready to buy from. Every one of those is a judgement call
 * that an operator will act on with a shopping bag in their hand, so each is
 * pinned here:
 *
 *   · CLASSIFICATION. An AirPods listing is also titled "…Case", so a naive
 *     match files it as a phone case and a buyer walks to the wrong stall. The
 *     precedence is asserted title by title, including the bundle titles that
 *     name three components at once.
 *   · INFERENCE HAS A LIMIT. A stall is only borrowed from the directory when
 *     the supplier has exactly ONE — guessing between two would be worse than
 *     saying nothing. Asserted in both directions.
 *   · GAPS ARE NOT DOUBLE-COUNTED. A row with no supplier has one problem, not
 *     three, or the "needs attention" count stops meaning anything.
 *   · PRICES NEVER LOOK COMPLETE WHEN THEY ARE NOT. An unpriced component is
 *     skipped from the unit cost, never treated as zero.
 *   · THE PROJECTION IS READ-ONLY. Building it twice must change nothing, or
 *     the "one write path per table" guarantee the whole design rests on is
 *     already broken.
 *
 * The DB half runs against a REAL throwaway SQLite database through the same
 * accessors the server uses, because the joins are the risk, and a mocked
 * accessor would only prove the mock agrees with itself.
 *
 * Run: `node scripts/test-sourcing-catalog.js`   (exit 0 = pass, 1 = regression)
 */

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const catalog = require('../src/sourcing/catalog')
const catalogView = require('../src/sourcing/catalog-view')
const stallLocation = require('../src/route/stall-location')
const routeDashboard = require('../src/route/dashboard')
const policy = require('../src/auth/policy')
const {
	initDb,
	upsertProductMapRow,
	updateProductMapRowById,
	getProductMap,
	replaceProductMap,
	setProductCost,
	setCharmCost,
	insertSupplierDirectoryRow,
	insertCharmShopDirectoryRow,
	insertCharmLibraryRow,
} = require('../src/db/setup')

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m'
let passed = 0, failed = 0
const failures = []
const queue = []
const group = (name) => queue.push({ group: name })
const test = (name, fn) => queue.push({ name, fn })

// ════════════════════════════════════════════════════════════════════════════
// Part 1 · Classification (pure)
// ════════════════════════════════════════════════════════════════════════════
group('Classifying a product from its title')

test('a phone case is a phone case', () => {
	for (const title of [
		'Cute Bunny iPhone 16 Pro Max Case',
		'Kawaii Bear Phone Case for iPhone 15',
		'Clear Protective Cover iPhone 14 Plus',
		'Y2K Butterfly Shell iPhone 13',
	]) {
		assert.strictEqual(catalog.deriveProductType(title), 'iphone_case', title)
	}
})

test('an AirPods case is never filed as a phone case', () => {
	// The whole reason AirPods are tested FIRST: every one of these also says
	// "Case", so a case-word match would send a buyer to the phone-case stall.
	for (const title of [
		'Kawaii AirPods Pro 2 Case',
		'Cute Bear Air Pods 3 Case Cover',
		'Pearl Bow airpods pro case with keychain',
	]) {
		assert.strictEqual(catalog.deriveProductType(title), 'airpods_case', title)
	}
})

test('the same device test fulfilment uses decides the family', () => {
	// Sharing deviceFamilyOf() is what stops the catalog and the model-fix guard
	// disagreeing about what an AirPods product is. Asserted through the public
	// behaviour: the spellings that helper accepts are the ones classified here.
	const { deviceFamilyOf, FAMILY_AIRPODS } = require('../src/listings/product-types')
	for (const title of ['AirPods Pro Case', 'air pods 3 case', 'AIRPOD case']) {
		assert.strictEqual(deviceFamilyOf('', title), FAMILY_AIRPODS, `${title} — the shared helper`)
		assert.strictEqual(catalog.deriveProductType(title), 'airpods_case', `${title} — the catalog`)
	}
})

test('an Apple Watch band is filed as a band, not as a charm or a case', () => {
	// Real band titles say "Charm" and "Strap" — both charm words — and some say
	// "Case" too. Testing the watch family FIRST is what keeps them off the
	// charm stall's shopping list.
	for (const title of [
		'Colorful Button Charm Apple Watch Band',
		'Kawaii Beaded Watch Strap for Apple Watch 42mm',
		'Y2K Pearl Watch Band 38/40/41mm',
	]) {
		assert.strictEqual(catalog.deriveProductType(title), 'apple_watch_band', title)
	}
})

test('an iPad case is filed as an iPad case, not as a phone case', () => {
	// Every iPad title says "Case" or "Cover", so the generic case rule would
	// file the whole line under iPhone and send a shopper to the wrong stall.
	for (const title of [
		'Bunny Cloud iPad Case, Magnetic Detachable Flip Cover for iPad Air',
		'Kawaii Clear iPad Pro 11 inch Case with Pencil Holder',
		'Y2K Tablet Case Cover',
	]) {
		assert.strictEqual(catalog.deriveProductType(title), 'ipad_case', title)
	}
})

test('a grip and a charm are only matched when nothing is cased', () => {
	assert.strictEqual(catalog.deriveProductType('Daisy Flower Phone Grip Holder'), 'grip')
	assert.strictEqual(catalog.deriveProductType('Retro Griptok Stand'), 'grip')
	assert.strictEqual(catalog.deriveProductType('Pearl Bow Charm'), 'charm')
	assert.strictEqual(catalog.deriveProductType('Beaded Phone Strap Keychain'), 'charm')
})

test('a bundle title is classified by what the buyer is actually buying', () => {
	// A real listing names three components. It is ONE case listing that throws
	// in a grip and a charm — filing it under "charm" would hide it from the
	// case-cost checks and from the case stall's product count.
	const bundle = 'Cherry MagSafe Case, Daisy Rabbit Grip & Pearl Bow Charm for iPhone 16'
	assert.strictEqual(catalog.deriveProductType(bundle), 'iphone_case')
})

test('an unclassifiable title becomes "other" rather than a wrong guess', () => {
	for (const title of ['Mystery Bundle', 'Sticker Sheet', '', '   ', null, undefined, 12345]) {
		assert.strictEqual(catalog.deriveProductType(title), 'other', JSON.stringify(title))
	}
})

test('substrings never match — a "staircase" is not a case', () => {
	// Word-boundary anchoring. "Suitcase"/"showcase" appear in real prop-styling
	// titles and would otherwise all become phone cases.
	assert.strictEqual(catalog.deriveProductType('Suitcase Sticker Pack'), 'other')
	assert.strictEqual(catalog.deriveProductType('Showcase Display Riser'), 'other')
	assert.strictEqual(catalog.deriveProductType('Understanding Grips'), 'other', 'and "grips" needs its own word too')
})

group('The operator overrides the guess')

test("a stored type wins over the title, and says it's an override", () => {
	const row = { title: 'Cherry Case for iPhone 16', product_type: 'airpods_case' }
	assert.deepStrictEqual(catalog.resolveProductType(row), { id: 'airpods_case', source: 'override' })
})

test('no stored type falls back to the derivation, flagged as a guess', () => {
	assert.deepStrictEqual(catalog.resolveProductType({ title: 'Cherry Case for iPhone 16' }), { id: 'iphone_case', source: 'derived' })
	for (const stored of [null, '', '   ']) {
		assert.strictEqual(catalog.resolveProductType({ title: 'Pearl Charm', product_type: stored }).source, 'derived', JSON.stringify(stored))
	}
})

test('a type retired from the taxonomy re-derives instead of rendering a dead badge', () => {
	const row = { title: 'Daisy Phone Grip', product_type: 'phone_case_v1' }
	assert.deepStrictEqual(catalog.resolveProductType(row), { id: 'grip', source: 'derived' })
})

test('the taxonomy is a closed set the API can validate against', () => {
	assert.deepStrictEqual(catalog.PRODUCT_TYPE_IDS, ['iphone_case', 'airpods_case', 'apple_watch_band', 'ipad_case', 'grip', 'charm', 'other'])
	for (const id of catalog.PRODUCT_TYPE_IDS) assert.strictEqual(catalog.isValidProductType(id), true, id)
	for (const bad of ['', null, undefined, 'IPHONE_CASE', 'weapons', 'other ']) {
		assert.strictEqual(catalog.isValidProductType(bad), false, JSON.stringify(bad))
	}
	assert.strictEqual(catalog.productType('nope').id, 'other', 'an unknown id degrades to "other", never undefined')
})

test('every type is labelled in both languages the page renders', () => {
	for (const t of catalog.PRODUCT_TYPES) {
		assert.ok(t.label && t.label_zh, `${t.id} needs an en and a zh label`)
		assert.strictEqual(catalog.productTypeLabel(t.id, 'zh'), t.label_zh)
		assert.strictEqual(catalog.productTypeLabel(t.id, 'en'), t.label)
	}
	for (const g of catalog.GAP_TYPES) assert.ok(g.label && g.label_zh, `${g.id} needs an en and a zh label`)
})

// ════════════════════════════════════════════════════════════════════════════
// Part 2 · Prices (pure)
// ════════════════════════════════════════════════════════════════════════════
group('Prices')

test('a price is rounded to money, and nonsense becomes "not priced"', () => {
	assert.strictEqual(catalog.normalizePrice('12.5'), 12.5)
	assert.strictEqual(catalog.normalizePrice(12.005), 12.01)
	assert.strictEqual(catalog.normalizePrice(0), 0, 'free is a price; it is not the same as unpriced')
	for (const bad of [null, undefined, '', 'abc', NaN, Infinity, -1, -0.01]) {
		assert.strictEqual(catalog.normalizePrice(bad), null, JSON.stringify(String(bad)))
	}
})

test('a row is judged on the price its own type actually has', () => {
	// A grip-only product is priced when it has a grip cost. Judging it on the
	// case cost would leave every grip permanently "needs attention".
	assert.deepStrictEqual(catalog.priceFieldsFor('iphone_case'), ['cost_case'])
	assert.deepStrictEqual(catalog.priceFieldsFor('airpods_case'), ['cost_case'])
	assert.deepStrictEqual(catalog.priceFieldsFor('grip'), ['cost_grip'])
	assert.deepStrictEqual(catalog.priceFieldsFor('charm'), [], "a charm's price lives on the charm code, not the product")
	assert.deepStrictEqual(catalog.priceFieldsFor('other'), ['cost_case'])
})

// ════════════════════════════════════════════════════════════════════════════
// Part 3 · Gaps (pure)
// ════════════════════════════════════════════════════════════════════════════
group('What stops a row being ready to buy from')

const gapsOf = (row) => catalog.catalogGaps({ product_type: 'iphone_case', ...row })

test('a complete row has nothing wrong with it', () => {
	assert.deepStrictEqual(gapsOf({ shop_name: 'HAN', stall_effective: 'A2-29', supplier_in_directory: true, cost_case: 5, image_url: '/i.png' }), [])
})

test('a missing supplier is ONE problem, not three', () => {
	// Telling an operator that a blank supplier also has a blank stall and is not
	// in the directory is noise: there is one thing to do, which is name a shop.
	assert.deepStrictEqual(gapsOf({ shop_name: '', cost_case: 5, image_url: '/i.png' }), ['no_supplier'])
})

test('a named supplier is checked for a stall and for being registered', () => {
	assert.deepStrictEqual(gapsOf({ shop_name: 'HAN', stall_effective: '', supplier_in_directory: true, cost_case: 5, image_url: '/i.png' }), ['no_stall'])
	assert.deepStrictEqual(
		gapsOf({ shop_name: 'Ghost', stall_effective: 'X1', supplier_in_directory: false, cost_case: 5, image_url: '/i.png' }),
		['unlisted_supplier'],
	)
})

test('a price gap is reported once, against the right column', () => {
	assert.deepStrictEqual(gapsOf({ shop_name: 'HAN', stall_effective: 'A2-29', supplier_in_directory: true, image_url: '/i.png' }), ['no_price'])
	const grip = { product_type: 'grip', shop_name: 'HAN', stall_effective: 'A2-29', supplier_in_directory: true, image_url: '/i.png' }
	assert.deepStrictEqual(catalog.catalogGaps({ ...grip, cost_case: 9 }), ['no_price'], 'a case cost does not price a grip')
	assert.deepStrictEqual(catalog.catalogGaps({ ...grip, cost_grip: 2 }), [], 'its grip cost does')
	assert.deepStrictEqual(
		catalog.catalogGaps({ product_type: 'charm', shop_name: 'HAN', stall_effective: '2D21', supplier_in_directory: true, image_url: '/i.png' }),
		[],
		'a charm has no price of its own to be missing',
	)
})

test('a free product is priced, not unpriced', () => {
	// The classic falsy-zero bug: `!row.cost_case` would report a gap on 0.
	assert.deepStrictEqual(gapsOf({ shop_name: 'HAN', stall_effective: 'A2-29', supplier_in_directory: true, cost_case: 0, image_url: '/i.png' }), [])
})

test('the product row wins over the inferred stall when both exist', () => {
	// catalogGaps falls back to `stall` so it can be reused on a raw row.
	assert.deepStrictEqual(gapsOf({ shop_name: 'HAN', stall: 'A2-29', supplier_in_directory: true, cost_case: 5, image_url: '/i.png' }), [])
})

test('every reported gap is one the UI has a chip for', () => {
	const row = { product_type: 'iphone_case', shop_name: 'Ghost', supplier_in_directory: false }
	for (const g of catalog.catalogGaps(row)) assert.strictEqual(catalog.isValidGapType(g), true, g)
	assert.deepStrictEqual(catalog.GAP_TYPE_IDS, ['no_supplier', 'no_stall', 'unlisted_supplier', 'no_price'])
})

test('a missing image is not a gap — those rows never reach the catalog', () => {
	assert.ok(!catalog.catalogGaps({ shop_name: 'HAN', stall_effective: 'A2-29', supplier_in_directory: true, cost_case: 5 }).includes('no_image'))
	assert.strictEqual(catalog.isValidGapType('no_image'), false)
})

// ════════════════════════════════════════════════════════════════════════════
// Part 4 · Locations (pure)
// ════════════════════════════════════════════════════════════════════════════
group('Rendering a location')

test('the unknown-floor sentinel is the route parser\'s, not a second one', () => {
	// Two sentinels drifting apart would print "F999" on the busiest market we
	// have not surveyed yet.
	assert.strictEqual(catalog.UNKNOWN_FLOOR_SENTINEL, stallLocation.UNKNOWN_FLOOR)
})

test('a location reads market · floor · booth, in either language', () => {
	const loc = catalogView.resolveLocation('康乐北区5A40-42', '热点')
	assert.strictEqual(catalog.locationText(loc, 'en'), 'Kangle North · F5 · 5A40-42')
	assert.strictEqual(catalog.locationText(loc, 'zh'), '康乐北区 · 5楼 · 5A40-42')
})

test('an unreadable floor is left out rather than printed as 999', () => {
	const loc = catalogView.resolveLocation('汇通A146', 'leo')
	assert.strictEqual(loc.floor, stallLocation.UNKNOWN_FLOOR)
	assert.strictEqual(catalog.locationText(loc, 'en'), 'Huitong · A146')
})

test('an unrecorded stall has no location line at all', () => {
	for (const stall of ['', '   ', '—', null, undefined]) {
		assert.strictEqual(catalog.locationText(catalogView.resolveLocation(stall, ''), 'en'), '', JSON.stringify(stall))
		assert.strictEqual(catalog.locationText(catalogView.resolveLocation(stall, ''), 'zh'), '')
	}
	assert.strictEqual(catalog.locationText(null, 'en'), '', 'and a missing location object is not a crash')
})

test('the location carries the walking-order key, so the page never re-parses', () => {
	const loc = catalogView.resolveLocation('康乐北区5A40-42', '热点')
	assert.strictEqual(loc.sort_key, stallLocation.locationSortKey('康乐北区5A40-42', '热点'))
	assert.ok(catalogView.resolveLocation('A2-29', 'HAN').sort_key < loc.sort_key, 'and it orders markets the way a buyer walks them')
})

test('shop names are matched case- and whitespace-insensitively', () => {
	assert.strictEqual(catalogView.shopKey('  Han   Cases '), catalogView.shopKey('han cases'))
	assert.strictEqual(catalogView.shopKey(null), '')
	assert.strictEqual(catalogView.supplierKey('HAN', 'A2-29'), catalogView.supplierKey('han', 'A2-29'))
	assert.notStrictEqual(catalogView.supplierKey('HAN', 'A2-29'), catalogView.supplierKey('HAN', 'A2-30'))
})

group('De-duplicating supplier product cards (pure)')

const groupedFixture = [
	{
		id: 11,
		supplier_key: 'shop-a\u0000a1',
		canonical_product_key: 'P-100',
		gaps: ['no_price'],
		cost_case: null,
		cost_grip: null,
		charm_cost: null,
		cost_total: null,
		image_approx: false,
		product_type: 'iphone_case',
		product_type_source: 'derived',
		sort_order: 1,
	},
	{
		id: 12,
		supplier_key: 'shop-a\u0000a1',
		canonical_product_key: 'P-100',
		gaps: [],
		cost_case: 6,
		cost_grip: 2,
		charm_cost: 1,
		cost_total: 9,
		image_approx: true,
		product_type: 'iphone_case',
		product_type_source: 'override',
		sort_order: 2,
	},
	// No canonical identity: identical-looking/title-shaped rows must remain
	// separate. The browser is not allowed to guess and hide real products.
	{ id: 13, supplier_key: 'shop-a\u0000a1', canonical_product_key: '', gaps: [], cost_total: 4, product_type: 'iphone_case', sort_order: 3 },
	{ id: 14, supplier_key: 'shop-a\u0000a1', canonical_product_key: '', gaps: [], cost_total: 4, product_type: 'iphone_case', sort_order: 4 },
	// A canonical key never collapses across two physical supplier rows.
	{ id: 15, supplier_key: 'shop-b\u0000b1', canonical_product_key: 'P-100', gaps: [], cost_total: 9, product_type: 'iphone_case', sort_order: 5 },
]

test('canonical aliases become one supplier card while all source ids remain addressable', () => {
	const groups = catalogView.groupSupplierProducts(groupedFixture)
	assert.strictEqual(groups.length, 4, 'two aliases collapsed; unkeyed rows and another supplier did not')
	const merged = groups.find((g) => g.supplier_key === 'shop-a\u0000a1' && g.canonical_product_key === 'P-100')
	assert.deepStrictEqual(merged.product_ids, [11, 12])
	assert.strictEqual(merged.listing_count, 2)
	assert.strictEqual(merged.representative_id, 12, 'the complete/priced alias represents the card')
	assert.strictEqual(merged.priced, true)
	assert.strictEqual(merged.ready, true)
	assert.strictEqual(merged.cost_total, 9)
})

test('missing canonical identity falls back to row id, never fuzzy hiding', () => {
	assert.strictEqual(catalogView.supplierProductIdentity(groupedFixture[0]), 'canonical:P-100')
	assert.strictEqual(catalogView.supplierProductIdentity(groupedFixture[2]), 'row:13')
	const unkeyed = catalogView.groupSupplierProducts(groupedFixture).filter((g) => g.supplier_key === 'shop-a\u0000a1' && !g.canonical_product_key)
	assert.deepStrictEqual(
		unkeyed.map((g) => g.product_ids),
		[[13], [14]],
	)
})

test('an exact, specific design-name match collapses lifestyle-photo misses only in the supplier view', () => {
	const rows = [
		{
			...groupedFixture[1],
			id: 21,
			canonical_product_key: 'P-21',
			title: 'Kawaii Sleepy Star MagSafe Case with Shaker Grip & Beaded Charm, Cute Clear Cover iPhone 17 16 15 14 Pro Max, Yellow Gift',
		},
		{
			...groupedFixture[1],
			id: 22,
			canonical_product_key: 'P-22',
			title: 'Kawaii Sleepy Star MagSafe Case, Liquid Shaker Grip, Pastel Night Sky Clear Cover iPhone 17 16 15 14 13 Pro Max, Cute Gift',
		},
	]
	assert.strictEqual(catalogView.supplierPresentationSignature(rows[0]), 'sleepy star')
	assert.strictEqual(catalogView.supplierPresentationSignature(rows[1]), 'sleepy star')
	const groups = catalogView.groupSupplierProducts(rows)
	assert.strictEqual(groups.length, 1)
	assert.strictEqual(groups[0].group_reason, 'presentation')
	assert.strictEqual(groups[0].presentation_key, 'sleepy star')
	assert.deepStrictEqual(groups[0].product_ids, [21, 22])
	assert.deepStrictEqual(rows.map((r) => r.canonical_product_key), ['P-21', 'P-22'], 'canonical source identities were not rewritten')
})

test('a broad repeated prefix is refused rather than hiding distinct products', () => {
	const rows = [31, 32, 33, 34].map((id) => ({
		...groupedFixture[1],
		id,
		canonical_product_key: `P-${id}`,
		title: `Kawaii Hello Kitty MagSafe Case ${id} with a different design`,
	}))
	assert.strictEqual(catalogView.supplierPresentationSignature(rows[0]), 'hello kitty')
	assert.strictEqual(catalogView.groupSupplierProducts(rows).length, 4, 'more than three canonical groups must never presentation-merge')
})

test('grouping is a read-only projection and never mutates catalog rows', () => {
	const before = JSON.stringify(groupedFixture)
	catalogView.groupSupplierProducts(groupedFixture)
	assert.strictEqual(JSON.stringify(groupedFixture), before)
})

// ════════════════════════════════════════════════════════════════════════════
// Part 5 · The read model, over a real database
// ════════════════════════════════════════════════════════════════════════════
group('Building the catalog from the real tables')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcing-catalog-'))
const db = initDb(path.join(tmpDir, 'test.db'))

// ── Fixtures ────────────────────────────────────────────────────────────────
// The supplier directory. TwoStall deliberately holds two booths: it is the
// case where a stall must NOT be inferred.
insertSupplierDirectoryRow(db, { shop_name: 'HAN', stall: 'A2-29', mall: '通信', floor: '2' })
insertSupplierDirectoryRow(db, { shop_name: '热点', stall: '康乐北区5A40-42' })
insertSupplierDirectoryRow(db, { shop_name: 'TwoStall', stall: '5C26' })
insertSupplierDirectoryRow(db, { shop_name: 'TwoStall', stall: '5C27' })

insertCharmShopDirectoryRow(db, { shop_name: '彩虹', stall: '2D21' })
insertCharmLibraryRow(db, { code: '2C666', default_charm_shop: '彩虹' })
setCharmCost(db, { code: '2C666', cost: 3.5 })

// The products. Each one is a distinct case the projection has to get right.
const P = {
	inferred: 'Cute Bunny iPhone 16 Pro Max Case', //  supplier, no stall → borrow the directory's
	airpods: 'Kawaii AirPods Pro 2 Case Cover', //     fully specified and priced
	ambiguous: 'Daisy Flower Phone Grip Holder', //    supplier with TWO stalls → infer nothing
	charm: 'Pearl Bow Charm Keychain', //              no supplier; charm data comes from the library
	ghost: 'Mystery Thing From Nowhere', //            supplier that is not in the directory
	override: 'Cherry Case for iPhone 16', //          operator says this is really an AirPods case
	noPhoto: 'Plain Unphotographed iPhone Case', //    deliberately imageless → must be dropped
}
upsertProductMapRow(db, { title: P.inferred, shop_name: 'han', stall: '' })
upsertProductMapRow(db, { title: P.airpods, shop_name: '热点', stall: '康乐北区5A40-42' })
upsertProductMapRow(db, { title: P.ambiguous, shop_name: 'TwoStall', stall: '' })
upsertProductMapRow(db, { title: P.charm, shop_name: '', charm_code: '2c666' })
upsertProductMapRow(db, { title: P.ghost, shop_name: 'GhostShop', stall: 'X1' })
upsertProductMapRow(db, { title: P.override, shop_name: 'HAN', stall: 'A2-29', product_type: 'airpods_case' })
upsertProductMapRow(db, { title: P.noPhoto, shop_name: 'HAN', stall: 'A2-29' })

setProductCost(db, { title: P.airpods, cost_case: 5 })
setProductCost(db, { title: P.ambiguous, cost_grip: 2 })
setProductCost(db, { title: P.override, cost_case: 6, cost_grip: 1.5 })

// Every listed product has a photo except P.noPhoto — the catalog projection
// must drop that one and keep the rest.
const WITH_IMAGE = new Set([P.inferred, P.airpods, P.ambiguous, P.charm, P.ghost, P.override].map((t) => t.toLowerCase()))
const imageResolver = {
	resolve: (titleNorm) => (WITH_IMAGE.has(titleNorm) ? { url: `/api/route/image/${encodeURIComponent(titleNorm)}`, approx: false } : null),
}
const build = () => catalogView.buildCatalog(db, { imageResolver })
const view = build()
const byTitle = (t) => view.products.find((p) => p.title === t)

test('every product_map row with an image is present exactly once', () => {
	assert.strictEqual(view.products.length, 6)
	assert.strictEqual(view.totals.products, 6)
	assert.strictEqual(new Set(view.products.map((p) => p.title_norm)).size, 6)
})

test('a product without a photo is excluded entirely', () => {
	assert.strictEqual(byTitle(P.noPhoto), undefined, 'imageless rows never reach the catalog')
	assert.ok(getProductMap(db).some((r) => r.title === P.noPhoto), 'but they remain in product_map for the Route tab')
	assert.ok(view.products.every((p) => p.image_url), 'every listed product has a photo')
	assert.strictEqual(view.totals.with_image, view.totals.products)
})

test('an exact listing identity closes the post-import canonical-key gap without a DB write', () => {
	const identityDb = initDb(path.join(tmpDir, 'exact-image-identity.db'))
	const titles = ['Daisy Cross-Shop MagSafe Case One', 'Daisy Cross-Shop MagSafe Case Two']
	try {
		insertSupplierDirectoryRow(identityDb, { shop_name: 'Daisy Lab', stall: 'A2-88' })
		for (const title of titles) upsertProductMapRow(identityDb, { title, shop_name: 'Daisy Lab', stall: 'A2-88' })
		const addListing = identityDb.prepare(
			"INSERT INTO listings (listing_id, shop_id, title, primary_image_url, state) VALUES (?, ?, ?, ?, 'active')",
		)
		const addIdentity = identityDb.prepare(
			"INSERT INTO listing_phash (listing_id, phash, design_phash, sha, algo, canonical_key) VALUES (?, ?, ?, ?, 'dhash-17x16-v1', ?)",
		)
		for (let i = 0; i < titles.length; i++) {
			const listingId = 91001 + i
			addListing.run(listingId, `SHOP-${i}`, titles[i], `https://example.test/daisy-${i}.jpg`)
			addIdentity.run(listingId, '0'.repeat(64), '0'.repeat(64), `sha-${i}`, 'P-91001')
		}

		const before = getProductMap(identityDb)
		assert.ok(before.every((r) => !r.canonical_product_key), 'fixture reproduces freshly imported rows with no stored key')
		const resolver = routeDashboard.buildCatalogImageResolver(identityDb)
		const exact = resolver.resolve(routeDashboard.normalizeTitle(titles[0]), titles[0])
		assert.strictEqual(exact.canonical_product_key, 'P-91001', 'exact image resolution carries the listing identity')
		assert.strictEqual(exact.listing_id, 91001)
		assert.strictEqual(
			routeDashboard.buildProductImageMap(identityDb).get(routeDashboard.normalizeTitle(titles[0])),
			'https://example.test/daisy-0.jpg',
			'the legacy title→URL map contract is unchanged',
		)
		const projected = catalogView.buildCatalog(identityDb)
		assert.deepStrictEqual(projected.products.map((p) => p.canonical_product_key), ['P-91001', 'P-91001'])
		assert.deepStrictEqual(projected.products.map((p) => p.alias_count), [2, 2])
		assert.strictEqual(projected.supplier_product_groups.length, 1, 'both exact listing identities produce one drawer card')
		assert.strictEqual(projected.supplier_product_groups[0].listing_count, 2)
		assert.deepStrictEqual(getProductMap(identityDb), before, 'the fallback is projection-only; product_map was not backfilled or changed')
	} finally {
		identityDb.close()
	}
})

test('a supplier with one booth lends its stall — flagged as borrowed', () => {
	const p = byTitle(P.inferred)
	assert.strictEqual(p.stall, '', 'the product row itself still says nothing')
	assert.strictEqual(p.stall_effective, 'A2-29')
	assert.strictEqual(p.stall_source, 'directory', 'so the page can show it is not the row\'s own value')
	assert.strictEqual(p.location.building_id, 'tongxin')
	assert.strictEqual(p.location.floor, 2)
	assert.ok(!p.gaps.includes('no_stall'), 'and it no longer reads as a missing stall')
})

test('a supplier with two booths lends nothing', () => {
	// Sending a buyer to 5C26 when the product might be at 5C27 is worse than
	// telling them the stall is unknown.
	const p = byTitle(P.ambiguous)
	assert.strictEqual(p.stall_effective, '')
	assert.strictEqual(p.stall_source, '')
	assert.deepStrictEqual(p.supplier_stall_options, ['5C26', '5C27'], 'the choice is offered to the operator instead')
	assert.ok(p.gaps.includes('no_stall'))
	assert.strictEqual(p.location.located, false)
})

test("a product's own stall is never overwritten by the directory", () => {
	const p = byTitle(P.airpods)
	assert.strictEqual(p.stall_effective, '康乐北区5A40-42')
	assert.strictEqual(p.stall_source, 'product')
})

test('the supplier is matched to the directory case-insensitively', () => {
	// The fixture writes "han" against a directory row spelled "HAN". A literal
	// match would report the busiest supplier we have as unregistered.
	const p = byTitle(P.inferred)
	assert.strictEqual(p.shop_name, 'han')
	assert.strictEqual(p.supplier_in_directory, true)
	assert.ok(!p.gaps.includes('unlisted_supplier'))
})

test('a supplier nobody registered is flagged, a blank one is not', () => {
	assert.strictEqual(byTitle(P.ghost).supplier_in_directory, false)
	assert.ok(byTitle(P.ghost).gaps.includes('unlisted_supplier'))
	assert.strictEqual(byTitle(P.charm).supplier_in_directory, null, 'no supplier is a different problem, already reported')
	assert.deepStrictEqual(byTitle(P.charm).gaps.includes('unlisted_supplier'), false)
})

test('a stall a supplier does not have registered is reported as such', () => {
	assert.strictEqual(byTitle(P.airpods).supplier_stall_registered, true)
	assert.strictEqual(byTitle(P.ghost).supplier_stall_registered, false, 'X1 belongs to no directory row')
})

test('a charm resolves its shop, booth and price from the library', () => {
	const p = byTitle(P.charm)
	assert.strictEqual(p.product_type, 'charm')
	assert.strictEqual(p.charm_code, '2c666')
	assert.strictEqual(p.charm_known, true, 'the code was matched case-insensitively')
	assert.strictEqual(p.charm_shop, '彩虹')
	assert.strictEqual(p.charm_shop_source, 'charm_library', 'the row named no shop, so the library supplied it')
	assert.strictEqual(p.charm_stall, '2D21', 'and the charm-shop directory supplied the booth')
	assert.strictEqual(p.charm_cost, 3.5)
})

test('a unit cost sums the components that HAVE a price, and skips those that do not', () => {
	assert.strictEqual(byTitle(P.override).cost_total, 7.5, 'case 6 + grip 1.5')
	assert.strictEqual(byTitle(P.airpods).cost_total, 5, 'an unpriced grip is skipped, not added as 0')
	assert.strictEqual(byTitle(P.charm).cost_total, 3.5, "a charm's cost is its charm code's")
	assert.strictEqual(byTitle(P.inferred).cost_total, null, 'nothing priced at all is null, never 0')
})

test('a stored type overrides the title, and the page is told it was a person', () => {
	const p = byTitle(P.override)
	assert.strictEqual(p.product_type, 'airpods_case')
	assert.strictEqual(p.product_type_source, 'override')
	assert.strictEqual(byTitle(P.inferred).product_type_source, 'derived')
})

test('the derived types come out as expected across the fixture', () => {
	assert.strictEqual(byTitle(P.inferred).product_type, 'iphone_case')
	assert.strictEqual(byTitle(P.airpods).product_type, 'airpods_case')
	assert.strictEqual(byTitle(P.ambiguous).product_type, 'grip')
	assert.strictEqual(byTitle(P.ghost).product_type, 'other')
})

test('the gaps on each row are exactly the ones an operator has to fix', () => {
	assert.deepStrictEqual(byTitle(P.inferred).gaps, ['no_price'])
	assert.deepStrictEqual(byTitle(P.airpods).gaps, [], 'fully specified')
	assert.deepStrictEqual(byTitle(P.override).gaps, [], 'override is also fully specified')
	assert.deepStrictEqual(byTitle(P.ambiguous).gaps, ['no_stall'])
	assert.deepStrictEqual(byTitle(P.charm).gaps, ['no_supplier'])
	assert.deepStrictEqual(byTitle(P.ghost).gaps, ['unlisted_supplier', 'no_price'])
})

test('every listed product carries the photo the resolver returned', () => {
	assert.strictEqual(byTitle(P.airpods).image_url, `/api/route/image/${encodeURIComponent(P.airpods.toLowerCase())}`)
	assert.strictEqual(byTitle(P.airpods).image_approx, false)
	assert.ok(byTitle(P.inferred).image_url)
	assert.ok(!byTitle(P.inferred).gaps.includes('no_image'))
})

test('a missing photo store costs a thumbnail, never the whole page', () => {
	// The resolver scans the listing + receipt corpus. On a fresh database those
	// tables can be empty or absent; the catalog must still render.
	const bare = initDb(path.join(tmpDir, 'bare.db'))
	bare.exec('DROP TABLE IF EXISTS listings; DROP TABLE IF EXISTS receipts')
	const built = catalogView.buildCatalog(bare)
	assert.strictEqual(built.ok, true)
	assert.deepStrictEqual(built.products, [])
	bare.close()
})

group('Rollups the page renders from')

test('a supplier carries its product count, its priced count and its mix', () => {
	const han = view.suppliers.find((s) => s.shop_name === 'HAN')
	assert.strictEqual(han.product_count, 2, 'the inferred-stall case and the override both name HAN')
	assert.strictEqual(han.priced_count, 1, 'only the override has a case cost')
	assert.deepStrictEqual(han.by_type, { iphone_case: 1, airpods_case: 1 })
	assert.strictEqual(han.location.building_id, 'tongxin')
	assert.ok(han.key, 'every supplier carries a stable key the drawer can reopen by')
})

test("a shop with two booths reports its products once, not twice per booth", () => {
	// Counting the shop's products against every booth it holds would double the
	// catalog size on screen for no reason a reader could see.
	const both = view.suppliers.filter((s) => s.shop_name === 'TwoStall')
	assert.strictEqual(both.length, 2)
	assert.deepStrictEqual(both.map((s) => s.stall_count), [2, 2])
	assert.strictEqual(
		both.reduce((n, s) => n + s.product_count, 0),
		1,
		'one product, counted once across the two booths',
	)
	// Attribution is by supplier_key now: the product with a blank stall lands
	// on the shop's primary booth (first directory row), never on both.
	assert.strictEqual(both.filter((s) => s.product_count > 0).length, 1)
})

test('a supplier\'s product_count equals the products stamped with its key', () => {
	// The number in the Suppliers table and the list the drawer opens must be
	// the same set by construction — no client-side re-join allowed to drift.
	for (const s of view.suppliers) {
		const listed = view.products.filter((p) => p.supplier_key === s.key)
		assert.strictEqual(listed.length, s.product_count, `${s.shop_name} · ${s.stall}`)
		assert.strictEqual(listed.filter((p) => !p.gaps.includes('no_price')).length, s.priced_count)
	}
	const attributed = view.products.filter((p) => p.supplier_key).length
	assert.strictEqual(
		view.suppliers.reduce((n, s) => n + s.product_count, 0),
		attributed,
		'every attributed product is counted exactly once',
	)
})

test('canonical aliases collapse in supplier metrics without removing source rows', () => {
	const ids = getProductMap(db)
		.filter((r) => r.title === P.inferred || r.title === P.override)
		.map((r) => r.id)
	assert.strictEqual(ids.length, 2)
	const setKey = db.prepare('UPDATE product_map SET canonical_product_key = ? WHERE id = ?')
	try {
		for (const id of ids) setKey.run('P-test-shared', id)
		const grouped = build()
		const han = grouped.suppliers.find((s) => s.shop_name === 'HAN')
		const cards = grouped.supplier_product_groups.filter((g) => g.supplier_key === han.key)
		assert.strictEqual(han.product_count, 2, 'both underlying listing mappings remain')
		assert.strictEqual(grouped.products.filter((p) => p.supplier_key === han.key).length, 2, 'the raw projection also keeps both')
		assert.strictEqual(han.unique_product_count, 1, 'the Suppliers UI reports one physical product')
		assert.strictEqual(han.unique_priced_count, 1)
		assert.strictEqual(han.unique_ready_count, 1)
		assert.strictEqual(han.unique_cost_total, 7.5, 'one representative cost, never double-counted')
		assert.strictEqual(cards.length, 1)
		assert.strictEqual(cards[0].listing_count, 2)
		assert.deepStrictEqual(cards[0].product_ids.slice().sort((a, b) => a - b), ids.slice().sort((a, b) => a - b))
	} finally {
		for (const id of ids) setKey.run(null, id)
	}
})

test('a product names the supplier_key of the booth it is counted against', () => {
	const han = view.suppliers.find((s) => s.shop_name === 'HAN')
	const inferred = byTitle(P.inferred)
	assert.strictEqual(inferred.supplier_key, han.key)
	assert.strictEqual(byTitle(P.ghost).supplier_key, '', 'an unlisted shop has no directory key')
	assert.strictEqual(byTitle(P.charm).supplier_key, '', 'no shop → no key')
})

test('a supplier with nothing mapped to it reports zero, not undefined', () => {
	const idle = view.suppliers.find((s) => s.shop_name === '热点')
	assert.strictEqual(typeof idle.product_count, 'number')
	assert.deepStrictEqual(
		view.suppliers.every((s) => typeof s.product_count === 'number' && typeof s.priced_count === 'number'),
		true,
	)
})

test('a charm shop counts its charms, and a charm counts its products', () => {
	const shop = view.charm_shops.find((s) => s.shop_name === '彩虹')
	assert.strictEqual(shop.charm_count, 1)
	assert.strictEqual(shop.location.code, '2D21')
	const charm = view.charms.find((c) => c.code === '2C666')
	assert.strictEqual(charm.product_count, 1, 'the one product that bundles it')
	assert.strictEqual(charm.charm_stall, '2D21')
	assert.strictEqual(charm.cost, 3.5)
})

test('the headline totals agree with the rows they summarise', () => {
	const t = view.totals
	assert.strictEqual(t.suppliers, view.suppliers.length)
	assert.strictEqual(t.charm_shops, view.charm_shops.length)
	assert.strictEqual(t.charms, view.charms.length)
	assert.strictEqual(t.with_supplier, view.products.filter((p) => p.shop_name).length)
	assert.strictEqual(t.with_location, view.products.filter((p) => p.location.located).length)
	assert.strictEqual(t.with_image, t.products, 'with_image always equals products — imageless rows were dropped')
	assert.strictEqual(t.ready, 2, 'airpods + override are fully specified')
	assert.strictEqual(t.buildings, 2, '通信 and 康乐北区')
})

test('the facet counts are what the filter chips claim, per type and per gap', () => {
	// A chip that says "3" and filters to 5 rows is worse than no chip.
	for (const id of catalog.PRODUCT_TYPE_IDS) {
		assert.strictEqual(view.totals.by_type[id], view.products.filter((p) => p.product_type === id).length, id)
	}
	for (const id of catalog.GAP_TYPE_IDS) {
		assert.strictEqual(view.totals.by_gap[id], view.products.filter((p) => p.gaps.includes(id)).length, id)
	}
	assert.deepStrictEqual(view.totals.by_type, { iphone_case: 1, airpods_case: 2, apple_watch_band: 0, ipad_case: 0, grip: 1, charm: 1, other: 1 })
})

test('the payload ships the taxonomy it was built with', () => {
	// The page filters on these. Serving counts keyed on ids the page does not
	// know about would render chips that match nothing.
	assert.deepStrictEqual(view.product_types.map((t) => t.id), catalog.PRODUCT_TYPE_IDS)
	assert.deepStrictEqual(view.gap_types.map((g) => g.id), catalog.GAP_TYPE_IDS)
	assert.strictEqual(typeof view.generated_at, 'number')
})

group('The projection is read-only')

test('building the catalog twice changes nothing in the database', () => {
	// The guarantee the whole design rests on: Sourcing READS this and WRITES
	// through /api/route/*. A projection that mutated would give the second
	// truth this design exists to avoid.
	const before = JSON.stringify(getProductMap(db))
	const a = build()
	const b = build()
	assert.strictEqual(JSON.stringify(getProductMap(db)), before)
	delete a.generated_at
	delete b.generated_at
	assert.deepStrictEqual(a, b, 'and the projection itself is deterministic')
})

group('An override survives the Excel re-import')

test('a re-import keeps the operator\'s type, price and canonical link', () => {
	// The Product Map sheet has no product_type column, and never will — it is
	// the Chinese-language sheet the market suppliers are managed from. A
	// re-import that wiped the classification would silently undo every
	// correction an operator has ever made.
	setProductCost(db, { title: P.override, cost_case: 6 })
	// Shaped exactly as the Excel importer hands rows over: a title, a supplier,
	// a stall and the normalised key — and no column for anything the app owns.
	const sheetRow = (title, shop_name, stall) => ({ title, shop_name, stall, title_norm: title.replace(/\|/g, ',').replace(/\s+/g, ' ').toLowerCase() })
	replaceProductMap(db, [sheetRow(P.override, 'HAN', 'A2-29'), sheetRow(P.airpods, '热点', '康乐北区5A40-42')])
	const after = catalogView.buildCatalog(db, { imageResolver })
	const kept = after.products.find((p) => p.title === P.override)
	assert.strictEqual(kept.product_type, 'airpods_case')
	assert.strictEqual(kept.product_type_source, 'override')
	assert.strictEqual(kept.cost_case, 6, 'and the price the sheet does not carry')
})

test('clearing the override brings the derivation back', () => {
	const row = getProductMap(db).find((r) => r.title === P.override)
	updateProductMapRowById(db, { id: row.id, title: P.override, shop_name: 'HAN', stall: 'A2-29', product_type: '' })
	const after = catalogView.buildCatalog(db, { imageResolver })
	const cleared = after.products.find((p) => p.title === P.override)
	assert.strictEqual(cleared.product_type, 'iphone_case', 'derived from the title again')
	assert.strictEqual(cleared.product_type_source, 'derived')
})

// ════════════════════════════════════════════════════════════════════════════
// Part 6 · Who may see it
// ════════════════════════════════════════════════════════════════════════════
group('Permissions')

test('the catalog carries the permission of the data it projects', () => {
	// It is route master data, so it reads as route:read — NOT as the sourcing
	// library's sourcing:manage, which is a different job.
	assert.strictEqual(policy.requiredCapability('GET', '/api/sourcing/catalog'), 'route:read')
	assert.strictEqual(policy.requiredCapability('GET', '/api/sourcing/catalog/export.csv'), 'route:read')
})

test('the sourcing library catch-all still owns everything else under /api/sourcing', () => {
	// The catalog rule must sit ABOVE the catch-all, and must not have widened it.
	assert.strictEqual(policy.requiredCapability('GET', '/api/sourcing/suppliers'), 'sourcing:manage')
	assert.strictEqual(policy.requiredCapability('POST', '/api/sourcing/packages/upload'), 'sourcing:manage')
	assert.strictEqual(policy.requiredCapability('GET', '/api/sourcing/meta'), 'sourcing:manage')
})

test('the catalog is not writable through the sourcing path at all', () => {
	// Writes go to /api/route/*, which already requires route:catalog. A POST to
	// the projection falls through to the library's capability and finds no
	// handler — it must never be a second write path.
	assert.strictEqual(policy.requiredCapability('POST', '/api/sourcing/catalog'), 'sourcing:manage')
	assert.strictEqual(policy.requiredCapability('POST', '/api/route/product-map'), 'route:catalog')
	assert.strictEqual(policy.requiredCapability('PUT', '/api/route/product-map'), 'route:catalog')
	assert.strictEqual(policy.requiredCapability('DELETE', '/api/route/product-map'), 'route:catalog')
})

test('the employee can run the catalog; the shopper cannot', () => {
	assert.strictEqual(policy.authorizeApi('packer', 'GET', '/api/sourcing/catalog').allowed, true)
	assert.strictEqual(policy.authorizeApi('packer', 'POST', '/api/route/product-map').allowed, true)
	assert.strictEqual(policy.authorizeApi('owner', 'GET', '/api/sourcing/catalog').allowed, true)
	assert.strictEqual(policy.authorizeApi('shopper', 'GET', '/api/sourcing/catalog').allowed, false)
})

// ════════════════════════════════════════════════════════════════════════════
// Part 7 · The shipped page's side of the contract
// ════════════════════════════════════════════════════════════════════════════
group('public/sourcing.html')

const page = fs.readFileSync(path.resolve(__dirname, '../public/sourcing.html'), 'utf8')

test('the page reads the projection and writes through the route endpoints', () => {
	assert.ok(page.includes("api('/api/sourcing/catalog')"), 'it loads the read model')
	assert.ok(page.includes('/api/route/product-map'), 'products are written where products live')
	assert.ok(page.includes('/api/route/suppliers'), 'suppliers likewise')
	assert.ok(page.includes('/api/route/charm-shops'), 'and charm shops')
	assert.ok(!/api\/sourcing\/catalog['"`]\s*,\s*\{\s*method/.test(page), 'and nothing is POSTed at the projection')
})

test('generated markup carries no inline event handlers', () => {
	// Every row is built from operator-entered text (shop names, titles). Inline
	// handlers in that markup are one apostrophe away from a broken page and one
	// quote away from an injection, which is why the page delegates on data-act.
	assert.ok(!/\son(?:click|change|input|submit|error|load)\s*=/i.test(page), 'no inline handlers anywhere in the page')
	assert.ok(page.includes('data-act'), 'interaction is delegated instead')
	assert.ok(/addEventListener\(\s*'error'/.test(page), 'broken images are handled by a capture-phase listener')
	assert.ok(page.includes("img.closest('.pcard, .prow, tr')"), 'and broken thumbs remove their host card/row')
})

test('the page escapes what it interpolates', () => {
	assert.strictEqual((page.match(/^\s*const esc = /gm) || []).length, 1, 'there is exactly one escaper')
	assert.ok(/&amp;|&lt;|&quot;/.test(page), 'and it maps the HTML metacharacters')
	// A shop name reaches the DOM through several renderers; spot-check that the
	// hottest ones go through it rather than concatenating raw values.
	assert.ok(/esc\(p\.title\)/.test(page), 'product titles are escaped')
	assert.ok(/esc\(s\.shop_name\)/.test(page), 'supplier names are escaped')
})

test('editing controls are gated on the capability the write endpoints require', () => {
	assert.ok(page.includes("can('route:catalog')"), 'the page asks for the same capability the API enforces')
	assert.ok(page.includes('CAN_EDIT_CATALOG'), 'and hides the controls that would 403 without it')
})

test('the page and the server agree on the unknown-floor sentinel', () => {
	// The page prints a floor only when it is not the sentinel. A stale copy
	// would put "F999" on every unsurveyed market.
	const m = /const UNKNOWN_FLOOR = (\d+)/.exec(page)
	assert.ok(m, 'the page declares the sentinel')
	assert.strictEqual(Number(m[1]), stallLocation.UNKNOWN_FLOOR)
})

test('the taxonomy is never hard-coded in the page', () => {
	// Types and gaps are served by /api/sourcing/catalog. A copy in the page
	// would go stale the moment the taxonomy grows.
	assert.ok(!/'iphone_case'\s*,\s*'airpods_case'/.test(page), 'no second copy of the type list')
	assert.ok(page.includes('META.product_types'), 'the page renders the served taxonomy')
	assert.ok(page.includes('META.gap_types'))
})

test('the Suppliers products column aligns the count, not the priced chip', () => {
	// The count is what an operator scans down the column. A variable-width
	// "N/M Priced" pill after the number used to push every count to a
	// different x-position; the countcell grid keeps the number in a fixed slot.
	// Markets must also share ONE table, otherwise each table independently
	// chooses where Products, Mall, Address and Notes begin.
	assert.ok(page.includes('countcell'), 'fixed-geometry count cell')
	assert.ok(page.includes('function productCountCell'), 'dedicated renderer for the products column')
	assert.ok(!/\$\{s\.product_count\}\$\{priced\}/.test(page), 'no longer concatenates count + priced pill')
	assert.ok(page.includes('supplierTableHtml(tableGroups)'), 'all markets render through one supplier table')
	assert.ok(page.includes('class="market-row"'), 'market grouping is preserved as full-width rows')
	assert.ok(page.includes('dtable supplier-table'), 'the shared table has stable column geometry')
	assert.ok(!page.includes('supplierTableHtml(g.rows)'), 'no independently sized table remains per market')
})

test('a supplier row opens a detail drawer of its products', () => {
	assert.ok(page.includes('id="supDrawer"'), 'the drawer markup is present')
	assert.ok(page.includes("data-act=\"sup-open\""), 'supplier rows are clickable')
	assert.ok(page.includes('function openSupplierDrawer'), 'click opens the drawer')
	assert.ok(page.includes('function renderSupplierDrawer'), 'and renders the product list')
	assert.ok(page.includes('supplierProductGroupsFor(s.key)'), 'the list uses the server\'s per-supplier physical-product groups')
	assert.ok(page.includes('data-act="sup-add-product"'), 'CRUD: add a product for this supplier')
	assert.ok(page.includes('openProductModal(null, { shop_name:'), 'add pre-fills shop and stall')
})

test('the supplier drawer paints one card and one image per canonical product', () => {
	assert.ok(page.includes('CAT.supplier_product_groups'), 'the page consumes the read-only canonical grouping')
	assert.ok(page.includes('groups.map(supplierProductRowHtml)'), 'one renderer invocation per physical-product group')
	assert.ok(page.includes('const p = group.representative'), 'one deterministic representative supplies the card')
	assert.ok(page.includes('group.aliases.length > 1'), 'grouped listings are called out rather than silently discarded')
	assert.ok(page.includes('group.aliases.some((p)'), 'search still finds every hidden listing title')
	const cardStart = page.indexOf('function supplierProductRowHtml(group)')
	const aliasesStart = page.indexOf('function supplierAliasDetailsHtml(group)')
	const aliasEnd = page.indexOf('function toggleSupplierListingDetails', aliasesStart)
	assert.ok(cardStart >= 0 && aliasesStart > cardStart && aliasEnd > aliasesStart)
	assert.strictEqual((page.slice(cardStart, aliasesStart).match(/thumbHtml\(p\)/g) || []).length, 1, 'a grouped card renders exactly one image')
	assert.ok(!page.slice(aliasesStart, aliasEnd).includes('thumbHtml'), 'the collapsed source-record manager never repeats product images')
})

test('grouped source listings remain individually manageable without automatic writes', () => {
	assert.ok(page.includes('function supplierAliasDetailsHtml(group)'), 'grouped source records have an explicit disclosure')
	assert.ok(page.includes('actionsHtml(alias.id)'), 'every underlying mapping retains edit/delete CRUD')
	assert.ok(page.includes("data-act=\"sup-toggle-listings\""), 'the aggregate card opens that disclosure')
	assert.ok(page.includes("p.canonical_product_key ? `canonical:${p.canonical_product_key}` : `row:${p.id}`"), 'the rolling-deploy fallback is precision-first')
})

test('supplier product prices explicitly itemise the charm before the total', () => {
	assert.ok(page.includes("price(p.cost_case, t('priceCase'))"), 'case cost has its own slot')
	assert.ok(page.includes("price(p.cost_grip, t('priceGrip'))"), 'grip cost has its own slot')
	assert.ok(page.includes("price(p.charm_cost, t('priceCharm'), 'charm')"), 'charm cost is no longer hidden in metadata')
	assert.ok(page.includes("price(p.cost_total, t('priceTotal'), 'total', totalTitle)"), 'the final value is labelled Total')
	assert.ok(page.includes('Case + Grip + Charm = Total'), 'the four permanent slots document their arithmetic')
	assert.ok(page.includes("const charmDetails = charmParts.length"), 'charm identity remains visible below the title')
	assert.ok(page.includes("const charmParts = []"), 'the identity line is rendered separately from pricing')
})

// ── Runner ──────────────────────────────────────────────────────────────────
console.log(`\n${BOLD}Sourcing Catalog — products, suppliers, locations and prices${RESET}\n`)
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
try {
	db.close()
} catch {
	/* already closed */
}
try {
	fs.rmSync(tmpDir, { recursive: true, force: true })
} catch {
	/* Windows can hold the WAL briefly; a temp dir left behind is not a failure */
}
if (failures.length) {
	console.log(`\n${RED}${BOLD}Failures${RESET}`)
	for (const f of failures) console.log(`\n  ${RED}${f.name}${RESET}\n  ${f.err.message.split('\n').join('\n  ')}`)
}
console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)
