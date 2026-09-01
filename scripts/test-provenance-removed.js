'use strict';

/**
 * Guards the removal of design-supplier provenance ("which QQ / WeChat chat did
 * this design come from?").
 *
 * The feature was withdrawn because the signal it depended on does not exist:
 * bulk imports arrive as folders named after the Etsy SHOP a drop was published
 * to, and a single one of those folders mixes designs from several chats — so
 * no attribution derived from the folder name could ever be true.
 *
 * These tests pin the removal in three places that would otherwise rot back in
 * quietly: the module graph, the database schema, and the sourcing registry's
 * write path.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const repoRoot = path.resolve(__dirname, '..');
const results = [];

function check(name, fn) {
  fn();
  results.push(name);
}

// ── 1. The modules and their entry points are gone ──────────────────────────

check('the provenance modules and their CLI no longer exist', () => {
  for (const rel of [
    'src/listings/provenance.js',
    'src/listings/provenance-history.js',
    'scripts/backfill-listing-provenance.js',
  ]) {
    assert.equal(fs.existsSync(path.join(repoRoot, rel)), false, `${rel} should have been deleted`);
  }
});

check('nothing in src/ still requires a provenance module', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(abs); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const src = fs.readFileSync(abs, 'utf8');
      if (/require\((['"]).*provenance(-history)?\1\)/.test(src)) {
        offenders.push(path.relative(repoRoot, abs));
      }
    }
  };
  walk(path.join(repoRoot, 'src'));
  assert.deepEqual(offenders, [], 'dangling require of a deleted provenance module');
});

check('the database module exports no provenance accessors', () => {
  const setup = require('../src/db/setup');
  const leaked = Object.keys(setup).filter((k) => /provenance/i.test(k));
  assert.deepEqual(leaked, [], 'db/setup still exports provenance accessors');
});

// ── 2. A fresh database carries none of the retired schema ──────────────────

const { initDb } = require('../src/db/setup');
const retiredColumns = {
  bulk_jobs: ['supplier_id', 'supplier_name', 'supplier_source'],
  bulk_job_items: ['supplier_id', 'supplier_name', 'supplier_source', 'supplier_confidence', 'supplier_evidence'],
  sourcing_suppliers: ['aliases'],
};

function assertSchemaIsClean(db, context) {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'listing_provenance'")
    .get();
  assert.equal(table, undefined, `${context}: listing_provenance should not exist`);

  for (const [tableName, columns] of Object.entries(retiredColumns)) {
    const present = new Set(db.pragma(`table_info(${tableName})`).map((c) => c.name));
    for (const column of columns) {
      assert.equal(present.has(column), false, `${context}: ${tableName}.${column} should have been dropped`);
    }
  }
}

const freshDb = initDb(':memory:');
try {
  check('a fresh database is created without the provenance schema', () => {
    assertSchemaIsClean(freshDb, 'fresh database');
  });

  // ── 3. The registry still works, minus the alias column ───────────────────
  // The Sourcing Library pre-dates provenance and must survive it intact.

  check('sourcing suppliers can still be created, read and updated', () => {
    const { insertSourcingSupplier, updateSourcingSupplier, getSourcingSuppliers, getSourcingSupplierById } =
      require('../src/db/setup');

    const created = insertSourcingSupplier(freshDb, {
      name: '壳引力',
      location: 'A209',
      qq: '12345',
      wechat: 'keyinli',
      notes: 'Case designs',
      // A stale caller passing the retired field must not break the insert.
      aliases: ['keyinli', 'KYL'],
    });
    assert.equal(created.name, '壳引力');
    assert.equal('aliases' in created, false, 'aliases must not survive on the returned row');

    const updated = updateSourcingSupplier(freshDb, created.id, { location: 'B110', aliases: ['ignored'] });
    assert.equal(updated.location, 'B110');
    assert.equal(updated.qq, '12345', 'unspecified fields keep their value');
    assert.equal('aliases' in updated, false);

    const listed = getSourcingSuppliers(freshDb);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].package_count, 0, 'package rollups are pre-existing and must still work');
    assert.equal('listing_count' in listed[0], false, 'listing_count came from provenance and is gone');
    assert.equal(getSourcingSupplierById(freshDb, created.id).name, '壳引力');
  });
} finally {
  freshDb.close();
}

// ── 4. An existing database is migrated, not merely ignored ─────────────────
// A database written before the removal still carries the columns and the
// table. Startup has to reclaim them, otherwise every future `table_info`
// reader sees a schema the code no longer understands.

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ued-provenance-removed-'));
try {
  const legacyPath = path.join(tmpDir, 'legacy.db');
  const legacy = initDb(legacyPath);
  // Re-create the retired schema exactly as the old build left it.
  legacy.exec(`
    ALTER TABLE bulk_jobs ADD COLUMN supplier_id INTEGER;
    ALTER TABLE bulk_jobs ADD COLUMN supplier_name TEXT NOT NULL DEFAULT '';
    ALTER TABLE bulk_jobs ADD COLUMN supplier_source TEXT NOT NULL DEFAULT 'none';
    ALTER TABLE bulk_job_items ADD COLUMN supplier_id INTEGER;
    ALTER TABLE bulk_job_items ADD COLUMN supplier_name TEXT NOT NULL DEFAULT '';
    ALTER TABLE bulk_job_items ADD COLUMN supplier_source TEXT NOT NULL DEFAULT 'none';
    ALTER TABLE bulk_job_items ADD COLUMN supplier_confidence TEXT NOT NULL DEFAULT 'none';
    ALTER TABLE bulk_job_items ADD COLUMN supplier_evidence TEXT NOT NULL DEFAULT '';
    ALTER TABLE sourcing_suppliers ADD COLUMN aliases TEXT NOT NULL DEFAULT '[]';
    CREATE TABLE listing_provenance (listing_id INTEGER PRIMARY KEY, supplier_id INTEGER, supplier_name TEXT);
  `);
  legacy.prepare(`
    INSERT INTO bulk_jobs (job_id, shop_key, shop_name, input_path, state, target_state, dry_run, total, supplier_name)
    VALUES ('job-1', 'Y2KASEofficial', 'Y2KASEofficial', 'C:/Downloads/0720_Y2KASEofficial', 'done', 'draft', 0, 3, 'wrong chat')
  `).run();
  legacy.prepare("INSERT INTO listing_provenance (listing_id, supplier_name) VALUES (1, 'wrong chat')").run();
  legacy.close();

  const migrated = initDb(legacyPath);
  try {
    check('reopening a pre-removal database drops the retired schema', () => {
      assertSchemaIsClean(migrated, 'migrated database');
    });

    check('migrating a pre-removal database preserves the run history itself', () => {
      const job = migrated.prepare("SELECT shop_name, input_path, total FROM bulk_jobs WHERE job_id = 'job-1'").get();
      assert.deepEqual(job, {
        shop_name: 'Y2KASEofficial',
        input_path: 'C:/Downloads/0720_Y2KASEofficial',
        total: 3,
      });
    });

    check('the migration is idempotent across restarts', () => {
      migrated.close();
      const again = initDb(legacyPath);
      try {
        assertSchemaIsClean(again, 'second reopen');
      } finally {
        again.close();
      }
    });
  } finally {
    try { migrated.close(); } catch { /* already closed by the idempotency check */ }
  }
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

for (const name of results) console.log(`  ok — ${name}`);
console.log(`PASS — design-supplier provenance is fully removed (${results.length} checks)`);
