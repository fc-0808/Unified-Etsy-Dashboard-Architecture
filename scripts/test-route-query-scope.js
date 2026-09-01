'use strict'

/**
 * Route dashboard backend query-scope contract.
 *
 * Proves, without wall-clock assertions, that:
 *   - every hot auxiliary read is limited to current receipt/item/listing sets;
 *   - scopes larger than 500 are split into batches with <= 500 bindings;
 *   - receipt transaction JSON is parsed once per selected receipt;
 *   - optional map-helper scopes preserve unscoped behaviour and make [] safe;
 *   - the HTTP endpoint keeps its payload contract and exposes timing/row metadata.
 *
 * Run: node scripts/test-route-query-scope.js
 */

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const Database = require('better-sqlite3')
const routeDashboard = require('../src/route/dashboard')
const dbSetup = require('../src/db/setup')

const TOTAL = 503
const BASE_RECEIPT = 100000
const BASE_LISTING = 200000
const OUTSIDE_ID = 999999
const OUTSIDE_KEY = 'outside-item-key'
const OUTSIDE_NORM = 'outside product'

let passed = 0
function test(name, fn) {
	fn()
	passed += 1
	console.log(`  ok  — ${name}`)
}

function makeDb() {
	const db = new Database(':memory:')
	db.exec(`
    CREATE TABLE shops (shop_id TEXT PRIMARY KEY, shop_name TEXT);
    CREATE TABLE receipts (
      receipt_id INTEGER PRIMARY KEY, shop_id TEXT, name TEXT, buyer_email TEXT,
      buyer_user_id INTEGER, message_from_buyer TEXT, team_note TEXT,
      shipping_country_iso TEXT, etsy_created_at INTEGER, all_transactions TEXT,
      is_paid INTEGER DEFAULT 1, is_shipped INTEGER DEFAULT 0, status TEXT,
      needs_purchase_at INTEGER, tracking_code TEXT, carrier_confirmed_at INTEGER,
      shipment_notified_at INTEGER, packaged_at INTEGER, archived_at INTEGER
    );
    CREATE TABLE route_manual_items (
      id INTEGER PRIMARY KEY, receipt_id INTEGER, item_key TEXT, title TEXT,
      phone_model TEXT, style TEXT, quantity INTEGER, shop_name TEXT,
      listing_id INTEGER, image_url TEXT, image_data BLOB, image_mime TEXT,
      source TEXT, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE listing_images (listing_id INTEGER, url TEXT);
    CREATE TABLE listings (
      listing_id INTEGER PRIMARY KEY, title TEXT, primary_image_url TEXT
    );
    CREATE TABLE listing_style_images (
      id INTEGER PRIMARY KEY, listing_id INTEGER, style_key TEXT, style_value TEXT,
      image_data BLOB, image_mime TEXT, note TEXT, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE listing_variation_images (
      listing_id INTEGER, style_key TEXT, style_value TEXT, image_id INTEGER,
      url TEXT, value_id INTEGER, property_id INTEGER, cached_at INTEGER
    );
    CREATE TABLE route_assignments (
      receipt_id INTEGER, item_key TEXT, title TEXT, charm_code TEXT, charm_shop TEXT,
      status_case TEXT, status_grip TEXT, status_charm TEXT, excluded INTEGER,
      dismissed_at INTEGER, supplier_shop_override TEXT, supplier_stall_override TEXT,
      updated_at INTEGER, PRIMARY KEY (receipt_id, item_key)
    );
    CREATE TABLE product_assignments (
      item_key TEXT PRIMARY KEY, title TEXT, supplier_shop TEXT, supplier_stall TEXT,
      charm_code TEXT, charm_shop TEXT, updated_at INTEGER
    );
    CREATE TABLE order_issues (
      id INTEGER PRIMARY KEY, receipt_id INTEGER, item_key TEXT, listing_id INTEGER,
      title TEXT, phone_model TEXT, issue_type TEXT, status TEXT, note TEXT,
      created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE order_exchanges (
      id INTEGER PRIMARY KEY, receipt_id INTEGER, item_key TEXT, listing_id INTEGER,
      title TEXT, have_model TEXT, need_model TEXT, components TEXT,
      supplier_shop TEXT, supplier_stall TEXT, status TEXT, note TEXT,
      created_at INTEGER, updated_at INTEGER, done_at INTEGER
    );
    CREATE TABLE order_line_substitutions (
      id INTEGER PRIMARY KEY, receipt_id INTEGER, item_key TEXT, original_title TEXT,
      new_title TEXT, new_style TEXT, new_phone_model TEXT, source TEXT,
      source_listing_id INTEGER, image_url TEXT, image_data BLOB, image_mime TEXT,
      note TEXT, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE product_map (
      id INTEGER PRIMARY KEY, title_norm TEXT UNIQUE, title TEXT, shop_name TEXT,
      stall TEXT, charm_shop TEXT, charm_code TEXT, canonical_product_key TEXT,
      sort_order INTEGER, updated_at INTEGER
    );
    CREATE TABLE listing_phash (
      listing_id INTEGER PRIMARY KEY, phash TEXT, canonical_key TEXT
    );
    CREATE TABLE product_merges (
      listing_a INTEGER, listing_b INTEGER, PRIMARY KEY (listing_a, listing_b)
    );
    CREATE TABLE charm_library (
      code TEXT PRIMARY KEY, default_charm_shop TEXT, sort_order INTEGER
    );
  `)
	return db
}

