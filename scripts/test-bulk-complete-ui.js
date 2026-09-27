'use strict'

/**
 * The Ship-with-4PX wizard must not hold one HTTP request open for the whole
 * Etsy completion. A dropped socket used to be reported as "the server may be
 * restarting" and the entire batch was POSTed again — which is what made a
 * normal batch look stuck at "retry 3/5".
 *
 * Run: node scripts/test-bulk-complete-ui.js
 */

const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const page = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8')
const server = fs.readFileSync(path.join(root, 'src', 'server', 'index.js'), 'utf8')
const setup = fs.readFileSync(path.join(root, 'src', 'db', 'setup.js'), 'utf8')

let failures = 0
function assert(cond, msg) {
	if (cond) console.log(`  ok  — ${msg}`)
	else {
		failures++
		console.error(`  FAIL — ${msg}`)
	}
}

assert(!page.includes('the server may be restarting'), 'the wizard no longer blames a restart and re-posts the batch')
assert(!page.includes('_fpxPostBulkCompleteResilient'), 'the blocking retry loop is gone')
assert(page.includes('async: true'), 'the page asks for a job, not a response that waits for every order')
assert(page.includes('/api/4px/bulk-complete/jobs/'), 'progress is a short poll')
assert(page.includes("cache: 'no-store'"), 'progress polls are not cached')
assert(page.includes('function _fpxRunBulkComplete'), 'both completion buttons share the job watcher')
assert(page.includes('shouldContinue: () => document.getElementById(\'bulkShipModal\')?.classList.contains(\'open\')'), 'the plain complete modal watches the same job')
assert(page.includes('shouldContinue: () => gen === _fbxCompleteGen'), 'closing the 4PX wizard stops the watch without cancelling the server job')
assert(page.includes('Completing…'), 'a row shows that Etsy completion is in progress')
assert(page.includes('Connection interrupted.'), 'a dropped poll says the server is still working')

assert(server.includes('req.body?.async !== true'), 'a stale page cannot mistake "accepted" for "finished"')
assert(server.includes('/api/4px/bulk-complete/jobs/:job_id'), 'the progress route exists')
assert(server.includes("res.setHeader('Cache-Control', 'no-store')"), 'the progress response is uncached')
const bulkHandler = server.slice(server.indexOf('POST /api/4px/bulk-complete'), server.indexOf('DELETE /api/4px/order/:receipt_id'))
assert(bulkHandler.length > 0, 'the bulk-complete handler is present')
assert(!bulkHandler.includes('req.setTimeout(0)'), 'completion no longer pins a socket open with an infinite timeout')
assert(!bulkHandler.includes('complianceSleep'), 'the HTTP handler does not sleep; the job runner does')
assert(server.includes('holdBulkCompletionIntents'), 'the reconciler is held off while the job is pacing the same orders')
assert(server.includes('bulkCompleteJob.recoverInterrupted'), 'a restart resumes an interrupted batch')
assert(server.includes('kickBulkComplete()'), 'boot and the progress poll can restart the drain')
assert(setup.includes('bulkCompleteJob.ensureSchema(db)'), 'the job tables are created with the rest of the schema')

if (failures) {
	console.error(`\n${failures} assertion(s) failed`)
	process.exit(1)
}
console.log('\nBulk-complete UI wiring checks passed.')
