'use strict';

/**
 * Etsy API v3 client — verified against https://developers.etsy.com/documentation/
 *
 * ─── AUTHENTICATION (verified from official docs) ────────────────────────────
 *
 * Every authenticated request requires TWO headers:
 *
 *   x-api-key:     keystring:shared_secret    ← BOTH parts, colon-separated
 *   Authorization: Bearer 12345678.token      ← numeric_user_id.oauth_token
 *
 * Source: https://developers.etsy.com/documentation/essentials/requests
 * "Your Etsy App API Key keystring and shared secret, separated by a colon (:)"
 *
 * The access token expires in 3600 seconds (1 hour). Token refresh is handled
 * by TokenManager in src/auth/token-manager.js.
 *
 * ─── RATE LIMITS (verified from official docs + user's screenshot) ───────────
 *
 * Personal Access apps: 5 QPS / 5,000 QPD (sliding 24h window)
 * Source: https://developers.etsy.com/documentation/essentials/rate-limits
 *
 * Rate limit headers returned on every response:
 *   x-limit-per-day        Total QPD limit
 *   x-remaining-today      Remaining in current 24h window
 *   x-limit-per-second     Total QPS limit
 *   x-remaining-this-second  Remaining in current second
 *   retry-after            Present on 429 responses
 *
 * ─── SCOPES required for this dashboard ─────────────────────────────────────
 *
 *   transactions_r — read orders/receipts (required)
 *   shops_r        — read shop info
 *   listings_r     — read private/inactive listings
 *
 * ─── PERSONAL ACCESS LIMIT ───────────────────────────────────────────────────
 *
 * The Developer Portal's allocation is authoritative (this installation has
 * historically shown five shops for Personal Access). Etsy API Terms permit one
 * designated key per application and prohibit duplicate keys/apps used to
 * circumvent limits. Never split shops across extra keys without Etsy's written
 * approval for this exact application topology.
 *
 * ─── RATE BUDGET MATH ────────────────────────────────────────────────────────
 *
 * Shops per key varies only by Etsy's approved allocation, never by network path.
 * ~5 API calls per shop per sync (resolveShopId + 2 receipt passes + listing images).
 *
 * 5 shops/key, 60-min interval: 5 × 5 × 24 =  600 calls/day → 12% of 5K QPD
 * 1 shop/key,  60-min interval: 1 × 5 × 24 =  120 calls/day →  2% of 5K QPD
 *
 * Server startup prints a live per-key budget breakdown.
 * DO NOT drop sync_interval_minutes below 15 — risks >3,600 calls/day on a 5-shop key.
 */

const axios = require('axios');
const FormData = require('form-data');
const { TokenExpiredError } = require('../auth/token-manager');

// ─────────────────────────────────────────────────────────────────────────────
// Rate Limiter (local, per-key)
// Tracks calls in a sliding 24h window to stay under the 5K QPD limit.
// Also reads x-remaining-today headers to sync with Etsy's actual server-side count.
// ─────────────────────────────────────────────────────────────────────────────

const PERSONAL_ACCESS_QPD = 5000; // verified from user's developer portal screenshot
const QPD_SAFETY_BUFFER   = 4900; // leave 100 calls headroom for manual/ad-hoc use

// When Etsy reports the budget as spent but gives us no `retry-after` to act on
// (e.g. a zero-remaining header on a success response), wait this long before the
// next attempt rather than hammering the key. The sliding window frees budget
// gradually, so a short, bounded cooldown lets us resume as soon as a bucket rolls
// off instead of stalling for a full day. After it elapses we send a single
// "half-open" probe to re-learn the real budget from Etsy's headers.
const DEFAULT_QPD_COOLDOWN_MS = 10 * 60 * 1000;

// Headroom (in calls) that low-priority BACKGROUND traffic (receipt sync, listing
// counts, inventory polling, image fetches, ledger backfills…) must always leave
// untouched. This guarantees high-priority, operator-initiated writes — shipping
// and completing orders, editing tracking — are NEVER locked out by a batch job
// that ran the key down. ~6% of the 5K/day budget; negligible for background work,
// but always enough for a human to fulfil orders.
const QPD_BACKGROUND_RESERVE = 300;

// Call priorities. 'critical' is reserved for user-initiated order fulfilment and
// is never gated locally — Etsy alone decides (a real 429 still surfaces). Anything
// else must respect the background reserve above.
const PRIORITY_CRITICAL = 'critical';

// ─── Per-second (QPS) pacing ──────────────────────────────────────────────────
// Etsy's hard wall is 5 QPS PER API KEY. The QPD guard above says nothing about
// bursts within a single second, so several concurrent callers on one key (e.g.
// the inventory sync's worker pool, a listing-counts fan-out, or 20 back-to-back
// image uploads while creating a listing) could otherwise cross 5 QPS and start
// tripping 429s — exactly the signal Etsy's anti-abuse systems watch. We pace
// EVERY outgoing request through a per-key leaky bucket sized a touch under the
// wall so the combined rate can never exceed it, no matter how many jobs overlap.
const QPS_SAFETY = 4; // requests/sec per key (Etsy allows 5 — leave headroom)

// A single, stable identifier Etsy can attribute our traffic to. A descriptive
// User-Agent is Etsy best practice and reduces the chance of being lumped in with
// anonymous/generic bot traffic. Version is read from package.json (best-effort).
const APP_VERSION = (() => {
  try { return require('../../package.json').version || '0.0.0'; }
  catch { return '0.0.0'; }
})();
const ETSY_USER_AGENT = `Unified-Etsy-Dashboard/${APP_VERSION} (+node)`;

/**
 * Thrown when an API key's QPD (queries-per-day) budget is exhausted, or when a
 * 429 persists through every retry. Identifiable via `code === 'ETSY_QPD_EXHAUSTED'`.
 *
 * This is a TRANSIENT, self-resolving condition: Etsy's QPD is a sliding 24h
 * window, so budget frees up continuously. Callers should treat it as a
 * "back off and resume on the next cycle" signal — never as a hard failure that
 * needs human action.
 */
class QpdExhaustedError extends Error {
  constructor(message, { resetInSeconds = null, keyId = null } = {}) {
    super(message);
    this.name = 'QpdExhaustedError';
    this.code = 'ETSY_QPD_EXHAUSTED';
    this.resetInSeconds = resetInSeconds;
    this.resetAt = resetInSeconds != null ? Date.now() + resetInSeconds * 1000 : null;
    this.keyId = keyId;
    this.retryable = true; // resolves on its own as the sliding window advances
  }
}

/** True when an error represents Etsy QPD exhaustion (or a persistent 429). */
function isQpdExhaustedError(err) {
  return !!err && err.code === 'ETSY_QPD_EXHAUSTED';
}

/**
 * Per-API-key budget guard for Etsy's sliding 24h QPD window.
 *
 * Etsy enforces QPD at the API-KEY level (not per shop), so one limiter is shared
 * by every shop on the same keystring. The guard combines two signals:
 *   1. A local sliding-window counter (defensive, works before the first response).
 *   2. The server-authoritative `x-remaining-today` header, which always wins.
 * On a 429 it honors Etsy's `retry-after` exactly, and short-circuits further
 * calls until the cooldown elapses so a spent key is never stormed.
 */
// Maximum snapshots to keep per API key (ring-buffer; older entries are evicted).
// One entry == one Etsy call, and a full sync cycle makes dozens of calls, so keep
// a generous window so the operator can see a meaningful breakdown of recent reasons.
const HISTORY_RING_SIZE = 200;

class RateLimiter {
  constructor(maxCallsPer24h = QPD_SAFETY_BUFFER, keyId = 'default', maxQps = QPS_SAFETY) {
    this._max = maxCallsPer24h;
    this._window = 24 * 60 * 60 * 1000; // sliding 24h window (Etsy uses bucket-based sliding window)
    this._calls = [];
    this._serverRemaining = null;       // updated from x-remaining-today response header
    this._keyId = keyId;                // masked keystring, for human-readable logs
    this._blockedUntil = 0;             // ms epoch; while in the future, check() short-circuits
    // QPS pacing: minimum gap between two requests on this key, and the epoch (ms)
    // at which the next request is allowed to leave. Concurrent callers each reserve
    // a distinct future slot, so N parallel requests are spaced, never simultaneous.
    this._minRequestIntervalMs = Math.ceil(1000 / Math.max(1, maxQps));
    this._nextRequestAt = 0;
    /**
     * Ring-buffer of authoritative budget snapshots from Etsy headers.
     * Each entry: { ts: <ms epoch>, remaining: <number>, delta: <number|null> }
     * delta = how many calls were consumed since the previous snapshot (negative = dropped).
     * Capped at HISTORY_RING_SIZE; oldest entries are evicted first.
     */
    this._history = [];
  }

  /**
   * Pre-flight gate, called before every Etsy request on this key.
   *
   * @param {'critical'|'normal'} [priority='normal']
   *   'critical' — operator-initiated order fulfilment (ship/complete/edit tracking).
   *   Never gated locally: we let Etsy be the sole authority so a human is never
   *   locked out of shipping by our own conservative counter. A genuine Etsy 429
   *   still surfaces (with its retry-after) through withRetry.
   * @throws {QpdExhaustedError} when no budget is available for this priority.
   */
  check(priority = 'normal') {
    const now = Date.now();
    this._calls = this._calls.filter((t) => now - t < this._window);

    // Critical user actions bypass the local guard entirely — Etsy decides.
    if (priority === PRIORITY_CRITICAL) {
      this._calls.push(now);
      return;
    }

    // Half-open: once a cooldown elapses, forget the stale "zero remaining" and
    // let the next background call probe Etsy to re-learn the real budget. A
    // success refreshes the count and resumes us; a 429 re-arms the cooldown via
    // the response interceptor. Without this we'd self-block indefinitely on a
    // stale count (no requests → no headers → never recover).
    if (this._blockedUntil && now >= this._blockedUntil) {
      this._blockedUntil = 0;
      this._serverRemaining = null;
    }

    // Honor an active cooldown so we don't fire requests guaranteed to be rejected.
    if (this._blockedUntil > now) {
      throw this._exhausted(Math.ceil((this._blockedUntil - now) / 1000));
    }

    // The server count always wins when present; the local counter is a fallback
    // for the window before the first response arrives.
    const localRemaining = this._max - this._calls.length;
    const effectiveRemaining =
      this._serverRemaining !== null
        ? Math.min(localRemaining, this._serverRemaining)
        : localRemaining;

    if (effectiveRemaining <= QPD_BACKGROUND_RESERVE) {
      if (effectiveRemaining <= 0) {
        // Genuinely out of budget. Recovery time depends on the binding limit:
        //   • server-bound (Etsy says 0) → sliding window frees gradually and the
        //     exact moment is unknown, so re-probe on a short bounded cadence.
        //   • local-bound (our own counter) → frees precisely when the oldest
        //     in-window call ages out.
        const serverBinding = this._serverRemaining !== null && this._serverRemaining <= 0;
        const coolSec = Math.ceil(DEFAULT_QPD_COOLDOWN_MS / 1000);
        const oldest = this._calls[0];
        const resetSec = serverBinding
          ? coolSec
          : (oldest ? Math.max(1, Math.ceil((oldest + this._window - now) / 1000)) : coolSec);
        // Cap the block at the probe cadence so we always re-check Etsy soon,
        // even if the local estimate is large — never self-block for ~24h.
        this._blockedUntil = now + Math.min(resetSec, coolSec) * 1000;
        throw this._exhausted(resetSec);
      }
      // Budget still exists but is the protected reserve for critical actions.
      // Do NOT arm a cooldown — the budget is intact, just withheld from batch work.
      throw this._exhausted(Math.ceil(DEFAULT_QPD_COOLDOWN_MS / 1000), { reserved: true });
    }

    this._calls.push(now);
  }

