'use strict';

/**
 * One-shop rollout of newly released device generations onto live listings.
 *
 * Operator-initiated, additive, and deliberately slow:
 *   • discovers candidates from the local listings cache (zero Etsy calls)
 *   • GET inventory → clone sibling model rows → PUT inventory
 *   • never rebuilds the matrix from catalog defaults
 *   • one shop per job — the operator walks shops themselves
 *   • jittered delay between listings, pause on QPD or consecutive failures
 *   • never auto-resumes; the operator hits Resume
 *   • persists progress so a run can resume after a restart
 *
 * Etsy Personal Access is ~5,000 calls / sliding 24h, shared by the key.
 * Fulfilment keeps a 300-call reserve in the client; this job stops earlier.
 */

const {
  getListingInventory,
  putListingInventory,
  updateListing,
  getListingVariationImages,
  updateVariationImages,
  isQpdExhaustedError,
  getBudgetSnapshots,
} = require('../etsy/client');
const { upsertListingInventory, pruneStaleInventory, logEvent } = require('../db/setup');
const rollout = require('./device-catalog-rollout');

const DEFAULT_DELAY_MS = 2500;
const DELAY_JITTER_MS = 1000;
const MIN_DELAY_MS = 1000;
const LIVE_MIN_DELAY_MS = 2000;
const MAX_DELAY_MS = 8000;
const DEFAULT_SHOP_GAP_MS = 10000;
const MIN_SHOP_GAP_MS = 5000;
const MAX_SHOP_GAP_MS = 60000;
const QPD_PAUSE_FLOOR = 400;
const ETSY_WORK_POLL_MS = 1500;
const COPY_GAP_MS = 400;
const CONSECUTIVE_FAILURE_PAUSE = 5;

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJson(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function moneyObject(price, currency) {
  if (price && typeof price === 'object' && price.amount != null) return price;
  const n = Number(price);
  if (!Number.isFinite(n)) return null;
  return {
    amount: Math.round(n * 100),
    divisor: 100,
    currency_code: currency || 'USD',
  };
}

function cacheInventory(db, listingId, inventory, currency) {
  const products = inventory && inventory.products;
  if (!Array.isArray(products) || !products.length) return 0;
  const seen = new Set();
  let written = 0;
  for (const product of products) {
    if (product && product.product_id != null) seen.add(product.product_id);
    for (const offering of product.offerings || []) {
      const priced = {
        ...offering,
        price: moneyObject(offering.price, currency) || offering.price,
      };
      upsertListingInventory(db, listingId, product, priced);
      written++;
    }
  }
  pruneStaleInventory(db, listingId, seen);
  return written;
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS catalog_rollout_jobs (
      job_id         TEXT PRIMARY KEY,
      rollout_id     TEXT NOT NULL,
      state          TEXT NOT NULL,
      dry_run        INTEGER NOT NULL DEFAULT 0,
      update_copy    INTEGER NOT NULL DEFAULT 1,
      listing_state  TEXT NOT NULL DEFAULT 'active',
      delay_ms       INTEGER NOT NULL DEFAULT 2500,
      shop_gap_ms    INTEGER NOT NULL DEFAULT 10000,
      shop_names     TEXT,
      options_json   TEXT,
      total          INTEGER NOT NULL DEFAULT 0,
      needed         INTEGER NOT NULL DEFAULT 0,
      processed      INTEGER NOT NULL DEFAULT 0,
      updated        INTEGER NOT NULL DEFAULT 0,
      skipped        INTEGER NOT NULL DEFAULT 0,
      failed         INTEGER NOT NULL DEFAULT 0,
      error          TEXT,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      started_at     INTEGER,
      finished_at    INTEGER
    );
    CREATE TABLE IF NOT EXISTS catalog_rollout_items (
      job_id          TEXT NOT NULL,
      shop_id         TEXT NOT NULL,
      shop_name       TEXT NOT NULL,
      listing_id      INTEGER NOT NULL,
      product_type    TEXT,
      title           TEXT,
      status          TEXT NOT NULL,
      added_models    TEXT,
      existing_models TEXT,
      clone_sources   TEXT,
      error           TEXT,
      plan_json       TEXT,
      updated_at      INTEGER,
      PRIMARY KEY (job_id, listing_id)
    );
    CREATE INDEX IF NOT EXISTS idx_catalog_rollout_items_job
      ON catalog_rollout_items(job_id, status);
  `);
  const itemCols = db.prepare(`PRAGMA table_info(catalog_rollout_items)`).all();
  if (!itemCols.some((col) => col.name === 'plan_json')) {
    db.exec(`ALTER TABLE catalog_rollout_items ADD COLUMN plan_json TEXT`);
  }
}

function rowToJob(row) {
  if (!row) return null;
  return {
    job_id: row.job_id,
    rollout_id: row.rollout_id,
    state: row.state,
    dry_run: row.dry_run === 1,
    update_copy: row.update_copy !== 0,
    listing_state: row.listing_state,
    delay_ms: row.delay_ms,
    shop_gap_ms: row.shop_gap_ms,
    shop_names: parseJson(row.shop_names, []),
    options: parseJson(row.options_json, {}),
    total: row.total,
    needed: row.needed,
    processed: row.processed,
    updated: row.updated,
    skipped: row.skipped,
    failed: row.failed,
    error: row.error,
    created_at: row.created_at,
    updated_at: row.updated_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
  };
}

function lowestKnownBudget() {
  const snaps = getBudgetSnapshots();
  const known = snaps.filter((s) => s.guard_remaining != null);
  if (!known.length) return { remaining: null, known: false };
  const remaining = Math.min(...known.map((s) => s.guard_remaining));
  return { remaining, known: true, snapshots: snaps };
}

class CatalogRolloutManager {
  /**
   * @param {object} deps
   * @param {import('better-sqlite3').Database} deps.db
   * @param {(shopName:string)=>Promise<object>} deps.resolveShopClient
   * @param {()=>Array<{shop_id:string,shop_name:string}>} deps.listAuthorizedShops
   * @param {()=>boolean} [deps.isEtsyWorkRunning]
   */
  constructor({ db, resolveShopClient, listAuthorizedShops, isEtsyWorkRunning }) {
    this.db = db;
    this.resolveShopClient = resolveShopClient;
    this.listAuthorizedShops = listAuthorizedShops;
    this.isEtsyWorkRunning = typeof isEtsyWorkRunning === 'function' ? isEtsyWorkRunning : () => false;
    this._live = new Map();
    this._seq = 0;
    ensureSchema(db);
    this._recoverInterrupted();
  }

  _recoverInterrupted() {
    const ts = nowSec();
    this.db.prepare(
      `UPDATE catalog_rollout_jobs
       SET state = 'paused', error = 'dashboard restarted — resume when ready', updated_at = ?
       WHERE state = 'running'`
    ).run(ts);
    this.db.prepare(
      `UPDATE catalog_rollout_items SET status = 'pending' WHERE status = 'in_progress'`
    ).run();
  }

  _liveState(jobId) {
    if (!this._live.has(jobId)) {
      this._live.set(jobId, { control: 'run', subscribers: new Set(), running: false });
    }
    return this._live.get(jobId);
  }

  _activeRunnerId() {
    for (const [id, live] of this._live) {
      if (live.running) return id;
    }
    const row = this.db.prepare(
      `SELECT job_id FROM catalog_rollout_jobs WHERE state = 'running' LIMIT 1`
    ).get();
    return row ? row.job_id : null;
  }

  _requeueInProgress(jobId) {
    this.db.prepare(
      `UPDATE catalog_rollout_items SET status = 'pending' WHERE job_id = ? AND status = 'in_progress'`
    ).run(jobId);
  }

  _claimItem(jobId, listingId) {
    const result = this.db.prepare(
      `UPDATE catalog_rollout_items
       SET status = 'in_progress', updated_at = ?
       WHERE job_id = ? AND listing_id = ? AND status = 'pending'`
    ).run(nowSec(), jobId, listingId);
    return result.changes === 1;
  }

  spec() {
    const spec = rollout.currentRolloutSpec();
    return {
      ...spec,
      defaults: {
        delay_ms: DEFAULT_DELAY_MS,
        jitter_ms: DELAY_JITTER_MS,
        shop_gap_ms: DEFAULT_SHOP_GAP_MS,
        listing_state: 'active',
        update_copy: true,
        dry_run: true,
        one_shop: true,
        product_types: rollout.ROLLOUT_PRODUCT_TYPES.slice(),
        review_required: true,
      },
      budget: lowestKnownBudget(),
      qpd_pause_floor: QPD_PAUSE_FLOOR,
      consecutive_failure_pause: CONSECUTIVE_FAILURE_PAUSE,
      live_min_delay_ms: LIVE_MIN_DELAY_MS,
    };
  }

  _authorized() {
    return (this.listAuthorizedShops() || []).filter((s) => s && s.shop_id && s.shop_name);
  }

  _oneShopError(shops, { requested } = {}) {
    let message;
    if (shops.length > 1) {
      message = 'Device-model updates run one shop at a time. Pick a single shop, finish it, then the next.';
    } else if (requested) {
      message = 'No authorized shop matched. Connect OAuth for that shop, or pick another shop in the Listings dropdown.';
    } else {
      message = 'Select one shop in the Listings dropdown. Device-model updates run one shop at a time.';
    }
    const err = new Error(message);
    err.status = 400;
    err.code = 'ONE_SHOP_REQUIRED';
    return err;
  }

  /**
   * Never imply "all authorized shops". An omitted shop list is empty so the
   * UI can ask the operator to pick one.
   */
  _resolveShops(opts = {}) {
    const authorized = this._authorized();
    const ids = Array.isArray(opts.shop_ids) ? opts.shop_ids.map(String).filter(Boolean) : [];
    const names = Array.isArray(opts.shop_names) ? opts.shop_names.map(String).filter(Boolean) : [];
    if (!ids.length && !names.length) return [];
    const byId = new Map(authorized.map((s) => [s.shop_id, s]));
    const byName = new Map(authorized.map((s) => [s.shop_name, s]));
    const out = [];
    const seen = new Set();
    for (const id of ids) {
      const shop = byId.get(id);
      if (shop && !seen.has(shop.shop_id)) { seen.add(shop.shop_id); out.push(shop); }
    }
    for (const name of names) {
      const shop = byName.get(name);
      if (shop && !seen.has(shop.shop_id)) { seen.add(shop.shop_id); out.push(shop); }
    }
    return out;
  }

  _scan(shops, listingState, productTypes) {
    const allowedTypes = Array.isArray(productTypes) ? productTypes : rollout.ROLLOUT_PRODUCT_TYPES.slice();
    const allowed = new Set(allowedTypes);
    if (!shops.length) {
      return { listings: [], summary: { total: 0, needed: 0, current: 0, skipped: 0, uncached: 0, by_shop: {}, by_type: {} } };
    }
    const shopIds = shops.map((s) => s.shop_id);
    const placeholders = shopIds.map(() => '?').join(',');
    const params = shopIds.slice();
    let stateSql = '';
    if (listingState && listingState !== 'all') {
      stateSql = ' AND l.state = ?';
      params.push(listingState);
    }
    const listings = this.db.prepare(
      `SELECT l.listing_id, l.shop_id, l.title, l.description, l.state, l.price_currency, s.shop_name
       FROM listings l
       JOIN shops s ON s.shop_id = l.shop_id
       WHERE l.shop_id IN (${placeholders})${stateSql}
       ORDER BY s.shop_name COLLATE NOCASE, l.listing_id`
    ).all(...params);

    const invByListing = new Map();
    const ids = listings.map((row) => row.listing_id);
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      const ph = chunk.map(() => '?').join(',');
      const rows = this.db.prepare(
        `SELECT listing_id, secondary_value, property_values, style_value
         FROM listing_inventory WHERE listing_id IN (${ph})`
      ).all(...chunk);
      for (const row of rows) {
        if (!invByListing.has(row.listing_id)) invByListing.set(row.listing_id, []);
        invByListing.get(row.listing_id).push(row);
      }
    }

    const summary = {
      total: listings.length,
      needed: 0,
      current: 0,
      skipped: 0,
      uncached: 0,
      by_shop: {},
      by_type: {},
    };
    const scanned = [];
    for (const listing of listings) {
      const shopBucket = summary.by_shop[listing.shop_name] || (summary.by_shop[listing.shop_name] = {
        shop_id: listing.shop_id, shop_name: listing.shop_name, total: 0, needed: 0, current: 0, skipped: 0, uncached: 0,
      });
      shopBucket.total++;
      const classified = rollout.classifyCachedListing({
        title: listing.title,
        inventoryRows: invByListing.get(listing.listing_id) || [],
      });
      const missing = classified.productType
        ? rollout.missingAdditions(classified.productType, classified.models)
        : [];
      let status = 'pending';
      let reason = null;
      if (!classified.productType) {
        status = 'skipped';
        reason = classified.reason || 'unsupported_line';
      } else if (!allowed.has(classified.productType)) {
        status = 'skipped';
        reason = 'filtered_out';
      } else if (!missing.length) {
        status = 'skipped';
        reason = 'already_current';
      }
      if (status === 'skipped') {
        summary.skipped++;
        shopBucket.skipped++;
        if (reason === 'already_current') {
          summary.current++;
          shopBucket.current++;
        } else if (reason === 'uncached') {
          summary.uncached++;
          shopBucket.uncached++;
        }
      } else {
        summary.needed++;
        shopBucket.needed++;
        const typeBucket = summary.by_type[classified.productType] || (summary.by_type[classified.productType] = { needed: 0, models: {} });
        typeBucket.needed++;
        for (const model of missing) {
          typeBucket.models[model] = (typeBucket.models[model] || 0) + 1;
        }
      }
      scanned.push({
        listing_id: listing.listing_id,
        shop_id: listing.shop_id,
        shop_name: listing.shop_name,
        title: listing.title,
        description: listing.description,
        state: listing.state,
        price_currency: listing.price_currency,
        product_type: classified.productType,
        existing_models: classified.models,
        missing_models: missing,
        status,
        reason,
      });
    }
    return { listings: scanned, summary };
  }

  preview(opts = {}) {
    const shops = this._resolveShops(opts);
    if (shops.length > 1) throw this._oneShopError(shops);
    const listingState = opts.state || 'active';
    const updateCopy = opts.update_copy !== false;
    const productTypes = rollout.normalizeProductTypes(opts.product_types);
    const { listings, summary } = this._scan(shops, listingState, productTypes);
    const spec = rollout.currentRolloutSpec();
    const estimate = rollout.estimateApiCalls(summary.needed, { updateCopy });
    const budget = lowestKnownBudget();
    let budgetWarning = null;
    if (budget.known && estimate.min > Math.max(0, budget.remaining - QPD_PAUSE_FLOOR)) {
      budgetWarning = `This run needs about ${estimate.min}–${estimate.max} Etsy calls; only ${budget.remaining} remain on the local guard (pause floor ${QPD_PAUSE_FLOOR}). Prefer a dry run or wait for budget to recover.`;
    }
    return {
      spec,
      shops: shops.map((s) => ({ shop_id: s.shop_id, shop_name: s.shop_name })),
      listing_state: listingState,
      update_copy: updateCopy,
      product_types: productTypes,
      one_shop: true,
      summary,
      estimate,
      budget,
      budget_warning: budgetWarning,
      sample: listings.filter((row) => row.status === 'pending').slice(0, 12).map((row) => ({
        listing_id: row.listing_id,
        shop_name: row.shop_name,
        title: row.title,
        product_type: row.product_type,
        missing_models: row.missing_models,
      })),
    };
  }

  start(opts = {}) {
    if (opts.dry_run !== true) {
      const err = new Error(
        'Run a dry-run first, review the plan, then apply that plan to Etsy. Direct live starts are not allowed.'
      );
      err.status = 400;
      err.code = 'REVIEW_REQUIRED';
      throw err;
    }
    const shops = this._resolveShops(opts);
    const requested = (Array.isArray(opts.shop_ids) && opts.shop_ids.length)
      || (Array.isArray(opts.shop_names) && opts.shop_names.length);
    if (shops.length !== 1) throw this._oneShopError(shops, { requested: !!requested });
    const listingState = opts.state || 'active';
    const dryRun = opts.dry_run === true;
    const updateCopy = opts.update_copy !== false;
    const productTypes = rollout.normalizeProductTypes(opts.product_types);
    if (!productTypes.length) {
      const err = new Error('Select at least one product line: iPhone cases and/or AirPods cases.');
      err.status = 400;
      err.code = 'PRODUCT_TYPE_REQUIRED';
      throw err;
    }
    let delayMs = rollout.clampDelayMs(opts.delay_ms, DEFAULT_DELAY_MS, MIN_DELAY_MS, MAX_DELAY_MS);
    if (!dryRun) delayMs = Math.max(delayMs, LIVE_MIN_DELAY_MS);
    const shopGapMs = rollout.clampDelayMs(opts.shop_gap_ms, DEFAULT_SHOP_GAP_MS, MIN_SHOP_GAP_MS, MAX_SHOP_GAP_MS);
    const { listings, summary } = this._scan(shops, listingState, productTypes);
    const estimate = rollout.estimateApiCalls(summary.needed, { updateCopy });
    const budget = lowestKnownBudget();
    if (!dryRun && !opts.force && budget.known && estimate.min > Math.max(0, budget.remaining - QPD_PAUSE_FLOOR)) {
      const err = new Error(
        `Refusing to start: about ${estimate.min} Etsy calls needed, ${budget.remaining} remain (keeping ${QPD_PAUSE_FLOOR} in reserve). Run a dry run or wait for budget to recover.`
      );
      err.status = 409;
      err.code = 'ETSY_BUDGET_LOW';
      throw err;
    }

    if (!summary.needed) {
      const err = new Error('No listings need the new device models. Sync listings first if the cache is empty.');
      err.status = 400;
      throw err;
    }

    const active = this._activeRunnerId();
    if (active) {
      const err = new Error(`A catalog rollout is already running (${active}). Pause or wait for it to finish.`);
      err.status = 409;
      throw err;
    }

    const spec = rollout.currentRolloutSpec();
    const ts = nowSec();
    const jobId = `rollout-${Date.now()}-${++this._seq}`;
    const shopNames = shops.map((s) => s.shop_name);
    const skippedUpfront = listings.filter((row) => row.status !== 'pending').length;
    this.db.prepare(
      `INSERT INTO catalog_rollout_jobs (
        job_id, rollout_id, state, dry_run, update_copy, listing_state, delay_ms, shop_gap_ms,
        shop_names, options_json, total, needed, processed, updated, skipped, failed,
        created_at, updated_at, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 0, ?, ?, ?)`
    ).run(
      jobId, spec.id, 'running', dryRun ? 1 : 0, updateCopy ? 1 : 0, listingState, delayMs, shopGapMs,
      JSON.stringify(shopNames),
      JSON.stringify({
        estimate,
        force: !!opts.force,
        product_types: productTypes,
        shop_id: shops[0].shop_id,
        shop_name: shops[0].shop_name,
      }),
      summary.needed, summary.needed, skippedUpfront, ts, ts, ts
    );

    const insertItem = this.db.prepare(
      `INSERT INTO catalog_rollout_items (
        job_id, shop_id, shop_name, listing_id, product_type, title, status,
        added_models, existing_models, clone_sources, error, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const writeItems = this.db.transaction((rows) => {
      for (const row of rows) {
        insertItem.run(
          jobId, row.shop_id, row.shop_name, row.listing_id, row.product_type, row.title,
          row.status === 'pending' ? 'pending' : 'skipped',
          JSON.stringify(row.missing_models || []),
          JSON.stringify(row.existing_models || []),
          '{}',
          row.reason,
          ts
        );
      }
    });
    writeItems(listings);

    const live = this._liveState(jobId);
    live.control = 'run';
    live.running = true;
    setTimeout(() => {
      this._run(jobId).catch((err) => {
        this._finish(jobId, 'error', err.message);
      });
    }, 250);

    return this.getJob(jobId);
  }

  listItems(jobId) {
    return this.db.prepare(
      `SELECT listing_id, shop_name, product_type, title, status, added_models, existing_models, clone_sources, error, plan_json
       FROM catalog_rollout_items WHERE job_id = ? ORDER BY shop_name, listing_id`
    ).all(jobId).map((row) => {
      const added_models = parseJson(row.added_models, []);
      const existing_models = parseJson(row.existing_models, []);
      return {
        listing_id: row.listing_id,
        shop_name: row.shop_name,
        product_type: row.product_type,
        title: row.title,
        status: row.status,
        added_models,
        existing_models,
        clone_sources: parseJson(row.clone_sources, {}),
        error: row.error,
        plan: rollout.enrichReviewPlan(parseJson(row.plan_json, null), {
          title: row.title,
          product_type: row.product_type,
          added_models,
          existing_models,
        }),
      };
    });
  }

  _planCachedItem(item, productTypes, updateCopy) {
    const rows = this.db.prepare(
      `SELECT product_id, property_values, style_value, secondary_value, quantity, is_enabled, price_amount
       FROM listing_inventory WHERE listing_id = ?`
    ).all(item.listing_id);
    const listingRow = this.db.prepare(
      `SELECT title, description FROM listings WHERE listing_id = ?`
    ).get(item.listing_id) || {};
    return rollout.planFromCachedListing({
      title: listingRow.title || item.title,
      description: listingRow.description || '',
      inventoryRows: rows,
      existingModels: parseJson(item.existing_models, []),
      missingModels: parseJson(item.added_models, []),
      productTypes,
      updateCopy,
    });
  }

  /**
   * Promote a completed dry-run into a live Etsy write of the reviewed listings.
   * Live still GET+PUTs each listing — the review plan is the allow-list, not the payload.
   */
  apply(jobId, opts = {}) {
    const job = this.getJob(jobId);
    if (!job) { const e = new Error('Job not found'); e.status = 404; throw e; }
    if (!job.dry_run) {
      const e = new Error('This job already ran against Etsy. Start a new dry-run for the next shop.');
      e.status = 409;
      e.code = 'ALREADY_APPLIED';
      throw e;
    }
    if (job.state !== 'done') {
      const e = new Error('Finish the dry-run and review the plan before applying to Etsy.');
      e.status = 409;
      e.code = 'REVIEW_REQUIRED';
      throw e;
    }

    const would = this.db.prepare(
      `SELECT listing_id FROM catalog_rollout_items WHERE job_id = ? AND status = 'would_update'`
    ).all(jobId);
    if (!would.length) {
      const e = new Error('This dry-run has no listings left to apply.');
      e.status = 400;
      throw e;
    }

    const requested = Array.isArray(opts.listing_ids)
      ? opts.listing_ids.map(Number).filter((n) => Number.isFinite(n) && n > 0)
      : null;
    const approved = requested && requested.length
      ? new Set(requested)
      : new Set(would.map((row) => row.listing_id));
    const selected = would.filter((row) => approved.has(row.listing_id));
    if (!selected.length) {
      const e = new Error('Select at least one listing from the review before applying to Etsy.');
      e.status = 400;
      throw e;
    }

    const estimate = rollout.estimateApiCalls(selected.length, { updateCopy: job.update_copy });
    const budget = lowestKnownBudget();
    if (!opts.force && budget.known && estimate.min > Math.max(0, budget.remaining - QPD_PAUSE_FLOOR)) {
      const err = new Error(
        `Refusing to apply: about ${estimate.min} Etsy calls needed, ${budget.remaining} remain (keeping ${QPD_PAUSE_FLOOR} in reserve). Wait for budget to recover.`
      );
      err.status = 409;
      err.code = 'ETSY_BUDGET_LOW';
      throw err;
    }

    const active = this._activeRunnerId();
    if (active) {
      const err = new Error(`A catalog rollout is already running (${active}). Pause or wait for it to finish.`);
      err.status = 409;
      throw err;
    }

    const ts = nowSec();
    const delayMs = Math.max(job.delay_ms || DEFAULT_DELAY_MS, LIVE_MIN_DELAY_MS);
    const options = { ...(job.options || {}), estimate, reviewed: true, selected_count: selected.length };

    this.db.transaction(() => {
      for (const row of would) {
        if (!approved.has(row.listing_id)) {
          this._patchItem(jobId, row.listing_id, { status: 'skipped', error: 'excluded_on_review' });
        } else {
          this._patchItem(jobId, row.listing_id, { status: 'pending', error: null });
        }
      }
      const skipped = this.db.prepare(
        `SELECT COUNT(*) AS n FROM catalog_rollout_items WHERE job_id = ? AND status = 'skipped'`
      ).get(jobId).n;
      const needed = this.db.prepare(
        `SELECT COUNT(*) AS n FROM catalog_rollout_items WHERE job_id = ? AND status = 'pending'`
      ).get(jobId).n;
      this._patchJob(jobId, {
        dry_run: 0,
        state: 'running',
        delay_ms: delayMs,
        processed: 0,
        updated: 0,
        failed: 0,
        skipped,
        needed,
        total: needed,
        error: null,
        finished_at: null,
        started_at: ts,
        options_json: JSON.stringify(options),
      });
    })();

    const live = this._liveState(jobId);
    live.control = 'run';
    live.running = true;
    this._emit(jobId, { type: 'resumed', job: this.getJob(jobId) });
    setTimeout(() => {
      this._run(jobId).catch((err) => this._finish(jobId, 'error', err.message));
    }, 50);
    return this.getJob(jobId);
  }

  getJob(jobId) {
    const job = rowToJob(this.db.prepare('SELECT * FROM catalog_rollout_jobs WHERE job_id = ?').get(jobId));
    if (!job) return null;
    const live = this._live.get(jobId);
    job.control = live ? live.control : (job.state === 'running' ? 'run' : job.state);
    job.spec = rollout.currentRolloutSpec();
    return job;
  }

  listJobs(limit = 20) {
    return this.db.prepare(
      `SELECT * FROM catalog_rollout_jobs ORDER BY created_at DESC LIMIT ?`
    ).all(Math.min(100, Math.max(1, Number(limit) || 20))).map(rowToJob);
  }

  subscribe(jobId, res) {
    const live = this._liveState(jobId);
    live.subscribers.add(res);
    res.on('close', () => {
      live.subscribers.delete(res);
    });
    const job = this.getJob(jobId);
    if (job) this._emit(jobId, { type: 'snapshot', job });
  }

  _emit(jobId, event) {
    const live = this._live.get(jobId);
    if (!live) return;
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of live.subscribers) {
      try { res.write(payload); } catch { /* client gone */ }
    }
  }

  _patchJob(jobId, fields) {
    const cols = [];
    const values = [];
    for (const [key, value] of Object.entries(fields)) {
      cols.push(`${key} = ?`);
      values.push(value);
    }
    cols.push('updated_at = ?');
    values.push(nowSec(), jobId);
    this.db.prepare(`UPDATE catalog_rollout_jobs SET ${cols.join(', ')} WHERE job_id = ?`).run(...values);
  }

  _patchItem(jobId, listingId, fields) {
    const cols = [];
    const values = [];
    for (const [key, value] of Object.entries(fields)) {
      cols.push(`${key} = ?`);
      values.push(value);
    }
    cols.push('updated_at = ?');
    values.push(nowSec(), jobId, listingId);
    this.db.prepare(
      `UPDATE catalog_rollout_items SET ${cols.join(', ')} WHERE job_id = ? AND listing_id = ?`
    ).run(...values);
  }

  _finish(jobId, state, error) {
    const live = this._liveState(jobId);
    live.running = false;
    live.control = state === 'paused' ? 'pause' : state;
    if (state === 'paused' || state === 'cancelled' || state === 'error') {
      this._requeueInProgress(jobId);
    }
    this._patchJob(jobId, {
      state,
      error: error || null,
      finished_at: (state === 'paused') ? null : nowSec(),
    });
    const job = this.getJob(jobId);
    this._emit(jobId, { type: 'done', job, error: error || null });
    if (state === 'done' || state === 'cancelled') {
      try {
        logEvent(this.db, {
          event_type: 'CATALOG_ROLLOUT',
          listing_title: job && job.rollout_id,
          detail: `${state}: updated ${job && job.updated}, skipped ${job && job.skipped}, failed ${job && job.failed}`,
          meta: { job_id: jobId, state },
        });
      } catch { /* audit must never break the job */ }
    }
  }

  pause(jobId) {
    const job = this.getJob(jobId);
    if (!job) { const e = new Error('Job not found'); e.status = 404; throw e; }
    const live = this._liveState(jobId);
    if (!live.running && job.state !== 'running') return job;
    live.control = 'pause';
    this._emit(jobId, { type: 'pausing', job: this.getJob(jobId) });
    return this.getJob(jobId);
  }

  cancel(jobId) {
    const job = this.getJob(jobId);
    if (!job) { const e = new Error('Job not found'); e.status = 404; throw e; }
    if (job.state === 'done' || job.state === 'cancelled') return job;
    this._liveState(jobId).control = 'cancel';
    if (!this._liveState(jobId).running) this._finish(jobId, 'cancelled');
    return this.getJob(jobId);
  }

  resume(jobId) {
    const job = this.getJob(jobId);
    if (!job) { const e = new Error('Job not found'); e.status = 404; throw e; }
    if (job.state === 'done' || job.state === 'cancelled') {
      const e = new Error('This job has finished and cannot be resumed.');
      e.status = 409;
      throw e;
    }
    const live = this._liveState(jobId);
    live.control = 'run';
    this._patchJob(jobId, {
      state: 'running',
      error: null,
      finished_at: null,
      started_at: job.started_at || nowSec(),
    });
    this._emit(jobId, { type: 'resumed', job: this.getJob(jobId) });
    if (live.running) return this.getJob(jobId);

    const active = this._activeRunnerId();
    if (active && active !== jobId) {
      const e = new Error(`Another catalog rollout is already running (${active}).`);
      e.status = 409;
      throw e;
    }
    live.running = true;
    setTimeout(() => {
      this._run(jobId).catch((err) => this._finish(jobId, 'error', err.message));
    }, 50);
    return this.getJob(jobId);
  }

  async _sleep(jobId, ms) {
    const live = this._liveState(jobId);
    const end = Date.now() + Math.max(0, ms);
    while (Date.now() < end) {
      if (live.control !== 'run') return live.control;
      await sleep(Math.min(250, end - Date.now()));
    }
    return live.control;
  }

  async _waitForEtsyIdle(jobId) {
    while (this.isEtsyWorkRunning()) {
      const control = await this._sleep(jobId, ETSY_WORK_POLL_MS);
      if (control !== 'run') return control;
    }
    return 'run';
  }

  async _run(jobId) {
    const jobRow = this.db.prepare('SELECT * FROM catalog_rollout_jobs WHERE job_id = ?').get(jobId);
    if (!jobRow) return;
    const live = this._liveState(jobId);
    live.running = true;
    this._requeueInProgress(jobId);

    const delayMs = jobRow.delay_ms;
    const shopGapMs = jobRow.shop_gap_ms;
    const dryRun = jobRow.dry_run === 1;
    const updateCopy = jobRow.update_copy !== 0;
    const options = parseJson(jobRow.options_json, {});
    const productTypes = rollout.normalizeProductTypes(options.product_types);
    const pending = this.db.prepare(
      `SELECT * FROM catalog_rollout_items WHERE job_id = ? AND status = 'pending' ORDER BY shop_name COLLATE NOCASE, listing_id`
    ).all(jobId);

    this._emit(jobId, { type: 'start', job: this.getJob(jobId), remaining: pending.length });

    let lastShop = null;
    let consecutiveFailures = 0;
    const shopCtxCache = new Map();
    const listingMeta = this.db.prepare(
      `SELECT title, description, price_currency FROM listings WHERE listing_id = ?`
    );

    const halt = (state, error) => this._finish(jobId, state, error);

    for (const item of pending) {
      if (live.control === 'cancel') { halt('cancelled'); return; }
      if (live.control === 'pause') { halt('paused'); return; }
      if (!this._claimItem(jobId, item.listing_id)) continue;

      if (lastShop && lastShop !== item.shop_name) {
        if (await this._sleep(jobId, shopGapMs) !== 'run') {
          this._patchItem(jobId, item.listing_id, { status: 'pending' });
          halt(live.control === 'cancel' ? 'cancelled' : 'paused');
          return;
        }
      }
      lastShop = item.shop_name;

      if (dryRun) {
        const planned = this._planCachedItem(item, productTypes, updateCopy);
        if (planned.block) {
          this._noteItem(jobId, item, {
            status: 'skipped',
            error: 'would_exceed_limit',
            added_models: JSON.stringify(planned.addedModels || []),
            existing_models: JSON.stringify(planned.existingModels || []),
            clone_sources: JSON.stringify(planned.cloneSources || {}),
            plan_json: JSON.stringify(planned.review || null),
          }, { skipped: true });
        } else {
          this._noteItem(jobId, item, {
            status: 'would_update',
            added_models: JSON.stringify(planned.addedModels && planned.addedModels.length
              ? planned.addedModels
              : parseJson(item.added_models, [])),
            existing_models: JSON.stringify(planned.existingModels && planned.existingModels.length
              ? planned.existingModels
              : parseJson(item.existing_models, [])),
            clone_sources: JSON.stringify(planned.cloneSources || {}),
            plan_json: JSON.stringify(planned.review || null),
          }, { would: true });
        }
        consecutiveFailures = 0;
        continue;
      }

      if (await this._waitForEtsyIdle(jobId) !== 'run') {
        this._patchItem(jobId, item.listing_id, { status: 'pending' });
        halt(live.control === 'cancel' ? 'cancelled' : 'paused');
        return;
      }

      const budget = lowestKnownBudget();
      if (budget.known && budget.remaining <= QPD_PAUSE_FLOOR) {
        this._patchItem(jobId, item.listing_id, { status: 'pending' });
        halt(
          'paused',
          `Paused: ${budget.remaining} Etsy calls remain (keeping ${QPD_PAUSE_FLOOR} in reserve). Resume when the daily budget recovers.`
        );
        return;
      }

      try {
        let shopCtx = shopCtxCache.get(item.shop_name);
        if (!shopCtx) {
          shopCtx = await this.resolveShopClient(item.shop_name);
          if (Array.isArray(shopCtx.scopes) && !shopCtx.scopes.includes('listings_w')) {
            const err = new Error('listings_w scope required. Re-run OAuth setup for this shop.');
            err.status = 403;
            err.needs_reauth = true;
            throw err;
          }
          shopCtxCache.set(item.shop_name, shopCtx);
        }

        const inv = await getListingInventory(shopCtx.shopClient, item.listing_id);
        const plan = rollout.applyRollout(inv, { product_types: productTypes });
        if (!plan.changed) {
          this._noteItem(jobId, item, {
            status: 'skipped',
            error: plan.reason || 'already_current',
            existing_models: JSON.stringify(plan.existingModels || []),
            added_models: '[]',
          }, { skipped: true });
          consecutiveFailures = 0;
          if (await this._sleep(jobId, Math.min(delayMs, 800)) !== 'run') {
            halt(live.control === 'cancel' ? 'cancelled' : 'paused');
            return;
          }
          continue;
        }

        const beforeStyles = rollout.styleValueIdMap(inv, plan.productType);
        const saved = await putListingInventory(shopCtx.shopClient, item.listing_id, plan.body);
        const afterInv = saved && Array.isArray(saved.products) && saved.products.length
          ? saved
          : await getListingInventory(shopCtx.shopClient, item.listing_id);
        const listingRow = listingMeta.get(item.listing_id) || {};
        cacheInventory(this.db, item.listing_id, afterInv, listingRow.price_currency);

        const afterStyles = rollout.styleValueIdMap(afterInv, plan.productType);
        if (rollout.styleValueIdsChanged(beforeStyles, afterStyles)) {
          try {
            const links = await getListingVariationImages(shopCtx.shopClient, shopCtx.numericShopId, item.listing_id);
            const remapped = rollout.remapVariationImages(links, afterStyles);
            if (remapped.length) {
              await updateVariationImages(shopCtx.shopClient, shopCtx.numericShopId, item.listing_id, remapped);
            }
          } catch { /* variation-image relink is best-effort */ }
        }

        let copyNote = null;
        if (updateCopy) {
          const copy = rollout.planCopyUpdates({
            title: listingRow.title || item.title,
            description: listingRow.description || '',
            productType: plan.productType,
            existingModels: plan.existingModels,
            addedModels: plan.addedModels,
          });
          const patch = {};
          if (copy.titleChanged) patch.title = copy.title;
          if (copy.descriptionChanged) patch.description = copy.description;
          if (Object.keys(patch).length) {
            if (await this._sleep(jobId, COPY_GAP_MS) !== 'run') {
              this._noteItem(jobId, item, {
                status: 'updated',
                product_type: plan.productType,
                title: item.title,
                added_models: JSON.stringify(plan.addedModels),
                existing_models: JSON.stringify(plan.existingModels),
                clone_sources: JSON.stringify(plan.cloneSources),
                error: 'paused_before_copy',
              }, { updated: true });
              halt(live.control === 'cancel' ? 'cancelled' : 'paused');
              return;
            }
            try {
              await updateListing(shopCtx.shopClient, shopCtx.numericShopId, item.listing_id, patch);
              this.db.prepare(
                `UPDATE listings SET title = COALESCE(?, title), description = COALESCE(?, description), synced_at = strftime('%s','now') WHERE listing_id = ?`
              ).run(patch.title || null, patch.description || null, item.listing_id);
              if (patch.title) item.title = patch.title;
            } catch (copyErr) {
              copyNote = copyErr.message;
            }
          } else if (copy.skipped) {
            copyNote = copy.skipped;
          }
        }

        this._noteItem(jobId, item, {
          status: 'updated',
          product_type: plan.productType,
          title: item.title,
          added_models: JSON.stringify(plan.addedModels),
          existing_models: JSON.stringify(plan.existingModels),
          clone_sources: JSON.stringify(plan.cloneSources),
          error: copyNote || null,
        }, { updated: true });
        consecutiveFailures = 0;
      } catch (err) {
        if (isQpdExhaustedError(err)) {
          this._patchItem(jobId, item.listing_id, { status: 'pending', error: err.message });
          halt('paused', err.message);
          return;
        }
        consecutiveFailures += 1;
        this._noteItem(jobId, item, {
          status: 'failed',
          error: (err.response && err.response.data && err.response.data.error) || err.message,
        }, { failed: true });
        if (consecutiveFailures >= CONSECUTIVE_FAILURE_PAUSE) {
          halt(
            'paused',
            `Paused after ${consecutiveFailures} consecutive listing failures. Check the log before resuming — Etsy may be rejecting the payload.`
          );
          return;
        }
      }

      const wait = rollout.pacedDelayMs(delayMs, DELAY_JITTER_MS);
      if (await this._sleep(jobId, wait) !== 'run') {
        halt(live.control === 'cancel' ? 'cancelled' : 'paused');
        return;
      }
    }

    halt('done');
  }

  _noteItem(jobId, item, fields, counters) {
    this._patchItem(jobId, item.listing_id, fields);
    const job = this.db.prepare('SELECT processed, updated, skipped, failed, total FROM catalog_rollout_jobs WHERE job_id = ?').get(jobId);
    const next = {
      processed: (job.processed || 0) + 1,
      updated: (job.updated || 0) + (counters.updated || counters.would ? 1 : 0),
      skipped: (job.skipped || 0) + (counters.skipped ? 1 : 0),
      failed: (job.failed || 0) + (counters.failed ? 1 : 0),
    };
    this._patchJob(jobId, next);
    this._emit(jobId, {
      type: counters.failed ? 'item_failed' : 'item',
      listing_id: item.listing_id,
      shop_name: item.shop_name,
      title: fields.title || item.title,
      status: fields.status,
      added_models: parseJson(fields.added_models, parseJson(item.added_models, [])),
      error: fields.error || null,
      processed: next.processed,
      total: job.total,
      updated: next.updated,
      skipped: next.skipped,
      failed: next.failed,
    });
  }
}

