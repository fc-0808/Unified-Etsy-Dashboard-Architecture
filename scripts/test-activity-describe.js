'use strict'

/**
 * Regression test — Activity log sentences for POST /api/route/assign.
 *
 * The endpoint is four jobs on one URL (purchase status, supplier/stall, charm,
 * exclusion). The classifier in src/orders/activity-describe.js — also inlined in
 * public/index.html and applied by GET /api/audit — must name the actual change
 * instead of the catch-all "Updated routing".
 *
 * Run: node scripts/test-activity-describe.js
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const activityDescribe = require('../src/orders/activity-describe')
const { describeRouteAssign, describeAuditEntry, orderRef, ROUTE_ASSIGN_MUTATION_KEYS } = activityDescribe

const ROOT = path.resolve(__dirname, '..')
const PAGE = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8')
const SERVER = fs.readFileSync(path.join(ROOT, 'src/server/index.js'), 'utf8')

let failures = 0
function check(cond, msg) {
	if (cond) console.log(`  ok  — ${msg}`)
	else {
		failures++
		console.error(`  FAIL — ${msg}`)
	}
}

function actionOf(details) {
	return describeRouteAssign(details).action
}

const FIXTURES = [
	{
		name: 'marks one component purchased',
		details: { receipt_id: '4172039867', item_key: 'abc', title: 'Kuromi Pink Case', status_case: 'Purchased' },
		action: 'Marked Case as “Purchased” on order #4172039867',
	},
	{
		name: 'marks two components with the same status',
		details: { receipt_id: '1', status_case: 'Purchased', status_grip: 'Purchased' },
		action: 'Marked Case & Grip as “Purchased” on order #1',
	},
	{
		name: 'marks all three components with the same status',
		details: { receipt_id: '1', status_case: 'Out of Stock', status_grip: 'Out of Stock', status_charm: 'Out of Stock' },
		action: 'Marked Case, Grip & Charm as “Out of Stock” on order #1',
	},
	{
		name: 'spells mixed component statuses',
		details: { receipt_id: '9', status_case: 'Purchased', status_charm: 'Wrong Stall' },
		action: 'Updated Case → Purchased, Charm → Wrong Stall on order #9',
	},
	{
		name: 'assigns a supplier and stall',
		details: { receipt_id: '4172071963', supplier_shop_override: '连家', supplier_stall_override: 'A2-29' },
		action: 'Set the supplier to 连家 at A2-29 on order #4172071963',
	},
	{
		name: 'assigns a supplier without a stall',
		details: { receipt_id: '2', supplier_shop_override: 'Leo' },
		action: 'Set the supplier to Leo on order #2',
	},
	{
		name: 'assigns a stall without a shop name',
		details: { receipt_id: '2', supplier_stall_override: '4D32' },
		action: 'Set the stall to 4D32 on order #2',
	},
	{
		name: 'clears the supplier (empty strings kept on the snapshot)',
		details: { receipt_id: '2', supplier_shop_override: '', supplier_stall_override: '' },
		action: 'Cleared the supplier on order #2',
	},
	{
		name: 'assigns a charm at a shop',
		details: { receipt_id: '3', charm_code: 'CH-00109', charm_shop: '领尚' },
		action: 'Assigned charm CH-00109 at 领尚 on order #3',
	},
	{
		name: 'assigns a charm code only',
		details: { receipt_id: '3', charm_code: 'CH-00109' },
		action: 'Assigned charm CH-00109 on order #3',
	},
	{
		name: 'clears the charm',
		details: { receipt_id: '3', charm_code: '', charm_shop: '' },
		action: 'Cleared the charm on order #3',
	},
	{
		name: 'sets only the charm shop',
		details: { receipt_id: '3', charm_shop: 'Kuromi Shop' },
		action: 'Set the charm shop to Kuromi Shop on order #3',
	},
	{
		name: 'clears only the charm shop',
		details: { receipt_id: '3', charm_shop: '' },
		action: 'Cleared the charm shop on order #3',
	},
	{
		name: 'takes a line off the purchasing route',
		details: { receipt_id: '4', excluded: '1' },
		action: 'Took this item off the purchasing route on order #4',
	},
	{
		name: 'puts a line back on the purchasing route',
		details: { receipt_id: '4', excluded: 0 },
		action: 'Put this item back on the purchasing route on order #4',
	},
	{
		name: 'names a synthetic manual order',
		details: { receipt_id: '-42', status_case: 'Purchased' },
		action: 'Marked Case as “Purchased” on manual order #42',
	},
	{
		name: 'combines a purchase and a supplier in one save',
		details: {
			receipt_id: '5',
			status_case: 'Purchased',
			supplier_shop_override: '连家',
			supplier_stall_override: 'A2-29',
		},
		action: 'Marked Case as “Purchased” and set the supplier to 连家 at A2-29 on order #5',
	},
	{
		name: 'combines three kinds of change with an Oxford comma',
		details: {
			receipt_id: '6',
			status_charm: 'Purchased',
			charm_code: 'CH-7',
			excluded: '1',
		},
		action: 'Marked Charm as “Purchased”, assigned charm CH-7, and took this item off the purchasing route on order #6',
	},
	{
		name: 'falls back honestly when the snapshot has no mutation fields',
		details: { receipt_id: '10000000042', item_key: 'x', title: 'Tamagotchi Clear Phone Case' },
		action: 'Saved purchasing-route details for order #10000000042',
	},
	{
		name: 'tolerates a missing details object',
		details: null,
		action: 'Saved purchasing-route details for an order',
	},
]

console.log('Activity-describe (route/assign) regression test\n')

console.log('Module fixtures')
for (const fixture of FIXTURES) {
	const got = actionOf(fixture.details)
	if (got === fixture.action) check(true, fixture.name)
	else check(false, `${fixture.name}\n        expected: ${fixture.action}\n        got:      ${got}`)
	check(describeRouteAssign(fixture.details).detail === '', `${fixture.name}: no extra detail line (the product card already shows the title)`)
}

check(orderRef({ receipt_id: '-7' }) === 'manual order #7', 'orderRef names synthetic manual orders')
check(orderRef({ receipt_id: '417' }) === 'order #417', 'orderRef names a live Etsy receipt')
check(orderRef({}) === 'an order', 'orderRef degrades when the receipt is missing')
check(
	ROUTE_ASSIGN_MUTATION_KEYS.includes('charm_code') && ROUTE_ASSIGN_MUTATION_KEYS.includes('supplier_shop_override'),
	'mutation-key list includes charm and supplier fields whose empty string is a clear',
)

const assigned = describeAuditEntry({
	path: '/api/route/assign',
	method: 'POST',
	details: { receipt_id: '8', status_grip: 'Purchased' },
})
check(assigned && assigned.action === 'Marked Grip as “Purchased” on order #8', 'describeAuditEntry owns POST /api/route/assign')
check(describeAuditEntry({ path: '/api/shop/assign', details: { status_case: 'Purchased' } }) === null, 'describeAuditEntry leaves /api/shop/assign to the existing browser rule')
check(describeAuditEntry({ path: '/api/orders/1/mark-packaged' }) === null, 'describeAuditEntry ignores unrelated paths')

console.log('\nBrowser copy stays in lockstep')
check(!/Updated routing for/.test(PAGE), 'the Activity log no longer uses the catch-all “Updated routing for”')
check(/function describeRouteAssign\(details\)/.test(PAGE), 'the browser inlines describeRouteAssign as a fallback')
check(/typeof e\.action === 'string' && e\.action\.trim\(\)/.test(PAGE), 'the browser prefers the server-attached action sentence')

const fnStart = PAGE.indexOf('function describeRouteAssign(details)')
const rulesStart = PAGE.indexOf('const RULES = [', fnStart)
check(fnStart >= 0 && rulesStart > fnStart, 'describeRouteAssign sits immediately before the RULES table')
if (fnStart >= 0 && rulesStart > fnStart) {
	const source = PAGE.slice(fnStart, rulesStart)
	let htmlDescribe
	try {
		htmlDescribe = vm.runInNewContext(`${source}\ndescribeRouteAssign`)
	} catch (err) {
		htmlDescribe = null
		check(false, `browser describeRouteAssign failed to evaluate: ${err.message}`)
	}
	if (typeof htmlDescribe === 'function') {
		for (const fixture of FIXTURES) {
			const fromHtml = htmlDescribe(fixture.details)
			const fromModule = describeRouteAssign(fixture.details)
			check(
				fromHtml.action === fromModule.action && fromHtml.detail === fromModule.detail,
				`HTML copy matches module for ${fixture.name}`,
			)
		}
	}
}

console.log('\nServer wiring')
check(/activityDescribe = require\('\.\.\/orders\/activity-describe'\)/.test(SERVER), 'the dashboard server imports the classifier')
check(/activityDescribe\.describeAuditEntry\(entry\)/.test(SERVER), 'GET /api/audit attaches action/detail from the classifier')
check(/_AUDIT_KEEP_EMPTY = new Set\(activityDescribe\.ROUTE_ASSIGN_MUTATION_KEYS\)/.test(SERVER), 'the audit snapshot keeps empty strings on route-assign mutation keys')
check(/!keepEmpty && \(_AUDIT_SECRET_KEY\.test\(key\)/.test(SERVER), 'mutation keys are not swallowed by the secret/bulk redact patterns')
const snapshotSource = SERVER.slice(SERVER.indexOf('function _auditSnapshot'), SERVER.indexOf('const _auditInsert'))
for (const key of ['supplier_shop_override', 'charm_code', 'excluded', 'status_case']) {
	check(snapshotSource.includes(`'${key}'`), `truncated snapshots still prefer ${key} over descriptive extras`)
}

console.log('')
if (failures > 0) {
	console.error(`${failures} assertion(s) FAILED`)
	process.exit(1)
}
console.log('All assertions passed.')
