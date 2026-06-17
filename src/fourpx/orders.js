'use strict';

/**
 * 4PX Open Platform — Direct Shipping Order operations.
 *
 * Wraps the ds.xms.* family of API methods for creating, labeling,
 * querying, and cancelling direct-shipping orders.
 *
 * API METHODS USED
 * ────────────────
 *  ds.xms.order.create           Create a new shipping order
 *  ds.xms.label.get              Fetch the shipping-label PDF/IMG URL
 *  ds.xms.order.cancel           Cancel an existing order
 *  ds.xms.order.get              Query order details by reference number
 *  ds.xms.logistics_product.getlist  List available logistics products
 *
 * All calls share the authentication flow in src/fourpx/api.js (MD5 sign).
 *
 * REFERENCE
 * ─────────
 * Go SDK model source: https://github.com/zengweigg/fourpx-express/blob/main/model/
 * Official docs:       https://open.4px.com/v2/doc
 *
 * @module src/fourpx/orders
 */

const { callApi } = require('./api');

// ── JSDoc typedefs ────────────────────────────────────────────────────────────

/**
 * @typedef {object} SenderAddress
 * @property {string}  first_name
 * @property {string}  [last_name]
 * @property {string}  [company]
 * @property {string}  [phone]
 * @property {string}  [email]
 * @property {string}  country        ISO 2-letter code, default "CN"
 * @property {string}  [state]
 * @property {string}  city
 * @property {string}  [street]
 * @property {string}  post_code      Required — 4PX rejects orders without it (DS000000).
 *                                    Set via fourpx_sender.post_code in config.json.
 */

/**
 * @typedef {object} RecipientAddress
 * @property {string}  first_name
 * @property {string}  [last_name]
 * @property {string}  [company]
 * @property {string}  phone          Required by 4PX for most products/destinations
 * @property {string}  [email]
 * @property {string}  country        ISO 2-letter code
 * @property {string}  [state]
 * @property {string}  city
 * @property {string}  street
 * @property {string}  [district]     Address line 2 / apt / unit
 * @property {string}  [post_code]
 */

/**
 * @typedef {object} DeclareItem
 * @property {string}  name_en         English product name for customs (declare_product_name_en)
 * @property {string}  [name_cn]       Chinese product name for customs (declare_product_name_cn)
 * @property {number}  qty             Unit count
 * @property {number}  unit_price      Declared unit value (most 2 decimals)
 * @property {string}  currency        ISO currency code, e.g. "USD"
 * @property {string}  [brand]         Brand name; defaults to "none"
 * @property {string}  [hs_code]       Import-country HS tariff code (digits only)
 * @property {string}  [origin_country] ISO 2-letter origin country (default "CN")
 */

/**
 * @typedef {object} ParcelSpec
 * @property {number}        weight_g        Gross weight in grams (required)
 * @property {number}        [length_cm]     Length in cm
 * @property {number}        [width_cm]      Width in cm
 * @property {number}        [height_cm]     Height in cm
 * @property {number}        declared_value  Total declared value for this parcel
 * @property {string}        currency        ISO currency code
 * @property {'Y'|'N'}       include_battery Whether the parcel contains a battery
 * @property {DeclareItem[]} items           Customs declaration line items
 */

/**
 * @typedef {object} CreateOrderInput
 * @property {string}        ref_no                   Customer reference (e.g. Etsy receipt ID)
 * @property {string}        logistics_product_code   4PX product code, e.g. "BDS"
 * @property {string}        [warehouse_code]         4PX warehouse code, e.g. "CNSZX01"
 * @property {'1'|'2'|'3'|'5'} [deliver_type='3']    Delivery method to 4PX warehouse
 * @property {SenderAddress} sender                   Shipper address (from config)
 * @property {RecipientAddress} recipient             Buyer address (from Etsy order)
 * @property {ParcelSpec[]}  parcels                  Package list (typically 1)
 * @property {'U'|'P'}       [duty_type='U']          DDU (recipient pays) or DDP (sender pays)
 * @property {string}        [sales_platform]         e.g. "ETSY"
 * @property {string|number} [trade_id]               Etsy order / transaction ID
 * @property {string|number} [buyer_id]               Etsy buyer ID
 * @property {string}        [ioss_no]                EU IOSS number (declared value ≤ €150).
 *                                                    Maps to ds.xms.order.create `ioss_no`.
 * @property {string}        [vat_no]                 EU/UK VAT number (maps to `vat_no`).
 * @property {string}        [eori_no]                EU EORI number (maps to `eori_no`).
 */

