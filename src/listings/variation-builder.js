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

const productTypes = require('./product-types');

// Etsy custom variation property IDs (Custom Property 1 / 2). The Styles axis
// (514) is shared by every product type; the device axis (513) is named per
// product type ("Phone Model" for iPhone, "AirPods Model" for AirPods).
const PROP_PHONE_MODEL = 513;
const PROP_STYLES = 514;

// Backward-compatible iPhone model exports (the default product type). New code
// should read the model set from the product-type registry instead.
const PHONE_MODELS = productTypes.getProductType('iphone_case').models.slice();
const MODEL_ORDER = PHONE_MODELS.slice();
const MODEL_DESCRIPTION_NAMES = { 'iPhone 14/13': ['iPhone 14', 'iPhone 13'] };

/**
 * Coerce an arbitrary {model: truthy} map into a clean boolean map over the
 * product type's known models. Delegates to the registry; defaults to iPhone so
 * existing single-argument callers keep working unchanged.
 * @param {object} input                {model: truthy}
 * @param {string} [productType='iphone_case']
 */
function normaliseEnabledModels(input, productType) {
  return productTypes.normaliseEnabledModels(productType, input);
}

/** The enabled variation models, in display order. */
function enabledModelList(enabledModels, productType) {
  return productTypes.enabledModelList(productType, enabledModels);
}

/** Buyer-facing description model names for the enabled models (combined models expand). */
function compatibilityNamesFor(enabledModels, productType) {
  return productTypes.compatibilityNamesFor(productType, enabledModels);
}

/** Every possible buyer-facing description model name for the iPhone default. */
const ALL_DESCRIPTION_NAMES = productTypes.allDescriptionNames('iphone_case');

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
  return out;
}

// Etsy limits + guardrails for operator-defined custom variation values.
const CUSTOM_STYLE_MAX_LABEL = 45; // Etsy property-value length cap
const CUSTOM_STYLE_MAX_COUNT = 24; // keep models × styles well under Etsy's limits

/**
 * Sanitise an operator-defined list of CUSTOM style variations. Each entry
 * becomes one "Styles" variation value (e.g. "Case1 + Charm1") with its own
 * price and (optional) linked product-image rank. When a non-empty list is
 * returned it fully REPLACES the canonical bundle matrix for that listing.
 *
 * Rules: label required (trimmed, ≤45 chars) and unique (case-insensitive);
 * price must be a positive number; imageRank is a positive integer or null.
 * Invalid/duplicate rows are dropped. Order is preserved.
 *
 * @param {Array<{label?:string,price?:number,imageRank?:number,id?:string}>} input
 * @returns {Array<{id:string,label:string,price:number,imageRank:number|null}>}
 */
