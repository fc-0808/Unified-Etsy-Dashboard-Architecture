'use strict'

/**
 * Regression tests — cached 4PX snapshot on the Orders list / Recently packaged.
 *
 * The packing bench must show the latest official 4PX event (tr.order.tracking.get)
 * from the persisted snapshot, never by calling 4PX per card. This suite locks:
 *   1. shapeForApi — 4PX parcels get a nested carrier_tracking object; others null.
 *   2. Attention vs normal lifecycle (fresh pre-transit is NOT attention).
 *   3. SQL chips — listCounts and filterSql agree, and are independent of each other.
 *   4. The orders route actually projects and strips the snapshot columns.
 *
 * Run: node scripts/test-carrier-tracking.js
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { initDb } = require('../src/db/setup')
const carrierTracking = require('../src/orders/carrier-tracking')

let failures = 0
function assert(cond, msg) {
	if (cond) console.log(`  ok  — ${msg}`)
	else {
		failures++
		console.error(`  FAIL — ${msg}`)
	}
}

const tmpPath = path.join(os.tmpdir(), `carrier-tracking-test-${process.pid}-${Date.now()}.db`)
const db = initDb(tmpPath)
const now = Math.floor(Date.now() / 1000)

console.log('4PX carrier-tracking snapshot (Orders / Recently packaged)\n')

db.prepare('INSERT INTO groups (group_id, label) VALUES (?,?)').run('g1', 'Group 1')
db.prepare('INSERT INTO shops (shop_id, group_id, shop_name) VALUES (?,?,?)').run('s1', 'g1', 'Shop One')

const seed = db.prepare(`
	INSERT INTO receipts (
		receipt_id, shop_id, group_id, name, status, is_paid, is_shipped,
		etsy_created_at, packaged_at, tracking_code, fourpx_consignment_no, fourpx_tracking_no,
		tracking_status, tracking_last_event, tracking_last_event_at, tracking_last_location,
		tracking_health, tracking_health_reason, tracking_is_disposed, tracking_checked_at,
		all_transactions
	) VALUES (
		@receipt_id, 's1', 'g1', @name, 'Paid', 1, 1,
		@created, @packaged, @tracking_code, @consignment, @fourpx_tracking_no,
		@status, @last_event, @last_event_at, @last_location,
		@health, @health_reason, @disposed, @checked_at,
		'[]'
	)
`)

const rows = [
	{
		receipt_id: 1,
		name: 'moving',
		created: now - 5 * 86400,
		packaged: now - 3600,
		tracking_code: '4PX3003150306784CN',
		consignment: 'C1',
		fourpx_tracking_no: '4PX3003150306784CN',
		status: 'in_transit',
		last_event: 'Shipment in transit',
		last_event_at: now - 3 * 3600,
		last_location: 'CN',
		health: 'ok',
		health_reason: null,
		disposed: 0,
		checked_at: now - 60,
	},
	{
		receipt_id: 2,
		name: 'awaiting',
		created: now - 2 * 86400,
		packaged: now - 1800,
		tracking_code: '4PX3003151201234CN',
		consignment: 'C2',
		fourpx_tracking_no: '4PX3003151201234CN',
		status: 'pre_transit',
		last_event: 'Parcel information received',
		last_event_at: now - 7200,
		last_location: null,
		health: 'ok',
		health_reason: null,
		disposed: 0,
		checked_at: now - 60,
	},
	{
		receipt_id: 3,
		name: 'stuck',
		created: now - 20 * 86400,
		packaged: now - 14 * 86400,
		tracking_code: '4PXSTUCK0001CN',
		consignment: 'C3',
		fourpx_tracking_no: '4PXSTUCK0001CN',
		status: 'in_transit',
		last_event: 'Held in customs',
		last_event_at: now - 12 * 86400,
		last_location: 'HONG KONG',
		health: 'critical',
		health_reason: 'No movement for 12 days.',
		disposed: 0,
		checked_at: now - 60,
	},
	{
		receipt_id: 4,
		name: 'disposed',
		created: now - 40 * 86400,
		packaged: now - 30 * 86400,
		tracking_code: '4PXDEAD0001CN',
		consignment: 'C4',
		fourpx_tracking_no: '4PXDEAD0001CN',
		status: 'exception',
		last_event: 'Parcel Disposal',
		last_event_at: now - 2 * 86400,
		last_location: 'US',
		health: 'critical',
		health_reason: 'Parcel disposed by carrier.',
		disposed: 1,
		checked_at: now - 60,
	},
	{
		receipt_id: 5,
		name: 'delayed',
		created: now - 18 * 86400,
		packaged: now - 10 * 86400,
		tracking_code: '4PXSLOW0001CN',
		consignment: 'C5',
		fourpx_tracking_no: '4PXSLOW0001CN',
		status: 'in_transit',
		last_event: 'Shipment arrived at facility and measured.',
		last_event_at: now - 6 * 86400,
		last_location: 'NANCHENG, CN',
		health: 'warning',
		health_reason: 'Slow transit.',
		disposed: 0,
		checked_at: now - 60,
	},
	{
		receipt_id: 6,
		name: 'delivered',
		created: now - 25 * 86400,
		packaged: now - 20 * 86400,
		tracking_code: '4PXDONE0001CN',
		consignment: 'C6',
		fourpx_tracking_no: '4PXDONE0001CN',
		status: 'delivered',
		last_event: 'Delivered',
		last_event_at: now - 86400,
		last_location: 'FLEMING ISLAND, FL',
		health: 'ok',
		health_reason: null,
		disposed: 0,
		checked_at: now - 60,
	},
	{
		receipt_id: 7,
		name: 'usps',
		created: now - 3 * 86400,
		packaged: now - 900,
		tracking_code: '9400111899223030000000',
		consignment: null,
		fourpx_tracking_no: null,
		status: null,
		last_event: null,
		last_event_at: null,
		last_location: null,
		health: null,
		health_reason: null,
		disposed: 0,
		checked_at: null,
	},
	{
		receipt_id: 8,
		name: 'unchecked-4px',
		created: now - 86400,
		packaged: now - 300,
		tracking_code: '4PXNEW0000001CN',
		consignment: 'C8',
		fourpx_tracking_no: '4PXNEW0000001CN',
		status: null,
		last_event: null,
		last_event_at: null,
		last_location: null,
		health: null,
		health_reason: null,
		disposed: 0,
		checked_at: null,
	},
	{
		receipt_id: 9,
		name: 'delivered-stale-health',
		created: now - 20 * 86400,
		packaged: now - 14 * 86400,
		tracking_code: '4PXDELSTALE0001CN',
		consignment: 'C9',
		fourpx_tracking_no: '4PXDELSTALE0001CN',
		status: 'delivered',
		last_event: 'Delivered. Position: Front door',
		last_event_at: now - 8 * 86400,
		last_location: 'CATONSVILLE, MD 21228, US',
		health: 'critical',
		health_reason: 'No carrier acceptance scan for 13 days after label creation.',
		disposed: 0,
		checked_at: now - 60,
	},
]
for (const r of rows) seed.run(r)

const byId = Object.fromEntries(db.prepare('SELECT * FROM receipts').all().map((r) => [r.receipt_id, r]))

assert(carrierTracking.shapeForApi(byId[7]) === null, 'non-4PX parcels do not pretend to have a 4PX snapshot')

const moving = carrierTracking.shapeForApi(byId[1])
assert(moving && moving.kind === 'moving' && moving.attention === false, 'healthy in-transit is moving, not attention')
assert(moving.last_event === 'Shipment in transit', 'latest event is the official trackingContent')
assert(moving.last_location === 'CN', 'latest location is preserved')
assert(moving.label === 'In transit', 'pill copy matches the parcel-route modal')

const awaiting = carrierTracking.shapeForApi(byId[2])
assert(awaiting && awaiting.kind === 'awaiting' && awaiting.attention === false, 'fresh pre-transit after packing is normal, not attention')
assert(awaiting.last_event === 'Parcel information received', 'forecast event still shows so the packer can see it')

const stuck = carrierTracking.shapeForApi(byId[3])
assert(stuck && stuck.attention === true && stuck.kind === 'stuck' && stuck.tone === 'critical', 'critical in-transit is stuck/attention')
assert(stuck.health_reason === 'No movement for 12 days.', 'health reason travels with the snapshot')

const disposed = carrierTracking.shapeForApi(byId[4])
assert(disposed && disposed.kind === 'disposed' && disposed.is_disposed === true, 'disposal flag wins the pill')

const delayed = carrierTracking.shapeForApi(byId[5])
assert(delayed && delayed.kind === 'delayed' && delayed.tone === 'warning' && delayed.attention === true, 'warning health is delayed/attention')

const delivered = carrierTracking.shapeForApi(byId[6])
assert(delivered && delivered.kind === 'delivered' && delivered.attention === false, 'delivered and healthy is not attention')

const deliveredStale = carrierTracking.shapeForApi(byId[9])
assert(deliveredStale && deliveredStale.kind === 'delivered' && deliveredStale.attention === false, 'delivered beats leftover critical health — not Attention/label-only')
assert(deliveredStale.last_event === 'Delivered. Position: Front door', 'latest event is the live delivery scan, not the stale forecast')

const unchecked = carrierTracking.shapeForApi(byId[8])
assert(unchecked && unchecked.kind === 'unchecked' && unchecked.attention === false, 'never-checked 4PX parcel is awaiting 4PX, not an alarm')

assert(carrierTracking.normalizeFilter('ATTENTION') === 'attention', 'tracking filter is case-insensitive')
assert(carrierTracking.normalizeFilter('nope') === 'all', 'unknown tracking filter fails open to all')
assert(carrierTracking.filterSql('all') === '1 = 1', 'all is unrestricted')

const extraWhere = `r.packaged_at IS NOT NULL AND r.status = 'Paid'`
const counts = carrierTracking.listCounts(db, { extraWhere })
assert(counts.total === 9, `total counts every sealed row (got ${counts.total})`)
assert(counts.attention === 3, `attention is stuck + disposed + delayed, not delivered-with-stale-health (got ${counts.attention})`)
assert(counts.moving === 1, `moving is healthy in-transit only (got ${counts.moving})`)
assert(counts.awaiting === 2, `awaiting is fresh pre-transit + unchecked 4PX, not USPS (got ${counts.awaiting})`)
assert(counts.delivered === 2, `delivered includes the healthy one and the stale-health one (got ${counts.delivered})`)
assert(counts.attention + counts.moving + counts.awaiting + counts.delivered === 8, '4PX chips partition 4PX parcels; All still counts every sealed row')

const attentionIds = db.prepare(`SELECT receipt_id FROM receipts r WHERE ${carrierTracking.filterSql('attention')} ORDER BY receipt_id`).all().map((r) => r.receipt_id)
assert(JSON.stringify(attentionIds) === JSON.stringify([3, 4, 5]), 'attention SQL matches stuck/disposed/delayed ids')

const movingIds = db.prepare(`SELECT receipt_id FROM receipts r WHERE ${carrierTracking.filterSql('moving')}`).all().map((r) => r.receipt_id)
assert(JSON.stringify(movingIds) === JSON.stringify([1]), 'moving SQL excludes delayed/stuck in-transit')

for (const field of carrierTracking.API_INTERNAL_FIELDS) {
	assert(carrierTracking.selectSql('r').includes(field), `selectSql projects ${field}`)
}

const serverSrc = fs.readFileSync(path.resolve(__dirname, '../src/server/index.js'), 'utf8')
assert(serverSrc.includes("require('../orders/carrier-tracking')"), 'GET /api/orders owns the snapshot through the shared module')
assert(serverSrc.includes('carrierTracking.selectSql'), 'the orders SELECT uses the module projection')
assert(serverSrc.includes('carrier_tracking: trackingSnap'), 'the payload exposes carrier_tracking, not raw columns')
assert(serverSrc.includes('tracking_counts: trackingCounts'), 'recently packaged returns tracking_counts for the chips')
assert(serverSrc.includes("req.query.tracking"), 'recently packaged accepts tracking=')
assert(serverSrc.includes('tracking_days: trackingDays'), 'Attention exposes packed-day counts for the current 4PX chip')
assert(serverSrc.includes('attachLiveTrackingSnapshot'), 'live parcel-route lookups persist back onto the receipt')
assert(serverSrc.includes('/api/4px/track/refresh-batch'), 'Attention can refresh the visible page through the shared 4PX worker')
assert(serverSrc.includes('alternateCodes: [known.tracking_code, known.fourpx_tracking_no]'), 'parcel-route lookups try both 4PX identifiers on the receipt')
assert(/tr\.order\.tracking\.get/.test(serverSrc) || /tr\.order\.tracking\.get/.test(fs.readFileSync(path.resolve(__dirname, '../src/orders/carrier-tracking.js'), 'utf8')), 'docs name the official 4PX method')

const workerSrc = fs.readFileSync(path.resolve(__dirname, '../src/workers/sync.js'), 'utf8')
assert(
	/WHEN r\.tracking_code LIKE '4PX%' THEN NULLIF\(TRIM\(r\.tracking_code\), ''\)[\s\S]{0,120}fourpx_tracking_no/.test(workerSrc),
	'the worker prefers the buyer-visible 4PX number over the dashboard label number',
)
assert(workerSrc.includes('alternateCodes: [order.tracking_code, order.fourpx_tracking_no]'), 'the worker still consults the other 4PX number when the first is forecast-only')

try {
	db.close()
} catch {}
try {
	fs.unlinkSync(tmpPath)
} catch {}

console.log(failures ? `\n${failures} failure(s)` : '\nAll carrier-tracking checks passed.')
process.exit(failures ? 1 : 0)
