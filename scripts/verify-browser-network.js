'use strict';

/**
 * Manual Etsy browser network readiness audit.
 *
 * This command never opens or controls a browser and never contacts Etsy. It
 * verifies the configured VPN-to-IPFoxy routes used by the dashboard, then performs
 * one read-only AdsPower profile-list query to confirm configured profiles are
 * not accidentally set to no-proxy, rotating, or an unexpected static exit.
 */

require('dotenv').config({ quiet: true });

const { loadConfig, usesGroupProxy } = require('../src/config/schema');
const { verifyGroupProxy } = require('../src/proxy/factory');
const { describeNetworkTransport } = require('../src/proxy/transport');
const {
  collectProfileAssignments,
  queryAdsPowerProfiles,
  auditAdsPowerProfiles,
  auditDeclaredBrowserProfiles,
  findAdsPowerLanExposures,
  hasWindowsAdsPowerFirewallBlock,
} = require('../src/proxy/browser-audit');

function status(ok) {
  return ok ? 'PASS' : 'FAIL';
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`Configuration error: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  console.log('\nManual browser network readiness (no Etsy requests)');
  console.log('='.repeat(62));
  console.log(`Transport: ${describeNetworkTransport(config.network_transport)}`);

  let ok = true;
  const proxiedGroups = config.groups.filter(usesGroupProxy);
  console.log(`\nGroup proxy routes (${proxiedGroups.length})`);
  for (const group of proxiedGroups) {
    try {
      const ip = await verifyGroupProxy(group, config.network_transport);
      console.log(`  PASS  ${group.group_id} → ${ip}`);
    } catch (err) {
      ok = false;
      console.log(`  FAIL  ${group.group_id} → ${err.message}`);
    }
  }

  const collected = collectProfileAssignments(config);
  const mappedIds = new Set(collected.assignments.map((entry) => entry.profile_id));
  const declared = config.browser_profiles.length
    ? config.browser_profiles
    : collected.assignments
        .filter((entry) => entry.expected_ips.size === 1)
        .map((entry) => ({
          profile_id: entry.profile_id,
          expected_egress_ip: [...entry.expected_ips][0],
          label: null,
        }));
  const profileIds = [...new Set([
    ...mappedIds,
    ...declared.map((entry) => entry.profile_id),
  ])];
  const expectedCount = config.browser_expected_static_proxy_count;
  console.log(`\nDeclared static AdsPower profiles (${declared.length})`);
  if (expectedCount != null && declared.length !== expectedCount) {
    ok = false;
    console.log(
      `  FAIL  config expects ${expectedCount} static browser profiles, ` +
      `but ${declared.length} are declared.`
    );
  }
  if (collected.missing.length) {
    ok = false;
    console.log(`  FAIL  ${collected.missing.length} shop(s) have no AdsPower profile mapping.`);
  }

  if (profileIds.length) {
    try {
      const profiles = await queryAdsPowerProfiles({
        apiKey: process.env.ADSPOWER_API_KEY,
        baseUrl: process.env.ADSPOWER_LOCAL_API_URL,
        profileIds,
        routeExpectations: new Map(
          declared.map((entry) => [entry.profile_id, entry.expected_egress_ip])
        ),
        networkTransport: config.network_transport,
      });
      const declaredAudit = auditDeclaredBrowserProfiles(declared, profiles);
      const mappingAudit = auditAdsPowerProfiles(config, profiles);
      ok = ok && declaredAudit.ok && mappingAudit.ok;

      for (const result of declaredAudit.results) {
        const mapping = mappedIds.has(result.profile_id)
          ? 'dashboard-mapped'
          : 'manual inventory only';
        console.log(
          `  ${status(result.ok).padEnd(4)}  ${result.label || `profile ${result.profile_id}`} ` +
          `→ ${result.observed_ip || result.expected_egress_ip} (${mapping})`
        );
        for (const error of result.errors) console.log(`        ERROR: ${error}`);
        for (const warning of result.warnings) console.log(`        NOTE: ${warning}`);
      }

      console.log('\nDashboard profile mapping consistency');
      for (const result of mappingAudit.results) {
        const groups = result.group_ids.join(', ');
        console.log(
          `  ${status(result.ok).padEnd(4)}  profile ${result.profile_id} ` +
          `(${result.shop_count} shop(s), ${groups})`
        );
        for (const error of result.errors) console.log(`        ERROR: ${error}`);
        for (const warning of result.warnings) console.log(`        NOTE: ${warning}`);
      }

      console.log('\nAdsPower Local API exposure');
      const localApiUrl = process.env.ADSPOWER_LOCAL_API_URL || 'http://127.0.0.1:50325';
      const localApiPort = Number(new URL(localApiUrl).port || 50325);
      const firewallProtected = hasWindowsAdsPowerFirewallBlock({
        port: localApiPort,
      });
      if (firewallProtected === true) {
        console.log(
          `  PASS  Windows Firewall blocks remote inbound TCP ${localApiPort}; loopback remains available.`
        );
      } else {
        const exposedAddresses = await findAdsPowerLanExposures({
          apiKey: process.env.ADSPOWER_API_KEY,
          baseUrl: localApiUrl,
        });
        if (exposedAddresses.length) {
          ok = false;
          console.log(
            `  FAIL  TCP ${localApiPort} is reachable through: ${exposedAddresses.join(', ')}`
          );
          console.log('        Run npm run browser:secure-api from an Administrator shell.');
        } else {
          console.log('  PASS  Local API is not reachable through non-loopback interfaces.');
        }
      }
    } catch (err) {
      ok = false;
      console.log(`  FAIL  ${err.message}`);
    }
  }

  console.log('\n' + '-'.repeat(62));
  if (ok) {
    console.log('PASS: configured network routes are ready for manual browser checks.');
    console.log('Next: use AdsPower “Check Proxy”, then open Etsy manually with 2FA enabled.');
  } else {
    console.log('FAIL: do not rely on these browser mappings until the items above are fixed.');
  }
  console.log(
    'This audit does not inspect fingerprints, automate Etsy, or guarantee platform enforcement outcomes.\n'
  );
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
