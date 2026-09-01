'use strict'
/**
 * Tests for the defences against malformed vision-model responses.
 *
 * The production incident these pin down: a provider answered the Phase-1 schema
 * with the schema fragment itself in two scalar slots —
 *
 *   { "character_name": {"type":"string"}, "character_franchise": {"type":"string"} }
 *
 * `character_name` hit a bare String() and became the literal "[object Object]".
 * `character_franchise` was never coerced at all, so a live object was persisted
 * into preview_json and reached the Inspector's HTML escaper, which called
 * .replace() on it and threw "str.replace is not a function" — blanking the
 * whole panel for every product in a 37-item run.
 *
 * Five layers are covered, in the order a bad value would travel through them:
 *
 *  1. MODEL BOUNDARY  — coerceToSchemaShape drops the echo before it enters.
 *  2. CHARACTER LOGIC — resolveCharacter yields strings whatever it is handed.
 *  3. PRIMITIVES      — plainText's definition of "usable as text".
 *  4. READ PATH       — buildItemDetail heals previews written before layer 1
 *                       existed, over a real database, with no migration.
 *  5. THE ESCAPER     — escHtml, extracted from the shipped page, can no longer
 *                       take a render down no matter what it is handed.
 *
 * Run: `node scripts/test-preview-sanitize.js`
 */

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const { plainText, plainTextList, scrubSchemaEchoes, sanitisePreview } = require('../src/listings/sanitize')
const { coerceToSchemaShape, resolveCharacter, PHASE1_SCHEMA } = require('../src/listings/ai-generator')

let Database = null
try {
	Database = require('better-sqlite3')
} catch {
	/* the read-path group is skipped below */
}

const GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m', DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m'
let passed = 0, failed = 0, skipped = 0
const failures = []
const pending = []
function group(name) { pending.push({ group: name }) }
function test(name, fn) { pending.push({ name, fn }) }
function skip(name, why) { pending.push({ name, skip: why }) }

// ── Load the shipped escaper out of public/index.html ────────────────────────
// Extracted from the real page rather than copied, so this test fails if anyone
// reintroduces a version that throws.
const HTML = path.resolve(__dirname, '../public/index.html')
const source = fs.readFileSync(HTML, 'utf8')

/** Slice out a top-level `function <name>(…) { … }` by matching its braces. */
function extractFunction(src, name) {
	const start = src.indexOf(`function ${name}(`)
	if (start < 0) return null
	const open = src.indexOf('{', start)
	if (open < 0) return null
	let depth = 0
	for (let i = open; i < src.length; i++) {
		if (src[i] === '{') depth++
		else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1)
	}
	return null
}

const ESCAPER_FUNCTIONS = ['toDisplayString', 'escHtml', 'escAttr']
const escaperSource = ESCAPER_FUNCTIONS.map((name) => {
	const fn = extractFunction(source, name)
	if (!fn) {
		console.error(`${RED}Could not locate function ${name}() in public/index.html.${RESET}`)
		process.exit(1)
	}
	return fn
}).join('\n')
const { escHtml, escAttr } = vm.runInThisContext(
	`(function () {\n${escaperSource}\nreturn { escHtml, escAttr }\n})`,
	{ filename: 'public/index.html (escapers)' },
)()

// Everything an escaper could plausibly — or implausibly — be handed. Labelled
// because several of these cannot be stringified for an assertion message.
const HOSTILE_VALUES = [
	['undefined', undefined], ['null', null], ['0', 0], ['1', 1], ['NaN', NaN], ['Infinity', Infinity],
	['true', true], ['false', false], ['empty string', ''], ['{}', {}], ['[]', []],
	['a schema echo', { type: 'string' }], ['[1,2,3]', [1, 2, 3]], ['a function', () => {}],
	['a Date', new Date(0)], ['a RegExp', /re/], ['a Symbol', Symbol('x')], ['a BigInt', 10n],
	['a null-prototype object', Object.create(null)], ['a custom toString', { toString: () => '<b>' }],
	['a throwing Symbol.toPrimitive', { [Symbol.toPrimitive]() { throw new Error('nope') } }],
]

