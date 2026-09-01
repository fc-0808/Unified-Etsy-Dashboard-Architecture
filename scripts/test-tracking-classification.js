'use strict';

/**
 * Tracking status classification tests.
 *
 * The bug these lock down: 4PX forwards last-mile partner wording almost
 * verbatim, and most of those partners never use the word "delivered". A
 * completed hand-off arrives as "Secure delivery (Enclosed porch)", "ENTREGADO"
 * or "The recipient has picked up the shipment from the retail outlet". A narrow
 * keyword list left those parcels at in_transit; because a delivered parcel then
 * never gets another scan, the no-movement heuristic reported them as STUCK.
 *
 * Every string in the "real feed" block below was taken from this account's own
 * Shipping tab, so the suite is a regression net against live carrier wording.
 *
 * Run: node scripts/test-tracking-classification.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  classifyTrackingList,
  normalizeOfficialTrackingData,
  normalizePublicTrackingItem,
  analyzeTrackingHealth,
  _withHealth,
  isDeliveredText,
  isExceptionText,
  OFFICIAL_API_METHOD,
  OFFICIAL_API_VERSION,
} = require('../src/tracking/checker');
const { normalizeFourpxLookupCode } = require('../src/tracking/validation');
const {
  initDb,
  backfillDeliveredTrackingFlags,
  backfillDisposedTrackingFlags,
  backfillFalseCustomsStuckFlags,
  queueOverdueTrackingRechecks,
  getShipments,
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

/** Classify a single latest-event description the way the official API path does. */
function classifyDesc(description, location = null) {
  return classifyTrackingList([
    { businessLinkCode: 'FPX_D_LM', occurDatetime: '2026-08-10 09:00:00', trackingContent: description, location },
    { businessLinkCode: 'FPX_L_RPIF', occurDatetime: '2026-07-01 09:00:00', trackingContent: 'Parcel information received' },
  ]).status;
}

console.log('Real wording from the live 4PX feed');

// [event description, expected canonical status]
const REAL_FEED = [
  // Completed deliveries that never say "delivered" — the reported bug.
  ['Secure delivery (Enclosed porch)', 'delivered'],
  ['Secure delivery (Back door)', 'delivered'],
  ['The recipient has picked up the shipment from the retail outlet', 'delivered'],
  ['ENTREGADO. Su envío está entregado.', 'delivered'],
  // Genuinely still moving — these must KEEP their stuck escalation path.
  ['ITEM IN TRANSIT', 'in_transit'],
  ['Shipment arrived to transit hub', 'in_transit'],
  ['Arrival at Destination Facility', 'in_transit'],
  ['Communication failed', 'in_transit'],
  ['No channel available', 'in_transit'],
  // Real problems stay problems.
  ['Delivery failed Note: We were unable to access the delivery location due to gate code', 'exception'],
  ['Undeliverable Package, Disposal Authorized by Shipper', 'exception'],
  ['Parcel Disposal', 'exception'],
];

for (const [desc, expected] of REAL_FEED) {
  check(`${expected.padEnd(10)} ← ${desc.length > 62 ? desc.slice(0, 59) + '…' : desc}`, () => {
    assert.strictEqual(classifyDesc(desc), expected);
  });
}

console.log('Official 4PX response contract');

check('uses the method and version published by the current official document', () => {
  assert.strictEqual(OFFICIAL_API_METHOD, 'tr.order.tracking.get');
  assert.strictEqual(OFFICIAL_API_VERSION, '1.0.0');
});

check('accepts official numeric/downstream identifiers without relaxing input safety', () => {
  assert.strictEqual(normalizeFourpxLookupCode('1234567890123'), '1234567890123');
  assert.strictEqual(normalizeFourpxLookupCode('1z8e26y00366094077'), '1Z8E26Y00366094077');
  assert.throws(() => normalizeFourpxLookupCode(`1Z');alert(1);//`), /invalid|unsupported/i);
});

