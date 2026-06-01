'use strict';

/**
 * Shared inventory / event-log helpers used by the sync worker and API routes.
 */

/**
 * Distinct style labels at quantity 0 for a listing (from local cache).
 * @returns {{ styles: string[], hasZero: boolean }}
 */
function getZeroStylesForListing(db, listingId) {
  const rows = db.prepare(`
    SELECT DISTINCT style_value
    FROM listing_inventory
    WHERE listing_id = ? AND is_enabled = 1 AND quantity = 0
  `).all(listingId);

  const hasZero = rows.length > 0;
  const styles  = [...new Set(rows.map((r) => r.style_value).filter(Boolean))];
  return { styles, hasZero };
}

/**
 * @param {object} inv - Etsy GET listing inventory response
 */
function listingHasLiveZero(inv) {
  for (const product of inv.products || []) {
    for (const offering of product.offerings || []) {
      if (offering.is_enabled === false) continue;
      if (offering.quantity === 0) return true;
    }
  }
  return false;
}

/**
 * Top-up restock: raise every enabled offering that is BELOW targetQty up to
 * targetQty. Never reduces a healthy variation (a style at qty 14 stays 14),
 * so we only ever fix out-of-stock / low variations.
 *
 * Mutates `inv` in place (so the same object can be PUT back to Etsy).
 *
 * @param {object} inv       - Etsy GET listing inventory response
 * @param {number} targetQty - desired minimum quantity per offering
 * @returns {number} count of offerings that were raised
 */
function raiseOfferingsToTarget(inv, targetQty) {
  let changed = 0;
  for (const product of inv.products || []) {
    for (const offering of product.offerings || []) {
      if (offering.is_enabled === false) continue;
      if ((offering.quantity ?? 0) < targetQty) {
        offering.quantity = targetQty;
        changed++;
      }
    }
  }
  return changed;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ listingId: number, eventTypes: string[], withinSeconds?: number }} opts
 */
function hasRecentEvent(db, { listingId, eventTypes, withinSeconds = 3600 }) {
  if (!listingId || !eventTypes.length) return false;
  const since = Math.floor(Date.now() / 1000) - withinSeconds;
  const ph    = eventTypes.map(() => '?').join(',');
  return !!db.prepare(`
    SELECT id FROM events
    WHERE listing_id = ? AND event_type IN (${ph}) AND created_at > ?
    LIMIT 1
  `).get(listingId, ...eventTypes, since);
}

/**
 * Log ZERO_STOCK at most once per listing per hour.
 * @returns {boolean} true if a new row was inserted
 */
function logZeroStockIfNeeded(db, fields) {
  const { listing_id: listingId } = fields;
  if (hasRecentEvent(db, { listingId, eventTypes: ['ZERO_STOCK'], withinSeconds: 3600 })) {
    return false;
  }
  const { logEvent } = require('../db/setup');
  logEvent(db, fields);
  return true;
}

/**
 * Priority score for order-triggered checks (higher = check first when capped).
 */
function orderCheckPriority(db, listingId, twoHoursAgo) {
  const row = db.prepare(`
    SELECT MIN(quantity) AS min_qty, MAX(synced_at) AS last_sync, COUNT(*) AS row_count
    FROM listing_inventory WHERE listing_id = ? AND is_enabled = 1
  `).get(listingId);

  if (!row || row.row_count === 0) return 100;
  if (row.min_qty === 0) return 90;
  if (row.last_sync < twoHoursAgo) return 50;
  return 10;
}

module.exports = {
  getZeroStylesForListing,
  listingHasLiveZero,
  raiseOfferingsToTarget,
  hasRecentEvent,
  logZeroStockIfNeeded,
  orderCheckPriority,
};
