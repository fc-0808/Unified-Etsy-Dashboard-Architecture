'use strict'

/**
 * Offline tests for catalog-health persistence and the growth diagnostics engine.
 * No Etsy credentials, proxies, or network.
 */

const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const {
  initDb,
  syncConfigToDb,
  upsertListing,
  upsertEtsyReview,
  updateShopHealth,
  snapshotListingMetrics,
  utcToday,
  markCatalogHealthSynced,
} = require('../src/db/setup')
const { buildGrowthReport, buildListingCadencePlan, classifyShop, growthPct, windowBounds } = require('../src/growth/diagnostics')
const { shopNeedsCatalogHealth, syncShopCatalogHealth } = require('../src/growth/catalog-sync')
const {
  normalizeManualComparison,
  parsePastedStatsText,
  saveManualComparison,
  listManualComparisons,
  deleteManualComparison,
} = require('../src/growth/manual-import')
const {
  parsePastedListingStats,
  normalizeListingDetailImport,
  saveListingDetailImport,
  listListingDetailImports,
  deleteListingDetailImport,
  buildListingDetailInsights,
} = require('../src/growth/manual-listing-import')

const realSetTimeout = global.setTimeout
global.setTimeout = (fn) => {
  fn()
  return 0
}

let passed = 0
const failures = []
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok  — ${name}`)
  } catch (err) {
    failures.push({ name, err })
    console.error(`  FAIL — ${name}\n       ${err.stack || err.message}`)
  }
}

const CONFIG = {
  groups: [{
    group_id: 'g1',
    label: 'Test',
    proxy: 'direct',
    shops: [
      { shop_id: 'shop-a', shop_name: 'Alpha', api_key: 'k', shared_secret: 's' },
      { shop_id: 'shop-b', shop_name: 'Beta', api_key: 'k', shared_secret: 's' },
    ],
  }],
}

function seedDb() {
  const db = initDb(':memory:')
  syncConfigToDb(db, CONFIG)
  return db
}

function insertReceipt(db, { id, shopId, created, gmv = 100, shipped = 1, shipBy = null, notified = null, status = 'Completed' }) {
  db.prepare(`
    INSERT INTO receipts (
      receipt_id, shop_id, group_id, status, is_shipped, is_paid,
      grandtotal_amount, grandtotal_currency, etsy_created_at, first_ship_by, shipment_notified_at
    ) VALUES (?, ?, 'g1', ?, ?, 1, ?, 'HKD', ?, ?, ?)
  `).run(id, shopId, status, shipped, gmv, created, shipBy, notified)
}

function listing(partial) {
  return {
    listing_id: 1,
    title: 'Hello Kitty Bow MagSafe iPhone Case for iPhone 16 15 14 Pro Max',
    state: 'active',
    views: 100,
    num_favorers: 4,
    quantity: 3,
    tags: ['hello kitty', 'iphone case', 'magsafe'],
    url: 'https://etsy.com/listing/1',
    ...partial,
  }
}

const NOW = Date.parse('2026-08-28T12:00:00Z')
const NOW_SEC = Math.floor(NOW / 1000)
const DAY = 86400

;(async () => {
  await test('growthPct handles zeros and rounding', () => {
    assert.equal(growthPct(20, 10), 100)
    assert.equal(growthPct(0, 0), 0)
    assert.equal(growthPct(10, 0), 100)
    assert.equal(growthPct(null, 10), null)
    assert.equal(windowBounds(7, NOW).days, 7)
    assert.equal(windowBounds(28, NOW).days, 28)
  })

  await test('optional catalog collection requires opt-in plus written-approval attestation', () => {
    const worker = fs.readFileSync(path.resolve(__dirname, '../src/workers/sync.js'), 'utf8')
    const schema = fs.readFileSync(path.resolve(__dirname, '../src/config/schema.js'), 'utf8')
    const server = fs.readFileSync(path.resolve(__dirname, '../src/server/index.js'), 'utf8')
    assert.match(worker, /config\.catalog_health_sync === true && config\.etsy_api_analytics_approved === true/)
    assert.match(worker, /optionalAnalyticsApproved && Date\.now\(\) - lastCount >= LISTING_COUNT_TTL_MS/)
    assert.match(schema, /catalog_health_sync:\s*raw\.catalog_health_sync === true/)
    assert.match(schema, /etsy_api_analytics_approved:\s*raw\.etsy_api_analytics_approved === true/)
    assert.match(server, /if \(!liveMetadataApproved \|\| !tokenManager\.hasTokens/)
    assert.match(server, /analyticsMetrics:\s*growthApiAnalyticsEnabled\(\)/)
  })

  await test('pasted Etsy Stats template parses without persisting raw text', () => {
    const parsed = parsePastedStatsText(`
