'use strict';

/**
 * Regression test — "buy this charm at the case/grip supplier".
 *
 * The Route tab's charm column can link a line's charm to the stall the case/grip
 * already comes from. For that single click to be TRUE end-to-end, four coupled
 * writes must all land (charmLibrary.linkCharmToSupplier):
 *
 *   1. charm_shop_directory — the supplier becomes a charm shop when it isn't one
 *      yet (matched by NAME, so a merchant is never listed twice; the shopper's
 *      charm stall is derived from this table).
 *   2. charm_library        — the code → shop mapping. This is the single source of
 *      truth buildRouteRows resolves a charm's shop through, so writing only the
 *      per-order snapshot would leave every view showing the OLD shop (the exact
 *      defect test-charm-supplier.js guards).
 *   3. route_assignments    — this order line's charm.
 *   4. product_assignments + product_map — the per-product default, so the next
 *      order of the same product inherits it.
 *
 * The operation must also be ATOMIC (no half-created charm shop when a later write
 * fails) and IDEMPOTENT (clicking twice changes nothing), and it must never
 * clobber a charm's existing photo / notes, nor a stall an operator recorded.
 *
 * Run: `node scripts/test-charm-from-supplier.js`
 * Exit code 0 = all assertions pass, 1 = a regression was detected.
 */

