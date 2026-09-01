'use strict'

/**
 * Cross-surface catalog contract.
 *
 * Product Catalog, Sourcing, Add Order and Design Switch must agree on active
 * membership and supplier identity. Retirement is a tombstone: active browsers
 * hide it, route resolution suppresses legacy fallbacks, and history survives.
 */

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const Database = require('better-sqlite3')
const {
	initDb,
	insertSupplierDirectoryRow,
	updateSupplierDirectoryRow,
	deleteSupplierDirectoryRow,
	upsertProductMapRow,
	updateProductMapRowById,
	getProductMap,
	getProductMapRow,
	replaceProductMap,
	deleteProductMapRow,
	syncProductMapToAssignments,
	setProductCost,
} = require('../src/db/setup')
const routeDashboard = require('../src/route/dashboard')

let passed = 0
function test(name, fn) {
	try {
		fn()
		passed++
		console.log(`  ok  — ${name}`)
	} catch (error) {
		console.error(`  FAIL — ${name}`)
		throw error
	}
}

function seedAccount(db) {
	db.prepare("INSERT INTO groups (group_id, label) VALUES ('G1', 'Catalog QA')").run()
	db.prepare("INSERT INTO shops (shop_id, group_id, shop_name) VALUES ('S1', 'G1', 'Etsy QA')").run()
}

function seedListing(db, id, title, image) {
	db.prepare(
		"INSERT INTO listings (listing_id, shop_id, title, primary_image_url, state) VALUES (?, 'S1', ?, ?, 'active')",
	).run(id, title, image)
}

function seedReceipt(db, title, listingId) {
	const transactions = JSON.stringify([
		{
			title,
			listing_id: listingId,
			quantity: 1,
			variations: [
				{ formatted_name: 'Phone Model', formatted_value: 'iPhone 16 Pro' },
				{ formatted_name: 'Style', formatted_value: 'Case+Grip' },
			],
		},
	])
	db.prepare(
		`INSERT INTO receipts
			(receipt_id, shop_id, group_id, name, status, is_paid, is_shipped,
			 etsy_created_at, all_transactions)
		 VALUES (1001, 'S1', 'G1', 'Catalog Buyer', 'Paid', 1, 0,
			 strftime('%s','now'), ?)`,
	).run(transactions)
}

console.log('\nUnified active Product Catalog\n')

