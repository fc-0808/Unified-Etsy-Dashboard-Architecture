'use strict';

/**
 * Unit tests for the Shipping morning-review alert inbox.
 *
 * The feature answers one operational question every morning: which abnormal
 * parcels are NEW since I last worked this queue? These tests pin the rules that
 * make that answer trustworthy:
 *
 *   · never-reviewed parcels are new;
 *   · reviewing silences a parcel WITHOUT resolving it;
 *   · escalation (delayed → stuck → disposed) re-alerts;
 *   · de-escalation does not;
 *   · recovery clears the acknowledgement, so a relapse is a fresh incident.
 *
 * It also covers the two surfaces that answer the question: the banner, and the
 * per-row NEW mark on the parcel board (the table the operator actually reads,
 * where the banner's capped list runs out), plus the incident ledger that lets
 * a row say "flagged 5h ago" on OUR clock rather than the carrier's back-dated
 * event clock.
 *
 * Run: node scripts/test-shipping-alerts.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  initDb,
  getShipments,
  getShippingAlerts,
  reviewShippingAlerts,
  pruneShippingAlertReviews,
  syncShippingAlertLedger,
  SHIPPING_ALERT_SEVERITY_RANK,
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ued-ship-alerts-'));
const db = initDb(path.join(tmpDir, 'test.db'));
const now = Math.floor(Date.now() / 1000);

db.prepare('INSERT INTO groups (group_id, label) VALUES (?, ?)').run('g1', 'Group 1');
db.prepare('INSERT INTO shops (shop_id, group_id, shop_name) VALUES (?, ?, ?)').run('1', 'g1', 'TestShop');
db.prepare('INSERT INTO shops (shop_id, group_id, shop_name) VALUES (?, ?, ?)').run('2', 'g1', 'OtherShop');

/** Seed one 4PX parcel. `health`/`status` drive which abnormal bucket it lands in. */
function seedParcel({ id, shop = '1', name = 'Buyer', status = 'in_transit', health = 'ok', event = 'Shipment in transit', disposed = 0, eventAt = now, checkedAt = now }) {
  db.prepare(`
    INSERT INTO receipts (
      receipt_id, shop_id, group_id, name, etsy_created_at, etsy_updated_at,
      tracking_code, fourpx_consignment_no, fourpx_tracking_no,
      tracking_status, tracking_last_event, tracking_last_event_at,
      tracking_health, tracking_is_disposed, tracking_checked_at, shipment_notified_at
    ) VALUES (
      @id, @shop, 'g1', @name, @now, @now,
      @tracking, @consignment, @tracking,
      @status, @event, @eventAt,
      @health, @disposed, @checkedAt, @now
    )
  `).run({
    id,
    shop,
    name,
    now,
    tracking: `4PX${String(id).padStart(10, '0')}CN`,
    consignment: `C-${id}`,
    status,
    event,
    eventAt,
    health,
    disposed,
    checkedAt,
  });
}

/**
 * Move a parcel between abnormal states the way a carrier sync would: the health
 * verdict changes and the check timestamp advances, because a state change is
 * only ever discovered by a check.
 */
function setHealth(id, { health, status, disposed = 0, deliveredAt = null, checkedAt = null }) {
  db.prepare(`
    UPDATE receipts
    SET tracking_health = @health,
        tracking_status = @status,
        tracking_is_disposed = @disposed,
        tracking_delivered_at = @deliveredAt,
        tracking_checked_at = COALESCE(@checkedAt, tracking_checked_at)
    WHERE receipt_id = @id
  `).run({ id, health, status, disposed, deliveredAt, checkedAt });
}

const alertFor = (id) => getShippingAlerts(db).alerts.find((a) => a.receipt_id === id);

// 201 stuck · 202 delayed · 203 healthy (must never alert) · 204 disposed
seedParcel({ id: 201, name: 'Stuck Buyer', health: 'critical', event: 'Held by customs' });
seedParcel({ id: 202, name: 'Delayed Buyer', health: 'warning', event: 'No update for 8 days' });
seedParcel({ id: 203, name: 'Healthy Buyer', health: 'ok' });
seedParcel({ id: 204, name: 'Disposed Buyer', shop: '2', health: 'critical', status: 'exception', disposed: 1, event: 'Parcel Disposal' });

console.log('Alert inbox — what counts as new');

check('severity ranking orders disposed above stuck above delayed above exception', () => {
  assert.ok(SHIPPING_ALERT_SEVERITY_RANK.disposed > SHIPPING_ALERT_SEVERITY_RANK.stuck);
  assert.ok(SHIPPING_ALERT_SEVERITY_RANK.stuck > SHIPPING_ALERT_SEVERITY_RANK.delayed);
  assert.ok(SHIPPING_ALERT_SEVERITY_RANK.delayed > SHIPPING_ALERT_SEVERITY_RANK.exception);
});

check('every never-reviewed abnormal parcel starts new, healthy parcels never appear', () => {
  const { alerts, summary } = getShippingAlerts(db);
  assert.strictEqual(summary.total, 3, 'only abnormal parcels are listed');
  assert.strictEqual(summary.new_total, 3, 'nothing reviewed yet, so everything is new');
  assert.strictEqual(summary.new_disposed, 1);
  assert.strictEqual(summary.new_stuck, 1);
  assert.strictEqual(summary.new_delayed, 1);
  assert.strictEqual(summary.last_reviewed_at, null);
  assert.ok(alerts.every((a) => a.is_new === true));
  assert.ok(!alerts.some((a) => a.receipt_id === 203), 'a healthy parcel is not an alert');
});

check('new parcels sort ahead of reviewed ones, most severe first', () => {
  const { alerts } = getShippingAlerts(db);
  assert.strictEqual(alerts[0].abnormal_kind, 'disposed', 'disposed leads the queue');
  assert.ok(alerts[0].severity_rank >= alerts[alerts.length - 1].severity_rank);
});

console.log('Acknowledging');

