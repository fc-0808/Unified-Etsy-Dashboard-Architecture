'use strict';

/**
 * Regression test — a charm's supplier SHOP must follow the charm library
 * (Manage charms), the single source of truth for a charm code → its supplier.
 *
 * Reproduces and guards against the defect where editing a charm's supplier in
 * Manage charms did NOT update the Route tab order lines or the Shopping page:
 * those read charm_shop from route_assignments / product_assignments, which only
 * CACHE the shop that was current when the charm was first assigned. So charm
 * CH-00017 could show "一樂潮品 · 2C666" in the charm library but the stale
 * "小艾飾品 · 2D41-43" on order lines.
 *
 * Fix: buildRouteRows resolves the charm shop from charm_library by the confirmed
 * charm code (falling back to the stored snapshot only for a code the library
 * doesn't know). The stall is derived from the shop name downstream, so a correct
 * shop yields a correct stall automatically.
 *
 * Run: `node scripts/test-charm-supplier.js`
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
      shipment_notified_at INTEGER, archived_at INTEGER
    );
    CREATE TABLE listing_images (listing_id INTEGER, url TEXT);
    CREATE TABLE route_manual_items (
      id INTEGER PRIMARY KEY, receipt_id INTEGER, item_key TEXT, title TEXT,
      phone_model TEXT, style TEXT, quantity INTEGER, shop_name TEXT,
      listing_id INTEGER, image_url TEXT, image_data BLOB, image_mime TEXT,
      source TEXT, created_at INTEGER
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
  `);
  return db;
}

// A charm-bearing product. Style "Case+Grip+Charm" ensures has_charm is true.
const TITLE = 'Kawaii Beaded Phone Charm Case';
const LISTING = 111;
const STYLE = 'Case & Grip & Charm';
const CHARM = 'CH-00017';

// Old (stale) supplier snapshotted onto the order line when the charm was assigned.
const OLD_SHOP = '小艾飾品';
// New supplier the operator set in Manage charms — must win everywhere.
const NEW_SHOP = '一樂潮品';

const KEY = routeDashboard.lineItemKey(TITLE, LISTING);

function tx() {
  return JSON.stringify([{ title: TITLE, listing_id: LISTING, quantity: 1, variations: [{ formatted_name: 'Style', formatted_value: STYLE }] }]);
}

function seed(db) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare('INSERT INTO shops (shop_id, shop_name) VALUES (?,?)').run('SHOP_A', 'TestShop');
  db.prepare(`INSERT INTO receipts (receipt_id, shop_id, name, etsy_created_at, all_transactions, is_paid, is_shipped, status)
              VALUES (?,?,?,?,?,1,0,'Paid')`).run(2001, 'SHOP_A', 'Alice', now - 3600, tx());

  // Charm library = source of truth. CH-00017 now supplied by the NEW shop.
  db.prepare('INSERT INTO charm_library (code, default_charm_shop, sort_order) VALUES (?,?,0)').run(CHARM, NEW_SHOP);

  // The order line has CH-00017 assigned, but its charm_shop still holds the OLD
  // shop (snapshot from assignment time) — the stale copy that used to win.
  db.prepare(`INSERT INTO route_assignments (receipt_id, item_key, title, status_charm, charm_code, charm_shop, updated_at)
              VALUES (?,?,?,?,?,?,?)`).run(2001, KEY, TITLE, 'Pending', CHARM, OLD_SHOP, now);

  // Stalls for both shops so we can prove the stall follows the resolved shop.
  db.prepare('INSERT INTO charm_shop_directory (shop_name, stall) VALUES (?,?)').run(OLD_SHOP, '2D41-43');
  db.prepare('INSERT INTO charm_shop_directory (shop_name, stall) VALUES (?,?)').run(NEW_SHOP, '2C666');
}

const db = makeDb();
seed(db);

console.log('Charm supplier propagation regression test\n');

const rows = routeDashboard.buildRouteRows(db, {}, { enrich_supplier: false });
const r = rows.find((x) => x.receipt_id === 2001);

assert(!!r, 'charm-bearing line is present in the route');
assert(r && r.has_charm === true, 'line is recognised as needing a charm');
assert(r && r.charm_code === CHARM, `charm code is preserved (got "${r && r.charm_code}")`);
assert(r && r.charm_shop === NEW_SHOP,
  `charm shop follows the LIBRARY's current supplier "${NEW_SHOP}" (got "${r && r.charm_shop}")`);
assert(r && r.charm_shop !== OLD_SHOP,
  `charm shop is NOT the stale snapshot "${OLD_SHOP}"`);

// Stall is derived from the shop name downstream (Route tab client / shop API),
// so a directory lookup on the RESOLVED shop must yield the new stall, not the old.
const stallByShop = new Map();
db.prepare('SELECT shop_name, stall FROM charm_shop_directory').all()
  .forEach((s) => stallByShop.set(s.shop_name, s.stall));
assert(stallByShop.get(r.charm_shop) === '2C666',
  `stall derived from the resolved shop is the new "2C666" (got "${stallByShop.get(r.charm_shop)}")`);

// — A code the library does NOT know still falls back to the stored snapshot. —
{
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO receipts (receipt_id, shop_id, name, etsy_created_at, all_transactions, is_paid, is_shipped, status)
              VALUES (?,?,?,?,?,1,0,'Paid')`).run(2002, 'SHOP_A', 'Bob', now - 3600, tx());
  db.prepare(`INSERT INTO route_assignments (receipt_id, item_key, title, status_charm, charm_code, charm_shop, updated_at)
              VALUES (?,?,?,?,?,?,?)`).run(2002, KEY, TITLE, 'Pending', 'CH-LEGACY', '老字號', now);
  const rows2 = routeDashboard.buildRouteRows(db, {}, { enrich_supplier: false });
  const r2 = rows2.find((x) => x.receipt_id === 2002);
  assert(r2 && r2.charm_shop === '老字號',
    `a code absent from the library keeps its stored snapshot "老字號" (got "${r2 && r2.charm_shop}")`);
}

db.close();

console.log('');
if (failures > 0) {
  console.error(`${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log('All assertions passed.');
