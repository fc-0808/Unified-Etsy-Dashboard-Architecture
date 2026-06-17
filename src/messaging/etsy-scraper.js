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
 * Detect Etsy's anti-bot "Access is temporarily restricted" interstitial.
 *
 * Etsy (via its HUMAN/PerimeterX bot defense) serves a near-empty page titled
 * "etsy.com" with the text "Access is temporarily restricted" and an offending
 * IP when it flags the request as automated. This happens most often when:
 *   - the browser is headless, and/or
 *   - the egress IP is a datacenter/VPN/Tor address rather than residential.
 *
 * When this page is shown there are zero conversation links, so the scraper
 * would otherwise silently return "0 conversations". We must surface it instead.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{restricted:boolean, ip?:string, refId?:string}>}
 */
async function detectAccessRestricted(page) {
  try {
    const info = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      const title = (document.title || '').trim().toLowerCase();

      // Direct text match (soft "Access is temporarily restricted" page).
      const textMatch = /access is temporarily restricted|verification required|unusual activity|detected (bot|automated)|slide right to secure/i.test(text);

      // CAPTCHA/challenge variant: the puzzle renders inside an iframe, so the
      // top document body is nearly empty and the title collapses to "etsy.com".
      // Real Etsy pages have a descriptive <title> and substantial body text.
      const hasChallengeIframe = Array.from(document.querySelectorAll('iframe'))
        .some(f => /captcha|px-captcha|perimeterx|hcaptcha|recaptcha|challenge/i.test(
          (f.src || '') + ' ' + (f.id || '') + ' ' + (f.title || '')
        ));
      const looksEmptyChallenge = title === 'etsy.com'
        && text.trim().length < 40
        && document.querySelectorAll('a').length < 5;

      const restricted = textMatch || hasChallengeIframe || looksEmptyChallenge;

      const ipMatch  = text.match(/IP\s+(\d{1,3}(?:\.\d{1,3}){3})/i);
      const refMatch = text.match(/ID:\s*([0-9a-f-]{8,})/i);
      return {
        restricted,
        ip:    ipMatch ? ipMatch[1] : null,
        refId: refMatch ? refMatch[1] : null,
      };
    });
    return { restricted: !!info.restricted, ip: info.ip, refId: info.refId };
  } catch {
    return { restricted: false };
  }
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
 * Navigate to a deep Etsy URL the way a human would: land on the Etsy homepage
 * first (establishing a normal browsing session + warming cookies), pause
 * briefly, then move to the target. Jumping straight to a deep link like
 * /messages/{id} on a cold context is a strong bot signal that triggers Etsy's
 * "Verification Required" challenge — this warmup materially reduces that.
 *
 * Best-effort: any failure here is swallowed and the caller proceeds to its own
 * goto/checks.
 *
 * @param {import('playwright').Page} page
 * @param {string} targetUrl
 * @param {{ waitUntil?: string, timeout?: number }} [opts]
 */
async function navigateHuman(page, targetUrl, opts = {}) {
  const { waitUntil = 'domcontentloaded', timeout = 25_000 } = opts;
  try {
    // Only warm up if we're not already on an etsy.com page.
    const cur = page.url();
    if (!/etsy\.com/i.test(cur)) {
      await page.goto(`${ETSY}/`, { waitUntil: 'domcontentloaded', timeout }).catch(() => {});
      await humanPause(800, 1800);
      // A little scroll makes the session look interactive rather than scripted.
      await page.mouse.wheel(0, 300 + Math.floor(Math.random() * 400)).catch(() => {});
      await humanPause(400, 900);
    }
  } catch { /* non-fatal */ }
  await page.goto(targetUrl, { waitUntil, timeout });
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
 * PRIMARY inbox read path for the current Etsy Shop Manager.
 *
 * Etsy's Shop Manager Messages page (/messages/inbox) bootstraps the full
 * conversation list as JSON inside an inline <script> tag, under:
 *   ...,"initial_data":{"hasConversationsData":true,"conversations":[ {…}, … ]}
 *
 * Each conversation object looks like:
 *   {
 *     "conversation_id": 1678691087,
 *     "excerpt": "Huh? I thought I ordered the case…",
 *     "is_unread": false,
 *     "message_count": 16,
 *     "timestamp": "2 days ago",
 *     "conversation_url": "/messages/1678691087",
 *     "other_user": { "display_name": "Aryan", "username": "…", … }
 *   }
 *
 * Parsing this blob is dramatically more reliable than DOM scraping because
 * the rows are a virtualized list with hashed class names and no convo anchors.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<Array<{convoId:string, buyerName:string, preview:string, ts:number, isUnread:boolean, messageCount:number}>>}
 */
