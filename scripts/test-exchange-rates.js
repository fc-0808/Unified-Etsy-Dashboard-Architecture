'use strict'

/**
 * The rate table behind every customs value on the packing bench.
 *
 * A missing table used to look like this: every UK order showed "GBP 135.00"
 * (Etsy's ceiling) because the per-order conversion never resolved and the
 * notice offered the only currency amount it still had. These tests pin the
 * store so that cannot happen again:
 *
 *   · a successful fetch is written next to the database
 *   · a station with no egress still converts from that last-good copy
 *   · a bad payload cannot overwrite a good copy
 *   · a failed lookup is retried in minutes, not at the next process restart
 *   · the VPN hop is tried when a direct connection fails
 *
 *     npm run test:exchange-rates
 */

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const rates = require('../src/compliance/exchange-rates')

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m'
let passed = 0, failed = 0
const failures = []
const pending = []
function group(name) { pending.push({ group: name }) }
function test(name, fn) { pending.push({ name, fn }) }

/** A table that would survive validateRateTable — 20 ISO currencies, EUR === 1. */
function table(extra = {}) {
	return {
		EUR: 1, GBP: 0.85, USD: 1.08, HKD: 8.5, NOK: 11.5, CHF: 0.95, AUD: 1.65, NZD: 1.8,
		CNY: 7.8, JPY: 160, CAD: 1.47, SGD: 1.45, KRW: 1450, INR: 90, MXN: 18, BRL: 5.5,
		SEK: 11.2, DKK: 7.46, PLN: 4.3, CZK: 25, TRY: 34, ZAR: 20,
		...extra,
	}
}

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'exchange-rates-'))
}

function silent() {}

group('A table we would put in front of a packer')

test('a real EUR-base table is accepted', () => {
	const checked = rates.validateRateTable(table())
	assert.strictEqual(checked.ok, true)
	assert.strictEqual(checked.rates.EUR, 1)
	assert.strictEqual(checked.rates.GBP, 0.85)
})

test('a table that is not EUR-based is refused', () => {
	const checked = rates.validateRateTable(table({ EUR: 1.07 }))
	assert.strictEqual(checked.ok, false)
})

test('a truncated or empty payload is refused', () => {
	assert.strictEqual(rates.validateRateTable(null).ok, false)
	assert.strictEqual(rates.validateRateTable({ EUR: 1, GBP: 0.85 }).ok, false)
	assert.strictEqual(rates.validateRateTable(table({ GBP: 0 })).ok, true) // 0 is dropped, rest remain
	assert.ok(!rates.validateRateTable(table({ GBP: 0 })).rates.GBP)
})

test('non-ISO keys and non-numeric values never enter the table', () => {
	const checked = rates.validateRateTable({ ...table(), bitcoin: 90000, XXXX: 'nope', '': 1 })
	assert.strictEqual(checked.ok, true)
	assert.ok(!checked.rates.bitcoin)
	assert.ok(!checked.rates.XXXX)
	assert.strictEqual(checked.rates.GBP, 0.85)
})

group('Conversion')

test('HKD 170 is EUR 20 at these rates', () => {
	const converted = rates.convert(170, 'HKD', 'EUR', table())
	assert.strictEqual(converted, 20)
})

test('HKD 1700 is GBP 170 at these rates', () => {
	const converted = rates.convert(1700, 'HKD', 'GBP', table())
	assert.strictEqual(converted, 170)
})

test('a missing currency is null, never a guess', () => {
	assert.strictEqual(rates.convert(20, 'HKD', 'XXX', table()), null)
	assert.strictEqual(rates.convert(20, 'HKD', 'GBP', {}), null)
	assert.strictEqual(rates.convert(NaN, 'HKD', 'GBP', table()), null)
})

group('Last-good copy on disk')

test('a successful fetch is written next to the database', async () => {
	const dir = tmpDir()
	const store = rates.createRateStore({
		cacheDir: dir,
		request: async () => ({ result: 'success', rates: table() }),
		log: silent,
		now: () => Date.parse('2026-08-19T04:00:00.000Z'),
	})
	const snap = await store.get()
	assert.strictEqual(snap.source, 'direct')
	assert.strictEqual(snap.rates.GBP, 0.85)
	assert.strictEqual(snap.stale, false)
	const saved = JSON.parse(fs.readFileSync(path.join(dir, rates.CACHE_FILE), 'utf8'))
	assert.strictEqual(saved.base, 'EUR')
	assert.strictEqual(saved.rates.GBP, 0.85)
	assert.strictEqual(saved.fetched_at, '2026-08-19T04:00:00.000Z')
})

test('a station with no egress still converts from the last-good copy', async () => {
	const dir = tmpDir()
	const live = rates.createRateStore({
		cacheDir: dir,
		request: async () => ({ result: 'success', rates: table() }),
		log: silent,
		now: () => Date.parse('2026-08-12T00:00:00.000Z'),
	})
	await live.get()

	const offline = rates.createRateStore({
		cacheDir: dir,
		request: async () => { throw new Error('ENETUNREACH') },
		log: silent,
		now: () => Date.parse('2026-08-19T00:00:00.000Z'),
	})
	const snap = await offline.get()
	assert.strictEqual(snap.source, 'cache')
	assert.strictEqual(snap.rates.GBP, 0.85)
	assert.strictEqual(snap.stale, true, 'a week-old table was described as fresh')
	assert.ok(snap.error, 'the failed refresh was not reported')
})

