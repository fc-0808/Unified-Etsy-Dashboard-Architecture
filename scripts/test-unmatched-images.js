'use strict';

/**
 * Regression tests for route-tab "Export images" (unmatched product ZIP).
 *
 * Route rows expose same-origin `/api/route/*` image URLs. The export must
 * resolve bytes from DB/cache — not fetch relative URLs (which always fail in
 * Node). Run: node scripts/test-unmatched-images.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');

const unmatched = require('../src/route/unmatched-images');

let passed = 0;
let failed = 0;

function ok(name) {
  passed++;
  console.log(`  PASS  ${name}`);
}

function fail(name, err) {
  failed++;
  console.error(`  FAIL  ${name}: ${err.message || err}`);
}

function test(name, fn) {
  try {
    fn();
    ok(name);
  } catch (err) {
    fail(name, err);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    fail(name, err);
  }
}

// ── URL parsing ─────────────────────────────────────────────────────────────

test('parseRouteImageUrl: listing-image', () => {
  const p = unmatched.parseRouteImageUrl('/api/route/listing-image/4498110917?w=300');
  assert.strictEqual(p.kind, 'listing');
  assert.strictEqual(p.id, 4498110917);
});

test('parseRouteImageUrl: variation-image with style key', () => {
  const p = unmatched.parseRouteImageUrl('/api/route/variation-image/4497126098?k=Case%20Only&v=1787027198');
  assert.strictEqual(p.kind, 'variation');
  assert.strictEqual(p.id, 4497126098);
  assert.strictEqual(p.style, 'Case Only');
});

test('parseRouteImageUrl: style-image', () => {
  const p = unmatched.parseRouteImageUrl('/api/route/style-image/42?v=100');
  assert.strictEqual(p.kind, 'style');
  assert.strictEqual(p.id, 42);
});

test('parseRouteImageUrl: absolute CDN url', () => {
  const url = 'https://i.etsystatic.com/64348201/r/il/8042c9/8016165557/il_570xN.8016165557_rzk0.jpg';
  const p = unmatched.parseRouteImageUrl(url);
  assert.strictEqual(p.kind, 'cdn');
  assert.strictEqual(p.cdnUrl, url);
});

// ── collectUnmatchedImageItems ──────────────────────────────────────────────

test('collectUnmatchedImageItems: skips catalog matches and dedupes', () => {
  const rows = [
    { excluded: 0, supplier_in_catalog: false, supplier_is_override: false, image_url: '/api/route/listing-image/1', item_key: 'a', title: 'Product A', receipt_id: 100, listing_id: 1, product_listing_id: 1 },
    { excluded: 0, supplier_in_catalog: false, supplier_is_override: false, image_url: '/api/route/listing-image/1', item_key: 'a', title: 'Product A dup', receipt_id: 101, listing_id: 1, product_listing_id: 1 },
    { excluded: 0, supplier_in_catalog: true, supplier_is_override: false, image_url: '/api/route/listing-image/2', item_key: 'b', title: 'Product B', receipt_id: 102, listing_id: 2 },
    { excluded: 1, supplier_in_catalog: false, supplier_is_override: false, image_url: '/api/route/listing-image/3', item_key: 'c', title: 'Product C', receipt_id: 103, listing_id: 3 },
    { excluded: 0, supplier_in_catalog: false, supplier_is_override: false, image_url: null, item_key: 'd', title: 'Product D', receipt_id: 104, listing_id: 4 },
  ];
  const items = unmatched.collectUnmatchedImageItems(rows);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].url, '/api/route/listing-image/1');
  assert.match(items[0].name, /^1_Product A\.jpg$/);
  assert.strictEqual(items[0].reason, 'not_in_catalog');
  // The duplicate order adds demand, not a second photo.
  assert.strictEqual(items[0].orders, 2);
});

// ── Wrong Stall lines belong in the same request ─────────────────────────────

/** A line with a supplier on record and every component pending. */
function sourcedRow(over) {
  return {
    excluded: 0,
    supplier_in_catalog: true,
    supplier_is_override: false,
    supplier_shop: '卡夫',
    supplier_stall: '康乐北区5C34-39',
    image_url: '/api/route/listing-image/9',
    item_key: 'w',
    title: 'Clear Glitter Case',
    receipt_id: 4148613801,
    listing_id: 9,
    product_listing_id: 9,
    quantity: 1,
    has_case: 1,
    has_grip: 0,
    has_charm: 0,
    status_case: 'Pending',
    status_grip: 'Pending',
    status_charm: 'Pending',
    ...over,
  };
}

