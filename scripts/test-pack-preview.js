'use strict'
/**
 * Behavioural tests for the packing-bench pack preview.
 *
 * Packing Mode takes the Etsy title off the order row on purpose: it is SEO
 * copy that names five phone models for a one-model order, sitting in the most
 * prominent position on the bench. That is only safe because the photo becomes
 * a button and the title is one tap away instead of gone. These tests pin the
 * behaviours that make the trade honest, and the ones that are easy to break by
 * accident:
 *
 *   · A packer tapping a photo must NOT be navigated off to etsy.com, and must
 *     not land in the owner-only design-switch modal on a switched line.
 *   · An OWNER must still get the Etsy link — this is presentation, not a
 *     capability change, and the dense list has to stay untouched.
 *   · The facts panel must mirror the row it came from (it is a clone, so a
 *     model correction can never disagree), and must not carry the interactive
 *     purchase chips across.
 *   · The full title must be reachable, or hiding it on the row loses data.
 *   · Escape must close the preview, NOT the 4PX drawer behind it.
 *   · A full-resolution variant that does not exist must degrade to the photo
 *     already on screen, never to a broken image.
 *
 * The UI ships as one large inline <script>, so the harness extracts just the
 * pack-preview block from public/index.html and runs the real shipped source
 * against jsdom rather than a copy of it.
 */

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { JSDOM, VirtualConsole } = require('jsdom')

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m'
let passed = 0, failed = 0
const failures = []
const pending = []
function group(name) { pending.push({ group: name }) }
function test(name, fn) { pending.push({ name, fn }) }

// ── Extract the pack-preview source straight out of the shipped page ─────────
const HTML = path.resolve(__dirname, '../public/index.html')
const source = fs.readFileSync(HTML, 'utf8')
const START = '// ══ PACK PREVIEW ══'
const END = '// ══ END PACK PREVIEW ══'
const a = source.indexOf(START)
const b = source.indexOf(END)
if (a < 0 || b < 0 || b <= a) {
	console.error(`${RED}Could not locate the pack-preview sentinels in public/index.html.${RESET}`)
	console.error(`${DIM}Expected "${START}" … "${END}".${RESET}`)
	process.exit(1)
}
const PREVIEW_SRC = source.slice(a, b)

// A 570px Etsy CDN url, the size the order rows actually request.
const ETSY_570 = 'https://i.etsystatic.com/12345678/r/il/abc123/4567890123/il_570xN.4567890123_qwer.jpg'
const ETSY_570_B = 'https://i.etsystatic.com/12345678/r/il/def456/9999999999/il_570xN.9999999999_asdf.jpg'
// An operator-uploaded variant photo, served from our own endpoint — already the
// original bytes, so there is no larger variant to ask for.
const LOCAL_IMG = '/api/route/style-image/7?v=1712345678'

const LONG_TITLE = 'Kawaii Cinnamoroll Case, Moon Grip, Star Beaded Charm, Blue Clear Anime Cover iPhone 17 16 15 14 13 Pro Max, Y2K Coquette Gift'

/** The meta block renderOrders() emits for a line, including the row modifiers. */
function metaBlock({ qty = '1', model = 'iPhone 17', style = 'Case+Grip+Charm' } = {}) {
	return `<div class="product-meta">
		<div class="product-meta-row"><span class="product-meta-label">Quantity</span><span class="product-meta-value product-meta-qty">${qty}</span></div>
		<div class="product-meta-row product-meta-row--model"><span class="product-meta-label">Phone model</span><span class="product-meta-value">${model}</span></div>
		<div class="product-meta-row product-meta-row--style"><span class="product-meta-label">Style</span><span class="product-meta-value">${style}</span></div>
	</div>`
}

/**
 * A document shaped like the surfaces the preview launches from, with the block
 * loaded. Mirrors the markup renderOrders() and _fbxRenderRows() emit — inline
 * handlers included — so a rename that breaks the wiring fails these tests.
 */
