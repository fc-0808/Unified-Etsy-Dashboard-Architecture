'use strict';

// Load .env (OpenAI key + bulk-listing tuning) before anything else reads
// process.env. Non-fatal if the file is absent — config.json still drives Etsy.
require('dotenv').config();

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
        deleteCharmLibraryRow, reorderCharmLibrary,
        getCharmPurchaseProgress, setCharmPurchaseProgress,
        getProductMap, upsertProductMapRow, updateProductMapRowById, deleteProductMapRow,
        insertManualItem, getManualItems, getManualItemImage, deleteManualItemByReceipt } = require('../db/setup');
const routeDashboard                               = require('../route/dashboard');
const enginePaths                                  = require('../route/engine-paths');
const { batchFetchRouteImages }                    = require('../route/image-fetcher');
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
        getShipOrder, splitName,
        safeLabelBaseName, assignUniqueLabelNames } = require('../fourpx/orders');
const { getFullTrackingEvents }                    = require('../tracking/checker');
const { scanInputRoot }                            = require('../listings/scanner');
const { getShopListingSettings }                   = require('../listings/shop-settings');
const { BulkJobManager }                           = require('../listings/bulk-runner');

const TOKENS_PATH = path.resolve(__dirname, '../../tokens.json');

// Absolute path to THIS dashboard's project root (src/server → ../../).
// Used to keep generated artifacts (e.g. shopping-route Excel files) inside
// our own program folder regardless of the process working directory.
const UED_ROOT = path.resolve(__dirname, '../../');

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
 * Comprehensive 4PX XMS logistics product catalogue — fallback for direct-customer
 * API keys that cannot access ds.xms.logistics_product.getlist (returns error 000024).
 *
 * When the live API IS available (ISV / software-provider accounts), this list is
 * never used — the API's country-filtered response takes precedence.
 *
 * Structure per entry:
 *   code      — logistics_product_code passed verbatim to ds.xms.order.create
 *   name      — short display label
 *   desc      — one-line description with transit time estimate
 *   tier      — 'economy' | 'standard' | 'express' | 'premium' | 'custom'
 *   countries — ISO-2 destination codes where this product is offered.
 *               Empty array [] means the product ships to ALL countries.
 *
 * Sources: b.4px.com portal, 4PX open-platform docs, partner reseller catalogs.
 * Country arrays are best-effort; the live API is authoritative for your account.
 */

// Helper — ISO-2 codes for common destination regions
const _EU27 = ['DE','FR','NL','IT','ES','PL','SE','BE','AT','PT','CZ','HU','RO',
               'SK','FI','DK','IE','HR','SI','LT','LV','EE','BG','GR','LU','MT','CY'];
const _EU_CORE = ['DE','FR','NL','IT','ES','PL','SE','BE','AT','PT'];
const _ANGLOSPHERE = ['US','CA','AU','GB'];
const _ASIA_EAST   = ['JP','KR','SG','MY','TH','PH','VN','TW','HK'];
const _LATAM       = ['MX','BR','CL','AR','CO','PE'];

// Destinations where 4PX requires an IOSS number for parcels with a declared
// value ≤ €150 (EU27 — the IOSS scheme covers the whole EU customs union). The
// server attaches config.fourpx_ioss_no to orders bound for these countries.
const FOURPX_IOSS_COUNTRIES = new Set(_EU27);

const FOURPX_PRODUCT_CATALOG = [
  // ── POSTLINK — Postal direct (邮政直连) ──────────────────────────────────────
  {
    code: 'S5058', name: 'POSTLINK-LW (S5058)',
    desc: 'Postal Light Weight · ≤2 kg · no battery · 10–25 days',
    tier: 'economy',
    countries: [..._ANGLOSPHERE, ..._EU27, ..._ASIA_EAST, ..._LATAM, 'NO','CH','IS','NZ'],
  },
  {
    code: 'S5118', name: 'US-ISLAND-PH (S5118)',
    desc: 'Postal · US island territories (HI/AK/GU/PR/VI) + Philippines · 12–25 days',
    tier: 'economy',
    countries: ['US','PH'],
  },
  {
    code: 'S5062', name: 'POSTLINK-S (S5062)',
    desc: 'Postal Small Package · ≤2 kg · economy · 12–30 days',
    tier: 'economy',
    countries: [..._ANGLOSPHERE, ..._EU27, ..._ASIA_EAST, ..._LATAM, 'NO','CH','NZ'],
  },
  {
    code: 'S5013', name: 'POSTLINK-R (S5013)',
    desc: 'Postal Registered Airmail · global · 15–40 days',
    tier: 'economy',
    countries: [], // worldwide
  },

  // ── 4PX Direct Lines / Special Lines (特线产品) ───────────────────────────────
  {
    code: 'FDYE', name: 'Yellow Express Direct',
    desc: '4PX Yellow Express · ePacket-grade · tracked · 8–18 days',
    tier: 'standard',
    countries: [..._ANGLOSPHERE, ..._EU_CORE, 'JP','KR','SG','MY','RU','BR','MX'],
  },
  {
    code: 'FXEC', name: 'Express via China Post',
    desc: 'China Post Express Registered · tracked · 10–20 days',
    tier: 'standard',
    countries: [], // worldwide
  },
  {
    code: 'FXRM', name: 'Registered Airmail',
    desc: 'China Post Registered Air · economy untracked · 15–30 days',
    tier: 'economy',
    countries: [], // worldwide
  },
  {
    code: 'FLPS', name: 'Light Priority Small',
    desc: '4PX Light Priority · ≤500 g · tracked · 8–16 days',
    tier: 'standard',
    countries: [..._ANGLOSPHERE, ..._EU_CORE],
  },
  {
    code: 'FDBM', name: 'Blue Multi Direct',
    desc: '4PX Blue Direct Multi-Piece · USPS last-mile · 8–15 days',
    tier: 'standard',
    countries: ['US'],
  },
  {
    code: 'FDTM', name: 'Direct Tracked Mail',
    desc: '4PX Direct Tracked Mail · USPS/Canada Post · 8–18 days',
    tier: 'standard',
    countries: ['US','CA'],
  },

  // ── 4PX Business Direct (商业小包) ───────────────────────────────────────────
  {
    code: 'BDS', name: 'Business Direct Small',
    desc: '4PX Business Direct · tracked · global · 8–20 days',
    tier: 'standard',
    countries: [], // worldwide
  },
  {
    code: 'BDSE', name: 'Business Direct Economy',
    desc: '4PX Business Direct Economy · low-cost tracked · 10–25 days',
    tier: 'economy',
    countries: [..._ANGLOSPHERE, ..._EU_CORE, 'PL','SE','BE'],
  },

  // ── QC Series — Quality Controlled (质量保障专线) ─────────────────────────────
  // Guaranteed scan events, dedicated sorters, low loss rate.
  { code: 'QCUS', name: 'QC — United States',    desc: 'QC · USPS last-mile · 7–15 days',             tier: 'standard', countries: ['US'] },
  { code: 'QCCA', name: 'QC — Canada',            desc: 'QC · Canada Post · 8–18 days',               tier: 'standard', countries: ['CA'] },
  { code: 'QCAU', name: 'QC — Australia',         desc: 'QC · Australia Post · 8–18 days',            tier: 'standard', countries: ['AU'] },
  { code: 'QCGB', name: 'QC — United Kingdom',    desc: 'QC · Royal Mail · 7–15 days',                tier: 'standard', countries: ['GB'] },
  { code: 'QCDE', name: 'QC — Germany',           desc: 'QC · Deutsche Post/DHL · 8–16 days',         tier: 'standard', countries: ['DE'] },
  { code: 'QCFR', name: 'QC — France',            desc: 'QC · La Poste Colissimo · 8–18 days',        tier: 'standard', countries: ['FR'] },
  { code: 'QCNL', name: 'QC — Netherlands',       desc: 'QC · PostNL · 8–16 days',                    tier: 'standard', countries: ['NL'] },
  { code: 'QCIT', name: 'QC — Italy',             desc: 'QC · Poste Italiane · 10–20 days',           tier: 'standard', countries: ['IT'] },
  { code: 'QCES', name: 'QC — Spain',             desc: 'QC · Correos · 10–20 days',                  tier: 'standard', countries: ['ES'] },
  { code: 'QCPL', name: 'QC — Poland',            desc: 'QC · InPost / Poczta Polska · 10–20 days',   tier: 'standard', countries: ['PL'] },
  { code: 'QCSE', name: 'QC — Sweden',            desc: 'QC · PostNord · 10–20 days',                 tier: 'standard', countries: ['SE'] },
  { code: 'QCNO', name: 'QC — Norway',            desc: 'QC · Posten Norge · 10–22 days',             tier: 'standard', countries: ['NO'] },
  { code: 'QCDK', name: 'QC — Denmark',           desc: 'QC · PostNord DK · 10–20 days',              tier: 'standard', countries: ['DK'] },
  { code: 'QCBE', name: 'QC — Belgium',           desc: 'QC · bpost · 10–18 days',                    tier: 'standard', countries: ['BE'] },
  { code: 'QCAT', name: 'QC — Austria',           desc: 'QC · Österreichische Post · 10–20 days',     tier: 'standard', countries: ['AT'] },
  { code: 'QCCH', name: 'QC — Switzerland',       desc: 'QC · Swiss Post · 10–20 days',               tier: 'standard', countries: ['CH'] },
  { code: 'QCPT', name: 'QC — Portugal',          desc: 'QC · CTT · 10–22 days',                      tier: 'standard', countries: ['PT'] },
  { code: 'QCJP', name: 'QC — Japan',             desc: 'QC · Japan Post · 8–16 days',                tier: 'standard', countries: ['JP'] },
  { code: 'QCKR', name: 'QC — South Korea',       desc: 'QC · Korea Post · 8–16 days',               tier: 'standard', countries: ['KR'] },
  { code: 'QCSG', name: 'QC — Singapore',         desc: 'QC · SingPost · 7–14 days',                  tier: 'standard', countries: ['SG'] },
  { code: 'QCMY', name: 'QC — Malaysia',          desc: 'QC · Pos Malaysia · 10–20 days',             tier: 'standard', countries: ['MY'] },
  { code: 'QCTH', name: 'QC — Thailand',          desc: 'QC · Thailand Post · 10–22 days',            tier: 'standard', countries: ['TH'] },
  { code: 'QCMX', name: 'QC — Mexico',            desc: 'QC · Correos México · 15–30 days',           tier: 'standard', countries: ['MX'] },
  { code: 'QCBR', name: 'QC — Brazil',            desc: 'QC · Correios · 20–45 days',                 tier: 'standard', countries: ['BR'] },
  { code: 'QCNZ', name: 'QC — New Zealand',       desc: 'QC · NZ Post · 10–22 days',                  tier: 'standard', countries: ['NZ'] },
  { code: 'QCSA', name: 'QC — Saudi Arabia',      desc: 'QC · Saudi Post · 12–25 days',               tier: 'standard', countries: ['SA'] },
  { code: 'QCAE', name: 'QC — United Arab Emirates', desc: 'QC · Emirates Post · 10–20 days',         tier: 'standard', countries: ['AE'] },
  { code: 'QCIL', name: 'QC — Israel',            desc: 'QC · Israel Post · 12–25 days',              tier: 'standard', countries: ['IL'] },
  { code: 'QCTR', name: 'QC — Turkey',            desc: 'QC · PTT · 12–25 days',                      tier: 'standard', countries: ['TR'] },

  // ── PX Series — Priority Express (优先快递) ───────────────────────────────────
  // Faster transit, signature tracking, priority sort.
  { code: 'PXUS', name: 'PX Priority — United States', desc: 'Priority Express · USPS Priority last-mile · 5–10 days',  tier: 'express', countries: ['US'] },
  { code: 'PXCA', name: 'PX Priority — Canada',        desc: 'Priority Express · Canada Post Xpresspost · 6–12 days',  tier: 'express', countries: ['CA'] },
  { code: 'PXAU', name: 'PX Priority — Australia',     desc: 'Priority Express · AusPost Express · 6–12 days',         tier: 'express', countries: ['AU'] },
  { code: 'PXGB', name: 'PX Priority — United Kingdom',desc: 'Priority Express · Royal Mail Tracked 48 · 5–10 days',   tier: 'express', countries: ['GB'] },
  { code: 'PXDE', name: 'PX Priority — Germany',       desc: 'Priority Express · DHL DE · 6–12 days',                 tier: 'express', countries: ['DE'] },
  { code: 'PXFR', name: 'PX Priority — France',        desc: 'Priority Express · Colissimo Priority · 6–12 days',      tier: 'express', countries: ['FR'] },
  { code: 'PXJP', name: 'PX Priority — Japan',         desc: 'Priority Express · Japan Post EMS · 5–10 days',          tier: 'express', countries: ['JP'] },
  { code: 'PXSG', name: 'PX Priority — Singapore',     desc: 'Priority Express · SingPost Priority · 5–10 days',       tier: 'express', countries: ['SG'] },

  // ── SFC (SF Express International / 顺丰国际) ─────────────────────────────────
  {
    code: 'SFCECO', name: 'SFC Economy',
    desc: 'SF Express Economy · tracked · 8–18 days',
    tier: 'standard',
    countries: ['US','CA','AU','GB','DE','FR','NL','IT','ES','JP','KR','SG'],
  },
  {
    code: 'SFCPRI', name: 'SFC Priority',
    desc: 'SF Express Priority · 6–12 days',
    tier: 'express',
    countries: ['US','CA','AU','GB','DE','FR','NL','IT','ES','JP','KR','SG'],
  },

  // ── YunExpress (云途物流) ────────────────────────────────────────────────────
  {
    code: 'YUNTU', name: 'YunExpress Standard',
    desc: 'Yun Express Standard · tracked · 8–20 days',
    tier: 'standard',
    countries: ['US','CA','AU','GB','DE','FR','NL','IT','ES','PL','SE','BE','AT','PT','CZ','HU'],
  },
  {
    code: 'YUNTUP', name: 'YunExpress Priority',
    desc: 'Yun Express Priority · 7–15 days',
    tier: 'express',
    countries: ['US','CA','AU','GB','DE','FR','NL','IT','ES','PL','SE','BE'],
  },

  // ── Manual / fallback ────────────────────────────────────────────────────────
  {
    code: 'OTHER', name: 'Other / Custom…',
    desc: 'Enter a product code manually',
    tier: 'custom',
    countries: [],
  },
];

