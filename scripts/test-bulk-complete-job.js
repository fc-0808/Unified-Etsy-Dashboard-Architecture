'use strict'

/**
 * The 4PX "Complete on Etsy" batch must survive a dropped HTTP connection.
 *
 * Completing used to hold one request open for the whole paced run and write
 * nothing until the end. A tunnel idle-timeout or a process restart killed
 * that request, and the browser started the entire batch over. This suite
 * locks the replacement: a job row is the source of truth, the drain survives
 * a kill, a retry attaches to the in-flight job, and pacing follows real
 * Etsy writes rather than idempotent skips.
 *
 * Run: node scripts/test-bulk-complete-job.js
 */

const Database = require('better-sqlite3')
const jobs = require('../src/orders/bulk-complete-job')

let failures = 0
function assert(cond, msg) {
	if (cond) console.log(`  ok  — ${msg}`)
	else {
		failures++
		console.error(`  FAIL — ${msg}`)
	}
}
function section(title) {
	console.log(`\n  ${title}`)
}

function memoryDb() {
	const db = new Database(':memory:')
	jobs.ensureSchema(db)
	return db
}

function order(id, tracking = `4PX${id}`, carrier = '4PX') {
	return { receipt_id: id, tracking_code: tracking, carrier_name: carrier }
}

