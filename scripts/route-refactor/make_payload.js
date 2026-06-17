'use strict';
// Build a deterministic --import-json payload from the live dashboard data,
// EXACTLY as POST /api/route/generate does, so we can pin golden Excel output
// and verify any refactor of the generator produces identical files.
const fs = require('fs');
const path = require('path');
const D = require('better-sqlite3');
const routeDashboard = require('../../src/route/dashboard');
let getCharmPurchaseProgress;
try { ({ getCharmPurchaseProgress } = require('../../src/db/setup')); } catch {}

const config = { pre_transit_days: 30 };
const db = new D(path.join(__dirname, '../../data/etsy_dashboard.db'), { readonly: false });

const rows = routeDashboard.buildRouteRows(db, config, { include_shipped: false, enrich_supplier: true });
try { if (getCharmPurchaseProgress) routeDashboard.reconcileCharmStatusesFromProgress(db, rows, getCharmPurchaseProgress(db)); } catch {}
const shoppingRows = rows.filter(r => !r.excluded && !routeDashboard.rowFullyPurchased(r));
const exported = routeDashboard.rowsToImportOrders(shoppingRows);
for (const o of exported) for (const it of o.items) { delete it._listing_id; delete it._manual_id; }

const outDir = path.join(__dirname);
const payloadPath = path.join(outDir, 'golden_payload.json');
fs.writeFileSync(payloadPath, JSON.stringify({ orders: exported, exported_at: '2026-01-01T00:00:00.000Z' }, null, 2));
console.log('wrote', payloadPath);
console.log('orders:', exported.length, 'items:', exported.reduce((s, o) => s + o.items.length, 0));
