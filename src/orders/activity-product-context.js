'use strict'

/**
 * Product context for line-level and order-level activity-log entries.
 *
 * New Shopping Mode writes carry a compact snapshot of the product metadata the
 * employee actually saw (model, style and a safe image reference). The reference
 * intentionally points at the application's existing image store; it is not a
 * second immutable copy of the image bytes. Historical audit rows predate that
 * metadata, so GET /api/audit resolves them from the canonical
 * `(receipt_id, item_key)` line identity in one batched pass.
 *
 * Snapshot values always win. This keeps model/style metadata historically
 * accurate after a design switch or model correction, while the read-time
 * fallback makes existing entries useful without a destructive data migration.
 * That fallback is explicitly current-order context, not a claim that old rows
 * can recover facts which were never recorded.
 */

const lineIdentity = require('./line-identity')
const routeDashboard = require('../route/dashboard')
const { shopRouteImageUrl } = require('../route/shop-images')

const ACTIVITY_CONTEXT_VERSION = 1
const ORDER_ACTIVITY_CONTEXT_VERSION = 1
const DEFAULT_BATCH_SIZE = 500
const MAX_IMAGE_REF_LENGTH = 1000
const MAX_ORDER_PRODUCTS = 8
const MAX_ORDER_SNAPSHOT_BYTES = 24 * 1024
const MAX_PRODUCT_TITLE_LENGTH = 240
const MAX_VARIATION_TEXT_LENGTH = 160

// Line-level routes resolve one exact `(receipt_id, item_key)`.
const LINE_PRODUCT_ACTIVITY_PATHS = [
	/^\/api\/shop\/assign$/,
	/^\/api\/route\/assign$/,
	/^\/api\/orders\/[^/]+\/items\/(?:component-status|purchase-state)$/,
]

// Packaging is an order-level action: every product sealed in that parcel belongs
// in its activity context. Bulk packaging remains a summary event because one log
// row may represent hundreds of orders.
const ORDER_PRODUCT_ACTIVITY_PATHS = [
	/^\/api\/orders\/[^/]+\/(?:mark-packaged|unmark-packaged)$/,
]

const LOCAL_IMAGE_PATH = /^\/api\/route\/(?:listing-image|variation-image|style-image|manual-image|substitution-image)(?:\/|$)/

function hasValue(value) {
	return value != null && value !== ''
}

function receiptIdOf(details) {
	if (!details || !hasValue(details.receipt_id)) return null
	const id = Number(details.receipt_id)
	return Number.isInteger(id) ? id : null
}

function isProductActivityEntry(entry) {
	const path = String(entry?.path || '')
	return LINE_PRODUCT_ACTIVITY_PATHS.some((pattern) => pattern.test(path))
		|| ORDER_PRODUCT_ACTIVITY_PATHS.some((pattern) => pattern.test(path))
}

function isLineProductActivityEntry(entry) {
	const path = String(entry?.path || '')
	return LINE_PRODUCT_ACTIVITY_PATHS.some((pattern) => pattern.test(path))
}

function isOrderProductActivityEntry(entry) {
	const path = String(entry?.path || '')
	return ORDER_PRODUCT_ACTIVITY_PATHS.some((pattern) => pattern.test(path))
}

function hasEventTimeSnapshot(details) {
	return Number(details?.activity_context_version) >= ACTIVITY_CONTEXT_VERSION
}

/**
 * Accept only image references the dashboard knows how to serve safely:
 * controlled same-origin route-image endpoints, or Etsy's exact image host for
 * the rare legacy/manual line that cannot be proxied by listing id.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function safeProductImageUrl(value) {
	if (typeof value !== 'string') return null
	const raw = value.trim()
	if (!raw || raw.length > MAX_IMAGE_REF_LENGTH) return null

	try {
		if (raw.startsWith('/')) {
			const base = new URL('https://activity.invalid')
			const parsed = new URL(raw, base)
			if (parsed.origin !== base.origin || !LOCAL_IMAGE_PATH.test(parsed.pathname)) return null
			parsed.hash = ''
			return parsed.pathname + parsed.search
		}

		const parsed = new URL(raw)
		if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'i.etsystatic.com') return null
		if (parsed.username || parsed.password) return null
		parsed.hash = ''
		return parsed.href
	} catch {
		return null
	}
}

function cleanText(value) {
	if (!hasValue(value)) return null
	return String(value).trim() || null
}

function boundedText(value, maxLength) {
	const text = cleanText(value)
	if (!text || text.length <= maxLength) return text
	return text.slice(0, Math.max(1, maxLength - 1)) + '…'
}

function positiveInteger(value) {
	const n = Number(value)
	return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * Convert a full route row into the small, presentation-safe activity context.
 * The shopping projection is important for an open BUY model correction: it
 * names the corrected model the employee was sent to purchase, not the rejected
 * model written on the original Etsy transaction.
 */
