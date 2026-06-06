'use strict';

/**
 * Playwright browser session manager for Etsy messaging.
 *
 * Design
 * ──────
 * Each Etsy shop account logs in exactly once via a VISIBLE Chromium window.
 * After login the session is saved to  data/sessions/{shop_id}_session.json
 * (Playwright storageState format — cookies + localStorage).
 *
 * All subsequent syncs and reply sends use a HEADLESS context loaded from the
 * saved session file.  No credentials are stored — only the session cookies.
 *
 * Login detection
 * ───────────────
 * After opening the login browser we poll the page URL every 1.5 seconds.
 * We consider the user logged in when:
 *   1. The URL is on etsy.com (not /signin or /join)
 *   2. The account navigation element is present in the DOM
 * We then save the storageState and close the browser automatically.
 *
 * Session expiry
 * ──────────────
 * Etsy sessions typically last months.  If a headless context is redirected
 * to /signin, that session file is deleted and the shop is marked as needing
 * re-login.
 */

const path = require('path');
const fs   = require('fs');
const adspower = require('../automation/adspower');

const SESSIONS_DIR = path.resolve(__dirname, '../../data/sessions');

// Shared browser identity so the LOGIN session and the HEADLESS sync/reply
// sessions present an identical fingerprint to Etsy. A mismatch between the
// browser that created the cookies and the one that reuses them is a common
// trigger for Etsy invalidating the session ("unusual activity").
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const CONTEXT_FINGERPRINT = {
  userAgent: USER_AGENT,
  viewport: { width: 1280, height: 800 },
  locale: 'en-US',
  timezoneId: 'America/New_York',
  extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
};

/** Init script applied to every context to strip the most obvious bot signals. */
function applyStealth(ctx) {
  return ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    if (!navigator.plugins || navigator.plugins.length === 0) {
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    }
  });
}

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

class BrowserManager {
  constructor() {
    /** @type {Map<string, {browser, ctx, page, status:string, error?:string}>} */
    this._loginSessions = new Map();

    /** Cached playwright module reference */
    this._pw = null;
  }

  // ── Playwright availability ─────────────────────────────────────────────────

  /** Lazy-load playwright — throws if not installed. */
  _getPlaywright() {
    if (this._pw) return this._pw;
    // eslint-disable-next-line global-require
    this._pw = require('playwright');
    return this._pw;
  }

  /** Whether Playwright's Chromium binary is reachable. */
  isAvailable() {
    try {
      this._getPlaywright();
      return true;
    } catch {
      return false;
    }
  }

  // ── Session paths ───────────────────────────────────────────────────────────

  getSessionPath(shopId) {
    // MUST match the filename used by src/automation/etsy-marketing.js
    // ('{shopId}.json', not '{shopId}_session.json') so that sessions captured
    // through the Discounts/Marketing tab are immediately usable here.
    return path.join(SESSIONS_DIR, `${shopId}.json`);
  }

