'use strict';

/**
 * Build buyer-facing Hangze custom-case lookbooks.
 * Prints Apple / Samsung PDFs (Etsy message attachments) and 2000px listing
 * guide PNGs. Layout under assets/buyer-lookbooks:
 *   pdfs/            attach to Etsy messages
 *   listing-photos/  listing images
 *   replies/         Etsy reply templates
 *   page-previews/   rasterized PDF pages
 *   print/           HTML/CSS/fonts/icons/samples Chrome prints from
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ExcelJS = require('exceljs');
const sharp = require('sharp');
const { PDFiumLibrary } = require('@hyzyla/pdfium');
const {
  allAppleStyles,
  RAW_SHOTS,
  FACTORY_SHOTS,
  renderAppleHtml,
  renderSamsungHtml,
  renderListingAppleHtml,
  renderListingSamsungHtml,
  renderListingModelsHtml,
} = require('./hangze-buyer-catalog');

const ROOT = path.resolve(__dirname, '..', 'assets', 'buyer-lookbooks');
const PRINT_DIR = path.join(ROOT, 'print');
const PDF_DIR = path.join(ROOT, 'pdfs');
const LISTING_DIR = path.join(ROOT, 'listing-photos');
const PAGES_DIR = path.join(ROOT, 'page-previews');
const REPLIES_DIR = path.join(ROOT, 'replies');
const XLSX_PATH = path.resolve(__dirname, '..', 'Copy of 杭泽科技常规可定制材质分类与报价26年(1).xlsx');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const USER_DATA = path.join(os.tmpdir(), 'y2kase-lookbook-chrome');

function ensureDirs() {
  for (const dir of [PRINT_DIR, PDF_DIR, LISTING_DIR, PAGES_DIR, REPLIES_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function fileUrl(filePath) {
  const abs = path.resolve(filePath).replace(/\\/g, '/');
  return encodeURI(`file:///${abs}`);
}

function runChrome(args) {
  if (!fs.existsSync(CHROME)) {
    throw new Error(`Chrome not found at ${CHROME}`);
  }
  fs.mkdirSync(USER_DATA, { recursive: true });
  const result = spawnSync(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--disk-cache-size=1',
    `--user-data-dir=${USER_DATA}`,
    '--virtual-time-budget=30000',
    ...args,
  ], {
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Chrome failed (${result.status}): ${result.stderr || result.stdout || 'no output'}`);
  }
  return result;
}

function replaceFile(fromPath, toPath) {
  for (let i = 0; i < 6; i++) {
    try {
      if (fs.existsSync(toPath)) fs.unlinkSync(toPath);
      fs.renameSync(fromPath, toPath);
      return toPath;
    } catch (err) {
      if (err && err.code === 'EBUSY' && i < 5) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
        continue;
      }
      if (err && err.code === 'EBUSY') {
        const fallback = toPath.replace(/(\.[^.]+)$/, '-updated$1');
        if (fs.existsSync(fallback)) {
          try { fs.unlinkSync(fallback); } catch (_) { /* ignore */ }
        }
        fs.renameSync(fromPath, fallback);
        return fallback;
      }
      throw err;
    }
  }
  return toPath;
}

function printPdf(htmlName, pdfName) {
  const html = path.join(PRINT_DIR, htmlName);
  const pdf = path.join(PDF_DIR, pdfName);
  const tmp = pdf.replace(/\.pdf$/i, '.tmp.pdf');
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  runChrome([
    '--no-pdf-header-footer',
    `--print-to-pdf=${tmp}`,
    fileUrl(html),
  ]);
  if (!fs.existsSync(tmp) || fs.statSync(tmp).size < 1000) {
    throw new Error(`PDF was not written: ${tmp}`);
  }
  const out = replaceFile(tmp, pdf);
  if (!fs.existsSync(out) || fs.statSync(out).size < 1000) {
    throw new Error(`PDF was not written: ${out}`);
  }
  return out;
}

