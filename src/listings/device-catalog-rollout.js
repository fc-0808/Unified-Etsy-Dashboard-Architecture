'use strict';

/**
 * Additive device-generation rollout for live Etsy listings.
 *
 * New drafts already emit the full model list from product-types.js. Live
 * listings must NOT be rebuilt from that list: an operator may have turned a
 * generation off, custom styles may exist, and prices/qty are per listing.
 *
 * This module only INJECTS the generations declared in
 * DEVICE_GENERATION_ADDITIONS, by cloning the style × offering matrix of the
 * closest existing sibling model. Existing products are preserved byte-for-byte
 * (after the same field-stripping Etsy's inventory PUT requires).
 *
 * Etsy replaces the entire products array on PUT. Omitting a row deletes it
 * for buyers. That is why every existing product is echoed back.
 */

const productTypes = require('./product-types');
const { retitleForModelsWithinLimit, insertMissingModelsInDescription } = require('./ai-generator');

/** Etsy listing-inventory hard cap (products = model × style rows). */
const ETSY_MAX_INVENTORY_PRODUCTS = 400;
const ETSY_TITLE_MAX = 140;
const ETSY_DESCRIPTION_MAX = 13000;

const ROLLOUT_ID = 'iphone18-pro-airpods5-2026';
const ROLLOUT_LABEL = 'iPhone 18 Pro / 18 Pro Max and AirPods 5';

/** Product lines this rollout is allowed to touch. Watch / iPad stay out. */
const ROLLOUT_PRODUCT_TYPES = Object.freeze(['iphone_case', 'airpods_case']);

function currentRolloutSpec() {
  const additions = {};
  for (const pt of productTypes.listProductTypes()) {
    const models = productTypes.generationAdditionsFor(pt.id);
    if (models.length) additions[pt.id] = models;
  }
  return {
    id: ROLLOUT_ID,
    label: ROLLOUT_LABEL,
    additions,
    product_types: ROLLOUT_PRODUCT_TYPES.slice(),
  };
}

/**
 * Restrict a run to iPhone cases, AirPods cases, or both.
 * `null` / omitted → both lines. An explicit empty array stays empty so the
 * job manager can refuse to start rather than silently updating everything.
 */
