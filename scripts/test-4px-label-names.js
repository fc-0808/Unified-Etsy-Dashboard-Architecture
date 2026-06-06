'use strict';

/**
 * Regression test — 4PX bulk label filenames.
 *
 * Guards the invariants the operator relies on when bulk-downloading shipping
 * labels with "Ship with 4PX":
 *   1. Every label is its OWN independent file (one per receipt).
 *   2. Each file is named by the CORRECT buyer for that receipt.
 *   3. No label is ever overwritten — duplicate buyer names get a numeric
 *      suffix, and de-dup is CASE-INSENSITIVE (Windows/macOS filesystems treat
 *      "Jane.pdf" and "jane.pdf" as the same file).
 *   4. Empty / illegal buyer names fall back safely.
 *
 * Run: `node scripts/test-4px-label-names.js`  (exit 0 = pass, 1 = regression)
 */

const { safeLabelBaseName, assignUniqueLabelNames } = require('../src/fourpx/orders');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ok  — ${msg}`); }
  else { failures++; console.error(`  FAIL — ${msg}`); }
}

console.log('4PX bulk label filename regression test\n');

// 1. One independent, correctly-named file per receipt.
{
  const items = [
    { receiptId: 1, buyerName: 'Charlotte Wong', trackingNo: 'T1' },
    { receiptId: 2, buyerName: 'Tammie Wingo', trackingNo: 'T2' },
    { receiptId: 3, buyerName: 'Elizabeth Franklin', trackingNo: 'T3' },
  ];
  const names = assignUniqueLabelNames(items);
  assert(names.size === 3, 'three receipts -> three filenames');
  assert(names.get(1) === 'Charlotte Wong.pdf', 'receipt 1 -> "Charlotte Wong.pdf"');
  assert(names.get(2) === 'Tammie Wingo.pdf', 'receipt 2 -> "Tammie Wingo.pdf"');
  assert(names.get(3) === 'Elizabeth Franklin.pdf', 'receipt 3 -> "Elizabeth Franklin.pdf"');
  const all = [...names.values()];
  assert(new Set(all).size === all.length, 'all filenames are unique');
}

// 2. Exact-duplicate buyer names never overwrite each other.
{
  const items = [
    { receiptId: 10, buyerName: 'Maya Khan', trackingNo: 'A' },
    { receiptId: 11, buyerName: 'Maya Khan', trackingNo: 'B' },
    { receiptId: 12, buyerName: 'Maya Khan', trackingNo: 'C' },
  ];
  const names = assignUniqueLabelNames(items);
  assert(names.get(10) === 'Maya Khan.pdf', 'first duplicate -> "Maya Khan.pdf"');
  assert(names.get(11) === 'Maya Khan (2).pdf', 'second duplicate -> "Maya Khan (2).pdf"');
  assert(names.get(12) === 'Maya Khan (3).pdf', 'third duplicate -> "Maya Khan (3).pdf"');
}

// 3. CASE-INSENSITIVE de-dup (the hardening fix) — these collide on Win/macOS.
{
  const items = [
    { receiptId: 20, buyerName: 'John Smith', trackingNo: 'A' },
    { receiptId: 21, buyerName: 'john smith', trackingNo: 'B' },
  ];
  const names = assignUniqueLabelNames(items);
  const lower = [...names.values()].map((n) => n.toLowerCase());
  assert(new Set(lower).size === 2,
    `case-only duplicates get distinct filenames (got: ${[...names.values()].join(', ')})`);
}

// 4. Empty / whitespace buyer names fall back to the tracking number.
{
  const items = [
    { receiptId: 30, buyerName: '   ', trackingNo: '4PX999CN' },
    { receiptId: 31, buyerName: '', trackingNo: '4PX888CN' },
  ];
  const names = assignUniqueLabelNames(items);
  assert(names.get(30) === '4PX999CN.pdf', 'blank buyer -> tracking-number filename');
  assert(names.get(31) === '4PX888CN.pdf', 'empty buyer -> tracking-number filename');
}

// 5. Illegal filename characters are stripped; trailing space trimmed.
{
  assert(safeLabelBaseName('MAEVE ') === 'MAEVE', 'trailing space trimmed');
  assert(safeLabelBaseName('A/B:C*?"<>|D') === 'ABCD', 'illegal characters removed');
  assert(safeLabelBaseName('', 'fallback') === 'fallback', 'empty -> fallback');
  assert(safeLabelBaseName('   ', 'TRK1') === 'TRK1', 'whitespace-only -> fallback');
}

console.log('');
if (failures > 0) {
  console.error(`${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log('All assertions passed.');
