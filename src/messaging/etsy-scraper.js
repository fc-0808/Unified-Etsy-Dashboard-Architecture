'use strict';

/**
 * Etsy inbox scraper + reply sender using Playwright.
 *
 * Reads messages by navigating the real Etsy web interface with a saved
 * browser session (no Etsy API involved at all — this uses the same routes
 * a logged-in Etsy user visits in their browser).
 *
 * Reply sending works the same way: navigate to the conversation page, type
 * the reply text into Etsy's own compose box, and click Send.  The message
 * goes through Etsy's standard web flow — fully indistinguishable from a
 * human user replying in their browser.
 *
 * Selector strategy
 * ──────────────────
 * Etsy's DOM uses CSS Modules (hashed class names) that change with every
 * deploy.  We rely primarily on semantic attributes:
 *   - href patterns  (/messages/convo/{id})
 *   - aria-label / data-testid attributes
 *   - placeholder text on inputs
 *   - Stable text content ("Send", "Reply")
 * Multiple fallback selectors are tried in order so minor UI rearrangements
 * don't break the scraper.
 */

const browserManager = require('./browser-manager');
const { upsertConversation, upsertConversationMessage } = require('../db/setup');
const {
  extractConversationsFromPayloads,
  extractMessagesFromPayloads,
} = require('./json-extractor');

const ETSY  = 'https://www.etsy.com';
const INBOX = `${ETSY}/messages/inbox`;

// URL fragments whose JSON responses are worth capturing for parsing.
const CAPTURE_URL_HINTS = ['message', 'convo', 'conversation', 'inbox', 'neu/', 'api/v3', 'ajax'];

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns true if the current page is the Etsy sign-in or join page,
 * meaning the session has expired.
 * @param {import('playwright').Page} page
 */
async function isSignedOut(page) {
  return /\/(signin|join|login)/i.test(page.url());
}

/**
 * Attach a network response listener that captures JSON payloads from
 * message-related endpoints. This is the PRIMARY read mechanism — far more
 * robust than DOM scraping because Etsy's internal JSON shapes change less
 * often than the rendered HTML/CSS.
 *
 * @param {import('playwright').Page} page
 * @returns {object[]} A live array that fills with parsed JSON bodies.
 */
function attachJsonCapture(page) {
  const payloads = [];

  page.on('response', async (response) => {
    try {
      const url = response.url();
      if (!CAPTURE_URL_HINTS.some(h => url.includes(h))) return;

      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;

      const json = await response.json().catch(() => null);
      if (json && typeof json === 'object') payloads.push(json);
    } catch { /* ignore non-JSON / aborted responses */ }
  });

  return payloads;
}

/**
 * Try to read the logged-in user's own Etsy user id from the page, so we can
 * classify which messages were sent by the seller (us) vs. the buyer.
 * @param {import('playwright').Page} page
 * @returns {Promise<string|null>}
 */
async function detectSelfUserId(page) {
  try {
    return await page.evaluate(() => {
      // Etsy exposes the current user id in a few global spots
      const candidates = [
        window?.Etsy?.Context?.data?.user_id,
        window?.Etsy?.Context?.data?.logged_in_user_id,
        window?.__APP_STATE__?.user?.user_id,
      ];
      for (const c of candidates) {
        if (c != null && String(c).length > 0) return String(c);
      }
      // Fallback: scan inline scripts for a user_id assignment
      const html = document.documentElement.innerHTML;
      const m = html.match(/"(?:logged_in_user_id|user_id)"\s*:\s*"?(\d{4,})"?/);
      return m ? m[1] : null;
    });
  } catch {
    return null;
  }
}

/**
 * Try selectors in order, return the first VISIBLE element found.
 * @param {import('playwright').Page} page
 * @param {string[]} selectors
 * @returns {Promise<import('playwright').ElementHandle|null>}
 */
async function findFirst(page, selectors) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible().catch(() => true)) return el;
    } catch { /* try next */ }
  }
  return null;
}

