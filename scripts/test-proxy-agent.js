'use strict';

/** Offline regression tests for the two-hop TLS callback contract. */
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const tls = require('tls');
const { SocksClient } = require('socks');
const { TwoHopSocksAgent } = require('../src/proxy/factory');

const originalChain = SocksClient.createConnectionChain;
const originalTlsConnect = tls.connect;

async function scenario(events) {
  const raw = new EventEmitter();
  raw.destroyCount = 0;
  raw.destroy = () => { raw.destroyCount += 1; };
  const secure = new EventEmitter();
  secure.destroy = () => {};
  SocksClient.createConnectionChain = async () => ({ socket: raw });
  tls.connect = () => {
    queueMicrotask(() => {
      for (const event of events) {
        if (event === 'secureConnect') secure.emit('secureConnect');
        else secure.emit('error', new Error('TLS failed'));
      }
    });
    return secure;
  };

  const agent = new TwoHopSocksAgent(
    7897,
    'socks5://user:pass@127.0.0.1:45001'
  );
  const callbacks = [];
  agent.createConnection(
    { host: 'example.test', port: 443 },
    (err, socket) => callbacks.push({ err, socket })
  );
  await new Promise((resolve) => setImmediate(resolve));
  agent.destroy();
  return { callbacks, raw };
}

(async () => {
  try {
    const successThenError = await scenario(['secureConnect', 'error']);
    assert.equal(successThenError.callbacks.length, 1);
    assert.equal(successThenError.callbacks[0].err, null);
    assert.equal(successThenError.raw.destroyCount, 0);

    const errorThenSuccess = await scenario(['error', 'secureConnect']);
    assert.equal(errorThenSuccess.callbacks.length, 1);
    assert.match(errorThenSuccess.callbacks[0].err.message, /TLS failed/);
    assert.equal(errorThenSuccess.raw.destroyCount, 1);

    console.log('PASS — proxy TLS completion callback is exactly-once');
  } finally {
    SocksClient.createConnectionChain = originalChain;
    tls.connect = originalTlsConnect;
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
