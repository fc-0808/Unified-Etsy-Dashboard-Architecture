'use strict';

/**
 * Backward-compatible single-route diagnostic.
 *
 * `npm run proxy:verify` is the comprehensive command. This older command keeps
 * testing the first proxied group, but now delegates to the production transport
 * implementation so it cannot drift from the configured VPN behavior.
 */
const { loadConfig, usesGroupProxy } = require('./src/config/schema');
const {
  describeGroupRoute,
  verifyGroupProxy,
} = require('./src/proxy/factory');

async function main() {
  const config = loadConfig();
  const group = config.groups.find(usesGroupProxy);
  if (!group) {
    console.log('No proxied group is configured. Run npm run proxy:verify for direct-route checks.');
    return;
  }

  console.log('='.repeat(68));
  console.log(' Group Proxy Transport Test');
  console.log('='.repeat(68));
  console.log(`\n  Group: ${group.group_id}`);
  console.log(`  Route: ${describeGroupRoute(group, config.network_transport)}`);

  try {
    const exitIp = await verifyGroupProxy(group, config.network_transport);
    console.log(`  Exit:  ${exitIp}`);
    console.log('\n  SUCCESS: the configured group proxy route is available.');
  } catch (err) {
    console.error(`\n  FAILED: ${err.message}`);
    console.error('  Run npm run proxy:verify for full diagnostics.');
    process.exitCode = 1;
  }
  console.log('\n' + '='.repeat(68));
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
