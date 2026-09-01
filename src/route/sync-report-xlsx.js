'use strict';

/**
 * Professional Excel renderer for the Purchase Status Sync Report.
 *
 * Turns the JSON report produced by POST /api/route/import-status (or any
 * stored version-history run) into a clean, presentation-grade .xlsx workbook
 * with embedded product photos — the kind of artifact a buying team can hand
 * to a manager or archive for the record.
 *
 * Layout (three worksheets):
 *   1. "Summary"        — headline metrics + run metadata.
 *   2. "Purchase Updates" — one row per changed product line, with the product
 *                           photo, before→after status, and per-order outcome.
 *   3. "Ready to Ship"  — every order that is fully purchased per this file.
 *
 * Styling is intentionally restrained and corporate: a branded header band,
 * banded rows, frozen headers, auto-filters, sensible column widths, and
 * status-coloured cells so the sheet reads at a glance and prints cleanly.
 *
 * Image bytes are supplied by the caller as a Map<listing_id, Buffer> so this
 * module stays free of any DB / network concerns and is trivially testable.
 */

const ExcelJS = require('exceljs');

// ── Brand palette (ARGB, no leading '#') ────────────────────────────────────
const COLORS = {
  brand:      'FF1F2937', // slate-800 — header band
  brandText:  'FFFFFFFF',
  subtle:     'FFF3F4F6', // gray-100 — zebra stripe / labels
  border:     'FFE5E7EB', // gray-200
  muted:      'FF6B7280', // gray-500
  text:       'FF111827', // gray-900
  good:       'FF059669', // emerald-600
  goodBg:     'FFD1FAE5',
  blue:       'FF2563EB',
  blueBg:     'FFDBEAFE',
  pendingBg:  'FFF3F4F6',
  warnBg:     'FFFEF3C7',
  warn:       'FF92400E',
  // Wrong Stall — cyan (location fix); kept apart from warn amber used for OOS
  cyanBg:     'FFCFFAFE',
  cyan:       'FF0E7490',
  dangerBg:   'FFFEE2E2',
  danger:     'FFB91C1C',
};

const STATUS_FILL = {
  'Purchased':         { bg: COLORS.goodBg,    fg: COLORS.good },
  'Pending':           { bg: COLORS.pendingBg, fg: COLORS.muted },
  'Out of Stock':      { bg: COLORS.warnBg,    fg: COLORS.warn },
  'Out of Production': { bg: COLORS.dangerBg,  fg: COLORS.danger },
  'Wrong Stall':       { bg: COLORS.cyanBg,    fg: COLORS.cyan },
  'Model Unavailable': { bg: COLORS.dangerBg,  fg: COLORS.danger },
};

const thinBorder = () => ({
  top:    { style: 'thin', color: { argb: COLORS.border } },
  left:   { style: 'thin', color: { argb: COLORS.border } },
  bottom: { style: 'thin', color: { argb: COLORS.border } },
  right:  { style: 'thin', color: { argb: COLORS.border } },
});

/** Detect ExcelJS image extension from a buffer's magic bytes. */
function imageExtension(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'gif';
  return 'jpeg';
}

/** Human label for a change list, e.g. "Case: Pending → Purchased". */
function changeText(changes) {
  return (changes || [])
    .map(c => `${c.label}: ${c.from} → ${c.to}`)
    .join('   |   ');
}

/** Outcome label for an order. */
function outcomeText(o) {
  const parts = [];
  if (o.now_fully_purchased) parts.push('Ready to ship');
  if (o.cleared_from_queue)  parts.push('Cleared from buy queue');
  if (o.is_manual)           parts.push('Manual entry');
  return parts.join('; ');
}

/**
 * Build the workbook.
 *
 * @param {object} report               the sync report payload
 * @param {Map<number,Buffer>} imageMap listing_id → image bytes (optional)
 * @returns {Promise<Buffer>}           xlsx file bytes
 */
async function buildSyncReportWorkbook(report, imageMap = new Map()) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Unified Etsy Dashboard';
  wb.created = report.generated_at ? new Date(report.generated_at) : new Date();

  const summary = report.summary || {};
  const orders  = Array.isArray(report.orders) ? report.orders : [];
  const ready   = Array.isArray(report.ready) ? report.ready : [];
  const when    = report.generated_at ? new Date(report.generated_at) : new Date();

  // Register every available image once; reuse the id across sheets.
  const imageIdByListing = new Map();
  const registerImage = (listingId) => {
    if (listingId == null) return null;
    if (imageIdByListing.has(listingId)) return imageIdByListing.get(listingId);
    const buf = imageMap.get(listingId) || imageMap.get(Number(listingId));
    if (!buf) { imageIdByListing.set(listingId, null); return null; }
    const ext = imageExtension(buf);
    if (!ext) { imageIdByListing.set(listingId, null); return null; }
    const imgId = wb.addImage({ buffer: buf, extension: ext });
    imageIdByListing.set(listingId, imgId);
    return imgId;
  };

  buildSummarySheet(wb, report, summary, when);
  buildUpdatesSheet(wb, orders, registerImage);
  buildReadySheet(wb, ready, registerImage);

  return wb.xlsx.writeBuffer();
}

