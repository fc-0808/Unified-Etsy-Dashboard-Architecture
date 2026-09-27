'use strict'
/**
 * Unit tests for the per-shop Etsy write lock in bulk-runner.
 *
 * Bulk runs now process several products at once so the slow vision/copy pass
 * can overlap. The Etsy write phase must NOT overlap: it shares one OAuth
 * token, one proxy and a 5 QPS budget per API key. These tests pin that
 * guarantee — including the nasty part, that a failing product must not stall
 * or poison every product queued behind it.
 *
 * Offline and deterministic: no DB, no network.
 */

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m'
let passed = 0, failed = 0
const failures = []
const pending = []

function group(name) { pending.push({ group: name }) }
function test(name, fn) { pending.push({ name, fn }) }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The lock is a self-contained method; exercise it on a bare object rather than
// standing up a full BulkJobManager (which needs a SQLite handle).
const { BulkJobManager } = require('../src/listings/bulk-runner')
const { requirePositiveEtsyId } = require('../src/listings/etsy-create')
const dashboardSource = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8')
const makeLock = () => {
	const host = { _etsyLocks: new Map() }
	host._withEtsyLock = BulkJobManager.prototype._withEtsyLock.bind(host)
	return host
}

group('Per-shop Etsy write lock')

test('runs critical sections one at a time', async () => {
	const host = makeLock()
	let active = 0, maxActive = 0
	const task = async () => {
		active++
		maxActive = Math.max(maxActive, active)
		await sleep(20)
		active--
	}
	await Promise.all([1, 2, 3, 4, 5].map(() => host._withEtsyLock('shopA', task)))
	assert.strictEqual(maxActive, 1, 'two Etsy writes overlapped — the rate budget would be doubled')
})

test('preserves FIFO order', async () => {
	const host = makeLock()
	const order = []
	await Promise.all(
		[1, 2, 3, 4].map((n) => host._withEtsyLock('shopA', async () => {
			await sleep(10 - n) // later tasks are faster; order must still hold
			order.push(n)
		})),
	)
	assert.deepStrictEqual(order, [1, 2, 3, 4])
})

test('different shops do not block each other', async () => {
	const host = makeLock()
	let active = 0, maxActive = 0
	const task = async () => {
		active++
		maxActive = Math.max(maxActive, active)
		await sleep(30)
		active--
	}
	await Promise.all([
		host._withEtsyLock('shopA', task),
		host._withEtsyLock('shopB', task),
	])
	assert.strictEqual(maxActive, 2, 'separate shops have separate rate budgets and should run in parallel')
})

test('a rejection propagates to its own caller', async () => {
	const host = makeLock()
	await assert.rejects(
		() => host._withEtsyLock('shopA', async () => { throw new Error('etsy 500') }),
		/etsy 500/,
	)
})

test('one failure does not poison the products queued behind it', async () => {
	const host = makeLock()
	const done = []
	const results = await Promise.allSettled([
		host._withEtsyLock('shopA', async () => { throw new Error('boom') }),
		host._withEtsyLock('shopA', async () => { await sleep(5); done.push('b'); return 'b' }),
		host._withEtsyLock('shopA', async () => { done.push('c'); return 'c' }),
	])
	assert.strictEqual(results[0].status, 'rejected')
	assert.strictEqual(results[1].status, 'fulfilled')
	assert.strictEqual(results[2].status, 'fulfilled')
	assert.deepStrictEqual(done, ['b', 'c'], 'the queue must keep draining in order after a failure')
})

test('still serialises after a failure', async () => {
	const host = makeLock()
	let active = 0, maxActive = 0
	const task = async () => {
		active++
		maxActive = Math.max(maxActive, active)
		await sleep(15)
		active--
	}
	await Promise.allSettled([
		host._withEtsyLock('shopA', async () => { throw new Error('boom') }),
		host._withEtsyLock('shopA', task),
		host._withEtsyLock('shopA', task),
	])
	assert.strictEqual(maxActive, 1)
})

test('a synchronous throw is contained like any other failure', async () => {
	const host = makeLock()
	const settled = await Promise.allSettled([
		host._withEtsyLock('shopA', () => { throw new Error('sync boom') }),
		host._withEtsyLock('shopA', async () => 'ok'),
	])
	assert.strictEqual(settled[0].status, 'rejected')
	assert.strictEqual(settled[1].status, 'fulfilled')
	assert.strictEqual(settled[1].value, 'ok')
})

test('returns the critical section\'s value', async () => {
	const host = makeLock()
	assert.strictEqual(await host._withEtsyLock('shopA', async () => 42), 42)
})

