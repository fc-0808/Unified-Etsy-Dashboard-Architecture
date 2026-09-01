'use strict'
/**
 * Behavioural tests for the Inspector image lightbox.
 *
 * The dashboard UI lives in one large inline <script>, so this harness extracts
 * just the lightbox block (between the sentinel comments in index.html) and runs
 * it against a jsdom document with a stubbed Inspector gallery. That keeps the
 * tests honest — they execute the real shipped source, not a copy — without
 * booting the whole application.
 *
 * The behaviours pinned here are the ones that are easy to break by accident:
 *   · Escape must close the lightbox, NOT the Inspector behind it.
 *   · Finishing a drag-reorder must not open the viewer.
 *   · Navigation must stay in bounds and focus must return where it started.
 */

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { JSDOM } = require('jsdom')

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m'
let passed = 0, failed = 0
const failures = []
const pending = []
function group(name) { pending.push({ group: name }) }
function test(name, fn) { pending.push({ name, fn }) }

// ── Extract the lightbox source straight out of the shipped page ─────────────
const HTML = path.resolve(__dirname, '../public/index.html')
const source = fs.readFileSync(HTML, 'utf8')
const START = '// ══ IMAGE LIGHTBOX ══'
const END = '// ══ END IMAGE LIGHTBOX ══'
const a = source.indexOf(START)
const b = source.indexOf(END)
if (a < 0 || b < 0 || b <= a) {
	console.error(`${RED}Could not locate the lightbox sentinels in public/index.html.${RESET}`)
	console.error(`${DIM}Expected "${START}" … "${END}".${RESET}`)
	process.exit(1)
}
const LIGHTBOX_SRC = source.slice(a, b)

/** Build a fresh document with a gallery of `n` photos and the lightbox loaded. */
function makeEnv(n = 4, { editable = true } = {}) {
	// Mirrors the markup bulkInspectorRender() emits, inline handlers included —
	// so a rename that breaks the attribute wiring fails these tests.
	const tiles = Array.from({ length: n }, (_, i) => {
		const rank = i + 1
		return `<div class="bins-thumb${rank === 1 ? ' is-first' : ''}${editable ? ' editable' : ''}"
			data-filename="photo-${rank}.jpg" data-rank="${rank}" tabindex="0" role="button"
			onclick="bulkLightboxFromThumb(event, this)" onkeydown="bulkThumbKey(event, this)">
			<span class="rank">${rank}</span>
			<img src="/api/img/${rank}?w=240" alt="photo-${rank}.jpg">
			${editable ? '<button type="button" class="bins-thumb-del" onclick="event.stopPropagation()">✕</button>' : ''}
		</div>`
	}).join('')

	const dom = new JSDOM(
		`<!doctype html><html><body><div id="binsGallery">${tiles}</div></body></html>`,
		// 'dangerously' compiles the inline on* attributes; the fixture contains
		// no <script> tags, so nothing else executes.
		{ pretendToBeVisual: true, runScripts: 'dangerously' },
	)
	const { window } = dom

	// jsdom does not implement layout or image loading; stub the few bits the
	// lightbox touches so it can run unmodified.
	window.requestAnimationFrame = (fn) => window.setTimeout(fn, 0)
	window.Element.prototype.scrollIntoView = function () {}
	Object.defineProperty(window.HTMLImageElement.prototype, 'src', {
		set(v) {
			this.setAttribute('src', v)
			// Resolve full-resolution preloads on the next tick.
			if (this.onload) window.setTimeout(() => this.onload && this.onload(), 0)
		},
		get() { return this.getAttribute('src') || '' },
	})

	// Globals the extracted block closes over.
	const preamble = `
		var API = '';
		var _bulkJobId = 'job-1';
		var _bulkInspectSeq = 7;
		var _binsImgVer = 3;
		function escAttr(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }
	`
	// A stand-in for the Inspector's own document-level shortcut handler. It is
	// registered in the BUBBLE phase, exactly like the real one, so the tests can
	// prove the lightbox's capture-phase listener wins.
	// Concatenated into the SAME eval as the lightbox source, so it closes over
	// the block's `let` bindings (a separate window.eval could not reach them).
	const postamble = `
		window.__inspectorKeys = [];
		document.addEventListener('keydown', function (e) { window.__inspectorKeys.push(e.key); });
		window.__setSuppress = function (t) { _binsSuppressClickUntil = t; };
	`
	window.eval(preamble + LIGHTBOX_SRC + postamble)
	return { dom, window, doc: window.document }
}