// The exact shape recovered from the failing run, kept verbatim as the fixture
// so a regression reproduces the original bug rather than an approximation.
const realWorldPreview = () => ({
	title: 'Pink Cherries Clear Translucent Pearl Charm AirPods Case with Charm',
	description: 'Pink Cherries with a glossy cherry dangle charm.',
	tags: ['kawaiiiphonecases', 'airpods case'],
	primaryColor: 'Clear',
	secondaryColor: 'Pink',
	character: 'kawaii character',
	characterDetected: '[object Object]',
	characterFranchise: { type: 'string' },
	characterConfidence: 0,
	characterEvidence: 'No character is depicted.',
	characterAlternatives: [],
	characterLowConfidence: true,
	currency: 'HKD',
	images: [{ rank: 1, filename: '1.jpg' }],
	settings: { who_made: 'i_did', when_made: 'made_to_order', materials: ['Silicone'] },
})

// ── 1. The model boundary ────────────────────────────────────────────────────
group('Model boundary — schema echoes never enter the pipeline')

test('a scalar slot filled with its own schema fragment is dropped', () => {
	const parsed = coerceToSchemaShape(
		{ product_summary: { character_name: { type: 'string' }, character_franchise: { type: 'string' }, character_evidence: 'A cherry print.' } },
		PHASE1_SCHEMA,
	)
	assert.ok(!('character_name' in parsed.product_summary), 'the echoed name survived')
	assert.ok(!('character_franchise' in parsed.product_summary), 'the echoed franchise survived')
	assert.strictEqual(parsed.product_summary.character_evidence, 'A cherry print.', 'a good field was collateral damage')
})

test('genuine values are never touched', () => {
	const summary = {
		character_name: 'Kuromi',
		character_franchise: 'Sanrio',
		character_confidence: 92,
		character_evidence: 'Black jester hood, pink skull.',
		case_primary_color: 'Black',
	}
	const parsed = coerceToSchemaShape({ product_summary: { ...summary } }, PHASE1_SCHEMA)
	assert.deepStrictEqual(parsed.product_summary, summary)
})

test('coercible-but-mistyped scalars are left for the existing call sites', () => {
	// "92" and 2025 are recoverable by the Number()/String() the pipeline already
	// does. Deleting them would lose a real answer, so the scrubber must not.
	const parsed = coerceToSchemaShape(
		{ product_summary: { character_confidence: '92', character_name: 2025 } },
		PHASE1_SCHEMA,
	)
	assert.strictEqual(parsed.product_summary.character_confidence, '92')
	assert.strictEqual(parsed.product_summary.character_name, 2025)
})

test('an echo nested inside an array of objects is dropped', () => {
	const parsed = coerceToSchemaShape(
		{ product_summary: { character_alternatives: [{ name: { type: 'string' }, confidence: 40 }, { name: 'Melody', confidence: 30 }] } },
		PHASE1_SCHEMA,
	)
	const [bad, good] = parsed.product_summary.character_alternatives
	assert.ok(!('name' in bad), 'the echoed alternative name survived')
	assert.strictEqual(bad.confidence, 40, 'a sibling field was lost')
	assert.deepStrictEqual(good, { name: 'Melody', confidence: 30 })
})

test('containers are filtered out of a scalar-item array', () => {
	const parsed = coerceToSchemaShape(
		{ product_summary: { design_motifs: ['cherry', { type: 'string' }, 'star', ['nested']] } },
		PHASE1_SCHEMA,
	)
	assert.deepStrictEqual(parsed.product_summary.design_motifs, ['cherry', 'star'])
})

test('the array-unwrapping defence still works, and scrubs the unwrapped object', () => {
	const parsed = coerceToSchemaShape([{ product_summary: { character_franchise: { type: 'string' }, character_name: 'Miffy' } }], PHASE1_SCHEMA)
	assert.ok(!Array.isArray(parsed), 'the single-element array was not unwrapped')
	assert.strictEqual(parsed.product_summary.character_name, 'Miffy')
	assert.ok(!('character_franchise' in parsed.product_summary), 'the unwrapped object was not scrubbed')
})

test('scrubbing survives payloads the schema does not describe', () => {
	for (const odd of [null, undefined, 42, 'text', [], {}]) {
		assert.doesNotThrow(() => scrubSchemaEchoes(odd, PHASE1_SCHEMA.schema), `threw on ${JSON.stringify(odd)}`)
	}
	assert.doesNotThrow(() => scrubSchemaEchoes({ a: 1 }, null))
	assert.doesNotThrow(() => scrubSchemaEchoes({ a: 1 }, { type: 'object' }), 'a schema with no properties')
})

