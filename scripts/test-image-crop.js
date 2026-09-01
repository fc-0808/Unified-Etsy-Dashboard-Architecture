'use strict'
/**
 * Tests for the Inspector's photo crop.
 *
 * Three layers, because the feature spans three:
 *
 *  1. BROWSER GEOMETRY — the pure rectangle maths from public/index.html. The
 *     block is extracted from the shipped page (between its sentinel comments)
 *     and evaluated here, so these tests exercise the real source rather than a
 *     copy that can drift. No DOM is needed: that is the whole point of keeping
 *     the maths pure.
 *  2. SERVER GEOMETRY — the same contract as the browser sees it, plus the
 *     clamping that makes a fractional-pixel disagreement harmless.
 *  3. PIXELS ON DISK — a real sharp round-trip against real files, pinning the
 *     properties that make this safe to point at a supplier's only copy of a
 *     photo: reversible, atomic, and in place.
 *
 * Run: `node scripts/test-image-crop.js`
 */

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('vm')

const editor = require('../src/listings/image-editor')

let sharp = null
try {
	sharp = require('sharp')
} catch {
	/* the pixel group is skipped below */
}

const GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m', DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m'
let passed = 0, failed = 0, skipped = 0
const failures = []
const pending = []
function group(name) { pending.push({ group: name }) }
function test(name, fn) { pending.push({ name, fn }) }
function skip(name, why) { pending.push({ name, skip: why }) }

// ── Load the browser geometry out of the shipped page ────────────────────────
const HTML = path.resolve(__dirname, '../public/index.html')
const source = fs.readFileSync(HTML, 'utf8')
const START = '// ══ CROP GEOMETRY ══'
const END = '// ══ END CROP GEOMETRY ══'
const a = source.indexOf(START)
const b = source.indexOf(END)
if (a < 0 || b < 0 || b <= a) {
	console.error(`${RED}Could not locate the crop-geometry sentinels in public/index.html.${RESET}`)
	console.error(`${DIM}Expected "${START}" … "${END}".${RESET}`)
	process.exit(1)
}
// Evaluated in THIS realm, not a fresh vm context: the rectangles it returns
// are compared against ones built here, and deepStrictEqual rejects objects
// whose prototypes come from a different realm.
const { bincrClamp, bincrRotateRect, bincrFitAspect, bincrMoveRect, bincrResizeRect, bincrRoundRect, bincrIsWholePhoto } = vm.runInThisContext(
	`(function () {\n${source.slice(a, b)}\n\treturn { bincrClamp, bincrRotateRect, bincrFitAspect, bincrMoveRect, bincrResizeRect, bincrRoundRect, bincrIsWholePhoto }\n})`,
	{ filename: 'public/index.html (crop geometry)' },
)()

// ── Helpers ──────────────────────────────────────────────────────────────────
const MIN = 48
const near = (actual, expected, msg, tol = 1e-6) =>
	assert.ok(Math.abs(actual - expected) <= tol, `${msg}: expected ${expected}, got ${actual}`)
const nearRect = (r, e, msg) => {
	near(r.x, e.x, `${msg} .x`)
	near(r.y, e.y, `${msg} .y`)
	near(r.w, e.w, `${msg} .w`)
	near(r.h, e.h, `${msg} .h`)
}
/** Assert a rect lies wholly inside the frame (the invariant every op must hold). */
const inside = (r, frame, msg) => {
	assert.ok(r.x >= -1e-6, `${msg}: left edge escaped (${r.x})`)
	assert.ok(r.y >= -1e-6, `${msg}: top edge escaped (${r.y})`)
	assert.ok(r.x + r.w <= frame.w + 1e-6, `${msg}: right edge escaped (${r.x + r.w} > ${frame.w})`)
	assert.ok(r.y + r.h <= frame.h + 1e-6, `${msg}: bottom edge escaped (${r.y + r.h} > ${frame.h})`)
	assert.ok(r.w > 0 && r.h > 0, `${msg}: degenerate rect ${r.w}×${r.h}`)
}

// ═════════════════════════════════════════════════════════════════════════════
group('Browser geometry · moving')

test('a move stays inside the photo on every side', () => {
	const frame = { w: 1000, h: 800 }
	const rect = { x: 400, y: 300, w: 200, h: 200 }
	nearRect(bincrMoveRect(rect, frame, 50, -50), { x: 450, y: 250, w: 200, h: 200 }, 'plain move')
	nearRect(bincrMoveRect(rect, frame, -9999, -9999), { x: 0, y: 0, w: 200, h: 200 }, 'pinned top-left')
	nearRect(bincrMoveRect(rect, frame, 9999, 9999), { x: 800, y: 600, w: 200, h: 200 }, 'pinned bottom-right')
})