function installRoutes(app, deps) {
  const manager = new CatalogRolloutManager(deps);

  app.get('/api/listings/catalog-rollout/spec', (_req, res) => {
    res.json(manager.spec());
  });

  app.post('/api/listings/catalog-rollout/preview', (req, res) => {
    try {
      res.json(manager.preview(req.body || {}));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.get('/api/listings/catalog-rollout', (req, res) => {
    res.json({ jobs: manager.listJobs(req.query.limit) });
  });

  app.post('/api/listings/catalog-rollout', (req, res) => {
    try {
      const job = manager.start(req.body || {});
      res.json({ success: true, ...job });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, code: err.code || null });
    }
  });

  app.get('/api/listings/catalog-rollout/stream/:job_id', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('\n');
    const job = manager.getJob(req.params.job_id);
    if (!job) {
      res.write(`data: ${JSON.stringify({ type: 'done', error: 'Job not found' })}\n\n`);
      res.end();
      return;
    }
    manager.subscribe(req.params.job_id, res);
  });

  app.get('/api/listings/catalog-rollout/:job_id', (req, res) => {
    const job = manager.getJob(req.params.job_id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json({ job, items: manager.listItems(req.params.job_id) });
  });

  app.post('/api/listings/catalog-rollout/:job_id/apply', (req, res) => {
    try { res.json({ success: true, ...manager.apply(req.params.job_id, req.body || {}) }); }
    catch (err) { res.status(err.status || 500).json({ error: err.message, code: err.code || null }); }
  });

  app.post('/api/listings/catalog-rollout/:job_id/pause', (req, res) => {
    try { res.json({ success: true, ...manager.pause(req.params.job_id) }); }
    catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  });

  app.post('/api/listings/catalog-rollout/:job_id/resume', (req, res) => {
    try { res.json({ success: true, ...manager.resume(req.params.job_id) }); }
    catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  });

  app.post('/api/listings/catalog-rollout/:job_id/cancel', (req, res) => {
    try { res.json({ success: true, ...manager.cancel(req.params.job_id) }); }
    catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  });

  return manager;
}

module.exports = {
  CatalogRolloutManager,
  installRoutes,
  ensureSchema,
  DEFAULT_DELAY_MS,
  DELAY_JITTER_MS,
  LIVE_MIN_DELAY_MS,
  DEFAULT_SHOP_GAP_MS,
  QPD_PAUSE_FLOOR,
  CONSECUTIVE_FAILURE_PAUSE,
};
