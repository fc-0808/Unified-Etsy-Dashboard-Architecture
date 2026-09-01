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
const crypto = require('crypto');
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
    /** A malformed on-disk store blocks all saves until a valid reload. */
    this._loadError = null;
    /** Last transient persistence failure after a successful token refresh. */
    this._persistenceError = null;
    this._persistRetryTimer = null;
    this._persistRetryDelayMs = 5000;
    /** @type {Map<string, Promise<string>>} shop_id → in-flight refresh (dedupe) */
    this._refreshing = new Map();
    this._load();
  }

  _load() {
    this._loadError = null;
    if (fs.existsSync(this._path)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this._path, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new TypeError('top-level value must be an object');
        }
        this._store = parsed;
      } catch (err) {
        // A corrupt/half-written tokens.json must NOT be silently reset — the next
        // _save() would overwrite it and permanently clobber every shop's refresh
        // token. Back it up first so it can be recovered, and surface the error.
        const backup = `${this._path}.corrupt-${Date.now()}`;
        try { fs.copyFileSync(this._path, backup); } catch { /* best effort */ }
        console.error(
          `[token-manager] ${this._path} is not valid JSON (${err.message}). ` +
          `Backed up to ${backup}. Token writes are disabled until the file is repaired and reloaded.`
        );
        // Keep any previously loaded in-memory tokens available to the running
        // process, but fail closed on persistence. Otherwise the next successful
        // refresh could overwrite every other shop with a partial store.
        this._loadError = err;
      }
    }
  }

  _save(store = this._store) {
    if (this._loadError) {
      throw new TokenStoreError(
        this._path,
        `Refusing to overwrite invalid token store at ${this._path}. ` +
          'Repair or restore the JSON file, then reload tokens.',
        this._loadError
      );
    }
    const dir = path.dirname(this._path);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tempPath = path.join(
      dir,
      `.${path.basename(this._path)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
    );
    let fd = null;
    try {
      fd = fs.openSync(tempPath, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(store, null, 2), 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tempPath, this._path);
      // POSIX only; harmless best-effort on Windows. Tokens must not be
      // world-readable on systems that honor Unix mode bits.
      try { fs.chmodSync(this._path, 0o600); } catch { /* platform/filesystem */ }
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* best effort */ }
      }
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch { /* best effort */ }
    }
  }

  /**
   * Check if a shop has tokens stored.
   * @param {string} shopId
   */
  hasTokens(shopId) {
    const t = this._store[shopId];
    return !!(t && t.refresh_token);
  }

  getStoreHealth() {
    return {
      valid: !this._loadError,
      persisted: !this._loadError && !this._persistenceError,
      path: this._path,
      error: (this._loadError || this._persistenceError)?.message || null,
    };
  }

  _schedulePersistenceRetry() {
    if (this._persistRetryTimer || this._loadError || !this._persistenceError) return;
    this._persistRetryTimer = setTimeout(() => {
      this._persistRetryTimer = null;
      try {
        this._save(this._store);
        this._persistenceError = null;
        this._persistRetryDelayMs = 5000;
        console.log('[token-manager] Recovered token-store persistence after a transient failure.');
      } catch (err) {
        this._persistenceError = err;
        this._persistRetryDelayMs = Math.min(this._persistRetryDelayMs * 2, 5 * 60 * 1000);
        this._schedulePersistenceRetry();
      }
    }, this._persistRetryDelayMs);
    if (typeof this._persistRetryTimer.unref === 'function') this._persistRetryTimer.unref();
  }

  /**
   * Store tokens for a shop after initial OAuth flow.
   * Called by scripts/oauth-setup.js after the authorization code grant.
   *
   * @param {string} shopId
   * @param {{ access_token: string, refresh_token: string, expires_in?: number }} tokenData
   */
  storeTokens(shopId, tokenData, { allowMemoryFallback = false } = {}) {
    const now = Date.now();
    const prev = this._store[shopId] || {};
    // Record granted scopes when supplied. Refresh responses may omit `scope`, so
    // preserve the prior set in that case; this lets callers pre-flight a token
    // authorized before a new permission was added.
    let scopes = prev.scopes || null;
    if (Array.isArray(tokenData.scopes)) scopes = tokenData.scopes;
    else if (typeof tokenData.scope === 'string' && tokenData.scope.trim()) scopes = tokenData.scope.trim().split(/\s+/);
    const nextStore = {
      ...this._store,
      [shopId]: {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        access_token_expires_at: now + ((tokenData.expires_in ?? 3600) * 1000),
        refresh_token_obtained_at: now,
        ...(scopes ? { scopes } : {}),
      },
    };
    try {
      this._save(nextStore);
      this._store = nextStore;
      this._persistenceError = null;
      return true;
    } catch (err) {
      if (!allowMemoryFallback || this._loadError) throw err;
      // Etsy may rotate the refresh token on every successful refresh. Keep the
      // new credential usable in memory and retry persistence; discarding it here
      // could orphan the shop immediately.
      this._store = nextStore;
      this._persistenceError = err;
      console.error(
        `[token-manager] CRITICAL: refreshed tokens for ${shopId} are only in memory ` +
        `because ${this._path} could not be saved (${err.message}). Retrying in background.`
      );
      this._schedulePersistenceRetry();
      return false;
    }
  }

  /** Recorded granted scopes for a shop (or null if unknown — legacy tokens). */
  getScopes(shopId) {
    const s = this._store[shopId];
    return s && Array.isArray(s.scopes) ? s.scopes : null;
  }

  /**
   * Whether the shop's token is known to have a scope. Returns true when the
   * scope set is unknown (legacy) so we never block on incomplete data — the
   * runtime error handler still catches a genuine missing scope.
   */
  hasScope(shopId, scope) {
    const scopes = this.getScopes(shopId);
    if (!scopes) return true; // unknown → don't pre-block
    return scopes.includes(scope);
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

    // A refresh can rotate Etsy's refresh token. Never contact the token endpoint
    // while persistence is disabled, or the newly-issued token could be lost and
    // permanently invalidate the only recoverable credential.
    if (this._loadError) {
      throw new TokenStoreError(
        this._path,
        `Cannot refresh OAuth tokens while ${this._path} is invalid. ` +
          'Repair or restore the token store, then reload it before retrying.',
        this._loadError
      );
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
      this.storeTokens(shopId, newTokens, { allowMemoryFallback: true });
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
      if (this._loadError) {
        return {
          shop_id: shopId,
          status: 'token_store_invalid',
          access_token_valid: false,
          refresh_token_days_remaining: null,
          expires_in_hours: null,
        };
      }
      if (this._persistenceError) {
        return {
          shop_id: shopId,
          status: 'token_store_unpersisted',
          access_token_valid: !!this._store[shopId]?.access_token,
          refresh_token_days_remaining: null,
          expires_in_hours: null,
        };
      }
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
      if (this._loadError) return false;
      this._save();
      return true;
    }
    return false;
  }

  /**
   * Hot-reload tokens from disk without restarting the server.
   * Call this after running oauth:setup for any shop so the server
   * immediately picks up the new tokens (including any new scopes).
   */
  reload() {
    if (this._persistenceError) {
      const err = new Error(
        'Refusing to reload tokens while refreshed credentials are not yet persisted.'
      );
      err.code = 'TOKEN_STORE_UNPERSISTED';
      err.status = 409;
      throw err;
    }
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

class TokenStoreError extends Error {
  constructor(tokensPath, message, cause = null) {
    super(message);
    this.name = 'TokenStoreError';
    this.code = 'TOKEN_STORE_INVALID';
    this.tokensPath = tokensPath;
    if (cause) this.cause = cause;
  }
}

module.exports = { TokenManager, TokenExpiredError, TokenStoreError };
