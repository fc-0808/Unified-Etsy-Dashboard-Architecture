'use strict'

/**
 * Regression test — the offline write-queue's pure logic (public/shop-sync.js).
 *
 * The op-id + coalescing rules are the correctness core of the durable queue: they
 * decide which taps merge into one write and which stay distinct. Getting them
 * wrong silently drops or duplicates a shopper's purchase. The SAME module runs in
 * the page, the service worker, and here — so this test locks the behavior for all
 * three. (IndexedDB itself isn't available in Node; those helpers are covered by
 * manual/e2e testing — here we drive the deterministic pure functions.)
 *
 * Run: `node scripts/test-shop-sync.js`   (0 = pass, 1 = regression)
 */

const ShopSync = require('../public/shop-sync.js')

let failures = 0
function assert(cond, msg) {
	if (cond) console.log(`  ok  — ${msg}`)
	else {
		failures++
		console.error(`  FAIL — ${msg}`)
	}
}

console.log('Offline write-queue (shop-sync) regression test\n')

// ── Op ids ──────────────────────────────────────────────────────────────────────
assert(ShopSync.assignOpId(123, 'abc') === ShopSync.assignOpId(123, 'abc'), 'assignOpId is deterministic')
assert(ShopSync.assignOpId(123, 'abc') !== ShopSync.assignOpId(124, 'abc'), 'assignOpId distinguishes receipts')
assert(ShopSync.assignOpId(123, 'abc') !== ShopSync.assignOpId(123, 'abd'), 'assignOpId distinguishes line items')
assert(ShopSync.costOpId({ kind: 'product', title: 'Case A', part: 'case' }) !== ShopSync.costOpId({ kind: 'product', title: 'Case A', part: 'grip' }), 'costOpId distinguishes case vs grip of same product')
assert(ShopSync.costOpId({ kind: 'charm', code: 'CH-1' }) !== ShopSync.costOpId({ kind: 'charm', code: 'CH-2' }), 'costOpId distinguishes charms')
assert(ShopSync.costOpId({ kind: 'product', title: 'X', part: 'case' }) !== ShopSync.costOpId({ kind: 'charm', code: 'X' }), 'product and charm cost ids never collide')

// ── Assign entry: fresh ───────────────────────────────────────────────────────
const e1 = ShopSync.makeAssignEntry(null, {
	receipt_id: 5,
	item_key: 'k',
	title: 'Widget',
	patch: { status_case: 'Purchased' },
	context: {
		phone_model: 'iPhone 17 Pro Max',
		style: 'Case 1 + Grip 1 + Charm',
		quantity: 2,
		product_listing_id: 777,
		product_image_url: '/api/route/listing-image/777?w=300',
	},
}, 1000)
assert(e1.url === '/api/shop/assign', 'assign entry targets /api/shop/assign')
assert(e1.id === ShopSync.assignOpId(5, 'k'), 'assign entry id matches its line')
assert(e1.body.receipt_id === 5 && e1.body.item_key === 'k' && e1.body.title === 'Widget', 'assign body carries line identity')
assert(e1.body.status_case === 'Purchased', 'assign body carries the patch')
assert(e1.body.phone_model === 'iPhone 17 Pro Max' && e1.body.style === 'Case 1 + Grip 1 + Charm', 'assign body snapshots the model and style shown to the shopper')
assert(e1.body.product_listing_id === 777 && e1.body.product_image_url.includes('/listing-image/777'), 'assign body snapshots the exact product image reference')
assert(e1.body.activity_context_version === ShopSync.ACTIVITY_CONTEXT_VERSION, 'assign body versions its event-time activity context')
assert(e1.ts === 1000, 'assign entry stamps the provided clock')

// ── Assign entry: coalescing (case then charm → ONE write with both) ────────────
const e2 = ShopSync.makeAssignEntry(e1, { receipt_id: 5, item_key: 'k', title: 'Widget', patch: { status_charm: 'Purchased' } }, 2000)
assert(e2.id === e1.id, 'a second tap on the same line coalesces into the same entry')
assert(e2.body.status_case === 'Purchased' && e2.body.status_charm === 'Purchased', 'coalesced entry retains BOTH component changes')
assert(e2.body.phone_model === 'iPhone 17 Pro Max' && e2.body.product_image_url === e1.body.product_image_url, 'coalescing preserves the event-time product context')
assert(e2.ts === 2000, 'coalesced entry advances the timestamp')

// ── Assign entry: last-writer-wins on the same component ────────────────────────
const e3 = ShopSync.makeAssignEntry(e2, { receipt_id: 5, item_key: 'k', title: 'Widget', patch: { status_case: 'Pending' } }, 3000)
assert(e3.body.status_case === 'Pending', 'the latest value for a component wins (undo/redo safe)')
assert(e3.body.status_charm === 'Purchased', 'unrelated coalesced fields are preserved')

// ── makeAssignEntry never mutates the previous entry (no shared-ref bugs) ────────
assert(e1.body.status_charm === undefined, 'merging does not mutate the earlier entry body')
assert(!ShopSync.canAcknowledgeEntry(e2, e1), 'an older in-flight ACK cannot delete a newer coalesced entry')
assert(ShopSync.canAcknowledgeEntry(e2, e2), 'the exact current entry can be deleted after ACK')

// ── Cost entry ────────────────────────────────────────────────────────────────
const c1 = ShopSync.makeCostEntry({ kind: 'product', title: 'Widget', part: 'grip', cost: 12.5 }, 1000)
assert(c1.url === '/api/shop/cost' && c1.body.cost === 12.5 && c1.body.part === 'grip', 'cost entry targets /api/shop/cost with its price')
const c2 = ShopSync.makeCostEntry({ kind: 'charm', code: 'CH-9', cost: 3 }, 1000)
assert(c2.id === ShopSync.costOpId({ kind: 'charm', code: 'CH-9' }), 'charm cost entry id matches its charm')

console.log('')
if (failures > 0) {
	console.error(`${failures} assertion(s) FAILED`)
	process.exit(1)
}
console.log('All assertions passed.')
