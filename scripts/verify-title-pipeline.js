'use strict'

/**
 * Live end-to-end verification of the design-analysis + title-quality pipeline.
 *
 * Picks a REAL product folder out of the local bulk-listing database — by
 * default one whose existing title FAILED the quality gate — re-runs the full
 * generator on its actual photos, and prints the old title beside the new one
 * with the gate's verdict on each.
 *
 * This is the honest test: same photos, same shop, only the pipeline changed.
 *
 *   node scripts/verify-title-pipeline.js
 *   node scripts/verify-title-pipeline.js --folder "C:\path\to\product"
 *   node scripts/verify-title-pipeline.js --count 3
 *
 * Costs real API calls (roughly 5 vision requests + 1-2 copy requests per
 * product). It NEVER writes to the database and NEVER touches Etsy.
 */

const fs = require('fs')
const path = require('path')

const { config } = require('../src/listings/config')
const { scanProductFolder } = require('../src/listings/scanner')
const { generateListingCopy } = require('../src/listings/ai-generator')
const { scoreTitle, buildTitleContext } = require('../src/listings/title-quality')

const RESET = '\x1b[0m', GREEN = '\x1b[32m', RED = '\x1b[31m', YEL = '\x1b[33m', CYAN = '\x1b[36m', BOLD = '\x1b[1m', DIM = '\x1b[2m'
const pass = (m) => console.log(`${GREEN}  ✓${RESET} ${m}`)
const fail = (m) => console.log(`${RED}  ✗${RESET} ${m}`)
const warn = (m) => console.log(`${YEL}  !${RESET} ${m}`)
const info = (m) => console.log(`${DIM}    ${m}${RESET}`)
const section = (m) => console.log(`\n${BOLD}${CYAN}── ${m} ──${RESET}\n`)

function parseArgs(argv) {
	const args = { folder: null, count: 1 }
	for (let i = 2; i < argv.length; i++) {
		if (argv[i] === '--folder') args.folder = argv[++i]
		else if (argv[i] === '--count') args.count = Math.max(1, parseInt(argv[++i], 10) || 1)
	}
	return args
}

function openDb() {
	const configPath = path.join(config.projectRoot, 'config.json')
	const candidates = []
	if (process.env.DB_PATH) candidates.push(process.env.DB_PATH)
	try {
		const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'))
		if (raw.db_path) candidates.push(path.resolve(path.dirname(configPath), raw.db_path))
	} catch { /* no config.json */ }
	candidates.push(path.join(config.projectRoot, 'data', 'etsy_dashboard.db'))
	for (const file of candidates) {
		if (file && fs.existsSync(file)) return new (require('better-sqlite3'))(file, { readonly: true })
	}
	return null
}

/** Real products whose current title is weak and whose photos are still on disk. */
function findWeakProducts(db, limit) {
	if (!db) return []
	let rows = []
	try {
		rows = db.prepare(`
			SELECT job_id, seq, product_name, product_folder, title, ai_json
			FROM bulk_job_items WHERE title IS NOT NULL AND title != ''
			ORDER BY updated_at DESC LIMIT 800
		`).all()
	} catch { return [] }

	const out = []
	for (const row of rows) {
		if (!fs.existsSync(row.product_folder)) continue
		let ai = {}
		try { ai = row.ai_json ? JSON.parse(row.ai_json) : {} } catch { ai = {} }
		const summary = ai.productSummary || {}
		const verdict = scoreTitle(row.title, buildTitleContext({
			characterName: ai.characterName || summary.character_name || '',
			characterIsGeneric: /kawaii character|unknown|generic/i.test(ai.characterName || summary.character_name || ''),
			productSummary: summary,
		}), { minScore: config.copy.titleMinScore })
		if (verdict.ok) continue
		out.push({ ...row, verdict })
		if (out.length >= limit) break
	}
	return out
}

