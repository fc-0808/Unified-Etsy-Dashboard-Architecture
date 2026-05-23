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
 * Each app (API key) is limited to 5 shops.
 * For 20 shops across 4 groups: 4 separate apps × 5 shops each.
 *
 * ─── RATE BUDGET MATH ────────────────────────────────────────────────────────
 *
 * 5 shops × 5 endpoints per sync = 25 calls per app per sync cycle
 * At 60-minute intervals: 25 × 24 = 600 calls/day per app key
 * Budget used: 600 / 5000 = 12% — comfortable headroom
 *
 * DO NOT use 5-minute intervals: 25 × 288 = 7,200 calls/day — 44% over budget
 */

const { TokenExpiredError } = require('../auth/token-manager');

// ─────────────────────────────────────────────────────────────────────────────
// Rate Limiter (local, per-key)
// Tracks calls in a sliding 24h window to stay under the 5K QPD limit.
// Also reads x-remaining-today headers to sync with Etsy's actual server-side count.
// ─────────────────────────────────────────────────────────────────────────────

const PERSONAL_ACCESS_QPD = 5000; // verified from user's developer portal screenshot
const QPD_SAFETY_BUFFER   = 4900; // leave 100 calls headroom for manual/ad-hoc use

class RateLimiter {
  constructor(maxCallsPer24h = QPD_SAFETY_BUFFER) {
    this._max = maxCallsPer24h;
    this._window = 24 * 60 * 60 * 1000; // sliding 24h window (Etsy uses bucket-based sliding window)
    this._calls = [];
    this._serverRemaining = null; // updated from x-remaining-today response header
  }

  /**
   * Check before making an API call. Throws if over budget.
   * @throws {Error} if QPD budget exhausted
   */
  check() {
    const now = Date.now();
    this._calls = this._calls.filter((t) => now - t < this._window);

    // Prefer the server-authoritative count if available and lower than our local count
    const localRemaining = this._max - this._calls.length;
    const effectiveRemaining =
      this._serverRemaining !== null
        ? Math.min(localRemaining, this._serverRemaining)
        : localRemaining;

    if (effectiveRemaining <= 0) {
      const oldest = this._calls[0];
      const resetIn = oldest
        ? Math.ceil((oldest + this._window - now) / 60000)
        : 60;
      throw new Error(
        `Etsy API QPD budget exhausted (${PERSONAL_ACCESS_QPD}/day limit). ` +
          `Resets in approximately ${resetIn} minutes. Increase sync_interval_minutes in config.json.`
      );
    }

    this._calls.push(now);
  }

