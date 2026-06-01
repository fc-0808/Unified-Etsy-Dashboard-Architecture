'use strict';

/**
 * Etsy Shop Manager marketing automation — Session-based multi-shop architecture.
 *
 * KEY INSIGHT: With only 2 AdsPower profiles, each profile acts as a
 * "proxy + fingerprint container". Each shop gets its own isolated Playwright
 * browser context loaded with that shop's saved Etsy session cookies
 * (Playwright storageState). This is the exact pattern used by Stripe, Shopify,
 * and other top companies for multi-account browser automation.
 *
 * Flow per shop:
 *   1. Open AdsPower profile for the shop's proxy group (stays open between shops)
 *   2. Create an isolated browser context loaded with shop's storageState JSON
 *   3. Navigate Etsy Shop Manager → Marketing → Sales & Discounts
 *   4. Complete the action (human-like delays throughout)
 *   5. Save updated storageState (refreshes session cookies)
 *   6. Close only the context — the profile browser stays open for next shop
 *
 * Session capture (one-time setup per shop):
 *   - Open AdsPower profile → new isolated context → navigate to Etsy sign-in
 *   - Wait for user to log in manually (up to 5 min)
 *   - Auto-detect login success → capture storageState → save to data/sessions/{shop_id}.json
 *   - Etsy auth cookies (et_*, st_*, LD) last up to 1 year
 */

const { chromium } = require('playwright-core');
const { openProfile } = require('./adspower');
const path = require('path');
const fs   = require('fs');

const SESSIONS_DIR   = path.resolve(__dirname, '../../data/sessions');
const DELAY_MIN      = 300;
const DELAY_MAX      = 1200;
const NAV_TIMEOUT    = 30_000;
const ACTION_TIMEOUT = 15_000;

// ── Utilities ─────────────────────────────────────────────────────────────────

function humanDelay(min = DELAY_MIN, max = DELAY_MAX) {
  const ms = Math.floor(Math.random() * (max - min) + min);
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function humanType(locator, text) {
  await locator.click();
  await humanDelay(150, 350);
  await locator.fill('');
  await humanDelay(100, 250);
  for (const char of text) {
    await locator.press(char);
    await humanDelay(40, 120);
  }
}

async function screenshot(page) {
  try {
    const buf = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: false });
    return buf.toString('base64');
  } catch { return null; }
}

function sessPath(shopId) {
  return path.join(SESSIONS_DIR, `${shopId}.json`);
}

// ── Session Management ────────────────────────────────────────────────────────

/**
 * Get session status for a shop without opening any browser.
 * Reads the saved storageState JSON and inspects Etsy auth cookie expiry.
 */
function getSessionInfo(shopId) {
  const p = sessPath(shopId);
  if (!fs.existsSync(p)) return { exists: false };
  try {
    const state = JSON.parse(fs.readFileSync(p, 'utf8'));
    const authCookies = (state.cookies || []).filter(c =>
      c.name.startsWith('et_') || c.name.startsWith('st_') || c.name === 'LD'
    );
    const expirySeconds = authCookies.map(c => c.expires || 0).filter(e => e > 0);
    const maxExpiry     = expirySeconds.length ? Math.max(...expirySeconds) : 0;
    const now           = Date.now() / 1000;
    const isExpired     = maxExpiry > 0 && maxExpiry < now;
    const expiresAt     = maxExpiry > 0 ? new Date(maxExpiry * 1000).toISOString() : null;
    const daysRemaining = maxExpiry > 0 ? Math.ceil((maxExpiry - now) / 86400) : null;
    const stat          = fs.statSync(p);
    return {
      exists: true,
      isExpired,
      expiresAt,
      daysRemaining,
      capturedAt: stat.mtimeMs,
      cookieCount: state.cookies?.length || 0,
    };
  } catch {
    return { exists: true, corrupted: true };
  }
}

/**
 * Delete a saved session file for a shop.
 */
