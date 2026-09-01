'use strict'

/**
 * Growth diagnostics — turn already-synced Etsy data into a ranked action plan.
 *
 * This module never calls Etsy. Page load reads SQLite only. The catalog-health
 * worker is what spends QPD; this file is the analyst.
 *
 * Funnel model (what a marketplace ops team actually uses):
 *   1. Traffic     — listing.views delta between daily snapshots
 *   2. Conversion  — orders / view-delta when snapshots exist
 *   3. Offer       — AOV, refunds, ads efficiency from receipts + ledger
 *   4. Operations  — vacation, rating, expired/sold-out, late ships
 *
 * Scope isolation: if most shops move together, the cause is market/seasonality.
 * If one shop drops while peers hold, the cause is shop-specific.
 */

const { scoreTitle } = require('../listings/title-quality')
const { CHARACTERS } = require('../listings/character-catalog')
const { latestManualComparisons } = require('./manual-import')
const { latestListingDetailImports, buildListingDetailInsights } = require('./manual-listing-import')

const MANUAL_SHOP_ID = '__manual__'

const CANCELLED_SQL = `LOWER(COALESCE(status,'')) IN ('canceled','cancelled','fully refunded')`

const T = Object.freeze({
  ordersDrop: -15,
  ordersDropHard: -25,
  strongGrowth: 15,
  viewsDrop: -20,
  conversionDrop: -20,
  ratingWarn: 4.6,
  ratingMinReviews: 5,
  lateShipPct: 8,
  adsPctHigh: 12,
  adsPerOrderHigh: 25,
  refundWatchPct: 5,
  endingSoonDays: 14,
  watchlistLimit: 25,
})

const SEVERITY_RANK = Object.freeze({ critical: 0, high: 1, medium: 2, low: 3 })
const ETSY_GUIDANCE = Object.freeze({
  search: 'https://www.etsy.com/seller-handbook/article/how-etsy-search-works/375461474487',
  titles: 'https://www.etsy.com/seller-handbook/article/1399426136697',
  visibility: 'https://help.etsy.com/hc/en-us/articles/25869947521175-How-to-Use-the-Etsy-Search-Visibility-Page',
  marketplaceInsights: 'https://help.etsy.com/hc/en-us/articles/35122361353239-How-Do-I-Use-Etsy-s-Marketplace-Insights-Tool',
  stats: 'https://help.etsy.com/hc/en-us/articles/115015774268-How-to-Use-Etsy-Stats-for-Your-Shop',
  shareAndSave: 'https://help.etsy.com/hc/en-us/articles/16981332744087-How-to-Save-on-Etsy-Fees-with-the-Share-Save-Program',
  service: 'https://help.etsy.com/hc/en-us/articles/360036207794-What-are-Etsy-s-Customer-Service-Standards',
  sellerPolicy: 'https://www.etsy.com/legal/sellers',
  ipPolicy: 'https://www.etsy.com/legal/ip/',
})

function growthPct(current, previous) {
  if (current == null || previous == null) return null
  if (previous === 0) return current === 0 ? 0 : 100
  return Math.round(((current - previous) / previous) * 1000) / 10
}

function round1(n) {
  return n == null || !Number.isFinite(n) ? null : Math.round(n * 10) / 10
}

function safeDiv(a, b) {
  if (b == null || b === 0 || a == null) return null
  return a / b
}

function windowBounds(windowDays, nowMs = Date.now()) {
  const days = windowDays === 28 ? 28 : 7
  const nowSec = Math.floor(nowMs / 1000)
  const currentTo = nowSec
  const currentFrom = nowSec - days * 24 * 3600
  const baselineTo = currentFrom
  const baselineFrom = currentFrom - days * 24 * 3600
  return { days, currentFrom, currentTo, baselineFrom, baselineTo }
}

function utcToday(nowMs = Date.now()) {
  return new Date(nowMs).toISOString().slice(0, 10)
}

function shiftDate(isoDay, days) {
  const ms = Date.parse(`${isoDay}T00:00:00Z`)
  if (!Number.isFinite(ms)) return null
  return new Date(ms + days * 24 * 3600 * 1000).toISOString().slice(0, 10)
}

function action({ severity, code, shop_id, shop_name, title, why, how, listings = [] }) {
  return {
    severity,
    code,
    shop_id: shop_id || null,
    shop_name: shop_name || null,
    title,
    why,
    how,
    listings: listings.slice(0, 8),
  }
}

