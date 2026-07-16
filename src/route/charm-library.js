'use strict';

/**
 * Charm-library helpers: seeding from the route engine's charm_manifest.json,
 * charm-code allocation, and image-file management on the charm_images folder.
 *
 * Design: the dashboard `charm_library` SQLite table is authoritative for
 * in-app CRUD. It is SEEDED once from the bundled charm_manifest.json (seed
 * when empty), after which add/edit/delete operate on the table + image folder.
 * Charm images are stored as <code>.<ext> under the route engine's
 * data/charm_images/ folder (see engine-paths.js), which the generator reads
 * when building the route. All paths resolve inside this dashboard.
 */

const fs   = require('fs');
const path = require('path');

const { getCharmLibrary, replaceCharmLibrary } = require('../db/setup');
const routeDashboard = require('./dashboard');
const enginePaths    = require('./engine-paths');

const ALLOWED_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
const CODE_RE = /^[A-Za-z0-9_-]+$/;

/** Absolute path to the charm_images directory, or null when unconfigured. */
function charmImagesDir(config) {
  const engineDir = enginePaths.engineDir(config);
  if (!engineDir) return null;
  // Prefer the manifest's declared dir; fall back to the conventional location.
  try {
    const cat = routeDashboard.loadCharmCatalog(engineDir);
    if (cat.images_dir) return cat.images_dir;
  } catch {}
  return enginePaths.charmImagesDir(config);
}

