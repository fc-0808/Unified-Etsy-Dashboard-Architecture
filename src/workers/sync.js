'use strict';

/**
 * Background sync worker.
 *
 * Runs on a configurable interval (sync_interval_minutes in config.json, default 60).
 * For each shop that has a token, fetches recent receipts from Etsy and writes them
 * to etsy_dashboard.db.
 *
 * Safety controls built in:
 *   - Per-group network path verified before any shop in that group is synced (fail-closed)
 *     Proxied groups: VPN → IPFoxy chain must be reachable
 *     Direct groups: plain internet connectivity confirmed via ipify
 *   - Per-shop deterministic offset + random jitter so shops never call Etsy in lock-step
 *   - Network client bound per group — groups never share HTTP state or proxy chains
 *   - Sync log entry written for every attempt (success or failure) for audit
 *   - If network check fails for a group, all shops in that group are skipped that cycle
 *   - Access token refreshed through the group's network path before each shop's requests
 */

const path = require('path');
const os   = require('os');
const cron = require('node-cron');

// ─── Cross-process sync lock ──────────────────────────────────────────────────
// Identifies THIS process when acquiring the shared 'sync_cycle' advisory lock.
// Guarantees only one process ever runs a receipt-sync cycle at a time, even if
// two dashboards (PM2 + a stray instance) or the embedded scheduler + the
// standalone `npm run sync` worker are running against the same database.
const SYNC_LOCK_NAME  = 'sync_cycle';
const SYNC_LOCK_OWNER = `${os.hostname()}:${process.pid}`;
// TTL must comfortably exceed one full cycle (≈10 min for a dozen shops). The
// heartbeat is renewed between groups, so a healthy holder never goes stale;
// a crashed holder's lock is reclaimable after this window.
const SYNC_LOCK_TTL_SEC = 20 * 60;

// Tracking is a separate workload with a separate lock. It uses 4PX rather than
// Etsy, so it can run on a tighter cadence without consuming Etsy's QPD budget,
// while the cross-process mutex prevents duplicate dashboard/worker instances
// from polling the same parcels simultaneously.
const TRACKING_LOCK_NAME = 'tracking_cycle';
const TRACKING_LOCK_TTL_SEC = 30 * 60;
// SQLite's advisory lock deliberately lets the SAME owner renew/reacquire. This
// in-process guard covers that case, while the DB lock covers other processes.
let _trackingCyclePromise = null;

const { loadConfig, getAllShops, isAutoRestockEnabled, refreshConfigInPlace } = require('../config/schema');
const { TokenManager, TokenExpiredError } = require('../auth/token-manager');
const { createGroupProxyClient, verifyGroupProxy } = require('../proxy/factory');
const { usesGroupProxy } = require('../config/schema');
const {
  buildShopClient,
  paginateReceipts,
  resolveShopId,
  getShop,
  getListingImageCatalogBatch,
  getListingVariationImages,
  getListingInventory,
  updateListingInventory,
  paginateLedgerEntries,
  getPaymentReceiptMap,
  isQpdExhaustedError,
} = require('../etsy/client');
const {
  initDb,
  syncConfigToDb,
  upsertReceipt,
  upsertListingImage,
  replaceListingVariationImages,
  listingIdsNeedingVariationRefresh,
  upsertListingInventory,
  updateCarrierStatus,
  updateTrackingDetail,
  recordTrackingCheckFailure,
  recordFourpxFreight,
  logEvent,
  startSyncLog,
  finishSyncLog,
  acquireLock,
  renewLock,
  releaseLock,
  syncShippingAlertLedger,
  startTrackingSyncRun,
  updateTrackingSyncRunProgress,
  finishTrackingSyncRun,
  getLatestTrackingSyncRun,
  updateShopSyncTime,
  updateShopHealth,
  updateShopLedgerSyncTime,
  upsertTransaction,
  upsertLedgerEntry,
  upsertEtsyPayment,
  reattributeLedgerEntries,
} = require('../db/setup');
const { buildVariationImageRows } = require('../listings/variation-images');
const { getTrackingSnapshot } = require('../tracking/checker');
const { resolveReceiptFreight } = require('../fourpx/freight');
const {
  getZeroStylesForListing,
  listingHasLiveZero,
  raiseOfferingsToTarget,
  logZeroStockIfNeeded,
  orderCheckPriority,
  formatStyleLabel,
} = require('../inventory/helpers');
const { maybeSyncShopCatalogHealth } = require('../growth/catalog-sync');

const {
  MAX_INV_WATCH_CHECKS_PER_CYCLE,
  INV_WATCH_STARTUP_DELAY_MS,
} = require('../compliance/suspension-guard');

// One coordinator owns every workload that spends the shared Etsy API budget.
// The in-process guard is mandatory because acquireLock intentionally lets the
// same owner renew; the DB lock independently excludes other processes.
let _etsyWorkPromise = null;

function getEtsyWorkStatus(db) {
  const now = Math.floor(Date.now() / 1000);
  let lock = null;
  try {
    lock = db.prepare(
      'SELECT owner, acquired_at, heartbeat_at FROM app_locks WHERE name = ?'
    ).get(SYNC_LOCK_NAME) || null;
  } catch { /* schema may not be ready in a diagnostic caller */ }
  const lockHeld = !!(lock && (lock.heartbeat_at ?? 0) >= now - SYNC_LOCK_TTL_SEC);
  return {
    in_process: _etsyWorkPromise?.kind ?? null,
    lock_held: lockHeld,
    lock_owner: lock?.owner ?? null,
    lock_acquired_at: lock?.acquired_at ?? null,
    lock_heartbeat_at: lock?.heartbeat_at ?? null,
  };
}

function isEtsyWorkRunning() {
  return _etsyWorkPromise != null;
}

// Etsy variation photos change rarely. Cache 7 days, and cap per-shop fetches
// so a large receipt page cannot blow the daily API budget on cosmetics.
const VARIATION_IMAGE_TTL_SEC = 7 * 24 * 3600;
const MAX_VARIATION_IMAGE_FETCHES_PER_SHOP = 40;

/**
 * Pull Etsy variation-images for `listingIds` and persist style → CDN URL.
 * Non-fatal: a single listing 404/timeout never aborts the receipt sync.
 *
 * @param {object} args
 * @param {import('better-sqlite3').Database} args.db
 * @param {import('axios').AxiosInstance} args.shopClient
 * @param {number} args.shopId
 * @param {number[]} args.listingIds
 * @param {Map<number, {heroUrl: string|null, byImageId: Map<number, string>}>} args.catalog
 * @param {string} args.label
 * @param {Function} [args.heartbeat]
 */
