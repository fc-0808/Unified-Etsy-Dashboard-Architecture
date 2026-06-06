'use strict';
/**
 * One-time backfill: decode HTML entities stored in buyer name / address fields
 * that Etsy injected during API sync (e.g. "O&#39;Keefe" → "O'Keefe").
 *
 * Run once: node scripts/backfill-html-decode.js
 */

const path     = require('path');
const Database = require('better-sqlite3');
const { loadConfig } = require('../src/config/schema');

const config = loadConfig();
const db = new Database(config.db_path);

function decodeHtmlEntities(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return value;
  return value
    .replace(/&#(\d+);/g,         (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/gi,  '&')
    .replace(/&lt;/gi,   '<')
    .replace(/&gt;/gi,   '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

const rows = db.prepare(`
  SELECT receipt_id, name, shipping_first_line, shipping_second_line,
         message_from_buyer, message_from_seller
  FROM receipts
  WHERE name                LIKE '%&#%'
     OR name                LIKE '%&amp;%'
     OR name                LIKE '%&lt;%'
     OR name                LIKE '%&gt;%'
     OR name                LIKE '%&quot;%'
     OR shipping_first_line LIKE '%&#%'
     OR shipping_second_line LIKE '%&#%'
     OR message_from_buyer  LIKE '%&#%'
     OR message_from_seller LIKE '%&#%'
`).all();

console.log(`Found ${rows.length} receipt(s) with HTML entities to fix.`);
if (rows.length === 0) {
  console.log('Nothing to do.');
  db.close();
  process.exit(0);
}

const update = db.prepare(`
  UPDATE receipts SET
    name                 = ?,
    shipping_first_line  = ?,
    shipping_second_line = ?,
    message_from_buyer   = ?,
    message_from_seller  = ?
  WHERE receipt_id = ?
`);

const fixAll = db.transaction(() => {
  for (const r of rows) {
    const newName = decodeHtmlEntities(r.name);
    update.run(
      newName,
      decodeHtmlEntities(r.shipping_first_line),
      decodeHtmlEntities(r.shipping_second_line),
      decodeHtmlEntities(r.message_from_buyer),
      decodeHtmlEntities(r.message_from_seller),
      r.receipt_id
    );
    if (newName !== r.name) {
      console.log(`  receipt ${r.receipt_id}: "${r.name}" → "${newName}"`);
    }
  }
});

fixAll();
db.close();
console.log('Backfill complete.');
