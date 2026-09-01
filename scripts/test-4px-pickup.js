'use strict'

/**
 * Regression test — 4PX door-to-door pickup booking (揽收预约 / 新建预约).
 *
 * WHAT THIS FEATURE IS
 * ────────────────────────────────────────────────────────────────────────────
 * Sealing a parcel used to be the end of the line in this app: somebody still
 * had to open b.4px.com, find DSS → 揽收预约 → 新建预约, and book a driver by
 * hand. The packing screen now books it directly through the three methods 4PX
 * publishes (ds.xms.api.collect.create.order / .cancel.order / .print.order).
 *
 * WHY IT NEEDS A TEST OF ITS OWN
 * ────────────────────────────────────────────────────────────────────────────
 * Every failure mode here costs real money or real time and none of them are
 * visible from the screen:
 *   • A double booking sends a second van and confuses the hand-over. The
 *     create method takes NO client idempotency key, so the guard is entirely
 *     ours and has to be proven.
 *   • A lost response must never lose the booking — an unacknowledged call has
 *     to end as an auditable 'unknown', not as nothing.
 *   • `reserve_time` is a bare calendar date read in the PICKUP's timezone. A
 *     server-clock "today" books a driver into yesterday whenever the two zones
 *     disagree, which is most of the working day for a non-CN host.
 *   • A rejected address is only fixable if the error names the field.
 *
 * WHAT IS COVERED
 *   1. The calendar: timezone-correct "today", window bounds, real dates only.
 *   2. pickup_info: required fields, documented lengths, aliases, phone sanity,
 *      and that every rejection names the field the operator must fix.
 *   3. The wire payload and response readers for all three methods.
 *   4. create is never retried and reports an uncertain outcome as uncertain.
 *   5. The outbox ledger against the REAL schema: write-before-call, resolve,
 *      attach, cancel-releases-parcels, crash recovery, no double-book.
 *   6. Which sealed parcels count as awaiting a driver (all four conditions).
 *   7. Printing the appointment form: it renders to the printer's dot grid as a
 *      label, and a form that is not label-shaped is refused, not shrunk.
 *   8. Access control: the routes are gated and a packer can do the job.
 *   9. The page and config are actually wired to all of the above.
 *
 * No network is touched: the signed client is stubbed in the require cache.
 *
 * Run: `node scripts/test-4px-pickup.js` (or `npm run test:4px-pickup`)
 * Exit code 0 = all assertions pass, 1 = a regression was detected.
 */

const os = require('os')
const path = require('path')
const fs = require('fs')

// ── Stub the signed 4PX client BEFORE collect.js captures it ─────────────────
// collect.js destructures `callApi` at module load, so the stub has to be in
// place first. Doing it this way (rather than injecting a client) keeps the
// production module free of test seams.
const apiPath = require.resolve('../src/fourpx/api')
const collectPath = require.resolve('../src/fourpx/collect')
const realApi = require(apiPath)
const calls = []
let nextReply = () => ({ collect_no: 'C000000001' })
realApi.callApi = (appKey, appSecret, method, body, options) => {
	calls.push({ appKey, appSecret, method, body, options })
	return Promise.resolve().then(() => nextReply({ method, body }))
}
delete require.cache[collectPath]
const collect = require(collectPath)

const {
	initDb,
	FOURPX_PICKUP_BLOCKING_STATUSES,
	openFourpxPickupAppointment,
	resolveFourpxPickupAppointment,
	attachFourpxPickupParcels,
	setFourpxPickupFormUrl,
	cancelFourpxPickupAppointment,
	getFourpxPickupAppointment,
	findActiveFourpxPickupAppointment,
	pruneStaleFourpxPickupAppointments,
	listFourpxPickupAppointments,
	listParcelsAwaitingFourpxPickup,
} = require('../src/db/setup')

let failures = 0
function assert(cond, msg) {
	if (cond) {
		console.log(`  ok  — ${msg}`)
	} else {
		failures++
		console.error(`  FAIL — ${msg}`)
	}
}
function section(title) {
	console.log(`\n  ${title}`)
}
/** Run `fn` and return the error it threw (or null). */
function caught(fn) {
	try {
		fn()
		return null
	} catch (err) {
		return err
	}
}

const NOW = 1_800_000_000 // fixed clock (epoch seconds)
const DAY = 24 * 3600
const TX = JSON.stringify([{ title: 'Kawaii Frog MAGSAFE Case', listing_id: 555, quantity: 1, variations: [] }])

/** A complete, valid pickup address — the happy path everything else varies. */
const ADDRESS = Object.freeze({
	name: '张衍丰',
	phone: '13058082917',
	country: 'CN',
	province: '广东省',
	city: '深圳市',
	district: '福田区',
	detail_address: '振华路与上步中路交汇处(燕南地铁站B口步行190米) 滨江爱义南方大厦',
})

console.log('4PX pickup booking (揽收预约) regression test')

