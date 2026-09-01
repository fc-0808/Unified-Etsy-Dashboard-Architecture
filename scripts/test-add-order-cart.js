'use strict'
/**
 * Behavioural tests for "Add Order to Route" — building ONE manual order that
 * carries several products, because a buyer routinely orders more than one.
 *
 * Like the other UI harnesses, this extracts the real block from index.html and
 * the real modal markup, then runs them against jsdom, so the tests exercise the
 * shipped source instead of a copy of it.
 *
 * The behaviours pinned here are the ones that make or break the feature:
 *   · The order panel is on screen BEFORE anything is added. A capability the
 *     operator cannot see is a capability they do not have — that empty state is
 *     the whole affordance for multi-product orders.
 *   · Adding several products builds several lines; the same product in the same
 *     configuration is one line with a larger quantity, never a duplicate.
 *   · The same product in a DIFFERENT model/style stays its own line.
 *   · Creating the order posts ONE request carrying every line.
 *   · A failed POST leaves the operator's list exactly as they built it.
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

const HTML = path.resolve(__dirname, '../public/index.html')
// Normalised so the extraction markers below do not depend on the checkout's
// line endings.
const source = fs.readFileSync(HTML, 'utf8').replace(/\r\n/g, '\n')

function slice(startMarker, endMarker, what) {
	const a = source.indexOf(startMarker)
	const b = source.indexOf(endMarker, a + 1)
	if (a < 0 || b < 0 || b <= a) {
		console.error(`${RED}Could not locate the ${what} in public/index.html.${RESET}`)
		console.error(`${DIM}Expected "${startMarker}" … "${endMarker}".${RESET}`)
		process.exit(1)
	}
	return source.slice(a, b)
}

// The draft-order logic, verbatim.
const CART_SRC = slice('// ══ ADD ORDER CART ══', '// ══ END ADD ORDER CART ══', 'add-order cart sentinels')
// The shipped modal markup (Add Order + its config popover), verbatim, so a
// renamed id or a dropped element fails these tests rather than production.
const MODAL_HTML = slice('<div id="addOrderModal"', '<!-- ── Product Catalog modal', 'Add Order modal markup')
// The Route toolbar button that carries the unsaved-draft badge.
const TOOLBAR_HTML = slice('<button type="button" class="route-act is-add"', '</button>', 'Add Order toolbar button') + '</button>'

/** Pull a top-level helper out of the page by name (3-tab indentation). */
function extractFn(name) {
	const head = `\t\t\tfunction ${name}(`
	const a = source.indexOf(head)
	const b = source.indexOf('\n\t\t\t}\n', a)
	if (a < 0 || b < 0) {
		console.error(`${RED}Could not extract ${name}() from public/index.html.${RESET}`)
		process.exit(1)
	}
	return source.slice(a, b + 5)
}
// Escaping and the photo preview are the page's own; a stub would prove nothing.
const BORROWED = ['toDisplayString', 'escHtml', 'escAttr', '_setAoCustomImage'].map(extractFn).join('\n')

/** jsdom values come from another realm, where deepStrictEqual sees a foreign prototype. */
const plain = (v) => JSON.parse(JSON.stringify(v))

/**
 * A window holding the real modal markup with the real cart block loaded.
 * Everything the block reaches outside itself is stubbed here and recorded, so
 * a test can see exactly which collaborators ran and with what.
 */