/** Seed the charm_library table from the manifest when the table is empty. */
function seedCharmLibraryIfEmpty(db, config) {
  const engineDir = enginePaths.engineDir(config);
  if (!engineDir) return { ok: false, reason: 'route engine directory not resolved' };
  if (getCharmLibrary(db).length > 0) return { ok: true, reason: 'preserved', seeded: 0 };
  try {
    const { charms } = routeDashboard.loadCharmCatalog(engineDir);
    const rows = charms.map((c, idx) => ({
      code:               c.code,
      sku:                c.sku || '',
      default_charm_shop: c.default_charm_shop || '',
      notes:              c.notes || '',
      image_file:         c.image_file || (c.has_image ? `${c.code}.png` : ''),
      sort_order:         idx,
    }));
    const n = replaceCharmLibrary(db, rows);
    return { ok: true, reason: 'seeded', seeded: n };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/** Force re-seed the charm_library from the manifest (discards in-app edits). */
function resyncCharmLibrary(db, config) {
  const engineDir = enginePaths.engineDir(config);
  if (!engineDir) return { ok: false, reason: 'route engine directory not resolved' };
  try {
    const { charms } = routeDashboard.loadCharmCatalog(engineDir);
    const rows = charms.map((c, idx) => ({
      code:               c.code,
      sku:                c.sku || '',
      default_charm_shop: c.default_charm_shop || '',
      notes:              c.notes || '',
      image_file:         c.image_file || (c.has_image ? `${c.code}.png` : ''),
      sort_order:         idx,
    }));
    const n = replaceCharmLibrary(db, rows);
    return { ok: true, seeded: n };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * Allocate the next sequential charm code (CH-00001, CH-00002, …) by scanning
 * existing CH-#### codes in the library.
 */
function allocateNextCode(db) {
  let max = 0;
  for (const r of getCharmLibrary(db)) {
    const m = /^CH-(\d+)$/i.exec(String(r.code || ''));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `CH-${String(max + 1).padStart(5, '0')}`;
}

/**
 * Short cache-busting version token for one image file, derived from its
 * on-disk mtime + size. Any upload/replace/rename/renumber changes at least one
 * of these, so the token changes and the content-addressed URL (…?code=X&v=TOKEN)
 * becomes a brand-new URL that every cache misses — while an UNCHANGED file keeps
 * the same token and stays immutably cached. Returns '' when the file is absent.
 * @param {string} dir       absolute charm_images directory
 * @param {string} imageFile bare filename (no path separators)
 */
function imageVersionFor(dir, imageFile) {
  if (!dir || !imageFile || /[/\\]/.test(imageFile)) return '';
  try {
    const st = fs.statSync(path.join(dir, imageFile));
    return `${Math.floor(st.mtimeMs).toString(36)}-${st.size.toString(36)}`;
  } catch { return ''; }
}

/** First existing <code>.<ext> filename in `dir`, or '' when none exists. */
function findImageFile(dir, code) {
  if (!dir || !CODE_RE.test(code)) return '';
  for (const ext of ALLOWED_EXT) {
    if (fs.existsSync(path.join(dir, `${code}.${ext}`))) return `${code}.${ext}`;
  }
  return '';
}

/**
 * Resolve the cache-busting version token for a single charm. Prefers the
 * library's recorded image_file, falling back to on-disk <code>.<ext> lookup so
 * the token is correct even when the DB image_file is stale/blank.
 */
function charmImageVersion(config, code, imageFile) {
  const dir = charmImagesDir(config);
  if (!dir) return '';
  const file = (imageFile && !/[/\\]/.test(imageFile) && fs.existsSync(path.join(dir, imageFile)))
    ? imageFile
    : findImageFile(dir, code);
  return imageVersionFor(dir, file);
}

/**
 * Build a Map<code, versionToken> for every charm in the library in ONE folder
 * pass, so per-request payloads (charms list, shop route) can attach an image
 * version to each charm without stat-ing the directory once per charm.
 * @param {import('better-sqlite3').Database} db
 * @param {object} config
 * @returns {Map<string,string>}
 */
function charmImageVersionMap(db, config) {
  const map = new Map();
  const dir = charmImagesDir(config);
  if (!dir) return map;
  for (const r of getCharmLibrary(db)) {
    const file = (r.image_file && !/[/\\]/.test(r.image_file) && fs.existsSync(path.join(dir, r.image_file)))
      ? r.image_file
      : findImageFile(dir, r.code);
    const v = imageVersionFor(dir, file);
    if (v) map.set(r.code, v);
  }
  return map;
}

/** Strip a data-URL prefix and return { buffer, ext } or throw. */
function decodeImage(imageBase64, explicitExt) {
  if (!imageBase64) throw Object.assign(new Error('No image data provided.'), { code: 'REQUIRED' });
  let ext = (explicitExt || '').toLowerCase().replace(/[^a-z]/g, '');
  let b64 = imageBase64;
  const m = /^data:image\/([a-zA-Z0-9.+-]+);base64,(.*)$/s.exec(imageBase64);
  if (m) {
    if (!ext) ext = m[1].toLowerCase();
    b64 = m[2];
  }
  if (ext === 'jpeg') ext = 'jpg';
  if (!ALLOWED_EXT.includes(ext)) ext = 'png';
  const buffer = Buffer.from(b64, 'base64');
  if (!buffer.length) throw Object.assign(new Error('Image data is empty or invalid.'), { code: 'REQUIRED' });
  return { buffer, ext: ext === 'jpg' ? 'jpg' : ext };
}

/** Remove any existing <code>.<ext> image files for a code in the dir. */
function deleteImageFiles(dir, code) {
  if (!dir || !CODE_RE.test(code)) return;
  for (const ext of ALLOWED_EXT) {
    const p = path.join(dir, `${code}.${ext}`);
    try { fs.unlinkSync(p); } catch {}
  }
}

/**
 * Save an uploaded image for a charm code. Clears prior <code>.* files first,
 * then writes <code>.<ext>. Returns the stored filename.
 */
function saveCharmImage(config, code, imageBase64, explicitExt) {
  const dir = charmImagesDir(config);
  if (!dir) throw new Error('charm_images directory is not available.');
  if (!CODE_RE.test(code)) throw new Error('Invalid charm code for image.');
  fs.mkdirSync(dir, { recursive: true });
  const { buffer, ext } = decodeImage(imageBase64, explicitExt);
  deleteImageFiles(dir, code);
  const fileName = `${code}.${ext}`;
  fs.writeFileSync(path.join(dir, fileName), buffer);
  return fileName;
}

/** Rename a charm's image files from oldCode.* to newCode.<sameExt>. Returns new filename or ''. */
function renameCharmImage(config, oldCode, newCode) {
  const dir = charmImagesDir(config);
  if (!dir || !CODE_RE.test(oldCode) || !CODE_RE.test(newCode)) return '';
  for (const ext of ALLOWED_EXT) {
    const oldP = path.join(dir, `${oldCode}.${ext}`);
    try {
      fs.accessSync(oldP, fs.constants.R_OK);
      const newName = `${newCode}.${ext}`;
      deleteImageFiles(dir, newCode);
      fs.renameSync(oldP, path.join(dir, newName));
      return newName;
    } catch {}
  }
  return '';
}

/** Delete a charm's image files from disk. */
function deleteCharmImage(config, code) {
  const dir = charmImagesDir(config);
  deleteImageFiles(dir, code);
}

/**
 * Rename a batch of charm image files for a reorder/renumber operation, using a
 * two-phase move (old → sentinel → new) so chained renames never collide.
 * @param {object} config
 * @param {Array<{oldCode,newCode,ext}>} renames
 */
function reorderCharmImages(config, renames) {
  const dir = charmImagesDir(config);
  if (!dir || !Array.isArray(renames) || !renames.length) return;

  const staged = [];
  // Phase 1: old.<ext> → __reorder__<old>.<ext>
  for (const r of renames) {
    if (!CODE_RE.test(r.oldCode) || !CODE_RE.test(r.newCode)) continue;
    const ext = ALLOWED_EXT.includes(String(r.ext).toLowerCase()) ? r.ext.toLowerCase() : 'png';
    const src = path.join(dir, `${r.oldCode}.${ext}`);
    const tmp = path.join(dir, `__reorder__${r.oldCode}.${ext}`);
    try { fs.accessSync(src, fs.constants.R_OK); fs.renameSync(src, tmp); staged.push({ tmp, dest: path.join(dir, `${r.newCode}.${ext}`) }); }
    catch {}
  }
  // Phase 2: sentinel → new.<ext> (clear any stale target first)
  for (const s of staged) {
    try { fs.unlinkSync(s.dest); } catch {}
    try { fs.renameSync(s.tmp, s.dest); } catch {}
  }
}

module.exports = {
  charmImagesDir,
  seedCharmLibraryIfEmpty,
  resyncCharmLibrary,
  allocateNextCode,
  saveCharmImage,
  renameCharmImage,
  deleteCharmImage,
  reorderCharmImages,
  charmImageVersion,
  charmImageVersionMap,
};
