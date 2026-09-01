'use strict'

/**
 * catalog-view.js — the Sourcing Catalog read model.
 *
 * WHAT THIS IS
 * ----------------------------------------------------------------------------
 * One function, `buildCatalog(db)`, that answers the question the Sourcing page
 * asks: "everything we know about what we sell and who we buy it from". It joins
 * five tables that already exist and are already authoritative:
 *
 *   product_map           → the products (title, supplier, charm, unit costs)
 *   supplier_directory    → the physical stall suppliers (name + location)
 *   charm_shop_directory  → the charm stalls
 *   charm_library         → the charm codes, their default stall and their price
 *   listings / receipts   → the product photos, via the shared image resolver
 *
 * WHY A PROJECTION AND NOT A NEW TABLE
 * ----------------------------------------------------------------------------
 * The Route tab, the mobile Shopping Mode and the Python route generator all
 * read those same tables. Copying them into a "sourcing_products" table would
 * create a second truth that silently drifts the first time someone edits the
 * wrong page — and it would need a migration, an import and a reconciler to keep
 * honest. Instead the Sourcing page READS this projection and WRITES through the
 * existing CRUD endpoints (/api/route/product-map, /api/route/suppliers,
 * /api/route/charm-shops), so an edit made here is instantly visible everywhere,
 * and there is exactly one place a bug can live per entity.
 *
 * WHAT THIS ADDS ON TOP OF THE RAW ROWS
 * ----------------------------------------------------------------------------
 *   • product type      — derived from the title, override-aware (catalog.js)
 *   • physical location — the stall code parsed into building + floor + walking
 *                         order (route/stall-location.js), so the page can group
 *                         the catalog the way a buyer actually walks the market
 *   • inferred stall    — when a product names a supplier but no stall and that
 *                         supplier is in the directory exactly once, the
 *                         directory's stall is shown (and flagged as inferred).
 *                         Displayed, never written: the directory stays the one
 *                         place a supplier's location is edited.
 *   • data-quality gaps — what stops each row being ready to buy from
 *                         (supplier, stall, price). Products without a photo
 *                         are excluded from the projection entirely.
 *   • supplier identity — every product is stamped with the `supplier_key` of
 *                         the ONE directory row it is counted against, so the
 *                         Suppliers page can open a supplier and list exactly
 *                         the products its number claims, with no second join
 *                         for the client to get wrong
 *   • physical groups   — canonical aliases from multiple Etsy shops become
 *                         one supplier-drawer card, while every source row
 *                         remains in `products` for export and explicit CRUD
 *   • rollups           — per-supplier product counts, per-type totals, and the
 *                         facet counts the page's filter chips render from
 *
 * Read-only: nothing in this file writes to the database.
 */

const stallLocation = require('../route/stall-location')
const routeDashboard = require('../route/dashboard')
const productSimilarity = require('../route/product-similarity')
const catalog = require('./catalog')
const { getProductMap, getSupplierDirectory, getCharmShopDirectory, getCharmLibrary } = require('../db/setup')

/** Case-insensitive, whitespace-collapsed key for matching a shop name. */
function shopKey(name) {
	return String(name == null ? '' : name)
		.trim()
		.replace(/\s+/g, ' ')
		.toLowerCase()
}

/**
 * Stable identity for ONE supplier_directory row — the shop, plus the booth
 * that distinguishes it from the shop's other booths.
 *
 * The Suppliers page needs this because a supplier row is now something an
 * operator opens, not just a line to read: the count in the table and the
 * product list behind it must be the same set, and the only way to guarantee
 * that is to stamp the owning row's identity onto each product (see
 * `supplier_key` below) rather than have the client re-derive the join.
 *
 * Folded the same way stall-location.supplierIdentityKey folds — shop name and
 * stall code both case-insensitive — so "HAN"/"han" and "A2-29"/"a2-29"
 * address the same booth here exactly as they do in the Route picker.
 */
function supplierKey(shop, stall) {
	return stallLocation.supplierIdentityKey(shop, stall)
}

/**
 * Identity used ONLY to collapse cards in one supplier's visual catalog.
 *
 * A canonical key is the durable, precision-first answer produced by the
 * product-identity coordinator from perceptual images, deterministic catalog
 * links, and explicit operator merges. If it is absent we deliberately fall
 * back to the row id. A second, tightly guarded presentation-only title tier
 * may join those base groups below; this function itself never guesses.
 */
function supplierProductIdentity(row) {
	const canonical = String((row && row.canonical_product_key) || '').trim()
	return canonical ? `canonical:${canonical}` : `row:${String(row && row.id)}`
}

