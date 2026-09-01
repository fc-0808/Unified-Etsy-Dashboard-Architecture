'use strict'
/**
 * Behavioural tests for marketplace import-tax handling.
 *
 * A wrong tax number here is not a rendering bug — it is written onto a physical
 * parcel, and the buyer discovers it by being charged VAT a second time at their
 * door. So the things pinned below are the ones whose failure is invisible from
 * the screen:
 *
 *   · The identifiers we ship are REAL. Every built-in value that has a national
 *     check digit is verified against that algorithm, so a fat-fingered edit to
 *     the registry fails here rather than at a border.
 *   · Etsy PROHIBITS writing the EU IOSS number on a parcel and INSTRUCTS
 *     writing the UK VAT number on it. The notice must never render those two
 *     the same way.
 *   · Over the collection ceiling Etsy charged the buyer nothing, so claiming
 *     "VAT prepaid" and offering the number is actively harmful. The notice has
 *     to flip.
 *   · The browser holds no hard-coded tax number. If the registry does not load
 *     the notice is absent, never invented.
 *   · An operator override is validated before it is believed, and a bad one is
 *     dropped in favour of the reviewed value instead of reaching the bench.
 *
 * The renderer ships inside one large inline <script>, so the harness extracts
 * the real block from public/index.html and runs the shipped source under jsdom
 * rather than a copy of it.
 *
 *     npm run test:destination-tax
 */

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { JSDOM } = require('jsdom')

const tax = require('../src/compliance/destination-tax')

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m'
let passed = 0, failed = 0
const failures = []
const pending = []
function group(name) { pending.push({ group: name }) }
function test(name, fn) { pending.push({ name, fn }) }

// ── Extract the renderer straight out of the shipped page ────────────────────
const HTML = path.resolve(__dirname, '../public/index.html')
const source = fs.readFileSync(HTML, 'utf8')
const START = '// ══ DESTINATION TAX ══'
const END = '// ══ END DESTINATION TAX ══'
const a = source.indexOf(START)
const b = source.indexOf(END)
if (a < 0 || b < 0 || b <= a) {
	console.error(`${RED}Could not locate the destination-tax sentinels in public/index.html.${RESET}`)
	console.error(`${DIM}Expected "${START}" … "${END}".${RESET}`)
	process.exit(1)
}
const RENDER_SRC = source.slice(a, b)

/**
 * The escaping helpers live elsewhere in the page, so they are lifted out of the
 * same file by name. Copying them into the harness instead would let the page's
 * real escaper rot while these tests kept passing.
 */
function liftFunction(name) {
	const start = source.indexOf(`function ${name}(`)
	assert.ok(start >= 0, `could not find function ${name}() in public/index.html`)
	// Brace-match rather than pattern-match the closing line: these bodies contain
	// nested blocks and the file's line endings are not ours to depend on.
	let depth = 0
	let i = source.indexOf('{', start)
	assert.ok(i > start, `function ${name}() has no body`)
	for (; i < source.length; i++) {
		if (source[i] === '{') depth++
		else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1)
	}
	throw new Error(`function ${name}() is unbalanced in public/index.html`)
}
const ESCAPERS = ['toDisplayString', 'escHtml', 'escAttr'].map(liftFunction).join('\n')

/**
 * The page's Chinese dictionary, read out of the page itself.
 *
 * Bounded by the declaration that follows it rather than by brace-matching, so a
 * brace inside a translated string cannot truncate it.
 */
const I18N_DICT = (() => {
	const start = source.indexOf('const I18N_DICT = {')
	assert.ok(start >= 0, 'could not find I18N_DICT in public/index.html')
	const after = source.indexOf('const I18N_PATTERNS', start)
	assert.ok(after > start, 'I18N_DICT is no longer followed by I18N_PATTERNS — the bound below is wrong')
	const literal = source.slice(source.indexOf('{', start), source.lastIndexOf('}', after) + 1)
	return new Function(`return (${literal})`)()
})()

/**
 * The page's localiser, dictionary and patterns — the real module, so a zh render
 * in these tests goes through exactly what a packer's browser runs.
 */
const I18N_SRC = (() => {
	const start = source.indexOf('const I18N_DICT = {')
	const end = source.indexOf('const ROLE = (() => {', start)
	assert.ok(end > start, 'the I18N module is no longer followed by the ROLE block — the bound below is wrong')
	return source.slice(start, end)
})()

/**
 * Every string the localiser would be asked to translate in a rendered subtree:
 * text nodes and human-readable attributes, minus anything under [data-i18n-skip].
 * Mirrors walk()/translateElement() in the page's I18N module.
 *
 * aria-label is deliberately excluded: it embeds the identifier, so it is unique
 * per destination and cannot be a dictionary key.
 */
function translatableStrings(el) {
	const out = new Set()
	const visit = (node) => {
		if (node.nodeType === 3) {
			const text = node.nodeValue.trim()
			if (text) out.add(text)
			return
		}
		if (node.nodeType !== 1 || node.hasAttribute('data-i18n-skip')) return
		for (const attr of ['title', 'placeholder']) {
			if (node.hasAttribute(attr)) out.add(node.getAttribute(attr).trim())
		}
		node.childNodes.forEach(visit)
	}
	visit(el)
	return out
}

