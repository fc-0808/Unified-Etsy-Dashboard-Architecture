'use strict';

/**
 * Background sync worker.
 *
 * Runs on a configurable interval (sync_interval_minutes in config.json, default 60).
 * For each shop that has a token, fetches recent receipts from Etsy and writes them
 * to etsy_dashboard.db.
 *
 * Safety controls built in:
 *   - Per-group proxy verified before any shop in that group is synced (fail-closed)
 *   - Per-shop deterministic offset + random jitter so shops never call Etsy in lock-step
 *   - Proxy client bound per group — groups never share HTTP state
 *   - Sync log entry written for every attempt (success or failure) for audit
 *   - If proxy check fails for a group, all shops in that group are skipped that cycle
 *   - Access token refreshed through the group proxy before each shop's requests
 */

const path = require('path');
const cron = require('node-cron');

const { loadConfig, getAllShops }   = require('../config/schema');
const { TokenManager, TokenExpiredError } = require('../auth/token-manager');
const { createGroupProxyClient, verifyGroupProxy } = require('../proxy/factory');
const {
  buildShopClient,
  paginateReceipts,
  resolveShopId,
  getListingImagesBatch,
} = require('../etsy/client');
const {
  initDb,
  syncConfigToDb,
  upsertReceipt,
  upsertListingImage,
  startSyncLog,
  finishSyncLog,
  updateShopSyncTime,
} = require('../db/setup');

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
    const shopClient = buildShopClient(
      proxyClient,
      shop.api_key,
      shop.shared_secret,
      accessToken,
    );

    // ── 3. Resolve shop name → numeric ID (cached after first call) ───────────
    const numericId = await resolveShopId(shopClient, shop.shop_id);

    // ── 4. Paginate receipts ──────────────────────────────────────────────────
    const maxPerSync = config.max_orders_per_sync ?? 100;
    console.log(`${label} Fetching up to ${maxPerSync} receipts...`);

    // Prepare a fast lookup: which listing_ids already have cached images?
    const cachedImgCheck = db.prepare('SELECT 1 FROM listing_images WHERE listing_id = ?');

    for await (const batch of paginateReceipts(shopClient, numericId, { maxTotal: maxPerSync })) {
      // Write receipts to DB
      const insertBatch = db.transaction(() => {
        for (const receipt of batch) {
          upsertReceipt(db, shop.shop_id, group.group_id, receipt);
          receiptsWritten++;
        }
      });
      insertBatch();
      console.log(`${label} Wrote batch of ${batch.length} receipts (total so far: ${receiptsWritten})`);

      // Fetch and cache listing images for ALL listing IDs across all transactions
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
    }

    // ── 5. Update shop metadata + finish log ──────────────────────────────────
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

  // ── Mandatory proxy gate — fail closed ────────────────────────────────────
  let proxyClient;
  let egressIp;
  try {
    egressIp = await verifyGroupProxy(group, config.vpn_local_port);
    console.log(`${label} Proxy verified — exit IP: ${egressIp}`);
    proxyClient = createGroupProxyClient(group, config.vpn_local_port);
  } catch (err) {
    console.error(
      `${label} PROXY VERIFICATION FAILED — skipping all shops in this group this cycle.\n` +
      `  Reason: ${err.message}\n` +
      `  Fix: ensure VPN is connected and IPFoxy proxy is active before next sync.`
    );
    return; // hard stop — never sync without confirmed proxy
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

  const totalReceipts = db.prepare('SELECT COUNT(*) AS c FROM receipts').get().c;
  console.log(`\n[sync] Cycle complete — ${totalReceipts} total receipts in DB`);
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

  console.log('[sync] Worker is running. Press Ctrl+C to stop.\n');
}

main().catch((err) => {
  console.error('Fatal sync error:', err.message);
  process.exit(1);
});
