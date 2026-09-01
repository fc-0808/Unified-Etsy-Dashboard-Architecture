'use strict';

/**
 * Shopping-Route dashboard logic.
 *
 * This module is the bridge between the Unified Etsy Dashboard (UED) and the
 * Orders Sorting Program (OSP).  It owns the *human-in-the-loop* layer that the
 * OSP Tkinter dashboard used to provide:
 *
 *   • Charm assignment   — which physical charm (CH-xxxxx) + charm shop each
 *                          order line should use.
 *   • Purchase status    — per-component Pending / Purchased / Out of Stock /
 *                          Out of Production for Case, Grip and Charm.
 *   • Exclusions         — drop a line from the next generated route.
 *
 * The automated catalog matching (title → supplier shop / stall / floor) and
 * the Excel/HTML rendering remain in OSP.  We feed our decisions to OSP through
 * the two files it already understands:
 *
 *   1. The --import-json order payload (charm_code / charm_shop per item).
 *   2. output/route_statuses_cache.json (per-component purchase statuses),
 *      which OSP reads via `_load_ui_status_cache`.
 *
 * Status-cache key format (must stay byte-identical to OSP):
 *     `${order_num}\x00${normalize(title).slice(0,50)}\x00${component}`
 * where component ∈ { case, grip, charm } and the value is one of STATUS_OPTIONS.
 */

const fs   = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const {
  getProductMap, getProductMapByNorm, getManualItems,
  getAllRouteAssignments, getAllProductAssignments,
  getCharmLibrary, getCharmShopDirectory,
  getOpenIssueMap, getOpenExchangeMap, getSubstitutionMap,
  getListingStyleImageMap, getListingVariationImageMap,
  MANUAL_SHOP_ID,
} = require('../db/setup');
const {
  lookupStyleKeyed,
  lookupVariationImage,
  parseStyleValueId,
  resolveUnswitchedLineImage,
  resolveSwitchedLineImage,
  variationImageApiUrl,
} = require('../listings/variation-images');
const enginePaths = require('./engine-paths');
const stallLocation = require('./stall-location');
const charmNotes = require('./charm-notes');
const sourcing = require('./sourcing');
const productTypes = require('../listings/product-types');

/** Valid component purchase statuses — mirror of OSP's STATUS_OPTIONS.
 *   Wrong Stall       (错档口位) — the recorded stall is wrong; must re-source.
 *                     Behaves like Out of Stock: still OUTSTANDING (needs action).
 *   Model Unavailable (没有此型号) — this phone model isn't carried here; a dead
 *                     end like Out of Production (terminal, not outstanding). */
const STATUS_OPTIONS = ['Pending', 'Purchased', 'Out of Stock', 'Out of Production', 'Model Unavailable', 'Wrong Stall'];
const DEFAULT_STATUS = 'Pending';

/**
 * Title-match threshold.
 * 100 = only products whose *exact* normalised title appears in the OSP
 * catalog are shown with supplier / location data.  Anything below 100
 * returns in_catalog:false so the dashboard never "guesses" a supplier
 * for a product that has not been explicitly catalogued.
 */
const MATCH_THRESHOLD = 100;
const ROUTE_QUERY_SCOPE_CHUNK_SIZE = 500;

/**
 * Read a finite scope in bounded IN-list batches. Values must already be
 * validated by the caller; this helper only de-duplicates and chunks them.
 *
 * @template T
 * @param {import('better-sqlite3').Database} db
 * @param {Iterable<T>} values
 * @param {(placeholders:string) => string} sqlFor
 * @returns {Array<object>}
 */
