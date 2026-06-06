'use strict';
const Database = require('better-sqlite3');
const db = new Database('./data/etsy_dashboard.db', { readonly: true });

const ids = process.argv.slice(2).length ? process.argv.slice(2) : ['4078118579', '4077716779'];
for (const id of ids) {
  const r = db.prepare('SELECT receipt_id, name, all_transactions FROM receipts WHERE receipt_id = ?').get(id);
  if (!r) { console.log(`#${id}: not found`); continue; }
  let txs = [];
  try { txs = JSON.parse(r.all_transactions || '[]'); } catch {}
  console.log(`\n#${r.receipt_id} — ${r.name} — ${txs.length} transaction(s)`);
  txs.forEach((t, i) => {
    const vars = (t.variations || []).map(v =>
      `${(v.formatted_name || v.property_name || '').trim()}=${(v.formatted_value || v.value || '').trim()}`
    ).join(' | ');
    console.log(`  [${i}] qty=${t.quantity} | ${String(t.title || '').slice(0, 60)}`);
    console.log(`       vars: ${vars || '(none)'}`);
  });
}
db.close();
