'use strict';

/**
 * AI copy generator for the Bulk Listing Creator.
 *
 * Ports the two-phase OpenAI pipeline from Listings_automation/src/ai_generator.py:
 *
 *   Phase 1 — Vision classification (deterministic): per-image facts
 *             (has_grip / has_charm / has_case / edge / MagSafe / grip_shape)
 *             plus a product summary (character, colors, design features).
 *             style_image_mapping is derived algorithmically from these facts.
 *
 *   Phase 2 — SEO copy (text-only): title (<=140), 500+ word description,
 *             exactly 13 tags, primary/secondary color — using Phase 1 facts
 *             as context (images are NOT re-sent).
 *
 * Uses OpenAI Structured Outputs (response_format json_schema, strict) so the
 * model returns guaranteed-shaped JSON. Vision-capable model required.
 */

const fs = require('fs');
const path = require('path');
const { config, hasOpenAiKey } = require('./config');

let _OpenAI = null;
function getOpenAIClient() {
  if (!hasOpenAiKey()) {
    const err = new Error('OPENAI_API_KEY is not set. Add it to the .env file to enable AI copy generation.');
    err.status = 400;
    throw err;
  }
  if (!_OpenAI) _OpenAI = require('openai');
  return new _OpenAI({ apiKey: config.openai.apiKey });
}

const ETSY_COLORS = [
  'Beige', 'Black', 'Blue', 'Bronze', 'Brown', 'Clear', 'Copper', 'Gold',
  'Gray', 'Green', 'Orange', 'Pink', 'Purple', 'Rainbow', 'Red',
  'Rose gold', 'Silver', 'White', 'Yellow',
];

function isReasoningModel(model) {
  return /^(gpt-5|o1|o3|o4)/.test(model || '');
}

// ── JSON schemas for Structured Outputs ──────────────────────────────────────

const PHASE1_SCHEMA = {
  name: 'phase1_classification',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      product_summary: {
        type: 'object',
        additionalProperties: false,
        properties: {
          character_name: { type: 'string' },
          case_primary_color: { type: 'string' },
          case_secondary_color: { type: 'string' },
          design_features: { type: 'string' },
        },
        required: ['character_name', 'case_primary_color', 'case_secondary_color', 'design_features'],
      },
      image_classifications: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            index: { type: 'integer' },
            description: { type: 'string' },
            accessory_reasoning: { type: 'string' },
            has_grip: { type: 'boolean' },
            has_charm: { type: 'boolean' },
            has_case: { type: 'boolean' },
            is_edge_or_profile: { type: 'boolean' },
            has_magsafe_ring: { type: 'boolean' },
            grip_shape: { type: 'string' },
            thumbnail_quality: { type: 'integer' },
          },
          required: [
            'index', 'description', 'accessory_reasoning', 'has_grip', 'has_charm',
            'has_case', 'is_edge_or_profile', 'has_magsafe_ring', 'grip_shape', 'thumbnail_quality',
          ],
        },
      },
    },
    required: ['product_summary', 'image_classifications'],
  },
};

const PHASE2_SCHEMA = {
  name: 'phase2_copy',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string' },
      description: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      primary_color: { type: 'string' },
      secondary_color: { type: 'string' },
    },
    required: ['title', 'description', 'tags', 'primary_color', 'secondary_color'],
  },
};

// ── Low-level OpenAI call with model-aware params + JSON schema ───────────────

async function callStructured(client, { messages, schema, maxTokens }) {
  const model = config.openai.model;
  const base = {
    model,
    messages,
    response_format: { type: 'json_schema', json_schema: schema },
  };
  if (isReasoningModel(model)) {
    base.max_completion_tokens = maxTokens;
  } else {
    base.temperature = schema.name === 'phase1_classification' ? 0.0 : 0.4;
    base.max_tokens = maxTokens;
  }
  const resp = await client.chat.completions.create(base);
  const content = resp.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI returned an empty response.');
  return JSON.parse(content);
}

// ── Image encoding ────────────────────────────────────────────────────────────