test('a matched line with no complaint is not exported', () => {
  assert.strictEqual(unmatched.collectUnmatchedImageItems([sourcedRow()]).length, 0);
});

test('Wrong Stall exports the photo and quotes the stall already tried', () => {
  const items = unmatched.collectUnmatchedImageItems([sourcedRow({ status_case: 'Wrong Stall' })]);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].reason, 'wrong_stall');
  assert.strictEqual(items[0].reason_label, 'Wrong stall');
  assert.strictEqual(items[0].components, 'case');
  assert.strictEqual(items[0].recorded_shop, '卡夫');
  assert.strictEqual(items[0].recorded_stall, '康乐北区5C34-39');
});

test('Wrong Stall exports even when the supplier was set by hand', () => {
  const row = sourcedRow({ supplier_in_catalog: false, supplier_is_override: true, status_case: 'Wrong Stall' });
  const items = unmatched.collectUnmatchedImageItems([row]);
  assert.strictEqual(items.length, 1, 'a hand-entered stall can be wrong too');
  assert.strictEqual(items[0].reason, 'wrong_stall');
});

test('a Wrong Stall charm is exported with the charm shop, not the case stall', () => {
  const row = sourcedRow({ has_charm: 1, status_charm: 'Wrong Stall', charm_shop: '汇通a146' });
  const items = unmatched.collectUnmatchedImageItems([row]);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].components, 'charm');
  assert.strictEqual(items[0].recorded_shop, '汇通a146');
});

test('a Wrong Stall status on a component the line lacks is ignored', () => {
  // Charm-status leftovers on a case-only line must not fake a sourcing gap.
  const row = sourcedRow({ has_charm: 0, status_charm: 'Wrong Stall' });
  assert.strictEqual(unmatched.collectUnmatchedImageItems([row]).length, 0);
});

test('an excluded Wrong Stall line stays out of the export', () => {
  const row = sourcedRow({ excluded: 1, status_case: 'Wrong Stall' });
  assert.strictEqual(unmatched.collectUnmatchedImageItems([row]).length, 0);
});

test('one product asked about for two reasons quotes the stall that was tried', () => {
  // Two orders of the same product: one had a stall and it was wrong, the other
  // never had one. Naming a place that failed beats naming nothing, whichever
  // order is read first — so the merged ask must not depend on row order.
  const wrong = () => sourcedRow({ status_case: 'Wrong Stall' });
  const blank = () => sourcedRow({ receipt_id: 4148613802, supplier_in_catalog: false, supplier_shop: '', supplier_stall: '' });
  for (const rows of [[wrong(), blank()], [blank(), wrong()]]) {
    const items = unmatched.collectUnmatchedImageItems(rows);
    assert.strictEqual(items.length, 1, 'still one photo for one product');
    assert.strictEqual(items[0].orders, 2);
    assert.strictEqual(items[0].reason, 'wrong_stall');
    assert.strictEqual(items[0].recorded_stall, '康乐北区5C34-39');
  }
});

test('countItemsByReason splits the ZIP by what is being asked', () => {
  const items = unmatched.collectUnmatchedImageItems([
    sourcedRow({ status_case: 'Wrong Stall' }),
    sourcedRow({ item_key: 'x', listing_id: 10, product_listing_id: 10, image_url: '/api/route/listing-image/10', supplier_in_catalog: false, supplier_shop: '', supplier_stall: '' }),
  ]);
  const counts = unmatched.countItemsByReason(items);
  assert.strictEqual(counts.wrong_stall, 1);
  assert.strictEqual(counts.not_in_catalog, 1);
});

