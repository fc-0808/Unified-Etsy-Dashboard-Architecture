'use strict'

/**
 * Catalog-only restore — recover product photos and supplier stall names
 * from a pre-offboard snapshot without undeleting the Etsy shops.
 *
 * Run: node scripts/test-restore-shop-catalog.js
 */

const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { initDb, syncConfigToDb } = require('../src/db/setup')
const { buildCatalogImageResolver } = require('../src/route/dashboard')
const {
	RestoreError,
	DEFAULT_ARCHIVED_SHOP_IDS,
	NEVER_RESTORE_TABLES,
	LISTING_COPY_TABLES,
	CATALOG_ARCHIVE_SHOP_ID,
	parseArgs,
	normalizeTitle,
	resolveSourceShops,
	resolveAllHistoryShops,
	planRestore,
	applyRestore,
	promoteListingsToProductMap,
	totalInserts,
} = require('./restore-shop-catalog')

let failures = 0
function test(name, fn) {
	try {
		fn()
		console.log(`  ok  - ${name}`)
	} catch (error) {
		failures += 1
		console.error(`  FAIL - ${name}`)
		console.error(`    ${error.stack || error.message}`)
	}
}

function tempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'ued-restore-catalog-'))
}

function seedSource(db) {
	syncConfigToDb(db, {
		groups: [
			{
				group_id: 'g-gone',
				label: 'Gone',
				proxy: 'direct',
				shops: [
					{ shop_id: 'GoneA', shop_name: 'GoneA', api_key: 'key-gone', shared_secret: 'secret-gone' },
					{ shop_id: 'CuteiPhoneCasesFinds', shop_name: 'CuteiPhoneCasesFinds', api_key: 'key-gone', shared_secret: 'secret-gone' },
				],
			},
			{
				group_id: 'g-keep',
				label: 'Keep',
				proxy: 'direct',
				shops: [
					{ shop_id: 'KeepShop', shop_name: 'KeepShop', api_key: 'key-keep', shared_secret: 'secret-keep' },
				],
			},
		],
	})

	db.prepare(`
		INSERT INTO listings (listing_id, shop_id, title, state, primary_image_url, description)
		VALUES
			(9001, 'GoneA', 'Frog Case', 'active', 'https://img.example/frog.jpg', 'A frog'),
			(9002, 'KeepShop', 'Keep Case', 'active', 'https://img.example/keep.jpg', 'Keep me'),
			(9003, 'GoneA', 'Cat Case', 'active', 'https://img.example/cat.jpg', 'A cat'),
			(9004, 'CuteiPhoneCasesFinds', 'Bunny Case', 'active', 'https://img.example/bunny.jpg', 'A bunny'),
			(9010, 'KeepShop', 'Old Keep Case', 'active', 'https://img.example/old-keep.jpg', 'Pruned from live shop'),
			(9999, 'GoneA', 'Archive Collide', 'active', 'https://img.example/archive.jpg', 'Should not overwrite live')
	`).run()

	db.prepare(`INSERT INTO listing_images (listing_id, url) VALUES (9001, 'https://img.example/frog.jpg')`).run()
	db.prepare(`INSERT INTO listing_images (listing_id, url) VALUES (9003, 'https://img.example/cat.jpg')`).run()
	db.prepare(`INSERT INTO listing_images (listing_id, url) VALUES (9004, 'https://img.example/bunny.jpg')`).run()
	db.prepare(`INSERT INTO listing_images (listing_id, url) VALUES (9010, 'https://img.example/old-keep.jpg')`).run()
	db.prepare(`INSERT INTO listing_image_data (listing_id, data) VALUES (9001, ?)`).run(Buffer.from('frog-bytes'))
	db.prepare(`
		INSERT INTO listing_phash (listing_id, phash, sha, algo, canonical_key)
		VALUES (9001, 'abcd', 'sha-frog', 'dhash', 'canon-frog')
	`).run()
	db.prepare(`
		INSERT INTO listing_vemb (listing_id, algo, dim, sha, embedding)
		VALUES (9001, 'test', 4, 'sha-frog', x'00000000')
	`).run()
	db.prepare(`
		INSERT INTO listing_style_images (listing_id, style_key, style_value, image_data)
		VALUES (9001, 'clear', 'Clear', x'89504e47')
	`).run()
	db.prepare(`
		INSERT INTO listing_variation_images (listing_id, style_key, style_value, url)
		VALUES (9001, 'clear', 'Clear', 'https://img.example/frog-clear.jpg')
	`).run()
	db.prepare(`
		INSERT INTO listing_variation_image_state (listing_id, fetched_at, mapping_count)
		VALUES (9001, 1, 1)
	`).run()
	db.prepare(`
		INSERT INTO listing_inventory (listing_id, product_id, quantity, is_enabled)
		VALUES (9001, 1, 12, 1)
	`).run()
	db.prepare(`
		INSERT INTO receipts (receipt_id, shop_id, group_id, name, etsy_created_at, etsy_updated_at, is_paid, is_shipped)
		VALUES (501, 'GoneA', 'g-gone', 'Buyer', 1, 1, 1, 0)
	`).run()
	db.prepare(`
		INSERT INTO product_merges (listing_a, listing_b, note)
		VALUES (9001, 9002, 'same product')
	`).run()

	db.prepare(`
		INSERT INTO product_map (title_norm, title, shop_name, stall, cost_case, charm_shop, charm_code)
		VALUES
			('frog case', 'Frog Case', 'StallVendor', 'A1', 12.5, 'Rainbow', 'CH-00003'),
			('cat case', 'Cat Case', 'OverwriteMe', 'B2', 9, '', ''),
			('bunny case', 'Bunny Case', 'FindsStall', 'C3', NULL, '', ''),
			('orphan product', 'Orphan Product', 'ShouldNotInsert', 'Z9', 1, '', '')
	`).run()
	const frogId = db.prepare("SELECT id FROM product_map WHERE title_norm = 'frog case'").get().id
	db.prepare(`
		INSERT INTO product_map_title_aliases (title_norm, product_id, title)
		VALUES ('frog case classic', ?, 'Frog Case Classic')
	`).run(frogId)
}

