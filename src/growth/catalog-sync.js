'use strict'

/**
 * Catalog-health sync — the budget-aware way to measure Etsy traffic.
 *
 * Etsy Open API v3 has no Stats / analytics endpoint. Search rank, traffic
 * source, and Etsy Ads impressions are not available. What the API does
 * expose, and what this module snapshots:
 *
 *   • GET /shops/{id}                  shop favorers, review average, vacation
 *   • GET /shops/{id}/listings           listing.views (lifetime, daily tabulation,
 *                                      active listings only), favorers, state, ending
 *   • GET /shops/{id}/listings?limit=1  cheap count probes for expired / sold_out / draft
 *   • GET /shops/{id}/reviews          rating pulse (no buyer identity stored)
 *
 * When explicitly enabled, cadence is once per shop per
 * catalog_health_interval_hours (default 24), not every receipt-sync cycle.
 * Manual mode is the default and never enters this module. Personal Access QPD
 * is 5,000/key; a daily
 * walk of ~150 listings/shop is ~2 listing pages + 3 count probes + 1 review
 * page + 1 getShop ≈ 7 calls/shop. 20 shops ≈ 140 calls/day.
 */

const {
  paginateListings,
  getListingsCountByState,
  paginateReviewsByShop,
  getShop,
  getRemainingBudget,
  isQpdExhaustedError,
} = require('../etsy/client')
const {
  upsertListing,
  pruneStaleListings,
  updateShopHealth,
  upsertShopHealthSnapshot,
  upsertEtsyReview,
  markCatalogHealthSynced,
  markReviewsSynced,
} = require('../db/setup')

const LISTING_STATES_COUNTED = Object.freeze(['inactive', 'sold_out', 'expired', 'draft'])
const MAX_LISTING_PAGES = 15 // 1,500 active listings; incomplete walks never prune
const MAX_REVIEW_PAGES = 3
const MIN_CATALOG_BUDGET = 400
const REVIEW_OVERLAP_SEC = 24 * 60 * 60

function shopNeedsCatalogHealth(db, shopId, intervalHours = 24) {
  if (!shopId) return false
  const hours = Math.max(12, Number(intervalHours) || 24)
  const row = db.prepare('SELECT catalog_health_synced_at FROM shops WHERE shop_id = ?').get(shopId)
  const last = Number(row?.catalog_health_synced_at) || 0
  if (!last) return true
  return Math.floor(Date.now() / 1000) - last >= hours * 3600
}

function hasCatalogBudget(shopClient, minRemaining = MIN_CATALOG_BUDGET) {
  try {
    const b = getRemainingBudget(shopClient)
    const remaining = b.server != null ? b.server : b.local
    return Number(remaining) >= minRemaining
  } catch {
    return true
  }
}

function latestReviewTimestamp(db, shopId) {
  const row = db.prepare(
    'SELECT MAX(created_timestamp) AS ts FROM etsy_reviews WHERE shop_id = ?'
  ).get(shopId)
  return Number(row?.ts) || 0
}

/**
 * @param {object} args
 * @param {import('better-sqlite3').Database} args.db
 * @param {import('axios').AxiosInstance} args.shopClient
 * @param {string|number} args.numericShopId
 * @param {string} args.shopId
 * @param {string} [args.shopName]
 * @param {boolean} args.analyticsApproved - caller verified retained Etsy written approval
 * @param {Function} [args.heartbeat]
 * @returns {Promise<{ listings:number, reviews:number, pruned:number, complete:boolean }>}
 */
