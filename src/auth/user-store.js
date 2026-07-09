/**
 * user-store.js — named per-person accounts backed by SQLite.
 *
 * WHY (the "hiring employees" upgrade)
 * ----------------------------------------------------------------------------
 * A single shared "packer" password works for one employee but breaks the moment
 * you have two, or need to remove one: you can't tell who did what, and removing
 * access means changing everyone's password. Named accounts fix both:
 *   • Accountability — the audit log records the actual person (username).
 *   • Clean offboarding — disable ONE account without touching anyone else, and
 *     an instant kill-switch (token_version) invalidates that person's live
 *     sessions immediately, even though cookies otherwise last weeks.
 *
 * Passwords are stored only as scrypt hashes (salt + hash) — never in plaintext.
 * The env-var owner/packer passwords in access.js still work as a bootstrap so
 * the owner can never be locked out; named accounts are layered on top.
 */

const crypto = require('crypto')

const SCRYPT_KEYLEN = 64

function hashPassword(password, salt) {
	salt = salt || crypto.randomBytes(16).toString('hex')
	const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex')
	return { salt, hash }
}

function verifyPassword(password, salt, hash) {
	const derived = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN)
	const stored = Buffer.from(hash, 'hex')
	if (derived.length !== stored.length) return false
	return crypto.timingSafeEqual(derived, stored)
}

/**
 * @param {import('better-sqlite3').Database} db
 */
/** Roles a named account may hold. `shopper` = mobile shopping-route only. */
const USER_ROLES = ['owner', 'packer', 'shopper']

function createUserStore(db) {
	db.exec(`CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL COLLATE NOCASE,
    role          TEXT NOT NULL CHECK (role IN ('owner','packer','shopper')),
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    active        INTEGER NOT NULL DEFAULT 1,
    token_version INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    created_by    TEXT,
    last_login_at INTEGER
  )`)

	// Migration: older installs created `users` with a CHECK that only permitted
	// ('owner','packer'). SQLite bakes CHECK constraints into the table, so a
	// plain CREATE IF NOT EXISTS won't loosen it — inserting a 'shopper' would
	// throw on those DBs. If the live table still lacks 'shopper', rebuild it
	// (data preserved) with the widened constraint. Wrapped so a failure here can
	// never take the whole app down at boot.
	try {
		const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get()
		if (ddl && ddl.sql && !/shopper/.test(ddl.sql)) {
			const rebuild = db.transaction(() => {
				db.exec(`CREATE TABLE users_new (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL COLLATE NOCASE,
    role          TEXT NOT NULL CHECK (role IN ('owner','packer','shopper')),
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    active        INTEGER NOT NULL DEFAULT 1,
    token_version INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    created_by    TEXT,
    last_login_at INTEGER
  )`)
				db.exec(`INSERT INTO users_new
    (id, username, role, password_salt, password_hash, active, token_version, created_at, created_by, last_login_at)
    SELECT id, username, role, password_salt, password_hash, active, token_version, created_at, created_by, last_login_at FROM users`)
				db.exec('DROP TABLE users')
				db.exec('ALTER TABLE users_new RENAME TO users')
			})
			rebuild()
		}
	} catch (e) {
		console.warn('[user-store] shopper-role migration skipped:', e.message)
	}

	const store = {
		count() {
			return db.prepare('SELECT COUNT(*) AS c FROM users').get().c
		},
		list() {
			// Never expose password material.
			return db.prepare('SELECT id, username, role, active, token_version, created_at, created_by, last_login_at FROM users ORDER BY role DESC, username ASC').all()
		},
		getByName(username) {
			if (!username) return null
			return db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(username).trim())
		},
		getById(id) {
			return db.prepare('SELECT * FROM users WHERE id = ?').get(id)
		},
		activeOwnerCount() {
			return db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'owner' AND active = 1").get().c
		},
		add({ username, password, role, createdBy }) {
			username = String(username || '').trim()
			if (!username) throw new Error('Username is required')
			if (!/^[a-zA-Z0-9._-]{2,40}$/.test(username)) throw new Error('Username must be 2–40 chars: letters, numbers, dot, dash, underscore')
			if (!password || String(password).length < 4) throw new Error('Password must be at least 4 characters')
			if (!USER_ROLES.includes(role)) throw new Error("Role must be 'owner', 'packer' or 'shopper'")
			if (store.getByName(username)) throw new Error(`User "${username}" already exists`)
			const { salt, hash } = hashPassword(password)
			const info = db
				.prepare('INSERT INTO users (username, role, password_salt, password_hash, active, token_version, created_at, created_by) VALUES (?, ?, ?, ?, 1, 0, ?, ?)')
				.run(username, role, salt, hash, Date.now(), createdBy || null)
			return store.getById(info.lastInsertRowid)
		},
		/** Verify a login. Returns { id, username, role, token_version } or null. */
		verify(username, password) {
			const u = store.getByName(username)
			if (!u || !u.active) return null
			if (!verifyPassword(password, u.password_salt, u.password_hash)) return null
			db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), u.id)
			return { id: u.id, username: u.username, role: u.role, token_version: u.token_version }
		},
		/**
		 * Confirm a live session's user still exists, is active, and its token
		 * version matches (the kill-switch). Returns { id, username, role } or null.
		 */
		validateSession(username, tokenVersion) {
			const u = store.getByName(username)
			if (!u || !u.active) return null
			if (Number(u.token_version) !== Number(tokenVersion)) return null
			return { id: u.id, username: u.username, role: u.role }
		},
		/** Disable (offboard) or re-enable. Disabling also revokes live sessions. */
		setActive(id, active) {
			db.prepare('UPDATE users SET active = ?, token_version = token_version + 1 WHERE id = ?').run(active ? 1 : 0, id)
			return store.getById(id)
		},
		/** Force-logout a user everywhere without disabling the account. */
		revokeSessions(id) {
			db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(id)
			return store.getById(id)
		},
		setPassword(id, password) {
			if (!password || String(password).length < 4) throw new Error('Password must be at least 4 characters')
			const { salt, hash } = hashPassword(password)
			db.prepare('UPDATE users SET password_salt = ?, password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(salt, hash, id)
			return store.getById(id)
		},
	}
	return store
}

module.exports = { createUserStore, hashPassword, verifyPassword, USER_ROLES }