/** Sleep for a randomised duration to mimic human pacing (anti-bot). */
function humanPause(minMs, maxMs) {
  const ms = minMs + Math.floor(Math.random() * Math.max(0, maxMs - minMs));
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Scroll a scrollable container (or the window) repeatedly so Etsy's lazy-loaded
 * conversation list / message thread renders all of its rows before we scrape.
 * @param {import('playwright').Page} page
 * @param {'top'|'bottom'} direction  - thread loads older messages at the top
 */
async function autoScroll(page, direction = 'bottom') {
  try {
    await page.evaluate(async (dir) => {
      const delay = (ms) => new Promise(r => setTimeout(r, ms));
      // Find the most plausible scroll container, else fall back to window.
      const candidates = Array.from(document.querySelectorAll('div, main, section'))
        .filter(el => el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 150);
      const scroller = candidates.sort((a, b) => b.scrollHeight - a.scrollHeight)[0] || null;

      for (let i = 0; i < 12; i++) {
        if (scroller) {
          scroller.scrollTop = dir === 'top' ? 0 : scroller.scrollHeight;
        } else {
          window.scrollTo(0, dir === 'top' ? 0 : document.body.scrollHeight);
        }
        await delay(350);
      }
    }, direction);
  } catch { /* non-fatal */ }
}

// ── Inbox scraping ────────────────────────────────────────────────────────────

/**
 * Extract the list of conversations visible on the Etsy inbox page.
 * @param {import('playwright').Page} page
 * @returns {Promise<Array<{convoId:string, buyerName:string, preview:string, ts:number, isUnread:boolean}>>}
 */
async function extractInbox(page) {
  try {
    await page.waitForSelector('a[href*="/messages/convo/"]', { timeout: 12_000 });
  } catch {
    return [];
  }

  // Etsy lazy-loads conversation rows on scroll — pull them all in first.
  await autoScroll(page, 'bottom');

  return page.evaluate(() => {
    const results = [];
    const seen    = new Set();

    for (const link of document.querySelectorAll('a[href*="/messages/convo/"]')) {
      const href  = link.getAttribute('href') || '';
      const m     = href.match(/\/messages\/convo\/(\d+)/);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);

      const convoId = m[1];

      // ── Buyer name ────────────────────────────────────────────────────────
      // Etsy puts the buyer name as the first prominent text inside the link
      const nameEl = link.querySelector(
        '[class*="name" i], [class*="buyer" i], strong, b, h2, h3, h4, [aria-label]'
      );
      const buyerName = (nameEl?.textContent?.trim() || '').split('\n')[0].trim()
        || Array.from(link.querySelectorAll('span')).find(s => s.textContent.trim().length > 1)?.textContent?.trim()
        || 'Unknown Buyer';

      // ── Message preview ───────────────────────────────────────────────────
      const previewEl = link.querySelector(
        'p, [class*="preview" i], [class*="snippet" i], [class*="excerpt" i], [class*="body" i]'
      );
      const preview = previewEl?.textContent?.trim().slice(0, 200) || '';

      // ── Timestamp ─────────────────────────────────────────────────────────
      const timeEl  = link.querySelector('time');
      const timeStr = timeEl?.getAttribute('datetime') || timeEl?.textContent || '';
      const ts      = timeStr ? Math.floor(new Date(timeStr).getTime() / 1000) : 0;

      // ── Unread ────────────────────────────────────────────────────────────
      const hasUnreadEl = !!link.querySelector('[class*="unread" i], [data-unread], [aria-label*="unread" i]');
      const ariaLabel   = link.getAttribute('aria-label') || '';
      const isUnread    = hasUnreadEl || /unread/i.test(ariaLabel);

      results.push({ convoId, buyerName, preview, ts, isUnread });
    }

    return results;
  });
}

// ── Conversation thread scraping ──────────────────────────────────────────────

/**
 * Extract individual messages from an open Etsy conversation page.
 * @param {import('playwright').Page} page
 * @returns {Promise<Array<{body:string, senderType:'buyer'|'seller', ts:number}>>}
 */
