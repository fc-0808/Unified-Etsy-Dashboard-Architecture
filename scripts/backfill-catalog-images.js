'use strict';

/**
 * Backfill the listing-image cache from the canonical `listings` table.
 *
 * Root-cause context: the Product Catalog used to resolve thumbnails only from
 * listings that had appeared in a past order, so live-but-never-sold listings
 * showed the 📦 placeholder. The `listings` table already stores a
 * `primary_image_url` for every live listing, so we can populate the
 * `listing_images` cache for all of them WITHOUT any network round-trip. This
 * also completes the binary route-image pipeline (Excel shopping-route photos)
 * for products that have never been ordered.
 *
 * Idempotent: only inserts URLs for listings not already cached (or whose
 * cached URL is empty). Safe to re-run.
 *
 * Usage: node scripts/backfill-catalog-images.js
 */

const Database = require('better-sqlite3');
const { loadConfig } = require('../src/config/schema');
const { upsertListingImage } = require('../src/db/setup');

const config = loadConfig();
const db = new Database(config.db_path);

function main() {
  let listings = [];
  try {
    listings = db.prepare(
      "SELECT listing_id, primary_image_url FROM listings WHERE primary_image_url IS NOT NULL AND primary_image_url <> ''"
    ).all();
  } catch (err) {
    console.error('Could not read listings table:', err.message);
    process.exit(1);
  }

  const cached = new Map();
  try {
    db.prepare('SELECT listing_id, url FROM listing_images').all()
      .forEach(r => cached.set(Number(r.listing_id), r.url || ''));
  } catch { /* table created lazily */ }

  const todo = listings.filter(l => {
    const cur = cached.get(Number(l.listing_id));
    return cur === undefined || cur === '';
  });

  console.log(`listings with a primary image : ${listings.length}`);
  console.log(`already cached                 : ${listings.length - todo.length}`);
  console.log(`to backfill (no/empty cache)   : ${todo.length}`);

  if (todo.length === 0) {
    console.log('\nNothing to do — every live listing already has a cached image URL.');
    db.close();
    return;
  }

  const tx = db.transaction((rows) => {
    for (const l of rows) upsertListingImage(db, Number(l.listing_id), l.primary_image_url);
  });
  tx(todo);

  console.log(`\n✅ Cached ${todo.length} listing image URL(s) from the listings table (no network used).`);
  db.close();
}

main();