function makeEnv({ mode = 'catalog', products = CATALOG } = {}) {
	const virtualConsole = new VirtualConsole()
	virtualConsole.on('jsdomError', () => {})
	const dom = new JSDOM(`<!doctype html><html><body>${TOOLBAR_HTML}${MODAL_HTML}</body></html>`, {
		runScripts: 'dangerously',
		virtualConsole,
	})
	const { window } = dom
	const calls = { posts: [], toasts: [], closed: 0, renderedGrid: 0, modeSet: [] }
	window.__calls = calls
	// Every collaborator the block calls, and nothing it does not.
	const prelude = `
		${BORROWED}
		let _aoMode = ${JSON.stringify(mode)}
		let _aoProducts = ${JSON.stringify(products)}
		let _aoCustomImageB64 = null, _aoCustomImageMime = ''
		const AO_STYLES = [
			{ value: 'Case+Grip+Charm', label: 'Case + Grip + Charm' },
			{ value: 'Case+Charm', label: 'Case + Charm' },
			{ value: 'Case Only', label: 'Case Only' },
		]
		function renderAoProducts() { window.__calls.renderedGrid++ }
		function setAddOrderMode(m) { _aoMode = m; window.__calls.modeSet.push(m); renderAoCart() }
		function _resetCustomProductForm() { _setAoCustomEditUi(false) }
		function _showAoConfig(p, preset) { window.__calls.config = { product: p, preset } }
		function _aoCanonicalStyle(raw) { return AO_STYLES.find((s) => s.value === raw)?.value || '' }
		function pickAoStyle() {}
		function selectAoCharm() {}
		function closeAddOrderModal() { window.__calls.closed++ }
		function showRouteToast(m) { window.__calls.toasts.push(m) }
		function _truncate(s, n) { return String(s).length > n ? String(s).slice(0, n) + '…' : String(s) }
		async function _submitManualOrder(payload, errEl, onSuccess) {
			window.__calls.posts.push(payload)
			if (window.__failNextPost) {
				if (errEl) { errEl.textContent = 'Error: boom'; errEl.style.display = 'block' }
				return
			}
			if (onSuccess) onSuccess()
		}
	`
	// One eval so the stubs and the block share a scope, exactly as they do on
	// the page. The trailing accessors are the test's only window into it.
	window.eval(`${prelude}\n${CART_SRC}\n` + `
		window.__draft = () => _aoCart.map((l) => ({ ...l }))
		window.__setMode = (m) => { _aoMode = m }
		window.__editing = () => _aoEditCartId
		window.__max = AO_CART_MAX
	`)
	window.renderAoCart()
	return { window, doc: window.document, calls }
}

const CATALOG = [
	{ listing_id: 101, title: 'Blue Fish Case', shop_name: 'Manual Orders', image_url: '/img/101.jpg', phone_models: ['iPhone 16'], styles: ['Case Only'] },
	{ listing_id: 202, title: 'Rainbow Stars Case', shop_name: 'Manual Orders', image_url: '/img/202.jpg', phone_models: [], styles: [] },
]

const catalogLine = (over = {}) => ({
	source: 'catalog',
	title: 'Blue Fish Case',
	listing_id: 101,
	image_url: '/img/101.jpg',
	shop_name: 'Manual Orders',
	phone_model: 'iPhone 16',
	style: 'Case Only',
	quantity: 1,
	charm_code: '',
	charm_shop: '',
	...over,
})

const customLine = (over = {}) => ({
	source: 'custom',
	title: 'Hand-made Bear Case',
	phone_model: 'iPhone 15',
	style: 'Case+Charm',
	quantity: 1,
	shop_name: '',
	image_b64: 'data:image/png;base64,AAAA',
	image_mime: 'image/png',
	charm_code: 'CH-7',
	charm_shop: 'Stall B',
	...over,
})

const lines = (doc) => Array.from(doc.querySelectorAll('#aoCartLines .ao-cart-line'))
const text = (doc, id) => doc.getElementById(id).textContent.trim()
const shown = (el) => el.style.display !== 'none'
const click = (window, el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))

// ─────────────────────────────────────────────────────────────────────────────
group('The order is visible before anything is in it')

test('the panel, its guidance and a disabled Create button are on screen from the start', () => {
	const { doc } = makeEnv()
	const cart = doc.getElementById('aoCart')
	assert.strictEqual(cart.classList.contains('is-hidden'), false, 'the order panel is hidden until something is added — the operator cannot tell an order holds several products')
	assert.ok(shown(doc.getElementById('aoCartEmpty')), 'the empty state is not rendered')
	assert.match(text(doc, 'aoCartEmpty'), /A buyer can order several/, 'the empty state does not say an order can hold several products')
	assert.strictEqual(text(doc, 'aoCartCount'), 'No products yet')
	assert.ok(doc.getElementById('aoCartSubmit').disabled, 'an empty order can be created')
	assert.strictEqual(shown(doc.getElementById('aoCartClear')), false, 'Clear all is offered with nothing to clear')
})

test('receipt mode steps aside only while the draft is empty', () => {
	const { window, doc } = makeEnv({ mode: 'receipt' })
	assert.ok(doc.getElementById('aoCart').classList.contains('is-hidden'), 'the empty panel crowds the receipt-ID flow it has nothing to do with')
	window.addToAoCart(catalogLine())
	assert.strictEqual(doc.getElementById('aoCart').classList.contains('is-hidden'), false, 'switching tabs hid a draft the operator already built')
})