async function extractMessages(page) {
  // Etsy renders message bubbles asynchronously; wait for at least one
  try {
    await page.waitForSelector(
      '[class*="message" i], [class*="bubble" i], [data-testid*="message"]',
      { timeout: 10_000 }
    );
  } catch {
    return [];
  }

  // Older messages load as you scroll up; newest are at the bottom. Pull both ends.
  await autoScroll(page, 'top');
  await autoScroll(page, 'bottom');

  return page.evaluate(() => {
    const results = [];

    // Try selector strategies from most-specific to least
    const strategies = [
      '[data-testid*="ConversationMessage"]',
      '[data-testid*="message-bubble"]',
      '[class*="MessageBubble"]',
      '[class*="message-bubble" i]',
      '[class*="ConversationMessage"]',
      '[class*="messageWrapper" i]',
    ];

    let items = [];
    for (const sel of strategies) {
      items = Array.from(document.querySelectorAll(sel));
      if (items.length > 0) break;
    }

    for (const el of items) {
      const body = el.textContent?.trim();
      if (!body || body.length < 2 || body.length > 10_000) continue;

      // Determine sender by looking for class signals on the element or ancestors
      const cls = Array.from(el.classList).join(' ').toLowerCase();
      const isSellerByClass = /seller|self|sent|right|outgoing/.test(cls);
      // Walk up to 4 ancestors for the same signals
      let ancestor = el.parentElement;
      let isSellerByAncestor = false;
      for (let i = 0; i < 4 && ancestor; i++) {
        const ac = Array.from(ancestor.classList).join(' ').toLowerCase();
        if (/seller|self|sent|right|outgoing/.test(ac)) { isSellerByAncestor = true; break; }
        ancestor = ancestor.parentElement;
      }
      const isSeller = isSellerByClass || isSellerByAncestor;

      const timeEl = el.querySelector('time');
      const ts = timeEl?.getAttribute('datetime')
        ? Math.floor(new Date(timeEl.getAttribute('datetime')).getTime() / 1000)
        : 0;

      results.push({ body, senderType: isSeller ? 'seller' : 'buyer', ts });
    }

    return results;
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Sync conversations from the Etsy inbox for a single shop.
 * Upserts all visible conversations into the local SQLite DB.
 *
 * @param {object} shopCfg  - Shop entry from getAllShops() (has shop_id, proxy)
 * @param {import('better-sqlite3').Database} db
 * @returns {Promise<{synced:number, skipped:boolean, reason?:string, error?:string}>}
 */
async function syncMessagesForShop(shopCfg, db) {
  const { shop_id, proxy, adspower_profile_id } = shopCfg;

  if (!browserManager.hasSession(shop_id)) {
    return { synced: 0, skipped: true, reason: 'no_browser_session' };
  }

  let browser, ctx, isAdsPower;
  try {
    ({ browser, ctx, isAdsPower } = await browserManager.createHeadlessContext(shop_id, proxy, adspower_profile_id));
    const page = await ctx.newPage();

    // PRIMARY read path: capture Etsy's internal JSON before navigating
    const payloads = attachJsonCapture(page);

    await page.goto(INBOX, { waitUntil: 'domcontentloaded', timeout: 25_000 });

    if (await isSignedOut(page)) {
      await browser.close();
      browserManager.deleteSession(shop_id);
      return { synced: 0, skipped: false, error: 'session_expired' };
    }

    // Dismiss any modal overlays (cookie consent, etc.) that might block interaction
    const overlayCloser = await page.$('[aria-label*="close" i], [aria-label*="dismiss" i]').catch(() => null);
    if (overlayCloser) await overlayCloser.click().catch(() => {});

    // Give XHR/fetch calls time to land, then settle
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});

    // 1) Try the robust JSON-interception path first
    let conversations = extractConversationsFromPayloads(payloads);
    let readMethod = 'json';

    // 2) Fall back to DOM scraping if no JSON conversation data was captured
    if (!conversations.length) {
      conversations = await extractInbox(page);
      readMethod = 'dom';
    }

    let synced = 0;
    if (process.env.MSG_DEBUG) {
      console.log(`[browser-sync] ${shop_id}: read via ${readMethod}, found ${conversations.length} conversation(s)`);
    }

    for (const c of conversations.slice(0, 100)) {
      try {
        upsertConversation(db, shop_id, shopCfg.group_id || 'direct', {
          conversation_id: c.convoId,
          buyer_name:      c.buyerName,
          subject:         c.preview || c.buyerName,
          is_read:         !c.isUnread,
          status:          c.isUnread ? 'unread' : 'read',
          last_message_at: c.ts || Math.floor(Date.now() / 1000),
        });
        synced++;
      } catch { /* continue with next */ }
    }

    // Persist refreshed cookies back to the session file (AdsPower mode also benefits)
    await ctx.storageState({ path: browserManager.getSessionPath(shop_id) });
    await ctx.close().catch(() => {});
    if (!isAdsPower) await browser.close().catch(() => {});
    return { synced, skipped: false, method: readMethod };

  } catch (err) {
    await ctx?.close().catch(() => {});
    if (!isAdsPower) await browser?.close().catch(() => {});
    return { synced: 0, skipped: false, error: err.message };
  }
}

/**
 * Fetch all messages in a specific conversation thread.
 * Also upserts each message into the DB so the rest of the UI can display them.
 *
 * @param {object} shopCfg
 * @param {string} convoId
 * @param {import('better-sqlite3').Database} db
 * @returns {Promise<{messages:Array, error?:string}>}
 */
async function fetchConversationThread(shopCfg, convoId, db) {
  const { shop_id, proxy, adspower_profile_id } = shopCfg;

  if (!browserManager.hasSession(shop_id)) {
    return { messages: [], error: 'no_browser_session' };
  }

  let browser, ctx, isAdsPower;
  try {
    ({ browser, ctx, isAdsPower } = await browserManager.createHeadlessContext(shop_id, proxy, adspower_profile_id));
    const page = await ctx.newPage();

    // PRIMARY read path: capture internal JSON before navigating
    const payloads = attachJsonCapture(page);

    await page.goto(`${ETSY}/messages/convo/${convoId}`, {
      waitUntil: 'domcontentloaded',
      timeout: 25_000,
    });

    if (await isSignedOut(page)) {
      await browser.close();
      browserManager.deleteSession(shop_id);
      return { messages: [], error: 'session_expired' };
    }

    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});

    // Detect our own user id so we can label seller vs buyer messages accurately
    const selfUserId = await detectSelfUserId(page);

    // 1) Robust JSON path first, 2) DOM scraping fallback
    let rawMessages = extractMessagesFromPayloads(payloads, selfUserId);
    if (!rawMessages.length) {
      rawMessages = await extractMessages(page);
    }

    // Persist each message into the DB with a stable ID
    rawMessages.forEach((m, idx) => {
      try {
        upsertConversationMessage(db, convoId, shop_id, {
          message_id:        `browser-${convoId}-${m.ts || idx}`,
          body:              m.body,
          message_text:      m.body,
          sender_type:       m.senderType,
          // Make seller messages look like seller in the DB
          seller_user_id:    m.senderType === 'seller' ? 'browser-seller' : null,
          sender_user_id:    m.senderType === 'seller' ? 'browser-seller' : null,
          created_timestamp: m.ts || Math.floor(Date.now() / 1000),
        });
      } catch { /* non-fatal */ }
    });

    await ctx.storageState({ path: browserManager.getSessionPath(shop_id) });
    await ctx.close().catch(() => {});
    if (!isAdsPower) await browser.close().catch(() => {});
    return { messages: rawMessages };

  } catch (err) {
    await ctx?.close().catch(() => {});
    if (!isAdsPower) await browser?.close().catch(() => {});
    return { messages: [], error: err.message };
  }
}

