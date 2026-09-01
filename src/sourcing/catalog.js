'use strict'

/**
 * catalog.js — pure helpers for the Sourcing Catalog.
 *
 * WHY A SEPARATE MODULE
 * ----------------------------------------------------------------------------
 * The Sourcing page grew a second job. Alongside the design-supplier zip
 * library (see library.js) it now presents the WHOLE product catalog: what we
 * sell, which physical supplier sells it, where that supplier is, and what each
 * component costs. That catalog is not new data — it is `product_map` +
 * `supplier_directory` + the charm tables, which the Route tab and the Python
 * route generator already treat as authoritative. The Sourcing page is a second
 * VIEW of it, never a second copy.
 *
 * The three decisions that view has to make are pure functions, so they live
 * here rather than in the request handler or the page:
 *
 *   1. WHAT KIND OF PRODUCT IS THIS ROW? `product_map` stores a listing title,
 *      not a product type. The type is derivable from the title (an AirPods
 *      case is never titled "iPhone"), so it is DERIVED by default and only
 *      persisted when the operator explicitly corrects it. That keeps 700+
 *      historical rows working with no backfill and no import to re-run.
 *   2. WHAT IS MISSING? A sourcing catalog is only useful if it can tell you
 *      which rows are not ready to buy from — no supplier, no stall, no price.
 *      (Products without a photo are excluded from the catalog entirely by
 *      catalog-view.js, so "no image" is not a gap an operator filters on.)
 *      `catalogGaps` names those, so the UI, the CSV export and the
 *      tests all agree on the definition of "needs attention".
 *   3. WHAT IS A PRICE? One normaliser, so a price typed into the Sourcing page
 *      is stored byte-identically to one typed into the Route tab.
 *
 * Nothing here touches the database, the network or the filesystem — it is
 * 100% deterministic and unit-testable (mirrors library.js, pack-queue.js).
 */

const { deviceFamilyOf, FAMILY_AIRPODS, FAMILY_WATCH, FAMILY_IPAD } = require('../listings/product-types')

/**
 * The kinds of product the catalog holds, in display order. `id` is the stable
 * value stored in `product_map.product_type` and used in URLs and filters;
 * `label` / `label_zh` are for the UI.
 *
 * `component` says which purchase price the row is judged on: a grip-only
 * product is "priced" when it has a grip cost, not a case cost. `family` ties a
 * type back to the device families fulfilment already knows about
 * (src/listings/product-types.js), so a classification here can never imply a
 * device generation that the model-fix flow would refuse.
 *
 * Adding a type here is the ONLY change needed to extend the taxonomy.
 */
const PRODUCT_TYPES = [
	{ id: 'iphone_case', label: 'iPhone Case', label_zh: '手机壳', family: 'iphone', component: 'case' },
	{ id: 'airpods_case', label: 'AirPods Case', label_zh: '耳机壳', family: 'airpods', component: 'case' },
	// A band is its line's one physical unit, so it is judged on the same
	// primary-unit ('case') cost every other single-item product is.
	{ id: 'apple_watch_band', label: 'Apple Watch Band', label_zh: '手表带', family: 'watch', component: 'case' },
	{ id: 'ipad_case', label: 'iPad Case', label_zh: '平板壳', family: 'ipad', component: 'case' },
	{ id: 'grip', label: 'Phone Grip', label_zh: '手机支架', family: 'iphone', component: 'grip' },
	{ id: 'charm', label: 'Charm', label_zh: '挂件', family: '', component: 'charm' },
	{ id: 'other', label: 'Other', label_zh: '其他', family: '', component: '' },
]

const PRODUCT_TYPE_IDS = PRODUCT_TYPES.map((t) => t.id)
const PRODUCT_TYPE_BY_ID = new Map(PRODUCT_TYPES.map((t) => [t.id, t]))

/**
 * The data-quality gaps a catalog row can have, in the order an operator would
 * fix them (you cannot price a product before you know who sells it).
 */
