'use strict';

/**
 * Supplier-catalog importer.
 *
 * Reads the authoritative supplier directory from the bundled route engine's
 *   <route_engine_dir>/data/supplier_catalog.xlsx   (see engine-paths.js)
 * and mirrors two of its sheets into the UED database so the dashboard can
 * drive its supplier / charm-shop pickers from the exact, real shop names and
 * stall locations — completely offline, with no per-request Excel parsing.
 *
 *   • "Suppliers"   sheet  → supplier_directory   (shop_name, stall, mall, floor, address, notes)
 *   • "Charm Shops" sheet  → charm_shop_directory (shop_name, stall, notes)
 *
 * The import is idempotent (full replace in a transaction) and cheap, so it is
 * safe to run on every server start. We also skip work when the workbook's
 * mtime hasn't changed since the last successful import.
 */

const fs   = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const {
  replaceSupplierDirectory,
  replaceCharmShopDirectory,
  replaceProductMap,
} = require('../db/setup');
const enginePaths = require('./engine-paths');

/** Replicate dashboard.js normalizeTitle for product-map key generation. */
function _normalizeTitle(text) {
  return String(text ?? '').replace(/\|/g, ',').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Remembers the last-imported workbook mtime so repeated startups are no-ops.
let _lastMtimeMs = 0;

/**
 * Resolve the absolute path to supplier_catalog.xlsx from config.
 * @param {object} config
 * @returns {string|null}
 */
function catalogPath(config) {
  return enginePaths.supplierCatalogPath(config);
}

/** Normalise a header cell to a lowercase key for tolerant column matching. */
function _hkey(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

/** Read a sheet as an array of objects keyed by lowercase header names. */
function _sheetRows(wb, sheetName) {
  const ws = wb.Sheets[sheetName];
  if (!ws) return [];
  // header:1 → array-of-arrays so we control header normalisation ourselves.
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });
  if (!aoa.length) return [];
  const headers = aoa[0].map(_hkey);
  const out = [];
  for (let i = 1; i < aoa.length; i++) {
    const row = aoa[i];
    const obj = {};
    headers.forEach((h, idx) => { if (h) obj[h] = row[idx] == null ? '' : String(row[idx]).trim(); });
    out.push(obj);
  }
  return out;
}

/** First non-empty value among the given header keys. */
function _pick(obj, keys) {
  for (const k of keys) { if (obj[k] != null && obj[k] !== '') return obj[k]; }
  return '';
}

/**
 * Detect instructional / guide rows that some sheets carry at the bottom
 * (e.g. "Charm Shops — quick guide …"). Real shop names are short, single-line,
 * and never contain the word "guide".
 */
function _isGuideRow(shopName) {
  const s = String(shopName || '');
  return s.includes('\n') || s.length > 40 || /quick guide|guide\b/i.test(s);
}

/** Read the "Suppliers" sheet → array of supplier rows (preserves Excel row order). */
function _readSuppliers(wb) {
  return _sheetRows(wb, 'Suppliers')
    .map((r, idx) => ({
      shop_name:  _pick(r, ['shop name', 'shop', 'name']),
      stall:      _pick(r, ['stall']),
      mall:       _pick(r, ['mall']),
      floor:      _pick(r, ['floor']),
      address:    _pick(r, ['address']),
      notes:      _pick(r, ['notes']),
      sort_order: idx,   // preserve Excel row order exactly
    }))
    .filter(r => r.shop_name && !_isGuideRow(r.shop_name));
}

/**
 * Read the "Product Map" sheet → array of product-title → supplier + charm rows.
 * Columns: PRODUCT TITLE, SHOP NAME, STALL, Charm Shop, Charm Code
 */
function _readProductMap(wb) {
  return _sheetRows(wb, 'Product Map')
    .map((r, idx) => {
      const title = _pick(r, ['product title', 'title']);
      return {
        title,
        title_norm: _normalizeTitle(title),
        shop_name:  _pick(r, ['shop name', 'shop']),
        stall:      _pick(r, ['stall']),
        charm_shop: _pick(r, ['charm shop']),
        charm_code: _pick(r, ['charm code']),
        sort_order: idx,
      };
    })
    .filter(r => r.title_norm);   // skip blank title rows
}

/** Read the "Charm Shops" sheet → array of charm-shop rows (preserves Excel order). */
function _readCharmShops(wb) {
  return _sheetRows(wb, 'Charm Shops')
    .map((r, idx) => ({
      shop_name: _pick(r, ['shop name', 'shop', 'name', 'charm shop']),
      stall:     _pick(r, ['stall']),
      notes:     _pick(r, ['notes']),
      sort_order: idx,
    }))
    .filter(r => r.shop_name && !_isGuideRow(r.shop_name));
}

/**
 * Import the supplier catalog into the UED database.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} config - app config (needs osp_project_dir)
 * @param {{ force?: boolean, skipSuppliers?: boolean, skipCharmShops?: boolean }} [opts]
 *   force          - re-import even if mtime unchanged
 *   skipSuppliers  - leave supplier_directory untouched (preserves in-app CRUD)
 *   skipCharmShops - leave charm_shop_directory untouched (preserves in-app CRUD)
 * @returns {{ ok: boolean, reason?: string, suppliers?: number, charm_shops?: number, path?: string }}
 */
function importSupplierCatalog(db, config, opts = {}) {
  const xlsxPath = catalogPath(config);
  if (!xlsxPath) return { ok: false, reason: 'route engine directory not resolved' };
  if (!fs.existsSync(xlsxPath)) return { ok: false, reason: 'supplier_catalog.xlsx not found', path: xlsxPath };

  const mtimeMs = fs.statSync(xlsxPath).mtimeMs;
  if (!opts.force && mtimeMs === _lastMtimeMs) {
    return { ok: true, reason: 'unchanged', path: xlsxPath };
  }

  // cellStyles/sheetStubs off, bookDeps off → fast, and drawings are ignored.
  const wb = XLSX.readFile(xlsxPath, { cellDates: false, cellNF: false, cellHTML: false });

  const productMap  = _readProductMap(wb);

  // The supplier + charm-shop directories are the authoritative stores for
  // in-app CRUD, so we only (re)seed them from Excel when explicitly asked —
  // otherwise user edits would be wiped on every restart. The product map has
  // no in-app CRUD, so it always refreshes.
  let nSup = null;
  if (!opts.skipSuppliers) {
    nSup = replaceSupplierDirectory(db, _readSuppliers(wb));
  }
  let nCharm = null;
  if (!opts.skipCharmShops) {
    nCharm = replaceCharmShopDirectory(db, _readCharmShops(wb));
  }
  const nProdMap  = replaceProductMap(db, productMap);

  _lastMtimeMs = mtimeMs;
  return { ok: true, suppliers: nSup, charm_shops: nCharm, product_map: nProdMap, path: xlsxPath };
}

module.exports = { importSupplierCatalog, catalogPath };
