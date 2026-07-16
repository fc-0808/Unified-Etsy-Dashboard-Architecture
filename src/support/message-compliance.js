'use strict'

/**
 * Etsy buyer-message compliance guard.
 *
 * Etsy's messaging policy prohibits specific content in buyer conversations —
 * off-platform contact info, off-Etsy payment requests, external links, and
 * review-for-discount exchanges. A message containing any of these can trigger
 * an immediate shop suspension.
 *
 * This module scans a generated message text against those hard rules before
 * it is ever returned to the operator, so no prohibited content is accidentally
 * pasted into an Etsy conversation.
 */

/**
 * @typedef {'off_platform_contact' | 'off_etsy_payment' | 'external_link' | 'off_etsy_redirect' | 'review_manipulation'} ViolationCategory
 * @typedef {{ category: ViolationCategory, description: string, matched: string }} Violation
 * @typedef {{ ok: boolean, violations: Violation[] }} ComplianceResult
 */

/** Patterns that detect off-Etsy contact info (email, phone, external apps). */
const OFF_PLATFORM_CONTACT = [
	{
		// Email addresses
		re: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/,
		description: 'email address',
	},
	{
		// Phone numbers (loose: digit groups with separators)
		re: /(?:\+?\d[\d\s\-().]{7,}\d)/,
		description: 'phone number',
	},
	{
		// Common off-Etsy messaging apps
		re: /\b(whatsapp|wechat|we\s*chat|telegram|viber|line\s+app|instagram\s+dm|facebook\s+messenger|messenger|snapchat|signal|kik|skype|discord)\b/i,
		description: 'off-Etsy messaging app',
	},
]

/** Patterns that detect off-Etsy payment methods. */
const OFF_ETSY_PAYMENT = [
	{
		re: /\b(paypal|venmo|zelle|cashapp|cash\s*app|wise|transferwise|western\s+union|moneygram|bank\s+transfer|wire\s+transfer|direct\s+deposit|gift\s+card|google\s+pay|apple\s+pay|crypto|bitcoin|ethereum|usdt|binance|coinbase)\b/i,
		description: 'off-Etsy payment method',
	},
	{
		re: /\b(pay\s+(me|us)\s+(directly|outside|off(\s+of)?\s+etsy))\b/i,
		description: 'request to pay outside Etsy',
	},
]

/** Patterns that detect external website links. */
const EXTERNAL_LINK = [
	{
		// URLs that aren't etsy.com
		re: /https?:\/\/(?!(?:www\.)?etsy\.com)[^\s"'>]+/i,
		description: 'external website link',
	},
	{
		// Bare domain-like references to competitor / external stores
		re: /\b(?:amazon|ebay|shopify|aliexpress|alibaba|temu|shein|wish\.com|depop|poshmark)\b/i,
		description: 'external marketplace reference',
	},
]

/** Patterns that detect steering buyers off Etsy. */
const OFF_ETSY_REDIRECT = [
	{
		re: /\b(contact\s+us\s+(at|via|through|on|by)\s+(?!etsy))/i,
		description: 'off-Etsy contact instruction',
	},
	{
		re: /\b(message\s+us\s+(at|via|through|on|by)\s+(?!etsy))/i,
		description: 'off-Etsy message instruction',
	},
	{
		re: /\b(cancel\s+(your\s+)?order\s+and\s+(re-?purchase|buy|order)\s+(elsewhere|outside|off\s+etsy))\b/i,
		description: 'instruction to cancel and repurchase off Etsy',
	},
	{
		re: /\b(move\s+(the\s+)?(conversation|chat|discussion|order)\s+(off|outside|away\s+from)\s+etsy)\b/i,
		description: 'instruction to move conversation off Etsy',
	},
	{
		re: /\b(reach\s+out\s+to\s+us\s+(at|via|through|by)\s+(?!etsy|this|here|the\s+shop))/i,
		description: 'off-Etsy contact redirect',
	},
]

/** Patterns that detect review-for-incentive exchanges (policy violation). */
const REVIEW_MANIPULATION = [
	{
		re: /\b(discount|refund|gift|coupon|credit|cashback|store\s+credit|compensation|reward)\b.*\b(review|feedback|star|rating)\b/i,
		description: 'discount/gift offered in exchange for a review',
	},
	{
		re: /\b(review|feedback|star|rating)\b.*\b(discount|refund|gift|coupon|credit|cashback|reward)\b/i,
		description: 'review solicited with an incentive',
	},
	{
		re: /\bleave\s+(us\s+)?(a\s+)?(5[\-\s]?star|five[\-\s]?star|positive|good)\s+(review|feedback|rating)\b/i,
		description: 'solicitation for a specific star rating',
	},
]

const RULE_GROUPS = [
	{ category: 'off_platform_contact', patterns: OFF_PLATFORM_CONTACT },
	{ category: 'off_etsy_payment', patterns: OFF_ETSY_PAYMENT },
	{ category: 'external_link', patterns: EXTERNAL_LINK },
	{ category: 'off_etsy_redirect', patterns: OFF_ETSY_REDIRECT },
	{ category: 'review_manipulation', patterns: REVIEW_MANIPULATION },
]

/**
 * Scan a generated buyer message for Etsy policy violations.
 *
 * @param {string} text  The raw message text to check.
 * @returns {ComplianceResult}
 */
function checkMessageCompliance(text) {
	const message = String(text || '')
	const violations = []

	for (const { category, patterns } of RULE_GROUPS) {
		for (const { re, description } of patterns) {
			const m = message.match(re)
			if (m) {
				violations.push({
					category,
					description,
					matched: m[0].length > 80 ? m[0].slice(0, 80) + '…' : m[0],
				})
				break // one violation per category is enough to flag it
			}
		}
	}

	return { ok: violations.length === 0, violations }
}

/**
 * Produce a short human-readable summary of why a message failed compliance.
 * Used in log warnings and error messages so the operator knows what went wrong.
 *
 * @param {ComplianceResult} compliance
 * @returns {string}
 */
function complianceReason(compliance) {
	if (!compliance || compliance.ok || !compliance.violations?.length) {
		return 'no violations'
	}
	return compliance.violations.map((v) => v.description).join('; ')
}

module.exports = { checkMessageCompliance, complianceReason }
