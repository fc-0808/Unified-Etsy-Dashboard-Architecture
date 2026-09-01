'use strict';

/**
 * Regression test — a line a shopper flagged "Wrong Stall" (错档口位) in person
 * must be treated as UNMATCHED.
 *
 * When the employee stands at the recorded stall and the product isn't there,
 * the mapping we hold is worth nothing: nobody can buy the item until someone
 * tells us the right supplier and stall. So the line has to behave exactly like
 * a product that was never catalogued —
 *
 *   • counted in the Route tab's "unmatched" pill and shown by "Unmatched only",
 *   • included in the Export-images ZIP (with the stall already tried quoted in
 *     the manifest, so the contacts know what to correct), and
 *   • dropped from that bucket the moment a corrected location is recorded —
 *     otherwise the request outlives its own answer and gets re-sent forever.
 *
 * Sections 1–3 drive the policy, the derived route fields and the resolution
 * against a seeded in-memory database; section 5 replays the operator's actual
 * round trip over HTTP against the REAL Express server (isolated throwaway
 * config + database, no network), because the auto-resolution and the export
 * headers only exist inside those handlers.
 *
 * Run: `node scripts/test-wrong-stall-sourcing.js`
 * Exit code 0 = all assertions pass, 1 = a regression was detected.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

const routeDashboard = require('../src/route/dashboard');
const sourcing = require('../src/route/sourcing');
const unmatchedImages = require('../src/route/unmatched-images');
const { resolveWrongStallForProduct } = require('../src/db/setup');

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  ok  — ${msg}`);
  } else {
    failures++;
    console.error(`  FAIL — ${msg}`);
  }
}

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── 1. The policy itself ─────────────────────────────────────────────────────

console.log('Wrong-stall sourcing regression test\n');
console.log('Policy (src/route/sourcing.js)');

const CASE_LINE = {
  has_case: 1, has_grip: 0, has_charm: 0,
  status_case: 'Pending', status_grip: 'Pending', status_charm: 'Pending',
  supplier_in_catalog: true, supplier_is_override: false,
  supplier_shop: '卡夫', supplier_stall: '康乐北区5C34-39',
};

assert(sourcing.sourcingReason(CASE_LINE) === null,
  'a catalogued line with no complaint needs no sourcing');
assert(sourcing.sourcingReason({ ...CASE_LINE, status_case: 'Wrong Stall' }) === sourcing.REASON_WRONG_STALL,
  'a Wrong Stall flag makes a catalogued line need sourcing again');
assert(sourcing.needsSourcing({ ...CASE_LINE, status_case: 'Wrong Stall' }),
  'and needsSourcing agrees, so one predicate drives the filter, the pill and the export');
assert(sourcing.sourcingReason({ ...CASE_LINE, supplier_in_catalog: false }) === sourcing.REASON_NOT_IN_CATALOG,
  'nothing recorded reads as not_in_catalog');
assert(sourcing.sourcingReason({ ...CASE_LINE, supplier_in_catalog: false, status_case: 'Wrong Stall' }) === sourcing.REASON_NOT_IN_CATALOG,
  'with no location on record, "nothing recorded" outranks a stale wrong-stall flag');
assert(sourcing.sourcingReason({ ...CASE_LINE, supplier_in_catalog: false, supplier_is_override: true }) === null,
  'a hand-entered supplier counts as recorded');

// A status left on a component the product doesn't have must stay inert.
assert(sourcing.wrongStallComponents({ ...CASE_LINE, status_charm: 'Wrong Stall' }).length === 0,
  'a charm status on a case-only line never flags the row');
assert(sourcing.wrongStallComponents({ ...CASE_LINE, has_charm: 1, status_charm: 'Wrong Stall' }).join() === 'charm',
  'a charm the line DOES have is reported on its own — its stall is separate from the case stall');

// Where each component is bought — the location a request must quote back.
assert(sourcing.recordedLocation(CASE_LINE, 'case').stall === '康乐北区5C34-39',
  'case/grip quote the supplier stall');
assert(sourcing.recordedLocation({ ...CASE_LINE, charm_shop: '汇通a146' }, 'charm').shop === '汇通a146',
  'a charm quotes its own charm shop, not the case supplier');

// Which flags a correction answers, scoped to the location that actually moved.
const flagged = { status_case: 'Wrong Stall', status_grip: 'Pending', status_charm: 'Wrong Stall' };
assert(sourcing.componentsResolvedByCorrection(flagged, { supplier: true }).join() === 'case',
  'correcting the supplier stall answers the case complaint only');
assert(sourcing.componentsResolvedByCorrection(flagged, { charm: true }).join() === 'charm',
  'correcting the charm answers the charm complaint only');
assert(sourcing.componentsResolvedByCorrection(flagged, { supplier: true, charm: true }).join() === 'case,charm',
  'correcting both answers both');
assert(sourcing.componentsResolvedByCorrection(flagged, {}).length === 0,
  'a save that moved nothing answers nothing — re-confirming the same stall must not close a report');

// locationMoved / productLocation — the assign handler's "did this save actually
// change where we buy?" predicates. They live in this module so a private helper
// buried mid-server-file can never go missing again (ReferenceError on save).
assert(sourcing.locationMoved(null, { stall: 'A' }, ['stall']),
  'a first write into an empty row counts as a move');
assert(!sourcing.locationMoved({ stall: 'A' }, { stall: 'A' }, ['stall']),
  're-saving the same stall is not a move');
assert(!sourcing.locationMoved({ stall: 'A' }, { stall: ' A ' }, ['stall']),
  'whitespace-only differences are not a move');
assert(sourcing.locationMoved({ stall: 'A' }, { stall: 'B' }, ['stall']),
  'a different stall is a move');
assert(!sourcing.locationMoved({ stall: 'A' }, null, ['stall']),
  'a missing after-row never counts as a move');
{
  const fromCatalog = sourcing.productLocation(null, { shop_name: '卡夫', stall: '5C34', charm_code: 'X1', charm_shop: '汇通' });
  assert(fromCatalog.supplier_shop === '卡夫' && fromCatalog.supplier_stall === '5C34' &&
    fromCatalog.charm_code === 'X1' && fromCatalog.charm_shop === '汇通',
    'productLocation falls back to the catalog when no product default exists');
  const fromAssignment = sourcing.productLocation(
    { supplier_shop: 'leo', supplier_stall: 'B2-14', charm_code: '', charm_shop: '' },
    { shop_name: '卡夫', stall: '5C34', charm_code: 'X1', charm_shop: '汇通' },
  );
  assert(fromAssignment.supplier_shop === 'leo' && fromAssignment.supplier_stall === 'B2-14' &&
    fromAssignment.charm_code === 'X1' && fromAssignment.charm_shop === '汇通',
    'and prefers the saved product default, falling through blank fields to the catalog');
}

// ── 2. Route rows carry the derived state ────────────────────────────────────

console.log('\nRoute rows (src/route/dashboard.js)');

/** In-memory DB with the tables buildRouteRows reads. */
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
      shipping_country_iso TEXT,
      etsy_created_at      INTEGER,
      all_transactions     TEXT,
      is_paid              INTEGER DEFAULT 1,
      is_shipped           INTEGER DEFAULT 0,
      status               TEXT,
      needs_purchase_at    INTEGER,
      tracking_code        TEXT,
      carrier_confirmed_at INTEGER,
      shipment_notified_at INTEGER,
      packaged_at          INTEGER,
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
      status_case TEXT DEFAULT 'Pending', status_grip TEXT DEFAULT 'Pending',
      status_charm TEXT DEFAULT 'Pending',
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
    CREATE TABLE listing_phash (
      listing_id INTEGER PRIMARY KEY, phash TEXT, design_phash TEXT,
      sha TEXT, algo TEXT, canonical_key TEXT, computed_at INTEGER
    );
    CREATE TABLE product_merges (
      listing_a INTEGER NOT NULL, listing_b INTEGER NOT NULL,
      note TEXT, created_by TEXT, created_at INTEGER,
      PRIMARY KEY (listing_a, listing_b), CHECK (listing_a < listing_b)
    );
  `);
  return db;
}

const CASE_TITLE = 'Clear Glitter Hello Kitty Case with 3D Rhinestone Bow';
const CASE_LISTING = 4148613801;
const CHARM_TITLE = 'Kawaii Cat Clear Case with Beaded Charm';
const CHARM_LISTING = 4150412015;
const PLAIN_TITLE = 'Pastel Cloud Clear AirPods Case with Charm';
const PLAIN_LISTING = 4149417725;

const CASE_KEY = routeDashboard.lineItemKey(CASE_TITLE, CASE_LISTING);
const CHARM_KEY = routeDashboard.lineItemKey(CHARM_TITLE, CHARM_LISTING);

const SUPPLIER = { shop: '卡夫', stall: '康乐北区5C34-39' };
/** A stall one order was pinned to by hand — not the product's default. */
const PINNED = { shop: 'leo', stall: '汇通A146' };
const CHARM_SHOP = '汇通a146';

function txFor(title, listingId, style) {
  return JSON.stringify([
    {
      title,
      listing_id: listingId,
      quantity: 1,
      variations: [
        { formatted_name: 'Style', formatted_value: style },
        { formatted_name: 'Model', formatted_value: 'iPhone 16 Pro' },
      ],
    },
  ]);
}

const db = makeDb();
{
  const now = Math.floor(Date.now() / 1000);
  db.prepare('INSERT INTO shops (shop_id, shop_name) VALUES (?,?)').run('SHOP_A', 'TestShop');
  const insReceipt = db.prepare(`
    INSERT INTO receipts (receipt_id, shop_id, name, etsy_created_at, all_transactions,
      is_paid, is_shipped, status)
    VALUES (?, 'SHOP_A', ?, ?, ?, 1, 0, 'Paid')
  `);
  // 3001 — inherits the catalogued stall; shopper flagged the CASE wrong.
  // 3002 — same product, but pinned to its OWN hand-entered stall, also flagged.
  // 3003 — same product, nothing flagged: ordinary shopping work.
  // 3004 — charm line: the CASE stall is fine, the inherited CHARM stall is wrong.
  // 3005 — a different product nobody ever catalogued.
  insReceipt.run(3001, 'WrongStall', now - 3600, txFor(CASE_TITLE, CASE_LISTING, 'Case Only'));
  insReceipt.run(3002, 'WrongStallPinned', now - 3600, txFor(CASE_TITLE, CASE_LISTING, 'Case Only'));
  insReceipt.run(3003, 'Fine', now - 3600, txFor(CASE_TITLE, CASE_LISTING, 'Case Only'));
  insReceipt.run(3004, 'WrongCharmStall', now - 3600, txFor(CHARM_TITLE, CHARM_LISTING, 'Case + Charm'));
  insReceipt.run(3005, 'NeverCatalogued', now - 3600, txFor(PLAIN_TITLE, PLAIN_LISTING, 'Case Only'));

  db.prepare('INSERT INTO listing_images (listing_id, url) VALUES (?,?), (?,?), (?,?)')
    .run(
      CASE_LISTING, 'https://cdn.example/case.jpg',
      CHARM_LISTING, 'https://cdn.example/charm.jpg',
      PLAIN_LISTING, 'https://cdn.example/plain.jpg'
    );

  // Both flagged products ARE catalogued — a wrong stall is a stall on record.
  const insMap = db.prepare(`
    INSERT INTO product_map (title_norm, title, shop_name, stall, updated_at)
    VALUES (?,?,?,?,?)
  `);
  insMap.run(routeDashboard.normalizeTitle(CASE_TITLE), CASE_TITLE, SUPPLIER.shop, SUPPLIER.stall, now);
  insMap.run(routeDashboard.normalizeTitle(CHARM_TITLE), CHARM_TITLE, SUPPLIER.shop, SUPPLIER.stall, now);

  // The charm line's charm comes from the product default, so correcting the
  // product answers it. (product_map charms are only suggestions — see the charm
  // priority chain in buildRouteRows.)
  db.prepare(`
    INSERT INTO product_assignments (item_key, title, charm_code, charm_shop, updated_at)
    VALUES (?,?,?,?,?)
  `).run(CHARM_KEY, CHARM_TITLE, 'CH-00092', CHARM_SHOP, now);

  const insAssign = db.prepare(`
    INSERT INTO route_assignments
      (receipt_id, item_key, title, status_case, status_grip, status_charm,
       supplier_shop_override, supplier_stall_override, charm_code, charm_shop, updated_at)
    VALUES (?,?,?,?,'Pending',?,?,?,?,?,?)
  `);
  insAssign.run(3001, CASE_KEY, CASE_TITLE, 'Wrong Stall', 'Pending', '', '', '', '', now);
  insAssign.run(3002, CASE_KEY, CASE_TITLE, 'Wrong Stall', 'Pending', PINNED.shop, PINNED.stall, '', '', now);
  insAssign.run(3003, CASE_KEY, CASE_TITLE, 'Pending', 'Pending', '', '', '', '', now);
  insAssign.run(3004, CHARM_KEY, CHARM_TITLE, 'Pending', 'Wrong Stall', '', '', '', '', now);
}

const rows = routeDashboard.buildRouteRows(db, {}, { enrich_supplier: false });
const at = (rid) => rows.find((r) => r.receipt_id === rid);

assert(rows.length === 5, `all five lines are in the route (got ${rows.length})`);

assert(at(3001).needs_sourcing === true && at(3001).sourcing_reason === 'wrong_stall',
  'the wrong-stall line needs sourcing, for the wrong-stall reason');
assert(at(3001).wrong_stall_components === 'case',
  'and names the component the shopper flagged, so a request can be specific');
assert(at(3001).supplier_stall === SUPPLIER.stall,
  'the (wrong) stall is still reported — it is what we quote back when asking for the right one');

assert(at(3002).sourcing_reason === 'wrong_stall' && at(3002).supplier_stall === PINNED.stall,
  'a line pinned to its own stall is flagged against THAT stall, not the product default');

assert(at(3003).needs_sourcing === false && at(3003).sourcing_reason === '',
  'a line with a working supplier is left alone');

assert(at(3004).sourcing_reason === 'wrong_stall' && at(3004).wrong_stall_components === 'charm',
  'a wrong CHARM stall flags the line even though the case supplier is fine');

assert(at(3005).needs_sourcing === true && at(3005).sourcing_reason === 'not_in_catalog',
  'an uncatalogued line needs sourcing too, for the other reason');

// The export is driven by the same rows, so it must pick up exactly these three
// products — one photo each, no matter how many orders are waiting on them.
{
  const items = unmatchedImages.collectUnmatchedImageItems(rows);
  const byTitle = (title) => items.find((i) => i.title === title);
  const counts = unmatchedImages.countItemsByReason(items);
  assert(items.length === 3,
    `Export images covers every product needing an answer, one photo each (got ${items.length})`);
  assert(counts.wrong_stall === 2 && counts.not_in_catalog === 1,
    'and both reasons are represented in the manifest');

  const caseItem = byTitle(CASE_TITLE);
  assert(caseItem.orders === 2,
    'the two flagged orders of one case share a single photo, and the ask counts both');
  assert(caseItem.reason === 'wrong_stall' && caseItem.recorded_stall === SUPPLIER.stall,
    'and it quotes the stall that was tried, so the contact knows where we already went');

  assert(byTitle(CHARM_TITLE) && byTitle(CHARM_TITLE).recorded_shop === CHARM_SHOP,
    'the charm request quotes the charm shop that was already tried');
  assert(byTitle(PLAIN_TITLE).reason === 'not_in_catalog' && byTitle(PLAIN_TITLE).recorded_stall === '',
    'an uncatalogued product has no stall to quote back');
}

// A purchased line is answered by definition — nothing left to ask about.
{
  db.prepare("UPDATE route_assignments SET status_case = 'Purchased' WHERE receipt_id = 3001").run();
  const after = routeDashboard.buildRouteRows(db, {}, { enrich_supplier: false });
  const line = after.find((r) => r.receipt_id === 3001);
  assert(line.needs_sourcing === false,
    'buying the item clears the flag on its own — the export stops asking about it');
  db.prepare("UPDATE route_assignments SET status_case = 'Wrong Stall' WHERE receipt_id = 3001").run();
}

// ── 3. A corrected location closes the report ────────────────────────────────

console.log('\nResolution (src/db/setup.js · resolveWrongStallForProduct)');

{
  const flaggedNow = () =>
    db.prepare("SELECT receipt_id FROM route_assignments WHERE status_case = 'Wrong Stall'").all().map((r) => r.receipt_id);

  assert(flaggedNow().join() === '3001,3002', 'precondition: two orders carry a case complaint');

  // A save that moved nothing must not close anything.
  assert(resolveWrongStallForProduct(db, CASE_TITLE, {}).length === 0,
    'a catalog save that changed no location clears nothing');
  // Correcting the CHARM does not answer a complaint about the CASE stall.
  assert(resolveWrongStallForProduct(db, CASE_TITLE, { charm: true }).length === 0,
    'correcting the charm shop leaves a case-stall complaint open');
  assert(flaggedNow().join() === '3001,3002', 'so both case complaints are still open');

  // Correcting the product's supplier answers it for every order that INHERITS
  // that location — and only those.
  const reset = resolveWrongStallForProduct(db, CASE_TITLE, { supplier: true });
  assert(reset.length === 1 && reset[0].receipt_id === 3001,
    'correcting the product stall closes the complaint on the orders that follow it');
  assert(reset[0].status_case === 'Pending',
    'the line goes back to Pending — still outstanding work, now at the corrected stall');
  assert(flaggedNow().join() === '3002',
    'the order pinned to its own stall keeps its flag — nobody has corrected THAT stall');

  const afterFix = routeDashboard.buildRouteRows(db, {}, { enrich_supplier: false });
  assert(afterFix.find((r) => r.receipt_id === 3001).needs_sourcing === false,
    'so the line drops out of the unmatched bucket and out of the export');

  // A different product's complaint is untouched by someone else's fix.
  assert(db.prepare("SELECT status_charm FROM route_assignments WHERE receipt_id = 3004").get().status_charm === 'Wrong Stall',
    'the charm complaint on another product is untouched');
  const charmFix = resolveWrongStallForProduct(db, CHARM_TITLE, { charm: true });
  assert(charmFix.length === 1 && charmFix[0].status_charm === 'Pending',
    'and is closed by correcting that product\'s charm');
}

db.close();

// ── 4. Wiring ────────────────────────────────────────────────────────────────
// The policy above only matters if every surface reads it. These assertions
// guard the call sites that are easy to fork by accident.

console.log('\nWiring');

const server = read('src/server/index.js');
const dashboard = read('public/index.html');

assert(server.includes('supplier_missing: live.filter((r) => r.needs_sourcing).length'),
  'the dashboard summary counts wrong-stall lines as unmatched');
assert(server.includes("supplier_wrong_stall: live.filter((r) => r.sourcing_reason === routeSourcing.REASON_WRONG_STALL).length"),
  'and breaks out how many of them are a bad mapping rather than a missing one');
assert(/routeSourcing\s*\.componentsResolvedByCorrection\(row, moved\)/.test(server),
  'POST /api/route/assign closes the reports its location edit answers');
assert(/routeSourcing\.locationMoved\(before, row,/.test(server),
  'via the shared locationMoved helper — not a private mid-file _locationMoved');
assert(/routeSourcing\.productLocation\(/.test(server),
  'and productLocation so a missing private _productLocation can never break Save supplier');
assert(!/\bfunction _productLocation\b/.test(server) && !/\bfunction _locationMoved\b/.test(server),
  'those helpers are not re-declared as private functions in the server file');
assert(server.includes('_closeWrongStallFromCatalogEdit(before, b)'),
  'and so does a Product Catalog edit, which is a per-product answer');
assert(/_closeWrongStallForProduct\(\s*effectiveTitle,/.test(server),
  'a supplier saved in the Route tab also answers the other orders it re-points');
assert(/routeSourcing\.locationMoved\(productBefore, productAfter/.test(server),
  'using the same move check for the product-level fan-out');
{
  // Headers must all be set before the archive writes its first byte, or the
  // setHeader throws mid-download.
  const start = server.indexOf("app.get('/api/route/download-unmatched-images'");
  const handler = server.slice(start, server.indexOf('// ─── Dashboard HTML', start));
  const streamAt = handler.indexOf('streamUnmatchedImagesZip');
  assert(streamAt > 0 && handler.lastIndexOf('res.setHeader(') < streamAt,
    'the export sets every response header before it starts streaming the ZIP');
  assert(handler.includes("res.setHeader('X-Images-Wrong-Stall'"),
    'and reports how many photos are wrong-stall re-sourcing requests');
}

assert(
  dashboard.includes('if (onlyUnmatched) rows = rows.filter(_rowNeedsSourcing)') ||
    dashboard.includes('if (state.onlyUnmatched && !_rowNeedsSourcing(row)) return false'),
  '"Unmatched only" in the Route tab shows wrong-stall lines too');
assert(dashboard.includes('supplier_missing: live.filter((r) => _rowNeedsSourcing(r)).length'),
  'and the live summary the client recomputes agrees with the server');
assert(/function _rowSourcingReason\(row\)[\s\S]{0,400}?'not_in_catalog'[\s\S]{0,200}?'wrong_stall'/.test(dashboard),
  'the client mirrors the server reason order, so a status edit re-buckets a row instantly');
assert(dashboard.includes("saved?.resolved_wrong_stall"),
  'saving a corrected supplier tells the operator the flag was cleared');

// ── 5. The operator's round trip, over HTTP ──────────────────────────────────
// Booted on a throwaway config + database so it touches nothing real, with the
// product photos pre-seeded into the image cache so the export never reaches for
// the network.

/** A 1×1 PNG — enough for the ZIP to contain a real, type-sniffable photo. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const PORT = 4900 + (process.pid % 200);
const BASE = `http://127.0.0.1:${PORT}`;

