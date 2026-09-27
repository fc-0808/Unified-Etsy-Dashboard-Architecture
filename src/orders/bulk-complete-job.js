'use strict'

/**
 * bulk-complete-job.js — durable runner for "Complete on Etsy" after Ship with 4PX.
 *
 * THE BUG THIS EXISTS TO KILL
 * ----------------------------------------------------------------------------
 * Completing a batch used to be one HTTP request that stayed open for the whole
 * paced run (about 2s between orders, plus the Etsy call, plus a longer pause
 * every 50). The handler wrote nothing until the last order finished. Cloudflare
 * Tunnel, carrier proxies, and a PM2 restart all treat a silent socket as dead
 * — typically around 100s. The browser then saw "Failed to fetch", announced
 * that the server was restarting, and re-POSTed the entire batch. Each retry
 * was another silent request longer than the tunnel timeout, so a normal
 * afternoon batch could not finish.
 *
 * A browser tab is not a place to hold a multi-minute fulfilment run.
 *
 * THE PATTERN
 * ----------------------------------------------------------------------------
 * POST creates a job and returns immediately. This process drains the job one
 * order at a time, with the same pacing used for bulk ships, and
 * writes each outcome to SQLite before starting the next order. The page polls
 * a short GET. If that poll fails, only the poll is retried — the work does
 * not start over. If the process is killed, the next boot puts any in-flight
 * row back to queued and continues. Re-POSTing the same orders while the job
 * is running (the response was lost, or the operator pressed Retry) attaches
 * to that job instead of opening a second paced loop.
 *
 * Buyer notification stays safe because every ship goes through
 * `shipEtsyReceipt`, which is idempotent on the tracking number and de-dupes
 * a receipt already in flight in this process. A row left `shipping` by a
 * hard kill is resumed, and the resume sees the order already shipped.
 *
 * DESIGN NOTES
 * ----------------------------------------------------------------------------
 *   • SQL plus a single-flight drain. No Express. scripts/test-bulk-complete-job.js
 *     drives it with a fake ship function.
 *   • One running job per fingerprint. The fingerprint is the set of
 *     (receipt, tracking, carrier), so order in the payload does not matter
 *     and a changed tracking number is a different run.
 *   • Pacing counts real Etsy writes (`done`), not idempotent skips. A retry
 *     that is mostly "already shipped" does not sit through a 2s pause per skip.
 *   • Finished jobs are kept for two weeks so a lost final poll can still
 *     reattach to a fully successful run, then pruned.
 */

const crypto = require('crypto')

