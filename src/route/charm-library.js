'use strict';

/**
 * Charm-library helpers: seeding from OSP's charm_manifest.json, charm-code
 * allocation, and image-file management on the shared charm_images folder.
 *
 * Design: the UED `charm_library` SQLite table is authoritative for in-app
 * CRUD. It is SEEDED once from OSP's read-only charm_manifest.json (seed when
 * empty), after which add/edit/delete operate on the table + the image folder.
 * Charm images are stored as <code>.<ext> under <osp>/data/charm_images/, the
 * same folder OSP reads from on disk, so new/updated images are visible to both
 * programs without touching supplier_catalog.xlsx (which would lose embeds).
 */

const fs   = require('fs');
const path = require('path');

const { getCharmLibrary, replaceCharmLibrary } = require('../db/setup');
const routeDashboard = require('./dashboard');

const ALLOWED_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
const CODE_RE = /^[A-Za-z0-9_-]+$/;

/** Absolute path to the charm_images directory, or null when unconfigured. */
function charmImagesDir(config) {
  if (!config || !config.osp_project_dir) return null;
  // Prefer the manifest's declared dir; fall back to the conventional location.
  try {
    const cat = routeDashboard.loadCharmCatalog(config.osp_project_dir);
    if (cat.images_dir) return cat.images_dir;
  } catch {}
  return path.join(config.osp_project_dir, 'data', 'charm_images');
}

/** Seed the charm_library table from the manifest when the table is empty. */
function seedCharmLibraryIfEmpty(db, config) {
  if (!config || !config.osp_project_dir) return { ok: false, reason: 'osp_project_dir not configured' };
  if (getCharmLibrary(db).length > 0) return { ok: true, reason: 'preserved', seeded: 0 };
  try {
    const { charms } = routeDashboard.loadCharmCatalog(config.osp_project_dir);
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
  if (!config || !config.osp_project_dir) return { ok: false, reason: 'osp_project_dir not configured' };
  try {
    const { charms } = routeDashboard.loadCharmCatalog(config.osp_project_dir);
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
};
