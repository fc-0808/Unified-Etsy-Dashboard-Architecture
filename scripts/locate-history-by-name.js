'use strict'

/**
 * Map listing photos → History folders by the cheapest accurate signal:
 * bulk_job_items.product_folder basename (Downloads archive names were
 * preserved when moved into History). Visual hash is a fallback only
 * when the name is missing or ambiguous.
 *
 * Shop-root invariant: an iPhoneCasesDesignArt listing is always under
 * History\iPhoneCasesDesignArt (never another shop or _Unassigned), and
 * the same for every other Etsy shop.
 */

require('dotenv').config({ quiet: true })
const fs = require('fs')
const path = require('path')
const { loadConfig } = require('../src/config/schema')
const { initDb } = require('../src/db/setup')
const catalog = require('../src/listings/history-catalog')
const { hashQueryImage } = require('../src/listings/history-match')
const { phashDistance } = require('../src/route/product-similarity')

const ASSETS = path.join(
	process.env.USERPROFILE || '',
	'.cursor',
	'projects',
	'c-Users-w088s-OneDrive-Documents-E-Commerce-Etsy-Programs-Unified-Etsy-Dashboard-Architecture',
	'assets',
)

const QUERIES = [
	{ id: '4569379722', label: 'Kitty Cat Mug MagSafe', file: 'Kitty_Cat_Mug' },
	{ id: '4569378324', label: 'Toy Story', file: 'Toy_Story' },
	{ id: '4569380738', label: 'Red Apple Ring Stand', file: 'Red_Apple_Ring' },
	{ id: '4566434151', label: 'Teddy Bear Photo Grid', file: 'Teddy_Bear' },
	{ id: '4554406882', label: 'Parfait Sundae', file: 'Parfait_Sundae' },
	{ id: '4562814864', label: 'Hello Kitty Apple AirPods', file: 'Hello_Kitty_Apple' },
	{ id: '4569371831', label: 'Butterfly Mint', file: 'Star_Outline_Butterfly' },
	{ id: '4542404390', label: 'Hello Kitty Pink iPhone collage', file: 'Hello_Kitty_Pink_iPhone' },
	{ id: '4542683658', label: 'Hibiscus Pink AirPods', file: 'Hibiscus' },
	{ id: '4546012644', label: 'Kiiroitori Yellow AirPods', file: 'Kiiroitori' },
	{ id: '4554399685', label: 'Chef Mouse Remy', file: 'Chef_Mouse' },
]

function findQueryFile(token) {
	const names = fs.readdirSync(ASSETS).filter((n) => n.toLowerCase().includes(token.toLowerCase()) && /\.jpe?g$/i.test(n))
	if (!names.length) return null
	names.sort((a, b) => fs.statSync(path.join(ASSETS, b)).mtimeMs - fs.statSync(path.join(ASSETS, a)).mtimeMs)
	return path.join(ASSETS, names[0])
}

function normName(name) {
	return String(name || '')
		.normalize('NFC')
		.replace(/_variants$/i, '')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase()
}

function shopFromListing(shopId) {
	return String(shopId || '').trim()
}

function foldersForShop(folders, shop, historyRoot, db) {
	const resolved = catalog.resolveHistoryShop(shop, { root: historyRoot, db })
	if (!resolved) return folders
	return folders.filter((f) => catalog.sameHistoryShop(f.shop, resolved.shop))
}

function batchHintFromDownloads(folderPath) {
	if (!folderPath) return ''
	const parts = String(folderPath).split(/[/\\]/).filter(Boolean)
	if (parts.length < 2) return ''
	return parts[parts.length - 2]
}

function scoreCandidate(folder, shop, batchHint) {
	let score = 0
	if (shop && catalog.sameHistoryShop(folder.shop, shop)) score += 100
	if (batchHint && folder.batch === batchHint) score += 50
	if (batchHint && folder.batch && folder.batch.includes(batchHint.replace(/_ICDA$/i, ''))) score += 30
	if (batchHint && folder.batch && batchHint.replace(/_ICDA$/i, '_iPhoneCasesDesignArt') === folder.batch) score += 40
	return score
}

function pickByName(folders, bulkName, shop, batchHint) {
	const exact = folders.filter((f) => f.product === bulkName)
	const stripped = folders.filter((f) => normName(f.product) === normName(bulkName))
	const pool = exact.length ? exact : stripped
	if (!pool.length) return { matches: [], winner: null, how: 'none' }
	if (pool.length === 1) return { matches: pool, winner: pool[0], how: exact.length ? 'name-exact' : 'name-stripped' }
	const ranked = pool
		.map((f) => ({ f, score: scoreCandidate(f, shop, batchHint) }))
		.sort((a, b) => b.score - a.score)
	if (ranked[0].score > ranked[1].score) {
		return { matches: pool, winner: ranked[0].f, how: exact.length ? 'name-exact+batch' : 'name-stripped+batch' }
	}
	return { matches: pool, winner: null, how: 'name-ambiguous' }
}

function firstImage(folder) {
	if (!folder || !folder.images || !folder.images.length) return null
	return folder.images[0].path
}

async function hashFile(p) {
	if (!p || !fs.existsSync(p)) return null
	try {
		const buf = fs.readFileSync(p)
		return await hashQueryImage(buf)
	} catch (err) {
		return { error: err.message }
	}
}

function hashDist(a, b) {
	if (!a || !b || a.error || b.error) return 64
	const dFull = phashDistance(a.full, b.full)
	const dDesign = phashDistance(a.design, b.design)
	const dCrop = phashDistance(a.crop, b.crop)
	return Math.min(dFull, dDesign, dCrop)
}

