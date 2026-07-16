'use strict'

/**
 * AI buyer-message generator for fulfilment issues.
 *
 * When a line-item is put ON HOLD as a fulfilment exception (the product is out
 * of production, or the buyer's phone model is no longer available), the operator
 * must reach out to the buyer on Etsy to offer a design switch or a refund. Etsy
 * v3 has no messaging API, so the message is COPIED from the dashboard and pasted
 * into the Etsy conversation by hand.
 *
 * This module turns the order's own facts (buyer name, shop name, the exact
 * product title & variations, the issue type, and any operator note) into a
 * warm, professional, ready-to-send message — one that is unique and correct for
 * each individual order — replacing the old "type a prompt into Gemini and copy
 * the reply" workflow with a single click.
 *
 * It uses the buyer-message provider from listings/config — by default the same
 * OpenRouter provider the vision pipeline uses (Qwen: qwen/qwen3.7-plus), which
 * writes warm, natural copy cheaply — and returns guaranteed-shaped JSON through
 * Structured Outputs so the caller always receives a clean message string.
 */

const { config, hasBuyerMessageKey } = require('../listings/config')
const { checkMessageCompliance, complianceReason } = require('./message-compliance')

let _OpenAI = null

/**
 * Build the chat client for buyer messages. Points at the configured provider
 * (OpenRouter by default) with its base URL + optional attribution headers, and
 * adds transport resilience for third-party gateways (retries + a long timeout
 * for models that reason internally, like Qwen).
 */
function getMessageClient() {
	if (!hasBuyerMessageKey()) {
		const err = new Error('No API key is configured for buyer messages. Set VISION_API_KEY (OpenRouter) or OPENAI_API_KEY, or BUYER_MESSAGE_API_KEY, in the .env file.')
		err.status = 400
		throw err
	}
	if (!_OpenAI) _OpenAI = require('openai')
	const opts = { apiKey: config.buyerMessage.apiKey, maxRetries: 4, timeout: 120000 }
	if (config.buyerMessage.baseUrl) opts.baseURL = config.buyerMessage.baseUrl
	const extraHeaders = {}
	if (config.buyerMessage.referer) extraHeaders['HTTP-Referer'] = config.buyerMessage.referer
	if (config.buyerMessage.title) extraHeaders['X-Title'] = config.buyerMessage.title
	if (Object.keys(extraHeaders).length) opts.defaultHeaders = extraHeaders
	return new _OpenAI(opts)
}

/**
 * OpenAI reasoning models (gpt-5.*, o-series) take reasoning_effort, not
 * temperature. Qwen (and other non-OpenAI models) reason internally but do NOT
 * accept reasoning_effort — they use temperature like a standard model.
 */
function isReasoningModel(model) {
	if (/qwen/i.test(model || '')) return false
	return /^(gpt-5|o1|o3|o4)/.test(model || '')
}

// The one field we need back: the message body. Structured Outputs guarantees a
// clean string (no markdown fences, no prose wrapper) so the UI can show/copy it
// verbatim.
const MESSAGE_SCHEMA = {
	name: 'buyer_issue_message',
	strict: true,
	schema: {
		type: 'object',
		additionalProperties: false,
		properties: {
			message: { type: 'string' },
		},
		required: ['message'],
	},
}

/** Human labels + situation framing per issue type, fed to the model as facts. */
const ISSUE_FRAMING = {
	out_of_production: {
		label: 'out of production / discontinued',
		situation:
			'This design can no longer be produced because it has been discontinued by the manufacturer/supplier. ' +
			'Explain this briefly, honestly and professionally — do NOT fabricate specific false claims or over-explain. ' +
			'A simple, truthful "this design has been discontinued and we can no longer make it to our quality standard" ' +
			'is enough. Never blame the buyer.',
		offer:
			'Warmly offer the buyer TWO clear choices: (1) switch to another design from our shop that they love ' +
			'just as much (we will happily set it up for them at no extra cost), or (2) a full, no-questions refund.',
	},
	model_unavailable: {
		label: 'phone model no longer available for this design',
		situation:
			'We can no longer offer the specific phone model the buyer selected for this design. Briefly and ' +
			'professionally explain this (the model is no longer stocked/produced for this particular case). ' +
			'Never blame the buyer.',
		offer:
			'Warmly offer the buyer TWO clear choices: (1) switch to a different design that DOES fit their phone ' +
			'(we will set it up at no extra cost), or (2) a full refund.',
	},
	other: {
		label: 'fulfilment issue',
		situation:
			'We have run into a problem fulfilling this item exactly as it was ordered. Explain briefly and ' +
			'professionally, leaning on the operator note if one is provided. Never blame the buyer.',
		offer:
			'Warmly offer the buyer TWO clear choices: (1) switch to an alternative product, or (2) a full refund.',
	},
}