const {
	BULK_SHIP_CHUNK_SIZE,
	BULK_SHIP_INTER_REQUEST_MS,
	BULK_SHIP_INTER_BATCH_MS,
	BULK_SHIP_ABSOLUTE_MAX,
} = require('../compliance/suspension-guard')

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS etsy_bulk_complete_jobs (
    id            TEXT    PRIMARY KEY,
    fingerprint   TEXT    NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'running',
    carrier_name  TEXT    NOT NULL DEFAULT '4PX',
    total         INTEGER NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    finished_at   INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_etsy_bulk_complete_jobs_fp
    ON etsy_bulk_complete_jobs(fingerprint, status, created_at);

  -- One in-flight run per order set. A second POST attaches instead of
  -- starting a parallel paced loop (two loops would double the Etsy write rate).
  CREATE UNIQUE INDEX IF NOT EXISTS idx_etsy_bulk_complete_one_running
    ON etsy_bulk_complete_jobs(fingerprint) WHERE status = 'running';

  CREATE TABLE IF NOT EXISTS etsy_bulk_complete_items (
    job_id         TEXT    NOT NULL,
    receipt_id     INTEGER NOT NULL,
    tracking_code  TEXT    NOT NULL,
    carrier_name   TEXT    NOT NULL,
    position       INTEGER NOT NULL,
    state          TEXT    NOT NULL DEFAULT 'queued',
    error          TEXT,
    updated_at     INTEGER NOT NULL,
    PRIMARY KEY (job_id, receipt_id)
  );

  CREATE INDEX IF NOT EXISTS idx_etsy_bulk_complete_items_state
    ON etsy_bulk_complete_items(state, position);
`

/** How long a fully successful identical run can be reattached to. */
const REATTACH_SUCCESS_SEC = 15 * 60

/** Finished jobs older than this are deleted so the table cannot grow without bound. */
const RETAIN_SEC = 14 * 24 * 3600

/**
 * One Etsy call that never comes back must not freeze every later order.
 * The underlying request keeps its own timeout; this is the queue's backstop.
 */
const DEFAULT_ITEM_TIMEOUT_MS = 180_000

const DEFAULT_PACE = Object.freeze({
	chunkSize: BULK_SHIP_CHUNK_SIZE,
	interRequestMs: BULK_SHIP_INTER_REQUEST_MS,
	interBatchMs: BULK_SHIP_INTER_BATCH_MS,
})

const _ready = new WeakSet()

function jobError(message, status = 400) {
	const err = new Error(message)
	err.status = status
	return err
}

function nowSec(now) {
	const ms = typeof now === 'function' ? now() : Number.isFinite(now) ? now : Date.now()
	return Math.floor(ms / 1000)
}

function ensureSchema(db) {
	db.exec(SCHEMA_SQL)
}

function ready(db) {
	if (_ready.has(db)) return
	ensureSchema(db)
	_ready.add(db)
}

/**
 * Identity of a batch. Sorted, so the same orders in a different order — the
 * usual shape of a retry — hit the same job.
 *
 * @param {{ receipt_id: number, tracking_code: string, carrier_name: string }[]} orders
 */
function fingerprintOrders(orders) {
	const lines = orders
		.map((o) => `${o.receipt_id}\t${o.tracking_code}\t${o.carrier_name}`)
		.sort()
	return crypto.createHash('sha256').update(lines.join('\n')).digest('hex')
}

function normalizeBatch(orders, { max = BULK_SHIP_ABSOLUTE_MAX, carrierName = '4PX' } = {}) {
	if (!Array.isArray(orders) || orders.length === 0) {
		throw jobError('orders[] is required and must be non-empty')
	}
	if (orders.length > max) {
		throw jobError(
			`Received ${orders.length} orders, which exceeds the safety ceiling of ${max}. ` +
				'This looks like a malformed request — split it into separate completions.',
		)
	}
	const seen = new Set()
	const clean = []
	for (const raw of orders) {
		const receiptId = Number(raw?.receipt_id)
		if (!Number.isInteger(receiptId) || receiptId <= 0) throw jobError('Every order needs a receipt_id.')
		if (seen.has(receiptId)) throw jobError(`Order ${receiptId} appears more than once in this batch.`)
		seen.add(receiptId)
		const tracking = String(raw?.tracking_code ?? '').trim()
		if (!tracking) throw jobError(`Order ${receiptId} is missing a tracking number.`)
		if (tracking.length > 100) throw jobError(`Order ${receiptId} has a tracking number that is too long.`)
		const carrier = String(raw?.carrier_name || carrierName || '4PX').trim() || '4PX'
		if (carrier.length > 80) throw jobError('Carrier name is too long.')
		clean.push({ receipt_id: receiptId, tracking_code: tracking, carrier_name: carrier })
	}
	return clean
}

function pruneFinished(db, sec) {
	const cutoff = sec - RETAIN_SEC
	const old = db.prepare(`SELECT id FROM etsy_bulk_complete_jobs WHERE status = 'done' AND finished_at IS NOT NULL AND finished_at < ?`).all(cutoff)
	if (!old.length) return 0
	const ids = old.map((r) => `'${r.id}'`).join(',')
	// ids are hex we generated, but still go through a parameter-free list only
	// after checking the shape, so a corrupted row cannot change the statement.
	if (!old.every((r) => /^[a-f0-9]{32}$/.test(r.id))) return 0
	db.prepare(`DELETE FROM etsy_bulk_complete_items WHERE job_id IN (${ids})`).run()
	return db.prepare(`DELETE FROM etsy_bulk_complete_jobs WHERE id IN (${ids})`).run().changes
}

function findRunning(db, fingerprint) {
	return db.prepare(`SELECT * FROM etsy_bulk_complete_jobs WHERE fingerprint = ? AND status = 'running' ORDER BY created_at DESC LIMIT 1`).get(fingerprint) || null
}

function findRecentSuccess(db, fingerprint, sec) {
	const row =
		db
			.prepare(
				`SELECT * FROM etsy_bulk_complete_jobs
         WHERE fingerprint = ? AND status = 'done' AND finished_at >= ?
         ORDER BY finished_at DESC LIMIT 1`,
			)
			.get(fingerprint, sec - REATTACH_SUCCESS_SEC) || null
	if (!row) return null
	const failed = db.prepare(`SELECT COUNT(*) AS n FROM etsy_bulk_complete_items WHERE job_id = ? AND state = 'failed'`).get(row.id).n
	// A run that still has failures must not be handed back as "the" result —
	// Retry exists to try those orders again. A clean run is safe to reattach
	// to, which is what a lost final poll looks like.
	return failed ? null : row
}

/**
 * Open a completion run, or attach to the one already covering this exact set.
 *
 * @returns {{ job: object, attached: boolean, orders: object[] }}
 */
function startJob(db, { orders, carrierName = '4PX', max = BULK_SHIP_ABSOLUTE_MAX, now = Date.now() } = {}) {
	ready(db)
	const clean = normalizeBatch(orders, { max, carrierName })
	const fingerprint = fingerprintOrders(clean)
	const sec = nowSec(now)

	const existing = findRunning(db, fingerprint) || findRecentSuccess(db, fingerprint, sec)
	if (existing) return { job: existing, attached: true, orders: clean }

	const id = crypto.randomBytes(16).toString('hex')
	const insertJob = db.prepare(
		`INSERT INTO etsy_bulk_complete_jobs
       (id, fingerprint, status, carrier_name, total, created_at, updated_at)
     VALUES (@id, @fingerprint, 'running', @carrier, @total, @sec, @sec)`,
	)
	const insertItem = db.prepare(
		`INSERT INTO etsy_bulk_complete_items
       (job_id, receipt_id, tracking_code, carrier_name, position, state, updated_at)
     VALUES (@jobId, @receiptId, @tracking, @carrier, @position, 'queued', @sec)`,
	)

	const tx = db.transaction(() => {
		pruneFinished(db, sec)
		// Lost the race with another request that inserted the same fingerprint
		// after our SELECT. Attach instead of failing the operator's click.
		const raced = findRunning(db, fingerprint)
		if (raced) return raced
		try {
			insertJob.run({ id, fingerprint, carrier: carrierName || '4PX', total: clean.length, sec })
		} catch (err) {
			if (!/UNIQUE/i.test(err.message || '')) throw err
			const winner = findRunning(db, fingerprint)
			if (winner) return winner
			throw err
		}
		for (let i = 0; i < clean.length; i++) {
			insertItem.run({
				jobId: id,
				receiptId: clean[i].receipt_id,
				tracking: clean[i].tracking_code,
				carrier: clean[i].carrier_name,
				position: i,
				sec,
			})
		}
		return null
	})

	const raced = tx()
	if (raced) return { job: raced, attached: true, orders: clean }
	return { job: db.prepare(`SELECT * FROM etsy_bulk_complete_jobs WHERE id = ?`).get(id), attached: false, orders: clean }
}

function snapshot(db, jobId) {
	ready(db)
	if (!jobId) return null
	const job = db.prepare(`SELECT * FROM etsy_bulk_complete_jobs WHERE id = ?`).get(String(jobId))
	if (!job) return null
	const items = db.prepare(`SELECT * FROM etsy_bulk_complete_items WHERE job_id = ? ORDER BY position ASC`).all(job.id)
	let done = 0
	let skipped = 0
	let failed = 0
	let pending = 0
	for (const item of items) {
		if (item.state === 'done') done++
		else if (item.state === 'skipped') skipped++
		else if (item.state === 'failed') failed++
		else pending++
	}
	return {
		job_id: job.id,
		status: job.status,
		total: job.total,
		completed: done + skipped,
		skipped,
		failed,
		pending,
		success: job.status === 'done' && failed === 0,
		results: items.map((item) => ({
			receipt_id: item.receipt_id,
			success: item.state === 'done' || item.state === 'skipped',
			tracking_code: item.tracking_code,
			skipped: item.state === 'skipped',
			error: item.state === 'failed' ? item.error || 'Failed' : null,
			state: item.state,
		})),
	}
}

/**
 * A hard kill leaves the row it was shipping marked `shipping`. Nothing in
 * this process is still working on it (boot, or the runner has exited), so
 * put it back. The next ship is idempotent if Etsy already accepted it.
 *
 * @returns {number} rows returned to the queue
 */
function recoverInterrupted(db, now = Date.now()) {
	ready(db)
	const info = db.prepare(`UPDATE etsy_bulk_complete_items SET state = 'queued', updated_at = ? WHERE state = 'shipping'`).run(nowSec(now))
	return info.changes
}

function claimNext(db, now = Date.now()) {
	ready(db)
	const sec = nowSec(now)
	const selectNext = db.prepare(
		`SELECT i.*
       FROM etsy_bulk_complete_items i
       JOIN etsy_bulk_complete_jobs j ON j.id = i.job_id
      WHERE j.status = 'running' AND i.state = 'queued'
      ORDER BY j.created_at ASC, i.position ASC
      LIMIT 1`,
	)
	const markShipping = db.prepare(
		`UPDATE etsy_bulk_complete_items
        SET state = 'shipping', updated_at = ?
      WHERE job_id = ? AND receipt_id = ? AND state = 'queued'`,
	)
	return db.transaction(() => {
		// Another connection can commit the row between the read and the write.
		// A lost race must try the next row. A hard cap keeps a row we can read
		// but not claim from spinning the drain; the next kick picks it up.
		for (let spins = 0; spins < 8; spins++) {
			const row = selectNext.get()
			if (!row) return null
			if (markShipping.run(sec, row.job_id, row.receipt_id).changes === 1) return row
		}
		return null
	})()
}

function countRealShips(db, jobId) {
	return db.prepare(`SELECT COUNT(*) AS n FROM etsy_bulk_complete_items WHERE job_id = ? AND state = 'done'`).get(jobId).n
}

/**
 * Delay before the next order, given how many real Etsy writes this job has
 * already made. Zero before the first write. Every later write waits
 * `interRequestMs`; every `chunkSize`-th write also waits `interBatchMs`.
 * Skips do not count — they never called Etsy.
 */
function paceDelayMs(realShipsAlreadyDone, pace = DEFAULT_PACE) {
	const n = Number(realShipsAlreadyDone) || 0
	if (n <= 0) return 0
	const chunk = Math.max(1, pace.chunkSize || DEFAULT_PACE.chunkSize)
	let ms = Math.max(0, pace.interRequestMs ?? DEFAULT_PACE.interRequestMs)
	if (n % chunk === 0) ms += Math.max(0, pace.interBatchMs ?? DEFAULT_PACE.interBatchMs)
	return ms
}

function failureMessage(err) {
	const body = err?.response?.data
	const fromBody = body && typeof body === 'object' ? body.error_description || body.error : null
	return String(fromBody || err?.message || 'Failed').slice(0, 500)
}

function recordItem(db, item, state, error, sec) {
	db.prepare(`UPDATE etsy_bulk_complete_items SET state = ?, error = ?, updated_at = ? WHERE job_id = ? AND receipt_id = ?`).run(state, error, sec, item.job_id, item.receipt_id)
	db.prepare(`UPDATE etsy_bulk_complete_jobs SET updated_at = ? WHERE id = ?`).run(sec, item.job_id)
}

function releaseItem(db, item, sec) {
	db.prepare(`UPDATE etsy_bulk_complete_items SET state = 'queued', updated_at = ? WHERE job_id = ? AND receipt_id = ? AND state = 'shipping'`).run(sec, item.job_id, item.receipt_id)
}

function finalizeDrainedJobs(db, sec) {
	const running = db.prepare(`SELECT id FROM etsy_bulk_complete_jobs WHERE status = 'running'`).all()
	const left = db.prepare(`SELECT COUNT(*) AS n FROM etsy_bulk_complete_items WHERE job_id = ? AND state IN ('queued', 'shipping')`)
	const mark = db.prepare(`UPDATE etsy_bulk_complete_jobs SET status = 'done', finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running'`)
	const finished = []
	for (const job of running) {
		if (left.get(job.id).n !== 0) continue
		if (mark.run(sec, sec, job.id).changes) finished.push(job.id)
	}
	return finished
}

