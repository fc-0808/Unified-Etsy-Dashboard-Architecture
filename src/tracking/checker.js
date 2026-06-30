'use strict';

/**
 * Carrier tracking status checker.
 *
 * Uses the 4PX Open Platform API (https://open.4px.com) to determine whether
 * a shipment is "Pre-transit" (label created, carrier has not physically picked
 * up the package) or "In-transit" (carrier scanned / picked up the package).
 *
 * WHY WE NEED THIS
 * ─────────────────
 * The Etsy v3 API (ShopReceipt / ShopReceiptShipment) exposes only:
 *   - tracking_code  — the tracking number
 *   - carrier_name   — carrier display name
 *   - shipment_notification_timestamp — when Etsy sent the buyer the email
 *     (= label creation time, NOT carrier-scan time)
 *
 * Etsy does not expose carrier scan status in its API. The only way to
 * distinguish "label printed" from "carrier picked up" is to query the carrier
 * directly. We use 4PX's official Open Platform API for this purpose.
 *
 * API INTEGRATION
 * ────────────────
 * Endpoint : POST https://open.4px.com/router/api/service
 * Method   : tr.order.tracking.get
 * Auth     : MD5 signature (see computeSign() below)
 * Docs     : https://open.4px.com/v2/doc
 *
 * PRE-TRANSIT SIGNAL
 * ──────────────────
 * A shipment is Pre-transit when trackingList has exactly ONE event and that
 * event's businessLinkCode === 'FPX_L_RPIF' ("Parcel information received").
 * This is the "label created" event — the carrier has the manifest but has
 * NOT physically received the parcel.
 *
 * Once the parcel is physically picked up, 4PX adds more events (e.g.
 * FPX_C_SPLS = "Shipment picked up") → In-transit.
 *
 * FALLBACK
 * ─────────
 * If no API credentials are configured (fourpx_app_key / fourpx_app_secret
 * absent from config.json), the module falls back to 4PX's public tracking
 * endpoint (the same one that powers track.4px.com). The fallback requires no
 * authentication but is less suitable for production (unofficial, subject to
 * undocumented rate limits).
 *
 * @module src/tracking/checker
 */

const https  = require('https');
const crypto = require('crypto');

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} TrackingResult
 * @property {'pre_transit'|'in_transit'|'delivered'|'exception'|'unknown'} status
 * @property {number|null} firstScanAt     Unix epoch of the FIRST physical carrier scan.
 *                                         Null for pre_transit / unknown.
 * @property {number}      eventCount      Total tracking events from 4PX.
 * @property {string|null} lastEventCode   4PX businessLinkCode of the most recent event.
 * @property {string|null} lastEventDesc   Human-readable description of the most recent event.
 */

// ── 4PX Official API — authentication ────────────────────────────────────────

/**
 * Compute the 4PX Open Platform request signature.
 *
 * Algorithm (from official 4PX SDK source):
 *   str  = "app_key" + appKey + "formatjson" + "method" + method
 *          + "timestamp" + timestamp + "v" + version
 *          + paramJson + appSecret
 *   sign = MD5(str).toLowerCase()
 *
 * Reference: https://github.com/zengweigg/fourpx-express/blob/main/service.go
 *
 * @param {string} appKey
 * @param {string} appSecret
 * @param {string} method       - API method name, e.g. "tr.order.tracking.get"
 * @param {string} timestamp    - Millisecond epoch as string
 * @param {string} version      - API version, e.g. "2.0.0"
 * @param {string} paramJson    - JSON-stringified request body
 * @returns {string}            - 32-char lowercase MD5 hex digest
 */
function computeSign(appKey, appSecret, method, timestamp, version, paramJson) {
  const raw = `app_key${appKey}formatjsonmethod${method}timestamp${timestamp}v${version}${paramJson}${appSecret}`;
  return crypto.createHash('md5').update(raw, 'utf8').digest('hex');
}

// ── 4PX Official API — tracking request ──────────────────────────────────────

const OFFICIAL_API_HOST    = 'open.4px.com';
const OFFICIAL_API_PATH    = '/router/api/service';
const OFFICIAL_API_METHOD  = 'tr.order.tracking.get';
const OFFICIAL_API_VERSION = '2.0.0';

/**
 * Query the 4PX Open Platform tracking API (official, authenticated).
 *
 * @param {string} appKey
 * @param {string} appSecret
 * @param {string} trackingCode
 * @param {object} [options]
 * @param {number} [options.timeoutMs=10000]
 * @returns {Promise<TrackingResult>}
 */
