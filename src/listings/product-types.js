'use strict';

/**
 * Product-type registry for the Bulk Listing Creator.
 *
 * A "product type" is the single source of truth for everything that differs
 * between the physical products this shop sells — the device-model variation
 * dimension, the allowed style bundles, the Etsy taxonomy to resolve, the copy
 * vocabulary, and the storefront section keywords. The rest of the pipeline
 * (scanner → AI → variation matrix → Etsy create) is product-type agnostic and
 * simply reads from the descriptor returned here.
 *
 * Adding a new product type (e.g. "Phone Grip", "Charger Case") is a matter of
 * appending one descriptor below — no changes to the pipeline are required.
 *
 * `iphone_case` reproduces the historical behaviour exactly and is the default,
 * so any caller that does not specify a product type keeps working unchanged.
 */

// Canonical style keys shared with pricing.js / variation-builder.js.
const ALL_STYLE_KEYS = ['Case+Grip+Charm', 'Case+Grip', 'Case+Charm', 'Case Only', 'Grip Only', 'Charm Only'];

// ── Descriptors ──────────────────────────────────────────────────────────────

const IPHONE_CASE = {
  id: 'iphone_case',
  label: 'iPhone Case',
  // Device family + nouns used to parameterise the AI prompts.
  deviceWord: 'iPhone',
  deviceNoun: 'phone case',
  deviceShort: 'iPhone case',
  deviceLabel: 'iPhone models',
  // Ordered "Phone Model" variation values (newest first). "iPhone 14/13" is a
  // single combined offering. Verbatim from the original variation-builder.
  models: [
    'iPhone 17 Pro Max', 'iPhone 17 Pro', 'iPhone 17',
    'iPhone 16 Pro Max', 'iPhone 16 Pro', 'iPhone 16',
    'iPhone 15 Pro Max', 'iPhone 15 Pro', 'iPhone 15',
    'iPhone 14 Pro Max', 'iPhone 14 Pro', 'iPhone 14/13',
  ],
  // How a variation model expands into buyer-facing compatibility names.
  modelDescriptionNames: { 'iPhone 14/13': ['iPhone 14', 'iPhone 13'] },
  // Etsy custom variation property (Custom Property 1).
  deviceProperty: { id: 513, name: 'Phone Model' },
  // Taxonomy resolution candidates (tried in order by findTaxonomyId).
  taxonomyKeywords: [['phone case'], ['cell phone case'], ['phone', 'case']],
  // Which shop section to auto-select as the default for this product type.
  sectionKeywords: /iphone|phone|case/i,
  materials: ['Silicone'],
  supportsGrip: true,
  supportsMagsafe: true,
  // Every style bundle is applicable to an iPhone case.
  allowedStyles: ALL_STYLE_KEYS.slice(),
  // Extra "these models are NOT available" note appended to the description.
  unavailableNote: ['all Plus, Mini, Air and "e" models', 'iPhone 13 Pro / Pro Max'],
  // Universal SEO tags the AI must always include for this device.
  universalTags: ['kawaii phone case', 'cute iphone case', 'y2k phone case'],
  deviceTagExamples: ['iphone 17 case', 'iphone 16 pro max'],
};

const AIRPODS_CASE = {
  id: 'airpods_case',
  label: 'AirPods Case',
  deviceWord: 'AirPods',
  deviceNoun: 'AirPods case',
  deviceShort: 'AirPods case',
  deviceLabel: 'AirPods models',
  // Ordered "AirPods Model" variation values (newest first). "AirPods Pro" is
  // the 1st-generation Pro (no numeric suffix).
  models: [
    'AirPods Pro 3', 'AirPods Pro 2', 'AirPods Pro',
    'AirPods 4', 'AirPods 3', 'AirPods 2', 'AirPods 1',
  ],
  modelDescriptionNames: {}, // AirPods model names are already buyer-facing.
  deviceProperty: { id: 513, name: 'AirPods Model' },
  // Etsy taxonomy for AirPods/earbud cases. Several candidates so we resolve
  // whichever node this seller taxonomy exposes; the operator can override.
  taxonomyKeywords: [
    ['earbud', 'case'], ['headphone', 'case'], ['earphone', 'case'],
    ['airpod'], ['earbud'], ['headphone'],
  ],
  sectionKeywords: /airpod|earbud|earphone|headphone/i,
  materials: ['Silicone'],
  // AirPods cases don't take a phone grip, and MagSafe is not a selling point.
  supportsGrip: false,
  supportsMagsafe: false,
  // Only the case and an optional dangling charm/keychain clip apply.
  allowedStyles: ['Case+Charm', 'Case Only', 'Charm Only'],
  unavailableNote: ['AirPods Max', 'any non-listed generation'],
  universalTags: ['airpods case', 'cute airpods case', 'kawaii airpods case'],
  deviceTagExamples: ['airpods pro 2 case', 'airpods 3 case'],
};

