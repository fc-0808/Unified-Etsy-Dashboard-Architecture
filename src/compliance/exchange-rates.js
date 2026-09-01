'use strict';

/**
 * Exchange rates for customs declarations.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The packing bench converts an order's value into the destination currency so
 * the packer can write it on a customs form. That conversion is the only thing
 * standing between "Declare GBP 22.00" and a notice that shows no figure at
 * all — which is what a packer sees the moment this feed is unavailable.
 *
 * A live HTTPS call to a third party is therefore the wrong thing to depend on
 * at render time, and depending on it silently is worse: the bench simply stops
 * naming a value, on one machine and not another, with nothing in the UI to say
 * why. This module exists so that never happens again:
 *
 *   1. LAST-GOOD TABLE ON DISK. Every successful fetch is written next to the
 *      database. It is read back on boot, so a station with no egress at all
 *      still converts — and because the file sits in the shared database
 *      directory, a station that CAN reach the internet keeps every other
 *      station supplied.
 *   2. THE PROXY THE REST OF THE APP USES. A direct connection is tried first;
 *      if it fails and a VPN SOCKS port is configured, the same local hop the
 *      Etsy sync relies on is tried next. A warehouse behind a filtered
 *      connection then works exactly where the rest of the dashboard works.
 *   3. FAILURE IS REPORTED, NOT SWALLOWED. The result always carries where the
 *      table came from and how old it is, so the caller can say "converted at a
 *      rate from 12 Aug" rather than implying it is today's.
 *   4. A BAD TABLE IS REFUSED. These numbers reach a customs form, so a payload
 *      that is not a plausible EUR-based table is rejected outright rather than
 *      cached over a good one.
 *
 * Rates are EUR-based: rates[X] is how many X you get for 1 EUR.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

/** Free, key-less, EUR-based daily reference rates. */
const SOURCE_URL = 'https://open.er-api.com/v6/latest/EUR';

/** A good table is reused for this long before we look for a newer one. */
const FRESH_MS = 6 * 60 * 60 * 1000;

/**
 * How soon a FAILED lookup is retried. Deliberately far shorter than FRESH_MS:
 * the old code left a boot-time failure in place until the process restarted,
 * which is precisely how one bad minute cost a whole shift its customs values.
 */
const RETRY_MS = 5 * 60 * 1000;

/** Past this age the UI must stop calling it "today's rate". */
const STALE_MS = 3 * 24 * 60 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 8000;
const CACHE_FILE = 'exchange-rates.json';
const CACHE_VERSION = 1;

/**
 * A table we would put in front of a packer.
 *
 * The published feed carries ~160 currencies with EUR pinned at exactly 1. A
 * response that does not look like that is a captive portal, an error page or a
 * truncated body — none of which may be cached over the last good table.
 *
 * @param {unknown} rates
 * @returns {{ ok: true, rates: Record<string, number> } | { ok: false, reason: string }}
 */
function validateRateTable(rates) {
  if (!rates || typeof rates !== 'object' || Array.isArray(rates)) {
    return { ok: false, reason: 'the response carried no rate table' };
  }
  const clean = {};
  for (const [code, value] of Object.entries(rates)) {
    // ISO-4217 codes only, and only finite positive numbers: a null or a string
    // would otherwise convert to NaN silently at the point of use.
    if (!/^[A-Z]{3}$/.test(code)) continue;
    const rate = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(rate) || rate <= 0) continue;
    clean[code] = rate;
  }
  if (Object.keys(clean).length < 20) {
    return { ok: false, reason: `only ${Object.keys(clean).length} usable currencies in the response` };
  }
  if (clean.EUR !== 1) {
    return { ok: false, reason: 'the table is not EUR-based (EUR is not exactly 1)' };
  }
  return { ok: true, rates: clean };
}

/**
 * One HTTPS GET returning a parsed JSON body, over an optional agent.
 * Rejects on transport error, timeout, non-200 and unparseable bodies alike —
 * every one of them is a reason to try the next route.
 */
function getJson(url, { agent = undefined, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { agent, headers: { Accept: 'application/json' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (err) {
          reject(new Error(`unparseable response (${err.message})`));
        }
      });
    });
    req.on('error', (err) => reject(new Error(err.code || err.message)));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`no response within ${timeoutMs}ms`));
    });
  });
}

/**
 * An agent that dials out through the local VPN's SOCKS5 port — the same first
 * hop the Etsy proxy chain uses. Returns null when no port is configured or the
 * agent library is unavailable, so the caller simply skips that route.
 *
 * socks-proxy-agent v10 is ESM-only, so this is a dynamic import rather than a
 * require: a require would throw ERR_REQUIRE_ESM, the hop would never be tried,
 * and a warehouse behind a filtered connection would look like it had no rates.
 */
async function socksAgentFor(vpnPort) {
  if (!vpnPort) return null;
  try {
    const mod = await import('socks-proxy-agent');
    const Agent = mod.SocksProxyAgent || mod.default;
    if (!Agent) return null;
    return new Agent(`socks5h://127.0.0.1:${vpnPort}`);
  } catch {
    return null;
  }
}

/**
 * A rate table with a memory.
 *
 * @param {object}   opts
 * @param {string}   opts.cacheDir      directory for the last-good table (the DB directory)
 * @param {number|null} [opts.vpnPort]  local SOCKS5 port to fall back to
 * @param {() => number} [opts.now]     injectable clock (tests)
 * @param {(url: string, opts: object) => Promise<object>} [opts.request]  injectable transport (tests)
 * @param {(msg: string) => void} [opts.log]
 */
