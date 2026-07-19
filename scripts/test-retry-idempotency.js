'use strict';

/**
 * Regression tests for the idempotency guard in src/etsy/client.js `withRetry`.
 *
 * Anchors the fix for the duplicate-side-effect bug: a non-idempotent POST
 * (e.g. createReceiptShipment, which emails the buyer) could SUCCEED on Etsy
 * while its RESPONSE was lost on the VPN→proxy chain — the old retry loop then
 * blindly re-sent it, producing a second shipment + a second buyer email.
 *
 * The `reconcile` probe closes that hole: before re-sending, it asks Etsy whether
 * the operation already landed. These tests pin the exact contract.
 *
 * The exponential backoff timer is stubbed to fire instantly so the suite is fast
 * and deterministic (no real waiting).
 *
 * Run: node scripts/test-retry-idempotency.js   (exits non-zero on any failure)
 */

const assert = require('node:assert/strict');

// Make withRetry's backoff instant BEFORE requiring the client module.
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn) => { fn(); return 0; };

const { withRetry } = require('../src/etsy/client');

// A transient transport failure (no HTTP response) — the "response lost" case.
function netErr() { return Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); }
// A non-retryable HTTP error (a real response came back).
function httpErr(status) { return Object.assign(new Error(`http ${status}`), { response: { status } }); }

let passed = 0;
const failures = [];
async function test(name, fn) {
	try { await fn(); passed++; console.log(`  ok  — ${name}`); }
	catch (err) { failures.push({ name, err }); console.log(`  FAIL — ${name}\n       ${err.message}`); }
}

(async () => {
	// 1. Happy path: a first-try success must never consult the probe.
	await test('success on first try never probes reconcile', async () => {
		let calls = 0, probes = 0;
		const r = await withRetry(async () => { calls++; return 'ok'; }, 3, {
			reconcile: async () => { probes++; return 'X'; },
		});
		assert.equal(r, 'ok');
		assert.equal(calls, 1);
		assert.equal(probes, 0);
	});

	// 2. THE key case — response lost but the op landed: adopt the existing record,
	//    do NOT re-send (no duplicate shipment / buyer email).
	await test('adopts existing record on retry instead of re-sending', async () => {
		let calls = 0;
		const existing = { receipt_shipping_id: 7, tracking_code: 'T1' };
		const r = await withRetry(async () => { calls++; throw netErr(); }, 3, {
			reconcile: async () => existing,
		});
		assert.deepEqual(r, existing);
		assert.equal(calls, 1); // fn was NOT retried — critical
	});

	// 3. Genuine failure: probe confirms nothing landed → safe to retry, 2nd wins.
	await test('retries when the probe confirms nothing was created', async () => {
		let calls = 0;
		const r = await withRetry(async () => { calls++; if (calls === 1) throw netErr(); return 'sent'; }, 3, {
			reconcile: async () => null,
		});
		assert.equal(r, 'sent');
		assert.equal(calls, 2);
	});

	// 4. Ambiguous: the probe itself fails → fail closed, surface the original
	//    error, and DO NOT re-send a non-idempotent op.
	await test('fails closed (no re-send) when the probe itself errors', async () => {
		let calls = 0;
		await assert.rejects(
			withRetry(async () => { calls++; throw netErr(); }, 3, {
				reconcile: async () => { throw new Error('probe down'); },
			}),
			/socket hang up/,
		);
		assert.equal(calls, 1);
	});

	// 5. Non-retryable HTTP error → throw immediately, never probe.
	await test('non-retryable error throws immediately without probing', async () => {
		let calls = 0, probes = 0;
		await assert.rejects(
			withRetry(async () => { calls++; throw httpErr(400); }, 3, {
				reconcile: async () => { probes++; return 'X'; },
			}),
			/http 400/,
		);
		assert.equal(calls, 1);
		assert.equal(probes, 0);
	});

	// 6. Idempotent calls (no reconcile) keep the original retry behavior.
	await test('idempotent call (no reconcile) still retries and succeeds', async () => {
		let calls = 0;
		const r = await withRetry(async () => { calls++; if (calls < 3) throw netErr(); return 'ok'; }, 3);
		assert.equal(r, 'ok');
		assert.equal(calls, 3);
	});

	global.setTimeout = realSetTimeout;
	console.log(`\n${failures.length ? 'FAIL' : 'PASS'} — ${passed} passed, ${failures.length} failed`);
	process.exit(failures.length ? 1 : 0);
})();
