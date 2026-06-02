'use strict';

/**
 * Builds the Etsy listing inventory (variation matrix) for an iPhone case.
 *
 * Structure (matches the live Y2KASEshop listings + Listings_automation):
 *   option1 = "Phone Model"  → Etsy custom property 513 (12 models)
 *   option2 = "Styles"       → Etsy custom property 514 (6 bundles)
 *
 * Price and quantity vary on the Styles property only:
 *   price_on_property    = [514]
 *   quantity_on_property = [514]
 *
 * That yields 12 × 6 = 72 products. Styles that the product photos don't
 * support (e.g. no grip image → grip bundles) are emitted as disabled
 * offerings so the variation still appears in the dropdown structure but is
 * hidden from buyers.
 */

// Etsy custom variation property IDs (Custom Property 1 / 2).
const PROP_PHONE_MODEL = 513;
const PROP_STYLES = 514;

// 12 phone models — verbatim from Listings_automation VariationMatrix.default_y2kase().
const PHONE_MODELS = [
  'iPhone 17 Pro Max',
  'iPhone 17 Pro',
  'iPhone 17',
  'iPhone 16 Pro Max',
  'iPhone 16 Pro',
  'iPhone 16',
  'iPhone 15 Pro Max',
  'iPhone 15 Pro',
  'iPhone 15',
  'iPhone 14 Pro Max',
  'iPhone 14 Pro',
  'iPhone 14/13',
];

// Internal style key → buyer-facing label (matches the pricing sheet variants).
const STYLES = [
  { key: 'Case+Grip+Charm', label: 'Case + Grip + Charm' },
  { key: 'Case+Grip',       label: 'Case + Grip' },
  { key: 'Case+Charm',      label: 'Case + Charm' },
  { key: 'Case Only',       label: 'Case Only' },
  { key: 'Grip Only',       label: 'Grip Only' },
  { key: 'Charm Only',      label: 'Charm Only' },
];

/**
 * Decide which styles are available based on Phase 1 image classification.
 * @param {object[]} imageAnalysis
 * @returns {Record<string, boolean>} style key → enabled
 */
function computeEnabledStyles(imageAnalysis = []) {
  const hasGrip = imageAnalysis.some((i) => i.has_grip);
  const hasCharm = imageAnalysis.some((i) => i.has_charm);
  return {
    'Case Only': true,
    'Grip Only': hasGrip,
    'Charm Only': hasCharm,
    'Case+Grip': hasGrip,
    'Case+Charm': hasCharm,
    'Case+Grip+Charm': hasGrip && hasCharm,
  };
}

/**
 * Build the full inventory body for putListingInventory.
 *
 * @param {object} args
 * @param {Record<string, number>} args.prices        style key → price (shop currency)
 * @param {object[]} [args.imageAnalysis]             Phase 1 facts (drives enabled styles)
 * @param {number} [args.restockQuantity=3]
 * @param {string[]} [args.models]                    override the model list
 * @returns {{ body:object, enabledStyles:Record<string,boolean>, minPrice:number, listingQuantity:number }}
 */
function buildInventory(args = {}) {
  const { prices = {}, imageAnalysis = [], restockQuantity = 3 } = args;
  const models = args.models && args.models.length ? args.models : PHONE_MODELS;
  const enabledStyles = computeEnabledStyles(imageAnalysis);

  const products = [];
  let minPrice = Infinity;
  let listingQuantity = 0;

  for (const model of models) {
    for (const style of STYLES) {
      const price = Number(prices[style.key]);
      if (!Number.isFinite(price) || price <= 0) continue; // no price → cannot offer
      const enabled = Boolean(enabledStyles[style.key]);
      const quantity = enabled ? restockQuantity : 0;
      if (enabled) {
        minPrice = Math.min(minPrice, price);
        listingQuantity += quantity;
      }
      products.push({
        property_values: [
          { property_id: PROP_PHONE_MODEL, property_name: 'Phone Model', values: [model], value_ids: [] },
          { property_id: PROP_STYLES,      property_name: 'Styles',      values: [style.label], value_ids: [] },
        ],
        offerings: [{ price, quantity, is_enabled: enabled }],
      });
    }
  }

  if (!Number.isFinite(minPrice)) minPrice = 0;
  if (listingQuantity === 0) listingQuantity = restockQuantity; // safety: keep listing valid

  const body = {
    products,
    price_on_property: [PROP_STYLES],
    quantity_on_property: [PROP_STYLES],
    sku_on_property: [],
  };

  return { body, enabledStyles, minPrice, listingQuantity };
}

/**
 * Build the variation-images payload linking style values to uploaded images.
 *
 * Requires the value_ids Etsy assigned to each Styles value (read back from
 * getListingInventory after the inventory PUT) and the uploaded image IDs keyed
 * by their 1-based rank.
 *
 * @param {object} args
 * @param {Record<string, number[]>} args.styleImageMapping  style key → image ranks (1-based)
 * @param {Map<number, number>} args.rankToImageId            rank → uploaded image_id
 * @param {Map<string, number>} args.styleLabelToValueId      style label → value_id
 * @returns {Array<{property_id:number,value_id:number,image_id:number}>}
 */
function buildVariationImages({ styleImageMapping = {}, rankToImageId, styleLabelToValueId }) {
  const out = [];
  const seen = new Set();
  for (const style of STYLES) {
    const ranks = styleImageMapping[style.key];
    if (!ranks || !ranks.length) continue;
    const valueId = styleLabelToValueId.get(style.label);
    if (valueId == null) continue;
    const imageId = rankToImageId.get(ranks[0]); // best-quality image for this style
    if (imageId == null) continue;
    const dedupeKey = `${valueId}:${imageId}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({ property_id: PROP_STYLES, value_id: valueId, image_id: imageId });
  }
  return out;
}

module.exports = {
  PROP_PHONE_MODEL,
  PROP_STYLES,
  PHONE_MODELS,
  STYLES,
  computeEnabledStyles,
  buildInventory,
  buildVariationImages,
};
