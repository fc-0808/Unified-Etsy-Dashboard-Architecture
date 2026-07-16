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
  getProductMapByNorm, getManualItems,
  getCharmLibrary, getCharmShopDirectory,
  getOpenIssueMap, getOpenExchangeMap, getSubstitutionMap,
  getListingStyleImageMap, normalizeStyleKey,
  MANUAL_SHOP_ID,
} = require('../db/setup');
const enginePaths = require('./engine-paths');

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
 * @param {string} style
 * @returns {{ hasCase: boolean, hasGrip: boolean, hasCharm: boolean }}
 */
function styleComponents(style) {
  const s = String(style ?? '').toLowerCase();
  return {
    hasCase:  s.includes('case'),
    hasGrip:  s.includes('grip') || s.includes('stand'),
    hasCharm: s.includes('charm'),
  };
}

/**
 * Extract phone model + style from an Etsy variations array.
 * Etsy v3 transactions store: [{ formatted_name, formatted_value }, ...].
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

  const styleProp = vars.find(v => /style/i.test(v?.formatted_name || v?.property_name || ''));
  const modelProp = vars.find(v => /model|iphone|phone/i.test(v?.formatted_name || v?.property_name || ''));

  return {
    style:      styleProp ? pick(styleProp) : '',
    phoneModel: modelProp ? pick(modelProp) : '',
  };
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

  // Single-receipt lookup (for "Add Order" feature — bypasses date filter).
  if (filters.receipt_id != null) {
    params.receipt_id = Number(filters.receipt_id);
    whereClause = 'r.is_paid = 1 AND r.receipt_id = @receipt_id';
  } else if (Array.isArray(filters.receipt_ids) && filters.receipt_ids.length) {
    // Explicit receipt set. Bypasses the date + shipped filters so pre-transit
    // (label-created) orders are included.
    const ids = filters.receipt_ids.map(Number).filter(Number.isInteger);
    if (ids.length) {
      const ph = ids.map((_, i) => `@rid${i}`).join(',');
      ids.forEach((id, i) => { params[`rid${i}`] = id; });
      whereClause = `r.is_paid = 1 AND r.receipt_id IN (${ph})`;
    } else {
      whereClause = '0';   // no valid ids → empty result
    }
  } else if (filters.shop_id === MANUAL_SHOP_ID) {
    // "Manual orders" scope. Every manual order lives in the synthetic
    // __manual__ shop, but comes in two shapes:
    //   • Orders-tab manual order  → a `receipts` row, NO sidecar.
    //   • Route-tab manual order   → a `receipts` row PLUS a linked
    //                                `route_manual_items` sidecar (which carries
    //                                the product image + purchasing detail).
    // Show ALL of them regardless of date / ship state — the operator asked to
    // see manual orders specifically, so the date + pending scope (which is only
    // meaningful for time-bounded Etsy sync data) must not hide any. Sidecar-
    // bearing receipts are de-duped out just below and re-emitted from the manual
    // loop with their richer detail, so each order surfaces exactly once.
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
  // BOTH a `receipts` row (so it shows in the Orders tab) AND a linked
  // `route_manual_items` sidecar (which carries its product image + purchasing
  // detail and is merged in below). Excluding any receipt that has a sidecar
  // ensures such an order is emitted exactly once here — via the sidecar merge,
  // with its image — instead of twice. Manual orders WITHOUT a sidecar (created
  // directly in the Orders tab) have no matching row and still flow through.
  whereClause = `(${whereClause}) AND r.receipt_id NOT IN (SELECT receipt_id FROM route_manual_items)`;

  const rows = db.prepare(`
    SELECT r.receipt_id, r.shop_id, r.name AS buyer_name, r.buyer_email,
           r.buyer_user_id, r.message_from_buyer, r.team_note,
           r.shipping_country_iso, r.etsy_created_at, r.all_transactions,
           r.is_shipped, r.carrier_confirmed_at, r.shipment_notified_at,
           s.shop_name
    FROM receipts r
    JOIN shops s ON s.shop_id = r.shop_id
    WHERE ${whereClause}
    ORDER BY r.etsy_created_at ASC
  `).all(params);

  // Batch-load thumbnail URLs for all referenced listings.
  const listingIds = new Set();
  for (const r of rows) {
    try {
      JSON.parse(r.all_transactions || '[]').forEach(t => { if (t.listing_id) listingIds.add(t.listing_id); });
    } catch {}
  }
  const imageMap = {};
  if (listingIds.size > 0) {
    const ph = [...listingIds].map(() => '?').join(',');
    db.prepare(`SELECT listing_id, url FROM listing_images WHERE listing_id IN (${ph})`)
      .all([...listingIds])
      .forEach(row => { imageMap[row.listing_id] = row.url; });
  }

  // Operator-supplied per-variant clarifying images, keyed by
  // `${listing_id}\x00${style_key}`. These override the ambiguous listing hero
  // shot for a specific style (e.g. show the grip for a "Grip 3 Only" line).
  const styleImageMap = getListingStyleImageMap(db, listingIds);

  // Saved per-order assignments, keyed by `${receipt_id}\x00${item_key}`.
  const assignMap = {};
  try {
    db.prepare('SELECT * FROM route_assignments').all().forEach(a => {
      assignMap[`${a.receipt_id}\x00${a.item_key}`] = a;
    });
  } catch { /* table may not exist yet on first run */ }

  // Per-product defaults (user-set overrides), keyed by item_key.
  const productMap = {};
  try {
    db.prepare('SELECT * FROM product_assignments').all().forEach(a => {
      productMap[a.item_key] = a;
    });
  } catch { /* table may not exist before first restart */ }

  // Open fulfilment issues, keyed by `${receipt_id}\x00${item_key}`. Any line with
  // an open issue is held out of the purchasing route (we must never buy a product
  // the buyer may cancel or swap) — unless the caller explicitly opts in.
  const issueMap = getOpenIssueMap(db);

  // Open wrong-model exchanges, keyed by `${receipt_id}\x00${item_key}`. A line with
  // an open exchange is one we ALREADY hold (in the wrong model): it must not be
  // bought again, so it is dropped from the "to shop" buy set — but, unlike an issue,
  // it stays VISIBLE and is surfaced in the dedicated "To exchange" bucket so staff
  // carry it back to the stall to swap it for the model the order needs.
  const exchangeMap = getOpenExchangeMap(db);

  // Local design switches, keyed by `${receipt_id}\x00${item_key}`. When a line
  // has a switch, we PURCHASE the replacement design: its title drives supplier
  // matching, its style drives Case/Grip/Charm, and its image/model ride along.
  // The Etsy receipt is never touched — this is a purely local override.
  const substitutionMap = getSubstitutionMap(db);

  // Authoritative product map from Excel "Product Map" sheet, keyed by title_norm.
  // Priority: route_assignments > product_assignments > excel_product_map > OSP catalog.
  const excelProductMap = getProductMapByNorm(db);
  // Durable physical-product identity across Etsy shops/listing IDs. Generated
  // from near-identical primary product images and persisted in listing_phash.
  // Product Map carries the same key so Excel/catalog aliases remain linked.
  const canonicalByListing = new Map();
  try {
    db.prepare('SELECT listing_id, canonical_key FROM listing_phash WHERE canonical_key IS NOT NULL')
      .all()
      .forEach(r => canonicalByListing.set(Number(r.listing_id), r.canonical_key));
  } catch { /* migration may not have run yet */ }

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
   *   buyer_email, order_date, private_notes, team_note, country }
   * @param {object} line - { title, listing_id, quantity, phoneModel, style,
   *   image_url, is_manual?, manual_id? }
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
    const comps       = styleComponents(style);
    const titleNorm = normalizeTitle(title);
    // Switched image: uploaded bytes are served from our endpoint; a catalog pick
    // stores a CDN url. Falls through to the line's own image when neither is set.
    if (sub) {
      line = {
        ...line,
        image_url: sub.has_image_data
          // Content-addressed: the `v` token changes whenever the operator
          // re-uploads the switched-design photo (updated_at moves), so the URL
          // changes too and the mobile service worker's cache-first image cache
          // can never serve the previous/original photo. Without it, a re-uploaded
          // switched image stays stale on the shopping floor (desktop, which has
          // no service worker, showed the new one — the source of the mismatch).
          ? `/api/route/substitution-image/${sub.id}?v=${sub.updated_at || 0}`
          : (sub.image_url || line.image_url),
      };
    }
    const saved    = assignMap[`${meta.receipt_id}\x00${key}`] || {};
    const product  = productMap[key] || {};
    const excelPM  = excelProductMap.get(titleNorm) || {};
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
    const canonicalProductKey = sub
      ? ((sub.source_listing_id != null && canonicalByListing.get(Number(sub.source_listing_id)))
          || excelPM.canonical_product_key
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
    if (cat && !isCustomSub) {
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
    const shopOvr  = saved.supplier_shop_override  || (isCustomSub ? '' : (product.supplier_shop  || excelPM.shop_name)) || '';
    const stallOvr = saved.supplier_stall_override || (isCustomSub ? '' : (product.supplier_stall || excelPM.stall))     || '';
    const isOverride = !!(saved.supplier_shop_override || saved.supplier_stall_override ||
                          (!isCustomSub && (product.supplier_shop || product.supplier_stall)));
    if (shopOvr || stallOvr) {
      const effectiveStall = stallOvr || (supplier?.stall || '');
      supplier = {
        shop_name:   shopOvr  || (supplier?.shop_name || ''),
        stall:       effectiveStall,
        floor:       stallFloor(effectiveStall),
        price:       supplier?.price      || '',
        charm_shop:  (isCustomSub ? '' : excelPM.charm_shop) || supplier?.charm_shop || '',
        charm_code:  (isCustomSub ? '' : excelPM.charm_code) || supplier?.charm_code || '',
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
    const effectiveCharmCode = saved.charm_code || (isCustomSub ? '' : product.charm_code) || '';
    const effectiveCharmShop = saved.charm_shop || (isCustomSub ? '' : product.charm_shop) || '';

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

    // Per-variant clarifying image (operator upload for this listing + style).
    // Skipped when the line was switched to another design — that product is a
    // different item and carries its own image via line.image_url above.
    const styleImg = (!sub && line.listing_id)
      ? (styleImageMap[`${line.listing_id}\x00${normalizeStyleKey(style)}`] || null)
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
      listing_id:  line.listing_id || null,
      product_key: canonicalProductKey,
      title,
      quantity:    line.quantity || 1,
      phone_model: phoneModel,
      style,
      image_url:   line.image_url != null
        ? line.image_url
        : (styleImg
            // Content-addressed (see substitution image): busts the mobile
            // service-worker cache when the variant photo is replaced.
            ? `/api/route/style-image/${styleImg.id}?v=${styleImg.updated_at || 0}`
            : (line.listing_id ? (imageMap[line.listing_id] || null) : null)),
      has_case:    comps.hasCase,
      has_grip:    comps.hasGrip,
      has_charm:   comps.hasCharm,
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
      // Open wrong-model exchange — we hold this item but in the wrong model and
      // must swap it in person at the supplier. Held out of the buy set (we have
      // it) and surfaced in the dedicated "To exchange" bucket instead.
      needs_exchange:        !!exchange,
      exchange_id:           exchange ? exchange.id : null,
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
      // Supplier match (from OSP catalog) — null when enrichment is off.
      supplier_shop:        supplier ? supplier.shop_name : '',
      supplier_stall:       supplier ? supplier.stall : '',
      supplier_floor:       supplier ? supplier.floor : null,
      supplier_price:       supplier ? supplier.price : '',
      supplier_in_catalog:  supplier ? supplier.in_catalog : false,
      supplier_match_score: supplier ? supplier.match_score : 0,
      supplier_is_override: supplier ? !!supplier.is_override : false,
      // Catalog's suggested charm — Excel Product Map first, then OSP catalog.
      // Suppressed for custom switches (no catalog record to suggest from).
      suggested_charm_code: isCustomSub ? '' : (excelPM.charm_code || (supplier ? supplier.charm_code : '')),
      suggested_charm_shop: isCustomSub ? '' : (excelPM.charm_shop || (supplier ? supplier.charm_shop : '')),
    });
  }

  // Pre-transit detection — mirrors the same logic used by GET /api/orders and
  // the Orders tab UI (shipment_notified_at within the pre_transit_days window,
  // carrier has not yet confirmed arrival).
  const preTransitDays = config.pre_transit_days ?? 30;
  const routeNowSec    = Math.floor(Date.now() / 1000);
  const preTransitCutoff = routeNowSec - preTransitDays * 24 * 3600;

  for (const r of rows) {
    let txs = [];
    try { txs = JSON.parse(r.all_transactions || '[]'); } catch {}
    if (!Array.isArray(txs)) continue;

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
      });
    }
  }

  // ── Manual (operator-created) line-items ──────────────────────────────────
  // These persist server-side and are always part of the working route set
  // (they bypass the date/shop/pending scope — they're deliberate additions).
  // Suppressed in three situations:
  //   1. Single-receipt / explicit-receipt-set lookups ("Add Order" path).
  //   2. A REAL shop_id filter is active — manual items carry no shop_id so they
  //      would bleed into every filtered shop view, creating noise. When the
  //      operator selects a specific shop they want to see only that shop's
  //      Etsy orders, not unrelated manual entries from other shopping sessions.
  //      The synthetic __manual__ shop is the ONE exception: selecting it means
  //      "show manual orders only", so the sidecars must be emitted (this is what
  //      makes Route-created manual orders visible under the "Manual orders"
  //      filter — their receipt is de-duped out above and re-emitted here).
  const manualOnlyScope = filters.shop_id === MANUAL_SHOP_ID;
  if (filters.include_manual !== false &&
      (!filters.shop_id || manualOnlyScope) &&
      filters.receipt_id == null &&
      !(Array.isArray(filters.receipt_ids) && filters.receipt_ids.length)) {
    let manualItems = [];
    try { manualItems = getManualItems(db); } catch { manualItems = []; }
    // Pull the linked manual ORDER (receipts row) for each sidecar so the Route
    // shows the real buyer name / country / notes the operator filled in from the
    // Orders tab, instead of a generic "Manual entry" placeholder.
    const manualOrderById = {};
    if (manualItems.length) {
      const ids = manualItems.map((m) => Number(m.receipt_id)).filter(Number.isInteger);
      if (ids.length) {
        const ph = ids.map(() => '?').join(',');
        try {
          db.prepare(
            `SELECT receipt_id, name, buyer_email, shipping_country_iso, etsy_created_at, message_from_buyer, team_note
             FROM receipts WHERE receipt_id IN (${ph})`
          ).all(ids).forEach((r) => { manualOrderById[r.receipt_id] = r; });
        } catch { /* receipts may lack rows for legacy sidecars */ }
      }
    }
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
  }

  return out;
}

