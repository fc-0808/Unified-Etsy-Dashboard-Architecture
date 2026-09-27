'use strict'

/**
 * Read a WeChat 账单 screenshot with the same vision provider the listing
 * pipeline already uses (VISION_API_KEY / OpenAI). The model only transcribes
 * visible rows. Classification — keep the ¥888 wires, drop the rest — lives in
 * wechat-bill.js so tests never need a network and a prompt tweak cannot
 * silently change what counts as COGS.
 */

const BILL_SCHEMA = {
	name: 'wechat_bill_rows',
	strict: true,
	schema: {
		type: 'object',
		additionalProperties: false,
		properties: {
			rows: {
				type: 'array',
				items: {
					type: 'object',
					additionalProperties: false,
					properties: {
						title: { type: 'string' },
						amount: { type: 'string' },
						local_datetime: { type: 'string' },
						counterparty: { type: 'string' },
					},
					required: ['title', 'amount', 'local_datetime', 'counterparty'],
				},
			},
		},
		required: ['rows'],
	},
}

const SYSTEM_PROMPT = `You transcribe WeChat Pay / 微信支付 / 微信账单 screenshots for bookkeeping.

Return JSON only. Copy every visible transfer row top-to-bottom. Do not invent rows, do not drop rows, do not translate Chinese, do not round amounts.

For each row:
- title: the full grey caption exactly as shown, e.g. "转账-来自Walter" or "转账-转给天生好运甜美鱼"
- amount: the signed amount exactly as shown, including + or − and two decimals, e.g. "+888.00" or "-22.00"
- local_datetime: the date/time under the title, preserving Chinese format when that is what the screenshot uses, e.g. "2026年9月11日 17:54"
- counterparty: the person named in the title (Walter, 天生好运甜美鱼, …), or "" if none

Ignore the search box, the clock, battery, and the word 取消. If a row is truncated or unreadable, omit it rather than guessing.`

function extractJson(text) {
	const raw = String(text || '').trim()
	const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
	const body = fenced ? fenced[1].trim() : raw
	const start = body.indexOf('{')
	const end = body.lastIndexOf('}')
	if (start < 0 || end <= start) {
		throw new Error('Vision response did not contain a JSON object.')
	}
	return JSON.parse(body.slice(start, end + 1))
}

function sniffImageMime(buf) {
	if (!Buffer.isBuffer(buf) || buf.length < 12) return null
	if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
	if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
	if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
	if (buf.toString('ascii', 0, 3) === 'GIF') return 'image/gif'
	if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') {
		const brand = buf.toString('ascii', 8, 12)
		if (brand.startsWith('avif') || brand.startsWith('avis')) return 'image/avif'
	}
	return null
}

function decodeBase64Image(b64, mimeHint) {
	let mime = String(mimeHint || '')
		.split(';', 1)[0]
		.trim()
		.toLowerCase()
	if (!b64 || typeof b64 !== 'string') return { data: null, mime: mime || '' }
	let raw = b64.trim()
	const dataUrl = /^data:([^;]+);base64,(.+)$/i.exec(raw)
	if (dataUrl) {
		mime = mime || String(dataUrl[1] || '')
			.split(';', 1)[0]
			.trim()
			.toLowerCase()
		raw = dataUrl[2]
	}
	let data
	try {
		data = Buffer.from(raw, 'base64')
	} catch {
		return { data: null, mime: mime || '' }
	}
	if (!data.length) return { data: null, mime: mime || '' }
	const sniffed = sniffImageMime(data)
	return { data, mime: sniffed || mime || 'image/jpeg' }
}

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

