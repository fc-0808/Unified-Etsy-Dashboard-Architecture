'use strict'

/**
 * Regression test — an order shipped with 4PX must NEVER be left stranded in
 * "Needs shipping".
 *
 * THE BUG THIS LOCKS DOWN
 * ----------------------------------------------------------------------------
 * "Ship with 4PX" is a two-phase transaction: create the (paid, irreversible)
 * 4PX label, then complete the order on Etsy. Phase two used to be driven by
 * the browser, so closing the tab / an expired token / a dropped connection
 * left the order with a real parcel in flight but `is_shipped = 0` — parked in
 * the Needs-shipping tab forever, quietly accruing a late-shipment strike, with
 * no automatic recovery.
 *
 * The fix is a durable obligation ledger (src/orders/etsy-completion.js): the
 * intent to complete is written the instant the label exists, and a server-side
 * reconciler discharges it with bounded retries. This test asserts the whole
 * state machine against the REAL schema (built by db/setup.initDb), so a column
 * rename or a schema change is caught too.
 *
 * WHAT IS COVERED
 *   1. Needs-shipping is `is_shipped = 0` — a 4PX label alone does not clear it.
 *   2. Enqueue is idempotent and never re-arms a settled (done) obligation.
 *   3. Backoff is monotonic, capped, and jittered.
 *   4. Failures retry; permanent failures and exhausted budgets dead-letter.
 *   5. Claims are LEASED — a crashed sweep cannot lose an obligation, and two
 *      runners cannot double-ship the same order.
 *   6. Orphan adoption rescues orders stranded by older builds, but refuses to
 *      auto-notify buyers of stale labels.
 *   7. Etsy's "already shipped" reply is success, not failure.
 *   8. Completing the order clears the ledger AND leaves Needs-shipping.
 *   9. The operator is warned only once the fast path has actually missed, so a
 *      healthy shipment never flashes a scary "not completed" chip.
 *
 * Run: `node scripts/test-etsy-completion.js` (or `npm run test:etsy-completion`)
 * Exit code 0 = all assertions pass, 1 = a regression was detected.
 */

const os = require('os')
const path = require('path')
const fs = require('fs')
const { initDb } = require('../src/db/setup')
const ec = require('../src/orders/etsy-completion')

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

const NOW = 1_800_000_000 // fixed clock: every schedule assertion is exact
const DAY = 24 * 3600
const TX = JSON.stringify([{ title: 'Kawaii Frog MAGSAFE Case', listing_id: 555, quantity: 1, variations: [] }])

/** The literal Needs-shipping predicate from GET /api/orders?shipped=false. */
function needsShippingIds(db) {
	return db
		.prepare(
			`SELECT receipt_id FROM receipts
       WHERE is_shipped = 0
         AND status NOT IN ('Canceled','Fully Refunded','Cancelled','Fully refunded')
       ORDER BY receipt_id`,
		)
		.all()
		.map((r) => r.receipt_id)
}

/** Mirror of the shipEtsyReceipt write, so "completed" means the same thing here. */
function completeOnEtsy(db, receiptId, tracking) {
	db.prepare(
		`UPDATE receipts SET is_shipped = 1, status = 'Completed', tracking_code = ?, carrier_name = '4PX',
       shipment_notified_at = COALESCE(shipment_notified_at, ?) WHERE receipt_id = ?`,
	).run(tracking, NOW, receiptId)
	ec.markDone(db, receiptId, { trackingCode: tracking, now: NOW })
}

