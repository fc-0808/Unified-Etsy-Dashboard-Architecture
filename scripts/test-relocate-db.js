'use strict';

/** End-to-end test of main SQLite relocation using temporary fixtures only. */
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ued-relocate-db-'));
try {
  const syncedDir = path.join(root, 'OneDrive', 'project-data');
  const sourceDb = path.join(syncedDir, 'dashboard.db');
  const targetDir = path.join(root, 'safe-data');
  const targetDb = path.join(targetDir, 'etsy_dashboard.db');
  const configPath = path.join(root, 'config.json');
  fs.mkdirSync(syncedDir, { recursive: true });
  const db = new Database(sourceDb);
  db.exec('CREATE TABLE fixture (id INTEGER PRIMARY KEY, value TEXT)');
  db.prepare('INSERT INTO fixture (value) VALUES (?)').run('preserved');
  db.close();

  fs.writeFileSync(configPath, JSON.stringify({
    db_path: sourceDb,
    auto_restock_enabled: false,
    groups: [{
      group_id: 'test',
      label: 'Test',
      proxy: 'direct',
      shops: [{
        shop_id: '1',
        shop_name: 'TestShop',
        api_key: 'test-key',
        shared_secret: 'test-secret',
      }],
    }],
  }, null, 2));

  const run = spawnSync(
    process.execPath,
    [path.resolve(__dirname, 'relocate-db.js')],
    {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        DASHBOARD_CONFIG_PATH: configPath,
        DASHBOARD_DB_DIR: targetDir,
      },
      encoding: 'utf8',
    }
  );
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(fs.existsSync(targetDb), true);
  const copied = new Database(targetDb, { readonly: true });
  assert.equal(copied.prepare('SELECT value FROM fixture').get().value, 'preserved');
  copied.close();

  const updated = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(path.resolve(updated.db_path), path.resolve(targetDb));
  assert.equal(fs.existsSync(sourceDb), false);
  assert.equal(
    fs.readdirSync(syncedDir).some((name) => name.startsWith('dashboard.db.moved-')),
    true
  );
  assert.equal(
    fs.readdirSync(root).some((name) => name.startsWith('config.json.bak-')),
    true
  );

  console.log('PASS — database relocation verifies, repoints, backs up config, and preserves source');
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