// ── Sheet 1: Summary ─────────────────────────────────────────────────────────
function buildSummarySheet(wb, report, summary, when) {
  const ws = wb.addWorksheet('Summary', {
    properties: { defaultColWidth: 22 },
    views: [{ showGridLines: false }],
  });
  ws.columns = [{ width: 30 }, { width: 26 }, { width: 26 }, { width: 26 }];

  // Title band
  ws.mergeCells('A1:D1');
  const title = ws.getCell('A1');
  title.value = 'Purchase Status Sync Report';
  title.font = { name: 'Calibri', size: 18, bold: true, color: { argb: COLORS.brandText } };
  title.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.brand } };
  ws.getRow(1).height = 36;

  ws.mergeCells('A2:D2');
  const sub = ws.getCell('A2');
  sub.value = `${report.file || 'uploaded workbook'}  ·  ${when.toLocaleString()}`;
  sub.font = { italic: true, size: 11, color: { argb: COLORS.muted } };
  sub.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  ws.getRow(2).height = 20;

  // Metric cards (label over value, two rows of cards)
  const metrics = [
    ['Orders updated this upload', summary.updated_orders || 0, COLORS.text],
    ['Product lines changed',      summary.updated_lines || 0,  COLORS.text],
    ['Ready to ship (in file)',    summary.ready_in_file ?? summary.became_ready ?? 0, COLORS.good],
    ['Still to buy (in file)',     summary.outstanding_in_file ?? 0, COLORS.warn],
    ['Cleared from buy queue',     summary.cleared_from_queue || 0, COLORS.blue],
    ['Orders in file',             summary.orders_in_file || 0, COLORS.text],
    ['Manual entries',             summary.manual_lines || 0,   COLORS.muted],
    ['Charm groups updated',       summary.updated_charms || 0, COLORS.text],
  ];

  let r = 4;
  for (let i = 0; i < metrics.length; i += 2) {
    placeCard(ws, r, 1, metrics[i]);
    if (metrics[i + 1]) placeCard(ws, r, 3, metrics[i + 1]);
    ws.getRow(r).height = 18;
    ws.getRow(r + 1).height = 30;
    r += 3;
  }

  // Warnings (if any)
  const warnings = Array.isArray(report.warnings) ? report.warnings : [];
  if (warnings.length) {
    ws.mergeCells(`A${r}:D${r}`);
    const wc = ws.getCell(`A${r}`);
    wc.value = `\u26A0  ${warnings.length} cell(s) ignored during import`;
    wc.font = { bold: true, color: { argb: COLORS.warn } };
    wc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.warnBg } };
    wc.alignment = { vertical: 'middle', indent: 1 };
    ws.getRow(r).height = 20;
    r += 1;
    for (const w of warnings.slice(0, 50)) {
      ws.mergeCells(`A${r}:D${r}`);
      const c = ws.getCell(`A${r}`);
      c.value = w;
      c.font = { size: 10, color: { argb: COLORS.muted } };
      c.alignment = { indent: 2, wrapText: true };
      r += 1;
    }
  }
}

function placeCard(ws, row, col, [label, value, valColor]) {
  const labelCell = ws.getCell(row, col);
  labelCell.value = String(label).toUpperCase();
  labelCell.font = { size: 9, bold: true, color: { argb: COLORS.muted } };
  labelCell.alignment = { vertical: 'middle', indent: 1 };

  const valueCell = ws.getCell(row + 1, col);
  valueCell.value = value;
  valueCell.font = { size: 22, bold: true, color: { argb: valColor || COLORS.text } };
  valueCell.alignment = { vertical: 'middle', indent: 1 };
  valueCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.subtle } };
  // Border the value cell + the one to its right (cards span 2 columns visually)
  const right = ws.getCell(row + 1, col + 1);
  right.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.subtle } };
  valueCell.border = { left: { style: 'thin', color: { argb: COLORS.border } }, bottom: { style: 'thin', color: { argb: COLORS.border } }, top: { style: 'thin', color: { argb: COLORS.border } } };
  right.border = { right: { style: 'thin', color: { argb: COLORS.border } }, bottom: { style: 'thin', color: { argb: COLORS.border } }, top: { style: 'thin', color: { argb: COLORS.border } } };
}

// ── Shared: styled header row ────────────────────────────────────────────────
function styleHeader(ws, headerRowIdx, count) {
  const row = ws.getRow(headerRowIdx);
  row.height = 24;
  for (let c = 1; c <= count; c++) {
    const cell = row.getCell(c);
    cell.font = { bold: true, color: { argb: COLORS.brandText }, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.brand } };
    cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    cell.border = thinBorder();
  }
}

function statusCellStyle(cell, value) {
  const key = String(value || '');
  const found = Object.keys(STATUS_FILL).find(k => key.includes(k));
  if (found) {
    cell.font = { color: { argb: STATUS_FILL[found].fg }, bold: true, size: 10 };
  }
}