test('a box the size of the photo cannot be nudged off it', () => {
	const frame = { w: 500, h: 500 }
	const rect = { x: 0, y: 0, w: 500, h: 500 }
	nearRect(bincrMoveRect(rect, frame, -10, 10), rect, 'full-frame box moved')
})

group('Browser geometry · resizing (free)')

test('each handle moves only its own edges', () => {
	const frame = { w: 1000, h: 1000 }
	const rect = { x: 200, y: 200, w: 400, h: 400 }
	nearRect(bincrResizeRect(rect, frame, 'e', 800, 0, MIN, null), { x: 200, y: 200, w: 600, h: 400 }, 'east')
	nearRect(bincrResizeRect(rect, frame, 'w', 100, 0, MIN, null), { x: 100, y: 200, w: 500, h: 400 }, 'west')
	nearRect(bincrResizeRect(rect, frame, 'n', 0, 50, MIN, null), { x: 200, y: 50, w: 400, h: 550 }, 'north')
	nearRect(bincrResizeRect(rect, frame, 'se', 900, 700, MIN, null), { x: 200, y: 200, w: 700, h: 500 }, 'south-east')
})

test('an edge cannot be dragged past its opposite — the minimum holds', () => {
	const frame = { w: 1000, h: 1000 }
	const rect = { x: 200, y: 200, w: 400, h: 400 }
	const pulled = bincrResizeRect(rect, frame, 'w', 9999, 0, MIN, null)
	near(pulled.w, MIN, 'west dragged past east')
	near(pulled.x, 600 - MIN, 'and it anchored on the east edge')
	const squashed = bincrResizeRect(rect, frame, 'n', 0, 9999, MIN, null)
	near(squashed.h, MIN, 'north dragged past south')
})

test('dragging outside the photo clamps to its edge', () => {
	const frame = { w: 640, h: 480 }
	const rect = { x: 100, y: 100, w: 100, h: 100 }
	const out = bincrResizeRect(rect, frame, 'se', 5000, 5000, MIN, null)
	nearRect(out, { x: 100, y: 100, w: 540, h: 380 }, 'clamped to the far corner')
	inside(out, frame, 'free resize past the edge')
})

group('Browser geometry · resizing (aspect locked)')

test('a locked corner drag keeps the ratio exactly', () => {
	const frame = { w: 2000, h: 2000 }
	const rect = { x: 500, y: 500, w: 400, h: 300 } // 4:3
	for (const [handle, px, py] of [['se', 1300, 1400], ['nw', 100, 90], ['ne', 1500, 120], ['sw', 60, 1450]]) {
		const out = bincrResizeRect(rect, frame, handle, px, py, MIN, 4 / 3)
		near(out.w / out.h, 4 / 3, `${handle} kept 4:3`, 1e-9)
		inside(out, frame, `${handle} locked drag`)
	}
})

test('an edge handle grows the locked box symmetrically about its centre', () => {
	const frame = { w: 2000, h: 2000 }
	const rect = { x: 800, y: 800, w: 400, h: 400 }
	const out = bincrResizeRect(rect, frame, 'e', 1400, 0, MIN, 1)
	near(out.w / out.h, 1, 'stayed square')
	near(out.x, 800, 'the opposite (west) edge stayed put')
	near(out.w, 600, 'the width followed the pointer')
	near(out.y + out.h / 2, 1000, 'and the height grew evenly around the centre')
})

test('a locked box run into a corner is scaled down, never pushed out', () => {
	const frame = { w: 1000, h: 400 }
	const rect = { x: 900, y: 300, w: 60, h: 60 }
	const out = bincrResizeRect(rect, frame, 'se', 5000, 5000, MIN, 1)
	near(out.w / out.h, 1, 'still square')
	near(out.h, 100, 'limited by the short side of the frame')
	inside(out, frame, 'locked drag into the corner')
})

test('the ratio survives even when the minimum size does the driving', () => {
	const frame = { w: 1000, h: 1000 }
	const rect = { x: 400, y: 400, w: 200, h: 200 }
	const out = bincrResizeRect(rect, frame, 'se', 401, 402, MIN, 16 / 9)
	near(out.w / out.h, 16 / 9, 'ratio held at the minimum')
	assert.ok(out.h >= MIN - 1e-6, `short side collapsed to ${out.h}`)
	inside(out, frame, 'minimum-size locked drag')
})

test('a zero-length drag cannot produce NaN', () => {
	const frame = { w: 800, h: 800 }
	const rect = { x: 100, y: 100, w: 200, h: 200 }
	const out = bincrResizeRect(rect, frame, 'se', 100, 100, MIN, 1)
	assert.ok(Number.isFinite(out.x) && Number.isFinite(out.w), `got ${JSON.stringify(out)}`)
	inside(out, frame, 'degenerate drag')
})

