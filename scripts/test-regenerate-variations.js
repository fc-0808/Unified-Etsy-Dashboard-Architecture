'use strict'

/**
 * Regression test — custom variations must survive "Apply & regenerate copy".
 *
 * The bug: an item's copy AND its variation matrix share one `preview_json`
 * blob. The background copy regeneration read that blob when the request
 * arrived, spent several seconds in the AI call, then wrote the whole thing
 * back — silently discarding any variation the operator's auto-save had
 * persisted in the meantime. Because the same stale snapshot also decided
 * whether a custom value was carrying the listing, the "never persist an empty
 * matrix" guard would then re-enable "Case Only" on top. From the operator's
 * seat: you build five custom variations, press the button, and some of them
 * are gone when the rewritten copy comes back.
 *
 * These tests drive the real BulkJobManager against an in-memory database with
 * only the AI call stubbed, so they exercise the actual merge logic.
 *
 * Run: `node scripts/test-regenerate-variations.js`
 * Exit code 0 = all assertions pass, 1 = a regression was detected.
 */

const Database = require('better-sqlite3')

// Swap ONE export before bulk-runner destructures it at require time. Every
// other helper (retitleForModels, filterModelsInDescription, …) stays real.
const aiGenerator = require('../src/listings/ai-generator')
const realGenerate = aiGenerator.generateCopyFromAnalysis
let aiGate = null // when set, the stub parks here until the test releases it
let aiCalls = []
aiGenerator.generateCopyFromAnalysis = async (args) => {
	aiCalls.push(args)
	if (aiGate) await aiGate
	return {
		title: 'Kuromi Star AirPods Case with Charm',
		description: 'Regenerated description.',
		tags: ['kuromi', 'airpods case'],
		characterName: 'Kuromi',
		characterDetected: 'Kuromi',
		characterFranchise: 'Sanrio',
		characterConfidence: 95,
		characterEvidence: 'stub',
		characterAlternatives: [],
		primaryColor: 'Green',
		secondaryColor: 'Pink',
		enabledModels: args.enabledModels,
		styleImageMapping: args.styleImageMapping || {},
	}
}

const { BulkJobManager } = require('../src/listings/bulk-runner')
const { STYLE_ORDER, normaliseEnabledModels } = require('../src/listings/variation-builder')

let failures = 0
function assert(cond, msg) {
	if (cond) {
		console.log(`  ok  — ${msg}`)
	} else {
		failures++
		console.error(`  FAIL — ${msg}`)
	}
}

// ── Fixtures ────────────────────────────────────────────────────────────────
const JOB_ID = 'job-test'
const FOLDER = '001 Star Green AirPods'
const ALL_MODELS = normaliseEnabledModels(undefined, 'iphone_case')
const ALL_STYLES_OFF = Object.fromEntries(STYLE_ORDER.map((k) => [k, false]))

// The five custom values from the reported case, all bundles switched off.
const FIVE_CUSTOM = [
	{ id: 'cs1', label: 'Case 1 + Charm 1', price: 350.11, imageRank: 1 },
	{ id: 'cs2', label: 'Case 1 Only', price: 261.86, imageRank: 2 },
	{ id: 'cs3', label: 'Case 2 Only', price: 261.86, imageRank: 3 },
	{ id: 'cs4', label: 'Charm 1 Only', price: 113.82, imageRank: 4 },
	{ id: 'cs5', label: 'Charm 2 Only', price: 113.82, imageRank: 5 },
]
const FIVE_ORDER = FIVE_CUSTOM.map((s) => s.label)

