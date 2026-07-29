'use strict';

/**
 * Regression test — AirPods-case charms are classified as INTEGRAL.
 *
 * An AirPods case ships with its charm ATTACHED (the charm is baked into the
 * product photo), so it is bought together with the case at the SAME supplier
 * and needs no separate charm code / image / charm stall — exactly like a grip
 * is to a phone case. buildRouteRows must therefore stamp `charm_integral` on
 * such lines so the Route tab (charm column) and the mobile Shopping view can
 * treat them like a grip instead of a separately-sourced charm.
 *
 * A phone-case charm is the opposite: a distinct, code-driven item sourced at a
 * charm stall — it must NEVER be flagged integral.
 *
 * Run: `node scripts/test-airpods-charm.js`
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

// One transaction line with an explicit Model + Style variation. `modelName` is
// the variation property label ("AirPods Model" / "Phone Model") and `model` its
// value; parseVariations matches the label via /model|iphone|phone/i.
function tx(title, listingId, modelName, model, style) {
  return JSON.stringify([
    {
      title,
      listing_id: listingId,
      quantity: 1,
      variations: [
        { formatted_name: modelName, formatted_value: model },
        { formatted_name: 'Style', formatted_value: style },
      ],
    },
  ]);
}

function seedReceipt(db, receiptId, title, listingId, modelName, model, style) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO receipts (receipt_id, shop_id, name, etsy_created_at, all_transactions, is_paid, is_shipped, status)
     VALUES (?,?,?,?,?,1,0,'Paid')`,
  ).run(receiptId, 'SHOP_A', 'Buyer', now - 3600, tx(title, listingId, modelName, model, style));
}

const db = makeDb();
db.prepare('INSERT INTO shops (shop_id, shop_name) VALUES (?,?)').run('SHOP_A', 'TestShop');

// 1) AirPods case + charm — the charm is INTEGRAL (ships attached).
seedReceipt(db, 3001, 'Pear Green AirPods Case with Charm', 201, 'AirPods Model', 'AirPods Pro 2', 'Case & Charm');
// 2) Phone case + grip + charm — the charm is a SEPARATELY-SOURCED item.
seedReceipt(db, 3002, 'Kawaii Beaded Phone Charm Case', 202, 'Phone Model', 'iPhone 15 Pro Max', 'Case & Grip & Charm');
// 3) AirPods charm-only (no case) — still integral (no separate sourcing).
seedReceipt(db, 3003, 'Star Dangle AirPods Charm', 203, 'AirPods Model', 'AirPods 4', 'Charm Only');
// 4) AirPods case WITHOUT a charm — no charm at all, so never integral.
seedReceipt(db, 3004, 'Plain AirPods Case', 204, 'AirPods Model', 'AirPods Pro', 'Case Only');
// 5) Title-only fallback: AirPods named in the title but no model variation set.
seedReceipt(db, 3005, 'Cute AirPods Case with Bear Charm', 205, 'Style', 'Case & Charm', 'Case & Charm');

console.log('AirPods integral-charm classification regression test\n');

const rows = routeDashboard.buildRouteRows(db, {}, { enrich_supplier: false });
const byId = (id) => rows.find((r) => r.receipt_id === id);

const air = byId(3001);
assert(!!air, 'AirPods case+charm line is present');
assert(air && air.has_charm === true, 'AirPods case+charm has a charm');
assert(air && air.charm_integral === true, 'AirPods case+charm charm is flagged INTEGRAL');

const phone = byId(3002);
assert(!!phone, 'phone case+grip+charm line is present');
assert(phone && phone.has_charm === true, 'phone case has a charm');
assert(phone && !phone.charm_integral, 'phone-case charm is NOT integral (sourced at a charm stall)');

const airCharmOnly = byId(3003);
assert(airCharmOnly && airCharmOnly.has_charm === true && !airCharmOnly.has_case,
  'AirPods charm-only line has a charm and no case');
assert(airCharmOnly && airCharmOnly.charm_integral === true,
  'AirPods charm-only charm is flagged INTEGRAL');

const airNoCharm = byId(3004);
assert(airNoCharm && airNoCharm.has_charm === false,
  'AirPods case-only line has no charm');
assert(airNoCharm && !airNoCharm.charm_integral,
  'AirPods case-only line is not flagged integral (no charm to flag)');

const airTitle = byId(3005);
assert(airTitle && airTitle.has_charm === true, 'title-only AirPods line has a charm');
assert(airTitle && airTitle.charm_integral === true,
  'AirPods detected via title fallback → charm flagged INTEGRAL');

db.close();

console.log('');
if (failures > 0) {
  console.error(`${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log('All assertions passed.');
