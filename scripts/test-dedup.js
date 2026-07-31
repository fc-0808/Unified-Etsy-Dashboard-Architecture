'use strict';

/**
 * Synthetic unit tests for the Etsy double-fire / ghost-receipt de-duplication
 * engine (src/orders/dedup.js). No database required — every case is a hand-built
 * fixture, so this runs anywhere and pins the exact behaviour the Orders tab
 * depends on.
 *
 * Regression anchor: the "Andrea Landeros" bug (Jul 2026) — a provisional
 * "Payment Processing" ghost created 5 DAYS before its real paid twin surfaced in
 * "Needs shipping" with no ship-by date, because the old clustering step only
 * paired same-key receipts created within a fixed window. Case (A) below locks the
 * fix: a provisional ghost is now collapsed into its survivor at ANY distance.
 *
 * Run: npm run test:dedup   (exits non-zero on any failure)
 */

const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
	computeDuplicateSuppression,
	DEDUP_WINDOW_SEC,
	isActionableOrder,
	actionableOrderSql,
} = require('../src/orders/dedup');

const DAY = 24 * 3600;
let passed = 0;
const failures = [];

function test(name, fn) {
	try {
		fn();
		passed++;
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures.push({ name, err });
		console.log(`  ✗ ${name}\n      ${err.message}`);
	}
}

// Fixture helper — sensible defaults, override per case.
let _seq = 0;
function receipt(over = {}) {
	_seq += 1;
	return {
		receipt_id: over.receipt_id ?? 1000 + _seq,
		shop_id: 'Y2KASEshop',
		buyer_user_id: 271657320,
		buyer_name: 'Andrea Landeros',
		shipping_zip: '79927',
		first_listing_id: 4497126592,
		first_product_title: 'Kawaii Frog MAGSAFE Case',
		first_ship_by: null,
		is_paid: 0,
		is_shipped: 0,
		etsy_created_at: 1_783_000_000,
		...over,
	};
}
const ghost = (over = {}) => receipt({ is_paid: 0, is_shipped: 0, first_ship_by: null, ...over });
const paid = (over = {}) => receipt({ is_paid: 1, is_shipped: 0, first_ship_by: 1_784_174_340, ...over });
const shipped = (over = {}) => receipt({ is_paid: 1, is_shipped: 1, first_ship_by: 1_784_174_340, ...over });

function run(rows) {
	return computeDuplicateSuppression(rows);
}

console.log('dedup engine — synthetic unit tests\n');

// ── (A) THE REGRESSION: provisional ghost 5 days before its paid twin ─────────
test('provisional ghost is suppressed even 5 days before its paid twin', () => {
	const g = ghost({ receipt_id: 4105497490, etsy_created_at: 1_783_097_201 });
	const real = paid({ receipt_id: 4111824191, etsy_created_at: 1_783_097_201 + 5 * DAY });
	const { suppressed } = run([g, real]);
	assert.ok(suppressed.has(4105497490), 'ghost must be hidden');
	assert.ok(!suppressed.has(4111824191), 'real paid order must be kept');
});

// ── (B) Near-simultaneous double-fire where BOTH cleared payment ──────────────
test('two paid orders within the tight window collapse to one survivor', () => {
	const a = paid({ receipt_id: 2001, etsy_created_at: 1_783_000_000 });
	const b = paid({ receipt_id: 2002, etsy_created_at: 1_783_000_000 + 120 }); // 2 min
	const { suppressed, survivorOf } = run([a, b]);
	assert.equal(suppressed.size, 1, 'exactly one collapsed');
	assert.ok(suppressed.has(2001), 'lower receipt_id loses the tie');
	assert.deepEqual(survivorOf.get(2002), [2001], 'survivor records what it absorbed');
});