function queryOfficialApi(appKey, appSecret, trackingCode, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10000;

  return new Promise((resolve) => {
    const body = JSON.stringify({ deliveryOrderNo: trackingCode });
    const timestamp = Date.now().toString();
    const sign = computeSign(appKey, appSecret, OFFICIAL_API_METHOD, timestamp, OFFICIAL_API_VERSION, body);

    const qs = [
      `app_key=${encodeURIComponent(appKey)}`,
      `format=json`,
      `language=en`,
      `method=${OFFICIAL_API_METHOD}`,
      `sign=${sign}`,
      `timestamp=${timestamp}`,
      `v=${OFFICIAL_API_VERSION}`,
    ].join('&');

    const timer = setTimeout(() => {
      req.destroy();
      resolve({ status: 'unknown', firstScanAt: null, eventCount: 0, lastEventCode: null, lastEventDesc: 'timeout' });
    }, timeoutMs);

    const req = https.request({
      hostname: OFFICIAL_API_HOST,
      port: 443,
      path: `${OFFICIAL_API_PATH}?${qs}`,
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent':    'EtsyDashboard/1.0 (4PX TrackingIntegration)',
        'Accept':        'application/json',
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const json = JSON.parse(raw);
          if (json.result !== '1' || !json.data) {
            resolve({ status: 'unknown', firstScanAt: null, eventCount: 0, lastEventCode: null, lastEventDesc: json.msg ?? json.errors?.[0]?.error_msg ?? 'api_error' });
            return;
          }
          resolve(classifyTrackingList(json.data.trackingList ?? []));
        } catch {
          resolve({ status: 'unknown', firstScanAt: null, eventCount: 0, lastEventCode: null, lastEventDesc: 'parse_error' });
        }
      });
    });

    req.on('error', () => {
      clearTimeout(timer);
      resolve({ status: 'unknown', firstScanAt: null, eventCount: 0, lastEventCode: null, lastEventDesc: 'network_error' });
    });

    req.write(body);
    req.end();
  });
}

// ── 4PX Public API — fallback (no auth required) ─────────────────────────────

/**
 * Query 4PX's public tracking endpoint (the backend powering track.4px.com).
 * Used as a fallback when no official API credentials are configured.
 *
 * @param {string} trackingCode
 * @param {object} [options]
 * @param {number} [options.timeoutMs=8000]
 * @returns {Promise<TrackingResult>}
 */
function queryPublicApi(trackingCode, options = {}) {
  const timeoutMs = options.timeoutMs ?? 8000;

  return new Promise((resolve) => {
    const body = JSON.stringify({ queryCodes: [trackingCode], language: 'en', translateLanguage: '' });

    const timer = setTimeout(() => {
      req.destroy();
      resolve({ status: 'unknown', firstScanAt: null, eventCount: 0, lastEventCode: null, lastEventDesc: 'timeout' });
    }, timeoutMs);

    const req = https.request({
      hostname: 'track.4px.com',
      port: 443,
      path: '/track/v2/front/listTrackV3',
      method: 'POST',
      headers: {
        'Content-Type':  'application/json;charset=UTF-8',
        'Content-Length': Buffer.byteLength(body),
        'Accept':        'application/json',
        'Origin':        'https://track.4px.com',
        'Referer':       'https://track.4px.com/',
        'User-Agent':    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const json = JSON.parse(raw);
          if (json.result !== 1 || !Array.isArray(json.data) || !json.data.length) {
            resolve({ status: 'unknown', firstScanAt: null, eventCount: 0, lastEventCode: null, lastEventDesc: 'not_found' });
            return;
          }
          const item = json.data[0];
          // Public API uses different status integers: 3=pre-transit, 1=in-transit, 2=delivered, 4=exception
          // Map the public-API track list to our canonical format via the shared classifier.
          const mapped = (item.tracks ?? []).map((t) => ({
            businessLinkCode: t.tkCode,
            occurDatetime:    t.tkDateStr,
            trackingContent:  t.tkTranslatedDesc ?? t.tkDesc,
          }));
          // Override: if public API says status=3 AND only 1 event, force pre_transit
          if (item.status === 3 && mapped.length <= 1) {
            resolve({ status: 'pre_transit', firstScanAt: null, eventCount: mapped.length, lastEventCode: mapped[0]?.businessLinkCode ?? null, lastEventDesc: mapped[0]?.trackingContent ?? null });
          } else if (item.status === 2) {
            const r = classifyTrackingList(mapped);
            resolve({ ...r, status: 'delivered' });
          } else {
            resolve(classifyTrackingList(mapped));
          }
        } catch {
          resolve({ status: 'unknown', firstScanAt: null, eventCount: 0, lastEventCode: null, lastEventDesc: 'parse_error' });
        }
      });
    });

    req.on('error', () => {
      clearTimeout(timer);
      resolve({ status: 'unknown', firstScanAt: null, eventCount: 0, lastEventCode: null, lastEventDesc: 'network_error' });
    });

    req.write(body);
    req.end();
  });
}

