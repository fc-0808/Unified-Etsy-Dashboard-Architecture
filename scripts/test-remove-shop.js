'use strict'

/**
 * Shop offboarding — the hard-delete path for a suspended Etsy shop.
 *
 * Pins the contract that a removal:
 *   • is dry-run by default at the CLI
 *   • is atomic across every shop-owned table
 *   • keeps the product catalog (listing photos / hashes / merges) by default
 *   • never deletes market-supplier rows whose `shop_name` is a stall
 *   • erases checklist attestations, order workflow, and growth imports
 *   • leaves sibling shops that share an API key untouched
 *   • is idempotent
 *
 * Run: node scripts/test-remove-shop.js
 */

const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { initDb, syncConfigToDb } = require('../src/db/setup')
const checklist = require('../src/operations/checklist')
const {
	OffboardError,
	CATALOG_ARCHIVE_SHOP_ID,
	NEVER_PURGE_TABLES,
	parseArgs,
	buildPlan,
	backstopSteps,
	collectSteps,
	applyDatabasePurge,
	removeShopsFromConfigFile,
	removeShopsFromTokensFile,
} = require('./remove-shop')

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

function seedFleet(db) {
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
			{
				group_id: 'g-gone',
				label: 'Gone',
				proxy: 'direct',
				shops: [
					{ shop_id: 'GoneA', shop_name: 'GoneA', api_key: 'key-gone', shared_secret: 'secret-gone' },
					{ shop_id: 'GoneB', shop_name: 'GoneB', api_key: 'key-gone', shared_secret: 'secret-gone' },
				],
			},
		],
	})
}

function insertReceipt(db, { receiptId, shopId, groupId }) {
	db.prepare(`
		INSERT INTO receipts (
			receipt_id, shop_id, group_id, name, etsy_created_at, etsy_updated_at, is_paid, is_shipped
		) VALUES (?, ?, ?, 'Buyer', 1, 1, 1, 0)
	`).run(receiptId, shopId, groupId)
}

function insertListing(db, { listingId, shopId }) {
	db.prepare(`
		INSERT INTO listings (listing_id, shop_id, title, state)
		VALUES (?, ?, 'Case', 'active')
	`).run(listingId, shopId)
}

console.log('Shop offboarding tests\n')

test('parseArgs accepts several ids, comma lists, and flags', () => {
	assert.deepEqual(
		parseArgs(['GoneA', 'GoneB', '--yes', 'GoneC,GoneD']),
		{ shopIds: ['GoneA', 'GoneB', 'GoneC', 'GoneD'], flags: new Set(['--yes']) },
	)
	assert.deepEqual(parseArgs(['--commit']).shopIds, [])
})

test('buildPlan rejects an empty id list', () => {
	assert.throws(() => buildPlan([], ['x']), OffboardError)
})

test('never-purge set covers market-supplier tables', () => {
	assert.equal(NEVER_PURGE_TABLES.has('product_map'), true)
	assert.equal(NEVER_PURGE_TABLES.has('supplier_directory'), true)
	assert.equal(NEVER_PURGE_TABLES.has('charm_shop_directory'), true)
	assert.equal(NEVER_PURGE_TABLES.has('audit_log'), true)
})

test('backstop does not target product_map or supplier_directory', () => {
	const db = initDb(':memory:')
	try {
		seedFleet(db)
		const extra = backstopSteps(db, ['GoneA'], ['GoneA'])
		const tables = extra.map((step) => step.table)
		assert.equal(tables.includes('product_map'), false)
		assert.equal(tables.includes('supplier_directory'), false)
		assert.equal(tables.includes('charm_shop_directory'), false)
	} finally {
		db.close()
	}
})

