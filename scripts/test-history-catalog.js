'use strict'

/**
 * Listing History visual catalog: walk, incremental update, dHash + embed match.
 *
 * Run: node scripts/test-history-catalog.js
 */

const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const sharp = require('sharp')
const { initDb } = require('../src/db/setup')
const catalog = require('../src/listings/history-catalog')
const index = require('../src/listings/history-index')
const match = require('../src/listings/history-match')
const locate = require('../src/listings/history-locate')
const cost = require('../src/listings/history-cost')
const policy = require('../src/auth/policy')

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const RESET = '\x1b[0m'
let passed = 0
let failed = 0
const jobs = []

function test(name, fn) {
	jobs.push({ name, fn })
}

async function colorJpeg(r, g, b, size = 48) {
	return sharp({
		create: { width: size, height: Math.round(size * 1.3), channels: 3, background: { r, g, b } },
	})
		.jpeg()
		.toBuffer()
}

async function gridEmbed(buf) {
	const { data, info } = await sharp(buf).resize(4, 4, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
	const vec = new Float32Array(info.width * info.height * 3)
	for (let i = 0; i < vec.length; i++) vec[i] = data[i] / 255
	return vec
}

function tmpRoot() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'history-cat-'))
}

function writeTree(root, spec) {
	for (const [rel, files] of Object.entries(spec)) {
		const dir = path.join(root, ...rel.split('/'))
		fs.mkdirSync(dir, { recursive: true })
		for (const [name, buf] of Object.entries(files)) {
			fs.writeFileSync(path.join(dir, name), buf)
		}
	}
}

function openDb() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-db-'))
	return initDb(path.join(dir, 't.db'))
}

console.log('\nHistory catalog\n')

test('isInsideRoot blocks .. traversal and other drives', () => {
	const root = 'C:\\Users\\w088s\\OneDrive\\Documents\\E-Commerce\\Etsy\\Listings\\History'
	assert.equal(catalog.isInsideRoot(root, path.join(root, 'Y2KASEofficial', '1')), true)
	assert.equal(catalog.isInsideRoot(root, path.join(root, '..', 'Secrets')), false)
	assert.equal(catalog.isInsideRoot(root, 'C:\\Windows\\System32'), false)
	assert.equal(catalog.safeResolveUnder(root, path.join(root, '..', 'x')), null)
})

test('product keys are POSIX and parse shop/batch/product', () => {
	const key = catalog.productKeyFromParts(['Y2KASEofficial', '0616_Y2KASEofficial', '1'])
	assert.equal(key, 'Y2KASEofficial/0616_Y2KASEofficial/1')
	const parsed = catalog.parseProductKey(key)
	assert.equal(parsed.shop, 'Y2KASEofficial')
	assert.equal(parsed.batch, '0616_Y2KASEofficial')
	assert.equal(parsed.product, '1')
	assert.equal(catalog.productHintFromKey('Y2KASEofficial/0722_airpods_Y2KASEofficial/3'), 'airpods_case')
	assert.equal(catalog.productHintFromKey('CuteCasesOnly/0709/1'), 'iphone_case')
})

test('Etsy shop maps onto History/<shop> case-insensitively and never to _Unassigned', () => {
	const root = tmpRoot()
	fs.mkdirSync(path.join(root, 'iPhoneCasesDesignArt'), { recursive: true })
	fs.mkdirSync(path.join(root, 'iPhoneCasesByTwily'), { recursive: true })
	fs.mkdirSync(path.join(root, '_Unassigned'), { recursive: true })
	const da = catalog.resolveHistoryShop('IPhoneCasesDesignArt', { root })
	assert.equal(da.shop, 'iPhoneCasesDesignArt')
	assert.equal(da.folder_path, path.join(root, 'iPhoneCasesDesignArt'))
	assert.equal(da.exists, true)
	assert.equal(catalog.sameHistoryShop('IPhoneCasesDesignArt', 'iPhoneCasesDesignArt'), true)
	assert.equal(catalog.sameHistoryShop('iPhoneCasesDesignArt', '_Unassigned'), false)
	assert.equal(catalog.folderBelongsToShop('_Unassigned', 'IPhoneCasesDesignArt'), false)
	assert.equal(catalog.listingIdFromQueryName('c__local_images_4569379722_Kitty_Cat_Mug-uuid.jpg'), '4569379722')
	assert.equal(catalog.listingIdFromQueryName('4569378324.jpg'), '4569378324')
})

