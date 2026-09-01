'use strict';

/**
 * 4PX Collection Appointment (揽收预约) — API adapter.
 *
 * WHAT THIS IS
 * ────────────────────────────────────────────────────────────────────────────
 * After a packer seals parcels, somebody has to get them to 4PX. The 4PX User
 * Center does that under DSS → 揽收预约 → 新建预约: you pick a date, confirm the
 * pickup address, and 4PX dispatches a driver to your door. The Open Platform
 * exposes the same three operations under the "揽收预约" category of the Global
 * Direct Shipping service, so the packing bench never has to leave this app:
 *
 *   ds.xms.api.collect.create.order  创建揽收预约单  — book a pickup
 *   ds.xms.api.collect.cancel.order  取消预约单      — cancel one
 *   ds.xms.api.collect.print.order   打印预约单      — get the appointment-form PDF
 *
 * All three are API version 1.0.0 on the standard router endpoint, so they ride
 * the shared signed client in ./api.js exactly like ds.xms.order.create does.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ────────────────────────────────────────────────────────────────────────────
 * 1. Bag grouping (组包). 4PX also publishes ds.xms.api.collect.create.big /
 *    .cancel.big / .print.big, which bundle several small parcels under one big
 *    -bag label so the driver scans once instead of N times. Its `ref_no` field
 *    is documented as "小包服务商单号" while the sibling ds.xms.order.create uses
 *    `ref_no` for the CUSTOMER's reference — the two readings are irreconcilable
 *    from the published docs, and guessing would mean sending the wrong parcel
 *    identifiers to a paid carrier. Bagging is optional (a driver can scan
 *    parcels individually), so it stays out until the semantics are confirmed
 *    with 4PX. The appointment itself carries no parcel list, so nothing here
 *    depends on it.
 * 2. Appointment status polling. 4PX publishes no "query appointment" method —
 *    the portal's 已分配 / 已揽收 / 已交仓 tabs have no API counterpart. Anything
 *    this app shows about an appointment is therefore OUR OWN ledger of what we
 *    submitted, never a claim about what the driver has done. The UI says so.
 *
 * WHY THE DATE WINDOW IS TIMEZONE-AWARE
 * ────────────────────────────────────────────────────────────────────────────
 * `reserve_time` is a bare calendar date (yyyy-MM-dd) interpreted by 4PX in the
 * pickup location's local time. The dashboard machine is not necessarily in that
 * timezone, so computing "today" with the server clock can offer (or reject) a
 * date that is off by one — booking a pickup for yesterday, which 4PX rejects,
 * or refusing today's pickup near midnight. Every date in this module is derived
 * in an explicit IANA timezone (default Asia/Shanghai, where 4PX's CN pickup
 * network operates).
 *
 * @module src/fourpx/collect
 */

const { callApi } = require('./api');

// ── API surface ──────────────────────────────────────────────────────────────

/** The three 揽收预约 methods this module speaks, and their API version. */
const COLLECT_METHODS = Object.freeze({
  createOrder: 'ds.xms.api.collect.create.order',
  cancelOrder: 'ds.xms.api.collect.cancel.order',
  printOrder:  'ds.xms.api.collect.print.order',
});

/** All three collection-appointment methods are published at v1.0.0. */
const COLLECT_API_VERSION = '1.0.0';

/** Timezone the pickup calendar is expressed in when none is configured. */
const DEFAULT_PICKUP_TIMEZONE = 'Asia/Shanghai';

/** Default size of the bookable window, in days including today. */
const DEFAULT_MAX_DAYS_AHEAD = 14;

/** Hard ceiling on the window, so a typo in config cannot render 3000 options. */
const MAX_DAYS_AHEAD_CEILING = 60;

/**
 * How recently a parcel must have been sealed to still count as awaiting a
 * driver, in days.
 *
 * The database cannot tell "still on the bench" from "handed over long ago but
 * never scanned": carrier_confirmed_at is only set by a successful tracking
 * lookup, so a parcel whose tracking never resolved reads as unscanned forever.
 * Without a bound, the pickup view would count months of long-gone parcels — the
 * fastest way to teach an operator to ignore a number. A week covers any
 * plausible delay between sealing a parcel and a driver taking it; older ones
 * are a tracking problem, which the dashboard surfaces elsewhere.
 */
const DEFAULT_AWAITING_DAYS = 7;

/** Ceiling on the awaiting window. */
const MAX_AWAITING_DAYS = 90;

