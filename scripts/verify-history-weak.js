'use strict'

require('dotenv').config({ quiet: true })
const fs = require('fs')
const path = require('path')
const { hashQueryImage } = require('../src/listings/history-match')
const { phashDistance } = require('../src/route/product-similarity')

const ASSETS = path.join(
	process.env.USERPROFILE || '',
	'.cursor',
	'projects',
	'c-Users-w088s-OneDrive-Documents-E-Commerce-Etsy-Programs-Unified-Etsy-Dashboard-Architecture',
	'assets',
)
const rows = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tmp', 'history-locate-11.json'), 'utf8'))
const WEAK = new Set(['Kitty Cat Mug MagSafe', 'Toy Story', 'Kiiroitori Yellow AirPods'])
const FILE_TOKENS = {
	'Kitty Cat Mug MagSafe': 'Kitty_Cat_Mug',
	'Toy Story': 'Toy_Story',
	'Kiiroitori Yellow AirPods': 'Kiiroitori',
}

function findQueryFile(token) {
	const names = fs.readdirSync(ASSETS).filter((n) => n.toLowerCase().includes(token.toLowerCase()) && /\.jpe?g$/i.test(n))
	names.sort((a, b) => fs.statSync(path.join(ASSETS, b)).mtimeMs - fs.statSync(path.join(ASSETS, a)).mtimeMs)
	return path.join(ASSETS, names[0])
}

function minDist(a, b) {
	return Math.min(phashDistance(a.full, b.full), phashDistance(a.design, b.design), phashDistance(a.crop, b.crop))
}

async function main() {
	for (const row of rows) {
		if (!WEAK.has(row.label)) continue
		const qHash = await hashQueryImage(fs.readFileSync(findQueryFile(FILE_TOKENS[row.label])))
		const files = fs.readdirSync(row.folder_path).filter((n) => /\.(jpe?g|png|webp)$/i.test(n))
		const ranked = []
		for (const name of files) {
			const h = await hashQueryImage(fs.readFileSync(path.join(row.folder_path, name)))
			ranked.push({ name, dist: minDist(qHash, h) })
		}
		ranked.sort((a, b) => a.dist - b.dist)
		console.log('\n' + row.label)
		console.log(row.folder_path)
		console.log('all', files.length, 'best 8:')
		for (const r of ranked.slice(0, 8)) console.log(' ', String(r.dist).padStart(3), r.name)
	}
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
