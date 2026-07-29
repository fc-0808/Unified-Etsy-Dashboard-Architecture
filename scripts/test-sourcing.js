'use strict'

/**
 * Regression test — Sourcing Library (design-supplier registry + zip index).
 *
 * Guards two layers that the /api/sourcing endpoints + the /sourcing UI depend on:
 *
 *   1. Pure helpers in src/sourcing/library.js — zip magic-byte detection, the
 *      filename sanitiser (path-traversal defence), the storage-path traversal
 *      guard, category/status validation, and byte formatting. These are the
 *      security-sensitive, deterministic parts of the upload flow.
 *
 *   2. The DB accessors in src/db/setup.js — supplier CRUD (incl. case-insensitive
 *      duplicate rejection), the ON DELETE CASCADE from a supplier to its packages,
 *      and package CRUD + filtering by supplier/category/query.
 *
 * Run: `node scripts/test-sourcing.js`   (exit 0 = pass, 1 = regression)
 */

const path = require('path')
const os = require('os')
const fs = require('fs')

const lib = require('../src/sourcing/library')
const {
	initDb,
	insertSourcingSupplier,
	updateSourcingSupplier,
	deleteSourcingSupplier,
	getSourcingSuppliers,
	getSourcingSupplierById,
	insertSourcingPackage,
	getSourcingPackages,
	getSourcingPackageById,
	updateSourcingPackage,
	deleteSourcingPackage,
} = require('../src/db/setup')

let failures = 0
function assert(cond, msg) {
	if (cond) console.log(`  ok  — ${msg}`)
	else {
		failures++
		console.error(`  FAIL — ${msg}`)
	}
}
function throws(fn, codeWanted, msg) {
	try {
		fn()
		failures++
		console.error(`  FAIL — ${msg} (expected throw)`)
	} catch (e) {
		if (codeWanted && e.code !== codeWanted) {
			failures++
			console.error(`  FAIL — ${msg} (got code ${e.code}, wanted ${codeWanted})`)
		} else console.log(`  ok  — ${msg}`)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[1] Pure helpers — src/sourcing/library.js')

// ZIP magic-byte detection
assert(lib.looksLikeZip(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])), 'local-file-header PK\\x03\\x04 is a zip')
assert(lib.looksLikeZip(Buffer.from([0x50, 0x4b, 0x05, 0x06])), 'empty archive PK\\x05\\x06 is a zip')
assert(lib.looksLikeZip(Buffer.from([0x50, 0x4b, 0x07, 0x08])), 'spanned archive PK\\x07\\x08 is a zip')
assert(!lib.looksLikeZip(Buffer.from('%PDF-1.7')), 'a PDF is not a zip')
assert(!lib.looksLikeZip(Buffer.from([0x50, 0x4b])), 'too-short buffer is not a zip')
assert(!lib.looksLikeZip(Buffer.from('MZ\u0000\u0000')), 'an EXE is not a zip')

