'use strict'
/**
 * Tests for declaring that a product has NO character.
 *
 * The vision pass is far more likely to read a plain pastel print as a licensed
 * mascot than it is to confuse two real mascots — a white wing charm becomes
 * Cinnamoroll, a rabbit silhouette becomes Miffy. Until now the Inspector had no
 * way to say "there is no character here": the operator had to know that typing
 * the exact phrase "kawaii character" into the free-text box was the magic
 * incantation that the pipeline treats as generic.
 *
 * Getting this wrong is expensive in both directions. A false character puts a
 * rights holder's name in the title and tags of a listing that does not depict
 * it, and it starves the copy of the real search terms (cherries, pearl charm,
 * pastel stripes) that would actually rank.
 *
 * Three layers:
 *
 *  1. THE PICKER    — the option markup, extracted from the shipped page between
 *                     its sentinels so these tests exercise the real source.
 *  2. THE CHOICE    — the select and the free-text box driven through jsdom,
 *                     because "what does the operator's click actually send" is
 *                     a DOM question.
 *  3. THE SERVER    — resolveOperatorCharacter: what an explicit choice means to
 *                     the copy pipeline, and specifically that declaring "none"
 *                     clears the stale franchise rather than keeping it.
 *
 * Run: `node scripts/test-character-picker.js`
 */

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const { resolveOperatorCharacter, isGenericName } = require('../src/listings/ai-generator')

let JSDOM = null
try {
	;({ JSDOM } = require('jsdom'))
} catch {
	/* the DOM group is skipped below */
}

const GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m', DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m'
let passed = 0, failed = 0, skipped = 0
const failures = []
const pending = []
function group(name) { pending.push({ group: name }) }
function test(name, fn) { pending.push({ name, fn }) }
function skip(name, why) { pending.push({ name, skip: why }) }

// ── Load the picker out of the shipped page ──────────────────────────────────
const HTML = path.resolve(__dirname, '../public/index.html')
const source = fs.readFileSync(HTML, 'utf8')
const START = '// ══ CHARACTER PICKER ══'
const END = '// ══ END CHARACTER PICKER ══'
const a = source.indexOf(START)
const b = source.indexOf(END)
if (a < 0 || b < 0 || b <= a) {
	console.error(`${RED}Could not locate the character-picker sentinels in public/index.html.${RESET}`)
	console.error(`${DIM}Expected "${START}" … "${END}".${RESET}`)
	process.exit(1)
}
const PICKER_SOURCE = source.slice(a, b)

/** The escaper the picker builds its markup with, also taken from the page. */
function extractFunction(src, name) {
	const start = src.indexOf(`function ${name}(`)
	if (start < 0) return null
	const open = src.indexOf('{', start)
	let depth = 0
	for (let i = open; i < src.length; i++) {
		if (src[i] === '{') depth++
		else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1)
	}
	return null
}
const escHtml = vm.runInThisContext(
	`(function(){${extractFunction(source, 'toDisplayString')}\n${extractFunction(source, 'escHtml')}\nreturn escHtml})()`,
)

/**
 * Instantiate the picker against a catalog fixture and an optional document.
 * The block reads `_bulkCharCatalog`, `escHtml` and `document` from its
 * surrounding scope on the page, so the wrapper supplies exactly those.
 */
function loadPicker({ catalog = null, document = null } = {}) {
	return vm.runInThisContext(
		`(function (escHtml, document, _bulkCharCatalog) {\n${PICKER_SOURCE}\n` +
			'return { BULK_GENERIC_CHARACTER, bulkIsGenericCharacter, bulkCharSelectHtml, bulkCharSelectChange, bulkChosenCharacter }\n})',
		{ filename: 'public/index.html (character picker)' },
	)(escHtml, document, catalog)
}

const CATALOG = {
	characters: [{ name: 'Kuromi', franchise: 'Sanrio' }, { name: 'Cinnamoroll', franchise: 'Sanrio' }],
	by_franchise: { Sanrio: ['Cinnamoroll', 'Kuromi'], 'San-X': ['Rilakkuma'] },
}
const picker = loadPicker({ catalog: CATALOG })
const { BULK_GENERIC_CHARACTER, bulkIsGenericCharacter, bulkCharSelectHtml } = picker

/** Every <option> in a rendered picker, as { value, label, selected }. */
function options(html) {
	const out = []
	const re = /<option value="([^"]*)"( selected)?>([^<]*)<\/option>/g
	let m
	while ((m = re.exec(html))) out.push({ value: m[1], selected: Boolean(m[2]), label: m[3] })
	return out
}
const selectedOf = (html) => (options(html).find((o) => o.selected) || {}).value
const valuesOf = (html) => options(html).map((o) => o.value)

