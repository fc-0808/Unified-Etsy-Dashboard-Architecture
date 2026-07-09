'use strict';

// Verifies the duplicate-order suppression fix against the LIVE database.
//   1. Re-implements BOTH the old and the new suppression logic.
//   2. Confirms the Dina Rivera ghost is now suppressed while the real order is kept.
//   3. Proves the wider ghost window never hides a real (paid/shipped) order:
//      every newly-suppressed receipt must be a provisional ghost.

const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.join(process.env.LOCALAPPDATA, 'EtsyDashboard', 'etsy_dashboard.db');
const db = new Database(dbPath, { readonly: true });

const DEDUP_WINDOW_SEC = 300;
const GHOST_PAIR_WINDOW_SEC = 6 * 3600;

const rows = db.prepare(`
  SELECT receipt_id, shop_id, buyer_user_id, name AS buyer_name, shipping_zip,
         first_listing_id, first_product_title, first_ship_by,
         is_paid, is_shipped, etsy_created_at
  FROM receipts
  WHERE source IS NULL OR source != 'manual'
`).all();

function group(rows) {
  const groups = new Map();
  for (const o of rows) {
    const buyerKey = o.buyer_user_id
      ? `uid:${o.buyer_user_id}`
      : `name:${(o.buyer_name || '').trim().toLowerCase()}|zip:${(o.shipping_zip || '').trim()}`;
    const productKey = o.first_listing_id
      ? `lid:${o.first_listing_id}`
      : `title:${(o.first_product_title || '').trim().toLowerCase().slice(0, 60)}`;
    const key = `${o.shop_id}|${buyerKey}|${productKey}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }
  return groups;
}

const score = (r) => (r.is_shipped ? 8 : 0) + (r.is_paid ? 4 : 0) + (r.first_ship_by ? 2 : 0);
const isProvisional = (r) => !r.is_paid && !r.is_shipped && !r.first_ship_by;

// ── OLD logic ────────────────────────────────────────────────────────────────
function oldSuppression() {
  const suppressed = new Set();
  const collapse = (cluster) => {
    if (cluster.length < 2) return;
    let primary = cluster[0];
    for (const c of cluster) {
      if (score(c) > score(primary) || (score(c) === score(primary) && c.receipt_id > primary.receipt_id)) primary = c;
    }
    for (const c of cluster) if (c.receipt_id !== primary.receipt_id) suppressed.add(c.receipt_id);
  };
  for (const g of group(rows).values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => (a.etsy_created_at || 0) - (b.etsy_created_at || 0));
    let cluster = [g[0]];
    for (let i = 1; i < g.length; i++) {
      const gap = (g[i].etsy_created_at || 0) - (g[i - 1].etsy_created_at || 0);
      if (gap <= DEDUP_WINDOW_SEC) cluster.push(g[i]);
      else { collapse(cluster); cluster = [g[i]]; }
    }
    collapse(cluster);
  }
  return suppressed;
}

// ── NEW logic ────────────────────────────────────────────────────────────────
function newSuppression() {
  const suppressed = new Set();
  const collapse = (cluster) => {
    if (cluster.length < 2) return;
    let primary = cluster[0];
    for (const c of cluster) {
      if (score(c) > score(primary) || (score(c) === score(primary) && c.receipt_id > primary.receipt_id)) primary = c;
    }
    for (const c of cluster) {
      if (c.receipt_id === primary.receipt_id) continue;
      const gap = Math.abs((c.etsy_created_at || 0) - (primary.etsy_created_at || 0));
      if (isProvisional(c) || gap <= DEDUP_WINDOW_SEC) suppressed.add(c.receipt_id);
    }
  };
  for (const g of group(rows).values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => (a.etsy_created_at || 0) - (b.etsy_created_at || 0));
    let cluster = [g[0]];
    for (let i = 1; i < g.length; i++) {
      const gap = (g[i].etsy_created_at || 0) - (g[i - 1].etsy_created_at || 0);
      if (gap <= GHOST_PAIR_WINDOW_SEC) cluster.push(g[i]);
      else { collapse(cluster); cluster = [g[i]]; }
    }
    collapse(cluster);
  }
  return suppressed;
}

const oldS = oldSuppression();
const newS = newSuppression();
const byId = new Map(rows.map((r) => [r.receipt_id, r]));

console.log(`Total non-manual receipts: ${rows.length}`);
console.log(`OLD suppressed: ${oldS.size}`);
console.log(`NEW suppressed: ${newS.size}`);

// 1) Dina Rivera assertion
const GHOST = 4110288157, REAL = 4110290863;
console.log(`\n[1] Dina Rivera ghost ${GHOST} suppressed? ${newS.has(GHOST)} (expect true)`);
console.log(`    Dina Rivera real  ${REAL} kept?       ${!newS.has(REAL)} (expect true)`);

// 2) Newly-suppressed by the fix — every one MUST be a provisional ghost.
const newlySuppressed = [...newS].filter((id) => !oldS.has(id));
console.log(`\n[2] Newly suppressed by fix: ${newlySuppressed.length}`);
let realWronglyHidden = 0;
for (const id of newlySuppressed) {
  const r = byId.get(id);
  const prov = isProvisional(r);
  if (!prov) {
    realWronglyHidden++;
    console.log(`    !! REAL order newly hidden: ${id} paid=${r.is_paid} shipped=${r.is_shipped} ship_by=${r.first_ship_by}`);
  }
}
console.log(`    Newly-hidden that are REAL (paid/shipped) orders: ${realWronglyHidden} (expect 0)`);

// 3) Global safety net — NO suppressed receipt anywhere may be a shipped order.
let shippedHidden = 0;
for (const id of newS) if (byId.get(id).is_shipped) shippedHidden++;
console.log(`\n[3] Shipped orders in suppressed set: ${shippedHidden} (expect 0)`);

// 4) Any suppressed PAID (non-shipped) order must be within the tight window of a
//    same-cluster survivor with a strictly higher score — never a lone paid order.
console.log(`\n[4] Paid (non-shipped) receipts newly suppressed by fix:`);
const paidNewly = newlySuppressed.filter((id) => byId.get(id).is_paid && !byId.get(id).is_shipped);
console.log(`    ${paidNewly.length} (expect 0 — paid orders only collapse within the tight window, unchanged from before)`);

const ok = newS.has(GHOST) && !newS.has(REAL) && realWronglyHidden === 0 && shippedHidden === 0 && paidNewly.length === 0;
console.log(`\nRESULT: ${ok ? 'PASS ✅' : 'FAIL ❌'}`);

db.close();
process.exit(ok ? 0 : 1);