/** Wait for the server to answer, or fail loudly rather than hang the suite. */
async function waitForHealth(child, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`server exited early (code ${child.exitCode})`);
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('server did not become healthy in time');
}

/** Seed the orders the operator is about to work through. */
function seedLiveDb(dbPath) {
  const live = new Database(dbPath);
  const now = Math.floor(Date.now() / 1000);
  try {
    // The shop row comes from the config the server booted with; make sure of it
    // rather than assume, since the receipts below are keyed to it.
    live.prepare("INSERT OR IGNORE INTO shops (shop_id, group_id, shop_name) VALUES ('S1', 'G1', 'TestShop')").run();
    const insReceipt = live.prepare(`
      INSERT INTO receipts (receipt_id, shop_id, group_id, name, etsy_created_at, all_transactions,
        is_paid, is_shipped, status)
      VALUES (?, 'S1', 'G1', ?, ?, ?, 1, 0, 'Paid')
    `);
    // 5001 / 5003 follow the catalogued stall; 5002 is pinned to its own.
    insReceipt.run(5001, 'Flagged', now - 3600, txFor(CASE_TITLE, CASE_LISTING, 'Case Only'));
    insReceipt.run(5002, 'FlaggedPinned', now - 3600, txFor(CASE_TITLE, CASE_LISTING, 'Case Only'));
    insReceipt.run(5003, 'FlaggedSibling', now - 3600, txFor(CASE_TITLE, CASE_LISTING, 'Case Only'));
    insReceipt.run(5004, 'NeverCatalogued', now - 3600, txFor(PLAIN_TITLE, PLAIN_LISTING, 'Case Only'));

    live.prepare('INSERT OR REPLACE INTO product_map (title_norm, title, shop_name, stall, updated_at) VALUES (?,?,?,?,?)')
      .run(routeDashboard.normalizeTitle(CASE_TITLE), CASE_TITLE, SUPPLIER.shop, SUPPLIER.stall, now);

    const insAssign = live.prepare(`
      INSERT INTO route_assignments
        (receipt_id, item_key, title, status_case, supplier_shop_override, supplier_stall_override, updated_at)
      VALUES (?,?,?,'Wrong Stall',?,?,?)
    `);
    insAssign.run(5001, CASE_KEY, CASE_TITLE, '', '', now);
    insAssign.run(5002, CASE_KEY, CASE_TITLE, PINNED.shop, PINNED.stall, now);
    insAssign.run(5003, CASE_KEY, CASE_TITLE, '', '', now);

    // A route row carries whatever URL the listing was indexed with, and the
    // export fetches it as a remote photo. Pointing it at this server's own
    // image endpoint keeps that real code path — including the HTTP fetch — while
    // the bytes come from the cache below, so the test never leaves the machine.
    const insImage = live.prepare('INSERT OR REPLACE INTO listing_images (listing_id, url) VALUES (?,?)');
    const insBytes = live.prepare('INSERT OR REPLACE INTO listing_image_data (listing_id, data, cached_at) VALUES (?,?,?)');
    for (const id of [CASE_LISTING, PLAIN_LISTING]) {
      insImage.run(id, `${BASE}/api/route/listing-image/${id}`);
      insBytes.run(id, PNG_1PX, now);
    }
  } finally {
    live.close();
  }
}