function screenshot(htmlName, pngName) {
  const html = path.join(PRINT_DIR, htmlName);
  const png = path.join(LISTING_DIR, pngName);
  if (fs.existsSync(png)) fs.unlinkSync(png);
  runChrome([
    '--window-size=2000,2000',
    '--force-device-scale-factor=1',
    `--screenshot=${png}`,
    fileUrl(html),
  ]);
  if (!fs.existsSync(png) || fs.statSync(png).size < 1000) {
    throw new Error(`Screenshot was not written: ${png}`);
  }
  return png;
}

async function rasterizePdf(pdfPath, prefix) {
  fs.mkdirSync(PAGES_DIR, { recursive: true });
  for (const name of fs.readdirSync(PAGES_DIR)) {
    if (name.startsWith(`${prefix}-page-`) && name.endsWith('.png')) {
      fs.unlinkSync(path.join(PAGES_DIR, name));
    }
  }
  const lib = await PDFiumLibrary.init();
  const doc = await lib.loadDocument(fs.readFileSync(pdfPath));
  const written = [];
  try {
    const n = typeof doc.pageCount === 'number' ? doc.pageCount
      : (doc.getPageCount ? doc.getPageCount() : 2);
    for (let i = 0; i < n; i++) {
      let page;
      try { page = doc.getPage(i); } catch (_) { break; }
      if (!page) break;
      const sz = page.getOriginalSize ? page.getOriginalSize() : { originalWidth: 595, originalHeight: 842 };
      const widthPt = sz.originalWidth || sz.width || 595;
      const scale = 220 / 72;
      const r = await page.render({ scale });
      const raw = Buffer.from(r.data.buffer || r.data);
      const out = path.join(PAGES_DIR, `${prefix}-page-${i + 1}.png`);
      await sharp(raw, { raw: { width: r.width, height: r.height, channels: 4 } })
        .png({ compressionLevel: 9 })
        .toFile(out);
      written.push(out);
    }
  } finally {
    if (doc.destroy) doc.destroy();
    else if (doc.close) doc.close();
  }
  return written;
}

function clampExtract(extract, width, height) {
  if (!extract) return null;
  const left = Math.max(0, Math.min(extract.left, width - 2));
  const top = Math.max(0, Math.min(extract.top, height - 2));
  const maxW = width - left;
  const maxH = height - top;
  return {
    left,
    top,
    width: Math.max(1, Math.min(extract.width, maxW)),
    height: Math.max(1, Math.min(extract.height, maxH)),
  };
}

async function frameBuffer(input, outPath, extract, opts) {
  const options = opts || {};
  const rotated = await sharp(input).rotate().toBuffer({ resolveWithObject: true });
  const crop = clampExtract(extract, rotated.info.width, rotated.info.height);
  let img = sharp(rotated.data);
  if (crop) img = img.extract(crop);
  const background = options.background || { r: 255, g: 245, b: 251, alpha: 1 };
  const width = options.width || 720;
  const height = options.height || 900;
  const fit = options.fit || 'contain';
  if (fit === 'inside') {
    await img
      .resize({ width, height, fit: 'inside' })
      .jpeg({ quality: 88 })
      .toFile(outPath);
    return;
  }
  await img
    .resize({
      width,
      height,
      fit,
      background,
    })
    .flatten({ background })
    .jpeg({ quality: 88 })
    .toFile(outPath);
}

