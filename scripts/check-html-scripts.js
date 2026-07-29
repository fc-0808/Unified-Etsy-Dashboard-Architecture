'use strict'

/**
 * Syntax-check the inline <script> blocks of the dashboard's HTML pages.
 *
 * The UI ships as hand-written pages with large inline scripts, so a stray
 * bracket only surfaces as a blank screen at runtime. Parsing each block with
 * the V8 parser turns that into a build-time error.
 *
 * Run: `node scripts/check-html-scripts.js [file...]`  (defaults to public/*.html)
 * Exit code 0 = every block parses, 1 = at least one syntax error.
 */

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const PUBLIC_DIR = path.join(__dirname, '..', 'public')
const files = process.argv.slice(2).length
	? process.argv.slice(2).map((f) => path.resolve(f))
	: fs
			.readdirSync(PUBLIC_DIR)
			.filter((f) => f.endsWith('.html'))
			.map((f) => path.join(PUBLIC_DIR, f))

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi

let failures = 0
for (const file of files) {
	const html = fs.readFileSync(file, 'utf8')
	let blocks = 0
	for (const m of html.matchAll(SCRIPT_RE)) {
		const attrs = m[1] || ''
		const body = m[2] || ''
		// External scripts have no inline body; JSON/template blocks aren't JS.
		if (/\bsrc\s*=/i.test(attrs)) continue
		if (/\btype\s*=\s*["']?(?!text\/javascript|module|application\/javascript)/i.test(attrs)) continue
		if (!body.trim()) continue
		blocks++
		// Line number of the block's first line, so an error points at the file.
		const startLine = html.slice(0, m.index).split('\n').length
		try {
			new vm.Script(body, { filename: file, lineOffset: startLine - 1 })
		} catch (err) {
			failures++
			console.error(`  FAIL — ${path.relative(process.cwd(), file)} (inline script at line ${startLine}): ${err.message}`)
		}
	}
	console.log(`  ok  — ${path.relative(process.cwd(), file)} · ${blocks} inline script block(s) parsed`)
}

if (failures) {
	console.error(`\n${failures} inline script block(s) failed to parse.`)
	process.exit(1)
}
console.log('\nAll inline scripts parse cleanly.')
