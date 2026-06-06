'use strict';
const Database = require('better-sqlite3');
const rd = require('../src/route/dashboard');

const db = new Database('./data/etsy_dashboard.db', { readonly: true });
const LUV = 'LUVKASEofficial';
const cfg = { pre_transit_days: 30 };

// 1. Plain shop filter.
const rows = rd.buildRouteRows(db, cfg, { shop_id: LUV, enrich_supplier: false, include_needs_purchase: true });
const leaks1 = rows.filter(r => r.shop_id !== LUV);
console.log(`[1] shop filter only       -> rows=${rows.length}, leaked=${leaks1.length}`);

// 2. Shop filter + a stale cross-shop pin (simulates localStorage extra_receipt_ids).
const other = db.prepare(
  "SELECT receipt_id, shop_id FROM receipts WHERE shop_id <> ? AND needs_purchase_at IS NOT NULL LIMIT 1"
).get(LUV);
const rows2 = rd.buildRouteRows(db, cfg, {
  shop_id: LUV, enrich_supplier: false,
  extra_receipt_ids: other ? [other.receipt_id] : [],
});
const leaks2 = rows2.filter(r => r.shop_id !== LUV);
console.log(`[2] shop filter + cross pin -> rows=${rows2.length}, leaked=${leaks2.length} (pin was receipt ${other ? other.receipt_id : 'n/a'} from ${other ? other.shop_id : 'n/a'})`);

// 3. Size of the pool that used to leak pre-fix (other shops' needs-purchase orders).
const pool = db.prepare(
  "SELECT COUNT(*) n FROM receipts WHERE shop_id <> ? AND needs_purchase_at IS NOT NULL AND status NOT IN ('Canceled','Cancelled','Fully Refunded','Fully refunded')"
).get(LUV);
console.log(`[3] other-shop needs_purchase candidates in DB (the pre-fix leak source): ${pool.n}`);

db.close();
console.log(leaks1.length === 0 && leaks2.length === 0 ? '\nPASS — no cross-shop leakage.' : '\nFAIL — leakage detected.');
