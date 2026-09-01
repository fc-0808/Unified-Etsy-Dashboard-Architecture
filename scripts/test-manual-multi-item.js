'use strict';

/**
 * Regression test — a Route-tab manual order can carry several products.
 *
 * A buyer often orders more than one case. The Add-Order catalog used to POST
 * once per click and mint a NEW receipts row each time, so two products became
 * two unrelated orders (two shipping addresses, two 4PX labels). The contract
 * now is:
 *
 *   • one `receipts` row (one buyer, one shipment)
 *   • one `route_manual_items` sidecar per product, sharing that receipt_id
 *   • one dashboard row per product (independent purchase status / charm)
 *   • same listing + different model/style → distinct item_keys
 *   • product_assignments still key by the unsuffixed product identity
 *
 * Also covers the schema migration that dropped UNIQUE(receipt_id) on the
 * sidecar table, and the legacy single-product POST body.
 *
 * Run: `node scripts/test-manual-multi-item.js`
 * Exit code 0 = all assertions pass, 1 = a regression was detected.
 */

const Database = require('better-sqlite3');
const {
  initDb,
  createRouteManualOrder,
  deleteManualOrderLine,
  insertManualItem,
  insertManualOrder,
  purgeManualOrder,
  upsertRouteAssignment,
  getManualItems,
  migrateRouteManualItemsSharedReceipt,
  MAX_ROUTE_MANUAL_ITEMS,
  MANUAL_SHOP_ID,
} = require('../src/db/setup');
const routeDashboard = require('../src/route/dashboard');

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  ok  — ${msg}`);
  } else {
    failures++;
    console.error(`  FAIL — ${msg}`);
  }
}
function throws(fn, code, msg) {
  try {
    fn();
    failures++;
    console.error(`  FAIL — ${msg} (no error thrown)`);
  } catch (err) {
    if (code && err.code !== code) {
      failures++;
      console.error(`  FAIL — ${msg} (got code ${err.code}, expected ${code})`);
      return;
    }
    console.log(`  ok  — ${msg}`);
  }
}

function uniqueOnReceiptId(db) {
  try {
    const indexes = db.pragma('index_list(route_manual_items)');
    for (const idx of indexes) {
      if (!idx.unique) continue;
      const cols = db.pragma(`index_info("${idx.name}")`);
      if (cols.length === 1 && cols[0].name === 'receipt_id') return true;
    }
  } catch { /* missing table */ }
  return false;
}

function line(title, extras = {}) {
  const listingId = extras.listing_id != null ? extras.listing_id : null;
  return {
    source: extras.source || 'catalog',
    title,
    listing_id: listingId,
    phone_model: extras.phone_model || '',
    style: extras.style || '',
    quantity: extras.quantity || 1,
    shop_name: extras.shop_name || 'Manual Orders',
    charm_code: extras.charm_code || '',
    charm_shop: extras.charm_shop || '',
    item_key: extras.item_key || routeDashboard.lineItemKeyWithVariant(
      title, listingId, extras.phone_model || '', extras.style || '',
    ),
  };
}

console.log('Manual multi-item order regression test\n');

// ── 1. Fresh schema allows several sidecars on one receipt ─────────────────
{
  console.log('1. Fresh database (initDb) allows a shared receipt_id');
  const db = initDb(':memory:');
  assert(!uniqueOnReceiptId(db), 'route_manual_items has no UNIQUE(receipt_id)');

  const created = createRouteManualOrder(db, {
    shop_id: MANUAL_SHOP_ID,
    items: [
      line('Rainbow Stars Case', { listing_id: 111, phone_model: 'iPhone 15 Pro', style: 'Case Only' }),
      line('Blue Fish Case', { listing_id: 222, phone_model: 'iPhone 16', style: 'Case+Grip' }),
    ],
  });
  assert(Number.isInteger(created.receipt_id) && created.receipt_id < 0, `created a negative receipt_id (got ${created.receipt_id})`);
  assert(created.items.length === 2, `returned 2 sidecar ids (got ${created.items.length})`);
  assert(created.items.every((it) => it.receipt_id === created.receipt_id), 'every sidecar shares the order receipt_id');

  const sidecars = db.prepare('SELECT * FROM route_manual_items WHERE receipt_id = ?').all(created.receipt_id);
  assert(sidecars.length === 2, `persisted 2 sidecars (got ${sidecars.length})`);

  const receipt = db.prepare('SELECT all_transactions, first_product_title, source FROM receipts WHERE receipt_id = ?').get(created.receipt_id);
  assert(receipt && receipt.source === 'manual', 'companion receipts row is source=manual');
  let txs = [];
  try { txs = JSON.parse(receipt.all_transactions || '[]'); } catch { txs = []; }
  assert(txs.length === 2, `all_transactions has 2 items (got ${txs.length})`);
  assert(receipt.first_product_title === 'Rainbow Stars Case', 'first_product_title is the first cart line');
  assert(txs[0].variations.some((v) => v.formatted_value === 'iPhone 15 Pro'), 'phone model is stored as a variation');
  assert(txs[1].variations.some((v) => v.formatted_value === 'Case+Grip'), 'style is stored as a variation');
  db.close();
}

// ── 2. Dashboard emits one row per product, same receipt ───────────────────
{
  console.log('\n2. buildRouteRows emits one row per product on the shared receipt');
  const db = initDb(':memory:');
  const created = createRouteManualOrder(db, {
    shop_id: MANUAL_SHOP_ID,
    items: [
      line('Rainbow Stars Case', { listing_id: 111, phone_model: 'iPhone 15 Pro', style: 'Case Only', charm_code: 'CH-1', charm_shop: '壳引力' }),
      line('Blue Fish Case', { listing_id: 222, phone_model: 'iPhone 16', style: 'Case+Charm', charm_code: 'CH-2', charm_shop: '芝士' }),
    ],
  });
  const rows = routeDashboard.buildRouteRows(db, {}, { receipt_id: created.receipt_id });
  assert(rows.length === 2, `dashboard returns 2 rows (got ${rows.length})`);
  assert(rows.every((r) => r.receipt_id === created.receipt_id), 'both rows share the receipt_id');
  assert(rows.every((r) => r.is_manual), 'both rows are tagged is_manual');
  const titles = rows.map((r) => r.title).sort();
  assert(titles[0] === 'Blue Fish Case' && titles[1] === 'Rainbow Stars Case', `titles are both products (got ${titles.join(', ')})`);
  const charms = new Set(rows.map((r) => r.charm_code));
  assert(charms.has('CH-1') && charms.has('CH-2'), 'each line kept its own charm');
  const keys = new Set(rows.map((r) => r.item_key));
  assert(keys.size === 2, 'the two lines have distinct item_keys');
  db.close();
}

// ── 3. Same listing, different models → distinct keys, shared product default
{
  console.log('\n3. Same listing + different models stay independent lines');
  const db = initDb(':memory:');
  const title = 'Shared Design Case';
  const listingId = 999;
  const created = createRouteManualOrder(db, {
    shop_id: MANUAL_SHOP_ID,
    items: [
      line(title, { listing_id: listingId, phone_model: 'iPhone 15 Pro', style: 'Case Only' }),
      line(title, { listing_id: listingId, phone_model: 'iPhone 16', style: 'Case Only' }),
    ],
  });
  assert(created.items[0].item_key !== created.items[1].item_key, 'variant lines have distinct item_keys');
  const productKeyA = routeDashboard.productDefaultsKey(created.items[0].item_key, null);
  const productKeyB = routeDashboard.productDefaultsKey(created.items[1].item_key, null);
  assert(productKeyA === productKeyB, 'product_assignments key is the same product identity');
  assert(productKeyA === routeDashboard.lineItemKey(title, listingId), 'stripped key equals the listing-scoped lineItemKey');
  assert(created.items[0].item_key.includes('#V'), 'variant suffix is present on the line key');
  db.close();
}

// ── 4. Legacy single-item insertManualItem still works ─────────────────────
{
  console.log('\n4. Legacy single-sidecar insert still works');
  const db = initDb(':memory:');
  const order = insertManualOrder(db, {
    shop_id: MANUAL_SHOP_ID,
    items: [{ title: 'Legacy Case', quantity: 1, listing_id: 50, variations: [] }],
  });
  const sidecar = insertManualItem(db, {
    receipt_id: order.receipt_id,
    item_key: routeDashboard.lineItemKey('Legacy Case', 50),
    title: 'Legacy Case',
    source: 'catalog',
    listing_id: 50,
    quantity: 1,
  });
  assert(sidecar.receipt_id === order.receipt_id, 'legacy insert links to the supplied receipt_id');
  assert(getManualItems(db).length === 1, 'one sidecar is listed');
  db.close();
}

// ── 5. Validation ──────────────────────────────────────────────────────────
{
  console.log('\n5. Validation rejects empty / untitled / oversized carts');
  const db = initDb(':memory:');
  throws(() => createRouteManualOrder(db, { items: [] }), 'REQUIRED', 'empty items is REQUIRED');
  throws(
    () => createRouteManualOrder(db, { items: [line('  ', { item_key: 'x' })] }),
    'REQUIRED',
    'blank title is REQUIRED',
  );
  const tooMany = Array.from({ length: MAX_ROUTE_MANUAL_ITEMS + 1 }, (_, i) =>
    line(`Case ${i + 1}`, { listing_id: 1000 + i, item_key: `k${i}` }),
  );
  throws(() => createRouteManualOrder(db, { items: tooMany }), 'REQUIRED', 'over-cap carts are REQUIRED');
  db.close();
}

// ── 6. Duplicate item_keys on the payload are disambiguated ────────────────
{
  console.log('\n6. Duplicate item_keys are disambiguated instead of colliding');
  const db = initDb(':memory:');
  const key = routeDashboard.lineItemKey('Same Title Custom');
  const created = createRouteManualOrder(db, {
    shop_id: MANUAL_SHOP_ID,
    items: [
      { ...line('Same Title Custom', { source: 'custom', item_key: key }), item_key: key },
      { ...line('Same Title Custom', { source: 'custom', item_key: key }), item_key: key },
    ],
  });
  assert(created.items[0].item_key !== created.items[1].item_key, 'colliding keys were uniqued');
  const rows = routeDashboard.buildRouteRows(db, {}, { receipt_id: created.receipt_id });
  assert(rows.length === 2, `both custom lines still emit (got ${rows.length})`);
  db.close();
}

// ── 7. Purge removes every sidecar + the receipts row ──────────────────────
{
  console.log('\n7. purgeManualOrder tears down every line of a multi-item order');
  const db = initDb(':memory:');
  const created = createRouteManualOrder(db, {
    shop_id: MANUAL_SHOP_ID,
    items: [
      line('One', { listing_id: 1 }),
      line('Two', { listing_id: 2 }),
      line('Three', { listing_id: 3 }),
    ],
  });
  const ok = purgeManualOrder(db, created.receipt_id);
  assert(ok, 'purge reported a change');
  assert(getManualItems(db).length === 0, 'no sidecars remain');
  assert(!db.prepare('SELECT 1 FROM receipts WHERE receipt_id = ?').get(created.receipt_id), 'receipts row is gone');
  assert(!db.prepare('SELECT 1 FROM route_assignments WHERE receipt_id = ?').get(created.receipt_id), 'assignments are gone');
  db.close();
}

// ── 8. Schema migration drops UNIQUE(receipt_id) ───────────────────────────
{
  console.log('\n8. migrateRouteManualItemsSharedReceipt rebuilds a legacy UNIQUE table');
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE route_manual_items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id  INTEGER NOT NULL UNIQUE,
      item_key    TEXT    NOT NULL,
      title       TEXT    NOT NULL,
      phone_model TEXT    DEFAULT '',
      style       TEXT    DEFAULT '',
      quantity    INTEGER DEFAULT 1,
      shop_name   TEXT    DEFAULT '',
      listing_id  INTEGER,
      image_url   TEXT    DEFAULT '',
      image_data  BLOB,
      image_mime  TEXT    DEFAULT '',
      source      TEXT    DEFAULT 'manual',
      created_at  INTEGER DEFAULT (strftime('%s','now'))
    );
  `);
  db.prepare(`INSERT INTO route_manual_items (receipt_id, item_key, title) VALUES (?, ?, ?)`).run(-5, 'legacy#L1', 'Legacy');
  assert(uniqueOnReceiptId(db), 'fixture starts with UNIQUE(receipt_id)');

  migrateRouteManualItemsSharedReceipt(db);
  assert(!uniqueOnReceiptId(db), 'UNIQUE(receipt_id) is gone after migration');
  const kept = db.prepare('SELECT receipt_id, title FROM route_manual_items').get();
  assert(kept && kept.receipt_id === -5 && kept.title === 'Legacy', 'existing sidecar survived the rebuild');

  db.prepare(`INSERT INTO route_manual_items (receipt_id, item_key, title) VALUES (?, ?, ?)`).run(-5, 'legacy#L2', 'Second');
  const count = db.prepare('SELECT COUNT(*) AS n FROM route_manual_items WHERE receipt_id = -5').get().n;
  assert(count === 2, `two sidecars now share receipt_id -5 (got ${count})`);

  // Idempotent: running again must not throw or drop rows.
  migrateRouteManualItemsSharedReceipt(db);
  assert(db.prepare('SELECT COUNT(*) AS n FROM route_manual_items').get().n === 2, 're-running the migration is a no-op');
  db.close();
}

