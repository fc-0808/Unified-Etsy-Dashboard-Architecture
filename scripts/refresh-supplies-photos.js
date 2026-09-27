'use strict'

/**
 * Copy studio-backed seed photos into the live supplies-photos folder.
 *
 * Catalog tiles keep the original product pixels (see original/) on one AI
 * studio plate. This overwrites the seeded files only; a later owner-uploaded
 * photo (sku-timestamp.webp) is left alone.
 *
 * Usage:
 *   node scripts/refresh-supplies-photos.js
 *   node scripts/refresh-supplies-photos.js --render
 */
const { spawnSync } = require('child_process')
const path = require('path')
const Database = require('better-sqlite3')
const { loadConfig } = require('../src/config/schema')
const core = require('../src/supplies/core')

function runRender() {
	const script = path.join(__dirname, 'studio-supplies-photos.py')
	const result = spawnSync('python', [script], {
		cwd: path.join(__dirname, '..'),
		stdio: 'inherit',
		windowsHide: true,
	})
	if (result.status !== 0) {
		throw new Error(`studio render failed (${result.status == null ? 'spawn error' : result.status})`)
	}
}

function main() {
	const render = process.argv.includes('--render')
	if (render) runRender()

	const config = loadConfig()
	const db = new Database(config.db_path)
	try {
		const photosDir = core.resolvePhotosDir(config.db_path)
		const result = core.reimportSeedPhotos(db, { photosDir })
		console.log(
			`[supplies] studio photos: ${result.updated} catalog files refreshed, ${result.skippedCustom} custom uploads kept (${photosDir})`,
		)
	} finally {
		db.close()
	}
}

main()