/** Clamp a configured awaiting window into [1, MAX_AWAITING_DAYS]. */
function normalizeAwaitingDays(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_AWAITING_DAYS;
  return Math.min(MAX_AWAITING_DAYS, Math.max(1, Math.floor(n)));
}

/**
 * pickup_info field constraints, verbatim from the published request schema of
 * ds.xms.api.collect.create.order (v1.0.0). `max` is the documented length.
 *
 * Over-long values are REJECTED rather than truncated: a silently shortened
 * street address produces a driver who cannot find the door, which is a worse
 * failure than an error message on the screen of the person who can fix it.
 */
const PICKUP_FIELDS = Object.freeze([
  { key: 'name',           max: 64,  required: true,  label: 'Contact name' },
  { key: 'phone',          max: 26,  required: true,  label: 'Contact phone' },
  { key: 'country',        max: 32,  required: true,  label: 'Country' },
  { key: 'province',       max: 20,  required: true,  label: 'Province / state' },
  { key: 'city',           max: 64,  required: true,  label: 'City' },
  { key: 'district',       max: 64,  required: true,  label: 'District' },
  { key: 'street',         max: 128, required: false, label: 'Street' },
  { key: 'detail_address', max: 256, required: true,  label: 'Detailed address' },
  { key: 'zip_code',       max: 24,  required: false, label: 'Postcode' },
]);

/**
 * Alternative spellings accepted for each pickup field. config.json and the
 * browser form both flow through normalizePickupInfo, so a hand-written config
 * that says `contact_name` / `mobile` / `address` works instead of silently
 * dropping the value and failing at 4PX with a bare "required" error.
 */
const PICKUP_ALIASES = Object.freeze({
  name:           ['contact_name', 'contact', 'first_name'],
  phone:          ['mobile', 'tel', 'telephone', 'contact_phone'],
  country:        ['country_code', 'nation'],
  province:       ['state', 'province_name'],
  city:           ['city_name'],
  district:       ['area', 'region', 'county'],
  street:         ['street_name', 'road'],
  detail_address: ['address', 'detail', 'address1', 'street_address'],
  zip_code:       ['zip', 'zipcode', 'post_code', 'postcode', 'postal_code'],
});

/** Max length of the free-text cancellation reason 4PX accepts. */
const MAX_CANCEL_REASON_LENGTH = 100;

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * A validation failure the OPERATOR can fix (a missing field, a bad date).
 * Carries an HTTP status so route handlers can pass it straight through, and
 * the offending field so the browser can focus the right input.
 *
 * @param {string} message
 * @param {string|null} field  pickup_info key or 'reserve_date'
 */
function pickupValidationError(message, field = null) {
  const err = new Error(message);
  err.status = 400;
  err.code = 'PICKUP_INVALID';
  if (field) err.field = field;
  return err;
}

// ── Calendar ─────────────────────────────────────────────────────────────────

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The calendar date (YYYY-MM-DD) it currently is in `timeZone`.
 *
 * en-CA is used because its short numeric date format IS ISO 8601, which makes
 * this a formatting operation rather than a string-assembly one.
 *
 * @param {string} [timeZone]
 * @param {number} [nowMs]  injectable clock for tests
 * @returns {string}
 */
function todayInTimeZone(timeZone = DEFAULT_PICKUP_TIMEZONE, nowMs = Date.now()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date(nowMs));
}

/**
 * Add whole days to an ISO date, treating it as a pure calendar value.
 *
 * Arithmetic runs in UTC on purpose: an ISO date has no time or zone, so doing
 * it in the host's local time would drop or duplicate a day whenever the host
 * crosses a DST boundary that the pickup timezone does not.
 *
 * @param {string} isoDate  YYYY-MM-DD
 * @param {number} days
 * @returns {string} YYYY-MM-DD
 */