function seedDest(db) {
	syncConfigToDb(db, {
		groups: [
			{
				group_id: 'g-keep',
				label: 'Keep',
				proxy: 'direct',
				shops: [
					{ shop_id: 'KeepShop', shop_name: 'KeepShop', api_key: 'key-keep', shared_secret: 'secret-keep' },
				],
			},
		],
	})
	db.prepare(`
		INSERT INTO listings (listing_id, shop_id, title, state, primary_image_url)
		VALUES
			(9002, 'KeepShop', 'Keep Case', 'active', 'https://img.example/keep.jpg'),
			(9999, 'KeepShop', 'Live Collide', 'active', 'https://img.example/live.jpg')
	`).run()
	db.prepare(`
		INSERT INTO product_map (title_norm, title, shop_name, stall, cost_case, charm_shop, charm_code)
		VALUES
			('frog case', 'Frog Case', '', '', NULL, '', ''),
			('cat case', 'Cat Case', 'KeepMe', 'LIVE', 3, '', '')
	`).run()
}

function makePair() {
	const dir = tempDir()
	const sourcePath = path.join(dir, 'source.db')
	const source = initDb(sourcePath)
	seedSource(source)
	source.close()
	const dest = initDb(':memory:')
	seedDest(dest)
	return { dir, sourcePath, dest }
}

console.log('Catalog-only restore tests\n')

test('parseArgs accepts ids, comma lists, --from/--db, and flags', () => {
	assert.deepEqual(
		parseArgs(['GoneA', '--yes', 'GoneB,GoneC', '--from', 'D:\\bak.db', '--db=C:\\live.db']),
		{
			shopIds: ['GoneA', 'GoneB', 'GoneC'],
			flags: new Set(['--yes']),
			from: 'D:\\bak.db',
			dbPath: 'C:\\live.db',
		},
	)
	assert.deepEqual(parseArgs(['--commit']).shopIds, [])
})