function makeManager() {
	const db = new Database(':memory:')
	db.exec(`
		CREATE TABLE bulk_jobs (
			job_id TEXT PRIMARY KEY, shop_key TEXT, shop_name TEXT, input_path TEXT,
			state TEXT DEFAULT 'done', target_state TEXT DEFAULT 'draft', dry_run INTEGER DEFAULT 1,
			total INTEGER DEFAULT 1, completed INTEGER DEFAULT 1, failed INTEGER DEFAULT 0,
			options_json TEXT, error TEXT, auto_resume_count INTEGER DEFAULT 0,
			created_at INTEGER, started_at INTEGER, finished_at INTEGER
		);
		CREATE TABLE bulk_job_items (
			job_id TEXT NOT NULL, product_folder TEXT NOT NULL, product_name TEXT, seq INTEGER,
			status TEXT DEFAULT 'done', listing_id INTEGER, listing_url TEXT, title TEXT, error TEXT,
			ai_json TEXT, checkpoint_json TEXT, preview_json TEXT, published_at INTEGER,
			reviewed_at INTEGER, policy_confirmed_at INTEGER, policy_confirmed_by TEXT,
			policy_attestation TEXT, excluded INTEGER DEFAULT 0, updated_at INTEGER,
			PRIMARY KEY (job_id, product_folder)
		);
	`)
	const mgr = new BulkJobManager({
		db,
		resolveShopClient: async () => {
			throw new Error('a dry-run job must never reach Etsy')
		},
	})
	return { db, mgr }
}

/** Seed one dry-run item whose matrix looks like a freshly generated preview. */
function seedItem(db, { preview = {}, ai = {} } = {}) {
	db.prepare('INSERT INTO bulk_jobs (job_id, shop_key, shop_name, input_path, options_json) VALUES (?,?,?,?,?)').run(
		JOB_ID,
		'shop',
		'TestShop',
		'C:/in',
		JSON.stringify({ productType: 'iphone_case' }),
	)
	const imageAnalysis = [{ rank: 1, has_grip: false, has_charm: true, has_magsafe_ring: false }]
	const basePreview = {
		title: 'Old title',
		description: 'Old description.',
		tags: ['old'],
		currency: 'HKD',
		images: Array.from({ length: 13 }, (_, i) => ({ rank: i + 1, filename: `IMG_${i + 1}.jpg` })),
		imageAnalysis,
		enabledStyles: { ...ALL_STYLES_OFF, 'Case Only': true, 'Case+Charm': true },
		enabledModels: ALL_MODELS,
		stylePrices: { 'Case Only': 261.86, 'Case+Charm': 350.11, 'Charm Only': 113.82 },
		styleImageMapping: {},
		customStyles: null,
		variationOrder: null,
		...preview,
	}
	db.prepare(
		'INSERT INTO bulk_job_items (job_id, product_folder, product_name, seq, status, ai_json, preview_json, title) VALUES (?,?,?,?,?,?,?,?)',
	).run(
		JOB_ID,
		FOLDER,
		'Star Green AirPods',
		1,
		'done',
		JSON.stringify({ imageAnalysis, productSummary: {}, ...ai }),
		JSON.stringify(basePreview),
		basePreview.title,
	)
}

function readPreview(db) {
	const row = db.prepare('SELECT preview_json, ai_json, title FROM bulk_job_items WHERE job_id = ? AND seq = 1').get(JOB_ID)
	return { preview: JSON.parse(row.preview_json), ai: JSON.parse(row.ai_json), title: row.title }
}

/** Resolve on the next SSE event of `type`; reject if the regeneration fails. */
function nextEvent(mgr, type, timeoutMs = 10000) {
	return new Promise((resolve, reject) => {
		const set = mgr._subscribers.get(JOB_ID) || new Set()
		const sink = {
			write(chunk) {
				for (const line of String(chunk).split('\n')) {
					if (!line.startsWith('data: ')) continue
					const ev = JSON.parse(line.slice(6))
					if (ev.type === type) {
						cleanup()
						resolve(ev)
					} else if (ev.type === 'regen_failed') {
						cleanup()
						reject(new Error(ev.error || 'regen_failed'))
					}
				}
			},
		}
		set.add(sink)
		mgr._subscribers.set(JOB_ID, set)
		const timer = setTimeout(() => {
			cleanup()
			reject(new Error(`timed out waiting for "${type}"`))
		}, timeoutMs)
		function cleanup() {
			clearTimeout(timer)
			set.delete(sink)
		}
	})
}

function deferred() {
	let resolve
	const promise = new Promise((r) => {
		resolve = r
	})
	return { promise, resolve }
}

const labelsOf = (list) => (Array.isArray(list) ? list.map((s) => s.label) : [])