function makeEnv({ packer = true } = {}) {
	const ordersRow = `
	<div id="tab-orders">
		<table><tbody id="ordersBody">
			<tr class="order-row">
				<td>
					<div class="product-cell">
						<div class="pack-count-chip packer-only">3 products</div>

						<!-- 1. A line we hold no listing id for: nothing to navigate to,
						     so the photo is a button that opens the preview — and the
						     fixture the preview tests below open. -->
						<div class="product-item" id="itemPlain">
							<div class="product-thumb" role="button" tabindex="0" title="Check against the item in hand"><img src="${ETSY_570}" alt="" loading="lazy"></div>
							<div class="product-info">
								<div class="product-title"><span class="product-title-text">${LONG_TITLE}</span></div>
								${metaBlock()}
								<div class="pp-comps"><button class="item-pp item-pp-bought" onclick="window.__chipFired = true">✓ Bought</button></div>
							</div>
						</div>

						<!-- 1b. The ordinary line: the thumb is an anchor to the Etsy
						     listing, which the bench now follows rather than intercepts. -->
						<div class="product-item" id="itemLinked">
							<a href="https://www.etsy.com/listing/1234567890" target="_blank" class="product-thumb" title="View on Etsy"><img src="${ETSY_570}" alt="" loading="lazy"></a>
							<div class="product-info">
								<div class="product-title"><span class="product-title-text">${LONG_TITLE}</span></div>
								${metaBlock()}
							</div>
						</div>

						<!-- 2. A switched line: a div carrying an OWNER-only onclick. -->
						<div class="product-item" id="itemSwitched">
							<div class="product-thumb product-thumb-switched" role="button" tabindex="0" title="Switched design — click to change or revert" onclick="window.__switchModal = true"><img src="${ETSY_570_B}" alt=""></div>
							<div class="product-info">
								<div class="product-title"><span class="product-title-text">Blue Holographic Fish Case</span> <span class="switched-badge" title="Buyer agreed to switch.">🔄 Switched</span></div>
								<div class="switched-from" title="Originally ordered">was: Original Sanrio Cinnamoroll Case</div>
								${metaBlock({ qty: '2', model: 'iPhone 15 Pro', style: 'Case Only' })}
							</div>
						</div>

						<!-- 3. A line whose photo failed to load / was never cached. -->
						<div class="product-item" id="itemNoImg">
							<div class="product-thumb">🛍️</div>
							<div class="product-info">
								<div class="product-title"><span class="product-title-text">No photo product</span></div>
								${metaBlock({ model: 'iPhone 13' })}
							</div>
						</div>
					</div>
				</td>
			</tr>
		</tbody></table>
	</div>`

	// The 4PX ship drawer: a single-product order row, and a multi-product one.
	const fbxRows = `
	<div id="fbxRows">
		<div class="fbx-row" id="fbxSingle">
			<img class="fbx-row-thumb" src="${ETSY_570}" alt="">
			<div class="fbx-row-main">
				<div class="fbx-row-name">Nathan James</div>
				<div class="fbx-row-title">${LONG_TITLE}</div>
				<div class="fbx-row-chips"><span class="fbx-chip qty">Qty 2</span><span class="fbx-chip style"><b>Style:</b> Case + Charm</span></div>
			</div>
		</div>
		<div class="fbx-row" id="fbxMulti">
			<img class="fbx-row-thumb" src="${ETSY_570_B}" alt="">
			<div class="fbx-row-main">
				<div class="fbx-row-products">
					<div class="fbx-prod-item" id="fbxProd">
						<img class="fbx-prod-thumb" src="${LOCAL_IMG}" alt="">
						<div class="fbx-prod-main">
							<div class="fbx-prod-title">Cinnamoroll Clear AirPods Case with Charm</div>
							<div class="fbx-prod-chips"><span class="fbx-chip qty">×2</span><span class="fbx-chip style"><b>Style:</b> Case + Charm</span></div>
						</div>
					</div>
				</div>
			</div>
		</div>
	</div>`

	// The owner-mode and modified-click tests assert that the Etsy anchor IS
	// followed, which jsdom reports as an unimplemented navigation. That line is
	// the proof those tests wanted, so it is dropped rather than printed;
	// everything else a page might log still reaches the terminal.
	const virtualConsole = new VirtualConsole()
	virtualConsole.forwardTo({
		...console,
		error: (...args) => {
			if (!/Not implemented: navigation/.test(String(args[0]))) console.error(...args)
		},
	})

	const dom = new JSDOM(
		`<!doctype html><html><body class="${packer ? 'mode-packer' : ''}">${ordersRow}${fbxRows}</body></html>`,
		// 'dangerously' compiles the inline on* attributes; the fixture contains no
		// <script> tags, so nothing else executes.
		{ pretendToBeVisual: true, runScripts: 'dangerously', virtualConsole },
	)
	const { window } = dom

	// jsdom implements neither layout nor image loading. Stub the little the
	// block touches so it runs unmodified. `__imgLoads = false` simulates an
	// il_fullxfull variant that does not exist: the preload never resolves.
	window.requestAnimationFrame = (fn) => window.setTimeout(fn, 0)
	window.__imgLoads = true
	Object.defineProperty(window.HTMLImageElement.prototype, 'src', {
		set(v) {
			this.setAttribute('src', v)
			if (this.onload && window.__imgLoads !== false) window.setTimeout(() => this.onload && this.onload(), 0)
		},
		get() { return this.getAttribute('src') || '' },
	})
	// The extracted block normally shares these helpers with the rest of the
	// dashboard script. Supply faithful stand-ins so the real pack-preview/charm
	// renderer can be exercised in isolation.
	window.escHtml = (value) => String(value == null ? '' : value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
	window.escAttr = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
	window.charmImageUrl = (code, version) => `/api/route/charm-image?code=${encodeURIComponent(code)}&v=${encodeURIComponent(version || 'session')}`

	// A stand-in for a handler behind the preview (the 4PX drawer binds Escape on
	// document in the BUBBLE phase), so the tests can prove capture wins.
	const postamble = `
		window.__behindKeys = [];
		document.addEventListener('keydown', function (e) { window.__behindKeys.push(e.key); });
	`
	window.eval(PREVIEW_SRC + postamble)
	return { dom, window, doc: window.document }
}

const clickOn = (window, el, init = {}) => {
	const ev = new window.MouseEvent('click', { bubbles: true, cancelable: true, ...init })
	el.dispatchEvent(ev)
	return ev
}
const key = (window, k, target) => {
	const ev = new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })
	;(target || window.document.body).dispatchEvent(ev)
	return ev
}
const tick = (window, ms = 5) => new Promise((r) => window.setTimeout(r, ms))
const pv = (doc) => doc.querySelector('.packpv')
const seenBehind = (window) => Array.from(window.__behindKeys)
const CHARM_TX = {
	quantity: 2,
	charm_integral: false,
	components: [{
		comp: 'charm',
		label: 'Charm',
		status: 'Purchased',
		charm_code: 'CH-00042',
		charm_image_version: 'm42-a',
		has_charm_image: true,
	}],
}

