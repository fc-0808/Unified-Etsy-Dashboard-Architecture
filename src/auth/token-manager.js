'use strict';

/**
 * Etsy OAuth 2.0 Token Manager
 *
 * CRITICAL CONTEXT: Etsy OAuth access tokens expire in exactly 3600 seconds (1 hour).
 * This is NOT a static Personal Access Token. It is a time-limited bearer token.
 *
 * Flow:
 *   1. First run: use scripts/oauth-setup.js to complete the OAuth flow per shop.
 *      This saves access_token + refresh_token to tokens.json.
 *   2. On every API call: TokenManager checks if the access_token is expired.
 *   3. If expired (or within 5-min buffer): uses refresh_token to get a new access_token.
 *   4. Etsy returns a new refresh_token with every refresh — it is saved back to tokens.json.
 *   5. Refresh tokens expire after 90 days. If expired, re-run oauth-setup.js for that shop.
 *
 * Token format from Etsy:
 *   access_token:  "12345678.VJTv9qyjwJbYlARxdFmEEQ"  (numeric_user_id.token)
 *   refresh_token: "12345678.JNGIJtvLm..."              (numeric_user_id.refresh_token)
 *
 * tokens.json is gitignored and stored separately from config.json.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const ETSY_TOKEN_URL = 'https://api.etsy.com/v3/public/oauth/token';
const ACCESS_TOKEN_TTL_MS = 3600 * 1000;        // 1 hour (as documented)
const REFRESH_BUFFER_MS  = 5 * 60 * 1000;       // refresh 5 minutes before expiry
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 3600 * 1000; // 90 days (documented)

/**
 * @typedef {object} ShopTokens
 * @property {string}  access_token          - Current OAuth bearer token (expires in 1h)
 * @property {string}  refresh_token         - Long-lived refresh token (expires in 90 days)
 * @property {number}  access_token_expires_at  - Unix ms timestamp when access_token expires
 * @property {number}  refresh_token_obtained_at - Unix ms timestamp when refresh_token was obtained
 */

class TokenManager {
  /**
   * @param {string} tokensFilePath - Absolute path to tokens.json (gitignored)
   */
  constructor(tokensFilePath) {
    this._path = tokensFilePath;
    /** @type {Record<string, ShopTokens>} shop_id → tokens */
    this._store = {};
    /** @type {Map<string, Promise<string>>} shop_id → in-flight refresh (dedupe) */
    this._refreshing = new Map();
    this._load();
  }

  _load() {
    if (fs.existsSync(this._path)) {
      try {
        this._store = JSON.parse(fs.readFileSync(this._path, 'utf8'));
      } catch {
        this._store = {};
      }
    }
  }

