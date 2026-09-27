'use strict'

/**
 * Deterministic Etsy SEO and content-quality guardrails.
 *
 * The copy model proposes language; this module owns marketplace constraints:
 *  - exactly 13 unique tags, each no longer than 20 characters;
 *  - a useful, product-first description rather than a padded word count;
 *  - two distinct valid taxonomy colours where evidence permits; and
 *  - accurate per-image alt text instead of duplicating the listing title.
 *
 * None of these helpers invent product claims. Their fallback vocabulary comes
 * from the product descriptor and vision facts that already ground the listing.
 */

const ETSY_TAG_COUNT = 13
const ETSY_TAG_MAX_LENGTH = 20
const ETSY_IMAGE_ALT_MAX_LENGTH = 500

function plain(value, max = Infinity) {
	return String(value == null ? '' : value)
		.replace(/[\u0000-\u001f\u007f]/g, ' ')
		.replace(/[<>]/g, '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, max)
		.trim()
}

/**
 * Etsy permits letters, numbers, spaces, apostrophes and hyphens in tags.
 * Truncate at a word boundary where possible so "apple watch accesso" never
 * becomes a buyer-facing search phrase.
 */
function cleanTag(raw) {
	let tag = plain(raw)
		.toLocaleLowerCase('en-US')
		.replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
		.replace(/\s+/g, ' ')
		.replace(/^[' -]+|[' -]+$/g, '')
		.trim()
	if (tag.length <= ETSY_TAG_MAX_LENGTH) return tag
	const clipped = tag.slice(0, ETSY_TAG_MAX_LENGTH + 1)
	const boundary = clipped.lastIndexOf(' ')
	tag = boundary >= 3 ? clipped.slice(0, boundary) : tag.slice(0, ETSY_TAG_MAX_LENGTH)
	return tag.replace(/^[' -]+|[' -]+$/g, '').trim()
}

function designTerms(design, productSummary) {
	const out = []
	const add = (value) => {
		const text = plain(value, 80)
		if (text && !out.some((item) => item.toLocaleLowerCase('en-US') === text.toLocaleLowerCase('en-US'))) out.push(text)
	}
	if (design) {
		add(design.subjectPrimary)
		add(design.subjectSecondary)
		for (const motif of design.motifs || []) add(motif && motif.term)
		for (const phrase of design.searchPhrases || []) add(phrase)
		for (const phrase of design.titleKeywords || []) add(phrase)
	}
	if (productSummary) {
		add(productSummary.design_subject)
		for (const motif of productSummary.design_motifs || []) add(motif)
	}
	return out
}

/**
 * Build a complete tag set from mandatory product vocabulary, the model's
 * suggestions, and concrete design facts. Priority is deliberate: a brand tag,
 * universal product phrases and device phrases can never be crowded out by 13
 * model-generated aesthetic variants.
 */
function finaliseSeoTags({
	generated = [],
	brandTags = [],
	productType,
	design,
	productSummary,
	primaryColor,
	secondaryColor,
	hasMagsafe = false,
} = {}) {
	const pt = productType || {}
	const tags = []
	const seen = new Set()
	const add = (raw) => {
		if (tags.length >= ETSY_TAG_COUNT) return
		const tag = cleanTag(raw)
		if (!tag) return
		const key = tag.toLocaleLowerCase('en-US')
		if (seen.has(key)) return
		seen.add(key)
		tags.push(tag)
	}

	for (const tag of brandTags.length ? brandTags : ['y2kase']) add(tag)
	for (const tag of pt.universalTags || []) add(tag)
	if (hasMagsafe && pt.supportsMagsafe) {
		for (const tag of ['magsafe iphone case', 'magsafe phone case', 'magsafe case']) add(tag)
	}
	for (const tag of pt.deviceTagExamples || []) add(tag)
	for (const tag of generated || []) {
		if (!hasMagsafe && /mag[\s-]?safe/i.test(String(tag || ''))) continue
		add(tag)
	}

	const noun = String(pt.deviceNoun || '').split(/\s+/).pop().toLowerCase() || 'accessory'
	const concrete = designTerms(design, productSummary)
	for (const term of concrete) {
		add(term)
		add(`${term} ${noun}`)
	}
	for (const color of [primaryColor, secondaryColor]) if (color) add(`${color} ${noun}`)
	for (const material of pt.materials || []) add(`${material} ${noun}`)
	for (const tag of pt.seoFallbackTags || []) add(tag)
	for (const tag of [
		pt.label,
		pt.deviceNoun,
		pt.deviceWord ? `${pt.deviceWord} accessory` : '',
		`${noun} accessory`,
	]) add(tag)

	return tags.slice(0, ETSY_TAG_COUNT)
}

function words(value) {
	return plain(value)
		.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []
}

function normalised(value) {
	return plain(value)
		.toLocaleLowerCase('en-US')
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim()
}

function containsMeaningfulTerm(haystack, term) {
	const haystackTokens = new Set(normalised(haystack).split(' ').filter(Boolean))
	const tokens = normalised(term).split(' ').filter((token) => token.length >= 3)
	return tokens.some((token) => haystackTokens.has(token))
}

/**
 * Audit conversion and search fundamentals. Word count is only a lower-bound
 * guard against empty boilerplate—there is intentionally no target near Etsy's
 * field limit and no reward for padding.
 */
function auditDescription(description, { productType, subject, design, productSummary } = {}) {
	const text = String(description || '').trim()
	const wordCount = words(text).length
	const firstSentence = text.split(/(?<=[.!?])\s+|\n+/)[0] || ''
	const issues = []
	const add = (code, message, fatal = true) => issues.push({ code, message, fatal })
	const pt = productType || {}

	if (!text) add('empty', 'Description is empty.')
	if (text && wordCount < 140) add('too_thin', `Description has only ${wordCount} words; it needs useful product, fit, material and ordering details.`)
	if (wordCount > 700) add('too_long', `Description has ${wordCount} words and is likely padded; shorten it for buyers.`)

	const itemTerms = [pt.deviceShort, pt.deviceNoun, pt.label].filter(Boolean)
	if (text && itemTerms.length && !itemTerms.some((term) => containsMeaningfulTerm(firstSentence, term))) {
		add('weak_opening', `The first sentence does not clearly identify the ${pt.deviceNoun || 'item'}.`)
	}

	const concrete = [subject, ...designTerms(design, productSummary)].filter(Boolean)
	if (text && concrete.length && !concrete.slice(0, 6).some((term) => containsMeaningfulTerm(firstSentence, term))) {
		add('generic_opening', 'The first sentence does not include the product’s strongest concrete design keyword.')
	}

	const requiredSections = [
		['key_features', /key\s+features/i, 'Key Features'],
		['compatibility', /device\s+compatibility/i, 'Device Compatibility'],
		['included', /what(?:'|’)?s\s+included/i, "What's Included"],
		['shipping', /shipping\s*(?:&|and)\s*processing/i, 'Shipping & Processing'],
	]
	for (const [code, pattern, label] of requiredSections) {
		if (text && !pattern.test(text)) add(`missing_${code}`, `Description is missing the “${label}” section.`)
	}

	const fatal = issues.some((issue) => issue.fatal)
	const score = Math.max(0, 100 - issues.reduce((sum, issue) => sum + (issue.fatal ? 18 : 6), 0))
	return {
		ok: !fatal,
		score,
		wordCount,
		firstSentence: plain(firstSentence, 320),
		issues,
		critique: issues.map((issue, index) => `${index + 1}. ${issue.message}`).join('\n'),
	}
}

function resolveListingColors(primary, secondary, summary, allowedColors) {
	const allowed = Array.isArray(allowedColors) ? allowedColors : []
	const get = (raw) => {
		const text = plain(raw).toLocaleLowerCase('en-US')
		return allowed.find((color) => color.toLocaleLowerCase('en-US') === text) || ''
	}
	const first = get(primary) || get(summary && summary.case_primary_color)
	const candidates = [
		get(secondary),
		get(summary && summary.case_secondary_color),
	].filter(Boolean)
	const second = candidates.find((color) => color !== first) || ''
	return { primaryColor: first, secondaryColor: second }
}

function linkedVariationLabel(copy, rank, productType) {
	for (const style of copy && Array.isArray(copy.customStyles) ? copy.customStyles : []) {
		if (Number(style.imageRank) === Number(rank) && style.label) return plain(style.label, 45)
	}
	for (const [key, ranks] of Object.entries((copy && copy.styleImageMapping) || {})) {
		if ((Array.isArray(ranks) ? ranks : [ranks]).some((value) => Number(value) === Number(rank))) {
			const style = (productType && productType.styles || []).find((entry) => entry && entry.key === key)
			return plain((style && style.label) || key, 45)
		}
	}
	return ''
}

/**
 * Accurate, rank-specific accessibility text. Etsy's own guidance explicitly
 * says not to paste the listing title/tags into alt text; each image should say
 * what that particular view contributes.
 */
function buildImageAltText(copy, image, productType) {
	const rank = Number(image && image.rank) || 1
	const pt = productType || {}
	const fact = (copy && Array.isArray(copy.imageAnalysis) ? copy.imageAnalysis : [])
		.find((entry) => Number(entry.index) === rank)
	const variation = linkedVariationLabel(copy, rank, pt)
	const factualView = plain(fact && fact.description, 380)
	const fallbackView = plain(
		(copy && copy.designAnalysis && copy.designAnalysis.visualSummary)
		|| (copy && copy.productSummary && copy.productSummary.design_features),
		360,
	)

	const parts = []
	if (variation) parts.push(`${variation} variation`)
	parts.push(factualView || fallbackView || `${pt.deviceNoun || 'Product'} view`)
	// Add a rank only when facts could otherwise repeat across several images.
	if (!factualView || rank > 1) parts.push(`photo ${rank}`)
	let result = plain(parts.join(' — '), ETSY_IMAGE_ALT_MAX_LENGTH)
	if (pt.deviceNoun && !normalised(result).includes(normalised(pt.deviceNoun))) {
		result = plain(`${pt.deviceNoun}: ${result}`, ETSY_IMAGE_ALT_MAX_LENGTH)
	}
	return result
}

module.exports = {
	cleanTag,
	finaliseSeoTags,
	auditDescription,
	resolveListingColors,
	buildImageAltText,
	ETSY_TAG_COUNT,
	ETSY_TAG_MAX_LENGTH,
	ETSY_IMAGE_ALT_MAX_LENGTH,
}