function _knownComponentCount(row) {
	return [row.cost_case, row.cost_grip, row.charm_cost].filter((v) => v != null).length
}

/**
 * Deterministically choose the one catalog row a collapsed product card shows.
 * Prefer the most actionable record, then the best image, then stable import/id
 * order. This does not merge fields or mutate any alias.
 */
function _compareSupplierProductRepresentative(a, b) {
	const gapDiff = (a.gaps || []).length - (b.gaps || []).length
	if (gapDiff) return gapDiff
	const componentDiff = _knownComponentCount(b) - _knownComponentCount(a)
	if (componentDiff) return componentDiff
	const exactImageDiff = Number(!!a.image_approx) - Number(!!b.image_approx)
	if (exactImageDiff) return exactImageDiff
	const overrideDiff = Number(b.product_type_source === 'override') - Number(a.product_type_source === 'override')
	if (overrideDiff) return overrideDiff
	const aOrder = Number.isFinite(Number(a.sort_order)) ? Number(a.sort_order) : Number.MAX_SAFE_INTEGER
	const bOrder = Number.isFinite(Number(b.sort_order)) ? Number(b.sort_order) : Number.MAX_SAFE_INTEGER
	return aOrder - bOrder || Number(a.id) - Number(b.id)
}

// Marketing/format words that may precede the actual product format marker.
// The remaining exact prefix is the seller's design name: "Kawaii Sleepy Star
// MagSafe Case..." and its cross-shop re-list both become "sleepy star".
const PRESENTATION_PREFIX_STOPWORDS = new Set([
	'cute',
	'kawaii',
	'y2k',
	'coquette',
	'aesthetic',
	'new',
	'original',
	'clear',
	'glitter',
	'protective',
	'protection',
])
const PRESENTATION_GROUP_MAX = 3
const PRESENTATION_TITLE_SIM_MIN = 0.5

function supplierPresentationSignature(row) {
	const prefix = String((row && row.title) || '').split(/\b(?:magsafe|case|cover|phone|iphone|airpods|ipad|watch)\b/i)[0]
	const tokens = (prefix.toLowerCase().match(/[a-z0-9]+/g) || []).filter((token) => !PRESENTATION_PREFIX_STOPWORDS.has(token))
	return tokens.length >= 2 ? tokens.join(' ') : ''
}

/**
 * Join canonical base groups only when a second, independent title signal is
 * exceptionally specific:
 *   • same supplier (the caller already partitions by supplier),
 *   • exact multi-token leading design name,
 *   • same product type,
 *   • >= 0.5 distinctive-token similarity for every pair, and
 *   • at most three base groups (broad names such as "Hello Kitty" are refused).
 *
 * This catches the real "Sleepy Star" case where two lifestyle photos have
 * unrelated global hashes, without weakening the purchase-route identity or
 * writing a speculative merge to the database.
 */
function _mergePresentationGroups(baseGroups) {
	const parent = baseGroups.map((_, index) => index)
	const find = (index) => {
		let root = index
		while (parent[root] !== root) root = parent[root]
		while (parent[index] !== index) {
			const next = parent[index]
			parent[index] = root
			index = next
		}
		return root
	}
	const union = (a, b) => {
		const ra = find(a)
		const rb = find(b)
		if (ra !== rb) parent[rb] = ra
	}

	const bySignature = new Map()
	baseGroups.forEach((group, index) => {
		const representative = group.rows.slice().sort(_compareSupplierProductRepresentative)[0]
		const signature = supplierPresentationSignature(representative)
		if (!signature) return
		if (!bySignature.has(signature)) bySignature.set(signature, [])
		bySignature.get(signature).push({ index, representative })
	})

	const acceptedSignatures = new Set()
	for (const [signature, entries] of bySignature) {
		if (entries.length < 2 || entries.length > PRESENTATION_GROUP_MAX) continue
		const type = entries[0].representative.product_type
		if (entries.some((entry) => entry.representative.product_type !== type)) continue
		let safe = true
		for (let i = 0; i < entries.length && safe; i++) {
			for (let j = i + 1; j < entries.length; j++) {
				if (productSimilarity.productTitleSimilarity(entries[i].representative.title, entries[j].representative.title) < PRESENTATION_TITLE_SIM_MIN) {
					safe = false
					break
				}
			}
		}
		if (!safe) continue
		acceptedSignatures.add(signature)
		for (let i = 1; i < entries.length; i++) union(entries[0].index, entries[i].index)
	}

	const merged = new Map()
	baseGroups.forEach((group, index) => {
		const root = find(index)
		if (!merged.has(root)) merged.set(root, { identities: [], rows: [], presentation_key: '' })
		const target = merged.get(root)
		target.identities.push(group.identity)
		target.rows.push(...group.rows)
		const signature = supplierPresentationSignature(group.rows.slice().sort(_compareSupplierProductRepresentative)[0])
		if (acceptedSignatures.has(signature)) target.presentation_key = signature
	})
	return [...merged.values()]
}

