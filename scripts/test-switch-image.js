'use strict';

/**
 * Regression test — a design SWITCH must render the REPLACEMENT design's image,
 * NEVER the original design the buyer moved away from.
 *
 * Reproduces and guards against the defect where switching a flagged line to
 * another product updated the title but kept showing the ORIGINAL product's
 * photo ("the same fucking old case shows without updating the product image").
 *
 * Root cause: the switched-image fallback chain ended in
 * `sub.image_url || imageMap[originalListingId]`. A catalog pick whose thumbnail
 * hadn't synced (very common — the switch grid shows a 📦 placeholder) saved an
 * EMPTY image_url, so every render fell back to the ORIGINAL listing's cached
 * image, making the switch look like it never happened.
 *
 * The fix resolves the image in priority order and NEVER falls back to the
 * original design:
 *   1. custom upload bytes (served from our endpoint),
 *   2. the switch's own stored CDN url,
 *   3. the REPLACEMENT listing's cached thumbnail (via source_listing_id),
 *   4. null → a neutral placeholder.
 *
 * Run: `node scripts/test-switch-image.js`
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
    CREATE TABLE listings (listing_id INTEGER PRIMARY KEY, title TEXT, primary_image_url TEXT);
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

const ORIG_TITLE = 'Cherry Soda Kawaii Blue Case';
const ORIG_LISTING = 111;
const ORIG_IMAGE = 'https://cdn.example/original-blue-case.jpg'; // must NEVER show on a switched line

const NEW_TITLE = 'Rainbow Stars Clear Case with Beaded Charm';
const NEW_LISTING = 222;
const NEW_IMAGE_IN_LISTING_IMAGES = 'https://cdn.example/rainbow-stars.jpg';

// A replacement whose image lives ONLY in the canonical `listings` table.
const NEW_TITLE_2 = 'Sanrio Cinnamoroll Blue Clear Case';
const NEW_LISTING_2 = 333;
const NEW_IMAGE_IN_LISTINGS = 'https://cdn.example/cinnamoroll.jpg';

// A replacement the operator picked that carries its own CDN url on the switch.
const NEW_TITLE_3 = 'Y2K Coquette Bow Case';
const NEW_LISTING_3 = 444;
const NEW_IMAGE_EXPLICIT = 'https://cdn.example/coquette-bow-EXPLICIT.jpg';

const ORIG_KEY = routeDashboard.lineItemKey(ORIG_TITLE, ORIG_LISTING);

function txFor(title, listingId) {
  return JSON.stringify([{ title, listing_id: listingId, quantity: 1, variations: [] }]);
}

function seed(db) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare('INSERT INTO shops (shop_id, shop_name) VALUES (?,?)').run('SHOP_A', 'Y2KASEshop');

  // The ORIGINAL listing has a cached image — the one that used to leak through.
  db.prepare('INSERT INTO listing_images (listing_id, url) VALUES (?,?)').run(ORIG_LISTING, ORIG_IMAGE);
  // Replacement #1 image is in listing_images.
  db.prepare('INSERT INTO listing_images (listing_id, url) VALUES (?,?)').run(NEW_LISTING, NEW_IMAGE_IN_LISTING_IMAGES);
  // Replacement #2 image is ONLY in the canonical listings table.
  db.prepare('INSERT INTO listings (listing_id, title, primary_image_url) VALUES (?,?,?)').run(NEW_LISTING_2, NEW_TITLE_2, NEW_IMAGE_IN_LISTINGS);

  const ins = db.prepare(`
    INSERT INTO receipts (receipt_id, shop_id, name, etsy_created_at, all_transactions,
      is_paid, is_shipped, status, needs_purchase_at)
    VALUES (@receipt_id, @shop_id, @name, @etsy_created_at, @all_transactions, 1, 0, 'Paid', NULL)
  `);
  //  3001 — catalog switch, EMPTY image_url, image resolvable via listing_images.
  //  3002 — control: NOT switched (keeps the original image).
  //  3003 — catalog switch, image resolvable only via the `listings` table.
  //  3004 — catalog switch that carries its OWN explicit CDN url.
  //  3005 — custom switch with uploaded image bytes.
  //  3006 — switch with NO resolvable image at all (must be null, not original).
  for (const [rid, name] of [
    [3001, 'SwitchEmptyUrl'], [3002, 'Control'], [3003, 'SwitchListingsTable'],
    [3004, 'SwitchExplicitUrl'], [3005, 'SwitchCustomUpload'], [3006, 'SwitchNoImage'],
  ]) {
    ins.run({ receipt_id: rid, shop_id: 'SHOP_A', name, etsy_created_at: now - 3600, all_transactions: txFor(ORIG_TITLE, ORIG_LISTING) });
  }

  const insSub = db.prepare(`
    INSERT INTO order_line_substitutions
      (receipt_id, item_key, original_title, new_title, source, source_listing_id, image_url, image_data, image_mime, updated_at)
    VALUES (@receipt_id, @item_key, @original_title, @new_title, @source, @source_listing_id, @image_url, @image_data, @image_mime, @now)
  `);
  const base = { item_key: ORIG_KEY, original_title: ORIG_TITLE, image_data: null, image_mime: null, now };
  insSub.run({ ...base, receipt_id: 3001, new_title: NEW_TITLE,   source: 'catalog', source_listing_id: NEW_LISTING,   image_url: '' });
  insSub.run({ ...base, receipt_id: 3003, new_title: NEW_TITLE_2, source: 'catalog', source_listing_id: NEW_LISTING_2, image_url: '' });
  insSub.run({ ...base, receipt_id: 3004, new_title: NEW_TITLE_3, source: 'catalog', source_listing_id: NEW_LISTING_3, image_url: NEW_IMAGE_EXPLICIT });
  insSub.run({ ...base, receipt_id: 3005, new_title: 'One-off Buyer Photo Case', source: 'custom', source_listing_id: null, image_url: '', image_data: Buffer.from('PNGDATA'), image_mime: 'image/png' });
  insSub.run({ ...base, receipt_id: 3006, new_title: 'Untraceable Custom Case', source: 'custom', source_listing_id: null, image_url: '' });
}

const db = makeDb();
seed(db);

console.log('Design-switch IMAGE regression test\n');

const rows = routeDashboard.buildRouteRows(db, {}, { enrich_supplier: false, include_issues: true });
const byReceipt = (rid) => rows.find((r) => r.receipt_id === rid);

// 1) Catalog switch, empty stored url → REPLACEMENT listing's cached image.
{
  const r = byReceipt(3001);
  assert(!!r, 'switched line (3001) is present in the route');
  assert(r && r.title === NEW_TITLE, `line title is the replacement (got "${r && r.title}")`);
  assert(r && r.image_url === NEW_IMAGE_IN_LISTING_IMAGES,
    `image resolves to the REPLACEMENT listing's cached photo (got "${r && r.image_url}")`);
  assert(r && r.image_url !== ORIG_IMAGE,
    'image is NEVER the original design ("same old case") photo');
}

// 2) Control: unswitched line keeps the original image.
{
  const r = byReceipt(3002);
  assert(r && r.image_url === ORIG_IMAGE,
    `unswitched line (3002) still shows its original image (got "${r && r.image_url}")`);
}

// 3) Catalog switch resolvable only via the canonical `listings` table.
{
  const r = byReceipt(3003);
  assert(r && r.image_url === NEW_IMAGE_IN_LISTINGS,
    `image falls back to listings.primary_image_url for the replacement (got "${r && r.image_url}")`);
  assert(r && r.image_url !== ORIG_IMAGE, 'still never the original image');
}

// 4) Catalog switch carrying its own explicit CDN url uses it verbatim.
{
  const r = byReceipt(3004);
  assert(r && r.image_url === NEW_IMAGE_EXPLICIT,
    `explicit stored image_url wins verbatim (got "${r && r.image_url}")`);
}

// 5) Custom switch with uploaded bytes → our content-addressed blob endpoint.
{
  const r = byReceipt(3005);
  const ok = r && typeof r.image_url === 'string' && /^\/api\/route\/substitution-image\/\d+\?v=/.test(r.image_url);
  assert(ok, `custom upload serves the uploaded blob (got "${r && r.image_url}")`);
  assert(r && r.image_url !== ORIG_IMAGE, 'custom upload never shows the original image');
}

// 6) No resolvable image at all → null placeholder, NEVER the original.
{
  const r = byReceipt(3006);
  assert(!!r, 'switched line (3006) is present in the route');
  assert(r && r.image_url === null,
    `unresolvable switch image is null (a neutral placeholder), got "${r && r.image_url}"`);
  assert(r && r.image_url !== ORIG_IMAGE,
    'an unresolvable switch NEVER falls back to the original design image');
}

db.close();

console.log('');
if (failures > 0) {
  console.error(`${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log('All assertions passed.');