{
	const db = initDb(':memory:')
	try {
		seedAccount(db)
		const titleA = 'Moon Rabbit Clear MagSafe Case with Grip'
		const titleB = 'Moon Rabbit MagSafe Phone Cover and Grip'
		const canonical = 'P-MOON-RABBIT'
		insertSupplierDirectoryRow(db, { shop_name: 'Moon Lab', stall: 'A2-18' })
		seedListing(db, 501, titleA, 'https://example.test/moon-a.png')
		seedListing(db, 502, titleB, 'https://example.test/moon-b.png')
		seedReceipt(db, titleA, 501)
		const a = upsertProductMapRow(db, {
			title: titleA,
			shop_name: 'Moon Lab',
			stall: 'A2-18',
			charm_code: 'CH-00018',
			canonical_product_key: canonical,
		})
		upsertProductMapRow(db, {
			title: titleB,
			shop_name: 'Moon Lab',
			stall: 'A2-18',
			charm_code: 'CH-00018',
			canonical_product_key: canonical,
		})
		const itemKey = routeDashboard.lineItemKey(titleA, 501)
		db.prepare(
			`INSERT INTO product_assignments
				(item_key, title, supplier_shop, supplier_stall, charm_code)
			 VALUES (?, ?, 'Moon Lab', 'A2-18', 'CH-00018')`,
		).run(itemKey, titleA)
		db.prepare(
			`INSERT INTO product_assignments
				(item_key, title, supplier_shop, supplier_stall, charm_code)
			 VALUES (?, ?, 'Moon Lab', 'A2-18', 'CH-00018')`,
		).run(routeDashboard.lineItemKey(titleB, 502), titleB)

		test('the shared picker is catalog-backed and collapses canonical aliases', () => {
			const catalog = routeDashboard.buildProductCatalog(db)
			assert.strictEqual(catalog.products.length, 1)
			assert.strictEqual(catalog.products[0].listing_count, 2)
			assert.strictEqual(catalog.products[0].shop_name, 'Moon Lab')
			assert.strictEqual(catalog.products[0].stall, 'A2-18')
			assert.deepStrictEqual(catalog.products[0].phone_models, ['iPhone 16 Pro'])
			assert.deepStrictEqual(catalog.products[0].styles, ['Case+Grip'])
		})

		test('an active route line resolves through the same supplier mapping', () => {
			const row = routeDashboard.buildRouteRows(db, {}, { enrich_supplier: false })[0]
			assert.strictEqual(row.supplier_shop, 'Moon Lab')
			assert.strictEqual(row.supplier_stall, 'A2-18')
			assert.strictEqual(row.catalog_status, 'active')
		})

		test('a same-offer canonical edit fans out to every exact alias default', () => {
			const result = updateProductMapRowById(db, {
				id: a.id,
				title: titleA,
				shop_name: 'Moon Lab New',
				stall: 'A2-19',
				charm_code: 'CH-00019',
			})
			for (const title of result.affected_titles) {
				syncProductMapToAssignments(db, {
					title,
					shop_name: 'Moon Lab New',
					stall: 'A2-19',
					charm_code: 'CH-00019',
				})
			}
			const maps = getProductMap(db)
			const defaults = db
				.prepare('SELECT title, supplier_shop, supplier_stall FROM product_assignments ORDER BY title')
				.all()
			assert.ok(maps.every((row) => row.shop_name === 'Moon Lab New' && row.stall === 'A2-19'))
			assert.ok(
				defaults.every(
					(row) => row.supplier_shop === 'Moon Lab New' && row.supplier_stall === 'A2-19',
				),
			)
		})

		const retired = deleteProductMapRow(db, a.id, {
			reason: 'Supplier discontinued design',
			by: 'catalog-test',
		})
		test('retiring one physical product retires every canonical title alias', () => {
			assert.strictEqual(retired.removed, 2)
			assert.strictEqual(getProductMap(db).length, 0)
			assert.strictEqual(routeDashboard.buildProductCatalog(db).products.length, 0)
			assert.strictEqual(getProductMapRow(db, { id: a.id }).status, 'retired')
		})

		test('a stale PUT cannot resurrect a product retired by another client', () => {
			assert.throws(
				() =>
					updateProductMapRowById(db, {
						id: a.id,
						title: titleA,
						shop_name: 'Moon Lab',
						stall: 'A2-18',
					}),
				(error) => error && error.code === 'CONFLICT',
			)
			assert.strictEqual(getProductMapRow(db, { id: a.id }).status, 'retired')
		})

		test('retirement clears stale defaults and suppresses supplier fallback', () => {
			assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM product_assignments').get().n, 0)
			const row = routeDashboard.buildRouteRows(db, {}, { enrich_supplier: false })[0]
			assert.strictEqual(row.supplier_shop, '')
			assert.strictEqual(row.supplier_stall, '')
			assert.strictEqual(row.catalog_status, 'retired')
			assert.strictEqual(row.needs_sourcing, true)
		})

		test('an explicit catalog save restores a retired title', () => {
			upsertProductMapRow(db, { title: titleA, shop_name: 'Moon Lab', stall: 'A2-18' })
			assert.strictEqual(getProductMap(db).length, 1)
			assert.strictEqual(getProductMapRow(db, { title: titleA }).status, 'active')
			assert.strictEqual(routeDashboard.buildProductCatalog(db).products.length, 1)
		})

		test('active product titles cannot be renamed out from under historical orders', () => {
			assert.throws(
				() =>
					updateProductMapRowById(db, {
						id: a.id,
						title: titleA + ' renamed',
						shop_name: 'Moon Lab',
						stall: 'A2-18',
					}),
				(error) => error && error.code === 'IMMUTABLE',
			)
			assert.strictEqual(getProductMapRow(db, { id: a.id }).title, titleA)
		})
	} finally {
		db.close()
	}
}

console.log('\nSupplier lifecycle and import safety\n')

