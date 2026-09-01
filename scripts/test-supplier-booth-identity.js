'use strict'
/**
 * Supplier / charm-shop booth identity — case twins must never invent a second
 * booth for the same physical stop (汇通A146 vs 汇通a146).
 *
 * Pins the write paths that keep the directory clean going forward:
 *   · Excel replace folds twins before insert (prefer uppercase / richer row).
 *   · In-app insert/update reject a case-variant as DUPLICATE.
 *   · Startup migration collapses twins already in the DB and rewrites
 *     product_map / product_assignments / route_assignments onto the spelling
 *     we kept — so the greyed-out "ext" picker card cannot come back.
 *
 * Run: `node scripts/test-supplier-booth-identity.js`
 */

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
	initDb,
	replaceSupplierDirectory,
	replaceCharmShopDirectory,
	insertSupplierDirectoryRow,
	insertCharmShopDirectoryRow,
	getSupplierDirectory,
	getCharmShopDirectory,
	foldBoothRowsByIdentity,
	preferBoothRow,
	migrateSupplierBoothIdentityDuplicates,
	migrateCharmShopBoothIdentityDuplicates,
	upsertProductMapRow,
	upsertRouteAssignment,
	getProductMap,
	getRouteAssignment,
} = require('../src/db/setup')
const stallLocation = require('../src/route/stall-location')

const GREEN = '\x1b[32m',
	RED = '\x1b[31m',
	DIM = '\x1b[2m',
	BOLD = '\x1b[1m',
	RESET = '\x1b[0m'
let passed = 0,
	failed = 0
const failures = []
const pending = []
const group = (name) => pending.push({ group: name })
const test = (name, fn) => pending.push({ name, fn })

function openDb() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ued-booth-'))
	const dbPath = path.join(dir, 't.db')
	const db = initDb(dbPath)
	db.__dir = dir
	return db
}

function closeDb(db) {
	try {
		db.close()
	} catch {
		/* */
	}
	try {
		fs.rmSync(db.__dir, { recursive: true, force: true })
	} catch {
		/* */
	}
}

// ─────────────────────────────────────────────────────────────────────────────
group('Folding a dirty import')

test('Excel replace collapses A146 / a146 into one booth', () => {
	const db = openDb()
	try {
		const n = replaceSupplierDirectory(db, [
			{ shop_name: 'leo', stall: '汇通a146', mall: '', sort_order: 0 },
			{ shop_name: 'leo', stall: '汇通A146', mall: '汇通', sort_order: 1 },
			{ shop_name: '锐成', stall: '经济5D16', sort_order: 2 },
		])
		assert.strictEqual(n, 2, 'two identities must remain after the fold')
		const rows = getSupplierDirectory(db)
		assert.strictEqual(rows.length, 2)
		const leo = rows.find((r) => r.shop_name === 'leo')
		assert.ok(leo, 'leo is missing')
		assert.strictEqual(leo.stall, '汇通A146', 'uppercase spelling must win')
		assert.strictEqual(leo.mall, '汇通', 'the richer row must be kept')
		assert.ok(!rows.some((r) => r.stall === '汇通a146'), 'lowercase twin must be gone')
	} finally {
		closeDb(db)
	}
})

test('charm-shop replace folds the same way', () => {
	const db = openDb()
	try {
		const n = replaceCharmShopDirectory(db, [
			{ shop_name: '彩虹', stall: '2d21', sort_order: 0 },
			{ shop_name: '彩虹', stall: '2D21', sort_order: 1 },
		])
		assert.strictEqual(n, 1)
		const rows = getCharmShopDirectory(db)
		assert.strictEqual(rows.length, 1)
		assert.strictEqual(rows[0].stall, '2D21')
	} finally {
		closeDb(db)
	}
})

test('foldBoothRowsByIdentity is pure and prefers uppercase stalls', () => {
	const folded = foldBoothRowsByIdentity([
		{ shop_name: 'V8', stall: 'a2-29' },
		{ shop_name: 'V8', stall: 'A2-29' },
		{ shop_name: 'v8', stall: 'A2-30' },
	])
	assert.strictEqual(folded.length, 2)
	const a229 = folded.find((r) => stallLocation.supplierIdentityKey(r.shop_name, r.stall) === stallLocation.supplierIdentityKey('V8', 'A2-29'))
	assert.strictEqual(a229.stall, 'A2-29')
	assert.strictEqual(preferBoothRow({ stall: 'a146' }, { stall: 'A146' }).stall, 'A146')
})

// ─────────────────────────────────────────────────────────────────────────────
group('In-app CRUD rejects case twins')

test('inserting a case-variant supplier is DUPLICATE', () => {
	const db = openDb()
	try {
		insertSupplierDirectoryRow(db, { shop_name: 'leo', stall: '汇通A146' })
		let code = null
		try {
			insertSupplierDirectoryRow(db, { shop_name: 'Leo', stall: '汇通a146' })
		} catch (e) {
			code = e.code
		}
		assert.strictEqual(code, 'DUPLICATE')
		assert.strictEqual(getSupplierDirectory(db).length, 1)
	} finally {
		closeDb(db)
	}
})