// ── 2. Character resolution ──────────────────────────────────────────────────
group('Character resolution — always yields strings')

test('a poisoned Phase-1 summary resolves to clean, generic copy', async () => {
	const character = await resolveCharacter(null, {
		images: [],
		imageAnalysis: [],
		productSummary: {
			character_name: { type: 'string' },
			character_franchise: { type: 'string' },
			character_evidence: { type: 'string' },
			character_confidence: 0,
			character_alternatives: [{ name: { type: 'string' }, confidence: 20 }],
		},
	})
	for (const field of ['characterName', 'characterDetected', 'characterFranchise', 'characterEvidence']) {
		assert.strictEqual(typeof character[field], 'string', `${field} is not a string`)
		assert.ok(!/\[object /.test(character[field]), `${field} leaked a stringified object: ${character[field]}`)
	}
	assert.strictEqual(character.characterName, 'kawaii character', 'garbage was promoted to a real character name')
	assert.strictEqual(character.characterFranchise, '')
	assert.deepStrictEqual(character.characterAlternatives, [], 'an unusable alternative was kept')
})

test('the literal string "[object Object]" is not accepted as a name either', async () => {
	// Historic runs stored this after a bare String() coercion; re-generating
	// from cached analysis must not launder it back into the copy.
	const character = await resolveCharacter(null, {
		images: [],
		imageAnalysis: [],
		productSummary: { character_name: '[object Object]', character_confidence: 90 },
	})
	assert.strictEqual(character.characterName, 'kawaii character')
	assert.strictEqual(character.characterDetected, '')
})

test('a real character still resolves normally', async () => {
	const character = await resolveCharacter(null, {
		images: [],
		imageAnalysis: [],
		productSummary: { character_name: 'Kuromi', character_franchise: 'Sanrio', character_confidence: 95, character_evidence: 'Jester hood.' },
	})
	assert.strictEqual(character.characterName, 'Kuromi')
	assert.strictEqual(character.characterFranchise, 'Sanrio')
	assert.strictEqual(character.characterEvidence, 'Jester hood.')
})

// ── 3. The primitives ────────────────────────────────────────────────────────
group('plainText — one definition of "usable as text"')

test('content passes through, trimmed', () => {
	assert.strictEqual(plainText('  Sanrio  '), 'Sanrio')
	assert.strictEqual(plainText('Hello Kitty'), 'Hello Kitty')
})

test('finite numbers are content', () => {
	assert.strictEqual(plainText(2025), '2025')
	assert.strictEqual(plainText(0), '0')
	assert.strictEqual(plainText(-1.5), '-1.5')
})

test('everything that carries no content becomes an empty string', () => {
	for (const empty of [null, undefined, {}, [], { type: 'string' }, NaN, Infinity, true, false, () => {}, Symbol('x')]) {
		assert.strictEqual(plainText(empty), '', `${String(empty)} was treated as content`)
	}
})

test('the stringified-object artefact is treated as absence', () => {
	assert.strictEqual(plainText('[object Object]'), '')
	assert.strictEqual(plainText('  [object Object]  '), '')
	assert.strictEqual(plainText('[object Array]'), '')
	// …but a legitimate string that merely mentions it is content.
	assert.strictEqual(plainText('Debugging [object Object] errors'), 'Debugging [object Object] errors')
})

test('plainTextList keeps only usable entries', () => {
	assert.deepStrictEqual(plainTextList(['cherry', '', { type: 'string' }, '  star  ', null, 7]), ['cherry', 'star', '7'])
	assert.deepStrictEqual(plainTextList('not an array'), [])
	assert.deepStrictEqual(plainTextList(undefined), [])
})

// ── 4. Preview healing ───────────────────────────────────────────────────────
group('sanitisePreview — healing what is already on disk')

test('the exact payload from the failing run comes out renderable', () => {
	const p = sanitisePreview(realWorldPreview())
	assert.ok(!('characterFranchise' in p), 'the object franchise survived — the chip would still render')
	assert.ok(!('characterDetected' in p), 'the "[object Object]" detection survived')
	assert.strictEqual(p.title, 'Pink Cherries Clear Translucent Pearl Charm AirPods Case with Charm')
	assert.strictEqual(p.character, 'kawaii character')
	assert.strictEqual(p.characterConfidence, 0, 'a non-text field was mangled')
	assert.strictEqual(p.characterLowConfidence, true)
	assert.deepStrictEqual(p.tags, ['kawaiiiphonecases', 'airpods case'])
})

test('empty text fields are deleted, not blanked', () => {
	// The Inspector guards chips with `p.field ? … : ''`; '' and absent behave the
	// same there, but deleting keeps the payload honest about what is known.
	const p = sanitisePreview({ characterFranchise: '   ', secondaryColor: {} })
	assert.ok(!('characterFranchise' in p))
	assert.ok(!('secondaryColor' in p))
})

test('unusable alternatives are dropped and their siblings preserved', () => {
	const p = sanitisePreview({
		characterAlternatives: [{ name: { type: 'string' }, confidence: 40 }, { name: 'Melody', confidence: 30 }, null, 'nope'],
	})
	assert.deepStrictEqual(p.characterAlternatives, [{ name: 'Melody', confidence: 30 }])
})

test('image filenames and shop settings are coerced too', () => {
	const p = sanitisePreview({
		images: [{ rank: 1, filename: { type: 'string' } }, { rank: 2, filename: '2.jpg' }],
		settings: { who_made: {}, when_made: 'made_to_order', materials: ['Silicone', { type: 'string' }] },
	})
	assert.strictEqual(p.images[0].filename, '', 'a bad filename would break the gallery alt text')
	assert.strictEqual(p.images[0].rank, 1, 'the rank was disturbed')
	assert.strictEqual(p.images[1].filename, '2.jpg')
	assert.strictEqual(p.settings.who_made, '')
	assert.deepStrictEqual(p.settings.materials, ['Silicone'])
})

test('a healthy preview is returned unchanged', () => {
	const healthy = {
		title: 'Kuromi AirPods Case', description: 'Cute.', tags: ['kuromi'],
		character: 'Kuromi', characterFranchise: 'Sanrio', characterConfidence: 95,
		images: [{ rank: 1, filename: '1.jpg' }], settings: { who_made: 'i_did', materials: ['Silicone'] },
	}
	assert.deepStrictEqual(sanitisePreview(JSON.parse(JSON.stringify(healthy))), healthy)
})

test('it is idempotent and never throws on odd input', () => {
	const once = sanitisePreview(realWorldPreview())
	assert.deepStrictEqual(sanitisePreview(JSON.parse(JSON.stringify(once))), once)
	for (const odd of [null, undefined, 42, 'text', []]) {
		assert.doesNotThrow(() => sanitisePreview(odd), `threw on ${JSON.stringify(odd)}`)
	}
	assert.deepStrictEqual(sanitisePreview({}), {})
})

// ── 5. The read path, end to end ─────────────────────────────────────────────
group('buildItemDetail — a historic broken job opens cleanly')

/** A BulkJobManager over an in-memory DB holding one item with a poisoned preview. */
function manager(previewJson) {
	const { BulkJobManager } = require('../src/listings/bulk-runner')
	const db = new Database(':memory:')
	db.exec(`
		CREATE TABLE bulk_jobs (job_id TEXT PRIMARY KEY, shop_key TEXT, shop_name TEXT, input_path TEXT,
			state TEXT DEFAULT 'done', target_state TEXT DEFAULT 'draft', dry_run INTEGER DEFAULT 1,
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
	db.prepare('INSERT INTO bulk_jobs (job_id, shop_key, shop_name, input_path, dry_run) VALUES (?,?,?,?,1)')
		.run('job-1', 'shop', 'KawaiiiPhoneCases', 'C:/does/not/exist')
	db.prepare('INSERT INTO bulk_job_items (job_id, product_folder, product_name, seq, preview_json) VALUES (?,?,?,1,?)')
		.run('job-1', 'C:/does/not/exist/product', 'Pink Cherries', previewJson)
	return new BulkJobManager({ db, resolveShopClient: async () => { throw new Error('no Etsy in tests') } })
}

/**
 * Render the Inspector's character panel the way the page does — the two escaped
 * expressions that actually threw — so the assertion is about the real symptom.
 */
function renderCharacterPanel(p) {
	return [
		`<span>${escHtml(p.character || p.characterDetected || 'kawaii character')}</span>`,
		p.characterFranchise ? `<span>${escHtml(p.characterFranchise)}</span>` : '',
		p.characterEvidence ? `<div>${escHtml(p.characterEvidence)}</div>` : '',
		(p.tags || []).map((t) => `<span>${escHtml(t)}</span>`).join(''),
	].join('')
}

if (!Database) {
	skip('buildItemDetail heals a historic preview', 'better-sqlite3 is not installed')
} else {
	test('the preview that crashed the Inspector now renders', () => {
		const detail = manager(JSON.stringify(realWorldPreview())).buildItemDetail('job-1', 1)
		let html
		assert.doesNotThrow(() => { html = renderCharacterPanel(detail.preview) }, 'the Inspector would still crash')
		assert.ok(!/\[object /.test(html), `the panel rendered a stringified object: ${html}`)
		assert.ok(html.includes('kawaii character'), 'the character fell back to nothing at all')
	})

	test('a preview that is not valid JSON degrades to an empty one', () => {
		const detail = manager('{ this is not json').buildItemDetail('job-1', 1)
		assert.deepStrictEqual(detail.preview, {})
		assert.doesNotThrow(() => renderCharacterPanel(detail.preview))
	})

	test('the rest of the detail payload is unaffected', () => {
		const detail = manager(JSON.stringify(realWorldPreview())).buildItemDetail('job-1', 1)
		assert.strictEqual(detail.item.seq, 1)
		assert.strictEqual(detail.item.name, 'Pink Cherries')
		assert.strictEqual(detail.job.shop_name, 'KawaiiiPhoneCases')
		assert.strictEqual(detail.preview.currency, 'HKD')
	})
}

// ── 6. The escaper itself ────────────────────────────────────────────────────
group('escHtml — the last line of defence, taken from the shipped page')

test('it escapes what it is supposed to escape', () => {
	assert.strictEqual(escHtml('<script>alert("x" & 1)</script>'), '&lt;script&gt;alert(&quot;x&quot; &amp; 1)&lt;/script&gt;')
	assert.strictEqual(escHtml('Tom & Jerry'), 'Tom &amp; Jerry')
	assert.strictEqual(escHtml('plain'), 'plain')
})

test('ampersands are escaped before the entities they would corrupt', () => {
	// Escaping < first and & second would turn "<" into "&amp;lt;".
	assert.strictEqual(escHtml('&lt;'), '&amp;lt;')
})

test('it never throws, for any input', () => {
	for (const [label, value] of HOSTILE_VALUES) {
		assert.doesNotThrow(() => escHtml(value), `escHtml threw on ${label}`)
		assert.strictEqual(typeof escHtml(value), 'string', `escHtml did not return a string for ${label}`)
	}
})

test('values that refuse to become text render as nothing', () => {
	// A null-prototype object has no toString at all, and a hostile one can throw
	// from Symbol.toPrimitive. Both must be absence, not an exception.
	assert.strictEqual(escHtml(Object.create(null)), '')
	assert.strictEqual(escHtml({ [Symbol.toPrimitive]() { throw new Error('nope') } }), '')
})

test('nullish input renders as nothing rather than "null"/"undefined"', () => {
	assert.strictEqual(escHtml(null), '')
	assert.strictEqual(escHtml(undefined), '')
	assert.strictEqual(escHtml(0), '0', 'a falsy number is still content')
	assert.strictEqual(escHtml(''), '')
})

test('a custom toString cannot smuggle markup through', () => {
	assert.strictEqual(escHtml({ toString: () => '<img onerror=alert(1)>' }), '&lt;img onerror=alert(1)&gt;')
})

test('escAttr is exactly as total as escHtml', () => {
	// The two escapers sit side by side and callers pick one by context. They
	// diverged on coercion once, and that divergence is what broke the Inspector;
	// they now share toDisplayString, so neither can regress alone.
	for (const [label, value] of HOSTILE_VALUES) {
		assert.doesNotThrow(() => escAttr(value), `escAttr threw on ${label}`)
		assert.strictEqual(escHtml(value) === '', escAttr(value) === '', `coercion diverged for ${label}`)
	}
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
