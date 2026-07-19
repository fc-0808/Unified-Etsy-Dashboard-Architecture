'use strict';

/**
 * Regression test — a bulk-listing run must land in the shop section that
 * matches its PRODUCT TYPE, resolved against the shop's CURRENT sections.
 *
 * Reproduces and guards against the defect where an AirPods run was tagged with
 * the "iPhone Cases" section: at dry-run time the shop had only an "iPhone
 * Cases" section, and the section <select> silently defaulted to that first
 * option, baking shop_section_id=<iPhone Cases> into the run's stored overrides.
 * When the operator later created an "AirPods Cases" section and pushed the run,
 * the stale iPhone section would have been used.
 *
 * Fix: reconcileShopSection() resolves the section against the shop's live
 * sections at publish time — honouring a deliberate choice, but self-correcting
 * a stale id or one owned by a different product type, and adopting a matching
 * section created after the dry run. The runner also force-refreshes shop
 * settings on real (non-dry) runs so newly-created sections are visible.
 *
 * Run: `node scripts/test-shop-section-reconcile.js`
 * Exit code 0 = all assertions pass, 1 = a regression was detected.
 */

const { reconcileShopSection } = require('../src/listings/shop-settings');
const { getProductType } = require('../src/listings/product-types');

const iphone = getProductType('iphone_case');
const airpods = getProductType('airpods_case');

const IP = { shop_section_id: 57228761, title: 'iPhone Cases' };
const AP = { shop_section_id: 99900001, title: 'AirPods Cases' };
const BEST = { shop_section_id: 12345, title: 'Best Sellers' };

let failures = 0;
function eq(name, got, want) {
  if (got === want) {
    console.log(`  ok  — ${name}`);
  } else {
    console.error(`  FAIL — ${name} (got ${got}, want ${want})`);
    failures++;
  }
}

// The original defect: AirPods run, section baked to "iPhone Cases", and an
// "AirPods Cases" section now exists → must correct to AirPods Cases.
eq('airpods run pinned to iPhone section corrects to AirPods Cases', reconcileShopSection(57228761, [IP, AP], airpods), 99900001);

// AirPods run pinned to iPhone section, but no AirPods section yet → NO section
// (never silently use the iPhone one).
eq('airpods run, no airpods section yet -> none', reconcileShopSection(57228761, [IP], airpods), null);

// Already correct / auto cases.
eq('airpods already on AirPods Cases -> kept', reconcileShopSection(99900001, [IP, AP], airpods), 99900001);
eq('airpods auto (no choice) -> AirPods Cases', reconcileShopSection(null, [IP, AP], airpods), 99900001);
eq('iphone auto (no choice) -> iPhone Cases', reconcileShopSection(null, [IP, AP], iphone), 57228761);

// Deliberate custom sections (no device word) must be respected, never clobbered.
eq('iphone deliberate "Best Sellers" respected', reconcileShopSection(12345, [IP, AP, BEST], iphone), 12345);
eq('airpods deliberate "Best Sellers" respected', reconcileShopSection(12345, [AP, BEST], airpods), 12345);

// Stale ids (section deleted / from another shop) → auto-detect.
eq('iphone stale id -> auto iPhone Cases', reconcileShopSection(88888888, [IP, BEST], iphone), 57228761);
eq('airpods stale id -> auto AirPods Cases', reconcileShopSection(88888888, [IP, AP], airpods), 99900001);

// No sections at all → none.
eq('no sections -> none', reconcileShopSection(57228761, [], airpods), null);

if (failures) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll shop-section reconciliation assertions passed.');