{
	const db = initDb(':memory:')
	try {
		const title = 'Supplier Lifecycle Blue iPhone Case'
		insertSupplierDirectoryRow(db, { shop_name: 'Old Booth', stall: '5D10' })
		const product = upsertProductMapRow(db, { title, shop_name: 'Old Booth', stall: '5D10' })
		db.prepare(
			`INSERT INTO product_assignments
				(item_key, title, supplier_shop, supplier_stall)
			 VALUES (?, ?, 'Old Booth', '5D10')`,
		).run(routeDashboard.lineItemKey(title, 700), title)
		db.prepare(
			`INSERT INTO product_assignments
				(item_key, title, supplier_shop, supplier_stall)
			 VALUES (?, ?, 'Old Booth', '5D10')`,
		).run(routeDashboard.lineItemKey('Legacy Default Without Map', 701), 'Legacy Default Without Map')
		db.prepare(
			`INSERT INTO route_assignments
				(receipt_id, item_key, title, supplier_shop_override, supplier_stall_override)
			 VALUES (9001, ?, 'Legacy Route Without Map', 'Old Booth', '5D10')`,
		).run(routeDashboard.lineItemKey('Legacy Route Without Map', 702))
		const blankMappedTitle = 'Active Blank Mapping With Deleted Override'
		upsertProductMapRow(db, { title: blankMappedTitle })
		db.prepare(
			`INSERT INTO route_assignments
				(receipt_id, item_key, title, supplier_shop_override, supplier_stall_override)
			 VALUES (9002, ?, ?, 'Old Booth', '5D10')`,
		).run(routeDashboard.lineItemKey(blankMappedTitle, 703), blankMappedTitle)

		test('renaming a supplier atomically rewrites catalog and saved defaults', () => {
			updateSupplierDirectoryRow(db, {
				orig_shop_name: 'Old Booth',
				orig_stall: '5D10',
				shop_name: 'New Booth',
				stall: '5D11',
			})
			const row = getProductMapRow(db, { id: product.id })
			const saved = db.prepare('SELECT * FROM product_assignments').get()
			assert.deepStrictEqual([row.shop_name, row.stall], ['New Booth', '5D11'])
			assert.deepStrictEqual([saved.supplier_shop, saved.supplier_stall], ['New Booth', '5D11'])
		})

		test('a supplier with active products cannot be silently orphaned', () => {
			assert.throws(
				() => deleteSupplierDirectoryRow(db, { shop_name: 'New Booth', stall: '5D11' }),
				(error) => error && error.code === 'IN_USE' && error.product_count >= 1,
			)
			assert.strictEqual(getProductMap(db).length, 2)
		})

		test('an explicitly confirmed supplier removal retires its active products', () => {
			const impact = deleteSupplierDirectoryRow(db, {
				shop_name: 'New Booth',
				stall: '5D11',
				retire_products: true,
				retired_by: 'catalog-test',
			})
			assert.strictEqual(impact.removed, 1)
			assert.strictEqual(impact.retired_products, 1)
			assert.strictEqual(getProductMap(db).length, 0)
			assert.strictEqual(getProductMapRow(db, { id: product.id }).status, 'retired')
			assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM product_assignments').get().n, 0)
			const routeOverride = db
				.prepare('SELECT supplier_shop_override, supplier_stall_override FROM route_assignments')
				.get()
			assert.deepStrictEqual(
				[routeOverride.supplier_shop_override, routeOverride.supplier_stall_override],
				['', ''],
			)
			assert.strictEqual(
				getProductMapRow(db, { title: 'Legacy Route Without Map' }).status,
				'retired',
			)
			assert.strictEqual(
				getProductMapRow(db, { title: blankMappedTitle }).status,
				'retired',
			)
		})

		const manualTitle = 'App Managed Product Not In Workbook'
		upsertProductMapRow(db, { title: manualTitle, shop_name: 'Manual Shop', stall: 'A200' })
		test('Excel merge preserves app-managed rows and retirement tombstones', () => {
			replaceProductMap(db, [
				{
					title_norm: routeDashboard.normalizeTitle(title),
					title,
					shop_name: 'Workbook Old Booth',
					stall: '5D10',
					charm_shop: '',
					charm_code: '',
					sort_order: 0,
				},
			])
			assert.ok(getProductMap(db).some((row) => row.title === manualTitle))
			assert.strictEqual(getProductMapRow(db, { title }).status, 'retired')
		})
	} finally {
		db.close()
	}
}

console.log('\nAdversarial identity and cleanup cases\n')