check('official tracking uses the shared UTF-8-safe 4PX client', () => {
  const checkerSource = fs.readFileSync(path.resolve(__dirname, '../src/tracking/checker.js'), 'utf8');
  const apiSource = fs.readFileSync(path.resolve(__dirname, '../src/fourpx/api.js'), 'utf8');
  assert.match(checkerSource, /const \{ callApi \} = require\('\.\.\/fourpx\/api'\)/);
  assert.ok(!checkerSource.includes('function computeSign('), 'tracking must not fork signing/response headers');
  assert.match(apiSource, /'Accept':\s+'\*\/\*'/, 'gateway response must remain UTF-8 instead of question marks');
});

check('normalizes official fields losslessly and sorts an oldest-first response', () => {
  const result = normalizeOfficialTrackingData({
    trackingList: [
      {
        businessLinkCode: 'FPX_L_RPIF',
        occurDatetime: '2026-08-20 08:45:13',
        timeZone: 'UTC+08:00',
        occurLocation: 'Nancheng',
        country: 'CN',
        trackingContent: 'Parcel information received',
      },
      {
        businessLinkCode: 'FPX_S_OK',
        occurDatetime: '2026-08-27 13:20:12',
        timeZone: 'UTC+02:00',
        occurLocation: '212 16 Malmö',
        country: 'SE',
        trackingContent: 'Paketet har levererats hem till dig',
      },
    ],
  });
  assert.strictEqual(result.status, 'delivered', 'published delivery code must be authoritative');
  assert.strictEqual(result.events[0].code, 'FPX_S_OK', 'newest event must lead regardless of input order');
  assert.strictEqual(result.events[0].timeZone, 'UTC+02:00');
  assert.strictEqual(result.events[0].location, '212 16 Malmö, SE');
  assert.ok(Number.isInteger(result.events[0].timestamp));
});

check('published destruction code is disposal even without disposal wording', () => {
  const result = normalizeOfficialTrackingData({
    trackingList: [{
      businessLinkCode: 'FPX_C_DT',
      occurDatetime: '2026-08-24 23:23:11',
      timeZone: 'UTC+08:00',
      occurLocation: 'Nancheng',
      trackingContent: 'Operation completed',
    }],
  });
  assert.strictEqual(result.status, 'exception');
  assert.strictEqual(_withHealth(result).health.isDisposed, true);
});

check('official occurLocation participates in location-only disposal detection', () => {
  const status = classifyTrackingList([{
    businessLinkCode: 'FPX_D_UNDG',
    occurDatetime: '2026-08-18 19:56:43',
    timeZone: 'UTC-10:00',
    occurLocation: 'Honolulu / Parcel Disposal',
    trackingContent: 'Undeliverable package',
  }]).status;
  assert.strictEqual(status, 'exception');
});

check('a delivery terminal embedded in occurLocation outranks an SMS failure description', () => {
  const result = normalizeOfficialTrackingData({
    trackingList: [{
      businessLinkCode: 'FPX_O_NM',
      occurDatetime: '2026-08-18 06:04:39',
      timeZone: 'UTC+02:00',
      occurLocation: 'Consignee - Parcel delivered (B2C) - SMS: failed to deliver sms',
      trackingContent: 'Communication failed',
    }],
  });
  assert.strictEqual(result.status, 'delivered');
});

check('public tkLocation/tkTimezone/tkDate survive normalization', () => {
  const result = normalizePublicTrackingItem({
    status: 1, // aggregate lags the event terminal
    tracks: [{
      tkCode: 'FPX_S_OK',
      tkDate: '2026-08-27T05:20:12.000+0000',
      tkDateStr: '2026-08-27 13:20:12',
      tkTimezone: 'UTC+10:00',
      tkLocation: 'WELSHPOOL, WA',
      tkTranslatedDesc: 'Paketet har levererats hem till dig',
    }],
  });
  assert.strictEqual(result.status, 'delivered');
  assert.strictEqual(result.events[0].location, 'WELSHPOOL, WA');
  assert.strictEqual(result.events[0].timeZone, 'UTC+10:00');
  assert.strictEqual(result.events[0].timestamp, 1787808012);
});

