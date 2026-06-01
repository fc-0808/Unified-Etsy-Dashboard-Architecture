'use strict';

/**
 * Etsy notification email parser.
 *
 * Etsy sends an email to the shop owner whenever a buyer sends a message.
 * This module detects those emails, extracts structured data from them,
 * and maps them to the conversations/conversation_messages schema.
 *
 * Supported email types:
 *   - "New Etsy message from {BuyerName}"
 *   - "{BuyerName} sent you an Etsy message"
 *   - Reply notifications for existing threads
 */

// All known Etsy sender domains
const ETSY_SENDER_DOMAINS = ['@etsy.com', '@sale.etsy.com', '@e.etsy.com', '@em.etsy.com'];

// Subject line → buyer name extraction patterns (ordered by specificity)
const SUBJECT_BUYER_PATTERNS = [
  /^new (?:etsy )?message from (.+?) on etsy$/i,
  /^new (?:etsy )?message from (.+?)$/i,
  /^(.+?) sent you an? (?:etsy )?message/i,
  /^re:\s*.+? - message from (.+?)$/i,
  /^message from (.+?) (?:about|regarding)/i,
];

// Conversation URL patterns Etsy uses in notification emails
const CONVO_URL_PATTERN = /https?:\/\/www\.etsy\.com\/(?:messages\/convo|conversations|convos)\/(\d+)/i;

// Signals the actual buyer message starts after this line in plain text
const MESSAGE_START_PATTERNS = [
  /^.+?\s+wrote:$/i,
  /^.+?\s+sent you a message:$/i,
  /^here(?:'s| is) (?:the|their) message:?$/i,
  /^message:$/i,
  /^new message:?$/i,
];

// Etsy email footer / boilerplate markers — content after these is discarded
const FOOTER_MARKERS = [
  'to ensure you receive',
  'unsubscribe',
  '© 20',
  'etsy, inc.',
  "don't want to receive",
  'privacy policy',
  'view this conversation',
  'reply to this message on etsy',
  'sent from etsy',
  'this email was sent',
  'manage your email preferences',
  '──────',
  '------',
  '______',
];

/**
 * Whether an email originates from Etsy's notification system.
 * @param {import('mailparser').ParsedMail} parsed
 * @returns {boolean}
 */
function isEtsyMessageNotification(parsed) {
  const fromText = (parsed.from?.text || '').toLowerCase();
  const subject  = (parsed.subject  || '').toLowerCase();

  if (!ETSY_SENDER_DOMAINS.some(d => fromText.includes(d))) return false;

  // Must reference a message or conversation in the subject
  return subject.includes('message') || subject.includes('convo');
}

/**
 * Extract the buyer's display name from the email subject line.
 * @param {string} subject
 * @returns {string|null}
 */
function extractBuyerName(subject) {
  for (const pattern of SUBJECT_BUYER_PATTERNS) {
    const m = subject.match(pattern);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

/**
 * Extract the Etsy conversation ID from the email body.
 * Scans both HTML and plain text for /messages/convo/{id} links.
 * @param {string} html
 * @param {string} text
 * @returns {string|null}
 */
function extractConvoId(html, text) {
  const m = (html + '\n' + text).match(CONVO_URL_PATTERN);
  return m ? m[1] : null;
}

/**
 * Build the canonical Etsy conversation URL from a conversation ID.
 * @param {string} convoId
 * @returns {string}
 */
function buildConvoUrl(convoId) {
  return `https://www.etsy.com/messages/convo/${convoId}`;
}

/**
 * Escape a string for use inside a RegExp.
 * @param {string} str
 * @returns {string}
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract the buyer's actual message body from the plain text version.
 *
 * Etsy notification emails follow a consistent structure:
 *   [Greeting/boilerplate]
 *   [BuyerName] wrote:
 *   [message body]
 *   [Etsy footer / CTA links]
 *
 * This function strips the framing and returns only the buyer's words.
 *
 * @param {string} text      - Parsed plain-text email body
 * @param {string|null} buyerName
 * @returns {string}
 */
function extractMessageBody(text, buyerName) {
  if (!text) return '';

  const lines = text.split(/\r?\n/).map(l => l.trim());

  // Build dynamic start patterns that include the buyer's name if we have it
  const dynamicPatterns = [...MESSAGE_START_PATTERNS];
  if (buyerName) {
    dynamicPatterns.unshift(new RegExp(`^${escapeRegex(buyerName)}\\s+wrote:?$`, 'i'));
    dynamicPatterns.unshift(new RegExp(`^${escapeRegex(buyerName)}\\s+sent you a message:?$`, 'i'));
  }

  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (dynamicPatterns.some(p => p.test(lines[i]))) {
      startIdx = i + 1;
      break;
    }
  }

  // Fallback: find the first long line that isn't boilerplate
  if (startIdx === -1) {
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].toLowerCase();
      if (
        lines[i].length > 25 &&
        !l.includes('etsy') &&
        !l.includes('notification') &&
        !l.includes('hi,') &&
        !l.startsWith('hello')
      ) {
        startIdx = i;
        break;
      }
    }
  }

  if (startIdx === -1 || startIdx >= lines.length) {
    return lines.slice(0, 6).join('\n').trim();
  }

  // Find where the Etsy footer begins
  let endIdx = lines.length;
  for (let i = startIdx; i < lines.length; i++) {
    const l = lines[i].toLowerCase();
    if (FOOTER_MARKERS.some(m => l.includes(m))) {
      endIdx = i;
      break;
    }
  }

  return lines
    .slice(startIdx, Math.min(endIdx, startIdx + 40))
    .join('\n')
    .trim();
}

/**
 * Parse a single email into the {conversation, message} shape expected by the DB layer.
 * Returns null if this is not an Etsy message notification or lacks a conversation ID.
 *
 * @param {import('mailparser').ParsedMail} parsed
 * @param {string} shopId
 * @returns {{ conversation: object, message: object } | null}
 */
function parseEtsyEmail(parsed, shopId) {
  if (!isEtsyMessageNotification(parsed)) return null;

  const subject  = parsed.subject || '';
  const buyerName = extractBuyerName(subject);
  const convoId   = extractConvoId(parsed.html || '', parsed.text || '');

  if (!convoId) return null;

  const body      = extractMessageBody(parsed.text || '', buyerName);
  const emailDate = parsed.date
    ? Math.floor(parsed.date.getTime() / 1000)
    : Math.floor(Date.now() / 1000);

  // Use the email's Message-ID header as the unique key so re-processing the
  // same email is idempotent (upsert will not create a duplicate row).
  const rawMsgId  = parsed.messageId || `${convoId}-${emailDate}`;
  const messageId = `email-${shopId}-${convoId}-${rawMsgId.replace(/[<>@\s]/g, '_')}`;

  return {
    conversation: {
      conversation_id: convoId,
      buyer_name:      buyerName,
      subject:         subject,
      is_read:         false,
      status:          'unread',
      last_message_at: emailDate,
      buyer_user_id:   null,
      receipt_id:      null,
    },
    message: {
      message_id:         messageId,
      body:               body || subject,
      message_text:       body || subject,
      sender_user_id:     null,  // null → treated as 'buyer' in upsertConversationMessage
      seller_user_id:     null,
      created_timestamp:  emailDate,
    },
  };
}

module.exports = {
  parseEtsyEmail,
  isEtsyMessageNotification,
  extractBuyerName,
  extractConvoId,
  extractMessageBody,
  buildConvoUrl,
};