function createRateStore({ cacheDir, vpnPort = null, now = Date.now, request = getJson, log = console.warn } = {}) {
  const cachePath = cacheDir ? path.join(cacheDir, CACHE_FILE) : null;

  /** @type {{ rates: Record<string, number>, fetchedAt: number, source: string }} */
  let table = { rates: {}, fetchedAt: 0, source: 'none' };
  let lastAttemptAt = null;
  let lastError = null;
  let loadedFromDisk = false;
  let inFlight = null;

  function readCache() {
    if (loadedFromDisk) return;
    loadedFromDisk = true;
    if (!cachePath) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      const checked = validateRateTable(parsed && parsed.rates);
      if (!checked.ok) {
        log(`[rates] ignoring the cached table at ${cachePath}: ${checked.reason}`);
        return;
      }
      const fetchedAt = Date.parse(parsed.fetched_at);
      table = { rates: checked.rates, fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : 0, source: 'cache' };
    } catch (err) {
      // ENOENT on a fresh install is normal and must not be noise.
      if (err.code !== 'ENOENT') log(`[rates] could not read ${cachePath}: ${err.message}`);
    }
  }

  function writeCache(rates, fetchedAt) {
    if (!cachePath) return;
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      const body = JSON.stringify({ version: CACHE_VERSION, base: 'EUR', fetched_at: new Date(fetchedAt).toISOString(), rates }, null, 1);
      // Write-then-rename: a station reading this file must never catch it half
      // written, because half a rate table still converts — wrongly.
      const tmp = `${cachePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, cachePath);
    } catch (err) {
      log(`[rates] could not cache the table to ${cachePath}: ${err.message}`);
    }
  }

  /** Try the open connection, then the VPN hop. Resolves to a clean table or null. */
  async function fetchTable() {
    const routes = [{ name: 'direct', agent: undefined }];
    const socks = await socksAgentFor(vpnPort);
    if (socks) routes.push({ name: `vpn:${vpnPort}`, agent: socks });

    const failures = [];
    for (const route of routes) {
      try {
        const body = await request(SOURCE_URL, { agent: route.agent, timeoutMs: REQUEST_TIMEOUT_MS });
        if (body && body.result && body.result !== 'success') throw new Error(String(body.result));
        const checked = validateRateTable(body && body.rates);
        if (!checked.ok) throw new Error(checked.reason);
        return { rates: checked.rates, route: route.name };
      } catch (err) {
        failures.push(`${route.name}: ${err.message}`);
      }
    }
    lastError = failures.join('; ');
    return null;
  }

  async function refresh() {
    lastAttemptAt = now();
    const fetched = await fetchTable();
    if (!fetched) {
      const held = Object.keys(table.rates).length
        ? `Holding the table from ${new Date(table.fetchedAt).toISOString()}.`
        : 'No cached table is available, so customs values cannot be converted until this succeeds.';
      log(`[rates] could not refresh exchange rates (${lastError}). ${held}`);
      return;
    }
    lastError = null;
    table = { rates: fetched.rates, fetchedAt: now(), source: fetched.route };
    writeCache(table.rates, table.fetchedAt);
  }

  /**
   * The current table, refreshing first when it is old enough to be worth
   * retrying. Never throws and never returns null: an empty table is a valid
   * answer meaning "we could not convert anything", which callers must render
   * as an absence rather than as a number.
   *
   * @returns {Promise<{ rates: Record<string, number>, fetched_at: string|null, age_ms: number|null, stale: boolean, source: string, error: string|null }>}
   */
  async function get() {
    readCache();
    const have = Object.keys(table.rates).length > 0;
    const age = have ? now() - table.fetchedAt : Infinity;
    const dueForRefresh = !have || age >= FRESH_MS;
    const retryElapsed = lastAttemptAt == null || now() - lastAttemptAt >= RETRY_MS;
    if (dueForRefresh && retryElapsed) {
      // One refresh at a time: a burst of page loads must not become a burst of
      // outbound requests, each waiting out its own timeout.
      inFlight = inFlight || refresh().finally(() => (inFlight = null));
      await inFlight;
    }
    return snapshot();
  }

  /** The table as it stands, with no network access. Safe to call synchronously. */
  function snapshot() {
    readCache();
    const have = Object.keys(table.rates).length > 0;
    const ageMs = have ? Math.max(0, now() - table.fetchedAt) : null;
    return {
      rates: table.rates,
      fetched_at: have && table.fetchedAt ? new Date(table.fetchedAt).toISOString() : null,
      age_ms: ageMs,
      stale: have ? ageMs > STALE_MS : false,
      source: have ? table.source : 'none',
      error: lastError,
    };
  }

  return { get, snapshot, cachePath };
}

/**
 * Convert between two currencies using an EUR-base table.
 * @returns {number|null} null when either currency is missing — never a guess.
 */
function convert(amount, fromCurrency, toCurrency, rates) {
  if (!Number.isFinite(amount) || !rates) return null;
  const from = rates[fromCurrency];
  const to = rates[toCurrency];
  if (!from || !to) return null;
  return (amount / from) * to;
}

module.exports = {
  createRateStore,
  validateRateTable,
  convert,
  SOURCE_URL,
  FRESH_MS,
  RETRY_MS,
  STALE_MS,
  CACHE_FILE,
};