/** Render the shipped charm-card template into one fixture product. */
function addCharmCard(window, doc, tx = CHARM_TX, { item = '#itemPlain', compact = false } = {}) {
	const host = doc.querySelector(item)
	host.insertAdjacentHTML('beforeend', window._packCharmPreviewHtml(tx, compact))
	return host.querySelector('.pack-charm-card')
}

group('Owning the tap on the bench')

test('tapping a linked photo goes to the Etsy listing, not the preview', async () => {
	const { window, doc } = makeEnv()
	const thumb = doc.querySelector('#itemLinked .product-thumb')
	const ev = clickOn(window, thumb.querySelector('img'))
	await tick(window)
	assert.strictEqual(pv(doc), null, 'the preview swallowed a tap meant for the listing')
	assert.strictEqual(ev.defaultPrevented, false, 'the anchor was cancelled — the packer never reaches Etsy')
	// Followed natively rather than reproduced, so there is no second copy of
	// the url, and the queue keeps its scroll position and its selection.
	assert.strictEqual(thumb.getAttribute('target'), '_blank', 'the listing would replace the queue instead of opening beside it')
})

test('a photo with no listing behind it still enlarges', async () => {
	const { window, doc } = makeEnv()
	const ev = clickOn(window, doc.querySelector('#itemPlain .product-thumb img'))
	await tick(window)
	assert.ok(pv(doc), 'a photo with nowhere to link lost its only way to be seen bigger')
	assert.strictEqual(ev.defaultPrevented, true)
})

test('a switched line never opens the owner-only design-switch modal', async () => {
	const { window, doc } = makeEnv()
	window.__switchModal = false
	clickOn(window, doc.querySelector('#itemSwitched .product-thumb'))
	await tick(window)
	assert.ok(pv(doc), 'no preview rendered')
	assert.strictEqual(window.__switchModal, false, 'the packer landed in a modal their session cannot submit')
})

test('Enter on a focused switched thumb opens it too', async () => {
	const { window, doc } = makeEnv()
	const thumb = doc.querySelector('#itemSwitched .product-thumb')
	thumb.focus()
	const ev = key(window, 'Enter', thumb)
	await tick(window)
	assert.ok(pv(doc), 'role="button" was a lie — no keyboard activation')
	assert.strictEqual(ev.defaultPrevented, true)
})

test('the owner keeps the Etsy link — nothing about the dense list changes', async () => {
	const { window, doc } = makeEnv({ packer: false })
	const ev = clickOn(window, doc.querySelector('#itemLinked .product-thumb img'))
	await tick(window)
	assert.strictEqual(pv(doc), null, 'the preview hijacked the owner view')
	assert.strictEqual(ev.defaultPrevented, false, 'the owner lost their link to Etsy')
})

test('a deliberate open-in-new-tab (Ctrl / ⌘ / Shift) is let through', async () => {
	for (const mod of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey']) {
		const { window, doc } = makeEnv()
		const ev = clickOn(window, doc.querySelector('#itemLinked .product-thumb img'), { [mod]: true })
		await tick(window)
		assert.strictEqual(pv(doc), null, `${mod}+click was swallowed`)
		assert.strictEqual(ev.defaultPrevented, false, `${mod}+click did not reach the browser`)
	}
})

test('a placeholder thumb with no photo is not clickable', async () => {
	const { window, doc } = makeEnv()
	const ev = clickOn(window, doc.querySelector('#itemNoImg .product-thumb'))
	await tick(window)
	assert.strictEqual(pv(doc), null, 'opened a preview of nothing')
	assert.strictEqual(ev.defaultPrevented, false)
})

test('clicking a purchase chip is left alone', async () => {
	const { window, doc } = makeEnv()
	window.__chipFired = false
	clickOn(window, doc.querySelector('#itemPlain .item-pp'))
	await tick(window)
	assert.strictEqual(window.__chipFired, true, 'the capture listener ate an unrelated click')
	assert.strictEqual(pv(doc), null)
})

group('Inline charm reference')

test('an assigned loose charm renders its own photo, code and per-line quantity', () => {
	const { window, doc } = makeEnv()
	const card = addCharmCard(window, doc)
	assert.ok(card, 'the charm component produced no bench card')
	assert.ok(card.classList.contains('packer-only'), 'the card would leak into the owner list')
	assert.strictEqual(card.querySelector('.pack-charm-head'), null, 'the simplified image picked up its old label/header again')
	assert.strictEqual(card.querySelector('.pack-charm-code').textContent, 'CH-00042')
	assert.strictEqual(card.querySelector('.pack-charm-qty').textContent, '×2')
	assert.strictEqual(card.querySelector('img').getAttribute('src'), '/api/route/charm-image?code=CH-00042&v=m42-a')
	assert.strictEqual(card.querySelector('img').getAttribute('alt'), 'Charm CH-00042')
})

test('quantity one stays quiet; a multi-unit line gets the only charm count badge', () => {
	const { window, doc } = makeEnv()
	let card = addCharmCard(window, doc, { ...CHARM_TX, quantity: 1 })
	assert.strictEqual(card.querySelector('.pack-charm-qty'), null)
	card.remove()
	card = addCharmCard(window, doc, { ...CHARM_TX, quantity: '3' })
	assert.strictEqual(card.querySelector('.pack-charm-qty').textContent, '×3')
})

test('title text never invents a charm, and integral AirPods charms stay with the case', () => {
	const { window } = makeEnv()
	assert.strictEqual(
		window._packCharmPreviewHtml({ title: 'SEO title says charm', components: [{ comp: 'case' }] }),
		'',
		'client-side title guessing created a false charm',
	)
	assert.strictEqual(
		window._packCharmPreviewHtml({ ...CHARM_TX, charm_integral: true }),
		'',
		'an attached AirPods charm was presented as a second loose piece',
	)
})