// ── (C) Genuine re-purchase: two paid orders far apart are BOTH kept ──────────
test('two paid orders far apart are genuine re-purchases and both kept', () => {
	const a = paid({ receipt_id: 3001, etsy_created_at: 1_783_000_000 });
	const b = paid({ receipt_id: 3002, etsy_created_at: 1_783_000_000 + 10 * DAY });
	const { suppressed } = run([a, b]);
	assert.equal(suppressed.size, 0, 'neither real order is hidden');
});

// ── (D) A lone provisional receipt is not duplicate-suppressed ───────────────
// The dedup engine only answers whether a row has a twin. The Orders API applies
// the separate fulfilment-validity gate (unpaid + unshipped + no ship-by) so a
// singleton provisional receipt is retained for reconciliation/audit but is not
// shown as actionable work.
test('a lone provisional receipt is retained for reconciliation (not dedup-suppressed)', () => {
	const g = ghost({ receipt_id: 4001 });
	const { suppressed } = run([g]);
	assert.equal(suppressed.size, 0, 'single-member group is never duplicate-suppressed');
});

// ── (E) A shipped order can NEVER be suppressed ───────────────────────────────
test('a shipped order is never suppressed, even against a later ghost', () => {
	const done = shipped({ receipt_id: 5001, etsy_created_at: 1_783_000_000 });
	const g = ghost({ receipt_id: 5002, etsy_created_at: 1_783_000_000 + 30 * DAY });
	const { suppressed } = run([done, g]);
	assert.ok(!suppressed.has(5001), 'shipped survivor kept');
	assert.ok(suppressed.has(5002), 'later ghost collapsed into the shipped twin');
});

// ── (F) Survivor is always the most-progressed, regardless of order/creation ──
test('shipped beats paid beats ghost when choosing the survivor', () => {
	const g = ghost({ receipt_id: 6001, etsy_created_at: 1_783_000_000 });
	const p = paid({ receipt_id: 6002, etsy_created_at: 1_783_000_000 + DAY });
	const s = shipped({ receipt_id: 6003, etsy_created_at: 1_783_000_000 + 2 * DAY });
	const { suppressed, survivorOf } = run([p, s, g]); // shuffled input
	assert.ok(!suppressed.has(6003), 'shipped is the survivor');
	assert.ok(suppressed.has(6001), 'ghost collapsed');
	// The paid order fired 1 day from the shipped survivor — far beyond the tight
	// window — so it is a genuine separate purchase and is KEPT.
	assert.ok(!suppressed.has(6002), 'far-apart paid order kept');
	assert.deepEqual(survivorOf.get(6003).sort(), [6001], 'only the ghost was absorbed');
});

// ── (G) Different buyers / products never cross-suppress ──────────────────────
test('different buyers with identical products are never merged', () => {
	const a = ghost({ receipt_id: 7001, buyer_user_id: 111 });
	const b = paid({ receipt_id: 7002, buyer_user_id: 222 });
	const { suppressed } = run([a, b]);
	assert.equal(suppressed.size, 0, 'distinct buyers stay independent');
});

test('same buyer, different products are never merged', () => {
	const a = ghost({ receipt_id: 7101, first_listing_id: 111 });
	const b = paid({ receipt_id: 7102, first_listing_id: 222 });
	const { suppressed } = run([a, b]);
	assert.equal(suppressed.size, 0, 'distinct products stay independent');
});

// ── (H) Buyer fallback key (missing user id → name+zip) still pairs a ghost ───
test('missing buyer_user_id falls back to name+zip and still pairs the ghost', () => {
	const g = ghost({ receipt_id: 8001, buyer_user_id: null, etsy_created_at: 1_783_000_000 });
	const real = paid({ receipt_id: 8002, buyer_user_id: null, etsy_created_at: 1_783_000_000 + 3 * DAY });
	const { suppressed } = run([g, real]);
	assert.ok(suppressed.has(8001), 'ghost paired via name+zip');
	assert.ok(!suppressed.has(8002), 'real order kept');
});

