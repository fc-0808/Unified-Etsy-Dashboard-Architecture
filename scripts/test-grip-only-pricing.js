'use strict'

/**
 * Tests for the "Grip Only" default-price link on the iPhone case line.
 *
 * WHY THIS FILE EXISTS
 * ----------------------------------------------------------------------------
 * The business decided the "Grip Only" bundle must always default to the same
 * price as "Case Only" — the grip clip costs nothing extra to fulfil, so the
 * two bundles are priced identically. That is expressed as a declared LINK on
 * the product-type registry (`priceLinks`), resolved in `resolveDefaultPrices`
 * AFTER the normal shop-vs-sheet precedence has already picked "Case Only"'s
 * value, so it:
 *   · wins over the shop's own historical "Grip Only" listings (which may
 *     have drifted from "Case Only" before this rule existed),
 *   · wins over the master sheet's "Grip Only" row,
 *   · still tracks "Case Only" automatically if that price is ever revised —
 *     no second edit, no stale hardcoded figure,
 *   · never fires for a currency/shop where "Case Only" itself has no price
 *     (nothing to link to), and
 *   · never touches a product line that has no "Grip Only" style at all
 *     (AirPods case, Apple Watch band).
 *
 * Pure unit tests: no network, no real database, no workbook. The one DB-shaped
 * dependency (the shop's cached prices) is a two-line stub, because the
 * behaviour under test is the LINK, not the SQL.
 *
 * Run: `node scripts/test-grip-only-pricing.js`   (exit 0 = pass, 1 = regression)
 */

const assert = require('assert')

const productTypes = require('../src/listings/product-types')
const { resolveDefaultPrices, getShopCurrentStylePrices } = require('../src/listings/shop-prices')

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m'
let passed = 0, failed = 0
const failures = []
const queue = []
const group = (name) => queue.push({ group: name })
const test = (name, fn) => queue.push({ name, fn })

const CASE = 'iphone_case'
const emptyDb = { prepare: () => ({ all: () => [] }) }

/** A stub cached-inventory row for `getShopCurrentStylePrices`. */
function shopRow(style, price, currency = 'HKD') {
	return {
		price_amount: price,
		price_currency: currency,
		listing_id: 1,
		property_values: JSON.stringify([{ property_id: productTypes.PROP_CHOICE, property_name: 'Styles', values: [style] }]),
	}
}

// ════════════════════════════════════════════════════════════════════════════
// Part 1 · The link is declared on the registry
// ════════════════════════════════════════════════════════════════════════════
group('The rule is declared once, on the iPhone case registry entry')

test('an iPhone case links "Grip Only" to "Case Only"', () => {
	assert.deepStrictEqual(productTypes.priceLinksFor(CASE), { 'Grip Only': 'Case Only' })
})

test('a line with no "Grip Only" style declares no link at all', () => {
	assert.deepStrictEqual(productTypes.priceLinksFor('airpods_case'), {})
	assert.deepStrictEqual(productTypes.priceLinksFor('apple_watch_band'), {})
})

test('an unknown product type is safe to query (defaults to the iPhone case link)', () => {
	assert.deepStrictEqual(productTypes.priceLinksFor(undefined), { 'Grip Only': 'Case Only' })
})

// ════════════════════════════════════════════════════════════════════════════
// Part 2 · The link wins over both sources, for both live currencies
// ════════════════════════════════════════════════════════════════════════════
group('"Grip Only" always resolves to "Case Only"\'s price')

test('HKD: with no shop data, "Grip Only" takes the sheet\'s "Case Only" price (261.86), not its own sheet row', () => {
	const sheetPrices = { 'Case Only': 261.86, 'Grip Only': 199.99 } // sheet row deliberately disagrees
	const resolved = resolveDefaultPrices({ db: emptyDb, shopId: 'ShopA', sheetPrices, productType: CASE })
	assert.strictEqual(resolved.prices['Case Only'], 261.86)
	assert.strictEqual(resolved.prices['Grip Only'], 261.86, 'linked to Case Only, not the sheet\'s own 199.99')
	assert.strictEqual(resolved.source['Grip Only'], resolved.source['Case Only'], 'same provenance as its anchor')
})

test('CAD: with no shop data, "Grip Only" takes the sheet\'s "Case Only" price (47.23)', () => {
	const sheetPrices = { 'Case Only': 47.23, 'Grip Only': 39.99 }
	const resolved = resolveDefaultPrices({ db: emptyDb, shopId: 'ShopA', sheetPrices, productType: CASE })
	assert.strictEqual(resolved.prices['Case Only'], 47.23)
	assert.strictEqual(resolved.prices['Grip Only'], 47.23)
})