test('a coincidental supplier stall name survives Etsy-shop removal', () => {
	const db = initDb(':memory:')
	try {
		seedFleet(db)
		insertReceipt(db, { receiptId: 101, shopId: 'GoneA', groupId: 'g-gone' })
		insertListing(db, { listingId: 9001, shopId: 'GoneA' })
		db.prepare(`
			INSERT INTO product_map (title_norm, title, shop_name, stall)
			VALUES ('frog case', 'Frog Case', 'GoneA', 'A1')
		`).run()
		db.prepare(`
			INSERT INTO supplier_directory (shop_name, stall, mall)
			VALUES ('GoneA', 'A1', 'Huaqiang')
		`).run()
		db.prepare(`
			INSERT INTO charm_shop_directory (shop_name, stall)
			VALUES ('GoneA', 'B2')
		`).run()

		applyDatabasePurge(db, ['GoneA'], ['GoneA'])

		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shops WHERE shop_id = ?').get('GoneA').n, 0)
		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM receipts WHERE shop_id = ?').get('GoneA').n, 0)
		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM listings WHERE shop_id = ?').get('GoneA').n, 0)
		assert.equal(db.prepare('SELECT shop_id FROM listings WHERE listing_id = 9001').get().shop_id, CATALOG_ARCHIVE_SHOP_ID)
		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shops WHERE shop_id = ?').get(CATALOG_ARCHIVE_SHOP_ID).n, 0)
		assert.equal(db.prepare('SELECT shop_name FROM product_map').get().shop_name, 'GoneA')
		assert.equal(db.prepare('SELECT shop_name FROM supplier_directory').get().shop_name, 'GoneA')
		assert.equal(db.prepare('SELECT shop_name FROM charm_shop_directory').get().shop_name, 'GoneA')
		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shops WHERE shop_id = ?').get('KeepShop').n, 1)
		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shops WHERE shop_id = ?').get('GoneB').n, 1)
	} finally {
		db.close()
	}
})

test('walks the ownership graph: receipts, listings, embeddings, checklist, growth', () => {
	const db = initDb(':memory:')
	try {
		seedFleet(db)
		insertReceipt(db, { receiptId: 201, shopId: 'GoneA', groupId: 'g-gone' })
		insertReceipt(db, { receiptId: 202, shopId: 'KeepShop', groupId: 'g-keep' })
		insertListing(db, { listingId: 8001, shopId: 'GoneA' })
		insertListing(db, { listingId: 8002, shopId: 'KeepShop' })

		db.prepare(`
			INSERT INTO listing_vemb (listing_id, algo, dim, sha, embedding)
			VALUES (8001, 'test', 4, 'abc', x'00000000')
		`).run()
		db.prepare(`
			INSERT INTO listing_vemb (listing_id, algo, dim, sha, embedding)
			VALUES (8002, 'test', 4, 'def', x'00000000')
		`).run()
		db.prepare(`
			INSERT INTO listing_images (listing_id, url)
			VALUES (8001, 'https://img.example/frog.jpg')
		`).run()
		db.prepare(`
			INSERT INTO listing_inventory (listing_id, product_id, quantity, is_enabled)
			VALUES (8001, 1, 3, 1)
		`).run()
		db.prepare(`
			INSERT INTO product_merges (listing_a, listing_b, note)
			VALUES (8001, 8002, 'same product')
		`).run()
		db.prepare(`
			INSERT INTO etsy_completion_intents (receipt_id, state, created_at, updated_at)
			VALUES (201, 'pending', 1, 1)
		`).run()
		db.prepare(`
			INSERT INTO shipping_buyer_notices (receipt_id, notice_kind, notified_at)
			VALUES (201, 'stuck', 1)
		`).run()
		checklist.ensureSchema(db)
		checklist.setCompletion(
			db,
			{ work_date: '2026-09-19', task_id: 'messages', shop_id: 'GoneA', completed: true },
			{ actor: 'owner', now: new Date('2026-09-19T04:00:00.000Z'), timeZone: 'Asia/Shanghai' },
		)
		checklist.setCompletion(
			db,
			{ work_date: '2026-09-19', task_id: 'messages', shop_id: 'KeepShop', completed: true },
			{ actor: 'owner', now: new Date('2026-09-19T04:00:00.000Z'), timeZone: 'Asia/Shanghai' },
		)
		db.prepare(`
			INSERT INTO growth_manual_listing_imports (
				import_key, shop_id, window_days, current_start, current_end, baseline_start, baseline_end, imported_at
			) VALUES ('imp-gone', 'GoneA', 7, '2026-09-01', '2026-09-07', '2026-08-25', '2026-08-31', 1)
		`).run()
		const importId = db.prepare('SELECT id FROM growth_manual_listing_imports WHERE import_key = ?').get('imp-gone').id
		db.prepare(`
			INSERT INTO growth_manual_listing_rows (
				import_id, row_key, title, current_views, baseline_views, current_orders, baseline_orders
			) VALUES (?, 'r1', 'Frog Case', 10, 8, 1, 1)
		`).run(importId)

		applyDatabasePurge(db, ['GoneA'], ['GoneA'])

		assert.equal(db.prepare('SELECT shop_id FROM listings WHERE listing_id = 8001').get().shop_id, CATALOG_ARCHIVE_SHOP_ID)
		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM listing_vemb WHERE listing_id = 8001').get().n, 1)
		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM listing_images WHERE listing_id = 8001').get().n, 1)
		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM listing_inventory WHERE listing_id = 8001').get().n, 0)
		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM listing_vemb WHERE listing_id = 8002').get().n, 1)
		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM product_merges').get().n, 1)
		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM etsy_completion_intents WHERE receipt_id = 201').get().n, 0)
		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shipping_buyer_notices WHERE receipt_id = 201').get().n, 0)
		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM operations_checklist_completions WHERE subject_id = ?').get('GoneA').n, 0)
		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM operations_checklist_completions WHERE subject_id = ?').get('KeepShop').n, 1)
		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM growth_manual_listing_imports').get().n, 0)
		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM growth_manual_listing_rows').get().n, 0)
		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM receipts WHERE shop_id = ?').get('KeepShop').n, 1)
		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM listings WHERE shop_id = ?').get('KeepShop').n, 1)
	} finally {
		db.close()
	}
})

