'use strict';

/**
 * One-off repair for image caches poisoned by the design-switch image defect.
 *
 * THE DEFECT (fixed in src/route/shop-images.js + src/route/dashboard.js):
 * /api/shop/route used to self-heal missing product photos keyed by the line's
 * `listing_id` — the listing the buyer ORDERED. On a SWITCHED line the row's
 * photo belongs to the REPLACEMENT design, so the fetcher downloaded the
 * replacement's photo and filed it under the ORIGINAL listing:
 *
 *   • /api/route/listing-image/<original> then served the replacement's photo
 *     to every other order of the original design, and
 *   • listing_phash hashed the replacement's photo as the ORIGINAL listing's
 *     visual identity, so the two designs could collapse onto one shopping card.
 *
 * WHAT THIS DOES
 * Finds every listing that was switched away from and whose cached bytes were
 * written AT OR AFTER the switch was created — the only window in which the bug
 * could have written them — and drops those two CACHE rows. Nothing durable is
 * lost: both re-derive on next use from the authoritative CDN url in
 * listing_images / listings.primary_image_url, and the canonical product keys
 * are recomputed by the identity reconciler once the photo is re-hashed.
 *
 * Over-purging is deliberately preferred: a needless purge costs one image
 * re-fetch, whereas leaving a poisoned entry shows the wrong product to whoever
 * is buying it.
 *
 * Usage:
 *   node scripts/repair-switched-listing-images.js            # report only
 *   node scripts/repair-switched-listing-images.js --apply    # perform the repair
 */

const Database = require('better-sqlite3');
const { loadConfig } = require('../src/config/schema');
const routeDashboard = require('../src/route/dashboard');

const APPLY = process.argv.includes('--apply');

const db = new Database(loadConfig().db_path, { readonly: !APPLY });

/** Does a table exist in this database? */
function hasTable(name) {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  return !!row;
}

if (!hasTable('order_line_substitutions') || !hasTable('listing_image_data')) {
  console.log('Nothing to check — this database has no design switches or no image cache yet.');
  db.close();
  process.exit(0);
}

const HAS_PHASH = hasTable('listing_phash');

/**
 * The listing a substituted line was ORDERED as. Recovered by rebuilding each
 * transaction's line key the same way the route builder does, rather than by
 * parsing the stored key — so the two can never disagree about the format.
 *
 * @param {number} receiptId
 * @param {string} itemKey
 * @returns {number|null}
 */
function orderedListingId(receiptId, itemKey) {
  let txs;
  try {
    const row = db.prepare('SELECT all_transactions FROM receipts WHERE receipt_id = ?').get(receiptId);
    txs = JSON.parse((row && row.all_transactions) || '[]');
  } catch {
    return null;
  }
  if (!Array.isArray(txs)) return null;
  for (const t of txs) {
    if (routeDashboard.lineItemKey(t.title || '', t.listing_id) !== itemKey) continue;
    const id = Number(t.listing_id);
    return Number.isInteger(id) && id > 0 ? id : null;
  }
  return null;
}

const subs = db
  .prepare('SELECT id, receipt_id, item_key, new_title, source, source_listing_id, created_at FROM order_line_substitutions')
  .all();

const getCache = db.prepare('SELECT cached_at FROM listing_image_data WHERE listing_id = ?');

/** listing_id → why it is suspect (first switch that could have poisoned it). */
const suspects = new Map();

for (const sub of subs) {
  const ordered = orderedListingId(sub.receipt_id, sub.item_key);
  if (ordered == null) continue;
  // A switch back onto the very same listing cannot poison anything.
  if (Number(sub.source_listing_id) === ordered) continue;

  const cached = getCache.get(ordered);
  if (!cached) continue;
  // Bytes cached BEFORE the switch existed came from the real listing.
  if (Number(cached.cached_at || 0) < Number(sub.created_at || 0)) continue;

  if (!suspects.has(ordered)) {
    suspects.set(ordered, {
      receipt_id: sub.receipt_id,
      new_title: sub.new_title,
      source: sub.source,
      replacement: sub.source_listing_id,
      cached_at: cached.cached_at,
      switched_at: sub.created_at,
    });
  }
}

console.log(`Design switches examined : ${subs.length}`);
console.log(`Listings to re-derive    : ${suspects.size}\n`);

if (!suspects.size) {
  console.log('No poisoned image caches found — nothing to repair.');
  db.close();
  process.exit(0);
}

const iso = (s) => (s ? new Date(Number(s) * 1000).toISOString().slice(0, 19).replace('T', ' ') : '—');
for (const [listingId, why] of suspects) {
  console.log(`  listing ${listingId}`);
  console.log(`    order ${why.receipt_id} switched to "${String(why.new_title).slice(0, 60)}" (${why.source}, replacement ${why.replacement ?? 'none'})`);
  console.log(`    switched ${iso(why.switched_at)} · image cached ${iso(why.cached_at)}`);
}

if (!APPLY) {
  console.log('\nReport only. Re-run with --apply to drop these cache rows so they re-derive.');
  db.close();
  process.exit(0);
}

const dropImage = db.prepare('DELETE FROM listing_image_data WHERE listing_id = ?');
const dropPhash = HAS_PHASH ? db.prepare('DELETE FROM listing_phash WHERE listing_id = ?') : null;

const repair = db.transaction((ids) => {
  let images = 0;
  let hashes = 0;
  for (const id of ids) {
    images += dropImage.run(id).changes;
    if (dropPhash) hashes += dropPhash.run(id).changes;
  }
  return { images, hashes };
});

const { images, hashes } = repair([...suspects.keys()]);

console.log(`\nRepaired. Dropped ${images} cached image(s) and ${hashes} perceptual hash(es).`);
console.log('They re-download from the listing\'s own CDN url on next use, and the');
console.log('identity reconciler recomputes the affected product keys automatically.');

db.close();
