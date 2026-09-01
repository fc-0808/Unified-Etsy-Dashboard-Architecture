'use strict';

/** End-to-end test of route-data relocation using only temporary fixtures. */
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ued-relocate-route-'));
try {
  const engineRoot = path.join(root, 'route-engine');
  const sourceData = path.join(engineRoot, 'data');
  const targetData = path.join(root, 'safe-data');
  const configPath = path.join(root, 'config.json');
  fs.mkdirSync(path.join(engineRoot, 'src'), { recursive: true });
  fs.mkdirSync(sourceData, { recursive: true });
  fs.writeFileSync(path.join(engineRoot, 'src', 'generate_shopping_route.py'), '# fixture\n');
  fs.writeFileSync(path.join(sourceData, 'charm_manifest.json'), '{"charms":[]}\n');
  const catalogDb = new Database(path.join(sourceData, 'etsy_orders.db'));
  catalogDb.exec('CREATE TABLE fixture (id INTEGER PRIMARY KEY)');
  catalogDb.close();

  fs.writeFileSync(configPath, JSON.stringify({
    db_path: path.join(root, 'dashboard.db'),
    auto_restock_enabled: false,
    route_engine_dir: engineRoot,
    route_engine_data_dir: null,
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
    [path.resolve(__dirname, 'relocate-route-data.js')],
    {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        DASHBOARD_CONFIG_PATH: configPath,
        ROUTE_ENGINE_DATA_DIR: targetData,
      },
      encoding: 'utf8',
    }
  );
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(fs.existsSync(path.join(targetData, 'etsy_orders.db')), true);
  assert.equal(fs.existsSync(path.join(targetData, 'charm_manifest.json')), true);
  const moved = fs.readdirSync(engineRoot).filter((name) => name.startsWith('data.moved-'));
  assert.equal(moved.length, 1);
  const updated = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(path.resolve(updated.route_engine_data_dir), path.resolve(targetData));

  console.log('PASS — route data relocation copies, verifies, repoints, and preserves the source');
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
