'use strict'

/**
 * Offline unit tests for the listing-title quality gate and the design
 * fingerprint sanitiser. No API calls, no database — pure logic, so this runs
 * in CI and on a laptop with no keys configured.
 *
 * Run: node scripts/test-title-quality.js
 */

const assert = require('assert')
const tq = require('../src/listings/title-quality')
const da = require('../src/listings/design-analyzer')

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m'

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
	try {
		fn()
		passed++
		console.log(`${GREEN}  ✓${RESET} ${name}`)
	} catch (err) {
		failed++
		failures.push({ name, err })
		console.log(`${RED}  ✗${RESET} ${name}`)
		console.log(`${DIM}      ${err.message}${RESET}`)
	}
}

function group(name) {
	console.log(`\n${BOLD}${name}${RESET}`)
}

// The exact context a strawberry case would produce.
const STRAWBERRY = tq.buildTitleContext({
	characterName: 'kawaii character',
	characterIsGeneric: true,
	designAnalysis: {
		subjectPrimary: 'Strawberry Cow',
		subjectSecondary: 'Cherry Bow',
		motifs: [
			{ term: 'strawberry', prominence: 10 },
			{ term: 'cow spots', prominence: 8 },
			{ term: 'pink bow', prominence: 6 },
			{ term: 'polka dots', prominence: 4 },
		],
		printedText: ['Berry Sweet'],
		artStyle: 'hand-drawn doodle',
		finish: 'glitter quicksand',
	},
	productSummary: {},
	devicePhrase: 'iPhone 17 16 15 14 13 Pro Max',
})

// A third-party-character case (identification does not imply authorization).
const HELLO_KITTY = tq.buildTitleContext({
	characterName: 'Hello Kitty',
	characterIsGeneric: false,
	designAnalysis: {
		subjectPrimary: 'Hello Kitty',
		subjectSecondary: '',
		motifs: [{ term: 'red bow', prominence: 9 }, { term: 'daisy', prominence: 5 }],
		printedText: [],
		artStyle: '3d puffy relief',
		finish: '',
	},
	devicePhrase: 'iPhone 17 16 15 14 13 Pro Max',
})

// A genuinely plain product — no character, no motifs.
const PLAIN = tq.buildTitleContext({ characterName: '', designAnalysis: null, productSummary: {}, devicePhrase: '' })

group('Context building')

test('extracts ranked, de-duplicated design terms', () => {
	assert.ok(STRAWBERRY.designTerms.includes('Strawberry Cow'), 'primary subject missing')
	assert.ok(STRAWBERRY.designTerms.includes('glitter quicksand'), 'finish missing')
	assert.strictEqual(STRAWBERRY.subject, 'Strawberry Cow')
	assert.strictEqual(new Set(STRAWBERRY.designTerms).size, STRAWBERRY.designTerms.length, 'terms are not unique')
})

test('an identified third-party character becomes the review subject', () => {
	assert.strictEqual(HELLO_KITTY.subject, 'Hello Kitty')
})

test('a generic character name is never used as the subject', () => {
	assert.notStrictEqual(STRAWBERRY.subject.toLowerCase(), 'kawaii character')
})

test('purely generic terms are excluded from design terms', () => {
	const ctx = tq.buildTitleContext({
		designAnalysis: { subjectPrimary: '', motifs: [{ term: 'cute design', prominence: 9 }], printedText: [], titleKeywords: [] },
	})
	assert.deepStrictEqual(ctx.designTerms, [], `expected no terms, got ${JSON.stringify(ctx.designTerms)}`)
})

group('Rejecting the boilerplate titles this work exists to kill')

// These are real titles taken from the broken run.
const BOILERPLATE = [
	'Clear Kawaii Y2K iPhone Case, Cute Aesthetic Cover for iPhone 17 16 15 14 13 Pro Max, Gift for Her, Trendy Phone Case Gift',
	'Kawaii Character Clear iPhone Case, Cute Y2K Aesthetic Cover for iPhone 17 16 15 14 13 Pro Max, Girly Gift for Her Bestie',
	'Cute Kawaii Y2K iPhone Phone Case for iPhone 17 16 15 14 13 Pro Max, Soft Silicone Aesthetic Cover, Trendy Gift for Her',
]

for (const title of BOILERPLATE) {
	test(`rejects "${title.slice(0, 44)}…"`, () => {
		const verdict = tq.scoreTitle(title, STRAWBERRY)
		assert.strictEqual(verdict.ok, false, `gate accepted a boilerplate title (score ${verdict.score})`)
		assert.ok(verdict.issues.some((i) => i.fatal), 'expected at least one fatal issue')
		assert.ok(verdict.critique.length > 10, 'expected an actionable critique')
	})
}

