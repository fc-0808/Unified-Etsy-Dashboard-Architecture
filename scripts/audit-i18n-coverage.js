'use strict'

/**
 * Audit I18N_DICT coverage against static UI strings in public/index.html.
 * Run: node scripts/audit-i18n-coverage.js
 */

const fs = require('fs')
const path = require('path')

const source = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8')

const dictStart = source.indexOf('const I18N_DICT = {')
const dictEnd = source.indexOf('const I18N_PATTERNS', dictStart)
const dictLiteral = source.slice(source.indexOf('{', dictStart), source.lastIndexOf('}', dictEnd) + 1)
const I18N_DICT = new Function(`return (${dictLiteral})`)()

const patStart = source.indexOf('const I18N_PATTERNS = [', dictEnd)
const patEnd = source.indexOf('const I18N = (() => {', patStart)
const patternsSrc = source.slice(patStart, patEnd)
const patternRes = [...patternsSrc.matchAll(/re:\s*(\/[^/]+\/[a-z]*)/g)].map((m) => {
	try {
		return eval(m[1])
	} catch {
		return null
	}
}).filter(Boolean)

function covered(s) {
	const t = s.trim()
	if (!t || t.length < 2) return true
	if (/^[\d\s.,:;#@$%&*+\-–—/\\|()[\]{}<>]+$/.test(t)) return true
	if (/^https?:\/\//.test(t)) return true
	if (t in I18N_DICT && I18N_DICT[t] !== t) return true
	for (const re of patternRes) {
		if (re.test(t)) return true
	}
	return false
}

// Skip: buyer names, iPhone models, product styles, SKUs, receipt IDs, etc.
const SKIP_RES = [
	/^iPhone\s/i,
	/^AirPods/i,
	/^iPad/i,
	/^Samsung/i,
	/^Google Pixel/i,
	/Pro Max|Pro\b|Plus\b|Mini\b/,
	/^\d{6,}$/,
	/^#[-\d]+$/,
	/^CH-\d+/i,
	/^4PX/i,
	/^Y2K/i,
	/^Case\b|^Grip\b|^Charm\b/i,
	/^[A-Z]{2,3}$/, // country codes alone
	/^[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}$/i,
]

function shouldSkip(s) {
	const t = s.trim()
	if (t.length > 120) return false // long UI sentences should translate
	if (SKIP_RES.some((re) => re.test(t))) return true
	// Likely a person name: two capitalized words only
	if (/^[A-Z][a-z]+ [A-Z][a-z]+$/.test(t)) return true
	return false
}

const candidates = new Set()

// Static HTML text between tags (simple extraction)
const htmlPart = source.slice(source.indexOf('<body'), source.indexOf('<script', source.indexOf('<body')))
for (const m of htmlPart.matchAll(/>([^<>{}\n\r][^<>{}\n\r]{1,200})</g)) {
	const t = m[1].replace(/\s+/g, ' ').trim()
	if (t && !/^\s*$/.test(t) && !/^[\d\s.,]+$/.test(t)) candidates.add(t)
}

// title= and placeholder= in HTML portion
for (const m of htmlPart.matchAll(/(?:title|placeholder)="([^"]{2,200})"/g)) {
	candidates.add(m[1].trim())
}

// PRESET_HINT strings
const hintBlock = source.match(/const PRESET_HINT = \{([\s\S]*?)\n\t\t\t\}/)
if (hintBlock) {
	for (const m of hintBlock[1].matchAll(/:\s*'((?:\\'|[^'])*)'/g)) {
		candidates.add(m[1].replace(/\\'/g, "'"))
	}
}

// Common button/modal strings in JS template literals (short phrases)
for (const m of source.matchAll(/>([A-Z][^<]{2,80})<\//g)) {
	const t = m[1].replace(/\s+/g, ' ').trim()
	if (t.length >= 3 && t.length <= 80) candidates.add(t)
}

const missing = []
for (const s of [...candidates].sort()) {
	if (shouldSkip(s)) continue
	if (!covered(s)) missing.push(s)
}

console.log(`I18N audit: ${Object.keys(I18N_DICT).length} dict entries, ${patternRes.length} patterns`)
console.log(`Candidates: ${candidates.size}, uncovered: ${missing.length}\n`)
for (const s of missing.slice(0, 150)) {
	console.log(`  MISSING: ${JSON.stringify(s)}`)
}
if (missing.length > 150) console.log(`  … and ${missing.length - 150} more`)

process.exit(missing.length ? 1 : 0)