test('missing assignment data is explicit instead of looking like no charm is required', () => {
	const { window, doc } = makeEnv()
	let card = addCharmCard(window, doc, {
		quantity: 1,
		components: [{ comp: 'charm', charm_code: '', has_charm_image: false }],
	})
	assert.ok(card.classList.contains('pack-charm-card--missing'))
	assert.ok(card.textContent.includes('Charm not assigned'))

	card.remove()
	card = addCharmCard(window, doc, {
		quantity: 1,
		components: [{ comp: 'charm', charm_code: 'CH-00077', has_charm_image: false }],
	})
	assert.ok(card.textContent.includes('Photo unavailable'))
	assert.ok(card.textContent.includes('CH-00077'), 'the known code disappeared with its missing photo')
	assert.strictEqual(card.querySelector('img'), null, 'a known-missing file was rendered as a broken image')
})

test('a stale image response degrades locally and keeps the charm identity visible', () => {
	const { window, doc } = makeEnv()
	const card = addCharmCard(window, doc)
	window._packCharmImageError(card.querySelector('img'))
	assert.strictEqual(card.querySelector('.pack-charm-thumb'), null)
	assert.ok(card.querySelector('.pack-charm-missing').textContent.includes('Photo unavailable'))
	assert.strictEqual(card.querySelector('.pack-charm-code').textContent, 'CH-00042')
	assert.ok(card.classList.contains('pack-charm-card--missing'))
})

test('dynamic charm values are encoded as data, never executable markup', () => {
	const { window, doc } = makeEnv()
	const hostile = `CH-"><img src=x onerror="window.__charmPwned=1">`
	window.__charmPwned = 0
	const card = addCharmCard(window, doc, {
		...CHARM_TX,
		components: [{ ...CHARM_TX.components[0], charm_code: hostile }],
	})
	assert.strictEqual(card.querySelector('.pack-charm-code').textContent, hostile)
	assert.strictEqual(card.querySelectorAll('img').length, 1)
	assert.strictEqual(window.__charmPwned, 0)
	assert.ok(card.querySelector('img').getAttribute('src').includes(encodeURIComponent(hostile)))
})

test('the compact 4PX variant uses the same assignment contract', () => {
	const { window, doc } = makeEnv()
	const card = addCharmCard(window, doc, CHARM_TX, { item: '#fbxProd', compact: true })
	assert.ok(card.classList.contains('pack-charm-card--compact'))
	assert.strictEqual(card.querySelector('.pack-charm-code').textContent, 'CH-00042')
})

test('tapping the charm enlarges it locally without an Etsy navigation', async () => {
	const { window, doc } = makeEnv()
	const card = addCharmCard(window, doc)
	const ev = clickOn(window, card.querySelector('img'))
	await tick(window)
	assert.strictEqual(ev.defaultPrevented, true)
	assert.ok(pv(doc), 'the charm image did not open the local preview')
	assert.strictEqual(doc.getElementById('packpvImg').getAttribute('src'), '/api/route/charm-image?code=CH-00042&v=m42-a')
	assert.strictEqual(doc.getElementById('packpvEyebrow').textContent, 'Charm to pack')
	assert.strictEqual(doc.getElementById('packpvTitle').textContent, 'CH-00042')
	assert.strictEqual(pv(doc).getAttribute('aria-label'), 'Charm photo — check it before sealing')
	assert.strictEqual(doc.querySelector('.packpv a[href]'), null)
})

test('owner mode does not activate the charm preview', async () => {
	const { window, doc } = makeEnv({ packer: false })
	const card = addCharmCard(window, doc)
	const ev = clickOn(window, card.querySelector('img'))
	await tick(window)
	assert.strictEqual(pv(doc), null)
	assert.strictEqual(ev.defaultPrevented, false)
})

group('The facts panel mirrors its row')

test('the meta block is cloned verbatim, model modifier included', async () => {
	const { window, doc } = makeEnv()
	clickOn(window, doc.querySelector('#itemPlain .product-thumb img'))
	await tick(window)
	const rows = doc.querySelectorAll('.packpv-meta .product-meta-row')
	assert.strictEqual(rows.length, 3, 'the facts drifted from the row')
	assert.strictEqual(doc.querySelector('.packpv-meta .product-meta-row--model .product-meta-value').textContent, 'iPhone 17')
	assert.strictEqual(doc.querySelector('.packpv-meta .product-meta-row--style .product-meta-value').textContent, 'Case+Grip+Charm')
})

test('each photo brings its OWN line’s facts, not the first line’s', async () => {
	const { window, doc } = makeEnv()
	clickOn(window, doc.querySelector('#itemSwitched .product-thumb'))
	await tick(window)
	assert.strictEqual(doc.querySelector('.packpv-meta .product-meta-row--model .product-meta-value').textContent, 'iPhone 15 Pro')
})

test('the interactive purchase chips are deliberately left behind', async () => {
	const { window, doc } = makeEnv()
	clickOn(window, doc.querySelector('#itemPlain .product-thumb img'))
	await tick(window)
	assert.strictEqual(doc.querySelector('.packpv .item-pp'), null, 'a live chip was cloned into a look-only surface')
	assert.strictEqual(doc.querySelector('.packpv .pp-comps'), null)
})