// ─────────────────────────────────────────────────────────────────────────────
group('Several products on one order')

test('each product the buyer ordered becomes its own line', () => {
	const { window, doc } = makeEnv()
	window.addToAoCart(catalogLine())
	window.addToAoCart(catalogLine({ title: 'Rainbow Stars Case', listing_id: 202, phone_model: '', style: 'Case+Charm' }))
	assert.strictEqual(lines(doc).length, 2, 'the second product did not survive')
	assert.deepStrictEqual(lines(doc).map((l) => l.querySelector('.ao-cart-title').textContent), ['Blue Fish Case', 'Rainbow Stars Case'])
	assert.strictEqual(text(doc, 'aoCartCount'), '2 products')
	assert.strictEqual(doc.getElementById('aoCartSubmit').disabled, false, 'a filled order cannot be created')
	assert.strictEqual(doc.getElementById('aoCartSubmit').textContent, 'Create order (2)')
	assert.strictEqual(shown(doc.getElementById('aoCartEmpty')), false, 'the empty state is still showing over a filled order')
})

test('the same product in the same configuration is one line, quantity 2', () => {
	const { window, doc } = makeEnv()
	window.addToAoCart(catalogLine())
	window.addToAoCart(catalogLine())
	assert.strictEqual(lines(doc).length, 1, 'an identical pick was duplicated instead of counted')
	assert.strictEqual(window.__draft()[0].quantity, 2)
	assert.strictEqual(text(doc, 'aoCartCount'), '1 product · 2 items')
	assert.strictEqual(doc.getElementById('aoCartSubmit').textContent, 'Create order (2)')
})

test('the same product in a different model or charm stays its own line', () => {
	const { window, doc } = makeEnv()
	window.addToAoCart(catalogLine())
	window.addToAoCart(catalogLine({ phone_model: 'iPhone 15' }))
	window.addToAoCart(catalogLine({ charm_code: 'CH-9' }))
	assert.strictEqual(lines(doc).length, 3, 'variants of one listing were collapsed into a single line')
	assert.strictEqual(text(doc, 'aoCartCount'), '3 products')
})

test('two custom products are never merged — each carries its own photo', () => {
	const { window, doc } = makeEnv()
	window.addToAoCart(customLine())
	window.addToAoCart(customLine())
	assert.strictEqual(lines(doc).length, 2, 'a second hand-built product was swallowed by the first')
})

test('quantities go up and down, and down to nothing', () => {
	const { window, doc } = makeEnv()
	window.addToAoCart(catalogLine())
	const id = window.__draft()[0].cartId
	click(window, lines(doc)[0].querySelectorAll('.ao-cart-qty button')[1])
	assert.strictEqual(window.__draft()[0].quantity, 2, 'the + control did nothing')
	click(window, lines(doc)[0].querySelectorAll('.ao-cart-qty button')[0])
	assert.strictEqual(window.__draft()[0].quantity, 1, 'the − control did nothing')
	window.bumpAoCartQty(id, -1)
	assert.strictEqual(lines(doc).length, 0, 'decrementing the last unit left an empty line behind')
	assert.ok(doc.getElementById('aoCartSubmit').disabled, 'the emptied order can still be created')
	assert.ok(shown(doc.getElementById('aoCartEmpty')), 'the guidance did not come back with the emptied order')
})

test('a single product can be dropped, and the whole order cleared', () => {
	const { window, doc } = makeEnv()
	window.addToAoCart(catalogLine())
	window.addToAoCart(catalogLine({ title: 'Rainbow Stars Case', listing_id: 202 }))
	click(window, lines(doc)[0].querySelector('.ao-cart-remove'))
	assert.deepStrictEqual(lines(doc).map((l) => l.querySelector('.ao-cart-title').textContent), ['Rainbow Stars Case'], 'removing one product took the wrong one')
	click(window, doc.getElementById('aoCartClear'))
	assert.strictEqual(lines(doc).length, 0, 'Clear all left products behind')
})