test('never-restore set covers shops, orders, inventory and tokens-adjacent ops', () => {
	assert.equal(NEVER_RESTORE_TABLES.has('shops'), true)
	assert.equal(NEVER_RESTORE_TABLES.has('receipts'), true)
	assert.equal(NEVER_RESTORE_TABLES.has('listing_inventory'), true)
	assert.equal(NEVER_RESTORE_TABLES.has('ledger_entries'), true)
	assert.equal(NEVER_RESTORE_TABLES.has('sync_log'), true)
	assert.equal(DEFAULT_ARCHIVED_SHOP_IDS.includes('CuteiPhoneCasesFinds'), true)
	assert.equal(LISTING_COPY_TABLES.some((spec) => spec.table === 'listing_inventory'), false)
	assert.equal(LISTING_COPY_TABLES.some((spec) => spec.table === 'shops'), false)
})

test('resolveSourceShops matches shop_id or shop_name case-insensitively', () => {
	const dir = tempDir()
	const sourcePath = path.join(dir, 'source.db')
	const source = initDb(sourcePath)
	seedSource(source)
	try {
		const resolved = resolveSourceShops(source, ['gonea', 'CuteiPhoneCasesFInds'])
		assert.deepEqual(resolved.targets.map((t) => t.shopId).sort(), ['CuteiPhoneCasesFinds', 'GoneA'])
		assert.equal(resolved.missing.length, 0)
		assert.equal(resolved.targets.find((t) => t.shopId === 'GoneA').listings, 3)
	} finally {
		source.close()
	}
})

test('dry-run plan does not mutate the destination', () => {
	const { dest, sourcePath } = makePair()
	try {
		const beforeListings = dest.prepare('SELECT COUNT(*) AS n FROM listings').get().n
		const beforeShops = dest.prepare('SELECT COUNT(*) AS n FROM shops').get().n
		const stats = planRestore(dest, sourcePath, ['GoneA', 'CuteiPhoneCasesFinds'])
		assert.ok(stats.listings.insert >= 3)
		assert.equal(dest.prepare('SELECT COUNT(*) AS n FROM listings').get().n, beforeListings)
		assert.equal(dest.prepare('SELECT COUNT(*) AS n FROM shops').get().n, beforeShops)
		assert.ok(totalInserts(stats) > 0)
	} finally {
		dest.close()
	}
})

test('restores product photos and data without undeleting the shop or its orders', () => {
	const { dest, sourcePath } = makePair()
	try {
		applyRestore(dest, sourcePath, ['GoneA', 'CuteiPhoneCasesFinds'])

		assert.equal(dest.prepare('SELECT COUNT(*) AS n FROM shops WHERE shop_id = ?').get('GoneA').n, 0)
		assert.equal(dest.prepare('SELECT COUNT(*) AS n FROM shops WHERE shop_id = ?').get('CuteiPhoneCasesFinds').n, 0)
		assert.equal(dest.prepare('SELECT COUNT(*) AS n FROM receipts WHERE shop_id = ?').get('GoneA').n, 0)
		assert.equal(dest.prepare('SELECT COUNT(*) AS n FROM listing_inventory WHERE listing_id = 9001').get().n, 0)

		const frog = dest.prepare('SELECT * FROM listings WHERE listing_id = 9001').get()
		assert.ok(frog)
		assert.equal(frog.shop_id, 'GoneA')
		assert.equal(frog.title, 'Frog Case')
		assert.equal(frog.primary_image_url, 'https://img.example/frog.jpg')
		assert.equal(dest.prepare('SELECT url FROM listing_images WHERE listing_id = 9001').get().url, 'https://img.example/frog.jpg')
		assert.deepEqual(dest.prepare('SELECT data FROM listing_image_data WHERE listing_id = 9001').get().data, Buffer.from('frog-bytes'))
		assert.equal(dest.prepare('SELECT canonical_key FROM listing_phash WHERE listing_id = 9001').get().canonical_key, 'canon-frog')
		assert.equal(dest.prepare('SELECT COUNT(*) AS n FROM listing_vemb WHERE listing_id = 9001').get().n, 1)
		assert.equal(dest.prepare('SELECT COUNT(*) AS n FROM listing_style_images WHERE listing_id = 9001').get().n, 1)
		assert.equal(dest.prepare('SELECT url FROM listing_variation_images WHERE listing_id = 9001').get().url, 'https://img.example/frog-clear.jpg')
		assert.equal(dest.prepare('SELECT listing_id FROM listings WHERE listing_id = 9004').get().listing_id, 9004)

		assert.equal(dest.prepare('SELECT COUNT(*) AS n FROM shops WHERE shop_id = ?').get('KeepShop').n, 1)
		assert.equal(dest.prepare('SELECT title FROM listings WHERE listing_id = 9002').get().title, 'Keep Case')

		const image = buildCatalogImageResolver(dest, { fuzzy: false }).resolve(normalizeTitle('Frog Case'), 'Frog Case')
		assert.ok(image)
		assert.equal(image.url, 'https://img.example/frog.jpg')
		assert.equal(image.approx, false)
	} finally {
		dest.close()
	}
})

