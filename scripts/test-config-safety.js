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
  const defaults = loadConfig();
  assert.equal(defaults.network_transport.mode, 'local_socks5');
  assert.equal(defaults.network_transport.local_host, '127.0.0.1');
  assert.equal(defaults.network_transport.local_port, 7897);
  assert.equal(defaults.vpn_local_port, 7897);
  assert.equal(defaults.browser_expected_static_proxy_count, null);
  assert.equal(defaults.auto_restock_enabled, false);
  assert.equal(defaults.catalog_health_sync, false);
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

  fs.writeFileSync(
    configPath,
    JSON.stringify({
      ...baseConfig,
      network_transport: {
        mode: 'system_tunnel',
        provider: 'System VPN',
        interface_name: 'VPN',
      },
      browser_expected_static_proxy_count: 3,
    }),
    'utf8'
  );
  const systemTunnel = loadConfig();
  assert.deepEqual(systemTunnel.network_transport, {
    mode: 'system_tunnel',
    provider: 'System VPN',
    interface_name: 'VPN',
    local_host: null,
    local_port: null,
  });
  assert.equal(systemTunnel.vpn_local_port, null);
  assert.equal(systemTunnel.browser_expected_static_proxy_count, 3);
  assert.deepEqual(systemTunnel.browser_profiles, []);

  fs.writeFileSync(
    configPath,
    JSON.stringify({
      ...baseConfig,
      browser_expected_static_proxy_count: 2,
      browser_profiles: [
        {
          profile_id: 'profile-1',
          expected_egress_ip: '203.0.113.10',
          label: 'Profile 1',
        },
        {
          profile_id: 'profile-2',
          expected_egress_ip: '203.0.113.11',
        },
      ],
    }),
    'utf8'
  );
  const browserInventory = loadConfig();
  assert.equal(browserInventory.browser_profiles.length, 2);
  assert.equal(browserInventory.browser_profiles[1].label, null);

  fs.writeFileSync(
    configPath,
    JSON.stringify({
      ...baseConfig,
      browser_expected_static_proxy_count: 2,
      browser_profiles: [{
        profile_id: 'profile-1',
        expected_egress_ip: '203.0.113.10',
      }],
    }),
    'utf8'
  );
  assert.throws(() => loadConfig(), /length does not match/);

  fs.writeFileSync(
    configPath,
    JSON.stringify({
      ...baseConfig,
      browser_expected_static_proxy_count: 0,
    }),
    'utf8'
  );
  assert.throws(() => loadConfig(), /browser_expected_static_proxy_count/);

  fs.writeFileSync(
    configPath,
    JSON.stringify({
      ...baseConfig,
      vpn_local_port: 7897,
      network_transport: { mode: 'system_tunnel', provider: 'System VPN' },
    }),
    'utf8'
  );
  assert.throws(() => loadConfig(), /not both/);

  fs.writeFileSync(
    configPath,
    JSON.stringify({
      ...baseConfig,
      network_transport: {
        mode: 'system_tunnel',
        provider: 'System VPN',
        local_port: 65532,
      },
    }),
    'utf8'
  );
  assert.throws(
    () => loadConfig(),
    /does not use local_host\/local_port/,
    'a VPN UI local port must not be mistaken for a SOCKS5 listener'
  );

  fs.writeFileSync(
    configPath,
    JSON.stringify({
      ...baseConfig,
      groups: [
        baseConfig.groups[0],
        { ...baseConfig.groups[0], label: 'Duplicate' },
      ],
    }),
    'utf8'
  );
  assert.throws(() => loadConfig(), /duplicate group_id/);

  fs.writeFileSync(
    configPath,
    JSON.stringify({
      ...baseConfig,
      groups: [{
        ...baseConfig.groups[0],
        proxy: 'socks5://private-user:private-password@proxy.test',
      }],
    }),
    'utf8'
  );
  assert.throws(
    () => loadConfig(),
    (err) => /proxy port is missing/.test(err.message)
      && !/private-user|private-password/.test(err.message),
    'proxy validation errors must not print credentials'
  );

  fs.writeFileSync(
    configPath,
    JSON.stringify({
      ...baseConfig,
      groups: [{
        ...baseConfig.groups[0],
        proxy: 'socks5://private-user:private-password@proxy.test:1080',
      }],
    }),
    'utf8'
  );
  assert.throws(
    () => loadConfig(),
    /expected_egress_ip is required/,
    'a proxied group must never start without a static exit pin'
  );

  fs.writeFileSync(
    configPath,
    JSON.stringify({
      ...baseConfig,
      groups: [{
        ...baseConfig.groups[0],
        expected_egress_ip: 'not-an-ip',
      }],
    }),
    'utf8'
  );
  assert.throws(() => loadConfig(), /expected_egress_ip/);

  fs.writeFileSync(
    configPath,
    JSON.stringify({ ...baseConfig, catalog_health_sync: true }),
    'utf8'
  );
  const catalogOn = loadConfig();
  assert.equal(catalogOn.catalog_health_sync, true);

  fs.writeFileSync(
    configPath,
    JSON.stringify({
      ...baseConfig,
      auto_restock_enabled: true,
      catalog_health_sync: true,
      route_engine_data_dir: 'route-data',
    }),
    'utf8'
  );
  const explicit = loadConfig();
  assert.equal(explicit.auto_restock_enabled, true);
  assert.equal(explicit.catalog_health_sync, true);
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

  console.log('PASS — transport, database, and Etsy writes use fail-closed defaults');
} finally {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
}