async function syncShopCatalogHealth({
  db,
  shopClient,
  numericShopId,
  shopId,
  shopName,
  analyticsApproved,
  heartbeat,
} = {}) {
  const label = `[catalog-health] ${shopName || shopId}`
  if (analyticsApproved !== true) {
    const err = new Error('Etsy written authorization is required before API content may be collected for analytics.')
    err.status = 409
    err.code = 'ETSY_API_ANALYTICS_NOT_APPROVED'
    throw err
  }
  if (!db || !shopClient || !shopId || numericShopId == null) {
    throw new Error('catalog health requires db, shopClient, shopId, numericShopId')
  }
  if (!hasCatalogBudget(shopClient)) {
    console.warn(`${label} Skipped — QPD remaining is below the catalog reserve`)
    return { listings: 0, reviews: 0, pruned: 0, complete: false, skipped: 'budget' }
  }

  heartbeat?.()

  try {
    const shopData = await getShop(shopClient, numericShopId)
    updateShopHealth(db, shopId, shopData || {})
  } catch (err) {
    if (isQpdExhaustedError(err)) throw err
    console.warn(`${label} getShop failed (non-fatal): ${err.message}`)
  }

  heartbeat?.()
  const seenIds = new Set()
  let listings = 0
  let pages = 0
  let complete = true
  try {
    for await (const batch of paginateListings(shopClient, numericShopId, {
      state: 'active',
      includeInventory: false,
      sort: false,
    })) {
      heartbeat?.()
      pages += 1
      const write = db.transaction((rows) => {
        for (const listing of rows) {
          upsertListing(db, shopId, listing, { snapshotMetrics: true })
          seenIds.add(listing.listing_id)
          listings += 1
        }
      })
      write(batch)
      if (pages >= MAX_LISTING_PAGES) {
        complete = false
        console.warn(`${label} Stopped after ${MAX_LISTING_PAGES} listing pages to protect QPD`)
        break
      }
    }
  } catch (err) {
    if (isQpdExhaustedError(err)) throw err
    complete = false
    console.warn(`${label} Active listing walk failed (non-fatal): ${err.message}`)
  }

  let pruned = 0
  if (complete && seenIds.size > 0) {
    try {
      pruned = pruneStaleListings(db, shopId, 'active', seenIds)
    } catch (err) {
      console.warn(`${label} Prune skipped: ${err.message}`)
    }
  }

  const stateCounts = {}
  if (complete) stateCounts.listing_active_count = seenIds.size
  for (const state of LISTING_STATES_COUNTED) {
    heartbeat?.()
    try {
      const count = await getListingsCountByState(shopClient, numericShopId, state)
      stateCounts[`listing_${state}_count`] = count
    } catch (err) {
      if (isQpdExhaustedError(err)) throw err
      console.warn(`${label} ${state} count failed (non-fatal): ${err.message}`)
    }
  }
  upsertShopHealthSnapshot(db, shopId, stateCounts)

  heartbeat?.()
  let reviews = 0
  const minCreated = latestReviewTimestamp(db, shopId)
  try {
    for await (const batch of paginateReviewsByShop(shopClient, numericShopId, {
      maxPages: MAX_REVIEW_PAGES,
      min_created: minCreated > 0 ? Math.max(0, minCreated - REVIEW_OVERLAP_SEC) : undefined,
    })) {
      const write = db.transaction((rows) => {
        for (const review of rows) {
          upsertEtsyReview(db, shopId, review)
          reviews += 1
        }
      })
      write(batch)
    }
    markReviewsSynced(db, shopId)
  } catch (err) {
    if (isQpdExhaustedError(err)) throw err
    console.warn(`${label} Reviews sync failed (non-fatal): ${err.message}`)
  }

  // An incomplete active-listing walk is not a fresh catalog snapshot. Leave it
  // due so the next approved run can resume instead of hiding missing listings
  // behind the normal 12–24 hour cadence.
  if (complete) markCatalogHealthSynced(db, shopId)
  console.log(`${label} listings=${listings} reviews=${reviews} pruned=${pruned} complete=${complete}`)
  return { listings, reviews, pruned, complete }
}

/**
 * Run catalog health only when the shop's snapshot is stale.
 * @returns {Promise<object|null>} result or null when skipped
 */
async function maybeSyncShopCatalogHealth(args) {
  const intervalHours = args.intervalHours ?? 24
  if (!shopNeedsCatalogHealth(args.db, args.shopId, intervalHours)) return null
  return syncShopCatalogHealth(args)
}

module.exports = {
  shopNeedsCatalogHealth,
  hasCatalogBudget,
  syncShopCatalogHealth,
  maybeSyncShopCatalogHealth,
  MIN_CATALOG_BUDGET,
  MAX_LISTING_PAGES,
  LISTING_STATES_COUNTED,
}
