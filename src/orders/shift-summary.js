'use strict'

/**
 * shift-summary.js — pure classification of audit_log rows into a per-employee
 * "what did they get done this shift" rollup.
 *
 * WHY A SEPARATE MODULE
 * ----------------------------------------------------------------------------
 * The rollup is served by GET /api/shift-summary and asserted by a regression
 * test (scripts/test-shift-summary.js). Keeping the pure logic here — imported by
 * both — means the endpoint and the test can never drift (mirrors pack-queue.js).
 *
 * It reads ONLY the existing audit_log (every mutating API call is already logged
 * with the acting user, path, status and a redacted details snapshot), so there is
 * no new per-action tracking to maintain — accountability falls out of data we
 * already keep.
 */

/** The action buckets a shift is summarised into, in display order. */
const BUCKETS = ['verified', 'purchased', 'packaged', 'shipped', 'issue', 'unpackaged']

/**
 * Classify one audit_log row into a bucket + how many orders it touched.
 *
 * @param {{ method:string, path:string, status:number, details:(object|null) }} row
 * @returns {{ bucket:(string|null), orders:number }}  bucket=null → not counted.
 */
function classifyShiftAction(row) {
	const method = row.method
	const p = String(row.path || '')
	const status = Number(row.status)
	const details = row.details || {}

	// Only successful, mutating actions count. GETs never mutate.
	if (!(status >= 200 && status < 300)) return { bucket: null, orders: 0 }
	if (method === 'GET') return { bucket: null, orders: 0 }

	// Bulk routes redact their receipt_ids array to a "N items" string; per-order
	// routes carry a single receipt_id. Recover the order count from either shape.
	const bulkCount = () => {
		const m = /^(\d+)\s+item/.exec(String(details.receipt_ids || ''))
		return m ? Number(m[1]) : 1
	}

	if (/\/bulk-mark-packaged$/.test(p)) return { bucket: details.packaged === 'false' ? 'unpackaged' : 'packaged', orders: bulkCount() }
	if (/\/mark-packaged$/.test(p)) return { bucket: 'packaged', orders: 1 }
	if (/\/unmark-packaged$/.test(p)) return { bucket: 'unpackaged', orders: 1 }
	if (/\/bulk-verify$/.test(p)) return { bucket: details.verified === 'false' ? null : 'verified', orders: bulkCount() }
	if (/\/verify-all$/.test(p) || /\/items\/verify$/.test(p)) return { bucket: details.verified === 'false' ? null : 'verified', orders: 1 }
	if (/\/4px\/bulk-create-order$/.test(p)) return { bucket: 'shipped', orders: bulkCount() }
	if (/\/4px\/create-order$/.test(p)) return { bucket: 'shipped', orders: 1 }
	if (/\/ship$/.test(p) || /\/manual\/[^/]+\/shipped$/.test(p)) return { bucket: 'shipped', orders: 1 }
	if (/\/items\/component-status$/.test(p)) {
		if (details.status === 'Purchased') return { bucket: 'purchased', orders: 1 }
		if (['Out of Stock', 'Out of Production', 'Model Unavailable', 'Wrong Stall'].includes(details.status)) return { bucket: 'issue', orders: 1 }
		return { bucket: null, orders: 0 }
	}
	if (/\/shop\/assign$/.test(p)) {
		const s = [details.status_case, details.status_grip, details.status_charm]
		if (s.includes('Purchased')) return { bucket: 'purchased', orders: 1 }
		if (s.some((x) => x && x !== 'Pending')) return { bucket: 'issue', orders: 1 }
		return { bucket: null, orders: 0 }
	}
	if (/\/clear-needs-purchase$/.test(p)) return { bucket: 'purchased', orders: 1 }
	if (/\/items\/purchase-state$/.test(p)) return { bucket: details.needs_purchase === 'false' ? 'purchased' : null, orders: 1 }
	return { bucket: null, orders: 0 }
}

/**
 * Roll a set of audit rows up into per-user bucket totals.
 *
 * @param {Array<{ts:number, role:string, user:string, method:string, path:string, status:number, details:(object|null)}>} rows
 * @returns {{ first_action_at:(number|null), last_action_at:(number|null), buckets:string[], users:object[] }}
 */
function summarizeShift(rows) {
	const byUser = new Map()
	let first = null
	let last = null
	for (const r of rows) {
		const { bucket, orders } = classifyShiftAction(r)
		if (!bucket) continue
		const key = r.user || '(unsigned)'
		if (!byUser.has(key)) {
			byUser.set(key, { user: key, role: r.role, counts: Object.fromEntries(BUCKETS.map((b) => [b, 0])), actions: 0 })
		}
		const u = byUser.get(key)
		u.counts[bucket] += orders
		u.actions += 1
		if (first == null || r.ts < first) first = r.ts
		if (last == null || r.ts > last) last = r.ts
	}
	return {
		first_action_at: first,
		last_action_at: last,
		buckets: BUCKETS,
		users: [...byUser.values()].sort((a, b) => b.actions - a.actions),
	}
}

module.exports = { BUCKETS, classifyShiftAction, summarizeShift }