const key = (window, k, target) => {
	const ev = new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })
	;(target || window.document.body).dispatchEvent(ev)
	return ev
}
const click = (window, el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
const tick = (window, ms = 5) => new Promise((r) => window.setTimeout(r, ms))
const tiles = (doc) => Array.from(doc.querySelectorAll('.bins-thumb'))
// jsdom arrays come from another realm, which deepStrictEqual rejects on
// prototype identity — copy into this realm before comparing.
const seenKeys = (window) => Array.from(window.__inspectorKeys)

group('Opening')

test('clicking a tile opens the viewer on that photo', async () => {
	const { window, doc } = makeEnv(4)
	click(window, tiles(doc)[2])
	await tick(window)
	assert.ok(doc.querySelector('.binlb'), 'no lightbox rendered')
	assert.strictEqual(doc.getElementById('binlbCount').textContent, '3 / 4')
	assert.strictEqual(doc.getElementById('binlbName').textContent, 'photo-3.jpg')
})

test('Enter and Space on a focused tile open it', async () => {
	for (const k of ['Enter', ' ']) {
		const { window, doc } = makeEnv(3)
		const tile = tiles(doc)[1]
		window.bulkThumbKey({ key: k, preventDefault() {}, target: tile }, tile)
		await tick(window)
		assert.ok(doc.querySelector('.binlb'), `${k} did not open the viewer`)
	}
})

test('the THUMBNAIL badge shows only on photo 1', async () => {
	const { window, doc } = makeEnv(3)
	click(window, tiles(doc)[0])
	await tick(window)
	assert.strictEqual(doc.getElementById('binlbFirst').style.display, '')
	click(window, doc.getElementById('binlbNext'))
	await tick(window)
	assert.strictEqual(doc.getElementById('binlbFirst').style.display, 'none')
})

test('clicking the remove button never opens the viewer', async () => {
	const { window, doc } = makeEnv(3)
	click(window, tiles(doc)[1].querySelector('.bins-thumb-del'))
	await tick(window)
	assert.strictEqual(doc.querySelector('.binlb'), null, 'delete click opened the lightbox')
})

test('finishing a drag-reorder does not open the viewer', async () => {
	const { window, doc } = makeEnv(4)
	// Mirrors what bulkImgDragEnd() does when a reorder completes.
	window.__setSuppress(Date.now() + 300)
	click(window, tiles(doc)[1])
	await tick(window)
	assert.strictEqual(doc.querySelector('.binlb'), null, 'a reorder was mistaken for a click')
})

test('the suppression window expires so later clicks still work', async () => {
	const { window, doc } = makeEnv(4)
	window.__setSuppress(Date.now() - 1)
	click(window, tiles(doc)[1])
	await tick(window)
	assert.ok(doc.querySelector('.binlb'), 'suppression leaked past its window')
})

test('works in read-only mode (no drag, no delete button)', async () => {
	const { window, doc } = makeEnv(3, { editable: false })
	click(window, tiles(doc)[0])
	await tick(window)
	assert.ok(doc.querySelector('.binlb'))
})

group('Navigation')

test('arrow keys move through the photos', async () => {
	const { window, doc } = makeEnv(4)
	click(window, tiles(doc)[0])
	await tick(window)
	key(window, 'ArrowRight')
	assert.strictEqual(doc.getElementById('binlbCount').textContent, '2 / 4')
	key(window, 'ArrowRight')
	assert.strictEqual(doc.getElementById('binlbCount').textContent, '3 / 4')
	key(window, 'ArrowLeft')
	assert.strictEqual(doc.getElementById('binlbCount').textContent, '2 / 4')
})

test('navigation stops at both ends instead of wrapping or crashing', async () => {
	const { window, doc } = makeEnv(3)
	click(window, tiles(doc)[0])
	await tick(window)
	for (let i = 0; i < 5; i++) key(window, 'ArrowLeft')
	assert.strictEqual(doc.getElementById('binlbCount').textContent, '1 / 3')
	assert.strictEqual(doc.getElementById('binlbPrev').disabled, true)
	for (let i = 0; i < 9; i++) key(window, 'ArrowRight')
	assert.strictEqual(doc.getElementById('binlbCount').textContent, '3 / 3')
	assert.strictEqual(doc.getElementById('binlbNext').disabled, true)
})

test('Home and End jump to the first and last photo', async () => {
	const { window, doc } = makeEnv(6)
	click(window, tiles(doc)[2])
	await tick(window)
	key(window, 'End')
	assert.strictEqual(doc.getElementById('binlbCount').textContent, '6 / 6')
	key(window, 'Home')
	assert.strictEqual(doc.getElementById('binlbCount').textContent, '1 / 6')
})

test('the filmstrip selects the current photo and jumps on click', async () => {
	const { window, doc } = makeEnv(5)
	click(window, tiles(doc)[0])
	await tick(window)
	const strip = () => Array.from(doc.querySelectorAll('#binlbStrip img'))
	assert.strictEqual(strip().length, 5)
	assert.ok(strip()[0].classList.contains('sel'))
	click(window, strip()[3])
	await tick(window)
	assert.strictEqual(doc.getElementById('binlbCount').textContent, '4 / 5')
	assert.ok(strip()[3].classList.contains('sel'))
	assert.strictEqual(strip().filter((s) => s.classList.contains('sel')).length, 1)
})

test('a single-photo product has both arrows disabled', async () => {
	const { window, doc } = makeEnv(1)
	click(window, tiles(doc)[0])
	await tick(window)
	assert.strictEqual(doc.getElementById('binlbPrev').disabled, true)
	assert.strictEqual(doc.getElementById('binlbNext').disabled, true)
})

group('Key ownership vs the Inspector')

test('Escape closes the lightbox and is hidden from the Inspector', async () => {
	const { window, doc } = makeEnv(3)
	click(window, tiles(doc)[0])
	await tick(window)
	window.__inspectorKeys.length = 0
	key(window, 'Escape')
	await tick(window, 200)
	assert.strictEqual(doc.querySelector('.binlb'), null, 'lightbox did not close')
	assert.deepStrictEqual(seenKeys(window), [], 'Escape leaked through — the Inspector would close too')
})

test('arrow keys never reach the Inspector while the viewer is open', async () => {
	const { window, doc } = makeEnv(4)
	click(window, tiles(doc)[0])
	await tick(window)
	window.__inspectorKeys.length = 0
	key(window, 'ArrowRight')
	key(window, 'ArrowLeft')
	assert.deepStrictEqual(seenKeys(window), [], 'the Inspector would have changed product')
})

test('unrelated keys still reach the Inspector', async () => {
	const { window, doc } = makeEnv(3)
	click(window, tiles(doc)[0])
	await tick(window)
	window.__inspectorKeys.length = 0
	key(window, 'r')
	assert.deepStrictEqual(seenKeys(window), ['r'])
})

test('once closed, keys go back to the Inspector', async () => {
	const { window, doc } = makeEnv(3)
	click(window, tiles(doc)[0])
	await tick(window)
	key(window, 'Escape')
	await tick(window, 200)
	window.__inspectorKeys.length = 0
	key(window, 'ArrowRight')
	assert.deepStrictEqual(seenKeys(window), ['ArrowRight'], 'the listener was not detached')
})

test('typing in a field is never hijacked', async () => {
	const { window, doc } = makeEnv(3)
	click(window, tiles(doc)[0])
	await tick(window)
	const input = doc.createElement('input')
	doc.body.appendChild(input)
	input.focus()
	const ev = key(window, 'ArrowRight', input)
	assert.strictEqual(ev.defaultPrevented, false, 'the viewer swallowed a keystroke meant for an input')
	assert.strictEqual(doc.getElementById('binlbCount').textContent, '1 / 3', 'and it navigated anyway')
})

test('Space activates a focused button rather than zooming', async () => {
	const { window, doc } = makeEnv(3)
	click(window, tiles(doc)[0])
	await tick(window)
	doc.getElementById('binlbClose').focus()
	const ev = key(window, ' ', doc.getElementById('binlbClose'))
	assert.strictEqual(ev.defaultPrevented, false, 'Space was stolen from the Close button')
})

group('Zoom')

test('zoom toggles the stage state and the button label', async () => {
	const { window, doc } = makeEnv(3)
	click(window, tiles(doc)[0])
	await tick(window)
	const stage = doc.getElementById('binlbStage')
	const btn = doc.getElementById('binlbZoom')
	assert.strictEqual(stage.classList.contains('zoomed'), false)
	click(window, btn)
	assert.strictEqual(stage.classList.contains('zoomed'), true)
	assert.strictEqual(btn.textContent, 'Fit to screen')
	click(window, btn)
	assert.strictEqual(stage.classList.contains('zoomed'), false)
	assert.strictEqual(btn.textContent, 'Zoom 100%')
})

test('Escape unzooms first and only then closes', async () => {
	const { window, doc } = makeEnv(3)
	click(window, tiles(doc)[0])
	await tick(window)
	click(window, doc.getElementById('binlbZoom'))
	key(window, 'Escape')
	assert.ok(doc.querySelector('.binlb'), 'closed while still zoomed — the zoom state was lost')
	assert.strictEqual(doc.getElementById('binlbStage').classList.contains('zoomed'), false)
	key(window, 'Escape')
	await tick(window, 200)
	assert.strictEqual(doc.querySelector('.binlb'), null)
})

test('changing photo always lands on a fit view', async () => {
	const { window, doc } = makeEnv(3)
	click(window, tiles(doc)[0])
	await tick(window)
	click(window, doc.getElementById('binlbZoom'))
	assert.strictEqual(doc.getElementById('binlbStage').classList.contains('zoomed'), true)
	key(window, 'ArrowRight')
	assert.strictEqual(doc.getElementById('binlbStage').classList.contains('zoomed'), false, 'stayed zoomed on the next photo')
	assert.strictEqual(doc.getElementById('binlbZoom').textContent, 'Zoom 100%')
})

group('Closing and cleanup')

test('the close button and backdrop both dismiss', async () => {
	for (const pick of ['binlbClose', 'binlbStage']) {
		const { window, doc } = makeEnv(3)
		click(window, tiles(doc)[0])
		await tick(window)
		click(window, doc.getElementById(pick))
		await tick(window, 200)
		assert.strictEqual(doc.querySelector('.binlb'), null, `${pick} did not close the viewer`)
	}
})

test('clicking the image itself does not close it', async () => {
	const { window, doc } = makeEnv(3)
	click(window, tiles(doc)[0])
	await tick(window)
	click(window, doc.getElementById('binlbImg'))
	await tick(window, 200)
	assert.ok(doc.querySelector('.binlb'), 'clicking the photo closed the viewer')
})

test('page scrolling is locked while open and restored after', async () => {
	const { window, doc } = makeEnv(3)
	doc.body.style.overflow = 'auto'
	click(window, tiles(doc)[0])
	await tick(window)
	assert.strictEqual(doc.body.style.overflow, 'hidden')
	key(window, 'Escape')
	await tick(window, 200)
	assert.strictEqual(doc.body.style.overflow, 'auto', 'the page was left unscrollable')
})

test('focus returns to the tile that opened it', async () => {
	const { window, doc } = makeEnv(4)
	const tile = tiles(doc)[2]
	tile.focus()
	click(window, tile)
	await tick(window, 60)
	assert.notStrictEqual(doc.activeElement, tile, 'focus should move into the dialog')
	key(window, 'Escape')
	await tick(window, 200)
	assert.strictEqual(doc.activeElement, tile, 'focus was not restored to the gallery')
})

test('closing twice is harmless', async () => {
	const { window, doc } = makeEnv(3)
	click(window, tiles(doc)[0])
	await tick(window)
	assert.doesNotThrow(() => {
		window.bulkLightboxClose()
		window.bulkLightboxClose()
	})
})

test('opening while already open leaves exactly one viewer', async () => {
	const { window, doc } = makeEnv(4)
	click(window, tiles(doc)[0])
	await tick(window)
	click(window, tiles(doc)[2])
	await tick(window, 250)
	assert.strictEqual(doc.querySelectorAll('.binlb').length, 1, 'stacked duplicate viewers')
})

test('keys after close do not throw', async () => {
	const { window, doc } = makeEnv(3)
	click(window, tiles(doc)[0])
	await tick(window)
	window.bulkLightboxClose()
	assert.doesNotThrow(() => {
		key(window, 'ArrowRight')
		key(window, 'Escape')
	})
})

group('Image sources')

test('the stage requests full bytes while tiles stay thumbnails', async () => {
	const { window, doc } = makeEnv(3)
	click(window, tiles(doc)[1])
	await tick(window, 30)
	const src = doc.getElementById('binlbImg').getAttribute('src')
	assert.ok(!/[?&]w=/.test(src), `expected the original, got ${src}`)
	assert.ok(src.includes('/image/2'), `wrong rank in ${src}`)
	assert.ok(doc.querySelector('#binlbStrip img').getAttribute('src').includes('w=240'), 'filmstrip should reuse cached thumbnails')
})

test('the cached tile paints first, then the full image swaps in', async () => {
	const { window, doc } = makeEnv(3)
	click(window, tiles(doc)[0])
	const img = doc.getElementById('binlbImg')
	// Synchronously after open, before the preload resolves.
	assert.ok(img.getAttribute('src').includes('w=240'), 'no instant placeholder')
	assert.ok(img.classList.contains('preview'))
	await tick(window, 30)
	assert.ok(!img.getAttribute('src').includes('w=240'), 'never upgraded to full resolution')
	assert.strictEqual(img.classList.contains('preview'), false)
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
	console.log()
	if (failed) {
		console.log(`${RED}${BOLD}  ${failed} test(s) failed${RESET}, ${passed} passed`)
		for (const f of failures) console.log(`${DIM}  · ${f.name}: ${f.err.message}${RESET}`)
		process.exit(1)
	}
	console.log(`${GREEN}${BOLD}  All ${passed} tests passed.${RESET}`)
	console.log()
})()
