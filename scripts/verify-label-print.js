'use strict';

// Verification harness for the crisp label-print pipeline. Exercises the REAL
// production module (src/fourpx/label-print.js), not a copy.
// Usage: node scripts/verify-label-print.js [path-to-label.pdf]

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const sharp = require('sharp');
const { loadConfig } = require('../src/config/schema');
const { initDb } = require('../src/db/setup');
const { renderLabelBitmap, printBitmapWindows, writeTempLabelPng } = require('../src/fourpx/label-print');

const SCRIPT = path.join(__dirname, 'print-label-image.ps1');

function fetchBuffer(url, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, (up) => {
      if (up.statusCode !== 200) { up.resume(); return reject(new Error(`HTTP ${up.statusCode}`)); }
      const chunks = [];
      up.on('data', (c) => chunks.push(c));
      up.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
  });
}

// Resolve a sample label PDF: an explicit path arg, else the newest stored
// label URL in the DB (downloaded to a temp file).
async function resolveSamplePdf(config) {
  const arg = process.argv[2];
  if (arg && fs.existsSync(arg)) return arg;
  const db = initDb(config.db_path);
  const rows = db.prepare(
    `SELECT fourpx_label_url FROM receipts
      WHERE fourpx_label_url IS NOT NULL AND fourpx_label_url <> ''
      ORDER BY receipt_id DESC LIMIT 5`
  ).all();
  for (const r of rows) {
    try {
      const buf = await fetchBuffer(r.fourpx_label_url);
      const fp = path.join(os.tmpdir(), 'ued-verify-label.pdf');
      fs.writeFileSync(fp, buf);
      return fp;
    } catch (_) { /* try next */ }
  }
  return null;
}

function ok(label) { console.log(`  PASS  ${label}`); }
function bad(label, detail) { console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); process.exitCode = 1; }

(async () => {
  const config = loadConfig();
  console.log('Config:');
  console.log(`  mode=${config.label_print_mode} printer="${config.label_printer_name}" ` +
    `media=${config.label_width_mm}x${config.label_height_mm}mm dpi=${config.label_dpi} ` +
    `threshold=${config.label_print_threshold} copies=${config.label_print_copies}`);

  const SRC = await resolveSamplePdf(config);
  if (!SRC || !fs.existsSync(SRC)) { bad('a sample label PDF is available (pass a path, or store a 4PX label first)'); return; }
  console.log(`  sample label: ${SRC}`);

  // 1) Production render path.
  console.log('\n[1] renderLabelBitmap (production module)');
  const { png, width, height } = await renderLabelBitmap(fs.readFileSync(SRC), {
    widthMm: config.label_width_mm,
    heightMm: config.label_height_mm,
    dpi: config.label_dpi,
    threshold: config.label_print_threshold,
  });
  const expectW = Math.round((config.label_width_mm / 25.4) * config.label_dpi);
  const expectH = Math.round((config.label_height_mm / 25.4) * config.label_dpi);
  (width === expectW && height === expectH)
    ? ok(`dot grid ${width}x${height} == native ${expectW}x${expectH}`)
    : bad('dot grid matches printer native resolution', `${width}x${height} != ${expectW}x${expectH}`);

  // 2) Confirm the bitmap is genuinely binary (pure black/white → crisp barcode).
  console.log('\n[2] 1-bit purity check');
  const { data, info } = await sharp(png).grayscale().raw().toBuffer({ resolveWithObject: true });
  const seen = new Set();
  let nonBinary = 0;
  for (let i = 0; i < data.length; i++) {
    seen.add(data[i]);
    if (data[i] > 16 && data[i] < 239) nonBinary++;
  }
  const greyPct = (nonBinary / data.length) * 100;
  console.log(`  distinct grey levels: ${seen.size}; mid-grey pixels: ${greyPct.toFixed(3)}%`);
  greyPct < 0.5
    ? ok('image is effectively pure black/white (no anti-alias blur)')
    : bad('image should be pure black/white', `${greyPct.toFixed(2)}% grey`);
  void info;

  // 3) Write the temp PNG exactly as the endpoint does.
  console.log('\n[3] writeTempLabelPng');
  const pngPath = writeTempLabelPng(png, 'VERIFY-Test Buyer');
  fs.existsSync(pngPath) ? ok(`wrote ${pngPath}`) : bad('temp PNG written');

  if (process.platform !== 'win32') {
    console.log('\n[4/5] skipped (not Windows)');
    return;
  }

  // 4) PS print script rejects an invalid printer cleanly (powers the 'auto'
  //    fallback-to-open behaviour). This must NOT print anything.
  console.log('\n[4] print script error handling (bogus printer)');
  try {
    await printBitmapWindows(pngPath, {
      printerName: '___NoSuchPrinter___',
      widthMm: config.label_width_mm,
      heightMm: config.label_height_mm,
      copies: 1,
      scriptPath: SCRIPT,
    });
    bad('invalid printer should reject', 'resolved instead');
  } catch (e) {
    /not found|invalid/i.test(e.message)
      ? ok(`rejected with: "${e.message.split(/\r?\n/)[0]}"`)
      : bad('invalid printer rejection message', e.message);
  }

  // 5) Confirm the CONFIGURED printer is actually installed, so 'auto' mode will
  //    silently print rather than silently fall back to opening the PDF.
  console.log('\n[5] configured printer is installed');
  const { execSync } = require('child_process');
  let installed = [];
  try {
    const out = execSync('powershell -NoProfile -Command "Get-Printer | Select-Object -ExpandProperty Name"', { encoding: 'utf8' });
    installed = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch (e) { /* ignore */ }
  installed.includes(config.label_printer_name)
    ? ok(`"${config.label_printer_name}" is installed → auto mode will print directly`)
    : bad(`configured printer "${config.label_printer_name}" not found`, `installed: ${installed.join(', ')}`);

  console.log('\nDone. (No physical print was sent — run a real Print label click to confirm output.)');
})().catch((e) => { console.error('VERIFY ERROR:', e); process.exit(1); });