test('a locked ratio that cannot fit the corner leaves the box alone', () => {
	// A 10:1 strip anchored 5px from the right edge can never satisfy the
	// minimum without spilling — the last good rect must survive.
	const frame = { w: 1000, h: 1000 }
	const rect = { x: 995, y: 500, w: 5, h: 5 }
	const out = bincrResizeRect(rect, frame, 'se', 999, 999, MIN, 10)
	nearRect(out, rect, 'impossible lock')
})

test('an unknown handle is a no-op rather than a corrupt rect', () => {
	const frame = { w: 500, h: 500 }
	const rect = { x: 10, y: 10, w: 100, h: 100 }
	nearRect(bincrResizeRect(rect, frame, '', 300, 300, MIN, null), rect, 'empty handle')
})

group('Browser geometry · aspect presets')

test('a preset fits inside the current box and stays centred on it', () => {
	const frame = { w: 1000, h: 1000 }
	const rect = { x: 100, y: 100, w: 600, h: 300 }
	const square = bincrFitAspect(rect, frame, 1)
	near(square.w, 300, 'took the short side')
	near(square.h, 300, 'as a square')
	near(square.x + square.w / 2, 400, 'centre x held')
	near(square.y + square.h / 2, 250, 'centre y held')
	inside(square, frame, 'square preset')
})

test('a preset on the whole photo yields the largest crop of that shape', () => {
	const frame = { w: 1200, h: 900 }
	const whole = { x: 0, y: 0, w: 1200, h: 900 }
	const wide = bincrFitAspect(whole, frame, 16 / 9)
	near(wide.w, 1200, 'used the full width')
	near(wide.h, 675, 'and the matching height')
	near(wide.y, 112.5, 'centred vertically')
	inside(wide, frame, '16:9 preset')
})

test('a preset near an edge is pushed back inside instead of overflowing', () => {
	const frame = { w: 1000, h: 1000 }
	const rect = { x: 940, y: 10, w: 60, h: 600 }
	const out = bincrFitAspect(rect, frame, 1)
	inside(out, frame, 'edge-hugging preset')
})

test('the free preset leaves the box untouched', () => {
	const frame = { w: 500, h: 500 }
	const rect = { x: 3, y: 7, w: 111, h: 222 }
	nearRect(bincrFitAspect(rect, frame, null), rect, 'free')
	nearRect(bincrFitAspect(rect, frame, 0), rect, 'zero ratio')
})

group('Browser geometry · rotation')

test('a quarter turn carries the box to the same pixels', () => {
	// A box hugging the top-left of a landscape photo must end up hugging the
	// top-right after a clockwise turn.
	const frame = { w: 1000, h: 600 }
	const rect = { x: 0, y: 0, w: 200, h: 100 }
	const cw = bincrRotateRect(rect, frame, 1)
	nearRect(cw.rect, { x: 500, y: 0, w: 100, h: 200 }, 'clockwise')
	assert.deepStrictEqual(cw.frame, { w: 600, h: 1000 }, 'frame transposed')
	inside(cw.rect, cw.frame, 'clockwise turn')
})

test('turning one way then back is the identity', () => {
	const frame = { w: 1234, h: 567 }
	const rect = { x: 111, y: 22, w: 333, h: 145 }
	const there = bincrRotateRect(rect, frame, 1)
	const back = bincrRotateRect(there.rect, there.frame, -1)
	nearRect(back.rect, rect, 'round trip')
	assert.deepStrictEqual(back.frame, frame, 'frame round trip')
})

test('four turns in the same direction return to the start', () => {
	let cur = { rect: { x: 40, y: 90, w: 300, h: 120 }, frame: { w: 800, h: 500 } }
	const start = JSON.parse(JSON.stringify(cur))
	for (let i = 0; i < 4; i++) {
		cur = bincrRotateRect(cur.rect, cur.frame, 1)
		inside(cur.rect, cur.frame, `turn ${i + 1}`)
	}
	nearRect(cur.rect, start.rect, 'four turns')
	assert.deepStrictEqual(cur.frame, start.frame, 'four turns, frame')
})

group('Browser geometry · the rectangle sent to the server')

test('fractional pixels are snapped and kept inside the frame', () => {
	const frame = { w: 1000.4, h: 800.2 }
	const rect = { x: 10.6, y: 20.2, w: 989.9, h: 779.9 }
	const out = bincrRoundRect(rect, frame)
	assert.ok(Number.isInteger(out.left) && Number.isInteger(out.width), 'not integers')
	assert.ok(out.left + out.width <= Math.round(frame.w), `overflowed: ${out.left}+${out.width}`)
	assert.ok(out.top + out.height <= Math.round(frame.h), `overflowed: ${out.top}+${out.height}`)
})

