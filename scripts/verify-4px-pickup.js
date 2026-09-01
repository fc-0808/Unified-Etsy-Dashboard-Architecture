'use strict'

/**
 * Pre-flight for 4PX door-to-door pickup booking (揽收预约).
 *
 * Answers the one question a regression test cannot: is THIS installation ready
 * to book a driver? It reads the real config and the real ledger, validates the
 * configured pickup address against 4PX's published schema, prints the exact
 * request body that would be sent, and — on request — proves the credentials and
 * signature work end to end using the only READ-ONLY method of the three.
 *
 * IT NEVER BOOKS. ds.xms.api.collect.create.order dispatches a real van and has
 * no client idempotency key, so a booking is only ever made from the dashboard,
 * where the double-book guards live. A CLI that could spend one would eventually
 * be run "just to test something".
 *
 * Usage:
 *   node scripts/verify-4px-pickup.js                    report + dry-run payload for today
 *   node scripts/verify-4px-pickup.js --date 2026-08-22   …for a specific date
 *   node scripts/verify-4px-pickup.js --print C123456     fetch an existing appointment form (read-only)
 *
 * Exit code 0 = ready to book, 1 = something must be fixed first.
 */

const { loadConfig } = require('../src/config/schema')
const { initDb, listFourpxPickupAppointments, listParcelsAwaitingFourpxPickup, pruneStaleFourpxPickupAppointments } = require('../src/db/setup')
const collect = require('../src/fourpx/collect')

