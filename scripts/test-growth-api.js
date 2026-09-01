'use strict'

/**
 * End-to-end Growth HTTP test against an isolated server and SQLite database.
 * EMBEDDED_SYNC=0 and catalog_health_sync=false guarantee this test cannot make
 * an Etsy request. It covers the real route/middleware/serialization layer.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const Database = require('better-sqlite3')

let failures = 0
function check(condition, message, extra = '') {
	if (condition) console.log(`  ok  — ${message}`)
	else {
		failures += 1
		console.error(`  FAIL — ${message}${extra ? ` (${extra})` : ''}`)
	}
}

const PORT = 5000 + (process.pid % 500)
const BASE = `http://127.0.0.1:${PORT}`
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ued-growth-api-'))
const configPath = path.join(tempDir, 'config.json')
const dbPath = path.join(tempDir, 'growth.db')
const tokensPath = path.join(tempDir, 'tokens.json')

fs.writeFileSync(
	configPath,
	JSON.stringify({
		db_path: dbPath,
		sync_interval_minutes: 60,
		inv_watch_interval_minutes: 240,
		auto_restock_enabled: false,
		catalog_health_sync: false,
		groups: [{
			group_id: 'growth-test',
			label: 'Growth Test',
			proxy: 'direct',
			shops: [{
				shop_id: 'shop-a',
				shop_name: 'Alpha',
				api_key: 'growthtestkey0000000001',
				shared_secret: 'growthtestsecret0001',
			}],
		}],
	}, null, 2),
	'utf8',
)
fs.writeFileSync(tokensPath, '{}', 'utf8')

async function request(urlPath, options = {}) {
	const response = await fetch(BASE + urlPath, options)
	const contentType = response.headers.get('content-type') || ''
	const body = contentType.includes('application/json')
		? await response.json().catch(() => null)
		: await response.text()
	return { status: response.status, body, headers: response.headers }
}

async function waitForServer(child, timeoutMs = 25_000) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (child.exitCode != null) throw new Error(`server exited early with code ${child.exitCode}`)
		try {
			const health = await request('/api/health')
			if (health.status === 200) return
		} catch {
			/* still starting */
		}
		await new Promise((resolve) => setTimeout(resolve, 250))
	}
	throw new Error('isolated Growth server did not become healthy')
}

async function stopChild(child) {
	if (child.exitCode != null) return
	child.kill()
	await Promise.race([
		new Promise((resolve) => child.once('exit', resolve)),
		new Promise((resolve) => setTimeout(resolve, 3000)),
	])
	if (child.exitCode == null) child.kill('SIGKILL')
}

const comparison = {
	import_key: 'growth_api_test_001',
	shop_id: 'shop-a',
	currency: 'HKD',
	current: {
		start: '2026-08-22',
		end: '2026-08-28',
		visits: 1000,
		views: 2000,
		orders: 20,
		revenue: 4000,
		conversion_rate: 2,
	},
	baseline: {
		start: '2026-08-15',
		end: '2026-08-21',
		visits: 1500,
		views: 2800,
		orders: 40,
		revenue: 7000,
		conversion_rate: 2.67,
	},
	health: {
		review_average: 4.5,
		review_count: 30,
		listing_active_count: 200,
		listing_expired_count: 3,
		is_vacation: false,
	},
}