test('the full title the row hides is available here', async () => {
	const { window, doc } = makeEnv()
	clickOn(window, doc.querySelector('#itemPlain .product-thumb img'))
	await tick(window)
	assert.strictEqual(doc.getElementById('packpvTitle').textContent, LONG_TITLE, 'hiding the title on the row lost it entirely')
})

test('a switched line stays recognisable as switched, and names what it replaced', async () => {
	const { window, doc } = makeEnv()
	clickOn(window, doc.querySelector('#itemSwitched .product-thumb'))
	await tick(window)
	assert.ok(doc.querySelector('#packpvEyebrow .switched-badge'), 'the 🔄 Switched badge did not come across')
	assert.strictEqual(doc.querySelector('.packpv-was').textContent, 'was: Original Sanrio Cinnamoroll Case')
})

test('the preview offers no Etsy link, because it only opens where there is none', async () => {
	// A photo with a listing behind it now goes there on tap, so by construction
	// nothing that reaches this surface has a listing to offer. The link that
	// used to live here could only ever have rendered hidden.
	for (const sel of ['#itemPlain .product-thumb img', '#itemSwitched .product-thumb']) {
		const { window, doc } = makeEnv()
		clickOn(window, doc.querySelector(sel))
		await tick(window)
		assert.ok(pv(doc), `${sel} did not open`)
		assert.strictEqual(doc.querySelector('.packpv a[href]'), null, 'a dead link came back to the preview')
	}
})

group('The 4PX ship drawer')

test('the single-product row photo opens with its own chips', async () => {
	const { window, doc } = makeEnv()
	clickOn(window, doc.querySelector('#fbxSingle .fbx-row-thumb'))
	await tick(window)
	assert.ok(pv(doc), 'the last look before a label prints is not clickable')
	assert.strictEqual(doc.querySelectorAll('.packpv-meta .fbx-chip').length, 2)
	assert.strictEqual(doc.getElementById('packpvTitle').textContent, LONG_TITLE)
})

test('a per-product photo wins over the order row photo around it', async () => {
	const { window, doc } = makeEnv()
	clickOn(window, doc.querySelector('#fbxProd .fbx-prod-thumb'))
	await tick(window)
	assert.strictEqual(doc.getElementById('packpvImg').getAttribute('src'), LOCAL_IMG, 'showed the row photo instead of the product tapped')
	assert.strictEqual(doc.getElementById('packpvTitle').textContent, 'Cinnamoroll Clear AirPods Case with Charm')
})

group('Image sources')

test('the row photo paints first, then the full-resolution file swaps in', async () => {
	const { window, doc } = makeEnv()
	clickOn(window, doc.querySelector('#itemPlain .product-thumb img'))
	const img = doc.getElementById('packpvImg')
	// Synchronously after open, before the preload resolves.
	assert.strictEqual(img.getAttribute('src'), ETSY_570, 'no instant placeholder — the stage would flash empty')
	await tick(window, 30)
	assert.ok(img.getAttribute('src').includes('il_fullxfull'), `never upgraded: ${img.getAttribute('src')}`)
})

test('a full-resolution variant that does not exist degrades to the row photo', async () => {
	const { window, doc } = makeEnv()
	window.__imgLoads = false
	clickOn(window, doc.querySelector('#itemPlain .product-thumb img'))
	await tick(window, 30)
	assert.strictEqual(doc.getElementById('packpvImg').getAttribute('src'), ETSY_570, 'left the packer looking at a broken image')
})

test('a non-Etsy url is never rewritten — it is already the original', async () => {
	const { window, doc } = makeEnv()
	assert.strictEqual(window._packPreviewFullSrc(LOCAL_IMG), '')
	assert.strictEqual(window._packPreviewFullSrc(''), '')
	assert.ok(window._packPreviewFullSrc(ETSY_570).includes('il_fullxfull'))
	clickOn(window, doc.querySelector('#fbxProd .fbx-prod-thumb'))
	await tick(window, 30)
	assert.strictEqual(doc.getElementById('packpvImg').getAttribute('src'), LOCAL_IMG)
})

test('a slow full-resolution load never lands on a preview opened after it', async () => {
	const { window, doc } = makeEnv()
	clickOn(window, doc.querySelector('#itemPlain .product-thumb img'))
	clickOn(window, doc.querySelector('#itemSwitched .product-thumb'))
	await tick(window, 60)
	assert.ok(doc.getElementById('packpvImg').getAttribute('src').includes('9999999999'), 'the first photo overwrote the second')
})

group('Dismissal and cleanup')

test('Escape closes the preview and is hidden from whatever is behind it', async () => {
	const { window, doc } = makeEnv()
	clickOn(window, doc.querySelector('#itemPlain .product-thumb img'))
	await tick(window)
	window.__behindKeys.length = 0
	key(window, 'Escape')
	await tick(window, 200)
	assert.strictEqual(pv(doc), null, 'the preview did not close')
	assert.deepStrictEqual(seenBehind(window), [], 'Escape leaked — the 4PX drawer would have closed too')
})

test('unrelated keys still reach what is behind', async () => {
	const { window, doc } = makeEnv()
	clickOn(window, doc.querySelector('#itemPlain .product-thumb img'))
	await tick(window)
	window.__behindKeys.length = 0
	key(window, 'ArrowRight')
	assert.deepStrictEqual(seenBehind(window), ['ArrowRight'])
})

test('typing in a field is never hijacked', async () => {
	const { window, doc } = makeEnv()
	clickOn(window, doc.querySelector('#itemPlain .product-thumb img'))
	await tick(window)
	const input = doc.createElement('input')
	doc.body.appendChild(input)
	input.focus()
	const ev = key(window, 'Escape', input)
	assert.strictEqual(ev.defaultPrevented, false, 'a keystroke meant for an input was swallowed')
	assert.ok(pv(doc), 'and it closed anyway')
})