// ── 1. The calendar ─────────────────────────────────────────────────────────
section('The pickup calendar is read in the PICKUP address’s timezone, not the server’s')
{
	// 2026-08-20 16:30 UTC — already the 21st in Shanghai, still the 20th in
	// New York. This is the off-by-one that books a driver into yesterday.
	const evening = Date.parse('2026-08-20T16:30:00Z')
	assert(collect.todayInTimeZone('Asia/Shanghai', evening) === '2026-08-21', 'a UTC evening is already tomorrow in Shanghai')
	assert(collect.todayInTimeZone('America/New_York', evening) === '2026-08-20', '…and still today in New York')
	assert(collect.todayInTimeZone(undefined, evening) === '2026-08-21', 'the default zone is Asia/Shanghai, where 4PX’s CN pickup network runs')

	// Calendar arithmetic must not drift across month ends or a host DST jump.
	assert(collect.addDaysToIsoDate('2026-08-31', 1) === '2026-09-01', 'adding a day crosses a month end')
	assert(collect.addDaysToIsoDate('2026-12-31', 1) === '2027-01-01', '…and a year end')
	assert(collect.addDaysToIsoDate('2026-03-08', 1) === '2026-03-09', '…and a US DST-transition day, without dropping or repeating it')
	assert(collect.daysBetweenIsoDates('2026-08-20', '2026-08-27') === 7, 'whole-day differences are exact')
	assert(collect.daysBetweenIsoDates('2026-08-27', '2026-08-20') === -7, '…and signed, so a past date is negative')
	assert(collect.weekdayForIsoDate('2026-08-20') === 'Thursday', 'the weekday matches 4PX’s own picker (2026-08-20 星期四)')

	const opts = { timeZone: 'Asia/Shanghai', nowMs: evening, maxDaysAhead: 14 }
	const dates = collect.listReserveDateOptions(opts)
	assert(dates.length === 14, 'the window offers exactly max_days_ahead options')
	assert(dates[0].date === '2026-08-21' && dates[0].isToday === true, 'the first option is today at the pickup address')
	assert(dates[13].date === '2026-09-03', '…and the last is 13 days later')
	assert(
		dates.every((d, i) => d.offset === i && /^\d{4}-\d{2}-\d{2}$/.test(d.date) && !!d.weekday),
		'every option carries an ISO date, its offset, and a weekday',
	)

	assert(collect.normalizeMaxDaysAhead(0) === 1, 'a window of 0 days is clamped to 1 — the dialog can never be empty')
	assert(collect.normalizeMaxDaysAhead(9999) === collect.MAX_DAYS_AHEAD_CEILING, '…and a typo cannot render thousands of options')
	assert(collect.normalizeMaxDaysAhead('abc') === collect.DEFAULT_MAX_DAYS_AHEAD, '…and junk falls back to the default')

	assert(collect.normalizeAwaitingDays(undefined) === collect.DEFAULT_AWAITING_DAYS, 'the awaiting-parcel lookback defaults to a week')
	assert(collect.normalizeAwaitingDays(0) === 1 && collect.normalizeAwaitingDays(1e6) === collect.MAX_AWAITING_DAYS, '…and is clamped at both ends')
}

section('A date 4PX would reject is refused here, with a message that says what to do')
{
	const opts = { timeZone: 'Asia/Shanghai', nowMs: Date.parse('2026-08-20T02:00:00Z'), maxDaysAhead: 14 }
	assert(collect.assertReserveDate('2026-08-20', opts) === '2026-08-20', 'today is bookable')
	assert(collect.assertReserveDate('  2026-08-27  ', opts) === '2026-08-27', 'a padded date is accepted and trimmed')
	assert(collect.assertReserveDate('2026-09-02', opts) === '2026-09-02', 'the last day of the window is bookable')

	const past = caught(() => collect.assertReserveDate('2026-08-19', opts))
	assert(past && past.status === 400 && past.field === 'reserve_date', 'yesterday is refused as an operator-fixable error on the date field')
	assert(past && /already passed/.test(past.message), '…and the message says the date has passed')

	const beyond = caught(() => collect.assertReserveDate('2026-09-03', opts))
	assert(beyond && /2026-09-02/.test(beyond.message), 'a date past the window names the latest bookable day')

	assert(caught(() => collect.assertReserveDate('', opts))?.field === 'reserve_date', 'a missing date is refused')
	assert(caught(() => collect.assertReserveDate('20/08/2026', opts))?.field === 'reserve_date', 'a non-ISO date is refused')
	assert(caught(() => collect.assertReserveDate('2026-02-31', opts))?.field === 'reserve_date', 'a date-shaped impossibility (2026-02-31) is refused')
}