function withTimeout(promise, ms, message) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			const err = new Error(message)
			err.code = 'ITEM_TIMEOUT'
			reject(err)
		}, ms)
		promise.then(
			(value) => {
				clearTimeout(timer)
				resolve(value)
			},
			(err) => {
				clearTimeout(timer)
				reject(err)
			},
		)
	})
}

/**
 * Drain every running job to completion. One order at a time, globally, so
 * two operators (or a retry overlapping a run) cannot exceed the paced rate.
 *
 * @param {object} deps
 * @param {(item: object) => Promise<{ skipped?: boolean }>} deps.ship
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {object} [deps.pace]
 * @param {number} [deps.itemTimeoutMs]
 * @param {number|function} [deps.now]
 * @param {(snapshot: object) => void} [deps.onFinished]
 * @param {(item: object, message: string) => void} [deps.onFailure]
 */
async function runQueue(db, deps) {
	ready(db)
	const pace = { ...DEFAULT_PACE, ...(deps.pace || {}) }
	const sleep = typeof deps.sleep === 'function' ? deps.sleep : (ms) => new Promise((r) => setTimeout(r, ms))
	const timeoutMs = Number.isFinite(deps.itemTimeoutMs) ? deps.itemTimeoutMs : DEFAULT_ITEM_TIMEOUT_MS
	const clock = deps.now

	for (;;) {
		const item = claimNext(db, clock)
		if (!item) {
			const finished = finalizeDrainedJobs(db, nowSec(clock))
			if (typeof deps.onFinished === 'function') {
				for (const id of finished) deps.onFinished(snapshot(db, id))
			}
			return
		}

		const delay = paceDelayMs(countRealShips(db, item.job_id), pace)
		try {
			if (delay) await sleep(delay)
			let outcome
			try {
				const shipped = deps.ship(item)
				outcome = timeoutMs > 0 ? await withTimeout(Promise.resolve(shipped), timeoutMs, `Completing order ${item.receipt_id} timed out.`) : await shipped
			} catch (err) {
				const message = failureMessage(err)
				recordItem(db, item, 'failed', message, nowSec(clock))
				if (typeof deps.onFailure === 'function') deps.onFailure(item, message)
				continue
			}
			const skipped = !!(outcome && outcome.skipped)
			recordItem(db, item, skipped ? 'skipped' : 'done', null, nowSec(clock))
		} catch (err) {
			// The pause itself failed, or recording did. Put the row back so a
			// restart of the drain can continue, then surface the fault.
			try {
				releaseItem(db, item, nowSec(clock))
			} catch {
				/* the next boot's recoverInterrupted covers a failed release */
			}
			throw err
		}
	}
}