function addDaysToIsoDate(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Whole days from `fromIso` to `toIso` (negative when `toIso` is earlier). */
function daysBetweenIsoDates(fromIso, toIso) {
  const parse = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((parse(toIso) - parse(fromIso)) / 86_400_000);
}

/** English weekday name for an ISO date (rendered in UTC — see addDaysToIsoDate). */
function weekdayForIsoDate(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' })
    .format(new Date(Date.UTC(y, m - 1, d)));
}

/** Clamp a configured window size into [1, MAX_DAYS_AHEAD_CEILING]. */
function normalizeMaxDaysAhead(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_MAX_DAYS_AHEAD;
  return Math.min(MAX_DAYS_AHEAD_CEILING, Math.max(1, Math.floor(n)));
}

/**
 * The dates a pickup may be booked for, oldest (today) first — the list behind
 * the date dropdown, mirroring 4PX's own 预约上门揽收日期 picker.
 *
 * @param {object} [opts]
 * @param {string} [opts.timeZone]
 * @param {number} [opts.maxDaysAhead]  window size in days, including today
 * @param {number} [opts.nowMs]
 * @returns {{ date: string, weekday: string, offset: number, isToday: boolean }[]}
 */
function listReserveDateOptions(opts = {}) {
  const timeZone = opts.timeZone || DEFAULT_PICKUP_TIMEZONE;
  const span = normalizeMaxDaysAhead(opts.maxDaysAhead);
  const today = todayInTimeZone(timeZone, opts.nowMs ?? Date.now());
  const out = [];
  for (let offset = 0; offset < span; offset++) {
    const date = addDaysToIsoDate(today, offset);
    out.push({ date, weekday: weekdayForIsoDate(date), offset, isToday: offset === 0 });
  }
  return out;
}

/**
 * Validate a requested pickup date against the bookable window and return it
 * normalized. Rejects a past date (4PX cannot dispatch a driver into yesterday)
 * and a date beyond the window (4PX's own picker does not offer one).
 *
 * @param {string} rawDate
 * @param {object} [opts]  same shape as listReserveDateOptions
 * @returns {string} the accepted YYYY-MM-DD
 * @throws {Error} pickupValidationError
 */
function assertReserveDate(rawDate, opts = {}) {
  const date = String(rawDate ?? '').trim();
  if (!date) {
    throw pickupValidationError('Pick the date you want 4PX to collect the parcels.', 'reserve_date');
  }
  if (!ISO_DATE_RE.test(date)) {
    throw pickupValidationError(`Pickup date must be formatted YYYY-MM-DD (got "${date}").`, 'reserve_date');
  }
  // Reject an impossible calendar date ("2026-02-31") that still matches the
  // shape — round-tripping through the formatter is the cheapest real check.
  const [y, m, d] = date.split('-').map(Number);
  if (new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) !== date) {
    throw pickupValidationError(`"${date}" is not a real calendar date.`, 'reserve_date');
  }

  const timeZone = opts.timeZone || DEFAULT_PICKUP_TIMEZONE;
  const span = normalizeMaxDaysAhead(opts.maxDaysAhead);
  const today = todayInTimeZone(timeZone, opts.nowMs ?? Date.now());
  const offset = daysBetweenIsoDates(today, date);

  if (offset < 0) {
    throw pickupValidationError(
      `${date} has already passed (it is ${today} at the pickup address). Choose today or a later date.`,
      'reserve_date',
    );
  }
  if (offset >= span) {
    const last = addDaysToIsoDate(today, span - 1);
    throw pickupValidationError(
      `4PX pickups can only be booked up to ${last} (${span} days ahead). Choose an earlier date.`,
      'reserve_date',
    );
  }
  return date;
}

// ── Pickup address ───────────────────────────────────────────────────────────

/**
 * Collapse a raw value to the trimmed single-line string 4PX expects. Newlines
 * and runs of whitespace become one space: a multi-line address pasted out of a
 * spreadsheet would otherwise be transmitted with embedded control characters.
 */