{
	const db = initDb(':memory:')
	try {
		const percentTitle = '100% Cotton Protective Case'
		const otherTitle = '100X Cotton Protective Case'
		const percent = upsertProductMapRow(db, { title: percentTitle, shop_name: 'Textile', stall: 'A1' })
		db.prepare(
			'INSERT INTO product_assignments (item_key, title, supplier_shop, supplier_stall) VALUES (?, ?, ?, ?)',
		).run(routeDashboard.lineItemKey(percentTitle, 1), percentTitle, 'Textile', 'A1')
		db.prepare(
			'INSERT INTO product_assignments (item_key, title, supplier_shop, supplier_stall) VALUES (?, ?, ?, ?)',
		).run(routeDashboard.lineItemKey(otherTitle, 2), otherTitle, 'Other', 'A2')

		test('catalog edits never treat % or _ in a title as a SQL wildcard', () => {
			syncProductMapToAssignments(db, {
				title: percentTitle,
				shop_name: 'Changed',
				stall: 'Z9',
			})
			const assignments = db
				.prepare('SELECT title, supplier_shop, supplier_stall FROM product_assignments ORDER BY title')
				.all()
			assert.deepStrictEqual(
				assignments.find((row) => row.title === percentTitle),
				{ title: percentTitle, supplier_shop: 'Changed', supplier_stall: 'Z9' },
			)
			assert.deepStrictEqual(
				assignments.find((row) => row.title === otherTitle),
				{ title: otherTitle, supplier_shop: 'Other', supplier_stall: 'A2' },
			)
		})

		test('retirement never treats % or _ in a title as a SQL wildcard', () => {
			deleteProductMapRow(db, percent.id)
			const remaining = db.prepare('SELECT title FROM product_assignments').all()
			assert.deepStrictEqual(remaining.map((row) => row.title), [otherTitle])
		})
	} finally {
		db.close()
	}
}

{
	const db = initDb(':memory:')
	try {
		seedAccount(db)
		const canonical = 'P-MULTI-SOURCE'
		const titleA = 'Multi Source Case A'
		const titleB = 'Multi Source Case B'
		seedListing(db, 801, titleA, 'https://example.test/multi-a.png')
		seedListing(db, 802, titleB, 'https://example.test/multi-b.png')
		const a = upsertProductMapRow(db, {
			title: titleA,
			shop_name: 'Supplier A',
			stall: 'A2-1',
			canonical_product_key: canonical,
		})
		upsertProductMapRow(db, {
			title: titleB,
			shop_name: 'Supplier B',
			stall: 'A2-2',
			canonical_product_key: canonical,
		})

		test('one physical product with two supplier offers renders as two truthful cards', () => {
			const products = routeDashboard.buildProductCatalog(db).products
			assert.strictEqual(products.length, 2)
			assert.deepStrictEqual(
				products.map((product) => product.shop_name).sort(),
				['Supplier A', 'Supplier B'],
			)
		})

		test('each supplier offer keeps its own wholesale price', () => {
			setProductCost(db, { title: titleA, cost_case: 5 })
			setProductCost(db, { title: titleB, cost_case: 8 })
			const prices = db
				.prepare('SELECT shop_name, cost_case FROM product_map WHERE canonical_product_key = ? ORDER BY shop_name')
				.all(canonical)
			assert.deepStrictEqual(prices, [
				{ shop_name: 'Supplier A', cost_case: 5 },
				{ shop_name: 'Supplier B', cost_case: 8 },
			])
		})

		test('discontinuing one supplier offer preserves the active alternative', () => {
			const impact = deleteProductMapRow(db, a.id)
			assert.strictEqual(impact.removed, 1)
			const products = routeDashboard.buildProductCatalog(db).products
			assert.strictEqual(products.length, 1)
			assert.strictEqual(products[0].shop_name, 'Supplier B')
		})
	} finally {
		db.close()
	}
}

{
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-lifecycle-migration-'))
	const dbPath = path.join(dir, 'legacy.db')
	const legacy = new Database(dbPath)
	legacy.exec(`
		CREATE TABLE product_map (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			title_norm TEXT NOT NULL UNIQUE,
			title TEXT NOT NULL DEFAULT '',
			shop_name TEXT DEFAULT '',
			stall TEXT DEFAULT '',
			charm_shop TEXT DEFAULT '',
			charm_code TEXT DEFAULT '',
			canonical_product_key TEXT,
			sort_order INTEGER DEFAULT 0,
			updated_at INTEGER
		);
		INSERT INTO product_map (title_norm, title) VALUES ('legacy product', 'Legacy Product');
	`)
	legacy.close()
	const migrated = initDb(dbPath)
	try {
		test('a pre-lifecycle database migrates existing products to active safely', () => {
			const row = getProductMapRow(migrated, { title: 'Legacy Product' })
			assert.strictEqual(row.status, 'active')
			assert.strictEqual(row.retired_at, null)
			assert.ok(
				migrated
					.pragma('table_info(product_map)')
					.map((column) => column.name)
					.includes('retired_reason'),
			)
		})
	} finally {
		migrated.close()
		fs.rmSync(dir, { recursive: true, force: true })
	}
}

console.log(`\nAll ${passed} catalog consistency assertions passed.\n`)
