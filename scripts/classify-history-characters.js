'use strict'

/**
 * File History product folders into IP-character destinations (copy, never move).
 *
 *   node scripts/classify-history-characters.js
 *   node scripts/classify-history-characters.js --limit 20
 *   node scripts/classify-history-characters.js --apply --limit 20
 *   node scripts/classify-history-characters.js --apply --shop Y2KASEofficial
 *   node scripts/classify-history-characters.js --status
 *
 * Default is a dry-run. History is never written to.
 */

require('dotenv').config({ quiet: true })
const path = require('path')
const sort = require('../src/listings/character-sort')
const history = require('../src/listings/history-catalog')
const vision = require('../src/listings/character-sort-vision')

function arg(flag) {
	return process.argv.includes(flag)
}

function argValue(flag, fallback) {
	const i = process.argv.indexOf(flag)
	if (i < 0 || i + 1 >= process.argv.length) return fallback
	return process.argv[i + 1]
}

function printRecord(row) {
	const mark = row.decision === 'auto' ? 'AUTO' : row.decision === 'original' ? 'ORIG' : row.decision === 'error' ? 'ERR ' : 'REVW'
	const conf = String(row.confidence != null ? row.confidence : '').padStart(3)
	const layer = String(row.layer || '').padEnd(12)
	const name = String(row.name || '—').slice(0, 22).padEnd(22)
	const dest = row.dest_relative || row.reason || ''
	console.log(`  [${mark}] ${conf} ${layer} ${name}  ${row.product_key}`)
	console.log(`         → ${dest}${row.copied ? '  (copied)' : row.skipped ? `  (${row.skipped})` : ''}`)
}

function printSummary(report) {
	const s = report.summary
	console.log('')
	console.log('History root   :', report.history_root)
	console.log('Listings root  :', report.listings_root)
	console.log('Mode           :', report.apply ? 'APPLY (copy)' : 'DRY-RUN (no copy)')
	console.log('Selected       :', `${s.selected} of ${s.scanned} product folders`)
	console.log('Layers         :', `name=${s.name}  vision=${s.vision}  needs-vision=${s.needs_vision || 0}  cache=${s.cached}`)
	console.log('Decisions      :', `auto=${s.auto}  review=${s.review}  original=${s.original}  errors=${s.errors}`)
	console.log('Copies         :', `new=${s.copied}  already=${s.already_copied}  retired=${s.retired || 0}  skipped=${s.skipped}`)
	console.log('Vision calls   :', s.vision_calls, `  ~$${report.cost.estimated_usd}`)
	console.log('Naive warning  :', `$${report.cost.naive_all_images_usd} if every archive JPEG went to chat-vision`)
	if (report.manifest) console.log('Manifest       :', report.manifest)
}

function printStatus() {
	const historyRoot = history.defaultHistoryRoot()
	const listingsRoot = sort.defaultListingsRoot()
	const walked = history.countHistoryTree(historyRoot)
	const manifest = sort.loadManifest(path.join(require('../src/listings/config').config.projectRoot, 'data', 'character-sort'))
	const decisions = { auto: 0, review: 0, original: 0, error: 0 }
	for (const row of manifest.byKey.values()) {
		decisions[row.decision] = (decisions[row.decision] || 0) + 1
	}
	console.log('History root   :', historyRoot, walked.exists ? '' : '(missing)')
	console.log('Listings root  :', listingsRoot)
	console.log('Product folders:', walked.folders)
	console.log('Manifest rows  :', manifest.byKey.size)
	console.log('Decisions      :', decisions)
	console.log('Vision ready   :', vision.visionEnabled() ? 'yes' : 'NO — set VISION_API_KEY / OPENAI_API_KEY')
	const pending = Math.max(0, walked.folders - manifest.byKey.size)
	const cost = sort.estimateCost({ folders: walked.folders, cached: manifest.byKey.size, visionCalls: pending })
	console.log('Est. remaining :', `${pending} vision call(s)  ~$${cost.estimated_usd}`)
}

async function main() {
	if (arg('--help') || arg('-h')) {
		console.log(`File History products into IP-character folders (copy only).

  --dry-run          default; classify and print the plan
  --apply            copy high-confidence folders to destinations
  --status           print archive + manifest stats
  --limit N          classify at most N folders
  --offset N         skip the first N folders
  --shop NAME        only one History shop folder
  --force            ignore manifest cache
  --accurate         3 photos at 1280px, then a second look for look-alikes,
                     collages, confidence under 90, and folder-name disagreements.
                     Replaces an earlier copy when the new answer differs.
  --name-only        never call vision; file only unique folder-name matches
  --auto-only        on --apply, copy only auto decisions (skip review/originals)
  --no-copy-review   do not copy the review queue
  --no-copy-originals
  --auto-confidence N   default 80
  --review-confidence N default 55
`)
		return
	}

	if (arg('--status')) {
		printStatus()
		return
	}

	const apply = arg('--apply')
	const accurate = arg('--accurate')
	const autoOnly = arg('--auto-only')
	const limit = Number(argValue('--limit', 0)) || 0
	const offset = Number(argValue('--offset', 0)) || 0
	const shop = argValue('--shop', '') || ''
	const autoConfidence = Number(argValue('--auto-confidence', sort.AUTO_CONFIDENCE))
	const reviewConfidence = Number(argValue('--review-confidence', sort.REVIEW_CONFIDENCE))

	if (apply && !vision.visionEnabled()) {
		console.error('Vision is not configured. Set VISION_API_KEY (or OPENAI_API_KEY) before --apply.')
		console.error('A dry-run still works for folders whose names already name the character.')
	}

	console.log(accurate ? 'Accurate pass: 3 photos, second look on look-alikes.' : 'Standard pass.')
	console.log(apply ? 'Classifying and copying…' : 'Dry-run (History will not be copied)…')
	if (!apply) console.log('Re-run with --apply after you have reviewed the plan.')

	const report = await sort.runSort({
		apply,
		limit,
		offset,
		shop,
		force: arg('--force'),
		accurate,
		pass: accurate ? sort.ACCURATE_PASS : '',
		imagesPerFolder: accurate ? 3 : undefined,
		nameOnly: arg('--name-only'),
		autoConfidence,
		reviewConfidence,
		copyReview: autoOnly ? false : !arg('--no-copy-review'),
		copyOriginals: autoOnly ? false : !arg('--no-copy-originals'),
		concurrency: apply ? 2 : 3,
		onRecord: (row) => printRecord(row),
	})
	printSummary(report)
	if (!apply && report.summary.auto) {
		console.log('')
		console.log(`Ready to copy ${report.summary.auto} high-confidence folder(s). Example:`)
		console.log('  node scripts/classify-history-characters.js --apply --limit 20')
	}
}

main().catch((err) => {
	console.error(err.message || err)
	process.exit(1)
})