test('the order is capped, and a refused product never disturbs the draft', () => {
	const { window, doc } = makeEnv()
	for (let i = 0; i < window.__max; i++) window.addToAoCart(catalogLine({ listing_id: 1000 + i, title: `Case ${i}` }))
	assert.strictEqual(lines(doc).length, window.__max)
	const errEl = doc.getElementById('aoCartErr')
	const accepted = window.addToAoCart(catalogLine({ listing_id: 9999, title: 'One too many' }), errEl)
	assert.strictEqual(accepted, false, 'the cap does not hold')
	assert.strictEqual(lines(doc).length, window.__max, 'a refused product still landed in the order')
	assert.strictEqual(errEl.textContent, `This order already has ${window.__max} products.`)
	assert.ok(shown(errEl), 'the operator is never told why the product was refused')
})

// ─────────────────────────────────────────────────────────────────────────────
group('Fixing a product already in the order')

test('editing replaces the product in place, keeping its position', () => {
	const { window, doc } = makeEnv()
	window.addToAoCart(catalogLine())
	window.addToAoCart(catalogLine({ title: 'Rainbow Stars Case', listing_id: 202 }))
	const [first, second] = window.__draft()
	assert.strictEqual(window.replaceAoCartLine(first.cartId, catalogLine({ phone_model: 'iPhone 17', quantity: 3 })), true)
	const after = window.__draft()
	assert.strictEqual(after.length, 2, 'editing changed how many products are on the order')
	assert.strictEqual(after[0].cartId, first.cartId, 'the edited product jumped position')
	assert.strictEqual(after[0].phone_model, 'iPhone 17', 'the correction was not applied')
	assert.strictEqual(after[0].quantity, 3)
	assert.strictEqual(after[1].cartId, second.cartId, 'editing disturbed the other product')
	assert.match(lines(doc)[0].querySelector('.ao-cart-meta').textContent, /iPhone 17/)
})

test('an edit that would duplicate another line still edits that line', () => {
	const { window } = makeEnv()
	window.addToAoCart(catalogLine())
	window.addToAoCart(catalogLine({ phone_model: 'iPhone 15' }))
	const [, second] = window.__draft()
	window.replaceAoCartLine(second.cartId, catalogLine())
	const after = window.__draft()
	assert.strictEqual(after.length, 2, 'the operator asked to change THIS product, not to merge it away')
	assert.strictEqual(after[1].phone_model, 'iPhone 16')
})

test('editing a product that is no longer in the order changes nothing', () => {
	const { window } = makeEnv()
	window.addToAoCart(catalogLine())
	const before = window.__draft()
	assert.strictEqual(window.replaceAoCartLine(4242, catalogLine({ title: 'Ghost' })), false)
	assert.deepStrictEqual(window.__draft(), before)
})

test('the product being edited is marked, and re-opens in the form that built it', () => {
	const { window, doc } = makeEnv()
	window.addToAoCart(catalogLine())
	window.addToAoCart(customLine())
	const [cat, cus] = window.__draft()

	window.editAoCartLine(cat.cartId)
	assert.strictEqual(window.__editing(), cat.cartId)
	assert.ok(lines(doc)[0].classList.contains('is-editing'), 'nothing shows which product is being changed')
	assert.strictEqual(window.__calls.config.product.listing_id, 101, 'the catalog line did not re-open in the config popover')
	assert.deepStrictEqual(plain(window.__calls.config.preset), { phone_model: 'iPhone 16', style: 'Case Only', quantity: 1, charm_code: '', charm_shop: '' })

	window.editAoCartLine(cus.cartId)
	assert.deepStrictEqual(plain(window.__calls.modeSet).slice(-1), ['custom'], 'the custom line did not re-open in the custom form')
	assert.strictEqual(doc.getElementById('aoCustomTitle').value, 'Hand-made Bear Case')
	assert.strictEqual(doc.getElementById('aoCustomQty').value, '1')
	assert.strictEqual(doc.getElementById('aoCustomSubmit').textContent, 'Save changes', 'the form still reads like it is adding a new product')
	assert.ok(shown(doc.getElementById('aoCustomCancelEdit')), 'an edit cannot be backed out of')
})

test('a custom edit re-opens with the photo already uploaded', () => {
	const { window, doc } = makeEnv()
	window.addToAoCart(customLine())
	window.editAoCartLine(window.__draft()[0].cartId)
	assert.strictEqual(doc.getElementById('aoDropPreview').getAttribute('src'), 'data:image/png;base64,AAAA', 'the operator has to re-upload a photo they already provided')
})

