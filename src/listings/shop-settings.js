'use strict';

/**
 * Per-shop Etsy settings resolver for the Bulk Listing Creator.
 *
 * Fetches the shop's shipping profiles, return policies, production partners,
 * shop sections, currency, and resolves the iPhone-case taxonomy_id — then
 * auto-selects sensible defaults. The UI can override any default before a run.
 *
 * Results are optionally cached to the shop_listing_settings table so repeated
 * opens of the Bulk Listings tab don't re-hit the Etsy API on every click.
 */

const {
  getShop,
  getShopShippingProfiles,
  getShopReturnPolicies,
  getShopProductionPartners,
  getShopSections,
  getShopReadinessStateDefinitions,
  findTaxonomyId,
} = require('../etsy/client');
const productTypes = require('./product-types');

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// Pick the shop section that best matches the product type (e.g. an "AirPods
// Cases" section for an AirPods run), else the first section for iPhone, else
// none — so an AirPods run never silently defaults to the iPhone section.
//
// A keyword match alone is not enough: every line's keywords include the word
// every section shares ("case"), so "iPad Cases" matches the iPhone pattern
// too. A section another line clearly owns is therefore skipped outright,
// including in the iPhone fallback — publishing an iPhone case into the iPad
// section is the same mistake, just quieter.
function pickSection(sections, pt) {
  const ours = sections.filter((s) => !sectionBelongsToOtherType(s.title, pt));
  if (!ours.length) return null;
  const preferred = ours.find((s) => pt.sectionKeywords.test(s.title || ''));
  if (preferred) return preferred.shop_section_id;
  return pt.id === 'iphone_case' ? ours[0].shop_section_id : null;
}

