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
 * Auth     : MD5 signature (shared client: src/fourpx/api.js)
 * Docs     : https://open.4px.com/v2/doc
 *
 * PRE-TRANSIT SIGNAL
 * ──────────────────
 * A shipment is Pre-transit while every event is forecast/label metadata
 * (FPX_L_RPIF, FPX_O_CRLB, FPX_O_SIS, and related official codes). The carrier
 * has the manifest but has NOT physically received the parcel.
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

const https = require('https');
const { callApi } = require('../fourpx/api');
const { normalizeFourpxLookupCode } = require('./validation');

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

// ── 4PX Official API — tracking request ──────────────────────────────────────

const OFFICIAL_API_METHOD  = 'tr.order.tracking.get';
// The current official endpoint contract exposes version 1.0.0:
// https://open.4px.com/apiInfo/detail?id=25
// The gateway also accepts 2.0.0 today, but pinning the documented version keeps
// this client inside the compatibility contract instead of relying on an alias.
const OFFICIAL_API_VERSION = '1.0.0';

/** Convert a shared-client error into the stable status vocabulary used here. */
function trackingFailureStatus(error) {
  const message = String(error?.message || error || 'api_error');
  if (/timed?\s*out|timeout/i.test(message)) return 'timeout';
  if (/non-json|parse/i.test(message)) return 'parse_error';
  if (/network|socket|econn|enotfound|eai_again|reset/i.test(message)) return 'network_error';
  if (String(error?.code || '') === '0' || /not\s+found|does not exist|不存在/i.test(message)) return 'not_found';
  return 'error';
}

function trackingLookupCode(value) {
  try {
    return normalizeFourpxLookupCode(String(value ?? ''));
  } catch {
    return null;
  }
}

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
async function queryOfficialApi(appKey, appSecret, trackingCode, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10000;
  try {
    const data = await callApi(
      appKey,
      appSecret,
      OFFICIAL_API_METHOD,
      { deliveryOrderNo: trackingCode },
      { version: OFFICIAL_API_VERSION, timeoutMs }
    );
    return normalizeOfficialTrackingData(data).classification;
  } catch (error) {
    const failure = trackingFailureStatus(error);
    return {
      status: 'unknown',
      firstScanAt: null,
      eventCount: 0,
      lastEventCode: null,
      lastEventDesc: failure,
    };
  }
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
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (json.result !== 1 || !Array.isArray(json.data) || !json.data.length) {
            resolve({ status: 'unknown', firstScanAt: null, eventCount: 0, lastEventCode: null, lastEventDesc: 'not_found' });
            return;
          }
          resolve(normalizePublicTrackingItem(json.data[0]).classification);
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

// ── Official event contract and canonical event access ───────────────────────
//
// Source of truth:
//   API schema   https://open.4px.com/apiInfo/detail?id=25
//   event codes  https://open.4px.com/v2/help/customdata?ids=help-data,21
//
// The official and public APIs use different property names. All classification
// goes through these accessors so location, event code and timestamp information
// cannot silently disappear at an adapter boundary again.

const PRE_TRANSIT_CODES = new Set([
  'FPX_L_RPIF', // Shipment information received.
  'FPX_L_ATP',  // Courier assigned; pickup has not happened.
  'FPX_O_CRLB', // Shipping label created.
  'FPX_O_IR',   // Service provider received electronic information.
  'FPX_O_SIS',  // Electronic information sent to service provider.
  'FPX_S_SFBR', // Booked.
]);

const DELIVERED_CODES = new Set([
  'FPX_S_OK',
  'FPX_S_OKCC',
  'FPX_S_OKGP',
  'FPX_S_OKIDC',
  'FPX_S_OKPO',
  'FPX_S_OKSC',
  'FPX_S_OKVP',
]);

const DISPOSAL_CODES = new Set([
  'FPX_C_DT',
  'FPX_C_DTCQ',
  'FPX_C_DTTM',
  'FPX_Y_ADPR',
  'FPX_Y_DS',
]);

const EXCEPTION_CODES = new Set([
  'FPX_C_BTC',
  'FPX_D_DFCR',
  'FPX_D_PD',
  'FPX_D_POD',
  'FPX_D_RA',
  'FPX_D_RR',
  'FPX_D_SPRA',
  'FPX_D_SR',
  'FPX_D_VN',
  'FPX_I_CR',
  'FPX_I_DG',
  'FPX_M_PRTS',
  'FPX_M_SE',
  'FPX_O_PRIA',
  'FPX_O_PRRF',
  'FPX_O_PRRR',
  'FPX_O_PRUC',
  'FPX_O_RFLM',
  'FPX_O_RTHM',
  'FPX_O_RTOC',
  'FPX_O_RTR',
  'FPX_O_SCB',
  'FPX_O_SD',
  'FPX_S_CC',
  'FPX_Y_CCMC',
  'FPX_Y_CCSC',
  'FPX_Y_COBH',
]);

const EXCEPTION_CODE_PREFIXES = [
  'FPX_C_HF',  // Held in 4PX facility.
  'FPX_D_FD',  // Delivery failed (all documented reason variants).
  'FPX_D_SH',  // Shipment on hold.
  'FPX_I_HC',  // Held in customs.
  'FPX_O_SPH', // Service provider hold.
];

const DELAY_CODE_PREFIXES = [
  'FPX_D_DD',  // Delivery delay.
  'FPX_M_TD',  // Transport delay.
];

const AWAITING_PICKUP_CODES = new Set([
  'FPX_D_ADWP', // Awaiting collection at local post office.
  'FPX_D_AP',   // Awaiting pickup by recipient.
  'FPX_D_SASPS', // Arrived at self-pickup site.
]);

function eventCode(event) {
  const value = event?.businessLinkCode ?? event?.code ?? event?.tkCode;
  return value == null ? '' : String(value).trim().toUpperCase();
}

function eventDescription(event) {
  const value = event?.trackingContent
    ?? event?.description
    ?? event?.tkTranslatedDesc
    ?? event?.tkDesc;
  return value == null ? '' : String(value).trim();
}

function eventTimeZone(event) {
  const value = event?.timeZone ?? event?.timezone ?? event?.tkTimezone;
  return value == null ? null : String(value).trim() || null;
}

/**
 * Join every location field defined by either API, without duplicating identical
 * values. `occurLocation`/`tkLocation` are the official names; `location` is our
 * normalized name. Carrier status text can legitimately appear in this field.
 */
function eventLocation(event) {
  const values = [
    event?.occurLocation,
    event?.tkLocation,
    event?.location,
    event?.city,
    event?.country,
  ];
  const comparableParts = [];
  const parts = [];
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const key = text.toLocaleLowerCase('en-US').replace(/[\s,]+/g, ' ').trim();
    const alreadyIncluded = comparableParts.some((existing) => (
      existing === key
      || existing.startsWith(`${key} `)
      || existing.endsWith(` ${key}`)
      || existing.includes(` ${key} `)
    ));
    if (alreadyIncluded) continue;
    comparableParts.push(key);
    parts.push(text);
  }
  return parts.join(', ');
}

