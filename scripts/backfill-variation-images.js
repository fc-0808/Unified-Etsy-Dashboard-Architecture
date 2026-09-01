'use strict';
/**
 * Backfill the Etsy Styles → photo mapping for listings already in the DB.
 *
 * The sync worker caches this going forward, but existing open orders were
 * synced before the mapping existed, so their Orders/Route thumbnails still
 * show the listing's generic hero collage instead of the exact variation the
 * buyer bought (e.g. "Case 1 + Grip 1").
 *
 * Respects proxy isolation — each group's listings are fetched through that
 * group's proxy chain, exactly like the sync worker.
 *
 * Usage:
 *   node scripts/backfill-variation-images.js              # open orders only
 *   node scripts/backfill-variation-images.js --all        # every known listing
 *   node scripts/backfill-variation-images.js --limit 200  # cap API calls
 */

const path = require('path');
const { loadConfig, getAllShops, usesGroupProxy } = require('../src/config/schema');
const { TokenManager } = require('../src/auth/token-manager');
const { createGroupProxyClient, verifyGroupProxy } = require('../src/proxy/factory');
const {
  buildShopClient,
  resolveShopId,
  getListingImageCatalogBatch,
  getListingVariationImages,
} = require('../src/etsy/client');
const {
  initDb,
  syncConfigToDb,
  upsertListingImage,
  replaceListingVariationImages,
  listingIdsNeedingVariationRefresh,
} = require('../src/db/setup');
const { buildVariationImageRows } = require('../src/listings/variation-images');

const TOKENS_PATH = path.resolve(__dirname, '../tokens.json');

const args = process.argv.slice(2);
const ALL = args.includes('--all');
const FORCE = args.includes('--force');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? Math.max(1, parseInt(args[limitIdx + 1], 10) || 0) : 500;
// Refresh anything older than a week; --force re-fetches everything.
const TTL_SEC = FORCE ? 0 : 7 * 24 * 3600;

/** listing_id → shop_id for the listings we care about, grouped by group_id. */
function collectTargets(db) {
  const openFilter = ALL
    ? ''
    : `AND r.is_shipped = 0
       AND r.status NOT IN ('Canceled','Cancelled','Fully Refunded','Fully refunded')`;
  return db.prepare(`
    SELECT DISTINCT t.listing_id AS listing_id, r.shop_id AS shop_id, r.group_id AS group_id
    FROM transactions t
    JOIN receipts r ON r.receipt_id = t.receipt_id
    WHERE t.listing_id IS NOT NULL ${openFilter}
  `).all();
}

async function main() {
  const config = loadConfig();
  const db = initDb(config.db_path);
  syncConfigToDb(db, config);

  const targets = collectTargets(db);
  if (!targets.length) {
    console.log('No listings found for backfill.');
    return;
  }

  const stale = new Set(listingIdsNeedingVariationRefresh(db, targets.map((t) => t.listing_id), TTL_SEC));
  const byGroup = new Map();
  for (const t of targets) {
    if (!stale.has(Number(t.listing_id))) continue;
    if (!byGroup.has(t.group_id)) byGroup.set(t.group_id, { listingIds: new Set(), shopIds: new Set() });
    const g = byGroup.get(t.group_id);
    g.listingIds.add(Number(t.listing_id));
    g.shopIds.add(t.shop_id);
  }

  const totalStale = [...byGroup.values()].reduce((n, g) => n + g.listingIds.size, 0);
  if (!totalStale) {
    console.log('Every listing already has a fresh variation-image cache. Nothing to do.');
    return;
  }
  console.log(`${totalStale} listing(s) need a variation-image refresh (cap ${LIMIT}).`);

  const tokenManager = new TokenManager(TOKENS_PATH);
  let budget = LIMIT;
  let totalMappings = 0;

  for (const [groupId, { listingIds, shopIds }] of byGroup) {
    if (budget <= 0) break;
    const group = config.groups.find((g) => g.group_id === groupId);
    if (!group) { console.warn(`[${groupId}] not in config — skipping`); continue; }

    let proxyClient;
    try {
      const exitIp = await verifyGroupProxy(group, config.vpn_local_port);
      console.log(`[${groupId}] proxy verified — exit IP ${exitIp}`);
      proxyClient = createGroupProxyClient(group, config.vpn_local_port);
    } catch (err) {
      console.error(`[${groupId}] proxy verification failed: ${err.message} — skipping group`);
      continue;
    }

    // Variation images are shop-scoped, so each shop's listings go through that
    // shop's own authenticated client.
    for (const shopId of shopIds) {
      if (budget <= 0) break;
      const shop = getAllShops(config).find((s) => s.shop_id === shopId);
      if (!shop || !tokenManager.hasTokens(shopId)) {
        console.warn(`[${groupId}/${shopId}] no tokens — skipping`);
        continue;
      }

      const shopListingIds = [...listingIds].filter((id) =>
        targets.some((t) => Number(t.listing_id) === id && t.shop_id === shopId));
      if (!shopListingIds.length) continue;

      let shopClient;
      let numericId;
      try {
        const accessToken = await tokenManager.getAccessToken(shop.shop_id, shop.api_key, null, proxyClient);
        shopClient = buildShopClient(proxyClient, shop.api_key, shop.shared_secret, accessToken, null, {
          requireProxy: usesGroupProxy(group),
        });
        numericId = await resolveShopId(shopClient, shop.shop_id);
      } catch (err) {
        console.error(`[${groupId}/${shopId}] auth failed: ${err.message} — skipping shop`);
        continue;
      }

      const slice = shopListingIds.slice(0, budget);
      console.log(`[${shop.shop_name}] fetching variation images for ${slice.length} listing(s)…`);

      const catalog = await getListingImageCatalogBatch(shopClient, slice);
      const saveHeroes = db.transaction(() => {
        for (const [listingId, entry] of catalog) {
          if (entry?.heroUrl) upsertListingImage(db, listingId, entry.heroUrl);
        }
      });
      saveHeroes();

      for (const listingId of slice) {
        const byImageId = catalog.get(listingId)?.byImageId;
        if (!(byImageId instanceof Map) || byImageId.size === 0) {
          console.warn(`  listing ${listingId}: no image catalog (inactive/removed?) — skipped`);
          continue;
        }
        budget -= 1;
        try {
          const results = await getListingVariationImages(shopClient, numericId, listingId);
          const rows = buildVariationImageRows(results, byImageId);
          replaceListingVariationImages(db, listingId, rows);
          totalMappings += rows.length;
          console.log(`  listing ${listingId}: ${rows.length} style photo(s)`);
        } catch (err) {
          const status = err.response?.status;
          if (status === 404) {
            replaceListingVariationImages(db, listingId, []);
            console.warn(`  listing ${listingId}: no variation images on Etsy`);
          } else {
            console.warn(`  listing ${listingId}: failed (${err.message})`);
          }
        }
        await new Promise((r) => setTimeout(r, 150));
      }
    }
  }

  console.log(`\nDone — cached ${totalMappings} style → photo mapping(s).`);
}

main().catch((err) => {
  console.error('Backfill failed:', err.message);
  process.exitCode = 1;
});
