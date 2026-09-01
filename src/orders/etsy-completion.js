'use strict'

/**
 * etsy-completion.js — the durable obligation ledger behind "Ship with 4PX".
 *
 * THE BUG THIS EXISTS TO KILL
 * ----------------------------------------------------------------------------
 * "Ship with 4PX" is a two-phase transaction across two systems:
 *
 *   Phase 1 (4PX)  create the shipment  → a REAL, PAID label + tracking number.
 *   Phase 2 (Etsy) complete the order   → is_shipped = 1, buyer notified.
 *
 * Phase 1 was durable (it writes to `receipts`), but phase 2 used to be driven
 * entirely by the browser: after the label came back, the drawer fired
 * `POST /api/orders/:id/ship` and hoped. Anything that interrupted that call —
 * closing the drawer or tab, a laptop sleeping, Wi-Fi dropping, an expired Etsy
 * token, a 429, a proxy hiccup — left the order in the worst possible state:
 * a paid label exists and the parcel will physically move, but Etsy still says
 * "Not shipped". The order therefore stayed in the **Needs shipping** tab
 * forever, silently accruing a late-shipment strike, and the ONLY recovery was
 * for a human to remember to run `scripts/complete-4px-pending.js` by hand.
 *
 * A browser tab is not a transaction coordinator. This module makes phase 2 an
 * obligation the SERVER owns.
 *
 * THE PATTERN
 * ----------------------------------------------------------------------------
 * A transactional outbox. The instant phase 1 produces an irreversible side
 * effect, we record a durable intent — "receipt R still owes Etsy a completion
 * with tracking T". A background reconciler then discharges that intent with
 * bounded exponential backoff until it succeeds, and the browser becomes a
 * FAST PATH plus a progress reporter rather than the system of record:
 *
 *   • Browser completes it in ~2s (unchanged UX) → intent settles `done`.
 *   • Browser dies / fails                       → the sweep finishes the job.
 *   • Etsy is down for an hour                   → backoff retries until it isn't.
 *   • Etsy rejects it permanently                → intent goes `dead`, and the
 *                                                  order card says so, loudly,
 *                                                  with a one-click retry.
 *
 * Every operation here is idempotent and keyed by `receipt_id`, because the one
 * thing worse than a late shipment is notifying a buyer twice. The actual Etsy
 * call remains de-duplicated upstream in `shipEtsyReceipt`.
 *
 * DESIGN NOTES
 * ----------------------------------------------------------------------------
 *   • Pure logic + SQL only. No HTTP, no Etsy, no config — so the whole state
 *     machine is unit-testable against an in-memory DB
 *     (see scripts/test-etsy-completion.js) and cannot drift from production.
 *   • `receipt_id` is the PRIMARY KEY: an order can owe at most one completion.
 *   • Claims are LEASED, not deleted, so a crash mid-sweep self-heals when the
 *     lease expires instead of losing the obligation.
 *   • Adoption (`adoptOrphans`) back-fills intents for orders stranded by older
 *     builds or by the bulk CLI, but only within a recent window — see the long
 *     comment there for why auto-shipping a months-old order is the wrong call.
 */

// ── Schema ───────────────────────────────────────────────────────────────────
// Owned here rather than inlined in db/setup.js so the table definition lives
// next to the state machine that maintains it. `initDb` executes this verbatim.
const ETSY_COMPLETION_SCHEMA_SQL = `
  -- ─────────────────────────────────────────────
  -- Durable "this order still owes Etsy a completion" ledger (outbox).
  -- One row per order; written when a 4PX label is created, settled when the
  -- order is actually completed on Etsy (by the browser, a bulk run, or the
  -- background reconciler). See src/orders/etsy-completion.js.
  -- ─────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS etsy_completion_intents (
    receipt_id      INTEGER PRIMARY KEY,
    -- pending → still owed | done → completed | dead → needs a human
    -- skipped → no longer applicable (cancelled/refunded order)
    state           TEXT    NOT NULL DEFAULT 'pending',
    tracking_code   TEXT,
    carrier_name    TEXT    NOT NULL DEFAULT '4PX',
    origin          TEXT    NOT NULL DEFAULT 'fourpx',
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    lease_until     INTEGER NOT NULL DEFAULT 0,
    last_attempt_at INTEGER,
    last_error      TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    settled_at      INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_etsy_completion_due
    ON etsy_completion_intents(state, next_attempt_at);
`