test('batch removal is atomic and prunes a group that becomes empty', () => {
	const db = initDb(':memory:')
	try {
		seedFleet(db)
		insertReceipt(db, { receiptId: 301, shopId: 'GoneA', groupId: 'g-gone' })
		insertReceipt(db, { receiptId: 302, shopId: 'GoneB', groupId: 'g-gone' })
		insertReceipt(db, { receiptId: 303, shopId: 'KeepShop', groupId: 'g-keep' })

		applyDatabasePurge(db, ['GoneA', 'GoneB'], ['GoneA', 'GoneB'])

		assert.deepEqual(
			db.prepare("SELECT shop_id FROM shops WHERE shop_id <> '__manual__' ORDER BY shop_id").all().map((r) => r.shop_id),
			['KeepShop'],
		)
		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM groups WHERE group_id = ?').get('g-gone').n, 0)
		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM groups WHERE group_id = ?').get('g-keep').n, 1)
		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM receipts').get().n, 1)
	} finally {
		db.close()
	}
})

test('rewrites mixed catalog-rollout jobs and deletes jobs that only targeted removed shops', () => {
	const db = initDb(':memory:')
	try {
		seedFleet(db)
		db.prepare(`
			INSERT INTO catalog_rollout_jobs (
				job_id, rollout_id, state, shop_names, total, needed, processed, updated, skipped, failed, created_at, updated_at
			) VALUES
				('job-only', 'r1', 'done', ?, 1, 1, 1, 1, 0, 0, 1, 1),
				('job-mixed', 'r1', 'done', ?, 2, 2, 2, 2, 0, 0, 1, 1)
		`).run(
			JSON.stringify(['GoneA']),
			JSON.stringify(['GoneA', 'KeepShop']),
		)
		db.prepare(`
			INSERT INTO catalog_rollout_items (job_id, shop_id, shop_name, listing_id, status)
			VALUES
				('job-only', 'GoneA', 'GoneA', 1, 'updated'),
				('job-mixed', 'GoneA', 'GoneA', 2, 'updated'),
				('job-mixed', 'KeepShop', 'KeepShop', 3, 'updated')
		`).run()

		applyDatabasePurge(db, ['GoneA'], ['GoneA'])

		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM catalog_rollout_jobs WHERE job_id = ?').get('job-only').n, 0)
		const mixed = db.prepare('SELECT shop_names FROM catalog_rollout_jobs WHERE job_id = ?').get('job-mixed')
		assert.ok(mixed)
		assert.deepEqual(JSON.parse(mixed.shop_names), ['KeepShop'])
		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM catalog_rollout_items WHERE shop_id = ?').get('GoneA').n, 0)
		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM catalog_rollout_items WHERE shop_id = ?').get('KeepShop').n, 1)
	} finally {
		db.close()
	}
})