function printVerdict(label, title, verdict) {
	const mark = verdict.ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`
	const colour = verdict.score >= config.copy.titleMinScore ? GREEN : verdict.score >= 50 ? YEL : RED
	console.log(`  ${mark} ${BOLD}${label}${RESET} ${colour}${verdict.score}/100${RESET} ${DIM}· ${title.length} chars · ${verdict.specificTerms.length} specific term(s)${RESET}`)
	console.log(`     ${title}`)
	if (verdict.issues.length) {
		for (const issue of verdict.issues) console.log(`     ${issue.fatal ? RED : YEL}· ${issue.message}${RESET}`)
	}
	console.log()
}

async function main() {
	const args = parseArgs(process.argv)

	section('1 · Active configuration')
	info(`Vision model      : ${BOLD}${config.openai.visionModel}${RESET}${DIM}`)
	info(`Vision provider   : ${config.openai.visionBaseUrl || '(OpenAI default)'}`)
	info(`Copy model        : ${config.openai.model}`)
	info(`Design analysis   : ${config.copy.designAnalysis ? `on (${config.copy.designImages} frames)` : 'OFF'}`)
	info(`Copy vision       : ${config.copy.vision}`)
	info(`Title gate        : ${config.copy.titleGate ? `on (min ${config.copy.titleMinScore}, up to ${config.copy.titleRepairAttempts} rewrite(s))` : 'OFF'}`)
	if (!config.openai.apiKey) { fail('OPENAI_API_KEY is not set — cannot run the pipeline.'); process.exit(1) }
	if (!config.copy.designAnalysis) warn('DESIGN_ANALYSIS is off — the run will not exercise the new pass.')

	section('2 · Choose real products')
	let targets = []
	if (args.folder) {
		if (!fs.existsSync(args.folder)) { fail(`Folder not found: ${args.folder}`); process.exit(1) }
		targets = [{ product_folder: args.folder, product_name: path.basename(args.folder), title: null }]
		pass(`Using the folder you supplied: ${args.folder}`)
	} else {
		const db = openDb()
		targets = findWeakProducts(db, args.count)
		if (db) db.close()
		if (!targets.length) {
			fail('No product with a weak title AND photos still on disk was found.')
			info('Pass --folder "<path to a product folder>" to test a specific product.')
			process.exit(1)
		}
		pass(`Found ${targets.length} product(s) whose current title fails the gate`)
	}

	let improved = 0
	let regressed = 0

	for (const target of targets) {
		section(`3 · ${target.product_name}`)

		const scanned = scanProductFolder(target.product_folder)
		if (!scanned.images.length) { warn('No images on disk — skipping.'); continue }
		info(`${scanned.images.length} photo(s) · ${target.product_folder}`)
		console.log()

		if (target.title) printVerdict('BEFORE', target.title, target.verdict)

		const started = Date.now()
		let result
		try {
			result = await generateListingCopy(scanned, { shopName: 'Y2KASEshop', brandTags: ['y2kase'] })
		} catch (err) {
			fail(`Pipeline FAILED: ${err.message}`)
			if (err.status) info(`HTTP status: ${err.status}`)
			process.exitCode = 1
			continue
		}
		const secs = ((Date.now() - started) / 1000).toFixed(1)

		// ── Design fingerprint ──
		const design = result.designAnalysis
		if (design) {
			pass(`Design fingerprint extracted in ${secs}s (confidence ${design.confidence}/100)`)
			info(`subject   : ${design.subjectPrimary || '—'}${design.subjectSecondary ? ` + ${design.subjectSecondary}` : ''}`)
			info(`motifs    : ${design.motifs.map((m) => `${m.term}(${m.prominence})`).join(', ') || '—'}`)
			if (design.printedText.length) info(`printed   : ${design.printedText.map((t) => `"${t}"`).join(', ')}`)
			info(`art style : ${design.artStyle || '—'} · finish: ${design.finish || '—'} · ${design.composition || '—'}`)
			info(`palette   : ${design.colorStory || '—'}`)
			info(`keywords  : ${design.titleKeywords.join(' | ') || '—'}`)
			info(`searches  : ${design.searchPhrases.slice(0, 4).join('; ') || '—'}`)
		} else {
			warn(`No design fingerprint returned (pipeline still completed in ${secs}s)`)
		}
		console.log()

		// ── The title ──
		const q = result.titleQuality || {}
		printVerdict('AFTER ', result.title, {
			ok: q.ok, score: q.score ?? 0, length: result.title.length,
			specificTerms: q.specificTerms || [], issues: q.issues || [],
		})
		if (q.groundedOnImages) info('the copy model saw the hero photos')
		if (q.repairAttempts) info(`the gate rejected the first attempt and requested ${q.repairAttempts} rewrite(s)`)

		// ── Assertions ──
		if (result.title.length > 140) fail(`Title exceeds Etsy's 140-char cap (${result.title.length}) — would be rejected on create`)
		else pass(`Title fits Etsy's cap (${result.title.length}/140)`)

		if (/kawaii character|cute character/i.test(result.title)) fail('Title still contains a placeholder subject')
		else pass('No placeholder subject in the title')

		if (q.ok) pass(`Title passes the quality gate (${q.score}/100)`)
		else warn(`Title still below the pass mark (${q.score}/100)`)

		if (result.tags && result.tags.length === 13) pass('Exactly 13 tags')
		else fail(`Expected 13 tags, got ${result.tags ? result.tags.length : 0}`)
		if (result.tags) info(`tags: ${result.tags.join(', ')}`)

		if (result.description && result.description.length > 500) pass(`Description written (${result.description.length} chars)`)
		else fail('Description too short or missing')

		if (target.verdict) {
			if ((q.score ?? 0) > target.verdict.score) { improved++; pass(`Specificity improved ${target.verdict.score} → ${q.score}`) }
			else { regressed++; fail(`Specificity did NOT improve (${target.verdict.score} → ${q.score ?? 0})`) }
		}
	}

	section('Summary')
	if (targets.some((t) => t.title)) {
		console.log(`  improved: ${GREEN}${improved}${RESET}   not improved: ${regressed ? RED : DIM}${regressed}${RESET}`)
	}
	console.log()
	if (regressed) { console.log(`${YEL}${BOLD}  Review the products that did not improve above.${RESET}\n`); process.exitCode = 1 }
	else console.log(`${GREEN}${BOLD}  Pipeline verified end-to-end on real product photos.${RESET}\n`)
}

main().catch((err) => { console.error(`\n${RED}Unexpected error:${RESET}`, err); process.exit(1) })