  hasSession(shopId) {
    const p = this.getSessionPath(shopId);
    if (!fs.existsSync(p)) return false;
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      // Valid storageState has a non-empty cookies array
      return Array.isArray(data.cookies) && data.cookies.length > 0;
    } catch {
      return false;
    }
  }

  deleteSession(shopId) {
    const p = this.getSessionPath(shopId);
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
  }

  // ── Login flow (visible browser) ────────────────────────────────────────────

  /** Current login-browser status for a shop: 'waiting_login' | 'saving' | 'logged_in' | 'error' | 'timeout' | null */
  getLoginStatus(shopId) {
    return this._loginSessions.get(shopId)?.status ?? null;
  }

  getLoginError(shopId) {
    return this._loginSessions.get(shopId)?.error ?? null;
  }

  /**
   * Open a login browser for a shop.
   *
   * Mode A — AdsPower CDP (PREFERRED when adspowerProfileId is provided):
   *   Connects to the existing AdsPower Chromium via CDP, opens an isolated
   *   context, and waits for the user to log in. This reuses AdsPower's
   *   per-profile proxy routing + anti-detect fingerprint — exactly the same
   *   mechanism the Discounts tab's "Capture Session" flow uses.
   *   Session is saved to data/sessions/{shopId}.json and shared with the
   *   Discounts/Marketing automation module.
   *
   * Mode B — Standalone Playwright (fallback when no AdsPower profile set):
   *   Launches a fresh Chromium window. Less optimal (generic fingerprint,
   *   no AdsPower proxy routing) but works without AdsPower.
   *   Also saves to data/sessions/{shopId}.json.
   *
   * @param {string}      shopId
   * @param {string|null} proxyUrl           - Group socks5:// proxy (Mode B fallback only)
   * @param {string|null} adspowerProfileId  - AdsPower user_id for this shop (enables Mode A)
   */
  async startLoginBrowser(shopId, proxyUrl = null, adspowerProfileId = null) {
    await this.closeLoginBrowser(shopId);

    const entry = { browser: null, ctx: null, page: null, status: 'waiting_login', mode: 'standalone' };
    this._loginSessions.set(shopId, entry);

    // ── Mode A: AdsPower CDP ─────────────────────────────────────────────────
    if (adspowerProfileId) {
      entry.mode = 'adspower';
      this._startLoginViaAdsPower(shopId, adspowerProfileId, entry).catch(err => {
        entry.status = 'error';
        entry.error  = err.message;
      });
      return;
    }

    // ── Mode B: Standalone Playwright ────────────────────────────────────────
    const pw = this._getPlaywright();

    const launchOpts = {
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,800',
      ],
    };
    // For standalone mode, route through the group proxy so Etsy sees the
    // correct static IP (same IP the API calls come from).
    if (proxyUrl && proxyUrl !== 'direct') launchOpts.proxy = { server: proxyUrl };

    const browser = await pw.chromium.launch(launchOpts);
    const ctx     = await browser.newContext({ ...CONTEXT_FINGERPRINT });
    await applyStealth(ctx);

    if (this.hasSession(shopId)) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.getSessionPath(shopId), 'utf8'));
        if (saved.cookies?.length) await ctx.addCookies(saved.cookies);
      } catch { /* ignore */ }
    }

    const page = await ctx.newPage();
    await page.goto('https://www.etsy.com/signin', { waitUntil: 'domcontentloaded' }).catch(() => {});

    entry.browser = browser;
    entry.ctx     = ctx;
    entry.page    = page;

    this._pollUntilLoggedIn(shopId, entry).catch(err => {
      entry.status = 'error';
      entry.error  = err.message;
    });
  }

  /**
   * Mode A login: connect to AdsPower via CDP and wait for Etsy login.
   * Shares the same session file as the Discounts/Marketing capture flow.
   */
  async _startLoginViaAdsPower(shopId, profileId, entry) {
    const { chromium } = this._getPlaywright();

    entry.status = 'opening_adspower';

    const wsEndpoint = await adspower.openProfile(profileId);
    const browser    = await chromium.connectOverCDP(wsEndpoint);
    const ctx        = await browser.newContext({ ignoreHTTPSErrors: true });
    const page       = await ctx.newPage();

    entry.browser = browser;
    entry.ctx     = ctx;
    entry.page    = page;
    entry.status  = 'waiting_login';

    await page.goto('https://www.etsy.com/signin', { waitUntil: 'domcontentloaded' }).catch(() => {});

    const POLL_MS    = 1500;
    const TIMEOUT_MS = 5 * 60 * 1000;
    const deadline   = Date.now() + TIMEOUT_MS;

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, POLL_MS));
      if (!this._loginSessions.has(shopId)) return;

      try {
        const url = page.url();
        if (/\/(signin|join|login)/i.test(url)) continue;
        if (!url.includes('etsy.com')) continue;

        const authEl = await page.$('[data-testid="account-icon"], [aria-label*="Account"], [href*="/messages"]').catch(() => null);
        if (authEl || url.includes('/messages') || url.includes('/shop-manager')) {
          entry.status = 'saving';
          await ctx.storageState({ path: this.getSessionPath(shopId) });
          entry.status = 'logged_in';
          await new Promise(r => setTimeout(r, 2000));
          await ctx.close().catch(() => {});
          // Do NOT close the AdsPower browser — AdsPower manages its own lifecycle
          this._loginSessions.delete(shopId);
          return;
        }
      } catch (err) {
        entry.status = 'error';
        entry.error  = err.message;
        await ctx.close().catch(() => {});
        this._loginSessions.delete(shopId);
        return;
      }
    }

    entry.status = 'timeout';
    await ctx.close().catch(() => {});
    this._loginSessions.delete(shopId);
  }

  async _pollUntilLoggedIn(shopId, entry) {
    const { browser, ctx, page } = entry;
    const POLL_MS     = 1500;
    const TIMEOUT_MS  = 5 * 60 * 1000;
    const deadline    = Date.now() + TIMEOUT_MS;

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, POLL_MS));
      if (!this._loginSessions.has(shopId)) return;

      try {
        const url = page.url();
        if (/\/(signin|join|login)/i.test(url)) continue;
        if (!url.includes('etsy.com')) continue;

        const authEl = await page.$('[data-testid="account-icon"], [aria-label*="Account"], [href*="/messages"]').catch(() => null);
        if (authEl || url.includes('/messages') || url.includes('/shop-manager')) {
          entry.status = 'saving';
          await ctx.storageState({ path: this.getSessionPath(shopId) });
          entry.status = 'logged_in';
          await new Promise(r => setTimeout(r, 2000));
          await browser.close().catch(() => {});
          this._loginSessions.delete(shopId);
          return;
        }
      } catch (err) {
        entry.status = 'error';
        entry.error  = err.message;
        await browser.close().catch(() => {});
        this._loginSessions.delete(shopId);
        return;
      }
    }

    entry.status = 'timeout';
    await browser.close().catch(() => {});
    this._loginSessions.delete(shopId);
  }

  async closeLoginBrowser(shopId) {
    const entry = this._loginSessions.get(shopId);
    if (!entry) return;
    // In AdsPower mode we only close the context, not the AdsPower browser itself
    if (entry.mode === 'adspower') {
      await entry.ctx?.close().catch(() => {});
    } else {
      await entry.browser?.close().catch(() => {});
    }
    this._loginSessions.delete(shopId);
  }

  // ── Headless context factory (for sync + reply) ─────────────────────────────

  /**
   * Create a browser context for sync/reply using the saved session.
   *
   * Mode A — AdsPower CDP (when adspowerProfileId provided):
   *   Connects to AdsPower's running Chromium. Correct proxy + fingerprint
   *   guaranteed by AdsPower. Caller must call ctx.close() after use
   *   and MUST NOT call browser.close() (AdsPower owns the browser lifecycle).
   *
   * Mode B — Standalone Playwright headless (fallback):
   *   Launches a new headless Chromium. Caller must call browser.close().
   *
   * Return shape: { browser, ctx, isAdsPower }
   *   isAdsPower=true → caller should close ctx only, not browser
   *
   * @param {string}      shopId
   * @param {string|null} proxyUrl           - Group SOCKS5 URL (Mode B only)
   * @param {string|null} adspowerProfileId  - Opens Mode A when provided
   * @returns {Promise<{browser, ctx, isAdsPower: boolean}>}
   */
  async createHeadlessContext(shopId, proxyUrl = null, adspowerProfileId = null) {
    if (!this.hasSession(shopId)) {
      throw new Error(
        `No session for ${shopId}. ` +
        `Use "Connect Inbox" in the Messages tab (or capture a session in the Discounts tab).`
      );
    }

    // ── Mode A: AdsPower CDP ─────────────────────────────────────────────────
    if (adspowerProfileId) {
      try {
        const { chromium } = this._getPlaywright();
        const wsEndpoint = await adspower.openProfile(adspowerProfileId);
        const browser    = await chromium.connectOverCDP(wsEndpoint);
        const ctx        = await browser.newContext({
          storageState: this.getSessionPath(shopId),
          ignoreHTTPSErrors: true,
        });
        return { browser, ctx, isAdsPower: true };
      } catch (err) {
        // AdsPower unavailable (not running, API key missing, etc.)
        // Log a clear warning and fall through to Mode B.
        console.warn(
          `[browser-manager] AdsPower CDP failed for ${shopId} (profile ${adspowerProfileId}): ` +
          `${err.message}. Falling back to standalone Playwright.`
        );
      }
    }

    // ── Mode B: Standalone Playwright headless ───────────────────────────────
    const pw = this._getPlaywright();

    const launchOpts = {
      headless: true,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    };
    // Route through the group proxy so Etsy sees the same IP as the API calls.
    if (proxyUrl && proxyUrl !== 'direct') launchOpts.proxy = { server: proxyUrl };

    const browser = await pw.chromium.launch(launchOpts);
    const ctx     = await browser.newContext({
      storageState: this.getSessionPath(shopId),
      ...CONTEXT_FINGERPRINT,
    });
    await applyStealth(ctx);

    return { browser, ctx, isAdsPower: false };
  }

  // ── Status snapshot ─────────────────────────────────────────────────────────

  /**
   * Return the session + login status for each shopId in the list.
   * @param {string[]} shopIds
   * @returns {Array<{shop_id:string, has_session:boolean, login_status:string|null}>}
   */
  getStatusSnapshot(shopIds) {
    return shopIds.map(shopId => ({
      shop_id:      shopId,
      has_session:  this.hasSession(shopId),
      login_status: this.getLoginStatus(shopId),
      login_error:  this.getLoginError(shopId),
    }));
  }
}

module.exports = new BrowserManager(); // singleton
