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
const {
  renderLabelBitmap,
  printBitmapWindows,
  writeTempLabelPng,
  MIN_HEALTHY_COVERAGE_PCT,
} = require('../src/fourpx/label-print');

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

/**
 * Read the driver's page geometry for a printer: the printable area of its
 * default stock (in hundredths of an inch, the unit the print script draws in)
 * and the device resolutions it advertises.
 *
 * @param {string} printerName
 * @returns {{ paperName: string, printableW: number, printableH: number,
 *             dpiX: number, dpiY: number, resolutions: number[] } | null}
 */
function probePrinterGeometry(printerName) {
  const ps = `
    Add-Type -AssemblyName System.Drawing | Out-Null
    $s = New-Object System.Drawing.Printing.PrinterSettings
    $s.PrinterName = ${JSON.stringify(printerName).replace(/"/g, "'")}
    if (-not $s.IsValid) { exit 1 }
    $d = $s.DefaultPageSettings
    [pscustomobject]@{
      paperName   = $d.PaperSize.PaperName
      printableW  = [double]$d.PrintableArea.Width
      printableH  = [double]$d.PrintableArea.Height
      dpiX        = [int]$d.PrinterResolution.X
      dpiY        = [int]$d.PrinterResolution.Y
      resolutions = @($s.PrinterResolutions | Where-Object { $_.X -gt 0 } | ForEach-Object { [int]$_.X })
    } | ConvertTo-Json -Compress`;
  // -EncodedCommand sidesteps every layer of cmd/PowerShell quoting.
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  try {
    const out = require('child_process').execSync(
      `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
      { encoding: 'utf8' }
    );
    const parsed = JSON.parse(out);
    // ConvertTo-Json collapses a single-element array to a scalar.
    parsed.resolutions = [].concat(parsed.resolutions ?? []);
    return parsed;
  } catch (_) {
    return null;
  }
}

/** Physical size of the inked region of a rendered label, in millimetres. */
async function measureInkExtentMm(png, width, height, dpi) {
  const { data } = await sharp(png).grayscale().raw().toBuffer({ resolveWithObject: true });
  let minX = width, maxX = -1, minY = height, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[y * width + x] >= 128) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const mmPerDot = 25.4 / dpi;
  return maxX < 0
    ? { w: 0, h: 0 }
    : { w: (maxX - minX + 1) * mmPerDot, h: (maxY - minY + 1) * mmPerDot };
}

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
  const { png, width, height, coveragePct } = await renderLabelBitmap(fs.readFileSync(SRC), {
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

  // 1b) Media fit. The render letterboxes rather than failing, so stock of the
  //     wrong SHAPE prints silently shrunk — 4PX labels are square, so 80x60 mm
  //     stock scores 75% and loses a quarter of the barcode size. This is the
  //     check that catches a config/stock drift before a batch goes out.
  console.log('\n[1b] media fit (configured stock vs label shape)');
  coveragePct >= MIN_HEALTHY_COVERAGE_PCT
    ? ok(`label fills ${coveragePct}% of the ${config.label_width_mm}x${config.label_height_mm}mm media`)
    : bad(`label should fill >=${MIN_HEALTHY_COVERAGE_PCT}% of the configured media`,
      `${coveragePct}% — it will print letterboxed/shrunk on ${config.label_width_mm}x${config.label_height_mm}mm stock`);

  // 1c) Ink extent. Confirms the shrink is real and measurable rather than
  //     trusting the coverage arithmetic alone.
  const inkMm = await measureInkExtentMm(png, width, height, config.label_dpi);
  console.log(`  printed artwork measures ${inkMm.w.toFixed(1)} x ${inkMm.h.toFixed(1)} mm on ` +
    `${config.label_width_mm} x ${config.label_height_mm} mm stock`);

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

  // 3b) The print script must stay pure ASCII. Windows PowerShell 5.1 decodes a
  //     BOM-less .ps1 using the system ANSI codepage, so a stray em-dash inside
  //     a string literal mojibakes into something containing a quote and the
  //     whole script fails to parse - every print breaks at once.
  console.log('\n[3b] print script is ASCII-safe for Windows PowerShell');
  const scriptSrc = fs.readFileSync(SCRIPT, 'utf8');
  const nonAscii = [...new Set(scriptSrc.match(/[^\x00-\x7F]/g) || [])];
  nonAscii.length === 0
    ? ok('print-label-image.ps1 contains no non-ASCII characters')
    : bad('print-label-image.ps1 must be pure ASCII', `found: ${nonAscii.join(' ')}`);

  // 4) PS print script rejects an invalid printer cleanly (powers the 'auto'
  //    fallback-to-open behaviour). This must NOT print anything.
  console.log('\n[4] print script error handling (bogus printer)');
  try {
    await printBitmapWindows(pngPath, {
      printerName: '___NoSuchPrinter___',
      widthMm: config.label_width_mm,
      heightMm: config.label_height_mm,
      copies: 1,
      dpi: config.label_dpi,
      scriptPath: SCRIPT,
    });
    bad('invalid printer should reject', 'resolved instead');
  } catch (e) {
    // PowerShell prefixes Write-Error output with the script path and position,
    // so report the line that carries the actual reason rather than line 1.
    const reason = e.message.split(/\r?\n/).find((l) => /not found|invalid/i.test(l));
    reason
      ? ok(`rejected with: "${reason.trim()}"`)
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
  const printerInstalled = installed.includes(config.label_printer_name);
  printerInstalled
    ? ok(`"${config.label_printer_name}" is installed → auto mode will print directly`)
    : bad(`configured printer "${config.label_printer_name}" not found`, `installed: ${installed.join(', ')}`);

  // 6) Driver geometry. The bitmap is drawn from the printable-area origin, so
  //    a printable area narrower than the media means the printer physically
  //    cannot reach the label's edges and GDI will shave them off. Also confirm
  //    the driver advertises the configured dpi, since the whole 1:1 dot
  //    mapping rests on device resolution == render resolution.
  console.log('\n[6] driver geometry vs configured media');
  if (!printerInstalled) {
    console.log('  SKIP  printer not installed');
  } else {
    const geo = probePrinterGeometry(config.label_printer_name);
    if (!geo) {
      bad('could not read the driver page geometry');
    } else {
      const HI_PER_MM = 100 / 25.4;
      const needW = config.label_width_mm * HI_PER_MM;
      const needH = config.label_height_mm * HI_PER_MM;
      console.log(`  printable ${(geo.printableW / HI_PER_MM).toFixed(1)} x ${(geo.printableH / HI_PER_MM).toFixed(1)} mm ` +
        `at ${geo.dpiX}x${geo.dpiY} dpi (default stock "${geo.paperName}")`);
      (geo.printableW >= needW - 3 && geo.printableH >= needH - 3)
        ? ok(`printable area covers the ${config.label_width_mm}x${config.label_height_mm}mm media`)
        : bad('printable area covers the configured media',
          `${(geo.printableW / HI_PER_MM).toFixed(1)}x${(geo.printableH / HI_PER_MM).toFixed(1)}mm — label edges will be clipped`);
      geo.resolutions.includes(config.label_dpi)
        ? ok(`driver advertises ${config.label_dpi} dpi → job pins to the native dot grid`)
        : bad(`driver advertises label_dpi (${config.label_dpi})`, `available: ${geo.resolutions.join(', ') || 'none'}`);
    }
  }

  console.log('\nDone. (No physical print was sent — run a real Print label click to confirm output.)');
})().catch((e) => { console.error('VERIFY ERROR:', e); process.exit(1); });
