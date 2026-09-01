'use strict'
/**
 * The charm manifest seeds Notes with an instruction to "Fill SKU (C)" — a
 * field the dashboard no longer has. Both the importer and the one-off cleanup
 * in src/db/setup.js drop that text, which means one regex decides whether a
 * charm's note is machine boilerplate or something an operator typed.
 *
 * A false positive here silently erases the operator's own words, so this pins
 * both directions: every shape the manifest actually produces is recognised,
 * and anything a person could plausibly write is left alone — including notes
 * that mention importing, or a date, or even a SKU, just not all three in the
 * generated form.
 *
 * Run: `node scripts/test-charm-notes.js`
 */

const assert = require('assert')
const { isImportBoilerplateNote, cleanCharmNote } = require('../src/route/charm-notes')

const GREEN = '\x1b[32m', RED = '\x1b[31m', BOLD = '\x1b[1m', RESET = '\x1b[0m'
let passed = 0
const failures = []

function check(name, fn) {
	try {
		fn()
		passed++
		console.log(`${GREEN}  ok${RESET}  — ${name}`)
	} catch (err) {
		failures.push({ name, err })
		console.log(`${RED}  FAIL${RESET} — ${name}`)
	}
}

// The two shapes present in route-engine/data/charm_manifest.json today. The
// second carries Excel's _x000d_ carriage-return escapes, exactly as exported.
const BOILERPLATE = [
	'Auto-import 2026-04-03 05:49 UTC. Fill SKU (C) and optional Default Charm Shop (D).',
	'Imported 2026-04-03 05:49 UTC._x000d_\n_x000d_\n• Fill SKU (C)._x000d_\n_x000d_\n• Optional: Default shop (D).',
	'  auto-import 2025-11-02 09:00 UTC. fill sku (c) and optional default charm shop (d).',
]

const OPERATOR = [
	'',
	'beaded, fragile',
	'Ask for the pink one — the blue fades.',
	'Imported from the old spreadsheet by hand',
	'2026-04-03: bought two spares',
	'SKU on the tag is CHM-HK-PINK, ignore it',
	'Auto-import note removed; this charm is now sourced at 2D21',
]

for (const note of BOILERPLATE) {
	check(`recognised as import boilerplate: ${JSON.stringify(note.slice(0, 48))}…`, () => {
		assert.strictEqual(isImportBoilerplateNote(note), true)
		assert.strictEqual(cleanCharmNote(note), '')
	})
}

for (const note of OPERATOR) {
	check(`left untouched: ${JSON.stringify(note.slice(0, 48))}`, () => {
		assert.strictEqual(isImportBoilerplateNote(note), false, 'an operator note was mistaken for boilerplate')
		assert.strictEqual(cleanCharmNote(note), note, 'an operator note was rewritten')
	})
}

check('a missing note is not an error', () => {
	assert.strictEqual(isImportBoilerplateNote(null), false)
	assert.strictEqual(isImportBoilerplateNote(undefined), false)
	assert.strictEqual(cleanCharmNote(null), '')
	assert.strictEqual(cleanCharmNote(undefined), '')
})

check('clearing is idempotent — a cleared note stays cleared', () => {
	assert.strictEqual(cleanCharmNote(cleanCharmNote(BOILERPLATE[0])), '')
})

console.log('')
if (failures.length) {
	console.log(`${RED}${BOLD}  ${failures.length} check(s) failed${RESET}, ${passed} passed`)
	for (const f of failures) console.log(`\n${RED}• ${f.name}${RESET}\n${f.err.stack}`)
	process.exit(1)
}
console.log(`${GREEN}${BOLD}  All ${passed} checks passed.${RESET}`)
