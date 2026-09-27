'use strict'

/**
 * Match product photos to Listing History folders.
 *
 *   node scripts/history-match.js photo.jpg [photo2.png ...]
 *   node scripts/history-match.js --shop iPhoneCasesDesignArt photo.jpg
 *   node scripts/history-match.js --no-rerank photo.jpg
 *
 * When --shop or a listing id in the filename is present, search is
 * limited to History/<shop>/ (e.g. iPhoneCasesDesignArt listings only
 * resolve under …\History\iPhoneCasesDesignArt).
 *
 * Prints the top folder per photo. Requires a populated index
 * (`npm run history:index`).
 */

require('dotenv').config({ quiet: true })
const fs = require('fs')
const path = require('path')
const { loadConfig } = require('../src/config/schema')
const { initDb } = require('../src/db/setup')
const match = require('../src/listings/history-match')

function loadDb() {
	const config = loadConfig()
	return initDb(config.db_path)
}

async function main() {
	const rerank = !process.argv.includes('--no-rerank')
	let shop = ''
	const files = []
	for (let i = 2; i < process.argv.length; i++) {
		const arg = process.argv[i]
		if (arg === '--no-rerank') continue
		if (arg === '--shop') {
			shop = String(process.argv[++i] || '').trim()
			continue
		}
		if (arg.startsWith('--shop=')) {
			shop = arg.slice('--shop='.length).trim()
			continue
		}
		if (arg.startsWith('--')) continue
		files.push(arg)
	}
	if (!files.length) {
		console.error('Usage: node scripts/history-match.js [--shop ShopName] [--no-rerank] <image> [image...]')
		process.exit(1)
	}
	const db = loadDb()
	const items = []
	for (const file of files) {
		const abs = path.resolve(file)
		if (!fs.existsSync(abs)) {
			console.error('Missing file:', abs)
			process.exitCode = 1
			continue
		}
		items.push({ name: path.basename(abs), buf: fs.readFileSync(abs), shop })
	}
	if (!items.length) process.exit(1)
	const { results } = await match.matchPhotos(db, items, { rerank, log: true, shop })
	for (const row of results) {
		console.log('\n' + (row.name || '(photo)'))
		if (!row.ok) {
			console.log('  ERROR', row.error)
			continue
		}
		if (!row.matches || !row.matches.length) {
			console.log('  no match', row.reason || '', row.shop_root ? `shop_root=${row.shop_root}` : '')
			continue
		}
		if (row.shop_root) console.log(`  shop=${row.shop}  shop_root=${row.shop_root}`)
		console.log(`  source=${row.source}  query_sha=${String(row.query_sha || '').slice(0, 12)}…`)
		for (const hit of row.matches.slice(0, 5)) {
			const score = hit.score != null ? ` score=${Number(hit.score).toFixed(3)}` : hit.distance != null ? ` d=${hit.distance}` : ''
			console.log(`  ${hit.confidence.padEnd(8)} ${hit.match_kind.padEnd(6)}  ${hit.product_key}${score}`)
			console.log(`           ${hit.folder_path}`)
		}
	}
	console.log('')
}

main().catch((err) => {
	console.error(err.message || err)
	process.exit(1)
})
