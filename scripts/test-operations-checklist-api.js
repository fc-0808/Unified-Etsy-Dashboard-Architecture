'use strict'

/**
 * Real HTTP/middleware contract test for the manual checklist. The server runs
 * against a throwaway database with embedded sync disabled and an empty token
 * store, so this test cannot make an Etsy request.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const Database = require('better-sqlite3')

let failures = 0
function check(condition, message, extra = '') {
	if (condition) {
		console.log(`  ok  - ${message}`)
	} else {
		failures += 1
		console.error(`  FAIL - ${message}${extra ? ` (${extra})` : ''}`)
	}
}

const PORT = 6200 + (process.pid % 500)
const BASE = `http://127.0.0.1:${PORT}`
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ued-checklist-api-'))
const configPath = path.join(tempDir, 'config.json')
const dbPath = path.join(tempDir, 'checklist.db')
const tokensPath = path.join(tempDir, 'tokens.json')

fs.writeFileSync(
	configPath,
	JSON.stringify({
		db_path: dbPath,
		operations_timezone: 'UTC',
		sync_interval_minutes: 60,
		inv_watch_interval_minutes: 240,
		auto_restock_enabled: false,
		catalog_health_sync: false,
		fourpx_tracking_sync: false,
		groups: [{
			group_id: 'checklist-test',
			label: 'Checklist Test',
			proxy: 'direct',
			shops: [{
				shop_id: 'shop-a',
				shop_name: 'Alpha',
				api_key: 'checklisttestkey000000001',
				shared_secret: 'checklisttestsecret00001',
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
	return {
		status: response.status,
		body,
		setCookie: response.headers.get('set-cookie') || '',
		contentType,
	}
}

function sessionCookie(setCookie) {
	const match = /(?:^|,\s*)sid=([^;]+)/.exec(setCookie)
	return match ? `sid=${match[1]}` : ''
}

async function login(password) {
	const response = await request('/api/auth/login', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ password }),
	})
	return {
		...response,
		cookie: sessionCookie(response.setCookie),
	}
}

async function waitForServer(child, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (child.exitCode != null) {
			throw new Error(`server exited early with code ${child.exitCode}`)
		}
		try {
			const health = await request('/api/health')
			if (health.status === 200) return
		} catch {
			// The isolated server is still starting.
		}
		await new Promise((resolve) => setTimeout(resolve, 250))
	}
	throw new Error('isolated checklist server did not become healthy')
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

async function main() {
	const child = spawn(
		process.execPath,
		[path.resolve(__dirname, '../src/server/index.js')],
		{
			env: {
				...process.env,
				PORT: String(PORT),
				HOST: '127.0.0.1',
				EMBEDDED_SYNC: '0',
				DASHBOARD_CONFIG_PATH: configPath,
				DASHBOARD_TOKENS_PATH: tokensPath,
				DASHBOARD_OWNER_PASSWORD: 'owner-checklist-password',
				DASHBOARD_PACKER_PASSWORD: 'packer-checklist-password',
				DASHBOARD_SHOPPER_PASSWORD: 'shopper-checklist-password',
				DASHBOARD_AUTH_SECRET: 'checklist-test-auth-secret-that-is-longer-than-thirty-two-bytes',
				ALLOW_LIVE_ETSY_READ_TEST: '',
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		},
	)
	let stdout = ''
	let stderr = ''
	child.stdout.on('data', (data) => {
		stdout += data.toString()
	})
	child.stderr.on('data', (data) => {
		stderr += data.toString()
	})

	try {
		await waitForServer(child)
		console.log('Operations checklist HTTP tests\n')

		let response = await request('/api/operations/checklist')
		check(
			response.status === 401
				&& response.body?.code === 'AUTH_REQUIRED',
			'checklist requires an authenticated session',
			`status ${response.status}`,
		)

		const shopper = await login('shopper-checklist-password')
		check(
			shopper.status === 200 && !!shopper.cookie,
			'shopper test session signs in',
			`status ${shopper.status}`,
		)
		response = await request('/api/operations/checklist', {
			headers: { Cookie: shopper.cookie },
		})
		check(
			response.status === 403
				&& response.body?.code === 'FORBIDDEN_ROLE',
			'mobile-only shopper is denied the operations checklist',
			`status ${response.status}`,
		)

		const packer = await login('packer-checklist-password')
		check(
			packer.status === 200 && !!packer.cookie,
			'employee test session signs in',
			`status ${packer.status}`,
		)
		response = await request('/api/operations/checklist', {
			headers: { Cookie: packer.cookie },
		})
		check(
			response.status === 403
				&& response.body?.code === 'FORBIDDEN_ROLE',
			'employee is denied the operations checklist',
			`status ${response.status}`,
		)
		response = await request('/api/operations/checklist', {
			method: 'PUT',
			headers: {
				Cookie: packer.cookie,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				work_date: '2026-01-01',
				task_id: 'messages',
				shop_id: 'shop-a',
				completed: true,
			}),
		})
		check(
			response.status === 403
				&& response.body?.code === 'FORBIDDEN_ROLE',
			'employee cannot mutate the operations checklist',
			`status ${response.status}`,
		)

		const owner = await login('owner-checklist-password')
		check(
			owner.status === 200 && !!owner.cookie,
			'owner test session signs in',
			`status ${owner.status}`,
		)
		const authHeaders = { Cookie: owner.cookie }
		response = await request('/api/operations/checklist', {
			headers: authHeaders,
		})
		check(response.status === 200, 'owner can load the checklist', `status ${response.status}`)
		check(response.body?.source === 'local_sqlite', 'response identifies the local SQLite source')
		check(response.body?.etsy_api_calls === 0, 'response guarantees zero Etsy API calls')
		check(response.body?.version === 2, 'response uses the shop-centric checklist contract')
		check(response.body?.time_zone === 'UTC', 'configured business timezone is authoritative')
		check(response.body?.shops?.length === 1 && response.body.shops[0].shop_id === 'shop-a', 'only the configured real shop is listed')
		check(response.body?.days?.length === 7 && response.body.days[0].iso_weekday === 1, 'API returns one Monday-to-Sunday week')
		const workDate = response.body.today
		check(response.body.today_summary.total === 1, 'daily progress counts shops rather than task rows')

		response = await request('/', { headers: authHeaders })
		check(
			response.status === 200
				&& response.body.includes('href="/operations-checklist.css"')
				&& response.body.includes('src="/operations-checklist.js"'),
			'dashboard loads the sticky checklist assets on every tab',
			`status ${response.status}`,
		)
		response = await request('/operations-checklist.js')
		check(
			response.status === 200
				&& /application\/javascript/.test(response.contentType)
				&& response.body.includes("const ENDPOINT = '/api/operations/checklist'"),
			'checklist controller is served as a first-party asset',
			`status ${response.status}`,
		)
		response = await request('/operations-checklist.css')
		check(
			response.status === 200
				&& /text\/css/.test(response.contentType)
				&& response.body.includes('.ops-checklist-edge'),
			'checklist styles are served as a first-party asset',
			`status ${response.status}`,
		)

		response = await request('/api/operations/checklist', {
			method: 'POST',
			headers: {
				Cookie: packer.cookie,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({}),
		})
		check(
			response.status === 403
				&& response.body?.code === 'FORBIDDEN_ROLE',
			'undeclared checklist methods remain denied by policy',
			`status ${response.status}`,
		)

		response = await request('/api/operations/checklist', {
			method: 'PUT',
			headers: {
				...authHeaders,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				work_date: workDate,
				task_id: 'messages',
				shop_id: 'shop-a',
				completed: true,
			}),
		})
		check(
			response.status === 200
				&& response.body?.ok === true
				&& response.body?.changed === true,
			'owner can complete one current per-shop task',
			`status ${response.status}`,
		)
		const completedAt = response.body?.completion?.completed_at
		check(response.body?.completion?.completed_by === 'owner', 'server records the authenticated actor')
		check(Number.isSafeInteger(completedAt), 'server returns a durable completion revision')

		response = await request('/api/operations/checklist', {
			method: 'PUT',
			headers: {
				...authHeaders,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				work_date: workDate,
				task_id: 'messages',
				shop_id: 'shop-a',
				completed: true,
			}),
		})
		check(
			response.status === 200
				&& response.body?.changed === false
				&& response.body?.completion?.completed_at === completedAt,
			'a repeated completion is idempotent',
			`status ${response.status}`,
		)

		response = await request('/api/operations/checklist', {
			headers: authHeaders,
		})
		check(
			response.status === 200
				&& response.body?.completions?.some(
					(entry) =>
						entry.work_date === workDate
						&& entry.task_id === 'messages'
						&& entry.shop_id === 'shop-a',
				),
			'completed state is shared by subsequent reads',
		)

		await new Promise((resolve) => setTimeout(resolve, 50))
		const inspection = new Database(dbPath, { readonly: true })
		try {
			const row = inspection.prepare(`
				SELECT work_date, task_id, subject_id, completed_by
				FROM operations_checklist_completions
				WHERE work_date = ? AND task_id = ? AND subject_id = ?
			`).get(workDate, 'messages', 'shop-a')
			check(row?.completed_by === 'owner', 'completion is persisted in the isolated SQLite database')
			const audit = inspection.prepare(`
				SELECT user, method, path, status, details
				FROM audit_log
				WHERE path = '/api/operations/checklist' AND method = 'PUT'
				ORDER BY id ASC
				LIMIT 1
			`).get()
			check(
				audit?.user === 'owner'
					&& audit.status === 200
					&& audit.details?.includes('"task_id":"messages"'),
				'normal mutation auditing captures actor and checklist identity',
			)
			const syncCount = inspection.prepare('SELECT COUNT(*) AS n FROM sync_log').get().n
			check(syncCount === 0, 'isolated checklist requests initiated no Etsy sync')
		} finally {
			inspection.close()
		}

		response = await request('/api/operations/checklist', {
			method: 'PUT',
			headers: {
				...authHeaders,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				work_date: workDate,
				task_id: 'messages',
				shop_id: 'shop-a',
				completed: false,
				expected_completed_at: completedAt,
			}),
		})
		check(
			response.status === 200
				&& response.body?.changed === true
				&& response.body?.completion === null,
			'a matching revision can be unchecked',
			`status ${response.status}`,
		)

	} catch (error) {
		console.error(error.stack || error.message)
		console.error(`\nServer stdout:\n${stdout}`)
		console.error(`\nServer stderr:\n${stderr}`)
		failures += 1
	} finally {
		await stopChild(child)
		fs.rmSync(tempDir, { recursive: true, force: true })
	}

	console.log('')
	if (failures) {
		console.error(`${failures} operations checklist HTTP assertion(s) failed.`)
		process.exitCode = 1
		return
	}
	console.log('All operations checklist HTTP assertions passed.')
}

main().catch((error) => {
	console.error(error.stack || error.message)
	fs.rmSync(tempDir, { recursive: true, force: true })
	process.exitCode = 1
})
