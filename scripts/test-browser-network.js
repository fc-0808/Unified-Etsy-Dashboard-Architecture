'use strict';

/** Offline tests for the read-only AdsPower browser-network audit. */
const assert = require('node:assert/strict');
const {
  normalizeAdsPowerApiUrl,
  collectProfileAssignments,
  sanitizeAdsPowerProfile,
  queryAdsPowerProfiles,
  findAdsPowerLanExposures,
  hasWindowsAdsPowerFirewallBlock,
  auditAdsPowerProfiles,
  auditDeclaredBrowserProfiles,
} = require('../src/proxy/browser-audit');

const baseConfig = {
  browser_expected_static_proxy_count: 1,
  groups: [{
    group_id: 'group-one',
    label: 'Group One',
    proxy: 'socks5://proxy-user:proxy-secret@proxy.example:45001',
    expected_egress_ip: '203.0.113.10',
    adspower_profile_id: 'profile-one',
    shops: [
      { shop_id: 'shop-a' },
      { shop_id: 'shop-b' },
    ],
  }],
};

(async () => {
  assert.equal(
    normalizeAdsPowerApiUrl('http://localhost:50325/'),
    'http://localhost:50325'
  );
  assert.equal(
    normalizeAdsPowerApiUrl('http://[::1]:50325'),
    'http://[::1]:50325'
  );
  assert.throws(
    () => normalizeAdsPowerApiUrl('https://example.com:50325'),
    /loopback only/
  );
  assert.throws(
    () => normalizeAdsPowerApiUrl('http://127.0.0.1:50325/unsafe'),
    /must not contain a path/
  );

  const collected = collectProfileAssignments(baseConfig);
  assert.equal(collected.missing.length, 0);
  assert.equal(collected.assignments.length, 1);
  assert.equal(collected.assignments[0].shop_ids.size, 2);
  assert.deepEqual([...collected.assignments[0].expected_ips], ['203.0.113.10']);
  assert.deepEqual(
    [...collected.assignments[0].expected_endpoints],
    ['proxy.example:45001']
  );

  const rawProfile = {
    profile_id: 'profile-one',
    profile_no: '101',
    username: 'seller@example.test',
    password: 'platform-secret',
    cookie: 'session-secret',
    ip: '203.0.113.10',
    ip_country: 'ca',
    fbcc_proxy_acc_id: 'saved-proxy-1',
    user_proxy_config: {
      proxy_soft: 'other',
      proxy_type: 'socks5',
      proxy_host: 'proxy.example',
      proxy_port: '45001',
      proxy_user: 'proxy-user',
      proxy_password: 'proxy-secret',
    },
  };
  const sanitized = sanitizeAdsPowerProfile(rawProfile);
  const serialized = JSON.stringify(sanitized);
  assert.doesNotMatch(serialized, /seller@example|platform-secret|session-secret|proxy-user|proxy-secret/);
  assert.equal(sanitized.last_known_ip, '203.0.113.10');

  const matching = auditAdsPowerProfiles(baseConfig, [sanitized]);
  assert.equal(matching.ok, true);
  assert.equal(matching.results[0].ok, true);

  const noProxy = auditAdsPowerProfiles(baseConfig, [{
    ...sanitized,
    proxy_soft: 'no_proxy',
    proxy_host: '',
    proxy_port: '',
    last_known_ip: null,
  }]);
  assert.equal(noProxy.ok, false);
  assert.match(noProxy.results[0].errors.join(' '), /without a proxy/);

  const rotating = auditAdsPowerProfiles(baseConfig, [{
    ...sanitized,
    proxy_soft: 'ipfoxyauto',
  }]);
  assert.equal(rotating.ok, false);
  assert.match(rotating.results[0].errors.join(' '), /rotating/);

  const wrongExit = auditAdsPowerProfiles(baseConfig, [{
    ...sanitized,
    last_known_ip: '203.0.113.99',
  }]);
  assert.equal(wrongExit.ok, false);
  assert.match(wrongExit.results[0].errors.join(' '), /does not match/);

  let requestSeen;
  let routeSeen;
  const queried = await queryAdsPowerProfiles({
    apiKey: 'local-api-secret',
    baseUrl: 'http://127.0.0.1:50325',
    profileIds: ['profile-one'],
    routeExpectations: new Map([['profile-one', '203.0.113.10']]),
    networkTransport: { mode: 'system_tunnel', provider: 'Test tunnel' },
    verifyRoute: async (group, transport) => {
      routeSeen = { group, transport };
      return '203.0.113.10';
    },
    request: async (url, body, options) => {
      requestSeen = { url, body, options };
      return {
        status: 200,
        data: { code: 0, data: { list: [rawProfile] }, msg: 'Success' },
      };
    },
  });
  assert.equal(requestSeen.url, 'http://127.0.0.1:50325/api/v2/browser-profile/list');
  assert.equal(requestSeen.options.headers.Authorization, 'Bearer local-api-secret');
  assert.deepEqual(requestSeen.body.profile_id, ['profile-one']);
  assert.equal(routeSeen.group.expected_egress_ip, '203.0.113.10');
  assert.match(routeSeen.group.proxy, /^socks5:\/\//);
  assert.equal(queried[0].route_check.ok, true);
  assert.equal(queried[0].route_check.observed_ip, '203.0.113.10');
  assert.doesNotMatch(JSON.stringify(queried), /local-api-secret|platform-secret|proxy-secret/);

  const declared = auditDeclaredBrowserProfiles([{
    profile_id: 'profile-one',
    expected_egress_ip: '203.0.113.10',
    label: 'Profile 1',
  }], queried);
  assert.equal(declared.ok, true);
  assert.equal(declared.results[0].observed_ip, '203.0.113.10');

  const exposureRequests = [];
  const exposures = await findAdsPowerLanExposures({
    apiKey: 'local-api-secret',
    networkInterfaces: {
      Loopback: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
      WiFi: [{ family: 'IPv4', internal: false, address: '192.168.1.20' }],
    },
    request: async (url, options) => {
      exposureRequests.push({ url, options });
      return { status: 200, data: { code: 0 } };
    },
  });
  assert.deepEqual(exposures, ['192.168.1.20']);
  assert.equal(exposureRequests.length, 1);
  assert.equal(exposureRequests[0].options.headers.Authorization, 'Bearer local-api-secret');
  assert.equal(
    hasWindowsAdsPowerFirewallBlock({
      platform: 'win32',
      run: () => 'SECURE\r\n',
    }),
    true
  );
  assert.equal(
    hasWindowsAdsPowerFirewallBlock({
      platform: 'win32',
      run: () => 'MISSING\r\n',
    }),
    false
  );
  assert.equal(
    hasWindowsAdsPowerFirewallBlock({ platform: 'linux' }),
    null
  );

  await assert.rejects(
    queryAdsPowerProfiles({
      apiKey: '',
      profileIds: ['profile-one'],
      request: async () => { throw new Error('must not run'); },
    }),
    (err) => err?.code === 'ADSPOWER_API_KEY_MISSING'
  );
  await assert.rejects(
    queryAdsPowerProfiles({
      apiKey: 'secret',
      baseUrl: 'http://remote.example:50325',
      profileIds: ['profile-one'],
      request: async () => { throw new Error('must not run'); },
    }),
    /loopback only/
  );

  console.log('PASS — browser network audit is read-only, loopback-only, and credential-safe');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
