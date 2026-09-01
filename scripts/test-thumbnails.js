'use strict'
/**
 * Unit tests for the Inspector thumbnail cache.
 *
 * Offline and deterministic: generates its own source images in a temp folder,
 * so it never touches the product library or the network.
 */

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m'
let passed = 0, failed = 0
const failures = []
const pending = []
function group(name) { pending.push({ group: name }) }
function test(name, fn) { pending.push({ name, fn }) }

const thumbs = require('../src/listings/thumbnails')
const sharp = require('sharp')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'thumbtest-'))

async function makeImage(name, size, opts = {}) {
	const p = path.join(TMP, name)
	let img = sharp({
		create: {
			width: size, height: size, channels: opts.alpha ? 4 : 3,
			background: opts.alpha ? { r: 255, g: 0, b: 128, alpha: 0.5 } : { r: 200, g: 120, b: 200 },
		},
	})
	img = opts.alpha ? img.png() : img.jpeg({ quality: 92 })
	fs.writeFileSync(p, await img.toBuffer())
	return p
}

group('Width normalisation')

test('snaps a requested width up to the nearest allowlisted size', () => {
	assert.strictEqual(thumbs.normaliseWidth(240), 240)
	assert.strictEqual(thumbs.normaliseWidth(100), 160)
	assert.strictEqual(thumbs.normaliseWidth(241), 480)
	assert.strictEqual(thumbs.normaliseWidth('240'), 240)
})

test('clamps oversized requests to the largest supported width', () => {
	assert.strictEqual(thumbs.normaliseWidth(99999), 960)
	assert.strictEqual(thumbs.normaliseWidth(960), 960)
})

test('treats absent or nonsensical widths as "no resize"', () => {
	for (const v of [null, undefined, '', 0, -5, 'abc', NaN, {}]) {
		assert.strictEqual(thumbs.normaliseWidth(v), null, `width=${JSON.stringify(v)}`)
	}
})

test('an unbounded width can never blow up the cache', () => {
	// Every arbitrary input must land on one of a handful of cache keys.
	const produced = new Set()
	for (let i = 1; i <= 2000; i += 7) produced.add(thumbs.normaliseWidth(i))
	for (const w of produced) assert.ok(thumbs.WIDTHS.includes(w), `${w} is not allowlisted`)
	assert.ok(produced.size <= thumbs.WIDTHS.length)
})

group('Thumbnail generation')

test('produces a WebP no wider than requested', async () => {
	const src = await makeImage('big.jpg', 1750)
	const out = await thumbs.getThumbnail(src, 240)
	assert.ok(out, 'expected a thumbnail')
	assert.strictEqual(out.mime, 'image/webp')
	const meta = await sharp(out.path).metadata()
	assert.strictEqual(meta.format, 'webp')
	assert.strictEqual(meta.width, 240)
})

test('is dramatically smaller than the original', async () => {
	const src = await makeImage('big2.jpg', 1750)
	const out = await thumbs.getThumbnail(src, 240)
	const before = fs.statSync(src).size
	const after = fs.statSync(out.path).size
	assert.ok(after < before / 5, `expected a large saving, got ${before} → ${after}`)
})

test('never upscales a source smaller than the target', async () => {
	const src = await makeImage('small.jpg', 90)
	const out = await thumbs.getThumbnail(src, 480)
	const meta = await sharp(out.path).metadata()
	assert.strictEqual(meta.width, 90)
})

test('preserves transparency', async () => {
	const src = await makeImage('alpha.png', 600, { alpha: true })
	const out = await thumbs.getThumbnail(src, 160)
	const meta = await sharp(out.path).metadata()
	assert.strictEqual(meta.hasAlpha, true)
})

group('Caching and invalidation')

test('a second request reuses the cached file', async () => {
	const src = await makeImage('cache.jpg', 800)
	const a = await thumbs.getThumbnail(src, 240)
	const mtimeA = fs.statSync(a.path).mtimeMs
	await new Promise((r) => setTimeout(r, 30))
	const b = await thumbs.getThumbnail(src, 240)
	assert.strictEqual(b.path, a.path)
	assert.strictEqual(fs.statSync(b.path).mtimeMs, mtimeA, 'cache entry was needlessly rewritten')
})

