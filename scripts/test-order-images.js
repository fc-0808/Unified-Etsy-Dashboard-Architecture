'use strict'

/**
 * Integration regression for LAN-safe Orders thumbnails.
 *
 * Boots the real server against a temporary database and a tiny local stand-in
 * for Etsy's image CDN. The Orders payload must expose only same-origin image
 * routes, and both the cached listing hero and exact variation route must return
 * bytes through the dashboard.
 */

const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const sharp = require('sharp')
const { initDb, createRouteManualOrder, MANUAL_SHOP_ID } = require('../src/db/setup')
const routeDashboard = require('../src/route/dashboard')
const { getFreeTestPort } = require('./free-test-port')

let passed = 0
function check(condition, message) {
	if (!condition) throw new Error(message)
	console.log(`PASS — ${message}`)
	passed += 1
}

function listen(server, port) {
	return new Promise((resolve, reject) => {
		server.once('error', reject)
		server.listen(port, '127.0.0.1', resolve)
	})
}

function close(server) {
	return new Promise((resolve) => server.close(() => resolve()))
}

async function waitForHealth(base, child, timeoutMs = 40_000) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (child.exitCode != null) throw new Error(`Dashboard exited early (${child.exitCode})`)
		try {
			const response = await fetch(`${base}/api/health`)
			if (response.ok) return
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 250))
	}
	throw new Error('Dashboard did not become healthy in time')
}