test('a missing shop name still serialises rather than running wild', async () => {
	const host = makeLock()
	let active = 0, maxActive = 0
	const task = async () => {
		active++
		maxActive = Math.max(maxActive, active)
		await sleep(10)
		active--
	}
	await Promise.all([
		host._withEtsyLock(undefined, task),
		host._withEtsyLock(null, task),
		host._withEtsyLock('', task),
	])
	assert.strictEqual(maxActive, 1)
})

group('Safe-preview network boundary')

test('dry runs resolve local shop config without constructing an Etsy client', async () => {
	let liveCalls = 0
	const host = {
		resolveShopConfig: () => ({ shop_id: 'local-shop', shop_name: 'Shop' }),
		resolveShopClient: async () => {
			liveCalls++
			throw new Error('must not contact Etsy')
		},
	}
	const context = await BulkJobManager.prototype._resolveRunShopContext.call(host, {
		dry_run: 1,
		shop_key: 'local-shop',
		shop_name: 'Shop',
	})
	assert.strictEqual(liveCalls, 0)
	assert.strictEqual(context.shopClient, null)
	assert.strictEqual(context.numericShopId, 'local-shop')
	assert.strictEqual(context.dryRun, true)
})

test('real listing jobs resolve the verified authenticated client', async () => {
	let liveCalls = 0
	const live = {
		shopClient: { verified: true },
		numericShopId: '123',
		shopCfg: { shop_id: 'local-shop' },
		scopes: ['listings_w'],
	}
	const host = {
		resolveShopConfig: () => ({ shop_id: 'local-shop' }),
		resolveShopClient: async () => { liveCalls++; return live },
	}
	const context = await BulkJobManager.prototype._resolveRunShopContext.call(host, {
		dry_run: 0,
		shop_name: 'Shop',
	})
	assert.strictEqual(liveCalls, 1)
	assert.strictEqual(context.shopClient, live.shopClient)
	assert.strictEqual(context.dryRun, false)
})

test('real jobs fail once before item writes when required listing settings are missing', () => {
	const validate = BulkJobManager.prototype._validateRealListingDefaults
	assert.throws(
		() => validate.call({}, { taxonomy_id: 1, readiness_state_id: null }),
		(err) => err && err.code === 'SHOP_LISTING_SETTINGS_INCOMPLETE' && err.status === 409,
	)
	assert.throws(
		() => validate.call({}, { taxonomy_id: null, readiness_state_id: 2 }),
		/Shop listing settings are incomplete/,
	)
	// Etsy's Jan 2026 draft update made shipping_profile_id optional for drafts.
	assert.doesNotThrow(() => validate.call({}, { taxonomy_id: 1, readiness_state_id: 2 }))
})

test('malformed Etsy listing and image IDs fail closed', () => {
	assert.strictEqual(requirePositiveEtsyId(123, 'listing_id'), 123)
	assert.strictEqual(requirePositiveEtsyId('456', 'listing_image_id'), '456')
	for (const invalid of [null, undefined, '', 0, '0', -1, 'abc', '1.2']) {
		assert.throws(
			() => requirePositiveEtsyId(invalid, 'listing_id'),
			(err) => err && err.code === 'ETSY_INVALID_ID_RESPONSE',
		)
	}
})

group('Publish safety')

test('publishing requires an explicit manual review stamp', () => {
	const guard = BulkJobManager.prototype._requireReviewedForPublish
	assert.throws(
		() => guard.call({}, { reviewed_at: null }),
		(err) => err && err.code === 'REVIEW_REQUIRED' && err.status === 409,
	)
	assert.doesNotThrow(() => guard.call({}, { reviewed_at: 1_700_000_000 }))
})

test('review sign-off stores the review timestamp', () => {
	const updates = []
	const events = []
	const item = { product_folder: 'p1', seq: 1, preview_json: '{"title":"ready"}' }
	const host = {
		getJob: () => ({ job_id: 'job-1' }),
		getItemBySeq: () => item,
		_isReviewable: () => true,
		_updateItem: (...args) => updates.push(args),
		_emit: (...args) => events.push(args),
	}
	const sign = BulkJobManager.prototype.setItemReviewed
	const result = sign.call(host, 'job-1', 1, true)
	assert.ok(result.reviewed_at)
	assert.strictEqual(updates[0][2].reviewed_at, result.reviewed_at)
	assert.strictEqual(events[0][1].reviewed_at, result.reviewed_at)
})

test('new bulk jobs cannot bypass the local preview workflow', () => {
	assert.throws(
		() => BulkJobManager.prototype.createAndStart.call({}, { dryRun: false }),
		(err) => err && err.code === 'SAFE_PREVIEW_REQUIRED' && err.status === 409,
	)
})