test('a box that fills the photo reads as "nothing to apply"', () => {
	const frame = { w: 1750, h: 1750 }
	assert.strictEqual(bincrIsWholePhoto({ x: 0, y: 0, w: 1750, h: 1750 }, frame, 0), true, 'full box')
	assert.strictEqual(bincrIsWholePhoto({ x: 0, y: 0, w: 1750, h: 1749 }, frame, 0), false, 'one pixel short')
	assert.strictEqual(bincrIsWholePhoto({ x: 0, y: 0, w: 1750, h: 1750 }, frame, 90), false, 'rotation is a change')
})

test('bincrClamp never returns NaN', () => {
	assert.strictEqual(bincrClamp(NaN, 5, 10), 5)
	assert.strictEqual(bincrClamp(undefined, 5, 10), 5)
	assert.strictEqual(bincrClamp(7, 10, 0), 10, 'inverted range collapses to lo')
})

// ═════════════════════════════════════════════════════════════════════════════
group('Server geometry')

test('rotations are snapped to the four quarter turns', () => {
	assert.strictEqual(editor.normaliseRotation(90), 90)
	assert.strictEqual(editor.normaliseRotation(-90), 270)
	assert.strictEqual(editor.normaliseRotation(450), 90)
	assert.strictEqual(editor.normaliseRotation(37), 0, 'an odd angle degrades to no rotation')
	assert.strictEqual(editor.normaliseRotation('bogus'), 0)
	assert.strictEqual(editor.normaliseRotation(undefined), 0)
})

test('a quarter turn transposes the frame the client measures against', () => {
	const o = { width: 1000, height: 600 }
	assert.deepStrictEqual(editor.frameSize(o, 0), { width: 1000, height: 600 })
	assert.deepStrictEqual(editor.frameSize(o, 180), { width: 1000, height: 600 })
	assert.deepStrictEqual(editor.frameSize(o, 90), { width: 600, height: 1000 })
	assert.deepStrictEqual(editor.frameSize(o, 270), { width: 600, height: 1000 })
})

test('a rectangle a fraction over the edge is clamped, not rejected', () => {
	// The browser divides CSS pixels by a fractional scale; landing a pixel or
	// two past the edge is routine and must not fail an operator's crop.
	const frame = { width: 1750, height: 1750 }
	const out = editor.normaliseCrop({ left: 0, top: 0, width: 1752, height: 1751 }, frame)
	assert.deepStrictEqual(out, { left: 0, top: 0, width: 1750, height: 1750 })
	const off = editor.normaliseCrop({ left: 1700, top: 1700, width: 400, height: 400 }, frame)
	assert.deepStrictEqual(off, { left: 1700, top: 1700, width: 50, height: 50 })
})

test('missing fields mean "the whole photo"', () => {
	const out = editor.normaliseCrop({}, { width: 800, height: 600 })
	assert.deepStrictEqual(out, { left: 0, top: 0, width: 800, height: 600 })
})

test('negative and non-numeric input collapses to the origin', () => {
	const out = editor.normaliseCrop({ left: -500, top: 'x', width: 200, height: 200 }, { width: 800, height: 600 })
	assert.deepStrictEqual(out, { left: 0, top: 0, width: 200, height: 200 })
})

test('an unusably small crop is refused with a 400', () => {
	assert.throws(
		() => editor.normaliseCrop({ left: 0, top: 0, width: 10, height: 10 }, { width: 800, height: 600 }),
		(e) => e.status === 400 && /too small/i.test(e.message),
	)
})

test('a tiny photo can still be cropped to its own size', () => {
	// The minimum must scale down to the frame, or a small image becomes uneditable.
	const out = editor.normaliseCrop({ left: 0, top: 0, width: 20, height: 20 }, { width: 20, height: 20 })
	assert.deepStrictEqual(out, { left: 0, top: 0, width: 20, height: 20 })
})

test('the whole photo with no rotation is recognised as a no-op', () => {
	const frame = { width: 500, height: 400 }
	assert.strictEqual(editor.isNoop({ left: 0, top: 0, width: 500, height: 400 }, frame, 0), true)
	assert.strictEqual(editor.isNoop({ left: 0, top: 0, width: 500, height: 400 }, frame, 180), false)
	assert.strictEqual(editor.isNoop({ left: 1, top: 0, width: 499, height: 400 }, frame, 0), false)
})

