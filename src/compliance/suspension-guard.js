'use strict';

/**
 * Etsy suspension-risk compliance guard.
 *
 * Etsy shop suspensions are rarely caused by a single API bug — they are usually
 * the result of policy signals (false shipping, overselling, linked accounts) or
 * technical abuse patterns (rate-limit storms, >5 shops per app key, bot-like
 * inventory writes). This module centralises those checks so every startup,
 * config reload, and admin health probe surfaces the same honest risk picture.
 */

const ETSY_SHOPS_PER_KEY = 5;
const MIN_SYNC_INTERVAL_MINUTES = 15;
const MIN_INV_WATCH_INTERVAL_MINUTES = 60;
// Anti-abuse is achieved by PACING (spreading writes over time), never by
// rejecting legitimate work — a blocked completion just makes real orders ship
// late, which is a WORSE Etsy signal than a paced burst. So the bulk-complete
// endpoint accepts any number of orders and processes them in chunks of this
// size, pausing between each ship and (longer) between chunks. This is a CHUNK
// SIZE, not a hard cap.
const BULK_SHIP_CHUNK_SIZE = 50;
const BULK_SHIP_INTER_REQUEST_MS = 2000;   // pause between individual ships
const BULK_SHIP_INTER_BATCH_MS = 15000;    // cooldown between chunks
// Sanity ceiling to reject obviously malformed payloads only (a single operator
// batch is realistically ≤ a few hundred). Not a compliance limit.
const BULK_SHIP_ABSOLUTE_MAX = 1000;
// Back-compat alias (older imports referenced MAX_BULK_SHIP_PER_BATCH).
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

/** Mirrors schema.js usesGroupProxy — inlined to avoid circular import with loadConfig(). */
const DIRECT_PROXY_MARKERS = new Set(['', 'direct', 'none', 'false']);
function usesGroupProxy(group) {
  const p = group?.proxy;
  if (p === null || p === false) return false;
  if (typeof p === 'string') return !DIRECT_PROXY_MARKERS.has(p.trim().toLowerCase());
  return true;
}

/** @typedef {'critical'|'high'|'medium'|'low'|'info'} RiskLevel */
/** @typedef {{ level: RiskLevel, code: string, title: string, detail: string, remediation: string }} SuspensionRisk */

/**
 * Analyse config for suspension-risk signals.
 * @param {import('../config/schema').AppConfig} config
 * @returns {SuspensionRisk[]}
 */
