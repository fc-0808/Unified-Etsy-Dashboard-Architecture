'use strict';

/**
 * Diagnostic: how many Product Catalog (product_map) rows resolve to a thumbnail,
 * using the SAME resolver the app uses (listings table + order history, with a
 * conservative flagged fuzzy fallback). Buckets each row as exact / approximate /
 * none so missing-image regressions are easy to spot.
 *
 * Usage: node scripts/diag-catalog-images.js
 */

const Database = require('better-sqlite3');
const { loadConfig } = require('../src/config/schema');
const rd = require('../src/route/dashboard');
const db = new Database(loadConfig().db_path, { readonly: true });

const resolver = rd.buildCatalogImageResolver(db);
const rows = db.prepare('SELECT title_norm, title FROM product_map').all();

let exact = 0, approx = 0, none = 0;
const noneSamples = [], approxSamples = [];
for (const r of rows) {
  const m = resolver.resolve(r.title_norm, r.title);
  if (!m) { none++; if (noneSamples.length < 20) noneSamples.push(r.title); }
  else if (m.approx) { approx++; if (approxSamples.length < 20) approxSamples.push(`${m.score} | ${r.title.slice(0,55)}`); }
  else exact++;
}
console.log(`product_map rows: ${rows.length}`);
console.log(`  ✓ exact image      : ${exact}`);
console.log(`  ≈ approximate image: ${approx}`);
console.log(`  ✗ still no image   : ${none}`);
console.log('\n── approximate (flagged in UI) ──');
approxSamples.forEach(s => console.log('  ' + s));
console.log('\n── still no image ──');
noneSamples.forEach(s => console.log('  ' + s));
db.close();