test('backing out of an edit leaves the order untouched', () => {
	const { window, doc } = makeEnv()
	window.addToAoCart(customLine())
	const before = window.__draft()
	window.editAoCartLine(before[0].cartId)
	click(window, doc.getElementById('aoCustomCancelEdit'))
	assert.strictEqual(window.__editing(), null, 'the form stayed in edit mode')
	assert.deepStrictEqual(window.__draft(), before, 'cancelling an edit changed the order')
	assert.strictEqual(doc.getElementById('aoCustomSubmit').textContent, 'Add to order')
	assert.strictEqual(shown(doc.getElementById('aoCustomCancelEdit')), false)
})

// ─────────────────────────────────────────────────────────────────────────────
group('Creating the order')

test('every product goes to the server in ONE order', async () => {
	const { window, doc } = makeEnv()
	window.addToAoCart(catalogLine())
	window.addToAoCart(catalogLine())
	window.addToAoCart(customLine())
	await window.submitAoCart()

	assert.strictEqual(window.__calls.posts.length, 1, 'the products were posted as separate orders')
	const items = plain(window.__calls.posts[0].items)
	assert.strictEqual(items.length, 2, 'a product was dropped on the way to the server')
	assert.deepStrictEqual(
		items.map((i) => [i.title, i.phone_model, i.style, i.quantity, i.charm_code]),
		[
			['Blue Fish Case', 'iPhone 16', 'Case Only', 2, ''],
			['Hand-made Bear Case', 'iPhone 15', 'Case+Charm', 1, 'CH-7'],
		],
		'each product must reach the server with its own model, style, charm and quantity',
	)
	assert.strictEqual(items[0].listing_id, 101, 'the catalog line lost the listing that identifies it')
	assert.strictEqual(items[1].image_b64, 'data:image/png;base64,AAAA', 'the uploaded photo never left the browser')

	assert.strictEqual(lines(doc).length, 0, 'the draft survived a successful create')
	assert.strictEqual(window.__calls.closed, 1, 'the modal stayed open after creating the order')
	assert.deepStrictEqual(plain(window.__calls.toasts).slice(-1), ['✓ Added 3 products as one order'])
	assert.ok(doc.getElementById('aoCartSubmit').disabled, 'the emptied panel still offers to create an order')
})

test('a failed create leaves the order exactly as it was built', async () => {
	const { window, doc } = makeEnv()
	window.addToAoCart(catalogLine())
	window.addToAoCart(customLine())
	const before = window.__draft()
	window.__failNextPost = true
	await window.submitAoCart()

	assert.deepStrictEqual(window.__draft(), before, 'a network failure threw away the operator’s work')
	assert.strictEqual(lines(doc).length, 2)
	assert.strictEqual(window.__calls.closed, 0, 'the modal closed over a failure')
	assert.strictEqual(doc.getElementById('aoCartSubmit').disabled, false, 'the operator cannot retry — the button stayed disabled')
	assert.ok(shown(doc.getElementById('aoCartErr')), 'the failure was silent')
})

test('an empty order is never sent, and says what to do instead', async () => {
	const { window, doc } = makeEnv()
	await window.submitAoCart()
	assert.strictEqual(window.__calls.posts.length, 0, 'an empty order reached the server')
	assert.strictEqual(text(doc, 'aoCartErr'), 'Add at least one product first.')
})

// ─────────────────────────────────────────────────────────────────────────────
group('An unsaved order is visible outside the modal')

test('the Route toolbar carries the draft, and drops it once created', async () => {
	const { window, doc } = makeEnv()
	const badge = doc.getElementById('routeAddOrderDraft')
	assert.strictEqual(shown(badge), false, 'an empty draft is advertised on the toolbar')
	window.addToAoCart(catalogLine({ quantity: 2 }))
	window.addToAoCart(customLine())
	assert.ok(shown(badge), 'closing the modal would hide the drafted order entirely')
	assert.strictEqual(badge.textContent, '3', 'the badge counts lines instead of items')
	await window.submitAoCart()
	assert.strictEqual(shown(badge), false, 'the badge outlived the order it was tracking')
})

// ─────────────────────────────────────────────────────────────────────────────
group('Shipped wiring')

