#!/usr/bin/env node
'use strict';

/**
 * Move mutable route-engine data (SQLite, supplier workbook, charm images) out
 * of a cloud-synced source tree. Run only while dashboard/worker processes are
 * stopped. The source is renamed as a timestamped safety copy, never deleted.
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { loadConfig } = require('../src/config/schema');
const enginePaths = require('../src/route/engine-paths');

const configPath = process.env.DASHBOARD_CONFIG_PATH
  ? path.resolve(process.env.DASHBOARD_CONFIG_PATH)
  : path.resolve('config.json');
const config = loadConfig();
const sourceDir = enginePaths.engineDataDir(config);

if (!sourceDir || !fs.existsSync(sourceDir)) {
  console.error(`Route-engine data directory was not found: ${sourceDir || '(not configured)'}`);
  process.exit(1);
}

const synced = /onedrive|dropbox|google ?drive|gdrive/i.test(sourceDir);
if (!synced && config.route_engine_data_dir) {
  console.log(`Route-engine data is already explicitly located outside a known sync folder:\n  ${sourceDir}`);
  process.exit(0);
}

const appDataRoot = process.platform === 'win32'
  ? (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'))
  : process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support')
    : (process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'));
const targetDir = path.resolve(
  process.env.ROUTE_ENGINE_DATA_DIR
    || path.join(appDataRoot, 'EtsyDashboard', 'route-engine-data')
);

if (path.resolve(sourceDir) === targetDir) {
  console.log(`Route-engine data already uses the requested destination:\n  ${targetDir}`);
  process.exit(0);
}
if (fs.existsSync(targetDir)) {
  console.error(`Destination already exists; refusing to merge or overwrite:\n  ${targetDir}`);
  process.exit(1);
}

console.log(`Relocating route-engine data:\n  from: ${sourceDir}\n  to  : ${targetDir}\n`);
fs.mkdirSync(path.dirname(targetDir), { recursive: true });
try {
  fs.cpSync(sourceDir, targetDir, { recursive: true, errorOnExist: true });
} catch (err) {
  try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch {}
  console.error(`Copy failed; source is untouched: ${err.message}`);
  process.exit(1);
}

const copiedDb = path.join(targetDir, 'etsy_orders.db');
if (fs.existsSync(copiedDb)) {
  try {
    const check = new Database(copiedDb, { readonly: true });
    const result = check.pragma('integrity_check');
    check.close();
    const ok = Array.isArray(result)
      && result[0]
      && (result[0].integrity_check === 'ok' || result[0] === 'ok');
    if (!ok) throw new Error(`integrity_check returned ${JSON.stringify(result)}`);
  } catch (err) {
    try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch {}
    console.error(`Copied route database failed integrity verification; source is untouched: ${err.message}`);
    process.exit(1);
  }
}

const rawConfig = fs.readFileSync(configPath, 'utf8');
const encodedTarget = JSON.stringify(targetDir);
let updatedConfig;
if (/"route_engine_data_dir"\s*:/.test(rawConfig)) {
  updatedConfig = rawConfig.replace(
    /("route_engine_data_dir"\s*:\s*)(?:"[^"]*"|null)/,
    `$1${encodedTarget}`
  );
} else {
  updatedConfig = rawConfig.replace(
    /("route_engine_dir"\s*:\s*(?:"[^"]*"|null)\s*,?)/,
    `$1\n  "route_engine_data_dir": ${encodedTarget},`
  );
}
if (updatedConfig === rawConfig) {
  console.error(
    `Data copied and verified, but config.json could not be updated automatically.\n` +
    `Set "route_engine_data_dir" to ${encodedTarget}; source remains untouched.`
  );
  process.exit(1);
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const configBackup = `${configPath}.bak-${stamp}`;
try {
  fs.copyFileSync(configPath, configBackup);
} catch (err) {
  console.error(`Could not back up config.json; refusing to repoint it: ${err.message}`);
  process.exit(1);
}
fs.writeFileSync(configPath, updatedConfig, 'utf8');

const backupDir = `${sourceDir}.moved-${stamp}`;
try {
  fs.renameSync(sourceDir, backupDir);
  console.log(`Original data was retained at:\n  ${backupDir}`);
} catch (err) {
  console.warn(`Config now points to the verified copy, but the old directory could not be renamed: ${err.message}`);
}

console.log(`\nRoute-engine data relocation complete:\n  ${targetDir}`);
console.log(`Configuration backup:\n  ${configBackup}`);
console.log('Start the dashboard and verify the Route tab before removing the timestamped safety copy.');
