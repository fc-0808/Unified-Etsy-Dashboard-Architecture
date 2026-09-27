'use strict';

/**
 * Pacing helpers for bulk ships and inventory sweeps.
 *
 * Bulk completion accepts any number of orders and processes them in chunks,
 * pausing between each ship and between chunks. The chunk size is not a cap.
 */

const MIN_SYNC_INTERVAL_MINUTES = 15;
const MIN_INV_WATCH_INTERVAL_MINUTES = 60;
const BULK_SHIP_CHUNK_SIZE = 50;
const BULK_SHIP_INTER_REQUEST_MS = 2000;
const BULK_SHIP_INTER_BATCH_MS = 15000;
const BULK_SHIP_ABSOLUTE_MAX = 1000;
const MAX_BULK_SHIP_PER_BATCH = BULK_SHIP_CHUNK_SIZE;
const MAX_SHIPS_PER_SHOP_PER_HOUR = 40;
const MAX_INV_WATCH_CHECKS_PER_CYCLE = 20;
const INV_WATCH_STARTUP_DELAY_MS = 10 * 60 * 1000;

/** Split an array into consecutive chunks of at most `size`. */
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Promise-based sleep. */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms | 0)));
}

// ── Runtime ship-rate guard (per shop, in-memory) ───────────────────────────
/** @type {Map<string, number[]>} shop_id → array of ship timestamps (ms) */
const _shipTimestamps = new Map();

/** Record a ship timestamp for a shop (rolling 1h window, self-trimming). */
function recordShip(shopId) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const history = (_shipTimestamps.get(shopId) || []).filter((t) => now - t < windowMs);
  history.push(now);
  _shipTimestamps.set(shopId, history);
}

/** How many ships a shop has recorded in the last hour. */
function shipsInLastHour(shopId) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  return (_shipTimestamps.get(shopId) || []).filter((t) => now - t < windowMs).length;
}

/**
 * Gate an ad-hoc single ship. Throws when a shop exceeds the hourly cap.
 *
 * The paced bulk-complete flow does not use this throw path. It records the
 * ship and keeps its own chunking and pauses.
 *
 * @param {string} shopId
 * @param {{ paced?: boolean }} [opts]  paced=true → record only, never throw
 */
function assertShipRateOk(shopId, opts = {}) {
  if (opts.paced) { recordShip(shopId); return; }
  if (shipsInLastHour(shopId) >= MAX_SHIPS_PER_SHOP_PER_HOUR) {
    const err = new Error(
      `Ship rate limit: ${shopId} has already completed ${shipsInLastHour(shopId)} order(s) in the last hour ` +
      `(max ${MAX_SHIPS_PER_SHOP_PER_HOUR}). Use the bulk "Complete orders" flow, which paces automatically, ` +
      'or wait a few minutes.'
    );
    err.status = 429;
    err.code = 'SHIP_RATE_LIMIT';
    throw err;
  }
  recordShip(shopId);
}

module.exports = {
  MIN_SYNC_INTERVAL_MINUTES,
  MIN_INV_WATCH_INTERVAL_MINUTES,
  BULK_SHIP_CHUNK_SIZE,
  BULK_SHIP_INTER_REQUEST_MS,
  BULK_SHIP_INTER_BATCH_MS,
  BULK_SHIP_ABSOLUTE_MAX,
  MAX_BULK_SHIP_PER_BATCH,
  MAX_SHIPS_PER_SHOP_PER_HOUR,
  MAX_INV_WATCH_CHECKS_PER_CYCLE,
  INV_WATCH_STARTUP_DELAY_MS,
  chunk,
  sleep,
  assertShipRateOk,
  recordShip,
  shipsInLastHour,
};