/** Absolute event epoch when available, else 4PX's UTC+8 display timestamp. */
function eventEpoch(event) {
  const explicit = Number(event?.timestamp);
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit > 1e12 ? Math.floor(explicit / 1000) : Math.floor(explicit);
  }
  if (event?.tkDate) {
    const parsed = Date.parse(String(event.tkDate));
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return _parseTrackTime(event?.time ?? event?.occurDatetime ?? event?.tkDateStr);
}

/** Defensive ordering: 4PX examples are newest-first, but the schema does not promise it. */
function sortTrackingEventsNewestFirst(events) {
  return (Array.isArray(events) ? events : [])
    .map((event, index) => ({ event, index, epoch: eventEpoch(event) }))
    .sort((a, b) => {
      if (a.epoch != null && b.epoch != null && a.epoch !== b.epoch) return b.epoch - a.epoch;
      if (a.epoch != null && b.epoch == null) return -1;
      if (a.epoch == null && b.epoch != null) return 1;
      return a.index - b.index;
    })
    .map(({ event }) => event);
}

function codeHasPrefix(code, prefixes) {
  return !!code && prefixes.some((prefix) => code.startsWith(prefix));
}

function eventLooksPreTransit(event) {
  const code = eventCode(event);
  if (PRE_TRANSIT_CODES.has(code)) return true;
  if (code) return false;
  return /\b(?:parcel|shipment)\s+information\s+(?:received|sent)\b|\bshipping\s+label\s+created\b|\bcourier\s+assigned\b/i.test(eventDescription(event));
}

function eventCodeIsDelivered(event) {
  return DELIVERED_CODES.has(eventCode(event));
}

function eventCodeIsDisposed(event) {
  return DISPOSAL_CODES.has(eventCode(event));
}

function eventCodeIsException(event) {
  const code = eventCode(event);
  return EXCEPTION_CODES.has(code)
    || DISPOSAL_CODES.has(code)
    || codeHasPrefix(code, EXCEPTION_CODE_PREFIXES);
}

function eventCodeIsDelay(event) {
  const code = eventCode(event);
  return code === 'FPX_I_DELAY' || codeHasPrefix(code, DELAY_CODE_PREFIXES);
}

function eventIsAwaitingPickup(event) {
  return AWAITING_PICKUP_CODES.has(eventCode(event))
    || /\bawaiting\s+(?:collection|pick[- ]?up)\s+(?:at|by)\b|\barrived\s+at\s+(?:the\s+)?self[- ]?pickup\s+site\b/i.test(eventDescription(event));
}

// ── Disposal / destruction terminal events ───────────────────────────────────

/** Matches 4PX / last-mile parcel-disposal terminal wording (EN + common CN). */
const DISPOSAL_RE = new RegExp([
  '\\bparcel\\s+dispos(?:al|ed)\\b',
  '\\bdispos(?:al|ed)\\s+authorized\\b',
  '\\bdisposal\\s+authorized\\b',
  '\\b(?:parcel|package|shipment)\\s+(?:has\\s+been\\s+|was\\s+)?destroyed\\b',
  '\\boverseas\\s+service\\s+provider\\s+destroyed\\s+(?:the\\s+)?shipment\\b',
  '\\babandon(?:ed)?\\s+due\\s+to\\s+prohibited\\s+or\\s+restricted\\s+items\\b',
  '销毁', '弃件', '报废',
].join('|'), 'i');

function isDisposalText(...parts) {
  return DISPOSAL_RE.test(parts.filter(Boolean).join(' '));
}

/** True when a raw API event OR a normalized TrackingEvent is a disposal. */
function eventLooksDisposed(event) {
  if (!event) return false;
  return eventCodeIsDisposed(event)
    || isDisposalText(eventDescription(event), eventLocation(event));
}

function timelineHasDisposal(events) {
  return Array.isArray(events) && events.some(eventLooksDisposed);
}

function latestHardTerminal(events) {
  return sortTrackingEventsNewestFirst(events)
    .find((event) => eventLooksDelivered(event) || eventLooksDisposed(event))
    ?? null;
}

// ── Delivery / exception terminals ───────────────────────────────────────────

const NOT_DELIVERED_RE = new RegExp([
  '\\b(?:not|non|nicht|niet|no|nao|n[ãa]o)\\s+(?:delivered|livr|zugestellt|bezorgd|entregad|entregue|consegnat)',
  '\\bun(?:delivered|deliverable)\\b',
  '\\bnon[- ]delivery\\b',
  '\\bpartial(?:ly)?\\s+delivered\\b',
  '\\b(?:delivery|deliver)\\s+(?:failed|failure|unsuccessful|attempt|attempted|exception|refused)\\b',
  '\\b(?:failed|unsuccessful|attempted)\\s+deliver',
  '\\b(?:awaiting|pending|scheduled\\s+for|out\\s+for)\\s+deliver',
  '\\b(?:ready|available)\\s+for\\s+(?:collection|pickup|pick[- ]up)\\b',
  '\\bawaiting\\s+collection\\b',
].join('|'), 'i');