/**
 * @typedef {object} CreateOrderResult
 * @property {string}  dsConsignmentNo     4PX internal consignment number — use for cancels / label
 * @property {string}  trackingNo          Public tracking number to share with buyer
 * @property {string}  [labelBarcode]      Label barcode (deprecated, use labelUrl)
 * @property {string}  refNo               Echo of the customer reference number
 * @property {string}  [logisticsChannelNo] Downstream channel number (may be empty initially)
 * @property {string}  [odaResultSign]     ODA flag: "Y" = remote area surcharge applies
 */

/**
 * @typedef {object} LabelResult
 * @property {string} [logisticsLabel]  Primary shipping label URL (PDF or IMG)
 * @property {string} [customLabel]     Customs label URL (special products only)
 * @property {string} [packageLabel]    Packing slip URL (special products only)
 * @property {string} [labelBarcode]    Label barcode string
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Decode HTML entities that Etsy injects into buyer name / address fields.
 *
 * Etsy's API HTML-encodes certain characters (e.g. "O&#39;Keefe" instead of
 * "O'Keefe").  If the value was not decoded before storage it arrives here as a
 * literal HTML entity string, which 4PX rejects with error 010101005
 * ("Only English and symbols can be entered, not pure symbols").
 *
 * Applied to every text field that flows from Etsy → DB → recipient payload.
 *
 * @param {string|null|undefined} str
 * @returns {string}
 */
