'use strict'

/**
 * Offline smoke test for /api/supplies mounted like UED.
 * Does not start the full dashboard (avoids duplicate sync schedulers).
 */
const http = require('http')
const express = require('express')
const path = require('path')
const fs = require('fs')
const os = require('os')
const Database = require('better-sqlite3')
const supplies = require('../src/supplies/routes')
const core = require('../src/supplies/core')
const catalogSeed = require('../src/supplies/catalog-seed')

function assert(cond, msg) {
	if (!cond) throw new Error(msg)
}

function assertSeedPhotosMatchNames() {
	assert(catalogSeed.length === 32, `seed has ${catalogSeed.length} rows`)
	const names = catalogSeed.map((r) => r.name)
	const zh = catalogSeed.map((r) => r.name_zh)
	assert(new Set(names).size === names.length, 'English seed names must be unique')
	assert(new Set(zh).size === zh.length, 'Chinese seed names must be unique')
	const bySku = Object.fromEntries(catalogSeed.map((r) => [r.sku, r]))
	assert(bySku['BAG-BLUE-WOVEN'].name_zh === '紫色蝴蝶结透明袋')
	assert(bySku['BAG-BLUE-WOVEN'].category === 'bags')
	assert(bySku['BAG-BOWKNOT-CLEAR'].name_zh === '蓝色防拆封条')
	assert(bySku['BAG-BOWKNOT-CLEAR'].category === 'seals')
	assert(bySku['BAG-PINK-POLY-A'].name_zh === '粉白菱格自封袋')
	assert(bySku['BAG-PINK-POLY-B'].name_zh === '米菲透明袋')
	assert(bySku['BAG-CLEAR-PATTERN'].name_zh === '爱心感谢封口贴')
	assert(bySku['BAG-CLEAR-PATTERN'].category === 'stickers')
	assert(bySku['BOX-PINK-MAILER-M'].name_zh === '蓝色编织袋')
	assert(bySku['BOX-PINK-MAILER-M'].category === 'bags')
	assert(bySku['SEL-4PX-SECURITY'].name_zh === '粉色纸箱（中）')
	assert(bySku['SEL-4PX-SECURITY'].category === 'boxes')
	assert(bySku['BBW-PINK-HEART'].category === 'mailers')
	assert(bySku['BBW-CLEAR-STD'].category === 'stickers')
	assert(bySku['MSC-ELASTIC-PINK'].category === 'bubble_wrap')
	assert(bySku['MLR-PINK-BUBBLE'].category === 'misc')
	assert(bySku['STK-HELLO-KITTY-ROLL'].family === 'hello_kitty')
	assert(bySku['STK-KUROMI-ROLL'].family === 'kuromi')
	assert(bySku['STK-CINNAMOROLL-ROLL'].name_zh === '米菲圆形贴纸卷')
	assert(bySku['STK-CINNAMOROLL-ROLL'].family === 'miffy')
	assert(bySku['STK-PURPLE-BOW'].name_zh === '玉桂狗贴纸盒（63张）')
	assert(bySku['STK-PURPLE-BOW'].family === 'cinnamoroll')
	assert(bySku['STK-ASSORTED-CHAR-ROLL-C'].family === 'other')
}

async function req(port, method, urlPath, body, role = 'packer') {
	const data = body ? JSON.stringify(body) : null
	return new Promise((resolve, reject) => {
		const r = http.request(
			{
				hostname: '127.0.0.1',
				port,
				path: urlPath,
				method,
				headers: {
					'Content-Type': 'application/json',
					'X-Test-Role': role,
					'X-Test-User': role === 'owner' ? 'owner' : 'mei',
					...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
				},
			},
			(res) => {
				let b = ''
				res.on('data', (c) => (b += c))
				res.on('end', () => {
					let parsed = null
					try {
						parsed = b ? JSON.parse(b) : null
					} catch {
						parsed = b
					}
					resolve({ status: res.statusCode, headers: res.headers, body: parsed })
				})
			},
		)
		r.on('error', reject)
		if (data) r.write(data)
		r.end()
	})
}

function reqBytes(port, urlPath, extraHeaders = {}) {
	return new Promise((resolve, reject) => {
		http.get(
			{
				hostname: '127.0.0.1',
				port,
				path: urlPath,
				headers: {
					'X-Test-Role': 'packer',
					'X-Test-User': 'mei',
					...extraHeaders,
				},
			},
			(res) => {
				const chunks = []
				res.on('data', (c) => chunks.push(c))
				res.on('end', () =>
					resolve({
						status: res.statusCode,
						headers: res.headers,
						body: Buffer.concat(chunks),
					}),
				)
			},
		).on('error', reject)
	})
}