function titleAt(index) {
	return `Scoped Product ${index}`
}

function keyAt(index) {
	return routeDashboard.lineItemKey(titleAt(index), BASE_LISTING + index)
}

function seed(db) {
	const now = Math.floor(Date.now() / 1000)
	const receiptIds = []
	db.prepare('INSERT INTO shops (shop_id, shop_name) VALUES (?, ?)').run('SCOPE_SHOP', 'Scope Shop')
	const insertReceipt = db.prepare(`
    INSERT INTO receipts (
      receipt_id, shop_id, name, etsy_created_at, all_transactions,
      is_paid, is_shipped, status
    ) VALUES (?, 'SCOPE_SHOP', ?, ?, ?, 1, 0, 'Paid')
  `)
	const insertImage = db.prepare('INSERT INTO listing_images (listing_id, url) VALUES (?, ?)')
	db.transaction(() => {
		for (let i = 0; i < TOTAL; i += 1) {
			const receiptId = BASE_RECEIPT + i
			const listingId = BASE_LISTING + i
			receiptIds.push(receiptId)
			insertReceipt.run(
				receiptId,
				`Buyer ${i}`,
				now - i,
				JSON.stringify([{
					title: titleAt(i),
					listing_id: listingId,
					quantity: 1,
					variations: [
						{ formatted_name: 'Phone Model', formatted_value: 'iPhone 16' },
						{ formatted_name: 'Style', formatted_value: 'Case Only' },
					],
				}]),
			)
			insertImage.run(listingId, `https://img.example/${listingId}.jpg`)
		}
	})()

	// A paid, recent order that would leak into an unscoped build.
	insertReceipt.run(
		OUTSIDE_ID,
		'Outside buyer',
		now,
		JSON.stringify([{ title: 'Outside Product', listing_id: OUTSIDE_ID, quantity: 1, variations: [] }]),
	)
	insertImage.run(OUTSIDE_ID, 'https://img.example/outside.jpg')

	const replacementTitle = 'Scoped Replacement Product'
	const replacementListing = 700001
	const originalKey = keyAt(0)
	const replacementKey = routeDashboard.lineItemKey(replacementTitle, replacementListing)
	insertImage.run(replacementListing, 'https://img.example/replacement.jpg')
	db.prepare(`
    INSERT INTO order_line_substitutions (
      id, receipt_id, item_key, original_title, new_title, new_style,
      new_phone_model, source, source_listing_id, image_url, image_data,
      image_mime, note, created_at, updated_at
    ) VALUES (1, ?, ?, ?, ?, 'Case Only', 'iPhone 16', 'catalog', ?, '', NULL, '', '', ?, ?)
  `).run(BASE_RECEIPT, originalKey, titleAt(0), replacementTitle, replacementListing, now, now)
	db.prepare(`
    INSERT INTO route_assignments (
      receipt_id, item_key, title, status_case, status_grip, status_charm,
      excluded, dismissed_at, supplier_shop_override, supplier_stall_override,
      charm_code, charm_shop, updated_at
    ) VALUES (?, ?, ?, 'Purchased', 'Pending', 'Pending', 0, NULL, '', '', '', '', ?)
  `).run(BASE_RECEIPT, originalKey, titleAt(0), now)
	db.prepare(`
    INSERT INTO product_assignments (
      item_key, title, supplier_shop, supplier_stall, charm_code, charm_shop, updated_at
    ) VALUES (?, ?, 'Scoped Supplier', 'A-01', '', '', ?)
  `).run(replacementKey, replacementTitle, now)
	db.prepare(`
    INSERT INTO product_map (
      id, title_norm, title, shop_name, stall, charm_shop, charm_code,
      canonical_product_key, sort_order, updated_at
    ) VALUES (1, ?, ?, 'Map Supplier', 'B-02', '', '', 'canon:replacement', 1, ?)
  `).run(routeDashboard.normalizeTitle(replacementTitle), replacementTitle, now)
	db.prepare(
		'INSERT INTO listing_phash (listing_id, phash, canonical_key) VALUES (?, ?, ?)',
	).run(replacementListing, 'hash-replacement', 'canon:replacement')

	// A custom switch may inherit the original canonical identity only after an
	// explicit product_merges edge says the operator declared it the same product.
	const customIndex = 1
	const customListing = BASE_LISTING + customIndex
	db.prepare(`
    INSERT INTO order_line_substitutions (
      id, receipt_id, item_key, original_title, new_title, new_style,
      new_phone_model, source, source_listing_id, image_url, image_data,
      image_mime, note, created_at, updated_at
    ) VALUES (2, ?, ?, ?, 'Custom Buyer Switch', 'Case Only', 'iPhone 16',
              'custom', NULL, '', NULL, '', '', ?, ?)
  `).run(BASE_RECEIPT + customIndex, keyAt(customIndex), titleAt(customIndex), now, now)
	db.prepare(
		'INSERT INTO listing_phash (listing_id, phash, canonical_key) VALUES (?, ?, ?)',
	).run(customListing, 'hash-custom-original', 'canon:operator-merge')
	db.prepare('INSERT INTO product_merges (listing_a, listing_b) VALUES (?, ?)')
		.run(customListing, 888888)

	// Current issue/exchange rows prove the scoped maps still feed row semantics.
	db.prepare(`
    INSERT INTO order_issues (
      id, receipt_id, item_key, listing_id, title, phone_model, issue_type,
      status, note, created_at, updated_at
    ) VALUES (1, ?, ?, ?, ?, 'iPhone 16', 'other', 'open', '', ?, ?)
  `).run(BASE_RECEIPT + 2, keyAt(2), BASE_LISTING + 2, titleAt(2), now, now)
	db.prepare(`
    INSERT INTO order_exchanges (
      id, receipt_id, item_key, listing_id, title, have_model, need_model,
      components, supplier_shop, supplier_stall, status, note, created_at, updated_at
    ) VALUES (1, ?, ?, ?, ?, 'iPhone 15', 'iPhone 16', 'case',
              'Scoped Supplier', 'A-01', 'open', '', ?, ?)
  `).run(BASE_RECEIPT + 3, keyAt(3), BASE_LISTING + 3, titleAt(3), now, now)

	// Out-of-scope sentinels in every hot table. A scoped query must never bind
	// their receipt/listing/item/title identity.
	db.prepare(`
    INSERT INTO route_assignments (
      receipt_id, item_key, title, status_case, status_grip, status_charm,
      excluded, supplier_shop_override, supplier_stall_override, charm_code,
      charm_shop, updated_at
    ) VALUES (?, ?, 'Outside', 'Pending', 'Pending', 'Pending', 0, '', '', '', '', ?)
  `).run(OUTSIDE_ID, OUTSIDE_KEY, now)
	db.prepare(`
    INSERT INTO product_assignments (
      item_key, title, supplier_shop, supplier_stall, charm_code, charm_shop, updated_at
    ) VALUES (?, 'Outside', 'Outside Supplier', '', '', '', ?)
  `).run(OUTSIDE_KEY, now)
	db.prepare(`
    INSERT INTO order_issues (
      id, receipt_id, item_key, issue_type, status, created_at, updated_at
    ) VALUES (2, ?, ?, 'other', 'open', ?, ?)
  `).run(OUTSIDE_ID, OUTSIDE_KEY, now, now)
	db.prepare(`
    INSERT INTO order_exchanges (
      id, receipt_id, item_key, status, created_at, updated_at
    ) VALUES (2, ?, ?, 'open', ?, ?)
  `).run(OUTSIDE_ID, OUTSIDE_KEY, now, now)
	db.prepare(`
    INSERT INTO order_line_substitutions (
      id, receipt_id, item_key, original_title, new_title, source,
      created_at, updated_at
    ) VALUES (3, ?, ?, 'Outside', 'Outside Replacement', 'catalog', ?, ?)
  `).run(OUTSIDE_ID, OUTSIDE_KEY, now, now)
	db.prepare(`
    INSERT INTO product_map (
      id, title_norm, title, sort_order, updated_at
    ) VALUES (2, ?, 'Outside Product', 2, ?)
  `).run(OUTSIDE_NORM, now)
	db.prepare(
		'INSERT INTO listing_phash (listing_id, phash, canonical_key) VALUES (?, ?, ?)',
	).run(OUTSIDE_ID, 'hash-outside', 'canon:outside')
	db.prepare('INSERT INTO product_merges (listing_a, listing_b) VALUES (?, ?)')
		.run(900001, 900002)
	db.prepare(`
    INSERT INTO listing_style_images (
      id, listing_id, style_key, style_value, image_data, image_mime, created_at, updated_at
    ) VALUES (1, ?, 'case only', 'Case Only', X'01', 'image/png', ?, ?)
  `).run(OUTSIDE_ID, now, now)
	db.prepare(`
    INSERT INTO listing_variation_images (
      listing_id, style_key, style_value, image_id, url, value_id, cached_at
    ) VALUES (?, 'case only', 'Case Only', 1, 'https://img.example/outside-variation.jpg', 1, ?)
  `).run(OUTSIDE_ID, now)

	return { receiptIds, replacementTitle, replacementListing }
}

