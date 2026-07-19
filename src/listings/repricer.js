'use strict';

/**
 * ShopRepricer — bulk-applies a per-style price map across every (or a chosen
 * subset of) live listing in a single shop.
 *
 * It re-uses the exact, battle-tested single-listing flow that powers the
 * manual restock button (GET inventory → mutate offerings → PUT inventory) and
 * iterates it over a whole shop, streaming progress to the UI over SSE in the
 * same shape BulkJobManager uses. Prices on these shops vary on the "Styles"
 * custom property (514), so a single style key (e.g. "Case+Charm") maps to all
 * of that listing's offerings for that style regardless of phone model.
 *
 * The local SQLite cache (listing_inventory + listings.price_amount) is patched
 * in-place after each successful PUT so the Listings table reflects new prices
 * immediately — no extra Etsy round-trip required.
 */

const { getListingInventory, updateListingInventory } = require('../etsy/client');
const { STYLE_KEYS } = require('./pricing');
const { styleKeyFromProps } = require('./shop-prices');

// Treat two prices as identical when within half a cent — avoids needless PUTs.
const PRICE_EPSILON = 0.005;

class ShopRepricer {
  /**
   * @param {object} deps
   * @param {import('better-sqlite3').Database} deps.db
   * @param {(shopName:string)=>Promise<{shopClient:any,numericShopId:number,shopCfg:object,scopes:string[]|null}>} deps.resolveShopClient
   */
  constructor({ db, resolveShopClient }) {
    this.db = db;
    this.resolveShopClient = resolveShopClient;
    this._jobs = new Map();        // job_id → live job summary
    this._subscribers = new Map(); // job_id → Set<res>
    this._seq = 0;
  }

  /** Keep only known styles with a finite, positive price (rounded to cents). */
  _sanitizePrices(prices) {
    const clean = {};
    for (const key of STYLE_KEYS) {
      const v = Number(prices?.[key]);
      if (Number.isFinite(v) && v > 0) clean[key] = Math.round(v * 100) / 100;
    }
    return clean;
  }

  getJob(jobId) { return this._jobs.get(jobId) || null; }

  subscribe(jobId, res) {
    if (!this._subscribers.has(jobId)) this._subscribers.set(jobId, new Set());
    this._subscribers.get(jobId).add(res);
    res.on('close', () => {
      const set = this._subscribers.get(jobId);
      if (set) { set.delete(res); if (!set.size) this._subscribers.delete(jobId); }
    });
  }

