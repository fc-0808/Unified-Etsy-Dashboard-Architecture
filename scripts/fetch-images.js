'use strict';
/**
 * One-time (and re-runnable) backfill: fetch listing image URLs for all
 * receipts already in the DB that don't yet have a cached image.
 *
 * Respects proxy isolation — each group's listing IDs are fetched through
 * that group's proxy chain, just like the sync worker does.
 *
 * Usage: node scripts/fetch-images.js
 */

const path = require('path');
const { loadConfig, getAllShops } = require('../src/config/schema');
const { TokenManager }           = require('../src/auth/token-manager');
const { createGroupProxyClient, verifyGroupProxy } = require('../src/proxy/factory');
const { buildShopClient, getListingImagesBatch, resolveShopId } = require('../src/etsy/client');
const { initDb, syncConfigToDb, upsertListingImage } = require('../src/db/setup');

const TOKENS_PATH = path.resolve(__dirname, '../tokens.json');

async function main() {
  const config = loadConfig();
  const db     = initDb(config.db_path);
  syncConfigToDb(db, config);

  const tokenManager = new TokenManager(TOKENS_PATH);

  // Collect ALL listing IDs (from first_listing_id AND all_transactions) not yet cached
  const receiptRows = db.prepare('SELECT group_id, shop_id, first_listing_id, all_transactions FROM receipts').all();
  const seenByGroup = new Map(); // group_id -> Set of listing_ids needing images
  const shopByGroup = new Map(); // group_id -> any shop_id with tokens

  for (const row of receiptRows) {
    if (!seenByGroup.has(row.group_id)) seenByGroup.set(row.group_id, new Set());
    if (!shopByGroup.has(row.group_id)) shopByGroup.set(row.group_id, row.shop_id);
    const ids = seenByGroup.get(row.group_id);
    if (row.first_listing_id) ids.add(row.first_listing_id);
    try {
      const txs = JSON.parse(row.all_transactions || '[]');
      for (const t of txs) if (t.listing_id) ids.add(t.listing_id);
    } catch {}
  }

  // Filter to only IDs not yet cached
  const cachedCheck = db.prepare('SELECT 1 FROM listing_images WHERE listing_id = ?');
  for (const [groupId, ids] of seenByGroup) {
    const uncached = [...ids].filter(id => !cachedCheck.get(id));
    seenByGroup.set(groupId, new Set(uncached));
  }

  const totalMissing = [...seenByGroup.values()].reduce((s, v) => s + v.size, 0);

  // Build the missing array in the format the rest of the script expects
  const missing = [];
  for (const [group_id, ids] of seenByGroup) {
    for (const listing_id of ids) {
      missing.push({ listing_id, group_id, shop_id: shopByGroup.get(group_id) });
    }
  }

  if (!missing.length) {
    console.log('All listing images are already cached. Nothing to do.');
    return;
  }

  console.log(`Found ${missing.length} listing ID(s) without cached images.`);

  // Group by group_id so we use the correct proxy for each group
  const byGroup = new Map();
  for (const row of missing) {
    if (!byGroup.has(row.group_id)) byGroup.set(row.group_id, { listingIds: [], shopId: row.shop_id });
    byGroup.get(row.group_id).listingIds.push(row.listing_id);
  }

  let totalCached = 0;

  for (const [groupId, { listingIds, shopId }] of byGroup) {
    const group = config.groups.find((g) => g.group_id === groupId);
    if (!group) { console.warn(`Group ${groupId} not found in config, skipping.`); continue; }

    // Verify proxy before making any API calls
    let proxyClient;
    try {
      const exitIp = await verifyGroupProxy(group, config.vpn_local_port);
      console.log(`[${groupId}] Proxy verified — exit IP: ${exitIp}`);
      proxyClient = createGroupProxyClient(group, config.vpn_local_port);
    } catch (err) {
      console.error(`[${groupId}] Proxy verification failed: ${err.message} — skipping group`);
      continue;
    }

    // Get a valid access token for one shop in this group
    const shop = getAllShops(config).find((s) => s.group_id === groupId && tokenManager.hasTokens(s.shop_id));
    if (!shop) { console.warn(`[${groupId}] No authenticated shop found — skipping group`); continue; }

    let shopClient;
    try {
      const accessToken = await tokenManager.getAccessToken(shop.shop_id, shop.api_key, null, proxyClient);
      shopClient = buildShopClient(proxyClient, shop.api_key, shop.shared_secret, accessToken);
      await resolveShopId(shopClient, shop.shop_id); // warm up the client
    } catch (err) {
      console.error(`[${groupId}] Token error: ${err.message} — skipping group`);
      continue;
    }

    console.log(`[${groupId}] Fetching images for ${listingIds.length} listings via ${shop.shop_name}...`);

    const imageMap = await getListingImagesBatch(shopClient, listingIds);
    const saveImages = db.transaction(() => {
      for (const [listingId, url] of imageMap) {
        upsertListingImage(db, listingId, url);
      }
    });
    saveImages();

    console.log(`[${groupId}] Cached ${imageMap.size} / ${listingIds.length} images.`);
    totalCached += imageMap.size;
  }

  const stillMissing = db.prepare(`
    SELECT COUNT(*) AS n FROM receipts r
    LEFT JOIN listing_images li ON li.listing_id = r.first_listing_id
    WHERE r.first_listing_id IS NOT NULL AND li.listing_id IS NULL
  `).get().n;

  console.log(`\nDone. ${totalCached} images cached. ${stillMissing} still missing (inactive/deleted listings).`);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
