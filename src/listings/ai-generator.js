'use strict'

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

const fs = require('fs')
const path = require('path')
const { config, hasOpenAiKey } = require('./config')
const { catalogPromptBlock, normaliseCharacter } = require('./character-catalog')
const { enabledStylesFor, normaliseEnabledStyles } = require('./variation-builder')
const productTypes = require('./product-types')

// Device-model helpers, resolved per product type (default iPhone). These wrap
// the product-type registry so the copy pipeline stays device-agnostic.
function compatibilityNamesFor(enabledModels, productType) {
	return productTypes.compatibilityNamesFor(productType, enabledModels)
}
function allDescriptionNamesFor(productType) {
	return productTypes.allDescriptionNames(productType)
}
function normaliseEnabledModels(input, productType) {
	return productTypes.normaliseEnabledModels(productType, input)
}

let _OpenAI = null
function getOpenAIClient() {
	if (!hasOpenAiKey()) {
		const err = new Error('OPENAI_API_KEY is not set. Add it to the .env file to enable AI copy generation.')
		err.status = 400
		throw err
	}
	if (!_OpenAI) _OpenAI = require('openai')
	return new _OpenAI({ apiKey: config.openai.apiKey })
}

/**
 * Vision client — may point at a different provider (OpenRouter, DashScope, etc.)
 * when VISION_API_KEY + VISION_BASE_URL are set, otherwise falls back to the main
 * OpenAI client so existing setups continue to work unchanged.
 *
 * For OpenRouter the SDK spec recommends passing HTTP-Referer and X-Title headers
 * via defaultHeaders so the request appears in your OpenRouter dashboard correctly.
 */
function getVisionClient() {
	const key = config.openai.visionApiKey
	const baseURL = config.openai.visionBaseUrl
	if (!key || !key.trim()) {
		return getOpenAIClient()
	}
	if (!_OpenAI) _OpenAI = require('openai')
	// Extra resilience for third-party gateways (OpenRouter), which can drop TLS
	// connections under load: let the SDK retry transport failures and allow a
	// long timeout for reasoning models that think before answering.
	const opts = { apiKey: key, maxRetries: 4, timeout: 120000 }
	if (baseURL) opts.baseURL = baseURL
	// Attach optional attribution headers (OpenRouter requires/recommends these).
	const extraHeaders = {}
	if (config.openai.visionReferer) extraHeaders['HTTP-Referer'] = config.openai.visionReferer
	if (config.openai.visionTitle)   extraHeaders['X-Title']      = config.openai.visionTitle
	if (Object.keys(extraHeaders).length) opts.defaultHeaders = extraHeaders
	return new _OpenAI(opts)
}

const ETSY_COLORS = ['Beige', 'Black', 'Blue', 'Bronze', 'Brown', 'Clear', 'Copper', 'Gold', 'Gray', 'Green', 'Orange', 'Pink', 'Purple', 'Rainbow', 'Red', 'Rose gold', 'Silver', 'White', 'Yellow']

function isReasoningModel(model) {
	// Qwen models reason internally but do NOT accept OpenAI's reasoning_effort
	// parameter or max_completion_tokens — treat them as standard models.
	if (/qwen/i.test(model || '')) return false
	return /^(gpt-5|o1|o3|o4)/.test(model || '')
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
					character_evidence: { type: 'string' },
					character_name: { type: 'string' },
					character_franchise: { type: 'string' },
					character_confidence: { type: 'integer' },
					character_alternatives: {
						type: 'array',
						items: {
							type: 'object',
							additionalProperties: false,
							properties: { name: { type: 'string' }, confidence: { type: 'integer' } },
							required: ['name', 'confidence'],
						},
					},
					case_primary_color: { type: 'string' },
					case_secondary_color: { type: 'string' },
					design_features: { type: 'string' },
					// The concrete, specific design SUBJECT — the thing a shopper would
					// search for when there is NO licensed character (e.g. "Strawberry",
					// "Cherry Bow", "Heart", "Daisy"). 1-3 words, Title Case, "" if a
					// licensed character dominates and there's no distinct motif.
					design_subject: { type: 'string' },
					// Every distinct visual motif on the case (lowercase nouns): e.g.
					// ["strawberry", "polka dots", "pink bow", "lace"]. Drives specific
					// SEO keywords in the title, tags, and description.
					design_motifs: { type: 'array', items: { type: 'string' } },
					// One-word dominant aesthetic if obvious: coquette|kawaii|y2k|fairycore|cottagecore|gothic|preppy|"".
					design_aesthetic: { type: 'string' },
				},
				required: ['character_evidence', 'character_name', 'character_franchise', 'character_confidence', 'character_alternatives', 'case_primary_color', 'case_secondary_color', 'design_features', 'design_subject', 'design_motifs', 'design_aesthetic'],
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
					required: ['index', 'description', 'accessory_reasoning', 'has_grip', 'has_charm', 'has_case', 'is_edge_or_profile', 'has_magsafe_ring', 'grip_shape', 'thumbnail_quality'],
				},
			},
		},
		required: ['product_summary', 'image_classifications'],
	},
}

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
			// Etsy listing attributes ("feature section") — boost SEO & filtering.
			// theme/occasion/celebration/pattern MUST be chosen from the allowed
			// lists provided in the user message (empty string if none fit).
			attributes: {
				type: 'object',
				additionalProperties: false,
				properties: {
					theme: { type: 'string' },
					occasion: { type: 'string' },
					celebration: { type: 'string' },
					pattern: { type: 'string' },
					glitter: { type: 'boolean' },
					card_slot: { type: 'boolean' },
					built_in_stand: { type: 'boolean' },
				},
				required: ['theme', 'occasion', 'celebration', 'pattern', 'glitter', 'card_slot', 'built_in_stand'],
			},
		},
		required: ['title', 'description', 'tags', 'primary_color', 'secondary_color', 'attributes'],
	},
}

// Dedicated character-identification pass: enumerates EVERY distinct mascot it
// can see (catalog-grounded), then commits to the single PRIMARY character (the
// hero on the thumbnail / largest / most repeated). Run multiple times and
// majority-voted for self-consistency.
const IDENTIFY_SCHEMA = {
	name: 'character_identification',
	strict: true,
	schema: {
		type: 'object',
		additionalProperties: false,
		properties: {
			distinct_characters: {
				type: 'array',
				items: {
					type: 'object',
					additionalProperties: false,
					properties: {
						name: { type: 'string' },
						franchise: { type: 'string' },
						confidence: { type: 'integer' },
						where: { type: 'string' },
					},
					required: ['name', 'franchise', 'confidence', 'where'],
				},
			},
			is_collage: { type: 'boolean' },
			primary_character: { type: 'string' },
			primary_franchise: { type: 'string' },
			primary_confidence: { type: 'integer' },
			reasoning: { type: 'string' },
		},
		required: ['distinct_characters', 'is_collage', 'primary_character', 'primary_franchise', 'primary_confidence', 'reasoning'],
	},
}

// Dedicated accessory pass: decides — conservatively — whether the product
// actually ships with a physical GRIP and/or a physical CHARM, so the style
// variations only include what's really offered.
const ACCESSORY_SCHEMA = {
	name: 'accessory_analysis',
	strict: true,
	schema: {
		type: 'object',
		additionalProperties: false,
		properties: {
			per_image: {
				type: 'array',
				items: {
					type: 'object',
					additionalProperties: false,
					properties: {
						index: { type: 'integer' },
						shows_grip: { type: 'boolean' },
						shows_charm: { type: 'boolean' },
						shows_magsafe: { type: 'boolean' },
						note: { type: 'string' },
					},
					required: ['index', 'shows_grip', 'shows_charm', 'shows_magsafe', 'note'],
				},
			},
			grip_present: { type: 'boolean' },
			grip_confidence: { type: 'integer' },
			grip_evidence: { type: 'string' },
			charm_present: { type: 'boolean' },
			charm_confidence: { type: 'integer' },
			charm_evidence: { type: 'string' },
			magsafe_present: { type: 'boolean' },
			magsafe_confidence: { type: 'integer' },
			magsafe_evidence: { type: 'string' },
		},
		required: ['per_image', 'grip_present', 'grip_confidence', 'grip_evidence', 'charm_present', 'charm_confidence', 'charm_evidence', 'magsafe_present', 'magsafe_confidence', 'magsafe_evidence'],
	},
}

// Dedicated MagSafe pass — MagSafe (a built-in magnet ring) is visually subtle on
// clear/printed cases, so it gets its own focused, evidence-rich detector rather
// than competing for attention inside the grip/charm pass.
const MAGSAFE_SCHEMA = {
	name: 'magsafe_analysis',
	strict: true,
	schema: {
		type: 'object',
		additionalProperties: false,
		properties: {
			per_image: {
				type: 'array',
				items: {
					type: 'object',
					additionalProperties: false,
					properties: {
						index: { type: 'integer' },
						shows_magsafe: { type: 'boolean' },
						signal: { type: 'string' }, // 'ring' | 'text' | 'mount' | 'graphic' | 'none'
						note: { type: 'string' },
					},
					required: ['index', 'shows_magsafe', 'signal', 'note'],
				},
			},
			magsafe_present: { type: 'boolean' },
			magsafe_confidence: { type: 'integer' },
			magsafe_evidence: { type: 'string' },
		},
		required: ['per_image', 'magsafe_present', 'magsafe_confidence', 'magsafe_evidence'],
	},
}

// ── Low-level OpenAI call with model-aware params + JSON schema ───────────────

/** True for non-OpenAI models that still reason internally (eat output tokens). */
function isExternalReasoningModel(model) {
	return /qwen|glm|deepseek|grok/i.test(model || '')
}

/**
 * Extract a JSON object/array from a model response that may be wrapped in
 * markdown fences or prefixed with prose. Returns the cleaned JSON string.
 */
function extractJson(text) {
	let s = String(text || '').trim()
	const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
	if (fence) s = fence[1].trim()
	if (s[0] !== '{' && s[0] !== '[') {
		const objStart = s.indexOf('{')
		const objEnd = s.lastIndexOf('}')
		if (objStart !== -1 && objEnd > objStart) s = s.slice(objStart, objEnd + 1)
	}
	return s
}