check('reviewing a single parcel clears only that one', () => {
  const result = reviewShippingAlerts(db, { receiptIds: [201], reviewedBy: 'owner' });
  assert.strictEqual(result.reviewed, 1);
  assert.deepStrictEqual(result.receipt_ids, [201]);

  const { summary } = getShippingAlerts(db);
  assert.strictEqual(summary.total, 3, 'reviewing does not resolve the parcel');
  assert.strictEqual(summary.new_total, 2);
  assert.strictEqual(summary.new_stuck, 0);

  const reviewed = alertFor(201);
  assert.strictEqual(reviewed.is_new, false);
  assert.strictEqual(reviewed.reviewed_by, 'owner');
  assert.ok(reviewed.reviewed_at > 0);
});

check('an empty receipt_ids array is a no-op, never "review everything"', () => {
  const before = getShippingAlerts(db).summary.new_total;
  const result = reviewShippingAlerts(db, { receiptIds: [] });
  assert.strictEqual(result.reviewed, 0);
  assert.strictEqual(getShippingAlerts(db).summary.new_total, before);
});

check('unknown and healthy ids are ignored rather than recorded', () => {
  const result = reviewShippingAlerts(db, { receiptIds: [203, 999999] });
  assert.strictEqual(result.reviewed, 0, 'a healthy or missing parcel is not reviewable');
  assert.strictEqual(getShippingAlerts(db).summary.total, 3);
});

check('reviewing with no id list clears the whole inbox', () => {
  const result = reviewShippingAlerts(db, { reviewedBy: 'owner' });
  assert.strictEqual(result.reviewed, 2, 'the two still-new parcels');
  const { summary, alerts } = getShippingAlerts(db);
  assert.strictEqual(summary.new_total, 0);
  assert.strictEqual(summary.total, 3, 'the board is unchanged — review is not resolve');
  assert.ok(alerts.every((a) => a.is_new === false));
  assert.ok(summary.last_reviewed_at > 0);
});

check('re-reviewing an unchanged inbox writes nothing', () => {
  assert.strictEqual(reviewShippingAlerts(db).reviewed, 0);
});

console.log('Escalation and recovery');

check('escalating delayed → stuck re-alerts the parcel', () => {
  assert.strictEqual(alertFor(202).is_new, false);
  setHealth(202, { health: 'critical', status: 'in_transit' });
  const escalated = alertFor(202);
  assert.strictEqual(escalated.is_new, true, 'a worse parcel is new work');
  assert.strictEqual(escalated.abnormal_kind, 'stuck');
  assert.strictEqual(getShippingAlerts(db).summary.new_stuck, 1);
});

check('escalating stuck → disposed re-alerts again', () => {
  reviewShippingAlerts(db);
  assert.strictEqual(alertFor(202).is_new, false);
  setHealth(202, { health: 'critical', status: 'exception', disposed: 1 });
  const escalated = alertFor(202);
  assert.strictEqual(escalated.is_new, true);
  assert.strictEqual(escalated.abnormal_kind, 'disposed');
});

check('de-escalating does not re-alert — no new action is needed', () => {
  reviewShippingAlerts(db);
  setHealth(202, { health: 'warning', status: 'in_transit' });
  const eased = alertFor(202);
  assert.strictEqual(eased.abnormal_kind, 'delayed');
  assert.strictEqual(eased.is_new, false, 'a parcel that improved is not new work');
});

check('a delivered parcel leaves the inbox and its acknowledgement is pruned', () => {
  setHealth(201, { health: 'ok', status: 'delivered', deliveredAt: now });
  const { alerts } = getShippingAlerts(db);
  assert.ok(!alerts.some((a) => a.receipt_id === 201), 'delivered parcels are not abnormal');
  const leftover = db.prepare('SELECT 1 FROM shipping_alert_reviews WHERE receipt_id = 201').get();
  assert.strictEqual(leftover, undefined, 'the stale acknowledgement is cleaned up');
});

check('a relapse after recovery is treated as a brand-new incident', () => {
  // Same parcel, same severity it was reviewed at before it recovered. Without
  // pruning, the stale acknowledgement would silence this forever.
  setHealth(201, { health: 'critical', status: 'in_transit', deliveredAt: null });
  const relapsed = alertFor(201);
  assert.strictEqual(relapsed.is_new, true, 'a recurrence must alert again');
});