  _emit(jobId, event) {
    const set = this._subscribers.get(jobId);
    if (!set) return;
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of set) { try { res.write(payload); } catch { /* client gone */ } }
  }

  /** Resolve the config shop_id (cache key) for a shop_name. */
  _resolveShopId(shopName) {
    const row = this.db.prepare('SELECT shop_id FROM shops WHERE shop_name = ?').get(shopName);
    return row?.shop_id || null;
  }

  /**
   * Start a bulk reprice. Returns immediately with a job id + target count; the
   * work itself runs in the background and is streamed over SSE. The run is
   * deferred a short tick so the client can attach to the stream before the
   * first event fires (the stream endpoint also replays a snapshot on connect).
   *
   * @param {string} shopName
   * @param {object} opts
   * @param {Record<string,number>} opts.prices       style key → new price
   * @param {string} [opts.state='active']            listing state filter
   * @param {number[]} [opts.listingIds=null]         optional explicit subset
   * @returns {{ job_id:string, total:number, prices:Record<string,number> }}
   */
  start(shopName, { prices, state = 'active', listingIds = null } = {}) {
    const clean = this._sanitizePrices(prices);
    if (!Object.keys(clean).length) { const e = new Error('No valid prices supplied.'); e.status = 400; throw e; }

    const shopId = this._resolveShopId(shopName);
    if (!shopId) { const e = new Error(`Unknown shop: ${shopName}`); e.status = 404; throw e; }

    let rows;
    if (Array.isArray(listingIds) && listingIds.length) {
      const ph = listingIds.map(() => '?').join(',');
      rows = this.db.prepare(
        `SELECT listing_id FROM listings WHERE shop_id = ? AND listing_id IN (${ph})`
      ).all(shopId, ...listingIds);
    } else {
      const stateCond = state && state !== 'all' ? ' AND state = @state' : '';
      rows = this.db.prepare(
        `SELECT listing_id FROM listings WHERE shop_id = @shop_id${stateCond} ORDER BY updated_timestamp DESC`
      ).all({ shop_id: shopId, state });
    }
    const targets = rows.map(r => r.listing_id);

    const jobId = `reprice-${Date.now()}-${++this._seq}`;
    const job = {
      job_id: jobId, shop_name: shopName, shop_id: shopId, prices: clean,
      state: 'running', total: targets.length,
      processed: 0, repriced: 0, offerings: 0, failed: 0,
      started_at: Date.now(), finished_at: null, error: null,
    };
    this._jobs.set(jobId, job);

    if (!targets.length) {
      job.state = 'done';
      job.finished_at = Date.now();
      return { job_id: jobId, total: 0, prices: clean };
    }

    setTimeout(() => { this._run(jobId, shopName, targets, clean).catch(() => {}); }, 250);
    return { job_id: jobId, total: targets.length, prices: clean };
  }

  /**
   * Synchronously reprice a single listing and return the result. Used by the
   * Edit-listing modal where the caller wants an immediate, awaited outcome
   * rather than an SSE stream.
   *
   * @param {string} shopName
   * @param {number} listingId
   * @param {Record<string,number>} prices  style key → new price
   */
  async repriceListingSync(shopName, listingId, prices) {
    const clean = this._sanitizePrices(prices);
    if (!Object.keys(clean).length) { const e = new Error('No valid prices supplied.'); e.status = 400; throw e; }
    const shopCtx = await this.resolveShopClient(shopName);
    if (Array.isArray(shopCtx.scopes) && !shopCtx.scopes.includes('listings_w')) {
      const e = new Error('listings_w scope required. Re-run OAuth setup for this shop to grant price-edit permission.');
      e.status = 403; e.needs_reauth = true; throw e;
    }
    const r = await this._repriceOne(shopCtx, listingId, clean);
    return { ...r, prices: clean };
  }

  async _run(jobId, shopName, targets, prices) {
    const job = this._jobs.get(jobId);
    this._emit(jobId, { type: 'start', total: targets.length, prices, shop_name: shopName });

    let shopCtx;
    try {
      shopCtx = await this.resolveShopClient(shopName);
    } catch (err) {
      job.state = 'error';
      job.error = err.message;
      job.finished_at = Date.now();
      this._emit(jobId, { type: 'done', ...this._summary(job), error: err.message });
      return;
    }

    // Pre-flight the write scope so we fail fast with a clear message instead of
    // 403-ing on every single listing.
    if (Array.isArray(shopCtx.scopes) && !shopCtx.scopes.includes('listings_w')) {
      job.state = 'error';
      job.error = 'listings_w scope required. Re-run OAuth setup for this shop to grant price-edit permission.';
      job.finished_at = Date.now();
      this._emit(jobId, { type: 'done', ...this._summary(job), error: job.error, needs_reauth: true });
      return;
    }

    for (const listingId of targets) {
      try {
        const r = await this._repriceOne(shopCtx, listingId, prices);
        job.processed++;
        if (r.changed) { job.repriced++; job.offerings += r.offerings; }
        this._emit(jobId, {
          type: 'item', listing_id: listingId, processed: job.processed, total: targets.length,
          changed: r.changed, offerings: r.offerings, min_price: r.minPrice, currency: r.currency,
        });
      } catch (err) {
        job.processed++;
        job.failed++;
        this._emit(jobId, {
          type: 'item_failed', listing_id: listingId, processed: job.processed, total: targets.length,
          error: err.response?.data?.error || err.message,
        });
      }
    }

    job.state = 'done';
    job.finished_at = Date.now();
    this._emit(jobId, { type: 'done', ...this._summary(job) });
  }

  _summary(job) {
    return {
      total: job.total, processed: job.processed, repriced: job.repriced,
      offerings: job.offerings, failed: job.failed,
    };
  }

  /**
   * Reprice a single listing: pull live inventory, set every offering of each
   * targeted style to the new price, PUT it back, then patch the local cache.
   */
  async _repriceOne(shopCtx, listingId, prices) {
    const { shopClient } = shopCtx;
    const inv = await getListingInventory(shopClient, listingId);

    let changed = false;
    let offeringsChanged = 0;
    let currency = null;
    const productUpdates = []; // { product_id, price, currency }

    for (const product of (inv.products || [])) {
      const styleKey = styleKeyFromProps(JSON.stringify(product.property_values || []));
      if (!styleKey || !(styleKey in prices)) continue;
      const newPrice = prices[styleKey];

      let prodCurrency = null;
      for (const offering of (product.offerings || [])) {
        const cur = offering.price && typeof offering.price === 'object'
          ? offering.price.amount / offering.price.divisor
          : Number(offering.price);
        if (offering.price && typeof offering.price === 'object') {
          prodCurrency = offering.price.currency_code || prodCurrency;
        }
        const differs = !(Number.isFinite(cur) && Math.abs(cur - newPrice) < PRICE_EPSILON);
        if (differs) {
          offeringsChanged++;
          changed = true; // only a real price delta warrants a live Etsy PUT
        }
        offering.price = newPrice; // PUT accepts a float (harmless no-op when equal)
      }
      currency = prodCurrency || currency;
      productUpdates.push({ product_id: product.product_id, price: newPrice, currency: prodCurrency });
    }

    if (!changed) return { changed: false, offerings: 0, minPrice: null, currency };

    await updateListingInventory(shopClient, listingId, inv);

    // Patch the local cache directly so the Listings table is instantly correct
    // without a second Etsy GET.
    const now = Math.floor(Date.now() / 1000);
    const tx = this.db.transaction(() => {
      const upd = this.db.prepare(
        'UPDATE listing_inventory SET price_amount = ?, price_currency = COALESCE(?, price_currency), synced_at = ? WHERE listing_id = ? AND product_id = ?'
      );
      for (const u of productUpdates) upd.run(u.price, u.currency, now, listingId, u.product_id);
    });
    tx();

    const minRow = this.db.prepare(
      'SELECT MIN(price_amount) AS m, price_currency AS c FROM listing_inventory WHERE listing_id = ? AND is_enabled = 1 AND price_amount > 0'
    ).get(listingId);
    if (minRow && minRow.m != null) {
      this.db.prepare('UPDATE listings SET price_amount = ?, synced_at = ? WHERE listing_id = ?')
        .run(minRow.m, now, listingId);
    }

    return { changed: true, offerings: offeringsChanged, minPrice: minRow?.m ?? null, currency: currency || minRow?.c || null };
  }
}

module.exports = { ShopRepricer };
