'use strict';

/**
 * Image fetching + caching for the shopping-route generator.
 *
 * Before the OSP Python script generates the three Excel route files it needs
 * binary JPEG bytes for each order-item product photo.  When running in
 * `--import-json` mode the script has no access to Etsy's CDN — all images
 * must arrive embedded in the JSON payload as base-64 strings.
 *
 * This module handles that pipeline:
 *   1. DB cache-first: no network round-trip for images already downloaded
 *      (stored in `listing_image_data`).
 *   2. Parallel CDN fetch: up to CONCURRENCY concurrent HTTPS requests with a
 *      per-request timeout and hard size cap.
 *   3. Write-through: successful fetches are immediately persisted to DB so
 *      subsequent route generations skip the network entirely.
 *
 * All failures are non-fatal — items without a fetchable image get no photo
 * in Excel (same behaviour as today for unmatched products), and the generation
 * continues normally.
 */

const https = require('https');
const http  = require('http');
const { getListingImageData, upsertListingImageData } = require('../db/setup');

/** Maximum time to wait for a single image response (ms). */
const FETCH_TIMEOUT_MS = 10_000;

/** Maximum accepted response body size — prevents runaway downloads. */
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB

/** Maximum simultaneous CDN fetch requests. */
const CONCURRENCY = 8;

// ─── Low-level HTTP fetch ────────────────────────────────────────────────────

/**
 * Fetch one image URL and return its raw bytes as a Buffer.
 *
 * Follows a single level of HTTP redirect.  Rejects on:
 *   • DNS / TCP errors
 *   • Timeout (> FETCH_TIMEOUT_MS)
 *   • Non-200 HTTP status (after redirect resolution)
 *   • Non-image Content-Type
 *   • Body larger than MAX_BODY_BYTES
 *
 * @param {string} imageUrl
 * @param {number} [hopsLeft=1] - redirect budget (prevents loops)
 * @returns {Promise<Buffer>}
 */
function fetchImageBuffer(imageUrl, hopsLeft = 1) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(imageUrl); }
    catch { return reject(new Error(`Invalid URL: ${imageUrl}`)); }

    const lib = parsed.protocol === 'https:' ? https : http;

    const req = lib.get(imageUrl, (res) => {
      const { statusCode } = res;

      // Handle redirects
      if (statusCode === 301 || statusCode === 302 || statusCode === 307 || statusCode === 308) {
        res.resume(); // drain so the socket is freed
        const loc = res.headers.location;
        if (!loc || hopsLeft <= 0) return reject(new Error('Too many redirects'));
        return fetchImageBuffer(loc, hopsLeft - 1).then(resolve).catch(reject);
      }

      if (statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${statusCode}`));
      }

      // Validate content-type — Etsy serves JPEG/PNG; accept octet-stream too.
      const mime = (res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!mime.startsWith('image/') && mime !== 'application/octet-stream') {
        res.resume();
        return reject(new Error(`Unexpected content-type: ${mime}`));
      }

      const chunks = [];
      let total = 0;

      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
          req.destroy(new Error('Response body exceeds size limit'));
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        if (chunks.length === 0) return reject(new Error('Empty response body'));
        resolve(Buffer.concat(chunks));
      });

      res.on('error', reject);
    });

    req.setTimeout(FETCH_TIMEOUT_MS, () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
  });
}

// ─── Cache + fetch ───────────────────────────────────────────────────────────

/**
 * Fetch-and-cache a single listing image.
 *
 * Returns the DB-cached bytes immediately if present.  Otherwise downloads
 * from the CDN, persists to DB, and returns the result.  Returns null on any
 * failure (non-fatal).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} listingId
 * @param {string|null} imageUrl
 * @returns {Promise<Buffer|null>}
 */
async function fetchAndCacheImage(db, listingId, imageUrl) {
  // 1. Check DB cache (synchronous — better-sqlite3 is sync)
  const cached = getListingImageData(db, listingId);
  if (cached) return cached;

  // 2. Nothing cached — need the URL
  if (!imageUrl) return null;

  // 3. Fetch from CDN
  let buf;
  try {
    buf = await fetchImageBuffer(imageUrl);
  } catch (err) {
    console.warn(`[image-fetcher] listing ${listingId}: fetch failed — ${err.message}`);
    return null;
  }

  // 4. Persist to DB cache (non-fatal if it fails)
  try {
    upsertListingImageData(db, listingId, buf);
  } catch (err) {
    console.warn(`[image-fetcher] listing ${listingId}: cache write failed — ${err.message}`);
  }

  return buf;
}

// ─── Batch fetch ─────────────────────────────────────────────────────────────

/**
 * Batch-fetch images for every unique listing referenced in a route export.
 *
 * Deduplicated by `listing_id` so each product is fetched only once regardless
 * of how many orders contain it.  Runs CONCURRENCY fetches simultaneously.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Map<number, string>} listingIdToUrl  listing_id → CDN image URL
 * @returns {Promise<Map<number, Buffer|null>>}
 */
async function batchFetchRouteImages(db, listingIdToUrl) {
  const entries = [...listingIdToUrl.entries()]; // [listingId, url][]
  const result  = new Map();

  if (entries.length === 0) return result;

  let nCache = 0, nFetched = 0, nFailed = 0;
  const t0 = Date.now();

  // Pre-check cache for all IDs synchronously (no async overhead for cache hits)
  const remaining = [];
  for (const [id, url] of entries) {
    const cached = getListingImageData(db, id);
    if (cached) { result.set(id, cached); nCache++; }
    else { remaining.push([id, url]); }
  }

  // Fetch remaining in parallel, CONCURRENCY at a time
  for (let i = 0; i < remaining.length; i += CONCURRENCY) {
    const batch = remaining.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(async ([id, url]) => {
        if (!url) { nFailed++; return [id, null]; }
        let buf = null;
        try {
          buf = await fetchImageBuffer(url);
          upsertListingImageData(db, id, buf);
          nFetched++;
        } catch (err) {
          console.warn(`[image-fetcher] listing ${id}: ${err.message}`);
          nFailed++;
        }
        return [id, buf];
      })
    );
    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value) result.set(s.value[0], s.value[1]);
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[image-fetcher] ${entries.length} listing(s): ` +
    `${nCache} cached, ${nFetched} fetched, ${nFailed} failed — ` +
    `${nCache + nFetched}/${entries.length} ready (${elapsed}s)`
  );

  return result;
}

module.exports = { fetchAndCacheImage, batchFetchRouteImages };
