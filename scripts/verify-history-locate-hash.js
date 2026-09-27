'use strict'

require('dotenv').config({ quiet: true })
const fs = require('fs')
const path = require('path')
const { hashQueryImage } = require('../src/listings/history-match')
const { phashDistance } = require('../src/route/product-similarity')
const catalog = require('../src/listings/history-catalog')

const ASSETS = path.join(
	process.env.USERPROFILE || '',
	'.cursor',
	'projects',
	'c-Users-w088s-OneDrive-Documents-E-Commerce-Etsy-Programs-Unified-Etsy-Dashboard-Architecture',
	'assets',
)

const rows = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tmp', 'history-locate-11.json'), 'utf8'))

function findQueryFile(token) {
	const names = fs.readdirSync(ASSETS).filter((n) => n.toLowerCase().includes(token.toLowerCase()) && /\.jpe?g$/i.test(n))
	if (!names.length) return null
	names.sort((a, b) => fs.statSync(path.join(ASSETS, b)).mtimeMs - fs.statSync(path.join(ASSETS, a)).mtimeMs)
	return path.join(ASSETS, names[0])
}

const FILE_TOKENS = {
	'Kitty Cat Mug MagSafe': 'Kitty_Cat_Mug',
	'Toy Story': 'Toy_Story',
	'Red Apple Ring Stand': 'Red_Apple_Ring',
	'Teddy Bear Photo Grid': 'Teddy_Bear',
	'Parfait Sundae': 'Parfait_Sundae',
	'Hello Kitty Apple AirPods': 'Hello_Kitty_Apple',
	'Butterfly Mint': 'Star_Outline_Butterfly',
	'Hello Kitty Pink iPhone collage': 'Hello_Kitty_Pink_iPhone',
	'Hibiscus Pink AirPods': 'Hibiscus',
	'Kiiroitori Yellow AirPods': 'Kiiroitori',
	'Chef Mouse Remy': 'Chef_Mouse',
}

function minDist(a, b) {
	return Math.min(phashDistance(a.full, b.full), phashDistance(a.design, b.design), phashDistance(a.crop, b.crop))
}

async function main() {
	const previewDir = path.join(__dirname, '..', 'tmp', 'history-locate-preview')
	fs.mkdirSync(previewDir, { recursive: true })
	for (const row of rows) {
		const qPath = findQueryFile(FILE_TOKENS[row.label])
		const qHash = await hashQueryImage(fs.readFileSync(qPath))
		const scanned = catalog.walkProductFolders ? null : null
		const files = fs.readdirSync(row.folder_path).filter((n) => /\.(jpe?g|png|webp)$/i.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
		let best = { dist: 999, file: null }
		const top = files.slice(0, 5)
		for (const name of top) {
			const p = path.join(row.folder_path, name)
			const h = await hashQueryImage(fs.readFileSync(p))
			const d = minDist(qHash, h)
			if (d < best.dist) best = { dist: d, file: name }
		}
		const hero = files[0]
		if (hero) {
			const dest = path.join(previewDir, row.listing_id + path.extname(hero))
			fs.copyFileSync(path.join(row.folder_path, hero), dest)
		}
		console.log(row.label)
		console.log('  folder files:', files.length, files.slice(0, 6).join(' | '))
		console.log('  best hamming :', best.dist, best.file)
		console.log('  verdict      :', best.dist <= 2 ? 'EXACT' : best.dist <= 10 ? 'LIKELY' : best.dist <= 18 ? 'RELATED' : 'WEAK-visual (name still sourced from this listing job)')
	}
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
