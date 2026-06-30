'use strict';

/**
 * One-time 4PX freight backfill.
 *
 * Re-resolves the shipping cost for every 4PX order that isn't already 'billed',
 * upgrading estimates to the real billed amount wherever 4PX has settled the
 * consignment. Useful after a logic change (e.g. the tracking-number fix for
 * ds.xms.order.getFreight) so existing rows refresh immediately instead of waiting
 * for the sync worker's periodic recheck.
 *
 * Run: node scripts/backfill-4px-freight.js
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { resolveReceiptFreight } = require('../src/fourpx/freight');

const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../config.json'), 'utf8'));
const { fourpx_app_key: appKey, fourpx_app_secret: appSecret } = config;
if (!appKey || !appSecret) {
  console.error('fourpx_app_key / fourpx_app_secret missing from config.json.');
  process.exit(1);
}

const db = new Database(path.resolve(__dirname, '../data/etsy_dashboard.db'));

// Every 4PX shipment not already settled (billed is immutable, so skip to save
// calls). Includes orders shipped directly on the 4PX portal (4PX tracking number
// synced from Etsy, no dashboard consignment) — the bulk of historical volume.
const orders = db.prepare(`
  SELECT receipt_id, source, tracking_code, fourpx_consignment_no, fourpx_tracking_no,
         shipping_country_iso, fourpx_product_code, fourpx_weight_g, fourpx_freight_status
  FROM receipts
  WHERE (fourpx_consignment_no IS NOT NULL OR tracking_code LIKE '4PX%')
    AND COALESCE(fourpx_order_status,'') != 'cancelled'
    AND COALESCE(fourpx_freight_status,'pending') != 'billed'
  ORDER BY COALESCE(fourpx_created_at, etsy_created_at) DESC
`).all();

console.log(`Backfilling freight for ${orders.length} non-billed 4PX order(s)…`);

(async () => {
  let billed = 0, estimated = 0, pending = 0, errored = 0;
  for (let i = 0; i < orders.length; i++) {
    try {
      const r = await resolveReceiptFreight({ db, config, appKey, appSecret, receipt: orders[i] });
      if (r.status === 'billed') billed++;
      else if (r.status === 'estimated') estimated++;
      else if (r.status === 'error') errored++;
      else pending++;
    } catch (e) { errored++; }
    if ((i + 1) % 25 === 0 || i === orders.length - 1) {
      process.stdout.write(`\r  ${i + 1}/${orders.length} — ${billed} billed, ${estimated} estimated, ${pending} pending, ${errored} err`);
    }
    await new Promise((x) => setTimeout(x, 120));
  }
  console.log(`\nDone — ${billed} billed, ${estimated} estimated, ${pending} pending, ${errored} error(s).`);
  db.close();
})();