/**
 * Group photographed catalog rows into unique physical products PER supplier.
 *
 * The returned groups contain ids only, not copied product records. The full
 * `products` array remains untouched and continues to carry every Etsy listing
 * alias for export and CRUD. Consumers can therefore render one image/card while
 * still drilling into all source records explicitly.
 */
function groupSupplierProducts(products) {
	const bySupplier = new Map()
	for (const row of Array.isArray(products) ? products : []) {
		const supplier = String(row && row.supplier_key ? row.supplier_key : '')
		if (!supplier) continue
		if (!bySupplier.has(supplier)) bySupplier.set(supplier, new Map())
		const identity = supplierProductIdentity(row)
		const groups = bySupplier.get(supplier)
		if (!groups.has(identity)) groups.set(identity, [])
		groups.get(identity).push(row)
	}

	const out = []
	for (const [supplier, groups] of bySupplier) {
		const baseGroups = [...groups].map(([identity, rows]) => ({ identity, rows }))
		for (const merged of _mergePresentationGroups(baseGroups)) {
			const rows = merged.rows
			const aliases = rows.slice().sort((a, b) => Number(a.id) - Number(b.id))
			const representative = rows.slice().sort(_compareSupplierProductRepresentative)[0]
			const isPresentationGroup = merged.identities.length > 1
			out.push({
				key: isPresentationGroup ? `presentation:${merged.presentation_key}` : merged.identities[0],
				group_reason: isPresentationGroup ? 'presentation' : merged.identities[0].startsWith('canonical:') ? 'canonical' : 'row',
				presentation_key: isPresentationGroup ? merged.presentation_key : '',
				supplier_key: supplier,
				canonical_product_key: String(representative.canonical_product_key || ''),
				representative_id: representative.id,
				product_ids: aliases.map((p) => p.id),
				listing_count: aliases.length,
				priced: !(representative.gaps || []).includes('no_price'),
				ready: !(representative.gaps || []).length,
				cost_total: representative.cost_total == null ? null : representative.cost_total,
				product_type: representative.product_type,
			})
		}
	}
	return out.sort((a, b) => {
		if (a.supplier_key !== b.supplier_key) return a.supplier_key < b.supplier_key ? -1 : 1
		return Number(a.representative_id) - Number(b.representative_id)
	})
}

/**
 * Project a raw stall code into the location shape the UI and the CSV export
 * consume. A superset of route/stall-location.parseStall, renamed to snake_case
 * for the wire and carrying the precomputed walking-order sort key so the client
 * never has to re-implement the parser to sort a column.
 *
 * @param {*} stall raw catalog value (may be blank)
 * @param {*} [shop] shop name, used only as the sort tiebreak
 */
function resolveLocation(stall, shop) {
	const loc = stallLocation.parseStall(stall)
	return {
		located: loc.located,
		registered: loc.registered,
		is_home: loc.isHome,
		building_id: loc.buildingId,
		building_label: loc.buildingLabel,
		building_order: loc.buildingOrder,
		floor: loc.floor,
		code: loc.code,
		raw: loc.raw,
		sort_key: stallLocation.locationSortKey(stall, shop),
	}
}

/**
 * Build the whole Sourcing Catalog read model.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ imageResolver?: { resolve: (titleNorm: string, title: string) => ({url: string, approx: boolean}|null) } }} [opts]
 *   `imageResolver` is injectable so a caller that already built one for another
 *   response (or a test that wants determinism) does not pay for a second scan
 *   of the listings + order-history corpus.
 * @returns {object} the payload served by GET /api/sourcing/catalog
 */
