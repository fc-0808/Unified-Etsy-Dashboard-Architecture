'use strict'

/**
 * Audit every generated listing title in the local bulk-listing database and
 * report how product-specific it actually is.
 *
 * This is the before/after instrument for the title-quality work: run it once
 * to see how many existing listings are interchangeable boilerplate, then again
 * after regenerating to confirm the fix landed. It is READ-ONLY — it never
 * calls an API, never writes to the database, and never touches Etsy.
 *
 *   node scripts/audit-listing-titles.js                 # all jobs
 *   node scripts/audit-listing-titles.js --job <job_id>  # one run
 *   node scripts/audit-listing-titles.js --failing       # only weak titles
 *   node scripts/audit-listing-titles.js --limit 20
 */

const path = require('path')
const { scoreTitle, buildTitleContext, DEFAULT_MIN_SCORE } = require('../src/listings/title-quality')
const { config } = require('../src/listings/config')

const RESET = '\x1b[0m', GREEN = '\x1b[32m', RED = '\x1b[31m', YEL = '\x1b[33m', CYAN = '\x1b[36m', BOLD = '\x1b[1m', DIM = '\x1b[2m'

function parseArgs(argv) {
	const args = { job: null, failing: false, limit: Infinity }
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i]
		if (a === '--job') args.job = argv[++i]
		else if (a === '--failing') args.failing = true
		else if (a === '--limit') args.limit = Math.max(1, parseInt(argv[++i], 10) || Infinity)
		else if (a === '--help' || a === '-h') args.help = true
	}
	return args
}

function openDb() {
	const fs = require('fs')
	let Database
	try {
		Database = require('better-sqlite3')
	} catch {
		console.error(`${RED}better-sqlite3 is not installed — run npm install first.${RESET}`)
		process.exit(1)
	}

	// Resolve exactly the way src/config/schema.js does, so the audit can never
	// read a different database from the one the dashboard writes.
	const candidates = []
	if (process.env.DB_PATH) candidates.push(process.env.DB_PATH)
	const configPath = path.join(config.projectRoot, 'config.json')
	try {
		const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'))
		if (raw.db_path) candidates.push(path.resolve(path.dirname(configPath), raw.db_path))
	} catch { /* no config.json — fall back to the default location */ }
	candidates.push(path.join(config.projectRoot, 'data', 'etsy_dashboard.db'))

	for (const file of candidates) {
		if (file && fs.existsSync(file)) return { db: new Database(file, { readonly: true }), file }
	}
	// Last resort: any .db file sitting in data/.
	const dir = path.join(config.projectRoot, 'data')
	if (fs.existsSync(dir)) {
		const found = fs.readdirSync(dir).find((f) => f.endsWith('.db'))
		if (found) return { db: new Database(path.join(dir, found), { readonly: true }), file: path.join(dir, found) }
	}
	console.error(`${RED}No database found. Looked in:${RESET}`)
	for (const c of candidates) console.error(`  ${DIM}${c}${RESET}`)
	console.error(`${DIM}Set DB_PATH to point at it explicitly.${RESET}`)
	process.exit(1)
}

function safeParse(json) {
	try { return json ? JSON.parse(json) : null } catch { return null }
}

function bar(score) {
	const filled = Math.round(score / 5)
	const colour = score >= DEFAULT_MIN_SCORE ? GREEN : score >= 50 ? YEL : RED
	return `${colour}${'█'.repeat(filled)}${DIM}${'░'.repeat(20 - filled)}${RESET}`
}