async function main() {
	const imageBytes = await sharp({
		create: {
			width: 8,
			height: 8,
			channels: 4,
			background: { r: 240, g: 120, b: 180, alpha: 1 },
		},
	}).png().toBuffer()
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ued-order-images-'))
	const dbPath = path.join(tmpDir, 'test.db')
	const configPath = path.join(tmpDir, 'config.json')
	const dashboardPort = await getFreeTestPort()
	let originPort = await getFreeTestPort()
	while (originPort === dashboardPort) originPort = await getFreeTestPort()
	const base = `http://127.0.0.1:${dashboardPort}`
	let originHits = 0
	const origin = http.createServer((req, res) => {
		originHits += 1
		res.writeHead(200, {
			'Content-Type': 'image/png',
			'Content-Length': imageBytes.length,
		})
		res.end(imageBytes)
	})
	await listen(origin, originPort)

	const db = initDb(dbPath)
	db.prepare('INSERT INTO groups (group_id, label) VALUES (?, ?)').run('G1', 'Image test')
	db.prepare('INSERT INTO shops (shop_id, group_id, shop_name) VALUES (?, ?, ?)').run('S1', 'G1', 'ImageTestShop')

	const heroUrl = `http://127.0.0.1:${originPort}/hero.png`
	const variationUrl = `http://127.0.0.1:${originPort}/variation.png`
	const transactions = [
		{
			transaction_id: 1,
			listing_id: 7001,
			title: 'Cached hero product',
			quantity: 1,
			variations: [
				{ property_id: 513, formatted_name: 'Phone Model', formatted_value: 'iPhone 16 Pro' },
				{ property_id: 514, formatted_name: 'Style', formatted_value: 'Case Only', value_id: 101 },
			],
		},
		{
			transaction_id: 2,
			listing_id: 7002,
			title: 'Exact variation product',
			quantity: 1,
			variations: [
				{ property_id: 513, formatted_name: 'Phone Model', formatted_value: 'iPhone 17 Pro' },
				{ property_id: 514, formatted_name: 'Styles', formatted_value: 'Case + Charm', value_id: 202 },
			],
		},
	]
	db.prepare(`
		INSERT INTO receipts (
			receipt_id, shop_id, group_id, name, status, is_paid, is_shipped,
			first_product_title, first_listing_id, first_quantity, first_variations,
			all_transactions, etsy_created_at, etsy_updated_at, synced_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		8001,
		'S1',
		'G1',
		'LAN Image Test',
		'Paid',
		1,
		0,
		transactions[0].title,
		transactions[0].listing_id,
		1,
		JSON.stringify(transactions[0].variations),
		JSON.stringify(transactions),
		1_700_000_000,
		1_700_000_000,
		1_700_000_000,
	)
	db.prepare('INSERT INTO listing_images (listing_id, url, cached_at) VALUES (?, ?, ?)').run(7001, heroUrl, 1_700_000_000)
	db.prepare('INSERT INTO listing_images (listing_id, url, cached_at) VALUES (?, ?, ?)').run(7002, heroUrl, 1_700_000_000)
	db.prepare('INSERT INTO listing_image_data (listing_id, data, cached_at) VALUES (?, ?, ?)').run(7001, imageBytes, 1_700_000_000)
	db.prepare(`
		INSERT INTO listing_variation_images (
			listing_id, style_key, style_value, image_id, url,
			value_id, property_id, cached_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`	).run(7002, 'case + charm', 'Case + Charm', 99, variationUrl, 202, 514, 1_700_000_123)

	const customTitle = 'Hello Kitty Kawaii Magnetic Stand Phone Case'
	const catalogTitle = 'Catalog MagSafe Case'
	const customKey = routeDashboard.lineItemKeyWithVariant(customTitle, null, 'iPhone 17 Pro Max', 'Case+Grip+Charm')
	const catalogKey = routeDashboard.lineItemKeyWithVariant(catalogTitle, 7001, 'iPhone 17 Pro Max', 'Case Only')
	const createdManual = createRouteManualOrder(db, {
		shop_id: MANUAL_SHOP_ID,
		items: [
			{
				source: 'catalog',
				title: catalogTitle,
				listing_id: 7001,
				image_url: heroUrl,
				item_key: catalogKey,
				phone_model: 'iPhone 17 Pro Max',
				style: 'Case Only',
				quantity: 1,
			},
			{
				source: 'custom',
				title: customTitle,
				item_key: customKey,
				phone_model: 'iPhone 17 Pro Max',
				style: 'Case+Grip+Charm',
				quantity: 1,
				image_data: imageBytes,
				image_mime: 'image/png',
			},
		],
	})
	db.close()

	fs.writeFileSync(
		configPath,
		JSON.stringify({
			db_path: dbPath,
			sync_interval_minutes: 1440,
			groups: [{
				group_id: 'G1',
				label: 'Image test',
				proxy: 'direct',
				shops: [{
					shop_id: 'S1',
					shop_name: 'ImageTestShop',
					api_key: 'image-test-api-key',
					shared_secret: 'image-test-shared-secret',
				}],
			}],
		}),
		'utf8',
	)

	const child = spawn(process.execPath, [path.resolve(__dirname, '../src/server/index.js')], {
		env: {
			...process.env,
			PORT: String(dashboardPort),
			DASHBOARD_CONFIG_PATH: configPath,
			EMBEDDED_SYNC: '0',
			DASHBOARD_OWNER_PASSWORD: '',
			DASHBOARD_PACKER_PASSWORD: '',
			DASHBOARD_SHOPPER_PASSWORD: '',
			DASHBOARD_AUTH_SECRET: '',
		},
		stdio: ['ignore', 'ignore', 'pipe'],
	})
	let stderr = ''
	child.stderr.on('data', (chunk) => {
		stderr += chunk.toString()
	})

	try {
		await waitForHealth(base, child)
		const ordersResponse = await fetch(`${base}/api/orders?shipped=all&limit=20`)
		check(ordersResponse.ok, 'real Orders API responds')
		const payload = await ordersResponse.json()
		const order = payload.orders.find((entry) => entry.receipt_id === 8001)
		check(!!order && order.transactions.length === 2, 'test order retains both product lines')

		const [hero, variation] = order.transactions
		check(
			hero.image_url === '/api/route/listing-image/7001?w=300',
			'listing hero is represented by a same-origin cache URL',
		)
		check(
			variation.image_url === '/api/route/variation-image/7002?k=Case%20%2B%20Charm&v=1700000123&w=300',
			'exact selected variation is represented by its same-origin proxy URL',
		)
		check(
			order.product_image_url === hero.image_url,
			'top-level fallback image uses the same-origin first-line URL',
		)
		check(
			!JSON.stringify([order.product_image_url, ...order.transactions.map((tx) => tx.image_url)]).includes('127.0.0.1'),
			'Orders payload exposes no origin-machine or third-party image host',
		)

		const manual = payload.orders.find((entry) => entry.receipt_id === createdManual.receipt_id)
		check(!!manual && manual.transactions.length === 2, 'manual order retains both product lines')
		const customTx = manual.transactions.find((tx) => tx.title === customTitle)
		check(
			!!customTx && /^\/api\/route\/manual-image\/\d+/.test(String(customTx.image_url || '')),
			'uploaded custom photo is served from the sidecar endpoint',
		)
		const catalogTx = manual.transactions.find((tx) => tx.title === catalogTitle)
		check(
			!!catalogTx && String(catalogTx.image_url || '').startsWith('/api/route/listing-image/7001'),
			'catalog sidecar still resolves through the listing cache',
		)

		const heroResponse = await fetch(base + hero.image_url)
		check(heroResponse.ok && (await heroResponse.arrayBuffer()).byteLength > 0, 'cached hero bytes stream through the dashboard')
		check(originHits === 0, 'cached hero requires no external origin request')

		const variationResponse = await fetch(base + variation.image_url)
		check(variationResponse.ok && (await variationResponse.arrayBuffer()).byteLength > 0, 'variation bytes stream through the dashboard')
		check(originHits === 1, 'variation proxy fetches the exact approved URL server-side once')

		const customImg = await fetch(base + customTx.image_url)
		check(
			customImg.ok && (await customImg.arrayBuffer()).byteLength === imageBytes.length,
			'uploaded custom bytes stream through the dashboard',
		)
		check(!/listing-image .* failed|variation-image .* failed|manual-image .* failed/i.test(stderr), 'image routes log no serving failures')
	} finally {
		child.kill()
		await new Promise((resolve) => setTimeout(resolve, 200))
		await close(origin)
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true })
		} catch {}
	}

	console.log(`\nPASS — ${passed} LAN image integration checks`)
}

main().catch((err) => {
	console.error(`FAIL — ${err.message}`)
	process.exitCode = 1
})
