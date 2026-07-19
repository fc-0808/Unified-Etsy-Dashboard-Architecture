'use strict';

/**
 * Input scanner for the Bulk Listing Creator.
 *
 * Expected input layout (mirrors Listings_automation/input):
 *
 *   <inputRoot>/
 *     <product folder 1>/
 *       1.PNG            ← thumbnail (lowest natural-sort number first)
 *       2.PNG ...
 *       2.mp4            ← optional single product video
 *     <product folder 2>/
 *       ...
 *
 * Each immediate subfolder represents ONE product (an iPhone case). Images are
 * natural-sorted so "2.png" comes before "10.png"; the first image is the
 * thumbnail. At most 20 images are kept (Etsy raised the per-listing photo cap
 * from 10 to 20 in Aug 2025). The first video file found is the product video.
 */

const fs   = require('fs');
const path = require('path');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.webm', '.m4v']);
const MAX_IMAGES = 20; // Etsy per-listing photo cap (raised from 10 → 20 in Aug 2025)

/**
 * Natural sort comparator: orders by the first integer found in the filename,
 * then lexicographically. So "1, 2, 10" instead of "1, 10, 2".
 */
function naturalCompare(a, b) {
  const na = (a.match(/\d+/) || [])[0];
  const nb = (b.match(/\d+/) || [])[0];
  if (na != null && nb != null) {
    const diff = parseInt(na, 10) - parseInt(nb, 10);
    if (diff !== 0) return diff;
  }
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function mimeForImage(ext) {
  const e = ext.toLowerCase().replace('.', '');
  if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
  return `image/${e}`;
}

function mimeForVideo(ext) {
  const e = ext.toLowerCase().replace('.', '');
  if (e === 'mov') return 'video/quicktime';
  if (e === 'm4v') return 'video/x-m4v';
  return `video/${e}`;
}

/**
 * Scan a single product folder.
 * @param {string} folderPath absolute path to the product folder
 * @param {object} [opts]
 * @param {number} [opts.maxImages=MAX_IMAGES]  Upper bound on images returned.
 *        Pass `Infinity` to get EVERY image on disk — required when resolving a
 *        curated image plan whose kept photos may natural-sort past the default
 *        cap (e.g. an operator-uploaded `upload-<ts>` file, or a listing that
 *        still holds orphan files from a removal made before archiving existed).
 * @returns {{
 *   folder: string, name: string,
 *   images: Array<{path:string,filename:string,mime:string,rank:number}>,
 *   video: {path:string,filename:string,mime:string}|null,
 *   imageCount: number, hasVideo: boolean, warnings: string[]
 * }}
 */
function scanProductFolder(folderPath, opts = {}) {
  const maxImages = opts.maxImages != null ? opts.maxImages : MAX_IMAGES;
  const name = path.basename(folderPath);
  const warnings = [];
  let entries = [];
  try {
    entries = fs.readdirSync(folderPath, { withFileTypes: true });
  } catch (err) {
    return {
      folder: folderPath, name, images: [], video: null,
      imageCount: 0, hasVideo: false, warnings: [`Cannot read folder: ${err.message}`],
    };
  }

  const files = entries.filter((e) => e.isFile()).map((e) => e.name);

  const imageFiles = files
    .filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase()))
    .sort(naturalCompare);
  const videoFiles = files
    .filter((f) => VIDEO_EXTS.has(path.extname(f).toLowerCase()))
    .sort(naturalCompare);

  if (Number.isFinite(maxImages) && imageFiles.length > maxImages) {
    warnings.push(`${imageFiles.length} images found — only the first ${maxImages} will be uploaded.`);
  }

  const images = imageFiles.slice(0, maxImages).map((f, i) => ({
    path: path.join(folderPath, f),
    filename: f,
    mime: mimeForImage(path.extname(f)),
    rank: i + 1,
  }));

  let video = null;
  if (videoFiles.length) {
    const f = videoFiles[0];
    video = {
      path: path.join(folderPath, f),
      filename: f,
      mime: mimeForVideo(path.extname(f)),
    };
    if (videoFiles.length > 1) {
      warnings.push(`${videoFiles.length} videos found — using "${f}" only.`);
    }
  }

  if (images.length === 0) warnings.push('No images found — product will be skipped.');

  return {
    folder: folderPath,
    name,
    images,
    video,
    imageCount: images.length,
    hasVideo: Boolean(video),
    warnings,
  };
}

/**
 * Scan an input root containing one subfolder per product.
 * @param {string} inputRoot absolute path
 * @returns {{ inputRoot:string, products:object[], skipped:object[] }}
 */
function scanInputRoot(inputRoot) {
  const resolved = path.resolve(inputRoot);
  if (!fs.existsSync(resolved)) {
    const err = new Error(`Input folder does not exist: ${resolved}`);
    err.status = 400;
    throw err;
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    const err = new Error(`Input path is not a folder: ${resolved}`);
    err.status = 400;
    throw err;
  }

  const subdirs = fs.readdirSync(resolved, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort(naturalCompare);

  const products = [];
  const skipped = [];
  for (const dir of subdirs) {
    const scanned = scanProductFolder(path.join(resolved, dir));
    if (scanned.imageCount === 0) skipped.push(scanned);
    else products.push(scanned);
  }

  return { inputRoot: resolved, products, skipped };
}

module.exports = {
  scanInputRoot,
  scanProductFolder,
  naturalCompare,
  IMAGE_EXTS,
  VIDEO_EXTS,
  MAX_IMAGES,
};
