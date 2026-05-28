'use strict';
// Diagnose: revenue parsing and sync_log egress_ip gaps
const { initDb } = require('../src/db/setup');
const { loadConfig } = require('../src/config/schema');
const c = loadConfig();
const db = initDb(c.db_path);

// 1. Check raw grandtotal in stored JSON for first receipt
const sample = db.prepare('SELECT receipt_id, grandtotal_amount, raw_json FROM receipts LIMIT 1').get();
if (sample) {
  const raw = JSON.parse(sample.raw_json);
  console.log('=== RECEIPT RAW FIELDS (first row) ===');
  console.log('receipt_id:', sample.receipt_id);
  console.log('grandtotal_amount in DB:', sample.grandtotal_amount);
  console.log('raw grandtotal field:', JSON.stringify(raw.grandtotal));
  console.log('raw grand_total field:', JSON.stringify(raw.grand_total));
  console.log('raw total_price field:', JSON.stringify(raw.total_price));
  // print all top-level keys
  console.log('all top-level keys:', Object.keys(raw).join(', '));
  console.log('');
}

// 2. Show all sync_log rows ordered by id
console.log('=== FULL SYNC LOG ===');
const log = db.prepare('SELECT id, shop_id, status, egress_ip, receipts_synced, started_at FROM sync_log ORDER BY id').all();
log.forEach((r) =>
  console.log(
    `id=${String(r.id).padStart(3)}`,
    r.shop_id.padEnd(28),
    r.status.padEnd(8),
    String(r.receipts_synced).padStart(4), 'rcpts',
    'IP:', (r.egress_ip || 'null').padEnd(16),
    new Date(r.started_at * 1000).toISOString()
  )
);