// ── Manifest ─────────────────────────────────────────────────────────────────

test('the manifest is Excel-safe CSV built from the real entry names', () => {
  const [item] = unmatched.collectUnmatchedImageItems([
    sourcedRow({ status_case: 'Wrong Stall', title: 'Case, "glitter" style' }),
  ]);
  const csv = unmatched.buildSourcingManifestCsv([{ name: '9_Case_2.png', entry: item }]);
  assert.ok(csv.startsWith('\ufeff'), 'needs a BOM so Excel reads Chinese shop names');
  const lines = csv.trimEnd().split('\r\n');
  assert.strictEqual(lines.length, 2, 'a header plus one row');
  assert.ok(lines[0].startsWith('\ufeffFile,Product,'));
  // Commas and quotes inside a title must not break the columns.
  assert.ok(lines[1].startsWith('9_Case_2.png,"Case, ""glitter"" style"'), lines[1]);
  assert.ok(lines[1].includes('Wrong stall'));
  assert.ok(lines[1].includes('康乐北区5C34-39'));
});

test('the manifest header stays stable for whoever reads the ZIP', () => {
  const csv = unmatched.buildSourcingManifestCsv([]);
  assert.strictEqual(
    csv.trimEnd(),
    '\ufeffFile,Product,Model,Style,We need,For,Stall already tried,Orders waiting,Units needed,Listing',
  );
});

// ── Isolated DB integration (never reads live config/order data) ─────────────

async function runIsolatedIntegrationTests() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ued-unmatched-images-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const { initDb, upsertListingStyleImage } = require('../src/db/setup');
  const db = initDb(dbPath);

  // Deterministic non-trivial PNG-like bytes. Resolution only needs a stored
  // image; decoding is not part of this module's contract.
  const image = Buffer.alloc(2048, 0x5a);
  image[0] = 0x89;
  image[1] = 0x50;
  image[2] = 0x4e;
  image[3] = 0x47;
  const saved = upsertListingStyleImage(db, {
    listing_id: 9,
    style_value: '',
    image_data: image,
    image_mime: 'image/png',
    note: 'isolated test fixture',
  });
  const url = `/api/route/style-image/${saved.id}`;
  const items = [{
    url,
    name: '9_Test product.jpg',
    title: 'Test product',
    model: 'Test model',
    style: '',
    reason_label: 'Not in catalog',
    components: '',
    recorded_shop: '',
    recorded_stall: '',
    orders: 1,
    units: 1,
    listing_id: 9,
    product_listing_id: 9,
  }];

  try {
    await testAsync('isolated: resolveRouteImageBytes reads same-origin image bytes', async () => {
      const { buffer, ext } = await unmatched.resolveRouteImageBytes(db, url);
      assert.ok(buffer && buffer.length === image.length, 'expected complete stored image bytes');
      assert.strictEqual(ext, 'png');
    });

    await testAsync('isolated: streamUnmatchedImagesZip produces a non-empty archive', async () => {
      const out = new PassThrough();
      const chunks = [];
      out.on('data', (chunk) => chunks.push(chunk));

      const done = new Promise((resolve, reject) => {
        out.on('end', resolve);
        out.on('error', reject);
      });

      const { added, failed } = await unmatched.streamUnmatchedImagesZip(out, db, items);
      await done;

      const zip = Buffer.concat(chunks);
      assert.strictEqual(added, 1, `expected one image, failures=${failed.join('; ')}`);
      assert.deepStrictEqual(failed, []);
      assert.ok(zip.length > 100, 'zip should be non-trivial');
      assert.ok(zip[0] === 0x50 && zip[1] === 0x4b, 'output should be a ZIP (PK header)');
    });
  } finally {
    db.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

(async () => {
  console.log('\nUnmatched images export tests\n');
  await runIsolatedIntegrationTests();
  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
})();