async function liveRoundTrip() {
  console.log('\nOver HTTP (the real server)');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrong-stall-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const cfgPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    db_path: dbPath,
    sync_interval_minutes: 999999, // never, for the life of the test
    groups: [{
      group_id: 'G1',
      label: 'Test Group',
      proxy: 'direct',
      shops: [{ shop_id: 'S1', shop_name: 'TestShop', api_key: 'wrongstalltestkey0000001', shared_secret: 'wrongstallsecret0001' }],
    }],
  }), 'utf8');

  const child = spawn(process.execPath, [path.resolve(__dirname, '../src/server/index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DASHBOARD_CONFIG_PATH: cfgPath,
      DASHBOARD_OWNER_PASSWORD: '',
      DASHBOARD_PACKER_PASSWORD: '',
      DASHBOARD_SHOPPER_PASSWORD: '',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d.toString()));

  try {
    await waitForHealth(child);
    seedLiveDb(dbPath);

    const dashboardRows = async () => {
      const body = await (await fetch(`${BASE}/api/route/dashboard`)).json();
      const by = new Map((body.rows || []).map((r) => [r.receipt_id, r]));
      return { summary: body.summary || {}, by };
    };

    // ── What the operator sees before doing anything.
    {
      const { summary, by } = await dashboardRows();
      assert(summary.supplier_missing === 4 && summary.supplier_wrong_stall === 3,
        `all four unbuyable lines are unmatched, three of them wrong-stall (got ${summary.supplier_missing}/${summary.supplier_wrong_stall})`);
      assert(by.get(5001).sourcing_reason === 'wrong_stall' && by.get(5004).sourcing_reason === 'not_in_catalog',
        'and each line says which kind of answer it is waiting for');
    }

    // ── Export images: the photos to send, and a manifest naming the ask.
    {
      const res = await fetch(`${BASE}/api/route/download-unmatched-images`);
      const zip = Buffer.from(await res.arrayBuffer());
      assert(res.status === 200, `the export streams a ZIP (got ${res.status})`);
      assert(res.headers.get('x-images-requested') === '2' &&
        res.headers.get('x-images-wrong-stall') === '1' &&
        res.headers.get('x-images-not-in-catalog') === '1',
        `one photo per product, counted by what is being asked (got ${res.headers.get('x-images-requested')}/${res.headers.get('x-images-wrong-stall')}/${res.headers.get('x-images-not-in-catalog')})`);
      assert(zip.subarray(0, 2).toString() === 'PK' && zip.length > 200,
        `and the body really is an archive (${zip.length} bytes)`);
      assert(zip.includes(Buffer.from('_sourcing-requests.csv')),
        'with the manifest that tells the contact what each photo is for');
      assert(!zip.includes(Buffer.from('_download_errors.txt')),
        'and every photo resolved — no error note in the ZIP');
    }

    // ── The answer comes back: the operator records the corrected stall.
    const CORRECTED = { shop: 'leo', stall: '汇通B2-14' };
    {
      const res = await fetch(`${BASE}/api/route/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          receipt_id: 5001,
          item_key: CASE_KEY,
          title: CASE_TITLE,
          supplier_shop_override: CORRECTED.shop,
          supplier_stall_override: CORRECTED.stall,
        }),
      });
      const saved = await res.json();
      assert(res.status === 200 && saved.resolved_wrong_stall?.join() === 'case',
        'saving the corrected stall closes the report it answers');
      assert(saved.assignment.status_case === 'Pending',
        'and hands the line back as ordinary outstanding work');
    }

    // ── Every order that followed that stall is answered too — and only those.
    {
      const { summary, by } = await dashboardRows();
      assert(by.get(5001).sourcing_reason === '' && by.get(5001).supplier_stall === CORRECTED.stall,
        'the corrected line is sourced, at its new stall');
      assert(by.get(5003).status_case === 'Pending' && by.get(5003).supplier_stall === CORRECTED.stall,
        'the other order of the same product is re-pointed and its flag cleared with it');
      assert(by.get(5002).status_case === 'Wrong Stall' && by.get(5002).supplier_stall === PINNED.stall,
        'the order pinned to its own stall still reports one — nobody corrected THAT stall');
      assert(summary.supplier_wrong_stall === 1,
        `so one wrong-stall line is left (got ${summary.supplier_wrong_stall})`);
    }

    // ── And the export stops asking about what has been answered.
    {
      const res = await fetch(`${BASE}/api/route/download-unmatched-images`);
      await res.arrayBuffer();
      assert(res.headers.get('x-images-wrong-stall') === '1' && res.headers.get('x-images-requested') === '2',
        'the next request carries only the products still without an answer');
    }
  } catch (err) {
    failures++;
    console.error(`  FAIL — live round trip: ${err.message}`);
    if (stderr.trim()) console.error(stderr.trim().split('\n').slice(-8).join('\n'));
  } finally {
    child.kill();
    await new Promise((r) => child.once('exit', r));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

liveRoundTrip().then(() => {
  console.log('');
  if (failures > 0) {
    console.error(`${failures} assertion(s) FAILED`);
    process.exit(1);
  }
  console.log('All assertions passed.');
});
