'use strict';

/**
 * One-time 4PX tracking-status backfill for the Shipping tab.
 *
 * Fetches a tracking snapshot (status, last event, location, delivery, first scan)
 * for every 4PX parcel that isn't already marked delivered, and persists it so the
 * Shipping tab shows accurate status + stuck detection immediately instead of
 * waiting for the periodic tracking sync to work through the backlog.
 *
 * Run: node scripts/backfill-4px-tracking.js
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { getTrackingSnapshot } = require('../src/tracking/checker');
const { updateTrackingDetail } = require('../src/db/setup');

const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../config.json'), 'utf8'));
const creds = { appKey: config.fourpx_app_key ?? null, appSecret: config.fourpx_app_secret ?? null };

const db = new Database(path.resolve(__dirname, '../data/etsy_dashboard.db'));

// Every 4PX parcel not already delivered, newest first. Delivered parcels are
// terminal, so skip them to save API calls.
const rows = db.prepare(`
  SELECT receipt_id,
         COALESCE(CASE WHEN tracking_code LIKE '4PX%' THEN tracking_code END, fourpx_tracking_no) AS tracking_no
  FROM receipts
  WHERE tracking_code LIKE '4PX%'
    AND COALESCE(tracking_status,'') != 'delivered'
    AND tracking_delivered_at IS NULL
  ORDER BY COALESCE(shipment_notified_at, etsy_created_at) DESC
`).all().filter((r) => r.tracking_no);

console.log(`Backfilling tracking status for ${rows.length} non-delivered 4PX parcel(s)…`);

(async () => {
  const nowEpoch = Math.floor(Date.now() / 1000);
  let inTransit = 0, delivered = 0, exception = 0, pre = 0, stuck = 0, err = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      const snap = await getTrackingSnapshot(r.tracking_no, creds);
      if (snap.ok) {
        const firstScanAt = ['in_transit', 'delivered', 'exception'].includes(snap.status)
          ? (snap.firstScanAt ?? nowEpoch) : null;
        updateTrackingDetail(db, r.receipt_id, {
          status: snap.status,
          firstScanAt,
          lastEventAt: snap.lastEventAt,
          lastEvent: snap.lastEvent,
          lastLocation: snap.lastLocation,
          deliveredAt: snap.deliveredAt,
          health: snap.health,
        });
        if (snap.status === 'delivered') delivered++;
        else if (snap.status === 'exception') exception++;
        else if (snap.status === 'in_transit') inTransit++;
        else pre++;
        if (snap.health && snap.health.isStuck) stuck++;
      } else {
        err++;
        updateTrackingDetail(db, r.receipt_id, {});
      }
    } catch (e) { err++; }
    if ((i + 1) % 25 === 0 || i === rows.length - 1) {
      process.stdout.write(`\r  ${i + 1}/${rows.length} — ${inTransit} in-transit, ${delivered} delivered, ${exception} exception, ${pre} pre, ${stuck} stuck, ${err} err`);
    }
    await new Promise((x) => setTimeout(x, 120));
  }
  console.log(`\nDone — ${inTransit} in-transit, ${delivered} delivered, ${exception} exception, ${pre} pre-transit, ${stuck} stuck, ${err} error(s).`);
  db.close();
})();