// ── Shared tracking list classifier ──────────────────────────────────────────

/**
 * Classify a 4PX tracking event list into our canonical TrackingResult.
 *
 * Pre-transit signal:
 *   - Only one event AND that event has businessLinkCode 'FPX_L_RPIF'
 *     ("Parcel information received" — label created, carrier not yet in possession).
 *
 * In-transit signal:
 *   - More than one event (carrier has performed at least one physical scan).
 *
 * The first physical scan event (first non-label event, oldest in time) is used
 * as `firstScanAt`. Events from the official API are returned newest-first.
 *
 * @param {Array<{businessLinkCode?:string, occurDatetime?:string, trackingContent?:string}>} trackingList
 * @returns {TrackingResult}
 */
function classifyTrackingList(trackingList) {
  const events = Array.isArray(trackingList) ? trackingList : [];
  const count  = events.length;

  if (count === 0) {
    return { status: 'unknown', firstScanAt: null, eventCount: 0, lastEventCode: null, lastEventDesc: null };
  }

  const latestEvent = events[0];
  const lastEventCode = latestEvent?.businessLinkCode ?? null;
  const lastEventDesc = latestEvent?.trackingContent  ?? null;

  // Pre-transit: ONLY "Parcel information received" (label-only event).
  // FPX_L_RPIF is the 4PX code for this state — exactly what Etsy calls "Pre-transit".
  const PRE_TRANSIT_CODES = new Set(['FPX_L_RPIF']);
  const isOnlyLabelEvent  = count === 1 && PRE_TRANSIT_CODES.has(lastEventCode);
  const allLabelEvents    = events.every((e) => PRE_TRANSIT_CODES.has(e.businessLinkCode) || !e.businessLinkCode);

  if (isOnlyLabelEvent || allLabelEvents) {
    return { status: 'pre_transit', firstScanAt: null, eventCount: count, lastEventCode, lastEventDesc };
  }

  // Determine final status from the most recent event code prefix:
  //   FPX_D_* = delivered, FPX_F_* = failed delivery
  const isDelivered = lastEventCode?.startsWith('FPX_D_');
  const isException = lastEventCode?.startsWith('FPX_F_') || lastEventCode?.startsWith('FPX_E_');
  const status      = isDelivered ? 'delivered' : isException ? 'exception' : 'in_transit';

  // firstScanAt = oldest non-label event (events are newest-first, so the last entry
  // that is NOT a label event is the earliest physical scan).
  const firstScanEvent = [...events].reverse().find(
    (e) => e.businessLinkCode && !PRE_TRANSIT_CODES.has(e.businessLinkCode)
  );

  let firstScanAt = null;
  if (firstScanEvent?.occurDatetime) {
    // Official API returns "YYYY-MM-DD HH:mm:ss" in UTC+08:00 — parse as-is (close enough)
    const d = new Date(firstScanEvent.occurDatetime.replace(' ', 'T') + '+08:00');
    if (!isNaN(d.getTime())) firstScanAt = Math.floor(d.getTime() / 1000);
  }

  return { status, firstScanAt, eventCount: count, lastEventCode, lastEventDesc };
}

// ── Public interface ──────────────────────────────────────────────────────────

/**
 * Check the carrier tracking status for a 4PX tracking number.
 *
 * Routing:
 *   1. If fourpx_app_key and fourpx_app_secret are provided in config → official API
 *   2. Otherwise                                                        → public fallback
 *
 * For unsupported carriers (non-4PX tracking codes), returns 'unknown' immediately
 * without making any network request — the caller should treat 'unknown' as pre-transit
 * (fail-open: show too many rather than miss genuine pre-transit orders).
 *
 * @param {string}      trackingCode
 * @param {string}      [carrierName]  - e.g. "4PX Worldwide Express"
 * @param {object}      [apiCredentials]
 * @param {string|null} [apiCredentials.appKey]    - fourpx_app_key from config
 * @param {string|null} [apiCredentials.appSecret] - fourpx_app_secret from config
 * @returns {Promise<TrackingResult>}
 */