  _save() {
    const dir = path.dirname(this._path);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this._path, JSON.stringify(this._store, null, 2), 'utf8');
  }

  /**
   * Check if a shop has tokens stored.
   * @param {string} shopId
   */
  hasTokens(shopId) {
    const t = this._store[shopId];
    return !!(t && t.refresh_token);
  }

  /**
   * Store tokens for a shop after initial OAuth flow.
   * Called by scripts/oauth-setup.js after the authorization code grant.
   *
   * @param {string} shopId
   * @param {{ access_token: string, refresh_token: string, expires_in?: number }} tokenData
   */
  storeTokens(shopId, tokenData) {
    const now = Date.now();
    this._store[shopId] = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      access_token_expires_at: now + ((tokenData.expires_in ?? 3600) * 1000),
      refresh_token_obtained_at: now,
    };
    this._save();
  }

  /**
   * Get a valid access token for the given shop.
   * Automatically refreshes if the current token is expired or about to expire.
   *
   * The refresh request is sent through the group's proxy so Etsy's token endpoint
   * sees the same static HK IP as the regular API calls.
   *
   * @param {string} shopId
   * @param {string} keystring         - Etsy app keystring (NOT keystring:secret — token endpoint doesn't need secret)
   * @param {string} fallbackRefreshToken - From config.json if tokens.json not initialized
   * @param {import('axios').AxiosInstance} [proxyClient]  - Optional: proxy-routed axios instance
   * @returns {Promise<string>} A valid access_token
   */
  async getAccessToken(shopId, keystring, fallbackRefreshToken, proxyClient) {
    const now = Date.now();
    const stored = this._store[shopId];

    // Check if refresh token has expired (90 days)
    if (stored && stored.refresh_token_obtained_at) {
      const age = now - stored.refresh_token_obtained_at;
      if (age > REFRESH_TOKEN_TTL_MS) {
        throw new TokenExpiredError(
          shopId,
          `Refresh token for shop ${shopId} has expired (90-day limit). ` +
            `Re-run 'npm run oauth:setup' to re-authenticate this shop.`
        );
      }
    }

    // Return cached access token if still valid
    if (
      stored &&
      stored.access_token &&
      stored.access_token_expires_at > now + REFRESH_BUFFER_MS
    ) {
      return stored.access_token;
    }

    // Determine the refresh token to use
    const refreshToken = stored?.refresh_token ?? fallbackRefreshToken;
    if (!refreshToken) {
      throw new TokenExpiredError(
        shopId,
        `No refresh token found for shop ${shopId}. ` +
          `Run 'npm run oauth:setup' to complete the initial OAuth flow.`
      );
    }

    // Dedupe concurrent refreshes: if a refresh for this shop is already in
    // flight (e.g. several bulk requests cross the expiry buffer at once), they
    // all await the same network call instead of stampeding Etsy's token endpoint.
    if (this._refreshing.has(shopId)) {
      return this._refreshing.get(shopId);
    }
    const p = (async () => {
      const newTokens = await this._doRefresh(keystring, refreshToken, proxyClient);
      this.storeTokens(shopId, newTokens);
      return newTokens.access_token;
    })();
    this._refreshing.set(shopId, p);
    try {
      return await p;
    } finally {
      this._refreshing.delete(shopId);
    }
  }

  /**
   * Exchange a refresh token for a new access token.
   * Uses the proxy client if provided (ensures correct exit IP for token endpoint).
   *
   * NOTE: The token endpoint (api.etsy.com/v3/public/oauth/token) is a PUBLIC endpoint.
   * It only needs the keystring (not keystring:secret) as client_id.
   *
   * @param {string} keystring - Just the keystring, no shared secret
   * @param {string} refreshToken
   * @param {import('axios').AxiosInstance} [proxyClient]
   * @returns {Promise<{ access_token: string, refresh_token: string, expires_in: number }>}
   */
  async _doRefresh(keystring, refreshToken, proxyClient) {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: keystring,
      refresh_token: refreshToken,
    });

    const requestConfig = {
      baseURL: '',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    };

    const client = proxyClient ?? axios;

    try {
      const { data } = await client.post(ETSY_TOKEN_URL, body.toString(), requestConfig);
      return data;
    } catch (err) {
      const status = err.response?.status;
      const desc = err.response?.data?.error_description ?? err.message;

      if (status === 400 && err.response?.data?.error === 'invalid_grant') {
        throw new TokenExpiredError(
          null,
          `Refresh token rejected by Etsy: "${desc}". ` +
            `The refresh token may have expired (90-day limit) or been revoked. ` +
            `Re-run 'npm run oauth:setup'.`
        );
      }
      throw err;
    }
  }

  /**
   * Get token status for all shops — useful for the dashboard UI and health checks.
   * @param {string[]} shopIds
   * @returns {Array<{ shop_id: string, status: string, expires_in_hours: number | null }>}
   */
  getStatus(shopIds) {
    const now = Date.now();
    return shopIds.map((shopId) => {
      const stored = this._store[shopId];
      if (!stored) return { shop_id: shopId, status: 'not_authenticated', expires_in_hours: null };

      const refreshAge = now - (stored.refresh_token_obtained_at ?? 0);
      const refreshExpired = refreshAge > REFRESH_TOKEN_TTL_MS;
      if (refreshExpired) return { shop_id: shopId, status: 'refresh_expired', expires_in_hours: null };

      const refreshDaysLeft = Math.floor((REFRESH_TOKEN_TTL_MS - refreshAge) / (24 * 3600 * 1000));
      const accessValid = stored.access_token_expires_at > now;

      return {
        shop_id: shopId,
        status: accessValid ? 'active' : 'needs_refresh',
        access_token_valid: accessValid,
        refresh_token_days_remaining: refreshDaysLeft,
        expires_in_hours: accessValid
          ? Math.floor((stored.access_token_expires_at - now) / 3600000)
          : 0,
      };
    });
  }

  /**
   * Invalidate a shop's tokens (e.g., when you get a 401 from the API).
   * Forces a refresh on the next getAccessToken call.
   * @param {string} shopId
   */
  invalidate(shopId) {
    if (this._store[shopId]) {
      this._store[shopId].access_token_expires_at = 0;
      this._save();
    }
  }

  /**
   * Hot-reload tokens from disk without restarting the server.
   * Call this after running oauth:setup for any shop so the server
   * immediately picks up the new tokens (including any new scopes).
   */
  reload() {
    this._load();
    // Force all in-memory tokens to appear expired so the next request
    // triggers a refresh using the newly-stored refresh token.
    for (const shopId of Object.keys(this._store)) {
      this._store[shopId].access_token_expires_at = 0;
    }
  }
}

/**
 * Specific error for expired or missing tokens — distinct from network errors.
 * The sync worker catches this type to log it separately rather than retrying.
 */
class TokenExpiredError extends Error {
  constructor(shopId, message) {
    super(message);
    this.name = 'TokenExpiredError';
    this.shopId = shopId;
  }
}

module.exports = { TokenManager, TokenExpiredError };