test('different widths are cached separately', async () => {
	const src = await makeImage('widths.jpg', 800)
	const a = await thumbs.getThumbnail(src, 160)
	const b = await thumbs.getThumbnail(src, 480)
	assert.notStrictEqual(a.etag, b.etag)
	assert.notStrictEqual(a.path, b.path)
})

test('replacing the source photo invalidates the ETag', async () => {
	const src = await makeImage('swap.jpg', 800)
	const before = await thumbs.getThumbnail(src, 240)
	// A different image at the same path — the classic stale-thumbnail trap.
	// Swap it in via rename: that is how a real replacement lands, and it avoids
	// the Windows sharing violation you get writing over a just-read file.
	await new Promise((r) => setTimeout(r, 20))
	const staged = path.join(TMP, 'swap-new.jpg')
	fs.writeFileSync(staged, await sharp({ create: { width: 900, height: 900, channels: 3, background: { r: 10, g: 200, b: 40 } } }).jpeg().toBuffer())
	fs.renameSync(staged, src)
	const after = await thumbs.getThumbnail(src, 240)
	assert.notStrictEqual(after.etag, before.etag, 'a replaced photo would be served stale forever')
})

test('the ETag is a quoted strong validator', async () => {
	const src = await makeImage('etag.jpg', 400)
	const out = await thumbs.getThumbnail(src, 240)
	assert.ok(/^"[a-f0-9]{40}"$/.test(out.etag), `bad ETag: ${out.etag}`)
})

test('concurrent requests for the same tile produce one valid file', async () => {
	const src = await makeImage('race.jpg', 1200)
	const results = await Promise.all(Array.from({ length: 12 }, () => thumbs.getThumbnail(src, 240)))
	const paths = new Set(results.map((r) => r.path))
	assert.strictEqual(paths.size, 1)
	const meta = await sharp(results[0].path).metadata()
	assert.strictEqual(meta.width, 240, 'a torn/partial file would fail to decode')
})

group('Graceful degradation')

test('a non-image file yields null so the caller streams the original', async () => {
	const p = path.join(TMP, 'notanimage.jpg')
	fs.writeFileSync(p, 'this is definitely not a JPEG')
	assert.strictEqual(await thumbs.getThumbnail(p, 240), null)
})

test('a missing file yields null rather than throwing', async () => {
	assert.strictEqual(await thumbs.getThumbnail(path.join(TMP, 'nope.jpg'), 240), null)
})

test('a directory yields null rather than throwing', async () => {
	assert.strictEqual(await thumbs.getThumbnail(TMP, 240), null)
})

test('no width means no thumbnail', async () => {
	const src = await makeImage('nowidth.jpg', 400)
	assert.strictEqual(await thumbs.getThumbnail(src, null), null)
})

test('pruning never throws, even on a cold cache', () => {
	assert.doesNotThrow(() => thumbs.pruneCache())
})

// ── Runner ───────────────────────────────────────────────────────────────────
;(async () => {
	for (const entry of pending) {
		if (entry.group) { console.log(`\n${BOLD}${entry.group}${RESET}`); continue }
		try {
			await entry.fn()
			passed++
			console.log(`${GREEN}  ✓${RESET} ${entry.name}`)
		} catch (err) {
			failed++
			failures.push({ name: entry.name, err })
			console.log(`${RED}  ✗${RESET} ${entry.name}`)
		}
	}
	try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* best effort */ }
	console.log()
	if (failed) {
		console.log(`${RED}${BOLD}  ${failed} test(s) failed${RESET}, ${passed} passed`)
		for (const f of failures) console.log(`${DIM}  · ${f.name}: ${f.err.message}${RESET}`)
		process.exit(1)
	}
	console.log(`${GREEN}${BOLD}  All ${passed} tests passed.${RESET}`)
	console.log()
})()
