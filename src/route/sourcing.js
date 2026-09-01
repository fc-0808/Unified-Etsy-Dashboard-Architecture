'use strict';

/**
 * "Where do we actually buy this?" — the single source of truth for whether a
 * route line still needs a supplier / stall answer, and why.
 *
 * Two DIFFERENT failures leave a shopper with nowhere to go, and both must be
 * chased the same way (send the product photo to the market contacts and ask
 * who sells it, where):
 *
 *   not_in_catalog — the title never matched the supplier catalog and nobody has
 *                    filled a shop / stall in by hand. Nothing is recorded.
 *   wrong_stall    — a location IS recorded, but the person standing in the
 *                    market found it wrong (错档口位). A recorded-but-wrong stall
 *                    is worth exactly as much as no stall at all, so the line
 *                    belongs in the same "unmatched" bucket and the same
 *                    re-sourcing request.
 *
 * Purchase status stays per component (case / grip / charm), so a line can need
 * re-sourcing for its charm while its case is perfectly fine.
 *
 * Keep this module dependency-free and side-effect-free: `src/route/dashboard.js`
 * derives row fields from it, the Export-images ZIP filters on it, and
 * `public/index.html` mirrors it client-side so live status edits re-bucket a row
 * without a round-trip.
 */

/** The component purchase status meaning "the recorded stall is wrong". */
const WRONG_STALL = 'Wrong Stall';

/**
 * What a Wrong Stall flag becomes once the location behind it is corrected: the
 * line is ordinary outstanding work again, now pointed at the right stall.
 * Wrong Stall and Pending are both "outstanding" (see src/orders/buy-queue.js),
 * so this never changes what is owed on an order — only where to go for it.
 */
const RESOLVED_STATUS = 'Pending';

const REASON_NOT_IN_CATALOG = 'not_in_catalog';
const REASON_WRONG_STALL = 'wrong_stall';

/** Operator-facing wording for each reason (UI badges + export manifest). */
const REASON_LABELS = {
  [REASON_NOT_IN_CATALOG]: 'Not in catalog',
  [REASON_WRONG_STALL]: 'Wrong stall',
};

/** Components bought at a stall, in the order the dashboard shows them. */
const COMPONENTS = ['case', 'grip', 'charm'];

/** component → the route-row / route_assignments field holding its status. */
const STATUS_FIELD = {
  case: 'status_case',
  grip: 'status_grip',
  charm: 'status_charm',
};

/** component → the route-row field saying the line actually has that piece. */
const PRESENT_FIELD = {
  case: 'has_case',
  grip: 'has_grip',
  charm: 'has_charm',
};

/**
 * Which physical location each component is bought at. Case and grip come off
 * the line's supplier stall; a charm has its own charm shop (resolved from the
 * charm library), which is why its stall can be wrong on its own.
 */
const LOCATION_SOURCE = {
  case: 'supplier',
  grip: 'supplier',
  charm: 'charm',
};

/**
 * Components whose STORED status is Wrong Stall, without regard for whether the
 * line has that piece. Use this against a raw `route_assignments` row (which
 * carries statuses but no component flags).
 *
 * @param {object} statuses - anything with status_case / status_grip / status_charm
 * @returns {string[]} component keys, in COMPONENTS order
 */
function flaggedComponents(statuses) {
  if (!statuses) return [];
  return COMPONENTS.filter((c) => statuses[STATUS_FIELD[c]] === WRONG_STALL);
}

/**
 * Components the shopper found at the wrong stall — flagged AND actually part of
 * the line, so a stale status left on a piece the product doesn't have (e.g. a
 * grip status on a case-only line) can never flag the row.
 *
 * @param {object} row - a buildRouteRows row
 * @returns {string[]} component keys, in COMPONENTS order
 */
function wrongStallComponents(row) {
  if (!row) return [];
  return flaggedComponents(row).filter((c) => !!row[PRESENT_FIELD[c]]);
}

/** @param {object} row - a buildRouteRows row */
function hasWrongStall(row) {
  return wrongStallComponents(row).length > 0;
}

/**
 * True when SOME shop / stall is recorded for the line — matched in the catalog
 * or filled in by hand. It says nothing about whether that location is correct.
 *
 * @param {object} row - a buildRouteRows row
 */
function supplierRecorded(row) {
  return !!(row && (row.supplier_in_catalog || row.supplier_is_override));
}

/**
 * Why this line still has nowhere trustworthy to buy it, or null when it is
 * sourced. "Nothing recorded" outranks "recorded but wrong": with no location at
 * all there is no stall for a Wrong Stall flag to be about.
 *
 * @param {object} row - a buildRouteRows row
 * @returns {'not_in_catalog'|'wrong_stall'|null}
 */