async function callStructured(client, { messages, schema, maxTokens, temperature, model, reasoningEffort }) {
	const useModel = model || config.openai.model
	const openaiReasoning = isReasoningModel(useModel)
	const externalReasoning = isExternalReasoningModel(useModel)

	// Models that reason internally (Qwen3.7-Plus etc.) burn output tokens on
	// chain-of-thought before JSON. Use the caller's budget as-is — do NOT force a
	// high floor (OpenRouter rejects upfront when input images + max_tokens exceed
	// your credit balance). Truncation retries grow the budget only when needed.
	const ceiling = Number.isFinite(config.openai.visionMaxTokensCeiling) && config.openai.visionMaxTokensCeiling > 0
		? config.openai.visionMaxTokensCeiling
		: 16000
	// A budget of 0/undefined means "no explicit cap" — send no max_tokens at all
	// (avoids the provider's upfront balance rejection on large caps).
	const wantBudget = Number.isFinite(maxTokens) && maxTokens > 0
	const baseBudget = wantBudget ? (externalReasoning ? Math.min(maxTokens, ceiling) : maxTokens) : 0

	const build = (mt) => {
		const body = {
			model: useModel,
			messages,
			response_format: { type: 'json_schema', json_schema: schema },
		}
		const hasBudget = Number.isFinite(mt) && mt > 0
		if (openaiReasoning) {
			if (hasBudget) body.max_completion_tokens = mt
			const effort = reasoningEffort || config.openai.reasoningEffort
			if (effort && effort !== 'default') body.reasoning_effort = effort
		} else {
			body.temperature = temperature != null ? temperature : schema.name === 'phase1_classification' ? 0.0 : 0.4
			if (hasBudget) body.max_tokens = mt
		}
		return body
	}

	const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
	const MAX_ATTEMPTS = 4
	let mt = baseBudget
	let lastErr = null

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		let resp
		try {
			resp = await client.chat.completions.create(build(mt))
		} catch (err) {
			const status = err.status || err.response?.status
			const body = err.response?.data?.error?.message || err.error?.message || err.message || ''
			lastErr = err

			// Genuine, non-retryable billing failure (only after the balance is truly
			// exhausted — surfaced clearly so the operator knows to top up).
			const billing = status === 402 || /requires more credits|insufficient_quota|payment required/i.test(body)

			// Transient: network drops, TLS resets, timeouts, rate limits, 5xx, and
			// empty/invalid HTTP bodies (SDK throws a JSON parse error on those).
			const transient =
				/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket disconnected|network|timeout|aborted/i.test(err.message || '') ||
				/Unexpected end of JSON input|Unexpected token/i.test(err.message || '') ||
				status === 408 || status === 409 || status === 429 || (status >= 500 && status < 600)

			if (billing) {
				const e = new Error(`Vision provider "${useModel}" rejected the request for billing reasons (HTTP ${status}): ${body}. Top up the VISION_API_KEY provider (OpenRouter) or switch OPENAI_VISION_MODEL back to an OpenAI model.`)
				e.status = 402
				throw e
			}
			if (transient && attempt < MAX_ATTEMPTS) {
				await sleep(800 * attempt) // linear backoff: 0.8s, 1.6s, 2.4s
				continue
			}
			throw err
		}

		const choice = resp.choices?.[0]
		const content = choice?.message?.content
		const finish = choice?.finish_reason

		if (content && content.trim()) {
			try {
				return JSON.parse(extractJson(content))
			} catch (err) {
				lastErr = err
				// Recoverable → retry. finish_reason:
				//  • 'length' — output was truncated → grow the budget (if one is set).
				//  • 'error'  — OpenRouter provider errored mid-generation; a retry
				//               usually re-routes to a healthy provider and succeeds.
				//  • other/null — malformed once; a fresh attempt typically parses.
				if (attempt < MAX_ATTEMPTS) {
					if ((finish === 'length' || finish === 'error') && Number.isFinite(mt) && mt > 0) mt = Math.min(mt * 2, ceiling)
					await sleep(800 * attempt) // backoff: 0.8s, 1.6s, 2.4s
					continue
				}
				throw new Error(`Model "${useModel}" returned unparsable JSON (finish_reason=${finish}) after ${MAX_ATTEMPTS} attempts: ${String(content).slice(0, 200)}`)
			}
		}

		// Empty content (or a bare provider error) — retry with backoff.
		lastErr = new Error(`Model "${useModel}" returned an empty response (finish_reason=${finish}).`)
		if (attempt < MAX_ATTEMPTS) {
			if ((finish === 'length' || finish === 'error') && Number.isFinite(mt) && mt > 0) mt = Math.min(mt * 2, ceiling)
			await sleep(700 * attempt)
			continue
		}
		break
	}
	throw lastErr || new Error('Model returned an empty response.')
}

// ── Image encoding ────────────────────────────────────────────────────────────

let _sharp = null
let _sharpUnavailable = false
function getSharp() {
	if (_sharp || _sharpUnavailable) return _sharp
	try { _sharp = require('sharp') } catch { _sharpUnavailable = true }
	return _sharp
}

// Vision providers cap the total image payload per request (OpenRouter: 30MB).
// Product photos are often huge (4000px+ PNGs), so we downscale to a sane long
// edge and re-encode as JPEG before base64 — this keeps ample detail for the
// model (which tiles at ~768-1024px) while cutting payload 10-50×.
const VISION_MAX_EDGE = 1536
const VISION_JPEG_QUALITY = 82

/**
 * Read an image, downscale + compress it, and return an OpenAI image_url part.
 * Falls back to the raw bytes if sharp is unavailable or processing fails.
 * @returns {Promise<object>}
 */
