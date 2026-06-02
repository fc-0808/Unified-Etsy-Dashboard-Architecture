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
  uploadListingImage,
  uploadListingVideo,
  putListingInventory,
  getListingInventory,
  updateVariationImages,
  updateListing,
} = require('../etsy/client');
const { buildInventory, buildVariationImages, PROP_STYLES } = require('./variation-builder');

/** Build the createDraftListing request body from copy + resolved settings. */
function buildCreateBody({ copy, settings, minPrice, listingQuantity }) {
  const d = settings.defaults || settings;
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
    materials: ['Silicone'],
    tags: copy.tags || [],
  };
  if (d.shipping_profile_id) body.shipping_profile_id = d.shipping_profile_id;
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

  const { body: inventoryBody, minPrice, listingQuantity, enabledStyles } = buildInventory({
    prices,
    imageAnalysis: copy.imageAnalysis,
    restockQuantity,
  });
  const createBody = buildCreateBody({ copy, settings, minPrice, listingQuantity });

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
    };
  }

  // ── 1. Create draft listing ────────────────────────────────────────────────
  let listingId = checkpoint.listing_id || null;
  if (!listingId) {
    const created = await createDraftListingForm(shopClient, shopId, createBody, { legacy: true });
    listingId = created.listing_id;
    checkpoint.listing_id = listingId;
    onStep('created', { listing_id: listingId });
  }

  // ── 2. Upload images (skip ranks already uploaded) ─────────────────────────
  const uploadedRanks = new Map(Object.entries(checkpoint.rank_to_image_id || {}).map(([k, v]) => [Number(k), v]));
  for (const img of product.images) {
    if (uploadedRanks.has(img.rank)) continue;
    const buffer = fs.readFileSync(img.path);
    const res = await uploadListingImage(shopClient, shopId, listingId, {
      buffer,
      filename: img.filename,
      rank: img.rank,
      altText: copy.title ? copy.title.slice(0, 250) : undefined,
    });
    if (res && res.listing_image_id) {
      uploadedRanks.set(img.rank, res.listing_image_id);
      checkpoint.rank_to_image_id = Object.fromEntries(uploadedRanks);
      onStep('image', { rank: img.rank, image_id: res.listing_image_id });
    }
  }

  // ── 3. Upload video (optional, best-effort) ────────────────────────────────
  if (product.video && !checkpoint.video_done) {
    try {
      const buffer = fs.readFileSync(product.video.path);
      await uploadListingVideo(shopClient, shopId, listingId, {
        buffer,
        filename: product.video.filename,
      });
      checkpoint.video_done = true;
      onStep('video', { ok: true });
    } catch (err) {
      onStep('video_warning', { error: err.response?.data?.error || err.message });
    }
  }

  // ── 4. Set the variation inventory ─────────────────────────────────────────
  if (!checkpoint.inventory_done) {
    await putListingInventory(shopClient, listingId, inventoryBody);
    checkpoint.inventory_done = true;
    onStep('inventory', { products: inventoryBody.products.length });
  }

  // ── 5+6. Link variation images (best-effort — non-fatal) ───────────────────
  if (!checkpoint.variation_images_done) {
    try {
      const inv = await getListingInventory(shopClient, listingId);
      const styleLabelToValueId = new Map();
      for (const p of inv.products || []) {
        for (const pv of p.property_values || []) {
          if (pv.property_id === PROP_STYLES && (pv.values || []).length && (pv.value_ids || []).length) {
            styleLabelToValueId.set(pv.values[0], pv.value_ids[0]);
          }
        }
      }
      const variationImages = buildVariationImages({
        styleImageMapping: copy.styleImageMapping || {},
        rankToImageId: uploadedRanks,
        styleLabelToValueId,
      });
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
  };
}

module.exports = { createListingForProduct, buildCreateBody };
