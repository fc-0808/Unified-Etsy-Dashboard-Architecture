#!/usr/bin/env node
'use strict'

/*
 * Read-only diagnostic for the "accidentally marked packaged" incident.
 *
 * bulk-mark-packaged stamps every order in a single batch with one identical
 * `packaged_at` epoch (a single nowEpoch shared across the UPDATE). So an
 * accidental bulk action shows up as a cluster of rows sharing the exact same
 * packaged_at second. This script surfaces those clusters so we can revert
 * precisely the offending batch and nothing else.
 */

const path = require('path')
const Database = require('better-sqlite3')
const { loadConfig } = require('../src/config/schema')

const cfg = loadConfig()
const dbPath = cfg.db_path
console.log('DB:', dbPath)

const db = new Database(dbPath, { readonly: true })

const totalPackaged = db.prepare('SELECT COUNT(*) AS n FROM receipts WHERE packaged_at IS NOT NULL').get().n
console.log(`\nTotal packaged (packaged_at IS NOT NULL): ${totalPackaged}`)

console.log('\n=== Clusters by identical packaged_at (candidate bulk batches) ===')
const clusters = db
	.prepare(`
		SELECT packaged_at,
		       COUNT(*) AS n,
		       datetime(packaged_at, 'unixepoch', 'localtime') AS packaged_local
		FROM receipts
		WHERE packaged_at IS NOT NULL
		GROUP BY packaged_at
		ORDER BY packaged_at DESC
	`)
	.all()

for (const c of clusters) {
	console.log(`  packaged_at=${c.packaged_at}  (${c.packaged_local})  ->  ${c.n} order(s)`)
}

console.log('\n=== Recent bulk-mark-packaged audit entries ===')
try {
	const audit = db
		.prepare(`
			SELECT datetime(ts/1000, 'unixepoch', 'localtime') AS when_local,
			       role, user, method, path, status, details
			FROM audit_log
			WHERE path LIKE '%mark-packaged%'
			ORDER BY id DESC
			LIMIT 25
		`)
		.all()
	if (!audit.length) console.log('  (none)')
	for (const a of audit) {
		console.log(`  ${a.when_local}  ${a.method} ${a.path}  status=${a.status}  user=${a.user || a.role || '?'}  details=${a.details || ''}`)
	}
} catch (e) {
	console.log('  audit_log query failed:', e.message)
}

db.close()
