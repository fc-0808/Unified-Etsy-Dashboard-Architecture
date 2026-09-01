'use strict'

/**
 * Centralised configuration for the Bulk Listing Creator feature.
 *
 * Reads from environment variables (.env at the project root). Loading dotenv
 * here makes every listings/* module self-sufficient when required outside the
 * server process (e.g. ad-hoc scripts or tests).
 */

const path = require('path')

try {
	require('dotenv').config({ quiet: true })
} catch {
	/* dotenv optional — env vars may be set by the shell/PM2 instead */
}

const PROJECT_ROOT = path.resolve(__dirname, '../../')

function bool(value, fallback) {
	if (value == null || value === '') return fallback
	return /^(1|true|yes|on)$/i.test(String(value).trim())
}

function int(value, fallback) {
	const n = parseInt(value, 10)
	return Number.isFinite(n) ? n : fallback
}

const config = {
	projectRoot: PROJECT_ROOT,

	openai: {
		// Text / SEO-copy model (Phase 2). Never sees images — keep it cheap.
		apiKey: process.env.OPENAI_API_KEY || '',
		model: process.env.OPENAI_MODEL || 'gpt-5.4-mini',

		// ── Vision provider (Phase 1 classify, character ID, accessory detect) ──
		// May point at a completely different provider (OpenRouter, DashScope, etc.).
		// Falls back to the main OpenAI key + default endpoint when not set.
		visionApiKey: process.env.VISION_API_KEY || process.env.OPENAI_API_KEY || '',
		visionBaseUrl: (process.env.VISION_BASE_URL || '').trim(),
		visionModel: process.env.OPENAI_VISION_MODEL || 'gpt-5.4',
		// Optional extra headers forwarded to the vision provider (e.g. OpenRouter attribution).
		visionReferer: (process.env.OPENROUTER_REFERER || '').trim(),
		visionTitle: (process.env.OPENROUTER_TITLE || '').trim(),

		// Image fidelity for the character-ID pass. "high" is a good default;
		// "original" = full-fidelity (more tokens) for tricky cases.
		visionDetail: (process.env.OPENAI_VISION_DETAIL || 'high').toLowerCase(),

		// Reasoning effort — only sent to OpenAI reasoning models (o-series, gpt-5.*).
		// Ignored automatically for Qwen / non-OpenAI models.
		reasoningEffort: (process.env.OPENAI_REASONING_EFFORT || 'low').toLowerCase(),

		// Output-token budget for the vision passes. 0 = send NO explicit cap (let
		// the provider use its default) — this avoids OpenRouter's upfront balance
		// check rejecting large max_tokens. When a cap IS set, a truncated response
		// (finish_reason=length) is retried with the budget doubled up to the ceiling.
		visionMaxTokens: int(process.env.OPENAI_VISION_MAX_TOKENS, 0),
		visionMaxTokensCeiling: int(process.env.OPENAI_VISION_MAX_TOKENS_CEILING, 16000),
	},

	// Listing-copy quality controls. The title is the single biggest SEO lever, so
	// it gets a dedicated design-analysis pass, an optional image-grounded copy
	// call, and a deterministic quality gate with a bounded repair loop. Every
	// stage can be switched off independently if a provider misbehaves.
	copy: {
		// Dedicated vision pass that extracts the concrete design fingerprint
		// (subject, motifs, art style, finish, printed text, buyer search phrases).
		// Without it the copy model only ever sees a thin generic summary.
		designAnalysis: bool(process.env.DESIGN_ANALYSIS, true),
		// How many artwork frames the design pass looks at. More frames = more
		// signal but a larger payload; 4 covers hero + backs + close-ups.
		designImages: Math.min(8, Math.max(1, int(process.env.DESIGN_ANALYSIS_IMAGES, 4))),

		// Show the copy model the hero photos as well as the extracted facts.
		//   auto — enable when the text model is known to accept images (default)
		//   on   — always attach (use when running a vision model for copy too)
		//   off  — never attach; rely on the design fingerprint alone
		// "auto"/"on" degrade to text-only automatically if the provider rejects
		// an image payload, so a misconfigured text model can never break a run.
		vision: (() => {
			const raw = (process.env.COPY_VISION || 'auto').trim().toLowerCase()
			return ['auto', 'on', 'off'].includes(raw) ? raw : 'auto'
		})(),

		// Deterministic gate: a title that does not reflect the real design is
		// rejected and rewritten with a specific critique before it can ship.
		titleGate: bool(process.env.TITLE_QUALITY_GATE, true),
		titleMinScore: Math.min(100, Math.max(0, int(process.env.TITLE_MIN_SCORE, 70))),
		titleRepairAttempts: Math.min(3, Math.max(0, int(process.env.TITLE_REPAIR_ATTEMPTS, 1))),
	},

	bulk: {
		// Every create is a draft. Activation is a separate reviewed transition;
		// an environment variable must never make new AI-generated copy go live.
		defaultState: 'draft',
		// How many products a run works on at once. The slow phase is the vision +
		// copy pass (~3 min/product, bound by the AI provider); the Etsy write phase
		// is serialised per shop by the runner's write lock, so raising this speeds
		// up generation without adding any burst pressure to the Etsy rate budget.
		// 3 keeps the AI phase the bottleneck — much higher and products just queue
		// behind the Etsy lock instead. Capped at 8 to bound memory (each worker
		// decodes up to 12 photos through sharp).
		concurrency: Math.min(8, Math.max(1, int(process.env.BULK_CONCURRENCY, 3))),
		restockQuantity: Math.max(0, int(process.env.BULK_RESTOCK_QUANTITY, 3)),
	},

	// Character identification tuning. A dedicated catalog-aware verification pass
	// double-checks the detected character; below the confidence floor we fall
	// back to a generic "kawaii character" rather than confidently mislabelling.
	character: {
		verify: bool(process.env.CHARACTER_VERIFY, true),
		confidenceFloor: Math.min(100, Math.max(0, int(process.env.CHARACTER_CONFIDENCE_FLOOR, 55))),
		// Self-consistency: how many independent identification samples to majority-
		// vote (only varies on non-reasoning models; reasoning models run once).
		samples: Math.min(5, Math.max(1, int(process.env.CHARACTER_SAMPLES, 3))),
	},

	pricingWorkbookPath: process.env.PRICING_WORKBOOK_PATH || path.join(PROJECT_ROOT, 'Y2KASE_Pricing_Master_4_Currencies.xlsx'),
}