function analyzeSuspensionRisks(config) {
  const risks = [];
  const allShops = config.groups.flatMap((g) =>
    (g.shops || []).map((s) => ({ ...s, group_id: g.group_id, group_label: g.label, proxy: g.proxy }))
  );

  // ── 1. Etsy Personal Access: 5 shops per API key (HARD Etsy limit) ─────────
  const shopsPerKey = new Map();
  for (const shop of allShops) {
    if (!shop.api_key) continue;
    if (!shopsPerKey.has(shop.api_key)) shopsPerKey.set(shop.api_key, []);
    shopsPerKey.get(shop.api_key).push(shop.shop_name || shop.shop_id);
  }
  for (const [key, names] of shopsPerKey) {
    if (names.length > ETSY_SHOPS_PER_KEY) {
      const masked = `${String(key).slice(0, 6)}…`;
      risks.push({
        level: 'critical',
        code: 'API_KEY_SHOP_OVERFLOW',
        title: `API key ${masked} is mapped to ${names.length} shops (Etsy limit: ${ETSY_SHOPS_PER_KEY})`,
        detail: `Shops on this key: ${names.join(', ')}. Exceeding the Personal Access limit is an explicit Etsy anti-abuse trigger and can cause OAuth revocation or shop review across ALL shops on the key.`,
        remediation: `Move the extra shop(s) to a separate Etsy developer app (new api_key + shared_secret) and re-run oauth:setup for each moved shop from its own AdsPower profile + static IP.`,
      });
    }
  }

  // ── 2. Many shops sharing one egress IP (association / linked-account risk) ──
  for (const group of config.groups) {
    const shopCount = (group.shops || []).length;
    if (shopCount <= 1) continue;

    if (!usesGroupProxy(group)) {
      risks.push({
        level: 'high',
        code: 'DIRECT_MULTI_SHOP_GROUP',
        title: `Group "${group.label}" has ${shopCount} shops on a direct (no-proxy) connection`,
        detail: 'All shops in this group share the server\'s public IP. Etsy correlates accounts by IP and browser fingerprint; multiple shops from one IP is a primary linked-account signal.',
        remediation: 'Assign each shop group its own static residential IP (IPFoxy) via AdsPower, or at minimum separate groups per identity document.',
      });
    } else if (shopCount > ETSY_SHOPS_PER_KEY) {
      risks.push({
        level: 'medium',
        code: 'PROXY_GROUP_MANY_SHOPS',
        title: `Group "${group.label}" routes ${shopCount} shops through one proxy`,
        detail: 'Even with a residential proxy, routing more than 5 shops through one IP increases Etsy\'s linked-account confidence score. This is not an API violation but is an OpSec risk.',
        remediation: 'Split shops across multiple proxy endpoints (one per identity group of ≤5 shops).',
      });
    }
  }

  // ── 3. Aggressive sync / inventory polling ─────────────────────────────────
  const syncMin = config.sync_interval_minutes ?? 60;
  if (syncMin < MIN_SYNC_INTERVAL_MINUTES) {
    risks.push({
      level: 'medium',
      code: 'SYNC_INTERVAL_TOO_LOW',
      title: `sync_interval_minutes is ${syncMin} (minimum safe: ${MIN_SYNC_INTERVAL_MINUTES})`,
      detail: `At ${syncMin}m intervals with 5 shops/key, background sync alone can exceed 3,600 API calls/day — tripping QPD limits and presenting as bot traffic.`,
      remediation: `Raise sync_interval_minutes to at least ${MIN_SYNC_INTERVAL_MINUTES} (recommended: 60).`,
    });
  }

  const invMin = config.inv_watch_interval_minutes ?? 240;
  if (invMin < MIN_INV_WATCH_INTERVAL_MINUTES) {
    risks.push({
      level: 'medium',
      code: 'INV_WATCH_INTERVAL_TOO_LOW',
      title: `inv_watch_interval_minutes is ${invMin} (minimum safe: ${MIN_INV_WATCH_INTERVAL_MINUTES})`,
      detail: 'Frequent inventory sweeps generate bursts of GET+PUT calls across all zero-stock listings — a classic bot fingerprint.',
      remediation: `Raise inv_watch_interval_minutes to at least ${MIN_INV_WATCH_INTERVAL_MINUTES} (recommended: 240).`,
    });
  }

  // ── 4. Auto-restock without physical stock (overselling → ODR → suspension) ─
  if (config.auto_restock_enabled !== false) {
    risks.push({
      level: 'high',
      code: 'AUTO_RESTOCK_ENABLED',
      title: 'Auto-restock is ON — listings show stock even when you have zero physical units',
      detail: 'When a variation hits qty 0 on Etsy, the sync worker automatically PUTs it back to restock_quantity (default 3). Buyers can purchase items you cannot fulfil → cases, bad reviews, and ODR penalties are the #1 organic suspension cause for high-volume shops.',
      remediation: 'Set auto_restock_enabled: false in config.json unless you maintain real-time physical inventory. Use ZERO_STOCK alerts instead.',
    });
  }

  // ── 5. Pre-transit workflow (policy, not API) ──────────────────────────────
  risks.push({
    level: 'info',
    code: 'PRE_TRANSIT_WORKFLOW',
    title: 'Pre-transit shipping workflow is active',
    detail: 'This dashboard supports marking orders shipped on Etsy before the carrier physically scans the parcel (to meet ship-by deadlines). Etsy policy requires truthful shipping status; buyer complaints about "shipped but not moving" directly raise case rates.',
    remediation: 'Only mark shipped after creating a real 4PX label. Monitor pre-transit orders and prioritise purchasing/packing. Consider reducing pre_transit_days to keep the queue tight.',
  });

  return risks;
}