function boundValues(args) {
	if (args.length === 1 && Array.isArray(args[0])) return args[0]
	if (args.length === 1 && args[0] && typeof args[0] === 'object') return Object.values(args[0])
	return args
}

function traceReads(rawDb) {
	const reads = []
	const db = new Proxy(rawDb, {
		get(target, prop) {
			if (prop === 'prepare') {
				return (sql) => {
					const statement = target.prepare(sql)
					return new Proxy(statement, {
						get(stmt, method) {
							if (method === 'all') {
								return (...args) => {
									reads.push({ sql: String(sql), values: boundValues(args) })
									return stmt.all(...args)
								}
							}
							const value = stmt[method]
							return typeof value === 'function' ? value.bind(stmt) : value
						},
					})
				}
			}
			const value = target[prop]
			return typeof value === 'function' ? value.bind(target) : value
		},
	})
	return { db, reads }
}

const db = makeDb()
const seeded = seed(db)
const traced = traceReads(db)

let parsedReceiptPayloads = 0
const originalJsonParse = JSON.parse
JSON.parse = function countedJsonParse(value, ...rest) {
	if (typeof value === 'string' && value.includes('"Scoped Product ')) {
		parsedReceiptPayloads += 1
	}
	return originalJsonParse.call(JSON, value, ...rest)
}