test('fills empty supplier fields and never overwrites a live stall name', () => {
	const { dest, sourcePath } = makePair()
	try {
		applyRestore(dest, sourcePath, ['GoneA', 'CuteiPhoneCasesFinds'])
		const frog = dest.prepare("SELECT shop_name, stall, cost_case, charm_shop, charm_code FROM product_map WHERE title_norm = 'frog case'").get()
		assert.equal(frog.shop_name, 'StallVendor')
		assert.equal(frog.stall, 'A1')
		assert.equal(frog.cost_case, 12.5)
		assert.equal(frog.charm_shop, 'Rainbow')
		assert.equal(frog.charm_code, 'CH-00003')
		const cat = dest.prepare("SELECT shop_name, stall, cost_case FROM product_map WHERE title_norm = 'cat case'").get()
		assert.equal(cat.shop_name, 'KeepMe')
		assert.equal(cat.stall, 'LIVE')
		assert.equal(cat.cost_case, 3)
		assert.equal(dest.prepare("SELECT COUNT(*) AS n FROM product_map WHERE title_norm = 'orphan product'").get().n, 0)
		assert.equal(dest.prepare("SELECT COUNT(*) AS n FROM product_map WHERE title_norm = 'bunny case'").get().n, 1)
		assert.equal(dest.prepare("SELECT shop_name FROM product_map WHERE title_norm = 'bunny case'").get().shop_name, 'FindsStall')
		const alias = dest.prepare("SELECT product_id, title FROM product_map_title_aliases WHERE title_norm = 'frog case classic'").get()
		assert.ok(alias)
		const frogId = dest.prepare("SELECT id FROM product_map WHERE title_norm = 'frog case'").get().id
		assert.equal(alias.product_id, frogId)
	} finally {
		dest.close()
	}
})

test('skips listing_id collisions that belong to a remaining shop', () => {
	const { dest, sourcePath } = makePair()
	try {
		applyRestore(dest, sourcePath, ['GoneA'])
		const live = dest.prepare('SELECT shop_id, title, primary_image_url FROM listings WHERE listing_id = 9999').get()
		assert.equal(live.shop_id, 'KeepShop')
		assert.equal(live.title, 'Live Collide')
		assert.equal(live.primary_image_url, 'https://img.example/live.jpg')
	} finally {
		dest.close()
	}
})

test('restores a product merge onto a remaining-shop listing', () => {
	const { dest, sourcePath } = makePair()
	try {
		applyRestore(dest, sourcePath, ['GoneA'])
		const merge = dest.prepare('SELECT note FROM product_merges WHERE listing_a = 9001 AND listing_b = 9002').get()
		assert.equal(merge.note, 'same product')
	} finally {
		dest.close()
	}
})

test('second restore is idempotent', () => {
	const { dest, sourcePath } = makePair()
	try {
		applyRestore(dest, sourcePath, ['GoneA', 'CuteiPhoneCasesFinds'])
		const listings = dest.prepare('SELECT COUNT(*) AS n FROM listings').get().n
		const images = dest.prepare('SELECT COUNT(*) AS n FROM listing_images').get().n
		const written = applyRestore(dest, sourcePath, ['GoneA', 'CuteiPhoneCasesFinds'])
		assert.equal(Object.keys(written).length, 0)
		assert.equal(dest.prepare('SELECT COUNT(*) AS n FROM listings').get().n, listings)
		assert.equal(dest.prepare('SELECT COUNT(*) AS n FROM listing_images').get().n, images)
	} finally {
		dest.close()
	}
})