/**
 * Throw on critical config violations unless the operator explicitly opts out.
 * Called from loadConfig() so bad config never reaches a running server.
 *
 * @param {object} raw  Parsed config.json (pre-defaults)
 * @param {SuspensionRisk[]} risks
 */
function enforceConfigCompliance(raw, risks) {
  const allowOverload = raw.allow_overloaded_api_keys === true
    || process.env.ALLOW_OVERLOADED_API_KEYS === '1'
    || process.env.ALLOW_OVERLOADED_API_KEYS === 'true';

  const critical = risks.filter((r) => r.level === 'critical');
  if (critical.length && !allowOverload) {
    const lines = critical.map((r) => `  • ${r.title}\n    ${r.remediation}`).join('\n');
    throw new Error(
      `config.json violates Etsy Personal Access limits and cannot start:\n${lines}\n\n` +
      'To override (NOT recommended — risks suspension across all shops on the key), ' +
      'set allow_overloaded_api_keys: true in config.json or ALLOW_OVERLOADED_API_KEYS=1 in the environment.'
    );
  }

  if (critical.length && allowOverload) {
    console.warn(
      '[compliance] ⚠ allow_overloaded_api_keys is set — starting despite API key shop overflow. ' +
      'This is an Etsy anti-abuse trigger; migrate shops to separate app keys ASAP.'
    );
  }
}

/**
 * Format risks for console or API output.
 * @param {SuspensionRisk[]} risks
 * @returns {string}
 */
function formatRiskReport(risks) {
  const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const sorted = [...risks].sort((a, b) => order[a.level] - order[b.level]);
  const icon = { critical: '⛔', high: '🔴', medium: '🟡', low: '🔵', info: 'ℹ' };

  if (!sorted.length) return '  No suspension risks detected.\n';

  return sorted.map((r) => {
    const lines = [
      `  ${icon[r.level] || '•'} [${r.level.toUpperCase()}] ${r.title}`,
      `      ${r.detail}`,
      `      → ${r.remediation}`,
    ];
    return lines.join('\n');
  }).join('\n\n') + '\n';
}

/**
 * Summarise risk counts for API responses.
 * @param {SuspensionRisk[]} risks
 */
function summarizeRisks(risks) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const r of risks) counts[r.level] = (counts[r.level] || 0) + 1;
  const worst = risks.find((r) => r.level === 'critical')
    || risks.find((r) => r.level === 'high')
    || risks.find((r) => r.level === 'medium')
    || null;
  return {
    total: risks.length,
    counts,
    status: counts.critical ? 'critical' : counts.high ? 'elevated' : counts.medium ? 'caution' : 'ok',
    headline: worst ? worst.title : 'No elevated suspension risks detected',
    risks,
  };
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
 * Gate an AD-HOC single ship. Throws when a shop exceeds the hourly cap, to stop
 * accidental fat-finger bursts from the single-order UI.
 *
 * NOTE: this is deliberately NOT used by the paced bulk-complete flow — that flow
 * owns its own pacing (chunking + inter-request/-chunk sleeps), which is the real
 * anti-abuse mechanism. Rejecting a deliberate, paced bulk completion would only
 * make legitimate orders ship late (a worse Etsy signal). The bulk path calls
 * recordShip() for accounting instead.
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

/**
 * Log a compliance warning when marking shipped without carrier confirmation.
 * @param {object} receiptRow  DB row with carrier_confirmed_at, tracking_code, etc.
 * @param {string} shopId
 */
function warnPreTransitShip(receiptRow, shopId) {
  if (receiptRow?.carrier_confirmed_at) return;
  console.warn(
    `[compliance] Pre-transit ship: ${shopId} receipt — tracking "${receiptRow?.tracking_code || '?'}" ` +
    'marked shipped on Etsy before carrier first-scan. High case-rate shops are Etsy\'s primary suspension trigger. ' +
    'Ensure the 4PX label is real and the parcel ships within 48h.'
  );
}

module.exports = {
  ETSY_SHOPS_PER_KEY,
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
  analyzeSuspensionRisks,
  enforceConfigCompliance,
  formatRiskReport,
  summarizeRisks,
  assertShipRateOk,
  recordShip,
  shipsInLastHour,
  warnPreTransitShip,
};
