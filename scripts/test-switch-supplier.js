'use strict';

/**
 * Regression test — a design SWITCH must carry the REPLACEMENT product's
 * supplier (name + stall), not just its image/title.
 *
 * Reproduces and guards against the defect where switching a flagged line to an
 * already-existing product updated the product image + title but left the
 * ORIGINAL product's supplier name/location in place (e.g. showed "热麦 5B13"
 * instead of the switched design's "虎山 A223").
 *
 * Root cause: buildRouteRows resolved the per-product saved default
 * (product_assignments — priority 2, ABOVE the Excel product map) under the
 * ORIGINAL line's key, which still holds the original product's supplier. Every
 * other attribute (title, image, Excel map, catalog match) was already re-keyed
 * onto the replacement; this one lookup was not. The fix routes it through
 * routeDashboard.productDefaultsKey so a catalog switch reads/writes the default
 * under the REPLACEMENT product's identity, and a custom upload gets none.
 *
 * Run: `node scripts/test-switch-supplier.js`
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

/** In-memory DB with the tables buildRouteRows + the switch path read. */
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE shops (shop_id TEXT PRIMARY KEY, shop_name TEXT);
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
    CREATE TABLE order_line_substitutions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, receipt_id INTEGER NOT NULL,
      item_key TEXT NOT NULL, original_title TEXT, new_title TEXT NOT NULL,
      new_style TEXT, new_phone_model TEXT, source TEXT, source_listing_id INTEGER,
      image_url TEXT, image_data BLOB, image_mime TEXT, note TEXT,
      created_at INTEGER, updated_at INTEGER, UNIQUE (receipt_id, item_key)
    );
  `);
  return db;
}

// Original ordered product and the design we switch INTO.
const ORIG_TITLE = 'Cute Bear Clear Case';
const ORIG_LISTING = 111;
const NEW_TITLE = 'Tamagotchi MAGSAFE Liquid Shaker Grip Case';
const NEW_LISTING = 222;

const ORIG_KEY = routeDashboard.lineItemKey(ORIG_TITLE, ORIG_LISTING);
const NEW_KEY = routeDashboard.lineItemKey(NEW_TITLE, NEW_LISTING);

const ORIG_SUPPLIER = { shop: '热麦', stall: '5B13' }; // stale — must NOT win after switch
const NEW_SUPPLIER = { shop: '虎山', stall: 'A223' };  // the correct switched supplier

function txFor(title, listingId) {
  return JSON.stringify([{ title, listing_id: listingId, quantity: 1, variations: [] }]);
}

function seed(db) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare('INSERT INTO shops (shop_id, shop_name) VALUES (?,?)').run('SHOP_A', 'TestShop');

  const ins = db.prepare(`
    INSERT INTO receipts (receipt_id, shop_id, name, etsy_created_at, all_transactions,
      is_paid, is_shipped, status, needs_purchase_at)
    VALUES (@receipt_id, @shop_id, @name, @etsy_created_at, @all_transactions, 1, 0, 'Paid', NULL)
  `);
  // 2001 — line switched (catalog) to the new design.
  // 2002 — control: same original product, NOT switched.
  // 2003 — line switched to a CUSTOM upload (not catalogued).
  ins.run({ receipt_id: 2001, shop_id: 'SHOP_A', name: 'Switched', etsy_created_at: now - 3600, all_transactions: txFor(ORIG_TITLE, ORIG_LISTING) });
  ins.run({ receipt_id: 2002, shop_id: 'SHOP_A', name: 'Control', etsy_created_at: now - 3600, all_transactions: txFor(ORIG_TITLE, ORIG_LISTING) });
  ins.run({ receipt_id: 2003, shop_id: 'SHOP_A', name: 'CustomSwitch', etsy_created_at: now - 3600, all_transactions: txFor(ORIG_TITLE, ORIG_LISTING) });

  // The ORIGINAL product carries a saved supplier (the stale one). This is the
  // priority-2 default that used to leak onto the switched line.
  db.prepare('INSERT INTO product_assignments (item_key, title, supplier_shop, supplier_stall) VALUES (?,?,?,?)')
    .run(ORIG_KEY, ORIG_TITLE, ORIG_SUPPLIER.shop, ORIG_SUPPLIER.stall);

  // The switched-INTO product's authoritative supplier lives in the Product Map,
  // keyed by its (normalised) title.
  db.prepare('INSERT INTO product_map (title_norm, title, shop_name, stall) VALUES (?,?,?,?)')
    .run(routeDashboard.normalizeTitle(NEW_TITLE), NEW_TITLE, NEW_SUPPLIER.shop, NEW_SUPPLIER.stall);

  // Design switches. On a real switch the route_assignments supplier override is
  // cleared, so we leave it empty here (the default seeded row is absent).
  const insSub = db.prepare(`
    INSERT INTO order_line_substitutions (receipt_id, item_key, original_title, new_title, source, source_listing_id, updated_at)
    VALUES (?,?,?,?,?,?,?)
  `);
  insSub.run(2001, ORIG_KEY, ORIG_TITLE, NEW_TITLE, 'catalog', NEW_LISTING, now);
  insSub.run(2003, ORIG_KEY, ORIG_TITLE, 'One-off Buyer Photo Case', 'custom', null, now);
}

const db = makeDb();
seed(db);

console.log('Design-switch supplier regression test\n');

const rows = routeDashboard.buildRouteRows(db, {}, { enrich_supplier: false, include_issues: true });
const byReceipt = (rid) => rows.find((r) => r.receipt_id === rid);

// — Helper unit behaviour (single source of truth for the key). —
assert(routeDashboard.productDefaultsKey(ORIG_KEY, null) === ORIG_KEY,
  'productDefaultsKey: no switch → the line\'s own key');
assert(routeDashboard.productDefaultsKey(ORIG_KEY, { source: 'catalog', new_title: NEW_TITLE, source_listing_id: NEW_LISTING }) === NEW_KEY,
  'productDefaultsKey: catalog switch → the REPLACEMENT product identity');
assert(routeDashboard.productDefaultsKey(ORIG_KEY, { source: 'custom', new_title: 'x' }) === null,
  'productDefaultsKey: custom switch → null (no catalog default)');

// — The bug: switched catalog line must show the NEW product's supplier. —
{
  const r = byReceipt(2001);
  assert(!!r, 'switched line (2001) is present in the route');
  assert(r && r.title === NEW_TITLE, `switched line title is the new design (got "${r && r.title}")`);
  assert(r && r.supplier_shop === NEW_SUPPLIER.shop,
    `switched line supplier NAME is the replacement's "${NEW_SUPPLIER.shop}" (got "${r && r.supplier_shop}")`);
  assert(r && r.supplier_stall === NEW_SUPPLIER.stall,
    `switched line supplier STALL is the replacement's "${NEW_SUPPLIER.stall}" (got "${r && r.supplier_stall}")`);
  assert(r && r.supplier_floor === 2,
    `switched line supplier FLOOR derives from the new stall A223 → F2 (got ${r && r.supplier_floor})`);
  assert(r && r.supplier_shop !== ORIG_SUPPLIER.shop && r.supplier_stall !== ORIG_SUPPLIER.stall,
    `switched line NEVER shows the stale original supplier "${ORIG_SUPPLIER.shop} ${ORIG_SUPPLIER.stall}"`);
}

// — No regression: an unswitched line with the same product keeps its supplier. —
{
  const r = byReceipt(2002);
  assert(r && r.supplier_shop === ORIG_SUPPLIER.shop && r.supplier_stall === ORIG_SUPPLIER.stall,
    `unswitched line (2002) still shows its own saved supplier "${ORIG_SUPPLIER.shop} ${ORIG_SUPPLIER.stall}" (got "${r && r.supplier_shop} ${r && r.supplier_stall}")`);
}

// — Custom switch: no catalog product, so the stale original must NOT leak. —
{
  const r = byReceipt(2003);
  assert(!!r, 'custom-switched line (2003) is present in the route');
  assert(r && r.supplier_shop !== ORIG_SUPPLIER.shop,
    `custom-switched line does NOT inherit the original supplier "${ORIG_SUPPLIER.shop}" (got "${r && r.supplier_shop}")`);
  assert(r && r.supplier_in_catalog === false,
    'custom-switched line is (correctly) UNMATCHED — operator must source it');
}

db.close();

console.log('');
if (failures > 0) {
  console.error(`${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log('All assertions passed.');
