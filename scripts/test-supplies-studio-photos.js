'use strict'

/**
 * Studio pack for supplies photos: one AI plate, original product pixels,
 * phone snapshots archived under original/.
 */
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const sharp = require('sharp')
const Database = require('better-sqlite3')
const catalogSeed = require('../src/supplies/catalog-seed')
const core = require('../src/supplies/core')

const SEED = path.join(__dirname, '../assets/supplies-seed')
const ORIGINAL = path.join(SEED, 'original')
const PLATE = path.join(SEED, 'studio-plate.png')

async function cornerMean(file) {
	const { data, info } = await sharp(file)
		.extract({ left: 12, top: 12, width: 48, height: 48 })
		.removeAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true })
	let r = 0
	let g = 0
	let b = 0
	const n = info.width * info.height
	for (let i = 0; i < data.length; i += 3) {
		r += data[i]
		g += data[i + 1]
		b += data[i + 2]
	}
	return [r / n, g / n, b / n]
}

function dist(a, b) {
	return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

async function main() {
	assert.equal(catalogSeed.length, 32)
	assert.equal(core.isCatalogSeedPhoto('BOX-PINK-MAILER-S', 'BOX-PINK-MAILER-S.webp'), true)
	assert.equal(core.isCatalogSeedPhoto('BOX-PINK-MAILER-S', 'BOX-PINK-MAILER-S-1710000000000.webp'), false)
	assert.ok(fs.existsSync(PLATE), 'AI studio plate is part of the seed pack')
	assert.ok(fs.statSync(PLATE).size > 1000, 'studio plate is a real image')

	for (const row of catalogSeed) {
		const studio = path.join(SEED, `${row.sku}.jpg`)
		const orig = path.join(ORIGINAL, `${row.sku}.jpg`)
		assert.ok(fs.existsSync(studio), `missing studio photo ${row.sku}`)
		assert.ok(fs.existsSync(orig), `missing original photo ${row.sku}`)
		assert.notEqual(
			Buffer.compare(fs.readFileSync(studio), fs.readFileSync(orig)),
			0,
			`${row.sku} must not still be the raw phone snapshot`,
		)
	}

	const plateMean = await cornerMean(PLATE)
	const means = []
	for (const row of catalogSeed) {
		const mean = await cornerMean(path.join(SEED, `${row.sku}.jpg`))
		means.push(mean)
		assert.ok(
			dist(mean, plateMean) < 40,
			`${row.sku} background should match the studio plate (d=${dist(mean, plateMean).toFixed(1)})`,
		)
	}
	for (let i = 1; i < means.length; i++) {
		assert.ok(
			dist(means[0], means[i]) < 18,
			`${catalogSeed[i].sku} background drifted from ${catalogSeed[0].sku} (d=${dist(means[0], means[i]).toFixed(1)})`,
		)
	}

	const wood = await cornerMean(path.join(ORIGINAL, 'STK-HELLO-KITTY-ROLL.jpg'))
	assert.ok(dist(wood, plateMean) > 20, 'archived phone snapshot still shows the original table')

	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ued-studio-'))
	const dbPath = path.join(tmp, 't.db')
	const photosDir = path.join(tmp, 'photos')
	const db = new Database(dbPath)
	try {
		core.migrateSuppliesSchema(db)
		const seeded = core.seedIfEmpty(db, { photosDir, seedDir: SEED })
		assert.equal(seeded.seeded, true)
		const custom = 'STK-HELLO-KITTY-ROLL-999.webp'
		const hello = db.prepare('SELECT photo_file FROM supply_items WHERE sku = ?').get('STK-HELLO-KITTY-ROLL')
		assert.ok(hello && hello.photo_file)
		fs.copyFileSync(path.join(photosDir, hello.photo_file), path.join(photosDir, custom))
		db.prepare('UPDATE supply_items SET photo_file = ? WHERE sku = ?').run(custom, 'STK-HELLO-KITTY-ROLL')
		const result = core.reimportSeedPhotos(db, { photosDir, seedDir: SEED })
		assert.equal(result.skippedCustom, 1)
		assert.equal(
			db.prepare('SELECT photo_file FROM supply_items WHERE sku = ?').get('STK-HELLO-KITTY-ROLL').photo_file,
			custom,
		)
		const tape = db.prepare('SELECT photo_file FROM supply_items WHERE sku = ?').get('TAP-PINK-PACKING')
		assert.ok(tape.photo_file === 'TAP-PINK-PACKING.webp' || tape.photo_file === 'TAP-PINK-PACKING.jpg')
	} finally {
		db.close()
		fs.rmSync(tmp, { recursive: true, force: true })
	}

	console.log('supplies studio photos OK')
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
