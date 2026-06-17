'use strict';

/**
 * Listing attribute (taxonomy "feature section") resolver.
 *
 * Etsy's listing attributes — Primary/Secondary colour, Theme, Occasion,
 * Celebration/Holiday, Pattern, and phone-case booleans (Built-in grip, Card
 * slot, Glitter, Built-in stand, Liquid) — are taxonomy properties. Filling them
 * materially improves search placement and buyer filtering.
 *
 * Each property exposes a fixed set of possible_values (value_id + name). We must
 * send valid value_ids, so this module:
 *   1. Builds a compact "menu" of allowed values for the AI to choose from
 *      (Theme / Occasion / Celebration / Pattern).
 *   2. Resolves the chosen names + our known vision facts (colours, grip) back to
 *      { property_id, value_ids, values, scale_id } update payloads — skipping
 *      anything that doesn't map to a real value so Etsy never 400s.
 */

const { getPropertiesByTaxonomyId } = require('../etsy/client');

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Match a desired value name against a property's possible_values (robust). */
function findValue(property, wanted) {
  const w = norm(wanted);
  if (!w) return null;
  const vals = property.possible_values || [];
  // exact (case-insensitive) → then startsWith → then substring either way.
  return (
    vals.find((v) => norm(v.name) === w) ||
    vals.find((v) => norm(v.name).startsWith(w) || w.startsWith(norm(v.name))) ||
    vals.find((v) => norm(v.name).includes(w) || w.includes(norm(v.name))) ||
    null
  );
}

/** Which property is this (by display/name)? Returns a canonical key or null. */
function classifyProperty(property) {
  const n = norm(property.display_name || property.name);
  if (n === 'primary color' || n === 'primary colour') return 'primary_color';
  if (n === 'secondary color' || n === 'secondary colour') return 'secondary_color';
  if (n.includes('built-in grip') || n === 'built in grip') return 'built_in_grip';
  if (n.includes('built-in stand') || n === 'built in stand') return 'built_in_stand';
  if (n.includes('card slot')) return 'card_slot';
  if (n === 'glitter') return 'glitter';
  if (n === 'liquid') return 'liquid';
  if (n === 'theme') return 'theme';
  if (n === 'occasion') return 'occasion';
  if (n === 'celebration' || n === 'holiday') return 'celebration';
  if (n === 'pattern') return 'pattern';
  return null;
}

/**
 * Build the AI value menu for the free-choice attributes (so the model picks
 * real Etsy values). Keeps each list compact to control prompt size.
 * @returns {{theme:string[],occasion:string[],celebration:string[],pattern:string[]}}
 */
function buildAttributeMenu(properties) {
  const menu = { theme: [], occasion: [], celebration: [], pattern: [] };
  for (const p of properties || []) {
    const key = classifyProperty(p);
    if (key && key in menu) {
      menu[key] = (p.possible_values || []).map((v) => v.name).filter(Boolean);
    }
  }
  return menu;
}

/**
 * Resolve concrete attribute update payloads.
 *
 * @param {object} args
 * @param {object[]} args.properties   taxonomy properties (results)
 * @param {object} args.facts          { primaryColor, secondaryColor, hasGrip }
 * @param {object} args.ai             AI/derived: { theme, occasion, celebration, pattern, glitter, card_slot, built_in_stand, liquid }
 * @returns {Array<{property_id:number, property_name:string, value_ids:number[], values:string[], scale_id?:number}>}
 */
function resolveAttributes({ properties = [], facts = {}, ai = {} }) {
  const out = [];
  const boolWord = (b) => (b ? 'Yes' : 'No');

  // Desired value name(s) per canonical attribute key.
  const desired = {
    primary_color: facts.primaryColor || '',
    secondary_color: facts.secondaryColor || '',
    built_in_grip: facts.hasGrip != null ? boolWord(facts.hasGrip) : '',
    built_in_stand: ai.built_in_stand != null ? boolWord(ai.built_in_stand) : 'No',
    card_slot: ai.card_slot != null ? boolWord(ai.card_slot) : 'No',
    glitter: ai.glitter != null ? boolWord(ai.glitter) : '',
    liquid: ai.liquid != null ? boolWord(ai.liquid) : 'No',
    theme: ai.theme || '',
    occasion: ai.occasion || '',
    celebration: ai.celebration || '',
    pattern: ai.pattern || '',
  };

  for (const p of properties) {
    const key = classifyProperty(p);
    if (!key) continue;
    const want = desired[key];
    if (!want) continue;

    const match = findValue(p, want);
    if (!match) continue;

    const update = {
      property_id: p.property_id,
      property_name: p.display_name || p.name,
      value_ids: [match.value_id],
      values: [match.name],
    };
    if (match.scale_id) update.scale_id = match.scale_id;
    out.push(update);
  }
  return out;
}

/** Fetch taxonomy properties (cached) and return both the raw list and AI menu. */
async function getTaxonomyAttributes(shopClient, taxonomyId) {
  if (!taxonomyId) return { properties: [], menu: { theme: [], occasion: [], celebration: [], pattern: [] } };
  let data;
  try {
    data = await getPropertiesByTaxonomyId(shopClient, taxonomyId);
  } catch {
    return { properties: [], menu: { theme: [], occasion: [], celebration: [], pattern: [] } };
  }
  const properties = data.results || [];
  return { properties, menu: buildAttributeMenu(properties) };
}

module.exports = { getTaxonomyAttributes, buildAttributeMenu, resolveAttributes, classifyProperty, findValue };
