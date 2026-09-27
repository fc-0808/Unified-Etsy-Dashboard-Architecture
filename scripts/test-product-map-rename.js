'use strict'

/**
 * Catalog product rename: the display title is mutable, previous listing
 * titles stay as aliases so orders, photos and Excel rows still resolve.
 *
 * Run: `node scripts/test-product-map-rename.js`
 */

const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
	initDb,
	insertSupplierDirectoryRow,
	upsertProductMapRow,
	updateProductMapRowById,
	getProductMap,
	getProductMapRow,
	getProductMapByNorm,
	listProductMapTitleAliases,
	setProductCost,
	syncProductMapToAssignments,
	replaceProductMap,
} = require('../src/db/setup')
const catalogView = require('../src/sourcing/catalog-view')
const routeDashboard = require('../src/route/dashboard')

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

let passed = 0
let failed = 0

function test(name, fn) {
	try {
		fn()
		passed++
		console.log(`  ${GREEN}ok${RESET}  — ${name}`)
	} catch (err) {
		failed++
		console.log(`  ${RED}FAIL${RESET} — ${name}`)
		console.log(`         ${err.stack || err.message}`)
	}
}

function openDb(label) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-rename-'))
	const db = initDb(path.join(dir, `${label || 't'}.db`))
	db._tmpdir = dir
	return db
}

function seedListing(db, id, title, image) {
	db.prepare(
		"INSERT INTO listings (listing_id, shop_id, title, primary_image_url, state) VALUES (?, 'S1', ?, ?, 'active')",
	).run(id, title, image)
}

console.log(`\n${BOLD}product-map rename${RESET}\n`)

test('an in-place rename updates the live title and keeps the old title as an alias', () => {
	const db = openDb('alias')
	try {
		insertSupplierDirectoryRow(db, { shop_name: 'HAN', stall: 'A2-29' })
		const created = upsertProductMapRow(db, { title: 'Pink Bunny MagSafe Case', shop_name: 'HAN', stall: 'A2-29' })
		const result = updateProductMapRowById(db, {
			id: created.id,
			title: 'Pink Bunny (warehouse name)',
			shop_name: 'HAN',
			stall: 'A2-29',
		})
		assert.equal(result.renamed, true)
		assert.equal(getProductMapRow(db, { id: created.id }).title, 'Pink Bunny (warehouse name)')
		assert.equal(getProductMapRow(db, { title: 'Pink Bunny MagSafe Case' }).id, created.id)
		assert.equal(getProductMapRow(db, { title: 'Pink Bunny (warehouse name)' }).id, created.id)
		const aliases = listProductMapTitleAliases(db, created.id)
		assert.equal(aliases.length, 1)
		assert.equal(aliases[0].title, 'Pink Bunny MagSafe Case')
		assert.ok(getProductMapByNorm(db, ['pink bunny magsafe case']).has('pink bunny magsafe case'))
	} finally {
		db.close()
	}
})

test('renaming back to a previous title promotes that alias and keeps the abandoned name', () => {
	const db = openDb('promote')
	try {
		const created = upsertProductMapRow(db, { title: 'Title A', shop_name: 'HAN', stall: 'A2-29' })
		updateProductMapRowById(db, { id: created.id, title: 'Title B', shop_name: 'HAN', stall: 'A2-29' })
		updateProductMapRowById(db, { id: created.id, title: 'Title A', shop_name: 'HAN', stall: 'A2-29' })
		assert.equal(getProductMapRow(db, { id: created.id }).title, 'Title A')
		const aliases = listProductMapTitleAliases(db, created.id).map((row) => row.title)
		assert.ok(aliases.includes('Title B'))
		assert.ok(!aliases.includes('Title A'))
	} finally {
		db.close()
	}
})

test('a name already used by another active product is rejected', () => {
	const db = openDb('clash')
	try {
		const a = upsertProductMapRow(db, { title: 'Alpha Case', shop_name: 'HAN', stall: 'A2-29' })
		upsertProductMapRow(db, { title: 'Beta Case', shop_name: 'HAN', stall: 'A2-29' })
		assert.throws(
			() => updateProductMapRowById(db, { id: a.id, title: 'Beta Case', shop_name: 'HAN', stall: 'A2-29' }),
			(error) => error && error.code === 'CONFLICT',
		)
		assert.equal(getProductMapRow(db, { id: a.id }).title, 'Alpha Case')
	} finally {
		db.close()
	}
})

test('saved product defaults still match after the catalog name changes', () => {
	const db = openDb('assignments')
	try {
		const title = 'Kuromi MagSafe Case with Grip'
		const created = upsertProductMapRow(db, { title, shop_name: 'HAN', stall: 'A2-29' })
		const itemKey = routeDashboard.lineItemKey(title, 501)
		db.prepare(
			`INSERT INTO product_assignments (item_key, title, supplier_shop, supplier_stall) VALUES (?, ?, 'HAN', 'A2-29')`,
		).run(itemKey, title)
		const result = updateProductMapRowById(db, {
			id: created.id,
			title: 'Kuromi warehouse label',
			shop_name: 'V8',
			stall: 'A2-21',
		})
		for (const aliasTitle of result.affected_titles) {
			syncProductMapToAssignments(db, {
				title: aliasTitle,
				shop_name: 'V8',
				stall: 'A2-21',
			})
		}
		const saved = db.prepare('SELECT supplier_shop, supplier_stall FROM product_assignments WHERE item_key = ?').get(itemKey)
		assert.equal(saved.supplier_shop, 'V8')
		assert.equal(saved.supplier_stall, 'A2-21')
	} finally {
		db.close()
	}
})

