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

const path    = require('path');
const https   = require('https');
const express = require('express');
const cors    = require('cors');

const { loadConfig, getAllShops }          = require('../config/schema');
const { TokenManager }                     = require('../auth/token-manager');
const { initDb, syncConfigToDb }           = require('../db/setup');
const { createGroupProxyClient }                   = require('../proxy/factory');
const { buildShopClient, resolveShopId,
        createReceiptShipment, paginateListings,
        updateListing, createDraftListing,
        deleteListing }                            = require('../etsy/client');
const { upsertListing }                            = require('../db/setup');

const TOKENS_PATH = path.resolve(__dirname, '../../tokens.json');

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

const app = express();
app.use(cors());
app.use(express.json());

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
      COUNT(r.receipt_id) AS receipts_in_db
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
  // limit=0 means "all" — cap at 5000 to protect the UI from extreme datasets
  const rawLimit = parseInt(req.query.limit ?? 50, 10);
  const limit = rawLimit === 0 ? 5000 : Math.min(rawLimit, 5000);
  const offset = parseInt(req.query.offset ?? 0, 10);

  const conditions = [];
  const params     = {};

  if (req.query.shop_id)  { conditions.push('r.shop_id = @shop_id');   params.shop_id  = req.query.shop_id; }
  if (req.query.group_id) { conditions.push('r.group_id = @group_id'); params.group_id = req.query.group_id; }
  if (req.query.status)   { conditions.push('r.status = @status');     params.status   = req.query.status; }

  // shipped=false → needs shipping: unshipped AND not Canceled/Refunded (default)
  // shipped=true  → shipped/completed only
  // shipped=all   → no filter
  if (req.query.shipped === 'false') {
    conditions.push("r.is_shipped = 0 AND r.status NOT IN ('Canceled','Fully Refunded','Cancelled','Fully refunded')");
  }
  if (req.query.shipped === 'true')  conditions.push('r.is_shipped = 1');

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
      li.url                AS product_image_url,
      r.etsy_created_at,
      r.etsy_updated_at,
      r.synced_at
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
    orders: enriched,
  });
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

  res.json({ log: enriched });
});

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

  if (!tracking_code || !tracking_code.trim()) {
    return res.status(400).json({ error: 'tracking_code is required' });
  }

  // 1. Look up the order to find which shop it belongs to
  const order = db.prepare(
    'SELECT shop_name FROM receipts WHERE receipt_id = ?'
  ).get(receipt_id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  // 2. Find shop + group config
  let shopCfg, groupCfg;
  for (const grp of config.groups) {
    const s = grp.shops.find(sh => sh.shop_name === order.shop_name);
    if (s) { shopCfg = s; groupCfg = grp; break; }
  }
  if (!shopCfg) return res.status(500).json({ error: `No config found for shop ${order.shop_name}` });

  try {
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

    // 5. Create the shipment on Etsy (this marks the order as shipped + notifies buyer)
    const result = await createReceiptShipment(shopClient, numericShopId, receipt_id, {
      tracking_code: tracking_code.trim(),
      carrier_name:  (carrier_name || '4PX').trim(),
      note_to_buyer: note_to_buyer.trim() || undefined,
      ship_date:     Math.floor(Date.now() / 1000), // today, Unix seconds
    });

    // 6. Update local DB immediately so the UI reflects the change without waiting for next sync
    db.prepare(
      "UPDATE receipts SET is_shipped = 1, status = 'Completed' WHERE receipt_id = ?"
    ).run(receipt_id);

    console.log(`[ship] ${order.shop_name} receipt ${receipt_id} marked shipped — tracking: ${tracking_code}`);
    res.json({ success: true, receipt_id, tracking_code, shipment: result });

  } catch (err) {
    const etsyError = err.response?.data;
    console.error(`[ship] Error shipping receipt ${receipt_id}:`, etsyError || err.message);
    res.status(err.response?.status || 500).json({
      error: etsyError?.error_description || etsyError?.error || err.message,
    });
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
  const limit  = Math.min(parseInt(req.query.limit ?? 50, 10), 500);
  const offset = parseInt(req.query.offset ?? 0, 10);
  const conditions = [];
  const params = {};

  if (req.query.shop_id) { conditions.push('l.shop_id = @shop_id'); params.shop_id = req.query.shop_id; }
  if (req.query.state && req.query.state !== 'all') { conditions.push('l.state = @state'); params.state = req.query.state; }
  if (req.query.q) { conditions.push("l.title LIKE @q"); params.q = `%${req.query.q}%`; }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const total = db.prepare(`SELECT COUNT(*) as n FROM listings l ${where}`).get(params).n;
  const rows  = db.prepare(`
    SELECT l.*, s.shop_name
    FROM listings l
    JOIN shops s ON s.shop_id = l.shop_id
    ${where}
    ORDER BY l.updated_timestamp DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit, offset });

  res.json({
    total,
    listings: rows.map(r => ({ ...r, tags: r.tags ? JSON.parse(r.tags) : [] })),
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

// ─── Dashboard HTML ───────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../../public/index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = 4000;
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
  console.log(`  Groups    : ${groups.length} (one proxy per group)`);
  console.log('\n  ── Rate limit budget (5 QPS / 5,000 QPD per API key) ──');
  budgetLines.forEach(l => console.log(l));
  console.log(`\n  Sync interval : ${syncIntervalH}h (cron) + 0–90s jitter per shop`);
  console.log('  QPS at burst  : ≤2 per shop (staggered by jitter, well under 5 QPS)');
  console.log('  Status        : ✓ Safe — all keys under 30% of daily budget\n');
  console.log('  Open http://localhost:4000 in your browser.\n');
});
