'use strict';

// Live-DB regression check for Etsy double-fire / ghost-receipt suppression.
//
//   1. Runs the CURRENT engine (src/orders/dedup.js) against the real database.
//   2. Re-implements the PREVIOUS (buggy) window-gated clustering inline so we can
//      prove exactly which receipts the fix newly rescues.
//   3. Asserts the known ghosts are hidden while their real twins are kept:
//        • Andrea Landeros — provisional ghost 4105497490 created 5 DAYS before its
//          real paid twin 4111824191 (the bug that motivated this fix).
//        • Dina Rivera    — the earlier, minutes-apart ghost 4110288157.
//   4. Proves the wider pairing never hides a real order: every receipt the fix
//      newly suppresses must be a provisional ghost, and NO shipped/paid order may
//      appear in the suppressed set.
//
// Run: node scripts/verify-dedup-fix.js   (exits non-zero on any failure)

const path = require('path');
const Database = require('better-sqlite3');
const { computeDuplicateSuppression, score, isProvisional, buildClusterKey, DEDUP_WINDOW_SEC } = require('../src/orders/dedup');

const dbPath = path.join(process.env.LOCALAPPDATA, 'EtsyDashboard', 'etsy_dashboard.db');
const db = new Database(dbPath, { readonly: true });

const rows = db.prepare(`
  SELECT receipt_id, shop_id, buyer_user_id, name AS buyer_name, shipping_zip,
         first_listing_id, first_product_title, first_ship_by,
         is_paid, is_shipped, etsy_created_at
  FROM receipts
  WHERE source IS NULL OR source != 'manual'
`).all();

// ── PREVIOUS production logic: window-gated clustering (the bug) ───────────────
// Same-key receipts were chained into a cluster only while consecutive creations
// stayed within GHOST_PAIR_WINDOW_SEC; a ghost farther than that from its twin
// landed in a singleton cluster and was never evaluated.
const GHOST_PAIR_WINDOW_SEC = 6 * 3600;
function oldWindowGatedSuppression() {
	const suppressed = new Set();
	const groups = new Map();
	for (const o of rows) {
		const key = buildClusterKey(o);
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(o);
	}
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
	for (const g of groups.values()) {
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

const oldS = oldWindowGatedSuppression();
const { suppressed: newS } = computeDuplicateSuppression(rows);
const byId = new Map(rows.map((r) => [r.receipt_id, r]));

console.log(`Total non-manual receipts: ${rows.length}`);
console.log(`OLD (window-gated) suppressed: ${oldS.size}`);
console.log(`NEW (whole-group)  suppressed: ${newS.size}`);

const checks = [];
const check = (label, cond) => { checks.push(cond); console.log(`  ${cond ? '✓' : '✗'} ${label}`); };

// [1] Andrea Landeros — the 5-day-apart ghost this fix targets.
const A_GHOST = 4105497490, A_REAL = 4111824191;
console.log('\n[1] Andrea Landeros (5 days apart):');
if (byId.has(A_GHOST) && byId.has(A_REAL)) {
	check(`ghost ${A_GHOST} suppressed`, newS.has(A_GHOST));
	check(`real  ${A_REAL} kept`, !newS.has(A_REAL));
	check(`fix rescued it (old logic MISSED the ghost)`, !oldS.has(A_GHOST));
} else {
	console.log('    (receipts not present in this DB — skipped)');
}

// [2] Dina Rivera — the earlier minutes-apart ghost.
const D_GHOST = 4110288157, D_REAL = 4110290863;
console.log('\n[2] Dina Rivera (minutes apart):');
if (byId.has(D_GHOST) && byId.has(D_REAL)) {
	check(`ghost ${D_GHOST} suppressed`, newS.has(D_GHOST));
	check(`real  ${D_REAL} kept`, !newS.has(D_REAL));
} else {
	console.log('    (receipts not present in this DB — skipped)');
}

// [3] Every receipt the fix NEWLY suppresses must be a provisional ghost.
const newlySuppressed = [...newS].filter((id) => !oldS.has(id));
console.log(`\n[3] Newly suppressed by fix: ${newlySuppressed.length}`);
const realNewlyHidden = newlySuppressed.filter((id) => !isProvisional(byId.get(id)));
for (const id of realNewlyHidden) {
	const r = byId.get(id);
	console.log(`    !! REAL order newly hidden: ${id} paid=${r.is_paid} shipped=${r.is_shipped} ship_by=${r.first_ship_by}`);
}
check(`no REAL (paid/shipped) order newly hidden`, realNewlyHidden.length === 0);

// [4] Global safety net — NO shipped order may EVER be in the suppressed set.
const shippedHidden = [...newS].filter((id) => byId.get(id).is_shipped);
check(`no shipped order anywhere in suppressed set (${shippedHidden.length})`, shippedHidden.length === 0);

// [5] Any newly-suppressed PAID (non-shipped) order would be a regression — paid
//     orders only collapse within the tight window, which the old logic already did.
const paidNewly = newlySuppressed.filter((id) => byId.get(id).is_paid && !byId.get(id).is_shipped);
check(`no paid (non-shipped) order newly hidden (${paidNewly.length})`, paidNewly.length === 0);

const ok = checks.every(Boolean);
console.log(`\nRESULT: ${ok ? 'PASS ✅' : 'FAIL ❌'}`);

db.close();
process.exit(ok ? 0 : 1);