function cleanLine(value) {
  if (value == null) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

/**
 * Read one pickup field from a raw object, honouring its accepted aliases.
 * @param {object} raw
 * @param {string} key
 */
function readPickupField(raw, key) {
  const direct = cleanLine(raw[key]);
  if (direct) return direct;
  for (const alias of PICKUP_ALIASES[key] || []) {
    const value = cleanLine(raw[alias]);
    if (value) return value;
  }
  return '';
}

/**
 * Normalize a pickup address into the exact `pickup_info` object 4PX documents,
 * validating presence and length. Optional fields are omitted when blank rather
 * than sent as "" — 4PX treats an empty string as a supplied value on some
 * fields and rejects it.
 *
 * @param {object|null|undefined} raw  config block or browser form payload
 * @param {object} [opts]
 * @param {boolean} [opts.partial=false]  collect problems instead of throwing;
 *   used by config load, where an incomplete address must warn (the operator can
 *   still complete it in the booking dialog) rather than abort startup.
 * @returns {object|{ pickup: object, problems: string[] }}
 * @throws {Error} pickupValidationError when !opts.partial
 */
function normalizePickupInfo(raw, opts = {}) {
  const partial = opts.partial === true;
  const source = raw && typeof raw === 'object' ? raw : {};
  const pickup = {};
  const problems = [];

  for (const field of PICKUP_FIELDS) {
    const value = readPickupField(source, field.key);
    if (!value) {
      if (field.required) problems.push(`${field.label} is required.`);
      continue;
    }
    if (value.length > field.max) {
      const problem = `${field.label} is ${value.length} characters — 4PX allows at most ${field.max}.`;
      if (partial) {
        problems.push(problem);
        continue;
      }
      throw pickupValidationError(problem, field.key);
    }
    pickup[field.key] = value;
  }

  // A driver is dispatched by phone. Anything without digits is a typo, and a
  // 4PX "invalid contact" rejection would not say which field caused it.
  if (pickup.phone && pickup.phone.replace(/\D/g, '').length < 5) {
    const problem = 'Contact phone must contain at least 5 digits so the driver can call ahead.';
    if (partial) problems.push(problem);
    else throw pickupValidationError(problem, 'phone');
  }

  if (partial) return { pickup, problems };
  if (problems.length) {
    // Name the first missing field so the browser can focus it.
    const firstMissing = PICKUP_FIELDS.find((f) => f.required && !pickup[f.key]);
    throw pickupValidationError(
      `Pickup address is incomplete — ${problems.join(' ')}`,
      firstMissing ? firstMissing.key : null,
    );
  }
  return pickup;
}

/** Truncate + clean a cancellation reason to what 4PX accepts. */
function normalizeCancelReason(raw) {
  const text = cleanLine(raw);
  if (!text) return '';
  return text.slice(0, MAX_CANCEL_REASON_LENGTH);
}

// ── Response normalization ───────────────────────────────────────────────────

/**
 * Pull the appointment number out of a create response.
 *
 * The documented success shape is { data: { collect_no: "2021081600000003" } },
 * and ./api.js has already unwrapped `data`. The camelCase and `collect_order_no`
 * aliases are accepted because 4PX's own docs use `collect_no` for create/cancel
 * but `collect_order_no` for print — the same identifier under two names — so a
 * gateway that normalizes one way or the other must not break booking.
 *
 * @param {object|string} data
 * @returns {string} the appointment number
 * @throws {Error} when the response carries no identifier
 */
function normalizeCollectCreateResponse(data) {
  if (typeof data === 'string' && data.trim()) return data.trim();
  const d = data && typeof data === 'object' ? data : {};
  const collectNo = cleanLine(
    d.collect_no ?? d.collectNo ?? d.collect_order_no ?? d.collectOrderNo ?? '',
  );
  if (!collectNo) {
    const err = new Error(
      '4PX accepted the pickup booking but returned no appointment number. ' +
      'Check 揽收预约 in the 4PX portal before booking again so the driver is not sent twice.',
    );
    err.code = 'PICKUP_NO_COLLECT_NO';
    err.status = 502;
    throw err;
  }
  return collectNo;
}

/**
 * Pull the appointment-form PDF URL out of a print response.
 *
 * The documented success shape has `data` as a bare URL string; the object form
 * is tolerated for the same reason as above.
 *
 * @param {object|string} data
 * @returns {string|null}
 */
function normalizeCollectPrintResponse(data) {
  if (typeof data === 'string') return cleanLine(data) || null;
  const d = data && typeof data === 'object' ? data : {};
  const url = cleanLine(d.url ?? d.pdf_url ?? d.pdfUrl ?? d.label_url ?? d.labelUrl ?? '');
  return url || null;
}

// ── API calls ────────────────────────────────────────────────────────────────

/**
 * Build the exact `ds.xms.api.collect.create.order` request body.
 *
 * Kept separate from the call so the payload can be asserted in tests and shown
 * by the diagnostic script without spending a real booking.
 *
 * @param {object} args
 * @param {string} args.reserveDate  YYYY-MM-DD (already validated)
 * @param {object} args.pickup       already normalized pickup_info
 * @returns {object}
 */
function buildCreateOrderPayload({ reserveDate, pickup }) {
  return { reserve_time: reserveDate, pickup_info: pickup };
}

/**
 * Book a pickup — 创建揽收预约单.
 *
 * NOT IDEMPOTENT. 4PX offers no client-supplied idempotency key for this method,
 * so this call is never retried: a replay after a lost response would dispatch a
 * second driver. A transport failure is surfaced as PICKUP_CREATE_UNCERTAIN and
 * the caller is responsible for recording that the outcome is unknown.
 *
 * @param {string} appKey
 * @param {string} appSecret
 * @param {object} args
 * @param {string} args.reserveDate
 * @param {object} args.pickup
 * @param {number} [args.timeoutMs=30000]
 * @returns {Promise<{ collectNo: string, payload: object, raw: object }>}
 */
async function createCollectOrder(appKey, appSecret, { reserveDate, pickup, timeoutMs = 30_000 }) {
  const payload = buildCreateOrderPayload({ reserveDate, pickup });
  let raw;
  try {
    raw = await callApi(appKey, appSecret, COLLECT_METHODS.createOrder, payload, {
      version: COLLECT_API_VERSION,
      timeoutMs,
    });
  } catch (err) {
    // A business rejection (result != "1") is definite: 4PX evaluated the
    // request and said no, so nothing was booked. api.js attaches `code` from
    // errors[].error_code for exactly those, which is how the two are told
    // apart from a timeout / reset, where the booking may or may not exist.
    if (!err.code) err.code = 'PICKUP_CREATE_UNCERTAIN';
    err.payload = payload;
    throw err;
  }
  return { collectNo: normalizeCollectCreateResponse(raw), payload, raw };
}

/**
 * Cancel a booked pickup — 取消预约单.
 *
 * The published schema names the free-text field `cancel_remark` while the
 * request example in the SAME document (and the declared field of the sibling
 * ds.xms.api.collect.cancel.big) uses `cancel_reason`. Both are sent: the field
 * is optional, unknown members are ignored by the gateway, and the alternative
 * is a cancellation whose reason is silently dropped.
 *
 * @param {string} appKey
 * @param {string} appSecret
 * @param {string} collectNo
 * @param {object} [opts]
 * @param {string} [opts.reason]
 * @param {number} [opts.timeoutMs=30000]
 * @returns {Promise<{ collectNo: string, reason: string, raw: object }>}
 */
async function cancelCollectOrder(appKey, appSecret, collectNo, opts = {}) {
  const no = cleanLine(collectNo);
  if (!no) throw pickupValidationError('An appointment number is required to cancel a pickup.', 'collect_no');
  const reason = normalizeCancelReason(opts.reason);
  const body = { collect_no: no };
  if (reason) {
    body.cancel_remark = reason;
    body.cancel_reason = reason;
  }
  const raw = await callApi(appKey, appSecret, COLLECT_METHODS.cancelOrder, body, {
    version: COLLECT_API_VERSION,
    timeoutMs: opts.timeoutMs ?? 30_000,
  });
  return { collectNo: no, reason, raw };
}

/**
 * Fetch the printable appointment form — 打印预约单.
 *
 * A pure read, so the caller may safely retry it.
 *
 * @param {string} appKey
 * @param {string} appSecret
 * @param {string|string[]} collectNos  one appointment number or several
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=30000]
 * @returns {Promise<{ pdfUrl: string|null, collectNos: string[], raw: object }>}
 */
async function printCollectOrder(appKey, appSecret, collectNos, opts = {}) {
  const list = (Array.isArray(collectNos) ? collectNos : [collectNos])
    .map(cleanLine)
    .filter(Boolean);
  if (!list.length) {
    throw pickupValidationError('At least one appointment number is required to print a pickup form.', 'collect_no');
  }
  const raw = await callApi(
    appKey,
    appSecret,
    COLLECT_METHODS.printOrder,
    { collect_order_no: list },
    { version: COLLECT_API_VERSION, timeoutMs: opts.timeoutMs ?? 30_000 },
  );
  return { pdfUrl: normalizeCollectPrintResponse(raw), collectNos: list, raw };
}

module.exports = {
  COLLECT_METHODS,
  COLLECT_API_VERSION,
  DEFAULT_PICKUP_TIMEZONE,
  DEFAULT_MAX_DAYS_AHEAD,
  MAX_DAYS_AHEAD_CEILING,
  DEFAULT_AWAITING_DAYS,
  MAX_AWAITING_DAYS,
  normalizeAwaitingDays,
  MAX_CANCEL_REASON_LENGTH,
  PICKUP_FIELDS,
  pickupValidationError,
  todayInTimeZone,
  addDaysToIsoDate,
  daysBetweenIsoDates,
  weekdayForIsoDate,
  normalizeMaxDaysAhead,
  listReserveDateOptions,
  assertReserveDate,
  normalizePickupInfo,
  normalizeCancelReason,
  normalizeCollectCreateResponse,
  normalizeCollectPrintResponse,
  buildCreateOrderPayload,
  createCollectOrder,
  cancelCollectOrder,
  printCollectOrder,
};
