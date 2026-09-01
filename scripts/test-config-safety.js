'use strict';

/** Offline tests for safe configuration defaults. */
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ued-config-safety-'));
const configPath = path.join(tempRoot, 'config.json');
process.env.DASHBOARD_CONFIG_PATH = configPath;
if (process.platform === 'win32') process.env.LOCALAPPDATA = path.join(tempRoot, 'LocalAppData');
else process.env.XDG_DATA_HOME = path.join(tempRoot, 'xdg-data');

const baseConfig = {
  sync_interval_minutes: 60,
  inv_watch_interval_minutes: 240,
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
};

try {
  fs.writeFileSync(configPath, JSON.stringify(baseConfig), 'utf8');
  const { defaultDbPath, loadConfig, isAutoRestockEnabled, patchRuntimeSettings, refreshConfigInPlace } = require('../src/config/schema');
  const { analyzeSuspensionRisks, enforceConfigCompliance } = require('../src/compliance/suspension-guard');

  const defaults = loadConfig();
  assert.equal(defaults.auto_restock_enabled, false);
  assert.equal(defaults.etsy_multi_key_approved, false);
  assert.equal(defaults.catalog_health_sync, false);
  assert.equal(defaults.etsy_api_analytics_approved, false);
  assert.equal(defaults.catalog_health_interval_hours, 24);
  assert.equal(isAutoRestockEnabled(defaults), false);
  assert.equal(isAutoRestockEnabled({}), false);
  assert.equal(isAutoRestockEnabled({ auto_restock_enabled: 'true' }), false);
  assert.equal(defaults.db_path, defaultDbPath());
  assert.equal(
    /onedrive|dropbox|google drive/i.test(defaults.db_path),
    false,
    'default database path must not use a synchronized folder'
  );

  const multiKeyConfig = {
    groups: [{
      group_id: 'multi',
      label: 'Multi',
      proxy: 'direct',
      shops: [
        { shop_id: '1', shop_name: 'One', api_key: 'key-one' },
        { shop_id: '2', shop_name: 'Two', api_key: 'key-two' },
      ],
    }],
  };
  const multiKeyRisk = analyzeSuspensionRisks(multiKeyConfig)
    .find((risk) => risk.code === 'MULTIPLE_API_KEYS_ONE_APPLICATION');
  assert.equal(multiKeyRisk?.level, 'high');
  const approvedRisk = analyzeSuspensionRisks({ ...multiKeyConfig, etsy_multi_key_approved: true })
    .find((risk) => risk.code === 'MULTIPLE_API_KEYS_APPROVAL_RECORDED');
  assert.equal(approvedRisk?.level, 'info');
  const overflowRisks = analyzeSuspensionRisks({
    groups: [{
      group_id: 'overflow',
      label: 'Overflow',
      proxy: 'direct',
      shops: Array.from({ length: 6 }, (_, i) => ({
        shop_id: String(i + 1),
        shop_name: `Shop ${i + 1}`,
        api_key: 'one-key',
      })),
    }],
  });
  assert.throws(
    () => enforceConfigCompliance({ allow_overloaded_api_keys: true }, overflowRisks),
    /no runtime override/i,
    'a local flag must never bypass Etsy shop/key allocation'
  );

  fs.writeFileSync(
    configPath,
    JSON.stringify({ ...baseConfig, catalog_health_sync: true }),
    'utf8'
  );
  assert.throws(
    () => loadConfig(),
    /written authorization/i,
    'API analytics must fail closed without Etsy written approval'
  );

  fs.writeFileSync(
    configPath,
    JSON.stringify({
      ...baseConfig,
      auto_restock_enabled: true,
      etsy_multi_key_approved: true,
      catalog_health_sync: true,
      etsy_api_analytics_approved: true,
      route_engine_data_dir: 'route-data',
    }),
    'utf8'
  );
  const explicit = loadConfig();
  assert.equal(explicit.auto_restock_enabled, true);
  assert.equal(explicit.etsy_multi_key_approved, true);
  assert.equal(explicit.catalog_health_sync, true);
  assert.equal(explicit.etsy_api_analytics_approved, true);
  assert.equal(isAutoRestockEnabled(explicit), true);
  assert.equal(explicit.route_engine_data_dir, path.join(tempRoot, 'route-data'));
  const enginePaths = require('../src/route/engine-paths');
  assert.equal(enginePaths.engineDataDir(explicit), path.join(tempRoot, 'route-data'));

  fs.writeFileSync(configPath, JSON.stringify(baseConfig), 'utf8');
  const live = loadConfig();
  assert.equal(isAutoRestockEnabled(live), false);

  const enabled = patchRuntimeSettings({ auto_restock_enabled: true });
  assert.equal(enabled.auto_restock_enabled, true);
  assert.equal(isAutoRestockEnabled(enabled), true);
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).auto_restock_enabled, true);

  refreshConfigInPlace(live);
  assert.equal(live.auto_restock_enabled, true);

  const qtyPatched = patchRuntimeSettings({ restock_quantity: 5 });
  assert.equal(qtyPatched.restock_quantity, 5);
  assert.equal(qtyPatched.auto_restock_enabled, true);

  assert.throws(() => patchRuntimeSettings({ api_key: 'stolen' }), /Cannot patch/);
  assert.throws(() => patchRuntimeSettings({ auto_restock_enabled: 'yes' }), /Invalid value/);
  assert.throws(() => patchRuntimeSettings({ restock_quantity: 0 }), /Invalid value/);
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).auto_restock_enabled, true);

  const placeholderConfig = JSON.parse(JSON.stringify(baseConfig));
  placeholderConfig.groups[0].shops[0].api_key = 'YOUR_KEYSTRING';
  fs.writeFileSync(configPath, JSON.stringify(placeholderConfig), 'utf8');
  assert.throws(() => loadConfig(), /placeholder value/);

  console.log('PASS — database location and Etsy inventory writes use safe opt-in defaults');
} finally {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
}
