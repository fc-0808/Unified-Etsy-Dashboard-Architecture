'use strict';

/**
 * Shared inventory / event-log helpers used by the sync worker and API routes.
 */

// A case listing has up to two variation dimensions: the device/phone model
// (e.g. "iPhone 17 Pro Max") and the product style (e.g. "Case+Grip+Charm").
// Only the style matters for restock grouping — a restock applies across every
// model — so we always strip the model dimension. Etsy shops name these
// dimensions inconsistently ("Style" vs "Styles", "Phone Model" vs
// "iPhone Model"), which is exactly why labels were previously inconsistent.
const MODEL_PROP_RE  = /\b(model|phone|device|fits|compatib)/i;
const STYLE_PROP_RE  = /^\s*styles?\b/i;

/**
 * Derive the canonical { styleVal, secondaryVal } from an Etsy product's
 * `property_values` array. `styleVal` is the restock-relevant style dimension
 * (model stripped); `secondaryVal` is the model dimension when present.
 *
 * Single source of truth for variation labelling — used at write time
 * (`upsertListingInventory`) and by the backfill script so cache + history stay
 * consistent.
 *
 * @param {Array<{property_name?: string, values?: string[]}>} propValues
 * @returns {{ styleVal: string|null, secondaryVal: string|null }}
 */
function deriveVariationLabels(propValues) {
  const props = (propValues || []).filter(
    (p) => p && p.property_name && p.values && p.values[0] != null
  );
  if (!props.length) return { styleVal: null, secondaryVal: null };

  const valueOf = (p) => p.values[0];

  // Prefer an explicitly style-named property; otherwise treat whatever is not
  // the model dimension as the style.
  const explicitStyle = props.find((p) => STYLE_PROP_RE.test(p.property_name));
  let modelProp;
  let styleProps;
  if (explicitStyle) {
    styleProps = [explicitStyle];
    modelProp  = props.find((p) => p !== explicitStyle) || null;
  } else {
    modelProp  = props.find((p) => MODEL_PROP_RE.test(p.property_name)) || null;
    styleProps = props.filter((p) => p !== modelProp);
    if (!styleProps.length) styleProps = props; // model-only listing
  }

  const styleVal     = styleProps.map(valueOf).filter(Boolean).join(' / ') || null;
  const secondaryVal = modelProp ? valueOf(modelProp) : null;
  return { styleVal, secondaryVal };
}

/**
 * Format a list of distinct style labels into one clean, deduped string for an
 * event's `detail`/`style_value`. Centralised so every restock/zero-stock
 * message reads identically (e.g. "Case+Grip+Charm" or "Case Only, Case+Charm")
 * regardless of which code path logged it.
 *
 * @param {string[]} styles
 * @returns {string}
 */
function formatStyleLabel(styles) {
  const clean = [
    ...new Set(
      (styles || [])
        .map((s) => (typeof s === 'string' ? s.trim() : s))
        .filter(Boolean)
    ),
  ];
  return clean.length ? clean.join(', ') : 'unknown variation(s)';
}

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
 * Remove every product (variation combination) that targets a given phone model
 * from a listing's inventory, IN PLACE, so the trimmed `inventory` object can be
 * PUT straight back via updateListingInventory.
 *
 * Matching is done on the model dimension only (case-insensitive, trimmed): a
 * product is dropped when its model-named property_value (or, when no property is
 * explicitly model-named, any property_value) carries the target value. This is
 * what "the listing no longer offers the model the buyer chose" requires.
 *
 * Guard rails:
 *   • Returns { ok:false } without mutating when the model isn't found, or when
 *     removing it would leave the listing with ZERO products (Etsy rejects an
 *     empty inventory — the operator should delete the listing instead).
 *
 * @param {object} inventory - Etsy GET listing inventory response (mutated)
 * @param {string} modelValue - the phone model to remove (e.g. "iPhone 14 Pro")
 * @returns {{ ok: boolean, removed: number, remaining: number, reason?: string }}
 */
function removeModelFromInventory(inventory, modelValue) {
  const target = String(modelValue ?? '').trim().toLowerCase();
  if (!target) return { ok: false, removed: 0, remaining: (inventory.products || []).length, reason: 'no model specified' };

  const products = Array.isArray(inventory.products) ? inventory.products : [];
  const matchesModel = (p) => {
    const props = (p.property_values || []).filter((pv) => pv && Array.isArray(pv.values));
    if (!props.length) return false;
    const modelProps = props.filter((pv) => MODEL_PROP_RE.test(pv.property_name || ''));
    const scope = modelProps.length ? modelProps : props;
    return scope.some((pv) => (pv.values || []).some((v) => String(v ?? '').trim().toLowerCase() === target));
  };

  const kept = products.filter((p) => !matchesModel(p));
  const removed = products.length - kept.length;
  if (removed === 0) return { ok: false, removed: 0, remaining: products.length, reason: 'model not found on listing' };
  if (kept.length === 0) return { ok: false, removed, remaining: 0, reason: 'removing the model would leave the listing empty — delete the listing instead' };

  inventory.products = kept;
  return { ok: true, removed, remaining: kept.length };
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
  deriveVariationLabels,
  formatStyleLabel,
  getZeroStylesForListing,
  listingHasLiveZero,
  raiseOfferingsToTarget,
  removeModelFromInventory,
  hasRecentEvent,
  logZeroStockIfNeeded,
  orderCheckPriority,
};
