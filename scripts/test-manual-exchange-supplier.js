'use strict';

/**
 * Regression test — a wrong-model exchange on a MANUAL (operator-added) order
 * must resolve its supplier, not fall into "Supplier not set".
 *
 * The shopping page resolves each open exchange's supplier by re-running
 * buildRouteRows scoped to the exchange's receipts (`receipt_ids: [...]`) and
 * reading the underlying line's supplier. The defect: buildRouteRows skipped
 * ALL manual items whenever ANY receipt scope (receipt_id / receipt_ids) was
 * active, so a manual-order line produced ZERO rows under that scope — the
 * exchange found no line, so its supplier came up empty and it grouped under
 * "未匹配供应商 / Supplier not set" even though the desktop clearly showed it
 * assigned (e.g. 芝士 / A267 / F2).
 *
 * Fix: buildRouteRows now emits manual items NARROWED to the requested receipts
 * when an explicit receipt scope is active (and still every manual item on the
 * unscoped dashboard, still none under a real shop filter).
 *
 * Run: `node scripts/test-manual-exchange-supplier.js`
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

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE shops (shop_id TEXT PRIMARY KEY, shop_name TEXT);
    CREATE TABLE receipts (
      receipt_id INTEGER PRIMARY KEY, shop_id TEXT, name TEXT, buyer_email TEXT,
      buyer_user_id INTEGER, message_from_buyer TEXT, team_note TEXT,
      shipping_country_iso TEXT, etsy_created_at INTEGER, all_transactions TEXT,
      is_paid INTEGER DEFAULT 1, is_shipped INTEGER DEFAULT 0, status TEXT,
      needs_purchase_at INTEGER, tracking_code TEXT, carrier_confirmed_at INTEGER,
      shipment_notified_at INTEGER, packaged_at INTEGER, archived_at INTEGER, source TEXT
    );
    CREATE TABLE listing_images (listing_id INTEGER, url TEXT);
    CREATE TABLE route_manual_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, receipt_id INTEGER NOT NULL UNIQUE,
      item_key TEXT NOT NULL, title TEXT NOT NULL,
      phone_model TEXT DEFAULT '', style TEXT DEFAULT '', quantity INTEGER DEFAULT 1,
      shop_name TEXT DEFAULT '', listing_id INTEGER, image_url TEXT DEFAULT '',
      image_data BLOB, image_mime TEXT DEFAULT '', source TEXT DEFAULT 'manual',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE route_assignments (
      receipt_id INTEGER, item_key TEXT, title TEXT,
      status_case TEXT, status_grip TEXT, status_charm TEXT,
      excluded INTEGER DEFAULT 0, dismissed_at INTEGER,
      supplier_shop_override TEXT DEFAULT '', supplier_stall_override TEXT DEFAULT '',
      charm_code TEXT DEFAULT '', charm_shop TEXT DEFAULT '',
      updated_at INTEGER, PRIMARY KEY (receipt_id, item_key)
    );
    CREATE TABLE product_assignments (
      item_key TEXT PRIMARY KEY, title TEXT,
      supplier_shop TEXT DEFAULT '', supplier_stall TEXT DEFAULT '',
      charm_code TEXT DEFAULT '', charm_shop TEXT DEFAULT '', updated_at INTEGER
    );
    CREATE TABLE product_map (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title_norm TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL DEFAULT '', shop_name TEXT DEFAULT '', stall TEXT DEFAULT '',
      charm_shop TEXT DEFAULT '', charm_code TEXT DEFAULT '',
      canonical_product_key TEXT, sort_order INTEGER DEFAULT 0, updated_at INTEGER
    );
    CREATE TABLE charm_library (
      code TEXT PRIMARY KEY, sku TEXT DEFAULT '', default_charm_shop TEXT DEFAULT '',
      notes TEXT DEFAULT '', image_file TEXT DEFAULT '', sort_order INTEGER DEFAULT 0,
      updated_at INTEGER
    );
    CREATE TABLE charm_shop_directory (
      shop_name TEXT NOT NULL, stall TEXT DEFAULT '', notes TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0, updated_at INTEGER, PRIMARY KEY (shop_name, stall)
    );
    CREATE TABLE order_exchanges (
      id INTEGER PRIMARY KEY AUTOINCREMENT, receipt_id INTEGER NOT NULL,
      item_key TEXT NOT NULL, listing_id INTEGER, title TEXT,
      have_model TEXT, need_model TEXT, components TEXT NOT NULL DEFAULT '',
      supplier_shop TEXT, supplier_stall TEXT, status TEXT NOT NULL DEFAULT 'open',
      note TEXT, created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')), done_at INTEGER,
      UNIQUE(receipt_id, item_key)
    );
  `);
  return db;
}

// A MANUAL (operator-added) order line: a case with a wrong-model exchange owed,
// its supplier assigned by hand on the Route tab (route_assignments override).
const RID = 90210; // synthetic manual receipt id
const TITLE = 'Kawaii Frog MAGSAFE Case with Frog Shaker Grip & Beaded Charm';
const STYLE = 'Case Only';
const KEY = routeDashboard.lineItemKey(TITLE, null);
const SUP_SHOP = '芝士';
const SUP_STALL = 'A267';

function seed(db) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare('INSERT INTO shops (shop_id, shop_name) VALUES (?,?)').run('SHOP_A', 'TestShop');
  // The linked receipts row a Route-tab manual order carries (source='manual').
  db.prepare(
    `INSERT INTO receipts (receipt_id, shop_id, name, etsy_created_at, all_transactions, is_paid, is_shipped, status, source)
     VALUES (?,?,?,?,?,1,0,'Paid','manual')`,
  ).run(RID, '', 'Manual order', now - 3600, '[]');
  // The manual sidecar (the product the operator added).
  db.prepare(
    `INSERT INTO route_manual_items (receipt_id, item_key, title, phone_model, style, quantity, shop_name, created_at)
     VALUES (?,?,?,?,?,1,?,?)`,
  ).run(RID, KEY, TITLE, 'iPhone 17 Pro Max', STYLE, 'Y2KASEshop', now - 3600);
  // Hand-assigned supplier on the Route tab (the override the desktop shows).
  db.prepare(
    `INSERT INTO route_assignments (receipt_id, item_key, title, supplier_shop_override, supplier_stall_override, updated_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(RID, KEY, TITLE, SUP_SHOP, SUP_STALL, now);
  // Open wrong-model exchange (have iPhone 17, need iPhone 17 Pro Max). No
  // supplier stored on the exchange itself — it must be inferred from the line.
  db.prepare(
    `INSERT INTO order_exchanges (receipt_id, item_key, title, have_model, need_model, components, status)
     VALUES (?,?,?,?,?,?, 'open')`,
  ).run(RID, KEY, TITLE, 'iPhone 17', 'iPhone 17 Pro Max', 'case');
}

const db = makeDb();
seed(db);

console.log('Manual-order exchange supplier resolution regression test\n');

// 1) The exact call the shopping endpoint makes to resolve exchange suppliers.
const scoped = routeDashboard.buildRouteRows(db, {}, {
  receipt_ids: [RID],
  enrich_supplier: false, // the override alone resolves the supplier
  include_dismissed: true,
  include_issues: true,
});
const line = scoped.find((r) => r.receipt_id === RID && r.item_key === KEY);
assert(!!line, 'manual line IS returned under a receipt_ids scope (was dropped before the fix)');
assert(line && line.is_manual === true, 'the returned line is flagged manual');
assert(line && line.supplier_shop === SUP_SHOP, `supplier shop resolves to "${SUP_SHOP}" (got "${line && line.supplier_shop}")`);
assert(line && line.supplier_stall === SUP_STALL, `supplier stall resolves to "${SUP_STALL}" (got "${line && line.supplier_stall}")`);

// 2) The single-receipt scope (GET /api/route/order/:id) also sees the manual line.
const single = routeDashboard.buildRouteRows(db, {}, { receipt_id: RID, enrich_supplier: false });
assert(single.some((r) => r.receipt_id === RID && r.item_key === KEY),
  'manual line is also returned under a single receipt_id scope');

// 3) The unscoped dashboard still emits the manual line EXACTLY once (no dup).
const full = routeDashboard.buildRouteRows(db, {}, { enrich_supplier: false });
const dupCount = full.filter((r) => r.receipt_id === RID && r.item_key === KEY).length;
assert(dupCount === 1, `unscoped dashboard emits the manual line exactly once (got ${dupCount})`);

// 4) A REAL shop filter still suppresses manual items (they carry no shop_id).
const shopFiltered = routeDashboard.buildRouteRows(db, {}, { shop_id: 'SHOP_A', enrich_supplier: false });
assert(!shopFiltered.some((r) => r.receipt_id === RID),
  'a real shop_id filter still hides manual items (no cross-shop noise)');

db.close();

console.log('');
if (failures > 0) {
  console.error(`${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log('All assertions passed.');
