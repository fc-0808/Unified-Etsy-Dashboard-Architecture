'use strict';
/**
 * Offline verification of inventory helper logic (no Etsy API).
 * Run: node scripts/verify-inventory-logic.js
 */

const Database = require('better-sqlite3');
const path     = require('path');
const {
  getZeroStylesForListing,
  listingHasLiveZero,
  hasRecentEvent,
  logZeroStockIfNeeded,
  orderCheckPriority,
} = require('../src/inventory/helpers');
const { initDb, upsertListingInventory, logEvent } = require('../src/db/setup');

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

const db = initDb(':memory:');
const now = Math.floor(Date.now() / 1000);

// Minimal listing_inventory rows for tests
db.exec(`
  INSERT INTO listings (listing_id, shop_id, title, state) VALUES (1001, 'TestShop', 'Test', 'active');
`);

function seedInventory(listingId, rows) {
  for (const r of rows) {
    db.prepare(`
      INSERT INTO listing_inventory
        (listing_id, product_id, offering_id, style_value, quantity, is_enabled, synced_at)
      VALUES (?, ?, 1, ?, ?, 1, ?)
      ON CONFLICT(listing_id, product_id) DO UPDATE SET
        style_value = excluded.style_value, quantity = excluded.quantity, synced_at = excluded.synced_at
    `).run(listingId, r.product_id, r.style, r.qty, now);
  }
}

console.log('\n── listingHasLiveZero ──');
assert(listingHasLiveZero({ products: [{ offerings: [{ quantity: 0, is_enabled: true }] }] }), 'detects zero');
assert(!listingHasLiveZero({ products: [{ offerings: [{ quantity: 3, is_enabled: true }] }] }), 'ignores in-stock');
assert(!listingHasLiveZero({ products: [{ offerings: [{ quantity: 0, is_enabled: false }] }] }), 'ignores disabled');

console.log('\n── getZeroStylesForListing ──');
seedInventory(1001, [
  { product_id: 1, style: 'Case Only', qty: 0 },
  { product_id: 2, style: 'Case Only', qty: 0 },
  { product_id: 3, style: 'Case+Grip', qty: 3 },
]);
const z = getZeroStylesForListing(db, 1001);
assert(z.hasZero && z.styles.length === 1 && z.styles[0] === 'Case Only', 'groups duplicate styles');

console.log('\n── hasRecentEvent / logZeroStockIfNeeded ──');
logEvent(db, {
  event_type: 'ZERO_STOCK', shop_name: 'TestShop', listing_id: 1001,
  listing_title: 'T', style_value: 'Case Only', detail: 'first',
});
assert(hasRecentEvent(db, { listingId: 1001, eventTypes: ['ZERO_STOCK'] }), 'recent ZERO_STOCK found');
const logged = logZeroStockIfNeeded(db, {
  event_type: 'ZERO_STOCK', shop_name: 'TestShop', listing_id: 1001,
  listing_title: 'T', style_value: 'Case Only', detail: 'duplicate',
});
assert(!logged, 'dedup blocks second ZERO_STOCK within 1h');
const count = db.prepare("SELECT COUNT(*) AS n FROM events WHERE listing_id = 1001 AND event_type = 'ZERO_STOCK'").get().n;
assert(count === 1, 'only one ZERO_STOCK row for listing');

console.log('\n── orderCheckPriority ──');
const twoHoursAgo = now - 7200;
seedInventory(2001, [{ product_id: 10, style: 'A', qty: 0 }]);
seedInventory(2002, [{ product_id: 20, style: 'B', qty: 5 }]);
db.prepare('UPDATE listing_inventory SET synced_at = ? WHERE listing_id = 2002').run(now);
assert(orderCheckPriority(db, 2001, twoHoursAgo) > orderCheckPriority(db, 2002, twoHoursAgo), 'zero stock ranks above in-stock');

console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
