'use strict';

/**
 * Etsy listing variation-image matching.
 *
 * Etsy stores one hero shot per listing, then separately maps variation
 * VALUES (Styles dropdown: "Case 1 + Grip 1") to listing image IDs. Orders
 * only carry the chosen style *string*, never an image URL or value_id, so
 * we cache that mapping at sync time and resolve it here.
 *
 * Style labels are matched after canonicalisation so "Case 1 + Grip 1",
 * "Case1+Grip1" and "case  1 +  grip 1" hit the same row.
 *
 * This module also owns the whole "which photo represents this order line"
 * decision — resolveUnswitchedLineImage / resolveSwitchedLineImage — so the
 * Route builder, the Orders API and the mobile shopping route all render the
 * same product from the same rules.
 */

const { PROP_STYLES } = require('./variation-builder');

/**
 * Stable lookup key for a Styles label. Empty when there is no style.
 *
 * @param {string|null|undefined} style
 * @returns {string}
 */
function canonicalizeStyleKey(style) {
  const base = String(style == null ? '' : style).trim().toLowerCase();
  if (!base) return '';
  return base
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/\s*([+/|&])\s*/g, ' $1 ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Lookup keys to try against a `${listing_id}\x00${style_key}` map so older
 * operator overrides (stored with looser spacing) still match a new order.
 *
 * @param {string|null|undefined} style
 * @returns {string[]}
 */
function styleKeyLookupCandidates(style) {
  const raw = String(style == null ? '' : style).trim().toLowerCase().replace(/\s+/g, ' ');
  const canon = canonicalizeStyleKey(style);
  const compact = raw.replace(/\s*([+/|&])\s*/g, '$1');
  const squeezed = raw.replace(/([a-z])\s+(\d)/g, '$1$2');
  return [...new Set([raw, canon, compact, squeezed].filter((k) => k !== ''))];
}

/**
 * @param {Object<string, T>} map
 * @param {number|string} listingId
 * @param {string|null|undefined} style
 * @returns {T|null}
 * @template T
 */
function lookupStyleKeyed(map, listingId, style) {
  if (!map || listingId == null) return null;
  const id = Number(listingId);
  if (!Number.isInteger(id) || id <= 0) return null;
  for (const key of styleKeyLookupCandidates(style)) {
    const hit = map[`${id}\x00${key}`];
    if (hit) return hit;
  }
  return null;
}

/**
 * The Etsy value_id the buyer's Styles selection resolved to.
 *
 * Etsy v3 transactions carry `{ property_id, value_id, formatted_name,
 * formatted_value }` per variation. The value_id is the exact, rename-proof
 * key into variation-images — the label is only a fallback.
 *
 * @param {any} variations - array or JSON string
 * @returns {number|null}
 */
function parseStyleValueId(variations) {
  let vars = variations;
  if (typeof vars === 'string') {
    try { vars = JSON.parse(vars); } catch { vars = []; }
  }
  if (!Array.isArray(vars)) return null;
  const prop = vars.find((v) => Number(v?.property_id) === PROP_STYLES)
    || vars.find((v) => /style/i.test(v?.formatted_name || v?.property_name || ''));
  const valueId = Number(prop?.value_id);
  return Number.isInteger(valueId) && valueId > 0 ? valueId : null;
}

/**
 * Resolve one line's Etsy variation photo. Matches on value_id first (exact),
 * then on the canonicalised Styles label for rows Etsy never gave us an id for.
 *
 * @param {{byStyle: Object, byValue: Object}|null} map
 * @param {number|string|null} listingId
 * @param {{valueId?: number|null, style?: string|null}} sel
 * @returns {{url:string, style_value:string, cached_at:number}|null}
 */
function lookupVariationImage(map, listingId, { valueId = null, style = null } = {}) {
  if (!map || listingId == null) return null;
  const id = Number(listingId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const vid = Number(valueId);
  if (Number.isInteger(vid) && vid > 0) {
    const hit = map.byValue ? map.byValue[`${id}\x00${vid}`] : null;
    if (hit) return hit;
  }
  return lookupStyleKeyed(map.byStyle, id, style);
}

/**
 * Image for an unswitched order line.
 *
 * Priority: operator Fix Image → Etsy variation photo → listing hero.
 * A design switch is a different product — see resolveSwitchedLineImage.
 *
 * @param {object} args
 * @param {{id:number, updated_at?:number}|null} [args.styleImg]
 * @param {string|null} [args.variationUrl]
 * @param {string|null} [args.listingUrl]
 * @returns {string|null}
 */
function resolveUnswitchedLineImage({ styleImg = null, variationUrl = null, listingUrl = null } = {}) {
  if (styleImg && styleImg.id != null) {
    return `/api/route/style-image/${styleImg.id}?v=${styleImg.updated_at || 0}`;
  }
  const variation = variationUrl != null ? String(variationUrl).trim() : '';
  if (variation) return variation;
  const listing = listingUrl != null ? String(listingUrl).trim() : '';
  return listing || null;
}

/**
 * Image for an order line whose design was SWITCHED to a replacement product.
 *
 * THE SINGLE SOURCE OF TRUTH for that decision, shared by the route builder and
 * the Orders API so the two surfaces can never disagree about which photo a
 * switched line shows.
 *
 * Priority, with NO fallback to the original design:
 *   1. uploaded bytes served from our own endpoint (custom switch),
 *   2. the switch's own stored CDN url (catalog switch),
 *   3. the replacement listing's cached thumbnail — repairs switches saved
 *      before the image could be resolved at write time,
 *   4. null → a neutral placeholder.
 *
 * Step 4 is deliberate. Falling through to the ORIGINAL listing's photo is the
 * "same old case" bug: the title changes but the shopper keeps seeing the design
 * the buyer moved away from, and buys it. A blank thumbnail is always safer than
 * a confident wrong one.
 *
 * The uploaded-bytes url is content-addressed (`?v=updated_at`), so replacing the
 * photo changes the url and the mobile service worker's cache-first image store
 * cannot serve the previous one.
 *
 * @param {{id:number, has_image_data?:number|boolean, image_url?:string|null,
 *          source_listing_id?:number|null, updated_at?:number}|null} sub
 * @param {(listingId:number) => (string|null|undefined)} [listingImageUrl]
 *        Cached hero-photo lookup for the REPLACEMENT listing.
 * @returns {string|null}
 */
function resolveSwitchedLineImage(sub, listingImageUrl = () => null) {
  if (!sub) return null;
  if (sub.has_image_data) {
    return `/api/route/substitution-image/${sub.id}?v=${sub.updated_at || 0}`;
  }
  const stored = sub.image_url != null ? String(sub.image_url).trim() : '';
  if (stored) return stored;
  const sourceListingId = Number(sub.source_listing_id);
  if (!Number.isInteger(sourceListingId) || sourceListingId <= 0) return null;
  const cached = listingImageUrl(sourceListingId);
  const url = cached != null ? String(cached).trim() : '';
  return url || null;
}

/**
 * Same-origin URL for an Etsy variation photo. The mobile shopping route's
 * service worker can only fetch `/api/*` (CSP connect-src is 'self').
 *
 * @param {number} listingId
 * @param {string} style
 * @param {number} [cachedAt]
 * @returns {string|null}
 */
function variationImageApiUrl(listingId, style, cachedAt) {
  const id = Number(listingId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const label = String(style == null ? '' : style).trim();
  if (!label) return null;
  const v = cachedAt != null ? `&v=${Number(cachedAt) || 0}` : '';
  return `/api/route/variation-image/${id}?k=${encodeURIComponent(label)}${v}`;
}

/**
 * Turn Etsy variation-images results + an image_id → CDN URL catalog into
 * rows ready to persist. Prefer the Styles property when a listing mixed
 * properties (Etsy normally allows only one).
 *
 * @param {Array<{property_id?:number, value_id?:number, value?:string, image_id?:number}>} results
 * @param {Map<number, string>|Record<number, string>|null} byImageId
 * @returns {Array<{style_key:string, style_value:string, image_id:number, url:string, value_id:number|null, property_id:number|null}>}
 */
function buildVariationImageRows(results, byImageId) {
  const list = Array.isArray(results) ? results : [];
  const lookup = (imageId) => {
    const id = Number(imageId);
    if (!Number.isInteger(id) || id <= 0) return null;
    if (byImageId instanceof Map) return byImageId.get(id) || null;
    if (byImageId && typeof byImageId === 'object') return byImageId[id] || byImageId[String(id)] || null;
    return null;
  };

  const hasStyles = list.some((r) => Number(r?.property_id) === PROP_STYLES);
  const filtered = hasStyles ? list.filter((r) => Number(r.property_id) === PROP_STYLES) : list;

  const rows = [];
  const seen = new Set();
  for (const r of filtered) {
    const styleValue = String(r?.value == null ? '' : r.value).trim();
    const styleKey = canonicalizeStyleKey(styleValue);
    if (!styleKey || seen.has(styleKey)) continue;
    const url = lookup(r.image_id);
    if (!url) continue;
    seen.add(styleKey);
    const imageId = Number(r.image_id);
    const valueId = r.value_id == null ? null : Number(r.value_id);
    const propertyId = r.property_id == null ? null : Number(r.property_id);
    rows.push({
      style_key: styleKey,
      style_value: styleValue,
      image_id: Number.isInteger(imageId) ? imageId : null,
      url: String(url),
      value_id: Number.isInteger(valueId) ? valueId : null,
      property_id: Number.isInteger(propertyId) ? propertyId : null,
    });
  }
  return rows;
}

module.exports = {
  PROP_STYLES,
  canonicalizeStyleKey,
  styleKeyLookupCandidates,
  lookupStyleKeyed,
  parseStyleValueId,
  lookupVariationImage,
  resolveUnswitchedLineImage,
  resolveSwitchedLineImage,
  variationImageApiUrl,
  buildVariationImageRows,
};
