'use strict';

/**
 * Device-coverage summaries for the Listings tab.
 *
 * Coverage is a local read of cached inventory (Etsy's Inventory association
 * already stored at listing-sync). These tests pin that we never invent
 * unoffered variants, that families stay separated, and that a title is only
 * a labelled fallback when the cache is empty.
 *
 * Run: node scripts/test-device-coverage.js
 */

const assert = require('node:assert/strict');
const deviceCoverage = require('../src/listings/device-coverage');
const productTypes = require('../src/listings/product-types');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';
let passed = 0;
let failed = 0;

function test(name, fn) {
	try {
		fn();
		passed += 1;
		console.log(`  ${GREEN}ok${RESET}  — ${name}`);
	} catch (err) {
		failed += 1;
		console.error(`  ${RED}FAIL${RESET} — ${name}`);
		console.error(`         ${err.stack || err.message}`);
	}
}

console.log('Device coverage (Listings tab)\n');

test('iPhone inventory models sort in canonical newest-first order and drop the prefix on chips', () => {
	const coverage = deviceCoverage.summarizeDeviceCoverage({
		models: ['iPhone 14/13', 'iPhone 17 Pro Max', 'iPhone 16', 'iPhone 17 Pro Max'],
		title: 'Pink Bow Cover for iPhone 17 16 15 14 13 Pro Max',
	});
	assert.equal(coverage.family, productTypes.FAMILY_IPHONE);
	assert.equal(coverage.source, 'inventory');
	assert.deepEqual(coverage.models, ['iPhone 17 Pro Max', 'iPhone 16', 'iPhone 14/13']);
	assert.deepEqual(coverage.chips, ['17 Pro Max', '16', '14/13']);
	assert.match(coverage.summary, /iPhone/);
	assert.match(coverage.summary, /17 Pro Max/);
});

test('AirPods listings show AirPods models, not iPhone generations', () => {
	const coverage = deviceCoverage.summarizeDeviceCoverage({
		models: ['AirPods 4', 'AirPods Pro 3', 'AirPods Pro 2'],
		title: 'Fruit Doodles Cover for AirPods Pro 3 2 1 & AirPods 4 3 2 1',
	});
	assert.equal(coverage.family, productTypes.FAMILY_AIRPODS);
	assert.equal(coverage.source, 'inventory');
	assert.deepEqual(coverage.models, ['AirPods Pro 3', 'AirPods Pro 2', 'AirPods 4']);
	assert.deepEqual(coverage.chips, ['Pro 3', 'Pro 2', '4']);
});

test('watch sizes stay as written and keep the Apple Watch family', () => {
	const coverage = deviceCoverage.summarizeDeviceCoverage({
		models: ['42/44/45/46/49mm', '38/40/41mm'],
		title: 'Hello Kitty Apple Watch Band',
	});
	assert.equal(coverage.family, productTypes.FAMILY_WATCH);
	assert.deepEqual(coverage.models, ['38/40/41mm', '42/44/45/46/49mm']);
	assert.deepEqual(coverage.chips, ['38/40/41mm', '42/44/45/46/49mm']);
});

test('unknown leftover models append after the canonical catalogue', () => {
	const coverage = deviceCoverage.summarizeDeviceCoverage({
		models: ['iPhone 17', 'iPhone 12 mini'],
		title: 'Cover for iPhone 17',
	});
	assert.deepEqual(coverage.models, ['iPhone 17', 'iPhone 12 mini']);
	assert.equal(coverage.source, 'inventory');
});

test('empty inventory falls back to the title compatibility phrase and labels the source', () => {
	const coverage = deviceCoverage.summarizeDeviceCoverage({
		models: [],
		title: 'Sanrio Clear iPhone Case, Cute Cover for iPhone 17 16 15 14 13 Pro Max, Gift for Her',
	});
	assert.equal(coverage.family, productTypes.FAMILY_IPHONE);
	assert.equal(coverage.source, 'title');
	assert.equal(coverage.models.length, 1);
	assert.match(coverage.models[0], /iPhone 17 16 15 14 13 Pro Max/i);
	assert.equal(coverage.chips[0], '17 16 15 14 13 Pro Max');
});

test('AirPods titles still show models when inventory has not been cached', () => {
	const coverage = deviceCoverage.summarizeDeviceCoverage({
		title: 'Fruit And Egg Doodles Cover for AirPods Pro 3 2 1 & AirPods 4 3 2 1, Gift for Her',
	});
	assert.equal(coverage.family, productTypes.FAMILY_AIRPODS);
	assert.equal(coverage.source, 'title');
	assert.match(coverage.summary, /AirPods Pro 3 2 1/i);
});

test('no invented models when neither inventory nor title names a device', () => {
	const coverage = deviceCoverage.summarizeDeviceCoverage({
		models: ['', '   '],
		title: 'Handmade Gift Wrap',
	});
	assert.equal(coverage.source, 'none');
	assert.deepEqual(coverage.models, []);
	assert.deepEqual(coverage.chips, []);
});

test('attachDeviceCoverageToListings groups cache rows without calling Etsy', () => {
	const listings = deviceCoverage.attachDeviceCoverageToListings(
		[
			{ listing_id: 11, title: 'Cover for iPhone 17 Pro Max' },
			{ listing_id: '22', title: 'AirPods case' },
		],
		[
			{ listing_id: 11, secondary_value: 'iPhone 17 Pro Max' },
			{ listing_id: 11, secondary_value: 'iPhone 17 Pro' },
			{ listing_id: 11, secondary_value: 'iPhone 17 Pro Max' },
			{ listing_id: 22, secondary_value: 'AirPods 5' },
		],
	);
	assert.equal(listings[0].device_coverage.source, 'inventory');
	assert.deepEqual(listings[0].device_coverage.models, ['iPhone 17 Pro Max', 'iPhone 17 Pro']);
	assert.equal(listings[1].device_coverage.family, productTypes.FAMILY_AIRPODS);
	assert.deepEqual(listings[1].device_coverage.models, ['AirPods 5']);
});

test('blank secondary_value rows are ignored so style-only cache lines cannot become fake models', () => {
	const grouped = deviceCoverage.groupModelsByListing([
		{ listing_id: 1, secondary_value: 'iPhone 17' },
		{ listing_id: 1, secondary_value: null },
		{ listing_id: 1, secondary_value: '  ' },
	]);
	assert.deepEqual(grouped.get(1), ['iPhone 17']);
});

if (failed) {
	console.error(`\n${failed} failed, ${passed} passed`);
	process.exit(1);
}
console.log(`\n${passed} passed`);