function seed(db) {
	db.prepare('INSERT INTO groups (group_id, label) VALUES (?,?)').run('G1', 'Group 1')
	db.prepare('INSERT INTO shops (shop_id, group_id, shop_name) VALUES (?,?,?)').run('SHOP_A', 'G1', 'Y2KASEshop')

	const ins = db.prepare(`
    INSERT INTO receipts
      (receipt_id, shop_id, group_id, name, status, is_paid, is_shipped, tracking_code,
       fourpx_tracking_no, fourpx_consignment_no, fourpx_order_status, fourpx_created_at,
       etsy_created_at, all_transactions, source)
    VALUES
      (@receipt_id, @shop_id, @group_id, @name, @status, @is_paid, @is_shipped, @tracking_code,
       @fourpx_tracking_no, @fourpx_consignment_no, @fourpx_order_status, @fourpx_created_at,
       @etsy_created_at, @all_transactions, @source)
  `)
	const base = {
		shop_id: 'SHOP_A',
		group_id: 'G1',
		is_paid: 1,
		is_shipped: 0,
		tracking_code: null,
		fourpx_tracking_no: null,
		fourpx_consignment_no: null,
		fourpx_order_status: null,
		fourpx_created_at: null,
		etsy_created_at: NOW - 3 * DAY,
		all_transactions: TX,
		source: null,
	}

	// 2001 — the reported bug: 4PX label created, never completed on Etsy.
	ins.run({
		...base,
		receipt_id: 2001,
		name: 'Catherine Chiu',
		status: 'Paid',
		tracking_code: '4PXTEST2001',
		fourpx_tracking_no: '4PXTEST2001',
		fourpx_consignment_no: 'DS2001',
		fourpx_order_status: 'created',
		fourpx_created_at: NOW - 3600,
	})
	// 2002 — plain unshipped order, no 4PX shipment. Must never be adopted.
	ins.run({ ...base, receipt_id: 2002, name: 'No Label', status: 'Paid' })
	// 2003 — cancelled order that still carries a label. Must never be shipped.
	ins.run({
		...base,
		receipt_id: 2003,
		name: 'Cancelled',
		status: 'Canceled',
		fourpx_tracking_no: '4PXTEST2003',
		fourpx_consignment_no: 'DS2003',
		fourpx_order_status: 'created',
		fourpx_created_at: NOW - 3600,
	})
	// 2004 — a STALE stranded label (60 days old). Outside the adoption window:
	//        auto-emailing this buyer "your order shipped" would be wrong.
	ins.run({
		...base,
		receipt_id: 2004,
		name: 'Stale Label',
		status: 'Paid',
		fourpx_tracking_no: '4PXTEST2004',
		fourpx_consignment_no: 'DS2004',
		fourpx_order_status: 'created',
		fourpx_created_at: NOW - 60 * DAY,
		etsy_created_at: NOW - 61 * DAY,
	})
	// 2005 — label was CANCELLED on 4PX; there is nothing to complete against.
	ins.run({
		...base,
		receipt_id: 2005,
		name: 'Cancelled Label',
		status: 'Paid',
		fourpx_consignment_no: 'DS2005',
		fourpx_order_status: 'cancelled',
		fourpx_created_at: NOW - 3600,
	})
	// 2006 — manual (off-Etsy) order shipped with 4PX. Completed locally, but it
	//        owes the same obligation, so it must be tracked the same way.
	ins.run({
		...base,
		receipt_id: 2006,
		name: 'Manual Buyer',
		status: 'Paid',
		source: 'manual',
		fourpx_tracking_no: '4PXTEST2006',
		fourpx_consignment_no: 'DS2006',
		fourpx_order_status: 'created',
		fourpx_created_at: NOW - 3600,
	})
}

const tmpPath = path.join(os.tmpdir(), `etsy-completion-test-${process.pid}-${Date.now()}.db`)
const db = initDb(tmpPath)

console.log('Etsy-completion (ship recovery) regression test')