check('current public aggregate statuses preserve lifecycle and abnormal states', () => {
  const physical = [{
    tkCode: 'FPX_C_SPLS',
    tkDate: '2026-08-27T05:20:12.000+0000',
    tkDateStr: '2026-08-27 13:20:12',
    tkTranslatedDesc: 'Shipment picked up.',
  }];
  const expected = new Map([
    [0, 'exception'],
    [1, 'in_transit'],
    [2, 'delivered'],
    [3, 'in_transit'], // physical event disproves a lagging forecast aggregate
    [4, 'in_transit'], // awaiting recipient pickup
    [5, 'exception'],
    [6, 'in_transit'], // stalled is lifecycle=in transit, health=critical
    [7, 'unknown'],
  ]);
  for (const [status, canonical] of expected) {
    assert.strictEqual(
      normalizePublicTrackingItem({ status, tracks: physical }).status,
      canonical,
      `public status ${status}`,
    );
  }
  assert.strictEqual(normalizePublicTrackingItem({
    status: 3,
    tracks: [{
      tkCode: 'FPX_L_RPIF',
      tkDate: '2026-08-27T05:20:12.000+0000',
      tkDateStr: '2026-08-27 13:20:12',
      tkTranslatedDesc: 'Parcel information received',
    }],
  }).status, 'pre_transit');
});

check('public returnStatusFlag promotes an otherwise-moving parcel to exception', () => {
  const result = normalizePublicTrackingItem({
    status: 1,
    returnStatusFlag: 2,
    tracks: [{
      tkCode: 'FPX_C_SPLS',
      tkDate: '2026-08-27T05:20:12.000+0000',
      tkDateStr: '2026-08-27 13:20:12',
      tkTranslatedDesc: 'Shipment picked up.',
    }],
  });
  assert.strictEqual(result.status, 'exception');
  assert.strictEqual(result.carrierState, 'returned');
});

console.log('Unattended and collected hand-offs');
for (const desc of [
  'Delivered',
  'Item delivered',
  'Delivery completed',
  'Successfully delivered',
  'Signed for by resident',
  'Left in safe place',
  'Left with neighbour',
  'Left in porch',
  'Delivered to a secure location',
  'Proof of delivery captured',
  'Picked up by the customer',
  'Collected by recipient',
  'Received by the recipient',
  'Handed over to the recipient',
]) {
  check(`delivered   ← ${desc}`, () => assert.strictEqual(classifyDesc(desc), 'delivered'));
}

console.log('Non-English terminals 4PX forwards untranslated');
for (const [desc, lang] of [
  ['ENTREGADO', 'es'],
  ['Entrega realizada', 'es'],
  ['Objeto entregue ao destinatário', 'pt'],
  ['Colis livré au destinataire', 'fr'],
  ['Livraison effectuée', 'fr'],
  ['Votre envoi a été distribué dans la boîte à lettres.', 'fr'],
  ['Votre envoi a �t� distribu� dans la bo�te � lettres.', 'fr-legacy-cache'],
  ['Sendung zugestellt', 'de'],
  ['Consegnato al destinatario', 'it'],
  ['Zending bezorgd', 'nl'],
  ['Przesyłka dostarczona', 'pl'],
  ['Levererad', 'sv'],
  ['Paketet har levererats hem till dig', 'sv'],
  ['Paketet �r upph�mtat hos ombud', 'sv-legacy-cache'],
  ['包裹已签收', 'zh'],
  ['已妥投', 'zh'],
]) {
  check(`delivered   ← [${lang}] ${desc}`, () => assert.strictEqual(classifyDesc(desc), 'delivered'));
}

console.log('False positives the guard must refuse');
// Each of these CONTAINS delivery wording but is not a completed delivery.
// Reading any of them as delivered would silently hide a real problem.
for (const [desc, expected, why] of [
  ['Out for delivery', 'in_transit', 'still on the van'],
  ['Attempted delivery', 'in_transit', 'attempt, not a delivery'],
  ['Delivery attempted - no answer', 'in_transit', 'attempt, not a delivery'],
  ['Ready for collection at retail outlet', 'in_transit', 'uncollected is actionable, not done'],
  ['Available for pickup', 'in_transit', 'uncollected is actionable, not done'],
  ['Awaiting collection by recipient', 'in_transit', 'uncollected is actionable, not done'],
  ['Arrived at delivery office', 'in_transit', 'a facility, not the buyer'],
  ['Handed over to local delivery carrier', 'in_transit', 'handed to a carrier, not the buyer'],
  ['No entregado', 'in_transit', 'Spanish negation'],
  ['Sendung nicht zugestellt', 'in_transit', 'German negation'],
  ['Colis non livré', 'in_transit', 'French negation'],
  ['Not delivered', 'in_transit', 'English negation'],
  ['Undelivered - returning to sender', 'exception', 'a failed delivery is an exception'],
  ['Delivery failed', 'exception', 'a failed delivery is an exception'],
]) {
  check(`${expected.padEnd(10)} ← ${desc}  (${why})`, () => assert.strictEqual(classifyDesc(desc), expected));
}