// ── 9. Deleting one product keeps the rest of the order ────────────────────
{
  console.log('\n9. Deleting one line keeps the order; deleting the last one purges it');
  const db = initDb(':memory:');
  const created = createRouteManualOrder(db, {
    shop_id: MANUAL_SHOP_ID,
    items: [
      line('Keep Me', { listing_id: 41 }),
      line('Delete Me', { listing_id: 42 }),
      line('Keep Me Too', { listing_id: 43 }),
    ],
  });
  const victim = created.items.find((it) => it.title === 'Delete Me');
  upsertRouteAssignment(db, { receipt_id: created.receipt_id, item_key: victim.item_key, title: 'Delete Me', charm_code: 'CH-X' });

  const first = deleteManualOrderLine(db, created.receipt_id, victim.item_key);
  assert(first.removed && !first.purged, 'deleting one of three lines does not purge the order');
  assert(first.remaining === 2, `two products remain (got ${first.remaining})`);

  const left = getManualItems(db).map((m) => m.title).sort();
  assert(left.length === 2 && !left.includes('Delete Me'), `only the deleted product is gone (left: ${left.join(', ')})`);
  assert(!db.prepare('SELECT 1 FROM route_assignments WHERE receipt_id = ? AND item_key = ?').get(created.receipt_id, victim.item_key), "the deleted line's assignment is gone");

  const receipt = db.prepare('SELECT all_transactions, first_product_title FROM receipts WHERE receipt_id = ?').get(created.receipt_id);
  assert(!!receipt, 'the companion receipt survives');
  let txs = [];
  try { txs = JSON.parse(receipt.all_transactions || '[]'); } catch { txs = []; }
  assert(txs.length === 2, `all_transactions dropped the deleted line (got ${txs.length})`);
  assert(!txs.some((t) => t.title === 'Delete Me'), 'the deleted product is no longer a transaction');
  assert(receipt.first_product_title === 'Keep Me', `first_product_title still points at a live line (got ${receipt.first_product_title})`);

  const rows = routeDashboard.buildRouteRows(db, {}, { receipt_id: created.receipt_id });
  assert(rows.length === 2, `dashboard now shows 2 lines (got ${rows.length})`);

  // Removing the remaining lines one at a time ends in a full teardown.
  deleteManualOrderLine(db, created.receipt_id, created.items[0].item_key);
  const last = deleteManualOrderLine(db, created.receipt_id, created.items[2].item_key);
  assert(last.purged, 'removing the final product purges the order');
  assert(!db.prepare('SELECT 1 FROM receipts WHERE receipt_id = ?').get(created.receipt_id), 'the receipts row is gone with the last product');
  assert(getManualItems(db).length === 0, 'no sidecars remain');
  db.close();
}

