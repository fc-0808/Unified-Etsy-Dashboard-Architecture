'use strict';
// Read-only inspection of receipts that already have a 4PX order, so we can
// safely exercise the bulk-labels.zip endpoint without creating shipments.
const Database = require('better-sqlite3');
const db = new Database('./data/etsy_dashboard.db', { readonly: true });

const rows = db.prepare(`
  SELECT receipt_id, name AS buyer_name, fourpx_tracking_no, fourpx_consignment_no,
         (fourpx_label_url IS NOT NULL AND fourpx_label_url <> '') AS has_cached_label
  FROM receipts
  WHERE (fourpx_tracking_no IS NOT NULL AND fourpx_tracking_no <> '')
     OR (fourpx_consignment_no IS NOT NULL AND fourpx_consignment_no <> '')
  ORDER BY receipt_id DESC
  LIMIT 20
`).all();

console.log(`Receipts with a 4PX order: ${rows.length} (showing up to 20)`);
for (const r of rows) {
  console.log(
    `  #${r.receipt_id} | buyer="${r.buyer_name}" | track=${r.fourpx_tracking_no || '-'} | consign=${r.fourpx_consignment_no || '-'} | cachedLabel=${r.has_cached_label ? 'yes' : 'no'}`
  );
}

// Surface any buyer-name data-quality issues that would produce bad filenames.
const emptyNames = rows.filter(r => !String(r.buyer_name || '').trim());
const dupNames = Object.entries(
  rows.reduce((m, r) => { const k = String(r.buyer_name || '').trim().toLowerCase(); m[k] = (m[k] || 0) + 1; return m; }, {})
).filter(([, n]) => n > 1);
console.log(`\nEmpty buyer names: ${emptyNames.length}`);
console.log(`Duplicate buyer names (would need numeric suffix): ${dupNames.map(([k, n]) => `"${k}"×${n}`).join(', ') || 'none'}`);

console.log('\nIDs CSV for live test:', rows.slice(0, 5).map(r => r.receipt_id).join(','));
db.close();