/** The registry exactly as GET /api/compliance/destination-tax serves it. */
const REGISTRY = tax.buildDestinationTaxRegistry(null)
const API_PAYLOAD = { reviewed_at: REGISTRY.reviewed_at, schemes: REGISTRY.schemes, countries: REGISTRY.countries }

/**
 * A page with the shipped renderer loaded.
 *
 * @param {object}  opts
 * @param {object|null} opts.registry  payload the fetch resolves with; null → the
 *                                     endpoint fails, which is a case with teeth.
 * @param {object}  opts.rates         EUR-base FX map, {} to simulate no rates.
 * @param {'en'|'zh'} opts.lang        'zh' loads the page's real localiser.
 */
async function makeEnv({
	registry = API_PAYLOAD,
	rates = { EUR: 1, GBP: 0.85, HKD: 8.5, NOK: 11.5, CHF: 0.95, AUD: 1.65, NZD: 1.8 },
	stale = false,
	cachedAt = '2026-08-19T00:00:00.000Z',
	lang = 'en',
} = {}) {
	// A real origin, because the localiser reads its locale out of localStorage.
	const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/' })
	const { window } = dom
	window.API = ''
	window.__fetched = []
	// Mutable so a later-arriving table can be injected the same way the page
	// receives it — over fetch — without reaching into the renderer's `let`.
	const feed = { registry, rates, stale, cachedAt }
	window.__ratesFeed = feed
	window.fetch = async (url) => {
		window.__fetched.push(url)
		if (String(url).includes('/api/compliance/destination-tax')) {
			if (!feed.registry) return { ok: false, status: 503, json: async () => ({}) }
			return { ok: true, status: 200, json: async () => feed.registry }
		}
		return {
			ok: true,
			status: 200,
			json: async () => ({
				rates: feed.rates,
				stale: feed.stale,
				cached_at: feed.cachedAt,
				source: Object.keys(feed.rates || {}).length ? 'direct' : 'none',
				error: Object.keys(feed.rates || {}).length ? null : 'no table',
			}),
		}
	}
	// I18N is the renderer's only outside dependency. Under 'zh' we load the real
	// module — its MutationObserver then translates every notice these tests insert,
	// which is the only way to prove the dictionary keys match what is rendered.
	//
	// One eval for all of it: a global eval's `const` bindings live only for the
	// duration of that eval, so the page's `const I18N` has to be declared in the
	// same call as the renderer that closes over it.
	if (lang === 'zh') window.localStorage.setItem('dashboardLang', 'zh')
	const i18n = lang === 'zh' ? `${I18N_SRC}\nI18N.init()` : 'const I18N = { t: (s) => s, get: () => "en" }'
	window.eval([ESCAPERS, i18n, RENDER_SRC].join('\n'))
	// Both loaders own module-scoped `let` bindings the harness cannot reach from
	// outside, so the rates are injected the way the page gets them: over fetch.
	await Promise.all([window.loadDestinationTax(), window.loadExchangeRates()])
	return { window, doc: window.document }
}

/** Render a notice and hand back a queryable element (or null for no notice). */
async function notice({ country, subtotal = 20, shopCcy = 'HKD', ...env }) {
	const { window, doc } = await makeEnv(env)
	const html = window.buildShippingNotices(country, subtotal, shopCcy)
	if (!html) return { html: '', el: null, window }
	const host = doc.createElement('div')
	host.innerHTML = html
	doc.body.appendChild(host)
	// Let the localiser's MutationObserver see the insertion, exactly as it does
	// when renderOrders() paints a row.
	await new Promise((resolve) => window.setTimeout(resolve, 0))
	return { html, el: host.firstElementChild, window }
}

// ═════════════════════════════════════════════════════════════════════════════
group('The identifiers we ship are real numbers')

test('every built-in identifier passes its own national checksum', () => {
	assert.deepStrictEqual(REGISTRY.problems, [], 'the registry reported problems with its own defaults')
	for (const key of tax.SCHEME_KEYS) {
		const scheme = REGISTRY.schemes[key]
		assert.ok(scheme.identifier, `${key} resolved no identifier — that destination silently loses its notice`)
		const result = tax.validateIdentifier(key, scheme.identifier)
		assert.ok(result.ok, `${key} identifier ${scheme.identifier} is invalid: ${result.reason}`)
	}
})

test("Etsy's UK VAT number is the one Etsy prints on the receipt", () => {
	// The number the operator asked for, in the grouping Etsy itself uses.
	assert.strictEqual(REGISTRY.schemes.UK_VAT.identifier, '370 6004 28')
	// It validates only under HMRC's mod-9755 variant, so accepting a single
	// algorithm would reject the very number we have to carry.
	const weighted = [3, 7, 0, 6, 0, 0, 4].reduce((s, n, i) => s + n * (8 - i), 0)
	assert.notStrictEqual((weighted + 28) % 97, 0, 'this number now passes plain mod-97 — re-read the validator comment')
	assert.strictEqual((weighted + 55 + 28) % 97, 0)
})

test('a mistyped identifier is rejected, in every scheme that can prove it', () => {
	const typos = {
		UK_VAT: '370 6004 29',
		CH_VAT: 'CHE-373.086.514',
		NZ_GST: '122669182',
		EU_IOSS: 'IM37200002240',
		NO_VOEC: '1021137',
	}
	for (const [key, value] of Object.entries(typos)) {
		const result = tax.validateIdentifier(key, value)
		assert.strictEqual(result.ok, false, `${key} accepted ${value}`)
		assert.ok(result.reason, `${key} rejected ${value} without saying why`)
	}
})

