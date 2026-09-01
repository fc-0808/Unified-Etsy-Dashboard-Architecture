'use strict';

/**
 * Style variation images — the photo the buyer picked in the Styles dropdown
 * (e.g. "Case 1 + Grip 1") must win over the listing's generic hero collage.
 *
 * Run: `node scripts/test-variation-images.js`
 */

const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
  initDb,
  syncConfigToDb,
  replaceListingVariationImages,
  getListingVariationImageMap,
  listingIdsNeedingVariationRefresh,
} = require('../src/db/setup');
const {
  canonicalizeStyleKey,
  styleKeyLookupCandidates,
  lookupStyleKeyed,
  lookupVariationImage,
  parseStyleValueId,
  resolveUnswitchedLineImage,
  variationImageApiUrl,
  buildVariationImageRows,
} = require('../src/listings/variation-images');
const routeDashboard = require('../src/route/dashboard');

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  — ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.error(`  FAIL — ${name}\n       ${err.stack || err.message}`);
  }
}

const CASE1 = 'https://i.etsystatic.com/example/il_570xN.case1.jpg';
const CASE2 = 'https://i.etsystatic.com/example/il_570xN.case2.jpg';
const HERO = 'https://i.etsystatic.com/example/il_570xN.hero-collage.jpg';
const LISTING_ID = 424242;
// The real Etsy value_id for "Case 1 + Grip 1" on the listing this feature
// was built against — the exact key an order line carries.
const VALUE_ID = 1461861649194;

test('canonicalises Case 1 + Grip 1 spacing and digit glue', () => {
  assert.equal(canonicalizeStyleKey('Case 1 + Grip 1'), 'case 1 + grip 1');
  assert.equal(canonicalizeStyleKey('Case1+Grip1'), 'case 1 + grip 1');
  assert.equal(canonicalizeStyleKey('  CASE  1+GRIP  1 '), 'case 1 + grip 1');
  assert.equal(canonicalizeStyleKey(''), '');
});

test('lookup hits every common Styles spelling', () => {
  const map = {};
  const key = canonicalizeStyleKey('Case 1 + Grip 1');
  map[`${LISTING_ID}\x00${key}`] = { url: CASE1 };
  assert.equal(lookupStyleKeyed(map, LISTING_ID, 'Case 1 + Grip 1').url, CASE1);
  assert.equal(lookupStyleKeyed(map, LISTING_ID, 'Case1+Grip1').url, CASE1);
  assert.equal(lookupStyleKeyed(map, LISTING_ID, 'case 1+grip 1').url, CASE1);
  assert.equal(lookupStyleKeyed(map, LISTING_ID, 'Case 2 + Grip 2'), null);
  assert.equal(lookupStyleKeyed(map, LISTING_ID, ''), null);
  assert.ok(styleKeyLookupCandidates('Case1+Grip1').includes('case 1 + grip 1'));
});

test('joins Etsy variation-images to listing image URLs, preferring Styles', () => {
  const byImageId = new Map([
    [10, HERO],
    [11, CASE1],
    [12, CASE2],
  ]);
  const rows = buildVariationImageRows([
    { property_id: 514, value_id: 1, value: 'Case 1 + Grip 1', image_id: 11 },
    { property_id: 514, value_id: 2, value: 'Case 2 + Grip 2', image_id: 12 },
    { property_id: 513, value_id: 9, value: 'iPhone 16', image_id: 10 },
  ], byImageId);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].style_key, 'case 1 + grip 1');
  assert.equal(rows[0].url, CASE1);
  assert.equal(rows[1].url, CASE2);
  assert.ok(!rows.some((r) => r.style_value === 'iPhone 16'));
});

test('drops variation rows whose image_id is missing from the catalog', () => {
  const rows = buildVariationImageRows([
    { property_id: 514, value: 'Case 1 + Grip 1', image_id: 99 },
  ], new Map([[11, CASE1]]));
  assert.deepEqual(rows, []);
});