// Backwards-compat alias — some internal helpers reference FOURPX_KNOWN_PRODUCTS
const FOURPX_KNOWN_PRODUCTS = FOURPX_PRODUCT_CATALOG;

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

// Reconcile the product catalog with the bundled route-engine catalog so an
// operator never sees a blank supplier for a product the engine already knows.
// Fills empty supplier/charm fields only — manual + Excel data always wins.
try {
  const rc = routeDashboard.reconcileProductMap(db, config);
  if (rc.ok && (rc.supplier_filled || rc.charm_filled)) {
    console.log(`[product-map] Reconciled from catalog: filled ${rc.supplier_filled} supplier + ${rc.charm_filled} charm field(s).`);
  }
} catch (err) {
  console.warn(`[product-map] Reconcile failed: ${err.message}`);
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

  // Build a map of shop_id → adspower_profile_id from the live config so the
  // frontend can decide which capture-session path to use per shop.
  const configShopMap = Object.fromEntries(
    getAllShops(config).map((s) => [s.shop_id, { adspower_profile_id: s.adspower_profile_id ?? null }])
  );

  const enriched = rows.map((r) => ({
    ...r,
    last_synced_at_iso: r.last_synced_at
      ? new Date(r.last_synced_at * 1000).toISOString()
      : null,
    token_status: tokenMap[r.shop_id]?.status ?? 'unknown',
    refresh_token_days_remaining: tokenMap[r.shop_id]?.refresh_token_days_remaining ?? null,
    adspower_profile_id: configShopMap[r.shop_id]?.adspower_profile_id ?? null,
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
  } else if (req.query.shipped === 'needs_purchase') {
    // Orders the operator has flagged as "still out of stock — needs purchase".
    // These are typically Pre-transit (a label was created to meet the Etsy ship-by
    // deadline, but the physical product still has to be bought). Show them regardless
    // of carrier/ship state so nothing flagged ever falls out of the purchasing queue.
    conditions.push(`r.needs_purchase_at IS NOT NULL
      AND r.status NOT IN ('Canceled', 'Cancelled', 'Fully Refunded', 'Fully refunded')`);
  }

  // ── Packaged filter ──────────────────────────────────────────────────────────
  // Operator-set flag indicating the parcel has been physically packed and is
  // ready for carrier pickup. Orthogonal to the shipped/pre-transit filter so
  // it can be combined with any view (most useful with shipped=pre_transit).
  //   packaged=true  → only orders with packaged_at IS NOT NULL
  //   packaged=false → only orders with packaged_at IS NULL (not yet packed)
  //   (omit)         → all orders regardless of packaged state
  if (req.query.packaged === 'true') {
    conditions.push('r.packaged_at IS NOT NULL');
  } else if (req.query.packaged === 'false') {
    conditions.push('r.packaged_at IS NULL');
  }

  // ── Archived orders ─────────────────────────────────────────────────────────
  // Operators archive orders that are stuck in "Pre-transit" forever (typically a
  // wrong tracking number was entered, so the carrier never scans it). Archived
  // orders are hidden from EVERY operational view and surface only in their own
  // dedicated "Archived" view (shipped=archived), or when a caller explicitly opts
  // in via include_archived=true (used by exports / audits).
  if (req.query.shipped === 'archived') {
    conditions.push('r.archived_at IS NOT NULL');
  } else if (req.query.include_archived !== 'true') {
    conditions.push('r.archived_at IS NULL');
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
      r.archived_at,
      r.archive_reason,
      r.needs_purchase_at,
      r.needs_purchase_note,
      r.packaged_at,
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

  // Per-line purchase state for the page's receipts, so the Orders tab can show a
  // purchasing control per product — and, when a product is a Case/Grip/Charm style,
  // per COMPONENT (e.g. case bought, grip still to buy). The COMPONENT statuses live in
  // route_assignments (the SAME table the Route tab edits), so the two tabs stay in
  // perfect sync. For products with no recognised components we fall back to the binary
  // receipt_item_purchase flag.
  const purchaseByReceipt = {};   // receipt_id → item_key → needs_purchase (0/1)  (no-component lines)
  const raByReceipt = {};         // receipt_id → item_key → { status_case, status_grip, status_charm }
  if (rows.length > 0) {
    const ridList = rows.map((r) => r.receipt_id);
    const ph = ridList.map(() => '?').join(',');
    db.prepare(`SELECT receipt_id, item_key, needs_purchase FROM receipt_item_purchase WHERE receipt_id IN (${ph})`)
      .all(ridList)
      .forEach((row) => {
        (purchaseByReceipt[row.receipt_id] ||= {})[row.item_key] = row.needs_purchase;
      });
    db.prepare(`SELECT receipt_id, item_key, status_case, status_grip, status_charm FROM route_assignments WHERE receipt_id IN (${ph})`)
      .all(ridList)
      .forEach((row) => {
        (raByReceipt[row.receipt_id] ||= {})[row.item_key] = row;
      });
  }
  const PURCHASE_OUTSTANDING = new Set(['Pending', 'Out of Stock']);

  const enriched = rows.map((r) => {
    let transactions = [];
    try { transactions = JSON.parse(r.all_transactions || '[]'); } catch {}
    const itemStates = purchaseByReceipt[r.receipt_id] || {};
    const raStates = raByReceipt[r.receipt_id] || {};
    const hasItemRows = Object.keys(itemStates).length > 0;
    // Inject cached image URL + per-line purchase state into each transaction:
    //   • components[]   — present Case/Grip/Charm with their current status (from
    //                      route_assignments; default 'Pending'). Shown as per-component
    //                      chips so the operator can mark case bought / grip still to buy.
    //   • needs_purchase — binary fallback for products with NO components.
    //   • line_outstanding — true while this line still has something to buy.
    const transactionsWithImages = transactions.map((t) => {
      const itemKey = routeDashboard.lineItemKey(t.title || '', t.listing_id);
      const { style } = routeDashboard.parseVariations(t.variations);
      const sc = routeDashboard.styleComponents(style);
      const a = raStates[itemKey] || {};
      const components = [];
      if (sc.hasCase)  components.push({ comp: 'case',  label: 'Case',  status: a.status_case  || 'Pending' });
      if (sc.hasGrip)  components.push({ comp: 'grip',  label: 'Grip',  status: a.status_grip  || 'Pending' });
      if (sc.hasCharm) components.push({ comp: 'charm', label: 'Charm', status: a.status_charm || 'Pending' });

      const raw = itemStates[itemKey];
      const needsPurchase = raw != null ? raw === 1 : (!hasItemRows && r.needs_purchase_at ? true : false);
      const purchased = raw === 0;
      const lineOutstanding = components.length
        ? components.some((c) => PURCHASE_OUTSTANDING.has(c.status))
        : needsPurchase;

      return {
        ...t,
        image_url: imageMap[t.listing_id] ?? null,
        item_key: itemKey,
        components,
        needs_purchase: needsPurchase,
        purchased,
        line_outstanding: lineOutstanding,
      };
    });
    const needsPurchaseItems = transactionsWithImages.filter((t) => t.line_outstanding).length;

    return {
      ...r,
      transactions: transactionsWithImages,
      needs_purchase_items: needsPurchaseItems,
      purchasable_items: transactionsWithImages.length,
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

  // ── Near-duplicate COLLAPSING ─────────────────────────────────────────────
  // Etsy occasionally issues two distinct receipt_ids for what is effectively
  // the same order: a buyer double-taps "Buy Now", or Etsy's payment pipeline
  // fires twice and both receipts survive.  The secondary receipt often
  // arrives with an incomplete payload (missing expected_ship_date) because
  // Etsy computes ship-by asynchronously and the duplicate races ahead of that
  // computation — that is exactly why the extra row showed up without a ship
  // date.
  //
  // We COLLAPSE such near-duplicates down to a single authoritative row so the
  // operator never sees the same order twice.  Detection key:
  //   shop_id + buyer (user_id, else name+zip) + product (listing_id, else title)
  // Receipts collapse when they share that key AND fall inside a chain of
  // creations each within DEDUP_WINDOW_SEC of the previous one.
  //
  // The surviving "primary" is the most complete receipt (ship-by present),
  // ties broken by the higher receipt_id (Etsy's latest = most authoritative).
  // The hidden receipt_ids are recorded on the survivor (duplicate_receipt_ids)
  // purely for audit/debugging — no second row is ever rendered.
  const DEDUP_WINDOW_SEC = 300; // 5-minute window between consecutive creations
  const dedupGroups = new Map();
  for (const o of enriched) {
    const buyerKey = o.buyer_user_id
      ? `uid:${o.buyer_user_id}`
      : `name:${(o.buyer_name || '').trim().toLowerCase()}|zip:${(o.shipping_zip || '').trim()}`;
    // Use first_listing_id when available; fall back to normalised product title
    const productKey = o.first_listing_id
      ? `lid:${o.first_listing_id}`
      : `title:${(o.first_product_title || '').trim().toLowerCase().slice(0, 60)}`;
    const key = `${o.shop_id}|${buyerKey}|${productKey}`;

    if (!dedupGroups.has(key)) dedupGroups.set(key, []);
    dedupGroups.get(key).push(o);
  }

  // receipt_ids that lose to a more-complete sibling and must be hidden.
  const suppressedIds = new Set();

  // Pick the winning row for a time-clustered set of duplicates and mark the
  // rest for suppression.  Survivor = most complete (ship-by set), then highest id.
  const collapseCluster = (cluster) => {
    if (cluster.length < 2) return;
    let primary = cluster[0];
    for (const c of cluster) {
      const cScore = c.first_ship_by ? 2 : 0;
      const pScore = primary.first_ship_by ? 2 : 0;
      if (cScore > pScore || (cScore === pScore && c.receipt_id > primary.receipt_id)) {
        primary = c;
      }
    }
    primary.had_duplicate = true;
    primary.duplicate_receipt_ids = cluster
      .filter((c) => c.receipt_id !== primary.receipt_id)
      .map((c) => c.receipt_id);
    for (const c of cluster) {
      if (c.receipt_id !== primary.receipt_id) suppressedIds.add(c.receipt_id);
    }
  };

  for (const group of dedupGroups.values()) {
    if (group.length < 2) continue;

    // Sort by creation time, then chain receipts whose consecutive gap is
    // within the window into a single cluster (handles 2, 3, … duplicates).
    group.sort((a, b) => (a.etsy_created_at || 0) - (b.etsy_created_at || 0));
    let cluster = [group[0]];
    for (let i = 1; i < group.length; i++) {
      const gap = (group[i].etsy_created_at || 0) - (group[i - 1].etsy_created_at || 0);
      if (gap <= DEDUP_WINDOW_SEC) {
        cluster.push(group[i]);
      } else {
        collapseCluster(cluster);
        cluster = [group[i]];
      }
    }
    collapseCluster(cluster);
  }

  const deduped = enriched.filter((o) => !suppressedIds.has(o.receipt_id));
  // Keep the pager honest: every duplicate hidden on this page is one fewer
  // real order than the raw COUNT(*) reported.
  const adjustedTotal = Math.max(0, countRow.total - suppressedIds.size);

  res.json({
    total: adjustedTotal,
    limit,
    offset,
    pre_transit_days: config.pre_transit_days ?? 30,
    orders: deduped,
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

// ─── Archive / restore order ────────────────────────────────────────────────────
//
// Use case: an order is stuck showing "Pre-transit" indefinitely because the wrong
// tracking number was entered when completing it. The carrier never scans that bogus
// number, so carrier_confirmed_at never gets set and the order can never graduate to
// "In transit" automatically. Archiving lets the operator clear it out of the active
// Orders views (without cancelling the Etsy receipt) while keeping a full record.
//
// This is a purely local/operational flag — it is NOT pushed to Etsy. The Etsy
// receipt and its shipment are left exactly as-is.

/**
 * POST /api/orders/:receipt_id/archive
 * Body (optional): { reason: string }
 * Marks the order archived (hidden from active views). Idempotent.
 */
app.post('/api/orders/:receipt_id/archive', (req, res) => {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : null;
  const nowEpoch = Math.floor(Date.now() / 1000);
  const result = db.prepare(`
    UPDATE receipts SET
      -- Preserve the original archive timestamp if already archived (idempotent re-archive)
      archived_at    = COALESCE(archived_at, @archived_at),
      archive_reason = @archive_reason
    WHERE receipt_id = @receipt_id
  `).run({ receipt_id: req.params.receipt_id, archived_at: nowEpoch, archive_reason: reason || null });

  if (result.changes === 0) return res.status(404).json({ error: 'Order not found' });
  console.log(`[archive] receipt ${req.params.receipt_id} archived${reason ? ` — reason: ${reason}` : ''}`);
  res.json({ success: true, receipt_id: req.params.receipt_id, archived_at: nowEpoch, archive_reason: reason || null });
});

/**
 * POST /api/orders/:receipt_id/unarchive
 * Restores an archived order back into the active views and clears the reason.
 */
app.post('/api/orders/:receipt_id/unarchive', (req, res) => {
  const result = db.prepare(
    'UPDATE receipts SET archived_at = NULL, archive_reason = NULL WHERE receipt_id = ?'
  ).run(req.params.receipt_id);

  if (result.changes === 0) return res.status(404).json({ error: 'Order not found' });
  console.log(`[archive] receipt ${req.params.receipt_id} restored`);
  res.json({ success: true, receipt_id: req.params.receipt_id });
});

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
 * POST /api/orders/:receipt_id/mark-packaged
 * Marks the order as physically packaged and ready for carrier pickup. Idempotent —
 * the original timestamp is preserved if the flag is already set.
 */
app.post('/api/orders/:receipt_id/mark-packaged', (req, res) => {
  const nowEpoch = Math.floor(Date.now() / 1000);
  const result = db.prepare(`
    UPDATE receipts SET
      packaged_at = COALESCE(packaged_at, @packaged_at)
    WHERE receipt_id = @receipt_id
  `).run({ receipt_id: req.params.receipt_id, packaged_at: nowEpoch });

  if (result.changes === 0) return res.status(404).json({ error: 'Order not found' });
  console.log(`[packaged] receipt ${req.params.receipt_id} marked as packaged`);
  res.json({ success: true, receipt_id: req.params.receipt_id, packaged_at: nowEpoch });
});

/**
 * POST /api/orders/:receipt_id/unmark-packaged
 * Clears the packaged flag, returning the order to the "not yet packaged" state.
 */
app.post('/api/orders/:receipt_id/unmark-packaged', (req, res) => {
  const result = db.prepare(
    'UPDATE receipts SET packaged_at = NULL WHERE receipt_id = ?'
  ).run(req.params.receipt_id);

  if (result.changes === 0) return res.status(404).json({ error: 'Order not found' });
  console.log(`[packaged] receipt ${req.params.receipt_id} packaged flag cleared`);
  res.json({ success: true, receipt_id: req.params.receipt_id });
});

/**
 * POST /api/orders/bulk-mark-packaged
 * Body: { receipt_ids: number[], packaged: boolean }
 * Bulk set (packaged=true) or clear (packaged=false) the packaged_at flag.
 * Setting is idempotent — orders already flagged keep their original timestamp.
 */
app.post('/api/orders/bulk-mark-packaged', (req, res) => {
  const { receipt_ids, packaged } = req.body || {};
  if (!Array.isArray(receipt_ids) || receipt_ids.length === 0) {
    return res.status(400).json({ error: 'receipt_ids must be a non-empty array' });
  }
  const ids = receipt_ids.map(Number).filter((n) => Number.isFinite(n));
  if (ids.length === 0) return res.status(400).json({ error: 'No valid receipt IDs provided' });

  const nowEpoch = Math.floor(Date.now() / 1000);
  const ph = ids.map(() => '?').join(',');
  let changed;
  if (packaged) {
    changed = db.prepare(
      `UPDATE receipts SET packaged_at = COALESCE(packaged_at, ?) WHERE receipt_id IN (${ph})`
    ).run(nowEpoch, ...ids).changes;
  } else {
    changed = db.prepare(
      `UPDATE receipts SET packaged_at = NULL WHERE receipt_id IN (${ph})`
    ).run(...ids).changes;
  }
  console.log(`[packaged] bulk ${packaged ? 'mark' : 'unmark'} — ${changed} receipt(s) updated`);
  res.json({ success: true, changed });
});

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

const PURCHASE_OUTSTANDING_STATUSES = new Set(['Pending', 'Out of Stock']);
const VALID_PURCHASE_STATUSES = new Set(['Pending', 'Purchased', 'Out of Stock', 'Out of Production']);

/** Present Case/Grip/Charm components of a transaction (from its Style variation). */
function txComponents(t) {
  const { style } = routeDashboard.parseVariations(t.variations);
  const sc = routeDashboard.styleComponents(style);
  const out = [];
  if (sc.hasCase)  out.push('case');
  if (sc.hasGrip)  out.push('grip');
  if (sc.hasCharm) out.push('charm');
  return out;
}

/** Parse a receipt's line items into [{ item_key, title, components[] }] (deduped). */
function orderLineItems(receiptId) {
  const row = db.prepare('SELECT all_transactions FROM receipts WHERE receipt_id = ?').get(receiptId);
  if (!row) return null;
  let txs = [];
  try { txs = JSON.parse(row.all_transactions || '[]'); } catch { txs = []; }
  const seen = new Map();
  for (const t of txs) {
    const key = routeDashboard.lineItemKey(t.title || '', t.listing_id);
    if (!seen.has(key)) seen.set(key, { item_key: key, title: t.title || '', components: txComponents(t) });
  }
  return [...seen.values()];
}

/**
 * Whether an order still has ANY outstanding purchasing work, considering both
 * component statuses (route_assignments) and the no-component binary flag.
 */
function orderHasOutstanding(receiptId) {
  const items = orderLineItems(receiptId);
  if (!items || !items.length) return false;
  const ra = {};
  db.prepare('SELECT * FROM route_assignments WHERE receipt_id = ?').all(receiptId).forEach((x) => { ra[x.item_key] = x; });
  const rip = {};
  db.prepare('SELECT * FROM receipt_item_purchase WHERE receipt_id = ?').all(receiptId).forEach((x) => { rip[x.item_key] = x; });
  for (const it of items) {
    if (it.components.length) {
      const a = ra[it.item_key] || {};
      for (const c of it.components) {
        if (PURCHASE_OUTSTANDING_STATUSES.has(a[`status_${c}`] || 'Pending')) return true;
      }
    } else {
      const b = rip[it.item_key];
      if (b && b.needs_purchase === 1) return true;
    }
  }
  return false;
}

/**
 * Auto-manage the order rollup (receipts.needs_purchase_at) from current line/component
 * state. Cleared when nothing is outstanding; set for PRE-TRANSIT orders that still have
 * outstanding work (so they ride into the purchasing Route). Unshipped orders are never
 * auto-flagged (they are already in the Route by default).
 */
function recomputeNeedsPurchaseRollup(receiptId) {
  const r = db.prepare('SELECT is_shipped, carrier_confirmed_at, needs_purchase_at FROM receipts WHERE receipt_id = ?').get(receiptId);
  if (!r) return false;
  const outstanding = orderHasOutstanding(receiptId);
  const isPreTransit = r.is_shipped === 1 && !r.carrier_confirmed_at;
  if (!outstanding) {
    db.prepare('UPDATE receipts SET needs_purchase_at = NULL, needs_purchase_note = NULL WHERE receipt_id = ?').run(receiptId);
  } else if (isPreTransit && !r.needs_purchase_at) {
    db.prepare('UPDATE receipts SET needs_purchase_at = ? WHERE receipt_id = ?').run(Math.floor(Date.now() / 1000), receiptId);
  }
  return outstanding;
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
`);

/** Write one no-component line-item's binary purchase state. */
function setItemPurchaseState(receiptId, itemKey, title, needsPurchase, note) {
  const nowEpoch = Math.floor(Date.now() / 1000);
  _ripUpsert.run({
    receipt_id: receiptId,
    item_key: itemKey,
    title: title ?? null,
    needs_purchase: needsPurchase ? 1 : 0,
    note: note ?? null,
    flagged_at: needsPurchase ? nowEpoch : null,
    purchased_at: needsPurchase ? null : nowEpoch,
    updated_at: nowEpoch,
  });
}

/** Mark every present component of every line as 'Purchased' (used by "mark all purchased"). */
function setAllComponentsPurchased(receiptId) {
  const items = orderLineItems(receiptId) || [];
  for (const it of items) {
    if (!it.components.length) continue;
    const patch = { receipt_id: Number(receiptId), item_key: it.item_key, title: it.title };
    for (const c of it.components) patch[`status_${c}`] = 'Purchased';
    upsertRouteAssignment(db, patch);
  }
}

/**
 * POST /api/orders/:receipt_id/needs-purchase
 * Body (optional): { note }
 * Flags the WHOLE order into the purchasing queue / Route. Products with no components
 * are marked needing purchase; component products default to Pending (= to buy).
 */
app.post('/api/orders/:receipt_id/needs-purchase', (req, res) => {
  const receiptId = req.params.receipt_id;
  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : null;
  const items = orderLineItems(receiptId);
  if (items === null) return res.status(404).json({ error: 'Order not found' });

  const txn = db.transaction(() => {
    for (const it of items) if (!it.components.length) setItemPurchaseState(receiptId, it.item_key, it.title, true, null);
    db.prepare(
      'UPDATE receipts SET needs_purchase_at = COALESCE(needs_purchase_at, ?), needs_purchase_note = COALESCE(?, needs_purchase_note) WHERE receipt_id = ?'
    ).run(Math.floor(Date.now() / 1000), note, receiptId);
  });
  txn();

  console.log(`[needs-purchase] receipt ${receiptId} flagged (${items.length} line item${items.length !== 1 ? 's' : ''})${note ? ` — note: ${note}` : ''}`);
  res.json({ success: true, receipt_id: receiptId, items: items.length });
});

/**
 * POST /api/orders/:receipt_id/clear-needs-purchase
 * Marks the WHOLE order purchased — every component → Purchased, every binary line
 * cleared, and the order flag removed.
 */
app.post('/api/orders/:receipt_id/clear-needs-purchase', (req, res) => {
  const receiptId = req.params.receipt_id;
  const exists = db.prepare('SELECT 1 FROM receipts WHERE receipt_id = ?').get(receiptId);
  if (!exists) return res.status(404).json({ error: 'Order not found' });

  const txn = db.transaction(() => {
    const nowEpoch = Math.floor(Date.now() / 1000);
    db.prepare(
      'UPDATE receipt_item_purchase SET needs_purchase = 0, purchased_at = ?, updated_at = ? WHERE receipt_id = ? AND needs_purchase = 1'
    ).run(nowEpoch, nowEpoch, receiptId);
    setAllComponentsPurchased(receiptId);
    db.prepare('UPDATE receipts SET needs_purchase_at = NULL, needs_purchase_note = NULL WHERE receipt_id = ?').run(receiptId);
  });
  txn();

  console.log(`[needs-purchase] receipt ${receiptId} cleared (all components/lines purchased)`);
  res.json({ success: true, receipt_id: receiptId });
});

/**
 * POST /api/orders/:receipt_id/items/component-status
 * Body: { item_key, title?, component: 'case'|'grip'|'charm', status }
 * Sets ONE component's purchase status (writes route_assignments — the same data the
 * Route tab uses, so the change shows there automatically) and re-rolls the order flag.
 * This is what lets the case be bought while the grip is still to buy.
 */
app.post('/api/orders/:receipt_id/items/component-status', (req, res) => {
  const receiptId = Number(req.params.receipt_id);
  const { item_key: itemKey, title = null, component, status } = req.body || {};
  const comp = String(component || '').toLowerCase();
  if (!itemKey || !['case', 'grip', 'charm'].includes(comp)) {
    return res.status(400).json({ error: 'item_key and a valid component (case|grip|charm) are required' });
  }
  if (!VALID_PURCHASE_STATUSES.has(status)) {
    return res.status(400).json({ error: 'invalid status' });
  }
  const exists = db.prepare('SELECT 1 FROM receipts WHERE receipt_id = ?').get(receiptId);
  if (!exists) return res.status(404).json({ error: 'Order not found' });

  let outstanding;
  const txn = db.transaction(() => {
    const patch = { receipt_id: receiptId, item_key: String(itemKey), title };
    patch[`status_${comp}`] = status;
    upsertRouteAssignment(db, patch);
    outstanding = recomputeNeedsPurchaseRollup(receiptId);
  });
  txn();

  console.log(`[needs-purchase] receipt ${receiptId} item ${itemKey} ${comp} → ${status} (outstanding: ${outstanding})`);
  res.json({ success: true, receipt_id: receiptId, item_key: itemKey, component: comp, status, outstanding });
});

/**
 * POST /api/orders/:receipt_id/items/purchase-state
 * Body: { item_key, title?, needs_purchase: boolean, note? }
 * Binary purchase toggle for a product with NO recognised components.
 */
app.post('/api/orders/:receipt_id/items/purchase-state', (req, res) => {
  const receiptId = req.params.receipt_id;
  const { item_key: itemKey, title = null, needs_purchase: needsPurchase } = req.body || {};
  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : null;
  if (!itemKey) return res.status(400).json({ error: 'item_key is required' });

  const exists = db.prepare('SELECT 1 FROM receipts WHERE receipt_id = ?').get(receiptId);
  if (!exists) return res.status(404).json({ error: 'Order not found' });

  let outstanding;
  const txn = db.transaction(() => {
    setItemPurchaseState(receiptId, itemKey, title, !!needsPurchase, note);
    outstanding = recomputeNeedsPurchaseRollup(receiptId);
  });
  txn();

  console.log(`[needs-purchase] receipt ${receiptId} item ${itemKey} → ${needsPurchase ? 'needs purchase' : 'purchased'} (outstanding: ${outstanding})`);
  res.json({ success: true, receipt_id: receiptId, item_key: itemKey, needs_purchase: !!needsPurchase, outstanding });
});

/**
 * POST /api/orders/bulk-needs-purchase
 * Body: { receipt_ids: number[], flag: boolean, note?: string }
 * Flags or clears whole orders in one transaction.
 */
app.post('/api/orders/bulk-needs-purchase', (req, res) => {
  const ids = Array.isArray(req.body?.receipt_ids) ? req.body.receipt_ids.map((x) => String(x).trim()).filter(Boolean) : [];
  const flag = req.body?.flag !== false; // default true
  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : null;
  if (!ids.length) return res.status(400).json({ error: 'receipt_ids is required' });

  let changed = 0;
  const txn = db.transaction((list) => {
    for (const id of list) {
      const items = orderLineItems(id);
      if (items === null) continue;
      if (flag) {
        for (const it of items) if (!it.components.length) setItemPurchaseState(id, it.item_key, it.title, true, null);
        db.prepare(
          'UPDATE receipts SET needs_purchase_at = COALESCE(needs_purchase_at, ?), needs_purchase_note = COALESCE(?, needs_purchase_note) WHERE receipt_id = ?'
        ).run(Math.floor(Date.now() / 1000), note, id);
      } else {
        const nowEpoch = Math.floor(Date.now() / 1000);
        db.prepare(
          'UPDATE receipt_item_purchase SET needs_purchase = 0, purchased_at = ?, updated_at = ? WHERE receipt_id = ? AND needs_purchase = 1'
        ).run(nowEpoch, nowEpoch, id);
        setAllComponentsPurchased(id);
        db.prepare('UPDATE receipts SET needs_purchase_at = NULL, needs_purchase_note = NULL WHERE receipt_id = ?').run(id);
      }
      changed++;
    }
  });
  txn(ids);

  console.log(`[needs-purchase] bulk ${flag ? 'flagged' : 'cleared'} ${changed}/${ids.length} orders`);
  res.json({ success: true, flag, changed, requested: ids.length });
});

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
 * @returns {Promise<object>}  The Etsy createReceiptShipment result.
 * @throws  {Error}  err.status carries an HTTP-friendly status when known.
 */
async function shipEtsyReceipt(receiptId, opts = {}) {
  const tracking = (opts.tracking_code || '').trim();
  const carrier  = (opts.carrier_name || '4PX').trim();
  if (!tracking) {
    const e = new Error('tracking_code is required'); e.status = 400; throw e;
  }

  // 1. Resolve which shop this receipt belongs to (receipts store shop_id).
  const order = db.prepare('SELECT shop_id FROM receipts WHERE receipt_id = ?').get(receiptId);
  if (!order) { const e = new Error('Order not found'); e.status = 404; throw e; }

  // 2. Find shop + group config by shop_id.
  let shopCfg, groupCfg;
  for (const grp of config.groups) {
    const s = grp.shops.find(sh => sh.shop_id === order.shop_id);
    if (s) { shopCfg = s; groupCfg = grp; break; }
  }
  if (!shopCfg) { const e = new Error(`No config found for shop ${order.shop_id}`); e.status = 500; throw e; }

  // 3. Fresh access token (same flow as the sync worker).
  const proxyClient = createGroupProxyClient(groupCfg, config.vpn_local_port);
  const accessToken = await tokenManager.getAccessToken(
    shopCfg.shop_id,
    shopCfg.api_key,
    shopCfg.refresh_token ?? null,
    proxyClient,
  );

  // 4. Authenticated client + numeric shop ID.
  const shopClient    = buildShopClient(proxyClient, shopCfg.api_key, shopCfg.shared_secret, accessToken);
  const numericShopId = await resolveShopId(shopClient, shopCfg.shop_id);

  // 5. Create the shipment on Etsy (marks shipped + notifies the buyer).
  const result = await createReceiptShipment(shopClient, numericShopId, receiptId, {
    tracking_code: tracking,
    carrier_name:  carrier,
    note_to_buyer: (opts.note_to_buyer || '').trim() || undefined,
    send_bcc:      opts.send_bcc ?? false,
  });

  // 6. Mirror the change locally so the UI updates without waiting for the next sync.
  db.prepare(
    "UPDATE receipts SET is_shipped = 1, tracking_code = ?, carrier_name = ?, status = 'Completed' WHERE receipt_id = ?"
  ).run(tracking, carrier, receiptId);

  console.log(`[ship] ${order.shop_id} receipt ${receiptId} marked shipped — tracking: ${tracking}`);
  return result;
}

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
    const result = await shipEtsyReceipt(receipt_id, { tracking_code, carrier_name, note_to_buyer });
    res.json({ success: true, receipt_id, tracking_code: tracking_code.trim(), shipment: result });
  } catch (err) {
    const etsyBody = err.response?.data;
    const errMsg   = (typeof etsyBody === 'object' ? (etsyBody?.error_description || etsyBody?.error) : null) || err.message;
    console.error(`[ship] Error shipping receipt ${receipt_id}:`, errMsg, err.stack?.split('\n')[0]);
    res.status(err.status || err.response?.status || 500).json({ error: errMsg });
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
    // EU IOSS: whether a number is configured + the destinations it applies to,
    // so the bulk wizard can reassure the operator that EU customs is handled.
    iossConfigured:  !!config.fourpx_ioss_no,
    iossCountries:   [...FOURPX_IOSS_COUNTRIES],
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
      return res.json({ products: cached.products, source: cached.source,
                        country: cached.country, cached: true });
    }

    let products = [];
    let source   = 'api';

    try {
      products = await getLogisticsProducts(appKey, appSecret, { countryCode: country || undefined });
    } catch {
      products = [];
    }

    // Direct-customer API keys cannot access ds.xms.logistics_product.getlist
    // (error 000024). Fall back to the curated catalogue with country filtering.
    if (!products.length) {
      source = 'fallback';

      // Filter catalogue entries relevant to this destination country.
      // products with countries:[] are global (available everywhere).
      const filtered = FOURPX_PRODUCT_CATALOG.filter(p =>
        !country || p.countries.length === 0 || p.countries.includes(country)
      );

      // Sort: (1) country-specific first, (2) then global, (3) custom last
      const tierOrder = { economy: 0, standard: 1, express: 2, premium: 3, custom: 99 };
      filtered.sort((a, b) => {
        const aSpec = a.countries.length > 0 ? 0 : 1;
        const bSpec = b.countries.length > 0 ? 0 : 1;
        if (aSpec !== bSpec) return aSpec - bSpec;
        return (tierOrder[a.tier] ?? 99) - (tierOrder[b.tier] ?? 99);
      });

      products = filtered.map(p => ({
        logistics_product_code: p.code,
        logistics_product_name: p.name,
        description:            p.desc,
        tier:                   p.tier,
        // Expose country scope so the frontend can show contextual info
        country_specific:       p.countries.length > 0,
      }));
    } else {
      // Live API response — normalise to the shape the frontend expects.
      // The getlist API returns logistics_product_name_en / _cn (not _name),
      // plus transport_mode_label which we map to a display tier for grouping.
      const MODE_TIER = { express: 'express', priority: 'standard', postal: 'economy', cod: 'custom' };
      const hasCjk = (s) => /[\u4e00-\u9fff]/.test(s || '');
      products = products.map(p => {
        const nameEn = p.logistics_product_name_en || p.logistics_product_name || '';
        const nameCn = p.logistics_product_name_cn || '';
        // Prefer a genuine English name. When 4PX only has a Chinese name (very
        // common for internal product lines), show the product code instead so
        // the English-language UI stays readable; keep the Chinese as a subtitle.
        const displayName = (!nameEn || hasCjk(nameEn)) ? p.logistics_product_code : nameEn;
        return {
          logistics_product_code: p.logistics_product_code,
          logistics_product_name: displayName,
          name_cn:                nameCn || undefined,
          description:            hasCjk(nameCn) && nameCn !== displayName ? nameCn : undefined,
          tier:                   MODE_TIER[p.transport_mode_label] ?? 'standard',
          transport_mode:         p.transport_mode,
          trackable:              p.order_track === 'Y',
          country_specific:       !!country,
        };
      });
      // Stable, useful ordering: trackable first, then by code.
      products.sort((a, b) => (Number(b.trackable) - Number(a.trackable)) ||
                              String(a.logistics_product_code).localeCompare(String(b.logistics_product_code)));
    }

    _fpxProductsCache.set(cacheKey, { products, source, country, expiresAt: Date.now() + 30 * 60 * 1000 });
    res.json({ products, source, country, cached: false });
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
async function create4pxShipmentForReceipt({ appKey, appSecret, receipt_id, recipient, parcel, logistics_product_code, duty_type = 'U' }) {
  if (!receipt_id)               { const e = new Error('receipt_id is required'); e.status = 400; throw e; }
  if (!recipient)                { const e = new Error('recipient is required'); e.status = 400; throw e; }
  if (!parcel)                   { const e = new Error('parcel is required'); e.status = 400; throw e; }
  if (!logistics_product_code)   { const e = new Error('logistics_product_code is required'); e.status = 400; throw e; }
  if (!parcel.weight_g || parcel.weight_g <= 0) {
    const e = new Error('parcel.weight_g must be a positive number (grams)'); e.status = 400; throw e;
  }
  if (!parcel.items?.length) {
    const e = new Error('parcel.items is required for customs declaration'); e.status = 400; throw e;
  }

  // Idempotency: never create a second 4PX order for the same receipt.
  const order = db.prepare(
    'SELECT receipt_id, shop_id, fourpx_consignment_no, fourpx_tracking_no FROM receipts WHERE receipt_id = ?'
  ).get(receipt_id);
  if (!order) { const e = new Error(`Receipt ${receipt_id} not found`); e.status = 404; throw e; }
  if (order.fourpx_consignment_no) {
    const e = new Error(`A 4PX shipment was already created for receipt ${receipt_id}.`);
    e.status = 409;
    e.consignment_no = order.fourpx_consignment_no;
    e.trackingNo     = order.fourpx_tracking_no;
    throw e;
  }

  // EU IOSS / VAT compliance: for EU27 destinations (declared value ≤ €150,
  // always true here), 4PX requires the IOSS number on `ioss_no` so the parcel
  // clears customs as VAT-prepaid. vat_no / eori_no are attached when configured.
  const destCountry = (recipient?.country || '').toUpperCase();
  const isEuDestination = FOURPX_IOSS_COUNTRIES.has(destCountry);
  const euCompliance = isEuDestination ? {
    ...(config.fourpx_ioss_no && { ioss_no: config.fourpx_ioss_no }),
    ...(config.fourpx_vat_no  && { vat_no:  config.fourpx_vat_no  }),
    ...(config.fourpx_eori_no && { eori_no: config.fourpx_eori_no }),
  } : {};

  if (isEuDestination && !config.fourpx_ioss_no) {
    console.warn(
      `[4px] receipt ${receipt_id} ships to EU country ${destCountry} but fourpx_ioss_no ` +
      `is not set in config.json — 4PX may reject the order (IOSS号 required).`
    );
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
    ...euCompliance,
  });

  // Persist immediately — tracking number is now available even before label fetch.
  upsertFourpxShipment(db, receipt_id, {
    consignmentNo: result.dsConsignmentNo,
    trackingNo:    result.trackingNo,
    status:        'created',
  });

  // Mirror into the main tracking_code field so pre-transit detection picks it up.
  if (result.trackingNo) {
    db.prepare(
      'UPDATE receipts SET tracking_code = ?, carrier_name = ? WHERE receipt_id = ? AND tracking_code IS NULL'
    ).run(result.trackingNo, '4PX', receipt_id);
  }

  console.log(
    `[4px] Created shipment for receipt ${receipt_id} — ` +
    `tracking: ${result.trackingNo}, consignment: ${result.dsConsignmentNo}`
  );
  return result;
}

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

    const result = await create4pxShipmentForReceipt({
      appKey, appSecret, receipt_id, recipient, parcel, logistics_product_code, duty_type,
    });

    res.json({ success: true, receipt_id, ...result });

  } catch (err) {
    // Log the full API response body when available — crucial for diagnosing
    // 4PX business errors (codes, messages) that don't surface in err.message alone.
    if (err.apiBody) {
      console.error('[4px] POST /api/4px/create-order API body:', JSON.stringify(err.apiBody));
    }
    console.error('[4px] POST /api/4px/create-order:', err.message, err.code ? `(code: ${err.code})` : '');
    res.status(err.status || 500).json({
      error: err.message,
      code:  err.code,
      ...(err.consignment_no && { consignment_no: err.consignment_no }),
      ...(err.apiBody && { api_response: err.apiBody }),
    });
  }
});

// Filesystem-safe label filenames (named by buyer) + case-insensitive
// de-duplication live in ../fourpx/orders as pure, unit-tested helpers
// (safeLabelBaseName / assignUniqueLabelNames). A thin alias keeps the existing
// single-label call sites readable.
const safe4pxLabelBaseName = safeLabelBaseName;

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
  const row = db.prepare(
    'SELECT fourpx_consignment_no, fourpx_tracking_no, fourpx_label_url, name AS buyer_name FROM receipts WHERE receipt_id = ?'
  ).get(receiptId);

  if (!row) { const e = new Error('Receipt not found'); e.status = 404; throw e; }
  if (!row.fourpx_consignment_no && !row.fourpx_tracking_no) {
    const e = new Error('No 4PX order exists for this receipt'); e.status = 404; throw e;
  }

  let labelUrl = row.fourpx_label_url;
  if (!labelUrl) {
    // ds.xms.label.get resolves by the 4PX tracking number (4px_tracking_no);
    // the ds_consignment_no (DS… prefix) returns "Can not find this order".
    const requestNo = row.fourpx_tracking_no || row.fourpx_consignment_no;
    const label = await getShipLabel(appKey, appSecret, requestNo, { format: 'PDF' });
    labelUrl = label.logisticsLabel ?? label.customLabel ?? null;
    if (labelUrl) {
      upsertFourpxShipment(db, receiptId, {
        consignmentNo: row.fourpx_consignment_no,
        labelUrl,
        status: 'label_fetched',
      });
    }
  }

  return {
    labelUrl,
    buyerName:     row.buyer_name || '',
    trackingNo:    row.fourpx_tracking_no,
    consignmentNo: row.fourpx_consignment_no,
  };
}

/**
 * Fetch the bytes of a (possibly plain-HTTP) 4PX label URL into a Buffer.
 * Used by the bulk ZIP builder, which needs the bytes in memory to append.
 *
 * @param {string} labelUrl
 * @param {number} [timeoutMs=25000]
 * @returns {Promise<Buffer>}
 */
function fetch4pxLabelBuffer(labelUrl, timeoutMs = 25_000) {
  return new Promise((resolve, reject) => {
    const lib = labelUrl.startsWith('https') ? require('https') : require('http');
    const req = lib.get(labelUrl, (up) => {
      if (up.statusCode !== 200) {
        up.resume();
        return reject(new Error(`label server returned ${up.statusCode}`));
      }
      const chunks = [];
      up.on('data', (c) => chunks.push(c));
      up.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', (e) => reject(e));
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`label download timed out after ${timeoutMs}ms`)));
  });
}

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
      'SELECT fourpx_consignment_no, fourpx_tracking_no, fourpx_label_url FROM receipts WHERE receipt_id = ?'
    ).get(receipt_id);

    if (!row) return res.status(404).json({ error: 'Receipt not found' });
    if (!row.fourpx_consignment_no && !row.fourpx_tracking_no) {
      return res.status(404).json({ error: 'No 4PX order exists for this receipt' });
    }

    // Return cached label if we have one (label URLs are long-lived at 4PX)
    if (row.fourpx_label_url) {
      return res.json({ success: true, labelUrl: row.fourpx_label_url, cached: true });
    }

    // ds.xms.label.get resolves by the 4PX tracking number (4px_tracking_no).
    // The ds_consignment_no (DS… prefix) returns "Can not find this order".
    const requestNo = row.fourpx_tracking_no || row.fourpx_consignment_no;
    const label = await getShipLabel(appKey, appSecret, requestNo, { format });
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
 * GET /api/4px/label-download/:receipt_id
 * Proxy-download the shipping label PDF so the browser shows a native
 * "Save As" dialog.  The 4PX label URL is plain HTTP and is cross-origin,
 * so the browser's <a download> attribute is ignored when pointing at it
 * directly.  This endpoint fetches the bytes server-side and re-serves them
 * with Content-Disposition: attachment plus a human-readable filename.
 */
app.get('/api/4px/label-download/:receipt_id', async (req, res) => {
  try {
    const { receipt_id } = req.params;
    const { appKey, appSecret } = get4pxCredentials();

    const { labelUrl, buyerName, trackingNo, consignmentNo } =
      await resolve4pxLabelUrl(receipt_id, { appKey, appSecret });

    if (!labelUrl) {
      return res.status(404).json({ error: 'Label not yet available — please try again in a few seconds.' });
    }

    // Filename = buyer name only: "Julie Zaring.pdf"
    const filename = `${safe4pxLabelBaseName(buyerName, trackingNo || consignmentNo)}.pdf`;

    // Proxy the PDF from 4PX (may be plain HTTP, so must happen server-side)
    const fetchFn  = labelUrl.startsWith('https') ? require('https') : require('http');
    const proxyReq = fetchFn.get(labelUrl, (upstream) => {
      if (upstream.statusCode !== 200) {
        res.status(502).json({ error: `4PX label server returned ${upstream.statusCode}` });
        upstream.resume();
        return;
      }
      res.setHeader('Content-Type', upstream.headers['content-type'] || 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
      if (upstream.headers['content-length']) {
        res.setHeader('Content-Length', upstream.headers['content-length']);
      }
      // Stream directly — no buffering
      upstream.pipe(res);
    });
    proxyReq.on('error', (err) => {
      if (!res.headersSent) res.status(502).json({ error: `Failed to fetch label: ${err.message}` });
    });
    req.on('close', () => proxyReq.destroy());

  } catch (err) {
    console.error('[4px] GET /api/4px/label-download:', err.message);
    if (!res.headersSent) res.status(err.status || 500).json({ error: err.message });
  }
});

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
  const results = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length || 1)).fill(0).map(async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await mapper(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
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
    const { appKey, appSecret } = get4pxCredentials();
    if (!config.fourpx_sender) {
      return res.status(501).json({
        error: 'fourpx_sender is not configured in config.json. ' +
               'Add sender address details to enable shipping order creation.',
      });
    }

    const orders = Array.isArray(req.body?.orders) ? req.body.orders : [];
    if (!orders.length) return res.status(400).json({ error: 'orders[] is required and must be non-empty' });
    if (orders.length > 200) return res.status(400).json({ error: 'A maximum of 200 orders can be created per batch' });

    const batchProduct = req.body.logistics_product_code;
    const batchDuty    = req.body.duty_type || 'U';

    const results = await runWithConcurrency(orders, 4, async (o) => {
      const receiptId = o.receipt_id;
      try {
        const result = await create4pxShipmentForReceipt({
          appKey, appSecret,
          receipt_id:             receiptId,
          recipient:              o.recipient,
          parcel:                 o.parcel,
          logistics_product_code: o.logistics_product_code || batchProduct,
          duty_type:              o.duty_type || batchDuty,
        });
        return {
          receipt_id:      receiptId,
          success:         true,
          trackingNo:      result.trackingNo,
          dsConsignmentNo: result.dsConsignmentNo,
          odaResultSign:   result.odaResultSign,
        };
      } catch (err) {
        if (err.apiBody) {
          console.error(`[4px/bulk] create receipt ${receiptId} API body:`, JSON.stringify(err.apiBody));
        }
        console.error(`[4px/bulk] create receipt ${receiptId} failed:`, err.message, err.code ? `(${err.code})` : '');
        return {
          receipt_id:      receiptId,
          success:         false,
          already_exists:  err.status === 409,
          // For an already-existing order, surface its tracking so the UI can
          // still complete + label it instead of treating it as a hard failure.
          trackingNo:      err.trackingNo || null,
          dsConsignmentNo: err.consignment_no || null,
          error:           err.message,
          code:            err.code || null,
        };
      }
    });

    const created  = results.filter(r => r.success).length;
    const existing = results.filter(r => r.already_exists).length;
    const failed   = results.length - created - existing;
    console.log(`[4px/bulk] create batch: ${created} created, ${existing} already existed, ${failed} failed (of ${results.length})`);

    res.json({ success: failed === 0, total: results.length, created, existing, failed, results });
  } catch (err) {
    console.error('[4px] POST /api/4px/bulk-create-order:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

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
    const { appKey, appSecret } = get4pxCredentials();
    const ids = String(req.query.receipt_ids || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: 'receipt_ids query param is required (comma-separated)' });
    if (ids.length > 200) return res.status(400).json({ error: 'A maximum of 200 labels can be downloaded per ZIP' });

    // Resolve every label URL first (bounded concurrency), so we can fail fast
    // with a JSON error before we start streaming the ZIP body.
    const resolved = await runWithConcurrency(ids, 5, async (receiptId) => {
      try {
        const r = await resolve4pxLabelUrl(receiptId, { appKey, appSecret });
        return { receiptId, ...r };
      } catch (err) {
        return { receiptId, labelUrl: null, buyerName: '', error: err.message };
      }
    });

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition',
      `attachment; filename="4PX-Labels-${stamp}.zip"; filename*=UTF-8''4PX-Labels-${stamp}.zip`);

    const { ZipArchive } = await import('archiver');
    const archive = new ZipArchive({ zlib: { level: 6 } });
    archive.on('error', (e) => {
      console.error('[4px/bulk] zip error:', e.message);
      if (!res.headersSent) res.status(500).json({ error: e.message });
      else res.destroy(e);
    });
    res.on('close', () => { if (!res.writableFinished) archive.abort(); });
    archive.pipe(res);

    // Pre-assign one UNIQUE, buyer-named filename per deliverable label up front
    // (case-insensitive dedup so no label is overwritten on Windows/macOS), so
    // each label lands in the ZIP as its own independent file that corresponds
    // to exactly the right buyer.
    const deliverable = resolved.filter((item) => item.labelUrl);
    const nameByReceipt = assignUniqueLabelNames(deliverable);

    const failures = [];
    let added = 0;

    for (const item of resolved) {
      if (!item.labelUrl) {
        failures.push(`receipt ${item.receiptId}: ${item.error || 'label not available yet'}`);
        continue;
      }
      const name = nameByReceipt.get(item.receiptId);
      try {
        const buf = await fetch4pxLabelBuffer(item.labelUrl);
        archive.append(buf, { name });
        added++;
      } catch (err) {
        failures.push(`receipt ${item.receiptId} (${name.replace(/\.pdf$/i, '')}): ${err.message}`);
      }
    }

    if (failures.length) {
      archive.append(
        ['Some labels could not be included in this archive:', '', ...failures,
         '', 'Tip: 4PX may need a few seconds after order creation to generate a label.',
         'Re-run the download once the labels show "ready".'].join('\n'),
        { name: '_label_errors.txt' }
      );
    }
    if (added === 0 && !failures.length) {
      archive.append('No labels were available to download.', { name: 'README.txt' });
    }

    console.log(`[4px/bulk] labels zip: ${added} labels, ${failures.length} failures (of ${ids.length})`);
    archive.finalize();
  } catch (err) {
    console.error('[4px] GET /api/4px/bulk-labels.zip:', err.message);
    if (!res.headersSent) res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * POST /api/4px/bulk-complete
 *
 * Mark several Etsy receipts as shipped, each with its OWN tracking number.
 * Body: { orders: [{ receipt_id, tracking_code, carrier_name? }], carrier_name? }
 *
 * Designed to run right after bulk-create-order: the frontend feeds back each
 * order's 4PX tracking number so completion is fully automated and every order
 * gets the correct, corresponding tracking number on Etsy.
 *
 * Returns per-order results; one Etsy failure never blocks the others.
 */
app.post('/api/4px/bulk-complete', async (req, res) => {
  const orders = Array.isArray(req.body?.orders) ? req.body.orders : [];
  if (!orders.length) return res.status(400).json({ error: 'orders[] is required and must be non-empty' });
  if (orders.length > 200) return res.status(400).json({ error: 'A maximum of 200 orders can be completed per batch' });

  const batchCarrier = req.body.carrier_name || '4PX';

  // Etsy completion is sequential (token refresh + per-shop rate limits make
  // parallelism risky); a small batch of orders completes quickly enough.
  const results = [];
  for (const o of orders) {
    try {
      await shipEtsyReceipt(o.receipt_id, {
        tracking_code: o.tracking_code,
        carrier_name:  o.carrier_name || batchCarrier,
      });
      results.push({ receipt_id: o.receipt_id, success: true, tracking_code: (o.tracking_code || '').trim() });
    } catch (err) {
      const etsyBody = err.response?.data;
      const errMsg   = (typeof etsyBody === 'object' ? (etsyBody?.error_description || etsyBody?.error) : null) || err.message;
      console.error(`[4px/bulk] complete receipt ${o.receipt_id} failed:`, errMsg);
      results.push({ receipt_id: o.receipt_id, success: false, error: errMsg });
    }
  }

  const ok     = results.filter(r => r.success).length;
  const failed = results.length - ok;
  console.log(`[4px/bulk] complete batch: ${ok} completed, ${failed} failed (of ${results.length})`);
  res.json({ success: failed === 0, total: results.length, completed: ok, failed, results });
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
      'SELECT fourpx_consignment_no, fourpx_tracking_no, fourpx_order_status FROM receipts WHERE receipt_id = ?'
    ).get(receipt_id);

    if (!row) return res.status(404).json({ error: 'Receipt not found' });
    if (!row.fourpx_consignment_no && !row.fourpx_tracking_no) {
      return res.status(404).json({ error: 'No 4PX order exists for this receipt' });
    }
    if (row.fourpx_order_status === 'cancelled') {
      return res.status(409).json({ error: '4PX order is already cancelled' });
    }

    // ds.xms.order.cancel also resolves by the 4PX tracking number, not the
    // ds_consignment_no (which returns "no such order").
    const requestNo = row.fourpx_tracking_no || row.fourpx_consignment_no;
    await cancelShipOrder(appKey, appSecret, requestNo, reason);

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

// ─── Bulk Listing Creator ───────────────────────────────────────────────────
// Ingests a folder-of-folders of product media, generates AI copy, prices each
// variation from the 4-currency master sheet, auto-resolves shop settings, and
// creates draft listings via the Etsy API. See src/listings/*.

const bulkManager = new BulkJobManager({ db, resolveShopClient: getShopClientForShopName });

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
  const rawPath = req.query.path ? String(req.query.path) : os.homedir();
  const dirPath = path.resolve(rawPath);
  try {
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      return res.status(400).json({ error: `Not a directory: ${dirPath}` });
    }
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const dirs = entries
      .filter((e) => {
        if (!e.isDirectory()) return false;
        // Skip obviously system/hidden folders on Windows & Mac/Linux
        const n = e.name;
        if (n.startsWith('.')) return false;
        if (['$RECYCLE.BIN', 'System Volume Information', 'node_modules', '__pycache__'].includes(n)) return false;
        return true;
      })
      .map((e) => ({ name: e.name, path: path.join(dirPath, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    const files = entries
      .filter((e) => e.isFile())
      .map((e) => ({ name: e.name, ext: path.extname(e.name).toLowerCase() }));

    const parent = path.dirname(dirPath) !== dirPath ? path.dirname(dirPath) : null;
    res.json({ path: dirPath, parent, dirs, file_count: files.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/bulk/scan  { input_path }
 * Returns the products detected in the input root (folder = one product).
 */
app.post('/api/bulk/scan', (req, res) => {
  try {
    const { input_path } = req.body;
    if (!input_path) return res.status(400).json({ error: 'input_path required' });
    const { inputRoot, products, skipped } = scanInputRoot(input_path);
    res.json({
      input_root: inputRoot,
      count: products.length,
      products: products.map(p => ({
        folder: p.folder, name: p.name, image_count: p.imageCount,
        has_video: p.hasVideo, warnings: p.warnings,
      })),
      skipped: skipped.map(s => ({ folder: s.folder, name: s.name, warnings: s.warnings })),
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * GET /api/bulk/shop-settings/:shop_name?force=1
 * Live-fetches (and caches) the shop's shipping/return/partner/section/taxonomy
 * plus currency, with auto-selected defaults for the override UI.
 */
app.get('/api/bulk/shop-settings/:shop_name', async (req, res) => {
  try {
    const { shopClient, numericShopId, shopCfg } = await getShopClientForShopName(req.params.shop_name);
    const settings = await getShopListingSettings({
      db, shopClient, shopId: numericShopId,
      shopKey: req.params.shop_name, force: req.query.force === '1',
    });
    res.json({ shop_key: shopCfg.shop_id, ...settings });
  } catch (err) {
    console.error('[bulk] shop-settings error:', err.response?.data || err.message);
    res.status(err.status || err.response?.status || 500).json({ error: err.response?.data?.error || err.message });
  }
});

/**
 * POST /api/bulk/run
 * { shop_name, input_path, state, overrides, dry_run, brand_tags }
 * Creates a job and starts processing in the background.
 */
app.post('/api/bulk/run', (req, res) => {
  try {
    const { shop_name, input_path, state, overrides, dry_run, brand_tags } = req.body;
    if (!shop_name) return res.status(400).json({ error: 'shop_name required' });
    if (!input_path) return res.status(400).json({ error: 'input_path required' });
    const job = bulkManager.createAndStart({
      shopName: shop_name,
      inputPath: input_path,
      targetState: state === 'published' ? 'published' : 'draft',
      dryRun: Boolean(dry_run),
      overrides: overrides || {},
      brandTags: Array.isArray(brand_tags) ? brand_tags : undefined,
    });
    res.status(201).json({ success: true, job });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/** GET /api/bulk/jobs — recent jobs (newest first). */
app.get('/api/bulk/jobs', (req, res) => {
  const jobs = db.prepare('SELECT * FROM bulk_jobs ORDER BY created_at DESC LIMIT 50').all();
  res.json({ jobs });
});

/** GET /api/bulk/jobs/:job_id — job + its items. */
app.get('/api/bulk/jobs/:job_id', (req, res) => {
  const job = bulkManager.getJob(req.params.job_id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ job, items: bulkManager.getItems(req.params.job_id) });
});

/** GET /api/bulk/stream/:job_id — SSE live progress. */
app.get('/api/bulk/stream/:job_id', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('\n');
  const job = bulkManager.getJob(req.params.job_id);
  if (job) {
    res.write(`data: ${JSON.stringify({ type: 'snapshot', job, items: bulkManager.getItems(req.params.job_id) })}\n\n`);
  }
  bulkManager.subscribe(req.params.job_id, res);
});

/** POST /api/bulk/jobs/:job_id/retry — resume failed/incomplete items. */
app.post('/api/bulk/jobs/:job_id/retry', (req, res) => {
  try {
    const job = bulkManager.retry(req.params.job_id, { overrides: req.body?.overrides });
    res.json({ success: true, job });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
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

/**
 * GET /api/automation/capture-session-stream  (SSE stream, EventSource-compatible)
 * Same as the POST version but accepts params as query string so the browser's
 * native EventSource API can be used directly (EventSource only supports GET).
 *
 * Query: ?profile_id=xxx&shop_id=yyy&shop_name=zzz
 */
app.get('/api/automation/capture-session-stream', async (req, res) => {
  const { profile_id, shop_id, shop_name } = req.query;
  if (!profile_id || !shop_id || !shop_name) {
    return res.status(400).json({ error: 'profile_id, shop_id, and shop_name query params required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (stage, message) => {
    res.write(`data: ${JSON.stringify({ stage, message })}\n\n`);
  };

  try {
    const result = await etsyMarketing.captureSession(profile_id, shop_id, shop_name, send);
    res.write(`data: ${JSON.stringify({ stage: result.success ? 'done' : 'error', ...result })}\n\n`);
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
 * POST /api/messages/sync  —  UNIFIED SMART SYNC (primary entry point)
 *
 * Etsy has no messaging API, so this orchestrates the two real channels per
 * shop, picking the best available source automatically:
 *   1. Browser automation  — if the shop has a saved Etsy browser session
 *                            (full thread read; also enables real replies)
 *   2. IMAP email           — if the shop has email_imap configured
 *                            (read-only notification snippets)
 * Shops with neither are reported as needing setup so the UI can guide login.
 *
 * Body: { shop_id?: string }  — omit to sync every eligible shop.
 */
app.post('/api/messages/sync', async (req, res) => {
  const targetShopId = req.body?.shop_id ?? null;
  const shops = getAllShops(config).filter(s => !targetShopId || s.shop_id === targetShopId);

  const browserShops = shops.filter(s => browserManager.hasSession(s.shop_id));
  const emailShops   = shops.filter(s => !browserManager.hasSession(s.shop_id)
                                         && s.email_imap?.user && s.email_imap?.password);
  const needsSetup   = shops.filter(s => !browserManager.hasSession(s.shop_id)
                                         && !(s.email_imap?.user && s.email_imap?.password));

  if (!browserShops.length && !emailShops.length) {
    return res.status(400).json({
      error: 'No messaging source configured for the selected shop(s).',
      hint: 'Click "Connect Inbox" to log in with the browser (recommended — enables reading AND replying), '
          + 'or add an email_imap block in config.json for read-only email sync.',
      needs_setup: needsSetup.map(s => s.shop_id),
    });
  }

  res.json({
    message: `Sync started — ${browserShops.length} via browser, ${emailShops.length} via email.`,
    browser_shops: browserShops.map(s => s.shop_id),
    email_shops:   emailShops.map(s => s.shop_id),
    needs_setup:   needsSetup.map(s => s.shop_id),
  });

  // Run in background so the HTTP response returns immediately.
  (async () => {
    let totalSynced = 0;

    // 1) Browser engine (priority — richest + reply-capable)
    for (const shopCfg of browserShops) {
      try {
        const result = await browserSyncShop(shopCfg, db);
        if (result.error === 'session_expired') {
          broadcastSyncEvent({ type: 'messages:session-expired', shop_id: shopCfg.shop_id });
          console.warn(`[messages/sync] ${shopCfg.shop_id}: browser session expired — re-login required`);
        } else if (result.error) {
          console.warn(`[messages/sync] ${shopCfg.shop_id}: browser sync error — ${result.error}`);
        } else {
          totalSynced += result.synced || 0;
        }
      } catch (err) {
        console.error(`[messages/sync] ${shopCfg.shop_id}: browser sync threw — ${err.message}`);
      }
      const unread = db.prepare(`SELECT COUNT(*) AS c FROM conversations WHERE status = 'unread'`).get().c;
      broadcastSyncEvent({ type: 'messages:unread', count: unread, shop_id: shopCfg.shop_id });
    }

    // 2) Email fallback for shops without a browser session
    if (emailShops.length) {
      const { totalSynced: emailSynced } = await syncAllShopEmails(emailShops, db, (shopId, result) => {
        if (result.error && result.error !== 'auth_failed') {
          broadcastSyncEvent({ type: 'messages:email-error', shop_id: shopId, error: result.error, detail: result.detail });
        }
        const unread = db.prepare(`SELECT COUNT(*) AS c FROM conversations WHERE status = 'unread'`).get().c;
        broadcastSyncEvent({ type: 'messages:unread', count: unread, shop_id: shopId });
      });
      totalSynced += emailSynced;
    }

    const totalUnread = db.prepare(`SELECT COUNT(*) AS c FROM conversations WHERE status = 'unread'`).get().c;
    broadcastSyncEvent({ type: 'messages:unread', count: totalUnread });
    console.log(`[messages/sync] Complete — ${totalSynced} synced; total unread: ${totalUnread}`);
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
    // Pass adspower_profile_id so the manager uses AdsPower CDP mode when configured.
    // Falls back to standalone Playwright if profile ID is not set.
    await browserManager.startLoginBrowser(shop_id, shopCfg.proxy || null, shopCfg.adspower_profile_id || null);
    const mode = shopCfg.adspower_profile_id ? 'AdsPower' : 'standalone Chromium';
    res.json({ started: true, message: `Browser opened via ${mode} — log into Etsy for this shop, then return here.` });
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
 * Returns the (self-contained) route-engine status so the UI can show a setup
 * callout if the vendored engine is somehow missing.
 */
app.get('/api/route/config', (req, res) => {
  const engineRoot = enginePaths.engineDir(config);
  const engineScript = enginePaths.engineScript(config);
  let scriptExists = false;
  if (engineScript) {
    try { fs.accessSync(engineScript, fs.constants.R_OK); scriptExists = true; } catch {}
  }
  let charmCount = 0;
  try { charmCount = routeDashboard.loadCharmCatalog(engineRoot).charms.length; } catch {}

  res.json({
    configured:    !!(engineRoot),
    script_exists: scriptExists,
    osp_project_dir: engineRoot,
    osp_python:    enginePaths.enginePython(config),
    script_path:   engineScript,
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
    // Explicit receipt set — comma-separated, bypasses the date/shipped filters
    // so only those receipts are returned (used by the "Add Order" lookup).
    const receiptIds = (req.query.receipt_ids || '')
      .split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isInteger);

    // Extra receipts pulled in via the Orders tab "Send to Route" — merged on
    // TOP of the date/shop scope so pre-transit orders show alongside pending.
    const extraIds = (req.query.extra_receipt_ids || '')
      .split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isInteger);

    const rows = routeDashboard.buildRouteRows(db, config, {
      date_from:         req.query.date_from,
      date_to:           req.query.date_to,
      shop_id:           req.query.shop_id,
      include_shipped:   req.query.include_shipped === 'true',
      // Pre-transit orders flagged "needs purchase" are auto-merged into the route so
      // they reliably get bought (durable, server-side — not browser localStorage).
      include_needs_purchase: req.query.include_needs_purchase !== 'false',
      enrich_supplier:   req.query.enrich_supplier !== 'false',
      receipt_ids:       receiptIds.length ? receiptIds : undefined,
      extra_receipt_ids: extraIds.length ? extraIds : undefined,
    });

    // Headline counts for the dashboard summary bar.
    // `charms_assigned` counts rows where the operator (or a per-product default) has
    // explicitly confirmed a charm code.  Catalog/Excel suggestions intentionally do NOT
    // count — r.charm_code is only populated from user-confirmed sources in buildRouteRows.
    const summary = {
      orders:    new Set(rows.map(r => r.receipt_id)).size,
      items:     rows.length,
      excluded:  rows.filter(r => r.excluded).length,
      charms_needed:   rows.filter(r => r.has_charm && !r.excluded).length,
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

    // Keep the Orders-tab purchasing rollup in sync: if a component status changed
    // here in the Route, re-roll the order flag (auto-clears a flagged pre-transit
    // order once everything is bought; auto-includes one that still has work).
    if (b.status_case != null || b.status_grip != null || b.status_charm != null) {
      try { recomputeNeedsPurchaseRollup(Number(b.receipt_id)); } catch { /* non-fatal */ }
    }

    res.json({ ok: true, assignment: row });
  } catch (err) {
    console.error('[route] assign error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/route/charm-progress
 * Returns { charm_code: purchased_qty } for the "Charms to Buy" list, so the UI
 * can show purchased vs. still-to-buy quantities per charm code.
 */
app.get('/api/route/charm-progress', (req, res) => {
  try {
    res.json({ ok: true, progress: getCharmPurchaseProgress(db) });
  } catch (err) {
    console.error('[route] charm-progress GET error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/route/charm-progress
 * Body: { charm_code, purchased_qty }
 * Sets how many physical pieces of a charm have already been purchased / are in
 * stock. Clamped to >= 0.
 */
app.post('/api/route/charm-progress', express.json(), (req, res) => {
  const b = req.body ?? {};
  if (!b.charm_code) return res.status(400).json({ error: 'charm_code is required.' });
  try {
    const saved = setCharmPurchaseProgress(db, b.charm_code, b.purchased_qty);
    res.json({ ok: true, ...saved });
  } catch (err) {
    res.status(err.code === 'REQUIRED' ? 400 : 500).json({ error: err.message });
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
 * GET /api/route/products
 * The "product database" that powers the Add-Order product picker: every
 * distinct product seen across orders, with its cached thumbnail and the set
 * of phone-model / style variations observed. Also returns the global lists of
 * known phone models + styles so the picker can offer them for custom products.
 *
 * Optional ?q= filters products by title / shop (case-insensitive substring).
 */
app.get('/api/route/products', (req, res) => {
  try {
    const cat = routeDashboard.buildProductCatalog(db);
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    const products = q
      ? cat.products.filter(p =>
          (p.title || '').toLowerCase().includes(q) ||
          (p.shop_name || '').toLowerCase().includes(q))
      : cat.products;
    res.json({ ok: true, products, phone_models: cat.phone_models, styles: cat.styles });
  } catch (err) {
    console.error('[route] products error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/route/manual-order
 * Add an operator-created line-item to the Orders Sorting Dashboard.
 *
 * Body:
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
 *
 * Returns the freshly-built route row so the client can insert it instantly.
 */
app.post('/api/route/manual-order', express.json({ limit: '25mb' }), (req, res) => {
  const b = req.body ?? {};
  const title = String(b.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Product title is required.' });

  try {
    const listingId = b.listing_id != null && String(b.listing_id).trim() !== ''
      ? Number(b.listing_id) : null;

    // Decode an optional base64 custom-product image (accepts data: URLs).
    let imageData = null;
    let imageMime = String(b.image_mime || '').trim();
    if (b.image_b64 && typeof b.image_b64 === 'string') {
      let raw = b.image_b64.trim();
      const m = /^data:([^;]+);base64,(.*)$/i.exec(raw);
      if (m) { imageMime = imageMime || m[1]; raw = m[2]; }
      try {
        const buf = Buffer.from(raw, 'base64');
        if (buf.length > 0) imageData = buf;
      } catch { /* ignore malformed image; item still added without a photo */ }
    }

    const itemKey = routeDashboard.lineItemKey(title, listingId);
    const created = insertManualItem(db, {
      item_key:    itemKey,
      title,
      phone_model: b.phone_model,
      style:       b.style,
      quantity:    b.quantity,
      shop_name:   b.shop_name,
      listing_id:  listingId,
      image_url:   String(b.image_url || '').trim(),
      image_data:  imageData,
      image_mime:  imageMime,
      source:      b.source,
    });

    // If a charm was pre-selected, persist it as a route assignment immediately
    // so it shows on the dashboard without requiring a separate assignment step.
    const charmCode = String(b.charm_code || '').trim();
    if (charmCode) {
      try {
        upsertRouteAssignment(db, {
          receipt_id: created.receipt_id,
          item_key:   itemKey,
          title,
          charm_code: charmCode,
          charm_shop: String(b.charm_shop || '').trim(),
        });
      } catch (e) {
        // Non-fatal; the order is still created, charm can be set from the dashboard.
        console.warn('[route] manual-order charm assignment warning:', e.message);
      }
    }

    // Build the matching dashboard row so the UI can render it immediately.
    let row = null;
    try {
      const rows = routeDashboard.buildRouteRows(db, config, { enrich_supplier: true });
      row = rows.find(r => r.receipt_id === created.receipt_id) || null;
    } catch { /* non-fatal — client can reload */ }

    res.status(201).json({ ok: true, ...created, row });
  } catch (err) {
    console.error('[route] manual-order create error:', err.message);
    res.status(err.code === 'REQUIRED' ? 400 : 500).json({ error: err.message });
  }
});

/**
 * DELETE /api/route/manual-order
 * Body: { receipt_id }  (the synthetic negative id)
 * Removes a manual line-item and any route assignment attached to it.
 */
app.delete('/api/route/manual-order', express.json(), (req, res) => {
  const rid = Number((req.body ?? {}).receipt_id);
  if (!Number.isInteger(rid)) return res.status(400).json({ error: 'receipt_id is required.' });
  try {
    const removed = deleteManualItemByReceipt(db, rid);
    if (!removed) return res.status(404).json({ error: 'Manual item not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[route] manual-order delete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/route/manual-image/:id
 * Streams the uploaded image bytes for a custom manual product.
 */
app.get('/api/route/manual-image/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).end();
  try {
    const img = getManualItemImage(db, id);
    if (!img) return res.status(404).end();
    res.setHeader('Content-Type', img.mime || 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(img.data);
  } catch (err) {
    console.error('[route] manual-image error:', err.message);
    if (!res.headersSent) res.status(404).end();
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
    // The import fully replaces product_map, so re-apply the catalog backfill to
    // keep empty supplier/charm cells populated from the route-engine catalog.
    try { routeDashboard.reconcileProductMap(db, config); } catch { /* non-fatal */ }
    res.json({ ...r, ..._supplierPayload() });
  } catch (err) {
    console.error('[route] import-suppliers error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Product Catalog (product_map) CRUD ────────────────────────────────────

// Attach a resolved product thumbnail (title_norm → Etsy image URL) to each row.
function _withProductImages(rows) {
  let imgMap;
  try { imgMap = routeDashboard.buildProductImageMap(db); } catch { imgMap = new Map(); }
  return rows.map(r => ({ ...r, image_url: imgMap.get(r.title_norm) || null }));
}

/**
 * GET /api/route/product-map?q=
 * Returns all product_map rows (each enriched with a product image URL),
 * optionally filtered by a search term.
 */
app.get('/api/route/product-map', (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    res.json({ ok: true, rows: _withProductImages(getProductMap(db, q || undefined)) });
  } catch (err) {
    console.error('[route] product-map GET error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/route/product-map/reconcile
 * Backfill empty supplier/charm fields from the bundled route-engine catalog
 * (exact title matches only; never overwrites existing values).
 */
app.post('/api/route/product-map/reconcile', (req, res) => {
  try {
    const r = routeDashboard.reconcileProductMap(db, config);
    res.json({ ...r, rows: _withProductImages(getProductMap(db)) });
  } catch (err) {
    console.error('[route] product-map reconcile error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/route/product-map
 * Create a new product→supplier/charm mapping.
 * Body: { title, shop_name?, stall?, charm_shop?, charm_code? }
 */
app.post('/api/route/product-map', express.json(), (req, res) => {
  try {
    const result = upsertProductMapRow(db, req.body ?? {});
    res.status(201).json({ ok: true, ...result, rows: _withProductImages(getProductMap(db)) });
  } catch (err) {
    res.status(_supplierErrStatus(err)).json({ error: err.message });
  }
});

/**
 * PUT /api/route/product-map
 * Update an existing mapping by id (title can be changed safely).
 * Body: { id, title, shop_name?, stall?, charm_shop?, charm_code? }
 */
app.put('/api/route/product-map', express.json(), (req, res) => {
  const b = req.body ?? {};
  if (!b.id) return res.status(400).json({ error: 'id is required.' });
  try {
    updateProductMapRowById(db, b);
    res.json({ ok: true, rows: _withProductImages(getProductMap(db)) });
  } catch (err) {
    res.status(_supplierErrStatus(err)).json({ error: err.message });
  }
});

/**
 * DELETE /api/route/product-map
 * Delete a mapping by id.
 * Body: { id }
 */
app.delete('/api/route/product-map', express.json(), (req, res) => {
  const b = req.body ?? {};
  if (!b.id) return res.status(400).json({ error: 'id is required.' });
  try {
    const removed = deleteProductMapRow(db, b.id);
    if (!removed) return res.status(404).json({ error: 'Entry not found.' });
    res.json({ ok: true, rows: _withProductImages(getProductMap(db)) });
  } catch (err) {
    res.status(_supplierErrStatus(err)).json({ error: err.message });
  }
});

/**
 * GET /api/route/product-map/export.csv
 * Download the entire product catalog as a UTF-8 CSV file.
 * Suitable for backup, spreadsheet editing, or re-import via the Excel import flow.
 */
app.get('/api/route/product-map/export.csv', (req, res) => {
  try {
    const rows = getProductMap(db);
    const esc  = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['Product Title', 'Shop Name', 'Stall', 'Charm Shop', 'Charm Code'].map(esc).join(',');
    const body   = rows.map(r =>
      [r.title, r.shop_name, r.stall, r.charm_shop, r.charm_code].map(esc).join(','),
    ).join('\r\n');
    const csv = `\uFEFF${header}\r\n${body}`;  // BOM for Excel UTF-8 auto-detect
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="product_catalog_${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('[route] product-map export error:', err.message);
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
  const ospDir = enginePaths.engineDir(config);
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
  { file: 'shopping_route.xlsx',           label: 'Full route',         desc: 'Floors · suppliers · orders',     icon: '📄', generated: true,  group: 'en' },
  { file: 'shopping_route_simple.xlsx',    label: 'Simple route',       desc: 'Compact supplier checklist',      icon: '🧾', generated: true,  group: 'en' },
  { file: 'shopping_route_zh.xlsx',        label: 'Shopping route',     desc: '简化版购物路线',                    icon: '🛍️', generated: true,  group: 'zh' },
  { file: 'shopping_route_zh_status.xlsx', label: 'Route + status',     desc: '含 手机壳 / 支架 / 挂件 状态',       icon: '📝', generated: true,  group: 'zh' },
  { file: 'shopping_route_zh_check.xlsx',  label: 'Purchase checklist', desc: '员工按订单核对采购状态',             icon: '📋', generated: true,  group: 'zh' },
  { file: 'shopping_route_zh_ready.xlsx',  label: 'Ready to ship',      desc: '全部已购买 · 可打包发货',           icon: '✅', generated: false, group: 'zh' },
];
// Just the filenames, for membership checks / lock probing.
const ROUTE_OUTPUT_XLSX = ROUTE_OUTPUT_FILES.map(s => s.file);
// Subset (re)written by a normal route generation — used for the pre-flight
// lock check so an open ready-to-ship report never blocks route generation.
const ROUTE_GENERATED_XLSX = ROUTE_OUTPUT_FILES.filter(s => s.generated).map(s => s.file);
// The on-demand ready-to-ship report, and the checklist it is built from.
const ROUTE_CHECK_FILE = 'shopping_route_zh_check.xlsx';
const ROUTE_READY_FILE = 'shopping_route_zh_ready.xlsx';

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
    return res.status(409).json({ error: 'A route generation is already in progress.' });
  }

  // Claim the lock synchronously — before any await — so a second concurrent
  // request can't slip through the guard above during async image-fetching.
  // Any early-exit error path below resets status to 'error' so the UI doesn't
  // get stuck in a permanently-locked state.
  _routeJob = { status: 'running', log: [], startedAt: new Date().toISOString(),
                finishedAt: null, outputDir: null, files: [], error: null };

  const ospDir = enginePaths.engineDir(config);
  if (!ospDir) {
    _routeJob.status = 'error';
    _routeJob.error  = 'Route engine directory could not be resolved.';
    _routeJob.finishedAt = new Date().toISOString();
    return res.status(400).json({ error: _routeJob.error });
  }

  const ospScript = enginePaths.engineScript(config);
  try { fs.accessSync(ospScript, fs.constants.R_OK); }
  catch {
    _routeJob.status = 'error';
    _routeJob.error  = `Route engine script not found: ${ospScript}`;
    _routeJob.finishedAt = new Date().toISOString();
    return res.status(400).json({ error: _routeJob.error });
  }

  const { date_from, date_to, shop_id, extra_receipt_ids: rawExtraIds } = req.body ?? {};

  // Parse comma-separated or array of receipt IDs forwarded from the client.
  // These are orders the operator pinned via "Send to Route" (pre-transit /
  // shipped) or the "+ Add Order" modal — they live outside the default
  // pending-only scope so they must be passed explicitly to ensure the
  // generated Excel files match exactly what the Route dashboard displays.
  const extraIds = Array.isArray(rawExtraIds)
    ? rawExtraIds.map(Number).filter(Number.isInteger)
    : typeof rawExtraIds === 'string' && rawExtraIds.trim()
      ? rawExtraIds.split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isInteger)
      : [];

  // ── Build route rows (orders × their saved charm/status assignments) ───────
  // enrich_supplier:true makes these rows IDENTICAL to what the operator sees
  // in the Route dashboard (catalog match + manual overrides), so the generated
  // Excel files carry the exact same supplier/stall placement — no divergence.
  // Helper to fail fast: release the lock and send an error response.
  const failEarly = (statusCode, message) => {
    _routeJob.status     = 'error';
    _routeJob.error      = message;
    _routeJob.finishedAt = new Date().toISOString();
    return res.status(statusCode).json({ error: message });
  };

  let rows;
  try {
    rows = routeDashboard.buildRouteRows(db, config, {
      date_from, date_to, shop_id, include_shipped: false,
      enrich_supplier: true,
      ...(extraIds.length ? { extra_receipt_ids: extraIds } : {}),
    });
  } catch (err) {
    return failEarly(500, `DB error: ${err.message}`);
  }

  // ── Reconcile charm statuses from the authoritative purchase-progress store ─
  // The "Charms to Buy" stepper count (charm_purchase_progress) is what the
  // operator sees as "still to buy". Fold it into the per-line charm statuses
  // BEFORE the status cache is written so the generated Excel's charm section
  // matches the dashboard exactly — including partial purchases that the
  // optimistic browser-side sync may have failed to persist.
  let charmRecInfo = { changed: 0, codes: 0 };
  try {
    charmRecInfo = routeDashboard.reconcileCharmStatusesFromProgress(
      db, rows, getCharmPurchaseProgress(db),
    );
  } catch (err) {
    console.warn(`[route] charm status reconciliation failed (non-fatal): ${err.message}`);
  }

  const includedRows   = rows.filter(r => !r.excluded);
  const exportedOrders = routeDashboard.rowsToImportOrders(rows);

  if (exportedOrders.length === 0) {
    return failEarly(400, 'No pending orders to generate a route for (after exclusions).');
  }

  // Route files are generated INTO this dashboard's own folder (not the OSP's).
  const outputDir  = _routeOutputDir();
  const outputXlsx = path.join(outputDir, 'shopping_route.xlsx');
  try {
    fs.mkdirSync(outputDir, { recursive: true });
  } catch (err) {
    return failEarly(500, `Cannot create output directory: ${err.message}`);
  }

  // ── Pre-flight: refuse to start if a target route file is locked ──────────
  // A generated workbook left OPEN in Excel holds an exclusive write lock on
  // Windows, so the Python save crashes with PermissionError part-way through —
  // the full/simple files get overwritten while the _zh file is left STALE.
  // That is the real reason "I regenerate but the Excel never changes". Detect
  // it up front and return one clear, actionable message instead of burning a
  // full generation and surfacing a raw traceback.
  const _lockedFiles = ROUTE_GENERATED_XLSX
    .filter((name) => {
      const fp = path.join(outputDir, name);
      let fd;
      try {
        fd = fs.openSync(fp, 'r+');   // read+write, no truncate — same access wb.save needs
        return false;                 // opened cleanly → not locked
      } catch (err) {
        if (err.code === 'ENOENT') return false;   // doesn't exist yet → writable
        return ['EBUSY', 'EPERM', 'EACCES'].includes(err.code); // locked
      } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
      }
    });
  if (_lockedFiles.length) {
    return failEarly(
      409,
      `Close ${_lockedFiles.join(', ')} in Excel, then click Generate again — ` +
      `the file is open and cannot be overwritten.`,
    );
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
    // Build a deduped Map<listing_id, image_url> from the full row set
    // (rows, not exportedOrders, because rows carry listing_id + image_url).
    const listingIdToUrl = new Map();
    for (const row of rows) {
      if (row.listing_id && row.image_url && !listingIdToUrl.has(row.listing_id)) {
        listingIdToUrl.set(row.listing_id, row.image_url);
      }
    }

    const imageDataMap = listingIdToUrl.size > 0
      ? await batchFetchRouteImages(db, listingIdToUrl)
      : new Map();

    for (const order of exportedOrders) {
      for (const item of order.items) {
        // 1. Etsy listing image (catalog products + catalog-picked manual items).
        if (item._listing_id) {
          const buf = imageDataMap.get(item._listing_id);
          if (buf) item.image_b64 = buf.toString('base64');
        }
        // 2. Uploaded custom-product image (manual items with no listing id).
        if (!item.image_b64 && item._manual_id != null) {
          try {
            const img = getManualItemImage(db, item._manual_id);
            if (img) item.image_b64 = img.data.toString('base64');
          } catch { /* non-fatal — item just has no photo */ }
        }
      }
    }
  } catch (err) {
    // Non-fatal: log and continue without images rather than blocking generation.
    console.warn(`[route] Image fetch failed (route will have no photos): ${err.message}`);
  } finally {
    // Always strip internal UED keys so the OSP never sees them.
    for (const order of exportedOrders) {
      for (const item of order.items) { delete item._listing_id; delete item._manual_id; }
    }
  }

  // ── Write OSP's status cache so it knows what's already Purchased / OOS ────
  // The generator reads this from the SAME folder it writes the Excel files to,
  // so it must live in our output dir alongside shopping_route.xlsx.
  let statusCacheInfo = { count: 0 };
  try {
    statusCacheInfo = routeDashboard.writeStatusCache(outputDir, includedRows);
  } catch (err) {
    return failEarly(500, `Cannot write status cache: ${err.message}`);
  }

  // ── Write temp JSON order payload, then spawn Python ───────────────────────
  const tmpFile = path.join(os.tmpdir(), `ued_route_${Date.now()}.json`);
  try {
    fs.writeFileSync(tmpFile, JSON.stringify({
      orders:      exportedOrders,
      exported_at: new Date().toISOString(),
    }, null, 2));
  } catch (err) {
    return failEarly(500, `Cannot write temp file: ${err.message}`);
  }

  // Always produce all three Excel files, matching a standard OSP run:
  //   shopping_route.xlsx · shopping_route_simple.xlsx · shopping_route_zh.xlsx
  // (--chinese adds the _zh file; the full + simple files are always written.)
  //
  // --project-dir is REQUIRED: it tells the generator to use the OSP's
  // organized layout (data/supplier_catalog.xlsx, data/charm_images, cache/),
  // which is where the catalog actually lives. Without it the script looks for
  // "supplier_catalog.xlsx" in the cwd root and fails with "Catalog not found".
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
  const pyArgs = [
    ospScript,
    '--project-dir', ospDir,
    '--import-json', tmpFile,
    '--output', outputXlsx,
    '--reset',
    '--no-catalog-update',
    '--chinese',
  ];

  // Release the dashboard's cached read-only handle on the engine database so
  // the generator has exclusive access to checkpoint/compact its WAL while it
  // rewrites the order cache. The handle re-opens lazily on the next request.
  try { routeDashboard.closeOspCatalog(); } catch { /* non-fatal */ }

  // Populate the log now that we have all the details (pyArgs, counts, etc.).
  // The job object was already created above to claim the lock; here we just
  // append the initial log lines and send the 202 response.
  const lineItemCount = exportedOrders.reduce((s, o) => s + o.items.length, 0);
  _routeJob.log.push(
    `[${new Date().toISOString()}] Starting route generation for ${exportedOrders.length} order(s), ${lineItemCount} line item(s)…`,
    ...(charmRecInfo.changed
      ? [`[charm] Reconciled ${charmRecInfo.changed} charm line status(es) from purchase progress across ${charmRecInfo.codes} code(s)`]
      : []),
    `[cache] Wrote ${statusCacheInfo.count} purchase-status entr${statusCacheInfo.count === 1 ? 'y' : 'ies'} to route_statuses_cache.json`,
    `[cmd] ${enginePaths.enginePython(config)} ${pyArgs.join(' ')}`,
  );

  res.status(202).json({ status: 'started', order_count: exportedOrders.length, item_count: lineItemCount });

  const proc = spawn(enginePaths.enginePython(config), pyArgs, {
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
      let files = [];
      try {
        const _allowed = new Set(ROUTE_OUTPUT_XLSX.map(n => n.toLowerCase()));
        files = fs.readdirSync(outputDir)
          .filter(f => _allowed.has(f.toLowerCase()))
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
      // If a route file was locked (opened in Excel during the run), the engine
      // emits a recognisable ROUTE_OUTPUT_LOCKED line — surface that verbatim
      // instead of the opaque "exited with code 1".
      const lockLine = _routeJob.log.find(l => l.includes('ROUTE_OUTPUT_LOCKED'));
      _routeJob.status     = 'error';
      _routeJob.error      = lockLine
        ? lockLine.replace(/^.*ROUTE_OUTPUT_LOCKED:\s*/, '').trim()
        : `Python exited with code ${code}`;
      _routeJob.finishedAt = new Date().toISOString();
      addLog(`[error] ${_routeJob.error}`);
    }

    console.log(`[route] Job finished — status: ${_routeJob.status}`);
  });
});

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
    return path.resolve(String(config.osp_output_dir).trim());
  }
  return path.join(UED_ROOT, 'output');
}
function _isAllowedRouteFile(name) {
  return /^shopping_route(_simple|_zh_status|_zh_check|_zh_ready|_zh)?\.(xlsx|html)$/i.test(name) && !/[/\\]/.test(name);
}

/**
 * GET /api/route/output-files
 * Lists the standard shopping-route Excel files and whether each exists.
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
 * POST /api/route/build-ready
 * Body (all optional): { data_b64?, file? }
 *
 * Builds the ready-to-ship report (shopping_route_zh_ready.xlsx) from an
 * employee-edited order-status checklist. The source checklist is resolved as:
 *   1. `data_b64`  — base64 of an uploaded .xlsx the operator just picked, or
 *   2. `file`      — the name of an existing route file in the output dir, or
 *   3. the in-place shopping_route_zh_check.xlsx (default).
 *
 * Spawns the Python generator in its standalone --build-ready-from mode (no PDF
 * parsing / catalog access) and returns the ready-order count when it finishes.
 */
app.post('/api/route/build-ready', express.json({ limit: '60mb' }), (req, res) => {
  const ospScript = enginePaths.engineScript(config);
  const ospDir    = enginePaths.engineDir(config);
  try { fs.accessSync(ospScript, fs.constants.R_OK); }
  catch { return res.status(400).json({ error: `Route engine script not found: ${ospScript}` }); }

  const outputDir = _routeOutputDir();
  if (!outputDir) return res.status(400).json({ error: 'Route output directory could not be resolved.' });
  try { fs.mkdirSync(outputDir, { recursive: true }); }
  catch (err) { return res.status(500).json({ error: `Cannot create output directory: ${err.message}` }); }

  const readyPath = path.join(outputDir, ROUTE_READY_FILE);

  // ── Resolve the source checklist ──────────────────────────────────────────
  const { data_b64, file } = req.body ?? {};
  let srcPath;
  let tmpToClean = null;
  if (data_b64 && String(data_b64).trim()) {
    let buf;
    try { buf = Buffer.from(String(data_b64).replace(/^data:[^,]*,/, ''), 'base64'); }
    catch { return res.status(400).json({ error: 'Uploaded file data is not valid base64.' }); }
    if (!buf || buf.length === 0) return res.status(400).json({ error: 'Uploaded file is empty.' });
    // .xlsx files are ZIP archives — verify the "PK" magic to reject bad uploads early.
    if (!(buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b)) {
      return res.status(400).json({ error: 'Uploaded file is not a valid .xlsx workbook.' });
    }
    srcPath = path.join(os.tmpdir(), `ued_check_${Date.now()}.xlsx`);
    try { fs.writeFileSync(srcPath, buf); tmpToClean = srcPath; }
    catch (err) { return res.status(500).json({ error: `Cannot stage uploaded file: ${err.message}` }); }
  } else if (file && _isAllowedRouteFile(String(file).trim())) {
    srcPath = path.join(outputDir, String(file).trim());
  } else {
    srcPath = path.join(outputDir, ROUTE_CHECK_FILE);
  }

  const _cleanup = () => { if (tmpToClean) { try { fs.unlinkSync(tmpToClean); } catch { /* ignore */ } } };

  try { fs.accessSync(srcPath, fs.constants.R_OK); }
  catch {
    _cleanup();
    return res.status(404).json({
      error: `Checklist not found. Generate a shopping route first (creates ${ROUTE_CHECK_FILE}) ` +
             `or upload an edited checklist file.`,
    });
  }

  // Refuse if the report is open in Excel (Windows holds an exclusive write lock).
  try {
    const fd = fs.openSync(readyPath, 'r+');
    fs.closeSync(fd);
  } catch (err) {
    if (err.code && ['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) {
      _cleanup();
      return res.status(409).json({ error: `Close ${ROUTE_READY_FILE} in Excel, then try again.` });
    }
    // ENOENT (not created yet) and other transient errors are fine.
  }

  const pyArgs = [
    ospScript,
    '--project-dir', ospDir,
    '--build-ready-from', srcPath,
    '--output', readyPath,
  ];

  // Free the cached read-only catalog handle (parity with route generation).
  try { routeDashboard.closeOspCatalog(); } catch { /* non-fatal */ }

  const proc = spawn(enginePaths.enginePython(config), pyArgs, {
    cwd: ospDir,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
  });

  let out = '', errOut = '';
  proc.stdout.on('data', c => { out += c.toString('utf8'); });
  proc.stderr.on('data', c => { errOut += c.toString('utf8'); });

  proc.on('error', err => {
    _cleanup();
    if (!res.headersSent) res.status(500).json({ error: `Could not start Python: ${err.message}` });
  });

  proc.on('close', code => {
    _cleanup();
    if (res.headersSent) return;
    if (code !== 0) {
      const lockLine = (out + '\n' + errOut).split('\n').find(l => l.includes('ROUTE_OUTPUT_LOCKED'));
      const msg = lockLine
        ? lockLine.replace(/^.*ROUTE_OUTPUT_LOCKED:\s*/, '').trim()
        : (errOut.trim().split('\n').filter(Boolean).pop() || `Python exited with code ${code}`);
      return res.status(500).json({ error: msg });
    }
    const m = out.match(/READY_TO_SHIP_COUNT:\s*(\d+)/);
    const readyCount = m ? parseInt(m[1], 10) : null;
    let meta = { exists: false };
    try { const st = fs.statSync(readyPath); meta = { exists: true, size: st.size, modified: st.mtimeMs }; } catch {}
    res.json({ ok: true, ready_count: readyCount, file: ROUTE_READY_FILE, ...meta });
  });
});

/**
 * GET /api/route/open?file=shopping_route.xlsx
 * Opens a generated Excel file with the OS default app (the dashboard runs
 * locally on the same machine as the files).
 */
app.get('/api/route/open', (req, res) => {
  const dir  = _routeOutputDir();
  const file = (req.query.file ?? '').trim();
  if (!dir) return res.status(400).json({ error: 'Route output directory could not be resolved.' });
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
  if (!dir) return res.status(400).json({ error: 'Route output directory could not be resolved.' });
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
    const extraIds = (req.query.extra_receipt_ids || '')
      .split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isInteger);

    const rows = routeDashboard.buildRouteRows(db, config, {
      date_from:         req.query.date_from,
      date_to:           req.query.date_to,
      shop_id:           req.query.shop_id,
      include_shipped:   req.query.include_shipped === 'true',
      enrich_supplier:   true,
      receipt_ids:       receiptIds.length ? receiptIds : undefined,
      extra_receipt_ids: extraIds.length ? extraIds : undefined,
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

  // NOTE: Etsy's public Open API v3 exposes NO messaging/conversation endpoints
  // (confirmed against the live OpenAPI spec — see src/etsy/client.js). The old
  // "conversation sync via internal API" cron has been retired because those
  // endpoints always return 403/404, which is what produced the perpetually
  // empty inbox. Messages now flow exclusively through the browser-automation
  // engine (primary) and IMAP email notifications (fallback), both scheduled
  // above. syncConversationsForShop is kept exported for backward compatibility
  // but is no longer scheduled.

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