/** Lifecycle states. `pending` is the only one the reconciler acts on. */
const STATE = Object.freeze({
	PENDING: 'pending',
	DONE: 'done',
	DEAD: 'dead',
	SKIPPED: 'skipped',
})

/**
 * Retry schedule in seconds, indexed by attempt number. Front-loaded (a token
 * refresh or a blip clears in seconds) then widening (a real Etsy outage or a
 * revoked token needs hours, and hammering it is how a shop gets rate-limited).
 * The last entry repeats until MAX_ATTEMPTS.
 */
const RETRY_BACKOFF_SEC = Object.freeze([30, 120, 300, 900, 2700, 7200, 21600])

/**
 * After this many failures the intent is dead-lettered. With the schedule above
 * that is ~2.5 days of trying — far longer than any transient fault, and short
 * enough that a genuinely broken order surfaces to a human while it still
 * matters. A dead intent is never retried automatically, only by explicit
 * operator action (which resets it).
 */
const MAX_ATTEMPTS = 12

/** How long a claimed intent stays leased before another sweep may re-claim it. */
const DEFAULT_LEASE_SEC = 600

/**
 * Grace period between creating a 4PX label and the reconciler's first attempt.
 * The browser's own fast path normally completes the order within a couple of
 * seconds; waiting lets it win, so the common case produces exactly one Etsy
 * call and the sweep finds nothing to do.
 */
const FIRST_ATTEMPT_GRACE_SEC = 45

/**
 * Adoption window. Only orders whose 4PX label is younger than this are pulled
 * into the ledger automatically.
 */
const ADOPT_MAX_AGE_SEC = 14 * 24 * 3600

/** Receipts in these states are terminal — they never owe a completion. */
const CANCELLED_STATUSES = Object.freeze(['Canceled', 'Cancelled', 'Fully Refunded', 'Fully refunded'])

const CANCELLED_SQL_LIST = CANCELLED_STATUSES.map((s) => `'${s}'`).join(', ')

// ── Schema helpers ───────────────────────────────────────────────────────────

/**
 * Create the ledger table + index if absent. Idempotent; safe on every boot.
 * @param {import('better-sqlite3').Database} db
 */