async function main() {

function states(db, jobId) {
	return db
		.prepare(`SELECT receipt_id, state, error FROM etsy_bulk_complete_items WHERE job_id = ? ORDER BY position`)
		.all(jobId)
		.map((r) => `${r.receipt_id}:${r.state}${r.error ? '(' + r.error + ')' : ''}`)
		.join(' ')
}

section('validation')
{
	const db = memoryDb()
	for (const [label, input] of [
		['empty', []],
		['missing tracking', [{ receipt_id: 5, tracking_code: '  ' }]],
		['bad id', [{ receipt_id: 'nope', tracking_code: '4PX1' }]],
		['duplicate', [order(1), order(1)]],
	]) {
		let threw = false
		try {
			jobs.startJob(db, { orders: input })
		} catch (err) {
			threw = err.status === 400
		}
		assert(threw, `${label} is rejected before a job exists`)
	}
	let tooBig = null
	try {
		jobs.startJob(db, { orders: [order(1), order(2), order(3)], max: 2 })
	} catch (err) {
		tooBig = err
	}
	assert(tooBig && tooBig.status === 400 && /safety ceiling/.test(tooBig.message), 'over the ceiling is a 400, not a partial job')
	assert(db.prepare(`SELECT COUNT(*) AS n FROM etsy_bulk_complete_jobs`).get().n === 0, 'rejected batches write nothing')
}

section('a job is the whole batch, and a second POST attaches')
{
	const db = memoryDb()
	const orders = [order(11), order(10), order(12)]
	const first = jobs.startJob(db, { orders, now: 1_700_000_000_000 })
	assert(first.attached === false, 'the first POST creates a job')
	assert(first.job.status === 'running', 'a new job is running')
	assert(first.job.total === 3, 'total is the batch size')
	const positions = db.prepare(`SELECT receipt_id FROM etsy_bulk_complete_items WHERE job_id = ? ORDER BY position`).all(first.job.id)
	assert(positions.map((r) => r.receipt_id).join(',') === '11,10,12', 'ship order follows the operator, not the fingerprint sort')

	const again = jobs.startJob(db, { orders: [order(12), order(11), order(10)], now: 1_700_000_000_000 })
	assert(again.attached === true && again.job.id === first.job.id, 'the same orders in a different order reattach')
	assert(db.prepare(`SELECT COUNT(*) AS n FROM etsy_bulk_complete_jobs`).get().n === 1, 'reattach does not open a second paced loop')

	const changed = jobs.startJob(db, { orders: [order(11, '4PXDIFFERENT'), order(10), order(12)] })
	assert(changed.attached === false && changed.job.id !== first.job.id, 'a changed tracking number is a different run')
}

section('drain paces real writes, records failures, and keeps going')
{
	const db = memoryDb()
	const { job } = jobs.startJob(db, { orders: [order(1), order(2), order(3), order(4)] })
	const sleeps = []
	const shipped = []
	await jobs.runQueue(db, {
		pace: { chunkSize: 2, interRequestMs: 2000, interBatchMs: 15000 },
		sleep: async (ms) => {
			sleeps.push(ms)
		},
		ship: async (item) => {
			shipped.push(item.receipt_id)
			if (item.receipt_id === 2) return { skipped: true }
			if (item.receipt_id === 3) {
				const err = new Error('ignored')
				err.response = { data: { error: 'Etsy said no' } }
				throw err
			}
			return { skipped: false }
		},
	})
	assert(shipped.join(',') === '1,2,3,4', 'one failure does not stop the rest, and order is preserved')
	assert(states(db, job.id) === '1:done 2:skipped 3:failed(Etsy said no) 4:done', 'done, skipped, and failed are distinct')
	// Pause is chosen from writes already recorded. Receipt 1 is the first real
	// write (no pause). Receipt 2 is a skip and receipt 3 fails, so neither
	// becomes `done`. Receipts 2, 3, and 4 each see exactly one completed write
	// and wait 2000. The chunk cooldown (every 2nd completion) never fires.
	assert(sleeps.join(',') === '2000,2000,2000', `pauses sit only in front of later real attempts (got ${sleeps.join(',')})`)

	const snap = jobs.snapshot(db, job.id)
	assert(snap.status === 'done', 'the job finishes when every row is terminal')
	assert(snap.completed === 3 && snap.skipped === 1 && snap.failed === 1 && snap.pending === 0, 'counts match the old bulk-complete response')
	assert(snap.success === false, 'a failure keeps success false')
	assert(snap.results[2].error === 'Etsy said no' && snap.results[2].success === false, 'the Etsy body is the error the operator sees')
}

section('chunk cooldown counts completed writes, not skips')
{
	const db = memoryDb()
	jobs.startJob(db, { orders: [order(1), order(2), order(3)] })
	const sleeps = []
	await jobs.runQueue(db, {
		pace: { chunkSize: 2, interRequestMs: 100, interBatchMs: 1000 },
		sleep: async (ms) => sleeps.push(ms),
		ship: async () => ({ skipped: false }),
	})
	// Before #1: 0 done, no sleep. Before #2: 1 done, 100. Before #3: 2 done, 100+1000.
	assert(sleeps.join(',') === '100,1100', `the chunk pause arrives on the write after a full chunk (got ${sleeps.join(',')})`)
}

section('a kill mid-ship resumes, and an already-accepted ship is a skip')
{
	const db = memoryDb()
	const { job } = jobs.startJob(db, { orders: [order(7), order(8)] })
	db.prepare(`UPDATE etsy_bulk_complete_items SET state = 'shipping' WHERE receipt_id = 7`).run()
	const recovered = jobs.recoverInterrupted(db)
	assert(recovered === 1, 'the in-flight row is returned to the queue')
	assert(db.prepare(`SELECT state FROM etsy_bulk_complete_items WHERE receipt_id = 7`).get().state === 'queued', 'it is queued, not stuck shipping')

	const seen = []
	await jobs.runQueue(db, {
		pace: { chunkSize: 50, interRequestMs: 2000, interBatchMs: 15000 },
		sleep: async () => {
			throw new Error('this batch has no completed write yet, so it must not pause')
		},
		ship: async (item) => {
			seen.push(item.receipt_id)
			return { skipped: item.receipt_id === 7 }
		},
	})
	assert(seen.join(',') === '7,8', 'resume ships the interrupted order first')
	assert(states(db, job.id) === '7:skipped 8:done', 'the interrupted order is recorded as already shipped')
	assert(jobs.snapshot(db, job.id).success === true, 'a fully skipped-or-done batch is a success')
}

section('one hung order does not freeze the queue')
{
	const db = memoryDb()
	const { job } = jobs.startJob(db, { orders: [order(1), order(2)] })
	await jobs.runQueue(db, {
		itemTimeoutMs: 30,
		pace: { chunkSize: 50, interRequestMs: 0, interBatchMs: 0 },
		sleep: async () => {},
		ship: (item) => (item.receipt_id === 1 ? new Promise(() => {}) : { skipped: false }),
	})
	const snap = jobs.snapshot(db, job.id)
	assert(snap.results[0].state === 'failed' && /timed out/.test(snap.results[0].error), 'the hung order is recorded as failed')
	assert(snap.results[1].state === 'done', 'the next order still completes')
	assert(snap.status === 'done', 'the job does not stay running forever')
}

section('retry after a partial failure starts a new run; a lost success poll does not')
{
	const db = memoryDb()
	const orders = [order(1), order(2)]
	const t0 = 1_800_000_000_000
	const first = jobs.startJob(db, { orders, now: t0 })
	await jobs.runQueue(db, {
		pace: { chunkSize: 50, interRequestMs: 0, interBatchMs: 0 },
		sleep: async () => {},
		ship: async (item) => {
			if (item.receipt_id === 2) throw new Error('nope')
			return { skipped: false }
		},
	})
	const retry = jobs.startJob(db, { orders, now: t0 + 1000 })
	assert(retry.attached === false && retry.job.id !== first.job.id, 'Retry after a failure does real work again')

	const clean = jobs.startJob(db, { orders: [order(3)], now: t0 })
	await jobs.runQueue(db, {
		now: t0,
		pace: { chunkSize: 50, interRequestMs: 0, interBatchMs: 0 },
		sleep: async () => {},
		ship: async () => ({ skipped: false }),
	})
	const lostPoll = jobs.startJob(db, { orders: [order(3)], now: t0 + 60_000 })
	assert(lostPoll.attached === true && lostPoll.job.id === clean.job.id, 'a successful run is reattached inside the window')
	const later = jobs.startJob(db, { orders: [order(3)], now: t0 + (jobs.REATTACH_SUCCESS_SEC + 5) * 1000 })
	assert(later.attached === false, 'after the window, the same orders are a new run')
}

section('two jobs share one paced drain, oldest first')
{
	const db = memoryDb()
	const a = jobs.startJob(db, { orders: [order(1), order(2)], now: 1_000_000 })
	const b = jobs.startJob(db, { orders: [order(3)], now: 2_000_000 })
	const seen = []
	await jobs.runQueue(db, {
		pace: { chunkSize: 50, interRequestMs: 0, interBatchMs: 0 },
		sleep: async () => {},
		ship: async (item) => {
			seen.push(item.receipt_id)
			return { skipped: false }
		},
	})
	assert(seen.join(',') === '1,2,3', 'the older job finishes before the next one starts')
	assert(jobs.snapshot(db, a.job.id).status === 'done' && jobs.snapshot(db, b.job.id).status === 'done', 'both jobs finish')
}

section('kick picks up a job that arrives mid-run and does not double-drain')
{
	jobs.resetRunnerForTests()
	const db = memoryDb()
	let release
	const gate = new Promise((resolve) => {
		release = resolve
	})
	let calls = 0
	const { job } = jobs.startJob(db, { orders: [order(1)] })
	const running = jobs.kick(db, {
		pace: { chunkSize: 50, interRequestMs: 0, interBatchMs: 0 },
		sleep: async () => {},
		ship: async (item) => {
			calls++
			if (item.receipt_id === 1) await gate
			return { skipped: false }
		},
	})
	const second = jobs.kick(db, {
		pace: { chunkSize: 50, interRequestMs: 0, interBatchMs: 0 },
		sleep: async () => {},
		ship: async () => {
			calls++
			return { skipped: false }
		},
	})
	assert(second === running, 'a second kick joins the in-flight drain')
	jobs.startJob(db, { orders: [order(2)] })
	release()
	await running
	assert(calls === 2, 'both orders ship exactly once')
	assert(jobs.snapshot(db, job.id).status === 'done', 'the first job finished')
	assert(
		db.prepare(`SELECT COUNT(*) AS n FROM etsy_bulk_complete_items WHERE state = 'done'`).get().n === 2,
		'the job created while the first order was in flight was drained too',
	)
}

section('old finished jobs are pruned; a recent one is kept')
{
	const db = memoryDb()
	const old = jobs.startJob(db, { orders: [order(1)], now: 1_000 * 1000 })
	db.prepare(`UPDATE etsy_bulk_complete_jobs SET status = 'done', finished_at = ? WHERE id = ?`).run(1_000, old.job.id)
	const recentSec = 2_000_000
	const recent = jobs.startJob(db, { orders: [order(2)], now: (recentSec - 100) * 1000 })
	db.prepare(`UPDATE etsy_bulk_complete_jobs SET status = 'done', finished_at = ? WHERE id = ?`).run(recentSec - 100, recent.job.id)
	jobs.startJob(db, { orders: [order(3)], now: recentSec * 1000 })
	const ids = db
		.prepare(`SELECT id FROM etsy_bulk_complete_jobs`)
		.all()
		.map((r) => r.id)
	assert(!ids.includes(old.job.id), 'a job finished more than two weeks ago is gone')
	assert(ids.includes(recent.job.id), 'a recent finished job is still there to reattach to')
}

section('hold window grows with the batch and stays bounded')
{
	assert(jobs.bulkIntentHoldSec(1) === 145, 'a single order holds the reconciler for a couple of minutes')
	assert(jobs.bulkIntentHoldSec(1000) === 6 * 3600, 'a huge batch caps the hold at six hours')
}

	if (failures) {
		console.error(`\n${failures} assertion(s) failed`)
		process.exit(1)
	}
	console.log('\nAll bulk-complete job assertions passed.')
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
