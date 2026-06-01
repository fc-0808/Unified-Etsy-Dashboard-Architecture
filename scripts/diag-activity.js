'use strict';
const path = require('path');
const Database = require('better-sqlite3');
const db = new Database(path.resolve(__dirname, '../data/etsy_dashboard.db'));
const now = Math.floor(Date.now() / 1000);

console.log('\n=== Recent events (last 15) ===');
const events = db.prepare(`
  SELECT event_type, shop_name, listing_id,
         datetime(created_at,'unixepoch','localtime') AS ts,
         ROUND((? - created_at)/3600.0, 1) AS hrs_ago
  FROM events ORDER BY created_at DESC LIMIT 15
`).all(now);
if (!events.length) console.log('  (none)');
events.forEach(r => console.log(`  ${r.ts}  (${r.hrs_ago}h ago)  ${r.event_type}  ${r.shop_name || ''}  ${r.listing_id || ''}`));

console.log('\n=== Last sync_log per shop (most recent 15) ===');
const logs = db.prepare(`
  SELECT sl.shop_id, s.shop_name, sl.status, sl.receipts_synced,
         datetime(sl.started_at,'unixepoch','localtime') AS started,
         ROUND((? - sl.started_at)/60.0, 1) AS min_ago
  FROM sync_log sl LEFT JOIN shops s ON s.shop_id = sl.shop_id
  ORDER BY sl.started_at DESC LIMIT 15
`).all(now);
if (!logs.length) console.log('  (none)');
logs.forEach(r => console.log(`  ${r.started}  (${r.min_ago}m ago)  ${r.shop_name || r.shop_id}  ${r.status}  receipts=${r.receipts_synced}`));

console.log('\n=== Newest receipts (most recent 10 by etsy_created_at) ===');
const receipts = db.prepare(`
  SELECT receipt_id, shop_id,
         datetime(etsy_created_at,'unixepoch','localtime') AS created,
         ROUND((? - etsy_created_at)/3600.0, 1) AS hrs_ago
  FROM receipts ORDER BY etsy_created_at DESC LIMIT 10
`).all(now);
receipts.forEach(r => console.log(`  ${r.created}  (${r.hrs_ago}h ago)  shop=${r.shop_id}  receipt=${r.receipt_id}`));

console.log('\n=== Zero-stock variants currently in cache ===');
const zero = db.prepare(`
  SELECT li.listing_id, l.shop_id, li.style_value, COUNT(*) AS n
  FROM listing_inventory li JOIN listings l ON l.listing_id = li.listing_id
  WHERE li.quantity = 0 AND li.is_enabled = 1 AND l.state = 'active'
  GROUP BY li.listing_id, li.style_value
`).all();
if (!zero.length) console.log('  (none — all cached variants in stock)');
zero.forEach(r => console.log(`  listing=${r.listing_id}  shop=${r.shop_id}  style=${r.style_value}  rows=${r.n}`));

db.close();