function sourcingReason(row) {
  if (!supplierRecorded(row)) return REASON_NOT_IN_CATALOG;
  if (hasWrongStall(row)) return REASON_WRONG_STALL;
  return null;
}

/** @param {object} row - a buildRouteRows row */
function needsSourcing(row) {
  return sourcingReason(row) !== null;
}

/**
 * The location currently on record for one component of a line — what we would
 * quote back when asking a contact "we were sent here and it was wrong".
 *
 * @param {object} row - a buildRouteRows row
 * @param {string} component - 'case' | 'grip' | 'charm'
 * @returns {{ shop: string, stall: string }}
 */
function recordedLocation(row, component) {
  if (!row) return { shop: '', stall: '' };
  if (LOCATION_SOURCE[component] === 'charm') {
    // A charm's stall is derived from its shop by the charm-shop directory, which
    // route rows don't carry — the shop name is what identifies the place.
    return { shop: String(row.charm_shop || '').trim(), stall: '' };
  }
  return {
    shop: String(row.supplier_shop || '').trim(),
    stall: String(row.supplier_stall || '').trim(),
  };
}

/**
 * Which Wrong Stall flags a location correction ANSWERS, and should therefore be
 * cleared back to Pending.
 *
 * Correcting a location IS the resolution of the "wrong stall" report about it:
 * the piece becomes ordinary outstanding work at the newly recorded stall.
 * Without this the flag — and the re-sourcing request it drives — would outlive
 * its own answer and the line would be asked about forever.
 *
 * Scoped by WHICH location moved, so fixing a supplier stall never silently
 * clears a separate complaint about the charm stall (or the other way round).
 *
 * @param {object} assignment - the stored route_assignments row, post-write
 * @param {{ supplier?: boolean, charm?: boolean }} corrected - locations that changed
 * @returns {string[]} component keys to reset to RESOLVED_STATUS
 */
function componentsResolvedByCorrection(assignment, corrected) {
  const moved = corrected || {};
  return flaggedComponents(assignment).filter((c) =>
    LOCATION_SOURCE[c] === 'charm' ? !!moved.charm : !!moved.supplier
  );
}

/**
 * Did this write actually MOVE a recorded location?
 *
 * Re-saving the shop / stall a row already held (the operator opening the picker
 * and pressing save on the same card) is not a correction, so it must never be
 * read as the answer to a "wrong stall" report. Only a value that genuinely
 * differs counts.
 *
 * Field names are caller-supplied so the same check spans route_assignments
 * overrides (`supplier_shop_override`), product_assignments defaults
 * (`supplier_shop`), and product_map catalog columns (`shop_name`).
 *
 * @param {object|null} before - the row as it stood before the write
 * @param {object|null} after - the row after the write
 * @param {string[]} fields - the columns describing that one location
 * @returns {boolean}
 */
function locationMoved(before, after, fields) {
  if (!after || !Array.isArray(fields) || !fields.length) return false;
  return fields.some((f) => String((before && before[f]) || '').trim() !== String(after[f] || '').trim());
}

/**
 * Where a product's orders are sent when the line itself says nothing: the saved
 * per-product default, falling back to the Product Catalog entry behind it — the
 * same two levels, in the same order, that buildRouteRows resolves.
 *
 * Both tables are flattened onto one shape so a "did it move?" comparison can
 * span them (a product often gains its first default from a catalog row).
 *
 * @param {object|null} assignment - product_assignments row
 * @param {object|null} catalog - product_map row
 * @returns {{ supplier_shop: string, supplier_stall: string, charm_code: string, charm_shop: string }}
 */
function productLocation(assignment, catalog) {
  const pick = (...vals) => String(vals.find((v) => String(v || '').trim()) || '').trim();
  return {
    supplier_shop: pick(assignment && assignment.supplier_shop, catalog && catalog.shop_name),
    supplier_stall: pick(assignment && assignment.supplier_stall, catalog && catalog.stall),
    charm_code: pick(assignment && assignment.charm_code, catalog && catalog.charm_code),
    charm_shop: pick(assignment && assignment.charm_shop, catalog && catalog.charm_shop),
  };
}

module.exports = {
  WRONG_STALL,
  RESOLVED_STATUS,
  REASON_NOT_IN_CATALOG,
  REASON_WRONG_STALL,
  REASON_LABELS,
  COMPONENTS,
  STATUS_FIELD,
  PRESENT_FIELD,
  flaggedComponents,
  wrongStallComponents,
  hasWrongStall,
  supplierRecorded,
  sourcingReason,
  needsSourcing,
  recordedLocation,
  componentsResolvedByCorrection,
  locationMoved,
  productLocation,
};