test('flags the "Kawaii Character" placeholder as fatal', () => {
	const verdict = tq.scoreTitle(BOILERPLATE[1], STRAWBERRY)
	assert.ok(verdict.issues.some((i) => i.code === 'placeholder_subject'), 'placeholder not detected')
})

test('flags a title that mentions none of the real design', () => {
	const verdict = tq.scoreTitle(BOILERPLATE[0], STRAWBERRY)
	assert.ok(verdict.issues.some((i) => i.code === 'design_terms_missing' || i.code === 'subject_missing'))
})

group('Accepting genuinely specific titles')

test('accepts a title built from the real design', () => {
	const title = 'Strawberry Cow iPhone Case, Glitter Quicksand Pink Cherry Bow Cover for iPhone 17 16 15 14 13 Pro Max, Kawaii Gift for Her'
	const verdict = tq.scoreTitle(title, STRAWBERRY)
	assert.strictEqual(verdict.ok, true, `gate rejected a good title (score ${verdict.score}): ${verdict.critique}`)
	assert.ok(verdict.score >= 70, `score too low: ${verdict.score}`)
	assert.ok(verdict.subjectPresent, 'subject should be detected')
})

test('accepts a third-party-character preview title that also describes the artwork', () => {
	const title = 'Hello Kitty iPhone Case with Red Bow and Daisy, 3D Puffy Relief Cover for iPhone 17 16 15 14 13 Pro Max, Cute Gift for Her'
	const verdict = tq.scoreTitle(title, HELLO_KITTY)
	assert.strictEqual(verdict.ok, true, `gate rejected a good title (score ${verdict.score}): ${verdict.critique}`)
})

test('a good title scores strictly higher than the boilerplate it replaces', () => {
	const good = tq.scoreTitle('Strawberry Cow Glitter iPhone Case, Pink Cherry Bow Polka Dot Cover for iPhone 17 16 15 14 13 Pro Max, Gift for Her', STRAWBERRY)
	const bad = tq.scoreTitle(BOILERPLATE[0], STRAWBERRY)
	assert.ok(good.score > bad.score, `good=${good.score} bad=${bad.score}`)
})

group('Edge cases and safety')

test('a plain product with no design signal is not failed forever', () => {
	const title = 'Clear Soft Silicone iPhone Case, Slim Shockproof Protective Cover for iPhone 17 16 15 14 13 Pro Max, Simple Gift for Her'
	const verdict = tq.scoreTitle(title, PLAIN)
	assert.strictEqual(verdict.evaluated, false, 'should skip specificity scoring with no signal')
	assert.strictEqual(verdict.ok, true, `unwinnable rejection (score ${verdict.score})`)
})

test('an empty title fails cleanly rather than throwing', () => {
	const verdict = tq.scoreTitle('', STRAWBERRY)
	assert.strictEqual(verdict.ok, false)
	assert.strictEqual(verdict.score, 0)
})

test('null and undefined are handled', () => {
	assert.strictEqual(tq.scoreTitle(null, STRAWBERRY).ok, false)
	assert.strictEqual(tq.scoreTitle(undefined, {}).ok, false)
	assert.doesNotThrow(() => tq.scoreTitle('Some Title', {}))
})

test('a title over Etsy\'s 140-char cap is fatal', () => {
	const verdict = tq.scoreTitle(`Strawberry Cow ${'Very Long Padding '.repeat(12)}`, STRAWBERRY)
	assert.ok(verdict.issues.some((i) => i.code === 'too_long' && i.fatal))
})

test('current Etsy guidance rewards scannable titles instead of filling 140 characters', () => {
	const concise = tq.scoreTitle('Strawberry Cow Pink Glitter iPhone Case with Cherry Bow for iPhone 17 Pro Max', {
		...STRAWBERRY,
		devicePhrase: '',
	})
	assert.ok(!concise.issues.some((i) => i.code === 'too_wordy'))
	assert.ok(!concise.issues.some((i) => i.code === 'too_short'))
	const stuffed = tq.scoreTitle('Strawberry Cow Pink Glitter Sparkle Cherry Bow Kawaii Cute Aesthetic Premium Amazing Perfect Gift iPhone Case Cover Accessory for Her Friend Sister', {
		...STRAWBERRY,
		devicePhrase: '',
	})
	assert.ok(stuffed.issues.some((i) => i.code === 'too_wordy'))
})

