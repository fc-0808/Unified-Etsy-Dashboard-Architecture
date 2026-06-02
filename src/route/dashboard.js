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

const { getProductMapByNorm } = require('../db/setup');
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
    // Default date / shop / pending scope.
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
    if (filters.shop_id) {
      scope.push('r.shop_id = @shop_id');
      params.shop_id = filters.shop_id;
    }
    if (!filters.include_shipped) {
      scope.push(
        "r.is_shipped = 0 AND r.status NOT IN ('Canceled','Cancelled','Fully Refunded','Fully refunded')"
      );
    }

    let scopeClause = scope.length ? `(${scope.join(' AND ')})` : '1';

    // Extra receipts (e.g. pre-transit orders the operator pulled in via the
    // Orders tab "Send to Route") are UNIONed on TOP of the date/shop scope —
    // they bypass the date + shipped filters so they always show up for
    // purchasing, *in addition to* (never instead of) the pending orders.
    const extra = Array.isArray(filters.extra_receipt_ids)
      ? filters.extra_receipt_ids.map(Number).filter(Number.isInteger)
      : [];
    if (extra.length) {
      const ph = extra.map((_, i) => `@xrid${i}`).join(',');
      extra.forEach((id, i) => { params[`xrid${i}`] = id; });
      scopeClause = `(${scopeClause} OR r.receipt_id IN (${ph}))`;
    }

    whereClause = `r.is_paid = 1 AND ${scopeClause}`;
  }

  const rows = db.prepare(`
    SELECT r.receipt_id, r.shop_id, r.name AS buyer_name, r.buyer_email,
           r.buyer_user_id, r.message_from_buyer, r.team_note,
           r.shipping_country_iso, r.etsy_created_at, r.all_transactions,
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
  for (const r of rows) {
    let txs = [];
    try { txs = JSON.parse(r.all_transactions || '[]'); } catch {}
    if (!Array.isArray(txs)) continue;

    for (const t of txs) {
      const title = (t.title || '').trim();
      if (!title) continue;

      const { phoneModel, style } = parseVariations(t.variations);
      const comps = styleComponents(style);
      // Listing-scoped key uniquely identifies this line-item's product, so two
      // different listings that share a 50-char title prefix never collide.
      const key       = lineItemKey(title, t.listing_id);
      const titleNorm = normalizeTitle(title);
      const saved    = assignMap[`${r.receipt_id}\x00${key}`] || {};
      const product  = productMap[key] || {};
      const excelPM  = excelProductMap.get(titleNorm) || {};

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

      out.push({
        receipt_id:  r.receipt_id,
        item_key:    key,
        shop_id:     r.shop_id,
        shop_name:   r.shop_name || r.shop_id,
        buyer_name:  r.buyer_name || '',
        buyer_email: r.buyer_email || '',
        order_date:  r.etsy_created_at || null,
        private_notes: r.message_from_buyer || '',
        team_note:   r.team_note || '',
        country:     r.shipping_country_iso || '',
        listing_id:  t.listing_id || null,
        title,
        quantity:    t.quantity || 1,
        phone_model: phoneModel,
        style,
        image_url:   t.listing_id ? (imageMap[t.listing_id] || null) : null,
        has_case:    comps.hasCase,
        has_grip:    comps.hasGrip,
        has_charm:   comps.hasCharm,
        charm_code:  effectiveCharmCode,
        charm_shop:  effectiveCharmShop,
        status_case:  saved.status_case  || DEFAULT_STATUS,
        status_grip:  saved.status_grip  || DEFAULT_STATUS,
        status_charm: saved.status_charm || DEFAULT_STATUS,
        excluded:    saved.excluded ? 1 : 0,
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
  }
  return out;
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
      // Internal UED key — used by the image-fetcher to look up cached bytes
      // before writing the JSON payload. Stripped from the payload after image
      // injection so the OSP never sees it.
      _listing_id: row.listing_id || null,
      charm_code:  row.charm_code || '',
      charm_shop:  row.charm_shop || '',
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
  styleComponents,
  parseVariations,
  buildRouteRows,
  buildProductImageMap,
  reconcileProductMap,
  loadCharmCatalog,
  resolveCharmImagePath,
  writeStatusCache,
  rowsToImportOrders,
  openOspCatalog,
  matchSupplier,
  stallFloor,
};
