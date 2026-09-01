'use strict';

/**
 * Single source of truth for the locations of THIS dashboard's self-contained
 * shopping-route engine and its data.
 *
 * The dashboard ships its own vendored copy of the route generator under
 * `<project>/route-engine/` so it is completely independent of any external
 * program.  Layout (mirrors a standard --project-dir install):
 *
 *   route-engine/
 *     src/generate_shopping_route.py     ← the generator
 *     src/supplier_catalog_backup.py     ← its only local dependency
 *     data/supplier_catalog.xlsx         ← supplier + charm catalog (editable)
 *     data/etsy_orders.db                ← catalog/charm SQLite (read by the UI)
 *     data/charm_manifest.json           ← charm index
 *     data/charm_images/<CODE>.<ext>     ← charm photos
 *     cache/  input/                     ← generator scratch space
 *
 * `route_engine_dir` in config overrides the default location.  For installs
 * that have not yet been migrated we transparently fall back to the legacy
 * `osp_project_dir` so nothing breaks mid-upgrade.
 */

const path = require('path');
const fs   = require('fs');

// <project root> = src/route → ../../
const PROJECT_ROOT = path.resolve(__dirname, '../../');

/** Default vendored engine directory inside this dashboard. */
const DEFAULT_ENGINE_DIR = path.join(PROJECT_ROOT, 'route-engine');

/**
 * Resolve the route-engine project directory (the --project-dir root).
 * Priority: explicit config → vendored default (if present) → legacy OSP dir.
 * @param {object} config
 * @returns {string|null}
 */
function engineDir(config) {
  if (config && config.route_engine_dir && String(config.route_engine_dir).trim()) {
    return path.resolve(String(config.route_engine_dir).trim());
  }
  // Prefer the vendored copy when it exists.
  try {
    if (fs.existsSync(path.join(DEFAULT_ENGINE_DIR, 'src', 'generate_shopping_route.py'))) {
      return DEFAULT_ENGINE_DIR;
    }
  } catch { /* ignore */ }
  // Legacy fallback: the old external Orders Sorting Program.
  if (config && config.osp_project_dir) return config.osp_project_dir;
  return null;
}

/** Absolute path to the generator script, or null when unavailable. */
function engineScript(config) {
  const dir = engineDir(config);
  return dir ? path.join(dir, 'src', 'generate_shopping_route.py') : null;
}

/** Python interpreter to run the engine with. */
function enginePython(config) {
  return (config && config.osp_python) || 'python';
}

/** Engine data directory (explicit mutable-data override, else <engineDir>/data). */
function engineDataDir(config) {
  if (config && config.route_engine_data_dir && String(config.route_engine_data_dir).trim()) {
    return path.resolve(String(config.route_engine_data_dir).trim());
  }
  const dir = engineDir(config);
  return dir ? path.join(dir, 'data') : null;
}

/** Path to the catalog/charm SQLite the UI reads, or null. */
function catalogDbPath(config) {
  const d = engineDataDir(config);
  return d ? path.join(d, 'etsy_orders.db') : null;
}

/** Path to the editable supplier catalog workbook, or null. */
function supplierCatalogPath(config) {
  const d = engineDataDir(config);
  return d ? path.join(d, 'supplier_catalog.xlsx') : null;
}

/** Path to the charm manifest JSON, or null. */
function charmManifestPath(config) {
  const d = engineDataDir(config);
  return d ? path.join(d, 'charm_manifest.json') : null;
}

/** Path to the charm images directory, or null. */
function charmImagesDir(config) {
  const d = engineDataDir(config);
  return d ? path.join(d, 'charm_images') : null;
}

module.exports = {
  PROJECT_ROOT,
  DEFAULT_ENGINE_DIR,
  engineDir,
  engineScript,
  enginePython,
  engineDataDir,
  catalogDbPath,
  supplierCatalogPath,
  charmManifestPath,
  charmImagesDir,
};
