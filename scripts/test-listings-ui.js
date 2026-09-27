'use strict'

/**
 * Listings tab UI contract: actions stay fully visible, every row names its
 * device models, and painting the table never fans out extra Etsy inventory
 * calls.
 *
 * Run: node scripts/test-listings-ui.js
 */

const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const HTML = path.resolve(__dirname, '../public/index.html')
const SERVER = path.resolve(__dirname, '../src/server/index.js')
const source = fs.readFileSync(HTML, 'utf8').replace(/\r\n/g, '\n')
const server = fs.readFileSync(SERVER, 'utf8').replace(/\r\n/g, '\n')

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const RESET = '\x1b[0m'
let passed = 0
let failed = 0

function test(name, fn) {
	try {
		fn()
		passed += 1
		console.log(`  ${GREEN}ok${RESET}  — ${name}`)
	} catch (err) {
		failed += 1
		console.error(`  ${RED}FAIL${RESET} — ${name}`)
		console.error(`         ${err.message}`)
	}
}

function listingsMarkup() {
	const start = source.indexOf('id="tab-listings"')
	const end = source.indexOf('id="tab-bulk"', start)
	assert.ok(start >= 0 && end > start, 'Listings tab markup is missing')
	return source.slice(start, end)
}

function listingsCss() {
	const start = source.indexOf('/* ── Listings tab')
	const end = source.indexOf('/* Urgent-order quick-select button', start)
	assert.ok(start >= 0 && end > start, 'Listings tab CSS block is missing')
	return source.slice(start, end)
}

console.log('Listings tab UI contract\n')

test('listing rows do not paint Etsy tags under the title', () => {
	const start = source.indexOf('function buildListingRow(l) {')
	const end = source.indexOf('async function fetchListings()', start)
	const body = source.slice(start, end)
	assert.doesNotMatch(body, /listing-tags/)
	assert.doesNotMatch(body, /listing-tag/)
	assert.doesNotMatch(body, /\.tags\s*\|\|/)
	assert.doesNotMatch(listingsMarkup(), /listing-tags/)
})