test('plural and singular forms match each other', () => {
	assert.ok(tq.titleContainsTerm(tq.tokenise('Pink Strawberries and Cherries Case'), 'strawberry'))
	assert.ok(tq.titleContainsTerm(tq.tokenise('Polka Dot Case'), 'polka dots'))
})

test('a multi-word term matches on its head noun', () => {
	assert.ok(tq.titleContainsTerm(tq.tokenise('Cherry Bow iPhone Case'), 'pink bow'))
})

test('an all-generic term can never match', () => {
	assert.strictEqual(tq.titleContainsTerm(tq.tokenise('Cute Kawaii Phone Case'), 'cute design'), false)
})

test('the exact device phrase is required', () => {
	const withDevice = tq.scoreTitle('Strawberry Cow Glitter Case for iPhone 17 16 15 14 13 Pro Max Pink Bow Cherry Gift Her Doodle Art', STRAWBERRY)
	const without = tq.scoreTitle('Strawberry Cow Glitter Case for iPhone 12 Pink Bow Cherry Polka Dot Doodle Gift for Her Berry Sweet', STRAWBERRY)
	assert.strictEqual(withDevice.devicePhrasePresent, true)
	assert.strictEqual(without.devicePhrasePresent, false)
})

group('Deterministic title tidy-up')

test('strips the "Kawaii Character" placeholder but keeps the adjective', () => {
	assert.strictEqual(tq.tidyTitle('Kawaii Character Clear iPhone Case'), 'Kawaii Clear iPhone Case')
})

test('removes a repeated vibe word, keeping the first', () => {
	assert.strictEqual(tq.tidyTitle('Cute Pink Case, Cute Cover'), 'Cute Pink Case, Cover')
})

test('never removes a distinct vibe word', () => {
	const out = tq.tidyTitle('Kawaii Y2K Strawberry Case')
	assert.ok(out.includes('Kawaii') && out.includes('Y2K'), out)
})

test('leaves a named franchise alone', () => {
	const out = tq.tidyTitle('Sanrio Characters iPhone Case')
	assert.ok(out.includes('Sanrio Characters'), out)
})

test('trims a dangling trailing "Gift" but keeps the first one', () => {
	assert.strictEqual(
		tq.tidyTitle('Rilakkuma Blue Polka Dot Case for iPhone 17, Gift for Her Gift'),
		'Rilakkuma Blue Polka Dot Case for iPhone 17, Gift for Her',
	)
})

test('never trims the only "Gift" in a title', () => {
	const title = 'Rilakkuma Blue Polka Dot Case for iPhone 17, Bestie Gift'
	assert.strictEqual(tq.tidyTitle(title), title)
})

test('never rewrites a mid-title repeat into something ungrammatical', () => {
	const title = 'Strawberry Case with Charm, Silicone Case for iPhone 17'
	assert.strictEqual(tq.tidyTitle(title), title)
})

test('leaves an already-clean title untouched', () => {
	const title = 'Strawberry Cow iPhone Case, Glitter Cover for iPhone 17 16 15'
	assert.strictEqual(tq.tidyTitle(title), title)
})

test('handles empty input', () => {
	assert.strictEqual(tq.tidyTitle(''), '')
	assert.strictEqual(tq.tidyTitle(null), '')
})

group('Design fingerprint sanitiser')

test('drops banned generic motifs and keeps concrete ones', () => {
	const design = da.normaliseDesign({
		visual_summary: 'A pink case with a large strawberry cow and scattered cherries.',
		subject_primary: 'Strawberry Cow',
		subject_secondary: 'cute design',
		motifs: [
			{ term: 'strawberry', prominence: 10 },
			{ term: 'cute', prominence: 9 },
			{ term: 'design', prominence: 8 },
			{ term: 'cherry', prominence: 6 },
			{ term: 'Strawberry', prominence: 3 },
		],
		printed_text: ['Berry Sweet'],
		art_style: 'hand-drawn doodle',
		finish: 'glitter quicksand',
		composition: 'centred graphic',
		color_story: 'pastel pink with red accents',
		aesthetic: 'coquette',
		differentiators: ['cow-spot pattern on the strawberry', 'cute'],
		search_phrases: ['strawberry cow phone case', 'cute case', 'pink cherry iphone case'],
		title_keywords: ['Strawberry Cow', 'Cute', 'Cherry Bow'],
		confidence: 88,
	})
	assert.ok(design, 'expected a usable fingerprint')
	const terms = design.motifs.map((m) => m.term)
	assert.ok(terms.includes('strawberry') && terms.includes('cherry'), JSON.stringify(terms))
	assert.ok(!terms.includes('cute') && !terms.includes('design'), `banned terms survived: ${JSON.stringify(terms)}`)
	assert.strictEqual(terms.length, new Set(terms).size, 'duplicate motifs survived')
	assert.ok(!design.titleKeywords.includes('Cute'), 'banned keyword survived')
	assert.ok(!design.searchPhrases.includes('cute case'), 'banned search phrase survived')
	assert.strictEqual(design.subjectSecondary, '', 'a banned secondary subject should be dropped')
	assert.strictEqual(design.confidence, 88)
})

