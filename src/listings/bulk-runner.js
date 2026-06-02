'use strict';

/**
 * Bulk Listing Creator — job orchestration.
 *
 * Owns the lifecycle of a bulk-create run: scan input → generate AI copy →
 * price → create listings via the Etsy API, one product at a time (respecting
 * the per-group proxy + 5 QPS / 5,000 QPD rate budget). Progress is persisted
 * to SQLite (bulk_jobs / bulk_job_items) and streamed to subscribers (SSE).
 *
 * Resume is idempotent: each product's per-step progress lives in
 * checkpoint_json, and generated copy is cached in ai_json, so a retry skips
 * completed work instead of re-running OpenAI or re-uploading media.
 */

const crypto = require('crypto');

const { scanInputRoot } = require('./scanner');
const { getPricesForCurrency } = require('./pricing');
const { generateListingCopy } = require('./ai-generator');
const { getShopListingSettings } = require('./shop-settings');
const { createListingForProduct } = require('./etsy-create');
const { config } = require('./config');

function now() { return Math.floor(Date.now() / 1000); }

// Derive a safe single brand tag from a shop display name (<=20 chars, tag-safe).
function defaultBrandTag(shopName) {
  const t = String(shopName || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  return t ? [t.slice(0, 20)] : [];
}

class BulkJobManager {
  /**
   * @param {object} deps
   * @param {import('better-sqlite3').Database} deps.db
   * @param {(shopName:string)=>Promise<{shopClient:object,numericShopId:string,shopCfg:object}>} deps.resolveShopClient
   */
  constructor({ db, resolveShopClient }) {
    this.db = db;
    this.resolveShopClient = resolveShopClient;
    this._subscribers = new Map(); // job_id → Set<res>
    this._running = new Set();     // job_ids currently executing
  }

  // ── SSE ────────────────────────────────────────────────────────────────────
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
    for (const res of set) { try { res.write(payload); } catch { /* dropped client */ } }
  }

  // ── DB helpers ───────────────────────────────────────────────────────────────
  getJob(jobId) {
    return this.db.prepare('SELECT * FROM bulk_jobs WHERE job_id = ?').get(jobId);
  }
  getItems(jobId) {
    return this.db.prepare('SELECT * FROM bulk_job_items WHERE job_id = ? ORDER BY product_name').all(jobId);
  }
  _updateJob(jobId, fields) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const set = keys.map((k) => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE bulk_jobs SET ${set} WHERE job_id = @job_id`).run({ ...fields, job_id: jobId });
  }
  _updateItem(jobId, folder, fields) {
    const keys = Object.keys(fields);
    const set = [...keys.map((k) => `${k} = @${k}`), "updated_at = strftime('%s','now')"].join(', ');
    this.db.prepare(`UPDATE bulk_job_items SET ${set} WHERE job_id = @job_id AND product_folder = @folder`)
      .run({ ...fields, job_id: jobId, folder });
  }

  /**
   * Create a job + item rows and kick off processing (async, non-blocking).
   * @returns {object} the created job row
   */
  createAndStart({ shopName, inputPath, targetState = 'draft', dryRun = false, overrides = {}, brandTags }) {
    const { products } = scanInputRoot(inputPath);
    if (!products.length) {
      const err = new Error(`No products with images found in "${inputPath}".`);
      err.status = 400;
      throw err;
    }

    const jobId = crypto.randomUUID();
    const insertJob = this.db.prepare(`
      INSERT INTO bulk_jobs (job_id, shop_key, shop_name, input_path, state, target_state, dry_run, total, options_json, created_at)
      VALUES (@job_id, @shop_key, @shop_name, @input_path, 'queued', @target_state, @dry_run, @total, @options_json, strftime('%s','now'))
    `);
    insertJob.run({
      job_id: jobId,
      shop_key: shopName,
      shop_name: shopName,
      input_path: inputPath,
      target_state: targetState === 'published' ? 'published' : 'draft',
      dry_run: dryRun ? 1 : 0,
      total: products.length,
      options_json: JSON.stringify({ overrides, brandTags: brandTags || defaultBrandTag(shopName) }),
    });

    const insertItem = this.db.prepare(`
      INSERT INTO bulk_job_items (job_id, product_folder, product_name, status)
      VALUES (@job_id, @folder, @name, 'pending')
    `);
    const tx = this.db.transaction((items) => { for (const it of items) insertItem.run(it); });
    tx(products.map((p) => ({ job_id: jobId, folder: p.folder, name: p.name })));

    // Fire and forget — errors are captured on the job row.
    this.run(jobId, { overrides, brandTags: brandTags || defaultBrandTag(shopName) })
      .catch((err) => {
        this._updateJob(jobId, { state: 'error', error: err.message, finished_at: now() });
        this._emit(jobId, { type: 'job', state: 'error', error: err.message });
      });

    return this.getJob(jobId);
  }

  /** Resume failed/incomplete items of an existing job. */
  retry(jobId, { overrides, brandTags } = {}) {
    const job = this.getJob(jobId);
    if (!job) { const e = new Error('Job not found'); e.status = 404; throw e; }
    if (this._running.has(jobId)) { const e = new Error('Job already running'); e.status = 409; throw e; }
    const opts = JSON.parse(job.options_json || '{}');
    this.run(jobId, {
      overrides: overrides || opts.overrides || {},
      brandTags: brandTags || opts.brandTags || defaultBrandTag(job.shop_name),
      onlyUnfinished: true,
    }).catch((err) => {
      this._updateJob(jobId, { state: 'error', error: err.message, finished_at: now() });
      this._emit(jobId, { type: 'job', state: 'error', error: err.message });
    });
    return this.getJob(jobId);
  }

  /**
   * Main processing loop for a job. Sequential per product to respect the
   * per-group proxy + Etsy rate budget (concurrency defaults to 1).
   */
  async run(jobId, { overrides = {}, brandTags = [], onlyUnfinished = false } = {}) {
    if (this._running.has(jobId)) return;
    this._running.add(jobId);
    const job = this.getJob(jobId);
    if (!job) { this._running.delete(jobId); return; }

    try {
      this._updateJob(jobId, { state: 'running', error: null, started_at: job.started_at || now() });
      this._emit(jobId, { type: 'job', state: 'running' });

      // Resolve shop client + settings once per run.
      const { shopClient, numericShopId } = await this.resolveShopClient(job.shop_name);
      const settings = await getShopListingSettings({
        db: this.db, shopClient, shopId: numericShopId, shopKey: job.shop_key, force: false,
      });

      // Merge UI overrides onto the auto-selected defaults.
      const defaults = { ...settings.defaults, ...(overrides || {}) };
      const mergedSettings = { ...settings, defaults };

      // Pricing by shop currency (Etsy Anchor Price column).
      const currency = overrides.currency_code || settings.currency_code;
      const priceInfo = getPricesForCurrency(currency, { column: 'anchor' });
      this._emit(jobId, { type: 'info', message: `Currency ${priceInfo.currency} (${priceInfo.token}); taxonomy ${defaults.taxonomy_id || 'unresolved'}` });

      const dryRun = job.dry_run === 1;
      const targetState = job.target_state;
      const restockQuantity = config.bulk.restockQuantity;

      // Build the work list.
      let items = this.getItems(jobId);
      if (onlyUnfinished) items = items.filter((it) => it.status !== 'done');

      // Re-scan folders so we have image/video paths (not persisted in DB).
      const { products } = scanInputRoot(job.input_path);
      const byFolder = new Map(products.map((p) => [p.folder, p]));

      const concurrency = Math.max(1, config.bulk.concurrency);
      let completed = job.completed || 0;
      let failed = 0;

      const processItem = async (item) => {
        const product = byFolder.get(item.product_folder);
        if (!product) {
          this._updateItem(jobId, item.product_folder, { status: 'failed', error: 'Folder no longer found' });
          failed++;
          return;
        }
        try {
          this._emit(jobId, { type: 'item', folder: item.product_folder, name: item.product_name, status: 'running' });

          // 1) AI copy (cached in ai_json for resume).
          let copy;
          if (item.ai_json) {
            copy = JSON.parse(item.ai_json);
          } else {
            copy = await generateListingCopy(product, { shopName: job.shop_name, brandTags });
            this._updateItem(jobId, item.product_folder, {
              status: 'ai_done', ai_json: JSON.stringify(copy), title: copy.title,
            });
            this._emit(jobId, { type: 'item', folder: item.product_folder, status: 'ai_done', title: copy.title });
          }

          // 2) Create / resume on Etsy.
          const checkpoint = item.checkpoint_json ? JSON.parse(item.checkpoint_json) : {};
          const result = await createListingForProduct({
            shopClient,
            shopId: numericShopId,
            product,
            copy,
            prices: priceInfo.prices,
            settings: mergedSettings,
            options: { state: targetState, restockQuantity, dryRun },
            checkpoint,
            onStep: (step, data) => {
              if (data && data.listing_id) {
                this._updateItem(jobId, item.product_folder, {
                  status: 'created', listing_id: data.listing_id,
                  checkpoint_json: JSON.stringify(checkpoint),
                });
              } else {
                this._updateItem(jobId, item.product_folder, { checkpoint_json: JSON.stringify(checkpoint) });
              }
              this._emit(jobId, { type: 'step', folder: item.product_folder, step, ...data });
            },
          });

          if (dryRun) {
            this._updateItem(jobId, item.product_folder, {
              status: 'done', title: copy.title,
              checkpoint_json: JSON.stringify({ preview: result }),
            });
          } else {
            this._updateItem(jobId, item.product_folder, {
              status: 'done', listing_id: result.listing_id, listing_url: result.url,
              title: copy.title, error: null, checkpoint_json: JSON.stringify(result.checkpoint),
            });
          }
          completed++;
          this._emit(jobId, {
            type: 'item', folder: item.product_folder, status: 'done',
            listing_id: result.listing_id, url: result.url, title: copy.title,
          });
        } catch (err) {
          const msg = err.response?.data?.error || err.response?.data?.error_description || err.message;
          this._updateItem(jobId, item.product_folder, { status: 'failed', error: msg });
          failed++;
          this._emit(jobId, { type: 'item', folder: item.product_folder, status: 'failed', error: msg });
        } finally {
          this._updateJob(jobId, { completed, failed });
        }
      };

      // Simple bounded worker pool.
      const queue = [...items];
      const workers = Array.from({ length: concurrency }, async () => {
        while (queue.length) {
          const it = queue.shift();
          if (it) await processItem(it);
        }
      });
      await Promise.all(workers);

      this._updateJob(jobId, { state: 'done', completed, failed, finished_at: now() });
      this._emit(jobId, { type: 'job', state: 'done', completed, failed });
    } finally {
      this._running.delete(jobId);
    }
  }
}

module.exports = { BulkJobManager, defaultBrandTag };