function ensureSchema(db) {
	db.exec(ETSY_COMPLETION_SCHEMA_SQL)
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Delay before the Nth retry, with ±10% jitter so a batch of intents that
 * failed together (one Etsy outage) does not stampede back in lockstep.
 *
 * @param {number} attempts  Failures recorded SO FAR, including the one that
 *                           just happened (so the first call passes 1).
 * @param {{ random?: () => number }} [opts]  Injectable RNG for deterministic tests.
 * @returns {number} seconds to wait, always ≥ 1.
 */
function backoffDelaySec(attempts, { random = Math.random } = {}) {
	const n = Number.isFinite(attempts) ? Math.max(1, Math.trunc(attempts)) : 1
	const base = RETRY_BACKOFF_SEC[Math.min(n, RETRY_BACKOFF_SEC.length) - 1]
	const jitter = base * 0.2 * (random() - 0.5)
	return Math.max(1, Math.round(base + jitter))
}

/**
 * Pick the tracking number to complete an order with, from a receipts row.
 *
 * Preference order matches the rest of the app (and the bulk CLI): the number
 * 4PX gave us for the parcel, then a 4PX number already mirrored onto the
 * receipt, then the consignment id as a last resort. Returns '' when the order
 * has no 4PX identity at all, which the caller must treat as "not completable".
 *
 * @param {object} row  A receipts row (or any object with these fields).
 * @returns {string}
 */
function resolveTracking(row) {
	if (!row) return ''
	const pick = (v) => String(v ?? '').trim()
	if (pick(row.fourpx_tracking_no)) return pick(row.fourpx_tracking_no)
	const code = pick(row.tracking_code)
	if (/^4PX/i.test(code)) return code
	if (pick(row.fourpx_consignment_no)) return pick(row.fourpx_consignment_no)
	return code
}

/** @returns {boolean} whether a receipts row is cancelled / fully refunded. */
function isTerminalStatus(status) {
	return CANCELLED_STATUSES.includes(String(status ?? ''))
}

/**
 * Decide what a failed completion attempt MEANS.
 *
 * Three outcomes matter, and conflating them is how a queue either spins
 * forever or gives up on a recoverable order:
 *
 *   alreadyShipped — Etsy says the receipt already has this shipment. That is
 *                    success with a lost ack, not a failure: reconcile locally
 *                    and never call Etsy again (a re-submit re-notifies the buyer).
 *   permanent      — the request can never succeed as written (order missing,
 *                    not an Etsy order, no tracking). Dead-letter immediately
 *                    instead of burning 12 attempts on a certainty.
 *   otherwise      — transient. Retry with backoff.
 *
 * @param {Error & { status?: number, code?: string, response?: any }} err
 * @returns {{ alreadyShipped: boolean, permanent: boolean, message: string }}
 */
function classifyCompletionError(err) {
	const body = err?.response?.data
	const fromBody = body && typeof body === 'object' ? body.error_description || body.error : null
	const message = String(fromBody || err?.message || 'Unknown error')
	const status = err?.status ?? err?.response?.status ?? null

	// Etsy phrases this several ways ("already shipped", "tracking already
	// submitted", …). Require BOTH halves so an unrelated message containing
	// "already" can never be mistaken for a completed shipment.
	const alreadyShipped = /already/i.test(message) && /(ship|track)/i.test(message)

	const permanent =
		!alreadyShipped &&
		(status === 404 ||
			err?.code === 'NOT_FOUND' ||
			err?.code === 'NOT_ON_ETSY' ||
			err?.code === 'NO_TRACKING' ||
			/not\s+found/i.test(message) ||
			/cannot be shipped or tracked through Etsy/i.test(message))

	return { alreadyShipped, permanent, message }
}

// ── Ledger operations ────────────────────────────────────────────────────────

const _nowSec = () => Math.floor(Date.now() / 1000)

/** @returns {object|null} the intent row for a receipt, or null. */
function getIntent(db, receiptId) {
	return db.prepare('SELECT * FROM etsy_completion_intents WHERE receipt_id = ?').get(Number(receiptId)) || null
}

/**
 * Look up many intents at once, for annotating a page of the orders list.
 * @returns {Map<number, object>} receipt_id → intent row (only those that exist).
 */
function getIntents(db, receiptIds) {
	const ids = [...new Set((receiptIds || []).map(Number).filter(Number.isInteger))]
	const out = new Map()
	if (!ids.length) return out
	// receipt_ids are integers from our own DB, so inlining them keeps us clear
	// of SQLite's host-parameter ceiling on a large page.
	const rows = db.prepare(`SELECT * FROM etsy_completion_intents WHERE receipt_id IN (${ids.join(',')})`).all()
	for (const row of rows) out.set(row.receipt_id, row)
	return out
}

/**
 * Record (or refresh) the obligation to complete an order on Etsy.
 *
 * Idempotent by design — it is called on every 4PX shipment creation, by the
 * orphan sweep, and by the operator's "Complete now" button:
 *
 *   • no row          → insert, first attempt due after `graceSec`.
 *   • `pending` row   → refresh the tracking number; bring the attempt forward
 *                       only when the caller explicitly asks (`expedite`).
 *   • `done` row      → NO-OP. The buyer has already been notified; re-arming
 *                       this is how you double-notify. Only `revive` overrides.
 *   • `dead`/`skipped`→ untouched unless `revive` (an operator retry), which
 *                       resets the attempt counter for a clean run.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object}  opts
 * @param {number}  opts.receiptId
 * @param {string}  [opts.trackingCode]
 * @param {string}  [opts.carrierName='4PX']
 * @param {string}  [opts.origin='fourpx']   Provenance, for diagnostics.
 * @param {number}  [opts.now]
 * @param {number}  [opts.graceSec=FIRST_ATTEMPT_GRACE_SEC]
 * @param {boolean} [opts.expedite=false]    Make an existing pending intent due now.
 * @param {boolean} [opts.revive=false]      Re-arm a done/dead/skipped intent.
 * @returns {{ created: boolean, changed: boolean, intent: object|null }}
 */
function enqueue(db, opts = {}) {
	const receiptId = Number(opts.receiptId)
	if (!Number.isInteger(receiptId)) throw new TypeError('enqueue: receiptId must be an integer')

	const now = Number.isFinite(opts.now) ? opts.now : _nowSec()
	const graceSec = Number.isFinite(opts.graceSec) ? opts.graceSec : FIRST_ATTEMPT_GRACE_SEC
	const tracking = String(opts.trackingCode ?? '').trim() || null
	const carrier = String(opts.carrierName ?? '').trim() || '4PX'
	const origin = String(opts.origin ?? '').trim() || 'fourpx'

	const existing = getIntent(db, receiptId)

	if (!existing) {
		db.prepare(
			`INSERT INTO etsy_completion_intents
         (receipt_id, state, tracking_code, carrier_name, origin,
          attempts, next_attempt_at, lease_until, created_at, updated_at)
       VALUES (@receiptId, '${STATE.PENDING}', @tracking, @carrier, @origin,
               0, @dueAt, 0, @now, @now)`,
		).run({ receiptId, tracking, carrier, origin, dueAt: now + Math.max(0, graceSec), now })
		return { created: true, changed: true, intent: getIntent(db, receiptId) }
	}

	const isSettled = existing.state !== STATE.PENDING
	if (isSettled && !opts.revive) return { created: false, changed: false, intent: existing }

	const reviving = isSettled && opts.revive === true
	db.prepare(
		`UPDATE etsy_completion_intents SET
       state           = '${STATE.PENDING}',
       tracking_code   = COALESCE(@tracking, tracking_code),
       carrier_name    = @carrier,
       origin          = @origin,
       attempts        = CASE WHEN @reviving = 1 THEN 0 ELSE attempts END,
       next_attempt_at = CASE WHEN @reviving = 1 OR @expedite = 1 THEN @dueNow ELSE next_attempt_at END,
       lease_until     = CASE WHEN @reviving = 1 OR @expedite = 1 THEN 0 ELSE lease_until END,
       last_error      = CASE WHEN @reviving = 1 THEN NULL ELSE last_error END,
       settled_at      = NULL,
       updated_at      = @now
     WHERE receipt_id  = @receiptId`,
	).run({
		receiptId,
		tracking,
		carrier,
		origin,
		reviving: reviving ? 1 : 0,
		expedite: opts.expedite ? 1 : 0,
		dueNow: now,
		now,
	})
	return { created: false, changed: true, intent: getIntent(db, receiptId) }
}

/**
 * Settle an intent as completed. Safe to call from every completion path
 * (ship modal, bulk complete, browser auto-complete, reconciler) — including
 * when no intent exists, which is the normal case for a plain manual ship.
 *
 * @returns {boolean} whether a row was updated.
 */
function markDone(db, receiptId, { now = _nowSec(), trackingCode = null } = {}) {
	const info = db
		.prepare(
			`UPDATE etsy_completion_intents SET
         state         = '${STATE.DONE}',
         tracking_code = COALESCE(@tracking, tracking_code),
         lease_until   = 0,
         last_error    = NULL,
         settled_at    = @now,
         updated_at    = @now
       WHERE receipt_id = @receiptId AND state <> '${STATE.DONE}'`,
		)
		.run({ receiptId: Number(receiptId), now, tracking: String(trackingCode ?? '').trim() || null })
	return info.changes > 0
}

/**
 * Retire an intent that no longer applies — the order was cancelled or fully
 * refunded, so completing it on Etsy would be wrong. Distinct from `dead`
 * because nothing is broken and nobody needs to act.
 */
function markSkipped(db, receiptId, { now = _nowSec(), reason = '' } = {}) {
	const info = db
		.prepare(
			`UPDATE etsy_completion_intents SET
         state       = '${STATE.SKIPPED}',
         lease_until = 0,
         last_error  = @reason,
         settled_at  = @now,
         updated_at  = @now
       WHERE receipt_id = @receiptId AND state = '${STATE.PENDING}'`,
		)
		.run({ receiptId: Number(receiptId), now, reason: String(reason || '') || null })
	return info.changes > 0
}

/**
 * Record a failed attempt and schedule the next one — or dead-letter the intent
 * when the failure is permanent or the budget is exhausted.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} receiptId
 * @param {object} opts
 * @param {string} opts.error                Human-readable reason, shown in the UI.
 * @param {boolean} [opts.permanent=false]   Skip the remaining attempts.
 * @param {number} [opts.now]
 * @param {() => number} [opts.random]       Injectable RNG for the backoff jitter.
 * @returns {{ state: string, attempts: number, nextAttemptAt: number|null }}
 */
function markFailed(db, receiptId, { error = '', permanent = false, now = _nowSec(), random = Math.random } = {}) {
	const rid = Number(receiptId)
	const current = getIntent(db, rid)
	if (!current) return { state: STATE.DONE, attempts: 0, nextAttemptAt: null }

	const attempts = (current.attempts || 0) + 1
	const exhausted = attempts >= MAX_ATTEMPTS
	const dead = permanent || exhausted
	const nextAttemptAt = dead ? current.next_attempt_at : now + backoffDelaySec(attempts, { random })

	db.prepare(
		`UPDATE etsy_completion_intents SET
       state           = @state,
       attempts        = @attempts,
       next_attempt_at = @nextAttemptAt,
       lease_until     = 0,
       last_attempt_at = @now,
       last_error      = @error,
       settled_at      = CASE WHEN @state = '${STATE.DEAD}' THEN @now ELSE NULL END,
       updated_at      = @now
     WHERE receipt_id  = @receiptId`,
	).run({
		receiptId: rid,
		state: dead ? STATE.DEAD : STATE.PENDING,
		attempts,
		nextAttemptAt,
		now,
		error: String(error || '').slice(0, 500) || null,
	})

	return { state: dead ? STATE.DEAD : STATE.PENDING, attempts, nextAttemptAt: dead ? null : nextAttemptAt }
}

/**
 * Atomically lease the next batch of due intents.
 *
 * Leasing (rather than deleting or flipping a flag) is what makes a crashed or
 * killed sweep harmless: the obligation stays `pending` and simply becomes
 * claimable again once the lease lapses. Two processes sharing the DB — the
 * dashboard and a standalone worker — can therefore both run this safely.
 *
 * @returns {object[]} the claimed intent rows, oldest-due first.
 */
function claimDue(db, { now = _nowSec(), limit = 5, leaseSec = DEFAULT_LEASE_SEC } = {}) {
	const cap = Math.max(1, Math.trunc(limit))
	const claim = db.transaction(() => {
		const due = db
			.prepare(
				`SELECT * FROM etsy_completion_intents
         WHERE state = '${STATE.PENDING}' AND next_attempt_at <= @now AND lease_until <= @now
         ORDER BY next_attempt_at ASC, receipt_id ASC
         LIMIT @cap`,
			)
			.all({ now, cap })
		if (!due.length) return []
		const lease = db.prepare('UPDATE etsy_completion_intents SET lease_until = @until, updated_at = @now WHERE receipt_id = @receiptId')
		for (const row of due) lease.run({ receiptId: row.receipt_id, until: now + leaseSec, now })
		return due
	})
	return claim()
}

/** Drop a lease without recording an attempt (e.g. the sweep is shutting down). */
function releaseClaim(db, receiptId, { now = _nowSec() } = {}) {
	db.prepare(`UPDATE etsy_completion_intents SET lease_until = 0, updated_at = @now WHERE receipt_id = @receiptId AND state = '${STATE.PENDING}'`).run({
		receiptId: Number(receiptId),
		now,
	})
}

/**
 * Back-fill intents for orders that hold a 4PX shipment but were never
 * completed on Etsy — the exact population `scripts/complete-4px-pending.js`
 * was written to rescue by hand. This is what heals orders stranded by the old
 * browser-driven flow, by the bulk CLI, or by a crash between the two phases.
 *
 * WHY THE AGE WINDOW EXISTS
 * Shipping is not a silent operation: completing an order emails the buyer.
 * Auto-completing a label created months ago would spray confusing "your order
 * shipped" notices for parcels that were long since resolved some other way —
 * and mass buyer-notification bursts are precisely the pattern Etsy's anti-abuse
 * systems watch. So automation owns the recent, unambiguous window; anything
 * older stays visible in the UI (the order card still shows the unfinished 4PX
 * shipment) and needs a deliberate human click.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @param {number} [opts.maxAgeSec=ADOPT_MAX_AGE_SEC]
 * @param {number} [opts.limit=200]
 * @param {number} [opts.graceSec=0]  Due immediately by default — these are already late.
 * @returns {number} how many intents were created.
 */
function adoptOrphans(db, { now = _nowSec(), maxAgeSec = ADOPT_MAX_AGE_SEC, limit = 200, graceSec = 0 } = {}) {
	const cutoff = now - Math.max(0, maxAgeSec)
	const rows = db
		.prepare(
			`SELECT r.receipt_id, r.tracking_code, r.fourpx_tracking_no, r.fourpx_consignment_no
       FROM receipts r
       LEFT JOIN etsy_completion_intents i ON i.receipt_id = r.receipt_id
       WHERE r.is_shipped = 0
         AND i.receipt_id IS NULL
         AND r.status NOT IN (${CANCELLED_SQL_LIST})
         AND COALESCE(r.fourpx_order_status, '') <> 'cancelled'
         AND (r.fourpx_tracking_no IS NOT NULL OR r.fourpx_consignment_no IS NOT NULL OR r.tracking_code LIKE '4PX%')
         AND COALESCE(r.fourpx_created_at, r.etsy_created_at, 0) >= @cutoff
       ORDER BY r.receipt_id ASC
       LIMIT @limit`,
		)
		.all({ cutoff, limit: Math.max(1, Math.trunc(limit)) })

	let created = 0
	for (const row of rows) {
		const tracking = resolveTracking(row)
		if (!tracking) continue
		const res = enqueue(db, { receiptId: row.receipt_id, trackingCode: tracking, origin: 'adopted', now, graceSec })
		if (res.created) created++
	}
	return created
}

/**
 * Counts for the operator-facing banner and for logs.
 * `due` is the subset of `pending` that is actionable right now.
 */
function summarize(db, { now = _nowSec() } = {}) {
	const row = db
		.prepare(
			`SELECT
         SUM(CASE WHEN state = '${STATE.PENDING}' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN state = '${STATE.PENDING}' AND next_attempt_at <= @now THEN 1 ELSE 0 END) AS due,
         SUM(CASE WHEN state = '${STATE.DEAD}' THEN 1 ELSE 0 END) AS dead
       FROM etsy_completion_intents`,
		)
		.get({ now })
	return { pending: row?.pending || 0, due: row?.due || 0, dead: row?.dead || 0 }
}

/**
 * Is this intent worth putting in front of a human yet?
 *
 * The happy path is fast: the browser creates the label, the intent lands with a
 * short grace window, and the very next request completes it — all inside a few
 * seconds. Surfacing "not completed on Etsy" during that window would flash a
 * scary warning on every single normal shipment, which trains operators to
 * ignore the warning entirely. So an intent only becomes *stranded* once the
 * fast path has demonstrably missed: either a server attempt already failed
 * (`attempts > 0`) or the grace window elapsed with the intent still open.
 *
 * Dead intents are always stranded — they have stopped retrying by definition.
 *
 * @param {object|null} intent
 * @param {number} [now]
 * @returns {boolean}
 */
function isStranded(intent, now = _nowSec()) {
	if (!intent) return false
	if (intent.state === STATE.DEAD) return true
	if (intent.state !== STATE.PENDING) return false
	return (intent.attempts || 0) > 0 || (intent.next_attempt_at || 0) <= now
}

/**
 * How many orders currently hold a live 4PX shipment that Etsy still does not
 * know about, counted from the orders themselves rather than from the ledger so
 * that pre-ledger stragglers (older than the adoption window, so never adopted)
 * are included. This is the number the recovery banner shows, and it is exactly
 * the set of cards that render a completion chip.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @returns {number}
 */
function countStranded(db, { now = _nowSec() } = {}) {
	const row = db
		.prepare(
			`SELECT COUNT(*) AS n
       FROM receipts r
       LEFT JOIN etsy_completion_intents i ON i.receipt_id = r.receipt_id
       WHERE r.is_shipped = 0
         AND r.status NOT IN (${CANCELLED_SQL_LIST})
         AND COALESCE(r.fourpx_order_status, '') <> 'cancelled'
         AND (r.fourpx_tracking_no IS NOT NULL OR r.fourpx_consignment_no IS NOT NULL OR r.tracking_code LIKE '4PX%')
         AND (
           i.receipt_id IS NULL
           OR i.state = '${STATE.DEAD}'
           OR (i.state = '${STATE.PENDING}' AND (i.attempts > 0 OR i.next_attempt_at <= @now))
         )`,
		)
		.get({ now })
	return row?.n || 0
}

/**
 * Shape an intent row for the API / UI. Returns null for settled-and-boring
 * states so a completed order carries no extra payload.
 *
 * `stranded` tells the UI whether to actually draw attention to this order; see
 * {@link isStranded}. A pending-but-not-stranded intent is still reported so the
 * client can tell "the normal flow is mid-flight" apart from "this order has a
 * label and no ledger entry at all", which are rendered very differently.
 *
 * @param {object|null} intent
 * @param {number} [now]
 * @returns {{ state: string, stranded: boolean, attempts: number, next_attempt_at: number|null,
 *             retry_in_sec: number|null, last_error: string|null, origin: string }|null}
 */
function shapeForApi(intent, now = _nowSec()) {
	if (!intent || intent.state === STATE.DONE || intent.state === STATE.SKIPPED) return null
	const nextAt = intent.state === STATE.PENDING ? intent.next_attempt_at : null
	return {
		state: intent.state,
		stranded: isStranded(intent, now),
		attempts: intent.attempts || 0,
		next_attempt_at: nextAt,
		retry_in_sec: nextAt != null ? Math.max(0, nextAt - now) : null,
		last_error: intent.last_error || null,
		origin: intent.origin || 'fourpx',
	}
}

module.exports = {
	ETSY_COMPLETION_SCHEMA_SQL,
	STATE,
	RETRY_BACKOFF_SEC,
	MAX_ATTEMPTS,
	DEFAULT_LEASE_SEC,
	FIRST_ATTEMPT_GRACE_SEC,
	ADOPT_MAX_AGE_SEC,
	CANCELLED_STATUSES,
	ensureSchema,
	backoffDelaySec,
	resolveTracking,
	isTerminalStatus,
	classifyCompletionError,
	getIntent,
	getIntents,
	enqueue,
	markDone,
	markSkipped,
	markFailed,
	claimDue,
	releaseClaim,
	adoptOrphans,
	summarize,
	isStranded,
	countStranded,
	shapeForApi,
}