const DELIVERED_RE = new RegExp([
  '\\bdelivered\\b',
  '\\bdeliver(?:y|ies)\\s+(?:completed?|successful|success|made|done)\\b',
  '\\bsuccessful(?:ly)?\\s+deliver(?:y|ed)\\b',
  '\\bproof\\s+of\\s+delivery\\b',
  '\\bsigned\\s+for\\b',
  '\\bsecure\\s+deliver(?:y|ed)\\b',
  '\\bsafe\\s+place\\b',
  '\\bleft\\s+(?:in|with|at)\\s+(?:a\\s+|the\\s+)?(?:safe|secure|porch|neighbou?r|reception|concierge|mailbox|letterbox|garage|shed|door)',
  '\\bdeliver(?:y|ed)\\s+to\\s+(?:a\\s+|the\\s+)?(?:safe|secure|neighbou?r|reception|concierge|mailbox|letterbox)',
  '\\b(?:recipient|customer|consignee|addressee)\\b[^.]{0,40}\\bpicked\\s+up\\b',
  '\\bpicked\\s+up\\s+by\\s+(?:the\\s+)?(?:recipient|customer|consignee|addressee)\\b',
  '\\bcollected\\s+by\\s+(?:the\\s+)?(?:recipient|customer|consignee|addressee)\\b',
  '\\breceived\\s+by\\s+(?:the\\s+)?(?:recipient|customer|consignee|addressee|agent)\\b',
  '\\bhanded\\s+(?:over\\s+)?to\\s+(?:the\\s+)?(?:recipient|customer|consignee|addressee|resident)\\b',
  'entregad[oa]',
  'entregue',
  'entrega\\s+(?:realizada|efectuada|concluída|concluida)',
  'livr[ée]{1,2}(?![a-z])',
  'livraison\\s+effectu',
  // La Poste terminal, including rows cached before the UTF-8 header fix where
  // accented characters were replaced with U+FFFD.
  '(?:envoi|colis).{0,40}distribu.{0,40}bo.te.{0,12}lettres',
  'zugestellt',
  'an\\s+empf[äa]nger\\s+[üu]bergeben',
  'consegnat[oa]',
  'consegna\\s+effettuata',
  'bezorgd',
  'afgeleverd',
  'dostarczon',
  'levererad',
  'levererat(?:s)?',
  'paketet.{0,30}upph.mtat.{0,30}ombud',
  'leveret',
  'utlevert',
  'doru[čc]en',
  '投妥', '妥投', '签收', '已送达', '已投递', '已妥投',
].join('|'), 'i');

const EXCEPTION_RE = new RegExp([
  '\\bdelivery\\s+(?:failed|failure|exception)\\b',
  '\\bfailed\\s+(?:delivery|attempt)\\b',
  '\\bunsuccessful\\b',
  '\\bundeliver(?:able|ed)\\b',
  '\\bcannot\\s+be\\s+delivered\\b',
  '\\b(?:shipment|parcel|package)\\s+(?:is\\s+)?(?:being\\s+)?returned\\b',
  '\\breturn(?:ed|ing)?\\s+(?:item\\s+)?to\\s+(?:sender|shipper|mailee|origin)\\b',
  '\\brefused\\b', '\\brejected\\b',
  '\\bseized\\b', '\\bdetained\\b', '\\bconfiscated\\b',
  '\\b(?:shipment|parcel|package)\\s+(?:is\\s+|was\\s+|has\\s+been\\s+)?(?:lost|missing|damaged|destroyed)\\b',
  '\\babnormal\\b', '\\bexception\\b',
  '\\bheld\\s+(?:in|at|by)\\b', '\\bshipment\\s+on\\s+hold\\b',
  '\\bcustoms\\s+hold\\b',
].join('|'), 'i');

function isDeliveredText(...parts) {
  const text = parts.filter(Boolean).join(' ');
  if (!text || NOT_DELIVERED_RE.test(text)) return false;
  return DELIVERED_RE.test(text);
}

function isExceptionText(...parts) {
  const text = parts.filter(Boolean).join(' ');
  if (!text || isDeliveredText(text)) return false;
  return EXCEPTION_RE.test(text) || DISPOSAL_RE.test(text);
}

function eventLooksDelivered(event) {
  if (!event || eventLooksDisposed(event)) return false;
  return eventCodeIsDelivered(event)
    || isDeliveredText(eventDescription(event), eventLocation(event));
}

function eventLooksException(event) {
  if (!event || eventLooksDelivered(event)) return false;
  return eventCodeIsException(event)
    || isExceptionText(eventDescription(event), eventLocation(event));
}

// ── Shared tracking list classifier ──────────────────────────────────────────

/**
 * Classify official or normalized events. Codes are authoritative when 4PX
 * publishes one; multilingual text and location remain defensive fallbacks for
 * last-mile events. Input order is not trusted.
 */
function classifyTrackingList(trackingList) {
  const events = sortTrackingEventsNewestFirst(trackingList);
  const count = events.length;
  if (!count) {
    return { status: 'unknown', firstScanAt: null, eventCount: 0, lastEventCode: null, lastEventDesc: null };
  }

  const latestEvent = events[0];
  const lastEventCode = eventCode(latestEvent) || null;
  const lastEventDesc = eventDescription(latestEvent) || null;

  if (events.every(eventLooksPreTransit)) {
    return { status: 'pre_transit', firstScanAt: null, eventCount: count, lastEventCode, lastEventDesc };
  }

  // A newest explicit delivery terminal wins over historical problems. A newest
  // disposal wins over delivery-shaped words in its location/status line.
  let status;
  if (eventLooksDelivered(latestEvent)) status = 'delivered';
  else if (eventLooksDisposed(latestEvent) || eventLooksException(latestEvent)) status = 'exception';
  else {
    // Some partners append an informational/SMS row after final delivery or
    // disposal. Keep the newest hard terminal in force, but allow a genuinely
    // newer exception above to override it.
    const hardTerminal = latestHardTerminal(events);
    status = hardTerminal
      ? (eventLooksDelivered(hardTerminal) ? 'delivered' : 'exception')
      : 'in_transit';
  }

  const firstScanEvent = [...events].reverse().find((event) => !eventLooksPreTransit(event));
  const firstScanAt = firstScanEvent ? eventEpoch(firstScanEvent) : null;
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

  const lookupCode = trackingLookupCode(trackingCode);
  if (!lookupCode) {
    return { status: 'unknown', firstScanAt: null, eventCount: 0, lastEventCode: null, lastEventDesc: 'unsupported_carrier' };
  }

  const { appKey, appSecret } = apiCredentials;

  if (appKey && appSecret) {
    const official = await queryOfficialApi(appKey, appSecret, lookupCode);
    if (official.status !== 'unknown') return official;
    return queryPublicApi(lookupCode);
  }

  // Fallback: public API (no auth required)
  return queryPublicApi(lookupCode);
}