function decodeHtml(str) {
  if (!str) return str ?? '';
  return str
    .replace(/&#(\d+);/g,         (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/gi,  '&')
    .replace(/&lt;/gi,   '<')
    .replace(/&gt;/gi,   '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/**
 * Split a full name into first / last components.
 * 4PX expects them as separate fields.
 *
 * @param {string} fullName
 * @returns {{ firstName: string, lastName: string }}
 */
function splitName(fullName) {
  const parts = (fullName || '').trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  const lastName  = parts.pop();
  const firstName = parts.join(' ');
  return { firstName, lastName };
}

// 4PX `ds.xms.order.create` field constraints (from the official open-platform
// docs / validation messages). Centralised so every order-creation path enforces
// them identically and a benign data quirk never causes a hard rejection.
const CONSIGNEE_NAME_MIN = 4;   // "consignee's name length must be between 4 and 30"
const CONSIGNEE_NAME_MAX = 30;
// 4PX rule 010101005: the consignee name must be made of a SURNAME and a GIVEN
// name, each with at least 2 letters, and the same word must not be repeated.
// A single-token name ("Stella") or an empty last_name is rejected outright.
const CONSIGNEE_PART_MIN_LETTERS = 2;
const SENDER_STREET_MIN  = 10;  // "shipper's street length must be between 10 and 90"
const SENDER_STREET_MAX  = 90;

/**
 * Legacy fixed fallback phone. RETAINED only for backward compatibility / as an
 * explicit manual override (input.default_recipient_phone).
 *
 * DO NOT reuse this as the universal fallback: Etsy never supplies a buyer phone,
 * so every phone-less order historically shipped with this SAME number. 4PX's
 * risk engine treats one contact appearing across thousands of unrelated
 * recipients as a "declared-recipient blacklist" (DS000000, "此订单为申报收件人黑
 * 名单") and rejects the order. New orders instead get a unique, destination-
 * localized number from generateRecipientPhone().
 */
const DEFAULT_RECIPIENT_PHONE = '8613058082917';

// ── Recipient phone generation ─────────────────────────────────────────────────
// Etsy does not expose the buyer's phone, yet 4PX requires one for many
// destinations (GB/US/CA/AU/NZ…). Rather than reuse a single hardcoded number on
// every order — which 4PX blacklists as a fraudulent shared contact — we
// synthesise a phone that is:
//   • destination-localized  — a valid national format for the country, so it
//     reads as a real local contact instead of a foreign (+86) number;
//   • deterministic per seed — the same order (ref_no) always yields the same
//     number, so retries are idempotent and never create a second identity;
//   • unique across orders   — different orders get different numbers, so no
//     single contact accumulates across unrelated recipients.

/**
 * Deterministically expand a seed into a stream of decimal digits.
 * Pure function of the seed (FNV-1a + xorshift mixing) — no randomness — so the
 * generated phone is stable across retries yet differs per order.
 *
 * @param {string} seed
 * @param {number} count  Number of digit characters required
 * @returns {string}      A string of exactly `count` characters '0'–'9'
 */
function _seededDigits(seed, count) {
  let h = 0x811c9dc5 >>> 0;                       // FNV-1a offset basis
  const s = (seed && String(seed)) || 'etsy-4px';
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;           // FNV-1a prime
  }
  let out = '';
  while (out.length < count) {
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
    h ^= h >>> 15;
    out += (h >>> 0).toString().padStart(10, '0');
  }
  return out.slice(0, count);
}

/** Char digit → number (input is always '0'–'9' from _seededDigits). */
const _digit = (ch) => ch.charCodeAt(0) - 48;

/** Build a valid 10-digit North-American (NANP) subscriber number: NXX-NXX-XXXX
 *  where the area-code and central-office leading digits are 2–9. */
function _nanp(d) {
  const lead = (i) => 2 + (_digit(d[i]) % 8); // 2–9
  return `${lead(0)}${d[1]}${d[2]}${lead(3)}${d[4]}${d[5]}${d[6]}${d[7]}${d[8]}${d[9]}`;
}

// Per-country builders. Each returns a digits-only E.164 string INCLUDING the
// country calling code (matching the historical "8613058082917" shape: no '+').
const RECIPIENT_PHONE_BUILDERS = {
  US: (d) => `1${_nanp(d)}`,                                  // +1 NXX-NXX-XXXX
  CA: (d) => `1${_nanp(d)}`,                                  // +1 NXX-NXX-XXXX
  GB: (d) => `447${1 + (_digit(d[0]) % 9)}${d.slice(1, 9)}`,  // +44 7[1-9]xxxxxxxx (mobile)
  AU: (d) => `614${d.slice(0, 8)}`,                           // +61 4xxxxxxxx (mobile)
  NZ: (d) => `6421${d.slice(0, 7)}`,                          // +64 21xxxxxxx (mobile)
};

/** Generic fallback for countries without a specific builder: a valid-format CN
 *  mobile (the historically-accepted shape) made unique per seed — 86 1[3-9] + 9. */
function _cnMobile(d) {
  return `861${3 + (_digit(d[0]) % 7)}${d.slice(1, 10)}`;
}

/**
 * Generate a placeholder recipient phone for a destination when the order carries
 * none. Destination-localized, deterministic per seed, and unique across orders.
 *
 * @param {string} country  ISO 2-letter destination country code
 * @param {string} seed     Stable per-order seed (e.g. the ref_no)
 * @returns {string}        Digits-only phone including country code
 */
function generateRecipientPhone(country, seed) {
  const cc = (country || '').toUpperCase();
  const digits = _seededDigits(`${cc}|${seed}`, 12);
  const build = RECIPIENT_PHONE_BUILDERS[cc] || _cnMobile;
  return build(digits);
}

// Destinations where 4PX mandates a non-empty consignee province
// (recipient_info.state) yet Etsy frequently omits it. The United Kingdom is the
// canonical case: British addressing treats the county as OPTIONAL (the postcode
// performs delivery routing), so most Etsy GB buyers have no county and 4PX
// rejects the order with 010104001 ("the consignee's province is required").
// Keyed by ISO-3166 alpha-2 (plus the colloquial "UK") for resilience against
// upstream data that uses the non-standard code.
const STATE_REQUIRED_DESTINATIONS = new Set(['GB', 'UK']);

// Full country names used as the final province fallback for the destinations
// above, when the order carries neither a province nor a city.
const STATE_FALLBACK_COUNTRY_NAME = { GB: 'United Kingdom', UK: 'United Kingdom' };

/**
 * Resolve a non-empty consignee province for the destinations that require one.
 *
 * 4PX rejects orders to certain countries (notably the UK) when
 * recipient_info.state is empty (010104001), but Etsy routinely omits the field
 * because the county is optional in those postal systems. Rather than invent a
 * fake value, we fall back to REAL data already present on the address:
 *
 *   1. the supplied province/county, when present (used verbatim);
 *   2. otherwise the buyer's city — a meaningful, deliverable province for these
 *      destinations (e.g. "London"), which the postcode disambiguates anyway;
 *   3. otherwise the destination's full country name (e.g. "United Kingdom").
 *
 * For every other destination the province is returned untouched (empty stays
 * empty), preserving the existing behaviour of omitting the field — important
 * because countries that validate the province against a fixed list (US, CA, AU…)
 * always receive a real state from Etsy and must never get a substituted value.
 *
 * @param {string} country  ISO 2-letter destination country code
 * @param {string} state    Province/county as supplied (already decoded)
 * @param {string} city     City as supplied (already decoded)
 * @returns {string}        Province to send, or '' to omit the field
 */
function resolveRecipientState(country, state, city) {
  const supplied = (state || '').trim();
  if (supplied) return supplied;

  const cc = (country || '').toUpperCase();
  if (!STATE_REQUIRED_DESTINATIONS.has(cc)) return '';

  return (city || '').trim() || STATE_FALLBACK_COUNTRY_NAME[cc] || cc;
}

/** Count Unicode letters (covers Latin, accented, CJK, …) in a string. */
function _letterCount(str) {
  return ((str || '').match(/\p{L}/gu) || []).length;
}

/** Last letter of a string, used to pad short parts deterministically. */
function _lastLetter(str) {
  const letters = (str || '').match(/\p{L}/gu);
  return letters ? letters[letters.length - 1] : 'x';
}

/**
 * Sanitise a buyer-supplied name fragment for 4PX.
 *
 * Etsy lets buyers enter free text (digits, emoji, symbols), but 4PX's name
 * validator only accepts letters plus the usual name punctuation (space, hyphen,
 * apostrophe, period). Anything else becomes a separator so the remaining real
 * letters survive as clean tokens. This also pre-empts the "must be letters"
 * branch of rule 010101005 for names like "Stella★" or "User123".
 */
function _sanitizeNamePart(str) {
  return (str || '')
    .replace(/[^\p{L}\s.'\-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Repeat the final letter until the part reaches the minimum letter count. */
function _padPart(part, minLetters) {
  let out = part;
  const pad = _lastLetter(part);
  while (_letterCount(out) < minLetters) out += pad;
  return out;
}

/**
 * Enforce 4PX's full consignee-name contract (rules 010101005 + length 4–30).
 *
 * 4PX requires the recipient name to be a SURNAME plus a GIVEN name, where each
 * part has ≥2 letters, no word is repeated, and the combined visible length is
 * 4–30 chars. Etsy, however, often gives us only a single token ("Stella"), or
 * the UI funnels the whole name into first_name with an empty last_name — both
 * of which 4PX rejects with code 010101005.
 *
 * This function is the single source of truth that turns ANY input into a valid
 * two-part name using only the buyer's real letters (never invented words):
 *   1. Sanitise + tokenise the combined name; drop repeated words (case-insens.).
 *   2. ≥2 distinct words  → given = all-but-last, surname = the last word.
 *   3. exactly 1 word     → split it in half so both fields exist (e.g. "Stella"
 *                           → "Ste"/"lla"); pad to ≥4 letters first when needed.
 *   4. Pad any part shorter than 2 letters by repeating its final letter.
 *   5. Cap the combined length at 30 (trim the given name first; surname is kept
 *      intact and never falls below 2 letters).
 *
 * @param {string} firstName
 * @param {string} [lastName]
 * @returns {{ first_name: string, last_name: string }}
 */
function enforceConsigneeName(firstName, lastName = '') {
  // 1. Combine both inputs, sanitise, tokenise, and drop repeated words so the
  //    "no repeated words" rule holds even for inputs like "Stella Stella".
  const combined = `${_sanitizeNamePart(firstName)} ${_sanitizeNamePart(lastName)}`.trim();
  const seen = new Set();
  const tokens = [];
  for (const tok of combined.split(/\s+/)) {
    if (!tok) continue;
    const key = tok.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tokens.push(tok);
  }

  let first = '';
  let last  = '';

  if (tokens.length >= 2) {
    // Standard case: the last word is the surname, the rest is the given name.
    last  = tokens[tokens.length - 1];
    first = tokens.slice(0, -1).join(' ');
  } else if (tokens.length === 1) {
    // Only one word available: 4PX still demands two parts, so split the buyer's
    // real letters in half rather than invent an unrelated surname. Pad to ≥4
    // letters first so each half clears the 2-letter minimum.
    let token = tokens[0];
    if (_letterCount(token) < CONSIGNEE_PART_MIN_LETTERS * 2) {
      token = _padPart(token, CONSIGNEE_PART_MIN_LETTERS * 2);
    }
    const mid = Math.ceil(token.length / 2);
    first = token.slice(0, mid);
    last  = token.slice(mid);
  } else {
    // No usable letters at all (e.g. name was all symbols/empty). Keep the order
    // shippable with a neutral, rule-compliant placeholder.
    first = 'Etsy';
    last  = 'Customer';
  }

  // 4. Each part must contain at least 2 letters.
  first = _padPart(first, CONSIGNEE_PART_MIN_LETTERS);
  last  = _padPart(last,  CONSIGNEE_PART_MIN_LETTERS);

  // 4b. The two parts must not be the same word (e.g. a one-letter input "A"
  //     pads to "Aaaa" and splits into "Aa"/"aa"). Extend the surname by one
  //     letter so the parts always differ — no repeated word reaches 4PX.
  if (first.toLowerCase() === last.toLowerCase()) {
    last += _lastLetter(last);
  }

  // 5. Cap the combined length at the maximum. Trim the given name first and
  //    never let either part drop below the 2-letter minimum.
  if ((first.length + 1 + last.length) > CONSIGNEE_NAME_MAX) {
    const roomForFirst = CONSIGNEE_NAME_MAX - 1 - last.length;
    if (roomForFirst >= CONSIGNEE_PART_MIN_LETTERS) {
      first = first.slice(0, roomForFirst).trim();
    } else {
      // Surname alone is over budget — trim it too, keeping both parts ≥2 letters.
      first = first.slice(0, CONSIGNEE_PART_MIN_LETTERS);
      last  = last.slice(0, CONSIGNEE_NAME_MAX - 1 - first.length).trim();
    }
  }

  return { first_name: first, last_name: last };
}

/**
 * Enforce 4PX's shipper-street length rule (10–90 chars).
 *
 * Postal products to some destinations (e.g. US POSTLINK) don't validate the
 * shipper street length, but stricter destinations (GB, CA, …) require a full
 * customs manifest and reject a street shorter than 10 chars. When the configured
 * street is too short we complete it with the sender's own city / state / postcode
 * (real location data, not filler) so it stays meaningful AND valid; over-length
 * streets are truncated to 90.
 *
 * @param {string} street
 * @param {{ city?: string, state?: string, post_code?: string, country?: string }} [ctx]
 * @returns {string}
 */
function enforceSenderStreet(street, ctx = {}) {
  let s = (street || '').trim();
  if (s.length >= SENDER_STREET_MIN && s.length <= SENDER_STREET_MAX) return s;

  if (s.length < SENDER_STREET_MIN) {
    // Append real location context (deduped) until the minimum is met.
    for (const part of [ctx.city, ctx.state, ctx.post_code, ctx.country]) {
      const p = (part || '').toString().trim();
      if (p && !s.toLowerCase().includes(p.toLowerCase())) {
        s = s ? `${s}, ${p}` : p;
        if (s.length >= SENDER_STREET_MIN) break;
      }
    }
    // Last resort: pad with the final character so the order is never blocked.
    while (s.length > 0 && s.length < SENDER_STREET_MIN) s += s.slice(-1);
    if (!s) s = 'Warehouse'.padEnd(SENDER_STREET_MIN, 'e'); // never empty
  }

  if (s.length > SENDER_STREET_MAX) s = s.slice(0, SENDER_STREET_MAX).trim();
  return s;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * List the logistics products available for this account.
 *
 * NOTE: This method may not be available for all 4PX account types.
 *       Falls back to an empty array if the API returns an error.
 *
 * @param {string}  appKey
 * @param {string}  appSecret
 * @param {object}  [filter]
 * @param {string}  [filter.countryCode]  Filter by 2-letter destination country
 * @returns {Promise<Array>}
 */
async function getLogisticsProducts(appKey, appSecret, filter = {}) {
  // ds.xms.logistics_product.getlist REQUIRES transport_mode and returns a
  // different product set per mode:
  //   1 = Express / Commercial    2 = Priority air
  //   3 = Postal / registered     4 = COD re-delivery
  // To present the complete catalog we query every mode and merge by code.
  const TRANSPORT_MODES = ['1', '2', '3', '4'];
  const TRANSPORT_LABEL = { 1: 'express', 2: 'priority', 3: 'postal', 4: 'cod' };

  const merged = new Map(); // code → product (first occurrence wins)

  await Promise.all(TRANSPORT_MODES.map(async (mode) => {
    const body = { transport_mode: mode };
    if (filter.countryCode) body.receive_country = filter.countryCode.toUpperCase();
    try {
      const data = await callApi(appKey, appSecret, 'ds.xms.logistics_product.getlist', body);
      const list = Array.isArray(data)
        ? data
        : (data.logisticsProductList ?? data.list ?? []);
      for (const p of list) {
        const code = p.logistics_product_code ?? p.logisticsProductCode ?? p.code;
        if (!code || merged.has(code)) continue;
        merged.set(code, {
          ...p,
          transport_mode:       mode,
          transport_mode_label: TRANSPORT_LABEL[mode],
        });
      }
    } catch (err) {
      console.warn(`[4px/orders] getLogisticsProducts(transport_mode=${mode}) failed: ${err.message}`);
    }
  }));

  return [...merged.values()];
}

/**
 * Create a 4PX direct-shipping order.
 *
 * Assembles and validates the full payload required by ds.xms.order.create,
 * then returns the assigned tracking number and consignment number.
 *
 * @param {string}            appKey
 * @param {string}            appSecret
 * @param {CreateOrderInput}  input
 * @returns {Promise<CreateOrderResult>}
 */
async function createShipOrder(appKey, appSecret, input) {
  const {
    ref_no,
    logistics_product_code,
    warehouse_code,
    deliver_type    = '3',
    sender,
    recipient,
    parcels,
    duty_type       = 'U',
    sales_platform,
    trade_id,
    buyer_id,
    ioss_no,
    vat_no,
    eori_no,
  } = input;

  // ── Validation ──────────────────────────────────────────────────────────────
  if (!ref_no?.trim())              throw new Error('ref_no is required');
  if (!logistics_product_code?.trim()) throw new Error('logistics_product_code is required');
  if (!sender)                      throw new Error('sender address is required');

  // Guard: sender.post_code is ALWAYS required by 4PX (error DS000000).
  // Destinations such as AU, CA, GB trigger stricter server-side validation that
  // returns DS000000 when the field is absent; omitting it for any country is wrong.
  // Caught here with a clear message so the config problem surfaces immediately.
  if (!sender.post_code?.trim()) {
    throw new Error(
      'sender.post_code (shipper postcode) is required by 4PX for all destinations ' +
      '(DS000000: "shipper\'s postcode is required"). ' +
      'Set "post_code" inside the fourpx_sender block in config.json and restart the server.'
    );
  }

  // Per-destination guard: several countries (AU, CA, NZ, GB, US) require a
  // valid sender phone number in addition to the postcode.  Warn early so the
  // operator can fix config before the shipment fails at 4PX.
  const DESTINATIONS_REQUIRING_SENDER_PHONE = new Set(['AU', 'CA', 'NZ', 'GB', 'US']);
  const destCountry = (recipient?.country ?? '').toUpperCase();
  if (DESTINATIONS_REQUIRING_SENDER_PHONE.has(destCountry) && !sender.phone?.trim()) {
    throw new Error(
      `sender.phone is required for shipments to ${destCountry}. ` +
      'Add "phone" to the fourpx_sender block in config.json.'
    );
  }

  if (!recipient)                   throw new Error('recipient address is required');
  if (!Array.isArray(parcels) || parcels.length === 0)
    throw new Error('at least one parcel is required');

  // ── Sender ──────────────────────────────────────────────────────────────────
  // post_code is sent unconditionally — it has already passed the validation guard
  // above, and using a conditional spread would silently drop it for edge-case
  // falsy values (e.g. after future refactors), reproducing DS000000.
  // street is normalised to 4PX's 10–90 length rule (enforceSenderStreet); a too-
  // short configured value (e.g. a province name) would otherwise be rejected for
  // stricter destinations with "shipper's street length must be between 10 and 90".
  // The shipper name is run through the same surname+given normaliser as the
  // consignee so a single-token configured name can't trip rule 010101005 either.
  const shipper = enforceConsigneeName(sender.first_name, sender.last_name || '');
  const senderPayload = {
    first_name: shipper.first_name,
    last_name:  shipper.last_name,
    ...(sender.company    && { company:    sender.company    }),
    ...(sender.phone      && { phone:      sender.phone      }),
    ...(sender.email      && { email:      sender.email      }),
    country:    sender.country ?? 'CN',
    ...(sender.state      && { state:      sender.state      }),
    city:       sender.city ?? 'Guangdong',
    street:     enforceSenderStreet(sender.street, sender),
    post_code:  sender.post_code,   // always sent — required by 4PX for all destinations
  };

  // ── Recipient ───────────────────────────────────────────────────────────────
  // decodeHtml() strips HTML entities that Etsy injects into buyer-supplied text
  // fields (e.g. "O&#39;Keefe" → "O'Keefe").  4PX error 010101005 is triggered
  // when raw entities reach the API.
  //
  // Two further 4PX rules are enforced here so an order is never rejected for a
  // benign data quirk that Etsy can't provide:
  //   • Consignee name (rule 010101005) must be a surname + given name, each ≥2
  //     letters, no repeated words, 4–30 chars total. Etsy frequently gives a
  //     single token ("Stella") or the whole name in first_name with no surname;
  //     enforceConsigneeName() always produces a valid two-part name.
  //   • A phone is required for many destinations (GB/CA/AU/NZ…), but Etsy never
  //     exposes the buyer's phone, so we fall back to a default contact number.
  const consignee = enforceConsigneeName(
    decodeHtml(recipient.first_name),
    decodeHtml(recipient.last_name || '')
  );
  // Phone: prefer the buyer's real number; else an explicit caller override; else
  // a synthesised destination-localized, per-order-unique number. Never fall back
  // to a single shared constant — that is what trips 4PX's recipient blacklist.
  const recipientPhone =
    (recipient.phone ?? '').toString().trim() ||
    (input.default_recipient_phone ?? '').toString().trim() ||
    generateRecipientPhone(recipient.country, ref_no);
  // Province (recipient_info.state): required by 4PX for some destinations (UK)
  // even though Etsy omits it. resolveRecipientState() fills it from real address
  // data only where mandated, otherwise leaves it empty so the field is omitted
  // exactly as before. Prevents 010104001 ("consignee's province is required").
  const recipientState = resolveRecipientState(
    recipient.country,
    decodeHtml(recipient.state || ''),
    decodeHtml(recipient.city || '')
  );
  const recipientPayload = {
    first_name:  consignee.first_name,
    last_name:   consignee.last_name,   // always present — 4PX 010101005 requires a surname
    ...(recipient.company   && { company:    decodeHtml(recipient.company)   }),
    phone:       recipientPhone,
    // email: required by 4PX for Etsy-origin shipments and mandatory for some
    // destinations (MX, etc.).  Always populate — callers must inject a fallback
    // before reaching here (buyer_email from DB → config default → owner address).
    ...(recipient.email     && { email:      recipient.email     }),
    // recipient_info.vat_no is included for completeness / label printing, but
    // note 4PX validates the destination tax id against the ORDER-LEVEL vat_no
    // field (see createShipOrder caller) — its "recipient_info.vat_no required"
    // error is satisfied there, not here. Verified empirically against the API.
    ...(recipient.vat_no    && { vat_no:     recipient.vat_no    }),
    country:     recipient.country,
    ...(recipientState      && { state:      recipientState      }),
    city:        decodeHtml(recipient.city),
    street:      decodeHtml(recipient.street),
    ...(recipient.district  && { district:   decodeHtml(recipient.district)  }),
    ...(recipient.post_code && { post_code:  recipient.post_code }),
  };

  // ── Parcels ─────────────────────────────────────────────────────────────────
  const parcelList = parcels.map((p) => {
    const declareInfo = (p.items ?? []).map((item) => ({
      declare_product_name_en:    item.name_en,
        ...(item.name_cn && { declare_product_name_cn: item.name_cn }),
      declare_product_code_qty:   item.qty,
      declare_unit_price_export:  +(item.unit_price.toFixed(2)),
      currency_export:            item.currency,
      declare_unit_price_import:  +(item.unit_price.toFixed(2)),
      currency_import:            item.currency,
      brand_export:               item.brand ?? 'none',
      brand_import:               item.brand ?? 'none',
      ...(item.hs_code        && { hscode_import:   item.hs_code    }),
      ...(item.origin_country && { origin_country: item.origin_country }),
    }));

    return {
      weight:           p.weight_g,
      ...(p.length_cm  && { length: p.length_cm }),
      ...(p.width_cm   && { width:  p.width_cm  }),
      ...(p.height_cm  && { height: p.height_cm }),
      parcel_value:     +(p.declared_value.toFixed(2)),
      currency:         p.currency,
      include_battery:  p.include_battery ?? 'N',
      declare_product_info: declareInfo,
    };
  });

  // ── business_type — REQUIRED by the API (DS000052 if empty). 4PX uses it for
  //   internal scheduling. The official default is "BDS", which works across the
  //   product families this dashboard ships (POSTLINK S5xxx, QC, PX, express…).
  //   The actual carrier is selected by logistics_product_code, not this value.
  const businessType = (input.business_type && String(input.business_type).trim()) || 'BDS';

  // ── Full payload ─────────────────────────────────────────────────────────────
  // Structure matches the official 4PX ds.xms.order.create schema (Go SDK
  // CreateOrderPost): logistics / recipient / deliver_type are NESTED wrapper
  // objects, and return_info is required.
  const payload = {
    ref_no:          ref_no.trim(),
    business_type:   businessType,
    duty_type,
    is_insure:       'N',
    logistics_service_info: {
      logistics_product_code,
    },
    return_info: {
      is_return_on_domestic: 'N',
      is_return_on_oversea:  'N',
    },
    parcel_list:     parcelList,
    sender:          senderPayload,
    recipient_info:  recipientPayload,
    deliver_type_info: {
      deliver_type,
      ...(warehouse_code && { warehouse_code }),
    },
    ...(sales_platform && { sales_platform }),
    ...(trade_id       && { trade_id:  String(trade_id)  }),
    ...(buyer_id       && { buyer_id:  String(buyer_id)  }),
    // EU compliance identifiers. ioss_no is required by 4PX for EU destinations
    // with a declared value ≤ €150 (marketplace-collected VAT, e.g. Etsy); vat_no
    // and eori_no are sent when the caller supplies them. Strip any whitespace and
    // an accidental "IOSS" prefix so customs EDI accepts the bare identifier.
    ...(ioss_no && { ioss_no: String(ioss_no).replace(/^\s*IOSS[:\s-]*/i, '').trim() }),
    ...(vat_no  && { vat_no:  String(vat_no).trim()  }),
    ...(eori_no && { eori_no: String(eori_no).trim() }),
  };

  const data = await callApi(appKey, appSecret, 'ds.xms.order.create', payload);

  return {
    dsConsignmentNo:    data.ds_consignment_no,
    trackingNo:         data['4px_tracking_no'],
    labelBarcode:       data.label_barcode,
    refNo:              data.ref_no,
    logisticsChannelNo: data.logistics_channel_no,
    odaResultSign:      data.oda_result_sign,
  };
}

/**
 * Fetch the shipping-label URL for an existing order.
 *
 * @param {string}  appKey
 * @param {string}  appSecret
 * @param {string}  requestNo    ds_consignment_no, 4px_tracking_no, or ref_no
 * @param {object}  [opts]
 * @param {'PDF'|'IMG'} [opts.format='PDF']
 * @returns {Promise<LabelResult>}
 */
async function getShipLabel(appKey, appSecret, requestNo, opts = {}) {
  const data = await callApi(appKey, appSecret, 'ds.xms.label.get', {
    request_no:                requestNo,
    response_label_format:     opts.format ?? 'PDF',
    is_print_declaration_list: 'Y',
    is_print_time:             'Y',
  });

  return {
    labelBarcode:   data.label_barcode   ?? null,
    logisticsLabel: data.label_url_info?.logistics_label ?? null,
    customLabel:    data.label_url_info?.custom_label    ?? null,
    packageLabel:   data.label_url_info?.package_label   ?? null,
  };
}

/**
 * Cancel an existing 4PX order.
 *
 * @param {string} appKey
 * @param {string} appSecret
 * @param {string} requestNo     ds_consignment_no or tracking number
 * @param {string} [reason]
 * @returns {Promise<void>}
 */
async function cancelShipOrder(appKey, appSecret, requestNo, reason = 'Customer request') {
  await callApi(appKey, appSecret, 'ds.xms.order.cancel', {
    request_no:    requestNo,
    cancel_reason: reason,
    currency:      'USD',
    deliver_type:  '3',
  });
}

/**
 * Query an existing 4PX order by reference number.
 *
 * @param {string} appKey
 * @param {string} appSecret
 * @param {string} requestNo     ds_consignment_no, tracking number, or customer ref
 * @returns {Promise<object>}
 */
async function getShipOrder(appKey, appSecret, requestNo) {
  return callApi(appKey, appSecret, 'ds.xms.order.get', { request_no: requestNo });
}

/**
 * Sanitize a buyer name into a filesystem-safe base name (WITHOUT extension).
 *
 * Strips characters that are illegal in Windows/macOS/Linux filenames plus
 * control chars, collapses runs of whitespace, and trims. Falls back to the
 * given value (e.g. the tracking number) when the name resolves to empty, so a
 * label is never written with a blank name.
 *
 * @param {string} buyerName
 * @param {string} [fallback]  Used when the buyer name resolves to empty.
 * @returns {string}           Base name WITHOUT extension.
 */
function safeLabelBaseName(buyerName, fallback) {
  const raw = (buyerName || '').trim();
  return raw.replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim()
      || (fallback || 'Shipment-Label');
}

/**
 * Assign a UNIQUE `.pdf` filename to each shipping label, named by its buyer, so
 * every label downloads as its own independent file with the correct buyer name
 * and no label is ever silently overwritten.
 *
 * De-duplication is intentionally CASE-INSENSITIVE: Windows and macOS use
 * case-insensitive filesystems, so "John Smith.pdf" and "john smith.pdf" would
 * collide and one label would be lost when the ZIP is extracted. Colliding names
 * get a " (2)", " (3)"… suffix instead. Order of `items` is preserved.
 *
 * @param {Array<{ receiptId: (number|string), buyerName?: string, trackingNo?: string }>} items
 * @returns {Map<number|string, string>} receiptId → unique filename (with .pdf)
 */
function assignUniqueLabelNames(items) {
  const used = new Set();   // lower-cased names already taken
  const out  = new Map();
  for (const it of items || []) {
    const base = safeLabelBaseName(it.buyerName, it.trackingNo || String(it.receiptId));
    let name = `${base}.pdf`;
    let n = 2;
    while (used.has(name.toLowerCase())) name = `${base} (${n++}).pdf`;
    used.add(name.toLowerCase());
    out.set(it.receiptId, name);
  }
  return out;
}

module.exports = {
  splitName,
  getLogisticsProducts,
  createShipOrder,
  getShipLabel,
  cancelShipOrder,
  getShipOrder,
  safeLabelBaseName,
  assignUniqueLabelNames,
  enforceConsigneeName,
  CONSIGNEE_NAME_MIN,
  CONSIGNEE_NAME_MAX,
  CONSIGNEE_PART_MIN_LETTERS,
  enforceSenderStreet,
  resolveRecipientState,
  generateRecipientPhone,
  DEFAULT_RECIPIENT_PHONE,
};