// ── 1. The picker ────────────────────────────────────────────────────────────
group('The picker offers an explicit "no character" choice')

test('the generic option exists and carries the pipeline\'s sentinel', () => {
	const html = bulkCharSelectHtml({ character: 'Kuromi' }, [])
	const generic = options(html).find((o) => o.value === BULK_GENERIC_CHARACTER)
	assert.ok(generic, 'there is no way to say "no character"')
	assert.strictEqual(BULK_GENERIC_CHARACTER, 'kawaii character', 'the sentinel drifted from the one the server understands')
	assert.ok(/no character/i.test(generic.label), `the option does not read as "no character": ${generic.label}`)
})

test('it sits above the catalog so the commonest correction needs no scrolling', () => {
	const values = valuesOf(bulkCharSelectHtml({ character: 'Kuromi' }, [{ name: 'Cinnamoroll', confidence: 40 }]))
	assert.strictEqual(values[0], '', 'the placeholder is no longer first')
	assert.strictEqual(values[1], BULK_GENERIC_CHARACTER, 'the generic is not the first real choice')
	assert.ok(values.indexOf('Rilakkuma') > 1, 'the catalog came before the generic')
	assert.strictEqual(values[values.length - 1], '__custom__', 'custom is no longer the escape hatch at the bottom')
})

test('a wrongly detected character is still pre-selected, with the generic one click away', () => {
	// The screenshot case: "Cinnamoroll 92%" on a case that is only stripes and
	// stars. The picker must not silently overrule the model — just offer the out.
	const html = bulkCharSelectHtml({ character: 'Cinnamoroll', characterDetected: 'Cinnamoroll' }, [])
	assert.strictEqual(selectedOf(html), 'Cinnamoroll')
	assert.ok(valuesOf(html).includes(BULK_GENERIC_CHARACTER))
})

test('a resolved generic pre-selects the option instead of falling to custom', () => {
	// This is what used to render as "✏️ Custom" with "kawaii character" typed
	// into the box, which read as though a human had entered it.
	const html = bulkCharSelectHtml({ character: 'kawaii character', characterDetected: '' }, [])
	assert.strictEqual(selectedOf(html), BULK_GENERIC_CHARACTER)
})

test('a generic effective name still surfaces the model\'s specific guess', () => {
	// Low confidence: the title defaulted to generic, but Phase 1 did have a
	// candidate. Offering it remains the more useful default.
	const html = bulkCharSelectHtml({ character: 'kawaii character', characterDetected: 'Miffy' }, [])
	assert.strictEqual(selectedOf(html), 'Miffy')
})

test('nothing known at all still falls back to custom', () => {
	assert.strictEqual(selectedOf(bulkCharSelectHtml({}, [])), '__custom__')
})

test('exactly one option is ever pre-selected', () => {
	const cases = [
		{ character: 'Kuromi' }, { character: 'kawaii character' }, {},
		{ character: 'kawaii character', characterDetected: 'Miffy' },
		{ character: 'Cinnamoroll', characterDetected: 'Cinnamoroll' },
	]
	for (const p of cases) {
		const chosen = options(bulkCharSelectHtml(p, [])).filter((o) => o.selected)
		assert.strictEqual(chosen.length, 1, `${JSON.stringify(p)} pre-selected ${chosen.length} options`)
	}
})

test('the generic is never offered twice as an "AI suggestion"', () => {
	const html = bulkCharSelectHtml(
		{ character: 'kawaii character', characterDetected: 'unknown' },
		[{ name: 'Various', confidence: 20 }, { name: 'Kuromi', confidence: 55 }],
	)
	// The placeholder and the custom escape hatch are not character choices.
	const generics = options(html)
		.filter((o) => o.value && o.value !== '__custom__')
		.filter((o) => bulkIsGenericCharacter(o.value))
	assert.deepStrictEqual(generics.map((o) => o.value), [BULK_GENERIC_CHARACTER], 'a generic name leaked into the suggestions')
})

test('the picker renders without a catalog (the fetch can fail)', () => {
	const bare = loadPicker({ catalog: null })
	const html = bare.bulkCharSelectHtml({ character: 'kawaii character' }, [])
	assert.strictEqual(selectedOf(html), BULK_GENERIC_CHARACTER, 'the generic must survive a catalog outage')
})

test('the UI and the server agree on what counts as generic', () => {
	// A divergence here means the picker offers a "character" the server discards,
	// or hides a real one behind the generic option.
	const vocabulary = [
		'kawaii character', 'Kawaii Character', 'unknown', 'Unknown', 'generic', 'none', 'None',
		'n/a', 'various', '', '  ',
		'Kuromi', 'Hello Kitty', 'Cinnamoroll', 'Totoro', 'Pikachu', 'Nonna', 'Generico',
	]
	for (const word of vocabulary) {
		assert.strictEqual(
			bulkIsGenericCharacter(word),
			isGenericName(word),
			`"${word}": the picker says ${bulkIsGenericCharacter(word) ? 'generic' : 'specific'}, the server disagrees`,
		)
	}
})