  /** Build a QpdExhaustedError with an honest, accurate reset estimate. */
  _exhausted(resetSec, { reserved = false } = {}) {
    const mins = Math.max(1, Math.round(resetSec / 60));
    if (reserved) {
      return new QpdExhaustedError(
        `Etsy API budget for key ${this._keyId} is low — the remaining ${QPD_BACKGROUND_RESERVE} ` +
          `call(s) are reserved for order fulfilment. Background sync resumes in ~${mins} min; ` +
          `shipping/completing orders still works.`,
        { resetInSeconds: resetSec, keyId: this._keyId }
      );
    }
    return new QpdExhaustedError(
      `Etsy daily API budget exhausted for key ${this._keyId} ` +
        `(${PERSONAL_ACCESS_QPD}/day, sliding 24h window). ` +
        `Auto-resumes in ~${mins} min as the window advances — no action needed.`,
      { resetInSeconds: resetSec, keyId: this._keyId }
    );
  }

  /**
   * Record an explicit cooldown, e.g. from a 429 `retry-after` (seconds) or a
   * zero `x-remaining-today` header. Extends (never shortens) any existing block.
   * @param {number|null} retryAfterSec
   */
  noteCooldown(retryAfterSec) {
    const sec = Number.isFinite(retryAfterSec) && retryAfterSec > 0
      ? retryAfterSec
      : Math.ceil(DEFAULT_QPD_COOLDOWN_MS / 1000);
    this._blockedUntil = Math.max(this._blockedUntil, Date.now() + sec * 1000);
    this._serverRemaining = 0;
  }

  /**
   * QPS gate — resolves once this request may leave without breaching the per-key
   * per-second wall. Reserves the next free slot atomically (synchronous section
   * before the await), so many concurrent callers on the same key line up behind
   * one another spaced by `_minRequestIntervalMs` instead of firing at once.
   *
   * This is a pure smoother: it never rejects, only delays. QPD exhaustion is a
   * separate concern handled by check(); this only shapes burst rate.
   *
   * @returns {Promise<void>}
   */
  async throttleQps() {
    const now = Date.now();
    const slot = Math.max(now, this._nextRequestAt);
    this._nextRequestAt = slot + this._minRequestIntervalMs;
    const wait = slot - now;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  /**
   * Update budget state from response headers (success OR error path).
   * @param {import('http').IncomingHttpHeaders} headers
   * @param {string} [op] Human-readable label for the call that produced these
   *   headers (e.g. "Fetch orders"), recorded in the history so the operator can
   *   see WHY each call was spent. Defaults to 'API call' when unknown.
   */
  updateFromHeaders(headers, op = 'API call') {
    if (!headers) return;
    const remaining = headers['x-remaining-today'];
    if (remaining !== undefined) {
      const n = parseInt(remaining, 10);
      if (Number.isFinite(n)) {
        const prev = this._serverRemaining;
        this._serverRemaining = n;

        // Record a history snapshot every time Etsy tells us the real budget.
        // Each response interceptor fire == exactly one Etsy call, so `op` names
        // precisely what this call was for.
        // delta: how many calls Etsy says were consumed since the last snapshot.
        // Negative delta means the sliding window released some old calls back to us.
        const delta = prev !== null ? prev - n : null;
        const snap = { ts: Date.now(), remaining: n, delta, op };
        this._history.push(snap);
        if (this._history.length > HISTORY_RING_SIZE) this._history.shift();

        if (n <= 0) {
          const ra = parseInt(headers['retry-after'], 10);
          this.noteCooldown(Number.isFinite(ra) ? ra : null);
        } else if (this._blockedUntil) {
          // Budget came back (a bucket rolled off) — clear any stale cooldown.
          this._blockedUntil = 0;
        }
      }
    }
    if (this._serverRemaining !== null && this._serverRemaining > 0 && this._serverRemaining < 200) {
      console.warn(
        `[etsy/client] Rate limit warning: key ${this._keyId} has only ${this._serverRemaining} call(s) left in the current 24h window.`
      );
    }
  }

  get remaining() {
    const now = Date.now();
    this._calls = this._calls.filter((t) => now - t < this._window);
    const local = this._max - this._calls.length;
    return this._serverRemaining !== null ? Math.min(local, this._serverRemaining) : local;
  }

  get serverRemaining() {
    return this._serverRemaining;
  }

  /** Milliseconds until this key is usable again (0 when not blocked). */
  get blockedForMs() {
    return Math.max(0, this._blockedUntil - Date.now());
  }
}

/** @type {Map<string, RateLimiter>} keystring → RateLimiter */
const _rateLimiters = new Map();

/**
 * Memoized shop name → numeric shop_id cache.
 * Etsy API path parameters require numeric IDs; config.json stores shop names.
 * @type {Map<string, string>}
 */
const _shopIdCache = new Map();

/**
 * Resolve a shop identifier (name string or numeric ID) to a numeric shop_id string.
 * If the value is already numeric it is returned as-is (no API call made).
 * For name strings, calls GET /application/shops?shop_name={name} and caches the result.
 *
 * @param {import('axios').AxiosInstance} shopClient - Authenticated shop client
 * @param {string|number} shopIdOrName
 * @returns {Promise<string>} Numeric shop_id as a string
 */
async function resolveShopId(shopClient, shopIdOrName) {
  const str = String(shopIdOrName);
  if (/^\d+$/.test(str)) return str;                // already numeric — no lookup needed
  if (_shopIdCache.has(str)) return _shopIdCache.get(str); // cached from a previous call

  gateClient(shopClient);
  const { data } = await shopClient.get('/application/shops', {
    params: { shop_name: str, limit: 1 },
  });

  if (!data.results || data.results.length === 0) {
    throw new Error(
      `Shop name "${str}" not found via Etsy API. ` +
      `Verify the shop_name in config.json matches the Etsy shop URL exactly.`
    );
  }

  const numericId = String(data.results[0].shop_id);
  _shopIdCache.set(str, numericId);
  return numericId;
}

function getRateLimiter(shopClient) {
  // Key the rate limiter to the keystring portion of x-api-key
  const rawKey = shopClient.defaults.headers?.common?.['x-api-key']
    ?? shopClient.defaults.headers?.['x-api-key']
    ?? 'default';
  const keystring = rawKey.split(':')[0]; // extract just the keystring from "keystring:secret"
  if (!_rateLimiters.has(keystring)) {
    // Mask the keystring for logs: keep the first 6 chars only.
    const keyId = keystring && keystring !== 'default'
      ? `${keystring.slice(0, 6)}…`
      : 'default';
    _rateLimiters.set(keystring, new RateLimiter(QPD_SAFETY_BUFFER, keyId));
  }
  return _rateLimiters.get(keystring);
}

/**
 * Pre-flight budget gate for a request on this client. Honors the priority that
 * was stamped on the client at creation (buildShopClient({ priority })). Clients
 * built for operator-initiated order fulfilment are 'critical' and bypass the
 * local guard; everything else respects the background reserve.
 * @param {import('axios').AxiosInstance} shopClient
 */
function gateClient(shopClient) {
  const priority = shopClient?.defaults?.__etsyPriority || 'normal';
  return getRateLimiter(shopClient).check(priority);
}

/**
 * Map an Etsy request (method + path) to a short, human-readable reason so the
 * budget history can explain WHY each call was spent. Ordered most-specific first.
 *
 * @param {string} [method] HTTP verb (any case)
 * @param {string} [url] Request path, e.g. "/application/shops/123/receipts"
 * @returns {string} A friendly label like "Fetch orders" or "Inventory check".
 */
function classifyEtsyOp(method, url) {
  const m = String(method || 'get').toUpperCase();
  const u = String(url || '');

  // Order fulfilment (operator-initiated, highest value)
  if (/\/receipts\/[^/]+\/tracking/.test(u)) return 'Ship / complete order';
  if (/\/receipts\/[^/]+\/transactions/.test(u)) return 'Order line items';
  if (/\/receipts\/[^/]+$/.test(u)) return 'Order details';
  if (/\/receipts(\?|$)/.test(u)) return 'Fetch orders';

  // Inventory & listings
  if (/\/listings\/[^/]+\/inventory/.test(u)) return m === 'PUT' ? 'Restock inventory' : 'Inventory check';
  if (/\/listings\/batch/.test(u)) return 'Order images';
  if (/\/reviews/.test(u)) return 'Shop reviews';
  if (/\/listings\/active/.test(u)) return 'Active listings';
  if (/\/listings\/[^/]+\/images/.test(u)) return 'Upload listing image';
  if (/\/listings\/[^/]+\/videos/.test(u)) return 'Upload listing video';
  if (/\/listings\/[^/]+\/variation-images/.test(u)) return m === 'POST' ? 'Set variation images' : 'Variation images';
  if (/\/shops\/[^/]+\/listings\/[^/]+/.test(u)) return 'Update listing';
  if (/\/shops\/[^/]+\/listings/.test(u)) return m === 'POST' ? 'Create listing' : 'Shop listings';
  if (/\/listings\/[^/]+$/.test(u) && m === 'DELETE') return 'Delete listing';

  // Finance
  if (/\/payment-account\/ledger-entries/.test(u)) return 'Finance / ledger sync';
  if (/\/payments/.test(u)) return 'Payments sync';

  // Shop metadata / listing-creation prerequisites
  if (/\/shipping-profiles/.test(u)) return 'Shipping profiles';
  if (/\/policies\/return/.test(u)) return 'Return policy';
  if (/\/production-partners/.test(u)) return 'Production partners';
  if (/\/sections/.test(u)) return 'Shop sections';
  if (/\/readiness-state-definitions/.test(u)) return 'Readiness states';
  if (/\/seller-taxonomy\/nodes\/[^/]+\/properties/.test(u)) return 'Taxonomy properties';
  if (/\/seller-taxonomy\/nodes/.test(u)) return 'Taxonomy lookup';

  // Shop core
  if (/\/openapi-ping/.test(u)) return 'Connection check';
  if (/\/shops\/[^/]+$/.test(u)) return m === 'PUT' ? 'Update shop' : 'Shop info';
  if (/\/shops(\?|$)/.test(u)) return 'Shop lookup';

  return 'API call';
}

/**
 * Add a response interceptor to a shop client that:
 * 1. Updates the rate limiter from response headers
 * 2. Logs QPS/QPD remaining for observability
 * @param {import('axios').AxiosInstance} instance
 */
function attachRateLimitInterceptor(instance) {
  instance.interceptors.response.use(
    (response) => {
      const limiter = getRateLimiter(instance);
      const op = classifyEtsyOp(response.config?.method, response.config?.url);
      limiter.updateFromHeaders(response.headers, op);
      return response;
    },
    (error) => {
      // Error responses carry the same budget headers — and a 429 carries the
      // authoritative `retry-after`. Capture both so the next check() can
      // short-circuit instead of stampeding a spent key.
      const resp = error?.response;
      if (resp) {
        const limiter = getRateLimiter(instance);
        const op = classifyEtsyOp(error.config?.method, error.config?.url);
        limiter.updateFromHeaders(resp.headers, op);
        if (resp.status === 429) {
          const ra = parseInt(resp.headers?.['retry-after'], 10);
          limiter.noteCooldown(Number.isFinite(ra) ? ra : null);
        }
      }
      return Promise.reject(error);
    }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Retry with exponential backoff
// Retryable HTTP:    429 (rate limit), 500, 502, 503, 504
// Retryable network: transient transport failures with NO HTTP response — e.g.
//                    "socket hang up" (ECONNRESET), connection timeouts, DNS
//                    blips. These are common over the VPN→proxy chain and have
//                    err.response === undefined, so they must be matched on
//                    err.code / err.message rather than a status code.
// Not retried:       401 (re-authenticate), 403 (scope missing), 404 (not found)
// ─────────────────────────────────────────────────────────────────────────────

// Transport-level error codes that are safe to retry. All requests here are
// idempotent (GETs, and the inventory PUT writes a fixed target quantity), so a
// reset socket can be replayed without risk of double-applying a side effect.
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',     // "socket hang up" — peer/proxy dropped the connection
  'ECONNABORTED',   // axios client-side timeout
  'ETIMEDOUT',      // OS-level connection/read timeout
  'EPIPE',          // broken pipe while writing the request
  'ECONNREFUSED',   // proxy hop briefly refused the connection
  'ENETUNREACH',    // transient network unreachable
  'EHOSTUNREACH',   // transient host unreachable
  'EAI_AGAIN',      // temporary DNS resolution failure
  'ERR_SOCKET_CONNECTION_TIMEOUT',
]);

const RETRYABLE_NETWORK_MESSAGES = [
  'socket hang up',
  'client network socket disconnected',
  'network socket disconnected',
  'timeout',
];

/**
 * True when an error is a transient transport failure (no HTTP response was
 * ever received) that is worth retrying rather than surfacing to the user.
 * @param {any} err
 */
function isRetryableNetworkError(err) {
  // A real HTTP response means the request reached Etsy — handled by status code.
  if (err?.response) return false;

  if (err?.code && RETRYABLE_NETWORK_CODES.has(err.code)) return true;

  const msg = String(err?.message || '').toLowerCase();
  return RETRYABLE_NETWORK_MESSAGES.some((m) => msg.includes(m));
}

/**
 * Retry wrapper for Etsy calls.
 *
 * @param {Function} fn                 The request to (re)run.
 * @param {number}   [maxRetries=3]
 * @param {object}   [opts]
 * @param {Function} [opts.reconcile]   Idempotency probe for NON-idempotent calls
 *   (POST creates). Between a retryable failure and the re-send, this is invoked to
 *   ask Etsy whether the operation already landed — because on the VPN→proxy chain
 *   the request can SUCCEED while only its RESPONSE is lost, and a blind re-send
 *   would then create a duplicate (for a shipment, a second buyer email). Contract:
 *     • resolves a truthy value → already applied; adopt it, do NOT re-send.
 *     • resolves null/false     → confirmed not applied; safe to re-send.
 *     • rejects                 → state unknown; fail closed (do NOT re-send a
 *                                 non-idempotent op) and surface the original error.
 *   Omit it for idempotent calls (GETs, quantity PUTs) to keep the current behavior.
 */
async function withRetry(fn, maxRetries = 3, opts = {}) {
  const reconcile = typeof opts.reconcile === 'function' ? opts.reconcile : null;
  const RETRYABLE = new Set([429, 500, 502, 503, 504]);
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      // Never retry token-related errors — they need human action
      if (err instanceof TokenExpiredError) throw err;

      const status     = err.response?.status;
      const isHttp      = RETRYABLE.has(status);
      const isNetwork   = isRetryableNetworkError(err);
      if (!isHttp && !isNetwork) throw err;

      lastError = err;
      if (attempt === maxRetries) break;

      // Use Etsy's retry-after header if present, else exponential backoff.
      // Network errors have no headers, so they always fall back to backoff.
      const retryAfter = err.response?.headers?.['retry-after'];
      const backoff = Math.pow(2, attempt) * 1000 + Math.random() * 500;
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : backoff;

      const reason = isHttp
        ? `HTTP ${status}`
        : `network ${err.code || ''} (${err.message})`.trim();

      console.warn(
        `[etsy/client] ${reason} — attempt ${attempt}/${maxRetries}. ` +
          `Waiting ${Math.round(waitMs / 1000)}s before retry...`
      );
      await new Promise((res) => setTimeout(res, waitMs));

      // Idempotency guard: before re-sending a non-idempotent create, confirm the
      // previous attempt didn't already succeed with its response lost in transit.
      if (reconcile) {
        let already;
        try {
          already = await reconcile({ error: lastError, attempt });
        } catch (probeErr) {
          console.warn(
            `[etsy/client] idempotency probe failed (${probeErr.message}) — ` +
              `not re-sending to avoid a duplicate side effect. Failing closed.`
          );
          if (
            probeErr?.failClosed
            || probeErr?.code === 'ETSY_CREATE_STATE_UNKNOWN'
            || isQpdExhaustedError(probeErr)
          ) {
            if (!probeErr.cause) probeErr.cause = lastError;
            throw probeErr;
          }
          throw lastError;
        }
        if (already != null && already !== false) {
          console.warn(
            '[etsy/client] operation already applied on Etsy (response was lost in ' +
              'transit) — adopting the existing record instead of re-sending.'
          );
          return already;
        }
        // Probe confirmed nothing was created → the re-send below is safe.
      }
    }
  }

  // A 429 that survived every retry means the QPD/QPS budget is genuinely spent.
  // Surface it as a typed, self-resolving error so callers can back off cleanly
  // (the response interceptor has already recorded the retry-after cooldown).
  if (lastError?.response?.status === 429) {
    const ra = parseInt(lastError.response.headers?.['retry-after'], 10);
    const sec = Number.isFinite(ra) && ra > 0 ? ra : 60;
    throw new QpdExhaustedError(
      `Etsy API rate limit (429) persisted after ${maxRetries} retries. ` +
        `Backing off ~${sec}s before resuming.`,
      { resetInSeconds: sec }
    );
  }

  throw lastError;
}