const GAP_TYPES = [
	{ id: 'no_supplier', label: 'No supplier', label_zh: '缺供应商' },
	{ id: 'no_stall', label: 'No stall', label_zh: '缺摊位' },
	{ id: 'unlisted_supplier', label: 'Supplier not in directory', label_zh: '供应商未登记' },
	{ id: 'no_price', label: 'No price', label_zh: '缺价格' },
]

const GAP_TYPE_IDS = GAP_TYPES.map((g) => g.id)

// A listing title names the product it sells. These are tested in a fixed
// precedence (see deriveProductType) because a real title mentions several
// components at once — "…MagSafe Case, Daisy Rabbit Grip & Pearl Bow Charm…" is
// a CASE listing that happens to bundle a grip and a charm.
const CASE_RE = /\b(?:case|cover|casing|shell)\b/i
const GRIP_RE = /\b(?:grip|griptok|grippy|kickstand|phone\s*ring|stand)\b/i
const CHARM_RE = /\b(?:charm|keychain|key\s*ring|keyring|pendant|dangle|strap|beaded)\b/i

/** True when `id` is one of the known product types. */
function isValidProductType(id) {
	return PRODUCT_TYPE_IDS.includes(String(id || ''))
}

/** True when `id` is one of the known gap types. */
function isValidGapType(id) {
	return GAP_TYPE_IDS.includes(String(id || ''))
}

/** The descriptor for a type id, or the 'other' descriptor as a safe default. */
function productType(id) {
	return PRODUCT_TYPE_BY_ID.get(String(id || '')) || PRODUCT_TYPE_BY_ID.get('other')
}

/** Look up a type's display label in `lang` ('en' | 'zh'). */
function productTypeLabel(id, lang) {
	const t = productType(id)
	return lang === 'zh' ? t.label_zh : t.label
}

/**
 * Classify a product from its listing title alone.
 *
 * PRECEDENCE MATTERS. Every real title mentions more than one component, so the
 * order below encodes "what is the buyer actually buying":
 *
 *   1. AirPods, Apple Watch and iPad first, delegated to the SAME device-family
 *      test fulfilment uses (deviceFamilyOf), because those listings are also
 *      titled "…Case" / "…Charm …Strap" and would otherwise be filed as a phone
 *      case or a charm. Sharing that helper is what guarantees the catalog and
 *      the model-fix guard can never disagree about which family a product is in.
 *   2. A case/cover word → a phone case (the common path, ~all of the catalog).
 *   3. Otherwise a grip word → a grip-only product.
 *   4. Otherwise a charm word → a charm-only product.
 *   5. Otherwise 'other', which the UI surfaces so the operator can correct it.
 *
 * Deliberately conservative: this only ever reads the title, so it is stable,
 * explainable and free. The long tail is handled by an explicit override rather
 * than by making the heuristic cleverer.
 *
 * @param {string} title
 * @returns {string} a PRODUCT_TYPES id
 */
function deriveProductType(title) {
	const t = String(title == null ? '' : title).trim()
	if (!t) return 'other'
	const family = deviceFamilyOf('', t)
	if (family === FAMILY_AIRPODS) return 'airpods_case'
	if (family === FAMILY_WATCH) return 'apple_watch_band'
	if (family === FAMILY_IPAD) return 'ipad_case'
	if (CASE_RE.test(t)) return 'iphone_case'
	if (GRIP_RE.test(t)) return 'grip'
	if (CHARM_RE.test(t)) return 'charm'
	return 'other'
}

/**
 * The type of a catalog row: the operator's stored override when there is one,
 * otherwise the derivation. `source` is reported so the UI can show that a
 * classification is a guess ("auto") and worth confirming.
 *
 * An unrecognised stored value (a type retired from the taxonomy) falls back to
 * the derivation instead of rendering a dead badge.
 *
 * @param {{ title?: string, product_type?: string|null }} row
 * @returns {{ id: string, source: 'override'|'derived' }}
 */