function assertOldSchemaMigrates() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ued-supplies-mig-'))
	const db = new Database(path.join(tmp, 'old.sqlite'))
	db.pragma('foreign_keys = ON')
	db.exec(`
		CREATE TABLE supply_categories (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			slug TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL,
			sort_order INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE supply_items (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			sku TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL,
			category_id INTEGER NOT NULL REFERENCES supply_categories(id),
			uom TEXT NOT NULL,
			reorder_point REAL NOT NULL DEFAULT 0,
			reorder_qty REAL NOT NULL DEFAULT 0,
			photo_file TEXT,
			notes TEXT,
			active INTEGER NOT NULL DEFAULT 1,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE TABLE supply_movements (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			item_id INTEGER NOT NULL REFERENCES supply_items(id),
			kind TEXT NOT NULL,
			qty_delta REAL NOT NULL,
			qty_before REAL NOT NULL,
			qty_after REAL NOT NULL,
			actor TEXT,
			note TEXT,
			ref_type TEXT,
			ref_id INTEGER,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
	`)
	core.migrateSuppliesSchema(db)
	const cols = new Set(db.pragma('table_info(supply_items)').map((c) => c.name))
	for (const col of ['unit_cost', 'currency', 'supplier_name', 'supplier_url', 'name_zh', 'sort_order', 'family', 'needs_purchase', 'needs_purchase_at', 'needs_purchase_by', 'purchased_at', 'purchased_by']) {
		assert(cols.has(col), `migration missing ${col}`)
	}
	const mvCols = new Set(db.pragma('table_info(supply_movements)').map((c) => c.name))
	for (const col of ['unit_cost', 'cost_total', 'currency']) {
		assert(mvCols.has(col), `movement migration missing ${col}`)
	}
	db.close()
	fs.rmSync(tmp, { recursive: true, force: true })
}

