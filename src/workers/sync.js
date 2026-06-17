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
const cron = require('node-cron');

const { loadConfig, getAllShops }   = require('../config/schema');
const { TokenManager, TokenExpiredError } = require('../auth/token-manager');
const { createGroupProxyClient, verifyGroupProxy } = require('../proxy/factory');
const { usesGroupProxy } = require('../config/schema');
const {
  buildShopClient,
  paginateReceipts,
  resolveShopId,
  getListingImagesBatch,
  getListingInventory,
  updateListingInventory,
  paginateConversations,
  getConversation,
} = require('../etsy/client');
const {
  initDb,
  syncConfigToDb,
  upsertReceipt,
  upsertListingImage,
  upsertListingInventory,
  updateCarrierStatus,
  logEvent,
  startSyncLog,
  finishSyncLog,
  updateShopSyncTime,
  upsertConversation,
  upsertConversationMessage,
} = require('../db/setup');
const { checkTrackingStatus } = require('../tracking/checker');
const {
  getZeroStylesForListing,
  listingHasLiveZero,
  raiseOfferingsToTarget,
  logZeroStockIfNeeded,
  orderCheckPriority,
} = require('../inventory/helpers');

const TOKENS_PATH = path.resolve(__dirname, '../../tokens.json');

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

  // ── Phase 1: rank by cache signals; always live-check (never skip on stale qty) ─
  const MAX_CHECKS_PER_CYCLE = 10;
  const ranked = [...listingIds]
    .map((lid) => ({ lid, priority: orderCheckPriority(db, lid, twoHoursAgo) }))
    .sort((a, b) => b.priority - a.priority);

  const toCheck = ranked.slice(0, MAX_CHECKS_PER_CYCLE).map((r) => r.lid);

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

      const styleLabel = zeroArr.length ? zeroArr.join(', ') : 'unknown variation(s)';

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
 */