function normaliseCustomStyles(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const label = String(raw.label ?? '').trim().slice(0, CUSTOM_STYLE_MAX_LABEL);
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    const price = Number(raw.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    let imageRank = Number(raw.imageRank);
    imageRank = Number.isFinite(imageRank) && imageRank > 0 ? Math.floor(imageRank) : null;
    seen.add(key);
    out.push({
      id: String(raw.id || `cs_${out.length + 1}_${key.replace(/[^a-z0-9]+/g, '').slice(0, 12)}`),
      label,
      price: Math.round(price * 100) / 100,
      imageRank,
    });
    if (out.length >= CUSTOM_STYLE_MAX_COUNT) break;
  }
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
  const pt = productTypes.getProductType(args.productType);
  // Model availability: an explicit list override wins; otherwise honour the
  // enabledModels map (default = all). Disabled models are OMITTED entirely so
  // buyers never see an unavailable model in the dropdown.
  const models = args.models && args.models.length
    ? args.models
    : enabledModelList(args.enabledModels, pt);

  // An explicit enabledStyles override (operator-adjusted) wins; otherwise derive
  // from the AI image analysis. Always sanitised to the 6 known style keys, then
  // restricted to the styles this product type actually offers (e.g. AirPods
  // cases never offer a grip).
  const rawStyles = args.enabledStyles && Object.keys(args.enabledStyles).length
    ? normaliseEnabledStyles(args.enabledStyles)
    : computeEnabledStyles(imageAnalysis);
  const allowed = new Set(pt.allowedStyles || STYLE_ORDER);
  const enabledStyles = {};
  for (const key of STYLE_ORDER) enabledStyles[key] = allowed.has(key) && Boolean(rawStyles[key]);
  // Only build offerings for styles the product type supports.
  const offeredStyles = STYLES.filter((s) => allowed.has(s.key));
  const deviceProp = pt.deviceProperty || { id: PROP_PHONE_MODEL, name: 'Phone Model' };

  const products = [];
  let minPrice = Infinity;
  let listingQuantity = 0;

  // Canonical bundle offerings (Case/Grip/Charm…) and operator-defined CUSTOM
  // offerings are merged into ONE ordered list of "Styles" values. Custom values
  // are ADDED on top of the bundles; labels that collide with a canonical value
  // are dropped (Etsy rejects duplicate values).
  const canonicalLabels = new Set(offeredStyles.filter((s) => Number(prices[s.key]) > 0).map((s) => s.label));
  const customStyles = normaliseCustomStyles(args.customStyles).filter((s) => !canonicalLabels.has(s.label));

  // Invariant: a listing must always offer at least one VISIBLE variation (Etsy
  // rejects a listing with none). The operator may disable any single bundle —
  // including "Case Only" — as long as another bundle or a custom value is
  // enabled. If they somehow disable everything and define no custom values, we
  // re-enable a sensible default (Case Only, else the first priced bundle).
  const anyEnabledBundle = offeredStyles.some((s) => Number(prices[s.key]) > 0 && enabledStyles[s.key]);
  if (!anyEnabledBundle && !customStyles.length) {
    const fallback = offeredStyles.find((s) => s.key === 'Case Only' && Number(prices[s.key]) > 0)
      || offeredStyles.find((s) => Number(prices[s.key]) > 0);
    if (fallback) enabledStyles[fallback.key] = true;
  }

  // Build the display order: honour the operator's variationOrder (an array of the
  // "Styles" value labels), then append anything not listed. Etsy renders the
  // dropdown options in the order the values first appear in the products array,
  // so this order IS the buyer-facing option order.
  const canonByLabel = new Map(offeredStyles.map((s) => [s.label, s]));
  const customByLabel = new Map(customStyles.map((s) => [s.label, s]));
  const ordered = [];
  const usedCanon = new Set();
  const usedCustom = new Set();
  for (const label of Array.isArray(args.variationOrder) ? args.variationOrder : []) {
    if (canonByLabel.has(label) && !usedCanon.has(label)) { ordered.push({ kind: 'canon', style: canonByLabel.get(label) }); usedCanon.add(label); }
    else if (customByLabel.has(label) && !usedCustom.has(label)) { ordered.push({ kind: 'custom', style: customByLabel.get(label) }); usedCustom.add(label); }
  }
  for (const s of offeredStyles) if (!usedCanon.has(s.label)) ordered.push({ kind: 'canon', style: s });
  for (const s of customStyles) if (!usedCustom.has(s.label)) ordered.push({ kind: 'custom', style: s });

  for (const model of models) {
    for (const em of ordered) {
      if (em.kind === 'canon') {
        const style = em.style;
        const price = Number(prices[style.key]);
        if (!Number.isFinite(price) || price <= 0) continue; // no price → cannot offer
        const enabled = Boolean(enabledStyles[style.key]);
        const quantity = enabled ? restockQuantity : 0;
        if (enabled) {
          minPrice = Math.min(minPrice, price);
          listingQuantity += quantity;
        }
        const offering = { price, quantity, is_enabled: enabled };
        if (readinessStateId != null) offering.readiness_state_id = readinessStateId;
        products.push({
          property_values: [
            { property_id: deviceProp.id, property_name: deviceProp.name, values: [model], value_ids: [] },
            { property_id: PROP_STYLES,   property_name: 'Styles',        values: [style.label], value_ids: [] },
          ],
          offerings: [offering],
        });
      } else {
        const style = em.style;
        minPrice = Math.min(minPrice, style.price);
        listingQuantity += restockQuantity;
        const offering = { price: style.price, quantity: restockQuantity, is_enabled: true };
        if (readinessStateId != null) offering.readiness_state_id = readinessStateId;
        products.push({
          property_values: [
            { property_id: deviceProp.id, property_name: deviceProp.name, values: [model], value_ids: [] },
            { property_id: PROP_STYLES,   property_name: 'Styles',        values: [style.label], value_ids: [] },
          ],
          offerings: [offering],
        });
      }
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

  return { body, enabledStyles, customStyles, minPrice, listingQuantity };
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

/**
 * Variation-images payload for CUSTOM styles: link each custom value's chosen
 * product image (imageRank) to the Etsy value_id assigned to that label.
 *
 * @param {object} args
 * @param {Array<{label:string,imageRank:number|null}>} args.customStyles
 * @param {Map<number,number>} args.rankToImageId        rank → uploaded image_id
 * @param {Map<string,number>} args.styleLabelToValueId  custom label → value_id
 */
function buildCustomVariationImages({ customStyles = [], rankToImageId, styleLabelToValueId }) {
  const out = [];
  const seen = new Set();
  for (const style of customStyles) {
    if (!style || style.imageRank == null) continue;
    const valueId = styleLabelToValueId.get(style.label);
    if (valueId == null) continue;
    const imageId = rankToImageId.get(Number(style.imageRank));
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
  normaliseCustomStyles,
  normaliseEnabledModels,
  enabledModelList,
  compatibilityNamesFor,
  buildInventory,
  buildVariationImages,
  buildCustomVariationImages,
};
