'use strict'

/**
 * library.js — pure, dependency-free helpers for the Sourcing Library.
 *
 * WHY A SEPARATE MODULE
 * ----------------------------------------------------------------------------
 * The Sourcing Library lets the owner catalogue the WeChat/QQ suppliers who
 * publish zipped product folders, and lets the employee file each downloaded zip
 * against a supplier + product type (phone case / grip / charm). The security-
 * sensitive parts of that flow — validating the category, deciding a file is a
 * real zip, and turning an untrusted client filename into a safe on-disk name —
 * are pure functions with no I/O, so they live here and are imported by BOTH the
 * server (src/server/index.js) and the regression test (scripts/test-sourcing.js).
 * Keeping them here means the endpoint and the test can never drift (this mirrors
 * src/orders/pack-queue.js and src/orders/shift-summary.js).
 *
 * Nothing in this file touches the database, the network or the filesystem — it
 * is 100% deterministic and unit-testable.
 */

const path = require('path')

/**
 * The product types the shop sells, in display order. `id` is the stable value
 * stored in the DB + used in URLs and on disk; `label` / `label_zh` are for the
 * UI. Adding a category here is the ONLY change needed to extend the taxonomy.
 */
const CATEGORIES = [
	{ id: 'phone_case', label: 'Phone Cases', label_zh: '手机壳' },
	{ id: 'grip', label: 'Grips', label_zh: '手机支架' },
	{ id: 'charm', label: 'Charms', label_zh: '挂件' },
]

const CATEGORY_IDS = CATEGORIES.map((c) => c.id)

/** The intake-workflow states a package moves through, in display order. */
const STATUSES = [
	{ id: 'new', label: 'New', label_zh: '待处理' },
	{ id: 'in_progress', label: 'In progress', label_zh: '处理中' },
	{ id: 'listed', label: 'Listed', label_zh: '已上架' },
	{ id: 'archived', label: 'Archived', label_zh: '已归档' },
]

const STATUS_IDS = STATUSES.map((s) => s.id)

/** True when `id` is one of the known product categories. */
function isValidCategory(id) {
	return CATEGORY_IDS.includes(String(id || ''))
}

/** True when `id` is one of the known workflow statuses. */
function isValidStatus(id) {
	return STATUS_IDS.includes(String(id || ''))
}

/**
 * The four-byte local-file-header magic that begins every ZIP archive
 * ("PK\x03\x04"), plus the two variants a valid zip can legitimately start with:
 * an empty archive ("PK\x05\x06") and a spanned archive ("PK\x07\x08"). We accept
 * all three so a legitimately-empty or multi-part zip is not rejected.
 * @param {Buffer} buf first bytes of the uploaded stream (>= 4 bytes)
 */
function looksLikeZip(buf) {
	if (!buf || buf.length < 4) return false
	if (buf[0] !== 0x50 || buf[1] !== 0x4b) return false // "PK"
	const c = buf[2]
	const d = buf[3]
	return (c === 0x03 && d === 0x04) || (c === 0x05 && d === 0x06) || (c === 0x07 && d === 0x08)
}

/**
 * Turn an untrusted client filename into a safe basename for display/storage.
 * Strips any directory component (defeats "../" / absolute-path traversal),
 * removes control + reserved characters, collapses whitespace, and caps length.
 * NEVER used as the actual on-disk name (that is a generated token — see
 * storedFileName); this only sanitises the human-facing original_filename and
 * seeds the download filename.
 * @returns {string} a safe basename, always ending in .zip; '' → 'package.zip'
 */
function sanitizeFilename(name) {
	let s = String(name == null ? '' : name)
	// Drop any path component the client tried to smuggle in.
	s = s.replace(/\\/g, '/')
	s = s.slice(s.lastIndexOf('/') + 1)
	// Remove control chars and characters illegal on Windows/most filesystems.
	// eslint-disable-next-line no-control-regex
	s = s.replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ')
	s = s.replace(/\s+/g, ' ').trim()
	// Strip a trailing dot/space run (illegal as a Windows filename ending).
	s = s.replace(/[. ]+$/, '')
	if (!s) s = 'package.zip'
	if (s.length > 180) {
		// Preserve the .zip extension when truncating an over-long name.
		const ext = s.toLowerCase().endsWith('.zip') ? '.zip' : ''
		s = s.slice(0, 180 - ext.length) + ext
	}
	if (!s.toLowerCase().endsWith('.zip')) s += '.zip'
	return s
}

/**
 * Derive a human title from an original filename when the uploader didn't type
 * one: the basename without its .zip extension, tidied up.
 */
function titleFromFilename(name) {
	const base = sanitizeFilename(name).replace(/\.zip$/i, '')
	return base === 'package' ? '' : base
}

/**
 * Generate the opaque, collision-proof on-disk name for a stored zip. Never
 * derived from client input, so it cannot be used for traversal or to overwrite
 * another file. Shape: <epochMs>-<8 hex>.zip.
 * @param {() => string} [rand] injectable randomness (tests); defaults to crypto.
 */
function storedFileName(rand) {
	const token = rand ? String(rand()) : require('crypto').randomBytes(8).toString('hex')
	return `${Date.now()}-${token}.zip`
}

/**
 * Resolve the absolute directory a supplier's packages of one category live in,
 * and assert it stays inside the library root (defence-in-depth against a
 * poisoned supplierId/category ever reaching the path). Both segments are
 * numeric-id / known-enum, so this should never throw in practice.
 * @param {string} root  absolute path of <data>/sourcing-library
 * @throws {Error} code 'BAD_PATH' if the resolved dir escapes root
 */
function packageDir(root, supplierId, category) {
	const sid = String(parseInt(supplierId, 10))
	if (!/^\d+$/.test(sid)) throw Object.assign(new Error('Invalid supplier id.'), { code: 'BAD_PATH' })
	if (!isValidCategory(category)) throw Object.assign(new Error('Invalid category.'), { code: 'BAD_PATH' })
	const dir = path.resolve(root, sid, category)
	const base = path.resolve(root)
	if (dir !== base && !dir.startsWith(base + path.sep)) {
		throw Object.assign(new Error('Resolved path escapes the library root.'), { code: 'BAD_PATH' })
	}
	return dir
}

/** Human-readable byte size, e.g. 1536 → "1.5 KB". */
function formatBytes(n) {
	const b = Number(n) || 0
	if (b < 1024) return `${b} B`
	const units = ['KB', 'MB', 'GB', 'TB']
	let v = b / 1024
	let i = 0
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024
		i++
	}
	return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/** Look up a category's display label (falls back to the raw id). */
function categoryLabel(id) {
	const c = CATEGORIES.find((x) => x.id === id)
	return c ? c.label : String(id || '')
}

module.exports = {
	CATEGORIES,
	CATEGORY_IDS,
	STATUSES,
	STATUS_IDS,
	isValidCategory,
	isValidStatus,
	looksLikeZip,
	sanitizeFilename,
	titleFromFilename,
	storedFileName,
	packageDir,
	formatBytes,
	categoryLabel,
}