test('the formats humans actually type are accepted and normalised', () => {
	assert.strictEqual(tax.validateIdentifier('UK_VAT', 'GB 370-6004.28').value, '370 6004 28')
	assert.strictEqual(tax.validateIdentifier('UK_VAT', '370600428').value, '370 6004 28')
	assert.strictEqual(tax.validateIdentifier('EU_IOSS', 'ioss im3720000224').value, 'IM3720000224')
	assert.strictEqual(tax.validateIdentifier('NO_VOEC', 'VOEC 2021137').value, '2021137')
	assert.strictEqual(tax.validateIdentifier('CH_VAT', 'che373086513').value, 'CHE-373.086.513')
})

test('a UK branch-trader suffix survives, because it is part of the number', () => {
	assert.strictEqual(tax.validateIdentifier('UK_VAT', 'GB370600428001').value, '370 6004 28 001')
})

test('an empty or unknown scheme is a stated failure, never a silent one', () => {
	assert.strictEqual(tax.validateIdentifier('UK_VAT', '').ok, false)
	assert.strictEqual(tax.validateIdentifier('UK_VAT', null).ok, false)
	assert.strictEqual(tax.validateIdentifier('NOPE', '123').ok, false)
})

group('Config overrides are believed only after they are checked')

test('a valid override wins and is marked as the operator’s own', () => {
	const reg = tax.buildDestinationTaxRegistry({ marketplace_tax_ids: { UK_VAT: 'GB123456782' } })
	assert.strictEqual(reg.schemes.UK_VAT.identifier, '123 4567 82')
	assert.strictEqual(reg.schemes.UK_VAT.identifier_source, tax.SOURCE.OPERATOR)
	assert.deepStrictEqual(reg.problems, [])
})

test('an invalid override is dropped for the reviewed value, and reported', () => {
	const reg = tax.buildDestinationTaxRegistry({ marketplace_tax_ids: { UK_VAT: '370 6004 29' } })
	assert.strictEqual(reg.schemes.UK_VAT.identifier, '370 6004 28', 'a number that fails its checksum reached the bench')
	assert.strictEqual(reg.schemes.UK_VAT.identifier_source, tax.SOURCE.MARKETPLACE)
	assert.strictEqual(reg.problems.length, 1)
	assert.match(reg.problems[0], /UK_VAT/)
})

test('an unknown scheme key is reported rather than ignored', () => {
	const reg = tax.buildDestinationTaxRegistry({ marketplace_tax_ids: { UK_VAT_NUMBER: '370 6004 28' } })
	assert.strictEqual(reg.problems.length, 1)
	assert.match(reg.problems[0], /unknown scheme/)
})

test('a malformed block cannot take the registry down with it', () => {
	for (const raw of [[], 'IM3720000224', 42]) {
		const reg = tax.buildDestinationTaxRegistry({ marketplace_tax_ids: raw })
		assert.strictEqual(reg.schemes.UK_VAT.identifier, '370 6004 28')
		assert.ok(reg.problems.length >= 1, `${JSON.stringify(raw)} was accepted silently`)
	}
	assert.strictEqual(tax.buildDestinationTaxRegistry(null).problems.length, 0)
	assert.strictEqual(tax.buildDestinationTaxRegistry(undefined).schemes.UK_VAT.identifier, '370 6004 28')
})

test('a blank value means "use the reviewed default", not "no identifier"', () => {
	const reg = tax.buildDestinationTaxRegistry({ marketplace_tax_ids: { UK_VAT: '', EU_IOSS: null } })
	assert.strictEqual(reg.schemes.UK_VAT.identifier, '370 6004 28')
	assert.strictEqual(reg.schemes.EU_IOSS.identifier, 'IM3720000224')
	assert.deepStrictEqual(reg.problems, [])
})

group('Destination coverage')

test('all 27 EU states resolve to IOSS, and only they do', () => {
	assert.strictEqual(tax.EU27.length, 27)
	assert.strictEqual(new Set(tax.EU27).size, 27, 'the EU27 list has a duplicate')
	for (const iso of tax.EU27) assert.strictEqual(REGISTRY.countries[iso], 'EU_IOSS', `${iso} is not mapped to IOSS`)
	// The UK left the customs union; mapping it to IOSS would put an IM number on
	// a British parcel, which is exactly the failure this asserts against.
	assert.notStrictEqual(REGISTRY.countries.GB, 'EU_IOSS')
	assert.strictEqual(REGISTRY.countries.GB, 'UK_VAT')
})

test('the non-EU schemes are wired to their destinations', () => {
	assert.strictEqual(REGISTRY.countries.NO, 'NO_VOEC')
	assert.strictEqual(REGISTRY.countries.CH, 'CH_VAT')
	assert.strictEqual(REGISTRY.countries.AU, 'AU_GST')
	assert.strictEqual(REGISTRY.countries.NZ, 'NZ_GST')
})

test('every scheme declares a disclosure the bench knows how to render', () => {
	const known = new Set(Object.values(tax.DISCLOSURE))
	for (const key of tax.SCHEME_KEYS) {
		assert.ok(known.has(REGISTRY.schemes[key].disclosure), `${key} declares an unknown disclosure "${REGISTRY.schemes[key].disclosure}"`)
	}
})