async function main() {
	const child = spawn(process.execPath, [path.resolve(__dirname, '../src/server/index.js')], {
		env: {
			...process.env,
			PORT: String(PORT),
			EMBEDDED_SYNC: '0',
			DASHBOARD_CONFIG_PATH: configPath,
			DASHBOARD_TOKENS_PATH: tokensPath,
			DASHBOARD_OWNER_PASSWORD: '',
			DASHBOARD_PACKER_PASSWORD: '',
			DASHBOARD_SHOPPER_PASSWORD: '',
			ALLOW_LIVE_ETSY_READ_TEST: '',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	let stdout = ''
	let stderr = ''
	child.stdout.on('data', (data) => { stdout += data.toString() })
	child.stderr.on('data', (data) => { stderr += data.toString() })

	try {
		await waitForServer(child)

		const page = await request('/')
		check(page.status === 200 && page.body.includes('id="tab-growth"'), 'dashboard serves the Growth panel')
		check(page.body.includes("'earnings', 'growth', 'shipping'"), 'showTab registry includes Growth between Earnings and Shipping')
		check(page.body.includes('class="growth-hero"') && page.body.includes('id="growthDataPanel"'), 'Growth uses the shared hero and live-status hierarchy')
		check(page.body.includes('id="growthPageState"') && page.body.includes('id="growthDashboard" hidden'), 'Growth has explicit loading/error and ready states')
		check(page.body.includes('id="growthCadence"') && page.body.includes('Official guidance'), 'Growth includes the evidence-backed listing experiment planner')
		check(page.body.includes('id="growthListingImport"') && page.body.includes('id="growthListingInsightsSection"'), 'Growth exposes zero-API per-listing import and insight surfaces')
		check(page.body.includes("].filter(([, rows]) => Array.isArray(rows) && rows.length > 0)"), 'empty watchlist categories are not rendered as blank cards')

		let response = await request('/api/growth?days=7')
		check(response.status === 200, 'GET /api/growth succeeds before any imports', `status ${response.status}`)
		check(response.body?.collection?.mode === 'manual', 'Growth defaults to manual collection mode')
		check(response.body?.collection?.api_calls_on_page_load === 0, 'Growth declares zero API calls on page load')
		check(response.body?.collection?.authorization_guaranteed_by_manual_mode === false, 'manual mode does not overstate contractual authorization')
		check(response.body?.compliance?.status === 'ok', 'Growth carries the local marketplace-compliance summary')

		const rightsDb = new Database(dbPath)
		rightsDb.prepare(
			`INSERT INTO listings (listing_id, shop_id, title, state, views)
			 VALUES (?, ?, ?, 'active', ?)`
		).run(9001, 'shop-a', '=CMD Hello Kitty Case', 100)
		rightsDb.close()
		response = await request('/api/growth/rights-review.csv')
		check(
			response.status === 200 &&
			(response.headers.get('content-type') || '').includes('text/csv') &&
			response.body.includes('"Likely Rights Holder"') &&
			response.body.includes('"\'=CMD Hello Kitty Case"'),
			'complete rights-review CSV is local and exportable',
		)

		response = await request('/api/growth/status')
		check(
			response.status === 200 &&
			response.body?.api_enabled === false &&
			response.body?.analytics_approval_recorded === false,
			'optional Etsy analytics is disabled without written-approval attestation',
		)

		response = await request('/api/growth/sync', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ shop_id: 'shop-a', confirm_api_calls: true }),
		})
		check(
			response.status === 409 && response.body?.code === 'ETSY_API_ANALYTICS_NOT_APPROVED',
			'API analytics cannot run without both approval and collection gates',
			`status ${response.status}`,
		)

		response = await request('/api/growth/manual/parse', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				raw: 'CURRENT\n2026-08-22 to 2026-08-28\nVisits: 1000\nOrders: 20\nPREVIOUS\n2026-08-15 to 2026-08-21\nVisits: 1500\nOrders: 40',
			}),
		})
		check(response.status === 200 && response.body?.parsed?.current?.visits === '1000', 'paste preview parses without persistence')
		await new Promise((resolve) => setTimeout(resolve, 30))
		const auditDb = new Database(dbPath, { readonly: true })
		const previewAudit = auditDb.prepare(
			`SELECT details FROM audit_log WHERE path = '/api/growth/manual/parse' ORDER BY id DESC LIMIT 1`
		).get()
		auditDb.close()
		check(!previewAudit?.details || !/CURRENT|Visits|1000/.test(previewAudit.details), 'paste text is redacted from the audit log')

		response = await request('/api/growth/manual/listings/parse', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				raw: [
					'CURRENT LISTINGS',
					'Listing ID\\tTitle\\tViews\\tFavorites\\tOrders\\tRevenue',
					'101\\tWinner\\t120\\t10\\t4\\t800',
					'102\\tViewed not bought\\t90\\t8\\t0\\t0',
					'PREVIOUS LISTINGS',
					'Listing ID\\tTitle\\tViews\\tFavorites\\tOrders\\tRevenue',
					'101\\tWinner\\t60\\t4\\t1\\t200',
					'102\\tViewed not bought\\t100\\t5\\t0\\t0',
				].join('\n').replace(/\\t/g, '\t'),
			}),
		})
		check(response.status === 200 && response.body?.parsed?.matched_rows === 2, 'per-listing Stats tables parse and match locally')
		const parsedListingRows = response.body?.parsed?.rows || []
		const listingWarnings = response.body?.parsed?.warnings || []
		await new Promise((resolve) => setTimeout(resolve, 30))
		const listingAuditDb = new Database(dbPath, { readonly: true })
		const listingPreviewAudit = listingAuditDb.prepare(
			`SELECT details FROM audit_log WHERE path = '/api/growth/manual/listings/parse' ORDER BY id DESC LIMIT 1`
		).get()
		listingAuditDb.close()
		check(!listingPreviewAudit?.details || !/Winner|Viewed not bought/.test(listingPreviewAudit.details), 'per-listing paste text is redacted from audit logs')

		response = await request('/api/growth/manual', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(comparison),
		})
		check(response.status === 201 && response.body?.comparison?.id > 0, 'manual comparison persists', `status ${response.status}`)
		const importId = response.body?.comparison?.id

		response = await request('/api/growth/manual/listings', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				import_key: 'growth_listing_api_001',
				shop_id: 'shop-a',
				currency: 'HKD',
				current: { start: '2026-08-22', end: '2026-08-28' },
				baseline: { start: '2026-08-15', end: '2026-08-21' },
				rows: parsedListingRows,
				warnings: listingWarnings,
			}),
		})
		check(response.status === 201 && response.body?.detail?.row_count === 2, 'per-listing comparison persists locally')
		const listingImportId = response.body?.detail?.id

		response = await request('/api/growth/manual/listings', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				import_key: 'growth_listing_api_001',
				shop_id: 'shop-a',
				currency: 'HKD',
				current: { start: '2026-08-22', end: '2026-08-28' },
				baseline: { start: '2026-08-15', end: '2026-08-21' },
				rows: parsedListingRows,
			}),
		})
		check(response.status === 200 && response.body?.deduplicated === true, 'per-listing import retries are idempotent')

		response = await request('/api/growth/manual', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(comparison),
		})
		check(response.status === 200 && response.body?.deduplicated === true, 'retry is idempotent and does not duplicate')

		response = await request('/api/growth?days=7&shop_id=shop-a')
		const shop = response.body?.shops?.[0]
		check(response.status === 200 && shop?.data_source === 'manual', 'report uses the imported manual comparison')
		check(shop?.orders_growth_pct === -50 && shop?.traffic_growth_pct === -33.3, 'report computes sales and traffic deltas')
		check(response.body?.coverage?.manual_imports === 1, 'coverage reports exactly one manual import')
		check(response.body?.coverage?.manual_listing_imports === 1, 'coverage reports exactly one per-listing import')
		check(response.body?.listing_insights?.[0]?.zero_api_calls === true, 'report returns local per-listing funnel insights')
		check(response.body?.actions?.some((action) => action.code === 'manual_listing_conversion'), 'report prioritizes viewed listings with no orders')
		check(response.body?.cadence?.principle?.includes('not a daily-listing hack'), 'API returns the quality-first listing cadence plan')
		check(response.body?.cadence?.evidence?.length === 7, 'cadence plan cites official Etsy search, traffic, and policy guidance')
		check(response.body?.cadence?.quality_gate?.length === 8, 'cadence plan includes the official pre-publish quality gate')
		check(response.body?.cadence?.traffic_methods?.length === 6, 'cadence plan includes a practical traffic-growth playbook')

		response = await request('/api/growth/manual?shop_id=shop-a')
		check(response.status === 200 && response.body?.imports?.length === 1, 'manual import history is queryable')

		response = await request('/api/growth/manual/listings?shop_id=shop-a')
		check(response.status === 200 && response.body?.imports?.[0]?.row_count === 2, 'per-listing import provenance is queryable without returning all rows')

		response = await request(`/api/growth/manual/listings/${listingImportId}`, { method: 'DELETE' })
		check(response.status === 200, 'mistaken per-listing import can be deleted')

		response = await request(`/api/growth/manual/${importId}`, { method: 'DELETE' })
		check(response.status === 200, 'mistaken manual import can be deleted')

		check(!stdout.includes('[catalog-health]'), 'server made no catalog-health request in manual mode')
	} finally {
		await stopChild(child)
		fs.rmSync(tempDir, { recursive: true, force: true })
	}

	console.log(`\n${failures ? 'FAIL' : 'PASS'} — Growth API: ${failures} failure(s)`)
	process.exitCode = failures ? 1 : 0
}

main().catch(async (err) => {
	console.error(err.stack || err.message)
	fs.rmSync(tempDir, { recursive: true, force: true })
	process.exitCode = 1
})