// ── Sheet 2: Purchase Updates ────────────────────────────────────────────────
function buildUpdatesSheet(wb, orders, registerImage) {
  const ws = wb.addWorksheet('Purchase Updates', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Order #',        key: 'order',    width: 16 },
    { header: 'Shop',           key: 'shop',     width: 22 },
    { header: 'Buyer',          key: 'buyer',    width: 22 },
    { header: 'Photo',          key: 'photo',    width: 11 },
    { header: 'Product',        key: 'product',  width: 46 },
    { header: 'Status Changes', key: 'changes',  width: 40 },
    { header: 'Outcome',        key: 'outcome',  width: 24 },
  ];
  styleHeader(ws, 1, 7);
  ws.autoFilter = { from: 'A1', to: 'G1' };

  let rowIdx = 2;
  let band = false;
  for (const o of orders) {
    const orderLabel = o.is_manual ? 'Manual' : `#${o.order_number}`;
    const outcome = outcomeText(o);
    const lines = Array.isArray(o.lines) && o.lines.length ? o.lines : [{ title: '', changes: [] }];
    band = !band;
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const row = ws.getRow(rowIdx);
      row.height = 50;
      row.getCell(1).value = i === 0 ? orderLabel : '';
      row.getCell(2).value = i === 0 ? (o.shop_name || '') : '';
      row.getCell(3).value = i === 0 ? (o.buyer_name || '') : '';
      row.getCell(5).value = ln.title || '';
      row.getCell(6).value = changeText(ln.changes);
      row.getCell(7).value = i === 0 ? outcome : '';

      // Per-cell styling
      for (let c = 1; c <= 7; c++) {
        const cell = row.getCell(c);
        cell.border = thinBorder();
        cell.alignment = { vertical: 'middle', wrapText: c === 5 || c === 6, indent: 1 };
        if (band) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.subtle } };
      }
      row.getCell(1).font = { bold: true, color: { argb: COLORS.text } };
      statusCellStyle(row.getCell(6), changeText(ln.changes).includes('Purchased') ? 'Purchased' : '');
      if (i === 0 && o.now_fully_purchased) {
        row.getCell(7).font = { bold: true, color: { argb: COLORS.good } };
      }

      // Embed photo
      const imgId = registerImage(ln.listing_id);
      if (imgId != null) {
        ws.addImage(imgId, {
          tl: { col: 3.15, row: (rowIdx - 1) + 0.08 },
          ext: { width: 46, height: 46 },
          editAs: 'oneCell',
        });
      }
      rowIdx++;
    }
  }

  if (rowIdx === 2) {
    ws.mergeCells('A2:G2');
    const c = ws.getCell('A2');
    c.value = 'No line-item changes in this upload.';
    c.font = { italic: true, color: { argb: COLORS.muted } };
    c.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(2).height = 28;
  }
}

// ── Sheet 3: Ready to Ship ───────────────────────────────────────────────────
function buildReadySheet(wb, ready, registerImage) {
  const ws = wb.addWorksheet('Ready to Ship', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Order #', key: 'order',   width: 16 },
    { header: 'Photo',   key: 'photo',   width: 11 },
    { header: 'Shop',    key: 'shop',    width: 26 },
    { header: 'Buyer',   key: 'buyer',   width: 28 },
    { header: 'Product', key: 'product', width: 46 },
    { header: 'Status',  key: 'status',  width: 16 },
  ];
  styleHeader(ws, 1, 6);
  ws.autoFilter = { from: 'A1', to: 'F1' };

  let rowIdx = 2;
  let band = false;
  for (const o of ready) {
    band = !band;
    const row = ws.getRow(rowIdx);
    row.height = 50;
    row.getCell(1).value = `#${o.order_number}`;
    row.getCell(3).value = o.shop_name || '';
    row.getCell(4).value = o.buyer_name || '';
    row.getCell(5).value = o.product || '';
    row.getCell(6).value = 'Ready';
    for (let c = 1; c <= 6; c++) {
      const cell = row.getCell(c);
      cell.border = thinBorder();
      cell.alignment = { vertical: 'middle', wrapText: c === 5, indent: 1 };
      if (band) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.subtle } };
    }
    row.getCell(1).font = { bold: true, color: { argb: COLORS.text } };
    row.getCell(6).font = { bold: true, color: { argb: COLORS.good } };

    const imgId = registerImage(o.image_listing_id);
    if (imgId != null) {
      ws.addImage(imgId, {
        tl: { col: 1.15, row: (rowIdx - 1) + 0.08 },
        ext: { width: 46, height: 46 },
        editAs: 'oneCell',
      });
    }
    rowIdx++;
  }

  if (rowIdx === 2) {
    ws.mergeCells('A2:F2');
    const c = ws.getCell('A2');
    c.value = 'No fully-purchased orders in this file yet.';
    c.font = { italic: true, color: { argb: COLORS.muted } };
    c.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(2).height = 28;
  }
}

module.exports = { buildSyncReportWorkbook };
