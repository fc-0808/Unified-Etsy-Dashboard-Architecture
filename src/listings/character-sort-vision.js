'use strict'

/**
 * One cheap, catalog-grounded vision call for History character filing.
 *
 * This is NOT the listing-generation identify pass (5 images, high detail,
 * optional majority vote). Archive filing only needs the PRIMARY character
 * on the hero shot. One 768px JPEG + short JSON is the production envelope
 * Google / Pinterest style pipelines use after cheap signals fail.
 */

const fs = require('fs')
const path = require('path')
const { config } = require('./config')
const { catalogPromptBlock, normaliseCharacter, isGenericCharacterName } = require('./character-catalog')

const VISION_TIMEOUT_MS = 60000
const VISION_EDGE = 1280
const VISION_JPEG_QUALITY = 80
const MAX_TOKENS = 1200

const IDENTIFY_SCHEMA = {
	name: 'history_character_file',
	strict: true,
	schema: {
		type: 'object',
		additionalProperties: false,
		properties: {
			primary_character: { type: 'string' },
			primary_franchise: { type: 'string' },
			primary_confidence: { type: 'integer' },
			is_collage: { type: 'boolean' },
			is_original: { type: 'boolean' },
			reasoning: { type: 'string' },
		},
		required: ['primary_character', 'primary_franchise', 'primary_confidence', 'is_collage', 'is_original', 'reasoning'],
	},
}

let _OpenAI = null
let _sharp = null
let _sharpUnavailable = false

function getSharp() {
	if (_sharp || _sharpUnavailable) return _sharp
	try {
		_sharp = require('sharp')
	} catch {
		_sharpUnavailable = true
	}
	return _sharp
}

function visionEnabled() {
	return Boolean(String((config.openai && config.openai.visionApiKey) || '').trim())
}

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

