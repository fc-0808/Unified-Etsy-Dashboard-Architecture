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
const path = require('path');

const { scanInputRoot, scanProductFolder } = require('./scanner');
const { getPricesForCurrency, STYLE_KEYS } = require('./pricing');
const { resolveDefaultPrices } = require('./shop-prices');
const { generateListingCopy, generateCopyFromAnalysis, filterModelsInDescription, retitleForModels } = require('./ai-generator');
const { getShopListingSettings } = require('./shop-settings');
const { createListingForProduct, repriceListing } = require('./etsy-create');
const { getTaxonomyAttributes } = require('./attributes');
const { computeEnabledStyles, normaliseEnabledStyles, normaliseEnabledModels, STYLE_ORDER } = require('./variation-builder');
const { updateListing } = require('../etsy/client');
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
    this._control = new Map();     // job_id → 'pause' | 'cancel' (cooperative signal)
    this._reconcileOrphans();
  }

  /**
   * Crash/restart recovery: any job left mid-flight (running/queued) in the DB
   * cannot still be executing in a freshly-started process. Its per-item
   * checkpoints are intact (idempotent resume), so rather than stranding it as
   * 'paused' and forcing a manual click, we AUTO-RESUME it from where it stopped.
   *
   * Crash-loop guard: each auto-resume bumps auto_resume_count; once an item
   * completes the count resets to 0 (see processItem), so steady progress is
   * unlimited and only repeated no-progress crashes exhaust the budget. Past the
   * cap the job is left 'paused' for manual inspection. Manual pauses are never
   * touched (their state is already 'paused', not 'running'/'queued').
   */
  _reconcileOrphans() {
    const MAX_AUTO_RESUME = 5;
    let interrupted = [];
    try {
      interrupted = this.db
        .prepare("SELECT job_id, COALESCE(auto_resume_count,0) AS arc FROM bulk_jobs WHERE state IN ('running','queued')")
        .all();
      if (!interrupted.length) return;
      // Park them all as paused first (clean, consistent state on boot).
      this.db.prepare("UPDATE bulk_jobs SET state = 'paused' WHERE state IN ('running','queued')").run();
      console.log(`[bulk] found ${interrupted.length} interrupted job(s) after restart`);
    } catch (err) {
      console.error('[bulk] orphan reconcile failed:', err.message);
      return;
    }

    for (const { job_id: jobId, arc } of interrupted) {
      if (arc >= MAX_AUTO_RESUME) {
        console.warn(`[bulk] job ${jobId} hit the auto-resume cap (${MAX_AUTO_RESUME}) without progress — left paused for review`);
        continue;
      }
      try { this.db.prepare('UPDATE bulk_jobs SET auto_resume_count = COALESCE(auto_resume_count,0) + 1 WHERE job_id = ?').run(jobId); } catch { /* non-fatal */ }
      // Defer so the HTTP server is fully listening and, if this process is in a
      // genuine crash loop, PM2's backoff still governs the restart cadence.
      setTimeout(() => {
        try {
          if (!this.getJob(jobId) || this._running.has(jobId)) return;
          console.log(`[bulk] auto-resuming job ${jobId} (attempt ${arc + 1}/${MAX_AUTO_RESUME})`);
          this.resume(jobId);
        } catch (err) {
          console.error(`[bulk] auto-resume of ${jobId} failed:`, err.message);
        }
      }, 8000);
    }
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
  /** Whether a job (or its publish/reprice/regenerate task) is executing in this process. */
  isActive(jobId) {
    return this._running.has(jobId) || this._running.has('publish:' + jobId) || this._running.has('prices:' + jobId) || this._running.has('models:' + jobId) || this.activeRegenSeqs(jobId).length > 0;
  }
  /** Item seqs currently regenerating copy (background) for this job. */
  activeRegenSeqs(jobId) {
    const prefix = 'regen:' + jobId + ':';
    const out = [];
    for (const key of this._running) {
      if (key.startsWith(prefix)) {
        const seq = Number(key.slice(prefix.length));
        if (Number.isFinite(seq)) out.push(seq);
      }
    }
    return out;
  }
  /** Delete a saved run and all its items. Refuses while it is actively executing. */
  deleteJob(jobId) {
    const job = this.getJob(jobId);
    if (!job) { const e = new Error('Job not found'); e.status = 404; throw e; }
    if (this.isActive(jobId)) { const e = new Error('Job is running — pause or wait for it to finish before deleting.'); e.status = 409; throw e; }
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM bulk_job_items WHERE job_id = ?').run(jobId);
      this.db.prepare('DELETE FROM bulk_jobs WHERE job_id = ?').run(jobId);
    });
    tx();
    this._subscribers.delete(jobId);
    return { ok: true };
  }
  getItems(jobId) {
    // Order by the persisted natural-sort sequence (1,2,3…10,11) so both the
    // processing order and the progress table match human expectation. Rows
    // created before the seq column existed (seq IS NULL) sort last by name.
    return this.db
      .prepare(`
        SELECT * FROM bulk_job_items
        WHERE job_id = ?
        ORDER BY (seq IS NULL), seq, product_name
      `)
      .all(jobId);
  }
  /** Look up a single item within a job by its 1-based seq. */
  getItemBySeq(jobId, seq) {
    return this.db
      .prepare('SELECT * FROM bulk_job_items WHERE job_id = ? AND seq = ?')
      .get(jobId, Number(seq));
  }

  // ── Inspection ───────────────────────────────────────────────────────────────
  /**
   * Full inspection payload for one product: copy, image order, the resolved
   * variation matrix (12 models × enabled styles with per-style prices) and the
   * shop settings used. Reads the persisted preview; never calls Etsy/OpenAI.
   */
  buildItemDetail(jobId, seq) {
    const job = this.getJob(jobId);
    if (!job) { const e = new Error('Job not found'); e.status = 404; throw e; }
    const item = this.getItemBySeq(jobId, seq);
    if (!item) { const e = new Error('Item not found'); e.status = 404; throw e; }

    let preview = null;
    try { preview = item.preview_json ? JSON.parse(item.preview_json) : null; } catch { preview = null; }
    let ai = null;
    try { ai = item.ai_json ? JSON.parse(item.ai_json) : null; } catch { ai = null; }

    // Fallback for legacy items created before preview_json existed: surface
    // whatever copy we cached so the Inspector is still useful.
    if (!preview && ai) {
      preview = {
        title: ai.title, description: ai.description, tags: ai.tags || [],
        primaryColor: ai.primaryColor || '', secondaryColor: ai.secondaryColor || '',
        character: ai.characterName || '', characterDetected: ai.characterDetected || '',
        characterFranchise: ai.characterFranchise || '', characterConfidence: ai.characterConfidence,
        characterEvidence: ai.characterEvidence || '', characterAlternatives: ai.characterAlternatives || [],
        characterLowConfidence: ai.characterLowConfidence || false,
        images: [], enabledStyles: computeEnabledStyles(ai.imageAnalysis || []), stylePrices: {},
        styleImageMapping: ai.styleImageMapping || {}, imageAnalysis: ai.imageAnalysis || [], settings: {},
      };
    }

    // Ensure the image gallery always reflects the real folder contents in
    // upload order (covers legacy items whose preview lacked the image list).
    if (preview && (!preview.images || !preview.images.length)) {
      try {
        const scanned = scanProductFolder(item.product_folder);
        preview.images = (scanned.images || []).map((im) => ({ rank: im.rank, filename: im.filename }));
        if (preview.hasVideo == null) preview.hasVideo = scanned.hasVideo;
        if (!preview.videoFilename && scanned.video) preview.videoFilename = scanned.video.filename;
      } catch { /* folder may have moved — leave images empty */ }
    }

    return {
      job: {
        job_id: job.job_id, shop_name: job.shop_name, dry_run: job.dry_run === 1,
        target_state: job.target_state, state: job.state,
      },
      item: {
        seq: item.seq, name: item.product_name, folder: item.product_folder,
        status: item.status, listing_id: item.listing_id, listing_url: item.listing_url,
        error: item.error, published_at: item.published_at, reviewed_at: item.reviewed_at,
      },
      preview: preview || {},
    };
  }

  /**
   * Resolve the on-disk path of an item's image by rank, validated to live
   * inside the job's input folder (prevents path traversal). Used to stream
   * thumbnails to the Inspector.
   */
  resolveItemImage(jobId, seq, rank) {
    const job = this.getJob(jobId);
    if (!job) { const e = new Error('Job not found'); e.status = 404; throw e; }
    const item = this.getItemBySeq(jobId, seq);
    if (!item) { const e = new Error('Item not found'); e.status = 404; throw e; }
    const scanned = scanProductFolder(item.product_folder);
    const img = (scanned.images || []).find((i) => i.rank === Number(rank));
    if (!img) { const e = new Error('Image not found'); e.status = 404; throw e; }
    const root = path.resolve(job.input_path);
    const resolved = path.resolve(img.path);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      const e = new Error('Image outside job input path'); e.status = 403; throw e;
    }
    return { path: resolved, mime: img.mime, filename: img.filename };
  }

  // ── Manual review (QA sign-off) ───────────────────────────────────────────
  /**
   * Toggle an item's "manually reviewed" sign-off. Pure local state (no Etsy
   * call) — lets the operator track which generated listings they've vetted and
   * are happy to create/publish.
   * @param {boolean} reviewed
   */
  setItemReviewed(jobId, seq, reviewed) {
    const job = this.getJob(jobId);
    if (!job) { const e = new Error('Job not found'); e.status = 404; throw e; }
    const item = this.getItemBySeq(jobId, seq);
    if (!item) { const e = new Error('Item not found'); e.status = 404; throw e; }
    const ts = reviewed ? now() : null;
    this._updateItem(jobId, item.product_folder, { reviewed_at: ts });
    this._emit(jobId, { type: 'reviewed', folder: item.product_folder, seq: item.seq, reviewed_at: ts });
    return { ok: true, seq: item.seq, reviewed_at: ts };
  }

  /** Bulk toggle review sign-off for a set of items (no Etsy calls). */
  setItemsReviewed(jobId, seqs, reviewed) {
    const job = this.getJob(jobId);
    if (!job) { const e = new Error('Job not found'); e.status = 404; throw e; }
    const wanted = Array.isArray(seqs) ? seqs.map(Number).filter((n) => Number.isFinite(n)) : [];
    if (!wanted.length) { const e = new Error('No listings selected.'); e.status = 400; throw e; }
    const wantedSet = new Set(wanted);
    const ts = reviewed ? now() : null;
    let updated = 0;
    for (const item of this.getItems(jobId)) {
      if (!wantedSet.has(Number(item.seq))) continue;
      this._updateItem(jobId, item.product_folder, { reviewed_at: ts });
      this._emit(jobId, { type: 'reviewed', folder: item.product_folder, seq: item.seq, reviewed_at: ts });
      updated++;
    }
    return { ok: true, updated, reviewed };
  }

  // ── Publishing ─────────────────────────────────────────────────────────────
  /** Publish one created draft listing (state → active). */
  async publishItem(jobId, seq) {
    const job = this.getJob(jobId);
    if (!job) { const e = new Error('Job not found'); e.status = 404; throw e; }
    if (job.dry_run === 1) { const e = new Error('This was a dry run — run it for real before publishing.'); e.status = 400; throw e; }
    const item = this.getItemBySeq(jobId, seq);
    if (!item) { const e = new Error('Item not found'); e.status = 404; throw e; }
    if (!item.listing_id) { const e = new Error('No listing created yet for this product.'); e.status = 400; throw e; }
    if (item.published_at) return { already: true, listing_id: item.listing_id, published_at: item.published_at };

    const { shopClient, numericShopId } = await this.resolveShopClient(job.shop_name);
    await updateListing(shopClient, numericShopId, item.listing_id, { state: 'active' });
    const ts = now();
    this._updateItem(jobId, item.product_folder, { published_at: ts });
    this._emit(jobId, { type: 'publish', folder: item.product_folder, seq: item.seq, ok: true, published_at: ts, listing_id: item.listing_id });
    return { ok: true, listing_id: item.listing_id, published_at: ts };
  }

  /**
   * Publish every created-but-unpublished draft in a job, sequentially (rate
   * budget) in the background, streaming per-item + summary events over SSE.
   */
  publishAll(jobId) {
    const job = this.getJob(jobId);
    if (!job) { const e = new Error('Job not found'); e.status = 404; throw e; }
    if (job.dry_run === 1) { const e = new Error('This was a dry run — run it for real before publishing.'); e.status = 400; throw e; }
    const pubKey = 'publish:' + jobId;
    if (this._running.has(pubKey)) { const e = new Error('Already publishing'); e.status = 409; throw e; }

    const targets = this.getItems(jobId).filter((it) => it.listing_id && !it.published_at);
    if (!targets.length) { const e = new Error('No unpublished draft listings to publish.'); e.status = 400; throw e; }

    this._running.add(pubKey);
    (async () => {
      this._emit(jobId, { type: 'publish_start', total: targets.length });
      const { shopClient, numericShopId } = await this.resolveShopClient(job.shop_name);
      let published = 0;
      let failed = 0;
      for (const it of targets) {
        try {
          await updateListing(shopClient, numericShopId, it.listing_id, { state: 'active' });
          const ts = now();
          this._updateItem(jobId, it.product_folder, { published_at: ts });
          published++;
          this._emit(jobId, { type: 'publish', folder: it.product_folder, seq: it.seq, ok: true, published_at: ts, listing_id: it.listing_id });
        } catch (err) {
          failed++;
          const msg = err.response?.data?.error || err.message;
          this._emit(jobId, { type: 'publish', folder: it.product_folder, seq: it.seq, ok: false, error: msg });
        }
      }
      this._emit(jobId, { type: 'publish_done', published, failed, total: targets.length });
    })()
      .catch((err) => this._emit(jobId, { type: 'publish_done', published: 0, failed: targets.length, error: err.message }))
      .finally(() => this._running.delete(pubKey));

    return { started: true, total: targets.length };
  }

  // ── Price editing ────────────────────────────────────────────────────────────
  /** Keep only known style keys with positive, 2-dp numbers. */
  _sanitizePrices(stylePrices) {
    const clean = {};
    for (const key of STYLE_KEYS) {
      const v = Number(stylePrices?.[key]);
      if (Number.isFinite(v) && v > 0) clean[key] = Math.round(v * 100) / 100;
    }
    return clean;
  }

  /**
   * Validate an operator-supplied variation-photo mapping (style key → [rank]).
   * Drops unknown style keys and ranks that don't exist among the product's
   * images. Returns { styleKey: [rank] } with a single positive integer rank.
   */
  _sanitizeStyleImageMapping(mapping, preview) {
    const out = {};
    if (!mapping || typeof mapping !== 'object') return out;
    const validRanks = new Set(
      ((preview && preview.images) || [])
        .map((im) => Number(im.rank))
        .filter((r) => Number.isFinite(r) && r > 0)
    );
    for (const key of STYLE_ORDER) {
      const raw = mapping[key];
      const rank = Array.isArray(raw) ? Number(raw[0]) : Number(raw);
      if (!Number.isFinite(rank) || rank <= 0) continue;
      // When we know the image list, only accept ranks that actually exist.
      if (validRanks.size && !validRanks.has(rank)) continue;
      out[key] = [rank];
    }
    return out;
  }

  /** Recompute the minimum enabled-style price for a preview. */
  _recomputeMinPrice(preview) {
    const enabled = preview.enabledStyles || {};
    const prices = preview.stylePrices || {};
    let min = Infinity;
    for (const [key, on] of Object.entries(enabled)) {
      if (on && Number.isFinite(prices[key])) min = Math.min(min, prices[key]);
    }
    if (!Number.isFinite(min)) {
      for (const v of Object.values(prices)) if (Number.isFinite(v)) min = Math.min(min, v);
    }
    return Number.isFinite(min) ? min : (preview.minPrice || 0);
  }

  /**
   * Apply edited per-style prices to one item. Persists to the preview and, for
   * an already-created (real) listing, re-pushes the variation inventory so the
   * Etsy draft/listing reflects the new prices immediately.
   */
  async updateItemPrices(jobId, seq, stylePrices) {
    const job = this.getJob(jobId);
    if (!job) { const e = new Error('Job not found'); e.status = 404; throw e; }
    const item = this.getItemBySeq(jobId, seq);
    if (!item) { const e = new Error('Item not found'); e.status = 404; throw e; }

    const clean = this._sanitizePrices(stylePrices);
    if (!Object.keys(clean).length) { const e = new Error('No valid prices supplied.'); e.status = 400; throw e; }

    let preview = {};
    try { preview = item.preview_json ? JSON.parse(item.preview_json) : {}; } catch { preview = {}; }
    let ai = {};
    try { ai = item.ai_json ? JSON.parse(item.ai_json) : {}; } catch { ai = {}; }

    preview.stylePrices = { ...(preview.stylePrices || {}), ...clean };
    if (!preview.enabledStyles || !Object.keys(preview.enabledStyles).length) {
      preview.enabledStyles = computeEnabledStyles(preview.imageAnalysis || ai.imageAnalysis || []);
    }
    preview.minPrice = this._recomputeMinPrice(preview);
    this._updateItem(jobId, item.product_folder, { preview_json: JSON.stringify(preview) });

    let pushed = false;
    if (job.dry_run !== 1 && item.listing_id) {
      const { shopClient, numericShopId } = await this.resolveShopClient(job.shop_name);
      let checkpoint = {};
      try { checkpoint = item.checkpoint_json ? JSON.parse(item.checkpoint_json) : {}; } catch { checkpoint = {}; }
      await repriceListing({
        shopClient, shopId: numericShopId, listingId: item.listing_id,
        prices: preview.stylePrices,
        imageAnalysis: preview.imageAnalysis || ai.imageAnalysis || [],
        restockQuantity: preview.restockQuantity ?? config.bulk.restockQuantity,
        styleImageMapping: preview.styleImageMapping || ai.styleImageMapping || {},
        rankToImageId: checkpoint.rank_to_image_id || {},
        enabledStyles: preview.enabledStyles,
        enabledModels: preview.enabledModels || ai.enabledModels,
        readinessStateId: (preview.settings && preview.settings.readiness_state_id) || null,
      });
      pushed = true;
    }
    this._emit(jobId, { type: 'prices', folder: item.product_folder, seq: item.seq, stylePrices: preview.stylePrices, minPrice: preview.minPrice, pushed });
    return { ok: true, pushed, stylePrices: preview.stylePrices, minPrice: preview.minPrice };
  }

  /**
   * Apply operator-adjusted variation styles (which of the 6 bundles to offer)
   * and optional prices to one item. Persists to the preview, recomputes the
   * enabled-offering matrix, and re-pushes inventory for a live listing.
   */
  async updateItemVariations(jobId, seq, { enabledStyles, stylePrices, styleImageMapping, enabledModels } = {}) {
    const job = this.getJob(jobId);
    if (!job) { const e = new Error('Job not found'); e.status = 404; throw e; }
    const item = this.getItemBySeq(jobId, seq);
    if (!item) { const e = new Error('Item not found'); e.status = 404; throw e; }

    let preview = {};
    try { preview = item.preview_json ? JSON.parse(item.preview_json) : {}; } catch { preview = {}; }
    let ai = {};
    try { ai = item.ai_json ? JSON.parse(item.ai_json) : {}; } catch { ai = {}; }

    if (enabledStyles && typeof enabledStyles === 'object') {
      preview.enabledStyles = normaliseEnabledStyles(enabledStyles);
    } else if (!preview.enabledStyles || !Object.keys(preview.enabledStyles).length) {
      preview.enabledStyles = computeEnabledStyles(preview.imageAnalysis || ai.imageAnalysis || []);
    }
    let aiModelsDirty = false;
    if (enabledModels && typeof enabledModels === 'object') {
      preview.enabledModels = normaliseEnabledModels(enabledModels);
      ai.enabledModels = preview.enabledModels; // honoured by the real create
      aiModelsDirty = true;
      // Keep the description's "Device Compatibility" AND the title's device range
      // consistent with the offered models (cheap, no AI re-run).
      if (preview.description) preview.description = filterModelsInDescription(preview.description, preview.enabledModels);
      if (ai.description) ai.description = filterModelsInDescription(ai.description, preview.enabledModels);
      if (preview.title) preview.title = retitleForModels(preview.title, preview.enabledModels);
      if (ai.title) ai.title = retitleForModels(ai.title, preview.enabledModels);
    } else if (!preview.enabledModels || !Object.keys(preview.enabledModels).length) {
      preview.enabledModels = normaliseEnabledModels(ai.enabledModels);
    }
    if (stylePrices && typeof stylePrices === 'object') {
      const clean = this._sanitizePrices(stylePrices);
      preview.stylePrices = { ...(preview.stylePrices || {}), ...clean };
    }
    // Operator-chosen variation photos (style key → [image rank]). Replaces the
    // mapping so the UI is the source of truth ("what you see is what we push").
    let aiDirty = false;
    if (styleImageMapping && typeof styleImageMapping === 'object') {
      preview.styleImageMapping = this._sanitizeStyleImageMapping(styleImageMapping, preview);
      // Mirror onto the cached copy so a later real-run create honours the choice.
      ai.styleImageMapping = preview.styleImageMapping;
      aiDirty = true;
    }
    preview.minPrice = this._recomputeMinPrice(preview);
    this._updateItem(jobId, item.product_folder, {
      preview_json: JSON.stringify(preview),
      ...(aiDirty || aiModelsDirty ? { ai_json: JSON.stringify(ai) } : {}),
      ...(aiModelsDirty && preview.title ? { title: preview.title } : {}),
    });

    let pushed = false;
    if (job.dry_run !== 1 && item.listing_id) {
      const { shopClient, numericShopId } = await this.resolveShopClient(job.shop_name);
      let checkpoint = {};
      try { checkpoint = item.checkpoint_json ? JSON.parse(item.checkpoint_json) : {}; } catch { checkpoint = {}; }
      // If the model change rewrote the title/description, push them to the live listing.
      if (aiModelsDirty) {
        try {
          const patch = {};
          if (preview.title) patch.title = preview.title;
          if (preview.description) patch.description = preview.description;
          if (Object.keys(patch).length) await updateListing(shopClient, numericShopId, item.listing_id, patch);
        } catch { /* non-fatal */ }
      }
      await repriceListing({
        shopClient, shopId: numericShopId, listingId: item.listing_id,
        prices: preview.stylePrices || {},
        imageAnalysis: preview.imageAnalysis || ai.imageAnalysis || [],
        restockQuantity: preview.restockQuantity ?? config.bulk.restockQuantity,
        styleImageMapping: preview.styleImageMapping || ai.styleImageMapping || {},
        rankToImageId: checkpoint.rank_to_image_id || {},
        enabledStyles: preview.enabledStyles,
        enabledModels: preview.enabledModels,
        readinessStateId: (preview.settings && preview.settings.readiness_state_id) || null,
      });
      pushed = true;
    }
    const enabledCount = STYLE_ORDER.filter((k) => preview.enabledStyles[k]).length;
    this._emit(jobId, { type: 'prices', folder: item.product_folder, seq: item.seq, stylePrices: preview.stylePrices, minPrice: preview.minPrice, enabledStyles: preview.enabledStyles, enabledModels: preview.enabledModels, title: aiModelsDirty ? preview.title : undefined, pushed });
    return { ok: true, pushed, enabledStyles: preview.enabledStyles, enabledModels: preview.enabledModels, stylePrices: preview.stylePrices, minPrice: preview.minPrice, enabledCount, styleImageMapping: preview.styleImageMapping || {}, title: preview.title, description: preview.description };
  }

  /**
   * Apply one price set to EVERY item in the job (background + SSE). Re-pushes
   * any already-created listings sequentially (rate budget).
   */
  updateAllPrices(jobId, stylePrices) {
    const job = this.getJob(jobId);
    if (!job) { const e = new Error('Job not found'); e.status = 404; throw e; }
    const clean = this._sanitizePrices(stylePrices);
    if (!Object.keys(clean).length) { const e = new Error('No valid prices supplied.'); e.status = 400; throw e; }
    const key = 'prices:' + jobId;
    if (this._running.has(key)) { const e = new Error('A bulk price update is already running'); e.status = 409; throw e; }

    const items = this.getItems(jobId);
    this._running.add(key);
    (async () => {
      this._emit(jobId, { type: 'reprice_start', total: items.length });
      let updated = 0;
      let pushed = 0;
      let failed = 0;
      let shopCtx = null;
      for (const item of items) {
        try {
          let preview = {};
          try { preview = item.preview_json ? JSON.parse(item.preview_json) : {}; } catch { preview = {}; }
          let ai = {};
          try { ai = item.ai_json ? JSON.parse(item.ai_json) : {}; } catch { ai = {}; }
          preview.stylePrices = { ...(preview.stylePrices || {}), ...clean };
          if (!preview.enabledStyles || !Object.keys(preview.enabledStyles).length) {
            preview.enabledStyles = computeEnabledStyles(preview.imageAnalysis || ai.imageAnalysis || []);
          }
          preview.minPrice = this._recomputeMinPrice(preview);
          this._updateItem(jobId, item.product_folder, { preview_json: JSON.stringify(preview) });
          updated++;

          if (job.dry_run !== 1 && item.listing_id) {
            if (!shopCtx) shopCtx = await this.resolveShopClient(job.shop_name);
            let checkpoint = {};
            try { checkpoint = item.checkpoint_json ? JSON.parse(item.checkpoint_json) : {}; } catch { checkpoint = {}; }
            await repriceListing({
              shopClient: shopCtx.shopClient, shopId: shopCtx.numericShopId, listingId: item.listing_id,
              prices: preview.stylePrices,
              imageAnalysis: preview.imageAnalysis || ai.imageAnalysis || [],
              restockQuantity: preview.restockQuantity ?? config.bulk.restockQuantity,
              styleImageMapping: preview.styleImageMapping || ai.styleImageMapping || {},
              rankToImageId: checkpoint.rank_to_image_id || {},
              enabledStyles: preview.enabledStyles,
              enabledModels: preview.enabledModels || ai.enabledModels,
              readinessStateId: (preview.settings && preview.settings.readiness_state_id) || null,
            });
            pushed++;
          }
          this._emit(jobId, { type: 'prices', folder: item.product_folder, seq: item.seq, stylePrices: preview.stylePrices, minPrice: preview.minPrice, pushed: job.dry_run !== 1 && !!item.listing_id });
        } catch (err) {
          failed++;
          this._emit(jobId, { type: 'reprice_item_failed', folder: item.product_folder, seq: item.seq, error: err.response?.data?.error || err.message });
        }
      }
      this._emit(jobId, { type: 'reprice_done', updated, pushed, failed });
    })()
      .catch((err) => this._emit(jobId, { type: 'reprice_done', updated: 0, pushed: 0, failed: items.length, error: err.message }))
      .finally(() => this._running.delete(key));

    return { started: true, total: items.length, prices: clean };
  }

  /**
   * Bulk-apply an iPhone-model selection to a chosen subset of items (background
   * + SSE). For each selected item: persists enabledModels, re-filters the
   * description's compatibility list (no AI), and — for already-created listings
   * — re-pushes the inventory so the live model dropdown matches.
   *
   * @param {string} jobId
   * @param {number[]} seqs                 1-based item sequences to update
   * @param {Record<string,boolean>} enabledModels
   */
  bulkUpdateModels(jobId, seqs, enabledModels) {
    const job = this.getJob(jobId);
    if (!job) { const e = new Error('Job not found'); e.status = 404; throw e; }
    const models = normaliseEnabledModels(enabledModels);
    const wanted = Array.isArray(seqs) ? seqs.map(Number).filter((n) => Number.isFinite(n)) : [];
    if (!wanted.length) { const e = new Error('No listings selected.'); e.status = 400; throw e; }

    const key = 'models:' + jobId;
    if (this._running.has(key)) { const e = new Error('A bulk model update is already running'); e.status = 409; throw e; }

    const wantedSet = new Set(wanted);
    const items = this.getItems(jobId).filter((it) => wantedSet.has(Number(it.seq)));
    this._running.add(key);

    (async () => {
      this._emit(jobId, { type: 'bulk_models_start', total: items.length });
      let updated = 0;
      let pushed = 0;
      let failed = 0;
      let shopCtx = null;
      for (const item of items) {
        try {
          let preview = {};
          let ai = {};
          try { preview = item.preview_json ? JSON.parse(item.preview_json) : {}; } catch { preview = {}; }
          try { ai = item.ai_json ? JSON.parse(item.ai_json) : {}; } catch { ai = {}; }

          preview.enabledModels = models;
          ai.enabledModels = models;
          // Keep BOTH the description compatibility list AND the title's device
          // range in sync with the new models — no AI re-run needed.
          if (preview.description) preview.description = filterModelsInDescription(preview.description, models);
          if (ai.description) ai.description = filterModelsInDescription(ai.description, models);
          if (preview.title) preview.title = retitleForModels(preview.title, models);
          if (ai.title) ai.title = retitleForModels(ai.title, models);

          const newTitle = preview.title || ai.title || item.title;
          this._updateItem(jobId, item.product_folder, {
            preview_json: JSON.stringify(preview),
            ai_json: JSON.stringify(ai),
            ...(newTitle ? { title: newTitle } : {}),
          });
          updated++;

          // Live listing → re-push inventory + the trimmed description.
          if (job.dry_run !== 1 && item.listing_id) {
            if (!shopCtx) shopCtx = await this.resolveShopClient(job.shop_name);
            let checkpoint = {};
            try { checkpoint = item.checkpoint_json ? JSON.parse(item.checkpoint_json) : {}; } catch { checkpoint = {}; }
            await repriceListing({
              shopClient: shopCtx.shopClient, shopId: shopCtx.numericShopId, listingId: item.listing_id,
              prices: preview.stylePrices || {},
              imageAnalysis: preview.imageAnalysis || ai.imageAnalysis || [],
              restockQuantity: preview.restockQuantity ?? config.bulk.restockQuantity,
              styleImageMapping: preview.styleImageMapping || ai.styleImageMapping || {},
              rankToImageId: checkpoint.rank_to_image_id || {},
              enabledStyles: preview.enabledStyles,
              enabledModels: models,
              readinessStateId: (preview.settings && preview.settings.readiness_state_id) || null,
            });
            // Push the updated title + description to the live listing.
            try {
              const patch = {};
              if (preview.description) patch.description = preview.description;
              if (newTitle) patch.title = newTitle;
              if (Object.keys(patch).length) await updateListing(shopCtx.shopClient, shopCtx.numericShopId, item.listing_id, patch);
            } catch { /* non-fatal */ }
            pushed++;
          }
          this._emit(jobId, { type: 'bulk_models_item', folder: item.product_folder, seq: item.seq, enabledModels: models, title: newTitle, done: updated });
        } catch (err) {
          failed++;
          this._emit(jobId, { type: 'bulk_models_item_failed', folder: item.product_folder, seq: item.seq, error: err.response?.data?.error || err.message });
        }
      }
      this._emit(jobId, { type: 'bulk_models_done', updated, pushed, failed });
    })()
      .catch((err) => this._emit(jobId, { type: 'bulk_models_done', updated: 0, pushed: 0, failed: items.length, error: err.message }))
      .finally(() => this._running.delete(key));

    return { started: true, total: items.length, enabledModels: models };
  }

  // ── Character correction (human-in-the-loop) ───────────────────────────────────
  /**
   * Kick off a single product's copy regeneration as a DETACHED background task
   * (Phase-2 only). Validates synchronously (so the caller still gets 404/400/409
   * errors), then returns immediately with `{ started: true }`. The actual AI
   * work + Etsy push runs independently of the HTTP request and streams its
   * result over SSE (`regen_start` / `item` / `regen_done` / `regen_failed`), so
   * the operator can leave the page and the regeneration still completes.
   */
  startRegenerateItemCopy(jobId, seq, opts = {}) {
    const job = this.getJob(jobId);
    if (!job) { const e = new Error('Job not found'); e.status = 404; throw e; }
    const item = this.getItemBySeq(jobId, seq);
    if (!item) { const e = new Error('Item not found'); e.status = 404; throw e; }

    // Quick precheck: there must be something to regenerate from.
    let ai = {};
    try { ai = item.ai_json ? JSON.parse(item.ai_json) : {}; } catch { ai = {}; }
    let preview = {};
    try { preview = item.preview_json ? JSON.parse(item.preview_json) : {}; } catch { preview = {}; }
    const imageAnalysis = ai.imageAnalysis || preview.imageAnalysis || [];
    if (!imageAnalysis.length && !opts.characterName) {
      const e = new Error('No cached image analysis to regenerate from.'); e.status = 400; throw e;
    }

    // Per-item guard: allow different items to regenerate in parallel, but block
    // a duplicate regeneration of the SAME item.
    const key = 'regen:' + jobId + ':' + item.seq;
    if (this._running.has(key)) { const e = new Error('This listing is already regenerating.'); e.status = 409; throw e; }
    this._running.add(key);

    this._runRegenerateItemCopy(jobId, item, job, opts)
      .catch((err) => this._emit(jobId, {
        type: 'regen_failed', folder: item.product_folder, seq: item.seq,
        error: err.response?.data?.error || err.message,
      }))
      .finally(() => this._running.delete(key));

    return { started: true, seq: item.seq };
  }

  /**
   * Regenerate a single product's copy (Phase-2 only) — optionally with a human-
   * corrected character name. Updates the cached copy + preview, and for a
   * created (real) listing pushes the new title/description/tags to Etsy.
   * Runs detached from the HTTP request; emits SSE progress events.
   */
  async _runRegenerateItemCopy(jobId, item, job, { characterName, magsafe, enabledModels, enabledStyles, styleImageMapping } = {}) {
    this._emit(jobId, { type: 'regen_start', folder: item.product_folder, seq: item.seq });

    let ai = {};
    try { ai = item.ai_json ? JSON.parse(item.ai_json) : {}; } catch { ai = {}; }
    let preview = {};
    try { preview = item.preview_json ? JSON.parse(item.preview_json) : {}; } catch { preview = {}; }
    const imageAnalysis = ai.imageAnalysis || preview.imageAnalysis || [];
    const productSummary = ai.productSummary || {};

    // Resolve which iPhone models to advertise: an explicit override wins,
    // otherwise reuse the item's existing selection (default all 12).
    const modelsForCopy = normaliseEnabledModels(
      (enabledModels && typeof enabledModels === 'object') ? enabledModels : (preview.enabledModels || ai.enabledModels),
    );
    // Operator's corrected style matrix drives the "What's Included" bundles +
    // grip/charm copy. Explicit override wins, else the saved preview selection.
    const stylesForCopy = (enabledStyles && typeof enabledStyles === 'object' && Object.keys(enabledStyles).length)
      ? enabledStyles
      : (preview.enabledStyles || ai.enabledStyles || null);

    // Only an EXPLICIT operator MagSafe toggle overrides the cached (dedicated-pass)
    // detection — never auto-clear it, so a correctly detected MagSafe survives a
    // copy regeneration.
    if (Array.isArray(imageAnalysis) && typeof magsafe === 'boolean') {
      for (const img of imageAnalysis) img.has_magsafe_ring = magsafe;
    }

    const opts = JSON.parse(job.options_json || '{}');
    const brandTags = opts.brandTags || [];

    // Best-effort: fetch the taxonomy attribute menu so regenerated copy can also
    // pick valid Etsy "feature section" values (Theme/Occasion/etc.).
    let attributeMenu = null;
    try {
      const taxonomyId = (preview.settings && preview.settings.taxonomy_id)
        || (opts.overrides && opts.overrides.taxonomy_id) || null;
      if (taxonomyId) {
        const { shopClient } = await this.resolveShopClient(job.shop_name);
        ({ menu: attributeMenu } = await getTaxonomyAttributes(shopClient, taxonomyId));
      }
    } catch { attributeMenu = null; }

    // Preserve the operator's manually-linked variation images across a copy
    // regeneration (regenerate only rewrites text — it must NOT re-derive links).
    // Precedence: explicit request mapping (latest UI state) > saved preview > ai.
    const explicitImages = (styleImageMapping && typeof styleImageMapping === 'object' && Object.keys(styleImageMapping).length)
      ? this._sanitizeStyleImageMapping(styleImageMapping, preview)
      : null;
    const savedStyleImages = explicitImages
      || (preview.styleImageMapping && Object.keys(preview.styleImageMapping).length ? preview.styleImageMapping : (ai.styleImageMapping || null));

    const copy = await generateCopyFromAnalysis({
      imageAnalysis, productSummary, characterOverride: characterName,
      shopName: job.shop_name, brandTags, enabledModels: modelsForCopy, enabledStyles: stylesForCopy,
      styleImageMapping: savedStyleImages, attributeMenu,
    });
    // Persist the (possibly overridden) image analysis so the corrected MagSafe
    // state sticks for future regenerations and the real create.
    copy.imageAnalysis = imageAnalysis;

    const newAi = { ...ai, ...copy };
    preview.title = copy.title;
    preview.description = copy.description;
    preview.tags = copy.tags || [];
    preview.primaryColor = copy.primaryColor || preview.primaryColor;
    preview.secondaryColor = copy.secondaryColor || preview.secondaryColor;
    preview.character = copy.characterName || '';
    preview.characterDetected = copy.characterDetected || '';
    preview.characterFranchise = copy.characterFranchise || '';
    preview.characterConfidence = copy.characterConfidence;
    preview.characterEvidence = copy.characterEvidence || '';
    preview.characterAlternatives = copy.characterAlternatives || [];
    preview.characterLowConfidence = copy.characterLowConfidence || false;
    preview.styleImageMapping = copy.styleImageMapping || preview.styleImageMapping || {};
    preview.enabledModels = copy.enabledModels || preview.enabledModels;
    preview.aiAttributes = copy.aiAttributes || preview.aiAttributes || null;

    this._updateItem(jobId, item.product_folder, {
      ai_json: JSON.stringify(newAi), title: copy.title, preview_json: JSON.stringify(preview),
    });

    let pushed = false;
    if (job.dry_run !== 1 && item.listing_id) {
      const { shopClient, numericShopId } = await this.resolveShopClient(job.shop_name);
      await updateListing(shopClient, numericShopId, item.listing_id, {
        title: copy.title, description: copy.description, tags: copy.tags || [],
      });
      pushed = true;
    }
    this._emit(jobId, { type: 'item', folder: item.product_folder, seq: item.seq, status: item.status, title: copy.title });
    this._emit(jobId, {
      type: 'regen_done', folder: item.product_folder, seq: item.seq,
      title: copy.title, character: copy.characterName, characterConfidence: copy.characterConfidence, pushed,
    });
    return { ok: true, pushed, title: copy.title, character: copy.characterName, characterConfidence: copy.characterConfidence };
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
  createAndStart({ shopName, inputPath, targetState = 'draft', dryRun = false, overrides = {}, brandTags, stylePrices }) {
    const { products } = scanInputRoot(inputPath);
    if (!products.length) {
      const err = new Error(`No products with images found in "${inputPath}".`);
      err.status = 400;
      throw err;
    }

    const cleanStylePrices = stylePrices ? this._sanitizePrices(stylePrices) : undefined;
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
      options_json: JSON.stringify({
        overrides,
        brandTags: brandTags || defaultBrandTag(shopName),
        stylePrices: cleanStylePrices,
      }),
    });

    const insertItem = this.db.prepare(`
      INSERT INTO bulk_job_items (job_id, product_folder, product_name, seq, status)
      VALUES (@job_id, @folder, @name, @seq, 'pending')
    `);
    const tx = this.db.transaction((items) => { for (const it of items) insertItem.run(it); });
    // products[] arrives in natural-sort order from the scanner — persist that
    // index as seq so it survives the DB round-trip.
    tx(products.map((p, i) => ({ job_id: jobId, folder: p.folder, name: p.name, seq: i + 1 })));

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
   * Promote a finished DRY-RUN job into a real run that creates Etsy DRAFT
   * listings — reusing every reviewed preview (character / MagSafe / model /
   * style / copy corrections) WITHOUT re-running the AI. This is the "approve &
   * publish to Etsy" step: review in the dry run, then create the real drafts
   * with one click and zero recomputation.
   */
  createDraftsFromDryRun(jobId) {
    const job = this.getJob(jobId);
    if (!job) { const e = new Error('Job not found'); e.status = 404; throw e; }
    if (this.isActive(jobId)) { const e = new Error('Job is currently running — wait for it to finish.'); e.status = 409; throw e; }
    if (job.dry_run !== 1) { const e = new Error('This run already creates real listings — use Resume/Retry instead.'); e.status = 400; throw e; }

    // Fold the reviewed preview edits back into the cached copy (ai_json) so the
    // real create honours every operator correction, then reset each item so the
    // runner takes the create path (which reuses ai_json and skips the AI).
    const items = this.getItems(jobId);
    let prepared = 0;
    for (const item of items) {
      let preview = {};
      let ai = {};
      try { preview = item.preview_json ? JSON.parse(item.preview_json) : {}; } catch { preview = {}; }
      try { ai = item.ai_json ? JSON.parse(item.ai_json) : {}; } catch { ai = {}; }
      if (!ai || !Object.keys(ai).length) continue; // never generated → leave for a fresh AI pass

      if (preview.title) ai.title = preview.title;
      if (preview.description) ai.description = preview.description;
      if (Array.isArray(preview.tags) && preview.tags.length) ai.tags = preview.tags;
      if (preview.primaryColor) ai.primaryColor = preview.primaryColor;
      if (preview.secondaryColor) ai.secondaryColor = preview.secondaryColor;
      if (preview.character) ai.characterName = preview.character;
      if (preview.enabledStyles && Object.keys(preview.enabledStyles).length) ai.enabledStyles = preview.enabledStyles;
      if (preview.enabledModels && Object.keys(preview.enabledModels).length) ai.enabledModels = preview.enabledModels;
      if (preview.styleImageMapping) ai.styleImageMapping = preview.styleImageMapping;
      if (Array.isArray(preview.imageAnalysis) && preview.imageAnalysis.length) ai.imageAnalysis = preview.imageAnalysis;
      if (preview.aiAttributes) ai.aiAttributes = preview.aiAttributes;

      this._updateItem(jobId, item.product_folder, {
        ai_json: JSON.stringify(ai),
        status: 'pending',
        listing_id: null,
        listing_url: null,
        published_at: null,
        checkpoint_json: null, // clear the dry-run {preview:true} marker
        error: null,
      });
      prepared++;
    }
    if (!prepared) { const e = new Error('No reviewed products to create — generate copy first.'); e.status = 400; throw e; }

    // Flip to a real run targeting DRAFT, reset counters, and launch.
    this._updateJob(jobId, { dry_run: 0, target_state: 'draft', state: 'queued', completed: 0, failed: 0, finished_at: null, error: null });

    const opts = JSON.parse(job.options_json || '{}');
    this.run(jobId, {
      overrides: opts.overrides || {},
      brandTags: opts.brandTags || defaultBrandTag(job.shop_name),
      onlyUnfinished: false,
    }).catch((err) => {
      this._updateJob(jobId, { state: 'error', error: err.message, finished_at: now() });
      this._emit(jobId, { type: 'job', state: 'error', error: err.message });
    });

    return this.getJob(jobId);
  }

  // ── Pause / Resume / Cancel ──────────────────────────────────────────────────
  // Cooperative control: the run loop checks _control between products, so a
  // pause/cancel takes effect after the in-flight product finishes (it never
  // leaves a listing half-created — each product is atomic + checkpointed).

  /** Signal a running job to pause after the current product. */
  pause(jobId) {
    const job = this.getJob(jobId);
    if (!job) { const e = new Error('Job not found'); e.status = 404; throw e; }
    if (!this._running.has(jobId)) { const e = new Error('Job is not running'); e.status = 409; throw e; }
    this._control.set(jobId, 'pause');
    this._emit(jobId, { type: 'job', state: 'pausing' });
    return this.getJob(jobId);
  }

  /** Resume a paused (or otherwise incomplete) job from where it stopped. */
  resume(jobId, { overrides, brandTags } = {}) {
    const job = this.getJob(jobId);
    if (!job) { const e = new Error('Job not found'); e.status = 404; throw e; }
    if (this._running.has(jobId)) { const e = new Error('Job already running'); e.status = 409; throw e; }
    this._control.delete(jobId);
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

  /** Cancel a job. If running, stops after the current product; else marks cancelled now. */
  cancel(jobId) {
    const job = this.getJob(jobId);
    if (!job) { const e = new Error('Job not found'); e.status = 404; throw e; }
    if (this._running.has(jobId)) {
      this._control.set(jobId, 'cancel');
      this._emit(jobId, { type: 'job', state: 'cancelling' });
    } else {
      this._updateJob(jobId, { state: 'cancelled', finished_at: now() });
      this._emit(jobId, { type: 'job', state: 'cancelled' });
    }
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
      const { shopClient, numericShopId, shopCfg, scopes } = await this.resolveShopClient(job.shop_name);

      // Pre-flight: a real (non-dry) run creates/edits listings, which needs the
      // listings_w OAuth scope. If the token is KNOWN to lack it, fail the whole
      // run ONCE with a clear, actionable message instead of failing every item.
      if (job.dry_run !== 1 && Array.isArray(scopes) && !scopes.includes('listings_w')) {
        const e = new Error(
          `This shop's Etsy token is missing the "listings_w" permission, so listings cannot be created. ` +
          `Re-authorise ${job.shop_name}: run "npm run oauth:setup", pick this shop, and approve ALL scopes (incl. "List and edit listings"). Then retry.`,
        );
        e.status = 403;
        throw e;
      }
      const settings = await getShopListingSettings({
        db: this.db, shopClient, shopId: numericShopId, shopKey: job.shop_key, force: false,
      });

      // Merge UI overrides onto the auto-selected defaults — but NEVER let an
      // empty/null override clobber a resolved default (e.g. a "Retry" from a
      // loaded job sends blank form fields as null; those must not wipe the
      // taxonomy_id / shipping_profile_id the shop settings already resolved).
      const cleanOverrides = {};
      for (const [k, v] of Object.entries(overrides || {})) {
        if (v == null) continue;
        if (Array.isArray(v) && v.length === 0) continue;
        if (typeof v === 'string' && v.trim() === '') continue;
        cleanOverrides[k] = v;
      }
      const storedOverrides = (() => { try { return JSON.parse(job.options_json || '{}').overrides || {}; } catch { return {}; } })();
      // Layer: resolved shop defaults < the run's stored overrides < non-empty live overrides.
      const defaults = { ...settings.defaults, ...storedOverrides, ...cleanOverrides };
      const mergedSettings = { ...settings, defaults };

      // Taxonomy attribute menu (Theme/Occasion/Celebration/Pattern allowed values)
      // so Phase 2 can pick valid Etsy "feature section" values. One cached call.
      let attributeMenu = null;
      try {
        ({ menu: attributeMenu } = await getTaxonomyAttributes(shopClient, defaults.taxonomy_id));
      } catch { attributeMenu = null; }

      // Default variation prices = the shop's CURRENT prices (cached inventory),
      // with the master sheet filling any gap, and any explicit run-config
      // prices (set in the Variation Prices card) overriding everything.
      const currency = overrides.currency_code || settings.currency_code;
      let sheetPrices = {};
      try { sheetPrices = getPricesForCurrency(currency, { column: 'anchor' }).prices; } catch { sheetPrices = {}; }
      const { prices: defaultPrices, shop: shopPrices } = resolveDefaultPrices({
        db: this.db, shopId: shopCfg.shop_id, sheetPrices,
      });
      const jobOpts = JSON.parse(job.options_json || '{}');
      const runStylePrices = this._sanitizePrices(jobOpts.stylePrices || {});
      const finalPrices = { ...sheetPrices, ...defaultPrices, ...runStylePrices };
      const priceInfo = { currency: String(currency || '').toUpperCase(), token: currency, prices: finalPrices };
      const priceSrc = Object.keys(runStylePrices).length ? 'custom' : (shopPrices.hasData ? 'shop' : 'sheet');
      this._emit(jobId, { type: 'info', message: `Currency ${priceInfo.currency}; prices from ${priceSrc}; taxonomy ${defaults.taxonomy_id || 'unresolved'}` });

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
            this._emit(jobId, { type: 'step', folder: item.product_folder, step: 'ai_cached' });
          } else {
            this._emit(jobId, { type: 'step', folder: item.product_folder, step: 'ai', images: product.images.length });
            copy = await generateListingCopy(product, { shopName: job.shop_name, brandTags, attributeMenu });
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
            options: { state: targetState, restockQuantity, dryRun, currency: priceInfo.currency },
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
              checkpoint_json: JSON.stringify({ preview: true }),
              preview_json: JSON.stringify(result.preview || {}),
            });
          } else {
            this._updateItem(jobId, item.product_folder, {
              status: 'done', listing_id: result.listing_id, listing_url: result.url,
              title: copy.title, error: null, checkpoint_json: JSON.stringify(result.checkpoint),
              preview_json: JSON.stringify(result.preview || {}),
            });
          }
          completed++;
          // Fresh progress — clear the crash-loop budget so a long run can always
          // self-heal across restarts as long as it keeps completing products.
          try { this._updateJob(jobId, { auto_resume_count: 0 }); } catch { /* non-fatal */ }
          this._emit(jobId, {
            type: 'item', folder: item.product_folder, status: 'done',
            listing_id: result.listing_id, url: result.url, title: copy.title,
          });
        } catch (err) {
          let msg = err.response?.data?.error || err.response?.data?.error_description || err.message;
          // Make the "missing scope" failure actionable instead of cryptic.
          if (/lacks scope|requires scope|listings_w/i.test(msg || '')) {
            msg = `Etsy token is missing the "listings_w" permission — re-run "npm run oauth:setup" for ${job.shop_name} and approve ALL scopes, then retry.`;
          }
          this._updateItem(jobId, item.product_folder, { status: 'failed', error: msg });
          failed++;
          this._emit(jobId, { type: 'item', folder: item.product_folder, status: 'failed', error: msg });
        } finally {
          this._updateJob(jobId, { completed, failed });
        }
      };

      // Simple bounded worker pool. A cooperative pause/cancel signal is checked
      // between products so the in-flight product always finishes cleanly.
      const queue = [...items];
      let stoppedBy = null; // 'pause' | 'cancel'
      const workers = Array.from({ length: concurrency }, async () => {
        while (queue.length) {
          const signal = this._control.get(jobId);
          if (signal) { stoppedBy = signal; break; }
          const it = queue.shift();
          if (it) await processItem(it);
        }
      });
      await Promise.all(workers);
      this._control.delete(jobId);

      if (stoppedBy === 'cancel') {
        this._updateJob(jobId, { state: 'cancelled', completed, failed, finished_at: now() });
        this._emit(jobId, { type: 'job', state: 'cancelled', completed, failed });
      } else if (stoppedBy === 'pause') {
        this._updateJob(jobId, { state: 'paused', completed, failed });
        this._emit(jobId, { type: 'job', state: 'paused', completed, failed });
      } else {
        this._updateJob(jobId, { state: 'done', completed, failed, finished_at: now() });
        this._emit(jobId, { type: 'job', state: 'done', completed, failed });
      }
    } finally {
      this._running.delete(jobId);
    }
  }
}

module.exports = { BulkJobManager, defaultBrandTag };