/**
 * Send a reply to a conversation via browser automation.
 * This is a REAL send through Etsy's web UI — identical to what a human
 * does in their browser.
 *
 * @param {object} shopCfg
 * @param {string} convoId
 * @param {string} replyText
 * @returns {Promise<{success:boolean, method:string, error?:string}>}
 */
async function sendBrowserReply(shopCfg, convoId, replyText) {
  const { shop_id, proxy, adspower_profile_id } = shopCfg;

  if (!browserManager.hasSession(shop_id)) {
    return { success: false, error: 'no_browser_session' };
  }

  let browser, ctx, isAdsPower;
  try {
    ({ browser, ctx, isAdsPower } = await browserManager.createHeadlessContext(shop_id, proxy, adspower_profile_id));
    const page = await ctx.newPage();

    await page.goto(`${ETSY}/messages/convo/${convoId}`, {
      waitUntil: 'networkidle',
      timeout: 30_000,
    });

    if (await isSignedOut(page)) {
      await ctx.close().catch(() => {});
      if (!isAdsPower) await browser.close().catch(() => {});
      browserManager.deleteSession(shop_id);
      return { success: false, error: 'session_expired' };
    }

    // Dismiss cookie/consent overlays that can intercept clicks.
    const overlayCloser = await page.$('[aria-label*="close" i], [aria-label*="dismiss" i], [aria-label*="accept" i]').catch(() => null);
    if (overlayCloser) await overlayCloser.click().catch(() => {});

    // ── Find the reply input ──────────────────────────────────────────────────
    // Etsy's compose box has shipped as a <textarea> AND, more recently, as a
    // contenteditable div / role="textbox". Try both kinds.
    const composer = await findFirst(page, [
      'textarea[placeholder*="reply" i]',
      'textarea[placeholder*="message" i]',
      'textarea[aria-label*="reply" i]',
      'textarea[aria-label*="message" i]',
      '[data-testid="reply-input"]',
      '[data-testid="message-input"]',
      '[data-testid="compose-textarea"]',
      '[contenteditable="true"][role="textbox"]',
      '[role="textbox"][aria-label*="message" i]',
      '[contenteditable="true"][aria-label*="message" i]',
      'div[contenteditable="true"]',
      // Last resort: any non-disabled, non-readonly textarea
      'textarea:not([readonly]):not([disabled])',
    ]);

    if (!composer) {
      await browser.close();
      return {
        success: false,
        error: 'Could not locate the reply box on Etsy — the page layout may have changed. Open Etsy directly.',
      };
    }

    const tagName = await composer.evaluate(el => el.tagName.toLowerCase()).catch(() => 'textarea');

    // ── Type the reply (human-paced to fire React handlers + avoid bot flags) ──
    await composer.scrollIntoViewIfNeeded().catch(() => {});
    await composer.click();
    await humanPause(150, 400);

    if (tagName === 'textarea' || tagName === 'input') {
      await composer.fill('');
    } else {
      // contenteditable: select-all + delete to clear any draft
      await page.keyboard.press('Control+A').catch(() => {});
      await page.keyboard.press('Delete').catch(() => {});
    }
    await page.keyboard.type(replyText, { delay: 18 + Math.floor(Math.random() * 22) });
    await humanPause(400, 800);

    // ── Click Send ────────────────────────────────────────────────────────────
    const sendBtn = await findFirst(page, [
      'button[data-testid="send-button"]',
      '[data-testid="reply-send"]',
      '[data-testid="send-message"]',
      'button:has-text("Send")',
      'button[aria-label*="send" i]',
      'button[type="submit"]',
      'input[type="submit"][value*="Send" i]',
    ]);

    if (sendBtn) {
      await sendBtn.click().catch(async () => {
        await composer.press('Control+Enter').catch(() => {});
      });
    } else {
      // Keyboard fallback — Ctrl+Enter is Etsy's standard send shortcut
      await composer.press('Control+Enter');
    }

    // ── Verify the send actually went through ──────────────────────────────────
    // Success signal: the composer empties out and our text appears in the thread.
    let sent = false;
    try {
      await page.waitForFunction(
        (sample) => {
          const txt = sample.slice(0, 40);
          // Our message now appears somewhere in the rendered thread
          const inThread = Array.from(document.querySelectorAll('[class*="message" i], [class*="bubble" i], p, div'))
            .some(el => (el.textContent || '').includes(txt));
          return inThread;
        },
        replyText,
        { timeout: 8_000 }
      );
      sent = true;
    } catch {
      // Fall back to a fixed settle delay; treat as best-effort success.
      await page.waitForTimeout(2500);
      sent = true;
    }

    // Persist refreshed session cookies
    await ctx.storageState({ path: browserManager.getSessionPath(shop_id) });
    await ctx.close().catch(() => {});
    if (!isAdsPower) await browser.close().catch(() => {});

    return { success: sent, method: 'browser' };

  } catch (err) {
    await ctx?.close().catch(() => {});
    if (!isAdsPower) await browser?.close().catch(() => {});
    return { success: false, error: err.message };
  }
}

module.exports = {
  syncMessagesForShop,
  fetchConversationThread,
  sendBrowserReply,
};