test('image priority: operator Fix Image > Etsy variation > listing hero', () => {
  assert.equal(
    resolveUnswitchedLineImage({
      styleImg: { id: 7, updated_at: 100 },
      variationUrl: CASE1,
      listingUrl: HERO,
    }),
    '/api/route/style-image/7?v=100',
  );
  assert.equal(
    resolveUnswitchedLineImage({ variationUrl: CASE1, listingUrl: HERO }),
    CASE1,
  );
  assert.equal(
    resolveUnswitchedLineImage({ listingUrl: HERO }),
    HERO,
  );
  assert.equal(resolveUnswitchedLineImage({}), null);
});

test('same-origin variation URL encodes the Styles label', () => {
  assert.equal(
    variationImageApiUrl(LISTING_ID, 'Case 1 + Grip 1', 1700000000),
    `/api/route/variation-image/${LISTING_ID}?k=Case%201%20%2B%20Grip%201&v=1700000000`,
  );
  assert.equal(variationImageApiUrl(LISTING_ID, ''), null);
});

test('reads the Styles value_id out of a real Etsy transaction', () => {
  const variations = JSON.stringify([
    { property_id: 513, value_id: 1272345710685, formatted_name: 'Phone Model', formatted_value: 'iPhone 16' },
    { property_id: 514, value_id: VALUE_ID, formatted_name: 'Styles', formatted_value: 'Case 1 + Grip 1' },
  ]);
  assert.equal(parseStyleValueId(variations), VALUE_ID);
  assert.equal(parseStyleValueId('[]'), null);
  assert.equal(parseStyleValueId(null), null);
});

test('value_id wins over the label, so a renamed style still resolves', () => {
  const map = {
    byValue: { [`${LISTING_ID}\x00${VALUE_ID}`]: { url: CASE1, style_value: 'Case 1 + Grip 1' } },
    byStyle: { [`${LISTING_ID}\x00${canonicalizeStyleKey('Case 2 + Grip 2')}`]: { url: CASE2 } },
  };
  assert.equal(
    lookupVariationImage(map, LISTING_ID, { valueId: VALUE_ID, style: 'Renamed On Etsy' }).url,
    CASE1,
  );
  assert.equal(
    lookupVariationImage(map, LISTING_ID, { valueId: null, style: 'Case2+Grip2' }).url,
    CASE2,
  );
  assert.equal(lookupVariationImage(map, LISTING_ID, { valueId: 999, style: 'Unknown' }), null);
});

test('DB cache round-trips by value_id and label, and refreshes stale listings', () => {
  const db = initDb(':memory:');
  replaceListingVariationImages(db, LISTING_ID, [
    { style_value: 'Case 1 + Grip 1', image_id: 11, url: CASE1, value_id: VALUE_ID, property_id: 514 },
    { style_value: 'Case 2 + Grip 2', image_id: 12, url: CASE2, value_id: 1463003206013, property_id: 514 },
  ]);
  const map = getListingVariationImageMap(db, [LISTING_ID]);
  assert.equal(lookupVariationImage(map, LISTING_ID, { valueId: VALUE_ID }).url, CASE1);
  assert.equal(lookupVariationImage(map, LISTING_ID, { style: 'Case1+Grip1' }).url, CASE1);
  assert.equal(lookupVariationImage(map, LISTING_ID, { style: 'Case 2 + Grip 2' }).url, CASE2);

  const fresh = listingIdsNeedingVariationRefresh(db, [LISTING_ID, 99], 7 * 24 * 3600);
  assert.deepEqual(fresh, [99]);
  const always = listingIdsNeedingVariationRefresh(db, [LISTING_ID], 0);
  assert.deepEqual(always, [LISTING_ID]);

  replaceListingVariationImages(db, LISTING_ID, []);
  const emptied = getListingVariationImageMap(db, [LISTING_ID]);
  assert.equal(Object.keys(emptied.byStyle).length, 0);
  assert.equal(Object.keys(emptied.byValue).length, 0);
  db.close();
});