async function loadExcelMedia() {
  if (!fs.existsSync(XLSX_PATH)) {
    throw new Error(`Hangze workbook not found: ${XLSX_PATH}`);
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(XLSX_PATH);
  const media = new Map();
  for (const m of wb.model.media || []) {
    if (!m) continue;
    let buf = m.buffer;
    if (!Buffer.isBuffer(buf) && m.base64) buf = Buffer.from(m.base64, 'base64');
    if (Buffer.isBuffer(buf)) media.set(Number(m.index), buf);
  }
  // Fallback: worksheet imageId → media
  const ws = wb.worksheets[0];
  for (const img of ws.getImages()) {
    if (media.has(img.imageId)) continue;
    const m = wb.model.media[img.imageId];
    if (!m) continue;
    let buf = m.buffer;
    if (!Buffer.isBuffer(buf) && m.base64) buf = Buffer.from(m.base64, 'base64');
    if (Buffer.isBuffer(buf)) media.set(img.imageId, buf);
  }
  return media;
}

async function prepareSamples() {
  const raw = path.join(PRINT_DIR, 'samples', '_raw');
  const dest = path.join(PRINT_DIR, 'samples');
  fs.mkdirSync(dest, { recursive: true });

  for (const [id, shot] of Object.entries(RAW_SHOTS)) {
    await frameBuffer(path.join(raw, shot.file), path.join(dest, `${id}.jpg`), shot.extract, shot);
  }

  const media = await loadExcelMedia();
  for (const [id, shot] of Object.entries(FACTORY_SHOTS)) {
    const buf = media.get(shot.imageId);
    if (!buf) throw new Error(`Missing Excel image ${shot.imageId} for ${id}`);
    await frameBuffer(buf, path.join(dest, `${id}.jpg`), shot.extract, shot);
  }

  const missing = allAppleStyles().filter((st) => !fs.existsSync(path.join(PRINT_DIR, st.img)));
  if (missing.length) {
    throw new Error(`Missing sample photos: ${missing.map((s) => s.id).join(', ')}`);
  }

  const dump = path.join(dest, '_xlsx');
  if (fs.existsSync(dump)) fs.rmSync(dump, { recursive: true, force: true });
}

function writeLookbookHtml() {
  fs.writeFileSync(path.join(PRINT_DIR, 'apple.html'), renderAppleHtml());
  fs.writeFileSync(path.join(PRINT_DIR, 'samsung.html'), renderSamsungHtml());
  fs.writeFileSync(path.join(PRINT_DIR, 'listing-apple.html'), renderListingAppleHtml());
  fs.writeFileSync(path.join(PRINT_DIR, 'listing-samsung.html'), renderListingSamsungHtml());
  fs.writeFileSync(path.join(PRINT_DIR, 'listing-apple-models.html'), renderListingModelsHtml('apple'));
  fs.writeFileSync(path.join(PRINT_DIR, 'listing-samsung-models.html'), renderListingModelsHtml('samsung'));
}

function assertReplies() {
  for (const name of ['etsy-reply-apple.txt', 'etsy-reply-samsung.txt']) {
    const text = fs.readFileSync(path.join(REPLIES_DIR, name), 'utf8').trim();
    if (!text) throw new Error(`${name} is empty`);
  }
}

async function main() {
  ensureDirs();
  assertReplies();
  writeLookbookHtml();
  await prepareSamples();
  if (fs.existsSync(USER_DATA)) fs.rmSync(USER_DATA, { recursive: true, force: true });
  const applePdf = printPdf('apple.html', 'Y2KASE-Apple-custom-case-lookbook.pdf');
  const samsungPdf = printPdf('samsung.html', 'Y2KASE-Samsung-custom-case-lookbook.pdf');
  const listing = [
    screenshot('listing-how-it-works.html', 'listing-how-custom-print-works.png'),
    screenshot('listing-apple.html', 'listing-apple-finishes.png'),
    screenshot('listing-samsung.html', 'listing-samsung-finishes.png'),
    screenshot('listing-apple-models.html', 'listing-apple-models.png'),
    screenshot('listing-samsung-models.html', 'listing-samsung-models.png'),
  ];
  const applePages = await rasterizePdf(applePdf, 'apple-lookbook');
  const samsungPages = await rasterizePdf(samsungPdf, 'samsung-lookbook');
  console.log(JSON.stringify({
    applePdf,
    samsungPdf,
    listing,
    applePages,
    samsungPages,
    bytes: {
      applePdf: fs.statSync(applePdf).size,
      samsungPdf: fs.statSync(samsungPdf).size,
    },
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
