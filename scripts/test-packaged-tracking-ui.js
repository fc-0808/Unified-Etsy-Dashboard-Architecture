'use strict'

/**
 * Regression tests — packing-mode Recently packaged 4PX status UI.
 *
 * The card must show the latest official 4PX event (the same first line as the
 * parcel-route modal) and isolate abnormal scans without putting tracking
 * numbers into inline JavaScript.
 *
 * Run: node scripts/test-packaged-tracking-ui.js
 */

const fs = require('fs')
const path = require('path')

const html = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8')
const moduleSrc = fs.readFileSync(path.resolve(__dirname, '../src/orders/carrier-tracking.js'), 'utf8')

let failures = 0
function assert(cond, msg) {
	if (cond) console.log(`  ok  — ${msg}`)
	else {
		failures++
		console.error(`  FAIL — ${msg}`)
	}
}

console.log('Recently packaged 4PX status UI\n')

assert(html.includes('function renderCarrierStatusHtml('), 'the card renderer exists')
assert(html.includes('o.carrier_tracking'), 'the card reads the shaped snapshot, not raw columns')
assert(/escHtml\(\s*event\s*\)/.test(html), 'latest-event text is HTML-escaped')
assert(/escHtml\(\s*reason\s*\)/.test(html), 'health-reason text is HTML-escaped')
assert(/escHtml\(\s*loc\s*\)/.test(html), 'location text is HTML-escaped')
assert(html.includes('carrier-status-event'), 'the latest 4PX event has a dedicated scan line')
assert(html.includes('class="carrier-status'), 'the snapshot is not stuffed into the coarse Pre-transit pill')
assert(html.includes('is-carrier-attention'), 'abnormal parcels mark the row')
assert(html.includes('setPackagedTrackingFilter'), 'the 4PX chip strip has a setter')
assert(html.includes("params.set('tracking'"), 'fetchOrders sends tracking= for the Attention chip')
assert(html.includes('data.tracking_counts'), 'the chip strip is painted from tracking_counts on the same response')
assert(html.includes("label: 'Attention'"), 'Attention is a first-class chip, not a client-side hide')
assert(html.includes('body.mode-packer #tab-orders .carrier-status-event'), 'packing mode enlarges the latest event')
assert(html.includes('packaged-days-group--tracking'), 'Packed day chips and 4PX chips are visually grouped, not one long strip')
assert(html.includes('is-attention:not(.carrier-status--warning)'), 'delayed attention stays warning-orange, not stuck-rose')
assert(/data-tracking="\$\{escAttr\(trackingNo\)\}"/.test(html), 'tracking numbers in attributes use escAttr')
assert(html.includes('#tab-orders .order-row:not(.is-open) .carrier-status'), 'collapsed mobile cards keep the latest scan visible')
assert(html.includes('is-openable fpx-track-link'), 'the status block reuses the parcel-route click handler')
assert(!/renderCarrierStatusHtml[\s\S]{0,800}onclick="open4pxTrackModal\(/.test(html), 'tracking numbers never enter inline JavaScript on the status block')
assert(html.includes('carrier-status.fpx-track-link[data-tracking]'), 'Enter/Space opens the timeline from the status block')
assert(html.includes('const coarsePillHtml = carrierStatusHtml'), 'a 4PX snapshot replaces the stale local Pre-transit/In-transit pill')
assert(html.includes("window.__packerTrackingFilter = 'all'"), 'leaving Recently packaged clears the 4PX chip')
assert(html.includes('data.tracking_days'), 'Attention uses tracking_days so Packed chips become a date filter')
assert(html.includes('packaged-day-head'), 'Attention groups rows by packed day')
assert(html.includes('function refreshPackagedTracking('), 'Attention can restamp the page from live 4PX')
assert(html.includes('applyCarrierTrackingUpdate'), 'opening the parcel-route modal patches the card from the persisted snapshot')
assert(html.includes('schedulePackagedTrackingRefetch'), 'a delivered live snapshot drops the card off Attention instead of sitting as a stale row')
assert(html.includes('tracking_status === \'delivered\''), 'Shipping prefers delivered over leftover stuck health')
assert(!/📦|🚚|✈️/.test(html.match(/carrier-status[\s\S]{0,2500}carrier-status-event/)?.[0] || ''), 'the status block does not lead with decorative emoji')

assert(moduleSrc.includes("tr.order.tracking.get"), 'the module names the official Open Platform method')
assert(moduleSrc.includes('language=en') || fs.readFileSync(path.resolve(__dirname, '../src/fourpx/api.js'), 'utf8').includes('language=en'), '4PX responses are requested in English')
assert(
	moduleSrc.includes('without calling 4PX once per row') || /fan out to the carrier/.test(moduleSrc),
	'the list contract forbids per-row 4PX lookups',
)

console.log(failures ? `\n${failures} failure(s)` : '\nAll packaged-tracking UI checks passed.')
process.exit(failures ? 1 : 0)
