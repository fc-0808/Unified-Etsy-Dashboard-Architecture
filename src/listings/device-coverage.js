'use strict';

/**
 * Device-model coverage for the Listings tab.
 *
 * Source of truth is the local `listing_inventory` cache, filled during the
 * documented shop-listings walk (`includes=Images,Inventory`). This module
 * never calls Etsy: showing models in the dashboard is a read of data the
 * operator already synced, not a new per-listing inventory fetch.
 *
 * Inventory `secondary_value` is the fit axis (Phone Model / AirPods Model /
 * Band Size, and iPad Model on the single-axis line). Titles are a last-resort
 * display fallback so a row still names the device when that cache is empty —
 * they are labelled as title-derived so they cannot be mistaken for live
 * variation data.
 */

const productTypes = require('./product-types');

const FAMILY_LABELS = {
  [productTypes.FAMILY_IPHONE]: 'iPhone',
  [productTypes.FAMILY_AIRPODS]: 'AirPods',
  [productTypes.FAMILY_WATCH]: 'Apple Watch',
  [productTypes.FAMILY_IPAD]: 'iPad',
};

function collapseWs(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function listingKey(id) {
  const numeric = Number(id);
  return Number.isFinite(numeric) ? numeric : id;
}

function inferFamily(models, title) {
  for (const model of models || []) {
    const typed = productTypes.typedModelFamily(model);
    if (typed) return typed;
  }
  return productTypes.deviceFamilyOf((models && models[0]) || '', title);
}

/**
 * Distinct fit-axis values already cached for each listing.
 *
 * @param {Array<{listing_id: number|string, secondary_value?: string|null}>} rows
 * @returns {Map<number|string, string[]>}
 */
function groupModelsByListing(rows) {
  const grouped = new Map();
  for (const row of rows || []) {
    const raw = collapseWs(row && row.secondary_value);
    if (!raw) continue;
    const key = listingKey(row.listing_id);
    let entry = grouped.get(key);
    if (!entry) {
      entry = { models: [], seen: new Set() };
      grouped.set(key, entry);
    }
    const norm = raw.toLowerCase();
    if (entry.seen.has(norm)) continue;
    entry.seen.add(norm);
    entry.models.push(raw);
  }
  const out = new Map();
  for (const [key, entry] of grouped) out.set(key, entry.models);
  return out;
}

function modelsForListing(grouped, listingId) {
  if (!grouped) return [];
  if (grouped.has(listingId)) return grouped.get(listingId);
  const key = listingKey(listingId);
  return grouped.get(key) || [];
}

function fallbackPhraseFromTitle(title, family) {
  const text = String(title || '');
  if (!text) return '';

  if (family === productTypes.FAMILY_AIRPODS) {
    const match = text.match(
      /AirPods Pro(?:\s+\d+)+(?:\s*&\s*AirPods(?:\s+\d+)*)?|AirPods(?:\s+\d+)+/i,
    );
    return match ? collapseWs(match[0]) : '';
  }
  if (family === productTypes.FAMILY_WATCH) {
    return /apple\s*watch/i.test(text) ? 'Apple Watch' : '';
  }
  if (family === productTypes.FAMILY_IPAD) {
    const match = text.match(/\biPad\b[^,]{0,48}/i);
    return match ? collapseWs(match[0]) : '';
  }

  const match = text.match(/\biPhone(?:\s+\d+(?:\s*\/\s*\d+)?)+(?:\s+Pro(?:\s*Max)?)?/i);
  return match ? collapseWs(match[0]) : '';
}

function orderedModels(family, models) {
  const unique = [];
  const seen = new Set();
  for (const model of models || []) {
    const raw = collapseWs(model);
    if (!raw) continue;
    const norm = raw.toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    unique.push(raw);
  }
  if (!unique.length) return [];

  const canonical = productTypes.canonicalModelsForFamily(family) || [];
  const wanted = new Set(unique.map((model) => model.toLowerCase()));
  const out = [];
  for (const model of canonical) {
    const norm = String(model).trim().toLowerCase();
    if (!wanted.has(norm)) continue;
    wanted.delete(norm);
    out.push(model);
  }
  for (const model of unique) {
    if (wanted.has(model.toLowerCase())) out.push(model);
  }
  return out;
}

function chipLabel(model, family) {
  const raw = collapseWs(model);
  if (!raw) return '';
  if (family === productTypes.FAMILY_IPHONE) {
    return raw.replace(/^iPhone\s+/i, '') || raw;
  }
  if (family === productTypes.FAMILY_AIRPODS) {
    return raw.replace(/^Air\s*Pods?\s+/i, '') || raw;
  }
  if (family === productTypes.FAMILY_IPAD) {
    return raw.replace(/^iPad\s+/i, '') || raw;
  }
  return raw;
}

/**
 * Compact, scannable coverage for one listing.
 *
 * @param {{models?: string[], title?: string}} [input]
 * @returns {{
 *   family: string,
 *   family_label: string,
 *   models: string[],
 *   chips: string[],
 *   summary: string,
 *   source: 'inventory'|'title'|'none',
 * }}
 */
function summarizeDeviceCoverage(input = {}) {
  const title = input.title || '';
  const inventoryModels = Array.isArray(input.models) ? input.models : [];
  const family = inferFamily(inventoryModels, title);
  const familyLabel = FAMILY_LABELS[family] || 'Models';

  const ordered = orderedModels(family, inventoryModels);
  if (ordered.length) {
    const chips = ordered.map((model) => chipLabel(model, family));
    return {
      family,
      family_label: familyLabel,
      models: ordered,
      chips,
      summary: `${familyLabel} ${chips.join(' · ')}`.trim(),
      source: 'inventory',
    };
  }

  const phrase = fallbackPhraseFromTitle(title, family);
  if (phrase) {
    const chips = [chipLabel(phrase, family)];
    return {
      family,
      family_label: familyLabel,
      models: [phrase],
      chips,
      summary: phrase,
      source: 'title',
    };
  }

  return {
    family,
    family_label: familyLabel,
    models: [],
    chips: [],
    summary: '',
    source: 'none',
  };
}

/**
 * Attach dashboard coverage to listing payloads without extra Etsy I/O.
 *
 * @param {Array<{listing_id: number|string, title?: string}>} listings
 * @param {Array<{listing_id: number|string, secondary_value?: string|null}>} modelRows
 */
function attachDeviceCoverageToListings(listings, modelRows) {
  const grouped = groupModelsByListing(modelRows);
  return (listings || []).map((listing) => ({
    ...listing,
    device_coverage: summarizeDeviceCoverage({
      models: modelsForListing(grouped, listing.listing_id),
      title: listing.title,
    }),
  }));
}

module.exports = {
  FAMILY_LABELS,
  attachDeviceCoverageToListings,
  groupModelsByListing,
  summarizeDeviceCoverage,
};
