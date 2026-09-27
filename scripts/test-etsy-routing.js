'use strict';

/**
 * Static architecture guard for Etsy network routing.
 *
 * Unit tests prove the SOCKS agent itself. This test proves future features
 * cannot quietly add a second, direct Etsy client elsewhere in src/.
 */

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const srcRoot = path.join(root, 'src');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

function javascriptFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...javascriptFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(absolute);
  }
  return files;
}

const allowedApiHosts = new Set([
  path.normalize('src/proxy/factory.js'),
  path.normalize('src/auth/token-manager.js'),
]);
const violations = [];
for (const absolute of javascriptFiles(srcRoot)) {
  const relative = path.normalize(path.relative(root, absolute));
  const source = fs.readFileSync(absolute, 'utf8');
  if (
    /https:\/\/(?:openapi|api)\.etsy\.com/i.test(source)
    && !allowedApiHosts.has(relative)
  ) {
    violations.push(relative);
  }
}
assert.deepEqual(
  violations,
  [],
  `Direct Etsy API host literal outside approved transport modules: ${violations.join(', ')}`
);

const factory = read('src/proxy/factory.js');
assert.match(factory, /proxies:\s*this\.proxies/);
assert.match(factory, /proxy:\s*false/);
assert.match(factory, /PROXY_ROUTE_OVERRIDE_BLOCKED/);
assert.match(factory, /_ensureEgressVerified/);
assert.match(factory, /expected_egress_ip/);

const client = read('src/etsy/client.js');
assert.match(client, /groupProxyClient\._proxyEnforced !== true/);
assert.match(client, /!groupProxyClient\._egressVerifiedAt/);
assert.match(client, /await groupProxyClient\._ensureEgressVerified\(\)/);
assert.match(client, /cfg\?\.httpsAgent !== requiredAgent/);

const tokens = read('src/auth/token-manager.js');
assert.match(tokens, /await proxyClient\._ensureEgressVerified\(\)/);
assert.match(tokens, /proxy:\s*false/);

const server = read('src/server/index.js');
assert.match(server, /getVerifiedGroupClient/);
assert.doesNotMatch(server, /\bcreateGroup(?:Proxy)?Client\s*\(/);

const worker = read('src/workers/sync.js');
assert.match(worker, /await verifyGroupProxy\(group,\s*config\.network_transport\)/);
assert.match(worker, /getVerifiedGroupClient/);

for (const relative of [
  'src/listings/bulk-runner.js',
  'src/listings/etsy-create.js',
  'src/listings/shop-settings.js',
  'src/listings/repricer.js',
]) {
  const source = read(relative);
  assert.doesNotMatch(source, /https:\/\/(?:openapi|api)\.etsy\.com/i);
}

const example = JSON.parse(read('config.example.json'));
assert.deepEqual(example.network_transport, {
  mode: 'local_socks5',
  provider: 'Efan VPN',
  local_host: '127.0.0.1',
  local_port: 7897,
});

console.log('PASS — every Etsy API entry point remains behind the verified proxy architecture');