function arg(name) {
	const i = process.argv.indexOf(name)
	return i > -1 ? process.argv[i + 1] : null
}
function ok(label) {
	console.log(`  PASS  ${label}`)
}
function bad(label, detail) {
	console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`)
	process.exitCode = 1
}
function warn(label) {
	console.log(`  WARN  ${label}`)
}
function heading(title) {
	console.log(`\n${title}`)
}

async function main() {
	console.log('4PX pickup booking (揽收预约) pre-flight\n')
	const config = loadConfig()

	// ── Feature + credentials ────────────────────────────────────────────────
	heading('Configuration')
	if (config.fourpx_pickup_booking === false) {
		bad('pickup booking is turned off', 'set "fourpx_pickup_booking": true in config.json')
	} else {
		ok('pickup booking is enabled')
	}
	const hasCreds = !!(config.fourpx_app_key && config.fourpx_app_secret)
	if (hasCreds) ok(`4PX credentials present (app_key ${String(config.fourpx_app_key).slice(0, 4)}…)`)
	else bad('4PX credentials missing', 'fourpx_app_key / fourpx_app_secret in config.json')

	const timeZone = config.fourpx_pickup_timezone || collect.DEFAULT_PICKUP_TIMEZONE
	const maxDaysAhead = collect.normalizeMaxDaysAhead(config.fourpx_pickup_max_days_ahead)
	const today = collect.todayInTimeZone(timeZone)
	ok(`pickup calendar reads ${timeZone} — it is ${today} (${collect.weekdayForIsoDate(today)}) there`)
	if (today !== new Date().toISOString().slice(0, 10)) {
		warn(`the pickup date is NOT the same calendar day as UTC right now — this is exactly why the window is timezone-aware`)
	}
	ok(`bookable window: ${today} → ${collect.addDaysToIsoDate(today, maxDaysAhead - 1)} (${maxDaysAhead} days)`)

	// ── The pre-filled pickup address ───────────────────────────────────────
	heading('Pickup address (揽收地址)')
	let pickup = null
	if (!config.fourpx_pickup) {
		warn('no default pickup address configured — the packer will have to type all of it every time (config.json → "fourpx_pickup")')
	} else {
		const { pickup: partial, problems } = collect.normalizePickupInfo(config.fourpx_pickup, { partial: true })
		for (const problem of problems) warn(problem)
		try {
			pickup = collect.normalizePickupInfo(config.fourpx_pickup)
			ok('the configured address satisfies every documented pickup_info rule')
			for (const field of collect.PICKUP_FIELDS) {
				if (pickup[field.key]) console.log(`        ${field.key.padEnd(15)} ${pickup[field.key]}`)
			}
		} catch (err) {
			pickup = null
			warn(`the dialog will open with blanks for the packer to complete: ${err.message}`)
			if (Object.keys(partial).length) console.log(`        usable so far: ${Object.keys(partial).join(', ')}`)
		}
	}

	// ── Dry-run payload ─────────────────────────────────────────────────────
	heading('Request that WOULD be sent (nothing is booked)')
	const requested = arg('--date') || today
	try {
		const reserveDate = collect.assertReserveDate(requested, { timeZone, maxDaysAhead })
		ok(`${reserveDate} (${collect.weekdayForIsoDate(reserveDate)}) is inside the bookable window`)
		if (pickup) {
			console.log(`        ${collect.COLLECT_METHODS.createOrder} v${collect.COLLECT_API_VERSION}`)
			console.log(
				JSON.stringify(collect.buildCreateOrderPayload({ reserveDate, pickup }), null, 2)
					.split('\n')
					.map((l) => `        ${l}`)
					.join('\n'),
			)
		} else {
			warn('no complete address, so no payload can be shown — the booking dialog would still work once the packer fills it in')
		}
	} catch (err) {
		bad(`${requested} cannot be booked`, err.message)
	}

	// ── Local state ─────────────────────────────────────────────────────────
	heading('Local state')
	const db = initDb(config.db_path)
	try {
		const reaped = pruneStaleFourpxPickupAppointments(db)
		if (reaped) warn(`${reaped} abandoned booking(s) were demoted to "unknown" — check 揽收预约 in the 4PX portal for those days`)

		const withinDays = collect.normalizeAwaitingDays(config.fourpx_pickup_awaiting_days)
		const awaiting = listParcelsAwaitingFourpxPickup(db, { withinDays })
		if (!awaiting.length) {
			ok(`no parcel sealed in the last ${withinDays} day(s) is waiting for a driver`)
		} else {
			const oldest = Math.floor((Date.now() / 1000 - awaiting[0].packaged_at) / 86400)
			ok(`${awaiting.length} sealed parcel(s) awaiting a driver (sealed within ${withinDays} day(s)); the oldest was sealed ${oldest} day(s) ago`)
			for (const p of awaiting.slice(0, 10)) console.log(`        #${p.receipt_id}  ${p.tracking_no || '(no tracking)'}  ${p.buyer_name || ''}`)
			if (awaiting.length > 10) console.log(`        …and ${awaiting.length - 10} more`)
		}

		const history = listFourpxPickupAppointments(db, { limit: 10 })
		if (!history.length) {
			console.log('        no pickups booked from this dashboard in the last 30 days')
		} else {
			for (const a of history) {
				console.log(`        ${a.reserve_date}  ${String(a.status).padEnd(10)} ${a.collect_no || '—'}  ${a.parcel_count} parcel(s)${a.error_message ? `  · ${a.error_message}` : ''}`)
			}
		}
	} finally {
		db.close()
	}

	// ── Printing the form the driver scans ──────────────────────────────────
	heading('Printing the appointment form (打印预约单)')
	const printMode = config.label_print_mode || 'auto'
	console.log(`        4PX issues the form as a 95 x 95 mm barcode label, so it prints through the shipping-label path:`)
	console.log(`        mode ${printMode} · printer "${config.label_printer_name}" · ${config.label_width_mm}x${config.label_height_mm} mm at ${config.label_dpi} dpi · ${config.label_print_copies} cop(ies)`)
	if (printMode === 'open') {
		ok('direct printing is off by config — the button opens the PDF for manual printing')
	} else if (process.platform !== 'win32' && printMode !== 'silent') {
		ok(`direct printing needs Windows — on ${process.platform} the button opens the PDF instead`)
	} else if (Math.abs(config.label_width_mm - config.label_height_mm) > 2) {
		warn(`the loaded stock is ${config.label_width_mm}x${config.label_height_mm} mm, but the form is square — it will print letterboxed and smaller than it could be`)
	} else {
		ok('the loaded stock is square, which is the form’s own shape')
		console.log('        run `npm run verify:label-print` to check the printer hardware itself')
	}

	// ── Optional live read ──────────────────────────────────────────────────
	const printNo = arg('--print')
	if (printNo && hasCreds) {
		heading(`Live read: ${collect.COLLECT_METHODS.printOrder} for ${printNo}`)
		try {
			const { pdfUrl } = await collect.printCollectOrder(config.fourpx_app_key, config.fourpx_app_secret, printNo)
			if (pdfUrl) ok(`4PX accepted the signed request and returned the appointment form: ${pdfUrl}`)
			else warn('4PX accepted the request but the form is not ready yet — try again in a few seconds')
		} catch (err) {
			bad('the live call failed', `${err.code ? `[${err.code}] ` : ''}${err.message}`)
		}
	} else if (printNo) {
		bad('--print needs 4PX credentials in config.json')
	} else {
		heading('Live read')
		console.log('        skipped — pass --print <appointment number> to prove the credentials and signature end to end.')
	}

	console.log('')
	console.log(process.exitCode ? 'Not ready — fix the FAIL lines above.' : 'Ready. Book pickups from the Orders tab (To pack & ship / Recently packaged).')
}

main().catch((err) => {
	console.error(`\nverify-4px-pickup failed: ${err.message}`)
	process.exit(1)
})