test('the browser and the server agree on the same rectangle', () => {
	// The two implementations are independent; this is the contract between them.
	// Every case is one the UI can actually emit — i.e. already ≥ the minimum.
	const cases = [
		{ frame: { w: 1750, h: 1750 }, rect: { x: 12.7, y: 900.2, w: 800.6, h: 400.4 } },
		{ frame: { w: 640, h: 480 }, rect: { x: 0, y: 0, w: 640, h: 480 } },
		{ frame: { w: 1000, h: 750 }, rect: { x: 899.6, y: 0.4, w: 100.8, h: 700.9 } },
		{ frame: { w: 1750, h: 1750 }, rect: { x: 1700.9, y: 1700.9, w: 60, h: 60 } },
	]
	for (const c of cases) {
		const fromUi = bincrRoundRect(c.rect, c.frame)
		const onServer = editor.normaliseCrop(fromUi, { width: c.frame.w, height: c.frame.h })
		assert.deepStrictEqual(onServer, fromUi, `server changed the browser's rect for ${JSON.stringify(c.rect)}`)
	}
})

test('the minimum crop size is the same number on both sides', () => {
	// The UI refuses to build a box below its minimum, so a UI whose minimum is
	// smaller than the server's would let an operator compose a crop that is
	// then rejected on apply.
	const m = /const BINCR_MIN_SIDE = (\d+)/.exec(source)
	assert.ok(m, 'BINCR_MIN_SIDE is no longer declared in public/index.html')
	assert.strictEqual(Number(m[1]), editor.MIN_SIDE, 'the browser and server minimums have drifted apart')
})

// ═════════════════════════════════════════════════════════════════════════════
group('Pixels on disk')

let workdir = null
/** Write a solid test photo and return its path. */
async function photo(name, width, height, colour = { r: 200, g: 40, b: 90 }) {
	const file = path.join(workdir, name)
	const ext = path.extname(name).toLowerCase()
	let img = sharp({ create: { width, height, channels: 3, background: colour } })
	img = ext === '.png' ? img.png() : ext === '.webp' ? img.webp() : img.jpeg({ quality: 100 })
	await img.toFile(file)
	return file
}

