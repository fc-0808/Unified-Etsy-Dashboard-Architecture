#!/usr/bin/env node
'use strict'

/*
 * Revert an accidental bulk "mark packaged" action.
 *
 * bulk-mark-packaged stamps every order in a batch with a single shared
 * `packaged_at` epoch, so an accidental batch is uniquely identifiable by that
 * one timestamp. This reverts ONLY the orders carrying that exact epoch (leaving
 * every individually-packaged order untouched), and records an audit_log entry
 * so the correction is traceable in the activity feed — mirroring what the
 * POST /api/orders/bulk-mark-packaged (packaged:false) endpoint would have done.
 *
 * Usage:
 *   node scripts/revert-packaged-batch.js <packaged_at_epoch> [--expect N] [--apply]
 *
 * Without --apply it runs a dry-run (shows what would change, no writes).
 */

const Database = require('better-sqlite3')
const { loadConfig } = require('../src/config/schema')

const args = process.argv.slice(2)
const epoch = Number(args.find((a) => /^\d+$/.test(a)))
const apply = args.includes('--apply')
const expectIdx = args.indexOf('--expect')
const expected = expectIdx !== -1 ? Number(args[expectIdx + 1]) : null

if (!Number.isInteger(epoch) || epoch <= 0) {
	console.error('ERROR: provide the packaged_at epoch, e.g. node scripts/revert-packaged-batch.js 1783394643 --expect 60 --apply')
	process.exit(1)
}

const cfg = loadConfig()
const db = new Database(cfg.db_path)
db.pragma('busy_timeout = 5000')

console.log('DB:', cfg.db_path)

const targets = db
	.prepare(`
		SELECT receipt_id, is_shipped, status,
		       datetime(packaged_at, 'unixepoch', 'localtime') AS packaged_local
		FROM receipts
		WHERE packaged_at = ?
		ORDER BY receipt_id
	`)
	.all(epoch)

const n = targets.length
console.log(`\nOrders carrying packaged_at=${epoch}: ${n}`)
if (n) console.log(`(marked ${targets[0].packaged_local})`)

if (n === 0) {
	console.log('Nothing to revert. Perhaps it was already reverted.')
	db.close()
	process.exit(0)
}

if (expected != null && n !== expected) {
	console.error(`\nABORT: expected ${expected} orders but found ${n}. Refusing to touch data until this is reconciled.`)
	db.close()
	process.exit(2)
}

const shippedCount = targets.filter((t) => t.is_shipped).length
console.log(`  unshipped: ${n - shippedCount}   shipped: ${shippedCount}`)
console.log('  receipt_ids:', targets.map((t) => t.receipt_id).join(', '))

if (!apply) {
	console.log('\nDRY RUN — no changes written. Re-run with --apply to perform the revert.')
	db.close()
	process.exit(0)
}

const nowMs = Date.now()
const tx = db.transaction(() => {
	const changed = db.prepare('UPDATE receipts SET packaged_at = NULL WHERE packaged_at = ?').run(epoch).changes
	db.prepare('INSERT INTO audit_log (ts, role, user, method, path, status, details) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
		nowMs,
		'owner',
		'owner',
		'POST',
		'/api/orders/bulk-mark-packaged',
		200,
		JSON.stringify({ receipt_ids: `${changed} items`, packaged: 'false', note: `revert of accidental batch packaged_at=${epoch}` }),
	)
	return changed
})

const changed = tx()
console.log(`\nDONE: reverted ${changed} order(s) back to not-packaged (packaged_at = NULL).`)

const remaining = db.prepare('SELECT COUNT(*) AS n FROM receipts WHERE packaged_at = ?').get(epoch).n
console.log(`Remaining with packaged_at=${epoch}: ${remaining} (expected 0)`)

db.close()
