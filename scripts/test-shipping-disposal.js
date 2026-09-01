'use strict';

/**
 * Unit tests for disposed-parcel detection + shipping claim persistence.
 * Run: node scripts/test-shipping-disposal.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  isDisposalText,
  timelineHasDisposal,
  analyzeTrackingHealth,
  _withHealth,
} = require('../src/tracking/checker');
const {
  initDb,
  getShipments,
  getShippingStats,
  getShippingAlerts,
  updateTrackingDetail,
  updateShippingClaim,
  backfillDisposedTrackingFlags,
} = require('../src/db/setup');

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

console.log('Disposal text detection');
check('matches Parcel Disposal', () => {
  assert.strictEqual(isDisposalText('Parcel Disposal'), true);
});
check('matches Disposal Authorized by Shipper', () => {
  assert.strictEqual(isDisposalText('Undeliverable Package, Disposal Authorized by Shipper'), true);
});
check('matches location-packed Parcel disposal', () => {
  assert.strictEqual(isDisposalText(null, 'Kent, WA 98032 / Parcel disposal'), true);
});
check('matches the official destroyed-shipment terminal wording', () => {
  assert.strictEqual(isDisposalText('Shipment has been destroyed.'), true);
});
check('does not match normal in-transit wording', () => {
  assert.strictEqual(isDisposalText('Shipment in transit to destination country'), false);
});
check('does not match disposition (word-boundary)', () => {
  assert.strictEqual(isDisposalText('package disposition update received'), false);
});

console.log('Shipping UI safety');
check('tracking numbers are data, never interpolated into executable onclick code', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8');
  assert.ok(/class="mono earn-4px-no ship-track-link" data-tracking="\$\{safeNo\}"/.test(html));
  assert.ok(!/open4pxTrackModal\('\$\{no\}'\)/.test(html));
  assert.ok(/class="tracking-number fpx-track-link" data-tracking="\$\{safeTrackingCode\}"/.test(html));
  assert.ok(!/open4pxTrackModal\('\$\{o\.tracking_code\}'\)/.test(html));
  assert.ok(/class="ship-alert-track" data-tracking="\$\{safeTracking\}"/.test(html));
  assert.ok(/tracking-carrier">\$\{escHtml\(o\.carrier_name\)\}/.test(html));
});

console.log('Timeline + health');
check('timelineHasDisposal finds location-only disposal', () => {
  const events = [
    { description: null, location: 'Kent, WA / Parcel disposal', time: '2026-08-06 17:08:00' },
    { description: 'Out for delivery', location: 'Olympia, WA', time: '2026-08-05 09:00:00' },
  ];
  assert.strictEqual(timelineHasDisposal(events), true);
});
check('analyzeTrackingHealth marks disposal as critical + isDisposed', () => {
  const events = [
    { description: 'Parcel Disposal', location: 'Kent, WA', time: '2026-08-06 17:08:00' },
  ];
  const h = analyzeTrackingHealth(events, 'in_transit');
  assert.strictEqual(h.isDisposed, true);
  assert.strictEqual(h.severity, 'critical');
  assert.strictEqual(h.isStuck, true);
  assert.ok(/dispos/i.test(h.reasons[0]));
});
check('_withHealth forces exception status on disposal', () => {
  const out = _withHealth({
    status: 'in_transit',
    events: [{ description: 'Parcel Disposal', location: null, time: '2026-08-06 17:08:00' }],
  });
  assert.strictEqual(out.status, 'exception');
  assert.strictEqual(out.health.isDisposed, true);
});
check('configured stuck-days threshold controls no-movement severity', () => {
  const sixDaysAgoUtc8 = new Date(Date.now() - 6 * 86400 * 1000 + 8 * 3600 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
  const events = [{ description: 'Departed origin facility', location: 'Shenzhen, CN', time: sixDaysAgoUtc8 }];
  const normal = analyzeTrackingHealth(events, 'in_transit');
  const configured = analyzeTrackingHealth(events, 'in_transit', { stuckDays: 5 });
  assert.strictEqual(normal.severity, 'ok');
  assert.strictEqual(configured.severity, 'critical');
});

console.log('DB: disposed filter + claim notes');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ued-ship-dispos-'));
const dbPath = path.join(tmpDir, 'test.db');
const db = initDb(dbPath);
const now = Math.floor(Date.now() / 1000);

db.prepare(`INSERT INTO groups (group_id, label) VALUES (?, ?)`).run('g1', 'Group 1');
db.prepare(`INSERT INTO shops (shop_id, group_id, shop_name) VALUES (?, ?, ?)`).run('1', 'g1', 'TestShop');

db.prepare(`
  INSERT INTO receipts (
    receipt_id, shop_id, group_id, name, etsy_created_at, etsy_updated_at,
    tracking_code, fourpx_consignment_no, fourpx_tracking_no,
    tracking_status, tracking_last_event, tracking_last_event_at,
    tracking_last_location, tracking_health, tracking_health_reason,
    shipment_notified_at
  ) VALUES
    (101, '1', 'g1', 'Buyer Disposed', @now, @now,
     '4PX3003001181713CN', 'C1', '4PX3003001181713CN',
     'in_transit', 'Undeliverable Package, Disposal Authorized by Shipper', @now,
     'Kent, WA', 'ok', NULL, @now),
    (102, '1', 'g1', 'Buyer OK', @now, @now,
     '4PX3003009999999CN', 'C2', '4PX3003009999999CN',
     'in_transit', 'Shipment in transit', @now,
     'Los Angeles, CA', 'ok', NULL, @now),
    (103, '1', 'g1', 'Buyer Loc Disposed', @now, @now,
     '4PX3003006517302CN', 'C3', '4PX3003006517302CN',
     'in_transit', 'Attempted delivery: no access', @now,
     'Kent, WA 98032 / Parcel disposal', 'warning', 'No carrier update for 8 days.', @now),
    (108, '1', 'g1', 'Buyer Destroyed', @now, @now,
     '4PX3003007777777CN', 'C8', '4PX3003007777777CN',
     'exception', 'Shipment has been destroyed.', @now,
     'Nancheng', 'critical', 'Carrier reported a delivery exception.', @now)
`).run({ now });
// Simulate a stale delivery verdict written before destruction/disposal support.
db.prepare('UPDATE receipts SET tracking_delivered_at = ? WHERE receipt_id = 108').run(now);

db.prepare(`
  INSERT INTO receipts (
    receipt_id, shop_id, group_id, name, etsy_created_at, etsy_updated_at,
    tracking_code, fourpx_consignment_no, tracking_status,
    tracking_last_event, tracking_last_event_at, tracking_health,
    shipment_notified_at, fourpx_order_status, archived_at
  ) VALUES
    (104, '1', 'g1', 'Disposition is not disposal', @now, @now,
     '4PX-DISPOSITION', 'C4', 'in_transit',
     'Package disposition update received', @now, 'ok', @now, NULL, NULL),
    (105, '1', 'g1', 'Old actionable parcel', @oldShip, @oldShip,
     '4PX-OLD-STUCK', 'C5', 'in_transit',
     'Held by customs', @oldEvent, 'critical', @oldShip, NULL, NULL),
    (106, '1', 'g1', 'Cancelled shipment', @now, @now,
     '4PX-CANCELLED', 'C6', 'in_transit',
     'Shipment in transit', @now, 'ok', @now, 'cancelled', NULL),
    (107, '1', 'g1', 'Archived shipment', @now, @now,
     '4PX-ARCHIVED', 'C7', 'in_transit',
     'Shipment in transit', @now, 'ok', @now, NULL, @now),
    (109, '1', 'g1', 'Label never accepted', @now, @now,
     '4PX-LABEL-ONLY', 'C9', 'pre_transit',
     'Parcel information received', @now, 'critical', @now, NULL, NULL)
`).run({
  now,
  oldShip: now - 60 * 86400,
  oldEvent: now - 35 * 86400,
});
db.prepare(`
  UPDATE receipts
  SET tracking_health_reason = 'No carrier acceptance scan for 12 days after label creation.'
  WHERE receipt_id = 109
`).run();

check('backfillDisposedTrackingFlags upgrades cached disposal rows', () => {
  const n = backfillDisposedTrackingFlags(db);
  assert.ok(n >= 2);
  const r = db.prepare('SELECT tracking_status, tracking_health FROM receipts WHERE receipt_id = 101').get();
  assert.strictEqual(r.tracking_status, 'exception');
  assert.strictEqual(r.tracking_health, 'critical');
  const disposition = db.prepare('SELECT tracking_status, tracking_health, tracking_is_disposed FROM receipts WHERE receipt_id = 104').get();
  assert.strictEqual(disposition.tracking_status, 'in_transit');
  assert.strictEqual(disposition.tracking_health, 'ok');
  assert.strictEqual(disposition.tracking_is_disposed, 0);
  assert.strictEqual(
    db.prepare('SELECT tracking_is_disposed FROM receipts WHERE receipt_id = 108').get().tracking_is_disposed,
    1,
    'official destroyed wording must enter the compensation queue',
  );
  assert.strictEqual(
    db.prepare('SELECT tracking_delivered_at FROM receipts WHERE receipt_id = 108').get().tracking_delivered_at,
    null,
    'disposal repair must clear a contradictory delivered timestamp',
  );
});

check('getShippingStats.disposed counts disposal parcels', () => {
  const s = getShippingStats(db, {});
  assert.strictEqual(Number(s.disposed), 3);
  assert.strictEqual(Number(s.stuck), 1, 'Disposed parcels must not be double-counted in Stuck');
  assert.strictEqual(Number(s.label_only), 1, 'A never-accepted label counts separately from Stuck');
  assert.strictEqual(Number(s.total), 7, 'Cancelled and archived parcels must stay off the board');
});

check('a label never accepted by the carrier is Label-only, not Stuck', () => {
  const stuck = getShipments(db, { status: 'stuck', limit: 50 });
  assert.ok(!stuck.rows.some((r) => r.tracking_no === '4PX-LABEL-ONLY'), 'label-only row leaked into the Stuck bucket');
  const labelOnly = getShipments(db, { status: 'label_only', limit: 50 });
  assert.strictEqual(labelOnly.total, 1);
  assert.strictEqual(labelOnly.rows[0].tracking_no, '4PX-LABEL-ONLY');
  assert.strictEqual(labelOnly.rows[0].is_label_only, 1);
  assert.strictEqual(labelOnly.rows[0].is_stuck, 0, 'is_stuck must stay false for a label-only row');
});

check('a label-only parcel never enters the alert inbox or needs a buyer message', () => {
  const { alerts } = getShippingAlerts(db, {});
  assert.ok(!alerts.some((row) => row.tracking_no === '4PX-LABEL-ONLY'), 'label-only is an internal drop-off gap, not a carrier-side alert');
  const all = getShipments(db, { status: 'all', limit: 50 }).rows.find((r) => r.tracking_no === '4PX-LABEL-ONLY');
  assert.strictEqual(all.outreach_needed, 0, 'no buyer message is owed for an un-dropped-off label');
});

check('getShipments status=disposed returns only disposed', () => {
  const { rows, total } = getShipments(db, { status: 'disposed', limit: 50 });
  assert.strictEqual(total, 3);
  assert.strictEqual(rows.every((r) => r.is_disposed === 1), true);
  assert.ok(rows.some((r) => r.tracking_no === '4PX3003001181713CN'));
});

check('getShipments status=stuck respects Period and All dates retains the full backlog', () => {
  const { rows, total } = getShipments(db, {
    status: 'stuck',
    from: now - 30 * 86400,
    to: now,
    limit: 50,
  });
  // 105 shipped 60d ago with last event 35d ago. The bounded lifecycle view
  // excludes it; the explicit All-dates assertion below preserves the backlog.
  assert.strictEqual(total, 0, 'Stuck Period view included a parcel with no in-window activity');
  assert.strictEqual(rows.length, 0);
});

check('getShipments lifecycle browse still respects Period', () => {
  const { rows } = getShipments(db, {
    status: 'in_transit',
    from: now - 30 * 86400,
    to: now,
    limit: 50,
  });
  assert.ok(
    !rows.some((r) => r.tracking_no === '4PX-OLD-STUCK'),
    'Old stuck falls out of lifecycle Period browse',
  );
});

check('getShipments period window still includes open parcels with recent activity', () => {
  db.prepare(`
    UPDATE receipts
    SET tracking_last_event_at = ?, shipment_notified_at = ?
    WHERE receipt_id = 105
  `).run(now - 2 * 86400, now - 60 * 86400);
  const { rows } = getShipments(db, {
    status: 'in_transit',
    from: now - 30 * 86400,
    to: now,
    limit: 50,
  });
  assert.ok(
    rows.some((r) => r.tracking_no === '4PX-OLD-STUCK'),
    'Recent carrier activity keeps an older shipment in the period',
  );
});

check('getShipments All dates still surfaces the full stuck backlog', () => {
  const { total } = getShipments(db, { status: 'stuck', limit: 50 });
  assert.strictEqual(total, 1);
});

check('getShippingStats action queues ignore Period and match alerts', () => {
  const alerts = getShippingAlerts(db, {}).summary;
  const scoped = getShippingStats(db, { from: now - 7 * 86400, to: now });
  const all = getShippingStats(db, {});
  assert.strictEqual(Number(scoped.disposed), Number(alerts.disposed));
  assert.strictEqual(Number(scoped.stuck), Number(alerts.stuck));
  assert.strictEqual(Number(scoped.delayed), Number(alerts.delayed));
  assert.strictEqual(Number(all.disposed), Number(alerts.disposed));
  assert.strictEqual(Number(all.stuck), Number(alerts.stuck));
});

check('getShippingAlerts returns open stuck and disposed parcels and ignores date windows', () => {
  const { alerts, summary } = getShippingAlerts(db, {});
  assert.strictEqual(Number(summary.disposed), 3);
  assert.strictEqual(Number(summary.stuck), 1);
  assert.strictEqual(Number(summary.total), 4);
  const kinds = alerts.map((row) => row.abnormal_kind).sort();
  assert.deepStrictEqual(kinds, ['disposed', 'disposed', 'disposed', 'stuck']);
  assert.ok(alerts.some((row) => row.tracking_no === '4PX-OLD-STUCK'));
  assert.ok(!alerts.some((row) => row.receipt_id === 102));
  assert.ok(!alerts.some((row) => row.receipt_id === 106));
});

check('updateShippingClaim persists note + status', () => {
  const r1 = updateShippingClaim(db, 101, { note: 'Filed claim #ABC — awaiting 4PX', status: 'claimed' });
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.shipping_claim_status, 'claimed');
  const row = getShipments(db, { status: 'disposed', limit: 50 }).rows.find((x) => x.receipt_id === 101);
  assert.strictEqual(row.shipping_claim_note, 'Filed claim #ABC — awaiting 4PX');
  assert.strictEqual(row.shipping_claim_status, 'claimed');
});

check('updateShippingClaim rejects invalid status', () => {
  const r = updateShippingClaim(db, 101, { status: 'banana' });
  assert.strictEqual(r.ok, false);
});

check('open claims counted in stats', () => {
  updateShippingClaim(db, 103, { status: 'investigating', note: 'gathering evidence' });
  const s = getShippingStats(db, {});
  assert.strictEqual(Number(s.claims_open), 2);
});

check('a live disposal snapshot clears a stale delivered timestamp', () => {
  db.prepare(`
    UPDATE receipts
    SET tracking_status = 'delivered', tracking_delivered_at = @now,
        tracking_health = 'ok', tracking_is_disposed = 0
    WHERE receipt_id = 102
  `).run({ now });
  updateTrackingDetail(db, 102, {
    status: 'exception',
    lastEvent: 'Parcel Disposal',
    lastEventAt: now,
    health: {
      severity: 'critical',
      reasons: ['Parcel disposed by carrier.'],
      isDisposed: true,
    },
    checkedAt: now,
  });
  const row = db.prepare(`
    SELECT tracking_status, tracking_delivered_at, tracking_is_disposed
    FROM receipts WHERE receipt_id = 102
  `).get();
  assert.strictEqual(row.tracking_status, 'exception');
  assert.strictEqual(row.tracking_delivered_at, null);
  assert.strictEqual(row.tracking_is_disposed, 1);
});

check('disposed precedence keeps a contradictory legacy row in the alert inbox', () => {
  db.prepare('UPDATE receipts SET tracking_delivered_at = ? WHERE receipt_id = 102').run(now);
  const alert = getShippingAlerts(db).alerts.find((row) => row.receipt_id === 102);
  assert.ok(alert, 'stale delivered_at must not hide an explicit disposal');
  assert.strictEqual(alert.abnormal_kind, 'disposed');
});

try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch {}

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll shipping disposal / claim tests passed.');
