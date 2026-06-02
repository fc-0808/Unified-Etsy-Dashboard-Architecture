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
 * @property {string}  [post_code]
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
  } = input;

  // ── Validation ──────────────────────────────────────────────────────────────
  if (!ref_no?.trim())              throw new Error('ref_no is required');
  if (!logistics_product_code?.trim()) throw new Error('logistics_product_code is required');
  if (!sender)                      throw new Error('sender address is required');
  if (!recipient)                   throw new Error('recipient address is required');
  if (!Array.isArray(parcels) || parcels.length === 0)
    throw new Error('at least one parcel is required');

  // ── Sender ──────────────────────────────────────────────────────────────────
  const senderPayload = {
    first_name: sender.first_name,
    ...(sender.last_name  && { last_name:  sender.last_name  }),
    ...(sender.company    && { company:    sender.company    }),
    ...(sender.phone      && { phone:      sender.phone      }),
    ...(sender.email      && { email:      sender.email      }),
    country:    sender.country ?? 'CN',
    ...(sender.state      && { state:      sender.state      }),
    city:       sender.city ?? 'Shenzhen',
    ...(sender.street     && { street:     sender.street     }),
    ...(sender.post_code  && { post_code:  sender.post_code  }),
  };

  // ── Recipient ───────────────────────────────────────────────────────────────
  const recipientPayload = {
    first_name: recipient.first_name,
    ...(recipient.last_name && { last_name:  recipient.last_name }),
    ...(recipient.company   && { company:    recipient.company   }),
    phone:       recipient.phone ?? '',
    ...(recipient.email     && { email:      recipient.email     }),
    country:     recipient.country,
    ...(recipient.state     && { state:      recipient.state     }),
    city:        recipient.city,
    street:      recipient.street,
    ...(recipient.district  && { district:   recipient.district  }),
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

module.exports = {
  splitName,
  getLogisticsProducts,
  createShipOrder,
  getShipLabel,
  cancelShipOrder,
  getShipOrder,
};
