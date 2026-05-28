'use strict';
const { initDb } = require('../src/db/setup');
const { loadConfig } = require('../src/config/schema');

const c = loadConfig();
const db = initDb(c.db_path);

const receipts = db.prepare('SELECT COUNT(*) AS n FROM receipts').get();
console.log('=== DATABASE STATE ===');
console.log('Total receipts:', receipts.n);
console.log('');

const shops = db.prepare(
  'SELECT shop_id, COUNT(*) AS n, SUM(grandtotal_amount) AS rev FROM receipts GROUP BY shop_id ORDER BY n DESC'
).all();
console.log('Per shop:');
shops.forEach((s) =>
  console.log(
    ' ', s.shop_id.padEnd(30),
    String(s.n).padStart(4), 'receipts',
    '  revenue:', s.rev ? s.rev.toFixed(2) : '0.00'
  )
);
console.log('');

const log = db.prepare(`
  SELECT sl.shop_id, sl.status, sl.egress_ip, sl.receipts_synced,
         sl.started_at, sl.completed_at
  FROM sync_log sl
  WHERE sl.id IN (SELECT MAX(id) FROM sync_log GROUP BY shop_id)
  ORDER BY sl.started_at DESC
`).all();
console.log('Last sync per shop (with egress IP):');
log.forEach((r) => {
  const dur = r.completed_at ? (r.completed_at - r.started_at) + 's' : '—';
  console.log(
    ' ', r.shop_id.padEnd(30),
    r.status.padEnd(8),
    String(r.receipts_synced).padStart(4), 'receipts',
    ' IP:', (r.egress_ip || 'null').padEnd(16),
    dur
  );
});
console.log('');

const groups = db.prepare(
  'SELECT group_id, COUNT(DISTINCT shop_id) AS shops, COUNT(*) AS receipts FROM receipts GROUP BY group_id'
).all();
console.log('Per group:');
groups.forEach((g) =>
  console.log(' ', g.group_id.padEnd(25), g.shops, 'shops,', g.receipts, 'receipts')
);