async function encodeImage(imgPath, mime, detail) {
	const ext = path.extname(imgPath).toLowerCase().replace('.', '')
	const sharp = getSharp()
	if (sharp) {
		try {
			const jpeg = await sharp(imgPath, { failOn: 'none' })
				.rotate() // honour EXIF orientation
				.resize({ width: VISION_MAX_EDGE, height: VISION_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
				.jpeg({ quality: VISION_JPEG_QUALITY, mozjpeg: true })
				.toBuffer()
			const b64 = jpeg.toString('base64')
			return { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}`, detail: detail || 'high' } }
		} catch {
			/* fall through to raw bytes */
		}
	}
	const data = fs.readFileSync(imgPath)
	const b64 = data.toString('base64')
	const finalMime = mime || (ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`)
	return { type: 'image_url', image_url: { url: `data:${finalMime};base64,${b64}`, detail: detail || 'high' } }
}

// ── Phase 1 ─────────────────────────────────────────────────────────────────

function buildPhase1Prompt(nImages, productType) {
	const pt = productTypes.getProductType(productType)
	return `You are a precision visual QA analyst classifying ${nImages} ${pt.deviceNoun} product images numbered IMAGE 1 to IMAGE ${nImages}.

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

Then fill "product_summary". CHARACTER IDENTIFICATION IS THE MOST ERROR-PRONE FIELD — follow this exact procedure and DO NOT guess from colour alone:
  STEP A — "character_evidence": FIRST, before naming anything, describe the decisive VISUAL features you actually see on the artwork: body shape (animal? human? a DEVICE/gadget?), ears (long/short/none), face markings, distinctive accessories (bow, hood, zipper, screen+buttons), and palette. 1-3 sentences.
  STEP B — match that evidence against this REFERENCE CATALOG of known characters and their decisive signatures:
${catalogPromptBlock()}
  STEP C — "character_name": the single best match from the catalog (use its EXACT name), or join multiple with " & ". CRITICAL RULES:
     • If the evidence is an EGG-SHAPED DEVICE with a pixel screen and buttons it is a Tamagotchi, NOT a white animal like Cinnamoroll.
     • A white rabbit with long upright ears and no hood/bow is most likely Miffy or Molang — it is NOT Chiikawa (Chiikawa's characters are a small round white cat "Hachiware" and a YELLOW rabbit "Usagi", never a long-eared white rabbit).
     • COLLAGE / STICKER-SHEET cases: if the art is a busy collage of MANY small different mascots/icons (no single dominant hero character), do NOT pick one — output "kawaii character" (or a theme like "Sanrio characters" only if you are sure of the franchise) and set a LOW confidence. Forcing one name onto a multi-character collage is the most common mistake — avoid it.
     • If nothing in the catalog matches the evidence well, output "kawaii character". Never force a catalog name onto mismatched evidence.
  "character_franchise"   the rights holder from the catalog (Sanrio, San-X, Bandai, Pokemon, Disney, …) or "unknown".
  "character_confidence"  integer 0-100: how certain the name is, judged ONLY by how well the evidence matches that character's signature cues. Be honest — partial/ambiguous art should score 40-70, a clear unmistakable match 85-100, a pure guess <40.
  "character_alternatives" up to 3 other plausible characters with their own confidences (e.g. look-alikes you considered and ruled out). Empty array if none.
  "case_primary_color"    dominant case body color — EXACTLY one of: ${ETSY_COLORS.join(', ')}.
  "case_secondary_color"  second most visible color — EXACTLY one of the same list.
  "design_features"       notable visual details for SEO (clear back, glitter, 3D, MagSafe ring, grip theme, charm bead colors). Empty string if none.
  "design_motifs"         EVERY distinct visual motif printed/shown on the case, as lowercase nouns — e.g. ["strawberry","polka dots","pink bow","cherry","heart","daisy","lace","star","butterfly","checkerboard"]. Be SPECIFIC about fruits, flowers, shapes, and patterns. Empty array only if truly plain.
  "design_subject"        the SINGLE most prominent, search-worthy NON-character subject in 1-3 words, Title Case — the thing a shopper would type when there is no licensed character (e.g. "Strawberry", "Cherry Bow", "Polka Dot Heart", "Daisy"). If a licensed character clearly dominates and there is no standout motif, use "".
  "design_aesthetic"      the dominant aesthetic in ONE lowercase word if obvious: coquette | kawaii | y2k | fairycore | cottagecore | gothic | preppy | "".

CRITICAL FOR SEO: be CONCRETE about the actual design. "strawberry", "cherry", "polka dot", "bow", "heart" are far stronger keywords than vague words like "cute" or "character". Always capture the real motifs.

Return only the structured JSON.`
}

const CHARM_KW = ['charm', 'dangling', 'dangle', 'lanyard', 'beads', 'beaded', 'cord', 'strap hanging', 'hanging strap', 'tassel', 'wristlet', 'pendant', 'hanging from', 'hanging accessory', 'bead chain', 'pearl chain']
const NO_CHARM = ['no charm', 'no dangling', 'no lanyard', 'no beads', 'no wristlet', 'without charm', 'bare corner', 'charm absent', 'charm not present', 'no bead']
const GRIP_KW = ['grip', 'popsocket', 'pop socket', 'pop-socket', 'phone holder', 'ring holder', 'finger ring', 'pear-shaped', 'shaker grip', 'disc', 'socket', 'protrusion']
const NO_GRIP = ['no grip', 'no popsocket', 'no holder', 'no socket', 'without grip', 'bare back', 'clean back']

function applyBooleanCorrection(items) {
	const out = []
	for (const item of items) {
		const combined = `${item.description || ''} ${item.accessory_reasoning || ''}`.toLowerCase()
		let hasCharm = Boolean(item.has_charm)
		let hasGrip = Boolean(item.has_grip)
		if (NO_CHARM.some((p) => combined.includes(p))) hasCharm = false
		else if (CHARM_KW.some((k) => combined.includes(k))) hasCharm = true
		if (NO_GRIP.some((p) => combined.includes(p))) hasGrip = false
		else if (GRIP_KW.some((k) => combined.includes(k))) hasGrip = true
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
		})
	}
	return out
}

/**
 * Derive style → [1-based image indices] mapping from Phase 1 facts.
 * Index 1 (thumbnail) is never linked. Sorted best-quality-first.
 */
function deriveStyleMapping(imageAnalysis) {
	const mapping = {
		'Case+Grip+Charm': [],
		'Case+Grip': [],
		'Case+Charm': [],
		'Case Only': [],
		'Case Only (edge)': [],
		'Grip Only': [],
		'Charm Only': [],
	}
	const quality = {}
	for (const img of imageAnalysis) quality[img.index] = Number(img.thumbnail_quality) || 5

	for (const img of imageAnalysis) {
		const idx = Number(img.index) || 0
		if (idx < 2) continue // thumbnail
		const { has_grip: g, has_charm: c, has_case: hasCase = true, is_edge_or_profile: edge } = img
		if (hasCase) {
			if (g && c) mapping['Case+Grip+Charm'].push(idx)
			else if (g) mapping['Case+Grip'].push(idx)
			else if (c) mapping['Case+Charm'].push(idx)
			else if (edge) mapping['Case Only (edge)'].push(idx)
			else mapping['Case Only'].push(idx)
		} else if (g) {
			mapping['Grip Only'].push(idx)
		}
	}
	mapping['Charm Only'] = []

	for (const style of Object.keys(mapping)) {
		mapping[style].sort((a, b) => (quality[b] || 5) - (quality[a] || 5) || a - b)
	}

	// Case+Charm fallback when no dedicated image exists.
	if (!mapping['Case+Charm'].length) {
		if (mapping['Case+Grip+Charm'].length) mapping['Case+Charm'] = [mapping['Case+Grip+Charm'][0]]
		else if (mapping['Case Only'].length) mapping['Case+Charm'] = [mapping['Case Only'][0]]
	}
	return mapping
}

async function phase1Classify(client, images, productType) {
	const pt = productTypes.getProductType(productType)
	const content = [{ type: 'text', text: buildPhase1Prompt(images.length, pt) }]
	for (let i = 0; i < images.length; i++) {
		content.push({ type: 'text', text: `\nIMAGE ${i + 1}:` })
		content.push(await encodeImage(images[i].path, images[i].mime))
	}
	const messages = [
		{
			role: 'system',
			content: `You are a precise visual QA analyst for e-commerce ${pt.deviceNoun} products. Classify each image and summarise the product. Do NOT write marketing copy. Return only valid JSON matching the schema.`,
		},
		{ role: 'user', content },
	]
	const parsed = await callStructured(client, { messages, schema: PHASE1_SCHEMA, maxTokens: config.openai.visionMaxTokens, model: config.openai.visionModel })
	const imageAnalysis = applyBooleanCorrection(parsed.image_classifications || [])
	return { imageAnalysis, productSummary: parsed.product_summary || {} }
}

// ── Character identification (dedicated, catalog-grounded, self-consistent) ────

const GENERIC_NAME = 'kawaii character'
function isGenericName(s) {
	return !s || /kawaii character|unknown|generic|^none$|n\/a|^various$/i.test(String(s).trim())
}

/** Order images thumbnail-first, then by quality — the hero usually leads. */
function evidenceImages(images, imageAnalysis, max) {
	const quality = {}
	for (const i of imageAnalysis || []) quality[Number(i.index)] = Number(i.thumbnail_quality) || 5
	const ranked = images
		.map((img, idx) => ({ img, rank: idx + 1 }))
		.sort((a, b) => {
			if (a.rank === 1) return -1 // thumbnail always first (hero shot)
			if (b.rank === 1) return 1
			return (quality[b.rank] || 5) - (quality[a.rank] || 5)
		})
		.slice(0, max)
		.map((x) => x.img)
	return ranked
}

/**
 * One focused identification call: enumerate every distinct mascot, then commit
 * to the single PRIMARY character (hero on the thumbnail / largest / repeated).
 */
async function identifyOnce(client, { images, imageAnalysis, productSummary, temperature }) {
	const chosen = evidenceImages(images, imageAnalysis, 5)
	if (!chosen.length) return null

	const hint = productSummary && productSummary.character_name && !isGenericName(productSummary.character_name) ? `A first analysis guessed "${productSummary.character_name}" — treat that as a hint only, verify it independently.` : ''

	const content = [
		{
			type: 'text',
			text:
				`Identify the PRIMARY licensed character on this phone case. IMAGE 1 is the THUMBNAIL (hero shot): the main character is whatever is most prominent there, repeated across images, or largest.\n\n` +
				`REFERENCE CATALOG (decisive visual signatures — match against these):\n${catalogPromptBlock()}\n\n` +
				`Procedure:\n` +
				`1) distinct_characters: list EVERY recognizable character/mascot you can see — each with its franchise, a 0-100 confidence, and where it appears (which image / position).\n` +
				`2) is_collage: true if the art is a busy sticker-sheet of MANY different small mascots with no single dominant hero.\n` +
				`3) primary_character: the ONE main character of this listing (EXACT catalog name). COLLAGE RULE — do NOT give up too easily: if ONE character is clearly the most frequent / largest / most central across the collage, name THAT specific character (with an honest confidence). Only when several characters truly share dominance equally: if they belong to one franchise use that theme (e.g. "Sanrio characters"), and only if the franchise itself is unclear use "kawaii character".\n` +
				`4) primary_confidence: brutally honest 0-100.\n\n` +
				`Zoom in mentally on the thumbnail and on repeated motifs; small on-screen size is NOT a reason to skip a character — the image is full-fidelity.\n\n` +
				`DISAMBIGUATION (do not get these wrong):\n` +
				`• Tamagotchi = an EGG-SHAPED DEVICE with a small pixel screen + buttons (a gadget), NOT a white animal. A collage/print full of tiny Tamagotchi devices/pixel pets is "Tamagotchi".\n` +
				`• A white rabbit with long upright ears and NO hood/bow = Miffy or Molang. NOT Chiikawa (Chiikawa's rabbit "Usagi" is YELLOW; "Hachiware" is a round white CAT).\n` +
				`• My Melody wears a pink/red HOOD; Kuromi wears a BLACK jester hood with a pink skull; Cinnamoroll is a white puppy with very long ears.\n` +
				`${hint}`,
		},
	]
	for (let i = 0; i < chosen.length; i++) {
		content.push({ type: 'text', text: `\n${i === 0 ? 'IMAGE 1 (THUMBNAIL / hero)' : 'IMAGE ' + (i + 1)}:` })
		content.push(await encodeImage(chosen[i].path, chosen[i].mime, config.openai.visionDetail))
	}

	const messages = [
		{ role: 'system', content: 'You are a meticulous licensed-character identification specialist for kawaii / Y2K merchandise. Judge ONLY by visual evidence against the catalog. Never invent a character. Return only valid JSON matching the schema.' },
		{ role: 'user', content },
	]
	return callStructured(client, { messages, schema: IDENTIFY_SCHEMA, maxTokens: Math.min(6000, config.openai.visionMaxTokens), temperature, model: config.openai.visionModel, reasoningEffort: config.openai.reasoningEffort })
}

/**
 * Self-consistent identification: run identifyOnce several times and majority-
 * vote the primary character (catalog-normalised). Sampling only varies on
 * non-reasoning models (temperature); reasoning models are queried once. Also
 * merges every sample's distinct_characters into a ranked candidate list.
 *
 * @returns {{name, franchise, confidence, candidates:Array<{name,confidence}>, isCollage, agreement, samples}|null}
 */
async function identifyCharacter(client, { images, imageAnalysis, productSummary }) {
	// Reasoning models (OpenAI o-series/gpt-5, Qwen, GLM…) deliberate internally,
	// so a single well-reasoned pass matches multi-sample voting — and avoids the
	// concurrent-request burst that trips third-party gateway budget checks.
	const reasoning = isReasoningModel(config.openai.visionModel) || isExternalReasoningModel(config.openai.visionModel)
	const samples = reasoning ? 1 : Math.max(1, config.character.samples)

	const runs = []
	for (let i = 0; i < samples; i++) {
		// Vary temperature across samples (non-reasoning) for genuine self-consistency.
		const temperature = reasoning ? undefined : samples === 1 ? 0.2 : 0.3 + i * 0.25
		runs.push(identifyOnce(client, { images, imageAnalysis, productSummary, temperature }).catch(() => null))
	}
	const results = (await Promise.all(runs)).filter(Boolean)
	if (!results.length) return null

	// Vote on the primary character (normalised to catalog canon).
	const votes = new Map() // canonKey → { name, franchise, confSum, count }
	const candidatePool = new Map() // canonKey → { name, confSum, count }
	let collageVotes = 0
	for (const r of results) {
		if (r.is_collage) collageVotes++
		const pName = String(r.primary_character || '').trim()
		if (pName) {
			const norm = normaliseCharacter(pName)
			const key = (norm.known ? norm.name : pName).toLowerCase()
			const v = votes.get(key) || { name: norm.known ? norm.name : pName, franchise: norm.franchise || r.primary_franchise || '', confSum: 0, count: 0 }
			v.confSum += Number(r.primary_confidence) || 0
			v.count += 1
			votes.set(key, v)
		}
		for (const dc of r.distinct_characters || []) {
			if (!dc || !dc.name || isGenericName(dc.name)) continue
			const norm = normaliseCharacter(dc.name)
			const key = (norm.known ? norm.name : dc.name).toLowerCase()
			const c = candidatePool.get(key) || { name: norm.known ? norm.name : dc.name, confSum: 0, count: 0 }
			c.confSum += Number(dc.confidence) || 0
			c.count += 1
			candidatePool.set(key, c)
		}
	}

	// Winner = most votes, tie-broken by summed confidence.
	let winner = null
	for (const v of votes.values()) {
		if (!winner || v.count > winner.count || (v.count === winner.count && v.confSum > winner.confSum)) winner = v
	}

	const agreement = winner ? winner.count / results.length : 0
	const avgConf = winner ? winner.confSum / winner.count : 0
	// Confidence reflects BOTH how sure each sample was and how much they agreed.
	const confidence = winner ? Math.round(avgConf * (0.5 + 0.5 * agreement)) : 0

	const candidates = [...candidatePool.values()]
		.sort((a, b) => b.confSum / b.count - a.confSum / a.count)
		.slice(0, 5)
		.map((c) => ({ name: c.name, confidence: Math.round(c.confSum / c.count) }))

	return {
		name: winner ? winner.name : GENERIC_NAME,
		franchise: winner ? winner.franchise : '',
		confidence,
		candidates,
		isCollage: collageVotes > results.length / 2,
		agreement,
		samples: results.length,
	}
}

// ── Accessory detection (grip / charm) ────────────────────────────────────────

/** One focused, conservative accessory-detection call across ALL images. */
async function analyzeAccessoriesOnce(client, { images, temperature }) {
	if (!images.length) return null
	const content = [
		{
			type: 'text',
			text:
				`Determine — CONSERVATIVELY — whether this phone-case product physically INCLUDES a GRIP and/or a CHARM accessory, and whether it has a real MAGSAFE magnetic ring. ` +
				`These drive the listing, so DO NOT over-report: when in doubt, answer false.\n\n` +
				`GRIP — a real, raised, 3-D holder physically attached to the BACK of the case: a popsocket, collapsible disc, ring holder, finger loop, or shaped knob/protrusion that clearly stands off the surface.\n` +
				`  NOT a grip: a hand or fingers holding the phone; a flat MagSafe magnet ring (a printed/embossed circle that is flush, not raised); the raised camera module; printed circular artwork.\n\n` +
				`CHARM — a real, 3-D dangling accessory hanging from the case: beads, a beaded chain, a pearl strand, a cord/lanyard/wristlet strap, a tassel, or a pendant, typically attached at a corner and hanging loose.\n` +
				`  NOT a charm: beads/hearts/stars that are PRINTED or painted flat onto the case; a wrist/hand/sleeve; the phone's own lanyard hole with nothing in it.\n\n` +
				`MAGSAFE — true ONLY when there is CLEAR evidence of a real magnetic ring system: a distinct circular magnet ring (often a double-ring) visibly built INTO the case back, OR explicit "MagSafe" text/packaging. Be VERY strict.\n` +
				`  NOT MagSafe: the round CAMERA module/lenses; a clear/transparent case with no visible magnet ring; printed or painted circles, halos, or circular artwork; reflections; the phone's own internal components seen through a clear case. A plain clear case or a printed design is NOT MagSafe. When you cannot clearly see a dedicated magnet ring, answer FALSE.\n\n` +
				`For EACH image set shows_grip / shows_charm / shows_magsafe (only true when you can CLEARLY see the real feature in that image), with a short note. ` +
				`Then set grip_present / charm_present / magsafe_present true only if at least one image clearly shows it. Give 0-100 confidence and brief evidence for each. Bias HARD toward FALSE when ambiguous — especially for MagSafe on clear cases.`,
		},
	]
	for (let i = 0; i < images.length; i++) {
		content.push({ type: 'text', text: `\nIMAGE ${i + 1}:` })
		content.push(await encodeImage(images[i].path, images[i].mime))
	}
	const messages = [
		{ role: 'system', content: 'You are a meticulous product-QA analyst deciding whether a phone case ships with a physical grip, a physical charm, and/or a real MagSafe magnet ring. Judge ONLY by clear visual evidence. Treat clear/printed cases as NON-MagSafe unless a dedicated magnet ring is unmistakably visible. When unsure, answer false. Return only valid JSON matching the schema.' },
		{ role: 'user', content },
	]
	return callStructured(client, { messages, schema: ACCESSORY_SCHEMA, maxTokens: Math.min(6000, config.openai.visionMaxTokens), temperature, model: config.openai.visionModel, reasoningEffort: config.openai.reasoningEffort })
}

/**
 * Self-consistent accessory detection: majority-vote grip/charm presence across
 * samples (non-reasoning models) and per-image. Conservative by construction.
 *
 * @returns {{hasGrip, hasCharm, gripConfidence, charmConfidence, gripEvidence,
 *            charmEvidence, perImage:Map<number,{has_grip,has_charm}>}|null}
 */
async function analyzeAccessories(client, { images, samples }) {
	if (!images.length) return null
	const reasoning = isReasoningModel(config.openai.visionModel) || isExternalReasoningModel(config.openai.visionModel)
	const n = reasoning ? 1 : Math.max(1, samples || config.character.samples)

	const runs = []
	for (let i = 0; i < n; i++) {
		const temperature = reasoning ? undefined : n === 1 ? 0.0 : 0.2 + i * 0.2
		runs.push(analyzeAccessoriesOnce(client, { images, temperature }).catch(() => null))
	}
	const results = (await Promise.all(runs)).filter(Boolean)
	if (!results.length) return null

	// Vote presence (majority); average confidence over the agreeing samples.
	const gripVotes = results.filter((r) => r.grip_present).length
	const charmVotes = results.filter((r) => r.charm_present).length
	const magsafeVotes = results.filter((r) => r.magsafe_present).length
	const hasGrip = gripVotes > results.length / 2
	const hasCharm = charmVotes > results.length / 2
	const hasMagsafe = magsafeVotes > results.length / 2
	const avg = (key, want) => {
		const vals = results.filter((r) => r[`${key}_present`] === want).map((r) => Number(r[`${key}_confidence`]) || 0)
		return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0
	}
	const evidence = (key, want) => (results.find((r) => r[`${key}_present`] === want) || {})[`${key}_evidence`] || ''

	// Per-image majority (for variation-image mapping + authoritative magsafe).
	const perImage = new Map()
	const idxVotes = new Map() // idx → { grip, charm, magsafe, n }
	for (const r of results) {
		for (const pi of r.per_image || []) {
			const k = Number(pi.index)
			const v = idxVotes.get(k) || { grip: 0, charm: 0, magsafe: 0, n: 0 }
			if (pi.shows_grip) v.grip++
			if (pi.shows_charm) v.charm++
			if (pi.shows_magsafe) v.magsafe++
			v.n++
			idxVotes.set(k, v)
		}
	}
	for (const [k, v] of idxVotes) {
		perImage.set(k, { has_grip: v.grip > v.n / 2, has_charm: v.charm > v.n / 2, has_magsafe_ring: v.magsafe > v.n / 2 })
	}

	return {
		hasGrip,
		hasCharm,
		hasMagsafe,
		gripConfidence: avg('grip', hasGrip),
		charmConfidence: avg('charm', hasCharm),
		magsafeConfidence: avg('magsafe', hasMagsafe),
		gripEvidence: evidence('grip', hasGrip),
		charmEvidence: evidence('charm', hasCharm),
		magsafeEvidence: evidence('magsafe', hasMagsafe),
		perImage,
		samples: results.length,
	}
}

// ── Dedicated MagSafe detection (focused + evidence-based) ────────────────────

/** One focused MagSafe-only call across ALL images (reads rings AND any text). */
async function analyzeMagsafeOnce(client, { images, temperature }) {
	if (!images.length) return null
	const content = [
		{
			type: 'text',
			text:
				`TASK: Decide whether this phone case is MAGSAFE-COMPATIBLE — i.e. it has a built-in ring of magnets (a MagSafe magnet array) that lets it snap onto MagSafe chargers, wallets, and mounts.\n\n` +
				`Treat ANY ONE of these POSITIVE signals as proof (signal type in parentheses):\n` +
				`1. (ring) A distinct CIRCULAR magnet ring on the BACK of the case — typically a single thin ring or two concentric rings, centred in the upper-middle of the back, SEPARATE from the camera. On a clear/transparent case this ring is often visible as a faint, white, or printed circle embedded in the case body.\n` +
				`2. (text) The words "MagSafe", "Mag Safe", "Magnetic", "magnet", or a magnet/ring icon printed ANYWHERE — on the case, the artwork, a hang-tag, packaging, or an infographic/feature image. READ all visible text.\n` +
				`3. (mount) The phone shown snapping onto / held by a magnetic mount, magnetic ring holder, magnetic wallet, or a round wireless/MagSafe charger.\n` +
				`4. (graphic) A feature/exploded diagram depicting magnets or a magnet ring.\n\n` +
				`NOT MagSafe (do NOT count these):\n` +
				`• The round CAMERA module/lenses (in a corner) — never the MagSafe ring.\n` +
				`• Clearly DECORATIVE printed circles that are part of the artwork (off-centre, multiple, colourful patterns) rather than one centred magnet ring.\n` +
				`• A plain case with NO visible centred ring AND NO magnetic text/graphic anywhere.\n\n` +
				`Be ACCURATE, not paranoid: most modern kawaii/Y2K cases ARE MagSafe. If you can see a centred ring outline OR any "MagSafe/magnetic" wording or magnet graphic, answer TRUE. Only answer FALSE when there is genuinely no ring and no magnetic indication in ANY image.\n\n` +
				`For EACH image: shows_magsafe (bool), signal ('ring'|'text'|'mount'|'graphic'|'none'), and a short note. Then set magsafe_present true if AT LEAST ONE image shows a positive signal. Give 0-100 confidence and cite the single strongest piece of evidence.`,
		},
	]
	for (let i = 0; i < images.length; i++) {
		content.push({ type: 'text', text: `\nIMAGE ${i + 1}:` })
		content.push(await encodeImage(images[i].path, images[i].mime))
	}
	const messages = [
		{ role: 'system', content: 'You are a meticulous product-spec analyst who determines whether a phone case is MagSafe-compatible (has a built-in magnet ring). You weigh BOTH a visible magnet ring AND any printed "MagSafe/magnetic" wording or magnet graphics. You never confuse the camera or decorative art for the magnet ring. Return only valid JSON matching the schema.' },
		{ role: 'user', content },
	]
	return callStructured(client, { messages, schema: MAGSAFE_SCHEMA, maxTokens: Math.min(6000, config.openai.visionMaxTokens), temperature, model: config.openai.visionModel, reasoningEffort: config.openai.reasoningEffort })
}

/**
 * Self-consistent MagSafe detection. Because false-negatives were the pain point,
 * the verdict leans positive: MagSafe is present if a MAJORITY of samples say so
 * OR any single sample is confidently positive (≥70). Returns overall + per-image.
 *
 * @returns {{hasMagsafe, confidence, evidence, perImage:Map<number,boolean>, samples}|null}
 */
async function analyzeMagsafe(client, { images, samples }) {
	if (!images.length) return null
	// MagSafe is the weak spot — run at least 2 samples even on reasoning models so
	// a single miss doesn't sink a real MagSafe case.
	const n = Math.max(2, samples || config.character.samples)
	const reasoning = isReasoningModel(config.openai.visionModel) || isExternalReasoningModel(config.openai.visionModel)

	const runs = []
	for (let i = 0; i < n; i++) {
		const temperature = reasoning ? undefined : 0.2 + i * 0.2
		runs.push(analyzeMagsafeOnce(client, { images, temperature }).catch(() => null))
	}
	const results = (await Promise.all(runs)).filter(Boolean)
	if (!results.length) return null

	const presentVotes = results.filter((r) => r.magsafe_present)
	const maxConf = presentVotes.reduce((m, r) => Math.max(m, Number(r.magsafe_confidence) || 0), 0)
	// Lean positive: majority OR a single confident positive sample.
	const hasMagsafe = presentVotes.length > results.length / 2 || maxConf >= 70
	const best = presentVotes.sort((a, b) => (Number(b.magsafe_confidence) || 0) - (Number(a.magsafe_confidence) || 0))[0]

	// Per-image: flag any image any sample marked positive (union — we want to
	// surface every shot that evidences MagSafe).
	const perImage = new Map()
	for (const r of results) {
		for (const pi of r.per_image || []) {
			if (pi.shows_magsafe) perImage.set(Number(pi.index), true)
		}
	}

	return {
		hasMagsafe,
		confidence: hasMagsafe ? Math.max(maxConf, 60) : (best ? best.magsafe_confidence : 0),
		evidence: best ? best.magsafe_evidence : 'No MagSafe ring or magnetic indication found in any image.',
		perImage,
		samples: results.length,
	}
}

/**
 * Resolve the final character from Phase 1 (+ optional verification), applying
 * catalog normalisation and the confidence floor. Returns the fields the rest
 * of the pipeline + the UI consume.
 */
async function resolveCharacter(client, { images, imageAnalysis, productSummary }) {
	const GENERIC = 'kawaii character'
	const canon = (s) => normaliseCharacter(s).name.toLowerCase()

	// Phase-1 baseline (incidental character guess from the classification pass).
	let name = String(productSummary.character_name || '').trim()
	let franchise = productSummary.character_franchise || ''
	const p1Conf = Number.isFinite(Number(productSummary.character_confidence)) ? Number(productSummary.character_confidence) : name ? 60 : 0
	let confidence = p1Conf
	const evidence = productSummary.character_evidence || ''
	let alternatives = Array.isArray(productSummary.character_alternatives) ? productSummary.character_alternatives.slice() : []

	// Dedicated, self-consistent identifier (authoritative). It enumerates every
	// mascot, votes on the PRIMARY character, and returns a ranked candidate pool.
	let ident = null
	if (config.character.verify && images.length) {
		try {
			ident = await identifyCharacter(client, { images, imageAnalysis, productSummary })
		} catch {
			ident = null
		}
	}

	if (ident && ident.name) {
		const identGeneric = isGenericName(ident.name)
		const agree = !isGenericName(name) && !identGeneric && canon(ident.name) === canon(name)
		if (!identGeneric) {
			// Trust the dedicated identifier as the primary signal.
			name = ident.name
			franchise = ident.franchise || franchise
			confidence = agree
				? Math.min(100, Math.round((ident.confidence + p1Conf) / 2) + 10) // corroborated
				: ident.confidence
		} else {
			// Identifier couldn't commit to one hero (true collage / mixed) → be humble
			// unless Phase 1 itself was strong and specific.
			if (!isGenericName(name) && p1Conf >= 80) {
				confidence = Math.round(p1Conf * 0.85)
			} else {
				name = GENERIC
				confidence = Math.min(confidence, ident.confidence, 45)
			}
		}
		// Merge the identifier's candidate pool into the alternatives (richer picker).
		alternatives = [...(ident.candidates || []), ...alternatives]
	}

	// Normalise to a catalog entry where possible (canonical spelling + franchise).
	const norm = normaliseCharacter(name)
	if (norm.known) {
		name = norm.name
		franchise = norm.franchise || franchise
	}

	// De-duplicate alternatives, drop the chosen name, cap to 5.
	const seen = new Set([name.toLowerCase()])
	alternatives = alternatives
		.filter((a) => {
			if (!a || !a.name) return false
			const k = String(a.name).toLowerCase()
			if (seen.has(k) || isGenericName(a.name)) return false
			seen.add(k)
			return true
		})
		.slice(0, 5)

	// Below the floor we refuse to confidently mislabel — fall back to generic,
	// but keep the detected candidate so the operator can confirm/override.
	const low = !name || isGenericName(name) || confidence < config.character.confidenceFloor
	const detectedName = isGenericName(name) ? (ident && ident.candidates && ident.candidates[0] ? ident.candidates[0].name : '') : name
	const effectiveName = low ? GENERIC : name

	return {
		characterName: effectiveName || GENERIC,
		characterDetected: detectedName || '',
		characterFranchise: franchise || '',
		characterConfidence: Math.max(0, Math.min(100, Math.round(confidence))),
		characterEvidence: evidence,
		characterAlternatives: alternatives,
		characterVerified: Boolean(ident),
		characterLowConfidence: low,
	}
}

// ── Phase 2 ─────────────────────────────────────────────────────────────────

function buildPhase2System(shopName, brandTags, hasMagsafe, enabledStyles, enabledModels, attributeMenu, subjectInfo, productType, customStyles) {
	const pt = productTypes.getProductType(productType)
	const deviceNoun = pt.deviceNoun // e.g. "phone case" / "AirPods case"
	const deviceShort = pt.deviceShort // e.g. "iPhone case" / "AirPods case"
	const tagsDisplay = brandTags && brandTags.length ? brandTags.map((t) => `"${t}"`).join(', ') : '"y2kase"'

	// Custom variation values (e.g. "Case1 + Charm1") are ADDED on top of the
	// canonical bundles; grip/charm copy reflects EITHER source.
	const custom = Array.isArray(customStyles) && customStyles.length ? customStyles : null

	// Grip/charm presence is derived from the OFFERED bundles (operator's matrix)
	// OR any custom label that mentions them. MagSafe only applies to product types
	// that support it (never AirPods cases).
	const hasGrip = pt.supportsGrip && (stylesHaveGrip(enabledStyles) || (custom && custom.some((s) => /grip|popsocket|holder/i.test(s.label))))
	const hasCharm = stylesHaveCharm(enabledStyles) || (custom && custom.some((s) => /charm|bead|strap|lanyard|keychain|clip/i.test(s.label)))
	hasMagsafe = pt.supportsMagsafe && hasMagsafe
	const devicePhrase = titleDevicePhrase(enabledModels, pt)

	// SUBJECT: when there's a real licensed character, lead with it. When generic,
	// lead with the SPECIFIC design motif (strawberry, cherry, bow…) — NEVER the
	// vague word "Character". This is the single biggest title-SEO lever.
	const si = subjectInfo || {}
	const motifs = (si.motifs || []).filter(Boolean)
	const motifList = motifs.join(', ')
	const titleCase = (s) => String(s || '').replace(/\b\w/g, (c) => c.toUpperCase())
	const titleCaseNoun = titleCase(deviceShort)
	let subjectClause
	if (!si.isGeneric && si.characterName) {
		subjectClause = `SUBJECT: this ${deviceNoun} features the licensed character "${si.characterName}" — LEAD the title with that character name (the strongest query), then color/aesthetic. Still weave the design motifs (${motifList || 'n/a'}) into tags + description.`
	} else {
		const lead = (si.designSubject && si.designSubject.trim()) || (motifs[0] ? titleCase(motifs[0]) : '')
		subjectClause = lead
			? `SUBJECT: there is NO licensed character. NEVER use the words "Character", "Kawaii Character", or a generic placeholder as the subject. LEAD the title with the SPECIFIC design subject "${lead}" + the primary color (e.g. "${lead} Pink ${titleCaseNoun}…"). Build the whole listing around the real motifs: ${motifList || lead}.`
			: `SUBJECT: there is no licensed character and no standout motif — LEAD with the primary color + aesthetic (e.g. "Pink Y2K ${titleCaseNoun}…"). NEVER write the word "Character".`
	}

	// Build the "feature section" attribute instructions from the taxonomy menu.
	const menu = attributeMenu || {}
	const list = (arr) => (Array.isArray(arr) && arr.length ? arr.join(', ') : '')
	const attrLines = []
	if (list(menu.theme)) attrLines.push(`  - theme: pick the SINGLE best-fitting value (or "") from: ${list(menu.theme)}`)
	if (list(menu.occasion)) attrLines.push(`  - occasion: pick the SINGLE best-fitting value (or "") from: ${list(menu.occasion)}`)
	if (list(menu.celebration)) attrLines.push(`  - celebration: pick the SINGLE best-fitting value (or "") from: ${list(menu.celebration)}`)
	if (list(menu.pattern)) attrLines.push(`  - pattern: pick the SINGLE best-fitting value (or "") from: ${list(menu.pattern)}`)
	const attributesClause = `ATTRIBUTES ("attributes" object — Etsy feature fields that boost search ranking & filtering; choose ONLY from the provided options, use "" if none truly fits — NEVER invent a value):
${attrLines.length ? attrLines.join('\n') : '  - (no catalog options provided — return "" for theme/occasion/celebration/pattern)'}
  - glitter: true ONLY if the case art is clearly glittery/sparkly, else false
  - card_slot: true ONLY if a card pocket/wallet is visible, else false
  - built_in_stand: true ONLY if a fold-out kickstand is visible, else false`

	// Device compatibility must reflect ONLY the models this listing offers.
	const compatNames = compatibilityNamesFor(enabledModels, pt)
	const unavailableNames = allDescriptionNamesFor(pt).filter((n) => !compatNames.includes(n))
	const compatClause = `"📱 Device Compatibility" — list EXACTLY these compatible models as bullets and NO others: ${compatNames.join(', ')}. Then add a note that these models are NOT available: ${[...unavailableNames, ...(pt.unavailableNote || [])].join(', ')}.`

	// MagSafe is mentioned ONLY when supported by the product type AND confirmed.
	const titleMagsafe = hasMagsafe
		? `Include "MAGSAFE" right after the character+color (the magnetic ring IS confirmed).`
		: `Do NOT include "MAGSAFE" anywhere in the title — this product has NO magnetic ring.`
	const descMagsafe = hasMagsafe
		? `Paragraph 2 (product uniqueness — material, clear back, artwork, AND the confirmed MagSafe ring);`
		: `Paragraph 2 (product uniqueness — material, design, artwork; this product has NO MagSafe — never mention MagSafe);`
	const tagsMagsafe = hasMagsafe
		? `the MagSafe tags "magsafe iphone case", "magsafe phone case", "magsafe case", `
		: `(this product has NO MagSafe — do NOT output any tag containing the word "magsafe"; use relevant aesthetic/character/accessory tags for those slots instead) `

	// Accessory paragraphs must mirror what's physically included.
	const gripPara = hasGrip
		? `Include ONE grip paragraph (a grip IS included).`
		: `Do NOT write a grip paragraph and never mention a grip/popsocket/ring holder — this product has NO grip.`
	const charmPara = hasCharm
		? `Include ONE charm paragraph (a charm IS included).`
		: `Do NOT write a charm paragraph and never mention a charm/beads/strap — this product has NO charm.`

	// "What's Included" must list EXACTLY the offered bundles — the operator's
	// enabled variation matrix, NOT the raw AI detection.
	// "What's Included" = the enabled canonical bundles PLUS any custom variation
	// values (custom are added on top, the buyer picks one from the whole set).
	const bundleLabels = enabledBundleLabels(enabledStyles)
	const customLabels = custom ? custom.map((s) => s.label) : []
	const allOffered = [...bundleLabels, ...customLabels]
	const offeredKeys = new Set(BUNDLE_ORDER.filter((k) => enabledStyles && enabledStyles[k]))
	const disabledNotes = BUNDLE_ORDER.filter((k) => !offeredKeys.has(k)).map((k) => `"${BUNDLE_DISPLAY[k]}"`)
	const bundlesClause = `"📦 What's Included" — list EXACTLY these ${allOffered.length} option(s) as bullets and NO others: ${allOffered.join(', ')}.${disabledNotes.length ? ` NEVER list any of these NOT-offered bundles: ${disabledNotes.join(', ')}.` : ''}`

	const universalTagList = (pt.universalTags || []).map((t) => `"${t}"`).join(', ')
	const deviceTagExamples = (pt.deviceTagExamples || []).map((t) => `"${t}"`).join(', ')

	return `OVERRIDE — TEXT-ONLY MODE: all image analysis was completed in Phase 1. Use the PRODUCT SUMMARY and PHASE 1 CLASSIFICATION facts in the user message directly. Trust them completely; never contradict them.

You are an elite, world-class Etsy SEO expert and top-tier seller of kawaii Y2K ${deviceNoun}s for the ${shopName} brand. Your priority is deeply researched, intensely SEO-driven listings that rank on page one.

SHOP BRAND TAGS (MANDATORY — include ALL of these exactly in your tags output): ${tagsDisplay}

Return ONLY a JSON object with keys: "title", "description", "tags", "primary_color", "secondary_color", "attributes".

${subjectClause}

TITLE (EXACTLY 130-140 chars — use the space, every char is SEO real estate): front-load the highest-volume buyer keywords first. Structure: [Subject = character OR specific design motif] [Primary Color] [MAGSAFE if confirmed] ${titleCaseNoun} [with Accessory], [Aesthetic] Cover for ${devicePhrase}, [Gift Intent] Gift. Lead with the SUBJECT defined above + "${deviceNoun}" / "${deviceShort}", then color, then aesthetics (Kawaii, Y2K, Coquette, Cute), then the device string. CRITICAL: the device coverage in the title MUST be EXACTLY "${devicePhrase}" — do NOT add model numbers that are not in that string (only the offered models are listed). Use natural buyer phrasing, not keyword soup. Only use each of % : & + at most once. ${titleMagsafe}

DESCRIPTION (minimum 500 words, keyword-rich but human and persuasive): start with an emoji + a desire hook line packed with the top keywords (the SUBJECT defined above — character OR specific design motif like "strawberry" — plus ${universalTagList || `"${deviceNoun}"`}, "Y2K aesthetic") — NOT a header. Then: Paragraph 1 (aesthetic & emotional desire — describe the actual design motifs by name, who it's for, the vibe, gift appeal); ${descMagsafe} ${gripPara} ${charmPara} Then sections: "✨ Key Features" (5-7 bullets, ONLY confirmed features — never list a grip, charm, or MagSafe feature that is not confirmed, each on its own line), ${compatClause}, ${bundlesClause}, "❤️ The ${shopName} Promise", and "🚚 Shipping & Processing" (ready to ship in 3-5 business days, worldwide tracked). Weave long-tail buyer phrases naturally throughout (e.g. "aesthetic ${deviceNoun}", "gift for her", character + "merch").

TAGS: EXACTLY 13 tags, each <=20 chars including spaces, all lowercase, MAXIMUM SEO coverage — every tag a distinct real buyer search term (no near-duplicates, no single repeated words across tags). Must include ALL brand tags above, the universal tags ${universalTagList || `"${deviceNoun}"`}, ${tagsMagsafe}two device model tags (e.g. ${deviceTagExamples || `"${deviceShort}"`}). Fill remaining slots with a SPREAD of: ${motifs.length ? `the SPECIFIC design motifs (${motifList}) as buyer phrases (e.g. "strawberry ${deviceNoun}"), ` : ''}the subject (character name OR design motif + " case"), the dominant aesthetic, the accessory (only if confirmed), a color term, and gift-intent ("gift for her", "bestie gift"). Prefer concrete motif/long-tail phrases over vague words like "cute character".

${attributesClause}

COLORS: primary_color and secondary_color MUST each be exactly one of: ${ETSY_COLORS.join(', ')}.

PROHIBITIONS: ${hasMagsafe ? '' : 'NEVER mention MagSafe in the title, description, or tags (not supported/ not detected). '}${hasGrip ? '' : 'NEVER mention a grip, popsocket, ring holder, "Case + Grip" or "Grip Only" anywhere (no grip). '}${hasCharm ? '' : 'NEVER mention a charm, beads, strap, "Case + Charm" or "Charm Only" anywhere (no charm detected). '}never claim MagSafe unless confirmed in Phase 1; never list device models not named above, and never list Samsung/Android; the Device Compatibility list must contain ONLY the compatible models named above; never fabricate accessories not confirmed in Phase 1; the "What's Included" bundle list must match exactly the offered bundles; never produce fewer or more than exactly 13 tags.`
}

// Bundle style metadata — the single source of truth for the "What's Included"
// section. The operator's enabledStyles map (the 6 variation toggles) drives
// the bundle list, the grip/charm paragraphs, AND the post-process filter, so the
// description ALWAYS matches the variation matrix the operator chose.
const BUNDLE_ORDER = ['Case+Grip+Charm', 'Case+Grip', 'Case+Charm', 'Case Only', 'Grip Only', 'Charm Only']
const BUNDLE_DISPLAY = {
	'Case+Grip+Charm': 'Full Set (Case + Grip + Charm)',
	'Case+Grip': 'Case + Grip',
	'Case+Charm': 'Case + Charm',
	'Case Only': 'Case Only',
	'Grip Only': 'Grip Only',
	'Charm Only': 'Charm Only',
}
const GRIP_STYLE_KEYS = ['Case+Grip', 'Grip Only', 'Case+Grip+Charm']
const CHARM_STYLE_KEYS = ['Case+Charm', 'Charm Only', 'Case+Grip+Charm']

function stylesHaveGrip(en) { return GRIP_STYLE_KEYS.some((k) => en && en[k]) }
function stylesHaveCharm(en) { return CHARM_STYLE_KEYS.some((k) => en && en[k]) }

/** Buyer-facing bundle labels for the enabled styles, in display order. */
function enabledBundleLabels(en) {
	return BUNDLE_ORDER.filter((k) => en && en[k]).map((k) => BUNDLE_DISPLAY[k])
}

/** Map a "What's Included" bullet's normalised label → its style key (or null). */
function bundleCoreToKey(core) {
	if (core === 'full set' || core === 'case+grip+charm') return 'Case+Grip+Charm'
	if (core === 'case+grip') return 'Case+Grip'
	if (core === 'case+charm') return 'Case+Charm'
	if (core === 'case only') return 'Case Only'
	if (core === 'grip only') return 'Grip Only'
	if (core === 'charm only') return 'Charm Only'
	return null
}

/**
 * Safety net: strip any "What's Included" bundle bullet whose style is NOT in the
 * enabled set, so the description can never contradict the operator's chosen
 * variation matrix even if the model ignores the prompt.
 */
function filterBundlesInDescription(description, enabledStyles) {
	if (!description) return description
	const en = enabledStyles || {}
	const lines = String(description).split('\n')
	const kept = lines.filter((line) => {
		const m = line.match(/^\s*[-•*]\s*(.+?)\s*$/)
		if (!m) return true
		const core = m[1]
			.split(/[-–—:(]/)[0]
			.toLowerCase()
			.replace(/\s*\+\s*/g, '+')
			.replace(/\s+/g, ' ')
			.trim()
		const key = bundleCoreToKey(core)
		if (key && !en[key]) return false // a recognised bundle that isn't offered
		return true
	})
	return kept.join('\n')
}

/**
 * The device string for the TITLE, derived from the enabled models. Product-type
 * aware (e.g. iPhone "iPhone 17 16 15 Pro Max"; AirPods "AirPods Pro 3 2 1 & AirPods 4 3 2 1").
 */
function titleDevicePhrase(enabledModels, productType) {
	return productTypes.titleDevicePhrase(productType, enabledModels)
}

/**
 * Rewrite the device model RANGE inside an existing title to match a new model
 * selection — WITHOUT re-running the AI. Only attempted for iPhone, whose title
 * carries a numeric "iPhone 17 16 …" run that is safe to swap; for other product
 * types (AirPods) the title is left untouched (regenerate copy to change it).
 */
function retitleForModels(title, enabledModels, productType) {
	if (!title) return title
	const pt = productTypes.getProductType(productType)
	if (pt.id !== 'iphone_case') return title
	const phrase = titleDevicePhrase(enabledModels, pt)
	const re = /iPhone(?:\s+\d+){1,6}(?:\s+Pro\s+Max|\s+Pro)?/gi
	let best = null
	let m
	while ((m = re.exec(title))) {
		const count = (m[0].match(/\d+/g) || []).length
		if (!best || count > best.count) best = { text: m[0], index: m.index, count }
	}
	if (!best) return title
	return title.slice(0, best.index) + phrase + title.slice(best.index + best.text.length)
}

/**
 * Safety net: strip any "Device Compatibility" bullet for a model that isn't
 * offered, so the description can never advertise an unavailable iPhone model.
 * Matches a bullet's leading label EXACTLY against a known model name (so
 * "iPhone 14" never accidentally removes "iPhone 14 Pro").
 */
function filterModelsInDescription(description, enabledModels, productType) {
	if (!description) return description
	const compat = new Set(compatibilityNamesFor(enabledModels, productType).map((n) => n.toLowerCase()))
	const known = new Set(allDescriptionNamesFor(productType).map((n) => n.toLowerCase()))
	const lines = String(description).split('\n')
	const kept = lines.filter((line) => {
		const m = line.match(/^\s*[-•*]\s*(.+?)\s*$/)
		if (!m) return true
		const core = m[1]
			.split(/[-–—:(]/)[0]
			.toLowerCase()
			.replace(/\s+/g, ' ')
			.trim()
		// Only act on lines that are exactly a known model bullet.
		if (!known.has(core)) return true
		return compat.has(core)
	})
	return kept.join('\n')
}

function buildPhase2User(meta, brandTags, imageAnalysis, productSummary, productType) {
	const pt = productTypes.getProductType(productType)
	const lines = [`Generate an SEO-optimized Etsy listing for this ${pt.deviceNoun} product.`, '', '=== PRODUCT FACTS ===', `Shop: ${meta.shopName || 'Y2KASEshop'}`, `Product type: Kawaii Y2K ${pt.deviceNoun} (possibly with accessories)`, `Material: ${(pt.materials || ['Silicone']).join(', ')}`]
	if (brandTags && brandTags.length) {
		lines.push(`BRAND IDENTITY TAGS (include ALL exactly as written): ${brandTags.map((t) => `"${t}"`).join(', ')}`)
	}
	if (productSummary) {
		const motifs = Array.isArray(productSummary.design_motifs) ? productSummary.design_motifs.filter(Boolean) : []
		lines.push(
			'',
			'=== PRODUCT SUMMARY (from Phase 1 vision — use directly) ===',
			`Character: ${productSummary.character_name || 'kawaii character'}`,
			`Design Subject (specific, non-character): ${productSummary.design_subject || ''}`,
			`Design Motifs: ${motifs.length ? motifs.join(', ') : '(none)'}`,
			`Design Aesthetic: ${productSummary.design_aesthetic || ''}`,
			`Primary Color: ${productSummary.case_primary_color || ''}`,
			`Secondary Color: ${productSummary.case_secondary_color || ''}`,
			`Design Features: ${productSummary.design_features || ''}`,
		)
	}
	if (imageAnalysis && imageAnalysis.length) {
		const hasGrip = imageAnalysis.some((i) => i.has_grip)
		const hasCharm = imageAnalysis.some((i) => i.has_charm)
		const hasMag = imageAnalysis.some((i) => i.has_magsafe_ring)
		const gripShapes = [...new Set(imageAnalysis.filter((i) => i.has_grip && i.grip_shape).map((i) => i.grip_shape))]
		lines.push('', '=== PHASE 1 CLASSIFICATION RESULTS (TRUST THESE) ===', `MagSafe ring detected: ${hasMag ? 'YES — include MAGSAFE in title and description' : 'NO — do NOT mention MagSafe anywhere'}`, `Grip accessory present: ${hasGrip ? 'YES' + (gripShapes.length ? ` — shape: ${gripShapes.join(', ')}` : '') : 'NO — omit grip paragraphs/features'}`, `Charm accessory present: ${hasCharm ? 'YES' : 'NO — omit charm paragraphs/features'}`)
	}
	lines.push('', 'Return ONLY the JSON object with keys: "title", "description", "tags", "primary_color", "secondary_color".')
	return lines.join('\n')
}

// ── Post-processing ───────────────────────────────────────────────────────────

function cleanTag(raw) {
	let t = String(raw || '')
		.trim()
		.toLowerCase()
	t = t.replace(/[^\w\s-]/g, '')
	t = t.replace(/\s+/g, ' ').trim()
	return t.slice(0, 20)
}

function ensureShopTags(tags, brandTags, hasMagsafe) {
	const coreBrand = (brandTags && brandTags.length ? brandTags : ['y2kase']).map((t) => t.slice(0, 20))
	const magsafe = ['magsafe iphone case', 'magsafe phone case', 'magsafe case']

	// When the case has NO magnetic ring, strip any MagSafe tag the model added so
	// the listing never advertises a feature the product doesn't have.
	let working = hasMagsafe ? tags : tags.filter((t) => !/magsafe/i.test(t))

	const requiredAll = hasMagsafe
		? [...coreBrand, ...magsafe.filter((m) => !coreBrand.includes(m))]
		: [...coreBrand]

	const set = new Set(working)
	const result = [...working]
	for (const req of requiredAll) {
		if (set.has(req)) continue
		if (result.length < 13) result.push(req)
		else {
			for (let i = result.length - 1; i >= 0; i--) {
				if (!requiredAll.includes(result[i])) {
					result[i] = req
					break
				}
			}
		}
		set.add(req)
	}
	return result.slice(0, 13)
}

function validateColor(raw) {
	if (!raw) return ''
	const clean = String(raw).trim().toLowerCase()
	const found = ETSY_COLORS.find((c) => c.toLowerCase() === clean)
	return found || ''
}

function postProcessTitle(rawTitle, hasMagsafe) {
	let title = String(rawTitle || '').trim()
	// Safety net: if no magnetic ring was detected, remove any MagSafe mention the
	// model slipped into the title, then tidy the resulting punctuation/spacing.
	if (!hasMagsafe) {
		title = title
			.replace(/\bmag[\s-]?safe\b/gi, '')
			.replace(/\s{2,}/g, ' ')
			.replace(/\s+,/g, ',')
			.replace(/,\s*,/g, ',')
			.replace(/^[\s,]+/, '')
			.trim()
	}
	if (title.length > 140) {
		title = title
			.slice(0, 140)
			.replace(/\s+\S*$/, '')
			.replace(/,+$/, '')
			.trim()
	}
	const subs = { '&': 'and', '+': 'and', '%': 'percent', ':': ',' }
	for (const [ch, repl] of Object.entries(subs)) {
		if (title.split(ch).length - 1 > 1) {
			const parts = title.split(ch)
			title = parts[0] + ch + parts.slice(1).join(` ${repl} `)
			title = title.replace(/\s+/g, ' ').trim()
		}
	}
	return title
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
	// textClient  → Phase 2 SEO copy only (GPT-5.4-mini / OpenAI)
	// visionClient → all image analysis  (Qwen / OpenRouter / DashScope, or same as text if no VISION_API_KEY)
	const textClient = getOpenAIClient()
	const visionClient = getVisionClient()
	const shopName = opts.shopName || 'Y2KASEshop'
	const brandTags = opts.brandTags || []
	const pt = productTypes.getProductType(opts.productType)
	// Analyse the first 12 photos for vision (character/accessory) — enough signal
	// without ballooning token cost. ALL of the product's images (up to 20, Etsy's
	// cap) are still uploaded to the listing by the create flow.
	const images = (product.images || []).slice(0, 12)
	if (!images.length) {
		const err = new Error(`No images for product "${product.name}" — cannot generate copy.`)
		err.status = 400
		throw err
	}

	// Phase 1 (with one retry on empty result)
	let phase1
	for (let attempt = 1; attempt <= 2; attempt++) {
		phase1 = await phase1Classify(visionClient, images, pt)
		if (phase1.imageAnalysis.length) break
	}
	const imageAnalysis = phase1.imageAnalysis
	const productSummary = phase1.productSummary

	// Character + accessory (grip/charm) + (for supported types) a dedicated
	// MagSafe pass run in parallel. Grip and MagSafe passes are skipped for
	// product types that don't support them (e.g. AirPods cases) — a charm
	// (keychain/clip) still applies, so the accessory pass always runs.
	const [character, accessories, magsafe] = await Promise.all([
		resolveCharacter(visionClient, { images, imageAnalysis, productSummary }),
		analyzeAccessories(visionClient, { images }).catch(() => null),
		pt.supportsMagsafe ? analyzeMagsafe(visionClient, { images }).catch(() => null) : Promise.resolve(null),
	])

	// Reconcile the noisy Phase-1 per-image grip/charm flags with the dedicated,
	// conservative accessory pass — this drives which style variations are offered.
	let hasGrip = imageAnalysis.some((i) => i.has_grip)
	let hasCharm = imageAnalysis.some((i) => i.has_charm)
	const accessory = { hasGrip, hasCharm, hasMagsafe: imageAnalysis.some((i) => i.has_magsafe_ring), gripConfidence: null, charmConfidence: null, magsafeConfidence: null, gripEvidence: '', charmEvidence: '', magsafeEvidence: '' }
	if (accessories) {
		// The dedicated grip/charm pass is authoritative for grip & charm — overwrite
		// the noisy Phase-1 per-image flags with its majority verdict.
		if (accessories.perImage && accessories.perImage.size) {
			for (const img of imageAnalysis) {
				const a = accessories.perImage.get(Number(img.index))
				if (a) {
					img.has_grip = a.has_grip
					img.has_charm = a.has_charm
				}
			}
		}
		hasGrip = accessories.hasGrip
		hasCharm = accessories.hasCharm
		accessory.hasGrip = hasGrip
		accessory.hasCharm = hasCharm
		accessory.gripConfidence = accessories.gripConfidence
		accessory.charmConfidence = accessories.charmConfidence
		accessory.gripEvidence = accessories.gripEvidence
		accessory.charmEvidence = accessories.charmEvidence
	}

	// Product types without a grip (e.g. AirPods cases) never offer one — force it
	// off so no grip copy/variation is ever produced.
	if (!pt.supportsGrip) {
		hasGrip = false
		accessory.hasGrip = false
		for (const img of imageAnalysis) img.has_grip = false
	}

	// MagSafe is decided SOLELY by the dedicated detector (most accurate). Apply its
	// verdict to every image flag so Phase-2 + attributes pick it up. Skipped
	// entirely for product types that don't support MagSafe.
	if (!pt.supportsMagsafe) {
		accessory.hasMagsafe = false
		for (const img of imageAnalysis) img.has_magsafe_ring = false
	} else if (magsafe) {
		accessory.hasMagsafe = magsafe.hasMagsafe
		accessory.magsafeConfidence = magsafe.confidence
		accessory.magsafeEvidence = magsafe.evidence
		for (const img of imageAnalysis) img.has_magsafe_ring = magsafe.hasMagsafe
	} else {
		// Detector failed entirely — fall back to the Phase-1 hint.
		accessory.hasMagsafe = imageAnalysis.some((i) => i.has_magsafe_ring)
	}

	// Safety net for the classic false-positive (a gripless, plain clear case whose
	// printed circle/camera gets mistaken for a ring): only override to FALSE when
	// there's NO grip AND the detector itself was not confident (<55). A confident
	// ring/text detection is always trusted, even without a grip.
	if (!hasGrip && accessory.hasMagsafe && (accessory.magsafeConfidence ?? 0) < 55) {
		accessory.hasMagsafe = false
		accessory.magsafeEvidence = `Overridden (low confidence ${accessory.magsafeConfidence ?? 0}% + no grip): treated as non-MagSafe.`
		for (const img of imageAnalysis) img.has_magsafe_ring = false
	}

	const enabledStyles = enabledStylesFor(hasGrip, hasCharm)
	// Model availability — defaults to all of the product type's models; an
	// operator override may be supplied (and will be re-applied on regenerate).
	const enabledModels = normaliseEnabledModels(opts.enabledModels, pt)

	// Feed the *resolved* character into Phase 2 so the copy uses it.
	productSummary.character_name = character.characterName
	productSummary.character_franchise = character.characterFranchise

	const copy = await runPhase2(textClient, { shopName, brandTags, imageAnalysis, productSummary, enabledStyles, enabledModels, attributeMenu: opts.attributeMenu, productType: pt })
	return {
		...copy,
		...character,
		enabledStyles,
		enabledModels,
		accessory,
		productType: pt.id,
		styleImageMapping: deriveStyleMapping(imageAnalysis),
		imageAnalysis,
		productSummary,
	}
}

/** Run the text-only Phase 2 (SEO copy) and post-process the result. */
async function runPhase2(client, { shopName, brandTags, imageAnalysis, productSummary, enabledStyles, enabledModels, attributeMenu, productType, customStyles }) {
	const pt = productTypes.getProductType(productType)
	const activeCustom = Array.isArray(customStyles) && customStyles.length ? customStyles : null
	const ia = Array.isArray(imageAnalysis) ? imageAnalysis : []
	const hasMagsafe = pt.supportsMagsafe && ia.some((i) => i.has_magsafe_ring)
	const models = normaliseEnabledModels(enabledModels, pt)
	// The OFFERED bundles (operator's matrix) are the source of truth for the
	// "What's Included" section + grip/charm copy. Fall back to AI detection only
	// when no explicit selection is supplied.
	const styles = (enabledStyles && Object.keys(enabledStyles).length)
		? normaliseEnabledStyles(enabledStyles)
		: enabledStylesFor(ia.some((i) => i.has_grip), ia.some((i) => i.has_charm))
	// Subject for the title: the licensed character if specific, else the concrete
	// design motif (strawberry, cherry, bow…) — never the vague word "Character".
	const subjectInfo = {
		characterName: productSummary.character_name || '',
		isGeneric: isGenericName(productSummary.character_name),
		designSubject: productSummary.design_subject || '',
		motifs: Array.isArray(productSummary.design_motifs) ? productSummary.design_motifs : [],
		aesthetic: productSummary.design_aesthetic || '',
	}
	const messages = [
		{ role: 'system', content: buildPhase2System(shopName, brandTags, hasMagsafe, styles, models, attributeMenu, subjectInfo, pt, activeCustom) },
		{ role: 'user', content: buildPhase2User({ shopName }, brandTags, imageAnalysis, productSummary, pt) },
	]
	const parsed = await callStructured(client, { messages, schema: PHASE2_SCHEMA, maxTokens: 16000 })
	let tags = (parsed.tags || []).map(cleanTag).filter(Boolean).slice(0, 13)
	tags = ensureShopTags(tags, brandTags, hasMagsafe)
	// Custom variations are added on top of the bundles, so the canonical bundle
	// filter still runs (it only strips NOT-offered canonical bundles; custom
	// labels never match a canonical key and pass through untouched).
	let description = filterBundlesInDescription(String(parsed.description || '').trim(), styles)
	description = filterModelsInDescription(description, models, pt)
	return {
		title: postProcessTitle(parsed.title, hasMagsafe),
		description,
		tags,
		aiAttributes: parsed.attributes || {},
		primaryColor: validateColor(parsed.primary_color) || validateColor(productSummary.case_primary_color),
		secondaryColor: validateColor(parsed.secondary_color) || validateColor(productSummary.case_secondary_color),
	}
}

/**
 * Regenerate the copy (Phase 2 only) from already-computed Phase 1 facts, with
 * an optional human-supplied character override. Used by the Inspector's
 * "correct character & regenerate" action — cheap (no vision re-classification).
 *
 * @param {object} args
 * @param {object[]} args.imageAnalysis     Phase 1 per-image facts (cached)
 * @param {object} args.productSummary      Phase 1 product summary (cached)
 * @param {string} [args.characterOverride] operator-corrected character name
 * @param {string} [args.shopName]
 * @param {string[]} [args.brandTags]
 * @returns {Promise<object>} same shape as generateListingCopy
 */
async function generateCopyFromAnalysis(args = {}) {
	const textClient = getOpenAIClient()
	const shopName = args.shopName || 'Y2KASEshop'
	const brandTags = args.brandTags || []
	const pt = productTypes.getProductType(args.productType)
	const imageAnalysis = args.imageAnalysis || []
	const productSummary = { ...(args.productSummary || {}) }

	let character
	if (args.characterOverride && String(args.characterOverride).trim()) {
		const norm = normaliseCharacter(args.characterOverride)
		character = {
			characterName: norm.name,
			characterDetected: norm.name,
			characterFranchise: norm.franchise || productSummary.character_franchise || '',
			characterConfidence: 100,
			characterEvidence: 'Manually set by operator.',
			characterAlternatives: [],
			characterVerified: true,
			characterLowConfidence: false,
		}
	} else {
		// images=[] so no actual vision API call is made here — textClient is fine
		character = await resolveCharacter(textClient, { images: [], imageAnalysis, productSummary })
	}

	productSummary.character_name = character.characterName
	productSummary.character_franchise = character.characterFranchise
	const enabledModels = normaliseEnabledModels(args.enabledModels, pt)
	// Operator's corrected style matrix drives the bundle list; fall back to AI.
	const enabledStyles = (args.enabledStyles && Object.keys(args.enabledStyles).length)
		? normaliseEnabledStyles(args.enabledStyles)
		: enabledStylesFor(pt.supportsGrip && imageAnalysis.some((i) => i.has_grip), imageAnalysis.some((i) => i.has_charm))
	const copy = await runPhase2(textClient, { shopName, brandTags, imageAnalysis, productSummary, enabledStyles, enabledModels, attributeMenu: args.attributeMenu, productType: pt, customStyles: args.customStyles })
	// Copy regeneration NEVER changes the variation-image links — preserve the
	// operator's saved mapping; only auto-derive when none was supplied.
	const styleImageMapping = (args.styleImageMapping && Object.keys(args.styleImageMapping).length)
		? args.styleImageMapping
		: deriveStyleMapping(imageAnalysis)
	const customStyles = Array.isArray(args.customStyles) && args.customStyles.length ? args.customStyles : null
	return { ...copy, ...character, enabledStyles, enabledModels, customStyles, productType: pt.id, styleImageMapping, imageAnalysis, productSummary }
}

module.exports = {
	generateListingCopy,
	generateCopyFromAnalysis,
	resolveCharacter,
	deriveStyleMapping,
	applyBooleanCorrection,
	filterModelsInDescription,
	retitleForModels,
	ETSY_COLORS,
	isReasoningModel,
}
