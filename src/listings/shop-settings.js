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
  findTaxonomyId,
} = require('../etsy/client');

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// Pick a shop section that looks like an iPhone/phone-case section, else first.
function pickSection(sections) {
  if (!sections.length) return null;
  const preferred = sections.find((s) => /iphone|phone|case/i.test(s.title || ''));
  return (preferred || sections[0]).shop_section_id;
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
async function fetchShopListingSettings(shopClient, shopId) {
  const [shop, shippingRes, returnRes, partnerRes, sectionRes] = await Promise.all([
    getShop(shopClient, shopId).catch((e) => ({ _error: e.message })),
    getShopShippingProfiles(shopClient, shopId).catch((e) => ({ _error: e.message, results: [] })),
    getShopReturnPolicies(shopClient, shopId).catch((e) => ({ _error: e.message, results: [] })),
    getShopProductionPartners(shopClient, shopId).catch((e) => ({ _error: e.message, results: [] })),
    getShopSections(shopClient, shopId).catch((e) => ({ _error: e.message, results: [] })),
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

  let taxonomyId = null;
  try {
    taxonomyId = await findTaxonomyId(shopClient, ['phone case'])
      || await findTaxonomyId(shopClient, ['cell phone case'])
      || await findTaxonomyId(shopClient, ['phone', 'case']);
  } catch {
    taxonomyId = null;
  }

  const selectedShipping = pickShippingProfile(shippingProfiles);
  const selectedProfile = shippingProfiles.find((p) => p.shipping_profile_id === selectedShipping);

  const defaults = {
    taxonomy_id: taxonomyId,
    shipping_profile_id: selectedShipping,
    return_policy_id: returnPolicies.length ? returnPolicies[0].return_policy_id : null,
    production_partner_ids: productionPartners.length ? [productionPartners[0].production_partner_id] : [],
    shop_section_id: pickSection(shopSections),
    who_made: 'someone_else',
    when_made: 'made_to_order',
    is_supply: false,
    processing_min: selectedProfile ? (selectedProfile.min_processing_days || null) : null,
    processing_max: selectedProfile ? (selectedProfile.max_processing_days || null) : null,
  };

  return {
    shop_name: shop.shop_name,
    shop_id: shop.shop_id,
    currency_code: shop.currency_code || null,
    warnings: [shippingRes, returnRes, partnerRes, sectionRes]
      .filter((r) => r && r._error)
      .map((r) => r._error),
    shipping_profiles: shippingProfiles,
    return_policies: returnPolicies,
    production_partners: productionPartners,
    shop_sections: shopSections,
    taxonomy_id: taxonomyId,
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
 */
async function getShopListingSettings({ db, shopClient, shopId, shopKey, force = false }) {
  if (db && !force) {
    try {
      const row = db.prepare('SELECT data_json, fetched_at FROM shop_listing_settings WHERE shop_key = ?').get(shopKey);
      if (row && (Date.now() - row.fetched_at) < CACHE_TTL_MS) {
        const cached = JSON.parse(row.data_json);
        cached._cached = true;
        return cached;
      }
    } catch { /* table may not exist yet — fall through to live fetch */ }
  }

  const settings = await fetchShopListingSettings(shopClient, shopId);

  if (db) {
    try {
      db.prepare(`
        INSERT INTO shop_listing_settings (shop_key, data_json, fetched_at)
        VALUES (@shop_key, @data_json, @fetched_at)
        ON CONFLICT(shop_key) DO UPDATE SET data_json = @data_json, fetched_at = @fetched_at
      `).run({ shop_key: shopKey, data_json: JSON.stringify(settings), fetched_at: Date.now() });
    } catch { /* non-fatal caching failure */ }
  }
  return settings;
}

module.exports = { fetchShopListingSettings, getShopListingSettings };
