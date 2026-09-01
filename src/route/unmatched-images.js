'use strict';

/**
 * Build a ZIP of product images for the route lines nobody can buy yet — the
 * photos the operator sends to the market contacts to ask "who sells this, and
 * where?".
 *
 * A line qualifies when `src/route/sourcing.js` says it still needs a location:
 * either it was never catalogued (and nobody filled a supplier in), or a shopper
 * stood at the recorded stall in person and flagged it Wrong Stall. A stall
 * that's on record but wrong is worth no more than no stall at all, so both land
 * in the same request.
 *
 * The ZIP is flat — every entry is a photo the operator can select and forward
 * as-is — plus one `_sourcing-requests.csv` manifest that says, per photo, what
 * we still need and (for a wrong stall) which location was already tried.
 *
 * Route rows expose same-origin image URLs (`/api/route/*`) for the UI and
 * mobile shopping route. Those paths cannot be fetched with a bare relative URL
 * on the server — bytes are resolved from the same DB/cache layer the HTTP
 * endpoints use, with CDN fetch only for absolute Etsy URLs.
 */

const {
  getListingStyleImage,
  getSubstitutionImage,
  getManualItemImage,
  getListingVariationImageMap,
} = require('../db/setup');
const { lookupVariationImage } = require('../listings/variation-images');
const { fetchImageBuffer } = require('./image-fetcher');
const { ensureListingImageBytes } = require('./shop-images');
const sourcing = require('./sourcing');

const MAX_IMAGES = 250;

/** Manifest naming the ask behind every photo. Underscored so it sorts first. */
const MANIFEST_NAME = '_sourcing-requests.csv';

/** archiver@8 is ESM-only; lazy-load ZipArchive for CommonJS callers. */
let _ZipArchive = null;
async function createZipArchive() {
  if (!_ZipArchive) {
    ({ ZipArchive: _ZipArchive } = await import('archiver'));
  }
  return new _ZipArchive({ zlib: { level: 6 } });
}