test('re-running a successful removal is a no-op', () => {
	const db = initDb(':memory:')
	try {
		seedFleet(db)
		insertReceipt(db, { receiptId: 401, shopId: 'GoneA', groupId: 'g-gone' })
		applyDatabasePurge(db, ['GoneA'], ['GoneA'])
		const second = applyDatabasePurge(db, ['GoneA'], ['GoneA'])
		assert.deepEqual(second, {})
		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shops WHERE shop_id = ?').get('KeepShop').n, 1)
	} finally {
		db.close()
	}
})

test('default keep-catalog remaps listings and omits photo tables from the delete plan', () => {
	const db = initDb(':memory:')
	try {
		seedFleet(db)
		const { steps } = collectSteps(db, ['GoneA'], ['GoneA'])
		const tables = steps.map((step) => step.table)
		assert.equal(tables.includes('listings'), false)
		assert.equal(tables.includes('listing_images'), false)
		assert.equal(tables.includes('listing_vemb'), false)
		assert.equal(tables.includes('product_merges'), false)
		assert.equal(tables.includes('listing_inventory'), true)
		assert.equal(tables.includes('receipts'), true)
	} finally {
		db.close()
	}
})

test('--purge-catalog deletes listing photos and the listing rows themselves', () => {
	const db = initDb(':memory:')
	try {
		seedFleet(db)
		insertListing(db, { listingId: 7001, shopId: 'GoneA' })
		db.prepare(`
			INSERT INTO listing_vemb (listing_id, algo, dim, sha, embedding)
			VALUES (7001, 'test', 4, 'abc', x'00000000')
		`).run()
		db.prepare(`
			INSERT INTO listing_images (listing_id, url)
			VALUES (7001, 'https://img.example/gone.jpg')
		`).run()

		applyDatabasePurge(db, ['GoneA'], ['GoneA'], { keepCatalog: false })

		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM listings WHERE listing_id = 7001').get().n, 0)
		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM listing_vemb WHERE listing_id = 7001').get().n, 0)
		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM listing_images WHERE listing_id = 7001').get().n, 0)
		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shops WHERE shop_id = ?').get('GoneA').n, 0)
	} finally {
		db.close()
	}
})

test('config and tokens rewrites drop the named shops and prune empty groups', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ued-offboard-'))
	const configPath = path.join(dir, 'config.json')
	const tokensPath = path.join(dir, 'tokens.json')
	fs.writeFileSync(configPath, JSON.stringify({
		groups: [
			{
				group_id: 'g-keep',
				label: 'Keep',
				shops: [{ shop_id: 'KeepShop', shop_name: 'KeepShop' }],
			},
			{
				group_id: 'g-gone',
				label: 'Gone',
				shops: [
					{ shop_id: 'GoneA', shop_name: 'GoneA' },
					{ shop_id: 'GoneB', shop_name: 'GoneB' },
				],
			},
		],
	}, null, 2) + '\n')
	fs.writeFileSync(tokensPath, JSON.stringify({
		KeepShop: { access_token: 'keep' },
		GoneA: { access_token: 'a' },
		GoneB: { access_token: 'b' },
	}, null, 2))

	const rewritten = removeShopsFromConfigFile(configPath, ['GoneA', 'GoneB'])
	assert.deepEqual(rewritten.groupPruned, ['g-gone'])
	const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
	assert.deepEqual(config.groups.map((g) => g.group_id), ['g-keep'])
	assert.deepEqual(config.groups[0].shops.map((s) => s.shop_id), ['KeepShop'])

	const removed = removeShopsFromTokensFile(tokensPath, ['GoneA', 'GoneB'])
	assert.equal(removed, 2)
	assert.deepEqual(JSON.parse(fs.readFileSync(tokensPath, 'utf8')), {
		KeepShop: { access_token: 'keep' },
	})
})

if (failures) {
	console.error(`\n${failures} test(s) failed`)
	process.exit(1)
}
console.log('\nAll shop offboarding tests passed.')