// ── Full tracking event retrieval (for UI parcel-route display) ───────────────

/**
 * @typedef {object} TrackingEvent
 * @property {string|null} time         - 4PX display time ("YYYY-MM-DD HH:mm:ss").
 * @property {number|null} timestamp    - Absolute Unix epoch when available.
 * @property {string|null} timeZone     - Event-location timezone metadata.
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
 *
 * @param {string}      trackingCode
 * @param {object}      [apiCredentials]
 * @param {string|null} [apiCredentials.appKey]
 * @param {string|null} [apiCredentials.appSecret]
 * @returns {Promise<FullTrackingResult>}
 */
async function getFullTrackingEvents(trackingCode, apiCredentials = {}) {
  if (!trackingCode) return { events: [], status: 'unknown', source: 'none' };
  const lookupCode = trackingLookupCode(trackingCode);
  if (!lookupCode) return { events: [], status: 'unsupported', source: 'none' };

  const { appKey, appSecret } = apiCredentials;

  if (appKey && appSecret) {
    const official = await _officialTrackFull(appKey, appSecret, lookupCode);
    // A successful official response with no events is not useful evidence. The
    // public endpoint sometimes sees a newly handed-off parcel first, so use it
    // for empty/not-found responses as well as transport failures.
    const FALLBACK_STATUSES = new Set(['unknown', 'not_found', 'error', 'network_error', 'timeout', 'parse_error']);
    if (!FALLBACK_STATUSES.has(official.status)) {
      return _withHealth(official);
    }
    console.log(`[4px/track] Official API returned ${official.status}; falling back to the public tracking feed`);
  }
  return _publicTrackFull(lookupCode).then(_withHealth);
}

/**
 * Normalize the documented official response without losing `occurLocation`,
 * `timeZone`, `country`, or `city`.
 *
 * @param {object} data 4PX response data object.
 * @returns {FullTrackingResult & {classification: TrackingResult}}
 */
function normalizeOfficialTrackingData(data = {}) {
  const rawEvents = sortTrackingEventsNewestFirst(data.trackingList);
  const classification = classifyTrackingList(rawEvents);
  const events = rawEvents.map((event) => ({
    time: event.occurDatetime ?? null,
    timestamp: eventEpoch(event),
    timeZone: eventTimeZone(event),
    description: eventDescription(event) || null,
    code: eventCode(event) || null,
    location: eventLocation(event) || null,
  }));
  return {
    events,
    status: classification.status,
    source: 'official',
    classification,
  };
}

/**
 * Normalize one item from track.4px.com's public response. `tkDate` is an
 * absolute ISO instant; prefer it over the UTC+8 display string for age math.
 *
 * @param {object} item Public API parcel object.
 * @returns {FullTrackingResult & {classification: TrackingResult}}
 */
function normalizePublicTrackingItem(item = {}) {
  const events = sortTrackingEventsNewestFirst((item.tracks ?? []).map((event) => ({
    time: event.tkDateStr ?? null,
    timestamp: eventEpoch(event),
    timeZone: eventTimeZone(event),
    description: eventDescription(event) || null,
    code: eventCode(event) || null,
    location: eventLocation(event) || null,
  })));
  const classified = classifyTrackingList(events);

  // Current track.4px.com runtime states (not part of the stable Open Platform
  // schema): 0 exception, 1 moving, 2 delivered, 3 forecast, 4 awaiting pickup,
  // 5 suspected return, 6 trajectory stalled, 7 no data. Exact event terminals
  // still win because the aggregate is known to lag last-mile scans.
  const numericField = (value) => (value == null || value === '' ? NaN : Number(value));
  const publicStatus = numericField(item.status);
  const returnStatusFlag = numericField(item.returnStatusFlag);
  let carrierState = null;
  if (returnStatusFlag === 2) carrierState = 'returned';
  else if (returnStatusFlag === 1) carrierState = 'returning';
  else {
    carrierState = {
      0: 'exception',
      1: 'in_transit',
      2: 'delivered',
      3: 'forecast',
      4: 'awaiting_pickup',
      5: 'suspected_return',
      6: 'stalled',
      7: 'no_data',
    }[publicStatus] ?? null;
  }

  let status = classified.status;
  if (!['delivered', 'exception'].includes(status)) {
    if (['returning', 'returned', 'exception', 'suspected_return'].includes(carrierState)) {
      status = 'exception';
    } else if (carrierState === 'delivered') {
      status = 'delivered';
    } else if (carrierState === 'forecast' && events.every(eventLooksPreTransit)) {
      status = 'pre_transit';
    } else if (carrierState === 'no_data') {
      status = 'unknown';
    } else {
      // Awaiting-pickup and stalled are still physically in transit; health
      // severity below carries the operator action without falsifying lifecycle.
      status = classified.status === 'unknown' ? 'in_transit' : classified.status;
    }
  }
  const classification = {
    ...classified,
    status,
    firstScanAt: status === 'pre_transit' ? null : classified.firstScanAt,
    carrierState,
    publicStatus: Number.isFinite(publicStatus) ? publicStatus : null,
    returnStatusFlag: Number.isFinite(returnStatusFlag) ? returnStatusFlag : null,
  };
  return {
    events,
    status,
    source: 'public',
    carrierState,
    publicStatus: classification.publicStatus,
    returnStatusFlag: classification.returnStatusFlag,
    classification,
  };
}

