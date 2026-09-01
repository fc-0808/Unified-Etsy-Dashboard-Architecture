'use strict';

/**
 * Regression test — reordering charms in Manage charms must NEVER change which
 * physical charm an order is assigned to, and charm codes are STABLE identities.
 *
 * Reproduces and guards against the defect where dragging charms to reorder them
 * renumbered codes by position (CH-00001, CH-00002, …) and then tried to remap
 * every route_assignments / product_assignments reference AND rename every image
 * on disk to follow. Any inconsistency in that fragile multi-step rename left an
 * order pointing at the WRONG physical charm (e.g. a Toy Story order that should
 * keep CH-00065 ended up on CH-00064).
 *
 * Fix: reordering updates ONLY sort_order. Codes never change, so assignments
 * and image files are untouched. A deliberate code rename (edit) still carries
 * its references across so orders are never orphaned.
 *
 * Run: `node scripts/test-charm-reorder.js`
 * Exit code 0 = all assertions pass, 1 = a regression was detected.
 */

const Database = require('better-sqlite3');
const setup = require('../src/db/setup');

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
    CREATE TABLE charm_library (
      code TEXT PRIMARY KEY, default_charm_shop TEXT DEFAULT '',
      notes TEXT DEFAULT '', image_file TEXT DEFAULT '', sort_order INTEGER DEFAULT 0,
      updated_at INTEGER
    );
    CREATE TABLE route_assignments (
      receipt_id INTEGER, item_key TEXT, title TEXT, charm_code TEXT DEFAULT '',
      charm_shop TEXT DEFAULT '', updated_at INTEGER, PRIMARY KEY (receipt_id, item_key)
    );
    CREATE TABLE product_assignments (
      item_key TEXT PRIMARY KEY, title TEXT, charm_code TEXT DEFAULT '', charm_shop TEXT DEFAULT ''
    );
    CREATE TABLE product_map (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title_norm TEXT NOT NULL UNIQUE,
      title TEXT DEFAULT '', charm_code TEXT DEFAULT '', charm_shop TEXT DEFAULT ''
    );
  `);
  return db;
}

// Three charms; the "Toy Story" charm is CH-00065, assigned to an order.
function seed(db) {
  const charms = [
    { code: 'CH-00063', default_charm_shop: '壳引力', notes: '', image_file: 'CH-00063.jpg', sort_order: 0 },
    { code: 'CH-00064', default_charm_shop: '壳引力', notes: '', image_file: 'CH-00064.jpg', sort_order: 1 },
    { code: 'CH-00065', default_charm_shop: '壳引力', notes: '', image_file: 'CH-00065.jpg', sort_order: 2 },
  ];
  setup.replaceCharmLibrary(db, charms);
  // A Toy Story order line is assigned CH-00065.
  db.prepare('INSERT INTO route_assignments (receipt_id, item_key, title, charm_code, charm_shop) VALUES (?,?,?,?,?)')
    .run(4111844924, 'toy-story#L1', 'Toy Story Characters Red MAGSAFE Phone Case', 'CH-00065', '壳引力');
  db.prepare('INSERT INTO product_assignments (item_key, title, charm_code, charm_shop) VALUES (?,?,?,?)')
    .run('toy-story#L1', 'Toy Story', 'CH-00065', '壳引力');
}

const db = makeDb();
seed(db);

const assignedCode = () =>
  db.prepare('SELECT charm_code FROM route_assignments WHERE receipt_id=? AND item_key=?')
    .get(4111844924, 'toy-story#L1').charm_code;
const codesInOrder = () => setup.getCharmLibrary(db).map((c) => c.code);
const imageOf = (code) => (setup.getCharmLibrary(db).find((c) => c.code === code) || {}).image_file;

console.log('Charm reorder stability regression test\n');

assert(assignedCode() === 'CH-00065', 'before: Toy Story order is assigned CH-00065');
assert(imageOf('CH-00065') === 'CH-00065.jpg', 'before: CH-00065 image is CH-00065.jpg');

// — Reorder: move CH-00065 (Toy Story) to the FRONT of the list. —
setup.reorderCharmLibrary(db, ['CH-00065', 'CH-00063', 'CH-00064']);

assert(JSON.stringify(codesInOrder()) === JSON.stringify(['CH-00065', 'CH-00063', 'CH-00064']),
  `after: display order follows the drag (got ${codesInOrder().join(', ')})`);
assert(assignedCode() === 'CH-00065',
  `after reorder: the order is STILL assigned CH-00065 — the physical charm never changed (got ${assignedCode()})`);
assert(imageOf('CH-00065') === 'CH-00065.jpg',
  'after reorder: CH-00065 keeps its own image file (no rename)');
assert(setup.getCharmLibrary(db).map((c) => c.code).sort().join(',') === 'CH-00063,CH-00064,CH-00065',
  'after reorder: the SAME three codes still exist (none renumbered)');

// — sort_order is repacked 0..N-1 in the new order. —
{
  const byCode = new Map(setup.getCharmLibrary(db).map((c) => [c.code, c.sort_order]));
  assert(byCode.get('CH-00065') === 0 && byCode.get('CH-00063') === 1 && byCode.get('CH-00064') === 2,
    'after reorder: sort_order = 0,1,2 in the new visual order');
}

// — A full-permutation guard still rejects a partial list. —
{
  let threw = false;
  try { setup.reorderCharmLibrary(db, ['CH-00065']); } catch (e) { threw = e && e.code === 'REQUIRED'; }
  assert(threw, 'a partial reorder list is rejected (full permutation required)');
}

// — A deliberate code RENAME carries the assignment across (no orphaning). —
setup.updateCharmLibraryRow(db, { orig_code: 'CH-00065', code: 'CH-90000' });
assert(assignedCode() === 'CH-90000',
  `manual code rename remaps the order's charm_code CH-00065 → CH-90000 (got ${assignedCode()})`);
assert(db.prepare('SELECT charm_code FROM product_assignments WHERE item_key=?').get('toy-story#L1').charm_code === 'CH-90000',
  'manual code rename also remaps the product-level default');

db.close();

console.log('');
if (failures > 0) {
  console.error(`${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log('All assertions passed.');
