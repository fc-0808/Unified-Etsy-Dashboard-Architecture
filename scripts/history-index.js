'use strict'

/**
 * Incrementally update the Listing History visual index.
 *
 *   node scripts/history-index.js              embed + hash (default)
 *   node scripts/history-index.js --hash-only  dHash only (free)
 *   node scripts/history-index.js --status     print index stats
 *
 * Safe to re-run: unchanged files are skipped by size/mtime then SHA.
 */

require('dotenv').config({ quiet: true })
const { loadConfig } = require('../src/config/schema')
const { initDb } = require('../src/db/setup')
const catalog = require('../src/listings/history-catalog')
const index = require('../src/listings/history-index')

function arg(flag) {
	return process.argv.includes(flag)
}

function loadDb() {
	const config = loadConfig()
	return initDb(config.db_path)
}

function printStatus(db) {
	const s = index.status(db)
	console.log('History root     :', s.root, s.root_exists ? '' : '(missing)')
	console.log('Folders          :', s.folders, s.missing_folders ? `(${s.missing_folders} missing)` : '')
	console.log('Images indexed   :', s.images, `hashed=${s.hashed} embedded=${s.embedded} pending_embed=${s.pending_embed}`)
	console.log('Images / folder  :', s.images_per_folder)
	console.log('Embed model      :', s.embed_model)
	if (s.last_run) console.log('Last run         :', JSON.stringify(s.last_run))
	if (s.last_error) console.log('Last error       :', s.last_error)
	if (s.job && s.job.running) console.log('Job              :', s.job.phase, s.job.folders_done + '/' + s.job.folders_total)
	const c = s.cost || {}
	if (c.index) {
		console.log('Cost (pending)   :', `$${c.index.pending_embed_usd} to embed ${c.index.pending_embed} image(s)`)
		console.log('Cost (query)     :', `~$${c.query_embed_only.typical_usd} embed-only  /  ~$${c.query_with_rerank.typical_usd} with vision rerank`)
		console.log('Naive warning    :', `$${c.query_with_rerank.naive_chat_vision_all_images_usd} if you sent every archive JPEG to chat-vision`)
	}
}

async function main() {
	const db = loadDb()
	catalog.ensureSchema(db)
	if (arg('--status')) {
		printStatus(db)
		return
	}
	const hashOnly = arg('--hash-only')
	console.log(hashOnly ? 'Updating History index (dHash only)…' : 'Updating History index (dHash + embeddings)…')
	console.log('Root:', catalog.defaultHistoryRoot())
	const started = Date.now()
	const result = await index.updateIndex(db, { embed: !hashOnly, wait: true })
	const sec = ((Date.now() - started) / 1000).toFixed(1)
	if (!result.accepted) {
		console.error('An index job is already running.')
		printStatus(db)
		process.exitCode = 1
		return
	}
	console.log(`Done in ${sec}s`)
	if (result.snapshot) console.log(result.snapshot)
	printStatus(db)
}

main().catch((err) => {
	console.error(err.message || err)
	process.exit(1)
})
