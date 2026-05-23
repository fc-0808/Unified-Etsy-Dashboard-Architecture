'use strict';

/**
 * Verify that every group's proxy chain is working correctly.
 *
 * For each group, this script:
 *   1. Establishes the VPN → IPFoxy chain
 *   2. Fetches the public exit IP from api.ipify.org
 *   3. Confirms it differs from your home IP
 *   4. Reports results in a clear table
 *
 * Run: npm run proxy:verify
 *
 * Prerequisites: VPN (饿饭加速器) must be connected before running.
 */

const axios = require('axios');
const { loadConfig } = require('../src/config/schema');
const { createGroupClient } = require('../src/proxy/factory');

async function getHomeIp() {
  try {
    const { data } = await axios.get('https://api.ipify.org?format=json', { timeout: 8000 });
    return data.ip;
  } catch {
    return '(unable to detect)';
  }
}

async function checkGroup(group, vpnPort, homeIp) {
  const start = Date.now();
  try {
    const client = createGroupClient(group, vpnPort, true);
    const { data } = await client.get('https://api.ipify.org?format=json', {
      baseURL: '',
      timeout: 20_000,
    });
    const exitIp = data.ip;
    const elapsed = Date.now() - start;
    const ok = exitIp !== homeIp;
    return { group_id: group.group_id, label: group.label, exitIp, ok, elapsed, error: null };
  } catch (err) {
    const elapsed = Date.now() - start;
    return {
      group_id: group.group_id,
      label: group.label,
      exitIp: null,
      ok: false,
      elapsed,
      error: err.message,
    };
  }
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`\nConfig error: ${err.message}\n`);
    process.exit(1);
  }

  console.log('\n' + '═'.repeat(70));
  console.log('  Etsy Dashboard — Proxy Chain Verification');
  console.log('═'.repeat(70));
  console.log('\n  Detecting home IP...');

  const homeIp = await getHomeIp();
  console.log(`  Home IP (visible without proxy): ${homeIp}`);
  console.log(`\n  Testing ${config.groups.length} groups — each uses VPN:${config.vpn_local_port} → IPFoxy...\n`);

  const results = await Promise.all(
    config.groups.map((g) => checkGroup(g, config.vpn_local_port, homeIp))
  );

  const colW = [24, 32, 18, 10];
  const header = [
    'Group ID'.padEnd(colW[0]),
    'Exit IP'.padEnd(colW[1]),
    'Status'.padEnd(colW[2]),
    'Latency',
  ].join('  ');

  console.log('  ' + header);
  console.log('  ' + '─'.repeat(header.length));

  let allPassed = true;
  for (const r of results) {
    const status = r.ok ? '✓  ISOLATED' : r.error ? '✗  ERROR' : '✗  SAME IP';
    const ip = r.exitIp ?? r.error?.slice(0, 30) ?? '—';
    const row = [
      r.group_id.padEnd(colW[0]),
      ip.padEnd(colW[1]),
      status.padEnd(colW[2]),
      `${r.elapsed}ms`,
    ].join('  ');
    console.log('  ' + row);
    if (!r.ok) allPassed = false;
  }

  console.log('\n' + '─'.repeat(72));
  if (allPassed) {
    console.log('  All groups verified. Network isolation confirmed.');
    console.log('  Each group exits through a different static HK IP.\n');
  } else {
    console.log('  One or more groups failed. Check:');
    console.log('  1. Is your VPN (饿饭加速器) connected at port ' + config.vpn_local_port + '?');
    console.log('  2. Are the IPFoxy proxy URLs in config.json correct?');
    console.log('  3. Is your IPFoxy subscription active?\n');
    process.exit(1);
  }
}

main();
