'use strict';

/**
 * Build a ZIP of product images for route-dashboard rows that have no
 * supplier / location yet (not in catalog and no manual override).
 */

const MAX_IMAGES = 250;

/** archiver@8 is ESM-only; lazy-load ZipArchive for CommonJS callers. */
let _ZipArchive = null;
async function createZipArchive() {
  if (!_ZipArchive) {
    ({ ZipArchive: _ZipArchive } = await import('archiver'));
  }
  return new _ZipArchive({ zlib: { level: 6 } });
}
const FETCH_TIMEOUT_MS = 25_000;

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

/**
 * Rows with no supplier match, deduped by product title (item_key).
 * @param {Array<object>} rows - buildRouteRows output
 * @returns {Array<{ url: string, name: string, title: string, receipt_id: number, listing_id: number|null }>}
 */
function collectUnmatchedImageItems(rows) {
  const seen = new Set();
  const items = [];

  for (const row of rows) {
    if (row.excluded) continue;
    if (row.supplier_in_catalog || row.supplier_is_override) continue;
    if (!row.image_url) continue;

    const key = row.item_key || row.title;
    if (seen.has(key)) continue;
    seen.add(key);

    const base = safeBaseName(row.title);
    const lid = row.listing_id ? String(row.listing_id) : String(row.receipt_id);
    const ext = extFromUrl(row.image_url);
    items.push({
      url: row.image_url,
      name: `${lid}_${base}.${ext}`,
      title: row.title,
      receipt_id: row.receipt_id,
      listing_id: row.listing_id ?? null,
    });

    if (items.length >= MAX_IMAGES) break;
  }

  return items;
}

/**
 * @param {string} url
 * @returns {Promise<{ buffer: Buffer, ext: string }>}
 */
async function fetchImage(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'UnifiedEtsyDashboard/1.0' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('empty body');
    const ext = extFromMime(res.headers.get('content-type')) || extFromUrl(url);
    return { buffer: buf, ext };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stream a ZIP to an Express response.
 * @param {import('express').Response} res
 * @param {Array<{ url: string, name: string }>} items
 * @returns {Promise<{ added: number, failed: string[] }>}
 */
async function streamUnmatchedImagesZip(res, items) {
  const archive = await createZipArchive();
  return new Promise((resolve, reject) => {
    const failed = [];
    let added = 0;

    archive.on('error', reject);
    res.on('close', () => {
      if (!res.writableFinished) archive.abort();
    });

    archive.pipe(res);

    (async () => {
      const usedNames = new Set();

      // Return a ZIP-unique version of `name`, reserving it in usedNames.
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
          const { buffer, ext } = await fetchImage(item.url);
          if (!entryName.endsWith(`.${ext}`)) {
            const dot = entryName.lastIndexOf('.');
            const corrected = (dot > 0 ? entryName.slice(0, dot) : entryName) + `.${ext}`;
            // Correcting the extension can collide with an already-reserved name,
            // so re-run the uniqueness check on the corrected name.
            entryName = reserveUniqueName(corrected);
          }
          archive.append(buffer, { name: entryName });
          added++;
        } catch (err) {
          failed.push(`${entryName}: ${err.message}`);
        }
      }

      if (failed.length) {
        archive.append(
          [
            'Some images could not be downloaded.',
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
  collectUnmatchedImageItems,
  streamUnmatchedImagesZip,
};