console.log('Precedence');

check('a delivery terminal outranks exception keywords on the same event', () => {
  // Without delivered-first precedence, "unsuccessful" would win and a completed
  // delivery would be reported as an exception.
  assert.strictEqual(classifyDesc('Delivered after an unsuccessful first attempt'), 'delivered');
});

check('an informational row appended after a hard delivery terminal stays delivered', () => {
  const status = classifyTrackingList([
    { businessLinkCode: 'FPX_O_NM', occurDatetime: '2026-08-11 09:00:00', trackingContent: 'SMS notification sent' },
    { businessLinkCode: 'FPX_S_OK', occurDatetime: '2026-08-10 09:00:00', trackingContent: 'Paketet har levererats hem till dig' },
  ]).status;
  assert.strictEqual(status, 'delivered');
});

check('a disposal terminal is never downgraded by delivery-shaped text elsewhere', () => {
  assert.strictEqual(classifyDesc('Parcel Disposal', 'Kent, WA 98032'), 'exception');
});

check('disposal in the location field still wins', () => {
  assert.strictEqual(classifyDesc('Attempted delivery: no access', 'Kent, WA 98032 / Parcel disposal'), 'exception');
});

check('a label-only timeline is still pre-transit', () => {
  const status = classifyTrackingList([
    { businessLinkCode: 'FPX_L_RPIF', occurDatetime: '2026-08-01 09:00:00', trackingContent: 'Parcel information received' },
  ]).status;
  assert.strictEqual(status, 'pre_transit');
});

console.log("Health: a delivered parcel is never stuck, however 4PX labels it");

/**
 * A carrier timestamp `days` ago, in the format 4PX emits.
 *
 * Health verdicts are decided by how OLD an event is, so these fixtures have to
 * be dated relative to the run. Absolute dates silently change meaning as the
 * calendar advances and eventually cross a different warning/critical threshold.
 */
function agoStamp(days) {
  return new Date(Date.now() - days * 86400_000).toISOString().replace('T', ' ').slice(0, 19);
}

const silentDeliveredTimeline = [
  { time: agoStamp(30), description: 'Secure delivery (Enclosed porch)', code: 'FPX_D_LM', location: 'GB' },
  { time: agoStamp(31), description: 'Out for delivery', code: 'FPX_D_OFD', location: 'GB' },
  { time: agoStamp(45), description: 'Shipment in transit', code: 'FPX_F_ST', location: 'CN' },
];

check('the reported case is ok, not critical, even when status says in_transit', () => {
  // A month of silence after a completed delivery. This is the exact shape that
  // produced "In transit / stuck" rows on the Shipping tab.
  const health = analyzeTrackingHealth(silentDeliveredTimeline, 'in_transit', { stuckDays: 10 });
  assert.strictEqual(health.severity, 'ok');
  assert.strictEqual(health.isStuck, false);
  assert.deepStrictEqual(health.reasons, []);
});

check('a silent parcel that never reached delivery is still critical', () => {
  // Upstream of the destination network — genuine stall. Destination-hub /
  // last-mile silence receives a wider grace period in separate tests below.
  const stuck = [
    { time: agoStamp(30), description: 'Shipment picked up.', code: 'FPX_C_SPLS', location: 'CN' },
    { time: agoStamp(45), description: 'Parcel information received', code: 'FPX_L_RPIF', location: 'CN' },
  ];
  const health = analyzeTrackingHealth(stuck, 'in_transit', { stuckDays: 10 });
  assert.strictEqual(health.severity, 'critical', 'genuine stalls must still escalate');
  assert.strictEqual(health.isStuck, true);
});