async function cacheStyleVariationImages({ db, shopClient, shopId, listingIds, catalog, label, heartbeat }) {
  const ids = [...new Set((listingIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return 0;
  let mapped = 0;
  let attempted = 0;
  for (const listingId of ids) {
    heartbeat?.();
    const byImageId = catalog.get(listingId)?.byImageId;
    if (!(byImageId instanceof Map) || byImageId.size === 0) {
      console.warn(`${label} No image catalog for listing ${listingId}; skipping variation-image cache`);
      continue;
    }
    attempted += 1;
    try {
      const results = await getListingVariationImages(shopClient, shopId, listingId);
      const rows = buildVariationImageRows(results, byImageId);
      replaceListingVariationImages(db, listingId, rows);
      mapped += rows.length;
    } catch (err) {
      const status = err.response?.status;
      if (status === 404) {
        try { replaceListingVariationImages(db, listingId, []); } catch { /* ignore */ }
      } else {
        console.warn(`${label} Variation images for listing ${listingId} failed (non-fatal): ${err.message}`);
      }
    }
    if (attempted < ids.length) await new Promise((r) => setTimeout(r, 150));
  }
  if (attempted) {
    console.log(`${label} Cached style variation images for ${attempted} listing(s) (${mapped} mapping(s))`);
  }
  return attempted;
}

/**
 * Single front door for receipt sync, manual/backfill sync, and inventory watch.
 * Returns immediately with a promise, mirroring startTrackingCycle.
 */
function startEtsyWork(db, kind, fn) {
  const skipped = (reason, activeKind = null) => ({
    started: false,
    reason,
    kind: activeKind,
    promise: Promise.resolve({ started: false, reason, kind: activeKind }),
  });

  if (_etsyWorkPromise) return skipped('running', _etsyWorkPromise.kind);
  if (!acquireLock(db, SYNC_LOCK_NAME, SYNC_LOCK_OWNER, SYNC_LOCK_TTL_SEC)) {
    return skipped('locked');
  }

  const token = {};
  const heartbeat = () => {
    if (renewLock(db, SYNC_LOCK_NAME, SYNC_LOCK_OWNER)) return true;
    const err = new Error('Etsy work lost its advisory lock; aborting to prevent duplicate API calls.');
    err.code = 'ETSY_LOCK_LOST';
    throw err;
  };

  const promise = (async () => {
    try {
      return await fn({ heartbeat });
    } finally {
      releaseLock(db, SYNC_LOCK_NAME, SYNC_LOCK_OWNER);
      if (_etsyWorkPromise?.token === token) _etsyWorkPromise = null;
    }
  })();
  _etsyWorkPromise = { kind, token, promise };
  return { started: true, kind, promise };
}

const TOKENS_PATH = path.resolve(__dirname, '../../tokens.json');

// ─── API-call frugality knobs ─────────────────────────────────────────────────
// Etsy's QPD is precious (5,000/key/day, shared across up to 5 shops). The active
// listing count is cosmetic (the "Active Listings" column) and barely changes, so
// we refresh it at most once per shop per this interval instead of every sync —
// saving one GET /shops call per shop per cycle. In-memory: a process restart
// simply refreshes it once on the next cycle.
const LISTING_COUNT_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
/** @type {Map<string, number>} shop_id → last listing-count refresh (ms epoch) */
const _lastListingCountRefresh = new Map();

// ─── Jitter helpers ───────────────────────────────────────────────────────────

/**
 * Stable per-shop offset derived from a hash of the shop_id.
 * Same shop always gets the same relative phase within a sync window,
 * so Y2KASEofficial always runs earlier and Y2KASEshop always runs a
 * bit later — but the exact second varies due to jitter.
 *
 * @param {string} shopId
 * @param {number} windowMs - Total spread window in milliseconds
 * @returns {number} Offset in ms
 */
function stableOffset(shopId, windowMs) {
  let hash = 0;
  for (let i = 0; i < shopId.length; i++) {
    hash = (hash * 31 + shopId.charCodeAt(i)) >>> 0;
  }
  return (hash % windowMs);
}

/**
 * Random jitter on top of the stable offset.
 * @param {number} maxMs
 * @returns {number}
 */
function jitter(maxMs) {
  return Math.floor(Math.random() * maxMs);
}

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

/** A telemetry/UI callback must never be able to abort the background worker. */
function safeTrackingHook(fn, payload, label) {
  if (typeof fn !== 'function') return;
  try {
    fn(payload);
  } catch (err) {
    console.warn(`[tracking] ${label} callback failed: ${err.message}`);
  }
}

/**
 * OpSec egress-IP allowlist (opt-in). When a group declares `expected_egress_ip`
 * in config.json (a string or an array of strings), the observed exit IP from
 * verifyGroupProxy MUST match one of them or the group is skipped for the cycle.
 * This is the strongest guard against a silent proxy/VPN leak exposing a shop on
 * an unexpected IP — the footprint Etsy uses to link/flag related shops. Groups
 * without the field are unaffected (returns true).
 *
 * @param {object} group
 * @param {string} ip
 * @returns {boolean}
 */
function egressIpAllowed(group, ip) {
  const raw = group?.expected_egress_ip;
  if (raw == null || raw === '') return true; // not configured → no enforcement
  const allow = (Array.isArray(raw) ? raw : [raw]).map((s) => String(s).trim()).filter(Boolean);
  if (!allow.length) return true;
  return allow.includes(String(ip).trim());
}

/**
 * Build a VALID node-cron expression for an "every N minutes" interval.
 *
 * The naive step-minute pattern (asterisk-slash-N in the minute field) is only
 * legal when N ≤ 59 — the minute field cannot express "every 90 minutes", and
 * some node-cron builds silently mis-fire or run hourly for N > 59. This
 * normalizes: sub-hour intervals stay minute-based;
 * hour-multiple intervals switch to the hour field; ≥24h caps at once daily.
 *
 * @param {number} minutes
 * @returns {string} cron expression
 */
function intervalToCron(minutes) {
  const m = Math.max(1, Math.ceil(Number(minutes) || 60));
  if (m < 60) return `*/${m} * * * *`;
  const hours = Math.round(m / 60);
  if (hours >= 24) return '0 0 * * *';      // daily ceiling
  return `0 */${hours} * * *`;              // every H hours, on the hour
}

// ─── Order-triggered inventory check + auto-restock ──────────────────────────

/**
 * Called after every receipt sync batch.  For each listing that appeared in a
 * recently-created order, we:
 *   1. Always live-check ordered listings (cache is used only to prioritize when
 *      more than MAX_CHECKS_PER_CYCLE listings need attention in one cycle).
 *   2. Call Etsy GET listing inventory to get live quantities.
 *   3. If any offering is at zero AND auto-restock is enabled, PUT all offerings
 *      back to config.restock_quantity and log an ORDER_RESTOCK event.
 *   4. If auto-restock is disabled, just log ZERO_STOCK (alert mode).
 *
 * Budget: at most 1 GET + 1 PUT per affected listing per sync cycle.
 * Listings whose cached stock is fine are skipped without any API call.
 *
 * @param {Set<number>}  listingIds - unique listing IDs in recent orders
 * @param {object}       shopClient - already-authenticated Etsy client for this shop
 * @param {object}       shop       - shop config entry (shop_id, shop_name, …)
 * @param {object}       config     - full app config (auto_restock_enabled, restock_quantity)
 * @param {import('better-sqlite3').Database} db
 */
async function checkAndRestockForOrders(listingIds, shopClient, shop, config, db, options = {}) {
  if (!listingIds.size) return;
  const heartbeat = options.heartbeat || null;

  const restockQty  = config.restock_quantity ?? 3;
  const autoRestock = isAutoRestockEnabled(config);
  const label       = `[order-restock] ${shop.shop_name}`;
  const twoHoursAgo = Math.floor(Date.now() / 1000) - 7200;

  // ── Phase 1: rank by cache signals, then skip redundant re-checks ──────────
  // Frugality: a listing whose live inventory was already refreshed within the
  // last sync interval AND is currently healthy (no cached zero offering) does
  // not need another GET this cycle — the order window collects each listing for
  // ~2 intervals, so without this we'd re-GET healthy listings every cycle for no
  // gain. Listings that are zero/low OR whose cache is stale are NEVER skipped,
  // so we never miss a real out-of-stock. The periodic inventory watch is a
  // further safety net.
  const MAX_CHECKS_PER_CYCLE = 10;
  const intervalSec        = (config.sync_interval_minutes ?? 60) * 60;
  const recentCheckCutoff  = Math.floor(Date.now() / 1000) - intervalSec;
  const cacheStmt = db.prepare(
    'SELECT MAX(synced_at) AS last, MIN(quantity) AS minq FROM listing_inventory WHERE listing_id = ? AND is_enabled = 1'
  );

  let skippedFresh = 0;
  const candidates = [...listingIds].filter((lid) => {
    const c = cacheStmt.get(lid);
    const checkedRecently = c && c.last != null && c.last >= recentCheckCutoff;
    const healthy         = c && c.minq != null && c.minq > 0;
    if (checkedRecently && healthy) { skippedFresh++; return false; }
    return true;
  });

  const ranked = candidates
    .map((lid) => ({ lid, priority: orderCheckPriority(db, lid, twoHoursAgo) }))
    .sort((a, b) => b.priority - a.priority);

  const toCheck = ranked.slice(0, MAX_CHECKS_PER_CYCLE).map((r) => r.lid);

  if (skippedFresh > 0) {
    console.log(`${label}: skipped ${skippedFresh} listing(s) already live-checked & healthy within the last ${Math.round(intervalSec / 60)}m (saved ${skippedFresh} API call(s))`);
  }

  if (!toCheck.length) {
    return; // everything ordered recently is already fresh & healthy — 0 API calls
  }

  if (listingIds.size > MAX_CHECKS_PER_CYCLE) {
    console.warn(
      `${label}: ${listingIds.size} ordered listing(s) — live-checking top ${MAX_CHECKS_PER_CYCLE} by priority this cycle`
    );
  } else {
    console.log(`${label}: live-checking ${toCheck.length} ordered listing(s)`);
  }

  // ── Phase 2: for each listing that needs checking, GET → maybe PUT ─────────
  // 300 ms inter-call pause keeps us comfortably under the 5 QPS wall even
  // when the entire cap of 10 listings needs checking back-to-back.
  for (const [idx, listingId] of toCheck.entries()) {
    if (idx > 0) await sleep(300);
    heartbeat?.();
    try {
      // Fetch live inventory from Etsy and immediately refresh the local cache
      const inv = await getListingInventory(shopClient, listingId);
      for (const product of (inv.products || [])) {
        for (const offering of (product.offerings || [])) {
          upsertListingInventory(db, listingId, product, offering);
        }
      }

      const listingTitle = db.prepare('SELECT title FROM listings WHERE listing_id = ?')
        .get(listingId)?.title || `Listing ${listingId}`;

      const { styles: zeroArr, hasZero } = getZeroStylesForListing(db, listingId);

      if (!hasZero) {
        console.log(`${label}: listing ${listingId} — live check OK, no zero offerings`);
        continue;
      }

      const styleLabel = formatStyleLabel(zeroArr);

      if (!autoRestock) {
        logZeroStockIfNeeded(db, {
          event_type:    'ZERO_STOCK',
          shop_name:      shop.shop_id,
          listing_id:     listingId,
          listing_title:  listingTitle,
          style_value:    styleLabel,
          detail:         `Order-triggered check: zero stock in [${styleLabel}]. Auto-restock is disabled — restock manually.`,
        });
        continue;
      }

      // Restock: top-up every low offering to restockQty (never reduce healthy
      // stock), then PUT the full inventory back.
      const restockedCount = raiseOfferingsToTarget(inv, restockQty);
      await updateListingInventory(shopClient, listingId, inv);

      // Refresh cache after restock
      for (const product of (inv.products || [])) {
        for (const offering of (product.offerings || [])) {
          upsertListingInventory(db, listingId, product, offering);
        }
      }

      console.log(`${label}: ✓ listing ${listingId} — restocked ${restockedCount} offering(s) → qty ${restockQty}`);
      logEvent(db, {
        event_type:    'ORDER_RESTOCK',
        shop_name:      shop.shop_id,
        listing_id:     listingId,
        listing_title:  listingTitle,
        style_value:    styleLabel,
        detail:         `New order triggered restock: [${styleLabel}] had zero stock → all ${restockedCount} offering(s) reset to qty ${restockQty}`,
        meta:           { triggered_by: 'new_order', zero_styles: zeroArr, restocked_count: restockedCount, new_quantity: restockQty },
      });

    } catch (err) {
      // Out of daily budget — stop the post-sync inventory sweep entirely rather
      // than logging a failure for every remaining listing. The receipts were
      // already synced above; restocks resume on the next cycle once budget frees.
      if (isQpdExhaustedError(err)) {
        console.warn(`${label}: inventory check paused — ${err.message}`);
        throw err; // bubble to syncShop so the cycle marks this key rate-limited
      }
      // A transport-level failure (e.g. "socket hang up") never reaches Etsy, so
      // there is no HTTP response/status. Don't mislabel it as a server 500 —
      // surface it as a network error so it isn't mistaken for an Etsy outage.
      const hasResponse = !!err.response;
      const status   = err.response?.status ?? err.status ?? null;
      const errMsg   = err.response?.data?.error || err.message;
      const isAuth   = status === 403;
      const isNetwork = !hasResponse;
      const statusLabel = status ?? 'network';
      console.error(`${label}: ✗ listing ${listingId} failed (${statusLabel}): ${errMsg}`);

      const listingTitle = db.prepare('SELECT title FROM listings WHERE listing_id = ?')
        .get(listingId)?.title || `Listing ${listingId}`;

      let detail;
      if (isAuth) {
        detail = `Order-triggered restock failed (403): listings_w scope required. Re-run "npm run oauth:setup".`;
      } else if (isNetwork) {
        detail = `Order-triggered restock failed (network): ${errMsg} — transient connection error, will retry on the next sync cycle.`;
      } else {
        detail = `Order-triggered restock failed (${statusLabel}): ${errMsg}`;
      }

      logEvent(db, {
        event_type:    'RESTOCK_FAILED',
        shop_name:      shop.shop_id,
        listing_id:     listingId,
        listing_title:  listingTitle,
        detail,
        meta:           { status, error: errMsg, code: err.code ?? null, transient: isNetwork, triggered_by: 'new_order', needs_reauth: isAuth },
      });
    }
  }
}

// ─── Per-shop sync ────────────────────────────────────────────────────────────

/**
 * Sync a single shop: fetch recent receipts from Etsy, write to SQLite.
 *
 * @param {object} shop       - Shop config entry (with group_id, proxy, api_key etc.)
 * @param {object} group      - Group config entry
 * @param {object} config     - Full app config
 * @param {object} proxyClient - Axios instance for this group's proxy chain
 * @param {TokenManager} tokenManager
 * @param {import('better-sqlite3').Database} db
 * @param {string|null} [egressIp]
 * @param {object} [options]
 * @param {boolean}  [options.fullBackfill=false] - Paginate the shop's ENTIRE
 *        order history (first order → today) instead of just the newest page.
 * @param {(progress:{written:number,shop_id:string})=>void} [options.onProgress]
 *        Called after every written batch so callers can stream live progress.
 */
async function syncShop(shop, group, config, proxyClient, tokenManager, db, egressIp = null, options = {}) {
  const { fullBackfill = false, onProgress = null, heartbeat = null } = options;
  const label = `[sync] ${shop.shop_name} (${group.group_id})`;
  const logId = startSyncLog(db, shop.shop_id, group.group_id, egressIp);

  let receiptsWritten = 0;

  // Listing IDs from recently-created orders — used for the order-triggered
  // inventory check that runs after both sync passes complete.
  // Only orders created within the last 2 × sync_interval are considered
  // "recent enough" to warrant a live inventory check.
  const orderListingIds   = new Set();
  const recentOrderCutoff = Math.floor(Date.now() / 1000) - (config.sync_interval_minutes ?? 60) * 2 * 60;

  try {
    // ── 1. Obtain fresh access token through group proxy ──────────────────────
    let accessToken;
    try {
      accessToken = await tokenManager.getAccessToken(
        shop.shop_id,
        shop.api_key,
        shop.refresh_token ?? null,
        proxyClient,
      );
    } catch (err) {
      if (err instanceof TokenExpiredError) {
        console.warn(`${label} Token expired — re-run oauth:setup for this shop`);
        finishSyncLog(db, logId, 'error', 0, err.message);
        return;
      }
      throw err;
    }

    // ── 2. Build authenticated client for this shop ───────────────────────────
    // Pass a fresh-token provider so the client auto-refreshes (and retries once
    // on a 401) if a long sync cycle outlives the 1h access token.
    const getToken = async (forceRefresh) => {
      if (forceRefresh) tokenManager.invalidate(shop.shop_id);
      return tokenManager.getAccessToken(shop.shop_id, shop.api_key, shop.refresh_token ?? null, proxyClient);
    };
    const shopClient = buildShopClient(
      proxyClient,
      shop.api_key,
      shop.shared_secret,
      accessToken,
      getToken,
      // Fail closed: a proxied group must never egress on the server's own IP.
      { requireProxy: usesGroupProxy(group) },
    );

    // ── 3. Resolve shop name → numeric ID (cached after first call) ───────────
    const numericId = await resolveShopId(shopClient, shop.shop_id);

    // ── 3b. Refresh the persisted active-listing count (THROTTLED) ────────────
    // The Etsy Shop object exposes listing_active_count directly, but it's a
    // cosmetic figure that barely moves. It is analytics metadata under Etsy's
    // Aug 2026 API Terms, so we fetch it only under the same written-approval +
    // collection opt-ins as catalog health, and then at most once per TTL.
    // Non-fatal: a failure here must never abort the receipt sync.
    const lastCount = _lastListingCountRefresh.get(shop.shop_id) ?? 0;
    const optionalAnalyticsApproved =
      config.catalog_health_sync === true &&
      config.etsy_api_analytics_approved === true;
    if (optionalAnalyticsApproved && Date.now() - lastCount >= LISTING_COUNT_TTL_MS) {
      try {
        const shopData = await getShop(shopClient, shop.shop_id);
        if (shopData) {
          updateShopHealth(db, shop.shop_id, shopData);
          if (shopData.listing_active_count != null) {
            console.log(`${label} Active listings: ${shopData.listing_active_count}`);
          }
        }
        _lastListingCountRefresh.set(shop.shop_id, Date.now());
      } catch (err) {
        console.warn(`${label} Listing-count refresh failed (non-fatal): ${err.message}`);
      }
    }

    // ── 4. Paginate receipts ──────────────────────────────────────────────────
    // Regular sync: only the newest `max_orders_per_sync` receipts.
    // Full backfill: every receipt from the shop's first order to today.
    const maxPerSync = fullBackfill ? Infinity : (config.max_orders_per_sync ?? 100);
    console.log(
      fullBackfill
        ? `${label} FULL BACKFILL — fetching ALL receipts (first order → today)...`
        : `${label} Fetching up to ${maxPerSync} receipts...`
    );

    // Prepare a fast lookup: which listing_ids already have cached images?
    const cachedImgCheck = db.prepare('SELECT 1 FROM listing_images WHERE listing_id = ?');
    let variationFetchesThisShop = 0;

    // Helper: write a batch of receipts to DB + cache listing images
    const writeBatch = async (batch) => {
      const insertBatch = db.transaction(() => {
        for (const receipt of batch) {
          upsertReceipt(db, shop.shop_id, group.group_id, receipt);
          receiptsWritten++;

          // Persist line-item transactions so earnings can attribute the 6.5%
          // transaction fee (ledger ref_type=transaction) back to this receipt.
          for (const tx of (receipt.transactions ?? [])) {
            if (tx && tx.transaction_id) {
              upsertTransaction(db, shop.shop_id, { ...tx, receipt_id: tx.receipt_id ?? receipt.receipt_id });
            }
          }

          // Collect listing IDs from recent orders for the post-sync inventory check.
          // Pass A receipts are sorted newest-first; only collect those created within
          // the last 2 sync intervals so we don't re-check stale orders every cycle.
          if ((receipt.create_timestamp ?? 0) >= recentOrderCutoff) {
            for (const tx of (receipt.transactions ?? [])) {
              if (tx.listing_id) orderListingIds.add(tx.listing_id);
            }
          }
        }
      });
      insertBatch();
      console.log(`${label} Wrote batch of ${batch.length} receipts (total so far: ${receiptsWritten})`);
      if (typeof onProgress === 'function') {
        try { onProgress({ shop_id: shop.shop_id, written: receiptsWritten }); }
        catch { /* progress reporting must never break the sync */ }
      }
      heartbeat?.();

      const listingIds = [...new Set(
        batch.flatMap((r) => (r.transactions ?? []).map((t) => t.listing_id))
      )].filter((id) => id);

      const uncachedIds = listingIds.filter((id) => !cachedImgCheck.get(id));
      const remainingVarBudget = MAX_VARIATION_IMAGE_FETCHES_PER_SHOP - variationFetchesThisShop;
      const staleVarIds = remainingVarBudget > 0
        ? listingIdsNeedingVariationRefresh(db, listingIds, VARIATION_IMAGE_TTL_SEC)
            .slice(0, remainingVarBudget)
        : [];

      const catalogIds = [...new Set([...uncachedIds, ...staleVarIds].map(Number).filter(Boolean))];
      let catalog = new Map();
      if (catalogIds.length > 0) {
        catalog = await getListingImageCatalogBatch(shopClient, catalogIds);
        if (catalog.size > 0) {
          const saveImages = db.transaction(() => {
            for (const [listingId, entry] of catalog) {
              if (entry?.heroUrl) upsertListingImage(db, listingId, entry.heroUrl);
            }
          });
          saveImages();
          const heroCount = [...catalog.values()].filter((e) => e?.heroUrl).length;
          if (heroCount) console.log(`${label} Cached ${heroCount} listing image(s)`);
        }
      }

      if (staleVarIds.length > 0) {
        const fetched = await cacheStyleVariationImages({
          db,
          shopClient,
          shopId: numericId,
          listingIds: staleVarIds,
          catalog,
          label,
          heartbeat,
        });
        variationFetchesThisShop += fetched;
      }
    };

    // Pass A: receipts by creation date (newest first).
    // Regular sync caps at maxPerSync; full backfill walks every page to the
    // shop's very first order. upsertReceipt is an UPSERT, so re-running a
    // backfill safely refreshes existing rows and adds any missing ones.
    for await (const batch of paginateReceipts(shopClient, numericId, {
      maxTotal: maxPerSync,
      sort_on: 'created',
      sort_order: 'desc',
    })) {
      await writeBatch(batch);
    }

    // Pass B: receipts updated in the last 14 days — catches tracking status
    // transitions for recently shipped orders and ensures orders in the full
    // pre_transit_days window (default 14 days) have fresh data.
    // Skipped during a full backfill because Pass A already pulled every order.
    if (!fullBackfill) {
      const fourteenDaysAgo = Math.floor(Date.now() / 1000) - 14 * 24 * 3600;
      console.log(`${label} Fetching recently-updated receipts (last 14 days)...`);
      // One page (100) instead of two: this pass only refreshes Etsy-side changes
      // (refunds, address/message edits) for recently-updated orders. Carrier
      // status is handled separately by the 4PX tracking poller (Pass D) and local
      // completion now stamps shipment_notified_at itself, so a second page is
      // rarely needed and not worth the extra QPD on every cycle.
      for await (const batch of paginateReceipts(shopClient, numericId, {
        maxTotal: 100,
        min_last_modified: fourteenDaysAgo,
        sort_on: 'updated',
        sort_order: 'desc',
      })) {
        await writeBatch(batch);
      }
    }

    // Backfill Etsy style photos for still-open orders whose listings were
    // already in listing_images (so writeBatch skipped them historically).
    const remainingVar = MAX_VARIATION_IMAGE_FETCHES_PER_SHOP - variationFetchesThisShop;
    if (remainingVar > 0) {
      try {
        const openListingIds = db.prepare(`
          SELECT DISTINCT t.listing_id
          FROM transactions t
          JOIN receipts r ON r.receipt_id = t.receipt_id
          WHERE r.shop_id = ?
            AND t.listing_id IS NOT NULL
            AND r.is_shipped = 0
            AND r.status NOT IN ('Canceled','Cancelled','Fully Refunded','Fully refunded')
        `).all(shop.shop_id).map((row) => row.listing_id);
        const stale = listingIdsNeedingVariationRefresh(db, openListingIds, VARIATION_IMAGE_TTL_SEC)
          .slice(0, remainingVar);
        if (stale.length) {
          heartbeat?.();
          const catalog = await getListingImageCatalogBatch(shopClient, stale);
          await cacheStyleVariationImages({
            db,
            shopClient,
            shopId: numericId,
            listingIds: stale,
            catalog,
            label,
            heartbeat,
          });
        }
      } catch (err) {
        console.warn(`${label} Style-variation backfill skipped (non-fatal): ${err.message}`);
      }
    }

    // ── 5. Order-triggered inventory check ───────────────────────────────────
    // For every listing that appeared in a recently-created order, refresh
    // its live inventory from Etsy. If any offering is at zero, auto-restock.
    // This fires inside the current sync window so restocks happen within
    // minutes of a sale rather than waiting for the 4-hour periodic sweep.
    if (orderListingIds.size > 0) {
      console.log(`${label} Order-triggered inventory check for ${orderListingIds.size} listing(s)…`);
      heartbeat?.();
      await checkAndRestockForOrders(orderListingIds, shopClient, shop, config, db, { heartbeat });
    }

    // ── 5b. Catalog health (views / reviews / expired counts) ────────────────
    // Non-fatal except QPD exhaustion, which the outer handler uses to skip the
    // rest of this API key. Default cadence is once per shop per 24h.
    // Fail closed: Etsy API Terms §5(25) require express written authorization
    // for API analytics. A sync opt-in alone is never enough.
    if (config.catalog_health_sync === true && config.etsy_api_analytics_approved === true) {
      try {
        heartbeat?.();
        await maybeSyncShopCatalogHealth({
          db,
          shopClient,
          numericShopId: numericId,
          shopId: shop.shop_id,
          shopName: shop.shop_name,
          analyticsApproved: config.etsy_api_analytics_approved,
          intervalHours: config.catalog_health_interval_hours,
          heartbeat,
        });
      } catch (err) {
        if (isQpdExhaustedError(err)) throw err;
        console.warn(`${label} Catalog health skipped (non-fatal): ${err.message}`);
      }
    }

    // ── 6. Update shop metadata + finish log ──────────────────────────────────
    updateShopSyncTime(db, shop.shop_id);
    finishSyncLog(db, logId, 'success', receiptsWritten);
    console.log(`${label} Done — ${receiptsWritten} receipts synced`);
    return { status: 'success', shop_id: shop.shop_id, api_key: shop.api_key };

  } catch (err) {
    if (err?.code === 'ETSY_LOCK_LOST') {
      finishSyncLog(db, logId, 'error', receiptsWritten, err.message);
      throw err;
    }
    // QPD exhaustion is a transient, self-resolving budget condition shared by
    // every shop on the same API key — NOT a per-shop failure. Record it as a
    // distinct, non-alarming 'rate_limited' status (rendered amber, not red) and
    // tell the caller so it can skip the remaining shops on this key for the
    // rest of the cycle instead of stampeding a key that's already spent.
    if (isQpdExhaustedError(err)) {
      console.warn(`${label} Skipped — ${err.message}`);
      finishSyncLog(db, logId, 'rate_limited', receiptsWritten, err.message);
      return {
        status: 'rate_limited',
        shop_id: shop.shop_id,
        api_key: shop.api_key,
        resetAt: err.resetAt ?? null,
      };
    }
    console.error(`${label} Sync failed: ${err.message}`);
    finishSyncLog(db, logId, 'error', receiptsWritten, err.message);
    return { status: 'error', shop_id: shop.shop_id, api_key: shop.api_key };
  }
}

// ─── Earnings: payment-account ledger sync ────────────────────────────────────

/**
 * Sync a shop's payment-account ledger into the local DB so the Finance tab can
 * report exact, per-shop earnings in the shop's payout currency.
 *
 * Strategy:
 *   1. Window: full backfill walks from `since` (default ~2015) → now; an
 *      incremental run starts a few days before the last high-water mark.
 *   2. Stream ledger pages, buffering entries and collecting the payment_ids
 *      referenced by gross/processing-fee entries.
 *   3. Resolve those payment_ids → receipt_ids via /payments and persist the map
 *      FIRST, so each ledger entry can attribute to its order on upsert.
 *   4. Upsert all entries, then re-attribute any stragglers and advance the
 *      high-water mark.
 *
 * @returns {Promise<{ entries: number, attributed: number }>}
 */
async function syncLedgerForShop(shop, group, config, proxyClient, tokenManager, db, options = {}) {
  const { fullBackfill = false, onProgress = null, heartbeat = null } = options;
  const label = `[ledger] ${shop.shop_name}`;

  const accessToken = await tokenManager.getAccessToken(
    shop.shop_id, shop.api_key, shop.refresh_token ?? null, proxyClient
  );
  const getToken = async (force) => {
    if (force) tokenManager.invalidate(shop.shop_id);
    return tokenManager.getAccessToken(shop.shop_id, shop.api_key, shop.refresh_token ?? null, proxyClient);
  };
  const shopClient = buildShopClient(proxyClient, shop.api_key, shop.shared_secret, accessToken, getToken, {
    requireProxy: usesGroupProxy(group), // fail closed for proxied groups
  });
  await resolveShopId(shopClient, shop.shop_id);

  const now = Math.floor(Date.now() / 1000);
  // Etsy rejects ledger windows that span too long (HTTP 400), so we walk the
  // history in fixed chunks. Bound the start to the shop's earliest order
  // (minus a buffer) so we never scan years before the shop existed.
  const CHUNK = 30 * 86400; // 30-day windows — safely inside Etsy's span limit
  const EARLIEST = 1420070400; // 2015-01-01 hard floor

  let minCreated;
  if (fullBackfill) {
    const firstReceipt = db.prepare('SELECT MIN(etsy_created_at) AS m FROM receipts WHERE shop_id = ?').get(shop.shop_id)?.m;
    minCreated = firstReceipt ? Math.max(EARLIEST, firstReceipt - 7 * 86400) : now - 3 * 365 * 86400;
  } else {
    const hw = db.prepare('SELECT ledger_synced_at FROM shops WHERE shop_id = ?').get(shop.shop_id)?.ledger_synced_at;
    minCreated = hw ? Math.max(EARLIEST, hw - 5 * 86400) : now - 3 * 365 * 86400; // 5-day overlap
  }

  console.log(`${label} ${fullBackfill ? 'FULL' : 'incremental'} ledger sync from ${new Date(minCreated * 1000).toISOString().slice(0, 10)} in ${Math.ceil((now - minCreated) / CHUNK)} window(s)…`);

  const buffer = [];
  const paymentIds = new Set();
  let maxDate = minCreated;

  for (let winStart = minCreated; winStart <= now; winStart += CHUNK) {
    heartbeat?.();
    const winEnd = Math.min(winStart + CHUNK - 1, now);
    for await (const page of paginateLedgerEntries(shopClient, shop.shop_id, { minCreated: winStart, maxCreated: winEnd })) {
      for (const e of page) {
        buffer.push(e);
        const rt = String(e.reference_type || '').toLowerCase();
        if ((rt === 'shop_payment' || rt === 'processing_fee' || rt === 'payment') && e.reference_id != null) {
          paymentIds.add(String(e.reference_id));
        }
        const d = e.create_date ?? e.created_timestamp ?? 0;
        if (d > maxDate) maxDate = d;
      }
      if (typeof onProgress === 'function') {
        try { onProgress({ shop_id: shop.shop_id, entries: buffer.length }); } catch { /* ignore */ }
      }
      heartbeat?.();
    }
  }

  // Resolve payment_id → receipt_id and persist BEFORE upserting entries so
  // gross/processing-fee rows attribute on insert.
  if (paymentIds.size > 0) {
    try {
      const map = await getPaymentReceiptMap(shopClient, shop.shop_id, [...paymentIds]);
      const saveMap = db.transaction(() => {
        for (const [pid, rid] of map) upsertEtsyPayment(db, shop.shop_id, pid, rid);
      });
      saveMap();
      console.log(`${label} mapped ${map.size}/${paymentIds.size} payment(s) → receipts`);
    } catch (err) {
      console.warn(`${label} payment→receipt mapping failed (non-fatal): ${err.message}`);
    }
  }

  const saveEntries = db.transaction(() => {
    for (const e of buffer) upsertLedgerEntry(db, shop.shop_id, e);
  });
  saveEntries();

  const reattributed = reattributeLedgerEntries(db, shop.shop_id);
  if (maxDate > minCreated) updateShopLedgerSyncTime(db, shop.shop_id, maxDate);

  const attributed = db.prepare(
    'SELECT COUNT(*) AS n FROM ledger_entries WHERE shop_id = ? AND receipt_id IS NOT NULL'
  ).get(shop.shop_id).n;

  console.log(`${label} done — ${buffer.length} entr${buffer.length === 1 ? 'y' : 'ies'} synced, ${reattributed} re-attributed, ${attributed} order-linked`);
  return { entries: buffer.length, attributed };
}

// ─── Per-group sync cycle ─────────────────────────────────────────────────────

/**
 * Run one sync cycle for all shops in a group.
 * Verifies the proxy first; skips the entire group if it fails.
 *
 * Shops are staggered using a stable hash offset + random jitter so they
 * never all fire at the same second.
 *
 * @param {object} group
 * @param {object[]} shopsInGroup - Shops belonging to this group that have tokens
 * @param {object} config
 * @param {TokenManager} tokenManager
 * @param {import('better-sqlite3').Database} db
 */
async function syncGroup(group, shopsInGroup, config, tokenManager, db, options = {}) {
  const heartbeat = options.heartbeat || null;
  const label = `[sync] group:${group.group_id}`;

  // Verify network path before touching any shops — fail closed regardless of routing type.
  // createGroupProxyClient / verifyGroupProxy both dispatch on usesGroupProxy() internally,
  // so the same call works for both VPN→IPFoxy chains and direct (no-proxy) groups.
  let proxyClient;
  let egressIp;
  const isDirect = !usesGroupProxy(group);
  try {
    egressIp = await verifyGroupProxy(group, config.vpn_local_port);
    proxyClient = createGroupProxyClient(group, config.vpn_local_port);
    if (isDirect) {
      console.log(`${label} Direct connection confirmed — egress IP: ${egressIp}`);
    } else {
      console.log(`${label} Proxy verified — exit IP: ${egressIp}`);
    }
    // OpSec: if the operator pinned the group's expected egress IP, refuse to sync
    // when the observed exit IP doesn't match — a proxy rotation or VPN leak would
    // otherwise expose these shops on an unexpected IP.
    if (!egressIpAllowed(group, egressIp)) {
      console.error(
        `${label} EGRESS IP MISMATCH — expected ${JSON.stringify(group.expected_egress_ip)}, ` +
        `observed ${egressIp}. Skipping all shops in this group this cycle (fail-closed). ` +
        `Fix the proxy/VPN or update expected_egress_ip in config.json.`
      );
      return;
    }
  } catch (err) {
    if (isDirect) {
      console.error(
        `${label} NETWORK CHECK FAILED — skipping all shops in this group this cycle.\n` +
        `  Reason: ${err.message}`
      );
    } else {
      console.error(
        `${label} PROXY VERIFICATION FAILED — skipping all shops in this group this cycle.\n` +
        `  Reason: ${err.message}\n` +
        `  Fix: ensure VPN is connected and IPFoxy proxy is active before next sync.`
      );
    }
    return;
  }

  // ── Stagger shops within the group ────────────────────────────────────────
  // Shops already run sequentially, so the queue itself staggers them.
  // We add a small per-shop stable offset (0–60s) + random jitter (0–30s)
  // so the same shop doesn't always fire at the exact same second each cycle.
  const windowMs    = 60  * 1000; // stable hash offset: 0–60 seconds
  const maxJitterMs = 30  * 1000; // random jitter on top: 0–30 seconds

  // QPD is enforced per API key. Once a key's daily budget is spent, every shop
  // sharing that key would fail identically — so we record the spent key and
  // skip its remaining shops for the rest of this cycle. This turns a wall of
  // red "budget exhausted" errors (one per shop) into a single amber notice and
  // avoids stampeding a key that's already over budget. The next cycle retries
  // automatically once the sliding window has freed budget.
  const exhaustedKeys = new Set();

  for (const shop of shopsInGroup) {
    if (exhaustedKeys.has(shop.api_key)) {
      console.log(
        `${label} Skipping ${shop.shop_name} — daily API budget for its key is exhausted this cycle; will resume next cycle.`
      );
      continue;
    }

    const delayMs = stableOffset(shop.shop_id, windowMs) + jitter(maxJitterMs);
    const delaySec = Math.round(delayMs / 1000);
    console.log(`${label} Scheduling ${shop.shop_name} in ~${delaySec}s`);
    await sleep(delayMs);
    heartbeat?.();

    const result = await syncShop(shop, group, config, proxyClient, tokenManager, db, egressIp, { heartbeat });

    if (result?.status === 'rate_limited' && shop.api_key) {
      exhaustedKeys.add(shop.api_key);
      const siblings = shopsInGroup.filter(
        (s) => s.api_key === shop.api_key && s.shop_id !== shop.shop_id
      ).length;
      console.warn(
        `${label} API key for ${shop.shop_name} is rate-limited` +
          (siblings ? ` — pausing ${siblings} more shop(s) on that key until the window resets.` : '.')
      );
    }
  }
}

// ─── Pass D: Carrier tracking status check ────────────────────────────────────

/**
 * Resolve bounded, defensive settings for the independent 4PX tracking worker.
 * Config validation also normalizes these values, but this function protects
 * direct/test callers and keeps all polling math in one source of truth.
 *
 * @param {object} config
 */
function getTrackingPollSettings(config = {}) {
  const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  return {
    enabled: config.fourpx_tracking_sync !== false,
    intervalMinutes: Math.round(clamp(finite(config.fourpx_tracking_interval_minutes, 15), 5, 24 * 60)),
    windowDays: Math.round(clamp(finite(config.fourpx_tracking_window_days, 120), 30, 365)),
    longTailRecheckHours: clamp(finite(config.fourpx_tracking_long_tail_recheck_hours, 168), 24, 30 * 24),
    preRecheckHours: clamp(finite(config.fourpx_tracking_pre_recheck_hours, 2), 0.25, 72),
    transitRecheckHours: clamp(finite(config.fourpx_tracking_transit_recheck_hours, 6), 0.5, 168),
    maxPerCycle: Math.round(clamp(finite(config.fourpx_tracking_max_per_cycle, 250), 1, 1000)),
    requestDelayMs: Math.round(clamp(finite(config.fourpx_tracking_request_delay_ms, 250), 100, 5000)),
    errorRetryMinutes: clamp(finite(config.fourpx_tracking_error_retry_minutes, 15), 1, 120),
    errorRetryMaxMinutes: clamp(finite(config.fourpx_tracking_error_retry_max_minutes, 120), 5, 24 * 60),
  };
}

/**
 * Shared candidate window/freshness parameters.
 * @param {object} settings
 * @param {number} [nowEpoch]
 */
function trackingCandidateParams(settings, nowEpoch = Math.floor(Date.now() / 1000)) {
  return {
    nowEpoch,
    windowCutoff: nowEpoch - settings.windowDays * 86400,
    longTailCutoff: nowEpoch - settings.longTailRecheckHours * 3600,
    preCutoff: nowEpoch - settings.preRecheckHours * 3600,
    transitCutoff: nowEpoch - settings.transitRecheckHours * 3600,
  };
}

const TRACKING_SHIP_DATE_SQL = 'COALESCE(r.shipment_notified_at, r.fourpx_created_at, r.etsy_created_at)';
// 4PX's official lookup accepts its own number or a downstream provider number;
// neither is contractually required to start with "4PX". The dedicated
// fourpx_tracking_no column or a 4PX consignment proves carrier ownership.
const TRACKING_LOOKUP_NO_SQL = `COALESCE(
  NULLIF(TRIM(r.fourpx_tracking_no), ''),
  CASE
    WHEN r.fourpx_consignment_no IS NOT NULL OR r.tracking_code LIKE '4PX%'
    THEN NULLIF(TRIM(r.tracking_code), '')
  END
)`;
const TRACKING_LOOKUP_SCOPE_SQL = `(${TRACKING_LOOKUP_NO_SQL} IS NOT NULL)`;
// Older official-client builds sent an Accept header that made the 4PX gateway
// replace non-ASCII tracking text with '?' / U+FFFD. Those snapshots receive an
// accelerated rewrite cadence; once repaired, this predicate becomes false.
const TRACKING_CORRUPT_TEXT_SQL = `(
  INSTR(COALESCE(r.tracking_last_event, ''), '???') > 0
  OR INSTR(COALESCE(r.tracking_last_event, ''), '�') > 0
)`;

/**
 * Due predicate shared verbatim by count and selection.
 *
 * The hot window uses phase-specific cache TTLs. Older parcels are deliberately
 * not abandoned: an open parcel has no inferred terminal state, so it receives a
 * low-frequency long-tail check until 4PX reports delivery/disposal or an
 * operator archives it. Explicit error retries remain due at their own cadence.
 */
const TRACKING_DUE_SQL = `(
  r.tracking_checked_at IS NULL
  OR (
    ${TRACKING_CORRUPT_TEXT_SQL}
    AND r.tracking_last_error IS NULL
    AND r.tracking_checked_at < @preCutoff
  )
  OR (r.tracking_next_check_at IS NOT NULL AND r.tracking_next_check_at <= @nowEpoch)
  OR (
    r.tracking_next_check_at IS NULL
    AND (
      (
        ${TRACKING_SHIP_DATE_SQL} >= @windowCutoff
        AND (
          (r.carrier_confirmed_at IS NULL     AND r.tracking_checked_at < @preCutoff)
          OR (r.carrier_confirmed_at IS NOT NULL AND r.tracking_checked_at < @transitCutoff)
        )
      )
      OR (
        ${TRACKING_SHIP_DATE_SQL} < @windowCutoff
        AND r.tracking_checked_at < @longTailCutoff
      )
    )
  )
)`;

/**
 * Count parcels due for a live 4PX check. Kept alongside the selection query so
 * the status endpoint and worker cannot drift into different definitions of
 * "backlog".
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} settings
 * @param {number} [nowEpoch]
 */
function countTrackingCandidates(db, settings, nowEpoch = Math.floor(Date.now() / 1000)) {
  const params = trackingCandidateParams(settings, nowEpoch);
  return Number(db.prepare(`
    SELECT COUNT(*) AS n
    FROM receipts r
    WHERE ${TRACKING_LOOKUP_SCOPE_SQL}
      AND COALESCE(r.fourpx_order_status, '') != 'cancelled'
      AND r.archived_at IS NULL
      AND COALESCE(r.tracking_status, '') != 'delivered'
      AND r.tracking_delivered_at IS NULL
      AND ${TRACKING_DUE_SQL}
  `).get(params).n || 0);
}

/**
 * Query the 4PX tracking API for open parcels whose cached snapshot is due and
 * persist their latest event, canonical status, health and pickup/delivery time.
 *
 * This is the core engine that powers accurate Pre-transit detection.
 * The Etsy v3 API does NOT expose carrier scan status — only the carrier
 * itself knows if the package has been physically picked up. We call 4PX's
 * public tracking API (the same one powering track.4px.com) to check.
 *
 * Pre-transit signal (4PX):
 *   status=3  ("receive forecast") AND tracks=[{tkCategoryCode:"L"}]
 *   → Only "Parcel information received" event. Carrier has NOT scanned/picked up.
 *
 * In-transit signal:
 *   status=1 AND tracks includes non-"L" category events
 *   → Carrier physically scanned / picked up the package.
 *
 * Rate limiting strategy:
 *   - Unchecked orders (tracking_checked_at IS NULL) are prioritized.
 *   - Recently shipped orders use phase-specific freshness windows.
 *   - Older open orders receive a bounded weekly long-tail check; they are never
 *     inferred delivered merely because time passed.
 *   - At most `fourpx_tracking_max_per_cycle` parcels are processed per cycle.
 *   - Requests are serial and paced; one failure never aborts the remaining batch.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} config
 * @param {object} [options]
 * @param {(trackingNo:string, credentials:object)=>Promise<object>} [options.getSnapshot]
 * @param {()=>void} [options.heartbeat]
 * @param {(progress:object)=>void} [options.onProgress]
 * @returns {Promise<object>} aggregate run summary
 */
async function runTrackingCheckPass(db, config, options = {}) {
  const settings = getTrackingPollSettings(config);
  const nowEpoch = Math.floor(Date.now() / 1000);
  const params = {
    ...trackingCandidateParams(settings, nowEpoch),
    max: settings.maxPerCycle,
  };
  const getSnapshot = options.getSnapshot || getTrackingSnapshot;

  // Candidates: every open 4PX parcel whose snapshot is due. Hot-window
  // pre-transit parcels are refreshed frequently to detect pickup; moving parcels
  // less often; the older open tail remains on its bounded weekly cadence.
  // Never-checked parcels are most urgent; then abnormal health, pre-transit,
  // and finally the oldest cached checks. Prefer Etsy's buyer-visible tracking
  // number, with the dashboard-created 4PX number as a fallback.
  const trackingSelect = `
    SELECT
      r.receipt_id,
      ${TRACKING_LOOKUP_NO_SQL} AS tracking_no,
      r.carrier_name,
      r.shop_id,
      r.carrier_confirmed_at,
      r.tracking_status,
      r.tracking_health,
      r.tracking_checked_at
    FROM receipts r`;
  const explicitIds = [...new Set((options.receiptIds || [])
    .map(Number)
    .filter(Number.isInteger))]
    .slice(0, 50);
  const candidates = explicitIds.length
    ? db.prepare(`
        ${trackingSelect}
        WHERE r.receipt_id IN (${explicitIds.map(() => '?').join(',')})
          AND ${TRACKING_LOOKUP_SCOPE_SQL}
          AND COALESCE(r.fourpx_order_status, '') != 'cancelled'
          AND r.archived_at IS NULL
        ORDER BY r.receipt_id
      `).all(...explicitIds)
    : db.prepare(`
    ${trackingSelect}
    WHERE ${TRACKING_LOOKUP_SCOPE_SQL}
      AND COALESCE(r.fourpx_order_status, '') != 'cancelled'
      AND r.archived_at IS NULL
      AND COALESCE(r.tracking_status, '') != 'delivered'
      AND r.tracking_delivered_at IS NULL
      AND ${TRACKING_DUE_SQL}
    ORDER BY
      CASE WHEN r.tracking_checked_at IS NULL THEN 0 ELSE 1 END ASC,
      CASE WHEN r.tracking_next_check_at IS NOT NULL THEN 0 ELSE 1 END ASC,
      CASE WHEN ${TRACKING_SHIP_DATE_SQL} >= @windowCutoff THEN 0 ELSE 1 END ASC,
      CASE r.tracking_health WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END ASC,
      CASE WHEN r.carrier_confirmed_at IS NULL THEN 0 ELSE 1 END ASC,
      COALESCE(r.tracking_checked_at, 0) ASC,
      COALESCE(r.shipment_notified_at, r.fourpx_created_at, r.etsy_created_at) DESC
    LIMIT @max
  `).all(params);

  const summary = {
    candidateCount: candidates.length,
    checkedCount: 0,
    updatedCount: 0,
    preTransit: 0,
    inTransit: 0,
    delivered: 0,
    exception: 0,
    unknown: 0,
    errors: 0,
    backlogRemaining: 0,
  };
  if (options.includeResults) summary.results = [];

  if (!candidates.length) {
    console.log('[tracking] No parcels need a tracking check this cycle.');
    return summary;
  }

  console.log(`[tracking] Checking ${candidates.length} parcel(s) via ${config.fourpx_app_key ? '4PX Official API (authenticated)' : '4PX Public API (fallback)'}…`);
  safeTrackingHook(options.onProgress, {
    checked: 0,
    total: candidates.length,
    ...summary,
  }, 'progress');

  for (const [idx, order] of candidates.entries()) {
    if (idx > 0) await sleep(settings.requestDelayMs);
    if (typeof options.heartbeat === 'function' && options.heartbeat() === false) {
      const err = new Error('Tracking cycle lost its advisory lock; aborting to prevent duplicate polling.');
      err.code = 'TRACKING_LOCK_LOST';
      err.partialSummary = {
        ...summary,
        backlogRemaining: countTrackingCandidates(db, settings),
      };
      throw err;
    }

    const checkedAt = Math.floor(Date.now() / 1000);
    summary.checkedCount++;
    try {
      const snap = await getSnapshot(order.tracking_no, {
        appKey:    config.fourpx_app_key    ?? null,
        appSecret: config.fourpx_app_secret ?? null,
        stuckDays: config.fourpx_stuck_days ?? 10,
      });

      if (!snap?.ok) {
        // Transient error / not yet registered — record the attempt only so we
        // don't hammer it, and preserve any previously-known status (fail-open).
        summary.unknown++;
        if (!['unknown', 'not_found'].includes(String(snap?.status || '').toLowerCase())) {
          summary.errors++;
        }
        const failure = recordTrackingCheckFailure(db, order.receipt_id, {
          checkedAt,
          error: snap?.error || snap?.status || 'Tracking data unavailable',
          baseRetryMinutes: settings.errorRetryMinutes,
          maxRetryMinutes: settings.errorRetryMaxMinutes,
        });
        if (summary.results) {
          summary.results.push({
            receipt_id: order.receipt_id,
            tracking_no: order.tracking_no,
            ok: false,
            status: snap?.status || 'unknown',
            source: snap?.source || null,
            error: snap?.error || snap?.status || 'Tracking data unavailable',
            next_check_at: failure.nextCheckAt,
          });
        }
      } else {
        const firstScanAt =
          ['in_transit', 'delivered', 'exception'].includes(snap.status)
            ? (snap.firstScanAt ?? checkedAt)
            : null;

        if (snap.status === 'delivered') summary.delivered++;
        else if (snap.status === 'exception') summary.exception++;
        else if (snap.status === 'in_transit') summary.inTransit++;
        else summary.preTransit++;

        updateTrackingDetail(db, order.receipt_id, {
          status:       snap.status,
          firstScanAt,
          lastEventAt:  snap.lastEventAt,
          lastEvent:    snap.lastEvent,
          lastLocation: snap.lastLocation,
          deliveredAt:  snap.deliveredAt,
          health:       snap.health,
          checkedAt,
        });
        summary.updatedCount++;
        if (summary.results) {
          summary.results.push({
            receipt_id: order.receipt_id,
            tracking_no: order.tracking_no,
            ok: true,
            status: snap.status,
            events: snap.events || [],
            health: snap.health || null,
            source: snap.source || null,
          });
        }
      }
    } catch (err) {
      summary.errors++;
      summary.unknown++;
      const failure = recordTrackingCheckFailure(db, order.receipt_id, {
        checkedAt,
        error: err.message,
        baseRetryMinutes: settings.errorRetryMinutes,
        maxRetryMinutes: settings.errorRetryMaxMinutes,
      });
      console.warn(`[tracking] ${order.tracking_no} failed: ${err.message}`);
      if (summary.results) {
        summary.results.push({
          receipt_id: order.receipt_id,
          tracking_no: order.tracking_no,
          ok: false,
          status: 'error',
          error: err.message,
          next_check_at: failure.nextCheckAt,
        });
      }
    }

    if (idx === candidates.length - 1 || (idx + 1) % 10 === 0) {
      safeTrackingHook(options.onProgress, {
        checked: idx + 1,
        total: candidates.length,
        ...summary,
      }, 'progress');
    }
  }

  // This pass is where a parcel actually turns stuck or disposed, so it is the
  // honest place to date the incident. Reconciling here — rather than only when
  // a browser asks — is what lets the morning board say "flagged 6h ago" for
  // something detected overnight instead of "flagged just now".
  //
  // Bookkeeping, never a reason to fail a completed carrier sweep: the "new"
  // flag itself comes from the review ledger and stands without this.
  try {
    const ledger = syncShippingAlertLedger(db);
    summary.alertsOpened = ledger.opened;
    summary.alertsEscalated = ledger.escalated;
    summary.alertsClosed = ledger.closed;
    if (ledger.opened || ledger.escalated) {
      console.log(`[tracking] Morning review — ${ledger.opened} newly abnormal, ${ledger.escalated} escalated, ${ledger.closed} recovered.`);
    }
  } catch (err) {
    console.warn(`[tracking] Shipping alert ledger sync failed: ${err.message}`);
  }

  summary.backlogRemaining = countTrackingCandidates(db, settings);
  console.log(
    `[tracking] Done — ${summary.inTransit} in-transit, ${summary.delivered} delivered, ` +
    `${summary.exception} exception, ${summary.preTransit} pre-transit, ` +
    `${summary.unknown} unknown/error, ${summary.backlogRemaining} still due`
  );
  return summary;
}

/**
 * Atomically launch one independent tracking cycle.
 *
 * Returns immediately with a promise so HTTP callers can send 202 Accepted
 * without holding the request open for a potentially large 4PX batch.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} config
 * @param {object} [options]
 * @returns {{started:boolean, reason?:string, runId?:number, promise:Promise<object>}}
 */
function startTrackingCycle(db, config, options = {}) {
  const settings = getTrackingPollSettings(config);
  if (!settings.enabled && !options.ignoreDisabled) {
    return {
      started: false,
      reason: 'disabled',
      promise: Promise.resolve({ started: false, reason: 'disabled' }),
    };
  }
  if (_trackingCyclePromise) {
    return {
      started: false,
      reason: 'running',
      promise: Promise.resolve({ started: false, reason: 'running' }),
    };
  }
  if (!acquireLock(db, TRACKING_LOCK_NAME, SYNC_LOCK_OWNER, TRACKING_LOCK_TTL_SEC)) {
    return {
      started: false,
      reason: 'running',
      promise: Promise.resolve({ started: false, reason: 'running' }),
    };
  }

  const trigger = options.trigger || 'scheduled';
  const startedMs = Date.now();
  let runId;
  try {
    runId = startTrackingSyncRun(db, trigger);
  } catch (err) {
    releaseLock(db, TRACKING_LOCK_NAME, SYNC_LOCK_OWNER);
    throw err;
  }
  safeTrackingHook(options.onStart, { runId, trigger, startedAt: Math.floor(startedMs / 1000) }, 'start');

  const cycleToken = {};
  const promise = (async () => {
    try {
      const externalProgress = options.onProgress;
      const summary = await runTrackingCheckPass(db, config, {
        ...options,
        heartbeat: () => renewLock(db, TRACKING_LOCK_NAME, SYNC_LOCK_OWNER),
        onProgress: (progress) => {
          updateTrackingSyncRunProgress(db, runId, progress);
          safeTrackingHook(externalProgress, progress, 'progress');
        },
      });
      summary.durationMs = Date.now() - startedMs;
      summary.status = summary.errors > 0 ? 'partial' : 'success';
      finishTrackingSyncRun(db, runId, summary);
      const result = { started: true, runId, trigger, ...summary };
      safeTrackingHook(options.onComplete, result, 'complete');
      return result;
    } catch (err) {
      const partial = err.partialSummary || {};
      const failed = {
        ...partial,
        status: err.code === 'TRACKING_LOCK_LOST' ? 'interrupted' : 'error',
        durationMs: Date.now() - startedMs,
        backlogRemaining: partial.backlogRemaining ?? (() => {
          try { return countTrackingCandidates(db, settings); }
          catch { return 0; }
        })(),
        error: err.message,
      };
      finishTrackingSyncRun(db, runId, failed);
      safeTrackingHook(options.onError, { started: true, runId, trigger, ...failed }, 'error');
      throw err;
    } finally {
      releaseLock(db, TRACKING_LOCK_NAME, SYNC_LOCK_OWNER);
      if (_trackingCyclePromise?.token === cycleToken) _trackingCyclePromise = null;
    }
  })();
  _trackingCyclePromise = { token: cycleToken, promise };

  return { started: true, runId, promise };
}

/**
 * Awaiting wrapper used by scheduled/background code.
 */
async function runTrackingCycle(db, config, options = {}) {
  const launch = startTrackingCycle(db, config, options);
  return launch.promise;
}

/**
 * Read-only status model for the Shipping tab.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} config
 */
function getTrackingCycleStatus(db, config) {
  const settings = getTrackingPollSettings(config);
  const now = Math.floor(Date.now() / 1000);
  const lock = db.prepare('SELECT owner, acquired_at, heartbeat_at FROM app_locks WHERE name = ?')
    .get(TRACKING_LOCK_NAME);
  const running = !!(lock && (lock.heartbeat_at || 0) >= now - TRACKING_LOCK_TTL_SEC);
  const { windowCutoff } = trackingCandidateParams(settings, now);
  const fleet = db.prepare(`
    SELECT
      COUNT(*) AS tracked_count,
      SUM(CASE
        WHEN COALESCE(r.tracking_status, '') != 'delivered'
          AND r.tracking_delivered_at IS NULL
        THEN 1 ELSE 0 END) AS open_count,
      SUM(CASE
        WHEN r.tracking_checked_at IS NULL
          AND COALESCE(r.tracking_status, '') != 'delivered'
          AND r.tracking_delivered_at IS NULL
        THEN 1 ELSE 0 END) AS never_checked,
      SUM(CASE
        WHEN COALESCE(r.tracking_status, '') != 'delivered'
          AND r.tracking_delivered_at IS NULL
          AND ${TRACKING_SHIP_DATE_SQL} < @windowCutoff
        THEN 1 ELSE 0 END) AS long_tail_open_count,
      MAX(r.tracking_checked_at) AS last_checked_at
    FROM receipts r
    WHERE ${TRACKING_LOOKUP_SCOPE_SQL}
      AND COALESCE(r.fourpx_order_status, '') != 'cancelled'
      AND r.archived_at IS NULL
  `).get({ windowCutoff });

  let dueCount = 0;
  try { dueCount = countTrackingCandidates(db, settings, now); }
  catch { dueCount = 0; }

  let latest = getLatestTrackingSyncRun(db);
  // A process can die after writing "running" but before finishing the row. The
  // advisory-lock heartbeat is authoritative; present a stale run as interrupted
  // immediately instead of showing a permanent spinner until the next cycle.
  if (latest?.status === 'running' && !running) {
    latest = {
      ...latest,
      status: 'interrupted',
      error_message: latest.error_message || 'The previous process stopped before this refresh completed.',
    };
  }

  return {
    enabled: settings.enabled,
    running,
    interval_minutes: settings.intervalMinutes,
    window_days: settings.windowDays,
    long_tail_recheck_hours: settings.longTailRecheckHours,
    pre_recheck_hours: settings.preRecheckHours,
    transit_recheck_hours: settings.transitRecheckHours,
    max_per_cycle: settings.maxPerCycle,
    due_count: dueCount,
    tracked_count: Number(fleet.tracked_count || 0),
    open_count: Number(fleet.open_count || 0),
    long_tail_open_count: Number(fleet.long_tail_open_count || 0),
    never_checked: Number(fleet.never_checked || 0),
    last_checked_at: fleet.last_checked_at || null,
    latest,
  };
}

// ─── Pass E: 4PX freight (shipping-cost) sync ─────────────────────────────────

/**
 * Resolve the 4PX shipping cost for every order that has a consignment but isn't
 * yet billed. Each order is priced immediately from the rate card
 * (ds.xms.estimated_cost.get) and reconciled to the authoritative billed amount
 * (ds.xms.order.getFreight) once 4PX settles it. See src/fourpx/freight.js.
 *
 * Mirrors runTrackingCheckPass's rate-limiting discipline:
 *   - Orders never priced (fourpx_freight_fetched_at IS NULL) are prioritized.
 *   - 'estimated'/'pending' orders are re-checked at most once every
 *     FREIGHT_RECHECK_HOURS (to upgrade an estimate to the billed amount).
 *   - 'billed' orders are skipped entirely (cost is immutable).
 *   - At most MAX_FREIGHT_CHECKS_PER_CYCLE API calls per cycle, paced by a short sleep.
 *
 * Requires authenticated credentials (fourpx_app_key + fourpx_app_secret); no-ops
 * without them. Tolerant of partial failure — one bad order never aborts the pass.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} config
 */
async function runFreightSyncPass(db, config) {
  const appKey    = config.fourpx_app_key    ?? null;
  const appSecret = config.fourpx_app_secret ?? null;
  if (!appKey || !appSecret) {
    console.log('[freight] 4PX credentials not configured — skipping freight sync.');
    return;
  }
  // Operator kill-switch: lets a heavy account disable the extra API traffic.
  if (config.fourpx_freight_sync === false) {
    console.log('[freight] Disabled via config.fourpx_freight_sync=false — skipping.');
    return;
  }

  const FREIGHT_RECHECK_HOURS       = Number.isFinite(config.fourpx_freight_recheck_hours)
                                        ? config.fourpx_freight_recheck_hours : 6;
  const MAX_FREIGHT_CHECKS_PER_CYCLE = 150;
  const INTER_REQUEST_MS             = 150;

  const recheckCutoff = Math.floor(Date.now() / 1000) - FREIGHT_RECHECK_HOURS * 3600;

  // Candidates: orders with a 4PX consignment that aren't 'billed' yet (or never
  // priced), and weren't re-queried within the recheck window. Pull the fields the
  // resolver needs to compute an estimate (destination + product + declared weight).
  const candidates = db.prepare(`
    SELECT receipt_id, source, tracking_code, fourpx_consignment_no, fourpx_tracking_no,
           shipping_country_iso, fourpx_product_code, fourpx_weight_g, fourpx_freight_status
    FROM receipts
    WHERE (fourpx_consignment_no IS NOT NULL OR tracking_code LIKE '4PX%')
      AND COALESCE(fourpx_order_status, '') != 'cancelled'
      AND COALESCE(fourpx_freight_status, 'pending') != 'billed'
      AND (fourpx_freight_fetched_at IS NULL OR fourpx_freight_fetched_at < ?)
    ORDER BY
      CASE WHEN fourpx_freight_fetched_at IS NULL THEN 0 ELSE 1 END ASC,
      COALESCE(fourpx_created_at, etsy_created_at) DESC
    LIMIT ?
  `).all(recheckCutoff, MAX_FREIGHT_CHECKS_PER_CYCLE);

  if (!candidates.length) {
    console.log('[freight] No orders need a cost query this cycle.');
    return;
  }

  console.log(`[freight] Pricing ${candidates.length} order(s) via 4PX (estimate + reconcile)…`);

  let billed = 0, estimated = 0, pending = 0, errored = 0;

  for (const [idx, order] of candidates.entries()) {
    if (idx > 0) await sleep(INTER_REQUEST_MS);
    try {
      const r = await resolveReceiptFreight({ db, config, appKey, appSecret, receipt: order });
      if (r.status === 'billed') billed++;
      else if (r.status === 'estimated') estimated++;
      else if (r.status === 'error') errored++;
      else pending++;
    } catch (err) {
      errored++;
      console.warn(`[freight] receipt ${order.receipt_id} failed: ${err.message}`);
    }
  }

  console.log(`[freight] Done — ${billed} billed, ${estimated} estimated, ${pending} pending, ${errored} error(s).`);
}

// ─── Main sync cycle ──────────────────────────────────────────────────────────

async function runSyncCycle(config, tokenManager, db) {
  const launch = startEtsyWork(db, 'sync', async ({ heartbeat }) => {
    refreshConfigInPlace(config);
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`[sync] Cycle started at ${new Date().toISOString()} (owner ${SYNC_LOCK_OWNER})`);
    console.log('─'.repeat(60));

    const allShops = getAllShops(config);
    const shopsWithTokens = allShops.filter((s) => tokenManager.hasTokens(s.shop_id));

    if (shopsWithTokens.length === 0) {
      console.warn('[sync] No shops have tokens. Run: npm run oauth:setup');
      return { started: true, shops: 0 };
    }

    console.log(`[sync] ${shopsWithTokens.length}/${allShops.length} shops have tokens — syncing those`);

    // Group shops by group_id for proxy-isolated processing
    const byGroup = new Map();
    for (const shop of shopsWithTokens) {
      if (!byGroup.has(shop.group_id)) byGroup.set(shop.group_id, []);
      byGroup.get(shop.group_id).push(shop);
    }

    // Sync each group sequentially (each has its own proxy; no shared HTTP state)
    for (const [groupId, shops] of byGroup) {
      const group = config.groups.find((g) => g.group_id === groupId);
      if (!group) continue;
      heartbeat();
      await syncGroup(group, shops, config, tokenManager, db, { heartbeat });
    }

    // Pass E: pull the actual billed shipping cost (freight) from 4PX for every
    // order with a consignment that hasn't been billed yet.
    try {
      heartbeat();
      await runFreightSyncPass(db, config);
    } catch (err) {
      if (err?.code === 'ETSY_LOCK_LOST') throw err;
      console.error(`[freight] Freight sync pass failed: ${err.message}`);
    }

    const totalReceipts = db.prepare('SELECT COUNT(*) AS c FROM receipts').get().c;
    console.log(`\n[sync] Cycle complete — ${totalReceipts} total receipts in DB`);
    return { started: true, shops: shopsWithTokens.length, totalReceipts };
  });

  if (!launch.started) {
    console.warn(
      `[sync] Etsy work already running (${launch.kind || launch.reason}) — skipping this trigger.`
    );
    return launch;
  }
  return launch.promise;
}

// ─── Periodic inventory watch (safety net) ───────────────────────────────────

/**
 * Sweep the local cache for zero-stock variants, confirm live on Etsy, and
 * auto-restock (or alert) — one consolidated event per affected listing.
 *
 * Exported so the dashboard server can schedule it in-process (alongside the
 * order-triggered restock inside runSyncCycle). Reads cached zero rows first
 * (0 API calls), then spends at most 1 GET + 1 PUT per affected listing.
 *
 * Requires listings_w OAuth scope to restock. On 403, logs RESTOCK_FAILED.
 *
 * @param {object} config       - full app config
 * @param {TokenManager} tokenManager
 * @param {import('better-sqlite3').Database} db
 */
async function runInventoryWatchCycle(config, tokenManager, db) {
  const launch = startEtsyWork(db, 'inventory_watch', ({ heartbeat }) => {
    refreshConfigInPlace(config);
    return runInventoryWatchCycleBody(config, tokenManager, db, heartbeat);
  });
  if (!launch.started) {
    console.log(`[inventory-watch] Skipping — Etsy work already running (${launch.kind || launch.reason}).`);
    return launch;
  }
  return launch.promise;
}

async function runInventoryWatchCycleBody(config, tokenManager, db, heartbeat) {
  const RESTOCK_QTY = config.restock_quantity ?? 3;
  const autoRestock = isAutoRestockEnabled(config);

  console.log('\n[inventory-watch] Starting inventory check from local cache…');

  // Find all zero-stock offerings from our local DB cache
  const zeroRows = db.prepare(`
    SELECT li.listing_id, li.product_id, li.offering_id,
           li.style_value, li.secondary_value, li.synced_at,
           l.shop_id, l.title AS listing_title
    FROM listing_inventory li
    JOIN listings l ON l.listing_id = li.listing_id
    WHERE li.quantity = 0 AND li.is_enabled = 1 AND l.state = 'active'
  `).all();

  if (!zeroRows.length) {
    console.log('[inventory-watch] No zero-stock variants found in cache.');
    return;
  }

  console.log(`[inventory-watch] Found ${zeroRows.length} zero-stock variant(s).`);

  // Group by listing so we do one GET + one PUT per listing (not per offering)
  const byListing = {};
  for (const row of zeroRows) {
    if (!byListing[row.listing_id]) byListing[row.listing_id] = [];
    byListing[row.listing_id].push(row);
  }

  if (!autoRestock) {
    // Alert-only mode — log ONE event per listing (not per model row)
    for (const [, rows] of Object.entries(byListing)) {
      const { shop_id, listing_id, listing_title } = rows[0];
      const zeroStyles = [...new Set(rows.map((r) => r.style_value).filter(Boolean))];
      const styleLabel = formatStyleLabel(zeroStyles);
      logZeroStockIfNeeded(db, {
        event_type:    'ZERO_STOCK',
        shop_name:      shop_id,
        listing_id:     listing_id,
        listing_title:  listing_title,
        style_value:    styleLabel,
        detail:         `Zero stock detected for [${styleLabel}]. Auto-restock is disabled — restock manually.`,
      });
    }
    return;
  }

  const listingEntries = Object.entries(byListing);
  const capped = listingEntries.slice(0, MAX_INV_WATCH_CHECKS_PER_CYCLE);
  if (listingEntries.length > MAX_INV_WATCH_CHECKS_PER_CYCLE) {
    console.warn(
      `[inventory-watch] Capping sweep at ${MAX_INV_WATCH_CHECKS_PER_CYCLE} listing(s) this cycle ` +
      `(${listingEntries.length} zero-stock listings total — remainder next cycle). ` +
      'Unbounded inventory PUT bursts are an Etsy bot/abuse signal.'
    );
  }

  for (const [idx, [listingIdStr, rows]] of capped.entries()) {
    if (idx > 0) await sleep(300);
    if (idx % 5 === 0) heartbeat();

    const listingId = parseInt(listingIdStr);
    const { shop_id, listing_title } = rows[0];

    // Find the shop config and build a client
    let shopCfg, groupCfg;
    for (const grp of config.groups) {
      const s = grp.shops.find(sh => sh.shop_id === shop_id);
      if (s) { shopCfg = s; groupCfg = grp; break; }
    }
    if (!shopCfg) {
      console.warn(`[inventory-watch] No config for shop_id ${shop_id}`);
      continue;
    }

    try {
      const proxyClient = createGroupProxyClient(groupCfg, config.vpn_local_port);
      const accessToken = await tokenManager.getAccessToken(
        shopCfg.shop_id, shopCfg.api_key, shopCfg.refresh_token ?? null, proxyClient
      );
      const shopClient  = buildShopClient(proxyClient, shopCfg.api_key, shopCfg.shared_secret, accessToken, null, {
        requireProxy: usesGroupProxy(groupCfg), // fail closed for proxied groups
      });
      await resolveShopId(shopClient, shopCfg.shop_id);

      // Fetch live inventory — never restock from cache alone (avoids stale over-restock)
      const inv = await getListingInventory(shopClient, listingId);

      for (const product of (inv.products || [])) {
        for (const offering of (product.offerings || [])) {
          upsertListingInventory(db, listingId, product, offering);
        }
      }

      if (!listingHasLiveZero(inv)) {
        console.log(`[inventory-watch] Listing ${listingId} — cache showed zero but live stock OK; cache refreshed`);
        continue;
      }

      // Top-up every low offering to RESTOCK_QTY (never reduce healthy stock).
      const restockedCount = raiseOfferingsToTarget(inv, RESTOCK_QTY);

      if (restockedCount === 0) {
        console.log(`[inventory-watch] Listing ${listingId} — nothing below qty ${RESTOCK_QTY}.`);
        continue;
      }

      // Push updated inventory back to Etsy
      await updateListingInventory(shopClient, listingId, inv);

      // Log ONE consolidated event per listing (not per model row)
      const { styles: zeroStyles } = getZeroStylesForListing(db, listingId);
      const styleLabel = formatStyleLabel(zeroStyles);
      console.log(`[inventory-watch] ✓ Auto-restocked ${shopCfg.shop_id} listing ${listingId}: all offerings → qty ${RESTOCK_QTY}`);

      logEvent(db, {
        event_type:    'AUTO_RESTOCK',
        shop_name:      shopCfg.shop_id,
        listing_id:     listingId,
        listing_title:  listing_title,
        style_value:    styleLabel,
        detail:         `Auto-restocked all offerings to qty ${RESTOCK_QTY} (triggered by zero stock in: ${styleLabel})`,
        meta:           { triggered_by: zeroStyles, restocked_count: restockedCount, new_quantity: RESTOCK_QTY },
      });

    } catch (err) {
      // Out of daily budget — stop the sweep here instead of logging a failure
      // for every remaining zero-stock listing. It resumes on the next sweep.
      if (isQpdExhaustedError(err)) {
        console.warn(`[inventory-watch] Sweep paused — ${err.message}`);
        break;
      }
      // Transport-level failure (e.g. "socket hang up") never reached Etsy, so
      // there is no HTTP status — don't mislabel it as a server 500.
      const hasResponse = !!err.response;
      const status   = err.response?.status ?? err.status ?? null;
      const errMsg   = err.response?.data?.error || err.message;
      const isAuth   = status === 403;
      const isNetwork = !hasResponse;
      const statusLabel = status ?? 'network';

      let userMsg;
      if (isAuth) {
        userMsg = `listings_w scope required. Re-run "npm run oauth:setup" for ${shop_id} to grant restock permission.`;
      } else if (isNetwork) {
        userMsg = `${errMsg} — transient connection error, will retry on the next sweep.`;
      } else {
        userMsg = errMsg;
      }

      console.error(`[inventory-watch] ✗ Restock failed for listing ${listingId} (${statusLabel}): ${errMsg}`);

      // ONE consolidated failure event per listing
      const failStyles = [...new Set(rows.map((r) => r.style_value).filter(Boolean))];
      const failLabel    = formatStyleLabel(failStyles);
      logEvent(db, {
        event_type:    'RESTOCK_FAILED',
        shop_name:      shop_id,
        listing_id:     listingId,
        listing_title:  listing_title,
        style_value:    failLabel,
        detail:         `Auto-restock failed: ${userMsg}`,
        meta:           { status, error: errMsg, code: err.code ?? null, transient: isNetwork, needs_reauth: isAuth },
      });
    }
  }

  console.log('[inventory-watch] Inventory check complete.');
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  console.log('═'.repeat(60));
  console.log('  Etsy Dashboard — Sync Worker');
  console.log('═'.repeat(60));

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`Config error: ${err.message}`);
    process.exit(1);
  }

  const tokenManager = new TokenManager(TOKENS_PATH);

  const db = initDb(config.db_path);
  syncConfigToDb(db, config); // keep DB in sync with config.json on every startup
  // Owner-scoped cleanup keeps a graceful standalone-worker restart from leaving
  // either advisory lock blocked until its TTL expires.
  let locksReleased = false;
  const releaseOwnedLocks = () => {
    if (locksReleased) return;
    locksReleased = true;
    releaseSyncLock(db);
    releaseTrackingLock(db);
  };
  process.once('exit', releaseOwnedLocks);
  process.once('SIGINT', () => {
    releaseOwnedLocks();
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    releaseOwnedLocks();
    process.exit(0);
  });

  const intervalMinutes = config.sync_interval_minutes ?? 60;
  console.log(`\n  Sync interval : ${intervalMinutes} minutes`);
  console.log(`  Shops in config : ${getAllShops(config).length}`);
  console.log(`  Shops with tokens : ${getAllShops(config).filter(s => tokenManager.hasTokens(s.shop_id)).length}`);
  console.log(`  DB : ${config.db_path}`);
  console.log('');

  // Run immediately on startup
  await runSyncCycle(config, tokenManager, db);

  // Then schedule recurring runs via cron
  // Build an unambiguous cron expression.
  // */60 is unreliable (some node-cron builds trigger runOnInit or mis-parse it).
  // Instead: every hour at minute 0 → "0 * * * *"
  //          every 30 min          → "0,30 * * * *"
  //          other intervals       → "0 */${intervalMinutes} * * *" (hour-based)
  const cronExpr = intervalToCron(intervalMinutes);
  console.log(`\n[sync] Scheduling next cycle with cron: ${cronExpr}`);

  cron.schedule(cronExpr, async () => {
    try {
      await runSyncCycle(config, tokenManager, db);
    } catch (err) {
      console.error(`[sync] Unhandled error in cycle: ${err.message}`);
    }
  });

  // ── Independent 4PX tracking refresh ───────────────────────────────────────
  // The dashboard server owns this scheduler by default (including when its Etsy
  // EMBEDDED_SYNC is off), avoiding two processes competing for every tick.
  // Headless deployments may explicitly elect this worker instead.
  const trackingSettings = getTrackingPollSettings(config);
  if (trackingSettings.enabled && process.env.FOURPX_TRACKING_WORKER === '1') {
    console.log(`[tracking] Scheduling independent refresh every ${trackingSettings.intervalMinutes}m`);
    const triggerTracking = (trigger) =>
      runTrackingCycle(db, config, { trigger })
        .then((result) => {
          if (result?.started === false) console.log(`[tracking] ${trigger} trigger skipped (${result.reason || 'not started'}).`);
          return result;
        })
        .catch((err) => console.error(`[tracking] ${trigger} refresh error:`, err.message));
    // Starts independently after the initial receipt cycle, including the
    // no-Etsy-token case.
    setTimeout(() => {
      triggerTracking('startup');
    }, 10_000);
    // Elapsed timer is intentional: cron steps only preserve cadence for values
    // that divide the clock field (e.g. */40 alternates 40m then 20m).
    setInterval(() => {
      triggerTracking('scheduled');
    }, trackingSettings.intervalMinutes * 60 * 1000);
  } else if (!trackingSettings.enabled) {
    console.log('[tracking] Independent refresh is disabled (fourpx_tracking_sync=false).');
  } else {
    console.log('[tracking] Scheduler owned by dashboard server (set FOURPX_TRACKING_WORKER=1 only for a headless worker).');
  }

  // ── Inventory auto-restock watcher ─────────────────────────────────────────
  // Runs every 4 hours (separate from receipt sync to stay within API budget).
  //
  // Strategy:
  //   1. Read cached listing_inventory from DB (no Etsy API calls)
  //   2. Find offerings with quantity = 0
  //   3. If auto_restock_enabled (config), fetch live inventory + restock via API
  //   4. Log every event to the events table regardless of outcome
  //
  // API budget:  restock = 1 GET + 1 PUT per affected listing
  //              monitoring = 0 extra API calls (reads local DB only)
  //
  // Requires: listings_w OAuth scope (WRITE). If 403, logs RESTOCK_FAILED.
  // Enable/disable: auto_restock_enabled in config.json, or the dashboard toggle
  // (PATCH /api/inventory/auto-restock). Default is false (alert-only).

  const INV_WATCH_INTERVAL_MIN = config.inv_watch_interval_minutes ?? 240;

  // The periodic watch lives at module scope (runInventoryWatchCycle) so the
  // dashboard server can schedule it in-process. Bind this run's config/db here.
  const runInventoryWatch = () => runInventoryWatchCycle(config, tokenManager, db);

  // Build a cron expression from INV_WATCH_INTERVAL_MIN
  // ≥ 60 min → hour-based schedule, < 60 min → minute-based schedule
  const invCronExpr = (() => {
    if (INV_WATCH_INTERVAL_MIN >= 60) {
      const hrs = Math.ceil(INV_WATCH_INTERVAL_MIN / 60);
      return hrs === 1 ? '0 * * * *' : `0 */${hrs} * * *`;
    }
    return `*/${Math.ceil(INV_WATCH_INTERVAL_MIN)} * * * *`;
  })();

  // Defer the first inventory sweep so a cold start never fires a burst of
  // inventory PUTs alongside the boot receipt sync (double bot fingerprint).
  console.log(`\n[inventory-watch] Scheduling periodic sweep: ${invCronExpr} (every ${INV_WATCH_INTERVAL_MIN}m)`);
  console.log(`[inventory-watch] First sweep in ${Math.round(INV_WATCH_STARTUP_DELAY_MS / 60000)}m (avoids startup API burst)`);
  setTimeout(() => {
    runInventoryWatch().catch((err) => console.error('[inventory-watch] Startup sweep error:', err.message));
  }, INV_WATCH_STARTUP_DELAY_MS);
  cron.schedule(invCronExpr, async () => {
    try { await runInventoryWatch(); }
    catch (err) { console.error('[inventory-watch] Unhandled error:', err.message); }
  });

  console.log('[sync] Worker is running. Press Ctrl+C to stop.\n');
}