test('the backdrop dismisses but the card itself does not', async () => {
	const { window, doc } = makeEnv()
	clickOn(window, doc.querySelector('#itemPlain .product-thumb img'))
	await tick(window)
	clickOn(window, doc.getElementById('packpvImg'))
	await tick(window, 200)
	assert.ok(pv(doc), 'a mis-hit on the photo cost the preview')
	clickOn(window, pv(doc))
	await tick(window, 200)
	assert.strictEqual(pv(doc), null, 'the backdrop did not dismiss')
})

test('the close button dismisses', async () => {
	const { window, doc } = makeEnv()
	clickOn(window, doc.querySelector('#itemPlain .product-thumb img'))
	await tick(window)
	clickOn(window, doc.getElementById('packpvClose'))
	await tick(window, 200)
	assert.strictEqual(pv(doc), null)
})

test('page scrolling is locked while open and restored after', async () => {
	const { window, doc } = makeEnv()
	doc.body.style.overflow = 'auto'
	clickOn(window, doc.querySelector('#itemPlain .product-thumb img'))
	await tick(window)
	assert.strictEqual(doc.body.style.overflow, 'hidden')
	key(window, 'Escape')
	await tick(window, 200)
	assert.strictEqual(doc.body.style.overflow, 'auto', 'the queue was left unscrollable')
})

test('focus returns to the photo that opened it, so the queue keeps its place', async () => {
	const { window, doc } = makeEnv()
	const thumb = doc.querySelector('#itemPlain .product-thumb')
	thumb.focus()
	clickOn(window, thumb.querySelector('img'))
	await tick(window, 60)
	assert.notStrictEqual(doc.activeElement, thumb, 'focus should move into the dialog')
	key(window, 'Escape')
	await tick(window, 200)
	assert.strictEqual(doc.activeElement, thumb, 'focus was not restored to the queue')
})

test('opening while already open leaves exactly one preview', async () => {
	const { window, doc } = makeEnv()
	clickOn(window, doc.querySelector('#itemPlain .product-thumb img'))
	await tick(window)
	clickOn(window, doc.querySelector('#itemSwitched .product-thumb'))
	await tick(window, 250)
	assert.strictEqual(doc.querySelectorAll('.packpv').length, 1, 'stacked duplicate previews')
})

test('closing twice, and keys after close, are harmless', async () => {
	const { window, doc } = makeEnv()
	clickOn(window, doc.querySelector('#itemPlain .product-thumb img'))
	await tick(window)
	assert.doesNotThrow(() => {
		window.packPreviewClose()
		window.packPreviewClose()
		key(window, 'Escape')
	})
})

/* ── Shipped markup & CSS invariants ─────────────────────────────────────────
   Three of this feature's guarantees live in CSS and in the render template
   rather than in the block above, and jsdom cannot evaluate `:has()` reliably
   enough to assert them by computed style. They are checked against the shipped
   file instead, because each one has already been got wrong once:
     · hiding `.product-title` instead of `.product-title-text` also hides the
       🔄 Switched badge, so a substituted design silently reads as a normal
       line — this is the bug the wrapper span exists to prevent;
     · an unescaped Etsy title interpolated into the row is an injection point.
   ────────────────────────────────────────────────────────────────────────── */
group('Shipped markup & CSS invariants')