function normalizeProductTypes(raw) {
  if (raw == null || raw === '') return ROLLOUT_PRODUCT_TYPES.slice();
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];
  const seen = new Set();
  for (const id of list) {
    const key = String(id || '').trim();
    if (!ROLLOUT_PRODUCT_TYPES.includes(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function norm(value) {
  return String(value ?? '').trim().toLowerCase();
}

function moneyToNumber(price) {
  if (price && typeof price === 'object') {
    const amount = Number(price.amount);
    const divisor = Number(price.divisor);
    if (Number.isFinite(amount) && Number.isFinite(divisor) && divisor !== 0) {
      return amount / divisor;
    }
    return NaN;
  }
  return Number(price);
}

function offeringPrice(offering) {
  return moneyToNumber(offering && offering.price);
}

function modelValueOf(product) {
  const props = Array.isArray(product && product.property_values) ? product.property_values : [];
  const device = props.find((pv) => {
    const id = Number(pv && pv.property_id);
    if (id === productTypes.PROP_DEVICE) return true;
    const name = String(pv && pv.property_name || '').trim().toLowerCase();
    return name === 'phone model' || name === 'airpods model' || name === 'band size';
  });
  const value = device && Array.isArray(device.values) ? device.values[0] : null;
  return value == null ? '' : String(value).trim();
}

function extractModels(inventory) {
  const seen = [];
  const seenNorm = new Set();
  for (const product of inventory && inventory.products || []) {
    const model = modelValueOf(product);
    const key = norm(model);
    if (!key || seenNorm.has(key)) continue;
    seenNorm.add(key);
    seen.push(model);
  }
  return seen;
}

function classifyFromPropertyValues(propValues) {
  const props = Array.isArray(propValues) ? propValues : [];
  for (const pv of props) {
    const name = String(pv && pv.property_name || '').trim().toLowerCase();
    if (name === 'airpods model') return 'airpods_case';
    if (name === 'phone model') return 'iphone_case';
    if (name === 'band size' || name === 'ipad model' || name === 'band style' || name === 'band color') {
      return null;
    }
  }
  return undefined;
}

function classifyFromModels(models) {
  for (const model of models || []) {
    const family = productTypes.deviceFamilyOf(model, '');
    if (family === productTypes.FAMILY_WATCH || family === productTypes.FAMILY_IPAD) return null;
    if (family === productTypes.FAMILY_AIRPODS) return 'airpods_case';
    if (family === productTypes.FAMILY_IPHONE && /iphone/i.test(model)) return 'iphone_case';
  }
  return null;
}

/**
 * Resolve the product line of a live inventory payload. Returns null for
 * watch/iPad/unknown listings that this rollout must never touch.
 */
function classifyInventory(inventory) {
  const products = inventory && inventory.products || [];
  for (const product of products) {
    const fromProps = classifyFromPropertyValues(product.property_values);
    if (fromProps === null) return null;
    if (fromProps) return fromProps;
  }
  return classifyFromModels(extractModels(inventory));
}

function classifyCachedListing({ title, inventoryRows } = {}) {
  const rows = Array.isArray(inventoryRows) ? inventoryRows : [];
  const models = [];
  const seen = new Set();
  let productType;
  for (const row of rows) {
    let parsed = null;
    if (row && row.property_values) {
      try { parsed = typeof row.property_values === 'string' ? JSON.parse(row.property_values) : row.property_values; } catch { parsed = null; }
    }
    if (productType === undefined) {
      const fromProps = classifyFromPropertyValues(parsed);
      if (fromProps === null) return { productType: null, models: [], reason: 'unsupported_line' };
      if (fromProps) productType = fromProps;
    }
    const model = String(row && row.secondary_value || '').trim();
    const key = norm(model);
    if (key && !seen.has(key)) {
      seen.add(key);
      models.push(model);
    }
  }
  if (!productType) productType = classifyFromModels(models);
  if (!productType && !models.length) {
    const family = productTypes.deviceFamilyOf('', title);
    if (family === productTypes.FAMILY_WATCH || family === productTypes.FAMILY_IPAD) {
      return { productType: null, models, reason: 'unsupported_line' };
    }
    return { productType: null, models, reason: 'uncached' };
  }
  if (!productType) return { productType: null, models, reason: 'unsupported_line' };
  return { productType, models, reason: null };
}

function missingAdditions(productType, existingModels) {
  const additions = productTypes.generationAdditionsFor(productType);
  const have = new Set((existingModels || []).map(norm));
  return additions.filter((model) => !have.has(norm(model)));
}

function parseDeviceModel(name) {
  const raw = String(name || '').trim();
  const match = raw.match(/(\d+)/);
  const gen = match ? Number(match[1]) : 0;
  const proMax = /pro\s*max/i.test(raw);
  const pro = /pro/i.test(raw) && !proMax;
  return {
    raw,
    gen: Number.isFinite(gen) ? gen : 0,
    variant: proMax ? 'pro_max' : pro ? 'pro' : 'base',
  };
}

function scoreCloneSource(candidate, target) {
  const c = parseDeviceModel(candidate);
  const t = parseDeviceModel(target);
  let score = 0;
  if (c.variant === t.variant) score += 1000;
  else if (
    (c.variant === 'pro' && t.variant === 'pro_max')
    || (c.variant === 'pro_max' && t.variant === 'pro')
  ) score += 400;
  const delta = t.gen - c.gen;
  if (delta === 1) score += 300;
  else if (delta > 1) score += Math.max(0, 200 - delta * 20);
  else if (delta === 0) score += 50;
  else score += Math.max(0, 30 + delta * 10);
  score += c.gen;
  return score;
}

function pickCloneSource(existingModels, targetModel) {
  const pool = (existingModels || []).filter((m) => String(m || '').trim());
  if (!pool.length) return null;
  let best = pool[0];
  let bestScore = -Infinity;
  for (const candidate of pool) {
    const score = scoreCloneSource(candidate, targetModel);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function sanitizePropertyValue(pv, { replaceModel } = {}) {
  if (!pv || typeof pv !== 'object') return null;
  const isDevice = Number(pv.property_id) === productTypes.PROP_DEVICE
    || /^(phone model|airpods model|band size)$/i.test(String(pv.property_name || '').trim());
  const values = isDevice && replaceModel
    ? [replaceModel]
    : Array.isArray(pv.values) ? pv.values.slice() : [];
  const valueIds = isDevice && replaceModel
    ? []
    : Array.isArray(pv.value_ids) ? pv.value_ids.slice() : [];
  const out = {
    property_id: pv.property_id,
    property_name: pv.property_name,
    values,
    value_ids: valueIds,
  };
  if (pv.scale_id) out.scale_id = pv.scale_id;
  if (pv.scale_name) out.scale_name = pv.scale_name;
  return out;
}

function listingReadinessId(inventory) {
  for (const product of inventory && inventory.products || []) {
    for (const offering of product.offerings || []) {
      if (offering && offering.readiness_state_id != null) return offering.readiness_state_id;
    }
  }
  return null;
}

function sanitizeOffering(offering, { defaultReadiness } = {}) {
  if (!offering || offering.is_deleted) return null;
  const price = offeringPrice(offering);
  const quantity = Number(offering.quantity);
  const out = {
    price: Number.isFinite(price) ? Math.round(price * 100) / 100 : 0,
    quantity: Number.isFinite(quantity) ? Math.max(0, Math.floor(quantity)) : 0,
    is_enabled: offering.is_enabled !== false,
  };
  if (offering.is_enabled === false) out.is_enabled = false;
  const readiness = offering.readiness_state_id != null ? offering.readiness_state_id : defaultReadiness;
  if (readiness != null) out.readiness_state_id = readiness;
  return out;
}

function sanitizeProduct(product, { replaceModel, defaultReadiness } = {}) {
  if (!product || product.is_deleted) return null;
  const property_values = (product.property_values || [])
    .map((pv) => sanitizePropertyValue(pv, { replaceModel }))
    .filter(Boolean);
  const offerings = (product.offerings || [])
    .map((o) => sanitizeOffering(o, { defaultReadiness }))
    .filter(Boolean);
  if (!offerings.length) return null;
  const out = { property_values, offerings };
  // Cloned rows must not reuse the source SKU — Etsy requires unique SKUs
  // per product inside a listing. Existing rows keep theirs.
  if (!replaceModel && product.sku) out.sku = product.sku;
  return out;
}

function productsForModel(products, model) {
  const key = norm(model);
  return (products || []).filter((p) => norm(modelValueOf(p)) === key);
}

function cloneProductsForModel(sourceProducts, newModel, { defaultReadiness } = {}) {
  const cloned = [];
  for (const product of sourceProducts || []) {
    const next = sanitizeProduct(product, { replaceModel: newModel, defaultReadiness });
    if (next) cloned.push(next);
  }
  return cloned;
}

function orderedModels(productType, existingModels, addedModels) {
  const pt = productTypes.getProductType(productType);
  const keep = new Set([...existingModels, ...addedModels].map(norm));
  const out = [];
  const seen = new Set();
  for (const model of pt.models || []) {
    if (!keep.has(norm(model)) || seen.has(norm(model))) continue;
    seen.add(norm(model));
    out.push(model);
  }
  for (const model of existingModels || []) {
    if (seen.has(norm(model))) continue;
    seen.add(norm(model));
    out.push(model);
  }
  return out;
}

function styleValueIdMap(inventory, productType) {
  const styleProp = productTypes.stylePropertyFor(productType);
  const map = new Map();
  for (const product of inventory && inventory.products || []) {
    for (const pv of product.property_values || []) {
      const match = Number(pv.property_id) === styleProp.id
        || String(pv.property_name || '').trim().toLowerCase() === String(styleProp.name || '').trim().toLowerCase();
      if (!match) continue;
      const label = pv.values && pv.values[0] != null ? String(pv.values[0]) : '';
      const valueId = pv.value_ids && pv.value_ids[0];
      if (label && valueId != null && !map.has(label)) map.set(label, valueId);
    }
  }
  return map;
}

function styleValueIdsChanged(before, after) {
  if (!(before instanceof Map) || !(after instanceof Map)) return true;
  if (before.size !== after.size) return true;
  for (const [label, valueId] of before) {
    if (after.get(label) !== valueId) return true;
  }
  return false;
}

function remapVariationImages(links, styleValueIds) {
  const out = [];
  const seen = new Set();
  for (const link of Array.isArray(links) ? links : []) {
    const label = link && (link.value != null ? String(link.value) : '');
    const imageId = Number(link && link.image_id);
    const propertyId = Number(link && link.property_id) || productTypes.PROP_CHOICE;
    if (!label || !Number.isFinite(imageId) || imageId <= 0) continue;
    const valueId = styleValueIds.get(label);
    if (valueId == null) continue;
    const key = `${propertyId}:${valueId}:${imageId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ property_id: propertyId, value_id: valueId, image_id: imageId });
  }
  return out;
}

function toPutInventoryBody(inventory, products) {
  return {
    products,
    price_on_property: inventory.price_on_property ?? [productTypes.PROP_CHOICE],
    quantity_on_property: inventory.quantity_on_property ?? [productTypes.PROP_CHOICE],
    sku_on_property: inventory.sku_on_property ?? [],
    readiness_state_on_property: inventory.readiness_state_on_property ?? [],
  };
}

/**
 * Build the inventory PUT body that adds missing generation values.
 *
 * @returns {{
 *   changed: boolean,
 *   reason: string|null,
 *   productType: string|null,
 *   existingModels: string[],
 *   addedModels: string[],
 *   cloneSources: Record<string,string>,
 *   body: object|null,
 *   productCount: number,
 * }}
 */
function applyRollout(inventory, opts = {}) {
  const productType = classifyInventory(inventory);
  const existingModels = extractModels(inventory);
  const allowedTypes = new Set(normalizeProductTypes(opts.product_types));
  const empty = {
    changed: false,
    reason: 'not_applicable',
    productType,
    existingModels,
    addedModels: [],
    cloneSources: {},
    body: null,
    productCount: (inventory && inventory.products || []).length,
  };
  if (!productType) return empty;
  if (!allowedTypes.has(productType)) {
    return { ...empty, reason: 'filtered_out' };
  }

  const missing = missingAdditions(productType, existingModels);
  if (!missing.length) {
    return { ...empty, reason: 'already_current' };
  }
  if (!existingModels.length) {
    return { ...empty, reason: 'no_clone_source' };
  }

  const defaultReadiness = listingReadinessId(inventory);
  const original = inventory.products || [];
  const groups = new Map();
  for (const model of existingModels) {
    groups.set(
      norm(model),
      productsForModel(original, model)
        .map((p) => sanitizeProduct(p, { defaultReadiness }))
        .filter(Boolean)
    );
  }

  const addedModels = [];
  const cloneSources = {};
  const clonedGroups = new Map();
  for (const model of missing) {
    const sourceName = pickCloneSource(existingModels, model);
    const sourceRows = sourceName ? groups.get(norm(sourceName)) : null;
    if (!sourceName || !sourceRows || !sourceRows.length) continue;
    const cloned = cloneProductsForModel(productsForModel(original, sourceName), model, { defaultReadiness });
    if (!cloned.length) continue;
    addedModels.push(model);
    cloneSources[model] = sourceName;
    clonedGroups.set(norm(model), cloned);
  }
  if (!addedModels.length) {
    return { ...empty, reason: 'no_clone_source' };
  }

  const order = orderedModels(productType, existingModels, addedModels);
  const products = [];
  for (const model of order) {
    const key = norm(model);
    const rows = clonedGroups.get(key) || groups.get(key) || [];
    products.push(...rows);
  }
  if (products.length > ETSY_MAX_INVENTORY_PRODUCTS) {
    return { ...empty, reason: 'would_exceed_limit', productCount: products.length };
  }
  if (!products.length) {
    return { ...empty, reason: 'empty_inventory' };
  }

  return {
    changed: true,
    reason: null,
    productType,
    existingModels,
    addedModels,
    cloneSources,
    body: toPutInventoryBody(inventory, products),
    productCount: products.length,
  };
}

function enabledMapFor(models) {
  const map = {};
  for (const model of models || []) {
    if (model) map[model] = true;
  }
  return map;
}

/**
 * Title + description patch for a listing that just gained models.
 * Never fabricates copy: if the existing title has no compact device phrase,
 * it is left alone. Titles that would exceed Etsy's 140-character cap first
 * try a shorter generation run (oldest gens dropped, new gens kept). If that
 * still cannot fit, the title is left unchanged so we never ship a truncated
 * string.
 */
function planCopyUpdates({ title, description, productType, existingModels, addedModels }) {
  const offered = [...existingModels, ...addedModels];
  const enabled = enabledMapFor(offered);
  const result = {
    title: title || '',
    description: description || '',
    titleChanged: false,
    descriptionChanged: false,
    skipped: null,
    compacted: false,
  };
  if (!productType || !addedModels.length) return result;

  const fitted = retitleForModelsWithinLimit(result.title, enabled, productType, {
    maxLen: ETSY_TITLE_MAX,
    mustIncludeModels: addedModels,
  });
  if (fitted.changed) {
    result.title = fitted.title;
    result.titleChanged = true;
    result.compacted = !!fitted.compacted;
  } else if (fitted.skipped) {
    result.skipped = fitted.skipped;
  }

  const nextDesc = insertMissingModelsInDescription(result.description, enabled, productType);
  if (nextDesc && nextDesc !== result.description) {
    if (nextDesc.length > ETSY_DESCRIPTION_MAX) {
      result.skipped = result.skipped || 'description_would_exceed_limit';
    } else {
      result.description = nextDesc;
      result.descriptionChanged = true;
    }
  }
  return result;
}

function describeCopyPlan(copy) {
  const parts = [];
  if (copy && copy.titleChanged && copy.compacted) parts.push('Update title (fitted to 140-char cap)');
  else if (copy && copy.titleChanged) parts.push('Update title');
  if (copy && copy.descriptionChanged) parts.push('Add compatibility bullets');
  if (copy && copy.skipped === 'title_would_exceed_limit') {
    parts.push('Title unchanged (Etsy 140-char cap)');
  }
  if (copy && copy.skipped === 'description_would_exceed_limit') {
    parts.push('Description unchanged (Etsy 13,000-char cap)');
  }
  return parts.length ? parts.join(' · ') : 'Variations only';
}

/**
 * Operator-facing review fields. Recomputes title copy from the listing's
 * current title so a dry-run stored before the 140-char fitter still shows
 * the same decision live apply will make.
 */
function enrichReviewPlan(plan, row = {}) {
  const next = plan && typeof plan === 'object' ? { ...plan } : {};
  const title = String(row.title || '');
  const productType = row.product_type || '';
  const added = Array.isArray(row.added_models) ? row.added_models : [];
  const existing = Array.isArray(row.existing_models) ? row.existing_models : [];

  if (title && productType && added.length) {
    const fresh = planCopyUpdates({
      title,
      description: '',
      productType,
      existingModels: existing,
      addedModels: added,
    });
    if (fresh.titleChanged) {
      next.copy_title = true;
      next.copy_compacted = !!fresh.compacted;
      next.next_title = fresh.title;
      if (next.copy_skipped === 'title_would_exceed_limit') next.copy_skipped = null;
    } else if (fresh.skipped === 'title_would_exceed_limit') {
      next.copy_title = false;
      next.copy_compacted = false;
      next.next_title = null;
      next.copy_skipped = 'title_would_exceed_limit';
    }
  }

  next.copy_label = describeCopyPlan({
    titleChanged: !!next.copy_title,
    descriptionChanged: !!next.copy_description,
    skipped: next.copy_skipped || null,
    compacted: !!next.copy_compacted,
  });
  return Object.keys(next).length ? next : null;
}

function reconstructInventoryFromCache(inventoryRows) {
  const products = [];
  for (const row of inventoryRows || []) {
    let property_values = row && row.property_values;
    if (typeof property_values === 'string') {
      try { property_values = JSON.parse(property_values); } catch { property_values = []; }
    }
    if (!Array.isArray(property_values) || !property_values.length) continue;
    products.push({
      product_id: row.product_id,
      property_values,
      offerings: [{
        price: Number.isFinite(Number(row.price_amount)) ? Number(row.price_amount) : 0,
        quantity: Number.isFinite(Number(row.quantity)) ? Number(row.quantity) : 0,
        is_enabled: row.is_enabled !== 0 && row.is_enabled !== false,
      }],
    });
  }
  return {
    products,
    price_on_property: [productTypes.PROP_CHOICE],
    quantity_on_property: [productTypes.PROP_CHOICE],
    sku_on_property: [],
    readiness_state_on_property: [],
  };
}

function nameOnlyClonePlan(existingModels, missingModels) {
  const addedModels = [];
  const cloneSources = {};
  for (const model of missingModels || []) {
    const source = pickCloneSource(existingModels, model);
    if (!source) continue;
    addedModels.push(model);
    cloneSources[model] = source;
  }
  return { addedModels, cloneSources };
}

/**
 * Dry-run plan from the local listings cache. Never talks to Etsy.
 * Live apply still GET+PUTs the real inventory; this is only for review.
 */
function planFromCachedListing({
  title,
  description,
  inventoryRows,
  existingModels,
  missingModels,
  productTypes: typeFilter,
  updateCopy,
} = {}) {
  const inventory = reconstructInventoryFromCache(inventoryRows);
  let plan = applyRollout(inventory, { product_types: typeFilter });
  const cachedExisting = (existingModels && existingModels.length)
    ? existingModels
    : plan.existingModels;
  const cachedMissing = (missingModels && missingModels.length)
    ? missingModels
    : missingAdditions(plan.productType, cachedExisting);

  if (
    !plan.changed
    && plan.reason !== 'would_exceed_limit'
    && plan.reason !== 'filtered_out'
  ) {
    const fallback = nameOnlyClonePlan(cachedExisting, cachedMissing);
    if (fallback.addedModels.length) {
      plan = {
        ...plan,
        changed: true,
        addedModels: fallback.addedModels,
        cloneSources: fallback.cloneSources,
        existingModels: cachedExisting.length ? cachedExisting : plan.existingModels,
      };
    }
  }

  const copy = updateCopy !== false
    ? planCopyUpdates({
        title: title || '',
        description: description || '',
        productType: plan.productType,
        existingModels: plan.existingModels && plan.existingModels.length ? plan.existingModels : cachedExisting,
        addedModels: plan.addedModels,
      })
    : {
        title: title || '',
        description: description || '',
        titleChanged: false,
        descriptionChanged: false,
        skipped: null,
        compacted: false,
      };

  return {
    ...plan,
    copy,
    review: {
      added_models: plan.addedModels,
      clone_sources: plan.cloneSources,
      product_count: plan.productCount,
      copy_title: !!copy.titleChanged,
      copy_description: !!copy.descriptionChanged,
      copy_compacted: !!copy.compacted,
      copy_skipped: copy.skipped || null,
      copy_label: describeCopyPlan(copy),
      next_title: copy.titleChanged ? copy.title : null,
      reason: plan.reason,
    },
    block: plan.reason === 'would_exceed_limit',
  };
}

function estimateApiCalls(neededListings, { updateCopy = true } = {}) {
  const n = Math.max(0, Number(neededListings) || 0);
  const min = n * 2; // GET inventory + PUT inventory
  const max = n * (updateCopy ? 4 : 3); // optional title PATCH + rare variation-image rematch
  return { min, max, per_listing_min: 2, per_listing_max: updateCopy ? 4 : 3 };
}

function clampDelayMs(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Human-paced delay: base plus [0, jitterMs) so successive listings do not
 * hit Etsy on a metronome. `random` is injectable for tests.
 */
function pacedDelayMs(baseMs, jitterMs, random = Math.random) {
  const base = Math.max(0, Number(baseMs) || 0);
  const span = Math.max(0, Number(jitterMs) || 0);
  const roll = typeof random === 'function' ? Number(random()) : 0;
  const unit = Number.isFinite(roll) ? Math.min(1, Math.max(0, roll)) : 0;
  return base + Math.floor(unit * span);
}

module.exports = {
  ETSY_MAX_INVENTORY_PRODUCTS,
  ETSY_TITLE_MAX,
  ETSY_DESCRIPTION_MAX,
  ROLLOUT_ID,
  ROLLOUT_LABEL,
  ROLLOUT_PRODUCT_TYPES,
  currentRolloutSpec,
  normalizeProductTypes,
  classifyInventory,
  classifyCachedListing,
  extractModels,
  missingAdditions,
  pickCloneSource,
  scoreCloneSource,
  listingReadinessId,
  applyRollout,
  planCopyUpdates,
  describeCopyPlan,
  enrichReviewPlan,
  planFromCachedListing,
  reconstructInventoryFromCache,
  styleValueIdMap,
  styleValueIdsChanged,
  remapVariationImages,
  estimateApiCalls,
  clampDelayMs,
  pacedDelayMs,
  sanitizeProduct,
  toPutInventoryBody,
};
