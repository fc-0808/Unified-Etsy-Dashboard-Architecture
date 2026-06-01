'use strict';

/**
 * Heuristic extractor for Etsy conversation/message data captured from the
 * browser's network traffic.
 *
 * Why heuristic?
 * ──────────────
 * Etsy's web app fetches conversation data from internal JSON endpoints, but
 * those URLs and exact shapes change without notice and are not documented.
 * Rather than hard-code an endpoint, we capture EVERY JSON response on the
 * messages pages and scan each payload for objects that "look like" a
 * conversation or a message. This survives endpoint renames and shape changes
 * far better than either a hard-coded URL or DOM scraping.
 *
 * Detection strategy
 * ──────────────────
 * We recursively walk every captured JSON value looking for arrays of objects.
 * An object is a CONVERSATION if it has a conversation-id-like key plus a
 * counterpart-name-like key. An object is a MESSAGE if it has a body/text key
 * plus a timestamp-like key. Field names are matched case-insensitively
 * against a set of known aliases.
 */

// Keys that identify a conversation id
const CONVO_ID_KEYS = ['conversation_id', 'convo_id', 'conversationid', 'id'];
// Keys that hold the other party's display name
const NAME_KEYS = ['other_user_display_name', 'other_user', 'display_name', 'login_name', 'username', 'name', 'buyer_name', 'from_name'];
// Keys that hold a message body
const BODY_KEYS = ['message', 'body', 'text', 'message_text', 'content', 'snippet', 'preview', 'last_message'];
// Keys that hold a timestamp
const TS_KEYS = ['create_date', 'created_timestamp', 'creation_tsz', 'last_message_date', 'timestamp', 'create_timestamp', 'sent_at', 'date'];
// Keys that indicate read/unread state
const READ_KEYS = ['is_read', 'read', 'was_read', 'has_unread', 'unread'];
// Keys that identify the sender (to classify buyer vs seller)
const SENDER_KEYS = ['sender_id', 'from_user_id', 'user_id', 'author_id', 'sender_user_id'];

/** Case-insensitive lookup of the first matching key in an object. */
function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  const lowerMap = {};
  for (const k of Object.keys(obj)) lowerMap[k.toLowerCase()] = obj[k];
  for (const want of keys) {
    const v = lowerMap[want.toLowerCase()];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

/** Normalize a timestamp value (seconds, ms, or ISO string) to epoch seconds. */
function toEpochSeconds(v) {
  if (v == null) return 0;
  if (typeof v === 'number') {
    // Heuristic: > 1e12 means milliseconds
    return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
  }
  const parsed = Date.parse(v);
  return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
}

/** A value that looks like a numeric/string id (not an object). */
function looksLikeId(v) {
  return (typeof v === 'number' && Number.isFinite(v)) ||
         (typeof v === 'string' && /^\d{3,}$/.test(v));
}

/** Decide whether an object looks like a conversation summary. */
function isConversationShape(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const id   = pick(obj, CONVO_ID_KEYS);
  const name = pick(obj, NAME_KEYS);
  // Must have an id-like value AND something resembling a counterpart name
  return looksLikeId(id) && typeof name === 'string' && name.length > 0;
}

/** Decide whether an object looks like an individual message. */
function isMessageShape(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const body = pick(obj, BODY_KEYS);
  const ts   = pick(obj, TS_KEYS);
  return typeof body === 'string' && body.length > 0 && ts !== undefined;
}

/**
 * Recursively collect arrays of objects matching a predicate.
 * @param {*} node
 * @param {(o:object)=>boolean} predicate
 * @param {object[]} acc
 * @param {number} depth
 */
function collectMatches(node, predicate, acc, depth = 0) {
  if (depth > 8 || node == null) return acc;

  if (Array.isArray(node)) {
    // If a majority of array items match, treat the whole array as a hit
    const objItems = node.filter(x => x && typeof x === 'object');
    const matching = objItems.filter(predicate);
    if (matching.length > 0 && matching.length >= Math.ceil(objItems.length / 2)) {
      acc.push(...matching);
    }
    // Still recurse into items for nested structures
    for (const item of node) collectMatches(item, predicate, acc, depth + 1);
    return acc;
  }

  if (typeof node === 'object') {
    for (const key of Object.keys(node)) {
      collectMatches(node[key], predicate, acc, depth + 1);
    }
  }
  return acc;
}

/**
 * Extract conversation summaries from an array of captured JSON payloads.
 * @param {object[]} payloads
 * @returns {Array<{convoId:string, buyerName:string, preview:string, ts:number, isUnread:boolean}>}
 */
function extractConversationsFromPayloads(payloads) {
  const byId = new Map();

  for (const payload of payloads) {
    const matches = collectMatches(payload, isConversationShape, []);
    for (const m of matches) {
      const convoId = String(pick(m, CONVO_ID_KEYS));
      if (!/^\d+$/.test(convoId)) continue;

      const buyerName = String(pick(m, NAME_KEYS) || 'Unknown Buyer').trim();
      const bodyVal   = pick(m, BODY_KEYS);
      const preview   = typeof bodyVal === 'string'
        ? bodyVal.slice(0, 200)
        : (typeof bodyVal === 'object' ? String(pick(bodyVal, BODY_KEYS) || '').slice(0, 200) : '');
      const ts        = toEpochSeconds(pick(m, TS_KEYS));

      const readVal = pick(m, READ_KEYS);
      // is_read true → read; has_unread/unread true → unread
      let isUnread = false;
      if (readVal !== undefined) {
        const keyUsed = READ_KEYS.find(k => pick(m, [k]) !== undefined);
        if (/unread/i.test(keyUsed || '')) isUnread = !!readVal;
        else isUnread = !readVal; // is_read/read/was_read
      }

      // Keep the richest record per convoId
      const existing = byId.get(convoId);
      if (!existing || (preview && !existing.preview) || (ts > existing.ts)) {
        byId.set(convoId, { convoId, buyerName, preview, ts, isUnread });
      }
    }
  }

  return Array.from(byId.values());
}

/**
 * Extract messages for a thread from captured JSON payloads.
 * @param {object[]} payloads
 * @param {string|number|null} sellerUserId  - The logged-in shop's user id, if known
 * @returns {Array<{body:string, senderType:'buyer'|'seller', ts:number, senderId:string|null}>}
 */
function extractMessagesFromPayloads(payloads, sellerUserId = null) {
  const seen = new Set();
  const out  = [];

  for (const payload of payloads) {
    const matches = collectMatches(payload, isMessageShape, []);
    for (const m of matches) {
      const body = String(pick(m, BODY_KEYS) || '').trim();
      if (!body) continue;

      const ts       = toEpochSeconds(pick(m, TS_KEYS));
      const senderId = pick(m, SENDER_KEYS);
      const dedupeKey = `${body.slice(0, 60)}|${ts}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      let senderType = 'buyer';
      if (sellerUserId != null && senderId != null && String(senderId) === String(sellerUserId)) {
        senderType = 'seller';
      }

      out.push({
        body,
        senderType,
        ts,
        senderId: senderId != null ? String(senderId) : null,
      });
    }
  }

  // Sort chronologically
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

module.exports = {
  extractConversationsFromPayloads,
  extractMessagesFromPayloads,
  // exported for unit testing
  isConversationShape,
  isMessageShape,
  collectMatches,
  toEpochSeconds,
};