if (!sharp) {
	skip('crop / revert round trip', 'sharp is not installed')
} else {
	test('cropping rewrites the photo in place at the requested size', async () => {
		const file = await photo('1.png', 800, 600)
		const before = fs.readdirSync(workdir).sort()
		const res = await editor.crop(file, { left: 100, top: 50, width: 400, height: 300 })
		assert.strictEqual(res.changed, true, 'reported no change')
		assert.strictEqual(res.width, 400)
		assert.strictEqual(res.height, 300)
		const meta = await sharp(file).metadata()
		assert.strictEqual(meta.width, 400, 'the file on disk was not rewritten')
		assert.strictEqual(meta.height, 300)
		assert.strictEqual(meta.format, 'png', 'the format changed, which would change the filename')
		assert.deepStrictEqual(
			fs.readdirSync(workdir).filter((f) => f !== editor.ORIGINALS_DIR).sort(),
			before,
			'a stray file was left in the product folder',
		)
	})

	test('the supplier original is preserved and restored exactly', async () => {
		const file = await photo('2.jpg', 500, 500)
		const pristine = fs.readFileSync(file)
		await editor.crop(file, { left: 10, top: 10, width: 200, height: 200 })
		assert.ok(editor.hasOriginal(file), 'no original was kept')
		assert.notStrictEqual(fs.readFileSync(file).length, pristine.length, 'the file was not actually cropped')
		await editor.restore(file)
		assert.ok(fs.readFileSync(file).equals(pristine), 'the restored file is not byte-identical')
		assert.strictEqual(editor.hasOriginal(file), false, 'the backup outlived the restore')
	})

	test('a second crop still reverts all the way back to the supplier photo', async () => {
		const file = await photo('3.png', 900, 900)
		const pristine = fs.readFileSync(file)
		await editor.crop(file, { left: 0, top: 0, width: 600, height: 600 })
		await editor.crop(file, { left: 0, top: 0, width: 300, height: 300 })
		assert.strictEqual((await sharp(file).metadata()).width, 300, 'the second crop did not apply')
		await editor.restore(file)
		assert.ok(fs.readFileSync(file).equals(pristine), '"revert" only undid the last crop')
	})

	test('a crop is measured against the second crop, not the first', async () => {
		// The operator crops what they can see, so the coordinate space must be
		// the CURRENT file — otherwise the second crop lands somewhere else.
		const file = await photo('4.png', 1000, 1000)
		await editor.crop(file, { left: 0, top: 0, width: 500, height: 500 })
		await editor.crop(file, { left: 400, top: 400, width: 100, height: 100 })
		const meta = await sharp(file).metadata()
		assert.strictEqual(meta.width, 100, 'the second crop was clamped against the wrong frame')
	})

	test('rotating swaps the frame the crop is taken from', async () => {
		const file = await photo('5.png', 800, 400)
		// After a quarter turn the frame is 400×800, so this rectangle is only
		// valid if the server really rotated before extracting.
		const res = await editor.crop(file, { left: 0, top: 0, width: 400, height: 800, rotate: 90 })
		assert.strictEqual(res.changed, true)
		const meta = await sharp(file).metadata()
		assert.strictEqual(meta.width, 400, 'the photo was not rotated before extracting')
		assert.strictEqual(meta.height, 800)
	})

	test('a full-frame crop with no rotation is skipped, leaving the bytes alone', async () => {
		const file = await photo('6.jpg', 640, 480)
		const before = fs.readFileSync(file)
		const res = await editor.crop(file, { left: 0, top: 0, width: 640, height: 480 })
		assert.strictEqual(res.changed, false, 'a no-op was re-encoded')
		assert.ok(fs.readFileSync(file).equals(before), 'the file was rewritten anyway')
		assert.strictEqual(editor.hasOriginal(file), false, 'a pointless backup was taken')
	})

	test('reverting a photo that was never cropped fails cleanly', async () => {
		const file = await photo('7.png', 300, 300)
		await assert.rejects(() => editor.restore(file), (e) => e.status === 404)
	})

	test('a crop below the minimum is refused before anything is written', async () => {
		const file = await photo('8.png', 400, 400)
		const before = fs.readFileSync(file)
		await assert.rejects(
			() => editor.crop(file, { left: 0, top: 0, width: 4, height: 4 }),
			(e) => e.status === 400,
		)
		assert.ok(fs.readFileSync(file).equals(before), 'the photo was touched by a rejected crop')
		assert.strictEqual(editor.hasOriginal(file), false, 'a rejected crop left a backup behind')
	})

	test('a file that is not an image is refused, not corrupted', async () => {
		const file = path.join(workdir, 'notes.png')
		fs.writeFileSync(file, 'this is plainly not a PNG')
		await assert.rejects(
			() => editor.crop(file, { left: 0, top: 0, width: 100, height: 100 }),
			(e) => e.status === 400,
		)
		assert.strictEqual(fs.readFileSync(file, 'utf8'), 'this is plainly not a PNG')
	})

	test('the backup lives in a subfolder the image scanner ignores', async () => {
		const { IMAGE_EXTS } = require('../src/listings/scanner')
		assert.strictEqual(IMAGE_EXTS.has(path.extname(editor.ORIGINALS_DIR).toLowerCase()), false)
		const file = await photo('9.png', 400, 400)
		await editor.crop(file, { left: 0, top: 0, width: 200, height: 200 })
		const { scanProductFolder } = require('../src/listings/scanner')
		const names = (scanProductFolder(workdir, { maxImages: Infinity }).images || []).map((im) => im.filename)
		assert.strictEqual(names.filter((n) => n === '9.png').length, 1, 'the original leaked back into the scan')
	})

	test('concurrent crops of the same photo leave a readable image', async () => {
		const file = await photo('10.png', 900, 900)
		const specs = [
			{ left: 0, top: 0, width: 500, height: 500 },
			{ left: 100, top: 100, width: 400, height: 400 },
			{ left: 50, top: 50, width: 600, height: 600 },
		]
		// Whichever rename lands last wins; the invariant is that a reader can
		// never see a torn file.
		await Promise.allSettled(specs.map((s) => editor.crop(file, s)))
		const meta = await sharp(file).metadata()
		assert.ok(meta.width > 0 && meta.height > 0, 'the photo was left unreadable')
	})
}

// ═════════════════════════════════════════════════════════════════════════════
group('Through the job manager')

let Database = null
try {
	Database = require('better-sqlite3')
} catch {
	/* the manager group is skipped below */
}

/**
 * A BulkJobManager over an in-memory database, holding one dry-run job with one
 * product folder of real photos — the minimum needed to drive the crop endpoints
 * exactly as the server does.
 */