check('prune leaves acknowledgements for parcels that are still abnormal', () => {
  reviewShippingAlerts(db);
  const before = db.prepare('SELECT COUNT(*) AS n FROM shipping_alert_reviews').get().n;
  assert.strictEqual(pruneShippingAlertReviews(db), 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM shipping_alert_reviews').get().n, before);
});

console.log('Scoping');

check('shop scope narrows the inbox without affecting stored review state', () => {
  setHealth(204, { health: 'critical', status: 'exception', disposed: 1 });
  const scoped = getShippingAlerts(db, { shopId: '2' });
  assert.ok(scoped.alerts.every((a) => a.shop_id === '2'));
  assert.strictEqual(scoped.summary.total, 1);
  assert.ok(getShippingAlerts(db).summary.total > scoped.summary.total);
});

check('limit is clamped to a sane page', () => {
  assert.strictEqual(getShippingAlerts(db, { limit: -5 }).alerts.length <= 500, true);
  assert.strictEqual(getShippingAlerts(db, { limit: 1 }).alerts.length, 1);
});

check('summary counts the whole abnormal set even when the row list is capped', () => {
  const full = getShippingAlerts(db);
  const capped = getShippingAlerts(db, { limit: 1 });
  assert.ok(full.summary.total > 1, 'need more than one abnormal parcel for this to mean anything');
  assert.strictEqual(capped.summary.total, full.summary.total, 'totals must not shrink with the page size');
  assert.strictEqual(capped.summary.new_total, full.summary.new_total);
  assert.strictEqual(capped.summary.returned, 1, 'returned reports the page size actually sent');
  assert.strictEqual(full.summary.returned, full.alerts.length);
});

check('kind counts are disjoint and add up to the total', () => {
  const { summary } = getShippingAlerts(db);
  const sum = summary.disposed + summary.stuck + summary.delayed + summary.exception;
  assert.strictEqual(sum, summary.total, 'every abnormal parcel lands in exactly one bucket');
  const newSum = summary.new_disposed + summary.new_stuck + summary.new_delayed + summary.new_exception;
  assert.strictEqual(newSum, summary.new_total);
});

console.log('Incident ledger — since when, on our clock');

// Fresh parcels so these assertions do not depend on the state the escalation
// tests above left behind.
const incidentOf = (id) => db.prepare('SELECT * FROM shipping_alert_incidents WHERE receipt_id = ?').get(id);

check('an incident opens dated from the carrier check that found it, not from now', () => {
  // The trap this exists for: 4PX back-dates events, so this parcel's newest
  // event is three weeks old while the dashboard only learned about it an hour
  // ago. Dating the incident from the event would bury genuinely new work.
  seedParcel({ id: 301, name: 'Fresh Stuck', health: 'critical', event: 'Held by customs', eventAt: now - 21 * 86400, checkedAt: now - 3600 });
  const result = syncShippingAlertLedger(db);
  assert.ok(result.opened >= 1);
  const incident = incidentOf(301);
  assert.strictEqual(incident.first_seen_at, now - 3600, 'the check that found it is when we learned');
  assert.strictEqual(incident.flagged_at, now - 3600);
  assert.strictEqual(incident.first_kind, 'stuck');
  assert.strictEqual(incident.peak_rank, SHIPPING_ALERT_SEVERITY_RANK.stuck);
});

check('a healthy parcel never opens an incident', () => {
  seedParcel({ id: 302, name: 'Fine', health: 'ok' });
  syncShippingAlertLedger(db);
  assert.strictEqual(incidentOf(302), undefined);
});

check('reconciling an unchanged set writes nothing', () => {
  assert.deepStrictEqual(syncShippingAlertLedger(db), { opened: 0, escalated: 0, closed: 0, reviews_pruned: 0 });
});

check('the incident timestamps reach the alert payload', () => {
  const alert = getShippingAlerts(db).alerts.find((a) => a.receipt_id === 301);
  assert.strictEqual(alert.first_seen_at, now - 3600);
  assert.strictEqual(alert.flagged_at, now - 3600);
});

check('the newest untriaged incident is reported for the banner headline', () => {
  assert.strictEqual(getShippingAlerts(db).summary.newest_flagged_at, now - 3600);
});

check('escalation moves flagged_at forward but keeps the incident age', () => {
  setHealth(301, { health: 'critical', status: 'exception', disposed: 1, checkedAt: now - 60 });
  const result = syncShippingAlertLedger(db);
  assert.strictEqual(result.escalated, 1);
  const incident = incidentOf(301);
  assert.strictEqual(incident.first_seen_at, now - 3600, 'the incident is still an hour old');
  assert.strictEqual(incident.flagged_at, now - 60, 'but it got worse a minute ago');
  assert.strictEqual(incident.peak_kind, 'disposed');
  assert.strictEqual(incident.first_kind, 'stuck', 'how it started is preserved');
});

check('de-escalation keeps the peak — the outstanding task has not changed', () => {
  setHealth(301, { health: 'warning', status: 'in_transit', disposed: 0, checkedAt: now });
  assert.strictEqual(syncShippingAlertLedger(db).escalated, 0);
  const incident = incidentOf(301);
  assert.strictEqual(incident.peak_kind, 'disposed');
  assert.strictEqual(incident.flagged_at, now - 60, 'a parcel that improved is not re-dated to the front');
});

check('recovery closes the incident and a relapse opens a brand-new one', () => {
  setHealth(301, { health: 'ok', status: 'delivered', deliveredAt: now, checkedAt: now });
  assert.strictEqual(syncShippingAlertLedger(db).closed, 1);
  assert.strictEqual(incidentOf(301), undefined);

  setHealth(301, { health: 'critical', status: 'in_transit', deliveredAt: null, checkedAt: now - 30 });
  assert.strictEqual(syncShippingAlertLedger(db).opened, 1);
  const relapse = incidentOf(301);
  assert.strictEqual(relapse.first_seen_at, now - 30, 'a recurrence is dated from its own detection');
  assert.strictEqual(relapse.peak_kind, 'stuck', 'it does not inherit the old incident severity');
});

check('a nonsense cached check time can never date an incident into the future', () => {
  seedParcel({ id: 303, name: 'Clock Skew', health: 'critical', event: 'Held by customs', checkedAt: now + 30 * 86400 });
  syncShippingAlertLedger(db, { now });
  assert.strictEqual(incidentOf(303).first_seen_at, now, 'clamped to the reconciliation clock');
});

console.log('Parcel board — the NEW mark on the table itself');

const boardRow = (id, opts = {}) => getShipments(db, { limit: 200, ...opts }).rows.find((r) => r.receipt_id === id);

check('every row reports its own review state, so the capped banner is not the only signal', () => {
  const row = boardRow(301);
  assert.strictEqual(row.is_new_alert, 1);
  assert.strictEqual(row.alert_kind, 'stuck');
  assert.strictEqual(row.alert_flagged_at, now - 30);
  assert.strictEqual(row.alert_reviewed_at, null);
});

check('a healthy parcel carries no alert state at all', () => {
  const row = boardRow(302);
  assert.strictEqual(row.is_new_alert, 0);
  assert.strictEqual(row.alert_kind, null, 'a fine parcel has no abnormal kind to show');
  assert.strictEqual(row.alert_flagged_at, null);
});

check('the board and the banner always agree on what is new', () => {
  // The whole feature rests on this: two surfaces, one server-side definition.
  const fromBoard = getShipments(db, { limit: 500 }).rows.filter((r) => r.is_new_alert).map((r) => r.receipt_id).sort();
  const fromInbox = getShippingAlerts(db, { limit: 500 }).alerts.filter((a) => a.is_new).map((a) => a.receipt_id).sort();
  assert.deepStrictEqual(fromBoard, fromInbox);
  assert.ok(fromBoard.length > 0, 'need something new for this to mean anything');
});

check('untriaged parcels lead the board', () => {
  const rows = getShipments(db, { limit: 500 }).rows;
  const lastNew = rows.reduce((acc, r, i) => (r.is_new_alert ? i : acc), -1);
  const firstOld = rows.findIndex((r) => !r.is_new_alert);
  assert.ok(lastNew >= 0 && firstOld >= 0, 'need both groups present');
  assert.ok(lastNew < firstOld, 'nothing already reviewed may outrank untriaged work');
});

check('alertState "new" narrows the board, and the total agrees with the rows', () => {
  const scoped = getShipments(db, { alertState: 'new', limit: 500 });
  assert.ok(scoped.rows.length > 0);
  assert.ok(scoped.rows.every((r) => r.is_new_alert === 1));
  assert.strictEqual(scoped.total, scoped.rows.length, 'the paging total must count the same filtered set');
  assert.strictEqual(scoped.total, getShippingAlerts(db).summary.new_total);
});

check('the "new only" filter composes with the parcel-state filter', () => {
  const stuckAndNew = getShipments(db, { status: 'stuck', alertState: 'new', limit: 500 });
  assert.ok(stuckAndNew.rows.every((r) => r.is_new_alert === 1 && r.is_stuck === 1 && !r.is_disposed));
});

check('acknowledging a parcel drops it from the new board without removing it', () => {
  const before = getShipments(db, { alertState: 'new', limit: 500 }).total;
  reviewShippingAlerts(db, { receiptIds: [301], reviewedBy: 'owner' });
  assert.strictEqual(getShipments(db, { alertState: 'new', limit: 500 }).total, before - 1);
  const row = boardRow(301);
  assert.strictEqual(row.is_new_alert, 0, 'the mark is cleared');
  assert.strictEqual(row.alert_kind, 'stuck', 'but the parcel is still an open problem on the board');
  assert.strictEqual(row.alert_reviewed_by, 'owner');
  assert.ok(row.alert_flagged_at > 0, 'and it still knows how long it has been waiting');
});

console.log('Banner rendering (shipped code, real markup)');
{
  const { JSDOM, VirtualConsole } = require('jsdom');
  const html = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8');

  // Run the SHIPPED renderer against the SHIPPED markup, so these assertions
  // break if either half drifts — a banner test that rebuilds its own DOM would
  // keep passing after the real one was renamed out from under it.
  const jsStart = html.indexOf('// ══ SHIPPING ALERTS ══');
  const jsEnd = html.indexOf('// ══ END SHIPPING ALERTS ══');
  assert.ok(jsStart > 0 && jsEnd > jsStart, 'shipping alert script sentinels missing from public/index.html');
  const moduleSource = html.slice(jsStart, jsEnd);

  const markupStart = html.indexOf('<section class="ship-alert-banner"');
  const markupEnd = html.indexOf('</section>', markupStart) + '</section>'.length;
  assert.ok(markupStart > 0, 'shipping alert banner markup missing from public/index.html');
  const bannerMarkup = html.slice(markupStart, markupEnd);

  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  // The real "New only" control ships in the toolbar, so lift it from the page
  // too rather than hand-rolling a stand-in that cannot drift with it.
  const toggleStart = html.indexOf('<button type="button" class="ship-new-toggle"');
  const toggleEnd = html.indexOf('</button>', toggleStart) + '</button>'.length;
  assert.ok(toggleStart > 0, '"New only" toggle markup missing from public/index.html');
  const toggleMarkup = html.slice(toggleStart, toggleEnd);

  const dom = new JSDOM(
    `<!doctype html><html><body><div class="tabs"><div class="tab" id="tab-btn-shipping">Shipping<span class="tab-alert-badge" id="shipTabAlertBadge"></span></div></div>${bannerMarkup}${toggleMarkup}<div id="shipTableWrap"></div></body></html>`,
    { pretendToBeVisual: true, runScripts: 'dangerously', virtualConsole },
  );
  const { window } = dom;
  // Collaborators the module reaches for, stubbed to the real contracts.
  window.eval(`
    const API = ''
    const toasts = []
    window.__toasts = toasts
    function showToast(msg, kind) { toasts.push({ msg, kind }) }
    function escHtml(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') }
    function escAttr(s) { return escHtml(s).replace(/'/g, '&#39;') }
    function _relTime() { return '3d ago' }
    function fetchJson() { return Promise.reject(new Error('offline')) }
    window.__statusFilter = null
    function setShipStatusFilter(v) { window.__statusFilter = v }
    // Board-side collaborators. The banner and the board are separate sections
    // of the page; only their contract is exercised here.
    window.__boardReloads = 0
    window.__clearedMarkers = []
    function _shipNewOnlyActive() { return document.getElementById('shipNewOnly')?.getAttribute('aria-pressed') === 'true' }
    function loadShipping() { window.__boardReloads += 1 }
    function _clearShipRowNewMarkers(ids) { window.__clearedMarkers.push(ids) }
    ${moduleSource}
    window.renderShippingAlerts = renderShippingAlerts
    window.toggleShippingAlertList = toggleShippingAlertList
    window._shipAlertKey = _shipAlertKey
  `);

  const doc = window.document;
  const banner = doc.getElementById('shipAlertBanner');
  const badge = doc.getElementById('shipTabAlertBadge');
  const newOnly = doc.getElementById('shipNewOnly');

  const alert = (over = {}) => ({
    receipt_id: 1,
    shop_name: 'Y2KASEshop',
    buyer_name: 'Elisabeth Johnson',
    tracking_no: '4PX3003001181713CN',
    abnormal_kind: 'disposed',
    severity_rank: 4,
    tracking_health_reason: 'Parcel disposed or destroyed by carrier — review 4PX claim eligibility.',
    tracking_last_event_at: now,
    is_new: true,
    ...over,
  });

  check('an empty inbox renders no banner and no badge', () => {
    window.renderShippingAlerts({ alerts: [], summary: { total: 0, new_total: 0 } });
    assert.strictEqual(banner.hasAttribute('hidden'), true);
    assert.strictEqual(badge.classList.contains('is-visible'), false);
    assert.strictEqual(doc.getElementById('shipAlertList').innerHTML, '');
  });

  check('a standing backlog with nothing new stays silent', () => {
    window.renderShippingAlerts({
      alerts: [alert({ is_new: false })],
      summary: { total: 1, disposed: 1, new_total: 0, last_reviewed_at: now - 3600 },
    });
    assert.strictEqual(banner.hasAttribute('hidden'), true, 'already-reviewed work must not re-alert');
  });

  check('new parcels raise the banner, the badge and the kind chips', () => {
    window.renderShippingAlerts({
      alerts: [alert(), alert({ receipt_id: 2, abnormal_kind: 'stuck', severity_rank: 3, tracking_no: '4PX3003024171982CN' })],
      summary: { total: 5, disposed: 1, stuck: 1, new_total: 2, new_disposed: 1, new_stuck: 1, last_reviewed_at: null, returned: 2 },
    });
    assert.strictEqual(banner.hasAttribute('hidden'), false);
    assert.match(doc.getElementById('shipAlertTitle').textContent, /^2 new abnormal parcels need action$/);
    assert.strictEqual(badge.textContent, '2');
    assert.strictEqual(badge.classList.contains('is-visible'), true);
    assert.match(doc.getElementById('tab-btn-shipping').getAttribute('title'), /2 abnormal parcels need action/);
    const chips = [...doc.querySelectorAll('.ship-alert-kind')].map((c) => c.dataset.alertKind);
    assert.deepStrictEqual(chips, ['disposed', 'stuck'], 'only non-zero kinds get a chip, most severe first');
    assert.strictEqual(doc.querySelectorAll('.ship-alert-row').length, 2);
    assert.match(doc.getElementById('shipAlertSub').textContent, /No parcels reviewed yet/);
  });

  check('one new parcel reads as singular', () => {
    window.renderShippingAlerts({ alerts: [alert()], summary: { total: 1, disposed: 1, new_total: 1, new_disposed: 1 } });
    assert.strictEqual(doc.getElementById('shipAlertTitle').textContent, '1 new abnormal parcel needs action');
  });

  check('tracking numbers become delegated buttons carrying the number as data', () => {
    window.renderShippingAlerts({ alerts: [alert()], summary: { total: 1, disposed: 1, new_total: 1, new_disposed: 1 } });
    const link = doc.querySelector('.ship-alert-track[data-tracking]');
    assert.strictEqual(link.tagName, 'BUTTON');
    assert.strictEqual(link.dataset.tracking, '4PX3003001181713CN');
    const done = doc.querySelector('.ship-alert-done[data-alert-receipt]');
    assert.strictEqual(done.dataset.alertReceipt, '1');
  });

  check('a non-4PX identifier is plain text, never a tracking button', () => {
    window.renderShippingAlerts({ alerts: [alert({ tracking_no: 'MANUAL-123' })], summary: { total: 1, new_total: 1, disposed: 1, new_disposed: 1 } });
    assert.strictEqual(doc.querySelector('button.ship-alert-track'), null);
  });

  check('a server-verified numeric 4PX identifier remains trackable', () => {
    window.renderShippingAlerts({
      alerts: [alert({ tracking_no: '1234567890123', tracking_lookup_supported: true })],
      summary: { total: 1, new_total: 1, disposed: 1, new_disposed: 1 },
    });
    assert.strictEqual(doc.querySelector('button.ship-alert-track').dataset.tracking, '1234567890123');
  });

  check('hostile shop, buyer and reason text is escaped, not executed', () => {
    window.renderShippingAlerts({
      alerts: [alert({
        shop_name: '<img src=x onerror=alert(1)>',
        buyer_name: '"><script>alert(2)</script>',
        tracking_health_reason: '</span><script>alert(3)</script>',
      })],
      summary: { total: 1, disposed: 1, new_total: 1, new_disposed: 1 },
    });
    assert.strictEqual(doc.querySelectorAll('#shipAlertList script, #shipAlertList img').length, 0, 'no markup escaped the escaper');
    assert.ok(doc.getElementById('shipAlertList').textContent.includes('<img src=x onerror=alert(1)>'), 'the hostile value survives as visible text');
  });

  check('the overflow line counts from the true total, not the rendered page', () => {
    const many = Array.from({ length: 20 }, (_, i) => alert({ receipt_id: 10 + i, tracking_no: `4PX000000000${i}CN` }));
    window.renderShippingAlerts({ alerts: many, summary: { total: 400, disposed: 400, new_total: 350, new_disposed: 350, returned: 20 } });
    assert.strictEqual(doc.querySelectorAll('.ship-alert-row').length, 8, 'the inline list is capped');
    assert.match(doc.querySelector('.ship-alert-more').textContent, /\+ 342 more new parcels/);
    assert.strictEqual(badge.textContent, '99+', 'the badge stays narrow past three digits');
  });

  check('a kind chip opens the board on that queue with the scope cleared', () => {
    window.renderShippingAlerts({ alerts: [alert()], summary: { total: 1, disposed: 1, new_total: 1, new_disposed: 1 } });
    doc.querySelector('.ship-alert-kind[data-alert-kind="disposed"]').click();
    assert.strictEqual(window.__statusFilter, 'disposed', 'the delegated handler drove the real filter');
    // The chip is labelled with a NEW count, so the board it opens must be the
    // new set — otherwise the number the operator just read stops matching the
    // table they land on.
    assert.strictEqual(newOnly.getAttribute('aria-pressed'), 'true');
  });

  check('the board filter mirrors the inbox count and is offered only when usable', () => {
    window.renderShippingAlerts({ alerts: [alert(), alert({ receipt_id: 2 })], summary: { total: 9, disposed: 9, new_total: 2, new_disposed: 2 } });
    assert.strictEqual(doc.getElementById('shipNewOnlyCount').textContent, '2');
    assert.strictEqual(newOnly.disabled, false);
  });

  check('finishing the queue disables the filter and releases it', () => {
    newOnly.setAttribute('aria-pressed', 'true');
    window.renderShippingAlerts({ alerts: [alert({ is_new: false })], summary: { total: 1, disposed: 1, new_total: 0 } });
    assert.strictEqual(newOnly.disabled, true, 'a filter that would empty the board is not offered');
    assert.strictEqual(newOnly.getAttribute('aria-pressed'), 'false', 'and it must not stay latched on an empty set');
    assert.strictEqual(doc.getElementById('shipNewOnlyCount').textContent, '0');
  });

  check('the banner leads with when the newest incident landed', () => {
    window.renderShippingAlerts({ alerts: [alert()], summary: { total: 1, disposed: 1, new_total: 1, new_disposed: 1, newest_flagged_at: now - 3600 } });
    assert.match(doc.getElementById('shipAlertSub').textContent, /^Newest flagged 3d ago\./, 'the overnight/backlog question is answered first');
  });

  // Layout regression. The banner once rendered each status pill as a giant
  // empty oval spanning the whole column, with the reason pushed onto the line
  // below, because a `.ship-alert-why span` rule applied the two-line clamp to
  // BOTH children — and -webkit-box is block-level, so the pill stopped hugging
  // its label. JSDOM has no layout engine, so these pin the structure and the
  // selector scope that decide the layout rather than measuring pixels.
  check('the status pill hugs its label instead of being stretched by the reason clamp', () => {
    window.renderShippingAlerts({ alerts: [alert()], summary: { total: 1, disposed: 1, new_total: 1, new_disposed: 1 } });
    const why = doc.querySelector('.ship-alert-why');
    const status = why.querySelector('.ship-alert-status');
    const pill = why.querySelector('.ship-chip');
    const reason = why.querySelector('.ship-alert-reason');
    assert.ok(status && pill && reason, 'status rail, pill and reason are separate elements');
    assert.strictEqual(pill.classList.contains('ship-alert-reason'), false, 'the pill must never carry the clamp');
    assert.strictEqual(pill.textContent, 'Disposed');
    assert.strictEqual(reason.textContent, 'Parcel disposed or destroyed by carrier — review 4PX claim eligibility.');
    assert.strictEqual(why.children.length, 2, 'exactly two grid cells: status + reason');
    assert.strictEqual(status.nextElementSibling, reason, 'no stray node between the status rail and the reason');
  });

  check('the clamp is scoped to the reason, so no rule can catch the pill again', () => {
    assert.ok(/\.ship-alert-reason\s*\{[^}]*-webkit-line-clamp/.test(html), 'the clamp lives on the reason');
    assert.ok(!/\.ship-alert-why\s+span\s*\{/.test(html), 'no descendant-span rule may reach the pill');
    assert.ok(/\.ship-alert-why\s*\{[^}]*grid-template-columns:\s*5\.5rem/.test(html), 'status pills sit in a fixed-width rail so left edges align');
    assert.ok(/\.ship-alert-why\s+\.ship-chip\s*\{[^}]*flex:\s*0 0 auto/.test(html), 'the pill is pinned to its intrinsic width');
  });

  check('the filter chip separates count from label with gap, not a text node', () => {
    window.renderShippingAlerts({ alerts: [alert()], summary: { total: 1, disposed: 1, new_total: 1, new_disposed: 1 } });
    const chip = doc.querySelector('.ship-alert-kind');
    assert.strictEqual(chip.childNodes.length, 2, 'exactly two flex items, nothing between them');
    assert.strictEqual(chip.childNodes[0].tagName, 'STRONG');
    assert.strictEqual(chip.childNodes[0].textContent, '1');
    assert.strictEqual(chip.childNodes[1].tagName, 'SPAN', 'the label is an explicit item, not anonymous text');
    assert.strictEqual(chip.childNodes[1].textContent, 'Disposed');
  });

  check('the parcel preview list is collapsed by default and expands on demand', () => {
    window.renderShippingAlerts({
      alerts: [alert(), alert({ receipt_id: 2, abnormal_kind: 'stuck', severity_rank: 3, tracking_no: '4PX3003024171982CN' })],
      summary: { total: 5, disposed: 1, stuck: 1, new_total: 2, new_disposed: 1, new_stuck: 1 },
    });
    const details = doc.getElementById('shipAlertDetails');
    const toggle = doc.getElementById('shipAlertToggleList');
    assert.ok(details && toggle, 'expand control and details region ship with the banner');
    assert.strictEqual(details.hidden, true, 'the tall row list stays closed until asked for');
    assert.strictEqual(toggle.getAttribute('aria-expanded'), 'false');
    assert.match(toggle.textContent, /Show 2 parcels/);
    assert.strictEqual(doc.querySelectorAll('.ship-alert-row').length, 2, 'rows are still rendered for expand');
    window.toggleShippingAlertList();
    assert.strictEqual(details.hidden, false);
    assert.strictEqual(toggle.getAttribute('aria-expanded'), 'true');
    assert.strictEqual(toggle.textContent, 'Hide list');
    window.toggleShippingAlertList();
    assert.strictEqual(details.hidden, true);
    assert.strictEqual(toggle.getAttribute('aria-expanded'), 'false');
  });

  check('the alert fingerprint changes only when the new set changes', () => {
    const a = { alerts: [alert()], summary: {} };
    const same = { alerts: [alert({ buyer_name: 'Renamed' })], summary: {} };
    const escalated = { alerts: [alert({ severity_rank: 3 })], summary: {} };
    assert.strictEqual(window._shipAlertKey(a), window._shipAlertKey(same), 'cosmetic changes must not re-announce');
    assert.notStrictEqual(window._shipAlertKey(a), window._shipAlertKey(escalated), 'an escalation must re-announce');
    assert.strictEqual(window._shipAlertKey({ alerts: [alert({ is_new: false })] }), '', 'reviewed parcels are not part of the fingerprint');
  });

  dom.window.close();
}

console.log('Parcel-activity rendering (shipped renderer, real markup)');
{
  const { JSDOM, VirtualConsole } = require('jsdom');
  const html = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8');

  const jsStart = html.indexOf('// ══ SHIPPING BOARD ══');
  const jsEnd = html.indexOf('// ══ END SHIPPING BOARD ══');
  assert.ok(jsStart > 0 && jsEnd > jsStart, 'shipping board script sentinels missing from public/index.html');
  const moduleSource = html.slice(jsStart, jsEnd);

  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  const dom = new JSDOM(
    '<!doctype html><html><body><table><tbody id="shipRows"></tbody></table></body></html>',
    { pretendToBeVisual: true, runScripts: 'dangerously', virtualConsole },
  );
  const { window } = dom;
  window.eval(`
    let _shipOffset = 0
    function escHtml(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') }
    function escAttr(s) { return escHtml(s).replace(/'/g, '&#39;') }
    function fmtFreightMoney(v, cur) { return cur + ' ' + v }
    function dashboardCardIsOpen() { return false }
    window.__newOnly = false
    function _shipNewOnlyActive() { return window.__newOnly }
    ${moduleSource}
    window.renderShipRows = renderShipRows
    window._clearShipRowNewMarkers = _clearShipRowNewMarkers
  `);

  const doc = window.document;
  const parcel = (over = {}) => ({
    receipt_id: 7001,
    shop_name: 'Y2KASEshop',
    buyer_name: 'Maggie Smith',
    tracking_no: '4PX3003006517302CN',
    tracking_status: 'exception',
    tracking_last_event: 'Parcel Disposal',
    tracking_last_event_at: now - 30 * 86400,
    tracking_checked_at: now - 3600,
    tracking_health: 'critical',
    tracking_health_reason: 'Parcel disposed by carrier.',
    is_disposed: 1,
    is_stuck: 1,
    is_new_alert: 1,
    alert_kind: 'disposed',
    alert_flagged_at: now - 4 * 3600,
    alert_first_seen_at: now - 4 * 3600,
    fourpx_freight_amount: 29.27,
    fourpx_freight_currency: 'CNY',
    ...over,
  });

  check('an untriaged parcel is marked in the row, not just counted in the banner', () => {
    window.renderShipRows([parcel()], true, 10);
    const row = doc.querySelector('#shipRows tr');
    assert.ok(row.classList.contains('ship-row-new'), 'the row itself is highlighted');
    assert.strictEqual(row.dataset.receipt, '7001', 'and is addressable for an in-place repaint');
    assert.strictEqual(row.querySelector('.ship-chip.ship-new').textContent, 'NEW');
    assert.strictEqual(row.querySelector('.ship-row-ack'), null, 'the board no longer has a per-row Reviewed control');
  });

  check('the NEW mark outranks the severity tint so it cannot be lost in the cascade', () => {
    window.renderShipRows([parcel()], true, 10);
    const cls = [...doc.querySelector('#shipRows tr').classList];
    assert.ok(cls.includes('ship-row-disposed') && cls.includes('ship-row-new'));
    assert.ok(cls.indexOf('ship-row-new') > cls.indexOf('ship-row-disposed'), 'order documents the intent');
    assert.ok(/\.ship-row-new td \{/.test(html), 'and the rule exists to win it');
    assert.ok(html.indexOf('.ship-row-new td {') > html.indexOf('.ship-row-disposed td {'), 'declared after the severity tints');
  });

  check('the row states when WE flagged it, next to the back-dated carrier age', () => {
    window.renderShipRows([parcel()], true, 10);
    const ages = doc.querySelector('#shipRows td[data-label="Event / checked"]');
    // The bug this prevents: a disposal discovered four hours ago reads "30d
    // ago" here, because that is the date the carrier put on the scan.
    assert.match(ages.textContent, /30d ago/);
    assert.strictEqual(ages.querySelector('.ship-flagged').textContent, 'Flagged 4h ago');
  });

  check('a reviewed parcel keeps its status but loses every new-work affordance', () => {
    window.renderShipRows([parcel({ is_new_alert: 0, alert_reviewed_at: now - 60 })], true, 10);
    const row = doc.querySelector('#shipRows tr');
    assert.strictEqual(row.classList.contains('ship-row-new'), false);
    assert.strictEqual(row.querySelector('.ship-chip.ship-new'), null);
    assert.strictEqual(row.querySelector('.ship-flagged'), null);
    assert.strictEqual(row.querySelector('.ship-chip.ship-disposed').textContent, 'Disposed', 'it is still a disposal on the board');
    assert.strictEqual(row.querySelectorAll('[data-label="Status"] .ship-chip').length, 1, 'Status shows one operational chip, not Exception + Disposed');
    assert.ok(row.querySelector('[data-label="Actions"]'), 'actions live outside Status');
  });

  check('stuck parcels do not also show Exception in Status', () => {
    window.renderShipRows([parcel({
      is_disposed: 0,
      is_stuck: 1,
      tracking_status: 'exception',
      tracking_health: 'critical',
      tracking_last_event: 'Held by customs',
      tracking_health_reason: 'No movement',
      outreach_status: 'needed',
    })], true, 10);
    const row = doc.querySelector('#shipRows tr');
    const statusText = row.querySelector('[data-label="Status"]').textContent;
    assert.match(statusText, /Stuck/);
    assert.ok(!/Exception/i.test(statusText), 'carrier status is demoted to the chip title, not a second pill');
    assert.ok(row.querySelector('[data-label="Actions"] [data-outreach-receipt]'), 'Message buyer is an Action, not a Status chip');
    assert.strictEqual(row.querySelector('.ship-row-ack'), null, 'Reviewed is not on the row');
  });

  check('the board links a numeric identifier verified as belonging to 4PX', () => {
    window.renderShipRows([parcel({
      tracking_no: '1234567890123',
      tracking_lookup_supported: 1,
    })], true, 10);
    assert.strictEqual(doc.querySelector('.ship-track-link').dataset.tracking, '1234567890123');
  });

  check('an incident with no ledger row degrades to no timestamp rather than a wrong one', () => {
    window.renderShipRows([parcel({ alert_flagged_at: null, alert_first_seen_at: null })], true, 10);
    const row = doc.querySelector('#shipRows tr');
    assert.ok(row.querySelector('.ship-chip.ship-new'), 'still flagged as new');
    assert.strictEqual(row.querySelector('.ship-flagged'), null, 'but never invents an age');
  });

  check('acknowledging repaints only the acknowledged rows, in place', () => {
    window.renderShipRows([parcel(), parcel({ receipt_id: 7002, tracking_no: '4PX3003006517303CN' })], true, 10);
    window._clearShipRowNewMarkers([7001]);
    const rows = [...doc.querySelectorAll('#shipRows tr')];
    assert.strictEqual(rows.length, 2, 'nothing is removed — the parcels are still open problems');
    assert.strictEqual(rows[0].classList.contains('ship-row-new'), false);
    assert.strictEqual(rows[0].querySelector('.ship-chip.ship-new'), null);
    assert.strictEqual(rows[1].classList.contains('ship-row-new'), true, 'the other row is untouched');
  });

  check('marking everything reviewed clears every mark', () => {
    window.renderShipRows([parcel(), parcel({ receipt_id: 7002 })], true, 10);
    window._clearShipRowNewMarkers();
    assert.strictEqual(doc.querySelectorAll('#shipRows tr.ship-row-new').length, 0);
  });

  check('the empty state explains itself when the new-only filter is what emptied it', () => {
    window.__newOnly = true;
    window.renderShipRows([], true, 10);
    assert.match(doc.querySelector('#shipRows').textContent, /Nothing new/);
    window.__newOnly = false;
    window.renderShipRows([], true, 10);
    assert.match(doc.querySelector('#shipRows').textContent, /No parcels match this filter/);
  });

  check('hostile carrier and buyer text cannot escape the row markup', () => {
    window.renderShipRows([parcel({
      buyer_name: '"><script>alert(1)</script>',
      shop_name: '<img src=x onerror=alert(2)>',
      tracking_last_event: '</td><script>alert(3)</script>',
      tracking_health_reason: '"><img src=x onerror=alert(4)>',
    })], true, 10);
    assert.strictEqual(doc.querySelectorAll('#shipRows script, #shipRows img').length, 0);
    assert.ok(doc.querySelector('#shipRows').textContent.includes('<img src=x onerror=alert(2)>'), 'the hostile value survives as text');
  });

  dom.window.close();
}

console.log('Dashboard wiring');
{
  const html = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8');

  check('tracking numbers in the banner are data, never generated inline JavaScript', () => {
    assert.ok(/class="ship-alert-track" data-tracking="\$\{safeTracking\}"/.test(html));
    assert.ok(!/open4pxTrackModal\('\$\{(?:a\.tracking_no|no)\}'\)/.test(html));
    assert.ok(html.includes('.ship-alert-track[data-tracking]'), 'banner links reuse the delegated tracking handler');
  });

  check('the banner and tab badge are hidden until something is actually new', () => {
    assert.ok(html.includes('id="shipAlertBanner"') && html.includes('hidden'), 'banner starts hidden');
    assert.ok(html.includes("banner.hidden = true"), 'banner hides when nothing is new');
    assert.ok(html.includes("badge.classList.toggle('is-visible', n > 0)"), 'badge hides at zero');
  });

  check('the review inbox is loaded on tab entry and refreshed by carrier sync events', () => {
    assert.ok(html.includes('loadShippingAlerts({ announce: true })'), 'tab entry announces new parcels');
    assert.ok(html.includes("ROLE.can('shipping:admin')"), 'badge polling is capability gated');
    assert.ok(/tracking_parcel_updated'\)\s*\{\s*\n\s*loadShippingAlerts\(\)/.test(html) || html.includes('loadShippingAlerts()'), 'sync events refresh the inbox');
  });

  check('review actions post to the acknowledge endpoint', () => {
    assert.ok(html.includes("/api/4px/shipping-alerts/review"));
    assert.ok(html.includes('data-alert-receipt='), 'per-row acknowledge uses a data attribute');
  });

  check('the parcel board is a first-class morning-review surface, not a second copy of the banner', () => {
    assert.ok(html.includes('id="shipNewOnly"'), 'a New-only control isolates untriaged rows');
    assert.ok(html.includes("p.set('alert_state', 'new')"), 'the control is a real server filter, not a client hide');
    assert.ok(html.includes('ship-row-new'), 'untriaged rows are highlighted in the table');
    assert.ok(html.includes('class="ship-chip ship-new"'), 'and carry a NEW badge');
    assert.ok(html.includes('.ship-alert-done[data-alert-receipt]'), 'banner parcels still acknowledge through the delegated handler');
    assert.ok(!html.includes('ship-row-ack'), 'the board no longer duplicates Reviewed on every row');
    assert.ok(html.includes('_clearShipRowNewMarkers'), 'acknowledging a row does not reload the whole table');
    assert.ok(html.includes('Flagged ${_relTime(flaggedAt)}'), 'rows state when WE flagged them, next to the carrier event age');
    assert.ok(html.includes('data-label="Actions"') && html.includes('ship-row-actions'), 'Message buyer sits in a trailing Actions column, not stacked into Status');
    assert.ok(html.includes('ship-status-stack'), 'Status chips share one horizontal stack');
    assert.ok(html.includes('_toggleShipBuyerNotice'), 'Message buyer is a one-click attestation');
    assert.ok(!html.includes('id="shipBuyerNoticeModal"'), 'the draft modal is gone');
    assert.ok(html.includes('id="shipAlertToggleList"') && html.includes('id="shipAlertDetails"'), 'the morning-review list is expandable rather than always tall');
  });
}

db.close();
try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch {}

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nPASS — shipping alert review inbox');