check('an active customs hold that has gone quiet is critical', () => {
  const held = [
    { time: agoStamp(12), description: 'Customs check', code: 'FPX_I_CC', location: 'US' },
    { time: agoStamp(14), description: 'Arrival to the destination airport', code: 'FPX_M_ATA', location: 'US' },
    { time: agoStamp(20), description: 'Shipment picked up.', code: 'FPX_C_SPLS', location: 'CN' },
  ];
  const health = analyzeTrackingHealth(held, 'in_transit', { stuckDays: 10 });
  assert.strictEqual(health.severity, 'critical');
  assert.strictEqual(health.isStuck, true);
  assert.ok(/held at customs/i.test(health.reasons[0]));
});

check('a label-only parcel becomes delayed, then stuck, when 4PX never accepts it', () => {
  const delayed = analyzeTrackingHealth(
    [{ time: agoStamp(8), description: 'Parcel information received', code: 'FPX_L_RPIF' }],
    'pre_transit',
    { stuckDays: 10 },
  );
  assert.strictEqual(delayed.severity, 'warning');
  assert.strictEqual(delayed.isStuck, false);

  const stuck = analyzeTrackingHealth(
    [{ time: agoStamp(11), description: 'Parcel information received', code: 'FPX_L_RPIF' }],
    'pre_transit',
    { stuckDays: 10 },
  );
  assert.strictEqual(stuck.severity, 'critical');
  assert.strictEqual(stuck.isStuck, true);
  assert.match(stuck.reasons[0], /acceptance scan/i);
});

check('silence over 45 days is never treated as proof of delivery', () => {
  const health = analyzeTrackingHealth(
    [{ time: agoStamp(60), description: 'Shipment picked up.', code: 'FPX_C_SPLS', location: 'CN' }],
    'in_transit',
    { stuckDays: 10 },
  );
  assert.strictEqual(health.severity, 'critical');
  assert.strictEqual(health.isStuck, true);
});

check('destination-network silence gets a wider grace period, not permanent immunity', () => {
  const recent = analyzeTrackingHealth(
    [{ time: agoStamp(12), description: 'ITEM IN TRANSIT', code: 'FPX_O_RR', location: 'Vancouver, CA' }],
    'in_transit',
    { stuckDays: 10 },
  );
  assert.strictEqual(recent.severity, 'warning');
  assert.strictEqual(recent.isStuck, false);

  const stalled = analyzeTrackingHealth(
    [{ time: agoStamp(21), description: 'ITEM IN TRANSIT', code: 'FPX_O_RR', location: 'Vancouver, CA' }],
    'in_transit',
    { stuckDays: 10 },
  );
  assert.strictEqual(stalled.severity, 'critical');
  assert.strictEqual(stalled.isStuck, true);
  assert.match(stalled.reasons[0], /destination network/i);
});

check('an official delay code enters the Delayed queue immediately', () => {
  const health = analyzeTrackingHealth(
    [{ time: agoStamp(1), description: 'Transport delay, wait for flight.', code: 'FPX_M_TDWF' }],
    'in_transit',
    { stuckDays: 10 },
  );
  assert.strictEqual(health.severity, 'warning');
  assert.strictEqual(health.isStuck, false);
  assert.match(health.reasons[0], /carrier reported a delay/i);
});

check('public awaiting-pickup and stalled states have explicit health severity', () => {
  const track = [{
    tkCode: 'FPX_D_AP',
    tkDate: new Date().toISOString(),
    tkDateStr: agoStamp(0),
    tkTranslatedDesc: 'Awaiting pick up by recipient as requested.',
  }];
  const pickup = _withHealth(normalizePublicTrackingItem({ status: 4, tracks: track }));
  assert.strictEqual(pickup.status, 'in_transit');
  assert.strictEqual(pickup.health.severity, 'warning');
  assert.strictEqual(pickup.health.isStuck, false);
  assert.match(pickup.health.reasons[0], /awaiting recipient pickup/i);

  const stalled = _withHealth(normalizePublicTrackingItem({ status: 6, tracks: track }));
  assert.strictEqual(stalled.status, 'in_transit');
  assert.strictEqual(stalled.health.severity, 'critical');
  assert.strictEqual(stalled.health.isStuck, true);
  assert.match(stalled.health.reasons[0], /trajectory as stalled/i);
});