function queryScopeInChunks(db, values, sqlFor) {
  const scoped = [...new Set(values)];
  const rows = [];
  for (let i = 0; i < scoped.length; i += ROUTE_QUERY_SCOPE_CHUNK_SIZE) {
    const chunk = scoped.slice(i, i + ROUTE_QUERY_SCOPE_CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    rows.push(...db.prepare(sqlFor(placeholders)).all(chunk));
  }
  return rows;
}

/**
 * Replicate OSP's `_normalize`: pipes→commas, collapse whitespace, trim, lower.
 * MUST match generate_shopping_route.py exactly so status-cache keys align.
 * @param {string} text
 * @returns {string}
 */
function normalizeTitle(text) {
  return String(text ?? '')
    .replace(/\|/g, ',')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * The 50-char normalised-title key OSP uses for status-cache lookups and
 * de-duplication. This is a PRODUCT-TITLE key only — it is intentionally NOT
 * unique per line-item, because OSP keys its status cache by title alone.
 * @param {string} title
 * @returns {string}
 */
function itemKey(title) {
  return normalizeTitle(title).slice(0, 50);
}

/** Marker separating the title key from the listing id in a line-item key. */
const LINE_KEY_MARKER = '#L';
/** Marker separating the product identity from a per-line variant fingerprint. */
const LINE_VARIANT_MARKER = '#V';

/**
 * Per-line-item identity used to store charm / supplier / status assignments.
 *
 * The bare 50-char title key (`itemKey`) collides whenever two DIFFERENT
 * products (listings) share the same first 50 title characters — a charm
 * assigned to one then bleeds onto the other. We therefore scope the key by the
 * Etsy listing id, which uniquely identifies the product on the order line.
 * When the listing id is missing (legacy/edge data) we fall back to the bare
 * title key so nothing breaks.
 *
 * Format: `${normalisedTitle[:50]}#L${listing_id}`  (e.g. "kawaii case#L4498110917")
 *
 * NOTE: This is *only* for our internal tables (route_assignments,
 * product_assignments) and the dashboard UI. The OSP status cache and import
 * payload keep using title-based keys (see writeStatusCache / rowsToImportOrders)
 * so byte-for-byte parity with the Python generator is preserved.
 *
 * @param {string} title
 * @param {string|number|null|undefined} listingId
 * @returns {string}
 */
function lineItemKey(title, listingId) {
  const base = itemKey(title);
  const lid = listingId != null && String(listingId).trim() !== '' ? String(listingId).trim() : '';
  return lid ? `${base}${LINE_KEY_MARKER}${lid}` : base;
}

/**
 * Coerce anything order data hands us into a usable Etsy listing id, or null.
 * Transactions, manual sidecars and substitutions each store the id with a
 * different type (number, numeric string, empty string, null).
 *
 * @param {string|number|null|undefined} value
 * @returns {number|null}
 */
function toListingId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Compact fingerprint of a line's chosen phone model + style, used to keep two
 * variants of the SAME listing as distinct route lines (independent purchase
 * status / charm) without polluting the per-product defaults key.
 *
 * @param {string} [phoneModel]
 * @param {string} [style]
 * @returns {string}
 */
function variantFingerprint(phoneModel, style) {
  const bits = [phoneModel, style]
    .map((s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' '))
    .filter(Boolean);
  if (!bits.length) return '';
  return bits.join('|').replace(/[^a-z0-9+|.-]+/g, '').slice(0, 48);
}

/**
 * Per-line identity for a manual-order cart line. Same product + different
 * model/style must not share a route_assignments row (marking one Purchased
 * would otherwise settle the other). Product-level defaults still live under
 * the unsuffixed `lineItemKey` — see stripLineVariantKey / productDefaultsKey.
 *
 * @param {string} title
 * @param {string|number|null|undefined} listingId
 * @param {string} [phoneModel]
 * @param {string} [style]
 * @returns {string}
 */
function lineItemKeyWithVariant(title, listingId, phoneModel, style) {
  const base = lineItemKey(title, listingId);
  const v = variantFingerprint(phoneModel, style);
  return v ? `${base}${LINE_VARIANT_MARKER}${v}` : base;
}

/**
 * Drop the `#V…` variant suffix so product_assignments still key by product,
 * not by phone-model / style. Safe on unsuffixed (Etsy) keys — no-op.
 *
 * @param {string} lineKey
 * @returns {string}
 */
function stripLineVariantKey(lineKey) {
  const s = String(lineKey || '');
  const i = s.indexOf(LINE_VARIANT_MARKER);
  return i === -1 ? s : s.slice(0, i);
}

/**
 * Key under which a line's PER-PRODUCT saved defaults live in
 * `product_assignments` (the user-set supplier + charm that every order of the
 * same product should inherit).
 *
 * For a normal line this is the product identity (title + listing), with any
 * manual-order variant suffix stripped. For a line the operator has SWITCHED
 * to a new design it MUST be the REPLACEMENT design's identity — the product
 * we will actually buy — NOT the original order line. The original line's key
 * still carries the ORIGINAL product's saved supplier/charm, so reading (or
 * writing) defaults under it on a switched line leaks stale data: the switch
 * would update the title + image yet keep the OLD supplier name / stall. This
 * mirrors how the image, canonical key and title-based supplier matching
 * already re-key onto the replacement on a switch.
 *
 *   • catalog switch → replacement listing identity (new title + source listing)
 *   • custom switch  → null: a custom upload is NOT a catalog product, so it has
 *                      no per-product default to inherit or persist; only the
 *                      per-order override (route_assignments) applies to it.
 *   • no switch      → the line's product identity (variant suffix stripped).
 *
 * Used on BOTH sides so reads and writes always agree:
 *   • read  — buildRouteRows/emitRow, resolving the supplier/charm to display,
 *   • write — POST /api/route/assign, persisting an operator's manual supplier
 *             /charm edit as the correct product's default.
 *
 * @param {string} lineKey  the line's own key (lineItemKey of the ORIGINAL title)
 * @param {object|null} sub the substitution record for the line, if any
 * @returns {string|null}   product-defaults key, or null when none applies
 */
function productDefaultsKey(lineKey, sub) {
  if (!sub) return stripLineVariantKey(lineKey);
  if (sub.source === 'custom') return null;
  return lineItemKey(sub.new_title || '', sub.source_listing_id);
}

/**
 * A line is "fully purchased" — and therefore needs NO further shopping — once
 * every component it actually carries (case / grip / charm) is marked Purchased.
 *
 * This is the SINGLE SOURCE OF TRUTH for that predicate, shared by:
 *   • buildRouteRows (to stamp `fully_purchased` on each row),
 *   • the dashboard summary ("N orders to shop"), and
 *   • route generation (so the generated Excel contains EXACTLY the orders the
 *     dashboard says still need shopping — never the already-purchased ones).
 *
 * It deliberately reads the live `status_*` fields so callers can recompute it
 * AFTER mutating statuses (e.g. the charm purchase-progress reconciliation that
 * runs at generation time) without the stale value lingering. Out of Stock /
 * Out of Production are NOT treated as purchased — those still need attention.
 *
 * Mirrors the client's `_rowFullyPurchased` in public/index.html byte-for-byte.
 *
 * @param {{has_case?:boolean, has_grip?:boolean, has_charm?:boolean,
 *          status_case?:string, status_grip?:string, status_charm?:string}} row
 * @returns {boolean}
 */
function rowFullyPurchased(row) {
  const present = [];
  if (row.has_case)  present.push(row.status_case  || DEFAULT_STATUS);
  if (row.has_grip)  present.push(row.status_grip  || DEFAULT_STATUS);
  if (row.has_charm) present.push(row.status_charm || DEFAULT_STATUS);
  return present.length > 0 && present.every(s => s === 'Purchased');
}

// ── Model fix × shopping: intent, and the component boundary ─────────────────
//
// A "Fix model" record (order_exchanges) answers ONE question — this line must
// be fulfilled with a DIFFERENT phone model than the order says — but it has TWO
// operationally OPPOSITE shapes, told apart solely by whether we already hold a
// physical wrong-model item:
//
//   SWAP (have_model set)   — the item is IN HAND, just in the wrong model.
//        Nothing is bought: the operator carries it back to the stall and swaps
//        it. The case is therefore HELD OUT of the buy set and lives only in the
//        "To exchange" bucket.
//   BUY  (have_model blank) — we hold NOTHING. The buyer ordered/needs a model
//        we never obtained, so the correct-model case must be PURCHASED exactly
//        like any other case; only the MODEL to buy differs from the order line.
//
// Collapsing the two shapes is precisely the failure this boundary prevents:
// treating a BUY as if the case were in hand silently drops the line from the
// Orders Sorting dashboard, the mobile shopping route AND the generated Excel —
// nobody ever buys the case, while the open record blocks the parcel from the
// packing queue forever. The buy shape is not an exception to the buy list; it
// IS a buy, carrying a model correction.
//
// Orthogonally, a model fix covers only the GENERATION-SPECIFIC physical unit
// (see modelFixCoveredComponents). On an iPhone line that is the case: a grip
// is universal and a separately-sourced charm has no model, so both stay in the
// buy list. On an AirPods line the charm ships ATTACHED to the case — one
// object — so a swap holds the charm with the case, and a charm-only AirPods
// line holds the charm itself. A Case+Grip+Charm iPhone line must never lose
// its grip and charm from the route.
//
// These helpers are the SINGLE SOURCE OF TRUTH for both rules, so every consumer
// (mobile shop route, Orders rollup, desktop Route tab, Excel generation, the
// packing queue) agrees on what an open model fix holds vs. what stays shoppable.
const EXCHANGE_COMPONENTS = ['case', 'grip', 'charm'];

/** We hold the wrong-model item and will swap it in person — nothing to buy. */
const EXCHANGE_INTENT_SWAP = 'swap';
/** We hold nothing — the correct model must still be bought. */
const EXCHANGE_INTENT_BUY = 'buy';

/**
 * Which of the two shapes a model fix takes, derived from the ONE field that
 * decides it: `have_model`. Deriving (rather than storing a second column) means
 * the intent can never drift out of step with the model it is derived from.
 *
 * @param {string|null|undefined} haveModel - the exchange's have_model value.
 * @returns {'swap'|'buy'}
 */
function modelFixIntentFrom(haveModel) {
  return String(haveModel || '').trim() ? EXCHANGE_INTENT_SWAP : EXCHANGE_INTENT_BUY;
}

/**
 * The intent of the OPEN model fix on a route row, or null when it has none.
 * @param {{needs_exchange?:boolean, exchange_have_model?:string}} row
 * @returns {'swap'|'buy'|null}
 */
function exchangeIntent(row) {
  if (!row || !row.needs_exchange) return null;
  return modelFixIntentFrom(row.exchange_have_model);
}

/**
 * The intent of a raw `order_exchanges` record (as read from the DB), for
 * callers that hold the record rather than a route row.
 * @param {{have_model?:string}|null} exchange
 * @returns {'swap'|'buy'|null}
 */
function exchangeRecordIntent(exchange) {
  if (!exchange) return null;
  return modelFixIntentFrom(exchange.have_model);
}

/**
 * The generation-specific pieces a model fix covers on this line.
 *
 * A model fix corrects the DEVICE GENERATION the line must be fulfilled with.
 * Only pieces that actually change with generation are swapped or re-bought:
 *
 *   iPhone  — the case (it must fit the phone). A grip is universal and a
 *             separately-sourced charm has no model, so both stay in the
 *             normal buy list.
 *   AirPods — the generation-fit unit. An integral charm ships ATTACHED to
 *             the case (one physical object), so it travels with the case.
 *             Charm-only AirPods lines have no case: the charm itself is
 *             the product.
 *
 * Never empty — a flagged fix with no recognised pieces defaults to the case
 * so we never silently hold nothing.
 *
 * @param {{has_case?:boolean, has_charm?:boolean, charm_integral?:boolean,
 *          phone_model?:string, title?:string}|null|undefined} line
 * @returns {string[]} ordered subset of EXCHANGE_COMPONENTS
 */
function modelFixCoveredComponents(line) {
  if (!line) return ['case'];
  const airpods = !!(line.charm_integral) || isAirpodsProduct(line.phone_model, line.title);
  if (airpods) {
    const out = [];
    if (line.has_case) out.push('case');
    if (line.has_charm) out.push('charm');
    return out.length ? out : ['case'];
  }
  return ['case'];
}

/**
 * The set of components an OPEN model fix holds out of buying on a row. Robust
 * to legacy rows that stored multiple pieces, but treats a flagged record with
 * an empty/blank component list as the generation-specific unit for this line
 * (case on iPhone; case+attached-charm — or charm alone — on AirPods). Returns
 * an empty set when the row has no open model fix — or when the fix is a BUY,
 * since a buy holds no physical item and therefore withholds nothing from the
 * buy set.
 *
 * An AirPods integral charm is physically attached to its case. If a SWAP holds
 * the case, the charm travels with it even on legacy records that only stored
 * "case" — otherwise the shopper would be sent to buy a charm that is already
 * dangling from the wrong-generation case they are carrying back to the stall.
 *
 * @param {{needs_exchange?:boolean, exchange_have_model?:string,
 *          exchange_components?:string, has_case?:boolean, has_charm?:boolean,
 *          charm_integral?:boolean, phone_model?:string, title?:string}} row
 * @returns {Set<string>}
 */
function exchangeHeldComponents(row) {
  if (!row || !row.needs_exchange) return new Set();
  // BUY: no wrong-model item is in hand, so nothing is held back — the case is
  // bought like any other, just in the corrected model.
  if (exchangeIntent(row) === EXCHANGE_INTENT_BUY) return new Set();
  const raw = String(row.exchange_components || '')
    .split(',')
    .map(c => c.trim().toLowerCase())
    .filter(c => EXCHANGE_COMPONENTS.includes(c));
  // A flagged swap with no explicit pieces defaults to this line's generation-
  // specific unit, so we never fall back to "holds nothing".
  const held = new Set(raw.length ? raw : modelFixCoveredComponents(row));
  const airpods = !!(row.charm_integral) || isAirpodsProduct(row.phone_model, row.title);
  if (airpods && row.has_charm) {
    if (held.has('case')) held.add('charm');
    if (!row.has_case) {
      held.delete('case');
      held.add('charm');
    }
  }
  return held;
}

/**
 * The phone model this line must actually be FULFILLED with — bought at the
 * stall and packed into the parcel. An open model fix makes `need_model`
 * authoritative: the model on the order line is the one we already know to be
 * wrong, so showing it to a shopper would have them buy the wrong case a second
 * time. Every surface that tells a human WHICH model to obtain or pack (Route
 * table, mobile route, generated Excel) must read this rather than `phone_model`.
 *
 * @param {{phone_model?:string, needs_exchange?:boolean,
 *          exchange_need_model?:string}} row
 * @returns {string}
 */
function effectiveShoppingModel(row) {
  if (!row) return '';
  if (row.needs_exchange) {
    const need = String(row.exchange_need_model || '').trim();
    if (need) return need;
  }
  return row.phone_model || '';
}

/**
 * Which components a shopper still has to BUY for this row: every component the
 * line actually carries MINUS the ones an open exchange already holds (in hand,
 * to be swapped in person). This is the shopping-facing view of the line.
 * @param {object} row
 * @returns {{ has_case:boolean, has_grip:boolean, has_charm:boolean }}
 */
function shoppableComponentFlags(row) {
  const held = exchangeHeldComponents(row);
  return {
    has_case:  !!row.has_case  && !held.has('case'),
    has_grip:  !!row.has_grip  && !held.has('grip'),
    has_charm: !!row.has_charm && !held.has('charm'),
  };
}

/**
 * True when the row STILL has pieces to buy once exchange-held components are
 * set aside — i.e. it belongs in the shopping route. Only a SWAP whose entire
 * generation-specific unit is held and that has nothing else on the line comes
 * back false (it lives solely in the "To exchange" bucket); a BUY model fix
 * always keeps its case here.
 * @param {object} row
 * @returns {boolean}
 */
function rowHasShoppingWork(row) {
  const s = shoppableComponentFlags(row);
  const present = [];
  if (s.has_case)  present.push(row.status_case  || DEFAULT_STATUS);
  if (s.has_grip)  present.push(row.status_grip  || DEFAULT_STATUS);
  if (s.has_charm) present.push(row.status_charm || DEFAULT_STATUS);
  return present.some(st => st !== 'Purchased');
}

/**
 * The shopping-facing projection of a row: the shoppable component flags applied
 * over the original row, the CORRECTED model substituted into `phone_model`, and
 * `fully_purchased` recomputed against them. Returns null when nothing remains
 * to buy (a pure case swap, handled entirely in the "To exchange" bucket).
 *
 * Callers use this so a swapped case disappears from the buy list while the
 * grip/charm on the same line stay put — and so a BUY model fix reaches the
 * shopper as an ordinary purchase that names the model to actually get. The
 * model the buyer originally ordered is preserved as `ordered_phone_model` for
 * anyone who needs to show the correction rather than just its result.
 *
 * @param {object} row
 * @returns {object|null}
 */
function rowShoppingProjection(row) {
  if (!row.needs_exchange) return row;
  const flags = shoppableComponentFlags(row);
  if (!flags.has_case && !flags.has_grip && !flags.has_charm) return null;
  const view = {
    ...row,
    ...flags,
    phone_model: effectiveShoppingModel(row),
    ordered_phone_model: row.phone_model || '',
  };
  view.fully_purchased = rowFullyPurchased(view);
  return view;
}

/**
 * Rebuild a canonical "Case+Grip+Charm"-style string from component flags. Used
 * to hand the batch route generator (which derives components from `style`) an
 * exchange line whose held pieces have been dropped, so the case being swapped
 * is not re-bought while the grip/charm are still listed.
 * @param {{has_case?:boolean, has_grip?:boolean, has_charm?:boolean}} flags
 * @returns {string}
 */
function styleFromComponentFlags(flags) {
  const parts = [];
  if (flags.has_case)  parts.push('Case');
  if (flags.has_grip)  parts.push('Grip');
  if (flags.has_charm) parts.push('Charm');
  return parts.join('+');
}

/**
 * Does an active design switch SUPERSEDE an open fulfilment issue on the same
 * line — i.e. should the line flow into purchasing DESPITE the "on hold" flag?
 *
 * This is the SINGLE SOURCE OF TRUTH for that precedence rule, shared by the
 * Route builder, the Orders API/UI, and the startup self-heal migration, so all
 * three agree on exactly when a switched line is buyable.
 *
 * A design switch resolves the fulfilment problem that prompted it and makes the
 * replacement buyable — so it supersedes any issue that PRE-DATES it. But if the
 * REPLACEMENT itself later turns out to be unavailable, that new hold is raised
 * AFTER the switch and must stick. The discriminator is therefore pure recency
 * (no matter who raised the issue or how):
 *
 *   1. No switch                       → nothing supersedes the hold (held stays).
 *   2. Switch, no open issue           → trivially buyable.
 *   3. Switch at/after the issue       → the switch resolved it → SUPERSEDED
 *                                        (also self-heals a stale pre-switch flag
 *                                        whose resolve never ran).
 *   4. Issue raised AFTER the switch   → a new problem with the REPLACEMENT →
 *                                        the line stays HELD and shows in Issues.
 *
 * Timestamps are epoch seconds (`updated_at` = last time each was asserted), so
 * the rule is correct across re-raises, reopens and switch edits.
 *
 * @param {{updated_at?:number}|null|undefined} sub   active substitution, or null
 * @param {{updated_at?:number}|null|undefined} issue open issue, or null
 * @returns {boolean} true when the switch un-holds the line
 */
function substitutionSupersedesIssue(sub, issue) {
  if (!sub) return false;   // no switch → nothing supersedes the hold
  if (!issue) return true;  // switch, no open issue → trivially buyable
  return (sub.updated_at || 0) >= (issue.updated_at || 0);
}

/**
 * Derive which components an order line needs from its Style string.
 * Mirrors OSP's `_style_has`: "stand"/"kickstand" counts as a grip.
 *
 * A SINGLE-AXIS line (an Apple Watch band, an iPad case) has no bundle string to
 * read: its only variation is the fit, so the style is empty and nothing would
 * be derived. Such a line still has exactly one physical unit to buy, and a line
 * with zero components is invisible to the shopping route (rowHasShoppingWork)
 * — the item would silently never be bought. So when the style says nothing,
 * the line's device family decides: a single-unit line occupies the primary unit
 * slot (`case`), which every downstream surface already knows how to shop,
 * status and pack. `line` is optional; without it the historical behaviour is
 * exact.
 *
 * @param {string} style
 * @param {{phoneModel?:string, phone_model?:string, title?:string}} [line]
 * @returns {{ hasCase: boolean, hasGrip: boolean, hasCharm: boolean }}
 */
function styleComponents(style, line) {
  const s = String(style ?? '').toLowerCase();
  const comps = {
    hasCase:  s.includes('case'),
    hasGrip:  s.includes('grip') || s.includes('stand'),
    hasCharm: s.includes('charm'),
  };
  if (comps.hasCase || comps.hasGrip || comps.hasCharm) return comps;
  if (line) {
    const family = productTypes.deviceFamilyOf(line.phoneModel ?? line.phone_model, line.title);
    if (productTypes.familyIsSingleUnit(family)) return { hasCase: true, hasGrip: false, hasCharm: false };
  }
  return comps;
}

/**
 * Is this line an AirPods case (as opposed to a phone case)?
 *
 * AirPods cases are the only product whose charm is INTEGRAL to the item: the
 * dangling charm ships attached to the case and is baked into the product photo
 * (see product-types.js — AirPods styles are Case+Charm / Case Only / Charm
 * Only, never a separately-sourced charm with its own code/image/stall). This is
 * the SINGLE place that classifies a line as AirPods, so the Route tab and the
 * mobile Shopping view agree without duplicating any regex.
 *
 * The model VARIATION value is authoritative ("AirPods Pro 2", "AirPods 4", …);
 * the title is only consulted as a fallback for legacy/manual lines that carry
 * no model. A phone case never has an "AirPods" model, so this can't misfire on
 * one.
 *
 * @param {string} phoneModel - the resolved model variation value
 * @param {string} [title]    - product title (fallback only)
 * @returns {boolean}
 */
function isAirpodsProduct(phoneModel, title) {
  return productTypes.deviceFamilyOf(phoneModel, title) === productTypes.FAMILY_AIRPODS;
}

/**
 * Extract the fit (phone model / band size) + bundle style from an Etsy
 * variations array. Etsy v3 transactions store:
 * [{ formatted_name, formatted_value }, ...].
 *
 * Which property means what is decided by productTypes.variationPropertyRole —
 * the same registry the Bulk Listing Creator writes those properties from — so
 * a new product line's axis is understood here the moment it is declared. An
 * Apple Watch band's "Band Size" is a FIT: it is what a shopper must match at
 * the stall, and what a model fix corrects.
 *
 * @param {any} variations
 * @returns {{ phoneModel: string, style: string }}
 */
function parseVariations(variations) {
  let vars = variations;
  if (typeof vars === 'string') {
    try { vars = JSON.parse(vars); } catch { vars = []; }
  }
  if (!Array.isArray(vars)) vars = [];

  const pick = (v) =>
    (v?.formatted_value ?? v?.value ?? (Array.isArray(v?.values) ? v.values[0] : '') ?? '')
      .toString()
      .trim();

  let style = '';
  let phoneModel = '';
  for (const v of vars) {
    const role = productTypes.variationPropertyRole(v?.formatted_name || v?.property_name);
    if (role === 'choice' && !style) style = pick(v);
    else if (role === 'fit' && !phoneModel) phoneModel = pick(v);
  }
  return { style, phoneModel };
}

/**
 * Build the flat list of route line-items for the dashboard, merging each
 * order line with its saved assignment (charm + statuses + excluded).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} config - app config (for shop_name lookup)
 * @param {object} [filters]
 * @param {string} [filters.date_from] - YYYY-MM-DD
 * @param {string} [filters.date_to]   - YYYY-MM-DD
 * @param {number[]} [filters.receipt_ids] - an EXPLICIT receipt scope that replaces
 *        the date/shipped scope entirely. An empty array means "no receipts" and
 *        returns nothing; omit the key to mean "no receipt filter".
 * @param {string} [filters.shop_id]
 * @param {boolean}[filters.include_shipped]
 * @param {boolean}[filters.enrich_supplier] - look up supplier shop/stall from OSP catalog
 * @param {boolean}[filters.include_dismissed] - include lines the operator removed
 *        from the dashboard (default false — they are hidden from view + generation)
 * @param {boolean}[filters.include_issues] - include line-items that have an OPEN
 *        fulfilment issue (out of production / model unavailable). Default false —
 *        such lines are held out of the purchasing dashboard + route generation so
 *        a product the buyer may cancel/swap is never bought.
 * @returns {Array<object>} one row per order line-item
 */
function buildRouteRows(db, config, filters = {}) {
  const params = {};
  let whereClause;
  let explicitReceiptIds = null;

  // Single-receipt lookup (for "Add Order" feature — bypasses date filter).
  if (filters.receipt_id != null) {
    params.receipt_id = Number(filters.receipt_id);
    whereClause = 'r.is_paid = 1 AND r.receipt_id = @receipt_id';
  } else if (Array.isArray(filters.receipt_ids)) {
    // Explicit receipt set. Bypasses the date + shipped filters so pre-transit
    // (label-created) orders are included.
    //
    // An EMPTY array means "these receipts: none" and must return nothing. It is
    // deliberately NOT treated as "no filter": a caller that computed a scope and
    // legitimately found zero orders (e.g. an empty Need-to-purchase queue) would
    // otherwise silently fall through to the default 30-day pending scope and get
    // the WHOLE dashboard back. Pass `undefined` to mean "no receipt filter".
    const ids = filters.receipt_ids.map(Number).filter(Number.isInteger);
    if (ids.length) {
      explicitReceiptIds = [...new Set(ids)];
      whereClause = 'r.is_paid = 1 AND r.receipt_id IN (__receipt_scope__)';
    } else {
      whereClause = '0';   // no valid ids → empty result
    }
  } else if (filters.shop_id === MANUAL_SHOP_ID) {
    // "Manual orders" scope. Every manual order lives in the synthetic
    // __manual__ shop, but comes in two shapes:
    //   • Orders-tab manual order  → a `receipts` row, NO sidecar.
    //   • Route-tab manual order   → a `receipts` row PLUS one or more linked
    //                                `route_manual_items` sidecars (which carry
    //                                each product's image + purchasing detail).
    // Show ALL of them regardless of date / ship state — the operator asked to
    // see manual orders specifically, so the date + pending scope (which is only
    // meaningful for time-bounded Etsy sync data) must not hide any. Sidecar-
    // bearing receipts are de-duped out just below and re-emitted from the
    // manual loop with their richer detail (one dashboard row per product).
    whereClause = 'r.is_paid = 1 AND r.shop_id = @shop_id';
    params.shop_id = MANUAL_SHOP_ID;
  } else {
    // Default date / pending scope.
    //
    // IMPORTANT — keep the shop filter OUT of this group. The pending scope is
    // OR-ed below with the "extra receipts" and "needs purchase" branches, and
    // the shop filter must constrain ALL of them (not just this one), otherwise
    // a pre-transit / needs-purchase order from another shop bleeds into a
    // shop-filtered view. The shop filter is therefore applied as a single
    // top-level AND that wraps the entire OR (see `shopClause` below).
    const scope = [];
    const nowSec = Math.floor(Date.now() / 1000);
    if (filters.date_from) {
      const ts = Math.floor(new Date(filters.date_from + 'T00:00:00Z').getTime() / 1000);
      if (!Number.isNaN(ts)) { scope.push('r.etsy_created_at >= @date_from'); params.date_from = ts; }
    } else {
      scope.push('r.etsy_created_at >= @date_from');
      params.date_from = nowSec - 30 * 24 * 3600;
    }
    if (filters.date_to) {
      const ts = Math.floor(new Date(filters.date_to + 'T23:59:59Z').getTime() / 1000);
      if (!Number.isNaN(ts)) { scope.push('r.etsy_created_at <= @date_to'); params.date_to = ts; }
    }
    if (!filters.include_shipped) {
      scope.push(
        "r.is_shipped = 0 AND r.status NOT IN ('Canceled','Cancelled','Fully Refunded','Fully refunded')"
      );
    }

    let scopeClause = scope.length ? `(${scope.join(' AND ')})` : '1';

    // Pre-transit orders (a label was created to hit the Etsy ship-by deadline but
    // the carrier has not yet confirmed pickup, so the goods may still need buying)
    // are an ACTIVE fulfilment obligation. Include them DIRECTLY here — exactly as
    // the Orders "Needs purchase" view does — rather than depending on the
    // needs_purchase_at rollup flag. That flag is only set lazily, when a component
    // status is edited, so a freshly-synced pre-transit order whose components are
    // all still default-Pending would otherwise never enter the route. Bounded by
    // the same pre_transit window the rest of the app uses, and OR-ed on top of the
    // date scope so it is never date-limited away. (Skipped when the caller asks for
    // shipped orders too, since that already widens the scope.)
    if (!filters.include_shipped) {
      const preTransitDays = config.pre_transit_days ?? 30;
      const preCutoff = nowSec - preTransitDays * 24 * 3600;
      scopeClause = `(${scopeClause} OR (r.is_shipped = 1
        AND r.tracking_code IS NOT NULL
        AND r.shipment_notified_at IS NOT NULL
        AND r.shipment_notified_at >= ${preCutoff}
        AND r.carrier_confirmed_at IS NULL
        AND r.status NOT IN ('Canceled','Cancelled','Fully Refunded','Fully refunded')))`;
    }

    // Extra receipts (e.g. pre-transit orders the operator pulled in via the
    // Orders tab "Send to Route") are UNIONed on TOP of the date scope — they
    // bypass the date + shipped filters so they always show up for purchasing,
    // *in addition to* (never instead of) the pending orders.
    const extra = Array.isArray(filters.extra_receipt_ids)
      ? filters.extra_receipt_ids.map(Number).filter(Number.isInteger)
      : [];
    if (extra.length) {
      const ph = extra.map((_, i) => `@xrid${i}`).join(',');
      extra.forEach((id, i) => { params[`xrid${i}`] = id; });
      scopeClause = `(${scopeClause} OR r.receipt_id IN (${ph}))`;
    }

    // Orders the operator flagged in the Orders tab as "still out of stock — needs
    // purchase" (typically Pre-transit: a label was created to hit the Etsy ship-by
    // deadline but the product still must be bought). These are is_shipped = 1, so the
    // pending scope above excludes them — we UNION them back in, durably and server-side
    // (no reliance on a single browser's localStorage), so they always show up for
    // purchasing until the flag is cleared. Cancelled/refunded ones are left out.
    if (filters.include_needs_purchase !== false) {
      scopeClause = `(${scopeClause} OR (r.needs_purchase_at IS NOT NULL
        AND r.status NOT IN ('Canceled','Cancelled','Fully Refunded','Fully refunded')))`;
    }

    // Shop filter — a HARD scope applied as a top-level AND so it constrains
    // EVERY branch above (pending, pinned-extra and needs-purchase alike). When
    // the operator selects a shop they must see ONLY that shop's orders; nothing
    // from another shop may ever leak in via an OR branch.
    let shopClause = '';
    if (filters.shop_id) {
      shopClause = ' AND r.shop_id = @shop_id';
      params.shop_id = filters.shop_id;
    }

    // NOTE: line-items with an OPEN fulfilment issue (out of production / model
    // unavailable) are held out of the purchasing Route — but that is enforced
    // per line in emitRow via the open-issue map, not here, so the order's other
    // products keep flowing.
    whereClause = `r.is_paid = 1 AND ${scopeClause}${shopClause}`;
  }

  // De-dupe linked manual orders. A manual order created from the Route tab has
  // BOTH a `receipts` row (so it shows in the Orders tab) AND one or more linked
  // `route_manual_items` sidecars (which carry each product's image + purchasing
  // detail and are merged in below). Excluding any receipt that has a sidecar
  // ensures such an order is emitted here via the sidecar merge — one row per
  // product — instead of once from receipts AND again from the sidecars.
  // Manual orders WITHOUT a sidecar (created directly in the Orders tab) have
  // no matching row and still flow through.
  whereClause = `(${whereClause}) AND r.receipt_id NOT IN (SELECT receipt_id FROM route_manual_items)`;

  const receiptSql = (scopedWhere) => `
    SELECT r.receipt_id, r.shop_id, r.name AS buyer_name, r.buyer_email,
           r.buyer_user_id, r.message_from_buyer, r.team_note,
           r.shipping_country_iso, r.etsy_created_at, r.all_transactions,
           r.is_shipped, r.carrier_confirmed_at, r.shipment_notified_at,
           r.packaged_at,
           s.shop_name
    FROM receipts r
    JOIN shops s ON s.shop_id = r.shop_id
    WHERE ${scopedWhere}
    ORDER BY r.etsy_created_at ASC
  `;
  const rows = explicitReceiptIds
    ? queryScopeInChunks(
        db,
        explicitReceiptIds,
        (ph) => receiptSql(whereClause.replace('__receipt_scope__', ph)),
      ).sort((a, b) => Number(a.etsy_created_at || 0) - Number(b.etsy_created_at || 0))
    : db.prepare(receiptSql(whereClause)).all(params);

  // Parse each receipt's transaction JSON exactly once. The parsed lines are also
  // the source of truth for every downstream receipt/item/listing query scope.
  const parsedRows = rows.map((receipt) => {
    let transactions = [];
    try {
      const parsed = JSON.parse(receipt.all_transactions || '[]');
      if (Array.isArray(parsed)) transactions = parsed;
    } catch {}
    return { receipt, transactions };
  });

  // Manual sidecars are part of the working route and therefore part of the same
  // scopes. Preserve the existing explicit-empty and shop-filter semantics while
  // resolving them before any assignment/issue/image reads.
  const manualOnlyScope = filters.shop_id === MANUAL_SHOP_ID;
  const explicitReceiptScope =
    filters.receipt_id != null
      ? new Set([Number(filters.receipt_id)].filter(Number.isInteger))
      : (Array.isArray(filters.receipt_ids)
          ? new Set(filters.receipt_ids.map(Number).filter(Number.isInteger))
          : null);
  let manualItems = [];
  if (filters.include_manual !== false &&
      (!filters.shop_id || manualOnlyScope)) {
    try { manualItems = getManualItems(db); } catch { manualItems = []; }
    if (explicitReceiptScope) {
      manualItems = manualItems.filter((m) => explicitReceiptScope.has(Number(m.receipt_id)));
    }
  }

  // Pull linked manual-order receipt metadata in bounded batches. This keeps
  // Route-created manual rows equivalent to Etsy rows (buyer/notes/seal state).
  const manualOrderById = {};
  const manualReceiptIds = manualItems
    .map((m) => Number(m.receipt_id))
    .filter(Number.isInteger);
  try {
    queryScopeInChunks(
      db,
      manualReceiptIds,
      (ph) => `SELECT receipt_id, name, buyer_email, shipping_country_iso, etsy_created_at,
                      message_from_buyer, team_note, packaged_at
               FROM receipts WHERE receipt_id IN (${ph})`,
    ).forEach((r) => { manualOrderById[r.receipt_id] = r; });
  } catch { /* receipts may lack rows for legacy sidecars */ }

  const currentLines = [];
  for (const { receipt, transactions } of parsedRows) {
    for (const tx of transactions) {
      const title = String(tx?.title || '').trim();
      if (!title) continue;
      const listingId = toListingId(tx.listing_id);
      currentLines.push({
        receipt_id: Number(receipt.receipt_id),
        item_key: lineItemKey(title, tx.listing_id || null),
        title,
        listing_id: listingId,
      });
    }
  }
  for (const item of manualItems) {
    const title = String(item.title || '').trim();
    if (!title) continue;
    const listingId = toListingId(item.listing_id);
    currentLines.push({
      receipt_id: Number(item.receipt_id),
      item_key: item.item_key || lineItemKey(title, item.listing_id || null),
      title,
      listing_id: listingId,
    });
  }
  if (!currentLines.length) return [];

  const receiptIds = new Set(
    [...rows.map((r) => Number(r.receipt_id)), ...manualReceiptIds]
      .filter(Number.isInteger),
  );
  const itemKeys = new Set(currentLines.map((line) => line.item_key));

  // Saved per-order assignments, keyed by `${receipt_id}\x00${item_key}`.
  let assignMap = {};
  try {
    assignMap = getAllRouteAssignments(db, receiptIds);
  } catch { /* table may not exist yet on first run */ }

  // Open workflow state is receipt-scoped. Omitting a scope from these helpers
  // remains backward-compatible; the Route builder always supplies its finite set.
  const issueMap = getOpenIssueMap(db, receiptIds);
  const exchangeMap = getOpenExchangeMap(db, receiptIds);
  const substitutionMap = getSubstitutionMap(db, receiptIds);

  // A substitution changes both the effective product key/title and the listing
  // whose image/canonical identity must be loaded. Only substitutions attached to
  // a current line are allowed to widen those scopes.
  const listingIds = new Set();
  const orderedListingIds = new Set();
  const productDefaultKeys = new Set();
  const effectiveTitleNorms = new Set();
  const substitutionListingIds = new Set();
  for (const line of currentLines) {
    if (line.listing_id) {
      listingIds.add(line.listing_id);
      orderedListingIds.add(line.listing_id);
    }
    const sub = substitutionMap.get(`${line.receipt_id}\x00${line.item_key}`) || null;
    const productKey = productDefaultsKey(line.item_key, sub);
    if (productKey) productDefaultKeys.add(productKey);
    const effectiveTitle = sub ? (sub.new_title || line.title) : line.title;
    const titleNorm = normalizeTitle(effectiveTitle);
    if (titleNorm) effectiveTitleNorms.add(titleNorm);
    const subListingId = sub ? toListingId(sub.source_listing_id) : null;
    if (subListingId) {
      listingIds.add(subListingId);
      substitutionListingIds.add(subListingId);
    }
  }

  // `itemKeys` is deliberately derived even though receipt-scoping is sufficient
  // for per-order tables: it documents/guards the finite current-item collection
  // from which product-default keys above are computed.
  if (!itemKeys.size) return [];

  // Batch-load ordered/manual thumbnails first. Replacement listings are loaded
  // separately below to preserve the historical switch-image fallback: an empty
  // replacement cache row must not block listings.primary_image_url.
  const imageMap = {};
  queryScopeInChunks(
    db,
    orderedListingIds,
    (ph) => `SELECT listing_id, url FROM listing_images WHERE listing_id IN (${ph})`,
  ).forEach((row) => { imageMap[row.listing_id] = row.url; });

  // A switched listing may only exist in the canonical listings table. Never
  // widen this fallback to unrelated listings, and never fall back to the old
  // ordered design.
  const uncachedSubstitutionImages = [...substitutionListingIds]
    .filter((id) => !(id in imageMap));
  try {
    queryScopeInChunks(
      db,
      uncachedSubstitutionImages,
      (ph) => `SELECT listing_id, url FROM listing_images
               WHERE listing_id IN (${ph}) AND url IS NOT NULL AND url <> ''`,
    ).forEach((row) => {
      if (!(row.listing_id in imageMap)) imageMap[row.listing_id] = row.url;
    });
    const missingSubstitutionImages = [...substitutionListingIds]
      .filter((id) => !(id in imageMap));
    queryScopeInChunks(
      db,
      missingSubstitutionImages,
      (ph) => `SELECT listing_id, primary_image_url FROM listings
               WHERE listing_id IN (${ph})
                 AND primary_image_url IS NOT NULL AND primary_image_url <> ''`,
    ).forEach((row) => {
      if (!(row.listing_id in imageMap)) imageMap[row.listing_id] = row.primary_image_url;
    });
  } catch { /* best-effort: switched lines use their stored image_url */ }

  // Operator-supplied per-variant clarifying images.
  const styleImageMap = getListingStyleImageMap(db, listingIds);
  const variationImageMap = getListingVariationImageMap(db, listingIds);

  // Per-product defaults and Excel product aliases are exact item/title scopes.
  const productMap = getAllProductAssignments(db, productDefaultKeys);
  const excelProductMap = getProductMapByNorm(db, effectiveTitleNorms);

  // Charm code → supplier shop, from the charm library (Manage charms). This is
  // the SINGLE SOURCE OF TRUTH for a charm's supplier: the shop is a pure function
  // of the charm CODE. route_assignments / product_assignments only CACHE the shop
  // that was current when the charm was first assigned, so once the operator edits
  // a charm's supplier here, that cache is stale — resolving the shop from the
  // library (below) is what keeps the Route tab + Shopping page in sync with the
  // edit instead of showing the old shop/stall.
  const charmShopByCode = new Map();
  try {
    getCharmLibrary(db).forEach((c) => charmShopByCode.set(c.code, c.default_charm_shop || ''));
  } catch { /* charm_library may not exist before first seed */ }
  // Durable physical-product identity across Etsy shops/listing IDs. Generated
  // from near-identical primary product images and persisted in listing_phash.
  // Product Map carries the same key so Excel/catalog aliases remain linked.
  const canonicalByListing = new Map();
  try {
    queryScopeInChunks(
      db,
      listingIds,
      (ph) => `SELECT listing_id, canonical_key FROM listing_phash
               WHERE canonical_key IS NOT NULL AND listing_id IN (${ph})`,
    )
      .forEach(r => canonicalByListing.set(Number(r.listing_id), r.canonical_key));
  } catch { /* migration may not have run yet */ }
  // Listings an operator has explicitly declared "same product" via the 同款
  // control. Only ever consulted as a last resort for a SWITCHED line (see the
  // canonical-key chain below), where it is the sole trustworthy signal: nothing
  // derivable from a hand-typed custom switch can tell us what it really is.
  const operatorMergedListings = new Set();
  try {
    for (const column of ['listing_a', 'listing_b']) {
      queryScopeInChunks(
        db,
        orderedListingIds,
        (ph) => `SELECT listing_a, listing_b FROM product_merges WHERE ${column} IN (${ph})`,
      ).forEach((r) => {
        operatorMergedListings.add(Number(r.listing_a));
        operatorMergedListings.add(Number(r.listing_b));
      });
    }
  } catch { /* product_merges may not exist on an older install */ }

  // Optional supplier-catalog enrichment (read-only from the engine's
  // etsy_orders.db — vendored inside this dashboard, no external program).
  const cat = filters.enrich_supplier ? openOspCatalog(enginePaths.engineDir(config)) : null;
  const supplierCache = new Map();   // item_key → match result (titles repeat across orders)

  const out = [];

  /**
   * Build ONE route row from receipt-level `meta` + a resolved line `line`,
   * applying the full supplier/charm enrichment + saved-assignment merge, and
   * push it onto `out`. Shared by real Etsy transactions and manual items so
   * both behave identically in the dashboard and in route generation.
   *
   * @param {object} meta - { receipt_id, shop_id, shop_name, buyer_name,
   *   buyer_email, order_date, private_notes, team_note, country, packaged_at }
   * @param {object} line - { title, listing_id, quantity, phoneModel, style,
   *   styleValueId?, image_url, is_manual?, manual_id? }
   */
  function emitRow(meta, line) {
    const origTitle = (line.title || '').trim();
    if (!origTitle) return;

    // Listing-scoped key uniquely identifies this line-item's product, so two
    // different listings that share a 50-char title prefix never collide. It is
    // derived from the ORIGINAL title so a design switch keeps the same identity
    // (and its saved purchase status) rather than orphaning the assignment.
    const key = line.item_key || lineItemKey(origTitle, line.listing_id);

    // Apply a local design switch, if any: buy the replacement design instead of
    // the original. Title → supplier match, style → components, model/image ride
    // along. Never affects Etsy.
    const sub = substitutionMap.get(`${meta.receipt_id}\x00${key}`) || null;
    const title       = sub ? (sub.new_title || origTitle).trim() : origTitle;
    const phoneModel  = sub && sub.new_phone_model ? sub.new_phone_model : (line.phoneModel || '');
    const style       = sub && sub.new_style ? sub.new_style : (line.style || '');
    const comps       = styleComponents(style, { phoneModel, title });
    const titleNorm = normalizeTitle(title);
    // Photo of the REPLACEMENT design on a switched line — never the original the
    // buyer moved away from. See resolveSwitchedLineImage for the full priority
    // chain and why it has no fallback to the original.
    const switchedImage = sub
      ? resolveSwitchedLineImage(sub, (id) => imageMap[id] || null)
      : null;

    // The Etsy listing this line is actually BOUGHT as, which is NOT the same
    // question as `listing_id` (the listing the buyer ORDERED). A catalog design
    // switch buys the replacement listing; a custom switch buys something that has
    // no listing at all. Conflating the two is what made the mobile shopping route
    // show the ORIGINAL design for a switched line: it re-proxied the photo through
    // /api/route/listing-image/<listing_id>, which is the design the buyer left.
    //
    // Every consumer that means "the PRODUCT" rather than "the ORDER" — its photo,
    // its cached image bytes, its perceptual identity — must key off this. Only
    // consumers that mean the order itself (the Etsy link, 同款 merge edges, the
    // line's saved purchase status) may keep using `listing_id`.
    const productListingId = sub ? toListingId(sub.source_listing_id) : toListingId(line.listing_id);

    const saved    = assignMap[`${meta.receipt_id}\x00${key}`] || {};
    // Per-product saved defaults (supplier / charm). On a SWITCHED line these
    // must describe the REPLACEMENT design we will actually buy — never the
    // original line, whose key still holds the ORIGINAL product's saved
    // supplier/charm. Reading them under the original key here was the SOLE
    // reason a design switch updated the title + image yet left the OLD supplier
    // name / stall in place: product_assignments outranks the (correctly
    // re-keyed) Excel map + catalog match in the priority chain below.
    // productDefaultsKey re-keys catalog switches onto the replacement and
    // returns null for custom uploads (which have no catalog default).
    const productDefKey = productDefaultsKey(key, sub);
    const product  = (productDefKey && productMap[productDefKey]) || {};
    const excelPM  = excelProductMap.get(titleNorm) || {};
    // A retired catalog row is a deliberate tombstone, not a missing mapping.
    // It suppresses product defaults and the legacy OSP fallback so deleting a
    // discontinued design cannot silently keep sending shoppers to the old
    // supplier. Per-order overrides remain valid because they are an explicit
    // decision for that one order.
    const catalogRetired = excelPM.status === 'retired';
    // Canonical physical-product identity — the key the shopping view uses to MERGE
    // order lines into a single product card. It MUST describe the product we will
    // actually BUY.
    //
    // For a SWITCHED line that product is the REPLACEMENT design, NOT the originally
    // ordered listing. Deriving it from the original `line.listing_id` (as an
    // unswitched line does) makes the switched line inherit the ORIGINAL design's
    // canonical key, so it merges into the wrong product card — the switched design
    // then shows other designs' models (and vice-versa) in the shopping route. So a
    // switched line takes its identity from the replacement instead:
    //   • catalog switch → the replacement listing's canonical (via source_listing_id),
    //   • else (custom upload, or no canonical on file) → the Excel map keyed by the
    //     switched title, and finally '' so it merges by its switched title downstream.
    // `excelPM` is already keyed by the effective (switched) title, so it's correct
    // for both branches; only the listing-derived lookup must avoid the original.
    //
    // LAST RESORT for a switch, and ONLY once an operator has pressed 同款 on the
    // card: adopt the original listing's canonical key. A custom switch is a
    // hand-typed title over an uploaded photo, so it has no source listing and is
    // deliberately never title-matched against the catalog — leaving it with no
    // identity at all and stranding it on a card of its own even when the operator
    // has just declared it the same product as the stall's other card. The merge
    // is recorded against the listing id the line still carries, which is why that
    // id is the right one to read. The gate is what keeps the original bug dead:
    // WITHOUT an explicit merge a switched line must never inherit the identity of
    // the design it was switched away FROM, or it lands on that product's card and
    // the shopper buys the wrong thing.
    const canonicalProductKey = sub
      ? ((sub.source_listing_id != null && canonicalByListing.get(Number(sub.source_listing_id)))
          || excelPM.canonical_product_key
          || (operatorMergedListings.has(Number(line.listing_id)) && canonicalByListing.get(Number(line.listing_id)))
          || '')
      : (canonicalByListing.get(Number(line.listing_id))
          || excelPM.canonical_product_key
          || '');

    // Durably removed lines drop out of the dashboard AND route generation
    // entirely. They are only materialised when the caller explicitly asks for
    // them (the "Show removed" view), so the operator can review / restore.
    const isDismissed = !!saved.dismissed_at;
    if (isDismissed && !filters.include_dismissed) return;

    // Open fulfilment issue (out of production / model unavailable). Such a line
    // is held out of purchasing entirely — buying it would waste money on a
    // product the buyer may cancel or swap. Materialised only when the caller
    // opts in (e.g. an audit view), and always tagged so the UI can flag it.
    //
    // CRITICAL SAFETY NET: a line the operator has SWITCHED to a new design must
    // never be silently withheld by a stale hold. A switch is an explicit "buy
    // this replacement instead" decision, so when it is at least as recent as the
    // issue (see substitutionSupersedesIssue) it CLEARS the hold and the line
    // flows into the route as the replacement. Without this, a switched line
    // whose issue was left open (legacy data, a re-raise, or a resolve that never
    // ran) drops out of the shopping route entirely — the buyer's item is missed.
    const rawIssue = issueMap.get(`${meta.receipt_id}\x00${key}`) || null;
    const issue = substitutionSupersedesIssue(sub, rawIssue) ? null : rawIssue;
    if (issue && !filters.include_issues) return;

    // Open wrong-model exchange for this line (we hold it, but in the wrong model).
    // It stays visible but is flagged so callers can hold it out of the buy set and
    // route it into the "To exchange" bucket instead.
    const exchange = exchangeMap.get(`${meta.receipt_id}\x00${key}`) || null;

    // A CUSTOM design switch is a product that is NOT in our catalog (the operator
    // uploaded a photo + typed a title after the buyer agreed to switch). Its title
    // must therefore NOT be title-matched against the supplier catalog / product map
    // — a fuzzy match would attach the wrong stall. Force it UNMATCHED so it lands in
    // the "unmatched" bucket for the operator to source (ask around) and fill in.
    // A catalog switch, by contrast, IS a real catalog product and keeps matching.
    // The operator's own saved supplier override (route_assignments) is always kept.
    const isCustomSub = !!(sub && sub.source === 'custom');

    let supplier = null;
    if (cat && !isCustomSub && !catalogRetired) {
      // Supplier match is purely a function of the title — cache by title key.
      const catKey = titleNorm;
      if (!supplierCache.has(catKey)) supplierCache.set(catKey, matchSupplier(cat, title));
      supplier = supplierCache.get(catKey);
    }

    // Priority chain for supplier (highest → lowest):
    //   1. Per-order manual override  (route_assignments.supplier_*_override)
    //   2. Per-product user save      (product_assignments.supplier_*)   [skipped for custom]
    //   3. Excel Product Map          (product_map.shop_name / stall)    [skipped for custom]
    //   4. OSP catalog exact match    (etsy_orders.db catalog)           [skipped for custom]
    const useCatalogDefaults = !isCustomSub && !catalogRetired;
    const shopOvr  = saved.supplier_shop_override  || (useCatalogDefaults ? (product.supplier_shop  || excelPM.shop_name) : '') || '';
    const stallOvr = saved.supplier_stall_override || (useCatalogDefaults ? (product.supplier_stall || excelPM.stall) : '')     || '';
    const isOverride = !!(saved.supplier_shop_override || saved.supplier_stall_override ||
                          (useCatalogDefaults && (product.supplier_shop || product.supplier_stall)));
    if (shopOvr || stallOvr) {
      const effectiveStall = stallOvr || (supplier?.stall || '');
      supplier = {
        shop_name:   shopOvr  || (supplier?.shop_name || ''),
        stall:       effectiveStall,
        floor:       stallFloor(effectiveStall),
        price:       supplier?.price      || '',
        charm_shop:  (useCatalogDefaults ? excelPM.charm_shop : '') || supplier?.charm_shop || '',
        charm_code:  (useCatalogDefaults ? excelPM.charm_code : '') || supplier?.charm_code || '',
        match_score: 100,
        in_catalog:  true,
        is_override: isOverride,
      };
    }

    // Priority chain for charm.
    //
    // CONFIRMED (user-set only) — these populate `charm_code` and are treated as
    // "assigned".  The "Needs charm" filter and the summary's charms_assigned count
    // rely on this field being empty when no human has made an explicit decision:
    //   1. Per-order save      (route_assignments.charm_code)   highest priority
    //   2. Per-product default (product_assignments.charm_code) user set this deliberately
    //
    // SUGGESTIONS ONLY — populated into `suggested_charm_code` so the operator sees
    // a pre-filled hint and can accept or override without it silently counting as done:
    //   3. Excel Product Map  (product_map.charm_code)   bulk-import; needs confirmation
    //   4. OSP catalog match  (supplier.charm_code)      auto-matched; needs confirmation
    //
    // Keeping catalog data out of charm_code ensures "Needs charm" always surfaces
    // every item that still requires a conscious operator decision.
    const effectiveCharmCode = saved.charm_code || (useCatalogDefaults ? product.charm_code : '') || '';
    // The charm's supplier SHOP follows its CODE via the charm library — the single
    // source of truth — NOT the per-order/per-product snapshot. Trusting the stored
    // snapshot was the bug: after editing a charm's supplier in Manage charms, the
    // already-assigned order lines (Route tab) and the Shopping page kept showing the
    // OLD shop (and therefore the old stall, which is derived from the shop name).
    // When the confirmed code is known to the library we take the library's shop
    // (even when intentionally blank); only a code the library doesn't recognise
    // (legacy / hand-typed) falls back to the stored snapshot.
    const effectiveCharmShop = (effectiveCharmCode && charmShopByCode.has(effectiveCharmCode))
      ? charmShopByCode.get(effectiveCharmCode)
      : (saved.charm_shop || (useCatalogDefaults ? product.charm_shop : '') || '');

    // ── Derived shopping-completion state ─────────────────────────────────────
    // A line is "fully purchased" once EVERY component it actually has (case /
    // grip / charm) is marked Purchased. Such a line needs no further shopping,
    // so the dashboard drops it out of the "to shop" headline counts and the
    // active queue (purely a derived view — the row is never destructively
    // excluded, so route generation, the ready-to-ship report and history keep
    // seeing it). Out of Stock / Out of Production are deliberately NOT treated
    // as purchased: those still warrant operator attention.
    const statusCase  = saved.status_case  || DEFAULT_STATUS;
    const statusGrip  = saved.status_grip  || DEFAULT_STATUS;
    const statusCharm = saved.status_charm || DEFAULT_STATUS;
    const fullyPurchased = rowFullyPurchased({
      has_case:  comps.hasCase,  has_grip:  comps.hasGrip,  has_charm:  comps.hasCharm,
      status_case: statusCase,   status_grip: statusGrip,   status_charm: statusCharm,
    });

    // ── Derived sourcing state ────────────────────────────────────────────────
    // Does this line still need someone to tell us WHERE to buy it? Either
    // nothing is recorded (not in the catalog, no manual entry) or a shopper
    // stood at the recorded stall and found it wrong. Both leave the same gap,
    // so both feed the "unmatched" bucket and the Export-images request.
    const sourcingRow = {
      has_case:  comps.hasCase,  has_grip:  comps.hasGrip,  has_charm:  comps.hasCharm,
      status_case: statusCase,   status_grip: statusGrip,   status_charm: statusCharm,
      supplier_in_catalog:  supplier ? supplier.in_catalog : false,
      supplier_is_override: supplier ? !!supplier.is_override : false,
    };
    const wrongStallComps = sourcing.wrongStallComponents(sourcingRow);
    const sourcingReason = sourcing.sourcingReason(sourcingRow);

    // Per-variant image: operator Fix Image, then Etsy Styles variation photo,
    // then the listing hero. Skipped when the line was switched to another
    // design — that product is a different item and carries its own image.
    const styleImg = (!sub && line.listing_id)
      ? (lookupStyleKeyed(styleImageMap, line.listing_id, style) || null)
      : null;
    const variationImg = (!sub && line.listing_id)
      ? lookupVariationImage(variationImageMap, line.listing_id, {
          valueId: line.styleValueId != null ? line.styleValueId : null,
          style,
        })
      : null;

    out.push({
      receipt_id:  meta.receipt_id,
      item_key:    key,
      shop_id:     meta.shop_id,
      shop_name:   meta.shop_name || meta.shop_id,
      buyer_name:  meta.buyer_name || '',
      buyer_email: meta.buyer_email || '',
      order_date:  meta.order_date || null,
      private_notes: meta.private_notes || '',
      team_note:   meta.team_note || '',
      country:     meta.country || '',
      // The listing the BUYER ORDERED. Stays put across a design switch so the
      // line keeps its saved purchase status, its Etsy link and its 同款 merge
      // edges. To address the product actually being BOUGHT, use
      // `product_listing_id` — after a switch they are different listings.
      listing_id:  line.listing_id || null,
      // The listing this line is BOUGHT as: the replacement after a catalog
      // design switch, else the ordered listing, else null (a custom switch is
      // not a catalog product at all). This is the id to use for the product's
      // photo, its cached image bytes and its perceptual identity.
      product_listing_id: productListingId,
      product_key: canonicalProductKey,
      title,
      quantity:    line.quantity || 1,
      // The model the BUYER ordered — kept verbatim as the audit trail of what
      // the order says, even once a model fix supersedes it.
      phone_model: phoneModel,
      // The model to actually BUY and PACK. Identical to `phone_model` unless an
      // open model fix corrects it, in which case every human-facing surface
      // must use this one or the wrong case gets bought/packed all over again.
      shopping_model: exchange
        ? (String(exchange.need_model || '').trim() || phoneModel)
        : phoneModel,
      style,
      // A SWITCHED line's image was fully resolved above (replacement upload /
      // CDN / source-listing thumbnail, or null for a neutral placeholder); it
      // must NEVER fall back to imageMap[line.listing_id] — that is the ORIGINAL
      // design the buyer moved away from ("same old case"). Only an UNSWITCHED
      // line uses the per-variant override → Etsy style photo → listing hero chain.
      image_url:   sub
        ? switchedImage
        : resolveUnswitchedLineImage({
            styleImg,
            variationUrl: variationImg
              ? variationImageApiUrl(
                  line.listing_id,
                  variationImg.style_value || style,
                  variationImg.cached_at,
                )
              : null,
            listingUrl: line.image_url != null
              ? line.image_url
              : (line.listing_id ? (imageMap[line.listing_id] || null) : null),
          }),
      has_case:    comps.hasCase,
      has_grip:    comps.hasGrip,
      has_charm:   comps.hasCharm,
      // The charm is INTEGRAL to the product (ships attached, shown in the
      // product photo) rather than a separately-sourced charm. True only for
      // AirPods cases that carry a charm — for those the charm needs no code /
      // image / charm-stall and is shopped alongside the case, exactly like a
      // grip is for a phone case. Consumed by the Route tab (charm column) and
      // the mobile Shopping view; empty on every phone-case line.
      charm_integral: comps.hasCharm && isAirpodsProduct(phoneModel, title),
      // Which device family this line belongs to. Lets the model-fix UI offer
      // AirPods generations on an AirPods line (or band sizes on a watch line,
      // and refuse an iPhone model on either) without every client re-deriving
      // the classification.
      device_family: productTypes.deviceFamilyOf(phoneModel, title),
      charm_code:  effectiveCharmCode,
      charm_shop:  effectiveCharmShop,
      status_case:  statusCase,
      status_grip:  statusGrip,
      status_charm: statusCharm,
      excluded:    saved.excluded ? 1 : 0,
      // Durably removed from the dashboard (see setRouteDismissed). Only present
      // in the result when filters.include_dismissed was requested.
      dismissed:    isDismissed ? 1 : 0,
      dismissed_at: saved.dismissed_at || null,
      // Open fulfilment issue (only present when filters.include_issues was set,
      // since open-issue lines are otherwise withheld from the route entirely).
      has_issue:    issue ? 1 : 0,
      issue_id:     issue ? issue.id : null,
      issue_type:   issue ? issue.issue_type : null,
      // True when every component this line has is Purchased — the line is done
      // shopping. Used by the dashboard to drop it from the "to shop" counts and
      // the active queue without ever altering the underlying assignment.
      fully_purchased: fullyPurchased,
      // Open model fix. Two shapes (see exchangeIntent): SWAP — we hold the item
      // in the wrong model and carry it back to the stall, so it is held out of
      // the buy set and surfaced in the "To exchange" bucket; BUY — we hold
      // nothing and must purchase the corrected model, so the line stays in the
      // normal buy set with `shopping_model` naming what to actually get.
      needs_exchange:        !!exchange,
      exchange_id:           exchange ? exchange.id : null,
      exchange_intent:       exchangeRecordIntent(exchange),
      exchange_have_model:   exchange ? (exchange.have_model || '') : '',
      exchange_need_model:   exchange ? (exchange.need_model || phoneModel || '') : '',
      exchange_components:   exchange ? (exchange.components || '') : '',
      exchange_supplier_shop:  exchange ? (exchange.supplier_shop || '') : '',
      exchange_supplier_stall: exchange ? (exchange.supplier_stall || '') : '',
      exchange_note:         exchange ? (exchange.note || '') : '',
      // Local design switch — this line is being purchased as a replacement
      // design the buyer agreed to (never reflected on Etsy). The title/style/
      // model/image above already reflect the switched product.
      substituted:      !!sub,
      substitution_id:  sub ? sub.id : null,
      substituted_from: sub ? (sub.original_title || origTitle) : '',
      // Manual (operator-created) line-item markers — used by the UI to show a
      // badge and route deletion through the manual-order endpoint.
      is_manual:   !!line.is_manual,
      manual_id:   line.manual_id != null ? line.manual_id : null,
      // Pre-transit indicator — label created within pre_transit_days and carrier
      // has not yet scanned the parcel. False for manual items (no Etsy shipment).
      is_pre_transit: meta.is_pre_transit || false,
      label_days_ago: meta.label_days_ago || 0,
      packaged_at:   meta.packaged_at || null,
      // Supplier match (from OSP catalog) — null when enrichment is off.
      supplier_shop:        supplier ? supplier.shop_name : '',
      supplier_stall:       supplier ? supplier.stall : '',
      supplier_floor:       supplier ? supplier.floor : null,
      supplier_price:       supplier ? supplier.price : '',
      supplier_in_catalog:  supplier ? supplier.in_catalog : false,
      supplier_match_score: supplier ? supplier.match_score : 0,
      supplier_is_override: supplier ? !!supplier.is_override : false,
      catalog_status: catalogRetired ? 'retired' : (excelPM.status || ''),
      // Sourcing gap (see src/route/sourcing.js). `needs_sourcing` is what the
      // "unmatched" filter, the summary pill and the Export-images ZIP all key
      // on; `sourcing_reason` says whether nothing is recorded or the recorded
      // stall was found wrong, and `wrong_stall_components` names the pieces the
      // shopper flagged so a re-sourcing request can be specific.
      needs_sourcing:       !!sourcingReason,
      sourcing_reason:      sourcingReason || '',
      wrong_stall_components: wrongStallComps.join(','),
      // Catalog's suggested charm — Excel Product Map first, then OSP catalog.
      // Suppressed for custom switches (no catalog record to suggest from).
      suggested_charm_code: useCatalogDefaults ? (excelPM.charm_code || (supplier ? supplier.charm_code : '')) : '',
      suggested_charm_shop: useCatalogDefaults ? (excelPM.charm_shop || (supplier ? supplier.charm_shop : '')) : '',
    });
  }

  // Pre-transit detection — mirrors the same logic used by GET /api/orders and
  // the Orders tab UI (shipment_notified_at within the pre_transit_days window,
  // carrier has not yet confirmed arrival).
  const preTransitDays = config.pre_transit_days ?? 30;
  const routeNowSec    = Math.floor(Date.now() / 1000);
  const preTransitCutoff = routeNowSec - preTransitDays * 24 * 3600;

  for (const { receipt: r, transactions: txs } of parsedRows) {
    const labelCreatedAt  = r.shipment_notified_at || 0;
    const isPreTransit    = !!(r.is_shipped && labelCreatedAt > preTransitCutoff && !r.carrier_confirmed_at);
    const labelDaysAgo    = labelCreatedAt ? (routeNowSec - labelCreatedAt) / 86400 : 0;

    const meta = {
      receipt_id:    r.receipt_id,
      shop_id:       r.shop_id,
      shop_name:     r.shop_name || r.shop_id,
      buyer_name:    r.buyer_name || '',
      buyer_email:   r.buyer_email || '',
      order_date:    r.etsy_created_at || null,
      private_notes: r.message_from_buyer || '',
      team_note:     r.team_note || '',
      country:       r.shipping_country_iso || '',
      is_pre_transit: isPreTransit,
      label_days_ago: labelDaysAgo,
      packaged_at:   r.packaged_at || null,
    };

    for (const t of txs) {
      const title = (t.title || '').trim();
      if (!title) continue;
      const { phoneModel, style } = parseVariations(t.variations);
      emitRow(meta, {
        title,
        listing_id: t.listing_id || null,
        quantity:   t.quantity || 1,
        phoneModel,
        style,
        styleValueId: parseStyleValueId(t.variations),
      });
    }
  }

  // ── Manual (operator-created) line-items ──────────────────────────────────
  // These persist server-side and are always part of the working route set
  // (they bypass the date/shop/pending scope — they're deliberate additions).
  // Suppressed / narrowed in two situations:
  //   1. An explicit-receipt scope (single receipt_id, or a receipt_ids set) is
  //      active. We STILL surface manual items, but ONLY those belonging to the
  //      requested receipts — so an explicit lookup sees the manual line instead
  //      of coming up empty. (This is what lets a wrong-model exchange on a
  //      MANUAL order resolve its supplier, and lets GET /api/route/order/:id add
  //      a manual order. Previously ANY receipt scope skipped manual items
  //      wholesale, so a manual-order exchange lost its supplier and fell into
  //      "Supplier not set".)
  //   2. A REAL shop_id filter is active — manual items carry no shop_id so they
  //      would bleed into every filtered shop view, creating noise. When the
  //      operator selects a specific shop they want to see only that shop's
  //      Etsy orders, not unrelated manual entries from other shopping sessions.
  //      The synthetic __manual__ shop is the ONE exception: selecting it means
  //      "show manual orders only", so the sidecars must be emitted (this is what
  //      makes Route-created manual orders visible under the "Manual orders"
  //      filter — their receipt is de-duped out above and re-emitted here).
  for (const m of manualItems) {
    const linked = manualOrderById[m.receipt_id] || null;
    const linkedName = (linked?.name && linked.name !== 'Manual order') ? linked.name : '';
    emitRow({
      receipt_id:    m.receipt_id,
      shop_id:       '',
      shop_name:     m.shop_name || 'Manual entry',
      buyer_name:    linkedName || 'Manual entry',
      buyer_email:   linked?.buyer_email || '',
      order_date:    linked?.etsy_created_at || m.created_at || null,
      private_notes: linked?.message_from_buyer || '',
      team_note:     linked?.team_note || '',
      country:       linked?.shipping_country_iso || '',
      // Sidecars bypass the receipts query above, so the sealed stamp has to be
      // carried over from the linked manual order explicitly. Without it every
      // manual row reads "not packaged" and an already-boxed manual order keeps
      // showing up as shopping work (notably on the "Charms to buy" list).
      // Legacy sidecars with no linked receipt stay null, as before.
      packaged_at:   linked?.packaged_at || null,
    }, {
      title:      m.title,
      item_key:   m.item_key,
      listing_id: m.listing_id || null,
      quantity:   m.quantity || 1,
      phoneModel: m.phone_model || '',
      style:      m.style || '',
      // Catalog picks store a CDN url; custom uploads are served from our
      // own endpoint. Fall back to the cached listing image when neither set.
      image_url:  m.image_url
        ? m.image_url
        // Content-addressed (see substitution image): busts the mobile
        // service-worker cache when a manual order's photo is replaced.
        : (m.has_image_data ? `/api/route/manual-image/${m.id}?v=${m.updated_at || m.created_at || 0}` : (m.listing_id ? (imageMap[m.listing_id] || null) : null)),
      is_manual:  true,
      manual_id:  m.id,
    });
  }

  return out;
}

/**
 * Build the active product picker shared by Add Order and Design Switch.
 *
 * `product_map` is the membership authority: adding/reactivating a catalog row
 * makes it available and retiring it removes it from every active picker.
 * Order history enriches those products with observed models/styles and order
 * counts, but can never resurrect a discontinued design.
 *
 * Canonical aliases are collapsed into one physical-product card, matching the
 * Route Product Catalog. Completed orders remain untouched in receipts.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ products: Array<object>, phone_models: string[], styles: string[] }}
 */
function buildProductCatalog(db) {
  const shopName = new Map();
  try {
    db.prepare('SELECT shop_id, shop_name FROM shops').all()
      .forEach(s => shopName.set(String(s.shop_id), s.shop_name || s.shop_id));
  } catch {}

  const historyByTitle = new Map();
  const allModels = new Set();
  const allStyles = new Set();
  let recs = [];
  try {
    recs = db.prepare(
      "SELECT shop_id, all_transactions FROM receipts WHERE all_transactions IS NOT NULL AND all_transactions <> ''"
    ).all();
  } catch { recs = []; }

  for (const rec of recs) {
    let txs = [];
    try { txs = JSON.parse(rec.all_transactions || '[]'); } catch { continue; }
    if (!Array.isArray(txs)) continue;
    for (const tx of txs) {
      const title = String(tx.title || '').trim();
      const titleNorm = normalizeTitle(title);
      if (!titleNorm) continue;
      const { phoneModel, style } = parseVariations(tx.variations);
      if (phoneModel) allModels.add(phoneModel);
      if (style) allStyles.add(style);

      let item = historyByTitle.get(titleNorm);
      if (!item) {
        item = {
          phone_models: new Set(),
          styles: new Set(),
          listing_counts: new Map(),
          shop_counts: new Map(),
          shop_id_counts: new Map(),
          order_count: 0,
        };
        historyByTitle.set(titleNorm, item);
      }
      if (phoneModel) item.phone_models.add(phoneModel);
      if (style) item.styles.add(style);
      const listingId = tx.listing_id != null && Number.isSafeInteger(Number(tx.listing_id))
        ? Number(tx.listing_id)
        : null;
      if (listingId) item.listing_counts.set(listingId, (item.listing_counts.get(listingId) || 0) + 1);
      const etsyShop = shopName.get(String(rec.shop_id)) || String(rec.shop_id || '');
      if (etsyShop) item.shop_counts.set(etsyShop, (item.shop_counts.get(etsyShop) || 0) + 1);
      if (rec.shop_id) item.shop_id_counts.set(String(rec.shop_id), (item.shop_id_counts.get(String(rec.shop_id)) || 0) + 1);
      item.order_count += 1;
    }
  }

  const mostUsed = (counts) => {
    let best = null, bestCount = -1;
    for (const [value, count] of counts || []) {
      if (count > bestCount) { best = value; bestCount = count; }
    }
    return best;
  };

  let resolver;
  try { resolver = buildCatalogImageResolver(db); }
  catch { resolver = { resolve: () => null }; }

  const candidates = getProductMap(db)
    .map(row => {
      const observed = historyByTitle.get(row.title_norm);
      const image = resolver.resolve(row.title_norm, row.title);
      // All three visual catalog surfaces follow the same contract: a selectable
      // product needs a photo. The row remains active in product_map and can be
      // fixed without manufacturing a misleading placeholder design.
      if (!image || !image.url) return null;
      const exactListingId = !image.approx && image.listing_id ? Number(image.listing_id) : null;
      const observedListingId = observed ? mostUsed(observed.listing_counts) : null;
      const supplierIdentity = encodeURIComponent(stallLocation.supplierIdentityKey(row.shop_name, row.stall));
      return {
        // A canonical physical product can legitimately have more than one
        // supplier offer. Keep each booth separate so the picker never displays
        // one supplier while exact-title route resolution uses another.
        key: row.canonical_product_key
          ? `C:${row.canonical_product_key}:S:${supplierIdentity}`
          : `P:${row.id}`,
        catalog_id: Number(row.id),
        canonical_product_key: row.canonical_product_key || '',
        listing_id: exactListingId || observedListingId || null,
        title: row.title || '',
        title_norm: row.title_norm,
        shop_name: row.shop_name || '',
        stall: row.stall || '',
        charm_shop: row.charm_shop || '',
        charm_code: row.charm_code || '',
        shop_id: observed ? (mostUsed(observed.shop_id_counts) || '') : '',
        etsy_shop_name: observed ? (mostUsed(observed.shop_counts) || '') : '',
        image_url: image.url,
        image_approx: !!image.approx,
        phone_models: observed ? new Set(observed.phone_models) : new Set(),
        styles: observed ? new Set(observed.styles) : new Set(),
        order_count: observed ? observed.order_count : 0,
        sort_order: Number.isFinite(Number(row.sort_order)) ? Number(row.sort_order) : Number.MAX_SAFE_INTEGER,
      };
    })
    .filter(Boolean);

  const byPhysicalProduct = new Map();
  for (const product of candidates) {
    if (!byPhysicalProduct.has(product.key)) byPhysicalProduct.set(product.key, []);
    byPhysicalProduct.get(product.key).push(product);
  }

  const products = [];
  for (const aliases of byPhysicalProduct.values()) {
    aliases.sort((a, b) =>
      Number(a.image_approx) - Number(b.image_approx)
      || Number(!a.listing_id) - Number(!b.listing_id)
      || b.order_count - a.order_count
      || a.sort_order - b.sort_order
      || a.title.localeCompare(b.title));
    const representative = aliases[0];
    const models = new Set();
    const styles = new Set();
    for (const alias of aliases) {
      alias.phone_models.forEach(value => models.add(value));
      alias.styles.forEach(value => styles.add(value));
    }
    const loc = stallLocation.parseStall(representative.stall);
    products.push({
      key: representative.key,
      catalog_id: representative.catalog_id,
      catalog_ids: aliases.map(alias => alias.catalog_id),
      canonical_product_key: representative.canonical_product_key,
      listing_id: representative.listing_id,
      title: representative.title,
      alias_titles: aliases.map(alias => alias.title),
      listing_count: aliases.length,
      shop_name: representative.shop_name,
      stall: representative.stall,
      supplier_shop: representative.shop_name,
      supplier_stall: representative.stall,
      charm_shop: representative.charm_shop,
      charm_code: representative.charm_code,
      shop_id: representative.shop_id,
      etsy_shop_name: representative.etsy_shop_name,
      image_url: representative.image_url,
      image_approx: representative.image_approx,
      phone_models: [...models].sort(),
      styles: [...styles].sort(),
      order_count: aliases.reduce((sum, alias) => sum + alias.order_count, 0),
      location: {
        building_id: loc.buildingId,
        building_label: loc.buildingLabel,
        floor: loc.floor === 999 ? null : loc.floor,
        located: loc.located,
      },
    });
  }

  products.sort((a, b) => {
    const ak = stallLocation.locationSortKey(a.stall, a.shop_name);
    const bk = stallLocation.locationSortKey(b.stall, b.shop_name);
    return ak < bk ? -1 : ak > bk ? 1 : a.title.localeCompare(b.title);
  });

  return {
    products,
    phone_models: [...allModels].sort(),
    styles: [...allStyles].sort(),
  };
}

// ─── Supplier catalog matching (parity with OSP) ──────────────────────────────
//
// OSP stores the supplier catalog (product_title → supplier shop_name + stall,
// price, suggested charm) in etsy_orders.db (`catalog` table + `catalog_fts`
// FTS5 trigram index) plus a `charm_shops` table mapping charm shop → stall.
//
// We open that DB read-only and reproduce OSP's match pipeline:
//   1. FTS5 trigram pre-filter (catalog_fts MATCH, BM25 order) — same query.
//   2. Re-rank candidates with token_sort_ratio (== rapidfuzz fuzz.ratio on
//      alphabetically-sorted tokens), keeping titles scoring >= MATCH_THRESHOLD.
//   3. O(N) fallback scan when FTS yields no candidates.
//
// fuzz.ratio is the normalized Indel similarity: 2*LCS/(len_a+len_b)*100.

/** Longest common subsequence length (character level). */
function _lcsLen(a, b) {
  const la = a.length, lb = b.length;
  if (la === 0 || lb === 0) return 0;
  let prev = new Array(lb + 1).fill(0);
  let curr = new Array(lb + 1).fill(0);
  for (let i = 1; i <= la; i++) {
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      curr[j] = ca === b.charCodeAt(j - 1)
        ? prev[j - 1] + 1
        : (prev[j] >= curr[j - 1] ? prev[j] : curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[lb];
}

/** rapidfuzz fuzz.ratio: 2*LCS/(len_a+len_b)*100. */
function _ratio(a, b) {
  const tot = a.length + b.length;
  if (tot === 0) return 100;
  return (2 * _lcsLen(a, b) / tot) * 100;
}

/** rapidfuzz fuzz.token_sort_ratio: ratio() on whitespace-sorted tokens. */
function _tokenSortRatio(a, b) {
  const sortToks = (s) => s.split(/\s+/).filter(Boolean).sort().join(' ');
  return _ratio(sortToks(a), sortToks(b));
}

/**
 * Parse the floor number from a stall code. Delegates to the shared stall
 * parser so the floor a route row carries is the same one Shopping Mode, the
 * desktop catalog and the Excel export derive — including for stalls in the
 * other markets we shop, whose code is prefixed with the building name.
 */
const stallFloor = stallLocation.stallFloor;

// Cached read-only handle + in-memory catalog snapshot, keyed by db path+mtime.
let _ospCatalog = null;  // { dbPath, mtimeMs, db, entries:[{id,norm,...}], byNorm:Map }

/**
 * Open OSP's etsy_orders.db (read-only) and snapshot the catalog for matching.
 * Returns null if the DB is absent. Re-reads when the file changes on disk.
 * @param {string} ospDir
 */
function openOspCatalog(ospDir) {
  if (!ospDir) return null;
  const dbPath = path.join(ospDir, 'data', 'etsy_orders.db');
  let stat;
  try { stat = fs.statSync(dbPath); } catch { return null; }

  if (_ospCatalog && _ospCatalog.dbPath === dbPath && _ospCatalog.mtimeMs === stat.mtimeMs) {
    return _ospCatalog;
  }
  try {
    if (_ospCatalog?.db) { try { _ospCatalog.db.close(); } catch {} }
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });

    const charmShopStall = {};
    try {
      db.prepare('SELECT shop_name, stall FROM charm_shops').all()
        .forEach(r => { charmShopStall[r.shop_name] = r.stall || ''; });
    } catch {}

    const rows = db.prepare(
      'SELECT id, product_title, shop_name, stall, price, charm_shop, charm_code FROM catalog'
    ).all();
    const entries = rows.map(r => ({
      id: r.id,
      norm: normalizeTitle(r.product_title),
      shop_name: r.shop_name || '',
      stall: r.stall || '',
      price: r.price || '',
      charm_shop: r.charm_shop || '',
      charm_code: r.charm_code || '',
    }));
    const byNorm = new Map();
    entries.forEach(e => byNorm.set(e.norm, e));   // last wins (matches OSP)

    let ftsOk = true;
    try { db.prepare('SELECT 1 FROM catalog_fts LIMIT 1').get(); } catch { ftsOk = false; }

    _ospCatalog = { dbPath, mtimeMs: stat.mtimeMs, db, entries, byNorm, charmShopStall, ftsOk };
    return _ospCatalog;
  } catch {
    return null;
  }
}

/**
 * Close and forget the cached read-only handle on the engine's etsy_orders.db.
 *
 * The dashboard keeps a long-lived read-only connection to the engine database
 * for fast supplier matching. In WAL mode a live reader prevents the database
 * from checkpointing its write-ahead log back into the main file, so when the
 * Python generator rewrites the order cache the WAL can grow without bound and
 * slow every query. Call this immediately before spawning the generator so it
 * has exclusive access to compact the WAL; the next match request transparently
 * re-opens the handle (it is lazy + mtime-cached).
 */
function closeOspCatalog() {
  if (_ospCatalog?.db) {
    try { _ospCatalog.db.close(); } catch { /* already closed */ }
  }
  _ospCatalog = null;
}

/**
 * Push the dashboard's authoritative charm mappings into the route-engine DB.
 *
 * ── Why this exists (root-cause fix) ──────────────────────────────────────
 * The dashboard owns TWO authoritative tables the operator edits in-app:
 *   • charm_library         — charm code → default_charm_shop (e.g. CH-00037 → 小艾飾品)
 *   • charm_shop_directory  — charm shop → stall              (e.g. 小艾飾品 → 2D41-43)
 * These drive the "购物路线" dashboard cells the operator sees.
 *
 * The Python generator, however, does NOT read those tables. It reads its OWN
 * copies — `charm_library` + `charm_shops` inside route-engine/data/etsy_orders.db
 * — and then FORCES them onto every resolved line via
 * apply_canonical_charm_fields_to_resolved(). Those engine copies are seeded
 * only once (from charm_manifest.json) and are never updated when the operator
 * edits a charm in the UI, so they drift out of sync. The result: the dashboard
 * shows CH-00037 → 小艾飾品 · 2D41-43 while the generated Excel shows the stale
 * 壳引力 · A2-33 for the same code.
 *
 * Mirroring the dashboard tables into the engine DB immediately before each
 * generation makes both outputs read the SAME source of truth, eliminating the
 * divergence for the reported code and every other drifted code.
 *
 * Upsert semantics (never destructive):
 *   • charm_library  — update default_charm_shop for existing codes, insert
 *                      codes the engine is missing. The `photo` BLOB is
 *                      left untouched (charm photos are sourced from the on-disk
 *                      data/charm_images/<code>.* override anyway), and engine
 *                      rows with no dashboard counterpart are preserved.
 *   • charm_shops    — update stall for existing shops, insert missing shops.
 *
 * @param {import('better-sqlite3').Database} db dashboard SQLite handle
 * @param {object} config
 * @returns {{ok: boolean, reason?: string, charms: number, shops: number}}
 */
function syncCharmTablesToEngine(db, config) {
  const dbPath = enginePaths.catalogDbPath(config);
  if (!dbPath) return { ok: false, reason: 'engine database path not resolved', charms: 0, shops: 0 };
  try { fs.statSync(dbPath); }
  catch { return { ok: false, reason: 'engine database not found', charms: 0, shops: 0 }; }

  const lib   = getCharmLibrary(db);          // [{code, default_charm_shop, ...}]
  const shops = getCharmShopDirectory(db);    // [{shop_name, stall, notes, ...}]

  let eng;
  try {
    eng = new Database(dbPath, { fileMustExist: true });
    eng.pragma('busy_timeout = 5000');

    // Older engine databases may predate these tables — create on demand so the
    // sync (and the subsequent generation) never crashes on a fresh install.
    // `sku` is the engine's own column: the dashboard dropped the field, but the
    // Python generator still SELECTs it for the Charm Library sheet, so the
    // column must exist. We never write it — existing engine values are left
    // untouched and new codes get the ''.
    eng.exec(`
      CREATE TABLE IF NOT EXISTS charm_library (
        code               TEXT PRIMARY KEY,
        sku                TEXT NOT NULL DEFAULT '',
        default_charm_shop TEXT NOT NULL DEFAULT '',
        notes              TEXT NOT NULL DEFAULT '',
        photo              BLOB
      );
      CREATE TABLE IF NOT EXISTS charm_shops (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        shop_name TEXT UNIQUE NOT NULL,
        stall     TEXT NOT NULL DEFAULT '',
        notes     TEXT NOT NULL DEFAULT ''
      );
    `);

    const upLib = eng.prepare(`
      INSERT INTO charm_library (code, default_charm_shop)
      VALUES (@code, @default_charm_shop)
      ON CONFLICT(code) DO UPDATE SET
        default_charm_shop = excluded.default_charm_shop
    `);
    const upShop = eng.prepare(`
      INSERT INTO charm_shops (shop_name, stall)
      VALUES (@shop_name, @stall)
      ON CONFLICT(shop_name) DO UPDATE SET
        stall = excluded.stall
    `);

    const tx = eng.transaction(() => {
      let nC = 0, nS = 0;
      for (const c of lib) {
        const code = String(c.code || '').trim();
        if (!code) continue;
        upLib.run({
          code,
          default_charm_shop: String(c.default_charm_shop || '').trim(),
        });
        nC++;
      }
      for (const s of shops) {
        const shop_name = String(s.shop_name || '').trim();
        if (!shop_name) continue;
        upShop.run({ shop_name, stall: String(s.stall || '').trim() });
        nS++;
      }
      return { nC, nS };
    });
    const { nC, nS } = tx();
    return { ok: true, charms: nC, shops: nS };
  } catch (err) {
    return { ok: false, reason: err.message, charms: 0, shops: 0 };
  } finally {
    if (eng) { try { eng.close(); } catch { /* ignore */ } }
  }
}

/** Run OSP's FTS5 candidate query (AND then OR fallback). */
function _ftsCandidates(cat, norm, limit = 15) {
  if (!cat.ftsOk) return [];
  const words = norm.toLowerCase().split(/\s+/)
    .map(w => w.replace(/[^a-z0-9]/g, ''))
    .filter(w => w.length >= 3);
  if (!words.length) return [];

  const sql = `
    SELECT c.product_title
    FROM catalog_fts f
    JOIN catalog c ON f.rowid = c.id
    WHERE catalog_fts MATCH ?
    ORDER BY bm25(catalog_fts)
    LIMIT ?`;
  const run = (op) => {
    const term = words.map(w => `"${w.replace(/"/g, '""')}"`).join(` ${op} `);
    try { return cat.db.prepare(sql).all(term, limit).map(r => r.product_title); }
    catch { return []; }
  };
  let res = run('AND');
  if (!res.length) res = run('OR');
  return res;
}

/**
 * Match one product title to a supplier catalog entry, mirroring OSP.
 * @param {object} cat - result of openOspCatalog
 * @param {string} title
 * @returns {null | { shop_name, stall, floor, price, charm_shop, charm_code, match_score, in_catalog }}
 */
function matchSupplier(cat, title) {
  if (!cat) return null;
  const norm = normalizeTitle(title);

  // 1. Exact normalized match — highest confidence.
  let best = cat.byNorm.get(norm) || null;
  let score = best ? 100 : 0;

  // 2. FTS5 candidates re-ranked by token_sort_ratio.
  if (!best) {
    const cands = _ftsCandidates(cat, norm);
    let pool = cands.map(t => cat.byNorm.get(normalizeTitle(t))).filter(Boolean);
    // 3. O(N) fallback when FTS gives nothing.
    if (!pool.length) pool = cat.entries;

    for (const e of pool) {
      const s = _tokenSortRatio(norm, e.norm);
      if (s > score) { score = s; best = e; }
    }
    if (score < MATCH_THRESHOLD) { best = null; }
  }

  if (!best) return { shop_name: '', stall: '', floor: 999, price: '', charm_shop: '', charm_code: '', match_score: Math.round(score), in_catalog: false };

  // Resolve charm shop stall if the catalog names a charm shop.
  return {
    shop_name:   best.shop_name,
    stall:       best.stall,
    floor:       stallFloor(best.stall),
    price:       best.price,
    charm_shop:  best.charm_shop,
    charm_code:  best.charm_code,
    charm_shop_stall: cat.charmShopStall[best.charm_shop] || '',
    match_score: Math.round(score),
    in_catalog:  true,
  };
}

/**
 * Load the OSP charm catalog from charm_manifest.json.
 * @param {string} ospDir - absolute OSP project dir
 * @returns {{ charms: Array<object>, images_dir: string|null }}
 */
function loadCharmCatalog(ospDir) {
  if (!ospDir) return { charms: [], images_dir: null };
  const manifestPath = path.join(ospDir, 'data', 'charm_manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return { charms: [], images_dir: null };
  }
  const imagesDir = manifest.charm_images_dir
    || path.join(ospDir, 'data', 'charm_images');

  const charms = (manifest.charms || []).map(c => ({
    code:               c.code,
    default_charm_shop: c.default_charm_shop || '',
    // The manifest seeds Notes with an instruction to fill in a SKU — a field
    // the dashboard no longer has. Dropped here, at the boundary, so neither
    // the first seed nor a later re-sync can put it back.
    notes:              charmNotes.cleanCharmNote(c.notes),
    image_file:         c.image_file || c.image_relative || `${c.code}.png`,
    has_image:          !!(c.image_file || c.image_relative),
  }));

  return { charms, images_dir: imagesDir };
}

/**
 * Resolve the on-disk path of a charm image by code, guarding against traversal.
 * @param {string} ospDir
 * @param {string} code - e.g. "CH-00001"
 * @returns {string|null} absolute file path, or null if not found/invalid
 */
function resolveCharmImagePath(ospDir, code) {
  if (!ospDir || !code || !/^[A-Za-z0-9_-]+$/.test(code)) return null;
  const { charms, images_dir } = loadCharmCatalog(ospDir);
  if (!images_dir) return null;
  const charm = charms.find(c => c.code === code);
  const fileName = charm?.image_file || `${code}.png`;
  if (/[/\\]/.test(fileName)) return null;
  const full = path.join(images_dir, fileName);
  try { fs.accessSync(full, fs.constants.R_OK); return full; }
  catch {
    // Try common extensions as a fallback.
    for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
      const alt = path.join(images_dir, `${code}.${ext}`);
      try { fs.accessSync(alt, fs.constants.R_OK); return alt; } catch {}
    }
    return null;
  }
}

/**
 * Write OSP's output/route_statuses_cache.json from the given route rows.
 * Only emits keys for components the line actually has, and only non-default
 * statuses + explicit Pending resets are needed — but we write every present
 * component so an item reset to Pending in the UI reliably overrides any stale
 * "Purchased" value OSP may have read from a previous shopping_route.xlsx.
 *
 * The Python generator reads this file from the SAME directory it writes the
 * route Excel files to (`_load_ui_status_cache(output_path.parent)`), so the
 * caller must pass the route OUTPUT directory — not the OSP project dir.
 *
 * @param {string} outputDir - directory the route files are generated into
 * @param {Array<object>} rows - output of buildRouteRows (already filtered)
 * @returns {{ path: string, count: number }}
 */
function writeStatusCache(outputDir, rows) {
  fs.mkdirSync(outputDir, { recursive: true });
  const cachePath = path.join(outputDir, 'route_statuses_cache.json');

  const cache = {};
  for (const row of rows) {
    // OSP keys its status cache by the bare 50-char TITLE key (it has no concept
    // of our listing-scoped line keys), so reconstruct that key from the title
    // to stay byte-identical with the Python generator's `_load_ui_status_cache`.
    const base = `${row.receipt_id}\x00${itemKey(row.title)}\x00`;
    if (row.has_case)  cache[`${base}case`]  = row.status_case  || DEFAULT_STATUS;
    if (row.has_grip)  cache[`${base}grip`]  = row.status_grip  || DEFAULT_STATUS;
    if (row.has_charm) cache[`${base}charm`] = row.status_charm || DEFAULT_STATUS;
  }

  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf8');
  return { path: cachePath, count: Object.keys(cache).length };
}

/*
 * REMOVED (intentionally): reconcileCharmStatusesFromProgress.
 * ----------------------------------------------------------------------------
 * A previous version re-derived every line's `status_charm` at generation time
 * from a SECOND, independently-stored counter (`charm_purchase_progress`, the
 * "Charms to Buy" stepper) and persisted the result back over the per-line
 * statuses. The two stores inevitably drifted: the counter kept a stale value
 * (e.g. `0` once a charm had ever been toggled to Pending in the modal, which
 * POSTs purchased_qty=0), so the reconcile reset to Pending every charm the
 * operator had just marked Purchased via the per-line dropdown — the status
 * "came back" after each route generation, and the same revert surfaced in the
 * Orders tab (which reads the same per-line column).
 *
 * Root-cause fix: per-line `route_assignments.status_charm` is now the SINGLE
 * SOURCE OF TRUTH for charm purchase state. The stepper writes through to those
 * per-line statuses directly (client `_syncCharmStatusFromQty`), and the
 * generator + dashboard both read them verbatim — there is no second store to
 * drift from and nothing silently overwrites an explicit operator edit.
 *
 * Do NOT re-introduce a generation-time reconcile against a separate counter.
 */

/**
 * Group flat route rows into the OSP --import-json order payload, carrying the
 * user's charm assignments through to OSP.  Excluded rows are dropped here.
 *
 * @param {Array<object>} rows
 * @returns {Array<object>} orders array for { orders: [...] }
 */
function rowsToImportOrders(rows) {
  const byReceipt = new Map();
  for (const original of rows) {
    if (original.excluded) continue;
    // A line under a model fix is projected down to what the shopper must
    // actually buy. A SWAP holds only the swapped piece (the case) out of buying
    // — we already have it — so we keep the line but pass a style that drops the
    // held pieces (the Python generator derives components from `style`); a pure
    // case swap with nothing else to buy projects to null and is skipped. A BUY
    // keeps every piece, and the projection carries the CORRECTED phone_model so
    // the printed route names the model to actually get.
    let row = original;
    if (original.needs_exchange) {
      const projected = rowShoppingProjection(original);
      if (!projected) continue;
      row = { ...projected, style: styleFromComponentFlags(projected) };
    }
    if (!byReceipt.has(row.receipt_id)) {
      byReceipt.set(row.receipt_id, {
        order_number:    String(row.receipt_id),
        etsy_shop:       row.shop_name,
        buyer_name:      row.buyer_name,
        buyer_username:  row.buyer_email ? row.buyer_email.split('@')[0] : '',
        ship_to_name:    row.buyer_name,
        ship_to_country: row.country,
        order_date:      row.order_date
          ? new Date(row.order_date * 1000).toLocaleDateString('en-US',
              { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
          : '',
        private_notes:   row.private_notes,
        items: [],
      });
    }
    byReceipt.get(row.receipt_id).items.push({
      title:       row.title,
      quantity:    row.quantity,
      // The CORRECTED model when a model fix applies — a printed shopping route
      // that named the buyer's original (already known-wrong) model would send
      // the shopper to buy the wrong case a second time.
      phone_model: effectiveShoppingModel(row),
      style:       row.style,
      image_url:   row.image_url,
      // Etsy listing id — the ONLY stable per-line discriminator. Two genuinely
      // different listings on the same order can share the first 50 normalised
      // title characters AND the same component set (e.g. two "Case+Grip+Charm"
      // variants of the same product family). The generator's line dedup keys on
      // (order, title[:50], components); without this id it collapses those two
      // distinct lines into one and silently drops a product the operator must
      // still buy. Carried through so Python can keep them apart. Empty string
      // for manual items / legacy rows with no listing — the generator then
      // falls back to the old title-only behaviour, so nothing breaks.
      listing_id:  row.listing_id != null ? String(row.listing_id) : '',
      // Internal UED key — used by the image-fetcher to look up cached bytes
      // before writing the JSON payload. Stripped from the payload after image
      // injection so the OSP never sees it.
      _listing_id: row.listing_id || null,
      // Internal UED key for manual custom-product uploads (no listing id);
      // lets the generator pull the stored image bytes. Stripped before export.
      _manual_id:  row.is_manual && row.manual_id != null ? row.manual_id : null,
      // Use the confirmed user-assigned code first; fall back to the catalog
      // suggestion so Python groups the item under the same code the dashboard
      // would display rather than independently re-running a catalog fuzzy
      // match that may diverge when the product_map SQLite table is stale.
      charm_code:  row.charm_code || row.suggested_charm_code || '',
      charm_shop:  row.charm_shop || row.suggested_charm_shop || '',
      // Supplier resolved by the dashboard (catalog enrichment + manual
      // overrides). Passed so OSP places the item on the exact shop/stall the
      // operator sees, instead of re-guessing from its own catalog.
      supplier_shop:  row.supplier_shop  || '',
      supplier_stall: row.supplier_stall || '',
    });
  }
  return [...byReceipt.values()].filter(o => o.items.length > 0);
}

// ─── Catalog thumbnail resolution ─────────────────────────────────────────────
//
// The Product Catalog (`product_map`) stores only a free-text product title — it
// has no stable listing_id link. To show a thumbnail we must resolve that title
// back to an Etsy listing that has a cached image. Historically this was done by
// scanning ONLY past orders (`receipts.all_transactions`), so any catalog product
// that had never sold under that exact title rendered the 📦 placeholder — even
// when it was a perfectly good live listing with an image already on file. The
// canonical `listings` table (every live listing, each with `primary_image_url`)
// was never consulted. That is the root cause of the "so many products have no
// image" complaint.
//
// The resolver below fixes that by sourcing images from BOTH the canonical
// listings table AND order history, with a conservative, clearly-flagged fuzzy
// fallback for titles that drift from any single listing (the operator lists the
// same product across many shops under different SEO titles, so a 1:1 exact match
// is not always possible).

/** Tokenise a title into lowercase alphanumeric word tokens. */
function _titleTokens(title) {
  return normalizeTitle(title).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
}

/**
 * Build a reusable catalog-image resolver.
 *
 * Returns `{ resolve(titleNorm, title) }` where `resolve` yields
 * `{ url, approx }` or `null`:
 *   • approx=false — exact normalised-title match against a live listing or a
 *     past order (safe, deterministic — never a different product's photo).
 *   • approx=true  — high-confidence IDF-weighted fuzzy match used only to fill
 *     gaps; the UI flags these so the operator knows it is a representative
 *     image, not necessarily the exact listing.
 *
 * The exact map and the fuzzy corpus are built once, so per-row resolution is
 * cheap.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ fuzzy?: boolean }} [opts]
 */
function buildCatalogImageResolver(db, opts = {}) {
  const FUZZY = opts.fuzzy !== false;
  // Tuned against the live dataset: accepts genuine title-drift matches while
  // rejecting same-character-but-different-variant false positives (e.g. a plain
  // "Hello Kitty" listing must NOT be served for a "Hello Kitty Strawberry"
  // catalog entry). Cosmetic thumbnails only — purchasing is driven by the
  // supplier/charm codes, not the photo.
  const MIN_SCORE = 0.88;
  const MIN_MARGIN = 0.10;

  // listing_id → cached CDN thumbnail URL (binary-pipeline cache).
  const urlByListing = new Map();
  try {
    db.prepare("SELECT listing_id, url FROM listing_images WHERE url IS NOT NULL AND url <> ''")
      .all().forEach(r => urlByListing.set(String(r.listing_id), r.url));
  } catch { /* table may not exist yet */ }

  // Exact-title image resolution can also carry the listing's durable physical
  // product identity. This is essential when a freshly imported product_map row
  // has not yet been backfilled with its already-known listing_phash key: the
  // read model can still group duplicate cards without writing to product_map.
  const canonicalByListing = new Map();
  try {
    db.prepare("SELECT listing_id, canonical_key FROM listing_phash WHERE canonical_key IS NOT NULL AND canonical_key <> ''")
      .all().forEach(r => canonicalByListing.set(String(r.listing_id), String(r.canonical_key)));
  } catch { /* listing_phash may not exist on a minimal/fresh database */ }

  // Exact resolution map: title_norm → url. Listings (canonical) win over orders.
  const exact = new Map();
  const exactMeta = new Map();
  // Fuzzy corpus: deduped candidate titles that have an image.
  const corpusByNorm = new Map(); // title_norm → { tokens, url, listing_id, canonical_product_key }

  const addCandidate = (title, url, listingId = null) => {
    if (!url) return;
    const tn = normalizeTitle(title);
    if (!tn) return;
    const id = listingId == null ? null : Number(listingId);
    const meta = {
      url,
      listing_id: Number.isSafeInteger(id) ? id : null,
      canonical_product_key: listingId == null ? '' : canonicalByListing.get(String(listingId)) || '',
    };
    if (!exact.has(tn)) {
      exact.set(tn, url);
      exactMeta.set(tn, meta);
    }
    if (!corpusByNorm.has(tn)) corpusByNorm.set(tn, { tokens: _titleTokens(title), ...meta });
  };

  // 1) Canonical source: every live listing carries its own primary_image_url.
  try {
    db.prepare("SELECT listing_id, title, primary_image_url FROM listings WHERE title IS NOT NULL AND title <> '' ORDER BY listing_id")
      .all()
      .forEach(l => {
        const url = (l.primary_image_url && String(l.primary_image_url).trim())
          || urlByListing.get(String(l.listing_id)) || null;
        addCandidate(l.title, url, l.listing_id);
      });
  } catch { /* listings table may not exist yet */ }

  // 2) Fallback: products that only exist in order history (e.g. delisted items).
  try {
    db.prepare("SELECT all_transactions FROM receipts WHERE all_transactions IS NOT NULL AND all_transactions <> ''")
      .all()
      .forEach(r => {
        let txs = [];
        try { txs = JSON.parse(r.all_transactions || '[]'); } catch { return; }
        if (!Array.isArray(txs)) return;
        for (const t of txs) {
          const url = t.listing_id ? urlByListing.get(String(t.listing_id)) : null;
          if (url) addCandidate(t.title || '', url, t.listing_id);
        }
      });
  } catch { /* receipts table may not exist yet */ }

  // Precompute IDF + L2-normalised TF-IDF vectors over the candidate corpus.
  let corpus = [];
  let idf = () => 1;
  if (FUZZY && corpusByNorm.size > 0) {
    const docFreq = new Map();
    const N = corpusByNorm.size;
    for (const { tokens } of corpusByNorm.values()) {
      for (const w of new Set(tokens)) docFreq.set(w, (docFreq.get(w) || 0) + 1);
    }
    idf = (w) => Math.log((N + 1) / ((docFreq.get(w) || 0) + 1)) + 1;
    corpus = [...corpusByNorm.values()].map(c => ({ url: c.url, vec: _tfidfVec(c.tokens, idf) }));
  }

  /** @param {string} titleNorm @param {string} title */
  function resolve(titleNorm, title) {
    const url = exact.get(titleNorm);
    if (url) return { ...exactMeta.get(titleNorm), url, approx: false };
    if (!FUZZY || corpus.length === 0) return null;

    const qv = _tfidfVec(_titleTokens(title || titleNorm || ''), idf);
    if (qv.len === 0) return null;

    let best = null, bestScore = 0, second = 0;
    for (const c of corpus) {
      const s = _cosine(qv, c.vec);
      if (s > bestScore) { second = bestScore; bestScore = s; best = c; }
      else if (s > second) { second = s; }
    }
    if (best && bestScore >= MIN_SCORE && (bestScore - second) >= MIN_MARGIN) {
      // A fuzzy title match is suitable for a labelled thumbnail fallback, but
      // never authoritative enough to collapse products. Deliberately omit its
      // canonical key.
      return { url: best.url, approx: true, score: Number(bestScore.toFixed(3)), listing_id: best.listing_id };
    }
    return null;
  }

  return { resolve, exact };
}

/** Build an L2-normalised TF-IDF vector. @returns {{ v: Map<string,number>, len: number }} */
function _tfidfVec(tokens, idf) {
  const tf = new Map();
  for (const w of tokens) tf.set(w, (tf.get(w) || 0) + 1);
  const v = new Map();
  let sumSq = 0;
  for (const [w, n] of tf) {
    const wt = n * idf(w);
    v.set(w, wt);
    sumSq += wt * wt;
  }
  return { v, len: Math.sqrt(sumSq) };
}

/** Cosine similarity of two TF-IDF vectors. */
function _cosine(a, b) {
  if (a.len === 0 || b.len === 0) return 0;
  const [small, large] = a.v.size <= b.v.size ? [a.v, b.v] : [b.v, a.v];
  let dot = 0;
  for (const [w, wt] of small) {
    const o = large.get(w);
    if (o) dot += wt * o;
  }
  return dot / (a.len * b.len);
}

/**
 * Back-compat shim: exact-only map of normalised product title → image URL.
 * Prefer {@link buildCatalogImageResolver} for new code (adds the fuzzy fallback
 * and the approximate-match flag).
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {Map<string, string>} title_norm → image URL
 */
function buildProductImageMap(db) {
  return buildCatalogImageResolver(db, { fuzzy: false }).exact;
}

/**
 * Backfill empty supplier / charm fields in `product_map` from the bundled
 * route-engine catalog (etsy_orders.db), using *exact* normalised-title matches
 * only. This reconciles the catalog the operator sees with the data the route
 * generator actually uses, so a product never shows a blank supplier when the
 * engine already knows it. Existing (non-empty) product_map values are never
 * overwritten — manual/Excel data always wins.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} config
 * @returns {{ ok: boolean, supplier_filled: number, charm_filled: number, reason?: string }}
 */
function reconcileProductMap(db, config) {
  const cat = openOspCatalog(enginePaths.engineDir(config));
  if (!cat) return { ok: false, supplier_filled: 0, charm_filled: 0, reason: 'route-engine catalog unavailable' };

  const rows = db.prepare("SELECT id, title_norm, shop_name, stall, charm_shop, charm_code FROM product_map WHERE status = 'active'").all();
  const now = Math.floor(Date.now() / 1000);
  const upd = db.prepare(`
    UPDATE product_map
    SET shop_name = @shop_name, stall = @stall, charm_shop = @charm_shop,
        charm_code = @charm_code, updated_at = @updated_at
    WHERE id = @id
  `);

  let supplierFilled = 0, charmFilled = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const entry = cat.byNorm.get(r.title_norm);
      if (!entry) continue;

      const supplierEmpty = !r.shop_name && !r.stall;
      const charmEmpty     = !r.charm_shop && !r.charm_code;
      if (!supplierEmpty && !charmEmpty) continue;

      const next = {
        id: r.id,
        shop_name:  r.shop_name,
        stall:      r.stall,
        charm_shop: r.charm_shop,
        charm_code: r.charm_code,
        updated_at: now,
      };
      let changed = false;

      if (supplierEmpty && (entry.shop_name || entry.stall)) {
        next.shop_name = entry.shop_name || '';
        next.stall     = entry.stall || '';
        supplierFilled++;
        changed = true;
      }
      if (charmEmpty && (entry.charm_shop || entry.charm_code)) {
        next.charm_shop = entry.charm_shop || '';
        next.charm_code = entry.charm_code || '';
        charmFilled++;
        changed = true;
      }
      if (changed) upd.run(next);
    }
  });
  tx();

  return { ok: true, supplier_filled: supplierFilled, charm_filled: charmFilled };
}

