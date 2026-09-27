'use strict'

/**
 * Local visual prior for find-by-photo: dark-ink layout grids rank similar
 * silhouettes together and separate a top-heavy print from a bottom-heavy one.
 *
 * Run: node scripts/test-find-by-photo-visual.js
 */

const assert = require('node:assert/strict')
const sharp = require('sharp')
const visual = require('../src/route/find-by-photo-visual')

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const RESET = '\x1b[0m'
let passed = 0
let failed = 0

async function test(name, fn) {
	try {
		await fn()
		passed++
		console.log(`  ${GREEN}ok${RESET}  — ${name}`)
	} catch (err) {
		failed++
		console.error(`  ${RED}FAIL${RESET} — ${name}`)
		console.error(`         ${err.message}`)
	}
}

async function inkCase({ topDark, bottomDark, bg = '#f4eef8' }) {
	const width = 240
	const height = 420
	const layers = []
	if (topDark) {
		layers.push({
			input: await sharp({
				create: { width: 160, height: 90, channels: 3, background: '#1a1218' },
			})
				.png()
				.toBuffer(),
			left: 40,
			top: 36,
		})
	}
	if (bottomDark) {
		layers.push({
			input: await sharp({
				create: { width: 140, height: 50, channels: 3, background: '#161016' },
			})
				.png()
				.toBuffer(),
			left: 50,
			top: 330,
		})
	}
	let img = sharp({
		create: { width, height, channels: 3, background: bg },
	})
	if (layers.length) img = img.composite(layers)
	return img.jpeg({ quality: 80 }).toBuffer()
}

console.log('\nFind by photo visual prior\n')

;(async () => {
	await test('computeVisualSignature rejects empty buffers', async () => {
		assert.equal(await visual.computeVisualSignature(Buffer.alloc(0)), null)
		assert.equal(await visual.computeVisualSignature(null), null)
	})

	await test('matching top-heavy prints outrank a bottom-heavy one', async () => {
		const query = await inkCase({ topDark: true, bottomDark: false })
		const same = await inkCase({ topDark: true, bottomDark: false, bg: '#fff7fb' })
		const other = await inkCase({ topDark: false, bottomDark: true })
		const q = await visual.computeVisualSignature(query)
		const scored = await visual.scoreSignatures(q, [
			{ title: 'same', jpeg: same, score: 10 },
			{ title: 'other', jpeg: other, score: 20 },
		])
		scored.sort(visual.compareBlended)
		assert.equal(scored[0].title, 'same')
		assert.ok(scored[0].layout_similarity > scored[1].layout_similarity)
	})

	await test('relative visual scores stay unknown when layouts do not separate', async () => {
		const a = await inkCase({ topDark: true, bottomDark: true })
		const q = await visual.computeVisualSignature(a)
		const scored = visual.relativeVisualScores([
			{ title: 'a', layout_similarity: 0.4 },
			{ title: 'b', layout_similarity: 0.401 },
		])
		assert.equal(scored[0].visual_similarity, null)
		assert.ok(q && Array.isArray(q.grid) && q.grid.length === visual.GRID_COLS * visual.GRID_ROWS)
	})

	await test('sparse ink mass is demoted against a dense collage query', async () => {
		const dense = await inkCase({ topDark: true, bottomDark: true })
		const sparse = await sharp({
			create: { width: 240, height: 420, channels: 3, background: '#efe4f4' },
		})
			.composite([
				{
					input: await sharp({
						create: { width: 28, height: 22, channels: 3, background: '#2a1820' },
					})
						.png()
						.toBuffer(),
					left: 108,
					top: 80,
				},
			])
			.jpeg({ quality: 80 })
			.toBuffer()
		const q = await visual.computeVisualSignature(dense)
		const scored = await visual.scoreSignatures(q, [
			{ title: 'dense', jpeg: dense, score: 20 },
			{ title: 'sparse', jpeg: sparse, score: 28 },
		])
		const sparseHit = scored.find((row) => row.title === 'sparse')
		const denseHit = scored.find((row) => row.title === 'dense')
		assert.ok(denseHit)
		assert.ok(sparseHit)
		assert.equal(sparseHit.mass_outlier, true)
		assert.equal(denseHit.mass_outlier, false)
		assert.ok(sparseHit.score < denseHit.score)
		assert.ok(visual.massMismatch(q, sparseHit.signature))
	})

	await test('cropProductJpeg drops a wood-colored table border', async () => {
		const inner = await sharp({
			create: { width: 120, height: 220, channels: 3, background: '#7b4cff' },
		})
			.png()
			.toBuffer()
		const framed = await sharp({
			create: { width: 240, height: 360, channels: 3, background: '#c4a06a' },
		})
			.composite([{ input: inner, left: 60, top: 50 }])
			.jpeg()
			.toBuffer()
		const crop = await visual.cropProductJpeg(framed, { edge: 120 })
		assert.ok(crop && crop.length)
		const cropStats = await sharp(crop).stats()
		const fullStats = await sharp(framed).stats()
		assert.ok(cropStats.channels[2].mean > fullStats.channels[2].mean)
	})

	if (failed) {
		console.error(`\n${failed} failed, ${passed} passed`)
		process.exit(1)
	}
	console.log(`\n${passed} passed`)
})()