// ── 2. What the click actually sends ─────────────────────────────────────────
group('The operator\'s choice reaches the request intact')

/** A document holding the rendered picker plus the free-text box beside it. */
function mountPicker(preview, customSeed = '') {
	const dom = new JSDOM('<!doctype html><body></body>')
	const doc = dom.window.document
	const mounted = loadPicker({ catalog: CATALOG, document: doc })
	doc.body.innerHTML =
		mounted.bulkCharSelectHtml(preview, []) +
		`<input id="binsCharInput" type="text" value="${customSeed}" style="display:none">`
	return { doc, ...mounted }
}

if (!JSDOM) {
	skip('the operator\'s choice reaches the request intact', 'jsdom is not installed')
} else {
	test('picking "no character" sends the generic sentinel', () => {
		const { doc, bulkChosenCharacter, bulkCharSelectChange } = mountPicker({ character: 'Cinnamoroll' })
		doc.getElementById('binsCharSelect').value = BULK_GENERIC_CHARACTER
		bulkCharSelectChange()
		assert.strictEqual(bulkChosenCharacter(), 'kawaii character')
	})

	test('picking it hides the free-text box rather than asking for a name', () => {
		const { doc, bulkCharSelectChange } = mountPicker({ character: 'Cinnamoroll' })
		doc.getElementById('binsCharSelect').value = BULK_GENERIC_CHARACTER
		bulkCharSelectChange()
		assert.strictEqual(doc.getElementById('binsCharInput').style.display, 'none')
	})

	test('an already-generic item opens on the option, box hidden, ready to regenerate', () => {
		const { doc, bulkChosenCharacter, bulkCharSelectChange } = mountPicker({ character: 'kawaii character' })
		bulkCharSelectChange() // the Inspector calls this once after rendering
		assert.strictEqual(doc.getElementById('binsCharSelect').value, BULK_GENERIC_CHARACTER)
		assert.strictEqual(doc.getElementById('binsCharInput').style.display, 'none')
		assert.strictEqual(bulkChosenCharacter(), 'kawaii character')
	})

	test('a real character is still sent as itself', () => {
		const { doc, bulkChosenCharacter } = mountPicker({ character: 'Cinnamoroll' })
		doc.getElementById('binsCharSelect').value = 'Kuromi'
		assert.strictEqual(bulkChosenCharacter(), 'Kuromi')
	})

	test('custom still wins when it is the selection', () => {
		const { doc, bulkChosenCharacter, bulkCharSelectChange } = mountPicker({}, 'Hatsune Miku')
		doc.getElementById('binsCharSelect').value = '__custom__'
		bulkCharSelectChange()
		assert.strictEqual(doc.getElementById('binsCharInput').style.display, '')
		assert.strictEqual(bulkChosenCharacter(), 'Hatsune Miku')
	})
}

// ── 3. What the server does with it ──────────────────────────────────────────
group('Declaring "no character" is a decision, not a missing answer')

const STALE = { character_franchise: 'Sanrio', character_name: 'Cinnamoroll' }

test('the generic choice resolves to the sentinel the copy pipeline understands', () => {
	const c = resolveOperatorCharacter('kawaii character', STALE)
	assert.strictEqual(c.characterName, 'kawaii character')
	assert.ok(isGenericName(c.characterName), 'the copy pass would treat this as a real character')
})

test('it clears the franchise the vision pass had guessed', () => {
	// The bug this pins: without it, a listing the operator just declared
	// character-free keeps "Sanrio" on it, because the old code fell back to
	// productSummary.character_franchise whenever the override had none.
	assert.strictEqual(resolveOperatorCharacter('kawaii character', STALE).characterFranchise, '')
})

test('it clears the rejected detection instead of re-offering it', () => {
	const c = resolveOperatorCharacter('kawaii character', STALE)
	assert.strictEqual(c.characterDetected, '')
	assert.deepStrictEqual(c.characterAlternatives, [])
})

test('it settles the question — no low-confidence warning survives', () => {
	const c = resolveOperatorCharacter('kawaii character', STALE)
	assert.strictEqual(c.characterLowConfidence, false)
	assert.strictEqual(c.characterConfidence, 100)
	assert.ok(/operator/i.test(c.characterEvidence), `the evidence does not credit the operator: ${c.characterEvidence}`)
})

