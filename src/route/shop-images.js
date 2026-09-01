'use strict';

/**
 * Shopping-route product image URLs.
 *
 * The mobile /shop page registers a service worker that cache-firsts image
 * requests. Product photos MUST therefore be same-origin: the app CSP sets
 * `connect-src 'self'`, so a service-worker fetch to i.etsystatic.com is
 * blocked and every direct CDN thumbnail falls through to the broken-image
 * placeholder. Charm / substitution / style photos already worked because they
 * are served from /api/route/* — listing photos now follow the same pattern.
 */

const { fetchAndCacheImage } = require('./image-fetcher');

/** Card thumbnails — ~104 px wide on a retina phone. */
const SHOP_CARD_WIDTH = 300;

/** Full-screen zoom — sharp enough to read the design. */
const SHOP_ZOOM_WIDTH = 570;

/**
 * Rewrite an Etsy CDN URL to a small thumbnail variant (desktop / fallback).
 * Non-Etsy URLs pass through unchanged.
 *
 * @param {string|null|undefined} url
 * @returns {string|null|undefined}
 */
function etsyThumb(url) {
  if (!url || typeof url !== 'string') return url;
  if (!/i\.etsystatic\.com/i.test(url)) return url;
  return url.replace(/il_[0-9a-zA-Z]+x[0-9a-zA-Z]+\./, 'il_300x300.');
}

/**
 * Resolve the image URL the mobile shopping route should render for one row.
 *
 *   • already same-origin (`/api/…`) → serve as-is. Uploaded switch photos,
 *     operator Fix Images and Etsy style-variation photos arrive this way and
 *     are already content-addressed.
 *   • a CDN url for a known product listing → proxy it same-origin so the
 *     service worker may cache it.
 *   • anything else → the CDN url, narrowed to a thumbnail.
 *
 * THE PROXY MUST KEY OFF `product_listing_id`, NEVER `listing_id`. The latter is
 * the listing the buyer ORDERED; after a design switch the line is bought as a
 * DIFFERENT listing, and proxying the ordered one served the shopper the design
 * the buyer had just moved away from — while the Orders and Route tabs, which
 * render `image_url` verbatim, correctly showed the replacement.
 *
 * When `product_listing_id` is absent the row falls back to the CDN url rather
 * than guessing a listing. A thumbnail that may not load through the PWA is a far
 * better failure than a confident photo of the wrong product: the shopper buys
 * what they see.
 *
 * @param {{ product_listing_id?: number|null, image_url?: string|null }} row
 * @returns {string|null}
 */
function shopRouteImageUrl(row) {
  const url = row && row.image_url != null ? row.image_url : null;
  if (!url) return null;
  if (typeof url === 'string' && url.startsWith('/api/')) return url;
  const lid = Number(row.product_listing_id);
  if (Number.isInteger(lid) && lid > 0) {
    return `/api/route/listing-image/${lid}?w=${SHOP_CARD_WIDTH}`;
  }
  return etsyThumb(url);
}

/**
 * Look up the cached Etsy CDN URL for a listing.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} listingId
 * @returns {string|null}
 */
function resolveListingCdnUrl(db, listingId) {
  try {
    const row = db.prepare(
      "SELECT url FROM listing_images WHERE listing_id = ? AND url IS NOT NULL AND url <> ''"
    ).get(listingId);
    if (row && row.url) return String(row.url);
    const listing = db.prepare(
      "SELECT primary_image_url FROM listings WHERE listing_id = ? AND primary_image_url IS NOT NULL AND primary_image_url <> ''"
    ).get(listingId);
    if (listing && listing.primary_image_url) return String(listing.primary_image_url);
  } catch { /* tables may not exist on first boot */ }
  return null;
}

/**
 * Return cached listing image bytes, fetching from the CDN and persisting on miss.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} listingId
 * @returns {Promise<Buffer|null>}
 */
async function ensureListingImageBytes(db, listingId) {
  const cdnUrl = resolveListingCdnUrl(db, listingId);
  return fetchAndCacheImage(db, listingId, cdnUrl);
}

module.exports = {
  SHOP_CARD_WIDTH,
  SHOP_ZOOM_WIDTH,
  etsyThumb,
  shopRouteImageUrl,
  resolveListingCdnUrl,
  ensureListingImageBytes,
};