// Escape a string for safe interpolation into a RegExp.
function reEscape(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Does a section title clearly belong to a DIFFERENT product type than `pt`?
// We key off each type's distinctive device word ("iPhone" / "AirPods"), NOT
// the generic "case" keyword every section shares — so we only flag genuine
// cross-type contamination (an AirPods run pointed at the "iPhone Cases"
// section) and never a legitimate custom section such as "Best Sellers".
function sectionBelongsToOtherType(title, pt) {
  const t = String(title || '');
  const matchesWord = (word) => Boolean(word) && new RegExp(`\\b${reEscape(word)}\\b`, 'i').test(t);
  if (matchesWord(pt.deviceWord)) return false; // owns THIS type's device word → not foreign
  return Object.values(productTypes.PRODUCT_TYPES).some(
    (other) => other.id !== pt.id && matchesWord(other.deviceWord),
  );
}

/**
 * Resolve the shop_section_id to use for a run against the shop's CURRENT
 * sections. Honours a deliberate operator choice, but self-corrects the two
 * ways a stored section id goes wrong between selection and publish:
 *   1. it no longer exists on the shop (deleted, or copied from another shop), or
 *   2. it belongs to a different product type — e.g. an AirPods run whose UI
 *      defaulted to the only existing "iPhone Cases" section — while a section
 *      matching THIS product type now exists (created after the dry run).
 * Falls back to pickSection's auto-selection when there is no valid choice.
 *
 * @param {number|null} desiredId  stored/override section id (may be stale)
 * @param {Array<{shop_section_id:number,title:string}>} sections  live sections
 * @param {object} pt  product-type descriptor
 * @returns {number|null}
 */
function reconcileShopSection(desiredId, sections, pt) {
  const list = Array.isArray(sections) ? sections : [];
  if (!list.length) return null;
  const byId = new Map(list.map((s) => [Number(s.shop_section_id), s]));
  const desired = desiredId != null ? byId.get(Number(desiredId)) : null;
  const autoId = pickSection(list, pt);

  // A stored id that no longer exists on this shop → auto-detect.
  if (desiredId != null && !desired) return autoId;
  // A section owned by another product type → never keep it. Correct it to the
  // matching section when one exists, else fall back to auto-selection (which,
  // for AirPods, is "no section" rather than silently using the iPhone one).
  if (desired && sectionBelongsToOtherType(desired.title, pt)) {
    const preferred = list.find(
      (s) => pt.sectionKeywords.test(s.title || '') && !sectionBelongsToOtherType(s.title, pt),
    );
    return preferred ? preferred.shop_section_id : autoId;
  }
  // Honour a valid, non-conflicting explicit choice.
  if (desired) return desired.shop_section_id;
  // No stored choice → auto-detect (matching section, iPhone fallback, or none).
  return autoId;
}

// Prefer a "ready to ship" / non-calculated profile, else the first.
function pickShippingProfile(profiles) {
  if (!profiles.length) return null;
  const preferred = profiles.find((p) => /ready|standard|default/i.test(p.title || ''));
  return (preferred || profiles[0]).shipping_profile_id;
}

/**
 * Fetch and resolve listing settings for a shop.
 * @param {import('axios').AxiosInstance} shopClient
 * @param {string|number} shopId  numeric shop ID
 * @returns {Promise<object>}
 */
async function fetchShopListingSettings(shopClient, shopId, productType) {
  const pt = productTypes.getProductType(productType);
  const [shop, shippingRes, returnRes, partnerRes, sectionRes, readinessRes] = await Promise.all([
    getShop(shopClient, shopId).catch((e) => ({ _error: e.message })),
    getShopShippingProfiles(shopClient, shopId).catch((e) => ({ _error: e.message, results: [] })),
    getShopReturnPolicies(shopClient, shopId).catch((e) => ({ _error: e.message, results: [] })),
    getShopProductionPartners(shopClient, shopId).catch((e) => ({ _error: e.message, results: [] })),
    getShopSections(shopClient, shopId).catch((e) => ({ _error: e.message, results: [] })),
    getShopReadinessStateDefinitions(shopClient, shopId).catch((e) => ({ _error: e.message, results: [] })),
  ]);

  const shippingProfiles = (shippingRes.results || []).map((p) => ({
    shipping_profile_id: p.shipping_profile_id,
    title: p.title,
    min_processing_days: p.min_processing_days ?? p.processing_days_display ?? null,
    max_processing_days: p.max_processing_days ?? null,
  }));
  const returnPolicies = (returnRes.results || []).map((p) => ({
    return_policy_id: p.return_policy_id,
    accepts_returns: p.accepts_returns,
    accepts_exchanges: p.accepts_exchanges,
    return_deadline: p.return_deadline,
  }));
  const productionPartners = (partnerRes.results || []).map((p) => ({
    production_partner_id: p.production_partner_id,
    partner_name: p.partner_name,
    location: p.location,
  }));
  const shopSections = (sectionRes.results || []).map((s) => ({
    shop_section_id: s.shop_section_id,
    title: s.title,
  }));

  // Readiness states (processing profiles). Etsy made readiness_state_id
  // mandatory for physical listings; the id we send is the definition's id.
  const mapReadiness = (results) => (results || []).map((r) => ({
    readiness_state_id: r.readiness_state_definition_id ?? r.readiness_state_id,
    readiness_state: r.readiness_state || '',
    min_processing_time: r.min_processing_time ?? null,
    max_processing_time: r.max_processing_time ?? null,
    processing_time_unit: r.processing_time_unit || 'days',
  })).filter((r) => r.readiness_state_id != null);

  let readinessStates = mapReadiness(readinessRes.results);

  // Reading settings must never hide an Etsy write. If a physical-listing
  // processing profile is missing, surface it for explicit setup in Shop
  // Manager; do not silently create one during a preview or page load.

  // Resolve the taxonomy for THIS product type by trying its keyword candidates
  // in order (e.g. AirPods → earbud/headphone/earphone case nodes).
  let taxonomyId = null;
  try {
    for (const keywords of pt.taxonomyKeywords) {
      taxonomyId = await findTaxonomyId(shopClient, keywords);
      if (taxonomyId) break;
    }
  } catch {
    taxonomyId = null;
  }

  const selectedShipping = pickShippingProfile(shippingProfiles);
  const selectedProfile = shippingProfiles.find((p) => p.shipping_profile_id === selectedShipping);

  // Default processing profile: prefer one matching "made_to_order", else first.
  const selectedReadiness =
    readinessStates.find((r) => /made_to_order/i.test(r.readiness_state)) || readinessStates[0] || null;

  const defaults = {
    taxonomy_id: taxonomyId,
    shipping_profile_id: selectedShipping,
    return_policy_id: returnPolicies.length ? returnPolicies[0].return_policy_id : null,
    production_partner_ids: productionPartners.length ? [productionPartners[0].production_partner_id] : [],
    shop_section_id: pickSection(shopSections, pt),
    readiness_state_id: selectedReadiness ? selectedReadiness.readiness_state_id : null,
    who_made: 'someone_else',
    when_made: 'made_to_order',
    is_supply: false,
    processing_min: selectedProfile ? (selectedProfile.min_processing_days || null) : null,
    processing_max: selectedProfile ? (selectedProfile.max_processing_days || null) : null,
  };

  const warnings = [shop, shippingRes, returnRes, partnerRes, sectionRes, readinessRes]
    .filter((r) => r && r._error)
    .map((r) => r._error);
  if (!readinessStates.length) {
    warnings.push('No processing profile found. Create one explicitly in Etsy Shop Manager before creating drafts.');
  }

  return {
    shop_name: shop.shop_name,
    shop_id: shop.shop_id,
    currency_code: shop.currency_code || null,
    warnings,
    shipping_profiles: shippingProfiles,
    return_policies: returnPolicies,
    production_partners: productionPartners,
    shop_sections: shopSections,
    readiness_states: readinessStates,
    taxonomy_id: taxonomyId,
    // Product-type context the UI mirrors: the active type, its device-model set,
    // the values it offers on each axis, and capability flags. `product_types`
    // (the full list) is added by the server so this cached object stays
    // product-type specific.
    ...productTypes.productMeta(pt),
    defaults,
  };
}

/**
 * Cached wrapper. Reads/writes the shop_listing_settings table when a db handle
 * is provided. Pass { force: true } to bypass the cache.
 *
 * @param {object} args
 * @param {import('better-sqlite3').Database} [args.db]
 * @param {import('axios').AxiosInstance} args.shopClient
 * @param {string|number} args.shopId      numeric shop ID
 * @param {string} args.shopKey            config shop_id (cache key / row id)
 * @param {boolean} [args.force]
 * @param {boolean} [args.cacheOnly]       never call Etsy; fail if cache is unavailable/stale
 */
async function getShopListingSettings({ db, shopClient, shopId, shopKey, productType, force = false, cacheOnly = false }) {
  const pt = productTypes.getProductType(productType);
  // Cache is per (shop, product type) — taxonomy, default section, models and
  // styles all differ by product type, so they must never share a cache row.
  const cacheKey = pt.id === 'iphone_case' ? shopKey : `${shopKey}::${pt.id}`;
  if (db && !force) {
    try {
      const row = db.prepare('SELECT data_json, fetched_at FROM shop_listing_settings WHERE shop_key = ?').get(cacheKey);
      if (row && (Date.now() - row.fetched_at) < CACHE_TTL_MS) {
        const cached = JSON.parse(row.data_json);
        // Invalidate caches written before readiness states existed, so physical
        // listings always get a readiness_state_id (now mandatory on Etsy). Also
        // invalidate legacy rows that predate the product_type field.
        const hasReadinessField = cached.defaults && 'readiness_state_id' in cached.defaults;
        const hasProductType = 'product_type' in cached;
        if (hasReadinessField && hasProductType) {
          cached._cached = true;
          return cached;
        }
      }
    } catch { /* table may not exist yet — fall through to live fetch */ }
  }

  if (cacheOnly) {
    const e = new Error(
      'Cached shop settings are unavailable or stale. Explicitly refresh Shop settings, then run the safe preview again.'
    );
    e.status = 409;
    e.code = 'SHOP_SETTINGS_CACHE_REQUIRED';
    throw e;
  }

  const settings = await fetchShopListingSettings(shopClient, shopId, pt);

  if (db) {
    try {
      db.prepare(`
        INSERT INTO shop_listing_settings (shop_key, data_json, fetched_at)
        VALUES (@shop_key, @data_json, @fetched_at)
        ON CONFLICT(shop_key) DO UPDATE SET data_json = @data_json, fetched_at = @fetched_at
      `).run({ shop_key: cacheKey, data_json: JSON.stringify(settings), fetched_at: Date.now() });
    } catch { /* non-fatal caching failure */ }
  }
  return settings;
}

module.exports = { fetchShopListingSettings, getShopListingSettings, pickSection, reconcileShopSection };