// ── 10. Deleting without an item_key still removes the whole order ─────────
{
  console.log('\n10. An item_key-less delete is still a full teardown (legacy callers)');
  const db = initDb(':memory:');
  const created = createRouteManualOrder(db, {
    shop_id: MANUAL_SHOP_ID,
    items: [line('One', { listing_id: 1 }), line('Two', { listing_id: 2 })],
  });
  const res = deleteManualOrderLine(db, created.receipt_id, '');
  assert(res.removed && res.purged, 'legacy delete purges the order');
  assert(getManualItems(db).length === 0, 'every sidecar is gone');

  // An unknown key must not silently no-op and strand the order either.
  const other = createRouteManualOrder(db, {
    shop_id: MANUAL_SHOP_ID,
    items: [line('Solo', { listing_id: 3 })],
  });
  const unknown = deleteManualOrderLine(db, other.receipt_id, 'no-such-key');
  assert(unknown.removed && unknown.purged, 'an unknown item_key falls back to the full teardown');
  db.close();
}

// ── 11. Unscoped dashboard does not duplicate a multi-item manual order ────
{
  console.log('\n11. Unscoped buildRouteRows does not double-emit a linked manual order');
  const db = initDb(':memory:');
  const created = createRouteManualOrder(db, {
    shop_id: MANUAL_SHOP_ID,
    items: [
      line('Alpha', { listing_id: 10 }),
      line('Beta', { listing_id: 20 }),
    ],
  });
  const rows = routeDashboard.buildRouteRows(db, {});
  const mine = rows.filter((r) => r.receipt_id === created.receipt_id);
  assert(mine.length === 2, `unscoped dashboard shows exactly 2 lines (got ${mine.length})`);
  db.close();
}

if (failures) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll manual multi-item assertions passed.');
