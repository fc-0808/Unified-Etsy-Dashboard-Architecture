'use strict';

/**
 * Buyer-outreach desk for stuck and disposed 4PX parcels.
 *
 * Etsy Open API v3 cannot send shop-to-buyer messages, so the dashboard drafts
 * a policy-safe template, the operator pastes it on Etsy, then attests here.
 * These tests pin the rules that keep that desk honest:
 *
 *   · only stuck and disposed are eligible (delayed/healthy stay watch-only);
 *   · templates pass the same Etsy-policy scanner as Issues, with 4PX codes
 *     present but not flagged as phone numbers;
 *   · mark-sent writes an append-only log and a receipts snapshot;
 *   · a stuck send does not cover a later disposal (follow_up);
 *   · undo of a follow-up restores the stuck snapshot, not a blank desk;
 *   · a relapse (recover then stuck again) clears the snapshot so the new
 *     incident starts unmessaged, without wiping history;
 *   · hostile copy is refused;
 *   · the board filter and stats card agree with the snapshot.
 *
 * Run: node scripts/test-shipping-buyer-notice.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  composeShippingBuyerNotice,
  checkShippingNoticeCompliance,
} = require('../src/support/shipping-buyer-notice');

const {
  initDb,
  getShipments,
  getShippingStats,
  getShippingBuyerNotice,
  recordShippingBuyerNotice,
  clearShippingBuyerNotice,
  syncShippingAlertLedger,
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ued-ship-notice-'));
const db = initDb(path.join(tmpDir, 'test.db'));
const now = Math.floor(Date.now() / 1000);

db.prepare('INSERT INTO groups (group_id, label) VALUES (?, ?)').run('g1', 'Group 1');
db.prepare('INSERT INTO shops (shop_id, group_id, shop_name) VALUES (?, ?, ?)').run('1', 'g1', 'Y2K Shop');

function seedParcel({ id, name = 'Ada Lovelace', status = 'in_transit', health = 'ok', event = 'Shipment in transit', disposed = 0, country = 'US' }) {
  db.prepare(`
    INSERT INTO receipts (
      receipt_id, shop_id, group_id, name, etsy_created_at, etsy_updated_at,
      tracking_code, fourpx_consignment_no, fourpx_tracking_no,
      tracking_status, tracking_last_event, tracking_last_event_at,
      tracking_health, tracking_is_disposed, tracking_checked_at, shipment_notified_at,
      shipping_country_iso
    ) VALUES (
      @id, '1', 'g1', @name, @now, @now,
      @tracking, @consignment, @tracking,
      @status, @event, @now,
      @health, @disposed, @now, @now,
      @country
    )
  `).run({
    id,
    name,
    now,
    tracking: `4PX${String(id).padStart(10, '0')}CN`,
    consignment: `C-${id}`,
    status,
    event,
    health,
    disposed,
    country,
  });
}

function setParcel(id, { health, status, disposed = 0, event = null, checkedAt = now }) {
  db.prepare(`
    UPDATE receipts
    SET tracking_health = @health,
        tracking_status = @status,
        tracking_is_disposed = @disposed,
        tracking_last_event = COALESCE(@event, tracking_last_event),
        tracking_checked_at = @checkedAt
    WHERE receipt_id = @id
  `).run({ id, health, status, disposed, event, checkedAt });
}

seedParcel({ id: 301, name: 'Stuck Buyer', health: 'critical', event: 'Held by customs' });
seedParcel({ id: 302, name: 'Disposed Buyer', health: 'critical', status: 'exception', disposed: 1, event: 'Parcel Disposal' });
seedParcel({ id: 303, name: 'Delayed Buyer', health: 'warning', event: 'No update for 8 days' });
seedParcel({ id: 304, name: 'Healthy Buyer', health: 'ok' });
seedParcel({ id: 305, name: 'Relapse Buyer', health: 'critical', event: 'No movement' });

syncShippingAlertLedger(db);

console.log('Templates — policy-safe copy with a real 4PX tracking code');

check('stuck template names the buyer, shop, tracking, and stays on Etsy', () => {
  const { kind, message, compliance } = composeShippingBuyerNotice({
    kind: 'stuck',
    shopName: 'Y2K Shop',
    buyerName: 'Ada Lovelace',
    trackingNo: '4PX3003038549111CN',
    lastEvent: 'Held by customs',
    country: 'US',
  });
  assert.strictEqual(kind, 'stuck');
  assert.ok(message.includes('Hi Ada,'));
  assert.ok(message.includes('Y2K Shop'));
  assert.ok(message.includes('4PX3003038549111CN'));
  assert.ok(!message.includes('Held by customs'), 'carrier last-event text is never quoted to the buyer');
  assert.ok(/keep all replies here on Etsy/i.test(message));
  assert.ok(!/whatsapp|wechat|http:\/\/|4px\.com|\+\d{8}/i.test(message));
  assert.strictEqual(compliance.ok, true, JSON.stringify(compliance.violations || []));
});

check('disposed template asks the carrier about the address without promising a refund', () => {
  const { kind, message, compliance } = composeShippingBuyerNotice({
    kind: 'disposed',
    shopName: 'Y2K Shop',
    buyerName: 'Chen, Wei',
    trackingNo: '4PX3003038549222CN',
    lastEvent: 'Parcel Disposal',
    country: 'GB',
  });
  assert.strictEqual(kind, 'disposed');
  assert.ok(message.includes('Hi Wei,'));
  assert.ok(/disposed or undeliverable/i.test(message));
  assert.ok(!/refund/i.test(message));
  assert.ok(/keep all communication here on Etsy/i.test(message));
  assert.strictEqual(compliance.ok, true, JSON.stringify(compliance.violations || []));
});

check('a 4PX tracking code is not mistaken for a phone number', () => {
  const result = checkShippingNoticeCompliance('Your tracking number is 4PX3003038549111CN.');
  assert.strictEqual(result.ok, true, JSON.stringify(result.violations || []));
});

check('carrier last-event phone numbers cannot poison the one-click attestation', () => {
  const hostile = [
    'Delivery failed Note: We were unable to access the delivery. Tel:15985123456',
    '??????????:15985123456 CN',
    'Call 1-800-555-0100 for pickup',
  ];
  for (const lastEvent of hostile) {
    const { message, compliance } = composeShippingBuyerNotice({
      kind: 'stuck',
      shopName: 'Y2KASEshop',
      buyerName: 'Angela Lin',
      trackingNo: '4PX3003056719299CN',
      lastEvent,
      country: 'US',
    });
    assert.ok(!message.includes('15985'), `event digits must not appear: ${lastEvent}`);
    assert.ok(!message.includes('800-555'), `event phone must not appear: ${lastEvent}`);
    assert.strictEqual(compliance.ok, true, JSON.stringify({ lastEvent, violations: compliance.violations }));
  }
});

check('unknown kinds are refused before any copy is produced', () => {
  assert.throws(() => composeShippingBuyerNotice({ kind: 'delayed' }), /stuck or disposed/);
});

console.log('Eligibility');

check('stuck and disposed start as outreach needed; delayed and healthy are ineligible', () => {
  assert.strictEqual(getShippingBuyerNotice(db, 301).outreach_status, 'needed');
  assert.strictEqual(getShippingBuyerNotice(db, 301).eligible, true);
  assert.strictEqual(getShippingBuyerNotice(db, 301).draft.kind, 'stuck');
  assert.strictEqual(getShippingBuyerNotice(db, 302).outreach_status, 'needed');
  assert.strictEqual(getShippingBuyerNotice(db, 302).draft.kind, 'disposed');
  assert.strictEqual(getShippingBuyerNotice(db, 303).eligible, false);
  assert.strictEqual(getShippingBuyerNotice(db, 303).outreach_status, 'ineligible');
  assert.strictEqual(getShippingBuyerNotice(db, 304).eligible, false);
});

check('marking a delayed parcel sent is refused', () => {
  const result = recordShippingBuyerNotice(db, 303, { notifiedBy: 'owner' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.status, 400);
});

console.log('Mark sent / undo');

check('mark sent writes the log, snapshot, and Etsy order URL', () => {
  const before = getShippingBuyerNotice(db, 301);
  const result = recordShippingBuyerNotice(db, 301, { notifiedBy: 'owner' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.outreach_status, 'sent');
  assert.strictEqual(result.notice_kind, 'stuck');
  assert.strictEqual(result.notified_by, 'owner');
  assert.ok(result.notified_at > 0);
  assert.strictEqual(result.last_message, before.draft.message);
  assert.ok(result.etsy_order_url.includes('/your/orders/sold?order_id=301'));
  assert.strictEqual(result.history.length, 1);
  assert.strictEqual(result.history[0].notice_kind, 'stuck');
});

check('hostile copy is refused and does not dirty the snapshot', () => {
  const before = getShippingBuyerNotice(db, 302);
  const result = recordShippingBuyerNotice(db, 302, {
    message: 'Hi, WhatsApp me at +1 415 555 0100 or paypal.me/shop',
    notifiedBy: 'owner',
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.status, 400);
  assert.ok(result.compliance && result.compliance.ok === false);
  const after = getShippingBuyerNotice(db, 302);
  assert.strictEqual(after.outreach_status, 'needed');
  assert.strictEqual(after.notified_at, before.notified_at);
});

check('undo of a first send returns the parcel to needed', () => {
  const result = clearShippingBuyerNotice(db, 301);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.outreach_status, 'needed');
  assert.strictEqual(result.history.length, 0);
  assert.strictEqual(result.notified_at, null);
});

check('re-send after undo is a fresh log row', () => {
  const result = recordShippingBuyerNotice(db, 301, { notifiedBy: 'owner' });
  assert.strictEqual(result.outreach_status, 'sent');
  assert.strictEqual(result.history.length, 1);
});

console.log('Escalation follow-up');

check('a stuck send becomes follow_up when the parcel is disposed', () => {
  setParcel(301, { health: 'critical', status: 'exception', disposed: 1, event: 'Parcel Disposal', checkedAt: now + 60 });
  syncShippingAlertLedger(db);
  const state = getShippingBuyerNotice(db, 301);
  assert.strictEqual(state.outreach_status, 'follow_up');
  assert.strictEqual(state.current_kind, 'disposed');
  assert.strictEqual(state.notice_kind, 'stuck');
  assert.strictEqual(state.draft.kind, 'disposed');
});

check('recording the disposed follow-up clears the queue', () => {
  const result = recordShippingBuyerNotice(db, 301, { notifiedBy: 'owner' });
  assert.strictEqual(result.outreach_status, 'sent');
  assert.strictEqual(result.notice_kind, 'disposed');
  assert.strictEqual(result.history.length, 2);
  assert.strictEqual(result.history[0].notice_kind, 'disposed');
});

check('undo of the follow-up restores the stuck snapshot (still follow_up)', () => {
  const result = clearShippingBuyerNotice(db, 301);
  assert.strictEqual(result.outreach_status, 'follow_up');
  assert.strictEqual(result.notice_kind, 'stuck');
  assert.strictEqual(result.history.length, 1);
  assert.strictEqual(result.history[0].notice_kind, 'stuck');
});

console.log('Relapse');

check('recover then stuck again clears the snapshot but keeps history', () => {
  recordShippingBuyerNotice(db, 305, { notifiedBy: 'owner' });
  assert.strictEqual(getShippingBuyerNotice(db, 305).outreach_status, 'sent');
  const historyBefore = db.prepare('SELECT COUNT(*) AS n FROM shipping_buyer_notices WHERE receipt_id = 305').get().n;
  assert.strictEqual(historyBefore, 1);

  setParcel(305, { health: 'ok', status: 'in_transit', disposed: 0, checkedAt: now + 120 });
  syncShippingAlertLedger(db);
  assert.strictEqual(getShippingBuyerNotice(db, 305).eligible, false);

  setParcel(305, { health: 'critical', status: 'in_transit', disposed: 0, event: 'Held again', checkedAt: now + 180 });
  syncShippingAlertLedger(db);

  const relapsed = getShippingBuyerNotice(db, 305);
  assert.strictEqual(relapsed.eligible, true);
  assert.strictEqual(relapsed.outreach_status, 'needed', 'a new incident must be messaged again');
  assert.strictEqual(relapsed.notified_at, null);
  assert.strictEqual(relapsed.history.length, 1, 'append-only history survives the snapshot reset');
});

console.log('Board filter and stats');

check('stats.outreach_needed counts stuck + disposed that still need a send', () => {
  const stats = getShippingStats(db);
  // 302 never sent; 301 is follow_up (needed); 305 relapsed (needed); 303/304 ineligible.
  assert.strictEqual(stats.outreach_needed, 3);
});

check('getShipments outreach=needed / sent agree with the snapshot', () => {
  const needed = getShipments(db, { outreach: 'needed' });
  const sent = getShipments(db, { outreach: 'sent' });
  const neededIds = needed.rows.map((r) => r.receipt_id).sort((a, b) => a - b);
  assert.deepStrictEqual(neededIds, [301, 302, 305]);
  assert.ok(needed.rows.every((r) => r.outreach_needed === 1));
  assert.ok(needed.rows.every((r) => r.outreach_status === 'needed' || r.outreach_status === 'follow_up'));
  assert.ok(!sent.rows.some((r) => [301, 302, 305].includes(r.receipt_id)));
});

check('unmessaged rows sort ahead of messaged ones on the open board', () => {
  recordShippingBuyerNotice(db, 302, { notifiedBy: 'owner' });
  const board = getShipments(db, {});
  const firstNeeded = board.rows.findIndex((r) => r.outreach_needed === 1);
  const firstSentEligible = board.rows.findIndex((r) => r.outreach_status === 'sent');
  assert.ok(firstNeeded >= 0);
  assert.ok(firstSentEligible >= 0);
  assert.ok(firstNeeded < firstSentEligible);
});

db.close();
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

console.log(`\n${failed ? `${failed} shipping buyer-notice check(s) failed.` : 'All shipping buyer-notice checks passed.'}`);
process.exit(failed ? 1 : 0);