function clearSession(shopId) {
  const p = sessPath(shopId);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

/**
 * Capture an Etsy session for a shop by opening AdsPower and waiting for the
 * user to log in. Streams progress via onProgress(stage, message).
 *
 * This is a ONE-TIME setup per shop. Captured sessions last up to 1 year.
 *
 * @param {string}   profileId    AdsPower profile ID for this shop's proxy group
 * @param {string}   shopId       Internal shop ID (used as filename)
 * @param {string}   shopName     Human-readable shop name (for display)
 * @param {function} onProgress   Callback(stage, message) for SSE streaming
 * @returns {Promise<{success: boolean, sessionInfo: object}>}
 */
async function captureSession(profileId, shopId, shopName, onProgress) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  let browser, context;

  try {
    onProgress?.('opening', `Opening AdsPower profile for ${shopName}…`);
    const wsEndpoint = await openProfile(profileId);
    browser  = await chromium.connectOverCDP(wsEndpoint);

    // Create a fresh isolated context — no cookies, no history
    context  = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();

    onProgress?.('navigating', 'Navigating to Etsy sign-in…');
    await page.goto('https://www.etsy.com/signin', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });

    onProgress?.('waiting', `⏳ Please log into <strong>${shopName}</strong> in the browser. Waiting up to 5 minutes…`);

    // Detect login success: URL moves to shop manager or /your/shops
    await page.waitForURL(
      url => url.includes('/your/shops') || url.includes('shop-manager') || url.includes('/sell/shops'),
      { timeout: 300_000 }  // 5-minute window for the user to log in
    );

    // Extra delay so all auth cookies are fully committed
    await new Promise(r => setTimeout(r, 3000));

    onProgress?.('saving', 'Login detected! Saving session cookies…');
    const p = sessPath(shopId);
    await context.storageState({ path: p });

    const info = getSessionInfo(shopId);
    const expStr = info.daysRemaining ? ` — valid for ~${info.daysRemaining} days` : '';
    onProgress?.('done', `✓ Session captured for ${shopName}${expStr}`);

    return { success: true, sessionInfo: info };
  } catch (err) {
    onProgress?.('error', `✗ ${err.message}`);
    return { success: false, error: err.message };
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

// ── Core Automation (session-based) ──────────────────────────────────────────

/**
 * Open an AdsPower profile via CDP and return { browser, makeShopContext }.
 *
 * makeShopContext(shopId) creates an isolated browser context loaded with
 * the shop's saved session. This allows multiple shops to run through the
 * same AdsPower profile (same proxy + fingerprint) sequentially.
 *
 * Caller is responsible for:
 *   - calling context.close() when done with each shop
 *   - calling browser.close() when completely finished with the profile
 *
 * @param {string} profileId
 */
async function openProfileForAutomation(profileId) {
  const wsEndpoint = await openProfile(profileId);
  const browser    = await chromium.connectOverCDP(wsEndpoint);

  const makeShopContext = (shopId) => {
    const p = sessPath(shopId);
    if (!fs.existsSync(p)) throw new Error(`No session for shop "${shopId}". Capture a session first via the Discounts tab.`);
    return browser.newContext({ storageState: p, ignoreHTTPSErrors: true });
  };

  return { browser, makeShopContext };
}

/**
 * Create a shop-wide percentage-off sale using a saved session.
 *
 * @param {object} opts
 * @param {string}   opts.profileId    AdsPower profile ID
 * @param {string}   opts.shopId       Internal shop ID (for session lookup)
 * @param {string}   opts.shopName     Etsy shop name
 * @param {number}   opts.percent      1–70 (Etsy limit)
 * @param {string}   [opts.endDate]    YYYY-MM-DD (leave blank = no end)
 * @param {function} [opts.onProgress] Callback(message)
 */
async function createSale(opts) {
  const { profileId, shopId, shopName, percent, endDate, onProgress } = opts;
  const shots = [];
  const progress = async (msg, page) => {
    const shot = page ? await screenshot(page) : null;
    if (shot) shots.push(shot);
    onProgress?.(msg, shot);
  };

  let browser, context;
  try {
    await progress('Opening AdsPower profile…', null);
    const { browser: b, makeShopContext } = await openProfileForAutomation(profileId);
    browser = b;

    await progress(`Restoring session for ${shopName}…`, null);
    context     = await makeShopContext(shopId);
    const page  = await context.newPage();

    // Navigate & verify session
    await page.goto(
      `https://www.etsy.com/your/shops/${shopName}/marketing`,
      { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }
    );
    await humanDelay(1500, 2500);

    if (page.url().includes('/signin') || page.url().includes('/login')) {
      clearSession(shopId);
      return { success: false, message: `Session expired for ${shopName} — please capture a new session.`, sessionExpired: true, screenshots: shots };
    }

    await progress('Session active ✓ — navigating to Sales & Discounts…', page);

    await page.goto(
      `https://www.etsy.com/your/shops/${shopName}/marketing/sales`,
      { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }
    );
    await humanDelay(1500, 2000);
    await progress('On Sales page', page);

    // "Run a sale" button
    const runSaleBtn = page.getByRole('button', { name: /run a sale/i })
      .or(page.getByRole('link', { name: /run a sale/i }))
      .or(page.getByText(/run a sale/i, { exact: false }))
      .first();

    const btnVisible = await runSaleBtn.isVisible({ timeout: 5000 }).catch(() => false);
    if (!btnVisible) {
      await progress('Could not find "Run a sale" — a sale may already be active', page);
      return { success: false, message: 'Could not find "Run a sale" button. A sale may already be active, or Etsy\'s UI has changed.', screenshots: shots };
    }

    await runSaleBtn.click();
    await humanDelay(1000, 1800);
    await progress('Clicked "Run a sale"', page);

    // Select "Percentage off"
    const pctOption = page.getByText(/percentage off/i, { exact: false })
      .or(page.getByRole('radio', { name: /percentage/i })).first();
    await pctOption.click({ timeout: ACTION_TIMEOUT });
    await humanDelay(600, 1000);
    await progress('Selected "Percentage off"', page);

    // Enter percentage
    const pctInput = page.locator(
      'input[name*="discount"], input[name*="percent"], input[placeholder*="%"], input[aria-label*="percent" i]'
    ).first().or(page.locator('input[type="number"]').first());
    await humanType(pctInput, String(percent));
    await humanDelay(600, 1000);
    await progress(`Entered ${percent}% discount`, page);

    // Optional end date
    if (endDate) {
      const endInput = page.locator('input[name*="end"], input[placeholder*="end" i], input[aria-label*="end date" i]').first();
      if (await endInput.isVisible({ timeout: 3000 }).catch(() => false)) {
        await humanType(endInput, endDate);
        await humanDelay(400, 800);
      }
    }

    await progress('Reviewing…', page);
    const reviewBtn = page.getByRole('button', { name: /review|confirm|continue|next/i }).first();
    await reviewBtn.click({ timeout: ACTION_TIMEOUT });
    await humanDelay(2000, 3000);
    await progress('Clicked Review', page);

    const confirmBtn = page.getByRole('button', { name: /confirm|create|submit|start sale/i }).first();
    if (await confirmBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await confirmBtn.click({ timeout: ACTION_TIMEOUT });
      await humanDelay(2000, 3000);
      await progress('Sale confirmed!', page);
    }

    // Refresh session
    await context.storageState({ path: sessPath(shopId) });

    const finalShot = await screenshot(page);
    if (finalShot) shots.push(finalShot);
    return { success: true, message: `${percent}% sale created for ${shopName}`, screenshots: shots };

  } catch (err) {
    return { success: false, message: err.message, screenshots: shots };
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Create a promo code using a saved session.
 *
 * @param {object} opts
 * @param {string}   opts.profileId    AdsPower profile ID
 * @param {string}   opts.shopId       Internal shop ID
 * @param {string}   opts.shopName     Etsy shop name
 * @param {string}   opts.code         Promo code string (e.g. "SUMMER20")
 * @param {'percent'|'fixed'|'shipping'} opts.type
 * @param {number}   [opts.amount]
 * @param {string}   [opts.expiryDate] YYYY-MM-DD
 * @param {number}   [opts.minOrderValue]
 * @param {function} [opts.onProgress]
 */
async function createPromoCode(opts) {
  const { profileId, shopId, shopName, code, type, amount, expiryDate, minOrderValue, onProgress } = opts;
  const shots = [];
  const progress = async (msg, page) => {
    const shot = page ? await screenshot(page) : null;
    if (shot) shots.push(shot);
    onProgress?.(msg, shot);
  };

  let browser, context;
  try {
    await progress('Opening AdsPower profile…', null);
    const { browser: b, makeShopContext } = await openProfileForAutomation(profileId);
    browser = b;

    await progress(`Restoring session for ${shopName}…`, null);
    context    = await makeShopContext(shopId);
    const page = await context.newPage();

    await page.goto(
      `https://www.etsy.com/your/shops/${shopName}/marketing/coupons`,
      { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }
    );
    await humanDelay(1500, 2500);

    if (page.url().includes('/signin') || page.url().includes('/login')) {
      clearSession(shopId);
      return { success: false, message: `Session expired for ${shopName} — please capture a new session.`, sessionExpired: true, screenshots: shots };
    }

    await progress('On Promo Codes page', page);

    const createBtn = page.getByRole('button', { name: /create.*promo|new.*code|new special offer/i }).first()
      .or(page.getByText(/create a promo code/i, { exact: false }).first());
    await createBtn.click({ timeout: ACTION_TIMEOUT });
    await humanDelay(1200, 2000);
    await progress('Clicked "Create promo code"', page);

    const codeInput = page.locator('input[name*="code"], input[placeholder*="code" i], input[aria-label*="promo code" i]').first();
    await humanType(codeInput, code.toUpperCase());
    await humanDelay(500, 900);
    await progress(`Entered code: ${code.toUpperCase()}`, page);

    if (type === 'percent' && amount) {
      const r = page.getByText(/percentage off/i, { exact: false }).first()
        .or(page.getByRole('radio', { name: /percentage/i }));
      await r.click({ timeout: ACTION_TIMEOUT }).catch(() => {});
      await humanDelay(400, 700);
      const amtInput = page.locator('input[name*="discount"], input[name*="percent"], input[type="number"]').first();
      await humanType(amtInput, String(amount));
      await humanDelay(400, 700);
      await progress(`Set ${amount}% discount`, page);
    } else if (type === 'shipping') {
      const r = page.getByText(/free.*shipping/i, { exact: false }).first()
        .or(page.getByRole('radio', { name: /free shipping/i }));
      await r.click({ timeout: ACTION_TIMEOUT }).catch(() => {});
      await humanDelay(400, 700);
      await progress('Selected free shipping', page);
    } else if (type === 'fixed' && amount) {
      const r = page.getByText(/fixed amount/i, { exact: false }).first()
        .or(page.getByRole('radio', { name: /fixed/i }));
      await r.click({ timeout: ACTION_TIMEOUT }).catch(() => {});
      await humanDelay(400, 700);
      const amtInput = page.locator('input[name*="amount"], input[type="number"]').first();
      await humanType(amtInput, String(amount));
      await humanDelay(400, 700);
      await progress(`Set $${amount} fixed discount`, page);
    }

    if (minOrderValue) {
      const minInput = page.locator('input[name*="minimum"], input[name*="min_order"], input[aria-label*="minimum" i]').first();
      if (await minInput.isVisible({ timeout: 3000 }).catch(() => false)) {
        await humanType(minInput, String(minOrderValue));
        await humanDelay(400, 700);
      }
    }

    if (expiryDate) {
      const expInput = page.locator('input[name*="expiry"], input[name*="end"], input[placeholder*="expir" i]').first();
      if (await expInput.isVisible({ timeout: 3000 }).catch(() => false)) {
        await humanType(expInput, expiryDate);
        await humanDelay(400, 700);
      }
    }

    const allBtn = page.getByText(/add all.*listing|select all/i, { exact: false }).first();
    if (await allBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await allBtn.click({ timeout: ACTION_TIMEOUT });
      await humanDelay(800, 1400);
      await progress('Applied to all active listings', page);
    }

    await progress('Reviewing promo code…', page);
    const reviewBtn = page.getByRole('button', { name: /review|confirm|continue|next/i }).first();
    await reviewBtn.click({ timeout: ACTION_TIMEOUT });
    await humanDelay(2000, 3000);

    const confirmBtn = page.getByRole('button', { name: /confirm|create code|create promo/i }).first();
    if (await confirmBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await confirmBtn.click({ timeout: ACTION_TIMEOUT });
      await humanDelay(2000, 3000);
      await progress('Promo code created!', page);
    }

    await context.storageState({ path: sessPath(shopId) });

    const finalShot = await screenshot(page);
    if (finalShot) shots.push(finalShot);
    return { success: true, message: `Promo code "${code.toUpperCase()}" created for ${shopName}`, screenshots: shots };

  } catch (err) {
    return { success: false, message: err.message, screenshots: shots };
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Verify a profile has an active Etsy session for a shop.
 * Uses saved session if available; falls back to direct profile check.
 */
async function checkLoginStatus(profileId, shopId, shopName) {
  let browser, context;
  try {
    const wsEndpoint = await openProfile(profileId);
    browser = await chromium.connectOverCDP(wsEndpoint);

    // Prefer saved session if available
    const hasSess = fs.existsSync(sessPath(shopId || shopName));
    const ctxOpts = hasSess
      ? { storageState: sessPath(shopId || shopName), ignoreHTTPSErrors: true }
      : { ignoreHTTPSErrors: true };
    context = await browser.newContext(ctxOpts);
    const page = await context.newPage();

    await page.goto(
      `https://www.etsy.com/your/shops/${shopName}/marketing`,
      { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }
    );
    await humanDelay(1000, 2000);

    const url        = page.url();
    const loggedIn   = !url.includes('/signin') && !url.includes('/login') && !url.includes('join_us');
    const shopMatches = url.toLowerCase().includes(shopName.toLowerCase());
    const shot        = await screenshot(page);
    return { loggedIn, shopMatches, url, screenshot: shot };
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = {
  captureSession,
  getSessionInfo,
  clearSession,
  createSale,
  createPromoCode,
  checkLoginStatus,
};