test('walk finds 3-level product folders and skips _archive', async () => {
	const root = tmpRoot()
	const red = await colorJpeg(220, 40, 40)
	const blue = await colorJpeg(40, 40, 220)
	writeTree(root, {
		'Y2KASEofficial/0616_Y2KASEofficial/1': { '1.jpg': red, '2.jpg': red },
		'Y2KASEofficial/0616_Y2KASEofficial/2': { '1.jpg': blue },
		'Y2KASEofficial/0616_Y2KASEofficial/1/_archive': { 'old.jpg': red },
		'Y2KASEofficial/0722_airpods_Y2KASEofficial/4': { '1.png': red },
	})
	const folders = catalog.walkProductFolders(root)
	assert.equal(folders.length, 3)
	assert.ok(folders.every((row) => !row.product_key.includes('_archive')))
	const keys = folders.map((row) => row.product_key).sort()
	assert.deepEqual(keys, [
		'Y2KASEofficial/0616_Y2KASEofficial/1',
		'Y2KASEofficial/0616_Y2KASEofficial/2',
		'Y2KASEofficial/0722_airpods_Y2KASEofficial/4',
	])
	const one = folders.find((row) => row.product.endsWith('1') && row.batch.startsWith('0616'))
	assert.ok(one.images.length >= 1)
	assert.equal(one.images[0].filename, '1.jpg')
})

test('initDb creates history tables', () => {
	const db = openDb()
	const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'history_%'").all().map((r) => r.name)
	assert.ok(tables.includes('history_folder'))
	assert.ok(tables.includes('history_image'))
	assert.ok(tables.includes('history_index_meta'))
	assert.ok(tables.includes('history_match_log'))
})

test('incremental update hashes, embeds, then skips unchanged files', async () => {
	const root = tmpRoot()
	const red = await colorJpeg(220, 30, 30)
	writeTree(root, { 'ShopA/0701_ShopA/1': { '1.jpg': red } })
	const db = openDb()
	const first = await index.updateIndex(db, {
		root,
		embed: async (buf) => gridEmbed(buf),
		wait: true,
	})
	assert.equal(first.accepted, true)
	assert.equal(first.snapshot.folders, 1)
	assert.ok(first.snapshot.hashed >= 1)
	assert.ok(first.snapshot.embedded >= 1)
	const second = await index.updateIndex(db, {
		root,
		embed: async (buf) => {
			throw new Error('should not re-embed')
		},
		wait: true,
	})
	assert.equal(second.snapshot.embedded, 0)
	assert.ok(second.snapshot.skipped >= 1)
	const stats = index.folderStats(db)
	assert.equal(stats.folders, 1)
	assert.equal(stats.embedded, 1)
})

test('a vanished folder is marked missing, not deleted', async () => {
	const root = tmpRoot()
	const red = await colorJpeg(200, 20, 20)
	const blue = await colorJpeg(20, 20, 200)
	writeTree(root, {
		'ShopA/0701_ShopA/1': { '1.jpg': red },
		'ShopA/0701_ShopA/2': { '1.jpg': blue },
	})
	const db = openDb()
	await index.updateIndex(db, { root, embed: false, wait: true })
	fs.rmSync(path.join(root, 'ShopA', '0701_ShopA', '2'), { recursive: true, force: true })
	await index.updateIndex(db, { root, embed: false, wait: true })
	const missing = db.prepare("SELECT product_key, status FROM history_folder WHERE status = 'missing'").all()
	assert.equal(missing.length, 1)
	assert.match(missing[0].product_key, /\/2$/)
	assert.equal(index.folderStats(db).folders, 1)
})