async function manager({ dryRun = 1, listingId = null } = {}) {
	const { BulkJobManager } = require('../src/listings/bulk-runner')
	const db = new Database(':memory:')
	db.exec(`
		CREATE TABLE bulk_jobs (job_id TEXT PRIMARY KEY, shop_key TEXT, shop_name TEXT, input_path TEXT,
			state TEXT DEFAULT 'done', target_state TEXT DEFAULT 'draft', dry_run INTEGER DEFAULT 0,
			total INTEGER DEFAULT 0, completed INTEGER DEFAULT 0, failed INTEGER DEFAULT 0,
			options_json TEXT, error TEXT, created_at INTEGER, started_at INTEGER, finished_at INTEGER,
			auto_resume_count INTEGER DEFAULT 0);
		CREATE TABLE bulk_job_items (job_id TEXT, product_folder TEXT, product_name TEXT, seq INTEGER,
			status TEXT DEFAULT 'done', listing_id INTEGER, listing_url TEXT, title TEXT, error TEXT,
			ai_json TEXT, checkpoint_json TEXT, preview_json TEXT, published_at INTEGER,
			reviewed_at INTEGER, policy_confirmed_at INTEGER, policy_confirmed_by TEXT,
			policy_attestation TEXT, excluded INTEGER DEFAULT 0, updated_at INTEGER,
			PRIMARY KEY (job_id, product_folder));
	`)

	const root = fs.mkdtempSync(path.join(workdir, 'job-'))
	const folder = path.join(root, 'cow-case')
	fs.mkdirSync(folder)
	for (const [name, w, h] of [['1.png', 900, 900], ['2.png', 800, 600], ['3.png', 700, 700]]) {
		await sharp({ create: { width: w, height: h, channels: 3, background: { r: 30, g: 30, b: 30 } } })
			.png()
			.toFile(path.join(folder, name))
	}

	db.prepare('INSERT INTO bulk_jobs (job_id, shop_key, shop_name, input_path, dry_run) VALUES (?,?,?,?,?)').run('job-1', 'shop', 'Shop', root, dryRun)
	db.prepare('INSERT INTO bulk_job_items (job_id, product_folder, product_name, seq, listing_id, preview_json) VALUES (?,?,?,?,?,?)').run(
		'job-1',
		folder,
		'cow-case',
		1,
		listingId,
		JSON.stringify({
			images: [
				{ rank: 1, filename: '1.png' },
				{ rank: 2, filename: '2.png' },
				{ rank: 3, filename: '3.png' },
			],
			imageOrder: ['1.png', '2.png', '3.png'],
			styleImageMapping: { case_only: [2], case_charm: [3] },
		}),
	)

	const mgr = new BulkJobManager({ db, resolveShopClient: async () => { throw new Error('no Etsy in tests') } })
	const preview = () => JSON.parse(db.prepare('SELECT preview_json FROM bulk_job_items WHERE job_id = ?').get('job-1').preview_json)
	return { mgr, db, folder, preview }
}

