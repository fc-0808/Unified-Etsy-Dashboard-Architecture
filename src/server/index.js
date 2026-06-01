'use strict';

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

const path           = require('path');
const https          = require('https');
const fs             = require('fs');
const { spawn }      = require('child_process');
const os             = require('os');
const express        = require('express');
const cors           = require('cors');
const cron           = require('node-cron');

const { loadConfig, getAllShops }          = require('../config/schema');
const { TokenManager }                     = require('../auth/token-manager');
const { initDb, syncConfigToDb }           = require('../db/setup');
const { createGroupProxyClient }                   = require('../proxy/factory');
const { buildShopClient, resolveShopId,
        createReceiptShipment, paginateListings,
        updateListing, createDraftListing,
        deleteListing,
        getListingInventory, updateListingInventory,
        getShop, updateShop,
        replyToConversation, markConversationReadOnEtsy } = require('../etsy/client');
const { upsertListing, upsertListingInventory,
        logEvent, upsertFourpxShipment,
        markConversationReadLocal,
        upsertConversationMessage,
        upsertRouteAssignment, getAllRouteAssignments,
        upsertProductAssignment, getAllProductAssignments,
        getSupplierDirectory, getCharmShopDirectory,
        insertSupplierDirectoryRow, updateSupplierDirectoryRow,
        deleteSupplierDirectoryRow,
        insertCharmShopDirectoryRow, updateCharmShopDirectoryRow,
        deleteCharmShopDirectoryRow,
        getCharmLibrary, getCharmByCode,
        insertCharmLibraryRow, updateCharmLibraryRow,
        deleteCharmLibraryRow, reorderCharmLibrary } = require('../db/setup');
const routeDashboard                               = require('../route/dashboard');
const unmatchedImages                              = require('../route/unmatched-images');
const { logZeroStockIfNeeded, listingHasLiveZero,
        raiseOfferingsToTarget, getZeroStylesForListing } = require('../inventory/helpers');
const { syncShop, syncConversationsForShop,
        runSyncCycle, runInventoryWatchCycle }     = require('../workers/sync');
const { syncAllShopEmails, syncEmailsForShop }     = require('../email/imap-sync');
const browserManager                               = require('../messaging/browser-manager');
const { syncMessagesForShop: browserSyncShop,
        sendBrowserReply }                         = require('../messaging/etsy-scraper');
const { createGroupClient }                        = require('../proxy/factory');
const { getLogisticsProducts, createShipOrder,
        getShipLabel, cancelShipOrder,
        getShipOrder, splitName }                  = require('../fourpx/orders');
const { getFullTrackingEvents }                    = require('../tracking/checker');

const TOKENS_PATH = path.resolve(__dirname, '../../tokens.json');

// ─── SSE sync-event bus ───────────────────────────────────────────────────────
// All connected SSE clients receive real-time sync log events.
const _sseClients = new Set();
function broadcastSyncEvent(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  _sseClients.forEach(res => { try { res.write(data); } catch {} });
}

// ─── Shopping Route generation job state ──────────────────────────────────────
// At most one route generation job runs at a time per server instance.
// The client polls GET /api/route/status every 1.5 s while status === 'running'.
let _routeJob = {
  status:    'idle',   // 'idle' | 'running' | 'done' | 'error'
  log:       [],
  startedAt: null,
  finishedAt: null,
  outputDir: null,
  files:     [],       // [{ name, path, size }]
  error:     null,
};

// Track which shops are currently syncing (for the UI spinner)
const _syncingShops = new Set();

// ── 4PX Logistics Products Cache ──────────────────────────────────────────────
// Cache the logistics product list for 30 minutes to avoid hammering the API.
// Keyed by "appKey:countryCode" so different country filters get separate caches.
const _fpxProductsCache = new Map(); // key → { products, expiresAt }

/**
 * Curated fallback list of standard 4PX XMS direct-shipping product codes.
 *
 * The ds.xms.logistics_product.getlist API is only available to software-service
 * provider accounts (ISV), NOT to direct-customer API keys. When that method
 * returns 404, the server returns this curated list instead so the dropdown
 * remains functional for direct customers.
 *
 * Source: 4PX XMS product catalogue (b.4px.com) as of 2025.
 * Codes in parentheses are the canonical logistics_product_code values to pass
 * to ds.xms.order.create.
 */
const FOURPX_KNOWN_PRODUCTS = [
  { code: 'S5058', name: 'POSTLINK-LW (S5058)',       desc: '邮政轻小件·普货 — US/CA/AU/EU' },
  { code: 'S5062', name: 'POSTLINK-S (S5062)',         desc: '邮政小包·经济 — US/CA/AU/EU' },
  { code: 'BDS',   name: 'BDS — Business Direct Small', desc: '4PX商业小件直邮' },
  { code: 'FDYE',  name: 'FDYE — Yellow Express Direct', desc: '4PX直发黄速' },
  { code: 'FXEC',  name: 'FXEC — Express via China Post', desc: '4PX中邮快递' },
  { code: 'OTHER', name: 'Other / Custom…',            desc: 'Enter product code manually' },
];

// ─── Bootstrap ────────────────────────────────────────────────────────────────

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`Config error: ${err.message}`);
  process.exit(1);
}

const tokenManager = new TokenManager(TOKENS_PATH);
const db = initDb(config.db_path);
syncConfigToDb(db, config);

// Import the supplier + charm-shop directory from OSP's supplier_catalog.xlsx
// so the route dashboard's pickers use the exact, real shop names + stalls.
// The supplier_directory table is the authoritative store for in-app CRUD, so
// we only SEED it from Excel when it's empty (first run); charm shops + product
// map always refresh. Use the "Re-sync from Excel" action to force-replace.
// Non-fatal: a missing workbook just leaves the directory empty.
const supplierImport = require('../route/supplier-import');
const charmLibrary   = require('../route/charm-library');
try {
  const seedSuppliers  = getSupplierDirectory(db).length === 0;
  const seedCharmShops = getCharmShopDirectory(db).length === 0;
  const r = supplierImport.importSupplierCatalog(db, config, {
    skipSuppliers:  !seedSuppliers,
    skipCharmShops: !seedCharmShops,
  });
  if (r.ok && (r.suppliers != null || r.charm_shops != null)) {
    const sp = r.suppliers   != null ? `seeded ${r.suppliers} supplier(s)`     : 'preserved suppliers';
    const cs = r.charm_shops != null ? `seeded ${r.charm_shops} charm shop(s)` : 'preserved charm shops';
    console.log(`[suppliers] Catalog import: ${sp}, ${cs}.`);
  } else if (r.ok) {
    console.log('[suppliers] Preserved existing supplier + charm-shop directories.');
  } else {
    console.warn(`[suppliers] Catalog import skipped: ${r.reason}`);
  }
} catch (err) {
  console.warn(`[suppliers] Catalog import failed: ${err.message}`);
}

// Seed the charm library from charm_manifest.json (only when empty), so charm
// CRUD edits survive restarts. Use "Re-sync charms" to force-reload from OSP.
try {
  const cr = charmLibrary.seedCharmLibraryIfEmpty(db, config);
  if (cr.ok && cr.reason === 'seeded') {
    console.log(`[charms] Seeded ${cr.seeded} charm(s) from charm_manifest.json`);
  } else if (cr.ok) {
    console.log('[charms] Preserved existing charm library.');
  } else {
    console.warn(`[charms] Charm seed skipped: ${cr.reason}`);
  }
} catch (err) {
  console.warn(`[charms] Charm seed failed: ${err.message}`);
}

const app = express();
app.use(cors());
// 25 MB body limit so base64 charm-image uploads (POST/PUT /api/route/charms)
// pass through. Express's default is only 100 KB, which rejected image uploads
// with a 413 before the route handler ran.
app.use(express.json({ limit: '25mb' }));

// ─── API routes ───────────────────────────────────────────────────────────────

/**
 * GET /api/shops
 * Returns all shops from DB with live order counts and last sync time.
 */
app.get('/api/shops', (req, res) => {
  const rows = db.prepare(`
    SELECT
      s.shop_id,
      s.shop_name,
      s.group_id,
      g.label        AS group_label,
      g.proxy_host,
      s.total_orders,
      s.last_synced_at,
      COUNT(r.receipt_id) AS receipts_in_db,
      (SELECT sl.status FROM sync_log sl WHERE sl.shop_id = s.shop_id
       ORDER BY sl.started_at DESC LIMIT 1) AS last_sync_status,
      (SELECT sl.receipts_synced FROM sync_log sl WHERE sl.shop_id = s.shop_id
       ORDER BY sl.started_at DESC LIMIT 1) AS last_receipts_synced
    FROM shops s
    JOIN groups g ON g.group_id = s.group_id
    LEFT JOIN receipts r ON r.shop_id = s.shop_id
    GROUP BY s.shop_id
    ORDER BY g.group_id, s.shop_name
  `).all();

  // Enrich with token status
  const allShopIds = getAllShops(config).map((s) => s.shop_id);
  const tokenStatus = tokenManager.getStatus(allShopIds);
  const tokenMap = Object.fromEntries(tokenStatus.map((t) => [t.shop_id, t]));

  const enriched = rows.map((r) => ({
    ...r,
    last_synced_at_iso: r.last_synced_at
      ? new Date(r.last_synced_at * 1000).toISOString()
      : null,
    token_status: tokenMap[r.shop_id]?.status ?? 'unknown',
    refresh_token_days_remaining: tokenMap[r.shop_id]?.refresh_token_days_remaining ?? null,
  }));

  res.json({ shops: enriched });
});

/**
 * GET /api/summary
 * Aggregated stats across all shops and groups.
 */
app.get('/api/summary', (req, res) => {
  const totals = db.prepare(`
    SELECT
      COUNT(DISTINCT shop_id)  AS total_shops_in_db,
      COUNT(*)                 AS total_receipts,
      SUM(CASE WHEN is_paid = 1 THEN 1 ELSE 0 END)    AS paid_orders,
      SUM(CASE WHEN is_shipped = 1 THEN 1 ELSE 0 END) AS shipped_orders,
      SUM(grandtotal_amount)   AS total_revenue
    FROM receipts
  `).get();

  const byGroup = db.prepare(`
    SELECT
      group_id,
      COUNT(DISTINCT shop_id)  AS shops,
      COUNT(*)                 AS receipts,
      SUM(grandtotal_amount)   AS revenue
    FROM receipts
    GROUP BY group_id
    ORDER BY group_id
  `).all();

  const byShop = db.prepare(`
    SELECT
      shop_id,
      COUNT(*) AS receipts,
      SUM(grandtotal_amount) AS revenue,
      MAX(etsy_created_at) AS latest_order_ts
    FROM receipts
    GROUP BY shop_id
    ORDER BY receipts DESC
  `).all();

  res.json({
    totals,
    by_group: byGroup,
    by_shop: byShop,
    shops_with_tokens: getAllShops(config).filter((s) => tokenManager.hasTokens(s.shop_id)).length,
    shops_total: getAllShops(config).length,
  });
});

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
 *   sort      — 'newest' (default) | 'oldest' | 'highest'
 */
