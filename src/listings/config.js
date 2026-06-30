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
	require('dotenv').config()
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
	},

	bulk: {
		defaultState: (process.env.LISTING_DEFAULT_STATE || 'draft').toLowerCase() === 'published' ? 'published' : 'draft',
		concurrency: Math.max(1, int(process.env.BULK_CONCURRENCY, 1)),
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

/** @returns {boolean} true when an OpenAI key is configured */
function hasOpenAiKey() {
	return Boolean(config.openai.apiKey && config.openai.apiKey.trim())
}

module.exports = { config, hasOpenAiKey, bool, int }
