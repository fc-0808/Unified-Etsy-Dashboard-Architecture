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

const SESSIONS_DIR = path.resolve(__dirname, '../../data/sessions');

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
    return path.join(SESSIONS_DIR, `${shopId}_session.json`);
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
   * Open a VISIBLE Chromium window so the user can log into Etsy manually.
   * The login is detected automatically; the session is saved and the browser
   * closes on its own.  Poll getLoginStatus() to track progress.
   *
   * @param {string}      shopId
   * @param {string|null} proxyUrl  - Optional socks5:// proxy URL
   */
  async startLoginBrowser(shopId, proxyUrl = null) {
    // Tear down any in-progress login for this shop
    await this.closeLoginBrowser(shopId);

    const pw = this._getPlaywright();

    const launchOpts = {
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,800',
      ],
    };
    if (proxyUrl) launchOpts.proxy = { server: proxyUrl };

    const browser = await pw.chromium.launch(launchOpts);
    const ctx     = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });

    // If an older session exists, pre-load its cookies — user might already be
    // logged in and just needs to click through or the session may be stale.
    if (this.hasSession(shopId)) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.getSessionPath(shopId), 'utf8'));
        if (saved.cookies?.length) await ctx.addCookies(saved.cookies);
      } catch { /* ignore */ }
    }

    const page = await ctx.newPage();
    // Start at the Etsy sign-in page
    await page.goto('https://www.etsy.com/signin', { waitUntil: 'domcontentloaded' }).catch(() => {});

    const entry = { browser, ctx, page, status: 'waiting_login' };
    this._loginSessions.set(shopId, entry);

    // Start async poll — never awaited by caller
    this._pollUntilLoggedIn(shopId, entry).catch(err => {
      entry.status = 'error';
      entry.error  = err.message;
    });
  }

  async _pollUntilLoggedIn(shopId, entry) {
    const { browser, ctx, page } = entry;
    const POLL_MS     = 1500;
    const TIMEOUT_MS  = 5 * 60 * 1000; // 5 minutes
    const deadline    = Date.now() + TIMEOUT_MS;

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, POLL_MS));
      if (!this._loginSessions.has(shopId)) return; // cancelled externally

      try {
        const url = page.url();

        // Still on sign-in / join / login pages → user hasn't completed login yet
        if (/\/(signin|join|login)/i.test(url)) continue;
        // Must be on Etsy domain
        if (!url.includes('etsy.com')) continue;

        // Look for a nav element that only appears when logged in
        const authEl = await page.$(
          '[data-testid="account-icon"], [aria-label*="Account"], [href*="/messages"], nav .account-nav-item'
        ).catch(() => null);

        if (authEl || url.includes('/messages') || url.includes('/shop-manager')) {
          // User is logged in ─ save the full storageState
          entry.status = 'saving';
          await ctx.storageState({ path: this.getSessionPath(shopId) });
          entry.status = 'logged_in';

          // Let the user see the logged-in state for a moment, then close
          await new Promise(r => setTimeout(r, 2000));
          await browser.close().catch(() => {});
          this._loginSessions.delete(shopId);
          return;
        }

      } catch (err) {
        // Page navigated away or crashed — stop polling
        entry.status = 'error';
        entry.error  = err.message;
        await browser.close().catch(() => {});
        this._loginSessions.delete(shopId);
        return;
      }
    }

    // Timed out without detecting login
    entry.status = 'timeout';
    await browser.close().catch(() => {});
    this._loginSessions.delete(shopId);
  }

  async closeLoginBrowser(shopId) {
    const entry = this._loginSessions.get(shopId);
    if (!entry) return;
    await entry.browser.close().catch(() => {});
    this._loginSessions.delete(shopId);
  }

  // ── Headless context factory (for sync + reply) ─────────────────────────────

  /**
   * Create a headless Playwright context using the saved session.
   * Caller MUST call `browser.close()` after use.
   *
   * @param {string}      shopId
   * @param {string|null} proxyUrl
   * @returns {Promise<{browser, ctx}>}
   */
  async createHeadlessContext(shopId, proxyUrl = null) {
    if (!this.hasSession(shopId)) {
      throw new Error(`No browser session for ${shopId} — open the Messages tab and click "Login with Browser".`);
    }

    const pw = this._getPlaywright();

    const launchOpts = {
      headless: true,
      args: [
        '--no-sandbox',
        // Removes the navigator.webdriver=true flag that headless Chrome sets,
        // which is the single most common bot-detection signal.
        '--disable-blink-features=AutomationControlled',
      ],
    };
    if (proxyUrl) launchOpts.proxy = { server: proxyUrl };

    const browser = await pw.chromium.launch(launchOpts);
    const ctx     = await browser.newContext({
      storageState: this.getSessionPath(shopId),
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      // Mimic a real desktop browser so Etsy renders the full layout
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      // A real Accept-Language header helps avoid "unusual activity" flags
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });

    // Patch the most obvious automation fingerprints before any page script runs
    await ctx.addInitScript(() => {
      // navigator.webdriver → undefined (real browsers don't set it)
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      // Fake a plausible plugins/languages array
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      if (!navigator.plugins || navigator.plugins.length === 0) {
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      }
    });

    return { browser, ctx };
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