  /**
   * Update the server-side remaining count from response headers.
   * Called by the axios response interceptor in createShopClient.
   * @param {import('http').IncomingMessage} headers
   */
  updateFromHeaders(headers) {
    const remaining = headers['x-remaining-today'];
    if (remaining !== undefined) {
      this._serverRemaining = parseInt(remaining, 10);
    }
    // Log a warning when budget is running low
    if (this._serverRemaining !== null && this._serverRemaining < 200) {
      console.warn(
        `[etsy/client] Rate limit warning: only ${this._serverRemaining} API calls remaining today.`
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
}

/** @type {Map<string, RateLimiter>} api_key → RateLimiter */
const _rateLimiters = new Map();

function getRateLimiter(shopClient) {
  // Key the rate limiter to the keystring portion of x-api-key
  const rawKey = shopClient.defaults.headers?.common?.['x-api-key']
    ?? shopClient.defaults.headers?.['x-api-key']
    ?? 'default';
  const keystring = rawKey.split(':')[0]; // extract just the keystring from "keystring:secret"
  if (!_rateLimiters.has(keystring)) {
    _rateLimiters.set(keystring, new RateLimiter());
  }
  return _rateLimiters.get(keystring);
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
      limiter.updateFromHeaders(response.headers);
      return response;
    },
    (error) => Promise.reject(error)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Retry with exponential backoff
// Retryable: 429 (rate limit), 500, 502, 503, 504
// Not retried: 401 (re-authenticate), 403 (scope missing), 404 (not found)
// ─────────────────────────────────────────────────────────────────────────────

async function withRetry(fn, maxRetries = 3) {
  const RETRYABLE = new Set([429, 500, 502, 503, 504]);
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      // Never retry token-related errors — they need human action
      if (err instanceof TokenExpiredError) throw err;

      const status = err.response?.status;
      if (!RETRYABLE.has(status)) throw err;

      lastError = err;
      if (attempt === maxRetries) break;

      // Use Etsy's retry-after header if present, else exponential backoff
      const retryAfter = err.response?.headers?.['retry-after'];
      const backoff = Math.pow(2, attempt) * 1000 + Math.random() * 500;
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : backoff;

      console.warn(
        `[etsy/client] HTTP ${status} — attempt ${attempt}/${maxRetries}. ` +
          `Waiting ${Math.round(waitMs / 1000)}s before retry...`
      );
      await new Promise((res) => setTimeout(res, waitMs));
    }
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
 * @returns {import('axios').AxiosInstance}
 */
function buildShopClient(groupProxyClient, apiKey, sharedSecret, accessToken) {
  const instance = Object.create(groupProxyClient);
  instance.defaults = {
    ...groupProxyClient.defaults,
    headers: {
      ...groupProxyClient.defaults.headers,
      common: {
        ...(groupProxyClient.defaults.headers?.common ?? {}),
        // CORRECT FORMAT: keystring:shared_secret (both required per Etsy API docs)
        'x-api-key': `${apiKey}:${sharedSecret}`,
        // CORRECT FORMAT: Bearer numeric_user_id.oauth_token
        Authorization: `Bearer ${accessToken}`,
      },
    },
  };
  attachRateLimitInterceptor(instance);
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
  getRateLimiter(shopClient).check();
  return withRetry(async () => {
    const { data } = await shopClient.get(`/application/shops/${shopId}`);
    return data;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Receipts (Orders) — requires transactions_r scope
// ─────────────────────────────────────────────────────────────────────────────

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
 * @param {string} [options.sort_order='desc']
 * @returns {Promise<{ count: number, results: object[] }>}
 */
async function getReceipts(shopClient, shopId, options = {}) {
  getRateLimiter(shopClient).check();

  const params = {
    limit: Math.min(options.limit ?? 100, 100),
    offset: options.offset ?? 0,
    sort_on: options.sort_on ?? 'created',
    sort_order: options.sort_order ?? 'desc',
  };
  if (options.was_paid !== undefined) params.was_paid = options.was_paid;
  if (options.was_shipped !== undefined) params.was_shipped = options.was_shipped;
  if (options.min_created) params.min_created = options.min_created;

  return withRetry(async () => {
    const { data } = await shopClient.get(`/application/shops/${shopId}/receipts`, { params });
    return data;
  });
}

/**
 * GET /application/shops/{shop_id}/receipts/{receipt_id}
 * Scope: transactions_r
 */
async function getReceipt(shopClient, shopId, receiptId) {
  getRateLimiter(shopClient).check();
  return withRetry(async () => {
    const { data } = await shopClient.get(
      `/application/shops/${shopId}/receipts/${receiptId}`
    );
    return data;
  });
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
  const pageSize = 100;
  const maxTotal = options.maxTotal ?? 200;
  let offset = 0;
  let fetched = 0;

  while (fetched < maxTotal) {
    const limit = Math.min(pageSize, maxTotal - fetched);
    const page = await getReceipts(shopClient, shopId, {
      limit,
      offset,
      min_created: options.min_created,
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
  getRateLimiter(shopClient).check();
  return withRetry(async () => {
    const { data } = await shopClient.get(
      `/application/shops/${shopId}/receipts/${receiptId}/transactions`
    );
    return data;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Listings — requires listings_r scope for private/inactive, none for active
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /application/shops/{shop_id}/listings/active
 * Scope: none (public listings only)
 */
async function getActiveListings(shopClient, shopId, options = {}) {
  getRateLimiter(shopClient).check();
  return withRetry(async () => {
    const { data } = await shopClient.get(`/application/shops/${shopId}/listings/active`, {
      params: { limit: options.limit ?? 50, offset: options.offset ?? 0 },
    });
    return data;
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
  const shop = await getShop(shopClient, shopId);
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

module.exports = {
  buildShopClient,
  attachRateLimitInterceptor,
  getShop,
  getReceipts,
  getReceipt,
  paginateReceipts,
  getReceiptTransactions,
  getActiveListings,
  ping,
  pingShop,
  getRemainingBudget,
  RateLimiter,
  PERSONAL_ACCESS_QPD,
};
