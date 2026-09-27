'use strict'

/**
 * Cost model for History visual search.
 *
 * The naive approach — send every History JPEG to a chat-vision model —
 * is how a demo looks impressive and a production bill explodes. Google
 * Lens / Pinterest / Amazon do not do that. They:
 *
 *   1. embed catalog images ONCE (dense vector index)
 *   2. embed the query once
 *   3. cosine / ANN retrieve a shortlist
 *   4. optionally LLM-rerank the top handful
 *
 * Rates below are list prices as of 2026-09 (Gemini Embedding 2 image
 * input ≈ $0.00012/image; Qwen 3.7 Plus via OpenRouter is typically
 * well under a cent per short rerank). They are a planning envelope,
 * not an invoice — the provider dashboard is authoritative.
 */

const EMBED_USD_PER_IMAGE = 0.00012
const RERANK_USD_PER_QUERY = 0.004
const NAIVE_VISION_USD_PER_IMAGE = 0.0025

function roundUsd(n) {
	const x = Number(n) || 0
	if (x === 0) return 0
	if (x < 0.01) return Math.round(x * 100000) / 100000
	return Math.round(x * 100) / 100
}

function estimateIndexCost({ pendingEmbed = 0, imagesPerFolder = 3, folders = 0 } = {}) {
	const pending = Math.max(0, Number(pendingEmbed) || 0)
	const full = Math.max(0, (Number(folders) || 0) * (Number(imagesPerFolder) || 0))
	return {
		usd_per_image: EMBED_USD_PER_IMAGE,
		pending_embed: pending,
		pending_embed_usd: roundUsd(pending * EMBED_USD_PER_IMAGE),
		full_reindex_usd: roundUsd(full * EMBED_USD_PER_IMAGE),
		hash_usd: 0,
	}
}

function estimateQueryCost({ rerank = false, catalogImages = 0 } = {}) {
	const embed = EMBED_USD_PER_IMAGE * 2
	const vision = rerank ? RERANK_USD_PER_QUERY : 0
	const naive = Math.max(0, Number(catalogImages) || 0) * NAIVE_VISION_USD_PER_IMAGE
	return {
		embed_usd: roundUsd(embed),
		rerank_usd: roundUsd(vision),
		typical_usd: roundUsd(embed + vision),
		naive_chat_vision_all_images_usd: roundUsd(naive),
		note: 'Typical query is one embed (+ optional top-K rerank). Naive chat-vision against the whole archive is listed only as a warning.',
	}
}

function publicEstimate({ folders, pendingEmbed, indexedImages, imagesPerFolder }) {
	const index = estimateIndexCost({ pendingEmbed, imagesPerFolder, folders })
	const query = estimateQueryCost({ rerank: true, catalogImages: indexedImages })
	const queryCheap = estimateQueryCost({ rerank: false, catalogImages: indexedImages })
	return {
		index,
		query_embed_only: queryCheap,
		query_with_rerank: query,
	}
}

module.exports = {
	EMBED_USD_PER_IMAGE,
	RERANK_USD_PER_QUERY,
	NAIVE_VISION_USD_PER_IMAGE,
	roundUsd,
	estimateIndexCost,
	estimateQueryCost,
	publicEstimate,
}