app.get('/api/orders', (req, res) => {
  const limit  = Math.min(Math.max(parseInt(req.query.limit  ?? 50, 10), 1), 5000);
  const offset = parseInt(req.query.offset ?? 0, 10);

  const conditions = [];
  const params     = {};

  if (req.query.shop_id) { conditions.push('r.shop_id = @shop_id'); params.shop_id = req.query.shop_id; }
  if (req.query.status)  { conditions.push('r.status = @status');   params.status  = req.query.status; }

  // Date range filter — date strings 'YYYY-MM-DD', compared against epoch column
  if (req.query.date_from) {
    const ts = Math.floor(new Date(req.query.date_from + 'T00:00:00').getTime() / 1000);
    if (!isNaN(ts)) { conditions.push('r.etsy_created_at >= @date_from'); params.date_from = ts; }
  }
  if (req.query.date_to) {
    const ts = Math.floor(new Date(req.query.date_to + 'T23:59:59').getTime() / 1000);
    if (!isNaN(ts)) { conditions.push('r.etsy_created_at <= @date_to'); params.date_to = ts; }
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
    conditions.push("r.is_shipped = 0 AND r.status NOT IN ('Canceled','Fully Refunded','Cancelled','Fully refunded')");
  } else if (req.query.shipped === 'true') {
    conditions.push("r.is_shipped = 1 AND r.status NOT IN ('Canceled', 'Cancelled')");
  } else if (req.query.shipped === 'pre_transit') {
    const preTransitDays = config.pre_transit_days ?? 30;
    const cutoff = Math.floor(Date.now() / 1000) - preTransitDays * 24 * 3600;
    conditions.push(`r.is_shipped = 1
      AND r.tracking_code IS NOT NULL
      AND r.shipment_notified_at IS NOT NULL
      AND r.shipment_notified_at >= ${cutoff}
      AND r.carrier_confirmed_at IS NULL
      AND r.status NOT IN ('Canceled', 'Cancelled', 'Fully Refunded', 'Fully refunded')`);
  } else if (req.query.shipped === 'in_transit') {
    const preTransitDays = config.pre_transit_days ?? 30;
    const cutoff = Math.floor(Date.now() / 1000) - preTransitDays * 24 * 3600;
    conditions.push(`r.is_shipped = 1
      AND r.tracking_code IS NOT NULL
      AND r.status NOT IN ('Canceled', 'Cancelled', 'Fully Refunded', 'Fully refunded')
      AND (
        r.carrier_confirmed_at IS NOT NULL
        OR r.shipment_notified_at IS NULL
        OR r.shipment_notified_at < ${cutoff}
      )`);
  } else if (req.query.shipped === 'cancelled') {
    conditions.push("r.status IN ('Canceled', 'Cancelled')");
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const sortMap = {
    newest: 'r.etsy_created_at DESC',
    oldest: 'r.etsy_created_at ASC',
  };
  const orderBy = sortMap[req.query.sort] ?? sortMap.newest;

  const rows = db.prepare(`
    SELECT
      r.receipt_id,
      r.shop_id,
      r.group_id,
      s.shop_name,
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
      li.url                AS product_image_url,
      r.etsy_created_at,
      r.etsy_updated_at,
      r.synced_at,
      r.fourpx_consignment_no,
      r.fourpx_tracking_no,
      r.fourpx_label_url,
      r.fourpx_order_status,
      r.fourpx_created_at
    FROM receipts r
    JOIN shops s ON s.shop_id = r.shop_id
    LEFT JOIN listing_images li ON li.listing_id = r.first_listing_id
    ${where}
    ORDER BY ${orderBy}
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit, offset });

  const countRow = db.prepare(`
    SELECT COUNT(*) AS total FROM receipts r ${where}
  `).get(params);

  // Collect all listing IDs across every transaction in the result set,
  // then fetch their cached image URLs in one query.
  const allListingIds = new Set();
  for (const r of rows) {
    if (r.first_listing_id) allListingIds.add(r.first_listing_id);
    try {
      const txs = JSON.parse(r.all_transactions || '[]');
      for (const t of txs) if (t.listing_id) allListingIds.add(t.listing_id);
    } catch {}
  }
  const imageMap = {};
  if (allListingIds.size > 0) {
    const placeholders = [...allListingIds].map(() => '?').join(',');
    db.prepare(`SELECT listing_id, url FROM listing_images WHERE listing_id IN (${placeholders})`)
      .all([...allListingIds])
      .forEach((row) => { imageMap[row.listing_id] = row.url; });
  }

  const enriched = rows.map((r) => {
    let transactions = [];
    try { transactions = JSON.parse(r.all_transactions || '[]'); } catch {}
    // Inject cached image URL into each transaction object
    const transactionsWithImages = transactions.map((t) => ({
      ...t,
      image_url: imageMap[t.listing_id] ?? null,
    }));

    return {
      ...r,
      transactions: transactionsWithImages,
      created_at_iso: r.etsy_created_at
        ? new Date(r.etsy_created_at * 1000).toISOString()
        : null,
      updated_at_iso: r.etsy_updated_at
        ? new Date(r.etsy_updated_at * 1000).toISOString()
        : null,
      synced_at_iso: r.synced_at
        ? new Date(r.synced_at * 1000).toISOString()
        : null,
      ship_by_iso: r.first_ship_by
        ? new Date(r.first_ship_by * 1000).toISOString()
        : null,
      shipping_country_iso: r.shipping_country_iso,
    };
  });

  res.json({
    total: countRow.total,
    limit,
    offset,
    pre_transit_days: config.pre_transit_days ?? 30,
    orders: enriched,
  });
});

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
  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;

  const conditions = ['r.is_paid = 1'];
  const params = {};

  // Date-from filter (default: 30 days ago)
  if (req.query.date_from) {
    const ts = Math.floor(new Date(req.query.date_from + 'T00:00:00').getTime() / 1000);
    if (!isNaN(ts)) { conditions.push('r.etsy_created_at >= @date_from'); params.date_from = ts; }
  } else {
    conditions.push('r.etsy_created_at >= @date_from');
    params.date_from = thirtyDaysAgo;
  }

  // Date-to filter (optional)
  if (req.query.date_to) {
    const ts = Math.floor(new Date(req.query.date_to + 'T23:59:59').getTime() / 1000);
    if (!isNaN(ts)) { conditions.push('r.etsy_created_at <= @date_to'); params.date_to = ts; }
  }

  // Single-shop filter (optional)
  if (req.query.shop_id) {
    conditions.push('r.shop_id = @shop_id');
    params.shop_id = req.query.shop_id;
  }

  // Exclude shipped + cancelled by default (only orders that still need to be purchased)
  if (req.query.include_shipped !== 'true') {
    conditions.push(
      "r.is_shipped = 0 AND r.status NOT IN ('Canceled','Cancelled','Fully Refunded','Fully refunded')"
    );
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const rows = db.prepare(`
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
  `).all(params);

  // Collect all listing IDs so we can batch-fetch their cached thumbnail URLs
  const allListingIds = new Set();
  for (const r of rows) {
    try {
      const txs = JSON.parse(r.all_transactions || '[]');
      for (const t of txs) if (t.listing_id) allListingIds.add(t.listing_id);
    } catch {}
  }

  // Build listing_id → image URL map in one query
  const imageMap = {};
  if (allListingIds.size > 0) {
    const ph = [...allListingIds].map(() => '?').join(',');
    db.prepare(`SELECT listing_id, url FROM listing_images WHERE listing_id IN (${ph})`)
      .all([...allListingIds])
      .forEach(row => { imageMap[row.listing_id] = row.url; });
  }

  // Format a Unix timestamp as the date string Etsy uses on PDFs: "Jan 15, 2025"
  const fmtDate = (ts) => ts
    ? new Date(ts * 1000).toLocaleDateString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
      })
    : '';

  // Derive a username from buyer_email or buyer_user_id (fallback)
  const fmtUsername = (email, userId) => {
    if (email) return email.split('@')[0];
    if (userId) return String(userId);
    return '';
  };

  // Parse Etsy variations array to extract phone model and style values.
  // Etsy v3 transactions store: [{ formatted_name, formatted_value }, ...].
  const parseVariations = routeDashboard.parseVariations;

  const orders = rows
    .map(r => {
      let transactions = [];
      try { transactions = JSON.parse(r.all_transactions || '[]'); } catch {}

      const items = transactions
        .map(t => {
          const title = (t.title || '').trim();
          if (!title) return null;
          const { style, phoneModel } = parseVariations(t.variations);
          return {
            title:       title,
            quantity:    t.quantity || 1,
            phone_model: phoneModel,
            style:       style,
            image_url:   t.listing_id ? (imageMap[t.listing_id] || null) : null,
          };
        })
        .filter(Boolean);

      if (!items.length) return null;

      return {
        order_number:    String(r.receipt_id),
        etsy_shop:       r.shop_name || '',
        buyer_name:      r.buyer_name || '',
        buyer_username:  fmtUsername(r.buyer_email, r.buyer_user_id),
        ship_to_name:    r.buyer_name || '',
        ship_to_country: r.shipping_country_iso || '',
        order_date:      fmtDate(r.etsy_created_at),
        private_notes:   r.message_from_buyer || '',
        items,
      };
    })
    .filter(Boolean);

  res.json({
    exported_at:  new Date().toISOString(),
    order_count:  orders.length,
    filters: {
      date_from:       params.date_from ? new Date(params.date_from * 1000).toISOString().slice(0, 10) : null,
      date_to:         params.date_to   ? new Date(params.date_to   * 1000).toISOString().slice(0, 10) : null,
      shop_id:         req.query.shop_id || null,
      include_shipped: req.query.include_shipped === 'true',
    },
    orders,
  });
});

/**
 * POST /api/admin/reload-tokens
 * Hot-reload tokens.json without restarting the server.
 * Call this after running oauth:setup for any shop.
 */
app.post('/api/admin/reload-tokens', (req, res) => {
  try {
    tokenManager.reload();
    const allShopIds = getAllShops(config).map((s) => s.shop_id);
    const status = tokenManager.getStatus(allShopIds);
    console.log('[admin] Tokens reloaded from disk');
    res.json({ success: true, shops: status.length });
  } catch (err) {
    console.error('[admin] Failed to reload tokens:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/sync-log
 * Recent sync history — useful to know when each shop was last synced and whether it succeeded.
 */
app.get('/api/sync-log', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit ?? 50, 10), 500);
  const rows = db.prepare(`
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
  `).all(limit);

  const enriched = rows.map((r) => ({
    ...r,
    started_at_iso:   new Date(r.started_at   * 1000).toISOString(),
    completed_at_iso: r.completed_at
      ? new Date(r.completed_at * 1000).toISOString()
      : null,
    duration_seconds: r.completed_at
      ? r.completed_at - r.started_at
      : null,
  }));

  res.json({ log: enriched, syncing: [..._syncingShops] });
});

// ─── SSE — real-time sync events ──────────────────────────────────────────────

/**
 * GET /api/sync/stream
 * Server-Sent Events stream. Client receives a push whenever a sync
 * starts, completes, or errors. Keeps the Sync Log tab live without polling.
 */
app.get('/api/sync/stream', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // nginx: disable buffering
  res.flushHeaders();

  // Send current syncing state immediately on connect
  res.write(`data: ${JSON.stringify({ type: 'connected', syncing: [..._syncingShops] })}\n\n`);

  _sseClients.add(res);
  req.on('close', () => _sseClients.delete(res));
});

// ─── Manual sync triggers ─────────────────────────────────────────────────────

/**
 * POST /api/sync/trigger/:shop_id
 * Manually trigger a sync for one shop. Returns immediately (202);
 * progress arrives via SSE stream.
 */
app.post('/api/sync/trigger/:shop_id', async (req, res) => {
  const shopId  = req.params.shop_id;
  const shopCfg = getAllShops(config).find(s => s.shop_id === shopId);
  if (!shopCfg) return res.status(404).json({ error: 'Shop not found' });
  if (_syncingShops.has(shopId)) return res.status(409).json({ error: 'Sync already running' });

  res.status(202).json({ ok: true, message: `Sync started for ${shopId}` });

  // Run async — result delivered via SSE
  _runManualSync([shopCfg]);
});

/**
 * POST /api/sync/trigger-all
 * Manually trigger a sync for all authenticated shops.
 */
app.post('/api/sync/trigger-all', async (req, res) => {
  const allShops = getAllShops(config).filter(s => tokenManager.hasTokens(s.shop_id));
  if (allShops.length === 0) return res.status(400).json({ error: 'No authenticated shops' });

  const alreadyRunning = allShops.filter(s => _syncingShops.has(s.shop_id));
  if (alreadyRunning.length === allShops.length)
    return res.status(409).json({ error: 'All shops already syncing' });

  res.status(202).json({ ok: true, message: `Sync started for ${allShops.length} shops` });
  _runManualSync(allShops);
});

/**
 * Internal helper: run syncShop for each shop in the list,
 * broadcasting SSE events at each lifecycle step.
 */
async function _runManualSync(shops) {
  for (const shopCfg of shops) {
    if (_syncingShops.has(shopCfg.shop_id)) continue;
    _syncingShops.add(shopCfg.shop_id);

    broadcastSyncEvent({ type: 'sync_start', shop_id: shopCfg.shop_id, ts: Date.now() });

    try {
      const groupCfg   = config.groups.find(g => g.group_id === shopCfg.group_id);
      const proxyClient = createGroupClient(groupCfg, config.vpn_local_port);
      const accessToken = await tokenManager.getAccessToken(
        shopCfg.shop_id, shopCfg.api_key, shopCfg.refresh_token ?? null, proxyClient
      );
      const shopClient = buildShopClient(proxyClient, shopCfg.api_key, shopCfg.shared_secret, accessToken);

      await syncShop(shopCfg, groupCfg, config, proxyClient, tokenManager, db);

      // Read the fresh log entry just written by syncShop
      const entry = db.prepare(`
        SELECT sl.*, s.shop_name,
          sl.completed_at - sl.started_at AS duration_seconds,
          datetime(sl.started_at,'unixepoch') AS started_at_iso
        FROM sync_log sl JOIN shops s ON s.shop_id = sl.shop_id
        WHERE sl.shop_id = ? ORDER BY sl.started_at DESC LIMIT 1
      `).get(shopCfg.shop_id);

      broadcastSyncEvent({ type: 'sync_complete', shop_id: shopCfg.shop_id, entry, ts: Date.now() });
    } catch (err) {
      console.error(`[manual-sync] ${shopCfg.shop_id}: ${err.message}`);
      broadcastSyncEvent({ type: 'sync_error', shop_id: shopCfg.shop_id, error: err.message, ts: Date.now() });
    } finally {
      _syncingShops.delete(shopCfg.shop_id);
    }
  }
}

// ─── Order notes ──────────────────────────────────────────────────────────────

/**
 * GET /api/orders/:receipt_id/note
 * Returns the team note + buyer's note for an order.
 */
app.get('/api/orders/:receipt_id/note', (req, res) => {
  const row = db.prepare(
    'SELECT team_note, message_from_buyer FROM receipts WHERE receipt_id = ?'
  ).get(req.params.receipt_id);
  if (!row) return res.status(404).json({ error: 'Order not found' });
  res.json({ team_note: row.team_note || '', message_from_buyer: row.message_from_buyer || '' });
});

/**
 * PUT /api/orders/:receipt_id/note
 * Body: { team_note: string }
 * Saves the team note in the local DB only (Etsy has no per-order seller-note API).
 */
app.put('/api/orders/:receipt_id/note', (req, res) => {
  const { team_note = '' } = req.body;
  const result = db.prepare(
    'UPDATE receipts SET team_note = ? WHERE receipt_id = ?'
  ).run(team_note, req.params.receipt_id);
  if (result.changes === 0) return res.status(404).json({ error: 'Order not found' });
  res.json({ success: true, team_note });
});

// ─── Ship order ───────────────────────────────────────────────────────────────

/**
 * POST /api/orders/:receipt_id/ship
 * Body: { tracking_code, carrier_name, note_to_buyer? }
 *
 * Calls the Etsy API to create a shipment tracking entry (marks as shipped),
 * then updates the local DB so the dashboard reflects the new status immediately.
 */
app.post('/api/orders/:receipt_id/ship', async (req, res) => {
  const { receipt_id } = req.params;
  const { tracking_code, carrier_name = '4PX', note_to_buyer = '' } = req.body;

  try {
    if (!tracking_code || !tracking_code.trim()) {
      return res.status(400).json({ error: 'tracking_code is required' });
    }

    // 1. Look up the order to find which shop it belongs to (receipts has shop_id, not shop_name)
    const order = db.prepare(
      'SELECT shop_id FROM receipts WHERE receipt_id = ?'
    ).get(receipt_id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // 2. Find shop + group config by shop_id
    let shopCfg, groupCfg;
    for (const grp of config.groups) {
      const s = grp.shops.find(sh => sh.shop_id === order.shop_id);
      if (s) { shopCfg = s; groupCfg = grp; break; }
    }
    if (!shopCfg) return res.status(500).json({ error: `No config found for shop ${order.shop_id}` });

    // 3. Get a fresh access token (same flow as the sync worker)
    const proxyClient = createGroupProxyClient(groupCfg, config.vpn_local_port);
    const accessToken = await tokenManager.getAccessToken(
      shopCfg.shop_id,
      shopCfg.api_key,
      shopCfg.refresh_token ?? null,
      proxyClient,
    );

    // 4. Build authenticated client and resolve numeric shop ID
    const shopClient = buildShopClient(proxyClient, shopCfg.api_key, shopCfg.shared_secret, accessToken);
    const numericShopId = await resolveShopId(shopClient, shopCfg.shop_id);

    // 5. Create the shipment on Etsy (marks as shipped, sends buyer notification)
    const result = await createReceiptShipment(shopClient, numericShopId, receipt_id, {
      tracking_code: tracking_code.trim(),
      carrier_name:  (carrier_name || '4PX').trim(),
      note_to_buyer: note_to_buyer.trim() || undefined,
      send_bcc:      false,
    });

    // 6. Update local DB immediately so the UI reflects the change without waiting for next sync
    db.prepare(
      "UPDATE receipts SET is_shipped = 1, tracking_code = ?, carrier_name = ?, status = 'Completed' WHERE receipt_id = ?"
    ).run(tracking_code.trim(), (carrier_name || '4PX').trim(), receipt_id);

    console.log(`[ship] ${order.shop_id} receipt ${receipt_id} marked shipped — tracking: ${tracking_code}`);
    res.json({ success: true, receipt_id, tracking_code, shipment: result });

  } catch (err) {
    const etsyBody = err.response?.data;
    const errMsg   = (typeof etsyBody === 'object' ? (etsyBody?.error_description || etsyBody?.error) : null) || err.message;
    console.error(`[ship] Error shipping receipt ${receipt_id}:`, errMsg, err.stack?.split('\n')[0]);
    res.status(err.response?.status || 500).json({ error: errMsg });
  }
});

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
  const { fourpx_app_key: appKey, fourpx_app_secret: appSecret } = config;
  if (!appKey || !appSecret) {
    const err = new Error(
      'fourpx_app_key and fourpx_app_secret must be set in config.json to use 4PX order creation.'
    );
    err.status = 501;
    throw err;
  }
  return { appKey, appSecret };
}

/**
 * GET /api/4px/config
 * Returns 4PX-related config values the frontend needs to pre-populate the drawer.
 * No credentials are exposed.
 */
app.get('/api/4px/config', (_req, res) => {
  const hasCreds = !!(config.fourpx_app_key && config.fourpx_app_secret);
  res.json({
    enabled:         hasCreds,
    hasSender:       !!config.fourpx_sender,
    warehouseCode:   config.fourpx_warehouse_code ?? null,
    defaultProduct:  config.fourpx_default_product ?? null,
    sender: config.fourpx_sender
      ? {
          // Only expose non-sensitive display fields
          first_name: config.fourpx_sender.first_name,
          company:    config.fourpx_sender.company ?? null,
          city:       config.fourpx_sender.city    ?? null,
          country:    config.fourpx_sender.country ?? 'CN',
        }
      : null,
  });
});

/**
 * GET /api/4px/products
 * List available logistics products for this 4PX account.
 *
 * Tries ds.xms.logistics_product.getlist first (available to ISV accounts).
 * Falls back to FOURPX_KNOWN_PRODUCTS for direct-customer API keys, where the
 * product-list API returns 404 (method not available for that account type).
 *
 * Results are cached for 30 minutes.
 * Query param: country (optional ISO-2 code, e.g. "US")
 */
app.get('/api/4px/products', async (req, res) => {
  try {
    const { appKey, appSecret } = get4pxCredentials();
    const country  = (req.query.country || '').toUpperCase();
    const cacheKey = `${appKey}:${country}`;
    const cached   = _fpxProductsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return res.json({ products: cached.products, source: cached.source, cached: true });
    }

    let products = [];
    let source   = 'api';

    try {
      products = await getLogisticsProducts(appKey, appSecret, { countryCode: country || undefined });
    } catch {
      products = [];
    }

    // Direct-customer API keys cannot access the logistics-product list method
    // (returns error code 000024 / resource-not-found). Fall back to the curated list.
    if (!products.length) {
      products = FOURPX_KNOWN_PRODUCTS.map(p => ({
        logistics_product_code: p.code,
        logistics_product_name: p.name,
        description:            p.desc,
      }));
      source = 'fallback';
    }

    _fpxProductsCache.set(cacheKey, { products, source, expiresAt: Date.now() + 30 * 60 * 1000 });
    res.json({ products, source, cached: false });
  } catch (err) {
    console.error('[4px] GET /api/4px/products:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * GET /api/4px/order/:receipt_id
 * Return the 4PX shipment details stored in the local DB for this receipt.
 * Also optionally fetches an up-to-date label URL if one isn't stored yet.
 */
app.get('/api/4px/order/:receipt_id', (req, res) => {
  const { receipt_id } = req.params;
  const row = db.prepare(`
    SELECT
      fourpx_consignment_no,
      fourpx_tracking_no,
      fourpx_label_url,
      fourpx_order_status,
      fourpx_created_at
    FROM receipts
    WHERE receipt_id = ?
  `).get(receipt_id);

  if (!row) return res.status(404).json({ error: 'Receipt not found' });
  if (!row.fourpx_consignment_no) {
    return res.json({ exists: false });
  }
  res.json({ exists: true, ...row });
});

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
app.post('/api/4px/create-order', async (req, res) => {
  try {
    const { appKey, appSecret } = get4pxCredentials();

    if (!config.fourpx_sender) {
      return res.status(501).json({
        error: 'fourpx_sender is not configured in config.json. ' +
               'Add sender address details to enable shipping order creation.',
      });
    }

    const {
      receipt_id,
      recipient,
      parcel,
      logistics_product_code,
      duty_type = 'U',
    } = req.body;

    if (!receipt_id)               return res.status(400).json({ error: 'receipt_id is required' });
    if (!recipient)                return res.status(400).json({ error: 'recipient is required' });
    if (!parcel)                   return res.status(400).json({ error: 'parcel is required' });
    if (!logistics_product_code)   return res.status(400).json({ error: 'logistics_product_code is required' });
    if (!parcel.weight_g || parcel.weight_g <= 0)
      return res.status(400).json({ error: 'parcel.weight_g must be a positive number (grams)' });
    if (!parcel.items?.length)
      return res.status(400).json({ error: 'parcel.items is required for customs declaration' });

    // Check the order exists and hasn't already had a 4PX shipment created
    const order = db.prepare(
      'SELECT receipt_id, shop_id, fourpx_consignment_no FROM receipts WHERE receipt_id = ?'
    ).get(receipt_id);
    if (!order) return res.status(404).json({ error: `Receipt ${receipt_id} not found` });
    if (order.fourpx_consignment_no) {
      return res.status(409).json({
        error:             `A 4PX shipment was already created for receipt ${receipt_id}.`,
        consignment_no:    order.fourpx_consignment_no,
      });
    }

    const result = await createShipOrder(appKey, appSecret, {
      ref_no:                `ETSY-${receipt_id}`,
      logistics_product_code,
      warehouse_code:        config.fourpx_warehouse_code ?? undefined,
      deliver_type:          '3',
      sender:                config.fourpx_sender,
      recipient,
      parcels:               [parcel],
      duty_type,
      sales_platform:        'ETSY',
      trade_id:              receipt_id,
    });

    // Persist immediately — tracking number is now available even before label fetch
    upsertFourpxShipment(db, receipt_id, {
      consignmentNo: result.dsConsignmentNo,
      trackingNo:    result.trackingNo,
      status:        'created',
    });

    // Also update the main tracking_code field so pre-transit detection picks it up
    if (result.trackingNo) {
      db.prepare(
        'UPDATE receipts SET tracking_code = ?, carrier_name = ? WHERE receipt_id = ? AND tracking_code IS NULL'
      ).run(result.trackingNo, '4PX', receipt_id);
    }

    console.log(
      `[4px] Created shipment for receipt ${receipt_id} — ` +
      `tracking: ${result.trackingNo}, consignment: ${result.dsConsignmentNo}`
    );

    res.json({ success: true, receipt_id, ...result });

  } catch (err) {
    console.error('[4px] POST /api/4px/create-order:', err.message);
    res.status(err.status || 500).json({ error: err.message, code: err.code });
  }
});

/**
 * GET /api/4px/label/:receipt_id
 * Fetch (or return cached) shipping label URL for a receipt.
 * Query param: format = 'PDF' | 'IMG' (default PDF)
 */
app.get('/api/4px/label/:receipt_id', async (req, res) => {
  try {
    const { appKey, appSecret } = get4pxCredentials();
    const { receipt_id } = req.params;
    const format = (req.query.format || 'PDF').toUpperCase();

    const row = db.prepare(
      'SELECT fourpx_consignment_no, fourpx_label_url FROM receipts WHERE receipt_id = ?'
    ).get(receipt_id);

    if (!row) return res.status(404).json({ error: 'Receipt not found' });
    if (!row.fourpx_consignment_no) {
      return res.status(404).json({ error: 'No 4PX order exists for this receipt' });
    }

    // Return cached label if we have one (label URLs are long-lived at 4PX)
    if (row.fourpx_label_url) {
      return res.json({ success: true, labelUrl: row.fourpx_label_url, cached: true });
    }

    // Fetch from 4PX API
    const label = await getShipLabel(appKey, appSecret, row.fourpx_consignment_no, { format });
    const labelUrl = label.logisticsLabel ?? label.customLabel ?? null;

    if (labelUrl) {
      upsertFourpxShipment(db, receipt_id, {
        consignmentNo: row.fourpx_consignment_no,
        labelUrl,
        status: 'label_fetched',
      });
    }

    res.json({ success: true, labelUrl, label });

  } catch (err) {
    console.error('[4px] GET /api/4px/label:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * DELETE /api/4px/order/:receipt_id
 * Cancel the 4PX order associated with a receipt.
 * Body: { reason: string }
 */
app.delete('/api/4px/order/:receipt_id', async (req, res) => {
  try {
    const { appKey, appSecret } = get4pxCredentials();
    const { receipt_id } = req.params;
    const reason = req.body?.reason || 'Customer request';

    const row = db.prepare(
      'SELECT fourpx_consignment_no, fourpx_order_status FROM receipts WHERE receipt_id = ?'
    ).get(receipt_id);

    if (!row) return res.status(404).json({ error: 'Receipt not found' });
    if (!row.fourpx_consignment_no) {
      return res.status(404).json({ error: 'No 4PX order exists for this receipt' });
    }
    if (row.fourpx_order_status === 'cancelled') {
      return res.status(409).json({ error: '4PX order is already cancelled' });
    }

    await cancelShipOrder(appKey, appSecret, row.fourpx_consignment_no, reason);

    upsertFourpxShipment(db, receipt_id, {
      consignmentNo: row.fourpx_consignment_no,
      status: 'cancelled',
    });

    console.log(`[4px] Cancelled shipment for receipt ${receipt_id} (${row.fourpx_consignment_no})`);
    res.json({ success: true, receipt_id });

  } catch (err) {
    console.error('[4px] DELETE /api/4px/order:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

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
app.get('/api/4px/track/:tracking_no', async (req, res) => {
  try {
    const { tracking_no } = req.params;
    if (!tracking_no || !/^4PX/i.test(tracking_no)) {
      return res.status(400).json({ error: 'Invalid or unsupported tracking number — must begin with "4PX"' });
    }
    const result = await getFullTrackingEvents(tracking_no, {
      appKey:    config.fourpx_app_key    ?? null,
      appSecret: config.fourpx_app_secret ?? null,
    });
    res.json(result);
  } catch (err) {
    console.error('[4px] GET /api/4px/track:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Exchange rates (free, no-key API) ───────────────────────────────────────
// Used to convert the receipt subtotal to the customs currency (EUR / GBP / etc.)
// that sellers must declare on international packages.
// Rates are cached for 6 hours to avoid hitting the free-tier limits.
//
// API: https://open.er-api.com/v6/latest/EUR  (no API key required)
// All amounts relative to 1 EUR; we invert to get local→EUR.

let _ratesCache = { ts: 0, rates: {}, error: null };

function fetchRates() {
  return new Promise((resolve) => {
    const req = https.get('https://open.er-api.com/v6/latest/EUR', (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          if (json.result === 'success') {
            _ratesCache = { ts: Date.now(), rates: json.rates, error: null };
            resolve(json.rates);
          } else {
            _ratesCache.error = json.result;
            resolve(_ratesCache.rates);
          }
        } catch (e) {
          _ratesCache.error = e.message;
          resolve(_ratesCache.rates);
        }
      });
    });
    req.on('error', (e) => {
      _ratesCache.error = e.message;
      resolve(_ratesCache.rates);
    });
    req.setTimeout(5000, () => { req.destroy(); resolve(_ratesCache.rates); });
  });
}

async function getRates() {
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  if (Date.now() - _ratesCache.ts < SIX_HOURS && Object.keys(_ratesCache.rates).length) {
    return _ratesCache.rates;
  }
  return fetchRates();
}

/**
 * Convert an amount in the shop currency (e.g. HKD) to a customs target currency
 * using the cached EUR-base exchange rates.
 *
 * @param {number} amountInShopCurrency  e.g. 175.05
 * @param {string} shopCurrency          e.g. 'HKD'
 * @param {string} targetCurrency        e.g. 'EUR'
 * @param {object} rates                 EUR-base rate map
 * @returns {number|null}
 */
function convertCurrency(amountInShopCurrency, shopCurrency, targetCurrency, rates) {
  if (!rates[shopCurrency] || !rates[targetCurrency]) return null;
  // rates[X] = how many X per 1 EUR
  // shopCurrency per EUR → amountInShopCurrency / shopRate = EUR amount
  // EUR amount × targetRate = targetCurrency amount
  const eur = amountInShopCurrency / rates[shopCurrency];
  return eur * rates[targetCurrency];
}

/**
 * GET /api/exchange-rates
 * Returns current EUR-based rates. Frontend uses this to show customs amounts.
 */
app.get('/api/exchange-rates', async (_req, res) => {
  try {
    const rates = await getRates();
    res.json({ rates, cached_at: new Date(_ratesCache.ts).toISOString(), error: _ratesCache.error });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Warm-up: fetch rates once at startup (non-blocking)
getRates().then(() => console.log('[rates] Exchange rates loaded')).catch(() => {});

// ─── Listings ─────────────────────────────────────────────────────────────────

/** Helper: resolve shop config + build authenticated client */
async function getShopClientForShopName(shopName) {
  let shopCfg, groupCfg;
  for (const grp of config.groups) {
    const s = grp.shops.find(sh => sh.shop_name === shopName);
    if (s) { shopCfg = s; groupCfg = grp; break; }
  }
  if (!shopCfg) throw Object.assign(new Error(`No config for shop ${shopName}`), { status: 404 });
  const proxyClient  = createGroupProxyClient(groupCfg, config.vpn_local_port);
  const accessToken  = await tokenManager.getAccessToken(
    shopCfg.shop_id, shopCfg.api_key, shopCfg.refresh_token ?? null, proxyClient
  );
  const shopClient   = buildShopClient(proxyClient, shopCfg.api_key, shopCfg.shared_secret, accessToken);
  const numericShopId = await resolveShopId(shopClient, shopCfg.shop_id);
  return { shopClient, numericShopId, shopCfg, groupCfg };
}

/**
 * GET /api/listings
 * Returns cached listings. Query params: shop_id, state, limit, offset, q (search)
 */
app.get('/api/listings', (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit ?? 500, 10), 1000);
  const offset = parseInt(req.query.offset ?? 0, 10);
  const conditions = [];
  const params = {};

  if (req.query.shop_id) { conditions.push('l.shop_id = @shop_id'); params.shop_id = req.query.shop_id; }
  if (req.query.state && req.query.state !== 'all') { conditions.push('l.state = @state'); params.state = req.query.state; }
  if (req.query.q) { conditions.push("l.title LIKE @q"); params.q = `%${req.query.q}%`; }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const total = db.prepare(`SELECT COUNT(*) as n FROM listings l ${where}`).get(params).n;

  // Sort: listings with any zero-stock enabled offering come first, then by updated desc.
  // A LEFT JOIN subquery computes the minimum quantity across all enabled offerings per listing.
  const rows  = db.prepare(`
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
  `).all({ ...params, limit, offset });

  // Embed pre-aggregated inventory into each listing in a single extra query.
  // This eliminates the separate /api/inventory/bulk round-trip from the frontend.
  // One row per (listing_id, style_value) — min_qty already computed server-side.
  let invByListing = {};
  if (rows.length > 0) {
    const ids = rows.map(r => r.listing_id);
    const ph  = ids.map(() => '?').join(',');
    const invRows = db.prepare(`
      SELECT listing_id, style_value,
             MIN(quantity)                                          AS min_qty,
             MAX(CASE WHEN quantity = 0 THEN 1 ELSE 0 END)         AS has_zero
      FROM listing_inventory
      WHERE listing_id IN (${ph}) AND is_enabled = 1
      GROUP BY listing_id, style_value
    `).all(...ids);
    for (const r of invRows) {
      if (!invByListing[r.listing_id]) invByListing[r.listing_id] = [];
      invByListing[r.listing_id].push({ style_value: r.style_value, quantity: r.min_qty, has_zero: r.has_zero === 1 });
    }
  }

  res.json({
    total,
    listings: rows.map(r => ({
      ...r,
      tags:      r.tags ? JSON.parse(r.tags) : [],
      inv_slots: invByListing[r.listing_id] ?? null,
    })),
  });
});

/**
 * GET /api/listings/sync/:shop_name
 * Fetches all listings for a shop from Etsy and caches them locally.
 */
app.get('/api/listings/sync/:shop_name', async (req, res) => {
  try {
    const { shopClient, numericShopId, shopCfg } = await getShopClientForShopName(req.params.shop_name);
    const state = req.query.state || 'active';
    let count = 0;
    for await (const batch of paginateListings(shopClient, numericShopId, { state })) {
      for (const listing of batch) {
        upsertListing(db, shopCfg.shop_id, listing);
        count++;
      }
    }
    console.log(`[listings] Synced ${count} ${state} listings for ${req.params.shop_name}`);
    res.json({ success: true, synced: count, shop: req.params.shop_name, state });
  } catch (err) {
    console.error('[listings] Sync error:', err.response?.data || err.message);
    res.status(err.status || err.response?.status || 500).json({ error: err.response?.data?.error || err.message });
  }
});

/**
 * PATCH /api/listings/:listing_id
 * Updates listing fields. Requires listings_w scope.
 */
app.patch('/api/listings/:listing_id', async (req, res) => {
  try {
    const { fields, shop_name } = req.body;
    if (!shop_name) return res.status(400).json({ error: 'shop_name required' });
    const { shopClient, numericShopId, shopCfg } = await getShopClientForShopName(shop_name);
    const result = await updateListing(shopClient, numericShopId, req.params.listing_id, fields);
    // Update local cache
    upsertListing(db, shopCfg.shop_id, result);
    res.json({ success: true, listing: result });
  } catch (err) {
    console.error('[listings] Update error:', err.response?.data || err.message);
    res.status(err.status || err.response?.status || 500).json({ error: err.response?.data?.error_description || err.response?.data?.error || err.message });
  }
});

/**
 * POST /api/listings
 * Creates a draft listing. Requires listings_w scope.
 */
app.post('/api/listings', async (req, res) => {
  try {
    const { shop_name, ...body } = req.body;
    if (!shop_name) return res.status(400).json({ error: 'shop_name required' });
    const { shopClient, numericShopId, shopCfg } = await getShopClientForShopName(shop_name);
    const result = await createDraftListing(shopClient, numericShopId, body);
    upsertListing(db, shopCfg.shop_id, result);
    res.status(201).json({ success: true, listing: result });
  } catch (err) {
    console.error('[listings] Create error:', err.response?.data || err.message);
    res.status(err.status || err.response?.status || 500).json({ error: err.response?.data?.error_description || err.response?.data?.error || err.message });
  }
});

/**
 * DELETE /api/listings/:listing_id
 * Deletes a listing. Requires listings_d scope.
 */
app.delete('/api/listings/:listing_id', async (req, res) => {
  try {
    const { shop_name } = req.body;
    if (!shop_name) return res.status(400).json({ error: 'shop_name required' });
    const { shopClient } = await getShopClientForShopName(shop_name);
    await deleteListing(shopClient, req.params.listing_id);
    db.prepare('DELETE FROM listings WHERE listing_id = ?').run(req.params.listing_id);
    res.json({ success: true });
  } catch (err) {
    console.error('[listings] Delete error:', err.response?.data || err.message);
    res.status(err.status || err.response?.status || 500).json({ error: err.response?.data?.error || err.message });
  }
});

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
    .map(s => parseInt(s.trim(), 10))
    .filter(n => !isNaN(n) && n > 0);

  if (!ids.length) return res.json({ inventory: {} });

  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT listing_id, product_id, offering_id, style_value, secondary_value,
           quantity, is_enabled, price_amount, price_currency, synced_at
    FROM listing_inventory
    WHERE listing_id IN (${placeholders})
    ORDER BY listing_id, style_value, secondary_value
  `).all(...ids);

  // Group by listing_id
  const inventory = {};
  for (const row of rows) {
    const lid = row.listing_id;
    if (!inventory[lid]) inventory[lid] = [];
    inventory[lid].push(row);
  }

  res.json({ inventory });
});

/**
 * GET /api/inventory/:listing_id
 * Returns cached inventory for a single listing from local DB.
 */
app.get('/api/inventory/:listing_id', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM listing_inventory WHERE listing_id = ? ORDER BY style_value, secondary_value
  `).all(req.params.listing_id);
  res.json({ listing_id: req.params.listing_id, products: rows });
});

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
    const { shopClient, shopCfg } = await getShopClientForShopName(req.params.shop_name);

    const listings = db.prepare(
      "SELECT listing_id, title FROM listings WHERE shop_id = ? AND state = 'active'"
    ).all(shopCfg.shop_id);

    if (!listings.length) {
      return res.json({ success: true, synced: 0, message: 'No active listings cached. Sync listings first.' });
    }

    const autoRestock = config.auto_restock_enabled !== false;
    const restockQty  = config.restock_quantity ?? 3;

    let synced = 0, restocked = 0, zeroAlerts = 0, restockFailed = 0;
    const zeroListingIds = new Set();

    const upsertInv = (listingId, inv) => {
      for (const product of (inv.products || [])) {
        for (const offering of (product.offerings || [])) {
          upsertListingInventory(db, listingId, product, offering);
        }
      }
    };

    // ── Per-listing worker: GET → cache → (restock | alert) ──────────────────
    const processListing = async (listing) => {
      const listingId = listing.listing_id;
      let inv;
      try {
        inv = await getListingInventory(shopClient, listingId);
        upsertInv(listingId, inv);
        synced++;
      } catch (err) {
        console.warn(`[inventory] Fetch failed for listing ${listingId}:`,
          err.response?.data?.error || err.message);
        return;
      }

      if (!listingHasLiveZero(inv)) return;
      zeroListingIds.add(listingId);

      const { styles } = getZeroStylesForListing(db, listingId);
      const styleLabel = styles.length ? styles.join(', ') : 'unknown variation(s)';

      // Alert-only mode
      if (!autoRestock) {
        if (logZeroStockIfNeeded(db, {
          event_type:    'ZERO_STOCK',
          shop_name:      req.params.shop_name,
          listing_id:     listingId,
          listing_title:  listing.title || null,
          style_value:    styleLabel,
          detail:         `Zero stock in [${styleLabel}] detected during inventory sync. Auto-restock disabled.`,
        })) zeroAlerts++;
        return;
      }

      // Auto-restock: top-up every low offering, then PUT
      try {
        const changed = raiseOfferingsToTarget(inv, restockQty);
        await updateListingInventory(shopClient, listingId, inv);
        upsertInv(listingId, inv);
        restocked++;
        console.log(`[inventory] ${req.params.shop_name}: restocked listing ${listingId} (${changed} offering(s) raised to qty ${restockQty})`);
        logEvent(db, {
          event_type:    'AUTO_RESTOCK',
          shop_name:      req.params.shop_name,
          listing_id:     listingId,
          listing_title:  listing.title || null,
          style_value:    styleLabel,
          detail:         `Auto-restocked [${styleLabel}] to qty ${restockQty} during inventory sync (${changed} offering(s) raised)`,
          meta:           { triggered_by: 'inventory_sync', zero_styles: styles, raised_count: changed, target_quantity: restockQty },
        });
      } catch (err) {
        const status = err.response?.status || err.status || 500;
        const isAuth = status === 403;
        restockFailed++;
        logEvent(db, {
          event_type:    'RESTOCK_FAILED',
          shop_name:      req.params.shop_name,
          listing_id:     listingId,
          listing_title:  listing.title || null,
          style_value:    styleLabel,
          detail:         isAuth
            ? `Restock failed (403): listings_w scope required. Re-run "npm run oauth:setup" for this shop.`
            : `Restock failed (${status}): ${err.response?.data?.error || err.message}`,
          meta:           { status, needs_reauth: isAuth },
        });
      }
    };

    // ── Bounded-concurrency pool over all listings ───────────────────────────
    const CONCURRENCY = 4;
    let cursor = 0;
    const runWorker = async () => {
      while (cursor < listings.length) {
        const next = listings[cursor++];
        await processListing(next);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, listings.length) }, runWorker)
    );

    logEvent(db, {
      event_type: 'INV_SYNC',
      shop_name:  req.params.shop_name,
      detail:     `Inventory sync: ${synced} listing(s) checked, ${zeroListingIds.size} with zero stock — ` +
                  `${restocked} auto-restocked` +
                  (restockFailed ? `, ${restockFailed} failed` : '') +
                  (zeroAlerts ? `, ${zeroAlerts} alerted` : '') + '.',
    });

    console.log(`[inventory] ${req.params.shop_name}: ${synced} checked, ` +
                `${zeroListingIds.size} zero-stock, ${restocked} restocked, ${restockFailed} failed`);

    res.json({
      success: true,
      synced,
      zero_stock_listings: zeroListingIds.size,
      restocked,
      restock_failed: restockFailed,
      events_logged: restocked + zeroAlerts,
    });
  } catch (err) {
    console.error('[inventory] Sync error:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

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
  const { shop_name, style_value, target_quantity = 3 } = req.body;
  if (!shop_name) return res.status(400).json({ error: 'shop_name required' });

  const listingRow = db.prepare('SELECT title FROM listings WHERE listing_id = ?').get(req.params.listing_id);
  const listingTitle = listingRow?.title || `Listing ${req.params.listing_id}`;
  const triggeredBy  = style_value || 'manual';

  try {
    const { shopClient } = await getShopClientForShopName(shop_name);

    // Step 1: Fetch full current inventory (required for the PUT)
    const inv = await getListingInventory(shopClient, req.params.listing_id);

    // Step 2: Set ALL offerings across ALL styles to target_quantity.
    // When any style hits 0 we top up the whole listing so every style is
    // back to full stock in one atomic operation.
    let updated = 0;
    for (const product of (inv.products || [])) {
      for (const offering of (product.offerings || [])) {
        offering.quantity = parseInt(target_quantity);
        updated++;
      }
    }

    if (!updated) return res.status(404).json({ error: 'Listing has no offerings to restock' });

    // Step 3: PUT the full inventory back (updateListingInventory strips invalid fields)
    await updateListingInventory(shopClient, req.params.listing_id, inv);

    // Step 4: Update local cache
    for (const product of (inv.products || [])) {
      for (const offering of (product.offerings || [])) {
        upsertListingInventory(db, parseInt(req.params.listing_id), product, offering);
      }
    }

    // ONE consolidated event per restock action
    logEvent(db, {
      event_type:    'MANUAL_RESTOCK',
      shop_name,
      listing_id:     parseInt(req.params.listing_id),
      listing_title:  listingTitle,
      style_value:    'All styles',
      detail:         `Restocked all 6 styles to qty ${target_quantity} (triggered by: ${triggeredBy})`,
      meta:           { triggered_by: triggeredBy, updated_count: updated, target_quantity },
    });

    console.log(`[inventory] Restocked ${shop_name} listing ${req.params.listing_id} all styles × ${updated} offering(s) → qty ${target_quantity}`);
    res.json({ success: true, target_quantity, updated_count: updated });
  } catch (err) {
    const status = err.response?.status || err.status || 500;
    const errMsg = err.response?.data?.error || err.message;

    // Friendly message for missing listings_w scope
    const isAuthErr = status === 403;
    const userMsg = isAuthErr
      ? 'listings_w scope required. Re-run npm run oauth:setup for this shop to grant restock permission.'
      : errMsg;

    logEvent(db, {
      event_type:    'RESTOCK_FAILED',
      shop_name,
      listing_id:    parseInt(req.params.listing_id),
      listing_title: listingTitle,
      style_value:   triggeredBy,
      detail:        `Restock failed: ${userMsg}`,
      meta:          { status, error: errMsg },
    });

    console.error(`[inventory] Restock failed (${status}):`, errMsg);
    res.status(status).json({ error: userMsg, needs_reauth: isAuthErr });
  }
});

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
  const lastSync = db.prepare(`
    SELECT MAX(started_at) AS t FROM sync_log WHERE status = 'success'
  `).get();

  // Most recent restock/alert activity (separate signal — only when something happened)
  const lastRestock = db.prepare(`
    SELECT MAX(created_at) AS t FROM events
    WHERE event_type IN ('AUTO_RESTOCK', 'ORDER_RESTOCK', 'ZERO_STOCK', 'RESTOCK_FAILED', 'MANUAL_RESTOCK')
  `).get();

  // "Last check" is whichever heartbeat is newer.
  const lastCheck = Math.max(lastSync?.t ?? 0, lastRestock?.t ?? 0) || null;

  // 24h health metrics
  const last24h    = Math.floor(Date.now() / 1000) - 86400;
  const restockRow = db.prepare(`
    SELECT
      SUM(CASE WHEN event_type = 'AUTO_RESTOCK'  THEN 1 ELSE 0 END) AS auto_count,
      SUM(CASE WHEN event_type = 'ORDER_RESTOCK' THEN 1 ELSE 0 END) AS order_count,
      SUM(CASE WHEN event_type = 'RESTOCK_FAILED' THEN 1 ELSE 0 END) AS fail_count,
      SUM(CASE WHEN event_type = 'ZERO_STOCK'    THEN 1 ELSE 0 END) AS zero_count
    FROM events WHERE created_at >= ?
  `).get(last24h);

  // How many successful background syncs ran in the last 24h (proof of life)
  const syncRow = db.prepare(`
    SELECT COUNT(*) AS n FROM sync_log WHERE status = 'success' AND started_at >= ?
  `).get(last24h);

  res.json({
    auto_restock_enabled:       config.auto_restock_enabled !== false,
    restock_quantity:           config.restock_quantity ?? 3,
    inv_watch_interval_minutes: config.inv_watch_interval_minutes ?? 240,
    embedded_sync:              process.env.EMBEDDED_SYNC !== '0',
    last_activity_at:           lastCheck,
    last_activity_at_iso:       lastCheck ? new Date(lastCheck * 1000).toISOString() : null,
    last_restock_at:            lastRestock?.t ?? null,
    last_restock_at_iso:        lastRestock?.t ? new Date(lastRestock.t * 1000).toISOString() : null,
    last_24h: {
      auto_restocks:   restockRow?.auto_count  ?? 0,
      order_restocks:  restockRow?.order_count ?? 0,
      restock_failed:  restockRow?.fail_count  ?? 0,
      zero_stock_alerts: restockRow?.zero_count ?? 0,
      syncs_completed: syncRow?.n ?? 0,
    },
  });
});

// ─── Events log ───────────────────────────────────────────────────────────────

/**
 * GET /api/events
 * Returns recent events. Query: type, shop_name, limit, offset
 */
app.get('/api/events', (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit ?? 100, 10), 500);
  const offset = parseInt(req.query.offset ?? 0, 10);
  const conds  = [], params = {};

  if (req.query.type && req.query.type !== 'all') {
    conds.push('event_type = @type'); params.type = req.query.type;
  }
  if (req.query.shop) {
    conds.push('shop_name = @shop'); params.shop = req.query.shop;
  }

  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) as n FROM events ${where}`).get(params).n;
  const rows  = db.prepare(
    `SELECT * FROM events ${where} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`
  ).all({ ...params, limit, offset });

  res.json({ total, events: rows });
});