function encodeImage(imgPath, mime) {
  const data = fs.readFileSync(imgPath);
  const b64 = data.toString('base64');
  const ext = path.extname(imgPath).toLowerCase().replace('.', '');
  const finalMime = mime || (ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`);
  return { type: 'image_url', image_url: { url: `data:${finalMime};base64,${b64}`, detail: 'high' } };
}

// ── Phase 1 ─────────────────────────────────────────────────────────────────

function buildPhase1Prompt(nImages) {
  return `You are a precision visual QA analyst classifying ${nImages} phone case product images numbered IMAGE 1 to IMAGE ${nImages}.

For EACH image produce one object with these fields:
  "index"               integer image number (1..${nImages})
  "description"         one sentence describing the image
  "accessory_reasoning" explicit statement of what accessories are visible (grip/charm/none). Reason before deciding booleans.
  "has_grip"            true ONLY if a raised grip/popsocket/ring/shaped disc is on the BACK of the case
  "has_charm"           true ONLY if beads/cord/lanyard/wristlet hang from the case. Do NOT confuse a hand or sleeve with a charm.
  "has_case"            true if the phone case body is visible
  "is_edge_or_profile"  true if the camera shows the side/edge/profile
  "has_magsafe_ring"    true if a circular magnetic ring outline is visible on the back
  "grip_shape"          short shape description if a grip is present, else ""
  "thumbnail_quality"   integer 1-10 quality as a thumbnail

CONSISTENCY: judge grip and charm INDEPENDENTLY. A wristlet/beaded loop at the case corner = charm even when no grip is present. "no grip on the back" does NOT imply no charm. Never invent a charm from a hand, finger, or sleeve.

Index 1 is the thumbnail. Classify ALL ${nImages} images, one object per image in ascending index order.

Then fill "product_summary":
  "character_name"        exact character(s) on the case (e.g. Cinnamoroll, Kuromi, Rilakkuma, "Pink Bunny"); join multiple with " & "; if unknown use "kawaii character".
  "case_primary_color"    dominant case body color — EXACTLY one of: ${ETSY_COLORS.join(', ')}.
  "case_secondary_color"  second most visible color — EXACTLY one of the same list.
  "design_features"       notable visual details for SEO (clear back, glitter, 3D, MagSafe ring, grip theme, charm bead colors). Empty string if none.

Return only the structured JSON.`;
}

const CHARM_KW = ['charm', 'dangling', 'dangle', 'lanyard', 'beads', 'beaded', 'cord', 'strap hanging', 'hanging strap', 'tassel', 'wristlet', 'pendant', 'hanging from', 'hanging accessory', 'bead chain', 'pearl chain'];
const NO_CHARM = ['no charm', 'no dangling', 'no lanyard', 'no beads', 'no wristlet', 'without charm', 'bare corner', 'charm absent', 'charm not present', 'no bead'];
const GRIP_KW = ['grip', 'popsocket', 'pop socket', 'pop-socket', 'phone holder', 'ring holder', 'finger ring', 'pear-shaped', 'shaker grip', 'disc', 'socket', 'protrusion'];
const NO_GRIP = ['no grip', 'no popsocket', 'no holder', 'no socket', 'without grip', 'bare back', 'clean back'];

function applyBooleanCorrection(items) {
  const out = [];
  for (const item of items) {
    const combined = `${item.description || ''} ${item.accessory_reasoning || ''}`.toLowerCase();
    let hasCharm = Boolean(item.has_charm);
    let hasGrip = Boolean(item.has_grip);
    if (NO_CHARM.some((p) => combined.includes(p))) hasCharm = false;
    else if (CHARM_KW.some((k) => combined.includes(k))) hasCharm = true;
    if (NO_GRIP.some((p) => combined.includes(p))) hasGrip = false;
    else if (GRIP_KW.some((k) => combined.includes(k))) hasGrip = true;
    out.push({
      index: item.index,
      description: item.description,
      has_grip: hasGrip,
      has_charm: hasCharm,
      has_case: item.has_case !== false,
      is_edge_or_profile: Boolean(item.is_edge_or_profile),
      has_magsafe_ring: Boolean(item.has_magsafe_ring),
      grip_shape: item.grip_shape || '',
      thumbnail_quality: Number(item.thumbnail_quality) || 5,
    });
  }
  return out;
}

/**
 * Derive style → [1-based image indices] mapping from Phase 1 facts.
 * Index 1 (thumbnail) is never linked. Sorted best-quality-first.
 */
function deriveStyleMapping(imageAnalysis) {
  const mapping = {
    'Case+Grip+Charm': [], 'Case+Grip': [], 'Case+Charm': [],
    'Case Only': [], 'Case Only (edge)': [], 'Grip Only': [], 'Charm Only': [],
  };
  const quality = {};
  for (const img of imageAnalysis) quality[img.index] = Number(img.thumbnail_quality) || 5;

  for (const img of imageAnalysis) {
    const idx = Number(img.index) || 0;
    if (idx < 2) continue; // thumbnail
    const { has_grip: g, has_charm: c, has_case: hasCase = true, is_edge_or_profile: edge } = img;
    if (hasCase) {
      if (g && c) mapping['Case+Grip+Charm'].push(idx);
      else if (g) mapping['Case+Grip'].push(idx);
      else if (c) mapping['Case+Charm'].push(idx);
      else if (edge) mapping['Case Only (edge)'].push(idx);
      else mapping['Case Only'].push(idx);
    } else if (g) {
      mapping['Grip Only'].push(idx);
    }
  }
  mapping['Charm Only'] = [];

  for (const style of Object.keys(mapping)) {
    mapping[style].sort((a, b) => (quality[b] || 5) - (quality[a] || 5) || a - b);
  }

  // Case+Charm fallback when no dedicated image exists.
  if (!mapping['Case+Charm'].length) {
    if (mapping['Case+Grip+Charm'].length) mapping['Case+Charm'] = [mapping['Case+Grip+Charm'][0]];
    else if (mapping['Case Only'].length) mapping['Case+Charm'] = [mapping['Case Only'][0]];
  }
  return mapping;
}

async function phase1Classify(client, images) {
  const content = [{ type: 'text', text: buildPhase1Prompt(images.length) }];
  images.forEach((img, i) => {
    content.push({ type: 'text', text: `\nIMAGE ${i + 1}:` });
    content.push(encodeImage(img.path, img.mime));
  });
  const messages = [
    {
      role: 'system',
      content: 'You are a precise visual QA analyst for e-commerce phone case products. Classify each image and summarise the product. Do NOT write marketing copy. Return only valid JSON matching the schema.',
    },
    { role: 'user', content },
  ];
  const parsed = await callStructured(client, { messages, schema: PHASE1_SCHEMA, maxTokens: 8000 });
  const imageAnalysis = applyBooleanCorrection(parsed.image_classifications || []);
  return { imageAnalysis, productSummary: parsed.product_summary || {} };
}

// ── Phase 2 ─────────────────────────────────────────────────────────────────

function buildPhase2System(shopName, brandTags) {
  const tagsDisplay = brandTags && brandTags.length
    ? brandTags.map((t) => `"${t}"`).join(', ')
    : '"y2kase"';
  return `OVERRIDE — TEXT-ONLY MODE: all image analysis was completed in Phase 1. Use the PRODUCT SUMMARY and PHASE 1 CLASSIFICATION facts in the user message directly. Trust them completely; never contradict them.

You are an elite, world-class Etsy SEO expert and top-tier seller of kawaii Y2K phone cases for the ${shopName} brand. Your priority is deeply researched, intensely SEO-driven listings that rank on page one.

SHOP BRAND TAGS (MANDATORY — include ALL of these exactly in your tags output): ${tagsDisplay}

Return ONLY a JSON object with keys: "title", "description", "tags", "primary_color", "secondary_color".

TITLE (140 chars max, never below 130): front-load the strongest keywords. Structure: [Character+Color] [MAGSAFE if confirmed] Case [with Accessory], [Style] [Color] Cover iPhone 17 16 15 14 13 Pro Max, [Aesthetic] Gift. Include character name, accessory, aesthetic (Kawaii, Y2K, Coquette), and "iPhone 17 16 15 14 13 Pro Max". Only use each of % : & + at most once. Include "MAGSAFE" only if the magnetic ring is confirmed in Phase 1.

DESCRIPTION (minimum 500 words): start with an emoji + keyword-packed desire hook (NOT a header). Then: Paragraph 1 (aesthetic & desire, include "kawaii phone case", character name, "Y2K aesthetic", "cute iPhone case"); Paragraph 2 (product uniqueness — material, clear back, artwork, MagSafe ring if confirmed); IF grip confirmed a grip paragraph; IF charm confirmed a charm paragraph. Then sections: "✨ Key Features" (5-7 bullets, only confirmed features, each on its own line), "📱 Device Compatibility" (iPhone 17/16/15 series each model + Pro/Pro Max, iPhone 15/14 Pro/Pro Max, iPhone 14, iPhone 13; note Plus/Mini and 13 Pro/Pro Max are NOT available), "📦 What's Included" (the 6 bundles: Full Set, Case+Grip, Case+Charm, Case Only, Grip Only, Charm Only), "❤️ The ${shopName} Promise", and "🚚 Shipping & Processing" (ready to ship in 3-5 business days, worldwide tracked).

TAGS: EXACTLY 13 tags, each <=20 chars including spaces, all lowercase, real buyer search terms, no punctuation except hyphens. Must include ALL brand tags above, the universal tags "kawaii phone case", "cute iphone case", "y2k phone case", the MagSafe tags "magsafe iphone case", "magsafe phone case", "magsafe case", two iPhone model tags (e.g. "iphone 17 case", "iphone 16 pro max"), and fill remaining slots with aesthetic/character/accessory/gift-intent tags relevant to THIS product.

COLORS: primary_color and secondary_color MUST each be exactly one of: ${ETSY_COLORS.join(', ')}.

PROHIBITIONS: never claim MagSafe unless confirmed in Phase 1; never list Plus/Mini models or Samsung/Android; never fabricate accessories not confirmed in Phase 1; never produce fewer or more than exactly 13 tags.`;
}

function buildPhase2User(meta, brandTags, imageAnalysis, productSummary) {
  const lines = [
    'Generate an SEO-optimized Etsy listing for this phone case product.',
    '',
    '=== PRODUCT FACTS ===',
    `Shop: ${meta.shopName || 'Y2KASEshop'}`,
    'Product type: Kawaii Y2K phone case (possibly with accessories)',
    'Material: Silicone',
  ];
  if (brandTags && brandTags.length) {
    lines.push(`BRAND IDENTITY TAGS (include ALL exactly as written): ${brandTags.map((t) => `"${t}"`).join(', ')}`);
  }
  if (productSummary) {
    lines.push(
      '',
      '=== PRODUCT SUMMARY (from Phase 1 vision — use directly) ===',
      `Character: ${productSummary.character_name || 'kawaii character'}`,
      `Primary Color: ${productSummary.case_primary_color || ''}`,
      `Secondary Color: ${productSummary.case_secondary_color || ''}`,
      `Design Features: ${productSummary.design_features || ''}`,
    );
  }
  if (imageAnalysis && imageAnalysis.length) {
    const hasGrip = imageAnalysis.some((i) => i.has_grip);
    const hasCharm = imageAnalysis.some((i) => i.has_charm);
    const hasMag = imageAnalysis.some((i) => i.has_magsafe_ring);
    const gripShapes = [...new Set(imageAnalysis.filter((i) => i.has_grip && i.grip_shape).map((i) => i.grip_shape))];
    lines.push(
      '',
      '=== PHASE 1 CLASSIFICATION RESULTS (TRUST THESE) ===',
      `MagSafe ring detected: ${hasMag ? 'YES — include MAGSAFE in title and description' : 'NO — do NOT mention MagSafe anywhere'}`,
      `Grip accessory present: ${hasGrip ? 'YES' + (gripShapes.length ? ` — shape: ${gripShapes.join(', ')}` : '') : 'NO — omit grip paragraphs/features'}`,
      `Charm accessory present: ${hasCharm ? 'YES' : 'NO — omit charm paragraphs/features'}`,
    );
  }
  lines.push(
    '',
    'Return ONLY the JSON object with keys: "title", "description", "tags", "primary_color", "secondary_color".',
  );
  return lines.join('\n');
}

// ── Post-processing ───────────────────────────────────────────────────────────

function cleanTag(raw) {
  let t = String(raw || '').trim().toLowerCase();
  t = t.replace(/[^\w\s-]/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  return t.slice(0, 20);
}

function ensureShopTags(tags, brandTags) {
  const coreBrand = (brandTags && brandTags.length ? brandTags : ['y2kase']).map((t) => t.slice(0, 20));
  const magsafe = ['magsafe iphone case', 'magsafe phone case', 'magsafe case'];
  const requiredAll = [...coreBrand, ...magsafe.filter((m) => !coreBrand.includes(m))];
  const set = new Set(tags);
  const result = [...tags];
  for (const req of requiredAll) {
    if (set.has(req)) continue;
    if (result.length < 13) result.push(req);
    else {
      for (let i = result.length - 1; i >= 0; i--) {
        if (!requiredAll.includes(result[i])) { result[i] = req; break; }
      }
    }
    set.add(req);
  }
  return result.slice(0, 13);
}

function validateColor(raw) {
  if (!raw) return '';
  const clean = String(raw).trim().toLowerCase();
  const found = ETSY_COLORS.find((c) => c.toLowerCase() === clean);
  return found || '';
}

function postProcessTitle(rawTitle) {
  let title = String(rawTitle || '').trim();
  if (title.length > 140) {
    title = title.slice(0, 140).replace(/\s+\S*$/, '').replace(/,+$/, '').trim();
  }
  const subs = { '&': 'and', '+': 'and', '%': 'percent', ':': ',' };
  for (const [ch, repl] of Object.entries(subs)) {
    if ((title.split(ch).length - 1) > 1) {
      const parts = title.split(ch);
      title = parts[0] + ch + parts.slice(1).join(` ${repl} `);
      title = title.replace(/\s+/g, ' ').trim();
    }
  }
  return title;
}

/**
 * Main entry: generate full listing copy for one scanned product.
 *
 * @param {object} product   scanner result ({ name, images:[{path,mime}], ... })
 * @param {object} [opts]
 * @param {string} [opts.shopName]
 * @param {string[]} [opts.brandTags]
 * @returns {Promise<{
 *   title:string, description:string, tags:string[],
 *   primaryColor:string, secondaryColor:string,
 *   styleImageMapping:Record<string,number[]>, imageAnalysis:object[],
 *   productSummary:object
 * }>}
 */
async function generateListingCopy(product, opts = {}) {
  const client = getOpenAIClient();
  const shopName = opts.shopName || 'Y2KASEshop';
  const brandTags = opts.brandTags || [];
  const images = (product.images || []).slice(0, 10);
  if (!images.length) {
    const err = new Error(`No images for product "${product.name}" — cannot generate copy.`);
    err.status = 400;
    throw err;
  }

  // Phase 1 (with one retry on empty result)
  let phase1;
  for (let attempt = 1; attempt <= 2; attempt++) {
    phase1 = await phase1Classify(client, images);
    if (phase1.imageAnalysis.length) break;
  }
  const imageAnalysis = phase1.imageAnalysis;
  const productSummary = phase1.productSummary;
  const styleImageMapping = deriveStyleMapping(imageAnalysis);

  // Phase 2 (text-only)
  const messages = [
    { role: 'system', content: buildPhase2System(shopName, brandTags) },
    { role: 'user', content: buildPhase2User({ shopName }, brandTags, imageAnalysis, productSummary) },
  ];
  const parsed = await callStructured(client, { messages, schema: PHASE2_SCHEMA, maxTokens: 16000 });

  let tags = (parsed.tags || []).map(cleanTag).filter(Boolean).slice(0, 13);
  tags = ensureShopTags(tags, brandTags);

  return {
    title: postProcessTitle(parsed.title),
    description: String(parsed.description || '').trim(),
    tags,
    primaryColor: validateColor(parsed.primary_color) || validateColor(productSummary.case_primary_color),
    secondaryColor: validateColor(parsed.secondary_color) || validateColor(productSummary.case_secondary_color),
    styleImageMapping,
    imageAnalysis,
    productSummary,
  };
}

module.exports = {
  generateListingCopy,
  deriveStyleMapping,
  applyBooleanCorrection,
  ETSY_COLORS,
  isReasoningModel,
};
