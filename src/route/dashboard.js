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

const { getProductMapByNorm, getManualItems, upsertRouteAssignment } = require('../db/setup');
const enginePaths = require('./engine-paths');

/** Valid component purchase statuses — mirror of OSP's STATUS_OPTIONS. */
const STATUS_OPTIONS = ['Pending', 'Purchased', 'Out of Stock', 'Out of Production'];
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

    // Archived orders are parked OUT of every active workflow (the Orders tab
    // hides them too). They must never appear in the purchasing Route — not even
    // via the needs-purchase OR-branch — so exclude them as a hard top-level AND
    // that wraps the entire scope. This is defense-in-depth: the write paths now
    // keep archived + needs_purchase mutually exclusive, and this guarantees a
    // stale/legacy archived row can still never leak into route generation.
    const archivedClause = ' AND r.archived_at IS NULL';

    whereClause = `r.is_paid = 1 AND ${scopeClause}${shopClause}${archivedClause}`;
  }

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

  // Authoritative product map from Excel "Product Map" sheet, keyed by title_norm.
  // Priority: route_assignments > product_assignments > excel_product_map > OSP catalog.
  const excelProductMap = getProductMapByNorm(db);

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
    const title = (line.title || '').trim();
    if (!title) return;

    const phoneModel = line.phoneModel || '';
    const style      = line.style || '';
    const comps      = styleComponents(style);
    // Listing-scoped key uniquely identifies this line-item's product, so two
    // different listings that share a 50-char title prefix never collide.
    const key       = line.item_key || lineItemKey(title, line.listing_id);
    const titleNorm = normalizeTitle(title);
    const saved    = assignMap[`${meta.receipt_id}\x00${key}`] || {};
    const product  = productMap[key] || {};
    const excelPM  = excelProductMap.get(titleNorm) || {};

    // Durably removed lines drop out of the dashboard AND route generation
    // entirely. They are only materialised when the caller explicitly asks for
    // them (the "Show removed" view), so the operator can review / restore.
    const isDismissed = !!saved.dismissed_at;
    if (isDismissed && !filters.include_dismissed) return;

    let supplier = null;
    if (cat) {
      // Supplier match is purely a function of the title — cache by title key.
      const catKey = titleNorm;
      if (!supplierCache.has(catKey)) supplierCache.set(catKey, matchSupplier(cat, title));
      supplier = supplierCache.get(catKey);
    }

    // Priority chain for supplier (highest → lowest):
    //   1. Per-order manual override  (route_assignments.supplier_*_override)
    //   2. Per-product user save      (product_assignments.supplier_*)
    //   3. Excel Product Map          (product_map.shop_name / stall)
    //   4. OSP catalog exact match    (etsy_orders.db catalog)
    const shopOvr  = saved.supplier_shop_override  || product.supplier_shop  || excelPM.shop_name || '';
    const stallOvr = saved.supplier_stall_override || product.supplier_stall || excelPM.stall     || '';
    const isOverride = !!(saved.supplier_shop_override || saved.supplier_stall_override ||
                          product.supplier_shop || product.supplier_stall);
    if (shopOvr || stallOvr) {
      const effectiveStall = stallOvr || (supplier?.stall || '');
      supplier = {
        shop_name:   shopOvr  || (supplier?.shop_name || ''),
        stall:       effectiveStall,
        floor:       stallFloor(effectiveStall),
        price:       supplier?.price      || '',
        charm_shop:  excelPM.charm_shop   || supplier?.charm_shop  || '',
        charm_code:  excelPM.charm_code   || supplier?.charm_code  || '',
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
    const effectiveCharmCode = saved.charm_code || product.charm_code || '';
    const effectiveCharmShop = saved.charm_shop || product.charm_shop || '';

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
      title,
      quantity:    line.quantity || 1,
      phone_model: phoneModel,
      style,
      image_url:   line.image_url != null
        ? line.image_url
        : (line.listing_id ? (imageMap[line.listing_id] || null) : null),
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
      // True when every component this line has is Purchased — the line is done
      // shopping. Used by the dashboard to drop it from the "to shop" counts and
      // the active queue without ever altering the underlying assignment.
      fully_purchased: fullyPurchased,
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
      suggested_charm_code: excelPM.charm_code || (supplier ? supplier.charm_code : ''),
      suggested_charm_shop: excelPM.charm_shop || (supplier ? supplier.charm_shop : ''),
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
  //   2. A shop_id filter is active — manual items carry no shop_id so they
  //      would bleed into every filtered shop view, creating noise. When the
  //      operator selects a specific shop they want to see only that shop's
  //      Etsy orders, not unrelated manual entries from other shopping sessions.
  if (filters.include_manual !== false &&
      !filters.shop_id &&
      filters.receipt_id == null &&
      !(Array.isArray(filters.receipt_ids) && filters.receipt_ids.length)) {
    let manualItems = [];
    try { manualItems = getManualItems(db); } catch { manualItems = []; }
    for (const m of manualItems) {
      emitRow({
        receipt_id:    m.receipt_id,
        shop_id:       '',
        shop_name:     m.shop_name || 'Manual entry',
        buyer_name:    'Manual entry',
        buyer_email:   '',
        order_date:    m.created_at || null,
        private_notes: '',
        team_note:     '',
        country:       '',
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
          : (m.has_image_data ? `/api/route/manual-image/${m.id}` : (m.listing_id ? (imageMap[m.listing_id] || null) : null)),
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
  // Cached thumbnail URLs by listing id.
  const urlByListing = new Map();
  try {
    db.prepare("SELECT listing_id, url FROM listing_images WHERE url IS NOT NULL AND url <> ''")
      .all().forEach(r => urlByListing.set(Number(r.listing_id), r.url));
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

/**
 * Reconcile per-line charm `status_charm` from the authoritative
 * `charm_purchase_progress` store (the "Charms to Buy" stepper count) so the
 * generated route Excel's charm section matches the dashboard exactly.
 *
 * WHY THIS EXISTS
 * ----------------
 * The dashboard's "Charms to Buy" modal shows "<n> still to buy" per charm code
 * derived from `charm_purchase_progress` (how many physical pieces of that code
 * are already bought). The generated Excel, however, derives its entire charm
 * section from per-line `status_charm` alone (via {@link writeStatusCache} →
 * route_statuses_cache.json → the Python generator's per-line charm filter).
 *
 * Those two stores were only kept in sync *optimistically in the browser*
 * (`_syncCharmStatusFromQty`), which runs when the operator drags the stepper.
 * If that sync never ran, partially failed to persist, or the order set changed
 * afterwards, the per-line statuses drift from the stepper count — so a charm
 * the dashboard reports as "1 of 2 · 1 still to buy" still has BOTH order lines
 * marked Pending in the DB, and the Excel prints the full quantity (2) instead
 * of the remaining 1. That is the exact defect this fixes.
 *
 * THE FIX
 * --------
 * Treat `charm_purchase_progress` as the single source of truth at generation
 * time. For every charm code that has a stored progress count, allocate exactly
 * that many pieces as "Purchased" (oldest order first — the most urgent to
 * fulfil), leaving the remainder "Pending". This is byte-for-byte the same
 * allocation the client performs in `_syncCharmStatusFromQty`, so the Purchased
 * flag lands on the SAME order lines the dashboard would choose.
 *
 * Terminal statuses set deliberately via the dropdown (Out of Stock / Out of
 * Production) are never touched and are skipped by the allocation, identical to
 * the client. Codes with no stored progress are left exactly as-is (the per-line
 * statuses already drive both views consistently in that case).
 *
 * Rows are mutated in place AND the changes are persisted to `route_assignments`
 * so the dashboard's per-line view permanently converges with the Excel.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Array<object>} rows     - buildRouteRows output (mutated in place)
 * @param {Record<string, number>} progress - charm_code → purchased pieces
 * @returns {{ changed: number, codes: number }}
 */
function reconcileCharmStatusesFromProgress(db, rows, progress) {
  if (!progress || typeof progress !== 'object' || !Array.isArray(rows)) {
    return { changed: 0, codes: 0 };
  }

  // Group charm-bearing, non-excluded, code-assigned lines by charm code —
  // this mirrors the dashboard's `_charmPurchaseScopeRows()` + `_aggregateCharms`.
  const byCode = new Map();
  for (const r of rows) {
    if (!r.has_charm || r.excluded || !r.charm_code) continue;
    if (!byCode.has(r.charm_code)) byCode.set(r.charm_code, []);
    byCode.get(r.charm_code).push(r);
  }

  const changed = [];
  let codesTouched = 0;

  for (const [code, lines] of byCode) {
    // Only reconcile codes the operator has an explicit progress count for.
    // Without one, the per-line statuses are already authoritative for both views.
    if (!Object.prototype.hasOwnProperty.call(progress, code)) continue;
    codesTouched++;

    // Oldest order first so the Purchased allocation is deterministic and
    // matches the client (most-urgent-first) exactly.
    lines.sort((a, b) =>
      (a.order_date || 0) - (b.order_date || 0) || (a.receipt_id - b.receipt_id));

    let remaining = Math.max(0, Math.floor(Number(progress[code]) || 0));

    for (const r of lines) {
      const st = r.status_charm || DEFAULT_STATUS;
      // Never clobber terminal statuses set deliberately via the dropdown; they
      // are also excluded from the allocation budget (same as the client).
      if (st === 'Out of Stock' || st === 'Out of Production') continue;

      const lineQty = r.quantity || 1;
      const target = remaining >= lineQty ? 'Purchased' : 'Pending';
      if (target === 'Purchased') remaining -= lineQty;

      if (st !== target) {
        r.status_charm = target;
        changed.push(r);
      }
    }
  }

  // Persist so the dashboard's per-line view converges with the Excel. Best
  // effort: the in-memory rows are already corrected for this generation run,
  // so a DB hiccup never blocks route output.
  if (changed.length) {
    try {
      const persist = db.transaction((items) => {
        for (const r of items) {
          upsertRouteAssignment(db, {
            receipt_id:   r.receipt_id,
            item_key:     r.item_key,
            title:        r.title,
            status_charm: r.status_charm,
          });
        }
      });
      persist(changed);
    } catch (err) {
      console.warn(`[route] charm status persist failed (non-fatal): ${err.message}`);
    }
  }

  return { changed: changed.length, codes: codesTouched };
}

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

/**
 * Build a map of normalised product title → primary product image URL.
 *
 * The product_map catalog stores only the product title, so to show a thumbnail
 * we resolve each title back to the Etsy listing it came from. Listing IDs and
 * titles live in `receipts.all_transactions` (a JSON array per receipt), and the
 * cached CDN thumbnail URL lives in `listing_images`. We index by the same
 * `normalizeTitle` key used everywhere else so lookups are exact.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {Map<string, string>} title_norm → image URL
 */
function buildProductImageMap(db) {
  const urlByListing = new Map();
  try {
    db.prepare('SELECT listing_id, url FROM listing_images WHERE url IS NOT NULL AND url <> \'\'')
      .all()
      .forEach(r => urlByListing.set(String(r.listing_id), r.url));
  } catch { /* table may not exist yet */ }

  const out = new Map();
  if (urlByListing.size === 0) return out;

  let recs = [];
  try {
    recs = db.prepare(
      "SELECT all_transactions FROM receipts WHERE all_transactions IS NOT NULL AND all_transactions <> ''"
    ).all();
  } catch { return out; }

  for (const r of recs) {
    let txs = [];
    try { txs = JSON.parse(r.all_transactions || '[]'); } catch { continue; }
    if (!Array.isArray(txs)) continue;
    for (const t of txs) {
      const tn = normalizeTitle(t.title || '');
      if (!tn || out.has(tn)) continue;
      const lid = t.listing_id ? String(t.listing_id) : '';
      const url = lid ? urlByListing.get(lid) : null;
      if (url) out.set(tn, url);
    }
  }
  return out;
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
  styleComponents,
  parseVariations,
  buildRouteRows,
  buildProductCatalog,
  buildProductImageMap,
  reconcileProductMap,
  loadCharmCatalog,
  resolveCharmImagePath,
  writeStatusCache,
  reconcileCharmStatusesFromProgress,
  rowsToImportOrders,
  openOspCatalog,
  closeOspCatalog,
  matchSupplier,
  stallFloor,
};