const Database = require('better-sqlite3');
const charmLibrary = require('../src/route/charm-library');

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  ok  — ${msg}`);
  } else {
    failures++;
    console.error(`  FAIL — ${msg}`);
  }
}
function throws(fn, msg) {
  try {
    fn();
    failures++;
    console.error(`  FAIL — ${msg} (no error thrown)`);
  } catch {
    console.log(`  ok  — ${msg}`);
  }
}

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
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
      code TEXT PRIMARY KEY, default_charm_shop TEXT DEFAULT '',
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

const LINE = { receipt_id: 4128662052, item_key: 'mamegoma-pink#L1', title: 'Mamegoma Pink iPhone Case with Charm' };
const shops = (db) => db.prepare('SELECT shop_name, stall FROM charm_shop_directory ORDER BY sort_order').all();
const lib = (db, code) => db.prepare('SELECT * FROM charm_library WHERE code = ?').get(code);
const assigned = (db) => db.prepare('SELECT charm_code, charm_shop FROM route_assignments WHERE receipt_id = ? AND item_key = ?').get(LINE.receipt_id, LINE.item_key);
const productDefault = (db) => db.prepare('SELECT charm_code, charm_shop FROM product_assignments WHERE item_key = ?').get(LINE.item_key);
const catalog = (db) => db.prepare('SELECT charm_code, charm_shop FROM product_map').all();

console.log('Charm-from-supplier regression test\n');

// ── 1. A brand-new charm at a supplier that is not yet a charm shop ──────────
{
  const db = makeDb();
  const code = charmLibrary.allocateNextCode(db); // empty library → CH-00001
  const out = charmLibrary.linkCharmToSupplier(db, { ...LINE, code, shop_name: '壳引力', stall: 'A2-33' });

  assert(out.created_charm === true && out.created_shop === true, 'reports the charm AND the charm shop as newly created');
  assert(shops(db).length === 1 && shops(db)[0].shop_name === '壳引力' && shops(db)[0].stall === 'A2-33', 'supplier is added to the charm-shop directory with its stall');
  assert(lib(db, code) && lib(db, code).default_charm_shop === '壳引力', 'charm library maps the code to the supplier (the source of truth every view resolves through)');
  assert(assigned(db) && assigned(db).charm_code === code && assigned(db).charm_shop === '壳引力', 'the order line is assigned the charm at the supplier');
  assert(productDefault(db) && productDefault(db).charm_code === code, 'the per-product default is set so future orders inherit it');
  assert(catalog(db).length === 1 && catalog(db)[0].charm_shop === '壳引力', 'the product catalog (product_map) is written through');
  assert(charmLibrary.allocateNextCode(db) === 'CH-00002', 'the next allocated code advances past the one just created');
}

// ── 2. Idempotency — clicking twice changes nothing ─────────────────────────
{
  const db = makeDb();
  const code = 'CH-00007';
  charmLibrary.linkCharmToSupplier(db, { ...LINE, code, shop_name: '壳引力', stall: 'A2-33' });
  const again = charmLibrary.linkCharmToSupplier(db, { ...LINE, code, shop_name: '壳引力', stall: 'A2-33' });

  assert(again.created_charm === false && again.created_shop === false, 're-running reports nothing new was created');
  assert(shops(db).length === 1, 'the charm shop is not duplicated');
  assert(db.prepare('SELECT COUNT(*) n FROM charm_library').get().n === 1, 'the charm is not duplicated');
  assert(assigned(db).charm_code === code && assigned(db).charm_shop === '壳引力', 'the assignment is unchanged');
}

// ── 3. Re-pointing an EXISTING charm keeps its notes / photo ────────────────
{
  const db = makeDb();
  db.prepare("INSERT INTO charm_library (code, default_charm_shop, notes, image_file, sort_order) VALUES ('CH-00055','小艾飾品','beaded','CH-00055.jpg',0)").run();
  db.prepare("INSERT INTO charm_shop_directory (shop_name, stall, sort_order) VALUES ('小艾飾品','2D41-43',0)").run();

  const out = charmLibrary.linkCharmToSupplier(db, { ...LINE, code: 'CH-00055', shop_name: '壳引力', stall: 'A2-33' });
  const row = lib(db, 'CH-00055');

  assert(out.created_charm === false, 'an existing charm is updated, not recreated');
  assert(row.default_charm_shop === '壳引力', 'the charm is re-pointed at the supplier');
  assert(row.notes === 'beaded' && row.image_file === 'CH-00055.jpg', 'notes and photo survive the re-point (image_file omitted = keep)');
  assert(shops(db).length === 2, 'the new supplier is added alongside the old charm shop (which is left intact)');
}

// ── 4. Supplier already listed as a charm shop but with NO stall → complete it
{
  const db = makeDb();
  db.prepare("INSERT INTO charm_shop_directory (shop_name, stall, sort_order) VALUES ('壳引力','',0)").run();
  const out = charmLibrary.linkCharmToSupplier(db, { ...LINE, code: 'CH-00001', shop_name: '壳引力', stall: 'A2-33' });

  assert(out.created_shop === false && out.filled_stall === true, 'reports the blank stall as completed rather than a new shop');
  assert(shops(db).length === 1 && shops(db)[0].stall === 'A2-33', "the existing entry's missing stall is filled in, with no duplicate row");
}

// ── 5. Directory records a DIFFERENT stall → never overwritten, but reported ─
{
  const db = makeDb();
  db.prepare("INSERT INTO charm_shop_directory (shop_name, stall, sort_order) VALUES ('壳引力','B1-07',0)").run();
  const out = charmLibrary.linkCharmToSupplier(db, { ...LINE, code: 'CH-00001', shop_name: '壳引力', stall: 'A2-33' });

  assert(shops(db).length === 1 && shops(db)[0].stall === 'B1-07', "an operator-recorded stall is never overwritten");
  assert(out.stall_mismatch === 'B1-07' && out.charm_stall === 'B1-07', 'the conflict is reported (and the real stall returned) instead of silently diverging');
  assert(lib(db, 'CH-00001').default_charm_shop === '壳引力', 'the charm is still linked to the supplier shop');
}

// ── 6. Merchant matching ignores case / surrounding spaces ──────────────────
{
  const db = makeDb();
  db.prepare("INSERT INTO charm_shop_directory (shop_name, stall, sort_order) VALUES ('Case Force','A2-33',0)").run();
  const out = charmLibrary.linkCharmToSupplier(db, { ...LINE, code: 'CH-00001', shop_name: '  case force  ', stall: 'A2-33' });

  assert(out.created_shop === false && shops(db).length === 1, 'a same-merchant name in different case/spacing does not create a second entry');
  assert(lib(db, 'CH-00001').default_charm_shop === 'case force', 'the trimmed supplier name is what gets stored');
}

// ── 7. Atomicity — a failure part-way through writes NOTHING ────────────────
{
  const db = makeDb();
  db.exec('DROP TABLE route_assignments'); // force the 3rd write to fail
  let threw = false;
  try {
    charmLibrary.linkCharmToSupplier(db, { ...LINE, code: 'CH-00001', shop_name: '壳引力', stall: 'A2-33' });
  } catch {
    threw = true;
  }
  assert(threw, 'a failed write propagates as an error');
  assert(shops(db).length === 0, 'the charm shop created earlier in the transaction is rolled back');
  assert(db.prepare('SELECT COUNT(*) n FROM charm_library').get().n === 0, 'the charm library row is rolled back — no orphan charm');
}

// ── 8. An explicit photo is recorded on the library row ────────────────────
{
  const db = makeDb();
  charmLibrary.linkCharmToSupplier(db, { ...LINE, code: 'CH-00001', shop_name: '壳引力', stall: 'A2-33', image_file: 'CH-00001.png' });
  assert(lib(db, 'CH-00001').image_file === 'CH-00001.png', 'an uploaded photo filename is stored on the new charm');
}

// ── 9. Input validation ────────────────────────────────────────────────────
{
  const db = makeDb();
  throws(() => charmLibrary.linkCharmToSupplier(db, { ...LINE, code: 'CH 00001!', shop_name: '壳引力' }), 'rejects a charm code with illegal characters');
  throws(() => charmLibrary.linkCharmToSupplier(db, { ...LINE, code: 'CH-00001', shop_name: '   ' }), 'rejects a blank supplier shop (nothing to link to)');
  throws(() => charmLibrary.linkCharmToSupplier(db, { receipt_id: 1, item_key: '', code: 'CH-00001', shop_name: '壳引力' }), 'rejects a missing item_key');
  assert(shops(db).length === 0 && db.prepare('SELECT COUNT(*) n FROM charm_library').get().n === 0, 'no partial state is left behind by rejected input');
}

console.log(failures ? `\n${failures} assertion(s) FAILED` : '\nAll assertions passed.');
process.exit(failures ? 1 : 0);