test('dHash exact match returns the same product folder', async () => {
	const root = tmpRoot()
	const red = await colorJpeg(210, 40, 40, 64)
	const blue = await colorJpeg(40, 40, 210, 64)
	writeTree(root, {
		'ShopA/0701_ShopA/10': { '1.jpg': red },
		'ShopA/0701_ShopA/11': { '1.jpg': blue },
	})
	const db = openDb()
	await index.updateIndex(db, { root, embed: false, wait: true })
	const result = await match.matchPhoto(db, red, { embed: false, rerank: false, root })
	assert.ok(result.matches.length)
	assert.equal(result.source, 'phash')
	assert.equal(result.matches[0].confidence, 'exact')
	assert.match(result.matches[0].product_key, /\/10$/)
})

test('known shop never returns another shop or _Unassigned even on identical photos', async () => {
	const root = tmpRoot()
	const red = await colorJpeg(210, 40, 40, 64)
	writeTree(root, {
		'iPhoneCasesDesignArt/0904_iPhoneCasesDesignArt/mug': { '1.jpg': red },
		'_Unassigned/0828_Y2KASE/mug': { '1.jpg': red },
	})
	const db = openDb()
	await index.updateIndex(db, { root, embed: false, wait: true })
	const result = await match.matchPhoto(db, red, {
		embed: false,
		rerank: false,
		root,
		shop: 'IPhoneCasesDesignArt',
	})
	assert.ok(result.matches.length)
	assert.equal(result.shop, 'iPhoneCasesDesignArt')
	assert.equal(result.shop_root, path.join(root, 'iPhoneCasesDesignArt'))
	assert.ok(result.matches.every((row) => row.shop === 'iPhoneCasesDesignArt'))
	assert.ok(!result.matches.some((row) => row.shop === '_Unassigned'))
	assert.match(result.matches[0].folder_path, /iPhoneCasesDesignArt/)
})

test('embedding recovers a match when the query is a recolor-in-name-only different crop of the same colour', async () => {
	const root = tmpRoot()
	const yellow = await colorJpeg(240, 200, 40, 80)
	const yellowCrop = await colorJpeg(240, 200, 40, 40)
	const purple = await colorJpeg(120, 40, 180, 80)
	writeTree(root, {
		'ShopA/0701_ShopA/duck': { '1.jpg': yellow },
		'ShopA/0701_ShopA/grape': { '1.jpg': purple },
	})
	const db = openDb()
	await index.updateIndex(db, {
		root,
		embed: async (buf) => gridEmbed(buf),
		hash: async () => ({ phash: '0'.repeat(64), design_phash: 'f'.repeat(64) }),
		wait: true,
	})
	const result = await match.matchPhoto(db, yellowCrop, {
		embed: async (buf) => gridEmbed(buf),
		hashQuery: async () => ({ full: '1'.repeat(64), design: '2'.repeat(64), crop: '3'.repeat(64) }),
		rerank: false,
		root,
	})
	assert.ok(result.matches.length)
	assert.equal(result.matches[0].product, 'duck')
	assert.equal(result.source, 'embed')
})

test('vision rerank can promote a second-place folder when injected', async () => {
	const root = tmpRoot()
	const a = await colorJpeg(10, 10, 10)
	const b = await colorJpeg(11, 11, 11)
	writeTree(root, {
		'ShopA/0701_ShopA/a': { '1.jpg': a },
		'ShopA/0701_ShopA/b': { '1.jpg': b },
	})
	const db = openDb()
	await index.updateIndex(db, { root, embed: false, wait: true })
	const result = await match.matchPhoto(db, a, {
		embed: false,
		forceRerank: true,
		rerank: async (pool) => pool.map((row, i) => ({ index: i + 1, same_print: row.product === 'b', confidence: row.product === 'b' ? 95 : 10, reason: 'test' })),
		root,
	})
	assert.equal(result.matches[0].product, 'b')
	assert.equal(result.matches[0].match_kind, 'vision')
})

