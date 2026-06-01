'use strict';

/**
 * Backfill listing images for all receipts that have no cached thumbnail.
 * Usage:  node scripts/backfill-images.js
 */

const path = require('path');
const Database = require('better-sqlite3');
const { loadConfig, getAllShops } = require('../src/config/schema');
const { createGroupClient } = require('../src/proxy/factory');
const { buildShopClient, getListingImagesBatch } = require('../src/etsy/client');
const { upsertListingImage } = require('../src/db/setup');
const { TokenManager } = require('../src/auth/token-manager');

const TOKENS_PATH = path.resolve(__dirname, '../tokens.json');
const config   = loadConfig();
const db       = new Database(config.db_path);
const allShops = getAllShops(config);
const tokenManager = new TokenManager(TOKENS_PATH);

// Collect all listing_ids per shop that have no cached image
const receipts = db.prepare('SELECT shop_id, all_transactions, first_listing_id FROM receipts').all();
const missingByShop = {};
for (const r of receipts) {
  const listingIds = new Set();
  try {
    JSON.parse(r.all_transactions || '[]').forEach(t => { if (t.listing_id) listingIds.add(Number(t.listing_id)); });
  } catch {}
  if (r.first_listing_id) listingIds.add(Number(r.first_listing_id));

  for (const lid of listingIds) {
    if (lid && !db.prepare('SELECT 1 FROM listing_images WHERE listing_id=?').get(lid)) {
      (missingByShop[r.shop_id] = missingByShop[r.shop_id] || new Set()).add(lid);
    }
  }
}

const total = Object.values(missingByShop).reduce((s, v) => s + v.size, 0);
console.log(`\nFound ${total} listing(s) missing images across ${Object.keys(missingByShop).length} shop(s):`);
Object.entries(missingByShop).forEach(([s, ids]) => console.log(`  ${s.padEnd(28)} → ${ids.size}`));
if (total === 0) { console.log('Nothing to do.'); process.exit(0); }

(async () => {
  for (const [shopId, listingIdSet] of Object.entries(missingByShop)) {
    const listingIds = [...listingIdSet];
    const shopCfg = allShops.find(s => s.shop_id === shopId);
    if (!shopCfg) { console.warn(`\n[${shopId}] No config — skipping`); continue; }

    const groupCfg = config.groups.find(g => g.group_id === shopCfg.group_id);
    const label = `[${shopId}]`;
    console.log(`\n${label} Fetching ${listingIds.length} image(s)…`);

    try {
      const proxyClient = createGroupClient(groupCfg, config.vpn_local_port);
      const accessToken = await tokenManager.getAccessToken(
        shopCfg.shop_id, shopCfg.api_key, shopCfg.refresh_token ?? null, proxyClient
      );
      const shopClient = buildShopClient(proxyClient, shopCfg.api_key, shopCfg.shared_secret, accessToken);
      const imageMap   = await getListingImagesBatch(shopClient, listingIds);

      db.transaction(() => {
        for (const [id, url] of imageMap) upsertListingImage(db, id, url);
        listingIds.filter(id => !imageMap.has(id)).forEach(id => upsertListingImage(db, id, null));
      })();

      console.log(`${label} ✓ ${imageMap.size} cached  |  ${listingIds.length - imageMap.size} inactive/not found`);
      imageMap.forEach((url, id) => console.log(`   ${id}  →  ${url.substring(0, 65)}…`));
    } catch (err) {
      console.error(`${label} ✗ ${err.message}`);
    }
  }

  console.log('\n✅ Done.');
  process.exit(0);
})();
