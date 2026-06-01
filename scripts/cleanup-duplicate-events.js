'use strict';
/**
 * One-time cleanup: remove duplicate ZERO_STOCK events produced by the old
 * per-offering logging bug (pre-fix).
 *
 * Strategy: within each (listing_id, 5-minute time bucket), keep only the
 * single row with the highest id (most recently inserted).  Events from
 * different time periods for the same listing are preserved normally.
 */
const path     = require('path');
const Database = require('better-sqlite3');

const dbPath = path.resolve(__dirname, '../data/etsy_dashboard.db');
const db = new Database(dbPath);

const before = db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type = 'ZERO_STOCK'").get().n;
console.log(`ZERO_STOCK events before cleanup : ${before}`);

const result = db.prepare(`
  DELETE FROM events
  WHERE event_type = 'ZERO_STOCK'
  AND id NOT IN (
    SELECT MAX(id)
    FROM   events
    WHERE  event_type = 'ZERO_STOCK'
    GROUP  BY COALESCE(listing_id, 0),
              (created_at / 300)       -- 5-minute bucket collapses one sync session
  )
`).run();

const after = db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type = 'ZERO_STOCK'").get().n;
console.log(`Deleted                          : ${result.changes} duplicate row(s)`);
console.log(`ZERO_STOCK events after cleanup  : ${after}`);

// Show surviving events grouped by listing
const survivors = db.prepare(`
  SELECT listing_id, listing_title, style_value,
         datetime(created_at, 'unixepoch', 'localtime') AS ts
  FROM   events
  WHERE  event_type = 'ZERO_STOCK'
  ORDER  BY created_at DESC
  LIMIT  20
`).all();
console.log('\nRemaining ZERO_STOCK events (newest 20):');
survivors.forEach(r =>
  console.log(`  [${r.ts}] #${r.listing_id ?? '—'} styles=[${r.style_value ?? '—'}]`)
);

db.close();
console.log('\nDone.');