test('cost model prices index + query far below naive chat-vision', () => {
	const est = cost.publicEstimate({ folders: 2220, pendingEmbed: 6660, indexedImages: 6660, imagesPerFolder: 3 })
	assert.ok(est.index.pending_embed_usd < 2)
	assert.ok(est.query_embed_only.typical_usd < 0.01)
	assert.ok(est.query_with_rerank.typical_usd < 0.02)
	assert.ok(est.query_with_rerank.naive_chat_vision_all_images_usd > 10)
})

test('listing map matches bulk folder name inside the Etsy shop History dir only', async () => {
	const root = tmpRoot()
	const red = await colorJpeg(200, 30, 30)
	writeTree(root, {
		'iPhoneCasesDesignArt/0904_iPhoneCasesDesignArt/mug_variants': { '1.jpg': red },
		'_Unassigned/0828_Y2KASE/mug_variants': { '1.jpg': red },
	})
	const db = openDb()
	db.prepare('INSERT INTO listings (listing_id, shop_id, title, state) VALUES (?,?,?,?)').run(
		4554399685,
		'IPhoneCasesDesignArt',
		'Chef Mouse',
		'active',
	)
	db.prepare(
		`INSERT INTO bulk_job_items (job_id, product_folder, product_name, listing_id, status, updated_at)
		 VALUES (?,?,?,?,?,strftime('%s','now'))`,
	).run(
		'job-1',
		path.join('C:', 'Users', 'w088s', 'Downloads', '0904_iPhoneCasesDesignArt', 'mug_variants'),
		'mug_variants',
		4554399685,
		'done',
	)
	locate.invalidateWalkCache()
	const first = locate.updateListingMap(db, [{ listing_id: 4554399685, shop: 'IPhoneCasesDesignArt' }], { root })
	assert.equal(first.resolved, 1)
	assert.equal(first.maps[0].status, 'resolved')
	assert.equal(first.maps[0].folder_name, 'mug_variants')
	assert.equal(first.maps[0].history_shop, 'iPhoneCasesDesignArt')
	assert.match(first.maps[0].product_key, /^iPhoneCasesDesignArt\//)
	assert.ok(!first.maps[0].product_key.includes('_Unassigned'))
	assert.ok(first.maps[0].folder_path.includes('iPhoneCasesDesignArt'))

	const second = locate.updateListingMap(db, [{ listing_id: 4554399685, shop: 'IPhoneCasesDesignArt' }], {
		root,
		folders: [],
	})
	assert.equal(second.skipped, 1)
	assert.equal(second.updated, 0)
	assert.equal(second.resolved, 1)
	assert.equal(second.maps[0].status, 'resolved')

	const rows = [
		{ sourcing_reason: 'not_in_catalog', listing_id: 4554399685, product_listing_id: 4554399685 },
		{ sourcing_reason: 'wrong_stall', listing_id: 4554399685, product_listing_id: 4554399685 },
		{ sourcing_reason: '', listing_id: 4554399685 },
	]
	locate.attachHistoryFolders(db, rows)
	assert.equal(rows[0].history_folder.status, 'resolved')
	assert.equal(rows[0].history_folder.folder_name, 'mug_variants')
	assert.equal(rows[0].history_folder.folder_path, '')
	assert.equal(rows[1].history_folder, null)
	assert.equal(rows[2].history_folder, null)

	const opened = locate.resolveOpenPath(db, {
		listing_id: 4554399685,
		shop: 'IPhoneCasesDesignArt',
		root,
	})
	assert.ok(opened.folder_path.endsWith('mug_variants') || opened.folder_path.includes('mug_variants'))
	assert.equal(opened.folder_name, 'mug_variants')

	fs.rmSync(path.join(root, 'iPhoneCasesDesignArt', '0904_iPhoneCasesDesignArt', 'mug_variants'), { recursive: true, force: true })
	locate.invalidateWalkCache()
	const afterDelete = locate.updateListingMap(db, [{ listing_id: 4554399685, shop: 'IPhoneCasesDesignArt' }], { root })
	assert.equal(afterDelete.maps[0].status, 'missing')
	assert.throws(
		() => locate.resolveOpenPath(db, { listing_id: 4554399685, shop: 'IPhoneCasesDesignArt', root }),
		(err) => err.status === 404,
	)
})

test('known shop does not resolve a same-named folder in _Unassigned', async () => {
	const root = tmpRoot()
	const red = await colorJpeg(200, 30, 30)
	writeTree(root, {
		'_Unassigned/0828_Y2KASE/mug_variants': { '1.jpg': red },
		'OtherShop/0904_OtherShop/mug_variants': { '1.jpg': red },
	})
	const db = openDb()
	db.prepare('INSERT INTO listings (listing_id, shop_id, title, state) VALUES (?,?,?,?)').run(
		4554399685,
		'IPhoneCasesDesignArt',
		'Chef Mouse',
		'active',
	)
	db.prepare(
		`INSERT INTO bulk_job_items (job_id, product_folder, product_name, listing_id, status, updated_at)
		 VALUES (?,?,?,?,?,strftime('%s','now'))`,
	).run('job-1', path.join('C:', 'Downloads', 'mug_variants'), 'mug_variants', 4554399685, 'done')
	locate.invalidateWalkCache()
	const result = locate.updateListingMap(db, [{ listing_id: 4554399685, shop: 'IPhoneCasesDesignArt' }], { root })
	assert.equal(result.maps[0].status, 'missing')
	assert.equal(result.maps[0].source, 'unassigned-blocked')
	assert.equal(result.maps[0].folder_name, '')

	const picked = locate.pickFolder(
		[
			{ shop: '_Unassigned', product: 'mug_variants', product_key: '_Unassigned/0828/mug_variants', batch: '0828_Y2KASE' },
			{ shop: 'OtherShop', product: 'mug_variants', product_key: 'OtherShop/0904/mug_variants', batch: '0904_OtherShop' },
		],
		'mug_variants',
		'iPhoneCasesDesignArt',
		'0904_iPhoneCasesDesignArt',
	)
	assert.equal(picked.winner, null)
	assert.equal(picked.how, 'unassigned-blocked')
})

test('dashboard attach locates future unmatched listings without a client click', async () => {
	const root = tmpRoot()
	const red = await colorJpeg(200, 30, 30)
	writeTree(root, {
		'iPhoneCasesDesignArt/0904_iPhoneCasesDesignArt/mug_variants': { '1.jpg': red },
		'_Unassigned/0828_Y2KASE/mug_variants': { '1.jpg': red },
	})
	const db = openDb()
	db.prepare('INSERT INTO listings (listing_id, shop_id, title, state) VALUES (?,?,?,?)').run(
		4554399686,
		'IPhoneCasesDesignArt',
		'Future Mug',
		'active',
	)
	db.prepare(
		`INSERT INTO bulk_job_items (job_id, product_folder, product_name, listing_id, status, updated_at)
		 VALUES (?,?,?,?,?,strftime('%s','now'))`,
	).run(
		'job-future',
		path.join('C:', 'Downloads', '0904_iPhoneCasesDesignArt', 'mug_variants'),
		'mug_variants',
		4554399686,
		'done',
	)
	locate.invalidateWalkCache()
	const rows = [
		{
			sourcing_reason: 'not_in_catalog',
			listing_id: 4554399686,
			product_listing_id: 4554399686,
			shop_id: 'IPhoneCasesDesignArt',
			dismissed: 0,
			excluded: 0,
		},
	]
	locate.attachHistoryFolders(db, rows, { locate: true, root })
	assert.equal(rows[0].history_folder.status, 'resolved')
	assert.equal(rows[0].history_folder.folder_name, 'mug_variants')
	assert.equal(rows[0].history_folder.folder_path, '')
	assert.match(rows[0].history_folder.product_key, /^iPhoneCasesDesignArt\//)
	assert.ok(!rows[0].history_folder.product_key.includes('_Unassigned'))

	const again = [
		{
			sourcing_reason: 'not_in_catalog',
			listing_id: 4554399686,
			product_listing_id: 4554399686,
			shop_id: 'IPhoneCasesDesignArt',
		},
	]
	locate.attachHistoryFolders(db, again, { locate: true, root, folders: [] })
	assert.equal(again[0].history_folder.status, 'resolved')
	assert.equal(again[0].history_folder.folder_name, 'mug_variants')

	const dismissed = [
		{
			sourcing_reason: 'not_in_catalog',
			listing_id: 4554399999,
			product_listing_id: 4554399999,
			shop_id: 'IPhoneCasesDesignArt',
			dismissed: 1,
		},
	]
	locate.attachHistoryFolders(db, dismissed, { locate: true, root, folders: [] })
	assert.equal(dismissed[0].history_folder.status, 'unmapped')
})

test('decodePhotoData rejects active documents', () => {
	assert.throws(() => match.decodePhotoData('data:image/svg+xml;base64,AAAA'), (err) => err.status === 400)
})

test('History APIs stay owner-only (no delegated ACL rule)', () => {
	for (const p of ['/api/listings/history/status', '/api/listings/history/update', '/api/listings/history/match', '/api/listings/history/open', '/api/listings/history/locate']) {
		assert.equal(policy.requiredCapability('GET', p), null)
		assert.equal(policy.requiredCapability('POST', p), null)
	}
	assert.equal(policy.authorizeApi('packer', 'POST', '/api/listings/history/match').allowed, false)
	assert.equal(policy.authorizeApi('owner', 'POST', '/api/listings/history/match').allowed, true)
})

test('UI: Bulk Listings tab ships a History finder card', () => {
	const html = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8')
	assert.match(html, /id="histFinderCard"/)
	assert.match(html, /id="histFinderDrop"/)
	assert.match(html, /histUpdateIndex/)
	assert.match(html, /histMatchFiles/)
	assert.match(html, /Find in History/)
	assert.match(html, /在 History 中查找/)
	assert.match(html, /History\\iPhoneCasesDesignArt/)
	assert.match(html, /其他店铺同理/)
})

test('UI: Route tab locates unmatched product folders', () => {
	const html = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8')
	assert.match(html, /id="routeFolderMenuBtn"/)
	assert.match(html, /id="routeLocateFoldersBtn"[^>]*data-cap="listings:manage"/)
	assert.match(html, /id="routePhotoLocateBtn"[^>]*data-cap="listings:manage"/)
	assert.match(html, /id="routeDownloadImagesBtn"/)
	assert.match(html, /openRouteProductFolder/)
	assert.match(html, /copyRouteHistoryFolderName/)
	assert.match(html, /Click to copy folder name/)
	assert.match(html, /hydrateRouteHistoryFolders/)
	const server = fs.readFileSync(path.resolve(__dirname, '../src/server/index.js'), 'utf8')
	assert.match(server, /attachHistoryFolders\(db, rows, \{ locate: true \}/)
	assert.match(html, /id="routePhotoLocateBtn"[^>]*data-cap="listings:manage"/)
	assert.match(html, /routeLocatePhotosFromInput/)
	assert.match(html, /Find product folder/)
	assert.match(html, /查找产品文件夹/)
	assert.match(html, /Upload a product photo/)
	assert.match(html, /上传产品照片/)
	assert.match(html, /Look up this queue/)
	assert.match(html, /查找当前队列/)
})

;(async () => {
	for (const job of jobs) {
		try {
			await job.fn()
			passed++
			console.log(`  ${GREEN}ok${RESET}  — ${job.name}`)
		} catch (err) {
			failed++
			console.error(`  ${RED}FAIL${RESET} — ${job.name}`)
			console.error(`         ${err && err.stack ? err.stack : err}`)
		}
	}
	console.log(`\n${passed} passed, ${failed} failed`)
	if (failed) process.exit(1)
})()