/** @param {string} s */
function safeBaseName(s, maxLen = 72) {
  const cleaned = String(s ?? '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || 'product').slice(0, maxLen);
}

/** @param {string} url */
function extFromUrl(url) {
  try {
    const p = new URL(url).pathname.toLowerCase();
    const m = /\.(jpe?g|png|gif|webp)(?:$|[?#])/i.exec(p);
    if (m) return m[1] === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  } catch {}
  return 'jpg';
}

/** @param {string} mime */
function extFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  return 'jpg';
}

/** @param {Buffer|null|undefined} buf */
function extFromBuffer(buf) {
  if (!buf || buf.length < 4) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return 'webp';
  return 'jpg';
}

/**
 * Parse a route image URL into a typed descriptor.
 * Accepts same-origin `/api/route/*` paths and absolute http(s) URLs.
 *
 * @param {string} imageUrl
 * @returns {{ kind: string, id?: number, style?: string, cdnUrl?: string }}
 */
function parseRouteImageUrl(imageUrl) {
  const raw = String(imageUrl || '').trim();
  if (!raw) return { kind: 'empty' };

  if (/^https?:\/\//i.test(raw)) {
    return { kind: 'cdn', cdnUrl: raw };
  }

  let parsed;
  try {
    parsed = new URL(raw, 'http://route.local');
  } catch {
    return { kind: 'unsupported' };
  }

  const m = /^\/api\/route\/(listing-image|variation-image|style-image|substitution-image|manual-image)\/(\d+)/i.exec(parsed.pathname);
  if (!m) return { kind: 'unsupported' };

  const id = parseInt(m[2], 10);
  if (!Number.isInteger(id)) return { kind: 'unsupported' };

  switch (m[1].toLowerCase()) {
    case 'listing-image':
      return { kind: 'listing', id };
    case 'variation-image':
      return { kind: 'variation', id, style: String(parsed.searchParams.get('k') || '').trim() };
    case 'style-image':
      return { kind: 'style', id };
    case 'substitution-image':
      return { kind: 'substitution', id };
    case 'manual-image':
      return { kind: 'manual', id };
    default:
      return { kind: 'unsupported' };
  }
}

/**
 * Resolve image bytes for any URL the route dashboard emits.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} imageUrl
 * @returns {Promise<{ buffer: Buffer, ext: string }>}
 */
async function resolveRouteImageBytes(db, imageUrl) {
  const spec = parseRouteImageUrl(imageUrl);

  switch (spec.kind) {
    case 'listing': {
      const buffer = await ensureListingImageBytes(db, spec.id);
      if (!buffer || !buffer.length) throw new Error('listing image not available');
      return { buffer, ext: extFromBuffer(buffer) };
    }
    case 'variation': {
      if (!spec.style) throw new Error('variation style missing');
      const map = getListingVariationImageMap(db, [spec.id]);
      const hit = lookupVariationImage(map, spec.id, { style: spec.style });
      if (!hit || !hit.url) throw new Error('variation image not cached');
      const buffer = await fetchImageBuffer(hit.url);
      return { buffer, ext: extFromUrl(hit.url) || extFromBuffer(buffer) };
    }
    case 'style': {
      const img = getListingStyleImage(db, spec.id);
      if (!img || !img.data || !img.data.length) throw new Error('style image not found');
      return { buffer: img.data, ext: extFromMime(img.mime) || extFromBuffer(img.data) };
    }
    case 'substitution': {
      const img = getSubstitutionImage(db, spec.id);
      if (!img || !img.data || !img.data.length) throw new Error('substitution image not found');
      return { buffer: img.data, ext: extFromMime(img.mime) || extFromBuffer(img.data) };
    }
    case 'manual': {
      const img = getManualItemImage(db, spec.id);
      if (!img || !img.data || !img.data.length) throw new Error('manual image not found');
      return { buffer: img.data, ext: extFromMime(img.mime) || extFromBuffer(img.data) };
    }
    case 'cdn': {
      const buffer = await fetchImageBuffer(spec.cdnUrl);
      return { buffer, ext: extFromUrl(spec.cdnUrl) || extFromBuffer(buffer) };
    }
    default:
      throw new Error(`unsupported image url: ${imageUrl}`);
  }
}

/**
 * What one row is asking for: the reason, the pieces flagged, and the location
 * already tried. A tried location only exists in the wrong-stall case — that is
 * the one where something was on record for the shopper to go to.
 *
 * @param {object} row - a buildRouteRows row that needs sourcing
 */
function sourcingAsk(row) {
  const reason = sourcing.sourcingReason(row);
  const components = sourcing.wrongStallComponents(row);
  const tried =
    reason === sourcing.REASON_WRONG_STALL && components.length
      ? sourcing.recordedLocation(row, components[0])
      : { shop: '', stall: '' };
  return {
    reason,
    reason_label: sourcing.REASON_LABELS[reason] || '',
    // Which pieces the shopper flagged, e.g. 'charm' when the case was fine.
    components: components.join(', '),
    recorded_shop: tried.shop,
    recorded_stall: tried.stall,
  };
}

/**
 * The lines that still need a supplier / stall answer, deduped to one entry per
 * product (item_key) because the question is about the product, not the order —
 * ten orders of the same case is still one photo to send.
 *
 * Each entry carries the reason it is being asked about and, for a wrong stall,
 * the location already tried, so the manifest can quote it back.
 *
 * @param {Array<object>} rows - buildRouteRows output
 * @returns {Array<object>} export entries, in row order, capped at MAX_IMAGES
 */
function collectUnmatchedImageItems(rows) {
  const byProduct = new Map();

  for (const row of rows || []) {
    if (row.excluded) continue;
    if (!sourcing.needsSourcing(row)) continue;
    if (!row.image_url) continue;

    const key = row.item_key || row.title;
    const existing = byProduct.get(key);
    if (existing) {
      // Another order of a product already queued: it adds demand, not a photo.
      existing.orders += 1;
      existing.units += Number(row.quantity) || 1;
      // Two orders of one product can ask for different reasons — one line had a
      // stall hand-entered and found wrong, another never had one at all. Report
      // the wrong stall: naming a place that failed is strictly more to go on
      // than naming nothing, and taking it whenever ANY line has one keeps the
      // manifest independent of which order happened to be read first.
      const ask = sourcingAsk(row);
      if (ask.reason === sourcing.REASON_WRONG_STALL && existing.reason !== ask.reason) {
        Object.assign(existing, ask);
      }
      continue;
    }
    if (byProduct.size >= MAX_IMAGES) continue;

    const base = safeBaseName(row.title);
    const lid = row.product_listing_id || row.listing_id;
    const fileStem = lid ? String(lid) : String(row.receipt_id);
    const ext = extFromUrl(row.image_url);
    byProduct.set(key, {
      url: row.image_url,
      name: `${fileStem}_${base}.${ext}`,
      title: row.title,
      receipt_id: row.receipt_id,
      listing_id: row.listing_id ?? null,
      product_listing_id: row.product_listing_id ?? null,
      ...sourcingAsk(row),
      model: row.shopping_model || row.phone_model || '',
      style: row.style || '',
      orders: 1,
      units: Number(row.quantity) || 1,
    });
  }

  return [...byProduct.values()];
}

/** RFC 4180 field escaping. */
function csvField(value) {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const MANIFEST_COLUMNS = [
  ['File', (e) => e.name],
  ['Product', (e) => e.title],
  ['Model', (e) => e.model],
  ['Style', (e) => e.style],
  ['We need', (e) => e.reason_label],
  ['For', (e) => e.components],
  ['Stall already tried', (e) => [e.recorded_shop, e.recorded_stall].filter(Boolean).join(' · ')],
  ['Orders waiting', (e) => e.orders],
  ['Units needed', (e) => e.units],
  ['Listing', (e) => e.product_listing_id || e.listing_id || ''],
];

/**
 * The manifest that turns a folder of photos into an answerable question.
 * UTF-8 BOM + CRLF so Excel opens Chinese shop names correctly on Windows.
 *
 * @param {Array<{ name: string, entry: object }>} added - photos actually in the ZIP
 * @returns {string}
 */
function buildSourcingManifestCsv(added) {
  const lines = [MANIFEST_COLUMNS.map(([header]) => csvField(header)).join(',')];
  for (const { name, entry } of added) {
    lines.push(
      MANIFEST_COLUMNS.map(([, read]) => csvField(read({ ...entry, name }))).join(',')
    );
  }
  return '\ufeff' + lines.join('\r\n') + '\r\n';
}

/**
 * How many export entries fall under each sourcing reason — surfaced as response
 * headers so the operator is told what the ZIP actually contains.
 *
 * @param {Array<{ reason?: string }>} items
 * @returns {{ not_in_catalog: number, wrong_stall: number }}
 */
function countItemsByReason(items) {
  const counts = { [sourcing.REASON_NOT_IN_CATALOG]: 0, [sourcing.REASON_WRONG_STALL]: 0 };
  for (const item of items || []) {
    if (item && Object.prototype.hasOwnProperty.call(counts, item.reason)) counts[item.reason] += 1;
  }
  return counts;
}

/**
 * Stream a ZIP to an Express response.
 * @param {import('express').Response} res
 * @param {import('better-sqlite3').Database} db
 * @param {Array<{ url: string, name: string }>} items
 * @returns {Promise<{ added: number, failed: string[] }>}
 */
async function streamUnmatchedImagesZip(res, db, items) {
  const archive = await createZipArchive();
  return new Promise((resolve, reject) => {
    const failed = [];
    const manifest = [];
    let added = 0;

    archive.on('error', reject);
    res.on('close', () => {
      if (!res.writableFinished) archive.abort();
    });

    archive.pipe(res);

    (async () => {
      const usedNames = new Set();

      const reserveUniqueName = (name) => {
        let candidate = name;
        if (usedNames.has(candidate)) {
          const dot = candidate.lastIndexOf('.');
          const stem = dot > 0 ? candidate.slice(0, dot) : candidate;
          const ext = dot > 0 ? candidate.slice(dot + 1) : 'jpg';
          let n = 2;
          while (usedNames.has(`${stem}_${n}.${ext}`)) n++;
          candidate = `${stem}_${n}.${ext}`;
        }
        usedNames.add(candidate);
        return candidate;
      };

      for (const item of items) {
        let entryName = reserveUniqueName(item.name);

        try {
          const { buffer, ext } = await resolveRouteImageBytes(db, item.url);
          if (!entryName.endsWith(`.${ext}`)) {
            const dot = entryName.lastIndexOf('.');
            const corrected = (dot > 0 ? entryName.slice(0, dot) : entryName) + `.${ext}`;
            entryName = reserveUniqueName(corrected);
          }
          archive.append(buffer, { name: entryName });
          manifest.push({ name: entryName, entry: item });
          added++;
        } catch (err) {
          failed.push(`${entryName}: ${err.message}`);
        }
      }

      // Built from what actually made it in — under its FINAL entry name, after
      // extension correction and collision suffixes — so every manifest row
      // points at a photo that is really there.
      if (manifest.length) {
        archive.append(buildSourcingManifestCsv(manifest), { name: MANIFEST_NAME });
      }

      if (failed.length) {
        archive.append(
          [
            'Some images could not be resolved.',
            'Run: npm run fetch-images',
            '',
            ...failed,
          ].join('\n'),
          { name: '_download_errors.txt' }
        );
      }

      if (added === 0 && items.length > 0 && !failed.length) {
        archive.append('No images could be downloaded.', { name: 'README.txt' });
      }

      archive.finalize();
      resolve({ added, failed });
    })().catch(reject);
  });
}

module.exports = {
  MAX_IMAGES,
  MANIFEST_NAME,
  parseRouteImageUrl,
  resolveRouteImageBytes,
  collectUnmatchedImageItems,
  buildSourcingManifestCsv,
  countItemsByReason,
  streamUnmatchedImagesZip,
};
