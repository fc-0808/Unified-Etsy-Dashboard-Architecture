'use strict';

/**
 * Purchase-status importer.
 *
 * Parses an employee-edited Chinese status workbook
 * (`shopping_route_zh_status.xlsx`) and extracts the per-component buy statuses
 * so the server can write them straight back into `route_assignments` — the
 * single table that drives BOTH the Route tab and the Orders tab's
 * "needs shipping / pre-transit" purchasing rollup.
 *
 * The status workbook is grouped by supplier/floor and carries no order number
 * or product title in any visible cell, so it cannot be mapped back to a
 * specific order line by content. To make it losslessly re-importable, the
 * Python generator embeds a hidden machine-readable key column (header
 * {@link KEY_HEADER}) on every data row:
 *
 *   • Case/Grip line row →  {"t":"l","r":"<order#>","k":"<item_key>"}
 *   • Charm aggregate row →  {"t":"c","code":"<charm_code>",
 *                             "lines":[["<order#>","<item_key>",<qty>], ...]}
 *
 * where `item_key` is byte-identical to the dashboard's
 * `lineItemKey(title, listing_id)`. We read the status cells (Case/Grip at the
 * S1 columns, Charm at the S2 column) and translate the localized status text
 * (中文 or English) back to the canonical English STATUS_OPTIONS the rest of the
 * system stores.
 */

const XLSX = require('xlsx');

/** Hidden key-column header written by the Python generator. */
const KEY_HEADER = '__UED_KEY__';

/**
 * Column indices (0-based) of the per-component status cells in the status
 * workbook produced by `_sheet_route_simple` with `show_components=True`:
 *   Section 1 (Case/Grip lines): Case = col 6, Grip = col 7  → idx 5, 6
 *   Section 2 (Charm aggregate): Charm = col 6               → idx 5
 */
const CASE_IDX  = 5;
const GRIP_IDX  = 6;
const CHARM_IDX = 5;

/** Localized status text → canonical English. */
const ZH_TO_EN = {
  '待处理': 'Pending',
  '已购买': 'Purchased',
  '缺货': 'Out of Stock',
  '停产': 'Out of Production',
  '错档口位': 'Wrong Stall',
  '没有此型号': 'Model Unavailable',
};
const EN_STATUSES = new Set(['Pending', 'Purchased', 'Out of Stock', 'Out of Production', 'Wrong Stall', 'Model Unavailable']);

/** Values that mean "this component does not apply to this line" → ignore. */
const NA_VALUES = new Set(['N/A', 'NA', '不适用', '', '—', '-', '\u2014']);

/**
 * Normalize a raw status cell to canonical English, or null when the cell is
 * blank / N/A / unrecognized (so callers leave that component untouched).
 * @param {*} value
 * @returns {string|null}
 */
function normalizeStatus(value) {
  const s = String(value ?? '').trim();
  if (!s || NA_VALUES.has(s)) return null;
  if (EN_STATUSES.has(s)) return s;
  if (ZH_TO_EN[s]) return ZH_TO_EN[s];
  return null;
}

/**
 * True when a cell holds text that is neither blank, N/A, nor a recognized
 * status — i.e. a value an employee typed/pasted that we cannot map and will
 * ignore. Used to surface gentle warnings instead of silently dropping edits.
 * @param {*} value
 * @returns {boolean}
 */
function isUnrecognizedStatus(value) {
  const s = String(value ?? '').trim();
  if (!s || NA_VALUES.has(s)) return false;
  return !EN_STATUSES.has(s) && !ZH_TO_EN[s];
}

/**
 * Parse an uploaded status workbook buffer.
 *
 * @param {Buffer} buf - raw .xlsx bytes
 * @returns {{
 *   hasKeyColumn: boolean,
 *   lines: Array<{ receipt_id:number, item_key:string,
 *                  status_case:string|null, status_grip:string|null }>,
 *   charms: Array<{ code:string, status:string|null,
 *                   lines:Array<[string|number, string, number]> }>,
 *   warnings: string[]
 * }}
 */
function parseStatusWorkbook(buf) {
  const result = { hasKeyColumn: false, lines: [], charms: [], warnings: [] };

  let wb;
  try {
    wb = XLSX.read(buf, { type: 'buffer' });
  } catch (err) {
    throw new Error(`Could not read the workbook: ${err.message}`);
  }

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: null });
    if (!aoa.length) continue;

    // Locate the hidden key column by its header sentinel (it sits past the last
    // visible column, but its index is identical across both section headers).
    let keyCol = -1;
    for (const row of aoa) {
      if (!Array.isArray(row)) continue;
      const idx = row.findIndex(c => String(c ?? '').trim() === KEY_HEADER);
      if (idx >= 0) { keyCol = idx; break; }
    }
    if (keyCol < 0) continue;
    result.hasKeyColumn = true;

    for (const row of aoa) {
      if (!Array.isArray(row)) continue;
      const rawKey = row[keyCol];
      if (rawKey == null) continue;
      const s = String(rawKey).trim();
      if (!s || s === KEY_HEADER || s.charAt(0) !== '{') continue;

      let key;
      try { key = JSON.parse(s); } catch { continue; }

      if (key.t === 'l') {
        const receiptId = Number(key.r);
        const itemKey = String(key.k ?? '');
        if (!Number.isInteger(receiptId) || !itemKey) continue;
        if (isUnrecognizedStatus(row[CASE_IDX])) {
          result.warnings.push(`Order #${key.r}: unrecognized Case status "${String(row[CASE_IDX]).trim()}" — left unchanged.`);
        }
        if (isUnrecognizedStatus(row[GRIP_IDX])) {
          result.warnings.push(`Order #${key.r}: unrecognized Grip status "${String(row[GRIP_IDX]).trim()}" — left unchanged.`);
        }
        const statusCase = normalizeStatus(row[CASE_IDX]);
        const statusGrip = normalizeStatus(row[GRIP_IDX]);
        if (statusCase == null && statusGrip == null) continue;
        result.lines.push({
          receipt_id: receiptId,
          item_key: itemKey,
          status_case: statusCase,
          status_grip: statusGrip,
        });
      } else if (key.t === 'c') {
        const code = String(key.code ?? '').trim();
        if (!code) continue;
        if (isUnrecognizedStatus(row[CHARM_IDX])) {
          result.warnings.push(`Charm ${code}: unrecognized status "${String(row[CHARM_IDX]).trim()}" — left unchanged.`);
        }
        const status = normalizeStatus(row[CHARM_IDX]);
        const lines = Array.isArray(key.lines) ? key.lines : [];
        result.charms.push({ code, status, lines });
      }
    }
  }

  return result;
}

module.exports = {
  KEY_HEADER,
  normalizeStatus,
  isUnrecognizedStatus,
  parseStatusWorkbook,
};