test('applyRestore refuses when source and destination are the same file', () => {
	const dir = tempDir()
	const sourcePath = path.join(dir, 'same.db')
	const db = initDb(sourcePath)
	seedSource(db)
	try {
		assert.throws(() => applyRestore(db, sourcePath, ['GoneA']), RestoreError)
	} finally {
		db.close()
	}
})

test('restores a missing operated-shop listing under the catalog archive shop_id', () => {
	const { dest, sourcePath } = makePair()
	try {
		applyRestore(dest, sourcePath, ['KeepShop'])
		const archived = dest.prepare('SELECT shop_id, title, primary_image_url FROM listings WHERE listing_id = 9010').get()
		assert.ok(archived)
		assert.equal(archived.shop_id, CATALOG_ARCHIVE_SHOP_ID)
		assert.equal(archived.title, 'Old Keep Case')
		assert.equal(archived.primary_image_url, 'https://img.example/old-keep.jpg')
		assert.equal(dest.prepare('SELECT url FROM listing_images WHERE listing_id = 9010').get().url, 'https://img.example/old-keep.jpg')
		assert.equal(dest.prepare('SELECT COUNT(*) AS n FROM shops WHERE shop_id = ?').get(CATALOG_ARCHIVE_SHOP_ID).n, 0)
		assert.equal(dest.prepare('SELECT shop_id FROM listings WHERE listing_id = 9002').get().shop_id, 'KeepShop')
		assert.equal(dest.prepare('SELECT COUNT(*) AS n FROM shops WHERE shop_id = ?').get('KeepShop').n, 1)
	} finally {
		dest.close()
	}
})

test('promoteListingsToProductMap inserts missing catalog rows and aliases same-photo titles', () => {
	const { dest, sourcePath } = makePair()
	try {
		applyRestore(dest, sourcePath, ['GoneA'])
		dest.prepare(`
			INSERT INTO listings (listing_id, shop_id, title, state, primary_image_url)
			VALUES (9020, 'GoneA', 'Frog Case iPhone 18', 'active', 'https://img.example/frog.jpg')
		`).run()
		dest.prepare(`
			INSERT INTO listing_phash (listing_id, phash, sha, algo, canonical_key)
			VALUES (9020, 'abcd', 'sha-frog-2', 'dhash', 'canon-frog')
		`).run()

		const stats = promoteListingsToProductMap(dest, true)
		assert.ok(stats.insert >= 1)
		assert.ok(stats.alias >= 1)
		assert.equal(dest.prepare("SELECT COUNT(*) AS n FROM product_map WHERE title_norm = 'keep case'").get().n, 1)
		const frogId = dest.prepare("SELECT id FROM product_map WHERE title_norm = 'frog case'").get().id
		const alias = dest.prepare("SELECT product_id FROM product_map_title_aliases WHERE title_norm = 'frog case iphone 18'").get()
		assert.ok(alias)
		assert.equal(alias.product_id, frogId)
		const frog = dest.prepare("SELECT canonical_product_key FROM product_map WHERE title_norm = 'frog case'").get()
		assert.equal(frog.canonical_product_key, 'canon-frog')

		const catalog = buildCatalogImageResolver(dest, { fuzzy: false })
		const viaAlias = catalog.resolve(normalizeTitle('Frog Case iPhone 18'), 'Frog Case iPhone 18')
		assert.ok(viaAlias)
		assert.equal(viaAlias.url, 'https://img.example/frog.jpg')

		const again = promoteListingsToProductMap(dest, true)
		assert.equal(again.insert, 0)
		assert.equal(again.alias, 0)
	} finally {
		dest.close()
	}
})

test('resolveAllHistoryShops includes every listing shop except the manual shop', () => {
	const dir = tempDir()
	const sourcePath = path.join(dir, 'source.db')
	const source = initDb(sourcePath)
	seedSource(source)
	try {
		const resolved = resolveAllHistoryShops(source)
		assert.deepEqual(resolved.targets.map((t) => t.shopId).sort(), [
			'CuteiPhoneCasesFinds',
			'GoneA',
			'KeepShop',
		])
		assert.equal(resolved.missing.length, 0)
	} finally {
		source.close()
	}
})

if (failures) {
	console.error(`\n${failures} failed`)
	process.exit(1)
}
console.log('\nAll catalog-restore tests passed.')
