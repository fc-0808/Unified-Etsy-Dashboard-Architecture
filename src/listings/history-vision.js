'use strict'

/**
 * Optional chat-vision rerank for History folder shortlists.
 *
 * This is the LAST, paid, step of History locate — never the index.
 * The query plus at most RERANK_CAP hero thumbnails go to the same
 * VISION_API_KEY / OpenAI-compatible provider the rest of listings uses.
 * Tests inject `{ rerank }` and never hit the network.
 */

const { config } = require('./config')
const vision = require('../route/find-by-photo-vision')

const RERANK_MAX_TOKENS = 400
const VISION_TIMEOUT_MS = 35000

const RERANK_SCHEMA = {
	name: 'history_folder_rerank',
	strict: true,
	schema: {
		type: 'object',
		additionalProperties: false,
		properties: {
			matches: {
				type: 'array',
				items: {
					type: 'object',
					additionalProperties: false,
					properties: {
						index: { type: 'integer' },
						confidence: { type: 'integer' },
						same_print: { type: 'boolean' },
						reason: { type: 'string' },
					},
					required: ['index', 'confidence', 'same_print', 'reason'],
				},
			},
		},
		required: ['matches'],
	},
}

let _OpenAI = null

function liveClient() {
	const key = String((config.openai && config.openai.visionApiKey) || '').trim()
	if (!key) return null
	if (!_OpenAI) _OpenAI = require('openai')
	const opts = { apiKey: key, maxRetries: 0, timeout: VISION_TIMEOUT_MS }
	const baseURL = String((config.openai && config.openai.visionBaseUrl) || '').trim()
	if (baseURL) opts.baseURL = baseURL
	const extraHeaders = {}
	if (config.openai.visionReferer) extraHeaders['HTTP-Referer'] = config.openai.visionReferer
	if (config.openai.visionTitle) extraHeaders['X-Title'] = config.openai.visionTitle
	if (Object.keys(extraHeaders).length) opts.defaultHeaders = extraHeaders
	return new _OpenAI(opts)
}

function imagePart(jpeg) {
	return {
		type: 'image_url',
		image_url: { url: 'data:image/jpeg;base64,' + jpeg.toString('base64'), detail: 'low' },
	}
}

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

function contentText(content) {
	if (typeof content === 'string') return content
	if (Array.isArray(content)) {
		return content
			.map((part) => (part && typeof part.text === 'string' ? part.text : ''))
			.join('\n')
	}
	return ''
}

function rerankPrompt(candidates) {
	const lines = candidates.map((row, i) => `${i + 1}. ${row.product_key || row.title || 'folder'} (${row.shop || '?'})`)
	return `LEFT/first image is the QUERY product photo.
The numbered images that follow are HERO shots from already-listed product folders in Listing History.

Match the PRINTED ARTWORK (character layout, bumper colour, collage vs single motif, any printed logo).
Lighting, phone model, MagSafe ring, grip/charm, and background WILL differ. That is not a mismatch.
Same character franchise is NOT enough. A yellow duck AirPods case is not a yellow chick iPhone case.
Return JSON matches for every candidate that is the SAME physical product. Empty matches if none match.

Candidates:
${lines.join('\n')}`
}

async function callRerank(client, { queryJpeg, candidates }) {
	const useModel = config.openai.visionModel || 'gpt-5.4'
	const content = [{ type: 'text', text: rerankPrompt(candidates) }, imagePart(queryJpeg)]
	for (let i = 0; i < candidates.length; i++) {
		if (!candidates[i].jpeg) continue
		content.push({ type: 'text', text: `Candidate ${i + 1}` })
		content.push(imagePart(candidates[i].jpeg))
	}
	const body = {
		model: useModel,
		messages: [
			{
				role: 'system',
				content:
					'You match a product photo to archive folder hero shots by printed artwork. Same character is not the same product. JSON only.',
			},
			{ role: 'user', content },
		],
		response_format: { type: 'json_object' },
		temperature: 0,
		max_tokens: RERANK_MAX_TOKENS,
	}
	const resp = await client.chat.completions.create(body)
	const raw = contentText(resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content)
	const parsed = JSON.parse(extractJson(raw))
	return Array.isArray(parsed && parsed.matches) ? parsed.matches : []
}

async function rerankFolders(queryJpeg, candidates, opts = {}) {
	const list = (Array.isArray(candidates) ? candidates : []).filter((row) => row && row.jpeg && row.jpeg.length)
	if (!queryJpeg || !list.length) return []
	if (typeof opts.rerank === 'function') return opts.rerank(list, queryJpeg)
	const client = opts.client || liveClient()
	if (!client) return []
	try {
		return await callRerank(client, { queryJpeg, candidates: list })
	} catch {
		return []
	}
}

module.exports = {
	RERANK_SCHEMA,
	rerankFolders,
	liveClient,
	visionEnabled: () => vision.visionIsEnabled(),
}