/** Take the buyer's first name for a natural greeting ("Angelique" from "Angelique Smith"). */
function firstName(name) {
	const n = String(name || '').trim()
	if (!n) return ''
	// Handles "First Last" and "Last, First"; falls back to the whole token.
	if (n.includes(',')) return n.split(',').pop().trim().split(/\s+/)[0]
	return n.split(/\s+/)[0]
}

/**
 * Build the system + user messages that turn one order's facts into a buyer
 * message. Every dynamic fact is passed as explicit context so the copy is
 * unique and correct per order.
 */
function buildMessages(ctx) {
	const shopName = (ctx.shopName || '').trim() || 'our shop'
	const buyer = firstName(ctx.buyerName)
	const type = ISSUE_FRAMING[ctx.issueType] ? ctx.issueType : 'other'
	const framing = ISSUE_FRAMING[type]
	const title = (ctx.productTitle || 'your item').trim()

	const facts = [
		`Shop name (sign the message as this brand's team): ${shopName}`,
		`Buyer's first name (greet them by this exact name; if blank, use "there"): ${buyer || '(unknown)'}`,
		`Product they ordered (refer to it naturally, you may shorten a very long title): "${title}"`,
		`Issue type: ${framing.label}`,
	]
	if (ctx.phoneModel) facts.push(`Buyer's selected phone model: ${ctx.phoneModel}`)
	if (ctx.style) facts.push(`Buyer's selected style/variation: ${ctx.style}`)
	// A replacement means the buyer ALREADY switched once, and the design they
	// chose (the title above) is now also unavailable. The message must own this
	// as a second, apologetic follow-up about THAT replacement — never re-mention
	// the original, and never imply we forgot the earlier conversation.
	if (ctx.isReplacement) facts.push(`IMPORTANT — this product is the REPLACEMENT design the buyer already agreed to switch to earlier; that replacement is now also unavailable. Warmly acknowledge that you're following up a second time about the design they chose, apologise a little extra for the repeat hiccup, and offer to switch it once more OR a full refund. Do NOT mention or name the original design they moved away from.`)
	if (ctx.note) facts.push(`Internal operator note (private context — use it to make the reason accurate, but NEVER quote it verbatim or reveal it is an internal note): ${ctx.note}`)
	if (ctx.extraInstructions) facts.push(`Extra instructions from the operator (follow these): ${ctx.extraInstructions}`)

	const tone = (ctx.tone || 'warm, sweet, sincere and professional').trim()

	const system =
		`You are a caring, professional customer-experience specialist writing on behalf of "${shopName}", ` +
		`a boutique Etsy shop selling kawaii / Y2K aesthetic phone cases and accessories. You write direct ` +
		`buyer messages that will be pasted into an Etsy conversation and sent to the customer.\n\n` +
		`GOAL: gently inform the buyer that the item they ordered cannot be fulfilled as-is, apologise sincerely, ` +
		`and offer them a design switch OR a full refund — making it effortless and pleasant for them to reply.\n\n` +
		`STYLE RULES:\n` +
		`• Tone: ${tone}. Sound like a real, thoughtful human — never robotic or corporate.\n` +
		`• Greet the buyer by their first name.\n` +
		`• Thank them warmly for their order and reference the specific product.\n` +
		`• Give a brief, honest, professional reason for the problem (see situation below). Never over-explain and never fabricate specific false claims.\n` +
		`• Clearly present the two options (switch design / full refund) and invite them to simply reply with their choice HERE in this Etsy conversation.\n` +
		`• Reassure them and apologise for the inconvenience without grovelling.\n` +
		`• Sign off warmly as the shop's team, e.g. "Warmly," then "The ${shopName} Team".\n` +
		`• Length: a concise but heartfelt message (roughly 120–220 words). Use short paragraphs.\n` +
		`• Plain text only — no markdown, no subject line, no placeholders like [Name] or [Product]; fill in every real detail from the facts. Do NOT invent an order number.\n\n` +
		`ETSY POLICY — HARD RULES (breaking ANY of these can get the shop permanently suspended, so NEVER do them):\n` +
		`• NEVER include or ask for an email address, phone number, or any off-Etsy messaging app (WhatsApp, Telegram, WeChat, Line, Instagram, Facebook, etc.).\n` +
		`• NEVER mention or request payment outside Etsy (PayPal, Venmo, Zelle, CashApp, Wise, bank/wire transfer, gift cards, crypto, "pay me directly").\n` +
		`• NEVER include an external website/store link or direct the buyer to buy anywhere other than through this Etsy shop. (An Etsy link is fine.)\n` +
		`• NEVER ask the buyer to cancel and repurchase elsewhere, or to move the conversation off Etsy.\n` +
		`• NEVER offer a discount/refund/gift in exchange for a review.\n` +
		`• Keep EVERYTHING — the refund, the design switch, and all communication — inside Etsy.\n\n` +
		`SITUATION: ${framing.situation}\n` +
		`OFFER: ${framing.offer}`

	const user =
		`Write the buyer message now using ONLY these order facts:\n\n${facts.join('\n')}\n\n` +
		`Return JSON: { "message": "<the full ready-to-send message>" }.`

	return [
		{ role: 'system', content: system },
		{ role: 'user', content: user },
	]
}