test('inserting a case-variant charm shop is DUPLICATE', () => {
	const db = openDb()
	try {
		insertCharmShopDirectoryRow(db, { shop_name: '彩虹', stall: '2D21' })
		let code = null
		try {
			insertCharmShopDirectoryRow(db, { shop_name: '彩虹', stall: '2d21' })
		} catch (e) {
			code = e.code
		}
		assert.strictEqual(code, 'DUPLICATE')
	} finally {
		closeDb(db)
	}
})

// ─────────────────────────────────────────────────────────────────────────────
group('Startup heal collapses twins already in the DB')

test('migration removes a case twin and rewrites route + product_map refs', () => {
	const db = openDb()
	try {
		// Bypass fold: write both spellings via raw SQL (simulates a pre-fix DB).
		db.prepare(
			`INSERT INTO supplier_directory (shop_name, stall, mall, floor, address, notes, sort_order, updated_at)
       VALUES (?, ?, '', '', '', '', 0, strftime('%s','now'))`,
		).run('leo', '汇通A146')
		db.prepare(
			`INSERT INTO supplier_directory (shop_name, stall, mall, floor, address, notes, sort_order, updated_at)
       VALUES (?, ?, '', '', '', '', 1, strftime('%s','now'))`,
		).run('leo', '汇通a146')

		upsertProductMapRow(db, {
			title: 'Pear Green AirPods Case',
			shop_name: 'leo',
			stall: '汇通a146',
		})
		upsertRouteAssignment(db, {
			receipt_id: 1,
			item_key: 'k#L1',
			supplier_shop_override: 'leo',
			supplier_stall_override: '汇通a146',
		})

		assert.strictEqual(getSupplierDirectory(db).length, 2, 'fixture must seed two twins')

		const { removed, rewritten } = migrateSupplierBoothIdentityDuplicates(db)
		assert.ok(removed >= 1, 'at least one twin must be deleted')
		assert.ok(rewritten >= 1, 'references must be rewritten onto the kept spelling')

		const rows = getSupplierDirectory(db)
		assert.strictEqual(rows.length, 1)
		assert.strictEqual(rows[0].stall, '汇通A146')

		const pm = getProductMap(db).find((r) => /Pear Green/i.test(r.title))
		assert.ok(pm)
		assert.strictEqual(pm.stall, '汇通A146', 'product_map must carry the directory spelling')

		const ra = getRouteAssignment(db, 1, 'k#L1')
		assert.ok(ra)
		assert.strictEqual(ra.supplier_stall_override, '汇通A146', 'route override must be canonised')
	} finally {
		closeDb(db)
	}
})

test('migration is a no-op on a clean directory', () => {
	const db = openDb()
	try {
		replaceSupplierDirectory(db, [{ shop_name: '锐成', stall: '经济5D16' }])
		const again = migrateSupplierBoothIdentityDuplicates(db)
		assert.deepStrictEqual(again, { removed: 0, rewritten: 0 })
	} finally {
		closeDb(db)
	}
})

test('charm-shop migration collapses twins', () => {
	const db = openDb()
	try {
		db.prepare(
			`INSERT INTO charm_shop_directory (shop_name, stall, notes, sort_order, updated_at)
       VALUES (?, ?, '', 0, strftime('%s','now'))`,
		).run('彩虹', '2D21')
		db.prepare(
			`INSERT INTO charm_shop_directory (shop_name, stall, notes, sort_order, updated_at)
       VALUES (?, ?, '', 1, strftime('%s','now'))`,
		).run('彩虹', '2d21')
		const { removed } = migrateCharmShopBoothIdentityDuplicates(db)
		assert.ok(removed >= 1)
		assert.strictEqual(getCharmShopDirectory(db).length, 1)
		assert.strictEqual(getCharmShopDirectory(db)[0].stall, '2D21')
	} finally {
		closeDb(db)
	}
})

// ─────────────────────────────────────────────────────────────────────────────
async function run() {
	for (const item of pending) {
		if (item.group) {
			console.log(`\n${BOLD}${item.group}${RESET}`)
			continue
		}
		try {
			await item.fn()
			passed++
			console.log(`  ${GREEN}✓${RESET} ${item.name}`)
		} catch (err) {
			failed++
			failures.push({ name: item.name, err })
			console.log(`  ${RED}✗${RESET} ${item.name}`)
			console.log(`    ${DIM}${err.message}${RESET}`)
		}
	}
	console.log(`\n${BOLD}Supplier booth identity${RESET}`)
	console.log(`${GREEN}${passed} passed${RESET}${failed ? `, ${RED}${failed} failed${RESET}` : ''}`)
	if (failures.length) {
		for (const f of failures) {
			console.error(`\n${RED}${f.name}${RESET}`)
			console.error(f.err.stack)
		}
		process.exit(1)
	}
}

run()
