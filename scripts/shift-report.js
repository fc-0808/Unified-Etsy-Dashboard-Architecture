#!/usr/bin/env node
'use strict'

/**
 * shift-report.js — per-employee "what got done" summary for a day.
 *
 *   npm run shift-report                       # today, everyone
 *   npm run shift-report -- hope               # today, just Hope
 *   npm run shift-report -- hope 2026-07-18    # a specific local day, just Hope
 *   npm run shift-report -- "" 2026-07-18      # a specific day, everyone
 *
 * Read-only: it only reads the audit_log the server already writes for every
 * mutating action, and classifies it with the SAME shared module the dashboard's
 * GET /api/shift-summary endpoint uses (src/orders/shift-summary.js).
 */

require('dotenv').config()
const { initDb } = require('../src/db/setup')
const { loadConfig } = require('../src/config/schema')
const { summarizeShift } = require('../src/orders/shift-summary')

const [, , userArg, dateArg] = process.argv

// Local-day window [start, next-midnight) for the requested date (default today).
const base = dateArg ? new Date(dateArg + 'T00:00:00') : new Date()
if (isNaN(base.getTime())) {
	console.error(`✗ Invalid date "${dateArg}" — use YYYY-MM-DD.`)
	process.exit(1)
}
base.setHours(0, 0, 0, 0)
const since = base.getTime()
const until = since + 24 * 3600 * 1000
const dayLabel = base.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric' })

const cfg = loadConfig()
const db = initDb(cfg.db_path)

const where = ['ts >= ?', 'ts < ?']
const params = [since, until]
if (userArg) {
	where.push('user = ?')
	params.push(userArg)
}
const rows = db
	.prepare(`SELECT ts, role, user, method, path, status, details FROM audit_log WHERE ${where.join(' AND ')} ORDER BY id ASC`)
	.all(...params)
	.map((r) => {
		let details = null
		try {
			details = r.details ? JSON.parse(r.details) : null
		} catch {
			details = null
		}
		return { ...r, details }
	})

const sum = summarizeShift(rows)

const LABELS = { verified: 'Verified', purchased: 'Purchased', packaged: 'Packaged', shipped: 'Shipped', issue: 'Flagged issue', unpackaged: 'Un-packaged' }
const time = (ms) => (ms ? new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—')

console.log(`\n  Shift summary — ${dayLabel}${userArg ? `  (user: ${userArg})` : ''}`)
console.log('  ' + '─'.repeat(64))
if (!sum.users.length) {
	console.log('  No recorded activity in this window.\n')
	db.close()
	process.exit(0)
}
console.log(`  First action ${time(sum.first_action_at)}   ·   Last action ${time(sum.last_action_at)}\n`)

for (const u of sum.users) {
	console.log(`  ${u.user}  (${u.role})  — ${u.actions} actions`)
	const parts = sum.buckets.filter((b) => u.counts[b] > 0).map((b) => `${LABELS[b]}: ${u.counts[b]}`)
	console.log('    ' + (parts.length ? parts.join('   ·   ') : '(no packing/shopping actions)'))
	console.log('')
}

db.close()