/**
 * Build the "product database" that powers the Route tab's Add-Order product
 * picker: every distinct product the dashboard has ever seen, with its cached
 * thumbnail and the set of phone-model / style variations observed across
 * orders. Products are keyed by listing_id (falling back to normalised title
 * when a line has no listing id).
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ products: Array<object>, phone_models: string[], styles: string[] }}
 */
function buildProductCatalog(db) {
  // Cached thumbnail URLs by listing id. Source from the canonical listings
  // table first (covers every live listing, sold or not) and fall back to the
  // order-driven listing_images cache for delisted products.
  const urlByListing = new Map();
  try {
    db.prepare("SELECT listing_id, primary_image_url FROM listings WHERE primary_image_url IS NOT NULL AND primary_image_url <> ''")
      .all().forEach(r => urlByListing.set(Number(r.listing_id), r.primary_image_url));
  } catch { /* listings table may not exist yet */ }
  try {
    db.prepare("SELECT listing_id, url FROM listing_images WHERE url IS NOT NULL AND url <> ''")
      .all().forEach(r => { if (!urlByListing.has(Number(r.listing_id))) urlByListing.set(Number(r.listing_id), r.url); });
  } catch { /* table may not exist yet */ }

  // Shop display names.
  const shopName = new Map();
  try {
    db.prepare('SELECT shop_id, shop_name FROM shops').all()
      .forEach(s => shopName.set(s.shop_id, s.shop_name || s.shop_id));
  } catch {}

  let recs = [];
  try {
    recs = db.prepare(
      "SELECT shop_id, all_transactions FROM receipts WHERE all_transactions IS NOT NULL AND all_transactions <> ''"
    ).all();
  } catch { recs = []; }

  const byKey = new Map();        // product key → product aggregate
  const allModels = new Set();
  const allStyles = new Set();

  for (const rec of recs) {
    let txs = [];
    try { txs = JSON.parse(rec.all_transactions || '[]'); } catch { continue; }
    if (!Array.isArray(txs)) continue;

    for (const t of txs) {
      const title = (t.title || '').trim();
      if (!title) continue;
      const listingId = t.listing_id ? Number(t.listing_id) : null;
      const key = listingId ? `L${listingId}` : `T${normalizeTitle(title)}`;
      const { phoneModel, style } = parseVariations(t.variations);
      if (phoneModel) allModels.add(phoneModel);
      if (style) allStyles.add(style);

      let p = byKey.get(key);
      if (!p) {
        p = {
          key,
          listing_id: listingId,
          title,
          shop_id:    rec.shop_id || '',
          shop_name:  shopName.get(rec.shop_id) || rec.shop_id || '',
          image_url:  listingId ? (urlByListing.get(listingId) || null) : null,
          phone_models: new Set(),
          styles:       new Set(),
          order_count:  0,
        };
        byKey.set(key, p);
      }
      if (phoneModel) p.phone_models.add(phoneModel);
      if (style) p.styles.add(style);
      p.order_count += 1;
    }
  }

  const products = [...byKey.values()]
    .map(p => ({
      key:          p.key,
      listing_id:   p.listing_id,
      title:        p.title,
      shop_id:      p.shop_id,
      shop_name:    p.shop_name,
      image_url:    p.image_url,
      phone_models: [...p.phone_models].sort(),
      styles:       [...p.styles].sort(),
      order_count:  p.order_count,
    }))
    .sort((a, b) => (b.order_count - a.order_count) || a.title.localeCompare(b.title));

  return {
    products,
    phone_models: [...allModels].sort(),
    styles:       [...allStyles].sort(),
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

/** Parse the floor number from a stall code (mirror of OSP `_stall_floor`). */
function stallFloor(stall) {
  if (!stall || ['—', '???', ''].includes(stall)) return 999;
  if (/^A2/i.test(stall)) return 2;
  let m = /^(\d)/.exec(stall);
  if (m) return Number(m[1]);
  m = /(\d)[A-Za-z]/.exec(stall);
  if (m) return Number(m[1]);
  return 999;
}

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
 *   • charm_library  — update default_charm_shop + sku for existing codes,
 *                      insert codes the engine is missing. The `photo` BLOB is
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

  const lib   = getCharmLibrary(db);          // [{code, sku, default_charm_shop, ...}]
  const shops = getCharmShopDirectory(db);    // [{shop_name, stall, notes, ...}]

  let eng;
  try {
    eng = new Database(dbPath, { fileMustExist: true });
    eng.pragma('busy_timeout = 5000');

    // Older engine databases may predate these tables — create on demand so the
    // sync (and the subsequent generation) never crashes on a fresh install.
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
      INSERT INTO charm_library (code, sku, default_charm_shop)
      VALUES (@code, @sku, @default_charm_shop)
      ON CONFLICT(code) DO UPDATE SET
        sku                = excluded.sku,
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
          sku:                String(c.sku || '').trim(),
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
    sku:                c.sku || '',
    default_charm_shop: c.default_charm_shop || '',
    notes:              c.notes || '',
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
  for (const row of rows) {
    if (row.excluded) continue;
    // A line awaiting a wrong-model exchange is already in hand — never re-buy it.
    if (row.needs_exchange) continue;
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
      phone_model: row.phone_model,
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

  // Exact resolution map: title_norm → url. Listings (canonical) win over orders.
  const exact = new Map();
  // Fuzzy corpus: deduped candidate titles that have an image.
  const corpusByNorm = new Map(); // title_norm → { tokens, url }

  const addCandidate = (title, url) => {
    if (!url) return;
    const tn = normalizeTitle(title);
    if (!tn) return;
    if (!exact.has(tn)) exact.set(tn, url);
    if (!corpusByNorm.has(tn)) corpusByNorm.set(tn, { tokens: _titleTokens(title), url });
  };

  // 1) Canonical source: every live listing carries its own primary_image_url.
  try {
    db.prepare("SELECT listing_id, title, primary_image_url FROM listings WHERE title IS NOT NULL AND title <> ''")
      .all()
      .forEach(l => {
        const url = (l.primary_image_url && String(l.primary_image_url).trim())
          || urlByListing.get(String(l.listing_id)) || null;
        addCandidate(l.title, url);
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
          if (url) addCandidate(t.title || '', url);
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
    if (url) return { url, approx: false };
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
      return { url: best.url, approx: true, score: Number(bestScore.toFixed(3)) };
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

  const rows = db.prepare('SELECT id, title_norm, shop_name, stall, charm_shop, charm_code FROM product_map').all();
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
  LINE_KEY_MARKER,
  rowFullyPurchased,
  substitutionSupersedesIssue,
  styleComponents,
  parseVariations,
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