let _running = false
let _again = false
let _inflight = null

/**
 * Start the drain if it is not already running. Calls made while a drain is
 * in progress set a flag so a job created mid-run is not left queued until
 * the next click. Returns the in-flight promise.
 */
function kick(db, deps) {
	ready(db)
	if (_running) {
		_again = true
		return _inflight
	}
	_running = true
	_inflight = (async () => {
		try {
			do {
				_again = false
				await runQueue(db, deps)
			} while (_again)
		} catch (err) {
			if (typeof deps.onRunnerError === 'function') deps.onRunnerError(err)
			else console.error('[4px/bulk] completion runner stopped:', err && err.message ? err.message : err)
		} finally {
			_running = false
			_inflight = null
		}
	})()
	return _inflight
}

function resetRunnerForTests() {
	_running = false
	_again = false
	_inflight = null
}

/**
 * How long to keep the background reconciler off these receipts while this
 * job is the thing shipping them. The sweep paces itself separately; running
 * both at once would double the buyer-notification rate. When the job
 * finishes, shipEtsyReceipt settles the intent. If the process dies, the
 * lease expires and the sweep is the safety net.
 */
function bulkIntentHoldSec(orderCount) {
	const n = Math.max(0, Number(orderCount) || 0)
	return Math.min(6 * 3600, 120 + n * 25)
}

module.exports = {
	SCHEMA_SQL,
	REATTACH_SUCCESS_SEC,
	RETAIN_SEC,
	DEFAULT_ITEM_TIMEOUT_MS,
	DEFAULT_PACE,
	BULK_SHIP_ABSOLUTE_MAX,
	ensureSchema,
	fingerprintOrders,
	normalizeBatch,
	startJob,
	snapshot,
	recoverInterrupted,
	claimNext,
	paceDelayMs,
	runQueue,
	kick,
	resetRunnerForTests,
	bulkIntentHoldSec,
	failureMessage,
}