test('the whole generic vocabulary means the same thing', () => {
	// An operator who types "none" into the free-text box must get the same
	// result as one who picks the dedicated option.
	for (const word of ['kawaii character', 'None', 'unknown', 'n/a', 'Various', '  generic  ']) {
		const c = resolveOperatorCharacter(word, STALE)
		assert.strictEqual(c.characterName, 'kawaii character', `"${word}" was taken as a real character`)
		assert.strictEqual(c.characterFranchise, '', `"${word}" kept a stale franchise`)
	}
})

test('a real character override is unaffected, and gains its catalog franchise', () => {
	const c = resolveOperatorCharacter('Kuromi', { character_franchise: 'Sanrio' })
	assert.strictEqual(c.characterName, 'Kuromi')
	assert.strictEqual(c.characterDetected, 'Kuromi')
	assert.strictEqual(c.characterFranchise, 'Sanrio')
	assert.strictEqual(c.characterConfidence, 100)
	assert.strictEqual(c.characterLowConfidence, false)
})

test('an off-catalog character keeps the vision pass\'s franchise as a fallback', () => {
	const c = resolveOperatorCharacter('Hatsune Miku', { character_franchise: 'Crypton' })
	assert.strictEqual(c.characterName, 'Hatsune Miku')
	assert.strictEqual(c.characterFranchise, 'Crypton')
})

test('no override at all means "let the vision passes decide"', () => {
	for (const nothing of [undefined, null, '', '   ', {}, [], 0, false]) {
		assert.strictEqual(resolveOperatorCharacter(nothing, STALE), null, `${JSON.stringify(nothing)} was taken as an override`)
	}
})

test('a value with no letters in it is not a name', () => {
	// This is the gate between an HTTP body and a word that gets printed in a
	// listing title — "0" must never become the character a listing is sold as.
	for (const nameless of [0, 42, '123', '---', '   ??   ', '★']) {
		assert.strictEqual(resolveOperatorCharacter(nameless, STALE), null, `${JSON.stringify(nameless)} was accepted as a character`)
	}
	// …but a name in any script is fine.
	assert.strictEqual(resolveOperatorCharacter('初音ミク').characterName, '初音ミク')
	assert.strictEqual(resolveOperatorCharacter('2B').characterName, '2B')
})

test('a malformed override cannot become a character named "[object Object]"', () => {
	assert.strictEqual(resolveOperatorCharacter({ type: 'string' }, STALE), null)
	assert.strictEqual(resolveOperatorCharacter('[object Object]', STALE), null)
})

test('it works with no product summary at all', () => {
	assert.doesNotThrow(() => resolveOperatorCharacter('Kuromi'))
	assert.strictEqual(resolveOperatorCharacter('Kuromi').characterFranchise, 'Sanrio')
	assert.strictEqual(resolveOperatorCharacter('Hatsune Miku').characterFranchise, '')
})

// ── 4. The round trip ────────────────────────────────────────────────────────
group('Round trip — the choice survives a regenerate and reopens as itself')

test('the server\'s answer re-renders as the selected "no character" option', () => {
	// resolveOperatorCharacter's block is written onto the preview by the
	// regenerate path, which is what the Inspector reads when it reopens.
	const resolved = resolveOperatorCharacter('kawaii character', STALE)
	const preview = {
		character: resolved.characterName,
		characterDetected: resolved.characterDetected,
		characterFranchise: resolved.characterFranchise,
		characterLowConfidence: resolved.characterLowConfidence,
	}
	const html = bulkCharSelectHtml(preview, resolved.characterAlternatives)
	assert.strictEqual(selectedOf(html), BULK_GENERIC_CHARACTER, 'reopening lost the operator\'s decision')
	assert.strictEqual(preview.characterFranchise, '', 'a franchise chip would still render')
})

test('a named override round-trips to its own option too', () => {
	const resolved = resolveOperatorCharacter('Kuromi', STALE)
	const html = bulkCharSelectHtml({ character: resolved.characterName, characterDetected: resolved.characterDetected }, [])
	assert.strictEqual(selectedOf(html), 'Kuromi')
})

// ── Runner ───────────────────────────────────────────────────────────────────
;(async () => {
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

	console.log()
	if (failed) {
		console.log(`${RED}${BOLD}  ${failed} test(s) failed${RESET}, ${passed} passed${skipped ? `, ${skipped} skipped` : ''}`)
		for (const f of failures) console.log(`${DIM}  · ${f.name}: ${f.err.message}${RESET}`)
		process.exit(1)
	}
	console.log(`${GREEN}${BOLD}  All ${passed} tests passed.${RESET}${skipped ? ` ${DIM}(${skipped} skipped)${RESET}` : ''}`)
	console.log()
})()
