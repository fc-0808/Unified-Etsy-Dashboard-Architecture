'use strict'

/**
 * Regression test — the per-employee shift-summary classification.
 *
 * Guards that each kind of audit_log action maps to the right bucket and order
 * count, and that failed / read-only calls are never counted. The pure logic lives
 * in src/orders/shift-summary.js (imported by GET /api/shift-summary and here), so
 * the endpoint and this test can never drift.
 *
 * Run: `node scripts/test-shift-summary.js`   (0 = pass, 1 = regression)
 */

const { classifyShiftAction, summarizeShift } = require('../src/orders/shift-summary')

let failures = 0
function assert(cond, msg) {
	if (cond) console.log(`  ok  — ${msg}`)
	else {
		failures++
		console.error(`  FAIL — ${msg}`)
	}
}

const OK = 200
function cls(method, path, status, details) {
	return classifyShiftAction({ method, path, status, details: details || {} })
}

console.log('Shift-summary classification regression test\n')

// ── Per-action classification ─────────────────────────────────────────────────
assert(cls('POST', '/api/orders/123/mark-packaged', OK).bucket === 'packaged', 'mark-packaged → packaged')
assert(cls('POST', '/api/orders/123/verify-all', OK).bucket === 'verified', 'verify-all → verified')
assert(cls('POST', '/api/orders/123/items/verify', OK, { verified: 'false' }).bucket === null, 'un-verify is not counted')
assert(cls('POST', '/api/orders/123/ship', OK).bucket === 'shipped', 'ship → shipped')
assert(cls('POST', '/api/4px/create-order', OK).bucket === 'shipped', '4px create-order → shipped')
assert(cls('POST', '/api/orders/123/items/component-status', OK, { status: 'Purchased' }).bucket === 'purchased', 'component Purchased → purchased')
assert(cls('POST', '/api/orders/123/items/component-status', OK, { status: 'Out of Stock' }).bucket === 'issue', 'component Out of Stock → issue')
assert(cls('POST', '/api/orders/123/items/component-status', OK, { status: 'Pending' }).bucket === null, 'component Pending → not counted')
assert(cls('POST', '/api/shop/assign', OK, { status_case: 'Purchased' }).bucket === 'purchased', 'shop assign Purchased → purchased')

// ── Order-count recovery from bulk "N items" details ────────────────────────────
assert(cls('POST', '/api/orders/bulk-verify', OK, { receipt_ids: '7 items' }).orders === 7, 'bulk-verify counts all 7 orders')
assert(cls('POST', '/api/orders/bulk-mark-packaged', OK, { receipt_ids: '4 items' }).orders === 4, 'bulk-mark-packaged counts all 4 orders')

// ── Never count failures or reads ───────────────────────────────────────────────
assert(cls('POST', '/api/orders/123/ship', 500).bucket === null, 'failed ship (500) is not counted')
assert(cls('GET', '/api/orders', OK).bucket === null, 'GET is never counted')

// ── Rollup ──────────────────────────────────────────────────────────────────────
const rows = [
	{ ts: 1000, user: 'hope', role: 'packer', method: 'POST', path: '/api/orders/1/verify-all', status: OK, details: {} },
	{ ts: 1500, user: 'hope', role: 'packer', method: 'POST', path: '/api/orders/1/mark-packaged', status: OK, details: {} },
	{ ts: 2000, user: 'hope', role: 'packer', method: 'POST', path: '/api/orders/bulk-verify', status: OK, details: { receipt_ids: '3 items' } },
	{ ts: 2500, user: 'hope', role: 'packer', method: 'POST', path: '/api/orders/2/items/component-status', status: OK, details: { status: 'Purchased' } },
	{ ts: 3000, user: 'walter', role: 'owner', method: 'POST', path: '/api/orders/9/ship', status: OK, details: {} },
	{ ts: 3500, user: 'hope', role: 'packer', method: 'GET', path: '/api/orders', status: OK, details: {} }, // ignored
]
const sum = summarizeShift(rows)
const hope = sum.users.find((u) => u.user === 'hope')
assert(hope.counts.verified === 4, `hope verified 1 + 3 (bulk) = 4 (got ${hope.counts.verified})`)
assert(hope.counts.packaged === 1, `hope packaged 1 (got ${hope.counts.packaged})`)
assert(hope.counts.purchased === 1, `hope purchased 1 (got ${hope.counts.purchased})`)
assert(hope.actions === 4, `hope 4 counted actions, GET ignored (got ${hope.actions})`)
assert(sum.users.find((u) => u.user === 'walter').counts.shipped === 1, 'walter shipped 1')
assert(sum.first_action_at === 1000 && sum.last_action_at === 3000, 'first/last action timestamps span only counted actions')

console.log('')
if (failures > 0) {
	console.error(`${failures} assertion(s) FAILED`)
	process.exit(1)
}
console.log('All assertions passed.')
