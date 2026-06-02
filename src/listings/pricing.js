'use strict';

/**
 * Pricing lookup for the Bulk Listing Creator.
 *
 * Reads Y2KASE_Pricing_Master_4_Currencies.xlsx. The "Pricing Strategy" sheet
 * contains four stacked tables (USD / CAD / HKD / RMB), each shaped:
 *
 *   <CUR> PRICING TABLE
 *   Product Variation | Etsy Anchor Price | True Customer Price | ...
 *   Case + Grip + Charm | 81.23 | 32.49 | ...
 *   ...
 *
 * Per the confirmed plan we use the "Etsy Anchor Price" column, matched to each
 * shop's currency. Each shop's currency is read from the Etsy shop record
 * (currency_code). RMB maps to CNY.
 */

const fs   = require('fs');
const XLSX  = require('xlsx');
const { config } = require('./config');

// Canonical internal style keys used by the variation builder + AI mapping.
const STYLE_KEYS = [
  'Case+Grip+Charm',
  'Case+Grip',
  'Case+Charm',
  'Case Only',
  'Grip Only',
  'Charm Only',
];

// Normalise the spreadsheet's "Product Variation" labels to our style keys.
function normaliseStyleLabel(label) {
  const s = String(label || '').toLowerCase().replace(/\s+/g, '');
  const map = {
    'case+grip+charm': 'Case+Grip+Charm',
    'case+grip': 'Case+Grip',
    'case+charm': 'Case+Charm',
    'caseonly': 'Case Only',
    'griponly': 'Grip Only',
    'charmonly': 'Charm Only',
  };
  return map[s] || null;
}

// Map an Etsy currency_code to the spreadsheet's table currency token.
function currencyToTableToken(currencyCode) {
  const c = String(currencyCode || '').toUpperCase();
  if (c === 'CNY') return 'RMB';
  return c; // USD, CAD, HKD, RMB
}

let _cache = null; // { mtimeMs, byCurrency: { USD: {style: {anchor, customer}}, ... } }

/**
 * Parse the workbook into a per-currency, per-style price table.
 * Cached and invalidated on file mtime change.
 * @param {string} [workbookPath]
 */
function loadPricingTables(workbookPath) {
  const file = workbookPath || config.pricingWorkbookPath;
  if (!fs.existsSync(file)) {
    const err = new Error(`Pricing workbook not found: ${file}`);
    err.status = 500;
    throw err;
  }
  const mtimeMs = fs.statSync(file).mtimeMs;
  if (_cache && _cache.file === file && _cache.mtimeMs === mtimeMs) {
    return _cache.byCurrency;
  }

  const wb = XLSX.readFile(file);
  // Prefer the "Pricing Strategy" sheet; fall back to the first sheet.
  const sheetName = wb.SheetNames.find((n) => /pricing/i.test(n)) || wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1 });

  const byCurrency = {};
  let currentCurrency = null;

  for (const row of rows) {
    if (!row || row.length === 0) continue;
    const first = String(row[0] || '').trim();
    if (!first) continue;

    // Table header e.g. "USD PRICING TABLE"
    const headerMatch = first.match(/^([A-Z]{3})\s+PRICING\s+TABLE/i);
    if (headerMatch) {
      currentCurrency = headerMatch[1].toUpperCase();
      byCurrency[currentCurrency] = {};
      continue;
    }

    // Column header row — skip.
    if (/product\s+variation/i.test(first)) continue;

    if (!currentCurrency) continue;

    const styleKey = normaliseStyleLabel(first);
    if (!styleKey) continue;

    const anchor   = Number(row[1]);
    const customer = Number(row[2]);
    if (Number.isFinite(anchor)) {
      byCurrency[currentCurrency][styleKey] = {
        anchor,
        customer: Number.isFinite(customer) ? customer : anchor,
      };
    }
  }

  _cache = { file, mtimeMs, byCurrency };
  return byCurrency;
}

/**
 * Get the style→price map for a given currency.
 * @param {string} currencyCode  Etsy shop currency_code (USD/CAD/HKD/CNY...)
 * @param {object} [opts]
 * @param {'anchor'|'customer'} [opts.column='anchor']
 * @param {string} [opts.workbookPath]
 * @returns {{ currency:string, token:string, prices: Record<string,number>, missing: string[] }}
 */
function getPricesForCurrency(currencyCode, opts = {}) {
  const column = opts.column === 'customer' ? 'customer' : 'anchor';
  const token = currencyToTableToken(currencyCode);
  const tables = loadPricingTables(opts.workbookPath);
  const table = tables[token];

  if (!table) {
    const available = Object.keys(tables).join(', ');
    const err = new Error(
      `No pricing table for currency "${currencyCode}" (looked for "${token}"). ` +
      `Available: ${available || 'none'}.`
    );
    err.status = 400;
    throw err;
  }

  const prices = {};
  const missing = [];
  for (const style of STYLE_KEYS) {
    const entry = table[style];
    if (entry && Number.isFinite(entry[column])) prices[style] = entry[column];
    else missing.push(style);
  }

  return { currency: String(currencyCode || '').toUpperCase(), token, prices, missing };
}

/** List the currencies present in the workbook (tokens, e.g. ["USD","CAD"...]). */
function listAvailableCurrencies(workbookPath) {
  return Object.keys(loadPricingTables(workbookPath));
}

module.exports = {
  STYLE_KEYS,
  loadPricingTables,
  getPricesForCurrency,
  listAvailableCurrencies,
  currencyToTableToken,
  normaliseStyleLabel,
};
