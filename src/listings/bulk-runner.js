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
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const { scanInputRoot, scanProductFolder, MAX_IMAGES, IMAGE_EXTS } = require('./scanner');
const { getPricesForCurrency, STYLE_KEYS } = require('./pricing');
const { resolveDefaultPrices } = require('./shop-prices');
const { generateListingCopy, generateCopyFromAnalysis, filterModelsInDescription, retitleForModels } = require('./ai-generator');
const { getShopListingSettings, reconcileShopSection } = require('./shop-settings');
const { createListingForProduct, repriceListing } = require('./etsy-create');
const { getTaxonomyAttributes } = require('./attributes');
const { computeEnabledStyles, normaliseEnabledStyles, normaliseCustomStyles, normaliseEnabledModels, STYLE_ORDER } = require('./variation-builder');
const { updateListing } = require('../etsy/client');
const { getProductType } = require('./product-types');
const { config } = require('./config');

function now() { return Math.floor(Date.now() / 1000); }

// Derive a safe single brand tag from a shop display name (<=20 chars, tag-safe).
function defaultBrandTag(shopName) {
  const t = String(shopName || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  return t ? [t.slice(0, 20)] : [];
}

/** The product type for a job (from options_json). Defaults to iPhone case. */
function jobProductType(job) {
  try { return JSON.parse(job.options_json || '{}').productType || 'iphone_case'; } catch { return 'iphone_case'; }
}

/**
 * Apply an operator-curated image plan to a freshly-scanned product before it
 * is uploaded to Etsy. The plan lives in the item's preview (`imageOrder` — an
 * ordered array of filenames the operator kept in the Inspector). We reorder
 * and filter the scanned images to match, then renumber ranks 1..N so the
 * thumbnail (rank 1) and variation-photo links stay in lock-step with what the
 * operator saw. When no plan exists (or none of its files still resolve) the
 * natural-sort scan order is used unchanged — never wipe a product's images.
 *
 * @param {object} product  scanner result ({ images:[{path,filename,mime,rank}], ... })
 * @param {object} preview  the item's persisted preview_json (may be null)
 * @returns {object} product with images reordered/filtered + re-ranked
 */
function applyImagePlan(product, preview) {
  const order = preview && Array.isArray(preview.imageOrder) ? preview.imageOrder : null;
  if (!order || !order.length) return product;
  // Resolve plan filenames against the FULL on-disk image set, not just the
  // natural-sort top-MAX_IMAGES that scanInputRoot returned: a kept photo can
  // sort past the cap (an operator-uploaded `upload-<ts>` file, or a listing
  // that still holds orphan files from a pre-archiving removal). Missing that
  // file would silently drop it from the upload. The plan is itself bounded to
  // ≤MAX_IMAGES, so the result never exceeds Etsy's cap.
  let byName;
  try {
    const all = scanProductFolder(product.folder, { maxImages: Infinity }).images || [];
    byName = new Map(all.map((im) => [im.filename, im]));
  } catch {
    byName = new Map();
  }
  for (const im of product.images || []) if (!byName.has(im.filename)) byName.set(im.filename, im);
  const picked = [];
  const seen = new Set();
  for (const fn of order) {
    if (seen.has(fn)) continue;
    const im = byName.get(fn);
    if (im) { picked.push(im); seen.add(fn); }
  }
  if (!picked.length) return product; // safety: plan resolved to nothing → keep scan
  const images = picked.map((im, i) => ({ ...im, rank: i + 1 }));
  return { ...product, images, imageCount: images.length };
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
    this._itemRevs = new Map();    // job_id\0folder → write revision (lost-update guard)
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

    // Product-type metadata so the Inspector renders the CORRECT device models +
    // style bundles for THIS job (e.g. AirPods models/styles), independent of
    // whatever product type the setup card currently has selected.
    const pt = getProductType(jobProductType(job));
    return {
      job: {
        job_id: job.job_id, shop_name: job.shop_name, dry_run: job.dry_run === 1,
        target_state: job.target_state, state: job.state,
        product_type: pt.id,
      },
      productMeta: {
        product_type: pt.id,
        models: pt.models.slice(),
        style_keys: pt.allowedStyles.slice(),
        device_label: pt.deviceLabel,
        supports_grip: pt.supportsGrip,
        supports_magsafe: pt.supportsMagsafe,
      },
      item: {
        seq: item.seq, name: item.product_name, folder: item.product_folder,
        status: item.status, listing_id: item.listing_id, listing_url: item.listing_url,
        error: item.error, published_at: item.published_at, reviewed_at: item.reviewed_at,
        excluded: item.excluded === 1,
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
    // Scan UNCAPPED: a planned/uploaded photo may natural-sort past MAX_IMAGES
    // when the folder still holds orphan files, and it must still stream.
    const scanned = scanProductFolder(item.product_folder, { maxImages: Infinity });
    // Prefer the persisted preview order (rank → filename) so an operator's
    // reordering/removal in the Inspector is honoured when streaming thumbnails.
    // The folder's own natural-sort rank is only a fallback for legacy items.
    let preview = null;
    try { preview = item.preview_json ? JSON.parse(item.preview_json) : null; } catch { preview = null; }
    const planned = preview && Array.isArray(preview.images)
      ? preview.images.find((i) => Number(i.rank) === Number(rank))
      : null;
    let img = null;
    if (planned && planned.filename) img = (scanned.images || []).find((i) => i.filename === planned.filename);
    if (!img) img = (scanned.images || []).find((i) => i.rank === Number(rank));
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

  // ── Exclude / delete (curate which products become listings) ─────────────
  /**
   * Flag a set of items to be SKIPPED when a dry run is promoted to real Etsy
   * drafts (or when the job is (re)run). The rows stay in the list for context;
   * they're simply never created on Etsy. Pure local state — no Etsy calls.
   * @param {number[]} seqs
   * @param {boolean} excluded
   */
  setItemsExcluded(jobId, seqs, excluded) {
    const job = this.getJob(jobId);
    if (!job) { const e = new Error('Job not found'); e.status = 404; throw e; }
    const wanted = Array.isArray(seqs) ? seqs.map(Number).filter((n) => Number.isFinite(n)) : [];
    if (!wanted.length) { const e = new Error('No listings selected.'); e.status = 400; throw e; }
    const wantedSet = new Set(wanted);
    const val = excluded ? 1 : 0;
    let updated = 0;
    for (const item of this.getItems(jobId)) {
      if (!wantedSet.has(Number(item.seq))) continue;
      this._updateItem(jobId, item.product_folder, { excluded: val });
      this._emit(jobId, { type: 'excluded', folder: item.product_folder, seq: item.seq, excluded: !!val });
      updated++;
    }
    return { ok: true, updated, excluded: !!val };
  }

  /**
   * Permanently remove one item from a saved run (does NOT touch files on disk
   * or any already-created Etsy listing — it only drops our tracking row).
   * Refuses while the job is actively executing so we never delete a row that a
   * worker is mid-write on. The job's total is kept in sync.
   */
  deleteItem(jobId, seq) {
    const job = this.getJob(jobId);
    if (!job) { const e = new Error('Job not found'); e.status = 404; throw e; }
    if (this.isActive(jobId)) { const e = new Error('Job is running — pause or wait for it to finish before removing products.'); e.status = 409; throw e; }
    const item = this.getItemBySeq(jobId, seq);
    if (!item) { const e = new Error('Item not found'); e.status = 404; throw e; }
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM bulk_job_items WHERE job_id = ? AND seq = ?').run(jobId, Number(seq));
      const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM bulk_job_items WHERE job_id = ?').get(jobId);
      this.db.prepare('UPDATE bulk_jobs SET total = ? WHERE job_id = ?').run(n, jobId);
    });
    tx();
    this._emit(jobId, { type: 'item_deleted', folder: item.product_folder, seq: Number(seq) });
    return { ok: true, seq: Number(seq) };
  }

  // ── Image curation (reorder / remove) ────────────────────────────────────
  /**
   * Persist an operator-curated image plan for one item: the ordered list of
   * filenames to keep (removed images are simply omitted; the first entry is
   * the thumbnail). We renumber ranks 1..N in the new order and remap the
   * variation-photo links (style → rank) through filenames so a reorder never
   * silently re-points a style to the wrong photo. The plan is honoured when the
   * dry run is promoted to real drafts (see applyImagePlan in the run loop).
   *
   * Only editable at the dry-run/preview stage — once a real listing exists its
   * photos live on Etsy and can't be re-ordered from here.
   *
   * @param {string} jobId
   * @param {number} seq
   * @param {string[]} filenames  kept images, in desired display order
   */
  updateItemImages(jobId, seq, filenames) {
    const job = this.getJob(jobId);
    if (!job) { const e = new Error('Job not found'); e.status = 404; throw e; }
    const item = this.getItemBySeq(jobId, seq);
    if (!item) { const e = new Error('Item not found'); e.status = 404; throw e; }
    if (job.dry_run !== 1 || item.listing_id) {
      const e = new Error('Images can only be re-ordered on a dry-run preview, before the Etsy draft is created.');
      e.status = 400; throw e;
    }

    let preview = {};
    try { preview = item.preview_json ? JSON.parse(item.preview_json) : {}; } catch { preview = {}; }
    let ai = {};
    try { ai = item.ai_json ? JSON.parse(item.ai_json) : {}; } catch { ai = {}; }

    // Natural-sort scan (capped at MAX_IMAGES) — only used as the rank fallback
    // for legacy items whose preview lacks an image list.
    let scanned = [];
    try { scanned = scanProductFolder(item.product_folder).images || []; } catch { scanned = []; }
    // Every image file physically on disk right now, UNCAPPED. The scanner only
    // surfaces the first MAX_IMAGES, but we must see them all to (a) accept a
    // freshly uploaded photo that natural-sorts past the cap and (b) reconcile
    // the folder against the plan below.
    let diskNames = [];
    try {
      diskNames = fs.readdirSync(item.product_folder).filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase()));
    } catch {
      diskNames = scanned.map((im) => im.filename);
    }
    const validNames = new Set(diskNames);

    const requested = Array.isArray(filenames) ? filenames : [];
    const order = [];
    const seen = new Set();
    for (const fn of requested) {
      if (typeof fn !== 'string' || !validNames.has(fn) || seen.has(fn)) continue;
      seen.add(fn); order.push(fn);
    }
    if (!order.length) { const e = new Error('Keep at least one image.'); e.status = 400; throw e; }

    // Reconcile the folder with the plan: any image on disk the operator did NOT
    // keep is soft-deleted into a `_removed/` subfolder. This keeps the folder
    // mirroring the plan so we (a) stay under Etsy's photo cap, (b) never let
    // natural-sort truncation hide a newly added photo, and (c) upload exactly
    // the kept set on the real create. Files are MOVED, never destroyed, so a
    // mistaken removal is fully recoverable.
    const keep = new Set(order);
    this._archiveImages(item.product_folder, diskNames.filter((n) => !keep.has(n)));

    // Map the CURRENT ranks → filenames so we can carry variation-photo links
    // across the reorder. Prefer the saved preview order; fall back to the scan.
    const oldImages = (preview.images && preview.images.length)
      ? preview.images
      : scanned.map((im) => ({ rank: im.rank, filename: im.filename }));
    const oldRankToName = new Map(oldImages.map((im) => [Number(im.rank), im.filename]));

    const newImages = order.map((fn, i) => ({ rank: i + 1, filename: fn }));
    const newNameToRank = new Map(newImages.map((im) => [im.filename, im.rank]));

    const remapStyleImages = (mapping) => {
      const out = {};
      for (const [key, raw] of Object.entries(mapping || {})) {
        const oldRank = Array.isArray(raw) ? Number(raw[0]) : Number(raw);
        const fn = oldRankToName.get(oldRank);
        const newRank = fn ? newNameToRank.get(fn) : undefined;
        if (Number.isFinite(newRank) && newRank > 0) out[key] = [newRank];
      }
      return out;
    };

    preview.images = newImages;
    preview.imageOrder = order;
    preview.styleImageMapping = remapStyleImages(preview.styleImageMapping);
    ai.styleImageMapping = preview.styleImageMapping;

    this._updateItem(jobId, item.product_folder, {
      preview_json: JSON.stringify(preview),
      ai_json: JSON.stringify(ai),
    });
    this._emit(jobId, { type: 'images', folder: item.product_folder, seq: item.seq, images: newImages });
    return { ok: true, images: newImages, styleImageMapping: preview.styleImageMapping };
  }

  /**
   * Soft-delete images out of a product folder by MOVING each named file into a
   * `_removed/` subfolder (created on demand). Non-destructive and recoverable;
   * scanProductFolder ignores subdirectories, so archived files disappear from
   * the plan/scan without being lost. Best-effort per file — a move that fails
   * leaves the file in place (harmless) and never breaks the surrounding save.
   *
   * @param {string} folder   product folder
   * @param {string[]} names  filenames (relative to folder) to archive
   */
  _archiveImages(folder, names) {
    if (!Array.isArray(names) || !names.length) return;
    const trash = path.join(folder, '_removed');
    for (const name of names) {
      const src = path.join(folder, name);
      try {
        if (!fs.existsSync(src)) continue;
        if (!fs.existsSync(trash)) fs.mkdirSync(trash, { recursive: true });
        let dest = path.join(trash, name);
        if (fs.existsSync(dest)) {
          const ext = path.extname(name);
          dest = path.join(trash, `${path.basename(name, ext)}-${Date.now()}${ext}`);
        }
        fs.renameSync(src, dest);
      } catch { /* best effort — leaving the original in place is harmless */ }
    }
  }

  /**
   * Import operator-uploaded photos into an item's product folder and append
   * them to the curated image plan. Same gate as updateItemImages: only valid on
   * a dry-run preview, before the Etsy draft is created — once a real listing
   * exists its photos live on Etsy and are managed there.
   *
   * Each upload is validated + decoded through sharp (rejects anything that is
   * not a real jpg/png/gif/webp — we never trust the client-declared type),
   * written to disk under a collision-free name, and appended AFTER the existing
   * kept photos. The re-rank + variation-photo remap + persistence + SSE emit are
   * delegated to updateItemImages so there is a single code path that mutates the
   * plan. Writing to disk (not just the DB) is essential: the real create re-scans
   * the folder, so an uploaded photo must physically exist there to be uploaded.
   *
   * @param {string} jobId
   * @param {number} seq
   * @param {Array<{data:Buffer, filename?:string}>} files
   * @returns {Promise<object>} updateItemImages result + { added:string[] }
   */
  async addItemImages(jobId, seq, files) {
    const job = this.getJob(jobId);
    if (!job) { const e = new Error('Job not found'); e.status = 404; throw e; }
    const item = this.getItemBySeq(jobId, seq);
    if (!item) { const e = new Error('Item not found'); e.status = 404; throw e; }
    if (job.dry_run !== 1 || item.listing_id) {
      const e = new Error('Photos can only be added on a dry-run preview, before the Etsy draft is created.');
      e.status = 400; throw e;
    }

    const incoming = Array.isArray(files)
      ? files.filter((f) => f && Buffer.isBuffer(f.data) && f.data.length)
      : [];
    if (!incoming.length) { const e = new Error('No image files supplied.'); e.status = 400; throw e; }

    const folder = item.product_folder;
    try {
      if (!fs.statSync(folder).isDirectory()) throw new Error('not a directory');
    } catch {
      const e = new Error('Product folder no longer exists on disk.'); e.status = 409; throw e;
    }

    // Every image file currently on disk — used only to pick a collision-free
    // name for the new files (it may include orphans left by a removal made
    // before the reconcile logic existed).
    let onDiskNames = [];
    try {
      onDiskNames = fs.readdirSync(folder).filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase()));
    } catch {
      try { onDiskNames = (scanProductFolder(folder).images || []).map((im) => im.filename); } catch { onDiskNames = []; }
    }

    // The 20-photo cap applies to the PLAN — the photos that actually upload to
    // Etsy — NOT to stray files on disk. Removed photos are archived out of the
    // folder by updateItemImages, but a listing edited before that logic existed
    // may still hold orphans, so we must count the plan (imageOrder), never the
    // raw directory. This is what lets "delete 2, then add 1" work as expected.
    let preview = {};
    try { preview = item.preview_json ? JSON.parse(item.preview_json) : {}; } catch { preview = {}; }
    const planNames = Array.isArray(preview.imageOrder) && preview.imageOrder.length
      ? preview.imageOrder
      : (Array.isArray(preview.images) && preview.images.length
          ? preview.images.slice().sort((a, b) => Number(a.rank) - Number(b.rank)).map((im) => im.filename)
          : onDiskNames);
    const room = MAX_IMAGES - planNames.length;
    if (room <= 0) {
      const e = new Error(`This product already has the maximum of ${MAX_IMAGES} photos. Remove one before adding more.`);
      e.status = 400; throw e;
    }
    if (incoming.length > room) {
      const e = new Error(`Only ${room} more photo${room === 1 ? '' : 's'} can be added (max ${MAX_IMAGES} per listing).`);
      e.status = 400; throw e;
    }

    // sharp's detected format → the on-disk extension we persist. Only raster
    // formats Etsy (and our scanner) accept are allowed through.
    const FORMAT_EXT = { jpeg: 'jpg', png: 'png', gif: 'gif', webp: 'webp' };
    const used = new Set(onDiskNames.map((n) => n.toLowerCase()));
    const written = [];
    let stamp = Date.now();
    try {
      for (const file of incoming) {
        // Confirm it is a real, decodable raster image and learn its TRUE format.
        // sharp is authoritative; the magic-byte sniff is a fallback if sharp is
        // unavailable for a given build/format.
        let fmt = '';
        try { fmt = String((await sharp(file.data).metadata()).format || '').toLowerCase(); } catch { fmt = ''; }
        let ext = FORMAT_EXT[fmt] || this._sniffImageExt(file.data);
        if (!ext) { const e = new Error('Unsupported image — upload a JPG, PNG, GIF or WebP.'); e.status = 400; throw e; }

        // Collision-free name. `upload-<timestamp>` keeps the first integer large
        // so natural-sort places new photos AFTER numbered originals (1.png, 2.png…)
        // — i.e. appended, matching the "add to the end" intent.
        let name;
        do { name = `upload-${stamp++}.${ext}`; }
        while (used.has(name.toLowerCase()) || fs.existsSync(path.join(folder, name)));
        used.add(name.toLowerCase());
        fs.writeFileSync(path.join(folder, name), file.data);
        written.push(name);
      }
    } catch (err) {
      // Roll back any files already written so a mid-batch failure leaves no
      // orphaned photos on disk.
      for (const n of written) { try { fs.unlinkSync(path.join(folder, n)); } catch { /* best effort */ } }
      throw err;
    }

    // Preserve the operator's current display order, then append the new photos.
    // (`preview` was already parsed above for the plan-count cap check.)
    const currentOrder = Array.isArray(preview.imageOrder) && preview.imageOrder.length
      ? preview.imageOrder.slice()
      : (Array.isArray(preview.images) && preview.images.length
          ? preview.images.slice().sort((a, b) => Number(a.rank) - Number(b.rank)).map((im) => im.filename)
          : onDiskNames.slice());
    const seen = new Set();
    const order = [];
    for (const fn of [...currentOrder, ...written]) {
      if (typeof fn === 'string' && !seen.has(fn)) { seen.add(fn); order.push(fn); }
    }

    const result = this.updateItemImages(jobId, seq, order);
    return { ...result, added: written };
  }

  /**
   * Fallback image sniffer by magic bytes, used only when sharp can't identify
   * the format. Returns a scanner-accepted extension or ''.
   */
  _sniffImageExt(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return '';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
    return '';
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
   * The listing's advertised "from" price. Custom variation values are offered
   * ALONGSIDE the canonical bundles, so the minimum is the lowest of the enabled
   * canonical prices AND the custom prices. Shared by every path that rewrites
   * the matrix, so they can't drift apart.
   */
  _effectiveMinPrice(preview) {
    const canonMin = this._recomputeMinPrice(preview);
    const custom = Array.isArray(preview.customStyles) ? preview.customStyles : [];
    const customPrices = custom.map((s) => Number(s.price)).filter((n) => Number.isFinite(n) && n > 0);
    if (!customPrices.length) return canonMin;
    const min = Math.min(canonMin, ...customPrices);
    return Number.isFinite(min) ? min : canonMin;
  }

  /**
   * Apply edited per-style prices to one item. Persists to the preview and, for
   * an already-created (real) listing, re-pushes the variation inventory so the
   * Etsy draft/listing reflects the new prices immediately.
   */
  async updateItemPrices(jobId, seq, stylePrices) {
    const job = this.getJob(jobId);
    if (!job) { const e = new Error('Job not found'); e.status = 404; throw e; }
    const productType = jobProductType(job);
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
        customStyles: preview.customStyles || ai.customStyles || undefined,
        variationOrder: preview.variationOrder || ai.variationOrder || undefined,
        readinessStateId: (preview.settings && preview.settings.readiness_state_id) || null,
        productType,
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
  async updateItemVariations(jobId, seq, { enabledStyles, stylePrices, styleImageMapping, enabledModels, customStyles, variationOrder } = {}) {
    const job = this.getJob(jobId);
    if (!job) { const e = new Error('Job not found'); e.status = 404; throw e; }
    const productType = jobProductType(job);
    const item = this.getItemBySeq(jobId, seq);
    if (!item) { const e = new Error('Item not found'); e.status = 404; throw e; }

    let preview = {};
    try { preview = item.preview_json ? JSON.parse(item.preview_json) : {}; } catch { preview = {}; }
    let ai = {};
    try { ai = item.ai_json ? JSON.parse(item.ai_json) : {}; } catch { ai = {}; }

    // Custom variation values (e.g. "Case1 + Charm1") are ADDED on top of the
    // bundles. An explicitly empty array clears them; `undefined` = no change.
    let aiCustomDirty = false;
    if (customStyles !== undefined) {
      const cleanCustom = normaliseCustomStyles(customStyles);
      preview.customStyles = cleanCustom.length ? cleanCustom : null;
      ai.customStyles = preview.customStyles;
      aiCustomDirty = true;
    }
    // The operator's chosen display order for the "Styles" options (an array of
    // value labels). Controls the buyer-facing dropdown order on Etsy.
    if (variationOrder !== undefined) {
      preview.variationOrder = Array.isArray(variationOrder) && variationOrder.length ? variationOrder.map(String) : null;
      ai.variationOrder = preview.variationOrder;
      aiCustomDirty = true;
    }
    const activeCustom = Array.isArray(preview.customStyles) ? preview.customStyles : null;

    if (enabledStyles && typeof enabledStyles === 'object') {
      preview.enabledStyles = normaliseEnabledStyles(enabledStyles);
    } else if (!preview.enabledStyles || !Object.keys(preview.enabledStyles).length) {
      preview.enabledStyles = computeEnabledStyles(preview.imageAnalysis || ai.imageAnalysis || []);
    }
    // Invariant (defence-in-depth): a listing must always offer at least one
    // VISIBLE variation. The operator may disable every canonical bundle —
    // including "Case Only" — but ONLY while a custom value carries the listing.
    // If a request somehow disables all bundles with no custom value (e.g. the UI
    // guard was bypassed), re-enable "Case Only" so we never persist an empty
    // matrix. This mirrors buildInventory()'s custom-aware fallback and replaces
    // the old unconditional force that resurrected "Case Only" for valid
    // custom-only listings.
    const hasActiveCustom = Array.isArray(activeCustom) && activeCustom.length > 0;
    if (!hasActiveCustom && !STYLE_ORDER.some((k) => preview.enabledStyles[k])) {
      preview.enabledStyles['Case Only'] = true;
    }
    let aiModelsDirty = false;
    if (enabledModels && typeof enabledModels === 'object') {
      preview.enabledModels = normaliseEnabledModels(enabledModels, productType);
      ai.enabledModels = preview.enabledModels; // honoured by the real create
      aiModelsDirty = true;
      // Keep the description's "Device Compatibility" AND the title's device range
      // consistent with the offered models (cheap, no AI re-run).
      if (preview.description) preview.description = filterModelsInDescription(preview.description, preview.enabledModels, productType);
      if (ai.description) ai.description = filterModelsInDescription(ai.description, preview.enabledModels, productType);
      if (preview.title) preview.title = retitleForModels(preview.title, preview.enabledModels, productType);
      if (ai.title) ai.title = retitleForModels(ai.title, preview.enabledModels, productType);
    } else if (!preview.enabledModels || !Object.keys(preview.enabledModels).length) {
      preview.enabledModels = normaliseEnabledModels(ai.enabledModels, productType);
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
    preview.minPrice = this._effectiveMinPrice(preview);
    this._updateItem(jobId, item.product_folder, {
      preview_json: JSON.stringify(preview),
      ...(aiDirty || aiModelsDirty || aiCustomDirty ? { ai_json: JSON.stringify(ai) } : {}),
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
        customStyles: preview.customStyles || undefined,
        variationOrder: preview.variationOrder || undefined,
        readinessStateId: (preview.settings && preview.settings.readiness_state_id) || null,
        productType,
      });
      pushed = true;
    }
    const enabledCount = activeCustom ? activeCustom.length : STYLE_ORDER.filter((k) => preview.enabledStyles[k]).length;
    this._emit(jobId, { type: 'prices', folder: item.product_folder, seq: item.seq, stylePrices: preview.stylePrices, minPrice: preview.minPrice, enabledStyles: preview.enabledStyles, enabledModels: preview.enabledModels, customStyles: preview.customStyles || null, variationOrder: preview.variationOrder || null, title: aiModelsDirty ? preview.title : undefined, pushed });
    return { ok: true, pushed, enabledStyles: preview.enabledStyles, enabledModels: preview.enabledModels, customStyles: preview.customStyles || null, variationOrder: preview.variationOrder || null, stylePrices: preview.stylePrices, minPrice: preview.minPrice, enabledCount, styleImageMapping: preview.styleImageMapping || {}, title: preview.title, description: preview.description };
  }

  /**
   * Apply one price set to EVERY item in the job (background + SSE). Re-pushes
   * any already-created listings sequentially (rate budget).
   */
  updateAllPrices(jobId, stylePrices) {
    const job = this.getJob(jobId);
    if (!job) { const e = new Error('Job not found'); e.status = 404; throw e; }
    const productType = jobProductType(job);
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
              customStyles: preview.customStyles || ai.customStyles || undefined,
              variationOrder: preview.variationOrder || ai.variationOrder || undefined,
              readinessStateId: (preview.settings && preview.settings.readiness_state_id) || null,
              productType,
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
    const productType = jobProductType(job);
    const models = normaliseEnabledModels(enabledModels, productType);
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
          if (preview.description) preview.description = filterModelsInDescription(preview.description, models, productType);
          if (ai.description) ai.description = filterModelsInDescription(ai.description, models, productType);
          if (preview.title) preview.title = retitleForModels(preview.title, models, productType);
          if (ai.title) ai.title = retitleForModels(ai.title, models, productType);

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
              customStyles: preview.customStyles || ai.customStyles || undefined,
              variationOrder: preview.variationOrder || ai.variationOrder || undefined,
              readinessStateId: (preview.settings && preview.settings.readiness_state_id) || null,
              productType,
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
  async _runRegenerateItemCopy(jobId, item, job, { characterName, magsafe, enabledModels, enabledStyles, styleImageMapping, customStyles, variationOrder } = {}) {
    this._emit(jobId, { type: 'regen_start', folder: item.product_folder, seq: item.seq });
    const productType = jobProductType(job);
    const folder = item.product_folder;
    // Revision of the row we're about to snapshot. Generating copy takes seconds;
    // if the operator's variation autosave lands in that window this moves, and
    // their newer intent wins the merge below.
    const revAtStart = this._itemRev(jobId, folder);

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
      productType,
    );
    // Operator's corrected style matrix drives the "What's Included" bundles +
    // grip/charm copy. Explicit override wins, else the saved preview selection.
    const stylesForCopy = (enabledStyles && typeof enabledStyles === 'object' && Object.keys(enabledStyles).length)
      ? enabledStyles
      : (preview.enabledStyles || ai.enabledStyles || null);
    // Operator-defined CUSTOM variation values ("Case 1 + Charm 1", …). "Apply &
    // regenerate copy" commits the whole editor, so a list in the request IS what
    // was on screen and wins over the persisted one — both for the copy the AI
    // writes and for what we store below. Absent (older client / other caller) =
    // no opinion, keep whatever is saved.
    const explicitCustom = customStyles !== undefined ? normaliseCustomStyles(customStyles) : null;
    const customForCopy = explicitCustom
      || (Array.isArray(preview.customStyles) ? preview.customStyles : (Array.isArray(ai.customStyles) ? ai.customStyles : null));

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
      styleImageMapping: savedStyleImages, attributeMenu, productType,
      customStyles: customForCopy && customForCopy.length ? customForCopy : null,
    });
    // Persist the (possibly overridden) image analysis so the corrected MagSafe
    // state sticks for future regenerations and the real create.
    copy.imageAnalysis = imageAnalysis;

    // ── Merge onto the CURRENT row, never the snapshot we started from ────────
    // `preview_json` is a single blob shared with the inspector's variation
    // autosave. Writing back the object parsed before the (multi-second) AI call
    // would silently delete anything saved in between — that is exactly how a
    // custom variation vanished moments after "Apply & regenerate copy". Re-read
    // here and overwrite only the fields this regeneration genuinely owns.
    const fresh = this.getItemBySeq(jobId, item.seq) || item;
    const racedWithSave = this._itemRev(jobId, folder) !== revAtStart;
    let next = {};
    try { next = fresh.preview_json ? JSON.parse(fresh.preview_json) : {}; } catch { next = {}; }
    let freshAi = {};
    try { freshAi = fresh.ai_json ? JSON.parse(fresh.ai_json) : {}; } catch { freshAi = {}; }

    // Copy-owned fields — the regeneration is authoritative for every one of these.
    next.title = copy.title;
    next.description = copy.description;
    next.tags = copy.tags || [];
    next.primaryColor = copy.primaryColor || next.primaryColor;
    next.secondaryColor = copy.secondaryColor || next.secondaryColor;
    next.character = copy.characterName || '';
    next.characterDetected = copy.characterDetected || '';
    next.characterFranchise = copy.characterFranchise || '';
    next.characterConfidence = copy.characterConfidence;
    next.characterEvidence = copy.characterEvidence || '';
    next.characterAlternatives = copy.characterAlternatives || [];
    next.characterLowConfidence = copy.characterLowConfidence || false;
    next.aiAttributes = copy.aiAttributes || next.aiAttributes || null;
    // The MagSafe override mutates `imageAnalysis` in place. That array came from
    // the snapshot, so mirror the corrected flag onto the freshly-read preview's
    // own copy — otherwise the toggle would spring back on the next render.
    if (typeof magsafe === 'boolean' && Array.isArray(next.imageAnalysis)) {
      for (const img of next.imageAnalysis) img.has_magsafe_ring = magsafe;
    }

    // Matrix fields — the request describes what the operator saw when they
    // pressed the button, so it wins, UNLESS a save landed while we generated.
    // That save is the newer intent, so we leave the freshly-read matrix alone.
    if (!racedWithSave) {
      if (explicitCustom) next.customStyles = explicitCustom.length ? explicitCustom : null;
      if (variationOrder !== undefined) {
        next.variationOrder = Array.isArray(variationOrder) && variationOrder.length ? variationOrder.map(String) : null;
      }
      if (explicitImages) next.styleImageMapping = this._sanitizeStyleImageMapping(explicitImages, next);
      else next.styleImageMapping = copy.styleImageMapping || next.styleImageMapping || {};
      next.enabledModels = copy.enabledModels || modelsForCopy || next.enabledModels;
      // Persist the EXACT style selection behind the button (parity with
      // enabledModels above), so the stored matrix is a single source of truth
      // independent of autosave timing. Same "never persist an empty matrix"
      // invariant as updateItemVariations: a canonical fallback is re-enabled
      // ONLY when no bundle and no custom value carries the listing — checked
      // against the customs we just resolved, not a stale snapshot.
      if (enabledStyles && typeof enabledStyles === 'object' && Object.keys(enabledStyles).length) {
        const normStyles = normaliseEnabledStyles(enabledStyles);
        const custom = Array.isArray(next.customStyles) ? next.customStyles : null;
        if (!(custom && custom.length) && !STYLE_ORDER.some((k) => normStyles[k])) normStyles['Case Only'] = true;
        next.enabledStyles = normStyles;
      }
    } else {
      // A newer save owns the matrix. Re-fit the generated text to it so the
      // title's device range and the "Device Compatibility" list can't advertise
      // models the listing no longer offers.
      const finalModels = normaliseEnabledModels(next.enabledModels, productType);
      if (next.title) next.title = retitleForModels(next.title, finalModels, productType);
      if (next.description) next.description = filterModelsInDescription(next.description, finalModels, productType);
    }
    next.minPrice = this._effectiveMinPrice(next);

    // Cached AI copy: layer the regenerated copy over the CURRENT cached object
    // (so a concurrent save's mirrors survive), then re-assert the matrix mirrors
    // — `copy` knows nothing about custom values or the operator's order.
    const newAi = { ...freshAi, ...copy };
    newAi.title = next.title;
    newAi.description = next.description;
    newAi.styleImageMapping = next.styleImageMapping;
    newAi.enabledModels = next.enabledModels;
    newAi.customStyles = next.customStyles || null;
    newAi.variationOrder = next.variationOrder || null;

    this._updateItem(jobId, folder, {
      ai_json: JSON.stringify(newAi), title: next.title, preview_json: JSON.stringify(next),
    });

    let pushed = false;
    if (job.dry_run !== 1 && item.listing_id) {
      const { shopClient, numericShopId } = await this.resolveShopClient(job.shop_name);
      await updateListing(shopClient, numericShopId, item.listing_id, {
        title: next.title, description: next.description, tags: next.tags || [],
      });
      pushed = true;
    }
    this._emit(jobId, { type: 'item', folder, seq: item.seq, status: item.status, title: next.title });
    this._emit(jobId, {
      type: 'regen_done', folder, seq: item.seq,
      title: next.title, character: copy.characterName, characterConfidence: copy.characterConfidence, pushed,
      enabledStyles: next.enabledStyles, enabledModels: next.enabledModels,
      customStyles: next.customStyles || null, variationOrder: next.variationOrder || null,
    });
    return { ok: true, pushed, title: next.title, character: copy.characterName, characterConfidence: copy.characterConfidence };
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
    const key = this._itemRevKey(jobId, folder);
    this._itemRevs.set(key, (this._itemRevs.get(key) || 0) + 1);
  }

  // ── Item write revision (optimistic-concurrency token) ──────────────────────
  // `preview_json` is ONE blob rewritten by several independent paths: the
  // inspector's variation autosave, price edits, and the background copy
  // regeneration. Every write bumps this counter, so a slow writer that read the
  // blob before an `await` can tell whether someone else has written since — and
  // merge instead of clobbering. `updated_at` can't serve here: it has one-second
  // granularity, and these writes land milliseconds apart.
  _itemRevKey(jobId, folder) { return `${jobId}\u0000${folder}`; }
  _itemRev(jobId, folder) { return this._itemRevs.get(this._itemRevKey(jobId, folder)) || 0; }

  /**
   * Create a job + item rows and kick off processing (async, non-blocking).
   * @returns {object} the created job row
   */
  createAndStart({ shopName, inputPath, targetState = 'draft', dryRun = false, overrides = {}, brandTags, stylePrices, productType }) {
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
        productType: productType || 'iphone_case',
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
      if (item.excluded === 1) continue; // operator opted this product out of Etsy creation
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
      // Per-style price edits made on the preview MUST carry into the real draft —
      // the run loop layers ai.stylePrices over the job-level defaults so the Etsy
      // inventory is created with exactly the prices the operator approved.
      if (preview.stylePrices && Object.keys(preview.stylePrices).length) ai.stylePrices = this._sanitizePrices(preview.stylePrices);
      if (preview.styleImageMapping) ai.styleImageMapping = preview.styleImageMapping;
      // Honour the operator's EXACT custom-variation state — including an explicit
      // clear (null) — so promoting never resurrects custom values they removed.
      if (preview.customStyles !== undefined) ai.customStyles = preview.customStyles; // operator-defined variation values
      if (preview.variationOrder !== undefined) ai.variationOrder = preview.variationOrder; // operator's variation display order
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
    if (!prepared) { const e = new Error('No products to create — all are excluded, or copy has not been generated yet.'); e.status = 400; throw e; }

    // Flip to a real run targeting DRAFT, reset counters, and launch. `total`
    // reflects the products we're actually creating (excluded ones are skipped)
    // so progress reads 100% when the kept subset finishes.
    this._updateJob(jobId, { dry_run: 0, target_state: 'draft', state: 'queued', completed: 0, failed: 0, total: prepared, finished_at: null, error: null });

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
      // A real (non-dry) run WRITES to Etsy, so resolve settings fresh from the
      // shop first: this picks up sections/profiles created AFTER the dry run
      // was saved (e.g. an "AirPods Cases" section added just before publish).
      // Dry runs may use the 6h cache — they only preview, never write.
      const settings = await getShopListingSettings({
        db: this.db, shopClient, shopId: numericShopId, shopKey: job.shop_key, productType: jobProductType(job),
        force: job.dry_run !== 1,
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

      // Reconcile the storefront section against the shop's CURRENT sections.
      // The section is chosen once (often at dry-run time) and then baked into
      // the run's stored overrides — but the shop's sections can change before
      // publish. This honours a deliberate choice while self-correcting a stale
      // id or one that belongs to another product type (e.g. an AirPods run
      // whose section defaulted to "iPhone Cases"), and adopts a matching
      // section created after the dry run. Only matters for real writes.
      if (job.dry_run !== 1) {
        try {
          const priorSection = defaults.shop_section_id ?? null;
          const resolvedSection = reconcileShopSection(priorSection, settings.shop_sections, getProductType(jobProductType(job)));
          if ((resolvedSection ?? null) !== priorSection) {
            defaults.shop_section_id = resolvedSection;
            const titleOf = (id) => (settings.shop_sections || []).find((s) => Number(s.shop_section_id) === Number(id));
            const to = resolvedSection ? `"${(titleOf(resolvedSection) || {}).title || resolvedSection}"` : 'none';
            const from = priorSection ? `"${(titleOf(priorSection) || {}).title || priorSection}"` : 'none';
            this._emit(jobId, { type: 'info', message: `Shop section auto-corrected for this ${jobProductType(job)} run: ${from} → ${to}.` });
          }
        } catch { /* keep the merged default if section resolution fails */ }
      }

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
      const productType = jobProductType(job);

      // Build the work list. Operator-excluded products are never created.
      let items = this.getItems(jobId);
      items = items.filter((it) => it.excluded !== 1);
      if (onlyUnfinished) items = items.filter((it) => it.status !== 'done');

      // Re-scan folders so we have image/video paths (not persisted in DB).
      const { products } = scanInputRoot(job.input_path);
      const byFolder = new Map(products.map((p) => [p.folder, p]));

      const concurrency = Math.max(1, config.bulk.concurrency);
      let completed = job.completed || 0;
      let failed = 0;

      const processItem = async (item) => {
        let product = byFolder.get(item.product_folder);
        if (!product) {
          this._updateItem(jobId, item.product_folder, { status: 'failed', error: 'Folder no longer found' });
          failed++;
          return;
        }
        // Honour the operator's curated image plan (reorder / removals) captured
        // in the Inspector during the dry run, so the real create uploads exactly
        // the photos they approved, in the approved order.
        try {
          const itemPreview = item.preview_json ? JSON.parse(item.preview_json) : null;
          product = applyImagePlan(product, itemPreview);
        } catch { /* fall back to natural scan order */ }
        try {
          this._emit(jobId, { type: 'item', folder: item.product_folder, name: item.product_name, status: 'running' });

          // 1) AI copy (cached in ai_json for resume).
          let copy;
          if (item.ai_json) {
            copy = JSON.parse(item.ai_json);
            this._emit(jobId, { type: 'step', folder: item.product_folder, step: 'ai_cached' });
          } else {
            this._emit(jobId, { type: 'step', folder: item.product_folder, step: 'ai', images: product.images.length });
            copy = await generateListingCopy(product, { shopName: job.shop_name, brandTags, attributeMenu, productType });
            this._updateItem(jobId, item.product_folder, {
              status: 'ai_done', ai_json: JSON.stringify(copy), title: copy.title,
            });
            this._emit(jobId, { type: 'item', folder: item.product_folder, status: 'ai_done', title: copy.title });
          }

          // 2) Create / resume on Etsy. Parse defensively (like every other
          // JSON.parse in this file): a corrupt checkpoint should start the item
          // from a clean slate, not throw and fail an otherwise-resumable item.
          let checkpoint = {};
          try { checkpoint = item.checkpoint_json ? JSON.parse(item.checkpoint_json) : {}; } catch { checkpoint = {}; }
          // Per-item price overrides captured in the Inspector during the dry-run
          // preview take precedence over the job-level defaults; any style the
          // operator didn't touch falls back to the job price. Without this, price
          // edits made on the preview were silently dropped when the run created
          // the real Etsy draft (the create used only the job-level prices).
          const priceOverrides = this._sanitizePrices(copy.stylePrices || {});
          const itemPrices = Object.keys(priceOverrides).length
            ? { ...priceInfo.prices, ...priceOverrides }
            : priceInfo.prices;
          const result = await createListingForProduct({
            shopClient,
            shopId: numericShopId,
            product,
            copy,
            prices: itemPrices,
            settings: mergedSettings,
            productType,
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
          if (!it) continue;
          // Defence-in-depth: processItem already catches its own errors, but an
          // UNEXPECTED throw — e.g. a transient SQLite lock (this DB can live on a
          // OneDrive-synced path) hitting the DB write in processItem's finally —
          // would otherwise reject Promise.all, abort the whole run, and strand
          // every remaining product as 'pending' with the job stuck in 'error'.
          // Contain the failure to THIS product and keep the pipeline moving so
          // the run still settles cleanly and the operator gets per-item Retry.
          try {
            await processItem(it);
          } catch (err) {
            failed++;
            const msg = (err && (err.response?.data?.error || err.message)) || 'Unexpected error';
            try { this._updateItem(jobId, it.product_folder, { status: 'failed', error: msg }); } catch { /* best effort */ }
            try { this._updateJob(jobId, { completed, failed }); } catch { /* best effort */ }
            this._emit(jobId, { type: 'item', folder: it.product_folder, status: 'failed', error: msg });
          }
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