function resolveProductType(row) {
	const stored = String((row && row.product_type) || '').trim()
	if (isValidProductType(stored)) return { id: stored, source: 'override' }
	return { id: deriveProductType(row && row.title), source: 'derived' }
}

/**
 * Normalise a price input → a non-negative number rounded to 2dp, or null to
 * mean "not priced yet". Mirrors the normaliser behind setProductCost so a
 * price is stored identically whichever page it was typed into.
 *
 * @param {*} value
 * @returns {number|null}
 */
function normalizePrice(value) {
	if (value === null || value === undefined || value === '') return null
	const n = Number(value)
	if (!Number.isFinite(n) || n < 0) return null
	return Math.round(n * 100) / 100
}

/**
 * Which cost column decides whether a row of this type is priced. Cases are
 * priced on the case cost, grips on the grip cost, and a charm's price lives on
 * the charm code in `charm_library` (not on the product row), so a charm row has
 * no price of its own to be missing.
 *
 * @param {string} typeId
 * @returns {string[]} product_map cost column names
 */
function priceFieldsFor(typeId) {
	const t = productType(typeId)
	if (t.component === 'grip') return ['cost_grip']
	if (t.component === 'charm') return []
	return ['cost_case']
}

/**
 * Everything about a catalog row that stops it being ready to buy from, as
 * GAP_TYPES ids. `no_stall` and `unlisted_supplier` are only reported once a
 * supplier is named — telling an operator that a blank supplier also has a blank
 * stall is noise, not a second problem.
 *
 * @param {object} row a built catalog row (post image/location resolution)
 * @returns {string[]}
 */
function catalogGaps(row) {
	const r = row || {}
	const out = []
	const shop = String(r.shop_name || '').trim()
	if (!shop) {
		out.push('no_supplier')
	} else {
		if (!String(r.stall_effective || r.stall || '').trim()) out.push('no_stall')
		if (r.supplier_in_directory === false) out.push('unlisted_supplier')
	}
	for (const field of priceFieldsFor(r.product_type)) {
		if (r[field] == null) {
			out.push('no_price')
			break
		}
	}
	// Image gaps are not reported: the catalog projection drops products without
	// a photo before they reach the UI, so a "no image" chip would always be empty.
	return out
}

/**
 * The human location line for a resolved stall, e.g. "Tongxin · F2 · A2-21".
 * Built from the `location` object produced by catalog-view.js (itself a
 * projection of route/stall-location.parseStall), so the CSV export, the page
 * and the tests all render a location the same way.
 *
 * @param {object} location
 * @param {'en'|'zh'} [lang]
 * @returns {string} '' when the stall is unrecorded
 */
function locationText(location, lang) {
	const loc = location || {}
	if (!loc.located) return ''
	const zh = lang === 'zh'
	const parts = []
	const building = loc.building_label ? (zh ? loc.building_label.zh : loc.building_label.en) : ''
	if (building) parts.push(building)
	if (loc.floor != null && loc.floor !== UNKNOWN_FLOOR_SENTINEL) parts.push(zh ? `${loc.floor}楼` : `F${loc.floor}`)
	if (loc.code) parts.push(loc.code)
	return parts.join(' · ')
}

// Kept local rather than imported so this module stays free of dependencies on
// the route layer; asserted equal to stall-location.UNKNOWN_FLOOR by the tests.
const UNKNOWN_FLOOR_SENTINEL = 999

module.exports = {
	PRODUCT_TYPES,
	PRODUCT_TYPE_IDS,
	GAP_TYPES,
	GAP_TYPE_IDS,
	UNKNOWN_FLOOR_SENTINEL,
	isValidProductType,
	isValidGapType,
	productType,
	productTypeLabel,
	deriveProductType,
	resolveProductType,
	normalizePrice,
	priceFieldsFor,
	catalogGaps,
	locationText,
}