// ─────────────────────────────────────────────────────────────────────────────
// Client factory
// Creates axios instances with the correct Etsy auth headers.
// Called by the sync worker on each sync cycle so the access token is always fresh.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build an axios instance for a specific shop with the correct auth headers.
 *
 * x-api-key format (per Etsy docs): "keystring:shared_secret"
 * Authorization format:             "Bearer 12345678.oauth_token"
 *
 * @param {import('axios').AxiosInstance} groupProxyClient - From proxy/factory.js (has httpsAgent set)
 * @param {string} apiKey        - Etsy app keystring
 * @param {string} sharedSecret  - Etsy app shared secret
 * @param {string} accessToken   - Current OAuth access token (e.g. "12345678.token")
 * @param {Function} [getToken]  - Optional fresh-token provider for long-lived clients
 * @param {object} [options]
 * @param {'critical'|'normal'} [options.priority='normal'] - Budget priority for all
 *        requests on this client. Use 'critical' for operator-initiated order
 *        fulfilment (ship/complete/edit tracking) so it is never gated by the
 *        background reserve. Defaults to 'normal' (respects the reserve).
 * @param {boolean} [options.requireProxy=false] - Fail-closed OpSec guard. When
 *        true, the underlying group client MUST carry an httpsAgent (i.e. the
 *        VPN→IPFoxy proxy chain). If it doesn't, we throw instead of letting a
 *        shop that must be proxied accidentally egress on the server's own
 *        datacenter IP — the exact footprint that gets shops linked/flagged.
 * @returns {import('axios').AxiosInstance}
 */
