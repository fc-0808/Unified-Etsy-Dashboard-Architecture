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
 * Shops per key varies: up to 5 on proxied keys, 1 on the direct key (CuteCasesOnly).
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

  getRateLimiter(shopClient).check();
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
      // CORRECT FORMAT: keystring:shared_secret (both required per Etsy API docs)
      'x-api-key':    `${apiKey}:${sharedSecret}`,
      // CORRECT FORMAT: Bearer numeric_user_id.oauth_token
      Authorization:  `Bearer ${accessToken}`,
    },
  });
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
  const numericId = await resolveShopId(shopClient, shopId);
  getRateLimiter(shopClient).check();
  return withRetry(async () => {
    const { data } = await shopClient.get(`/application/shops/${numericId}`);
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
  const numericId = await resolveShopId(shopClient, shopId);
  getRateLimiter(shopClient).check();

  const params = {
    limit: Math.min(options.limit ?? 100, 100),
    offset: options.offset ?? 0,
    sort_on: options.sort_on ?? 'created',
    sort_order: options.sort_order ?? 'desc',
  };
  if (options.was_paid     !== undefined) params.was_paid           = options.was_paid;
  if (options.was_shipped  !== undefined) params.was_shipped        = options.was_shipped;
  if (options.min_created)               params.min_created         = options.min_created;
  if (options.min_last_modified)         params.min_last_modified   = options.min_last_modified;
  if (options.sort_on)                   params.sort_on             = options.sort_on;
  if (options.sort_order)                params.sort_order          = options.sort_order;

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
  getRateLimiter(shopClient).check();
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
  getRateLimiter(shopClient).check();
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
  getRateLimiter(shopClient).check();
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

/**
 * GET /application/shops/{shop_id}/listings
 * Scope: listings_r
 *
 * Returns all listings for a shop (any state). Paginates automatically.
 * @param {import('axios').AxiosInstance} shopClient
 * @param {string|number} shopId - numeric shop ID
 * @param {object} [opts]
 * @param {'active'|'inactive'|'draft'|'sold_out'|'expired'|'all'} [opts.state]
 * @yields {object[]} batches of listing objects
 */
async function* paginateListings(shopClient, shopId, opts = {}) {
  const { state = 'active' } = opts;
  let offset = 0;
  const limit = 100;
  while (true) {
    getRateLimiter(shopClient).check();
    const { data } = await withRetry(() =>
      shopClient.get(`/application/shops/${shopId}/listings`, {
        params: { limit, offset, state, includes: 'Images', sort_on: 'updated', sort_order: 'desc' },
      })
    );
    const listings = data.results ?? data.listings ?? [];
    if (!listings.length) break;
    yield listings;
    if (listings.length < limit) break;
    offset += limit;
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
  getRateLimiter(shopClient).check();
  return withRetry(async () => {
    const { data } = await shopClient.patch(
      `/application/shops/${shopId}/listings/${listingId}`,
      fields
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
  getRateLimiter(shopClient).check();
  return withRetry(async () => {
    const { data } = await shopClient.post(`/application/shops/${shopId}/listings`, body);
    return data;
  });
}

/**
 * DELETE /application/listings/{listing_id}
 * Scope: listings_d
 */
async function deleteListing(shopClient, listingId) {
  getRateLimiter(shopClient).check();
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
 * @param {number}  [opts.ship_date]    - Unix epoch seconds; defaults to today
 */
async function createReceiptShipment(shopClient, shopId, receiptId, opts = {}) {
  getRateLimiter(shopClient).check();
  return withRetry(async () => {
    const body = {
      tracking_code:  opts.tracking_code,
      carrier_name:   opts.carrier_name || '4PX',
      send_bcc:       opts.send_bcc ?? false,
    };
    if (opts.note_to_buyer) body.note_to_buyer = opts.note_to_buyer;
    if (opts.ship_date)     body.ship_date     = opts.ship_date;
    const { data } = await shopClient.post(
      `/application/shops/${shopId}/receipts/${receiptId}/tracking`,
      body
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
  getRateLimiter(shopClient).check();
  return withRetry(async () => {
    const { data } = await shopClient.get(
      `/application/shops/${numericId}/receipts/${receiptId}/transactions`
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
  const numericId = await resolveShopId(shopClient, shopId);
  getRateLimiter(shopClient).check();
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
 * Fetch the primary thumbnail URL for up to 100 listing IDs in one API call.
 * Uses GET /application/listings/batch?listing_ids[]=…&includes[]=Images
 *
 * Returns a Map<number, string> of listing_id → image URL.
 * Missing/inactive listings are silently omitted from the result.
 *
 * @param {import('axios').AxiosInstance} shopClient
 * @param {number[]} listingIds
 * @returns {Promise<Map<number, string>>}
 */
async function getListingImagesBatch(shopClient, listingIds) {
  const unique = [...new Set(listingIds.map(Number))].filter(Boolean);
  if (!unique.length) return new Map();

  // Etsy batch endpoint accepts up to 100 IDs per request
  const chunks = [];
  for (let i = 0; i < unique.length; i += 100) chunks.push(unique.slice(i, i + 100));

  const result = new Map();

  for (const chunk of chunks) {
    getRateLimiter(shopClient).check();
    try {
      await withRetry(async () => {
        // Build URLSearchParams manually so repeated keys are serialised correctly:
        // listing_ids[]=1&listing_ids[]=2&includes[]=Images
        const params = new URLSearchParams();
        chunk.forEach((id) => params.append('listing_ids[]', id));
        params.append('includes[]', 'Images');

        const { data } = await shopClient.get('/application/listings/batch', { params });
        for (const listing of (data.results ?? [])) {
          const img = listing.images?.[0];
          if (img) {
            const url = img.url_570xN ?? img.url_fullxfull ?? img.url_170x135 ?? null;
            if (url) result.set(listing.listing_id, url);
          }
        }
      });
    } catch (err) {
      // Non-fatal — images are cosmetic; log and continue
      console.warn(`[etsy/client] getListingImagesBatch failed for chunk: ${err.message}`);
    }

    if (chunks.length > 1) await new Promise((r) => setTimeout(r, 300));
  }

  return result;
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
 * Update a shop's properties. Commonly used to set sale_message.
 * Scope: shops_w
 *
 * @param {import('axios').AxiosInstance} shopClient
 * @param {string|number} shopId
 * @param {object} fields - Partial shop fields to update (e.g. { sale_message: '...' })
 */
async function updateShop(shopClient, shopId, fields) {
  const numericId = await resolveShopId(shopClient, shopId);
  getRateLimiter(shopClient).check();
  return withRetry(async () => {
    const { data } = await shopClient.put(`/application/shops/${numericId}`, fields);
    return data;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversations — undocumented Etsy v3 internal endpoints
//
// Etsy's public v3 API does not expose conversation/messaging endpoints.
// However, Etsy's own web app (etsy.com/your/messages) calls private v3
// endpoints that are accessible with valid OAuth tokens carrying the
// conversations_r / conversations_w scopes.
//
// IMPORTANT: These endpoints are NOT in the public OpenAPI spec. They may
// change without notice. All methods include explicit 403/404 error handling
// so a missing scope or endpoint removal degrades gracefully without crashing
// the rest of the sync pipeline.
//
// Required OAuth access: standard auth token (no special scope needed for these
// internal endpoints — Etsy does not expose conversation scopes publicly).
// The endpoints work when Etsy's web app session is replicated via OAuth token,
// but may return 403 if Etsy restricts access to third-party keys.
// All methods handle 403/404 gracefully and log a clear warning.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List conversation threads for a shop.
 * GET /v3/application/shops/{shop_id}/conversations
 * Scope: conversations_r
 *
 * @param {import('axios').AxiosInstance} shopClient
 * @param {string|number} shopId
 * @param {object} [options]
 * @param {number} [options.limit=25]
 * @param {number} [options.offset=0]
 * @returns {Promise<{ count: number, results: object[] }>}
 */
async function getConversations(shopClient, shopId, options = {}) {
  const numericId = await resolveShopId(shopClient, shopId);
  getRateLimiter(shopClient).check();
  return withRetry(async () => {
    const { data } = await shopClient.get(
      `/application/shops/${numericId}/conversations`,
      { params: { limit: options.limit ?? 25, offset: options.offset ?? 0 } }
    );
    return data;
  });
}

/**
 * Get a single conversation thread with all its messages.
 * GET /v3/application/shops/{shop_id}/conversations/{convo_id}
 * Scope: conversations_r
 *
 * @param {import('axios').AxiosInstance} shopClient
 * @param {string|number} shopId
 * @param {string|number} convoId
 */
async function getConversation(shopClient, shopId, convoId) {
  const numericId = await resolveShopId(shopClient, shopId);
  getRateLimiter(shopClient).check();
  return withRetry(async () => {
    const { data } = await shopClient.get(
      `/application/shops/${numericId}/conversations/${convoId}`
    );
    return data;
  });
}

/**
 * Send a reply to a conversation thread.
 * POST /v3/application/shops/{shop_id}/conversations/{convo_id}
 * Scope: conversations_w
 *
 * @param {import('axios').AxiosInstance} shopClient
 * @param {string|number} shopId
 * @param {string|number} convoId
 * @param {string} messageBody  - Plain text message content
 */
async function replyToConversation(shopClient, shopId, convoId, messageBody) {
  const numericId = await resolveShopId(shopClient, shopId);
  getRateLimiter(shopClient).check();
  return withRetry(async () => {
    const { data } = await shopClient.post(
      `/application/shops/${numericId}/conversations/${convoId}`,
      { message: messageBody }
    );
    return data;
  });
}

/**
 * Mark a conversation as read on Etsy.
 * PUT /v3/application/shops/{shop_id}/conversations/{convo_id}
 * Scope: conversations_w
 *
 * @param {import('axios').AxiosInstance} shopClient
 * @param {string|number} shopId
 * @param {string|number} convoId
 */
async function markConversationReadOnEtsy(shopClient, shopId, convoId) {
  const numericId = await resolveShopId(shopClient, shopId);
  getRateLimiter(shopClient).check();
  return withRetry(async () => {
    const { data } = await shopClient.put(
      `/application/shops/${numericId}/conversations/${convoId}`,
      { is_read: true }
    );
    return data;
  });
}

/**
 * Async generator: paginate all conversations for a shop.
 * Yields batches of conversation objects.
 *
 * @param {import('axios').AxiosInstance} shopClient
 * @param {string|number} shopId
 * @param {object} [opts]
 * @param {number} [opts.maxTotal=100]
 */
async function* paginateConversations(shopClient, shopId, opts = {}) {
  const limit    = 25;
  const maxTotal = opts.maxTotal ?? 100;
  let offset     = 0;
  let fetched    = 0;

  while (fetched < maxTotal) {
    const page = await getConversations(shopClient, shopId, { limit, offset });
    const results = page.results ?? [];
    if (!results.length) break;
    yield results;
    fetched += results.length;
    offset  += results.length;
    if (results.length < limit) break;
    await new Promise((r) => setTimeout(r, 300));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bulk listing creation — form-encoded create, media upload, variation images
//
// createDraftListing (above) posts JSON, which works for the simple single-
// variation create used by the dashboard's manual form. The Etsy spec, however,
// declares the create body as application/x-www-form-urlencoded and the image/
// video uploads as multipart/form-data. The bulk pipeline uses the dedicated
// helpers below to exactly match the spec (array fields, binary uploads).
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
 * Creates a physical draft listing using the spec-compliant encoding. Pass
 * { legacy: true } in opts to enable processing-profile related fields.
 *
 * @param {import('axios').AxiosInstance} shopClient
 * @param {string|number} shopId  numeric shop ID
 * @param {object} body           createDraftListing fields
 * @param {object} [opts]
 * @param {boolean} [opts.legacy]
 */
async function createDraftListingForm(shopClient, shopId, body, opts = {}) {
  getRateLimiter(shopClient).check();
  const params = _toFormUrlEncoded(body);
  const query = opts.legacy ? '?legacy=true' : '';
  return withRetry(async () => {
    const { data } = await shopClient.post(
      `/application/shops/${shopId}/listings${query}`,
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    return data;
  });
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
  getRateLimiter(shopClient).check();
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
  });
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
  getRateLimiter(shopClient).check();
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
  getRateLimiter(shopClient).check();
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
  getRateLimiter(shopClient).check();
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
  getRateLimiter(shopClient).check();
  return withRetry(async () => {
    const { data } = await shopClient.get(`/application/shops/${numericId}/shipping-profiles`);
    return data;
  });
}

/** GET /application/shops/{shop_id}/policies/return — scope none */
async function getShopReturnPolicies(shopClient, shopId) {
  const numericId = await resolveShopId(shopClient, shopId);
  getRateLimiter(shopClient).check();
  return withRetry(async () => {
    const { data } = await shopClient.get(`/application/shops/${numericId}/policies/return`);
    return data;
  });
}

/** GET /application/shops/{shop_id}/production-partners — scope shops_r */
async function getShopProductionPartners(shopClient, shopId) {
  const numericId = await resolveShopId(shopClient, shopId);
  getRateLimiter(shopClient).check();
  return withRetry(async () => {
    const { data } = await shopClient.get(`/application/shops/${numericId}/production-partners`);
    return data;
  });
}

/** GET /application/shops/{shop_id}/sections — scope none */
async function getShopSections(shopClient, shopId) {
  const numericId = await resolveShopId(shopClient, shopId);
  getRateLimiter(shopClient).check();
  return withRetry(async () => {
    const { data } = await shopClient.get(`/application/shops/${numericId}/sections`);
    return data;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Seller taxonomy — resolve a numeric taxonomy_id for listing creation.
// The full node tree rarely changes, so it is cached process-wide.
// ─────────────────────────────────────────────────────────────────────────────

let _taxonomyNodesCache = null;

/** GET /application/seller-taxonomy/nodes — scope none */
async function getSellerTaxonomyNodes(shopClient) {
  if (_taxonomyNodesCache) return _taxonomyNodesCache;
  getRateLimiter(shopClient).check();
  const data = await withRetry(async () => {
    const res = await shopClient.get('/application/seller-taxonomy/nodes');
    return res.data;
  });
  _taxonomyNodesCache = data;
  return data;
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
  uploadListingImage,
  uploadListingVideo,
  putListingInventory,
  updateVariationImages,
  getShopShippingProfiles,
  getShopReturnPolicies,
  getShopProductionPartners,
  getShopSections,
  getSellerTaxonomyNodes,
  findTaxonomyId,
  getReceipts,
  getReceipt,
  createReceiptShipment,
  paginateReceipts,
  getReceiptTransactions,
  getListingImagesBatch,
  getActiveListings,
  paginateListings,
  updateListing,
  createDraftListing,
  deleteListing,
  getListingInventory,
  updateListingInventory,
  ping,
  pingShop,
  getRemainingBudget,
  RateLimiter,
  PERSONAL_ACCESS_QPD,
  // Conversations (undocumented Etsy internal API)
  getConversations,
  getConversation,
  replyToConversation,
  markConversationReadOnEtsy,
  paginateConversations,
};
