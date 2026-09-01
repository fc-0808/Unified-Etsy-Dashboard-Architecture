'use strict'

/**
 * Regression tests for Activity log product context.
 *
 * Covers the hybrid contract:
 *   - future Shopping Mode events keep their immutable event-time snapshot;
 *   - historical events resolve by canonical (receipt_id, item_key);
 *   - snapshot fields are never overwritten by current order data;
 *   - image references cross a strict protocol/host/path allowlist.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const activityContext = require('../src/orders/activity-product-context')
const { safeStoredImageMime, sendStoredImage } = require('../src/route/stored-image-security')

const {
	ACTIVITY_CONTEXT_VERSION,
	MAX_ORDER_PRODUCTS,
	MAX_ORDER_SNAPSHOT_BYTES,
	MAX_PRODUCT_TITLE_LENGTH,
	MAX_VARIATION_TEXT_LENGTH,
	safeProductImageUrl,
	contextFromRouteRow,
	buildOrderProductSnapshot,
	parseOrderProductSnapshot,
	serializeOrderProductSnapshot,
	findRouteRow,
	enrichAuditEntries,
} = activityContext

// ── Image boundary ─────────────────────────────────────────────────────────────
assert.equal(
	safeProductImageUrl('/api/route/listing-image/777?w=300#ignored'),
	'/api/route/listing-image/777?w=300',
	'same-origin listing images are accepted and fragments are removed',
)
assert.equal(
	safeProductImageUrl('/api/route/variation-image/777?k=Case%201&v=2'),
	'/api/route/variation-image/777?k=Case%201&v=2',
	'same-origin style variation images are accepted',
)
assert.match(
	safeProductImageUrl('https://i.etsystatic.com/123/r/il/example.jpg'),
	/^https:\/\/i\.etsystatic\.com\//,
	'Etsy CDN images are accepted for legacy rows without a proxy id',
)
for (const unsafe of [
	'javascript:alert(1)',
	'data:image/png;base64,AAAA',
	'//evil.example/api/route/listing-image/1',
	'/api/users',
	'https://i.etsystatic.com.evil.example/image.jpg',
]) {
	assert.equal(safeProductImageUrl(unsafe), null, `unsafe image reference is rejected: ${unsafe}`)
}

// Operator-uploaded endpoints are same-origin, so a direct navigation must never
// turn SVG/HTML bytes into an authenticated active document.
assert.equal(safeStoredImageMime('image/png'), 'image/png', 'passive raster MIME is accepted')
assert.equal(safeStoredImageMime('image/jpg; charset=binary'), 'image/jpeg', 'JPEG aliases are normalised')
assert.equal(safeStoredImageMime('image/svg+xml'), null, 'active SVG documents are rejected')
assert.equal(safeStoredImageMime('text/html'), null, 'HTML disguised as an image is rejected')

function fakeResponse() {
	return {
		headers: {},
		statusCode: 200,
		ended: false,
		body: null,
		setHeader(name, value) { this.headers[name] = value },
		status(code) { this.statusCode = code; return this },
		end() { this.ended = true; return this },
		send(body) { this.body = body; return this },
	}
}
const rejectedImage = fakeResponse()
assert.equal(sendStoredImage(rejectedImage, { mime: 'image/svg+xml', data: Buffer.from('<svg/>') }), false, 'active uploaded content is not served')
assert.equal(rejectedImage.statusCode, 415, 'active uploaded content receives HTTP 415')
const rasterImage = fakeResponse()
assert.equal(sendStoredImage(rasterImage, { mime: 'image/png', data: Buffer.from('PNG') }), true, 'passive raster bytes are served')
assert.equal(rasterImage.headers['X-Content-Type-Options'], 'nosniff', 'stored image responses disable MIME sniffing')
assert.match(rasterImage.headers['Content-Security-Policy'], /sandbox/, 'stored image responses are inert under direct navigation')

// ── Shopping-facing row projection ─────────────────────────────────────────────
const corrected = contextFromRouteRow(
	{
		receipt_id: 42,
		item_key: 'canonical-line',
		title: 'Corrected model case',
		phone_model: 'iPhone 15 Pro',
		style: 'Case 2 + Grip 1',
		quantity: 1,
		listing_id: 111,
		product_listing_id: 222,
		image_url: 'ignored-by-injected-image-builder',
		has_case: true,
		has_grip: true,
		has_charm: false,
		status_case: 'Pending',
		status_grip: 'Pending',
		needs_exchange: true,
		exchange_have_model: '',
		exchange_need_model: 'iPhone 17 Pro',
	},
	(row) => `/api/route/listing-image/${row.product_listing_id}?w=300`,
)
assert.equal(corrected.phone_model, 'iPhone 17 Pro', 'activity context names the corrected model the shopper was sent to buy')
assert.equal(corrected.ordered_phone_model, 'iPhone 15 Pro', 'activity context preserves the originally ordered model')
assert.equal(corrected.style, 'Case 2 + Grip 1', 'activity context carries the ordered style')
assert.equal(corrected.product_image_url, '/api/route/listing-image/222?w=300', 'activity context uses the product actually being purchased')

// ── Historical enrichment + snapshot precedence ────────────────────────────────
const routeRows = [
	{
		receipt_id: 42,
		item_key: 'canonical-line',
		title: 'Current title must not replace the audit title',
		phone_model: 'iPhone 17 Pro',
		style: 'Case 2 + Grip 1',
		quantity: 2,
		listing_id: 111,
		product_listing_id: 222,
		image_url: 'unused',
		has_case: true,
		has_grip: true,
		has_charm: true,
		status_case: 'Purchased',
		status_grip: 'Purchased',
		status_charm: 'Purchased',
		needs_exchange: false,
	},
	{
		receipt_id: 42,
		item_key: 'second-line',
		title: 'Second product in the packaged order',
		phone_model: 'iPhone 16',
		style: 'Case Only',
		quantity: 1,
		listing_id: 333,
		product_listing_id: 333,
		image_url: 'unused',
		has_case: true,
		has_grip: false,
		has_charm: false,
		status_case: 'Purchased',
		status_grip: 'Pending',
		status_charm: 'Pending',
		needs_exchange: false,
	},
]

const entries = [
	{
		id: 1,
		path: '/api/shop/assign',
		status: 200,
		details: {
			receipt_id: '42',
			item_key: 'stale-line-alias',
			title: 'Title captured when the employee tapped Purchased',
			status_charm: 'Purchased',
		},
	},
	{
		id: 2,
		path: '/api/shop/assign',
		status: 200,
		details: {
			receipt_id: '42',
			item_key: 'canonical-line',
			title: 'Event-time title',
			style: 'Event-time style',
			product_image_url: '/api/route/style-image/9?v=1',
			activity_context_version: String(ACTIVITY_CONTEXT_VERSION),
		},
	},
	{
		id: 3,
		path: '/api/users',
		status: 201,
		details: { receipt_id: '42', item_key: 'canonical-line' },
	},
	{
		id: 4,
		path: '/api/shop/assign',
		status: 200,
		details: {
			receipt_id: '42',
			item_key: 'canonical-line',
			activity_context_version: String(ACTIVITY_CONTEXT_VERSION),
			product_image_url: 'javascript:alert(1)',
		},
	},
	{
		id: 5,
		path: '/api/orders/42/mark-packaged',
		status: 200,
		details: { receipt_id: '42' },
	},
	{
		id: 6,
		path: '/api/orders/42/mark-packaged',
		status: 200,
		details: { receipt_id: '42' },
		product_context: JSON.stringify({
			version: 1,
			product_count: 1,
			products: [{
				title: 'Product captured when the parcel was sealed',
				phone_model: 'Event-time Model',
				style: 'Event-time Style',
				quantity: 1,
				product_listing_id: 900,
				product_image_url: '/api/route/listing-image/900?w=300',
			}],
		}),
	},
]

let buildCalls = 0
const enriched = enrichAuditEntries({
	db: {},
	config: {},
	entries,
	buildRouteRows: (_db, _config, filters) => {
		buildCalls++
		assert.deepEqual(filters.receipt_ids, [42], 'historical enrichment de-duplicates receipt ids')
		assert.equal(filters.enrich_supplier, false, 'activity enrichment does not load unrelated supplier data')
		return routeRows
	},
	makeImageUrl: (row) => `/api/route/listing-image/${row.product_listing_id}?w=300`,
	makeLineResolver: () => ({
		canonical: (_receiptId, itemKey) => itemKey === 'stale-line-alias' ? 'canonical-line' : itemKey,
	}),
})

assert.equal(buildCalls, 1, 'historical product context is built in one batch')
assert.equal(enriched[0].details.title, entries[0].details.title, 'the immutable audit title wins over current order data')
assert.equal(enriched[0].details.phone_model, 'iPhone 17 Pro', 'a historical entry gains its model')
assert.equal(enriched[0].details.style, 'Case 2 + Grip 1', 'a historical entry gains its style')
assert.equal(enriched[0].details.quantity, 2, 'a historical entry gains its line quantity')
assert.equal(enriched[0].details.product_image_url, '/api/route/listing-image/222?w=300', 'a historical entry gains the exact product image')
assert.equal(enriched[1].details.style, 'Event-time style', 'a versioned event-time style is never replaced by live data')
assert.equal(enriched[1].details.product_image_url, '/api/route/style-image/9?v=1', 'a versioned event-time image is never replaced by live data')
assert.equal(enriched[2].details.style, undefined, 'unrelated activity is never product-enriched')
assert.equal(enriched[3].details.product_image_url, undefined, 'an unsafe persisted image is removed from the API response')
assert.equal(enriched[4].details.product_count, 2, 'a packaged-order activity reports every product sealed in the parcel')
assert.equal(enriched[4].details.products.length, 2, 'a packaged-order activity carries compact per-line contexts')
assert.deepEqual(
	enriched[4].details.products.map((product) => product.style),
	['Case 2 + Grip 1', 'Case Only'],
	'a packaged-order activity preserves each line’s own style variation',
)
assert.deepEqual(
	enriched[4].details.products.map((product) => product.product_image_url),
	['/api/route/listing-image/222?w=300', '/api/route/listing-image/333?w=300'],
	'a packaged-order activity preserves each line’s own product image',
)
assert.equal(enriched[5].details.products[0].style, 'Event-time Style', 'a persisted packaging snapshot wins over current order data')
assert.equal(enriched[5].details.products[0].product_listing_id, 900, 'a persisted packaging snapshot keeps the product sealed at event time')
assert.equal(enriched[5].product_context, undefined, 'raw snapshot JSON is not exposed in the Activity API')
assert.equal(MAX_ORDER_PRODUCTS, 8, 'packaged-order enrichment has a bounded response size')
const cappedOrder = enrichAuditEntries({
	db: {},
	config: {},
	entries: [{ id: 50, path: '/api/orders/50/mark-packaged', status: 200, details: { receipt_id: '50' } }],
	buildRouteRows: () => Array.from({ length: 10 }, (_, index) => ({
		receipt_id: 50,
		item_key: `line-${index}`,
		title: `Product ${index + 1}`,
		phone_model: `Model ${index + 1}`,
		style: `Style ${index + 1}`,
		quantity: 1,
		product_listing_id: 500 + index,
		image_url: 'unused',
		needs_exchange: false,
	})),
	makeImageUrl: (row) => `/api/route/listing-image/${row.product_listing_id}?w=300`,
	makeLineResolver: () => {
		throw new Error('order-level enrichment must not initialise the line resolver')
	},
})
assert.equal(cappedOrder[0].details.product_count, 10, 'packaged activity preserves the full product count')
assert.equal(cappedOrder[0].details.products.length, MAX_ORDER_PRODUCTS, 'packaged activity caps embedded product cards')

const capturedOrder = buildOrderProductSnapshot(
	{},
	{},
	70,
	{
		buildRouteRows: () => Array.from({ length: 10 }, (_, index) => ({
			receipt_id: 70,
			title: `Captured product ${index + 1}`,
			phone_model: `Captured model ${index + 1}`,
			style: `Captured style ${index + 1}`,
			quantity: 1,
			product_listing_id: 700 + index,
			image_url: 'unused',
			needs_exchange: false,
		})),
		makeImageUrl: (row) => `/api/route/listing-image/${row.product_listing_id}?w=300`,
	},
)
assert.equal(capturedOrder.product_count, 10, 'event-time packaging snapshots preserve full cardinality')
assert.equal(capturedOrder.products.length, MAX_ORDER_PRODUCTS, 'event-time packaging snapshots bound stored product detail')
const snapshotJson = serializeOrderProductSnapshot(capturedOrder)
assert.ok(snapshotJson && snapshotJson.length < 10000, 'event-time packaging snapshots serialize to a compact bounded payload')
assert.deepEqual(parseOrderProductSnapshot(snapshotJson), capturedOrder, 'event-time packaging snapshots validate and round-trip')

const oversizedOrder = buildOrderProductSnapshot(
	{},
	{},
	71,
	{
		buildRouteRows: () => [{
			receipt_id: 71,
			title: '"'.repeat(2 * 1024 * 1024),
			phone_model: 'M'.repeat(10000),
			style: 'S'.repeat(10000),
			quantity: 1,
			product_listing_id: 710,
			image_url: 'unused',
			needs_exchange: false,
		}],
		makeImageUrl: () => '/api/route/listing-image/710?w=300',
	},
)
assert.ok(oversizedOrder.products[0].title.length <= MAX_PRODUCT_TITLE_LENGTH, 'snapshot product titles have a hard length bound')
assert.ok(oversizedOrder.products[0].phone_model.length <= MAX_VARIATION_TEXT_LENGTH, 'snapshot model/style text has a hard length bound')
const oversizedJson = serializeOrderProductSnapshot(oversizedOrder)
assert.ok(oversizedJson && Buffer.byteLength(oversizedJson, 'utf8') <= MAX_ORDER_SNAPSHOT_BYTES, 'the complete persisted snapshot has a hard byte-size budget')

// ── Conservative legacy fallback ───────────────────────────────────────────────
const longTitle = 'Kawaii Hamster Popsicle Case with 3D Grip and Beaded Charm '.repeat(4).trim()
const unique = findRouteRow(
	{ receipt_id: 9, item_key: 'missing…', title: longTitle.slice(0, 80) + '…' },
	[
		{ receipt_id: 9, item_key: 'actual-a', title: longTitle },
		{ receipt_id: 9, item_key: 'actual-b', title: 'A completely different product' },
	],
	{ canonical: (_id, key) => key },
)
assert.equal(unique.item_key, 'actual-a', 'a truncated legacy title resolves only when its prefix is unique')

const ambiguous = findRouteRow(
	{ receipt_id: 9, item_key: 'missing…', title: 'Same product prefix…' },
	[
		{ receipt_id: 9, item_key: 'actual-a', title: 'Same product prefix red' },
		{ receipt_id: 9, item_key: 'actual-b', title: 'Same product prefix blue' },
	],
	{ canonical: (_id, key) => key },
)
assert.equal(ambiguous, null, 'legacy fallback refuses to guess between two matching order lines')

const duplicateKey = findRouteRow(
	{ receipt_id: 10, item_key: 'shared-key', title: 'Shared listing title' },
	[
		{ receipt_id: 10, item_key: 'shared-key', title: 'Shared listing title', style: 'Red' },
		{ receipt_id: 10, item_key: 'shared-key', title: 'Shared listing title', style: 'Blue' },
	],
	{ canonical: (_id, key) => key },
)
assert.equal(duplicateKey, null, 'an ambiguous exact key never silently borrows the first line’s style/image')

// ── Server wiring ───────────────────────────────────────────────────────────────
const server = fs.readFileSync(path.resolve(__dirname, '../src/server/index.js'), 'utf8')
assert.match(server, /activityProductContext\.safeProductImageUrl\(val\)/, 'audit writes validate the event-time image reference')
assert.match(server, /activityProductContext\.enrichAuditEntries\(\{/, 'audit reads invoke historical product enrichment')
assert.match(server, /product_context TEXT/, 'audit storage has a dedicated order-product snapshot column')
assert.match(server, /serializeOrderProductSnapshot\(res\.locals\.auditOrderProductSnapshot\)/, 'audit writes serialize the trusted server-side order snapshot')
assert.equal((server.match(/^\s*_captureAuditOrderProductSnapshot\(res, receiptId\)$/gm) || []).length, 2, 'mark and unmark packaged both capture event-time products')
const snapshotSource = server.slice(server.indexOf('function _auditSnapshot'), server.indexOf('const _auditInsert'))
assert.ok(
	snapshotSource.indexOf('collect(req.query)') < snapshotSource.indexOf('collect(req.body)')
		&& snapshotSource.indexOf('collect(req.body)') < snapshotSource.indexOf('collect(req.params)'),
	'audit identity precedence is query < applied body < authoritative URL params',
)
assert.match(server, /const itemKey = lineIdentity\.canonicalLineKey\(db, receiptId, b\.item_key\)/, 'offline shopper writes canonicalise stale line aliases before mutation')
assert.match(server, /Math\.min\(Math\.max\(requestedLimit, 1\), 2000\)/, 'audit limit is clamped on both bounds')
assert.match(server, /delete out\.product_image_url[\s\S]*const compact = \{\}/, 'an oversized image reference cannot erase the audit line identity')
assert.doesNotMatch(server, /delete out\.activity_context_version/, 'dropping an oversized image never downgrades event metadata into live enrichment')
assert.equal((server.match(/return sendStoredImage\(res, img\)/g) || []).length, 3, 'all uploaded product-image endpoints use the passive-image response boundary')

console.log('test-activity-product-context: all assertions passed')