CURRENT
2026-08-22 to 2026-08-28
Visits: 1,240
Views: 2,860
Orders: 31
Revenue: HKD 4,920.50
Conversion rate: 2.5%

PREVIOUS
2026-08-15 to 2026-08-21
Visits: 1,560
Views: 3,240
Orders: 43
Revenue: HKD 6,880.00

SHOP HEALTH
Rating: 4.8
Review count: 120
Vacation mode: off
Currency: HKD
`)
    assert.equal(parsed.current.start, '2026-08-22')
    assert.equal(parsed.current.visits, '1,240')
    assert.equal(parsed.baseline.orders, '43')
    assert.equal(parsed.health.review_average, '4.8')
    assert.equal(parsed.health.is_vacation, 'off')
    assert.equal(parsed.currency, 'HKD')
    assert.ok(parsed.recognized_fields >= 12)
    assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'raw_text'), false)

    const chinese = parsePastedStatsText(`
本期
2026-08-22 至 2026-08-28
访问量：900
订单：18
上期
2026-08-15 至 2026-08-21
访问量：1200
订单：24
店铺状态
平均评分：4.9
假期模式：关闭
`)
    assert.equal(chinese.current.visits, '900')
    assert.equal(chinese.baseline.orders, '24')
    assert.equal(chinese.health.review_average, '4.9')
    assert.equal(chinese.health.is_vacation, '关闭')
  })

  await test('manual comparisons require equal supported windows and comparable traffic', () => {
    const valid = normalizeManualComparison({
      import_key: 'manual_test_valid',
      shop_id: 'shop-a',
      currency: 'HKD',
      current: { start: '2026-08-22', end: '2026-08-28', visits: '1,000', orders: '25', revenue: '5,000' },
      baseline: { start: '2026-08-15', end: '2026-08-21', visits: '1,250', orders: '30', revenue: '6,000' },
    }, { nowMs: NOW })
    assert.equal(valid.window_days, 7)
    assert.equal(valid.current.visits, 1000)
    assert.equal(valid.current.conversion_rate, 2.5)
    assert.throws(() => normalizeManualComparison({
      import_key: 'manual_test_bad',
      shop_id: 'shop-a',
      current: { start: '2026-08-22', end: '2026-08-28', visits: 100, orders: 2 },
      baseline: { start: '2026-08-01', end: '2026-08-21', visits: 100, orders: 2 },
    }, { nowMs: NOW }), /same length/)
    assert.throws(() => normalizeManualComparison({
      import_key: 'manual_test_mixed',
      shop_id: 'shop-a',
      current: { start: '2026-08-22', end: '2026-08-28', visits: 100, orders: 2 },
      baseline: { start: '2026-08-15', end: '2026-08-21', views: 100, orders: 2 },
    }, { nowMs: NOW }), /same traffic metric/)
  })

  await test('per-listing paste joins two Stats tables without retaining raw text', () => {
    const parsed = parsePastedListingStats(`
CURRENT LISTINGS
Listing ID	Title	Views	Favorites	Orders	Revenue
101	Strong case	120	12	4	HKD 800
102	Viewed but not bought	90	9	0	HKD 0
103	Current only	5	0	0	HKD 0