test('Route rows show the Styles photo instead of the listing hero', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE shops (shop_id TEXT PRIMARY KEY, shop_name TEXT);
    CREATE TABLE receipts (
      receipt_id INTEGER PRIMARY KEY, shop_id TEXT, name TEXT, buyer_email TEXT,
      buyer_user_id INTEGER, message_from_buyer TEXT, team_note TEXT,
      shipping_country_iso TEXT, etsy_created_at INTEGER, all_transactions TEXT,
      is_paid INTEGER DEFAULT 1, is_shipped INTEGER DEFAULT 0, status TEXT,
      needs_purchase_at INTEGER, tracking_code TEXT, carrier_confirmed_at INTEGER,
      shipment_notified_at INTEGER, packaged_at INTEGER, archived_at INTEGER
    );
    CREATE TABLE listing_images (listing_id INTEGER, url TEXT);
    CREATE TABLE listings (listing_id INTEGER PRIMARY KEY, title TEXT, primary_image_url TEXT);
    CREATE TABLE listing_variation_images (
      listing_id INTEGER NOT NULL, style_key TEXT NOT NULL, style_value TEXT NOT NULL DEFAULT '',
      image_id INTEGER, url TEXT NOT NULL, value_id INTEGER, property_id INTEGER,
      cached_at INTEGER DEFAULT 1, PRIMARY KEY (listing_id, style_key)
    );
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

  const title = 'Fruit Red MAGSAFE iPhone Case with Grip';
  db.prepare('INSERT INTO shops (shop_id, shop_name) VALUES (?,?)').run('SHOP_A', 'KawaiiPhoneCases');
  db.prepare('INSERT INTO listing_images (listing_id, url) VALUES (?,?)').run(LISTING_ID, HERO);
  db.prepare(`
    INSERT INTO listing_variation_images (listing_id, style_key, style_value, image_id, url, value_id, cached_at)
    VALUES (?, ?, ?, ?, ?, ?, 42)
  `).run(LISTING_ID, canonicalizeStyleKey('Case 1 + Grip 1'), 'Case 1 + Grip 1', 11, CASE1, VALUE_ID);

  const txs = JSON.stringify([{
    title,
    listing_id: LISTING_ID,
    quantity: 1,
    variations: [
      { property_id: 513, value_id: 1272345710685, formatted_name: 'Phone Model', formatted_value: 'iPhone 16' },
      { property_id: 514, value_id: VALUE_ID, formatted_name: 'Styles', formatted_value: 'Case 1 + Grip 1' },
    ],
  }]);
  db.prepare(`
    INSERT INTO receipts (receipt_id, shop_id, name, etsy_created_at, all_transactions, is_paid, is_shipped, status)
    VALUES (9001, 'SHOP_A', 'Wadelis', strftime('%s','now'), ?, 1, 0, 'Paid')
  `).run(txs);

  const rows = routeDashboard.buildRouteRows(db, {}, { enrich_supplier: false, include_issues: true });
  const row = rows.find((r) => r.receipt_id === 9001);
  assert.ok(row, 'order line is present');
  assert.equal(row.style, 'Case 1 + Grip 1');
  assert.equal(row.image_url, variationImageApiUrl(LISTING_ID, 'Case 1 + Grip 1', 42));
  assert.notEqual(row.image_url, HERO);
  db.close();
});

test('initDb creates variation-image tables used by a live dashboard', () => {
  const db = initDb(':memory:');
  syncConfigToDb(db, {
    groups: [{
      group_id: 'g1',
      label: 'G',
      proxy: 'direct',
      shops: [{ shop_id: 's1', shop_name: 'Shop', api_key: 'k', shared_secret: 's' }],
    }],
  });
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('listing_variation_images','listing_variation_image_state')`).all().map((r) => r.name).sort();
  assert.deepEqual(tables, ['listing_variation_image_state', 'listing_variation_images']);
  db.close();
});

console.log(`\n${failures.length ? 'FAIL' : 'PASS'} — ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
