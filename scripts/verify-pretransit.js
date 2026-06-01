const Database = require('better-sqlite3');
const db = new Database('data/etsy_dashboard.db');

const shops = db.prepare('SELECT shop_id, shop_name FROM shops').all();
console.log('Pre-transit counts (3-day window — matching server filter):\n');
for (const shop of shops) {
  const r = db.prepare(`
    SELECT COUNT(*) as cnt FROM receipts
    WHERE shop_id = ?
      AND is_shipped = 1
      AND tracking_code IS NOT NULL
      AND etsy_updated_at >= (strftime('%s','now') - 3*24*3600)
  `).get(shop.shop_id);
  if (r.cnt > 0) console.log(`  ${shop.shop_name}: ${r.cnt}`);
}
