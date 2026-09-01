'use strict'

/**
 * Boots the real Express entry point against an entirely isolated config,
 * token store, SQLite database, route-engine directory, output directory, and
 * ephemeral loopback port. It exercises only GETs after login and cannot read or
 * mutate the operator's production config, credentials, database, or Etsy API.
 */
const crypto = require('crypto')
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { initDb, syncConfigToDb } = require('../src/db/setup')
const exchangeRates = require('../src/compliance/exchange-rates')

const projectRoot = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ued-route-smoke-'))
const engineRoot = path.join(tempRoot, 'route-engine')
const configPath = path.join(tempRoot, 'config.json')
const tokensPath = path.join(tempRoot, 'tokens.json')
const dbPath = path.join(tempRoot, 'dashboard.db')
const outputDir = path.join(tempRoot, 'output')
const ownerPassword = `smoke-owner-${crypto.randomBytes(12).toString('hex')}`
const packerPassword = `smoke-packer-${crypto.randomBytes(12).toString('hex')}`

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
	if (cond) {
		pass++
		console.log(`  \x1b[32m✓\x1b[0m ${name}`)
	} else {
		fail++
		console.log(`  \x1b[31m✗ ${name}\x1b[0m ${extra}`)
	}
}

function allocatePort() {
	return new Promise((resolve, reject) => {
		const socket = net.createServer()
		socket.once('error', reject)
		socket.listen(0, '127.0.0.1', () => {
			const port = socket.address().port
			socket.close((err) => (err ? reject(err) : resolve(port)))
		})
	})
}

function writeFixture() {
	fs.mkdirSync(path.join(engineRoot, 'src'), { recursive: true })
	fs.mkdirSync(path.join(engineRoot, 'data'), { recursive: true })
	fs.mkdirSync(outputDir, { recursive: true })
	// Route status checks require the entry point to exist, but this smoke never
	// spawns it. Copying code only (no catalog/order data) keeps the fixture real
	// while preventing access to production route-engine state.
	fs.copyFileSync(
		path.join(projectRoot, 'route-engine', 'src', 'generate_shopping_route.py'),
		path.join(engineRoot, 'src', 'generate_shopping_route.py'),
	)
	fs.writeFileSync(tokensPath, '{}\n', 'utf8')
	// Keep the smoke hermetic. The real server reads its last-good EUR-base table
	// beside the database; seeding that cache proves the employee customs payload
	// without making CI availability depend on a third-party FX endpoint.
	const rates = {
		EUR: 1, GBP: 0.85, USD: 1.08, HKD: 8.5, NOK: 11.5, CHF: 0.95,
		AUD: 1.65, NZD: 1.8, CNY: 7.8, JPY: 160, CAD: 1.47, SGD: 1.45,
		KRW: 1450, INR: 90, MXN: 18, BRL: 5.5, SEK: 11.2, DKK: 7.46,
		PLN: 4.3, CZK: 25, TRY: 34, ZAR: 20,
	}
	fs.writeFileSync(
		path.join(tempRoot, exchangeRates.CACHE_FILE),
		JSON.stringify({ version: 1, base: 'EUR', fetched_at: new Date().toISOString(), rates }, null, 2),
		'utf8',
	)
	const fixtureConfig = {
			db_path: dbPath,
			sync_interval_minutes: 1440,
			inv_watch_interval_minutes: 1440,
			auto_restock_enabled: false,
			route_engine_dir: engineRoot,
			osp_output_dir: outputDir,
			groups: [{
				group_id: 'smoke',
				label: 'Isolated smoke fixture',
				proxy: 'direct',
				shops: [{
					shop_id: '900000001',
					shop_name: 'SmokeFixtureShop',
					api_key: 'smokefixturekey',
					shared_secret: 'smokefixturesecret',
				}],
			}],
		}
	fs.writeFileSync(
		configPath,
		JSON.stringify(fixtureConfig, null, 2),
		'utf8',
	)
	const fixtureDb = initDb(dbPath)
	syncConfigToDb(fixtureDb, fixtureConfig)
	fixtureDb.prepare(`
		INSERT INTO receipts
			(receipt_id, shop_id, group_id, name, status, is_paid,
			 grandtotal_amount, grandtotal_currency, subtotal_amount, etsy_created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(9001, '900000001', 'smoke', 'Fixture Buyer', 'Paid', 1, 49.95, 'USD', 45.00, Math.floor(Date.now() / 1000))
	fixtureDb.prepare(`
		INSERT INTO receipts
			(receipt_id, shop_id, group_id, name, status, is_paid,
			 grandtotal_amount, grandtotal_currency, subtotal_amount, shipping_country_iso, etsy_created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(9002, '900000001', 'smoke', 'UK Fixture Buyer', 'Paid', 1, 175.00, 'HKD', 170.00, 'GB', Math.floor(Date.now() / 1000))
	fixtureDb.close()
}

async function waitForServer(base, child, timeoutMs = 30000) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (child.exitCode != null) throw new Error(`server exited early (code ${child.exitCode})`)
		try {
			const response = await fetch(base + '/api/health')
			if (response.ok) return
		} catch {
			/* startup in progress */
		}
		await new Promise((resolve) => setTimeout(resolve, 250))
	}
	throw new Error('server did not start within 30s')
}

