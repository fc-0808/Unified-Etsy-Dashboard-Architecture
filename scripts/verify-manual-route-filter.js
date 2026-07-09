/**
 * One-off verification for the "Manual orders" Route-tab filter fix.
 *
 * Confirms that buildRouteRows returns the SAME manual orders whether the
 * dashboard is unsorted (no shop filter) or explicitly scoped to the synthetic
 * "Manual orders" shop (shop_id = '__manual__'). Prior to the fix the latter
 * returned nothing for Route-created manual orders.
 *
 * Read-only: it never writes to the database.
 */
const { loadConfig } = require('../src/config/schema');
const { initDb, MANUAL_SHOP_ID } = require('../src/db/setup');
const routeDashboard = require('../src/route/dashboard');

const config = loadConfig();
const db = initDb(config.db_path);

const base = { enrich_supplier: false };

const unsorted = routeDashboard.buildRouteRows(db, config, { ...base });
const manualOnly = routeDashboard.buildRouteRows(db, config, { ...base, shop_id: MANUAL_SHOP_ID });
const realShop = routeDashboard.buildRouteRows(db, config, { ...base, shop_id: '__nonexistent_shop__' });

const manualInUnsorted = unsorted.filter((r) => r.is_manual || r.shop_id === MANUAL_SHOP_ID);

const key = (r) => `${r.receipt_id}\x00${r.item_key}`;
const manualOnlySet = new Set(manualOnly.map(key));
const missing = manualInUnsorted.filter((r) => !manualOnlySet.has(key(r)));

console.log('── Manual-orders Route filter verification ─────────────────────');
console.log(`Unsorted rows total:                ${unsorted.length}`);
console.log(`  → manual rows within unsorted:    ${manualInUnsorted.length}`);
console.log(`Manual-only (shop_id=__manual__):   ${manualOnly.length}`);
console.log(`Bogus real-shop filter rows:        ${realShop.length} (expected 0)`);
console.log('');

const allManualOnlyAreManual = manualOnly.every((r) => r.is_manual || r.shop_id === MANUAL_SHOP_ID);

let ok = true;
if (missing.length > 0) {
  ok = false;
  console.log(`✗ FAIL: ${missing.length} manual order(s) visible unsorted are HIDDEN under the Manual-orders filter:`);
  missing.forEach((r) => console.log(`    receipt ${r.receipt_id} — ${r.title}`));
} else {
  console.log('✓ Every manual order visible when unsorted is ALSO visible under the Manual-orders filter.');
}

if (!allManualOnlyAreManual) {
  ok = false;
  const leak = manualOnly.filter((r) => !(r.is_manual || r.shop_id === MANUAL_SHOP_ID));
  console.log(`✗ FAIL: ${leak.length} NON-manual row(s) leaked into the Manual-orders filter.`);
} else {
  console.log('✓ The Manual-orders filter contains ONLY manual orders (no Etsy orders leaked in).');
}

if (manualOnly.length > 0) {
  console.log('');
  console.log('Sample manual-only rows:');
  manualOnly.slice(0, 5).forEach((r) => {
    console.log(`    receipt ${r.receipt_id} | is_manual=${r.is_manual} | ${r.phone_model} | ${r.style} | ${r.title}`);
  });
}

console.log('');
console.log(ok ? '✅ PASS' : '❌ FAIL');
db.close();
process.exit(ok ? 0 : 1);