test('a lane the carrier declares asks the packer for nothing', () => {
	// Australia: Etsy collects the GST and 4PX declares it from the order data, so
	// there is no customs form to write on. The scheme still holds the ARN — what
	// changed is who writes it down, not what the number is.
	const au = tax.resolveDestinationTax('AU', null)
	assert.strictEqual(au.key, 'AU_GST', 'Australia lost its scheme entirely, so the ARN is no longer on file')
	assert.strictEqual(au.disclosure, tax.DISCLOSURE.CARRIER)
	assert.strictEqual(au.package_instruction, null, 'a carrier-declared lane still tells the packer to write something')
})

test('a destination Etsy does not collect for gets no scheme at all', () => {
	for (const iso of ['US', 'CA', 'JP', 'MX', 'HK', 'ZZ', '', null, undefined]) {
		assert.strictEqual(tax.resolveDestinationTax(iso, null), null, `${iso} was handed a tax scheme`)
	}
})

test('a lower-case or padded country code still resolves', () => {
	assert.strictEqual(tax.resolveDestinationTax(' gb ', null).key, 'UK_VAT')
	assert.strictEqual(tax.resolveDestinationTax('de', null).key, 'EU_IOSS')
})

group('The collection ceiling decides which notice this is')

test('at or under the ceiling the tax is prepaid; a penny over it is not', () => {
	const uk = REGISTRY.schemes.UK_VAT
	assert.strictEqual(tax.classifyDeclaredValue(uk, 134.99), 'prepaid')
	assert.strictEqual(tax.classifyDeclaredValue(uk, 135), 'prepaid', 'the ceiling itself is inclusive')
	assert.strictEqual(tax.classifyDeclaredValue(uk, 135.01), 'border')
})

test('a scheme with no ceiling is always prepaid', () => {
	assert.strictEqual(REGISTRY.schemes.CH_VAT.threshold, null)
	assert.strictEqual(tax.classifyDeclaredValue(REGISTRY.schemes.CH_VAT, 5000), 'prepaid')
})

test('an unconvertible value is called unverified, never assumed to be under', () => {
	const uk = REGISTRY.schemes.UK_VAT
	for (const value of [null, undefined, 0, -1, NaN, Infinity, 'x']) {
		assert.strictEqual(tax.classifyDeclaredValue(uk, value), 'unverified', `${value} was treated as a real amount`)
	}
})

test('the packing declaration is the destination amount, never shop-currency revenue', () => {
	const uk = REGISTRY.schemes.UK_VAT
	assert.deepStrictEqual(tax.shapeCustomsDeclaration(uk, 16.486), { currency: 'GBP', amount: 16.49, state: 'prepaid' })
	assert.strictEqual(tax.shapeCustomsDeclaration(uk, 200).state, 'border')
	assert.strictEqual(tax.shapeCustomsDeclaration(uk, null).amount, null)
	assert.strictEqual(tax.shapeCustomsDeclaration(REGISTRY.schemes.AU_GST, 31.46), null, 'a carrier-declared lane still produced a declaration')
})

test('every ceiling is stated in its own currency with a named basis', () => {
	for (const scheme of Object.values(REGISTRY.schemes)) {
		if (!scheme.threshold) continue
		assert.strictEqual(scheme.threshold.currency, scheme.customs_currency, `${scheme.key} measures its ceiling in a currency the notice never shows`)
		assert.ok(scheme.threshold.basis, `${scheme.key} has a ceiling with no stated basis`)
	}
})

group('What the shipment transmits')

test('an install that configured nothing still ships an IOSS number', () => {
	const resolved = tax.resolveShipmentIoss(null)
	assert.strictEqual(resolved.value, 'IM3720000224')
	assert.strictEqual(resolved.source, tax.SOURCE.MARKETPLACE)
})

test('fourpx_ioss_no stays authoritative — including a value we would not have chosen', () => {
	assert.strictEqual(tax.resolveShipmentIoss({ fourpx_ioss_no: 'IM0123456789' }).value, 'IM0123456789')
	assert.strictEqual(tax.resolveShipmentIoss({ fourpx_ioss_no: 'im 3720000224' }).value, 'IM3720000224')
	// 4PX is the authority on what it accepts, so an odd-looking operator value is
	// transmitted rather than refused on our own opinion of the format.
	assert.strictEqual(tax.resolveShipmentIoss({ fourpx_ioss_no: 'IOSS-XYZ' }).value, 'IOSS-XYZ')
	assert.strictEqual(tax.resolveShipmentIoss({ fourpx_ioss_no: 'IOSS-XYZ' }).source, tax.SOURCE.OPERATOR)
})

test('the marketplace_tax_ids override reaches the shipment too', () => {
	const resolved = tax.resolveShipmentIoss({ marketplace_tax_ids: { EU_IOSS: 'IM0987654321' } })
	assert.strictEqual(resolved.value, 'IM0987654321')
	assert.strictEqual(resolved.source, tax.SOURCE.OPERATOR)
})

// ═════════════════════════════════════════════════════════════════════════════
group('The packing notice — UK, the number Etsy tells you to write on the box')

