'use strict';

/**
 * Regression test — Route dashboard shop filter must be a HARD scope.
 *
 * Reproduces and guards against the defect where selecting a single shop in the
 * Orders Sorting Dashboard still surfaced orders from OTHER shops. The cause was
 * that the `shop_id` filter only constrained the date/pending branch of the
 * WHERE clause, while the "extra receipts" (Send to Route pins) and the
 * "needs purchase" (pre-transit) branches were OR-ed in WITHOUT the shop
 * constraint — so another shop's pre-transit/pinned orders leaked into a
 * shop-filtered view.
 *
 * Run: `node scripts/test-route-shop-filter.js`
 * Exit code 0 = all assertions pass, 1 = a regression was detected.
 */

const Database = require('better-sqlite3');
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

/** Build an in-memory DB with just the tables buildRouteRows reads. */
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE shops (
      shop_id   TEXT PRIMARY KEY,
      shop_name TEXT
    );
    CREATE TABLE receipts (
      receipt_id           INTEGER PRIMARY KEY,
      shop_id              TEXT,
      name                 TEXT,
      buyer_email          TEXT,
      buyer_user_id        INTEGER,
      message_from_buyer   TEXT,
      team_note            TEXT,
      shipping_country_iso  TEXT,
      etsy_created_at      INTEGER,
      all_transactions     TEXT,
      is_paid              INTEGER DEFAULT 1,
      is_shipped           INTEGER DEFAULT 0,
      status               TEXT,
      needs_purchase_at    INTEGER,
      tracking_code        TEXT,
      carrier_confirmed_at INTEGER,
      shipment_notified_at INTEGER,
      archived_at          INTEGER
    );
    CREATE TABLE listing_images (listing_id INTEGER, url TEXT);
    -- buildRouteRows de-dupes linked manual orders via a NOT IN sub-select against
    -- this table, so it must exist even when empty for the query to run.
    CREATE TABLE route_manual_items (
      id          INTEGER PRIMARY KEY,
      receipt_id  INTEGER,
      item_key    TEXT,
      title       TEXT,
      phone_model TEXT,
      style       TEXT,
      quantity    INTEGER,
      shop_name   TEXT,
      listing_id  INTEGER,
      image_url   TEXT,
      image_data  BLOB,
      image_mime  TEXT,
      source      TEXT,
      created_at  INTEGER
    );
  `);
  return db;
}

const TX = JSON.stringify([
  { title: 'Cute Case', listing_id: 111, quantity: 1, variations: [] },
]);

function seed(db) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare('INSERT INTO shops (shop_id, shop_name) VALUES (?,?)').run('SHOP_A', 'LUVKASEofficial');
  db.prepare('INSERT INTO shops (shop_id, shop_name) VALUES (?,?)').run('SHOP_B', 'Y2KASEshop');

  const ins = db.prepare(`
    INSERT INTO receipts
      (receipt_id, shop_id, name, etsy_created_at, all_transactions,
       is_paid, is_shipped, status, needs_purchase_at, tracking_code, shipment_notified_at)
    VALUES (@receipt_id, @shop_id, @name, @etsy_created_at, @all_transactions,
            @is_paid, @is_shipped, @status, @needs_purchase_at, @tracking_code, @shipment_notified_at)
  `);

  // 1. Shop A — normal pending order (should ALWAYS show for shop A).
  ins.run({ receipt_id: 1001, shop_id: 'SHOP_A', name: 'Alice', etsy_created_at: now - 3600,
    all_transactions: TX, is_paid: 1, is_shipped: 0, status: 'Paid', needs_purchase_at: null, tracking_code: null, shipment_notified_at: null });

  // 2. Shop B — normal pending order (must NOT show when filtering shop A).
  ins.run({ receipt_id: 1002, shop_id: 'SHOP_B', name: 'Bob', etsy_created_at: now - 3600,
    all_transactions: TX, is_paid: 1, is_shipped: 0, status: 'Paid', needs_purchase_at: null, tracking_code: null, shipment_notified_at: null });

  // 3. Shop B — pre-transit order flagged "needs purchase" (the leak source).
  ins.run({ receipt_id: 1003, shop_id: 'SHOP_B', name: 'Carol', etsy_created_at: now - 3600,
    all_transactions: TX, is_paid: 1, is_shipped: 1, status: 'Paid', needs_purchase_at: now, tracking_code: '4PXTEST3', shipment_notified_at: now });

  // 4. Shop A — pre-transit needs-purchase order (should show for shop A).
  ins.run({ receipt_id: 1004, shop_id: 'SHOP_A', name: 'Dan', etsy_created_at: now - 3600,
    all_transactions: TX, is_paid: 1, is_shipped: 1, status: 'Paid', needs_purchase_at: now, tracking_code: '4PXTEST4', shipment_notified_at: now });

  // 5. Shop A — pre-transit order that was NEVER flagged needs_purchase (its
  //    components are still default-Pending so the rollup never ran). It must STILL
  //    enter the route directly via the pre-transit scope branch — this is the bug
  //    where unflagged pre-transit orders silently fell out of the purchasing queue.
  ins.run({ receipt_id: 1005, shop_id: 'SHOP_A', name: 'Erin', etsy_created_at: now - 3600,
    all_transactions: TX, is_paid: 1, is_shipped: 1, status: 'Completed', needs_purchase_at: null, tracking_code: '4PXTEST5', shipment_notified_at: now });

  // 6. Shop A — UNPAID pending order. Purchasing is paid-only, so it must NOT enter
  //    the route (you don't buy stock for an order that hasn't been paid for).
  ins.run({ receipt_id: 1006, shop_id: 'SHOP_A', name: 'Faye', etsy_created_at: now - 3600,
    all_transactions: TX, is_paid: 0, is_shipped: 0, status: 'Payment Processing', needs_purchase_at: null, tracking_code: null, shipment_notified_at: null });
}

function shopIds(rows) { return [...new Set(rows.map(r => r.shop_id))].sort(); }
function receiptIds(rows) { return [...new Set(rows.map(r => r.receipt_id))].sort((a, b) => a - b); }

const db = makeDb();
seed(db);
const cfg = {};

console.log('Route dashboard shop-filter regression test\n');

// — Filter to SHOP_A: must return ONLY shop A's orders, never shop B's. —
{
  const rows = routeDashboard.buildRouteRows(db, cfg, { shop_id: 'SHOP_A', enrich_supplier: false });
  const ids = shopIds(rows);
  assert(ids.length === 1 && ids[0] === 'SHOP_A',
    `shop_id=SHOP_A returns only SHOP_A rows (got shops: ${ids.join(', ') || 'none'})`);
  const rids = receiptIds(rows);
  assert(rids.includes(1001) && rids.includes(1004),
    `shop_id=SHOP_A includes its own pending (1001) and needs-purchase (1004) orders (got: ${rids.join(', ')})`);
  assert(!rids.includes(1002) && !rids.includes(1003),
    `shop_id=SHOP_A excludes SHOP_B's pending (1002) and needs-purchase (1003) orders`);
  assert(rids.includes(1005),
    `shop_id=SHOP_A includes its UNFLAGGED pre-transit order (1005) via the pre-transit scope (got: ${rids.join(', ')})`);
  assert(!rids.includes(1006),
    `shop_id=SHOP_A excludes its UNPAID order (1006) — purchasing is paid-only`);
}

