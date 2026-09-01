'use strict';

/**
 * Single source of truth for whether an order may be physically sealed.
 * Shared by the dedicated mark-packaged endpoints and the 4PX create flow.
 */
const buyQueue = require('./buy-queue');
const packQueue = require('./pack-queue');

/**
 * @param {import('better-sqlite3').Database} db
 * @param {Array<number|string>} receiptIds
 * @param {object} [config]
 * @returns {Map<number,string>} receipt_id → blocking reason
 */
function unsealableReasons(db, receiptIds, config = {}) {
  const reasons = new Map();
  const ids = (receiptIds || []).map(Number).filter(Number.isFinite);
  if (!ids.length) return reasons;

  const placeholders = ids.map(() => '?').join(',');
  let rows;
  try {
    rows = db.prepare(
      `SELECT receipt_id, all_transactions FROM receipts WHERE receipt_id IN (${placeholders})`
    ).all(...ids);
  } catch {
    for (const id of ids) reasons.set(id, 'could not be verified because order data is unavailable');
    return reasons;
  }

  const { ready, verified } = buyQueue.classifyPurchaseState(db, rows);
  const requireVerification = packQueue.requireVerifyBeforePack(config);
  const missingLineItems = new Set();
  for (const row of rows) {
    let transactions = null;
    try { transactions = JSON.parse(row.all_transactions || 'null'); } catch {}
    if (!Array.isArray(transactions) || transactions.length === 0) {
      missingLineItems.add(Number(row.receipt_id));
    }
  }
  const openIssue = new Set();
  const openSwap = new Set();
  try {
    db.prepare(
      `SELECT DISTINCT receipt_id
       FROM order_issues
       WHERE status = 'open' AND receipt_id IN (${placeholders})`
    ).all(...ids).forEach((row) => openIssue.add(Number(row.receipt_id)));
  } catch {
    // Additive table may not exist on a partially initialized fixture.
  }
  try {
    db.prepare(
      `SELECT DISTINCT r.receipt_id
       FROM receipts r
       WHERE r.receipt_id IN (${placeholders})
         AND ${packQueue.openExchangeExistsSql('r')}`
    ).all(...ids).forEach((row) => openSwap.add(Number(row.receipt_id)));
  } catch {
    // Additive table may not exist on a partially initialized fixture.
  }

  for (const id of ids) {
    if (missingLineItems.has(id)) {
      reasons.set(id, 'has no complete line-item data to verify');
    } else if (openIssue.has(id)) {
      reasons.set(id, 'is on hold (a product is out of production or the model is unavailable)');
    } else if (openSwap.has(id)) {
      reasons.set(id, 'is awaiting a wrong-model supplier swap');
    } else if (!ready.has(id)) {
      reasons.set(id, 'still has products that are not yet purchased / in hand');
    } else if (requireVerification && !verified.has(id)) {
      reasons.set(id, 'has not been physically verified by the packer');
    }
  }
  return reasons;
}

module.exports = { unsealableReasons };