async function encodeImagePart(buffer, mime, detail) {
	const sharp = getSharp()
	if (sharp) {
		try {
			const jpeg = await sharp(buffer, { failOn: 'none' })
				.rotate()
				.resize({ width: 1536, height: 1536, fit: 'inside', withoutEnlargement: true })
				.jpeg({ quality: 88, mozjpeg: true })
				.toBuffer()
			return {
				type: 'image_url',
				image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}`, detail: detail || 'high' },
			}
		} catch {
			/* fall through */
		}
	}
	const safeMime = mime || 'image/jpeg'
	return {
		type: 'image_url',
		image_url: { url: `data:${safeMime};base64,${buffer.toString('base64')}`, detail: detail || 'high' },
	}
}

function visionConfig() {
	const { config } = require('../listings/config')
	return config.openai
}

function hasVisionKey() {
	try {
		const openai = visionConfig()
		return Boolean((openai.visionApiKey || openai.apiKey || '').trim())
	} catch {
		return false
	}
}

function getVisionClient() {
	const openai = visionConfig()
	const key = (openai.visionApiKey || openai.apiKey || '').trim()
	if (!key) {
		const error = new Error('VISION_API_KEY is not set. Add it to the .env file to read WeChat bill screenshots.')
		error.status = 503
		error.code = 'GOODS_FLOAT_VISION_UNAVAILABLE'
		throw error
	}
	const OpenAI = require('openai')
	const opts = { apiKey: key, maxRetries: 3, timeout: 120000 }
	if (openai.visionBaseUrl) opts.baseURL = openai.visionBaseUrl
	const extraHeaders = {}
	if (openai.visionReferer) extraHeaders['HTTP-Referer'] = openai.visionReferer
	if (openai.visionTitle) extraHeaders['X-Title'] = openai.visionTitle
	if (Object.keys(extraHeaders).length) opts.defaultHeaders = extraHeaders
	return { client: new OpenAI(opts), openai }
}

function isSchemaUnsupported(error) {
	const body = String(error && (error.message || error.error?.message) || '')
	const status = error && (error.status || error.response?.status)
	return status === 400 && /json_schema|response_format|unrecognized/i.test(body)
}

async function completeJson(client, { model, messages, maxTokens }) {
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
	const formats = [
		{ response_format: { type: 'json_schema', json_schema: BILL_SCHEMA } },
		{ response_format: { type: 'json_object' } },
	]
	let lastErr = null
	for (const format of formats) {
		for (let attempt = 1; attempt <= 3; attempt++) {
			try {
				const body = { model, messages, temperature: 0, ...format }
				if (Number.isFinite(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens
				const resp = await client.chat.completions.create(body)
				const content = resp.choices?.[0]?.message?.content
				if (!content || !String(content).trim()) {
					throw new Error('Vision model returned an empty response.')
				}
				const parsed = extractJson(content)
				const rows = Array.isArray(parsed.rows) ? parsed.rows : []
				return { rows, model, usage: resp.usage || null }
			} catch (error) {
				lastErr = error
				if (format.response_format.type === 'json_schema' && isSchemaUnsupported(error)) break
				const status = error.status || error.response?.status
				const transient =
					/ECONNRESET|ETIMEDOUT|ENOTFOUND|timeout|aborted|Unexpected end of JSON/i.test(error.message || '') ||
					status === 429 ||
					(status >= 500 && status < 600)
				if (transient && attempt < 3) {
					await sleep(700 * attempt)
					continue
				}
				if (format.response_format.type === 'json_schema') break
				throw error
			}
		}
	}
	throw lastErr || new Error('Vision model could not transcribe the WeChat bill screenshot.')
}

async function extractBillRows({ buffer, mime, detail } = {}) {
	if (!Buffer.isBuffer(buffer) || !buffer.length) {
		const error = new Error('A WeChat bill screenshot is required.')
		error.status = 400
		error.code = 'INVALID_GOODS_FLOAT_IMAGE'
		throw error
	}
	const { client, openai } = getVisionClient()
	const image = await encodeImagePart(buffer, mime, detail || openai.visionDetail)
	const maxTokens = openai.visionMaxTokens > 0 ? Math.min(4000, openai.visionMaxTokens) : 4000
	return completeJson(client, {
		model: openai.visionModel,
		maxTokens,
		messages: [
			{ role: 'system', content: SYSTEM_PROMPT },
			{
				role: 'user',
				content: [
					{
						type: 'text',
						text: 'Transcribe every transfer row visible in this WeChat 账单 screenshot.',
					},
					image,
				],
			},
		],
	})
}

module.exports = {
	BILL_SCHEMA,
	sniffImageMime,
	decodeBase64Image,
	encodeImagePart,
	hasVisionKey,
	extractBillRows,
	extractJson,
}
