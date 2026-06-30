'use strict';

/**
 * 4PX shipping-cost resolution.
 *
 * Single source of truth for turning a receipt's 4PX shipment into a stored cost,
 * shared by the sync worker (runFreightSyncPass) and the server's on-demand refresh
 * endpoints so both behave identically.
 *
 * Cost model (estimate → reconcile), the approach used by professional shipping
 * platforms (Shippo/EasyPost/ShipStation) for carrier billing:
 *
 *   1. ACTUAL (authoritative) — ds.xms.order.getFreight. 4PX only returns this once
 *      it has financially SETTLED the consignment (days/weeks later, in arrears).
 *   2. ESTIMATE (immediate)   — ds.xms.estimated_cost.get. A live rate-card lookup
 *      from destination + weight + product. This is the number the 4PX merchant
 *      portal shows the moment a parcel is measured, so it's available right away.
 *
 * We prefer ACTUAL when present and fall back to ESTIMATE, marking each row's status
 * accordingly ('billed' | 'estimated' | 'pending' | 'error'). Once an order is
 * 'billed' it is never re-queried (the cost is immutable).
 *
 * @module src/fourpx/freight
 */

const { getOrderFreight, getEstimatedCost } = require('./orders');
const { recordFourpxFreight } = require('../db/setup');

/**
 * Resolve and persist the shipping cost for one 4PX shipment.
 *
 * @param {object} args
 * @param {import('better-sqlite3').Database} args.db
 * @param {object} args.config       App config (default product/weight/currency knobs).
 * @param {string} args.appKey
 * @param {string} args.appSecret
 * @param {object} args.receipt      Row with: receipt_id, fourpx_consignment_no,
 *                                   fourpx_tracking_no, shipping_country_iso,
 *                                   fourpx_product_code, fourpx_weight_g,
 *                                   fourpx_freight_status.
 * @returns {Promise<{status:string, source:'billed'|'estimated'|'none', amount:number|null, currency:string|null}>}
 */
async function resolveReceiptFreight({ db, config, appKey, appSecret, receipt }) {
  // A receipt is a 4PX shipment if it has a dashboard-created consignment OR simply
  // a 4PX tracking number synced from Etsy (most shipments — created directly on the
  // 4PX portal — fall in the latter group and were previously never priced).
  const etsyTracking = /^4PX/i.test(receipt.tracking_code || '') ? receipt.tracking_code : null;
  const trackingNo = receipt.fourpx_tracking_no || etsyTracking;

  // ds.xms.order.getFreight resolves a consignment by its TRACKING number (4PX…CN),
  // its ref_no (ETSY-<id>), or the service-provider number — but NOT by the
  // ds_consignment_no (DS4PX…CN), which returns an empty {} (verified live). So
  // address the billed-cost lookup by the tracking number first, then the
  // reconstructed ref_no, then the consignment as a last resort.
  const refNo = receipt.receipt_id != null && receipt.receipt_id > 0
    ? `ETSY-${receipt.receipt_id}`
    : (receipt.receipt_id != null ? `MANUAL-${Math.abs(receipt.receipt_id)}` : null);
  const freightRequestNo = trackingNo || refNo || receipt.fourpx_consignment_no;

  if (!trackingNo && !receipt.fourpx_consignment_no) {
    return { status: 'pending', source: 'none', amount: null, currency: null };
  }

  // 1. Try the authoritative billed cost first (cheap when already settled).
  try {
    const actual = await getOrderFreight(appKey, appSecret, freightRequestNo);
    if (actual.status === 'billed' && actual.totalFee !== null) {
      recordFourpxFreight(db, receipt.receipt_id, {
        status: 'billed',
        totalFee: actual.totalFee,
        currency: actual.currency || 'CNY',
        billedWeightG: actual.billedWeightG,
        feeItems: actual.feeItems,
      });
      return { status: 'billed', source: 'billed', amount: actual.totalFee, currency: actual.currency || 'CNY' };
    }
  } catch (err) {
    // Non-fatal — fall through to the estimate. Surfaced by the caller's logging.
    receipt.__freightActualError = err.message;
  }

  // 2. Estimate from the rate card using the order's destination + weight + product.
  const country = (receipt.shipping_country_iso || '').toUpperCase();
  const product = receipt.fourpx_product_code || config.fourpx_default_product || null;
  const weightG = Number.isFinite(receipt.fourpx_weight_g) && receipt.fourpx_weight_g > 0
    ? receipt.fourpx_weight_g
    : (Number.isFinite(config.fourpx_default_weight_g) ? config.fourpx_default_weight_g : 100);
  const currency = config.fourpx_settlement_currency || 'CNY';

  if (country) {
    try {
      const est = await getEstimatedCost(appKey, appSecret, {
        countryCode: country, weightG, productCode: product, currency,
      });
      if (est.fee !== null) {
        recordFourpxFreight(db, receipt.receipt_id, {
          status: 'estimated',
          totalFee: est.fee,
          currency: est.currency,
          billedWeightG: est.chargeWeightG,
          feeItems: null,
        });
        return { status: 'estimated', source: 'estimated', amount: est.fee, currency: est.currency };
      }
    } catch (err) {
      recordFourpxFreight(db, receipt.receipt_id, { status: 'error' });
      return { status: 'error', source: 'none', amount: null, currency: null, error: err.message };
    }
  }

  // 3. Nothing resolved (no country, or both lookups empty) — mark pending.
  recordFourpxFreight(db, receipt.receipt_id, { status: 'pending' });
  return { status: 'pending', source: 'none', amount: null, currency: null };
}

module.exports = { resolveReceiptFreight };
