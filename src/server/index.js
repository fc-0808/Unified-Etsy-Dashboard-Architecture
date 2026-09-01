'use strict'

// Load .env (OpenAI key + bulk-listing tuning) before anything else reads
// process.env. Non-fatal if the file is absent — config.json still drives Etsy.
require('dotenv').config({ quiet: true })

const crypto = require('crypto')
const sharp = require('sharp')

/**
 * Local dashboard server.
 *
 * Serves a single-page dashboard that reads from etsy_dashboard.db.
 * All data is read from SQLite — no live Etsy API calls from the UI.
 * The sync worker keeps the DB current in the background.
 *
 * Routes:
 *   GET /              → dashboard HTML
 *   GET /api/summary   → shop stats summary
 *   GET /api/orders    → paginated orders across all shops (or filtered by shop/group)
 *   GET /api/shops     → list of all shops with last sync time + order counts
 *   GET /api/sync-log  → recent sync history
 */

const path = require('path')
const https = require('https')
const fs = require('fs')
const { spawn, execSync } = require('child_process')
const os = require('os')
const express = require('express')
const cors = require('cors')
const cron = require('node-cron')
const Database = require('better-sqlite3')
// RFC 6266 / RFC 5987 Content-Disposition builder (same library Express uses
// internally for res.download). Produces a valid ASCII `filename=` fallback PLUS
// a UTF-8 `filename*=` form, so non-ASCII buyer names (e.g. "Łukasz Gierszon")
// never throw ERR_INVALID_CHAR when written to the response header.
const contentDisposition = require('content-disposition')

const { loadConfig, getAllShops, usesGroupProxy, isAutoRestockEnabled, patchRuntimeSettings } = require('../config/schema')
const { resolveListenHost } = require('./network-policy')
const { analyzeSuspensionRisks, formatRiskReport, summarizeRisks, assertShipRateOk, warnPreTransitShip, chunk: chunkArray, sleep: complianceSleep, BULK_SHIP_CHUNK_SIZE, BULK_SHIP_INTER_REQUEST_MS, BULK_SHIP_INTER_BATCH_MS, BULK_SHIP_ABSOLUTE_MAX, INV_WATCH_STARTUP_DELAY_MS } = require('../compliance/suspension-guard')
const destinationTax = require('../compliance/destination-tax')
const { createRateStore, convert: convertCurrencyAmount } = require('../compliance/exchange-rates')
const { TokenManager } = require('../auth/token-manager')
const { initDb, syncConfigToDb } = require('../db/setup')
// Single source of truth for the Ready-to-pack ("To pack & ship") queue scope,
// shared with scripts/test-pack-queue-exchange.js so the two can never drift.
const packQueue = require('../orders/pack-queue')
const { unsealableReasons: getUnsealableReasons } = require('../orders/seal-guard')
// Single source of truth for the Need-to-purchase ("🛒 Need to purchase") queue
// scope AND for the charm shopping list derived from it, shared with
// scripts/test-charms-to-buy-scope.js so the order list, the "Charms to buy"
// list and the test can never disagree about what still has to be bought.
const buyQueue = require('../orders/buy-queue')
// Single source of truth for an order line's identity — the (receipt_id, item_key)
// every per-line fact is stored under. A Route-tab manual order names its lines
// with a per-variant key held in route_manual_items, so any surface that instead
// re-derives the key from receipts.all_transactions addresses a row nothing else
// writes (shopping marks the charm bought; the Orders tab shows it as still to
// buy). Every consumer resolves through this module so the two can never split.
// Contract + rationale: src/orders/line-identity.js; tests:
// scripts/test-manual-line-identity.js.
const lineIdentity = require('../orders/line-identity')
// Event-time product snapshots + batched historical enrichment for line-level
// Activity log entries (model, style and the exact product image).
const activityProductContext = require('../orders/activity-product-context')
// Pure per-employee shift-summary rollup, shared with scripts/test-shift-summary.js.
const { summarizeShift } = require('../orders/shift-summary')
// Shared, SQLite-only Monday-to-Sunday operations checklist. This module has no
// Etsy client/token dependency; every listed action remains a human attestation.
const operationsChecklist = require('../operations/checklist')
// Durable ledger of "this order still owes Etsy a completion". Creating a 4PX
// label is an irreversible, paid side effect; completing the order on Etsy is a
// second call that can fail or be interrupted. The ledger + the reconciler below
// guarantee the second half always happens, so a 4PX-shipped order can never be
// stranded in Needs-shipping. State machine + tests: src/orders/etsy-completion.js.
const etsyCompletion = require('../orders/etsy-completion')
// Single source of truth for Etsy double-fire / "ghost receipt" suppression,
// shared with scripts/test-dedup.js (synthetic unit tests) and
// scripts/verify-dedup-fix.js (live-DB regression check) so the three can never
// drift. The heavy reasoning lives in the module's header comment.
const { computeDuplicateSuppression, actionableOrderSql } = require('../orders/dedup')
// Single source of truth for "the buyer paid extra for faster shipping". It reads
// Etsy's per-transaction `shipping_upgrade` and decides the tier + the expedited
// boolean; the Express badge, the Express filter, the express-first sort and the
// 4PX lane recommendation all resolve through it, so those four can never
// disagree. Contract + rationale: src/orders/shipping-upgrade.js; tests:
// scripts/test-express-orders.js.
const shippingUpgrade = require('../orders/shipping-upgrade')
const { createGroupProxyClient } = require('../proxy/factory')
const { buildShopClient, resolveShopId, createReceiptShipment, paginateListings, updateListing, createDraftListing, deleteListing, getListingInventory, updateListingInventory, getShop, updateShop, isQpdExhaustedError, getBudgetSnapshots, getShopSections, createShopSection, updateShopSection, deleteShopSection } = require('../etsy/client')
const {
	upsertListing,
	pruneStaleListings,
	upsertListingInventory,
	pruneStaleInventory,
	logEvent,
	upsertFourpxShipment,
	recordFourpxFreight,
	recordFourpxShipmentInputs,
	getFourpxShippingSummary,
	FOURPX_PICKUP_BLOCKING_STATUSES,
	openFourpxPickupAppointment,
	resolveFourpxPickupAppointment,
	attachFourpxPickupParcels,
	setFourpxPickupFormUrl,
	cancelFourpxPickupAppointment,
	getFourpxPickupAppointment,
	findActiveFourpxPickupAppointment,
	pruneStaleFourpxPickupAppointments,
	listFourpxPickupAppointments,
	listParcelsAwaitingFourpxPickup,
	updateTrackingDetail,
	getShipments,
	getShippingStats,
	getShippingAlerts,
	reviewShippingAlerts,
	syncShippingAlertLedger,
	updateShippingClaim,
	getShippingBuyerNotice,
	recordShippingBuyerNotice,
	clearShippingBuyerNotice,
	MAX_SHIPPING_NOTICE_BODY_LENGTH,
	backfillDisposedTrackingFlags,
	backfillDeliveredTrackingFlags,
	backfillFalseCustomsStuckFlags,
	queueOverdueTrackingRechecks,
	acquireLock,
	releaseLock,
	SHIPPING_CLAIM_STATUSES,
	MAX_SHIPPING_CLAIM_NOTE_LENGTH,
	setFourpxBalance,
	getFourpxBalanceStatus,
	upsertRouteAssignment,
	getRouteAssignment,
	getAllRouteAssignments,
	upsertProductAssignment,
	getProductAssignment,
	getAllProductAssignments,
	getSupplierDirectory,
	getCharmShopDirectory,
	getSourcingSuppliers,
	getSourcingSupplierById,
	insertSourcingSupplier,
	updateSourcingSupplier,
	deleteSourcingSupplier,
	getSourcingPackages,
	getSourcingPackageById,
	insertSourcingPackage,
	updateSourcingPackage,
	deleteSourcingPackage,
	insertSupplierDirectoryRow,
	updateSupplierDirectoryRow,
	deleteSupplierDirectoryRow,
	insertCharmShopDirectoryRow,
	updateCharmShopDirectoryRow,
	deleteCharmShopDirectoryRow,
	getCharmLibrary,
	getCharmByCode,
	setProductCost,
	setCharmCost,
	insertCharmLibraryRow,
	updateCharmLibraryRow,
	deleteCharmLibraryRow,
	reorderCharmLibrary,
	getCharmPurchaseProgress,
	setCharmPurchaseProgress,
	getProductMap,
	upsertProductMapRow,
	updateProductMapRowById,
	deleteProductMapRow,
	mergeProductMapSupplierCharm,
	syncProductMapToAssignments,
	getProductMapRow,
	resolveWrongStallForProduct,
	reconcileAssignmentsToProductMap,
	createRouteManualOrder,
	MAX_ROUTE_MANUAL_ITEMS,
	getManualItems,
	getManualItemImage,
	deleteManualOrderLine,
	insertManualOrder,
	updateManualOrder,
	deleteManualOrder,
	purgeManualOrder,
	setManualOrderShipped,
	setManualOrderTracking,
	MANUAL_SHOP_ID,
	MANUAL_GROUP_ID,
	recordPurchaseSyncRun,
	listPurchaseSyncRuns,
	getPurchaseSyncRun,
	getListingImageData,
	updateShopHealth,
	upsertShopHealthSnapshot,
	getEarningsSummary,
	getCurrentMonthNet,
	getPerOrderEarnings,
	getLedgerStats,
	getShopBalances,
	setRouteDismissed,
	setRouteVerified,
	setItemPurchaseVerified,
	clearRouteVerified,
	clearDismissedByReceipt,
	ISSUE_TYPES,
	ISSUE_RESOLUTIONS,
	getIssuesForReceipts,
	getIssuesForReceipt,
	getIssueById,
	getOrderIssue,
	upsertOrderIssue,
	patchOrderIssue,
	deleteOrderIssue,
	getExchangesForReceipts,
	getExchangesForReceipt,
	getExchangeById,
	upsertOrderExchange,
	patchOrderExchange,
	deleteOrderExchange,
	getSubstitutionsForReceipts,
	getSubstitutionForLine,
	upsertOrderSubstitution,
	deleteOrderSubstitution,
	getSubstitutionImage,
	upsertListingStyleImage,
	deleteListingStyleImage,
	getListingStyleImageMeta,
	getListingStyleImage,
	getListingStyleImageMap,
	getListingVariationImageMap,
} = require('../db/setup')
const { lookupStyleKeyed, lookupVariationImage, parseStyleValueId, resolveUnswitchedLineImage, resolveSwitchedLineImage } = require('../listings/variation-images')
const routeDashboard = require('../route/dashboard')
const routeSourcing = require('../route/sourcing')
const productMerges = require('../route/product-merges')
const productSimilarity = require('../route/product-similarity')
const { ProductIdentityCoordinator } = require('../route/product-identity-coordinator')
const { FLOOR_MAPS, normalizeStallCode, stallCodeAliases } = require('../route/floor-map')
const { generateBuyerIssueMessage } = require('../support/buyer-message')
const { checkMessageCompliance } = require('../support/message-compliance')
const enginePaths = require('../route/engine-paths')
const sourcingLib = require('../sourcing/library')
const sourcingCatalog = require('../sourcing/catalog')
const sourcingCatalogView = require('../sourcing/catalog-view')
const statusImport = require('../route/status-import')
const { buildSyncReportWorkbook } = require('../route/sync-report-xlsx')
const { batchFetchRouteImages, fetchImageBuffer } = require('../route/image-fetcher')
const { shopRouteImageUrl, ensureListingImageBytes } = require('../route/shop-images')
const { sendStoredImage } = require('../route/stored-image-security')
const unmatchedImages = require('../route/unmatched-images')
const { logZeroStockIfNeeded, listingHasLiveZero, raiseOfferingsToTarget, getZeroStylesForListing, formatStyleLabel, removeModelFromInventory } = require('../inventory/helpers')
const { syncShop, runSyncCycle, runInventoryWatchCycle, startEtsyWork, isEtsyWorkRunning, getEtsyWorkStatus, syncLedgerForShop, startTrackingCycle, getTrackingCycleStatus, getTrackingPollSettings, releaseSyncLock, releaseTrackingLock, intervalToCron } = require('../workers/sync')
const { createGroupClient } = require('../proxy/factory')
const { getLogisticsProducts, createShipOrder, getShipLabel, cancelShipOrder, getShipOrder, getOrderFreight, getEstimatedCost, normalizeShipOrderResponse, planShipOrderReference, mintShipOrderFallbackRef, isRefInProcessingRejection, splitName, safeLabelBaseName, assignUniqueLabelNames } = require('../fourpx/orders')
const { renderLabelBitmap, printBitmapWindows, writeTempLabelPng, MIN_HEALTHY_COVERAGE_PCT } = require('../fourpx/label-print')
// 4PX door-to-door collection booking (揽收预约). Namespaced rather than
// destructured: the module is a small API surface used in one place, and reading
// `fourpxCollect.assertReserveDate(...)` at the call site says which carrier
// contract the rule comes from.
const fourpxCollect = require('../fourpx/collect')
const { listReserveDateOptions, PICKUP_FIELDS: FOURPX_PICKUP_FIELDS, DEFAULT_PICKUP_TIMEZONE: FOURPX_DEFAULT_PICKUP_TIMEZONE } = fourpxCollect
const { downloadToBuffer, isTransientDownloadError } = require('../util/http-download')
const { resolveReceiptFreight } = require('../fourpx/freight')
const { FOURPX_POSTLINK_S5058_CODE, FOURPX_POSTLINK_S5058_COUNTRIES, FOURPX_COUNTRY_DEFAULT_PRODUCT, FOURPX_EXPRESS_WORLDWIDE, FOURPX_EXPRESS_BY_COUNTRY, resolveLogisticsProduct, isExpressProduct, expressCandidates, assessExpressChoice, resolveUsIslandZipFallback } = require('../fourpx/product-preference')
const { getFullTrackingEvents, _withHealth } = require('../tracking/checker')
const { normalizeTrackingCode, normalizeFourpxLookupCode, normalizeCarrierName } = require('../tracking/validation')
const { scanInputRoot } = require('../listings/scanner')
const { getShopListingSettings } = require('../listings/shop-settings')
const { BulkJobManager } = require('../listings/bulk-runner')
const { listProductTypes, getProductType, styleKeysFor, deviceFamilyOf, crossFamilyModelError, canonicalModelsForFamily, primaryComponentLabel, FAMILY_IPHONE, FAMILY_AIRPODS, FAMILY_WATCH, FAMILY_IPAD } = require('../listings/product-types')
const { getPricesForCurrency } = require('../listings/pricing')
const { resolveDefaultPrices, getShopCurrentStylePrices } = require('../listings/shop-prices')
const { ShopRepricer } = require('../listings/repricer')
const { CHARACTERS } = require('../listings/character-catalog')
const thumbnails = require('../listings/thumbnails')
const { buildGrowthReport, listThirdPartyRightsReview } = require('../growth/diagnostics')
const { shopNeedsCatalogHealth, syncShopCatalogHealth } = require('../growth/catalog-sync')
const {
	parsePastedStatsText,
	saveManualComparison,
	listManualComparisons,
	deleteManualComparison,
} = require('../growth/manual-import')
const {
	parsePastedListingStats,
	saveListingDetailImport,
	listListingDetailImports,
	deleteListingDetailImport,
} = require('../growth/manual-listing-import')

// Default remains the repo-local, gitignored token store. Tests and isolated
// secondary instances can point at their own file so merely booting the real
// server module never reads or rewrites production credentials.
const TOKENS_PATH = process.env.DASHBOARD_TOKENS_PATH ? path.resolve(process.env.DASHBOARD_TOKENS_PATH) : path.resolve(__dirname, '../../tokens.json')

// Absolute path to THIS dashboard's project root (src/server → ../../).
// Used to keep generated artifacts (e.g. shopping-route Excel files) inside
// our own program folder regardless of the process working directory.
const UED_ROOT = path.resolve(__dirname, '../../')

// ─── SSE sync-event bus ───────────────────────────────────────────────────────
// All connected SSE clients receive real-time sync log events.
const _sseClients = new Set()
function broadcastSyncEvent(payload) {
	const data = `data: ${JSON.stringify(payload)}\n\n`
	_sseClients.forEach((res) => {
		try {
			res.write(data)
		} catch {}
	})
}

// ─── SSE shopping-route bus ───────────────────────────────────────────────────
// Powers live collaboration on the shopping route: when anyone (owner on the
// desktop Route tab, or a shopper on the mobile /shop page) changes a purchase
// status, every other connected device is pushed the update instantly so the
// team never double-buys or works off stale data. Kept separate from the sync
// bus above so shoppers only ever receive shopping events (never sync logs).
const _routeSseClients = new Set()
function broadcastRouteEvent(payload) {
	const data = `data: ${JSON.stringify(payload)}\n\n`
	_routeSseClients.forEach((res) => {
		try {
			res.write(data)
		} catch {}
	})
}

/**
 * Tell every live Route/Shopping client that this order's ROUTE MEMBERSHIP or
 * CONTENT changed in a way a per-line 'assign' patch can't express — a design was
 * switched (a line enters the route, or its title/supplier/image change), a switch
 * was reverted, or a fulfilment issue was flagged / resolved / reopened / deleted
 * (a line leaves or re-enters the purchasing route). Clients respond by re-fetching
 * so the new/removed line appears instantly, instead of only after a manual reload.
 * Without this, such changes show in the Orders tab (where they're made) but the
 * Route tab and mobile Shopping page stay stale.
 */
function broadcastRouteRefresh(receiptId, reason) {
	broadcastRouteEvent({ type: 'refresh', receipt_id: Number(receiptId) || null, reason: reason || 'change' })
}

/**
 * Catalog and supplier mutations affect every product browser and may also
 * change live route resolution. Use the existing route stream so all tabs and
 * devices invalidate from one ordered event instead of maintaining a second
 * best-effort notification channel.
 */
function broadcastCatalogRefresh(reason, details = {}) {
	broadcastRouteEvent({
		type: 'refresh',
		scope: 'catalog',
		receipt_id: null,
		reason: reason || 'catalog-changed',
		...details,
	})
}

// ─── Shopping Route generation job state ──────────────────────────────────────
// At most one route generation job runs at a time per server instance.
// The client polls GET /api/route/status every 1.5 s while status === 'running'.
let _routeJob = {
	status: 'idle', // 'idle' | 'running' | 'done' | 'error'
	log: [],
	startedAt: null,
	finishedAt: null,
	outputDir: null,
	files: [], // [{ name, path, size }]
	error: null,
}

// Track which shops are currently syncing (for the UI spinner)
const _syncingShops = new Set()

// ── 4PX Logistics Products Cache ──────────────────────────────────────────────
// Cache the logistics product list for 30 minutes to avoid hammering the API.
// Keyed by "appKey:countryCode" so different country filters get separate caches.
const _fpxProductsCache = new Map() // key → { products, expiresAt }

// Second cache: the *authoritative* set of logistics-product codes 4PX actually
// accepts for a destination, used to validate a chosen product BEFORE calling
// ds.xms.order.create (so an invalid code is rejected with clear guidance instead
// of the opaque 4PX "product code does not exist" / DS000110 round-trip).
// Keyed by "appKey:countryCode" → { codes:Set<string>, priceable:Set<string>, expiresAt }.
const _fpxValidCodesCache = new Map()

/**
 * Curated 4PX logistics products — the RECOMMENDED, human-friendly shortlist we
 * float to the top of the picker and use as the last-resort fallback list.
 *
 * CRITICAL INVARIANT — every code here is a REAL, order-able 4PX product code.
 * ─────────────────────────────────────────────────────────────────────────────
 * The previous version of this catalogue carried ~20 *fabricated* codes (PXUS,
 * PXCA, SFCECO, YUNTU, FDBM, BDS, …). None of them exist on the 4PX account: the
 * live ds.xms.logistics_product.getlist returns 600+ products and NOT ONE of the
 * fabricated codes is among them. They were nonetheless injected into the picker
 * as "curated" options and every attempt to ship with one failed at order-create
 * with 4PX error DS000110 ("product code does not exist") — the exact bug this
 * file now fixes. The correct 4PX priority-postal code is "PX" (not "PXUS"): 4PX
 * resolves the destination carrier internally, so there are NO per-country
 * suffix codes (same lesson already learned for QC → there is no "QCUS").
 *
 * Every code below was verified against BOTH the live product list and the live
 * ds.xms.estimated_cost.get rate card for this account. The live API remains the
 * single source of truth at runtime; this list only supplies friendly English
 * names, tiering, and a sensible default ordering on top of the live data.
 *
 * Structure per entry:
 *   code      — logistics_product_code passed verbatim to ds.xms.order.create
 *   name      — short English display label
 *   desc      — one-line description (live price / ETA is appended when known)
 *   tier      — 'economy' | 'standard' | 'express' | 'custom'
 *   countries — ISO-2 destinations where this product is offered; [] = worldwide.
 */

// Helper — ISO-2 codes for common destination regions. Sourced from the
// destination-tax registry so the product catalogue, the customs data we
// transmit and the packing bench cannot drift to different ideas of "the EU".
const _EU27 = [...destinationTax.EU27]

// Destinations where 4PX requires an IOSS number for parcels with a declared
// value ≤ €150 (EU27 — the IOSS scheme covers the whole EU customs union). The
// server attaches the resolved marketplace IOSS number to orders bound for these
// countries (see destinationTax.resolveShipmentIoss).
const FOURPX_IOSS_COUNTRIES = destinationTax.EU_IOSS_COUNTRIES

const FOURPX_RECOMMENDED_PRODUCTS = [
	// ── POSTLINK-LW (S5058) — the default workhorse for light parcels ────────────
	// Docs-verified POSTLINK-LW coverage lives in src/fourpx/product-preference.js
	// so the picker default, /api/4px/config, and the server-side resolver agree.
	{
		code: 'S5058',
		name: 'POSTLINK-LW (S5058)',
		desc: 'Postal Light Weight · ≤2 kg · tracked · economy',
		tier: 'economy',
		countries: [...FOURPX_POSTLINK_S5058_COUNTRIES],
	},

	// ── QC — POSTLINK Standard Registered (联邮通标准挂号) ─────────────────────────
	// A single global code; 4PX resolves the destination carrier internally.
	{ code: 'QC', name: 'POSTLINK Standard (QC)', desc: 'Standard registered · guaranteed scans · low loss', tier: 'standard', countries: [] },

	// ── PX — POSTLINK Priority Registered (联邮通优先挂号) ─────────────────────────
	// The REAL 4PX priority-postal code. This is the correct product for a faster
	// service to the US and elsewhere — it replaces the old fabricated "PXUS".
	{ code: 'PX', name: 'POSTLINK Priority (PX)', desc: 'Priority registered · faster transit · signature scans', tier: 'express', countries: [] },

	// ── S5063 — POSTLINK China–US Fast Track (联邮通中美快线) ──────────────────────
	// US-only expedited postal line (no battery). Real, priced ~5–9 days.
	{ code: 'S5063', name: 'POSTLINK US Fast Track (S5063)', desc: 'China–US expedited postal line · no battery', tier: 'express', countries: ['US'] },

	// ── S5118 — US-ISLAND-PH — the ONLY lane for US island ZIPs ──────────────────
	// Hawaii / Alaska / Guam / Puerto Rico / US Virgin Islands (+ Philippines).
	{ code: 'S5118', name: 'US-ISLAND-PH (S5118)', desc: 'US island territories (HI/AK/GU/PR/VI) + Philippines', tier: 'economy', countries: ['US', 'PH'] },

	// ── Manual / fallback ────────────────────────────────────────────────────────
	{ code: 'OTHER', name: 'Other / Custom…', desc: 'Enter a 4PX product code manually', tier: 'custom', countries: [] },
]

/**
 * True when a curated product entry is offered for `country` ([] = worldwide).
 * @param {{countries:string[]}} p
 * @param {string} country  ISO-2 (already upper-cased) or '' for "any".
 */
function _fpxProductServesCountry(p, country) {
	return !country || !Array.isArray(p.countries) || p.countries.length === 0 || p.countries.includes(country)
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

let config
try {
	config = loadConfig()
} catch (err) {
	console.error(`Config error: ${err.message}`)
	process.exit(1)
}

const tokenManager = new TokenManager(TOKENS_PATH)
const db = initDb(config.db_path)
syncConfigToDb(db, config)

// ── Sourcing Library on-disk store ──────────────────────────────────────────
// Uploaded product zips are large binary blobs, so they live on disk (indexed by
// the sourcing_packages table) under <data>/sourcing-library, alongside the DB.
// One folder per supplier id, then per category, keeps the tree browsable and the
// paths short. Created eagerly at boot so the very first upload never races a mkdir.
const SOURCING_ROOT = path.join(path.dirname(path.resolve(config.db_path)), 'sourcing-library')
try {
	fs.mkdirSync(SOURCING_ROOT, { recursive: true })
} catch (err) {
	console.error(`[sourcing] could not create library dir ${SOURCING_ROOT}: ${err.message}`)
}

// Import the supplier + charm-shop directory from OSP's supplier_catalog.xlsx
// so the route dashboard's pickers use the exact, real shop names + stalls.
// The supplier_directory table is the authoritative store for in-app CRUD, so
// we only SEED it from Excel when it's empty (first run); charm shops + product
// map always refresh. Use the "Re-sync from Excel" action to force-replace.
// Non-fatal: a missing workbook just leaves the directory empty.
const supplierImport = require('../route/supplier-import')
const charmLibrary = require('../route/charm-library')
try {
	const seedSuppliers = getSupplierDirectory(db).length === 0
	const seedCharmShops = getCharmShopDirectory(db).length === 0
	const r = supplierImport.importSupplierCatalog(db, config, {
		skipSuppliers: !seedSuppliers,
		skipCharmShops: !seedCharmShops,
	})
	if (r.ok && (r.suppliers != null || r.charm_shops != null)) {
		const sp = r.suppliers != null ? `seeded ${r.suppliers} supplier(s)` : 'preserved suppliers'
		const cs = r.charm_shops != null ? `seeded ${r.charm_shops} charm shop(s)` : 'preserved charm shops'
		console.log(`[suppliers] Catalog import: ${sp}, ${cs}.`)
	} else if (r.ok) {
		console.log('[suppliers] Preserved existing supplier + charm-shop directories.')
	} else {
		console.warn(`[suppliers] Catalog import skipped: ${r.reason}`)
	}
} catch (err) {
	console.warn(`[suppliers] Catalog import failed: ${err.message}`)
}

// Reconcile the product catalog with the bundled route-engine catalog so an
// operator never sees a blank supplier for a product the engine already knows.
// Fills empty supplier/charm fields only — manual + Excel data always wins.
try {
	const rc = routeDashboard.reconcileProductMap(db, config)
	if (rc.ok && (rc.supplier_filled || rc.charm_filled)) {
		console.log(`[product-map] Reconciled from catalog: filled ${rc.supplier_filled} supplier + ${rc.charm_filled} charm field(s).`)
	}
} catch (err) {
	console.warn(`[product-map] Reconcile failed: ${err.message}`)
}

// Backfill the Product Catalog from every supplier/charm the operator has saved
// in the Orders Sorting Dashboard (product_assignments). This repairs historical
// drift from before write-through existed, so products edited in the Route tab
// days ago now appear correctly filled in the Product Catalog. Idempotent: a
// no-op once the two tables already agree.
try {
	const ra = reconcileAssignmentsToProductMap(db)
	if (ra.ok && (ra.filled || ra.created)) {
		console.log(`[product-map] Synced from Orders Sorting Dashboard: updated ${ra.filled} + added ${ra.created} catalog entr(ies).`)
	}
} catch (err) {
	console.warn(`[product-map] Assignment→catalog sync failed: ${err.message}`)
}

// Seed the charm library from charm_manifest.json (only when empty), so charm
// CRUD edits survive restarts. Use "Re-sync charms" to force-reload from OSP.
try {
	const cr = charmLibrary.seedCharmLibraryIfEmpty(db, config)
	if (cr.ok && cr.reason === 'seeded') {
		console.log(`[charms] Seeded ${cr.seeded} charm(s) from charm_manifest.json`)
	} else if (cr.ok) {
		console.log('[charms] Preserved existing charm library.')
	} else {
		console.warn(`[charms] Charm seed skipped: ${cr.reason}`)
	}
} catch (err) {
	console.warn(`[charms] Charm seed failed: ${err.message}`)
}

const app = express()
const trustProxyRaw = String(process.env.DASHBOARD_TRUST_PROXY || 'loopback').trim()
const trustProxy = /^\d+$/.test(trustProxyRaw) ? Number(trustProxyRaw) : /^(?:false|off|no)$/i.test(trustProxyRaw) ? false : trustProxyRaw
app.set('trust proxy', trustProxy)
app.disable('x-powered-by')
app.use((_req, res, next) => {
	res.setHeader('X-Content-Type-Options', 'nosniff')
	res.setHeader('X-Frame-Options', 'DENY')
	res.setHeader('Referrer-Policy', 'no-referrer')
	res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
	// The current UI intentionally uses inline scripts/styles and event handlers,
	// so those two sources remain allowed. The policy still blocks framing,
	// plugins, foreign scripts, and unexpected network destinations.
	res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; " + "form-action 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " + "img-src 'self' data: blob: https:; media-src 'self' data: blob: https:; " + "connect-src 'self'; worker-src 'self' blob:")
	next()
})
// The shipped UI is same-origin and needs no CORS. Cross-origin browser access is
// opt-in and exact-origin only; a wildcard on a credentialed operations API would
// unnecessarily widen the attack surface.
const configuredCorsOrigins = new Set(
	String(process.env.DASHBOARD_CORS_ORIGINS || '')
		.split(',')
		.map((origin) => origin.trim())
		.filter(Boolean),
)
if (configuredCorsOrigins.size) {
	app.use(
		cors({
			origin(origin, callback) {
				callback(null, !origin || configuredCorsOrigins.has(origin))
			},
			credentials: true,
		}),
	)
}
// gzip/deflate every JSON + HTML response. Big win on slow mobile/cellular and
// LAN (Cloudflare compresses edge→client, but this covers LAN + origin→edge).
// CRITICAL: never compress Server-Sent Events — buffering the stream would break
// real-time push and leave clients hanging in "connecting".
const compression = require('compression')
app.use(
	compression({
		filter: (req, res) => {
			const ct = String(res.getHeader('Content-Type') || '')
			if (ct.includes('text/event-stream')) return false
			return compression.filter(req, res)
		},
	}),
)
// ─── Authentication & role-based access control ─────────────────────────────────
// Installs login + the deny-by-default role gate BEFORE any routes, so every
// endpoint below is protected. WHO may do WHAT lives in src/auth/policy.js. Auth
// is opt-in: it activates only when DASHBOARD_OWNER_PASSWORD is set, so existing
// single-user setups keep working.
const { createAuth } = require('../auth/access')
const { createUserStore } = require('../auth/user-store')
const userStore = createUserStore(db)
const auth = createAuth({ store: userStore })
auth.install(app)
// In passwordless single-owner mode the server binds to loopback. Also pin Host:
// otherwise a malicious public hostname can DNS-rebind to 127.0.0.1 and become
// same-origin with owner-level APIs in the victim's browser.
if (!auth.enabled) {
	const localHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
	app.use((req, res, next) => {
		if (!localHosts.has(String(req.hostname || '').toLowerCase())) {
			return res.status(421).json({ error: 'Invalid local dashboard host', code: 'INVALID_HOST' })
		}
		next()
	})
}
// Reject browser-initiated cross-site mutations (and GET endpoints that have a
// physical side effect). Same-origin UI calls and non-browser automation, which
// do not send Sec-Fetch-Site, retain their existing behavior.
app.use((req, res, next) => {
	if (!req.path.startsWith('/api/')) return next()
	const sideEffectGet = req.method === 'GET' && (/^\/api\/4px\/label-print\//.test(req.path) || req.path === '/api/route/open' || req.path === '/api/route/supplier-catalog/open')
	const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method)
	if (mutating || sideEffectGet) {
		const origin = String(req.headers.origin || '').trim()
		let sameOrigin = false
		if (origin) {
			try {
				sameOrigin = new URL(origin).host === String(req.headers.host || '')
			} catch {
				sameOrigin = false
			}
		}
		const explicitlyTrusted = !!origin && configuredCorsOrigins.has(origin)
		const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase()
		if ((origin && !sameOrigin && !explicitlyTrusted) || (['cross-site', 'same-site'].includes(fetchSite) && !sameOrigin && !explicitlyTrusted)) {
			return res.status(403).json({ error: 'Cross-site request blocked', code: 'CROSS_SITE_BLOCKED' })
		}
	}
	next()
})
// Parse large JSON only AFTER authentication/authorization. The login route has
// its own tight 16 KB parser in access.js, so an unauthenticated client cannot
// force 25 MB JSON parsing on protected endpoints.
app.use(express.json({ limit: '25mb' }))
if (auth.enabled) {
	console.log(`[auth] Access control ENABLED — ${userStore.count()} named user(s) + env bootstrap (owner / packer).`)
} else {
	console.warn('[auth] Auth OFF (single-owner mode). Set DASHBOARD_OWNER_PASSWORD in .env, or add a user: npm run user -- add <name> <role>')
}

// Staff administration: accounts, the audit log and shift reports. The gate above
// already denies these to everyone but the owner; naming the capability at the
// route keeps the requirement visible where the handler lives.
const requireStaffAdmin = auth.requireCapability('admin:users')

// ─── Audit log ──────────────────────────────────────────────────────────────────
// Records every state-changing API call with the acting role, so the owner can
// always answer "who packed/shipped which order, and when". One middleware covers
// every mutating route automatically (no per-handler wiring to forget).
db.exec(`CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  role TEXT,
  user TEXT,
  method TEXT,
  path TEXT,
  status INTEGER,
  details TEXT,
  product_context TEXT
)`)
// Additive migrations for DBs created before these columns existed. `details`
// stores a small, redacted JSON snapshot of the request so the activity feed can
// say exactly WHICH order/product/shop an action touched — not just the URL.
// `product_context` is a bounded, versioned event-time snapshot for order-level
// actions such as packaging, where one receipt may contain several products.
for (const col of ['user TEXT', 'details TEXT', 'product_context TEXT']) {
	try {
		db.exec(`ALTER TABLE audit_log ADD COLUMN ${col}`)
	} catch {
		/* column already exists on an older DB — fine */
	}
}

// Keys that must NEVER be persisted (secrets) or that are binary / far too large
// to be meaningful in an audit trail. Matched case-insensitively as substrings.
const _AUDIT_SECRET_KEY = /pass|token|secret|api[-_]?key|authorization|\bauth\b|credential|private|cookie|\bcode\b/i
const _AUDIT_BULKY_KEY = /image|photo|thumbnail|b64|base64|buffer|blob|bytes|\bcsv\b|xlsx|\bfile\b|data_?url|payload|\braw\b/i

/**
 * Build a compact, human-meaningful snapshot of a request for the audit log.
 * Captures scalar identifiers/labels from the route params, body, and query
 * (e.g. receipt_id, title, tracking_code) while redacting secrets, dropping
 * binary/bulky fields, summarising arrays as counts, and truncating long
 * strings. Returns a JSON string, or null when there's nothing useful to store.
 */
function _auditSnapshot(req) {
	const out = {}
	const collect = (src) => {
		if (!src || typeof src !== 'object') return
		for (const [key, val] of Object.entries(src)) {
			if (val == null || val === '') continue
			// Shopping Mode deliberately sends the exact image reference the employee
			// saw. Keep it only after a strict allowlist check; every other image/blob
			// field remains excluded by _AUDIT_BULKY_KEY below.
			if (key === 'product_image_url') {
				const safeImage = activityProductContext.safeProductImageUrl(val)
				if (safeImage) out[key] = safeImage
				continue
			}
			if (_AUDIT_SECRET_KEY.test(key) || _AUDIT_BULKY_KEY.test(key)) continue
			if (Array.isArray(val)) {
				out[key] = `${val.length} item${val.length === 1 ? '' : 's'}`
			} else if (typeof val === 'object') {
				continue // skip nested objects (usually binary/structured blobs)
			} else {
				let s = String(val)
				if (s.length > 140) s = s.slice(0, 137) + '…'
				out[key] = s
			}
		}
	}
	// Query is the least authoritative source on a mutating request. Body values
	// describe the applied mutation and URL params identify its resource, so both
	// must override a conflicting query string rather than letting it forge the
	// audit target.
	collect(req.query)
	collect(req.body)
	collect(req.params)
	const keys = Object.keys(out)
	if (keys.length === 0) return null
	let json = JSON.stringify(out)
	if (json.length <= 2000) return json

	// A long but valid image URL must never make the ENTIRE audit identity vanish.
	// Drop the optional media reference first, then pack identifiers/status fields
	// ahead of descriptive extras until the hard row budget is reached.
	delete out.product_image_url
	const priority = ['receipt_id', 'item_key', 'activity_context_version', 'title', 'component', 'status', 'status_case', 'status_grip', 'status_charm', 'listing_id', 'product_listing_id', 'phone_model', 'ordered_phone_model', 'style', 'quantity']
	const compact = {}
	const orderedKeys = [...new Set([...priority, ...Object.keys(out)])]
	for (const key of orderedKeys) {
		if (!Object.prototype.hasOwnProperty.call(out, key)) continue
		compact[key] = out[key]
		const candidate = JSON.stringify(compact)
		if (candidate.length > 2000) delete compact[key]
	}
	json = JSON.stringify(compact)
	return Object.keys(compact).length && json.length <= 2000 ? json : null
}

const _auditInsert = db.prepare('INSERT INTO audit_log (ts, role, user, method, path, status, details, product_context) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
app.use((req, res, next) => {
	if ((req.path.startsWith('/api/') || req.path === '/api') && (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE') && !req.path.startsWith('/api/auth/')) {
		res.on('finish', () => {
			try {
				const productContext = activityProductContext.serializeOrderProductSnapshot(res.locals.auditOrderProductSnapshot)
				_auditInsert.run(Date.now(), (req.auth && req.auth.role) || 'anon', (req.auth && req.auth.user) || null, req.method, req.path, res.statusCode, _auditSnapshot(req), productContext)
			} catch {
				/* never let auditing break a request */
			}
		})
	}
	next()
})

operationsChecklist.installRoutes(app, {
	db,
	timeZone: () => config.operations_timezone,
})

function _captureAuditOrderProductSnapshot(res, receiptId) {
	try {
		const snapshot = activityProductContext.buildOrderProductSnapshot(db, config, receiptId)
		if (snapshot) res.locals.auditOrderProductSnapshot = snapshot
	} catch (error) {
		// Auditing is best-effort and must never block the physical packing flow.
		// GET /api/audit retains its historical read-time fallback when this fails.
		console.warn(`[audit] could not snapshot products for receipt ${receiptId}:`, error.message)
	}
}

// Owner-only: recent audit entries (packer is denied by the gate above anyway).
// Optional `since`/`until` (epoch ms) bound the window so the client can request
// a real day/range accurately — the caller computes local-day boundaries, the
// server only compares numeric timestamps (timezone-agnostic).
app.get('/api/audit', requireStaffAdmin, (req, res) => {
	const requestedLimit = Number.parseInt(req.query.limit, 10)
	const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 2000) : 200
	const since = Number(req.query.since)
	const until = Number(req.query.until)
	const where = []
	const whereParams = []
	if (Number.isFinite(since)) {
		where.push('ts >= ?')
		whereParams.push(since)
	}
	if (Number.isFinite(until)) {
		where.push('ts < ?')
		whereParams.push(until)
	}
	const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : ''
	const rows = db.prepare(`SELECT id, ts, role, user, method, path, status, details, product_context FROM audit_log${whereSql} ORDER BY id DESC LIMIT ?`).all(...whereParams, limit)
	// Authoritative per-person counts over the WHOLE range (never capped by the
	// row limit), so the UI's per-user totals stay correct even when the rendered
	// list is truncated. Cardinality is tiny (one row per user/role pair).
	const tallies = db.prepare(`SELECT user, role, COUNT(*) AS n FROM audit_log${whereSql} GROUP BY user, role`).all(...whereParams)
	const parsedEntries = rows.map((r) => {
		let details = null
		if (r.details) {
			try {
				details = JSON.parse(r.details)
			} catch {
				/* legacy / malformed — leave null */
			}
		}
		return { ...r, details }
	})
	// New shopper writes already carry event-time product metadata plus a safe image
	// reference. Older audit rows are resolved in batches from their canonical
	// order-line key, so historical activity gains best-effort current images/styles
	// without rewriting audit history.
	const entries = activityProductContext.enrichAuditEntries({
		db,
		config,
		entries: parsedEntries,
		onError: (error) => console.warn('[audit] product context enrichment failed:', error.message),
	})
	res.json({ entries, tallies })
})

/**
 * GET /api/shift-summary  (owner only)
 * A per-employee "what did they get done" rollup over a time window. Reads the
 * existing audit_log (no new tracking to maintain) and classifies each successful
 * mutation into verified / purchased / packaged / shipped / issue buckets via the
 * shared, unit-tested src/orders/shift-summary module.
 *
 * Query: since, until (epoch ms — caller computes local-day boundaries, as with
 * /api/audit), user (optional filter). Returns per-user totals.
 */
app.get('/api/shift-summary', requireStaffAdmin, (req, res) => {
	const since = Number(req.query.since)
	const until = Number(req.query.until)
	const userFilter = (req.query.user || '').trim()
	const where = []
	const p = []
	if (Number.isFinite(since)) {
		where.push('ts >= ?')
		p.push(since)
	}
	if (Number.isFinite(until)) {
		where.push('ts < ?')
		p.push(until)
	}
	if (userFilter) {
		where.push('user = ?')
		p.push(userFilter)
	}
	const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : ''
	const rows = db
		.prepare(`SELECT ts, role, user, method, path, status, details FROM audit_log${whereSql} ORDER BY id ASC`)
		.all(...p)
		.map((r) => {
			let details = null
			try {
				details = r.details ? JSON.parse(r.details) : null
			} catch {
				details = null
			}
			return { ...r, details }
		})

	res.json({
		since: Number.isFinite(since) ? since : null,
		until: Number.isFinite(until) ? until : null,
		...summarizeShift(rows),
	})
})

// ─── Team / user management ──────────────────────────────────────────────────
// Named accounts for accountability + clean offboarding. Non-owner sessions are
// already denied by the deny-by-default gate; the guard is belt-and-suspenders.
app.get('/api/users', requireStaffAdmin, (_req, res) => {
	res.json({ users: userStore.list() })
})
app.post('/api/users', requireStaffAdmin, (req, res) => {
	try {
		const { username, password, role } = req.body || {}
		const u = userStore.add({ username, password, role, createdBy: (req.auth && req.auth.user) || 'owner' })
		res.json({ user: { id: u.id, username: u.username, role: u.role, active: u.active } })
	} catch (e) {
		res.status(400).json({ error: e.message })
	}
})
app.post('/api/users/:id/disable', requireStaffAdmin, (req, res) => {
	const id = Number(req.params.id)
	const u = userStore.getById(id)
	if (!u) return res.status(404).json({ error: 'User not found' })
	// Guard rails: never let the owner lock themselves out.
	if (u.username && req.auth && String(u.username).toLowerCase() === String(req.auth.user).toLowerCase()) return res.status(400).json({ error: 'You cannot disable your own account.' })
	if (u.role === 'owner' && u.active && userStore.activeOwnerCount() <= 1) return res.status(400).json({ error: 'Cannot disable the last active owner.' })
	res.json({ user: userStore.setActive(id, false) })
})
app.post('/api/users/:id/enable', requireStaffAdmin, (req, res) => {
	const u = userStore.getById(Number(req.params.id))
	if (!u) return res.status(404).json({ error: 'User not found' })
	res.json({ user: userStore.setActive(Number(req.params.id), true) })
})
app.post('/api/users/:id/revoke', requireStaffAdmin, (req, res) => {
	const u = userStore.getById(Number(req.params.id))
	if (!u) return res.status(404).json({ error: 'User not found' })
	res.json({ user: userStore.revokeSessions(Number(req.params.id)) })
})
app.post('/api/users/:id/password', requireStaffAdmin, (req, res) => {
	try {
		const u = userStore.getById(Number(req.params.id))
		if (!u) return res.status(404).json({ error: 'User not found' })
		userStore.setPassword(Number(req.params.id), (req.body || {}).password)
		res.json({ ok: true })
	} catch (e) {
		res.status(400).json({ error: e.message })
	}
})

// ─── Automated database backups ──────────────────────────────────────────────────
// Once an employee is mutating data, a lost/corrupt DB = lost business. We take a
// consistent online snapshot (better-sqlite3 .backup()) to a NON-synced local
// folder and keep the last N. Configure via DASHBOARD_BACKUP_DIR / _KEEP.
const BACKUP_DIR = process.env.DASHBOARD_BACKUP_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), 'EtsyDashboard', 'backups')
const BACKUP_KEEP = Math.min(365, Math.max(1, Math.floor(Number(process.env.DASHBOARD_BACKUP_KEEP) || 14)))
async function runDbBackup(reason) {
	try {
		fs.mkdirSync(BACKUP_DIR, { recursive: true })
		const stamp = new Date().toISOString().replace(/[:.]/g, '-')
		const dest = path.join(BACKUP_DIR, `etsy_dashboard-${stamp}.db`)
		await db.backup(dest) // online backup → a consistent single-file snapshot
		const routeDbPath = enginePaths.catalogDbPath(config)
		let routeBackedUp = false
		if (routeDbPath && fs.existsSync(routeDbPath)) {
			const routeBackup = path.join(BACKUP_DIR, `route_engine-${stamp}.db`)
			let routeDb = null
			try {
				routeDb = new Database(routeDbPath, { readonly: true, fileMustExist: true })
				await routeDb.backup(routeBackup)
				routeBackedUp = true
			} catch (err) {
				console.warn(`[backup] Route-engine DB backup failed; dashboard backup is still valid: ${err.message}`)
			} finally {
				try {
					routeDb?.close()
				} catch {}
			}
		}
		for (const prefix of ['etsy_dashboard-', 'route_engine-']) {
			const files = fs
				.readdirSync(BACKUP_DIR)
				.filter((f) => f.startsWith(prefix) && f.endsWith('.db'))
				.sort()
			while (files.length > BACKUP_KEEP) {
				const file = files.shift()
				try {
					fs.unlinkSync(path.join(BACKUP_DIR, file))
				} catch {
					/* best-effort retention */
				}
			}
		}
		console.log(`[backup] ${reason} → ${BACKUP_DIR} (dashboard${routeBackedUp ? ' + route-engine' : ''} SQLite; keeping ${BACKUP_KEEP} each)`)
	} catch (e) {
		console.warn('[backup] FAILED:', e.message)
	}
}
// Loud warning if the LIVE DB sits inside a cloud-synced folder (corruption risk).
{
	const dbAbs = path.resolve(config.db_path)
	if (/onedrive|dropbox|google ?drive|gdrive/i.test(dbAbs)) {
		console.warn('  ┌───────────────────────────────────────────────────────────────────────┐')
		console.warn('  │  ⚠  DATABASE IS INSIDE A CLOUD-SYNCED FOLDER — CORRUPTION RISK          │')
		console.warn(`  │  ${dbAbs}`)
		console.warn('  │  Live SQLite must NOT be synced by OneDrive/Dropbox/Drive.              │')
		console.warn('  │  Move it out (server stopped):   node scripts/relocate-db.js           │')
		console.warn('  └───────────────────────────────────────────────────────────────────────┘')
	}
}
{
	const routeDataAbs = enginePaths.engineDataDir(config)
	if (routeDataAbs && /onedrive|dropbox|google ?drive|gdrive/i.test(routeDataAbs)) {
		console.warn(`[route] Mutable route-engine data is inside a cloud-synced folder: ${routeDataAbs}`)
		console.warn('[route] Stop the dashboard and run `npm run relocate-route-data` to protect its SQLite/catalog files.')
	}
}
setTimeout(() => runDbBackup('startup'), 30 * 1000)
cron.schedule('15 3 * * *', () => runDbBackup('daily'))

// ─── API routes ───────────────────────────────────────────────────────────────

/**
 * GET /api/shops
 * Returns all shops from DB with live order counts and last sync time.
 */
app.get('/api/shops', (req, res) => {
	const rows = db
		.prepare(
			`
    SELECT
      s.shop_id,
      s.shop_name,
      s.group_id,
      g.label        AS group_label,
      g.proxy_host,
      s.total_orders,
      s.last_synced_at,
      s.listing_active_count,
      s.listing_count_synced_at,
      COUNT(r.receipt_id) AS receipts_in_db,
      (SELECT sl.status FROM sync_log sl WHERE sl.shop_id = s.shop_id
       ORDER BY sl.started_at DESC LIMIT 1) AS last_sync_status,
      (SELECT sl.receipts_synced FROM sync_log sl WHERE sl.shop_id = s.shop_id
       ORDER BY sl.started_at DESC LIMIT 1) AS last_receipts_synced
    FROM shops s
    JOIN groups g ON g.group_id = s.group_id
    LEFT JOIN receipts r ON r.shop_id = s.shop_id
    WHERE s.group_id <> @manual_group
    GROUP BY s.shop_id
    ORDER BY g.group_id, s.shop_name
  `,
		)
		.all({ manual_group: MANUAL_GROUP_ID })

	// Enrich with token status
	const allShopIds = getAllShops(config).map((s) => s.shop_id)
	const tokenStatus = tokenManager.getStatus(allShopIds)
	const tokenMap = Object.fromEntries(tokenStatus.map((t) => [t.shop_id, t]))

	// Build a map of shop_id → adspower_profile_id from the live config so the
	// frontend can decide which capture-session path to use per shop.
	const configShopMap = Object.fromEntries(getAllShops(config).map((s) => [s.shop_id, { adspower_profile_id: s.adspower_profile_id ?? null }]))

	const enriched = rows.map((r) => ({
		...r,
		last_synced_at_iso: r.last_synced_at ? new Date(r.last_synced_at * 1000).toISOString() : null,
		token_status: tokenMap[r.shop_id]?.status ?? 'unknown',
		refresh_token_days_remaining: tokenMap[r.shop_id]?.refresh_token_days_remaining ?? null,
		adspower_profile_id: configShopMap[r.shop_id]?.adspower_profile_id ?? null,
	}))

	res.json({ shops: enriched })
})

/**
 * GET /api/etsy/budget
 *
 * Last-known Etsy QPD budget by API key and by shop.
 *
 * Important: Etsy QPD is API-key scoped, not shop scoped. Multiple shops using
 * the same app key share the same 5,000/day bucket. This endpoint does NOT make
 * Etsy calls; it exposes the in-memory budget state learned from Etsy response
 * headers (`x-remaining-today`) during normal work. If the process restarted and
 * no call has seen headers for a key yet, the value is marked `known:false`.
 */
app.get('/api/etsy/budget', (req, res) => {
	const snapshots = new Map(getBudgetSnapshots().map((b) => [b.keystring, b]))
	const shops = getAllShops(config).filter((s) => s.group_id !== MANUAL_GROUP_ID)

	const byKey = new Map()
	for (const shop of shops) {
		const key = shop.api_key || 'unknown'
		if (!byKey.has(key)) {
			const snap = snapshots.get(key)
			byKey.set(key, {
				api_key: key,
				key_id: snap?.key_id || (key === 'unknown' ? 'unknown' : `${key.slice(0, 6)}…`),
				known: !!snap?.known,
				remaining: snap?.known ? snap.remaining : null,
				max: snap?.max ?? 5000,
				percent_used: snap?.known ? snap.percent_used : null,
				blocked_for_ms: snap?.blocked_for_ms ?? 0,
				guard_remaining: snap?.guard_remaining ?? null,
				guard_max: snap?.guard_max ?? 4900,
				history: snap?.history ?? [],
				shops: [],
			})
		}
		byKey.get(key).shops.push({
			shop_id: shop.shop_id,
			shop_name: shop.shop_name,
			group_id: shop.group_id,
		})
	}

	const keys = [...byKey.values()].map((k) => ({
		...k,
		shop_count: k.shops.length,
	}))

	const keyByApiKey = new Map(keys.map((k) => [k.api_key, k]))
	const shopBudgets = shops.map((shop) => {
		const keyBudget = keyByApiKey.get(shop.api_key || 'unknown')
		return {
			shop_id: shop.shop_id,
			shop_name: shop.shop_name,
			group_id: shop.group_id,
			api_key_id: keyBudget?.key_id ?? 'unknown',
			key_shop_count: keyBudget?.shop_count ?? 0,
			known: !!keyBudget?.known,
			remaining: keyBudget?.remaining ?? null,
			max: keyBudget?.max ?? 5000,
			percent_used: keyBudget?.percent_used ?? null,
			blocked_for_ms: keyBudget?.blocked_for_ms ?? 0,
		}
	})

	// Do not expose raw Etsy API keystrings to the browser; the masked key_id is
	// sufficient for operators to understand which shops share a quota bucket.
	const publicKeys = keys.map(({ api_key, ...rest }) => rest)

	res.json({
		generated_at: Date.now(),
		note: 'Etsy QPD is shared per API key, not per shop. Values are last-known from Etsy response headers; this endpoint spends 0 Etsy calls.',
		keys: publicKeys,
		shops: shopBudgets,
	})
})

/**
 * GET /api/shops/listing-counts
 * Cached active-listing counts per shop. A live Etsy refresh is allowed only
 * when written API-analytics approval and catalog collection are both enabled.
 *
 * Returns { counts: { [shop_id]: { active, digital, source, error? } } }.
 * The Etsy Shop object exposes `listing_active_count` directly, so a single
 * lightweight getShop call per shop avoids paginating every listing.
 *
 * When a shop is unauthenticated or the Etsy call fails we fall back to the
 * locally cached count so the Overview column always renders a usable number.
 * The route is intentionally defined before any future `/api/shops/:id` route
 * and is an exact match, so there is no path collision with GET /api/shops.
 */
// Active-listing counts change rarely, but the Overview tab polls this endpoint
// on load, on every tab switch, and on a 2-minute timer. Without a TTL, each poll
// fired a live getShop call per shop, continuously draining the shared Etsy QPD
// budget and pinning it at the fulfilment reserve floor (it could never recover
// because the dashboard re-consumed every call the sliding window released). We
// therefore serve from the persisted DB cache and only refresh a shop from Etsy
// when analytics approval is recorded and its cached count is older than this
// TTL. `?force=1` may bypass the TTL, never the approval gate.
const LISTING_COUNT_TTL_MS = 6 * 60 * 60 * 1000 // 6 hours

app.get('/api/shops/listing-counts', async (req, res) => {
	const shops = getAllShops(config).filter((s) => s.group_id !== MANUAL_GROUP_ID)
	const force = req.query.force === '1' || req.query.force === 'true'
	const liveMetadataApproved =
		config.catalog_health_sync === true &&
		config.etsy_api_analytics_approved === true

	// Last known good value + when it was last refreshed from Etsy.
	const cachedRow = (shopId) => db.prepare('SELECT listing_active_count, listing_count_synced_at FROM shops WHERE shop_id = ?').get(shopId)
	const fallbackActive = (shopId) => {
		const persisted = cachedRow(shopId)?.listing_active_count
		if (persisted != null) return persisted
		return db.prepare("SELECT COUNT(*) AS n FROM listings WHERE shop_id = ? AND state = 'active'").get(shopId)?.n ?? 0
	}

	const now = Date.now()
	const results = await Promise.all(
		shops.map(async (shopCfg) => {
			const row = cachedRow(shopCfg.shop_id)
			const cached = fallbackActive(shopCfg.shop_id)
			const syncedAtMs = row?.listing_count_synced_at ? row.listing_count_synced_at * 1000 : 0
			const isFresh = syncedAtMs && now - syncedAtMs < LISTING_COUNT_TTL_MS

			// Cache-first: serve persisted value without spending an Etsy call unless the
			// cache is stale (or a manual force-refresh was requested).
			if (!liveMetadataApproved || !tokenManager.hasTokens(shopCfg.shop_id) || (isFresh && !force)) {
				return [shopCfg.shop_id, { active: cached, digital: 0, source: 'cache' }]
			}

			try {
				const { shopClient } = await getShopClientForShopName(shopCfg.shop_name)
				const shopData = await getShop(shopClient, shopCfg.shop_id)
				const active = shopData.listing_active_count ?? cached
				updateShopHealth(db, shopCfg.shop_id, shopData || { listing_active_count: active })
				return [
					shopCfg.shop_id,
					{
						active,
						digital: shopData.digital_listing_count ?? 0,
						source: 'etsy',
					},
				]
			} catch (err) {
				// Budget-exhaustion here is expected and harmless (we fall back to cache);
				// log it quietly so it doesn't flood the error log every poll.
				if (isQpdExhaustedError(err)) {
					console.warn(`[shops] listing-count for ${shopCfg.shop_name}: budget reserved, using cached count.`)
				} else {
					console.error(`[shops] listing-count fetch failed for ${shopCfg.shop_name}:`, err.message)
				}
				return [shopCfg.shop_id, { active: cached, digital: 0, source: 'cache', error: err.message }]
			}
		}),
	)

	res.json({ counts: Object.fromEntries(results) })
})

/**
 * GET /api/summary
 * Aggregated stats across all shops and groups.
 */
app.get('/api/summary', (req, res) => {
	const totals = db
		.prepare(
			`
    SELECT
      COUNT(DISTINCT shop_id)  AS total_shops_in_db,
      COUNT(*)                 AS total_receipts,
      SUM(CASE WHEN is_paid = 1 THEN 1 ELSE 0 END)    AS paid_orders,
      SUM(CASE WHEN is_shipped = 1 THEN 1 ELSE 0 END) AS shipped_orders,
      SUM(grandtotal_amount)   AS total_revenue
    FROM receipts
  `,
		)
		.get()

	const byGroup = db
		.prepare(
			`
    SELECT
      group_id,
      COUNT(DISTINCT shop_id)  AS shops,
      COUNT(*)                 AS receipts,
      SUM(grandtotal_amount)   AS revenue
    FROM receipts
    GROUP BY group_id
    ORDER BY group_id
  `,
		)
		.all()

	const byShop = db
		.prepare(
			`
    SELECT
      shop_id,
      COUNT(*) AS receipts,
      SUM(grandtotal_amount) AS revenue,
      MAX(etsy_created_at) AS latest_order_ts
    FROM receipts
    GROUP BY shop_id
    ORDER BY receipts DESC
  `,
		)
		.all()

	// Defense in depth: never send revenue figures to a non-owner. The packer's
	// Overview is hidden in the UI, but if this endpoint is ever called by a packer
	// session (e.g. a background refresh) it must not leak earnings.
	if (req.auth && req.auth.role !== 'owner') {
		if (totals) delete totals.total_revenue
		byGroup.forEach((g) => delete g.revenue)
		byShop.forEach((s) => delete s.revenue)
	}

	res.json({
		totals,
		by_group: byGroup,
		by_shop: byShop,
		shops_with_tokens: getAllShops(config).filter((s) => tokenManager.hasTokens(s.shop_id)).length,
		shops_total: getAllShops(config).length,
	})
})

/**
 * Classify a candidate set of receipts by purchasing progress —
 * { ready, outstanding, verified, onHold }.
 *
 * Thin binding of the shared buy-queue module to this server's database handle.
 * The rule itself (what counts as "still to buy", "in hand" and "on hold") lives
 * in src/orders/buy-queue.js, so the Orders API, the "Charms to buy" shopping
 * list and the regression tests all classify identically. See that module's
 * header for the full reasoning behind the three buckets.
 *
 * @param {Array<{receipt_id:number, all_transactions:string}>} candidates
 * @returns {{ ready:Set<number>, outstanding:Set<number>, verified:Set<number>, onHold:Set<number> }}
 */
function classifyPurchaseState(candidates) {
	return buyQueue.classifyPurchaseState(db, candidates)
}

/**
 * Read every non-manual receipt and delegate to the shared, unit-tested dedup
 * engine (src/orders/dedup.js) to decide which Etsy double-fire "ghost" receipts
 * to hide from every view. This wrapper owns only the DB read; all of the
 * suppression reasoning — and its regression tests — live in the module.
 *
 * Manual orders (negative receipt_id, source='manual') are operator-authored,
 * never an Etsy double-fire, and are excluded from the candidate set here.
 *
 * @returns {{ suppressed: Set<number>, survivorOf: Map<number, number[]> }}
 *          suppressed — receipt_ids to hide from every view.
 *          survivorOf — survivor receipt_id → list of receipt_ids it absorbed.
 */
function computeSuppressedDuplicates() {
	let rows = []
	try {
		rows = db
			.prepare(
				`
      SELECT receipt_id, shop_id, buyer_user_id, name AS buyer_name, shipping_zip,
             first_listing_id, first_product_title, first_ship_by,
             is_paid, is_shipped, etsy_created_at
      FROM receipts
      WHERE source IS NULL OR source != 'manual'
    `,
			)
			.all()
	} catch {
		return { suppressed: new Set(), survivorOf: new Map() }
	}

	return computeDuplicateSuppression(rows)
}

// ── Ship-by deadline ─────────────────────────────────────────────────────────
// Etsy gives every transaction its own expected_ship_date; an order's real
// deadline is the EARLIEST of them, because missing any one line makes the whole
// order late. The Orders page computes exactly that from the transaction list it
// renders (Math.min over expected_ship_date, falling back to first_ship_by), so
// this is the SQL twin of that rule — one definition shared by the deadline
// rollup and the ship-by sorts, so a banner, a sort and a card can never
// disagree about when an order is due.
//
// `first_ship_by` alone is not enough: it is the FIRST transaction's date, which
// on a multi-line order can be later than the earliest one.
//
// json_each() raises on malformed input, so the CASE guards it — SQLite's CASE
// short-circuits, leaving legacy or truncated rows to fall back to the column.
const SHIP_BY_DEADLINE_SQL = (alias = 'r') => {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new TypeError('Invalid SQL alias')
	return `COALESCE(
    CASE WHEN json_valid(${alias}.all_transactions)
         THEN (SELECT MIN(json_extract(t.value, '$.expected_ship_date')) FROM json_each(${alias}.all_transactions) t)
    END,
    ${alias}.first_ship_by)`
}

/** How far ahead the deadline banner looks. Beyond this nothing is "soon". */
const DEADLINE_HORIZON_SEC = 48 * 3600
/** Payload guard. Far more than any real urgent queue; see the `truncated` flag. */
const DEADLINE_MAX_ROWS = 750

/**
 * Ship-by deadlines for every order that still has to leave the warehouse and is
 * already overdue or due within DEADLINE_HORIZON_SEC.
 *
 * Deliberately DATABASE-WIDE rather than scoped to the caller's filters, exactly
 * like the ship-recovery banner: a deadline is an obligation to Etsy, and it does
 * not stop counting because the operator narrowed the view to one shop or paged
 * past it. Duplicate ghosts and non-actionable provisional receipts are excluded
 * so the count matches the orders a human can actually act on.
 *
 * Returns raw timestamps rather than counts so the page can re-derive "overdue"
 * and "due within 24h" on every tick — the banner stays exact as the clock
 * crosses a threshold, with no polling and no server round-trip.
 *
 * @param {Set<number>} suppressedDupIds  Ghost receipts already hidden from the list.
 * @returns {{ deadlines: number[], truncated: boolean }}
 */
function collectShippingDeadlines(suppressedDupIds) {
	const horizon = Math.floor(Date.now() / 1000) + DEADLINE_HORIZON_SEC
	const dupFilter = suppressedDupIds?.size ? `AND r.receipt_id NOT IN (${[...suppressedDupIds].map(Number).filter(Number.isInteger).join(',')})` : ''
	const rows = db
		.prepare(
			`SELECT ship_by FROM (
         SELECT ${SHIP_BY_DEADLINE_SQL('r')} AS ship_by
           FROM receipts r
          WHERE r.is_shipped = 0
            AND r.status NOT IN ('Canceled','Fully Refunded','Cancelled','Fully refunded')
            AND ${actionableOrderSql('r')}
            ${dupFilter}
       )
       WHERE ship_by IS NOT NULL AND ship_by <= @horizon
       ORDER BY ship_by ASC
       LIMIT @cap`,
		)
		.all({ horizon, cap: DEADLINE_MAX_ROWS + 1 })
	const deadlines = rows.map((r) => Number(r.ship_by)).filter(Number.isFinite)
	return { deadlines: deadlines.slice(0, DEADLINE_MAX_ROWS), truncated: deadlines.length > DEADLINE_MAX_ROWS }
}

/**
 * GET /api/orders
 * Paginated, filterable orders list.
 *
 * Query params:
 *   shop_id   — filter by specific shop
 *   group_id  — filter by group
 *   status    — filter by status string
 *   limit     — page size (default 50, max 200)
 *   offset    — pagination offset
 *   sort      — 'newest' (default) | 'oldest' | 'packaged_newest' | 'packaged_oldest' |
 *               'ship_by_soonest' | 'ship_by_latest' | 'express_first'
 *   shipped   — false | true | pre_transit | in_transit | needs_purchase |
 *               ready_to_pack | to_verify | recently_packaged | cancelled | issues | all
 *   purchased_cohort — today | yesterday | recent. Narrow to orders whose shopping
 *               was FINISHED in that local-day window (packer's "shopped yesterday").
 *   packaged_cohort  — today | yesterday | YYYY-MM-DD | all. Narrow Recently packaged
 *               to orders sealed on that local day (powers the day chips).
 *   purchase  — ready (fully purchased) | outstanding (still needs buying).
 *               Orthogonal to `shipped`; combine with Needs-shipping/Pre-transit
 *               to isolate "fully purchased but not yet packed" orders.
 *   np_filter — needs_purchase view only: all (default) | tobuy | onhold.
 *   packaged  — true | false (parcel physically packed flag)
 *   expedited — true | false. Narrow to orders where the buyer paid extra for a
 *               faster shipping option (Etsy `shipping_upgrade`), or to ordinary
 *               ones. Orthogonal to every other filter.
 *
 * Every order carries `shipping_upgrade` (null on ordinary orders) plus a flat
 * `is_expedited` boolean, so a consumer can badge or gate on one field.
 *
 * Response adds `np_counts` ({ all, tobuy, onhold }) on the needs_purchase view —
 * the size of every sub-filter, so the tab badge can count actionable work only.
 * On recently_packaged, response adds `packaged_days` ([{ date, count }, …], newest
 * first, full history) so the day chips stay stable as the packer clicks between them.
 */
app.get('/api/orders', async (req, res) => {
	const limit = Math.min(Math.max(parseInt(req.query.limit ?? 50, 10), 1), 5000)
	const offset = parseInt(req.query.offset ?? 0, 10)

	const conditions = []
	const params = {}

	// ── Single-order lookup ────────────────────────────────────────────────────
	// When a receipt_id is supplied (the order-number search box, or "open this
	// order" from the activity log) we resolve THAT one order and nothing else —
	// regardless of its ship/pack state or which filtered page it would fall on.
	// Parsed here; every scope/duplicate condition is discarded below so the
	// lookup can never be filtered away. Accepts negative ids (manual orders).
	const focusReceiptId = /^-?\d+$/.test(String(req.query.receipt_id ?? '')) ? parseInt(req.query.receipt_id, 10) : null

	// ── Global near-duplicate suppression ─────────────────────────────────────
	// Hide Etsy double-fire ghost receipts in EVERY view (computed across the whole
	// table, since a duplicate's surviving sibling often lives in a different tab —
	// e.g. shipped — and a per-page pass could never pair them). Excluding the ids
	// here, at the SQL level, also keeps COUNT(*) and pagination exact.
	const { suppressed: suppressedDupIds, survivorOf: dupSurvivorOf } = computeSuppressedDuplicates()
	if (suppressedDupIds.size > 0) {
		// receipt_ids are integers from our own DB — inline them directly so we are
		// never bound by SQLite's host-parameter limit.
		const idList = [...suppressedDupIds].map(Number).filter(Number.isInteger).join(',')
		conditions.push(`r.receipt_id NOT IN (${idList})`)
	}

	if (req.query.shop_id) {
		conditions.push('r.shop_id = @shop_id')
		params.shop_id = req.query.shop_id
	}
	if (req.query.status) {
		conditions.push('r.status = @status')
		params.status = req.query.status
	}

	// Etsy can emit a provisional receipt while checkout/payment is still pending.
	// Those rows are not fulfilment orders and may never appear in Etsy's Orders
	// manager (observed fingerprint: unpaid + unshipped + no ship-by date). Keep
	// them in the local mirror so a later paid twin can be reconciled by the dedup
	// engine, but never surface them as actionable Orders-tab work. This predicate
	// is deliberately based on durable fields rather than the display status text,
	// whose spelling/casing Etsy may change. A direct receipt-id lookup below still
	// overrides it for diagnostics and audit.
	conditions.push(actionableOrderSql('r'))

	// Date range filter — date strings 'YYYY-MM-DD', compared against epoch column
	if (req.query.date_from) {
		const ts = Math.floor(new Date(req.query.date_from + 'T00:00:00').getTime() / 1000)
		if (!isNaN(ts)) {
			conditions.push('r.etsy_created_at >= @date_from')
			params.date_from = ts
		}
	}
	if (req.query.date_to) {
		const ts = Math.floor(new Date(req.query.date_to + 'T23:59:59').getTime() / 1000)
		if (!isNaN(ts)) {
			conditions.push('r.etsy_created_at <= @date_to')
			params.date_to = ts
		}
	}

	// shipped filter:
	//  false        → needs shipping (unshipped, not cancelled/refunded)
	//  true         → all shipped orders
	//  pre_transit  → label created within pre_transit_days AND carrier has not yet confirmed
	//                 receipt (carrier_confirmed_at IS NULL).
	//
	//                 Precise detection via 4PX tracking API (Pass D, sync worker):
	//                 The sync worker queries 4PX's public tracking API for every unconfirmed
	//                 shipped 4PX order. If the tracking shows only "Parcel information received"
	//                 (4PX status=3), carrier_confirmed_at stays NULL → shown as Pre-transit.
	//                 Once 4PX scans/picks up the package (status=1, non-"L" category event),
	//                 carrier_confirmed_at is set → order moves to In-transit immediately.
	//
	//                 The pre_transit_days window (default 30) is the outer bound — orders
	//                 older than this are excluded even if carrier_confirmed_at is NULL, as a
	//                 safety valve against stale untracked records.
	//
	//  in_transit   → carrier confirmed (carrier_confirmed_at IS NOT NULL) OR label older than
	//                 pre_transit_days (fallback for unsupported carriers / API failures)
	//  all          → no filter
	if (req.query.shipped === 'false') {
		conditions.push("r.is_shipped = 0 AND r.status NOT IN ('Canceled','Fully Refunded','Cancelled','Fully refunded')")
	} else if (req.query.shipped === 'true') {
		conditions.push("r.is_shipped = 1 AND r.status NOT IN ('Canceled', 'Cancelled')")
	} else if (req.query.shipped === 'pre_transit') {
		const preTransitDays = config.pre_transit_days ?? 30
		const cutoff = Math.floor(Date.now() / 1000) - preTransitDays * 24 * 3600
		conditions.push(`r.is_shipped = 1
      AND r.tracking_code IS NOT NULL
      AND r.shipment_notified_at IS NOT NULL
      AND r.shipment_notified_at >= ${cutoff}
      AND r.carrier_confirmed_at IS NULL
      AND r.status NOT IN ('Canceled', 'Cancelled', 'Fully Refunded', 'Fully refunded')`)
	} else if (req.query.shipped === 'in_transit') {
		const preTransitDays = config.pre_transit_days ?? 30
		const cutoff = Math.floor(Date.now() / 1000) - preTransitDays * 24 * 3600
		conditions.push(`r.is_shipped = 1
      AND r.tracking_code IS NOT NULL
      AND r.status NOT IN ('Canceled', 'Cancelled', 'Fully Refunded', 'Fully refunded')
      AND (
        r.carrier_confirmed_at IS NOT NULL
        OR r.shipment_notified_at IS NULL
        OR r.shipment_notified_at < ${cutoff}
      )`)
	} else if (req.query.shipped === 'cancelled') {
		conditions.push("r.status IN ('Canceled', 'Cancelled')")
	} else if (req.query.shipped === 'issues') {
		// ── Fulfilment-issue queue ─────────────────────────────────────────────
		// Orders with at least one OPEN issue (a product out of production, or the
		// buyer's chosen phone model no longer offered). These are held out of the
		// purchasing Route and need an operator decision (message buyer → handle the
		// Etsy listing → resolve via swap/refund). Regardless of ship state.
		conditions.push("EXISTS (SELECT 1 FROM order_issues oi WHERE oi.receipt_id = r.receipt_id AND oi.status = 'open')")
		// Optional readability sub-filter. A cancelled/refunded order can linger in
		// this queue with an unresolved issue but is no longer actionable, so let the
		// operator isolate the live worklist ('active') from closed-out orders
		// ('cancelled'). Terminal = Etsy-cancelled OR fully refunded ("cancelled and
		// such"). Default ('all') keeps both, grouped by the ORDER BY below.
		if (req.query.issue_filter === 'active') {
			conditions.push("r.status NOT IN ('Canceled', 'Cancelled', 'Fully Refunded', 'Fully refunded')")
		} else if (req.query.issue_filter === 'cancelled') {
			conditions.push("r.status IN ('Canceled', 'Cancelled', 'Fully Refunded', 'Fully refunded')")
		}
	} else if (req.query.shipped === 'needs_purchase') {
		// ── Needs-purchase work queue ──────────────────────────────────────────
		// The actionable "still have to BUY these" list — the exact complement of the
		// Ready-to-pack queue. An order belongs here when BOTH are true:
		//   1. It still has to LEAVE the warehouse — Needs-shipping (unshipped) OR
		//      Pre-transit (a label was created early to beat the Etsy ship-by
		//      deadline, but the parcel hasn't actually entered the carrier network).
		//   2. It still has OUTSTANDING shopping work — at least one Case/Grip/Charm
		//      component is not yet Purchased, or a no-component line is still flagged
		//      to buy.
		// The order-level half (1) — plus paid-only and not-yet-packaged — comes from
		// the shared buy-queue module; the "outstanding" half (2) is applied below via
		// classifyPurchaseState (purchaseWant = 'outstanding'). Both therefore use the
		// SAME single source of truth as the "Charms to buy" shopping list opened from
		// this very tab, so the two can never disagree about what still has to be
		// bought. See src/orders/buy-queue.js for the full rule.
		conditions.push(buyQueue.needsPurchaseScopeSql(config, 'r'))
	} else if (req.query.shipped === 'ready_to_pack') {
		// ── Ready-to-pack work queue ───────────────────────────────────────────
		// The actionable "go pack & ship these" list: orders that still have to LEAVE
		// the warehouse (Needs-shipping OR Pre-transit) AND whose every product has
		// been fully purchased AND which have NOT yet been physically packaged. This
		// scope only sets the ship-state half here; the "fully purchased" half is
		// applied below via classifyPurchaseState (purchaseWant = 'ready') and the
		// "not yet packaged" half is forced via the packaged filter. Pre-transit
		// matters because a label may have been created early to beat the Etsy
		// ship-by deadline while the parcel itself was never actually packed.
		// Ship-state half (Needs-shipping OR Pre-transit) AND the exchange-hold guard
		// that keeps wrong-model-in-hand orders out of the queue until they are
		// swapped. Both come from the shared pack-queue module so this scope, the
		// packer's live count badge, and the regression test all move together.
		conditions.push(packQueue.readyToPackShipStateSql(config, 'r'))
		conditions.push(packQueue.excludeOpenExchangeSql('r'))
	} else if (req.query.shipped === 'to_verify') {
		// ── Morning verification worklist ──────────────────────────────────────
		// The packer's first task each morning: confirm the items the shopper bought
		// yesterday are physically in hand before packing. Same ship-state + exchange
		// scope as Ready-to-pack (and not yet packaged), narrowed below to orders that
		// are fully purchased but NOT yet fully verified (purchaseWant='ready' +
		// verify filter). Pair with purchased_cohort=yesterday to get exactly the
		// previous trip's orders.
		conditions.push(packQueue.readyToPackShipStateSql(config, 'r'))
		conditions.push(packQueue.excludeOpenExchangeSql('r'))
	} else if (req.query.shipped === 'recently_packaged') {
		// ── Recently-packaged review queue ─────────────────────────────────────
		// The packer's audit trail: every order physically marked as packaged
		// (packaged_at IS NOT NULL), newest first (see sort default below). Full
		// history — day chips + archive picker let the operator jump to any sealing
		// day; pagination keeps the unfiltered "All" view fast. Independent of ship
		// state: an order is often marked packaged BEFORE it is shipped, and stays
		// reviewable either way. Cancelled/refunded receipts are excluded so the list
		// stays actionable.
		conditions.push(`r.packaged_at IS NOT NULL
      AND r.status NOT IN ('Canceled', 'Cancelled', 'Fully Refunded', 'Fully refunded')`)
	}

	// ── Packaged filter ──────────────────────────────────────────────────────────
	// Operator-set flag indicating the parcel has been physically packed and is
	// ready for carrier pickup. Orthogonal to the shipped/pre-transit filter so
	// it can be combined with any view (most useful with shipped=pre_transit).
	//   packaged=true  → only orders with packaged_at IS NOT NULL
	//   packaged=false → only orders with packaged_at IS NULL (not yet packed)
	//   (omit)         → all orders regardless of packaged state
	// The Ready-to-pack queue is, by definition, the NOT-yet-packaged set, so it
	// defaults packaged=false unless the caller overrides it explicitly.
	let packagedParam = req.query.packaged
	if ((req.query.shipped === 'ready_to_pack' || req.query.shipped === 'to_verify') && packagedParam == null) packagedParam = 'false'
	if (packagedParam === 'true') {
		conditions.push('r.packaged_at IS NOT NULL')
	} else if (packagedParam === 'false') {
		conditions.push('r.packaged_at IS NULL')
	}

	// ── Express / shipping-upgrade filter ────────────────────────────────────────
	// Orthogonal to every scope above, so it composes with any view (its most
	// useful pairings are Needs-shipping and Ready-to-pack — "what did someone pay
	// to have rushed, and is it packed yet?").
	//   expedited=true  → only orders where the buyer bought a SPEED upgrade
	//   expedited=false → only ordinary-shipping orders
	//   (omit)          → all orders
	// COALESCE guards rows written before the column existed, which carry NULL
	// rather than 0 and would otherwise vanish from BOTH sides of the filter.
	if (req.query.expedited === 'true') {
		conditions.push('r.is_expedited = 1')
	} else if (req.query.expedited === 'false') {
		conditions.push('COALESCE(r.is_expedited, 0) = 0')
	}

	// ── Purchase-completion cohort filter ────────────────────────────────────────
	// Narrow to orders whose shopping was finished in a local-day window (today /
	// yesterday / recent). Lets the packer pull "the orders I shopped yesterday"
	// the next morning. Orthogonal to every other filter; see pack-queue module.
	if (req.query.purchased_cohort) {
		conditions.push(packQueue.purchasedCohortSql(req.query.purchased_cohort, 'r'))
	}

	// ── Packaged-day cohort (Recently packaged day chips) ─────────────────────
	// Day chips describe the WHOLE review window — every local day that has at
	// least one sealed parcel — so selecting Tuesday never empties Monday's chip.
	// Counts are taken from the SAME conditions that drive the list (dedup,
	// actionable, shop, rolling window), BEFORE the day cohort narrows them —
	// one source of truth, so the All chip can never disagree with `total`.
	let packagedDays = null
	if (req.query.shipped === 'recently_packaged') {
		const dayExtraWhere = conditions.length ? conditions.join(' AND ') : '1 = 1'
		try {
			packagedDays = packQueue.listPackagedDayCounts(db, {
				windowDays: 0,
				extraWhere: dayExtraWhere,
				params,
			})
		} catch (err) {
			console.error('[orders] packaged_days rollup failed:', err.message)
			packagedDays = []
		}
		const packagedCohort = String(req.query.packaged_cohort || '').trim()
		if (packagedCohort && packagedCohort !== 'all') {
			conditions.push(packQueue.packagedCohortSql(packagedCohort, 'r'))
		}
	}

	// ── Purchase-state filter ──────────────────────────────────────────────────
	// "fully purchased" (no outstanding shopping) vs "outstanding" (something still
	// to buy). This predicate depends on per-line component statuses + the binary
	// purchase flag — data that cannot be expressed in the base SQL — so we resolve
	// it against the CURRENT scope: take every receipt matching the conditions
	// above, classify it with the same logic the rest of the app uses, then narrow
	// the query to just the wanted receipt_ids. Doing it as an extra WHERE clause
	// (rather than a post-query JS filter) keeps pagination + COUNT(*) exact.
	//
	//   purchase=ready        → fully purchased
	//   purchase=outstanding  → still needs buying
	//   shipped=ready_to_pack → implies purchase=ready
	let purchaseWant = null
	// Need-to-purchase sub-filter sizes, attached to the response for the tab's
	// count badge (see below). Stays null for every other view.
	let npCounts = null
	if (req.query.purchase === 'ready' || req.query.purchase === 'outstanding') {
		purchaseWant = req.query.purchase
	}
	if (req.query.shipped === 'ready_to_pack') purchaseWant = 'ready'
	// The morning verification worklist is the fully-purchased half of its scope.
	if (req.query.shipped === 'to_verify') purchaseWant = 'ready'
	// The Needs-purchase view is, by definition, the OUTSTANDING half of the
	// Needs-shipping + Pre-transit (+ explicitly-flagged) scope set above.
	if (req.query.shipped === 'needs_purchase') purchaseWant = 'outstanding'

	if (purchaseWant) {
		// An order with an OPEN fulfilment issue (a product out of production, or the
		// buyer's chosen phone model no longer offered) is ON HOLD: it awaits an owner
		// decision (message buyer → swap/refund) and cannot be PACKED. The packing
		// queues (ready_to_pack / to_verify) and the owner's purchase filters therefore
		// still exclude on-hold orders entirely.
		//
		// The Needs-purchase PACKER view is the deliberate exception: it now INCLUDES
		// on-hold orders so a packer can see and reconcile the in-hand (already-bought)
		// products of a PARTIALLY blocked multi-product order — e.g. 2 cases in hand
		// while a 3rd is out of production. (Previously such an order vanished from the
		// buy queue even though it still had buyable/verifiable lines.)
		const npView = req.query.shipped === 'needs_purchase'
		if (!npView) {
			conditions.push("NOT EXISTS (SELECT 1 FROM order_issues oi WHERE oi.receipt_id = r.receipt_id AND oi.status = 'open')")
		}
		const baseWhere = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
		const candidates = db.prepare(`SELECT r.receipt_id, r.all_transactions FROM receipts r ${baseWhere}`).all(params)
		const { ready, outstanding, verified, onHold } = classifyPurchaseState(candidates)
		let keep = purchaseWant === 'ready' ? ready : outstanding
		// Verification narrowing:
		//   • to_verify view          → fully purchased but NOT yet verified (worklist).
		//   • ready_to_pack + gate on → only VERIFIED orders are packable.
		if (req.query.shipped === 'to_verify') {
			keep = new Set([...ready].filter((id) => !verified.has(id)))
		} else if (req.query.shipped === 'ready_to_pack' && packQueue.requireVerifyBeforePack(config)) {
			keep = new Set([...ready].filter((id) => verified.has(id)))
		} else if (npView) {
			// Segmented sub-filter (np_filter): all (default) | tobuy | onhold. The
			// rule lives in the shared buy-queue module so the "Charms to buy" list
			// resolves the exact same order set this tab is showing.
			keep = buyQueue.resolveNeedsPurchaseSet({ outstanding, onHold }, String(req.query.np_filter || 'all'))
			// Size of ALL THREE sub-filters, from this same classification pass — free
			// (the sets are already in memory) and therefore guaranteed to agree with
			// the list. Lets the tab's count badge report actionable work only, and
			// still explain the difference against what is on screen, in ONE request.
			npCounts = buyQueue.needsPurchaseBreakdown({ outstanding, onHold })
		}
		if (keep.size === 0) {
			conditions.push('1 = 0') // no receipt qualifies → empty page (count stays 0)
		} else {
			// receipt_ids are integers from our own DB — inline them directly so we are
			// never bound by SQLite's host-parameter limit on a large queue.
			const idList = [...keep].map(Number).filter(Number.isInteger).join(',')
			conditions.push(`r.receipt_id IN (${idList})`)
		}
	}

	// A direct order-number lookup overrides every scope/duplicate filter gathered
	// above so the requested order ALWAYS resolves — even if it is shipped,
	// cancelled, de-duplicated, or would otherwise sit on a later page.
	if (focusReceiptId != null) {
		conditions.length = 0
		for (const k of Object.keys(params)) delete params[k]
		conditions.push('r.receipt_id = @focus_receipt_id')
		params.focus_receipt_id = focusReceiptId
	}

	const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

	const sortMap = {
		newest: 'r.etsy_created_at DESC',
		oldest: 'r.etsy_created_at ASC',
		// Order by the moment the parcel was physically packed. SQLite sorts NULLs
		// last for DESC, so never-packaged orders fall to the bottom when this sort
		// is used on a mixed scope. The Recently-packaged scope is packaged-only.
		packaged_newest: 'r.packaged_at DESC',
		packaged_oldest: 'r.packaged_at ASC',
		// Deadline order — what the ship-by banner jumps to. Orders with no
		// deadline sort last in both directions (they are never urgent), so the top
		// of the list is always the work with the least time left on it.
		ship_by_soonest: `${SHIP_BY_DEADLINE_SQL('r')} IS NULL, ${SHIP_BY_DEADLINE_SQL('r')} ASC`,
		ship_by_latest: `${SHIP_BY_DEADLINE_SQL('r')} IS NULL, ${SHIP_BY_DEADLINE_SQL('r')} DESC`,
		// Express-first triage. The buyer paid a separate fee for SPEED, so on any
		// working queue those parcels are picked, packed and handed over ahead of
		// standard ones. Ties break on the ship-by deadline (soonest first) so the
		// express block is itself ordered by urgency rather than arbitrarily, and
		// the standard block below it keeps the same deadline discipline.
		// COALESCE keeps pre-migration rows (NULL) sorting with the standard block.
		express_first: `COALESCE(r.is_expedited, 0) DESC, ${SHIP_BY_DEADLINE_SQL('r')} IS NULL, ${SHIP_BY_DEADLINE_SQL('r')} ASC`,
	}
	// The Recently-packaged review queue is chronological by packing time by
	// definition ("what did I just seal?"), so it defaults to packaged_at DESC
	// unless the caller asks for an explicit, supported sort.
	const defaultSort = req.query.shipped === 'recently_packaged' ? 'packaged_newest' : 'newest'
	const orderBy = sortMap[req.query.sort] ?? sortMap[defaultSort]

	// In the Issues / on-hold view, terminal orders (Etsy-cancelled or fully
	// refunded) are no longer actionable but can linger with an unresolved issue.
	// Sink them below the live, still-actionable orders so the worklist stays
	// readable, while preserving the caller's chronological sort WITHIN each group.
	// Done in SQL so the grouping is stable across paginated pages. No effect on the
	// 'active'/'cancelled' sub-filters (each is homogeneous) or any other view.
	const issuesGrouping = req.query.shipped === 'issues' ? "CASE WHEN r.status IN ('Canceled', 'Cancelled', 'Fully Refunded', 'Fully refunded') THEN 1 ELSE 0 END, " : ''

	const rows = db
		.prepare(
			`
    SELECT
      r.receipt_id,
      r.shop_id,
      r.group_id,
      s.shop_name,
      r.buyer_user_id,
      r.name                AS buyer_name,
      r.buyer_email,
      r.status,
      r.is_paid,
      r.is_shipped,
      r.grandtotal_amount,
      r.grandtotal_currency,
      r.subtotal_amount,
      r.shipping_country_iso  AS country_iso_raw,
      r.shipping_first_line,
      r.shipping_second_line,
      r.shipping_city,
      r.shipping_state,
      r.shipping_zip,
      r.shipping_country_iso,
      r.first_product_title,
      r.first_listing_id,
      r.first_quantity,
      r.first_ship_by,
      r.first_variations,
      r.all_transactions,
      r.formatted_address,
      r.message_from_buyer,
      r.team_note,
      r.tracking_code,
      r.carrier_name,
      r.shipment_was_shipped,
      r.shipment_notified_at,
      r.carrier_confirmed_at,
      r.needs_purchase_at,
      r.needs_purchase_note,
      r.packaged_at,
      -- Paid shipping upgrade, straight from Etsy's per-transaction
      -- shipping_upgrade field (rolled up per receipt at sync time). Projected by
      -- the module that reads it back, so the aliases can never drift.
      ${shippingUpgrade.selectSql('r')},
      li.url                AS product_image_url,
      r.etsy_created_at,
      r.etsy_updated_at,
      r.synced_at,
      r.fourpx_consignment_no,
      r.fourpx_tracking_no,
      r.fourpx_label_url,
      r.fourpx_order_status,
      r.fourpx_created_at,
      r.fourpx_freight_amount,
      r.fourpx_freight_currency,
      r.fourpx_billed_weight_g,
      r.fourpx_freight_breakdown,
      r.fourpx_freight_status,
      r.fourpx_freight_fetched_at,
      r.source
    FROM receipts r
    JOIN shops s ON s.shop_id = r.shop_id
    LEFT JOIN listing_images li ON li.listing_id = r.first_listing_id
    ${where}
    ORDER BY ${issuesGrouping}${orderBy}
    LIMIT @limit OFFSET @offset
  `,
		)
		.all({ ...params, limit, offset })

	const countRow = db
		.prepare(
			`
    SELECT COUNT(*) AS total FROM receipts r ${where}
  `,
		)
		.get(params)

	// Collect all listing IDs across every transaction in the result set,
	// then fetch their cached image URLs in one query.
	const allListingIds = new Set()
	for (const r of rows) {
		if (r.first_listing_id) allListingIds.add(r.first_listing_id)
		try {
			const txs = JSON.parse(r.all_transactions || '[]')
			for (const t of txs) if (t.listing_id) allListingIds.add(t.listing_id)
		} catch {}
	}
	const imageMap = {}
	if (allListingIds.size > 0) {
		const placeholders = [...allListingIds].map(() => '?').join(',')
		db.prepare(`SELECT listing_id, url FROM listing_images WHERE listing_id IN (${placeholders})`)
			.all([...allListingIds])
			.forEach((row) => {
				imageMap[row.listing_id] = row.url
			})
	}
	// Operator-supplied per-variant clarifying images, keyed by
	// `${listing_id}\x00${style_key}`. These override the ambiguous listing hero
	// shot for a specific style (e.g. show the grip for a "Grip 3 Only" line).
	const styleImageMap = getListingStyleImageMap(db, allListingIds)
	const variationImageMap = getListingVariationImageMap(db, allListingIds)

	// Per-line purchase state for the page's receipts, so the Orders tab can show a
	// purchasing control per product — and, when a product is a Case/Grip/Charm style,
	// per COMPONENT (e.g. case bought, grip still to buy). The COMPONENT statuses live in
	// route_assignments (the SAME table the Route tab edits), so the two tabs stay in
	// perfect sync. For products with no recognised components we fall back to the binary
	// receipt_item_purchase flag.
	const purchaseByReceipt = {} // receipt_id → item_key → needs_purchase (0/1)  (no-component lines)
	const ripVerifiedByReceipt = {} // receipt_id → item_key → verified_at (no-component lines)
	const raByReceipt = {} // receipt_id → item_key → { status_case, status_grip, status_charm, charm_code, charm_shop, verified_at }
	const issuesByReceipt = {} // receipt_id → item_key → issue row (fulfilment exceptions)
	const exchangesByReceipt = {} // receipt_id → item_key → exchange row (wrong-model swaps)
	const substitutionsByReceipt = {} // receipt_id → item_key → substitution row (design switches)
	// ── Charm resolution maps (for the "which charm to buy" detail on outstanding
	// charm lines) ─────────────────────────────────────────────────────────────
	// Built once per request and reused for every line. They mirror the SAME
	// confirmed-charm priority chain the Route tab / shopping route use
	// (route_assignments → product_assignments), so the packer's buy detail can
	// never disagree with the Route. Best-effort: any failure leaves charms with a
	// plain status chip and never breaks the orders list.
	const productCharmByKey = {} // item_key → { charm_code, charm_shop }  (per-product default)
	const charmShopByCode = new Map() // charm code → supplier shop  (charm library = source of truth)
	const charmStallByShop = new Map() // lower(shop_name) → stall  (where to buy)
	let charmImgVerMap = new Map() // charm_code → image version token (cache-bust)
	if (rows.length > 0) {
		const ridList = rows.map((r) => r.receipt_id)
		const ph = ridList.map(() => '?').join(',')
		db.prepare(`SELECT receipt_id, item_key, needs_purchase, verified_at FROM receipt_item_purchase WHERE receipt_id IN (${ph})`)
			.all(ridList)
			.forEach((row) => {
				;(purchaseByReceipt[row.receipt_id] ||= {})[row.item_key] = row.needs_purchase
				;(ripVerifiedByReceipt[row.receipt_id] ||= {})[row.item_key] = row.verified_at
			})
		db.prepare(`SELECT receipt_id, item_key, status_case, status_grip, status_charm, charm_code, charm_shop, verified_at FROM route_assignments WHERE receipt_id IN (${ph})`)
			.all(ridList)
			.forEach((row) => {
				;(raByReceipt[row.receipt_id] ||= {})[row.item_key] = row
			})
		// Per-product charm defaults + charm-shop → stall directory + charm image
		// versions. All small/bounded and wrapped so a charm-catalog hiccup can
		// never take down the orders list.
		try {
			db.prepare('SELECT item_key, charm_code, charm_shop FROM product_assignments')
				.all()
				.forEach((a) => {
					productCharmByKey[a.item_key] = { charm_code: a.charm_code || '', charm_shop: a.charm_shop || '' }
				})
		} catch {}
		// Charm library = single source of truth for a charm code → its supplier shop.
		// Assignments only cache the shop from when the charm was assigned, so we
		// resolve the shop from the library by code (below) to stay in lockstep with
		// Manage-charms edits, exactly like buildRouteRows / the Route tab.
		try {
			getCharmLibrary(db).forEach((c) => charmShopByCode.set(c.code, c.default_charm_shop || ''))
		} catch {}
		try {
			getCharmShopDirectory(db).forEach((c) => {
				const k = String(c.shop_name || '')
					.trim()
					.toLowerCase()
				if (k && !charmStallByShop.has(k)) charmStallByShop.set(k, c.stall || '')
			})
		} catch {}
		try {
			charmImgVerMap = charmLibrary.charmImageVersionMap(db, config)
		} catch {}
		// Fulfilment issues (out of production / model unavailable) for the page.
		const issuesByRid = getIssuesForReceipts(db, ridList)
		for (const rid of Object.keys(issuesByRid)) {
			for (const iss of issuesByRid[rid]) {
				;(issuesByReceipt[rid] ||= {})[iss.item_key] = iss
			}
		}
		// Wrong-model exchanges (item in hand, wrong model — swap at the supplier).
		const exchByRid = getExchangesForReceipts(db, ridList)
		for (const rid of Object.keys(exchByRid)) {
			for (const ex of exchByRid[rid]) {
				;(exchangesByReceipt[rid] ||= {})[ex.item_key] = ex
			}
		}
		// Local design switches (buyer agreed to switch to another design). These
		// override what we RENDER + PURCHASE for the line; Etsy is never touched.
		const subsByRid = getSubstitutionsForReceipts(db, ridList)
		for (const rid of Object.keys(subsByRid)) {
			for (const s of subsByRid[rid]) {
				;(substitutionsByReceipt[rid] ||= {})[s.item_key] = s
			}
		}
		// A CATALOG design switch points at a DIFFERENT listing than the one the
		// buyer ordered, so its thumbnail isn't in the imageMap built above (which
		// only covers ordered lines). Load the replacement listings' cached images
		// too, so a switched line can render the REPLACEMENT design's photo instead
		// of falling back to the original design (the "same old case" bug). Best-
		// effort and de-duped; failures leave the line to its own stored image_url.
		const subListingIds = new Set()
		for (const rid of Object.keys(substitutionsByReceipt)) {
			for (const ik of Object.keys(substitutionsByReceipt[rid])) {
				const s = substitutionsByReceipt[rid][ik]
				if (s && s.source_listing_id != null && !(s.source_listing_id in imageMap)) subListingIds.add(Number(s.source_listing_id))
			}
		}
		if (subListingIds.size > 0) {
			const subPh = [...subListingIds].map(() => '?').join(',')
			try {
				db.prepare(`SELECT listing_id, url FROM listing_images WHERE listing_id IN (${subPh}) AND url IS NOT NULL AND url <> ''`)
					.all([...subListingIds])
					.forEach((row) => {
						if (!(row.listing_id in imageMap)) imageMap[row.listing_id] = row.url
					})
			} catch {}
			const stillMissing = [...subListingIds].filter((id) => !(id in imageMap))
			if (stillMissing.length > 0) {
				const mPh = stillMissing.map(() => '?').join(',')
				try {
					db.prepare(`SELECT listing_id, primary_image_url FROM listings WHERE listing_id IN (${mPh}) AND primary_image_url IS NOT NULL AND primary_image_url <> ''`)
						.all(stillMissing)
						.forEach((row) => {
							if (!(row.listing_id in imageMap)) imageMap[row.listing_id] = row.primary_image_url
						})
				} catch {}
			}
		}
	}
	const PURCHASE_OUTSTANDING = new Set(['Pending', 'Out of Stock', 'Wrong Stall'])

	// Canonical line identity for every receipt on the page, loaded in ONE query.
	// A Route-tab manual order names its lines with a per-variant key (so the same
	// listing in two models stays two lines); resolving through this is what keeps
	// the component chips below reading the very rows Shopping Mode wrote.
	const lineKeys = lineIdentity.lineKeyResolver(
		db,
		rows.map((r) => r.receipt_id),
	)

	// Warm the rate table if boot's refresh has not landed yet. Without this, the
	// first orders payload after a restart carries customs_declaration.amount = null
	// and every employee bench shows a blank "declare in GBP".
	if (!Object.keys(rateStore.snapshot().rates).length) {
		try {
			await rateStore.get()
		} catch (err) {
			console.warn('[orders] exchange rates unavailable:', err.message)
		}
	}
	const rateSnap = rateStore.snapshot()

	const enriched = rows.map((r) => {
		let transactions = []
		try {
			transactions = JSON.parse(r.all_transactions || '[]')
		} catch {}
		const itemStates = purchaseByReceipt[r.receipt_id] || {}
		const raStates = raByReceipt[r.receipt_id] || {}
		const issueStates = issuesByReceipt[r.receipt_id] || {}
		const exchangeStates = exchangesByReceipt[r.receipt_id] || {}
		const subStates = substitutionsByReceipt[r.receipt_id] || {}
		const hasItemRows = Object.keys(itemStates).length > 0
		// Inject cached image URL + per-line purchase state into each transaction:
		//   • components[]   — present Case/Grip/Charm with their current status (from
		//                      route_assignments; default 'Pending'). Shown as per-component
		//                      chips so the operator can mark case bought / grip still to buy.
		//   • needs_purchase — binary fallback for products with NO components.
		//   • line_outstanding — true while this line still has something to buy.
		const lineKeysForOrder = lineKeys.keysFor(r.receipt_id, transactions)
		const transactionsWithImages = transactions.map((t, txIndex) => {
			const itemKey = lineKeysForOrder[txIndex]
			// A local design switch overrides what we render + purchase for this
			// line. The style drives which Case/Grip/Charm chips appear, so we use
			// the switched style when one is set (never touches Etsy).
			const sub = subStates[itemKey] || null
			const { style: origStyle, phoneModel: origModel } = routeDashboard.parseVariations(t.variations)
			const style = sub && sub.new_style ? sub.new_style : origStyle
			// The effective title/model also decide the line's device family, which
			// names its primary unit ("Case" on a phone line, "Band" on a watch one)
			// and lets a single-axis line — whose style says nothing — still declare
			// the one unit it has to buy.
			const lineTitle = (sub && sub.new_title) || t.title || ''
			const lineModel = (sub && sub.new_phone_model) || origModel || ''
			const lineDeviceFamily = deviceFamilyOf(lineModel, lineTitle)
			const sc = routeDashboard.styleComponents(style, { phoneModel: lineModel, title: lineTitle })
			const primaryLabel = primaryComponentLabel(lineDeviceFamily)
			const a = raStates[itemKey] || {}
			const components = []
			if (sc.hasCase) components.push({ comp: 'case', label: primaryLabel, status: a.status_case || 'Pending' })
			if (sc.hasGrip) components.push({ comp: 'grip', label: 'Grip', status: a.status_grip || 'Pending' })
			if (sc.hasCharm) {
				// Attach the CONFIRMED charm assignment (never suggestions) so the buy
				// queue can show exactly which charm to source, and where. Same chain
				// the Route tab uses: per-order save → per-product default. On a
				// SWITCHED line the per-product default must come from the REPLACEMENT
				// design — not the original line's key, which still holds the original
				// product's charm — so it stays in lockstep with the Route tab and
				// buildRouteRows (see routeDashboard.productDefaultsKey).
				const pdKey = routeDashboard.productDefaultsKey(itemKey, sub)
				const pd = (pdKey && productCharmByKey[pdKey]) || {}
				const charmCode = (a.charm_code || pd.charm_code || '').trim()
				// Supplier shop follows the CODE via the charm library (source of truth);
				// the per-order/per-product snapshot is only a fallback for a code the
				// library doesn't know, so a Manage-charms supplier edit shows up here too.
				const charmShop = (charmCode && charmShopByCode.has(charmCode) ? charmShopByCode.get(charmCode) : a.charm_shop || pd.charm_shop || '').trim()
				const charmStall = charmShop ? charmStallByShop.get(charmShop.toLowerCase()) || '' : ''
				components.push({
					comp: 'charm',
					label: 'Charm',
					status: a.status_charm || 'Pending',
					charm_code: charmCode,
					charm_shop: charmShop,
					charm_stall: charmStall,
					charm_floor: charmStall && routeDashboard.stallFloor ? routeDashboard.stallFloor(charmStall) : null,
					charm_image_version: charmCode ? charmImgVerMap.get(charmCode) || '' : '',
					has_charm_image: charmCode ? charmImgVerMap.has(charmCode) : false,
				})
			}

			const raw = itemStates[itemKey]
			const needsPurchase = raw != null ? raw === 1 : !hasItemRows && r.needs_purchase_at ? true : false
			const purchased = raw === 0
			// A line with an OPEN fulfilment issue is held out of purchasing entirely
			// (it's pending a buyer swap/refund decision), so it is never "outstanding"
			// — UNLESS a more recent design switch supersedes the hold, in which case
			// the replacement is buyable and the line IS outstanding again. Same rule
			// the route builder enforces, so Orders counts and the route never disagree.
			const issue = issueStates[itemKey] || null
			const issueOpen = !!(issue && issue.status === 'open') && !routeDashboard.substitutionSupersedesIssue(sub, issue)
			// A line with an OPEN wrong-model exchange holds ONLY the generation-
			// specific piece (the case on iPhone; the case + attached charm on
			// AirPods) in hand — that piece is not "outstanding to buy". But any
			// grip / separately-sourced charm on the SAME line still must be bought,
			// so the line stays outstanding while those pieces are unbought (a case-
			// only swap on a Case+Grip+Charm iPhone line must NOT mark the whole
			// line done).
			const exchange = exchangeStates[itemKey] || null
			const exchangeOpen = !!(exchange && exchange.status === 'open')
			const lineCharmIntegral = !!(sc.hasCharm && routeDashboard.isAirpodsProduct(lineModel, lineTitle))
			const exchangeHeld = exchangeOpen
				? routeDashboard.exchangeHeldComponents({
						needs_exchange: true,
						exchange_components: exchange.components,
						exchange_have_model: exchange.have_model,
						has_case: sc.hasCase,
						has_grip: sc.hasGrip,
						has_charm: sc.hasCharm,
						charm_integral: lineCharmIntegral,
						phone_model: lineModel,
						title: lineTitle,
					})
				: null
			const lineOutstanding = issueOpen ? false : components.length ? components.some((c) => !(exchangeHeld && exchangeHeld.has(c.comp)) && PURCHASE_OUTSTANDING.has(c.status)) : exchangeOpen ? false : needsPurchase
			// "In hand" — we physically have (part or all of) this product AND it is
			// not blocked (no open issue / exchange). A partially-bought line counts:
			// if the case is purchased but the charm is still pending, we DO hold a
			// case to reconcile. This is what a packer verifies on an order that is
			// otherwise on hold because a DIFFERENT line is unavailable.
			const anyCompPurchased = components.length > 0 && components.some((c) => c.status === 'Purchased')
			const inHand = !issueOpen && !exchangeOpen && (components.length ? anyCompPurchased : purchased)
			// Packer VERIFICATION stamp for this line (confirmed physically in hand),
			// read from the store that backs the line (route_assignments for component
			// lines, receipt_item_purchase for no-component lines).
			const lineVerified = components.length ? !!a.verified_at : !!(ripVerifiedByReceipt[r.receipt_id] || {})[itemKey]

			// A per-variant clarifying image (operator upload for this listing +
			// original style) overrides the ambiguous listing hero shot — but only
			// when the line hasn't been switched to another design (a switch is a
			// different product and carries its own image, which always wins).
			const styleImg = t.listing_id ? lookupStyleKeyed(styleImageMap, t.listing_id, origStyle) : null
			// The Etsy photo for the exact Styles value the buyer bought — matched
			// on the transaction's value_id, so a renamed style still resolves.
			const variationImg = t.listing_id
				? lookupVariationImage(variationImageMap, t.listing_id, {
						valueId: parseStyleValueId(t.variations),
						style: origStyle,
					})
				: null

			// The switched-design image. Resolved by the SAME function the route
			// builder uses, so the Orders tab and the shopping floor can never
			// disagree about which design a switched line shows.
			const subImageUrl = resolveSwitchedLineImage(sub, (id) => imageMap[id] || null)

			// Image priority: design switch → operator Fix Image → Etsy style
			// variation photo → listing hero. The variation photo is what the
			// buyer saw for "Case 1 + Grip 1" on the listing page.
			let imageUrl
			if (sub) {
				imageUrl = subImageUrl
			} else {
				imageUrl = resolveUnswitchedLineImage({
					styleImg,
					variationUrl: variationImg?.url || null,
					listingUrl: t.listing_id ? (imageMap[t.listing_id] ?? null) : null,
				})
			}

			return {
				...t,
				image_url: imageUrl,
				// Present when a per-variant clarifying image exists for this line's
				// listing + style, so the UI can badge the thumbnail and offer revert.
				style_image_id: styleImg ? styleImg.id : null,
				item_key: itemKey,
				// Resolved fulfilment identity — authoritative for model-fix UI (never
				// re-parse variations client-side; honours design switches).
				phone_model: lineModel,
				device_family: lineDeviceFamily,
				charm_integral: lineCharmIntegral,
				components,
				needs_purchase: needsPurchase,
				purchased,
				line_outstanding: lineOutstanding,
				// Physically bought & unblocked → a packer can verify it in hand even on
				// an otherwise-on-hold order (inventory reconciliation).
				in_hand: inHand,
				// Whether a packer has confirmed this specific line is in hand.
				verified: lineVerified,
				// Local design switch (buyer agreed to switch to another design).
				// The UI shows the replacement product + a "switched from" note; the
				// original Etsy title is preserved for reference. Etsy is untouched.
				substitution: sub
					? {
							id: sub.id,
							new_title: sub.new_title,
							new_style: sub.new_style,
							new_phone_model: sub.new_phone_model,
							source: sub.source,
							image_url: subImageUrl,
							original_title: sub.original_title || t.title || '',
							note: sub.note || '',
							created_at: sub.created_at,
							// Last time the switch was asserted — the UI compares this
							// against the issue's updated_at (same rule the route uses) to
							// decide whether the switch supersedes a stale on-hold flag.
							updated_at: sub.updated_at,
						}
					: null,
				issue: issue
					? {
							id: issue.id,
							issue_type: issue.issue_type,
							status: issue.status,
							// Authoritative "is this line currently held out of purchasing?"
							// flag — an open issue NOT superseded by a newer design switch.
							// The UI reads this (never re-deriving the rule) so the on-hold
							// chip/badge and the purchasing route always agree.
							on_hold: issueOpen,
							phone_model: issue.phone_model,
							note: issue.note,
							buyer_notified_at: issue.buyer_notified_at,
							listing_handled_at: issue.listing_handled_at,
							listing_action: issue.listing_action,
							resolution: issue.resolution,
							resolved_at: issue.resolved_at,
							// Last time the hold was (re-)raised — see substitution.updated_at.
							updated_at: issue.updated_at,
						}
					: null,
				exchange: exchange
					? {
							id: exchange.id,
							status: exchange.status,
							have_model: exchange.have_model,
							need_model: exchange.need_model,
							components: exchange.components,
							supplier_shop: exchange.supplier_shop,
							supplier_stall: exchange.supplier_stall,
							note: exchange.note,
							done_at: exchange.done_at,
						}
					: null,
			}
		})
		const needsPurchaseItems = transactionsWithImages.filter((t) => t.line_outstanding).length
		const openIssues = transactionsWithImages.filter((t) => t.issue && t.issue.status === 'open').length
		const openExchanges = transactionsWithImages.filter((t) => t.exchange && t.exchange.status === 'open').length
		// How many line-items are physically in hand (any component purchased +
		// unblocked) vs genuinely on hold — powers the "N in hand · M on hold"
		// reconciliation chip so a packer can see a partially-blocked order's
		// verifiable stock. on_hold uses the superseded-aware `issue.on_hold`, so a
		// switched line whose old issue is superseded is NOT counted as on hold.
		const inHandItems = transactionsWithImages.filter((t) => t.in_hand).length
		const verifiedItems = transactionsWithImages.filter((t) => t.in_hand && t.verified).length
		const onHoldItems = transactionsWithImages.filter((t) => t.issue && t.issue.on_hold).length

		// `orders:read` is an operational permission, not a finance permission.
		// Keep the order/fulfilment shape intact for employees while removing the
		// same revenue fields that /api/summary already strips server-side.
		const visibleReceipt = { ...r }
		if (!req.auth || req.auth.role !== 'owner') {
			delete visibleReceipt.grandtotal_amount
			delete visibleReceipt.grandtotal_currency
			delete visibleReceipt.subtotal_amount
		}
		// The paid shipping upgrade travels as ONE shaped object (or null), never as
		// loose columns, so a consumer cannot half-read it — e.g. see a tier but
		// miss the expedited flag the filter and the sort actually key on.
		// Deliberately NOT a finance field: what the buyer paid is stripped above,
		// but "this parcel was bought as Express" is a fulfilment instruction every
		// packer must see, so it stays on the employee payload.
		const upgrade = shippingUpgrade.shapeForApi(r, transactions)
		for (const f of shippingUpgrade.API_INTERNAL_FIELDS) delete visibleReceipt[f]

		// Customs figure the packer writes on the form. Converted here, while we
		// still have the shop-currency subtotal: employees never receive that
		// subtotal (it is revenue), so a browser-side conversion always produces
		// a blank amount on their bench. The destination-currency number is an
		// operational instruction, not a finance field.
		const customsDeclaration = customsDeclarationForReceipt(r, rateSnap)

		return {
			...visibleReceipt,
			customs_declaration: customsDeclaration,
			// null on ordinary orders; { name, method, tier, label, expedited,
			// lines, upgradedLines } when the buyer paid to upgrade shipping.
			shipping_upgrade: upgrade,
			// Flattened so the card, the 4PX drawer and any future consumer can gate
			// on one boolean without null-checking the object first. Mirrors the
			// is_expedited column the SQL filter and sort read.
			is_expedited: !!(upgrade && upgrade.expedited),
			transactions: transactionsWithImages,
			needs_purchase_items: needsPurchaseItems,
			open_issues: openIssues,
			open_exchanges: openExchanges,
			in_hand_items: inHandItems,
			verified_items: verifiedItems,
			on_hold_items: onHoldItems,
			purchasable_items: transactionsWithImages.length,
			// Pre-shaped 4PX shipping cost so the UI can render it without re-parsing
			// the breakdown JSON column. status: 'none' | 'pending' | 'billed' | 'error'.
			freight: shapeFreight(r),
			created_at_iso: r.etsy_created_at ? new Date(r.etsy_created_at * 1000).toISOString() : null,
			updated_at_iso: r.etsy_updated_at ? new Date(r.etsy_updated_at * 1000).toISOString() : null,
			synced_at_iso: r.synced_at ? new Date(r.synced_at * 1000).toISOString() : null,
			ship_by_iso: r.first_ship_by ? new Date(r.first_ship_by * 1000).toISOString() : null,
			shipping_country_iso: r.shipping_country_iso,
		}
	})

	// ── Near-duplicate annotation ─────────────────────────────────────────────
	// Etsy double-fire ghost receipts have ALREADY been excluded at the SQL level
	// (see computeDuplicateSuppression above), so the page never contains both a
	// survivor and its ghost and COUNT(*) is already exact. Here we only annotate
	// any surviving row that absorbed one or more duplicates, so the UI can surface
	// the hidden receipt_ids for audit/debugging — no second row is ever rendered.
	for (const o of enriched) {
		const absorbed = dupSurvivorOf.get(o.receipt_id)
		if (absorbed && absorbed.length) {
			o.had_duplicate = true
			o.duplicate_receipt_ids = absorbed
		}
	}

	// ── Etsy-completion state ─────────────────────────────────────────────────
	// An order can hold a real, paid 4PX label and still be unshipped on Etsy —
	// the half-finished state that used to leave it stuck in Needs-shipping with
	// no explanation. The ledger knows whether that gap is being retried, or has
	// given up and needs a human, so the card can say which instead of looking
	// like an ordinary un-actioned order. Null on every healthy order.
	let etsyCompletionPending = 0
	try {
		const intents = etsyCompletion.getIntents(
			db,
			enriched.map((o) => o.receipt_id),
		)
		const nowSec = Math.floor(Date.now() / 1000)
		for (const o of enriched) {
			const shaped = o.is_shipped ? null : etsyCompletion.shapeForApi(intents.get(o.receipt_id), nowSec)
			if (shaped) o.etsy_completion = shaped
		}
		etsyCompletionPending = etsyCompletion.countStranded(db, { now: nowSec })
	} catch (err) {
		// Diagnostics must never take down the orders list.
		console.error('[orders] etsy-completion annotation failed:', err.message)
	}

	// ── Ship-by deadline rollup ───────────────────────────────────────────────
	// Timestamps, not counts, so the page can keep the banner exact as the clock
	// runs (see collectShippingDeadlines). Never fatal to the list.
	let shippingDeadlines = { deadlines: [], truncated: false }
	try {
		shippingDeadlines = collectShippingDeadlines(suppressedDupIds)
	} catch (err) {
		console.error('[orders] ship-by deadline rollup failed:', err.message)
	}

	res.json({
		total: countRow.total,
		limit,
		offset,
		pre_transit_days: config.pre_transit_days ?? 30,
		tracking_edit_days: config.tracking_edit_days ?? 3,
		recently_packaged_days: config.recently_packaged_days ?? 7,
		// Whether verification is a REQUIRED stage before packing. Drives the packer
		// UI: when on, "To pack & ship" shows verified-only and the "Verify purchases"
		// worklist is a distinct upstream stage; when off, verification isn't gating,
		// so the redundant "Verify purchases" tab is hidden entirely (see fetchOrders).
		require_verify_before_pack: packQueue.requireVerifyBeforePack(config),
		// Orders held out of the packing queue solely because they still owe a
		// wrong-model supplier swap. Surfaced on every /api/orders response (cheap,
		// single indexed COUNT) so the packing screen can reassure the operator that
		// these were set aside on purpose — not silently lost. Filter-independent by
		// design: the chip reflects the global hold, not the current page's scope.
		exchange_hold_count: packQueue.openExchangeHoldCount(db, config),
		// Need-to-purchase view only: how the queue splits across the All / To buy /
		// On hold sub-filters ({ all, tobuy, onhold }, where all === tobuy + onhold).
		// `total` above is the count for the sub-filter actually requested; this is
		// the whole queue, so the tab badge can show the actionable figure (tobuy)
		// and still reconcile it against the rows on screen.
		...(npCounts ? { np_counts: npCounts } : {}),
		// Recently-packaged view only: local-day breakdown of every sealed parcel
		// ({ date: 'YYYY-MM-DD', count }[], newest first). Independent of the
		// selected day so the chips stay put as the packer clicks between them.
		...(packagedDays ? { packaged_days: packagedDays } : {}),
		// How many orders across the WHOLE database still owe Etsy a completion for
		// a 4PX label already paid for, counting only those the fast path has
		// already missed (see etsy-completion.isStranded) so an ordinary shipment
		// in flight never trips it. Any non-zero value is a real, visible problem —
		// every one of those is a live late shipment — so the Needs-shipping view
		// surfaces it as a banner with a "finish them now" action.
		etsy_completion_pending: etsyCompletionPending,
		// Ship-by deadlines (Unix seconds, ascending) for every unshipped order that
		// is overdue or due within the next 48 hours — database-wide, so paging or
		// filtering can never hide a deadline that is about to be missed. The page
		// derives its own counts from these and re-derives them every second.
		shipping_deadlines: shippingDeadlines.deadlines,
		shipping_deadlines_truncated: shippingDeadlines.truncated,
		orders: enriched,
	})
})

/**
 * GET /api/export/orders-for-route
 *
 * Exports unshipped paid orders in the format that the Orders Sorting Program
 * (OSP) consumes via its --import-json flag, eliminating the need to manually
 * export PDFs from each of the 20 Etsy shops.
 *
 * The response JSON is written to a file and passed to OSP:
 *   curl http://localhost:4000/api/export/orders-for-route > orders_export.json
 *   python src/generate_shopping_route.py --project-dir . --import-json orders_export.json
 *
 * Or use the included scripts/generate-route.ps1 which does both steps in one.
 *
 * Query params:
 *   date_from       — YYYY-MM-DD (default: 30 days ago)
 *   date_to         — YYYY-MM-DD (default: today)
 *   shop_id         — filter to one shop (optional)
 *   include_shipped — 'true' to include already-shipped orders (default: false)
 */
app.get('/api/export/orders-for-route', (req, res) => {
	const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 3600

	const conditions = ['r.is_paid = 1']
	const params = {}

	// Date-from filter (default: 30 days ago)
	if (req.query.date_from) {
		const ts = Math.floor(new Date(req.query.date_from + 'T00:00:00').getTime() / 1000)
		if (!isNaN(ts)) {
			conditions.push('r.etsy_created_at >= @date_from')
			params.date_from = ts
		}
	} else {
		conditions.push('r.etsy_created_at >= @date_from')
		params.date_from = thirtyDaysAgo
	}

	// Date-to filter (optional)
	if (req.query.date_to) {
		const ts = Math.floor(new Date(req.query.date_to + 'T23:59:59').getTime() / 1000)
		if (!isNaN(ts)) {
			conditions.push('r.etsy_created_at <= @date_to')
			params.date_to = ts
		}
	}

	// Single-shop filter (optional)
	if (req.query.shop_id) {
		conditions.push('r.shop_id = @shop_id')
		params.shop_id = req.query.shop_id
	}

	// Exclude shipped + cancelled by default (only orders that still need to be purchased)
	if (req.query.include_shipped !== 'true') {
		conditions.push("r.is_shipped = 0 AND r.status NOT IN ('Canceled','Cancelled','Fully Refunded','Fully refunded')")
	}

	const where = `WHERE ${conditions.join(' AND ')}`

	const rows = db
		.prepare(
			`
    SELECT
      r.receipt_id,
      r.name              AS buyer_name,
      r.buyer_email,
      r.buyer_user_id,
      r.message_from_buyer,
      r.shipping_country_iso,
      r.etsy_created_at,
      r.all_transactions,
      s.shop_name
    FROM receipts r
    JOIN shops s ON s.shop_id = r.shop_id
    ${where}
    ORDER BY r.etsy_created_at DESC
  `,
		)
		.all(params)

	// Collect all listing IDs so we can batch-fetch their cached thumbnail URLs
	const allListingIds = new Set()
	for (const r of rows) {
		try {
			const txs = JSON.parse(r.all_transactions || '[]')
			for (const t of txs) if (t.listing_id) allListingIds.add(t.listing_id)
		} catch {}
	}

	// Build listing_id → image URL map in one query
	const imageMap = {}
	if (allListingIds.size > 0) {
		const ph = [...allListingIds].map(() => '?').join(',')
		db.prepare(`SELECT listing_id, url FROM listing_images WHERE listing_id IN (${ph})`)
			.all([...allListingIds])
			.forEach((row) => {
				imageMap[row.listing_id] = row.url
			})
	}

	const variationImageMap = getListingVariationImageMap(db, allListingIds)

	// Format a Unix timestamp as the date string Etsy uses on PDFs: "Jan 15, 2025"
	const fmtDate = (ts) =>
		ts
			? new Date(ts * 1000).toLocaleDateString('en-US', {
					year: 'numeric',
					month: 'short',
					day: 'numeric',
					timeZone: 'UTC',
				})
			: ''

	// Derive a username from buyer_email or buyer_user_id (fallback)
	const fmtUsername = (email, userId) => {
		if (email) return email.split('@')[0]
		if (userId) return String(userId)
		return ''
	}

	// Parse Etsy variations array to extract phone model and style values.
	// Etsy v3 transactions store: [{ formatted_name, formatted_value }, ...].
	const parseVariations = routeDashboard.parseVariations

	const orders = rows
		.map((r) => {
			let transactions = []
			try {
				transactions = JSON.parse(r.all_transactions || '[]')
			} catch {}

			const items = transactions
				.map((t) => {
					const title = (t.title || '').trim()
					if (!title) return null
					const { style, phoneModel } = parseVariations(t.variations)
					const variationImg = t.listing_id
						? lookupVariationImage(variationImageMap, t.listing_id, {
								valueId: parseStyleValueId(t.variations),
								style,
							})
						: null
					return {
						title: title,
						quantity: t.quantity || 1,
						phone_model: phoneModel,
						style: style,
						image_url: resolveUnswitchedLineImage({
							variationUrl: variationImg?.url || null,
							listingUrl: t.listing_id ? imageMap[t.listing_id] || null : null,
						}),
					}
				})
				.filter(Boolean)

			if (!items.length) return null

			return {
				order_number: String(r.receipt_id),
				etsy_shop: r.shop_name || '',
				buyer_name: r.buyer_name || '',
				buyer_username: fmtUsername(r.buyer_email, r.buyer_user_id),
				ship_to_name: r.buyer_name || '',
				ship_to_country: r.shipping_country_iso || '',
				order_date: fmtDate(r.etsy_created_at),
				private_notes: r.message_from_buyer || '',
				items,
			}
		})
		.filter(Boolean)

	res.json({
		exported_at: new Date().toISOString(),
		order_count: orders.length,
		filters: {
			date_from: params.date_from ? new Date(params.date_from * 1000).toISOString().slice(0, 10) : null,
			date_to: params.date_to ? new Date(params.date_to * 1000).toISOString().slice(0, 10) : null,
			shop_id: req.query.shop_id || null,
			include_shipped: req.query.include_shipped === 'true',
		},
		orders,
	})
})

/**
 * POST /api/admin/reload-tokens
 * Hot-reload config.json AND tokens.json without restarting the server.
 * Called automatically by scripts/oauth-setup.js after each shop is authorised.
 *
 * Why config is reloaded too: the dashboard loads config.json ONCE at startup.
 * A shop added to config.json afterwards is invisible to the running process —
 * and a freshly-minted OAuth token for that shop is silently ignored because the
 * server doesn't know the shop exists (its /api/shops token map is built from
 * getAllShops(config)). Reloading config here makes new shops live immediately.
 * Safe to reassign: every HTTP handler and the cron sync callbacks read the
 * module-level `config` at call time, so they all see the new value at once.
 */
app.post('/api/admin/reload-tokens', (req, res) => {
	try {
		// Reload config first so newly-added shops/groups become known. If the file
		// is mid-edit / invalid, keep the previously-loaded config rather than crash.
		let configReloaded = false
		try {
			config = loadConfig()
			syncConfigToDb(db, config)
			configReloaded = true
		} catch (cfgErr) {
			console.error('[admin] Config reload skipped (kept previous):', cfgErr.message)
		}

		tokenManager.reload()
		const tokenStore = tokenManager.getStoreHealth()
		if (!tokenStore.valid) {
			return res.status(409).json({
				success: false,
				code: 'TOKEN_STORE_INVALID',
				error: 'tokens.json is invalid. Repair or restore it before reloading OAuth credentials.',
				config_reloaded: configReloaded,
			})
		}
		const allShopIds = getAllShops(config).map((s) => s.shop_id)
		const status = tokenManager.getStatus(allShopIds)
		console.log(`[admin] Reloaded ${configReloaded ? 'config + ' : ''}tokens from disk (${status.length} shops)`)
		res.json({ success: true, config_reloaded: configReloaded, shops: status.length })
	} catch (err) {
		console.error('[admin] Failed to reload:', err.message)
		res.status(err.status || 500).json({ error: err.message, code: err.code })
	}
})

/**
 * GET /api/admin/suspension-risk
 * Structured compliance report — surfaces config + operational signals that
 * correlate with Etsy shop suspension (linked accounts, overselling, bot bursts).
 */
app.get('/api/admin/suspension-risk', (req, res) => {
	const summary = summarizeRisks(analyzeSuspensionRisks(config))
	res.json(summary)
})

/**
 * GET /api/health
 * Lightweight liveness probe — no DB or Etsy calls. Used by the in-app
 * "Restart server" button to detect when the process has come back up.
 */
app.get('/api/health', (req, res) => {
	if (!req.auth || req.auth.role !== 'owner') {
		return res.json({ ok: true })
	}
	res.json({
		ok: true,
		pid: process.pid,
		uptime_s: Math.round(process.uptime()),
		pm2: process.env.pm_id !== undefined,
		// What code is actually running vs. what's on disk — this is a long-lived
		// pm2 process, so edits don't take effect until a restart. Compare `build`
		// here against `git log -1` to confirm a fix has actually shipped instead
		// of guessing from behavior alone.
		build: BOOT_FINGERPRINT,
	})
})

/**
 * POST /api/restart
 * Restarts the dashboard process so the operator never needs a terminal.
 *
 * Under PM2 (the supported production runner, autorestart:true) a clean exit is
 * immediately revived, so we flush this response and exit(0). If PM2 is NOT
 * supervising this process we best-effort shell out to the local `pm2 restart`
 * so a tray/bare-node launch still recovers; if that's unavailable we report it
 * rather than killing an unsupervised process (which would not come back).
 */
app.post('/api/restart', (req, res) => {
	const underPm2 = process.env.pm_id !== undefined
	res.status(202).json({ ok: true, under_pm2: underPm2, message: 'Restarting…' })

	const doRestart = () => {
		if (underPm2) {
			console.log('[admin] Restart requested via UI — exiting for PM2 to revive.')
			process.exit(0)
		}
		// Not supervised by PM2: try the bundled pm2 CLI to restart the managed app.
		try {
			const { spawn } = require('child_process')
			const pm2Bin = path.resolve(__dirname, '../../node_modules/.bin', process.platform === 'win32' ? 'pm2.cmd' : 'pm2')
			if (require('fs').existsSync(pm2Bin)) {
				console.log('[admin] Restart requested via UI — delegating to PM2 CLI.')
				const child = spawn(pm2Bin, ['restart', 'etsy-dashboard'], { detached: true, stdio: 'ignore', windowsHide: true })
				child.unref()
				return
			}
		} catch (err) {
			console.error('[admin] PM2 restart delegation failed:', err.message)
		}
		console.warn('[admin] Restart requested but process is not under PM2 and no PM2 CLI was found — manual restart required.')
	}

	// Let Express flush the 202 before we go down.
	setTimeout(doRestart, 300)
})

/**
 * GET /api/sync-log
 * Recent sync history — useful to know when each shop was last synced and whether it succeeded.
 */
app.get('/api/sync-log', (req, res) => {
	const limit = Math.min(parseInt(req.query.limit ?? 50, 10), 500)
	const rows = db
		.prepare(
			`
    SELECT
      sl.id,
      sl.shop_id,
      s.shop_name,
      sl.group_id,
      sl.started_at,
      sl.completed_at,
      sl.receipts_synced,
      sl.status,
      sl.egress_ip,
      sl.error_message
    FROM sync_log sl
    JOIN shops s ON s.shop_id = sl.shop_id
    ORDER BY sl.started_at DESC
    LIMIT ?
  `,
		)
		.all(limit)

	const enriched = rows.map((r) => ({
		...r,
		started_at_iso: new Date(r.started_at * 1000).toISOString(),
		completed_at_iso: r.completed_at ? new Date(r.completed_at * 1000).toISOString() : null,
		duration_seconds: r.completed_at ? r.completed_at - r.started_at : null,
	}))

	res.json({ log: enriched, syncing: [..._syncingShops] })
})

// ─── SSE — real-time sync events ──────────────────────────────────────────────

/**
 * GET /api/sync/stream
 * Server-Sent Events stream. Client receives a push whenever a sync
 * starts, completes, or errors. Keeps the Sync Log tab live without polling.
 */
app.get('/api/sync/stream', (req, res) => {
	res.setHeader('Content-Type', 'text/event-stream')
	res.setHeader('Cache-Control', 'no-cache')
	res.setHeader('Connection', 'keep-alive')
	res.setHeader('X-Accel-Buffering', 'no') // nginx: disable buffering
	res.flushHeaders()

	// Send current syncing state immediately on connect
	res.write(`data: ${JSON.stringify({ type: 'connected', syncing: [..._syncingShops] })}\n\n`)

	_sseClients.add(res)
	req.on('close', () => _sseClients.delete(res))
})

// ─── Manual sync triggers ─────────────────────────────────────────────────────

/**
 * POST /api/sync/trigger/:shop_id
 * Manually trigger a sync for one shop. Returns immediately (202);
 * progress arrives via SSE stream.
 */
app.post('/api/sync/trigger/:shop_id', async (req, res) => {
	const shopId = req.params.shop_id
	const shopCfg = getAllShops(config).find((s) => s.shop_id === shopId)
	if (!shopCfg) return res.status(404).json({ error: 'Shop not found' })
	if (_syncingShops.has(shopId)) return res.status(409).json({ error: 'Sync already running' })

	const launch = _startManualSync([shopCfg])
	if (!launch.started) {
		return res.status(409).json({ error: 'Another Etsy sync task is already running.', reason: launch.reason, kind: launch.kind || null, ...getEtsyWorkStatus(db) })
	}
	res.status(202).json({ ok: true, message: `Sync started for ${shopId}` })
})

/**
 * POST /api/sync/trigger-all
 * Manually trigger a sync for all authenticated shops.
 */
// Debounce window for "sync all shops" so a double-click / impatient retry can't
// launch overlapping full-fleet runs seconds apart (each spends real API budget).
const SYNC_ALL_DEBOUNCE_MS = 60_000
let _lastTriggerAllAt = 0

app.post('/api/sync/trigger-all', async (req, res) => {
	const allShops = getAllShops(config).filter((s) => tokenManager.hasTokens(s.shop_id))
	if (allShops.length === 0) return res.status(400).json({ error: 'No authenticated shops' })

	const sinceLast = Date.now() - _lastTriggerAllAt
	if (sinceLast < SYNC_ALL_DEBOUNCE_MS) {
		return res.status(429).json({ error: `Sync-all was just triggered — try again in ${Math.ceil((SYNC_ALL_DEBOUNCE_MS - sinceLast) / 1000)}s.` })
	}

	const alreadyRunning = allShops.filter((s) => _syncingShops.has(s.shop_id))
	if (alreadyRunning.length === allShops.length) return res.status(409).json({ error: 'All shops already syncing' })

	const launch = _startManualSync(allShops)
	if (!launch.started) {
		return res.status(409).json({ error: 'Another Etsy sync task is already running.', reason: launch.reason, kind: launch.kind || null, ...getEtsyWorkStatus(db) })
	}
	_lastTriggerAllAt = Date.now()
	res.status(202).json({ ok: true, message: `Sync started for ${allShops.length} shops` })
})

/**
 * Internal helper: run syncShop for each shop in the list,
 * broadcasting SSE events at each lifecycle step.
 */
function _startManualSync(shops) {
	const launch = startEtsyWork(db, 'manual', async ({ heartbeat }) => {
		// QPD is per API key — once a key is spent, skip its remaining shops this run
		// instead of firing doomed requests that just burn into the cooldown.
		const exhaustedKeys = new Set()

		let _shopIdx = -1
		for (const shopCfg of shops) {
			_shopIdx++
			heartbeat()
			if (_syncingShops.has(shopCfg.shop_id)) continue

			if (exhaustedKeys.has(shopCfg.api_key)) {
				broadcastSyncEvent({
					type: 'sync_skipped',
					shop_id: shopCfg.shop_id,
					reason: 'rate_limited',
					message: "Daily API budget for this shop's key is exhausted — skipped; resumes automatically.",
					ts: Date.now(),
				})
				continue
			}

			// Stagger consecutive shops in a multi-shop run so same-key shops don't fire
			// back-to-back. The per-key QPS bucket already caps the rate, but this keeps
			// the traffic shaped like the jittered background worker rather than a burst.
			if (_shopIdx > 0) await new Promise((r) => setTimeout(r, 1500 + Math.floor(Math.random() * 2000)))

			_syncingShops.add(shopCfg.shop_id)

			broadcastSyncEvent({ type: 'sync_start', shop_id: shopCfg.shop_id, ts: Date.now() })

			try {
				const groupCfg = config.groups.find((g) => g.group_id === shopCfg.group_id)
				const proxyClient = createGroupClient(groupCfg, config.vpn_local_port)
				const accessToken = await tokenManager.getAccessToken(shopCfg.shop_id, shopCfg.api_key, shopCfg.refresh_token ?? null, proxyClient)
				// Pre-flight fail-closed check: a proxied group must carry a proxy agent.
				buildShopClient(proxyClient, shopCfg.api_key, shopCfg.shared_secret, accessToken, null, { requireProxy: usesGroupProxy(groupCfg) })

				const result = await syncShop(shopCfg, groupCfg, config, proxyClient, tokenManager, db, null, { heartbeat })
				if (result?.status === 'rate_limited' && shopCfg.api_key) {
					exhaustedKeys.add(shopCfg.api_key)
				}

				// Read the fresh log entry just written by syncShop
				const entry = db
					.prepare(
						`
        SELECT sl.*, s.shop_name,
          sl.completed_at - sl.started_at AS duration_seconds,
          datetime(sl.started_at,'unixepoch') AS started_at_iso
        FROM sync_log sl JOIN shops s ON s.shop_id = sl.shop_id
        WHERE sl.shop_id = ? ORDER BY sl.started_at DESC LIMIT 1
      `,
					)
					.get(shopCfg.shop_id)

				broadcastSyncEvent({ type: 'sync_complete', shop_id: shopCfg.shop_id, entry, ts: Date.now() })
			} catch (err) {
				if (err?.code === 'ETSY_LOCK_LOST') throw err
				console.error(`[manual-sync] ${shopCfg.shop_id}: ${err.message}`)
				broadcastSyncEvent({ type: 'sync_error', shop_id: shopCfg.shop_id, error: err.message, ts: Date.now() })
			} finally {
				_syncingShops.delete(shopCfg.shop_id)
			}
		}
	})
	if (launch.started) {
		launch.promise.catch((err) => {
			console.error(`[manual-sync] Work failed: ${err.message}`)
			broadcastSyncEvent({ type: 'sync_error', scope: 'manual', error: err.message, ts: Date.now() })
		})
	}
	return launch
}

// ─── Full order backfill (first order → today) ────────────────────────────────
//
// Unlike the periodic sync (which only pulls the newest page of receipts), a
// backfill walks every receipt page for a shop, upserting each order so the DB
// holds the shop's complete history. Progress streams over the same SSE channel.

let _backfillRunning = false

/**
 * POST /api/sync/backfill-all
 * Backfill the entire order history for every authenticated shop.
 */
app.post('/api/sync/backfill-all', (req, res) => {
	if (_backfillRunning) return res.status(409).json({ error: 'A backfill is already running' })
	const shops = getAllShops(config).filter((s) => tokenManager.hasTokens(s.shop_id))
	if (shops.length === 0) return res.status(400).json({ error: 'No authenticated shops' })

	const launch = _startBackfill(shops)
	if (!launch.started) {
		return res.status(409).json({ error: 'Another Etsy sync task is already running.', reason: launch.reason, kind: launch.kind || null, ...getEtsyWorkStatus(db) })
	}
	res.status(202).json({ ok: true, message: `Backfill started for ${shops.length} shop(s)`, shops: shops.length })
})

/**
 * POST /api/sync/backfill/:shop_id
 * Backfill the entire order history for a single shop.
 */
app.post('/api/sync/backfill/:shop_id', (req, res) => {
	if (_backfillRunning) return res.status(409).json({ error: 'A backfill is already running' })
	const shopCfg = getAllShops(config).find((s) => s.shop_id === req.params.shop_id)
	if (!shopCfg) return res.status(404).json({ error: 'Shop not found' })
	if (!tokenManager.hasTokens(shopCfg.shop_id)) return res.status(401).json({ error: 'Shop not authenticated' })

	const launch = _startBackfill([shopCfg])
	if (!launch.started) {
		return res.status(409).json({ error: 'Another Etsy sync task is already running.', reason: launch.reason, kind: launch.kind || null, ...getEtsyWorkStatus(db) })
	}
	res.status(202).json({ ok: true, message: `Backfill started for ${shopCfg.shop_name}` })
})

/**
 * Internal: run a full backfill for each shop sequentially, streaming
 * sync_start / sync_progress / sync_complete events over SSE. A terminal
 * `backfill_done` event tells the client the whole run has finished.
 */
function _startBackfill(shops) {
	const launch = startEtsyWork(db, 'backfill', async ({ heartbeat }) => {
		_backfillRunning = true
		broadcastSyncEvent({ type: 'backfill_start', total: shops.length, ts: Date.now() })

		let completed = 0
		let totalWritten = 0
		// QPD is per API key — once a key is spent, skip its remaining shops so a
		// history backfill doesn't keep stampeding a key that's already over budget.
		const exhaustedKeys = new Set()

		try {
			for (const shopCfg of shops) {
				heartbeat()
				if (_syncingShops.has(shopCfg.shop_id)) continue

				if (exhaustedKeys.has(shopCfg.api_key)) {
					broadcastSyncEvent({
						type: 'sync_skipped',
						mode: 'backfill',
						shop_id: shopCfg.shop_id,
						reason: 'rate_limited',
						message: "Daily API budget for this shop's key is exhausted — backfill paused for it; resume later.",
						ts: Date.now(),
					})
					completed++
					broadcastSyncEvent({ type: 'backfill_progress', completed, total: shops.length, ts: Date.now() })
					continue
				}

				_syncingShops.add(shopCfg.shop_id)
				broadcastSyncEvent({ type: 'sync_start', mode: 'backfill', shop_id: shopCfg.shop_id, ts: Date.now() })

				try {
					const groupCfg = config.groups.find((g) => g.group_id === shopCfg.group_id)
					const proxyClient = createGroupClient(groupCfg, config.vpn_local_port)

					const result = await syncShop(shopCfg, groupCfg, config, proxyClient, tokenManager, db, null, {
						fullBackfill: true,
						heartbeat,
						onProgress: ({ written }) => {
							broadcastSyncEvent({ type: 'sync_progress', mode: 'backfill', shop_id: shopCfg.shop_id, written, ts: Date.now() })
						},
					})
					if (result?.status === 'rate_limited' && shopCfg.api_key) {
						exhaustedKeys.add(shopCfg.api_key)
					}

					const entry = db
						.prepare(
							`
          SELECT sl.*, s.shop_name,
            sl.completed_at - sl.started_at AS duration_seconds,
            datetime(sl.started_at,'unixepoch') AS started_at_iso
          FROM sync_log sl JOIN shops s ON s.shop_id = sl.shop_id
          WHERE sl.shop_id = ? ORDER BY sl.started_at DESC LIMIT 1
        `,
						)
						.get(shopCfg.shop_id)

					totalWritten += entry?.receipts_synced ?? 0
					broadcastSyncEvent({ type: 'sync_complete', mode: 'backfill', shop_id: shopCfg.shop_id, entry, ts: Date.now() })
				} catch (err) {
					if (err?.code === 'ETSY_LOCK_LOST') throw err
					console.error(`[backfill] ${shopCfg.shop_id}: ${err.message}`)
					broadcastSyncEvent({ type: 'sync_error', mode: 'backfill', shop_id: shopCfg.shop_id, error: err.message, ts: Date.now() })
				} finally {
					_syncingShops.delete(shopCfg.shop_id)
					completed++
					broadcastSyncEvent({ type: 'backfill_progress', completed, total: shops.length, ts: Date.now() })
				}
			}
		} finally {
			_backfillRunning = false
			broadcastSyncEvent({ type: 'backfill_done', completed, total: shops.length, total_written: totalWritten, ts: Date.now() })
			console.log(`[backfill] Complete — ${completed}/${shops.length} shops, ${totalWritten} receipts upserted`)
		}
	})
	if (launch.started) {
		launch.promise.catch((err) => {
			console.error(`[backfill] Work failed: ${err.message}`)
			broadcastSyncEvent({ type: 'sync_error', scope: 'backfill', error: err.message, ts: Date.now() })
		})
	}
	return launch
}

// ─── Finance / earnings ───────────────────────────────────────────────────────
//
// Earnings come from each shop's Etsy payment-account ledger (the authoritative
// record), denominated in that shop's payout currency. We never convert between
// currencies — totals are grouped/displayed per currency.

let _ledgerSyncRunning = false

/**
 * GET /api/finance/summary?from&to&shop_id
 * Aggregated gross / fees / tax / refunds / net grouped by shop, currency, and
 * fee category for the window. Timestamps are unix seconds.
 */
app.get('/api/finance/summary', (req, res) => {
	const from = req.query.from ? parseInt(req.query.from, 10) : undefined
	const to = req.query.to ? parseInt(req.query.to, 10) : undefined
	const shopId = req.query.shop_id || undefined
	const summary = getEarningsSummary(db, { from, to, shopId })
	// Current payment-account balance is point-in-time (not window-bound), so it
	// is computed independently of from/to and attached to the same payload to
	// save the UI a second round trip.
	summary.balances = getShopBalances(db, { shopId })
	// Month-to-date net profit is calendar-month bound (not window-bound), to
	// mirror Etsy's "Your current net profit on Etsy for this month" headline.
	summary.monthToDate = getCurrentMonthNet(db, { shopId })
	res.json(summary)
})

/**
 * GET /api/finance/per-order?from&to&shop_id&limit&offset
 * Per-receipt earnings (gross, fees, tax, net) for the window.
 */
app.get('/api/finance/per-order', (req, res) => {
	const from = req.query.from ? parseInt(req.query.from, 10) : undefined
	const to = req.query.to ? parseInt(req.query.to, 10) : undefined
	const shopId = req.query.shop_id || undefined
	const limit = req.query.limit ? parseInt(req.query.limit, 10) : undefined
	const offset = req.query.offset ? parseInt(req.query.offset, 10) : undefined
	res.json(getPerOrderEarnings(db, { from, to, shopId, limit, offset }))
})

/**
 * GET /api/finance/status
 * Ledger coverage per shop (entry counts, first/last dates, last sync) so the
 * UI can show how complete the earnings data is.
 */
app.get('/api/finance/status', (req, res) => {
	const stats = getLedgerStats(db)
	const shops = db.prepare('SELECT shop_id, shop_name, ledger_synced_at FROM shops').all()
	const byId = Object.fromEntries(stats.map((s) => [s.shop_id, s]))
	const merged = shops
		.filter((s) => s.shop_id !== MANUAL_SHOP_ID)
		.map((s) => ({
			shop_id: s.shop_id,
			shop_name: s.shop_name,
			ledger_synced_at: s.ledger_synced_at ?? null,
			entries: byId[s.shop_id]?.entries ?? 0,
			first_date: byId[s.shop_id]?.first_date ?? null,
			last_date: byId[s.shop_id]?.last_date ?? null,
		}))
	res.json({ shops: merged, running: _ledgerSyncRunning })
})

/**
 * POST /api/finance/sync-all   { full?: boolean }
 * Sync the payment-account ledger for every authenticated shop. `full` (default
 * true) walks the entire history; otherwise an incremental sync from each shop's
 * high-water mark. Streams progress over SSE.
 */
let _lastFinanceSyncAllAt = 0

app.post('/api/finance/sync-all', (req, res) => {
	if (_ledgerSyncRunning) return res.status(409).json({ error: 'An earnings sync is already running' })
	const shops = getAllShops(config).filter((s) => tokenManager.hasTokens(s.shop_id))
	if (shops.length === 0) return res.status(400).json({ error: 'No authenticated shops' })

	const sinceLast = Date.now() - _lastFinanceSyncAllAt
	if (sinceLast < SYNC_ALL_DEBOUNCE_MS) {
		return res.status(429).json({ error: `Earnings sync-all was just triggered — try again in ${Math.ceil((SYNC_ALL_DEBOUNCE_MS - sinceLast) / 1000)}s.` })
	}

	const full = req.body?.full !== false
	const launch = _startLedgerSync(shops, { fullBackfill: full })
	if (!launch.started) {
		return res.status(409).json({ error: 'Another Etsy sync task is already running.', reason: launch.reason, kind: launch.kind || null, ...getEtsyWorkStatus(db) })
	}
	_lastFinanceSyncAllAt = Date.now()
	res.status(202).json({ ok: true, message: `Earnings sync started for ${shops.length} shop(s)`, shops: shops.length, full })
})

/**
 * POST /api/finance/sync/:shop_id   { full?: boolean }
 * Sync the ledger for a single shop.
 */
app.post('/api/finance/sync/:shop_id', (req, res) => {
	if (_ledgerSyncRunning) return res.status(409).json({ error: 'An earnings sync is already running' })
	const shopCfg = getAllShops(config).find((s) => s.shop_id === req.params.shop_id)
	if (!shopCfg) return res.status(404).json({ error: 'Shop not found' })
	if (!tokenManager.hasTokens(shopCfg.shop_id)) return res.status(401).json({ error: 'Shop not authenticated' })
	const full = req.body?.full !== false
	const launch = _startLedgerSync([shopCfg], { fullBackfill: full })
	if (!launch.started) {
		return res.status(409).json({ error: 'Another Etsy sync task is already running.', reason: launch.reason, kind: launch.kind || null, ...getEtsyWorkStatus(db) })
	}
	res.status(202).json({ ok: true, message: `Earnings sync started for ${shopCfg.shop_name}`, full })
})

/**
 * GET /api/growth
 * Sales / traffic diagnosis from already-synced data. Never calls Etsy.
 * Query: days=7|28, shop_id=
 */
function growthApiAnalyticsEnabled() {
	return config.catalog_health_sync === true && config.etsy_api_analytics_approved === true
}

app.get('/api/growth', (req, res) => {
	try {
		const days = Number(req.query.days) === 28 ? 28 : 7
		const shopId = req.query.shop_id ? String(req.query.shop_id) : ''
		const report = buildGrowthReport(db, { windowDays: days, shopId: shopId || undefined })
		report.compliance = summarizeRisks(analyzeSuspensionRisks(config))
		const apiEnabled = growthApiAnalyticsEnabled()
		report.collection = {
			mode: apiEnabled ? 'manual_with_approved_api_opt_in' : 'manual',
			api_enabled: apiEnabled,
			analytics_approval_recorded: config.etsy_api_analytics_approved === true,
			api_calls_on_page_load: 0,
			authorization_guaranteed_by_manual_mode: false,
			terms_notice: 'Manual mode avoids automated Etsy access and scraping, but Etsy API Terms §5(24) use broad language about automated analysis of Etsy data. Retain Etsy written scope confirmation for the lowest contractual risk.',
			message: apiEnabled
				? 'Manual imports are preferred. Optional API analytics is enabled under a recorded written-approval attestation.'
				: 'Manual mode: opening and refreshing Growth makes zero Etsy API calls.',
		}
		res.json(report)
	} catch (err) {
		console.error('[growth] report failed:', err.message)
		res.status(500).json({ error: err.message || 'Growth report failed' })
	}
})

function growthCsvCell(value) {
	let text = String(value ?? '')
	// Spreadsheet formula injection: listing titles are external Etsy content.
	if (/^[=+\-@]/.test(text)) text = `'${text}`
	return `"${text.replace(/"/g, '""')}"`
}

/**
 * GET /api/growth/rights-review.csv
 * Complete local-only authorization review queue. Never calls Etsy and contains
 * no buyer/order data. Identification is a review trigger, not a legal verdict.
 */
app.get('/api/growth/rights-review.csv', (_req, res) => {
	const rows = listThirdPartyRightsReview(db)
	const columns = [
		['Shop', (row) => row.shop_name],
		['Listing ID', (row) => row.listing_id],
		['Title', (row) => row.title],
		['Identified Character', (row) => row.character],
		['Likely Rights Holder', (row) => row.rights_holder],
		['Lifetime Views (cached)', (row) => row.views],
		['Listing URL', (row) => row.listing_url],
		['Required Review', () => 'Retain documented authorization and confirm Etsy Creativity Standards eligibility; otherwise remove/exclude'],
	]
	const csv = [
		columns.map(([label]) => growthCsvCell(label)).join(','),
		...rows.map((row) => columns.map(([, get]) => growthCsvCell(get(row))).join(',')),
	].join('\r\n')
	res.setHeader('Content-Type', 'text/csv; charset=utf-8')
	res.setHeader('Content-Disposition', `attachment; filename="etsy-rights-review-${new Date().toISOString().slice(0, 10)}.csv"`)
	res.setHeader('X-Export-Row-Count', String(rows.length))
	res.send('\uFEFF' + csv)
})

/**
 * GET /api/growth/status
 * Catalog-health coverage + whether a catalog sync is running.
 */
app.get('/api/growth/status', (req, res) => {
	const intervalHours = config.catalog_health_interval_hours ?? 24
	const shops = getAllShops(config).filter((s) => s.shop_id !== MANUAL_SHOP_ID)
	const work = getEtsyWorkStatus(db)
	const rows = shops.map((s) => {
		const row = db.prepare(
			`SELECT catalog_health_synced_at, reviews_synced_at, review_average, review_count, is_vacation, listing_active_count FROM shops WHERE shop_id = ?`
		).get(s.shop_id) || {}
		return {
			shop_id: s.shop_id,
			shop_name: s.shop_name,
			authenticated: tokenManager.hasTokens(s.shop_id),
			stale: shopNeedsCatalogHealth(db, s.shop_id, intervalHours),
			catalog_health_synced_at: row.catalog_health_synced_at ?? null,
			reviews_synced_at: row.reviews_synced_at ?? null,
			review_average: row.review_average ?? null,
			review_count: row.review_count ?? null,
			is_vacation: row.is_vacation === 1,
			listing_active_count: row.listing_active_count ?? null,
		}
	})
	res.json({
		mode: growthApiAnalyticsEnabled() ? 'manual_with_approved_api_opt_in' : 'manual',
		api_enabled: growthApiAnalyticsEnabled(),
		analytics_approval_recorded: config.etsy_api_analytics_approved === true,
		api_calls_on_page_load: 0,
		interval_hours: intervalHours,
		running: work.in_process === 'catalog_health',
		etsy_work: work,
		shops: rows,
	})
})

/**
 * POST /api/growth/manual/parse
 * Parse pasted aggregate Shop Manager text in memory. The original text is
 * deliberately not stored. This endpoint never imports or calls Etsy.
 */
app.post('/api/growth/manual/parse', (req, res) => {
	try {
		// `raw` intentionally matches the audit middleware's bulky/redacted
		// key policy, so preview text cannot leak into audit_log.details.
		const parsed = parsePastedStatsText(req.body?.raw)
		res.json({ ok: true, parsed })
	} catch (err) {
		res.status(err.status || 400).json({ error: err.message, code: err.code || 'INVALID_GROWTH_PASTE', field: err.field || null })
	}
})

/**
 * POST /api/growth/manual
 * Persist one validated current-vs-previous aggregate comparison. Owner-only,
 * local SQLite only, idempotent through import_key, and zero Etsy API calls.
 */
app.post('/api/growth/manual', (req, res) => {
	try {
		const result = saveManualComparison(db, req.body, {
			importedBy: req.auth?.user || 'owner',
		})
		res.status(result.deduplicated ? 200 : 201).json({ ok: true, ...result })
	} catch (err) {
		console.warn(`[growth] manual import rejected: ${err.message}`)
		res.status(err.status || 400).json({ error: err.message, code: err.code || 'INVALID_GROWTH_IMPORT', field: err.field || null })
	}
})

/** GET /api/growth/manual — recent local imports for provenance/correction. */
app.get('/api/growth/manual', (req, res) => {
	try {
		const shopId = req.query.shop_id ? String(req.query.shop_id) : null
		const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))
		res.json({ imports: listManualComparisons(db, { shopId, limit }) })
	} catch (err) {
		res.status(500).json({ error: err.message || 'Could not load manual Growth imports' })
	}
})

/** DELETE /api/growth/manual/:id — remove a mistaken local aggregate import. */
app.delete('/api/growth/manual/:id', (req, res) => {
	try {
		const deleted = deleteManualComparison(db, req.params.id)
		if (!deleted) return res.status(404).json({ error: 'Manual Growth import not found' })
		res.json({ ok: true })
	} catch (err) {
		res.status(err.status || 400).json({ error: err.message, code: err.code || 'INVALID_GROWTH_IMPORT' })
	}
})

/**
 * POST /api/growth/manual/listings/parse
 * Parse two copied per-listing Stats tables in memory. Raw text is redacted by
 * the audit middleware and discarded after this response.
 */
app.post('/api/growth/manual/listings/parse', (req, res) => {
	try {
		const parsed = parsePastedListingStats(req.body?.raw)
		res.json({ ok: true, parsed })
	} catch (err) {
		res.status(err.status || 400).json({
			error: err.message,
			code: err.code || 'INVALID_GROWTH_LISTING_PASTE',
			field: err.field || null,
		})
	}
})

/**
 * POST /api/growth/manual/listings
 * Persist a validated per-listing comparison in local SQLite. The request
 * contains normalized aggregate metrics only and never triggers an Etsy call.
 */
app.post('/api/growth/manual/listings', (req, res) => {
	try {
		const result = saveListingDetailImport(db, req.body, {
			importedBy: req.auth?.user || 'owner',
		})
		res.status(result.deduplicated ? 200 : 201).json({ ok: true, ...result })
	} catch (err) {
		console.warn(`[growth] manual listing import rejected: ${err.message}`)
		res.status(err.status || 400).json({
			error: err.message,
			code: err.code || 'INVALID_GROWTH_LISTING_IMPORT',
			field: err.field || null,
		})
	}
})

/** GET /api/growth/manual/listings — local per-listing import provenance. */
app.get('/api/growth/manual/listings', (req, res) => {
	try {
		const shopId = req.query.shop_id ? String(req.query.shop_id) : null
		const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25))
		res.json({ imports: listListingDetailImports(db, { shopId, limit }) })
	} catch (err) {
		res.status(500).json({ error: err.message || 'Could not load per-listing Growth imports' })
	}
})

/** DELETE /api/growth/manual/listings/:id — remove one mistaken local import. */
app.delete('/api/growth/manual/listings/:id', (req, res) => {
	try {
		const deleted = deleteListingDetailImport(db, req.params.id)
		if (!deleted) return res.status(404).json({ error: 'Per-listing Growth import not found' })
		res.json({ ok: true })
	} catch (err) {
		res.status(err.status || 400).json({
			error: err.message,
			code: err.code || 'INVALID_GROWTH_LISTING_IMPORT',
		})
	}
})

let _lastGrowthSyncAt = 0

/**
 * POST /api/growth/sync
 * Walk stale shops' active listings + reviews. Owner-only (no ACL rule).
 * Body: { force?: boolean }
 */
app.post('/api/growth/sync', (req, res) => {
	if (!growthApiAnalyticsEnabled()) {
		return res.status(409).json({
			error: 'API analytics is disabled. Etsy written authorization plus both etsy_api_analytics_approved and catalog_health_sync are required; use manual Growth imports otherwise.',
			code: 'ETSY_API_ANALYTICS_NOT_APPROVED',
		})
	}
	if (req.body?.confirm_api_calls !== true) {
		return res.status(400).json({ error: 'Explicit confirmation is required before making Etsy API calls.' })
	}
	const shops = getAllShops(config).filter((s) => tokenManager.hasTokens(s.shop_id) && s.shop_id !== MANUAL_SHOP_ID)
	if (shops.length === 0) return res.status(400).json({ error: 'No authenticated shops' })
	const requestedShopId = String(req.body?.shop_id || '').trim()
	if (!requestedShopId) {
		return res.status(400).json({ error: 'Select one shop for an on-demand API collection.' })
	}
	const selected = shops.find((shop) => shop.shop_id === requestedShopId)
	if (!selected) return res.status(404).json({ error: 'Authenticated shop not found' })

	const sinceLast = Date.now() - _lastGrowthSyncAt
	if (sinceLast < 15_000) {
		return res.status(429).json({ error: `Catalog sync was just triggered — try again in ${Math.ceil((15_000 - sinceLast) / 1000)}s.` })
	}

	const force = req.body?.force === true
	const intervalHours = config.catalog_health_interval_hours ?? 24
	const targets = force || shopNeedsCatalogHealth(db, selected.shop_id, intervalHours) ? [selected] : []
	if (!targets.length) {
		return res.json({ ok: true, message: 'Every shop already has a fresh catalog snapshot.', shops: 0 })
	}

	const launch = startEtsyWork(db, 'catalog_health', async ({ heartbeat }) => {
		const results = []
		for (const shop of targets) {
			heartbeat()
			try {
				const { shopClient, numericShopId } = await getShopClientForShopName(shop.shop_name)
				const result = await syncShopCatalogHealth({
					db,
					shopClient,
					numericShopId,
					shopId: shop.shop_id,
					shopName: shop.shop_name,
					analyticsApproved: config.etsy_api_analytics_approved,
					heartbeat,
				})
				results.push({ shop_id: shop.shop_id, shop_name: shop.shop_name, ...result })
			} catch (err) {
				if (isQpdExhaustedError(err)) {
					results.push({ shop_id: shop.shop_id, shop_name: shop.shop_name, skipped: 'qpd', error: err.message })
					break
				}
				console.warn(`[growth] ${shop.shop_name} catalog failed: ${err.message}`)
				results.push({ shop_id: shop.shop_id, shop_name: shop.shop_name, error: err.message })
			}
		}
		return { shops: results }
	})
	if (!launch.started) {
		return res.status(409).json({ error: 'Another Etsy sync task is already running.', reason: launch.reason, kind: launch.kind || null, ...getEtsyWorkStatus(db) })
	}
	_lastGrowthSyncAt = Date.now()
	res.status(202).json({ ok: true, message: `Catalog health started for ${targets.length} shop(s)`, shops: targets.length, force })
})

/**
 * Internal: sync ledgers sequentially with SSE progress events
 * (ledger_sync_start / ledger_sync_progress / ledger_sync_done).
 */
function _startLedgerSync(shops, { fullBackfill }) {
	const launch = startEtsyWork(db, 'ledger', async ({ heartbeat }) => {
		_ledgerSyncRunning = true
		broadcastSyncEvent({ type: 'ledger_sync_start', total: shops.length, full: !!fullBackfill, ts: Date.now() })

		let completed = 0
		let totalEntries = 0
		// A full earnings backfill walks years of ledger history per shop and is the
		// heaviest QPD consumer in the app. QPD is per API key, so when one shop on a
		// key runs out, skip the rest of that key's shops — they'd only burn into the
		// cooldown — and let the operator resume once the window frees budget.
		const exhaustedKeys = new Set()

		try {
			for (const shopCfg of shops) {
				heartbeat()
				if (exhaustedKeys.has(shopCfg.api_key)) {
					broadcastSyncEvent({
						type: 'ledger_shop_skipped',
						shop_id: shopCfg.shop_id,
						reason: 'rate_limited',
						message: "Daily API budget for this shop's key is exhausted — earnings sync paused for it; resume later.",
						ts: Date.now(),
					})
					completed++
					broadcastSyncEvent({ type: 'ledger_sync_progress', completed, total: shops.length, ts: Date.now() })
					continue
				}

				broadcastSyncEvent({ type: 'ledger_shop_start', shop_id: shopCfg.shop_id, ts: Date.now() })
				try {
					const groupCfg = config.groups.find((g) => g.group_id === shopCfg.group_id)
					const proxyClient = createGroupClient(groupCfg, config.vpn_local_port)
					const { entries, attributed } = await syncLedgerForShop(shopCfg, groupCfg, config, proxyClient, tokenManager, db, {
						fullBackfill,
						heartbeat,
						onProgress: ({ entries }) => broadcastSyncEvent({ type: 'ledger_progress', shop_id: shopCfg.shop_id, entries, ts: Date.now() }),
					})
					totalEntries += entries
					broadcastSyncEvent({ type: 'ledger_shop_done', shop_id: shopCfg.shop_id, entries, attributed, ts: Date.now() })
				} catch (err) {
					if (err?.code === 'ETSY_LOCK_LOST') throw err
					if (isQpdExhaustedError(err)) {
						if (shopCfg.api_key) exhaustedKeys.add(shopCfg.api_key)
						console.warn(`[ledger] ${shopCfg.shop_id}: paused — ${err.message}`)
						broadcastSyncEvent({
							type: 'ledger_shop_skipped',
							shop_id: shopCfg.shop_id,
							reason: 'rate_limited',
							message: err.message,
							ts: Date.now(),
						})
					} else {
						console.error(`[ledger] ${shopCfg.shop_id}: ${err.message}`)
						broadcastSyncEvent({ type: 'ledger_shop_error', shop_id: shopCfg.shop_id, error: err.message, ts: Date.now() })
					}
				} finally {
					completed++
					broadcastSyncEvent({ type: 'ledger_sync_progress', completed, total: shops.length, ts: Date.now() })
				}
			}
		} finally {
			_ledgerSyncRunning = false
			broadcastSyncEvent({ type: 'ledger_sync_done', completed, total: shops.length, total_entries: totalEntries, ts: Date.now() })
			console.log(`[ledger] Earnings sync complete — ${completed}/${shops.length} shops, ${totalEntries} entries`)
		}
	})
	if (launch.started) {
		launch.promise.catch((err) => {
			console.error(`[ledger] Work failed: ${err.message}`)
			broadcastSyncEvent({ type: 'ledger_shop_error', scope: 'ledger', error: err.message, ts: Date.now() })
		})
	}
	return launch
}

// ─── Order notes ──────────────────────────────────────────────────────────────

/**
 * GET /api/orders/:receipt_id/note
 * Returns the team note + buyer's note for an order.
 */
app.get('/api/orders/:receipt_id/note', (req, res) => {
	const row = db.prepare('SELECT team_note, message_from_buyer FROM receipts WHERE receipt_id = ?').get(req.params.receipt_id)
	if (!row) return res.status(404).json({ error: 'Order not found' })
	res.json({ team_note: row.team_note || '', message_from_buyer: row.message_from_buyer || '' })
})

/**
 * PUT /api/orders/:receipt_id/note
 * Body: { team_note: string }
 * Saves the team note in the local DB only (Etsy has no per-order seller-note API).
 */
app.put('/api/orders/:receipt_id/note', (req, res) => {
	const { team_note = '' } = req.body
	const result = db.prepare('UPDATE receipts SET team_note = ? WHERE receipt_id = ?').run(team_note, req.params.receipt_id)
	if (result.changes === 0) return res.status(404).json({ error: 'Order not found' })
	res.json({ success: true, team_note })
})

// ─── Fulfilment issues (out-of-production / model-unavailable workflow) ─────────
//
// When a product can no longer be supplied as the buyer ordered it — the
// manufacturer discontinued it (out_of_production), or the supplier no longer
// offers the phone model the buyer chose (model_unavailable) — the operator
// flags the affected LINE-ITEM as an issue. While the issue is OPEN:
//   • the line is held out of the purchasing Route (so we never buy it), and
//   • the operator works a checklist: message the buyer (manually — Etsy v3 has
//     no messaging API), handle the Etsy listing (delete it, or remove the
//     unavailable model), and finally resolve it (buyer switched / refunded /
//     cancelled).
// All purely local/operational except the explicit "handle listing" action,
// which performs the real Etsy API call on demand.

/** Resolve the affected listing's owning shop client from a receipt. */
async function shopClientForReceipt(receiptId) {
	const r = db.prepare('SELECT shop_id FROM receipts WHERE receipt_id = ?').get(receiptId)
	if (!r) return null
	const shop = db.prepare('SELECT shop_name FROM shops WHERE shop_id = ?').get(r.shop_id)
	if (!shop?.shop_name) return null
	return getShopClientForShopName(shop.shop_name)
}

/**
 * GET /api/orders/:receipt_id/issues
 * Lists every fulfilment issue (open + resolved) on an order.
 */
app.get('/api/orders/:receipt_id/issues', (req, res) => {
	const exists = db.prepare('SELECT 1 FROM receipts WHERE receipt_id = ?').get(req.params.receipt_id)
	if (!exists) return res.status(404).json({ error: 'Order not found' })
	res.json({ issues: getIssuesForReceipt(db, req.params.receipt_id) })
})

/**
 * POST /api/orders/:receipt_id/issues
 * Body: { item_key, issue_type, listing_id?, title?, phone_model?, note? }
 * Flags (or re-opens) a line-item as having a fulfilment issue. This alone holds
 * the line out of the purchasing Route — the listing/buyer actions are separate.
 */
app.post('/api/orders/:receipt_id/issues', (req, res) => {
	const receiptId = Number(req.params.receipt_id)
	const { item_key: itemKey, issue_type: issueType, listing_id: listingId, title, phone_model: phoneModel, note } = req.body || {}
	if (!itemKey) return res.status(400).json({ error: 'item_key is required' })
	if (!ISSUE_TYPES.includes(issueType)) return res.status(400).json({ error: `issue_type must be one of: ${ISSUE_TYPES.join(', ')}` })
	const exists = db.prepare('SELECT 1 FROM receipts WHERE receipt_id = ?').get(receiptId)
	if (!exists) return res.status(404).json({ error: 'Order not found' })

	// Authoritative product context: if this line was switched to a replacement,
	// the issue is about THAT replacement (the buyer already moved on from the
	// original), so its title/model must describe the switched design regardless of
	// what the client sent. This keeps the held product, the buyer message and the
	// AI draft all speaking about the item actually being fulfilled.
	const sub = getSubstitutionForLine(db, receiptId, String(itemKey))
	const effectiveTitle = sub && sub.new_title ? sub.new_title : title
	const effectivePhoneModel = sub && sub.new_phone_model ? sub.new_phone_model : phoneModel

	let issue
	const txn = db.transaction(() => {
		issue = upsertOrderIssue(db, {
			receipt_id: receiptId,
			item_key: String(itemKey),
			listing_id: listingId,
			title: effectiveTitle,
			phone_model: effectivePhoneModel,
			issue_type: issueType,
			note: typeof note === 'string' ? note.trim().slice(0, 1000) : null,
			source: 'manual',
		})
		// Holding a line out of purchasing must also clear any stale needs-purchase
		// rollup so the order can't simultaneously be "buy this" and "on hold".
		recomputeNeedsPurchaseRollup(receiptId)
	})
	txn()

	console.log(`[issue] receipt ${receiptId} line ${itemKey} flagged as ${issueType}`)
	// Flagging holds the line out of purchasing — refresh live Route/Shopping views
	// so it drops off there immediately.
	broadcastRouteRefresh(receiptId, 'issue-flagged')
	res.json({ success: true, issue })
})

/**
 * POST /api/issues/:id/notify
 * Records that the operator has messaged the buyer (toggle via body { notified }).
 */
app.post('/api/issues/:id/notify', (req, res) => {
	const notified = req.body?.notified !== false
	const issue = patchOrderIssue(db, req.params.id, { buyer_notified_at: notified ? Math.floor(Date.now() / 1000) : null })
	if (!issue) return res.status(404).json({ error: 'Issue not found' })
	res.json({ success: true, issue })
})

/**
 * POST /api/issues/:id/draft-message
 * Body: { tone?, instructions?, regenerate? }
 * Generates a warm, professional, ready-to-send buyer message for this issue,
 * unique to the order (correct buyer first name, shop/brand name, product title,
 * variations, and issue type). Persists it on the issue so reopening shows the
 * same copy. Returns { message, issue }.
 *
 * This replaces the old "type a prompt into Gemini and copy the reply" workflow:
 * the operator clicks once, then copies the message into the Etsy conversation
 * (Etsy v3 has no messaging API, so sending is still a manual paste).
 */
app.post('/api/issues/:id/draft-message', async (req, res) => {
	const issue = getIssueById(db, req.params.id)
	if (!issue) return res.status(404).json({ error: 'Issue not found' })

	// If a message already exists and the caller isn't explicitly regenerating,
	// return the saved one so the copy is stable across reopens. Re-run the
	// compliance check so a draft saved before this guard existed is still vetted.
	if (issue.buyer_message && !req.body?.regenerate) {
		return res.json({ success: true, message: issue.buyer_message, issue, cached: true, compliance: checkMessageCompliance(issue.buyer_message) })
	}

	try {
		// Resolve the order facts: buyer name + shop/brand name from the receipt,
		// and the exact product variations (style / phone model) from the line.
		const receipt = db
			.prepare(
				`
			SELECT r.name AS buyer_name, s.shop_name AS shop_name
			FROM receipts r LEFT JOIN shops s ON s.shop_id = r.shop_id
			WHERE r.receipt_id = ?
		`,
			)
			.get(issue.receipt_id)
		if (!receipt) return res.status(404).json({ error: 'Order not found for this issue.' })

		// Pull the matching transaction line to recover style/model variations. We
		// match on listing_id + title so multi-line orders map to the right product.
		let style = ''
		let phoneModel = issue.phone_model || ''
		try {
			const txns = receiptLineRecords(issue.receipt_id)
			const match = lineIdentity.findTransactionByLineKey(db, issue.receipt_id, txns, issue.item_key) || txns.find((t) => issue.listing_id && Number(t.listing_id) === Number(issue.listing_id))
			if (match) {
				const parsed = routeDashboard.parseVariations(match.variations)
				style = parsed.style || ''
				if (!phoneModel) phoneModel = parsed.phoneModel || ''
			}
		} catch {
			/* variations are best-effort context */
		}

		// If the line was switched, the message is about the REPLACEMENT the buyer
		// chose — so the design title, style and (if changed) model all come from the
		// substitution, never the original the buyer already moved away from.
		const sub = getSubstitutionForLine(db, issue.receipt_id, issue.item_key)
		const productTitle = (sub && sub.new_title) || issue.title || ''
		if (sub && sub.new_style) style = sub.new_style
		if (sub && sub.new_phone_model) phoneModel = sub.new_phone_model

		const { message, compliance } = await generateBuyerIssueMessage({
			shopName: receipt.shop_name || '',
			buyerName: receipt.buyer_name || '',
			productTitle,
			issueType: issue.issue_type,
			phoneModel: issue.issue_type === 'model_unavailable' ? phoneModel : '',
			style,
			note: issue.note || '',
			isReplacement: !!sub,
			tone: typeof req.body?.tone === 'string' ? req.body.tone.slice(0, 200) : '',
			extraInstructions: typeof req.body?.instructions === 'string' ? req.body.instructions.slice(0, 500) : '',
		})

		const updated = patchOrderIssue(db, issue.id, { buyer_message: message, buyer_message_at: Math.floor(Date.now() / 1000) })
		res.json({ success: true, message, issue: updated, compliance })
	} catch (err) {
		console.error('[issue] draft-message error:', err.response?.data || err.message)
		// A 422 from the compliance guard means every draft kept violating policy;
		// surface its structured findings so the UI can explain what to fix.
		res.status(err.status || err.response?.status || 500).json({
			error: err.response?.data?.error?.message || err.message || 'Could not generate the message.',
			...(err.compliance ? { compliance: err.compliance } : {}),
		})
	}
})

/**
 * POST /api/support/message-check
 * Body: { message }
 * Vets ANY buyer message — AI-drafted OR hand-typed — against Etsy's messaging
 * policy BEFORE it is pasted into an Etsy conversation. Etsy v3 has no messaging
 * API, so the human paste is the moment of risk; this is the last automated
 * checkpoint that catches off-Etsy contact/payment/links/steering — the content
 * classes that get shops suspended. Pure + local (no Etsy call, no AI).
 */
app.post('/api/support/message-check', express.json({ limit: '256kb' }), (req, res) => {
	const message = typeof req.body?.message === 'string' ? req.body.message : ''
	if (!message.trim()) return res.status(400).json({ error: 'A message is required.' })
	res.json({ success: true, ...checkMessageCompliance(message) })
})

/**
 * POST /api/issues/:id/handle-listing
 * Body: { shop_name? }
 * Performs the real Etsy listing action for the issue:
 *   • out_of_production → DELETE the listing.
 *   • model_unavailable → remove the buyer's model from the listing's inventory.
 * On success, stamps listing_handled_at + listing_action. If the listing is
 * already gone (404) we treat it as handled. Any other failure is surfaced so
 * the operator can fall back to handling it manually on Etsy.
 */
app.post('/api/issues/:id/handle-listing', async (req, res) => {
	const issue = getIssueById(db, req.params.id)
	if (!issue) return res.status(404).json({ error: 'Issue not found' })
	if (!issue.listing_id) return res.status(400).json({ error: 'This issue has no Etsy listing to act on — handle it manually and mark it done.' })

	try {
		const resolved = req.body?.shop_name ? await getShopClientForShopName(req.body.shop_name) : await shopClientForReceipt(issue.receipt_id)
		if (!resolved?.shopClient) return res.status(400).json({ error: 'Could not resolve the shop for this order. Pass shop_name or check the shop is configured.' })
		const { shopClient } = resolved

		let action = 'none'
		if (issue.issue_type === 'out_of_production') {
			try {
				await deleteListing(shopClient, issue.listing_id)
			} catch (err) {
				const status = err.response?.status || err.status
				if (status !== 404) throw err // already deleted → treat as handled
			}
			db.prepare('DELETE FROM listings WHERE listing_id = ?').run(issue.listing_id)
			action = 'deleted'
		} else if (issue.issue_type === 'model_unavailable') {
			if (!issue.phone_model) return res.status(400).json({ error: 'No phone model recorded on this issue — cannot remove it. Edit the issue or handle it manually.' })
			const inv = await getListingInventory(shopClient, issue.listing_id)
			const result = removeModelFromInventory(inv, issue.phone_model)
			if (!result.ok) return res.status(409).json({ error: result.reason || 'Could not remove the model from the listing.' })
			await updateListingInventory(shopClient, issue.listing_id, inv)
			action = 'model_removed'
		} else {
			return res.status(400).json({ error: 'This issue type has no automatic Etsy action — mark it handled manually.' })
		}

		const updated = patchOrderIssue(db, issue.id, { listing_handled_at: Math.floor(Date.now() / 1000), listing_action: action })
		logEvent(db, {
			event_type: 'ORDER_ISSUE',
			shop_name: null,
			listing_id: issue.listing_id,
			listing_title: issue.title || null,
			detail: action === 'deleted' ? `Listing ${issue.listing_id} deleted on Etsy (out of production)` : `Removed model "${issue.phone_model}" from listing ${issue.listing_id} on Etsy`,
			meta: { issue_id: issue.id, receipt_id: issue.receipt_id, issue_type: issue.issue_type, action },
		})
		console.log(`[issue] ${issue.id}: Etsy listing ${issue.listing_id} handled (${action})`)
		res.json({ success: true, issue: updated, action })
	} catch (err) {
		console.error('[issue] handle-listing error:', err.response?.data || err.message)
		res.status(err.status || err.response?.status || 500).json({ error: err.response?.data?.error_description || err.response?.data?.error || err.message })
	}
})

/**
 * POST /api/issues/:id/handle-listing-manual
 * Marks the Etsy listing action as done by hand (fallback when the API path
 * fails or the operator prefers to do it in Etsy). Body: { action? }.
 */
app.post('/api/issues/:id/handle-listing-manual', (req, res) => {
	const issue = getIssueById(db, req.params.id)
	if (!issue) return res.status(404).json({ error: 'Issue not found' })
	// `undo` clears the local checklist stamp so the operator can redo / re-record
	// it (the Etsy action itself is not reversed — that's intentional).
	if (req.body?.undo) {
		const updated = patchOrderIssue(db, issue.id, { listing_handled_at: null, listing_action: null })
		return res.json({ success: true, issue: updated })
	}
	const action = issue.issue_type === 'out_of_production' ? 'deleted' : issue.issue_type === 'model_unavailable' ? 'model_removed' : 'none'
	const updated = patchOrderIssue(db, issue.id, { listing_handled_at: Math.floor(Date.now() / 1000), listing_action: action })
	res.json({ success: true, issue: updated })
})

/**
 * POST /api/issues/:id/resolve
 * Body: { resolution }  — 'switched' | 'refunded' | 'cancelled' | 'other'
 * Closes the issue. The line stops being held out of the Route (a switched/
 * re-ordered product flows again; refunded/cancelled lines are no longer bought
 * because the order itself is being cancelled/refunded on Etsy by the operator).
 */
app.post('/api/issues/:id/resolve', (req, res) => {
	const resolution = req.body?.resolution
	if (!ISSUE_RESOLUTIONS.includes(resolution)) return res.status(400).json({ error: `resolution must be one of: ${ISSUE_RESOLUTIONS.join(', ')}` })
	const issue = getIssueById(db, req.params.id)
	if (!issue) return res.status(404).json({ error: 'Issue not found' })

	let updated
	const txn = db.transaction(() => {
		updated = patchOrderIssue(db, issue.id, { status: 'resolved', resolution, resolved_at: Math.floor(Date.now() / 1000) })
		recomputeNeedsPurchaseRollup(issue.receipt_id)
	})
	txn()
	console.log(`[issue] ${issue.id} resolved (${resolution})`)
	// Resolving un-holds a switched/re-ordered line (it flows back into purchasing)
	// — refresh live Route/Shopping views.
	broadcastRouteRefresh(issue.receipt_id, 'issue-resolved')
	res.json({ success: true, issue: updated })
})

/**
 * POST /api/issues/:id/reopen
 * Re-opens a resolved issue (clears the resolution) — holds the line again.
 */
app.post('/api/issues/:id/reopen', (req, res) => {
	const issue = getIssueById(db, req.params.id)
	if (!issue) return res.status(404).json({ error: 'Issue not found' })
	let updated
	const txn = db.transaction(() => {
		// Reopening is a DELIBERATE operator hold, so it takes 'manual' ownership.
		// This matters for a switched line: an operator-owned hold raised after a
		// switch is respected (it wins over the switch), whereas an automated shop
		// signal never reverses a switch. Taking ownership here keeps that boundary
		// crisp — a human re-hold sticks, an auto re-raise does not.
		updated = patchOrderIssue(db, issue.id, { status: 'open', resolution: null, resolved_at: null, source: 'manual' })
		recomputeNeedsPurchaseRollup(issue.receipt_id)
	})
	txn()
	// Reopening re-holds the line — refresh live Route/Shopping views.
	broadcastRouteRefresh(issue.receipt_id, 'issue-reopened')
	res.json({ success: true, issue: updated })
})

/**
 * DELETE /api/issues/:id
 * Removes the issue entirely (e.g. flagged in error). The line returns to the
 * normal purchasing workflow.
 */
app.delete('/api/issues/:id', (req, res) => {
	const issue = getIssueById(db, req.params.id)
	if (!issue) return res.status(404).json({ error: 'Issue not found' })
	const txn = db.transaction(() => {
		deleteOrderIssue(db, issue.id)
		recomputeNeedsPurchaseRollup(issue.receipt_id)
	})
	txn()
	// Deleting the issue returns the line to purchasing — refresh live views.
	broadcastRouteRefresh(issue.receipt_id, 'issue-deleted')
	res.json({ success: true })
})

// ─── Design switches (buyer agreed to switch to another design) ──────────────
//
// After a fulfilment issue is flagged and the buyer chooses to SWITCH design
// (rather than refund), the operator picks a replacement — from the product
// catalog or a custom upload. We record it as a LOCAL, non-destructive override:
// the dashboard then renders + purchases the replacement design for this line,
// while the Etsy receipt is NEVER modified and nothing is pushed to Etsy.
//
// Creating a switch auto-resolves any open issue on the line as 'switched' (so
// the line un-holds and flows back into the purchasing queue) and resets its
// purchase status so the new design starts as "still to buy".

/**
 * A receipt's line records for identity / product-context resolution.
 *
 * Prefers the `transactions` table (populated for synced Etsy orders) and falls
 * back to the cached `receipts.all_transactions` JSON — which is the ONLY place a
 * MANUAL order's lines live, since a fabricated receipt has no Etsy transactions
 * to sync. Without the fallback every manual line looked context-free, so an
 * auto-raised issue or model fix on one carried no title / model / listing id.
 *
 * @param {number|string} receiptId
 * @returns {Array<{title:string, listing_id:*, variations:*}>}
 */
function receiptLineRecords(receiptId) {
	try {
		const rows = db.prepare('SELECT title, listing_id, variations FROM transactions WHERE receipt_id = ?').all(Number(receiptId))
		if (rows.length) return rows
	} catch {
		/* table may not exist yet on first run */
	}
	try {
		const row = db.prepare('SELECT all_transactions FROM receipts WHERE receipt_id = ?').get(Number(receiptId))
		const txs = JSON.parse(row?.all_transactions || '[]')
		return Array.isArray(txs) ? txs : []
	} catch {
		return []
	}
}

/** Resolve the original transaction title for a receipt line (for the snapshot). */
function _origTitleForLine(receiptId, itemKey) {
	try {
		const row = db.prepare('SELECT all_transactions FROM receipts WHERE receipt_id = ?').get(receiptId)
		const txs = JSON.parse(row?.all_transactions || '[]')
		const match = lineIdentity.findTransactionByLineKey(db, receiptId, txs, itemKey)
		return match ? match.title || '' : ''
	} catch {
		return ''
	}
}

/**
 * Resolve a listing's canonical cached thumbnail URL, or '' when none is known.
 * Checks the order-driven image cache first, then the canonical `listings` table.
 * Used when a CATALOG design switch is saved: the client sends the catalog
 * thumbnail it happened to have rendered, but that can be blank (the switch grid
 * shows a 📦 placeholder for products whose image hadn't synced). Resolving the
 * replacement LISTING's own image here means the switched line stores — and later
 * renders — the REPLACEMENT design's photo, never silently falling back to the
 * original design the buyer moved away from (the "same old case" bug).
 */
function _resolveListingImageUrl(listingId) {
	const id = Number(listingId)
	if (!Number.isInteger(id)) return ''
	try {
		const r = db.prepare("SELECT url FROM listing_images WHERE listing_id = ? AND url IS NOT NULL AND url <> ''").get(id)
		if (r && r.url) return String(r.url)
	} catch {
		/* table may not exist yet */
	}
	try {
		const r = db.prepare("SELECT primary_image_url FROM listings WHERE listing_id = ? AND primary_image_url IS NOT NULL AND primary_image_url <> ''").get(id)
		if (r && r.primary_image_url) return String(r.primary_image_url)
	} catch {
		/* table may not exist yet */
	}
	return ''
}

/**
 * POST /api/orders/:receipt_id/substitution
 * Body: { item_key, new_title, new_style?, new_phone_model?, source?,
 *         source_listing_id?, image_url?, image_b64?, image_mime?, note? }
 * Creates / updates the local design switch for a line and un-holds it.
 */
app.post('/api/orders/:receipt_id/substitution', express.json({ limit: '25mb' }), (req, res) => {
	const receiptId = Number(req.params.receipt_id)
	const b = req.body || {}
	const itemKey = b.item_key
	const newTitle = String(b.new_title || '').trim()
	if (!itemKey) return res.status(400).json({ error: 'item_key is required' })
	if (!newTitle) return res.status(400).json({ error: 'A replacement product title is required.' })
	const exists = db.prepare('SELECT 1 FROM receipts WHERE receipt_id = ?').get(receiptId)
	if (!exists) return res.status(404).json({ error: 'Order not found' })

	// Decode an optional base64 custom-product image (accepts data: URLs). When no
	// image field is present at all, the stored image (if any) is preserved.
	let imageArgs = {}
	if (Object.prototype.hasOwnProperty.call(b, 'image_b64')) {
		let imageData = null
		let imageMime = String(b.image_mime || '').trim()
		if (b.image_b64 && typeof b.image_b64 === 'string') {
			let raw = b.image_b64.trim()
			const m = /^data:([^;]+);base64,(.*)$/i.exec(raw)
			if (m) {
				imageMime = imageMime || m[1]
				raw = m[2]
			}
			try {
				const buf = Buffer.from(raw, 'base64')
				if (buf.length) imageData = buf
			} catch {
				/* ignore */
			}
		}
		imageArgs = { image_data: imageData, image_mime: imageMime }
	}

	const sourceListingId = b.source_listing_id != null && String(b.source_listing_id).trim() !== '' ? Number(b.source_listing_id) : null
	const substitutionSource =
		b.source === 'catalog' || b.source === 'custom'
			? b.source
			: sourceListingId
				? 'catalog'
				: 'custom'
	if (substitutionSource === 'catalog') {
		const catalogId = Number(b.catalog_id)
		const activeCatalogProduct = getProductMapRow(
			db,
			Number.isInteger(catalogId) && catalogId > 0 ? { id: catalogId } : { title: newTitle },
		)
		if (
			!activeCatalogProduct ||
			activeCatalogProduct.status === 'retired' ||
			activeCatalogProduct.title_norm !== routeDashboard.normalizeTitle(newTitle)
		) {
			return res.status(409).json({
				error: 'That replacement is no longer active in Product Catalog. Refresh and choose another design.',
				code: 'CATALOG_PRODUCT_UNAVAILABLE',
			})
		}
	}
	// Authoritatively resolve the image to persist for the replacement design.
	//   1. an explicit CDN url the client passed (the catalog thumbnail), else
	//   2. for a catalog switch, the replacement LISTING's own cached image — so a
	//      pick whose grid thumbnail hadn't loaded still stores the right photo,
	//   3. else '' → the line renders a neutral placeholder, NEVER the original
	//      design (a custom upload instead rides along as bytes in imageArgs).
	let storedImageUrl = b.image_url != null ? String(b.image_url).trim() : ''
	const hasUploadedImage = imageArgs.image_data instanceof Buffer && imageArgs.image_data.length > 0
	if (!storedImageUrl && !hasUploadedImage && sourceListingId != null) {
		storedImageUrl = _resolveListingImageUrl(sourceListingId)
	}

	let substitution
	let resolvedIssue = null
	const txn = db.transaction(() => {
		substitution = upsertOrderSubstitution(db, {
			receipt_id: receiptId,
			item_key: String(itemKey),
			original_title: b.original_title != null ? String(b.original_title) : _origTitleForLine(receiptId, String(itemKey)),
			new_title: newTitle,
			new_style: b.new_style != null ? String(b.new_style) : null,
			new_phone_model: b.new_phone_model != null ? String(b.new_phone_model) : null,
			source: substitutionSource,
			source_listing_id: sourceListingId,
			image_url: storedImageUrl || null,
			note: typeof b.note === 'string' ? b.note.trim().slice(0, 1000) : null,
			...imageArgs,
		})

		// Auto-resolve an open issue on this line as 'switched' so it un-holds and
		// flows back into purchasing with the new design.
		const open = getIssuesForReceipt(db, receiptId).find((i) => i.item_key === String(itemKey) && i.status === 'open')
		if (open) {
			resolvedIssue = patchOrderIssue(db, open.id, { status: 'resolved', resolution: 'switched', resolved_at: Math.floor(Date.now() / 1000) })
		}

		// Reactivate the line for purchasing. The replacement is a different product
		// the buyer just agreed to, so it must:
		//   • start "still to buy" (statuses → Pending), and
		//   • be pulled back into BOTH purchasing queues even if the original line was
		//     previously EXCLUDED or DISMISSED (common for an already-shipped/completed
		//     order whose line had been set aside). Without clearing those flags the
		//     switched line stays invisible in the Route active list AND the Orders
		//     "Needs purchase" view. We UPSERT so a Pending row always exists (a line
		//     that never had an assignment still enters the queue), stamped with the
		//     new title so the Route reads the switched product.
		// The switched product is a DIFFERENT item, so the line's saved supplier
		// context (from the ORIGINAL product) is now stale and must be cleared:
		//   • a CUSTOM upload isn't in the catalog, so it should read as UNMATCHED —
		//     the operator asks around, then fills in the supplier on the Route tab
		//     (which persists as a fresh override), and
		//   • a CATALOG switch should re-match its OWN supplier by the new title,
		//     which only happens once the stale override is gone.
		// So we wipe supplier_*_override + charm on switch, alongside re-activating
		// the line (excluded/dismissed cleared, statuses → Pending).
		try {
			db.prepare(
				`
				INSERT INTO route_assignments (receipt_id, item_key, title, status_case, status_grip, status_charm, excluded, dismissed_at, supplier_shop_override, supplier_stall_override, charm_code, charm_shop, updated_at)
				VALUES (@receipt_id, @item_key, @title, 'Pending', 'Pending', 'Pending', 0, NULL, '', '', '', '', strftime('%s','now'))
				ON CONFLICT(receipt_id, item_key) DO UPDATE SET
					title = @title,
					status_case = 'Pending', status_grip = 'Pending', status_charm = 'Pending',
					excluded = 0, dismissed_at = NULL,
					supplier_shop_override = '', supplier_stall_override = '',
					charm_code = '', charm_shop = '',
					updated_at = strftime('%s','now')
			`,
			).run({ receipt_id: receiptId, item_key: String(itemKey), title: newTitle })
			// No-component products fall back to the binary buy flag — force it on so
			// a style-less replacement still shows as "to buy".
			db.prepare(`UPDATE receipt_item_purchase SET needs_purchase=1, purchased_at=NULL WHERE receipt_id = ? AND item_key = ?`).run(receiptId, String(itemKey))
		} catch (e) {
			console.warn('[substitution] reactivate warning:', e.message)
		}

		recomputeNeedsPurchaseRollup(receiptId)
	})
	txn()

	logEvent(db, {
		event_type: 'ORDER_SUBSTITUTION',
		shop_name: null,
		listing_id: substitution.source_listing_id || null,
		listing_title: newTitle,
		detail: `Order ${receiptId} line switched to "${newTitle}"${resolvedIssue ? ' (issue resolved: switched)' : ''}`,
		meta: { receipt_id: receiptId, item_key: String(itemKey), source: substitution.source },
	})
	console.log(`[substitution] receipt ${receiptId} line ${itemKey} → "${newTitle}"`)
	// A switch pulls the (un-held) replacement line into the purchasing route with a
	// new title/supplier/image — push a refresh so live Route/Shopping views show it
	// immediately rather than only after a manual reload.
	broadcastRouteRefresh(receiptId, 'substitution')
	res.json({ success: true, substitution, issue: resolvedIssue })
})

/**
 * DELETE /api/orders/:receipt_id/substitution
 * Body: { item_key }
 * Removes the design switch, reverting the line to its original Etsy product.
 */
app.delete('/api/orders/:receipt_id/substitution', express.json(), (req, res) => {
	const receiptId = Number(req.params.receipt_id)
	const itemKey = (req.body || {}).item_key
	if (!itemKey) return res.status(400).json({ error: 'item_key is required' })
	const removed = deleteOrderSubstitution(db, receiptId, String(itemKey))
	if (!removed) return res.status(404).json({ error: 'No design switch found for this line.' })
	recomputeNeedsPurchaseRollup(receiptId)
	// Reverting a switch changes the line back to the original product (title/
	// supplier/image) — refresh live Route/Shopping views.
	broadcastRouteRefresh(receiptId, 'substitution-removed')
	res.json({ success: true })
})

/**
 * GET /api/route/substitution-image/:id
 * Streams the uploaded image bytes for a custom design switch.
 */
app.get('/api/route/substitution-image/:id', (req, res) => {
	const id = parseInt(req.params.id, 10)
	if (!Number.isInteger(id)) return res.status(400).end()
	try {
		const img = getSubstitutionImage(db, id)
		if (!img) return res.status(404).end()
		return sendStoredImage(res, img)
	} catch (err) {
		if (!res.headersSent) res.status(404).end()
	}
})

// ─── Per-variant clarifying images (listing_id + style → uploaded photo) ──────
//
// Etsy serves one hero image per listing, so a line bought as a single component
// (e.g. "Grip 3 Only") still shows the whole case+grip shot — ambiguous for
// whoever sources or packs it. An operator uploads a photo of exactly what the
// buyer gets FOR THAT VARIANT; it then overrides the thumbnail on every order
// (past + future) of the same listing+style, in the Orders tab, the Route and
// mobile picking. It touches ONLY the displayed image — never Etsy, the title,
// the supplier or the purchase state (that's what order_line_substitutions is
// for). A design switch always wins over it.

/**
 * Decode an optional base64 image field (accepts data: URLs) into { data, mime }.
 * Returns { data: null } when no usable image was supplied.
 */
function _decodeBase64Image(b64, mimeHint) {
	let mime = String(mimeHint || '').trim()
	if (!b64 || typeof b64 !== 'string') return { data: null, mime }
	let raw = b64.trim()
	const m = /^data:([^;]+);base64,(.*)$/i.exec(raw)
	if (m) {
		mime = mime || m[1]
		raw = m[2]
	}
	try {
		const buf = Buffer.from(raw, 'base64')
		if (buf.length) return { data: buf, mime: mime || 'image/png' }
	} catch {
		/* ignore malformed base64 */
	}
	return { data: null, mime }
}

/**
 * GET /api/listings/:listing_id/style-image?style=...
 * Returns whether a clarifying image exists for a variant (metadata only), so
 * the editor can show the current photo and offer "revert".
 */
app.get('/api/listings/:listing_id/style-image', (req, res) => {
	const listingId = Number(req.params.listing_id)
	if (!Number.isInteger(listingId)) return res.status(400).json({ error: 'Invalid listing id' })
	const meta = getListingStyleImageMeta(db, listingId, String(req.query.style || ''))
	res.json({
		success: true,
		exists: !!meta,
		style_image: meta ? { id: meta.id, style_value: meta.style_value, note: meta.note, updated_at: meta.updated_at, image_url: `/api/route/style-image/${meta.id}?v=${meta.updated_at || 0}` } : null,
	})
})

/**
 * POST /api/listings/:listing_id/style-image
 * Body: { style?, image_b64, image_mime?, note? }
 * Upserts the clarifying image for (listing_id, style).
 */
app.post('/api/listings/:listing_id/style-image', express.json({ limit: '25mb' }), (req, res) => {
	const listingId = Number(req.params.listing_id)
	if (!Number.isInteger(listingId)) return res.status(400).json({ error: 'Invalid listing id' })
	const b = req.body || {}
	const { data, mime } = _decodeBase64Image(b.image_b64, b.image_mime)
	if (!data) return res.status(400).json({ error: 'A valid image is required.' })

	const styleImage = upsertListingStyleImage(db, {
		listing_id: listingId,
		style_value: b.style != null ? String(b.style) : '',
		image_data: data,
		image_mime: mime,
		note: typeof b.note === 'string' ? b.note.trim().slice(0, 1000) : '',
	})

	logEvent(db, {
		event_type: 'LISTING_STYLE_IMAGE',
		shop_name: null,
		listing_id: listingId,
		listing_title: null,
		detail: `Custom variant image set for listing ${listingId}${styleImage.style_value ? ` (${styleImage.style_value})` : ''}`,
		meta: { listing_id: listingId, style: styleImage.style_value },
	})
	res.json({ success: true, style_image: { ...styleImage, image_url: `/api/route/style-image/${styleImage.id}?v=${styleImage.updated_at || 0}` } })
})

/**
 * DELETE /api/listings/:listing_id/style-image
 * Body: { style? }
 * Removes the override, reverting the variant to the Etsy listing image.
 */
app.delete('/api/listings/:listing_id/style-image', express.json(), (req, res) => {
	const listingId = Number(req.params.listing_id)
	if (!Number.isInteger(listingId)) return res.status(400).json({ error: 'Invalid listing id' })
	const removed = deleteListingStyleImage(db, listingId, String((req.body || {}).style || ''))
	if (!removed) return res.status(404).json({ error: 'No custom image found for this variant.' })
	res.json({ success: true })
})

/**
 * GET /api/route/style-image/:id
 * Streams the uploaded clarifying image bytes for a variant.
 */
app.get('/api/route/style-image/:id', (req, res) => {
	const id = parseInt(req.params.id, 10)
	if (!Number.isInteger(id)) return res.status(400).end()
	try {
		const img = getListingStyleImage(db, id)
		if (!img) return res.status(404).end()
		return sendStoredImage(res, img)
	} catch (err) {
		if (!res.headersSent) res.status(404).end()
	}
})

// ─── Model fixes (this line must be fulfilled with a DIFFERENT device model) ─
//
// Distinct from order_issues: the buyer still receives a working product for the
// device they actually have. A model fix takes one of two shapes, decided solely
// by whether we already hold a physical wrong-model item (see the boundary
// helpers in src/route/dashboard.js):
//
//   SWAP (have_model set)   — the item is in hand in the wrong model. Nothing is
//        bought; it is carried back to the stall and swapped. The generation-
//        specific unit (iPhone: the case; AirPods: the case and its attached
//        charm) is held OUT of the purchasing Route and surfaced in the "To
//        exchange" bucket so staff never mistake it for done and ship the wrong
//        model.
//   BUY  (have_model blank) — we hold nothing, so the corrected model is bought
//        exactly like any other case. The line STAYS in the purchasing Route,
//        now naming the corrected model, and settles itself the moment that unit
//        is marked Purchased (see settleBoughtModelFixes).
//
// Cross-family corrections (iPhone ↔ AirPods) are refused: those are different
// products, not a generation swap.

/**
 * Resolve the fulfilment identity of a line (title / model / present pieces)
 * honouring a design switch, so a model fix covers the product we will actually
 * pack — not the original the buyer already moved away from.
 */
function resolveLineForModelFix(receiptId, itemKey, fallbackTitle) {
	let title = fallbackTitle || ''
	let phoneModel = ''
	let style = ''
	try {
		const row = db.prepare('SELECT all_transactions FROM receipts WHERE receipt_id = ?').get(Number(receiptId))
		const txs = JSON.parse(row?.all_transactions || '[]')
		const match = lineIdentity.findTransactionByLineKey(db, receiptId, txs, itemKey)
		if (match) {
			title = match.title || title
			const parsed = routeDashboard.parseVariations(match.variations)
			phoneModel = parsed.phoneModel || ''
			style = parsed.style || ''
		}
	} catch {
		/* receipt may be a manual line with no Etsy transactions */
	}
	try {
		const sub = getSubstitutionForLine(db, Number(receiptId), String(itemKey))
		if (sub) {
			if (sub.new_title) title = sub.new_title
			if (sub.new_phone_model) phoneModel = sub.new_phone_model
			if (sub.new_style) style = sub.new_style
		}
	} catch {
		/* table may not exist yet */
	}
	const comps = routeDashboard.styleComponents(style, { phoneModel, title })
	return {
		title,
		phone_model: phoneModel,
		style,
		has_case: !!comps.hasCase,
		has_grip: !!comps.hasGrip,
		has_charm: !!comps.hasCharm,
		charm_integral: !!(comps.hasCharm && routeDashboard.isAirpodsProduct(phoneModel, title)),
	}
}

/**
 * The open model fix on one order line, or null.
 * @returns {object|null} the `order_exchanges` row
 */
function getOpenExchangeForLine(receiptId, itemKey) {
	try {
		return db.prepare("SELECT * FROM order_exchanges WHERE receipt_id = ? AND item_key = ? AND status = 'open'").get(Number(receiptId), String(itemKey)) || null
	} catch {
		return null // table may not exist yet on a fresh DB
	}
}

/**
 * The components a model fix covers. Prefers the stored list (so a deliberate
 * write is honoured), then this line's generation-specific unit, then 'case'.
 * AirPods self-heal: an integral charm rides with a covered case even on
 * legacy records that only stored "case".
 * @returns {string[]}
 */
function exchangeCoveredComponents(exchange, line) {
	const comps = String((exchange && exchange.components) || '')
		.split(',')
		.map((c) => c.trim().toLowerCase())
		.filter((c) => routeDashboard.EXCHANGE_COMPONENTS.includes(c))
	const resolved = line || (exchange ? resolveLineForModelFix(exchange.receipt_id, exchange.item_key, exchange.title) : null)
	const base = comps.length ? comps.slice() : routeDashboard.modelFixCoveredComponents(resolved)
	const held = new Set(base)
	if (resolved) {
		const airpods = !!resolved.charm_integral || routeDashboard.isAirpodsProduct(resolved.phone_model, resolved.title)
		if (airpods && resolved.has_charm) {
			if (held.has('case')) held.add('charm')
			if (!resolved.has_case) {
				held.delete('case')
				held.add('charm')
			}
		}
	}
	const ordered = routeDashboard.EXCHANGE_COMPONENTS.filter((c) => held.has(c))
	return ordered.length ? ordered : ['case']
}

/**
 * Put the pieces a BUY model fix covers back to 'Pending'.
 *
 * A buy means we do NOT hold the item: whatever the line's case status said
 * before (Purchased for the wrong model, or Out of Stock for a model we are no
 * longer buying) describes a product we are not going to ship. Leaving that
 * status in place would let the corrected case be counted as already bought, and
 * the line would vanish from every shopping surface without anyone buying it.
 */
function resetComponentsForBuyModelFix(receiptId, exchange) {
	const patch = { receipt_id: Number(receiptId), item_key: String(exchange.item_key), title: exchange.title || undefined }
	for (const comp of exchangeCoveredComponents(exchange)) patch[`status_${comp}`] = 'Pending'
	upsertRouteAssignment(db, patch)
	// A pending component is by definition not verified as in hand any more.
	clearRouteVerified(db, Number(receiptId), String(exchange.item_key))
}

/**
 * Close any BUY model fix on a line whose covered components are now all
 * Purchased — the corrected model has been bought, so the fix is fulfilled.
 *
 * This is what keeps the buy shape self-settling. Without it the record would
 * stay open after the shopper bought the right case, leaving a permanent, unclosable
 * "still to fix" entry that nobody can act on, and requiring a second, redundant
 * confirmation click before the order is considered finished. SWAP fixes are
 * deliberately untouched: their components are Purchased by design from the
 * start, so auto-closing them would discard the swap before it happened.
 *
 * Safe to call after any component-status write. Returns the ids it closed.
 *
 * @param {number} receiptId
 * @param {string} itemKey
 * @returns {number[]}
 */
function settleBoughtModelFixes(receiptId, itemKey) {
	const exchange = getOpenExchangeForLine(receiptId, itemKey)
	if (!exchange) return []
	if (routeDashboard.exchangeRecordIntent(exchange) !== routeDashboard.EXCHANGE_INTENT_BUY) return []

	const assignment = db.prepare('SELECT * FROM route_assignments WHERE receipt_id = ? AND item_key = ?').get(Number(receiptId), String(itemKey)) || {}
	const allBought = exchangeCoveredComponents(exchange).every((comp) => (assignment[`status_${comp}`] || 'Pending') === 'Purchased')
	if (!allBought) return []

	patchOrderExchange(db, exchange.id, { status: 'done', done_at: Math.floor(Date.now() / 1000) })
	console.log(`[model-fix] ${exchange.id} auto-settled — corrected model "${exchange.need_model}" purchased on receipt ${receiptId}`)
	return [exchange.id]
}

/**
 * Boot-time self-heal: close BUY model fixes whose covered components are ALREADY
 * Purchased.
 *
 * Before the swap/buy boundary existed, a buy-shaped fix held its case out of the
 * buy set exactly like a swap, so a record can be left open with its case marked
 * Purchased — a contradiction: the corrected model is in hand, yet the order still
 * reads as owing a fix, and nothing would ever close it. This applies the same
 * decision settleBoughtModelFixes makes on every purchase to that history. It only
 * ever CLOSES records and never writes a component status, so it cannot discard an
 * operator's work; orders whose corrected case is still unbought are left alone to
 * flow through the shopping route normally.
 */
function settleAlreadyBoughtModelFixes() {
	let settled = 0
	try {
		const open = db.prepare("SELECT receipt_id, item_key, have_model FROM order_exchanges WHERE status = 'open'").all()
		for (const row of open) {
			if (routeDashboard.exchangeRecordIntent(row) !== routeDashboard.EXCHANGE_INTENT_BUY) continue
			db.transaction(() => {
				if (settleBoughtModelFixes(row.receipt_id, row.item_key).length) {
					settled++
					recomputeNeedsPurchaseRollup(row.receipt_id)
				}
			})()
		}
	} catch (e) {
		console.warn('[model-fix] boot reconcile failed:', e.message)
	}
	if (settled) console.log(`[model-fix] reconciled ${settled} already-purchased model fix(es) at boot`)
}

/**
 * GET /api/fulfilment/device-models
 * Canonical fit values per device family for the model-fix UI: iPhone / AirPods
 * generations, the Apple Watch band sizes and the iPad models. On a single-axis
 * line the priced axis IS the only fit dimension, so that is what a model fix
 * corrects there.
 * Single source of truth: src/listings/product-types.js (never duplicate in the client).
 */
app.get('/api/fulfilment/device-models', (_req, res) => {
	res.json({
		iphone: canonicalModelsForFamily(FAMILY_IPHONE),
		airpods: canonicalModelsForFamily(FAMILY_AIRPODS),
		watch: canonicalModelsForFamily(FAMILY_WATCH),
		ipad: canonicalModelsForFamily(FAMILY_IPAD),
	})
})

/**
 * GET /api/orders/:receipt_id/exchanges
 * Lists every model fix (open + done) on an order.
 */
app.get('/api/orders/:receipt_id/exchanges', (req, res) => {
	const exists = db.prepare('SELECT 1 FROM receipts WHERE receipt_id = ?').get(req.params.receipt_id)
	if (!exists) return res.status(404).json({ error: 'Order not found' })
	res.json({ exchanges: getExchangesForReceipt(db, req.params.receipt_id) })
})

/**
 * POST /api/orders/:receipt_id/exchanges
 * Body: { item_key, have_model, need_model?, components?, listing_id?, title?,
 *         supplier_shop?, supplier_stall?, note? }
 * Flags (or re-opens) a line as a wrong-model exchange. This holds the line out of
 * the buy set (we have it) and adds it to the "To exchange" swap list.
 */
app.post('/api/orders/:receipt_id/exchanges', (req, res) => {
	const receiptId = Number(req.params.receipt_id)
	const b = req.body || {}
	const itemKey = b.item_key
	if (!itemKey) return res.status(400).json({ error: 'item_key is required' })
	// have_model is OPTIONAL: present ⇒ we hold a wrong model to SWAP at the
	// supplier; absent ⇒ we hold nothing and must BUY the correct model (a buyer
	// model-change with no matching stock). need_model — the model to actually
	// pack — is the authoritative field and is required in both cases.
	const haveModel = typeof b.have_model === 'string' ? b.have_model.trim() : ''
	const needModel = typeof b.need_model === 'string' ? b.need_model.trim() : ''
	if (!needModel) return res.status(400).json({ error: 'need_model (the model the order needs / you will pack) is required' })
	if (haveModel && haveModel.toLowerCase() === needModel.toLowerCase()) {
		return res.status(400).json({ error: 'The model you have and the model the order needs are the same — there is nothing to fix.' })
	}
	const exists = db.prepare('SELECT 1 FROM receipts WHERE receipt_id = ?').get(receiptId)
	if (!exists) return res.status(404).json({ error: 'Order not found' })

	// Cover the generation-specific unit for THIS line. The client is not trusted
	// with the component set (older clients always posted "case"; a grip on an
	// iPhone line must stay shoppable; an AirPods attached charm must travel
	// with the case).
	const line = resolveLineForModelFix(receiptId, itemKey, b.title)
	const lineFamily = deviceFamilyOf(line.phone_model, line.title)
	const needErr = crossFamilyModelError(lineFamily, needModel)
	if (needErr) return res.status(400).json({ error: needErr })
	const haveErr = haveModel ? crossFamilyModelError(lineFamily, haveModel) : null
	if (haveErr) return res.status(400).json({ error: haveErr })
	const components = routeDashboard.modelFixCoveredComponents(line).join(',')

	const intent = routeDashboard.modelFixIntentFrom(haveModel)
	// What the line was under BEFORE this save decides whether the purchase state
	// has to start over. Re-saving an unchanged buy (e.g. editing only the note)
	// must NOT wipe out a shopper's progress, so we reset only when the fix is
	// genuinely new, changed shape (swap → buy), or now targets a DIFFERENT model
	// than the one already bought against.
	const prior = getOpenExchangeForLine(receiptId, itemKey)
	const priorIntent = routeDashboard.exchangeRecordIntent(prior)
	const targetModelChanged = !prior || String(prior.need_model || '').trim() !== needModel
	const restartsPurchasing = intent === routeDashboard.EXCHANGE_INTENT_BUY && (priorIntent !== routeDashboard.EXCHANGE_INTENT_BUY || targetModelChanged)

	let exchange
	const txn = db.transaction(() => {
		exchange = upsertOrderExchange(db, {
			receipt_id: receiptId,
			item_key: String(itemKey),
			listing_id: b.listing_id,
			title: b.title,
			have_model: haveModel || null,
			need_model: needModel,
			components,
			supplier_shop: typeof b.supplier_shop === 'string' ? b.supplier_shop.trim() : null,
			supplier_stall: typeof b.supplier_stall === 'string' ? b.supplier_stall.trim() : null,
			note: typeof b.note === 'string' ? b.note.trim().slice(0, 1000) : null,
		})
		if (restartsPurchasing) resetComponentsForBuyModelFix(receiptId, exchange)
		// Changing what a line owes must re-derive the order's needs-purchase
		// rollup: a swap holds it out of buying (it can't be both "buy this" and
		// "already in hand"), while a buy puts it back in.
		recomputeNeedsPurchaseRollup(receiptId)
	})
	txn()

	console.log(`[model-fix] receipt ${receiptId} line ${itemKey} flagged: ${intent === routeDashboard.EXCHANGE_INTENT_SWAP ? `swap "${haveModel}" → "${needModel}"` : `buy "${needModel}" (nothing in hand to swap)`}`)
	// Either shape changes what the shopper on the floor should be doing with this
	// line — a buy puts it in the buy list under the corrected model, a swap pulls
	// it out and into "To exchange" — and this endpoint is also how a fix is
	// CHANGED from one shape to the other. Announce every write so live clients
	// re-partition immediately; the handler re-fetches, which is correct for both
	// directions. Staying silent on swaps left shoppers buying a case we'd just
	// decided to swap, until someone happened to refresh.
	broadcastRouteEvent({
		type: 'exchange',
		exchange_id: exchange.id,
		receipt_id: receiptId,
		status: 'open',
		by: (req.auth && req.auth.user) || 'owner',
	})
	res.json({ success: true, exchange })
})

/**
 * POST /api/exchanges/:id/done
 * Marks the fix complete — the swap was made at the stall, or the corrected
 * model was bought. The affected components are flipped to Purchased so the line
 * becomes genuinely fulfilled and the order can ship.
 */
app.post('/api/exchanges/:id/done', (req, res) => {
	const exchange = getExchangeById(db, req.params.id)
	if (!exchange) return res.status(404).json({ error: 'Exchange not found' })

	let updated
	const txn = db.transaction(() => {
		updated = patchOrderExchange(db, exchange.id, { status: 'done', done_at: Math.floor(Date.now() / 1000) })
		// The pieces are now the correct model and in hand → Purchased, so the line
		// drops from every buy view and the order becomes ready to ship.
		const patch = { receipt_id: exchange.receipt_id, item_key: exchange.item_key, title: exchange.title || undefined }
		for (const comp of exchangeCoveredComponents(exchange)) patch[`status_${comp}`] = 'Purchased'
		upsertRouteAssignment(db, patch)
		recomputeNeedsPurchaseRollup(exchange.receipt_id)
	})
	txn()
	console.log(`[model-fix] ${exchange.id} marked done (${routeDashboard.exchangeRecordIntent(exchange)})`)
	// Notify live shopping-route clients so the exchange drops off every device.
	broadcastRouteEvent({
		type: 'exchange',
		exchange_id: exchange.id,
		receipt_id: exchange.receipt_id,
		status: 'done',
		by: (req.auth && req.auth.user) || 'owner',
	})
	res.json({ success: true, exchange: updated })
})

/**
 * POST /api/exchanges/:id/reopen
 * Re-opens a completed model fix (the swap fell through, or the case bought was
 * still the wrong model). A SWAP goes back to being held out of buying and
 * returns to the "To exchange" bucket; a BUY returns to the shopping route with
 * its components reset, since marking it done had flipped them to Purchased and
 * leaving them there would hide the line the operator just said is unfinished.
 */
app.post('/api/exchanges/:id/reopen', (req, res) => {
	const exchange = getExchangeById(db, req.params.id)
	if (!exchange) return res.status(404).json({ error: 'Exchange not found' })
	let updated
	const txn = db.transaction(() => {
		updated = patchOrderExchange(db, exchange.id, { status: 'open', done_at: null })
		if (routeDashboard.exchangeRecordIntent(exchange) === routeDashboard.EXCHANGE_INTENT_BUY) {
			resetComponentsForBuyModelFix(exchange.receipt_id, exchange)
		}
		recomputeNeedsPurchaseRollup(exchange.receipt_id)
	})
	txn()
	// Tell live shopping-route clients to resync so the swap reappears everywhere.
	broadcastRouteEvent({
		type: 'exchange',
		exchange_id: exchange.id,
		receipt_id: exchange.receipt_id,
		status: 'open',
		by: (req.auth && req.auth.user) || 'owner',
	})
	res.json({ success: true, exchange: updated })
})

/**
 * DELETE /api/exchanges/:id
 * Removes the exchange entirely (flagged in error). The line returns to the
 * normal purchasing workflow.
 */
app.delete('/api/exchanges/:id', (req, res) => {
	const exchange = getExchangeById(db, req.params.id)
	if (!exchange) return res.status(404).json({ error: 'Exchange not found' })
	const txn = db.transaction(() => {
		deleteOrderExchange(db, exchange.id)
		recomputeNeedsPurchaseRollup(exchange.receipt_id)
	})
	txn()
	res.json({ success: true })
})

// ─── Packaged flag (pre-transit parcel ready for carrier pickup) ─────────────
//
// Use case: a shipping label is created on Etsy to hit the ship-by deadline
// (the order becomes Pre-transit). The operator then physically packs the
// parcel. Marking it "packaged" lets the team filter the Pre-transit view into
// two buckets — parcels sitting on the packing bench vs. parcels fully packed
// and waiting for the carrier. This removes ambiguity in high-volume fulfilment
// where dozens of pre-transit orders may be at different physical stages.
//
// Purely local/operational — never pushed to Etsy.
// Preserved across Etsy re-syncs (upsertReceipt never touches this column).

/**
 * Which of the given orders CANNOT be sealed (marked packaged) yet, and why.
 *
 * Packing is a physical, terminal action: you cannot seal a parcel that isn't
 * fully in hand. An order is sealable exactly when it would qualify for the
 * Ready-to-pack queue on purchase grounds — every product Purchased/in hand
 * (classifyPurchaseState `ready`), NO open fulfilment issue (out of production /
 * model unavailable), and NO open wrong-model exchange. This is the guard that
 * PREVENTS the inconsistent "packaged but still needs purchase" state at the
 * source, rather than hiding it after the fact.
 *
 * Computes everything in a bounded number of queries (one classify pass + two
 * indexed lookups) so it is cheap even for a large bulk selection.
 *
 * @param {Array<number|string>} receiptIds
 * @returns {Map<number, string>} receipt_id → human-readable blocking reason (only
 *          the NOT-sealable orders are present; a sealable order is absent).
 */
function unsealableReasons(receiptIds) {
	return getUnsealableReasons(db, receiptIds, config)
}

/**
 * POST /api/orders/:receipt_id/mark-packaged
 * Marks the order as physically packaged and ready for carrier pickup. Idempotent —
 * the original timestamp is preserved if the flag is already set. Refuses to seal
 * an order that isn't fully in hand (see unsealableReasons), so the inconsistent
 * "packaged but still needs purchase" state can never be created.
 */
app.post('/api/orders/:receipt_id/mark-packaged', (req, res) => {
	const receiptId = Number(req.params.receipt_id)
	const exists = db.prepare('SELECT packaged_at FROM receipts WHERE receipt_id = ?').get(receiptId)
	if (!exists) return res.status(404).json({ error: 'Order not found' })
	// Idempotent: if it's already packaged, don't re-check (allows re-confirming an
	// order sealed before this guard existed). Only NEW seals are guarded.
	if (!exists.packaged_at) {
		const reason = unsealableReasons([receiptId]).get(receiptId)
		if (reason) {
			return res.status(409).json({ error: `Can't mark this order packaged — it ${reason}. Finish it first.`, code: 'NOT_SEALABLE' })
		}
	}

	const nowEpoch = Math.floor(Date.now() / 1000)
	const result = db
		.prepare(
			`
    UPDATE receipts SET
      packaged_at = COALESCE(packaged_at, @packaged_at)
    WHERE receipt_id = @receipt_id
  `,
		)
		.run({ receipt_id: req.params.receipt_id, packaged_at: nowEpoch })

	if (result.changes === 0) return res.status(404).json({ error: 'Order not found' })
	_captureAuditOrderProductSnapshot(res, receiptId)
	console.log(`[packaged] receipt ${req.params.receipt_id} marked as packaged`)
	res.json({ success: true, receipt_id: req.params.receipt_id, packaged_at: nowEpoch })
})

/**
 * POST /api/orders/:receipt_id/unmark-packaged
 * Clears the packaged flag, returning the order to the "not yet packaged" state.
 */
app.post('/api/orders/:receipt_id/unmark-packaged', (req, res) => {
	const receiptId = Number(req.params.receipt_id)
	const result = db.prepare('UPDATE receipts SET packaged_at = NULL WHERE receipt_id = ?').run(receiptId)

	if (result.changes === 0) return res.status(404).json({ error: 'Order not found' })
	_captureAuditOrderProductSnapshot(res, receiptId)
	console.log(`[packaged] receipt ${req.params.receipt_id} packaged flag cleared`)
	res.json({ success: true, receipt_id: req.params.receipt_id })
})

/**
 * POST /api/orders/bulk-mark-packaged
 * Body: { receipt_ids: number[], packaged: boolean }
 * Bulk set (packaged=true) or clear (packaged=false) the packaged_at flag.
 * Setting is idempotent — orders already flagged keep their original timestamp.
 */
app.post('/api/orders/bulk-mark-packaged', (req, res) => {
	const { receipt_ids, packaged } = req.body || {}
	if (!Array.isArray(receipt_ids) || receipt_ids.length === 0) {
		return res.status(400).json({ error: 'receipt_ids must be a non-empty array' })
	}
	const ids = receipt_ids.map(Number).filter((n) => Number.isFinite(n))
	if (ids.length === 0) return res.status(400).json({ error: 'No valid receipt IDs provided' })

	const nowEpoch = Math.floor(Date.now() / 1000)
	let changed
	let skipped = []
	if (packaged) {
		// Seal only the orders that are actually sealable; skip (never fail) the rest
		// and report them, mirroring the bulk-4PX "do the valid ones, tell you what
		// was left" pattern. An already-packaged order in the selection is left as-is
		// (its guard is bypassed) so a mixed re-confirm never trips.
		const already = new Set(
			db
				.prepare(`SELECT receipt_id FROM receipts WHERE packaged_at IS NOT NULL AND receipt_id IN (${ids.map(() => '?').join(',')})`)
				.all(...ids)
				.map((r) => r.receipt_id),
		)
		const toCheck = ids.filter((id) => !already.has(id))
		const reasons = unsealableReasons(toCheck)
		skipped = [...reasons.entries()].map(([receipt_id, reason]) => ({ receipt_id, reason }))
		const sealable = ids.filter((id) => !reasons.has(id))
		if (sealable.length) {
			const ph2 = sealable.map(() => '?').join(',')
			changed = db.prepare(`UPDATE receipts SET packaged_at = COALESCE(packaged_at, ?) WHERE receipt_id IN (${ph2})`).run(nowEpoch, ...sealable).changes
		} else {
			changed = 0
		}
	} else {
		const ph = ids.map(() => '?').join(',')
		changed = db.prepare(`UPDATE receipts SET packaged_at = NULL WHERE receipt_id IN (${ph})`).run(...ids).changes
	}
	console.log(`[packaged] bulk ${packaged ? 'mark' : 'unmark'} — ${changed} receipt(s) updated${skipped.length ? `, ${skipped.length} skipped (not sealable)` : ''}`)
	res.json({ success: true, changed, skipped, packaged: packaged !== false })
})

// ─── Manual orders (operator-created orders in the Orders tab) ────────────────
//
// A manual order is a real `receipts` row authored by the operator for a sale
// that did not come from Etsy (off-Etsy / replacement / wholesale). It carries a
// negative receipt_id + source='manual' and is otherwise a first-class order:
// it shows in the Orders tab, can be marked packaged, shipped with 4PX, and have
// its label downloaded — all through the SAME endpoints Etsy orders use. It is
// never pushed to or fetched from Etsy.

/**
 * Resolve { shop_id, group_id } for a manual order. Manual orders live under the
 * dedicated synthetic "Manual Orders" shop by default; a real shop_id may still
 * be supplied to attribute the order to a specific shop.
 */
function resolveManualOrderShop(rawShopId) {
	const shopId = String(rawShopId || '').trim() || MANUAL_SHOP_ID
	const shop = db.prepare('SELECT shop_id, group_id FROM shops WHERE shop_id = ?').get(shopId)
	if (!shop) {
		const e = new Error(`Unknown shop "${shopId}".`)
		e.status = 400
		throw e
	}
	return { shop_id: shop.shop_id, group_id: shop.group_id }
}

/**
 * POST /api/orders/manual
 * Create a manual order. Body: {
 *   shop_id, name, buyer_email?, shipping_first_line?, shipping_second_line?,
 *   shipping_city?, shipping_state?, shipping_zip?, shipping_country_iso?,
 *   items: [{ title, quantity?, listing_id? }], grandtotal_amount?,
 *   grandtotal_currency?, message_from_buyer?, team_note?
 * }
 */
app.post('/api/orders/manual', (req, res) => {
	try {
		const b = req.body ?? {}
		if (!String(b.name || '').trim()) {
			return res.status(400).json({ error: 'Buyer name is required.' })
		}
		const { shop_id, group_id } = resolveManualOrderShop(b.shop_id)
		const { receipt_id } = insertManualOrder(db, { ...b, shop_id, group_id, requireName: true })
		console.log(`[manual-order] created receipt ${receipt_id} for shop ${shop_id} — buyer "${String(b.name || '').trim()}"`)
		res.status(201).json({ success: true, receipt_id })
	} catch (err) {
		const status = err.status || (err.code === 'REQUIRED' ? 400 : 500)
		if (status >= 500) console.error('[manual-order] create error:', err.message)
		res.status(status).json({ error: err.message })
	}
})

/**
 * PUT /api/orders/manual/:receipt_id
 * Edit a manual order's buyer / address / items. Etsy orders are rejected.
 */
app.put('/api/orders/manual/:receipt_id', (req, res) => {
	try {
		const ok = updateManualOrder(db, req.params.receipt_id, req.body ?? {})
		if (!ok) return res.status(404).json({ error: 'Manual order not found.' })
		res.json({ success: true, receipt_id: Number(req.params.receipt_id) })
	} catch (err) {
		const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'FORBIDDEN' ? 403 : err.code === 'REQUIRED' ? 400 : 500
		if (status >= 500) console.error('[manual-order] update error:', err.message)
		res.status(status).json({ error: err.message })
	}
})

/**
 * DELETE /api/orders/manual/:receipt_id
 * Permanently delete a manual order. Blocked while a 4PX shipment still exists —
 * the operator must cancel the 4PX order first so no label is orphaned.
 */
app.delete('/api/orders/manual/:receipt_id', (req, res) => {
	try {
		const rid = Number(req.params.receipt_id)
		const force = req.query.force === 'true' || req.query.force === '1'
		const row = db.prepare('SELECT source, fourpx_consignment_no, fourpx_order_status FROM receipts WHERE receipt_id = ?').get(rid)
		if (!row) return res.status(404).json({ error: 'Manual order not found.' })
		if (row.source !== 'manual') return res.status(403).json({ error: 'Only manual orders can be deleted.' })
		// Block only while an ACTIVE 4PX shipment exists. A shipment that has already
		// been cancelled keeps its consignment number on the receipt, so checking the
		// presence of fourpx_consignment_no alone would wrongly block deletion forever.
		// `force` lets the operator override when the parcel already shipped and the
		// 4PX order can no longer be cancelled — the local manual order is removed,
		// the dispatched label/parcel is unaffected.
		if (row.fourpx_consignment_no && row.fourpx_order_status !== 'cancelled' && !force) {
			return res.status(409).json({ error: 'This manual order has a 4PX shipment. Cancel the 4PX shipment first, then delete it.', code: 'HAS_4PX_SHIPMENT' })
		}
		const ok = deleteManualOrder(db, rid)
		if (!ok) return res.status(404).json({ error: 'Manual order not found.' })
		console.log(`[manual-order] deleted receipt ${rid}`)
		res.json({ success: true })
	} catch (err) {
		const status = err.code === 'FORBIDDEN' ? 403 : 500
		if (status >= 500) console.error('[manual-order] delete error:', err.message)
		res.status(status).json({ error: err.message })
	}
})

/**
 * POST /api/orders/manual/:receipt_id/shipped
 * Body: { shipped: boolean }
 * Toggle a manual order's LOCAL shipped state (manual orders never touch Etsy).
 */
app.post('/api/orders/manual/:receipt_id/shipped', (req, res) => {
	try {
		const shipped = req.body?.shipped !== false
		const ok = setManualOrderShipped(db, req.params.receipt_id, shipped)
		if (!ok) return res.status(404).json({ error: 'Manual order not found.' })
		// Keep the completion ledger in step. Un-shipping is a deliberate operator
		// reversal, so any outstanding obligation is retired rather than left for
		// the reconciler to undo the decision a minute later.
		if (shipped) etsyCompletion.markDone(db, req.params.receipt_id)
		else etsyCompletion.markSkipped(db, req.params.receipt_id, { reason: 'Operator marked the order unshipped' })
		res.json({ success: true, receipt_id: Number(req.params.receipt_id), shipped })
	} catch (err) {
		const status = err.status || (err.code === 'NOT_FOUND' ? 404 : err.code === 'FORBIDDEN' ? 403 : 500)
		if (status >= 500) console.error('[manual-order] shipped toggle error:', err.message)
		res.status(status).json({ error: err.message })
	}
})

/**
 * POST /api/orders/manual/:receipt_id/tracking
 * Body: { tracking_code, carrier_name? }
 * Attach (or, with an empty tracking_code, clear) a tracking number on a manual
 * order so its parcel can be tracked — for packages already shipped via 4PX (or
 * another carrier) outside the integrated "Ship with 4PX" flow. Setting a number
 * marks the manual order locally shipped; manual orders never touch Etsy.
 */
app.post('/api/orders/manual/:receipt_id/tracking', (req, res) => {
	try {
		const { tracking_code, carrier_name } = req.body ?? {}
		const ok = setManualOrderTracking(db, req.params.receipt_id, { tracking_code, carrier_name })
		if (!ok) return res.status(404).json({ error: 'Manual order not found.' })
		const tracking = String(tracking_code || '').trim()
		console.log(`[manual-order] receipt ${req.params.receipt_id} tracking ${tracking ? `set to "${tracking}"` : 'cleared'}`)
		res.json({ success: true, receipt_id: Number(req.params.receipt_id), tracking_code: tracking })
	} catch (err) {
		const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'FORBIDDEN' ? 403 : 500
		if (status >= 500) console.error('[manual-order] tracking update error:', err.message)
		res.status(status).json({ error: err.message })
	}
})

// ─── Needs-purchase / out-of-stock tracking (line-item & component aware) ────────
//
// Use case: order volume is high and a product goes out of stock right as the Etsy
// ship-by deadline arrives. The operator creates a label + marks the order shipped on
// Etsy (so it shows "Pre-transit"), but the product still has to be bought.
//
// Two levels of granularity:
//   • LINE ITEM   — an order can hold several products; product A may be in stock while
//                   product B is not. Products with NO recognised Case/Grip/Charm style
//                   use the binary receipt_item_purchase flag.
//   • COMPONENT   — a single product is often "Case+Grip+Charm"; the case may be bought
//                   while the grip is not. Component purchase status is stored in
//                   route_assignments.status_{case,grip,charm} — the SAME table the Route
//                   tab edits — so the Orders tab and the Route tab stay perfectly in sync.
//
// receipts.needs_purchase_at is a denormalised ORDER rollup that gates whether a
// PRE-TRANSIT order is pulled into the purchasing Route. It is auto-managed: set while a
// pre-transit order still has outstanding purchasing work, cleared once everything is
// bought. (Unshipped orders are already in the Route by default, so they are never
// auto-flagged — their component edits simply sync straight through.)
//
// Purely local/operational — never pushed to Etsy.

const PURCHASE_OUTSTANDING_STATUSES = new Set(['Pending', 'Out of Stock', 'Wrong Stall'])
const VALID_PURCHASE_STATUSES = new Set(['Pending', 'Purchased', 'Out of Stock', 'Out of Production', 'Wrong Stall', 'Model Unavailable'])

/**
 * Present Case/Grip/Charm components implied by a Style string. `line` (the
 * effective model + title) lets a single-axis product — a watch band, whose
 * only variation is its size — still declare its one physical unit.
 */
function componentsFromStyle(style, line) {
	const sc = routeDashboard.styleComponents(style, line)
	const out = []
	if (sc.hasCase) out.push('case')
	if (sc.hasGrip) out.push('grip')
	if (sc.hasCharm) out.push('charm')
	return out
}

/**
 * Parse a receipt's line items into [{ item_key, title, components[] }] (deduped).
 * Substitution-aware: a switched line's components/title reflect the REPLACEMENT
 * design (so the purchasing rollup buys the right product), never the original.
 */
function orderLineItems(receiptId) {
	const row = db.prepare('SELECT all_transactions FROM receipts WHERE receipt_id = ?').get(receiptId)
	if (!row) return null
	let txs = []
	try {
		txs = JSON.parse(row.all_transactions || '[]')
	} catch {
		txs = []
	}
	// Load any design switches for this receipt once, keyed by item_key.
	const subs = {}
	try {
		;(getSubstitutionsForReceipts(db, [Number(receiptId)])[receiptId] || []).forEach((s) => {
			subs[s.item_key] = s
		})
	} catch {
		/* table may not exist yet */
	}

	// Resolve each line's canonical key (a manual order's lines are named by the
	// per-variant key stored in route_manual_items), so the rollup, verification
	// and "mark all purchased" paths built on this read and write the same rows
	// the Route tab and Shopping Mode do.
	const keys = lineIdentity.receiptLineKeys(db, receiptId, txs)

	const seen = new Map()
	txs.forEach((t, i) => {
		const key = keys[i]
		if (seen.has(key)) return
		const sub = subs[key]
		const parsed = routeDashboard.parseVariations(t.variations)
		const style = sub && sub.new_style ? sub.new_style : parsed.style
		const title = sub ? sub.new_title : t.title || ''
		const phoneModel = (sub && sub.new_phone_model) || parsed.phoneModel || ''
		seen.set(key, { item_key: key, title, phone_model: phoneModel, components: componentsFromStyle(style, { phoneModel, title }) })
	})
	return [...seen.values()]
}

/**
 * Whether an order still has ANY outstanding purchasing work, considering both
 * component statuses (route_assignments) and the no-component binary flag.
 */
function orderHasOutstanding(receiptId) {
	const items = orderLineItems(receiptId)
	if (!items || !items.length) return false
	const ra = {}
	db.prepare('SELECT * FROM route_assignments WHERE receipt_id = ?')
		.all(receiptId)
		.forEach((x) => {
			ra[x.item_key] = x
		})
	const rip = {}
	db.prepare('SELECT * FROM receipt_item_purchase WHERE receipt_id = ?')
		.all(receiptId)
		.forEach((x) => {
			rip[x.item_key] = x
		})
	// Lines with an OPEN fulfilment issue are on hold (out of production / model
	// unavailable) — they are never bought, so the WHOLE line is skipped.
	const onHold = new Set()
	db.prepare("SELECT item_key FROM order_issues WHERE receipt_id = ? AND status = 'open'")
		.all(receiptId)
		.forEach((x) => onHold.add(x.item_key))
	// A line with an OPEN wrong-model exchange only holds the generation-specific
	// piece (the CASE on iPhone; the case + attached charm on AirPods) in hand —
	// a separately-sourced grip/charm on the same line must still be bought, so we
	// skip only the held COMPONENTS, not the entire line. (Historically the whole
	// line was skipped, which made a Case+Grip+Charm exchange wrongly report the
	// order as fully in-hand while its grip/charm were still unbought.)
	const exchangeHeld = new Map()
	try {
		db.prepare("SELECT item_key, components, have_model FROM order_exchanges WHERE receipt_id = ? AND status = 'open'")
			.all(receiptId)
			.forEach((x) => {
				const it = items.find((i) => i.item_key === x.item_key)
				const comps = (it && it.components) || []
				exchangeHeld.set(
					x.item_key,
					routeDashboard.exchangeHeldComponents({
						needs_exchange: true,
						exchange_components: x.components,
						exchange_have_model: x.have_model,
						has_case: comps.includes('case'),
						has_grip: comps.includes('grip'),
						has_charm: comps.includes('charm'),
						phone_model: it && it.phone_model,
						title: it && it.title,
					}),
				)
			})
	} catch {
		/* table may not exist yet on first run */
	}
	for (const it of items) {
		if (onHold.has(it.item_key)) continue
		const held = exchangeHeld.get(it.item_key)
		if (it.components.length) {
			const a = ra[it.item_key] || {}
			for (const c of it.components) {
				if (held && held.has(c)) continue // in hand (wrong model) — swapped, not bought
				if (PURCHASE_OUTSTANDING_STATUSES.has(a[`status_${c}`] || 'Pending')) return true
			}
		} else {
			// No-component product: an exchange holds the whole (single) piece in hand.
			if (held && held.size) continue
			const b = rip[it.item_key]
			if (b && b.needs_purchase === 1) return true
		}
	}
	return false
}

/**
 * Auto-manage the order rollup (receipts.needs_purchase_at) from current line/component
 * state. Cleared when nothing is outstanding; set for PRE-TRANSIT orders that still have
 * outstanding work (so they ride into the purchasing Route). Unshipped orders are never
 * auto-flagged (they are already in the Route by default).
 */
function recomputeNeedsPurchaseRollup(receiptId) {
	const r = db.prepare('SELECT is_shipped, carrier_confirmed_at, needs_purchase_at, purchase_completed_at FROM receipts WHERE receipt_id = ?').get(receiptId)
	if (!r) return false
	const outstanding = orderHasOutstanding(receiptId)
	const isPreTransit = r.is_shipped === 1 && !r.carrier_confirmed_at
	const nowEpoch = Math.floor(Date.now() / 1000)

	if (!outstanding) {
		// The order just became (or remains) fully purchased. Stamp the completion
		// moment once — this is the "shopping finished for this order" time the
		// packing cohort filter reads — and preserve it across later no-op recomputes.
		db.prepare('UPDATE receipts SET needs_purchase_at = NULL, needs_purchase_note = NULL, purchase_completed_at = COALESCE(purchase_completed_at, ?) WHERE receipt_id = ?').run(nowEpoch, receiptId)
	} else {
		// Back to outstanding (e.g. a line went Out of Stock, or was re-flagged to
		// buy): clear the completion stamp so the NEXT completion re-stamps the real
		// time — the cohort must reflect when shopping actually finished.
		if (r.purchase_completed_at) {
			db.prepare('UPDATE receipts SET purchase_completed_at = NULL WHERE receipt_id = ?').run(receiptId)
		}
		if (isPreTransit && !r.needs_purchase_at) {
			db.prepare('UPDATE receipts SET needs_purchase_at = ? WHERE receipt_id = ?').run(nowEpoch, receiptId)
		}
	}
	return outstanding
}

// ─── Purchase-status → Orders-tab fulfilment-issue bridge ───────────────────
// Marking a component Discontinued (Out of Production) / No-model (Model
// Unavailable) is exactly the signal the Orders tab's fulfilment-issue workflow
// needs, so we mirror it automatically — the operator sees the hold (and can
// notify the buyer / handle the listing) without re-entering anything.
//
// CRITICAL: this bridge must fire from EVERY surface that can set a purchase
// status — the mobile shopping route, the desktop Route tab, the Orders-tab
// per-component control, and the bulk route-status import — otherwise the same
// action ("mark Out of Production") produces an on-hold issue on one screen but
// silently nothing on another, and the order never appears in Issues/on-hold.
// It is therefore keyed by (receipt_id, item_key) and reads the line's CURRENT
// stored statuses, so any caller only has to upsert the assignment and then call
// syncAssignmentIssue(receipt_id, item_key). `source: 'shop'` here means
// "auto-derived from a status change" (any surface) — as opposed to 'manual',
// the operator's deliberate "Flag issue" workflow.
const SHOP_STATUS_TO_ISSUE = { 'Out of Production': 'out_of_production', 'Model Unavailable': 'model_unavailable' }
// Severity order when a line's components disagree: a discontinued product (gone
// entirely) outranks a single unavailable model.
const SHOP_ISSUE_PRIORITY = ['out_of_production', 'model_unavailable']

/**
 * Recover the line's product context (listing_id / title / phone_model) from the
 * order's transactions, so an auto-created issue carries everything the operator
 * workflow needs (buyer message, delete-listing / remove-model actions).
 */
function deriveLineContext(receiptId, itemKey) {
	try {
		const txns = receiptLineRecords(receiptId)
		const match = lineIdentity.findTransactionByLineKey(db, receiptId, txns, itemKey)
		if (!match) return {}
		const parsed = routeDashboard.parseVariations(match.variations)
		// If the line was switched, any issue on it concerns the REPLACEMENT the
		// buyer chose, so its title/model must describe the switched design — never
		// the original the buyer already moved away from.
		const sub = getSubstitutionForLine(db, receiptId, itemKey)
		return {
			title: (sub && sub.new_title) || match.title,
			listing_id: match.listing_id,
			phone_model: (sub && sub.new_phone_model) || parsed.phoneModel || null,
		}
	} catch {
		return {}
	}
}

// An auto-flag Shopping Mode is free to CLEAR on revert: created by Shopping Mode,
// still open, and untouched by the operator (no buyer message drafted/sent,
// listing not handled, no resolution). Manual issues — or ones the operator has
// started working — are never auto-cleared.
function isRevertibleShopIssue(iss) {
	return !!(iss && iss.source === 'shop' && iss.status === 'open' && !iss.buyer_notified_at && !iss.listing_handled_at && !iss.buyer_message && !iss.resolution)
}
// An OPEN issue the operator owns, which Shopping Mode must never overwrite: a
// manual flag, or a shop flag the operator has begun working (notified / handled
// / drafted a message). A RESOLVED issue is NOT owned — it's closed, so a fresh
// shopper assertion may re-raise it.
function isOperatorActiveOpen(iss) {
	return !!(iss && iss.status === 'open' && (iss.source !== 'shop' || iss.buyer_notified_at || iss.listing_handled_at || iss.buyer_message))
}

/**
 * Reconcile a line's Orders-tab fulfilment issue with its current component
 * statuses (from ANY surface). Idempotent: safe to call after every assign.
 *   • any component Discontinued / No-model → ensure an OPEN issue of the mapped
 *     type. Creates one, retypes our own untouched flag, or re-raises a closed
 *     one — but never disturbs an actively-worked operator issue.
 *   • none → clear our own untouched auto-flag (never a manual / worked one).
 * Returns a short descriptor for logging, or null when nothing changed.
 *
 * @param {number|string} receiptId
 * @param {string} itemKey
 */
function syncAssignmentIssue(receiptId, itemKey) {
	receiptId = Number(receiptId)
	itemKey = String(itemKey)
	// Read the line's CURRENT stored statuses so the bridge is correct no matter
	// which surface changed them (and works even when the caller only touched one
	// component). Inside a caller's transaction this sees the just-upserted values.
	const ra = db.prepare('SELECT status_case, status_grip, status_charm, title FROM route_assignments WHERE receipt_id = ? AND item_key = ?').get(receiptId, itemKey) || {}
	const statuses = [ra.status_case, ra.status_grip, ra.status_charm]
	const desired = SHOP_ISSUE_PRIORITY.find((type) => statuses.some((s) => SHOP_STATUS_TO_ISSUE[s] === type)) || null
	const existing = getOrderIssue(db, receiptId, itemKey)

	if (desired) {
		// Already flagged correctly (by anyone) → nothing to do.
		if (existing && existing.status === 'open' && existing.issue_type === desired) return null
		// Never override an operator's actively-open issue.
		if (isOperatorActiveOpen(existing)) return null
		// Create / retype / re-raise as an auto (status-derived) open issue. On a
		// SWITCHED line this is exactly right: the buyer already moved to the
		// replacement, so marking the replacement's component terminal means the
		// REPLACEMENT is now unavailable — a genuine new hold. deriveLineContext
		// resolves the switched design's title/model, and the route only treats it
		// as a hold when it post-dates the switch (substitutionSupersedesIssue), so
		// a switch can never be silently reversed by a stale pre-switch flag.
		const ctx = deriveLineContext(receiptId, itemKey)
		upsertOrderIssue(db, {
			receipt_id: receiptId,
			item_key: itemKey,
			listing_id: ctx.listing_id,
			title: ctx.title || ra.title,
			phone_model: ctx.phone_model,
			issue_type: desired,
			source: 'shop',
		})
		const action = !existing ? 'flagged' : existing.status !== 'open' ? 'reraised' : 'retyped'
		return { action, issue_type: desired }
	}

	// No terminal component anymore → clear our own untouched auto-flag.
	if (isRevertibleShopIssue(existing)) {
		deleteOrderIssue(db, existing.id)
		return { action: 'cleared' }
	}
	return null
}

const _ripUpsert = db.prepare(`
  INSERT INTO receipt_item_purchase (receipt_id, item_key, title, needs_purchase, note, flagged_at, purchased_at, updated_at)
  VALUES (@receipt_id, @item_key, @title, @needs_purchase, @note, @flagged_at, @purchased_at, @updated_at)
  ON CONFLICT(receipt_id, item_key) DO UPDATE SET
    title          = COALESCE(excluded.title, title),
    needs_purchase = excluded.needs_purchase,
    note           = COALESCE(excluded.note, note),
    flagged_at     = CASE WHEN excluded.needs_purchase = 1 THEN COALESCE(flagged_at, excluded.flagged_at) ELSE flagged_at END,
    purchased_at   = CASE WHEN excluded.needs_purchase = 0 THEN excluded.purchased_at ELSE NULL END,
    updated_at     = excluded.updated_at
`)

/** Write one no-component line-item's binary purchase state. */
function setItemPurchaseState(receiptId, itemKey, title, needsPurchase, note) {
	const nowEpoch = Math.floor(Date.now() / 1000)
	_ripUpsert.run({
		receipt_id: receiptId,
		item_key: itemKey,
		title: title ?? null,
		needs_purchase: needsPurchase ? 1 : 0,
		note: note ?? null,
		flagged_at: needsPurchase ? nowEpoch : null,
		purchased_at: needsPurchase ? null : nowEpoch,
		updated_at: nowEpoch,
	})
}

/** Mark every present component of every line as 'Purchased' (used by "mark all purchased"). */
function setAllComponentsPurchased(receiptId) {
	const items = orderLineItems(receiptId) || []
	for (const it of items) {
		if (!it.components.length) continue
		const patch = { receipt_id: Number(receiptId), item_key: it.item_key, title: it.title }
		for (const c of it.components) patch[`status_${c}`] = 'Purchased'
		upsertRouteAssignment(db, patch)
		// Everything on this line is now Purchased (no terminal status left), so
		// clear any auto-derived on-hold flag it carried — keeping the issue state a
		// faithful reflection of the purchase status, consistent with every other
		// status path. A manual / operator-worked issue is deliberately left intact.
		syncAssignmentIssue(receiptId, it.item_key)
	}
}

/**
 * POST /api/orders/:receipt_id/needs-purchase
 * Body (optional): { note }
 * Flags the WHOLE order into the purchasing queue / Route. Products with no components
 * are marked needing purchase; component products default to Pending (= to buy).
 */
app.post('/api/orders/:receipt_id/needs-purchase', (req, res) => {
	const receiptId = req.params.receipt_id
	const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : null
	const items = orderLineItems(receiptId)
	if (items === null) return res.status(404).json({ error: 'Order not found' })

	const txn = db.transaction(() => {
		for (const it of items) if (!it.components.length) setItemPurchaseState(receiptId, it.item_key, it.title, true, null)
		db.prepare('UPDATE receipts SET needs_purchase_at = COALESCE(needs_purchase_at, ?), needs_purchase_note = COALESCE(?, needs_purchase_note) WHERE receipt_id = ?').run(Math.floor(Date.now() / 1000), note, receiptId)
	})
	txn()

	console.log(`[needs-purchase] receipt ${receiptId} flagged (${items.length} line item${items.length !== 1 ? 's' : ''})${note ? ` — note: ${note}` : ''}`)
	res.json({ success: true, receipt_id: receiptId, items: items.length })
})

/**
 * POST /api/orders/:receipt_id/clear-needs-purchase
 * Marks the WHOLE order purchased — every component → Purchased, every binary line
 * cleared, and the order flag removed.
 */
app.post('/api/orders/:receipt_id/clear-needs-purchase', (req, res) => {
	const receiptId = req.params.receipt_id
	const exists = db.prepare('SELECT 1 FROM receipts WHERE receipt_id = ?').get(receiptId)
	if (!exists) return res.status(404).json({ error: 'Order not found' })

	const txn = db.transaction(() => {
		const nowEpoch = Math.floor(Date.now() / 1000)
		db.prepare('UPDATE receipt_item_purchase SET needs_purchase = 0, purchased_at = ?, updated_at = ? WHERE receipt_id = ? AND needs_purchase = 1').run(nowEpoch, nowEpoch, receiptId)
		setAllComponentsPurchased(receiptId)
		db.prepare('UPDATE receipts SET needs_purchase_at = NULL, needs_purchase_note = NULL WHERE receipt_id = ?').run(receiptId)
	})
	txn()

	console.log(`[needs-purchase] receipt ${receiptId} cleared (all components/lines purchased)`)
	res.json({ success: true, receipt_id: receiptId })
})

/**
 * POST /api/orders/:receipt_id/items/component-status
 * Body: { item_key, title?, component: 'case'|'grip'|'charm', status }
 * Sets ONE component's purchase status (writes route_assignments — the same data the
 * Route tab uses, so the change shows there automatically) and re-rolls the order flag.
 * This is what lets the case be bought while the grip is still to buy.
 */
app.post('/api/orders/:receipt_id/items/component-status', (req, res) => {
	const receiptId = Number(req.params.receipt_id)
	const { title = null, component, status } = req.body || {}
	const comp = String(component || '').toLowerCase()
	// Canonicalise so a stale Orders-tab client that still holds the unsuffixed
	// key writes the same row Shopping Mode / the Route tab already use.
	const itemKey = lineIdentity.canonicalLineKey(db, receiptId, req.body?.item_key)
	if (!itemKey || !['case', 'grip', 'charm'].includes(comp)) {
		return res.status(400).json({ error: 'item_key and a valid component (case|grip|charm) are required' })
	}
	if (!VALID_PURCHASE_STATUSES.has(status)) {
		return res.status(400).json({ error: 'invalid status' })
	}
	const exists = db.prepare('SELECT 1 FROM receipts WHERE receipt_id = ?').get(receiptId)
	if (!exists) return res.status(404).json({ error: 'Order not found' })

	let outstanding
	const txn = db.transaction(() => {
		const patch = { receipt_id: receiptId, item_key: String(itemKey), title }
		patch[`status_${comp}`] = status
		upsertRouteAssignment(db, patch)
		// A component moving OFF 'Purchased' means the item may no longer be in hand,
		// so any prior packer verification of this line is now stale — clear it.
		if (status !== 'Purchased') clearRouteVerified(db, receiptId, String(itemKey))
		// Bridge terminal statuses to the fulfilment-issue workflow, identically to
		// the Route tab and mobile route, so on-hold state is consistent everywhere.
		syncAssignmentIssue(receiptId, String(itemKey))
		// Buying the corrected model IS completing a buy-shaped model fix, so close
		// it here rather than asking for a second confirmation elsewhere.
		settleBoughtModelFixes(receiptId, String(itemKey))
		outstanding = recomputeNeedsPurchaseRollup(receiptId)
	})
	txn()

	console.log(`[needs-purchase] receipt ${receiptId} item ${itemKey} ${comp} → ${status} (outstanding: ${outstanding})`)
	res.json({ success: true, receipt_id: receiptId, item_key: itemKey, component: comp, status, outstanding })
})

/**
 * Stamp (or clear) verification on ONE line, writing to the store that actually
 * backs it: component lines live in route_assignments, no-component lines in
 * receipt_item_purchase. Writing only the correct store avoids creating a phantom
 * route_assignments row (which would default to Pending Case/Grip/Charm and make a
 * componentless product look like it needs purchasing). Mirrors the read side in
 * classifyPurchaseState, which chooses the same store by component presence.
 *
 * @param {number} receiptId
 * @param {{item_key:string, title?:string, components:string[]}} item
 * @param {boolean} verified
 * @param {string} by
 */
function verifyLine(receiptId, item, verified, by) {
	if (item.components && item.components.length) {
		setRouteVerified(db, { receipt_id: receiptId, item_key: item.item_key, title: item.title, verified, by })
	} else {
		setItemPurchaseVerified(db, { receipt_id: receiptId, item_key: item.item_key, title: item.title, verified, by })
	}
}

/**
 * POST /api/orders/:receipt_id/items/verify
 * Body: { item_key, title?, verified: boolean }
 * The packer's morning confirmation that a specific line's product is physically in
 * hand — the second half of the two-person "Purchased → Verified" integrity gate.
 * Records WHO verified (req.auth.user) for the audit trail. Verifying a line that is
 * not yet in hand is harmless: classifyPurchaseState only counts verification among
 * in-hand lines, and any status regression clears it (see component-status handler).
 */
app.post('/api/orders/:receipt_id/items/verify', (req, res) => {
	const receiptId = Number(req.params.receipt_id)
	const { title = null } = req.body || {}
	const verified = req.body?.verified !== false // default true
	const itemKey = lineIdentity.canonicalLineKey(db, receiptId, req.body?.item_key)
	if (!itemKey) return res.status(400).json({ error: 'item_key is required' })
	const exists = db.prepare('SELECT 1 FROM receipts WHERE receipt_id = ?').get(receiptId)
	if (!exists) return res.status(404).json({ error: 'Order not found' })

	// Resolve the line's components so we write the correct backing store. If the
	// line isn't in the order's current transactions (shouldn't happen from the UI),
	// treat it as no-component — a receipt_item_purchase upsert, never a phantom
	// route_assignments row.
	const items = orderLineItems(receiptId) || []
	const item = items.find((i) => i.item_key === String(itemKey)) || { item_key: String(itemKey), title, components: [] }

	const by = (req.auth && req.auth.user) || 'owner'
	db.transaction(() => verifyLine(receiptId, item, verified, by))()

	console.log(`[verify] receipt ${receiptId} item ${itemKey} → ${verified ? `verified by ${by}` : 'unverified'}`)
	res.json({ success: true, receipt_id: receiptId, item_key: itemKey, verified, verified_by: verified ? by : '' })
})

/**
 * POST /api/orders/:receipt_id/verify-all
 * Body: { verified?: boolean }  (default true)
 * Verify (or unverify) EVERY packable line of an order in one action — the common
 * case when the packer has the whole parcel's contents laid out and confirmed.
 */
app.post('/api/orders/:receipt_id/verify-all', (req, res) => {
	const receiptId = Number(req.params.receipt_id)
	const verified = req.body?.verified !== false
	const items = orderLineItems(receiptId)
	if (items === null) return res.status(404).json({ error: 'Order not found' })

	const by = (req.auth && req.auth.user) || 'owner'
	let changed = 0
	const txn = db.transaction(() => {
		for (const it of items) {
			verifyLine(receiptId, it, verified, by)
			changed++
		}
	})
	txn()

	console.log(`[verify] receipt ${receiptId} verify-all → ${verified ? `verified by ${by}` : 'unverified'} (${changed} lines)`)
	res.json({ success: true, receipt_id: receiptId, verified, lines: changed })
})

/**
 * POST /api/orders/bulk-verify
 * Body: { receipt_ids: number[], verified?: boolean }  (default true)
 * Verify (or unverify) every packable line of many orders at once — the packer's
 * "I've checked this whole tray of parcels" action on the morning worklist.
 */
app.post('/api/orders/bulk-verify', (req, res) => {
	const ids = Array.isArray(req.body?.receipt_ids) ? req.body.receipt_ids.map((x) => Number(x)).filter(Number.isInteger) : []
	const verified = req.body?.verified !== false
	if (!ids.length) return res.status(400).json({ error: 'receipt_ids is required' })
	const by = (req.auth && req.auth.user) || 'owner'

	let changed = 0
	const txn = db.transaction((list) => {
		for (const id of list) {
			const items = orderLineItems(id)
			if (items === null) continue
			for (const it of items) verifyLine(id, it, verified, by)
			changed++
		}
	})
	txn(ids)

	console.log(`[verify] bulk ${verified ? 'verified' : 'unverified'} ${changed}/${ids.length} orders by ${by}`)
	res.json({ success: true, verified, changed, requested: ids.length })
})

/**
 * POST /api/orders/:receipt_id/items/purchase-state
 * Body: { item_key, title?, needs_purchase: boolean, note? }
 * Binary purchase toggle for a product with NO recognised components.
 */
app.post('/api/orders/:receipt_id/items/purchase-state', (req, res) => {
	const receiptId = req.params.receipt_id
	const { title = null, needs_purchase: needsPurchase } = req.body || {}
	const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : null
	const itemKey = lineIdentity.canonicalLineKey(db, receiptId, req.body?.item_key)
	if (!itemKey) return res.status(400).json({ error: 'item_key is required' })

	const exists = db.prepare('SELECT 1 FROM receipts WHERE receipt_id = ?').get(receiptId)
	if (!exists) return res.status(404).json({ error: 'Order not found' })

	let outstanding
	const txn = db.transaction(() => {
		setItemPurchaseState(receiptId, itemKey, title, !!needsPurchase, note)
		outstanding = recomputeNeedsPurchaseRollup(receiptId)
	})
	txn()

	console.log(`[needs-purchase] receipt ${receiptId} item ${itemKey} → ${needsPurchase ? 'needs purchase' : 'purchased'} (outstanding: ${outstanding})`)
	res.json({ success: true, receipt_id: receiptId, item_key: itemKey, needs_purchase: !!needsPurchase, outstanding })
})

/**
 * POST /api/orders/bulk-needs-purchase
 * Body: { receipt_ids: number[], flag: boolean, note?: string }
 * Flags or clears whole orders in one transaction.
 */
app.post('/api/orders/bulk-needs-purchase', (req, res) => {
	const ids = Array.isArray(req.body?.receipt_ids) ? req.body.receipt_ids.map((x) => String(x).trim()).filter(Boolean) : []
	const flag = req.body?.flag !== false // default true
	const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : null
	if (!ids.length) return res.status(400).json({ error: 'receipt_ids is required' })

	let changed = 0
	const txn = db.transaction((list) => {
		for (const id of list) {
			const items = orderLineItems(id)
			if (items === null) continue
			if (flag) {
				for (const it of items) if (!it.components.length) setItemPurchaseState(id, it.item_key, it.title, true, null)
				db.prepare('UPDATE receipts SET needs_purchase_at = COALESCE(needs_purchase_at, ?), needs_purchase_note = COALESCE(?, needs_purchase_note) WHERE receipt_id = ?').run(Math.floor(Date.now() / 1000), note, id)
			} else {
				const nowEpoch = Math.floor(Date.now() / 1000)
				db.prepare('UPDATE receipt_item_purchase SET needs_purchase = 0, purchased_at = ?, updated_at = ? WHERE receipt_id = ? AND needs_purchase = 1').run(nowEpoch, nowEpoch, id)
				setAllComponentsPurchased(id)
				db.prepare('UPDATE receipts SET needs_purchase_at = NULL, needs_purchase_note = NULL WHERE receipt_id = ?').run(id)
			}
			changed++
		}
	})
	txn(ids)

	console.log(`[needs-purchase] bulk ${flag ? 'flagged' : 'cleared'} ${changed}/${ids.length} orders`)
	res.json({ success: true, flag, changed, requested: ids.length })
})

// ─── Ship order ───────────────────────────────────────────────────────────────

/**
 * Mark a single Etsy receipt as shipped (creates an Etsy shipment tracking entry,
 * which notifies the buyer) and update the local DB to match immediately.
 *
 * Extracted as a standalone helper so BOTH the single-order ship route and the
 * 4PX bulk-complete flow share one authoritative implementation — there is only
 * one place where Etsy shipment creation + local persistence happen.
 *
 * @param {number|string} receiptId
 * @param {object} opts
 * @param {string} opts.tracking_code            Tracking number to attach (required)
 * @param {string} [opts.carrier_name='4PX']
 * @param {string} [opts.note_to_buyer]
 * @param {boolean} [opts.send_bcc=false]
 * @param {'ship'|'update'} [opts.mode='ship']   'ship' marks a new order shipped
 *                                               (status → Completed). 'update' re-submits
 *                                               tracking on an already-shipped order
 *                                               (edit-tracking flow): it preserves the
 *                                               existing status and RESETS the carrier
 *                                               confirmation so the corrected number is
 *                                               re-evaluated from scratch as pre-transit.
 * @returns {Promise<object>}  The Etsy createReceiptShipment result.
 * @throws  {Error}  err.status carries an HTTP-friendly status when known.
 */
// Tracks 'ship' calls currently talking to Etsy, keyed by receipt id, so two
// concurrent requests for the same receipt (e.g. a resumed bulk-complete that
// overlaps a still-running original after a connection blip) share ONE Etsy call
// and the buyer is never notified twice. 'update' (edit-tracking) is an explicit
// operator re-submit and is intentionally not de-duplicated.
const _shipInFlight = new Map() // receiptId(string) -> Promise<object>

function shipEtsyReceipt(receiptId, opts = {}) {
	const mode = opts.mode === 'update' ? 'update' : 'ship'
	if (mode === 'update') return _shipEtsyReceiptImpl(receiptId, opts)

	const key = String(receiptId)
	const existing = _shipInFlight.get(key)
	if (existing) return existing

	const p = _shipEtsyReceiptImpl(receiptId, opts)
	_shipInFlight.set(key, p)
	// Free the slot once settled (success OR failure) so a later, legitimate retry
	// of a genuinely-failed order can proceed.
	p.finally(() => {
		if (_shipInFlight.get(key) === p) _shipInFlight.delete(key)
	})
	return p
}

async function _shipEtsyReceiptImpl(receiptId, opts = {}) {
	const tracking = normalizeTrackingCode(opts.tracking_code)
	const carrier = normalizeCarrierName(opts.carrier_name, { fallback: '4PX' })
	const mode = opts.mode === 'update' ? 'update' : 'ship'

	// 1. Resolve which shop this receipt belongs to (receipts store shop_id).
	const order = db.prepare('SELECT shop_id, source, tracking_code, carrier_confirmed_at, is_shipped FROM receipts WHERE receipt_id = ?').get(receiptId)
	if (!order) {
		const e = new Error('Order not found')
		e.status = 404
		throw e
	}
	// Manual orders have no Etsy counterpart — an Etsy ship/tracking API call for a
	// fabricated receipt id would 404. They are shipped locally instead.
	if (order.source === 'manual') {
		const e = new Error('Manual orders are not on Etsy and cannot be shipped or tracked through Etsy. Mark them shipped locally or ship them with 4PX.')
		e.status = 400
		throw e
	}

	// Idempotency: if this receipt is ALREADY shipped on Etsy with this EXACT
	// tracking number, do not call Etsy again. Etsy sends a buyer notification on
	// every successful tracking submit and allows multiple shipment records per
	// receipt, so a blind re-submit would double-notify the buyer. Skipping here
	// makes bulk-complete safe to re-run after an interruption (dropped connection,
	// server restart): already-completed orders are skipped instantly and only the
	// remaining ones are shipped. A DIFFERENT tracking number is treated as a
	// genuine (re)ship and proceeds normally.
	if (mode !== 'update' && order.is_shipped === 1 && (order.tracking_code || '').trim() === tracking) {
		// The obligation is discharged either way — settle it so the reconciler
		// stops carrying an order that is demonstrably already shipped.
		etsyCompletion.markDone(db, receiptId, { trackingCode: tracking })
		console.log(`[ship] ${order.shop_id} receipt ${receiptId} already shipped with ${tracking} — skipped (idempotent)`)
		return { receipt_id: receiptId, tracking_code: tracking, carrier_name: carrier, skipped: true, alreadyShipped: true }
	}

	// 2. Find shop + group config by shop_id.
	let shopCfg, groupCfg
	for (const grp of config.groups) {
		const s = grp.shops.find((sh) => sh.shop_id === order.shop_id)
		if (s) {
			shopCfg = s
			groupCfg = grp
			break
		}
	}
	if (!shopCfg) {
		const e = new Error(`No config found for shop ${order.shop_id}`)
		e.status = 500
		throw e
	}

	if (mode !== 'update') {
		// pacedBulk: the bulk-complete endpoint owns pacing (chunk + sleeps), so the
		// per-shop hourly hard-stop is recorded but not thrown for that flow — a paced
		// completion of real, already-labeled orders must never be blocked.
		assertShipRateOk(order.shop_id, { paced: opts.pacedBulk === true })
		warnPreTransitShip(order, order.shop_id)
	}

	// 3. Fresh access token (same flow as the sync worker).
	const proxyClient = createGroupProxyClient(groupCfg, config.vpn_local_port)
	const accessToken = await tokenManager.getAccessToken(shopCfg.shop_id, shopCfg.api_key, shopCfg.refresh_token ?? null, proxyClient)

	// 4. Authenticated client + numeric shop ID.
	// Mark this client 'critical': shipping/completing an order is an operator-
	// initiated fulfilment action and must never be locked out by the background
	// budget reserve. Etsy itself remains the sole authority on a true 429.
	const shopClient = buildShopClient(proxyClient, shopCfg.api_key, shopCfg.shared_secret, accessToken, null, {
		priority: 'critical',
		// Fail closed: a proxied group must never ship an order from the server's own IP.
		requireProxy: usesGroupProxy(groupCfg),
	})
	const numericShopId = await resolveShopId(shopClient, shopCfg.shop_id)

	// 5. Create the shipment on Etsy (marks shipped + notifies the buyer).
	const result = await createReceiptShipment(shopClient, numericShopId, receiptId, {
		tracking_code: tracking,
		carrier_name: carrier,
		note_to_buyer: (opts.note_to_buyer || '').trim() || undefined,
		send_bcc: opts.send_bcc ?? false,
		// 'ship' is idempotent on tracking_code (never double-notify the buyer on a
		// lost-response retry). 'update' is a deliberate operator re-notify, so it
		// must always reach Etsy — disable the idempotency probe for it.
		idempotent: mode !== 'update',
	})

	// 6. Mirror the change locally so the UI updates without waiting for the next sync.
	if (mode === 'update') {
		// Edit-tracking flow: the order is already shipped/completed. Swap the tracking
		// number and carrier, and RESET the carrier confirmation + last-check time so the
		// tracking poller re-evaluates the corrected number from scratch — the new code
		// legitimately starts life as pre-transit again. We deliberately do NOT touch
		// shipment_notified_at: the Etsy edit window is measured from the ORIGINAL ship
		// notification, so preserving it keeps our remaining-window math accurate.
		db.prepare(
			`UPDATE receipts SET
         tracking_code        = ?,
         carrier_name         = ?,
         carrier_confirmed_at = NULL,
         tracking_checked_at  = NULL,
         tracking_status      = NULL,
         tracking_last_event  = NULL,
         tracking_last_event_at = NULL,
         tracking_last_location = NULL,
         tracking_delivered_at = NULL,
         tracking_health      = NULL,
         tracking_health_reason = NULL,
         tracking_is_disposed = 0,
         tracking_last_error  = NULL,
         tracking_error_at    = NULL,
         tracking_error_count = 0,
         tracking_next_check_at = NULL
       WHERE receipt_id = ?`,
		).run(tracking, carrier, receiptId)
		console.log(`[ship] ${order.shop_id} receipt ${receiptId} tracking UPDATED — new tracking: ${tracking}`)
	} else {
		// Stamp shipment_notified_at = now. Etsy's createReceiptShipment call we just
		// made IS the buyer's ship notification, so "now" is the correct, authoritative
		// moment. This is critical: shipment_notified_at is what the Pre-transit and
		// Ready-to-pack queues filter on, and the ONLY other writer of it is the
		// receipt sync — which can be paused by the QPD budget. Without stamping it
		// here a freshly-completed order has NULL shipment_notified_at, which (a) fails
		// the Pre-transit/Ready-to-pack filters and (b) is wrongly caught by the
		// In-transit filter's "shipment_notified_at IS NULL" clause — so the order
		// vanishes from the pack queue until the next successful sync. COALESCE
		// preserves a real Etsy timestamp if a prior sync already set one.
		// carrier_confirmed_at / tracking_checked_at are reset so the 4PX tracking
		// poller re-evaluates the parcel from scratch (it legitimately starts life as
		// pre-transit until the carrier physically scans it).
		db.prepare(
			`UPDATE receipts SET
         is_shipped           = 1,
         tracking_code        = ?,
         carrier_name         = ?,
         status               = 'Completed',
         shipment_notified_at = COALESCE(shipment_notified_at, strftime('%s','now')),
         carrier_confirmed_at = NULL,
         tracking_checked_at  = NULL,
         tracking_status      = NULL,
         tracking_last_event  = NULL,
         tracking_last_event_at = NULL,
         tracking_last_location = NULL,
         tracking_delivered_at = NULL,
         tracking_health      = NULL,
         tracking_health_reason = NULL,
         tracking_is_disposed = 0,
         tracking_last_error  = NULL,
         tracking_error_at    = NULL,
         tracking_error_count = 0,
         tracking_next_check_at = NULL
       WHERE receipt_id = ?`,
		).run(tracking, carrier, receiptId)
		// Discharge the durable completion obligation, if one was recorded when the
		// 4PX label was created. This is the ONE place every completion path
		// converges on (ship modal, browser auto-complete, bulk complete, the
		// background reconciler), so the ledger can never disagree with `receipts`.
		etsyCompletion.markDone(db, receiptId, { trackingCode: tracking })
		console.log(`[ship] ${order.shop_id} receipt ${receiptId} marked shipped — tracking: ${tracking} (now Ready-to-pack / Pre-transit)`)
	}
	return result
}

/**
 * POST /api/orders/:receipt_id/ship
 * Body: { tracking_code, carrier_name, note_to_buyer? }
 *
 * Calls the Etsy API to create a shipment tracking entry (marks as shipped),
 * then updates the local DB so the dashboard reflects the new status immediately.
 */
app.post('/api/orders/:receipt_id/ship', async (req, res) => {
	const { receipt_id } = req.params
	const { tracking_code, carrier_name = '4PX', note_to_buyer = '' } = req.body

	try {
		const result = await shipEtsyReceipt(receipt_id, { tracking_code, carrier_name, note_to_buyer })
		res.json({ success: true, receipt_id, tracking_code: tracking_code.trim(), shipment: result })
	} catch (err) {
		const etsyBody = err.response?.data
		const errMsg = (typeof etsyBody === 'object' ? etsyBody?.error_description || etsyBody?.error : null) || err.message
		console.error(`[ship] Error shipping receipt ${receipt_id}:`, errMsg, err.stack?.split('\n')[0])
		res.status(err.status || err.response?.status || 500).json({ error: errMsg })
	}
})

// ─── Etsy-completion reconciler ───────────────────────────────────────────────
//
// The safety net behind "Ship with 4PX". Creating a 4PX label is irreversible
// and paid; completing the order on Etsy is a SECOND call that can fail or be
// interrupted. When it was, the order stayed in Needs-shipping with a live
// parcel — a silent late shipment that only a human running
// `scripts/complete-4px-pending.js` would ever fix.
//
// create4pxShipmentForReceipt now records a durable intent the moment the label
// exists (src/orders/etsy-completion.js). This loop discharges those intents:
//
//   • runs shortly after each label is created (so an interrupted browser costs
//     seconds, not days), and on a slow schedule as a floor,
//   • adopts orphans — orders already stranded by older builds or the bulk CLI,
//   • paces itself exactly like the bulk-complete flow (buyer notifications are
//     the thing Etsy's anti-abuse systems watch), and
//   • gives up loudly rather than silently: an intent that cannot succeed goes
//     `dead` and the order card shows it with a one-click retry.
//
// Everything routes through shipEtsyReceipt, which de-duplicates concurrent
// calls per receipt and is idempotent on the tracking number — so the browser's
// fast path and this loop can race without ever double-notifying a buyer.

/** Orders completed per sweep. Small on purpose: each one emails a buyer. */
const ETSY_COMPLETION_SWEEP_LIMIT = 5

let _etsyCompletionSweeping = false
let _etsyCompletionTimer = null
let _etsyCompletionTimerDueAt = null

/**
 * Request a sweep in `delaySec`. Collapses repeated requests into the EARLIEST
 * one, so creating ten labels in a row schedules one sweep, not ten.
 */
function scheduleEtsyCompletionSweep(delaySec = 30) {
	const dueAt = Date.now() + Math.max(1, delaySec) * 1000
	if (_etsyCompletionTimer && _etsyCompletionTimerDueAt != null && _etsyCompletionTimerDueAt <= dueAt) return
	if (_etsyCompletionTimer) clearTimeout(_etsyCompletionTimer)
	_etsyCompletionTimerDueAt = dueAt
	_etsyCompletionTimer = setTimeout(() => {
		_etsyCompletionTimer = null
		_etsyCompletionTimerDueAt = null
		runEtsyCompletionSweep('kick').catch((err) => console.error('[completion] sweep failed:', err.message))
	}, dueAt - Date.now())
	// Never hold the process open for a retry timer.
	if (typeof _etsyCompletionTimer.unref === 'function') _etsyCompletionTimer.unref()
}

/**
 * Reconcile local state when Etsy reports the receipt is ALREADY shipped.
 *
 * This is a lost acknowledgement, not a failure: a previous attempt reached
 * Etsy but its response never reached us. Re-submitting would send the buyer a
 * second shipping email, so we mirror the outcome locally and stop. Mirrors the
 * shipEtsyReceipt write, but preserves any tracking/carrier already recorded.
 */
function _reconcileAlreadyShipped(receiptId, tracking, carrier) {
	db.prepare(
		`UPDATE receipts SET
       is_shipped           = 1,
       tracking_code        = COALESCE(tracking_code, @tracking),
       carrier_name         = COALESCE(carrier_name, @carrier),
       status               = 'Completed',
       shipment_notified_at = COALESCE(shipment_notified_at, strftime('%s','now')),
       carrier_confirmed_at = NULL,
       tracking_checked_at  = NULL
     WHERE receipt_id = @receiptId`,
	).run({ receiptId: Number(receiptId), tracking: tracking || null, carrier: carrier || '4PX' })
	etsyCompletion.markDone(db, receiptId, { trackingCode: tracking })
}

/**
 * Discharge ONE completion obligation.
 *
 * Shared by the background sweep and the operator's "Complete now" button so
 * both behave identically — there is one implementation of "finish this order",
 * and it always leaves the ledger and `receipts` agreeing with each other.
 *
 * @param {object} intent  A row from etsy_completion_intents.
 * @returns {Promise<{ outcome: 'completed'|'already'|'skipped'|'retry'|'dead', message: string }>}
 */
async function dischargeCompletionIntent(intent) {
	const rid = Number(intent.receipt_id)
	const row = db.prepare('SELECT receipt_id, shop_id, status, is_shipped, source, tracking_code, carrier_name, fourpx_tracking_no, fourpx_consignment_no FROM receipts WHERE receipt_id = ?').get(rid)

	if (!row) {
		etsyCompletion.markFailed(db, rid, { error: 'The order no longer exists in the local database.', permanent: true })
		return { outcome: 'dead', message: 'Order not found locally.' }
	}
	// Someone else finished it (ship modal, a sync, the bulk flow) — the
	// obligation is discharged regardless of who discharged it.
	if (row.is_shipped) {
		etsyCompletion.markDone(db, rid)
		return { outcome: 'already', message: 'Already completed.' }
	}
	// A cancelled or fully refunded order must never be shipped, and nothing is
	// broken — retire the intent quietly instead of dead-lettering it.
	if (etsyCompletion.isTerminalStatus(row.status)) {
		etsyCompletion.markSkipped(db, rid, { reason: `Order is ${row.status}` })
		return { outcome: 'skipped', message: `Order is ${row.status}.` }
	}

	const carrier = intent.carrier_name || '4PX'
	const tracking = String(intent.tracking_code || '').trim() || etsyCompletion.resolveTracking(row)
	if (!tracking) {
		etsyCompletion.markFailed(db, rid, { error: 'No 4PX tracking number is recorded for this order.', permanent: true })
		return { outcome: 'dead', message: 'No tracking number to complete with.' }
	}

	try {
		if (row.source === 'manual') {
			// Manual orders have no Etsy counterpart; completing them is a local write.
			setManualOrderShipped(db, rid, true)
			etsyCompletion.markDone(db, rid, { trackingCode: tracking })
			console.log(`[completion] receipt ${rid} (manual) marked shipped — tracking ${tracking}`)
			return { outcome: 'completed', message: 'Marked shipped.' }
		}
		// pacedBulk: this loop owns its own pacing (below), so the ad-hoc hourly
		// ship cap must not block a recovery that only exists because an order is
		// ALREADY late. recordShip() still accounts for it.
		await shipEtsyReceipt(rid, { tracking_code: tracking, carrier_name: carrier, pacedBulk: true })
		etsyCompletion.markDone(db, rid, { trackingCode: tracking })
		return { outcome: 'completed', message: 'Completed on Etsy.' }
	} catch (err) {
		const { alreadyShipped, permanent, message } = etsyCompletion.classifyCompletionError(err)
		if (alreadyShipped) {
			_reconcileAlreadyShipped(rid, tracking, carrier)
			console.log(`[completion] receipt ${rid} was already shipped on Etsy — reconciled locally`)
			return { outcome: 'already', message: 'Already shipped on Etsy — reconciled.' }
		}
		const next = etsyCompletion.markFailed(db, rid, { error: message, permanent })
		if (next.state === etsyCompletion.STATE.DEAD) {
			console.error(`[completion] receipt ${rid} DEAD after ${next.attempts} attempt(s) — needs an operator: ${message}`)
			return { outcome: 'dead', message }
		}
		console.warn(`[completion] receipt ${rid} attempt ${next.attempts} failed (${message}) — retrying in ${next.nextAttemptAt - Math.floor(Date.now() / 1000)}s`)
		return { outcome: 'retry', message }
	}
}

/**
 * One pass of the reconciler: adopt stranded orders, then complete a small,
 * paced batch of everything that is due.
 *
 * Single-flight — a slow pass never stacks on itself. Cross-process safety
 * comes from the leases in the ledger, so a standalone worker sharing this DB
 * cannot double-claim the same order.
 *
 * @param {string} [trigger]  'startup' | 'scheduled' | 'kick' | 'manual'
 */
async function runEtsyCompletionSweep(trigger = 'scheduled') {
	if (_etsyCompletionSweeping) return { skipped: true, reason: 'A completion sweep is already running.' }
	_etsyCompletionSweeping = true
	const startedAt = Date.now()
	const stats = { adopted: 0, attempted: 0, completed: 0, already: 0, skipped: 0, retry: 0, dead: 0 }

	try {
		try {
			stats.adopted = etsyCompletion.adoptOrphans(db)
			if (stats.adopted) console.log(`[completion] adopted ${stats.adopted} order(s) that hold a 4PX label but were never completed on Etsy`)
		} catch (err) {
			console.error('[completion] orphan adoption failed:', err.message)
		}

		const claimed = etsyCompletion.claimDue(db, { limit: ETSY_COMPLETION_SWEEP_LIMIT })
		for (const [idx, intent] of claimed.entries()) {
			// Same cadence as the bulk-complete flow: a burst of buyer ship
			// notifications is the anti-abuse signal we must not emit.
			if (idx > 0) await complianceSleep(BULK_SHIP_INTER_REQUEST_MS)
			stats.attempted++
			try {
				const { outcome } = await dischargeCompletionIntent(intent)
				stats[outcome] = (stats[outcome] || 0) + 1
			} catch (err) {
				// dischargeCompletionIntent handles its own failures; anything reaching
				// here is a bug, and must not abandon the leases of the remaining batch.
				stats.retry++
				etsyCompletion.releaseClaim(db, intent.receipt_id)
				console.error(`[completion] unexpected error on receipt ${intent.receipt_id}:`, err.message)
			}
		}

		// Hit the per-sweep cap → there is a backlog. Come back for it soon rather
		// than waiting out the full interval, still one paced batch at a time.
		if (claimed.length >= ETSY_COMPLETION_SWEEP_LIMIT) scheduleEtsyCompletionSweep(60)

		if (stats.attempted || stats.adopted) {
			console.log(`[completion] ${trigger} sweep — completed ${stats.completed}, already ${stats.already}, skipped ${stats.skipped}, retrying ${stats.retry}, dead ${stats.dead} (${Date.now() - startedAt}ms)`)
		}
	} finally {
		_etsyCompletionSweeping = false
	}
	return { skipped: false, ...stats }
}

/**
 * POST /api/orders/:receipt_id/complete-with-4px
 *
 * Finish an order that already has a 4PX label but is not yet completed on
 * Etsy — the retry behind the order card's "Finish on Etsy" button, and the way
 * an operator discharges an intent the reconciler dead-lettered or never
 * adopted (a stale label outside the automatic window).
 *
 * Runs the completion INLINE so the operator gets a real answer instead of
 * "queued", and re-arms the ledger first so a failure is still owned durably.
 */
app.post('/api/orders/:receipt_id/complete-with-4px', async (req, res) => {
	const rid = Number(req.params.receipt_id)
	if (!Number.isInteger(rid)) return res.status(400).json({ error: 'Invalid order id.' })

	try {
		const row = db.prepare('SELECT receipt_id, status, is_shipped, source, tracking_code, fourpx_tracking_no, fourpx_consignment_no FROM receipts WHERE receipt_id = ?').get(rid)
		if (!row) return res.status(404).json({ error: 'Order not found.' })
		if (row.is_shipped) {
			etsyCompletion.markDone(db, rid)
			return res.json({ success: true, receipt_id: rid, outcome: 'already', message: 'This order is already completed.' })
		}
		if (etsyCompletion.isTerminalStatus(row.status)) {
			return res.status(409).json({ error: `This order is ${row.status} and must not be shipped.`, code: 'ORDER_TERMINAL' })
		}
		const tracking = etsyCompletion.resolveTracking(row)
		if (!tracking) {
			return res.status(409).json({ error: 'This order has no 4PX tracking number yet — create the 4PX shipment first.', code: 'NO_TRACKING' })
		}

		// revive: an operator asking again is exactly the signal that clears a
		// dead-lettered intent and gives it a fresh attempt budget.
		const { intent } = etsyCompletion.enqueue(db, { receiptId: rid, trackingCode: tracking, origin: 'operator', graceSec: 0, expedite: true, revive: true })
		const { outcome, message } = await dischargeCompletionIntent(intent)

		if (outcome === 'completed' || outcome === 'already') {
			return res.json({ success: true, receipt_id: rid, outcome, tracking_code: tracking, message })
		}
		if (outcome === 'skipped') return res.status(409).json({ error: message, outcome, code: 'ORDER_TERMINAL' })
		// Still owed: the ledger keeps retrying in the background, so say so.
		return res.status(502).json({ error: message, outcome, receipt_id: rid, retrying: outcome === 'retry' })
	} catch (err) {
		console.error(`[completion] manual completion of receipt ${rid} failed:`, err.message)
		res.status(err.status || 500).json({ error: err.message })
	}
})

/**
 * POST /api/orders/complete-pending-4px
 *
 * Run the reconciler now and report what it did. Powers the Needs-shipping
 * banner's "Finish them now" action; identical work to the scheduled sweep, so
 * pressing it can never produce a different outcome than waiting would.
 */
app.post('/api/orders/complete-pending-4px', async (req, res) => {
	try {
		const result = await runEtsyCompletionSweep('manual')
		// `stranded` is the same figure the banner renders, so the toast the
		// operator reads after pressing the button can never contradict the banner
		// that is still on screen behind it.
		res.json({
			success: !result.skipped,
			...result,
			pending: { ...etsyCompletion.summarize(db), stranded: etsyCompletion.countStranded(db) },
		})
	} catch (err) {
		console.error('[completion] manual sweep failed:', err.message)
		res.status(500).json({ error: err.message })
	}
})

/**
 * POST /api/orders/:receipt_id/update-tracking
 * Body: { tracking_code, carrier_name?, note_to_buyer? }
 *
 * Edit / correct the tracking number on an ALREADY-shipped receipt. Etsy has no
 * dedicated "update tracking" endpoint — instead, re-submitting tracking via the
 * same createReceiptShipment call updates the buyer-facing tracking and triggers a
 * fresh shipping notification. This is exactly what Etsy's own "Edit tracking"
 * button does, and it is only permitted within a short window (≈3 days) after the
 * original ship notification.
 *
 * We pre-validate against that window (config.tracking_edit_days) so the operator
 * gets a clear message instead of an opaque Etsy 4xx, but Etsy stays the source of
 * truth: a call it rejects is surfaced verbatim.
 */
app.post('/api/orders/:receipt_id/update-tracking', async (req, res) => {
	const { receipt_id } = req.params
	const { tracking_code, carrier_name = '4PX', note_to_buyer = '' } = req.body

	try {
		const tracking = normalizeTrackingCode(tracking_code)

		// Load current state to validate the edit is sensible BEFORE calling Etsy.
		const row = db.prepare('SELECT is_shipped, status, tracking_code, shipment_notified_at, carrier_confirmed_at FROM receipts WHERE receipt_id = ?').get(receipt_id)
		if (!row) return res.status(404).json({ error: 'Order not found' })

		if (!row.is_shipped) {
			return res.status(409).json({
				error: 'This order has not been marked shipped yet. Use "Complete order" to add tracking for the first time.',
			})
		}
		if (/^(Canceled|Cancelled|Fully Refunded|Fully refunded)$/.test(row.status || '')) {
			return res.status(409).json({ error: `Cannot edit tracking on a ${row.status} order.` })
		}

		// Editable window: Etsy allows re-submitting tracking for ~tracking_edit_days days
		// after the original ship notification. shipment_notified_at is the authoritative
		// ship-notification epoch. If it's missing (legacy rows), we let the request through
		// and rely on Etsy to accept or reject it.
		const editDays = config.tracking_edit_days ?? 3
		if (row.shipment_notified_at) {
			const daysSince = (Math.floor(Date.now() / 1000) - row.shipment_notified_at) / 86400
			if (daysSince > editDays) {
				return res.status(409).json({
					error: `Etsy's ${editDays}-day window for editing tracking has passed (this order shipped ${daysSince.toFixed(1)} days ago). The tracking number can no longer be changed via the API.`,
				})
			}
		}

		const result = await shipEtsyReceipt(receipt_id, {
			tracking_code: tracking,
			carrier_name,
			note_to_buyer,
			mode: 'update',
		})
		res.json({ success: true, receipt_id, tracking_code: tracking, shipment: result })
	} catch (err) {
		const etsyBody = err.response?.data
		const errMsg = (typeof etsyBody === 'object' ? etsyBody?.error_description || etsyBody?.error : null) || err.message
		console.error(`[ship] Error updating tracking for receipt ${receipt_id}:`, errMsg, err.stack?.split('\n')[0])
		res.status(err.status || err.response?.status || 500).json({ error: errMsg })
	}
})

// ─────────────────────────────────────────────────────────────────────────────
// 4PX SHIPPING ORDER CREATION
// These endpoints allow creating a 4PX direct-shipping order directly from
// the dashboard, without needing to log in to the 4PX platform separately.
//
// Prerequisites (config.json):
//   fourpx_app_key      — 4PX Open Platform AppKey
//   fourpx_app_secret   — 4PX Open Platform AppSecret
//   fourpx_sender       — Sender address object
//   fourpx_warehouse_code — Drop-off warehouse code (optional)
//   fourpx_default_product — Default logistics product code (optional)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Helper: verify that 4PX credentials are configured.
 * Returns { appKey, appSecret } or throws an HTTP-friendly error.
 */
function get4pxCredentials() {
	const { fourpx_app_key: appKey, fourpx_app_secret: appSecret } = config
	if (!appKey || !appSecret) {
		const err = new Error('fourpx_app_key and fourpx_app_secret must be set in config.json to use 4PX order creation.')
		err.status = 501
		throw err
	}
	return { appKey, appSecret }
}

/**
 * GET /api/4px/config
 * Returns 4PX-related config values the frontend needs to pre-populate the drawer.
 * No credentials are exposed.
 */
app.get('/api/4px/config', (_req, res) => {
	const hasCreds = !!(config.fourpx_app_key && config.fourpx_app_secret)
	const shipmentIoss = destinationTax.resolveShipmentIoss(config)
	res.json({
		enabled: hasCreds,
		hasSender: !!config.fourpx_sender,
		warehouseCode: config.fourpx_warehouse_code ?? null,
		defaultProduct: config.fourpx_default_product ?? null,
		// POSTLINK-LW (S5058 / "postlink-s5058") is auto-selected when the destination
		// catalogue offers it; countryDefaultProducts + defaultProduct are fallbacks.
		preferredProduct: FOURPX_POSTLINK_S5058_CODE,
		countryDefaultProducts: FOURPX_COUNTRY_DEFAULT_PRODUCT,
		// ── Express lanes ─────────────────────────────────────────────────────────
		// POSTLINK-LW above is the ECONOMY default. On an order the buyer paid to
		// upgrade (Etsy `shipping_upgrade`) the drawer pre-selects from these
		// instead, strongest first, and warns if the operator picks a slower lane.
		// Server-side resolution uses the very same tables (resolveLogisticsProduct
		// with expedited: true), so the pre-selection and the booked lane agree.
		expressProducts: FOURPX_EXPRESS_WORLDWIDE,
		expressProductsByCountry: FOURPX_EXPRESS_BY_COUNTRY,
		// EU IOSS: whether a number will actually be transmitted + the destinations
		// it applies to, so the bulk wizard can reassure the operator that EU
		// customs is handled. This reflects the RESOLVED number (config override or
		// registry value), not merely whether config.json names one.
		iossConfigured: !!shipmentIoss.value,
		iossSource: shipmentIoss.source,
		iossCountries: [...FOURPX_IOSS_COUNTRIES],
		sender: config.fourpx_sender
			? {
					// Only expose non-sensitive display fields
					first_name: config.fourpx_sender.first_name,
					company: config.fourpx_sender.company ?? null,
					city: config.fourpx_sender.city ?? null,
					country: config.fourpx_sender.country ?? 'CN',
				}
			: null,
	})
})

/**
 * Fetch, from 4PX, the ground-truth of what can actually be shipped to a
 * destination — and cache it for 30 minutes. Two independent live signals are
 * combined so a single API quirk can never hide a valid product nor surface an
 * invalid one:
 *
 *   • ds.xms.logistics_product.getlist  → every product code enabled on the
 *     account (the broad "does this code exist at all?" oracle). Country-agnostic.
 *   • ds.xms.estimated_cost.get         → every lane 4PX will actually PRICE for
 *     this country+weight, with fee + ETA (the "is it orderable right now, and
 *     what does it cost/how fast?" oracle). Country-specific but not exhaustive
 *     (some enabled lanes — e.g. S5058→AU — are order-able yet omitted here).
 *
 * @returns {Promise<{codes:Set<string>, priceable:Set<string>,
 *                    nameByCode:Map<string,string>, priceByCode:Map<string,object>,
 *                    live:Array, priced:Array, ok:boolean}>}
 */
async function get4pxValidCodes(appKey, appSecret, country) {
	const cc = (country || '').toUpperCase()
	const cacheKey = `${appKey}:${cc}`
	const hit = _fpxValidCodesCache.get(cacheKey)
	if (hit && hit.expiresAt > Date.now()) return hit

	const hasCjk = (s) => /[\u4e00-\u9fff]/.test(s || '')

	// (1) Account-wide product catalogue (names + existence).
	let live = []
	try {
		live = await getLogisticsProducts(appKey, appSecret, { countryCode: cc || undefined })
	} catch (err) {
		console.warn(`[4px/products] getlist failed for ${cc || 'ALL'}: ${err.message}`)
	}
	const codes = new Set()
	const nameByCode = new Map()
	for (const p of live) {
		const code = (p.logistics_product_code ?? p.logisticsProductCode ?? p.code ?? '').toString().trim()
		if (!code) continue
		codes.add(code.toUpperCase())
		const nameEn = p.logistics_product_name_en || p.logistics_product_name || ''
		if (nameEn && !hasCjk(nameEn)) nameByCode.set(code.toUpperCase(), nameEn)
	}

	// (2) Live rate card for this country+weight (order-ability + price + ETA).
	const priceable = new Set()
	const priceByCode = new Map()
	let priced = []
	if (cc) {
		try {
			const weightG = Number(config.fourpx_default_weight_g) > 0 ? Number(config.fourpx_default_weight_g) : 100
			const est = await getEstimatedCost(appKey, appSecret, { countryCode: cc, weightG, currency: config.fourpx_settlement_currency || 'CNY' })
			priced = Array.isArray(est.all) ? est.all : []
			for (const p of priced) {
				const code = (p.logistics_product_code ?? p.logisticsProductCode ?? '').toString().trim()
				if (!code) continue
				const fee = Number(p.lump_sum_fee ?? p.lumpSumFee ?? p.total_fee)
				priceable.add(code.toUpperCase())
				priceByCode.set(code.toUpperCase(), {
					fee: Number.isFinite(fee) ? fee : null,
					currency: config.fourpx_settlement_currency || 'CNY',
					estimatedTime: p.estimated_time ?? p.estimatedTime ?? null,
				})
			}
		} catch (err) {
			console.warn(`[4px/products] estimated_cost failed for ${cc}: ${err.message}`)
		}
	}

	const result = {
		codes,
		priceable,
		nameByCode,
		priceByCode,
		live,
		priced,
		ok: codes.size > 0 || priceable.size > 0,
		expiresAt: Date.now() + 30 * 60 * 1000,
	}
	_fpxValidCodesCache.set(cacheKey, result)
	return result
}

/** Render a "5–8 days · ~39.90 CNY" style suffix from a rate-card entry. */
function _fpxPriceSuffix(price) {
	if (!price) return ''
	const parts = []
	if (price.estimatedTime) parts.push(`${String(price.estimatedTime).replace(/-/g, '–')} days`)
	if (Number.isFinite(price.fee)) parts.push(`~${price.fee.toFixed(2)} ${price.currency || 'CNY'}`)
	return parts.join(' · ')
}

/** Derive a display tier for a live lane from its ETA (fewest days = faster). */
function _fpxTierFromEta(estimatedTime) {
	const m = String(estimatedTime || '').match(/\d+/)
	if (!m) return 'standard'
	const minDays = Number(m[0])
	if (minDays <= 8) return 'express'
	if (minDays <= 14) return 'standard'
	return 'economy'
}

/**
 * GET /api/4px/products
 * List the logistics products a shipment can ACTUALLY be created with for a
 * destination. Every returned code is real and order-able — the picker can no
 * longer offer a fabricated code that fails at order-create with DS000110.
 *
 * Ordering:
 *   1. Recommended — our curated, verified-real shortlist for the destination,
 *      enriched with live price/ETA. Pre-selected default lives here (S5058).
 *   2. All priced lanes returned by 4PX's live rate card (real prices + ETAs),
 *      grouped by speed, cheapest first.
 *   3. "Other / custom" for power users who know a specific code.
 *
 * Results are cached for 30 minutes. Query param: country (ISO-2, e.g. "US").
 */
app.get('/api/4px/products', async (req, res) => {
	try {
		const { appKey, appSecret } = get4pxCredentials()
		const country = (req.query.country || '').toUpperCase()
		const cacheKey = `${appKey}:${country}`
		const cached = _fpxProductsCache.get(cacheKey)
		if (cached && cached.expiresAt > Date.now()) {
			return res.json({ products: cached.products, source: cached.source, country: cached.country, cached: true })
		}

		const { priceByCode, priced, nameByCode, live } = await get4pxValidCodes(appKey, appSecret, country)

		const products = []
		const seen = new Set() // upper-cased codes already added (dedupe)

		// ── 1. Recommended (curated, verified-real) ──────────────────────────────
		for (const p of FOURPX_RECOMMENDED_PRODUCTS) {
			if (p.code === 'OTHER') continue
			if (!_fpxProductServesCountry(p, country)) continue
			const price = priceByCode.get(p.code.toUpperCase())
			const suffix = _fpxPriceSuffix(price)
			products.push({
				logistics_product_code: p.code,
				logistics_product_name: p.name,
				description: suffix ? `${p.desc} · ${suffix}` : p.desc,
				tier: 'recommended',
				service_tier: p.tier,
				recommended: true,
				// Is this lane fast enough to honour a buyer-paid shipping upgrade?
				// Decided by the same module that picks the express default, so the
				// picker's "Express" marks and the pre-selection cannot disagree.
				express: isExpressProduct(p),
				fee: price?.fee ?? null,
				currency: price?.currency ?? null,
				estimated_time: price?.estimatedTime ?? null,
				country_specific: Array.isArray(p.countries) && p.countries.length > 0,
			})
			seen.add(p.code.toUpperCase())
		}

		// ── 2. All other live-priced lanes (real prices + ETAs, cheapest first) ──
		const moreLanes = priced
			.map((p) => {
				const code = (p.logistics_product_code ?? p.logisticsProductCode ?? '').toString().trim()
				const fee = Number(p.lump_sum_fee ?? p.lumpSumFee ?? p.total_fee)
				return { code, fee: Number.isFinite(fee) ? fee : Infinity, eta: p.estimated_time ?? p.estimatedTime ?? null }
			})
			.filter((l) => l.code && !seen.has(l.code.toUpperCase()))
			.sort((a, b) => a.fee - b.fee)
		for (const l of moreLanes) {
			seen.add(l.code.toUpperCase())
			const price = { fee: Number.isFinite(l.fee) ? l.fee : null, currency: config.fourpx_settlement_currency || 'CNY', estimatedTime: l.eta }
			const suffix = _fpxPriceSuffix(price)
			const etaTier = _fpxTierFromEta(l.eta)
			const name = nameByCode.get(l.code.toUpperCase()) || l.code
			products.push({
				logistics_product_code: l.code,
				logistics_product_name: name,
				description: suffix || undefined,
				tier: etaTier,
				// An uncurated lane qualifies as express on either signal: 4PX's own
				// product naming, or a rate-card ETA fast enough to honour an upgrade
				// (_fpxTierFromEta's 'express' band = 8 days or fewer).
				express: etaTier === 'express' || isExpressProduct({ logistics_product_code: l.code, logistics_product_name: name }),
				fee: price.fee,
				currency: price.currency,
				estimated_time: price.estimatedTime,
				country_specific: !!country,
			})
		}

		// ── Source classification ────────────────────────────────────────────────
		// 'api'      — at least one live signal (rate card and/or product list) drove the list.
		// 'fallback' — no live data; only the curated verified-real shortlist is shown.
		const usedLive = priced.length > 0 || live.length > 0
		const source = usedLive ? 'api' : 'fallback'

		// The custom escape hatch is always last, in its own group.
		products.push({ logistics_product_code: 'OTHER', logistics_product_name: 'Other / Custom…', description: 'Enter a 4PX product code manually', tier: 'custom', country_specific: false })

		const recommendedCount = products.filter((p) => p.recommended).length
		console.log(`[4px/products] ${country || 'ALL'}: ${recommendedCount} recommended + ${moreLanes.length} priced lane(s) (source=${source})`)

		_fpxProductsCache.set(cacheKey, { products, source, country, expiresAt: Date.now() + 30 * 60 * 1000 })
		res.json({ products, source, country, cached: false })
	} catch (err) {
		console.error('[4px] GET /api/4px/products:', err.message)
		res.status(err.status || 500).json({ error: err.message })
	}
})

/**
 * GET /api/4px/order/:receipt_id
 * Return the 4PX shipment details stored in the local DB for this receipt.
 * Also optionally fetches an up-to-date label URL if one isn't stored yet.
 */
app.get('/api/4px/order/:receipt_id', (req, res) => {
	const { receipt_id } = req.params
	const row = db
		.prepare(
			`
    SELECT
      fourpx_consignment_no,
      fourpx_tracking_no,
      fourpx_label_url,
      fourpx_order_status,
      fourpx_created_at
    FROM receipts
    WHERE receipt_id = ?
  `,
		)
		.get(receipt_id)

	if (!row) return res.status(404).json({ error: 'Receipt not found' })
	if (row.fourpx_order_status === 'cancelled') {
		return res.json({
			exists: false,
			cancelled: true,
			previous_consignment_no: row.fourpx_consignment_no,
			previous_tracking_no: row.fourpx_tracking_no,
		})
	}
	if (!row.fourpx_consignment_no) {
		return res.json({ exists: false })
	}
	res.json({ exists: true, ...row })
})

// ─── 4PX freight (shipping cost) ──────────────────────────────────────────────

/**
 * Shape the stored freight columns of a receipt row into the JSON the UI consumes.
 * `breakdown` is parsed from its JSON column; bad/empty values degrade to [].
 *
 * @param {object} row  A receipts row selecting the fourpx_freight_* columns.
 * @returns {object}
 */
function shapeFreight(row) {
	let breakdown = []
	if (row.fourpx_freight_breakdown) {
		try {
			breakdown = JSON.parse(row.fourpx_freight_breakdown)
		} catch {
			breakdown = []
		}
	}
	return {
		amount: row.fourpx_freight_amount ?? null,
		currency: row.fourpx_freight_currency ?? null,
		billedWeightG: row.fourpx_billed_weight_g ?? null,
		breakdown: Array.isArray(breakdown) ? breakdown : [],
		// 'pending' until 4PX bills the parcel; 'billed' once a real charge arrives.
		status: row.fourpx_freight_status ?? (row.fourpx_consignment_no ? 'pending' : 'none'),
		fetchedAt: row.fourpx_freight_fetched_at ?? null,
	}
}

/**
 * Query 4PX for one receipt's freight and persist it. Shared by the on-demand
 * GET (with ?refresh=1) and the bulk POST refresh endpoint.
 *
 * @param {number|string} receiptId
 * @param {{appKey:string, appSecret:string}} creds
 * @returns {Promise<{updated:boolean, status:string, reason?:string}>}
 */
async function refreshFreightForReceipt(receiptId, { appKey, appSecret }) {
	const row = db
		.prepare(
			`SELECT receipt_id, source, tracking_code, fourpx_consignment_no, fourpx_tracking_no, fourpx_order_status,
		                 shipping_country_iso, fourpx_product_code, fourpx_weight_g, fourpx_freight_status
		          FROM receipts WHERE receipt_id = ?`,
		)
		.get(receiptId)
	if (!row) return { updated: false, status: 'none', reason: 'receipt_not_found' }
	const isFourpx = row.fourpx_consignment_no || row.fourpx_tracking_no || /^4PX/i.test(row.tracking_code || '')
	if (!isFourpx) return { updated: false, status: 'none', reason: 'no_consignment' }
	if (row.fourpx_order_status === 'cancelled') return { updated: false, status: 'cancelled', reason: 'order_cancelled' }

	try {
		const r = await resolveReceiptFreight({ db, config, appKey, appSecret, receipt: row })
		return { updated: r.status === 'billed' || r.status === 'estimated', status: r.status, source: r.source, amount: r.amount, currency: r.currency }
	} catch (err) {
		recordFourpxFreight(db, receiptId, { status: 'error' })
		console.error(`[4px/freight] receipt ${receiptId} failed:`, err.message)
		return { updated: false, status: 'error', reason: err.message }
	}
}

/**
 * GET /api/4px/freight/:receipt_id
 * Return the stored shipping cost for one order. With ?refresh=1 it first queries
 * 4PX live (ds.xms.order.getFreight) and persists the result before responding.
 */
app.get('/api/4px/freight/:receipt_id', async (req, res) => {
	const { receipt_id } = req.params
	try {
		if (req.query.refresh === '1' || req.query.refresh === 'true') {
			const { appKey, appSecret } = get4pxCredentials()
			await refreshFreightForReceipt(receipt_id, { appKey, appSecret })
		}
		const row = db
			.prepare(
				`
				SELECT fourpx_consignment_no, fourpx_freight_amount, fourpx_freight_currency,
				       fourpx_billed_weight_g, fourpx_freight_breakdown, fourpx_freight_status,
				       fourpx_freight_fetched_at
				FROM receipts WHERE receipt_id = ?
			`,
			)
			.get(receipt_id)
		if (!row) return res.status(404).json({ error: 'Receipt not found' })
		res.json({ receipt_id: Number(receipt_id), freight: shapeFreight(row) })
	} catch (err) {
		console.error('[4px] GET /api/4px/freight:', err.message)
		res.status(err.status || 500).json({ error: err.message })
	}
})

/**
 * POST /api/4px/freight/refresh
 * Force a live freight re-query for a set of orders.
 * Body: { receipt_ids: number[] }
 */
app.post('/api/4px/freight/refresh', async (req, res) => {
	try {
		const { appKey, appSecret } = get4pxCredentials()
		const ids = Array.isArray(req.body?.receipt_ids) ? req.body.receipt_ids : []
		if (!ids.length) return res.status(400).json({ error: 'receipt_ids[] is required' })
		// Cap the batch and pace requests so a big refresh can't stampede the 4PX API.
		const capped = ids.slice(0, 200)
		const results = []
		for (let i = 0; i < capped.length; i++) {
			if (i > 0) await new Promise((r) => setTimeout(r, 150))
			const r = await refreshFreightForReceipt(capped[i], { appKey, appSecret })
			results.push({ receipt_id: capped[i], ...r })
		}
		const billed = results.filter((r) => r.status === 'billed').length
		res.json({ success: true, requested: capped.length, billed, results })
	} catch (err) {
		console.error('[4px] POST /api/4px/freight/refresh:', err.message)
		res.status(err.status || 500).json({ error: err.message })
	}
})

/**
 * GET /api/4px/shipping-summary
 * Per-shop 4PX shipping cost for the Earnings tab. Grouped by 4PX settlement
 * currency (CNY) with billed-vs-estimated provenance, plus the live EUR-base rate
 * map so the frontend can convert the CNY spend into each shop's payout currency
 * for the "true net (incl. shipping)" view.
 *
 * Query params (all optional):
 *   from / to  — unix-epoch window on fourpx_created_at (matches the Earnings range).
 *   shop_id    — restrict to one shop.
 */
app.get('/api/4px/shipping-summary', async (req, res) => {
	try {
		const from = req.query.from ? parseInt(req.query.from, 10) : undefined
		const to = req.query.to ? parseInt(req.query.to, 10) : undefined
		const shopId = req.query.shop_id || undefined
		const { byShop } = getFourpxShippingSummary(db, { from, to, shopId })

		// Grand totals per settlement currency across all shops in scope.
		const grandTotals = {}
		for (const shop of Object.values(byShop)) {
			for (const [cur, t] of Object.entries(shop.totals)) {
				grandTotals[cur] = +((grandTotals[cur] ?? 0) + t.amount).toFixed(2)
			}
		}

		// Live rates let the UI convert CNY → each shop's payout currency.
		let rates = {}
		try {
			rates = await getRates()
		} catch {}

		res.json({ shops: Object.values(byShop), grandTotals, rates })
	} catch (err) {
		console.error('[4px] GET /api/4px/shipping-summary:', err.message)
		res.status(500).json({ error: err.message })
	}
})

/**
 * POST /api/4px/create-order
 * Create a 4PX direct-shipping order for an Etsy receipt.
 *
 * Request body:
 *   receipt_id              — Etsy receipt ID (required)
 *   recipient               — Recipient address (may override Etsy data)
 *   parcel                  — { weight_g, declared_value, currency, include_battery, items[] }
 *   logistics_product_code  — 4PX product code
 *   duty_type               — 'U' (DDU) or 'P' (DDP), default 'U'
 *   also_ship_etsy          — boolean, default false (not yet implemented here)
 */
/**
 * Create a 4PX direct-shipping order for one Etsy receipt and persist the result.
 *
 * Shared by the single-order route and the bulk-create flow so the validation,
 * idempotency guard, 4PX call, and DB persistence live in exactly one place.
 *
 * @param {object} input
 * @param {number|string} input.receipt_id
 * @param {object}  input.recipient                Recipient address payload.
 * @param {object}  input.parcel                   Single parcel spec (weight_g, items[], …).
 * @param {string}  input.logistics_product_code
 * @param {'U'|'P'} [input.duty_type='U']
 * @returns {Promise<object>}  createShipOrder result (trackingNo, dsConsignmentNo, …).
 * @throws  {Error}  err.status set to a sensible HTTP code; err.code carries any 4PX code.
 */
/**
 * Translate opaque 4PX risk-control rejections into actionable English guidance.
 *
 * 4PX returns "此订单为申报收件人黑名单" (DS000000) when the declared recipient
 * matches its blacklist. The most common cause was a shared placeholder phone
 * reused across every order — now eliminated by generateRecipientPhone(), which
 * gives each order a unique destination-localized number. If a blacklist
 * rejection still surfaces, the recipient name/address itself is flagged on 4PX's
 * side and only 4PX support can clear it, so we say exactly that.
 *
 * @param {Error}        err         The error thrown by createShipOrder.
 * @param {number|string} receipt_id Etsy receipt for log/operator context.
 * @returns {Error}                  The same error, or a clearer replacement.
 */
function annotate4pxOrderError(err, receipt_id) {
	const msg = (err && err.message) || ''
	if (/黑名单|blacklist/i.test(msg)) {
		const friendly = new Error(`4PX rejected receipt ${receipt_id}: the declared recipient is on 4PX's ` + `risk-control blacklist. Each order now sends a unique, destination-` + `localized contact phone, so a previously over-used shared number is no ` + `longer the cause. If this persists, the recipient's name/address is ` + `flagged on 4PX's side and must be cleared with 4PX support. ` + `(Original 4PX message: ${msg})`)
		friendly.status = 422
		friendly.code = err.code || 'DS000000'
		friendly.apiBody = err.apiBody
		return friendly
	}
	return err
}

// Single-flight by receipt. A double-click, two tabs, or the bulk worker must
// never pass the local preflight twice. Concurrent callers may carry different
// shipping options, so reject the later request rather than silently returning
// the first request's result as though its payload had been applied.
const _fourpxCreateInFlight = new Map()
const FOURPX_CREATE_LOCK_OWNER = `${os.hostname()}:${process.pid}`
const FOURPX_CREATE_LOCK_TTL_SEC = 10 * 60

async function create4pxShipmentForReceipt(input) {
	const key = input && input.receipt_id != null ? String(input.receipt_id) : null
	if (!key) return _create4pxShipmentForReceipt(input || {})
	if (_fourpxCreateInFlight.has(key)) {
		const e = new Error(`A 4PX shipment is already being created for receipt ${key}.`)
		e.status = 409
		e.code = 'FOURPX_CREATE_IN_FLIGHT'
		throw e
	}
	const lockName = `fourpx_create:${key}`
	if (!acquireLock(db, lockName, FOURPX_CREATE_LOCK_OWNER, FOURPX_CREATE_LOCK_TTL_SEC)) {
		const e = new Error(`Another dashboard process is already creating a 4PX shipment for receipt ${key}.`)
		e.status = 409
		e.code = 'FOURPX_CREATE_LOCKED'
		throw e
	}
	const pending = _create4pxShipmentForReceipt(input)
	_fourpxCreateInFlight.set(key, pending)
	try {
		return await pending
	} finally {
		if (_fourpxCreateInFlight.get(key) === pending) _fourpxCreateInFlight.delete(key)
		try {
			releaseLock(db, lockName, FOURPX_CREATE_LOCK_OWNER)
		} catch (err) {
			console.warn(`[4px] could not release create lock for receipt ${key}: ${err.message}`)
		}
	}
}

async function _create4pxShipmentForReceipt({ appKey, appSecret, receipt_id, recipient, parcel, logistics_product_code, duty_type = 'U', mark_packaged = false }) {
	if (!receipt_id) {
		const e = new Error('receipt_id is required')
		e.status = 400
		throw e
	}
	if (!recipient) {
		const e = new Error('recipient is required')
		e.status = 400
		throw e
	}
	if (!parcel) {
		const e = new Error('parcel is required')
		e.status = 400
		throw e
	}
	// Did the buyer pay Etsy extra for faster shipping? Read from OUR row rather
	// than from the request, because this decides which lane a paid label is
	// booked on: a caller — bulk worker, retry job, API client — must not be able
	// to downgrade an express parcel by omitting or spoofing a flag. Best-effort:
	// a lookup failure means we ship exactly as before, never that we fail to ship.
	let isExpedited = false
	try {
		isExpedited = db.prepare('SELECT is_expedited FROM receipts WHERE receipt_id = ?').get(receipt_id)?.is_expedited === 1
	} catch (err) {
		console.warn(`[4px] could not read express flag for receipt ${receipt_id}: ${err.message}`)
	}

	// Server-side default (defense in depth): when a caller omits the product,
	// fall back to POSTLINK-LW (S5058) if the destination supports it, else QC —
	// the same preference the drawer pre-selects. Keeps the default correct even
	// for API clients / retry jobs that never went through the UI. On an EXPRESS
	// order the express chain replaces that default, because POSTLINK-LW is the
	// economy lane and would silently undo the upgrade the buyer paid for.
	if (!logistics_product_code) {
		logistics_product_code = resolveLogisticsProduct({
			country: recipient?.country,
			configDefault: config.fourpx_default_product ?? null,
			expedited: isExpedited,
		})
	}
	if (!logistics_product_code) {
		const e = new Error('logistics_product_code is required')
		e.status = 400
		throw e
	}
	if (!parcel.weight_g || parcel.weight_g <= 0) {
		const e = new Error('parcel.weight_g must be a positive number (grams)')
		e.status = 400
		throw e
	}
	if (!parcel.items?.length) {
		const e = new Error('parcel.items is required for customs declaration')
		e.status = 400
		throw e
	}

	// Idempotency: never create a second 4PX order for the same receipt.
	const order = db
		.prepare(
			`
		SELECT receipt_id, shop_id, source, buyer_email, packaged_at,
		       fourpx_ref_no, fourpx_consignment_no, fourpx_tracking_no,
		       fourpx_order_status
		FROM receipts WHERE receipt_id = ?
	`,
		)
		.get(receipt_id)
	if (!order) {
		const e = new Error(`Receipt ${receipt_id} not found`)
		e.status = 404
		throw e
	}
	const referencePlan = planShipOrderReference({
		source: order.source,
		receiptId: receipt_id,
		previousRef: order.fourpx_ref_no,
		orderStatus: order.fourpx_order_status,
		hasConsignment: !!order.fourpx_consignment_no,
	})
	const { refNo, replacingCancelled, retryingPendingRef } = referencePlan
	if (order.fourpx_consignment_no && !replacingCancelled) {
		const e = new Error(`A 4PX shipment was already created for receipt ${receipt_id}.`)
		e.status = 409
		e.consignment_no = order.fourpx_consignment_no
		e.trackingNo = order.fourpx_tracking_no
		throw e
	}
	// `mark_packaged` is the same physical seal action as the dedicated endpoint.
	// Enforce the shared purchase/issue/exchange invariant before making any 4PX
	// side effect. Existing packaged rows remain grandfathered and idempotent.
	if (mark_packaged && !order.packaged_at) {
		const reason = unsealableReasons([receipt_id]).get(Number(receipt_id))
		if (reason) {
			const e = new Error(`Can't mark this order packaged — it ${reason}. Finish it first.`)
			e.status = 409
			e.code = 'NOT_SEALABLE'
			throw e
		}
	}

	const destCountry = (recipient?.country || '').toUpperCase()
	const isEuDestination = FOURPX_IOSS_COUNTRIES.has(destCountry)

	// ── Destination tax / customs compliance ─────────────────────────────────────
	// IMPORTANT: 4PX validates BOTH the EU IOSS/VAT and the destination recipient
	// tax id against the ORDER-LEVEL `vat_no` / `ioss_no` / `eori_no` fields — NOT
	// the recipient_info sub-object. Its error is labelled "recipient_info.vat_no
	// required", but supplying the value inside recipient_info is silently ignored
	// (verified by probing every recipient_info field name against the live API).
	// The value MUST be set at the order top level.
	//
	//   • EU27 (declared value ≤ €150, always true here): attach the marketplace
	//     IOSS number so the parcel clears as VAT-prepaid; vat_no / eori_no too.
	//   • Mexico (MX): since the Oct-2024 SAT reform, a recipient RFC/CURP is
	//     mandatory. Use the buyer's RFC when supplied, else the SAT generic RFC
	//     for unregistered individuals (XAXX010101000) so the shipment clears.
	const COUNTRIES_REQUIRING_RECIPIENT_VAT = new Set(['MX'])
	const MX_GENERIC_RFC = 'XAXX010101000'
	const recipientVatNo = (recipient.vat_no || '').trim() || (COUNTRIES_REQUIRING_RECIPIENT_VAT.has(destCountry) ? MX_GENERIC_RFC : '')

	const taxCompliance = {}
	if (isEuDestination) {
		// The IOSS number the packing bench shows for this destination is the same
		// one transmitted here: an install that never set fourpx_ioss_no now falls
		// back to the reviewed registry value instead of shipping without one and
		// having 4PX reject the order (IOSS号 required).
		const ioss = destinationTax.resolveShipmentIoss(config)
		if (ioss.value) taxCompliance.ioss_no = ioss.value
		else console.warn(`[4px] receipt ${receipt_id} ships to EU country ${destCountry} but no IOSS number could be resolved — ` + 'set fourpx_ioss_no (or marketplace_tax_ids.EU_IOSS) in config.json; 4PX may reject the order.')
		if (config.fourpx_vat_no) taxCompliance.vat_no = config.fourpx_vat_no
		if (config.fourpx_eori_no) taxCompliance.eori_no = config.fourpx_eori_no
	}
	// Recipient tax id (e.g. MX RFC) is supplied at the order-level vat_no field.
	// NB: non-EU marketplace identifiers (UK VAT, VOEC, …) are deliberately NOT
	// written here. 4PX reads vat_no as the party tax id for the lane, and the
	// destination guidance for those schemes is a customs-form entry rather than a
	// field in this payload — see src/compliance/destination-tax.js.
	if (recipientVatNo) taxCompliance.vat_no = recipientVatNo

	// ── Recipient enrichment ─────────────────────────────────────────────────────
	// Email: 4PX requires recipient_info.email for all Etsy-sourced shipments and
	// some destinations enforce it strictly (MX, etc.).  Resolution order:
	//   1. Caller-supplied recipient.email (e.g. from the UI form)
	//   2. buyer_email stored in the receipts row (synced from Etsy at order time)
	//   3. Explicit override from config (fourpx_default_recipient_email)
	//   4. The configured shop owner's contact address
	const shopContact = getAllShops(config).find((shop) => String(shop.shop_id) === String(order.shop_id))?.owner_email
	const recipientEmail = (recipient.email || '').trim() || (order.buyer_email || '').trim() || (config.fourpx_default_recipient_email || '').trim() || String(shopContact || '').trim()
	if (!recipientEmail) {
		const e = new Error('4PX requires a recipient email, but Etsy did not return one. ' + 'Enter it for this shipment or set fourpx_default_recipient_email in config.json.')
		e.status = 422
		e.code = 'RECIPIENT_EMAIL_REQUIRED'
		throw e
	}

	const enrichedRecipient = {
		...recipient,
		email: recipientEmail,
		// Mirror the tax id into recipient_info too (harmless; used by 4PX for label
		// printing). The binding validation is satisfied by the order-level vat_no.
		...(recipientVatNo && { vat_no: recipientVatNo }),
	}

	// ── Validate the product against 4PX's live catalogue (defense in depth) ─────
	// Prevents the opaque DS000110 ("product code does not exist") round-trip: if
	// the account cannot actually ship to this destination with the chosen code,
	// reject NOW with clear, actionable guidance and real alternatives — instead of
	// letting 4PX fail the create call. A code is accepted when it appears in EITHER
	// the account product list (getlist) OR the live rate card (estimated_cost) OR
	// our curated verified-real shortlist for the country; this union avoids false
	// rejections for lanes one signal omits (e.g. S5058→AU is order-able yet absent
	// from the AU rate card). If both live signals are unavailable, validation is
	// skipped and 4PX stays the final authority.
	try {
		const { codes, priceable, ok } = await get4pxValidCodes(appKey, appSecret, destCountry)
		if (ok) {
			const want = String(logistics_product_code).toUpperCase()
			const recommendedForCountry = FOURPX_RECOMMENDED_PRODUCTS.filter((p) => p.code !== 'OTHER' && _fpxProductServesCountry(p, destCountry)).map((p) => p.code)
			const isValid = codes.has(want) || priceable.has(want) || recommendedForCountry.some((c) => c.toUpperCase() === want)
			if (!isValid) {
				const suggestions = recommendedForCountry.filter((c) => codes.has(c.toUpperCase()) || priceable.has(c.toUpperCase()))
				// NB: keep this message free of ':' — the browser's humanize4pxError()
				// strips everything before a colon when cleaning raw 4PX errors.
				const altText = suggestions.length ? ` Recommended services for ${destCountry || 'this destination'} — ${suggestions.join(', ')}.` : ''
				const e = new Error(`4PX shipping service "${logistics_product_code}" is not available for ${destCountry || 'this destination'} on your account. Pick another service from the dropdown.${altText}`)
				e.status = 422
				e.code = 'DS000110'
				throw e
			}
		}
	} catch (err) {
		if (err.status === 422) throw err
		// A failure of the validation lookup itself must never block a shipment.
		console.warn(`[4px] product validation skipped for receipt ${receipt_id}: ${err.message}`)
	}

	// ── Express downgrade trail ──────────────────────────────────────────────────
	// The operator has already been warned in the drawer, and a lane can be chosen
	// deliberately (weight, battery, cost), so this NEVER blocks the shipment — but
	// booking a paid express order onto an economy lane is the failure this whole
	// feature exists to prevent, so it must leave a trail somewhere a "why did this
	// buyer get 20-day post?" question can be answered from.
	if (isExpedited) {
		const advisory = assessExpressChoice({ country: destCountry, selectedCode: logistics_product_code, expedited: true })
		if (advisory.downgraded) {
			console.warn(`[4px] receipt ${receipt_id} is EXPRESS (buyer paid to upgrade) but is being booked on "${logistics_product_code}", which is not an express lane` + (advisory.recommended ? `; recommended ${advisory.recommended}.` : '.'))
		}
	}

	// Persist the deterministic reference before the external side effect. If the
	// process loses the response or crashes, the next attempt probes this exact
	// reference instead of inventing a second order.
	let activeRefNo = refNo
	db.prepare('UPDATE receipts SET fourpx_ref_no = ? WHERE receipt_id = ?').run(activeRefNo, receipt_id)

	let result = null
	// The product we ultimately booked (may differ from the caller's choice when
	// the US remote/island ZIP fallback kicks in — S5058 → S5118). Persisted below
	// so freight pricing and the order card name the lane that actually shipped.
	let bookedProductCode = String(logistics_product_code)
	let productFallback = null
	if (retryingPendingRef) {
		try {
			result = normalizeShipOrderResponse(await getShipOrder(appKey, appSecret, activeRefNo), activeRefNo)
			if (result) {
				console.warn(`[4px] receipt ${receipt_id} adopted pending order ${result.dsConsignmentNo || result.trackingNo}.`)
			}
		} catch {
			// Not found (or temporarily unavailable): use the same persisted ref
			// for the create call below, so 4PX remains the duplicate authority.
		}
	}

	const shipOrderPayload = (productCode, useRef = activeRefNo) => ({
		ref_no: useRef,
		logistics_product_code: productCode,
		warehouse_code: config.fourpx_warehouse_code ?? undefined,
		deliver_type: '3',
		sender: config.fourpx_sender,
		recipient: enrichedRecipient,
		parcels: [parcel],
		duty_type,
		sales_platform: 'ETSY',
		trade_id: receipt_id,
		...taxCompliance,
	})

	const persistActiveRef = (nextRef) => {
		activeRefNo = nextRef
		db.prepare('UPDATE receipts SET fourpx_ref_no = ? WHERE receipt_id = ?').run(activeRefNo, receipt_id)
	}

	// After a create failure, probe by our deterministic ref_no before giving up.
	// A transport blip can leave the order committed on 4PX's side with no response
	// reaching us; adopting it prevents a later retry from opening a second consignment.
	const adoptExistingOrNull = async (context, probeRef = activeRefNo) => {
		try {
			const adopted = normalizeShipOrderResponse(await getShipOrder(appKey, appSecret, probeRef), probeRef)
			if (adopted) {
				console.warn(`[4px] receipt ${receipt_id} ${context}; adopted existing order ${adopted.dsConsignmentNo || adopted.trackingNo}.`)
			}
			return adopted || null
		} catch (probeErr) {
			console.warn(`[4px] receipt ${receipt_id} create reconciliation failed: ${probeErr.message}`)
			return null
		}
	}

	// DS000007 ("Ref_no in processing"): wait briefly and poll. The create may
	// still commit; adopting beats inventing a second consignment. Used both for
	// ambiguous first creates and for the island-ZIP S5118 retry.
	const waitAndAdoptRef = async (probeRef = activeRefNo, { attempts = 4, delayMs = 1500 } = {}) => {
		for (let i = 0; i < attempts; i++) {
			if (i > 0) await complianceSleep(delayMs)
			const adopted = await adoptExistingOrNull(`ref-in-processing poll ${i + 1}/${attempts}`, probeRef)
			if (adopted) return adopted
		}
		return null
	}

	/** Book US-ISLAND-PH (S5118) on a FRESH ref after S5058 rejected an island ZIP
	 *  AND the recipient address independently confirms an S5118 territory. */
	const createWithIslandZipFallback = async (fallbackCode, fromCode) => {
		// Fresh ref — a rejected S5058 create can leave the original ref "in
		// processing" (DS000007) for several seconds even though no consignment
		// was committed. Reusing that ref for S5118 is exactly the Failed row
		// operators were seeing in bulk ("already being submitted to 4PX").
		const islandRef = mintShipOrderFallbackRef(referencePlan.baseRef, 'ISL')
		persistActiveRef(islandRef)
		console.warn(`[4px] receipt ${receipt_id}: ${fromCode} rejected for remote/island ZIP — address confirmed S5118 territory — auto-retrying with ${fallbackCode} (US-ISLAND-PH) on ref ${islandRef}`)

		const markFallback = () => {
			productFallback = {
				from: fromCode,
				to: fallbackCode,
				reason: 'remote_island_zip',
			}
			bookedProductCode = fallbackCode
		}

		try {
			const created = await createShipOrder(appKey, appSecret, shipOrderPayload(fallbackCode))
			markFallback()
			return created
		} catch (retryErr) {
			let adopted = await adoptExistingOrNull('island-ZIP fallback response was ambiguous')
			if (!adopted && isRefInProcessingRejection(retryErr)) {
				console.warn(`[4px] receipt ${receipt_id}: S5118 create hit DS000007 on ${islandRef} — waiting for 4PX to release/commit the ref`)
				adopted = await waitAndAdoptRef(islandRef)
				if (!adopted) {
					await complianceSleep(2000)
					try {
						const created = await createShipOrder(appKey, appSecret, shipOrderPayload(fallbackCode))
						markFallback()
						return created
					} catch (retryErr2) {
						adopted = (await waitAndAdoptRef(islandRef)) || (await adoptExistingOrNull('island-ZIP fallback second attempt ambiguous', islandRef))
						if (!adopted) throw annotate4pxOrderError(retryErr2, receipt_id)
					}
				}
			}
			if (!adopted) throw annotate4pxOrderError(retryErr, receipt_id)
			// Adopted an order that landed while we waited — still record the
			// intended product switch so the wizard/audit trail stays honest.
			markFallback()
			return adopted
		}
	}

	/** Resolve S5118 fallback only when error + address both qualify. */
	const resolveIslandFallback = (err) =>
		resolveUsIslandZipFallback({
			country: destCountry,
			selectedCode: bookedProductCode,
			error: err,
			postCode: enrichedRecipient.post_code || recipient.post_code || '',
			state: enrichedRecipient.state || recipient.state || '',
		})

	try {
		if (!result) result = await createShipOrder(appKey, appSecret, shipOrderPayload(bookedProductCode))
	} catch (err) {
		result = await adoptExistingOrNull('create response was ambiguous')
		// DS000007 on the first attempt: poll before any product switch. A
		// concurrent tab / prior bulk run may still be committing this ref.
		if (!result && isRefInProcessingRejection(err)) {
			console.warn(`[4px] receipt ${receipt_id}: ${bookedProductCode} hit DS000007 on ${activeRefNo} — waiting to adopt or free the ref`)
			result = await waitAndAdoptRef(activeRefNo)
			if (!result) {
				// Ref stuck in processing with no order — mint a fresh ref and
				// recreate. If the destination is a confirmed US island ZIP, this
				// create surfaces 010109005 and the island fallback below takes over.
				const freedRef = mintShipOrderFallbackRef(referencePlan.baseRef, 'P')
				persistActiveRef(freedRef)
				console.warn(`[4px] receipt ${receipt_id}: ref still processing with no order — recreating on ${freedRef}`)
				try {
					result = await createShipOrder(appKey, appSecret, shipOrderPayload(bookedProductCode))
				} catch (err2) {
					result = await adoptExistingOrNull('recreate after DS000007 was ambiguous')
					if (!result) {
						const fallbackCode = resolveIslandFallback(err2)
						if (fallbackCode) {
							result = await createWithIslandZipFallback(fallbackCode, bookedProductCode)
						} else if (isRefInProcessingRejection(err2)) {
							result = await waitAndAdoptRef(activeRefNo)
							if (!result) throw annotate4pxOrderError(err2, receipt_id)
						} else {
							throw annotate4pxOrderError(err2, receipt_id)
						}
					}
				}
			}
		}
		if (!result) {
			// US island / remote ZIP: S5058 rejects HI/AK/GU/PR/VI ZIPs with
			// 010109005 — but only auto-retry on S5118 when the address itself
			// confirms an S5118 territory (see resolveUsIslandZipFallback).
			const fallbackCode = resolveIslandFallback(err)
			if (fallbackCode) {
				result = await createWithIslandZipFallback(fallbackCode, bookedProductCode)
			} else {
				throw annotate4pxOrderError(err, receipt_id)
			}
		}
	}

	// Persist immediately — tracking number is now available even before label fetch.
	upsertFourpxShipment(db, receipt_id, {
		refNo: activeRefNo,
		consignmentNo: result.dsConsignmentNo,
		trackingNo: result.trackingNo,
		status: 'created',
		replaceExisting: replacingCancelled,
	})

	// Capture the product + declared weight so the freight pass can price this order
	// via ds.xms.estimated_cost.get (and reconcile to the billed cost later).
	recordFourpxShipmentInputs(db, receipt_id, {
		productCode: bookedProductCode || null,
		weightG: parcel && Number.isFinite(parcel.weight_g) ? parcel.weight_g : parcel && Number.isFinite(parcel.weight) ? parcel.weight : null,
		replaceExisting: replacingCancelled,
	})

	// Mirror into the main tracking_code field so pre-transit detection picks it up.
	if (result.trackingNo) {
		db.prepare(
			`
			UPDATE receipts SET tracking_code = ?, carrier_name = ?
			WHERE receipt_id = ?
			  AND (
			    tracking_code IS NULL
			    OR (? = 1 AND (tracking_code = ? OR UPPER(COALESCE(carrier_name, '')) LIKE '4PX%'))
			  )
		`,
		).run(result.trackingNo, '4PX', receipt_id, replacingCancelled ? 1 : 0, order.fourpx_tracking_no)
	}

	// ── Packaging is DECOUPLED from shipping ─────────────────────────────────────
	// Creating a 4PX label is NOT proof the parcel is physically packed. A label is
	// very often created early purely to beat the Etsy ship-by deadline (and avoid a
	// late-shipment penalty) while the goods may not even be bought yet — exactly the
	// "Pre-transit" / "Needs purchase" state this app already models. So we must never
	// assume "shipped ⇒ packaged": doing so would falsely drop unpacked orders out of
	// the packing queue. Packaging stays an explicit operator decision (the per-row
	// "Mark packaged" action) and is only stamped here when the operator opted in via
	// mark_packaged (e.g. they ARE packing at ship time). Idempotent via COALESCE.
	if (mark_packaged) {
		db.prepare('UPDATE receipts SET packaged_at = COALESCE(packaged_at, ?) WHERE receipt_id = ?').run(Math.floor(Date.now() / 1000), receipt_id)
	}

	// ── The label is real and paid — record the obligation to finish the job ────
	// From here on the order MUST also be completed on Etsy, or it sits in
	// Needs-shipping accruing a late-shipment strike while its parcel is already
	// moving. The browser normally does that within a couple of seconds, but a
	// browser is not a transaction coordinator: closing the tab, a sleeping
	// laptop or an expired token used to strand the order permanently.
	//
	// Writing the intent HERE — immediately after the irreversible side effect,
	// before anyone can navigate away — is what makes the second phase durable.
	// The reconciler (runEtsyCompletionSweep) discharges it if the browser
	// doesn't, after a short grace period so the fast path normally wins and
	// exactly one Etsy call is made.
	const completionTracking = result.trackingNo || result.dsConsignmentNo || ''
	if (completionTracking) {
		try {
			etsyCompletion.enqueue(db, { receiptId: receipt_id, trackingCode: completionTracking, carrierName: '4PX', origin: 'fourpx' })
			scheduleEtsyCompletionSweep(etsyCompletion.FIRST_ATTEMPT_GRACE_SEC + 10)
		} catch (err) {
			// The label exists; never fail the request over bookkeeping. The orphan
			// sweep adopts this receipt on the next cycle.
			console.error(`[4px] could not record the Etsy-completion intent for receipt ${receipt_id}: ${err.message}`)
		}
	}

	console.log(`[4px] Created shipment for receipt ${receipt_id} — ` + `tracking: ${result.trackingNo}, consignment: ${result.dsConsignmentNo}` + `${productFallback ? ` (auto-switched ${productFallback.from} → ${productFallback.to} for remote/island ZIP)` : ''}` + `${mark_packaged ? ' (marked packaged)' : ' (not packaged — label only)'}`)
	return productFallback ? { ...result, productFallback } : result
}

app.post('/api/4px/create-order', async (req, res) => {
	try {
		const { appKey, appSecret } = get4pxCredentials()

		if (!config.fourpx_sender) {
			return res.status(501).json({
				error: 'fourpx_sender is not configured in config.json. ' + 'Add sender address details to enable shipping order creation.',
			})
		}

		const { receipt_id, recipient, parcel, logistics_product_code, duty_type = 'U', mark_packaged = false } = req.body

		const result = await create4pxShipmentForReceipt({
			appKey,
			appSecret,
			receipt_id,
			recipient,
			parcel,
			logistics_product_code,
			duty_type,
			mark_packaged: !!mark_packaged,
		})

		res.json({ success: true, receipt_id, ...result })
	} catch (err) {
		// Log the full API response body when available — crucial for diagnosing
		// 4PX business errors (codes, messages) that don't surface in err.message alone.
		if (err.apiBody) {
			console.error('[4px] POST /api/4px/create-order API body:', JSON.stringify(err.apiBody))
		}
		console.error('[4px] POST /api/4px/create-order:', err.message, err.code ? `(code: ${err.code})` : '')
		res.status(err.status || 500).json({
			error: err.message,
			code: err.code,
			...(err.consignment_no && { consignment_no: err.consignment_no }),
			...(err.apiBody && { api_response: err.apiBody }),
		})
	}
})

// Filesystem-safe label filenames (named by buyer) + case-insensitive
// de-duplication live in ../fourpx/orders as pure, unit-tested helpers
// (safeLabelBaseName / assignUniqueLabelNames). A thin alias keeps the existing
// single-label call sites readable.
const safe4pxLabelBaseName = safeLabelBaseName

/**
 * Run an idempotent async operation, retrying only on transient transport
 * faults (connection resets / timeouts) with bounded exponential backoff.
 *
 * MUST only wrap idempotent reads — never a non-idempotent create — because a
 * lost response would otherwise be replayed as a duplicate side effect.
 *
 * @param {() => Promise<any>} fn
 * @param {object} [opts]
 * @param {number} [opts.maxAttempts=3]
 * @param {number} [opts.baseDelayMs=500]
 * @param {string} [opts.label='operation']
 */
async function withTransientRetry(fn, opts = {}) {
	const maxAttempts = Math.max(1, opts.maxAttempts ?? 3)
	const baseDelayMs = opts.baseDelayMs ?? 500
	const label = opts.label ?? 'operation'
	let lastError
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return await fn()
		} catch (err) {
			lastError = err
			if (!isTransientDownloadError(err) || attempt === maxAttempts) throw err
			const backoff = Math.min(baseDelayMs * 2 ** (attempt - 1), 5_000)
			const delayMs = Math.round(backoff / 2 + Math.random() * (backoff / 2))
			console.warn(`[4px] ${label} transient failure (${err.message}) — retry ${attempt}/${maxAttempts - 1} in ${delayMs}ms`)
			await new Promise((r) => setTimeout(r, delayMs))
		}
	}
	throw lastError
}

/**
 * Resolve the shipping-label URL for a receipt — returns the cached URL when
 * present, otherwise fetches it from 4PX (ds.xms.label.get) and caches it.
 *
 * Shared by the single label / label-download routes and the bulk labels ZIP.
 *
 * @param {number|string} receiptId
 * @param {object} creds  { appKey, appSecret }
 * @returns {Promise<{ labelUrl: string|null, buyerName: string, trackingNo: string|null, consignmentNo: string|null }>}
 * @throws  {Error} err.status set when the receipt or 4PX order is missing.
 */
async function resolve4pxLabelUrl(receiptId, { appKey, appSecret }) {
	const row = db.prepare('SELECT fourpx_consignment_no, fourpx_tracking_no, fourpx_label_url, name AS buyer_name FROM receipts WHERE receipt_id = ?').get(receiptId)

	if (!row) {
		const e = new Error('Receipt not found')
		e.status = 404
		throw e
	}
	if (!row.fourpx_consignment_no && !row.fourpx_tracking_no) {
		const e = new Error('No 4PX order exists for this receipt')
		e.status = 404
		throw e
	}

	let labelUrl = row.fourpx_label_url
	if (!labelUrl) {
		// ds.xms.label.get resolves by the 4PX tracking number (4px_tracking_no);
		// the ds_consignment_no (DS… prefix) returns "Can not find this order".
		const requestNo = row.fourpx_tracking_no || row.fourpx_consignment_no
		// ds.xms.label.get is a pure READ, so a transient transport reset
		// ("socket hang up") on the 4PX gateway is safe to replay. Retry it with
		// bounded exponential backoff before surfacing the failure.
		const label = await withTransientRetry(() => getShipLabel(appKey, appSecret, requestNo, { format: 'PDF' }), { label: 'ds.xms.label.get' })
		labelUrl = label.logisticsLabel ?? label.customLabel ?? null
		if (labelUrl) {
			upsertFourpxShipment(db, receiptId, {
				consignmentNo: row.fourpx_consignment_no,
				labelUrl,
				status: 'label_fetched',
			})
		}
	}

	return {
		labelUrl,
		buyerName: row.buyer_name || '',
		trackingNo: row.fourpx_tracking_no,
		consignmentNo: row.fourpx_consignment_no,
	}
}

/**
 * Fetch the bytes of a (possibly plain-HTTP) 4PX label URL into a Buffer.
 *
 * Delegates to the shared resilient downloader (src/util/http-download.js) so a
 * transient CDN connection reset ("socket hang up" / ECONNRESET) — the #1 cause
 * of intermittent "Label did not print" failures — is transparently retried
 * with exponential backoff instead of failing the operator's one print click.
 * Also follows 30x redirects and guards against truncated bodies.
 *
 * Used by the single label-print / label-download routes and the bulk ZIP builder.
 *
 * @param {string} labelUrl
 * @param {number} [timeoutMs=25000]  Per-attempt inactivity timeout.
 * @returns {Promise<Buffer>}
 */
function fetch4pxLabelBuffer(labelUrl, timeoutMs = 25_000) {
	return downloadToBuffer(labelUrl, {
		timeoutMs,
		maxAttempts: 4,
		label: '4PX shipping label',
		onRetry: ({ attempt, maxAttempts, delayMs, error }) => {
			console.warn(`[4px] label download ${error.code || ''} (${error.message}) — ` + `retry ${attempt}/${maxAttempts - 1} in ${delayMs}ms`)
		},
	})
}

/**
 * GET /api/4px/label/:receipt_id
 * Fetch (or return cached) shipping label URL for a receipt.
 * Query param: format = 'PDF' | 'IMG' (default PDF)
 */
app.get('/api/4px/label/:receipt_id', async (req, res) => {
	try {
		const { appKey, appSecret } = get4pxCredentials()
		const { receipt_id } = req.params
		const format = (req.query.format || 'PDF').toUpperCase()

		const row = db.prepare('SELECT fourpx_consignment_no, fourpx_tracking_no, fourpx_label_url FROM receipts WHERE receipt_id = ?').get(receipt_id)

		if (!row) return res.status(404).json({ error: 'Receipt not found' })
		if (!row.fourpx_consignment_no && !row.fourpx_tracking_no) {
			return res.status(404).json({ error: 'No 4PX order exists for this receipt' })
		}

		// Return cached label if we have one (label URLs are long-lived at 4PX)
		if (row.fourpx_label_url) {
			return res.json({ success: true, labelUrl: row.fourpx_label_url, cached: true })
		}

		// ds.xms.label.get resolves by the 4PX tracking number (4px_tracking_no).
		// The ds_consignment_no (DS… prefix) returns "Can not find this order".
		const requestNo = row.fourpx_tracking_no || row.fourpx_consignment_no
		const label = await getShipLabel(appKey, appSecret, requestNo, { format })
		const labelUrl = label.logisticsLabel ?? label.customLabel ?? null

		if (labelUrl) {
			upsertFourpxShipment(db, receipt_id, {
				consignmentNo: row.fourpx_consignment_no,
				labelUrl,
				status: 'label_fetched',
			})
		}

		res.json({ success: true, labelUrl, label })
	} catch (err) {
		console.error('[4px] GET /api/4px/label:', err.message)
		res.status(err.status || 500).json({ error: err.message })
	}
})

/**
 * GET /api/4px/label-download/:receipt_id
 * Proxy-download the shipping label PDF so the browser shows a native
 * "Save As" dialog.  The 4PX label URL is plain HTTP and is cross-origin,
 * so the browser's <a download> attribute is ignored when pointing at it
 * directly.  This endpoint fetches the bytes server-side and re-serves them
 * with Content-Disposition: attachment plus a human-readable filename.
 */
app.get('/api/4px/label-download/:receipt_id', async (req, res) => {
	try {
		const { receipt_id } = req.params
		const { appKey, appSecret } = get4pxCredentials()

		const { labelUrl, buyerName, trackingNo, consignmentNo } = await resolve4pxLabelUrl(receipt_id, { appKey, appSecret })

		if (!labelUrl) {
			return res.status(404).json({ error: 'Label not yet available — please try again in a few seconds.' })
		}

		// Filename = buyer name only: "Julie Zaring.pdf". Built via the
		// content-disposition library (RFC 6266) so non-ASCII buyer names such as
		// "Łukasz Gierszon" produce a valid ASCII `filename=` fallback PLUS a UTF-8
		// `filename*=` form, instead of throwing ERR_INVALID_CHAR on setHeader.
		const filename = `${safe4pxLabelBaseName(buyerName, trackingNo || consignmentNo)}.pdf`

		// Pull the PDF server-side (4PX label URLs are often plain HTTP, so the
		// browser would block a direct mixed-content fetch). fetch4pxLabelBuffer
		// transparently retries transient CDN resets ("socket hang up"), follows
		// redirects and rejects truncated bodies — so we buffer the (small) PDF
		// once and re-serve it, rather than piping a fragile single-shot stream
		// that dies on the first reset.
		const buf = await fetch4pxLabelBuffer(labelUrl)
		if (res.writableEnded || res.destroyed) return // client already gave up
		res.setHeader('Content-Type', 'application/pdf')
		res.setHeader('Content-Disposition', contentDisposition(filename))
		res.setHeader('Content-Length', buf.length)
		res.end(buf)
	} catch (err) {
		console.error('[4px] GET /api/4px/label-download:', err.message)
		// A failed upstream label fetch is a bad-gateway (502) condition, not our
		// own 500. resolve4pxLabelUrl sets err.status (404) for missing receipts.
		const code = err.status || (err.statusCode || err.cause?.statusCode ? 502 : 500)
		if (!res.headersSent) res.status(code).json({ error: err.message })
	}
})

// Absolute path to the GDI image-print helper (repo-root/scripts).
const LABEL_PRINT_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'print-label-image.ps1')
const LABEL_PRINT_DEDUPE_MS = 10_000
const _labelPrintInFlight = new Set()
const _labelPrintedAt = new Map()

/**
 * Remember that something just printed, so a double-tap can be recognised, and
 * forget it once the window has passed. The expiry is what keeps these maps from
 * growing for the lifetime of a long-running server.
 *
 * @param {Map<string, number>} map
 * @param {string} key
 * @param {number} ttlMs dedupe window this map is keyed to
 */
function _recordPrinted(map, key, ttlMs) {
	const printedAt = Date.now()
	map.set(key, printedAt)
	const timer = setTimeout(() => {
		// Only expire our own stamp: a reprint inside the window replaces it.
		if (map.get(key) === printedAt) map.delete(key)
	}, ttlMs)
	if (typeof timer.unref === 'function') timer.unref()
}
function _recordLabelPrinted(key) {
	_recordPrinted(_labelPrintedAt, key, LABEL_PRINT_DEDUPE_MS)
}

/**
 * Open a file in the OS default application (detached so it outlives the request).
 * @param {string} fp absolute file path
 */
function _openInDefaultApp(fp) {
	if (process.platform === 'win32') {
		// `start` needs an (empty) title arg before the path; run via cmd.
		spawn('cmd', ['/c', 'start', '', fp], { detached: true, stdio: 'ignore' }).unref()
	} else if (process.platform === 'darwin') {
		spawn('open', [fp], { detached: true, stdio: 'ignore' }).unref()
	} else {
		spawn('xdg-open', [fp], { detached: true, stdio: 'ignore' }).unref()
	}
}

/**
 * GET /api/4px/label-print/:receipt_id
 *
 * Crisp one-click shipping-label print.
 *
 * 4PX label PDFs embed the barcode as a RASTER image. Any scaled / anti-aliased
 * print path (Adobe "Fit", the browser's PDF print) resamples the 1-bit barcode
 * into fuzzy grey bars that print blurry and can be unscannable. Instead we
 * rasterize the label OURSELVES to a pure 1-bit bitmap at the printer's exact
 * native dot grid (80 × 80 mm @ 203 dpi = 639 × 639 dots) and print it 1:1 via
 * GDI — every bar lands on a whole printer dot, so the barcode stays razor
 * sharp. See src/fourpx/label-print.js.
 *
 * Modes (config.label_print_mode):
 *   'auto'   → silent direct print on Windows when the printer resolves; else
 *              fall back to opening the PDF in the OS default app.
 *   'silent' → always print directly (surfaces an error if the printer is gone).
 *   'open'   → always open the PDF in the OS default app (no direct print).
 *
 * Response: { ok, mode: 'printed' | 'opened', printer?, file?,
 *             coverage_pct?, warnings?: string[] }
 * `warnings` is non-fatal: the label DID print, but its geometry (configured
 * stock shape, or the driver's printable area) is off and the operator should
 * fix it before running a batch.
 */
app.get('/api/4px/label-print/:receipt_id', async (req, res) => {
	const printKey = String(req.params.receipt_id)
	const lastPrintedAt = _labelPrintedAt.get(printKey) || 0
	const remainingMs = LABEL_PRINT_DEDUPE_MS - (Date.now() - lastPrintedAt)
	if (_labelPrintInFlight.has(printKey) || remainingMs > 0) {
		const retryAfter = Math.max(1, Math.ceil(Math.max(remainingMs, 1000) / 1000))
		res.setHeader('Retry-After', String(retryAfter))
		return res.status(409).json({
			error: `A label print for this order was just sent. Wait ${retryAfter}s before printing another copy.`,
			code: 'LABEL_PRINT_DEDUPED',
			retry_after: retryAfter,
		})
	}
	_labelPrintInFlight.add(printKey)
	try {
		const { receipt_id } = req.params
		const { appKey, appSecret } = get4pxCredentials()

		const { labelUrl, buyerName, trackingNo, consignmentNo } = await resolve4pxLabelUrl(receipt_id, { appKey, appSecret })

		if (!labelUrl) {
			return res.status(404).json({ error: 'Label not yet available — please try again in a few seconds.' })
		}

		// Pull the bytes server-side (4PX label URLs are frequently plain HTTP, so
		// the browser would block a direct mixed-content fetch).
		const buf = await fetch4pxLabelBuffer(labelUrl)
		const baseName = safe4pxLabelBaseName(buyerName, trackingNo || consignmentNo)

		const mode = config.label_print_mode || 'auto'
		const wantDirect = mode === 'silent' || (mode === 'auto' && process.platform === 'win32')

		if (wantDirect) {
			try {
				const { png, width, height, coveragePct } = await renderLabelBitmap(buf, {
					widthMm: config.label_width_mm,
					heightMm: config.label_height_mm,
					dpi: config.label_dpi,
					threshold: config.label_print_threshold,
				})
				// Media-fit guard. The render letterboxes the label into the
				// configured stock, so stock of the wrong SHAPE still prints — just
				// silently shrunk, with a proportionally smaller (harder to scan)
				// barcode and no error anywhere. Coverage makes that visible.
				const mediaWarning = coveragePct < MIN_HEALTHY_COVERAGE_PCT ? `Label stock mismatch: the label only fills ${coveragePct}% of the configured ` + `${config.label_width_mm}×${config.label_height_mm} mm media, so it prints shrunk. ` + `4PX labels are square — set label_width_mm/label_height_mm in config.json to the stock you actually loaded.` : null
				if (mediaWarning) console.warn(`[4px] ${mediaWarning}`)

				const pngPath = writeTempLabelPng(png, baseName)
				const diag = await printBitmapWindows(pngPath, {
					printerName: config.label_printer_name,
					widthMm: config.label_width_mm,
					heightMm: config.label_height_mm,
					copies: config.label_print_copies,
					dpi: config.label_dpi,
					scriptPath: LABEL_PRINT_SCRIPT,
				})
				// Past this point the label has PHYSICALLY printed, so nothing here
				// may throw: the catch below degrades to opening the PDF, which would
				// leave the operator with a printed label AND a manual-print prompt.
				const geometryWarnings = Array.isArray(diag?.warnings) ? diag.warnings : []
				console.log(`[4px] printed label for receipt ${receipt_id} → "${config.label_printer_name}" ` + `(${width}×${height} dots, ${coveragePct}% media fit` + `${diag?.paper ? `, paper ${diag.paper}` : ''}${diag?.resolution ? `, ${diag.resolution} dpi` : ''})`)
				for (const w of geometryWarnings) console.warn(`[4px] print geometry: ${w}`)

				_recordLabelPrinted(printKey)
				return res.json({
					ok: true,
					mode: 'printed',
					printer: config.label_printer_name,
					coverage_pct: coveragePct,
					// Surfaced so the operator learns about a stock/driver geometry
					// problem on the very first print instead of after a batch of
					// undersized or edge-clipped labels.
					warnings: [mediaWarning, ...geometryWarnings].filter(Boolean),
				})
			} catch (printErr) {
				console.error('[4px] direct label print failed:', printErr.message)
				// A printer that is offline / out of labels / jammed is an actionable
				// hardware fault: surface it in every mode instead of silently opening
				// the PDF, or the operator thinks it printed when nothing came out.
				if (printErr.printerNotReady) {
					return res.status(503).json({ error: printErr.message })
				}
				// In 'silent' mode the operator explicitly opted out of the fallback,
				// so surface the failure. In 'auto' mode, degrade to opening the PDF.
				if (mode === 'silent') {
					return res.status(500).json({ error: `Direct print failed: ${printErr.message}` })
				}
			}
		}

		// Fallback / 'open' mode: drop the PDF to temp and open in the default app
		// so the operator can print it manually.
		const dir = path.join(os.tmpdir(), 'ued-4px-labels')
		fs.mkdirSync(dir, { recursive: true })
		const fp = path.join(dir, `${baseName}.pdf`)
		fs.writeFileSync(fp, buf)
		_openInDefaultApp(fp)
		_recordLabelPrinted(printKey)
		res.json({ ok: true, mode: 'opened', file: `${baseName}.pdf` })
	} catch (err) {
		console.error('[4px] GET /api/4px/label-print:', err.message)
		if (!res.headersSent) res.status(err.status || 500).json({ error: err.message })
	} finally {
		_labelPrintInFlight.delete(printKey)
	}
})

// ─────────────────────────────────────────────────────────────────────────────
// 4PX DOOR-TO-DOOR PICKUP (揽收预约)
//
// Closing the last manual step of the packing shift. Sealing a parcel used to be
// the end of the line here: somebody still had to open b.4px.com, find
// DSS → 揽收预约 → 新建预约, and book a driver for what the bench had just
// finished. These routes put that same booking on the packing screen, driven by
// the three methods 4PX publishes for it (create / cancel / print).
//
// THREE PROPERTIES THIS CODE HAS TO GUARANTEE
//   1. Never double-dispatch. ds.xms.api.collect.create.order takes no client
//      idempotency key, so a double-tap or two tabs must be stopped BEFORE the
//      call: single-flight in this process, a cross-process DB lock, and a
//      duplicate check against the day's existing appointment.
//   2. Never lose a booking. The outbox row is written before the call, so a
//      crash or timeout mid-flight leaves an auditable 'unknown' instead of a
//      driver nobody knows about. See src/db/setup.js.
//   3. Never invent 4PX state. There is no query method for appointments, so
//      everything reported here is what WE submitted; driver assignment and
//      collection progress stay in the portal, and the UI says so.
// ─────────────────────────────────────────────────────────────────────────────

/** Config-resolved settings for the pickup calendar. */
function pickupCalendarOptions() {
	return {
		timeZone: config.fourpx_pickup_timezone || FOURPX_DEFAULT_PICKUP_TIMEZONE,
		maxDaysAhead: config.fourpx_pickup_max_days_ahead,
	}
}

/**
 * Which sealed parcels count as still waiting for a driver.
 *
 * Bounded by how recently they were sealed: an unscanned parcel from two months
 * ago left long ago and only reads as unscanned because its tracking never
 * resolved. See listParcelsAwaitingFourpxPickup in src/db/setup.js.
 */
function pickupAwaitingParcels() {
	return listParcelsAwaitingFourpxPickup(db, { withinDays: config.fourpx_pickup_awaiting_days })
}

/**
 * Credentials + feature gate for every pickup route.
 * Throws a 501 with an actionable message when the feature cannot work.
 */
function get4pxPickupCredentials() {
	if (config.fourpx_pickup_booking === false) {
		const err = new Error('4PX pickup booking is turned off (fourpx_pickup_booking: false in config.json).')
		err.status = 501
		err.code = 'PICKUP_DISABLED'
		throw err
	}
	return get4pxCredentials()
}

/** Shape one outbox row for the browser. */
function serializePickupAppointment(row) {
	if (!row) return null
	return {
		id: row.id,
		collect_no: row.collect_no || null,
		reserve_date: row.reserve_date,
		status: row.status,
		parcel_count: row.parcel_count ?? 0,
		contact_name: row.contact_name || null,
		contact_phone: row.contact_phone || null,
		city: row.city || null,
		district: row.district || null,
		detail_address: row.detail_address || null,
		error_message: row.error_message || null,
		created_by: row.created_by || null,
		created_at: row.created_at,
		cancelled_at: row.cancelled_at || null,
		// A form can only be printed once 4PX has issued an appointment number.
		can_print: row.status === 'submitted' && !!row.collect_no,
		can_cancel: row.status === 'submitted' && !!row.collect_no,
		parcels: Array.isArray(row.parcels) ? row.parcels : undefined,
	}
}

/**
 * GET /api/4px/pickup/options
 *
 * Everything the booking dialog needs in one round trip: whether the feature is
 * usable, the bookable dates, the pre-fill address, which sealed parcels are
 * still waiting for a driver, and the recent bookings. One request rather than
 * five keeps the dialog instant on the bench tablet.
 */
app.get('/api/4px/pickup/options', (_req, res) => {
	try {
		const enabled = !!(config.fourpx_app_key && config.fourpx_app_secret) && config.fourpx_pickup_booking !== false
		// Reap anything a crash orphaned before reporting state, so a stale
		// 'submitting' row can never present as an in-flight request forever.
		if (enabled) pruneStaleFourpxPickupAppointments(db)

		const calendar = pickupCalendarOptions()
		const awaiting = enabled ? pickupAwaitingParcels() : []
		const appointments = enabled ? listFourpxPickupAppointments(db, { limit: 12 }) : []
		const dates = listReserveDateOptions(calendar)
		// Mark the days already spoken for so the dialog can warn before the POST
		// rather than after a 409.
		const bookedDates = new Set(appointments.filter((a) => FOURPX_PICKUP_BLOCKING_STATUSES.includes(a.status)).map((a) => a.reserve_date))

		res.json({
			enabled,
			timezone: calendar.timeZone,
			today: fourpxCollect.todayInTimeZone(calendar.timeZone),
			max_days_ahead: fourpxCollect.normalizeMaxDaysAhead(calendar.maxDaysAhead),
			dates: dates.map((d) => ({ ...d, booked: bookedDates.has(d.date) })),
			pickup: config.fourpx_pickup || null,
			pickup_fields: FOURPX_PICKUP_FIELDS,
			awaiting: {
				count: awaiting.length,
				oldest_packaged_at: awaiting.length ? awaiting[0].packaged_at : null,
				// The lookback the count is scoped to, so the page can say what it
				// counted instead of implying it knows about every parcel ever sealed.
				within_days: fourpxCollect.normalizeAwaitingDays(config.fourpx_pickup_awaiting_days),
				receipt_ids: awaiting.map((p) => p.receipt_id),
			},
			appointments: appointments.map(serializePickupAppointment),
		})
	} catch (err) {
		console.error('[4px/pickup] GET options:', err.message)
		res.status(err.status || 500).json({ error: err.message })
	}
})

/**
 * GET /api/4px/pickup/appointments
 * The pickup history on its own, for a background refresh after an action.
 */
app.get('/api/4px/pickup/appointments', (req, res) => {
	try {
		pruneStaleFourpxPickupAppointments(db)
		const limit = Number(req.query.limit) || 12
		const rows = listFourpxPickupAppointments(db, { limit })
		res.json({ appointments: rows.map(serializePickupAppointment) })
	} catch (err) {
		console.error('[4px/pickup] GET appointments:', err.message)
		res.status(err.status || 500).json({ error: err.message })
	}
})

// Single-flight by pickup DATE. Two packers (or one impatient double-tap) must
// not both get past the duplicate check and book the same day twice — a second
// driver is a real cost and a confusing hand-over. Keyed on the date rather than
// globally so two different days can still be booked concurrently.
const _pickupBookInFlight = new Map()
const FOURPX_PICKUP_LOCK_OWNER = `${os.hostname()}:${process.pid}`
const FOURPX_PICKUP_LOCK_TTL_SEC = 5 * 60

/**
 * POST /api/4px/pickup/appointments
 * Body: { reserve_date, pickup: {...}, allow_duplicate?: boolean }
 *
 * Books a 4PX collection for the parcels currently sealed and waiting.
 */
app.post('/api/4px/pickup/appointments', async (req, res) => {
	let lockKey = null
	try {
		const { appKey, appSecret } = get4pxPickupCredentials()
		const body = req.body || {}

		// Validate BOTH inputs before touching the network or the DB, so a bad
		// address never leaves a reserved row behind.
		const reserveDate = fourpxCollect.assertReserveDate(body.reserve_date, pickupCalendarOptions())
		// The dialog pre-fills from config but the packer may correct it, so the
		// submitted address wins and config is only the fallback.
		const pickup = fourpxCollect.normalizePickupInfo(body.pickup && typeof body.pickup === 'object' && Object.keys(body.pickup).length ? body.pickup : config.fourpx_pickup)

		pruneStaleFourpxPickupAppointments(db)

		// ── Duplicate guards (in-process, then cross-process, then durable) ──
		if (_pickupBookInFlight.has(reserveDate)) {
			return res.status(409).json({
				error: `A pickup for ${reserveDate} is already being booked. Wait for it to finish.`,
				code: 'PICKUP_BOOK_IN_FLIGHT',
			})
		}
		const existing = findActiveFourpxPickupAppointment(db, reserveDate)
		if (existing && body.allow_duplicate !== true) {
			return res.status(409).json({
				error: existing.status === 'submitted' ? `4PX is already collecting on ${reserveDate} (appointment ${existing.collect_no}). Cancel that one first, or confirm you want a second driver.` : `A booking for ${reserveDate} was submitted but 4PX never confirmed it. Check 揽收预约 in the 4PX portal before booking again.`,
				code: 'PICKUP_ALREADY_BOOKED',
				appointment: serializePickupAppointment(existing),
			})
		}
		lockKey = `fourpx_pickup:${reserveDate}`
		if (!acquireLock(db, lockKey, FOURPX_PICKUP_LOCK_OWNER, FOURPX_PICKUP_LOCK_TTL_SEC)) {
			lockKey = null
			return res.status(409).json({
				error: `Another dashboard process is already booking a 4PX pickup for ${reserveDate}.`,
				code: 'PICKUP_BOOK_LOCKED',
			})
		}

		// Snapshot what the driver is being booked for BEFORE the call, so the
		// attachment reflects the bench at the moment of booking.
		const awaiting = pickupAwaitingParcels()

		// Reserve the outbox row, then call. From here on, every exit path
		// resolves the row — there is no way to leave it dangling.
		const appointmentId = openFourpxPickupAppointment(db, {
			reserveDate,
			pickup,
			createdBy: (req.auth && req.auth.user) || null,
		})

		const pending = (async () => {
			try {
				const { collectNo } = await fourpxCollect.createCollectOrder(appKey, appSecret, { reserveDate, pickup })
				resolveFourpxPickupAppointment(db, appointmentId, { status: 'submitted', collectNo })
				attachFourpxPickupParcels(db, appointmentId, awaiting)
				return collectNo
			} catch (err) {
				// A business rejection is definite (nothing booked); a transport
				// failure is not, and must be recorded as such — see the module
				// header in src/fourpx/collect.js.
				const uncertain = err.code === 'PICKUP_CREATE_UNCERTAIN'
				resolveFourpxPickupAppointment(db, appointmentId, {
					status: uncertain ? 'unknown' : 'failed',
					errorMessage: err.message,
				})
				throw err
			}
		})()
		_pickupBookInFlight.set(reserveDate, pending)
		let collectNo
		try {
			collectNo = await pending
		} finally {
			if (_pickupBookInFlight.get(reserveDate) === pending) _pickupBookInFlight.delete(reserveDate)
		}

		const row = getFourpxPickupAppointment(db, { id: appointmentId })
		console.log(`[4px/pickup] booked ${reserveDate} → appointment ${collectNo} (${awaiting.length} sealed parcel(s))`)
		res.json({
			success: true,
			appointment: serializePickupAppointment({ ...row, parcels: awaiting.map((p) => ({ receipt_id: p.receipt_id, tracking_no: p.tracking_no })) }),
		})
	} catch (err) {
		console.error('[4px/pickup] POST appointments:', err.message)
		const status = err.status || (err.code === 'PICKUP_CREATE_UNCERTAIN' ? 504 : 502)
		res.status(status).json({
			error: err.code === 'PICKUP_CREATE_UNCERTAIN' ? `4PX did not answer in time, so it is unclear whether the pickup was booked: ${err.message}. ` + `Check 揽收预约 in the 4PX portal before trying again.` : err.message,
			code: err.code || 'PICKUP_CREATE_FAILED',
			field: err.field || undefined,
		})
	} finally {
		if (lockKey) {
			try {
				releaseLock(db, lockKey, FOURPX_PICKUP_LOCK_OWNER)
			} catch (err) {
				console.warn(`[4px/pickup] could not release ${lockKey}: ${err.message}`)
			}
		}
	}
})

/**
 * POST /api/4px/pickup/appointments/:id/cancel
 * Body: { reason?: string }
 *
 * Cancels at 4PX first, and only then locally — a local row flipped to
 * "cancelled" while the driver is still coming is the one outcome worth
 * protecting against, so the API is the source of truth for the transition.
 */
app.post('/api/4px/pickup/appointments/:id/cancel', async (req, res) => {
	try {
		const { appKey, appSecret } = get4pxPickupCredentials()
		const id = Number(req.params.id)
		if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid appointment id' })

		const row = getFourpxPickupAppointment(db, { id })
		if (!row) return res.status(404).json({ error: 'Pickup appointment not found' })
		if (row.status === 'cancelled') {
			// Idempotent: re-cancelling an already-cancelled pickup is a no-op, not
			// an error, so a retried click cannot fail.
			return res.json({ success: true, already: true, appointment: serializePickupAppointment(row) })
		}
		if (!row.collect_no) {
			return res.status(409).json({
				error: '4PX never returned an appointment number for this booking, so there is nothing to cancel here. Check 揽收预约 in the 4PX portal.',
				code: 'PICKUP_NO_COLLECT_NO',
			})
		}

		await fourpxCollect.cancelCollectOrder(appKey, appSecret, row.collect_no, { reason: req.body?.reason })
		cancelFourpxPickupAppointment(db, id, {
			by: (req.auth && req.auth.user) || null,
			reason: fourpxCollect.normalizeCancelReason(req.body?.reason),
		})
		console.log(`[4px/pickup] cancelled appointment ${row.collect_no} (${row.reserve_date})`)
		res.json({ success: true, appointment: serializePickupAppointment(getFourpxPickupAppointment(db, { id })) })
	} catch (err) {
		console.error('[4px/pickup] POST cancel:', err.message)
		res.status(err.status || 502).json({ error: err.message, code: err.code || 'PICKUP_CANCEL_FAILED' })
	}
})

/**
 * Resolve the appointment row and the PDF bytes of its form (打印预约单).
 *
 * Shared by the two things an operator can do with that sheet — read it in the
 * browser, or send it straight to the printer — so both agree on what "the form
 * for this appointment" means and neither can drift on error wording.
 *
 * The URL is cached on the row: 打印预约单 is a pure read, but it is still a
 * billed API call, and a reprint should not spend one.
 *
 * @param {number} id
 * @returns {Promise<{ row: object, buffer: Buffer }>}
 * @throws {Error} with .status set (404 unknown/not ready, 409 no appointment number)
 */
async function loadPickupFormPdf(id) {
	const { appKey, appSecret } = get4pxPickupCredentials()
	const row = getFourpxPickupAppointment(db, { id })
	if (!row) {
		const err = new Error('Pickup appointment not found')
		err.status = 404
		throw err
	}
	if (!row.collect_no) {
		const err = new Error('This booking has no 4PX appointment number yet, so no form exists.')
		err.status = 409
		err.code = 'PICKUP_NO_COLLECT_NO'
		throw err
	}

	let formUrl = row.form_url
	if (!formUrl) {
		// A pure read, so a transient gateway reset is safe to replay.
		const printed = await withTransientRetry(() => fourpxCollect.printCollectOrder(appKey, appSecret, row.collect_no), { label: 'ds.xms.api.collect.print.order' })
		formUrl = printed.pdfUrl
		if (formUrl) setFourpxPickupFormUrl(db, id, formUrl)
	}
	if (!formUrl) {
		const err = new Error('The appointment form is not ready yet — try again in a few seconds.')
		err.status = 404
		throw err
	}

	const buffer = await downloadToBuffer(formUrl, { timeoutMs: 25_000, maxAttempts: 4, label: '4PX appointment form' })
	return { row, buffer }
}

/** Reject an appointment id that is not a positive integer. */
function parsePickupAppointmentId(raw) {
	const id = Number(raw)
	if (!Number.isInteger(id) || id < 1) {
		const err = new Error('Invalid appointment id')
		err.status = 400
		throw err
	}
	return id
}

/**
 * GET /api/4px/pickup/appointments/:id/form
 *
 * Streams the 4PX appointment form (打印预约单) as an inline PDF — the sheet the
 * driver signs. Proxied rather than linked because 4PX serves these from a plain
 * -HTTP host, which the browser blocks as mixed content from an HTTPS dashboard.
 *
 * This is the READ path (open it, check it, save it). The one-click print lives
 * in the POST route below, because printing is a physical side effect.
 */
app.get('/api/4px/pickup/appointments/:id/form', async (req, res) => {
	try {
		const id = parsePickupAppointmentId(req.params.id)
		const { row, buffer } = await loadPickupFormPdf(id)
		res.setHeader('Content-Type', 'application/pdf')
		res.setHeader('Content-Length', String(buffer.length))
		res.setHeader('Content-Disposition', contentDisposition(`4px-pickup-${row.collect_no}.pdf`, { type: 'inline' }))
		res.setHeader('Cache-Control', 'no-store')
		res.end(buffer)
	} catch (err) {
		console.error('[4px/pickup] GET form:', err.message)
		if (!res.headersSent) res.status(err.status || 502).json({ error: err.message, code: err.code || 'PICKUP_FORM_FAILED' })
	}
})

// A second identical sheet within a few seconds is a double-tap, not a decision.
// (Wanting two copies every time is what label_print_copies is for.)
const PICKUP_FORM_PRINT_DEDUPE_MS = 8_000
const _pickupFormPrintInFlight = new Set()
const _pickupFormPrintedAt = new Map()

/**
 * POST /api/4px/pickup/appointments/:id/print
 *
 * One-click print of the 4PX appointment form (打印预约单) — the barcode the
 * collecting driver scans when the parcels are handed over.
 *
 * WHY THIS IS NOT "OPEN THE PDF AND PRESS CTRL+P"
 * The parcels, the driver and the label printer are all at the bench; the
 * dashboard may be on a tablet. Handing the operator a PDF viewer means finding
 * the print dialog, picking a printer and hoping the scaling is right, on the one
 * artefact that has to exist before the van leaves. Printing it here makes it one
 * tap, and — because the print script pre-flights the printer — a printer that is
 * offline or out of labels is reported as such instead of a job silently piling
 * up in the spooler.
 *
 * WHY THE LABEL PIPELINE
 * 4PX issues this form as a 95 × 95 mm square whose content is a Code128 of the
 * appointment number: the same artefact class as a shipping label, on the same
 * stock. So it uses the same crisp 1-bit render at the printer's native dot grid
 * (see src/fourpx/label-print.js) — a scaled/anti-aliased print would blur those
 * bars, and an unscannable appointment barcode means a manual hand-over.
 *
 * Modes and hardware come from the label block in config.json
 * (label_print_mode / label_printer_name / label_width_mm / label_height_mm /
 * label_dpi / label_print_copies), so there is nothing extra to misconfigure.
 *
 * Response: { ok, mode: 'printed' | 'opened', printer?, coverage_pct?, file?,
 *             warnings?: string[] }
 */
app.post('/api/4px/pickup/appointments/:id/print', async (req, res) => {
	let printKey = null
	try {
		const id = parsePickupAppointmentId(req.params.id)
		printKey = String(id)

		// Double-tap guard, mirroring the shipping-label print path: the second
		// tap of an impatient double-click must not put a second sheet on the
		// printer, but it must also say so rather than appearing to do nothing.
		const lastPrintedAt = _pickupFormPrintedAt.get(printKey) || 0
		const remainingMs = PICKUP_FORM_PRINT_DEDUPE_MS - (Date.now() - lastPrintedAt)
		if (_pickupFormPrintInFlight.has(printKey) || remainingMs > 0) {
			const retryAfter = Math.max(1, Math.ceil(Math.max(remainingMs, 1000) / 1000))
			res.setHeader('Retry-After', String(retryAfter))
			printKey = null // nothing to release: this request never claimed it
			return res.status(409).json({
				error: `This appointment form was just sent to the printer. Wait ${retryAfter}s if you need another copy.`,
				code: 'PICKUP_FORM_PRINT_DEDUPED',
				retry_after: retryAfter,
			})
		}
		_pickupFormPrintInFlight.add(printKey)

		const { row, buffer } = await loadPickupFormPdf(id)
		const baseName = `4px-pickup-${String(row.collect_no).replace(/[^\w.-]+/g, '_')}`

		const mode = config.label_print_mode || 'auto'
		const wantDirect = mode === 'silent' || (mode === 'auto' && process.platform === 'win32')
		let shapeRefusal = null

		if (wantDirect) {
			try {
				const { png, width, height, coveragePct } = await renderLabelBitmap(buffer, {
					widthMm: config.label_width_mm,
					heightMm: config.label_height_mm,
					dpi: config.label_dpi,
					threshold: config.label_print_threshold,
				})
				// Shape guard. The render letterboxes whatever 4PX sent into the
				// loaded stock, so a form that is NOT label-shaped still "prints" —
				// as shrunken content with a barcode nobody can scan. 4PX issues
				// this form square today; if that ever changes, do not burn a label
				// on it, and say why.
				if (coveragePct < MIN_HEALTHY_COVERAGE_PCT) {
					shapeRefusal = `4PX returned an appointment form that is not label-shaped: it would fill only ${coveragePct}% ` + `of the ${config.label_width_mm}×${config.label_height_mm} mm stock, too small to scan. ` + `Print the PDF on paper instead, or set label_width_mm/label_height_mm to the stock you actually loaded.`
					console.warn(`[4px/pickup] ${shapeRefusal}`)
					// 'silent' promised a printed label and cannot deliver one; that
					// is a conflict with the media, not a server fault.
					if (mode === 'silent') {
						return res.status(409).json({ error: shapeRefusal, code: 'PICKUP_FORM_NOT_LABEL_SHAPED' })
					}
					// 'auto': fall through to opening the PDF, carrying the reason.
				} else {
					const pngPath = writeTempLabelPng(png, baseName)
					const diag = await printBitmapWindows(pngPath, {
						printerName: config.label_printer_name,
						widthMm: config.label_width_mm,
						heightMm: config.label_height_mm,
						copies: config.label_print_copies,
						dpi: config.label_dpi,
						scriptPath: LABEL_PRINT_SCRIPT,
					})
					// Past this point the form has PHYSICALLY printed, so nothing here
					// may throw: the catch below degrades to opening the PDF, which
					// would leave the operator with a printed form AND a stray viewer.
					const warnings = Array.isArray(diag?.warnings) ? diag.warnings : []
					console.log(`[4px/pickup] printed appointment form ${row.collect_no} → "${config.label_printer_name}" ` + `(${width}×${height} dots, ${coveragePct}% media fit${diag?.paper ? `, paper ${diag.paper}` : ''})`)
					for (const w of warnings) console.warn(`[4px/pickup] print geometry: ${w}`)

					_recordPrinted(_pickupFormPrintedAt, printKey, PICKUP_FORM_PRINT_DEDUPE_MS)
					return res.json({
						ok: true,
						mode: 'printed',
						printer: config.label_printer_name,
						coverage_pct: coveragePct,
						warnings,
					})
				}
			} catch (printErr) {
				console.error('[4px/pickup] direct form print failed:', printErr.message)
				// An offline / jammed / label-less printer is an actionable hardware
				// fault: surface it in every mode instead of quietly opening a PDF
				// the operator is not looking at.
				if (printErr.printerNotReady) {
					return res.status(503).json({ error: printErr.message, code: 'PRINTER_NOT_READY' })
				}
				if (mode === 'silent') {
					return res.status(500).json({ error: `Direct print failed: ${printErr.message}`, code: 'PICKUP_FORM_PRINT_FAILED' })
				}
				// 'auto': fall through and open the PDF instead.
			}
		}

		// Fallback / 'open' mode: drop the PDF next to the host's default viewer
		// so the operator can print it by hand.
		const dir = path.join(os.tmpdir(), 'ued-4px-pickup-forms')
		fs.mkdirSync(dir, { recursive: true })
		const fp = path.join(dir, `${baseName}.pdf`)
		fs.writeFileSync(fp, buffer)
		_openInDefaultApp(fp)
		_recordPrinted(_pickupFormPrintedAt, printKey, PICKUP_FORM_PRINT_DEDUPE_MS)
		res.json({
			ok: true,
			mode: 'opened',
			file: `${baseName}.pdf`,
			warnings: shapeRefusal ? [shapeRefusal] : [],
		})
	} catch (err) {
		console.error('[4px/pickup] POST print:', err.message)
		if (!res.headersSent) res.status(err.status || 502).json({ error: err.message, code: err.code || 'PICKUP_FORM_PRINT_FAILED' })
	} finally {
		if (printKey) _pickupFormPrintInFlight.delete(printKey)
	}
})

// ─────────────────────────────────────────────────────────────────────────────
// 4PX BULK SHIPPING
//
// The 4PX DS XMS API is strictly per-order (ds.xms.order.create / .label.get
// each act on ONE shipment — there is no batch-create method). "Bulk" is
// therefore orchestrated here: a concurrency-limited fan-out over the existing
// single-order helpers, with idempotency and per-order result reporting so a
// failure on one order never blocks the rest.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run an async mapper over items with a bounded concurrency pool.
 * Results preserve input order; the mapper should resolve (never reject) so one
 * failing item cannot abort the batch — wrap per-item failures into the result.
 *
 * @template I, O
 * @param {I[]} items
 * @param {number} limit
 * @param {(item: I, index: number) => Promise<O>} mapper
 * @returns {Promise<O[]>}
 */
async function runWithConcurrency(items, limit, mapper) {
	const results = new Array(items.length)
	let cursor = 0
	const workers = new Array(Math.min(limit, items.length || 1)).fill(0).map(async () => {
		while (cursor < items.length) {
			const idx = cursor++
			results[idx] = await mapper(items[idx], idx)
		}
	})
	await Promise.all(workers)
	return results
}

/**
 * POST /api/4px/bulk-create-order
 *
 * Create 4PX direct-shipping orders for several receipts at once.
 *
 * Body: {
 *   orders: [{ receipt_id, recipient, parcel, logistics_product_code?, duty_type? }],
 *   logistics_product_code?,   // batch-level default applied when an order omits it
 *   duty_type?                 // batch-level default (default 'U')
 * }
 *
 * Returns 207-style per-order results so the UI can show exactly which orders
 * succeeded (with their tracking numbers) and which failed (with the reason).
 * Orders that already have a 4PX shipment are reported as already_exists rather
 * than erroring the whole batch.
 */
app.post('/api/4px/bulk-create-order', async (req, res) => {
	try {
		const { appKey, appSecret } = get4pxCredentials()
		if (!config.fourpx_sender) {
			return res.status(501).json({
				error: 'fourpx_sender is not configured in config.json. ' + 'Add sender address details to enable shipping order creation.',
			})
		}

		const orders = Array.isArray(req.body?.orders) ? req.body.orders : []
		if (!orders.length) return res.status(400).json({ error: 'orders[] is required and must be non-empty' })
		if (orders.length > 200) return res.status(400).json({ error: 'A maximum of 200 orders can be created per batch' })

		const batchProduct = req.body.logistics_product_code
		const batchDuty = req.body.duty_type || 'U'
		// Batch-level packaging opt-in: only stamp packaged_at when the operator
		// confirmed the parcels are actually packed (per-order override supported).
		const batchMarkPackaged = !!req.body.mark_packaged

		const results = await runWithConcurrency(orders, 4, async (o) => {
			const receiptId = o.receipt_id
			try {
				const result = await create4pxShipmentForReceipt({
					appKey,
					appSecret,
					receipt_id: receiptId,
					recipient: o.recipient,
					parcel: o.parcel,
					logistics_product_code: o.logistics_product_code || batchProduct,
					duty_type: o.duty_type || batchDuty,
					mark_packaged: o.mark_packaged != null ? !!o.mark_packaged : batchMarkPackaged,
				})
				return {
					receipt_id: receiptId,
					success: true,
					trackingNo: result.trackingNo,
					dsConsignmentNo: result.dsConsignmentNo,
					odaResultSign: result.odaResultSign,
					// Present when S5058 was rejected for a US remote/island ZIP and
					// the server auto-retried on US-ISLAND-PH (S5118). The wizard
					// surfaces this so the operator can see why the booked lane
					// differs from what they selected.
					productFallback: result.productFallback || null,
					logistics_product_code: result.productFallback?.to || o.logistics_product_code || batchProduct || null,
				}
			} catch (err) {
				if (err.apiBody) {
					console.error(`[4px/bulk] create receipt ${receiptId} API body:`, JSON.stringify(err.apiBody))
				}
				console.error(`[4px/bulk] create receipt ${receiptId} failed:`, err.message, err.code ? `(${err.code})` : '')
				return {
					receipt_id: receiptId,
					success: false,
					already_exists: err.status === 409,
					// For an already-existing order, surface its tracking so the UI can
					// still complete + label it instead of treating it as a hard failure.
					trackingNo: err.trackingNo || null,
					dsConsignmentNo: err.consignment_no || null,
					error: err.message,
					code: err.code || null,
				}
			}
		})

		const created = results.filter((r) => r.success).length
		const existing = results.filter((r) => r.already_exists).length
		const failed = results.length - created - existing
		console.log(`[4px/bulk] create batch: ${created} created, ${existing} already existed, ${failed} failed (of ${results.length})`)

		res.json({ success: failed === 0, total: results.length, created, existing, failed, results })
	} catch (err) {
		console.error('[4px] POST /api/4px/bulk-create-order:', err.message)
		res.status(err.status || 500).json({ error: err.message })
	}
})

/**
 * GET /api/4px/bulk-labels.zip?receipt_ids=1,2,3
 *
 * Stream a ZIP archive of shipping-label PDFs, ONE entry per receipt, each named
 * by the buyer's name ("Julie Zaring.pdf"). Duplicate names get a numeric suffix
 * so no label is ever overwritten. Labels that can't be fetched are collected
 * into a _label_errors.txt entry rather than failing the whole download.
 */
app.get('/api/4px/bulk-labels.zip', async (req, res) => {
	try {
		const { appKey, appSecret } = get4pxCredentials()
		const ids = String(req.query.receipt_ids || '')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean)
		if (!ids.length) return res.status(400).json({ error: 'receipt_ids query param is required (comma-separated)' })
		if (ids.length > 200) return res.status(400).json({ error: 'A maximum of 200 labels can be downloaded per ZIP' })

		// Resolve every label URL first (bounded concurrency), so we can fail fast
		// with a JSON error before we start streaming the ZIP body.
		const resolved = await runWithConcurrency(ids, 5, async (receiptId) => {
			try {
				const r = await resolve4pxLabelUrl(receiptId, { appKey, appSecret })
				return { receiptId, ...r }
			} catch (err) {
				return { receiptId, labelUrl: null, buyerName: '', error: err.message }
			}
		})

		const stamp = new Date().toISOString().slice(0, 10)
		res.setHeader('Content-Type', 'application/zip')
		res.setHeader('Content-Disposition', `attachment; filename="4PX-Labels-${stamp}.zip"; filename*=UTF-8''4PX-Labels-${stamp}.zip`)

		const { ZipArchive } = await import('archiver')
		const archive = new ZipArchive({ zlib: { level: 6 } })
		archive.on('error', (e) => {
			console.error('[4px/bulk] zip error:', e.message)
			if (!res.headersSent) res.status(500).json({ error: e.message })
			else res.destroy(e)
		})
		res.on('close', () => {
			if (!res.writableFinished) archive.abort()
		})
		archive.pipe(res)

		// Pre-assign one UNIQUE, buyer-named filename per deliverable label up front
		// (case-insensitive dedup so no label is overwritten on Windows/macOS), so
		// each label lands in the ZIP as its own independent file that corresponds
		// to exactly the right buyer.
		const deliverable = resolved.filter((item) => item.labelUrl)
		const nameByReceipt = assignUniqueLabelNames(deliverable)

		const failures = []
		let added = 0

		for (const item of resolved) {
			if (!item.labelUrl) {
				failures.push(`receipt ${item.receiptId}: ${item.error || 'label not available yet'}`)
				continue
			}
			const name = nameByReceipt.get(item.receiptId)
			try {
				const buf = await fetch4pxLabelBuffer(item.labelUrl)
				archive.append(buf, { name })
				added++
			} catch (err) {
				failures.push(`receipt ${item.receiptId} (${name.replace(/\.pdf$/i, '')}): ${err.message}`)
			}
		}

		if (failures.length) {
			archive.append(['Some labels could not be included in this archive:', '', ...failures, '', 'Tip: 4PX may need a few seconds after order creation to generate a label.', 'Re-run the download once the labels show "ready".'].join('\n'), { name: '_label_errors.txt' })
		}
		if (added === 0 && !failures.length) {
			archive.append('No labels were available to download.', { name: 'README.txt' })
		}

		console.log(`[4px/bulk] labels zip: ${added} labels, ${failures.length} failures (of ${ids.length})`)
		archive.finalize()
	} catch (err) {
		console.error('[4px] GET /api/4px/bulk-labels.zip:', err.message)
		if (!res.headersSent) res.status(err.status || 500).json({ error: err.message })
	}
})

/**
 * POST /api/4px/bulk-complete
 *
 * Mark any number of Etsy receipts as shipped, each with its OWN tracking number.
 * Body: { orders: [{ receipt_id, tracking_code, carrier_name? }], carrier_name? }
 *
 * Designed to run right after bulk-create-order: the frontend feeds back each
 * order's 4PX tracking number so completion is fully automated and every order
 * gets the correct, corresponding tracking number on Etsy.
 *
 * ─── Auto-chunk + pace (never reject legitimate work) ─────────────────────────
 * Etsy's anti-abuse systems care about the RATE of writes, not the size of an
 * operator's queue. Blocking a large batch just makes real, already-labeled
 * orders ship late — a worse suspension signal than a paced burst. So we accept
 * any size and process it SEQUENTIALLY in chunks of BULK_SHIP_CHUNK_SIZE:
 *   • BULK_SHIP_INTER_REQUEST_MS pause between each ship,
 *   • BULK_SHIP_INTER_BATCH_MS cooldown between chunks.
 * This keeps the effective rate low and human-like while completing everything.
 *
 * Returns per-order results; one Etsy failure never blocks the others. The
 * response shape is unchanged (total/completed/failed/results) so the existing
 * frontend keeps working; chunk metadata is added for observability.
 */
app.post('/api/4px/bulk-complete', async (req, res) => {
	// Paced completion can legitimately run for minutes on a large batch. Disable
	// the per-socket inactivity timeout for this one long-running request so the
	// connection is never dropped mid-flight (Node's default is already 0/off; this
	// is explicit + future-proof against very large batches or intermediary limits).
	req.setTimeout(0)
	res.setTimeout(0)

	const orders = Array.isArray(req.body?.orders) ? req.body.orders : []
	if (!orders.length) return res.status(400).json({ error: 'orders[] is required and must be non-empty' })
	// Sanity ceiling only — guards against a malformed payload, not a compliance cap.
	if (orders.length > BULK_SHIP_ABSOLUTE_MAX) {
		return res.status(400).json({
			error: `Received ${orders.length} orders, which exceeds the safety ceiling of ${BULK_SHIP_ABSOLUTE_MAX}. ` + 'This looks like a malformed request — split it into separate completions.',
		})
	}

	const batchCarrier = req.body.carrier_name || '4PX'
	const chunks = chunkArray(orders, BULK_SHIP_CHUNK_SIZE)
	const paced = orders.length > 1
	const etaSec = paced ? Math.round(((orders.length - 1) * BULK_SHIP_INTER_REQUEST_MS + (chunks.length - 1) * BULK_SHIP_INTER_BATCH_MS) / 1000) : 0
	console.log(`[4px/bulk] complete: ${orders.length} order(s) in ${chunks.length} chunk(s) of ≤${BULK_SHIP_CHUNK_SIZE}` + (paced ? ` — paced, ~${etaSec}s` : ''))

	const results = []
	for (const [chunkIdx, group] of chunks.entries()) {
		// Cooldown between chunks (not before the first) to keep the write rate low.
		if (chunkIdx > 0) await complianceSleep(BULK_SHIP_INTER_BATCH_MS)

		for (const [i, o] of group.entries()) {
			const isFirstOverall = chunkIdx === 0 && i === 0
			if (!isFirstOverall) await complianceSleep(BULK_SHIP_INTER_REQUEST_MS)
			try {
				const r = await shipEtsyReceipt(o.receipt_id, {
					tracking_code: o.tracking_code,
					carrier_name: o.carrier_name || batchCarrier,
					pacedBulk: true,
				})
				// `skipped` = already shipped with this tracking (idempotent re-run);
				// surfaced so a resumed batch can report "already done" honestly.
				results.push({ receipt_id: o.receipt_id, success: true, tracking_code: (o.tracking_code || '').trim(), skipped: !!r?.skipped })
			} catch (err) {
				const etsyBody = err.response?.data
				const errMsg = (typeof etsyBody === 'object' ? etsyBody?.error_description || etsyBody?.error : null) || err.message
				console.error(`[4px/bulk] complete receipt ${o.receipt_id} failed:`, errMsg)
				results.push({ receipt_id: o.receipt_id, success: false, error: errMsg })
			}
		}
	}

	const ok = results.filter((r) => r.success).length
	const skipped = results.filter((r) => r.success && r.skipped).length
	const failed = results.length - ok
	console.log(`[4px/bulk] complete batch: ${ok} completed${skipped ? ` (${skipped} already shipped, skipped)` : ''}, ${failed} failed (of ${results.length})`)
	res.json({
		success: failed === 0,
		total: results.length,
		completed: ok,
		skipped,
		failed,
		chunks: chunks.length,
		chunk_size: BULK_SHIP_CHUNK_SIZE,
		results,
	})
})

/**
 * DELETE /api/4px/order/:receipt_id
 * Cancel the 4PX order associated with a receipt.
 * Body: { reason: string }
 */
app.delete('/api/4px/order/:receipt_id', async (req, res) => {
	try {
		const { appKey, appSecret } = get4pxCredentials()
		const { receipt_id } = req.params
		const reason = req.body?.reason || 'Customer request'

		const row = db.prepare('SELECT fourpx_consignment_no, fourpx_tracking_no, fourpx_order_status FROM receipts WHERE receipt_id = ?').get(receipt_id)

		if (!row) return res.status(404).json({ error: 'Receipt not found' })
		if (!row.fourpx_consignment_no && !row.fourpx_tracking_no) {
			return res.status(404).json({ error: 'No 4PX order exists for this receipt' })
		}
		if (row.fourpx_order_status === 'cancelled') {
			return res.status(409).json({ error: '4PX order is already cancelled' })
		}

		// ds.xms.order.cancel also resolves by the 4PX tracking number, not the
		// ds_consignment_no (which returns "no such order").
		const requestNo = row.fourpx_tracking_no || row.fourpx_consignment_no
		await cancelShipOrder(appKey, appSecret, requestNo, reason)

		upsertFourpxShipment(db, receipt_id, {
			consignmentNo: row.fourpx_consignment_no,
			status: 'cancelled',
		})

		console.log(`[4px] Cancelled shipment for receipt ${receipt_id} (${row.fourpx_consignment_no})`)
		res.json({ success: true, receipt_id })
	} catch (err) {
		console.error('[4px] DELETE /api/4px/order:', err.message)
		res.status(err.status || 500).json({ error: err.message })
	}
})

/**
 * GET /api/4px/track/:tracking_no
 *
 * Fetch the full tracking event history for a 4PX tracking number.
 * Used by the parcel-route modal in the Orders tab when a user clicks
 * a 4PX tracking number.
 *
 * Routing:
 *   - If fourpx_app_key + fourpx_app_secret are configured → official 4PX API
 *     (tr.order.tracking.get) with full authentication.
 *   - Otherwise → 4PX public tracking endpoint (track.4px.com) as a fallback.
 *
 * Response: { events: [{time, description, location, code}], status: string }
 */
const _trackingTimelineCache = new Map()
const _trackingTimelineInflight = new Map()
const _trackingTimelineRate = new Map()
const TRACKING_TIMELINE_TTL_MS = 60 * 1000
const TRACKING_TIMELINE_MAX_CONCURRENCY = 4
const TRACKING_TIMELINE_RATE_PER_MINUTE = 30

app.get('/api/4px/track/:tracking_no', async (req, res) => {
	try {
		const trackingNo = normalizeFourpxLookupCode(req.params.tracking_no)
		const known = db
			.prepare(
				`
			SELECT receipt_id
			FROM receipts
			WHERE (
			    tracking_code = @trackingNo COLLATE NOCASE
			    OR fourpx_tracking_no = @trackingNo COLLATE NOCASE
			  )
			  AND (
			    fourpx_consignment_no IS NOT NULL
			    OR COALESCE(fourpx_tracking_no, '') != ''
			    OR tracking_code LIKE '4PX%'
			  )
			LIMIT 1
		`,
			)
			.get({ trackingNo })
		if (!known) {
			return res.status(404).json({ error: 'Tracking number is not attached to a dashboard order.' })
		}

		const rateKey = String(req.auth?.user || req.ip || 'local')
		const now = Date.now()
		const recent = (_trackingTimelineRate.get(rateKey) || []).filter((ts) => now - ts < 60_000)
		if (recent.length >= TRACKING_TIMELINE_RATE_PER_MINUTE) {
			const retryAfter = Math.max(1, Math.ceil((60_000 - (now - recent[0])) / 1000))
			res.setHeader('Retry-After', String(retryAfter))
			return res.status(429).json({ error: 'Too many live tracking lookups. Please wait a moment.', retry_after: retryAfter })
		}
		recent.push(now)
		_trackingTimelineRate.set(rateKey, recent)
		if (_trackingTimelineRate.size > 1000) {
			const oldestKey = _trackingTimelineRate.keys().next().value
			_trackingTimelineRate.delete(oldestKey)
		}

		const cached = _trackingTimelineCache.get(trackingNo)
		if (cached && now - cached.cachedAt < TRACKING_TIMELINE_TTL_MS) {
			return res.json({ ...cached.data, cached: true })
		}

		let lookup = _trackingTimelineInflight.get(trackingNo)
		if (!lookup) {
			if (_trackingTimelineInflight.size >= TRACKING_TIMELINE_MAX_CONCURRENCY) {
				res.setHeader('Retry-After', '2')
				return res.status(429).json({ error: 'Carrier lookup capacity is busy. Try again in a few seconds.', retry_after: 2 })
			}
			lookup = getFullTrackingEvents(trackingNo, {
				appKey: config.fourpx_app_key ?? null,
				appSecret: config.fourpx_app_secret ?? null,
			})
				.then((result) => _withHealth(result, { stuckDays: _stuckDays() }))
				.then((data) => {
					_trackingTimelineCache.set(trackingNo, { cachedAt: Date.now(), data })
					if (_trackingTimelineCache.size > 500) {
						const oldest = _trackingTimelineCache.keys().next().value
						_trackingTimelineCache.delete(oldest)
					}
					return data
				})
				.finally(() => _trackingTimelineInflight.delete(trackingNo))
			_trackingTimelineInflight.set(trackingNo, lookup)
		}
		res.json(await lookup)
	} catch (err) {
		console.error('[4px] GET /api/4px/track:', err.message)
		res.status(err.status || 500).json({ error: err.message })
	}
})

// ─── Shipping tab (4PX parcel monitoring) ─────────────────────────────────────

/** Resolve the configured "stuck" threshold in days (default 10). */
function _stuckDays() {
	const value = Number(config.fourpx_stuck_days)
	return Number.isFinite(value) ? Math.min(30, Math.max(3, Math.round(value))) : 10
}

const SHIPPING_STATUS_FILTERS = new Set(['all', 'stuck', 'label_only', 'delayed', 'disposed', 'pre_transit', 'in_transit', 'delivered', 'exception', 'unknown'])
const SHIPPING_CLAIM_FILTERS = new Set(['all', 'open', ...SHIPPING_CLAIM_STATUSES])
const SHIPPING_ALERT_STATE_FILTERS = new Set(['all', 'new'])
const SHIPPING_OUTREACH_FILTERS = new Set(['all', 'needed', 'sent'])

/** Normalize an optional shop scope to a trimmed id, or null for "all shops". */
function _optionalShopId(value) {
	if (value == null) return null
	const trimmed = String(value).trim()
	return trimmed === '' ? null : trimmed
}

/** Parse and bound the shared Shipping list/stats/export query contract. */
function _shippingQueryFilters(req) {
	const status = String(req.query.status || 'all')
		.trim()
		.toLowerCase()
	const claimStatus = String(req.query.claim_status || 'all')
		.trim()
		.toLowerCase()
	const alertState = String(req.query.alert_state || 'all')
		.trim()
		.toLowerCase()
	const outreach = String(req.query.outreach || 'all')
		.trim()
		.toLowerCase()
	if (!SHIPPING_STATUS_FILTERS.has(status)) {
		throw Object.assign(new Error('Invalid shipping status filter.'), { status: 400 })
	}
	if (!SHIPPING_CLAIM_FILTERS.has(claimStatus)) {
		throw Object.assign(new Error('Invalid claim status filter.'), { status: 400 })
	}
	if (!SHIPPING_ALERT_STATE_FILTERS.has(alertState)) {
		throw Object.assign(new Error('Invalid alert state filter.'), { status: 400 })
	}
	if (!SHIPPING_OUTREACH_FILTERS.has(outreach)) {
		throw Object.assign(new Error('Invalid buyer outreach filter.'), { status: 400 })
	}
	const parseEpoch = (name) => {
		if (req.query[name] == null || req.query[name] === '') return undefined
		const n = Number(req.query[name])
		if (!Number.isFinite(n) || n < 0) throw Object.assign(new Error(`Invalid ${name} timestamp.`), { status: 400 })
		return Math.floor(n)
	}
	const from = parseEpoch('from')
	const to = parseEpoch('to')
	if (from != null && to != null && from > to) {
		throw Object.assign(new Error('"from" must be earlier than "to".'), { status: 400 })
	}
	const q = String(req.query.q || '').trim()
	if (q.length > 200) throw Object.assign(new Error('Shipping search must be 200 characters or fewer.'), { status: 400 })
	return {
		status: status === 'all' ? undefined : status,
		claimStatus: claimStatus === 'all' ? undefined : claimStatus,
		alertState: alertState === 'all' ? undefined : alertState,
		outreach: outreach === 'all' ? undefined : outreach,
		shopId: req.query.shop_id ? String(req.query.shop_id).slice(0, 100) : undefined,
		q: q || undefined,
		from,
		to,
	}
}

/**
 * Launch a 4PX tracking cycle and mirror lifecycle/progress over the existing
 * sync SSE bus. The worker owns locking, pacing and durable telemetry; this
 * adapter only makes the result visible to an open Shipping tab.
 */
function _startServerTrackingRefresh(trigger, options = {}) {
	const { ignoreDisabled = false, ...workerOptions } = options
	const publicTelemetry = (payload) => {
		const { results: _results, ...safe } = payload || {}
		return safe
	}
	const launch = startTrackingCycle(db, config, {
		...workerOptions,
		trigger,
		ignoreDisabled,
		onStart: (run) => {
			broadcastSyncEvent({ type: 'tracking_sync_start', ...run, ts: Date.now() })
		},
		onProgress: (progress) => {
			broadcastSyncEvent({ type: 'tracking_sync_progress', ...publicTelemetry(progress), ts: Date.now() })
		},
		onComplete: (summary) => {
			broadcastSyncEvent({ type: 'tracking_sync_done', ...publicTelemetry(summary), ts: Date.now() })
		},
		onError: (failure) => {
			broadcastSyncEvent({ type: 'tracking_sync_error', ...failure, ts: Date.now() })
		},
	})
	if (launch.started) {
		// The HTTP trigger returns immediately; own the promise here so a failed
		// background request is logged rather than becoming an unhandled rejection.
		launch.promise.catch((err) => {
			console.error(`[tracking] ${trigger} refresh failed: ${err.message}`)
		})
	} else {
		console.log(`[tracking] ${trigger} trigger skipped (${launch.reason || 'not started'})`)
	}
	return launch
}

/**
 * GET /api/4px/tracking-sync/status — scheduler health, last run and due backlog.
 */
app.get('/api/4px/tracking-sync/status', (_req, res) => {
	try {
		res.json(getTrackingCycleStatus(db, config))
	} catch (err) {
		console.error('[4px] GET /api/4px/tracking-sync/status:', err.message)
		res.status(500).json({ error: err.message })
	}
})

/**
 * POST /api/4px/tracking-sync/run — enqueue one due-parcel refresh now.
 *
 * Returns 202 immediately; progress is available from the status endpoint and
 * the shared SSE stream. Manual runs remain available when automatic polling is
 * disabled, but still obey the same lock, batch cap and request pacing.
 */
app.post('/api/4px/tracking-sync/run', (_req, res) => {
	try {
		const launch = _startServerTrackingRefresh('manual', { ignoreDisabled: true })
		if (!launch.started) {
			const status = getTrackingCycleStatus(db, config)
			if (launch.reason === 'running') {
				return res.status(409).json({ error: 'A tracking refresh is already running.', ...status })
			}
			return res.status(503).json({ error: 'Tracking refresh could not be started.', reason: launch.reason, ...status })
		}
		res.status(202).json({
			accepted: true,
			run_id: launch.runId,
			message: 'Tracking refresh started.',
		})
	} catch (err) {
		console.error('[4px] POST /api/4px/tracking-sync/run:', err.message)
		res.status(500).json({ error: err.message })
	}
})

/**
 * GET /api/4px/shipping-stats — summary counts for the Shipping tab cards.
 * Query: shop_id?
 */
// Cached-snapshot deployment repairs. These rewrite rows whose stored
// status/health predates a detector or age policy the classifier has learned.
// They are write-heavy passes, so they run once per process rather than on every
// dashboard poll.
let _disposedBackfillDone = false
function ensureDisposedTrackingFlags() {
	if (_disposedBackfillDone) return
	backfillDisposedTrackingFlags(db)
	// Runs second on purpose: disposal is terminal, so it claims its rows before
	// the delivery repair looks at anything.
	backfillDeliveredTrackingFlags(db)
	// Clears Stuck/Delayed customs-loop verdicts when the last event already
	// shows destination-network / last-mile progress (the reported false positives).
	backfillFalseCustomsStuckFlags(db)
	// Queue label-only / long-silent candidates for a full-timeline carrier
	// recheck. Do not publish severity from one lossy cached event.
	queueOverdueTrackingRechecks(db, { stuckDays: _stuckDays() })
	_disposedBackfillDone = true
}

/**
 * Open/close/escalate incident rows so the parcel board can show how long each
 * abnormal parcel has been waiting for attention.
 *
 * Advisory work, not request work: the "new" flag itself is derived from the
 * review ledger and is correct with or without this, so a failure here costs a
 * relative timestamp and nothing else. Never let it fail a dashboard read.
 */
function refreshShippingAlertLedger() {
	try {
		syncShippingAlertLedger(db)
	} catch (err) {
		console.warn('[4px] shipping alert ledger sync failed:', err.message)
	}
}

app.get('/api/4px/shipping-stats', (req, res) => {
	try {
		// Soft-fix rows whose cached last event already says "disposal" but
		// whose status/health were written before that detector existed. This is a
		// legacy repair scan, not request work; run it once per process instead of
		// issuing a write-heavy full-table UPDATE on every dashboard poll.
		ensureDisposedTrackingFlags()
		const filters = _shippingQueryFilters(req)
		const stats = getShippingStats(db, {
			shopId: filters.shopId,
			q: filters.q,
			from: filters.from,
			to: filters.to,
			stuckDays: _stuckDays(),
		})
		res.json({ ...stats, stuck_days: _stuckDays() })
	} catch (err) {
		console.error('[4px] GET /api/4px/shipping-stats:', err.message)
		res.status(err.status || 500).json({ error: err.message })
	}
})

/**
 * GET /api/4px/shipping-alerts — open abnormal parcels for the morning-review
 * alert banner. Ignores ship-date windows so long-silent stuck/disposed parcels
 * still surface. Each alert carries `is_new` (never reviewed, or escalated since
 * review) and the summary carries the matching `new_*` counts.
 * Query: shop_id?
 */
app.get('/api/4px/shipping-alerts', (req, res) => {
	try {
		ensureDisposedTrackingFlags()
		const shopId = _optionalShopId(req.query.shop_id)
		const result = getShippingAlerts(db, { shopId })
		res.json({ ...result, generated_at: Math.floor(Date.now() / 1000) })
	} catch (err) {
		console.error('[4px] GET /api/4px/shipping-alerts:', err.message)
		res.status(err.status || 500).json({ error: err.message })
	}
})

/**
 * POST /api/4px/shipping-alerts/review — mark abnormal parcels as reviewed so
 * they leave the "new" set until they escalate. This is the acknowledge half of
 * the morning-review inbox; it deliberately does NOT resolve the parcel, which
 * stays on the board (and in the claim workflow) until the carrier moves it.
 *
 * Body: { receipt_ids?: number[] }  — omit to review every currently-new alert.
 * Returns the refreshed alert payload so the caller needs no second round trip.
 */
app.post('/api/4px/shipping-alerts/review', (req, res) => {
	try {
		const body = req.body || {}
		let receiptIds
		if (Object.prototype.hasOwnProperty.call(body, 'receipt_ids')) {
			if (!Array.isArray(body.receipt_ids)) {
				return res.status(400).json({ error: 'receipt_ids must be an array of order numbers' })
			}
			if (body.receipt_ids.length > 500) {
				return res.status(400).json({ error: 'Review at most 500 parcels per request' })
			}
			const invalid = body.receipt_ids.some((id) => !Number.isInteger(Number(id)) || Number(id) <= 0)
			if (invalid) return res.status(400).json({ error: 'receipt_ids must be positive order numbers' })
			receiptIds = body.receipt_ids
		}
		ensureDisposedTrackingFlags()
		const result = reviewShippingAlerts(db, { receiptIds, reviewedBy: req.auth?.user || null })
		const shopId = _optionalShopId(body.shop_id ?? req.query.shop_id)
		const refreshed = getShippingAlerts(db, { shopId })
		res.json({
			success: true,
			reviewed: result.reviewed,
			receipt_ids: result.receipt_ids,
			...refreshed,
			generated_at: Math.floor(Date.now() / 1000),
		})
	} catch (err) {
		console.error('[4px] POST /api/4px/shipping-alerts/review:', err.message)
		res.status(err.status || 500).json({ error: err.message })
	}
})

/**
 * GET /api/4px/shipments — paginated list of 4PX parcels with cached tracking
 * snapshot + freight, and an is_stuck flag. Powers the Shipping tab table.
 *
 * Rows also carry the morning-review state (`is_new_alert`, `alert_kind`,
 * `alert_flagged_at`) so every row can show for itself whether it is untriaged
 * work — the alert banner above the board only ever lists the first handful.
 *
 * Query: status? (canonical or 'stuck'|'label_only'|'delayed'|'disposed'),
 * alert_state? ('new'), shop_id?, q?, claim_status?, limit?, offset?
 */
app.get('/api/4px/shipments', (req, res) => {
	try {
		ensureDisposedTrackingFlags()
		refreshShippingAlertLedger()
		const filters = _shippingQueryFilters(req)
		const result = getShipments(db, {
			...filters,
			stuckDays: _stuckDays(),
			limit: req.query.limit,
			offset: req.query.offset,
		})
		res.json({ ...result, stuck_days: _stuckDays() })
	} catch (err) {
		console.error('[4px] GET /api/4px/shipments:', err.message)
		res.status(err.status || 500).json({ error: err.message })
	}
})

/**
 * PUT /api/4px/shipments/:receipt_id/claim — save the Shipping-tab compensation
 * claim note and/or status for one parcel. Dedicated storage (shipping_claim_*),
 * separate from Orders/Route team_note.
 * Body: { note?: string, status?: 'none'|'investigating'|'claimed'|'compensated'|'closed' }
 */
app.put('/api/4px/shipments/:receipt_id/claim', (req, res) => {
	try {
		const patch = {}
		if (Object.prototype.hasOwnProperty.call(req.body || {}, 'note')) {
			if (req.body.note != null && typeof req.body.note !== 'string') {
				return res.status(400).json({ error: 'Claim note must be text' })
			}
			if (typeof req.body.note === 'string' && req.body.note.length > MAX_SHIPPING_CLAIM_NOTE_LENGTH) {
				return res.status(400).json({ error: `Claim note must be ${MAX_SHIPPING_CLAIM_NOTE_LENGTH} characters or fewer` })
			}
			patch.note = req.body.note
		}
		if (Object.prototype.hasOwnProperty.call(req.body || {}, 'status')) {
			if (req.body.status != null && typeof req.body.status !== 'string') {
				return res.status(400).json({ error: 'Claim status must be text', allowed_statuses: SHIPPING_CLAIM_STATUSES })
			}
			patch.status = req.body.status
		}
		if (!Object.keys(patch).length) {
			return res.status(400).json({ error: 'Provide note and/or status', allowed_statuses: SHIPPING_CLAIM_STATUSES })
		}
		const result = updateShippingClaim(db, req.params.receipt_id, patch)
		if (!result.ok) {
			const code = result.error === 'Order not found' ? 404 : 400
			return res.status(code).json({ error: result.error, allowed_statuses: SHIPPING_CLAIM_STATUSES })
		}
		res.json({ success: true, ...result })
	} catch (err) {
		console.error('[4px] PUT /api/4px/shipments/:id/claim:', err.message)
		res.status(500).json({ error: err.message })
	}
})

/**
 * GET /api/4px/shipments/:receipt_id/buyer-notice — draft + send attestation for
 * a stuck/disposed parcel. Etsy has no messaging API; the operator copies the
 * draft into the Etsy conversation, then POSTs to mark it sent.
 */
app.get('/api/4px/shipments/:receipt_id/buyer-notice', (req, res) => {
	try {
		ensureDisposedTrackingFlags()
		refreshShippingAlertLedger()
		const result = getShippingBuyerNotice(db, req.params.receipt_id)
		if (!result.ok) return res.status(result.status || 400).json({ error: result.error })
		res.json(result)
	} catch (err) {
		console.error('[4px] GET /api/4px/shipments/:id/buyer-notice:', err.message)
		res.status(500).json({ error: err.message })
	}
})

/**
 * POST /api/4px/shipments/:receipt_id/buyer-notice — attest (or undo) that the
 * operator messaged the buyer on Etsy about this stuck/disposed parcel.
 * Body: { sent?: boolean, message?: string }
 *   sent=true  (default) records the send with the draft or provided message
 *   sent=false undoes the latest attestation for this incident
 */
app.post('/api/4px/shipments/:receipt_id/buyer-notice', (req, res) => {
	try {
		const body = req.body || {}
		const sent = body.sent !== false
		let result
		if (sent) {
			if (body.message != null && typeof body.message !== 'string') {
				return res.status(400).json({ error: 'message must be text' })
			}
			if (typeof body.message === 'string' && body.message.length > MAX_SHIPPING_NOTICE_BODY_LENGTH) {
				return res.status(400).json({ error: `Message must be ${MAX_SHIPPING_NOTICE_BODY_LENGTH} characters or fewer` })
			}
			result = recordShippingBuyerNotice(db, req.params.receipt_id, {
				message: body.message,
				notifiedBy: req.auth?.user || null,
			})
		} else {
			result = clearShippingBuyerNotice(db, req.params.receipt_id)
		}
		if (!result.ok) {
			return res.status(result.status || 400).json({ error: result.error, compliance: result.compliance })
		}
		res.json({ success: true, ...result })
	} catch (err) {
		console.error('[4px] POST /api/4px/shipments/:id/buyer-notice:', err.message)
		res.status(500).json({ error: err.message })
	}
})

/**
 * GET /api/4px/shipments/export.csv — download the filtered parcel list as CSV.
 *
 * Honours the SAME filters as GET /api/4px/shipments (status, shop_id, q, from,
 * to, claim_status) so "what you see is what you download". The Shipping tab's
 * "Download stuck" / "Download disposed" buttons call this with the matching
 * status, producing a ready-to-escalate sheet for 4PX batch queries / claims.
 * Not paginated: every matching parcel is exported in one file.
 *
 * The first column is the bare tracking number so the file doubles as a paste-list
 * for the 4PX portal's batch-query box; the remaining columns give an ops-desk the
 * context needed to file a complaint (buyer, destination, why it's stuck, how long,
 * and the operator's claim note/status).
 */
app.get('/api/4px/shipments/export.csv', (req, res) => {
	try {
		// Export is a first-class read path: it must receive the same one-time
		// cached disposal/delivery repairs as the interactive board.
		ensureDisposedTrackingFlags()
		// Once, before the first page: paging re-reads the same ordered query, so
		// mutating the ledger between pages could shift a row across a page
		// boundary and duplicate or drop it.
		refreshShippingAlertLedger()
		// Default to the stuck bucket (the feature's primary use) but respect an
		// explicit status so the same endpoint can export any filtered view.
		const query = _shippingQueryFilters(req)
		if (req.query.status == null) query.status = 'stuck'
		query.stuckDays = _stuckDays()
		const status = query.status || 'all'
		// getShipments intentionally caps interactive pages at 1,000. Export all
		// matching rows by paging that same query instead of silently truncating.
		const MAX_EXPORT_ROWS = 50_000
		const pageSize = 1000
		const firstPage = getShipments(db, { ...query, limit: pageSize, offset: 0 })
		if (firstPage.total > MAX_EXPORT_ROWS) {
			return res.status(413).json({
				error: `Export matches ${firstPage.total.toLocaleString()} parcels; narrow the filters below ${MAX_EXPORT_ROWS.toLocaleString()} rows.`,
			})
		}
		const rows = [...firstPage.rows]
		let offset = firstPage.rows.length
		while (offset < firstPage.total) {
			const page = getShipments(db, { ...query, limit: pageSize, offset })
			rows.push(...page.rows)
			offset += page.rows.length
			if (page.rows.length < pageSize) break
		}

		const nowSec = Math.floor(Date.now() / 1000)
		const iso = (ts) => (ts ? new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '')
		const daysSince = (ts) => (ts ? Math.floor((nowSec - ts) / 86400) : '')
		// r.is_label_only carves the "never accepted by carrier" critical rows out
		// of Stuck (see LABEL_ONLY_SQL) — mirror that split here so an exported
		// sheet's Health column agrees with the board instead of re-merging them.
		const healthLabel = (r) => (r.is_label_only ? 'label_only' : r.tracking_health === 'critical' ? 'stuck' : r.tracking_health === 'warning' ? 'delayed' : r.tracking_health || 'ok')
		// Neutralize spreadsheet formulas in operator/buyer-controlled text before
		// quoting. Excel still evaluates =,+,-,@ inside ordinary CSV quoted cells.
		const esc = (v) => {
			const raw = String(v ?? '')
			const safe = /^\s*[=+\-@]/.test(raw) ? `'${raw}` : raw
			return `"${safe.replace(/"/g, '""')}"`
		}

		const columns = [
			['Tracking Number', (r) => r.tracking_no],
			['Consignment No', (r) => r.fourpx_consignment_no],
			['Shop', (r) => r.shop_name],
			['Buyer', (r) => r.buyer_name],
			['Destination', (r) => r.shipping_country_iso],
			['Status', (r) => r.tracking_status],
			['Disposed', (r) => (r.is_disposed ? 'yes' : '')],
			['Health', (r) => healthLabel(r)],
			// Morning-review state, so an exported sheet distinguishes work nobody
			// has looked at yet from a backlog already being chased.
			['New (Unreviewed)', (r) => (r.is_new_alert ? 'yes' : '')],
			['Flagged (UTC)', (r) => iso(r.alert_flagged_at)],
			['Days Flagged', (r) => daysSince(r.alert_flagged_at)],
			['Reviewed (UTC)', (r) => iso(r.alert_reviewed_at)],
			['Reason', (r) => r.tracking_health_reason],
			['Last Event', (r) => r.tracking_last_event],
			['Last Location', (r) => r.tracking_last_location],
			['Last Update (UTC)', (r) => iso(r.tracking_last_event_at)],
			['Last Checked (UTC)', (r) => iso(r.tracking_checked_at)],
			['Days Since Update', (r) => daysSince(r.tracking_last_event_at)],
			['Ship Date (UTC)', (r) => iso(r.shipment_notified_at || r.etsy_created_at)],
			['Days In Transit', (r) => daysSince(r.carrier_confirmed_at || r.shipment_notified_at || r.etsy_created_at)],
			['Shipping Cost', (r) => (r.fourpx_freight_amount != null ? `${r.fourpx_freight_amount} ${r.fourpx_freight_currency || ''}`.trim() : '')],
			['Claim Status', (r) => r.shipping_claim_status || ''],
			['Claim Note', (r) => r.shipping_claim_note || ''],
			['Buyer Messaged', (r) => (r.outreach_status === 'sent' ? 'yes' : r.outreach_needed ? 'needed' : r.outreach_status || '')],
			['Buyer Messaged (UTC)', (r) => iso(r.shipping_buyer_notified_at)],
			['Buyer Message Kind', (r) => r.shipping_buyer_notice_kind || ''],
		]

		const header = columns.map((c) => esc(c[0])).join(',')
		const body = rows.map((r) => columns.map((c) => esc(c[1](r))).join(',')).join('\r\n')
		const csv = `\uFEFF${header}\r\n${body}` // BOM so Excel auto-detects UTF-8

		const stamp = new Date().toISOString().slice(0, 10)
		const fname = `4PX-${status}-tracking-${stamp}.csv`
		res.setHeader('Content-Type', 'text/csv; charset=utf-8')
		res.setHeader('Content-Disposition', contentDisposition(fname))
		res.setHeader('X-Export-Row-Count', String(rows.length))
		res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Export-Row-Count')
		res.send(csv)
	} catch (err) {
		console.error('[4px] GET /api/4px/shipments/export.csv:', err.message)
		res.status(err.status || 500).json({ error: err.message })
	}
})

/**
 * GET /api/4px/balance — the recorded 4PX prepaid balance + checkbook-style estimate
 * of the remaining balance (snapshot − shipping billed since). 4PX has no balance API.
 * POST /api/4px/balance — record a new balance snapshot. Body: { amount, currency?, as_of?, note? }
 */
app.get('/api/4px/balance', (req, res) => {
	try {
		res.json(getFourpxBalanceStatus(db))
	} catch (err) {
		console.error('[4px] GET /api/4px/balance:', err.message)
		res.status(500).json({ error: err.message })
	}
})

app.post('/api/4px/balance', (req, res) => {
	try {
		const amount = Number(req.body?.amount)
		if (!Number.isFinite(amount)) return res.status(400).json({ error: 'A numeric "amount" is required' })
		// as_of accepts a unix epoch or a YYYY-MM-DD date; default now.
		let asOf
		if (req.body?.as_of != null) {
			asOf = typeof req.body.as_of === 'number' ? req.body.as_of : Math.floor(new Date(req.body.as_of).getTime() / 1000)
			if (!Number.isFinite(asOf)) asOf = undefined
		}
		setFourpxBalance(db, { amount, currency: req.body?.currency || 'CNY', asOf, note: req.body?.note || null })
		res.json({ success: true, ...getFourpxBalanceStatus(db) })
	} catch (err) {
		console.error('[4px] POST /api/4px/balance:', err.message)
		res.status(500).json({ error: err.message })
	}
})

/**
 * POST /api/4px/track/refresh/:receipt_id — force a live tracking re-check for one
 * parcel, persist the snapshot, and return the fresh events + health. Used by the
 * "refresh" action in the Shipping tab.
 */
app.post('/api/4px/track/refresh/:receipt_id', async (req, res) => {
	const receiptId = String(req.params.receipt_id)
	try {
		const row = db
			.prepare(
				`
			SELECT
				COALESCE(
					CASE WHEN fourpx_consignment_no IS NOT NULL AND fourpx_tracking_no LIKE '4PX%' THEN fourpx_tracking_no END,
					CASE WHEN tracking_code LIKE '4PX%' THEN tracking_code END,
					fourpx_tracking_no
				) AS tracking_no,
				tracking_checked_at
			FROM receipts WHERE receipt_id = ?
		`,
			)
			.get(receiptId)
		if (!row || !row.tracking_no) return res.status(404).json({ error: 'No 4PX tracking number for this order' })

		const now = Math.floor(Date.now() / 1000)
		const cooldownSec = 30
		if (row.tracking_checked_at && now - row.tracking_checked_at < cooldownSec) {
			const retryAfter = cooldownSec - (now - row.tracking_checked_at)
			res.setHeader('Retry-After', String(retryAfter))
			return res.status(429).json({
				error: `This parcel was checked moments ago. Try again in ${retryAfter}s.`,
				retry_after: retryAfter,
			})
		}

		// Route the one-row check through the SAME scheduler lock/pacing machinery
		// as background runs. This prevents cross-process duplicates and avoids a
		// manual click bypassing a live batch already contacting 4PX.
		const launch = _startServerTrackingRefresh('parcel_manual', {
			ignoreDisabled: true,
			receiptIds: [Number(receiptId)],
			includeResults: true,
		})
		if (!launch.started) {
			return res.status(409).json({
				error: 'A carrier refresh is already running. This parcel will update automatically if it is due.',
				reason: launch.reason,
			})
		}
		const cycle = await launch.promise
		const result = cycle.results?.[0]
		if (!result) return res.status(404).json({ error: 'No refreshable 4PX parcel was found for this order.' })
		if (!result.ok) {
			return res.status(502).json({
				error: result.error || '4PX did not return tracking data. The previous status was preserved.',
				tracking_no: result.tracking_no,
				status: result.status,
				source: result.source,
			})
		}

		broadcastSyncEvent({
			type: 'tracking_parcel_updated',
			receipt_id: Number(receiptId),
			tracking_no: row.tracking_no,
			status: result.status,
			ts: Date.now(),
		})
		res.json({
			tracking_no: result.tracking_no,
			status: result.status,
			events: result.events,
			health: result.health,
			source: result.source,
		})
	} catch (err) {
		console.error('[4px] POST /api/4px/track/refresh:', err.message)
		res.status(500).json({ error: err.message })
	}
})

// ─── Exchange rates ──────────────────────────────────────────────────────────
// Converts a receipt subtotal into the customs currency a packer declares on an
// international parcel. src/compliance/exchange-rates.js owns the durability
// this needs — a last-good table on disk, a VPN fallback route, and an honest
// age on every answer — because a station that cannot reach the rate feed used
// to show every order the same notice with no value in it.
//
// The cache lives beside the database, so stations sharing a database directory
// also share the last good table: one machine with egress supplies the rest.
const rateStore = createRateStore({
	cacheDir: path.dirname(path.resolve(config.db_path)),
	vpnPort: config.vpn_local_port,
})

/**
 * Destination-currency amount to write on a customs form.
 *
 * Looks at the in-memory / on-disk table (no network on the orders path) so a
 * list of 200 receipts cannot become 200 outbound FX calls. The boot refresh
 * and 30-minute heartbeat keep that table warm.
 */
function customsDeclarationForReceipt(r, rateSnap = rateStore.snapshot()) {
	const scheme = destinationTax.resolveDestinationTax(r.shipping_country_iso, config)
	if (!scheme) return null
	const converted = convertCurrencyAmount(Number(r.subtotal_amount), r.grandtotal_currency, scheme.customs_currency, rateSnap.rates || {})
	const shaped = destinationTax.shapeCustomsDeclaration(scheme, converted)
	if (!shaped) return null
	shaped.stale = Boolean(rateSnap.stale)
	if (rateSnap.fetched_at) shaped.rates_at = rateSnap.fetched_at
	return shaped
}

/** EUR-base table for server-side conversions; {} when nothing is available. */
async function getRates() {
	return (await rateStore.get()).rates
}

/**
 * GET /api/exchange-rates
 *
 * The EUR-base table plus its provenance: when it was fetched, how it got here,
 * and whether it is old enough that the bench must stop calling it today's rate.
 * The dashboard renders customs values from this, so an empty `rates` is a real
 * answer — it means "declare nothing you cannot read off the Etsy order page".
 */
app.get('/api/exchange-rates', async (_req, res) => {
	try {
		const snap = await rateStore.get()
		res.json({ rates: snap.rates, cached_at: snap.fetched_at, age_ms: snap.age_ms, stale: snap.stale, source: snap.source, error: snap.error })
	} catch (e) {
		// Should be unreachable: the store swallows its own failures by design.
		console.error('[rates] GET /api/exchange-rates:', e.message)
		res.status(500).json({ error: e.message, rates: {} })
	}
})

// Warm-up at boot, and a heartbeat afterwards. Without the heartbeat a station
// that boots offline stays without rates until someone reloads the page at the
// exact moment the retry window is open.
async function refreshRatesWithReport(context) {
	const snap = await rateStore.get()
	const count = Object.keys(snap.rates).length
	if (!count) {
		console.warn(`[rates] no exchange rates available (${snap.error || 'unknown reason'}) — the packing bench cannot show customs values. ` + `They are cached at ${rateStore.cachePath}; a station with internet access will populate it.`)
		return
	}
	if (snap.source === 'cache' || snap.stale) {
		console.warn(`[rates] using rates from ${snap.fetched_at} (${snap.source})${snap.error ? ` — last refresh failed: ${snap.error}` : ''}`)
		return
	}
	if (context === 'boot') console.log(`[rates] Exchange rates loaded (${count} currencies, ${snap.source})`)
}
refreshRatesWithReport('boot').catch(() => {})
setInterval(() => refreshRatesWithReport('heartbeat').catch(() => {}), 30 * 60 * 1000).unref()

/**
 * GET /api/compliance/destination-tax
 *
 * The marketplace import-tax registry: which destinations have VAT/GST collected
 * by Etsy, the identifier that clears each one, whether that identifier may be
 * written on the parcel, and the value ceiling above which the tax is collected
 * at the border instead.
 *
 * The packing bench renders its customs notice entirely from this payload — no
 * tax number is hard-coded in the browser — so an identifier change is a config
 * edit, and the number the packer writes on the box is the same one the shipment
 * transmits. Pairs with /api/exchange-rates, which supplies the conversion the
 * declared value and the ceiling comparison need.
 */
app.get('/api/compliance/destination-tax', (_req, res) => {
	const { reviewed_at, schemes, countries } = destinationTax.buildDestinationTaxRegistry(config)
	// `problems` stays server-side: it names config mistakes, which are for the
	// operator's log rather than a packer's screen. They are already warned about
	// at load, and again at boot below.
	res.setHeader('Cache-Control', 'private, max-age=300')
	res.json({ reviewed_at, schemes, countries })
})

// Boot-time visibility: a destination whose identifier failed validation would
// otherwise only show up as a notice quietly missing from the bench.
{
	const registry = destinationTax.buildDestinationTaxRegistry(config)
	for (const problem of registry.problems) console.warn(`[tax] ${problem}`)
	const missing = Object.values(registry.schemes)
		.filter((s) => !s.identifier)
		.map((s) => s.key)
	if (missing.length) console.warn(`[tax] no identifier resolved for ${missing.join(', ')} — those destinations get no customs notice.`)
}

// ─── Listings ─────────────────────────────────────────────────────────────────

/** Helper: resolve shop config + build authenticated client */
async function getShopClientForShopName(shopName) {
	let shopCfg, groupCfg
	for (const grp of config.groups) {
		const s = grp.shops.find((sh) => sh.shop_name === shopName)
		if (s) {
			shopCfg = s
			groupCfg = grp
			break
		}
	}
	if (!shopCfg) throw Object.assign(new Error(`No config for shop ${shopName}`), { status: 404 })
	const proxyClient = createGroupProxyClient(groupCfg, config.vpn_local_port)
	const accessToken = await tokenManager.getAccessToken(shopCfg.shop_id, shopCfg.api_key, shopCfg.refresh_token ?? null, proxyClient)
	// Fresh-token provider so the client auto-refreshes mid-run (long bulk jobs can
	// outlive a 1h access token). forceRefresh=true is used by the 401 retry path.
	const getToken = async (forceRefresh) => {
		if (forceRefresh) tokenManager.invalidate(shopCfg.shop_id)
		return tokenManager.getAccessToken(shopCfg.shop_id, shopCfg.api_key, shopCfg.refresh_token ?? null, proxyClient)
	}
	const shopClient = buildShopClient(proxyClient, shopCfg.api_key, shopCfg.shared_secret, accessToken, getToken, {
		// Fail closed: a proxied group must never egress on the server's own IP.
		requireProxy: usesGroupProxy(groupCfg),
	})
	const numericShopId = await resolveShopId(shopClient, shopCfg.shop_id)
	// Recorded OAuth scopes (null for legacy tokens) — lets callers pre-flight
	// permission errors like a missing listings_w scope.
	const scopes = tokenManager.getScopes(shopCfg.shop_id)
	return { shopClient, numericShopId, shopCfg, groupCfg, scopes }
}

/**
 * GET /api/listings
 * Returns cached listings. Query params: shop_id, state, limit, offset, q (search)
 */
app.get('/api/listings', (req, res) => {
	const limit = Math.min(parseInt(req.query.limit ?? 500, 10), 1000)
	const offset = parseInt(req.query.offset ?? 0, 10)
	const conditions = []
	const params = {}

	if (req.query.shop_id) {
		conditions.push('l.shop_id = @shop_id')
		params.shop_id = req.query.shop_id
	}
	if (req.query.state && req.query.state !== 'all') {
		conditions.push('l.state = @state')
		params.state = req.query.state
	}
	if (req.query.q) {
		conditions.push('l.title LIKE @q')
		params.q = `%${req.query.q}%`
	}

	const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''

	const total = db.prepare(`SELECT COUNT(*) as n FROM listings l ${where}`).get(params).n

	// Sort: listings with any zero-stock enabled offering come first, then by updated desc.
	// A LEFT JOIN subquery computes the minimum quantity across all enabled offerings per listing.
	const rows = db
		.prepare(
			`
    SELECT l.*, s.shop_name,
           COALESCE(inv.min_qty, 999) AS _min_qty
    FROM listings l
    JOIN shops s ON s.shop_id = l.shop_id
    LEFT JOIN (
      SELECT listing_id, MIN(quantity) AS min_qty
      FROM listing_inventory
      WHERE is_enabled = 1
      GROUP BY listing_id
    ) inv ON inv.listing_id = l.listing_id
    ${where}
    ORDER BY _min_qty ASC, l.updated_timestamp DESC
    LIMIT @limit OFFSET @offset
  `,
		)
		.all({ ...params, limit, offset })

	// Embed pre-aggregated inventory into each listing in a single extra query.
	// This eliminates the separate /api/inventory/bulk round-trip from the frontend.
	// One row per (listing_id, style_value) — min_qty already computed server-side.
	let invByListing = {}
	if (rows.length > 0) {
		const ids = rows.map((r) => r.listing_id)
		const ph = ids.map(() => '?').join(',')
		const invRows = db
			.prepare(
				`
      SELECT listing_id, style_value,
             MIN(quantity)                                          AS min_qty,
             MAX(CASE WHEN quantity = 0 THEN 1 ELSE 0 END)         AS has_zero,
             MIN(CASE WHEN price_amount > 0 THEN price_amount END) AS price,
             MAX(price_currency)                                   AS price_currency
      FROM listing_inventory
      WHERE listing_id IN (${ph}) AND is_enabled = 1
      GROUP BY listing_id, style_value
    `,
			)
			.all(...ids)
		for (const r of invRows) {
			if (!invByListing[r.listing_id]) invByListing[r.listing_id] = []
			invByListing[r.listing_id].push({
				style_value: r.style_value,
				quantity: r.min_qty,
				has_zero: r.has_zero === 1,
				price: r.price != null ? r.price : null,
				currency: r.price_currency || null,
			})
		}
	}

	res.json({
		total,
		listings: rows.map((r) => ({
			...r,
			tags: r.tags ? JSON.parse(r.tags) : [],
			inv_slots: invByListing[r.listing_id] ?? null,
		})),
	})
})

/**
 * GET /api/listings/sync/:shop_name
 * Fetches listings for a shop from Etsy and mirrors them into the local cache.
 *
 * Etsy's endpoint only accepts a single concrete state, so "all" is expanded to
 * every state. After each state is fully paginated we reconcile the cache with
 * pruneStaleListings(): listings Etsy no longer returns (deleted on Etsy, or
 * moved to another state) are dropped so the Listings tab shows exactly what the
 * shop currently lists — not a growing pile of stale rows that hide the new ones.
 *
 * We request the `Inventory` association (includeInventory), so each listing
 * arrives with its full per-variation offerings inline. That lets us cache the
 * per-style price + stock in the SAME pass — the Price/inventory strip is
 * populated the moment a sync finishes, with no separate per-listing inventory
 * fetch (one page call per 100 listings instead of one call per listing).
 */
const ETSY_LISTING_STATES = ['active', 'inactive', 'draft', 'sold_out', 'expired']

/**
 * Cache a listing's embedded inventory (from includes=Inventory) into
 * listing_inventory, then prune variation rows Etsy no longer returns.
 * Returns the number of offering rows written (0 when the listing has none).
 */
function cacheListingInventory(listingId, inventory) {
	const products = inventory?.products
	if (!Array.isArray(products) || products.length === 0) return 0

	const seenProductIds = new Set()
	let written = 0
	for (const product of products) {
		if (product?.product_id != null) seenProductIds.add(product.product_id)
		// A product always has ≥1 offering; guard anyway so a malformed payload
		// can never throw and abort the whole sync.
		for (const offering of product.offerings || []) {
			upsertListingInventory(db, listingId, product, offering)
			written++
		}
	}
	pruneStaleInventory(db, listingId, seenProductIds)
	return written
}

app.get('/api/listings/sync/:shop_name', async (req, res) => {
	try {
		const { shopClient, numericShopId, shopCfg } = await getShopClientForShopName(req.params.shop_name)
		const requested = req.query.state || 'active'
		const states = requested === 'all' ? ETSY_LISTING_STATES : [requested]

		let synced = 0
		let removed = 0
		let variations = 0
		const stateCounts = {}
		for (const state of states) {
			// Track which listing_ids Etsy returned for this state so we can prune
			// the locally-cached rows it no longer lists once the full walk succeeds.
			const seenIds = new Set()
			for await (const batch of paginateListings(shopClient, numericShopId, { state, includeInventory: true })) {
				for (const listing of batch) {
					// Listing sync is an operational cache refresh. Retain Etsy's
					// view/favorite metrics only when the separate written-approval
					// and catalog-analytics gates are both enabled.
					upsertListing(db, shopCfg.shop_id, listing, {
						analyticsMetrics: growthApiAnalyticsEnabled(),
					})
					variations += cacheListingInventory(listing.listing_id, listing.inventory)
					seenIds.add(listing.listing_id)
					synced++
				}
			}
			// Guarded inside pruneStaleListings: an empty result never wipes the cache.
			removed += pruneStaleListings(db, shopCfg.shop_id, state, seenIds)
			stateCounts[`listing_${state}_count`] = seenIds.size
		}
		upsertShopHealthSnapshot(db, shopCfg.shop_id, stateCounts)

		console.log(`[listings] Synced ${synced} listing(s) [${states.join(', ')}] for ${req.params.shop_name}; cached ${variations} variation(s); pruned ${removed} stale`)
		res.json({ success: true, synced, variations, removed, shop: req.params.shop_name, state: requested })
	} catch (err) {
		console.error('[listings] Sync error:', err.response?.data || err.message)
		res.status(err.status || err.response?.status || 500).json({ error: err.response?.data?.error || err.message })
	}
})

/**
 * PATCH /api/listings/:listing_id
 * Updates listing fields. Requires listings_w scope.
 */
app.patch('/api/listings/:listing_id', async (req, res) => {
	try {
		const { fields, shop_name } = req.body
		if (!shop_name) return res.status(400).json({ error: 'shop_name required' })
		const { shopClient, numericShopId, shopCfg } = await getShopClientForShopName(shop_name)
		const result = await updateListing(shopClient, numericShopId, req.params.listing_id, fields)
		// Update local cache
		upsertListing(db, shopCfg.shop_id, result)
		res.json({ success: true, listing: result })
	} catch (err) {
		console.error('[listings] Update error:', err.response?.data || err.message)
		res.status(err.status || err.response?.status || 500).json({ error: err.response?.data?.error_description || err.response?.data?.error || err.message })
	}
})

/**
 * POST /api/listings
 * Creates a draft listing. Requires listings_w scope.
 */
app.post('/api/listings', async (req, res) => {
	try {
		const { shop_name, ...body } = req.body
		if (!shop_name) return res.status(400).json({ error: 'shop_name required' })
		const { shopClient, numericShopId, shopCfg } = await getShopClientForShopName(shop_name)
		const result = await createDraftListing(shopClient, numericShopId, body)
		upsertListing(db, shopCfg.shop_id, result)
		res.status(201).json({ success: true, listing: result })
	} catch (err) {
		console.error('[listings] Create error:', err.response?.data || err.message)
		res.status(err.status || err.response?.status || 500).json({ error: err.response?.data?.error_description || err.response?.data?.error || err.message })
	}
})

/**
 * DELETE /api/listings/:listing_id
 * Deletes a listing. Requires listings_d scope.
 */
app.delete('/api/listings/:listing_id', async (req, res) => {
	try {
		const { shop_name } = req.body
		if (!shop_name) return res.status(400).json({ error: 'shop_name required' })
		const { shopClient } = await getShopClientForShopName(shop_name)
		await deleteListing(shopClient, req.params.listing_id)
		db.prepare('DELETE FROM listings WHERE listing_id = ?').run(req.params.listing_id)
		res.json({ success: true })
	} catch (err) {
		console.error('[listings] Delete error:', err.response?.data || err.message)
		res.status(err.status || err.response?.status || 500).json({ error: err.response?.data?.error || err.message })
	}
})

// ─── Shop Sections (CRUD) ─────────────────────────────────────────────────────
// Sections are the storefront categories shoppers browse (e.g. "iPhone Cases",
// "AirPod Cases"). Etsy exposes full CRUD under /shops/{shop_id}/sections.
// Reads need no scope; create/update/delete require the shops_w OAuth scope.
// All writes go live to Etsy through the per-group proxy chain — there is no
// local mirror table for sections, so the UI always reflects Etsy's truth.

/** Normalize an Etsy error into a clean { status, message } pair for the UI. */
function etsyErr(err) {
	const status = err.status || err.response?.status || 500
	const message = err.response?.data?.error_description || err.response?.data?.error || err.message
	return { status, message }
}

/** True when the shop's recorded OAuth scopes are known and lack `shops_w`. */
function lacksShopWrite(scopes) {
	return Array.isArray(scopes) && !scopes.includes('shops_w')
}

const SHOP_W_HINT = 'shops_w scope required. Re-run "npm run oauth:setup" for this shop to grant section-management permission.'

/**
 * GET /api/shops/:shop_name/sections
 * Live list of the shop's sections straight from Etsy (title, rank, listing count).
 */
app.get('/api/shops/:shop_name/sections', async (req, res) => {
	try {
		const { shopClient, numericShopId } = await getShopClientForShopName(req.params.shop_name)
		const data = await getShopSections(shopClient, numericShopId)
		res.json({ success: true, count: data.count ?? (data.results || []).length, sections: data.results || [] })
	} catch (err) {
		const { status, message } = etsyErr(err)
		console.error('[sections] List error:', message)
		res.status(status).json({ error: message })
	}
})

/**
 * POST /api/shops/:shop_name/sections   body: { title }
 * Creates a new section. Requires shops_w scope.
 */
app.post('/api/shops/:shop_name/sections', async (req, res) => {
	try {
		const title = (req.body?.title || '').trim()
		if (!title) return res.status(400).json({ error: 'title is required' })
		if (title.length > 24) return res.status(400).json({ error: 'Section title must be 24 characters or fewer.' })
		const { shopClient, numericShopId, scopes } = await getShopClientForShopName(req.params.shop_name)
		if (lacksShopWrite(scopes)) return res.status(403).json({ error: SHOP_W_HINT })
		const section = await createShopSection(shopClient, numericShopId, { title })
		logEvent(db, { event_type: 'SECTION_CREATED', shop_name: req.params.shop_name, detail: `Created section "${title}"` })
		res.status(201).json({ success: true, section })
	} catch (err) {
		const { status, message } = etsyErr(err)
		console.error('[sections] Create error:', message)
		res.status(status).json({ error: status === 403 ? `${message} — ${SHOP_W_HINT}` : message })
	}
})

/**
 * PUT /api/shops/:shop_name/sections/:section_id   body: { title }
 * Renames a section. Requires shops_w scope.
 */
app.put('/api/shops/:shop_name/sections/:section_id', async (req, res) => {
	try {
		const title = (req.body?.title || '').trim()
		if (!title) return res.status(400).json({ error: 'title is required' })
		if (title.length > 24) return res.status(400).json({ error: 'Section title must be 24 characters or fewer.' })
		const { shopClient, numericShopId, scopes } = await getShopClientForShopName(req.params.shop_name)
		if (lacksShopWrite(scopes)) return res.status(403).json({ error: SHOP_W_HINT })
		const section = await updateShopSection(shopClient, numericShopId, req.params.section_id, { title })
		logEvent(db, { event_type: 'SECTION_UPDATED', shop_name: req.params.shop_name, detail: `Renamed section #${req.params.section_id} to "${title}"` })
		res.json({ success: true, section })
	} catch (err) {
		const { status, message } = etsyErr(err)
		console.error('[sections] Update error:', message)
		res.status(status).json({ error: status === 403 ? `${message} — ${SHOP_W_HINT}` : message })
	}
})

/**
 * DELETE /api/shops/:shop_name/sections/:section_id
 * Deletes a section (listings inside become unsectioned). Requires shops_w scope.
 */
app.delete('/api/shops/:shop_name/sections/:section_id', async (req, res) => {
	try {
		const { shopClient, numericShopId, scopes } = await getShopClientForShopName(req.params.shop_name)
		if (lacksShopWrite(scopes)) return res.status(403).json({ error: SHOP_W_HINT })
		await deleteShopSection(shopClient, numericShopId, req.params.section_id)
		logEvent(db, { event_type: 'SECTION_DELETED', shop_name: req.params.shop_name, detail: `Deleted section #${req.params.section_id}` })
		res.json({ success: true })
	} catch (err) {
		const { status, message } = etsyErr(err)
		console.error('[sections] Delete error:', message)
		res.status(status).json({ error: status === 403 ? `${message} — ${SHOP_W_HINT}` : message })
	}
})

// ─── Bulk per-style repricing ─────────────────────────────────────────────────
// Apply a per-style price map to every (or a subset of) live listing in a shop.
// Used by the Listings tab "Bulk price" tool. Heavy work is streamed over SSE.

const shopRepricer = new ShopRepricer({ db, resolveShopClient: getShopClientForShopName })

/**
 * GET /api/listings/style-prices?shop_id=<config_shop_id>
 * Returns the shop's CURRENT per-style prices (median across cached offerings),
 * so the bulk-price editor can pre-fill sensible defaults. Falls back to the
 * 4-currency master sheet for any style the shop doesn't currently sell.
 */
app.get('/api/listings/style-prices', (req, res) => {
	try {
		const shopId = req.query.shop_id
		if (!shopId) return res.status(400).json({ error: 'shop_id required' })
		const productType = getProductType(req.query.product_type).id
		const styleKeys = styleKeysFor(productType)

		const shop = getShopCurrentStylePrices(db, shopId, productType)

		// Fill gaps from the product line's price book, or the master sheet.
		let sheetPrices = {}
		if (shop.currency) {
			try {
				sheetPrices = getPricesForCurrency(shop.currency, { productType }).prices || {}
			} catch {
				sheetPrices = {}
			}
		}
		const merged = {}
		const source = {}
		for (const key of styleKeys) {
			if (Number.isFinite(shop.prices[key])) {
				merged[key] = shop.prices[key]
				source[key] = 'shop'
			} else if (Number.isFinite(sheetPrices[key])) {
				merged[key] = sheetPrices[key]
				source[key] = 'sheet'
			}
		}

		res.json({
			style_keys: styleKeys,
			prices: merged,
			source,
			counts: shop.counts,
			currency: shop.currency,
			listing_count: shop.listingCount,
			has_data: shop.hasData,
		})
	} catch (err) {
		res.status(err.status || 500).json({ error: err.message })
	}
})

/**
 * POST /api/listings/reprice
 * Body: { shop_name, prices: { styleKey: amount }, state?, listing_ids?, product_type? }
 * Kicks off a background bulk reprice and returns a job_id to stream.
 */
app.post('/api/listings/reprice', (req, res) => {
	try {
		const { shop_name, prices, state, listing_ids, product_type } = req.body || {}
		if (!shop_name) return res.status(400).json({ error: 'shop_name required' })
		const result = shopRepricer.start(shop_name, { prices, state, listingIds: listing_ids, productType: getProductType(product_type).id })
		res.json({ success: true, ...result })
	} catch (err) {
		res.status(err.status || 500).json({ error: err.message })
	}
})

/** GET /api/listings/reprice/stream/:job_id — SSE live progress. */
app.get('/api/listings/reprice/stream/:job_id', (req, res) => {
	res.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		Connection: 'keep-alive',
	})
	res.write('\n')
	const job = shopRepricer.getJob(req.params.job_id)
	if (job) res.write(`data: ${JSON.stringify({ type: 'snapshot', job })}\n\n`)
	shopRepricer.subscribe(req.params.job_id, res)
})

/**
 * POST /api/listings/:listing_id/variation-prices
 * Body: { shop_name, prices: { styleKey: amount }, product_type? }
 * Synchronously sets per-style prices for ONE listing (used by the Edit modal).
 * Requires listings_w scope.
 */
app.post('/api/listings/:listing_id/variation-prices', async (req, res) => {
	try {
		const { shop_name, prices, product_type } = req.body || {}
		if (!shop_name) return res.status(400).json({ error: 'shop_name required' })
		const result = await shopRepricer.repriceListingSync(shop_name, parseInt(req.params.listing_id, 10), prices, getProductType(product_type).id)
		res.json({ success: true, ...result })
	} catch (err) {
		console.error('[listings] Variation reprice error:', err.response?.data || err.message)
		res.status(err.status || err.response?.status || 500).json({
			error: err.response?.data?.error || err.message,
			needs_reauth: err.needs_reauth || false,
		})
	}
})

// ─── Bulk Listing Creator ───────────────────────────────────────────────────
// Ingests a folder-of-folders of product media, generates AI copy, prices each
// variation from the 4-currency master sheet, auto-resolves shop settings, and
// creates draft listings via the Etsy API. See src/listings/*.

const bulkManager = new BulkJobManager({ db, resolveShopClient: getShopClientForShopName })

/**
 * GET /api/bulk/browse?path=<absolute-dir>
 * Returns the sub-directories (and a summary of files) at the given path so
 * the frontend can show a native-feeling folder-picker modal without ever
 * exposing or typing the raw filesystem path. The server already has full
 * filesystem access — this is purely a read-only listing.
 *
 * Defaults to the user's home directory when no path is supplied.
 */
app.get('/api/bulk/browse', (req, res) => {
	const rawPath = req.query.path ? String(req.query.path) : os.homedir()
	const dirPath = path.resolve(rawPath)
	try {
		if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
			return res.status(400).json({ error: `Not a directory: ${dirPath}` })
		}
		const entries = fs.readdirSync(dirPath, { withFileTypes: true })
		const dirs = entries
			.filter((e) => {
				if (!e.isDirectory()) return false
				// Skip obviously system/hidden folders on Windows & Mac/Linux
				const n = e.name
				if (n.startsWith('.')) return false
				if (['$RECYCLE.BIN', 'System Volume Information', 'node_modules', '__pycache__'].includes(n)) return false
				return true
			})
			.map((e) => ({ name: e.name, path: path.join(dirPath, e.name) }))
			.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))

		const files = entries.filter((e) => e.isFile()).map((e) => ({ name: e.name, ext: path.extname(e.name).toLowerCase() }))

		const parent = path.dirname(dirPath) !== dirPath ? path.dirname(dirPath) : null
		res.json({ path: dirPath, parent, dirs, file_count: files.length })
	} catch (err) {
		res.status(500).json({ error: err.message })
	}
})

/**
 * POST /api/bulk/scan  { input_path }
 * Returns the products detected in the input root (folder = one product).
 */
app.post('/api/bulk/scan', (req, res) => {
	try {
		const { input_path } = req.body
		if (!input_path) return res.status(400).json({ error: 'input_path required' })
		const { inputRoot, products, skipped } = scanInputRoot(input_path)
		res.json({
			input_root: inputRoot,
			count: products.length,
			products: products.map((p) => ({
				folder: p.folder,
				name: p.name,
				image_count: p.imageCount,
				has_video: p.hasVideo,
				warnings: p.warnings,
			})),
			skipped: skipped.map((s) => ({ folder: s.folder, name: s.name, warnings: s.warnings })),
		})
	} catch (err) {
		res.status(err.status || 500).json({ error: err.message })
	}
})

/**
 * GET /api/bulk/shop-settings/:shop_name?force=1
 * Live-fetches (and caches) the shop's shipping/return/partner/section/taxonomy
 * plus currency, with auto-selected defaults for the override UI.
 */
app.get('/api/bulk/shop-settings/:shop_name', async (req, res) => {
	try {
		const { shopClient, numericShopId, shopCfg } = await getShopClientForShopName(req.params.shop_name)
		const productType = getProductType(req.query.product_type).id
		const settings = await getShopListingSettings({
			db,
			shopClient,
			shopId: numericShopId,
			shopKey: req.params.shop_name,
			productType,
			force: req.query.force === '1',
		})
		// Default variation prices = the shop's CURRENT prices (from cached live
		// listings), with the product line's own price book — or the master sheet —
		// filling any value the shop doesn't already sell.
		let sheetPrices = {}
		try {
			sheetPrices = getPricesForCurrency(settings.currency_code, { column: 'anchor', productType }).prices
		} catch {
			sheetPrices = {}
		}
		const { prices, source, shop } = resolveDefaultPrices({ db, shopId: shopCfg.shop_id, sheetPrices, productType })
		res.json({
			shop_key: shopCfg.shop_id,
			...settings,
			product_types: listProductTypes(),
			default_prices: prices,
			prices_source: source,
			shop_current_prices: shop.prices,
			shop_price_listings: shop.listingCount,
			sheet_prices: sheetPrices,
		})
	} catch (err) {
		console.error('[bulk] shop-settings error:', err.response?.data || err.message)
		res.status(err.status || err.response?.status || 500).json({ error: err.response?.data?.error || err.message })
	}
})

/**
 * POST /api/bulk/run
 * { shop_name, input_path, state, overrides, dry_run, brand_tags }
 * Creates a job and starts processing in the background.
 */
app.post('/api/bulk/run', (req, res) => {
	try {
		const { shop_name, input_path, state, overrides, dry_run, brand_tags, style_prices, product_type } = req.body
		if (!shop_name) return res.status(400).json({ error: 'shop_name required' })
		if (!input_path) return res.status(400).json({ error: 'input_path required' })
		const job = bulkManager.createAndStart({
			shopName: shop_name,
			inputPath: input_path,
			targetState: state === 'published' ? 'published' : 'draft',
			dryRun: Boolean(dry_run),
			overrides: overrides || {},
			brandTags: Array.isArray(brand_tags) ? brand_tags : undefined,
			stylePrices: style_prices && typeof style_prices === 'object' ? style_prices : undefined,
			productType: getProductType(product_type).id,
		})
		res.status(201).json({ success: true, job })
	} catch (err) {
		res.status(err.status || 500).json({ error: err.message })
	}
})

/**
 * GET /api/bulk/jobs?shop=<shop_name>&limit=50 — saved runs (newest first), with
 * per-job item rollups so the History panel can summarise each run and the user
 * can reopen/recover it after leaving the session.
 */
app.get('/api/bulk/jobs', (req, res) => {
	const limit = Math.min(parseInt(req.query.limit ?? 50, 10) || 50, 200)
	const params = { limit }
	let where = ''
	if (req.query.shop) {
		where = 'WHERE j.shop_name = @shop'
		params.shop = String(req.query.shop)
	}
	const jobs = db
		.prepare(
			`
    SELECT j.*,
      (SELECT COUNT(*) FROM bulk_job_items i WHERE i.job_id = j.job_id) AS item_count,
      (SELECT COUNT(*) FROM bulk_job_items i WHERE i.job_id = j.job_id AND i.status = 'done') AS done_count,
      (SELECT COUNT(*) FROM bulk_job_items i WHERE i.job_id = j.job_id AND i.status = 'failed') AS failed_count,
      (SELECT COUNT(*) FROM bulk_job_items i WHERE i.job_id = j.job_id AND i.listing_id IS NOT NULL) AS created_count,
      (SELECT COUNT(*) FROM bulk_job_items i WHERE i.job_id = j.job_id AND i.published_at IS NOT NULL) AS published_count
    FROM bulk_jobs j
    ${where}
    ORDER BY j.created_at DESC
    LIMIT @limit
  `,
		)
		.all(params)
	// Annotate with whether the job is actively executing in this process.
	for (const j of jobs) j.is_active = bulkManager.isActive(j.job_id)
	res.json({ jobs })
})

/** GET /api/bulk/jobs/:job_id — job + its items. */
app.get('/api/bulk/jobs/:job_id', (req, res) => {
	const job = bulkManager.getJob(req.params.job_id)
	if (!job) return res.status(404).json({ error: 'Job not found' })
	res.json({
		job,
		// Reopening a run must restore ITS product line (models, priced values,
		// axis names), not whatever the setup card happens to have selected.
		product_meta: bulkManager.jobProductMeta(job.job_id),
		items: bulkManager.listItemsForClient(req.params.job_id),
		is_active: bulkManager.isActive(job.job_id),
	})
})

/** DELETE /api/bulk/jobs/:job_id — remove a saved run (and its items). */
app.delete('/api/bulk/jobs/:job_id', (req, res) => {
	try {
		bulkManager.deleteJob(req.params.job_id)
		res.json({ success: true })
	} catch (err) {
		res.status(err.status || 500).json({ error: err.message })
	}
})

/** GET /api/bulk/stream/:job_id — SSE live progress. */
app.get('/api/bulk/stream/:job_id', (req, res) => {
	res.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		Connection: 'keep-alive',
	})
	res.write('\n')
	const job = bulkManager.getJob(req.params.job_id)
	if (job) {
		res.write(`data: ${JSON.stringify({ type: 'snapshot', job, items: bulkManager.listItemsForClient(req.params.job_id), regenerating: bulkManager.activeRegenSeqs(req.params.job_id) })}\n\n`)
	}
	bulkManager.subscribe(req.params.job_id, res)
})

/** POST /api/bulk/jobs/:job_id/retry — resume failed/incomplete items. */
app.post('/api/bulk/jobs/:job_id/retry', (req, res) => {
	try {
		const job = bulkManager.retry(req.params.job_id, { overrides: req.body?.overrides })
		res.json({ success: true, job })
	} catch (err) {
		res.status(err.status || 500).json({ error: err.message })
	}
})

/**
 * POST /api/bulk/jobs/:job_id/create-drafts — promote a finished DRY-RUN job to
 * a real run that creates Etsy DRAFT listings, reusing the reviewed previews.
 */
app.post('/api/bulk/jobs/:job_id/create-drafts', (req, res) => {
	try {
		const job = bulkManager.createDraftsFromDryRun(req.params.job_id)
		res.json({ success: true, job })
	} catch (err) {
		res.status(err.status || 500).json({ error: err.message })
	}
})

/** POST /api/bulk/jobs/:job_id/pause — stop after the current product. */
app.post('/api/bulk/jobs/:job_id/pause', (req, res) => {
	try {
		const job = bulkManager.pause(req.params.job_id)
		res.json({ success: true, job })
	} catch (err) {
		res.status(err.status || 500).json({ error: err.message })
	}
})

/** POST /api/bulk/jobs/:job_id/resume — continue a paused/incomplete job. */
app.post('/api/bulk/jobs/:job_id/resume', (req, res) => {
	try {
		const job = bulkManager.resume(req.params.job_id, { overrides: req.body?.overrides })
		res.json({ success: true, job })
	} catch (err) {
		res.status(err.status || 500).json({ error: err.message })
	}
})

/** POST /api/bulk/jobs/:job_id/cancel — stop the job (after the current product). */
app.post('/api/bulk/jobs/:job_id/cancel', (req, res) => {
	try {
		const job = bulkManager.cancel(req.params.job_id)
		res.json({ success: true, job })
	} catch (err) {
		res.status(err.status || 500).json({ error: err.message })
	}
})

/**
 * GET /api/bulk/jobs/:job_id/items/:seq/detail
 * Full inspection payload for one product (copy, image order, variation matrix,
 * resolved shop settings, listing/publish state).
 */
app.get('/api/bulk/jobs/:job_id/items/:seq/detail', (req, res) => {
	try {
		const detail = bulkManager.buildItemDetail(req.params.job_id, req.params.seq)
		// Currency-aware price presets = this shop's actual per-style tier prices
		// (the values shown on the bundle rows, e.g. HKD → 409.89/350.11/261.86/
		// 170.76/113.82; a CAD shop → its CAD tiers). Taken from the item's resolved
		// stylePrices so they match exactly what the operator sees; the master sheet
		// is a fallback. Deduped + sorted high→low. Powers the price combobox.
		let pricePresets = []
		try {
			const clean = (arr) => [...new Set(arr.map((n) => Math.round(Number(n) * 100) / 100).filter((n) => Number.isFinite(n) && n > 0))]
			let vals = clean(Object.values((detail.preview && detail.preview.stylePrices) || {}))
			if (!vals.length) {
				const cur = (detail.preview && detail.preview.currency) || ''
				vals = clean(Object.values(getPricesForCurrency(cur, { column: 'anchor' }).prices))
			}
			pricePresets = vals.sort((a, b) => b - a)
		} catch {
			pricePresets = []
		}
		detail.pricePresets = pricePresets
		res.json(detail)
	} catch (err) {
		res.status(err.status || 500).json({ error: err.message })
	}
})

/**
 * GET /api/bulk/jobs/:job_id/items/:seq/image/:rank[?w=240]
 * Streams a product image (validated to live inside the job's input folder)
 * so the Inspector can show the real photos in upload order.
 *
 * `?w=` returns a cached WebP thumbnail instead of the original. Supplier
 * photos are ~1 MB / 1750px each and the gallery paints them at ~72px, so the
 * Inspector asks for thumbnails and only fetches full bytes on demand. The
 * thumbnail's ETag is content-addressed (source mtime+size), which makes it
 * safe to cache immutably — a replaced photo produces a different ETag.
 */
app.get('/api/bulk/jobs/:job_id/items/:seq/image/:rank', async (req, res) => {
	let imgPath
	let mime
	try {
		const resolved = bulkManager.resolveItemImage(req.params.job_id, req.params.seq, req.params.rank)
		imgPath = resolved.path
		mime = resolved.mime
	} catch (err) {
		return res.status(err.status || 500).json({ error: err.message })
	}

	try {
		const width = thumbnails.normaliseWidth(req.query.w)
		const thumb = width ? await thumbnails.getThumbnail(imgPath, width) : null
		if (thumb) {
			// Content-addressed → the bytes behind this ETag can never change.
			res.setHeader('ETag', thumb.etag)
			res.setHeader('Content-Type', thumb.mime)
			res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
			if (req.headers['if-none-match'] === thumb.etag) return res.status(304).end()
			return fs
				.createReadStream(thumb.path)
				.on('error', () => {
					if (!res.headersSent) res.status(500).end()
				})
				.pipe(res)
		}
	} catch (err) {
		// Thumbnailing is an optimisation, never a hard dependency — fall through
		// to the original bytes rather than showing the operator a broken tile.
		console.warn('[bulk] thumbnail failed, serving original:', err.message)
	}

	res.setHeader('Content-Type', mime || 'application/octet-stream')
	res.setHeader('Cache-Control', 'private, max-age=300')
	fs.createReadStream(imgPath)
		.on('error', () => {
			if (!res.headersSent) res.status(500).end()
		})
		.pipe(res)
})

/** POST /api/bulk/jobs/:job_id/items/:seq/publish — publish one draft to Etsy. */
app.post('/api/bulk/jobs/:job_id/items/:seq/publish', async (req, res) => {
	try {
		const result = await bulkManager.publishItem(req.params.job_id, req.params.seq)
		res.json({ success: true, ...result })
	} catch (err) {
		console.error('[bulk] publish item error:', err.response?.data || err.message)
		res.status(err.status || err.response?.status || 500).json({ error: err.response?.data?.error || err.message })
	}
})

/** POST /api/bulk/jobs/:job_id/publish — publish all created drafts (background + SSE). */
app.post('/api/bulk/jobs/:job_id/publish', (req, res) => {
	try {
		res.json({ success: true, ...bulkManager.publishAll(req.params.job_id) })
	} catch (err) {
		res.status(err.status || 500).json({ error: err.message })
	}
})

/** POST /api/bulk/jobs/:job_id/items/:seq/reviewed — toggle manual-review sign-off. */
app.post('/api/bulk/jobs/:job_id/items/:seq/reviewed', (req, res) => {
	try {
		const reviewed = req.body?.reviewed !== false // default true
		res.json({
			success: true,
			...bulkManager.setItemReviewed(req.params.job_id, req.params.seq, reviewed, {
				attestation: req.body?.attestation,
				reviewedBy: req.auth?.user || 'owner',
			}),
		})
	} catch (err) {
		res.status(err.status || 500).json({ error: err.message })
	}
})

/** POST /api/bulk/jobs/:job_id/reviewed — bulk toggle review sign-off { seqs, reviewed }. */
app.post('/api/bulk/jobs/:job_id/reviewed', (req, res) => {
	try {
		const reviewed = req.body?.reviewed !== false
		res.json({
			success: true,
			...bulkManager.setItemsReviewed(
				req.params.job_id,
				Array.isArray(req.body?.seqs) ? req.body.seqs : [],
				reviewed,
				{ attestation: req.body?.attestation, reviewedBy: req.auth?.user || 'owner' },
			),
		})
	} catch (err) {
		res.status(err.status || 500).json({ error: err.message })
	}
})

/**
 * POST /api/bulk/jobs/:job_id/excluded — bulk include/exclude products from Etsy
 * creation { seqs, excluded }. Excluded rows stay in the list but are skipped
 * when the dry run is promoted to real drafts.
 */
app.post('/api/bulk/jobs/:job_id/excluded', (req, res) => {
	try {
		const excluded = req.body?.excluded !== false // default true
		res.json({ success: true, ...bulkManager.setItemsExcluded(req.params.job_id, Array.isArray(req.body?.seqs) ? req.body.seqs : [], excluded) })
	} catch (err) {
		res.status(err.status || 500).json({ error: err.message })
	}
})

/** DELETE /api/bulk/jobs/:job_id/items/:seq — remove one product from the run. */
app.delete('/api/bulk/jobs/:job_id/items/:seq', (req, res) => {
	try {
		res.json({ success: true, ...bulkManager.deleteItem(req.params.job_id, req.params.seq) })
	} catch (err) {
		res.status(err.status || 500).json({ error: err.message })
	}
})

/**
 * POST /api/bulk/jobs/:job_id/items/:seq/images — persist a curated image plan
 * { filenames: [...] } (kept images in display order; the first is the
 * thumbnail). Only valid on a dry-run preview before the draft is created.
 */
app.post('/api/bulk/jobs/:job_id/items/:seq/images', (req, res) => {
	try {
		res.json({ success: true, ...bulkManager.updateItemImages(req.params.job_id, req.params.seq, Array.isArray(req.body?.filenames) ? req.body.filenames : []) })
	} catch (err) {
		res.status(err.status || 500).json({ error: err.message })
	}
})

/**
 * POST /api/bulk/jobs/:job_id/items/:seq/images/upload
 * Body: { images: [{ data_b64, filename?, mime? }] } — base64 (data-URL ok).
 * Import operator-uploaded photos into the product folder and append them to the
 * curated image plan. Dry-run preview only, before the Etsy draft exists. The
 * client uploads one photo per request (progress + stays well under the body
 * limit); the server appends idempotently so a sequence accumulates correctly.
 */
app.post('/api/bulk/jobs/:job_id/items/:seq/images/upload', express.json({ limit: '60mb' }), async (req, res) => {
	try {
		const raw = Array.isArray(req.body?.images) ? req.body.images : []
		const files = []
		for (const it of raw) {
			const { data } = _decodeBase64Image(it?.data_b64 ?? it?.image_b64, it?.mime)
			if (data) files.push({ data, filename: typeof it?.filename === 'string' ? it.filename : '' })
		}
		if (!files.length) return res.status(400).json({ error: 'A valid image is required.' })
		const result = await bulkManager.addItemImages(req.params.job_id, req.params.seq, files)
		res.json({ success: true, ...result })
	} catch (err) {
		res.status(err.status || 500).json({ error: err.message })
	}
})

/**
 * POST /api/bulk/jobs/:job_id/items/:seq/images/:rank/crop
 * Body: { left, top, width, height, rotate } — the rectangle in the pixel space
 * of the EXIF-oriented photo AFTER `rotate` degrees, i.e. exactly the frame the
 * operator dragged the crop box in.
 *
 * Rewrites the photo in place (same filename, same format) and keeps a pristine
 * copy for the revert below. Dry-run preview only, before the Etsy draft exists.
 */
app.post('/api/bulk/jobs/:job_id/items/:seq/images/:rank/crop', async (req, res) => {
	try {
		const result = await bulkManager.cropItemImage(req.params.job_id, req.params.seq, req.params.rank, req.body || {})
		res.json({ success: true, ...result })
	} catch (err) {
		res.status(err.status || 500).json({ error: err.message })
	}
})

/**
 * POST /api/bulk/jobs/:job_id/items/:seq/images/:rank/revert
 * Restore a cropped photo to exactly the file the supplier shipped.
 */
app.post('/api/bulk/jobs/:job_id/items/:seq/images/:rank/revert', async (req, res) => {
	try {
		const result = await bulkManager.revertItemImage(req.params.job_id, req.params.seq, req.params.rank)
		res.json({ success: true, ...result })
	} catch (err) {
		res.status(err.status || 500).json({ error: err.message })
	}
})

/**
 * POST /api/bulk/jobs/:job_id/items/:seq/prices  { style_prices: {styleKey: price} }
 * Update one product's per-style prices; re-pushes inventory if it's a live draft.
 */
app.post('/api/bulk/jobs/:job_id/items/:seq/prices', async (req, res) => {
	try {
		const result = await bulkManager.updateItemPrices(req.params.job_id, req.params.seq, req.body?.style_prices || {})
		res.json({ success: true, ...result })
	} catch (err) {
		console.error('[bulk] item prices error:', err.response?.data || err.message)
		res.status(err.status || err.response?.status || 500).json({ error: err.response?.data?.error || err.message })
	}
})

/**
 * POST /api/bulk/jobs/:job_id/items/:seq/variations  { enabled_styles, style_prices }
 * Adjust which of the 6 styles a listing offers (and optionally its prices);
 * re-pushes the variation inventory for a live draft.
 */
app.post('/api/bulk/jobs/:job_id/items/:seq/variations', async (req, res) => {
	try {
		const result = await bulkManager.updateItemVariations(req.params.job_id, req.params.seq, {
			enabledStyles: req.body?.enabled_styles,
			stylePrices: req.body?.style_prices,
			styleImageMapping: req.body?.style_image_mapping,
			enabledModels: req.body?.enabled_models,
			customStyles: req.body?.custom_styles,
			variationOrder: req.body?.variation_order,
		})
		res.json({ success: true, ...result })
	} catch (err) {
		console.error('[bulk] item variations error:', err.response?.data || err.message)
		res.status(err.status || err.response?.status || 500).json({ error: err.response?.data?.error || err.message })
	}
})

/**
 * POST /api/bulk/jobs/:job_id/prices  { style_prices: {styleKey: price} }
 * Bulk-apply one price set to every product in the job (background + SSE).
 */
/**
 * POST /api/bulk/jobs/:job_id/bulk-models
 * Body: { seqs: number[], enabled_models: {model: bool} }
 * Bulk-apply an iPhone-model selection to the chosen listings (background + SSE).
 */
app.post('/api/bulk/jobs/:job_id/bulk-models', (req, res) => {
	try {
		const result = bulkManager.bulkUpdateModels(req.params.job_id, Array.isArray(req.body?.seqs) ? req.body.seqs : [], req.body?.enabled_models || {})
		res.json({ success: true, ...result })
	} catch (err) {
		res.status(err.status || 500).json({ error: err.message })
	}
})

app.post('/api/bulk/jobs/:job_id/prices', (req, res) => {
	try {
		res.json({ success: true, ...bulkManager.updateAllPrices(req.params.job_id, req.body?.style_prices || {}) })
	} catch (err) {
		res.status(err.status || 500).json({ error: err.message })
	}
})

/**
 * POST /api/bulk/jobs/:job_id/items/:seq/regenerate  { character_name? }
 * Regenerate copy (Phase-2 only), optionally with a corrected character name;
 * pushes the new title/description/tags to Etsy for a live draft.
 *
 * "Apply & regenerate copy" commits the whole inspector, so the request also
 * carries the variation matrix exactly as the operator sees it (models, styles,
 * variation photos, custom values and their dropdown order). Sending it makes
 * the regeneration self-contained: the copy is written for that matrix, and
 * that matrix is what gets stored — it can never fall back to a stale one.
 */
app.post('/api/bulk/jobs/:job_id/items/:seq/regenerate', async (req, res) => {
	try {
		const result = bulkManager.startRegenerateItemCopy(req.params.job_id, req.params.seq, {
			characterName: req.body?.character_name,
			magsafe: typeof req.body?.magsafe === 'boolean' ? req.body.magsafe : undefined,
			enabledModels: req.body?.enabled_models,
			enabledStyles: req.body?.enabled_styles,
			styleImageMapping: req.body?.style_image_mapping,
			customStyles: req.body?.custom_styles,
			variationOrder: req.body?.variation_order,
		})
		res.json({ success: true, ...result })
	} catch (err) {
		console.error('[bulk] regenerate error:', err.response?.data || err.message)
		res.status(err.status || err.response?.status || 500).json({ error: err.response?.data?.error || err.message })
	}
})

/** GET /api/bulk/characters — the curated character catalog (for the picker). */
app.get('/api/bulk/characters', (req, res) => {
	const byFranchise = {}
	for (const c of CHARACTERS) {
		;(byFranchise[c.franchise] ||= []).push(c.name)
	}
	for (const f of Object.keys(byFranchise)) byFranchise[f].sort((a, b) => a.localeCompare(b))
	res.json({
		characters: CHARACTERS.map((c) => ({ name: c.name, franchise: c.franchise })),
		by_franchise: byFranchise,
	})
})

// ─── Inventory ────────────────────────────────────────────────────────────────

/**
 * GET /api/inventory/:listing_id
 * Returns cached inventory rows for a listing, grouped by style.
 */
/**
 * GET /api/inventory/bulk?listing_ids=1,2,3
 * Returns cached inventory for multiple listing IDs in one DB query.
 * Used by the listings tab to populate all visible rows without N+1 requests.
 * MUST be defined before /api/inventory/:listing_id to avoid param capture.
 */
app.get('/api/inventory/bulk', (req, res) => {
	const ids = (req.query.listing_ids || '')
		.split(',')
		.map((s) => parseInt(s.trim(), 10))
		.filter((n) => !isNaN(n) && n > 0)

	if (!ids.length) return res.json({ inventory: {} })

	const placeholders = ids.map(() => '?').join(',')
	const rows = db
		.prepare(
			`
    SELECT listing_id, product_id, offering_id, style_value, secondary_value,
           quantity, is_enabled, price_amount, price_currency, synced_at
    FROM listing_inventory
    WHERE listing_id IN (${placeholders})
    ORDER BY listing_id, style_value, secondary_value
  `,
		)
		.all(...ids)

	// Group by listing_id
	const inventory = {}
	for (const row of rows) {
		const lid = row.listing_id
		if (!inventory[lid]) inventory[lid] = []
		inventory[lid].push(row)
	}

	res.json({ inventory })
})

/**
 * GET /api/inventory/:listing_id
 * Returns cached inventory for a single listing from local DB.
 */
app.get('/api/inventory/:listing_id', (req, res) => {
	const rows = db
		.prepare(
			`
    SELECT * FROM listing_inventory WHERE listing_id = ? ORDER BY style_value, secondary_value
  `,
		)
		.all(req.params.listing_id)
	res.json({ listing_id: req.params.listing_id, products: rows })
})

/**
 * POST /api/inventory/sync/:shop_name
 * Checks live Etsy inventory for every active listing of a shop AND auto-restocks
 * any out-of-stock variation (when auto_restock_enabled). This is the same engine
 * the background scheduler uses — triggering it manually just runs it on demand.
 *
 * Behaviour per listing:
 *   1. GET live inventory, refresh the local cache.
 *   2. If a variation is at zero:
 *        - auto_restock_enabled  → top-up ALL low offerings to restock_quantity
 *          (never reduces healthy ones), PUT to Etsy, log AUTO_RESTOCK.
 *        - auto_restock disabled → log ONE ZERO_STOCK alert (1-hour dedup).
 *
 * Performance: listings are processed with bounded concurrency so a shop with
 * 100+ listings finishes in seconds, not minutes (each worker stays well under
 * the 5 QPS limit; withRetry handles any 429s).
 */
app.post('/api/inventory/sync/:shop_name', async (req, res) => {
	try {
		const { shopClient, shopCfg } = await getShopClientForShopName(req.params.shop_name)

		const listings = db.prepare("SELECT listing_id, title FROM listings WHERE shop_id = ? AND state = 'active'").all(shopCfg.shop_id)

		if (!listings.length) {
			return res.json({ success: true, synced: 0, message: 'No active listings cached. Sync listings first.' })
		}

		const autoRestock = isAutoRestockEnabled(config)
		const restockQty = config.restock_quantity ?? 3

		let synced = 0,
			restocked = 0,
			zeroAlerts = 0,
			restockFailed = 0
		const zeroListingIds = new Set()

		const upsertInv = (listingId, inv) => {
			for (const product of inv.products || []) {
				for (const offering of product.offerings || []) {
					upsertListingInventory(db, listingId, product, offering)
				}
			}
		}

		// ── Per-listing worker: GET → cache → (restock | alert) ──────────────────
		const processListing = async (listing) => {
			const listingId = listing.listing_id
			let inv
			try {
				inv = await getListingInventory(shopClient, listingId)
				upsertInv(listingId, inv)
				synced++
			} catch (err) {
				console.warn(`[inventory] Fetch failed for listing ${listingId}:`, err.response?.data?.error || err.message)
				return
			}

			if (!listingHasLiveZero(inv)) return
			zeroListingIds.add(listingId)

			const { styles } = getZeroStylesForListing(db, listingId)
			const styleLabel = formatStyleLabel(styles)

			// Alert-only mode
			if (!autoRestock) {
				if (
					logZeroStockIfNeeded(db, {
						event_type: 'ZERO_STOCK',
						shop_name: req.params.shop_name,
						listing_id: listingId,
						listing_title: listing.title || null,
						style_value: styleLabel,
						detail: `Zero stock in [${styleLabel}] detected during inventory sync. Auto-restock disabled.`,
					})
				)
					zeroAlerts++
				return
			}

			// Auto-restock: top-up every low offering, then PUT
			try {
				const changed = raiseOfferingsToTarget(inv, restockQty)
				await updateListingInventory(shopClient, listingId, inv)
				upsertInv(listingId, inv)
				restocked++
				console.log(`[inventory] ${req.params.shop_name}: restocked listing ${listingId} (${changed} offering(s) raised to qty ${restockQty})`)
				logEvent(db, {
					event_type: 'AUTO_RESTOCK',
					shop_name: req.params.shop_name,
					listing_id: listingId,
					listing_title: listing.title || null,
					style_value: styleLabel,
					detail: `Auto-restocked [${styleLabel}] to qty ${restockQty} during inventory sync (${changed} offering(s) raised)`,
					meta: { triggered_by: 'inventory_sync', zero_styles: styles, raised_count: changed, target_quantity: restockQty },
				})
			} catch (err) {
				const status = err.response?.status || err.status || 500
				const isAuth = status === 403
				restockFailed++
				logEvent(db, {
					event_type: 'RESTOCK_FAILED',
					shop_name: req.params.shop_name,
					listing_id: listingId,
					listing_title: listing.title || null,
					style_value: styleLabel,
					detail: isAuth ? `Restock failed (403): listings_w scope required. Re-run "npm run oauth:setup" for this shop.` : `Restock failed (${status}): ${err.response?.data?.error || err.message}`,
					meta: { status, needs_reauth: isAuth },
				})
			}
		}

		// ── Bounded-concurrency pool over all listings ───────────────────────────
		const CONCURRENCY = 4
		let cursor = 0
		const runWorker = async () => {
			while (cursor < listings.length) {
				const next = listings[cursor++]
				await processListing(next)
			}
		}
		await Promise.all(Array.from({ length: Math.min(CONCURRENCY, listings.length) }, runWorker))

		logEvent(db, {
			event_type: 'INV_SYNC',
			shop_name: req.params.shop_name,
			detail: `Inventory sync: ${synced} listing(s) checked, ${zeroListingIds.size} with zero stock — ` + `${restocked} auto-restocked` + (restockFailed ? `, ${restockFailed} failed` : '') + (zeroAlerts ? `, ${zeroAlerts} alerted` : '') + '.',
		})

		console.log(`[inventory] ${req.params.shop_name}: ${synced} checked, ` + `${zeroListingIds.size} zero-stock, ${restocked} restocked, ${restockFailed} failed`)

		res.json({
			success: true,
			synced,
			zero_stock_listings: zeroListingIds.size,
			restocked,
			restock_failed: restockFailed,
			events_logged: restocked + zeroAlerts,
		})
	} catch (err) {
		console.error('[inventory] Sync error:', err.message)
		res.status(err.status || 500).json({ error: err.message })
	}
})

/**
 * POST /api/inventory/:listing_id/restock
 * Restocks all zero-qty offerings for a given style across all phone models.
 * Requires listings_w OAuth scope — returns a clear 403 message if missing.
 *
 * Body: { shop_name, style_value, target_quantity (default 3) }
 *   style_value — canonical style key (e.g. "case only"). Restocks ALL models
 *                 of that style that are at zero. If omitted, restocks every
 *                 zero-qty offering in the listing.
 */
app.post('/api/inventory/:listing_id/restock', async (req, res) => {
	const { shop_name, style_value, target_quantity = 3 } = req.body
	if (!shop_name) return res.status(400).json({ error: 'shop_name required' })

	const listingRow = db.prepare('SELECT title FROM listings WHERE listing_id = ?').get(req.params.listing_id)
	const listingTitle = listingRow?.title || `Listing ${req.params.listing_id}`
	const triggeredBy = style_value || 'manual'

	try {
		const { shopClient } = await getShopClientForShopName(shop_name)

		// Step 1: Fetch full current inventory (required for the PUT)
		const inv = await getListingInventory(shopClient, req.params.listing_id)

		// Step 2: Set ALL offerings across ALL styles to target_quantity.
		// When any style hits 0 we top up the whole listing so every style is
		// back to full stock in one atomic operation.
		let updated = 0
		for (const product of inv.products || []) {
			for (const offering of product.offerings || []) {
				offering.quantity = parseInt(target_quantity)
				updated++
			}
		}

		if (!updated) return res.status(404).json({ error: 'Listing has no offerings to restock' })

		// Step 3: PUT the full inventory back (updateListingInventory strips invalid fields)
		await updateListingInventory(shopClient, req.params.listing_id, inv)

		// Step 4: Update local cache
		for (const product of inv.products || []) {
			for (const offering of product.offerings || []) {
				upsertListingInventory(db, parseInt(req.params.listing_id), product, offering)
			}
		}

		// ONE consolidated event per restock action
		logEvent(db, {
			event_type: 'MANUAL_RESTOCK',
			shop_name,
			listing_id: parseInt(req.params.listing_id),
			listing_title: listingTitle,
			style_value: 'All styles',
			detail: `Restocked all 6 styles to qty ${target_quantity} (triggered by: ${triggeredBy})`,
			meta: { triggered_by: triggeredBy, updated_count: updated, target_quantity },
		})

		console.log(`[inventory] Restocked ${shop_name} listing ${req.params.listing_id} all styles × ${updated} offering(s) → qty ${target_quantity}`)
		res.json({ success: true, target_quantity, updated_count: updated })
	} catch (err) {
		const status = err.response?.status || err.status || 500
		const errMsg = err.response?.data?.error || err.message

		// Friendly message for missing listings_w scope
		const isAuthErr = status === 403
		const userMsg = isAuthErr ? 'listings_w scope required. Re-run npm run oauth:setup for this shop to grant restock permission.' : errMsg

		logEvent(db, {
			event_type: 'RESTOCK_FAILED',
			shop_name,
			listing_id: parseInt(req.params.listing_id),
			listing_title: listingTitle,
			style_value: triggeredBy,
			detail: `Restock failed: ${userMsg}`,
			meta: { status, error: errMsg },
		})

		console.error(`[inventory] Restock failed (${status}):`, errMsg)
		res.status(status).json({ error: userMsg, needs_reauth: isAuthErr })
	}
})

// ─── Inventory watch status ───────────────────────────────────────────────────

/**
 * GET /api/inventory/watch/status
 * Returns the current auto-restock configuration and when it last ran.
 * Used by the UI status strip in the Listings tab.
 */
app.get('/api/inventory/watch/status', (req, res) => {
	// "Last check" = the true heartbeat of the automation: the most recent
	// SUCCESSFUL background sync. This updates every cycle even when nothing is
	// out of stock, so the UI reflects that checks are running (not just restocks).
	const lastSync = db
		.prepare(
			`
    SELECT MAX(started_at) AS t FROM sync_log WHERE status = 'success'
  `,
		)
		.get()

	// Most recent restock/alert activity (separate signal — only when something happened)
	const lastRestock = db
		.prepare(
			`
    SELECT MAX(created_at) AS t FROM events
    WHERE event_type IN ('AUTO_RESTOCK', 'ORDER_RESTOCK', 'ZERO_STOCK', 'RESTOCK_FAILED', 'MANUAL_RESTOCK')
  `,
		)
		.get()

	// "Last check" is whichever heartbeat is newer.
	const lastCheck = Math.max(lastSync?.t ?? 0, lastRestock?.t ?? 0) || null

	// 24h health metrics
	const last24h = Math.floor(Date.now() / 1000) - 86400
	const restockRow = db
		.prepare(
			`
    SELECT
      SUM(CASE WHEN event_type = 'AUTO_RESTOCK'  THEN 1 ELSE 0 END) AS auto_count,
      SUM(CASE WHEN event_type = 'ORDER_RESTOCK' THEN 1 ELSE 0 END) AS order_count,
      SUM(CASE WHEN event_type = 'RESTOCK_FAILED' THEN 1 ELSE 0 END) AS fail_count,
      SUM(CASE WHEN event_type = 'ZERO_STOCK'    THEN 1 ELSE 0 END) AS zero_count
    FROM events WHERE created_at >= ?
  `,
		)
		.get(last24h)

	// How many successful background syncs ran in the last 24h (proof of life)
	const syncRow = db
		.prepare(
			`
    SELECT COUNT(*) AS n FROM sync_log WHERE status = 'success' AND started_at >= ?
  `,
		)
		.get(last24h)

	res.json({
		auto_restock_enabled: isAutoRestockEnabled(config),
		restock_quantity: config.restock_quantity ?? 3,
		inv_watch_interval_minutes: config.inv_watch_interval_minutes ?? 240,
		embedded_sync: process.env.EMBEDDED_SYNC !== '0',
		last_activity_at: lastCheck,
		last_activity_at_iso: lastCheck ? new Date(lastCheck * 1000).toISOString() : null,
		last_restock_at: lastRestock?.t ?? null,
		last_restock_at_iso: lastRestock?.t ? new Date(lastRestock.t * 1000).toISOString() : null,
		last_24h: {
			auto_restocks: restockRow?.auto_count ?? 0,
			order_restocks: restockRow?.order_count ?? 0,
			restock_failed: restockRow?.fail_count ?? 0,
			zero_stock_alerts: restockRow?.zero_count ?? 0,
			syncs_completed: syncRow?.n ?? 0,
		},
	})
})

/**
 * PATCH /api/inventory/auto-restock
 * Owner-only. Persist auto_restock_enabled (and optional restock_quantity) to
 * config.json, apply it to the running process, and when turning ON queue the
 * same inventory-watch sweep the scheduler uses so currently-zero listings are
 * restocked immediately instead of waiting for the next order or 4h watch.
 *
 * Body: { enabled: boolean, restock_quantity?: integer }
 */
app.patch('/api/inventory/auto-restock', (req, res) => {
	if (!req.auth || req.auth.role !== 'owner') {
		return res.status(403).json({ error: 'Only the owner can change auto-restock.', code: 'OWNER_REQUIRED' })
	}

	const body = req.body && typeof req.body === 'object' ? req.body : {}
	if (!Object.prototype.hasOwnProperty.call(body, 'enabled') || typeof body.enabled !== 'boolean') {
		return res.status(400).json({ error: 'Body must include enabled: true or false' })
	}

	const patch = { auto_restock_enabled: body.enabled }
	if (Object.prototype.hasOwnProperty.call(body, 'restock_quantity')) {
		const qty = Number(body.restock_quantity)
		if (!Number.isInteger(qty) || qty < 1 || qty > 999) {
			return res.status(400).json({ error: 'restock_quantity must be an integer from 1 to 999' })
		}
		patch.restock_quantity = qty
	}

	let next
	try {
		next = patchRuntimeSettings(patch)
	} catch (err) {
		console.error('[inventory] Failed to persist auto-restock setting:', err.message)
		return res.status(500).json({ error: 'Could not save auto-restock setting', detail: err.message })
	}

	Object.assign(config, next)

	const enabled = isAutoRestockEnabled(config)
	const qty = config.restock_quantity ?? 3
	const by = (req.auth && req.auth.user) || 'owner'

	logEvent(db, {
		event_type: 'CONFIG',
		detail: enabled ? `Auto-restock enabled by ${by}. Zero-stock offerings will be raised to qty ${qty}.` : `Auto-restock disabled by ${by}. Zero-stock listings will alert only until restocked manually.`,
		meta: { auto_restock_enabled: enabled, restock_quantity: qty, by },
	})
	console.log(`[inventory] Auto-restock ${enabled ? 'ENABLED' : 'DISABLED'} by ${by} (qty ${qty})`)

	let sweep_queued = false
	if (enabled) {
		sweep_queued = true
		setImmediate(() => {
			runInventoryWatchCycle(config, tokenManager, db).catch((err) => {
				console.error('[inventory] post-enable sweep failed:', err.message)
			})
		})
	}

	res.json({
		success: true,
		auto_restock_enabled: enabled,
		restock_quantity: qty,
		sweep_queued,
	})
})

// ─── Events log ───────────────────────────────────────────────────────────────

/**
 * GET /api/events
 * Returns recent events. Query: type, shop_name, limit, offset
 */
app.get('/api/events', (req, res) => {
	const limit = Math.min(parseInt(req.query.limit ?? 100, 10), 500)
	const offset = parseInt(req.query.offset ?? 0, 10)
	const conds = [],
		params = {}

	if (req.query.type && req.query.type !== 'all') {
		conds.push('event_type = @type')
		params.type = req.query.type
	}
	if (req.query.shop) {
		conds.push('shop_name = @shop')
		params.shop = req.query.shop
	}

	const where = conds.length ? 'WHERE ' + conds.join(' AND ') : ''
	const total = db.prepare(`SELECT COUNT(*) as n FROM events ${where}`).get(params).n
	const rows = db.prepare(`SELECT * FROM events ${where} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`).all({ ...params, limit, offset })

	res.json({ total, events: rows })
})

// ─── Shopping Route Generator API ────────────────────────────────────────────

/**
 * GET /api/route/config
 * Returns the (self-contained) route-engine status so the UI can show a setup
 * callout if the vendored engine is somehow missing.
 */
app.get('/api/route/config', (req, res) => {
	const engineRoot = enginePaths.engineDir(config)
	const engineScript = enginePaths.engineScript(config)
	const owner = req.auth && req.auth.role === 'owner'
	let scriptExists = false
	if (engineScript) {
		try {
			fs.accessSync(engineScript, fs.constants.R_OK)
			scriptExists = true
		} catch {}
	}
	let charmCount = 0
	try {
		charmCount = routeDashboard.loadCharmCatalog(engineRoot).charms.length
	} catch {}

	res.json({
		configured: !!engineRoot,
		script_exists: scriptExists,
		osp_project_dir: owner && engineRoot ? engineRoot : engineRoot ? path.basename(engineRoot) : null,
		osp_python: owner ? enginePaths.enginePython(config) : path.basename(enginePaths.enginePython(config)),
		script_path: owner && engineScript ? engineScript : engineScript ? path.basename(engineScript) : null,
		charm_count: charmCount,
		job: owner ? _routeJob : { ..._routeJob, log: (_routeJob.log || []).filter((line) => !String(line).includes('[cmd]')) },
	})
})

/**
 * GET /api/route/status
 * Returns the current route job state (status, log lines, output files).
 * The browser polls this endpoint every 1.5 s while status === 'running'.
 */
app.get('/api/route/status', (req, res) => {
	if (req.auth && req.auth.role === 'owner') return res.json(_routeJob)
	res.json({
		..._routeJob,
		log: (_routeJob.log || []).filter((line) => !String(line).includes('[cmd]')),
	})
})

/**
 * GET /api/route/dashboard
 * The integrated Orders Sorting Dashboard data: every pending order line-item
 * merged with its saved charm assignment + per-component purchase status.
 *
 * Query params: date_from, date_to, shop_id, include_shipped (all optional).
 */
app.get('/api/route/dashboard', (req, res) => {
	try {
		// Explicit receipt set — comma-separated, bypasses the date/shipped filters
		// so only those receipts are returned (used by the "Add Order" lookup).
		const receiptIds = (req.query.receipt_ids || '')
			.split(',')
			.map((s) => parseInt(s.trim(), 10))
			.filter(Number.isInteger)

		// Extra receipts pulled in via the Orders tab "Send to Route" — merged on
		// TOP of the date/shop scope so pre-transit orders show alongside pending.
		const extraIds = (req.query.extra_receipt_ids || '')
			.split(',')
			.map((s) => parseInt(s.trim(), 10))
			.filter(Number.isInteger)

		const routeBuildStarted = process.hrtime.bigint()
		const rows = routeDashboard.buildRouteRows(db, config, {
			date_from: req.query.date_from,
			date_to: req.query.date_to,
			shop_id: req.query.shop_id,
			include_shipped: req.query.include_shipped === 'true',
			// Pre-transit orders flagged "needs purchase" are auto-merged into the route so
			// they reliably get bought (durable, server-side — not browser localStorage).
			include_needs_purchase: req.query.include_needs_purchase !== 'false',
			enrich_supplier: req.query.enrich_supplier !== 'false',
			// Include durably-removed lines so the client can power its "Show removed"
			// view + Undo without a second round-trip. They are flagged (r.dismissed)
			// and hidden from the active list client-side, exactly like fully-purchased.
			include_dismissed: req.query.include_dismissed !== 'false',
			receipt_ids: receiptIds.length ? receiptIds : undefined,
			extra_receipt_ids: extraIds.length ? extraIds : undefined,
		})
		const routeBuildMs = Number(process.hrtime.bigint() - routeBuildStarted) / 1e6

		// Headline counts for the dashboard summary bar.
		//
		// The headline "orders" / "items" counts reflect what STILL NEEDS SHOPPING:
		// a line that is excluded or fully purchased (every component bought) is done,
		// so it is dropped from these counts to avoid inflating the shopping workload.
		// Fully purchased lines are surfaced separately via `fully_purchased` so the
		// operator can still see (and reveal) them. The client recomputes this exact
		// shape live from the in-memory rows as statuses change — keep the two in sync.
		//
		// `charms_assigned` counts rows where the operator (or a per-product default) has
		// explicitly confirmed a charm code.  Catalog/Excel suggestions intentionally do NOT
		// count — r.charm_code is only populated from user-confirmed sources in buildRouteRows.
		// Removed (dismissed) lines never count toward shopping work — they are a
		// separate, reviewable bucket surfaced via the "🗑 removed" pill.
		const live = rows.filter((r) => !r.dismissed)
		// A SWAP model fix holds its generation-specific unit in hand (the case
		// on iPhone; the case + attached charm on AirPods). A separately-sourced
		// grip/charm on the SAME line still need buying, so it stays in the "to
		// shop" active set whenever it has such pieces left (a pure unit swap
		// drops out, like a fully purchased line) and is surfaced separately via
		// `to_exchange`. A BUY model fix holds nothing at all, so it is ordinary
		// shopping work that happens to carry a corrected model, and is counted
		// here like any other line.
		// Mirrors the client's _computeRouteSummary exactly.
		const active = live.filter((r) => !r.excluded && !r.fully_purchased && (!r.needs_exchange || routeDashboard.rowHasShoppingWork(r)))
		const isSwap = (r) => routeDashboard.exchangeIntent(r) === routeDashboard.EXCHANGE_INTENT_SWAP
		const isBuyFix = (r) => routeDashboard.exchangeIntent(r) === routeDashboard.EXCHANGE_INTENT_BUY
		const summary = {
			orders: new Set(active.map((r) => r.receipt_id)).size,
			items: active.length,
			excluded: live.filter((r) => r.excluded).length,
			fully_purchased: live.filter((r) => r.fully_purchased && !r.excluded && !r.needs_exchange).length,
			// Swaps owed at a stall — in hand, never re-bought.
			to_exchange: live.filter((r) => isSwap(r) && !r.excluded).length,
			// Lines whose model was corrected and must be BOUGHT. They are already
			// inside `items`; this count exists so the operator can see (and filter
			// to) the ones where buying the model on the order line would be a
			// mistake. Never hidden from the buy queue.
			to_buy_model: live.filter((r) => isBuyFix(r) && !r.excluded && !r.fully_purchased).length,
			dismissed: rows.filter((r) => r.dismissed).length,
			// Charm-code assignment progress. Integral (AirPods) charms are excluded:
			// they ship attached to the case and need no code, so counting them would
			// leave "assigned" permanently short of "needed".
			charms_needed: active.filter((r) => r.has_charm && !r.charm_integral).length,
			charms_assigned: active.filter((r) => r.has_charm && !r.charm_integral && r.charm_code).length,
			// Sourcing progress. "Missing" is every line with nowhere trustworthy to
			// buy it — never catalogued, OR flagged Wrong Stall in person, since a
			// stall that turned out to be wrong leaves the shopper exactly as stuck.
			// `supplier_wrong_stall` breaks out that second group so the operator can
			// see how much of the gap is a bad mapping rather than a missing one.
			supplier_matched: live.filter((r) => !r.needs_sourcing).length,
			supplier_missing: live.filter((r) => r.needs_sourcing).length,
			supplier_wrong_stall: live.filter((r) => r.sourcing_reason === routeSourcing.REASON_WRONG_STALL).length,
			total_orders: new Set(live.map((r) => r.receipt_id)).size,
			total_items: live.length,
		}

		const roundedRouteBuildMs = Number(routeBuildMs.toFixed(1))
		res.set('Server-Timing', `route-build;dur=${roundedRouteBuildMs.toFixed(1)}`)
		res.set('X-Route-Row-Count', String(rows.length))
		res.json({
			rows,
			summary,
			statuses: routeDashboard.STATUS_OPTIONS,
			meta: {
				row_count: rows.length,
				route_build_ms: roundedRouteBuildMs,
			},
		})
	} catch (err) {
		console.error('[route] dashboard error:', err.message)
		res.status(500).json({ error: err.message })
	}
})

/**
 * POST /api/route/assign
 * Body: { receipt_id, item_key, title?, charm_code?, charm_shop?,
 *         status_case?, status_grip?, status_charm?, excluded?,
 *         supplier_shop_override?, supplier_stall_override? }
 * Upserts one order line's assignment. Only provided fields change.
 *
 * Correcting a location also clears any Wrong Stall flag it answers (returned as
 * `resolved_wrong_stall`) — see routeSourcing.componentsResolvedByCorrection.
 * Product-level fan-out uses routeSourcing.locationMoved / productLocation so the
 * "did this save move a stall?" check stays in one place with the rest of the
 * wrong-stall policy.
 */
app.post('/api/route/assign', express.json(), (req, res) => {
	const b = req.body ?? {}
	if (b.receipt_id == null || !b.item_key) {
		return res.status(400).json({ error: 'receipt_id and item_key are required.' })
	}
	const validStatus = (value) => value == null || routeDashboard.STATUS_OPTIONS.includes(value)
	if (!validStatus(b.status_case) || !validStatus(b.status_grip) || !validStatus(b.status_charm)) {
		return res.status(400).json({ error: 'Invalid status value.' })
	}
	try {
		let row
		let settledFixes = []
		let resolvedWrongStall = []
		let catalogChanged = false
		const hasStatusChange = b.status_case != null || b.status_grip != null || b.status_charm != null
		// Keep the assignment, verification gate, issue bridge, model-fix settlement
		// and order rollup atomic — the same invariant enforced by Shopping Mode.
		db.transaction(() => {
			// What the line looked like BEFORE this write, so we can tell whether the
			// operator actually moved a location (and not merely re-saved the same one).
			const before = getRouteAssignment(db, Number(b.receipt_id), String(b.item_key))
			row = upsertRouteAssignment(db, {
				receipt_id: Number(b.receipt_id),
				item_key: String(b.item_key),
				title: b.title,
				charm_code: b.charm_code,
				charm_shop: b.charm_shop,
				status_case: b.status_case,
				status_grip: b.status_grip,
				status_charm: b.status_charm,
				excluded: b.excluded,
				supplier_shop_override: b.supplier_shop_override,
				supplier_stall_override: b.supplier_stall_override,
			})

			// Recording a NEW location answers the "wrong stall" report about the old
			// one: those pieces go back to Pending, now aimed at the corrected stall.
			// Without this the flag would outlive its own answer — the line would stay
			// in the unmatched bucket and keep being exported for re-sourcing forever.
			// Statuses the caller set explicitly in THIS request always win, so an
			// operator marking Wrong Stall and a supplier in one go is never undone.
			const moved = {
				supplier: routeSourcing.locationMoved(before, row, ['supplier_shop_override', 'supplier_stall_override']),
				charm: routeSourcing.locationMoved(before, row, ['charm_code', 'charm_shop']),
			}
			resolvedWrongStall = routeSourcing.componentsResolvedByCorrection(row, moved).filter((comp) => b[routeSourcing.STATUS_FIELD[comp]] == null)
			if (resolvedWrongStall.length) {
				const patch = { receipt_id: row.receipt_id, item_key: row.item_key }
				for (const comp of resolvedWrongStall) patch[routeSourcing.STATUS_FIELD[comp]] = routeSourcing.RESOLVED_STATUS
				row = upsertRouteAssignment(db, patch)
			}

			// An auto-resolved Wrong Stall is a status change like any other, so it
			// goes through the same side effects rather than assuming Wrong Stall and
			// Pending happen to classify identically downstream.
			if (hasStatusChange || resolvedWrongStall.length) {
				if (resolvedWrongStall.length || [b.status_case, b.status_grip, b.status_charm].some((status) => status != null && status !== 'Purchased')) {
					clearRouteVerified(db, row.receipt_id, row.item_key)
				}
				syncAssignmentIssue(row.receipt_id, row.item_key)
				settledFixes = settleBoughtModelFixes(row.receipt_id, row.item_key)
				recomputeNeedsPurchaseRollup(Number(b.receipt_id))
			}
		})()

		// ── Persist supplier + charm at product level so every future order
		//    with the same product title gets the same defaults automatically.
		const hasSupplierChange = b.supplier_shop_override != null || b.supplier_stall_override != null
		const hasCharmChange = b.charm_code != null
		if ((hasSupplierChange || hasCharmChange) && b.item_key) {
			// Route the per-product default to the product we will actually BUY. On a
			// SWITCHED line that is the REPLACEMENT design — not the original order
			// line — so both the key and the title come from the substitution. This
			// keeps the WRITE symmetric with how buildRouteRows READS the default
			// (routeDashboard.productDefaultsKey): a supplier/charm the operator sets
			// on a switched line becomes the REPLACEMENT product's default, and never
			// pollutes (or is misattributed to) the original product.
			//
			// A CUSTOM upload has no catalog product (productKey === null): we skip the
			// product-level + catalog write entirely so we neither corrupt the original
			// product's default nor invent a bogus catalog entry from a one-off title.
			// The per-order override saved just above still stands, so the operator's
			// choice is honoured for that specific line.
			const sub = getSubstitutionForLine(db, Number(b.receipt_id), String(b.item_key))
			const productKey = routeDashboard.productDefaultsKey(String(b.item_key), sub)
			const effectiveTitle = sub && sub.new_title ? sub.new_title : b.title
			const catalogEntry = getProductMapRow(db, { title: effectiveTitle })
			// An order-level override on a discontinued product is allowed, but it
			// must not recreate a global default or silently restore catalog status.
			if (productKey && catalogEntry?.status !== 'retired') {
				const productPatch = { item_key: productKey, title: effectiveTitle }
				if (hasSupplierChange) {
					productPatch.supplier_shop = b.supplier_shop_override ?? ''
					productPatch.supplier_stall = b.supplier_stall_override ?? ''
				}
				if (hasCharmChange) {
					productPatch.charm_code = b.charm_code ?? ''
					productPatch.charm_shop = b.charm_shop ?? ''
				}
				// Where every OTHER order of this product was being sent before this
				// save: its product default, or the catalog entry behind it. Compared
				// against the default actually stored (upsertProductAssignment keeps a
				// previous value rather than blanking it) so only a real move counts.
				const productBefore = routeSourcing.productLocation(getProductAssignment(db, productKey), getProductMapRow(db, { title: effectiveTitle }))
				const productAfter = routeSourcing.productLocation(upsertProductAssignment(db, productPatch), null)

				// Write-through to the Product Catalog (product_map) so a supplier/charm
				// edited HERE in the Orders Sorting Dashboard is immediately reflected in
				// the Product Catalog modal — the two views stay consistent. Only the
				// field(s) that changed are written; the rest of the catalog row is
				// preserved. The row is created if the product wasn't catalogued yet, so
				// products no longer show "Not set" after being assigned in the Route tab.
				try {
					const mapPatch = { title: effectiveTitle }
					if (hasSupplierChange) {
						mapPatch.supplier_shop = b.supplier_shop_override ?? ''
						mapPatch.supplier_stall = b.supplier_stall_override ?? ''
					}
					if (hasCharmChange) {
						mapPatch.charm_code = b.charm_code ?? ''
						mapPatch.charm_shop = b.charm_shop ?? ''
					}
					catalogChanged = !!mergeProductMapSupplierCharm(db, mapPatch)?.changed
				} catch (e) {
					console.warn('[route] product-map write-through failed:', e.message)
				}

				// The edit just re-pointed every OTHER order of this product too, so it
				// answers their Wrong Stall reports as much as this line's. Only lines
				// that inherit the default are touched (resolveWrongStallForProduct) —
				// an order pinned to its own stall is still standing at the wrong one.
				// Best-effort, like the write-through above: the operator's save must
				// stand even if the fan-out fails.
				try {
					_closeWrongStallForProduct(
						effectiveTitle,
						{
							supplier: hasSupplierChange && routeSourcing.locationMoved(productBefore, productAfter, ['supplier_shop', 'supplier_stall']),
							charm: hasCharmChange && routeSourcing.locationMoved(productBefore, productAfter, ['charm_code', 'charm_shop']),
						},
						'product-supplier',
					)
				} catch (e) {
					console.warn('[route] wrong-stall fan-out failed:', e.message)
				}
			}
		}

		// Push the change to every live shopping-route client (mobile + desktop)
		// so collaborators see it without refreshing.
		broadcastRouteEvent({
			type: 'assign',
			receipt_id: row.receipt_id,
			item_key: row.item_key,
			charm_code: row.charm_code,
			charm_shop: row.charm_shop,
			status_case: row.status_case,
			status_grip: row.status_grip,
			status_charm: row.status_charm,
			excluded: row.excluded,
			updated_at: row.updated_at,
			by: (req.auth && req.auth.user) || 'owner',
		})
		if (catalogChanged) broadcastCatalogRefresh('product-default-updated')
		// A settled model fix disappears from the correction list on every device,
		// so live clients need the same nudge the manual "done" action gives them.
		for (const exchangeId of settledFixes) {
			broadcastRouteEvent({
				type: 'exchange',
				exchange_id: exchangeId,
				receipt_id: row.receipt_id,
				status: 'done',
				by: (req.auth && req.auth.user) || 'owner',
			})
		}

		res.json({ ok: true, assignment: row, settled_model_fixes: settledFixes, resolved_wrong_stall: resolvedWrongStall })
	} catch (err) {
		console.error('[route] assign error:', err.message)
		res.status(500).json({ error: err.message })
	}
})

// ─── Online Shopping Route (mobile) API ───────────────────────────────────────
//
// A live, phone-friendly view of the SAME shopping route the desktop Route tab
// generates as Excel. It reads the exact same source of truth (buildRouteRows +
// route_assignments), so the mobile view, the desktop dashboard, and the Excel
// export can never disagree. Employees with the `shopper` role reach ONLY these
// endpoints (the `shopper` role in src/auth/policy.js). Real-time collaboration
// rides the _routeSseClients bus: every status change is pushed to all devices.

// ── Canonical product identity across shops (perceptual image hash) ──────────
// The SAME physical product is listed separately in each Etsy shop (different
// listing_id AND — as the data shows — different SEO titles), so title can't
// link them. The reliable signal is the product IMAGE. A raw byte hash only
// matches byte-identical uploads; shops often re-encode/resize, so we use a
// perceptual dHash (17×16 grayscale gradient) which is stable across encoding and
// scaling → the same design links across shops. Hashes are persisted in
// listing_phash (keyed by listing_id, invalidated when the source bytes change).

// v2 adds a second, camera-band-excluded "design" hash; bumping the version
// forces a one-time re-hash of every cached image on next boot so both hashes
// exist and stay consistent.
const PRODUCT_HASH_ALGO = 'dhash256-v2'
// Fraction of the image height (from the top) occupied by the phone's camera
// cutout, which varies by phone model for the SAME case design. The design hash
// drops this band so re-lists across models still match. 5 of 21 rows ≈ 24%.
const DESIGN_HASH_DROP_ROWS = 5

// dHash over a grid: compare each grayscale pixel to its right neighbour, reading
// `rows` rows (skipping the first `dropRows`) × 16 comparisons → 256 bits. With
// dropRows=0 this is the full-image hash; with dropRows>0 it excludes the top
// band (camera cutout) to yield a design-region hash. The 256-bit fingerprint
// keeps visual similarity robust while avoiding the original 64-bit collisions.
async function computeDHashGrid(buf, dropRows) {
	const totalRows = 16 + dropRows
	const raw = await sharp(buf).greyscale().resize(17, totalRows, { fit: 'fill' }).raw().toBuffer()
	let hash = 0n
	let bit = 0n
	for (let r = 0; r < 16; r++) {
		const row = r + dropRows
		for (let col = 0; col < 16; col++) {
			if (raw[row * 17 + col] < raw[row * 17 + col + 1]) hash |= 1n << bit
			bit++
		}
	}
	return hash.toString(16).padStart(64, '0')
}

// Full-image perceptual hash (cross-shop / byte-independent product identity).
function computeDHash(buf) {
	return computeDHashGrid(buf, 0)
}

// Design-region hash: same dHash with the top camera band dropped, so the SAME
// case design photographed on different phone models still matches.
function computeDesignHash(buf) {
	return computeDHashGrid(buf, DESIGN_HASH_DROP_ROWS)
}

// Compute + persist a listing's perceptual hash from its cached image bytes.
// Skips work when already up-to-date. Returns the phash, or null if no image.
async function ensureListingPhash(listingId) {
	const id = Number(listingId)
	if (!id) return null
	if (_listingPhashInflight.has(id)) return _listingPhashInflight.get(id)
	const promise = _ensureListingPhash(id).finally(() => {
		if (_listingPhashInflight.get(id) === promise) _listingPhashInflight.delete(id)
	})
	_listingPhashInflight.set(id, promise)
	return promise
}

const _listingPhashInflight = new Map()
async function _ensureListingPhash(listingId) {
	if (!listingId) return null
	let img
	try {
		img = db.prepare('SELECT data FROM listing_image_data WHERE listing_id = ?').get(listingId)
	} catch {
		return null
	}
	if (!img || !img.data || !img.data.length) return null
	const sha = crypto.createHash('sha256').update(img.data).digest('hex')
	const existing = db.prepare('SELECT phash, sha, algo FROM listing_phash WHERE listing_id = ?').get(listingId)
	if (existing && existing.sha === sha && existing.algo === PRODUCT_HASH_ALGO) return existing.phash
	let phash
	let designPhash
	try {
		phash = await computeDHash(img.data)
		designPhash = await computeDesignHash(img.data)
	} catch (e) {
		return existing ? existing.phash : null
	}
	db.prepare("INSERT INTO listing_phash (listing_id, phash, design_phash, sha, algo, canonical_key, computed_at) VALUES (?,?,?,?,?,NULL,strftime('%s','now')) ON CONFLICT(listing_id) DO UPDATE SET phash=excluded.phash, design_phash=excluded.design_phash, sha=excluded.sha, algo=excluded.algo, canonical_key=NULL, computed_at=excluded.computed_at").run(listingId, phash, designPhash, sha, PRODUCT_HASH_ALGO)
	return phash
}

// Background pass: hash every cached image that doesn't have a current phash.
let _phashBusy = false
async function backfillPhashes() {
	if (_phashBusy) return
	_phashBusy = true
	try {
		const ids = db
			.prepare('SELECT d.listing_id AS id FROM listing_image_data d LEFT JOIN listing_phash p ON p.listing_id = d.listing_id WHERE p.listing_id IS NULL OR p.algo IS NULL OR p.algo <> ?')
			.all(PRODUCT_HASH_ALGO)
			.map((r) => r.id)
		for (const [index, id] of ids.entries()) {
			try {
				await ensureListingPhash(id)
			} catch {
				/* keep going */
			}
			// Sharp work is CPU-heavy; yield between bounded batches so boot-time
			// hashing never monopolizes the HTTP event loop.
			if ((index + 1) % 10 === 0) await new Promise((resolve) => setImmediate(resolve))
		}
		if (ids.length) console.log(`[phash] computed ${ids.length} product image hash(es)`)
		if (ids.length) _productIdentityCoordinator.schedule('backfill', 750)
	} catch (e) {
		console.warn('[phash] backfill failed:', e.message)
	} finally {
		_phashBusy = false
	}
}

let _imageIdentityHydrationBusy = false
async function hydrateMissingProductIdentities(batchSize = 40) {
	if (_imageIdentityHydrationBusy) return
	_imageIdentityHydrationBusy = true
	let rows = []
	try {
		rows = db
			.prepare(
				`
				SELECT i.listing_id, i.url
				FROM listing_images i
				LEFT JOIN listing_image_data d ON d.listing_id = i.listing_id
				WHERE d.listing_id IS NULL
				  AND i.url IS NOT NULL
				  AND trim(i.url) <> ''
				ORDER BY i.listing_id
				LIMIT ?
			`,
			)
			.all(batchSize)
		if (rows.length) {
			const images = new Map(rows.map((r) => [r.listing_id, r.url]))
			await batchFetchRouteImages(db, images)
			for (const row of rows) await ensureListingPhash(row.listing_id)
			// Trailing debounce spans adjacent 3-second hydration batches, so a long
			// boot hydration produces one full O(n²) reconciliation, not one per batch.
			_productIdentityCoordinator.schedule('hydration', 5000)
			console.log(`[phash] hydrated ${rows.length} missing catalog image identity/identities`)
		}
	} catch (e) {
		console.warn('[phash] image identity hydration failed:', e.message)
	} finally {
		_imageIdentityHydrationBusy = false
	}
	// Work in bounded batches so startup remains responsive.
	if (rows.length === batchSize) setTimeout(() => hydrateMissingProductIdentities(batchSize).catch(() => {}), 3000)
}

// Perceptual-hash distance + the same-product decision logic live in the shared
// pure module (one source of truth for the server, scripts, and the test).
const { phashDistance } = productSimilarity

// Gather every DETERMINISTIC same-product token for the given listings — facts
// the rest of the system already treats as one product, namespaced so the
// resolver (and its log line) can tell them apart:
//   • `title:<normalised title>` — product_map keys supplier/charm/cost by this
//     exact string and enforces it UNIQUE, so two listings sharing it ARE one
//     catalog product. Without this edge that product can render as two cards
//     quoting two different prices, which is simply inconsistent.
//   • `folder:<source folder>` — the bulk lister creates a listing FROM a design
//     folder, so two listings built from the same folder are the same product by
//     construction (this is how one design reaches several shops).
// Both are read defensively: a missing table just yields fewer tokens.
function collectProductIdentityTokens(listingIds) {
	const tokens = new Map() // listing_id → string[]
	const wanted = listingIds instanceof Set ? listingIds : new Set(listingIds.map(Number))
	const add = (listingId, token) => {
		const id = Number(listingId)
		if (!wanted.has(id) || !token) return
		if (!tokens.has(id)) tokens.set(id, [])
		const list = tokens.get(id)
		if (!list.includes(token)) list.push(token)
	}
	const addTitle = (listingId, title) => {
		const norm = routeDashboard.normalizeTitle(title || '')
		if (norm) add(listingId, `title:${norm}`)
	}
	try {
		db.prepare("SELECT DISTINCT listing_id, title FROM transactions WHERE listing_id IS NOT NULL AND title IS NOT NULL AND trim(title) <> ''")
			.all()
			.forEach((r) => addTitle(r.listing_id, r.title))
	} catch (e) {
		console.warn('[phash] transaction titles unavailable for identity:', e.message)
	}
	try {
		db.prepare("SELECT listing_id, title FROM listings WHERE listing_id IS NOT NULL AND title IS NOT NULL AND trim(title) <> ''")
			.all()
			.forEach((r) => addTitle(r.listing_id, r.title))
	} catch {
		/* listings table may not exist on an older install */
	}
	try {
		db.prepare("SELECT listing_id, product_folder FROM bulk_job_items WHERE listing_id IS NOT NULL AND product_folder IS NOT NULL AND trim(product_folder) <> ''")
			.all()
			.forEach((r) => add(r.listing_id, `folder:${r.product_folder}`))
	} catch {
		/* bulk_job_items may not exist on an older install */
	}
	return tokens
}

// Persist a durable canonical product identity. The decision logic itself lives
// in the shared pure module (src/route/product-similarity.js), which composes,
// in increasing order of authority: the guarded VISUAL heuristic, DETERMINISTIC
// same-product tokens (shared catalog title / bulk source folder), and FORCED
// operator merges from product_merges. This function only does the DB I/O —
// gather the signals, run the resolver, write the keys back, and reconcile the
// catalog facts that hang off a product identity.
function reconcileCanonicalProductKeys() {
	try {
		const rows = db.prepare('SELECT listing_id, phash, design_phash, canonical_key, computed_at FROM listing_phash WHERE algo = ? ORDER BY listing_id').all(PRODUCT_HASH_ALGO)
		if (!rows.length) return { groups: 0, updated: 0 }

		const productByTitle = new Map()
		db.prepare("SELECT title_norm, stall FROM product_map WHERE status = 'active'")
			.all()
			.forEach((r) =>
				productByTitle.set(
					r.title_norm,
					String(r.stall || '')
						.replace(/\s+/g, '')
						.toUpperCase(),
				),
			)
		const stallsByListing = new Map()
		// One representative title per listing, so a near-miss visual match can be
		// corroborated by title similarity inside the resolver.
		const titleByListing = new Map()
		db.prepare('SELECT DISTINCT listing_id, title FROM transactions WHERE listing_id IS NOT NULL')
			.all()
			.forEach((r) => {
				const lid = Number(r.listing_id)
				if (!titleByListing.has(lid) && r.title) titleByListing.set(lid, r.title)
				const stall = productByTitle.get(routeDashboard.normalizeTitle(r.title))
				if (!stall) return
				if (!stallsByListing.has(lid)) stallsByListing.set(lid, new Set())
				stallsByListing.get(lid).add(stall)
			})

		const identityTokens = collectProductIdentityTokens(rows.map((r) => Number(r.listing_id)))
		const resolved = productSimilarity.resolveProductIdentity({
			listings: rows.map((row) => ({
				listing_id: Number(row.listing_id),
				phash: row.phash,
				designPhash: row.design_phash,
				title: titleByListing.get(Number(row.listing_id)),
				stalls: stallsByListing.get(Number(row.listing_id)),
				identityKeys: identityTokens.get(Number(row.listing_id)),
			})),
			forcedPairs: productMerges.getMergeEdges(db),
		})

		const update = db.prepare('UPDATE listing_phash SET canonical_key = ? WHERE listing_id = ?')
		let updated = 0
		const tx = db.transaction(() => {
			for (const row of rows) {
				const key = resolved.keyByListing.get(Number(row.listing_id))
				if (!key || row.canonical_key === key) continue
				update.run(key, row.listing_id)
				updated++
			}
		})
		tx()
		if (updated) {
			const s = resolved.stats
			console.log(`[phash] canonical identity: ${updated} key(s) updated across ${resolved.groups.length} product(s) — ${s.visual} visual, ${s.deterministic} deterministic, ${s.operator} operator edge(s)`)
		}

		// Attach the same canonical key to every title alias in product_map. This
		// makes the identity visible to the Product Catalog and survives Excel
		// export/import instead of living only in the shopping UI.
		db.exec(`
			UPDATE product_map
			SET canonical_product_key = (
				SELECT lp.canonical_key
				FROM transactions t
				JOIN listing_phash lp ON lp.listing_id = t.listing_id
				WHERE lower(trim(replace(t.title, '|', ','))) = product_map.title_norm
				  AND lp.canonical_key IS NOT NULL
				ORDER BY t.transaction_id DESC
				LIMIT 1
			)
			WHERE EXISTS (
				SELECT 1
				FROM transactions t
				JOIN listing_phash lp ON lp.listing_id = t.listing_id
				WHERE lower(trim(replace(t.title, '|', ','))) = product_map.title_norm
				  AND lp.canonical_key IS NOT NULL
			)
		`)
		// Robust whitespace/case normalization pass (SQLite cannot collapse
		// arbitrary whitespace like routeDashboard.normalizeTitle does).
		const keyByTitleNorm = new Map()
		db.prepare('SELECT t.title, lp.canonical_key FROM transactions t JOIN listing_phash lp ON lp.listing_id = t.listing_id WHERE lp.canonical_key IS NOT NULL')
			.all()
			.forEach((r) => {
				const n = routeDashboard.normalizeTitle(r.title)
				if (n && !keyByTitleNorm.has(n)) keyByTitleNorm.set(n, r.canonical_key)
			})
		const setProductCanonical = db.prepare('UPDATE product_map SET canonical_product_key = ? WHERE title_norm = ?')
		const setProductKeys = db.transaction(() => {
			for (const [titleNorm, key] of keyByTitleNorm) setProductCanonical.run(key, titleNorm)
		})
		setProductKeys()

		// Reconcile shared catalog facts across title aliases of one physical
		// product. Fill blanks only — never silently overwrite an operator's
		// explicit conflicting supplier/charm/cost choice.
		const aliases = db
			.prepare(
				"SELECT id, canonical_product_key, shop_name, stall, charm_shop, charm_code, cost_case, cost_grip FROM product_map WHERE canonical_product_key IS NOT NULL AND status = 'active'",
			)
			.all()
		const byCanonical = new Map()
		for (const row of aliases) {
			if (!byCanonical.has(row.canonical_product_key)) byCanonical.set(row.canonical_product_key, [])
			byCanonical.get(row.canonical_product_key).push(row)
		}
		const aliasUpdate = db.prepare(`
			UPDATE product_map SET
				shop_name = CASE WHEN trim(COALESCE(shop_name,'')) = '' THEN @shop_name ELSE shop_name END,
				stall = CASE WHEN trim(COALESCE(stall,'')) = '' THEN @stall ELSE stall END,
				charm_shop = CASE WHEN trim(COALESCE(charm_shop,'')) = '' THEN @charm_shop ELSE charm_shop END,
				charm_code = CASE WHEN trim(COALESCE(charm_code,'')) = '' THEN @charm_code ELSE charm_code END,
				cost_case = COALESCE(cost_case, @cost_case),
				cost_grip = COALESCE(cost_grip, @cost_grip)
			WHERE id = @id
		`)
		const firstValue = (members, field) => {
			const hit = members.find((m) => m[field] !== null && String(m[field]).trim() !== '')
			return hit ? hit[field] : null
		}
		const syncAliases = db.transaction(() => {
			for (const members of byCanonical.values()) {
				const shared = {
					shop_name: firstValue(members, 'shop_name') || '',
					stall: firstValue(members, 'stall') || '',
					charm_shop: firstValue(members, 'charm_shop') || '',
					charm_code: firstValue(members, 'charm_code') || '',
					cost_case: firstValue(members, 'cost_case'),
					cost_grip: firstValue(members, 'cost_grip'),
				}
				for (const member of members) aliasUpdate.run({ id: member.id, ...shared })
			}
		})
		syncAliases()
		return { groups: resolved.groups.length, updated }
	} catch (e) {
		console.warn('[phash] canonical reconciliation failed:', e.message)
		return { groups: 0, updated: 0 }
	}
}

const _productIdentityCoordinator = new ProductIdentityCoordinator({
	reconcile: () => reconcileCanonicalProductKeys(),
	onResult: (result, reasons) => {
		const hasBackgroundReason = reasons.some((reason) => !String(reason).startsWith('operator-'))
		if (result.updated && hasBackgroundReason) {
			broadcastCatalogRefresh('identity-reconciled')
		}
	},
})

/**
 * GET /api/shop/route
 * The active shopping list. Returns every line that still needs attention
 * (pending / partially bought), grouped client-side by supplier floor → shop →
 * stall, plus a small summary. Query: date_from, date_to, shop_id, include_shipped.
 */
app.get('/api/shop/route', (req, res) => {
	try {
		const rows = routeDashboard.buildRouteRows(db, config, {
			date_from: req.query.date_from,
			date_to: req.query.date_to,
			shop_id: req.query.shop_id,
			include_shipped: req.query.include_shipped === 'true',
			// Pre-transit + "needs purchase" orders must reliably appear for the shopper.
			include_needs_purchase: true,
			// The whole point of the mobile view is supplier/stall/charm context.
			enrich_supplier: true,
			// Never show durably-removed lines on the shopping floor.
			include_dismissed: false,
		})

		// Lines a shopper can act on: not operator-excluded. A SWAP model fix holds
		// only its CASE out of buying (we already have it — it's carried back and
		// swapped in person, and surfaced separately in `exchanges` below); the
		// grip/charm on the SAME line still have to be bought, so we PROJECT the row
		// down to just its still-buyable pieces instead of dropping the whole line.
		// A pure case-only swap projects to null (nothing left to buy) and drops out.
		// A BUY model fix keeps every piece and the projection rewrites `phone_model`
		// to the CORRECTED model, so the card on the floor names the case to get.
		const live = rows
			.filter((r) => !r.excluded)
			.map((r) => routeDashboard.rowShoppingProjection(r))
			.filter(Boolean)
		const remaining = live.filter((r) => !r.fully_purchased)
		const summary = {
			items: remaining.length,
			orders: new Set(remaining.map((r) => r.receipt_id)).size,
			purchased: live.filter((r) => r.fully_purchased).length,
			total_items: live.length,
		}

		// Charm-shop → stall location, so charm groups can show WHERE to buy the
		// charm (parity with the case/grip supplier location).
		const charmLoc = new Map()
		try {
			getCharmShopDirectory(db).forEach((c) => {
				const k = String(c.shop_name || '')
					.trim()
					.toLowerCase()
				if (k && !charmLoc.has(k)) charmLoc.set(k, c.stall || '')
			})
		} catch (e) {
			console.warn('[shop] charm-shop directory load failed:', e.message)
		}

		// Purchase costs: case/grip price per product (product_map), charm price per
		// code (charm_library). Shown on the route so the shopper can pay the stall
		// (WeChat) without asking. Keyed by normalised title / charm code.
		const productCost = new Map()
		const canonicalCost = new Map()
		const charmCost = new Map()
		try {
			db.prepare('SELECT title_norm, cost_case, cost_grip, canonical_product_key FROM product_map WHERE cost_case IS NOT NULL OR cost_grip IS NOT NULL OR canonical_product_key IS NOT NULL')
				.all()
				.forEach((r) => {
					productCost.set(r.title_norm, r)
					if (r.canonical_product_key && (r.cost_case != null || r.cost_grip != null)) {
						const current = canonicalCost.get(r.canonical_product_key) || {}
						canonicalCost.set(r.canonical_product_key, {
							cost_case: current.cost_case ?? r.cost_case ?? null,
							cost_grip: current.cost_grip ?? r.cost_grip ?? null,
						})
					}
				})
			db.prepare('SELECT code, cost FROM charm_library WHERE cost IS NOT NULL')
				.all()
				.forEach((r) => charmCost.set(r.code, r.cost))
		} catch (e) {
			console.warn('[shop] cost load failed:', e.message)
		}

		// Per-charm image version (mtime+size) so the mobile page builds
		// content-addressed charm-image URLs that self-invalidate when a charm
		// photo is replaced/renamed/renumbered — no stale thumbnails on the floor.
		let charmImgVer = new Map()
		try {
			charmImgVer = charmLibrary.charmImageVersionMap(db, config)
		} catch (e) {
			console.warn('[shop] charm image version load failed:', e.message)
		}

		// Perceptual-hash map (listing_id → phash) for cross-shop product unifying,
		// plus the set of listings whose image bytes are already cached.
		const phashMap = new Map()
		const cachedImg = new Set()
		try {
			db.prepare('SELECT listing_id, canonical_key, phash FROM listing_phash WHERE algo = ?')
				.all(PRODUCT_HASH_ALGO)
				.forEach((r) => phashMap.set(r.listing_id, r.canonical_key || `p:${r.phash}`))
			db.prepare('SELECT listing_id FROM listing_image_data')
				.all()
				.forEach((r) => cachedImg.add(r.listing_id))
		} catch (e) {
			console.warn('[shop] phash load failed:', e.message)
		}

		// Send ONLY the fields the mobile page uses — a much smaller payload than the
		// full desktop row (drops buyer/notes/exchange/issue/supplier-price/etc.),
		// so it loads noticeably faster over cellular. Product images are proxied
		// through /api/route/listing-image (same-origin) so the service worker can
		// cache them without tripping connect-src.
		const lean = live.map((r) => {
			const cs = String(r.charm_shop || '').trim()
			const charmStall = cs ? charmLoc.get(cs.toLowerCase()) || '' : ''
			const tn = routeDashboard.normalizeTitle
				? routeDashboard.normalizeTitle(r.title)
				: String(r.title || '')
						.trim()
						.toLowerCase()
			const cc = String(r.charm_code || '').trim()
			const pc = productCost.get(tn)
			// Canonical product key: same product IMAGE across shops → same key
			// (unifies cross-shop duplicates whose titles differ). Falls back to the
			// normalised title until the image is cached + hashed (self-healed below).
			//
			// Keyed by the listing this line is BOUGHT as. Using the ORDERED listing
			// would hand a switched line the identity of the design it was switched
			// AWAY from whenever the replacement isn't hashed yet, merging it onto
			// that product's card — exactly the mix-up buildRouteRows works to
			// prevent (a custom switch has no listing, so it merges by title).
			const canonicalKey = r.product_listing_id ? phashMap.get(r.product_listing_id) : null
			const productKey = r.product_key || canonicalKey || (pc && pc.canonical_product_key) || 't:' + tn
			const sharedCost = canonicalCost.get(productKey)
			return {
				receipt_id: r.receipt_id,
				item_key: r.item_key,
				title: r.title,
				product_key: productKey,
				// The Etsy listing behind this line. Needed on the floor so the shopper
				// can declare "these two cards are the same product" (product_merges)
				// when two shops photographed one product differently and no automatic
				// signal can link them.
				listing_id: r.listing_id,
				// The listing whose design/image is actually being purchased. This can
				// differ from listing_id after a catalog design switch and is captured
				// in the employee's activity snapshot so it keeps the correct product
				// identity instead of falling back to the design that was replaced.
				product_listing_id: r.product_listing_id,
				quantity: r.quantity,
				// Already the CORRECTED model when a model fix applies (the projection
				// above rewrote it), so the card on the floor always names the case to
				// actually buy. `ordered_phone_model` is sent only when the two differ,
				// so the shopper can see WHY it disagrees with the Etsy order.
				phone_model: r.phone_model,
				ordered_phone_model: r.ordered_phone_model && r.ordered_phone_model !== r.phone_model ? r.ordered_phone_model : '',
				style: r.style,
				image_url: shopRouteImageUrl(r),
				has_case: r.has_case,
				has_grip: r.has_grip,
				has_charm: r.has_charm,
				// Charm ships attached to the product (AirPods case) — shopped with
				// the case at its supplier, not sourced at a charm stall. Lets the
				// mobile view treat it exactly like a grip (no code / image / stall).
				charm_integral: !!r.charm_integral,
				status_case: r.status_case,
				status_grip: r.status_grip,
				status_charm: r.status_charm,
				charm_code: r.charm_code,
				charm_image_version: cc ? charmImgVer.get(cc) || '' : '',
				charm_shop: r.charm_shop,
				charm_stall: charmStall,
				charm_floor: charmStall && routeDashboard.stallFloor ? routeDashboard.stallFloor(charmStall) : null,
				supplier_shop: r.supplier_shop,
				supplier_stall: r.supplier_stall,
				supplier_floor: r.supplier_floor,
				is_pre_transit: r.is_pre_transit,
				// Purchase costs (null = not priced yet): case & grip priced separately
				// at the supplier stall; charm at the charm stall.
				cost_case: sharedCost && sharedCost.cost_case != null ? sharedCost.cost_case : pc && pc.cost_case != null ? pc.cost_case : null,
				cost_grip: sharedCost && sharedCost.cost_grip != null ? sharedCost.cost_grip : pc && pc.cost_grip != null ? pc.cost_grip : null,
				charm_cost: cc && charmCost.has(cc) ? charmCost.get(cc) : null,
			}
		})

		// ── Open swaps (wrong-model items still owed at a stall) ───────────────
		// These are the cases we already HAVE but in the wrong model and must carry
		// back to the stall to swap. Pulled from the model-fix table (all OPEN,
		// regardless of order date). An item is exchanged WHERE IT WAS BOUGHT, so we
		// resolve each one's supplier the SAME way the buy list does — by enriching
		// the underlying order lines (route override → product default → product map
		// → catalog). This fixes swaps landing under "Supplier not set".
		//
		// Restricted to SWAPs. A BUY model fix has nothing to carry: it is already
		// in `rows` above as an ordinary purchase naming the corrected model, and
		// listing it here too would show the shopper the same case twice — once to
		// buy, once to "swap" an item they do not have.
		let exchanges = []
		try {
			const openEx = db
				.prepare("SELECT * FROM order_exchanges WHERE status = 'open'")
				.all()
				.filter((e) => routeDashboard.exchangeRecordIntent(e) === routeDashboard.EXCHANGE_INTENT_SWAP)

			// Enrich the underlying order lines to learn each product's supplier.
			let enriched = []
			const exReceiptIds = [...new Set(openEx.map((e) => Number(e.receipt_id)).filter(Number.isInteger))]
			if (exReceiptIds.length) {
				try {
					enriched = routeDashboard.buildRouteRows(db, config, {
						receipt_ids: exReceiptIds,
						enrich_supplier: true,
						include_dismissed: true,
						include_issues: true,
					})
				} catch (e2) {
					console.warn('[shop] exchange supplier enrich failed:', e2.message)
				}
			}
			const supByKey = new Map()
			enriched.forEach((r) => supByKey.set(r.receipt_id + '\x00' + r.item_key, r))
			// Fallback lookup by receipt + normalised title when the item_key differs.
			const norm = (s) =>
				routeDashboard.normalizeTitle
					? routeDashboard.normalizeTitle(s || '')
					: String(s || '')
							.trim()
							.toLowerCase()
			const findEnriched = (e) => {
				const exact = supByKey.get(e.receipt_id + '\x00' + e.item_key)
				if (exact) return exact
				const nt = norm(e.title)
				return enriched.find((r) => r.receipt_id === e.receipt_id && norm(r.title) === nt) || null
			}

			const exLids = [...new Set(openEx.map((e) => e.listing_id).filter(Boolean))]
			const exImg = {}
			if (exLids.length) {
				const ph = exLids.map(() => '?').join(',')
				db.prepare(`SELECT listing_id, url FROM listing_images WHERE listing_id IN (${ph})`)
					.all(exLids)
					.forEach((r) => {
						exImg[r.listing_id] = r.url
					})
			}
			exchanges = openEx.map((e) => {
				const enr = findEnriched(e)
				// Prefer the enriched order line's photo: it is design-switch aware, so a
				// swap on a switched line shows the REPLACEMENT — which is the item the
				// shopper is physically carrying back to the stall. Only when the line
				// can't be enriched do we fall back to the exchange record's own listing.
				const swapImage = enr && enr.image_url ? { product_listing_id: enr.product_listing_id, image_url: enr.image_url } : { product_listing_id: e.listing_id || null, image_url: e.listing_id ? exImg[e.listing_id] || null : null }
				// Prefer an explicit exchange location, else the product's supplier.
				const shop = e.supplier_shop || (enr && enr.supplier_shop) || ''
				const stall = e.supplier_stall || (enr && enr.supplier_stall) || ''
				let floor = null
				if (e.supplier_stall) floor = routeDashboard.stallFloor ? routeDashboard.stallFloor(e.supplier_stall) : null
				else if (enr && enr.supplier_floor != null) floor = enr.supplier_floor
				else if (stall) floor = routeDashboard.stallFloor ? routeDashboard.stallFloor(stall) : null
				return {
					exchange_id: e.id,
					receipt_id: e.receipt_id,
					item_key: e.item_key,
					title: e.title || (enr && enr.title) || '',
					have_model: e.have_model || '',
					need_model: e.need_model || (enr && enr.phone_model) || '',
					components: e.components || '',
					// Lets the swap card name "Case + attached charm" on AirPods instead
					// of always printing "Case" (correct for iPhone, wrong when the charm
					// ships attached and is part of the same physical swap).
					charm_integral: !!(enr && enr.charm_integral),
					has_case: enr ? !!enr.has_case : true,
					has_charm: enr ? !!enr.has_charm : false,
					note: e.note || '',
					supplier_shop: shop,
					supplier_stall: stall,
					supplier_floor: floor,
					image_url: shopRouteImageUrl(swapImage),
				}
			})
		} catch (e) {
			console.warn('[shop] exchanges load failed:', e.message)
		}

		// Listings whose product identity came from an operator "same product"
		// declaration rather than an automatic signal, so the UI can offer to UNDO
		// exactly those merges (and nothing else).
		let manualMergeListings = []
		try {
			const ids = new Set()
			for (const edge of productMerges.getMergeEdges(db)) {
				ids.add(Number(edge.listing_a))
				ids.add(Number(edge.listing_b))
			}
			manualMergeListings = [...ids]
		} catch (e) {
			console.warn('[shop] merge edges load failed:', e.message)
		}

		res.json({
			ok: true,
			rows: lean,
			exchanges,
			summary,
			statuses: routeDashboard.STATUS_OPTIONS,
			manual_merge_listings: manualMergeListings,
			server_time: Date.now(),
		})

		// ── Self-heal cross-shop product unifying (after responding) ───────────
		// For any route line whose image isn't cached/hashed yet: fetch+cache the
		// image, then compute its perceptual hash. Next load, same-image products
		// across shops collapse into one card. Fire-and-forget; never blocks.
		try {
			const needImg = new Map()
			const needHash = []
			for (const r of live) {
				// Cache and hash the listing whose photo this row actually SHOWS. On a
				// switched line that is the REPLACEMENT, not the ordered listing —
				// keying by the latter filed the replacement's bytes under the original
				// listing, poisoning its thumbnail and its perceptual hash for every
				// other order of that design.
				const lid = r.product_listing_id
				if (!lid) continue
				// Only a CDN url is fetchable. Rows already served from one of our own
				// /api/route/* endpoints (uploaded switch photo, operator Fix Image,
				// style-variation photo) have no remote source to download.
				const cdnUrl = typeof r.image_url === 'string' && /^https?:\/\//i.test(r.image_url) ? r.image_url : null
				if (!cachedImg.has(lid) && cdnUrl) needImg.set(lid, cdnUrl)
				else if (!phashMap.has(lid)) needHash.push(lid)
			}
			if (needImg.size || needHash.length) {
				;(async () => {
					try {
						if (needImg.size) await batchFetchRouteImages(db, needImg)
					} catch (e) {
						console.warn('[shop] image cache (self-heal) failed:', e.message)
					}
					for (const id of new Set([...needImg.keys(), ...needHash])) {
						try {
							await ensureListingPhash(id)
						} catch {
							/* keep going */
						}
					}
					_productIdentityCoordinator.schedule('shop-self-heal', 750)
				})()
			}
		} catch (e) {
			/* self-heal is best-effort */
		}
	} catch (err) {
		console.error('[shop] route error:', err.message)
		res.status(500).json({ error: err.message })
	}
})

/**
 * GET /api/shop/stream
 * Server-Sent Events feed of live purchase-status changes. Every connected
 * phone/desktop gets a push whenever anyone updates a line, so the team stays
 * in sync without polling or double-buying.
 */
app.get('/api/shop/stream', (req, res) => {
	res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
	// `no-transform` tells Cloudflare / proxies NOT to buffer or modify the stream
	// (the fix for the tunnel hanging in "connecting"); `identity` prevents any
	// compression that would buffer it.
	res.setHeader('Cache-Control', 'no-cache, no-transform')
	res.setHeader('Connection', 'keep-alive')
	res.setHeader('X-Accel-Buffering', 'no')
	res.setHeader('Content-Encoding', 'identity')
	res.flushHeaders()

	// A ~2KB comment padding forces intermediary buffers (Cloudflare Tunnel, mobile
	// carrier proxies) to flush immediately, so the browser's EventSource fires
	// `onopen` right away instead of hanging while the edge waits to fill a buffer.
	res.write(':' + ' '.repeat(2048) + '\n\n')
	// Tell the client how fast to reconnect if the link drops.
	res.write('retry: 3000\n\n')
	res.write(`data: ${JSON.stringify({ type: 'connected', server_time: Date.now() })}\n\n`)

	// Heartbeat keeps mobile connections alive through proxies / Cloudflare Tunnel
	// and lets the client detect a dropped link quickly. 15s is well under the
	// typical 100s idle-timeout of carrier/CDN proxies.
	const keepAlive = setInterval(() => {
		try {
			res.write(': keep-alive\n\n')
		} catch {}
	}, 15000)

	_routeSseClients.add(res)
	req.on('close', () => {
		clearInterval(keepAlive)
		_routeSseClients.delete(res)
	})
})

/**
 * POST /api/shop/assign
 * The mobile shopper's ONE mutation: set a component's purchase status.
 * Body: { receipt_id, item_key, title?, status_case?, status_grip?, status_charm? }
 * Deliberately narrower than /api/route/assign — a shopper can only move
 * purchase statuses (Case / Grip / Charm), never edit suppliers, charms,
 * exclusions, or manual items. Broadcasts the change to all live clients.
 */
app.post('/api/shop/assign', express.json(), (req, res) => {
	const b = req.body ?? {}
	if (b.receipt_id == null || !b.item_key) {
		return res.status(400).json({ error: 'receipt_id and item_key are required.' })
	}
	const receiptId = Number(b.receipt_id)
	if (!Number.isInteger(receiptId)) {
		return res.status(400).json({ error: 'receipt_id must be an integer.' })
	}
	// A queued offline write may have been minted by an older page that still held
	// a pre-variant alias. Canonicalise before EVERY side effect so the purchase,
	// issue bridge, model-fix settlement, SSE event and audit snapshot all address
	// the same durable order line rather than creating an invisible ghost row.
	const itemKey = lineIdentity.canonicalLineKey(db, receiptId, b.item_key)
	b.receipt_id = receiptId
	b.item_key = itemKey
	const validStatus = (v) => v == null || routeDashboard.STATUS_OPTIONS.includes(v)
	if (!validStatus(b.status_case) || !validStatus(b.status_grip) || !validStatus(b.status_charm)) {
		return res.status(400).json({ error: 'Invalid status value.' })
	}
	if (b.status_case == null && b.status_grip == null && b.status_charm == null) {
		return res.status(400).json({ error: 'Provide at least one status to update.' })
	}
	try {
		let row
		let issueSync = null
		let settledFixes = []
		// Persist the status, issue bridge, model-fix settlement and order rollup as
		// one atomic unit. A failed auxiliary update now leaves the durable queue in
		// place for retry instead of acknowledging a partially-applied tap.
		db.transaction(() => {
			row = upsertRouteAssignment(db, {
				receipt_id: receiptId,
				item_key: itemKey,
				title: b.title,
				status_case: b.status_case,
				status_grip: b.status_grip,
				status_charm: b.status_charm,
			})
			// If the shopper moved any component OFF 'Purchased', a prior packer
			// verification of this line is now stale — clear it so the two-person
			// gate can't pass on out-of-hand stock.
			if ([b.status_case, b.status_grip, b.status_charm].some((s) => s != null && s !== 'Purchased')) {
				clearRouteVerified(db, row.receipt_id, row.item_key)
			}
			issueSync = syncAssignmentIssue(row.receipt_id, row.item_key)
			// Mobile purchasing must settle BUY-shaped model fixes exactly like the
			// desktop Route and Orders component-status paths.
			settledFixes = settleBoughtModelFixes(row.receipt_id, row.item_key)
			recomputeNeedsPurchaseRollup(receiptId)
		})()
		if (issueSync) {
			console.log(`[shop] issue ${issueSync.action}${issueSync.issue_type ? ' (' + issueSync.issue_type + ')' : ''} for receipt ${row.receipt_id} line ${row.item_key}`)
		}

		broadcastRouteEvent({
			type: 'assign',
			receipt_id: row.receipt_id,
			item_key: row.item_key,
			charm_code: row.charm_code,
			charm_shop: row.charm_shop,
			status_case: row.status_case,
			status_grip: row.status_grip,
			status_charm: row.status_charm,
			excluded: row.excluded,
			updated_at: row.updated_at,
			by: (req.auth && req.auth.user) || 'shopper',
		})
		for (const exchangeId of settledFixes) {
			broadcastRouteEvent({
				type: 'exchange',
				exchange_id: exchangeId,
				receipt_id: row.receipt_id,
				status: 'done',
				by: (req.auth && req.auth.user) || 'shopper',
			})
		}

		res.json({ ok: true, assignment: row, settled_model_fixes: settledFixes })
	} catch (err) {
		console.error('[shop] assign error:', err.message)
		res.status(500).json({ error: err.message })
	}
})

/**
 * POST /api/shop/cost
 * Set the purchase cost of a product component or a charm, so the shopper can pay
 * the supplier without asking. Case & grip are priced separately. Body:
 *   { kind: 'product', title, part: 'case'|'grip', cost }  → product_map.cost_<part>
 *   { kind: 'charm',   code,  cost }                        → charm_library.cost
 * cost may be a number ≥ 0, or null/'' to clear. Broadcasts so every device
 * updates its prices + stall subtotals live.
 */
app.post('/api/shop/cost', express.json(), (req, res) => {
	const b = req.body ?? {}
	const kind = b.kind
	if (kind !== 'product' && kind !== 'charm') {
		return res.status(400).json({ error: "kind must be 'product' or 'charm'." })
	}
	if (b.cost != null && b.cost !== '' && (!Number.isFinite(Number(b.cost)) || Number(b.cost) < 0)) {
		return res.status(400).json({ error: 'cost must be a non-negative number (or empty to clear).' })
	}
	try {
		let result
		let part
		if (kind === 'product') {
			if (!b.title) return res.status(400).json({ error: 'title is required.' })
			part = b.part === 'grip' ? 'grip' : 'case'
			result = setProductCost(db, { title: b.title, [part === 'grip' ? 'cost_grip' : 'cost_case']: b.cost })
		} else {
			if (!b.code) return res.status(400).json({ error: 'code is required.' })
			result = setCharmCost(db, { code: b.code, cost: b.cost })
		}
		broadcastRouteEvent({
			type: 'cost',
			kind,
			part: kind === 'product' ? part : undefined,
			title: kind === 'product' ? String(b.title) : undefined,
			code: kind === 'charm' ? result.code : undefined,
			cost: kind === 'product' ? (part === 'grip' ? result.cost_grip : result.cost_case) : result.cost,
			by: (req.auth && req.auth.user) || 'shopper',
		})
		broadcastCatalogRefresh(kind === 'product' ? 'product-cost-updated' : 'charm-cost-updated')
		res.json({ ok: true, ...result })
	} catch (err) {
		console.error('[shop] cost error:', err.message)
		res.status(err.code === 'REQUIRED' ? 400 : 500).json({ error: err.message })
	}
})

/**
 * GET /api/route/floor-map
 * Returns the recorded physical floor layout (corridors → sides → blocks →
 * stalls) for the in-person Map view. Each stall is enriched with the
 * authoritative shop name from supplier_directory (falling back to the recorded
 * name), plus a normalised code the client uses to match live route stalls.
 */
app.get('/api/route/floor-map', (req, res) => {
	try {
		// Authoritative shop name per normalised stall (first wins).
		const byStall = new Map()
		try {
			getSupplierDirectory(db).forEach((s) => {
				const k = normalizeStallCode(s.stall)
				if (k && s.shop_name && !byStall.has(k)) byStall.set(k, String(s.shop_name).trim())
			})
		} catch (e) {
			console.warn('[floor-map] supplier directory load failed:', e.message)
		}
		const floors = FLOOR_MAPS.map((f) => ({
			mall: f.mall,
			floor: f.floor,
			label: f.label,
			landmarks: f.landmarks || [],
			corridors: f.corridors.map((c) => ({
				id: c.id,
				label: c.label,
				sides: c.sides.map((sd) => ({
					id: sd.id,
					label: sd.label,
					blocks: sd.blocks.map((blk) =>
						blk.map((st) => {
							const norm = normalizeStallCode(st.code)
							const aliases = stallCodeAliases(st.code)
							const dirName = aliases.map((alias) => byStall.get(alias)).find(Boolean)
							// The on-site recording is ground truth for the physical map, so a
							// recorded name wins over the catalog directory (which can carry a
							// stall's OLD tenant, e.g. A209 had both 也壳 and 舒克). The directory
							// only fills in stalls we didn't name on-site.
							const name = (st.name || dirName || '').trim()
							return { code: st.code, norm, aliases, name, named: !!name }
						}),
					),
				})),
			})),
		}))
		res.json({ floors })
	} catch (err) {
		console.error('[floor-map] error:', err.message)
		res.status(500).json({ error: err.message })
	}
})

/**
 * GET /api/route/charm-progress
 * Returns { charm_code: purchased_qty } for the "Charms to Buy" list, so the UI
 * can show purchased vs. still-to-buy quantities per charm code.
 */
app.get('/api/route/charm-progress', (req, res) => {
	try {
		res.json({ ok: true, progress: getCharmPurchaseProgress(db) })
	} catch (err) {
		console.error('[route] charm-progress GET error:', err.message)
		res.status(500).json({ error: err.message })
	}
})

/**
 * GET /api/route/charms-to-buy
 * A self-contained bundle powering the "Charms to Buy" list for the buy queue:
 * the charm-bearing route rows, the charm catalog, the charm-shop directory, and
 * the per-charm purchase progress — everything the client aggregation needs in a
 * SINGLE round-trip.
 *
 * WHY a dedicated endpoint (vs. reusing /api/route/dashboard + /charms +
 * /charm-progress): those three are the owner's full purchasing planner and are
 * NOT on the packer allowlist. Packing Mode's "Need to purchase" tab needs the
 * same charm shopping list, so we expose ONLY the charm/purchase/supplier data
 * (never revenue) through one packer-safe route. Employees persist status changes
 * through the already-allowed per-item component-status endpoint, so this stays
 * read-only for them.
 *
 * SCOPE — the reason this endpoint resolves its own receipt set instead of
 * reusing the Route dashboard's default one: the list is opened FROM the
 * "Need to purchase" tab, so its totals have to reconcile against the orders on
 * that screen. It therefore takes the tab's EXACT order set (the 'all' sub-filter
 * = still-to-buy ∪ on-hold, dedup-suppressed, unpackaged, paid) from the shared
 * buy-queue module, then keeps only the charm lines an employee can actually go
 * and buy (isCharmShoppingRow). Previously it used the Route dashboard's 30-day
 * pending scope, which also swept in orders that were already fully purchased —
 * so the header read "18 pcs total" while the tab held only 13.
 *
 * The response carries a `scope` block so the count on screen can always be
 * traced back to the orders that produced it.
 */
app.get('/api/route/charms-to-buy', (req, res) => {
	try {
		const receiptIds = buyQueue.needsPurchaseReceiptIds(db, config, {
			npFilter: 'all',
			suppressedReceiptIds: computeSuppressedDuplicates().suppressed,
		})
		const rows = routeDashboard
			.buildRouteRows(db, config, {
				receipt_ids: [...receiptIds],
				enrich_supplier: true,
				include_dismissed: false,
			})
			.filter(buyQueue.isCharmShoppingRow)
		const { charms, charm_shops } = _charmsPayload()
		res.json({
			ok: true,
			rows,
			charms,
			charm_shops,
			progress: getCharmPurchaseProgress(db),
			scope: { source: 'needs_purchase', np_filter: 'all', orders: receiptIds.size, charm_lines: rows.length },
		})
	} catch (err) {
		console.error('[route] charms-to-buy error:', err.message)
		res.status(500).json({ error: err.message })
	}
})

/**
 * POST /api/route/charm-progress
 * Body: { charm_code, purchased_qty }
 * Sets how many physical pieces of a charm have already been purchased / are in
 * stock. Clamped to >= 0.
 */
app.post('/api/route/charm-progress', express.json(), (req, res) => {
	const b = req.body ?? {}
	if (!b.charm_code) return res.status(400).json({ error: 'charm_code is required.' })
	try {
		const saved = setCharmPurchaseProgress(db, b.charm_code, b.purchased_qty)
		res.json({ ok: true, ...saved })
	} catch (err) {
		res.status(err.code === 'REQUIRED' ? 400 : 500).json({ error: err.message })
	}
})

/**
 * GET /api/route/order/:receiptId
 * Fetch a single order as route row(s) — bypasses the date window so any
 * paid order in the DB can be added to the route dashboard on demand.
 */
app.get('/api/route/order/:receiptId', (req, res) => {
	const receiptId = parseInt(req.params.receiptId, 10)
	if (isNaN(receiptId)) return res.status(400).json({ error: 'Invalid receipt_id' })
	try {
		// Explicitly pulling an order back in is an unambiguous "un-remove": clear any
		// prior dismissal so the order returns to the active dashboard cleanly.
		clearDismissedByReceipt(db, receiptId)
		const rows = routeDashboard.buildRouteRows(db, config, {
			receipt_id: receiptId,
			enrich_supplier: true,
		})
		if (rows.length === 0) return res.status(404).json({ error: 'Order not found or not paid.' })
		res.json({ rows })
	} catch (err) {
		console.error('[route] order fetch error:', err.message)
		res.status(500).json({ error: err.message })
	}
})

/**
 * GET /api/route/products
 * Active Product Catalog read model shared by Add Order and Design Switch.
 * Membership/supplier/location come from product_map; order history only enriches
 * cards with observed models/styles/counts and can never resurrect retired rows.
 *
 * Optional ?q= filters title, aliases, supplier, stall or charm.
 */
app.get('/api/route/products', (req, res) => {
	try {
		const cat = routeDashboard.buildProductCatalog(db)
		const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : ''
		const products = q
			? cat.products.filter(
					(p) =>
						(p.title || '').toLowerCase().includes(q) ||
						(p.alias_titles || []).some((title) => String(title || '').toLowerCase().includes(q)) ||
						(p.shop_name || '').toLowerCase().includes(q) ||
						(p.stall || '').toLowerCase().includes(q) ||
						(p.charm_shop || '').toLowerCase().includes(q) ||
						(p.charm_code || '').toLowerCase().includes(q),
				)
			: cat.products
		res.json({ ok: true, products, phone_models: cat.phone_models, styles: cat.styles })
	} catch (err) {
		console.error('[route] products error:', err.message)
		res.status(500).json({ error: err.message })
	}
})

/**
 * POST /api/route/manual-order
 * Add an operator-created order to the Orders Sorting Dashboard. A buyer may
 * order several products, so the body accepts either:
 *
 *   { items: [ { title, phone_model, style, quantity, ... }, ... ] }
 *
 * or the legacy single-product shape (title at the top level), which is treated
 * as a one-item cart. Either way this creates ONE receipts row (one buyer, one
 * shipment) plus one route sidecar per product.
 *
 * Each item:
 *   source       'catalog' | 'custom'
 *   title        required
 *   phone_model  optional
 *   style        optional (drives Case/Grip/Charm component detection)
 *   quantity     optional (default 1)
 *   shop_name    optional
 *   listing_id   optional (catalog picks — enables supplier match + image)
 *   image_url    optional (catalog CDN thumbnail)
 *   image_b64    optional (custom upload — raw or data: URL)
 *   image_mime   optional (custom upload mime, e.g. image/png)
 *   charm_code / charm_shop  optional per-line charm
 *
 * Returns the freshly-built route rows so the client can insert them instantly.
 */
app.post('/api/route/manual-order', express.json({ limit: '25mb' }), (req, res) => {
	const b = req.body ?? {}
	const rawItems = Array.isArray(b.items) && b.items.length ? b.items : String(b.title || '').trim() ? [b] : []
	if (!rawItems.length) return res.status(400).json({ error: 'At least one product is required.' })
	if (rawItems.length > MAX_ROUTE_MANUAL_ITEMS) {
		return res.status(400).json({ error: `A manual order can contain at most ${MAX_ROUTE_MANUAL_ITEMS} products.` })
	}

	try {
		const usedKeys = new Set()
		const items = rawItems.map((it, idx) => {
			const title = String(it.title || '').trim()
			if (!title) {
				const e = new Error(`Product ${idx + 1} is missing a title.`)
				e.code = 'REQUIRED'
				throw e
			}
			const source = it.source === 'catalog' ? 'catalog' : 'custom'
			const catalogId = Number(it.catalog_id)
			const catalogProduct =
				source === 'catalog'
					? getProductMapRow(
							db,
							Number.isInteger(catalogId) && catalogId > 0 ? { id: catalogId } : { title },
						)
					: null
			if (
				source === 'catalog' &&
				(!catalogProduct ||
					catalogProduct.status === 'retired' ||
					catalogProduct.title_norm !== routeDashboard.normalizeTitle(title))
			) {
				throw Object.assign(
					new Error(`“${title}” is no longer active in Product Catalog. Refresh and choose a replacement.`),
					{ code: 'CATALOG_PRODUCT_UNAVAILABLE' },
				)
			}
			const listingId = it.listing_id != null && String(it.listing_id).trim() !== '' ? Number(it.listing_id) : null
			const phoneModel = String(it.phone_model || '').trim()
			const style = String(it.style || '').trim()
			let itemKey = routeDashboard.lineItemKeyWithVariant(title, listingId, phoneModel, style)
			if (usedKeys.has(itemKey)) {
				let n = 2
				let candidate = `${itemKey}~${n}`
				while (usedKeys.has(candidate)) {
					n += 1
					candidate = `${itemKey}~${n}`
				}
				itemKey = candidate
			}
			usedKeys.add(itemKey)

			let imageData = null
			let imageMime = String(it.image_mime || '').trim()
			if (it.image_b64 && typeof it.image_b64 === 'string') {
				let raw = it.image_b64.trim()
				const m = /^data:([^;]+);base64,(.*)$/i.exec(raw)
				if (m) {
					imageMime = imageMime || m[1]
					raw = m[2]
				}
				try {
					const buf = Buffer.from(raw, 'base64')
					if (buf.length > 0) imageData = buf
				} catch {
					/* ignore malformed image; item still added without a photo */
				}
			}

			return {
				source,
				title,
				phone_model: phoneModel,
				style,
				quantity: it.quantity,
				shop_name: catalogProduct ? catalogProduct.shop_name || '' : it.shop_name,
				listing_id: listingId,
				image_url: String(it.image_url || '').trim(),
				image_data: imageData,
				image_mime: imageMime,
				charm_code: it.charm_code,
				charm_shop: it.charm_shop,
				item_key: itemKey,
			}
		})

		const created = createRouteManualOrder(db, { shop_id: MANUAL_SHOP_ID, items })

		let rows = []
		try {
			rows = routeDashboard.buildRouteRows(db, config, {
				enrich_supplier: true,
				receipt_id: created.receipt_id,
			})
		} catch {
			/* non-fatal — client can reload */
		}

		res.status(201).json({
			ok: true,
			receipt_id: created.receipt_id,
			items: created.items,
			rows,
			row: rows[0] || null, // legacy single-item clients
		})
	} catch (err) {
		console.error('[route] manual-order create error:', err.message)
		const status = err.code === 'REQUIRED' ? 400 : err.code === 'CATALOG_PRODUCT_UNAVAILABLE' ? 409 : 500
		res.status(status).json({ error: err.message, code: err.code })
	}
})

/**
 * DELETE /api/route/manual-order
 * Body: { receipt_id, item_key? }  (the synthetic negative id)
 *
 * With an item_key, removes just THAT product from the order — a manual order
 * can carry several, and deleting one must not take the buyer's other products
 * (or the order itself) with it. Removing the last remaining product tears the
 * whole order down, since an order with no products is not an order. Without an
 * item_key the whole order is removed, as before.
 */
app.delete('/api/route/manual-order', express.json(), (req, res) => {
	const b = req.body ?? {}
	const rid = Number(b.receipt_id)
	const itemKey = String(b.item_key || '').trim()
	if (!Number.isInteger(rid)) return res.status(400).json({ error: 'receipt_id is required.' })
	try {
		// Block deletion while a 4PX shipment exists — the manual order may have been
		// shipped from the Orders tab, and deleting it here would orphan the label.
		const linked = db.prepare('SELECT fourpx_consignment_no, fourpx_order_status FROM receipts WHERE receipt_id = ?').get(rid)
		if (linked?.fourpx_consignment_no && linked.fourpx_order_status !== 'cancelled') {
			return res.status(409).json({ error: 'This manual order has a 4PX shipment. Cancel the 4PX shipment in the Orders tab first, then delete it.' })
		}
		const result = deleteManualOrderLine(db, rid, itemKey)
		if (!result.removed) return res.status(404).json({ error: 'Manual item not found.' })
		res.json({ ok: true, purged: result.purged, remaining: result.remaining })
	} catch (err) {
		console.error('[route] manual-order delete error:', err.message)
		res.status(500).json({ error: err.message })
	}
})

/**
 * POST /api/route/dismiss
 * Body: { receipt_id, item_key, title?, dismissed? }  -- single line
 *   or  { items: [{ receipt_id, item_key, title? }], dismissed? }  -- batch
 *
 * Durably removes (or, with dismissed:false, restores) one or more order lines
 * from the Orders Sorting Dashboard. A removed line stays out of the dashboard
 * and the next generated route, but the underlying Etsy receipt is untouched —
 * it still appears in the Orders tab and can be re-added later. Reversible.
 */
app.post('/api/route/dismiss', express.json(), (req, res) => {
	const b = req.body ?? {}
	const dismissed = b.dismissed !== false // default true (remove)
	const items = Array.isArray(b.items) && b.items.length ? b.items : [{ receipt_id: b.receipt_id, item_key: b.item_key, title: b.title }]

	const valid = items.filter((it) => it && it.receipt_id != null && it.item_key)
	if (!valid.length) {
		return res.status(400).json({ error: 'receipt_id and item_key are required.' })
	}

	try {
		const apply = db.transaction((list) => {
			for (const it of list) {
				setRouteDismissed(db, {
					receipt_id: Number(it.receipt_id),
					item_key: String(it.item_key),
					title: it.title,
					dismissed,
				})
			}
		})
		apply(valid)
		res.json({ ok: true, dismissed, count: valid.length })
	} catch (err) {
		console.error('[route] dismiss error:', err.message)
		res.status(500).json({ error: err.message })
	}
})

/**
 * GET /api/route/manual-image/:id
 * Streams the uploaded image bytes for a custom manual product.
 */
app.get('/api/route/manual-image/:id', (req, res) => {
	const id = parseInt(req.params.id, 10)
	if (!Number.isInteger(id)) return res.status(400).end()
	try {
		const img = getManualItemImage(db, id)
		if (!img) return res.status(404).end()
		return sendStoredImage(res, img)
	} catch (err) {
		console.error('[route] manual-image error:', err.message)
		if (!res.headersSent) res.status(404).end()
	}
})

/**
 * GET /api/route/suppliers
 * Returns the authoritative supplier directory + charm-shop directory,
 * imported from supplier_catalog.xlsx. Drives the dashboard's pickers.
 */
// Build the suppliers + charm-shops payload in authoritative sort_order.
function _supplierPayload() {
	const suppliers = getSupplierDirectory(db).map((s) => ({ shop_name: s.shop_name, stall: s.stall, mall: s.mall, floor: s.floor, address: s.address, notes: s.notes, sort_order: s.sort_order }))
	const charm_shops = getCharmShopDirectory(db).map((s) => ({ shop_name: s.shop_name, stall: s.stall, notes: s.notes, sort_order: s.sort_order }))
	return { suppliers, charm_shops }
}

// Map a thrown CRUD error code to an HTTP status.
function _supplierErrStatus(err) {
	if (err && err.code === 'DUPLICATE') return 409
	if (err && err.code === 'IN_USE') return 409
	if (err && (err.code === 'CONFLICT' || err.code === 'IMMUTABLE')) return 409
	if (err && err.code === 'REQUIRED') return 400
	if (err && err.code === 'NOT_FOUND') return 404
	return 500
}

app.get('/api/route/suppliers', (req, res) => {
	try {
		res.json(_supplierPayload())
	} catch (err) {
		console.error('[route] suppliers error:', err.message)
		res.status(500).json({ error: err.message })
	}
})

/**
 * POST /api/route/suppliers — create a new supplier in the directory.
 * Body: { shop_name, stall, mall?, floor?, address?, notes? }
 * Returns the full refreshed list so the UI can re-render in one round-trip.
 */
app.post('/api/route/suppliers', express.json(), (req, res) => {
	const b = req.body ?? {}
	try {
		insertSupplierDirectoryRow(db, b)
		broadcastCatalogRefresh('supplier-created')
		res.json({ ok: true, ..._supplierPayload() })
	} catch (err) {
		res.status(_supplierErrStatus(err)).json({ error: err.message, code: err.code })
	}
})

/**
 * PUT /api/route/suppliers — update an existing supplier.
 * Body: { orig_shop_name, orig_stall, shop_name, stall, mall?, floor?, address?, notes? }
 */
app.put('/api/route/suppliers', express.json(), (req, res) => {
	const b = req.body ?? {}
	try {
		updateSupplierDirectoryRow(db, b)
		broadcastCatalogRefresh('supplier-updated')
		res.json({ ok: true, ..._supplierPayload() })
	} catch (err) {
		res.status(_supplierErrStatus(err)).json({ error: err.message, code: err.code })
	}
})

/**
 * DELETE /api/route/suppliers — remove a supplier by composite key.
 * Body: { shop_name, stall, retire_products? }
 * Active products protect the supplier unless the caller explicitly confirms
 * that all products at this booth should be retired atomically.
 */
app.delete('/api/route/suppliers', express.json(), (req, res) => {
	const b = req.body ?? {}
	try {
		const result = deleteSupplierDirectoryRow(db, {
			...b,
			retire_products: b.retire_products === true,
			retired_by: (req.auth && req.auth.user) || '',
		})
		if (!result.removed) return res.status(404).json({ error: 'Supplier not found.' })
		broadcastCatalogRefresh('supplier-deleted', { retired_products: result.retired_products })
		res.json({ ok: true, impact: result, ..._supplierPayload() })
	} catch (err) {
		res.status(_supplierErrStatus(err)).json({ error: err.message, code: err.code, product_count: err.product_count })
	}
})

/**
 * POST /api/route/charm-shops — create a new charm shop in the directory.
 * Body: { shop_name, stall, notes? }
 */
app.post('/api/route/charm-shops', express.json(), (req, res) => {
	const b = req.body ?? {}
	try {
		insertCharmShopDirectoryRow(db, b)
		broadcastCatalogRefresh('charm-supplier-created')
		res.json({ ok: true, ..._supplierPayload() })
	} catch (err) {
		res.status(_supplierErrStatus(err)).json({ error: err.message })
	}
})

/**
 * PUT /api/route/charm-shops — update an existing charm shop.
 * Body: { orig_shop_name, orig_stall, shop_name, stall, notes? }
 */
app.put('/api/route/charm-shops', express.json(), (req, res) => {
	const b = req.body ?? {}
	try {
		updateCharmShopDirectoryRow(db, b)
		broadcastCatalogRefresh('charm-supplier-updated')
		res.json({ ok: true, ..._supplierPayload() })
	} catch (err) {
		res.status(_supplierErrStatus(err)).json({ error: err.message })
	}
})

/**
 * DELETE /api/route/charm-shops — remove a charm shop by composite key.
 * Body: { shop_name, stall }
 */
app.delete('/api/route/charm-shops', express.json(), (req, res) => {
	const b = req.body ?? {}
	try {
		const removed = deleteCharmShopDirectoryRow(db, b)
		if (!removed) return res.status(404).json({ error: 'Charm shop not found.' })
		broadcastCatalogRefresh('charm-supplier-deleted')
		res.json({ ok: true, ..._supplierPayload() })
	} catch (err) {
		res.status(_supplierErrStatus(err)).json({ error: err.message })
	}
})

/**
 * POST /api/route/import-suppliers
 * Merge supplier_catalog.xlsx's Product Map into the active catalog.
 * Supplier and charm-shop directories are app-owned master data after initial
 * seeding; this route never replaces them behind lifecycle protections.
 */
app.post('/api/route/import-suppliers', (req, res) => {
	try {
		const r = supplierImport.importSupplierCatalog(db, config, {
			force: true,
			skipSuppliers: true,
			skipCharmShops: true,
		})
		if (!r.ok) return res.status(400).json(r)
		// The import merges product_map, so re-apply the catalog backfill to
		// keep empty supplier/charm cells populated from the route-engine catalog.
		try {
			routeDashboard.reconcileProductMap(db, config)
		} catch {
			/* non-fatal */
		}
		broadcastCatalogRefresh('catalog-imported')
		res.json({ ...r, ..._supplierPayload() })
	} catch (err) {
		console.error('[route] import-suppliers error:', err.message)
		res.status(500).json({ error: err.message })
	}
})

// ════════════════════════════════════════════════════════════════════════════
// SOURCING LIBRARY — design-supplier registry + uploaded product-zip manager.
//
// A back-office workspace (served at /sourcing) for the owner + employee to:
//   • keep the master list of WeChat/QQ design suppliers (name, location, chat
//     handles) with full CRUD, and
//   • file the zipped product folders the employee downloads from those chats
//     against the right supplier + product type (phone case / grip / charm),
//     with upload / rename / re-categorise / status / download / delete.
//
// Zip bytes stream to disk under SOURCING_ROOT (never held wholly in memory, so
// a 500 MB folder uploads with constant memory); the sourcing_packages table is
// the searchable, sortable index. Every mutating call is already captured by the
// audit middleware, so who-uploaded-what is on the record without extra code.
// ════════════════════════════════════════════════════════════════════════════

// Map a thrown sourcing CRUD error code to an HTTP status (mirrors _supplierErrStatus).
function _sourcingErrStatus(err) {
	if (err && err.code === 'DUPLICATE') return 409
	if (err && err.code === 'REQUIRED') return 400
	if (err && err.code === 'NOT_FOUND') return 404
	if (err && err.code === 'BAD_PATH') return 400
	return 500
}

// Absolute path of a stored package on disk, guarded against traversal.
function _sourcingPackagePath(pkg) {
	return path.join(sourcingLib.packageDir(SOURCING_ROOT, pkg.supplier_id, pkg.category), pkg.stored_name)
}

// Best-effort file removal — a missing file must never block a DB delete.
function _sourcingUnlink(absPath) {
	try {
		if (absPath && fs.existsSync(absPath)) fs.unlinkSync(absPath)
	} catch (err) {
		console.warn('[sourcing] could not remove file:', err.message)
	}
}

// Static taxonomy (categories + workflow statuses) for the UI to render labels.
app.get('/api/sourcing/meta', (req, res) => {
	res.json({
		categories: sourcingLib.CATEGORIES,
		statuses: sourcingLib.STATUSES,
		product_types: sourcingCatalog.PRODUCT_TYPES,
		gap_types: sourcingCatalog.GAP_TYPES,
	})
})

// ─── Sourcing Catalog (a PROJECTION, not a second copy) ─────────────────────
//
// One read model over the master data the Route tab and the Python route
// generator already own: product_map (what we sell + its unit costs),
// supplier_directory (who sells it + where), charm_shop_directory / charm_library
// (the charm leg), and the listings/order-history image corpus (the photos).
//
// Reads come from here so the whole page loads in one round trip. WRITES go to
// the endpoints that already own each entity — /api/route/product-map,
// /api/route/suppliers, /api/route/charm-shops — so there is exactly one write
// path per table and the two pages can never disagree. See
// src/sourcing/catalog-view.js for the reasoning in full.

app.get('/api/sourcing/catalog', (req, res) => {
	try {
		res.json(sourcingCatalogView.buildCatalog(db))
	} catch (err) {
		console.error('[sourcing] catalog GET error:', err.message)
		res.status(500).json({ error: err.message })
	}
})

/**
 * GET /api/sourcing/catalog/export.csv
 * The catalog as a UTF-8 CSV, with everything the page shows: product type,
 * supplier, resolved building/floor, charm, and per-component prices.
 *
 * Deliberately a SEPARATE export from /api/route/product-map/export.csv, which
 * mirrors the "Product Map" sheet of supplier_catalog.xlsx column-for-column and
 * therefore has to keep its shape for the Excel round-trip to work.
 */
app.get('/api/sourcing/catalog/export.csv', (req, res) => {
	try {
		const { products } = sourcingCatalogView.buildCatalog(db)
		const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
		const header = ['Product Title', 'Product Type', 'Type Source', 'Supplier', 'Stall', 'Building', 'Floor', 'In Directory', 'Charm Shop', 'Charm Stall', 'Charm Code', 'Case Cost', 'Grip Cost', 'Charm Cost', 'Unit Cost', 'Needs Attention', 'Canonical Product ID'].map(cell).join(',')
		const body = products.map((p) => [p.title, sourcingCatalog.productTypeLabel(p.product_type, 'en'), p.product_type_source, p.shop_name, p.stall_effective, p.location.located ? p.location.building_label.en : '', p.location.floor && p.location.floor !== sourcingCatalog.UNKNOWN_FLOOR_SENTINEL ? p.location.floor : '', p.supplier_in_directory === null ? '' : p.supplier_in_directory ? 'yes' : 'no', p.charm_shop, p.charm_stall, p.charm_code, p.cost_case, p.cost_grip, p.charm_cost, p.cost_total, p.gaps.join(' '), p.canonical_product_key].map(cell).join(',')).join('\r\n')
		res.setHeader('Content-Type', 'text/csv; charset=utf-8')
		res.setHeader('Content-Disposition', `attachment; filename="sourcing_catalog_${new Date().toISOString().slice(0, 10)}.csv"`)
		res.send(`\uFEFF${header}\r\n${body}`) // BOM so Excel detects UTF-8
	} catch (err) {
		console.error('[sourcing] catalog export error:', err.message)
		res.status(500).json({ error: err.message })
	}
})

// ─── Suppliers ──────────────────────────────────────────────────────────────

app.get('/api/sourcing/suppliers', (req, res) => {
	try {
		res.json({ suppliers: getSourcingSuppliers(db) })
	} catch (err) {
		console.error('[sourcing] suppliers GET error:', err.message)
		res.status(500).json({ error: err.message })
	}
})

app.post('/api/sourcing/suppliers', express.json(), (req, res) => {
	try {
		const supplier = insertSourcingSupplier(db, req.body ?? {})
		res.json({ ok: true, supplier, suppliers: getSourcingSuppliers(db) })
	} catch (err) {
		res.status(_sourcingErrStatus(err)).json({ error: err.message })
	}
})

app.put('/api/sourcing/suppliers/:id', express.json(), (req, res) => {
	try {
		const supplier = updateSourcingSupplier(db, req.params.id, req.body ?? {})
		res.json({ ok: true, supplier, suppliers: getSourcingSuppliers(db) })
	} catch (err) {
		res.status(_sourcingErrStatus(err)).json({ error: err.message })
	}
})

app.delete('/api/sourcing/suppliers/:id', (req, res) => {
	try {
		const { packages } = deleteSourcingSupplier(db, req.params.id)
		// DB rows are gone; now clean their zip files (best-effort), then the now-
		// empty supplier folder. A failed unlink is logged, never fatal.
		for (const p of packages) {
			try {
				_sourcingUnlink(_sourcingPackagePath(p))
			} catch (e) {
				console.warn('[sourcing] file cleanup skipped:', e.message)
			}
		}
		try {
			fs.rmSync(path.join(SOURCING_ROOT, String(req.params.id)), { recursive: true, force: true })
		} catch {
			/* non-fatal */
		}
		res.json({ ok: true, removed_packages: packages.length, suppliers: getSourcingSuppliers(db) })
	} catch (err) {
		res.status(_sourcingErrStatus(err)).json({ error: err.message })
	}
})

// ─── Packages ─────────────────────────────────────────────────────────────

app.get('/api/sourcing/packages', (req, res) => {
	try {
		const rows = getSourcingPackages(db, {
			supplier_id: req.query.supplier_id,
			category: req.query.category,
			q: req.query.q,
		})
		res.json({ packages: rows })
	} catch (err) {
		console.error('[sourcing] packages GET error:', err.message)
		res.status(500).json({ error: err.message })
	}
})

/**
 * POST /api/sourcing/packages/upload?supplier_id=&category=&filename=&title=&notes=
 *
 * The zip is sent as the raw request body (Content-Type: application/octet-stream)
 * and STREAMED straight to a temp file on disk while we hash it — constant memory
 * even for a 500 MB folder, unlike the base64-in-JSON pattern used elsewhere for
 * small images. Metadata rides on the query string (no multipart parser needed).
 *
 * Safety: the first bytes are checked for the ZIP magic before we accept the file;
 * the on-disk name is a generated token (never client input); the temp file is
 * removed on any error or on a non-zip payload.
 */
app.post('/api/sourcing/packages/upload', (req, res) => {
	const supplierId = parseInt(req.query.supplier_id, 10)
	const category = String(req.query.category || '')
	const supplier = getSourcingSupplierById(db, supplierId)
	if (!supplier) return res.status(404).json({ error: 'Supplier not found.', code: 'NOT_FOUND' })
	if (!sourcingLib.isValidCategory(category)) return res.status(400).json({ error: 'Invalid category.', code: 'REQUIRED' })

	const originalFilename = sourcingLib.sanitizeFilename(req.query.filename || 'package.zip')
	const title = String(req.query.title || '').trim() || sourcingLib.titleFromFilename(originalFilename)
	const notes = String(req.query.notes || '').trim()
	const uploadedBy = (req.auth && req.auth.user) || ''

	let dir
	try {
		dir = sourcingLib.packageDir(SOURCING_ROOT, supplierId, category)
		fs.mkdirSync(dir, { recursive: true })
	} catch (err) {
		return res.status(_sourcingErrStatus(err)).json({ error: err.message })
	}

	const storedName = sourcingLib.storedFileName()
	const finalPath = path.join(dir, storedName)
	const tmpPath = finalPath + '.part'
	const hash = crypto.createHash('sha256')
	const out = fs.createWriteStream(tmpPath)

	let bytes = 0
	let headerChecked = false
	let aborted = false
	const MAX_BYTES = 1024 * 1024 * 1024 // 1 GB hard ceiling per upload

	// Remove the half-written temp file — but only once the write stream has really
	// closed. fs.createWriteStream() opens the file ASYNCHRONOUSLY, so unlinking
	// straight after destroy() loses a race we hit constantly: the unlink returns
	// ENOENT (the open hasn't landed) and the still-pending open then CREATES the
	// file, stranding a .part on disk forever. Every rejected upload — a non-zip
	// pick, an empty body, a cancelled transfer — takes that path, so the leak
	// accumulates fastest on exactly the errors an operator retries. Waiting for
	// 'close' guarantees the fd is released and the open has settled either way.
	function removeTemp() {
		if (out.closed) _sourcingUnlink(tmpPath)
		else out.once('close', () => _sourcingUnlink(tmpPath))
	}

	function fail(status, message, code) {
		if (aborted) return
		aborted = true
		try {
			req.unpipe(out)
		} catch {}
		out.destroy()
		removeTemp()
		if (!res.headersSent) res.status(status).json({ error: message, code })
	}

	req.on('data', (chunk) => {
		if (aborted) return
		if (!headerChecked) {
			headerChecked = true
			if (!sourcingLib.looksLikeZip(chunk)) {
				return fail(400, 'That file is not a .zip archive. Please upload the zipped product folder.', 'NOT_ZIP')
			}
		}
		bytes += chunk.length
		if (bytes > MAX_BYTES) {
			return fail(413, 'File is too large (max 1 GB per upload).', 'TOO_LARGE')
		}
		hash.update(chunk)
	})

	req.on('error', () => fail(400, 'Upload interrupted. Please try again.', 'UPLOAD_ERROR'))
	out.on('error', (err) => fail(500, `Could not write file: ${err.message}`, 'WRITE_ERROR'))

	out.on('finish', () => {
		if (aborted) return
		if (bytes === 0) {
			removeTemp()
			return res.status(400).json({ error: 'The upload was empty.', code: 'EMPTY' })
		}
		try {
			fs.renameSync(tmpPath, finalPath)
			const pkg = insertSourcingPackage(db, {
				supplier_id: supplierId,
				category,
				title,
				original_filename: originalFilename,
				stored_name: storedName,
				size_bytes: bytes,
				sha256: hash.digest('hex'),
				status: 'new',
				notes,
				uploaded_by: uploadedBy,
			})
			res.json({ ok: true, package: pkg, suppliers: getSourcingSuppliers(db) })
		} catch (err) {
			_sourcingUnlink(finalPath)
			removeTemp()
			console.error('[sourcing] upload finalise error:', err.message)
			if (!res.headersSent) res.status(500).json({ error: err.message })
		}
	})

	req.pipe(out)
})

app.put('/api/sourcing/packages/:id', express.json(), (req, res) => {
	try {
		const b = req.body ?? {}
		if (b.category != null && !sourcingLib.isValidCategory(b.category)) {
			return res.status(400).json({ error: 'Invalid category.', code: 'REQUIRED' })
		}
		if (b.status != null && !sourcingLib.isValidStatus(b.status)) {
			return res.status(400).json({ error: 'Invalid status.', code: 'REQUIRED' })
		}
		const before = getSourcingPackageById(db, req.params.id)
		if (!before) return res.status(404).json({ error: 'Package not found.', code: 'NOT_FOUND' })
		const pkg = updateSourcingPackage(db, req.params.id, b)
		// If the category changed, move the file into the new category folder so
		// the on-disk tree stays consistent with the index (best-effort; the DB is
		// the source of truth for where a file lives, so a failed move is logged).
		if (b.category != null && b.category !== before.category) {
			try {
				const fromPath = _sourcingPackagePath(before)
				const toDir = sourcingLib.packageDir(SOURCING_ROOT, pkg.supplier_id, pkg.category)
				fs.mkdirSync(toDir, { recursive: true })
				const toPath = path.join(toDir, pkg.stored_name)
				if (fs.existsSync(fromPath)) fs.renameSync(fromPath, toPath)
			} catch (e) {
				console.warn('[sourcing] category file move skipped:', e.message)
			}
		}
		res.json({ ok: true, package: pkg, suppliers: getSourcingSuppliers(db) })
	} catch (err) {
		res.status(_sourcingErrStatus(err)).json({ error: err.message })
	}
})

app.delete('/api/sourcing/packages/:id', (req, res) => {
	try {
		const pkg = deleteSourcingPackage(db, req.params.id)
		_sourcingUnlink(_sourcingPackagePath(pkg))
		res.json({ ok: true, suppliers: getSourcingSuppliers(db) })
	} catch (err) {
		res.status(_sourcingErrStatus(err)).json({ error: err.message })
	}
})

// Stream a stored zip back to the browser as a download with its original name.
app.get('/api/sourcing/packages/:id/download', (req, res) => {
	try {
		const pkg = getSourcingPackageById(db, req.params.id)
		if (!pkg) return res.status(404).json({ error: 'Package not found.' })
		const abs = _sourcingPackagePath(pkg)
		if (!fs.existsSync(abs)) return res.status(410).json({ error: 'The stored file is missing.' })
		const downloadName = sourcingLib.sanitizeFilename(pkg.original_filename || pkg.title || 'package.zip')
		res.setHeader('Content-Type', 'application/zip')
		res.setHeader('Content-Disposition', contentDisposition(downloadName))
		try {
			res.setHeader('Content-Length', fs.statSync(abs).size)
		} catch {}
		const stream = fs.createReadStream(abs)
		stream.on('error', (err) => {
			console.error('[sourcing] download stream error:', err.message)
			if (!res.headersSent) res.status(500).end()
			else res.destroy()
		})
		stream.pipe(res)
	} catch (err) {
		console.error('[sourcing] download error:', err.message)
		if (!res.headersSent) res.status(_sourcingErrStatus(err)).json({ error: err.message })
	}
})

// ─── Product Catalog (product_map) CRUD ────────────────────────────────────

// Attach a resolved product thumbnail to each row. Images are sourced from the
// canonical listings table + order history (exact match), with a conservative
// fuzzy fallback for drifted titles flagged via `image_approx`.
function _withProductImages(rows) {
	let resolver
	try {
		resolver = routeDashboard.buildCatalogImageResolver(db)
	} catch {
		resolver = { resolve: () => null }
	}
	return rows.map((r) => {
		const m = resolver.resolve(r.title_norm, r.title)
		return { ...r, image_url: m ? m.url : null, image_approx: m ? !!m.approx : false }
	})
}

/**
 * GET /api/route/product-map?q=
 * Returns all product_map rows (each enriched with a product image URL),
 * optionally filtered by a search term.
 */
app.get('/api/route/product-map', (req, res) => {
	try {
		const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
		res.json({ ok: true, rows: _withProductImages(getProductMap(db, q || undefined)) })
	} catch (err) {
		console.error('[route] product-map GET error:', err.message)
		res.status(500).json({ error: err.message })
	}
})

/**
 * POST /api/route/product-map/reconcile
 * Backfill empty supplier/charm fields from the bundled route-engine catalog
 * (exact title matches only; never overwrites existing values).
 */
app.post('/api/route/product-map/reconcile', (req, res) => {
	try {
		const r = routeDashboard.reconcileProductMap(db, config)
		if ((r.supplier_filled || 0) + (r.charm_filled || 0) > 0) {
			broadcastCatalogRefresh('catalog-reconciled')
		}
		res.json({ ...r, rows: _withProductImages(getProductMap(db)) })
	} catch (err) {
		console.error('[route] product-map reconcile error:', err.message)
		res.status(500).json({ error: err.message })
	}
})

/**
 * Reject a product-type value the taxonomy does not know, so a typo can never
 * be persisted as a permanent override that renders as a dead badge. '' is
 * legal and means "clear the override, derive it from the title again".
 * @returns {string|null} an error message, or null when the body is acceptable
 */
function _productTypeError(body) {
	const v = body.product_type
	if (v == null || v === '') return null
	if (sourcingCatalog.isValidProductType(v)) return null
	return `Unknown product type "${String(v).slice(0, 40)}". Expected one of: ${sourcingCatalog.PRODUCT_TYPE_IDS.join(', ')}.`
}

/**
 * Apply the optional per-component purchase prices that may ride along with a
 * catalog write, and return the resulting costs (or null when the caller sent
 * none).
 *
 * Prices are NOT written by the product_map accessors on purpose: setProductCost
 * owns them because it also records price history and fans a change out to every
 * catalog title that is the same physical product. So it runs AFTER the mapping
 * row exists, keyed on the title the row now has, and only for the cost fields
 * actually present in the body — `undefined` means "leave this price alone",
 * which is exactly how setProductCost reads a missing key.
 *
 * @param {string} title the row's FINAL title (a PUT may have just changed it)
 * @param {object} body the request body
 */
function _applyCatalogPrices(title, body) {
	const patch = {}
	if ('cost_case' in body) patch.cost_case = sourcingCatalog.normalizePrice(body.cost_case)
	if ('cost_grip' in body) patch.cost_grip = sourcingCatalog.normalizePrice(body.cost_grip)
	if (!Object.keys(patch).length) return null
	return setProductCost(db, { title, ...patch })
}

/**
 * Close the Wrong Stall reports a PRODUCT-level location correction answers, on
 * every order line that inherits that location, and tell live clients.
 *
 * A per-product location is written from two places — the Product Catalog modal
 * and a supplier/charm edit in the Route tab (which saves the product default) —
 * and both must settle the reports they answer, or lines whose stall is now
 * correct would keep being exported for re-sourcing forever.
 *
 * @param {string} title - the product whose recorded location changed
 * @param {{ supplier?: boolean, charm?: boolean }} moved - locations that changed
 * @param {string} reason - SSE refresh reason, for the client log
 * @returns {object[]} the route_assignments rows whose flag was cleared
 */
function _closeWrongStallForProduct(title, moved, reason) {
	if (!moved || (!moved.supplier && !moved.charm)) return []

	let rows = []
	db.transaction(() => {
		rows = resolveWrongStallForProduct(db, title, moved)
		for (const row of rows) syncAssignmentIssue(row.receipt_id, row.item_key)
		for (const receiptId of new Set(rows.map((r) => r.receipt_id))) recomputeNeedsPurchaseRollup(receiptId)
	})()
	if (!rows.length) return rows

	// The stall AND the status both moved, which a per-line 'assign' patch can't
	// express — live clients (the shopper still on the market floor) re-fetch so
	// they get the corrected location, not just a status flip on a stale stall.
	for (const receiptId of new Set(rows.map((r) => r.receipt_id))) {
		broadcastRouteRefresh(receiptId, reason)
	}
	console.log(`[route] ${reason} cleared ${rows.length} wrong-stall flag(s) for "${title}"`)
	return rows
}

/**
 * Close the Wrong Stall reports a Product-Catalog location edit answers.
 *
 * The modal PUTs the whole row on every save, so a correction is recognised by
 * comparing against the catalog row as it stood BEFORE the write — re-saving the
 * same shop / stall must never close an open report.
 *
 * @param {object|null} before - the catalog row before the write
 * @param {object} after - the values that were saved
 * @returns {number} order lines whose flag was cleared
 */
function _closeWrongStallFromCatalogEdit(before, after) {
	const moved = {
		supplier: routeSourcing.locationMoved(before, after, ['shop_name', 'stall']),
		charm: routeSourcing.locationMoved(before, after, ['charm_code', 'charm_shop']),
	}
	return _closeWrongStallForProduct(after.title, moved, 'catalog-supplier').length
}

/**
 * POST /api/route/product-map
 * Create a new product→supplier/charm mapping.
 * Body: { title, shop_name?, stall?, charm_shop?, charm_code?, product_type?,
 *         cost_case?, cost_grip? }
 */
app.post('/api/route/product-map', express.json(), (req, res) => {
	try {
		const b = req.body ?? {}
		const typeError = _productTypeError(b)
		if (typeError) return res.status(400).json({ error: typeError, code: 'REQUIRED' })
		const write = db.transaction(() => {
			const before = getProductMapRow(db, { title: b.title })
			const result = upsertProductMapRow(db, b)
			_applyCatalogPrices(b.title, b)
			// Keep the Route tab consistent with the catalog: push this product-level
			// supplier/charm onto defaults for every canonical title alias moved
			// by the same supplier-offer fan-out.
			for (const title of new Set([b.title, ...(result.affected_titles || [])])) {
				syncProductMapToAssignments(db, { ...b, title })
			}
			return { before, result }
		})
		const { before, result } = write()
		try {
			_closeWrongStallFromCatalogEdit(before, b)
		} catch (e) {
			console.warn('[route] wrong-stall fan-out failed after catalog save:', e.message)
		}
		broadcastCatalogRefresh(before && before.status === 'retired' ? 'product-restored' : 'product-created')
		res.status(201).json({ ok: true, ...result, rows: _withProductImages(getProductMap(db)) })
	} catch (err) {
		res.status(_supplierErrStatus(err)).json({ error: err.message, code: err.code })
	}
})

/**
 * PUT /api/route/product-map
 * Update an existing active mapping by id. Product title is immutable; POST a
 * corrected title and retire the old row instead.
 * Body: { id, title, shop_name?, stall?, charm_shop?, charm_code?, product_type?,
 *         cost_case?, cost_grip? }
 *
 * `product_type` and the cost fields are optional and tri-state: omit the key to
 * leave the value alone, send '' to clear it, send a value to set it.
 */
app.put('/api/route/product-map', express.json(), (req, res) => {
	const b = req.body ?? {}
	if (!b.id) return res.status(400).json({ error: 'id is required.' })
	const typeError = _productTypeError(b)
	if (typeError) return res.status(400).json({ error: typeError, code: 'REQUIRED' })
	try {
		const write = db.transaction(() => {
			const before = getProductMapRow(db, { id: b.id })
			const result = updateProductMapRowById(db, b)
			_applyCatalogPrices(b.title, b)
			for (const title of new Set([b.title, ...(result.affected_titles || [])])) {
				syncProductMapToAssignments(db, { ...b, title })
			}
			return before
		})
		const before = write()
		try {
			_closeWrongStallFromCatalogEdit(before, b)
		} catch (e) {
			console.warn('[route] wrong-stall fan-out failed after catalog edit:', e.message)
		}
		broadcastCatalogRefresh('product-updated')
		res.json({ ok: true, rows: _withProductImages(getProductMap(db)) })
	} catch (err) {
		res.status(_supplierErrStatus(err)).json({ error: err.message, code: err.code })
	}
})

/**
 * DELETE /api/route/product-map
 * Retire a mapping by id. Canonical title aliases retire together so one
 * physical discontinued product cannot remain selectable under another listing
 * title. Historical orders and substitutions are retained.
 * Body: { id, reason? }
 */
app.delete('/api/route/product-map', express.json(), (req, res) => {
	const b = req.body ?? {}
	if (!b.id) return res.status(400).json({ error: 'id is required.' })
	try {
		const result = deleteProductMapRow(db, b.id, {
			reason: b.reason,
			by: (req.auth && req.auth.user) || '',
		})
		if (!result.removed) return res.status(404).json({ error: 'Active catalog entry not found.' })
		broadcastCatalogRefresh('product-retired', { retired_products: result.removed })
		res.json({ ok: true, impact: result, rows: _withProductImages(getProductMap(db)) })
	} catch (err) {
		res.status(_supplierErrStatus(err)).json({ error: err.message })
	}
})

/**
 * POST /api/route/product-merges
 * Declare that two or more listings are the SAME physical product, so their
 * orders merge into one product card on the shopping route even when their
 * images differ and the perceptual hash can't link them automatically.
 * Body: { listing_ids: number[], note?: string }
 * The canonical reconciler re-runs immediately, so the effect is instant.
 */
app.post('/api/route/product-merges', express.json(), (req, res) => {
	const b = req.body ?? {}
	try {
		const inserted = productMerges.linkProducts(db, b.listing_ids, {
			note: b.note,
			createdBy: (req.auth && req.auth.user) || '',
		})
		const identity = _productIdentityCoordinator.runNow('operator-merge')
		// Product identity changed, so the route's CARD grouping changed — a
		// per-line patch can't express that. Tell every connected device to pull a
		// fresh route so the merge appears on the shop floor instantly.
		if (inserted) broadcastCatalogRefresh('product-merged')
		res.status(201).json({ ok: true, inserted, groups: identity.groups })
	} catch (err) {
		res.status(err.status || 500).json({ error: err.message })
	}
})

/**
 * DELETE /api/route/product-merges
 * Undo a manual merge. Pass { listing_id } (or { listing_ids: [...] } to split a
 * whole merged product back apart) to fully unlink those listings, or
 * { listing_a, listing_b } to drop a single equivalence edge.
 */
app.delete('/api/route/product-merges', express.json(), (req, res) => {
	const b = req.body ?? {}
	try {
		let removed = 0
		if (b.listing_a != null && b.listing_b != null) {
			removed = productMerges.removeMergePair(db, b.listing_a, b.listing_b) ? 1 : 0
		} else if (Array.isArray(b.listing_ids) && b.listing_ids.length) {
			for (const id of b.listing_ids) removed += productMerges.unlinkProduct(db, id)
		} else if (b.listing_id != null) {
			removed = productMerges.unlinkProduct(db, b.listing_id)
		} else {
			return res.status(400).json({ error: 'Provide listing_id, listing_ids, or listing_a and listing_b.' })
		}
		const identity = _productIdentityCoordinator.runNow('operator-unmerge')
		if (removed) broadcastCatalogRefresh('product-unmerged')
		res.json({ ok: true, removed, groups: identity.groups })
	} catch (err) {
		res.status(err.status || 500).json({ error: err.message })
	}
})

/**
 * GET /api/route/product-map/export.csv
 * Download the entire product catalog as a UTF-8 CSV file.
 * Suitable for backup, spreadsheet editing, or re-import via the Excel import flow.
 */
app.get('/api/route/product-map/export.csv', (req, res) => {
	try {
		const rows = getProductMap(db)
		const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
		const header = ['Product Title', 'Shop Name', 'Stall', 'Charm Shop', 'Charm Code', 'Canonical Product ID'].map(esc).join(',')
		const body = rows.map((r) => [r.title, r.shop_name, r.stall, r.charm_shop, r.charm_code, r.canonical_product_key].map(esc).join(',')).join('\r\n')
		const csv = `\uFEFF${header}\r\n${body}` // BOM for Excel UTF-8 auto-detect
		res.setHeader('Content-Type', 'text/csv; charset=utf-8')
		res.setHeader('Content-Disposition', `attachment; filename="product_catalog_${new Date().toISOString().slice(0, 10)}.csv"`)
		res.send(csv)
	} catch (err) {
		console.error('[route] product-map export error:', err.message)
		res.status(500).json({ error: err.message })
	}
})

/**
 * POST /api/route/supplier-catalog/open
 * Open the editable supplier_catalog.xlsx workbook in the operator's default
 * spreadsheet application. This is a localhost dashboard, so the file is opened
 * on the same machine as the browser. Returns 404 when the workbook is missing.
 */
app.post('/api/route/supplier-catalog/open', (req, res) => {
	try {
		const fp = enginePaths.supplierCatalogPath(config)
		if (!fp || !fs.existsSync(fp)) {
			return res.status(404).json({ error: 'supplier_catalog.xlsx not found.', path: fp || null })
		}
		_openInDefaultApp(fp)
		res.json({ ok: true, path: fp })
	} catch (err) {
		console.error('[route] supplier-catalog open error:', err.message)
		res.status(500).json({ error: err.message })
	}
})

// Build the enriched charm list (+ charm shops) for the UI.
function _charmsPayload() {
	const stallByShop = {}
	getCharmShopDirectory(db).forEach((s) => {
		stallByShop[s.shop_name] = s.stall
	})
	// Per-charm image version (mtime+size) computed in one folder pass, so the UI
	// can build content-addressed image URLs (…&v=TOKEN) that self-invalidate on
	// any upload/replace/rename/renumber — no stale thumbnails, ever.
	const imgVer = charmLibrary.charmImageVersionMap(db, config)
	const charms = getCharmLibrary(db).map((c) => ({
		code: c.code,
		default_charm_shop: c.default_charm_shop || '',
		default_charm_shop_stall: stallByShop[c.default_charm_shop] || '',
		notes: c.notes || '',
		image_file: c.image_file || '',
		// has_image reflects a REAL file on disk, not just a non-empty DB column.
		// charmImageVersionMap only records a version when a <code>.<ext> file
		// actually exists, so `imgVer.has(code)` is the authoritative disk check.
		// This is what prevents a charm whose image was lost/orphaned (e.g. by a
		// past renumber) from rendering as a broken <img> in the Manage-charm menu.
		has_image: imgVer.has(c.code),
		image_version: imgVer.get(c.code) || '',
		sort_order: c.sort_order,
	}))
	return { charms, charm_shops: getCharmShopDirectory(db) }
}

/**
 * GET /api/route/charms
 * Returns the (UED-authoritative) charm library, enriched with each charm
 * shop's exact stall so the UI can show "shop · stall".
 */
app.get('/api/route/charms', (req, res) => {
	try {
		res.json(_charmsPayload())
	} catch (err) {
		res.status(500).json({ error: err.message })
	}
})

/**
 * POST /api/route/charms — add a new charm.
 * Body: { code?, default_charm_shop?, notes?, image_base64?, image_ext? }
 * A code is auto-allocated (CH-#####) when not provided.
 */
app.post('/api/route/charms', express.json({ limit: '20mb' }), (req, res) => {
	const b = req.body ?? {}
	try {
		let code = String(b.code || '').trim()
		if (!code) code = charmLibrary.allocateNextCode(db)
		if (!/^[A-Za-z0-9_-]+$/.test(code)) {
			return res.status(400).json({ error: 'Charm code may only contain letters, digits, "-" and "_".' })
		}
		let imageFile = ''
		if (b.image_base64) imageFile = charmLibrary.saveCharmImage(config, code, b.image_base64, b.image_ext)
		insertCharmLibraryRow(db, {
			code,
			default_charm_shop: b.default_charm_shop,
			notes: b.notes,
			image_file: imageFile,
		})
		broadcastCatalogRefresh('charm-created')
		res.json({ ok: true, code, ..._charmsPayload() })
	} catch (err) {
		res.status(_supplierErrStatus(err)).json({ error: err.message })
	}
})

/**
 * PUT /api/route/charms — update a charm (incl. renaming its code).
 * Body: { orig_code, code, default_charm_shop?, notes?, image_base64?, image_ext? }
 */
app.put('/api/route/charms', express.json({ limit: '20mb' }), (req, res) => {
	const b = req.body ?? {}
	try {
		const origCode = String(b.orig_code || '').trim()
		const newCode = String(b.code || origCode).trim()
		if (!/^[A-Za-z0-9_-]+$/.test(newCode)) {
			return res.status(400).json({ error: 'Charm code may only contain letters, digits, "-" and "_".' })
		}
		const cur = getCharmByCode(db, origCode)
		if (!cur) return res.status(404).json({ error: 'Charm not found.' })

		// Resolve the resulting image filename across rename / new upload.
		let imageFile = cur.image_file || ''
		if (newCode !== origCode) {
			const renamed = charmLibrary.renameCharmImage(config, origCode, newCode)
			if (renamed) imageFile = renamed
		}
		if (b.image_base64) {
			imageFile = charmLibrary.saveCharmImage(config, newCode, b.image_base64, b.image_ext)
		}

		updateCharmLibraryRow(db, {
			orig_code: origCode,
			code: newCode,
			default_charm_shop: b.default_charm_shop,
			notes: b.notes,
			image_file: imageFile,
		})
		// The charm library is the source of truth for a code → its supplier shop,
		// so a supplier (or code) change here changes what every already-assigned
		// order line resolves to. Tell all live Route/Shopping clients to refetch so
		// the new supplier + stall show up immediately instead of the stale snapshot.
		const shopChanged = b.default_charm_shop != null && String(b.default_charm_shop).trim() !== (cur.default_charm_shop || '')
		if (shopChanged || newCode !== origCode || b.image_base64) broadcastCatalogRefresh('charm-updated')
		res.json({ ok: true, code: newCode, ..._charmsPayload() })
	} catch (err) {
		res.status(_supplierErrStatus(err)).json({ error: err.message })
	}
})

/**
 * DELETE /api/route/charms — remove a charm (and its image file).
 * Body: { code }
 */
app.delete('/api/route/charms', express.json(), (req, res) => {
	const code = String((req.body ?? {}).code || '').trim()
	try {
		const removed = deleteCharmLibraryRow(db, code)
		if (!removed) return res.status(404).json({ error: 'Charm not found.' })
		try {
			charmLibrary.deleteCharmImage(config, code)
		} catch {}
		// Order lines still referencing this code now fall back to their stored
		// snapshot — refetch live views so that resolution change is reflected.
		broadcastCatalogRefresh('charm-deleted')
		res.json({ ok: true, ..._charmsPayload() })
	} catch (err) {
		res.status(_supplierErrStatus(err)).json({ error: err.message })
	}
})

/**
 * POST /api/route/charm-from-supplier
 * "This charm is bought at the same stall as the case/grip."
 *
 * One atomic operation for what is otherwise a four-step manual chore (add the
 * supplier to the charm-shop list → create a charm code → upload its photo →
 * assign it to the line). Body:
 *   { receipt_id, item_key, title?, code?, image_base64?, image_ext?, replace_image? }
 *
 * Why a dedicated endpoint instead of the client chaining the existing CRUD calls:
 *   • ATOMIC — a charm shop created without the assignment landing (or vice versa)
 *     leaves the operator with confusing half-state; here it's one transaction.
 *   • The SUPPLIER IS RESOLVED SERVER-SIDE through the very same enrichment the
 *     dashboard renders from (per-line override → product default → catalog match),
 *     so we can never link a charm to a stale shop name a client happened to hold.
 *   • IDEMPOTENT — clicking twice converges to the same state.
 *
 * The charm library is the single source of truth for a code → its shop (see
 * buildRouteRows), so the shop is written THERE; writing only the per-order
 * snapshot would leave every view still resolving the old shop.
 */
app.post('/api/route/charm-from-supplier', express.json({ limit: '20mb' }), (req, res) => {
	const b = req.body ?? {}
	if (b.receipt_id == null || !b.item_key) {
		return res.status(400).json({ error: 'receipt_id and item_key are required.' })
	}
	const receiptId = Number(b.receipt_id)
	const itemKey = String(b.item_key)
	try {
		// ── 1. Resolve the line (and therefore its EFFECTIVE supplier) ──────────
		let line = null
		try {
			const rows = routeDashboard.buildRouteRows(db, config, {
				receipt_ids: [receiptId],
				enrich_supplier: true,
				include_dismissed: true,
				include_issues: true,
			})
			line = rows.find((r) => r.receipt_id === receiptId && r.item_key === itemKey) || null
		} catch (e) {
			console.error('[route] charm-from-supplier resolve failed:', e.message)
			return res.status(500).json({ error: 'Could not resolve this order line: ' + e.message })
		}
		if (!line) return res.status(404).json({ error: 'Order line not found.' })
		if (!line.has_charm) return res.status(400).json({ error: 'This line has no charm to source.' })
		if (line.charm_integral) {
			return res.status(400).json({ error: 'An AirPods charm ships attached to its case — there is no separate charm to source.' })
		}
		const shopName = String(line.supplier_shop || '').trim()
		if (!shopName) {
			return res.status(400).json({ error: "Set this line's supplier first — there is no shop to link the charm to." })
		}
		const supplierStall = String(line.supplier_stall || '').trim()

		// ── 2. Which charm code? ────────────────────────────────────────────────
		// An explicit choice wins, then the line's CONFIRMED code, else a fresh one.
		// A mere SUGGESTION is deliberately never adopted: it names a specific charm
		// that usually belongs to a different shop, and re-pointing it would move
		// that charm for every product using it.
		let code =
			String(b.code || '')
				.trim()
				.toUpperCase() || String(line.charm_code || '').trim()
		if (!code) code = charmLibrary.allocateNextCode(db)
		if (!/^[A-Za-z0-9_-]+$/.test(code)) {
			return res.status(400).json({ error: 'Charm code may only contain letters, digits, "-" and "_".' })
		}
		const existing = getCharmByCode(db, code)
		const prevShop = existing ? String(existing.default_charm_shop || '').trim() : ''

		// ── 3. Optional photo ───────────────────────────────────────────────────
		// Written before the DB work so the library row can record the filename (the
		// same order POST /api/route/charms uses). A charm code is shared by every
		// product that uses that physical charm, so an EXISTING photo is only
		// replaced when explicitly requested.
		let imageFile = existing ? existing.image_file || '' : ''
		const hadImage = !!charmLibrary.charmImageVersion(config, code, imageFile)
		let imageSaved = false
		if (b.image_base64 && (!hadImage || b.replace_image === true)) {
			imageFile = charmLibrary.saveCharmImage(config, code, b.image_base64, b.image_ext)
			imageSaved = true
		}

		// ── 4. Apply everything, or nothing ─────────────────────────────────────
		// The four coupled writes (charm-shop directory, charm library, this line's
		// assignment, the per-product default) live in charmLibrary.linkCharmToSupplier
		// so they're exercised directly by the regression test.
		const out = charmLibrary.linkCharmToSupplier(db, {
			receipt_id: receiptId,
			item_key: itemKey,
			title: b.title || line.title,
			code,
			shop_name: shopName,
			stall: supplierStall,
			image_file: imageSaved ? imageFile : undefined,
		})
		const assignment = out.assignment

		// Patch this line on every live client, and — because a code's shop lives in
		// the library — tell them to refetch when the mapping itself changed, since
		// that re-resolves OTHER assigned lines (and moves the charm between stalls
		// in the mobile route). Same reasoning as PUT /api/route/charms.
		broadcastRouteEvent({
			type: 'assign',
			receipt_id: assignment.receipt_id,
			item_key: assignment.item_key,
			charm_code: assignment.charm_code,
			charm_shop: assignment.charm_shop,
			status_case: assignment.status_case,
			status_grip: assignment.status_grip,
			status_charm: assignment.status_charm,
			excluded: assignment.excluded,
			updated_at: assignment.updated_at,
			by: (req.auth && req.auth.user) || 'owner',
		})
		if (out.created_charm || out.created_shop || prevShop !== shopName || imageSaved) {
			broadcastCatalogRefresh('charm-from-supplier')
		}

		console.log(`[route] charm ${code} → supplier "${shopName}"${supplierStall ? ' · ' + supplierStall : ''}` + `${out.created_charm ? ' (charm created)' : ''}${out.created_shop ? ' (charm shop created)' : ''}${imageSaved ? ' (photo saved)' : ''}`)

		res.json({
			ok: true,
			...out,
			image_saved: imageSaved,
			image_skipped: !!b.image_base64 && !imageSaved,
			..._charmsPayload(),
		})
	} catch (err) {
		console.error('[route] charm-from-supplier error:', err.message)
		res.status(_supplierErrStatus(err)).json({ error: err.message })
	}
})

/**
 * POST /api/route/charms/resync — reload the charm library from
 * charm_manifest.json (discards in-app charm edits).
 */
app.post('/api/route/charms/resync', (req, res) => {
	try {
		const r = charmLibrary.resyncCharmLibrary(db, config)
		if (!r.ok) return res.status(400).json(r)
		// The whole library was replaced from the manifest — code → supplier
		// mappings may have changed, so refetch all live Route/Shopping views.
		broadcastCatalogRefresh('charm-resynced')
		res.json({ ok: true, ..._charmsPayload() })
	} catch (err) {
		res.status(500).json({ error: err.message })
	}
})

/**
 * POST /api/route/charms/reorder — drag-to-reorder (display order only).
 * Body: { order: [code, ...] } — current codes in the desired visual order.
 * Only each charm's sort_order changes; codes stay put (stable identities), so
 * every image file and charm_code reference — and thus every order's assigned
 * charm — is untouched.
 */
app.post('/api/route/charms/reorder', express.json(), (req, res) => {
	const order = (req.body ?? {}).order
	if (!Array.isArray(order) || !order.length) {
		return res.status(400).json({ error: 'order must be a non-empty array of charm codes.' })
	}
	try {
		// Codes are stable identities: a reorder only re-sorts (sort_order), so it
		// touches no assignment, no supplier resolution and no image file. Nothing
		// on the route rows changes, hence no image rename and no route refresh —
		// only the charm library's display order, returned below for the modal.
		reorderCharmLibrary(db, order)
		res.json({ ok: true, ..._charmsPayload() })
	} catch (err) {
		res.status(_supplierErrStatus(err)).json({ error: err.message })
	}
})

/**
 * GET /api/route/charm-image?code=CH-00001
 * Streams a charm thumbnail from the charm_images directory. Prefers the
 * library's stored image_file, then falls back to <code>.<ext> resolution.
 */
app.get('/api/route/charm-image', (req, res) => {
	const ospDir = enginePaths.engineDir(config)
	const code = (req.query.code || '').trim()
	if (!code) return res.status(404).end()

	// Content-addressed caching. When the URL carries a version token (…&v=TOKEN,
	// derived from the file's mtime+size), the bytes for THAT url can never change
	// — a new photo yields a new token → a new url — so we cache it hard for a
	// year and mark it `immutable`. Requests WITHOUT a version (legacy links, hand-
	// typed urls) must always revalidate so a replaced charm photo is never served
	// stale; the ETag/Last-Modified that `sendFile` emits keep that revalidation a
	// cheap 304. This kills the "every charm shows the same old thumbnail" bug at
	// the root: a stale cache entry can no longer survive a photo swap/renumber.
	const versioned = !!String(req.query.v || '').trim()
	const sendOpts = versioned ? { maxAge: '365d', immutable: true, headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } } : { maxAge: 0, headers: { 'Cache-Control': 'public, max-age=0, must-revalidate' } }

	// Try the library's recorded image_file first.
	try {
		const row = getCharmByCode(db, code)
		const dir = charmLibrary.charmImagesDir(config)
		if (row && row.image_file && dir && !/[/\\]/.test(row.image_file)) {
			const full = path.join(dir, row.image_file)
			try {
				fs.accessSync(full, fs.constants.R_OK)
				return res.sendFile(full, sendOpts)
			} catch {}
		}
	} catch {}

	// Fallback: manifest / <code>.<ext> resolution.
	const full = routeDashboard.resolveCharmImagePath(ospDir, code)
	if (!full) return res.status(404).end()
	res.sendFile(full, sendOpts, (err) => {
		if (err && !res.headersSent) res.status(404).end()
	})
})

// ── Single source of truth for the generated shopping-route Excel files ──────
// Every surface that lists, locks, scans, or links these files derives from
// THIS array, so adding a new output (e.g. the Chinese status workbook) never
// requires touching the lock pre-check, the post-run scan, or the menu again.
// `generated:true` files are (re)written by every route generation run — they
// are lock-probed before the run and overwritten by the Python script.
// `generated:false` files are produced on demand by a separate action (the
// ready-to-ship report is built from the edited checklist) and so are listed +
// openable but NOT touched by — or lock-probed for — a normal generation.
// `group` drives the sectioned "Open files" menu: 'en' = English working
// files (for you), 'zh' = Simplified-Chinese files (for the shopping employee).
const ROUTE_OUTPUT_FILES = [
	{ file: 'shopping_route.xlsx', label: 'Full route', desc: 'Floors · suppliers · orders', icon: '📄', generated: true, group: 'en' },
	{ file: 'shopping_route_simple.xlsx', label: 'Simple route', desc: 'Compact supplier checklist', icon: '🧾', generated: true, group: 'en' },
	{ file: 'shopping_route_zh.xlsx', label: 'Shopping route', desc: '简化版购物路线', icon: '🛍️', generated: true, group: 'zh' },
	{ file: 'shopping_route_zh_status.xlsx', label: 'Route + status', desc: '含 手机壳 / 支架 / 挂件 状态', icon: '📝', generated: true, group: 'zh' },
]
// Just the filenames, for membership checks / lock probing.
const ROUTE_OUTPUT_XLSX = ROUTE_OUTPUT_FILES.map((s) => s.file)
// Subset (re)written by a normal route generation — used for the pre-flight
// lock check so an open route file never blocks route generation.
const ROUTE_GENERATED_XLSX = ROUTE_OUTPUT_FILES.filter((s) => s.generated).map((s) => s.file)

/**
 * POST /api/route/generate
 * Body: { date_from?, date_to?, shop_id?, chinese?, html?, purge_purchased? }
 *
 * Exports pending orders from the DB to a temp JSON file, then spawns the
 * Orders Sorting Program Python script with --import-json pointing at that
 * file.  Returns immediately (202) while the child process runs in the
 * background.  Poll GET /api/route/status for progress.
 */
app.post('/api/route/generate', express.json(), async (req, res) => {
	if (_routeJob.status === 'running') {
		return res.status(409).json({ error: 'A route generation is already in progress.' })
	}

	// Claim the lock synchronously — before any await — so a second concurrent
	// request can't slip through the guard above during async image-fetching.
	// Any early-exit error path below resets status to 'error' so the UI doesn't
	// get stuck in a permanently-locked state.
	_routeJob = { status: 'running', log: [], startedAt: new Date().toISOString(), finishedAt: null, outputDir: null, files: [], error: null }

	const ospDir = enginePaths.engineDir(config)
	if (!ospDir) {
		_routeJob.status = 'error'
		_routeJob.error = 'Route engine directory could not be resolved.'
		_routeJob.finishedAt = new Date().toISOString()
		return res.status(400).json({ error: _routeJob.error })
	}

	const ospScript = enginePaths.engineScript(config)
	try {
		fs.accessSync(ospScript, fs.constants.R_OK)
	} catch {
		_routeJob.status = 'error'
		_routeJob.error = `Route engine script not found: ${ospScript}`
		_routeJob.finishedAt = new Date().toISOString()
		return res.status(400).json({ error: _routeJob.error })
	}

	const { date_from, date_to, shop_id, extra_receipt_ids: rawExtraIds } = req.body ?? {}

	// Parse comma-separated or array of receipt IDs forwarded from the client.
	// These are orders the operator pinned via "Send to Route" (pre-transit /
	// shipped) or the "+ Add Order" modal — they live outside the default
	// pending-only scope so they must be passed explicitly to ensure the
	// generated Excel files match exactly what the Route dashboard displays.
	const extraIds = Array.isArray(rawExtraIds)
		? rawExtraIds.map(Number).filter(Number.isInteger)
		: typeof rawExtraIds === 'string' && rawExtraIds.trim()
			? rawExtraIds
					.split(',')
					.map((s) => parseInt(s.trim(), 10))
					.filter(Number.isInteger)
			: []

	// ── Build route rows (orders × their saved charm/status assignments) ───────
	// enrich_supplier:true makes these rows IDENTICAL to what the operator sees
	// in the Route dashboard (catalog match + manual overrides), so the generated
	// Excel files carry the exact same supplier/stall placement — no divergence.
	// Helper to fail fast: release the lock and send an error response.
	const failEarly = (statusCode, message) => {
		_routeJob.status = 'error'
		_routeJob.error = message
		_routeJob.finishedAt = new Date().toISOString()
		return res.status(statusCode).json({ error: message })
	}

	let rows
	try {
		rows = routeDashboard.buildRouteRows(db, config, {
			date_from,
			date_to,
			shop_id,
			include_shipped: false,
			enrich_supplier: true,
			...(extraIds.length ? { extra_receipt_ids: extraIds } : {}),
		})
	} catch (err) {
		return failEarly(500, `DB error: ${err.message}`)
	}

	// ── Single source of truth: per-line route_assignments.status_charm ────────
	// Charm purchase state lives in ONE place — the per-line `status_charm`
	// column the operator edits directly (Route-tab dropdown, Orders-tab chip,
	// or the "Charms to Buy" stepper, which writes through to these same lines).
	// The generator therefore consumes those per-line statuses verbatim.
	//
	// HISTORY / ROOT CAUSE (do not re-introduce): a prior version re-derived the
	// per-line statuses here from a SEPARATE, independently-stored counter
	// (`charm_purchase_progress`) and persisted the result back over the lines.
	// That second store silently drifted from the lines — e.g. it kept a stale
	// `0` once a charm had ever been toggled to Pending in the modal — so every
	// charm the operator marked Purchased via the dropdown was reset to Pending
	// the next time a route was generated (and then surfaced as reverted in the
	// Orders tab too). Treating the per-line status as the only source of truth
	// eliminates that entire class of bug. See dashboard.js for the removed
	// reconcile helper's rationale.

	// ── The route MUST mirror the dashboard's "to shop" set exactly ───────────
	// The Orders Sorting Dashboard headline ("N orders / M items to shop") hides
	// two buckets that need no shopping: rows the operator EXCLUDED, and rows that
	// are FULLY PURCHASED (every component already bought). The generated route is
	// a shopping list, so it must contain the SAME set — otherwise the operator
	// sees "63 orders to shop" but the Excel prints 100+ orders, re-listing things
	// already in hand. We therefore drop both buckets here. `fully_purchased` is
	// computed by the shared helper so it stays byte-identical with the dashboard
	// summary + client view.
	// A line awaiting a wrong-model exchange only holds its CASE out of buying (we
	// already have it, to swap in person); its grip/charm must still be sourced.
	// We therefore keep exchange lines here and let rowsToImportOrders project them
	// down to just the still-buyable pieces (a pure case-only swap drops out there).
	const shoppingRows = rows.filter((r) => !r.excluded && (r.needs_exchange ? routeDashboard.rowHasShoppingWork(r) : !routeDashboard.rowFullyPurchased(r)))
	const exportedOrders = routeDashboard.rowsToImportOrders(shoppingRows)

	if (exportedOrders.length === 0) {
		return failEarly(400, 'Nothing to shop — every order in scope is already fully purchased or excluded.')
	}

	// Route files are generated INTO this dashboard's own folder (not the OSP's).
	const outputDir = _routeOutputDir()
	const outputXlsx = path.join(outputDir, 'shopping_route.xlsx')
	try {
		fs.mkdirSync(outputDir, { recursive: true })
	} catch (err) {
		return failEarly(500, `Cannot create output directory: ${err.message}`)
	}

	// ── Pre-flight: refuse to start if a target route file is locked ──────────
	// A generated workbook left OPEN in Excel holds an exclusive write lock on
	// Windows, so the Python save crashes with PermissionError part-way through —
	// the full/simple files get overwritten while the _zh file is left STALE.
	// That is the real reason "I regenerate but the Excel never changes". Detect
	// it up front and return one clear, actionable message instead of burning a
	// full generation and surfacing a raw traceback.
	const _lockedFiles = ROUTE_GENERATED_XLSX.filter((name) => {
		const fp = path.join(outputDir, name)
		let fd
		try {
			fd = fs.openSync(fp, 'r+') // read+write, no truncate — same access wb.save needs
			return false // opened cleanly → not locked
		} catch (err) {
			if (err.code === 'ENOENT') return false // doesn't exist yet → writable
			return ['EBUSY', 'EPERM', 'EACCES'].includes(err.code) // locked
		} finally {
			if (fd !== undefined) {
				try {
					fs.closeSync(fd)
				} catch {
					/* ignore */
				}
			}
		}
	})
	if (_lockedFiles.length) {
		return failEarly(409, `Close ${_lockedFiles.join(', ')} in Excel, then click Generate again — ` + `the file is open and cannot be overwritten.`)
	}

	// ── Embed product photos into the JSON payload ────────────────────────────
	// OSP runs in --import-json mode and has no access to the Etsy CDN, so we
	// must supply image bytes directly.  We gather each unique listing_id → URL
	// from the route rows, fetch bytes in parallel (DB cache-first), encode as
	// base64, and attach as `image_b64` on each item.  The OSP then decodes this
	// into `photo_bytes`.  This image — the exact listing photo the dashboard
	// renders in its own order gallery — is the SINGLE SOURCE OF TRUTH for the
	// route: in --import-json mode the OSP's catalog-photo step only fills in
	// items that arrive WITHOUT an image and never overrides a supplied one, so
	// the route Excel always shows the same per-order photo as this dashboard.
	try {
		// Build a deduped Map<listing_id, image_url> from the to-shop row set
		// (shoppingRows carry listing_id + image_url, and match exportedOrders so we
		// never fetch images for items that won't appear in the route).
		const listingIdToUrl = new Map()
		for (const row of shoppingRows) {
			if (row.listing_id && row.image_url && !listingIdToUrl.has(row.listing_id)) {
				listingIdToUrl.set(row.listing_id, row.image_url)
			}
		}

		const imageDataMap = listingIdToUrl.size > 0 ? await batchFetchRouteImages(db, listingIdToUrl) : new Map()

		for (const order of exportedOrders) {
			for (const item of order.items) {
				// 1. Etsy listing image (catalog products + catalog-picked manual items).
				if (item._listing_id) {
					const buf = imageDataMap.get(item._listing_id)
					if (buf) item.image_b64 = buf.toString('base64')
				}
				// 2. Uploaded custom-product image (manual items with no listing id).
				if (!item.image_b64 && item._manual_id != null) {
					try {
						const img = getManualItemImage(db, item._manual_id)
						if (img) item.image_b64 = img.data.toString('base64')
					} catch {
						/* non-fatal — item just has no photo */
					}
				}
			}
		}
	} catch (err) {
		// Non-fatal: log and continue without images rather than blocking generation.
		console.warn(`[route] Image fetch failed (route will have no photos): ${err.message}`)
	} finally {
		// Always strip internal UED keys so the OSP never sees them.
		for (const order of exportedOrders) {
			for (const item of order.items) {
				delete item._listing_id
				delete item._manual_id
			}
		}
	}

	// ── Write OSP's status cache so it knows what's already Purchased / OOS ────
	// The generator reads this from the SAME folder it writes the Excel files to,
	// so it must live in our output dir alongside shopping_route.xlsx.
	let statusCacheInfo = { count: 0 }
	try {
		statusCacheInfo = routeDashboard.writeStatusCache(outputDir, shoppingRows)
	} catch (err) {
		return failEarly(500, `Cannot write status cache: ${err.message}`)
	}

	// ── Write temp JSON order payload, then spawn Python ───────────────────────
	const tmpFile = path.join(os.tmpdir(), `ued_route_${Date.now()}.json`)
	try {
		fs.writeFileSync(
			tmpFile,
			JSON.stringify(
				{
					orders: exportedOrders,
					exported_at: new Date().toISOString(),
				},
				null,
				2,
			),
		)
	} catch (err) {
		return failEarly(500, `Cannot write temp file: ${err.message}`)
	}

	// Always produce all three Excel files, matching a standard OSP run:
	//   shopping_route.xlsx · shopping_route_simple.xlsx · shopping_route_zh.xlsx
	// (--chinese adds the _zh file; the full + simple files are always written.)
	//
	// --project-dir selects the vendored engine code/layout. --data-dir keeps the
	// mutable catalog DB/workbook/images independently relocatable outside a
	// cloud-synced source tree.
	// --output redirects the three route files into THIS dashboard's folder.
	//
	// --reset makes the dashboard the SINGLE SOURCE OF TRUTH: the route is built
	// purely from this export (images, supplier + charm overrides included) and
	// is NOT merged with OSP's accumulating order cache. Without it, OSP merges
	// these orders with its stale cache — inflating the order count (e.g. 130 vs
	// 83) and discarding the fresh images/overrides because the orders "already
	// exist" in the cache. Purchase statuses are preserved separately via the
	// route_statuses_cache.json overlay, so --reset does not lose progress.
	// --no-catalog-update: the dashboard is the single source of truth for the
	// catalog (it edits products via its own UI and reads the SQLite mirror), so
	// the generator must NOT load + re-save + back up the multi-MB supplier
	// catalog workbook on every run. Skipping those writes (and the structural
	// sheet-init that also loads the workbook) is the single biggest speedup and
	// removes the per-run backup bloat. Route output is unchanged because all
	// supplier/charm values are supplied in the import payload + SQLite reads.
	//
	// --reset: build the route purely from THIS export — never merged with any
	// previously cached orders — so the Excel contains exactly the orders in the
	// current Orders Sorting Dashboard and nothing carried over from prior runs.
	const pyArgs = [ospScript, '--project-dir', ospDir, '--data-dir', enginePaths.engineDataDir(config), '--import-json', tmpFile, '--output', outputXlsx, '--reset', '--no-catalog-update', '--chinese']

	// ── Mirror the dashboard's authoritative charm mappings into the engine DB ─
	// The generator reads charm code → shop (charm_library) and shop → stall
	// (charm_shops) from its OWN copies inside route-engine/data/etsy_orders.db
	// and forces them onto every line. Those copies are seeded once and never
	// updated when the operator edits a charm in-app, so they drift — making the
	// generated Excel show a stale charm shop/stall (e.g. CH-00037 → 壳引力 / A2-33)
	// while the dashboard correctly shows 小艾飾品 / 2D41-43. Push the authoritative
	// dashboard tables across BEFORE generation so both outputs agree. Non-fatal:
	// a failed sync just falls back to the engine's existing (possibly stale) data.
	let charmSyncInfo = { ok: false, charms: 0, shops: 0 }
	try {
		charmSyncInfo = routeDashboard.syncCharmTablesToEngine(db, config)
		if (!charmSyncInfo.ok) {
			console.warn(`[route] charm table sync to engine skipped: ${charmSyncInfo.reason}`)
		}
	} catch (err) {
		console.warn(`[route] charm table sync to engine failed (non-fatal): ${err.message}`)
	}

	// Release the dashboard's cached read-only handle on the engine database so
	// the generator has exclusive access to checkpoint/compact its WAL while it
	// rewrites the order cache. The handle re-opens lazily on the next request.
	try {
		routeDashboard.closeOspCatalog()
	} catch {
		/* non-fatal */
	}

	// Populate the log now that we have all the details (pyArgs, counts, etc.).
	// The job object was already created above to claim the lock; here we just
	// append the initial log lines and send the 202 response.
	const lineItemCount = exportedOrders.reduce((s, o) => s + o.items.length, 0)
	_routeJob.log.push(`[${new Date().toISOString()}] Starting route generation for ${exportedOrders.length} order(s), ${lineItemCount} line item(s)…`, ...(charmSyncInfo.ok ? [`[charm] Synced ${charmSyncInfo.charms} charm code(s) + ${charmSyncInfo.shops} charm shop(s) to engine DB (dashboard is source of truth)`] : []), `[cache] Wrote ${statusCacheInfo.count} purchase-status entr${statusCacheInfo.count === 1 ? 'y' : 'ies'} to route_statuses_cache.json`, `[cmd] ${enginePaths.enginePython(config)} ${pyArgs.join(' ')}`)

	res.status(202).json({ status: 'started', order_count: exportedOrders.length, item_count: lineItemCount })

	const proc = spawn(enginePaths.enginePython(config), pyArgs, {
		cwd: ospDir,
		env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
	})

	const addLog = (line) => {
		_routeJob.log.push(line)
	}

	proc.stdout.on('data', (chunk) => chunk.toString('utf8').split('\n').filter(Boolean).forEach(addLog))
	proc.stderr.on('data', (chunk) =>
		chunk
			.toString('utf8')
			.split('\n')
			.filter(Boolean)
			.forEach((l) => addLog(`[stderr] ${l}`)),
	)

	proc.on('error', (err) => {
		try {
			fs.unlinkSync(tmpFile)
		} catch {}
		_routeJob.status = 'error'
		_routeJob.error = err.message
		_routeJob.finishedAt = new Date().toISOString()
		addLog(`[error] Failed to start Python: ${err.message}`)
		console.error('[route] spawn error:', err.message)
	})

	proc.on('close', (code) => {
		try {
			fs.unlinkSync(tmpFile)
		} catch {}

		if (code === 0) {
			let files = []
			try {
				const _allowed = new Set(ROUTE_OUTPUT_XLSX.map((n) => n.toLowerCase()))
				files = fs
					.readdirSync(outputDir)
					.filter((f) => _allowed.has(f.toLowerCase()))
					.map((f) => {
						const fp = path.join(outputDir, f)
						const stat = fs.statSync(fp)
						return { name: f, path: fp, size: stat.size, modified: stat.mtimeMs }
					})
					.sort((a, b) => b.modified - a.modified)
			} catch {}

			_routeJob.status = 'done'
			_routeJob.finishedAt = new Date().toISOString()
			_routeJob.outputDir = outputDir
			_routeJob.files = files
			addLog(`[done] Generation complete — ${files.length} file(s) ready.`)
			files.forEach((f) => addLog(`[file] ${f.name}  (${(f.size / 1024).toFixed(1)} KB)`))
		} else {
			// If a route file was locked (opened in Excel during the run), the engine
			// emits a recognisable ROUTE_OUTPUT_LOCKED line — surface that verbatim
			// instead of the opaque "exited with code 1".
			const lockLine = _routeJob.log.find((l) => l.includes('ROUTE_OUTPUT_LOCKED'))
			_routeJob.status = 'error'
			_routeJob.error = lockLine ? lockLine.replace(/^.*ROUTE_OUTPUT_LOCKED:\s*/, '').trim() : `Python exited with code ${code}`
			_routeJob.finishedAt = new Date().toISOString()
			addLog(`[error] ${_routeJob.error}`)
		}

		console.log(`[route] Job finished — status: ${_routeJob.status}`)
	})
})

/**
 * Directory the generated shopping-route files live in.
 *
 * The Python generator runs against the OSP project (catalog, charm images,
 * caches) but we redirect its OUTPUT into THIS dashboard's own folder so the
 * three Excel files belong to the dashboard, not the OSP.  Configurable via
 * `osp_output_dir`; defaults to <dashboard root>/output.
 */
function _routeOutputDir() {
	if (config.osp_output_dir && String(config.osp_output_dir).trim()) {
		return path.resolve(String(config.osp_output_dir).trim())
	}
	return path.join(UED_ROOT, 'output')
}
function _isAllowedRouteFile(name) {
	return /^shopping_route(_simple|_zh_status|_zh)?\.(xlsx|html)$/i.test(name) && !/[/\\]/.test(name)
}

/**
 * GET /api/route/output-files
 * Lists the standard shopping-route Excel files and whether each exists.
 */
app.get('/api/route/output-files', (req, res) => {
	const dir = _routeOutputDir()
	if (!dir) return res.json({ files: ROUTE_OUTPUT_FILES.map((s) => ({ ...s, exists: false })) })
	const files = ROUTE_OUTPUT_FILES.map((spec) => {
		const fp = path.join(dir, spec.file)
		try {
			const st = fs.statSync(fp)
			return { ...spec, exists: true, size: st.size, modified: st.mtimeMs }
		} catch {
			return { ...spec, exists: false }
		}
	})
	res.json({ files })
})

/**
 * POST /api/route/import-status
 * Body: { data_b64 }  — base64 of an employee-edited shopping_route_zh_status.xlsx
 *
 * Reads the per-component purchase statuses an employee recorded in the Chinese
 * status workbook and writes them straight back into `route_assignments` — the
 * SAME table the Route tab edits and the Orders tab reads for its
 * "needs shipping / pre-transit" purchasing rollup. After applying the edits we
 * re-roll each affected order's needs_purchase flag, so a pre-transit order that
 * is now fully bought drops out of the buy queue automatically (and one that
 * still has outstanding work stays in it).
 *
 * The workbook must have been produced by the current generator, which embeds a
 * hidden machine-readable key column on every row (see src/route/status-import.js
 * and generate_shopping_route.py). Older files without that column cannot be
 * mapped back to orders — the caller is told to regenerate the route first.
 */
app.post('/api/route/import-status', express.json({ limit: '60mb' }), (req, res) => {
	const { data_b64 } = req.body ?? {}
	if (!data_b64 || !String(data_b64).trim()) {
		return res.status(400).json({ error: 'No file uploaded.' })
	}

	let buf
	try {
		buf = Buffer.from(String(data_b64).replace(/^data:[^,]*,/, ''), 'base64')
	} catch {
		return res.status(400).json({ error: 'Uploaded file data is not valid base64.' })
	}
	if (!buf || buf.length === 0) return res.status(400).json({ error: 'Uploaded file is empty.' })
	// .xlsx files are ZIP archives — verify the "PK" magic to reject bad uploads early.
	if (!(buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b)) {
		return res.status(400).json({ error: 'Uploaded file is not a valid .xlsx workbook.' })
	}

	let parsed
	try {
		parsed = statusImport.parseStatusWorkbook(buf)
	} catch (err) {
		return res.status(400).json({ error: `Could not parse the workbook: ${err.message}` })
	}

	if (!parsed.hasKeyColumn) {
		return res.status(422).json({
			error: 'This file is missing the embedded order key — it was generated by an older ' + 'version. Click “Generate route” once to produce an importable ' + 'shopping_route_zh_status.xlsx, then have your employee edit and upload that.',
		})
	}

	const STATUS_OK = new Set(routeDashboard.STATUS_OPTIONS)

	// Merge precedence for a SINGLE component when the same physical line appears
	// more than once in the workbook (the generator can list one line in both the
	// routable and the "unmatched" section). A deliberate edit must never be lost
	// to a default: 'Pending' (the unedited default) never clobbers a real status,
	// and when two deliberate statuses disagree the later one in sheet order wins.
	const mergeStatus = (existing, incoming) => {
		if (!incoming || !STATUS_OK.has(incoming)) return existing || null
		if (!existing) return incoming
		if (existing === 'Pending') return incoming
		if (incoming === 'Pending') return existing
		return incoming
	}

	// Coalesce every workbook row into ONE patch per (receipt_id, item_key) so a
	// line carrying Case + Grip (Section 1) and a Charm (Section 2 aggregate) is
	// written once with all three components — and duplicates collapse cleanly.
	const lineMap = new Map() // `${rid}\u0000${key}` → { receipt_id, item_key, status_case, status_grip, status_charm }
	const getLine = (rid, key) => {
		const k = `${rid}\u0000${key}`
		let o = lineMap.get(k)
		if (!o) {
			o = { receipt_id: rid, item_key: key, status_case: null, status_grip: null, status_charm: null }
			lineMap.set(k, o)
		}
		return o
	}

	for (const ln of parsed.lines) {
		const o = getLine(ln.receipt_id, ln.item_key)
		o.status_case = mergeStatus(o.status_case, ln.status_case)
		o.status_grip = mergeStatus(o.status_grip, ln.status_grip)
	}

	// Charm aggregates need LOSS-SAFE handling. The status workbook collapses
	// every line that shares a charm code into ONE row, so the cell can only be
	// "Purchased" when EVERY constituent is already bought — a partially-bought
	// charm (e.g. 3 of 5) therefore renders as "Pending". Blindly stamping that
	// Pending back onto all lines (or zeroing the stepper) would wipe the 3 real
	// purchases. So:
	//   • Purchased            → mark every constituent Purchased + stepper = full
	//                            qty (a clear, forward "all in hand" decision).
	//   • Out of Stock / Out of Production → apply only to constituents NOT
	//                            already Purchased (never downgrade completed work).
	//   • Pending              → NO-OP. The aggregate cannot distinguish "reset"
	//                            from "partially done / untouched default", so we
	//                            never let it undo per-line progress. (Use the
	//                            dashboard to reset an individual charm.)
	const _curCharm = db.prepare('SELECT status_charm FROM route_assignments WHERE receipt_id = ? AND item_key = ?')
	const charmProgress = [] // { code, qty } to persist after the line writes
	let updatedCharms = 0
	for (const ch of parsed.charms) {
		if (!ch.status || !STATUS_OK.has(ch.status) || ch.status === 'Pending') continue
		let totalQty = 0
		let codeTouched = false
		for (const entry of Array.isArray(ch.lines) ? ch.lines : []) {
			const rid = Number(Array.isArray(entry) ? entry[0] : null)
			const key = Array.isArray(entry) ? String(entry[1] ?? '') : ''
			const qty = Array.isArray(entry) ? Math.max(1, Math.floor(Number(entry[2]) || 1)) : 1
			if (!Number.isInteger(rid) || !key) continue
			if (ch.status !== 'Purchased') {
				// Out of Stock / Out of Production — preserve any already-bought line.
				let cur
				try {
					cur = _curCharm.get(rid, key)
				} catch {
					cur = null
				}
				if (cur && cur.status_charm === 'Purchased') continue
			}
			const o = getLine(rid, key)
			o.status_charm = mergeStatus(o.status_charm, ch.status)
			totalQty += qty
			codeTouched = true
		}
		if (codeTouched) {
			updatedCharms++
			if (ch.status === 'Purchased') charmProgress.push({ code: ch.code, qty: totalQty })
		}
	}

	// ── Snapshot the BEFORE state so the report can show real before→after diffs.
	//    A row counts as "updated" only when a component status actually changed —
	//    re-uploading an unchanged file produces an honest "0 orders updated".
	const _curLine = db.prepare('SELECT status_case, status_grip, status_charm FROM route_assignments WHERE receipt_id = ? AND item_key = ?')
	const beforeLine = new Map() // `${rid}\u0000${key}` → prior statuses (or {})
	for (const o of lineMap.values()) {
		let cur = null
		try {
			cur = _curLine.get(o.receipt_id, o.item_key)
		} catch {
			cur = null
		}
		beforeLine.set(`${o.receipt_id}\u0000${o.item_key}`, cur || {})
	}

	// Resolve human-friendly metadata (shop, buyer, product titles) + the prior
	// needs-purchase flag — captured BEFORE the rollup so we can report which
	// orders were cleared from the buy queue.
	const affectedIds = [...new Set([...lineMap.values()].map((o) => o.receipt_id))]
	const posIds = affectedIds.filter((id) => id > 0)
	const metaById = new Map()
	const titleByLine = new Map()
	const listingByLine = new Map() // `${rid}\u0000${key}` → listing_id (for product photos)
	if (posIds.length) {
		const ph = posIds.map(() => '?').join(',')
		db.prepare(
			`SELECT r.receipt_id, r.name AS buyer_name, r.needs_purchase_at, r.is_shipped,
              r.carrier_confirmed_at, r.all_transactions, s.shop_name
       FROM receipts r JOIN shops s ON s.shop_id = r.shop_id
       WHERE r.receipt_id IN (${ph})`,
		)
			.all(posIds)
			.forEach((r) => {
				metaById.set(r.receipt_id, r)
				let txs = []
				try {
					txs = JSON.parse(r.all_transactions || '[]')
				} catch {
					txs = []
				}
				for (const t of txs) {
					const k = routeDashboard.lineItemKey(t.title || '', t.listing_id)
					const lk = `${r.receipt_id}\u0000${k}`
					if (!titleByLine.has(lk)) titleByLine.set(lk, (t.title || '').trim())
					const lid = t.listing_id != null ? Number(t.listing_id) : null
					if (Number.isInteger(lid) && !listingByLine.has(lk)) listingByLine.set(lk, lid)
				}
			})
	}
	// Manual route entries (synthetic non-positive receipt ids). A manual order
	// can carry several products, so the sidecars are keyed PER LINE — keying
	// them by receipt_id alone would make every line of the order inherit the
	// last sidecar's photo. `manualOrderMeta` keeps the first sidecar per order
	// purely for the order-level shop name.
	const manualByLine = new Map()
	const manualOrderMeta = new Map()
	try {
		for (const m of getManualItems(db)) {
			const lk = `${m.receipt_id}\u0000${m.item_key}`
			manualByLine.set(lk, m)
			if (!manualOrderMeta.has(m.receipt_id)) manualOrderMeta.set(m.receipt_id, m)
			titleByLine.set(lk, m.title || '')
			const lid = m.listing_id != null ? Number(m.listing_id) : null
			if (Number.isInteger(lid)) listingByLine.set(lk, lid)
		}
	} catch {
		/* manual items optional */
	}

	const affected = new Set()
	let upsertedLines = 0

	try {
		const applyAll = db.transaction(() => {
			for (const o of lineMap.values()) {
				const patch = { receipt_id: o.receipt_id, item_key: o.item_key }
				let touched = false
				if (o.status_case) {
					patch.status_case = o.status_case
					touched = true
				}
				if (o.status_grip) {
					patch.status_grip = o.status_grip
					touched = true
				}
				if (o.status_charm) {
					patch.status_charm = o.status_charm
					touched = true
				}
				if (!touched) continue
				upsertRouteAssignment(db, patch)
				// Bridge terminal statuses arriving from the field (Excel / paper route)
				// to the fulfilment-issue workflow, so a shopper's "Out of Production"
				// mark surfaces as an on-hold issue no matter which surface recorded it.
				syncAssignmentIssue(o.receipt_id, o.item_key)
				affected.add(o.receipt_id)
				upsertedLines++
			}
			for (const cp of charmProgress) {
				try {
					setCharmPurchaseProgress(db, cp.code, cp.qty)
				} catch {
					/* progress is best-effort — never abort the import for it */
				}
			}
		})
		applyAll()
	} catch (err) {
		console.error('[route] import-status error:', err.message)
		return res.status(500).json({ error: `Failed to apply statuses: ${err.message}` })
	}

	// Re-roll each affected Etsy order's purchasing flag so the Orders tab's
	// needs-shipping / pre-transit views reflect the new statuses immediately.
	// Manual route entries use synthetic non-positive ids and have no Etsy
	// shipment, so they are excluded from the rollup.
	const outstandingAfter = new Map()
	let manualLines = 0
	for (const rid of affected) {
		if (rid <= 0) {
			manualLines++
			continue
		}
		try {
			outstandingAfter.set(rid, recomputeNeedsPurchaseRollup(rid))
		} catch {
			outstandingAfter.set(rid, true)
		}
	}

	// ── Build the per-order change report (only orders with a real change) ──────
	const COMP_LABEL = { case: 'Case', grip: 'Grip', charm: 'Charm' }
	const reportByOrder = new Map()
	let changedLines = 0
	for (const o of lineMap.values()) {
		const lk = `${o.receipt_id}\u0000${o.item_key}`
		const before = beforeLine.get(lk) || {}
		const changes = []
		for (const comp of ['case', 'grip', 'charm']) {
			const to = o[`status_${comp}`]
			if (!to) continue
			const from = before[`status_${comp}`] || 'Pending'
			if (from === to) continue
			changes.push({ component: comp, label: COMP_LABEL[comp], from, to })
		}
		if (!changes.length) continue
		changedLines++
		let entry = reportByOrder.get(o.receipt_id)
		if (!entry) {
			const meta = metaById.get(o.receipt_id)
			const man = manualOrderMeta.get(o.receipt_id)
			entry = {
				order_number: String(o.receipt_id),
				is_manual: o.receipt_id <= 0,
				shop_name: meta ? meta.shop_name : man ? man.shop_name || 'Manual entry' : 'Manual entry',
				buyer_name: meta ? meta.buyer_name || '' : '',
				lines: [],
				now_fully_purchased: false,
				cleared_from_queue: false,
			}
			reportByOrder.set(o.receipt_id, entry)
		}
		const lid = listingByLine.has(lk) ? listingByLine.get(lk) : null
		const manLine = manualByLine.get(lk)
		entry.lines.push({
			title: titleByLine.get(lk) || o.item_key,
			listing_id: lid,
			image_url: lid ? `/api/route/listing-image/${lid}` : manLine && manLine.has_image_data ? `/api/route/manual-image/${manLine.id}?v=${manLine.updated_at || manLine.created_at || 0}` : null,
			changes,
		})
	}

	// Per-order outcomes (ready-to-ship, cleared from the buy queue).
	let becameReady = 0
	let clearedFromQueue = 0
	for (const [rid, entry] of reportByOrder) {
		if (rid <= 0) continue // manual: no Etsy shipment lifecycle
		const meta = metaById.get(rid)
		const wasFlagged = !!(meta && meta.needs_purchase_at)
		const outstanding = outstandingAfter.has(rid) ? outstandingAfter.get(rid) : true
		entry.now_fully_purchased = !outstanding
		if (!outstanding) becameReady++
		if (wasFlagged && !outstanding) {
			entry.cleared_from_queue = true
			clearedFromQueue++
		}
	}

	// Sort: orders that became ready first, then by order number — the most
	// actionable rows (ready to ship / cleared from the queue) surface at the top.
	const orders = [...reportByOrder.values()].sort((a, b) => {
		if (a.now_fully_purchased !== b.now_fully_purchased) return a.now_fully_purchased ? -1 : 1
		return String(a.order_number).localeCompare(String(b.order_number))
	})

	// ── Resulting-state confirmation (independent of this upload's delta) ───────
	// A change report alone is confusing when an unchanged file is re-uploaded
	// ("0 updated" reads like nothing happened). So we ALSO report the resulting
	// fulfillment state of EVERY Etsy order represented in the file: how many are
	// now fully purchased / ready to ship vs. still have items to buy. This gives
	// a positive, actionable confirmation even when the delta is zero — mirroring
	// how mature bulk-import tools acknowledge an already-synced upload.
	const fileOrderIds = [...new Set([...lineMap.values()].map((o) => o.receipt_id).filter((id) => id > 0))]
	const readyOrdersList = []
	let outstandingInFile = 0
	for (const rid of fileOrderIds) {
		let outstanding
		if (outstandingAfter.has(rid)) outstanding = outstandingAfter.get(rid)
		else {
			try {
				outstanding = orderHasOutstanding(rid)
			} catch {
				outstanding = true
			}
		}
		if (outstanding) {
			outstandingInFile++
			continue
		}
		const meta = metaById.get(rid)
		// First product photo + title for the order, for the report thumbnails / Excel.
		let firstListing = null
		let firstTitle = ''
		if (meta) {
			try {
				const txs = JSON.parse(meta.all_transactions || '[]')
				for (const t of txs) {
					if (!firstTitle && t.title) firstTitle = String(t.title).trim()
					if (firstListing == null && t.listing_id != null && Number.isInteger(Number(t.listing_id))) {
						firstListing = Number(t.listing_id)
					}
					if (firstListing != null && firstTitle) break
				}
			} catch {
				/* leave blank */
			}
		}
		readyOrdersList.push({
			order_number: String(rid),
			shop_name: meta ? meta.shop_name : '',
			buyer_name: meta ? meta.buyer_name || '' : '',
			product: firstTitle,
			image_listing_id: firstListing,
			image_url: firstListing ? `/api/route/listing-image/${firstListing}` : null,
			changed: reportByOrder.has(rid),
		})
	}
	readyOrdersList.sort((a, b) => String(a.order_number).localeCompare(String(b.order_number)))

	const summary = {
		updated_orders: orders.length,
		updated_lines: changedLines,
		updated_charms: updatedCharms,
		became_ready: becameReady,
		cleared_from_queue: clearedFromQueue,
		manual_lines: manualLines,
		lines_processed: upsertedLines,
		// Resulting state across the whole file (not just this upload's delta).
		orders_in_file: fileOrderIds.length,
		ready_in_file: readyOrdersList.length,
		outstanding_in_file: outstandingInFile,
	}

	const payload = {
		ok: true,
		generated_at: new Date().toISOString(),
		file: typeof req.body?.filename === 'string' ? req.body.filename : null,
		summary,
		orders,
		ready: readyOrdersList,
		warnings: parsed.warnings || [],
		// Back-compat flat fields (older clients / scripts).
		updated_lines: changedLines,
		updated_charms: updatedCharms,
		affected_orders: orders.length,
		ready_orders: becameReady,
		manual_lines: manualLines,
	}

	// ── Version control: persist this sync as an immutable audit record so the
	//    owner can always trace back which orders were purchased, when, and from
	//    which file. Best-effort — a logging failure never blocks the import.
	try {
		payload.run_id = recordPurchaseSyncRun(db, {
			file_name: payload.file,
			summary,
			payload,
		})
	} catch (err) {
		console.warn('[route] purchase-sync history write failed:', err.message)
	}

	res.json(payload)
})

/**
 * GET /api/route/listing-image/:id[?w=300]
 * Serves a product photo for the shopping route and purchase-sync report.
 * Prefers locally cached JPEG/PNG bytes (listing_image_data); on a cache miss
 * fetches from the Etsy CDN server-side, persists, then streams the bytes.
 * Optional ?w= resizes for card thumbnails. Returns 404 when no image exists.
 */
app.get('/api/route/listing-image/:id', async (req, res) => {
	const id = parseInt(req.params.id, 10)
	if (!Number.isInteger(id)) return res.status(400).end()
	try {
		const data = await ensureListingImageBytes(db, id)
		if (!data || !data.length) return res.status(404).end()

		const width = thumbnails.normaliseWidth(req.query.w)
		if (width) {
			try {
				const resized = await sharp(data).rotate().resize(width, width, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer()
				res.setHeader('Content-Type', 'image/jpeg')
				res.setHeader('Cache-Control', 'private, max-age=86400')
				return res.send(resized)
			} catch (err) {
				console.warn(`[route] listing-image ${id} resize failed, serving original:`, err.message)
			}
		}

		const mime = data[0] === 0x89 && data[1] === 0x50 ? 'image/png' : 'image/jpeg'
		res.setHeader('Content-Type', mime)
		res.setHeader('Cache-Control', 'private, max-age=86400')
		return res.send(data)
	} catch (err) {
		console.warn(`[route] listing-image ${req.params.id} failed:`, err.message)
		if (!res.headersSent) res.status(404).end()
	}
})

/**
 * GET /api/route/variation-image/:listingId?k=<style>[&v=cached_at][&w=300]
 *
 * Serves the Etsy photo linked to a Styles value (e.g. "Case 1 + Grip 1").
 * Only URLs already cached in listing_variation_images are fetched — the
 * style query is a lookup key, never an open URL proxy.
 */
app.get('/api/route/variation-image/:id', async (req, res) => {
	const id = parseInt(req.params.id, 10)
	const style = String(req.query.k == null ? '' : req.query.k).trim()
	if (!Number.isInteger(id) || !style) return res.status(400).end()
	try {
		const map = getListingVariationImageMap(db, [id])
		const hit = lookupVariationImage(map, id, { style })
		if (!hit || !hit.url) return res.status(404).end()
		const data = await fetchImageBuffer(hit.url)
		if (!data || !data.length) return res.status(404).end()

		const width = thumbnails.normaliseWidth(req.query.w)
		if (width) {
			try {
				const resized = await sharp(data).rotate().resize(width, width, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer()
				res.setHeader('Content-Type', 'image/jpeg')
				res.setHeader('Cache-Control', 'private, max-age=86400')
				return res.send(resized)
			} catch (err) {
				console.warn(`[route] variation-image ${id} resize failed, serving original:`, err.message)
			}
		}

		const mime = data[0] === 0x89 && data[1] === 0x50 ? 'image/png' : 'image/jpeg'
		res.setHeader('Content-Type', mime)
		res.setHeader('Cache-Control', 'private, max-age=86400')
		return res.send(data)
	} catch (err) {
		console.warn(`[route] variation-image ${req.params.id} failed:`, err.message)
		if (!res.headersSent) res.status(404).end()
	}
})

/**
 * Collect a listing_id → image-bytes map for an entire sync report, fetching &
 * caching any missing CDN photos so the Excel export embeds real thumbnails.
 */
async function _collectSyncReportImages(report) {
	const ids = new Set()
	for (const o of report.orders || []) {
		for (const ln of o.lines || []) {
			if (ln.listing_id != null) ids.add(Number(ln.listing_id))
		}
	}
	for (const r of report.ready || []) {
		if (r.image_listing_id != null) ids.add(Number(r.image_listing_id))
	}
	const result = new Map()
	const missing = new Map() // listing_id → cdn url (for the fetcher)
	for (const id of ids) {
		if (!Number.isInteger(id)) continue
		const cached = getListingImageData(db, id)
		if (cached && cached.length) {
			result.set(id, cached)
			continue
		}
		try {
			const row = db.prepare('SELECT url FROM listing_images WHERE listing_id = ?').get(id)
			if (row && row.url) missing.set(id, row.url)
		} catch {
			/* ignore */
		}
	}
	if (missing.size) {
		try {
			const fetched = await batchFetchRouteImages(db, missing)
			for (const [id, buf] of fetched) if (buf) result.set(id, buf)
		} catch (err) {
			console.warn('[route] sync-report image fetch failed:', err.message)
		}
	}
	return result
}

/** Stream a built sync-report workbook to the client as a download. */
async function _sendSyncReportXlsx(res, report, downloadName) {
	const imageMap = await _collectSyncReportImages(report)
	const buf = await buildSyncReportWorkbook(report, imageMap)
	res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
	res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`)
	res.setHeader('Cache-Control', 'no-store')
	res.send(Buffer.from(buf))
}

/**
 * GET /api/route/sync-history
 * Lightweight list of every recorded purchase-status sync (newest first) for
 * the version-history browser. Excludes the heavy stored payload.
 */
app.get('/api/route/sync-history', (req, res) => {
	try {
		const limit = parseInt(req.query.limit, 10) || 100
		res.json({ runs: listPurchaseSyncRuns(db, limit) })
	} catch (err) {
		console.error('[route] sync-history list error:', err.message)
		res.status(500).json({ error: err.message })
	}
})

/**
 * GET /api/route/sync-history/:id
 * The full stored report for a past sync, so it can be re-opened in the report
 * modal exactly as it appeared when first run.
 */
app.get('/api/route/sync-history/:id', (req, res) => {
	const id = parseInt(req.params.id, 10)
	if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id.' })
	try {
		const payload = getPurchaseSyncRun(db, id)
		if (!payload) return res.status(404).json({ error: 'Sync run not found.' })
		res.json(payload)
	} catch (err) {
		console.error('[route] sync-history detail error:', err.message)
		res.status(500).json({ error: err.message })
	}
})

/**
 * GET /api/route/sync-history/:id/export.xlsx
 * Download a stored sync run as a professional, image-rich Excel workbook.
 */
app.get('/api/route/sync-history/:id/export.xlsx', async (req, res) => {
	const id = parseInt(req.params.id, 10)
	if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id.' })
	try {
		const report = getPurchaseSyncRun(db, id)
		if (!report) return res.status(404).json({ error: 'Sync run not found.' })
		const stamp = (report.generated_at || new Date().toISOString()).slice(0, 10)
		await _sendSyncReportXlsx(res, report, `purchase-status-sync-${stamp}-run${id}.xlsx`)
	} catch (err) {
		console.error('[route] sync-history export error:', err.message)
		if (!res.headersSent) res.status(500).json({ error: err.message })
	}
})

/**
 * GET /api/route/open?file=shopping_route.xlsx
 * Opens a generated Excel file with the OS default app (the dashboard runs
 * locally on the same machine as the files).
 */
app.get('/api/route/open', (req, res) => {
	const dir = _routeOutputDir()
	const file = (req.query.file ?? '').trim()
	if (!dir) return res.status(400).json({ error: 'Route output directory could not be resolved.' })
	if (!_isAllowedRouteFile(file)) return res.status(400).json({ error: 'Invalid file name.' })

	const fp = path.join(dir, file)
	try {
		fs.accessSync(fp, fs.constants.R_OK)
	} catch {
		return res.status(404).json({ error: 'File not found — generate the shopping route first.' })
	}

	try {
		if (process.platform === 'win32') {
			// `start` needs an (empty) title arg before the path; run via cmd.
			spawn('cmd', ['/c', 'start', '', fp], { detached: true, stdio: 'ignore' }).unref()
		} else if (process.platform === 'darwin') {
			spawn('open', [fp], { detached: true, stdio: 'ignore' }).unref()
		} else {
			spawn('xdg-open', [fp], { detached: true, stdio: 'ignore' }).unref()
		}
		res.json({ ok: true, file })
	} catch (err) {
		console.error('[route] open error:', err.message)
		res.status(500).json({ error: `Could not open file: ${err.message}` })
	}
})

/**
 * GET /api/route/download?file=shopping_route.xlsx
 * Serves a shopping-route file from the OSP output directory.
 */
app.get('/api/route/download', (req, res) => {
	const dir = _routeOutputDir()
	const file = (req.query.file ?? '').trim()
	if (!dir) return res.status(400).json({ error: 'Route output directory could not be resolved.' })
	if (!_isAllowedRouteFile(file)) return res.status(400).json({ error: 'Invalid file name.' })

	const fp = path.join(dir, file)
	try {
		fs.accessSync(fp, fs.constants.R_OK)
	} catch {
		return res.status(404).json({ error: 'File not found.' })
	}

	res.download(fp, file, (err) => {
		if (err && !res.headersSent) {
			console.error('[route] download error:', err.message)
			res.status(500).json({ error: 'Download failed.' })
		}
	})
})

/**
 * GET /api/route/download-unmatched-images
 * ZIP of product photos for every line nobody can buy yet — never catalogued, or
 * flagged Wrong Stall in person — plus a manifest naming the ask behind each one.
 * These are the images the operator forwards to the market contacts.
 * Uses the same date/shop/receipt scope as GET /api/route/dashboard.
 *
 * Query: date_from, date_to, shop_id, receipt_ids (comma-separated).
 * Response: application/zip; X-Images-Requested / X-Images-Not-In-Catalog /
 *           X-Images-Wrong-Stall headers (all set before the stream opens).
 */
app.get('/api/route/download-unmatched-images', async (req, res) => {
	try {
		const receiptIds = (req.query.receipt_ids || '')
			.split(',')
			.map((s) => parseInt(s.trim(), 10))
			.filter(Number.isInteger)
		const extraIds = (req.query.extra_receipt_ids || '')
			.split(',')
			.map((s) => parseInt(s.trim(), 10))
			.filter(Number.isInteger)

		const rows = routeDashboard.buildRouteRows(db, config, {
			date_from: req.query.date_from,
			date_to: req.query.date_to,
			shop_id: req.query.shop_id,
			include_shipped: req.query.include_shipped === 'true',
			enrich_supplier: true,
			receipt_ids: receiptIds.length ? receiptIds : undefined,
			extra_receipt_ids: extraIds.length ? extraIds : undefined,
		})

		const items = unmatchedImages.collectUnmatchedImageItems(rows)
		if (!items.length) {
			return res.status(404).json({
				error: 'Nothing to source in this date range — every line has a supplier and none are flagged Wrong Stall. Try widening the dates, or run npm run fetch-images if photos are missing.',
			})
		}

		const stamp = new Date().toISOString().slice(0, 10)
		const zipName = `unmatched-products-${stamp}.zip`
		const byReason = unmatchedImages.countItemsByReason(items)

		// Every header goes out BEFORE the archive starts streaming: once the first
		// chunk is written the headers are flushed and any later setHeader throws.
		res.setHeader('Content-Type', 'application/zip')
		res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`)
		res.setHeader('X-Images-Requested', String(items.length))
		res.setHeader('X-Images-Not-In-Catalog', String(byReason[routeSourcing.REASON_NOT_IN_CATALOG]))
		res.setHeader('X-Images-Wrong-Stall', String(byReason[routeSourcing.REASON_WRONG_STALL]))

		const { added, failed } = await unmatchedImages.streamUnmatchedImagesZip(res, db, items)
		console.log(`[route] sourcing images zip: ${added}/${items.length} ` + `(${byReason[routeSourcing.REASON_WRONG_STALL]} wrong stall, ${failed.length} failed)`)
	} catch (err) {
		console.error('[route] download-unmatched-images:', err.message)
		if (!res.headersSent) {
			res.status(500).json({ error: err.message || 'Could not build image archive.' })
		}
	}
})

// ─── Dashboard HTML ───────────────────────────────────────────────────────────

// The checklist is split out of the already-large dashboard document so its
// controller and styles can be syntax/DOM tested independently. Explicit routes
// preserve the dashboard's deny-by-default static surface (no broad public dir).
app.get('/operations-checklist.css', (_req, res) => {
	res.type('text/css').set('Cache-Control', 'no-cache').sendFile(path.resolve(__dirname, '../../public/operations-checklist.css'))
})
app.get('/operations-checklist.js', (_req, res) => {
	res.type('application/javascript').set('Cache-Control', 'no-cache').sendFile(path.resolve(__dirname, '../../public/operations-checklist.js'))
})

app.get('/', (req, res) => {
	res.sendFile(path.resolve(__dirname, '../../public/index.html'))
})

// ─── Online Shopping Route (mobile PWA) ───────────────────────────────────────
// Purpose-built, phone-first page for employees doing the in-person shopping.
// Auth-gated by requirePage (see access.js): shoppers land here after login.
app.get('/shop', (req, res) => {
	res.sendFile(path.resolve(__dirname, '../../public/shop.html'))
})

// ─── Sourcing Library (back-office design intake) ─────────────────────────────
// Standalone workspace for cataloguing WeChat/QQ design suppliers and filing the
// zipped product folders downloaded from them. Auth-gated by requirePage: owner
// and packer only (shoppers are bounced to /shop). See access.js.
app.get('/sourcing', (req, res) => {
	res.sendFile(path.resolve(__dirname, '../../public/sourcing.html'))
})

// Shared offline write-queue module (durable IndexedDB queue + replay logic),
// used by shop.html, the service worker (via importScripts), and a Node test —
// one source of truth. Served with no-cache so queue-logic fixes propagate
// immediately (the byte-identical SW re-registers when this changes too).
app.get('/shop-sync.js', (_req, res) => {
	res.type('application/javascript').set('Cache-Control', 'no-cache').sendFile(path.resolve(__dirname, '../../public/shop-sync.js'))
})

// Supplier WeChat prep-list builder (pure payload + canvas PNG). Shared with the
// shopping page and a Node regression test — same pattern as shop-sync.js.
app.get('/shop-supplier-prep.js', (_req, res) => {
	res.type('application/javascript').set('Cache-Control', 'no-cache').sendFile(path.resolve(__dirname, '../../public/shop-supplier-prep.js'))
})

// PWA manifest — makes the shopping route installable to a phone home screen.
app.get('/shop.webmanifest', (_req, res) => {
	res.type('application/manifest+json').json({
		name: 'Shopping Route',
		short_name: 'Shopping',
		description: 'Live shopping route for Etsy orders',
		start_url: '/shop',
		scope: '/shop',
		display: 'standalone',
		orientation: 'portrait',
		background_color: '#0f1117',
		theme_color: '#0f1117',
		icons: [{ src: '/shop-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
	})
})

// App icon (vector — scales to any size, no binary asset to ship).
app.get('/shop-icon.svg', (_req, res) => {
	res.type('image/svg+xml').send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">` + `<rect width="512" height="512" rx="96" fill="#0f1117"/>` + `<path d="M160 176h224l-20 176a32 32 0 0 1-32 28H212a32 32 0 0 1-32-28z" fill="none" stroke="#f56400" stroke-width="24" stroke-linejoin="round"/>` + `<path d="M200 176v-8a56 56 0 0 1 112 0v8" fill="none" stroke="#f56400" stroke-width="24" stroke-linecap="round"/>` + `<path d="M226 268l26 26 52-58" fill="none" stroke="#6c8fff" stroke-width="24" stroke-linecap="round" stroke-linejoin="round"/>` + `</svg>`)
})

// Minimal service worker — caches the app shell for instant load + offline open
// (data is always fetched fresh from the network; API is never cached).
app.get('/shop-sw.js', (_req, res) => {
	res.type('application/javascript').set('Cache-Control', 'no-cache').send(`
// Shared durable-queue module (op ids, IndexedDB, replayAll) — the SAME code the
// page uses, so Background Sync replays are byte-for-byte consistent with live
// flushes. Wrapped so a fetch failure (e.g. first install offline) can't abort SW
// installation; the 'sync' handler defensively re-checks self.ShopSync.
try { importScripts('/shop-sync.js'); } catch (e) {}
const SHELL = 'shopping-route-shell-v40';
// v3: ALL of our own image endpoints (charm, substitution/switched-design, style
// variant, manual) are now content-addressed (…?v=TOKEN / …&v=TOKEN) — the token
// moves whenever the underlying photo is replaced, so the URL changes and this
// cache-first store can never serve a stale thumbnail. Bumping the cache name
// evicts entries cached under the OLD un-versioned URLs (e.g. a switched-design
// photo that kept showing the original image on the shopping floor).
const IMG = 'shopping-route-img-v3';
const ASSETS = ['/shop', '/shop.webmanifest', '/shop-icon.svg', '/shop-sync.js', '/shop-supplier-prep.js'];
// Anything that is an image we serve: charm / listing / switched-design / variant /
// manual endpoints. Direct Etsy CDN URLs are intentionally NOT intercepted —
// CSP connect-src is 'self', so a service-worker fetch to etsystatic.com would
// fail; listing photos are proxied through /api/route/listing-image instead.
function isImage(url, req) {
  return req.destination === 'image'
    || url.pathname.startsWith('/api/route/charm-image')
    || url.pathname.startsWith('/api/route/listing-image')
    || url.pathname.startsWith('/api/route/variation-image')
    || url.pathname.startsWith('/api/route/style-image')
    || url.pathname.startsWith('/api/route/substitution-image')
    || url.pathname.startsWith('/api/route/manual-image');
}
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== IMG).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Images: cache-first (they never change for a given URL) → instant on repeat,
  // and never re-downloaded through the tunnel. This is the big image-speed win.
  if (isImage(url, e.request)) {
    e.respondWith(caches.open(IMG).then(async (cache) => {
      const hit = await cache.match(e.request);
      if (hit) return hit;
      try {
        const resp = await fetch(e.request);
        if (resp && (resp.ok || resp.type === 'opaque')) cache.put(e.request, resp.clone()).catch(() => {});
        return resp;
      } catch (err) {
        return hit || Response.error();
      }
    }));
    return;
  }
  // Never cache other API/SSE traffic — always live.
  if (url.pathname.startsWith('/api/')) return;
  if (e.request.mode === 'navigate' || ASSETS.includes(url.pathname)) {
    e.respondWith(fetch(e.request).then((r) => {
      const copy = r.clone();
      caches.open(SHELL).then((c) => c.put(e.request, copy)).catch(() => {});
      return r;
    }).catch(() => caches.match(e.request).then((m) => m || caches.match('/shop'))));
  }
});
// Background Sync: when the OS restores connectivity, drain the durable queue even
// if the app is closed. The page registers the shop-sync-flush tag on every
// enqueue; here we replay it idempotently. If the browser lacks Background Sync
// (e.g. iOS Safari), the page's own online/foreground flush is the fallback, so no
// write is ever stranded.
self.addEventListener('sync', (e) => {
  if (e.tag === 'shop-sync-flush' && self.ShopSync) {
    e.waitUntil(self.ShopSync.replayAll().catch(() => {}));
  }
});
`)
})

// ─── API safety net ───────────────────────────────────────────────────────────
//
// These two handlers guarantee that EVERY /api/* response is JSON. Without them,
// an unmatched route or an uncaught handler error falls through to Express's
// default HTML responses ("Cannot GET …" / the HTML error page). A browser doing
// `fetch(...).then(r => r.json())` on that HTML throws the opaque
// "Unexpected token '<'" — which is exactly the class of bug this prevents.

// JSON 404 for any unknown API endpoint (must come after all /api routes).
app.use('/api', (req, res) => {
	res.status(404).json({ error: `Unknown API endpoint: ${req.method} ${req.originalUrl}` })
})

// Centralized JSON error handler. Express identifies this as error-handling
// middleware by its four-argument signature, so any `throw` / rejected promise
// surfaced by a route lands here as a clean JSON error instead of HTML.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
	console.error(`[api-error] ${req.method} ${req.originalUrl}:`, err.stack || err.message)
	if (res.headersSent) return next(err)
	res.status(err.status || err.statusCode || 500).json({
		error: err.message || 'Internal server error',
	})
})

// ─── Start ────────────────────────────────────────────────────────────────────

// Build/deploy fingerprint, logged once at boot. This is a pm2-managed long-
// running process — code on disk only takes effect after a restart (`npm run
// auto:restart` / `pm2 restart etsy-dashboard`), so "did my fix actually ship?"
// is a real, recurring question here. Printing the commit + boot time removes
// the guesswork: compare it against `git log -1` to confirm what's live.
function bootFingerprint() {
	try {
		const commit = execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
			.toString()
			.trim()
		const commitTime = execSync('git log -1 --format=%cd --date=iso-strict', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
			.toString()
			.trim()
		const dirty =
			execSync('git status --porcelain', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
				.toString()
				.trim().length > 0
		return `${commit}${dirty ? '+dirty' : ''} (committed ${commitTime})`
	} catch {
		return 'unknown (not a git checkout or git unavailable)'
	}
}
// Git subprocesses are synchronous and `/api/health` is polled aggressively while
// restarting. Compute once at boot instead of blocking the event loop per probe.
const BOOT_FINGERPRINT = bootFingerprint()

const PORT = Number(process.env.PORT) || 4000
const allowOpenNetwork = process.env.DASHBOARD_ALLOW_UNAUTHENTICATED_NETWORK === '1' || process.env.DASHBOARD_ALLOW_UNAUTHENTICATED_NETWORK === 'true'
const LISTEN_HOST = resolveListenHost({
	authEnabled: auth.enabled,
	allowUnauthenticatedNetwork: allowOpenNetwork,
	requestedHost: process.env.HOST,
})
// Precompute perceptual hashes for already-cached product images shortly after
// boot, so the shopping route can unify same-image products across shops on the
// first open (rather than waiting for the per-request self-heal).
setTimeout(() => {
	backfillPhashes().catch(() => {})
}, 5000)
setTimeout(() => {
	hydrateMissingProductIdentities().catch(() => {})
}, 8000)
// Reconcile model fixes left in a contradictory state by an older build (open,
// but with the corrected model already bought) so no order sits in limbo.
setTimeout(settleAlreadyBoughtModelFixes, 6000)
const httpServer = app.listen(PORT, LISTEN_HOST, () => {
	const allShops = getAllShops(config)
	const authedN = allShops.filter((s) => tokenManager.hasTokens(s.shop_id)).length
	const groups = config.groups

	// ── Rate-limit budget analysis (logged at every startup) ─────
	// Etsy Personal Access: 5 QPS / 5,000 QPD per API key
	// Sync interval: each shop runs roughly once per hour (cron + jitter)
	// Calls per shop per sync:
	//   1 token refresh (POST /oauth/token) — only when token is expiring
	//   1-2 receipt pages  (GET /shops/{id}/receipts)
	//   ≈ 3 calls/shop/cycle on average
	const syncIntervalH = 1 // hourly cron
	const callsPerShopPerCycle = 3
	const cyclesPerDay = 24 / syncIntervalH
	const uniqueKeys = [...new Set(allShops.map((s) => s.api_key))]
	const budgetLines = uniqueKeys.map((key) => {
		const shopCount = allShops.filter((s) => s.api_key === key).length
		const callsPerDay = shopCount * callsPerShopPerCycle * cyclesPerDay
		const pct = ((callsPerDay / 5000) * 100).toFixed(1)
		return `      ${key.slice(0, 6)}…  ${shopCount} shops → ~${callsPerDay} calls/day  (${pct}% of 5K QPD)`
	})

	// Discover this machine's LAN IPv4 address(es) when the configured bind permits
	// remote access, so the owner knows what to open on the employee's computer.
	const lanAddrs = []
	try {
		const nets = os.networkInterfaces()
		for (const name of Object.keys(nets)) {
			for (const ni of nets[name] || []) {
				if (ni.family === 'IPv4' && !ni.internal) lanAddrs.push(ni.address)
			}
		}
	} catch {
		/* os enumeration best-effort */
	}
	// Prefer a real home/office LAN IP over virtual adapters (VirtualBox / Docker /
	// WSL / Hyper-V), so the URL we highlight is the one the employee should use.
	const ipRank = (ip) => {
		if (/^192\.168\.56\./.test(ip)) return 5 // VirtualBox host-only
		if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 4 // Docker / WSL / Hyper-V
		if (/^169\.254\./.test(ip)) return 6 // link-local (no DHCP)
		if (/^192\.168\./.test(ip)) return 1 // typical home/office LAN
		if (/^10\./.test(ip)) return 2 // common private LAN
		return 3
	}
	const lanUrls = lanAddrs.sort((a, b) => ipRank(a) - ipRank(b)).map((ip) => `http://${ip}:${PORT}`)

	console.log('═'.repeat(60))
	console.log('  Unified Dashboard')
	console.log('═'.repeat(60))
	console.log(`\n  Build       : ${BOOT_FINGERPRINT}  ·  pid ${process.pid}  ·  booted ${new Date().toISOString()}`)
	console.log(`  Local URL   : http://localhost:${PORT}   (this computer)`)
	if (LISTEN_HOST !== '127.0.0.1' && LISTEN_HOST !== '::1' && lanUrls.length) {
		console.log(`  Network URL : ${lanUrls[0]}   ← open THIS on your employee's laptop`)
		lanUrls.slice(1).forEach((u) => console.log(`                ${u}`))
	} else if (LISTEN_HOST === '127.0.0.1' || LISTEN_HOST === '::1') {
		console.log('  Network URL : disabled (auth is off; localhost-only safety bind)')
	} else {
		console.log('  Network URL : (no LAN address found — connect to Wi-Fi/Ethernet)')
	}
	console.log(`  Access      : ${auth.enabled ? '🔒 Login required — Owner / Packer roles enforced' : '⚠ OPEN (no login) — set DASHBOARD_OWNER_PASSWORD in .env for roles'}`)
	console.log(`  DB        : ${config.db_path}`)
	console.log(`  Shops     : ${allShops.length} configured, ${authedN} authenticated`)
	const proxiedGroups = groups.filter((g) => {
		const { usesGroupProxy } = require('../config/schema')
		return usesGroupProxy(g)
	}).length
	const directGroups = groups.length - proxiedGroups
	console.log(`  Groups    : ${groups.length} (${proxiedGroups} proxied via VPN→IPFoxy, ${directGroups} direct)`)
	console.log('\n  ── Rate limit budget (5 QPS / 5,000 QPD per API key) ──')
	budgetLines.forEach((l) => console.log(l))
	console.log(`\n  Sync interval : ${syncIntervalH}h (cron) + 0–90s jitter per shop`)
	console.log('  QPS at burst  : ≤2 per shop (staggered by jitter, well under 5 QPS)')
	console.log('  Status        : ✓ Safe — all keys under 30% of daily budget\n')

	const suspensionRisks = analyzeSuspensionRisks(config)
	const riskSummary = summarizeRisks(suspensionRisks)
	console.log('  ── Suspension risk compliance ──')
	console.log(formatRiskReport(suspensionRisks))
	if (riskSummary.status !== 'ok') {
		console.log(`  Compliance    : ${riskSummary.status.toUpperCase()} — review risks above`)
		console.log('  API endpoint  : GET /api/admin/suspension-risk\n')
	}

	console.log(LISTEN_HOST === '127.0.0.1' || LISTEN_HOST === '::1' ? `  Open http://localhost:${PORT} on this computer.\n` : `  Open http://localhost:${PORT} here, or the Network URL on another computer.\n`)

	// ── Embedded order + inventory sync ────────────────────────────────────────
	// Runs the SAME receipt sync + order-triggered auto-restock that the standalone
	// worker (`npm run sync`) performs, but in-process so a single `npm start`
	// keeps everything current automatically — no second terminal required.
	//
	//   • Receipt sync  (every sync_interval_minutes): pulls new orders for every
	//     shop and, for any listing in a recent order, live-checks Etsy inventory
	//     and auto-restocks zero-stock variations (logs ORDER_RESTOCK).
	//   • Inventory watch (every inv_watch_interval_minutes): safety-net sweep that
	//     catches zero-stock not tied to a recent order (logs AUTO_RESTOCK).
	//
	// Disable with EMBEDDED_SYNC=0 if you prefer to run `npm run sync` separately.
	const trackingSettings = getTrackingPollSettings(config)
	if (process.env.EMBEDDED_SYNC === '0') {
		console.log('  Embedded sync: DISABLED (EMBEDDED_SYNC=0) — run `npm run sync` in a separate terminal\n')
	} else {
		const syncIntervalMin = config.sync_interval_minutes ?? 60
		const invWatchMin = config.inv_watch_interval_minutes ?? 240

		// Single shared guard so receipt sync and inventory watch never overlap each
		// other (or themselves) — protects the per-key QPD budget.
		let syncBusy = false
		const runGuarded = async (label, fn) => {
			if (syncBusy) {
				console.log(`[${label}] Previous sync still running — skipping this trigger`)
				return
			}
			// Don't stack a scheduled cycle on top of an operator-initiated heavy job
			// (full backfill / earnings sync). They share the same per-key QPD budget,
			// so running them together would only burn budget faster. The QPS bucket
			// already prevents any rate breach; this just avoids wasteful overlap.
			if (_backfillRunning || _ledgerSyncRunning) {
				console.log(`[${label}] A manual backfill/earnings sync is running — skipping this scheduled trigger`)
				return
			}
			syncBusy = true
			try {
				await fn()
			} catch (err) {
				console.error(`[${label}] Unhandled error: ${err.message}`)
			} finally {
				syncBusy = false
			}
		}

		// Robust cron builder handles intervals > 59 min correctly (a naive
		// `*/90 * * * *` is invalid in the minute field and mis-fires).
		const receiptCron = intervalToCron(syncIntervalMin)
		const invCron = intervalToCron(invWatchMin)

		console.log(`  Embedded sync: ON — receipts "${receiptCron}" (every ${syncIntervalMin}m), inventory watch "${invCron}" (every ${invWatchMin}m)`)
		console.log('                 Auto-restock + order sync run automatically while the dashboard is open.\n')

		// A restart is not a business event. If every authenticated shop completed
		// a receipt sync within the configured interval, wait for cron instead of
		// repeating the same Etsy reads eight seconds after deployment.
		const latestSuccessfulSync = db.prepare(
			`SELECT MAX(completed_at) AS completed_at
			 FROM sync_log
			 WHERE shop_id = ? AND status = 'success'`
		)
		const authenticatedShopIds = allShops
			.filter((shop) => tokenManager.hasTokens(shop.shop_id))
			.map((shop) => shop.shop_id)
		const startupCutoff = Math.floor(Date.now() / 1000) - syncIntervalMin * 60
		const allShopsFresh =
			authenticatedShopIds.length > 0 &&
			authenticatedShopIds.every((shopId) => {
				const completedAt = Number(latestSuccessfulSync.get(shopId)?.completed_at) || 0
				return completedAt >= startupCutoff
			})

		// Kick off receipt sync shortly after boot only when data is genuinely
		// stale; defer inventory sweep to avoid a startup GET+PUT burst.
		setTimeout(() => {
			if (allShopsFresh) {
				console.log(`[sync] Startup sync skipped — all ${authenticatedShopIds.length} authenticated shop(s) synced within the last ${syncIntervalMin}m.`)
				return
			}
			runGuarded('sync', () => runSyncCycle(config, tokenManager, db))
		}, 8000)
		setTimeout(() => {
			runGuarded('inventory-watch', () => runInventoryWatchCycle(config, tokenManager, db))
		}, INV_WATCH_STARTUP_DELAY_MS)
		cron.schedule(receiptCron, () => {
			runGuarded('sync', () => runSyncCycle(config, tokenManager, db))
		})
		cron.schedule(invCron, () => {
			runGuarded('inventory-watch', () => runInventoryWatchCycle(config, tokenManager, db))
		})
	}

	// ── Etsy-completion reconciler ─────────────────────────────────────────────
	// Independent of EMBEDDED_SYNC and of the QPD budget: an order holding a paid
	// 4PX label that was never completed on Etsy is a live late-shipment strike,
	// and finishing it is always the right call. The startup pass is what heals
	// anything stranded while the dashboard was down. Cross-process safe — the
	// ledger leases each order, so a second runner cannot double-ship one.
	const completionSweepMin = Math.max(1, config.etsy_completion_sweep_minutes ?? 5)
	console.log(`  Ship recovery: every ${completionSweepMin}m — completes 4PX-labelled orders that were never finished on Etsy\n`)
	setTimeout(() => {
		runEtsyCompletionSweep('startup').catch((err) => console.error('[completion] startup sweep failed:', err.message))
	}, 20_000)
	setInterval(
		() => {
			runEtsyCompletionSweep('scheduled').catch((err) => console.error('[completion] scheduled sweep failed:', err.message))
		},
		completionSweepMin * 60 * 1000,
	)

	// 4PX tracking is independent of Etsy's embedded-sync switch and QPD budget.
	// Keep parcel status current even when EMBEDDED_SYNC=0; a standalone worker
	// sharing this DB is harmless because the cross-process tracking lock elects
	// exactly one runner.
	if (trackingSettings.enabled) {
		// Run one-time cached repairs before the startup carrier cycle builds its
		// due queue. This avoids a first-tab race where deployment rechecks would
		// otherwise wait for the next 15-minute scheduler tick.
		try {
			ensureDisposedTrackingFlags()
		} catch (err) {
			console.warn(`[tracking] Cached tracking repair failed: ${err.message}`)
		}
		console.log(`  4PX tracking : every ${trackingSettings.intervalMinutes}m (pre-transit ${trackingSettings.preRecheckHours}h, moving ${trackingSettings.transitRecheckHours}h cache TTL)\n`)
		setTimeout(() => {
			_startServerTrackingRefresh('startup')
		}, 15_000)
		setInterval(
			() => {
				_startServerTrackingRefresh('scheduled')
			},
			trackingSettings.intervalMinutes * 60 * 1000,
		)
	}
})

// ── Single-instance guard ─────────────────────────────────────────────────────
// If another dashboard already owns the port, refuse to start and exit. Without
// this, a second copy launched by hand or from the IDE would bind nothing yet
// keep running its embedded sync scheduler in the background — the exact cause
// of every shop being synced twice per hour. Exiting here keeps "one port = one
// scheduler", and PM2 (which supervises the canonical instance) is unaffected.
httpServer.on('error', (err) => {
	if (err.code === 'EADDRINUSE') {
		console.error(`\n[fatal] Port ${PORT} is already in use — another dashboard instance is running.\n` + `        Refusing to start a duplicate (a second embedded sync scheduler would\n` + `        double every shop's sync). Stop the other instance or set PORT to a free\n` + `        port, then start again.\n`)
	} else {
		console.error(`\n[fatal] HTTP server error: ${err.message}\n`)
	}
	process.exit(1)
})

// ── Graceful shutdown: free advisory locks this process owns ──────────────────
// A UI restart (POST /api/restart → process.exit(0)) or a PM2 reload takes this
// process down directly. If the embedded sync cycle's advisory lock is still held
// by our pid, the freshly-revived process cannot acquire it until the ~20-minute
// heartbeat TTL lapses — so its boot sync is skipped and the Shops & Sync tab
// shows "API unknown" (the in-memory Etsy budget is only learned from live sync
// response headers) until the next top-of-hour cron. Releasing on the way out
// lets the new process sync and re-learn the budget within seconds of boot.
// Both release helpers are owner-scoped, so a genuinely separate live worker
// holding either lock is never disturbed. better-sqlite3 is synchronous, so this is safe to
// run inside the 'exit' handler (the catch-all that also covers process.exit).
let _locksReleased = false
function releaseOwnedLocks() {
	if (_locksReleased) return
	_locksReleased = true
	try {
		releaseSyncLock(db)
		releaseTrackingLock(db)
		for (const receiptId of _fourpxCreateInFlight.keys()) {
			releaseLock(db, `fourpx_create:${receiptId}`, FOURPX_CREATE_LOCK_OWNER)
		}
	} catch {
		/* best effort — never throw from a shutdown path */
	}
}
process.on('exit', releaseOwnedLocks)
process.on('SIGINT', () => {
	releaseOwnedLocks()
	process.exit(0)
})
process.on('SIGTERM', () => {
	releaseOwnedLocks()
	process.exit(0)
})

// ── Last-resort crash guards ──────────────────────────────────────────────────
// Continuing after an uncaught exception leaves Node in an undefined state.
// Stop accepting new work, give active requests a short grace period, release
// advisory locks, and let PM2 restart a clean process. Mutation paths are
// checkpointed/idempotent, so retrying is safer than running corrupted state.
let _fatalShutdownStarted = false
function shutdownAfterFatal(kind, detail) {
	if (_fatalShutdownStarted) return
	_fatalShutdownStarted = true
	console.error(`[fatal] ${kind} — shutting down for a clean PM2 restart:\n${detail}`)
	process.exitCode = 1
	const finish = () => {
		releaseOwnedLocks()
		process.exit(1)
	}
	try {
		httpServer.close(finish)
	} catch {
		finish()
		return
	}
	const timer = setTimeout(finish, 10_000)
	if (typeof timer.unref === 'function') timer.unref()
}
process.on('unhandledRejection', (reason) => {
	const detail = reason instanceof Error ? reason.stack || reason.message : JSON.stringify(reason)
	shutdownAfterFatal('Unhandled promise rejection', detail)
})
process.on('uncaughtException', (err) => {
	shutdownAfterFatal('Uncaught exception', err?.stack || err)
})
