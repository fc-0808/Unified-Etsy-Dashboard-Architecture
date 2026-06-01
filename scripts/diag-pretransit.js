const Database = require('better-sqlite3');
const db = new Database('data/etsy_dashboard.db');

const shop = db.prepare("SELECT shop_id FROM shops WHERE shop_name='Y2KASEshop'").get();
if (!shop) { console.log('Shop not found'); process.exit(1); }

const now = Math.floor(Date.now() / 1000);
const day = 24 * 3600;

// Show distribution of etsy_updated_at for is_shipped=1 orders with tracking
const rows = db.prepare(`
  SELECT receipt_id, tracking_code, carrier_name, shipment_was_shipped,
         etsy_updated_at, etsy_created_at,
         datetime(etsy_updated_at,'unixepoch') as updated_at_str,
         datetime(etsy_created_at,'unixepoch') as created_at_str
  FROM receipts
  WHERE shop_id = ? AND is_shipped = 1 AND tracking_code IS NOT NULL
  ORDER BY etsy_updated_at DESC
  LIMIT 30
`).all(shop.shop_id);

console.log(`\nY2KASEshop — shipped orders with tracking (latest 30 by update date):\n`);
for (const r of rows) {
  const daysAgoUpdated = ((now - r.etsy_updated_at) / day).toFixed(1);
  const daysAgoCreated = ((now - r.etsy_created_at) / day).toFixed(1);
  console.log(`  #${r.receipt_id} | was_shipped=${r.shipment_was_shipped} | updated ${daysAgoUpdated}d ago (${r.updated_at_str}) | created ${daysAgoCreated}d ago`);
}

// Count by different time windows
const windows = [1, 2, 3, 5, 7, 10, 14, 30];
console.log('\nCount with shipment_was_shipped=0 by etsy_updated_at window:');
for (const d of windows) {
  const r = db.prepare(`
    SELECT COUNT(*) as cnt FROM receipts
    WHERE shop_id=? AND is_shipped=1 AND tracking_code IS NOT NULL
    AND shipment_was_shipped=0 AND etsy_updated_at >= ?
  `).get(shop.shop_id, now - d * day);
  console.log(`  Last ${d} days: ${r.cnt}`);
}