test('historical orders still resolve supplier through the previous listing title', () => {
	const db = openDb('orders')
	try {
		db.prepare("INSERT INTO groups (group_id, label) VALUES ('G1', 'Rename QA')").run()
		db.prepare("INSERT INTO shops (shop_id, group_id, shop_name) VALUES ('S1', 'G1', 'Etsy QA')").run()
		insertSupplierDirectoryRow(db, { shop_name: 'Moon Lab', stall: 'A2-18' })
		const title = 'Moon Rabbit Clear MagSafe Case'
		const renamed = 'Moon Rabbit warehouse name'
		seedListing(db, 801, title, 'https://example.test/moon.png')
		const created = upsertProductMapRow(db, { title, shop_name: 'Moon Lab', stall: 'A2-18' })
		db.prepare(
			`INSERT INTO receipts
				(receipt_id, shop_id, group_id, name, status, is_paid, is_shipped, etsy_created_at, all_transactions)
			 VALUES (1801, 'S1', 'G1', 'Buyer', 'Paid', 1, 0, strftime('%s','now'), ?)`,
		).run(JSON.stringify([{ title, listing_id: 801, quantity: 1, variations: [] }]))
		updateProductMapRowById(db, { id: created.id, title: renamed, shop_name: 'Moon Lab', stall: 'A2-18' })
		const row = routeDashboard.buildRouteRows(db, {}, { enrich_supplier: false })[0]
		assert.equal(row.supplier_shop, 'Moon Lab')
		assert.equal(row.supplier_stall, 'A2-18')
		assert.equal(row.catalog_status, 'active')
		const picker = routeDashboard.buildProductCatalog(db)
		assert.ok(picker.products.some((p) => p.title === renamed && p.image_url === 'https://example.test/moon.png'))
	} finally {
		db.close()
	}
})

test('the sourcing projection keeps the photo and shows the new name', () => {
	const db = openDb('catalog')
	try {
		insertSupplierDirectoryRow(db, { shop_name: 'HAN', stall: 'A2-29' })
		const title = 'Cherry Sweet Case for iPhone 16'
		const created = upsertProductMapRow(db, { title, shop_name: 'HAN', stall: 'A2-29' })
		const resolver = {
			resolve: (titleNorm) =>
				titleNorm === title.toLowerCase() ? { url: 'https://example.test/cherry.png', approx: false } : null,
		}
		updateProductMapRowById(db, { id: created.id, title: 'Cherry warehouse name', shop_name: 'HAN', stall: 'A2-29' })
		const view = catalogView.buildCatalog(db, { imageResolver: resolver })
		const row = view.products.find((p) => p.id === created.id)
		assert.ok(row, 'renamed product remains in the photographed catalog')
		assert.equal(row.title, 'Cherry warehouse name')
		assert.equal(row.image_url, 'https://example.test/cherry.png')
		assert.ok(row.title_aliases.includes(title))
	} finally {
		db.close()
	}
})

test('Excel re-import of the old Etsy title updates the renamed row instead of duplicating it', () => {
	const db = openDb('excel')
	try {
		const created = upsertProductMapRow(db, { title: 'Etsy Listing Title', shop_name: 'HAN', stall: 'A2-29' })
		updateProductMapRowById(db, { id: created.id, title: 'Warehouse name', shop_name: 'HAN', stall: 'A2-29' })
		replaceProductMap(db, [
			{
				title_norm: 'etsy listing title',
				title: 'Etsy Listing Title',
				shop_name: 'V8',
				stall: 'A2-21',
				charm_shop: '',
				charm_code: '',
				sort_order: 1,
			},
		])
		assert.equal(getProductMap(db).length, 1)
		const row = getProductMapRow(db, { id: created.id })
		assert.equal(row.title, 'Warehouse name')
		assert.equal(row.shop_name, 'V8')
		assert.equal(row.stall, 'A2-21')
	} finally {
		db.close()
	}
})

test('a price posted under the previous title lands on the renamed product', () => {
	const db = openDb('price')
	try {
		const created = upsertProductMapRow(db, { title: 'Priced Case', shop_name: 'HAN', stall: 'A2-29' })
		updateProductMapRowById(db, { id: created.id, title: 'Priced warehouse', shop_name: 'HAN', stall: 'A2-29' })
		setProductCost(db, { title: 'Priced Case', cost_case: 8.5 })
		assert.equal(getProductMapRow(db, { id: created.id }).cost_case, 8.5)
		assert.equal(getProductMap(db).length, 1)
	} finally {
		db.close()
	}
})

test('cosmetic case changes that share a title_norm do not create an alias', () => {
	const db = openDb('cosmetic')
	try {
		const created = upsertProductMapRow(db, { title: 'Hello Kitty Case', shop_name: 'HAN', stall: 'A2-29' })
		const result = updateProductMapRowById(db, {
			id: created.id,
			title: 'hello kitty case',
			shop_name: 'HAN',
			stall: 'A2-29',
		})
		assert.equal(result.renamed, false)
		assert.equal(getProductMapRow(db, { id: created.id }).title, 'hello kitty case')
		assert.equal(listProductMapTitleAliases(db, created.id).length, 0)
	} finally {
		db.close()
	}
})

if (failed) {
	console.log(`\n${failed} failed, ${passed} passed\n`)
	process.exit(1)
}
console.log(`\n${passed} passed\n`)