test('a bad payload cannot overwrite a good copy', async () => {
	const dir = tmpDir()
	let body = { result: 'success', rates: table() }
	const store = rates.createRateStore({
		cacheDir: dir,
		request: async () => body,
		log: silent,
		now: (() => { let t = 0; return () => t += rates.FRESH_MS + 1 })(),
	})
	await store.get()
	body = { result: 'success', rates: { EUR: 1, GBP: 0.85 } } // too small
	const snap = await store.get()
	assert.strictEqual(snap.rates.HKD, 8.5, 'the good table was replaced with a truncated one')
	assert.ok(snap.error, 'the rejected refresh was not reported')
})

test('two page loads share one in-flight refresh', async () => {
	const dir = tmpDir()
	let calls = 0
	let release
	const hold = new Promise((resolve) => { release = resolve })
	const store = rates.createRateStore({
		cacheDir: dir,
		request: async () => { calls++; await hold; return { result: 'success', rates: table() } },
		log: silent,
	})
	const a = store.get()
	const b = store.get()
	release()
	await Promise.all([a, b])
	assert.strictEqual(calls, 1, `a burst of loads became ${calls} outbound requests`)
})

test('a failed lookup is retried after RETRY_MS, not held until restart', async () => {
	const dir = tmpDir()
	let now = 1_000
	let calls = 0
	const store = rates.createRateStore({
		cacheDir: dir,
		request: async () => { calls++; throw new Error('ETIMEDOUT') },
		log: silent,
		now: () => now,
	})
	await store.get()
	assert.strictEqual(calls, 1)
	now += 1_000
	await store.get()
	assert.strictEqual(calls, 1, 'a retry fired inside the backoff window')
	now += rates.RETRY_MS
	await store.get()
	assert.strictEqual(calls, 2, 'a retry was not scheduled after the backoff')
})

group('The VPN hop is the same first hop the rest of the app uses')

test('a failed direct connection falls through to the configured SOCKS port', async () => {
	const dir = tmpDir()
	const seen = []
	const store = rates.createRateStore({
		cacheDir: dir,
		vpnPort: 7897,
		request: async (_url, opts) => {
			seen.push(Boolean(opts && opts.agent))
			if (!opts || !opts.agent) throw new Error('ENETUNREACH')
			return { result: 'success', rates: table() }
		},
		log: silent,
	})
	const snap = await store.get()
	assert.deepStrictEqual(seen, [false, true], `routes tried: ${JSON.stringify(seen)}`)
	assert.strictEqual(snap.source, 'vpn:7897')
	assert.strictEqual(snap.rates.GBP, 0.85)
})

group('Shipped wiring')

test('the dashboard serves this store, not an in-memory fetch of its own', () => {
	const server = fs.readFileSync(path.resolve(__dirname, '../src/server/index.js'), 'utf8')
	assert.ok(server.includes("require('../compliance/exchange-rates')"), 'the server no longer loads the rate store')
	assert.ok(server.includes('createRateStore'), 'the server constructs no rate store')
	assert.ok(server.includes('path.dirname(path.resolve(config.db_path))'), 'the last-good table is not next to the database')
	assert.ok(!/https\.get\('https:\/\/open\.er-api\.com/.test(server), 'the inline open.er-api.com fetch is back in the server')
	assert.ok(!/_ratesCache/.test(server), 'the old in-memory cache survived')
})

test('packers can read the table and nobody can write it over HTTP', () => {
	const policy = require('../src/auth/policy')
	assert.strictEqual(policy.requiredCapability('GET', '/api/exchange-rates'), 'app:shell')
	assert.strictEqual(policy.authorizeApi('packer', 'GET', '/api/exchange-rates').allowed, true)
	assert.strictEqual(policy.requiredCapability('POST', '/api/exchange-rates'), null)
})

;(async () => {
	for (const entry of pending) {
		if (entry.group) { console.log(`\n${BOLD}${entry.group}${RESET}`); continue }
		try {
			await entry.fn()
			passed++
			console.log(`${GREEN}  ✓${RESET} ${entry.name}`)
		} catch (err) {
			failed++
			failures.push({ name: entry.name, err })
			console.log(`${RED}  ✗${RESET} ${entry.name}`)
		}
	}
	console.log()
	if (failed) {
		console.log(`${RED}${BOLD}  ${failed} test(s) failed${RESET}, ${passed} passed`)
		for (const f of failures) console.log(`${DIM}  · ${f.name}: ${f.err.message}${RESET}`)
		process.exit(1)
	}
	console.log(`${GREEN}${BOLD}  All ${passed} tests passed.${RESET}`)
	process.exit(0)
})()