function buildShopClient(groupProxyClient, apiKey, sharedSecret, accessToken, getToken, options = {}) {
  // ── OpSec fail-closed: a shop that must be proxied never egresses direct ──────
  if (options.requireProxy && !groupProxyClient.defaults.httpsAgent) {
    throw new Error(
      `[etsy/client] Refusing to build a shop client for a proxied group without a ` +
      `proxy agent. This would send the shop's Etsy traffic from the server's own IP ` +
      `(group_id=${groupProxyClient._groupId ?? 'unknown'}). Check config.json proxy settings.`
    );
  }

  // Use axios.create() — Object.create() on an axios instance does not propagate
  // defaults into the actual request headers (axios merges from instance.defaults
  // at request time, which requires a real instance, not a prototype clone).
  const instance = axios.create({
    baseURL:    groupProxyClient.defaults.baseURL,
    httpsAgent: groupProxyClient.defaults.httpsAgent,
    timeout:    groupProxyClient.defaults.timeout ?? 30_000,
    headers: {
      'Content-Type': 'application/json',
      Accept:         'application/json',
      'User-Agent':   ETSY_USER_AGENT,
      // CORRECT FORMAT: keystring:shared_secret (both required per Etsy API docs)
      'x-api-key':    `${apiKey}:${sharedSecret}`,
      // CORRECT FORMAT: Bearer numeric_user_id.oauth_token
      Authorization:  `Bearer ${accessToken}`,
    },
  });
  // Stamp the budget priority so gateClient() can honor it on every request.
  instance.defaults.__etsyPriority = options.priority === PRIORITY_CRITICAL ? PRIORITY_CRITICAL : 'normal';
  attachRateLimitInterceptor(instance);

  // ── QPS pacing (applies to EVERY request, incl. critical) ────────────────────
  // Etsy's 5 QPS wall is enforced per key regardless of call priority, so even
  // order-fulfilment bursts (e.g. bulk-complete of up to 200 receipts) must be
  // spaced. This request interceptor awaits the per-key leaky bucket before each
  // send, capping the combined outgoing rate across ALL overlapping jobs on the
  // key. It only ever delays — it never rejects — so correctness is unaffected.
  instance.interceptors.request.use(async (cfg) => {
    await getRateLimiter(instance).throttleQps();
    return cfg;
  });

  // Etsy access tokens expire after 1 hour. For long-lived clients (e.g. a bulk
  // run that spans >1h), a token baked in at creation goes stale mid-run →
  // "invalid_token". When a getToken() provider is supplied, we (1) attach a
  // FRESH auto-refreshed token on every request, and (2) on a 401 force a refresh
  // and retry the request once. This keeps any long-running job authenticated
  // without re-creating the client.
  if (typeof getToken === 'function') {
    instance.interceptors.request.use(async (cfg) => {
      try {
        const tok = await getToken(false);
        if (tok) cfg.headers.Authorization = `Bearer ${tok}`;
      } catch { /* fall back to the baked-in token */ }
      return cfg;
    });
    instance.interceptors.response.use(undefined, async (error) => {
      const status = error.response?.status;
      const cfg = error.config;
      const body = error.response?.data;
      const isAuth = status === 401 || /invalid_token|token.*expired|unauthor/i.test(
        (body && (body.error || body.error_description)) || error.message || ''
      );
      if (isAuth && cfg && !cfg._authRetried) {
        cfg._authRetried = true;
        try {
          const tok = await getToken(true); // force refresh
          if (tok) {
            cfg.headers = cfg.headers || {};
            cfg.headers.Authorization = `Bearer ${tok}`;
            return instance.request(cfg);
          }
        } catch { /* fall through to reject */ }
      }
      return Promise.reject(error);
    });
  }
  return instance;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shop endpoints
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /application/shops/{shop_id}
 * Scope: none (public endpoint — only x-api-key needed, no Bearer token required)
 *
 * @param {import('axios').AxiosInstance} shopClient
 * @param {string} shopId
 */
async function getShop(shopClient, shopId) {
  const numericId = await resolveShopId(shopClient, shopId);
  gateClient(shopClient);
  return withRetry(async () => {
    const { data } = await shopClient.get(`/application/shops/${numericId}`);
    return data;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Receipts (Orders) — requires transactions_r scope
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Etsy's wire values are `up` and `down`. Accept the conventional aliases used
 * by older callers, but never send undocumented `asc` / `desc` values.
 */
function normalizeEtsySortOrder(value, fallback = 'down') {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === 'up' || v === 'asc' || v === 'ascending') return 'up';
  if (v === 'down' || v === 'desc' || v === 'descending') return 'down';
  return fallback;
}

/**
 * GET /application/shops/{shop_id}/receipts
 * Scope: transactions_r
 *
 * @param {import('axios').AxiosInstance} shopClient
 * @param {string} shopId
 * @param {object} [options]
 * @param {number} [options.limit=100]          - Max per page (Etsy max: 100)
 * @param {number} [options.offset=0]
 * @param {boolean} [options.was_paid]
 * @param {boolean} [options.was_shipped]
 * @param {number} [options.min_created]        - Unix timestamp lower bound
 * @param {string} [options.sort_on='created']
 * @param {string} [options.sort_order='down']
 * @returns {Promise<{ count: number, results: object[] }>}
 */
async function getReceipts(shopClient, shopId, options = {}) {
  const numericId = await resolveShopId(shopClient, shopId);
  gateClient(shopClient);

  const params = {
    limit: Math.min(options.limit ?? 100, 100),
    offset: options.offset ?? 0,
    sort_on: options.sort_on ?? 'created',
    sort_order: normalizeEtsySortOrder(options.sort_order, 'down'),
  };
  if (options.was_paid     !== undefined) params.was_paid           = options.was_paid;
  if (options.was_shipped  !== undefined) params.was_shipped        = options.was_shipped;
  if (options.min_created)               params.min_created         = options.min_created;
  if (options.min_last_modified)         params.min_last_modified   = options.min_last_modified;
  if (options.sort_on)                   params.sort_on             = options.sort_on;
  if (options.sort_order)                params.sort_order          = normalizeEtsySortOrder(options.sort_order, 'down');

  return withRetry(async () => {
    const { data } = await shopClient.get(`/application/shops/${numericId}/receipts`, { params });
    return data;
  });
}

/**
 * GET /application/shops/{shop_id}/receipts/{receipt_id}
 * Scope: transactions_r
 */
async function getReceipt(shopClient, shopId, receiptId) {
  const numericId = await resolveShopId(shopClient, shopId);
  gateClient(shopClient);
  return withRetry(async () => {
    const { data } = await shopClient.get(
      `/application/shops/${numericId}/receipts/${receiptId}`
    );
    return data;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Listing inventory endpoints
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /application/listings/{listing_id}/inventory
 * Scope: listings_r
 *
 * Returns the full inventory for a listing including all variation products
 * and their per-offering quantities.
 *
 * Response shape:
 *   { products: [{product_id, property_values, offerings: [{offering_id, quantity, is_enabled, price}]}],
 *     price_on_property, quantity_on_property, sku_on_property }
 *
 * @param {import('axios').AxiosInstance} shopClient
 * @param {string|number} listingId
 */
async function getListingInventory(shopClient, listingId) {
  gateClient(shopClient);
  return withRetry(async () => {
    const { data } = await shopClient.get(`/application/listings/${listingId}/inventory`);
    return data;
  });
}

/**
 * PUT /application/listings/{listing_id}/inventory
 * Scope: listings_w  ← REQUIRES RE-AUTHORIZATION if tokens lack this scope
 *
 * Replaces the full inventory for a listing. You MUST send the complete
 * products array (not just the changed items) — Etsy replaces everything.
 *
 * Typical workflow:
 *   1. const inv = await getListingInventory(client, id);
 *   2. Modify inv.products (e.g. set quantity to 3)
 *   3. await updateListingInventory(client, id, inv);
 *
 * @param {import('axios').AxiosInstance} shopClient
 * @param {string|number} listingId
 * @param {object} inventory   — full inventory object from getListingInventory
 */
async function updateListingInventory(shopClient, listingId, inventory) {
  gateClient(shopClient);
  return withRetry(async () => {
    // Etsy's PUT endpoint only accepts a strict subset of fields.
    // The GET response includes read-only fields (product_id, is_deleted, offering_id)
    // and price as a {amount, divisor, currency_code} object — all of which must be
    // stripped / converted before sending or Etsy returns 400 "invalid keys".
    const cleanProducts = (inventory.products || []).map(p => {
      const product = {
        property_values: (p.property_values || []).map(pv => {
          const out = {
            property_id:   pv.property_id,
            property_name: pv.property_name,
            values:        pv.values    ?? [],
            value_ids:     pv.value_ids ?? [],
          };
          // Only include scale fields when non-null and non-zero to avoid
          // sending invalid scale references for non-scaled properties.
          if (pv.scale_id)   out.scale_id   = pv.scale_id;
          if (pv.scale_name) out.scale_name = pv.scale_name;
          return out;
        }),
        // Only include non-deleted, enabled offerings.
        // CRITICAL: readiness_state_id (processing profile) MUST be echoed back
        // on every offering — even when readiness_state_on_property is [] —
        // or Etsy returns 400 "All offerings need readiness state".
        offerings: (p.offerings || [])
          .filter(o => !o.is_deleted && o.is_enabled !== false)
          .map(o => {
            // price arrives as {amount, divisor, currency_code}; PUT wants float
            const rawPrice = o.price;
            const price = (rawPrice && typeof rawPrice === 'object')
              ? rawPrice.amount / rawPrice.divisor
              : (rawPrice ?? 0);
            const offering = { price, quantity: o.quantity, is_enabled: true };
            // Echo back readiness_state_id — required when present
            if (o.readiness_state_id != null) {
              offering.readiness_state_id = o.readiness_state_id;
            }
            return offering;
          }),
      };
      if (p.sku) product.sku = p.sku;
      return product;
    })
    // Drop any products whose every offering was filtered out
    .filter(p => p.offerings.length > 0);

    const body = {
      products:                     cleanProducts,
      price_on_property:            inventory.price_on_property            ?? [],
      quantity_on_property:         inventory.quantity_on_property         ?? [],
      sku_on_property:              inventory.sku_on_property              ?? [],
      readiness_state_on_property:  inventory.readiness_state_on_property  ?? [],
    };
    const { data } = await shopClient.put(`/application/listings/${listingId}/inventory`, body);
    return data;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Listing endpoints
// ─────────────────────────────────────────────────────────────────────────────

function _moneyAsNumber(value) {
  if (value && typeof value === 'object') {
    const amount = Number(value.amount);
    const divisor = Number(value.divisor);
    return Number.isFinite(amount) && Number.isFinite(divisor) && divisor !== 0
      ? amount / divisor
      : NaN;
  }
  return Number(value);
}

/**
 * Find a draft that matches a create request and was created during the current
 * operation window. This is an idempotency reconciliation probe, not a general
 * title search: exact copy + taxonomy + price matching and a recent timestamp
 * prevent an older, legitimately similar draft from being adopted.
 */
async function findMatchingDraftListing(shopClient, shopId, body, {
  createdAfter = null,
  acceptListing = null,
} = {}) {
  const minCreated = Number.isFinite(Number(createdAfter))
    ? Math.floor(Number(createdAfter)) - 5
    : null;
  const expectedPrice = _moneyAsNumber(body?.price);
  const limit = 100;
  // Ambiguous failures are rare, so spend a bounded number of read calls to
  // search beyond the first page rather than risk a duplicate create.
  for (let offset = 0; offset < 500; offset += limit) {
    gateClient(shopClient);
    const data = await withRetry(async () => {
      const response = await shopClient.get(`/application/shops/${shopId}/listings`, {
        params: { state: 'draft', limit, offset },
      });
      return response.data;
    });
    const listings = data?.results || [];
    const match = listings.find((listing) => {
      const created = Number(
        listing.created_timestamp
        ?? listing.creation_timestamp
        ?? listing.original_creation_timestamp
        ?? 0
      );
      if (minCreated !== null && (!created || created < minCreated)) return false;
      if (String(listing.title ?? '') !== String(body?.title ?? '')) return false;
      if (String(listing.description ?? '') !== String(body?.description ?? '')) return false;
      if (body?.taxonomy_id != null && Number(listing.taxonomy_id) !== Number(body.taxonomy_id)) return false;
      if (Number.isFinite(expectedPrice)) {
        const actualPrice = _moneyAsNumber(listing.price);
        if (!Number.isFinite(actualPrice) || Math.abs(actualPrice - expectedPrice) > 0.005) return false;
      }
      if (body?.shop_section_id != null && Number(listing.shop_section_id) !== Number(body.shop_section_id)) return false;
      if (typeof acceptListing === 'function' && !acceptListing(listing)) return false;
      return true;
    });
    if (match) return match;
    if (listings.length < limit) break;
  }
  return null;
}

/**
 * GET /application/shops/{shop_id}/listings
 * Scope: listings_r
 *
 * Returns all listings for a shop (any state). Paginates automatically.
 * @param {import('axios').AxiosInstance} shopClient
 * @param {string|number} shopId - numeric shop ID
 * @param {object} [opts]
 * @param {'active'|'inactive'|'draft'|'sold_out'|'expired'|'all'} [opts.state]
 * @param {boolean} [opts.includeInventory=false] - Also request the `Inventory`
 *        association so each listing carries its full per-variation inventory
 *        (offerings with price + quantity) inline. This is far cheaper than a
 *        follow-up getListingInventory per listing (one page call of up to 100
 *        listings vs. up to 100 separate calls) and lets the caller cache
 *        variation prices in the same pass.
 * @yields {object[]} batches of listing objects
 */
async function* paginateListings(shopClient, shopId, opts = {}) {
  const { state = 'active', includeInventory = false } = opts;
  const includes = includeInventory ? 'Images,Inventory' : 'Images';
  let offset = 0;
  const limit = 100;
  while (true) {
    gateClient(shopClient);
    const params = { limit, offset, state, includes };
    // sort_on is documented as search-only; the listings tab still sends it and
    // Etsy accepts it for this shop-scoped endpoint. Catalog-health walks omit
    // it so a future spec tightening cannot 400 the daily snapshot.
    if (opts.sort !== false) {
      params.sort_on = 'updated';
      params.sort_order = 'down';
    }
    const { data } = await withRetry(() =>
      shopClient.get(`/application/shops/${shopId}/listings`, { params })
    );
    const listings = data.results ?? data.listings ?? [];
    if (!listings.length) break;
    yield listings;
    if (listings.length < limit) break;
    offset += limit;
    await new Promise((r) => setTimeout(r, 250)); // polite pause between pages
  }
}

/**
 * GET /application/shops/{shop_id}/listings?limit=1
 * Scope: listings_r
 *
 * Cheap count probe: Etsy returns `count` for the requested state without
 * walking every page. Used by catalog health to know expired/sold_out/draft
 * volume without spending a call per 100 listings.
 * @param {import('axios').AxiosInstance} shopClient
 * @param {string|number} shopId
 * @param {string} state
 * @returns {Promise<number>}
 */
async function getListingsCountByState(shopClient, shopId, state) {
  gateClient(shopClient);
  const { data } = await withRetry(() =>
    shopClient.get(`/application/shops/${shopId}/listings`, {
      params: { limit: 1, offset: 0, state },
    })
  );
  const count = Number(data?.count);
  if (Number.isFinite(count)) return count;
  return Array.isArray(data?.results) ? data.results.length : 0;
}

/**
 * GET /application/shops/{shop_id}/reviews
 * Scope: none (API key still required)
 *
 * Newest-first pages of shop reviews. Caps pages so a first run cannot spend
 * the daily QPD walking years of history; callers persist incrementally via
 * min_created.
 * @param {import('axios').AxiosInstance} shopClient
 * @param {string|number} shopId
 * @param {object} [opts]
 * @param {number} [opts.limit=100]
 * @param {number} [opts.offset=0]
 * @param {number} [opts.min_created]
 * @param {number} [opts.max_created]
 * @param {number} [opts.maxPages=3]
 * @yields {object[]} batches of TransactionReview objects
 */
async function* paginateReviewsByShop(shopClient, shopId, opts = {}) {
  const limit = Math.min(100, Math.max(1, Number(opts.limit) || 100));
  const maxPages = Math.min(20, Math.max(1, Number(opts.maxPages) || 3));
  let offset = Math.max(0, Number(opts.offset) || 0);
  let pages = 0;
  while (pages < maxPages) {
    gateClient(shopClient);
    const params = { limit, offset };
    if (opts.min_created != null && Number.isFinite(Number(opts.min_created))) {
      params.min_created = Math.trunc(Number(opts.min_created));
    }
    if (opts.max_created != null && Number.isFinite(Number(opts.max_created))) {
      params.max_created = Math.trunc(Number(opts.max_created));
    }
    const { data } = await withRetry(() =>
      shopClient.get(`/application/shops/${shopId}/reviews`, { params })
    );
    const reviews = data.results ?? [];
    if (!reviews.length) break;
    yield reviews;
    pages += 1;
    if (reviews.length < limit) break;
    offset += limit;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * PATCH /application/shops/{shop_id}/listings/{listing_id}
 * Scope: listings_w
 *
 * Updates editable fields on a listing.
 * @param {import('axios').AxiosInstance} shopClient
 * @param {string|number} shopId
 * @param {string|number} listingId
 * @param {object} fields - { title, description, price, quantity, tags, state }
 */
async function updateListing(shopClient, shopId, listingId, fields) {
  gateClient(shopClient);
  return withRetry(async () => {
    const params = _toFormUrlEncoded(fields);
    const { data } = await shopClient.patch(
      `/application/shops/${shopId}/listings/${listingId}`,
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    return data;
  });
}

/**
 * POST /application/shops/{shop_id}/listings
 * Scope: listings_w
 *
 * Creates a draft listing. All required fields must be provided.
 * @param {import('axios').AxiosInstance} shopClient
 * @param {string|number} shopId
 * @param {object} body - { quantity, title, description, price, who_made, when_made, taxonomy_id, ... }
 */
async function createDraftListing(shopClient, shopId, body) {
  return createDraftListingForm(shopClient, shopId, body);
}

/**
 * DELETE /application/listings/{listing_id}
 * Scope: listings_d
 */
async function deleteListing(shopClient, listingId) {
  gateClient(shopClient);
  return withRetry(async () => {
    await shopClient.delete(`/application/listings/${listingId}`);
  });
}

/**
 * POST /application/shops/{shop_id}/receipts/{receipt_id}/tracking
 * Scope: transactions_w
 *
 * Creates a shipment tracking entry and marks the receipt as shipped.
 * Etsy sends a shipping confirmation email to the buyer.
 *
 * @param {import('axios').AxiosInstance} shopClient
 * @param {string|number} shopId  - numeric shop ID
 * @param {string|number} receiptId
 * @param {object} opts
 * @param {string}  opts.tracking_code  - required
 * @param {string}  opts.carrier_name   - required (e.g. "4PX")
 * @param {boolean} [opts.send_bcc]     - send a copy to the seller (default false)
 * @param {string}  [opts.note_to_buyer]
 * @param {number|string|Date} [opts.ship_date] - ISO-8601 date/time, or epoch
 *        seconds/milliseconds which will be normalized to Etsy's ISO format.
 */
async function createReceiptShipment(shopClient, shopId, receiptId, opts = {}) {
  gateClient(shopClient);

  // This POST fires a buyer shipping-notification email and Etsy allows MANY
  // shipment records per receipt, so it is NOT idempotent. On a retry (e.g. the
  // request landed but its response was lost on the proxy chain), probe the
  // receipt's existing shipments and adopt the one carrying this exact
  // tracking_code instead of sending a second notification. For the deliberate
  // edit-tracking flow (idempotent:false), snapshot existing shipment IDs first
  // so only a NEW record from this attempt can satisfy reconciliation.
  const wantTracking = String(opts.tracking_code ?? '').trim();
  let baselineShipmentIds = null;
  if (opts.idempotent === false && wantTracking) {
    // An edit intentionally creates a new shipment notification even if the same
    // code existed before. Snapshot existing IDs so reconciliation adopts only
    // the shipment created by THIS attempt, never an older one.
    const before = await getReceipt(shopClient, shopId, receiptId);
    baselineShipmentIds = new Set(
      (Array.isArray(before?.shipments) ? before.shipments : [])
        .map((s) => String(s?.receipt_shipping_id ?? ''))
        .filter(Boolean)
    );
  }
  const reconcile = wantTracking
    ? async () => {
        const receipt = await getReceipt(shopClient, shopId, receiptId);
        const shipments = Array.isArray(receipt?.shipments) ? receipt.shipments : [];
        return shipments.find((s) => {
          if (String(s?.tracking_code ?? '').trim() !== wantTracking) return false;
          if (!baselineShipmentIds) return true;
          return !baselineShipmentIds.has(String(s?.receipt_shipping_id ?? ''));
        }) || null;
      }
    : null;

  return withRetry(async () => {
    const body = {
      tracking_code:  opts.tracking_code,
      carrier_name:   /^4px$/i.test(String(opts.carrier_name || '4px')) ? '4px' : opts.carrier_name,
      send_bcc:       opts.send_bcc ?? false,
    };
    if (opts.note_to_buyer) body.note_to_buyer = opts.note_to_buyer;
    if (opts.ship_date != null) {
      const raw = opts.ship_date;
      let date;
      if (raw instanceof Date) date = new Date(raw.getTime());
      else if (typeof raw === 'number' && Number.isFinite(raw)) {
        date = new Date(raw < 1e12 ? raw * 1000 : raw);
      } else {
        date = new Date(String(raw));
      }
      if (!Number.isFinite(date.getTime())) {
        const err = new TypeError('ship_date must be an ISO-8601 date/time or a finite epoch timestamp');
        err.status = 400;
        throw err;
      }
      body.ship_date = date.toISOString();
    }
    const { data } = await shopClient.post(
      `/application/shops/${shopId}/receipts/${receiptId}/tracking`,
      body
    );
    return data;
  }, 3, { reconcile });
}

/**
 * Async generator that paginates through ALL receipts for a shop.
 * Yields batches of receipt objects (arrays of up to 100).
 *
 * Usage:
 *   for await (const batch of paginateReceipts(client, shopId)) {
 *     for (const receipt of batch) { ... }
 *   }
 *
 * @param {import('axios').AxiosInstance} shopClient
 * @param {string} shopId
 * @param {object} [options]
 * @param {number} [options.maxTotal=200]     - Hard cap (budget protection)
 * @param {number} [options.min_created]      - Only fetch receipts after this Unix timestamp
 */
async function* paginateReceipts(shopClient, shopId, options = {}) {
  const numericId = await resolveShopId(shopClient, shopId);
  const pageSize = 100;
  const maxTotal = options.maxTotal ?? 200;
  let offset = 0;
  let fetched = 0;

  while (fetched < maxTotal) {
    const limit = Math.min(pageSize, maxTotal - fetched);
    const page = await getReceipts(shopClient, numericId, {
      limit,
      offset,
      min_created:        options.min_created,
      min_last_modified:  options.min_last_modified,
      sort_on:            options.sort_on,
      sort_order:         options.sort_order,
    });

    if (!page.results || page.results.length === 0) break;
    yield page.results;

    fetched += page.results.length;
    offset += page.results.length;
    if (page.results.length < limit) break;

    await new Promise((res) => setTimeout(res, 300)); // polite pause between pages
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Transactions (line items within a receipt) — requires transactions_r scope
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /application/shops/{shop_id}/receipts/{receipt_id}/transactions
 * Scope: transactions_r
 */
async function getReceiptTransactions(shopClient, shopId, receiptId) {
  const numericId = await resolveShopId(shopClient, shopId);
  gateClient(shopClient);
  return withRetry(async () => {
    const { data } = await shopClient.get(
      `/application/shops/${numericId}/receipts/${receiptId}/transactions`
    );
    return data;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Payment account ledger & payments — requires transactions_r scope
//
// The ledger is Etsy's authoritative financial record: every sale posting, fee,
// tax, refund and disbursement, denominated in the shop's PAYOUT currency. It is
// the only reliable source for "what you actually earned" per order — the
// per-receipt /payments amounts are known to be mislabeled/unreliable, so we use
// the ledger for money and /payments ONLY to map payment_id → receipt_id.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Async generator that pages through a shop's payment-account ledger entries
 * within a [minCreated, maxCreated] window (both required by Etsy).
 *
 * @param {import('axios').AxiosInstance} shopClient
 * @param {string} shopId
 * @param {object} opts
 * @param {number} opts.minCreated  - Unix seconds, inclusive lower bound
 * @param {number} opts.maxCreated  - Unix seconds, inclusive upper bound
 * @param {number} [opts.pageSize=100]
 * @yields {object[]} a page of PaymentAccountLedgerEntry objects
 */
async function* paginateLedgerEntries(shopClient, shopId, opts = {}) {
  const numericId = await resolveShopId(shopClient, shopId);
  const pageSize  = opts.pageSize ?? 100;
  const minCreated = opts.minCreated;
  const maxCreated = opts.maxCreated;
  // Optional hard ceiling on entries per window (budget defence). Defaults to
  // unbounded to preserve prior behaviour; the QPD guard still stops a runaway
  // walk once the background reserve is reached.
  const maxTotal  = opts.maxTotal ?? Infinity;
  let offset = 0;
  let fetched = 0;

  while (fetched < maxTotal) {
    gateClient(shopClient);
    const data = await withRetry(async () => {
      const { data } = await shopClient.get(
        `/application/shops/${numericId}/payment-account/ledger-entries`,
        { params: { min_created: minCreated, max_created: maxCreated, limit: pageSize, offset } }
      );
      return data;
    });
    const results = data.results || [];
    if (results.length === 0) break;
    yield results;
    offset += results.length;
    fetched += results.length;
    if (results.length < pageSize) break;
    await new Promise((r) => setTimeout(r, 250)); // polite pause between pages
  }
}

/**
 * Fetch payments by their numeric IDs, returning a Map of payment_id → receipt_id.
 * The /payments money fields are unreliable, but the receipt_id linkage is solid,
 * which is all we need to attribute gross/processing-fee ledger entries to orders.
 *
 * @param {import('axios').AxiosInstance} shopClient
 * @param {string} shopId
 * @param {Array<string|number>} paymentIds
 * @returns {Promise<Map<string,number>>}
 */
async function getPaymentReceiptMap(shopClient, shopId, paymentIds) {
  const numericId = await resolveShopId(shopClient, shopId);
  const out = new Map();
  const unique = [...new Set(paymentIds.map(String).filter(Boolean))];
  const BATCH = 100;

  for (let i = 0; i < unique.length; i += BATCH) {
    const batch = unique.slice(i, i + BATCH);
    gateClient(shopClient);
    const data = await withRetry(async () => {
      const { data } = await shopClient.get(
        `/application/shops/${numericId}/payments`,
        { params: { payment_ids: batch.join(',') } }
      );
      return data;
    });
    for (const p of (data.results || [])) {
      if (p.payment_id != null && p.receipt_id != null) {
        out.set(String(p.payment_id), Number(p.receipt_id));
      }
    }
    if (i + BATCH < unique.length) await new Promise((r) => setTimeout(r, 250));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Listings — requires listings_r scope for private/inactive, none for active
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /application/shops/{shop_id}/listings/active
 * Scope: none (public listings only)
 */
async function getActiveListings(shopClient, shopId, options = {}) {
  const numericId = await resolveShopId(shopClient, shopId);
  gateClient(shopClient);
  return withRetry(async () => {
    const { data } = await shopClient.get(`/application/shops/${numericId}/listings/active`, {
      params: { limit: options.limit ?? 50, offset: options.offset ?? 0 },
    });
    return data;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Listing images — batch fetch to minimise API calls
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pick the dashboard-sized CDN URL from an Etsy ListingImage resource.
 * @param {object|null|undefined} img
 * @returns {string|null}
 */
function pickListingImageUrl(img) {
  if (!img) return null;
  return img.url_570xN ?? img.url_fullxfull ?? img.url_170x135 ?? img.url_75x75 ?? null;
}

/**
 * Fetch every listing image (all ranks, with listing_image_id) for up to 100
 * IDs per request. Used to join Etsy variation-images (image_id) to a CDN URL.
 *
 * Returns Map<listingId, { heroUrl: string|null, byImageId: Map<number, string> }>.
 * Missing/inactive listings are silently omitted.
 *
 * @param {import('axios').AxiosInstance} shopClient
 * @param {number[]} listingIds
 * @returns {Promise<Map<number, {heroUrl: string|null, byImageId: Map<number, string>}>>}
 */
async function getListingImageCatalogBatch(shopClient, listingIds) {
  const unique = [...new Set(listingIds.map(Number))].filter(Boolean);
  if (!unique.length) return new Map();

  const chunks = [];
  for (let i = 0; i < unique.length; i += 100) chunks.push(unique.slice(i, i + 100));

  const result = new Map();

  for (const chunk of chunks) {
    gateClient(shopClient);
    try {
      await withRetry(async () => {
        const params = new URLSearchParams();
        // Etsy's batch endpoint declares its array query params as explode:false,
        // i.e. a single COMMA-SEPARATED value (listing_ids=1,2,3). Repeated or
        // bracketed keys (listing_ids[]=1) are NOT recognised — Etsy then treats
        // listing_ids as missing (400) or silently returns just one row. See
        // etsy/open-api discussion #1479 and the reference SDK, which both join on
        // ",". This matches getPaymentReceiptMap's payment_ids serialisation.
        params.append('listing_ids', chunk.join(','));
        params.append('includes', 'Images');

        const { data } = await shopClient.get('/application/listings/batch', { params });
        for (const listing of (data.results ?? [])) {
          const byImageId = new Map();
          const images = Array.isArray(listing.images) ? listing.images : [];
          let heroUrl = pickListingImageUrl(images[0]);
          for (const img of images) {
            const url = pickListingImageUrl(img);
            const imageId = Number(img?.listing_image_id ?? img?.image_id);
            if (url && Number.isInteger(imageId) && imageId > 0) byImageId.set(imageId, url);
          }
          result.set(listing.listing_id, { heroUrl: heroUrl || null, byImageId });
        }
      });
    } catch (err) {
      console.warn(`[etsy/client] getListingImageCatalogBatch failed for chunk: ${err.message}`);
    }

    if (chunks.length > 1) await new Promise((r) => setTimeout(r, 300));
  }

  return result;
}

/**
 * Fetch the primary thumbnail URL for up to 100 listing IDs in one API call.
 * Uses GET /application/listings/batch?listing_ids=…,…&includes=Images
 *
 * Returns a Map<number, string> of listing_id → image URL.
 * Missing/inactive listings are silently omitted from the result.
 *
 * @param {import('axios').AxiosInstance} shopClient
 * @param {number[]} listingIds
 * @returns {Promise<Map<number, string>>}
 */
async function getListingImagesBatch(shopClient, listingIds) {
  const catalog = await getListingImageCatalogBatch(shopClient, listingIds);
  const result = new Map();
  for (const [listingId, entry] of catalog) {
    if (entry?.heroUrl) result.set(listingId, entry.heroUrl);
  }
  return result;
}

/**
 * GET /application/shops/{shop_id}/listings/{listing_id}/variation-images
 * Scope: none
 *
 * Returns the listing's variation → image_id links. `value` is the Styles
 * dropdown label (e.g. "Case 1 + Grip 1"); `image_id` joins to a ListingImage.
 *
 * @param {import('axios').AxiosInstance} shopClient
 * @param {string|number} shopId
 * @param {string|number} listingId
 * @returns {Promise<Array<{property_id:number, value_id:number, value:string, image_id:number}>>}
 */
async function getListingVariationImages(shopClient, shopId, listingId) {
  gateClient(shopClient);
  return withRetry(async () => {
    const { data } = await shopClient.get(
      `/application/shops/${shopId}/listings/${listingId}/variation-images`
    );
    return Array.isArray(data?.results) ? data.results : [];
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Ping — public endpoint, no bearer token needed, just x-api-key
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /application/openapi-ping
 * Verifies API key is valid. Returns application_id.
 * No OAuth token required — useful for testing connectivity before full auth.
 *
 * @param {import('axios').AxiosInstance} shopClient
 */
async function ping(shopClient) {
  return withRetry(async () => {
    const { data } = await shopClient.get('/application/openapi-ping');
    return data; // { application_id: 1234 }
  });
}

/**
 * Full connectivity test: verifies x-api-key format AND OAuth token are both working.
 * Returns key shop metadata.
 *
 * @param {import('axios').AxiosInstance} shopClient
 * @param {string} shopId
 */
async function pingShop(shopClient, shopId) {
  const shop = await getShop(shopClient, shopId); // resolveShopId is called inside getShop
  return {
    shop_name: shop.shop_name,
    currency_code: shop.currency_code,
    listing_active_count: shop.listing_active_count ?? 0,
    user_id: shop.user_id,
  };
}

/**
 * Get remaining QPD budget for a shop client's API key.
 * @param {import('axios').AxiosInstance} shopClient
 * @returns {{ local: number, server: number | null, max: number }}
 */
function getRemainingBudget(shopClient) {
  const limiter = getRateLimiter(shopClient);
  return {
    local: limiter.remaining,
    server: limiter.serverRemaining,
    max: QPD_SAFETY_BUFFER,
    percent_used: Math.round((1 - limiter.remaining / QPD_SAFETY_BUFFER) * 100),
  };
}

/**
 * Return the process-local QPD budget snapshot for every API key this process has
 * seen. This is intentionally read-only and does NOT call Etsy: every Etsy call
 * costs quota, so the dashboard should display the last known budget from
 * response headers instead of spending calls to ask how many calls are left.
 *
 * @returns {Array<{
 *   keystring: string,
 *   key_id: string,
 *   remaining: number,
 *   server_remaining: number | null,
 *   max: number,
 *   percent_used: number,
 *   blocked_for_ms: number,
 *   known: boolean
 * }>}
 */
function getBudgetSnapshots() {
  return [..._rateLimiters.entries()].map(([keystring, limiter]) => ({
    keystring,
    key_id: limiter._keyId,
    // Primary display value: Etsy's actual header when known. The local guard is
    // deliberately more conservative (4,900 safety cap + fulfilment reserve), so
    // keep it separate from the user's "how many Etsy calls are left?" number.
    remaining: limiter.serverRemaining !== null ? limiter.serverRemaining : limiter.remaining,
    guard_remaining: limiter.remaining,
    server_remaining: limiter.serverRemaining,
    max: PERSONAL_ACCESS_QPD,
    guard_max: QPD_SAFETY_BUFFER,
    percent_used: Math.max(0, Math.min(100, Math.round((1 - (limiter.serverRemaining !== null ? limiter.serverRemaining : limiter.remaining) / PERSONAL_ACCESS_QPD) * 100))),
    blocked_for_ms: limiter.blockedForMs,
    known: limiter.serverRemaining !== null,
    // History ring-buffer: last ≤50 budget snapshots from Etsy's x-remaining-today header.
    // Each entry: { ts (ms epoch), remaining, delta (calls consumed since previous snapshot; null for first) }.
    history: limiter._history.slice(),
  }));
}

/**
 * Update a shop's properties. Commonly used to set sale_message.
 * Scope: shops_w
 *
 * @param {import('axios').AxiosInstance} shopClient
 * @param {string|number} shopId
 * @param {object} fields - Partial shop fields to update (e.g. { sale_message: '...' })
 */
async function updateShop(shopClient, shopId, fields) {
  const numericId = await resolveShopId(shopClient, shopId);
  gateClient(shopClient);
  return withRetry(async () => {
    const { data } = await shopClient.put(`/application/shops/${numericId}`, fields);
    return data;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Bulk listing creation — form-encoded create, media upload, variation images
//
// Manual and bulk draft creation both delegate to the same documented
// application/x-www-form-urlencoded serializer. Image/video uploads use
// multipart/form-data; inventory remains JSON.
// ─────────────────────────────────────────────────────────────────────────────

// Listing fields that Etsy accepts as a single comma-separated string.
const _COMMA_ARRAY_FIELDS = new Set(['tags', 'materials', 'styles']);

/**
 * Serialise a listing payload to application/x-www-form-urlencoded.
 * - tags/materials/styles → comma-separated single value
 * - other arrays (e.g. production_partner_ids) → repeated keys
 * - booleans → "true"/"false"
 */
function _toFormUrlEncoded(body) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (_COMMA_ARRAY_FIELDS.has(key)) {
        if (value.length) params.append(key, value.join(','));
      } else {
        value.forEach((v) => { if (v !== undefined && v !== null) params.append(key, String(v)); });
      }
    } else if (typeof value === 'boolean') {
      params.append(key, value ? 'true' : 'false');
    } else {
      params.append(key, String(value));
    }
  }
  return params;
}

/**
 * POST /application/shops/{shop_id}/listings  (form-urlencoded)
 * Scope: listings_w
 *
 * Creates a physical draft listing using the spec-compliant encoding.
 *
 * @param {import('axios').AxiosInstance} shopClient
 * @param {string|number} shopId  numeric shop ID
 * @param {object} body           createDraftListing fields
 * @param {object} [opts]
 * @param {number} [opts.createdAfter] Epoch seconds used by retry reconciliation.
 * @param {Function|false} [opts.reconcile] Custom reconcile probe, or false to
 *        disable automatic recent-draft reconciliation.
 * @param {Function} [opts.acceptListing] Optional ownership predicate for
 *        rejecting a matching draft already claimed by another local item.
 */
async function createDraftListingForm(shopClient, shopId, body, opts = {}) {
  gateClient(shopClient);
  const params = _toFormUrlEncoded(body);
  const createdAfter = Number.isFinite(Number(opts.createdAfter))
    ? Number(opts.createdAfter)
    : Math.floor(Date.now() / 1000);
  const reconcile = opts.reconcile === false
    ? null
    : (typeof opts.reconcile === 'function'
        ? opts.reconcile
        : async () => {
            // Every retryable response is treated as potentially ambiguous,
            // including 429. If the limiter blocks this read probe, withRetry
            // fails closed rather than re-sending a create.
            const match = await findMatchingDraftListing(shopClient, shopId, body, {
              createdAfter,
              acceptListing: opts.acceptListing,
            });
            if (match) return match;
            const unknown = new Error(
              'Draft-create outcome is still ambiguous; refusing to re-send a non-idempotent POST.'
            );
            unknown.code = 'ETSY_CREATE_STATE_UNKNOWN';
            unknown.failClosed = true;
            throw unknown;
          });
  return withRetry(async () => {
    const { data } = await shopClient.post(
      `/application/shops/${shopId}/listings`,
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    return data;
  }, 3, { reconcile });
}

/**
 * POST /application/shops/{shop_id}/listings/{listing_id}/images  (multipart)
 * Scope: listings_w
 *
 * Uploads a single image to a listing at a given rank.
 *
 * @param {import('axios').AxiosInstance} shopClient
 * @param {string|number} shopId
 * @param {string|number} listingId
 * @param {object} opts
 * @param {Buffer} opts.buffer        raw image bytes
 * @param {string} opts.filename      original file name (used for content type)
 * @param {number} [opts.rank=1]      1-based display position
 * @param {string} [opts.altText]
 * @param {boolean} [opts.overwrite]
 */
async function uploadListingImage(shopClient, shopId, listingId, opts = {}) {
  gateClient(shopClient);
  // A ranked overwrite is replay-safe: a retry replaces that exact slot. An
  // append-style upload has no API idempotency key, so never re-send it after an
  // ambiguous transport failure.
  const maxRetries = opts.overwrite && opts.rank != null ? 3 : 1;
  return withRetry(async () => {
    const form = new FormData();
    form.append('image', opts.buffer, { filename: opts.filename || 'image.jpg' });
    if (opts.rank != null) form.append('rank', String(opts.rank));
    if (opts.altText) form.append('alt_text', String(opts.altText).slice(0, 500));
    if (opts.overwrite) form.append('overwrite', 'true');
    const { data } = await shopClient.post(
      `/application/shops/${shopId}/listings/${listingId}/images`,
      form,
      {
        headers: form.getHeaders(),
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 120_000,
      }
    );
    return data;
  }, maxRetries);
}

/**
 * POST /application/shops/{shop_id}/listings/{listing_id}/videos  (multipart)
 * Scope: listings_w
 *
 * @param {import('axios').AxiosInstance} shopClient
 * @param {string|number} shopId
 * @param {string|number} listingId
 * @param {object} opts
 * @param {Buffer} opts.buffer    raw video bytes
 * @param {string} opts.filename  video file name (Etsy requires the `name` field)
 */
async function uploadListingVideo(shopClient, shopId, listingId, opts = {}) {
  gateClient(shopClient);
  const baselineVideoIds = Array.isArray(opts.baselineVideoIds)
    ? new Set(opts.baselineVideoIds.map(String))
    : new Set(
        ((await getListingVideos(shopClient, listingId)).results || [])
          .map((video) => String(video.video_id ?? ''))
          .filter(Boolean)
      );
  const reconcile = async ({ error } = {}) => {
    const existing = await getListingVideos(shopClient, listingId);
    const uploaded = (existing.results || []).find((video) =>
      video.video_state !== 'deleted'
      && !baselineVideoIds.has(String(video.video_id ?? ''))
    ) || null;
    if (uploaded) return uploaded;
    const unknown = new Error(
      'Listing-video upload outcome is ambiguous; refusing to re-send the binary.'
    );
    unknown.code = 'ETSY_VIDEO_STATE_UNKNOWN';
    unknown.failClosed = true;
    unknown.responseStatus = error?.response?.status ?? null;
    throw unknown;
  };
  return withRetry(async () => {
    const form = new FormData();
    const filename = opts.filename || 'video.mp4';
    form.append('video', opts.buffer, { filename });
    form.append('name', filename);
    const { data } = await shopClient.post(
      `/application/shops/${shopId}/listings/${listingId}/videos`,
      form,
      {
        headers: form.getHeaders(),
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 300_000,
      }
    );
    return data;
  }, 3, { reconcile });
}

/** GET /application/listings/{listing_id}/videos — public read endpoint. */
async function getListingVideos(shopClient, listingId) {
  gateClient(shopClient);
  return withRetry(async () => {
    const { data } = await shopClient.get(`/application/listings/${listingId}/videos`);
    return data;
  });
}

/**
 * PUT /application/listings/{listing_id}/inventory  (raw body)
 * Scope: listings_w
 *
 * Sends a pre-built inventory body verbatim (after light normalisation). Unlike
 * updateListingInventory, this does NOT drop disabled offerings — required for
 * the bulk variation matrix where some styles are intentionally hidden.
 *
 * @param {import('axios').AxiosInstance} shopClient
 * @param {string|number} listingId
 * @param {object} body  { products, price_on_property, quantity_on_property, sku_on_property }
 */
async function putListingInventory(shopClient, listingId, body) {
  gateClient(shopClient);
  return withRetry(async () => {
    const { data } = await shopClient.put(`/application/listings/${listingId}/inventory`, body);
    return data;
  });
}

/**
 * POST /application/shops/{shop_id}/listings/{listing_id}/variation-images
 * Scope: listings_w
 *
 * Links uploaded images to specific variation values. Overwrites all existing
 * variation images on the listing.
 *
 * @param {import('axios').AxiosInstance} shopClient
 * @param {string|number} shopId
 * @param {string|number} listingId
 * @param {Array<{property_id:number,value_id:number,image_id:number}>} variationImages
 */
async function updateVariationImages(shopClient, shopId, listingId, variationImages) {
  gateClient(shopClient);
  return withRetry(async () => {
    const { data } = await shopClient.post(
      `/application/shops/${shopId}/listings/${listingId}/variation-images`,
      { variation_images: variationImages }
    );
    return data;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Shop-level settings used to populate listing references (read-only fetches)
// ─────────────────────────────────────────────────────────────────────────────

/** GET /application/shops/{shop_id}/shipping-profiles — scope shops_r */
async function getShopShippingProfiles(shopClient, shopId) {
  const numericId = await resolveShopId(shopClient, shopId);
  gateClient(shopClient);
  return withRetry(async () => {
    const { data } = await shopClient.get(`/application/shops/${numericId}/shipping-profiles`);
    return data;
  });
}

/** GET /application/shops/{shop_id}/policies/return — scope none */
async function getShopReturnPolicies(shopClient, shopId) {
  const numericId = await resolveShopId(shopClient, shopId);
  gateClient(shopClient);
  return withRetry(async () => {
    const { data } = await shopClient.get(`/application/shops/${numericId}/policies/return`);
    return data;
  });
}

/** GET /application/shops/{shop_id}/production-partners — scope shops_r */
async function getShopProductionPartners(shopClient, shopId) {
  const numericId = await resolveShopId(shopClient, shopId);
  gateClient(shopClient);
  return withRetry(async () => {
    const { data } = await shopClient.get(`/application/shops/${numericId}/production-partners`);
    return data;
  });
}

/** GET /application/shops/{shop_id}/sections — scope none */
async function getShopSections(shopClient, shopId) {
  const numericId = await resolveShopId(shopClient, shopId);
  gateClient(shopClient);
  return withRetry(async () => {
    const { data } = await shopClient.get(`/application/shops/${numericId}/sections`);
    return data;
  });
}

/** GET /application/shops/{shop_id}/sections/{shop_section_id} — scope none */
async function getShopSection(shopClient, shopId, sectionId) {
  const numericId = await resolveShopId(shopClient, shopId);
  gateClient(shopClient);
  return withRetry(async () => {
    const { data } = await shopClient.get(`/application/shops/${numericId}/sections/${sectionId}`);
    return data;
  });
}

/**
 * POST /application/shops/{shop_id}/sections — scope shops_w
 * Creates a new shop section. Etsy accepts a single `title` field, sent as
 * application/x-www-form-urlencoded, and returns the created ShopSection.
 * @returns {Promise<object>} the created ShopSection (with shop_section_id, rank…)
 */
async function createShopSection(shopClient, shopId, { title } = {}) {
  const numericId = await resolveShopId(shopClient, shopId);
  gateClient(shopClient);

  // Creating a section is not idempotent (Etsy allows same-titled sections). On a
  // retry, probe existing sections and adopt the one with this title rather than
  // leaving a duplicate section on the public shop if the first POST landed but
  // its response was lost in transit.
  const wantTitle = String(title ?? '').trim();
  const before = wantTitle ? await getShopSections(shopClient, numericId) : null;
  const baselineIds = new Set(
    (Array.isArray(before?.results) ? before.results : [])
      .map((section) => String(section?.shop_section_id ?? ''))
      .filter(Boolean)
  );
  const reconcile = wantTitle
    ? async () => {
        const data = await getShopSections(shopClient, numericId);
        const results = Array.isArray(data?.results) ? data.results : [];
        const created = results.find((section) =>
          String(section?.title ?? '').trim() === wantTitle
          && !baselineIds.has(String(section?.shop_section_id ?? ''))
        ) || null;
        if (created) return created;
        const unknown = new Error(
          'Shop-section create outcome is ambiguous; refusing to create a duplicate.'
        );
        unknown.code = 'ETSY_SECTION_STATE_UNKNOWN';
        unknown.failClosed = true;
        throw unknown;
      }
    : null;

  return withRetry(async () => {
    const params = new URLSearchParams();
    params.append('title', String(title ?? ''));
    const { data } = await shopClient.post(
      `/application/shops/${numericId}/sections`,
      params,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );
    return data;
  }, 3, { reconcile });
}

/**
 * PUT /application/shops/{shop_id}/sections/{shop_section_id} — scope shops_w
 * Renames an existing shop section. Returns the updated ShopSection.
 */
async function updateShopSection(shopClient, shopId, sectionId, { title } = {}) {
  const numericId = await resolveShopId(shopClient, shopId);
  gateClient(shopClient);
  return withRetry(async () => {
    const params = new URLSearchParams();
    params.append('title', String(title ?? ''));
    const { data } = await shopClient.put(
      `/application/shops/${numericId}/sections/${sectionId}`,
      params,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );
    return data;
  });
}

/**
 * DELETE /application/shops/{shop_id}/sections/{shop_section_id} — scope shops_w
 * Deletes a shop section. Etsy returns 204 No Content on success. Listings that
 * were in the section are not deleted; they simply become unsectioned.
 */
async function deleteShopSection(shopClient, shopId, sectionId) {
  const numericId = await resolveShopId(shopClient, shopId);
  gateClient(shopClient);
  return withRetry(async () => {
    await shopClient.delete(`/application/shops/${numericId}/sections/${sectionId}`);
    return true;
  });
}

/**
 * GET /application/shops/{shop_id}/readiness-state-definitions — scope shops_r
 * Returns the shop's processing profiles. Every physical listing requires a
 * readiness_state_id (Etsy made this mandatory in 2025); the id to send on
 * createDraftListing / inventory offerings is the definition's id.
 */
async function getShopReadinessStateDefinitions(shopClient, shopId) {
  const numericId = await resolveShopId(shopClient, shopId);
  gateClient(shopClient);
  return withRetry(async () => {
    const { data } = await shopClient.get(`/application/shops/${numericId}/readiness-state-definitions`);
    return data;
  });
}

/**
 * POST /application/shops/{shop_id}/readiness-state-definitions — scope shops_w
 * Creates a processing profile. Used as a fallback when a shop has none, so we
 * can satisfy Etsy's mandatory readiness_state_id on physical listings.
 * @returns the created definition (with its id)
 */
async function createShopReadinessStateDefinition(shopClient, shopId, {
  readiness_state = 'made_to_order', min_processing_time = 3, max_processing_time = 5, processing_time_unit = 'days',
} = {}) {
  const numericId = await resolveShopId(shopClient, shopId);
  gateClient(shopClient);
  const before = await getShopReadinessStateDefinitions(shopClient, numericId);
  const baselineIds = new Set(
    (Array.isArray(before?.results) ? before.results : [])
      .map((profile) => String(profile?.readiness_state_id ?? ''))
      .filter(Boolean)
  );
  const reconcile = async () => {
    const current = await getShopReadinessStateDefinitions(shopClient, numericId);
    const created = (Array.isArray(current?.results) ? current.results : [])
      .find((profile) =>
        !baselineIds.has(String(profile?.readiness_state_id ?? ''))
        && profile?.readiness_state === readiness_state
        && Number(profile?.min_processing_days) === Number(min_processing_time)
        && Number(profile?.max_processing_days) === Number(max_processing_time)
      ) || null;
    if (created) return created;
    const unknown = new Error(
      'Processing-profile create outcome is ambiguous; refusing to create a duplicate.'
    );
    unknown.code = 'ETSY_READINESS_STATE_UNKNOWN';
    unknown.failClosed = true;
    throw unknown;
  };
  return withRetry(async () => {
    const params = new URLSearchParams();
    params.append('readiness_state', readiness_state);
    params.append('min_processing_time', String(min_processing_time));
    params.append('max_processing_time', String(max_processing_time));
    params.append('processing_time_unit', processing_time_unit);
    const { data } = await shopClient.post(
      `/application/shops/${numericId}/readiness-state-definitions`,
      params,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );
    return data;
  }, 3, { reconcile });
}

// ─────────────────────────────────────────────────────────────────────────────
// Seller taxonomy — resolve a numeric taxonomy_id for listing creation.
// The full node tree rarely changes, so it is cached process-wide.
// ─────────────────────────────────────────────────────────────────────────────

let _taxonomyNodesCache = null;

/** GET /application/seller-taxonomy/nodes — scope none */
async function getSellerTaxonomyNodes(shopClient) {
  if (_taxonomyNodesCache) return _taxonomyNodesCache;
  gateClient(shopClient);
  const data = await withRetry(async () => {
    const res = await shopClient.get('/application/seller-taxonomy/nodes');
    return res.data;
  });
  _taxonomyNodesCache = data;
  return data;
}

// Taxonomy attribute (property) definitions per taxonomy_id. These define the
// "feature section" fields (Theme, Occasion, Pattern, colours, etc.) and rarely
// change, so we cache them process-wide per taxonomy.
const _taxonomyPropsCache = new Map();

/** GET /application/seller-taxonomy/nodes/{taxonomy_id}/properties — scope none */
async function getPropertiesByTaxonomyId(shopClient, taxonomyId) {
  const key = String(taxonomyId);
  if (_taxonomyPropsCache.has(key)) return _taxonomyPropsCache.get(key);
  gateClient(shopClient);
  const data = await withRetry(async () => {
    const res = await shopClient.get(`/application/seller-taxonomy/nodes/${taxonomyId}/properties`);
    return res.data;
  });
  _taxonomyPropsCache.set(key, data);
  return data;
}

/**
 * PUT /application/shops/{shop_id}/listings/{listing_id}/properties/{property_id}
 * Scope: listings_w — sets a single listing attribute (taxonomy property).
 * @param {object} body  { value_ids?:number[], values?:string[], scale_id?:number }
 */
async function updateListingProperty(shopClient, shopId, listingId, propertyId, body) {
  const numericId = await resolveShopId(shopClient, shopId);
  gateClient(shopClient);
  return withRetry(async () => {
    const { data } = await shopClient.put(
      `/application/shops/${numericId}/listings/${listingId}/properties/${propertyId}`,
      body,
    );
    return data;
  });
}

/**
 * Resolve the deepest taxonomy node whose full path matches all keywords.
 * Returns the numeric taxonomy_id or null.
 *
 * @param {import('axios').AxiosInstance} shopClient
 * @param {string[]} keywords  lowercase substrings that must all appear in the node name/path
 */
async function findTaxonomyId(shopClient, keywords) {
  const wanted = keywords.map((k) => k.toLowerCase());
  const data = await getSellerTaxonomyNodes(shopClient);
  let best = null;

  const visit = (node, trail) => {
    const name = (node.name || '').toLowerCase();
    const path = `${trail} ${name}`.trim();
    if (wanted.every((w) => path.includes(w))) {
      // Prefer the deepest (most specific) match.
      if (!best || path.length > best.path.length) {
        best = { id: node.id, path };
      }
    }
    for (const child of node.children || []) visit(child, path);
  };

  for (const root of data.results || []) visit(root, '');
  return best ? best.id : null;
}

module.exports = {
  buildShopClient,
  attachRateLimitInterceptor,
  resolveShopId,
  getShop,
  updateShop,
  createDraftListingForm,
  findMatchingDraftListing,
  uploadListingImage,
  uploadListingVideo,
  getListingVideos,
  putListingInventory,
  updateVariationImages,
  getListingVariationImages,
  getShopShippingProfiles,
  getShopReturnPolicies,
  getShopProductionPartners,
  getShopReadinessStateDefinitions,
  createShopReadinessStateDefinition,
  getShopSections,
  getShopSection,
  createShopSection,
  updateShopSection,
  deleteShopSection,
  getSellerTaxonomyNodes,
  getPropertiesByTaxonomyId,
  updateListingProperty,
  findTaxonomyId,
  getReceipts,
  getReceipt,
  createReceiptShipment,
  paginateReceipts,
  getReceiptTransactions,
  paginateLedgerEntries,
  getPaymentReceiptMap,
  getListingImagesBatch,
  getListingImageCatalogBatch,
  getActiveListings,
  paginateListings,
  getListingsCountByState,
  paginateReviewsByShop,
  updateListing,
  createDraftListing,
  deleteListing,
  getListingInventory,
  updateListingInventory,
  ping,
  pingShop,
  getRemainingBudget,
  getBudgetSnapshots,
  RateLimiter,
  QpdExhaustedError,
  isQpdExhaustedError,
  PERSONAL_ACCESS_QPD,
  withRetry,
  normalizeEtsySortOrder,
};