test('motifs come back ranked by prominence', () => {
	const design = da.normaliseDesign({
		motifs: [{ term: 'daisy', prominence: 3 }, { term: 'strawberry', prominence: 9 }, { term: 'bow', prominence: 6 }],
		subject_primary: 'Strawberry', printed_text: [], differentiators: [], search_phrases: [], title_keywords: [], confidence: 50,
	})
	assert.deepStrictEqual(design.motifs.map((m) => m.term), ['strawberry', 'bow', 'daisy'])
})

test('promotes the strongest motif when the model refuses a subject', () => {
	const design = da.normaliseDesign({
		subject_primary: 'cute character',
		motifs: [{ term: 'melting smiley', prominence: 10 }],
		printed_text: [], differentiators: [], search_phrases: [], title_keywords: [], confidence: 40,
	})
	assert.strictEqual(design.subjectPrimary, 'Melting Smiley')
})

test('an all-generic fingerprint is rejected as unusable', () => {
	const design = da.normaliseDesign({
		subject_primary: 'cute', subject_secondary: 'kawaii',
		motifs: [{ term: 'design', prominence: 5 }],
		printed_text: [], art_style: '', finish: '', composition: '', color_story: '', aesthetic: '',
		differentiators: [], search_phrases: [], title_keywords: [], confidence: 20,
	})
	assert.strictEqual(da.isUsableDesign(design), false)
})

test('malformed model output does not throw', () => {
	assert.strictEqual(da.normaliseDesign(null), null)
	assert.strictEqual(da.normaliseDesign('nonsense'), null)
	assert.doesNotThrow(() => da.normaliseDesign({}))
	assert.doesNotThrow(() => da.normaliseDesign({ motifs: [null, {}, { term: 5 }], printed_text: [null] }))
})

group('Design image selection')

test('always leads with the thumbnail and skips edge/accessory shots', () => {
	const images = Array.from({ length: 6 }, (_, i) => ({ path: `${i + 1}.jpg`, mime: 'image/jpeg' }))
	const analysis = [
		{ index: 1, thumbnail_quality: 4, has_case: true },
		{ index: 2, thumbnail_quality: 9, has_case: false },   // accessory only
		{ index: 3, thumbnail_quality: 9, has_case: true, is_edge_or_profile: true },
		{ index: 4, thumbnail_quality: 8, has_case: true },
		{ index: 5, thumbnail_quality: 7, has_case: true },
		{ index: 6, thumbnail_quality: 2, has_case: true },
	]
	const picked = da.pickDesignImages(images, analysis, 3).map((p) => p.rank)
	assert.strictEqual(picked[0], 1, 'thumbnail must lead')
	assert.deepStrictEqual(picked, [1, 4, 5], JSON.stringify(picked))
})

test('works with no Phase 1 analysis at all', () => {
	const images = [{ path: 'a.jpg' }, { path: 'b.jpg' }]
	assert.strictEqual(da.pickDesignImages(images, [], 4).length, 2)
	assert.strictEqual(da.pickDesignImages([], [], 4).length, 0)
})

group('Design facts block')

test('renders the fingerprint for the copy prompt', () => {
	const design = da.normaliseDesign({
		visual_summary: 'A pink case with a strawberry cow.',
		subject_primary: 'Strawberry Cow', subject_secondary: '',
		motifs: [{ term: 'strawberry', prominence: 10 }],
		printed_text: ['Berry Sweet'], art_style: 'hand-drawn doodle', finish: 'glitter quicksand',
		composition: 'centred graphic', color_story: 'pastel pink', aesthetic: 'coquette',
		differentiators: ['cow-spot strawberry'], search_phrases: ['strawberry cow phone case'],
		title_keywords: ['Strawberry Cow'], confidence: 90,
	})
	const block = da.designFactsBlock(design)
	assert.ok(block.includes('Strawberry Cow'))
	assert.ok(block.includes('Berry Sweet'))
	assert.ok(block.includes('glitter quicksand'))
	assert.strictEqual(da.designFactsBlock(null), '')
})