// ── 2. The pickup address ───────────────────────────────────────────────────
section('pickup_info is validated to 4PX’s documented schema before anything is spent')
{
	const clean = collect.normalizePickupInfo(ADDRESS)
	assert(clean.name === ADDRESS.name && clean.detail_address === ADDRESS.detail_address, 'a complete address passes through unchanged')
	assert(!('zip_code' in clean) && !('street' in clean), 'blank optional fields are omitted, never sent as "" (4PX rejects an empty supplied value)')

	const messy = collect.normalizePickupInfo({ ...ADDRESS, detail_address: '  Line one\n  Line two\t\tunit 3  ' })
	assert(messy.detail_address === 'Line one Line two unit 3', 'a multi-line address pasted from a spreadsheet is collapsed to one line')

	// config.json is hand-written, so the spellings a human would reach for work.
	const aliased = collect.normalizePickupInfo({
		contact_name: 'Zhang Yanfeng',
		mobile: '13058082917',
		country_code: 'CN',
		state: '广东省',
		city_name: '深圳市',
		area: '福田区',
		address: '滨江爱义南方大厦',
		postcode: '518000',
	})
	assert(aliased.name === 'Zhang Yanfeng' && aliased.phone === '13058082917', 'contact_name / mobile aliases are honoured')
	assert(aliased.province === '广东省' && aliased.district === '福田区' && aliased.detail_address === '滨江爱义南方大厦', 'state / area / address aliases are honoured')
	assert(aliased.zip_code === '518000', 'postcode alias is honoured')

	for (const field of ['name', 'phone', 'country', 'province', 'city', 'district', 'detail_address']) {
		const err = caught(() => collect.normalizePickupInfo({ ...ADDRESS, [field]: '' }))
		assert(err && err.status === 400 && err.field === field, `a missing ${field} is refused and names ${field}, so the dialog can focus it`)
	}
	assert(collect.normalizePickupInfo({ ...ADDRESS, street: '', zip_code: '' }), 'street and postcode stay optional')

	const long = caught(() => collect.normalizePickupInfo({ ...ADDRESS, province: 'x'.repeat(21) }))
	assert(long && long.field === 'province' && /at most 20/.test(long.message), 'an over-long value is REJECTED, not truncated — a shortened address is a driver at the wrong door')

	const badPhone = caught(() => collect.normalizePickupInfo({ ...ADDRESS, phone: '(0) --' }))
	assert(badPhone && badPhone.field === 'phone', 'a phone with no real digits is refused here, not by an opaque 4PX "invalid contact"')

	// Config load must warn, never abort: the packer can complete the address in
	// the dialog, and refusing to boot over a pre-fill would take the whole
	// dashboard down with it.
	const partial = collect.normalizePickupInfo({ city: '深圳市' }, { partial: true })
	assert(partial.pickup.city === '深圳市' && partial.problems.length >= 6, 'partial mode collects problems instead of throwing')
	assert(collect.normalizePickupInfo(null, { partial: true }).problems.length > 0, '…and reports a missing block the same way')

	assert(collect.normalizeCancelReason('  a  b  ') === 'a b', 'a cancellation reason is cleaned')
	assert(collect.normalizeCancelReason('x'.repeat(200)).length === collect.MAX_CANCEL_REASON_LENGTH, '…and capped to what 4PX accepts')
	assert(collect.normalizeCancelReason(null) === '', '…and an absent reason is simply empty')
}

// ── 3. The wire format ──────────────────────────────────────────────────────
section('The request bodies match the published schemas exactly')
{
	const payload = collect.buildCreateOrderPayload({ reserveDate: '2026-08-20', pickup: collect.normalizePickupInfo(ADDRESS) })
	assert(Object.keys(payload).join(',') === 'reserve_time,pickup_info', 'create sends exactly reserve_time + pickup_info')
	assert(payload.reserve_time === '2026-08-20', 'reserve_time is the bare calendar date, with no time or zone bolted on')
	assert(payload.pickup_info.detail_address === ADDRESS.detail_address, 'the address is nested under pickup_info')

	assert(collect.COLLECT_METHODS.createOrder === 'ds.xms.api.collect.create.order', 'the create method name is the documented one')
	assert(collect.COLLECT_METHODS.cancelOrder === 'ds.xms.api.collect.cancel.order', '…and cancel')
	assert(collect.COLLECT_METHODS.printOrder === 'ds.xms.api.collect.print.order', '…and print')
	assert(collect.COLLECT_API_VERSION === '1.0.0', 'all three ride API version 1.0.0')
}

section('Responses are read the way 4PX actually sends them')
{
	assert(collect.normalizeCollectCreateResponse({ collect_no: '2021081600000003' }) === '2021081600000003', 'the documented create shape yields the appointment number')
	assert(collect.normalizeCollectCreateResponse({ collectOrderNo: 'C9' }) === 'C9', '…and so do the aliases the docs use inconsistently across methods')
	assert(collect.normalizeCollectCreateResponse(' C7 ') === 'C7', '…and a bare string')
	const noNo = caught(() => collect.normalizeCollectCreateResponse({}))
	assert(noNo && noNo.code === 'PICKUP_NO_COLLECT_NO' && /portal/.test(noNo.message), 'an accepted booking with no number is loud, and tells the operator to check the portal before rebooking')

	assert(collect.normalizeCollectPrintResponse('http://x/y.pdf') === 'http://x/y.pdf', 'the print method’s bare-URL response is read')
	assert(collect.normalizeCollectPrintResponse({ url: 'http://x/y.pdf' }) === 'http://x/y.pdf', '…and the object form')
	assert(collect.normalizeCollectPrintResponse({}) === null, '…and "not ready yet" is null, not an exception')
}

