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
// These are the Etsy "Phone Model" variation VALUES (option1). "iPhone 14/13" is a
// single combined offering.
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

// Display order for the model selector + sanitisation (same as PHONE_MODELS).
const MODEL_ORDER = PHONE_MODELS.slice();

// How each variation model expands into buyer-facing names for the listing
// description's "Device Compatibility" section (the combined model splits in two).
const MODEL_DESCRIPTION_NAMES = {
  'iPhone 14/13': ['iPhone 14', 'iPhone 13'],
};

/**
 * Coerce an arbitrary {model: truthy} map into a clean boolean map over the 12
 * known models. If the input enables NOTHING (or is empty/missing), every model
 * is enabled — a listing must always offer at least one phone model, and the
 * default behaviour is "all models available".
 */
function normaliseEnabledModels(input) {
  if (!input || typeof input !== 'object' || !Object.keys(input).length) {
    const all = {};
    for (const m of MODEL_ORDER) all[m] = true;
    return all;
  }
  const out = {};
  let anyOn = false;
  for (const m of MODEL_ORDER) {
    out[m] = Boolean(input[m]);
    if (out[m]) anyOn = true;
  }
  if (!anyOn) for (const m of MODEL_ORDER) out[m] = true; // never ship an empty model list
  return out;
}

/** The enabled variation models, in display order. */
function enabledModelList(enabledModels) {
  const norm = normaliseEnabledModels(enabledModels);
  return MODEL_ORDER.filter((m) => norm[m]);
}

/** Buyer-facing description model names for the enabled models (14/13 expands). */
function compatibilityNamesFor(enabledModels) {
  const out = [];
  for (const m of enabledModelList(enabledModels)) {
    const names = MODEL_DESCRIPTION_NAMES[m] || [m];
    for (const n of names) out.push(n);
  }
  return out;
}

/** Every possible buyer-facing description model name (across all 12 models). */
const ALL_DESCRIPTION_NAMES = (() => {
  const out = [];
  for (const m of MODEL_ORDER) {
    const names = MODEL_DESCRIPTION_NAMES[m] || [m];
    for (const n of names) out.push(n);
  }
  return out;
})();

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
function enabledStylesFor(hasGrip, hasCharm) {
  const g = Boolean(hasGrip);
  const c = Boolean(hasCharm);
  return {
    'Case Only': true,        // always offered
    'Grip Only': g,
    'Charm Only': c,
    'Case+Grip': g,
    'Case+Charm': c,
    'Case+Grip+Charm': g && c,
  };
}

function computeEnabledStyles(imageAnalysis = []) {
  return enabledStylesFor(
    imageAnalysis.some((i) => i.has_grip),
    imageAnalysis.some((i) => i.has_charm),
  );
}

// Style keys, in display order. Case Only is always available.
const STYLE_ORDER = ['Case+Grip+Charm', 'Case+Grip', 'Case+Charm', 'Case Only', 'Grip Only', 'Charm Only'];

/**
 * Coerce an arbitrary {styleKey: truthy} map into a clean boolean map over the
 * 6 known styles. "Case Only" is forced on (a listing must always offer the
 * bare case), so the operator can never ship an empty listing.
 */
function normaliseEnabledStyles(input = {}) {
  const out = {};
  for (const key of STYLE_ORDER) out[key] = Boolean(input[key]);
  out['Case Only'] = true;
  return out;
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
  const { prices = {}, imageAnalysis = [], restockQuantity = 3, readinessStateId = null } = args;
  // Model availability: an explicit list override wins; otherwise honour the
  // enabledModels map (default = all 12). Disabled models are OMITTED entirely so
  // buyers never see an unavailable model in the dropdown.
  const models = args.models && args.models.length
    ? args.models
    : enabledModelList(args.enabledModels);
  // An explicit enabledStyles override (operator-adjusted) wins; otherwise derive
  // from the AI image analysis. Always sanitised to the 6 known style keys.
  const enabledStyles = args.enabledStyles && Object.keys(args.enabledStyles).length
    ? normaliseEnabledStyles(args.enabledStyles)
    : computeEnabledStyles(imageAnalysis);

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
      const offering = { price, quantity, is_enabled: enabled };
      // Etsy requires a processing profile on every offering of a physical listing.
      if (readinessStateId != null) offering.readiness_state_id = readinessStateId;
      products.push({
        property_values: [
          { property_id: PROP_PHONE_MODEL, property_name: 'Phone Model', values: [model], value_ids: [] },
          { property_id: PROP_STYLES,      property_name: 'Styles',      values: [style.label], value_ids: [] },
        ],
        offerings: [offering],
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
  MODEL_ORDER,
  MODEL_DESCRIPTION_NAMES,
  ALL_DESCRIPTION_NAMES,
  STYLES,
  STYLE_ORDER,
  computeEnabledStyles,
  enabledStylesFor,
  normaliseEnabledStyles,
  normaliseEnabledModels,
  enabledModelList,
  compatibilityNamesFor,
  buildInventory,
  buildVariationImages,
};