check('a critical silence reason outranks an earlier delay warning on the board', () => {
  const health = analyzeTrackingHealth(
    [{ time: agoStamp(21), description: 'Transport delay, wait for flight.', code: 'FPX_M_TDWF' }],
    'in_transit',
    { stuckDays: 10 },
  );
  assert.strictEqual(health.severity, 'critical');
  assert.match(health.reasons[0], /no carrier update/i);
});

console.log('Health: recent post-customs progress receives a destination grace period');

/** Real China→US timeline shape that previously false-flagged as Stuck. */
function livePostCustomsTimeline(latestDesc, latestDaysAgo = 0.75) {
  return [
    { time: agoStamp(latestDaysAgo), description: latestDesc, code: 'FPX_M_IT', location: 'US' },
    { time: agoStamp(1.5), description: 'Handed over to last mile', code: 'FPX_D_STPP', location: 'US' },
    { time: agoStamp(1.6), description: 'Released from customs: customs cleared.\n', code: 'FPX_I_RCUK', location: 'US' },
    { time: agoStamp(5), description: 'Released from customs: customs cleared.\n', code: 'FPX_I_RCUK', location: 'US' },
    { time: agoStamp(7), description: 'Arrived at warehouse', code: 'FPX_M_CRSD', location: 'US' },
    { time: agoStamp(7.1), description: 'Customs check', code: 'FPX_I_CC', location: 'US' },
    { time: agoStamp(8), description: 'Arrival to the destination airport', code: 'FPX_M_ATA', location: 'US' },
    { time: agoStamp(8.5), description: 'Customs check', code: 'FPX_I_CC', location: 'US' },
    { time: agoStamp(11), description: 'Relased from export customs.', code: 'FPX_Q_ECC', location: 'CN' },
    { time: agoStamp(12), description: 'Shipment picked up.', code: 'FPX_C_SPLS', location: 'CN' },
  ];
}

for (const latest of [
  'Departed destination hub',
  'Arrived at origin hub',
  'Handed over to last mile',
]) {
  check(`ok ← live lane ending in "${latest}" (was false Stuck)`, () => {
    const health = analyzeTrackingHealth(livePostCustomsTimeline(latest), 'in_transit', { stuckDays: 10 });
    assert.strictEqual(health.severity, 'ok', `expected ok, got ${health.severity}: ${health.reasons.join('; ')}`);
    assert.strictEqual(health.isStuck, false);
    assert.deepStrictEqual(health.reasons, []);
  });
}

check('customs clearances are not counted as holds', () => {
  // Five events containing the word "customs", but only two are holds — and both
  // were cleared before destination progress. Must stay ok.
  const health = analyzeTrackingHealth(livePostCustomsTimeline('Departed destination hub'), 'in_transit', { stuckDays: 10 });
  assert.ok(!health.reasons.some((r) => /customs/i.test(r)));
});

check('warning severity is Delayed, not Stuck', () => {
  // Long transit upstream of destination → warning only.
  const delayed = [
    { time: agoStamp(1), description: 'Shipment picked up.', code: 'FPX_C_SPLS', location: 'CN' },
    { time: agoStamp(28), description: 'Parcel information received', code: 'FPX_L_RPIF', location: 'CN' },
  ];
  const health = analyzeTrackingHealth(delayed, 'in_transit', { stuckDays: 10 });
  assert.strictEqual(health.severity, 'warning');
  assert.strictEqual(health.isStuck, false, 'warning must not set isStuck');
});

check('_withHealth promotes the public API integer status to delivered', () => {
  // The public endpoint reports its own aggregate status, which lags its
  // partners. Status 1 (in_transit) + a delivery terminal must become delivered.
  const promoted = _withHealth({ events: silentDeliveredTimeline, status: 'in_transit', source: 'public' });
  assert.strictEqual(promoted.status, 'delivered');
  assert.strictEqual(promoted.health.severity, 'ok');
});