async function stopChild(child) {
	if (!child || child.exitCode != null) return
	const exited = new Promise((resolve) => child.once('exit', resolve))
	child.kill()
	await Promise.race([
		exited,
		new Promise((resolve) => setTimeout(resolve, 5000)),
	])
	if (child.exitCode == null) {
		const forceExited = new Promise((resolve) => child.once('exit', resolve))
		child.kill('SIGKILL')
		await Promise.race([
			forceExited,
			new Promise((resolve) => setTimeout(resolve, 2000)),
		])
	}
}

;(async () => {
	let child = null
	let output = ''
	try {
		writeFixture()
		const port = await allocatePort()
		const base = `http://127.0.0.1:${port}`
		console.log('\n  Booting an isolated dashboard fixture…\n')
		child = spawn(process.execPath, [path.join(projectRoot, 'src', 'server', 'index.js')], {
			cwd: tempRoot,
			env: {
				...process.env,
				OPENAI_API_KEY: '',
				OPENROUTER_API_KEY: '',
				CLOUDFLARE_TUNNEL_TOKEN: '',
				PORT: String(port),
				HOST: '127.0.0.1',
				NODE_ENV: 'test',
				EMBEDDED_SYNC: '0',
				DASHBOARD_CONFIG_PATH: configPath,
				DASHBOARD_TOKENS_PATH: tokensPath,
				DASHBOARD_OWNER_PASSWORD: ownerPassword,
				DASHBOARD_PACKER_PASSWORD: packerPassword,
				DASHBOARD_SHOPPER_PASSWORD: '',
				DASHBOARD_AUTH_SECRET: crypto.randomBytes(48).toString('base64url'),
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		child.stdout.on('data', (chunk) => { output += chunk.toString() })
		child.stderr.on('data', (chunk) => { output += chunk.toString() })
		await waitForServer(base, child)

		const login = (password) => fetch(base + '/api/auth/login', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ password }),
		})

		let response = await login(packerPassword)
		const cookie = (typeof response.headers.getSetCookie === 'function'
			? response.headers.getSetCookie()
			: [])
			.map((value) => value.split(';')[0])
			.join('; ')
		check('Employee signs in', response.status === 200, `got ${response.status}`)

		const get = (requestPath) => fetch(base + requestPath, {
			headers: { cookie },
			redirect: 'manual',
		})

		console.log('\n  The desktop dashboard is reachable\n')
		response = await get('/')
		check('GET / serves the dashboard (not a redirect)', response.status === 200, `got ${response.status}`)
		check('Security headers block framing', response.headers.get('x-frame-options') === 'DENY')
		check('Content Security Policy is present', /frame-ancestors 'none'/.test(response.headers.get('content-security-policy') || ''))
		response = await fetch(base + '/api/health', { headers: { Origin: 'https://attacker.invalid' } })
		check('Unconfigured cross-origin reads receive no CORS grant', !response.headers.get('access-control-allow-origin'))

		response = await get('/auth-session.js')
		const shim = await response.text()
		const auth = JSON.parse(shim.replace(/^window\.__AUTH=/, '').replace(/;$/, ''))
		check('Session bootstrap is served', response.status === 200 && auth.role === 'packer')
		check('Route capability is present', auth.capabilities.includes('route:read'))
		check('Route tab is mapped to that capability', auth.tabs?.route === 'route:read')

		console.log('\n  Every endpoint the Route tab loads on open\n')
		for (const requestPath of ['/api/shops', '/api/route/config', '/api/route/status', '/api/route/suppliers', '/api/route/charms', '/api/route/dashboard', '/api/route/output-files']) {
			response = await get(requestPath)
			check(`GET ${requestPath}`, response.status === 200, `got ${response.status}`)
		}

		console.log('\n  Supporting reads for the dashboard’s modals\n')
		for (const requestPath of ['/api/route/product-map', '/api/route/products', '/api/route/charms-to-buy', '/api/route/charm-progress', '/api/route/floor-map', '/api/route/sync-history']) {
			response = await get(requestPath)
			check(`GET ${requestPath}`, response.status === 200, `got ${response.status}`)
		}

		console.log('\n  Boundaries still hold\n')
		for (const requestPath of ['/api/users', '/api/audit', '/api/route/open?file=shopping_route.xlsx']) {
			response = await get(requestPath)
			check(`GET ${requestPath} → 403`, response.status === 403, `got ${response.status}`)
		}
		const remoteHeaders = {
			cookie,
			'x-forwarded-for': '203.0.113.10, 127.0.0.1',
			'x-forwarded-proto': 'https',
		}
		response = await fetch(base + '/api/orders', { headers: remoteHeaders })
		check('Remote employee is blocked from desktop APIs', response.status === 403)
		response = await fetch(base + '/api/shop/route', { headers: remoteHeaders })
		check('Remote employee retains mobile shopping route', response.status === 200)

		console.log('\n  Finance fields remain owner-only\n')
		response = await get('/api/orders?limit=10')
		const packerOrders = await response.json()
		const packerOrder = packerOrders.orders?.find((order) => order.receipt_id === 9001)
		check('Employee can read fulfilment orders', response.status === 200 && !!packerOrder)
		check(
			'Employee order payload strips revenue',
			packerOrder
				&& !Object.hasOwn(packerOrder, 'grandtotal_amount')
				&& !Object.hasOwn(packerOrder, 'grandtotal_currency')
				&& !Object.hasOwn(packerOrder, 'subtotal_amount'),
		)
		const packerUk = packerOrders.orders?.find((order) => order.receipt_id === 9002)
		check(
			'Employee UK order carries a destination-currency customs amount, not shop revenue',
			packerUk
				&& packerUk.customs_declaration
				&& packerUk.customs_declaration.currency === 'GBP'
				&& typeof packerUk.customs_declaration.amount === 'number'
				&& packerUk.customs_declaration.amount > 0
				&& !Object.hasOwn(packerUk, 'subtotal_amount')
				&& !Object.hasOwn(packerUk, 'grandtotal_amount'),
		)

		const ownerLogin = await login(ownerPassword)
		const ownerCookie = (typeof ownerLogin.headers.getSetCookie === 'function'
			? ownerLogin.headers.getSetCookie()
			: [])
			.map((value) => value.split(';')[0])
			.join('; ')
		response = await fetch(base + '/api/orders?limit=10', { headers: { cookie: ownerCookie } })
		const ownerOrders = await response.json()
		const ownerOrder = ownerOrders.orders?.find((order) => order.receipt_id === 9001)
		check(
			'Owner order payload retains revenue',
			response.status === 200
				&& ownerOrder?.grandtotal_amount === 49.95
				&& ownerOrder?.grandtotal_currency === 'USD'
				&& ownerOrder?.subtotal_amount === 45,
		)

		console.log('\n  Browser request hardening\n')
		response = await fetch(base + '/api/shop/cost', {
			method: 'POST',
			headers: {
				cookie,
				'Content-Type': 'application/json',
				'Sec-Fetch-Site': 'cross-site',
			},
			body: '{}',
		})
		check('Cross-site browser mutation is blocked', response.status === 403)
		response = await fetch(base + '/api/shop/cost', {
			method: 'POST',
			headers: {
				cookie,
				'Content-Type': 'application/json',
				Origin: 'https://attacker.invalid',
			},
			body: '{}',
		})
		check('Foreign Origin mutation is blocked without relying on Fetch Metadata', response.status === 403)

		response = await fetch(base + '/api/route/assign', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '{not valid json',
		})
		check('Unauthorized body is rejected before large JSON parsing', response.status === 401)

		response = await fetch(base + '/api/health')
		const publicHealth = await response.json()
		check('Public health response exposes liveness only', response.status === 200 && Object.keys(publicHealth).join(',') === 'ok')
	} catch (err) {
		fail++
		console.error(`  FAIL — ${err.message}`)
		if (output) console.error(output.slice(-6000))
	} finally {
		await stopChild(child)
		try { fs.rmSync(tempRoot, { recursive: true, force: true }) } catch {}
	}

	console.log(`\n  ${pass} passed, ${fail} failed\n`)
	process.exitCode = fail ? 1 : 0
})()