try {
	seed(db)

	// ── 1. The bug itself ─────────────────────────────────────────────────────
	section('A 4PX label alone does not take an order out of Needs shipping')
	{
		const ids = needsShippingIds(db)
		assert(ids.includes(2001), 'the 4PX-labelled but uncompleted order is in Needs shipping (this IS the bug)')
		assert(!ids.includes(2003), 'a cancelled order is never in Needs shipping')

		const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='etsy_completion_intents'").all()
		assert(tables.length === 1, 'initDb creates the completion ledger')
	}

	// ── 2. Enqueue semantics ──────────────────────────────────────────────────
	section('Recording the obligation is idempotent and never re-notifies a buyer')
	{
		const first = ec.enqueue(db, { receiptId: 2001, trackingCode: '4PXTEST2001', now: NOW })
		assert(first.created === true, 'the first enqueue creates the intent')
		assert(first.intent.state === ec.STATE.PENDING, 'a new intent starts pending')
		assert(first.intent.next_attempt_at === NOW + ec.FIRST_ATTEMPT_GRACE_SEC, `the first attempt is deferred by the grace period so the browser fast path wins (got ${first.intent.next_attempt_at - NOW}s)`)

		const second = ec.enqueue(db, { receiptId: 2001, trackingCode: '4PXTEST2001', now: NOW + 5 })
		assert(second.created === false, 'a repeat enqueue does not create a second intent')
		assert(second.intent.next_attempt_at === NOW + ec.FIRST_ATTEMPT_GRACE_SEC, 'a repeat enqueue does not pull the schedule forward on its own')

		const expedited = ec.enqueue(db, { receiptId: 2001, now: NOW + 5, expedite: true })
		assert(expedited.intent.next_attempt_at === NOW + 5, 'an explicit expedite makes the intent due now')

		// The single most important safety property in this file.
		ec.markDone(db, 2001, { now: NOW + 10 })
		const afterDone = ec.enqueue(db, { receiptId: 2001, trackingCode: '4PXTEST2001', now: NOW + 20 })
		assert(afterDone.changed === false, 'enqueue is a NO-OP on a completed order — a settled obligation is never re-armed')
		assert(ec.getIntent(db, 2001).state === ec.STATE.DONE, '…and the intent stays done, so no buyer is notified twice')

		const revived = ec.enqueue(db, { receiptId: 2001, now: NOW + 30, revive: true, graceSec: 0 })
		assert(revived.intent.state === ec.STATE.PENDING, 'an explicit operator retry (revive) does re-arm it')
		assert(revived.intent.attempts === 0, '…with a fresh attempt budget')

		// Restore for later sections.
		ec.markDone(db, 2001, { now: NOW + 31 })
	}

	// ── 3. Backoff ────────────────────────────────────────────────────────────
	section('Retry backoff widens, is capped, and is jittered')
	{
		const mid = () => 0.5 // no jitter → exact expected values
		const delays = [1, 2, 3, 4, 5, 6, 7, 8, 20].map((n) => ec.backoffDelaySec(n, { random: mid }))
		assert(
			delays.slice(0, ec.RETRY_BACKOFF_SEC.length).every((d, i) => d === ec.RETRY_BACKOFF_SEC[i]),
			`the schedule matches the declared table (${ec.RETRY_BACKOFF_SEC.join(', ')}s)`,
		)
		const last = ec.RETRY_BACKOFF_SEC[ec.RETRY_BACKOFF_SEC.length - 1]
		assert(delays[delays.length - 1] === last, `the delay is capped at ${last}s rather than growing without bound`)
		assert(
			delays.slice(0, ec.RETRY_BACKOFF_SEC.length).every((d, i, a) => i === 0 || d > a[i - 1]),
			'each step waits strictly longer than the previous one',
		)
		assert(ec.backoffDelaySec(1, { random: () => 0 }) < ec.backoffDelaySec(1, { random: () => 1 }), 'jitter spreads simultaneous retries apart')
		assert(ec.backoffDelaySec(0) >= 1 && ec.backoffDelaySec(-5) >= 1, 'a nonsensical attempt count still yields a sane delay')
	}

	// ── 4. Failure handling ───────────────────────────────────────────────────
	section('Transient failures retry; hopeless ones stop')
	{
		ec.enqueue(db, { receiptId: 2006, trackingCode: '4PXTEST2006', now: NOW, graceSec: 0 })

		const f1 = ec.markFailed(db, 2006, { error: 'Etsy 429', now: NOW, random: () => 0.5 })
		assert(f1.state === ec.STATE.PENDING && f1.attempts === 1, 'a transient failure keeps the intent pending')
		assert(f1.nextAttemptAt === NOW + ec.RETRY_BACKOFF_SEC[0], `…and schedules the next try ${ec.RETRY_BACKOFF_SEC[0]}s out`)
		assert(ec.getIntent(db, 2006).last_error === 'Etsy 429', 'the reason is stored so the order card can show it')

		const f2 = ec.markFailed(db, 2006, { error: 'Order not found', permanent: true, now: NOW + 60 })
		assert(f2.state === ec.STATE.DEAD, 'a permanent failure dead-letters immediately instead of burning the budget')

		// Budget exhaustion.
		ec.enqueue(db, { receiptId: 2002, trackingCode: 'X', now: NOW, graceSec: 0 })
		let out
		for (let i = 0; i < ec.MAX_ATTEMPTS; i++) out = ec.markFailed(db, 2002, { error: 'boom', now: NOW + i, random: () => 0.5 })
		assert(out.state === ec.STATE.DEAD && out.attempts === ec.MAX_ATTEMPTS, `an intent gives up after ${ec.MAX_ATTEMPTS} attempts rather than retrying forever`)
		assert(ec.claimDue(db, { now: NOW + 10 * DAY, limit: 50 }).every((r) => r.receipt_id !== 2002), 'a dead intent is never picked up again automatically')

		db.prepare('DELETE FROM etsy_completion_intents WHERE receipt_id IN (2002, 2006)').run()
	}

	// ── 5. Leases ─────────────────────────────────────────────────────────────
	section('Claims are leased, so no obligation is lost and none is double-shipped')
	{
		ec.enqueue(db, { receiptId: 2006, trackingCode: '4PXTEST2006', now: NOW, graceSec: 0 })

		const notYet = ec.claimDue(db, { now: NOW - 1, limit: 10 })
		assert(notYet.length === 0, 'an intent that is not due yet is not claimed')

		const claimed = ec.claimDue(db, { now: NOW, limit: 10, leaseSec: 600 })
		assert(claimed.length === 1 && claimed[0].receipt_id === 2006, 'a due intent is claimed')

		const again = ec.claimDue(db, { now: NOW + 1, limit: 10 })
		assert(again.length === 0, 'a leased intent cannot be claimed by a second runner (no double-ship)')

		const afterLease = ec.claimDue(db, { now: NOW + 601, limit: 10 })
		assert(afterLease.length === 1, 'once the lease expires the obligation is claimable again (a crashed sweep self-heals)')

		ec.releaseClaim(db, 2006, { now: NOW + 602 })
		assert(ec.claimDue(db, { now: NOW + 603, limit: 10 }).length === 1, 'an explicitly released claim is immediately re-claimable')

		// A per-sweep cap keeps buyer notifications paced.
		ec.enqueue(db, { receiptId: 2002, trackingCode: 'Y', now: NOW, graceSec: 0 })
		ec.releaseClaim(db, 2006, { now: NOW + 604 })
		const capped = ec.claimDue(db, { now: NOW + 605, limit: 1 })
		assert(capped.length === 1, 'the batch size is respected so a backlog cannot burst-notify buyers')

		db.prepare('DELETE FROM etsy_completion_intents WHERE receipt_id IN (2002, 2006)').run()
	}

	// ── 6. Orphan adoption ────────────────────────────────────────────────────
	section('Orders stranded by an older build are rescued — but stale labels are not auto-shipped')
	{
		db.prepare('DELETE FROM etsy_completion_intents').run()
		const adopted = ec.adoptOrphans(db, { now: NOW })
		const ids = db.prepare('SELECT receipt_id FROM etsy_completion_intents ORDER BY receipt_id').all().map((r) => r.receipt_id)

		assert(ids.includes(2001), 'the stranded 4PX-labelled order is adopted — this is what heals the reported bug')
		assert(ids.includes(2006), 'a stranded manual order shipped with 4PX is adopted too')
		assert(!ids.includes(2002), 'an order with no 4PX shipment is never adopted')
		assert(!ids.includes(2003), 'a cancelled order is never adopted')
		assert(!ids.includes(2005), 'an order whose 4PX label was cancelled is never adopted')
		assert(!ids.includes(2004), `a ${Math.round(ec.ADOPT_MAX_AGE_SEC / DAY)}-day-old label is left for a human — auto-emailing that buyer would be wrong`)
		assert(adopted === ids.length, `adoptOrphans reports what it created (got ${adopted}, ledger has ${ids.length})`)

		assert(ec.adoptOrphans(db, { now: NOW }) === 0, 'a second adoption pass is a no-op — adoption cannot duplicate an obligation')
		assert(db.prepare('SELECT tracking_code FROM etsy_completion_intents WHERE receipt_id = 2001').get().tracking_code === '4PXTEST2001', 'the adopted intent carries the order’s own tracking number')

		// Once completed, the order is gone from Needs shipping AND from the ledger's
		// pending set — the end-to-end property this whole feature exists to hold.
		completeOnEtsy(db, 2001, '4PXTEST2001')
		assert(!needsShippingIds(db).includes(2001), 'completing the order removes it from Needs shipping')
		assert(ec.getIntent(db, 2001).state === ec.STATE.DONE, '…and settles its obligation')
		assert(ec.summarize(db, { now: NOW }).pending === db.prepare(`SELECT COUNT(*) c FROM etsy_completion_intents WHERE state = 'pending'`).get().c, 'the pending summary agrees with the ledger')
	}

	// ── 7. Tracking resolution + error classification ─────────────────────────
	section('Tracking resolution and Etsy error classification')
	{
		assert(ec.resolveTracking({ fourpx_tracking_no: 'A', tracking_code: 'B', fourpx_consignment_no: 'C' }) === 'A', 'the 4PX tracking number wins')
		assert(ec.resolveTracking({ tracking_code: '4PXB', fourpx_consignment_no: 'C' }) === '4PXB', 'a 4PX number already mirrored onto the receipt is next')
		assert(ec.resolveTracking({ tracking_code: 'USPS9', fourpx_consignment_no: 'C' }) === 'C', 'a non-4PX tracking code does not outrank the consignment id')
		assert(ec.resolveTracking({}) === '' && ec.resolveTracking(null) === '', 'an order with no identity resolves to empty (not completable)')

		const already = ec.classifyCompletionError(new Error('Receipt already has a shipment with this tracking code'))
		assert(already.alreadyShipped === true, 'Etsy reporting the order is already shipped is treated as success, not failure')
		assert(already.permanent === false, '…and is never dead-lettered')

		assert(ec.classifyCompletionError(new Error('Already flagged for review')).alreadyShipped === false, 'an unrelated message containing "already" is not mistaken for a shipment')

		const notFound = Object.assign(new Error('Receipt not found'), { status: 404 })
		assert(ec.classifyCompletionError(notFound).permanent === true, 'a 404 from Etsy is permanent — retrying it 12 times helps nobody')

		const rate = Object.assign(new Error('Too many requests'), { status: 429 })
		assert(ec.classifyCompletionError(rate).permanent === false, 'a rate limit is transient and keeps retrying')

		const axiosish = { response: { data: { error_description: 'Invalid access token' }, status: 401 }, message: 'Request failed' }
		assert(ec.classifyCompletionError(axiosish).message === 'Invalid access token', 'the operator-facing message prefers Etsy’s own wording over the axios wrapper')

		assert(ec.isTerminalStatus('Canceled') && ec.isTerminalStatus('Fully refunded') && !ec.isTerminalStatus('Paid'), 'terminal statuses are recognised so a refunded order is never shipped')
	}

	// ── 8. API shaping ────────────────────────────────────────────────────────
	section('What the order card is told')
	{
		assert(ec.shapeForApi(null) === null, 'an order with no obligation carries no payload')
		assert(ec.shapeForApi({ state: ec.STATE.DONE }) === null, 'a completed obligation is not advertised to the UI')
		assert(ec.shapeForApi({ state: ec.STATE.SKIPPED }) === null, 'a retired obligation is not advertised either')

		const pending = ec.shapeForApi({ state: ec.STATE.PENDING, attempts: 2, next_attempt_at: NOW + 90, last_error: 'Etsy 503', origin: 'fourpx' }, NOW)
		assert(pending.retry_in_sec === 90, 'a pending obligation reports how long until the next automatic retry')
		assert(pending.last_error === 'Etsy 503', '…and why the last try failed')

		const dead = ec.shapeForApi({ state: ec.STATE.DEAD, attempts: 12, next_attempt_at: NOW, last_error: 'Invalid token', origin: 'fourpx' }, NOW)
		assert(dead.retry_in_sec === null, 'a dead obligation reports no countdown — nothing is coming to save it')
		assert(dead.state === 'dead', '…so the card can tell the operator to act')
	}

	// ── 9. When to actually alarm the operator ────────────────────────────────
	// A warning that fires on every healthy shipment is a warning nobody reads.
	// The chip and the recovery banner must stay silent for the seconds the
	// normal flow needs, then speak up the moment it has demonstrably missed.
	section('The operator is warned only once the fast path has actually missed')
	{
		db.prepare('DELETE FROM etsy_completion_intents WHERE receipt_id = 2006').run()
		const fresh = ec.enqueue(db, { receiptId: 2006, trackingCode: '4PXTEST2006', now: NOW }).intent

		assert(ec.isStranded(fresh, NOW) === false, 'a label created seconds ago is not flagged — the browser is still finishing the job')
		assert(ec.shapeForApi(fresh, NOW).stranded === false, '…so the order card stays quiet during a perfectly normal shipment')
		assert(ec.countStranded(db, { now: NOW }) === 1, 'the banner counts only the genuinely stale label (2004), not the shipment in flight')

		const afterGrace = NOW + ec.FIRST_ATTEMPT_GRACE_SEC + 1
		assert(ec.isStranded(fresh, afterGrace) === true, 'once the grace window passes with the order still open, it is flagged')
		assert(ec.countStranded(db, { now: afterGrace }) === 2, '…and the banner picks it up without any attempt having been recorded')

		ec.markFailed(db, 2006, { error: 'Etsy 503', now: NOW + 1, random: () => 0.5 })
		const failed = ec.getIntent(db, 2006)
		assert(failed.next_attempt_at > NOW + 1, 'a failed attempt backs off into the future')
		assert(ec.isStranded(failed, NOW + 2) === true, '…yet a failure already seen is surfaced immediately, not hidden until the backoff expires')
		assert(ec.countStranded(db, { now: NOW + 2 }) === 2, 'the banner and the card agree on the same set of orders')

		completeOnEtsy(db, 2006, '4PXTEST2006')
		assert(ec.isStranded(ec.getIntent(db, 2006), afterGrace) === false, 'a settled obligation is never stranded')
		assert(ec.countStranded(db, { now: afterGrace }) === 1, '…and drops straight out of the banner count')

		assert(ec.isStranded(null, NOW) === false, 'an order with no ledger entry is not "stranded" by the ledger — the card decides that from the label itself')
		assert(ec.isStranded({ state: ec.STATE.DEAD, attempts: 3, next_attempt_at: NOW + DAY }, NOW) === true, 'a dead obligation always alarms — nothing is coming to retry it')

		// 2003 (cancelled order) and 2005 (cancelled label) both still carry 4PX
		// columns; neither may ever be counted, or the banner would never clear.
		const stranded = db
			.prepare(
				`SELECT r.receipt_id FROM receipts r
         LEFT JOIN etsy_completion_intents i ON i.receipt_id = r.receipt_id
         WHERE r.is_shipped = 0 AND r.fourpx_consignment_no IS NOT NULL
           AND r.status NOT IN ('Canceled','Cancelled','Fully Refunded','Fully refunded')
           AND COALESCE(r.fourpx_order_status,'') <> 'cancelled'
         ORDER BY r.receipt_id`,
			)
			.all()
			.map((r) => r.receipt_id)
		assert(stranded.join(',') === '2004', 'the only order left owing Etsy anything is the stale label a human must decide on')
	}

	// ── 10. Dashboard wiring ──────────────────────────────────────────────────
	// The ledger is only useful if the page actually reads it. These assert the
	// contract between server and page against the shipped markup, so silently
	// deleting the banner or the chip fails the build instead of the operator.
	section('The Orders page is actually wired to the ledger')
	{
		const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')

		assert(/id="shipRecoveryBanner"/.test(page), 'the Needs-shipping view carries the ship-recovery banner')
		assert(/function updateShipRecoveryBanner\(/.test(page), '…backed by a function that shows and hides it')
		assert(/updateShipRecoveryBanner\(\s*(data|json|d)\??\.etsy_completion_pending/.test(page), '…driven by the count the orders API reports, not a client-side guess')
		assert(/o\.etsy_completion\??\.stranded|etsy_completion\.stranded/.test(page), 'the order card respects the stranded flag, so a healthy shipment shows no scary chip')
		assert(/completeWith4px\(\$\{o\.receipt_id\}/.test(page), 'the chip’s retry button passes the receipt id as a number, never as interpolated markup')
		assert(/\/complete-with-4px`, \{ method: 'POST' \}/.test(page), '…and posts to the single-order completion endpoint')
		assert(/\/api\/orders\/complete-pending-4px`, \{ method: 'POST' \}/.test(page), 'the banner’s bulk action posts to the sweep endpoint')
		assert(/Promise\.resolve\(pending\)[\s\S]{0,160}?fetchOrders\(\)/.test(page), 'closing the 4PX drawer waits for the completion it started before refreshing — no stale "Unshipped" flash')
		assert(/const pending = _fpxCompleteInFlight/.test(page), '…using the promise the submit step handed it, rather than a fixed delay')

		const policy = require('../src/auth/policy')
		assert(policy.requiredCapability('POST', '/api/orders/complete-pending-4px') === 'orders:ship', 'the bulk endpoint needs the same capability as shipping an order')
		assert(policy.requiredCapability('POST', '/api/orders/4123456789/complete-with-4px') === 'orders:ship', '…and so does the single-order retry — completion IS shipping')
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

console.log('')
if (failures > 0) {
	console.error(`${failures} assertion(s) FAILED`)
	process.exit(1)
}
console.log('All assertions passed.')