PREVIOUS LISTINGS
Listing ID	Title	Views	Favorites	Orders	Revenue
101	Strong case	60	4	1	HKD 200
102	Viewed but not bought	100	5	0	HKD 0
104	Previous only	30	2	1	HKD 100
`)
    assert.equal(parsed.matched_rows, 2)
    assert.equal(parsed.current_rows, 3)
    assert.equal(parsed.baseline_rows, 3)
    assert.equal(parsed.rows[0].listing_id, '101')
    assert.equal(parsed.rows[0].current.views, 120)
    assert.equal(parsed.rows[0].baseline.orders, 1)
    assert.equal(parsed.warnings.length, 2)
    assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'raw'), false)
    assert.throws(
      () => parsePastedListingStats('CURRENT LISTINGS\nListing\tViews\tOrders\nA\t1\t0'),
      /CURRENT LISTINGS and PREVIOUS LISTINGS/
    )
  })

  await test('per-listing detail is validated, idempotent, and drives local funnel actions', () => {
    const db = seedDb()
    const payload = {
      import_key: 'listing_detail_test_001',
      shop_id: 'shop-a',
      currency: 'HKD',
      current: { start: '2026-08-22', end: '2026-08-28' },
      baseline: { start: '2026-08-15', end: '2026-08-21' },
      warnings: ['One title-only row was excluded.'],
      rows: [
        {
          listing_id: '101',
          title: 'Current winner',
          current: { views: 120, favorites: 12, orders: 4, revenue: 800 },
          baseline: { views: 60, favorites: 4, orders: 1, revenue: 200 },
        },
        {
          listing_id: '102',
          title: 'Viewed but not bought',
          current: { views: 90, favorites: 9, orders: 0, revenue: 0 },
          baseline: { views: 100, favorites: 5, orders: 0, revenue: 0 },
        },
        {
          listing_id: '103',
          title: 'Traffic loss',
          current: { views: 30, favorites: 1, orders: 0, revenue: 0 },
          baseline: { views: 100, favorites: 3, orders: 1, revenue: 120 },
        },
      ],
    }
    const normalized = normalizeListingDetailImport(payload, { nowMs: NOW })
    assert.equal(normalized.window_days, 7)
    assert.equal(normalized.rows[0].current_views, 120)

    const first = saveListingDetailImport(db, payload, { importedBy: 'owner', nowMs: NOW })
    const retry = saveListingDetailImport(db, payload, { importedBy: 'owner', nowMs: NOW })
    assert.equal(first.deduplicated, false)
    assert.equal(retry.deduplicated, true)
    assert.equal(first.detail.row_count, 3)
    assert.equal(first.detail.totals.current.views, 240)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM growth_manual_listing_rows').get().n, 3)

    const insights = buildListingDetailInsights(first.detail)
    assert.equal(insights.zero_api_calls, true)
    assert.equal(insights.groups.winners[0].listing_id, '101')
    assert.ok(insights.groups.conversion_fixes.some((row) => row.listing_id === '102'))
    assert.ok(insights.groups.traffic_losses.some((row) => row.listing_id === '103'))

    const report = buildGrowthReport(db, { windowDays: 7, shopId: 'shop-a', nowMs: NOW })
    assert.equal(report.listing_insights.length, 1)
    assert.equal(report.coverage.manual_listing_shops, 1)
    assert.ok(report.actions.some((item) => item.code === 'manual_listing_conversion'))
    assert.ok(report.actions.some((item) => item.code === 'manual_listing_traffic_loss'))
    assert.ok(report.actions.some((item) => item.code === 'manual_listing_winners'))
    assert.equal(report.shops[0].manual_listing_rows, 3)

    const listed = listListingDetailImports(db, { shopId: 'shop-a' })
    assert.equal(listed.length, 1)
    assert.equal(listed[0].row_count, 3)
    assert.equal(listed[0].rows.length, 0)
    assert.equal(deleteListingDetailImport(db, first.detail.id), true)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM growth_manual_listing_rows').get().n, 0)
  })

  await test('report refuses to combine aggregate and listing detail from different periods', () => {
    const db = seedDb()
    saveManualComparison(db, {
      import_key: 'aggregate_period_alignment',
      shop_id: 'shop-a',
      current: { start: '2026-08-22', end: '2026-08-28', visits: 100, orders: 2 },
      baseline: { start: '2026-08-15', end: '2026-08-21', visits: 120, orders: 3 },
    }, { nowMs: NOW })
    saveListingDetailImport(db, {
      import_key: 'detail_period_alignment',
      shop_id: 'shop-a',
      current: { start: '2026-08-15', end: '2026-08-21' },
      baseline: { start: '2026-08-08', end: '2026-08-14' },
      rows: [{
        listing_id: '101',
        title: 'Older listing period',
        current: { views: 30, orders: 0 },
        baseline: { views: 50, orders: 1 },
      }],
    }, { nowMs: NOW })
    const report = buildGrowthReport(db, { windowDays: 7, shopId: 'shop-a', nowMs: NOW })
    assert.equal(report.listing_insights.length, 0)
    assert.equal(report.coverage.manual_listing_usable_shops, 0)
    assert.equal(report.coverage.manual_listing_period_mismatches, 1)
    assert.ok(report.actions.some((item) => item.code === 'manual_listing_period_mismatch'))
  })

  await test('manual import is idempotent and becomes the report source', () => {
    const db = seedDb()
    const payload = {
      import_key: 'manual_report_001',
      shop_id: 'shop-a',
      currency: 'HKD',
      current: {
        start: '2026-08-22', end: '2026-08-28',
        visits: 1000, views: 2000, orders: 20, revenue: 4000,
        conversion_rate: 2, favorites: 40, ad_spend: 200,
      },
      baseline: {
        start: '2026-08-15', end: '2026-08-21',
        visits: 1500, views: 2700, orders: 40, revenue: 7000,
        conversion_rate: 2.67, favorites: 60, ad_spend: 250,
      },
      health: {
        review_average: 4.3,
        review_count: 30,
        listing_active_count: 200,
        listing_expired_count: 4,
        listing_sold_out_count: 3,
        is_vacation: false,
      },
    }
    const first = saveManualComparison(db, payload, { importedBy: 'owner', nowMs: NOW })
    const retry = saveManualComparison(db, payload, { importedBy: 'owner', nowMs: NOW })
    assert.equal(first.deduplicated, false)
    assert.equal(retry.deduplicated, true)
    assert.equal(first.comparison.id, retry.comparison.id)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM growth_manual_comparisons').get().n, 1)

    const report = buildGrowthReport(db, { windowDays: 7, nowMs: NOW })
    const alpha = report.shops.find((shop) => shop.shop_id === 'shop-a')
    assert.equal(alpha.data_source, 'manual')
    assert.equal(alpha.orders_current, 20)
    assert.equal(alpha.orders_baseline, 40)
    assert.equal(alpha.orders_growth_pct, -50)
    assert.equal(alpha.traffic_metric, 'visits')
    assert.equal(alpha.traffic_growth_pct, -33.3)
    assert.equal(alpha.review_average, 4.3)
    assert.equal(alpha.expired_count, 4)
    assert.equal(alpha.ads, 200)
    assert.equal(report.coverage.manual_shops, 1)
    assert.equal(report.portfolio.manual_shops, 1)
    assert.ok(report.cadence)
    assert.match(report.cadence.summary, /temporary boost/i)
    assert.ok(alpha.findings.some((finding) => finding.code === 'traffic_drop'))
    const otherWindowReport = buildGrowthReport(db, { windowDays: 28, nowMs: NOW })
    assert.equal(otherWindowReport.coverage.manual_shops, 0)
    assert.equal(otherWindowReport.coverage.manual_other_window_shops, 1)

    const listed = listManualComparisons(db, { shopId: 'shop-a' })
    assert.equal(listed.length, 1)
    assert.equal(listed[0].imported_by, 'owner')
    assert.equal(deleteManualComparison(db, listed[0].id), true)
    assert.equal(deleteManualComparison(db, listed[0].id), false)
  })

  await test('manual reports align late-shipping and review signals to the imported dates', () => {
    const db = seedDb()
    saveManualComparison(db, {
      import_key: 'manual_signal_dates',
      shop_id: 'shop-a',
      current: { start: '2026-08-01', end: '2026-08-07', visits: 100, orders: 3 },
      baseline: { start: '2026-07-25', end: '2026-07-31', visits: 120, orders: 4 },
    }, { nowMs: NOW })
    const august5 = Math.floor(Date.parse('2026-08-05T12:00:00Z') / 1000)
    const august25 = Math.floor(Date.parse('2026-08-25T12:00:00Z') / 1000)
    insertReceipt(db, {
      id: 801,
      shopId: 'shop-a',
      created: august5,
      shipped: 1,
      shipBy: august5 + DAY,
      notified: august5 + 3 * DAY,
    })
    insertReceipt(db, {
      id: 802,
      shopId: 'shop-a',
      created: august25,
      shipped: 1,
      shipBy: august25 + DAY,
      notified: august25 + 3 * DAY,
    })
    upsertEtsyReview(db, 'shop-a', {
      transaction_id: 8101,
      listing_id: 1,
      rating: 2,
      review: 'Older imported-period issue',
      created_timestamp: august5,
    })
    upsertEtsyReview(db, 'shop-a', {
      transaction_id: 8102,
      listing_id: 1,
      rating: 5,
      review: 'Rolling-window review',
      created_timestamp: august25,
    })

    const report = buildGrowthReport(db, { windowDays: 7, shopId: 'shop-a', nowMs: NOW })
    const alpha = report.shops[0]
    assert.deepEqual(alpha.operational_signal_period, { start: '2026-08-01', end: '2026-08-07' })
    assert.equal(alpha.late_ships, 1)
    assert.equal(alpha.late_ship_rate_pct, 100)
    assert.equal(alpha.recent_review_avg, 2)
    assert.equal(alpha.recent_low_reviews, 1)
    assert.equal(report.reviews.low_recent.length, 0)
  })

  await test('vacation is a critical ranking action', () => {
    const d = classifyShop({
      shop_id: 'shop-a',
      shop_name: 'Alpha',
      is_vacation: true,
      orders_current: 10,
      orders_baseline: 12,
      orders_growth_pct: -16,
      window_days: 7,
    })
    assert.equal(d.primary_cause, 'vacation')
    assert.equal(d.severity, 'critical')
    assert.ok(d.findings[0].how.includes('vacation'))
  })

  await test('orders down with flat views is conversion, not traffic', () => {
    const d = classifyShop({
      shop_id: 'shop-a',
      shop_name: 'Alpha',
      is_vacation: false,
      orders_current: 10,
      orders_baseline: 20,
      orders_growth_pct: -50,
      views_growth_pct: 2,
      snapshot_ready: true,
      view_delta: 400,
      window_days: 7,
      expired_count: 0,
      sold_out_count: 0,
    })
    assert.equal(d.primary_cause, 'conversion_drop')
  })

  await test('zero view-delta with order drop is a traffic problem', () => {
    const d = classifyShop({
      shop_id: 'shop-a',
      shop_name: 'Alpha',
      is_vacation: false,
      orders_current: 8,
      orders_baseline: 20,
      orders_growth_pct: -60,
      snapshot_ready: true,
      view_delta: 0,
      window_days: 7,
      expired_count: 0,
    })
    assert.equal(d.primary_cause, 'traffic_drop')
  })

  await test('listing cadence is a quality experiment, never a daily-post hack', () => {
    const plans = buildListingCadencePlan([
      {
        shop_id: 'shop-a',
        shop_name: 'Alpha',
        data_source: 'local_sync',
        orders_current: 10,
        orders_growth_pct: -5,
        expired_count: 0,
        late_ship_rate_pct: 0,
        is_vacation: false,
      },
      {
        shop_id: 'shop-b',
        shop_name: 'Beta',
        data_source: 'manual',
        orders_current: 30,
        orders_growth_pct: 25,
        traffic_growth_pct: 12,
        expired_count: 0,
        late_ship_rate_pct: 0,
        review_average: 4.9,
        review_count: 20,
        is_vacation: false,
      },
    ], { weak_titles: [], zero_views: [] })
    assert.match(plans.principle, /not a daily-listing hack/i)
    assert.match(plans.summary, /not effective/i)
    assert.equal(plans.shops[0].status, 'measure_first')
    assert.equal(plans.shops[0].target_max, 1)
    assert.equal(plans.shops[1].status, 'scale_winner')
    assert.equal(plans.shops[1].target_max, 2)
    assert.equal(plans.quality_gate.length, 8)
    assert.ok(plans.quality_gate.some((item) => item.includes('13 tag slots')))
    assert.equal(plans.traffic_methods.length, 6)
    assert.ok(plans.traffic_methods.some((method) => method.title === 'Find demand inside Etsy'))
    assert.ok(plans.evidence.every((source) => source.url.startsWith('https://')))
  })

  await test('listing cadence pauses when shop-quality blockers exist', () => {
    const plans = buildListingCadencePlan([{
      shop_id: 'shop-a',
      shop_name: 'Alpha',
      data_source: 'manual',
      orders_current: 20,
      orders_growth_pct: 20,
      expired_count: 3,
      late_ship_rate_pct: 12,
      review_average: 4.2,
      review_count: 30,
      is_vacation: false,
    }], { weak_titles: [], zero_views: [], rights_review_by_shop: { 'shop-a': 2 } })
    assert.equal(plans.shops[0].status, 'fix_foundation')
    assert.equal(plans.shops[0].target_max, 0)
    assert.ok(plans.shops[0].blockers.includes('expired listings'))
    assert.ok(plans.shops[0].blockers.includes('late dispatch'))
    assert.ok(plans.shops[0].blockers.includes('third-party rights review'))
  })

  await test('upsertListing writes a same-day metric snapshot', () => {
    const db = seedDb()
    upsertListing(db, 'shop-a', listing({ listing_id: 11, views: 50 }), { snapshotMetrics: true })
    upsertListing(db, 'shop-a', listing({ listing_id: 11, views: 77 }), { snapshotMetrics: true })
    const today = utcToday()
    const snaps = db.prepare('SELECT views, num_favorers FROM listing_metric_snapshots WHERE listing_id = 11').all()
    assert.equal(snaps.length, 1)
    assert.equal(snaps[0].views, 77)
    const row = db.prepare('SELECT views, ending_timestamp, image_count FROM listings WHERE listing_id = 11').get()
    assert.equal(row.views, 77)
    assert.equal(today.length, 10)
  })

  await test('operational listing cache writes do not silently create analytics snapshots', () => {
    const db = seedDb()
    upsertListing(db, 'shop-a', listing({ listing_id: 12, views: 99 }))
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM listings WHERE listing_id = 12').get().n, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM listing_metric_snapshots WHERE listing_id = 12').get().n, 0)
    const inserted = db.prepare('SELECT views, num_favorers FROM listings WHERE listing_id = 12').get()
    assert.equal(inserted.views, null)
    assert.equal(inserted.num_favorers, null)

    upsertListing(db, 'shop-a', listing({ listing_id: 13, views: 50, num_favorers: 5 }), { analyticsMetrics: true })
    upsertListing(db, 'shop-a', listing({ listing_id: 13, views: 999, num_favorers: 99, quantity: 8 }))
    const preserved = db.prepare('SELECT views, num_favorers, quantity FROM listings WHERE listing_id = 13').get()
    assert.equal(preserved.views, 50)
    assert.equal(preserved.num_favorers, 5)
    assert.equal(preserved.quantity, 8)
  })

  await test('updateShopHealth persists rating and vacation without wiping counts', () => {
    const db = seedDb()
    updateShopHealth(db, 'shop-a', {
      listing_active_count: 40,
      review_average: 4.91,
      review_count: 80,
      is_vacation: false,
      num_favorers: 120,
    })
    updateShopHealth(db, 'shop-a', { listing_active_count: 41 })
    const shop = db.prepare('SELECT * FROM shops WHERE shop_id = ?').get('shop-a')
    assert.equal(shop.listing_active_count, 41)
    assert.equal(shop.review_average, 4.91)
    assert.equal(shop.is_vacation, 0)
    const snap = db.prepare('SELECT * FROM shop_health_snapshots WHERE shop_id = ?').get('shop-a')
    assert.equal(snap.listing_active_count, 41)
    assert.equal(snap.review_count, 80)
  })

  await test('report diagnoses a declining shop from receipts and expired listings', () => {
    const db = seedDb()
    let id = 1
    for (let i = 0; i < 20; i++) {
      insertReceipt(db, { id: id++, shopId: 'shop-a', created: NOW_SEC - 3 * DAY, gmv: 120 })
    }
    for (let i = 0; i < 40; i++) {
      insertReceipt(db, { id: id++, shopId: 'shop-a', created: NOW_SEC - 10 * DAY, gmv: 120 })
    }
    for (let i = 0; i < 18; i++) {
      insertReceipt(db, { id: id++, shopId: 'shop-b', created: NOW_SEC - 3 * DAY, gmv: 90 })
    }
    for (let i = 0; i < 16; i++) {
      insertReceipt(db, { id: id++, shopId: 'shop-b', created: NOW_SEC - 10 * DAY, gmv: 90 })
    }
    upsertListing(db, 'shop-a', listing({ listing_id: 21, state: 'expired', views: 900, title: 'Expired hero case' }))
    upsertListing(db, 'shop-a', listing({ listing_id: 22, state: 'active', views: 10 }))
    updateShopHealth(db, 'shop-a', { review_average: 4.2, review_count: 30, listing_active_count: 1 })

    const report = buildGrowthReport(db, { windowDays: 7, nowMs: NOW })
    const alpha = report.shops.find((s) => s.shop_id === 'shop-a')
    assert.ok(alpha)
    assert.equal(alpha.orders_current, 20)
    assert.equal(alpha.orders_baseline, 40)
    assert.ok(alpha.orders_growth_pct < -15)
    assert.equal(alpha.expired_count, 1)
    assert.ok(alpha.findings.some((f) => f.code === 'expired_listings'))
    assert.ok(alpha.findings.some((f) => f.code === 'low_rating'))
    assert.ok(report.actions.some((a) => a.code === 'expired_listings' && a.shop_id === 'shop-a'))
    assert.equal(report.watchlist.expired.length, 1)
    assert.equal(report.watchlist.rights_review.length, 1)
    assert.equal(report.watchlist.rights_review_total, 1)
    assert.equal(report.watchlist.rights_review[0].rights_holder, 'Sanrio')
    assert.equal(alpha.primary_cause, 'third_party_rights_review')
    assert.equal(alpha.rights_review_count, 1)
    assert.ok(report.actions.some((action) => action.code === 'third_party_rights_review'))
    const hygiene = report.watchlist.weak_titles.find((row) => row.listing_id === 22)
    assert.ok(hygiene.issues.includes('unused_tag_slots'))
    assert.ok(hygiene.title_word_count > 0)
    assert.equal(report.coverage.snapshot_ready, false)
    assert.match(report.coverage.note, /zero Etsy API calls/i)
  })

  await test('view snapshots produce a per-shop view delta', () => {
    const db = seedDb()
    const today = utcToday(NOW)
    const weekAgo = new Date(NOW - 7 * 86400000).toISOString().slice(0, 10)
    snapshotListingMetrics(db, 'shop-a', listing({ listing_id: 31, views: 100 }), weekAgo)
    snapshotListingMetrics(db, 'shop-a', listing({ listing_id: 31, views: 100 }), today)
    snapshotListingMetrics(db, 'shop-a', listing({ listing_id: 32, views: 80 }), weekAgo)
    snapshotListingMetrics(db, 'shop-a', listing({ listing_id: 32, views: 80 }), today)
    insertReceipt(db, { id: 501, shopId: 'shop-a', created: NOW_SEC - 2 * DAY })
    insertReceipt(db, { id: 502, shopId: 'shop-a', created: NOW_SEC - 10 * DAY })
    insertReceipt(db, { id: 503, shopId: 'shop-a', created: NOW_SEC - 11 * DAY })
    insertReceipt(db, { id: 504, shopId: 'shop-a', created: NOW_SEC - 12 * DAY })
    const report = buildGrowthReport(db, { windowDays: 7, nowMs: NOW })
    const alpha = report.shops.find((s) => s.shop_id === 'shop-a')
    assert.equal(alpha.view_delta, 0)
    assert.equal(alpha.snapshot_ready, true)
    assert.equal(alpha.primary_cause, 'traffic_drop')
  })

  await test('reviews persist without buyer identity', () => {
    const db = seedDb()
    upsertEtsyReview(db, 'shop-a', {
      transaction_id: 9001,
      listing_id: 21,
      rating: 2,
      review: 'Late and wrong colour',
      buyer_user_id: 555,
      language: 'en',
      created_timestamp: NOW_SEC - 86400,
    })
    const row = db.prepare('SELECT * FROM etsy_reviews WHERE transaction_id = 9001').get()
    assert.equal(row.rating, 2)
    assert.equal(row.review, 'Late and wrong colour')
    assert.equal(row.shop_id, 'shop-a')
    assert.equal(Object.prototype.hasOwnProperty.call(row, 'buyer_user_id'), false)
    const report = buildGrowthReport(db, { windowDays: 7, nowMs: NOW })
    assert.equal(report.reviews.low_recent.length, 1)
    assert.equal(report.reviews.low_recent[0].rating, 2)
  })

  await test('shopNeedsCatalogHealth respects the interval', () => {
    const db = seedDb()
    assert.equal(shopNeedsCatalogHealth(db, 'shop-a', 24), true)
    markCatalogHealthSynced(db, 'shop-a', Math.floor(Date.now() / 1000))
    assert.equal(shopNeedsCatalogHealth(db, 'shop-a', 24), false)
  })

  await test('catalog sync itself rejects callers without written-approval confirmation', async () => {
    await assert.rejects(
      () => syncShopCatalogHealth({}),
      (err) => err && err.code === 'ETSY_API_ANALYTICS_NOT_APPROVED' && err.status === 409,
    )
  })

  await test('catalog health walk snapshots listings, counts, and reviews', async () => {
    const db = seedDb()
    const calls = []
    const shopClient = {
      defaults: { headers: { 'x-api-key': 'offline-growth:secret' }, __etsyPriority: 'normal' },
      get: async (url, options) => {
        calls.push({ url, params: options?.params })
        if (url === '/application/shops/123') {
          return { data: { listing_active_count: 1, review_average: 4.8, review_count: 12, is_vacation: false, num_favorers: 9 } }
        }
        if (url === '/application/shops/123/listings') {
          if (options.params.state === 'active') {
            return {
              data: {
                count: 1,
                results: [listing({ listing_id: 44, views: 12, images: [{ url_570xN: 'https://cdn.example/a.jpg' }] })],
              },
            }
          }
          return { data: { count: options.params.state === 'expired' ? 3 : 0, results: [] } }
        }
        if (url === '/application/shops/123/reviews') {
          return {
            data: {
              count: 1,
              results: [{ transaction_id: 77, rating: 5, review: 'Cute', created_timestamp: NOW_SEC }],
            },
          }
        }
        throw new Error(`unexpected ${url}`)
      },
    }
    const result = await syncShopCatalogHealth({
      db,
      shopClient,
      numericShopId: 123,
      shopId: 'shop-a',
      shopName: 'Alpha',
      analyticsApproved: true,
    })
    assert.equal(result.listings, 1)
    assert.equal(result.reviews, 1)
    assert.equal(result.complete, true)
    const listingRow = db.prepare('SELECT views, state FROM listings WHERE listing_id = 44').get()
    assert.equal(listingRow.views, 12)
    const expired = db.prepare('SELECT listing_expired_count FROM shop_health_snapshots WHERE shop_id = ?').get('shop-a')
    assert.equal(expired.listing_expired_count, 3)
    const review = db.prepare('SELECT rating FROM etsy_reviews WHERE transaction_id = 77').get()
    assert.equal(review.rating, 5)
    assert.ok(calls.some((c) => c.url.endsWith('/reviews')))
    assert.ok(calls.some((c) => c.url.endsWith('/listings') && c.params.state === 'expired' && c.params.limit === 1))
    const activeWalk = calls.find((c) => c.url.endsWith('/listings') && c.params.state === 'active')
    assert.equal(activeWalk.params.includes, 'Images')
    assert.equal(activeWalk.params.sort_on, undefined)
  })

  await test('an incomplete approved catalog walk is never marked fresh', async () => {
    const db = seedDb()
    let page = 0
    const shopClient = {
      defaults: { headers: { 'x-api-key': 'offline-incomplete:secret' }, __etsyPriority: 'normal' },
      get: async (url, options) => {
        if (url === '/application/shops/123') return { data: { listing_active_count: 2000 } }
        if (url === '/application/shops/123/listings' && options.params.state === 'active') {
          const base = ++page * 1000
          return {
            data: {
              count: 2000,
              results: Array.from({ length: 100 }, (_, i) => listing({ listing_id: base + i, views: i })),
            },
          }
        }
        if (url === '/application/shops/123/listings') return { data: { count: 0, results: [] } }
        if (url === '/application/shops/123/reviews') return { data: { count: 0, results: [] } }
        throw new Error(`unexpected ${url}`)
      },
    }
    const result = await syncShopCatalogHealth({
      db,
      shopClient,
      numericShopId: 123,
      shopId: 'shop-a',
      shopName: 'Alpha',
      analyticsApproved: true,
    })
    assert.equal(result.complete, false)
    assert.equal(page, 15)
    const row = db.prepare('SELECT catalog_health_synced_at FROM shops WHERE shop_id = ?').get('shop-a')
    assert.equal(row.catalog_health_synced_at, null)
  })

  global.setTimeout = realSetTimeout
  console.log(`\n${failures.length ? 'FAIL' : 'PASS'} — ${passed} passed, ${failures.length} failed`)
  process.exitCode = failures.length ? 1 : 0
})().catch((err) => {
  global.setTimeout = realSetTimeout
  console.error(err)
  process.exitCode = 1
})
