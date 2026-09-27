'use strict'

/**
 * activity-describe.js — turn a stored audit_log snapshot into a specific
 * "who did what" sentence for the Activity log.
 *
 * WHY A SEPARATE MODULE
 * ----------------------------------------------------------------------------
 * GET /api/audit used to hand the browser a raw method+path+details blob, and
 * the Activity log mapped `/api/route/assign` to the catch-all "Updated routing
 * for order #…". That endpoint is the Orders Sorting write for four different
 * jobs — purchase status, supplier/stall, charm assignment, and route
 * exclusion — so the sentence was true of all of them and useful for none.
 *
 * The classifier reads ONLY the snapshot already stored on the row (the
 * request body the operator sent). Historical rows become specific without a
 * data migration; new rows stay specific even when a field is cleared, because
 * `_auditSnapshot` now keeps empty strings for these mutation keys.
 *
 * The same function is inlined in public/index.html so a cached page that
 * predates `entry.action` still renders the specific sentence. scripts/test-
 * activity-describe.js keeps the two copies honest against one fixture table.
 */

/** Request-body keys whose empty string is a real mutation (a clear), not noise. */
const ROUTE_ASSIGN_MUTATION_KEYS = Object.freeze([
	'status_case',
	'status_grip',
	'status_charm',
	'supplier_shop_override',
	'supplier_stall_override',
	'charm_code',
	'charm_shop',
	'excluded',
])

const ROUTE_ASSIGN_PATH = /\/route\/assign$/
const STATUS_FIELDS = [
	['status_case', 'Case'],
	['status_grip', 'Grip'],
	['status_charm', 'Charm'],
]

function own(details, key) {
	return details != null && Object.prototype.hasOwnProperty.call(details, key) && details[key] != null
}

function textOf(details, key) {
	if (!own(details, key)) return null
	return String(details[key]).trim()
}

/**
 * Label the targeted receipt the way the rest of the Activity log does:
 * synthetic manual orders (negative ids) are named as such.
 *
 * @param {object|null|undefined} details
 * @returns {string}
 */
function orderRef(details) {
	const raw = details == null ? null : details.receipt_id
	if (raw == null || raw === '') return 'an order'
	const id = Number(raw)
	if (!Number.isFinite(id)) return `order #${raw}`
	return id < 0 ? `manual order #${Math.abs(id)}` : `order #${id}`
}

function lowerFirst(phrase) {
	if (!phrase) return phrase
	return phrase.charAt(0).toLowerCase() + phrase.slice(1)
}

function joinPhrases(phrases, order) {
	if (!phrases.length) return `Saved purchasing-route details for ${order}`
	const first = phrases[0]
	const rest = phrases.slice(1).map(lowerFirst)
	const body =
		rest.length === 0
			? first
			: rest.length === 1
				? `${first} and ${rest[0]}`
				: `${[first, ...rest.slice(0, -1)].join(', ')}, and ${rest[rest.length - 1]}`
	return `${body} on ${order}`
}

function joinNames(names) {
	if (names.length <= 1) return names[0] || ''
	if (names.length === 2) return `${names[0]} & ${names[1]}`
	return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`
}

function statusPhrase(details) {
	const comps = STATUS_FIELDS.map(([key, label]) => [label, textOf(details, key)]).filter(([, value]) => value)
	if (!comps.length) return null
	const names = comps.map(([name]) => name)
	const uniform = comps.every(([, value]) => value === comps[0][1])
	if (uniform) return `Marked ${joinNames(names)} as “${comps[0][1]}”`
	return `Updated ${comps.map(([name, value]) => `${name} → ${value}`).join(', ')}`
}

function supplierPhrase(details) {
	const shop = textOf(details, 'supplier_shop_override')
	const stall = textOf(details, 'supplier_stall_override')
	if (shop == null && stall == null) return null
	if (!shop && !stall) return 'Cleared the supplier'
	if (shop && stall) return `Set the supplier to ${shop} at ${stall}`
	if (shop) return `Set the supplier to ${shop}`
	return `Set the stall to ${stall}`
}

function charmPhrase(details) {
	const code = textOf(details, 'charm_code')
	const shop = textOf(details, 'charm_shop')
	if (code == null && shop == null) return null
	if (code === '') return 'Cleared the charm'
	if (code && shop) return `Assigned charm ${code} at ${shop}`
	if (code) return `Assigned charm ${code}`
	if (shop === '') return 'Cleared the charm shop'
	return `Set the charm shop to ${shop}`
}

function excludedPhrase(details) {
	if (!own(details, 'excluded')) return null
	const value = details.excluded
	const off = value === true || value === 1 || value === '1' || value === 'true'
	const on = value === false || value === 0 || value === '0' || value === 'false'
	if (!off && !on) {
		const numeric = Number(value)
		if (numeric === 1) return 'Took this item off the purchasing route'
		if (numeric === 0) return 'Put this item back on the purchasing route'
		return null
	}
	return off ? 'Took this item off the purchasing route' : 'Put this item back on the purchasing route'
}

/**
 * Translate a POST /api/route/assign snapshot into an Activity-log sentence.
 *
 * @param {object|null|undefined} details
 * @returns {{ action: string, detail: string }}
 */
function describeRouteAssign(details) {
	const d = details && typeof details === 'object' ? details : {}
	const phrases = [statusPhrase(d), supplierPhrase(d), charmPhrase(d), excludedPhrase(d)].filter(Boolean)
	return { action: joinPhrases(phrases, orderRef(d)), detail: '' }
}

/**
 * Describe one audit row when this module owns the path. Returns null for
 * every other route so the browser's existing RULES table stays authoritative.
 *
 * @param {{ path?: string, details?: object|null }} entry
 * @returns {{ action: string, detail: string }|null}
 */
function describeAuditEntry(entry) {
	const path = String(entry?.path || '')
	if (!ROUTE_ASSIGN_PATH.test(path)) return null
	return describeRouteAssign(entry?.details)
}

module.exports = {
	ROUTE_ASSIGN_MUTATION_KEYS,
	describeAuditEntry,
	describeRouteAssign,
	orderRef,
}
