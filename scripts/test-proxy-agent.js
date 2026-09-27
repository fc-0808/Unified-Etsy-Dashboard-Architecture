'use strict';

/** Offline regressions for both supported VPN transport modes. */
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const tls = require('tls');
const { SocksClient } = require('socks');
const {
  GroupProxyAgent,
  createGroupClient,
  clearClientCache,
  fetchExitIpWithRetry,
  parseProxyUrl,
} = require('../src/proxy/factory');
const { buildShopClient } = require('../src/etsy/client');

const originalConnect = SocksClient.createConnection;
const originalChain = SocksClient.createConnectionChain;
const originalTlsConnect = tls.connect;

const GROUP_PROXY = 'socks5://user:pass@127.0.0.1:45001';
const SYSTEM_TUNNEL = {
  mode: 'system_tunnel',
  provider: 'System VPN',
  interface_name: 'VPN',
};
const LOCAL_SOCKS = {
  mode: 'local_socks5',
  provider: 'Efan VPN',
  local_host: '127.0.0.1',
  local_port: 7897,
};

async function scenario(events, transport = LOCAL_SOCKS) {
  const raw = new EventEmitter();
  raw.destroyCount = 0;
  raw.destroy = () => { raw.destroyCount += 1; };
  const secure = new EventEmitter();
  secure.destroy = () => {};
  const calls = [];

  SocksClient.createConnection = async (options) => {
    calls.push({ kind: 'single', options });
    return { socket: raw };
  };
  SocksClient.createConnectionChain = async (options) => {
    calls.push({ kind: 'chain', options });
    return { socket: raw };
  };
  tls.connect = () => {
    queueMicrotask(() => {
      for (const event of events) {
        if (event === 'secureConnect') secure.emit('secureConnect');
        else secure.emit('error', new Error('TLS failed'));
      }
    });
    return secure;
  };

  const agent = new GroupProxyAgent(transport, GROUP_PROXY);
  const callbacks = [];
  agent.createConnection(
    { host: 'example.test', port: 443 },
    (err, socket) => callbacks.push({ err, socket })
  );
  await new Promise((resolve) => setImmediate(resolve));
  agent.destroy();
  return { callbacks, raw, calls, agent };
}

(async () => {
  try {
    const successThenError = await scenario(['secureConnect', 'error']);
    assert.equal(successThenError.callbacks.length, 1);
    assert.equal(successThenError.callbacks[0].err, null);
    assert.equal(successThenError.raw.destroyCount, 0);
    assert.equal(successThenError.calls[0].kind, 'chain');
    assert.equal(successThenError.calls[0].options.proxies.length, 2);
    assert.equal(successThenError.calls[0].options.proxies[0].port, 7897);

    const errorThenSuccess = await scenario(['error', 'secureConnect']);
    assert.equal(errorThenSuccess.callbacks.length, 1);
    assert.match(errorThenSuccess.callbacks[0].err.message, /TLS failed/);
    assert.equal(errorThenSuccess.raw.destroyCount, 1);

    const systemTunnel = await scenario(['secureConnect'], SYSTEM_TUNNEL);
    assert.equal(systemTunnel.calls.length, 1);
    assert.equal(systemTunnel.calls[0].kind, 'single');
    assert.equal(systemTunnel.calls[0].options.proxy.port, 45001);
    assert.match(systemTunnel.agent.description, /System VPN system tunnel/);
    assert.doesNotMatch(systemTunnel.agent.description, /user|pass/);

    const parsed = parseProxyUrl('socks5://user%40name:p%3Ass@example.test:1080');
    assert.equal(parsed.userId, 'user@name');
    assert.equal(parsed.password, 'p:ss');
    assert.throws(() => parseProxyUrl('http://user:pass@example.test:8080'), /protocol/);
    assert.throws(() => parseProxyUrl('socks5://user:pass@example.test'), /port/);

    let attempts = 0;
    const retried = await fetchExitIpWithRetry({
      get: async () => {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error('route reset'), { code: 'ECONNRESET' });
        return { data: { ip: '203.0.113.10' } };
      },
    }, {
      sleep: async () => {},
      onRetry: () => {},
    });
    assert.equal(attempts, 3);
    assert.equal(retried.data.ip, '203.0.113.10');

    let definitiveAttempts = 0;
    await assert.rejects(
      fetchExitIpWithRetry({
        get: async () => {
          definitiveAttempts += 1;
          throw Object.assign(new Error('bad request'), { response: { status: 400 } });
        },
      }, {
        sleep: async () => {},
        onRetry: () => {},
      }),
      /bad request/
    );
    assert.equal(definitiveAttempts, 1);

    const proxied = createGroupClient({
      group_id: 'proxied',
      proxy: GROUP_PROXY,
      expected_egress_ip: '203.0.113.10',
    }, SYSTEM_TUNNEL, true);
    assert.equal(proxied._proxyEnforced, true);
    assert.equal(proxied._agent.proxies.length, 1);
    assert.equal(proxied.defaults.proxy, false);
    assert.doesNotMatch(proxied._routeKey, /user|pass/);
    assert.doesNotMatch(JSON.stringify(proxied._agent), /user|pass/);
    assert.equal(
      proxied._assertProxyRoute({
        httpsAgent: proxied._agent,
        proxy: false,
      }).httpsAgent,
      proxied._agent
    );
    assert.throws(
      () => proxied._assertProxyRoute({ httpsAgent: new (require('https').Agent)(), proxy: false }),
      (err) => err?.code === 'PROXY_ROUTE_OVERRIDE_BLOCKED'
    );
    assert.throws(
      () => createGroupClient({
        group_id: 'unpinned',
        proxy: GROUP_PROXY,
      }, SYSTEM_TUNNEL, true),
      (err) => err?.code === 'PROXY_EGRESS_PIN_REQUIRED'
    );

    const direct = createGroupClient({
      group_id: 'direct',
      proxy: 'direct',
    }, SYSTEM_TUNNEL, true);
    assert.equal(direct._proxyEnforced, false);
    assert.equal(direct.defaults.httpsAgent, undefined);
    assert.equal(direct.defaults.proxy, false);
    assert.throws(
      () => buildShopClient(direct, 'key', 'secret', '1.token', null, { requireProxy: true }),
      /Refusing to build/
    );
    assert.throws(
      () => buildShopClient(proxied, 'key', 'secret', '1.token', null, { requireProxy: true }),
      /preflight check/
    );
    proxied._egressVerifiedAt = Date.now();
    proxied._verifiedEgressIp = '203.0.113.10';
    const shopClient = buildShopClient(
      proxied,
      'key',
      'secret',
      '1.token',
      null,
      { requireProxy: true, shopId: 'ProbeShop' }
    );
    assert.equal(shopClient.defaults.proxy, false);
    assert.equal(shopClient._proxyEnforced, true);
    const guarded = await shopClient._assertProxyRoute({
      httpsAgent: proxied._agent,
      proxy: false,
    });
    assert.equal(guarded.httpsAgent, proxied._agent);
    await assert.rejects(
      shopClient._assertProxyRoute({ httpsAgent: proxied._agent, proxy: true }),
      (err) => err?.code === 'PROXY_ROUTE_OVERRIDE_BLOCKED'
    );

    console.log('PASS — system-tunnel and local-SOCKS routes fail closed offline');
  } finally {
    clearClientCache();
    SocksClient.createConnection = originalConnect;
    SocksClient.createConnectionChain = originalChain;
    tls.connect = originalTlsConnect;
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