check('_withHealth still promotes disposal to exception', () => {
  const disposed = _withHealth({
    events: [{ time: '2026-07-05 14:12:00', description: 'Parcel Disposal', code: 'FPX_D_LM', location: 'CN' }],
    status: 'in_transit',
    source: 'public',
  });
  assert.strictEqual(disposed.status, 'exception');
  assert.strictEqual(disposed.health.isDisposed, true);
});

check('the exported text helpers agree with the classifier', () => {
  assert.strictEqual(isDeliveredText('Secure delivery (Enclosed porch)'), true);
  assert.strictEqual(isDeliveredText(null, 'ENTREGADO'), true);
  assert.strictEqual(isDeliveredText('Out for delivery'), false);
  assert.strictEqual(isDeliveredText(''), false);
  assert.strictEqual(isDeliveredText(null, undefined), false);
  assert.strictEqual(isExceptionText('Delivery failed'), true);
  assert.strictEqual(isExceptionText('Secure delivery (Back door)'), false);
});

console.log('Repairing rows already cached in the database');
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ued-track-class-'));
  const db = initDb(path.join(tmpDir, 'test.db'));
  const now = Math.floor(Date.now() / 1000);
  const eventAt = now - 12 * 86400;

  db.prepare('INSERT INTO groups (group_id, label) VALUES (?, ?)').run('g1', 'G1');
  db.prepare('INSERT INTO shops (shop_id, group_id, shop_name) VALUES (?, ?, ?)').run('1', 'g1', 'TestShop');

  const seed = db.prepare(`
    INSERT INTO receipts (
      receipt_id, shop_id, group_id, name, etsy_created_at, etsy_updated_at,
      tracking_code, fourpx_consignment_no, fourpx_tracking_no,
      tracking_status, tracking_last_event, tracking_last_event_at,
      tracking_last_location, tracking_health, tracking_health_reason,
      tracking_is_disposed, shipment_notified_at
    ) VALUES (
      @id, '1', 'g1', @name, @now, @now,
      @tracking, @consignment, @tracking,
      @status, @event, @eventAt,
      @location, @health, @reason,
      @disposed, @now
    )
  `);
  const rows = [
    [301, 'UK safe place', 'in_transit', 'Secure delivery (Enclosed porch)', 'GB', 'critical', 'No carrier update for 11 days.', 0],
    [302, 'DE collected', 'in_transit', 'The recipient has picked up the shipment from the retail outlet', 'DE', 'critical', 'No carrier update for 33 days.', 0],
    [303, 'ES delivered', 'in_transit', 'ENTREGADO. Su envío está entregado.', 'ES', 'critical', 'No carrier update for 28 days.', 0],
    [304, 'Genuinely stuck', 'in_transit', 'Shipment picked up.', 'CN', 'critical', 'No carrier update for 41 days.', 0],
    [305, 'Disposed', 'exception', 'Parcel Disposal', 'CN', 'critical', 'Parcel disposed or destroyed by carrier — review 4PX claim eligibility.', 1],
    [306, 'Already delivered', 'delivered', 'Delivered', 'US', 'ok', null, 0],
    [307, 'False customs stuck', 'in_transit', 'Arrived at Origin Hub', 'US', 'critical', '6 customs scans with no delivery — likely held at customs.', 0],
    [308, 'Last mile false stuck', 'in_transit', 'Handed over to last mile', 'US', 'critical', '6 customs scans with no delivery — likely held at customs.', 0],
    [309, 'Departed hub false stuck', 'in_transit', 'Departed Destination Hub', 'US', 'critical', '7 customs scans with no delivery — likely held at customs.', 0],
    [310, 'Cleared customs false stuck', 'in_transit', 'Released from customs: customs cleared.\n', 'US', 'critical', '7 customs scans with no delivery — likely held at customs.', 0],
  ];
  for (const [id, name, status, event, location, health, reason, disposed] of rows) {
    seed.run({ id, name, status, event, location, health, reason, disposed, eventAt, now, tracking: `4PX${id}0000000CN`, consignment: `C-${id}` });
  }

  const read = (id) => db.prepare('SELECT tracking_status, tracking_health, tracking_health_reason, tracking_delivered_at FROM receipts WHERE receipt_id = ?').get(id);

  check('the repair reclassifies exactly the delivered parcels', () => {
    assert.strictEqual(backfillDeliveredTrackingFlags(db), 3);
    for (const id of [301, 302, 303]) {
      const row = read(id);
      assert.strictEqual(row.tracking_status, 'delivered', `receipt ${id} should be delivered`);
      assert.strictEqual(row.tracking_health, 'ok', `receipt ${id} should be healthy`);
      assert.strictEqual(row.tracking_health_reason, null, `receipt ${id} should lose its stuck reason`);
      assert.strictEqual(row.tracking_delivered_at, eventAt, `receipt ${id} should record when it landed`);
    }
  });

  check('a genuinely stuck parcel is left alone', () => {
    const row = read(304);
    assert.strictEqual(row.tracking_status, 'in_transit');
    assert.strictEqual(row.tracking_health, 'critical');
  });

  check('a disposed parcel keeps its compensation verdict', () => {
    const row = read(305);
    assert.strictEqual(row.tracking_status, 'exception');
    assert.strictEqual(row.tracking_health, 'critical');
  });

  check('the repair is idempotent', () => {
    assert.strictEqual(backfillDeliveredTrackingFlags(db), 0);
  });

  check('it composes with the disposal repair in either order', () => {
    backfillDisposedTrackingFlags(db);
    assert.strictEqual(backfillDeliveredTrackingFlags(db), 0);
    assert.strictEqual(read(305).tracking_status, 'exception');
  });

  check('false customs-loop Stuck rows heal when last event is past customs', () => {
    assert.strictEqual(backfillFalseCustomsStuckFlags(db), 4);
    for (const id of [307, 308, 309, 310]) {
      const row = read(id);
      assert.strictEqual(row.tracking_health, 'ok', `receipt ${id} should leave the stuck queue`);
      assert.strictEqual(row.tracking_health_reason, null);
      assert.strictEqual(row.tracking_status, 'in_transit');
    }
    // Upstream silence stall must remain.
    assert.strictEqual(read(304).tracking_health, 'critical');
  });

  check('customs false-positive repair is idempotent', () => {
    assert.strictEqual(backfillFalseCustomsStuckFlags(db), 0);
  });

  check('the repaired parcels leave the stuck queue on the Shipping board', () => {
    const stuck = getShipments(db, { status: 'stuck', limit: 50 });
    const ids = stuck.rows.map((r) => r.receipt_id).sort();
    assert.deepStrictEqual(ids, [304], 'only the genuine stall remains stuck');
  });

  check('deployment migration queues overdue rows for authoritative carrier recheck', () => {
    seed.run({
      id: 311,
      name: 'Unaccepted label',
      status: 'pre_transit',
      event: 'Parcel information received',
      eventAt: now - 12 * 86400,
      location: 'CN',
      health: 'ok',
      reason: null,
      disposed: 0,
      now,
      tracking: '4PX3110000000CN',
      consignment: 'C-311',
    });
    seed.run({
      id: 312,
      name: 'Destination silence',
      status: 'in_transit',
      event: 'ITEM IN TRANSIT',
      eventAt: now - 21 * 86400,
      location: 'Vancouver, CA',
      health: 'ok',
      reason: null,
      disposed: 0,
      now,
      tracking: '4PX3120000000CN',
      consignment: 'C-312',
    });
    db.prepare('UPDATE receipts SET tracking_checked_at = ? WHERE receipt_id IN (311, 312)').run(now);

    assert.ok(
      queueOverdueTrackingRechecks(db, { stuckDays: 10, nowEpoch: now }) >= 2,
      'the two newly seeded overdue rows must be queued',
    );
    for (const id of [311, 312]) {
      const row = read(id);
      assert.strictEqual(row.tracking_health, 'ok', 'one cached event must not publish a verdict');
      assert.strictEqual(
        db.prepare('SELECT tracking_checked_at FROM receipts WHERE receipt_id = ?').get(id).tracking_checked_at,
        null,
        'cleared freshness makes the locked worker select the parcel',
      );
    }
    assert.strictEqual(queueOverdueTrackingRechecks(db, { stuckDays: 10, nowEpoch: now }), 0, 'queueing is idempotent');
  });

  db.close();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nPASS — tracking classification + cached-row repair');
