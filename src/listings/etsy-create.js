'use strict';

/**
 * Per-product Etsy creation orchestrator for the Bulk Listing Creator.
 *
 * Sequence (each step is checkpointed so a retry resumes instead of restarting):
 *   1. createDraftListingForm     → listing_id
 *   2. uploadListingImage × ranks → rank → image_id
 *   3. uploadListingVideo         → (optional)
 *   4. putListingInventory        → 12 × 6 variation matrix
 *   5. getListingInventory        → resolve Styles value_ids
 *   6. updateVariationImages      → link styles to images (best-effort)
 *   7. (optional) updateListing state=active when publishing
 *
 * dryRun mode builds and returns the create + inventory payloads without any
 * Etsy write calls — used to preview a run.
 */

const fs = require('fs');
const {
  createDraftListingForm,
  findMatchingDraftListing,
  uploadListingImage,
  uploadListingVideo,
  getListingVideos,
  putListingInventory,
  getListingInventory,
  updateVariationImages,
  updateListing,
  updateListingProperty,
} = require('../etsy/client');
const { buildInventory, buildVariationImages, buildCustomVariationImages, normaliseCustomStyles } = require('./variation-builder');
const { getTaxonomyAttributes, resolveAttributes } = require('./attributes');
const productTypes = require('./product-types');

/** Dedupe a list of variation-image links by their Etsy value_id (first wins). */
function dedupeByValueId(list) {
  const seen = new Set();
  const out = [];
  for (const v of list) {
    if (!v || v.value_id == null || seen.has(v.value_id)) continue;
    seen.add(v.value_id);
    out.push(v);
  }
  return out;
}

/**
 * Map each priced-axis value label to the value_id Etsy assigned it, read back
 * from getListingInventory after the inventory PUT. Etsy re-issues these ids on
 * every PUT, so variation images must always be linked from a fresh read.
 */
function readStyleValueIds(inventory, productType) {
  const propId = productTypes.stylePropertyFor(productType).id;
  const map = new Map();
  for (const p of inventory.products || []) {
    for (const pv of p.property_values || []) {
      if (pv.property_id === propId && (pv.values || []).length && (pv.value_ids || []).length) {
        map.set(pv.values[0], pv.value_ids[0]);
      }
    }
  }
  return map;
}

/** Build the createDraftListing request body from copy + resolved settings. */
function buildCreateBody({ copy, settings, minPrice, listingQuantity, productType }) {
  const d = settings.defaults || settings;
  const pt = productTypes.getProductType(productType);
  const body = {
    quantity: listingQuantity || 3,
    title: copy.title,
    description: copy.description,
    price: Number(minPrice.toFixed(2)),
    who_made: d.who_made || 'someone_else',
    when_made: d.when_made || 'made_to_order',
    taxonomy_id: d.taxonomy_id,
    type: 'physical',
    is_supply: d.is_supply === true,
    should_auto_renew: true,
    is_taxable: true,
    materials: pt.materials || ['Silicone'],
    tags: copy.tags || [],
  };
  if (d.shipping_profile_id) body.shipping_profile_id = d.shipping_profile_id;
  // Etsy requires a processing profile (readiness_state_id) on every physical listing.
  if (d.readiness_state_id != null) body.readiness_state_id = d.readiness_state_id;
  if (d.return_policy_id) body.return_policy_id = d.return_policy_id;
  if (d.shop_section_id) body.shop_section_id = d.shop_section_id;
  if (Array.isArray(d.production_partner_ids) && d.production_partner_ids.length) {
    body.production_partner_ids = d.production_partner_ids;
  }
  if (d.processing_min) body.processing_min = d.processing_min;
  if (d.processing_max) body.processing_max = d.processing_max;
  return body;
}

/**
 * Create (or resume creating) a single listing for one scanned product.
 *
 * @param {object} ctx
 * @param {import('axios').AxiosInstance} ctx.shopClient
 * @param {string|number} ctx.shopId            numeric shop ID
 * @param {object} ctx.product                  scanner result
 * @param {object} ctx.copy                     ai-generator result
 * @param {Record<string,number>} ctx.prices    style key → price
 * @param {object} ctx.settings                 shop settings ({ defaults })
 * @param {object} [ctx.options]
 * @param {'draft'|'published'} [ctx.options.state='draft']
 * @param {number} [ctx.options.restockQuantity=3]
 * @param {boolean} [ctx.options.dryRun=false]
 * @param {object} [ctx.checkpoint]             persisted partial progress
 * @param {(step:string,data:object)=>void} [ctx.onStep]
 * @returns {Promise<object>} result with listing_id, url, checkpoint, preview...
 */