// ── Buyer-message model (AI messages for on-hold / fulfilment-issue orders) ────
// These warm, human buyer messages are text-only and short, so they default to
// the SAME OpenRouter provider the vision pipeline uses (Qwen), which is cheap
// and writes natural copy. When no dedicated OpenRouter/vision provider is
// configured we fall back to the main OpenAI text model. Every part can be
// overridden independently with BUYER_MESSAGE_* env vars.
const _hasOpenRouter = Boolean((process.env.VISION_API_KEY || '').trim() && config.openai.visionBaseUrl)
config.buyerMessage = {
	model: process.env.BUYER_MESSAGE_MODEL
		|| (_hasOpenRouter ? (process.env.OPENAI_VISION_MODEL || 'qwen/qwen3.7-plus') : config.openai.model),
	apiKey: process.env.BUYER_MESSAGE_API_KEY
		|| (_hasOpenRouter ? config.openai.visionApiKey : config.openai.apiKey),
	baseUrl: (process.env.BUYER_MESSAGE_BASE_URL || (_hasOpenRouter ? config.openai.visionBaseUrl : '')).trim(),
	// OpenRouter attribution headers (shared with the vision provider config).
	referer: config.openai.visionReferer,
	title: config.openai.visionTitle,
}

/** @returns {boolean} true when an OpenAI key is configured */
function hasOpenAiKey() {
	return Boolean(config.openai.apiKey && config.openai.apiKey.trim())
}

/** @returns {boolean} true when a provider key for buyer messages is configured */
function hasBuyerMessageKey() {
	return Boolean(config.buyerMessage.apiKey && config.buyerMessage.apiKey.trim())
}

module.exports = { config, hasOpenAiKey, hasBuyerMessageKey, bool, int }