function parseTags(raw) {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function orderMetrics(db, fromSec, toSec) {
  return db.prepare(
    `
    SELECT shop_id,
           COUNT(*) AS orders,
           ROUND(SUM(grandtotal_amount), 2) AS gmv,
           ROUND(AVG(grandtotal_amount), 2) AS aov,
           MAX(grandtotal_currency) AS currency
    FROM receipts
    WHERE etsy_created_at >= ? AND etsy_created_at < ?
      AND shop_id != ?
      AND NOT (${CANCELLED_SQL})
    GROUP BY shop_id
  `
  ).all(fromSec, toSec, MANUAL_SHOP_ID)
}

function ledgerMetrics(db, fromSec, toSec) {
  return db.prepare(
    `
    SELECT shop_id,
           ROUND(SUM(CASE WHEN category='sales' THEN amount_cents ELSE 0 END)/100.0, 2) AS gross,
           ROUND(SUM(CASE WHEN category='ads' THEN amount_cents ELSE 0 END)/100.0, 2) AS ads,
           ROUND(SUM(CASE WHEN category='refund' THEN amount_cents ELSE 0 END)/100.0, 2) AS refund
    FROM ledger_entries
    WHERE create_date >= ? AND create_date < ?
      AND shop_id != ?
    GROUP BY shop_id
  `
  ).all(fromSec, toSec, MANUAL_SHOP_ID)
}

function lateShipMetrics(db, fromSec, toSec, nowSec) {
  return db.prepare(
    `
    SELECT shop_id,
           COUNT(*) AS considered,
           SUM(CASE
             WHEN first_ship_by IS NOT NULL AND (
               (is_shipped = 1 AND COALESCE(shipment_notified_at, etsy_updated_at) > first_ship_by + 86400)
               OR (is_shipped = 0 AND first_ship_by < ?)
             ) THEN 1 ELSE 0 END) AS late
    FROM receipts
    WHERE etsy_created_at >= ? AND etsy_created_at < ?
      AND shop_id != ?
      AND NOT (${CANCELLED_SQL})
    GROUP BY shop_id
  `
  ).all(nowSec, fromSec, toSec, MANUAL_SHOP_ID)
}

function listingStateCounts(db) {
  return db.prepare(
    `
    SELECT shop_id, state, COUNT(*) AS n
    FROM listings
    WHERE shop_id != ?
    GROUP BY shop_id, state
  `
  ).all(MANUAL_SHOP_ID)
}

function snapshotDays(db) {
  return db.prepare(
    `SELECT COUNT(DISTINCT captured_on) AS n FROM listing_metric_snapshots`
  ).get()?.n || 0
}

function viewDeltas(db, currentDay, baselineDay) {
  if (!currentDay || !baselineDay || currentDay === baselineDay) return new Map()
  const rows = db.prepare(
    `
    SELECT cur.shop_id,
           SUM(cur.views - prev.views) AS view_delta,
           SUM(cur.num_favorers - prev.num_favorers) AS favorer_delta,
           COUNT(*) AS listings_compared
    FROM listing_metric_snapshots cur
    JOIN listing_metric_snapshots prev
      ON cur.listing_id = prev.listing_id AND prev.captured_on = ?
    WHERE cur.captured_on = ?
      AND cur.views IS NOT NULL AND prev.views IS NOT NULL
    GROUP BY cur.shop_id
  `
  ).all(baselineDay, currentDay)
  return new Map(rows.map((r) => [r.shop_id, r]))
}

function listingViewDeltas(db, currentDay, baselineDay, sinceSec, limit = T.watchlistLimit) {
  if (!currentDay || !baselineDay || currentDay === baselineDay) return []
  return db.prepare(
    `
    SELECT cur.listing_id, cur.shop_id, l.title, l.listing_url, l.state, l.views,
           (cur.views - prev.views) AS view_delta,
           COALESCE(sales.units, 0) AS units_28d
    FROM listing_metric_snapshots cur
    JOIN listing_metric_snapshots prev
      ON cur.listing_id = prev.listing_id AND prev.captured_on = ?
    LEFT JOIN listings l ON l.listing_id = cur.listing_id
    LEFT JOIN (
      SELECT t.listing_id, SUM(t.quantity) AS units
      FROM transactions t
      JOIN receipts r ON r.receipt_id = t.receipt_id
      WHERE t.listing_id IS NOT NULL AND r.etsy_created_at >= ?
      GROUP BY t.listing_id
    ) sales ON sales.listing_id = cur.listing_id
    WHERE cur.captured_on = ?
      AND cur.views IS NOT NULL AND prev.views IS NOT NULL
      AND (cur.views - prev.views) <= 0
      AND prev.views >= 20
    ORDER BY (cur.views - prev.views) ASC, prev.views DESC
    LIMIT ?
  `
  ).all(baselineDay, sinceSec, currentDay, limit)
}

function byShopMap(rows) {
  return new Map(rows.map((r) => [r.shop_id, r]))
}

function shopRows(db) {
  return db.prepare(
    `
    SELECT shop_id, shop_name, listing_active_count, num_favorers,
           transaction_sold_count, review_count, review_average, is_vacation,
           catalog_health_synced_at, reviews_synced_at, listing_count_synced_at
    FROM shops
    WHERE shop_id != ?
    ORDER BY shop_name
  `
  ).all(MANUAL_SHOP_ID)
}

function diagnoseListing(listing) {
  const tags = parseTags(listing.tags)
  const title = String(listing.title || '').trim()
  const words = title.match(/[\p{L}\p{N}]+/gu) || []
  const scored = scoreTitle(title, {})
  const issues = []
  if (words.length < 4) issues.push('title_too_vague')
  if (words.length > 15) issues.push('title_not_scannable')
  if (tags.length < 13) issues.push('unused_tag_slots')
  if (scored.issues.some((issue) => issue.code === 'placeholder_subject')) issues.push('placeholder_subject')
  if (scored.issues.some((issue) => issue.code === 'aesthetic_spam')) issues.push('keyword_stacking')
  if (/\b(?:gift for|perfect gift|best gift|gift present)\b/i.test(title)) issues.push('gift_language')

  let qualityScore = 100
  if (issues.includes('title_too_vague')) qualityScore -= 35
  if (issues.includes('title_not_scannable')) qualityScore -= 20
  if (issues.includes('unused_tag_slots')) qualityScore -= Math.min(25, (13 - tags.length) * 3)
  if (issues.includes('placeholder_subject')) qualityScore -= 35
  if (issues.includes('keyword_stacking')) qualityScore -= 20
  if (issues.includes('gift_language')) qualityScore -= 10
  return { score: Math.max(0, qualityScore), issues: [...new Set(issues)], word_count: words.length, tag_count: tags.length }
}

const THIRD_PARTY_CHARACTER_PATTERNS = CHARACTERS
  .filter((entry) => entry?.name && entry?.franchise)
  .map((entry) => ({
    name: entry.name,
    franchise: entry.franchise,
    re: new RegExp(`(^|[^a-z0-9])${String(entry.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i'),
  }))

function thirdPartyCharacterInTitle(title) {
  const text = String(title || '')
  return THIRD_PARTY_CHARACTER_PATTERNS.find((entry) => entry.re.test(text)) || null
}

function listThirdPartyRightsReview(db) {
  const candidates = db.prepare(
    `
    SELECT l.listing_id, l.shop_id, s.shop_name, l.title, l.listing_url, l.views, l.state
    FROM listings l
    JOIN shops s ON s.shop_id = l.shop_id
    WHERE l.shop_id != ? AND l.state = 'active'
    ORDER BY l.views DESC, l.listing_id
  `
  ).all(MANUAL_SHOP_ID)
  const rows = []
  for (const listing of candidates) {
    const match = thirdPartyCharacterInTitle(listing.title)
    if (!match) continue
    rows.push({
      ...listing,
      character: match.name,
      rights_holder: match.franchise,
      issue: 'documented_authorization_required',
    })
  }
  return rows
}

function buildWatchlist(db, nowSec) {
  const endingBefore = nowSec + T.endingSoonDays * 24 * 3600
  const expired = db.prepare(
    `
    SELECT listing_id, shop_id, title, listing_url, state, views, ending_timestamp
    FROM listings WHERE state = 'expired' AND shop_id != ?
    ORDER BY views DESC LIMIT ?
  `
  ).all(MANUAL_SHOP_ID, T.watchlistLimit)

  const soldOut = db.prepare(
    `
    SELECT listing_id, shop_id, title, listing_url, state, views
    FROM listings WHERE state = 'sold_out' AND shop_id != ?
    ORDER BY views DESC LIMIT ?
  `
  ).all(MANUAL_SHOP_ID, T.watchlistLimit)

  const endingSoon = db.prepare(
    `
    SELECT listing_id, shop_id, title, listing_url, state, views, ending_timestamp, should_auto_renew
    FROM listings
    WHERE shop_id != ? AND state = 'active'
      AND ending_timestamp IS NOT NULL
      AND ending_timestamp <= ?
      AND COALESCE(should_auto_renew, 0) = 0
    ORDER BY ending_timestamp ASC LIMIT ?
  `
  ).all(MANUAL_SHOP_ID, endingBefore, T.watchlistLimit)

  const zeroViews = db.prepare(
    `
    SELECT listing_id, shop_id, title, listing_url, state, views, created_timestamp
    FROM listings
    WHERE shop_id != ? AND state = 'active' AND COALESCE(views, 0) = 0
      AND created_timestamp IS NOT NULL
      AND created_timestamp < ?
    ORDER BY created_timestamp ASC LIMIT ?
  `
  ).all(MANUAL_SHOP_ID, nowSec - 7 * 24 * 3600, T.watchlistLimit)

  const titleCandidates = db.prepare(
    `
    SELECT listing_id, shop_id, title, listing_url, tags, views, state
    FROM listings WHERE shop_id != ? AND state = 'active'
    ORDER BY views DESC LIMIT 80
  `
  ).all(MANUAL_SHOP_ID)

  const weakTitles = []
  for (const listing of titleCandidates) {
    const d = diagnoseListing(listing)
    if (d.issues.length) {
      weakTitles.push({
        listing_id: listing.listing_id,
        shop_id: listing.shop_id,
        title: listing.title,
        listing_url: listing.listing_url,
        views: listing.views,
        title_score: d.score,
        title_word_count: d.word_count,
        tag_count: d.tag_count,
        issues: d.issues,
      })
    }
    if (weakTitles.length >= T.watchlistLimit) break
  }

  const rightsCandidates = listThirdPartyRightsReview(db)
  const rightsReview = []
  const rightsReviewByShop = {}
  let rightsReviewTotal = 0
  for (const listing of rightsCandidates) {
    rightsReviewTotal += 1
    rightsReviewByShop[listing.shop_id] = (rightsReviewByShop[listing.shop_id] || 0) + 1
    if (rightsReview.length < T.watchlistLimit) {
      rightsReview.push(listing)
    }
  }

  return {
    rights_review: rightsReview,
    rights_review_total: rightsReviewTotal,
    rights_review_by_shop: rightsReviewByShop,
    expired,
    sold_out: soldOut,
    ending_soon: endingSoon,
    zero_views: zeroViews,
    weak_titles: weakTitles,
  }
}

function reviewMetrics(db, fromSec, toSec) {
  const recent = db.prepare(
    `
    SELECT shop_id,
           COUNT(*) AS n,
           ROUND(AVG(rating), 2) AS avg_rating,
           SUM(CASE WHEN rating <= 3 THEN 1 ELSE 0 END) AS low
    FROM etsy_reviews
    WHERE created_timestamp >= ? AND created_timestamp < ? AND shop_id != ?
    GROUP BY shop_id
  `
  ).all(fromSec, toSec, MANUAL_SHOP_ID)
  return byShopMap(recent)
}

function reviewPulse(db, fromSec, toSec) {
  const byShop = reviewMetrics(db, fromSec, toSec)

  const low = db.prepare(
    `
    SELECT r.transaction_id, r.shop_id, s.shop_name, r.listing_id, r.rating, r.review,
           r.created_timestamp, l.title AS listing_title
    FROM etsy_reviews r
    JOIN shops s ON s.shop_id = r.shop_id
    LEFT JOIN listings l ON l.listing_id = r.listing_id
    WHERE r.rating <= 3
      AND r.created_timestamp >= ? AND r.created_timestamp < ?
      AND r.shop_id != ?
    ORDER BY r.created_timestamp DESC
    LIMIT 20
  `
  ).all(fromSec, toSec, MANUAL_SHOP_ID)

  return { by_shop: byShop, low_recent: low }
}

function localPeriodBounds(startIso, endIso) {
  const startParts = String(startIso || '').split('-').map(Number)
  const endParts = String(endIso || '').split('-').map(Number)
  if (startParts.length !== 3 || endParts.length !== 3 || [...startParts, ...endParts].some((part) => !Number.isInteger(part))) {
    return null
  }
  const fromMs = new Date(startParts[0], startParts[1] - 1, startParts[2]).getTime()
  const toMs = new Date(endParts[0], endParts[1] - 1, endParts[2] + 1).getTime()
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return null
  return { from: Math.floor(fromMs / 1000), to: Math.floor(toMs / 1000) }
}

function classifyShop(shop) {
  const findings = []
  const push = (sev, code, title, why, how, listings) => {
    findings.push(action({ severity: sev, code, shop_id: shop.shop_id, shop_name: shop.shop_name, title, why, how, listings }))
  }

  if (shop.is_vacation) {
    push('critical', 'vacation', 'Shop is on vacation',
      'Vacation mode hides the shop from search and search ads. Traffic and sales drop until it is turned off.',
      'Turn off vacation mode in Etsy Shop Manager, then confirm it in the next manual shop-health import.')
  }

  if (shop.review_average != null && shop.review_count >= T.ratingMinReviews && shop.review_average < T.ratingWarn) {
    push('high', 'low_rating', `Shop rating is ${Number(shop.review_average).toFixed(2)}`,
      `Etsy includes customer-service quality in ranking. ${shop.review_average} across ${shop.review_count} reviews is below the ${T.ratingWarn} operating line used by this dashboard.`,
      'Reply to every 1–3 star review, fix the quality/shipping cause, and stop ads on listings that collect the complaints.')
  }

  if ((shop.expired_count || 0) > 0) {
    push('high', 'expired_listings', `${shop.expired_count} expired listing${shop.expired_count === 1 ? '' : 's'}`,
      'Expired listings fall out of Etsy Search. Catalogue size that is not live is not ranking.',
      'Open Listings → Expired, renew the ones with history, and turn on auto-renew for keepers.')
  }

  if ((shop.late_ship_rate_pct || 0) >= T.lateShipPct) {
    push('high', 'late_shipping', `Late-ship rate ${shop.late_ship_rate_pct}%`,
      'Customer-service quality is a documented Etsy Search signal. Late dispatch can also contribute to poor reviews or cases.',
      'Shorten processing days, pack the overdue queue first, and do not let ship-by dates pass without a label.')
  }

  if ((shop.sold_out_count || 0) > 0) {
    push('medium', 'sold_out_listings', `${shop.sold_out_count} sold-out listing${shop.sold_out_count === 1 ? '' : 's'}`,
      'Sold-out listings stop converting and usually drop in search until they are restocked.',
      'Restock the sold-out listings that still have views, or deactivate the ones you will not replenish.')
  }

  const trafficLabel = shop.traffic_metric_label || 'Listing views'
  const viewsDrop = shop.traffic_growth_pct ?? shop.views_growth_pct
  const ordersDrop = shop.orders_growth_pct
  if (viewsDrop != null && viewsDrop <= T.viewsDrop) {
    push('high', 'traffic_drop', `${trafficLabel} ${viewsDrop}% vs prior ${shop.window_days}d`,
      `Sales follow traffic. ${trafficLabel} are down, so this is primarily a discovery problem — not checkout.`,
      'Renew expired listings, refresh the first photo and title on the traffic-drop watchlist, and pause ads that are not producing views.')
  } else if (shop.snapshot_ready && (shop.traffic_delta ?? shop.view_delta ?? 0) <= 0 && (ordersDrop || 0) <= T.ordersDrop) {
    push('high', 'traffic_drop', `No ${trafficLabel.toLowerCase()} growth in the last ${shop.window_days}d`,
      shop.data_source === 'manual'
        ? `${trafficLabel} did not grow while orders fell, which points to a discovery problem before checkout.`
        : 'Lifetime listing views did not rise. Etsy only tabulates them for active listings, so this points to a discovery problem.',
      'Renew expired listings, restock sold-out sellers, and refresh photos/titles on listings that used to have views.')
  } else if (viewsDrop != null && viewsDrop >= -5 && ordersDrop != null && ordersDrop <= T.conversionDrop) {
    push('high', 'conversion_drop', `Orders ${ordersDrop}% while views held`,
      'People still find the listings; they are not buying. That is price, photos, reviews, shipping time, or a weak offer — not rank.',
      'Compare price vs. similar sold listings, refresh photos on the hero SKUs, and read the last 10 reviews for objections.')
  } else if (ordersDrop != null && ordersDrop <= T.ordersDropHard) {
    push('high', 'sales_drop', `Orders ${ordersDrop}% vs prior ${shop.window_days}d`,
      shop.snapshot_ready
        ? 'Orders fell. Views did not produce a clean traffic/conversion split, so treat both rank and offer until the next snapshot.'
        : 'Orders fell. Import current and previous Etsy Stats so UED can split this into traffic vs conversion without an API call.',
      'Do not raise ad spend until expired listings, rating, and late ships are clean. Then refresh the top 10 titles/photos.')
  } else if (ordersDrop != null && ordersDrop <= T.ordersDrop) {
    push('medium', 'sales_drop', `Orders ${ordersDrop}% vs prior ${shop.window_days}d`,
      'Soft decline. Worth a 2-week sprint before it becomes a ranking hole.',
      'Check stockouts on recent sellers, title quality, and whether ads spend rose while orders fell.')
  }

  const adsPct = shop.ads_pct_gross
  const adsPerOrder = shop.ads_per_order
  if (shop.orders_current >= 5 && ((adsPct || 0) > T.adsPctHigh || (adsPerOrder || 0) > T.adsPerOrderHigh) && (ordersDrop || 0) < 5) {
    push('medium', 'ads_inefficient', `Ads ${adsPct != null ? adsPct + '% of gross' : 'HKD ' + adsPerOrder + '/order'}`,
      'Ad spend is high relative to sales. Etsy states that ads do not improve organic placement outside designated ad spaces.',
      'Do not use ad spend to repair organic rank. Keep Etsy Ads only on listings that convert profitably, then reassess after 14 days.')
  }

  if ((shop.refund_pct_gross || 0) >= T.refundWatchPct) {
    push('medium', 'refunds', `Refunds ${shop.refund_pct_gross}% of gross`,
      'Refunds reduce net revenue; unresolved service failures can also become cases, and Etsy includes case rate in customer-service quality.',
      'Open the refunded receipts, fix the product/shipping cause, and stop promoting the SKUs that refund.')
  }

  findings.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9))
  const primary = findings[0] || null
  return {
    primary_cause: primary ? primary.code : 'healthy',
    severity: primary ? primary.severity : 'ok',
    findings,
  }
}

function countWatchlistByShop(watchlist, key) {
  const counts = new Map()
  for (const row of watchlist?.[key] || []) {
    counts.set(row.shop_id, (counts.get(row.shop_id) || 0) + 1)
  }
  return counts
}

/**
 * Build a capacity-aware publishing plan. Etsy documents a small temporary
 * recency boost, but explicitly says creating/renewing solely for that boost is
 * not an effective optimization strategy. Targets below are controlled
 * experiments, never a ranking guarantee or a daily-post quota.
 */
function buildListingCadencePlan(shops, watchlist) {
  const weakTitles = countWatchlistByShop(watchlist, 'weak_titles')
  const zeroViews = countWatchlistByShop(watchlist, 'zero_views')
  const rightsReview = Object.keys(watchlist?.rights_review_by_shop || {}).length
    ? new Map(Object.entries(watchlist.rights_review_by_shop))
    : countWatchlistByShop(watchlist, 'rights_review')

  const plans = shops.map((shop) => {
    const blockers = []
    if (shop.is_vacation) blockers.push('vacation mode')
    if ((shop.expired_count || 0) > 0) blockers.push('expired listings')
    if ((shop.late_ship_rate_pct || 0) >= T.lateShipPct) blockers.push('late dispatch')
    if (shop.review_average != null && shop.review_count >= T.ratingMinReviews && shop.review_average < T.ratingWarn) blockers.push('rating')
    if ((rightsReview.get(shop.shop_id) || 0) > 0) blockers.push('third-party rights review')

    const weakCount = weakTitles.get(shop.shop_id) || 0
    const zeroViewCount = zeroViews.get(shop.shop_id) || 0
    const conversionFell =
      shop.conversion_rate_delta != null && shop.conversion_rate_delta <= -0.3
    const trafficFell =
      shop.traffic_growth_pct != null && shop.traffic_growth_pct <= T.viewsDrop
    const strongDemand =
      shop.orders_current >= 15 && (shop.orders_growth_pct || 0) >= T.strongGrowth

    let status
    let targetMin
    let targetMax
    let headline
    let rationale
    let nextSteps

    if (blockers.length) {
      status = 'fix_foundation'
      targetMin = 0
      targetMax = 0
      headline = 'Fix the foundation first'
      rationale = `New inventory will not compensate for ${blockers.join(', ')}. Resolve these before increasing publishing volume.`
      nextSteps = [
        `Resolve ${blockers[0]}.`,
        weakCount ? `Improve the ${weakCount} highest-impact listing hygiene issue(s).` : 'Review Etsy Search Visibility for listing-quality issues.',
        'Resume with one genuinely distinct listing experiment after the blockers clear.',
      ]
    } else if (conversionFell) {
      status = 'improve_conversion'
      targetMin = 0
      targetMax = 1
      headline = 'Repair conversion before adding volume'
      rationale = 'Traffic is reaching the shop, but conversion weakened. More listings would multiply an offer or presentation problem.'
      nextSteps = [
        'Improve the first photo, price/value proposition, delivery promise, and return-policy clarity on the most visited listings.',
        'Use all relevant attributes and 13 varied tags; keep the title clear and scannable.',
        'Publish at most one distinct test after the existing offer is improved.',
      ]
    } else if (shop.data_source !== 'manual') {
      status = 'measure_first'
      targetMin = 1
      targetMax = 1
      headline = 'Establish a measured baseline'
      rationale = 'Orders are available locally, but traffic and conversion are not. One controlled test is more useful than an unmeasured daily schedule.'
      nextSteps = [
        'Import current and previous Etsy Stats for this shop.',
        'Choose one unmet search intent or genuinely new design—not a near-duplicate.',
        'Publish one test, record the hypothesis, and review it after 14 and 28 days.',
      ]
    } else if (strongDemand) {
      status = 'scale_winner'
      targetMin = 1
      targetMax = 2
      headline = 'Scale proven demand carefully'
      rationale = 'The shop has enough current demand to support controlled expansion without flooding the catalogue.'
      nextSteps = [
        'Create one or two genuinely distinct listings based on proven themes or unmet search terms.',
        'Vary the buyer intent, first photo, attributes, and tags; do not clone a winner with cosmetic wording changes.',
        'Keep only experiments that earn qualified visits and orders over 14–28 days.',
      ]
    } else if (trafficFell) {
      status = 'expand_relevance'
      targetMin = 1
      targetMax = 2
      headline = 'Test new search coverage'
      rationale = 'Traffic declined, so a small number of demand-backed listings can test new query coverage while existing listings are repaired.'
      nextSteps = [
        'Use Shop Manager traffic details to identify missing relevant search terms.',
        'Publish one or two distinct listings that answer those intents.',
        zeroViewCount ? `Also improve or retire the ${zeroViewCount} zero-view listing(s) in the watchlist.` : 'Compare each test with the current traffic baseline.',
      ]
    } else {
      status = 'steady_test'
      targetMin = 1
      targetMax = 1
      headline = 'Maintain one quality experiment'
      rationale = 'Performance is stable. A weekly test creates learning without turning recency into the strategy.'
      nextSteps = [
        'Publish one genuinely new, demand-informed listing this week.',
        'Use a clear item-first title, specific category/attributes, 13 varied tags, and a strong first photo.',
        'Review visits, conversion, and orders after 14 and 28 days before scaling.',
      ]
    }

    return {
      shop_id: shop.shop_id,
      shop_name: shop.shop_name,
      status,
      target_min: targetMin,
      target_max: targetMax,
      target_label: targetMax === 0
        ? 'Pause until fixed'
        : targetMin === targetMax
          ? `${targetMin} / week`
          : `${targetMin}–${targetMax} / week`,
      headline,
      rationale,
      next_steps: nextSteps,
      blockers,
      weak_title_count: weakCount,
      zero_view_count: zeroViewCount,
      rights_review_count: rightsReview.get(shop.shop_id) || 0,
    }
  })

  const activePlans = plans.filter((plan) => plan.target_max > 0)
  return {
    principle: 'Quality experiments, not a daily-listing hack',
    summary: 'New listings can receive a small temporary boost while Etsy learns engagement, but Etsy says creating or renewing solely for that boost is not effective. Publish only genuinely distinct, demand-informed listings you can measure.',
    evaluation: 'Check indexing after 48 hours, then evaluate qualified visits, conversion, and orders at 14 and 28 days. Avoid judging rank by searching for your own listings because results are personalized.',
    portfolio_target_min: activePlans.reduce((sum, plan) => sum + plan.target_min, 0),
    portfolio_target_max: activePlans.reduce((sum, plan) => sum + plan.target_max, 0),
    fix_first_count: plans.filter((plan) => plan.status === 'fix_foundation' || plan.status === 'improve_conversion').length,
    measure_first_count: plans.filter((plan) => plan.status === 'measure_first').length,
    shops: plans,
    quality_gate: [
      'Serve a genuinely distinct buyer intent—not a near-duplicate created for recency.',
      'For every third-party character, brand, image, or protected design, retain documented authorization; supplier availability is not a license.',
      'Use a clear item-first title; Etsy suggests considering fewer than 15 words.',
      'Choose the most specific category and complete every relevant attribute.',
      'Use all 13 tag slots with varied, natural multi-word phrases.',
      'Lead with one clear, well-lit product image; Etsy recommends 2000px or more.',
      'Add multiple useful photos and an explicit return policy, even if no returns are accepted.',
      'Check Etsy Search Visibility and resolve customer-service quality issues before scaling.',
    ],
    traffic_methods: [
      {
        title: 'Find demand inside Etsy',
        action: 'Use Marketplace Insights for real search volume, competition, related terms, and 30-day trends; prioritize relevant high-demand opportunities with lower listing supply.',
        evidence: 'official',
        url: ETSY_GUIDANCE.marketplaceInsights,
      },
      {
        title: 'Use your actual search terms',
        action: 'In Etsy Stats, compare which search terms and traffic sources already bring qualified visits. Extend proven terms to genuinely related listings; do not rewrite a winning listing without a measured reason.',
        evidence: 'official',
        url: ETSY_GUIDANCE.stats,
      },
      {
        title: 'Earn the click and the sale',
        action: 'Improve the first photo, item clarity, price/value, processing promise, multiple photos, and return-policy confidence before buying or attracting more traffic.',
        evidence: 'official',
        url: ETSY_GUIDANCE.visibility,
      },
      {
        title: 'Bring qualified external traffic',
        action: 'Use Etsy Share & Save listing links in one sustainable channel such as Pinterest, Instagram, or an opt-in email list. Judge the source by orders and conversion—not raw clicks.',
        evidence: 'official',
        url: ETSY_GUIDANCE.shareAndSave,
      },
      {
        title: 'Protect shop-wide service quality',
        action: 'Monitor message response, on-time shipping/tracking, review rating, and case rate. Falling below Etsy customer-service standards can reduce search visibility.',
        evidence: 'official',
        url: ETSY_GUIDANCE.service,
      },
      {
        title: 'Run controlled experiments',
        action: 'Record a baseline, change one meaningful variable, compare equal full-week windows, and wait for enough visits before deciding. Treat daily fluctuations as noise.',
        evidence: 'operating practice',
        url: null,
      },
    ],
    evidence: [
      { label: 'How Etsy Search Works', url: ETSY_GUIDANCE.search },
      { label: 'Current Etsy title guidance', url: ETSY_GUIDANCE.titles },
      { label: 'Etsy Search Visibility page', url: ETSY_GUIDANCE.visibility },
      { label: 'Marketplace Insights', url: ETSY_GUIDANCE.marketplaceInsights },
      { label: 'Share & Save', url: ETSY_GUIDANCE.shareAndSave },
      { label: 'Etsy Seller Policy', url: ETSY_GUIDANCE.sellerPolicy },
      { label: 'Etsy IP Policy', url: ETSY_GUIDANCE.ipPolicy },
    ],
  }
}

function isolateScope(shops) {
  const scored = shops.filter((s) => s.orders_current + s.orders_baseline >= 6)
  if (scored.length < 2) return { scope: 'insufficient', declining: 0, compared: scored.length }
  const declining = scored.filter((s) => (s.orders_growth_pct ?? 0) <= T.ordersDrop)
  const share = declining.length / scored.length
  return {
    scope: share >= 0.6 ? 'portfolio' : 'shop',
    declining: declining.length,
    compared: scored.length,
  }
}

function buildCoverage(db, nowSec, windowDays) {
  const shops = shopRows(db)
  const listingCount = db.prepare('SELECT COUNT(*) AS n FROM listings WHERE shop_id != ?').get(MANUAL_SHOP_ID)?.n || 0
  const reviewCount = db.prepare('SELECT COUNT(*) AS n FROM etsy_reviews WHERE shop_id != ?').get(MANUAL_SHOP_ID)?.n || 0
  const manual = db.prepare(
    `SELECT COUNT(*) AS imports, COUNT(DISTINCT shop_id) AS shops, MAX(imported_at) AS latest
     FROM growth_manual_comparisons
     WHERE window_days = ?`
  ).get(windowDays) || {}
  const manualOtherWindow = db.prepare(
    `SELECT COUNT(DISTINCT shop_id) AS shops
     FROM growth_manual_comparisons
     WHERE window_days != ?`
  ).get(windowDays) || {}
  const listingDetail = db.prepare(
    `SELECT COUNT(*) AS imports, COUNT(DISTINCT shop_id) AS shops, MAX(imported_at) AS latest
     FROM growth_manual_listing_imports
     WHERE window_days = ?`
  ).get(windowDays) || {}
  const days = snapshotDays(db)
  const latestSnap = db.prepare('SELECT MAX(captured_on) AS d FROM listing_metric_snapshots').get()?.d || null
  const oldestSnap = db.prepare('SELECT MIN(captured_on) AS d FROM listing_metric_snapshots').get()?.d || null
  const stale = shops.filter((s) => !s.catalog_health_synced_at || nowSec - s.catalog_health_synced_at > 36 * 3600)
  return {
    shops: shops.length,
    listings_cached: listingCount,
    reviews_cached: reviewCount,
    snapshot_days: days,
    latest_snapshot_on: latestSnap,
    oldest_snapshot_on: oldestSnap,
    snapshot_ready: days >= 2 || Number(manual.shops || 0) > 0,
    manual_imports: Number(manual.imports || 0),
    manual_shops: Number(manual.shops || 0),
    manual_other_window_shops: Number(manualOtherWindow.shops || 0),
    latest_manual_import_at: manual.latest || null,
    manual_listing_imports: Number(listingDetail.imports || 0),
    manual_listing_shops: Number(listingDetail.shops || 0),
    latest_manual_listing_import_at: listingDetail.latest || null,
    shops_needing_catalog: stale.map((s) => ({ shop_id: s.shop_id, shop_name: s.shop_name, catalog_health_synced_at: s.catalog_health_synced_at })),
    note: 'Manual Etsy Stats comparisons—including optional per-listing tables—use zero Etsy API calls. Optional API listing-view snapshots require recorded Etsy analytics authorization.',
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ windowDays?: number, shopId?: string, nowMs?: number }} [opts]
 */
function buildGrowthReport(db, opts = {}) {
  const nowMs = opts.nowMs || Date.now()
  const nowSec = Math.floor(nowMs / 1000)
  const win = windowBounds(opts.windowDays, nowMs)
  const today = utcToday(nowMs)
  const baselineDay = db.prepare(
    `SELECT MAX(captured_on) AS d FROM listing_metric_snapshots WHERE captured_on <= ?`
  ).get(shiftDate(today, -win.days))?.d || null
  const currentDay = db.prepare(
    `SELECT MAX(captured_on) AS d FROM listing_metric_snapshots WHERE captured_on <= ?`
  ).get(today)?.d || null

  const shops = shopRows(db)
  const currentOrders = byShopMap(orderMetrics(db, win.currentFrom, win.currentTo))
  const baselineOrders = byShopMap(orderMetrics(db, win.baselineFrom, win.baselineTo))
  const currentLedger = byShopMap(ledgerMetrics(db, win.currentFrom, win.currentTo))
  const late = byShopMap(lateShipMetrics(db, win.currentFrom, win.currentTo, nowSec))
  const states = listingStateCounts(db)
  const stateByShop = new Map()
  for (const row of states) {
    if (!stateByShop.has(row.shop_id)) stateByShop.set(row.shop_id, {})
    stateByShop.get(row.shop_id)[row.state] = row.n
  }
  const views = viewDeltas(db, currentDay, baselineDay)
  const priorBaselineDay = db.prepare(
    `SELECT MAX(captured_on) AS d FROM listing_metric_snapshots WHERE captured_on <= ?`
  ).get(shiftDate(today, -win.days * 2))?.d || null
  const priorViews = viewDeltas(db, baselineDay, priorBaselineDay)
  const reviews = reviewPulse(db, win.currentFrom, win.currentTo)
  const manual = latestManualComparisons(db, { windowDays: win.days, shopId: opts.shopId || null })
  const listingDetail = latestListingDetailImports(db, { windowDays: win.days, shopId: opts.shopId || null })
  const listingDetailUsable = new Map()
  const listingDetailMismatches = []
  for (const [shopId, detail] of listingDetail) {
    const aggregate = manual.get(shopId)
    const aligned = !aggregate || (
      aggregate.current.start === detail.current.start &&
      aggregate.current.end === detail.current.end &&
      aggregate.baseline.start === detail.baseline.start &&
      aggregate.baseline.end === detail.baseline.end
    )
    if (aligned) listingDetailUsable.set(shopId, detail)
    else listingDetailMismatches.push({ shop_id: shopId, shop_name: detail.shop_name, detail, aggregate })
  }
  const listingInsights = [...listingDetailUsable.values()]
    .map(buildListingDetailInsights)
    .filter(Boolean)
  const shopName = Object.fromEntries(shops.map((s) => [s.shop_id, s.shop_name]))
  const manualSignalCache = new Map()
  const signalsForManualPeriod = (manualRow) => {
    if (!manualRow) return null
    const key = `${manualRow.current.start}|${manualRow.current.end}`
    if (manualSignalCache.has(key)) return manualSignalCache.get(key)
    const bounds = localPeriodBounds(manualRow.current.start, manualRow.current.end)
    const signals = bounds
      ? {
          bounds,
          late: byShopMap(lateShipMetrics(db, bounds.from, bounds.to, nowSec)),
          reviews: reviewMetrics(db, bounds.from, bounds.to),
        }
      : null
    manualSignalCache.set(key, signals)
    return signals
  }

  const shopReports = shops
    .filter((s) => !opts.shopId || s.shop_id === opts.shopId)
    .map((s) => {
      const localCur = currentOrders.get(s.shop_id) || { orders: 0, gmv: 0, aov: null, currency: null }
      const localBase = baselineOrders.get(s.shop_id) || { orders: 0, gmv: 0, aov: null }
      const led = currentLedger.get(s.shop_id) || { gross: 0, ads: 0, refund: 0 }
      const st = stateByShop.get(s.shop_id) || {}
      const viewRow = views.get(s.shop_id)
      const priorViewRow = priorViews.get(s.shop_id)
      const manualRow = manual.get(s.shop_id) || null
      const manualSignals = signalsForManualPeriod(manualRow)
      const lateRow = (manualSignals?.late || late).get(s.shop_id) || { considered: 0, late: 0 }
      const reviewRow = (manualSignals?.reviews || reviews.by_shop).get(s.shop_id)
      const listingDetailRow = listingDetailUsable.get(s.shop_id) || null
      const manualCurrent = manualRow?.current || null
      const manualBaseline = manualRow?.baseline || null
      const ordersCurrent = manualCurrent ? manualCurrent.orders : (localCur.orders || 0)
      const ordersBaseline = manualBaseline ? manualBaseline.orders : (localBase.orders || 0)
      const gmvCurrent = manualCurrent?.revenue ?? localCur.gmv ?? 0
      const gmvBaseline = manualBaseline?.revenue ?? localBase.gmv ?? 0
      const trafficMetric = manualCurrent?.visits != null && manualBaseline?.visits != null
        ? 'visits'
        : manualCurrent?.views != null && manualBaseline?.views != null
          ? 'views'
          : 'api_listing_views'
      const trafficCurrent = trafficMetric === 'visits'
        ? manualCurrent.visits
        : trafficMetric === 'views'
          ? manualCurrent.views
          : null
      const trafficBaseline = trafficMetric === 'visits'
        ? manualBaseline.visits
        : trafficMetric === 'views'
          ? manualBaseline.views
          : null
      const apiSnapshotReady = Boolean(viewRow && viewRow.listings_compared > 0)
      const manualSnapshotReady = trafficCurrent != null && trafficBaseline != null
      const snapshotReady = manualSnapshotReady || apiSnapshotReady
      const trafficDelta = manualSnapshotReady
        ? trafficCurrent - trafficBaseline
        : apiSnapshotReady
          ? viewRow.view_delta
          : null
      const trafficGrowth = manualSnapshotReady
        ? growthPct(trafficCurrent, trafficBaseline)
        : priorViewRow && apiSnapshotReady
          ? growthPct(viewRow.view_delta || 0, priorViewRow.view_delta || 0)
          : null
      // Never mix a manually dated period with rolling ledger values from a
      // different window. Optional manual values stay null when omitted.
      const gross = manualRow ? manualCurrent.revenue : (led.gross ?? 0)
      const ads = manualRow ? manualCurrent.ad_spend : Math.abs(led.ads || 0)
      const refund = manualRow ? null : Math.abs(led.refund || 0)
      const manualHealth = manualRow?.health || {}
      const aov = ordersCurrent > 0 && gmvCurrent != null
        ? Math.round((gmvCurrent / ordersCurrent) * 100) / 100
        : localCur.aov
      const report = {
        shop_id: s.shop_id,
        shop_name: s.shop_name,
        window_days: win.days,
        data_source: manualRow ? 'manual' : 'local_sync',
        manual_import_id: manualRow?.id ?? null,
        manual_imported_at: manualRow?.imported_at ?? null,
        manual_period: manualRow ? {
          current_start: manualCurrent.start,
          current_end: manualCurrent.end,
          baseline_start: manualBaseline.start,
          baseline_end: manualBaseline.end,
        } : null,
        manual_warnings: manualRow?.warnings || [],
        operational_signal_period: manualSignals ? {
          start: manualRow.current.start,
          end: manualRow.current.end,
        } : null,
        manual_listing_import_id: listingDetailRow?.id ?? null,
        manual_listing_imported_at: listingDetailRow?.imported_at ?? null,
        manual_listing_rows: listingDetailRow?.row_count ?? 0,
        currency: manualRow?.currency || localCur.currency || null,
        orders_current: ordersCurrent,
        orders_baseline: ordersBaseline,
        orders_growth_pct: growthPct(ordersCurrent, ordersBaseline),
        gmv_current: gmvCurrent,
        gmv_baseline: gmvBaseline,
        aov,
        ads,
        ads_per_order: round1(safeDiv(ads, ordersCurrent)),
        ads_pct_gross: round1(safeDiv(ads, gross) * 100),
        refund,
        refund_pct_gross: round1(safeDiv(refund, gross) * 100),
        listing_active_count: manualHealth.listing_active_count ?? s.listing_active_count ?? st.active ?? 0,
        expired_count: manualHealth.listing_expired_count ?? st.expired ?? 0,
        sold_out_count: manualHealth.listing_sold_out_count ?? st.sold_out ?? 0,
        draft_count: st.draft || 0,
        inactive_count: st.inactive || 0,
        num_favorers: s.num_favorers,
        review_count: manualHealth.review_count ?? s.review_count,
        review_average: manualHealth.review_average ?? s.review_average,
        recent_review_avg: reviewRow?.avg_rating ?? null,
        recent_low_reviews: reviewRow?.low || 0,
        is_vacation: manualHealth.is_vacation ?? (s.is_vacation === 1 || s.is_vacation === true),
        late_ship_rate_pct: round1(safeDiv(lateRow.late || 0, lateRow.considered || 0) * 100),
        late_ships: lateRow.late || 0,
        traffic_metric: trafficMetric,
        traffic_metric_label: trafficMetric === 'visits' ? 'Visits' : trafficMetric === 'views' ? 'Views' : 'Listing views',
        traffic_current: trafficCurrent,
        traffic_baseline: trafficBaseline,
        traffic_delta: trafficDelta,
        traffic_growth_pct: trafficGrowth,
        view_delta: trafficDelta,
        favorer_delta: manualCurrent?.favorites != null && manualBaseline?.favorites != null
          ? manualCurrent.favorites - manualBaseline.favorites
          : apiSnapshotReady
            ? viewRow.favorer_delta
            : null,
        views_growth_pct: trafficGrowth,
        conversion_rate: manualCurrent?.conversion_rate ?? null,
        conversion_rate_baseline: manualBaseline?.conversion_rate ?? null,
        conversion_rate_delta: manualCurrent?.conversion_rate != null && manualBaseline?.conversion_rate != null
          ? round1(manualCurrent.conversion_rate - manualBaseline.conversion_rate)
          : null,
        snapshot_ready: snapshotReady,
        catalog_health_synced_at: s.catalog_health_synced_at,
      }
      const diagnosed = classifyShop(report)
      return { ...report, ...diagnosed }
    })
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) || (b.orders_current - a.orders_current))

  const scope = isolateScope(shopReports)
  const actions = []
  if (scope.scope === 'portfolio') {
    actions.push(action({
      severity: 'high',
      code: 'portfolio_decline',
      title: `${scope.declining} of ${scope.compared} shops declined together — validate the cause first`,
      why: 'A synchronized decline can be seasonality, category demand, a Stats/reporting issue, or broader search visibility—not nine independent listing failures.',
      how: 'Check Etsy Search Visibility and the traffic-source mix, compare the same period with an Etsy-wide trend, and preserve the current baseline. Do not mass-renew, bulk-edit, or toggle Vacation Mode based only on a forum workaround.',
    }))
  }
  for (const shop of shopReports) {
    for (const finding of shop.findings) actions.push(finding)
  }
  for (const insight of listingInsights) {
    const conversionRows = insight.groups.conversion_fixes || []
    const trafficRows = insight.groups.traffic_losses || []
    const interestRows = insight.groups.interest_not_sales || []
    const winnerRows = insight.groups.winners || []
    const counts = insight.group_counts || {}
    if (counts.conversion_fixes) {
      actions.push(action({
        severity: 'high',
        code: 'manual_listing_conversion',
        shop_id: insight.import.shop_id,
        shop_name: insight.import.shop_name,
        title: `${counts.conversion_fixes} viewed listing(s) produced no orders`,
        why: `These listings each received at least ${insight.evidence_floor_views} views in the manually entered period, but no order. This is an offer or presentation signal—not proof of a search-ranking problem.`,
        how: 'Compare the first image, total price, delivery estimate, variations, description clarity, and trust signals with the shop’s winners. Change one variable at a time and re-measure over the same window.',
        listings: conversionRows,
      }))
    }
    if (counts.traffic_losses) {
      actions.push(action({
        severity: 'high',
        code: 'manual_listing_traffic_loss',
        shop_id: insight.import.shop_id,
        shop_name: insight.import.shop_name,
        title: `${counts.traffic_losses} established listing(s) lost at least 30% of views`,
        why: 'The decline is based on equal manually entered periods. It can reflect demand, seasonality, search relevance, competition, or listing quality; it does not identify a single algorithm cause.',
        how: 'Inspect the listing’s Etsy search terms and traffic source in Shop Manager, verify inventory and policy status, then test a clearer first image or one evidence-backed title/tag change. Do not mass-renew or keyword-stuff.',
        listings: trafficRows,
      }))
    }
    if (counts.interest_not_sales) {
      actions.push(action({
        severity: 'medium',
        code: 'manual_listing_interest_gap',
        shop_id: insight.import.shop_id,
        shop_name: insight.import.shop_name,
        title: `${counts.interest_not_sales} listing(s) gained favorites without order growth`,
        why: 'Interest increased but completed purchases did not, which can indicate price, shipping, timing, variation, or confidence friction.',
        how: 'Review the total delivered price and processing time, make options easier to understand, and consider Etsy’s native favorited-item offer where eligible. Avoid external buyer targeting.',
        listings: interestRows,
      }))
    }
    if (counts.winners) {
      actions.push(action({
        severity: 'low',
        code: 'manual_listing_winners',
        shop_id: insight.import.shop_id,
        shop_name: insight.import.shop_name,
        title: `${counts.winners} listing winner(s) earned more orders or revenue`,
        why: 'These are the strongest local signals for what buyers currently want in this shop.',
        how: 'Protect stock and delivery quality, document the winning query/photo/offer, and test one genuinely distinct adjacent product. Do not clone listings solely to manipulate recency.',
        listings: winnerRows,
      }))
    }
  }
  for (const mismatch of listingDetailMismatches) {
    actions.push(action({
      severity: 'medium',
      code: 'manual_listing_period_mismatch',
      shop_id: mismatch.shop_id,
      shop_name: mismatch.shop_name,
      title: 'Per-listing detail does not match the latest aggregate Stats period',
      why: `The latest listing table covers ${mismatch.detail.current.start}–${mismatch.detail.current.end}, while the aggregate comparison covers ${mismatch.aggregate.current.start}–${mismatch.aggregate.current.end}. Combining them would produce misleading recommendations.`,
      how: 'Import the per-listing current and previous tables using exactly the same dates as the latest aggregate comparison.',
    }))
  }
  actions.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9))

  const watchlist = buildWatchlist(db, nowSec)
  watchlist.traffic_drop_listings = listingViewDeltas(db, currentDay, baselineDay, win.currentFrom).map((row) => ({
    ...row,
    shop_name: shopName[row.shop_id] || row.shop_id,
  }))
  for (const shop of shopReports) {
    const rightsCount = Number(watchlist.rights_review_by_shop[shop.shop_id] || 0)
    shop.rights_review_count = rightsCount
    if (rightsCount > 0 && shop.severity !== 'critical') {
      shop.severity = 'high'
      shop.primary_cause = 'third_party_rights_review'
    }
  }
  shopReports.sort((a, b) =>
    (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) ||
    b.orders_current - a.orders_current
  )
  if (watchlist.rights_review_total > 0) {
    actions.push(action({
      severity: 'high',
      code: 'third_party_rights_review',
      title: `${watchlist.rights_review_total} active listing(s) reference identified third-party characters`,
      why: 'The character catalog identifies likely rights holders; it does not grant a license. Etsy may terminate selling privileges after repeat or multiple infringement notices.',
      how: 'Before publishing, renewing, or promoting them, verify documented authorization and Creativity Standards eligibility. A supplier selling the product is not proof of IP permission; exclude or remove any item you cannot substantiate.',
      listings: watchlist.rights_review,
    }))
    actions.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9))
  }

  const portfolioOrdersCur = shopReports.reduce((n, s) => n + s.orders_current, 0)
  const portfolioOrdersBase = shopReports.reduce((n, s) => n + s.orders_baseline, 0)
  const currencies = [...new Set(shopReports.map((s) => s.currency).filter(Boolean))]
  const gmvCur = shopReports.reduce((n, s) => n + (s.gmv_current || 0), 0)
  const trafficRows = shopReports.filter((s) => s.traffic_delta != null)
  const viewDelta = trafficRows.length ? trafficRows.reduce((n, s) => n + (s.traffic_delta || 0), 0) : null
  const trafficMetrics = [...new Set(trafficRows.map((s) => s.traffic_metric))]
  const comparableTrafficRows = trafficMetrics.length === 1
    ? trafficRows.filter((s) => s.traffic_current != null && s.traffic_baseline != null)
    : []
  const trafficCurrent = comparableTrafficRows.length
    ? comparableTrafficRows.reduce((sum, s) => sum + s.traffic_current, 0)
    : null
  const trafficBaseline = comparableTrafficRows.length
    ? comparableTrafficRows.reduce((sum, s) => sum + s.traffic_baseline, 0)
    : null
  const manualVisitRows = shopReports.filter((s) => s.data_source === 'manual' && s.traffic_metric === 'visits')
  const manualVisitsCurrent = manualVisitRows.reduce((sum, s) => sum + (s.traffic_current || 0), 0)
  const manualVisitsBaseline = manualVisitRows.reduce((sum, s) => sum + (s.traffic_baseline || 0), 0)
  const manualOrdersCurrent = manualVisitRows.reduce((sum, s) => sum + (s.orders_current || 0), 0)
  const manualOrdersBaseline = manualVisitRows.reduce((sum, s) => sum + (s.orders_baseline || 0), 0)
  const cadence = buildListingCadencePlan(shopReports, watchlist)
  const coverage = buildCoverage(db, nowSec, win.days)
  coverage.manual_listing_usable_shops = listingDetailUsable.size
  coverage.manual_listing_period_mismatches = listingDetailMismatches.length

  return {
    generated_at: new Date(nowMs).toISOString(),
    window: {
      days: win.days,
      current_from: new Date(win.currentFrom * 1000).toISOString(),
      current_to: new Date(win.currentTo * 1000).toISOString(),
      baseline_from: new Date(win.baselineFrom * 1000).toISOString(),
      baseline_to: new Date(win.baselineTo * 1000).toISOString(),
      snapshot_current_on: currentDay,
      snapshot_baseline_on: baselineDay,
    },
    coverage,
    scope,
    portfolio: {
      orders_current: portfolioOrdersCur,
      orders_baseline: portfolioOrdersBase,
      orders_growth_pct: growthPct(portfolioOrdersCur, portfolioOrdersBase),
      gmv_current: currencies.length === 1 ? gmvCur : null,
      currency: currencies.length === 1 ? currencies[0] : currencies.length ? 'MIXED' : null,
      view_delta: viewDelta,
      traffic_delta: viewDelta,
      traffic_metric: trafficMetrics.length === 1 ? trafficMetrics[0] : trafficMetrics.length ? 'mixed' : null,
      traffic_current: trafficCurrent,
      traffic_baseline: trafficBaseline,
      traffic_growth_pct: growthPct(trafficCurrent, trafficBaseline),
      manual_shops: shopReports.filter((s) => s.data_source === 'manual').length,
      conversion_rate: manualVisitsCurrent > 0 ? round1((manualOrdersCurrent / manualVisitsCurrent) * 100) : null,
      conversion_rate_baseline: manualVisitsBaseline > 0 ? round1((manualOrdersBaseline / manualVisitsBaseline) * 100) : null,
      shops_vacation: shopReports.filter((s) => s.is_vacation).length,
      shops_expired: shopReports.filter((s) => s.expired_count > 0).length,
    },
    shops: shopReports,
    actions: actions.slice(0, 40),
    cadence,
    listing_insights: listingInsights,
    watchlist,
    reviews: {
      low_recent: reviews.low_recent,
    },
  }
}

module.exports = {
  buildGrowthReport,
  classifyShop,
  buildListingCadencePlan,
  listThirdPartyRightsReview,
  windowBounds,
  growthPct,
  T,
}