let rows
try {
	rows = routeDashboard.buildRouteRows(traced.db, {}, {
		receipt_ids: seeded.receiptIds,
		include_manual: false,
		include_issues: true,
		enrich_supplier: false,
	})
} finally {
	JSON.parse = originalJsonParse
}

console.log('Route query-scope contract\n')

test('explicit receipt scope returns only the requested 503 rows', () => {
	assert.strictEqual(rows.length, TOTAL)
	assert.ok(rows.every((row) => row.receipt_id !== OUTSIDE_ID))
})

test('each selected receipt transaction payload is parsed exactly once', () => {
	assert.strictEqual(parsedReceiptPayloads, TOTAL)
})

test('switch image/default and canonical identity semantics survive scoping', () => {
	const catalogSwitch = rows.find((row) => row.receipt_id === BASE_RECEIPT)
	assert.strictEqual(catalogSwitch.title, seeded.replacementTitle)
	assert.strictEqual(catalogSwitch.product_listing_id, seeded.replacementListing)
	assert.strictEqual(catalogSwitch.image_url, 'https://img.example/replacement.jpg')
	assert.strictEqual(catalogSwitch.status_case, 'Purchased')
	assert.strictEqual(catalogSwitch.supplier_shop, 'Scoped Supplier')
	assert.strictEqual(catalogSwitch.product_key, 'canon:replacement')

	const customSwitch = rows.find((row) => row.receipt_id === BASE_RECEIPT + 1)
	assert.strictEqual(customSwitch.title, 'Custom Buyer Switch')
	assert.strictEqual(customSwitch.product_key, 'canon:operator-merge')
	assert.strictEqual(rows.find((row) => row.receipt_id === BASE_RECEIPT + 2).has_issue, 1)
	assert.strictEqual(rows.find((row) => row.receipt_id === BASE_RECEIPT + 3).needs_exchange, true)
})