function contextFromRouteRow(row, makeImageUrl = shopRouteImageUrl) {
	if (!row || typeof row !== 'object') return null
	const displayed = routeDashboard.rowShoppingProjection(row) || row
	const image = safeProductImageUrl(makeImageUrl(displayed))
	const context = {}

	const title = boundedText(displayed.title, MAX_PRODUCT_TITLE_LENGTH)
	const model = boundedText(displayed.phone_model, MAX_VARIATION_TEXT_LENGTH)
	const orderedModel = boundedText(displayed.ordered_phone_model, MAX_VARIATION_TEXT_LENGTH)
	const style = boundedText(displayed.style, MAX_VARIATION_TEXT_LENGTH)
	const quantity = positiveInteger(displayed.quantity)
	const listingId = positiveInteger(displayed.listing_id)
	const productListingId = positiveInteger(displayed.product_listing_id)

	if (title) context.title = title
	if (model) context.phone_model = model
	if (orderedModel && orderedModel !== model) context.ordered_phone_model = orderedModel
	if (style) context.style = style
	if (quantity) context.quantity = quantity
	if (listingId) context.listing_id = listingId
	if (productListingId) context.product_listing_id = productListingId
	if (image) context.product_image_url = image

	return Object.keys(context).length ? context : null
}

/**
 * Capture the products sealed in one parcel at event time. The snapshot is
 * bounded for durable audit storage while product_count preserves the full
 * cardinality for a "+N more" disclosure.
 */
function buildOrderProductSnapshot(
	db,
	config,
	receiptId,
	{
		buildRouteRows = routeDashboard.buildRouteRows,
		makeImageUrl = shopRouteImageUrl,
	} = {},
) {
	const id = Number(receiptId)
	if (!Number.isInteger(id)) return null
	const rows = buildRouteRows(db, config, {
		receipt_ids: [id],
		enrich_supplier: false,
		include_dismissed: true,
		include_issues: true,
	})
	const products = (Array.isArray(rows) ? rows : [])
		.map((row) => contextFromRouteRow(row, makeImageUrl))
		.filter(Boolean)
	if (!products.length) return null
	return {
		version: ORDER_ACTIVITY_CONTEXT_VERSION,
		product_count: products.length,
		products: products.slice(0, MAX_ORDER_PRODUCTS),
	}
}

/**
 * Validate a persisted order snapshot before exposing it to the browser. This
 * also gives additive schema/version changes a safe degradation path.
 */
function parseOrderProductSnapshot(value) {
	let snapshot = value
	if (typeof snapshot === 'string') {
		try {
			snapshot = JSON.parse(snapshot)
		} catch {
			return null
		}
	}
	if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.products)) return null
	const products = snapshot.products
		.slice(0, MAX_ORDER_PRODUCTS)
		.map((product) => contextFromRouteRow(product, (row) => row.product_image_url))
		.filter(Boolean)
	if (!products.length) return null
	const declaredCount = positiveInteger(snapshot.product_count)
	return {
		version: positiveInteger(snapshot.version) || ORDER_ACTIVITY_CONTEXT_VERSION,
		product_count: Math.max(declaredCount || products.length, products.length),
		products,
	}
}

