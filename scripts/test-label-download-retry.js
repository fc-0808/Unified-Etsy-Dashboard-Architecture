'use strict';

/**
 * Regression test for the resilient label downloader (src/util/http-download.js).
 *
 * Guards the fix for the intermittent "Label did not print: socket hang up"
 * failure: a transient CDN connection reset must be transparently retried, a
 * 30x redirect must be followed, a mid-transfer truncation must be retried, and
 * a deterministic 4xx must fail FAST without wasting retries.
 *
 * Pure local HTTP servers — no network, no 4PX credentials required.
 *
 *   node scripts/test-label-download-retry.js
 */

const http = require('http');
const assert = require('assert');
const { downloadToBuffer, isTransientDownloadError } = require('../src/util/http-download');

const listen = (server) => new Promise((r) => server.listen(0, () => r(server.address().port)));

async function testTransientResetsRecover() {
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits++;
    if (hits <= 2) { req.socket.destroy(); return; } // → ECONNRESET / "socket hang up"
    const body = Buffer.from('%PDF-1.4 fake label bytes');
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': body.length });
    res.end(body);
  });
  const port = await listen(srv);
  try {
    const buf = await downloadToBuffer(`http://127.0.0.1:${port}/label.pdf`, {
      baseDelayMs: 20, timeoutMs: 2000, maxAttempts: 4,
    });
    assert.ok(buf.length > 0, 'expected a body after retries');
    assert.strictEqual(hits, 3, `expected 3 hits (2 resets + 1 ok), got ${hits}`);
    console.log(`✓ transient "socket hang up" recovered after ${hits} attempts`);
  } finally { srv.close(); }
}

async function testRedirectFollowed() {
  const srv = http.createServer((req, res) => {
    if (req.url === '/a') { res.writeHead(302, { Location: '/b' }); res.end(); return; }
    const body = Buffer.from('redirected body');
    res.writeHead(200, { 'Content-Length': body.length }); res.end(body);
  });
  const port = await listen(srv);
  try {
    const buf = await downloadToBuffer(`http://127.0.0.1:${port}/a`, { baseDelayMs: 10 });
    assert.strictEqual(buf.toString(), 'redirected body');
    console.log('✓ 302 redirect followed');
  } finally { srv.close(); }
}

async function testTruncationRetries() {
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits++;
    if (hits === 1) {
      // Promise 100 bytes but drop the socket after a few → truncated body.
      res.writeHead(200, { 'Content-Length': 100 });
      res.write('partial');
      req.socket.destroy();
      return;
    }
    const body = Buffer.from('complete body second time');
    res.writeHead(200, { 'Content-Length': body.length }); res.end(body);
  });
  const port = await listen(srv);
  try {
    const buf = await downloadToBuffer(`http://127.0.0.1:${port}/t`, { baseDelayMs: 20, maxAttempts: 3 });
    assert.strictEqual(buf.toString(), 'complete body second time');
    assert.strictEqual(hits, 2, `expected a retry after truncation, got ${hits} hits`);
    console.log('✓ truncated transfer retried and recovered');
  } finally { srv.close(); }
}

async function testNonRetryable404FailsFast() {
  let hits = 0;
  const srv = http.createServer((_req, res) => { hits++; res.writeHead(404); res.end('nope'); });
  const port = await listen(srv);
  try {
    await downloadToBuffer(`http://127.0.0.1:${port}/x`, { baseDelayMs: 10, maxAttempts: 4 });
    throw new Error('expected 404 to throw');
  } catch (e) {
    assert.strictEqual(hits, 1, `404 must NOT retry, got ${hits} hits`);
    assert.match(e.message, /404/);
    console.log('✓ deterministic 404 fails fast (no wasted retries)');
  } finally { srv.close(); }
}

function testClassifier() {
  assert.strictEqual(isTransientDownloadError({ code: 'ECONNRESET' }), true);
  assert.strictEqual(isTransientDownloadError({ message: 'socket hang up' }), true);
  assert.strictEqual(isTransientDownloadError({ statusCode: 503 }), true);
  assert.strictEqual(isTransientDownloadError({ statusCode: 404 }), false);
  assert.strictEqual(isTransientDownloadError({ nonRetryable: true, message: 'socket hang up' }), false);
  console.log('✓ transient-error classifier behaves correctly');
}

(async () => {
  testClassifier();
  await testTransientResetsRecover();
  await testRedirectFollowed();
  await testTruncationRetries();
  await testNonRetryable404FailsFast();
  console.log('\nALL LABEL-DOWNLOAD RETRY TESTS PASSED');
})().catch((e) => { console.error('\nTEST FAILED:', e); process.exit(1); });