/** Strip any accidental code fence / prose wrapper and parse the JSON object. */
function extractJson(text) {
	let s = String(text || '').trim()
	const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
	if (fence) s = fence[1].trim()
	if (s[0] !== '{') {
		const a = s.indexOf('{')
		const b = s.lastIndexOf('}')
		if (a !== -1 && b > a) s = s.slice(a, b + 1)
	}
	return JSON.parse(s)
}

/**
 * Generate a ready-to-send buyer message for a fulfilment issue.
 *
 * @param {object} ctx
 * @param {string} ctx.shopName          the shop / brand name to sign as
 * @param {string} ctx.buyerName         the buyer's full name (first name is used)
 * @param {string} ctx.productTitle      the exact product title from the order
 * @param {string} ctx.issueType         'out_of_production' | 'model_unavailable' | 'other'
 * @param {string} [ctx.phoneModel]      buyer's selected phone model (model_unavailable)
 * @param {string} [ctx.style]           buyer's selected style/variation
 * @param {string} [ctx.note]            private operator note for accurate context
 * @param {string} [ctx.tone]            tone override
 * @param {string} [ctx.extraInstructions] free-form operator instructions
 * @param {boolean} [ctx.isReplacement]  true when productTitle is a replacement the
 *   buyer already switched to and which is now ALSO unavailable (a second follow-up)
 * @returns {Promise<{ message: string, model: string, compliance: object }>}
 */
async function generateBuyerIssueMessage(ctx = {}) {
	const client = getMessageClient()
	const model = config.buyerMessage.model
	const messages = buildMessages(ctx)

	const body = {
		model,
		messages,
		response_format: { type: 'json_schema', json_schema: MESSAGE_SCHEMA },
	}
	if (isReasoningModel(model)) {
		const effort = config.openai.reasoningEffort
		if (effort && effort !== 'default') body.reasoning_effort = effort
	} else {
		// A little warmth/variety so two orders never read identically.
		body.temperature = 0.8
	}

	const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
	const MAX_ATTEMPTS = 3
	let lastErr = null
	// Best clean draft seen so far, and the best (least-bad) draft overall as a
	// fallback for the error message. A model that slips policy content in once
	// usually clears on a retry, so we keep sampling until we get a clean one.
	let bestFlagged = null

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		let resp
		try {
			resp = await client.chat.completions.create(body)
		} catch (err) {
			lastErr = err
			const status = err.status || err.response?.status
			const transient =
				status === 408 || status === 409 || status === 429 || (status >= 500 && status < 600) ||
				/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network|timeout|aborted|Unexpected end of JSON/i.test(err.message || '')
			if (transient && attempt < MAX_ATTEMPTS) {
				await sleep(700 * attempt)
				continue
			}
			throw err
		}

		const content = resp.choices?.[0]?.message?.content
		if (content && content.trim()) {
			try {
				const parsed = extractJson(content)
				const message = String(parsed.message || '').trim()
				if (message) {
					// ── Compliance gate ──────────────────────────────────────────
					// Never return a draft that would violate Etsy's messaging policy
					// (off-Etsy contact / payment / links / steering). If the model
					// slipped something in, retry with a stronger constraint; only
					// after exhausting attempts do we refuse, so the operator never
					// unknowingly pastes suspension-triggering text into Etsy.
					const compliance = checkMessageCompliance(message)
					if (compliance.ok) return { message, model, compliance }

					if (!bestFlagged) bestFlagged = { message, compliance }
					console.warn(`[buyer-message] draft rejected by compliance guard (${complianceReason(compliance)}) — regenerating.`)
					// Tighten the instruction for the next attempt.
					messages.push({
						role: 'system',
						content:
							'Your previous draft violated Etsy policy by including one or more of: ' +
							compliance.violations.map((v) => v.category).join(', ') +
							'. Rewrite it so it contains NO email, phone, off-Etsy app, external link, off-Etsy payment, ' +
							'or any suggestion to move off Etsy. Keep everything inside Etsy.',
					})
					body.messages = messages
				}
			} catch (err) {
				lastErr = err
			}
		}
		if (attempt < MAX_ATTEMPTS) await sleep(700 * attempt)
	}

	if (bestFlagged) {
		const err = new Error(
			'The generated message kept including content that Etsy prohibits ' +
			`(${complianceReason(bestFlagged.compliance)}). To protect the shop, it was not returned. ` +
			'Please write the message manually, keeping all contact and payment inside Etsy.'
		)
		err.status = 422
		err.compliance = bestFlagged.compliance
		throw err
	}
	throw lastErr || new Error('The AI returned an empty message. Please try again.')
}

module.exports = { generateBuyerIssueMessage, firstName }
