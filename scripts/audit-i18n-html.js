'use strict'

/** HTML + PRESET_HINT only — fewer JS false positives */
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
const patternRes = [...patternsSrc.matchAll(/re:\s*(\/[^/]+\/[a-z]*)/g)]
	.map((m) => {
		try {
			return eval(m[1])
		} catch {
			return null
		}
	})
	.filter(Boolean)

function covered(s) {
	const t = s.trim()
	if (!t || t.length < 2) return true
	if (/^[\d\s.,:;#@$%&*+\-–—/\\|()[\]{}<>]+$/.test(t)) return true
	if (t in I18N_DICT && I18N_DICT[t] !== t) return true
	for (const re of patternRes) if (re.test(t)) return true
	return false
}

const SKIP_RES = [
	/^iPhone\s/i,
	/^AirPods/i,
	/^iPad/i,
	/Pro Max|Pro\b|Plus\b|Mini\b/,
	/^\d{6,}$/,
	/^CH-\d+/i,
	/^Y2K/i,
	/^[A-Z][a-z]+ [A-Z][a-z]+$/,
]

function shouldSkip(s) {
	const t = s.trim()
	if (t.includes('${')) return true
	if (SKIP_RES.some((re) => re.test(t))) return true
	return false
}

const candidates = new Set()
const htmlPart = source.slice(source.indexOf('<body'), source.indexOf('<script', source.indexOf('<body')))
for (const m of htmlPart.matchAll(/>([^<>{}\n\r][^<>{}\n\r]{1,200})</g)) {
	const t = m[1].replace(/\s+/g, ' ').trim()
	if (t) candidates.add(t)
}
for (const m of htmlPart.matchAll(/(?:title|placeholder|aria-label)="([^"]{2,200})"/g)) {
	candidates.add(m[1].trim())
}

const hintBlock = source.match(/const PRESET_HINT = \{([\s\S]*?)\n\t\t\t\}/)
if (hintBlock) {
	for (const m of hintBlock[1].matchAll(/:\s*'((?:\\'|[^'])*)'/g)) {
		candidates.add(m[1].replace(/\\'/g, "'"))
	}
}

const missing = [...candidates].filter((s) => !shouldSkip(s) && !covered(s)).sort((a, b) => a.length - b.length)
console.log(`HTML+hint uncovered: ${missing.length}`)
for (const s of missing) console.log(JSON.stringify(s))