function main() {
	const args = parseArgs(process.argv)
	if (args.help) {
		console.log('Usage: node scripts/audit-listing-titles.js [--job <id>] [--failing] [--limit N]')
		return
	}

	const { db, file } = openDb()
	console.log(`\n${BOLD}${CYAN}Listing title specificity audit${RESET}`)
	console.log(`${DIM}database: ${file}${RESET}`)
	console.log(`${DIM}pass mark: ${config.copy.titleMinScore}/100${RESET}\n`)

	let rows
	try {
		rows = args.job
			? db.prepare('SELECT * FROM bulk_job_items WHERE job_id = ? ORDER BY (seq IS NULL), seq').all(args.job)
			: db.prepare('SELECT * FROM bulk_job_items ORDER BY job_id, (seq IS NULL), seq').all()
	} catch (err) {
		console.error(`${RED}Could not read bulk_job_items: ${err.message}${RESET}`)
		process.exit(1)
	}

	const scored = []
	for (const row of rows) {
		if (!row.title) continue
		const ai = safeParse(row.ai_json) || {}
		const preview = safeParse(row.preview_json) || {}
		const summary = ai.productSummary || {}
		const design = ai.designAnalysis || preview.designAnalysis || null
		const characterName = preview.character || ai.characterName || summary.character_name || ''

		const context = buildTitleContext({
			characterName,
			characterIsGeneric: /kawaii character|unknown|generic/i.test(characterName),
			designAnalysis: design,
			productSummary: summary,
		})
		const verdict = scoreTitle(row.title, context, { minScore: config.copy.titleMinScore })
		scored.push({ row, verdict, design: Boolean(design), context })
	}

	if (!scored.length) {
		console.log(`${YEL}No generated titles found${args.job ? ` for job ${args.job}` : ''}.${RESET}\n`)
		return
	}

	const shown = scored.filter((s) => !args.failing || !s.verdict.ok).slice(0, args.limit)
	for (const { row, verdict, design } of shown) {
		const mark = verdict.ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`
		const job = args.job ? '' : ` ${DIM}(job ${String(row.job_id).slice(0, 8)})${RESET}`
		console.log(`${mark} ${BOLD}#${row.seq || '?'}${RESET}${job} ${DIM}${row.product_name || row.product_folder}${RESET}`)
		console.log(`   ${bar(verdict.score)} ${verdict.score}/100  ${DIM}${verdict.length} chars · ${verdict.matchedDesignTerms.length}/${verdict.matchedDesignTerms.length + verdict.missingDesignTerms.length} design terms · fingerprint ${design ? 'yes' : `${YEL}missing${RESET}${DIM}`}${RESET}`)
		console.log(`   ${row.title}`)
		if (!verdict.ok) {
			for (const issue of verdict.issues) {
				console.log(`   ${issue.fatal ? RED : YEL}· ${issue.message}${RESET}`)
			}
		}
		console.log()
	}

	// ── Summary ────────────────────────────────────────────────────────────────
	const total = scored.length
	const passing = scored.filter((s) => s.verdict.ok).length
	const withFingerprint = scored.filter((s) => s.design).length
	const avg = Math.round(scored.reduce((sum, s) => sum + s.verdict.score, 0) / total)

	// The clearest signal that titles are interchangeable: how many distinct
	// "content" signatures exist across the run. 100 listings sharing 4 shapes is
	// exactly the failure this pipeline was rebuilt to eliminate.
	const signatures = new Map()
	for (const s of scored) {
		const key = [...s.verdict.specificTerms].sort().join(' ') || '(nothing specific)'
		signatures.set(key, (signatures.get(key) || 0) + 1)
	}
	const duplicated = [...signatures.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1])

	console.log(`${BOLD}${CYAN}── Summary ──${RESET}\n`)
	console.log(`  Titles audited        ${BOLD}${total}${RESET}`)
	console.log(`  Passing the gate      ${passing >= total * 0.9 ? GREEN : passing >= total / 2 ? YEL : RED}${passing}${RESET} / ${total}  (${Math.round((passing / total) * 100)}%)`)
	console.log(`  Average specificity   ${avg >= config.copy.titleMinScore ? GREEN : RED}${avg}${RESET}/100`)
	console.log(`  With a design fingerprint  ${withFingerprint} / ${total}`)
	console.log(`  Distinct title "shapes"    ${signatures.size} across ${total} listings`)
	if (duplicated.length) {
		console.log(`\n  ${YEL}Interchangeable titles — these products share the same descriptive words:${RESET}`)
		for (const [key, n] of duplicated.slice(0, 5)) {
			console.log(`    ${RED}×${n}${RESET} ${DIM}${key.slice(0, 90)}${RESET}`)
		}
	}
	if (withFingerprint < total) {
		console.log(`\n  ${DIM}${total - withFingerprint} listing(s) predate the design-analysis pass. Open each in the`)
		console.log(`  Inspector and press "Apply & regenerate copy" — the pass will run on their`)
		console.log(`  photos and the quality gate will rewrite the title.${RESET}`)
	}
	console.log()
	db.close()
}

main()
