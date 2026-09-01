'use strict'

/**
 * Regression test — operator-facing UI should not lead with decorative emoji.
 * Typographic symbols used as UI affordances (✓ × + ← →) are allowed.
 *
 * Run: node scripts/test-ui-no-emoji.js
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const FILES = ['public/index.html', 'public/shop.html', 'public/sourcing.html', 'public/login.html'].map((f) =>
	path.join(ROOT, f),
)

// Colourful / decorative emoji that should not appear in visible UI strings.
const DECORATIVE = /[📦🛒📋✅👁🔎👉⏱🔄📱💰🏪🚚✨🖨📄💲📤🚀🚫🗑📥📂⚡🔁📍🧾🖼️✚🔍📷🛍️🔗✎👥🗂️🚪⬇⛔🧩🎬✏️⬆️⚡️]/u

// Spot-check high-traffic labels that previously carried emoji.
const MUST_BE_CLEAN = [
	'>Team<',
	'>Activity<',
	'>Shopping Mode<',
	'>Sourcing<',
	'>Packing Mode<',
	'>Need to purchase<',
	'>To pack &amp; ship<',
	'>Recently packaged<',
	'Activity log</div>',
	'>Ship with 4PX<',
	'>Mark packaged<',
	'>Charms to buy<',
]

let failures = 0
function fail(msg) {
	failures++
	console.error(`  FAIL — ${msg}`)
}
function ok(msg) {
	console.log(`  ok  — ${msg}`)
}

console.log('UI emoji regression test\n')

for (const file of FILES) {
	if (!fs.existsSync(file)) continue
	const rel = path.relative(ROOT, file)
	const lines = fs.readFileSync(file, 'utf8').split('\n')
	let hits = 0
	let inBlockComment = false
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]
		const trimmed = line.trim()
		if (inBlockComment) {
			if (trimmed.includes('*/')) inBlockComment = false
			continue
		}
		if (trimmed.startsWith('<!--')) continue
		if (trimmed.startsWith('//')) continue
		if (trimmed.includes('/*')) {
			if (!trimmed.includes('*/')) inBlockComment = true
			continue
		}
		if (DECORATIVE.test(line)) {
			hits++
			if (hits <= 3) fail(`${rel}:${i + 1} still contains decorative emoji`)
		}
	}
	if (hits === 0) ok(`${rel} has no decorative emoji in non-comment lines`)
	else if (hits > 3) fail(`${rel} has ${hits} decorative emoji line(s) total`)
}

const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8')
for (const needle of MUST_BE_CLEAN) {
	if (!index.includes(needle)) fail(`expected clean label missing: ${needle}`)
	else ok(`label present without emoji prefix: ${needle}`)
}

console.log('')
if (failures) {
	console.error(`${failures} assertion(s) FAILED`)
	process.exit(1)
}
console.log('All assertions passed.')
