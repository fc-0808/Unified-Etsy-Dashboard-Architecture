'use strict';
const path     = require('path');
const Database = require('better-sqlite3');

const db = new Database(path.resolve(__dirname, '../data/etsy_dashboard.db'));

const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;

const rows = db.prepare(`
  SELECT listing_id, style_value,
         datetime(created_at, 'unixepoch', 'localtime') AS ts,
         CASE WHEN created_at > ? THEN 'SUPPRESSED (< 1h – dedup active)'
                                  ELSE 'WOULD LOG ONCE if still zero-stock'
         END AS verdict
  FROM   events
  WHERE  event_type = 'ZERO_STOCK'
  ORDER  BY created_at DESC
`).all(oneHourAgo);

console.log('Current ZERO_STOCK events and next-sync behaviour:\n');
rows.forEach(r =>
  console.log(`  #${r.listing_id}  [${r.ts}]  styles=[${r.style_value ?? '—'}]  → ${r.verdict}`)
);

db.close();