async function extractInboxFromBootstrap(page) {
  try {
    const conversations = await page.evaluate(() => {
      // String-aware scanner: find the matching close bracket for an array,
      // ignoring brackets that appear inside JSON string values.
      const matchArray = (text, openIdx) => {
        let depth = 0, inStr = false, esc = false;
        for (let i = openIdx; i < text.length; i++) {
          const ch = text[i];
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') { inStr = !inStr; continue; }
          if (inStr) continue;
          if (ch === '[') depth++;
          else if (ch === ']') { depth--; if (depth === 0) return i; }
        }
        return -1;
      };

      const scripts = Array.from(document.querySelectorAll('script'));
      for (const s of scripts) {
        const t = s.textContent || '';
        if (!t.includes('hasConversationsData') || !t.includes('"conversations"')) continue;

        const marker = '"conversations":[';
        const mi = t.indexOf(marker);
        if (mi === -1) continue;

        const openIdx = mi + marker.length - 1;      // index of '['
        const closeIdx = matchArray(t, openIdx);
        if (closeIdx === -1) continue;

        const arrStr = t.slice(openIdx, closeIdx + 1);
        try {
          return JSON.parse(arrStr);
        } catch {
          /* try next script */
        }
      }
      return null;
    });

    if (!Array.isArray(conversations)) return [];

    const now = Math.floor(Date.now() / 1000);
    return conversations.map((c, idx) => {
      // conversation_url is "/messages/1678691087"; conversation_id is numeric.
      const convoId = String(
        c.conversation_id ??
        (c.conversation_url || '').match(/\/messages\/(\d+)/)?.[1] ??
        ''
      );
      return {
        convoId,
        buyerName: c.other_user?.display_name || c.title || 'Etsy user',
        preview: c.excerpt || '',
        // Relative timestamps ("2 days ago") can't be parsed precisely; the
        // array is already newest-first, so preserve order with a descending ts.
        ts: now - idx,
        isUnread: !!c.is_unread,
        messageCount: c.message_count || 0,
      };
    }).filter(c => c.convoId);
  } catch {
    return [];
  }
}

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
 * PRIMARY thread read path: parse the messages bootstrap JSON on /messages/{id}.
 *
 * Etsy embeds the full message list as JSON in an inline <script>:
 *   ..."messages":[ { "message": "<html body>", "sender_id": 1060104094,
 *                     "create_date": 1780474817, "conversation_message_id": 7408796029,
 *                     "is_system_message": false, ... }, … ]
 *
 * The seller's own messages have sender_id === the logged-in user id (exposed as
 * <html data-user-id="…">). Message bodies are HTML (with <br/> and entities).
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<Array<{messageId:string, body:string, senderType:'buyer'|'seller', ts:number}>>}
 */