async function checkTrackingStatus(trackingCode, carrierName, apiCredentials = {}) {
  if (!trackingCode) {
    return { status: 'unknown', firstScanAt: null, eventCount: 0, lastEventCode: null, lastEventDesc: 'no_tracking_code' };
  }

  // Only 4PX tracking numbers are supported (starts with "4PX", case-insensitive).
  // Future: add other carriers here (USPS, UPS, etc.)
  if (!/^4PX/i.test(trackingCode)) {
    return { status: 'unknown', firstScanAt: null, eventCount: 0, lastEventCode: null, lastEventDesc: 'unsupported_carrier' };
  }

  const { appKey, appSecret } = apiCredentials;

  if (appKey && appSecret) {
    return queryOfficialApi(appKey, appSecret, trackingCode);
  }

  // Fallback: public API (no auth required)
  return queryPublicApi(trackingCode);
}

// ── Full tracking event retrieval (for UI parcel-route display) ───────────────

/**
 * @typedef {object} TrackingEvent
 * @property {string|null} time         - "YYYY-MM-DD HH:mm:ss" (UTC+8)
 * @property {string|null} description  - Human-readable event description
 * @property {string|null} code         - 4PX businessLinkCode, e.g. "FPX_C_SPLS"
 * @property {string|null} location     - Location string, e.g. "GUANGZHOU, CN"
 */

/**
 * @typedef {object} FullTrackingResult
 * @property {TrackingEvent[]} events   - Ordered newest-first
 * @property {string}          status   - Canonical status: pre_transit | in_transit | delivered | exception | unknown | error
 * @property {string}          [source] - 'official' | 'public' | 'none' | 'unsupported'
 */

/**
 * Fetch the full list of tracking events for display in the parcel-route modal.
 *
 * Routing:
 *   1. Official 4PX Open Platform API (tr.order.tracking.get) if credentials present.
 *   2. 4PX public tracking endpoint (track.4px.com) as a no-auth fallback.
 *      The public API returns richer location data (city + country).
 *
 * @param {string}      trackingCode
 * @param {object}      [apiCredentials]
 * @param {string|null} [apiCredentials.appKey]
 * @param {string|null} [apiCredentials.appSecret]
 * @returns {Promise<FullTrackingResult>}
 */
async function getFullTrackingEvents(trackingCode, apiCredentials = {}) {
  if (!trackingCode) return { events: [], status: 'unknown', source: 'none' };
  if (!/^4PX/i.test(trackingCode)) return { events: [], status: 'unsupported', source: 'none' };

  const { appKey, appSecret } = apiCredentials;

  if (appKey && appSecret) {
    const official = await _officialTrackFull(appKey, appSecret, trackingCode);
    // Fall back to the public API when the official API returns a hard failure.
    // "pre_transit", "in_transit", "delivered", "exception", "not_found" are
    // valid terminal statuses — only transient errors trigger the fallback.
    const FALLBACK_STATUSES = new Set(['error', 'network_error', 'timeout', 'parse_error']);
    if (!FALLBACK_STATUSES.has(official.status)) {
      return _withHealth(official);
    }
    // Official API failed — use public tracking endpoint which is more permissive
    // and returns richer location data even for pre-transit parcels.
    console.log(`[4px/track] Official API failed (${official.status}) for ${trackingCode}, falling back to public API`);
  }
  return _publicTrackFull(trackingCode).then(_withHealth);
}

/**
 * Fetch full tracking events via the 4PX Open Platform API (authenticated).
 * Returns normalized events + canonical status derived from classifyTrackingList.
 */
