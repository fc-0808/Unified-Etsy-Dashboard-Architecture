'use strict'

/**
 * Unit tests for Sourcing-drawer product_map merges.
 * Run: `node scripts/test-product-map-merge.js`
 */

const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { initDb, upsertProductMapRow, getProductMap } = require('../src/db/setup')
const productMapMerge = require('../src/route/product-map-merge')
const productMerges = require('../src/route/product-merges')

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
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-merge-'))
	const db = initDb(path.join(dir, `${label || 't'}.db`))
	db._tmpdir = dir
	return db
}

console.log(`\n${BOLD}product-map merge${RESET}\n`)

test('chooseCanonicalKey prefers an existing P- key, else mints manual:pm-<minId>', () => {
	assert.equal(productMapMerge.chooseCanonicalKey([{ id: 9, canonical_product_key: '' }, { id: 3, canonical_product_key: 'P-88' }]), 'P-88')
	assert.equal(productMapMerge.chooseCanonicalKey([{ id: 9, canonical_product_key: '' }, { id: 3, canonical_product_key: '' }]), 'manual:pm-3')
})

test('merge writes a shared canonical key on both product_map rows', () => {
	const db = openDb('shared-key')
	try {
		upsertProductMapRow(db, { title: 'Hello Kitty MagSafe Case Shop A', shop_name: 'HAN', stall: 'A2-29', cost_case: 12 })
		upsertProductMapRow(db, { title: 'Cute Hello Kitty MagSafe Case Shop B', shop_name: 'HAN', stall: 'A2-29', cost_case: 12 })
		const rows = getProductMap(db)
		const ids = rows.map((r) => r.id)
		const result = productMapMerge.mergeProductMapRows(db, ids, { createdBy: 'tester' })
		assert.equal(result.canonical_product_key, `manual:pm-${Math.min(...ids)}`)
		const keys = getProductMap(db).map((r) => r.canonical_product_key)
		assert.ok(keys.every((k) => k === result.canonical_product_key))
		assert.equal(result.edges_inserted, 0)
	} finally {
		db.close()
		fs.rmSync(db._tmpdir, { recursive: true, force: true })
	}
})

test('when listing titles resolve, merge also inserts product_merges edges', () => {
	const db = openDb('with-listings')
	try {
		db.prepare(
			"INSERT INTO listings (listing_id, shop_id, title, primary_image_url, state) VALUES (?, ?, ?, ?, 'active')",
		).run(1001, 'SHOP-1', 'Alpha Case Title', 'https://example.test/a.jpg')
		db.prepare(
			"INSERT INTO listings (listing_id, shop_id, title, primary_image_url, state) VALUES (?, ?, ?, ?, 'active')",
		).run(1002, 'SHOP-1', 'Beta Case Title', 'https://example.test/b.jpg')
		upsertProductMapRow(db, { title: 'Alpha Case Title', shop_name: 'HAN', stall: 'A2-29', cost_case: 10 })
		upsertProductMapRow(db, { title: 'Beta Case Title', shop_name: 'HAN', stall: 'A2-29', cost_case: 10 })
		const ids = getProductMap(db).map((r) => r.id)
		const result = productMapMerge.mergeProductMapRows(db, ids, { note: 'test' })
		assert.deepEqual(result.listing_ids, [1001, 1002])
		assert.ok(result.edges_inserted >= 1)
		const edges = productMerges.getMergeEdges(db)
		assert.ok(edges.some((e) => e.listing_a === 1001 && e.listing_b === 1002))
	} finally {
		db.close()
		fs.rmSync(db._tmpdir, { recursive: true, force: true })
	}
})

test('refuses fewer than two products', () => {
	const db = openDb('solo')
	try {
		upsertProductMapRow(db, { title: 'Solo', shop_name: 'HAN', stall: 'A2-29', cost_case: 1 })
		const id = getProductMap(db)[0].id
		assert.throws(() => productMapMerge.mergeProductMapRows(db, [id]), /at least two/i)
	} finally {
		db.close()
		fs.rmSync(db._tmpdir, { recursive: true, force: true })
	}
})

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)
