'use strict';
/**
 * Backfill script: run 4PX tracking check for all recently shipped orders
 * across all shops. Sets carrier_confirmed_at for in-transit packages.
 *
 * Uses the official 4PX Open Platform API (tr.order.tracking.get) when
 * fourpx_app_key / fourpx_app_secret are set in config.json; otherwise
 * falls back to the public tracking API.
 *
 * Run once after upgrading to the carrier-tracking integration.
 * The sync worker's Pass D handles ongoing checks automatically.
 */

const { initDb, updateCarrierStatus } = require('../src/db/setup');
const { checkTrackingStatus } = require('../src/tracking/checker');
const { loadConfig } = require('../src/config/schema');

const config = loadConfig();
const db = initDb(config.db_path);
const creds = { appKey: config.fourpx_app_key ?? null, appSecret: config.fourpx_app_secret ?? null };

console.log(`API mode: ${creds.appKey ? '4PX Official API (authenticated)' : '4PX Public API (fallback)'}`);

const WINDOW_DAYS = 35; // look back 35 days
const INTER_REQUEST_MS = 150;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const windowCutoff = Math.floor(Date.now() / 1000) - WINDOW_DAYS * 24 * 3600;
  const nowEpoch = Math.floor(Date.now() / 1000);

  const rows = db.prepare(`
    SELECT receipt_id, tracking_code, carrier_name, shop_id,
           date(shipment_notified_at,'unixepoch') as d,
           carrier_confirmed_at
    FROM receipts
    WHERE is_shipped = 1
      AND tracking_code IS NOT NULL
      AND tracking_code LIKE '4PX%'
      AND shipment_notified_at IS NOT NULL
      AND shipment_notified_at >= ?
    ORDER BY shop_id, shipment_notified_at DESC
  `).all(windowCutoff);

  console.log(`Backfill: checking ${rows.length} 4PX orders from last ${WINDOW_DAYS} days...`);

  let confirmed = 0, stillPre = 0, unknown = 0, alreadySet = 0;
  const shopSummary = {};

  for (const [idx, order] of rows.entries()) {
    if (idx > 0) await sleep(INTER_REQUEST_MS);

    // Already has carrier_confirmed_at set — just mark as checked
    if (order.carrier_confirmed_at != null) {
      alreadySet++;
      continue;
    }

    const result = await checkTrackingStatus(order.tracking_code, order.carrier_name, creds);
    let carrierConfirmedAt = null;

    if (result.status === 'in_transit' || result.status === 'delivered' || result.status === 'exception') {
      carrierConfirmedAt = result.firstScanAt ?? nowEpoch;
      confirmed++;
    } else if (result.status === 'pre_transit') {
      stillPre++;
    } else {
      unknown++;
    }

    updateCarrierStatus(db, order.receipt_id, {
      carrierConfirmedAt,
      trackingCheckedAt: nowEpoch,
    });

    // Track per-shop stats
    const s = shopSummary[order.shop_id] = shopSummary[order.shop_id] || { pre: 0, intransit: 0, unk: 0 };
    if (carrierConfirmedAt) s.intransit++;
    else if (result.status === 'pre_transit') s.pre++;
    else s.unk++;

    if ((idx + 1) % 20 === 0 || idx === rows.length - 1) {
      const pct = Math.round(((idx + 1) / rows.length) * 100);
      process.stdout.write(`\r  Progress: ${idx + 1}/${rows.length} (${pct}%)  `);
    }
  }

  console.log('\n');
  console.log('═'.repeat(60));
  console.log('BACKFILL COMPLETE');
  console.log('═'.repeat(60));
  console.log(`Total checked   : ${rows.length}`);
  console.log(`Already set     : ${alreadySet}`);
  console.log(`→ Confirmed in-transit : ${confirmed}`);
  console.log(`→ Still pre-transit    : ${stillPre}`);
  console.log(`→ Unknown/error        : ${unknown}`);
  console.log('\nPer-shop breakdown:');
  for (const [shop, stats] of Object.entries(shopSummary)) {
    console.log(`  ${shop}: pre=${stats.pre} in-transit=${stats.intransit} unknown=${stats.unk}`);
  }

  // Verify Y2KASEshop count
  const y2kPreTransit = db.prepare(`
    SELECT COUNT(*) as cnt FROM receipts
    WHERE shop_id = 'Y2KASEshop' AND is_shipped = 1
      AND tracking_code IS NOT NULL
      AND shipment_notified_at IS NOT NULL
      AND shipment_notified_at >= ?
      AND carrier_confirmed_at IS NULL
  `).get(windowCutoff);
  console.log(`\nY2KASEshop pre-transit count: ${y2kPreTransit.cnt} (expected: ~22)`);
})();