function buildCatalog(db, opts = {}) {
	const resolver = opts.imageResolver || _safeImageResolver(db)

	const supplierRows = getSupplierDirectory(db)
	const charmShopRows = getCharmShopDirectory(db)
	const charmRows = getCharmLibrary(db)
	const productRows = getProductMap(db)

	// ── Supplier lookups ─────────────────────────────────────────────────────
	// `byShop` maps a shop name to every directory entry under that name. A shop
	// can legitimately hold more than one stall, which is exactly why a stall is
	// only inferred when there is precisely ONE candidate — guessing between two
	// stalls would send a buyer to the wrong one.
	const byShop = new Map()
	for (const s of supplierRows) {
		const k = shopKey(s.shop_name)
		if (!k) continue
		if (!byShop.has(k)) byShop.set(k, [])
		byShop.get(k).push(s)
	}
	const directoryPairs = new Set(supplierRows.map((s) => supplierKey(s.shop_name, s.stall)))

	// A unique id per directory row. (shop_name, stall) is the table's primary
	// key; after supplierIdentityKey folds letter case, two rows that only
	// differed by casing share a base key — the suffix keeps those rare twins
	// distinct instead of letting both claim (and both report) the same products.
	const seenId = new Map()
	const supplierIds = supplierRows.map((s) => {
		const base = supplierKey(s.shop_name, s.stall)
		const n = (seenId.get(base) || 0) + 1
		seenId.set(base, n)
		return n === 1 ? base : `${base}#${n}`
	})

	const charmStallByShop = new Map()
	for (const s of charmShopRows) {
		const k = shopKey(s.shop_name)
		if (k && !charmStallByShop.has(k)) charmStallByShop.set(k, String(s.stall || '').trim())
	}

	const charmByCode = new Map()
	for (const c of charmRows) charmByCode.set(String(c.code || '').trim().toUpperCase(), c)

	// ── Products ─────────────────────────────────────────────────────────────
	const supplierStats = new Map() // shopKey → rollup
	const totalsByType = Object.fromEntries(catalog.PRODUCT_TYPE_IDS.map((id) => [id, 0]))
	const totalsByGap = Object.fromEntries(catalog.GAP_TYPE_IDS.map((id) => [id, 0]))
	const charmUsage = new Map() // charm code → products using it

	const products = productRows.map((r) => {
		const type = catalog.resolveProductType(r)
		const shop = String(r.shop_name || '').trim()
		const stall = String(r.stall || '').trim()
		const key = shopKey(shop)
		const candidates = key ? byShop.get(key) || [] : []

		// Stall precedence: what the product row says, else the directory when it
		// leaves no doubt. `stall_source` tells the UI which it is looking at.
		let stallEffective = stall
		let stallSource = stall ? 'product' : ''
		if (!stallEffective && candidates.length === 1) {
			stallEffective = String(candidates[0].stall || '').trim()
			if (stallEffective) stallSource = 'directory'
		}

		// Which directory row this product is counted against — the booth it
		// names, or the shop's primary booth when it names none. Exactly one row
		// or none, never two: this single field is what makes the number in the
		// Suppliers table and the list an operator opens behind it the same set,
		// with no join for the client to get subtly wrong. A product whose shop
		// is absent from the directory belongs to no row (it is already reported
		// as an `unlisted_supplier` gap).
		let supplierRef = ''
		if (candidates.length) {
			const named = stall ? candidates.find((c) => String(c.stall || '').trim().toLowerCase() === stall.toLowerCase()) : null
			const owner = named || candidates[0]
			supplierRef = supplierKey(owner.shop_name, owner.stall)
		}

		const image = resolver.resolve(r.title_norm, r.title)
		// The Sourcing catalog is a visual buying aid: a row without a photo is
		// useless on the floor and clutters every filter. Drop it here — before
		// rollups — so the page, the CSV export and the supplier counts all agree
		// that imageless products do not exist in this view. They remain in
		// product_map for the Route tab; this is a projection filter, not a delete.
		if (!image || !image.url) return null
		// A new/re-imported product_map row can temporarily lack the canonical key
		// that its exact Etsy listing already owns. Use that exact-title image
		// source as a read-only identity fallback. Never trust a fuzzy thumbnail
		// match for grouping, and never write the fallback back to product_map.
		const canonicalProductKey = String(
			r.canonical_product_key || (!image.approx && image.canonical_product_key ? image.canonical_product_key : '') || '',
		).trim()

		const charmCode = String(r.charm_code || '').trim()
		const charmShop = String(r.charm_shop || '').trim()
		const charm = charmCode ? charmByCode.get(charmCode.toUpperCase()) : null
		// A charm's stall comes from the charm-shop directory, keyed on whichever
		// shop the row names, falling back to the charm code's default shop.
		const charmShopEffective = charmShop || (charm ? String(charm.default_charm_shop || '').trim() : '')

		const row = {
			id: r.id,
			title: r.title || '',
			title_norm: r.title_norm,
			product_type: type.id,
			product_type_source: type.source,
			shop_name: shop,
			stall,
			stall_effective: stallEffective,
			stall_source: stallSource,
			// `false` only when a shop IS named but no directory entry matches it —
			// a blank supplier is a different (already reported) problem.
			supplier_in_directory: shop ? candidates.length > 0 : null,
			supplier_stall_registered: shop && stall ? directoryPairs.has(supplierKey(shop, stall)) : null,
			supplier_stall_options: candidates.map((c) => String(c.stall || '').trim()).filter(Boolean),
			supplier_key: supplierRef,
			location: resolveLocation(stallEffective, shop),
			charm_shop: charmShopEffective,
			charm_shop_source: charmShop ? 'product' : charmShopEffective ? 'charm_library' : '',
			charm_code: charmCode,
			charm_stall: charmShopEffective ? charmStallByShop.get(shopKey(charmShopEffective)) || '' : '',
			charm_cost: charm && charm.cost != null ? charm.cost : null,
			charm_known: charmCode ? !!charm : null,
			cost_case: r.cost_case == null ? null : r.cost_case,
			cost_grip: r.cost_grip == null ? null : r.cost_grip,
			canonical_product_key: canonicalProductKey,
			alias_count: 1,
			image_url: image.url,
			image_approx: !!image.approx,
			sort_order: r.sort_order,
			updated_at: r.updated_at,
		}
		// What the buyer pays at the stall for one unit of this product, across
		// every component that has a price. Nulls are skipped rather than treated
		// as zero, so an unpriced grip cannot make a total look complete.
		const parts = [row.cost_case, row.cost_grip, row.charm_cost].filter((v) => v != null)
		row.cost_total = parts.length ? Math.round(parts.reduce((a, b) => a + b, 0) * 100) / 100 : null
		row.gaps = catalog.catalogGaps(row)

		totalsByType[row.product_type] = (totalsByType[row.product_type] || 0) + 1
		for (const g of row.gaps) totalsByGap[g] = (totalsByGap[g] || 0) + 1
		if (charmCode) charmUsage.set(charmCode.toUpperCase(), (charmUsage.get(charmCode.toUpperCase()) || 0) + 1)

		if (supplierRef) {
			if (!supplierStats.has(supplierRef)) {
				supplierStats.set(supplierRef, { product_count: 0, priced_count: 0, ready_count: 0, cost_total: 0, by_type: {} })
			}
			const stats = supplierStats.get(supplierRef)
			stats.product_count++
			if (!row.gaps.includes('no_price')) stats.priced_count++
			if (!row.gaps.length) stats.ready_count++
			if (row.cost_total != null) stats.cost_total += row.cost_total
			stats.by_type[row.product_type] = (stats.by_type[row.product_type] || 0) + 1
		}
		return row
	}).filter(Boolean)

	// Count aliases from the EFFECTIVE projection key (stored product-map key or
	// exact listing fallback), so Catalog badges and Supplier grouping agree.
	const aliasCount = new Map()
	for (const row of products) {
		if (row.canonical_product_key) aliasCount.set(row.canonical_product_key, (aliasCount.get(row.canonical_product_key) || 0) + 1)
	}
	for (const row of products) {
		row.alias_count = row.canonical_product_key ? aliasCount.get(row.canonical_product_key) || 1 : 1
	}

	// A second, read-only shape for the Suppliers drawer. `products` above still
	// has every listing alias; these groups only describe which ids share one
	// physical-product card. No write, delete, or field coalescing occurs here.
	const supplier_product_groups = groupSupplierProducts(products)
	const uniqueStats = new Map()
	for (const group of supplier_product_groups) {
		if (!uniqueStats.has(group.supplier_key)) {
			uniqueStats.set(group.supplier_key, { product_count: 0, priced_count: 0, ready_count: 0, cost_total: 0, has_cost: false, by_type: {} })
		}
		const stats = uniqueStats.get(group.supplier_key)
		stats.product_count++
		if (group.priced) stats.priced_count++
		if (group.ready) stats.ready_count++
		if (group.cost_total != null) {
			stats.cost_total += group.cost_total
			stats.has_cost = true
		}
		stats.by_type[group.product_type] = (stats.by_type[group.product_type] || 0) + 1
	}

	// ── Suppliers ────────────────────────────────────────────────────────────
	// Every rollup here is the count of products carrying this row's `key`, so a
	// supplier's number and the list an operator opens behind it cannot disagree
	// — and a shop with two booths reports each product against exactly one of
	// them rather than twice.
	const suppliers = supplierRows.map((s, i) => {
		const key = supplierIds[i]
		const stats = supplierStats.get(key) || { product_count: 0, priced_count: 0, ready_count: 0, cost_total: 0, by_type: {} }
		const unique = uniqueStats.get(key) || { product_count: 0, priced_count: 0, ready_count: 0, cost_total: 0, has_cost: false, by_type: {} }
		return {
			key,
			shop_key: shopKey(s.shop_name),
			shop_name: s.shop_name || '',
			stall: String(s.stall || '').trim(),
			mall: s.mall || '',
			floor: s.floor || '',
			address: s.address || '',
			notes: s.notes || '',
			sort_order: s.sort_order,
			updated_at: s.updated_at,
			location: resolveLocation(s.stall, s.shop_name),
			stall_count: (byShop.get(shopKey(s.shop_name)) || []).length,
			product_count: stats.product_count,
			priced_count: stats.priced_count,
			ready_count: stats.ready_count,
			cost_total: stats.product_count ? Math.round(stats.cost_total * 100) / 100 : null,
			by_type: stats.by_type,
			// `product_count` above intentionally remains the number of underlying
			// listing rows for compatibility and CRUD warnings. These are the
			// de-duplicated physical-product metrics shown in the Suppliers UI.
			unique_product_count: unique.product_count,
			unique_priced_count: unique.priced_count,
			unique_ready_count: unique.ready_count,
			unique_cost_total: unique.has_cost ? Math.round(unique.cost_total * 100) / 100 : null,
			unique_by_type: unique.by_type,
		}
	})

	const charm_shops = charmShopRows.map((s) => {
		const key = shopKey(s.shop_name)
		return {
			shop_name: s.shop_name || '',
			stall: String(s.stall || '').trim(),
			notes: s.notes || '',
			sort_order: s.sort_order,
			updated_at: s.updated_at,
			location: resolveLocation(s.stall, s.shop_name),
			charm_count: charmRows.filter((c) => shopKey(c.default_charm_shop) === key).length,
		}
	})

	// Charm codes are reference data for the product editor's picker (and for the
	// price shown on a product that bundles one). Charm CRUD — including the
	// photo — stays in the Route tab, which owns the image store; duplicating it
	// here would mean two upload paths for one file.
	const charms = charmRows.map((c) => {
		const shop = String(c.default_charm_shop || '').trim()
		return {
			code: c.code,
			charm_shop: shop,
			charm_stall: shop ? charmStallByShop.get(shopKey(shop)) || '' : '',
			cost: c.cost == null ? null : c.cost,
			notes: c.notes || '',
			product_count: charmUsage.get(String(c.code || '').trim().toUpperCase()) || 0,
		}
	})

	// ── Rollups ──────────────────────────────────────────────────────────────
	const buildings = new Set()
	for (const p of products) if (p.location.located) buildings.add(p.location.building_id)

	return {
		ok: true,
		generated_at: Math.floor(Date.now() / 1000),
		product_types: catalog.PRODUCT_TYPES,
		gap_types: catalog.GAP_TYPES,
		products,
		supplier_product_groups,
		suppliers,
		charm_shops,
		charms,
		totals: {
			products: products.length,
			suppliers: suppliers.length,
			charm_shops: charm_shops.length,
			charms: charms.length,
			buildings: buildings.size,
			by_type: totalsByType,
			by_gap: totalsByGap,
			with_supplier: products.filter((p) => p.shop_name).length,
			with_location: products.filter((p) => p.location.located).length,
			with_price: products.filter((p) => !p.gaps.includes('no_price')).length,
			// Always equal to products.length: imageless rows were dropped above.
			with_image: products.length,
			ready: products.filter((p) => p.gaps.length === 0).length,
		},
	}
}

/**
 * The shared catalog image resolver, degraded to "no images" rather than a 500
 * if the listing/receipt tables it scans are not present yet (a fresh database,
 * or a test that seeds only the catalog tables). A missing thumbnail must never
 * cost an operator the whole page.
 */
function _safeImageResolver(db) {
	try {
		return routeDashboard.buildCatalogImageResolver(db)
	} catch {
		return { resolve: () => null }
	}
}

module.exports = {
	buildCatalog,
	resolveLocation,
	shopKey,
	supplierKey,
	supplierProductIdentity,
	supplierPresentationSignature,
	groupSupplierProducts,
}