// ── 4. Calling behaviour ────────────────────────────────────────────────────
section('A booking is attempted exactly once, and an unclear outcome is reported as unclear')
;(async () => {
	calls.length = 0
	nextReply = () => ({ collect_no: 'C123' })
	const created = await collect.createCollectOrder('KEY', 'SECRET', { reserveDate: '2026-08-20', pickup: collect.normalizePickupInfo(ADDRESS) })
	assert(created.collectNo === 'C123', 'a successful create returns the appointment number')
	assert(calls.length === 1, 'exactly one API call is made — a replay would dispatch a second driver')
	assert(calls[0].method === collect.COLLECT_METHODS.createOrder && calls[0].options.version === '1.0.0', '…to the create method at v1.0.0')

	// A timeout / reset: 4PX may or may not have booked it. api.js only attaches
	// `code` to business rejections, so a bare error means "we do not know".
	nextReply = () => {
		throw new Error('socket hang up')
	}
	let uncertain = null
	try {
		await collect.createCollectOrder('KEY', 'SECRET', { reserveDate: '2026-08-20', pickup: collect.normalizePickupInfo(ADDRESS) })
	} catch (err) {
		uncertain = err
	}
	assert(uncertain && uncertain.code === 'PICKUP_CREATE_UNCERTAIN', 'a transport failure is flagged uncertain, never assumed to have failed')
	assert(uncertain && uncertain.payload && uncertain.payload.reserve_time === '2026-08-20', '…and carries the payload, so the log says what may have been booked')

	// A business rejection is definite: 4PX evaluated it and said no.
	nextReply = () => {
		const err = new Error('The pickup area is not serviced')
		err.code = 'S001'
		throw err
	}
	let rejected = null
	try {
		await collect.createCollectOrder('KEY', 'SECRET', { reserveDate: '2026-08-20', pickup: collect.normalizePickupInfo(ADDRESS) })
	} catch (err) {
		rejected = err
	}
	assert(rejected && rejected.code === 'S001', 'a business rejection keeps its 4PX error code and is NOT relabelled uncertain')

	calls.length = 0
	nextReply = () => ({})
	const cancelled = await collect.cancelCollectOrder('KEY', 'SECRET', ' C123 ', { reason: '  changed plan  ' })
	assert(cancelled.collectNo === 'C123', 'cancel trims the appointment number')
	assert(calls[0].body.collect_no === 'C123', '…and sends it as collect_no')
	assert(calls[0].body.cancel_remark === 'changed plan' && calls[0].body.cancel_reason === 'changed plan', 'both documented spellings of the reason field are sent, because the docs disagree with themselves')
	await collect.cancelCollectOrder('K', 'S', '').then(
		() => assert(false, 'cancel without an appointment number is refused'),
		(err) => assert(err.field === 'collect_no', 'cancel without an appointment number is refused'),
	)

	calls.length = 0
	nextReply = () => 'http://label.4px.com/pickup/C123.pdf'
	const printed = await collect.printCollectOrder('KEY', 'SECRET', 'C123')
	assert(printed.pdfUrl === 'http://label.4px.com/pickup/C123.pdf', 'print returns the form URL')
	assert(Array.isArray(calls[0].body.collect_order_no), 'print sends collect_order_no as a list, as documented')
	await collect.printCollectOrder('K', 'S', []).then(
		() => assert(false, 'print with no appointment number is refused'),
		(err) => assert(err.field === 'collect_no', 'print with no appointment number is refused'),
	)
})()
	.then(runLedgerTests)
	.catch((err) => {
		failures++
		console.error(`  FAIL — the async section threw: ${err.stack}`)
		finish()
	})

