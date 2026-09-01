#!/usr/bin/env node
/**
 * relocate-db.js — safely move the SQLite database OUT of a cloud-synced folder.
 *
 * Running a live SQLite DB inside OneDrive/Dropbox/Drive risks corruption (the
 * sync client uploads/locks the file mid-write and can restore stale copies).
 * This moves it to a local, non-synced folder and repoints config.json.
 *
 *   1. STOP the dashboard first (npm run auto:stop) so nothing is writing.
 *   2. node scripts/relocate-db.js
 *   3. Start it again (npm run auto:start).
 *
 * It uses SQLite `VACUUM INTO` to write a clean, consistent copy (no WAL/SHM
 * leftovers), verifies integrity, updates config.json, and renames the old file
 * aside (never deletes your data).
 */

require('dotenv').config({ quiet: true })
const fs = require('fs')
const os = require('os')
const path = require('path')
const Database = require('better-sqlite3')
const { loadConfig } = require('../src/config/schema')

const configPath = process.env.DASHBOARD_CONFIG_PATH
	? path.resolve(process.env.DASHBOARD_CONFIG_PATH)
	: path.resolve('config.json')
const srcPath = loadConfig().db_path

if (!fs.existsSync(srcPath)) {
	console.error(`✗ Database not found at ${srcPath}`)
	process.exit(1)
}

const synced = /onedrive|dropbox|google ?drive|gdrive/i.test(srcPath)
if (!synced) {
	console.log(`ℹ The database is already outside a known cloud-sync folder:\n  ${srcPath}`)
	console.log('  Nothing to do. (Set a custom location manually in config.json if you still want to move it.)')
	process.exit(0)
}

const targetDir = process.env.DASHBOARD_DB_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), 'EtsyDashboard')
const targetPath = path.join(targetDir, 'etsy_dashboard.db')

if (fs.existsSync(targetPath)) {
	console.error(`✗ A database already exists at the destination:\n  ${targetPath}\n  Move or delete it first so we never overwrite data.`)
	process.exit(1)
}

console.log(`Relocating database:\n  from: ${srcPath}\n  to  : ${targetPath}\n`)
fs.mkdirSync(targetDir, { recursive: true })

// 1. Consistent copy via VACUUM INTO (SQLite accepts forward slashes on Windows).
try {
	const src = new Database(srcPath, { readonly: true })
	const litPath = targetPath.replace(/\\/g, '/').replace(/'/g, "''")
	src.exec(`VACUUM INTO '${litPath}'`)
	src.close()
} catch (e) {
	console.error('✗ Copy failed:', e.message)
	process.exit(1)
}

// 2. Verify the new file.
try {
	const chk = new Database(targetPath, { readonly: true })
	const result = chk.pragma('integrity_check')
	chk.close()
	const ok = Array.isArray(result) && result[0] && (result[0].integrity_check === 'ok' || result[0] === 'ok')
	if (!ok) throw new Error('integrity_check did not return ok: ' + JSON.stringify(result))
} catch (e) {
	console.error('✗ Verification failed, aborting (your original DB is untouched):', e.message)
	try {
		fs.unlinkSync(targetPath)
	} catch {}
	process.exit(1)
}

// 3. Repoint config.json (minimal edit — only the db_path value).
const raw = fs.readFileSync(configPath, 'utf8')
const updated = raw.replace(/("db_path"\s*:\s*)(?:"[^"]*"|null)/, `$1${JSON.stringify(targetPath)}`)
if (updated === raw) {
	console.error('✗ Could not auto-edit config.json. The verified copy was left at:\n  ' + targetPath)
	console.error('  The original database and config are untouched; set db_path manually if desired.')
	process.exit(1)
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const configBackup = `${configPath}.bak-${stamp}`
try {
	fs.copyFileSync(configPath, configBackup)
} catch (e) {
	console.error('✗ Could not back up config.json; refusing to repoint it:', e.message)
	process.exit(1)
}
fs.writeFileSync(configPath, updated)
console.log(`✓ Updated config.json db_path (backup: ${configBackup}).`)

// 4. Rename the old cloud-synced DB aside (keep as a safety copy, never delete).
for (const suffix of ['', '-wal', '-shm']) {
	const f = srcPath + suffix
	if (fs.existsSync(f)) {
		try {
			fs.renameSync(f, `${f}.moved-${stamp}`)
		} catch (e) {
			console.warn(`⚠ Could not rename ${f}: ${e.message}`)
		}
	}
}

console.log(`\n✓ Done. New database location:\n  ${targetPath}`)
console.log('  Old files were renamed with a .moved-* suffix (safe to delete once verified).')
console.log('  Start the dashboard again: npm run auto:start')