group('Legacy summary merge')

test('mirrors the fingerprint onto the legacy design_* fields', () => {
	const summary = { design_subject: '', design_motifs: ['pink'], design_features: 'clear back' }
	const design = da.normaliseDesign({
		subject_primary: 'Strawberry Cow',
		motifs: [{ term: 'strawberry', prominence: 10 }, { term: 'cherry', prominence: 7 }],
		printed_text: ['Berry Sweet'], art_style: 'doodle', finish: 'glitter', composition: 'centred',
		color_story: 'pink', aesthetic: 'coquette', differentiators: [], search_phrases: [], title_keywords: [], confidence: 80,
	})
	da.applyDesignToSummary(summary, design)
	assert.strictEqual(summary.design_subject, 'Strawberry Cow')
	assert.ok(summary.design_motifs.includes('strawberry'))
	assert.strictEqual(summary.design_aesthetic, 'coquette')
	assert.ok(summary.design_features.includes('clear back'), 'must not discard existing features')
	assert.ok(summary.design_features.includes('Berry Sweet'))
})

test('leaves the summary untouched when there is no usable fingerprint', () => {
	const summary = { design_subject: 'Existing', design_motifs: ['bow'] }
	da.applyDesignToSummary(summary, null)
	assert.strictEqual(summary.design_subject, 'Existing')
	assert.deepStrictEqual(summary.design_motifs, ['bow'])
})

group('Copy-model vision capability detection')

const { modelAcceptsImages, coerceToSchemaShape } = require('../src/listings/ai-generator')

test('recognises vision-capable models', () => {
	for (const m of ['gpt-5.4-mini', 'gpt-4o', 'gpt-4.1', 'qwen/qwen3.7-plus', 'gemini-2.5-pro', 'claude-sonnet-4']) {
		assert.strictEqual(modelAcceptsImages(m), true, `${m} should be vision-capable`)
	}
})

test('is conservative about unknown or text-only models', () => {
	for (const m of ['', null, 'text-davinci-003', 'mistral-7b-instruct', 'some-unknown-model']) {
		assert.strictEqual(modelAcceptsImages(m), false, `${m} should NOT be treated as vision-capable`)
	}
})

group('Structured-output array unwrapping')
// Regression guard: Qwen returned a valid object wrapped in a one-element array,
// which silently nulled out every vision pass. This must never regress quietly.

const OBJ_SCHEMA = { schema: { type: 'object', required: ['visual_summary', 'motifs'] } }

test('unwraps a single-element array when the schema wants an object', () => {
	const payload = { visual_summary: 'a', motifs: ['b'] }
	assert.deepStrictEqual(coerceToSchemaShape([payload], OBJ_SCHEMA), payload)
})

test('leaves a plain object alone', () => {
	const payload = { visual_summary: 'a', motifs: ['b'] }
	assert.strictEqual(coerceToSchemaShape(payload, OBJ_SCHEMA), payload)
})

test('picks the best-matching object when the model returns several', () => {
	const noise = { note: 'thinking out loud' }
	const real = { visual_summary: 'a', motifs: ['b'] }
	assert.deepStrictEqual(coerceToSchemaShape([noise, real], OBJ_SCHEMA), real)
})

test('never unwraps when the schema legitimately wants an array', () => {
	const arraySchema = { schema: { type: 'array' } }
	const payload = [{ a: 1 }]
	assert.strictEqual(coerceToSchemaShape(payload, arraySchema), payload)
})

test('passes through arrays with no usable object so validation can reject', () => {
	const payload = ['nope']
	assert.strictEqual(coerceToSchemaShape(payload, OBJ_SCHEMA), payload)
})

test('tolerates a missing or malformed schema', () => {
	assert.deepStrictEqual(coerceToSchemaShape([{ a: 1 }], null), [{ a: 1 }])
	assert.deepStrictEqual(coerceToSchemaShape([{ a: 1 }], {}), [{ a: 1 }])
})

test('handles an empty array without throwing', () => {
	assert.deepStrictEqual(coerceToSchemaShape([], OBJ_SCHEMA), [])
})

// ── Summary ──────────────────────────────────────────────────────────────────
console.log()
if (failed) {
	console.log(`${RED}${BOLD}  ${failed} test(s) failed${RESET}, ${passed} passed`)
	for (const f of failures) console.log(`${DIM}  · ${f.name}: ${f.err.message}${RESET}`)
	process.exit(1)
}
console.log(`${GREEN}${BOLD}  All ${passed} tests passed.${RESET}`)
console.log()