// ── (I) Product fallback key (missing listing id → normalised title) ──────────
test('missing first_listing_id falls back to normalised title', () => {
	const g = ghost({ receipt_id: 8101, first_listing_id: null, first_product_title: '  Kawaii Frog MAGSAFE Case  ' });
	const real = paid({ receipt_id: 8102, first_listing_id: null, first_product_title: 'kawaii frog magsafe case' });
	const { suppressed } = run([g, real]);
	assert.ok(suppressed.has(8101), 'ghost paired via normalised title');
});

// ── (J) Manual/empty inputs are handled without throwing ──────────────────────
test('empty and non-array inputs return empty result without throwing', () => {
	assert.equal(run([]).suppressed.size, 0);
	assert.equal(computeDuplicateSuppression(undefined).suppressed.size, 0);
	assert.equal(computeDuplicateSuppression(null).suppressed.size, 0);
});

// ── (K) Boundary: exactly DEDUP_WINDOW_SEC apart still collapses (<=) ──────────
test('two paid orders exactly DEDUP_WINDOW_SEC apart collapse (inclusive bound)', () => {
	const a = paid({ receipt_id: 9001, etsy_created_at: 1_783_000_000 });
	const b = paid({ receipt_id: 9002, etsy_created_at: 1_783_000_000 + DEDUP_WINDOW_SEC });
	const { suppressed } = run([a, b]);
	assert.equal(suppressed.size, 1, 'inclusive window collapses the pair');
});

// ── (L) Orders-tab validity gate ──────────────────────────────────────────────
test('unpaid Etsy receipt without shipment or ship-by is not actionable', () => {
	assert.equal(isActionableOrder(ghost({ source: 'etsy' })), false);
});

test('legacy NULL-source provisional receipt is treated as Etsy and hidden', () => {
	assert.equal(isActionableOrder(ghost({ source: null })), false);
});

test('manual order remains actionable without Etsy payment metadata', () => {
	assert.equal(isActionableOrder(ghost({ source: 'manual' })), true);
});

test('any commitment signal makes an Etsy receipt actionable', () => {
	assert.equal(isActionableOrder(ghost({ source: 'etsy', is_paid: 1 })), true);
	assert.equal(isActionableOrder(ghost({ source: 'etsy', is_shipped: 1 })), true);
	assert.equal(isActionableOrder(ghost({ source: 'etsy', first_ship_by: 1_784_000_000 })), true);
});

test('SQL validity predicate matches pure classifier and preserves exact counts', () => {
	const db = new Database(':memory:');
	try {
		db.exec(`CREATE TABLE receipts (
			receipt_id INTEGER PRIMARY KEY,
			source TEXT,
			is_paid INTEGER,
			is_shipped INTEGER,
			first_ship_by INTEGER
		)`);
		const fixtures = [
			{ receipt_id: 1, source: 'etsy', is_paid: 0, is_shipped: 0, first_ship_by: null },
			{ receipt_id: 2, source: null, is_paid: 0, is_shipped: 0, first_ship_by: null },
			{ receipt_id: 3, source: 'manual', is_paid: 0, is_shipped: 0, first_ship_by: null },
			{ receipt_id: 4, source: 'etsy', is_paid: 1, is_shipped: 0, first_ship_by: null },
			{ receipt_id: 5, source: 'ETSY', is_paid: null, is_shipped: null, first_ship_by: null },
		];
		const insert = db.prepare('INSERT INTO receipts VALUES (@receipt_id, @source, @is_paid, @is_shipped, @first_ship_by)');
		db.transaction((rows) => rows.forEach((row) => insert.run(row)))(fixtures);
		const actual = db.prepare(`SELECT receipt_id FROM receipts r WHERE ${actionableOrderSql('r')} ORDER BY receipt_id`).all().map((r) => r.receipt_id);
		const expected = fixtures.filter(isActionableOrder).map((r) => r.receipt_id);
		assert.deepEqual(actual, expected);
		assert.throws(() => actionableOrderSql('r; DROP TABLE receipts'), /Invalid SQL alias/);
	} finally {
		db.close();
	}
});

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