function serializeOrderProductSnapshot(value) {
	const snapshot = parseOrderProductSnapshot(value)
	if (!snapshot) return null
	// Defence in depth beyond the per-field and product-count bounds. If escaping
	// or a future additive field pushes the payload over budget, keep the earliest
	// product cards and the authoritative full count rather than writing an
	// unbounded audit row.
	const bounded = { ...snapshot, products: snapshot.products.map((product) => ({ ...product })) }
	let json = JSON.stringify(bounded)
	while (Buffer.byteLength(json, 'utf8') > MAX_ORDER_SNAPSHOT_BYTES && bounded.products.length > 1) {
		bounded.products.pop()
		json = JSON.stringify(bounded)
	}
	return Buffer.byteLength(json, 'utf8') <= MAX_ORDER_SNAPSHOT_BYTES ? json : null
}

function auditPrefix(value) {
	const text = cleanText(value)
	if (!text || !text.endsWith('…')) return null
	return text.slice(0, -1)
}

function uniqueMatch(rows, predicate) {
	const matches = rows.filter(predicate)
	return matches.length === 1 ? matches[0] : null
}

/**
 * Resolve one legacy snapshot to a route row. Exact/canonical line identity wins.
 * Prefix/title fallbacks are used only when they identify exactly one line; this
 * recovers old 140-character-truncated audit values without ever guessing among
 * two products in the same order.
 */
function findRouteRow(details, rows, resolver) {
	const receiptId = receiptIdOf(details)
	const itemKey = cleanText(details?.item_key)
	if (receiptId == null || !itemKey || !rows.length) return null

	const receiptRows = rows.filter((row) => Number(row.receipt_id) === receiptId)
	let hit = uniqueMatch(receiptRows, (row) => String(row.item_key) === itemKey)
	if (hit) return hit

	const canonical = resolver?.canonical ? resolver.canonical(receiptId, itemKey) : itemKey
	if (canonical !== itemKey) {
		hit = uniqueMatch(receiptRows, (row) => String(row.item_key) === canonical)
		if (hit) return hit
	}

	const keyPrefix = auditPrefix(itemKey)
	if (keyPrefix) {
		hit = uniqueMatch(receiptRows, (row) => String(row.item_key || '').startsWith(keyPrefix))
		if (hit) return hit
	}

	const title = cleanText(details?.title)
	if (!title) return null
	const normalizedTitle = routeDashboard.normalizeTitle(title)
	hit = uniqueMatch(receiptRows, (row) => routeDashboard.normalizeTitle(row.title || '') === normalizedTitle)
	if (hit) return hit

	const titlePrefix = auditPrefix(title)
	if (!titlePrefix) return null
	const normalizedPrefix = routeDashboard.normalizeTitle(titlePrefix)
	return uniqueMatch(receiptRows, (row) => routeDashboard.normalizeTitle(row.title || '').startsWith(normalizedPrefix))
}

function mergeMissingContext(details, context) {
	if (!context) return details
	const merged = { ...details }
	for (const [key, value] of Object.entries(context)) {
		if (!hasValue(merged[key]) && hasValue(value)) merged[key] = value
	}
	return merged
}

/**
 * Enrich legacy line-level and packaged-order audit entries in bounded batches.
 *
 * Dependencies are injectable so the identity/merge contract can be tested
 * without constructing the application's large SQLite schema.
 */