async function main() {
	console.log('Regenerate-copy variation preservation regression test\n')

	// ── 1. The reported bug: a save that lands mid-regeneration must survive ──
	// Reproduces the exact timing — the operator's 550 ms debounced auto-save
	// fires AFTER the regenerate request was accepted but BEFORE the AI returns.
	// The old code wrote its stale snapshot back and erased all five values.
	{
		console.log('An auto-save landing during a regeneration')
		const { db, mgr } = makeManager()
		seedItem(db)
		aiCalls = []
		const gate = deferred()
		aiGate = gate.promise
		const done = nextEvent(mgr, 'regen_done')
		// Old client: sends the styles it can see but no custom values at all.
		mgr.startRegenerateItemCopy(JOB_ID, 1, { characterName: 'Kuromi', enabledStyles: ALL_STYLES_OFF })
		// …the AI is now parked, so the snapshot has already been taken.
		await mgr.updateItemVariations(JOB_ID, 1, {
			enabledStyles: ALL_STYLES_OFF,
			enabledModels: ALL_MODELS,
			customStyles: FIVE_CUSTOM,
			variationOrder: FIVE_ORDER,
		})
		gate.resolve()
		aiGate = null
		await done

		const { preview, ai, title } = readPreview(db)
		assert(labelsOf(preview.customStyles).length === 5, 'all five custom variations survive a concurrent save')
		assert(labelsOf(preview.customStyles).join('|') === FIVE_ORDER.join('|'), 'their names and order are intact')
		assert(preview.enabledStyles['Case Only'] === false, '"Case Only" is not resurrected while custom values carry the listing')
		assert(!STYLE_ORDER.some((k) => preview.enabledStyles[k]), 'every canonical bundle stays switched off')
		assert(preview.variationOrder && preview.variationOrder.length === 5, 'the buyer-facing dropdown order is preserved')
		assert(preview.description === 'Regenerated description.', 'the regenerated copy is still applied')
		assert(labelsOf(ai.customStyles).length === 5, 'the cached AI copy mirrors the same matrix')
		assert(title === preview.title, 'the item title column matches the stored preview')
		db.close()
	}

	// ── 2. The request carries the matrix, so it is persisted verbatim ────────
	{
		console.log('\nA regenerate request that carries the full matrix')
		const { db, mgr } = makeManager()
		seedItem(db)
		aiCalls = []
		const done = nextEvent(mgr, 'regen_done')
		mgr.startRegenerateItemCopy(JOB_ID, 1, {
			characterName: 'Kuromi',
			enabledStyles: ALL_STYLES_OFF,
			enabledModels: ALL_MODELS,
			customStyles: FIVE_CUSTOM,
			variationOrder: FIVE_ORDER,
		})
		const ev = await done

		const { preview } = readPreview(db)
		assert(labelsOf(preview.customStyles).join('|') === FIVE_ORDER.join('|'), 'custom values are stored exactly as sent')
		assert(preview.enabledStyles['Case Only'] === false, 'a deliberately empty bundle set is respected')
		assert(preview.minPrice === 113.82, 'the "from" price is the cheapest custom value')
		assert(labelsOf(ev.customStyles).length === 5, 'the regen_done event reports the stored matrix')
		assert(aiCalls.length === 1 && labelsOf(aiCalls[0].customStyles).length === 5, 'the copy is written for those five values')
		db.close()
	}

	// ── 3. Stale values must never override what the operator just sent ───────
	{
		console.log('\nA request whose custom values differ from the stored ones')
		const { db, mgr } = makeManager()
		seedItem(db, { preview: { customStyles: [{ id: 'old', label: 'Old Bundle', price: 99, imageRank: null }] } })
		aiCalls = []
		const done = nextEvent(mgr, 'regen_done')
		mgr.startRegenerateItemCopy(JOB_ID, 1, {
			characterName: 'Kuromi',
			enabledStyles: ALL_STYLES_OFF,
			customStyles: FIVE_CUSTOM,
			variationOrder: FIVE_ORDER,
		})
		await done

		const { preview } = readPreview(db)
		assert(!labelsOf(preview.customStyles).includes('Old Bundle'), 'the superseded value is gone')
		assert(labelsOf(preview.customStyles).length === 5, 'the five values from the request replaced it')
		assert(!labelsOf(aiCalls[0].customStyles).includes('Old Bundle'), 'the copy describes the new values, not the stale one')
		db.close()
	}

	// ── 4. Invalid rows are dropped, but never the whole set ──────────────────
	{
		console.log('\nA request containing an incomplete custom row')
		const { db, mgr } = makeManager()
		seedItem(db)
		const done = nextEvent(mgr, 'regen_done')
		mgr.startRegenerateItemCopy(JOB_ID, 1, {
			characterName: 'Kuromi',
			enabledStyles: ALL_STYLES_OFF,
			customStyles: [FIVE_CUSTOM[0], { id: 'bad', label: '', price: 0, imageRank: null }, FIVE_CUSTOM[1]],
		})
		await done

		const { preview } = readPreview(db)
		assert(labelsOf(preview.customStyles).join('|') === 'Case 1 + Charm 1|Case 1 Only', 'the two valid rows are kept, the blank one dropped')
		db.close()
	}

	// ── 5. The empty-matrix invariant still holds ─────────────────────────────
	{
		console.log('\nA request that would leave the listing with no options at all')
		const { db, mgr } = makeManager()
		seedItem(db)
		const done = nextEvent(mgr, 'regen_done')
		mgr.startRegenerateItemCopy(JOB_ID, 1, { characterName: 'Kuromi', enabledStyles: ALL_STYLES_OFF, customStyles: [] })
		await done

		const { preview } = readPreview(db)
		assert(preview.enabledStyles['Case Only'] === true, '"Case Only" is re-enabled when nothing else can carry the listing')
		assert(preview.customStyles === null, 'an explicitly emptied custom list is cleared')
		db.close()
	}

	// ── 6. Operator-linked variation photos survive ───────────────────────────
	{
		console.log('\nManually linked variation photos')
		const { db, mgr } = makeManager()
		seedItem(db)
		const done = nextEvent(mgr, 'regen_done')
		mgr.startRegenerateItemCopy(JOB_ID, 1, {
			characterName: 'Kuromi',
			enabledStyles: { ...ALL_STYLES_OFF, 'Case Only': true },
			styleImageMapping: { 'Case Only': [7] },
			customStyles: [FIVE_CUSTOM[0]],
		})
		await done

		const { preview } = readPreview(db)
		assert(JSON.stringify(preview.styleImageMapping['Case Only']) === '[7]', 'a bundle keeps the photo the operator linked')
		assert(preview.customStyles[0].imageRank === 1, 'a custom value keeps its own linked photo')
		db.close()
	}

	// ── 7. A concurrent save wins the matrix without losing the new copy ──────
	{
		console.log('\nA save that changes the matrix mid-flight')
		const { db, mgr } = makeManager()
		seedItem(db)
		const gate = deferred()
		aiGate = gate.promise
		const done = nextEvent(mgr, 'regen_done')
		// The request carries three values; the operator then adds two more.
		mgr.startRegenerateItemCopy(JOB_ID, 1, {
			characterName: 'Kuromi',
			enabledStyles: ALL_STYLES_OFF,
			customStyles: FIVE_CUSTOM.slice(0, 3),
			variationOrder: FIVE_ORDER.slice(0, 3),
		})
		await mgr.updateItemVariations(JOB_ID, 1, {
			enabledStyles: ALL_STYLES_OFF,
			enabledModels: ALL_MODELS,
			customStyles: FIVE_CUSTOM,
			variationOrder: FIVE_ORDER,
		})
		gate.resolve()
		aiGate = null
		await done

		const { preview } = readPreview(db)
		assert(labelsOf(preview.customStyles).length === 5, 'the later save wins over the values the request carried')
		assert(preview.description === 'Regenerated description.', 'the regenerated copy is applied on top of it')
		db.close()
	}

	aiGenerator.generateCopyFromAnalysis = realGenerate

	if (failures) {
		console.error(`\n${failures} assertion(s) failed.`)
		process.exit(1)
	}
	console.log('\nAll assertions passed.')
}

main().catch((err) => {
	console.error('\nTest harness error:', err)
	process.exit(1)
})
