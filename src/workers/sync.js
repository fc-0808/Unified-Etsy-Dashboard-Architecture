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

const { loadConfig, getAllShops }   = require('../config/schema');
const { TokenManager, TokenExpiredError } = require('../auth/token-manager');
const { createGroupProxyClient, verifyGroupProxy } = require('../proxy/factory');
const { usesGroupProxy } = require('../config/schema');
const {
  buildShopClient,
  paginateReceipts,
  resolveShopId,
  getShop,
  getListingImagesBatch,
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
  upsertListingInventory,
  updateCarrierStatus,
  updateTrackingDetail,
  recordFourpxFreight,
  logEvent,
  startSyncLog,
  finishSyncLog,
  acquireLock,
  renewLock,
  releaseLock,
  updateShopSyncTime,
  updateShopListingCount,
  updateShopLedgerSyncTime,
  upsertTransaction,
  upsertLedgerEntry,
  upsertEtsyPayment,
  reattributeLedgerEntries,
} = require('../db/setup');
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
 *   3. If any offering is at zero AND auto_restock_enabled, PUT all offerings
 *      back to config.restock_quantity and log an ORDER_RESTOCK event.
 *   4. If auto_restock_enabled is false, just log ZERO_STOCK (alert mode).
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
async function checkAndRestockForOrders(listingIds, shopClient, shop, config, db) {
  if (!listingIds.size) return;

  const restockQty  = config.restock_quantity ?? 3;
  const autoRestock = config.auto_restock_enabled !== false;
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
  const { fullBackfill = false, onProgress = null } = options;
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
    // cosmetic figure that barely moves — so we refresh it at most once per
    // LISTING_COUNT_TTL_MS per shop rather than burning a GET /shops on every
    // sync cycle. Non-fatal: a failure here must never abort the receipt sync.
    const lastCount = _lastListingCountRefresh.get(shop.shop_id) ?? 0;
    if (Date.now() - lastCount >= LISTING_COUNT_TTL_MS) {
      try {
        const shopData = await getShop(shopClient, shop.shop_id);
        if (shopData && shopData.listing_active_count != null) {
          updateShopListingCount(db, shop.shop_id, shopData.listing_active_count);
          console.log(`${label} Active listings: ${shopData.listing_active_count}`);
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

      const uncachedIds = [...new Set(
        batch.flatMap((r) => (r.transactions ?? []).map((t) => t.listing_id))
      )].filter((id) => id && !cachedImgCheck.get(id));

      if (uncachedIds.length > 0) {
        const imageMap = await getListingImagesBatch(shopClient, uncachedIds);
        if (imageMap.size > 0) {
          const saveImages = db.transaction(() => {
            for (const [listingId, url] of imageMap) {
              upsertListingImage(db, listingId, url);
            }
          });
          saveImages();
          console.log(`${label} Cached ${imageMap.size} listing image(s)`);
        }
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

    // ── 5. Order-triggered inventory check ───────────────────────────────────
    // For every listing that appeared in a recently-created order, refresh
    // its live inventory from Etsy. If any offering is at zero, auto-restock.
    // This fires inside the current sync window so restocks happen within
    // minutes of a sale rather than waiting for the 4-hour periodic sweep.
    if (orderListingIds.size > 0) {
      console.log(`${label} Order-triggered inventory check for ${orderListingIds.size} listing(s)…`);
      await checkAndRestockForOrders(orderListingIds, shopClient, shop, config, db);
    }

    // ── 6. Update shop metadata + finish log ──────────────────────────────────
    updateShopSyncTime(db, shop.shop_id);
    finishSyncLog(db, logId, 'success', receiptsWritten);
    console.log(`${label} Done — ${receiptsWritten} receipts synced`);
    return { status: 'success', shop_id: shop.shop_id, api_key: shop.api_key };

  } catch (err) {
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
  const { fullBackfill = false, onProgress = null } = options;
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
async function syncGroup(group, shopsInGroup, config, tokenManager, db) {
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

    const result = await syncShop(shop, group, config, proxyClient, tokenManager, db, egressIp);

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
 * Query the 4PX tracking API for all recently shipped, unconfirmed orders
 * and update `carrier_confirmed_at` for those that have been picked up.
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
 *   - Previously checked orders are re-checked only after TRACKING_RECHECK_HOURS.
 *   - At most MAX_TRACK_CHECKS_PER_CYCLE orders are processed per sync cycle.
 *   - A 150ms pause between requests avoids hammering the 4PX API.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} config - App config (pre_transit_days)
 */
async function runTrackingCheckPass(db, config) {
  // Window: don't keep polling parcels older than this (they're surely delivered
  // even if the carrier never posted a final scan). Generous so the Shipping tab
  // still tracks long-haul/stuck parcels.
  const TRACKING_WINDOW_DAYS    = Math.max((config.pre_transit_days ?? 30) + 3, 120);
  const PRE_RECHECK_HOURS       = 4;   // pre-transit: check often (pickup detection)
  const TRANSIT_RECHECK_HOURS   = 18;  // in-transit: refresh status / detect delivery + stuck
  const MAX_TRACK_CHECKS_PER_CYCLE = 250;
  const INTER_REQUEST_MS        = 150;

  const nowEpoch      = Math.floor(Date.now() / 1000);
  const windowCutoff  = nowEpoch - TRACKING_WINDOW_DAYS * 86400;
  const preCutoff     = nowEpoch - PRE_RECHECK_HOURS * 3600;
  const transitCutoff = nowEpoch - TRANSIT_RECHECK_HOURS * 3600;

  // Candidates: every 4PX parcel that is NOT yet delivered, within the window,
  // whose snapshot is stale for its phase. Pre-transit parcels (no first scan) are
  // refreshed frequently to detect pickup; in-transit parcels less often to keep
  // their status / last-event / delivery / stuck state current for the Shipping tab.
  // Never-checked parcels are most urgent; pre-transit beats in-transit.
  const candidates = db.prepare(`
    SELECT receipt_id, tracking_code, carrier_name, shop_id, carrier_confirmed_at
    FROM receipts
    WHERE tracking_code LIKE '4PX%'
      AND COALESCE(tracking_status, '') != 'delivered'
      AND tracking_delivered_at IS NULL
      AND COALESCE(shipment_notified_at, etsy_created_at) >= @windowCutoff
      AND (
        tracking_checked_at IS NULL
        OR (carrier_confirmed_at IS NULL     AND tracking_checked_at < @preCutoff)
        OR (carrier_confirmed_at IS NOT NULL AND tracking_checked_at < @transitCutoff)
      )
    ORDER BY
      CASE WHEN tracking_checked_at IS NULL THEN 0 ELSE 1 END ASC,
      CASE WHEN carrier_confirmed_at IS NULL THEN 0 ELSE 1 END ASC,
      COALESCE(shipment_notified_at, etsy_created_at) DESC
    LIMIT @max
  `).all({ windowCutoff, preCutoff, transitCutoff, max: MAX_TRACK_CHECKS_PER_CYCLE });

  if (!candidates.length) {
    console.log('[tracking] No parcels need a tracking check this cycle.');
    return;
  }

  console.log(`[tracking] Checking ${candidates.length} parcel(s) via ${config.fourpx_app_key ? '4PX Official API (authenticated)' : '4PX Public API (fallback)'}…`);

  let confirmed = 0, stillPre = 0, delivered = 0, exception = 0, unknown = 0;

  for (const [idx, order] of candidates.entries()) {
    if (idx > 0) await sleep(INTER_REQUEST_MS);

    const snap = await getTrackingSnapshot(order.tracking_code, {
      appKey:    config.fourpx_app_key    ?? null,
      appSecret: config.fourpx_app_secret ?? null,
    });

    if (!snap.ok) {
      // Transient error / not yet registered — record the attempt only so we don't
      // hammer it, and leave any previously-known status intact (fail-open).
      unknown++;
      updateTrackingDetail(db, order.receipt_id, { checkedAt: nowEpoch });
      continue;
    }

    // First physical scan → carrier_confirmed_at (drives pre-transit detection).
    const firstScanAt =
      (snap.status === 'in_transit' || snap.status === 'delivered' || snap.status === 'exception')
        ? (snap.firstScanAt ?? nowEpoch)
        : null;

    if (snap.status === 'delivered') delivered++;
    else if (snap.status === 'exception') exception++;
    else if (snap.status === 'in_transit') confirmed++;
    else stillPre++;

    updateTrackingDetail(db, order.receipt_id, {
      status:       snap.status,
      firstScanAt,
      lastEventAt:  snap.lastEventAt,
      lastEvent:    snap.lastEvent,
      lastLocation: snap.lastLocation,
      deliveredAt:  snap.deliveredAt,
      health:       snap.health,
      checkedAt:    nowEpoch,
    });
  }

  console.log(
    `[tracking] Done — ${confirmed} in-transit, ${delivered} delivered, ` +
    `${exception} exception, ${stillPre} pre-transit, ${unknown} unknown/error`
  );
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
  // ── Cross-process guard ─────────────────────────────────────────────────────
  // Only one process may run a sync cycle at a time. If another live process
  // already holds the lock (e.g. a stray duplicate dashboard, or the standalone
  // worker running alongside the embedded scheduler), bail out immediately so we
  // never double-sync shops or burn double the Etsy API budget.
  if (!acquireLock(db, SYNC_LOCK_NAME, SYNC_LOCK_OWNER, SYNC_LOCK_TTL_SEC)) {
    console.warn(
      '[sync] Another process is already running a sync cycle (lock held) — skipping this trigger. ' +
      'This is expected if a duplicate dashboard/worker is running; close the extra instance to stop double syncs.'
    );
    return;
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`[sync] Cycle started at ${new Date().toISOString()} (owner ${SYNC_LOCK_OWNER})`);
  console.log('─'.repeat(60));

  try {
    const allShops = getAllShops(config);
    const shopsWithTokens = allShops.filter((s) => tokenManager.hasTokens(s.shop_id));

    if (shopsWithTokens.length === 0) {
      console.warn('[sync] No shops have tokens. Run: npm run oauth:setup');
      return;
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
      renewLock(db, SYNC_LOCK_NAME, SYNC_LOCK_OWNER); // keep the lock fresh across long cycles
      await syncGroup(group, shops, config, tokenManager, db);
    }

    // Pass D: carrier tracking check for all recently shipped unconfirmed orders.
    // Runs after ALL shops are synced so it covers every shop in one pass.
    // Uses 4PX's public tracking API to determine if the carrier has physically
    // picked up each package, enabling precise Pre-transit vs In-transit detection.
    try {
      renewLock(db, SYNC_LOCK_NAME, SYNC_LOCK_OWNER);
      await runTrackingCheckPass(db, config);
    } catch (err) {
      console.error(`[tracking] Tracking check pass failed: ${err.message}`);
    }

    // Pass E: pull the actual billed shipping cost (freight) from 4PX for every
    // order with a consignment that hasn't been billed yet. Runs after tracking
    // so it shares the same once-per-cycle, post-sync cadence.
    try {
      renewLock(db, SYNC_LOCK_NAME, SYNC_LOCK_OWNER);
      await runFreightSyncPass(db, config);
    } catch (err) {
      console.error(`[freight] Freight sync pass failed: ${err.message}`);
    }

    const totalReceipts = db.prepare('SELECT COUNT(*) AS c FROM receipts').get().c;
    console.log(`\n[sync] Cycle complete — ${totalReceipts} total receipts in DB`);
  } finally {
    releaseLock(db, SYNC_LOCK_NAME, SYNC_LOCK_OWNER);
  }
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
  const RESTOCK_QTY = config.restock_quantity ?? 3;
  const autoRestock = config.auto_restock_enabled !== false;

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
  for (const [idx, [listingIdStr, rows]] of listingEntries.entries()) {
    if (idx > 0) await sleep(300);

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
  // Enable/disable: set auto_restock_enabled: true/false in config.json (default true)

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

  // Run inventory watch immediately then on the configured interval
  console.log(`\n[inventory-watch] Scheduling periodic sweep: ${invCronExpr} (every ${INV_WATCH_INTERVAL_MIN}m)`);
  await runInventoryWatch();
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

// ─── Exports (used by server for manual sync triggers) ───────────────────────
// Only export when required as a module; don't run main() in that case.
if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal sync error:', err.message);
    process.exit(1);
  });
} else {
  module.exports = { syncShop, syncGroup, runSyncCycle, runTrackingCheckPass, runFreightSyncPass, checkAndRestockForOrders, runInventoryWatchCycle, syncLedgerForShop, releaseSyncLock, intervalToCron };
}