async function encodeHero(imgPath, detail = 'high', edge = VISION_EDGE) {
	const sharp = getSharp()
	const longEdge = Math.min(1536, Math.max(512, Number(edge) || VISION_EDGE))
	if (sharp) {
		try {
			const jpeg = await sharp(imgPath, { failOn: 'none' })
				.rotate()
				.resize({ width: longEdge, height: longEdge, fit: 'inside', withoutEnlargement: true })
				.jpeg({ quality: VISION_JPEG_QUALITY, mozjpeg: true })
				.toBuffer()
			return {
				type: 'image_url',
				image_url: { url: 'data:image/jpeg;base64,' + jpeg.toString('base64'), detail },
			}
		} catch {
			/* fall through */
		}
	}
	const data = fs.readFileSync(imgPath)
	const ext = path.extname(imgPath).toLowerCase().replace('.', '')
	const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext || 'jpeg'}`
	return {
		type: 'image_url',
		image_url: { url: `data:${mime};base64,${data.toString('base64')}`, detail },
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

function unwrapObject(parsed) {
	if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
	if (Array.isArray(parsed)) {
		const objects = parsed.filter((row) => row && typeof row === 'object' && !Array.isArray(row))
		return objects[0] || {}
	}
	return {}
}

function buildPrompt(hint) {
	const hintLine = hint
		? `Folder-name hint (verify, do not trust blindly): ${hint}\n\n`
		: ''
	return (
		`Identify the PRIMARY third-party character printed on this product. Identification is a filing signal and does NOT imply a license.\n\n` +
		hintLine +
		`REFERENCE CATALOG:\n${catalogPromptBlock()}\n\n` +
		`Rules:\n` +
		`• primary_character = EXACT catalog name of the one dominant mascot. Empty / "kawaii character" if none.\n` +
		`• is_original = true only when the print is an original motif with NO recognizable licensed mascot.\n` +
		`• is_collage = true when many different mascots share the art equally. Then prefer a franchise theme ("Sanrio characters") if they share a house.\n` +
		`• primary_confidence is a brutal 0-100. Look-alikes (Miffy vs My Melody vs Molang; Cinnamoroll vs Pochacco; Kuromi vs My Melody; Rilakkuma vs Pompompurin) must stay below 70 unless the decisive cue is visible.\n` +
		`• Tamagotchi is an egg-shaped DEVICE with a screen, never a white animal. Pixel pets like Mametchi count as Tamagotchi.\n` +
		`• Judge the PRINTED ARTWORK, not the charm, grip, sticker sheet in the background, or a tag, unless that printed art is the product.\n` +
		`• reasoning: name the decisive cue you can actually see (ear length, hood colour, skull, x-shaped mouth, bow, zipper, pixel screen). Max 30 words.\n` +
		`Return JSON only.`
	)
}

async function callIdentify(client, { images, hint, edge, heroDetail }) {
	const list = (Array.isArray(images) ? images : []).filter((img) => img && img.path)
	if (!list.length) return null
	const content = [{ type: 'text', text: buildPrompt(hint) }]
	for (let i = 0; i < list.length; i++) {
		content.push({ type: 'text', text: i === 0 ? 'IMAGE 1 (hero / largest print):' : `IMAGE ${i + 1} (supporting):` })
		content.push(await encodeHero(list[i].path, i === 0 ? (heroDetail || 'high') : 'low', edge))
	}
	const model = (config.openai && config.openai.visionModel) || 'gpt-5.4'
	const messages = [
		{
			role: 'system',
			content: 'You file product photos into a licensed-character archive. Judge only visual evidence against the catalog. JSON only.',
		},
		{ role: 'user', content },
	]
	let parsed = null
	let lastErr = null
	for (let attempt = 1; attempt <= 3; attempt++) {
		const body = {
			model,
			messages,
			temperature: 0,
			max_tokens: MAX_TOKENS,
		}
		if (attempt < 3) body.response_format = { type: 'json_schema', json_schema: IDENTIFY_SCHEMA }
		else body.response_format = { type: 'json_object' }
		try {
			const resp = await client.chat.completions.create(body)
			const raw = contentText(resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content)
			if (!raw.trim()) {
				lastErr = new Error('empty vision response')
				continue
			}
			parsed = unwrapObject(JSON.parse(extractJson(raw)))
			break
		} catch (err) {
			lastErr = err
			const status = err.status || (err.response && err.response.status)
			if (status === 429 || (status >= 500 && status < 600)) {
				await new Promise((resolve) => setTimeout(resolve, 1500 * attempt))
			}
		}
	}
	if (!parsed) throw lastErr || new Error('vision returned no JSON')
	const name = String(parsed.primary_character || '').trim()
	const franchise = String(parsed.primary_franchise || '').trim()
	const confidence = Number(parsed.primary_confidence)
	const unnamed = !name || isGenericCharacterName(name)
	if (!Number.isFinite(confidence) || (confidence <= 0 && unnamed && parsed.is_original !== true)) {
		throw new Error('vision omitted a usable confidence')
	}
	const norm = normaliseCharacter(name)
	const generic = norm.generic === true || isGenericCharacterName(name) || parsed.is_original === true
	return {
		name: generic ? (parsed.is_original ? 'original' : name || 'kawaii character') : (norm.known ? norm.name : name),
		franchise: generic ? '' : (norm.franchise || franchise),
		known: Boolean(norm.known && !generic),
		generic,
		confidence: Math.max(0, Math.min(100, confidence)),
		isCollage: parsed.is_collage === true,
		isOriginal: parsed.is_original === true,
		reasoning: String(parsed.reasoning || '').slice(0, 400),
	}
}

/**
 * @param {Array<{path:string}>} images
 * @param {{ hint?: string, identify?: Function, client?: object }} [opts]
 */
async function identifyProduct(images, opts = {}) {
	const list = (Array.isArray(images) ? images : []).filter((img) => img && img.path)
	if (!list.length) return null
	if (typeof opts.identify === 'function') return opts.identify(list, opts.hint || '')
	const client = opts.client || liveClient()
	if (!client) {
		const err = new Error('Vision is not configured (VISION_API_KEY / OPENAI_API_KEY).')
		err.code = 'VISION_DISABLED'
		throw err
	}
	return callIdentify(client, {
		images: list,
		hint: opts.hint || '',
		edge: opts.edge,
		heroDetail: opts.heroDetail || 'high',
	})
}

module.exports = {
	IDENTIFY_SCHEMA,
	VISION_EDGE,
	identifyProduct,
	visionEnabled,
	liveClient,
}
