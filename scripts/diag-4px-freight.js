'use strict';

/**
 * Diagnostic — 4PX `ds.xms.order.getFreight` (shipping cost) response inspector.
 *
 * The public 4PX docs list the getFreight method but NOT its exact request/response
 * field names (those live behind the authenticated portal, and 4PX is inconsistent
 * between snake_case / camelCase / nested lists). This script calls the live API for
 * a real consignment and prints BOTH:
 *   1. the normalized FreightResult our code produces (what the dashboard stores), and
 *   2. the raw `data` payload 4PX returned (so you can confirm/extend the field map).
 *
 * Run it ONCE against an order you know 4PX has already billed to lock the mapping:
 *
 *   node scripts/diag-4px-freight.js <consignmentOrTrackingNo>
 *   node scripts/diag-4px-freight.js            # auto-picks a recent 4PX order from the DB
 *
 * If the normalized `totalFee` is null but the raw payload clearly contains a charge,
 * copy the raw key name into the _FREIGHT_*_KEYS arrays in src/fourpx/orders.js.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { getOrderFreight } = require('../src/fourpx/orders');

function loadConfig() {
  const p = path.resolve(__dirname, '../config.json');
  if (!fs.existsSync(p)) {
    console.error('config.json not found at project root.');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function main() {
  const config = loadConfig();
  const appKey = config.fourpx_app_key;
  const appSecret = config.fourpx_app_secret;
  if (!appKey || !appSecret) {
    console.error('fourpx_app_key / fourpx_app_secret missing from config.json.');
    process.exit(1);
  }

  let requestNo = process.argv[2];

  // No explicit consignment given — pick a recent one from the DB so the script is
  // runnable with zero arguments right after some orders have shipped.
  if (!requestNo) {
    const dbPath = path.resolve(__dirname, '../data/etsy_dashboard.db');
    if (!fs.existsSync(dbPath)) {
      console.error('No consignment number given and data/etsy_dashboard.db not found.');
      console.error('Usage: node scripts/diag-4px-freight.js <consignmentOrTrackingNo>');
      process.exit(1);
    }
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare(`
      SELECT receipt_id, fourpx_consignment_no, fourpx_tracking_no
      FROM receipts
      WHERE fourpx_consignment_no IS NOT NULL OR fourpx_tracking_no IS NOT NULL
      ORDER BY fourpx_created_at DESC
      LIMIT 1
    `).get();
    db.close();
    if (!row) {
      console.error('No 4PX orders found in the DB to inspect. Pass a consignment number explicitly.');
      process.exit(1);
    }
    requestNo = row.fourpx_consignment_no || row.fourpx_tracking_no;
    console.log(`No argument given — using most recent 4PX order: receipt ${row.receipt_id}, request_no=${requestNo}\n`);
  }

  console.log(`Querying ds.xms.order.getFreight for: ${requestNo}\n`);
  try {
    const freight = await getOrderFreight(appKey, appSecret, requestNo);
    console.log('── Normalized FreightResult (what the dashboard stores) ──');
    console.log(JSON.stringify({
      status: freight.status,
      totalFee: freight.totalFee,
      currency: freight.currency,
      billedWeightG: freight.billedWeightG,
      weightRaw: freight.weightRaw,
      feeItems: freight.feeItems,
    }, null, 2));
    console.log('\n── Raw 4PX `data` payload (confirm/extend field mapping here) ──');
    console.log(JSON.stringify(freight.raw, null, 2));

    if (freight.totalFee === null) {
      console.log('\n[!] totalFee is null. If the raw payload above contains a charge, add its');
      console.log('    key to _FREIGHT_TOTAL_KEYS (and currency/weight keys) in src/fourpx/orders.js.');
    }
  } catch (err) {
    console.error('getFreight failed:', err.message, err.code ? `(code ${err.code})` : '');
    if (err.apiBody) console.error('Raw API body:', JSON.stringify(err.apiBody, null, 2));
    process.exit(1);
  }
}

main();