test('Updated sits in its own column instead of under sticky Actions', () => {
	const css = listingsCss()
	assert.match(listingsMarkup(), /class="listing-updated-col">Updated/)
	assert.match(source, /class="listing-updated-cell"/)
	assert.match(source, /class="listing-updated-date"/)
	assert.match(source, /function fmtListingUpdated\(/)
	assert.match(css, /\.listing-updated-date,[\s\S]*white-space:\s*nowrap/)
	assert.doesNotMatch(css, /position:\s*sticky/)
	const start = source.indexOf('function fmtListingUpdated(')
	const end = source.indexOf('function badge(', start)
	assert.ok(start >= 0 && end > start, 'fmtListingUpdated helper is missing')
	const context = { result: null }
	vm.runInNewContext(`${source.slice(start, end)}\nresult = fmtListingUpdated(1760110320)`, context)
	assert.equal(typeof context.result.date, 'string')
	assert.equal(typeof context.result.time, 'string')
	assert.equal(typeof context.result.text, 'string')
	assert.equal(/\n/.test(context.result.text), false)
	assert.ok(context.result.date.length <= 12, `updated date too long: ${context.result.date}`)
	assert.ok(context.result.time.length <= 12, `updated time too long: ${context.result.time}`)
})

test('Listings table fits the page width without a horizontal scrollbar', () => {
	const css = listingsCss()
	assert.match(css, /#tab-listings \.table-wrap \{[\s\S]*overflow-x:\s*hidden/)
	assert.match(css, /#tab-listings #listingsTable \{[\s\S]*table-layout:\s*fixed/)
	assert.match(css, /#tab-listings \.inv-strip \{[\s\S]*flex-wrap:\s*wrap/)
	assert.doesNotMatch(css, /width:\s*max-content/)
	assert.doesNotMatch(css, /min-width:\s*168px/)
	assert.doesNotMatch(css, /overflow-x:\s*auto/)
})

test('Actions stay on one row without forcing the table past the page', () => {
	const markup = listingsMarkup()
	assert.doesNotMatch(markup, /<th[^>]*style="width:\s*110px"[^>]*>Actions/)
	assert.match(markup, /class="listing-actions-col">Actions/)
	assert.match(markup, /<colgroup>/)
	assert.match(listingsCss(), /\.listing-actions \{[\s\S]*flex-wrap:\s*nowrap/)
	assert.match(listingsCss(), /col\.listing-col-actions \{[\s\S]*width:\s*17%/)
})

test('Edit and Delete are dedicated unclipped action buttons', () => {
	assert.match(source, /class="listing-act listing-act-edit"/)
	assert.match(source, /class="listing-act listing-act-delete"/)
	assert.match(source, /onclick="confirmDeleteListing\(/)
	assert.match(listingsCss(), /\.listing-act-delete \{/)
	assert.match(listingsCss(), /white-space:\s*nowrap/)
})

test('every listing row renders device coverage in the title cell, not a hidden column', () => {
	assert.match(source, /function buildListingModelsHtml\(/)
	assert.match(source, /const modelsHtml = buildListingModelsHtml\(l\.device_coverage, l\.title\)/)
	assert.match(source, /function fallbackCoverageFromTitle\(/)
	assert.match(source, /<div class="listing-title">\$\{link\}<\/div>\s*\$\{modelsHtml\}/)
	assert.match(source, /class="listing-models/)
	assert.match(source, /class="listing-model-chip"/)
	const collapsed = source.slice(
		source.indexOf('#tab-listings .listing-card-row:not(.is-open) td:nth-child(n + 3)'),
		source.indexOf('#tab-listings .listing-card-row.is-open .listing-mobile-summary'),
	)
	assert.doesNotMatch(collapsed, /listing-models/)
})

test('painting listings reads the local cache only — no per-row Etsy inventory fan-out', () => {
	const fetchStart = source.indexOf('async function fetchListings()')
	const fetchEnd = source.indexOf('function changeListPage(', fetchStart)
	const fetchBody = source.slice(fetchStart, fetchEnd)
	assert.match(fetchBody, /\/api\/listings\?/)
	assert.doesNotMatch(fetchBody, /\/api\/inventory\//)
	assert.doesNotMatch(fetchBody, /getListingInventory/)
	assert.match(server, /deviceCoverage\.attachDeviceCoverageToListings/)
	assert.match(server, /never fan out getListingInventory/)
	assert.match(server, /SELECT DISTINCT listing_id, secondary_value/)
})

test('Delete still goes through the documented listings delete endpoint after an explicit confirm', () => {
	const start = source.indexOf('async function confirmDeleteListing')
	const end = source.indexOf('// ── Bulk price by variation', start)
	const body = source.slice(start, end)
	assert.match(body, /showConfirmDialog/)
	assert.match(body, /method: 'DELETE'/)
	assert.match(body, /\/api\/listings\/\$\{listingId\}/)
	assert.match(body, /shop_name: shopName/)
})

test('toolbar is grouped and no longer uses clipped decorative prefixes', () => {
	const markup = listingsMarkup()
	assert.match(markup, /class="filters listings-toolbar"/)
	assert.match(markup, /listings-toolbar-primary/)
	assert.match(markup, /listings-toolbar-actions/)
	assert.doesNotMatch(markup, /＄ Bulk price/)
	assert.doesNotMatch(markup, /⊞ Manage sections/)
	assert.match(markup, />Bulk price</)
	assert.match(markup, />Manage sections</)
})

test('buildListingModelsHtml escapes model labels before they hit innerHTML', () => {
	const slice = (startNeedle, endNeedle) => {
		const start = source.indexOf(startNeedle)
		const end = source.indexOf(endNeedle, start + startNeedle.length)
		assert.ok(start >= 0 && end > start, `missing ${startNeedle}`)
		return source.slice(start, end)
	}
	const helpers =
		slice('function toDisplayString(value) {', 'function recalcDeclared()') +
		'\n' +
		slice('function escAttr(str) {', 'function jsAttr(str) {') +
		'\n' +
		slice('function fallbackCoverageFromTitle(title) {', 'function buildListingRow(l) {')
	const context = { result: '' }
	vm.runInNewContext(`${helpers}\nresult = buildListingModelsHtml({ family_label: 'iPhone', chips: ['17 <Pro>'], models: ['iPhone 17 <Pro>'], source: 'inventory' })`, context)
	assert.equal(context.result.includes('<Pro>'), false)
	assert.match(context.result, /listing-model-chip/)
	assert.match(context.result, /iPhone/)
})

if (failed) {
	console.error(`\n${failed} failed, ${passed} passed`)
	process.exit(1)
}
console.log(`\n${passed} passed`)