if (!sharp || !Database) {
	skip('crop through BulkJobManager', !sharp ? 'sharp is not installed' : 'better-sqlite3 is not installed')
} else {
	test('cropping the thumbnail records the edit against its filename', async () => {
		const { mgr, folder, preview } = await manager()
		const res = await mgr.cropItemImage('job-1', 1, 1, { left: 100, top: 100, width: 500, height: 500 })
		assert.strictEqual(res.changed, true)
		assert.strictEqual(res.filename, '1.png')
		const meta = await sharp(path.join(folder, '1.png')).metadata()
		assert.strictEqual(meta.width, 500, 'the file on disk was not cropped')
		assert.deepStrictEqual(Object.keys(preview().imageEdits), ['1.png'])
		assert.strictEqual(preview().imageEdits['1.png'].revertible, true)
	})

	test('the crop lands on the photo the operator was looking at, not the file order', async () => {
		// Rank 2 is a different file from image 2 once the plan has been reordered;
		// resolving through the plan is what keeps them in step.
		const { mgr, folder } = await manager()
		mgr.updateItemImages('job-1', 1, ['3.png', '1.png', '2.png'])
		await mgr.cropItemImage('job-1', 1, 1, { left: 0, top: 0, width: 300, height: 300 })
		assert.strictEqual((await sharp(path.join(folder, '3.png')).metadata()).width, 300, 'cropped the wrong photo')
		assert.strictEqual((await sharp(path.join(folder, '1.png')).metadata()).width, 900, 'cropped an innocent photo')
	})

	test('a crop leaves the image plan and the variation photo links untouched', async () => {
		const { mgr, preview } = await manager()
		const before = preview()
		await mgr.cropItemImage('job-1', 1, 2, { left: 0, top: 0, width: 400, height: 400 })
		const after = preview()
		assert.deepStrictEqual(after.imageOrder, before.imageOrder, 'the upload order moved')
		assert.deepStrictEqual(after.images, before.images, 'the ranks moved')
		assert.deepStrictEqual(after.styleImageMapping, before.styleImageMapping, 'a variation lost its photo')
	})

	test('revert restores the photo and clears the record', async () => {
		const { mgr, folder, preview } = await manager()
		await mgr.cropItemImage('job-1', 1, 1, { left: 0, top: 0, width: 400, height: 400 })
		await mgr.revertItemImage('job-1', 1, 1)
		assert.strictEqual((await sharp(path.join(folder, '1.png')).metadata()).width, 900, 'the photo was not restored')
		assert.strictEqual(preview().imageEdits, undefined, 'the crop record outlived the revert')
	})

	test('reverting an untouched photo is a clean 404', async () => {
		const { mgr } = await manager()
		await assert.rejects(() => mgr.revertItemImage('job-1', 1, 2), (e) => e.status === 404)
	})

	test('dropping a cropped photo from the plan drops its record too', async () => {
		const { mgr, preview } = await manager()
		await mgr.cropItemImage('job-1', 1, 3, { left: 0, top: 0, width: 300, height: 300 })
		assert.ok(preview().imageEdits['3.png'], 'setup failed')
		mgr.updateItemImages('job-1', 1, ['1.png', '2.png'])
		assert.strictEqual(preview().imageEdits, undefined, 'a record for an archived photo survived')
	})

	test('archiving a photo never disturbs another photo\'s crop record', async () => {
		const { mgr, preview } = await manager()
		await mgr.cropItemImage('job-1', 1, 1, { left: 0, top: 0, width: 300, height: 300 })
		mgr.updateItemImages('job-1', 1, ['1.png', '2.png'])
		assert.ok(preview().imageEdits && preview().imageEdits['1.png'], 'the kept photo lost its record')
	})

	test('a real listing can no longer be re-cropped', async () => {
		const { mgr } = await manager({ dryRun: 0, listingId: 12345 })
		await assert.rejects(
			() => mgr.cropItemImage('job-1', 1, 1, { left: 0, top: 0, width: 100, height: 100 }),
			(e) => e.status === 400 && /dry-run preview/.test(e.message),
		)
		await assert.rejects(() => mgr.revertItemImage('job-1', 1, 1), (e) => e.status === 400)
	})

	test('a rank that does not exist is a 404, not a crash', async () => {
		const { mgr } = await manager()
		await assert.rejects(() => mgr.cropItemImage('job-1', 1, 99, { left: 0, top: 0, width: 100, height: 100 }), (e) => e.status === 404)
	})

	test('the Etsy upload picks up the cropped bytes at the same filename', async () => {
		// applyImagePlan turns the curated gallery into the exact file list that
		// goes to Etsy. Cropping in place must be invisible to it.
		const { applyImagePlan } = require('../src/listings/bulk-runner')
		const { scanProductFolder } = require('../src/listings/scanner')
		const { mgr, folder, preview } = await manager()
		await mgr.cropItemImage('job-1', 1, 1, { left: 0, top: 0, width: 450, height: 450 })

		const planned = applyImagePlan(scanProductFolder(folder, { maxImages: Infinity }), preview())
		assert.deepStrictEqual(planned.images.map((im) => im.filename), ['1.png', '2.png', '3.png'], 'the upload list changed')
		assert.deepStrictEqual(planned.images.map((im) => im.rank), [1, 2, 3], 'the ranks moved')
		const meta = await sharp(planned.images[0].path).metadata()
		assert.strictEqual(meta.width, 450, 'Etsy would have received the uncropped photo')
	})

	test('the pristine backup is never mistaken for a listing photo', async () => {
		const { applyImagePlan } = require('../src/listings/bulk-runner')
		const { scanProductFolder } = require('../src/listings/scanner')
		const { mgr, folder, preview } = await manager()
		await mgr.cropItemImage('job-1', 1, 1, { left: 0, top: 0, width: 450, height: 450 })
		const planned = applyImagePlan(scanProductFolder(folder, { maxImages: Infinity }), preview())
		assert.strictEqual(planned.images.length, 3, 'the archived original was uploaded as a fourth photo')
		for (const im of planned.images) {
			assert.ok(!im.path.includes(editor.ORIGINALS_DIR), `${im.path} points into the backup folder`)
		}
	})
}

// ── Runner ───────────────────────────────────────────────────────────────────
;(async () => {
	workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'etsy-crop-test-'))
	try {
		for (const entry of pending) {
			if (entry.group) { console.log(`\n${BOLD}${entry.group}${RESET}`); continue }
			if (entry.skip) {
				skipped++
				console.log(`${YELLOW}  ‒${RESET} ${entry.name} ${DIM}(${entry.skip})${RESET}`)
				continue
			}
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
	} finally {
		try { fs.rmSync(workdir, { recursive: true, force: true }) } catch { /* best effort */ }
	}

	console.log()
	if (failed) {
		console.log(`${RED}${BOLD}  ${failed} test(s) failed${RESET}, ${passed} passed${skipped ? `, ${skipped} skipped` : ''}`)
		for (const f of failures) console.log(`${DIM}  · ${f.name}: ${f.err.message}${RESET}`)
		process.exit(1)
	}
	console.log(`${GREEN}${BOLD}  All ${passed} tests passed.${RESET}${skipped ? ` ${DIM}(${skipped} skipped)${RESET}` : ''}`)
	console.log()
})()
