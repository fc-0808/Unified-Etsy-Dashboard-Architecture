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
const SENDER_STREET_MIN  = 10;  // "shipper's street length must be between 10 and 90"
const SENDER_STREET_MAX  = 90;

/** Default recipient phone used when the order carries none (Etsy never supplies
 *  a buyer phone, yet many destinations — GB, CA, AU, NZ… — require one). */
const DEFAULT_RECIPIENT_PHONE = '8613058082917';

/** Visible (non-space) character count of the combined consignee name. */
function _consigneeNameLen(first, last) {
  return `${first || ''}${last || ''}`.replace(/\s+/g, '').length;
}

/**
 * Enforce 4PX's consignee-name length rule (4–30 visible chars).
 *
 * Etsy buyers with very short names (e.g. "Ava") fall below the 4-char minimum
 * and 4PX rejects the order. We pad up to the minimum by repeating the FINAL
 * letter of the name ("Ava" → "Avaa") — deterministic, keeps it recognisably the
 * buyer, and never invents unrelated characters. Names over the maximum are
 * trimmed (last name first) so the field always lands inside 4–30.
 *
 * @param {string} firstName
 * @param {string} [lastName]
 * @returns {{ first_name: string, last_name: string }}
 */
function enforceConsigneeName(firstName, lastName = '') {
  let first = (firstName || '').trim();
  let last  = (lastName  || '').trim();

  // Pad to the minimum by repeating the last letter of the combined name.
  if (_consigneeNameLen(first, last) < CONSIGNEE_NAME_MIN && (first || last)) {
    const src = (last || first).replace(/\s+/g, '');
    const padChar = src.slice(-1) || 'x';
    while (_consigneeNameLen(first, last) < CONSIGNEE_NAME_MIN) {
      if (last) last += padChar; else first += padChar;
    }
  }

  // Cap to the maximum (trim the last name first, then the first name).
  if (last && (first.length + 1 + last.length) > CONSIGNEE_NAME_MAX) {
    last = last.slice(0, Math.max(0, CONSIGNEE_NAME_MAX - first.length - 1)).trim();
  }
  if (first.length > CONSIGNEE_NAME_MAX) first = first.slice(0, CONSIGNEE_NAME_MAX).trim();

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
  const senderPayload = {
    first_name: sender.first_name,
    ...(sender.last_name  && { last_name:  sender.last_name  }),
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
  //   • Consignee name must be 4–30 chars — short names ("Ava") are padded.
  //   • A phone is required for many destinations (GB/CA/AU/NZ…), but Etsy never
  //     exposes the buyer's phone, so we fall back to a default contact number.
  const consignee = enforceConsigneeName(
    decodeHtml(recipient.first_name),
    decodeHtml(recipient.last_name || '')
  );
  const recipientPhone = (recipient.phone ?? '').toString().trim()
    || (input.default_recipient_phone || DEFAULT_RECIPIENT_PHONE);
  const recipientPayload = {
    first_name:  consignee.first_name,
    ...(consignee.last_name && { last_name:  consignee.last_name }),
    ...(recipient.company   && { company:    decodeHtml(recipient.company)   }),
    phone:       recipientPhone,
    ...(recipient.email     && { email:      recipient.email     }),
    country:     recipient.country,
    ...(recipient.state     && { state:      decodeHtml(recipient.state)     }),
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
  enforceSenderStreet,
  DEFAULT_RECIPIENT_PHONE,
};
