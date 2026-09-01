'use strict'

/**
 * Regression test — Activity log modal must stay readable on a phone.
 *
 * The feed is a four-column table on desktop. On narrow viewports it becomes a
 * bottom sheet with card rows (who + result on one line, full action text, time
 * beneath) so action sentences are never truncated behind horizontal scroll.
 *
 * Run: node scripts/test-activity-ui.js
 */

const fs = require('fs')
const path = require('path')

const PAGE = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8')
const ACTIVITY_START = PAGE.indexOf('const ACTIVITY = (() => {')
const ACTIVITY_END = PAGE.indexOf('// ── State ──', ACTIVITY_START)
const ACTIVITY = ACTIVITY_START >= 0 && ACTIVITY_END > ACTIVITY_START
	? PAGE.slice(ACTIVITY_START, ACTIVITY_END)
	: ''

let failures = 0
function assert(cond, msg) {
	if (cond) console.log(`  ok  — ${msg}`)
	else {
		failures++
		console.error(`  FAIL — ${msg}`)
	}
}

console.log('Activity log mobile UI regression test\n')

assert(/id="auditModal"/.test(PAGE), 'the activity log modal is present')
assert(/class="modal-box audit-modal-box"/.test(PAGE), '…uses a dedicated modal box class instead of inline width')
assert(/class="table-wrap audit-table-wrap"/.test(PAGE), '…and a scroll region class on the feed')
assert(/id="auditTable"/.test(PAGE), '…with a table id for mobile card scoping')

assert(/class="audit-row"/.test(PAGE), 'activity rows carry audit-row for the mobile card layout')
assert(/class="audit-when"/.test(PAGE), '…with semantic cell classes')
assert(/class="audit-action"/.test(PAGE), '…including audit-action so text can wrap')
assert(/class="audit-detail"/.test(PAGE), '…and audit-detail for secondary context')
assert(/audit-product-context/.test(ACTIVITY), 'line-level activity renders a dedicated product context')
assert(/Array\.isArray\(d\.products\)/.test(ACTIVITY) && /audit-order-products/.test(ACTIVITY), 'packaged-order activity renders all supplied product contexts')
assert(/d\.products\.filter[\s\S]*\.slice\(0, 8\)/.test(ACTIVITY), 'packaged-order product rendering is defensively bounded')
assert(/audit-product-thumb/.test(ACTIVITY), '…with a product thumbnail')
assert(/audit-product-title/.test(ACTIVITY), '…and a compact, dedicated product title')
assert(/loading="lazy"/.test(ACTIVITY), '…whose image loading is deferred for long activity feeds')
assert(/option\('Model(?: to buy)?'/.test(ACTIVITY) && /option\('Style'/.test(ACTIVITY), '…and readable model/style option chips')
assert(/safeProductImage/.test(ACTIVITY) && /i\.etsystatic\.com/.test(ACTIVITY), 'product image URLs are allowlisted again in the browser')
assert(/src="\$\{_escHtml\(image\)\}"/.test(ACTIVITY), 'product image attributes are HTML-escaped')
assert(/title="\$\{_escHtml\(title\)\}"/.test(ACTIVITY), 'the complete product name remains available through a safely escaped tooltip')
assert(/remainingDetail = detail === productDetail/.test(ACTIVITY), 'the old Product detail is removed instead of rendering the title twice')
assert(!/<a\b[^>]*\bclass=["'][^"']*\baudit-product-media\b/.test(ACTIVITY), 'uploaded image endpoints are never opened as top-level same-origin pages')
assert(/const RENDER_BATCH = 150/.test(ACTIVITY) && /allRows\.slice\(0, _renderLimit\)/.test(ACTIVITY), 'long feeds render in bounded batches')
assert(/requestSeq !== _loadSeq/.test(ACTIVITY), 'stale range responses cannot overwrite the latest selection')
assert(/const DEFAULT_USER = 'hope'/.test(ACTIVITY) && /_activeUser = DEFAULT_USER/.test(ACTIVITY), 'every open defaults to Hope’s activity')
assert(/const DEFAULT_RANGE = 'today'/.test(ACTIVITY) && /_range = DEFAULT_RANGE/.test(ACTIVITY), 'every open defaults to today’s local-day range')
assert(/class="earn-seg-btn active" data-range="today" aria-pressed="true"/.test(PAGE), 'the static range state also starts on Today')

assert(/#auditModal \.audit-modal-box/.test(PAGE), 'desktop modal sizing lives in CSS')
assert(/\.audit-product-thumb\s*\{[^}]*object-fit:\s*cover/.test(PAGE), 'product thumbnails have a bounded, cropped desktop layout')
assert(/\.audit-product-title\s*\{[^}]*-webkit-line-clamp:\s*2/.test(PAGE), 'long product names are visually clamped to two lines')
assert(/\.audit-order-products\.is-multi \.audit-product-title\s*\{[^}]*-webkit-line-clamp:\s*1/.test(PAGE), 'multi-product packaged orders use one-line titles per product')
assert(/role="dialog"/.test(PAGE) && /aria-modal="true"/.test(PAGE) && /aria-labelledby="auditModalTitle"/.test(PAGE), 'the activity sheet exposes dialog semantics')
assert(/_returnFocus/.test(ACTIVITY) && /event\.key !== 'Tab'/.test(ACTIVITY), 'the activity dialog traps and restores keyboard focus')
assert(/@media \(max-width: 768px\)[\s\S]*#auditModal\.modal-overlay\.open[\s\S]*align-items: flex-end/.test(PAGE), 'mobile opens as a bottom sheet')
assert(/#auditModal \.audit-row[\s\S]*grid-template-areas/.test(PAGE), 'mobile rows reflow as cards, not a clipped table')
assert(/#auditModal \.audit-product-media\s*\{[^}]*flex-basis:\s*56px/.test(PAGE), 'mobile product thumbnails stay clear without dominating each card')
assert(/#auditModal #auditTable thead[\s\S]*display: none/.test(PAGE), 'mobile hides table headers')
assert(/#auditModal \.audit-filters[\s\S]*overflow-x: auto/.test(PAGE), 'person filters scroll horizontally instead of wrapping awkwardly')
assert(/#auditModal #auditRange \.earn-seg-btn[\s\S]*flex: 1/.test(PAGE), 'time-range pills share the full width on mobile')

console.log('')
if (failures > 0) {
	console.error(`${failures} assertion(s) FAILED`)
	process.exit(1)
}
console.log('All assertions passed.')
