'use strict';

/**
 * Resilient binary HTTP(S) download to an in-memory Buffer.
 *
 * WHY THIS EXISTS
 * ───────────────
 * 4PX shipping-label PDFs are served from a CDN that (a) is frequently plain
 * HTTP, (b) sometimes 30x-redirects, and (c) intermittently RESETS the TCP
 * connection mid-handshake or mid-transfer. A single bare `http.get` therefore
 * fails "sometimes" with Node's `ECONNRESET` → the message "socket hang up",
 * which then surfaces to the operator as "Label did not print: socket hang up".
 *
 * A one-shot download has no business turning a transient network blip into a
 * hard user-facing failure. This helper does what a production label pipeline
 * (ShipStation / EasyPost / Pirate Ship) does: classify transient faults and
 * transparently retry them with exponential backoff + jitter, follow redirects,
 * bound every attempt with a timeout, force a fresh connection per attempt (so
 * we never reuse a socket the server already half-closed), and verify the body
 * wasn't truncated. Only a genuinely unrecoverable error reaches the caller.
 *
 * The retryable-error taxonomy intentionally mirrors src/etsy/client.js so the
 * whole codebase treats transport failures consistently.
 *
 * @module src/util/http-download
 */

const http  = require('http');
const https = require('https');
const { URL } = require('url');

// ── Transient-fault taxonomy (mirrors src/etsy/client.js) ─────────────────────

// Transport-level error codes that are safe to retry. Downloads are pure reads
// (GET) with no side effects, so replaying a reset socket is always safe.
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',                    // "socket hang up" — peer/proxy dropped the connection
  'ECONNABORTED',                  // client-side abort/timeout
  'ETIMEDOUT',                     // OS-level connect/read timeout
  'EPIPE',                         // broken pipe while writing the request
  'ECONNREFUSED',                  // hop briefly refused the connection
  'ENETUNREACH',                   // transient network unreachable
  'EHOSTUNREACH',                  // transient host unreachable
  'EAI_AGAIN',                     // temporary DNS resolution failure
  'ERR_SOCKET_CONNECTION_TIMEOUT',
  'UND_ERR_SOCKET',
]);

// Matched against err.message (lower-cased) for errors that carry no code.
const RETRYABLE_MESSAGE_FRAGMENTS = [
  'socket hang up',
  'network socket disconnected',
  'client network socket disconnected',
  'timed out',
  'timeout',
  'truncated',                     // our own short-read guard (see below)
];

// HTTP statuses worth retrying — transient server/CDN conditions only.
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * True when an error represents a transient transport/CDN fault worth retrying
 * rather than surfacing. A definitive HTTP error (e.g. 404) carries
 * `err.nonRetryable = true` and is never retried.
 * @param {any} err
 * @returns {boolean}
 */