/**
 * Release the sync-cycle advisory lock IF this process still owns it.
 *
 * Called by the embedded dashboard on graceful shutdown. A UI restart / PM2
 * reload exits this process directly; if a sync cycle's lock is still held
 * (owner = this pid), the freshly-revived process cannot acquire it until the
 * SYNC_LOCK_TTL_SEC (~20 min) heartbeat lapses — so its boot sync is skipped and
 * the in-memory Etsy API budget stays "unknown" until then. Releasing here lets
 * the new process sync (and re-learn the budget) within seconds of boot.
 *
 * Owner-scoped (DELETE … WHERE owner = us), so a genuinely separate live worker
 * that happens to hold the lock is never disturbed.
 *
 * @param {import('better-sqlite3').Database} db
 */
function releaseSyncLock(db) {
  try {
    releaseLock(db, SYNC_LOCK_NAME, SYNC_LOCK_OWNER);
  } catch {
    /* best-effort during shutdown — never throw from an exit path */
  }
}

/** Release the tracking-cycle advisory lock if this process owns it. */
function releaseTrackingLock(db) {
  try {
    releaseLock(db, TRACKING_LOCK_NAME, SYNC_LOCK_OWNER);
  } catch {
    /* best-effort during shutdown */
  }
}

// ─── Exports (used by server for manual sync triggers) ───────────────────────
// Only export when required as a module; don't run main() in that case.
if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal sync error:', err.message);
    process.exit(1);
  });
} else {
  module.exports = {
    syncShop,
    syncGroup,
    runSyncCycle,
    startEtsyWork,
    isEtsyWorkRunning,
    getEtsyWorkStatus,
    runTrackingCheckPass,
    runTrackingCycle,
    startTrackingCycle,
    getTrackingCycleStatus,
    getTrackingPollSettings,
    countTrackingCandidates,
    runFreightSyncPass,
    checkAndRestockForOrders,
    runInventoryWatchCycle,
    syncLedgerForShop,
    releaseSyncLock,
    releaseTrackingLock,
    intervalToCron,
  };
}