async function createListingForProduct(ctx) {
  const {
    shopClient, shopId, product, copy, prices, settings,
    options = {}, onStep = () => {},
  } = ctx;
  const checkpoint = ctx.checkpoint || {};
  const state = options.state === 'published' ? 'published' : 'draft';
  const restockQuantity = options.restockQuantity ?? 3;

  const readinessStateId = (settings.defaults || settings).readiness_state_id ?? null;
  // The product type parameterises the device-model dimension, allowed styles
  // and materials. Prefer the explicit ctx value, then the cached copy's type.
  const productType = ctx.productType || copy.productType || null;
  // Operator-defined custom variation values (e.g. "Case1 + Charm1") fully
  // replace the canonical bundle matrix for this listing when present.
  const customStyles = normaliseCustomStyles(copy.customStyles);
  const { body: inventoryBody, minPrice, listingQuantity, enabledStyles } = buildInventory({
    prices,
    imageAnalysis: copy.imageAnalysis,
    // Prefer the dedicated accessory pass's verdict when present (more accurate
    // than the noisy per-image flags); otherwise derive from imageAnalysis.
    enabledStyles: copy.enabledStyles,
    // Which device models to offer (default all when not specified).
    enabledModels: copy.enabledModels,
    customStyles,
    // Operator's chosen display order for the "Styles" options (labels).
    variationOrder: copy.variationOrder,
    productType,
    restockQuantity,
    readinessStateId,
  });
  const createBody = buildCreateBody({ copy, settings, minPrice, listingQuantity, productType });

  // A self-contained inspection payload, persisted with the item so the UI can
  // render image order, copy, the full variation matrix and the resolved shop
  // settings later with zero recomputation or extra Etsy calls.
  const d = settings.defaults || settings;
  const preview = {
    title: copy.title,
    description: copy.description,
    tags: copy.tags || [],
    primaryColor: copy.primaryColor || '',
    secondaryColor: copy.secondaryColor || '',
    // Character identification (for the Inspector + human-in-the-loop correction)
    character: copy.characterName || '',
    characterDetected: copy.characterDetected || '',
    characterFranchise: copy.characterFranchise || '',
    characterConfidence: copy.characterConfidence,
    characterEvidence: copy.characterEvidence || '',
    characterAlternatives: copy.characterAlternatives || [],
    characterLowConfidence: copy.characterLowConfidence || false,
    // Design fingerprint + the title's quality score, so the Inspector can show
    // the operator WHY the copy says what it says and flag weak titles for review.
    designAnalysis: copy.designAnalysis || null,
    titleQuality: copy.titleQuality || null,
    accessory: copy.accessory || null,
    aiAttributes: copy.aiAttributes || null,
    currency: options.currency || '',
    minPrice,
    listingQuantity,
    restockQuantity,
    enabledStyles,
    enabledModels: copy.enabledModels || null,
    customStyles: customStyles.length ? customStyles : null,
    productType: productType || copy.productType || null,
    stylePrices: prices,
    inventoryProducts: inventoryBody.products.length,
    images: (product.images || []).map((im) => ({ rank: im.rank, filename: im.filename })),
    hasVideo: product.hasVideo,
    videoFilename: product.video ? product.video.filename : null,
    styleImageMapping: copy.styleImageMapping || {},
    imageAnalysis: copy.imageAnalysis || [],
    settings: {
      taxonomy_id: d.taxonomy_id || null,
      shipping_profile_id: d.shipping_profile_id || null,
      return_policy_id: d.return_policy_id || null,
      production_partner_ids: d.production_partner_ids || [],
      shop_section_id: d.shop_section_id || null,
      readiness_state_id: d.readiness_state_id ?? null,
      who_made: createBody.who_made,
      when_made: createBody.when_made,
      materials: createBody.materials || [],
    },
  };

  // ── Dry run: return the payloads without touching Etsy ─────────────────────
  if (options.dryRun) {
    return {
      dryRun: true,
      product: product.name,
      createBody,
      inventoryProducts: inventoryBody.products.length,
      enabledStyles,
      minPrice,
      imageCount: product.images.length,
      hasVideo: product.hasVideo,
      preview,
    };
  }

  // ── 1. Create draft listing ────────────────────────────────────────────────
  let listingId = checkpoint.listing_id || null;
  if (!listingId) {
    const acceptListing = (listing) =>
      typeof ctx.isListingClaimed !== 'function'
      || !ctx.isListingClaimed(listing?.listing_id);
    // Persist intent BEFORE the non-idempotent POST. If the process dies after
    // Etsy commits but before the response/checkpoint arrives, the next resume
    // can adopt the exact recent draft instead of creating another one.
    if (!checkpoint.create_attempted_at) {
      checkpoint.create_attempted_at = Math.floor(Date.now() / 1000);
      onStep('create_start', { created_after: checkpoint.create_attempted_at });
    } else {
      const existing = await findMatchingDraftListing(shopClient, shopId, createBody, {
        createdAfter: checkpoint.create_attempted_at,
        acceptListing,
      });
      if (existing?.listing_id) {
        listingId = existing.listing_id;
      }
    }

    const created = listingId
      ? { listing_id: listingId }
      : await createDraftListingForm(shopClient, shopId, createBody, {
          createdAfter: checkpoint.create_attempted_at,
          acceptListing,
        });
    listingId = created.listing_id;
    checkpoint.listing_id = listingId;
    delete checkpoint.create_attempted_at;
    onStep('created', { listing_id: listingId });
  }

  // ── 2. Upload images (skip ranks already uploaded) ─────────────────────────
  const uploadedRanks = new Map(Object.entries(checkpoint.rank_to_image_id || {}).map(([k, v]) => [Number(k), v]));
  const totalImages = product.images.length;
  for (const img of product.images) {
    if (uploadedRanks.has(img.rank)) continue;
    const buffer = fs.readFileSync(img.path);
    const res = await uploadListingImage(shopClient, shopId, listingId, {
      buffer,
      filename: img.filename,
      rank: img.rank,
      altText: copy.title ? copy.title.slice(0, 250) : undefined,
      // Rank is the idempotency key for a new draft's gallery. A transport retry
      // replaces that rank rather than appending a duplicate image.
      overwrite: true,
    });
    if (res && res.listing_image_id) {
      uploadedRanks.set(img.rank, res.listing_image_id);
      checkpoint.rank_to_image_id = Object.fromEntries(uploadedRanks);
      onStep('image', { rank: img.rank, image_id: res.listing_image_id, done: uploadedRanks.size, total: totalImages });
    }
  }

  // ── 3. Upload video (optional, best-effort) ────────────────────────────────
  if (product.video && !checkpoint.video_done) {
    try {
      let baselineVideoIds = Array.isArray(checkpoint.video_baseline_ids)
        ? checkpoint.video_baseline_ids.map(String)
        : null;
      if (checkpoint.video_attempted) {
        const existingVideos = await getListingVideos(shopClient, listingId);
        const baseline = new Set(baselineVideoIds || []);
        if ((existingVideos.results || []).some((video) =>
          video.video_state !== 'deleted'
          && !baseline.has(String(video.video_id ?? ''))
        )) {
          checkpoint.video_done = true;
          delete checkpoint.video_attempted;
          delete checkpoint.video_baseline_ids;
          onStep('video', { ok: true, reconciled: true });
        }
      }
      if (checkpoint.video_done) {
        // Reconciled a prior ambiguous upload; do not send the binary again.
      } else {
        if (!checkpoint.video_attempted) {
          const before = await getListingVideos(shopClient, listingId);
          baselineVideoIds = (before.results || [])
            .map((video) => String(video.video_id ?? ''))
            .filter(Boolean);
          checkpoint.video_baseline_ids = baselineVideoIds;
          checkpoint.video_attempted = true;
        }
        onStep('video_start', {});
        onStep('video_checkpoint', {});
        const buffer = fs.readFileSync(product.video.path);
        await uploadListingVideo(shopClient, shopId, listingId, {
          buffer,
          filename: product.video.filename,
          baselineVideoIds: baselineVideoIds || [],
        });
        checkpoint.video_done = true;
        delete checkpoint.video_attempted;
        delete checkpoint.video_baseline_ids;
        onStep('video', { ok: true });
      }
    } catch (err) {
      onStep('video_warning', { error: err.response?.data?.error || err.message });
    }
  }

  // ── 4. Set the variation inventory ─────────────────────────────────────────
  if (!checkpoint.inventory_done) {
    onStep('inventory_start', { products: inventoryBody.products.length });
    await putListingInventory(shopClient, listingId, inventoryBody);
    checkpoint.inventory_done = true;
    onStep('inventory', { products: inventoryBody.products.length });
  }

  // ── 4.5. Set listing attributes / "feature section" (best-effort) ──────────
  // Colours, Built-in grip, Theme, Occasion, Celebration, Pattern, etc. These
  // are taxonomy properties that materially improve search placement.
  if (!checkpoint.attributes_done) {
    try {
      const taxonomyId = (settings.defaults || settings).taxonomy_id;
      const { properties } = await getTaxonomyAttributes(shopClient, taxonomyId);
      const facts = {
        primaryColor: copy.primaryColor || '',
        secondaryColor: copy.secondaryColor || '',
        hasGrip: copy.accessory ? copy.accessory.hasGrip : undefined,
      };
      const updates = resolveAttributes({ properties, facts, ai: copy.aiAttributes || {} });
      let setCount = 0;
      for (const u of updates) {
        try {
          const body = { value_ids: u.value_ids };
          if (u.values && u.values.length) body.values = u.values;
          if (u.scale_id) body.scale_id = u.scale_id;
          await updateListingProperty(shopClient, shopId, listingId, u.property_id, body);
          setCount++;
        } catch (e) {
          onStep('attribute_warning', { property: u.property_name, error: e.response?.data?.error || e.message });
        }
      }
      checkpoint.attributes_done = true;
      onStep('attributes', { set: setCount, total: updates.length });
    } catch (err) {
      onStep('attributes_warning', { error: err.response?.data?.error || err.message });
    }
  }

  // ── 5+6. Link variation images (best-effort — non-fatal) ───────────────────
  if (!checkpoint.variation_images_done) {
    try {
      onStep('variation_images_start', {});
      const inv = await getListingInventory(shopClient, listingId);
      const styleLabelToValueId = readStyleValueIds(inv, productType);
      // Canonical values use the AI-derived style→image mapping; custom values
      // carry their own per-value image. Custom variations are ADDED on top, so
      // link both sets (distinct value_ids, deduped for safety).
      const variationImages = dedupeByValueId([
        ...buildVariationImages({
          styleImageMapping: copy.styleImageMapping || {},
          rankToImageId: uploadedRanks,
          styleLabelToValueId,
          productType,
        }),
        ...(customStyles.length ? buildCustomVariationImages({ customStyles, rankToImageId: uploadedRanks, styleLabelToValueId, productType }) : []),
      ]);
      if (variationImages.length) {
        await updateVariationImages(shopClient, shopId, listingId, variationImages);
        onStep('variation_images', { linked: variationImages.length });
      }
      checkpoint.variation_images_done = true;
    } catch (err) {
      onStep('variation_images_warning', { error: err.response?.data?.error || err.message });
    }
  }

  // ── 7. Publish if requested ────────────────────────────────────────────────
  if (state === 'published' && !checkpoint.published) {
    await updateListing(shopClient, shopId, listingId, { state: 'active' });
    checkpoint.published = true;
    onStep('published', { listing_id: listingId });
  }

  return {
    listing_id: listingId,
    url: `https://www.etsy.com/listing/${listingId}`,
    state,
    images_uploaded: uploadedRanks.size,
    inventory_products: inventoryBody.products.length,
    enabled_styles: Object.entries(enabledStyles).filter(([, v]) => v).map(([k]) => k),
    checkpoint,
    preview,
  };
}