// Filename sanitisation — path traversal must be defeated.
assert(lib.sanitizeFilename('../../etc/passwd') === 'passwd.zip', 'strips ../ traversal + adds .zip')
assert(lib.sanitizeFilename('C:\\Windows\\evil.zip') === 'evil.zip', 'strips Windows drive path')
assert(lib.sanitizeFilename('cute cases.zip') === 'cute cases.zip', 'keeps a normal name')
assert(lib.sanitizeFilename('') === 'package.zip', 'empty → package.zip')
assert(!/[<>:"/\\|?*]/.test(lib.sanitizeFilename('a<b>c:d?e*.zip')), 'removes reserved characters')
assert(lib.sanitizeFilename('grips').toLowerCase().endsWith('.zip'), 'always ends in .zip')

// Title derivation
assert(lib.titleFromFilename('Spring Charms.zip') === 'Spring Charms', 'title drops .zip extension')
assert(lib.titleFromFilename('') === '', 'blank filename → empty title')

// Stored name uniqueness + shape
const n1 = lib.storedFileName()
const n2 = lib.storedFileName()
assert(n1 !== n2, 'stored names are unique')
assert(/^\d+-[0-9a-f]+\.zip$/.test(n1), 'stored name shape <ms>-<hex>.zip')

// Category / status validation
assert(lib.isValidCategory('phone_case') && lib.isValidCategory('grip') && lib.isValidCategory('charm'), 'the three product categories are valid')
assert(!lib.isValidCategory('sticker') && !lib.isValidCategory(''), 'unknown/blank category rejected')
assert(lib.isValidStatus('new') && lib.isValidStatus('archived'), 'known statuses valid')
assert(!lib.isValidStatus('deleted'), 'unknown status rejected')

// packageDir traversal guard
const root = path.join(os.tmpdir(), 'sourcing-root-test')
assert(lib.packageDir(root, 7, 'grip') === path.resolve(root, '7', 'grip'), 'packageDir builds <root>/<id>/<category>')
throws(() => lib.packageDir(root, 'abc', 'grip'), 'BAD_PATH', 'non-numeric supplier id rejected')
throws(() => lib.packageDir(root, 5, 'weapons'), 'BAD_PATH', 'invalid category rejected in path')

// Byte formatting
assert(lib.formatBytes(0) === '0 B', '0 bytes')
assert(lib.formatBytes(1536) === '1.5 KB', '1536 → 1.5 KB')
assert(lib.formatBytes(5 * 1024 * 1024) === '5.0 MB', '5 MB')

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[2] DB accessors — src/db/setup.js')

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sourcing-db-')), 'test.db')
const db = initDb(tmpDb)

// Supplier CRUD
throws(() => insertSourcingSupplier(db, { name: '  ' }), 'REQUIRED', 'blank supplier name rejected')
const sup = insertSourcingSupplier(db, { name: 'Shenzhen Cases', location: 'HQB', wechat: 'wx123', qq: '888' })
assert(sup && sup.id > 0, 'supplier inserted with id')
assert(sup.name === 'Shenzhen Cases' && sup.wechat === 'wx123', 'supplier fields stored')
throws(() => insertSourcingSupplier(db, { name: 'shenzhen cases' }), 'DUPLICATE', 'duplicate name (case-insensitive) rejected')

const sup2 = insertSourcingSupplier(db, { name: 'Grip World' })
assert(getSourcingSuppliers(db).length === 2, 'two suppliers listed')

const upd = updateSourcingSupplier(db, sup.id, { location: 'Futian' })
assert(upd.location === 'Futian' && upd.name === 'Shenzhen Cases', 'update patches location, keeps name')
throws(() => updateSourcingSupplier(db, sup.id, { name: 'Grip World' }), 'DUPLICATE', 'renaming onto another supplier rejected')
throws(() => updateSourcingSupplier(db, 99999, { name: 'x' }), 'NOT_FOUND', 'updating missing supplier rejected')

// Package CRUD
const p1 = insertSourcingPackage(db, { supplier_id: sup.id, category: 'phone_case', title: 'Spring cases', original_filename: 'spring.zip', stored_name: 'a.zip', size_bytes: 100, sha256: 'x', uploaded_by: 'hope' })
const p2 = insertSourcingPackage(db, { supplier_id: sup.id, category: 'grip', title: 'Round grips', original_filename: 'grips.zip', stored_name: 'b.zip', size_bytes: 200, sha256: 'y', uploaded_by: 'hope' })
insertSourcingPackage(db, { supplier_id: sup2.id, category: 'charm', title: 'Bear charms', stored_name: 'c.zip', size_bytes: 300, sha256: 'z' })
assert(p1.id > 0 && p1.status === 'new', 'package inserted with default status "new"')

assert(getSourcingPackages(db, { supplier_id: sup.id }).length === 2, 'two packages for supplier 1')
assert(getSourcingPackages(db, { supplier_id: sup.id, category: 'grip' }).length === 1, 'filter by category')
assert(getSourcingPackages(db, { supplier_id: sup.id, q: 'spring' }).length === 1, 'free-text query matches title')
assert(getSourcingPackages(db, { q: 'zzz-none' }).length === 0, 'query with no match returns none')

// package_counts surfaced on the supplier list
const listed = getSourcingSuppliers(db)
const s1row = listed.find((s) => s.id === sup.id)
assert(s1row.package_count === 2 && s1row.package_counts.grip === 1, 'supplier list carries per-category package counts')

// Update package (recategorise + status)
const pu = updateSourcingPackage(db, p2.id, { category: 'charm', status: 'listed' })
assert(pu.category === 'charm' && pu.status === 'listed', 'package recategorised + status changed')
throws(() => updateSourcingPackage(db, 99999, {}), 'NOT_FOUND', 'updating missing package rejected')

// Delete a single package
const del = deleteSourcingPackage(db, p1.id)
assert(del.id === p1.id && !getSourcingPackageById(db, p1.id), 'single package deleted')

// Cascade: deleting a supplier removes its remaining packages + returns them
const cascade = deleteSourcingSupplier(db, sup.id)
assert(cascade.packages.length === 1, 'cascade returns the 1 remaining package for file cleanup')
assert(getSourcingPackages(db, { supplier_id: sup.id }).length === 0, 'packages gone after supplier delete')
assert(!getSourcingSupplierById(db, sup.id), 'supplier gone after delete')
assert(getSourcingSuppliers(db).length === 1, 'other supplier + its package untouched')
assert(getSourcingPackages(db, { supplier_id: sup2.id }).length === 1, "sibling supplier's package intact")

db.close()
try {
	fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true })
} catch {}

// ─────────────────────────────────────────────────────────────────────────────
if (failures) {
	console.error(`\n✗ ${failures} assertion(s) failed.`)
	process.exit(1)
}
console.log('\n✓ All Sourcing Library assertions passed.')