function fullResultFromNormalized(normalized) {
  const { classification: _classification, ...result } = normalized;
  return result;
}

/** Fetch and normalize full tracking events from the official Open Platform. */
async function _officialTrackFull(appKey, appSecret, trackingCode) {
  try {
    const data = await callApi(
      appKey,
      appSecret,
      OFFICIAL_API_METHOD,
      { deliveryOrderNo: trackingCode },
      { version: OFFICIAL_API_VERSION, timeoutMs: 12_000 }
    );
    return fullResultFromNormalized(normalizeOfficialTrackingData(data));
  } catch (error) {
    return {
      events: [],
      status: trackingFailureStatus(error),
      source: 'official',
      error: String(error?.message || error || 'api_error'),
    };
  }
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
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          clearTimeout(timer);
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (json.result !== 1 || !Array.isArray(json.data) || !json.data.length) {
              return resolve({ events: [], status: 'not_found', source: 'public' });
            }
            resolve(fullResultFromNormalized(normalizePublicTrackingItem(json.data[0])));
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

/**
 * Parse a 4PX display timestamp.
 *
 * Both official `occurDatetime` and public `tkDateStr` are emitted on the
 * gateway's UTC+8 clock. The accompanying timeZone/tkTimezone describes the
 * event location; it is not the offset applied to the display value. The public
 * `tkDate` absolute timestamp confirms this behavior and is preferred whenever
 * it exists (see eventEpoch).
 */
function _parseTrackTime(timeStr) {
  if (!timeStr) return null;
  const value = String(timeStr).trim();
  if (!value) return null;
  const hasOffset = /(?:z|[+-]\d{2}:?\d{2})$/i.test(value);
  const d = new Date(value.replace(' ', 'T') + (hasOffset ? '' : '+08:00'));
  return isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
}

/**
 * Cross-border pipeline stages (ascending = more progressed). Health heuristics
 * are stage-gated: a historical customs hold must not keep flagging a parcel
 * that has already entered the destination network or last-mile hand-off.
 */
const TRACKING_STAGE = Object.freeze({
  UNKNOWN: 0,
  ORIGIN: 1,
  EXPORT_CUSTOMS: 2,
  LINEHAUL: 3,
  IMPORT_CUSTOMS: 4,
  DESTINATION: 5,
  LAST_MILE: 6,
  DELIVERED: 7,
});

/**
 * Active customs HOLD wording only. Must NOT match clearances — a normal
 * China→US/EU lane posts "Released from customs: customs cleared" (and the
 * common 4PX typo "Relased from export customs") several times. Counting those
 * as holds was the primary source of false "Stuck" rows on the Shipping tab.
 */
const CUSTOMS_HOLD_RE = /\bcustoms\s+check\b|\bheld\s+(?:by\s+)?customs\b|\bcustoms\s+hold\b|\bcustoms\s+inspection\b|\bawaiting\s+customs\b|\bpending\s+customs\b|\bcustoms\s+clearance\s+in\s+progress\b|\bdetain(?:ed|ment)\s+(?:by\s+)?customs\b/i;

/** Customs CLEARANCE / exit wording (includes the live-feed "Relased" typo). */
const CUSTOMS_CLEAR_RE = /releas(?:ed|e)?\s+from\s+(?:export\s+|import\s+)?customs|relased\s+from\s+(?:export\s+|import\s+)?customs|customs\s+cleared|export\s+customs\s+cleared|cleared\s+(?:by\s+)?customs|customs\s+release/i;

/**
 * Infer where a single scan sits in the cross-border pipeline. Accepts either
 * a normalized/raw event or legacy description text.
 * @param {object|string|null|undefined} eventOrDescription
 * @returns {number} TRACKING_STAGE value
 */
function inferTrackingStage(eventOrDescription) {
  const event = eventOrDescription && typeof eventOrDescription === 'object'
    ? eventOrDescription
    : null;
  const t = event
    ? [eventDescription(event), eventLocation(event)].filter(Boolean).join(' ')
    : String(eventOrDescription || '').trim();
  const code = eventCode(event);
  if (event ? eventLooksDelivered(event) : isDeliveredText(t)) return TRACKING_STAGE.DELIVERED;
  if (!t && !code) return TRACKING_STAGE.UNKNOWN;
  if (/out for delivery|final delivery|\busps\b|royal mail|local (?:delivery|post|carrier)|handed\s+(?:over\s+)?to\s+(?:the\s+)?(?:local\s+)?(?:delivery\s+)?(?:carrier|post)|handed\s+over\s+to\s+last\s*mile|last[-\s]?mile/i.test(t)) {
    return TRACKING_STAGE.LAST_MILE;
  }
  // Destination-network movement. 4PX often labels the destination country's
  // sorting hub as "Arrived at Origin Hub" AFTER last-mile acceptance — that is
  // forward progress, not a regression to China origin.
  if (/departed\s+destination\s+hub|arrived\s+at\s+(?:origin|destination)\s+hub|destination\s+(?:hub|facilit|airport)|arrival\s+to\s+the\s+destination|arrived\s+at\s+.{0,40}destination|in\s+transit\s+to\s+next\s+facilit|regional\s+facilit|loaded\s+for\s+transport|delivery\s+(?:centre|center)|item\s+in\s+transit|shipment\s+(?:in\s+transit|arrived\s+to\s+transit)/i.test(t)) {
    return TRACKING_STAGE.DESTINATION;
  }
  if (CUSTOMS_CLEAR_RE.test(t) || CUSTOMS_HOLD_RE.test(t)) return TRACKING_STAGE.IMPORT_CUSTOMS;
  if (/\bcustoms\b/i.test(t)) return TRACKING_STAGE.IMPORT_CUSTOMS;
  if (/hand(?:ed)?\s+over\s+to\s+airline|departure\s+from\s+(?:the\s+)?original\s+airport|depart(?:ed|ure)\s+from\s+(?:the\s+)?origin/i.test(t)) {
    return TRACKING_STAGE.LINEHAUL;
  }
  if (/picked\s+up|arrived\s+at\s+facilit|depart\s+from\s+facilit|shipping\s+label|parcel\s+information\s+received|arrived\s+at\s+warehouse/i.test(t)) {
    return TRACKING_STAGE.ORIGIN;
  }
  // Official families are useful only after wording checks: prefixes are broad
  // business areas, not final statuses. For example FPX_O_RR can be a
  // destination service-provider scan, whose text is caught above.
  if (code.startsWith('FPX_D_')) return TRACKING_STAGE.DESTINATION;
  if (code.startsWith('FPX_I_')) return TRACKING_STAGE.IMPORT_CUSTOMS;
  if (code.startsWith('FPX_M_')) return TRACKING_STAGE.LINEHAUL;
  if (code.startsWith('FPX_Q_')) return TRACKING_STAGE.EXPORT_CUSTOMS;
  if (/^FPX_(?:C|F|L)_/.test(code)) return TRACKING_STAGE.ORIGIN;
  return TRACKING_STAGE.UNKNOWN;
}

/**
 * True when the newest scan shows the parcel has left import customs and is
 * moving in the destination network / last-mile. Used by health analysis and
 * by the cached-row repair so a stale "N customs scans" verdict cannot keep a
 * healthy parcel in the Stuck queue.
 * @param {string|null|undefined} description
 * @returns {boolean}
 */
function eventShowsPostCustomsProgress(eventOrDescription) {
  return inferTrackingStage(eventOrDescription) >= TRACKING_STAGE.DESTINATION;
}

function eventIsCustomsHold(event) {
  const code = eventCode(event);
  return code.startsWith('FPX_I_HC')
    || code === 'FPX_M_HCSC'
    || CUSTOMS_HOLD_RE.test([eventDescription(event), eventLocation(event)].join(' '));
}

function eventIsCustomsClear(event) {
  const code = eventCode(event);
  return code === 'FPX_I_CPC'
    || code === 'FPX_I_RCUK'
    || code === 'FPX_Q_ECC'
    || CUSTOMS_CLEAR_RE.test(eventDescription(event));
}

/**
 * True when the timeline shows the parcel has exited the latest customs HOLD
 * (a later clearance, or destination / last-mile movement).
 * Events are newest-first.
 * @param {TrackingEvent[]} list
 * @returns {boolean}
 */
function timelineExitedCustomsHold(list) {
  const ordered = sortTrackingEventsNewestFirst(list);
  if (!ordered.length) return false;
  if (eventShowsPostCustomsProgress(ordered[0])) return true;

  let latestHoldIdx = -1;
  for (let i = 0; i < ordered.length; i++) {
    if (eventIsCustomsHold(ordered[i])) {
      latestHoldIdx = i;
      break;
    }
  }
  if (latestHoldIdx < 0) {
    // No hold on record — a clearance or any destination-stage scan means customs
    // is not an active problem.
    return ordered.some((event) => eventIsCustomsClear(event) || eventShowsPostCustomsProgress(event));
  }
  // Newer than the latest hold (lower index) → clearance or network progress.
  for (let i = 0; i < latestHoldIdx; i++) {
    if (eventIsCustomsClear(ordered[i]) || eventShowsPostCustomsProgress(ordered[i])) return true;
  }
  return false;
}

/**
 * Analyze a tracking timeline for signs of a stuck or delayed parcel.
 *
 * Heuristics (tuned for 4PX cross-border lanes), evaluated in stage order:
 *   - Terminal disposal / carrier exception / completed delivery
 *   - Label created but no carrier acceptance scan
 *   - Active customs HOLD that has not been cleared or progressed past
 *   - Official transport/delivery-delay codes
 *   - No scan update for N days (with a longer destination-network grace period)
 *   - Extremely long total transit while still upstream
 *
 * Historical customs clearances are never counted as holds. Destination and
 * last-mile scans get a longer silence threshold, but absence of an explicit
 * delivery terminal is never treated as proof of delivery.
 *
 * @param {TrackingEvent[]} events  Newest-first
 * @param {string}        status    Canonical status from classifyTrackingList
 * @param {{stuckDays?:number}} [options]
 * @returns {{
 *   isStuck: boolean,
 *   severity: 'ok'|'warning'|'critical',
 *   reasons: string[],
 *   daysSinceLastUpdate: number|null,
 *   daysInTransit: number|null,
 *   repeatedEvents: Array<{ description: string, count: number }>,
 * }}
 */
function analyzeTrackingHealth(events, status, options = {}) {
  const list = sortTrackingEventsNewestFirst(events);
  const reasons = [];
  let severity = 'ok';
  const configuredStuckDays = Number(options.stuckDays);
  const criticalSilenceDays = Number.isFinite(configuredStuckDays)
    ? Math.min(30, Math.max(3, Math.round(configuredStuckDays)))
    : 10;
  const warningSilenceDays = Math.max(2, Math.min(7, criticalSilenceDays - 1));

  const bump = (level, msg) => {
    if (level === 'critical') {
      // The database stores the first reason as the board summary. If a warning
      // later escalates, put the critical cause first instead of showing a mild
      // reason on a red Stuck row.
      if (severity === 'critical') reasons.push(msg);
      else reasons.unshift(msg);
      severity = 'critical';
    } else {
      reasons.push(msg);
      if (severity !== 'critical') severity = 'warning';
    }
  };

  // Disposal is terminal — elevate above a generic exception so the Shipping
  // tab can surface a dedicated review queue. The event does not itself prove
  // compensation eligibility; that decision remains with 4PX.
  const newestIsDelivered = eventLooksDelivered(list[0]);
  const isDisposed = !newestIsDelivered && timelineHasDisposal(list);
  if (isDisposed) {
    bump('critical', 'Parcel disposed or destroyed by carrier — review 4PX claim eligibility.');
    return { isStuck: true, severity: 'critical', reasons, daysSinceLastUpdate: null, daysInTransit: null, repeatedEvents: [], isDisposed: true };
  }

  // A delivery terminal on the newest event settles the parcel even when the
  // status handed to us disagrees. Health is recomputed from the timeline on
  // every sync, so this also repairs rows whose status was persisted by an
  // earlier, narrower classifier — without it a delivered parcel stays silent
  // forever (it is finished) and the no-movement rule below reports it as stuck.
  if (status === 'delivered' || newestIsDelivered) {
    return { isStuck: false, severity: 'ok', reasons: [], daysSinceLastUpdate: null, daysInTransit: null, repeatedEvents: [], isDisposed: false, delivered: true };
  }

  if (status === 'exception' || eventLooksException(list[0])) {
    bump('critical', 'Carrier reported a delivery exception — contact 4PX.');
    return { isStuck: true, severity, reasons, daysSinceLastUpdate: null, daysInTransit: null, repeatedEvents: [], isDisposed: false };
  }

  const configuredNow = Number(options.nowEpoch);
  const nowSec = Number.isFinite(configuredNow) ? Math.floor(configuredNow) : Math.floor(Date.now() / 1000);
  const latestTs = eventEpoch(list[0]);
  const daysSinceLastUpdate = latestTs != null
    ? Math.max(0, Math.floor((nowSec - latestTs) / 86400))
    : null;

  // Oldest event with a parseable time → approximate transit duration.
  let oldestTs = null;
  for (let i = list.length - 1; i >= 0; i--) {
    const ts = eventEpoch(list[i]);
    if (ts != null) { oldestTs = ts; break; }
  }
  const daysInTransit = oldestTs != null
    ? Math.max(0, Math.floor((nowSec - oldestTs) / 86400))
    : null;

  // A label-only parcel is not healthy forever. It is operationally stuck when
  // 4PX still has no physical acceptance event after the configured threshold.
  if (status === 'pre_transit') {
    if (daysSinceLastUpdate != null && daysSinceLastUpdate >= criticalSilenceDays) {
      bump('critical', `No carrier acceptance scan for ${daysSinceLastUpdate} days after label creation.`);
    } else if (daysSinceLastUpdate != null && daysSinceLastUpdate >= warningSilenceDays) {
      bump('warning', `No carrier acceptance scan for ${daysSinceLastUpdate} days after label creation.`);
    }
    return {
      isStuck: severity === 'critical',
      severity,
      reasons,
      daysSinceLastUpdate,
      daysInTransit,
      repeatedEvents: [],
      isDisposed: false,
    };
  }

  const currentStage = inferTrackingStage(list[0]);
  const inDestinationNetwork = currentStage >= TRACKING_STAGE.DESTINATION;
  const exitedCustoms = timelineExitedCustomsHold(list);
  const destinationWarningDays = Math.max(criticalSilenceDays, warningSilenceDays + 3);
  const destinationCriticalDays = Math.max(destinationWarningDays + 7, criticalSilenceDays * 2);

  // Official delay events are useful immediately; do not wait for an arbitrary
  // text-age heuristic before exposing the Delayed watch queue.
  if (status === 'in_transit' && eventIsAwaitingPickup(list[0])) {
    bump('warning', 'Parcel is awaiting recipient pickup; collect promptly to avoid return.');
  } else if (
    status === 'in_transit'
    && (eventCodeIsDelay(list[0]) || /\b(?:transport|delivery|clearance)\s+delay\b/i.test(eventDescription(list[0])))
  ) {
    bump('warning', `Carrier reported a delay${eventDescription(list[0]) ? `: ${eventDescription(list[0])}` : '.'}`);
  }

  // Repeated ACTIVE customs HOLDS (not clearances). Clearance text contains
  // "customs" too; counting it produced 5–7 false "holds" on every healthy lane.
  const descCounts = new Map();
  for (const e of list) {
    const key = _normEventText(eventDescription(e));
    if (!key || key.length < 8 || !eventIsCustomsHold(e)) continue;
    descCounts.set(key, (descCounts.get(key) || 0) + 1);
  }
  const repeatedEvents = [...descCounts.entries()]
    .filter(([, n]) => n >= 4)
    .map(([description, count]) => ({ description, count }))
    .sort((a, b) => b.count - a.count);

  // Customs heuristics only apply while the parcel has NOT progressed past the
  // hold. Once last-mile / destination-hub scans appear, customs history is
  // resolved context — not a Stuck reason.
  if (!exitedCustoms && status === 'in_transit') {
    for (const { description, count } of repeatedEvents) {
      const short = description.length > 48 ? description.slice(0, 45) + '…' : description;
      bump('warning', `"${short}" repeated ${count}× — parcel may be stuck in a customs loop.`);
    }

    const holdCount = list.filter(eventIsCustomsHold).length;
    const clearCount = list.filter(eventIsCustomsClear).length;

    // Newest scan is still an active hold and it has gone quiet → real stall.
    if (eventIsCustomsHold(list[0]) && daysSinceLastUpdate != null) {
      if (daysSinceLastUpdate >= criticalSilenceDays) {
        bump('critical', `Held at customs with no update for ${daysSinceLastUpdate} days.`);
      } else if (daysSinceLastUpdate >= warningSilenceDays) {
        bump('warning', `Held at customs with no update for ${daysSinceLastUpdate} days.`);
      }
    }

    // Many holds and no clearance anywhere in the timeline — still inside customs.
    if (holdCount >= 4 && clearCount === 0) {
      bump(holdCount >= 6 ? 'critical' : 'warning',
        `${holdCount} customs holds with no clearance — likely held at customs.`);
    } else if (holdCount >= 3 && clearCount >= 2 && currentStage <= TRACKING_STAGE.IMPORT_CUSTOMS) {
      // Oscillating inspection without destination progress.
      bump('warning', 'Customs cleared and re-checked multiple times — possible re-inspection.');
    }
  }

  // Silence is evidence of a stall, never evidence of delivery. Destination and
  // last-mile stages get a wider grace period because partner scans are sparser.
  if (status === 'in_transit' && daysSinceLastUpdate != null) {
    if (inDestinationNetwork) {
      if (daysSinceLastUpdate >= destinationCriticalDays) {
        bump('critical', `No carrier update for ${daysSinceLastUpdate} days after reaching the destination network.`);
      } else if (daysSinceLastUpdate >= destinationWarningDays) {
        bump('warning', `No carrier update for ${daysSinceLastUpdate} days after reaching the destination network.`);
      }
    } else if (daysSinceLastUpdate >= criticalSilenceDays) {
      bump('critical', `No carrier update for ${daysSinceLastUpdate} days (parcel had not reached local delivery).`);
    } else if (daysSinceLastUpdate >= warningSilenceDays) {
      bump('warning', `No carrier update for ${daysSinceLastUpdate} days.`);
    }
  }

  // Long total transit while still moving is informational (delayed), not stuck —
  // 20–30 days is normal for economy. Skip once it reached the destination
  // network. Only flag the genuinely extreme, pre-delivery case as critical.
  if (status === 'in_transit' && daysInTransit != null && !inDestinationNetwork) {
    if (daysInTransit >= 40) bump('critical', `In transit for ${daysInTransit} days — well past any normal window.`);
    else if (daysInTransit >= 25) bump('warning', `In transit for ${daysInTransit} days.`);
  }

  // Stuck = critical only. Warning is the Delayed watch queue; conflating the
  // two previously made every slow-but-moving customs lane look like Stuck.
  const isStuck = severity === 'critical';
  return { isStuck, severity, reasons, daysSinceLastUpdate, daysInTransit, repeatedEvents, isDisposed: false };
}

function _withHealth(result, options = {}) {
  const events = sortTrackingEventsNewestFirst(result.events);
  // 4PX's own status field is an AGGREGATE and routinely lags its last-mile
  // partners: it stays "in transit" (public API status 1) after the partner has
  // posted a terminal scan. Event code + text + location are the source of truth.
  let status = result.status ?? 'unknown';
  if (eventLooksDelivered(events[0])) status = 'delivered';
  else if (eventLooksDisposed(events[0]) || eventLooksException(events[0])) status = 'exception';
  else {
    const hardTerminal = latestHardTerminal(events);
    if (hardTerminal) status = eventLooksDelivered(hardTerminal) ? 'delivered' : 'exception';
  }
  let health = analyzeTrackingHealth(events, status, options);
  if (status !== 'delivered' && !health.isDisposed) {
    const carrierPolicy = {
      exception: ['critical', '4PX marked this parcel as an exception.'],
      awaiting_pickup: ['warning', 'Parcel is awaiting recipient pickup; collect promptly to avoid return.'],
      suspected_return: ['critical', '4PX marked this parcel as a suspected return.'],
      stalled: ['critical', '4PX marked the tracking trajectory as stalled.'],
      returning: ['critical', '4PX marked this parcel as returning to sender.'],
      returned: ['critical', '4PX marked this parcel as returned to sender.'],
    }[result.carrierState];
    if (carrierPolicy) {
      const [targetSeverity, reason] = carrierPolicy;
      const rank = { ok: 0, warning: 1, critical: 2 };
      const severity = rank[targetSeverity] > rank[health.severity]
        ? targetSeverity
        : health.severity;
      health = {
        ...health,
        severity,
        isStuck: severity === 'critical',
        reasons: [reason, ...(health.reasons || []).filter((item) => item !== reason)],
      };
    }
  }
  return { ...result, events, status, health };
}

/**
 * Fetch a compact tracking SNAPSHOT for persistence (Shipping tab): canonical
 * status plus the first carrier scan, the most-recent event (description, time,
 * location), and a delivered timestamp. One API call (reuses getFullTrackingEvents),
 * so it's the single source the sync pass writes to the receipts row.
 *
 * @param {string} trackingCode
 * @param {object} [apiCredentials] { appKey, appSecret }
 * @returns {Promise<{ok:boolean, status:string, source:string, eventCount:number,
 *   firstScanAt:number|null, lastEventAt:number|null, lastEvent:string|null,
 *   lastLocation:string|null, deliveredAt:number|null, events:TrackingEvent[],
 *   health:object}>}
 */
async function getTrackingSnapshot(trackingCode, apiCredentials = {}) {
  const full = await getFullTrackingEvents(trackingCode, apiCredentials);
  const events = sortTrackingEventsNewestFirst(full.events);
  const VALID = new Set(['pre_transit', 'in_transit', 'delivered', 'exception']);
  const ok = VALID.has(full.status);

  const latest = events[0] || null;
  const lastEventAt = latest ? eventEpoch(latest) : null;

  // First physical scan = oldest event that is not forecast/label metadata.
  const firstScanEvent = [...events].reverse().find((event) => !eventLooksPreTransit(event));
  const firstScanAt = firstScanEvent ? eventEpoch(firstScanEvent) : null;

  return {
    ok,
    status: full.status,
    source: full.source,
    eventCount: events.length,
    firstScanAt,
    lastEventAt,
    lastEvent: latest ? latest.description : null,
    lastLocation: latest ? latest.location : null,
    deliveredAt: full.status === 'delivered' ? lastEventAt : null,
    events,
    health: analyzeTrackingHealth(events, full.status, { stuckDays: apiCredentials.stuckDays }),
  };
}

module.exports = {
  checkTrackingStatus,
  classifyTrackingList,
  normalizeOfficialTrackingData,
  normalizePublicTrackingItem,
  getFullTrackingEvents,
  analyzeTrackingHealth,
  _withHealth,
  getTrackingSnapshot,
  isDisposalText,
  timelineHasDisposal,
  isDeliveredText,
  isExceptionText,
  eventLooksDelivered,
  eventLooksDisposed,
  eventLooksException,
  eventEpoch,
  eventLocation,
  inferTrackingStage,
  eventShowsPostCustomsProgress,
  timelineExitedCustomsHold,
  TRACKING_STAGE,
  CUSTOMS_HOLD_RE,
  CUSTOMS_CLEAR_RE,
  DISPOSAL_RE,
  DELIVERED_RE,
  NOT_DELIVERED_RE,
  OFFICIAL_API_METHOD,
  OFFICIAL_API_VERSION,
};