test('a shop that already sells "Grip Only" at a different price is overridden to match "Case Only"', () => {
	// This is the historical-drift case: 162 live listings already exist and
	// their "Grip Only" median happens to differ from "Case Only". The rule
	// must win even though the shop's own price would normally take priority.
	const db = { prepare: () => ({ all: () => [shopRow('Case Only', 261.86), shopRow('Grip Only', 240.00)] }) }
	const seen = getShopCurrentStylePrices(db, 'ShopA', CASE)
	assert.strictEqual(seen.prices['Grip Only'], 240.00, 'the cache IS read (so this is a real contest)')

	const resolved = resolveDefaultPrices({ db, shopId: 'ShopA', sheetPrices: {}, productType: CASE })
	assert.strictEqual(resolved.prices['Case Only'], 261.86)
	assert.strictEqual(resolved.prices['Grip Only'], 261.86, 'snapped to Case Only, not the shop\'s own 240.00')
	assert.strictEqual(resolved.source['Grip Only'], 'shop')
})

test('a shop already priced correctly (Grip Only === Case Only) is left unchanged', () => {
	const db = { prepare: () => ({ all: () => [shopRow('Case Only', 261.86), shopRow('Grip Only', 261.86)] }) }
	const resolved = resolveDefaultPrices({ db, shopId: 'ShopA', sheetPrices: {}, productType: CASE })
	assert.strictEqual(resolved.prices['Grip Only'], 261.86)
})

test('every other style is untouched by the link', () => {
	const sheetPrices = {
		'Case+Grip+Charm': 409.89, 'Case+Grip': 350.11, 'Case+Charm': 350.11,
		'Case Only': 261.86, 'Grip Only': 999, 'Charm Only': 113.82,
	}
	const resolved = resolveDefaultPrices({ db: emptyDb, shopId: 'ShopA', sheetPrices, productType: CASE })
	assert.strictEqual(resolved.prices['Case+Grip+Charm'], 409.89)
	assert.strictEqual(resolved.prices['Case+Grip'], 350.11)
	assert.strictEqual(resolved.prices['Case+Charm'], 350.11)
	assert.strictEqual(resolved.prices['Charm Only'], 113.82)
	assert.strictEqual(resolved.prices['Grip Only'], 261.86)
})

// ════════════════════════════════════════════════════════════════════════════
// Part 3 · Edge cases the link must not break
// ════════════════════════════════════════════════════════════════════════════
group('The link degrades safely when there is nothing to link to')

test('if "Case Only" itself has no price anywhere, "Grip Only" is left unresolved (not zeroed)', () => {
	const resolved = resolveDefaultPrices({ db: emptyDb, shopId: 'ShopA', sheetPrices: { 'Grip Only': 55 }, productType: CASE })
	assert.strictEqual(resolved.prices['Case Only'], undefined, 'no anchor value exists')
	assert.strictEqual(resolved.prices['Grip Only'], 55, 'falls back to its own resolved value instead of being blanked')
})

test('a product line with no "Grip Only" style is completely unaffected', () => {
	const resolved = resolveDefaultPrices({
		db: emptyDb, shopId: 'ShopA',
		sheetPrices: { 'Case Only': 100, 'Charm Only': 50 },
		productType: 'airpods_case',
	})
	assert.strictEqual(resolved.prices['Case Only'], 100)
	assert.strictEqual(resolved.prices['Charm Only'], 50)
	assert.strictEqual(Object.prototype.hasOwnProperty.call(resolved.prices, 'Grip Only'), false)
})

test('the Apple Watch band\'s own price book is untouched by the (absent) link', () => {
	const resolved = resolveDefaultPrices({
		db: emptyDb, shopId: 'ShopA',
		sheetPrices: { '38/40/41mm': 350.11, '42mm [Series 10/11]': 350.11, '42/44/45/46/49mm': 350.11 },
		productType: 'apple_watch_band',
	})
	assert.strictEqual(resolved.prices['38/40/41mm'], 350.11)
	assert.strictEqual(resolved.prices['42mm [Series 10/11]'], 350.11)
	assert.strictEqual(resolved.prices['42/44/45/46/49mm'], 350.11)
})

// ── Runner ──────────────────────────────────────────────────────────────────
console.log(`\n${BOLD}Grip Only pricing — always matches Case Only${RESET}\n`)
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
