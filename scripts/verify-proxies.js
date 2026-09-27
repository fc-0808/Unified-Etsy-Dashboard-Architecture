'use strict';

/**
 * Verify that every configured group route is working correctly.
 *
 * For each group, this script:
 *   1. Establishes the configured system-tunnel or local-SOCKS transport
 *   2. Requires the group's IPFoxy SOCKS5 proxy
 *   3. Fetches the public exit IP from api.ipify.org
 *   4. Confirms proxied groups differ from the system-route IP and one another
 *   5. Enforces expected_egress_ip pins when configured
 *
 * Run: npm run proxy:verify
 */

const net = require('net');
const axios = require('axios');
const { loadConfig, usesGroupProxy } = require('../src/config/schema');
const { describeGroupRoute, verifyGroupProxy } = require('../src/proxy/factory');
const { describeNetworkTransport, TRANSPORT_MODES } = require('../src/proxy/transport');

async function getSystemRouteIp() {
  try {
    const { data } = await axios.get('https://api.ipify.org?format=json', {
      proxy: false,
      timeout: 8000,
    });
    const ip = String(data?.ip || '').trim();
    return net.isIP(ip) ? ip : null;
  } catch {
    return null;
  }
}

async function checkGroup(group, networkTransport, systemRouteIp) {
  const direct = !usesGroupProxy(group);
  const start = Date.now();
  try {
    const exitIp = await verifyGroupProxy(group, networkTransport);
    const elapsed = Date.now() - start;
    const validIp = net.isIP(exitIp) !== 0;
    const expected = group.expected_egress_ip == null || group.expected_egress_ip === ''
      ? []
      : (Array.isArray(group.expected_egress_ip)
          ? group.expected_egress_ip
          : [group.expected_egress_ip]).map((ip) => String(ip).trim());
    const expectedOk = expected.length === 0 || expected.includes(exitIp);
    const proxyChangedEgress = direct || !systemRouteIp || exitIp !== systemRouteIp;
    const ok = validIp && expectedOk && proxyChangedEgress;
    let error = null;
    if (!validIp) error = 'invalid IP response';
    else if (!expectedOk) error = `expected ${expected.join(' or ')}`;
    else if (!proxyChangedEgress) error = 'same as system route';
    return {
      group_id: group.group_id,
      label: group.label,
      exitIp,
      ok,
      elapsed,
      error,
      direct,
      route: describeGroupRoute(group, networkTransport),
    };
  } catch (err) {
    const elapsed = Date.now() - start;
    return {
      group_id: group.group_id,
      label: group.label,
      exitIp: null,
      ok: false,
      elapsed,
      error: err.message,
      direct,
      route: (() => {
        try { return describeGroupRoute(group, networkTransport); }
        catch { return direct ? 'direct' : 'invalid route'; }
      })(),
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
  console.log(`\n  Transport: ${describeNetworkTransport(config.network_transport)}`);
  console.log('  Detecting the public IP of the current Windows system route...');

  const systemRouteIp = await getSystemRouteIp();
  console.log(`  System-route IP: ${systemRouteIp || '(unable to detect)'}`);
  console.log(`\n  Testing ${config.groups.length} configured group route(s)...\n`);

  const results = await Promise.all(
    config.groups.map((g) => checkGroup(g, config.network_transport, systemRouteIp))
  );

  // Distinct group proxies are expected to have distinct static exits. Detect a
  // subscription/assignment mistake before any Etsy request is made.
  const groupsByExit = new Map();
  for (const result of results.filter((r) => !r.direct && r.ok)) {
    if (!groupsByExit.has(result.exitIp)) groupsByExit.set(result.exitIp, []);
    groupsByExit.get(result.exitIp).push(result);
  }
  for (const [ip, sameExit] of groupsByExit) {
    if (sameExit.length < 2) continue;
    const groupIds = sameExit.map((r) => r.group_id).join(', ');
    for (const result of sameExit) {
      result.ok = false;
      result.error = `shared exit ${ip} (${groupIds})`;
    }
  }

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
    const status = r.direct
      ? (r.ok ? '✓  DIRECT' : '✗  ERROR')
      : r.ok
        ? '✓  VERIFIED'
        : r.error
          ? '✗  ERROR'
          : '✗  SAME IP';
    const ip = r.exitIp || r.error?.slice(0, 30) || '—';
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
    console.log('  All configured routes verified.');
    console.log('  Every proxied group used IPFoxy and returned a distinct public exit.\n');
    const unpinned = config.groups.filter((group) =>
      usesGroupProxy(group)
      && (group.expected_egress_ip == null || group.expected_egress_ip === '')
    );
    if (unpinned.length) {
      console.log(
        `  Recommendation: ${unpinned.length} proxied group(s) have no expected_egress_ip pin.\n` +
        '  Confirm each static address in the IPFoxy portal, then add it to config.json\n' +
        '  so a provider-side address change fails closed.\n'
      );
    }
  } else {
    console.log('  One or more groups failed. Check:');
    if (config.network_transport.mode === TRANSPORT_MODES.SYSTEM_TUNNEL) {
      console.log(
        `  1. Is ${config.network_transport.provider} connected in Virtual Network Card / TUN mode?`
      );
    } else {
      console.log(
        `  1. Is ${config.network_transport.provider} listening on ` +
        `${config.network_transport.local_host}:${config.network_transport.local_port}?`
      );
    }
    console.log('  2. Are the existing IPFoxy proxy URLs and subscriptions active?');
    console.log('  3. Do expected_egress_ip pins match the IPFoxy portal?');
    console.log('  4. Do different groups accidentally resolve to the same static exit?\n');
    process.exit(1);
  }
}

main();
