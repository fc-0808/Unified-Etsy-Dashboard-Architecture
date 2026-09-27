'use strict'

/**
 * Locate History folders for a batch of query photos.
 *
 * Cheapest accurate order:
 *   1. listing_id encoded in the filename (zero API)
 *   2. bulk_job_items.product_folder for that listing
 *   3. History dHash index (local, free)
 *   4. listing_phash → title (corroboration)
 */

require('dotenv').config({ quiet: true })
const fs = require('fs')
const path = require('path')
const { loadConfig } = require('../src/config/schema')
const { initDb } = require('../src/db/setup')
const catalog = require('../src/listings/history-catalog')
const { PRODUCT_HASH_ALGO } = require('../src/route/product-image-hash')
const { phashDistance } = require('../src/route/product-similarity')
const find = require('../src/route/find-by-photo')

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

function historyUnder(folderPath) {
	const root = catalog.defaultHistoryRoot()
	if (!folderPath) return null
	const resolved = path.resolve(folderPath)
	if (catalog.isInsideRoot(root, resolved)) return resolved
	return null
}

function main() {
	const config = loadConfig()
	const db = initDb(config.db_path)
	catalog.ensureSchema(db)
	const historyRoot = catalog.defaultHistoryRoot()
	console.log('DB           :', config.db_path)
	console.log('History root :', historyRoot)
	console.log('')

	const listingStmt = db.prepare('SELECT listing_id, shop_id, title, state FROM listings WHERE listing_id = ?')
	const bulkStmt = db.prepare(
		`SELECT job_id, product_folder, product_name, listing_id, title, status
		 FROM bulk_job_items WHERE listing_id = ? ORDER BY updated_at DESC`,
	)
	const hashStmt = db.prepare('SELECT listing_id, phash, design_phash, canonical_key FROM listing_phash WHERE listing_id = ?')
	let historyFolders = []
	try {
		historyFolders = db.prepare("SELECT id, product_key, folder_path, shop, batch, product, status FROM history_folder").all()
	} catch {
		historyFolders = []
	}

	const byKey = new Map(historyFolders.map((r) => [r.product_key, r]))
	const byPath = new Map(historyFolders.map((r) => [String(r.folder_path || '').toLowerCase(), r]))

	for (const q of QUERIES) {
		const file = findQueryFile(q.file)
		const listing = listingStmt.get(Number(q.id))
		const bulkRows = bulkStmt.all(Number(q.id))
		const hash = hashStmt.get(Number(q.id))
		console.log('────────────────────────────────────────')
		console.log(q.label)
		console.log('  listing_id :', q.id)
		console.log('  query file :', file ? path.basename(file) : '(missing on disk)')
		if (listing) {
			console.log('  Etsy title :', listing.title)
			console.log('  shop/state :', listing.shop_id, listing.state)
		} else {
			console.log('  Etsy title : (not in listings table)')
		}
		if (hash) console.log('  listing hash present')
		if (!bulkRows.length) {
			console.log('  bulk folder: (no bulk_job_items row)')
		}
		for (const row of bulkRows) {
			const hist = historyUnder(row.product_folder)
			const indexed = byPath.get(String(row.product_folder || '').toLowerCase())
			console.log('  bulk folder:', row.product_folder)
			console.log('    name     :', row.product_name)
			console.log('    job/status:', row.job_id, row.status)
			console.log('    in History root:', hist ? 'YES' : 'NO')
			if (indexed) console.log('    indexed key :', indexed.product_key, indexed.status)
		}
	}

	console.log('\nHistory index folders:', historyFolders.length)
	console.log('listing_phash count :', db.prepare('SELECT COUNT(*) AS n FROM listing_phash').get().n)
	console.log('listings count      :', db.prepare('SELECT COUNT(*) AS n FROM listings').get().n)
	console.log('bulk items w/ listing:', db.prepare('SELECT COUNT(*) AS n FROM bulk_job_items WHERE listing_id IS NOT NULL').get().n)
}

main()