async function extractMessagesFromBootstrap(page) {
  try {
    const raw = await page.evaluate(() => {
      const matchArray = (text, openIdx) => {
        let depth = 0, inStr = false, esc = false;
        for (let i = openIdx; i < text.length; i++) {
          const ch = text[i];
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') { inStr = !inStr; continue; }
          if (inStr) continue;
          if (ch === '[') depth++;
          else if (ch === ']') { depth--; if (depth === 0) return i; }
        }
        return -1;
      };

      const selfUserId = document.documentElement.getAttribute('data-user-id') || null;

      const scripts = Array.from(document.querySelectorAll('script'));
      for (const s of scripts) {
        const t = s.textContent || '';
        const key = '"messages":[';
        const mi = t.indexOf(key);
        if (mi === -1) continue;
        // Make sure this looks like the conversation messages array
        if (!t.includes('conversation_message_id')) continue;

        const openIdx = mi + key.length - 1;
        const closeIdx = matchArray(t, openIdx);
        if (closeIdx === -1) continue;

        try {
          const arr = JSON.parse(t.slice(openIdx, closeIdx + 1));
          if (Array.isArray(arr) && arr.length) return { arr, selfUserId };
        } catch { /* try next */ }
      }
      return { arr: null, selfUserId };
    });

    if (!raw || !Array.isArray(raw.arr)) return [];

    const self = raw.selfUserId ? String(raw.selfUserId) : null;

    // Decode Etsy's HTML message body into clean plain text.
    const decode = (html) => {
      if (!html) return '';
      let s = String(html)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, '');
      // Decode common HTML entities
      const ents = { '&amp;': '&', '&#39;': "'", '&quot;': '"', '&lt;': '<', '&gt;': '>', '&nbsp;': ' ' };
      s = s.replace(/&amp;|&#39;|&quot;|&lt;|&gt;|&nbsp;/g, m => ents[m] || m);
      s = s.replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(+n); } catch { return _; } });
      return s.trim();
    };

    return raw.arr
      .filter(m => !m.is_system_message)
      .map(m => ({
        messageId: String(m.conversation_message_id || ''),
        body: decode(m.message),
        senderType: (self && String(m.sender_id) === self) ? 'seller' : 'buyer',
        ts: m.create_date || 0,
      }))
      .filter(m => m.body);
  } catch {
    return [];
  }
}

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

    await navigateHuman(page, INBOX, { waitUntil: 'domcontentloaded', timeout: 25_000 });

    if (await isSignedOut(page)) {
      await ctx.close().catch(() => {});
      if (!isAdsPower) await browser.close().catch(() => {});
      browserManager.deleteSession(shop_id);
      return { synced: 0, skipped: false, error: 'session_expired' };
    }

    // Etsy bot-block interstitial — surface it instead of silently returning 0.
    const block = await detectAccessRestricted(page);
    if (block.restricted) {
      await ctx.close().catch(() => {});
      if (!isAdsPower) await browser.close().catch(() => {});
      return {
        synced: 0,
        skipped: false,
        error: 'access_restricted',
        blocked_ip: block.ip || null,
        ref_id: block.refId || null,
      };
    }

    // Dismiss any modal overlays (cookie consent, etc.) that might block interaction
    const overlayCloser = await page.$('[aria-label*="close" i], [aria-label*="dismiss" i]').catch(() => null);
    if (overlayCloser) await overlayCloser.click().catch(() => {});

    // Give XHR/fetch calls time to land, then settle
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});

    // 1) PRIMARY: parse the inbox bootstrap JSON embedded in the page (most
    //    reliable for the current Etsy Shop Manager Messages UI).
    let conversations = await extractInboxFromBootstrap(page);
    let readMethod = 'bootstrap';

    // 2) Try the network JSON-interception path
    if (!conversations.length) {
      conversations = extractConversationsFromPayloads(payloads);
      readMethod = 'json';
    }

    // 3) Fall back to DOM scraping
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

    // Current Etsy thread URL is /messages/{id} (NOT /messages/convo/{id}).
    await navigateHuman(page, `${ETSY}/messages/${convoId}`, {
      waitUntil: 'domcontentloaded',
      timeout: 25_000,
    });

    if (await isSignedOut(page)) {
      await ctx.close().catch(() => {});
      if (!isAdsPower) await browser.close().catch(() => {});
      browserManager.deleteSession(shop_id);
      return { messages: [], error: 'session_expired' };
    }

    const block = await detectAccessRestricted(page);
    if (block.restricted) {
      await ctx.close().catch(() => {});
      if (!isAdsPower) await browser.close().catch(() => {});
      return { messages: [], error: 'access_restricted', blocked_ip: block.ip || null };
    }

    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});

    // 1) PRIMARY: parse the messages bootstrap JSON embedded in the page.
    let rawMessages = await extractMessagesFromBootstrap(page);

    // 2) Network JSON interception, 3) DOM scraping fallback
    if (!rawMessages.length) {
      const selfUserId = await detectSelfUserId(page);
      rawMessages = extractMessagesFromPayloads(payloads, selfUserId);
      if (!rawMessages.length) rawMessages = await extractMessages(page);
    }

    // Persist each message into the DB with a stable ID
    rawMessages.forEach((m, idx) => {
      try {
        upsertConversationMessage(db, convoId, shop_id, {
          message_id:        m.messageId || `browser-${convoId}-${m.ts || idx}`,
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

    // Current Etsy thread URL is /messages/{id} (NOT /messages/convo/{id}).
    await navigateHuman(page, `${ETSY}/messages/${convoId}`, {
      waitUntil: 'networkidle',
      timeout: 30_000,
    });

    if (await isSignedOut(page)) {
      await ctx.close().catch(() => {});
      if (!isAdsPower) await browser.close().catch(() => {});
      browserManager.deleteSession(shop_id);
      return { success: false, error: 'session_expired' };
    }

    const block = await detectAccessRestricted(page);
    if (block.restricted) {
      await ctx.close().catch(() => {});
      if (!isAdsPower) await browser.close().catch(() => {});
      return { success: false, error: 'access_restricted', blocked_ip: block.ip || null };
    }

    // Dismiss cookie/consent overlays that can intercept clicks.
    const overlayCloser = await page.$('[aria-label*="close" i], [aria-label*="dismiss" i], [aria-label*="accept" i]').catch(() => null);
    if (overlayCloser) await overlayCloser.click().catch(() => {});

    // The compose box is rendered by React after hydration — wait for it.
    await page.waitForSelector(
      'textarea[placeholder*="reply" i], textarea.new-message-textarea-min-height, ' +
      'textarea:not([readonly]):not([disabled]), [contenteditable="true"][role="textbox"], div[contenteditable="true"]',
      { timeout: 15_000 }
    ).catch(() => {});

    // ── Find the reply input ──────────────────────────────────────────────────
    // Etsy's Shop Manager compose box is a <textarea placeholder="Type your reply">.
    // Older/other layouts used contenteditable; we support both.
    const composer = await findFirst(page, [
      'textarea[placeholder*="reply" i]',
      'textarea.new-message-textarea-min-height',
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
      await ctx.close().catch(() => {});
      if (!isAdsPower) await browser.close().catch(() => {});
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
    // Etsy's Shop Manager uses a filled primary button (often labelled "Send").
    const sendBtn = await findFirst(page, [
      'button[data-testid="send-button"]',
      '[data-testid="reply-send"]',
      '[data-testid="send-message"]',
      'button:has-text("Send")',
      'button[aria-label*="send" i]',
      'button.wt-btn--filled:has-text("Send")',
      'button.wt-btn--filled',
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