// ── 5–9. The ledger, printing, access control, and the wiring ───────────────
// Async because rasterizing the appointment form is: the render is the one part
// of the print path that can be exercised without a printer attached.
async function runLedgerTests() {
	const tmpPath = path.join(os.tmpdir(), `4px-pickup-test-${process.pid}-${Date.now()}.db`)
	const db = initDb(tmpPath)
	try {
		seed(db)

		section('The booking is written down BEFORE 4PX is called, so a crash cannot lose it')
		{
			const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('fourpx_pickup_appointments','fourpx_pickup_appointment_orders')").all()
			assert(tables.length === 2, 'initDb creates the appointment ledger and its parcel join table')

			const id = openFourpxPickupAppointment(db, { reserveDate: '2026-08-20', pickup: collect.normalizePickupInfo(ADDRESS), createdBy: 'ivy' })
			const row = getFourpxPickupAppointment(db, { id })
			assert(row.status === 'submitting' && row.collect_no === null, 'the reserved row exists before the call, with no appointment number yet')
			assert(row.contact_phone === ADDRESS.phone && row.district === ADDRESS.district, '…and records the exact address that was submitted')
			assert(row.created_by === 'ivy', '…and who booked it')
			assert(FOURPX_PICKUP_BLOCKING_STATUSES.includes('submitting'), 'an in-flight booking already blocks a second one for the same day')

			resolveFourpxPickupAppointment(db, id, { status: 'submitted', collectNo: 'C2026082001' })
			const done = getFourpxPickupAppointment(db, { id })
			assert(done.status === 'submitted' && done.collect_no === 'C2026082001', 'the answer from 4PX resolves the same row')
			assert(getFourpxPickupAppointment(db, { collectNo: 'C2026082001' }).id === id, '…and is findable by appointment number')

			const dupe = caught(() => resolveFourpxPickupAppointment(db, openFourpxPickupAppointment(db, { reserveDate: '2026-08-25', pickup: {} }), { status: 'submitted', collectNo: 'C2026082001' }))
			assert(dupe !== null, 'the same 4PX appointment number cannot be recorded twice')

			assert(caught(() => resolveFourpxPickupAppointment(db, id, { status: 'nonsense' })) !== null, 'an unknown status is refused rather than silently stored')
		}

		section('A second driver is never dispatched for a day that already has one')
		{
			const active = findActiveFourpxPickupAppointment(db, '2026-08-20')
			assert(active && active.collect_no === 'C2026082001', 'the booked day reports its live appointment — this is the duplicate guard')
			assert(findActiveFourpxPickupAppointment(db, '2026-08-21') === null, 'an unbooked day is free')

			const failedId = openFourpxPickupAppointment(db, { reserveDate: '2026-08-22', pickup: {} })
			resolveFourpxPickupAppointment(db, failedId, { status: 'failed', errorMessage: 'The pickup area is not serviced' })
			assert(findActiveFourpxPickupAppointment(db, '2026-08-22') === null, 'a definitively rejected booking does NOT block a retry')

			const unknownId = openFourpxPickupAppointment(db, { reserveDate: '2026-08-23', pickup: {} })
			resolveFourpxPickupAppointment(db, unknownId, { status: 'unknown', errorMessage: 'socket hang up' })
			assert(findActiveFourpxPickupAppointment(db, '2026-08-23') !== null, 'an UNCERTAIN booking does block — "maybe booked" is treated as booked so a human checks the portal')
		}

		section('A crash mid-call leaves an auditable record, not an in-flight request forever')
		{
			const orphanId = openFourpxPickupAppointment(db, { reserveDate: '2026-08-24', pickup: {} })
			db.prepare('UPDATE fourpx_pickup_appointments SET created_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 3600, orphanId)

			assert(pruneStaleFourpxPickupAppointments(db) === 1, 'a stale submitting row is reaped')
			const orphan = getFourpxPickupAppointment(db, { id: orphanId })
			assert(orphan.status === 'unknown' && /portal/.test(orphan.error_message), '…demoted to unknown with an instruction a human can act on')
			assert(orphan.resolved_at != null, '…and stamped as resolved')
			assert(pruneStaleFourpxPickupAppointments(db) === 0, 'reaping is idempotent')

			const fresh = openFourpxPickupAppointment(db, { reserveDate: '2026-08-26', pickup: {} })
			pruneStaleFourpxPickupAppointments(db)
			assert(getFourpxPickupAppointment(db, { id: fresh }).status === 'submitting', 'a genuinely in-flight booking is left alone')
			resolveFourpxPickupAppointment(db, fresh, { status: 'failed', errorMessage: 'cleanup' })
		}

		section('Which sealed parcels are still waiting for a driver')
		{
			const awaiting = listParcelsAwaitingFourpxPickup(db)
			const ids = awaiting.map((p) => p.receipt_id)
			assert(ids.includes(3001) && ids.includes(3002), 'a sealed parcel with a 4PX label and no carrier scan is awaiting pickup')
			assert(!ids.includes(3003), 'an unsealed order is not — there is nothing to hand over yet')
			assert(!ids.includes(3004), 'a parcel 4PX has already scanned is not — it is in the network, a pickup is moot')
			assert(!ids.includes(3005), 'a sealed order with no 4PX label is not — the driver has nothing to collect')
			assert(!ids.includes(3006), 'a cancelled order is never awaiting a pickup')
			assert(!ids.includes(3007), 'an order whose 4PX label was cancelled is not either')
			assert(awaiting[0].receipt_id === 3001, 'the oldest sealed parcel is reported first, so the bar can say how long it has waited')
			assert(awaiting[0].tracking_no === '4PXTEST3001', '…with the tracking number the driver will scan')

			// The bug a live database exposes: carrier_confirmed_at is only ever set
			// by a successful tracking lookup, so a parcel handed over months ago
			// whose tracking never resolved reads as unscanned forever. Counting
			// those made the bar claim 37 parcels were waiting on an empty bench.
			assert(!ids.includes(3008), 'a parcel sealed months ago is NOT waiting for today’s van — it left long ago and only reads as unscanned because tracking never resolved')
			assert(
				listParcelsAwaitingFourpxPickup(db, { withinDays: 90 })
					.map((p) => p.receipt_id)
					.includes(3008),
				'…and a wider window still finds it, so the bound is a policy and not a silent filter',
			)
			assert(listParcelsAwaitingFourpxPickup(db, { withinDays: 0 }).length <= awaiting.length, 'a nonsensical window is clamped instead of returning everything')
		}

		section('Booking claims the parcels; cancelling gives them back')
		{
			const awaiting = listParcelsAwaitingFourpxPickup(db)
			const id = openFourpxPickupAppointment(db, { reserveDate: '2026-08-27', pickup: collect.normalizePickupInfo(ADDRESS) })
			resolveFourpxPickupAppointment(db, id, { status: 'submitted', collectNo: 'C2026082701' })
			const n = attachFourpxPickupParcels(db, id, awaiting)
			assert(n === awaiting.length && getFourpxPickupAppointment(db, { id }).parcel_count === n, 'the parcels booked for are attached and counted')
			assert(attachFourpxPickupParcels(db, id, awaiting) === n, 're-attaching is idempotent, so a replayed write cannot inflate the count')
			assert(listParcelsAwaitingFourpxPickup(db).length === 0, 'an attached parcel stops counting as awaiting — no second booking for the same parcels')

			setFourpxPickupFormUrl(db, id, 'http://label.4px.com/pickup/C2026082701.pdf')
			assert(getFourpxPickupAppointment(db, { id }).form_url.endsWith('.pdf'), 'the appointment-form URL is cached, so reprinting costs no API call')

			const listed = listFourpxPickupAppointments(db, { limit: 20 }).find((r) => r.id === id)
			assert(listed && listed.parcels.length === n, 'the history lists an appointment with its parcels')
			assert(listFourpxPickupAppointments(db, { limit: 1 }).length === 1, '…and respects the limit')

			cancelFourpxPickupAppointment(db, id, { by: 'ivy', reason: 'driver came early' })
			const cancelled = getFourpxPickupAppointment(db, { id })
			assert(cancelled.status === 'cancelled' && cancelled.cancelled_by === 'ivy' && cancelled.cancel_reason === 'driver came early', 'a cancellation is recorded with who and why')
			assert(cancelled.parcel_count === 0, '…and stops claiming parcels')
			assert(listParcelsAwaitingFourpxPickup(db).length === n, 'the parcels are awaiting a driver again — a cancelled pickup must not hide them')
			assert(findActiveFourpxPickupAppointment(db, '2026-08-27') === null, '…and the day is bookable again')
		}

		section('The form the driver scans prints in one tap, on the label printer')
		{
			const sharp = require('sharp')
			const { renderLabelBitmap, MIN_HEALTHY_COVERAGE_PCT } = require('../src/fourpx/label-print')

			// 4PX issues 打印预约单 as a 95 x 95 mm square whose content is a Code128
			// of the appointment number. That is a LABEL, not an office document, so
			// it goes through the same 1-bit crisp-barcode render as a shipping
			// label: 80 mm at 203 dpi = 639 dots, every bar on a whole printer dot.
			const square = await renderLabelBitmap(squarePdf(269.29), { widthMm: 80, heightMm: 80, dpi: 203 })
			assert(square.width === 639 && square.height === 639, 'the form is rasterized to the printer’s exact dot grid, so the barcode stays scannable')
			assert(square.coveragePct === 100, '…and a square form on square stock fills the label completely')
			const meta = await sharp(square.png).metadata()
			assert(meta.width === 639 && meta.format === 'png', '…as a PNG the GDI print path can draw 1:1')
			const ink = await sharp(square.png).stats()
			assert(ink.channels[0].min === 0 && ink.channels[0].max === 255, 'the render is pure black and white — a thresholded barcode, not anti-aliased grey')

			// The guard that matters if 4PX ever changes the form: an A4 page
			// letterboxed onto label stock is a barcode nobody can scan.
			const a4 = await renderLabelBitmap(minimalPdf(1), { widthMm: 80, heightMm: 80, dpi: 203 })
			assert(a4.coveragePct < MIN_HEALTHY_COVERAGE_PCT, 'a form that is NOT label-shaped scores below the healthy coverage bar, which is what makes the server refuse to print it')
		}

		section('Only the people who seal parcels can book the van')
		{
			const policy = require('../src/auth/policy')
			assert(policy.CAPABILITIES['shipping:pickup'], 'the capability exists and is documented')
			assert(policy.requiredCapability('GET', '/api/4px/pickup/options') === 'shipping:pickup', 'the options endpoint is gated')
			assert(policy.requiredCapability('GET', '/api/4px/pickup/appointments') === 'shipping:pickup', 'the history endpoint is gated')
			assert(policy.requiredCapability('POST', '/api/4px/pickup/appointments') === 'shipping:pickup', 'booking is gated')
			assert(policy.requiredCapability('POST', '/api/4px/pickup/appointments/12/cancel') === 'shipping:pickup', 'cancelling is gated')
			assert(policy.requiredCapability('GET', '/api/4px/pickup/appointments/12/form') === 'shipping:pickup', 'the appointment form is gated')
			assert(policy.requiredCapability('POST', '/api/4px/pickup/appointments/12/print') === 'shipping:pickup', '…and so is printing it, which moves paper on the bench PC')

			assert(policy.roleCan('packer', 'shipping:pickup'), 'a packer can book a pickup — it is part of the packing job')
			assert(policy.roleCan('owner', 'shipping:pickup'), 'the owner can too')
			assert(!policy.roleCan('shopper', 'shipping:pickup'), 'a shopper cannot spend a pickup')
			assert(policy.authorizeApi('shopper', 'POST', '/api/4px/pickup/appointments').allowed === false, '…and is refused by the request authorizer, not just the UI')
			assert(policy.authorizeApi('packer', 'POST', '/api/4px/pickup/appointments').allowed === true, '…while a packer is allowed through')
		}

		section('The server, the page and the config are actually wired to all of this')
		{
			const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'index.js'), 'utf8')
			assert(/_pickupBookInFlight/.test(server), 'the booking route single-flights by date, so a double-tap cannot pass the duplicate check twice')
			assert(/acquireLock\(db, lockKey/.test(server), '…and takes a cross-process lock, so two dashboard processes cannot either')
			assert(/findActiveFourpxPickupAppointment\(db, reserveDate\)/.test(server), '…and refuses a day that already has a live appointment')
			assert(/openFourpxPickupAppointment\([\s\S]{0,400}?createCollectOrder/.test(server), 'the outbox row is opened BEFORE the API call')
			assert(/uncertain \? 'unknown' : 'failed'/.test(server), '…and an uncertain outcome is stored as unknown, not failed')
			assert(/allow_duplicate/.test(server), 'a deliberate second van is possible, but only as an explicit choice')
			assert(/withTransientRetry\(\(\) => fourpxCollect\.printCollectOrder/.test(server), 'the form fetch — a pure read — may be retried')
			assert(!/withTransientRetry\([^)]{0,80}createCollectOrder/.test(server), 'the booking call is NEVER retried')
			assert(/Content-Type', 'application\/pdf'/.test(server), 'the appointment form is proxied as a PDF (4PX serves it over plain HTTP, which the browser would block)')
			assert(/app\.post\('\/api\/4px\/pickup\/appointments\/:id\/print'/.test(server), 'the form can also be printed outright, in one request')
			assert(/loadPickupFormPdf\(id\)[\s\S]{0,4000}loadPickupFormPdf\(id\)/.test(server), '…from the same resolver as the read path, so the two cannot disagree about which form this is')
			assert(
				/\/print'[\s\S]{0,3000}renderLabelBitmap\(buffer, \{[\s\S]{0,200}widthMm: config\.label_width_mm/.test(server),
				'…and prints it through the crisp 1-bit LABEL path on the label printer, because 4PX issues the form as a 95 mm square barcode',
			)
			assert(/coveragePct < MIN_HEALTHY_COVERAGE_PCT\) \{[\s\S]{0,1200}PICKUP_FORM_NOT_LABEL_SHAPED/.test(server), 'a form that is not label-shaped is refused rather than shrunk into an unscannable barcode')
			assert(/PICKUP_FORM_PRINT_DEDUPED/.test(server), 'a double-tap is answered, not obeyed with a second label')
			assert(/printErr\.printerNotReady\)[\s\S]{0,160}503/.test(server), 'an offline / jammed / label-less printer is a 503 the operator can act on')
			assert(/mode === 'silent'\)[\s\S]{0,200}PICKUP_FORM_PRINT_FAILED/.test(server), '…and silent mode never degrades into opening a PDF nobody is looking at')
			assert(/_recordPrinted\(_pickupFormPrintedAt/.test(server), 'the dedupe stamp expires, so the map does not grow for the life of the server')

			const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')
			assert(/id="pickupBar"[^>]*data-cap="shipping:pickup"/.test(page), 'the packing screen carries the pickup bar, gated by the capability')
			assert(/id="pickupModal"/.test(page) && /id="pickupDate"/.test(page), '…and the 新建预约 dialog with its date picker')
			// Every documented pickup_info key must be bound to an input, or a
			// driver is dispatched with a field 4PX needed left blank.
			const unbound = collect.PICKUP_FIELDS.filter((f) => !new RegExp(`${f.key}: 'pickup[A-Za-z]+'`).test(page))
			assert(unbound.length === 0, `every documented pickup_info field is bound to an input${unbound.length ? ` (missing: ${unbound.map((f) => f.key).join(', ')})` : ''}`)
			assert(/PICKUP\.sync\(\)/.test(page), 'the bar is refreshed by the orders view')
			assert(/const PICKUP = \(\(\) =>/.test(page), '…from a self-contained module')
			assert(/textContent = a\.collect_no|no\.textContent = a\.collect_no/.test(page), 'appointment numbers are rendered as text, never as interpolated markup')
			assert(/PICKUP_ALREADY_BOOKED/.test(page), 'the page understands the duplicate answer and re-reads state instead of just showing an error')
			assert(/may or may not have been booked/.test(page), '…and tells the operator plainly when the outcome is unknown')
			assert(/id="pickupSuccessPrintBtn"[^>]*onclick="PICKUP\.printForm\(null, this\)"/.test(page), 'the booking confirmation prints the form in one tap — the next real step, on the button the keyboard lands on')
			assert(/id="pickupPrintBtn"/.test(page) && /id="pickupFormBtn"/.test(page), 'the bar can print the form, and still open it as a PDF for reading or saving')
			assert(/appointments\/' \+ encodeURIComponent\(appointmentId\) \+ '\/print'/.test(page), 'printing goes through the server, which owns the printer')
			assert(/printing\.has\(appointmentId\)/.test(page), '…and a second tap while the job is in flight is a no-op, not a second sheet')
			assert(/openForm, printForm/.test(page), 'both actions are on the module’s public surface')
			assert(/setTimeout\(\(\) => controller\.abort\(\), 90_000\)/.test(page), 'the request outlives a slow 4PX fetch plus a rasterize plus the spooler, so the browser does not blame the printer for its own timeout')

			const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'config', 'schema.js'), 'utf8')
			assert(/fourpx_pickup:\s*normalizeFourpxPickup\(raw\.fourpx_pickup\)/.test(schema), 'config normalizes the default pickup address')
			assert(/fourpx_pickup_timezone:\s*normalizeFourpxPickupTimezone/.test(schema), '…and validates the timezone at load, so a bad zone is not a 500 at the bench')
			assert(/normalizeMaxDaysAhead\(raw\.fourpx_pickup_max_days_ahead\)/.test(schema), '…and clamps the bookable window')
			assert(/normalizeAwaitingDays\(raw\.fourpx_pickup_awaiting_days\)/.test(schema), '…and the awaiting-parcel lookback')
			assert(/withinDays: config\.fourpx_pickup_awaiting_days/.test(server), 'the server scopes "awaiting a driver" to that lookback, in both the options and booking paths')
			assert(/within_days: fourpxCollect\.normalizeAwaitingDays/.test(server), '…and reports the window it used, so the page can say what it counted')

			assert(!/pickup_form_printer_name/.test(schema), 'the form needs NO printer settings of its own — it is a label, and a second printer to misconfigure would only be a second thing to get wrong')

			const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.example.json'), 'utf8'))
			assert('fourpx_pickup' in example && 'fourpx_pickup_booking' in example, 'config.example.json documents the pickup block')
			assert(example.fourpx_pickup_timezone === collect.DEFAULT_PICKUP_TIMEZONE, '…with the default timezone')
			assert(example.fourpx_pickup_max_days_ahead === collect.DEFAULT_MAX_DAYS_AHEAD, '…and the default window')
			assert(example.fourpx_pickup_awaiting_days === collect.DEFAULT_AWAITING_DAYS, '…and the default lookback')
			assert(/95 x 95 mm/.test(example._pickup_form_print_comment || ''), '…and explains, where an operator will look for it, that the form prints on label stock')
		}
	} finally {
		db.close()
		for (const suffix of ['', '-wal', '-shm']) {
			try {
				fs.unlinkSync(tmpPath + suffix)
			} catch {
				/* ignore */
			}
		}
	}
	finish()
}

/**
 * Orders covering every reason a parcel is (or is not) waiting for a driver.
 */
function seed(db) {
	db.prepare('INSERT INTO groups (group_id, label) VALUES (?,?)').run('G1', 'Group 1')
	db.prepare('INSERT INTO shops (shop_id, group_id, shop_name) VALUES (?,?,?)').run('SHOP_A', 'G1', 'Y2KASEshop')

	const ins = db.prepare(`
    INSERT INTO receipts
      (receipt_id, shop_id, group_id, name, status, is_paid, is_shipped, packaged_at,
       fourpx_tracking_no, fourpx_consignment_no, fourpx_order_status, carrier_confirmed_at,
       etsy_created_at, all_transactions)
    VALUES
      (@receipt_id, @shop_id, @group_id, @name, @status, 1, @is_shipped, @packaged_at,
       @fourpx_tracking_no, @fourpx_consignment_no, @fourpx_order_status, @carrier_confirmed_at,
       @etsy_created_at, @all_transactions)
  `)
	const base = {
		shop_id: 'SHOP_A',
		group_id: 'G1',
		status: 'Completed',
		is_shipped: 1,
		packaged_at: null,
		fourpx_tracking_no: null,
		fourpx_consignment_no: null,
		fourpx_order_status: 'created',
		carrier_confirmed_at: null,
		etsy_created_at: NOW - 3 * DAY,
		all_transactions: TX,
	}

	// 3001/3002 — sealed, labelled, not yet scanned: exactly what a driver is for.
	ins.run({ ...base, receipt_id: 3001, name: 'Sealed First', packaged_at: NOW - 2 * DAY, fourpx_tracking_no: '4PXTEST3001', fourpx_consignment_no: 'DS3001' })
	ins.run({ ...base, receipt_id: 3002, name: 'Sealed Later', packaged_at: NOW - 3600, fourpx_tracking_no: '4PXTEST3002', fourpx_consignment_no: 'DS3002' })
	// 3003 — labelled but not sealed yet.
	ins.run({ ...base, receipt_id: 3003, name: 'Not Packed', is_shipped: 0, fourpx_tracking_no: '4PXTEST3003', fourpx_consignment_no: 'DS3003' })
	// 3004 — already scanned by 4PX: in the network, a pickup is moot.
	ins.run({ ...base, receipt_id: 3004, name: 'Already Scanned', packaged_at: NOW - DAY, fourpx_tracking_no: '4PXTEST3004', fourpx_consignment_no: 'DS3004', carrier_confirmed_at: NOW - 3600 })
	// 3005 — sealed but shipped by another carrier: nothing for 4PX to collect.
	ins.run({ ...base, receipt_id: 3005, name: 'No 4PX Label', packaged_at: NOW - DAY, fourpx_order_status: null })
	// 3006 — cancelled after sealing.
	ins.run({ ...base, receipt_id: 3006, name: 'Cancelled Order', status: 'Canceled', packaged_at: NOW - DAY, fourpx_tracking_no: '4PXTEST3006', fourpx_consignment_no: 'DS3006' })
	// 3007 — the 4PX label itself was cancelled.
	ins.run({ ...base, receipt_id: 3007, name: 'Cancelled Label', packaged_at: NOW - DAY, fourpx_tracking_no: '4PXTEST3007', fourpx_consignment_no: 'DS3007', fourpx_order_status: 'cancelled' })
	// 3008 — sealed 70 days ago and never scanned. It was handed over long ago;
	//        the missing scan is a tracking gap, not a parcel on the bench.
	ins.run({ ...base, receipt_id: 3008, name: 'Long Gone', packaged_at: Math.floor(Date.now() / 1000) - 70 * DAY, fourpx_tracking_no: '4PXTEST3008', fourpx_consignment_no: 'DS3008' })
}

/**
 * The real 4PX appointment form, to scale: a square page (269.29 pt = 95 mm).
 * @param {number} sidePt
 */
function squarePdf(sidePt) {
	return minimalPdf(1, { widthPt: sidePt, heightPt: sidePt })
}

/**
 * A minimal, VALID PDF standing in for a 4PX appointment form.
 *
 * Built here rather than committed as a binary fixture so the PAGE SHAPE is a
 * parameter: the whole print decision turns on whether the form is square (a
 * label, which is what 4PX issues) or a paper page (which must not be shrunk
 * onto label stock), and one fixture cannot be both. The cross-reference table
 * is written properly — pdfium can rebuild a broken one, so a hand-waved xref
 * would pass this test while proving nothing about real 4PX documents.
 *
 * Each page carries a filled black rectangle, which is enough for the render
 * assertions (dot grid, coverage, "there is ink on it").
 *
 * @param {number} pageCount
 * @param {{ widthPt?: number, heightPt?: number }} [size] default A4 portrait
 * @returns {Buffer}
 */
function minimalPdf(pageCount = 1, size = {}) {
	const widthPt = size.widthPt || 595
	const heightPt = size.heightPt || 842
	/** @type {string[]} object bodies, index 0 = object number 1 */
	const objects = ['', ''] // 1 = catalog, 2 = page tree; filled in below
	const push = (body) => objects.push(body) // Array#push returns the new length…
	const kids = []
	for (let i = 0; i < pageCount; i++) {
		const content = `0 0 0 rg 20 ${40 + i * 20} ${Math.round(widthPt / 2)} ${Math.round(heightPt / 3)} re f`
		const streamNo = push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`) // …which is the object number
		const pageNo = push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPt} ${heightPt}] /Contents ${streamNo} 0 R /Resources << >> >>`)
		kids.push(`${pageNo} 0 R`)
	}
	objects[0] = '<< /Type /Catalog /Pages 2 0 R >>'
	objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`

	// Byte offsets: every character written here is Latin-1, so string length is
	// byte length and the xref offsets are exact.
	let pdf = '%PDF-1.4\n'
	const offsets = []
	objects.forEach((body, i) => {
		offsets.push(pdf.length)
		pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
	})
	const startXref = pdf.length
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
	for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`
	return Buffer.from(pdf, 'latin1')
}

function finish() {
	console.log('')
	if (failures > 0) {
		console.error(`${failures} assertion(s) FAILED`)
		process.exit(1)
	}
	console.log('All assertions passed.')
}
