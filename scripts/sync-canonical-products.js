'use strict';

/**
 * Persist canonical physical-product IDs into supplier_catalog.xlsx.
 *
 * The database discovers aliases from product-image perceptual hashes. This
 * command writes those durable IDs back to the Product Map sheet so a later
 * full Excel re-import retains cross-shop identity.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const XLSX = require('xlsx');
const { loadConfig } = require('../src/config/schema');
const enginePaths = require('../src/route/engine-paths');

const normalize = (value) =>
  String(value || '')
    .replace(/\|/g, ',')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

function main() {
  const config = loadConfig();
  const workbookPath = enginePaths.supplierCatalogPath(config);
  if (!workbookPath || !fs.existsSync(workbookPath)) {
    throw new Error(`supplier_catalog.xlsx not found: ${workbookPath || '(unresolved)'}`);
  }

  const dbPath = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'EtsyDashboard',
    'etsy_dashboard.db',
  );
  const db = require('better-sqlite3')(dbPath, { readonly: true });
  const keyByTitle = new Map(
    db
      .prepare(
        'SELECT title_norm, canonical_product_key FROM product_map WHERE canonical_product_key IS NOT NULL',
      )
      .all()
      .map((row) => [row.title_norm, row.canonical_product_key]),
  );

  const workbook = XLSX.readFile(workbookPath, {
    cellDates: false,
    cellNF: true,
    cellStyles: true,
  });
  const sheet = workbook.Sheets['Product Map'];
  if (!sheet) throw new Error('Product Map sheet not found');
  const data = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
    raw: false,
  });
  if (!data.length) throw new Error('Product Map sheet is empty');

  const headers = data[0].map((value) => String(value || '').trim());
  const titleCol = headers.findIndex((header) =>
    ['product title', 'title'].includes(header.toLowerCase()),
  );
  if (titleCol < 0) throw new Error('Product Title column not found');
  let canonicalCol = headers.findIndex((header) =>
    ['canonical product id', 'canonical product key', 'product id'].includes(
      header.toLowerCase(),
    ),
  );
  if (canonicalCol < 0) {
    canonicalCol = headers.length;
    data[0][canonicalCol] = 'Canonical Product ID';
  }

  let written = 0;
  for (let index = 1; index < data.length; index++) {
    const key = keyByTitle.get(normalize(data[index][titleCol])) || '';
    data[index][canonicalCol] = key;
    if (key) written++;
  }

  const backupPath = workbookPath.replace(
    /\.xlsx$/i,
    `.before-canonical-${new Date().toISOString().slice(0, 10)}.xlsx`,
  );
  if (!fs.existsSync(backupPath)) fs.copyFileSync(workbookPath, backupPath);

  const replacement = XLSX.utils.aoa_to_sheet(data);
  replacement['!cols'] = (sheet['!cols'] || []).slice();
  replacement['!cols'][canonicalCol] = { wch: 20 };
  workbook.Sheets['Product Map'] = replacement;
  XLSX.writeFile(workbook, workbookPath);

  console.log(`Workbook: ${workbookPath}`);
  console.log(`Backup: ${backupPath}`);
  console.log(`Canonical IDs written: ${written}/${Math.max(0, data.length - 1)}`);
}

try {
  main();
} catch (error) {
  console.error(`[canonical-products] ${error.message}`);
  process.exitCode = 1;
}