async function syncShop(shop, group, config, proxyClient, tokenManager, db, egressIp = null) {
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
    );

    // ── 3. Resolve shop name → numeric ID (cached after first call) ───────────
    const numericId = await resolveShopId(shopClient, shop.shop_id);

    // ── 4. Paginate receipts ──────────────────────────────────────────────────
    const maxPerSync = config.max_orders_per_sync ?? 100;
    console.log(`${label} Fetching up to ${maxPerSync} receipts...`);

    // Prepare a fast lookup: which listing_ids already have cached images?
    const cachedImgCheck = db.prepare('SELECT 1 FROM listing_images WHERE listing_id = ?');

    // Helper: write a batch of receipts to DB + cache listing images
    const writeBatch = async (batch) => {
      const insertBatch = db.transaction(() => {
        for (const receipt of batch) {
          upsertReceipt(db, shop.shop_id, group.group_id, receipt);
          receiptsWritten++;

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

    // Pass A: newest N receipts by creation date (always)
    for await (const batch of paginateReceipts(shopClient, numericId, { maxTotal: maxPerSync })) {
      await writeBatch(batch);
    }

    // Pass B: receipts updated in the last 14 days — catches tracking status
    // transitions for recently shipped orders and ensures orders in the full
    // pre_transit_days window (default 14 days) have fresh data.
    // Extended from 7 to 14 days to match pre_transit_days default, ensuring
    // any Etsy-side updates to orders in the pre-transit window are synced.
    const fourteenDaysAgo = Math.floor(Date.now() / 1000) - 14 * 24 * 3600;
    console.log(`${label} Fetching recently-updated receipts (last 14 days)...`);
    for await (const batch of paginateReceipts(shopClient, numericId, {
      maxTotal: 200,
      min_last_modified: fourteenDaysAgo,
      sort_on: 'updated',
      sort_order: 'desc',
    })) {
      await writeBatch(batch);
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

  } catch (err) {
    console.error(`${label} Sync failed: ${err.message}`);
    finishSyncLog(db, logId, 'error', receiptsWritten, err.message);
  }
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

  for (const shop of shopsInGroup) {
    const delayMs = stableOffset(shop.shop_id, windowMs) + jitter(maxJitterMs);
    const delaySec = Math.round(delayMs / 1000);
    console.log(`${label} Scheduling ${shop.shop_name} in ~${delaySec}s`);
    await sleep(delayMs);
    await syncShop(shop, group, config, proxyClient, tokenManager, db, egressIp);
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
  const TRACKING_WINDOW_DAYS    = (config.pre_transit_days ?? 30) + 3; // look a bit beyond the filter window
  const TRACKING_RECHECK_HOURS  = 4;   // re-check each order at most once every 4 hours
  const MAX_TRACK_CHECKS_PER_CYCLE = 200; // safety cap: max API calls per sync cycle
  const INTER_REQUEST_MS        = 150; // pause between 4PX API calls

  const windowCutoff  = Math.floor(Date.now() / 1000) - TRACKING_WINDOW_DAYS * 24 * 3600;
  const recheckCutoff = Math.floor(Date.now() / 1000) - TRACKING_RECHECK_HOURS * 3600;
  const nowEpoch      = Math.floor(Date.now() / 1000);

  // Fetch orders that need a tracking check.
  // Prioritize:
  //   1. Never checked (tracking_checked_at IS NULL) — these are the most urgent.
  //   2. Checked more than RECHECK_HOURS ago — periodic refresh.
  // Only process 4PX tracking codes (our shops' primary carrier).
  // Ignore orders where carrier_confirmed_at is already set — they're confirmed in-transit.
  const candidates = db.prepare(`
    SELECT receipt_id, tracking_code, carrier_name, shop_id
    FROM receipts
    WHERE is_shipped = 1
      AND tracking_code IS NOT NULL
      AND tracking_code LIKE '4PX%'
      AND carrier_confirmed_at IS NULL
      AND shipment_notified_at IS NOT NULL
      AND shipment_notified_at >= ?
      AND (tracking_checked_at IS NULL OR tracking_checked_at < ?)
    ORDER BY
      CASE WHEN tracking_checked_at IS NULL THEN 0 ELSE 1 END ASC,
      shipment_notified_at DESC
    LIMIT ?
  `).all(windowCutoff, recheckCutoff, MAX_TRACK_CHECKS_PER_CYCLE);

  if (!candidates.length) {
    console.log('[tracking] No orders need tracking check this cycle.');
    return;
  }

  console.log(`[tracking] Checking ${candidates.length} order(s) via ${config.fourpx_app_key ? '4PX Official API (authenticated)' : '4PX Public API (fallback)'}…`);

  let confirmed = 0;
  let stillPre  = 0;
  let unknown   = 0;

  for (const [idx, order] of candidates.entries()) {
    if (idx > 0) await sleep(INTER_REQUEST_MS);

    const result = await checkTrackingStatus(order.tracking_code, order.carrier_name, {
      appKey:    config.fourpx_app_key    ?? null,
      appSecret: config.fourpx_app_secret ?? null,
    });

    let carrierConfirmedAt = null;

    if (result.status === 'in_transit' || result.status === 'delivered' || result.status === 'exception') {
      // Package has been physically picked up / scanned by carrier.
      // Record the first scan time (falls back to now if not available from API).
      carrierConfirmedAt = result.firstScanAt ?? nowEpoch;
      confirmed++;
    } else if (result.status === 'pre_transit') {
      stillPre++;
    } else {
      // 'unknown' — API error, unsupported carrier, or not yet registered.
      // Treat as pre-transit (fail-open): better to show too many than too few.
      unknown++;
    }

    updateCarrierStatus(db, order.receipt_id, {
      carrierConfirmedAt,
      trackingCheckedAt: nowEpoch,
    });
  }

  console.log(
    `[tracking] Done — ${confirmed} confirmed in-transit, ` +
    `${stillPre} still pre-transit, ${unknown} unknown/error`
  );
}

// ─── Conversation sync pass ───────────────────────────────────────────────────

/**
 * Sync conversation threads and messages for a single shop.
 *
 * Uses Etsy's undocumented internal v3 conversation endpoints — the same ones
 * that power etsy.com/your/messages. Uses existing OAuth tokens (no special
 * scope required, as Etsy does not expose conversation scopes publicly).
 * Returns skipped:true with a clear warning if Etsy returns 403 or 404.
 *
 * Rate budget: ~1 call per 25 convos + 1 call per new thread detail.
 * Run at most every 20 minutes per shop to stay within QPD budget.
 *
 * @param {object}   shop          - Shop config entry
 * @param {object}   group         - Group config entry
 * @param {object}   config        - Full app config
 * @param {object}   proxyClient   - Proxy-isolated axios base client for the group
 * @param {TokenManager} tokenManager
 * @param {import('better-sqlite3').Database} db
 * @param {function} [notifyFn]    - Optional callback(newUnreadCount) for SSE push
 * @returns {Promise<{ synced: number, newUnread: number, skipped: boolean }>}
 */
async function syncConversationsForShop(shop, group, config, proxyClient, tokenManager, db, notifyFn) {
  const label = `[convos] ${shop.shop_name}`;

  // Rate gate: skip if synced within the last 18 minutes (leave 2-min buffer vs 20-min cron)
  const CONVO_SYNC_MIN_INTERVAL_S = 18 * 60;
  const lastSyncRow = db.prepare(`
    SELECT MAX(synced_at) AS last FROM conversations WHERE shop_id = ?
  `).get(shop.shop_id);
  const lastSyncAt = lastSyncRow?.last ?? 0;
  const nowEpoch = Math.floor(Date.now() / 1000);
  if (nowEpoch - lastSyncAt < CONVO_SYNC_MIN_INTERVAL_S) {
    return { synced: 0, newUnread: 0, skipped: true };
  }

  let accessToken;
  try {
    accessToken = await tokenManager.getAccessToken(
      shop.shop_id, shop.api_key, shop.refresh_token ?? null, proxyClient
    );
  } catch {
    return { synced: 0, newUnread: 0, skipped: true };
  }

  const shopClient = buildShopClient(proxyClient, shop.api_key, shop.shared_secret, accessToken);

  let synced    = 0;
  let newUnread = 0;

  try {
    for await (const batch of paginateConversations(shopClient, shop.shop_id, { maxTotal: 50 })) {
      const writeBatch = db.transaction(() => {
        for (const convo of batch) {
          const convoId = String(convo.conversation_id ?? convo.convo_id);

          // Track if this conversation was previously read so we can detect new unreads
          const prev = db.prepare('SELECT status FROM conversations WHERE convo_id = ?').get(convoId);
          const wasRead = prev?.status === 'read' || prev?.status === 'replied';

          upsertConversation(db, shop.shop_id, group.group_id, convo);
          synced++;

          if (convo.is_read === false && wasRead !== false) {
            newUnread++;
          }

          // Upsert any messages embedded directly in the conversation list response
          const msgs = Array.isArray(convo.messages) ? convo.messages : [];
          for (const msg of msgs) {
            if (msg.message_id || msg.id) {
              upsertConversationMessage(db, convoId, shop.shop_id, {
                ...msg,
                seller_user_id: convo.seller_user_id ?? null,
              });
            }
          }
        }
      });
      writeBatch();

      // For conversations with unread messages that don't have embedded message bodies,
      // fetch the full thread detail (one API call per unread convo, capped at 5/cycle)
      let detailFetched = 0;
      for (const convo of batch) {
        if (detailFetched >= 5) break;
        const convoId = String(convo.conversation_id ?? convo.convo_id);
        const msgs    = Array.isArray(convo.messages) ? convo.messages : [];
        const hasBody = msgs.some(m => m.message_text || m.body || m.text);
        if (!hasBody) {
          try {
            await sleep(300);
            const full = await getConversation(shopClient, shop.shop_id, convoId);
            const fullMsgs = Array.isArray(full.messages) ? full.messages : [];
            const saveDetail = db.transaction(() => {
              for (const msg of fullMsgs) {
                if (msg.message_id || msg.id) {
                  upsertConversationMessage(db, convoId, shop.shop_id, {
                    ...msg,
                    seller_user_id: full.seller_user_id ?? convo.seller_user_id ?? null,
                  });
                }
              }
            });
            saveDetail();
            detailFetched++;
          } catch (err) {
            // Non-fatal — missing detail is cosmetic
            console.warn(`${label} Detail fetch for convo ${convoId} failed: ${err.message}`);
          }
        }
      }
    }

    console.log(`${label} Conversation sync complete — ${synced} threads, ${newUnread} new unread`);

    if (newUnread > 0 && typeof notifyFn === 'function') {
      const totalUnread = db.prepare(
        `SELECT COUNT(*) AS c FROM conversations WHERE shop_id = ? AND status = 'unread'`
      ).get(shop.shop_id).c;
      notifyFn(totalUnread);
    }

    return { synced, newUnread, skipped: false };

  } catch (err) {
    const status = err.response?.status;
    if (status === 403) {
      console.warn(
        `${label} Conversation sync skipped — 403 Forbidden. ` +
        `Etsy does not allow third-party access to conversation endpoints for this app key. ` +
        `Use the "Open on Etsy" link in the Messages tab to read/reply directly.`
      );
    } else if (status === 404) {
      console.warn(
        `${label} Conversation sync skipped — 404. ` +
        `Etsy's internal conversation endpoint may be unavailable or the path has changed.`
      );
    } else {
      console.error(`${label} Conversation sync failed: ${err.message}`);
    }
    return { synced: 0, newUnread: 0, skipped: true };
  }
}

// ─── Main sync cycle ──────────────────────────────────────────────────────────

async function runSyncCycle(config, tokenManager, db) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`[sync] Cycle started at ${new Date().toISOString()}`);
  console.log('─'.repeat(60));

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
    await syncGroup(group, shops, config, tokenManager, db);
  }

  // Pass D: carrier tracking check for all recently shipped unconfirmed orders.
  // Runs after ALL shops are synced so it covers every shop in one pass.
  // Uses 4PX's public tracking API to determine if the carrier has physically
  // picked up each package, enabling precise Pre-transit vs In-transit detection.
  try {
    await runTrackingCheckPass(db, config);
  } catch (err) {
    console.error(`[tracking] Tracking check pass failed: ${err.message}`);
  }

  const totalReceipts = db.prepare('SELECT COUNT(*) AS c FROM receipts').get().c;
  console.log(`\n[sync] Cycle complete — ${totalReceipts} total receipts in DB`);
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
      const styleLabel = zeroStyles.length ? zeroStyles.join(', ') : 'unknown variation(s)';
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
      const shopClient  = buildShopClient(proxyClient, shopCfg.api_key, shopCfg.shared_secret, accessToken);
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
      const styleLabel = zeroStyles.length ? zeroStyles.join(', ') : 'unknown variation(s)';
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
      const failLabel    = failStyles.length ? failStyles.join(', ') : 'unknown variation(s)';
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
  const cronExpr = intervalMinutes === 60
    ? '0 * * * *'
    : `*/${Math.ceil(intervalMinutes)} * * * *`;
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

// ─── Exports (used by server for manual sync triggers) ───────────────────────
// Only export when required as a module; don't run main() in that case.
if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal sync error:', err.message);
    process.exit(1);
  });
} else {
  module.exports = { syncShop, syncGroup, runSyncCycle, runTrackingCheckPass, checkAndRestockForOrders, runInventoryWatchCycle, syncConversationsForShop };
}