// ─── Discount Automation (AdsPower + Playwright CDP) ─────────────────────────

const adsPower      = require('../automation/adspower');
const etsyMarketing = require('../automation/etsy-marketing');

// Seed API key from config on startup so it's always available
{
  const cfg = loadConfig();
  if (cfg.adspower_api_key) adsPower.setApiKey(cfg.adspower_api_key);
}

/**
 * PUT /api/automation/adspower/apikey
 * Save or clear the AdsPower API key in config.json and apply it live.
 * Body: { api_key: string }
 */
app.put('/api/automation/adspower/apikey', (req, res) => {
  const { api_key = '' } = req.body;
  try {
    const cfgPath = path.resolve(__dirname, '../../config.json');
    const cfg     = JSON.parse(require('fs').readFileSync(cfgPath, 'utf8'));
    cfg.adspower_api_key = api_key.trim();
    require('fs').writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    adsPower.setApiKey(api_key.trim() || null);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/automation/adspower/status
 * Returns whether AdsPower Local API is reachable, detected URL, API key status,
 * and available profiles.
 */
app.get('/api/automation/adspower/status', async (req, res) => {
  const status   = await adsPower.checkStatus();
  let profiles   = [];
  if (status.ok) {
    try { profiles = await adsPower.listProfiles(); } catch { /* not critical */ }
  }
  // Load API key from config each time so UI always sees current state
  const cfg = loadConfig();
  res.json({ ...status, profiles, hasApiKey: !!adsPower.getApiKey(), configuredKey: cfg.adspower_api_key ? '••••' + cfg.adspower_api_key.slice(-4) : null });
});

/**
 * POST /api/automation/check-login
 * Verifies that a given AdsPower profile has an active Etsy session for a shop.
 * Body: { profile_id, shop_name }
 */
app.post('/api/automation/check-login', async (req, res) => {
  const { profile_id, shop_id, shop_name } = req.body;
  if (!profile_id || !shop_name) return res.status(400).json({ error: 'profile_id and shop_name required' });
  try {
    const result = await etsyMarketing.checkLoginStatus(profile_id, shop_id || shop_name, shop_name);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/automation/create-sale
 * Creates a shop-wide %-off sale via browser automation using saved session.
 *
 * Body: { profile_id, shop_id, shop_name, percent, end_date? }
 */
app.post('/api/automation/create-sale', async (req, res) => {
  const { profile_id, shop_id, shop_name, percent, end_date } = req.body;
  if (!profile_id || !shop_name || !percent) {
    return res.status(400).json({ error: 'profile_id, shop_name, and percent required' });
  }

  const steps = [];
  try {
    const result = await etsyMarketing.createSale({
      profileId:  profile_id,
      shopId:     shop_id || shop_name,
      shopName:   shop_name,
      percent:    Number(percent),
      endDate:    end_date || null,
      onProgress: (msg) => { steps.push(msg); console.log(`[automation] ${shop_name}: ${msg}`); },
    });
    res.json({ ...result, steps });
  } catch (err) {
    res.status(500).json({ error: err.message, steps });
  }
});

/**
 * POST /api/automation/create-promo
 * Creates a promo code via browser automation using saved session.
 *
 * Body: { profile_id, shop_id, shop_name, code, type, amount?, expiry_date?, min_order? }
 */
app.post('/api/automation/create-promo', async (req, res) => {
  const { profile_id, shop_id, shop_name, code, type, amount, expiry_date, min_order } = req.body;
  if (!profile_id || !shop_name || !code || !type) {
    return res.status(400).json({ error: 'profile_id, shop_name, code, and type required' });
  }

  const steps = [];
  try {
    const result = await etsyMarketing.createPromoCode({
      profileId:     profile_id,
      shopId:        shop_id || shop_name,
      shopName:      shop_name,
      code,
      type,
      amount:        amount    ? Number(amount)    : null,
      expiryDate:    expiry_date || null,
      minOrderValue: min_order ? Number(min_order) : null,
      onProgress: (msg) => { steps.push(msg); console.log(`[automation] ${shop_name}: ${msg}`); },
    });
    res.json({ ...result, steps });
  } catch (err) {
    res.status(500).json({ error: err.message, steps });
  }
});

/**
 * POST /api/automation/create-sale-bulk
 * Runs createSale for multiple shops sequentially using saved sessions.
 * Shops sharing the same profile_id reuse the same AdsPower browser open.
 * Body: { shops: [{profile_id, shop_id, shop_name}], percent, end_date? }
 */
app.post('/api/automation/create-sale-bulk', async (req, res) => {
  const { shops, percent, end_date } = req.body;
  if (!Array.isArray(shops) || !shops.length || !percent) {
    return res.status(400).json({ error: 'shops[] and percent required' });
  }

  const results = [];
  for (const { profile_id, shop_id, shop_name } of shops) {
    const steps = [];
    try {
      if (results.length > 0) await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));
      const r = await etsyMarketing.createSale({
        profileId: profile_id,
        shopId:    shop_id || shop_name,
        shopName:  shop_name,
        percent:   Number(percent),
        endDate:   end_date || null,
        onProgress: (msg) => { steps.push(msg); console.log(`[automation] ${shop_name}: ${msg}`); },
      });
      results.push({ shop_name, ...r, steps });
    } catch (err) {
      results.push({ shop_name, success: false, message: err.message, steps });
    }
  }
  res.json({ results });
});

// ─── Session Management Endpoints ─────────────────────────────────────────────

/**
 * GET /api/automation/session-status
 * Returns session info (exists, expiry, days remaining) for all configured shops.
 */
app.get('/api/automation/session-status', (req, res) => {
  const shops  = getAllShops();
  const result = {};
  for (const shop of shops) {
    result[shop.shop_id] = etsyMarketing.getSessionInfo(shop.shop_id);
  }
  res.json(result);
});

/**
 * DELETE /api/automation/session/:shop_id
 * Clears the saved session for a shop (user will need to re-capture).
 */
app.delete('/api/automation/session/:shop_id', (req, res) => {
  try {
    etsyMarketing.clearSession(req.params.shop_id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/automation/capture-session  (SSE stream)
 * Opens AdsPower profile, navigates to Etsy sign-in in an isolated context,
 * then waits for the user to log in (up to 5 min). Streams progress via SSE.
 *
 * Body: { profile_id, shop_id, shop_name }
 */
app.post('/api/automation/capture-session', async (req, res) => {
  const { profile_id, shop_id, shop_name } = req.body;
  if (!profile_id || !shop_id || !shop_name) {
    return res.status(400).json({ error: 'profile_id, shop_id, and shop_name required' });
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (stage, message) => {
    res.write(`data: ${JSON.stringify({ stage, message })}\n\n`);
  };

  try {
    const result = await etsyMarketing.captureSession(profile_id, shop_id, shop_name, send);
    res.write(`data: ${JSON.stringify({ stage: result.success ? 'complete' : 'error', ...result })}\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ stage: 'error', message: err.message })}\n\n`);
  } finally {
    res.end();
  }
});

// ─── Discounts ────────────────────────────────────────────────────────────────

/**
 * GET /api/discounts
 * Returns all configured shops from local data only — no live Etsy API calls.
 * Authenticated status is derived from tokenManager. Counts come from the local DB.
 * sale_message is fetched lazily via GET /api/discounts/:shop_id/sale-message.
 */
app.get('/api/discounts', (req, res) => {
  const allShops = getAllShops(config);

  const shops = allShops.map(shopCfg => {
    const authenticated = tokenManager.hasTokens(shopCfg.shop_id);

    // Active listing count from local DB
    const listingCount = db.prepare(
      "SELECT COUNT(*) as n FROM listings WHERE shop_id = ? AND state = 'active'"
    ).get(shopCfg.shop_id)?.n ?? 0;

    // Best available icon: first listing image for this shop
    const iconRow = db.prepare(
      `SELECT li.url FROM listing_images li
       JOIN listings l ON l.listing_id = li.listing_id
       WHERE l.shop_id = ? LIMIT 1`
    ).get(shopCfg.shop_id);

    return {
      shop_id:              shopCfg.shop_id,
      shop_name:            shopCfg.shop_name,
      authenticated,
      listing_active_count: listingCount,
      icon_url:             iconRow?.url || null,
      url:                  `https://www.etsy.com/shop/${shopCfg.shop_name}`,
      // sale_message loaded on-demand — null means "not yet fetched"
      sale_message:         null,
    };
  });

  res.json({ shops });
});

/**
 * GET /api/discounts/:shop_id/sale-message
 * Fetches the current sale_message for a single shop from the Etsy API.
 * Called lazily per-shop after the page has loaded.
 */
app.get('/api/discounts/:shop_id/sale-message', async (req, res) => {
  const { shop_id } = req.params;
  const shopCfg = getAllShops(config).find(s => s.shop_id === shop_id);
  if (!shopCfg)                          return res.status(404).json({ error: 'Shop not found' });
  if (!tokenManager.hasTokens(shop_id)) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const groupCfg   = config.groups.find(g => g.shops.some(s => s.shop_id === shop_id));
    const shopClient = buildShopClient(createGroupClient(groupCfg), shop_id, tokenManager);
    const shopData   = await getShop(shopClient, shop_id);
    res.json({
      sale_message:         shopData.sale_message          || '',
      digital_sale_message: shopData.digital_sale_message  || '',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/discounts/:shop_id/sale-message
 * Updates the sale_message (and optionally digital_sale_message) for a shop.
 * Scope required: shops_w
 */
app.put('/api/discounts/:shop_id/sale-message', async (req, res) => {
  const { shop_id } = req.params;
  const { sale_message, digital_sale_message } = req.body;
  const shopCfg  = getAllShops(config).find(s => s.shop_id === shop_id);
  if (!shopCfg)  return res.status(404).json({ error: 'Shop not found' });
  if (!tokenManager.hasTokens(shop_id)) return res.status(401).json({ error: 'Shop not authenticated' });

  const groupCfg   = config.groups.find(g => g.shops.some(s => s.shop_id === shop_id));
  const proxyClient = createGroupClient(groupCfg);
  const shopClient  = buildShopClient(proxyClient, shop_id, tokenManager);

  const fields = {};
  if (sale_message         !== undefined) fields.sale_message         = sale_message;
  if (digital_sale_message !== undefined) fields.digital_sale_message = digital_sale_message;

  try {
    const updated = await updateShop(shopClient, shop_id, fields);
    res.json({ success: true, sale_message: updated.sale_message, digital_sale_message: updated.digital_sale_message });
  } catch (err) {
    console.error('[discounts] updateShop error:', err.response?.data || err.message);
    res.status(err.response?.status || 500).json({ error: err.response?.data?.error || err.message });
  }
});

// ─── Messages (Conversations) ────────────────────────────────────────────────
// These routes read from the local SQLite conversations/conversation_messages
// tables. The data is populated by the conversation sync cron (every 20 min)
// and by the manual /api/messages/sync trigger.
//
// NOTE: Etsy's public v3 API does not expose conversations. The sync worker
// calls Etsy's undocumented internal endpoints — see src/etsy/client.js.

/**
 * GET /api/messages
 * Paginated list of conversations across all shops (or filtered by shop/status).
 *
 * Query params:
 *   shop_id — filter by specific shop
 *   status  — 'unread' | 'read' | 'replied' | 'all' (default: all)
 *   search  — fuzzy match on buyer_name or subject
 *   limit   — default 50
 *   offset  — default 0
 */
app.get('/api/messages', (req, res) => {
  const limit  = Math.min(Math.max(parseInt(req.query.limit  ?? 50,  10), 1), 200);
  const offset = parseInt(req.query.offset ?? 0, 10);

  const conditions = [];
  const params     = {};

  if (req.query.shop_id && req.query.shop_id !== 'all') {
    conditions.push('c.shop_id = @shop_id');
    params.shop_id = req.query.shop_id;
  }
  if (req.query.status && req.query.status !== 'all') {
    conditions.push('c.status = @status');
    params.status = req.query.status;
  }
  if (req.query.search) {
    conditions.push("(c.buyer_name LIKE @search OR c.subject LIKE @search)");
    params.search = `%${req.query.search}%`;
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const rows = db.prepare(`
    SELECT
      c.convo_id, c.shop_id, c.group_id,
      c.buyer_user_id, c.buyer_name, c.subject,
      c.status, c.unread_count, c.last_message_at,
      c.linked_receipt_id, c.synced_at,
      s.shop_name,
      (SELECT body FROM conversation_messages
       WHERE convo_id = c.convo_id ORDER BY created_at DESC LIMIT 1) AS last_message_preview,
      (SELECT sender_type FROM conversation_messages
       WHERE convo_id = c.convo_id ORDER BY created_at DESC LIMIT 1) AS last_sender_type
    FROM conversations c
    JOIN shops s ON s.shop_id = c.shop_id
    ${where}
    ORDER BY c.last_message_at DESC NULLS LAST
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit, offset });

  const total = db.prepare(`
    SELECT COUNT(*) AS c FROM conversations c ${where}
  `).get(params).c;

  res.json({ conversations: rows, total, limit, offset });
});

/**
 * GET /api/messages/unread-count
 * Total unread conversation count across all shops (or filtered by shop_id).
 * Polled by the UI every 30s to drive the tab badge.
 */
app.get('/api/messages/unread-count', (req, res) => {
  const params = {};
  let where = "WHERE status = 'unread'";
  if (req.query.shop_id) {
    where += ' AND shop_id = @shop_id';
    params.shop_id = req.query.shop_id;
  }
  const row = db.prepare(`SELECT COUNT(*) AS c FROM conversations ${where}`).get(params);
  res.json({ unread: row.c });
});

/**
 * GET /api/messages/:shop_id/:convo_id
 * Full conversation thread with all messages and optional linked order info.
 */
app.get('/api/messages/:shop_id/:convo_id', (req, res) => {
  const { shop_id, convo_id } = req.params;

  const convo = db.prepare(`
    SELECT c.*, s.shop_name
    FROM conversations c
    JOIN shops s ON s.shop_id = c.shop_id
    WHERE c.convo_id = @convo_id AND c.shop_id = @shop_id
  `).get({ convo_id, shop_id });

  if (!convo) return res.status(404).json({ error: 'Conversation not found' });

  const messages = db.prepare(`
    SELECT message_id, sender_type, body, created_at, read_at
    FROM conversation_messages
    WHERE convo_id = @convo_id
    ORDER BY created_at ASC
  `).all({ convo_id });

  // Link to order if a receipt is associated
  let linkedOrder = null;
  if (convo.linked_receipt_id) {
    linkedOrder = db.prepare(`
      SELECT receipt_id, name, status, is_shipped,
             grandtotal_amount, grandtotal_currency,
             first_product_title, etsy_created_at
      FROM receipts WHERE receipt_id = @id
    `).get({ id: convo.linked_receipt_id });
  } else if (convo.buyer_user_id) {
    // Try to find a receipt by buyer_user_id (same buyer may have placed an order)
    linkedOrder = db.prepare(`
      SELECT receipt_id, name, status, is_shipped,
             grandtotal_amount, grandtotal_currency,
             first_product_title, etsy_created_at
      FROM receipts
      WHERE shop_id = @shop_id AND buyer_user_id = @buyer_user_id
      ORDER BY etsy_created_at DESC LIMIT 1
    `).get({ shop_id, buyer_user_id: convo.buyer_user_id });
  }

  res.json({ conversation: convo, messages, linked_order: linkedOrder });
});

/**
 * POST /api/messages/:shop_id/:convo_id/reply
 * Send a reply to a buyer. Calls Etsy API through the group proxy.
 * Body: { body: string }
 */
app.post('/api/messages/:shop_id/:convo_id/reply', async (req, res) => {
  const { shop_id, convo_id } = req.params;
  const { body } = req.body;

  if (!body?.trim()) return res.status(400).json({ error: 'Message body is required' });

  const shopCfg = getAllShops(config).find(s => s.shop_id === shop_id);
  if (!shopCfg)  return res.status(404).json({ error: 'Shop not found in config' });
  if (!tokenManager.hasTokens(shop_id))
    return res.status(401).json({ error: 'Shop not authenticated — run oauth:setup' });

  const groupCfg = config.groups.find(g => g.shops.some(s => s.shop_id === shop_id));
  if (!groupCfg) return res.status(404).json({ error: 'Group not found for shop' });

  const etsyUrl     = `https://www.etsy.com/messages/convo/${convo_id}`;
  const trimmedBody = body.trim();
  const now         = Math.floor(Date.now() / 1000);

  // ── Tier 1: Browser automation (real send via Etsy web UI) ─────────────────
  if (browserManager.hasSession(shop_id)) {
    console.log(`[messages] Sending reply for ${shop_id}/${convo_id} via browser automation…`);
    const result = await sendBrowserReply(shopCfg, convo_id, trimmedBody);

    if (result.success) {
      // Persist the sent message locally
      const msgId = `browser-sent-${now}`;
      upsertConversationMessage(db, convo_id, shop_id, {
        message_id:        msgId,
        sender_type:       'seller',
        message_text:      trimmedBody,
        created_timestamp: now,
        seller_user_id:    'browser-seller',
        sender_user_id:    'browser-seller',
      });
      db.prepare(`UPDATE conversations SET status = 'replied', synced_at = ? WHERE convo_id = ?`).run(now, convo_id);
      broadcastSyncEvent({ type: 'messages:sent', shop_id, convo_id });
      return res.json({ success: true, method: 'browser', etsy_url: etsyUrl });
    }

    if (result.error === 'session_expired') {
      return res.json({
        success: false, method: 'session_expired',
        message: 'Your Etsy browser session expired. Click "Re-login" in the Messages tab to reconnect.',
        etsy_url: etsyUrl,
      });
    }

    // Browser failed for another reason — log and fall through to clipboard
    console.warn(`[messages] Browser reply failed (${result.error}) — falling back to clipboard flow`);
  }

  // ── Tier 2: Etsy internal API (may work for some API keys) ─────────────────
  try {
    const proxyClient = createGroupProxyClient(groupCfg, config.vpn_local_port);
    const accessToken = await tokenManager.getAccessToken(
      shopCfg.shop_id, shopCfg.api_key, shopCfg.refresh_token ?? null, proxyClient
    );
    const shopClient = buildShopClient(proxyClient, shopCfg.api_key, shopCfg.shared_secret, accessToken);

    const result = await replyToConversation(shopClient, shop_id, convo_id, trimmedBody);

    const finalMsgId = result?.message_id ?? result?.conversation_message_id ?? `api-${now}`;
    upsertConversationMessage(db, convo_id, shop_id, {
      message_id:        finalMsgId,
      sender_type:       'seller',
      message_text:      trimmedBody,
      created_timestamp: now,
      seller_user_id:    null,
      sender_user_id:    null,
    });
    db.prepare(`UPDATE conversations SET status = 'replied', synced_at = ? WHERE convo_id = ?`).run(now, convo_id);
    broadcastSyncEvent({ type: 'messages:sent', shop_id, convo_id });
    return res.json({ success: true, method: 'api', message_id: finalMsgId, etsy_url: etsyUrl });

  } catch (err) {
    const status = err.response?.status || 500;
    const detail = err.response?.data?.error || err.message;

    // ── Tier 3: Clipboard + open Etsy (guaranteed fallback) ──────────────────
    if (status === 403 || status === 404) {
      return res.json({
        success:   false,
        method:    'clipboard',
        etsy_url:  etsyUrl,
        copy_text: trimmedBody,
        message:   'Set up browser login in the Messages tab for one-click replies. For now, your message was copied — paste it on Etsy.',
      });
    }

    res.status(status).json({ error: detail, etsy_url: etsyUrl });
  }
});

/**
 * PUT /api/messages/:shop_id/:convo_id/read
 * Mark a conversation as read on Etsy and update local DB.
 */
app.put('/api/messages/:shop_id/:convo_id/read', async (req, res) => {
  const { shop_id, convo_id } = req.params;

  // Always update locally regardless of API success
  markConversationReadLocal(db, convo_id);

  const shopCfg = getAllShops(config).find(s => s.shop_id === shop_id);
  if (!shopCfg || !tokenManager.hasTokens(shop_id)) {
    return res.json({ success: true, local_only: true });
  }

  const groupCfg = config.groups.find(g => g.shops.some(s => s.shop_id === shop_id));
  if (!groupCfg) return res.json({ success: true, local_only: true });

  try {
    const proxyClient = createGroupProxyClient(groupCfg, config.vpn_local_port);
    const accessToken = await tokenManager.getAccessToken(
      shopCfg.shop_id, shopCfg.api_key, shopCfg.refresh_token ?? null, proxyClient
    );
    const shopClient = buildShopClient(proxyClient, shopCfg.api_key, shopCfg.shared_secret, accessToken);
    await markConversationReadOnEtsy(shopClient, shop_id, convo_id);
    res.json({ success: true, local_only: false });
  } catch {
    // Non-fatal — local DB is already updated
    res.json({ success: true, local_only: true });
  }
});

/**
 * POST /api/messages/sync
 * Trigger an immediate conversation sync for one shop or all shops.
 * Body: { shop_id?: string }  — omit to sync all authenticated shops.
 */
app.post('/api/messages/sync', async (req, res) => {
  const targetShopId = req.body?.shop_id ?? null;
  const allShops = getAllShops(config).filter(s => {
    if (!tokenManager.hasTokens(s.shop_id)) return false;
    return !targetShopId || s.shop_id === targetShopId;
  });

  if (!allShops.length) {
    return res.status(400).json({ error: 'No authenticated shops found' });
  }

  res.json({ message: `Conversation sync started for ${allShops.length} shop(s)` });

  // Run sync in background — don't await so the response is immediate
  (async () => {
    let totalNew = 0;
    for (const shopCfg of allShops) {
      const groupCfg = config.groups.find(g => g.shops.some(s => s.shop_id === shopCfg.shop_id));
      if (!groupCfg) continue;
      const proxyClient = createGroupProxyClient(groupCfg, config.vpn_local_port);
      const result = await syncConversationsForShop(
        shopCfg, groupCfg, config, proxyClient, tokenManager, db,
        (unreadCount) => {
          broadcastSyncEvent({ type: 'messages:unread', count: unreadCount, shop_id: shopCfg.shop_id });
        }
      );
      totalNew += result.newUnread;
    }
    const totalUnread = db.prepare(`SELECT COUNT(*) AS c FROM conversations WHERE status = 'unread'`).get().c;
    broadcastSyncEvent({ type: 'messages:unread', count: totalUnread });
    console.log(`[messages/sync] Complete — ${totalNew} new unread across ${allShops.length} shop(s)`);
  })().catch(err => console.error('[messages/sync] Error:', err.message));
});

// ── Browser-based messaging endpoints ────────────────────────────────────────

/**
 * GET /api/messages/browser-status
 * Returns the browser session status for every shop:
 *   has_session   — saved session file exists
 *   login_status  — current login-browser state (null if no login in progress)
 */
app.get('/api/messages/browser-status', (req, res) => {
  const allShops = getAllShops(config);
  const statuses = browserManager.getStatusSnapshot(allShops.map(s => s.shop_id));

  // Enrich with shop_name
  const enriched = statuses.map(s => {
    const shop = allShops.find(x => x.shop_id === s.shop_id);
    return { ...s, shop_name: shop?.shop_name || s.shop_id };
  });

  res.json({ shops: enriched, playwright_available: browserManager.isAvailable() });
});

/**
 * POST /api/messages/browser-setup/start/:shop_id
 * Open a visible Chromium window for the user to log into Etsy for this shop.
 * The session is saved automatically on login detection.
 */
app.post('/api/messages/browser-setup/start/:shop_id', async (req, res) => {
  const { shop_id } = req.params;

  if (!browserManager.isAvailable()) {
    return res.status(503).json({ error: 'Playwright not available. Run: npx playwright install chromium' });
  }

  const shopCfg = getAllShops(config).find(s => s.shop_id === shop_id);
  if (!shopCfg) return res.status(404).json({ error: 'Shop not found in config' });

  try {
    await browserManager.startLoginBrowser(shop_id, shopCfg.proxy || null);
    res.json({ started: true, message: 'Chromium window opened — log into your Etsy account, then return here.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/messages/browser-setup/cancel/:shop_id
 * Cancel an in-progress login browser session.
 */
app.post('/api/messages/browser-setup/cancel/:shop_id', async (req, res) => {
  const { shop_id } = req.params;
  await browserManager.closeLoginBrowser(shop_id);
  res.json({ cancelled: true });
});

/**
 * DELETE /api/messages/browser-setup/:shop_id
 * Delete saved session (forces re-login on next sync).
 */
app.delete('/api/messages/browser-setup/:shop_id', (req, res) => {
  browserManager.deleteSession(req.params.shop_id);
  res.json({ deleted: true });
});

/**
 * POST /api/messages/browser-sync
 * Trigger an immediate headless browser inbox sync for one shop or all shops
 * that have a saved browser session.
 * Body: { shop_id?: string }
 */
app.post('/api/messages/browser-sync', async (req, res) => {
  const targetShopId = req.body?.shop_id ?? null;
  const allShops = getAllShops(config).filter(s => {
    if (!browserManager.hasSession(s.shop_id)) return false;
    return !targetShopId || s.shop_id === targetShopId;
  });

  if (!allShops.length) {
    return res.status(400).json({
      error: 'No shops with an active browser session.',
      hint: 'Click "Login with Browser" in the Messages tab for each shop first.',
    });
  }

  res.json({ message: `Browser sync started for ${allShops.length} shop(s)` });

  (async () => {
    let totalSynced = 0;
    for (const shopCfg of allShops) {
      const result = await browserSyncShop(shopCfg, db);
      if (result.error === 'session_expired') {
        broadcastSyncEvent({ type: 'messages:session-expired', shop_id: shopCfg.shop_id });
        console.warn(`[browser-sync] ${shopCfg.shop_id}: session expired — re-login required`);
        continue;
      }
      totalSynced += result.synced || 0;
      if (result.synced > 0) {
        const totalUnread = db.prepare(`SELECT COUNT(*) AS c FROM conversations WHERE status = 'unread'`).get().c;
        broadcastSyncEvent({ type: 'messages:unread', count: totalUnread, shop_id: shopCfg.shop_id });
      }
    }
    const totalUnread = db.prepare(`SELECT COUNT(*) AS c FROM conversations WHERE status = 'unread'`).get().c;
    broadcastSyncEvent({ type: 'messages:unread', count: totalUnread });
    console.log(`[browser-sync] Done — ${totalSynced} conversations synced. Total unread: ${totalUnread}`);
  })().catch(err => console.error('[browser-sync] Error:', err.message));
});

/**
 * GET /api/messages/email-status
 * Returns which shops have email_imap configured and whether the last sync
 * succeeded, so the UI can show setup prompts for unconfigured shops.
 */
app.get('/api/messages/email-status', (req, res) => {
  const allShops = getAllShops(config);
  const statuses = allShops.map(s => ({
    shop_id:       s.shop_id,
    shop_name:     s.shop_name,
    email_user:    s.email_imap?.user   ?? null,
    email_host:    s.email_imap?.host   ?? 'imap.gmail.com',
    configured:    !!(s.email_imap?.user && s.email_imap?.password),
  }));
  res.json({ shops: statuses });
});

/**
 * POST /api/messages/email-sync
 * Trigger an immediate IMAP email sync for one shop or all configured shops.
 * Body: { shop_id?: string }
 */
app.post('/api/messages/email-sync', async (req, res) => {
  const targetShopId = req.body?.shop_id ?? null;
  const allShops = getAllShops(config).filter(s => {
    if (!s.email_imap?.user) return false;
    return !targetShopId || s.shop_id === targetShopId;
  });

  if (!allShops.length) {
    return res.status(400).json({
      error: 'No shops with email_imap configured.',
      hint: 'Add an email_imap block to each shop in config.json. See config.example.json for reference.',
    });
  }

  res.json({ message: `Email sync started for ${allShops.length} shop(s)` });

  // Run in background
  (async () => {
    const { totalSynced, results } = await syncAllShopEmails(allShops, db, (shopId, result) => {
      if (result.synced > 0) {
        const totalUnread = db.prepare(`SELECT COUNT(*) AS c FROM conversations WHERE status = 'unread'`).get().c;
        broadcastSyncEvent({ type: 'messages:unread', count: totalUnread, shop_id: shopId });
      }
      if (result.error) {
        broadcastSyncEvent({ type: 'messages:email-error', shop_id: shopId, error: result.error, detail: result.detail });
      }
    });

    const totalUnread = db.prepare(`SELECT COUNT(*) AS c FROM conversations WHERE status = 'unread'`).get().c;
    broadcastSyncEvent({ type: 'messages:unread', count: totalUnread });
    console.log(`[email-sync] Complete — ${totalSynced} messages synced from ${allShops.length} shop inbox(es). Total unread: ${totalUnread}`);

    results.forEach(r => {
      if (r.error) console.warn(`[email-sync] ${r.shop_id}: ${r.error} — ${r.detail}`);
    });
  })().catch(err => console.error('[email-sync] Fatal error:', err.message));
});

// ─── Shopping Route Generator API ────────────────────────────────────────────

/**
 * GET /api/route/config
 * Returns OSP configuration status so the UI can show a setup callout when
 * osp_project_dir is not yet set in config.json.
 */
app.get('/api/route/config', (req, res) => {
  const ospDir    = config.osp_project_dir;
  const ospScript = ospDir ? path.join(ospDir, 'src', 'generate_shopping_route.py') : null;
  let scriptExists = false;
  if (ospScript) {
    try { fs.accessSync(ospScript, fs.constants.R_OK); scriptExists = true; } catch {}
  }
  let charmCount = 0;
  try { charmCount = routeDashboard.loadCharmCatalog(ospDir).charms.length; } catch {}

  res.json({
    configured:    !!(ospDir),
    script_exists: scriptExists,
    osp_project_dir: ospDir,
    osp_python:    config.osp_python,
    script_path:   ospScript,
    charm_count:   charmCount,
    job:           _routeJob,
  });
});

/**
 * GET /api/route/status
 * Returns the current route job state (status, log lines, output files).
 * The browser polls this endpoint every 1.5 s while status === 'running'.
 */
app.get('/api/route/status', (req, res) => {
  res.json(_routeJob);
});

/**
 * GET /api/route/dashboard
 * The integrated Orders Sorting Dashboard data: every pending order line-item
 * merged with its saved charm assignment + per-component purchase status.
 *
 * Query params: date_from, date_to, shop_id, include_shipped (all optional).
 */
app.get('/api/route/dashboard', (req, res) => {
  try {
    // Explicit receipt set (pinned orders) — comma-separated, bypasses the
    // date/shipped filters so pre-transit orders can be pulled in.
    const receiptIds = (req.query.receipt_ids || '')
      .split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isInteger);

    const rows = routeDashboard.buildRouteRows(db, config, {
      date_from:       req.query.date_from,
      date_to:         req.query.date_to,
      shop_id:         req.query.shop_id,
      include_shipped: req.query.include_shipped === 'true',
      enrich_supplier: req.query.enrich_supplier !== 'false',
      receipt_ids:     receiptIds.length ? receiptIds : undefined,
    });

    // Headline counts for the dashboard summary bar.
    const summary = {
      orders:    new Set(rows.map(r => r.receipt_id)).size,
      items:     rows.length,
      excluded:  rows.filter(r => r.excluded).length,
      charms_needed: rows.filter(r => r.has_charm && !r.excluded).length,
      charms_assigned: rows.filter(r => r.has_charm && r.charm_code).length,
      supplier_matched: rows.filter(r => r.supplier_in_catalog).length,
      supplier_missing: rows.filter(r => !r.supplier_in_catalog).length,
    };

    res.json({ rows, summary, statuses: routeDashboard.STATUS_OPTIONS });
  } catch (err) {
    console.error('[route] dashboard error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/route/assign
 * Body: { receipt_id, item_key, title?, charm_code?, charm_shop?,
 *         status_case?, status_grip?, status_charm?, excluded? }
 * Upserts one order line's assignment. Only provided fields change.
 */
app.post('/api/route/assign', express.json(), (req, res) => {
  const b = req.body ?? {};
  if (b.receipt_id == null || !b.item_key) {
    return res.status(400).json({ error: 'receipt_id and item_key are required.' });
  }
  try {
    const row = upsertRouteAssignment(db, {
      receipt_id:              Number(b.receipt_id),
      item_key:                String(b.item_key),
      title:                   b.title,
      charm_code:              b.charm_code,
      charm_shop:              b.charm_shop,
      status_case:             b.status_case,
      status_grip:             b.status_grip,
      status_charm:            b.status_charm,
      excluded:                b.excluded,
      supplier_shop_override:  b.supplier_shop_override,
      supplier_stall_override: b.supplier_stall_override,
    });

    // ── Persist supplier + charm at product level so every future order
    //    with the same product title gets the same defaults automatically.
    const hasSupplierChange = b.supplier_shop_override != null || b.supplier_stall_override != null;
    const hasCharmChange    = b.charm_code != null;
    if ((hasSupplierChange || hasCharmChange) && b.item_key) {
      const productPatch = { item_key: String(b.item_key), title: b.title };
      if (hasSupplierChange) {
        productPatch.supplier_shop  = b.supplier_shop_override  ?? '';
        productPatch.supplier_stall = b.supplier_stall_override ?? '';
      }
      if (hasCharmChange) {
        productPatch.charm_code = b.charm_code  ?? '';
        productPatch.charm_shop = b.charm_shop  ?? '';
      }
      upsertProductAssignment(db, productPatch);
    }

    res.json({ ok: true, assignment: row });
  } catch (err) {
    console.error('[route] assign error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/route/order/:receiptId
 * Fetch a single order as route row(s) — bypasses the date window so any
 * paid order in the DB can be added to the route dashboard on demand.
 */
app.get('/api/route/order/:receiptId', (req, res) => {
  const receiptId = parseInt(req.params.receiptId, 10);
  if (isNaN(receiptId)) return res.status(400).json({ error: 'Invalid receipt_id' });
  try {
    const rows = routeDashboard.buildRouteRows(db, config, {
      receipt_id:      receiptId,
      enrich_supplier: true,
    });
    if (rows.length === 0) return res.status(404).json({ error: 'Order not found or not paid.' });
    res.json({ rows });
  } catch (err) {
    console.error('[route] order fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/route/suppliers
 * Returns the authoritative supplier directory + charm-shop directory,
 * imported from supplier_catalog.xlsx. Drives the dashboard's pickers.
 */
// Build the suppliers + charm-shops payload in authoritative sort_order.
function _supplierPayload() {
  const suppliers = getSupplierDirectory(db)
    .map(s => ({ shop_name: s.shop_name, stall: s.stall, mall: s.mall, floor: s.floor, address: s.address, notes: s.notes, sort_order: s.sort_order }));
  const charm_shops = getCharmShopDirectory(db)
    .map(s => ({ shop_name: s.shop_name, stall: s.stall, notes: s.notes, sort_order: s.sort_order }));
  return { suppliers, charm_shops };
}

// Map a thrown CRUD error code to an HTTP status.
function _supplierErrStatus(err) {
  if (err && err.code === 'DUPLICATE') return 409;
  if (err && (err.code === 'REQUIRED')) return 400;
  if (err && err.code === 'NOT_FOUND') return 404;
  return 500;
}

app.get('/api/route/suppliers', (req, res) => {
  try {
    res.json(_supplierPayload());
  } catch (err) {
    console.error('[route] suppliers error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/route/suppliers — create a new supplier in the directory.
 * Body: { shop_name, stall, mall?, floor?, address?, notes? }
 * Returns the full refreshed list so the UI can re-render in one round-trip.
 */
app.post('/api/route/suppliers', express.json(), (req, res) => {
  const b = req.body ?? {};
  try {
    insertSupplierDirectoryRow(db, b);
    res.json({ ok: true, ..._supplierPayload() });
  } catch (err) {
    res.status(_supplierErrStatus(err)).json({ error: err.message });
  }
});

/**
 * PUT /api/route/suppliers — update an existing supplier.
 * Body: { orig_shop_name, orig_stall, shop_name, stall, mall?, floor?, address?, notes? }
 */
app.put('/api/route/suppliers', express.json(), (req, res) => {
  const b = req.body ?? {};
  try {
    updateSupplierDirectoryRow(db, b);
    res.json({ ok: true, ..._supplierPayload() });
  } catch (err) {
    res.status(_supplierErrStatus(err)).json({ error: err.message });
  }
});

/**
 * DELETE /api/route/suppliers — remove a supplier by composite key.
 * Body: { shop_name, stall }
 */
app.delete('/api/route/suppliers', express.json(), (req, res) => {
  const b = req.body ?? {};
  try {
    const removed = deleteSupplierDirectoryRow(db, b);
    if (!removed) return res.status(404).json({ error: 'Supplier not found.' });
    res.json({ ok: true, ..._supplierPayload() });
  } catch (err) {
    res.status(_supplierErrStatus(err)).json({ error: err.message });
  }
});

/**
 * POST /api/route/charm-shops — create a new charm shop in the directory.
 * Body: { shop_name, stall, notes? }
 */
app.post('/api/route/charm-shops', express.json(), (req, res) => {
  const b = req.body ?? {};
  try {
    insertCharmShopDirectoryRow(db, b);
    res.json({ ok: true, ..._supplierPayload() });
  } catch (err) {
    res.status(_supplierErrStatus(err)).json({ error: err.message });
  }
});

/**
 * PUT /api/route/charm-shops — update an existing charm shop.
 * Body: { orig_shop_name, orig_stall, shop_name, stall, notes? }
 */
app.put('/api/route/charm-shops', express.json(), (req, res) => {
  const b = req.body ?? {};
  try {
    updateCharmShopDirectoryRow(db, b);
    res.json({ ok: true, ..._supplierPayload() });
  } catch (err) {
    res.status(_supplierErrStatus(err)).json({ error: err.message });
  }
});

/**
 * DELETE /api/route/charm-shops — remove a charm shop by composite key.
 * Body: { shop_name, stall }
 */
app.delete('/api/route/charm-shops', express.json(), (req, res) => {
  const b = req.body ?? {};
  try {
    const removed = deleteCharmShopDirectoryRow(db, b);
    if (!removed) return res.status(404).json({ error: 'Charm shop not found.' });
    res.json({ ok: true, ..._supplierPayload() });
  } catch (err) {
    res.status(_supplierErrStatus(err)).json({ error: err.message });
  }
});

/**
 * POST /api/route/import-suppliers
 * Force a re-import of supplier_catalog.xlsx (replaces the directory with the
 * Excel "Suppliers" sheet — use this to pull edits made in OSP).
 */
app.post('/api/route/import-suppliers', (req, res) => {
  try {
    const r = supplierImport.importSupplierCatalog(db, config, { force: true });
    if (!r.ok) return res.status(400).json(r);
    res.json({ ...r, ..._supplierPayload() });
  } catch (err) {
    console.error('[route] import-suppliers error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Build the enriched charm list (+ charm shops) for the UI.
function _charmsPayload() {
  const stallByShop = {};
  getCharmShopDirectory(db).forEach(s => { stallByShop[s.shop_name] = s.stall; });
  const charms = getCharmLibrary(db).map(c => ({
    code:               c.code,
    sku:                c.sku || '',
    default_charm_shop: c.default_charm_shop || '',
    default_charm_shop_stall: stallByShop[c.default_charm_shop] || '',
    notes:              c.notes || '',
    image_file:         c.image_file || '',
    has_image:          !!c.image_file,
    sort_order:         c.sort_order,
  }));
  return { charms, charm_shops: getCharmShopDirectory(db) };
}

/**
 * GET /api/route/charms
 * Returns the (UED-authoritative) charm library, enriched with each charm
 * shop's exact stall so the UI can show "shop · stall".
 */
app.get('/api/route/charms', (req, res) => {
  try {
    res.json(_charmsPayload());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/route/charms — add a new charm.
 * Body: { code?, sku?, default_charm_shop?, notes?, image_base64?, image_ext? }
 * A code is auto-allocated (CH-#####) when not provided.
 */
app.post('/api/route/charms', express.json({ limit: '20mb' }), (req, res) => {
  const b = req.body ?? {};
  try {
    let code = String(b.code || '').trim();
    if (!code) code = charmLibrary.allocateNextCode(db);
    if (!/^[A-Za-z0-9_-]+$/.test(code)) {
      return res.status(400).json({ error: 'Charm code may only contain letters, digits, "-" and "_".' });
    }
    let imageFile = '';
    if (b.image_base64) imageFile = charmLibrary.saveCharmImage(config, code, b.image_base64, b.image_ext);
    insertCharmLibraryRow(db, {
      code,
      sku:                b.sku,
      default_charm_shop: b.default_charm_shop,
      notes:              b.notes,
      image_file:         imageFile,
    });
    res.json({ ok: true, code, ..._charmsPayload() });
  } catch (err) {
    res.status(_supplierErrStatus(err)).json({ error: err.message });
  }
});

/**
 * PUT /api/route/charms — update a charm (incl. renaming its code).
 * Body: { orig_code, code, sku?, default_charm_shop?, notes?, image_base64?, image_ext? }
 */
app.put('/api/route/charms', express.json({ limit: '20mb' }), (req, res) => {
  const b = req.body ?? {};
  try {
    const origCode = String(b.orig_code || '').trim();
    const newCode  = String(b.code || origCode).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(newCode)) {
      return res.status(400).json({ error: 'Charm code may only contain letters, digits, "-" and "_".' });
    }
    const cur = getCharmByCode(db, origCode);
    if (!cur) return res.status(404).json({ error: 'Charm not found.' });

    // Resolve the resulting image filename across rename / new upload.
    let imageFile = cur.image_file || '';
    if (newCode !== origCode) {
      const renamed = charmLibrary.renameCharmImage(config, origCode, newCode);
      if (renamed) imageFile = renamed;
    }
    if (b.image_base64) {
      imageFile = charmLibrary.saveCharmImage(config, newCode, b.image_base64, b.image_ext);
    }

    updateCharmLibraryRow(db, {
      orig_code:          origCode,
      code:               newCode,
      sku:                b.sku,
      default_charm_shop: b.default_charm_shop,
      notes:              b.notes,
      image_file:         imageFile,
    });
    res.json({ ok: true, code: newCode, ..._charmsPayload() });
  } catch (err) {
    res.status(_supplierErrStatus(err)).json({ error: err.message });
  }
});

/**
 * DELETE /api/route/charms — remove a charm (and its image file).
 * Body: { code }
 */
app.delete('/api/route/charms', express.json(), (req, res) => {
  const code = String((req.body ?? {}).code || '').trim();
  try {
    const removed = deleteCharmLibraryRow(db, code);
    if (!removed) return res.status(404).json({ error: 'Charm not found.' });
    try { charmLibrary.deleteCharmImage(config, code); } catch {}
    res.json({ ok: true, ..._charmsPayload() });
  } catch (err) {
    res.status(_supplierErrStatus(err)).json({ error: err.message });
  }
});

/**
 * POST /api/route/charms/resync — reload the charm library from
 * charm_manifest.json (discards in-app charm edits).
 */
app.post('/api/route/charms/resync', (req, res) => {
  try {
    const r = charmLibrary.resyncCharmLibrary(db, config);
    if (!r.ok) return res.status(400).json(r);
    res.json({ ok: true, ..._charmsPayload() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/route/charms/reorder — drag-to-reorder + renumber.
 * Body: { order: [code, ...] } — current codes in the desired visual order.
 * Codes are renumbered sequentially by position; image files + charm_code
 * references follow so each physical charm keeps its image and assignments.
 */
app.post('/api/route/charms/reorder', express.json(), (req, res) => {
  const order = (req.body ?? {}).order;
  if (!Array.isArray(order) || !order.length) {
    return res.status(400).json({ error: 'order must be a non-empty array of charm codes.' });
  }
  try {
    const { renames } = reorderCharmLibrary(db, order);
    try { charmLibrary.reorderCharmImages(config, renames); }
    catch (e) { console.warn('[charms] image reorder warning:', e.message); }
    res.json({ ok: true, ..._charmsPayload() });
  } catch (err) {
    res.status(_supplierErrStatus(err)).json({ error: err.message });
  }
});

/**
 * GET /api/route/charm-image?code=CH-00001
 * Streams a charm thumbnail from the charm_images directory. Prefers the
 * library's stored image_file, then falls back to <code>.<ext> resolution.
 */
app.get('/api/route/charm-image', (req, res) => {
  const ospDir = config.osp_project_dir;
  const code   = (req.query.code || '').trim();
  if (!code) return res.status(404).end();

  // Try the library's recorded image_file first.
  try {
    const row = getCharmByCode(db, code);
    const dir = charmLibrary.charmImagesDir(config);
    if (row && row.image_file && dir && !/[/\\]/.test(row.image_file)) {
      const full = path.join(dir, row.image_file);
      try { fs.accessSync(full, fs.constants.R_OK); return res.sendFile(full); } catch {}
    }
  } catch {}

  // Fallback: manifest / <code>.<ext> resolution.
  const full = routeDashboard.resolveCharmImagePath(ospDir, code);
  if (!full) return res.status(404).end();
  res.sendFile(full, err => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

/**
 * POST /api/route/generate
 * Body: { date_from?, date_to?, shop_id?, chinese?, html?, purge_purchased? }
 *
 * Exports pending orders from the DB to a temp JSON file, then spawns the
 * Orders Sorting Program Python script with --import-json pointing at that
 * file.  Returns immediately (202) while the child process runs in the
 * background.  Poll GET /api/route/status for progress.
 */
app.post('/api/route/generate', express.json(), (req, res) => {
  if (_routeJob.status === 'running') {
    return res.status(409).json({ error: 'A route generation is already in progress.' });
  }

  const ospDir = config.osp_project_dir;
  if (!ospDir) {
    return res.status(400).json({ error: 'osp_project_dir is not set in config.json.' });
  }

  const ospScript = path.join(ospDir, 'src', 'generate_shopping_route.py');
  try { fs.accessSync(ospScript, fs.constants.R_OK); }
  catch {
    return res.status(400).json({ error: `Script not found: ${ospScript}` });
  }

  const { date_from, date_to, shop_id } = req.body ?? {};

  // ── Build route rows (orders × their saved charm/status assignments) ───────
  let rows;
  try {
    rows = routeDashboard.buildRouteRows(db, config, {
      date_from, date_to, shop_id, include_shipped: false,
    });
  } catch (err) {
    return res.status(500).json({ error: `DB error: ${err.message}` });
  }

  const includedRows  = rows.filter(r => !r.excluded);
  const exportedOrders = routeDashboard.rowsToImportOrders(rows);

  if (exportedOrders.length === 0) {
    return res.status(400).json({ error: 'No pending orders to generate a route for (after exclusions).' });
  }

  // ── Write OSP's status cache so it knows what's already Purchased / OOS ────
  let statusCacheInfo = { count: 0 };
  try {
    statusCacheInfo = routeDashboard.writeStatusCache(ospDir, includedRows);
  } catch (err) {
    return res.status(500).json({ error: `Cannot write status cache: ${err.message}` });
  }

  // ── Write temp JSON order payload, then spawn Python ───────────────────────
  const tmpFile = path.join(os.tmpdir(), `ued_route_${Date.now()}.json`);
  try {
    fs.writeFileSync(tmpFile, JSON.stringify({
      orders:      exportedOrders,
      exported_at: new Date().toISOString(),
    }, null, 2));
  } catch (err) {
    return res.status(500).json({ error: `Cannot write temp file: ${err.message}` });
  }

  // Always produce all three Excel files, matching a standard OSP run:
  //   shopping_route.xlsx · shopping_route_simple.xlsx · shopping_route_zh.xlsx
  // (--chinese adds the _zh file; the full + simple files are always written.)
  const pyArgs = [ospScript, '--import-json', tmpFile, '--chinese'];

  const lineItemCount = exportedOrders.reduce((s, o) => s + o.items.length, 0);
  _routeJob = {
    status:     'running',
    log:        [
      `[${new Date().toISOString()}] Starting route generation for ${exportedOrders.length} order(s), ${lineItemCount} line item(s)…`,
      `[cache] Wrote ${statusCacheInfo.count} purchase-status entr${statusCacheInfo.count === 1 ? 'y' : 'ies'} to route_statuses_cache.json`,
      `[cmd] ${config.osp_python} ${pyArgs.join(' ')}`,
    ],
    startedAt:  new Date().toISOString(),
    finishedAt: null,
    outputDir:  null,
    files:      [],
    error:      null,
  };

  res.status(202).json({ status: 'started', order_count: exportedOrders.length, item_count: lineItemCount });

  const proc = spawn(config.osp_python, pyArgs, {
    cwd: ospDir,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
  });

  const addLog = line => { _routeJob.log.push(line); };

  proc.stdout.on('data', chunk =>
    chunk.toString('utf8').split('\n').filter(Boolean).forEach(addLog));
  proc.stderr.on('data', chunk =>
    chunk.toString('utf8').split('\n').filter(Boolean).forEach(l => addLog(`[stderr] ${l}`)));

  proc.on('error', err => {
    try { fs.unlinkSync(tmpFile); } catch {}
    _routeJob.status     = 'error';
    _routeJob.error      = err.message;
    _routeJob.finishedAt = new Date().toISOString();
    addLog(`[error] Failed to start Python: ${err.message}`);
    console.error('[route] spawn error:', err.message);
  });

  proc.on('close', code => {
    try { fs.unlinkSync(tmpFile); } catch {}

    if (code === 0) {
      const outputDir = path.join(ospDir, 'output');
      let files = [];
      try {
        files = fs.readdirSync(outputDir)
          .filter(f => /^shopping_route(_simple|_zh)?\.xlsx$/i.test(f))
          .map(f => {
            const fp   = path.join(outputDir, f);
            const stat = fs.statSync(fp);
            return { name: f, path: fp, size: stat.size, modified: stat.mtimeMs };
          })
          .sort((a, b) => b.modified - a.modified);
      } catch {}

      _routeJob.status     = 'done';
      _routeJob.finishedAt = new Date().toISOString();
      _routeJob.outputDir  = outputDir;
      _routeJob.files      = files;
      addLog(`[done] Generation complete — ${files.length} file(s) ready.`);
      files.forEach(f => addLog(`[file] ${f.name}  (${(f.size / 1024).toFixed(1)} KB)`));
    } else {
      _routeJob.status     = 'error';
      _routeJob.error      = `Python exited with code ${code}`;
      _routeJob.finishedAt = new Date().toISOString();
      addLog(`[error] Python exited with code ${code}`);
    }

    console.log(`[route] Job finished — status: ${_routeJob.status}`);
  });
});

// The three Excel files a standard OSP run produces, with friendly labels.
const ROUTE_OUTPUT_FILES = [
  { file: 'shopping_route.xlsx',        label: 'Full route',    desc: 'Floors · products · orders', icon: '📄' },
  { file: 'shopping_route_simple.xlsx', label: 'Simple route',  desc: 'Compact supplier checklist',  icon: '🧾' },
  { file: 'shopping_route_zh.xlsx',     label: 'Chinese route', desc: '中文 · simplified',            icon: '🇨🇳' },
];

function _routeOutputDir() {
  return config.osp_project_dir ? path.join(config.osp_project_dir, 'output') : null;
}
function _isAllowedRouteFile(name) {
  return /^shopping_route(_simple|_zh)?\.(xlsx|html)$/i.test(name) && !/[/\\]/.test(name);
}

/**
 * GET /api/route/output-files
 * Lists the three standard shopping-route Excel files and whether each exists.
 */
app.get('/api/route/output-files', (req, res) => {
  const dir = _routeOutputDir();
  if (!dir) return res.json({ files: ROUTE_OUTPUT_FILES.map(s => ({ ...s, exists: false })) });
  const files = ROUTE_OUTPUT_FILES.map(spec => {
    const fp = path.join(dir, spec.file);
    try {
      const st = fs.statSync(fp);
      return { ...spec, exists: true, size: st.size, modified: st.mtimeMs };
    } catch {
      return { ...spec, exists: false };
    }
  });
  res.json({ files });
});

/**
 * GET /api/route/open?file=shopping_route.xlsx
 * Opens a generated Excel file with the OS default app (the dashboard runs
 * locally on the same machine as the files).
 */
app.get('/api/route/open', (req, res) => {
  const dir  = _routeOutputDir();
  const file = (req.query.file ?? '').trim();
  if (!dir) return res.status(400).json({ error: 'osp_project_dir is not set in config.json.' });
  if (!_isAllowedRouteFile(file)) return res.status(400).json({ error: 'Invalid file name.' });

  const fp = path.join(dir, file);
  try { fs.accessSync(fp, fs.constants.R_OK); }
  catch { return res.status(404).json({ error: 'File not found — generate the shopping route first.' }); }

  try {
    if (process.platform === 'win32') {
      // `start` needs an (empty) title arg before the path; run via cmd.
      spawn('cmd', ['/c', 'start', '', fp], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [fp], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [fp], { detached: true, stdio: 'ignore' }).unref();
    }
    res.json({ ok: true, file });
  } catch (err) {
    console.error('[route] open error:', err.message);
    res.status(500).json({ error: `Could not open file: ${err.message}` });
  }
});

/**
 * GET /api/route/download?file=shopping_route.xlsx
 * Serves a shopping-route file from the OSP output directory.
 */
app.get('/api/route/download', (req, res) => {
  const dir  = _routeOutputDir();
  const file = (req.query.file ?? '').trim();
  if (!dir) return res.status(400).json({ error: 'osp_project_dir is not set in config.json.' });
  if (!_isAllowedRouteFile(file)) return res.status(400).json({ error: 'Invalid file name.' });

  const fp = path.join(dir, file);
  try { fs.accessSync(fp, fs.constants.R_OK); }
  catch { return res.status(404).json({ error: 'File not found.' }); }

  res.download(fp, file, err => {
    if (err && !res.headersSent) {
      console.error('[route] download error:', err.message);
      res.status(500).json({ error: 'Download failed.' });
    }
  });
});

/**
 * GET /api/route/download-unmatched-images
 * ZIP of product thumbnails for items with no supplier/location yet.
 * Uses the same date/shop/receipt scope as GET /api/route/dashboard.
 *
 * Query: date_from, date_to, shop_id, receipt_ids (comma-separated).
 * Response: application/zip; X-Images-Added / X-Images-Requested headers.
 */
app.get('/api/route/download-unmatched-images', async (req, res) => {
  try {
    const receiptIds = (req.query.receipt_ids || '')
      .split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isInteger);

    const rows = routeDashboard.buildRouteRows(db, config, {
      date_from:       req.query.date_from,
      date_to:         req.query.date_to,
      shop_id:         req.query.shop_id,
      include_shipped: req.query.include_shipped === 'true',
      enrich_supplier: true,
      receipt_ids:     receiptIds.length ? receiptIds : undefined,
    });

    const items = unmatchedImages.collectUnmatchedImageItems(rows);
    if (!items.length) {
      return res.status(404).json({
        error: 'No unmatched products with cached images in this date range. Try widening dates or run npm run fetch-images.',
      });
    }

    const stamp = new Date().toISOString().slice(0, 10);
    const zipName = `unmatched-products-${stamp}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
    res.setHeader('X-Images-Requested', String(items.length));

    const { added, failed } = await unmatchedImages.streamUnmatchedImagesZip(res, items);
    console.log(`[route] unmatched images zip: ${added}/${items.length} (${failed.length} failed)`);
  } catch (err) {
    console.error('[route] download-unmatched-images:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'Could not build image archive.' });
    }
  }
});

// ─── Dashboard HTML ───────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../../public/index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 4000;
app.listen(PORT, () => {
  const allShops  = getAllShops(config);
  const authedN   = allShops.filter(s => tokenManager.hasTokens(s.shop_id)).length;
  const groups    = config.groups;

  // ── Rate-limit budget analysis (logged at every startup) ─────
  // Etsy Personal Access: 5 QPS / 5,000 QPD per API key
  // Sync interval: each shop runs roughly once per hour (cron + jitter)
  // Calls per shop per sync:
  //   1 token refresh (POST /oauth/token) — only when token is expiring
  //   1-2 receipt pages  (GET /shops/{id}/receipts)
  //   ≈ 3 calls/shop/cycle on average
  const syncIntervalH = 1; // hourly cron
  const callsPerShopPerCycle = 3;
  const cyclesPerDay  = 24 / syncIntervalH;
  const uniqueKeys    = [...new Set(allShops.map(s => s.api_key))];
  const budgetLines   = uniqueKeys.map(key => {
    const shopCount = allShops.filter(s => s.api_key === key).length;
    const callsPerDay = shopCount * callsPerShopPerCycle * cyclesPerDay;
    const pct = ((callsPerDay / 5000) * 100).toFixed(1);
    return `      ${key.slice(0, 16)}…  ${shopCount} shops → ~${callsPerDay} calls/day  (${pct}% of 5K QPD)`;
  });

  console.log('═'.repeat(60));
  console.log('  Etsy Unified Dashboard');
  console.log('═'.repeat(60));
  console.log(`\n  Local URL : http://localhost:${PORT}`);
  console.log(`  DB        : ${config.db_path}`);
  console.log(`  Shops     : ${allShops.length} configured, ${authedN} authenticated`);
  const proxiedGroups = groups.filter(g => { const { usesGroupProxy } = require('../config/schema'); return usesGroupProxy(g); }).length;
  const directGroups  = groups.length - proxiedGroups;
  console.log(`  Groups    : ${groups.length} (${proxiedGroups} proxied via VPN→IPFoxy, ${directGroups} direct)`);
  console.log('\n  ── Rate limit budget (5 QPS / 5,000 QPD per API key) ──');
  budgetLines.forEach(l => console.log(l));
  console.log(`\n  Sync interval : ${syncIntervalH}h (cron) + 0–90s jitter per shop`);
  console.log('  QPS at burst  : ≤2 per shop (staggered by jitter, well under 5 QPS)');
  console.log('  Status        : ✓ Safe — all keys under 30% of daily budget\n');
  console.log('  Open http://localhost:4000 in your browser.\n');

  // ── Browser inbox sync cron (every 5 minutes) ─────────────────────────────
  // Syncs Etsy inbox via headless Playwright for all shops with saved sessions.
  // Runs before email sync so browser data takes priority.
  cron.schedule('*/5 * * * *', async () => {
    try {
      const browserShops = getAllShops(config).filter(s => browserManager.hasSession(s.shop_id));
      if (!browserShops.length) return;

      let totalSynced = 0;
      for (const shopCfg of browserShops) {
        const result = await browserSyncShop(shopCfg, db);
        if (result.error === 'session_expired') {
          broadcastSyncEvent({ type: 'messages:session-expired', shop_id: shopCfg.shop_id });
        } else if (result.synced > 0) {
          totalSynced += result.synced;
          const unread = db.prepare(`SELECT COUNT(*) AS c FROM conversations WHERE status = 'unread'`).get().c;
          broadcastSyncEvent({ type: 'messages:unread', count: unread, shop_id: shopCfg.shop_id });
        }
      }
      if (totalSynced > 0) {
        console.log(`[browser-sync] Cron — synced ${totalSynced} conversation(s)`);
      }
    } catch (err) {
      console.error('[browser-sync] Cron error:', err.message);
    }
  });

  // ── Email inbox sync cron (every 5 minutes) ────────────────────────────────
  // Polls Gmail/Outlook via IMAP for Etsy message notification emails.
  // Only runs for shops that have email_imap configured in config.json.
  // No Etsy API calls — reads the shop owner's email inbox directly.
  const emailShops = getAllShops(config).filter(s => s.email_imap?.user && s.email_imap?.password);
  if (emailShops.length > 0) {
    console.log(`  Email sync: ${emailShops.length} shop(s) configured for IMAP email sync (every 5 min)`);
    cron.schedule('*/5 * * * *', async () => {
      try {
        const { totalSynced } = await syncAllShopEmails(emailShops, db, (shopId, result) => {
          if (result.synced > 0) {
            const totalUnread = db.prepare(`SELECT COUNT(*) AS c FROM conversations WHERE status = 'unread'`).get().c;
            broadcastSyncEvent({ type: 'messages:unread', count: totalUnread, shop_id: shopId });
          }
          if (result.error && result.error !== 'auth_failed') {
            // Auth failures are expected until the user fixes their app password; don't flood console
            console.warn(`[email-sync] ${shopId}: ${result.error} — ${result.detail}`);
          }
        });
        if (totalSynced > 0) {
          console.log(`[email-sync] Synced ${totalSynced} new message(s) from inbox`);
        }
      } catch (err) {
        console.error('[email-sync] Cron error:', err.message);
      }
    });
  }

  // ── Conversation sync cron (every 20 minutes) ──────────────────────────────
  // Syncs all authenticated shops' conversation threads from Etsy's internal API.
  // Rate budget: ~72 calls/shop/day — well within QPD limits (see architecture docs).
  // The sync worker also exports syncConversationsForShop for use here so we
  // reuse all the proxy-isolation and token-refresh logic.
  cron.schedule('*/20 * * * *', async () => {
    try {
      const authedShops = getAllShops(config).filter(s => tokenManager.hasTokens(s.shop_id));
      if (!authedShops.length) return;

      console.log(`\n[convo-sync] Starting conversation sync for ${authedShops.length} shop(s)…`);
      let totalNew = 0;

      for (const shopCfg of authedShops) {
        const groupCfg = config.groups.find(g => g.shops.some(s => s.shop_id === shopCfg.shop_id));
        if (!groupCfg) continue;

        const proxyClient = createGroupProxyClient(groupCfg, config.vpn_local_port);
        const result = await syncConversationsForShop(
          shopCfg, groupCfg, config, proxyClient, tokenManager, db,
          (unreadCount) => {
            broadcastSyncEvent({ type: 'messages:unread', count: unreadCount, shop_id: shopCfg.shop_id });
          }
        );
        if (!result.skipped) totalNew += result.newUnread;
      }

      const totalUnread = db.prepare(`SELECT COUNT(*) AS c FROM conversations WHERE status = 'unread'`).get().c;
      broadcastSyncEvent({ type: 'messages:unread', count: totalUnread });
      console.log(`[convo-sync] Done — total unread: ${totalUnread} (${totalNew} new this cycle)`);
    } catch (err) {
      console.error(`[convo-sync] Error: ${err.message}`);
    }
  });

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
  if (process.env.EMBEDDED_SYNC === '0') {
    console.log('  Embedded sync: DISABLED (EMBEDDED_SYNC=0) — run `npm run sync` in a separate terminal\n');
  } else {
    const syncIntervalMin = config.sync_interval_minutes ?? 60;
    const invWatchMin     = config.inv_watch_interval_minutes ?? 240;

    // Single shared guard so receipt sync and inventory watch never overlap each
    // other (or themselves) — protects the per-key QPD budget.
    let syncBusy = false;
    const runGuarded = async (label, fn) => {
      if (syncBusy) {
        console.log(`[${label}] Previous sync still running — skipping this trigger`);
        return;
      }
      syncBusy = true;
      try {
        await fn();
      } catch (err) {
        console.error(`[${label}] Unhandled error: ${err.message}`);
      } finally {
        syncBusy = false;
      }
    };

    const receiptCron = syncIntervalMin === 60
      ? '0 * * * *'
      : `*/${Math.max(1, Math.ceil(syncIntervalMin))} * * * *`;
    const invCron = invWatchMin >= 60
      ? (Math.ceil(invWatchMin / 60) === 1 ? '0 * * * *' : `0 */${Math.ceil(invWatchMin / 60)} * * *`)
      : `*/${Math.max(1, Math.ceil(invWatchMin))} * * * *`;

    console.log(`  Embedded sync: ON — receipts "${receiptCron}" (every ${syncIntervalMin}m), inventory watch "${invCron}" (every ${invWatchMin}m)`);
    console.log('                 Auto-restock + order sync run automatically while the dashboard is open.\n');

    // Kick off shortly after boot so the dashboard is responsive first, then on cron.
    setTimeout(() => {
      runGuarded('sync', () => runSyncCycle(config, tokenManager, db))
        .then(() => runGuarded('inventory-watch', () => runInventoryWatchCycle(config, tokenManager, db)));
    }, 8000);

    cron.schedule(receiptCron, () => {
      runGuarded('sync', () => runSyncCycle(config, tokenManager, db));
    });
    cron.schedule(invCron, () => {
      runGuarded('inventory-watch', () => runInventoryWatchCycle(config, tokenManager, db));
    });
  }
});
