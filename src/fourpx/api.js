'use strict';

/**
 * 4PX Open Platform API — base HTTP client.
 *
 * Shared by src/fourpx/orders.js (shipping order creation) and any future
 * module that communicates with the official 4PX Open Platform.
 *
 * AUTHENTICATION
 * ─────────────
 * Every request requires an MD5 signature appended to the query-string.
 * Algorithm (from the official 4PX Go SDK at github.com/zengweigg/fourpx-express):
 *
 *   str  = "app_key" + KEY
 *         + "formatjson"
 *         + "method"    + METHOD
 *         + "timestamp" + TS
 *         + "v"         + VERSION
 *         + PARAM_JSON
 *         + SECRET
 *   sign = MD5(str).toLowerCase()
 *
 * REQUEST FORMAT
 * ─────────────
 * Method : POST https://open.4px.com/router/api/service
 * Query  : app_key, format=json, language=en, method, sign, timestamp, v
 * Body   : JSON-encoded business parameters
 *
 * RESPONSE FORMAT
 * ───────────────
 * The API returns { result: "1", data: {...} } on success.
 * Business errors are returned as { result: "0", message: "...", code: "..." }.
 * HTTP-level errors are rare — business errors ride on HTTP 200.
 *
 * @module src/fourpx/api
 */

const https  = require('https');
const crypto = require('crypto');

const FOURPX_HOST    = 'open.4px.com';
const FOURPX_PATH    = '/router/api/service';
// The ds.xms.* (Direct Shipping) family of methods this module talks to runs on
// API version 1.0.0. Calling them with v2.0.0 routes to a non-existent
// downstream service and returns "服务商接口404" (service provider interface 404).
// (Tracking methods tr.* use 2.0.0 but those live in src/tracking/checker.js.)
const FOURPX_VERSION = '1.0.0';

// ── Signature ────────────────────────────────────────────────────────────────

/**
 * Compute the 4PX Open Platform MD5 request signature.
 *
 * @param {string} appKey
 * @param {string} appSecret
 * @param {string} method       - API method name, e.g. "ds.xms.order.create"
 * @param {string} timestamp    - Millisecond epoch as a string
 * @param {string} version      - API version, e.g. "2.0.0"
 * @param {string} paramJson    - JSON-stringified request body
 * @returns {string}            - 32-char lowercase MD5 hex digest
 */
function computeSign(appKey, appSecret, method, timestamp, version, paramJson) {
  const raw =
    `app_key${appKey}` +
    `formatjson` +
    `method${method}` +
    `timestamp${timestamp}` +
    `v${version}` +
    paramJson +
    appSecret;
  return crypto.createHash('md5').update(raw, 'utf8').digest('hex');
}

// ── Core API caller ───────────────────────────────────────────────────────────

/**
 * Make an authenticated POST request to the 4PX Open Platform.
 *
 * @param {string} appKey
 * @param {string} appSecret
 * @param {string} method         - API method name
 * @param {object} [body={}]      - Business request payload
 * @param {object} [options]
 * @param {number} [options.timeoutMs=30000]
 * @param {string} [options.version]           - Override API version
 * @returns {Promise<object>}     - Resolved .data field from the API response
 * @throws  {Error}               - On network error, timeout, or API business error
 */
function callApi(appKey, appSecret, method, body = {}, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const version   = options.version   ?? FOURPX_VERSION;

  return new Promise((resolve, reject) => {
    const timestamp = Date.now().toString();
    const paramJson = JSON.stringify(body);
    const sign      = computeSign(appKey, appSecret, method, timestamp, version, paramJson);

    const qs = [
      `app_key=${encodeURIComponent(appKey)}`,
      `format=json`,
      `language=en`,
      `method=${encodeURIComponent(method)}`,
      `sign=${sign}`,
      `timestamp=${timestamp}`,
      `v=${encodeURIComponent(version)}`,
    ].join('&');

    let req;
    const timer = setTimeout(() => {
      req?.destroy(new Error(`4PX API timeout after ${timeoutMs}ms (method=${method})`));
    }, timeoutMs);

    req = https.request(
      {
        hostname: FOURPX_HOST,
        port:     443,
        path:     `${FOURPX_PATH}?${qs}`,
        method:   'POST',
        headers:  {
          'Content-Type':   'application/json;charset=UTF-8',
          'Content-Length': Buffer.byteLength(paramJson),
          'User-Agent':     'EtsyDashboard/1.0 (4PX OpenPlatform)',
          // CRITICAL: do NOT send `Accept: application/json`. The 4PX gateway
          // reacts to that exact value by transcoding its response body to ASCII,
          // which replaces every Chinese character (product names AND error
          // messages) with literal '?'. `Accept: */*` keeps the UTF-8 body intact.
          'Accept':         '*/*',
          'Accept-Charset': 'utf-8',
        },
      },
      (res) => {
        // Collect raw Buffers; decode as UTF-8 only after all chunks arrive.
        // Concatenating with += converts each chunk to a string independently,
        // which splits multi-byte sequences (e.g. Chinese error messages) at
        // chunk boundaries and produces garbage ("??????") instead of real text.
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          clearTimeout(timer);
          const raw = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = JSON.parse(raw);
          } catch {
            return reject(new Error(
              `4PX API returned non-JSON response for method "${method}": ` +
              raw.slice(0, 500)
            ));
          }
          // 4PX uses result="1" for success; anything else is a business error.
          if (json.result !== '1') {
            // The actionable detail lives in errors[].error_msg / error_code.
            // json.msg is only a generic header (e.g. "System processing failed").
            const firstErr = Array.isArray(json.errors) && json.errors.length
              ? json.errors[0]
              : null;
            const detailMsg  = firstErr?.error_msg  || firstErr?.errorMsg;
            const detailCode = firstErr?.error_code || firstErr?.errorCode;
            const errMsg =
              detailMsg || json.message || json.msg ||
              `4PX API error — result: ${json.result}`;
            const err   = new Error(errMsg);
            err.code    = detailCode || json.code || json.result;
            err.apiBody = json;
            return reject(err);
          }
          resolve(json.data ?? {});
        });
      }
    );

    req.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`4PX API network error (${method}): ${e.message}`));
    });

    req.write(paramJson);
    req.end();
  });
}

module.exports = { computeSign, callApi };
