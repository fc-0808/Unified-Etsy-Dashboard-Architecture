'use strict'

/**
 * End-to-end smoke test for the Shipping tracking scheduler HTTP surface.
 *
 * Boots the real Express server against a throwaway config/database with auth
 * and embedded schedulers disabled. No parcel rows are inserted, so the manual
 * run exercises locking + durable telemetry without making a 4PX network call.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')
const { initDb } = require('../src/db/setup')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ued-tracking-api-'))
const dbPath = path.join(tmpDir, 'test.db')
const configPath = path.join(tmpDir, 'config.json')
const port = 4900 + (process.pid % 500)
const base = `http://127.0.0.1:${port}`

let failures = 0
function check(condition, message) {
	if (condition) console.log(`  ✓ ${message}`)
	else {
		failures++
		console.error(`  ✗ ${message}`)
	}
}

async function waitForHealth(child, timeoutMs = 40_000) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (child.exitCode != null) throw new Error(`Server exited early (${child.exitCode})`)
		try {
			const response = await fetch(base + '/api/health')
			if (response.ok) return
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 300))
	}
	throw new Error('Server did not become healthy in time')
}

async function json(pathname, options) {
	const response = await fetch(base + pathname, options)
	return { response, body: await response.json().catch(() => ({})) }
}

function rawStatus(pathname, headers = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request({
			host: '127.0.0.1',
			port,
			path: pathname,
			method: 'GET',
			headers,
		}, (res) => {
			res.resume()
			res.on('end', () => resolve(res.statusCode))
		})
		req.on('error', reject)
		req.end()
	})
}

;(async () => {
	fs.writeFileSync(
		configPath,
		JSON.stringify({
			db_path: dbPath,
			sync_interval_minutes: 1440,
			fourpx_tracking_sync: true,
			fourpx_tracking_interval_minutes: 15,
			groups: [{
				group_id: 'G1',
				label: 'Tracking API test',
				proxy: 'direct',
				shops: [{
					shop_id: 'S1',
					shop_name: 'TestShop',
					api_key: 'trackingapitestkey000001',
					shared_secret: 'trackingapitestsecret001',
				}],
			}],
		}),
		'utf8',
	)

	const child = spawn(process.execPath, [path.resolve(__dirname, '../src/server/index.js')], {
		env: {
			...process.env,
			PORT: String(port),
			DASHBOARD_CONFIG_PATH: configPath,
			EMBEDDED_SYNC: '0',
			DASHBOARD_OWNER_PASSWORD: '',
			DASHBOARD_PACKER_PASSWORD: '',
			DASHBOARD_SHOPPER_PASSWORD: '',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	let stdout = ''
	let stderr = ''
	child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
	child.stderr.on('data', (chunk) => { stderr += chunk.toString() })

	try {
		await waitForHealth(child)

		const reboundStatus = await rawStatus('/api/health', { Host: 'attacker.example' })
		check(reboundStatus === 421, 'passwordless mode rejects DNS-rebinding Host headers')
		const sameSiteCsrf = await fetch(base + '/api/4px/tracking-sync/run', {
			method: 'POST',
			headers: { 'Sec-Fetch-Site': 'same-site' },
		})
		check(sameSiteCsrf.status === 403, 'same-site browser mutations require a trusted origin')

		const initial = await json('/api/4px/tracking-sync/status')
		check(initial.response.status === 200, 'GET tracking status responds')
		check(initial.body.enabled === true && initial.body.running === false, 'status exposes enabled/idle scheduler state')
		check(initial.body.due_count === 0 && initial.body.tracked_count === 0, 'empty database has no due parcels')

		const started = await json('/api/4px/tracking-sync/run', { method: 'POST' })
		check(started.response.status === 202 && started.body.accepted === true, 'POST tracking run is accepted asynchronously')

		let completed = null
		for (let i = 0; i < 30; i++) {
			const current = await json('/api/4px/tracking-sync/status')
			if (!current.body.running && current.body.latest?.status === 'success') {
				completed = current.body
				break
			}
			await new Promise((resolve) => setTimeout(resolve, 100))
		}
		check(!!completed, 'manual run completes and persists telemetry')
		check(completed?.latest?.candidate_count === 0 && completed?.latest?.checked_count === 0, 'zero-work run reports honest counts')

		const seededDb = initDb(dbPath)
		const now = Math.floor(Date.now() / 1000)
		let lastTracking = ''
		const insert = seededDb.prepare(`
			INSERT INTO receipts (
				receipt_id, shop_id, group_id, name, etsy_created_at, etsy_updated_at,
				tracking_code, fourpx_consignment_no, tracking_status,
				tracking_last_event, tracking_last_event_at, tracking_health,
				tracking_is_disposed, tracking_checked_at, carrier_confirmed_at,
				shipment_notified_at, shipping_claim_note
			) VALUES (
				@receiptId, 'S1', 'G1', @name, @now, @now,
				@tracking, @consignment, 'exception',
				'Parcel Disposal', @now, 'critical',
				1, @now, @now, @now, @claimNote
			)
		`)
		const seed = seededDb.transaction(() => {
			for (let i = 0; i < 1002; i++) {
				const tracking = `4PX9${String(i).padStart(13, '0')}CN`
				lastTracking = tracking
				insert.run({
					receiptId: 100_000 + i,
					name: i === 0 ? '=2+2' : `Buyer ${i}`,
					now,
					tracking,
					consignment: `C-${i}`,
					claimNote: i === 0 ? '@SUM(1,1)\nsecond line' : null,
				})
			}
		})
		seed()
		seededDb.close()

		const bounded = await json('/api/4px/shipments?status=disposed&limit=-1&offset=-20')
		check(bounded.response.status === 200 && bounded.body.rows?.length === 1 && bounded.body.total === 1002, 'negative pagination is safely clamped')
		const badDate = await json('/api/4px/shipments?from=not-a-number')
		check(badDate.response.status === 400, 'malformed date filters return 400, not 500')
		const badStatus = await json('/api/4px/shipments?status=drop-table')
		check(badStatus.response.status === 400, 'unknown status filters return 400')
		const searchedStats = await json('/api/4px/shipping-stats?q=' + encodeURIComponent('=2+2'))
		check(searchedStats.response.status === 200 && searchedStats.body.total === 1, 'metric counts honor the active search scope')
		const alerts = await json('/api/4px/shipping-alerts')
		check(alerts.response.status === 200 && Array.isArray(alerts.body.alerts) && alerts.body.summary, 'shipping alerts returns an abnormal parcel review payload')
		// 1,002 disposed parcels were seeded above and none have been reviewed, so
		// the counts must reflect the full set even though the row list is capped.
		check(alerts.body.summary?.total === 1002 && alerts.body.summary?.new_total === 1002, 'alert counts cover every abnormal parcel, not just the returned page')
		check(alerts.body.alerts.length < alerts.body.summary.total && alerts.body.summary.returned === alerts.body.alerts.length, 'the alert row list is capped and reports how much it carries')
		check(alerts.body.alerts.every((a) => a.is_new === true), 'never-reviewed parcels arrive flagged as new')
		check(Number.isInteger(alerts.body.summary?.newest_flagged_at), 'alert summary carries when the newest incident was detected')

		const newBoard = await json('/api/4px/shipments?alert_state=new&limit=5')
		check(newBoard.response.status === 200 && newBoard.body.total === 1002, 'the parcel board can isolate the same untriaged set the banner counts')
		check(newBoard.body.rows?.every((r) => r.is_new_alert === 1 && r.alert_kind === 'disposed'), 'board rows carry the NEW mark and the abnormal kind')
		check(newBoard.body.rows?.every((r) => Number.isInteger(r.alert_flagged_at)), 'board rows carry when we flagged them, not just the carrier event age')
		const badAlertState = await json('/api/4px/shipments?alert_state=drop-table')
		check(badAlertState.response.status === 400, 'unknown alert-state filters return 400')
		const neededBoard = await json('/api/4px/shipments?outreach=needed&limit=5')
		check(neededBoard.response.status === 200 && neededBoard.body.total === 1002, 'the parcel board can isolate stuck/disposed parcels that still need a buyer message')
		check(neededBoard.body.rows?.every((r) => r.outreach_needed === 1), 'needed-outreach rows carry the unmessaged flag')
		const badOutreach = await json('/api/4px/shipments?outreach=drop-table')
		check(badOutreach.response.status === 400, 'unknown outreach filters return 400')

		const reviewOne = await json('/api/4px/shipping-alerts/review', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ receipt_ids: [100_000] }),
		})
		check(reviewOne.response.status === 200 && reviewOne.body.reviewed === 1, 'reviewing one parcel acknowledges exactly that parcel')
		check(reviewOne.body.summary?.new_total === 1001 && reviewOne.body.summary?.total === 1002, 'review acknowledges without resolving the parcel')
		const afterOne = await json('/api/4px/shipments?q=' + encodeURIComponent('=2+2'))
		check(afterOne.body.rows?.[0]?.receipt_id === 100_000 && afterOne.body.rows[0].is_new_alert === 0, 'acknowledging a parcel clears its board NEW mark without removing it')
		const remainingNew = await json('/api/4px/shipments?alert_state=new&limit=1')
		check(remainingNew.body.total === 1001, 'the new-only board shrinks by the parcel just reviewed')

		const badReview = await json('/api/4px/shipping-alerts/review', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ receipt_ids: 'all' }),
		})
		check(badReview.response.status === 400, 'review rejects a non-array id list')
		const hostileReview = await json('/api/4px/shipping-alerts/review', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ receipt_ids: ["1 OR 1=1"] }),
		})
		check(hostileReview.response.status === 400, 'review rejects non-numeric order identifiers')

		const reviewAll = await json('/api/4px/shipping-alerts/review', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		})
		check(reviewAll.response.status === 200 && reviewAll.body.summary?.new_total === 0, 'reviewing with no id list clears the whole inbox')
		check(reviewAll.body.summary?.total === 1002, 'the parcel board is untouched by a review')
		const emptyNew = await json('/api/4px/shipments?alert_state=new')
		check(emptyNew.response.status === 200 && emptyNew.body.total === 0 && emptyNew.body.rows?.length === 0, 'an empty inbox produces an empty new-only board')
		const badClaim = await json('/api/4px/shipments/100000/claim', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ note: { nested: true } }),
		})
		check(badClaim.response.status === 400, 'claim notes reject non-string payloads')
		const longClaim = await json('/api/4px/shipments/100000/claim', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ note: 'x'.repeat(4001) }),
		})
		check(longClaim.response.status === 400, 'claim notes enforce the storage bound')

		const invalidTimeline = await json('/api/4px/track/' + encodeURIComponent(`4PX');alert(1);//`))
		check(invalidTimeline.response.status === 400, 'live tracking rejects hostile identifiers before lookup')
		const unknownTimeline = await json('/api/4px/track/4PX88888888888888CN')
		check(unknownTimeline.response.status === 404, 'live tracking is scoped to known dashboard parcels')
		const unknownNumericTimeline = await json('/api/4px/track/1234567890123')
		check(unknownNumericTimeline.response.status === 404, 'official numeric identifiers pass validation but remain database-scoped')

		const exportResponse = await fetch(base + '/api/4px/shipments/export.csv?status=disposed')
		const exportText = await exportResponse.text()
		check(exportResponse.status === 200, 'disposed CSV export responds')
		check(Number(exportResponse.headers.get('x-export-row-count')) === 1002, 'CSV export includes more than the interactive 1,000-row cap')
		check(exportText.includes(lastTracking), 'CSV export includes the final paginated parcel')
		check(exportText.includes('New (Unreviewed)'), 'CSV names the morning-review column so an ops sheet can sort by it')
		check(exportText.includes('Buyer Messaged'), 'CSV names the buyer-outreach column so an ops sheet can sort by it')
		check(exportText.includes(`"'=2+2"`), 'CSV neutralizes formula-leading buyer names')
		check(exportText.includes(`"'@SUM(1,1)\nsecond line"`), 'CSV safely quotes multiline formula-leading notes')

		const page = await fetch(base + '/').then((r) => r.text())
		check(page.includes('id="shipSyncPanel"') && page.includes('id="shipActionCards"'), 'dashboard ships the redesigned tracking UI')
		check(page.includes('id="shipOutreachFilter"') && page.includes('_toggleShipBuyerNotice'), 'dashboard ships the buyer-outreach filter and one-click confirm')
		check(page.includes('data-outreach-receipt') && page.includes('/api/4px/shipments/${receiptId}/buyer-notice'), 'buyer-outreach copy uses data attributes and posts the attestation endpoint')
		check(!page.includes('id="shipBuyerNoticeModal"'), 'dashboard does not ship the buyer-notice draft modal')
		check(!page.includes('ship-row-ack'), 'dashboard does not ship a per-row Reviewed button')
		check(page.includes('id="shipStatusFilter"') && page.includes('<option value="stuck" selected>'), 'Shipping opens on Stuck — action needed by default')
		check(page.includes('<option value="30" selected>Last 30 days</option>'), 'Shipping action queues default to the last 30 days')
		check(!page.includes('Actionable open parcels remain visible even when they shipped outside the selected period'), 'period help no longer promises a stuck bypass')
		check(!page.includes(`open4pxTrackModal('\${o.tracking_code}')`), 'dashboard contains no executable tracking interpolation')
	} catch (err) {
		failures++
		console.error(`  ✗ tracking API smoke failed: ${err.stack || err.message}`)
		if (stdout) console.error(stdout)
		if (stderr) console.error(stderr)
	} finally {
		child.kill('SIGTERM')
		await new Promise((resolve) => {
			if (child.exitCode != null) return resolve()
			child.once('exit', resolve)
			setTimeout(resolve, 2500)
		})
		try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
	}

	console.log(`\n${failures ? `${failures} tracking API check(s) failed.` : 'All tracking API smoke checks passed.'}`)
	process.exit(failures ? 1 : 0)
})()
