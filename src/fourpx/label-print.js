'use strict';

/**
 * Crisp shipping-label printing for thermal label printers.
 *
 * THE PROBLEM
 *   4PX label PDFs embed the barcode as a high-resolution RASTER image. When a
 *   normal print pipeline (Adobe "Fit", or the browser's PDF print) scales that
 *   page to fit the label media, it resamples the 1-bit barcode with grayscale
 *   anti-aliasing — turning the crisp black bars into fuzzy grey ones. On a
 *   203 dpi thermal head that prints visibly blurry and can be unscannable.
 *
 * THE FIX (what ShipStation / Pirate Ship / EasyPost do)
 *   Render the label OURSELVES to a pure 1-bit black/white bitmap sized to the
 *   printer's EXACT native dot grid (e.g. 80 mm @ 203 dpi = 640×640 dots), then
 *   print it 1:1 (nearest-neighbour, no driver scaling). Every barcode bar lands
 *   on a whole printer dot, so the result is razor-sharp and scannable.
 *
 *   Pipeline:
 *     PDF ──pdfium──▶ supersampled RGBA ──sharp──▶ greyscale ▶ resize-to-dots
 *         ▶ threshold(1-bit) ▶ PNG ──PowerShell/GDI──▶ printer (1:1)
 *
 * On non-Windows hosts (or when no printer is configured) the caller falls back
 * to opening the PDF in the OS default app — this module only owns the
 * render + Windows direct-print path.
 *
 * @module src/fourpx/label-print
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawn } = require('child_process');
const sharp = require('sharp');
const { PDFiumLibrary } = require('@hyzyla/pdfium');

// pdfium is a WASM module; initialise it once and reuse across requests.
let _pdfiumPromise = null;
function getPdfium() {
  if (!_pdfiumPromise) _pdfiumPromise = PDFiumLibrary.init();
  return _pdfiumPromise;
}

/**
 * @typedef {object} LabelBitmapOptions
 * @property {number} [widthMm=80]      Physical media width in millimetres.
 * @property {number} [heightMm=80]     Physical media height in millimetres.
 * @property {number} [dpi=203]         Printer head resolution (dots per inch).
 * @property {number} [threshold=160]   Binarisation cutoff (1–255).
 * @property {number} [supersample=3]   Render oversampling factor before threshold.
 */

/**
 * Rasterize the first page of a label PDF into a crisp 1-bit PNG sized to the
 * printer's exact dot grid.
 *
 * @param {Buffer} pdfBuffer
 * @param {LabelBitmapOptions} [opts]
 * @returns {Promise<{ png: Buffer, width: number, height: number, coveragePct: number }>}
 *   coveragePct is the % of the media area the label content fills after the
 *   aspect-preserving fit. A low value means the configured media size does not
 *   match the label's real shape (e.g. a square label on tall/wide stock) — the
 *   caller can surface this so a media-size misconfiguration never prints
 *   silently shrunk/off-centre.
 */