test('the bench hides the title TEXT, never the badge holder around it', () => {
	assert.ok(source.includes('body.mode-packer #tab-orders .product-title-text'), 'the packing layout no longer targets .product-title-text')
	assert.ok(!/body\.mode-packer #tab-orders \.product-title,/.test(source), 'the packing layout hides .product-title wholesale — the 🔄 Switched badge goes with it')
})

test('the mobile card does the same', () => {
	assert.ok(/#tab-orders \.order-row:not\(\.is-open\) \.product-title-text,\s*\n\s*#tab-orders \.order-row:not\(\.is-open\) \.switched-from/.test(source), 'the collapsed mobile card no longer targets .product-title-text')
})

test('every rendered title is escaped and wrapped', () => {
	assert.ok(source.includes(`<span class="product-title-text">${'${escHtml(tx.title'}`), 'the plain title is no longer escaped/wrapped')
	assert.ok(source.includes(`<span class="product-title-text">${'${escHtml(_sub.new_title)}'}</span>`), 'the switched title is no longer escaped/wrapped')
	assert.ok(!/class="product-title">\$\{tx\.title/.test(source), 'an unescaped Etsy title is interpolated into the row')
})

test('the model and style rows are tagged so the bench can rank them', () => {
	assert.ok(source.includes('product-meta-row--model'), 'the model row modifier is gone — the phone model loses its headline size')
	assert.ok(source.includes('product-meta-row--style'), 'the style row modifier is gone')
})

/* ── Thumbnail geometry ──────────────────────────────────────────────────────
   The bench enlarges the product photo and keeps `object-fit: contain`, so the
   SHAPE of the slot decides how much dead space every row carries. A square
   slot holding this catalogue letterboxed it by a quarter of its own width and
   painted the result, which is how the bench came to show two grey pillars on
   every line — the single most distracting thing in the row, and an artefact of
   the frame rather than of any product.

   That is a geometry bug, not a matter of taste, so it is asserted as geometry:
   the slot is reconstructed from the shipped custom properties and measured
   against the real corpus, rather than pattern-matched. Setting `--pack-ar` to
   1, or reverting the width to a second copy of the height, fails here with the
   number of grey pixels it would put back on screen.

   The bounds are the observed spread of `listing_images`: every photo is a
   portrait `il_570xN`, 570×751 … 570×780. Re-measure before touching them. */
const PHOTO_AR_MIN = 0.731
const PHOTO_AR_MAX = 0.759
// A seam this thin cannot be perceived, and the slot does not paint it anyway.
const MAX_LETTERBOX_PER_SIDE = 2

/** Every value declared for a custom property, in source order. */
function cssVarValues(name) {
	return [...source.matchAll(new RegExp(`--${name}\\s*:\\s*([^;]+);`, 'g'))].map((m) => m[1].trim())
}

/** The declaration block of a rule. Anchored to the start of the selector's own
 *  line, or `.product-thumb` would match the tail of the far more specific
 *  `body.mode-packer #tab-orders .product-thumb` and silently test that instead. */
function ruleBody(selector) {
	const lit = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	const m = new RegExp(`(?:^|\\n)[\\t ]*${lit} \\{`).exec(source)
	assert.ok(m, `the rule \`${selector}\` is gone`)
	const start = m.index + m[0].length
	return source.slice(start, source.indexOf('}', start))
}

group('Bench thumbnail geometry')

test('the slot is cut to the catalogue, so `contain` leaves no visible letterbox', () => {
	const ars = cssVarValues('pack-ar')
	assert.strictEqual(ars.length, 1, `--pack-ar should be declared exactly once, found ${ars.length}`)
	const ar = parseFloat(ars[0])
	assert.ok(ar > 0 && ar < 1, `--pack-ar is ${ars[0]} — the catalogue is portrait, so this must be below 1`)

	const heights = cssVarValues('pack-thumb-h').map(parseFloat)
	assert.ok(heights.length >= 1, '--pack-thumb-h is gone — the slot has no size knob')

	for (const slotH of heights) {
		const slotW = slotH * ar
		for (const photoAr of [PHOTO_AR_MIN, PHOTO_AR_MAX]) {
			// `contain`: scale so the whole picture fits, then centre it.
			const scale = Math.min(slotW / photoAr, slotH)
			const perSide = (slotW - scale * photoAr) / 2
			assert.ok(
				perSide < MAX_LETTERBOX_PER_SIDE,
				`a ${photoAr} photo in the ${slotW.toFixed(1)}×${slotH} slot letterboxes ${perSide.toFixed(1)}px per side`,
			)
		}
	}
})

test('the slot derives its width from the ratio instead of squaring the height', () => {
	const decls = ruleBody('body.mode-packer #tab-orders .product-thumb')
	assert.ok(/width:\s*calc\([^)]*--pack-thumb-h[\s\S]*?--pack-ar/.test(decls), 'the thumbnail width no longer derives from --pack-ar — a square slot is back')
	assert.ok(/height:\s*var\(\s*--pack-thumb-h/.test(decls), 'the thumbnail height no longer reads --pack-thumb-h')
	// The fallbacks are load-bearing: `width: var(--undefined)` resolves to
	// `auto`, and an auto-width flex item with flex-shrink:0 has no photo at all.
	assert.ok(/--pack-thumb-h,\s*\d/.test(decls) && /--pack-ar,\s*0?\.\d/.test(decls), 'a custom property lost its fallback — renaming it would collapse the photo')
})

test('a slot holding a photo paints nothing behind it', () => {
	const decls = ruleBody('body.mode-packer #tab-orders .product-thumb:has(img)')
	assert.ok(/background:\s*transparent/.test(decls), 'the bench thumbnail paints a fill again — any residual letterbox becomes a visible seam')
	assert.ok(/border-color:\s*transparent/.test(decls), 'the bench thumbnail paints a border again')
	assert.ok(
		!/background:\s*rgba\(255,\s*255,\s*255/.test(ruleBody('body.mode-packer #tab-orders .product-thumb')),
		'the unconditional thumbnail rule paints a fill — it would show through on every line, photo or not',
	)
	// The 🛍️ fallback has no picture to be its own frame, so it must keep one.
	assert.ok(/^\s*background:\s*var\(--border\)/m.test(ruleBody('.product-thumb')), 'the base thumbnail lost its fill — the broken-image fallback now floats with no box')
})

test('the enlarged view does not letterbox onto a painted stage either', () => {
	assert.ok(!/background:\s*rgba/.test(ruleBody('.packpv-stage')), 'the preview stage paints a fill — it flexes to the card, so it can never match the photo and the grey bars come back larger')
})

test('"Quantity 1" leaves the row but not the preview', () => {
	assert.ok(
		source.includes('body.mode-packer #tab-orders .product-meta-row:has(.product-meta-qty):not(.product-meta-row--multi-qty)'),
		'the boilerplate quantity row is back on the bench',
	)
	// The preview mounts on <body>; an unscoped rule would blank it there too,
	// and then the count would be unreachable rather than merely de-emphasised.
	assert.ok(!/body\.mode-packer \.product-meta-row:has\(\.product-meta-qty\)/.test(source), 'the quantity rule is not scoped to #tab-orders — it hides the count in the pack preview as well')
	// Above one it is the only quantity token left anywhere, so it must survive.
	assert.ok(source.includes('body.mode-packer #tab-orders .product-meta-qty--multi'), 'the multi-unit pill lost its bench sizing — the one quantity that matters is now the quiet one')
})

group('Bench clarity markers')

test('the multi-product chip is a count, not an instruction', () => {
	assert.ok(source.includes('${_label}</div>'), 'the pack-count chip markup was removed')
	assert.ok(source.includes('`${txs.length} products`'), 'the short "N products" label is gone')
	assert.ok(!source.includes('Pack all ${txs.length} products'), 'the instructional "Pack all N products" copy is back')
	assert.ok(!source.includes('pcc-ic'), 'the 📦 emoji span is back on the chip')
	const chip = ruleBody('.pack-count-chip')
	assert.ok(!/border\s*:/.test(chip), 'the chip paints a border again — the quiet count reads as a button')
	assert.ok(/text-transform:\s*uppercase/.test(chip), 'the chip lost its quiet uppercase treatment')
})

test('Grip and Charm are highlighted in the STYLE string, not as second badges', () => {
	assert.ok(source.includes('function _styleValueHtml'), 'the STYLE highlighter is gone')
	assert.ok(source.includes("replace(/\\bGrip\\b/gi"), 'the highlighter no longer targets the word Grip')
	assert.ok(source.includes("replace(/\\bCharm\\b/gi"), 'the highlighter no longer targets the word Charm')
	assert.ok(source.includes('_styleValueHtml(v.formatted_value)'), 'plain STYLE rows no longer go through the highlighter')
	assert.ok(source.includes('_styleValueHtml(sw.now)'), 'switched STYLE rows no longer go through the highlighter')
	assert.ok(!source.includes('charm-flag'), 'the ✨ Charm badge is still in the page')
	assert.ok(/body\.mode-packer \.charm-word\s*\{[\s\S]*?color:\s*#fcd34d/.test(source), 'Charm lost its amber colour')
	assert.ok(/body\.mode-packer \.grip-word\s*\{[\s\S]*?color:\s*#7dd3fc/.test(source), 'Grip lost its sky colour')
	assert.ok(source.includes('@keyframes charm-word-pulse'), 'the Charm pulse animation is gone')
	assert.ok(source.includes('@keyframes grip-word-pulse'), 'the Grip pulse animation is gone')
	assert.ok(source.includes('prefers-reduced-motion'), 'the pulse ignores prefers-reduced-motion')
})

test('a listed photo opens Etsy; only the rest enlarge', () => {
	assert.ok(source.includes('function _packThumbLinksToListing'), 'the listing-vs-preview gate is gone')
	assert.ok(source.includes('if (_packThumbLinksToListing(ctx.thumb)) return'), 'linked photos are intercepted again')
	assert.ok(/target="_blank" rel="noopener" class="\$\{_thumbCls\}"/.test(source) || source.includes('target="_blank" rel="noopener"'), 'the listed thumb lost target=_blank')
	assert.ok(source.includes("body.mode-packer #tab-orders a.product-thumb:has(img)::after"), 'the hover glyph no longer names the Etsy destination')
})

test('every product photo is rounded, not only the ones that fill their slot', () => {
	// Stretching the <img> to the slot + contain + border-radius only rounds
	// photos that fill the box. Letting the <img> hug its own aspect makes the
	// radius clip the painted pixels of every photo — AirPods and phone cases
	// alike. See the comment on the rule itself.
	const decls = ruleBody('body.mode-packer #tab-orders .product-thumb img')
	assert.ok(/width:\s*auto/.test(decls) && /height:\s*auto/.test(decls), 'the <img> is stretched to the slot again — squarer photos keep square corners')
	assert.ok(/max-width:\s*100%/.test(decls) && /max-height:\s*100%/.test(decls), 'the <img> is no longer capped by the slot')
	assert.ok(/border-radius:\s*10px/.test(decls), 'the rounded corners are gone from the photo itself')
})

group('Charm-card shipped integration')

test('the card is hidden by default and revealed only by packing mode', () => {
	assert.ok(/\.pack-charm-card\s*\{[\s\S]*?display:\s*none/.test(source), 'the charm card leaks into the owner order list')
	assert.ok(/body\.mode-packer \.pack-charm-card\s*\{[\s\S]*?display:\s*flex/.test(source), 'packing mode never reveals the charm card')
})

test('the visible charm reference is image-only, with no yellow container chrome', () => {
	const card = ruleBody('body.mode-packer .pack-charm-card')
	assert.ok(/padding:\s*0/.test(card), 'the old padded container came back')
	assert.ok(/border:\s*0/.test(card), 'the old outlined container came back')
	assert.ok(/background:\s*transparent/.test(card), 'the old tinted container came back')
	assert.ok(!source.includes('<span class="pack-charm-label">'), 'the visible "Charm to pack" label came back')
	assert.ok(
		/\.pack-charm-code,\s*\n\s*\.pack-charm-visually-hidden\s*\{[\s\S]*?clip:\s*rect\(0,\s*0,\s*0,\s*0\)/.test(source),
		'the charm code is visible again instead of being retained only for accessibility/preview context',
	)
})

test('every Orders row and both 4PX row shapes use the shared charm renderer', () => {
	assert.ok(source.includes('const packCharmHtml = _packCharmPreviewHtml(tx)'), 'Orders rows do not consume the charm contract')
	assert.ok(source.includes('const charmHtml = _packCharmPreviewHtml(it.packTx, true)'), 'multi-product 4PX rows lost the charm')
	assert.ok(source.includes('const rowCharmHtml = items.length === 1 ? _packCharmPreviewHtml(items[0].packTx, true)'), 'single-product 4PX rows lost the charm')
})

test('charm photos use contain, so identification never depends on a crop', () => {
	const decls = ruleBody('.pack-charm-thumb img')
	assert.ok(/object-fit:\s*contain/.test(decls), 'the charm photo is cropped on the packing bench')
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