test('the VAT number is on screen, in full, and copyable in one tap', async () => {
	const { el, window } = await notice({ country: 'GB' })
	const chip = el.querySelector('.customs-id')
	assert.ok(chip, 'the UK VAT number has no copy affordance')
	assert.strictEqual(chip.textContent, '370 6004 28')
	assert.strictEqual(chip.dataset.copy, '370 6004 28', 'the copied text is not the number on screen')
	assert.strictEqual(chip.tagName, 'BUTTON', 'the identifier is not keyboard-reachable')
	// Copying goes through the value on the element, so a number containing a
	// quote could never be interpolated into an inline handler.
	assert.ok(!/onclick="copyNumber\(this, *'/.test(window.buildShippingNotices('GB', 20, 'HKD')), 'the identifier is interpolated into a JS string literal')
})

test('it says to write it on the parcel, and shows the value to declare', async () => {
	const { el } = await notice({ country: 'GB', subtotal: 20, shopCcy: 'HKD' })
	const text = el.textContent.replace(/\s+/g, ' ')
	assert.match(text, /Write this number on the parcel/i)
	// 20 HKD → EUR 2.35 → GBP 2.00 with the harness rates.
	assert.match(text, /GBP 2\.00/, `no declared value in the notice: ${text}`)
	assert.match(text, /Etsy pays the VAT/i)
	assert.ok(!el.classList.contains('customs-notice--border'))
})

test('the copy button actually copies, and says so', async () => {
	const { el, window } = await notice({ country: 'GB' })
	const written = []
	window.navigator.clipboard = { writeText: (t) => written.push(t) }
	const chip = el.querySelector('.customs-id')
	chip.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
	assert.deepStrictEqual(written, ['370 6004 28'])
	assert.match(chip.textContent, /Copied/)
})

group('The packing notice — EU, the number that must NOT go on the box')

test('the IOSS number is shown but explicitly barred from the parcel', async () => {
	const { el } = await notice({ country: 'DE' })
	assert.strictEqual(el.querySelector('.customs-id').textContent, 'IM3720000224')
	assert.ok(el.classList.contains('customs-notice--electronic'), 'the EU notice is styled like a write-on-the-box one')
	assert.ok(el.querySelector('.customs-pill--nowrite'), 'nothing on screen stops a packer writing the IOSS number on the parcel')
	assert.match(el.textContent.replace(/\s+/g, ' '), /Never write on parcel/i)
})

test('it never instructs writing the number down — for any EU state', async () => {
	for (const iso of tax.EU27) {
		const { el, html } = await notice({ country: iso })
		assert.ok(el, `${iso} produced no notice`)
		assert.ok(!/write (this|it) (number )?on the (parcel|customs form)/i.test(html), `${iso} tells the packer to write the IOSS number down`)
		assert.ok(el.classList.contains('customs-notice--electronic'), `${iso} is not marked electronic-only`)
	}
})

test('the value in euros is still the packer’s job, and it is stated', async () => {
	const { el } = await notice({ country: 'FR', subtotal: 170, shopCcy: 'HKD' })
	// 170 HKD → EUR 20.00.
	assert.match(el.textContent.replace(/\s+/g, ' '), /Declare on the customs form: EUR 20\.00/)
})

group('The packing notice — over the ceiling, nothing was prepaid')

test('a high-value UK order flips to "collected at the border"', async () => {
	// 1700 HKD → EUR 200 → GBP 170, over the GBP 135 ceiling.
	const { el } = await notice({ country: 'GB', subtotal: 1700, shopCcy: 'HKD' })
	assert.ok(el.classList.contains('customs-notice--border'), 'an order Etsy charged no VAT on still reads as prepaid')
	assert.strictEqual(el.querySelector('.customs-id'), null, 'the VAT number is still offered for a parcel it does not cover')
	const text = el.textContent.replace(/\s+/g, ' ')
	assert.match(text, /collected at the border/i)
	assert.match(text, /GBP 135/, 'the notice does not say what the ceiling was')
	assert.match(text, /does not apply/i)
	assert.match(text, /GBP 170\.00/, 'the value to declare disappeared with the flip')
})

test('a high-value EU order does the same', async () => {
	// 1700 HKD → EUR 200, over the EUR 150 ceiling.
	const { el } = await notice({ country: 'IT', subtotal: 1700, shopCcy: 'HKD' })
	assert.ok(el.classList.contains('customs-notice--border'))
	assert.strictEqual(el.querySelector('.customs-id'), null)
	assert.match(el.textContent.replace(/\s+/g, ' '), /ceiling of EUR 150\.00/)
})

test('a Swiss order never flips, because that scheme has no ceiling', async () => {
	const { el } = await notice({ country: 'CH', subtotal: 100000, shopCcy: 'HKD' })
	assert.ok(!el.classList.contains('customs-notice--border'))
	assert.strictEqual(el.querySelector('.customs-id').textContent, 'CHE-373.086.513')
})

group('Degrading honestly')

test('with no FX rates the number still shows, and no ceiling is offered as the amount to declare', async () => {
	const { el } = await notice({ country: 'GB', rates: {} })
	assert.strictEqual(el.querySelector('.customs-id').textContent, '370 6004 28')
	const text = el.textContent.replace(/\s+/g, ' ')
	assert.match(text, /Declare the order value in GBP/)
	assert.match(text, /Live rates are unavailable/)
	assert.ok(!/GBP 135/.test(text), 'the ceiling was shown as a currency amount — that is what a packer copies onto the form')
	assert.ok(!el.classList.contains('customs-notice--border'), 'an unknown value was treated as over the ceiling')
})

test('an employee order with no shop subtotal still shows the server-converted amount', async () => {
	// This is the employee-laptop case: revenue fields are stripped, client FX is
	// empty, and the only figure the bench may show is customs_declaration.
	const { window, doc } = await makeEnv({ rates: {} })
	const host = doc.createElement('div')
	host.innerHTML = window.buildShippingNotices('GB', undefined, undefined, { amount: 16.49, currency: 'GBP', state: 'prepaid' })
	const text = host.textContent.replace(/\s+/g, ' ')
	assert.match(text, /Declare on the customs form: GBP 16\.49/)
	assert.ok(!/GBP 135/.test(text), 'the ceiling leaked onto an employee notice')
	assert.ok(!/Live rates are unavailable/.test(text), 'the notice ignored the server amount and fell back to the empty-rates copy')
})

test('every destination without rates withholds its ceiling the same way', async () => {
	// The UK GBP 135 bug is a special case of a general one: any scheme whose
	// ceiling is the only currency amount on screen will have every order look
	// like that ceiling. Pin it for every write-on-parcel destination.
	for (const [iso, amount] of [
		['GB', 'GBP 135'],
		['DE', 'EUR 150'],
		['NO', 'NOK 3000'],
		['NZ', 'NZD 1000'],
	]) {
		const { el } = await notice({ country: iso, rates: {} })
		assert.ok(el, `${iso} produced no notice once the rates were gone`)
		assert.ok(!el.textContent.includes(amount), `${iso} still shows ${amount} when the order value cannot be converted`)
	}
})

test('a stale table still converts, and says the rate is old', async () => {
	const { el } = await notice({ country: 'GB', subtotal: 220, stale: true, cachedAt: '2026-08-12T00:00:00.000Z' })
	const text = el.textContent.replace(/\s+/g, ' ')
	assert.match(text, /Declare on the customs form: GBP 22\.00/)
	assert.match(text, /old rate/)
	assert.ok(!/today's rate/.test(text), 'a stale table was described as today\'s')
})

test('rates that land after the first paint rebuild the notices already on screen', async () => {
	const { window, doc } = await makeEnv({ rates: {} })
	const host = doc.createElement('div')
	host.innerHTML = window.customsNoticeHost('GB', 220, 'HKD')
	doc.body.appendChild(host)
	assert.ok(!/GBP 22/.test(host.textContent), 'a value appeared before any rate table existed')
	assert.ok(!/GBP 135/.test(host.textContent), 'the ceiling was offered as the amount to declare')
	window.__ratesFeed.rates = { EUR: 1, GBP: 0.85, HKD: 8.5, NOK: 11.5, CHF: 0.95, AUD: 1.65, NZD: 1.8 }
	const ok = await window.loadExchangeRates()
	assert.strictEqual(ok, true)
	assert.match(host.textContent.replace(/\s+/g, ' '), /Declare on the customs form: GBP 22\.00/)
})

test('with no registry there is no notice — and no invented number', async () => {
	const { html } = await notice({ country: 'GB', registry: null })
	assert.strictEqual(html, '')
})

test('the page carries no tax number of its own', () => {
	// The whole point of the server-side registry. A literal here would be a
	// second source of truth that config.json cannot correct.
	assert.ok(!/IM\d{10}/.test(source), 'an IOSS number is hard-coded in public/index.html')
	assert.ok(!/370\s*6004\s*28/.test(source), 'a UK VAT number is hard-coded in public/index.html')
	assert.ok(!/CHE-?\d{3}\.?\d{3}\.?\d{3}/.test(source), 'a Swiss UID is hard-coded in public/index.html')
	assert.ok(source.includes('/api/compliance/destination-tax'), 'the page no longer loads the registry')
})

test('a scheme whose identifier failed to resolve produces no notice', async () => {
	const gutted = JSON.parse(JSON.stringify(API_PAYLOAD))
	gutted.schemes.UK_VAT.identifier = null
	const { html } = await notice({ country: 'GB', registry: gutted })
	assert.strictEqual(html, '', 'a notice rendered around a missing identifier')
})

test('a destination with no scheme renders nothing at all', async () => {
	for (const iso of ['US', 'CA', 'JP', '', null, undefined, 'zz']) {
		const { html } = await notice({ country: iso })
		assert.strictEqual(html, '', `${iso} produced a notice`)
	}
})

test('an Australian parcel gets no notice, because there is nothing to write', async () => {
	// The bench decides on `disclosure`, not on a country list, so this holds for
	// any lane the carrier declares — and for AU at every order value, including
	// over the AUD 1,000 ceiling where the buyer is billed at the border anyway.
	for (const subtotal of [20, 220, 500000]) {
		const { html } = await notice({ country: 'AU', subtotal })
		assert.strictEqual(html, '', `an AU order of ${subtotal} produced a notice`)
	}
	const { html } = await notice({ country: 'AU', rates: {} })
	assert.strictEqual(html, '', 'an AU order produced a notice once the FX rates were gone')
})

test('the ship drawer offers no chip for a lane the carrier declares', () => {
	// The chip exists so the last screen before the label prints shows a number the
	// packer must transcribe. Australia has none, and it must not be mistaken for
	// an EU destination and given an IOSS chip either.
	assert.ok(source.includes("scheme.disclosure === 'carrier'"), 'the drawer chip no longer excludes carrier-declared lanes')
	assert.ok(source.includes("scheme?.key === 'EU_IOSS'"), 'the drawer recognises EU destinations by disclosure again, which now catches more than the EU')
})

group('Provenance and injection')

test('a value we compiled rather than read off a receipt asks to be confirmed', async () => {
	const { el } = await notice({ country: 'NO' })
	assert.strictEqual(REGISTRY.schemes.NO_VOEC.identifier_source, tax.SOURCE.REFERENCE)
	assert.ok(el.querySelector('.customs-pill--confirm'), 'a reference value is presented as if Etsy had stated it')
})

test('an Etsy-stated or operator-set value carries no hedge', async () => {
	for (const iso of ['GB', 'DE']) {
		const { el } = await notice({ country: iso })
		assert.strictEqual(el.querySelector('.customs-pill--confirm'), null, `${iso} is hedged despite coming from Etsy`)
	}
	const operator = JSON.parse(JSON.stringify(API_PAYLOAD))
	operator.schemes.NO_VOEC.identifier_source = tax.SOURCE.OPERATOR
	const { el } = await notice({ country: 'NO', registry: operator })
	assert.strictEqual(el.querySelector('.customs-pill--confirm'), null, 'the operator’s own value is still hedged')
})

test('a hostile registry cannot inject markup into the bench', async () => {
	const evil = JSON.parse(JSON.stringify(API_PAYLOAD))
	evil.schemes.UK_VAT.identifier = '"><img src=x onerror="window.__pwned=1">'
	evil.schemes.UK_VAT.title = '<script>window.__pwned=1</script>'
	evil.schemes.UK_VAT.package_instruction = '<b>bold</b>'
	const { el, window } = await notice({ country: 'GB', registry: evil })
	assert.strictEqual(el.querySelector('img'), null, 'an <img> was injected through the identifier')
	assert.strictEqual(el.querySelector('script'), null, 'a <script> was injected through the title')
	assert.strictEqual(el.querySelector('b'), null, 'markup was injected through the instruction')
	assert.notStrictEqual(window.__pwned, 1)
	assert.strictEqual(el.querySelector('.customs-id').dataset.copy, '"><img src=x onerror="window.__pwned=1">', 'the attribute was mangled rather than escaped')
})

group('The bench reads in the packer’s language')

/** Every notice this registry can produce, across all four rendering states. */
async function everyNotice() {
	// Force the hedge pill on, so the "confirm once" wording is covered even when
	// every shipped default happens to come from an Etsy receipt.
	const hedged = JSON.parse(JSON.stringify(API_PAYLOAD))
	for (const key of Object.keys(hedged.schemes)) hedged.schemes[key].identifier_source = tax.SOURCE.REFERENCE

	const out = []
	for (const country of Object.keys(API_PAYLOAD.countries)) {
		for (const variant of [
			{ subtotal: 20 }, // under every ceiling: Etsy paid
			{ subtotal: 20, registry: hedged }, // same, with the hedge pill
			{ subtotal: 500000 }, // over every ceiling: collected at the border
			{ subtotal: 20, rates: {} }, // no FX: no converted value, and no ceiling pretending to be one
			{ subtotal: 20, stale: true }, // last-good table: convert, but do not call it today's rate
		]) {
			const { el } = await notice({ country, ...variant })
			if (el) out.push(el)
		}
	}
	return out
}

test('every line it can render has a Chinese translation', async () => {
	const missing = new Set()
	for (const el of await everyNotice()) {
		for (const phrase of translatableStrings(el)) if (!(phrase in I18N_DICT)) missing.add(phrase)
	}
	assert.deepStrictEqual([...missing].sort(), [], 'these lines would render in English for a 中文 packer')
})

test('the copy chip announces itself in the packer’s language', () => {
	// copyNumber() asks for this one by hand rather than through the DOM walker.
	assert.ok('✓ Copied!' in I18N_DICT, 'the copy confirmation is untranslated')
})

test('no identifier or amount is exposed to the dictionary', async () => {
	for (const el of await everyNotice()) {
		const phrases = [...translatableStrings(el)]
		const id = el.querySelector('.customs-id')
		if (id) {
			assert.ok(
				phrases.every((p) => !p.includes(id.dataset.copy)),
				`the identifier ${id.dataset.copy} is translatable — a dictionary hit would rewrite a customs form`,
			)
		}
		for (const money of el.querySelectorAll('strong')) {
			assert.ok(money.hasAttribute('data-i18n-skip'), `the amount “${money.textContent}” is translatable`)
		}
	}
})

test('a 中文 packer reads it in Chinese, through the page’s own localiser', async () => {
	const { el } = await notice({ country: 'GB', subtotal: 20, lang: 'zh' })
	const text = el.textContent.replace(/\s+/g, ' ')
	assert.match(text, /英国进口 —— Etsy 已代缴 VAT/, 'the title stayed English for a Chinese packer')
	assert.match(text, /请把该号码写在包裹上/, 'the instruction that decides what goes on the box stayed English')
	assert.match(text, /报关单申报金额/, 'the declared-value line stayed English')
	assert.ok(!/[A-Za-z]{4,}/.test(text.replace(/Etsy|GBP|VAT/g, '')), `English prose survived: ${text}`)
})

test('the localiser cannot rewrite the number that goes on the parcel', async () => {
	for (const [country, key] of [
		['GB', 'UK_VAT'],
		['DE', 'EU_IOSS'],
		['NO', 'NO_VOEC'],
		['CH', 'CH_VAT'],
		['NZ', 'NZ_GST'],
	]) {
		const { el } = await notice({ country, subtotal: 20, lang: 'zh' })
		assert.strictEqual(el.querySelector('.customs-id').textContent, REGISTRY.schemes[key].identifier, `${key} was altered by the localiser`)
		assert.match(el.textContent, new RegExp(`${REGISTRY.schemes[key].customs_currency} \\d`), `${key} lost its declared amount to the localiser`)
	}
})

test('the copy chip still copies the number after it has been translated', async () => {
	const { el, window } = await notice({ country: 'GB', subtotal: 20, lang: 'zh' })
	let copied = null
	window.navigator.clipboard = { writeText: async (v) => void (copied = v) }
	const chip = el.querySelector('.customs-id')
	chip.click()
	assert.strictEqual(copied, REGISTRY.schemes.UK_VAT.identifier)
	await new Promise((resolve) => window.setTimeout(resolve, 0))
	assert.strictEqual(chip.textContent, '✓ 已复制！', 'the confirmation is untranslated, or it replaced the exempt node')
	await new Promise((resolve) => window.setTimeout(resolve, 1600))
	assert.strictEqual(chip.textContent, REGISTRY.schemes.UK_VAT.identifier, 'the number did not come back after the flash')
})

test('a phrase is never a sentence with a value spliced into it', async () => {
	// A dictionary can only translate whole phrases. An amount in the middle of a
	// line splits it into two untranslatable fragments, so every figure has to sit
	// at the end of its line — this is the invariant that keeps the dictionary flat.
	for (const el of await everyNotice()) {
		for (const line of el.querySelectorAll('.customs-value, .customs-fine, .customs-guidance, .customs-notice-title')) {
			// Meaningful children only: the template's indentation is not content.
			const nodes = [...line.childNodes].filter((n) => (n.nodeType === 3 ? Boolean(n.nodeValue.trim()) : n.nodeType === 1))
			const lastValue = nodes.reduce((last, n, i) => (n.nodeType === 1 && n.tagName === 'STRONG' ? i : last), -1)
			if (lastValue < 0) continue
			const trailingText = nodes.findIndex((n, i) => i > lastValue && n.nodeType === 3)
			assert.strictEqual(trailingText, -1, `“${line.textContent.trim()}” continues in prose after a value, so neither half of it can be translated`)
		}
	}
})

group('Shipped wiring & policy')

test('the notice is rendered from the order’s destination and the server-converted declaration', () => {
	assert.ok(/customsNoticeHost\(\s*\n?\s*o\.shipping_country_iso,/.test(source), 'the notice no longer reads the order destination')
	assert.ok(source.includes('o.customs_declaration'), 'the notice no longer uses the server-converted customs amount — employees will see a blank figure')
})

test('the registry and the rate table are loaded before the first order row is painted', () => {
	assert.ok(/await Promise\.all\(\[[^\]]*loadDestinationTax\(\)/.test(source), 'orders can now render before the registry arrives, i.e. with no customs notice')
	assert.ok(/await Promise\.all\(\[[^\]]*loadExchangeRates\(\)/.test(source), 'orders can now render before the rate table arrives, i.e. every UK order showing the same ceiling')
})

test('the collapsed mobile card still defers the notice rather than losing it', () => {
	assert.ok(source.includes('#tab-orders .order-row:not(.is-open) .customs-notice'), 'the collapsed card no longer targets the notice — it would show mid-summary')
	assert.ok(!source.includes('ioss-notice'), 'the old .ioss-notice class survives somewhere and now styles nothing')
})

test('packing mode enlarges the number that gets transcribed', () => {
	assert.ok(/body\.mode-packer \.customs-id \{[\s\S]*?font-size:\s*1[5-9]px/.test(source), 'the bench no longer enlarges the identifier')
})

test('the endpoint is delegated to the packing bench, not owner-only', () => {
	const policy = require('../src/auth/policy')
	assert.strictEqual(policy.requiredCapability('GET', '/api/compliance/destination-tax'), 'app:shell')
	assert.strictEqual(policy.authorizeApi('packer', 'GET', '/api/compliance/destination-tax').allowed, true)
	assert.strictEqual(policy.authorizeApi('shopper', 'GET', '/api/compliance/destination-tax').allowed, false)
	// Read-only: nothing about this registry is editable over HTTP.
	assert.strictEqual(policy.requiredCapability('POST', '/api/compliance/destination-tax'), null)
})

test('the server derives its EU set and its shipment IOSS from this registry', () => {
	const server = fs.readFileSync(path.resolve(__dirname, '../src/server/index.js'), 'utf8')
	assert.ok(server.includes('destinationTax.EU27'), 'the server keeps its own copy of the EU27 list')
	assert.ok(server.includes('destinationTax.resolveShipmentIoss(config)'), 'the shipment no longer resolves its IOSS number through the registry')
	assert.ok(!/const _EU27 = \['DE'/.test(server), 'the hard-coded EU27 array is back in the server')
	assert.ok(server.includes('createRateStore'), 'the exchange-rate table is back to an in-memory fetch with no last-good copy')
	assert.ok(server.includes('customsDeclarationForReceipt'), 'employee order payloads no longer carry a server-converted customs amount')
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
	process.exit(0)
})()