const hotReads = [
	{ name: 'receipt selection', match: /FROM\s+receipts\s+r\b/i, scope: /r\.receipt_id\s+IN\s*\(/i },
	{ name: 'route assignments', match: /FROM\s+route_assignments\b/i, scope: /receipt_id\s+IN\s*\(/i },
	{ name: 'product assignments', match: /FROM\s+product_assignments\b/i, scope: /item_key\s+IN\s*\(/i },
	{ name: 'open issues', match: /FROM\s+order_issues\b/i, scope: /receipt_id\s+IN\s*\(/i },
	{ name: 'open exchanges', match: /FROM\s+order_exchanges\b/i, scope: /receipt_id\s+IN\s*\(/i },
	{ name: 'substitutions', match: /FROM\s+order_line_substitutions\b/i, scope: /receipt_id\s+IN\s*\(/i },
	{ name: 'listing images', match: /FROM\s+listing_images\b/i, scope: /listing_id\s+IN\s*\(/i },
	{ name: 'style images', match: /FROM\s+listing_style_images\b/i, scope: /listing_id\s+IN\s*\(/i },
	{ name: 'variation images', match: /FROM\s+listing_variation_images\b/i, scope: /listing_id\s+IN\s*\(/i },
	{ name: 'product map', match: /FROM\s+product_map\b/i, scope: /title_norm\s+IN\s*\(/i },
	{ name: 'listing phash', match: /FROM\s+listing_phash\b/i, scope: /listing_id\s+IN\s*\(/i },
	{ name: 'product merges', match: /FROM\s+product_merges\b/i, scope: /listing_[ab]\s+IN\s*\(/i },
]

test('every hot read has a finite WHERE scope and at most 500 bindings', () => {
	for (const contract of hotReads) {
		const calls = traced.reads.filter((read) => contract.match.test(read.sql))
		assert.ok(calls.length >= 1, `${contract.name}: query was not observed`)
		assert.ok(calls.length >= 2, `${contract.name}: >500 scope was not chunked`)
		for (const call of calls) {
			assert.match(call.sql, contract.scope, `${contract.name}: unscoped SQL`)
			assert.ok(call.values.length > 0, `${contract.name}: empty batch was queried`)
			assert.ok(call.values.length <= 500, `${contract.name}: ${call.values.length} bindings`)
		}
	}
})

test('hot query bindings never include out-of-scope sentinels', () => {
	const scopedCalls = traced.reads.filter((read) => hotReads.some((contract) => contract.match.test(read.sql)))
	const values = scopedCalls.flatMap((call) => call.values)
	assert.ok(!values.includes(OUTSIDE_ID))
	assert.ok(!values.includes(OUTSIDE_KEY))
	assert.ok(!values.includes(OUTSIDE_NORM))
})

test('map helpers remain backward-compatible when scope is omitted', () => {
	assert.ok(dbSetup.getAllRouteAssignments(db)[`${OUTSIDE_ID}\x00${OUTSIDE_KEY}`])
	assert.ok(dbSetup.getAllProductAssignments(db)[OUTSIDE_KEY])
	assert.ok(dbSetup.getOpenIssueMap(db).has(`${OUTSIDE_ID}\x00${OUTSIDE_KEY}`))
	assert.ok(dbSetup.getOpenExchangeMap(db).has(`${OUTSIDE_ID}\x00${OUTSIDE_KEY}`))
	assert.ok(dbSetup.getSubstitutionMap(db).has(`${OUTSIDE_ID}\x00${OUTSIDE_KEY}`))
	assert.ok(dbSetup.getProductMapByNorm(db).has(OUTSIDE_NORM))
})

test('empty helper scopes return empty maps without preparing SQL', () => {
	let prepares = 0
	const noQueryDb = {
		prepare() {
			prepares += 1
			throw new Error('empty scope must not query')
		},
	}
	assert.deepStrictEqual(dbSetup.getAllRouteAssignments(noQueryDb, []), {})
	assert.deepStrictEqual(dbSetup.getAllProductAssignments(noQueryDb, []), {})
	assert.strictEqual(dbSetup.getOpenIssueMap(noQueryDb, []).size, 0)
	assert.strictEqual(dbSetup.getOpenExchangeMap(noQueryDb, []).size, 0)
	assert.strictEqual(dbSetup.getSubstitutionMap(noQueryDb, []).size, 0)
	assert.strictEqual(dbSetup.getProductMapByNorm(noQueryDb, []).size, 0)
	assert.deepStrictEqual(dbSetup.getListingStyleImageMap(noQueryDb, []), {})
	assert.deepStrictEqual(
		dbSetup.getListingVariationImageMap(noQueryDb, []),
		{ byStyle: {}, byValue: {} },
	)
	assert.strictEqual(prepares, 0)
})

test('explicit empty receipt scope remains empty and skips hot reads', () => {
	const emptyTrace = traceReads(db)
	const emptyRows = routeDashboard.buildRouteRows(emptyTrace.db, {}, {
		receipt_ids: [],
		include_manual: false,
		enrich_supplier: false,
	})
	assert.deepStrictEqual(emptyRows, [])
	assert.ok(!emptyTrace.reads.some((read) => hotReads.slice(1).some((contract) => contract.match.test(read.sql))))
})

test('dashboard endpoint keeps payload compatibility and exposes diagnostics', () => {
	const source = fs.readFileSync(path.resolve(__dirname, '../src/server/index.js'), 'utf8')
	const start = source.indexOf("app.get('/api/route/dashboard'")
	const end = source.indexOf("app.post('/api/route/assign'", start)
	assert.ok(start >= 0 && end > start)
	const endpoint = source.slice(start, end)
	for (const token of ['rows,', 'summary,', 'statuses: routeDashboard.STATUS_OPTIONS', 'meta:']) {
		assert.ok(endpoint.includes(token), `missing response token: ${token}`)
	}
	assert.ok(endpoint.includes("'Server-Timing'"))
	assert.ok(endpoint.includes('route-build;dur='))
	assert.ok(endpoint.includes("'X-Route-Row-Count'"))
	assert.ok(!/Cache-Control[^\n]*public/i.test(endpoint))
})

db.close()
console.log(`\nAll ${passed} assertions passed.`)
