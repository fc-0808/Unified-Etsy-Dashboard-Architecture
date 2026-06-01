'use strict';

/**
 * IMAP email sync engine for Etsy message notifications.
 *
 * Architecture
 * ─────────────
 * Each shop in config.json can declare an `email_imap` block containing
 * IMAP credentials for the Gmail (or other provider) account that receives
 * Etsy message notification emails.
 *
 * On every poll cycle this module:
 *   1. Connects to the IMAP server with TLS
 *   2. Searches for emails from @etsy.com in the last N days
 *   3. Parses each email with `mailparser`
 *   4. Extracts buyer name, message body, and conversation URL
 *   5. Upserts into the local conversations + conversation_messages tables
 *   6. Disconnects cleanly
 *
 * The upsert is idempotent — re-processing the same email writes the same
 * row (matched by the email's Message-ID header), so duplicate calls are safe.
 *
 * Supported providers
 * ────────────────────
 * Gmail:   host=imap.gmail.com  port=993  secure=true  (App Password required)
 * Outlook: host=outlook.office365.com  port=993  secure=true
 * Yahoo:   host=imap.mail.yahoo.com    port=993  secure=true  (App Password required)
 *
 * Gmail App Password setup:
 *   Google Account → Security → 2-Step Verification → App Passwords
 *   Choose "Mail" + "Windows Computer" → copy the 16-char code.
 *   Use that code as `password` in config.json — NOT your regular Gmail password.
 */

const { ImapFlow }    = require('imapflow');
const { simpleParser } = require('mailparser');
const { parseEtsyEmail } = require('./parser');
const { upsertConversation, upsertConversationMessage } = require('../db/setup');

/** Milliseconds to wait between reconnect attempts after a transient error. */
const RECONNECT_DELAY_MS = 5_000;

/** Maximum emails fetched and processed in a single sync pass. */
const MAX_EMAILS_PER_PASS = 100;

/** How many days back to search for Etsy notification emails. */
const LOOKBACK_DAYS = 30;

/**
 * Build an ImapFlow client from a shop's `email_imap` config block.
 *
 * @param {object} emailCfg
 * @returns {ImapFlow}
 */
function buildImapClient(emailCfg) {
  const port   = emailCfg.port ?? 993;
  const secure = emailCfg.secure !== false && port !== 143;

  return new ImapFlow({
    host:   emailCfg.host     || 'imap.gmail.com',
    port,
    secure,
    auth: {
      user: emailCfg.user,
      pass: emailCfg.password,
    },
    // Suppress verbose imapflow debug logs — errors still surface via thrown exceptions
    logger: false,
    // Connection-level timeout (ms) — prevents silent hangs on bad proxy/network
    socketTimeout: 30_000,
    connectionTimeout: 15_000,
  });
}

/**
 * Sync Etsy message notification emails for a single shop.
 *
 * @param {object}   shopCfg    - Shop entry from config.json (with group_id attached by getAllShops)
 * @param {import('better-sqlite3').Database} db
 * @param {object}   [opts]
 * @param {boolean}  [opts.unseenOnly=false]  - If true, only fetch UNSEEN emails (faster, may miss
 *                                              emails already marked read by your email client).
 *                                              Default: false — fetches all from the last LOOKBACK_DAYS.
 * @returns {Promise<{ synced: number, skipped: boolean, reason?: string, error?: string }>}
 */
async function syncEmailsForShop(shopCfg, db, opts = {}) {
  const emailCfg = shopCfg.email_imap;

  if (!emailCfg?.user || !emailCfg?.password) {
    return { synced: 0, skipped: true, reason: 'no_email_config' };
  }

  const client = buildImapClient(emailCfg);
  let synced  = 0;
  let skipped = 0;

  try {
    await client.connect();

    const lock = await client.getMailboxLock('INBOX');

    try {
      const sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - LOOKBACK_DAYS);

      // Build the IMAP search criteria
      const searchCriteria = opts.unseenOnly
        ? { from: 'etsy.com', since: sinceDate, seen: false }
        : { from: 'etsy.com', since: sinceDate };

      const uids = await client.search(searchCriteria, { uid: true });

      if (!uids || uids.length === 0) {
        return { synced: 0, skipped: false };
      }

      // Process most-recent first; cap at MAX_EMAILS_PER_PASS
      const batch = uids.slice(-MAX_EMAILS_PER_PASS);

      for await (const msg of client.fetch(batch, { source: true, uid: true })) {
        try {
          const parsed = await simpleParser(msg.source);
          const result = parseEtsyEmail(parsed, shopCfg.shop_id);

          if (!result) {
            skipped++;
            continue;
          }

          upsertConversation(db, shopCfg.shop_id, shopCfg.group_id || 'direct', result.conversation);
          upsertConversationMessage(db, String(result.conversation.conversation_id), shopCfg.shop_id, result.message);
          synced++;
        } catch {
          skipped++;
        }
      }
    } finally {
      lock.release();
    }

    await client.logout();
    return { synced, skipped, skipped_flag: false };

  } catch (err) {
    // Attempt a clean disconnect regardless
    try { await client.logout(); } catch { /* ignore */ }

    // Classify the error so callers can surface a useful message
    const msg = err.message || '';
    if (msg.includes('Invalid credentials') || msg.includes('AUTHENTICATIONFAILED') || msg.includes('auth') || msg.includes('LOGIN')) {
      return { synced: 0, skipped: false, error: 'auth_failed', detail: 'IMAP credentials rejected. Check your app password in config.json.' };
    }
    if (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') || msg.includes('getaddrinfo')) {
      return { synced: 0, skipped: false, error: 'connection_failed', detail: `Cannot reach ${emailCfg.host || 'imap.gmail.com'}. Check host/port settings.` };
    }

    return { synced: 0, skipped: false, error: 'unknown', detail: msg };
  }
}

/**
 * Sync all shops that have `email_imap` configured.
 * Runs in sequence (one shop at a time) to avoid hammering Gmail rate limits.
 *
 * @param {Array<object>}  allShops   - Output of getAllShops(config)
 * @param {import('better-sqlite3').Database} db
 * @param {Function}       [notify]   - Optional callback(shopId, result) for real-time UI updates
 * @returns {Promise<{ totalSynced: number, results: Array }>}
 */
async function syncAllShopEmails(allShops, db, notify) {
  const results = [];
  let totalSynced = 0;

  for (const shop of allShops) {
    if (!shop.email_imap?.user) continue;

    try {
      const result = await syncEmailsForShop(shop, db);
      results.push({ shop_id: shop.shop_id, ...result });
      totalSynced += result.synced || 0;

      if (notify) notify(shop.shop_id, result);
    } catch (err) {
      results.push({ shop_id: shop.shop_id, error: 'unexpected', detail: err.message });
      if (notify) notify(shop.shop_id, { error: 'unexpected', detail: err.message });
    }

    // Brief pause between shops to be polite to the IMAP server
    await new Promise(r => setTimeout(r, 500));
  }

  return { totalSynced, results };
}

module.exports = {
  syncEmailsForShop,
  syncAllShopEmails,
  LOOKBACK_DAYS,
  MAX_EMAILS_PER_PASS,
};