async function main() {
	assertSeedPhotosMatchNames()
	assertOldSchemaMigrates()

	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ued-supplies-'))
	const dbPath = path.join(tmp, 'test.sqlite')
	const db = new Database(dbPath)
	db.pragma('foreign_keys = ON')

	const app = express()
	app.use(express.json({ limit: '2mb' }))
	app.use((req, _res, next) => {
		req.auth = {
			role: req.headers['x-test-role'] || 'packer',
			user: req.headers['x-test-user'] || 'mei',
		}
		next()
	})
	supplies.installRoutes(app, { db, dbPath, warmup: false })

	const server = await new Promise((resolve) => {
		const s = app.listen(0, '127.0.0.1', () => resolve(s))
	})
	const port = server.address().port

	try {
		const items = await req(port, 'GET', '/api/supplies/items')
		assert(items.status === 200, `items status ${items.status}`)
		assert(items.body.items.length === 32, `expected 32 items, got ${items.body.items.length}`)
		assert(items.body.items.every((i) => i.photo_path), 'every item should have photo_path')
		assert(
			items.body.items.every((i) => typeof i.photo_thumb === 'string' && i.photo_thumb.includes('?w=240')),
			'every item should advertise a 240px thumbnail',
		)
		assert(
			items.body.items.every((i) => Object.prototype.hasOwnProperty.call(i, 'supplier_url')),
			'supplier_url is part of the inventory payload',
		)
		assert(
			items.body.items.every((i) => Object.prototype.hasOwnProperty.call(i, 'unit_cost')),
			'unit_cost is part of the inventory payload',
		)
		assert(
			items.body.items.every((i) => i.name_zh && /[\u4e00-\u9fff]/.test(i.name_zh)),
			'seeded items carry a Chinese display name',
		)

		const seals = items.body.items.find((i) => i.sku === 'BAG-BOWKNOT-CLEAR')
		assert(seals && seals.name_zh === '蓝色防拆封条', 'seal photo is named as seals')
		assert(seals.category_slug === 'seals', '4PX seals sit in the seals section')
		const woven = items.body.items.find((i) => i.sku === 'BOX-PINK-MAILER-M')
		assert(woven && woven.name_zh === '蓝色编织袋', 'woven sack photo is named as a bag')
		assert(woven.category_slug === 'bags', 'woven sack is not filed as a box')
		const bowBag = items.body.items.find((i) => i.sku === 'BAG-BLUE-WOVEN')
		assert(bowBag && bowBag.name_zh === '紫色蝴蝶结透明袋')
		assert(bowBag.category_slug === 'bags')

		const cats = await req(port, 'GET', '/api/supplies/categories')
		assert(cats.status === 200, 'categories')
		assert(Array.isArray(cats.body.families?.stickers), 'sticker families are advertised')
		assert(cats.body.families.stickers.some((f) => f.slug === 'hello_kitty'))
		const stickers = await req(port, 'GET', '/api/supplies/items?category=stickers')
		assert(stickers.body.items.length >= 10, 'sticker catalog')
		assert(
			stickers.body.items.every((i) => i.family && i.family_name),
			'every sticker has a character family',
		)
		const helloKitty = stickers.body.items.filter((i) => i.family === 'hello_kitty')
		assert(helloKitty.length >= 2, 'Hello Kitty subclass has multiple rolls')
		assert(helloKitty.every((i) => i.family_name === 'Hello Kitty'))
		const helloOnly = await req(port, 'GET', '/api/supplies/items?category=stickers&family=hello_kitty')
		assert(helloOnly.body.items.length === helloKitty.length)
		assert(helloOnly.body.items.every((i) => i.family === 'hello_kitty'))
		const intoKuromi = await req(
			port,
			'POST',
			'/api/supplies/items/reorder',
			{
				item_id: helloKitty[0].id,
				category_slug: 'stickers',
				family: 'kuromi',
				before_id: null,
			},
			'owner',
		)
		assert(intoKuromi.status === 200, `move into Kuromi ${intoKuromi.status}`)
		assert(intoKuromi.body.item.family === 'kuromi', 'sticker subclass updated')

		const boxes = await req(port, 'GET', '/api/supplies/items?category=boxes')
		assert(boxes.body.items.length >= 2, 'boxes to rearrange')
		const [boxA, boxB] = boxes.body.items
		const packerReorder = await req(port, 'POST', '/api/supplies/items/reorder', {
			item_id: boxB.id,
			category_slug: 'boxes',
			before_id: boxA.id,
		}, 'packer')
		assert(packerReorder.status === 200, `packer can rearrange (${packerReorder.status})`)
		const boxesAfter = await req(port, 'GET', '/api/supplies/items?category=boxes')
		assert(boxesAfter.body.items[0].id === boxB.id, 'dropped card is first in the section')
		assert(boxesAfter.body.items[1].id === boxA.id, 'previous first card follows')

		const bags = await req(port, 'GET', '/api/supplies/items?category=bags')
		const bag = bags.body.items[0]
		const crossed = await req(port, 'POST', '/api/supplies/items/reorder', {
			item_id: bag.id,
			category_slug: 'boxes',
			before_id: null,
		}, 'owner')
		assert(crossed.status === 200, `move between sections ${crossed.status}`)
		assert(crossed.body.item.category_slug === 'boxes', 'card moved to the drop section')

		const photoName = items.body.items[0].photo_file
		const original = await reqBytes(port, `/api/supplies/photos/${encodeURIComponent(photoName)}`)
		assert(original.status === 200, `photo status ${original.status}`)
		assert(original.headers['x-content-type-options'] === 'nosniff', 'original photo disables MIME sniffing')
		assert(String(original.headers['content-security-policy'] || '').includes('sandbox'), 'original photo is inert under navigation')

		const thumb = await reqBytes(port, `/api/supplies/photos/${encodeURIComponent(photoName)}?w=240`)
		assert(thumb.status === 200, `thumb status ${thumb.status}`)
		assert(thumb.headers['x-content-type-options'] === 'nosniff', 'thumbnail disables MIME sniffing')
		assert(String(thumb.headers['content-security-policy'] || '').includes('sandbox'), 'thumbnail is inert under navigation')
		assert(String(thumb.headers['content-type'] || '').includes('image/webp'), `thumb type ${thumb.headers['content-type']}`)
		assert(thumb.body.length > 32, 'thumb has bytes')
		assert(thumb.body.length < original.body.length, 'thumbnail must be smaller than the stored photo')
		assert(String(thumb.headers['cache-control'] || '').includes('immutable'), 'thumbs are immutably cacheable')

		const etag = thumb.headers.etag
		assert(etag, 'thumb sends an ETag')
		const cached = await reqBytes(port, `/api/supplies/photos/${encodeURIComponent(photoName)}?w=240`, {
			'If-None-Match': etag,
		})
		assert(cached.status === 304, `revalidated thumb ${cached.status}`)

		const start = await req(port, 'POST', '/api/supplies/counts', {})
		assert(start.status === 201, `start count ${start.status}`)
		const sid = start.body.session.id
		assert(start.body.session.progress.total === 32, 'count lines')
		assert(
			start.body.session.lines.every((l) => l.photo_thumb && l.photo_thumb.includes('?w=240')),
			'count cards use thumbnails, not original photos',
		)

		const first = start.body.session.lines[0]
		const line = await req(port, 'PUT', `/api/supplies/counts/${sid}/lines`, {
			lines: [{ item_id: first.item_id, counted_qty: 7 }],
		})
		assert(line.status === 200, `line save ${line.status}`)
		assert(line.body.session.progress.counted === 1, 'one counted')

		const recv = await req(port, 'POST', '/api/supplies/receive', {
			item_id: first.item_id,
			qty: 3,
			note: 'smoke receive',
		})
		assert(recv.status === 201, `receive ${recv.status}`)
		assert(Number(recv.body.item.qty_on_hand) === 3, `qty after receive ${recv.body.item.qty_on_hand}`)

		const catalogByPacker = await req(port, 'POST', '/api/supplies/items', {
			sku: 'PACKER-SKU',
			name: 'Packer Tape',
			category_slug: 'tape',
			uom: 'roll',
			reorder_point: 0,
			reorder_qty: 2,
		}, 'packer')
		assert(catalogByPacker.status === 201, `packer can create catalog item (${catalogByPacker.status})`)
		assert(catalogByPacker.body.item.name === 'Packer Tape', 'packer-created name saved')

		const badUrl = await req(port, 'POST', '/api/supplies/items', {
			sku: 'TEST-XSS',
			name: 'Nope',
			category_slug: 'misc',
			uom: 'each',
			reorder_point: 1,
			reorder_qty: 2,
			supplier_url: 'javascript:alert(1)',
		}, 'owner')
		assert(badUrl.status === 400, `javascript: supplier URL must be rejected (${badUrl.status})`)

		const catalogOk = await req(port, 'POST', '/api/supplies/items', {
			sku: 'TEST-SKU',
			name: 'Test Item',
			category_slug: 'misc',
			uom: 'each',
			reorder_point: 1,
			reorder_qty: 2,
			unit_cost: 12.5,
			currency: 'CNY',
			supplier_name: 'Taobao',
			supplier_url: 'https://item.taobao.com/item.htm?id=1',
		}, 'owner')
		assert(catalogOk.status === 201, `owner create ${catalogOk.status}`)
		assert(catalogOk.body.item.unit_cost === 12.5, 'unit cost saved')
		assert(catalogOk.body.item.currency === 'CNY', 'currency saved')
		assert(catalogOk.body.item.supplier_name === 'Taobao', 'supplier name saved')
		assert(String(catalogOk.body.item.supplier_url).startsWith('https://item.taobao.com/'), 'supplier url saved')

		const openDuringCreate = await req(port, 'GET', '/api/supplies/counts/current')
		assert(openDuringCreate.body.session, 'count stays open after catalog create')
		assert(
			openDuringCreate.body.session.lines.some((l) => l.item_id === catalogOk.body.item.id),
			'a SKU added during an open count is included in that count',
		)

		const patched = await req(port, 'PATCH', `/api/supplies/items/${catalogOk.body.item.id}`, {
			unit_cost: 9.9,
			supplier_url: 'https://www.amazon.com/dp/B0TEST',
		}, 'owner')
		assert(patched.status === 200, `owner patch ${patched.status}`)
		assert(patched.body.item.unit_cost === 9.9, 'unit cost updated')
		assert(String(patched.body.item.supplier_url).includes('amazon.com'), 'supplier url updated')

		const pricedRecv = await req(port, 'POST', '/api/supplies/receive', {
			item_id: catalogOk.body.item.id,
			qty: 4,
			unit_cost: 3.25,
			currency: 'CNY',
			note: 'taobao restock',
		}, 'packer')
		assert(pricedRecv.status === 201, `priced receive ${pricedRecv.status}`)
		assert(pricedRecv.body.movement.unit_cost === 3.25, 'receive stores unit cost')
		assert(pricedRecv.body.movement.cost_total === 13, `receive total ${pricedRecv.body.movement.cost_total}`)
		assert(pricedRecv.body.movement.currency === 'CNY', 'receive stores currency')
		assert(pricedRecv.body.item.unit_cost === 3.25, 'last paid price updates the catalog')
		assert(pricedRecv.body.item.currency === 'CNY', 'last paid currency updates the catalog')

		const inheritRecv = await req(port, 'POST', '/api/supplies/receive', {
			item_id: catalogOk.body.item.id,
			qty: 2,
			note: 'reuse last paid',
		}, 'packer')
		assert(inheritRecv.status === 201, `inherit receive ${inheritRecv.status}`)
		assert(inheritRecv.body.movement.unit_cost === 3.25, 'blank restock reuses last paid unit cost')
		assert(inheritRecv.body.movement.cost_total === 6.5, `inherited total ${inheritRecv.body.movement.cost_total}`)
		assert(inheritRecv.body.item.unit_cost === 3.25, 'inherited restock does not rewrite last paid')

		const spendFrom = new Date(Date.now() - 3600_000).toISOString()
		const spendTo = new Date(Date.now() + 3600_000).toISOString()
		const spendPath = `/api/supplies/spend?from=${encodeURIComponent(spendFrom)}&to=${encodeURIComponent(spendTo)}`
		const spendPacker = await req(port, 'GET', spendPath, null, 'packer')
		assert(spendPacker.status === 403, 'packer cannot read spend')
		const spend = await req(port, 'GET', spendPath, null, 'owner')
		assert(spend.status === 200, `spend ${spend.status}`)
		const mine = (spend.body.lines || []).filter((line) => line.item_id === catalogOk.body.item.id)
		assert(mine.length >= 2, `expected priced restocks in spend, got ${mine.length}`)
		const cny = (spend.body.totals || []).find((row) => row.currency === 'CNY')
		assert(cny && cny.amount >= 19.5, `CNY spend should include 13 + 6.5, got ${cny && cny.amount}`)
		const missingSpend = await req(port, 'GET', '/api/supplies/spend', null, 'owner')
		assert(missingSpend.status === 400, 'spend requires a range')
		const invertedSpend = await req(port, 'GET', `/api/supplies/spend?from=${encodeURIComponent(spendTo)}&to=${encodeURIComponent(spendFrom)}`, null, 'owner')
		assert(invertedSpend.status === 400, 'spend rejects inverted range')

		const renamed = await req(port, 'PATCH', `/api/supplies/items/${catalogOk.body.item.id}`, {
			name: 'Shelf Label',
			name_zh: '货架标签',
			category_slug: 'bags',
		}, 'owner')
		assert(renamed.status === 200, `rename/move ${renamed.status}`)
		assert(renamed.body.item.name === 'Shelf Label', 'name updated')
		assert(renamed.body.item.name_zh === '货架标签', 'chinese name updated')
		assert(renamed.body.item.category_slug === 'bags', 'category moved')

		const TINY_PNG =
			'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
		const photoReplace = await req(
			port,
			'PATCH',
			`/api/supplies/items/${catalogOk.body.item.id}`,
			{ photo_data: TINY_PNG },
			'owner',
		)
		assert(photoReplace.status === 200, `owner photo replace ${photoReplace.status} ${JSON.stringify(photoReplace.body)}`)
		assert(photoReplace.body.item.photo_file, 'replaced photo is stored')
		assert(photoReplace.body.item.photo_path, 'replaced photo has a url')
		assert(String(photoReplace.body.item.photo_thumb || '').includes('?w=240'), 'replaced photo still serves a thumb')

		const seededPhoto = items.body.items.find((i) => i.photo_file && i.photo_file !== photoName)
		assert(seededPhoto, 'seeded catalog has a photo to replace')
		const photosDirEarly = core.resolvePhotosDir(dbPath)
		const previousSeedPath = path.join(photosDirEarly, seededPhoto.photo_file)
		assert(fs.existsSync(previousSeedPath), 'seed photo exists before replace')
		const swapped = await req(
			port,
			'PATCH',
			`/api/supplies/items/${seededPhoto.id}`,
			{ photo_data: TINY_PNG },
			'owner',
		)
		assert(swapped.status === 200, `seeded photo replace ${swapped.status}`)
		assert(swapped.body.item.photo_file !== seededPhoto.photo_file, 'new photo file replaces the previous one')
		assert(!fs.existsSync(previousSeedPath), 'replaced seed photo is removed once nothing references it')

		const packerPhoto = await req(
			port,
			'PATCH',
			`/api/supplies/items/${catalogOk.body.item.id}`,
			{ photo_data: TINY_PNG },
			'packer',
		)
		assert(packerPhoto.status === 200, `packer can replace photos (${packerPhoto.status})`)
		assert(packerPhoto.body.item.photo_file, 'packer photo replace is stored')

		const nameless = await req(port, 'POST', '/api/supplies/items', {
			name: 'Auto SKU Tape',
			name_zh: '自动编号胶带',
			category_slug: 'tape',
			uom: 'roll',
			reorder_point: 0,
			reorder_qty: 2,
		}, 'owner')
		assert(nameless.status === 201, `create without sku ${nameless.status} ${JSON.stringify(nameless.body)}`)
		assert(nameless.body.item.sku, 'server allocated an internal sku')
		assert(nameless.body.item.name === 'Auto SKU Tape', 'name is the identity')

		assert(core.escapeLikePattern('50%_off\\x') === '50\\%\\_off\\\\x', 'LIKE metacharacters are escaped')
		const underscoreItem = await req(port, 'POST', '/api/supplies/items', {
			name: 'Hello_World Pack',
			name_zh: '下划线测试包材',
			category_slug: 'misc',
			uom: 'each',
			reorder_point: 0,
			reorder_qty: 1,
		}, 'owner')
		assert(underscoreItem.status === 201, `underscore name ${underscoreItem.status}`)
		const percentItem = await req(port, 'POST', '/api/supplies/items', {
			name: 'Hello%World Pack',
			name_zh: '百分号测试包材',
			category_slug: 'misc',
			uom: 'each',
			reorder_point: 0,
			reorder_qty: 1,
		}, 'owner')
		assert(percentItem.status === 201, `percent name ${percentItem.status}`)
		const likePercent = await req(port, 'GET', `/api/supplies/items?q=${encodeURIComponent('Hello%World')}`)
		assert(likePercent.status === 200, 'percent search')
		assert(
			likePercent.body.items.some((i) => i.id === percentItem.body.item.id),
			'literal percent sign matches the percent name',
		)
		assert(
			!likePercent.body.items.some((i) => i.id === underscoreItem.body.item.id),
			'percent is not treated as a LIKE wildcard',
		)
		const likeUnder = await req(port, 'GET', `/api/supplies/items?q=${encodeURIComponent('Hello_World')}`)
		assert(
			likeUnder.body.items.some((i) => i.id === underscoreItem.body.item.id),
			'literal underscore matches the underscore name',
		)
		assert(
			!likeUnder.body.items.some((i) => i.id === percentItem.body.item.id),
			'underscore is not treated as a LIKE wildcard',
		)
		const stockUnder = await req(port, 'POST', '/api/supplies/receive', {
			item_id: underscoreItem.body.item.id,
			qty: 1,
		})
		assert(stockUnder.status === 201, 'underscore fixture is not left at zero')
		const stockPercent = await req(port, 'POST', '/api/supplies/receive', {
			item_id: percentItem.body.item.id,
			qty: 1,
		})
		assert(stockPercent.status === 201, 'percent fixture is not left at zero')

		const clash = await req(port, 'POST', '/api/supplies/items', {
			name: 'Shelf Label',
			category_slug: 'misc',
			uom: 'each',
			reorder_point: 0,
			reorder_qty: 1,
		}, 'owner')
		assert(clash.status === 409, `duplicate name rejected (${clash.status})`)

		const collapsed = await req(port, 'PATCH', `/api/supplies/items/${catalogOk.body.item.id}`, {
			name: '  Pretty   Box  ',
		}, 'owner')
		assert(collapsed.status === 200, `whitespace name ${collapsed.status}`)
		assert(collapsed.body.item.name === 'Pretty Box', 'name whitespace is collapsed')

		const tooLong = await req(port, 'PATCH', `/api/supplies/items/${catalogOk.body.item.id}`, {
			name: 'N'.repeat(core.ITEM_NAME_MAX + 1),
		}, 'owner')
		assert(tooLong.status === 400, `overlong name rejected (${tooLong.status})`)
		assert(tooLong.body.error === 'Name is too long', 'overlong name error')

		await req(port, 'DELETE', `/api/supplies/items/${nameless.body.item.id}`, null, 'owner')

		const archived = await req(port, 'DELETE', `/api/supplies/items/${catalogOk.body.item.id}`, null, 'owner')
		assert(archived.status === 200, `owner archive ${archived.status}`)
		assert(archived.body.archived === true, 'delete retires rather than erasing history')
		assert(archived.body.deleted === false, 'default delete is not a purge')
		assert(archived.body.item.active === 0, 'retired item is inactive')

		const liveAfterRetire = await req(port, 'GET', '/api/supplies/items?active=1')
		assert(
			!liveAfterRetire.body.items.some((i) => i.id === catalogOk.body.item.id),
			'retired item leaves the live catalog',
		)
		const historyAfterRetire = await req(port, 'GET', '/api/supplies/items?active=all')
		assert(
			historyAfterRetire.body.items.some((i) => i.id === catalogOk.body.item.id && i.active === 0),
			'retired item remains in history',
		)

		const openAfterRetire = await req(port, 'GET', '/api/supplies/counts/current')
		assert(openAfterRetire.body.session, 'open count survives retire')
		assert(
			!openAfterRetire.body.session.lines.some((l) => l.item_id === catalogOk.body.item.id),
			'retired item leaves the open count',
		)

		const packerDelete = await req(port, 'DELETE', `/api/supplies/items/${catalogOk.body.item.id}`, null, 'packer')
		assert(packerDelete.status === 200, `packer can retire a catalog item (${packerDelete.status})`)
		assert(packerDelete.body.archived === true, 'packer retire is the same two-step delete')

		const purgeWhileActive = await req(port, 'DELETE', `/api/supplies/items/${first.item_id}?purge=1`, null, 'owner')
		assert(purgeWhileActive.status === 409, 'cannot permanently delete an active supply')
		assert(
			purgeWhileActive.body.error === 'Retire this supply before deleting it permanently',
			'purge of an active item explains the two-step rule',
		)

		const retiredAgain = await req(port, 'DELETE', `/api/supplies/items/${catalogOk.body.item.id}`, null, 'owner')
		assert(retiredAgain.status === 200, 'retiring an already retired item is idempotent')
		assert(retiredAgain.body.archived === true, 'idempotent retire still reports archived')

		const restored = await req(port, 'PATCH', `/api/supplies/items/${catalogOk.body.item.id}`, {
			active: 1,
		}, 'owner')
		assert(restored.status === 200, `restore ${restored.status}`)
		assert(restored.body.item.active === 1, 'restored item is active')
		const openAfterRestore = await req(port, 'GET', '/api/supplies/counts/current')
		assert(
			openAfterRestore.body.session.lines.some((l) => l.item_id === catalogOk.body.item.id),
			'restored item re-enters the open count',
		)

		const retireForPurge = await req(port, 'DELETE', `/api/supplies/items/${catalogOk.body.item.id}`, null, 'owner')
		assert(retireForPurge.status === 200, `retire before purge ${retireForPurge.status}`)
		const photosDirForPurge = core.resolvePhotosDir(dbPath)
		const replacedPhoto = packerPhoto.body.item.photo_file
		assert(replacedPhoto, 'replaced photo filename is known')
		assert(fs.existsSync(path.join(photosDirForPurge, replacedPhoto)), 'replaced photo exists before purge')

		const purged = await req(port, 'DELETE', `/api/supplies/items/${catalogOk.body.item.id}?purge=1`, null, 'owner')
		assert(purged.status === 200, `purge ${purged.status}`)
		assert(purged.body.deleted === true, 'purge reports deleted')
		assert(purged.body.archived === false, 'purge is not an archive')
		assert(purged.body.item == null, 'purged item is gone from the payload')
		const gone = await req(port, 'GET', `/api/supplies/items/${catalogOk.body.item.id}`)
		assert(gone.status === 404, 'purged item is not fetchable')
		assert(!fs.existsSync(path.join(photosDirForPurge, replacedPhoto)), 'purged photo is removed')
		const purgeAgain = await req(port, 'DELETE', `/api/supplies/items/${catalogOk.body.item.id}?purge=1`, null, 'owner')
		assert(purgeAgain.status === 404, 'purging a missing item is 404')

		const packerPatch = await req(port, 'PATCH', `/api/supplies/items/${catalogByPacker.body.item.id}`, {
			name: 'Packer Tape Renamed',
			supplier_name: 'Packer Shop',
		}, 'packer')
		assert(packerPatch.status === 200, `packer can edit catalog (${packerPatch.status})`)
		assert(packerPatch.body.item.name === 'Packer Tape Renamed', 'packer can rename a supply')
		assert(packerPatch.body.item.supplier_name === 'Packer Shop', 'packer catalog write is persisted')

		const alerts = await req(port, 'GET', '/api/supplies/alerts')
		assert(alerts.status === 200, `alerts ${alerts.status}`)
		assert(alerts.body.low_stock_count >= 1, 'some low stock')
		assert(Array.isArray(alerts.body.low_stock), 'low_stock list')
		assert(Array.isArray(alerts.body.needs_purchase), 'needs_purchase list')
		assert(alerts.body.needs_purchase_count === 0, 'nothing flagged to buy yet')
		assert(
			alerts.body.low_stock
				.filter((i) => i.photo_file)
				.every((i) => i.photo_thumb && i.photo_thumb.includes('?w=240')),
			'alert photos are thumbnails',
		)
		assert(
			alerts.body.low_stock.some((i) => i.photo_thumb && i.photo_thumb.includes('?w=240')),
			'seeded low-stock alerts still include a photo',
		)

		const flagDenied = await req(port, 'POST', `/api/supplies/items/${first.item_id}/needs-purchase`, {}, 'packer')
		assert(flagDenied.status === 400, 'needed is required')

		const flagged = await req(port, 'POST', `/api/supplies/items/${first.item_id}/needs-purchase`, { needed: true }, 'packer')
		assert(flagged.status === 200, `packer can flag needs-purchase (${flagged.status})`)
		assert(flagged.body.item.needs_purchase === 1, 'item is flagged')
		assert(flagged.body.item.needs_purchase_by === 'mei', 'actor is stored')
		const alertsBuy = await req(port, 'GET', '/api/supplies/alerts')
		assert(alertsBuy.body.needs_purchase_count === 1, 'alerts include the purchase flag')
		assert(alertsBuy.body.needs_purchase[0].id === first.item_id, 'flagged SKU is on the purchase list')
		const openFlagged = await req(port, 'GET', '/api/supplies/counts/current')
		assert(
			openFlagged.body.session.lines.some((l) => l.item_id === first.item_id && l.needs_purchase === 1),
			'open count lines carry the purchase flag',
		)

		const packerPurchased = await req(port, 'POST', `/api/supplies/items/${first.item_id}/purchased`, { purchased: true }, 'packer')
		assert(packerPurchased.status === 403, 'packer cannot mark purchased')

		const purchasedDenied = await req(port, 'POST', `/api/supplies/items/${first.item_id}/purchased`, { purchased: false }, 'owner')
		assert(purchasedDenied.status === 400, 'purchased must be true')

		const bought = await req(port, 'POST', `/api/supplies/items/${first.item_id}/purchased`, { purchased: true }, 'owner')
		assert(bought.status === 200, `owner can mark purchased (${bought.status})`)
		assert(bought.body.item.needs_purchase === 0, 'Mark purchased clears the buy list')
		assert(bought.body.item.purchased_by === 'owner', 'purchaser is stored')
		assert(bought.body.item.purchased_at, 'purchased_at is stored')
		const alertsBought = await req(port, 'GET', '/api/supplies/alerts')
		assert(alertsBought.body.needs_purchase_count === 0, 'purchase list is empty after Mark purchased')

		const reflag = await req(port, 'POST', `/api/supplies/items/${first.item_id}/needs-purchase`, { needed: true }, 'packer')
		assert(reflag.status === 200, 'employee can flag again after a purchase')

		const recvClears = await req(port, 'POST', '/api/supplies/receive', {
			item_id: first.item_id,
			qty: 1,
			note: 'arrived',
		})
		assert(recvClears.status === 201, `receive after flag ${recvClears.status}`)
		assert(recvClears.body.item.needs_purchase === 0, 'restocking clears Need to buy')
		const alertsAfterRecv = await req(port, 'GET', '/api/supplies/alerts')
		assert(alertsAfterRecv.body.needs_purchase_count === 0, 'purchase list is empty after restock')

		const photosDir = core.resolvePhotosDir(dbPath)
		assert(fs.readdirSync(photosDir).length >= 32, 'seed photos copied')
		const samplePhoto = path.join(photosDir, photoName)
		assert(fs.statSync(samplePhoto).size < 1_500_000, `stored seed photo should be transcoded, got ${fs.statSync(samplePhoto).size} bytes`)

		console.log('supplies smoke OK')
	} finally {
		await new Promise((resolve) => server.close(resolve))
		db.close()
		try {
			fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })
		} catch {
			// Windows can keep a transcoded photo mapped briefly after close.
		}
	}
}

main().catch((err) => {
	console.error('supplies smoke FAIL', err)
	process.exit(1)
})
