'use strict';

const assert = require('node:assert/strict');
const {
  isLocalDashboardRequest,
  isPrivateAddress,
  resolveListenHost,
} = require('../src/server/network-policy');

assert.equal(resolveListenHost({
  authEnabled: false,
  allowUnauthenticatedNetwork: false,
  requestedHost: '0.0.0.0',
}), '127.0.0.1');
assert.equal(resolveListenHost({
  authEnabled: true,
  requestedHost: '192.168.1.10',
}), '192.168.1.10');
assert.equal(resolveListenHost({ authEnabled: true }), '0.0.0.0');

assert.equal(isPrivateAddress('::ffff:192.168.1.5'), true);
assert.equal(isPrivateAddress('8.8.8.8'), false);

const req = (remoteAddress, headers = {}) => ({
  socket: { remoteAddress },
  headers,
});
assert.equal(
  isLocalDashboardRequest(req('192.168.1.20', { host: 'dashboard.local:4000' })),
  true,
  'direct private peer with custom hostname should be local'
);
assert.equal(
  isLocalDashboardRequest(req('127.0.0.1', {
    'x-forwarded-for': '192.168.1.20, 127.0.0.1',
    'x-forwarded-proto': 'http',
  })),
  true,
  'office reverse-proxy chain should be local'
);
assert.equal(
  isLocalDashboardRequest(req('127.0.0.1', {
    'x-forwarded-for': '203.0.113.9, 127.0.0.1',
    'x-forwarded-proto': 'https',
  })),
  false,
  'public tunnel client should be remote'
);
assert.equal(
  isLocalDashboardRequest(req('127.0.0.1', {
    'x-forwarded-for': '192.168.1.20, 203.0.113.9',
  })),
  false,
  'spoofed private prefix must not hide a public hop'
);
assert.equal(
  isLocalDashboardRequest(req('127.0.0.1', { 'x-forwarded-proto': 'https' })),
  false,
  'forwarded request without client chain is not proven local'
);

console.log('PASS — bind and LAN/tunnel classification fail closed');