function _officialTrackFull(appKey, appSecret, trackingCode) {
  return new Promise((resolve) => {
    const body      = JSON.stringify({ deliveryOrderNo: trackingCode });
    const timestamp = Date.now().toString();
    const sign      = computeSign(appKey, appSecret, OFFICIAL_API_METHOD, timestamp, OFFICIAL_API_VERSION, body);

    const qs = [
      `app_key=${encodeURIComponent(appKey)}`,
      `format=json`,
      `language=en`,
      `method=${OFFICIAL_API_METHOD}`,
      `sign=${sign}`,
      `timestamp=${timestamp}`,
      `v=${OFFICIAL_API_VERSION}`,
    ].join('&');

    let req;
    const timer = setTimeout(() => {
      req?.destroy();
      resolve({ events: [], status: 'timeout', source: 'official' });
    }, 12_000);

    req = https.request(
      {
        hostname: OFFICIAL_API_HOST,
        port:     443,
        path:     `${OFFICIAL_API_PATH}?${qs}`,
        method:   'POST',
        headers:  {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent':     'EtsyDashboard/1.0 (4PX TrackingIntegration)',
          'Accept':         'application/json',
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          clearTimeout(timer);
          try {
            const json = JSON.parse(raw);
            if (json.result !== '1' || !json.data) {
              return resolve({ events: [], status: 'error', source: 'official', error: json.msg ?? json.errors?.[0]?.error_msg ?? 'api_error' });
            }
            const trackingList = json.data.trackingList ?? [];
            const events = trackingList.map((e) => ({
              time:        e.occurDatetime       ?? null,
              description: e.trackingContent     ?? null,
              code:        e.businessLinkCode     ?? null,
              location:    e.country ?? e.location ?? null,
            }));
            const classified = classifyTrackingList(trackingList);
            resolve({ events, status: classified.status, source: 'official' });
          } catch {
            resolve({ events: [], status: 'parse_error', source: 'official' });
          }
        });
      }
    );

    req.on('error', () => {
      clearTimeout(timer);
      resolve({ events: [], status: 'network_error', source: 'official' });
    });

    req.write(body);
    req.end();
  });
}

/**
 * Fetch full tracking events via the 4PX public tracking API (no auth required).
 * The public endpoint (track.4px.com) returns richer location + city data.
 */
function _publicTrackFull(trackingCode) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ queryCodes: [trackingCode], language: 'en', translateLanguage: '' });

    let req;
    const timer = setTimeout(() => {
      req?.destroy();
      resolve({ events: [], status: 'timeout', source: 'public' });
    }, 10_000);

    req = https.request(
      {
        hostname: 'track.4px.com',
        port:     443,
        path:     '/track/v2/front/listTrackV3',
        method:   'POST',
        headers:  {
          'Content-Type':   'application/json;charset=UTF-8',
          'Content-Length': Buffer.byteLength(body),
          'Accept':         'application/json',
          'Origin':         'https://track.4px.com',
          'Referer':        'https://track.4px.com/',
          'User-Agent':     'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          clearTimeout(timer);
          try {
            const json = JSON.parse(raw);
            if (json.result !== 1 || !Array.isArray(json.data) || !json.data.length) {
              return resolve({ events: [], status: 'not_found', source: 'public' });
            }
            const item   = json.data[0];
            const events = (item.tracks ?? []).map((t) => ({
              time:        t.tkDateStr                              ?? null,
              description: t.tkTranslatedDesc ?? t.tkDesc          ?? null,
              code:        t.tkCode                                 ?? null,
              location:    [t.location, t.country].filter(Boolean).join(', ') || null,
            }));
            const statusMap = { 1: 'in_transit', 2: 'delivered', 3: 'pre_transit', 4: 'exception' };
            const status    = statusMap[item.status] ?? 'unknown';
            resolve({ events, status, source: 'public' });
          } catch {
            resolve({ events: [], status: 'parse_error', source: 'public' });
          }
        });
      }
    );

    req.on('error', () => {
      clearTimeout(timer);
      resolve({ events: [], status: 'network_error', source: 'public' });
    });

    req.write(body);
    req.end();
  });
}

// ── Tracking health analysis (stuck / delayed parcel detection) ───────────────