const PRODUCT_TYPES = {
  [IPHONE_CASE.id]: IPHONE_CASE,
  [AIRPODS_CASE.id]: AIRPODS_CASE,
};

const DEFAULT_PRODUCT_TYPE = IPHONE_CASE.id;

// ── Accessors ────────────────────────────────────────────────────────────────

/** Resolve a product-type descriptor from an id (or a descriptor). Defaults to iPhone. */
function getProductType(idOrPt) {
  if (idOrPt && typeof idOrPt === 'object' && idOrPt.id) return idOrPt;
  return PRODUCT_TYPES[idOrPt] || PRODUCT_TYPES[DEFAULT_PRODUCT_TYPE];
}

/** Public list for UI dropdowns. */
function listProductTypes() {
  return Object.values(PRODUCT_TYPES).map((p) => ({ id: p.id, label: p.label }));
}

// ── Device-model helpers (parameterised by product type) ─────────────────────

/**
 * Coerce an arbitrary {model: truthy} map into a clean boolean map over the
 * type's known models. If the input enables nothing, every model is enabled — a
 * listing must always offer at least one device model.
 */
function normaliseEnabledModels(idOrPt, input) {
  const pt = getProductType(idOrPt);
  const order = pt.models;
  if (!input || typeof input !== 'object' || !Object.keys(input).length) {
    const all = {};
    for (const m of order) all[m] = true;
    return all;
  }
  const out = {};
  let anyOn = false;
  for (const m of order) {
    out[m] = Boolean(input[m]);
    if (out[m]) anyOn = true;
  }
  if (!anyOn) for (const m of order) out[m] = true;
  return out;
}

/** The enabled variation models, in display order. */
function enabledModelList(idOrPt, enabledModels) {
  const pt = getProductType(idOrPt);
  const norm = normaliseEnabledModels(pt, enabledModels);
  return pt.models.filter((m) => norm[m]);
}

/** Buyer-facing description model names for the enabled models (combined models expand). */
function compatibilityNamesFor(idOrPt, enabledModels) {
  const pt = getProductType(idOrPt);
  const out = [];
  for (const m of enabledModelList(pt, enabledModels)) {
    const names = pt.modelDescriptionNames[m] || [m];
    for (const n of names) out.push(n);
  }
  return out;
}

/** Every possible buyer-facing description model name across all models. */
function allDescriptionNames(idOrPt) {
  const pt = getProductType(idOrPt);
  const out = [];
  for (const m of pt.models) {
    const names = pt.modelDescriptionNames[m] || [m];
    for (const n of names) out.push(n);
  }
  return out;
}

/**
 * The compact device string for the TITLE, derived from the enabled models.
 *   iPhone : all → "iPhone 17 16 15 14 13 Pro Max"; 15-17 → "iPhone 17 16 15 Pro Max".
 *   AirPods: "AirPods Pro 3 2 1 & AirPods 4 3 2 1" (only the offered generations).
 */
function titleDevicePhrase(idOrPt, enabledModels) {
  const pt = getProductType(idOrPt);
  const names = compatibilityNamesFor(pt, enabledModels);
  if (!names.length) return pt.deviceWord;

  if (pt.id === 'airpods_case') {
    const proNums = [];
    const baseNums = [];
    for (const n of names) {
      const pro = /pro/i.test(n);
      const m = n.match(/(\d+)/);
      const num = m ? Number(m[1]) : 1; // "AirPods Pro" (no number) = gen 1
      if (pro) proNums.push(num);
      else if (m) baseNums.push(num);
    }
    const desc = (a) => [...new Set(a)].sort((x, y) => y - x);
    const parts = [];
    if (proNums.length) parts.push(`AirPods Pro ${desc(proNums).join(' ')}`);
    if (baseNums.length) parts.push(`AirPods ${desc(baseNums).join(' ')}`);
    return parts.join(' & ') || 'AirPods';
  }

  // iPhone (and any numeric phone-style device).
  const nums = [];
  for (const n of names) {
    const m = n.match(/(\d+)/);
    if (m && !nums.includes(m[1])) nums.push(m[1]);
  }
  nums.sort((a, b) => Number(b) - Number(a));
  const anyProMax = names.some((n) => /pro max/i.test(n));
  if (!nums.length) return pt.deviceWord;
  return `${pt.deviceWord} ${nums.join(' ')}${anyProMax ? ' Pro Max' : ''}`;
}

module.exports = {
  ALL_STYLE_KEYS,
  PRODUCT_TYPES,
  DEFAULT_PRODUCT_TYPE,
  getProductType,
  listProductTypes,
  normaliseEnabledModels,
  enabledModelList,
  compatibilityNamesFor,
  allDescriptionNames,
  titleDevicePhrase,
};