test('real jobs cannot resume until listings are reviewed', () => {
	const guard = BulkJobManager.prototype._requireReviewForRealJob
	const host = {
		getItems: () => [{ excluded: 0, reviewed_at: null }],
	}
	assert.throws(
		() => guard.call(host, 'job-1', { dry_run: 0 }),
		(err) => err && err.code === 'REVIEW_REQUIRED' && err.status === 409,
	)
	assert.doesNotThrow(() => guard.call(host, 'job-1', { dry_run: 1 }))
	host.getItems = () => [{ excluded: 0, reviewed_at: 123 }]
	assert.doesNotThrow(() => guard.call(host, 'job-1', { dry_run: 0 }))
})

test('bulk UI reviews without a blocking popup', () => {
	assert.match(dashboardSource, /id="bulkDryRun" checked disabled/)
	assert.doesNotMatch(dashboardSource, /function bulkPolicyAttestation\(\)/)
	assert.doesNotMatch(dashboardSource, /const confirmed = confirm\(/)
	assert.match(dashboardSource, /JSON\.stringify\(\{ seqs, reviewed \}\)/)
	assert.match(dashboardSource, /JSON\.stringify\(\{ reviewed: next \}\)/)
})

test('publish-target runs always create recoverable drafts before activation', () => {
	const stateFor = BulkJobManager.prototype._effectiveCreateState
	assert.strictEqual(stateFor.call({}, 'published', false), 'draft')
	assert.strictEqual(stateFor.call({}, 'published', true), 'published')
	assert.strictEqual(stateFor.call({}, 'draft', false), 'draft')
})

test('material edits invalidate a stale review stamp', () => {
	const updates = []
	const events = []
	const host = {
		_updateItem: (...args) => updates.push(args),
		_emit: (...args) => events.push(args),
	}
	BulkJobManager.prototype._invalidateReview.call(
		host,
		'job-1',
		{ product_folder: 'p1', seq: 1, reviewed_at: 123 },
		'copy_changed',
	)
	assert.deepStrictEqual(updates[0][2], {
		reviewed_at: null,
		policy_confirmed_at: null,
		policy_confirmed_by: null,
		policy_attestation: null,
	})
	assert.strictEqual(events[0][1].reviewed_at, null)
	assert.strictEqual(events[0][1].reason, 'copy_changed')

	updates.length = 0
	BulkJobManager.prototype._invalidateReview.call(
		host,
		'job-1',
		{ product_folder: 'p1', seq: 1, reviewed_at: null },
	)
	assert.strictEqual(updates.length, 0)
})

test('items cannot be pre-approved before a preview exists', () => {
	const reviewable = BulkJobManager.prototype._isReviewable
	assert.strictEqual(reviewable.call({}, { status: 'pending', preview_json: null, listing_id: null }), false)
	assert.strictEqual(reviewable.call({}, { status: 'failed', preview_json: '{"title":"ready"}' }), true)
	assert.strictEqual(reviewable.call({}, { status: 'done' }), true)
})

group('Concurrency configuration')

// Note: these reload config.js, which re-runs dotenv — so an unset variable is
// immediately repopulated from .env. Every case therefore sets the value
// explicitly rather than relying on absence.
const concurrencyFor = (value) => {
	const previous = process.env.BULK_CONCURRENCY
	process.env.BULK_CONCURRENCY = value
	delete require.cache[require.resolve('../src/listings/config')]
	try {
		return require('../src/listings/config').config.bulk.concurrency
	} finally {
		if (previous === undefined) delete process.env.BULK_CONCURRENCY
		else process.env.BULK_CONCURRENCY = previous
		delete require.cache[require.resolve('../src/listings/config')]
	}
}

test('falls back to overlapping generation when unparseable', () => {
	// The fallback is the shipped default: parallel, but bounded.
	const fallback = concurrencyFor('not-a-number')
	assert.strictEqual(fallback, 3)
	assert.ok(fallback >= 2 && fallback <= 8)
})

test('respects an operator override and clamps absurd values', () => {
	for (const [env, expected] of [['1', 1], ['4', 4], ['8', 8], ['999', 8], ['0', 1], ['-3', 1]]) {
		assert.strictEqual(concurrencyFor(env), expected, `BULK_CONCURRENCY=${env}`)
	}
})

test('an operator can still force fully sequential runs', () => {
	assert.strictEqual(concurrencyFor('1'), 1)
})

// ── Runner ───────────────────────────────────────────────────────────────────
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
	console.log()
})()