/** Normalize event text for duplicate detection (lowercase, collapse whitespace). */
function _normEventText(s) {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Parse 4PX "YYYY-MM-DD HH:mm:ss" timestamps (UTC+8) to Unix seconds. */
function _parseTrackTime(timeStr) {
  if (!timeStr) return null;
  const d = new Date(String(timeStr).replace(' ', 'T') + '+08:00');
  return isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
}

const CUSTOMS_RE = /\bcustoms\b/i;
const RELEASED_CUSTOMS_RE = /released from customs|customs cleared/i;

/**
 * Analyze a tracking timeline for signs of a stuck or delayed parcel.
 *
 * Heuristics (tuned for 4PX cross-border lanes):
 *   - No scan update for N days while still in_transit
 *   - Same event description repeated 3+ times (e.g. "Customs check" at LAX)
 *   - Customs loop: multiple customs checks with no delivery progress
 *   - Long time in transit since first physical scan
 *
 * @param {TrackingEvent[]} events  Newest-first
 * @param {string}        status    Canonical status from classifyTrackingList
 * @returns {{
 *   isStuck: boolean,
 *   severity: 'ok'|'warning'|'critical',
 *   reasons: string[],
 *   daysSinceLastUpdate: number|null,
 *   daysInTransit: number|null,
 *   repeatedEvents: Array<{ description: string, count: number }>,
 * }}
 */
function analyzeTrackingHealth(events, status) {
  const list = Array.isArray(events) ? events : [];
  const reasons = [];
  let severity = 'ok';

  const bump = (level, msg) => {
    reasons.push(msg);
    if (level === 'critical') severity = 'critical';
    else if (level === 'warning' && severity !== 'critical') severity = 'warning';
  };

  if (status === 'delivered') {
    return { isStuck: false, severity: 'ok', reasons: [], daysSinceLastUpdate: null, daysInTransit: null, repeatedEvents: [] };
  }

  if (status === 'exception') {
    bump('critical', 'Carrier reported a delivery exception — contact 4PX.');
    return { isStuck: true, severity, reasons, daysSinceLastUpdate: null, daysInTransit: null, repeatedEvents: [] };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const latestTs = _parseTrackTime(list[0]?.time);
  const daysSinceLastUpdate = latestTs != null ? Math.floor((nowSec - latestTs) / 86400) : null;

  // Oldest event with a parseable time → approximate transit duration.
  let oldestTs = null;
  for (let i = list.length - 1; i >= 0; i--) {
    const ts = _parseTrackTime(list[i]?.time);
    if (ts != null) { oldestTs = ts; break; }
  }
  const daysInTransit = oldestTs != null ? Math.floor((nowSec - oldestTs) / 86400) : null;

  // Repeated identical descriptions (common customs-loop signal).
  const descCounts = new Map();
  for (const e of list) {
    const key = _normEventText(e.description);
    if (!key || key.length < 8) continue;
    descCounts.set(key, (descCounts.get(key) || 0) + 1);
  }
  const repeatedEvents = [...descCounts.entries()]
    .filter(([, n]) => n >= 3)
    .map(([description, count]) => ({ description, count }))
    .sort((a, b) => b.count - a.count);

  for (const { description, count } of repeatedEvents) {
    const short = description.length > 48 ? description.slice(0, 45) + '…' : description;
    bump('warning', `"${short}" repeated ${count}× — parcel may be stuck in a loop.`);
  }

  // Customs-specific: many customs scans without terminal delivery.
  const customsCount = list.filter((e) => CUSTOMS_RE.test(e.description || '')).length;
  const releasedCount = list.filter((e) => RELEASED_CUSTOMS_RE.test(e.description || '')).length;
  if (customsCount >= 3 && status === 'in_transit') {
    bump(customsCount >= 5 ? 'critical' : 'warning',
      `${customsCount} customs scan${customsCount === 1 ? '' : 's'} with no delivery — likely held at customs.`);
  }
  if (customsCount >= 2 && releasedCount >= 2 && status === 'in_transit') {
    bump('warning', 'Customs cleared multiple times but parcel still in transit — possible re-inspection.');
  }

  if (status === 'in_transit' && daysSinceLastUpdate != null) {
    if (daysSinceLastUpdate >= 10) bump('critical', `No carrier update for ${daysSinceLastUpdate} days.`);
    else if (daysSinceLastUpdate >= 5) bump('warning', `No carrier update for ${daysSinceLastUpdate} days.`);
  }

  if (status === 'in_transit' && daysInTransit != null && daysInTransit >= 21) {
    bump('critical', `In transit for ${daysInTransit} days — well past typical delivery window.`);
  } else if (status === 'in_transit' && daysInTransit != null && daysInTransit >= 14) {
    bump('warning', `In transit for ${daysInTransit} days.`);
  }

  const isStuck = severity !== 'ok';
  return { isStuck, severity, reasons, daysSinceLastUpdate, daysInTransit, repeatedEvents };
}

function _withHealth(result) {
  const health = analyzeTrackingHealth(result.events ?? [], result.status ?? 'unknown');
  return { ...result, health };
}

module.exports = { checkTrackingStatus, getFullTrackingEvents, analyzeTrackingHealth, _withHealth };