test('the modal markup keeps the hooks the block renders into', () => {
	assert.ok(MODAL_HTML.includes('id="aoCartEmpty"'), 'the empty state is gone from the shipped modal')
	assert.ok(/id="aoCartSubmit"[^>]*disabled/.test(MODAL_HTML), 'the Create button no longer starts disabled')
	assert.ok(MODAL_HTML.includes('aria-live="polite"'), 'the product count is no longer announced to screen readers')
	assert.ok(TOOLBAR_HTML.includes('id="routeAddOrderDraft"'), 'the toolbar lost the unsaved-draft badge')
	assert.ok(
		source.includes("'Add one or more products from your catalog, build a custom product, or pull in an existing Etsy order. Products you add here ship as a single buyer order.':"),
		'the multi-product subtitle is missing from the Chinese dictionary',
	)
})

test('the product grid gives up height without collapsing its cards', () => {
	const css = source.slice(source.indexOf('.ao-product-grid {'), source.indexOf('.ao-grid-loading,'))
	// The grid is a shrinkable flex item so a long order never pushes the Create
	// button off the card. That definite height is also what once collapsed every
	// card into a sliver, so all three guards below have to stay together:
	assert.ok(/flex: 1 1 auto;/.test(css), 'the grid no longer yields height to the order panel')
	assert.ok(/grid-auto-rows: max-content;/.test(css), 'rows can be sized by the grid box again — cards collapse into slivers')
	assert.ok(/align-content: start;/.test(css), 'leftover height is distributed across the rows again')
	// A positive floor makes the grid overflow its pane and paint over the order
	// panel on a short screen.
	assert.ok(/min-height: 0;/.test(css), 'the grid has a height floor again, which overlaps the order panel when space runs out')
	assert.ok(/\.add-order-card-wide\.has-cart \.ao-product-grid \{\s*max-height: 32vh;/.test(source), 'the grid no longer makes extra room once an order is being built')

	const thumb = source.slice(source.indexOf('.ao-product-thumb {'), source.indexOf('.ao-product-body {'))
	assert.strictEqual((thumb.match(/flex-shrink: 0;/g) || []).length, 2, 'the product photo and its placeholder can be squashed flat again')
	const card = source.slice(source.indexOf('.add-order-card-wide {'), source.indexOf('.add-order-head {'))
	assert.ok(/overflow-y: auto;/.test(card), 'the modal can no longer scroll as a last resort on a very short screen')
})

test('the order panel is visible while empty and never pushed off the card', () => {
	const cartCss = source.slice(source.indexOf('/* The order being built'), source.indexOf('.ao-cart-head {'))
	assert.ok(/\.ao-cart \{[\s\S]{0,200}?display: flex;/.test(cartCss), 'the order panel is display:none again — it must be visible while empty')
	assert.ok(/flex-shrink: 0;/.test(cartCss), 'the order panel can be squeezed away by the product grid')
	assert.ok(cartCss.includes('.ao-cart.is-hidden'), 'the only rule that may hide the panel is gone')
	assert.ok(source.includes("classList.toggle('has-cart', products > 0)"), 'nothing tells the card an order is being built')
})

test('the shipped forms add a product, or save the one being edited', () => {
	const catalog = source.slice(source.indexOf('function submitCatalogProduct('), source.indexOf('function submitCustomProduct('))
	const custom = source.slice(source.indexOf('function submitCustomProduct('), source.indexOf('// ══ ADD ORDER CART'))
	for (const [name, fn] of [['catalog', catalog], ['custom', custom]]) {
		assert.ok(fn.includes('const editId = _aoEditCartId'), `the ${name} form no longer notices it is editing`)
		assert.ok(/editId !== null \? replaceAoCartLine\(editId, line\) : addToAoCart\(line, errEl\)/.test(fn), `the ${name} form does not route an edit to replaceAoCartLine`)
	}
	assert.ok(source.includes('if (_aoEditCartId !== null) _exitAoEdit()'), 'picking a new product no longer abandons an open edit')
	const setMode = source.slice(source.indexOf('function setAddOrderMode('), source.indexOf('function _fillAoDatalists('))
	assert.ok(setMode.includes('renderAoCart()'), 'switching tabs no longer re-renders the order panel')
})

test('the page posts the whole order to the multi-item endpoint', () => {
	const submit = source.slice(source.indexOf('async function submitAoCart('), source.indexOf('// ══ END ADD ORDER CART'))
	assert.ok(/items: _aoCart\.map\(/.test(submit), 'the draft is no longer posted as an items[] array')
	assert.ok(source.includes("fetch(`${API}/api/route/manual-order`"), 'the manual-order endpoint moved')
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
