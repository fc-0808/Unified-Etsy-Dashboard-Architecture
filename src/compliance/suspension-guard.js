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
const ETSY_API_TERMS_URL = 'https://www.etsy.com/legal/api/';

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
        detail: `Shops on this key: ${names.join(', ')}. This exceeds the access allocation recorded for this Personal Access key.`,
        remediation: `Do not create duplicate apps/keys to bypass limits. Ask developer@etsy.com to approve the intended shop/key topology for this single application, then connect only the shops Etsy authorizes. Terms: ${ETSY_API_TERMS_URL}`,
      });
    }
  }

  // Etsy's current API Terms say each application uses its designated API key
  // and prohibit additional keys/apps created to circumvent limits or duplicate
  // substantially the same service. A single dashboard configured with several
  // keys therefore needs explicit Etsy approval; network/proxy separation does
  // not change that application-level requirement.
  if (shopsPerKey.size > 1) {
    const approved = config.etsy_multi_key_approved === true;
    risks.push({
      level: approved ? 'info' : 'high',
      code: approved ? 'MULTIPLE_API_KEYS_APPROVAL_RECORDED' : 'MULTIPLE_API_KEYS_ONE_APPLICATION',
      title: approved
        ? `Written multi-key approval is recorded for ${shopsPerKey.size} Etsy API keys`
        : `This application is configured with ${shopsPerKey.size} Etsy API keys without a recorded approval`,
      detail: approved
        ? 'The local attestation records that Etsy approved this exact topology. Keep the written approval with the application compliance records.'
        : 'Etsy API Terms assign one designated key to an application and prohibit duplicate applications or extra keys used to circumvent limits. Technical routing separation is not policy approval.',
      remediation: approved
        ? `Reconfirm approval before changing keys, shop count, ownership, or application purpose. Terms: ${ETSY_API_TERMS_URL}`
        : `Confirm this exact multi-key topology in writing with developer@etsy.com. If approved, retain the response and set etsy_multi_key_approved to true. Otherwise migrate to the key/topology Etsy designates. Terms: ${ETSY_API_TERMS_URL}`,
    });
  }

  // Etsy API Terms §5(25), updated Aug 18 2026, prohibit requesting Etsy
  // content for analytics unless Etsy expressly authorizes it in writing.
  // Manual Growth avoids API requests and scraping, but §5(24)'s broad
  // automated-analysis wording is disclosed separately rather than treated as
  // permission created by this technical gate.
  if (config.catalog_health_sync === true && config.etsy_api_analytics_approved !== true) {
    risks.push({
      level: 'critical',
      code: 'API_ANALYTICS_APPROVAL_REQUIRED',
      title: 'API-based Growth analytics is enabled without a written-approval attestation',
      detail: 'catalog_health_sync would request listings, views, shop data and reviews for analytics. Etsy API Terms §5(25) require express written authorization for that purpose.',
      remediation: `Set catalog_health_sync to false and use manual Growth imports. Enable it only after Etsy grants written authorization, then set etsy_api_analytics_approved to true. Terms: ${ETSY_API_TERMS_URL}`,
    });
  }

  // ── 2. Network routing is operational, never a compliance control ───────────
  for (const group of config.groups) {
    const shopCount = (group.shops || []).length;
    if (shopCount <= 1) continue;

    if (!usesGroupProxy(group)) {
      risks.push({
        level: 'info',
        code: 'DIRECT_MULTI_SHOP_GROUP',
        title: `Group "${group.label}" has ${shopCount} shops on one direct network route`,
        detail: 'This is an operational routing choice, not evidence of policy compliance or non-compliance. All developer/shop ownership information must remain accurate and complete.',
        remediation: 'Use a stable, secure network path and disclose the real application purpose and ownership accurately to Etsy. Do not use proxies or browser profiles to conceal common control.',
      });
    } else if (shopCount > ETSY_SHOPS_PER_KEY) {
      risks.push({
        level: 'medium',
        code: 'PROXY_GROUP_MANY_SHOPS',
        title: `Group "${group.label}" routes ${shopCount} shops through one proxy`,
        detail: 'A proxy changes transport only; it does not expand an API key allocation or authorize a multi-shop/multi-key topology.',
        remediation: 'Do not split traffic to evade platform controls. Confirm the application and shop allocation with Etsy Developer Support.',
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
  if (config.auto_restock_enabled === true) {
    risks.push({
      level: 'high',
      code: 'AUTO_RESTOCK_ENABLED',
      title: 'Auto-restock is ON — every quantity increase must be backed by fulfillable stock',
      detail: 'When a variation reaches 0, the worker raises it to restock_quantity. If physical inventory is not authoritative, this can create unavailable orders, cancellations, poor reviews, and buyer cases; repeated service-standard failures can affect visibility or selling privileges.',
      remediation: 'Set auto_restock_enabled: false in config.json unless you maintain real-time physical inventory. Use ZERO_STOCK alerts instead.',
    });
  }

  // ── 5. Pre-transit workflow (policy, not API) ──────────────────────────────
  risks.push({
    level: 'info',
    code: 'PRE_TRANSIT_WORKFLOW',
    title: 'Pre-transit shipping workflow is active',
    detail: 'This dashboard can submit tracking before the carrier first scan. Shipment status and dates must accurately represent the real handoff and processing promise; long label-only periods can lead to buyer contacts or cases.',
    remediation: 'Submit shipment completion only when it accurately reflects the parcel workflow. Monitor label-only parcels, hand them to the carrier promptly, and keep processing times realistic.',
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
function enforceConfigCompliance(_raw, risks) {
  const critical = risks.filter((r) => r.level === 'critical');
  const approvalRequired = critical.filter((r) => r.code === 'API_ANALYTICS_APPROVAL_REQUIRED');
  if (approvalRequired.length) {
    const lines = approvalRequired.map((r) => `  • ${r.title}\n    ${r.remediation}`).join('\n');
    throw new Error(
      `config.json enables Etsy API analytics without recording written authorization:\n${lines}\n\n` +
      'There is no runtime override for this policy gate; use manual Growth imports or record Etsy\'s written approval.'
    );
  }

  const allocationCritical = critical.filter((r) => r.code !== 'API_ANALYTICS_APPROVAL_REQUIRED');
  if (allocationCritical.length) {
    const lines = allocationCritical.map((r) => `  • ${r.title}\n    ${r.remediation}`).join('\n');
    throw new Error(
      `config.json violates Etsy Personal Access limits and cannot start:\n${lines}\n\n` +
      'There is no runtime override for Etsy\'s allocation. Reduce the connected shops or obtain the required Etsy approval.'
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
    'marked shipped on Etsy before carrier first-scan. Confirm the status accurately reflects the real parcel handoff ' +
    'and monitor it until the carrier accepts it.'
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