function enrichAuditEntries({
	db,
	config,
	entries,
	buildRouteRows = routeDashboard.buildRouteRows,
	makeImageUrl = shopRouteImageUrl,
	makeLineResolver = lineIdentity.lineKeyResolver,
	batchSize = DEFAULT_BATCH_SIZE,
	onError = null,
}) {
	const source = Array.isArray(entries) ? entries : []
	if (!source.length) return source

	const prepared = source.map((entry) => {
		if (!entry || typeof entry !== 'object') return entry
		let details = entry.details && typeof entry.details === 'object' && !Array.isArray(entry.details)
			? { ...entry.details }
			: entry.details
		if (details && hasValue(details.product_image_url)) {
			const safe = safeProductImageUrl(details.product_image_url)
			if (safe) details.product_image_url = safe
			else delete details.product_image_url
		}
		const orderSnapshot = isOrderProductActivityEntry(entry)
			? parseOrderProductSnapshot(entry.product_context)
			: null
		if (orderSnapshot) {
			details = {
				...(details && typeof details === 'object' ? details : {}),
				products: orderSnapshot.products,
				product_count: orderSnapshot.product_count,
			}
		}
		const publicEntry = { ...entry, details }
		delete publicEntry.product_context
		return publicEntry
	})

	const lineTargets = prepared.filter((entry) => {
		const details = entry?.details
		return isLineProductActivityEntry(entry)
			&& details
			&& receiptIdOf(details) != null
			&& hasValue(details.item_key)
			&& !hasEventTimeSnapshot(details)
	})
	const orderTargets = prepared.filter((entry) => {
		const details = entry?.details
		return isOrderProductActivityEntry(entry)
			&& details
			&& receiptIdOf(details) != null
			&& !Array.isArray(details.products)
	})
	const targets = [...lineTargets, ...orderTargets]
	if (!targets.length) return prepared

	const receiptIds = [...new Set(targets.map((entry) => receiptIdOf(entry.details)).filter((id) => id != null))]
	const size = Math.max(1, Math.min(Number(batchSize) || DEFAULT_BATCH_SIZE, DEFAULT_BATCH_SIZE))
	const rows = []
	for (let offset = 0; offset < receiptIds.length; offset += size) {
		const chunk = receiptIds.slice(offset, offset + size)
		try {
			const built = buildRouteRows(db, config, {
				receipt_ids: chunk,
				enrich_supplier: false,
				include_dismissed: true,
				include_issues: true,
			})
			if (Array.isArray(built)) rows.push(...built)
		} catch (error) {
			if (typeof onError === 'function') onError(error, chunk)
		}
	}
	if (!rows.length) return prepared

	let resolver = null
	if (lineTargets.length) {
		try {
			resolver = makeLineResolver(db, receiptIds)
		} catch (error) {
			if (typeof onError === 'function') onError(error, receiptIds)
		}
	}

	const lineTargetIds = new Set(lineTargets.map((entry) => entry.id))
	const orderTargetIds = new Set(orderTargets.map((entry) => entry.id))
	const rowsByReceipt = new Map()
	for (const row of rows) {
		const receiptId = Number(row?.receipt_id)
		if (!Number.isInteger(receiptId)) continue
		if (!rowsByReceipt.has(receiptId)) rowsByReceipt.set(receiptId, [])
		rowsByReceipt.get(receiptId).push(row)
	}

	return prepared.map((entry) => {
		if (!entry || !entry.details) return entry

		if (orderTargetIds.has(entry.id)) {
			const receiptRows = rowsByReceipt.get(receiptIdOf(entry.details)) || []
			const products = receiptRows
				.map((row) => contextFromRouteRow(row, makeImageUrl))
				.filter(Boolean)
			if (!products.length) return entry
			return {
				...entry,
				details: {
					...entry.details,
					products: products.slice(0, MAX_ORDER_PRODUCTS),
					product_count: products.length,
				},
			}
		}

		if (!lineTargetIds.has(entry.id) || hasEventTimeSnapshot(entry.details)) return entry
		const row = findRouteRow(entry.details, rows, resolver)
		if (!row) return entry
		const context = contextFromRouteRow(row, makeImageUrl)
		return context ? { ...entry, details: mergeMissingContext(entry.details, context) } : entry
	})
}

module.exports = {
	ACTIVITY_CONTEXT_VERSION,
	ORDER_ACTIVITY_CONTEXT_VERSION,
	MAX_ORDER_PRODUCTS,
	MAX_ORDER_SNAPSHOT_BYTES,
	MAX_PRODUCT_TITLE_LENGTH,
	MAX_VARIATION_TEXT_LENGTH,
	LINE_PRODUCT_ACTIVITY_PATHS,
	ORDER_PRODUCT_ACTIVITY_PATHS,
	isProductActivityEntry,
	isLineProductActivityEntry,
	isOrderProductActivityEntry,
	safeProductImageUrl,
	contextFromRouteRow,
	buildOrderProductSnapshot,
	parseOrderProductSnapshot,
	serializeOrderProductSnapshot,
	findRouteRow,
	mergeMissingContext,
	enrichAuditEntries,
}