async function renderLabelBitmap(pdfBuffer, opts = {}) {
  const widthMm     = opts.widthMm     ?? 80;
  const heightMm    = opts.heightMm    ?? 80;
  const dpi         = opts.dpi         ?? 203;
  const threshold   = opts.threshold   ?? 160;
  const supersample = opts.supersample ?? 3;

  // Target dot grid: physical size × printer dpi.
  const targetW = Math.max(1, Math.round((widthMm  / 25.4) * dpi));
  const targetH = Math.max(1, Math.round((heightMm / 25.4) * dpi));

  const lib = await getPdfium();
  const doc = await lib.loadDocument(pdfBuffer);
  try {
    const page = doc.getPage(0);

    // PDFium renders at (points × scale) pixels. We oversample relative to the
    // target dot grid so the single downscale-then-threshold step produces clean
    // edges. scale is derived from the page's own width so the result is
    // independent of the label's point size.
    let pageWidthPt  = 266.45; // 4PX labels are ~3.7in square; safe fallback
    let pageHeightPt = 266.45;
    try {
      const sz = page.getOriginalSize();
      if (sz && sz.originalWidth  > 0) pageWidthPt  = sz.originalWidth;
      if (sz && sz.originalHeight > 0) pageHeightPt = sz.originalHeight;
    } catch (_) { /* use fallback */ }
    const renderPx = targetW * supersample;
    const scale = renderPx / pageWidthPt;

    const r = await page.render({ scale });
    const raw = Buffer.from(r.data.buffer || r.data);

    // Greyscale → fit into the exact dot grid (white letterbox if aspect differs)
    // → hard threshold to pure black/white. The threshold is what kills the
    // grey anti-aliasing and keeps the barcode bars solid.
    const buffer = await sharp(raw, { raw: { width: r.width, height: r.height, channels: 4 } })
      .flatten({ background: '#ffffff' })
      .grayscale()
      .resize(targetW, targetH, { kernel: 'lanczos3', fit: 'contain', background: '#ffffff' })
      .threshold(threshold)
      .png({ compressionLevel: 9 })
      .toBuffer();

    // How much of the media the label actually covers after the aspect-
    // preserving `fit: contain`. With contain the content fills one axis fully
    // and is letterboxed on the other, so coverage = min(aspect ratio) — 100%
    // means the label shape matches the media, lower means growing white margins.
    const srcAspect   = pageWidthPt / pageHeightPt;
    const mediaAspect = targetW / targetH;
    const coveragePct = Math.round(
      (Math.min(srcAspect, mediaAspect) / Math.max(srcAspect, mediaAspect)) * 100
    );

    return { png: buffer, width: targetW, height: targetH, coveragePct };
  } finally {
    try { doc.destroy(); } catch (_) { /* ignore */ }
  }
}

/**
 * Print a PNG bitmap 1:1 (no scaling, nearest-neighbour) to a named Windows
 * printer using GDI via PowerShell. The bitmap MUST already be sized to the
 * media's dot grid so the draw is pixel-perfect.
 *
 * @param {string} pngPath        Absolute path to the PNG to print.
 * @param {object} opts
 * @param {string} opts.printerName
 * @param {number} opts.widthMm
 * @param {number} opts.heightMm
 * @param {number} [opts.copies=1]
 * @param {string} opts.scriptPath  Absolute path to print-label-image.ps1.
 * @returns {Promise<void>}
 */
function printBitmapWindows(pngPath, opts) {
  const { printerName, widthMm, heightMm, copies = 1, scriptPath } = opts;
  return new Promise((resolve, reject) => {
    const args = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-ImagePath', pngPath,
      '-Printer', printerName,
      '-WidthMm', String(widthMm),
      '-HeightMm', String(heightMm),
      '-Copies', String(copies),
    ];
    const ps = spawn('powershell.exe', args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    ps.stdout.on('data', (d) => { stdout += d.toString(); });
    ps.stderr.on('data', (d) => { stderr += d.toString(); });
    ps.on('error', reject);
    ps.on('close', (code) => {
      if (code === 0 && /PRINTED:/i.test(stdout)) {
        resolve();
      } else {
        const msg = (stderr || stdout || `powershell exited with code ${code}`).trim();
        const err = new Error(msg);
        // Exit 4/5 are the script's pre-flight "printer offline / not ready"
        // signals. They are actionable hardware faults, so the caller must
        // surface them rather than silently falling back to opening the PDF.
        if (code === 4 || code === 5) err.printerNotReady = true;
        reject(err);
      }
    });
  });
}

/**
 * Write the rendered label PNG to a stable temp file (named by buyer so the
 * print queue entry is identifiable) and return its path.
 *
 * @param {Buffer} png
 * @param {string} baseName  Filename base WITHOUT extension (already sanitised).
 * @returns {string} absolute path to the written PNG
 */
function writeTempLabelPng(png, baseName) {
  const dir = path.join(os.tmpdir(), 'ued-4px-labels');
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `${baseName}.png`);
  fs.writeFileSync(fp, png);
  return fp;
}

module.exports = {
  renderLabelBitmap,
  printBitmapWindows,
  writeTempLabelPng,
};