// — Pinned "extra" receipt from another shop must NOT leak into a filtered view. —
{
  const rows = routeDashboard.buildRouteRows(db, cfg, {
    shop_id: 'SHOP_A', extra_receipt_ids: [1002], enrich_supplier: false,
  });
  const ids = shopIds(rows);
  assert(ids.length === 1 && ids[0] === 'SHOP_A',
    `shop_id=SHOP_A + pinned SHOP_B receipt still returns only SHOP_A rows (got: ${ids.join(', ') || 'none'})`);
}

// — No shop filter: every shop's pending + needs-purchase orders are present. —
{
  const rows = routeDashboard.buildRouteRows(db, cfg, { enrich_supplier: false });
  const ids = shopIds(rows);
  assert(ids.includes('SHOP_A') && ids.includes('SHOP_B'),
    `no shop filter returns both shops (got: ${ids.join(', ')})`);
  const rids = receiptIds(rows);
  assert([1001, 1002, 1003, 1004, 1005].every(id => rids.includes(id)),
    `no shop filter returns every paid pending / pre-transit order incl. unflagged pre-transit 1005 (got: ${rids.join(', ')})`);
  assert(!rids.includes(1006),
    `no shop filter still excludes the UNPAID order (1006) — purchasing is paid-only`);
}

db.close();

console.log('');
if (failures > 0) {
  console.error(`${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log('All assertions passed.');