function bestHashAgainst(queryHash, candidates) {
	let best = null
	for (const folder of candidates) {
		for (const img of folder.images || []) {
			if (!img._hash || img._hash.error) continue
			const dist = hashDist(queryHash, img._hash)
			if (!best || dist < best.dist) {
				best = { folder, image: img.path, dist }
			}
		}
	}
	return best
}

async function main() {
	const config = loadConfig()
	const db = initDb(config.db_path)
	const historyRoot = catalog.defaultHistoryRoot()
	console.log('Walking History (name index, no API)…')
	const t0 = Date.now()
	const folders = catalog.walkProductFolders(historyRoot, { imagesPerFolder: 1 })
	console.log(`Walked ${folders.length} product folders in ${Date.now() - t0}ms`)
	console.log('')

	const listingStmt = db.prepare('SELECT listing_id, shop_id, title, state FROM listings WHERE listing_id = ?')
	const bulkStmt = db.prepare(
		`SELECT job_id, product_folder, product_name, listing_id, title, status
		 FROM bulk_job_items WHERE listing_id = ? ORDER BY updated_at DESC`,
	)

	const results = []
	const needHash = []

	for (const q of QUERIES) {
		const listing = listingStmt.get(Number(q.id))
		const bulk = bulkStmt.get(Number(q.id))
		const shop = listing ? shopFromListing(listing.shop_id) : ''
		const bulkPath = bulk && bulk.product_folder ? bulk.product_folder : ''
		const bulkName = bulkPath ? path.basename(bulkPath) : bulk && bulk.product_name ? bulk.product_name : ''
		const batchHint = batchHintFromDownloads(bulkPath)
		const shopFolders = foldersForShop(folders, shop, historyRoot, db)
		const picked = pickByName(shopFolders, bulkName, shop, batchHint)
		const row = {
			label: q.label,
			listing_id: q.id,
			title: listing ? listing.title : '',
			shop,
			bulk_name: bulkName,
			bulk_path: bulkPath,
			batch_hint: batchHint,
			how: picked.how,
			candidates: picked.matches.length,
			winner: picked.winner,
			query_file: findQueryFile(q.file),
		}
		results.push(row)
		if (!picked.winner) needHash.push(row)
	}

	if (needHash.length) {
		console.log(`Name miss/ambiguous: ${needHash.length} — hashing query + candidate heroes (local, $0)…`)
		for (const row of needHash) {
			const shopFolders = foldersForShop(folders, row.shop, historyRoot, db)
			const batchFolders = shopFolders.filter((f) => row.batch_hint && (
				f.batch === row.batch_hint
				|| f.batch.replace(/_iPhoneCasesDesignArt$/i, '_ICDA') === row.batch_hint
				|| f.batch === row.batch_hint.replace(/_ICDA$/i, '_iPhoneCasesDesignArt')
				|| (row.batch_hint.startsWith(f.batch.slice(0, 4)) && f.batch.toLowerCase().includes(row.batch_hint.slice(5, 12).toLowerCase()))
			))
			let pool = row.candidates > 1
				? shopFolders.filter((f) => normName(f.product) === normName(row.bulk_name) || f.product === row.bulk_name)
				: (batchFolders.length ? batchFolders : shopFolders)
			if (pool.length > 80) pool = pool.slice(0, 80)
			const qHash = await hashFile(row.query_file)
			if (!qHash || qHash.error) {
				row.how = 'hash-failed'
				row.hash_error = qHash && qHash.error
				continue
			}
			for (const folder of pool) {
				const hero = firstImage(folder)
				if (!hero) continue
				folder.images[0]._hash = await hashFile(hero)
			}
			const best = bestHashAgainst(qHash, pool)
			if (best && best.dist <= 8) {
				row.winner = best.folder
				row.how = best.dist <= 2 ? 'hash-exact' : 'hash-likely'
				row.hash_dist = best.dist
				row.hash_image = best.image
			} else if (best) {
				row.how = 'hash-weak'
				row.hash_dist = best.dist
				row.winner = best.folder
				row.hash_image = best.image
			} else {
				row.how = 'unresolved'
			}
		}
	}

	console.log('════════════════════════════════════════')
	console.log('RESULTS')
	console.log('════════════════════════════════════════')
	for (const row of results) {
		console.log('')
		console.log(row.label)
		console.log('  listing_id :', row.listing_id)
		console.log('  shop       :', row.shop)
		console.log('  shop root  :', catalog.historyShopRoot(row.shop, { root: historyRoot, db }) || '(unknown shop)')
		console.log('  bulk name  :', row.bulk_name)
		console.log('  method     :', row.how, row.hash_dist != null ? `(hamming ${row.hash_dist})` : '')
		console.log('  candidates :', row.candidates)
		if (row.winner) {
			console.log('  folder name:', row.winner.product)
			console.log('  product_key:', row.winner.product_key)
			console.log('  folder path:', row.winner.folder_path)
			console.log('  exists     :', fs.existsSync(row.winner.folder_path) ? 'YES' : 'NO')
		} else {
			console.log('  folder name: (not found)')
			console.log('  folder path: (not found)')
		}
	}

	const outPath = path.join(__dirname, '..', 'tmp', 'history-locate-11.json')
	fs.mkdirSync(path.dirname(outPath), { recursive: true })
	fs.writeFileSync(
		outPath,
		JSON.stringify(
			results.map((r) => ({
				label: r.label,
				listing_id: r.listing_id,
				title: r.title,
				shop: r.shop,
				method: r.how,
				hash_dist: r.hash_dist || null,
				folder_name: r.winner ? r.winner.product : null,
				product_key: r.winner ? r.winner.product_key : null,
				folder_path: r.winner ? r.winner.folder_path : null,
				bulk_name: r.bulk_name,
			})),
			null,
			2,
		),
		'utf8',
	)
	console.log('\nWrote', outPath)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
