'use strict';

/**
 * One-time backfill: normalise variation labels so restock / zero-stock events
 * read consistently (e.g. "Case+Grip+Charm") instead of enumerating every
 * iPhone-model × style combination.
 *
 * Two passes, both idempotent:
 *   1. listing_inventory — recompute style_value / secondary_value from the
 *      stored property_values JSON using deriveVariationLabels (the same logic
 *      now used at write time). Fixes rows whose style property was named
 *      "Styles" (plural) and therefore previously fell back to "Model / Style".
 *   2. events — for historical rows whose style_value still carries a model
 *      prefix ("… / Style"), collapse to the distinct style label and rewrite
 *      the same substring inside the human-readable detail. Structured `meta`
 *      is preserved untouched.
 *
 * Usage:
 *   node scripts/backfill-style-values.js [--dry-run] [--db <path>]
 */

const path = require('path');
const Database = require('better-sqlite3');
const { deriveVariationLabels } = require('../src/inventory/helpers');

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const dbFlagIdx = argv.indexOf('--db');

function resolveDbPath() {
  if (dbFlagIdx !== -1 && argv[dbFlagIdx + 1]) return path.resolve(argv[dbFlagIdx + 1]);
  try {
    const { loadConfig } = require('../src/config/schema');
    const cfg = loadConfig();
    if (cfg && cfg.db_path) return cfg.db_path;
  } catch {
    /* fall through to default */
  }
  return path.resolve(__dirname, '../data/etsy_dashboard.db');
}

// Device/model values are never the restock-relevant label. Used only to clean
// LEGACY event strings (we no longer have their property objects, only the
// joined "Model / Style" text).
const MODEL_VALUE_RE = /\b(iphone|ipad|samsung|galaxy|pixel|android|google|oneplus|huawei|xiaomi)\b/i;

/**
 * Collapse a legacy, comma-joined "Model / Style" event label down to the
 * distinct style component(s). Pure string transform — safe on display text.
 */
function cleanLegacyStyleString(styleValue) {
  if (!styleValue || typeof styleValue !== 'string') return styleValue;
  const tokens = styleValue.split(',').map((t) => t.trim()).filter(Boolean);
  const cleaned = tokens.map((tok) => {
    if (!tok.includes(' / ')) return tok;
    const parts = tok.split(' / ').map((s) => s.trim()).filter(Boolean);
    const styleParts = parts.filter((p) => !MODEL_VALUE_RE.test(p));
    return (styleParts.length ? styleParts : parts.slice(-1)).join(' / ');
  });
  return [...new Set(cleaned.filter(Boolean))].join(', ');
}

function main() {
  const dbPath = resolveDbPath();
  console.log(`Backfill style values${DRY_RUN ? ' [DRY RUN]' : ''}`);
  console.log(`Database: ${dbPath}\n`);

  const db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');

  // ── Pass 1: listing_inventory cache ──────────────────────────────────────
  const invRows = db.prepare(
    'SELECT listing_id, product_id, style_value, secondary_value, property_values FROM listing_inventory'
  ).all();

  const updateInv = db.prepare(
    'UPDATE listing_inventory SET style_value = ?, secondary_value = ? WHERE listing_id = ? AND product_id = ?'
  );

  let invChanged = 0;
  const applyInv = db.transaction(() => {
    for (const r of invRows) {
      let propValues = [];
      try { propValues = JSON.parse(r.property_values || '[]'); } catch { continue; }
      const { styleVal, secondaryVal } = deriveVariationLabels(propValues);
      if (styleVal == null) continue; // nothing to derive — leave as-is
      if (styleVal !== r.style_value || secondaryVal !== r.secondary_value) {
        invChanged++;
        if (!DRY_RUN) updateInv.run(styleVal, secondaryVal, r.listing_id, r.product_id);
      }
    }
  });
  applyInv();
  console.log(`Pass 1 — listing_inventory: ${invChanged}/${invRows.length} row(s) ${DRY_RUN ? 'would be' : ''} updated`);

  // ── Pass 2: historical events ────────────────────────────────────────────
  const evRows = db.prepare(
    "SELECT id, style_value, detail FROM events WHERE style_value LIKE '% / %'"
  ).all();

  const updateEv = db.prepare('UPDATE events SET style_value = ?, detail = ? WHERE id = ?');

  let evChanged = 0;
  const sample = [];
  const applyEv = db.transaction(() => {
    for (const e of evRows) {
      const cleanLabel = cleanLegacyStyleString(e.style_value);
      if (!cleanLabel || cleanLabel === e.style_value) continue;
      // Replace the verbose label wherever it appears in the detail text
      // (works for both "[label]" and "(triggered by zero stock in: label)").
      const newDetail = (e.detail || '').split(e.style_value).join(cleanLabel);
      evChanged++;
      if (sample.length < 3) sample.push({ before: e.style_value, after: cleanLabel });
      if (!DRY_RUN) updateEv.run(cleanLabel, newDetail, e.id);
    }
  });
  applyEv();
  console.log(`Pass 2 — events:            ${evChanged}/${evRows.length} row(s) ${DRY_RUN ? 'would be' : ''} updated`);

  if (sample.length) {
    console.log('\nExample transforms:');
    for (const s of sample) {
      console.log(`  - "${s.before}"`);
      console.log(`    → "${s.after}"`);
    }
  }

  db.close();
  console.log(`\nDone${DRY_RUN ? ' (no changes written)' : ''}.`);
}

main();