/**
 * Re-push a listing's variation inventory with new per-style prices, preserving
 * the full 12×6 matrix (including disabled styles) and re-linking variation
 * images. Used to update prices on an already-created draft/active listing.
 *
 * @param {object} ctx
 * @param {import('axios').AxiosInstance} ctx.shopClient
 * @param {string|number} ctx.shopId
 * @param {string|number} ctx.listingId
 * @param {Record<string,number>} ctx.prices              style key → new price
 * @param {object[]} [ctx.imageAnalysis]
 * @param {number} [ctx.restockQuantity=3]
 * @param {Record<string,number[]>} [ctx.styleImageMapping]
 * @param {Map<number,number>|Record<string,number>} [ctx.rankToImageId]
 * @returns {Promise<{minPrice:number, inventoryProducts:number}>}
 */
async function repriceListing(ctx) {
  const {
    shopClient, shopId, listingId, prices,
    imageAnalysis = [], restockQuantity = 3,
    styleImageMapping = {}, rankToImageId, enabledStyles, enabledModels, readinessStateId, productType, variationOrder,
  } = ctx;

  const customStyles = normaliseCustomStyles(ctx.customStyles);
  const { body: inventoryBody, minPrice } = buildInventory({ prices, imageAnalysis, restockQuantity, enabledStyles, enabledModels, customStyles, variationOrder, readinessStateId, productType });
  await putListingInventory(shopClient, listingId, inventoryBody);

  // Re-link variation images (value_ids are re-issued by Etsy after a PUT).
  try {
    const map = rankToImageId instanceof Map
      ? rankToImageId
      : new Map(Object.entries(rankToImageId || {}).map(([k, v]) => [Number(k), v]));
    if (map.size) {
      const inv = await getListingInventory(shopClient, listingId);
      const styleLabelToValueId = readStyleValueIds(inv, productType);
      const variationImages = dedupeByValueId([
        ...buildVariationImages({ styleImageMapping, rankToImageId: map, styleLabelToValueId, productType }),
        ...(customStyles.length ? buildCustomVariationImages({ customStyles, rankToImageId: map, styleLabelToValueId, productType }) : []),
      ]);
      if (variationImages.length) await updateVariationImages(shopClient, shopId, listingId, variationImages);
    }
  } catch { /* variation-image relink is best-effort */ }

  return { minPrice, inventoryProducts: inventoryBody.products.length };
}

module.exports = { createListingForProduct, buildCreateBody, repriceListing };