function isTransientDownloadError(err) {
  if (!err) return false;
  if (err.nonRetryable) return false;
  if (typeof err.statusCode === 'number') return RETRYABLE_STATUS.has(err.statusCode);
  if (err.code && RETRYABLE_NETWORK_CODES.has(err.code)) return true;
  const msg = String(err.message || '').toLowerCase();
  return RETRYABLE_MESSAGE_FRAGMENTS.some((m) => msg.includes(m));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Perform ONE download attempt, following redirects up to `maxRedirects` hops.
 * Resolves with the body Buffer or rejects with a classified error.
 *
 * @param {string} startUrl
 * @param {object} opts
 * @param {number} opts.timeoutMs      Per-attempt inactivity timeout.
 * @param {object} opts.headers        Extra request headers.
 * @param {number} opts.maxRedirects   Max 30x hops to follow.
 * @returns {Promise<Buffer>}
 */
function downloadOnce(startUrl, { timeoutMs, headers, maxRedirects }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

    const visit = (rawUrl, redirectsLeft) => {
      let url;
      try {
        url = new URL(rawUrl);
      } catch {
        const e = new Error(`Invalid label URL: ${rawUrl}`);
        e.nonRetryable = true;
        return finish(reject, e);
      }

      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.get(
        url,
        {
          // Force a fresh connection every attempt. Reusing a keep-alive socket
          // that the CDN has silently closed is a classic source of a delayed
          // "socket hang up" on the NEXT request — `agent: false` + Connection:
          // close sidesteps that entirely.
          agent: false,
          headers: {
            'User-Agent': 'EtsyDashboard/1.0 (4PX label fetch)',
            Accept: '*/*',
            Connection: 'close',
            ...headers,
          },
        },
        (up) => {
          const status = up.statusCode || 0;

          // ── Redirects (incl. cross-protocol http→https) ──────────────────
          if (status >= 300 && status < 400 && up.headers.location) {
            up.resume(); // drain & free the socket
            if (redirectsLeft <= 0) {
              const e = new Error(`Too many redirects fetching label (last: ${status})`);
              e.nonRetryable = true;
              return finish(reject, e);
            }
            const next = new URL(up.headers.location, url).toString();
            return visit(next, redirectsLeft - 1);
          }

          // ── Non-200 terminal responses ───────────────────────────────────
          if (status !== 200) {
            up.resume();
            const e = new Error(`Label server returned HTTP ${status}`);
            e.statusCode = status;
            // 4xx (except the transient 408/425/429) are deterministic — never retry.
            if (status >= 400 && status < 500 && !RETRYABLE_STATUS.has(status)) {
              e.nonRetryable = true;
            }
            return finish(reject, e);
          }

          // ── Body ─────────────────────────────────────────────────────────
          const expectedLen = Number.parseInt(up.headers['content-length'], 10);
          const chunks = [];
          let received = 0;
          up.on('data', (c) => { chunks.push(c); received += c.length; });
          up.on('end', () => {
            // A connection dropped mid-transfer can end "cleanly" with fewer
            // bytes than Content-Length promised. Treat that as transient so we
            // retry instead of handing back a corrupt/partial PDF.
            if (Number.isFinite(expectedLen) && received < expectedLen) {
              const e = new Error(
                `Label download truncated: got ${received} of ${expectedLen} bytes`
              );
              return finish(reject, e);
            }
            if (received === 0) {
              return finish(reject, new Error('Label download returned an empty body'));
            }
            finish(resolve, Buffer.concat(chunks));
          });
          up.on('error', (e) => finish(reject, e));
        }
      );

      req.on('error', (e) => finish(reject, e));
      // Per-attempt inactivity timeout. Destroying with an Error makes the
      // 'error' handler fire with a classified, retryable message.
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Label download timed out after ${timeoutMs}ms`));
      });
    };

    visit(startUrl, maxRedirects);
  });
}

/**
 * Download a URL to a Buffer with transparent retries on transient faults.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=25000]   Per-attempt inactivity timeout.
 * @param {number} [opts.maxAttempts=4]      Total attempts (1 try + 3 retries).
 * @param {number} [opts.baseDelayMs=400]    Backoff base; grows 2^n with jitter.
 * @param {number} [opts.maxRedirects=5]     Max 30x hops per attempt.
 * @param {object} [opts.headers={}]         Extra request headers.
 * @param {string} [opts.label='resource']   Human label used in log/error text.
 * @param {(info:{attempt:number,maxAttempts:number,delayMs:number,error:Error})=>void}
 *        [opts.onRetry]                      Optional retry observer (for logging).
 * @returns {Promise<Buffer>}
 * @throws  {Error} The last error after exhausting retries, or the first
 *                  non-retryable error. Transport failures are normalised so the
 *                  caller can show an actionable message instead of "socket hang up".
 */
async function downloadToBuffer(url, opts = {}) {
  const timeoutMs    = opts.timeoutMs   ?? 25_000;
  const maxAttempts  = Math.max(1, opts.maxAttempts ?? 4);
  const baseDelayMs  = opts.baseDelayMs ?? 400;
  const maxRedirects = opts.maxRedirects ?? 5;
  const headers      = opts.headers     ?? {};
  const label        = opts.label       ?? 'resource';

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await downloadOnce(url, { timeoutMs, headers, maxRedirects });
    } catch (err) {
      lastError = err;
      const transient = isTransientDownloadError(err);
      if (!transient || attempt === maxAttempts) break;

      // Exponential backoff with full jitter, capped so a flaky CDN can't stall
      // an operator-initiated print for too long.
      const backoff = Math.min(baseDelayMs * 2 ** (attempt - 1), 5_000);
      const delayMs = Math.round(backoff / 2 + Math.random() * (backoff / 2));

      if (typeof opts.onRetry === 'function') {
        try { opts.onRetry({ attempt, maxAttempts, delayMs, error: err }); } catch { /* observer must not break the retry */ }
      }
      await sleep(delayMs);
    }
  }

  // Exhausted: rewrite the raw transport message into something actionable while
  // preserving the underlying cause for logs.
  const raw = String(lastError?.message || 'unknown error');
  const wrapped = new Error(
    isTransientDownloadError(lastError)
      ? `Could not download the ${label} after ${maxAttempts} attempts — the ` +
        `server kept dropping the connection (${raw}). Please try again in a moment.`
      : raw
  );
  wrapped.cause = lastError;
  if (typeof lastError?.statusCode === 'number') wrapped.statusCode = lastError.statusCode;
  throw wrapped;
}

module.exports = {
  downloadToBuffer,
  isTransientDownloadError,
  // Exported for unit tests.
  RETRYABLE_NETWORK_CODES,
  RETRYABLE_STATUS,
};