module.exports = {
  STATUS_OPTIONS,
  DEFAULT_STATUS,
  MATCH_THRESHOLD,
  normalizeTitle,
  itemKey,
  lineItemKey,
  lineItemKeyWithVariant,
  stripLineVariantKey,
  variantFingerprint,
  productDefaultsKey,
  LINE_KEY_MARKER,
  LINE_VARIANT_MARKER,
  rowFullyPurchased,
  EXCHANGE_COMPONENTS,
  EXCHANGE_INTENT_SWAP,
  EXCHANGE_INTENT_BUY,
  modelFixIntentFrom,
  exchangeIntent,
  exchangeRecordIntent,
  effectiveShoppingModel,
  modelFixCoveredComponents,
  exchangeHeldComponents,
  shoppableComponentFlags,
  rowHasShoppingWork,
  rowShoppingProjection,
  styleFromComponentFlags,
  substitutionSupersedesIssue,
  styleComponents,
  parseVariations,
  isAirpodsProduct,
  buildRouteRows,
  buildProductCatalog,
  buildProductImageMap,
  buildCatalogImageResolver,
  reconcileProductMap,
  loadCharmCatalog,
  resolveCharmImagePath,
  writeStatusCache,
  rowsToImportOrders,
  openOspCatalog,
  closeOspCatalog,
  syncCharmTablesToEngine,
  matchSupplier,
  stallFloor,
};
