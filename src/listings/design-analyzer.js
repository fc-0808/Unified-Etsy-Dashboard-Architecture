'use strict'

/**
 * Dedicated "design fingerprint" vision pass for the Bulk Listing Creator.
 *
 * WHY THIS EXISTS
 * ---------------
 * Phase 1 (`phase1Classify`) is a QA pass: its real job is per-image grip /
 * charm / MagSafe / edge booleans across up to 12 photos. Design description
 * was bolted onto the end of that prompt as two fields, at temperature 0, in a
 * call already juggling twenty other instructions. Predictably the model spent
 * its attention on the booleans and returned thin, generic design signal — so
 * the text-only copywriter downstream had nothing to work with and fell back on
 * shop-level boilerplate ("Kawaii Y2K … Cute Aesthetic Cover"), which is
 * identical for every product and therefore ranks for nothing.
 *
 * This module gives the artwork its own focused, high-fidelity look. It reads
 * only the frames that actually show the printed design, and it is graded on
 * one thing: producing terms that could ONLY describe this product. Its output
 * is the ground truth the title is written from and later scored against.
 *
 * It is deliberately a separate call rather than more fields on Phase 1:
 * focused prompts beat omnibus prompts, it can run in parallel with the
 * character/accessory passes at no wall-clock cost, and its result is cached
 * per item so regenerating copy never re-pays for it.
 */

const { config } = require('./config')
const productTypes = require('./product-types')
const { classify, tokenise, isPlaceholder } = require('./title-quality')

// Terms that describe nothing. The prompt forbids them and the sanitiser below
// enforces that ban, because "be specific" instructions are advisory but a
// post-filter is not.
const BANNED_TERMS = [
	'kawaii', 'cute', 'aesthetic', 'y2k', 'trendy', 'girly', 'chic', 'stylish', 'cool', 'pretty',
	'lovely', 'adorable', 'beautiful', 'nice', 'unique', 'design', 'pattern', 'print', 'graphic',
	'character', 'phone case', 'case', 'cover', 'gift', 'art', 'artwork', 'style', 'theme', 'motif',
]

const DESIGN_SCHEMA = {
	name: 'design_fingerprint',
	strict: true,
	schema: {
		type: 'object',
		additionalProperties: false,
		properties: {
			// A plain-language account of what is literally on the case. This is the
			// anchor: every other field must be consistent with it.
			visual_summary: { type: 'string' },
			// The one thing a shopper would point at and name. 1-3 words, Title Case.
			subject_primary: { type: 'string' },
			subject_secondary: { type: 'string' },
			// Every distinct depicted element, ranked 1-10 by visual prominence.
			motifs: {
				type: 'array',
				items: {
					type: 'object',
					additionalProperties: false,
					properties: { term: { type: 'string' }, prominence: { type: 'integer' } },
					required: ['term', 'prominence'],
				},
			},
			// Words physically printed on the case — extremely strong, rarely-used SEO.
			printed_text: { type: 'array', items: { type: 'string' } },
			// HOW it is drawn/made, not what it depicts.
			art_style: { type: 'string' },
			finish: { type: 'string' },
			composition: { type: 'string' },
			color_story: { type: 'string' },
			aesthetic: { type: 'string' },
			// What distinguishes this from every other case of the same colour.
			differentiators: { type: 'array', items: { type: 'string' } },
			// Real Etsy queries that should land on THIS product.
			search_phrases: { type: 'array', items: { type: 'string' } },
			// Ranked title-ready fragments, strongest first.
			title_keywords: { type: 'array', items: { type: 'string' } },
			confidence: { type: 'integer' },
		},
		required: [
			'visual_summary', 'subject_primary', 'subject_secondary', 'motifs', 'printed_text',
			'art_style', 'finish', 'composition', 'color_story', 'aesthetic', 'differentiators',
			'search_phrases', 'title_keywords', 'confidence',
		],
	},
}

/**
 * Choose the frames that actually show the artwork.
 *
 * The thumbnail is always included (it is the hero shot the design was chosen
 * for). Everything else is ranked by how much printed surface it is likely to
 * show: accessory-only and edge/profile shots are demoted because a photo of a
 * case's side teaches the model nothing about the print.
 *
 * @param {Array<{path:string,mime:string}>} images  in upload order (index 0 = rank 1)
 * @param {Array<object>} imageAnalysis              Phase 1 per-image facts (may be empty)
 * @param {number} max
 * @returns {Array<{path:string,mime:string,rank:number}>}
 */
function pickDesignImages(images, imageAnalysis, max) {
	const facts = new Map()
	for (const entry of imageAnalysis || []) facts.set(Number(entry.index), entry)

	return (images || [])
		.map((image, i) => {
			const rank = i + 1
			const fact = facts.get(rank) || {}
			let score = Number(fact.thumbnail_quality) || 5
			if (rank === 1) score += 1000 // hero shot — always first, always included
			if (fact.has_case === false) score -= 50 // accessory-only shot, no print
			if (fact.is_edge_or_profile) score -= 25 // side view, no print
			return { image, rank, score }
		})
		.sort((a, b) => b.score - a.score || a.rank - b.rank)
		.slice(0, Math.max(1, max))
		.map((entry) => ({ ...entry.image, rank: entry.rank }))
}

function buildDesignPrompt(nImages, pt) {
	const deviceNoun = pt.deviceNoun
	return `You are the lead merchandising analyst for a top-1% Etsy shop. A copywriter who CANNOT see these photos will write the product title from your answer alone. If your answer would fit a different ${deviceNoun}, you have failed.

You are looking at ${nImages} photograph(s) of ONE ${deviceNoun}. IMAGE 1 is the hero shot. Describe the DESIGN — what is printed on, moulded into, or attached to the product.

THE ONE RULE: every term you output must name a THING, a TECHNIQUE, a MATERIAL, or a MOOD YOU CAN POINT AT. These words are BANNED everywhere in your output because they describe nothing: ${BANNED_TERMS.join(', ')}. "A strawberry with a smiling face" is an answer. "A cute kawaii design" is not.

Be a forensic describer, not a marketer. Name fruits, animals, flowers, foods, objects, shapes and patterns exactly ("wild strawberry", "checkerboard", "cherry bow", "melting smiley", "gingham", "holographic star"). Never invent something you cannot see; when a detail is genuinely unreadable, leave that field empty rather than guessing.

FIELDS
  "visual_summary"    2-3 sentences: exactly what a shopper sees on the back of the product. Mention the subject, the supporting elements, the layout and the colours.
  "subject_primary"   The single most prominent depicted thing, 1-3 words, Title Case (e.g. "Strawberry Cow", "Melting Smiley", "Cherry Bow", "Pixel Heart"). If a third-party character dominates, identify its exact name for operator rights review; identification does not imply permission. NEVER a banned word. "" only if the product is genuinely plain with nothing depicted.
  "subject_secondary" The next most prominent thing, same rules, or "".
  "motifs"            EVERY distinct depicted element, each with "prominence" 1-10 (10 = the hero of the artwork, 1 = a small background detail). 3-10 entries. Lowercase nouns, 1-3 words each. Include repeated background elements (polka dots, gingham, glitter flecks, tiny stars) — those are real buyer queries.
  "printed_text"      EXACT transcription of any words, letters, numbers or slogans visible ON the product (not on packaging or watermarks). Empty array if none. Transcribe faithfully, including deliberate misspellings.
  "art_style"         HOW it is rendered, 1-4 words: e.g. "hand-drawn doodle", "3D puffy relief", "pixel art", "airbrush gradient", "watercolour", "sticker collage", "line art", "photo print", "embroidered patch look".
  "finish"            The physical surface/material effect, 1-4 words: e.g. "clear jelly", "holographic", "glitter quicksand", "matte pastel", "mirror chrome", "frosted translucent", "raised 3D silicone", "" if plainly none.
  "composition"       Layout in 1-4 words: "centred graphic", "all-over repeat print", "border frame", "scattered sticker collage", "half-and-half split", "corner accent".
  "color_story"       The palette in a short phrase, using real colour names: e.g. "pastel pink with mint and cream accents", "black with neon green".
  "aesthetic"         ONE lowercase word ONLY if it genuinely applies: coquette | y2k | kawaii | fairycore | cottagecore | gothic | preppy | grunge | minimalist | retro. Use "" when unsure. This is the ONE place a vibe word is allowed.
  "differentiators"   3-5 short phrases naming what makes THIS product different from any other product of the same colour. Concrete details only.
  "search_phrases"    10 phrases a real shopper would type into Etsy search and expect to find THIS EXACT product. 3-6 words, lowercase, no punctuation. At least 8 must contain a concrete noun from the artwork. No banned words on their own.
  "title_keywords"    6-10 title-ready fragments ranked strongest first, Title Case, 1-3 words each — the exact phrases the copywriter should lead with. First entry MUST be the strongest, most searched way to name this product's design.
  "confidence"        0-100: how confident you are that this fingerprint uniquely and correctly describes the product.

Return only the structured JSON.`
}

// ── Normalisation ────────────────────────────────────────────────────────────

function cleanPhrase(value, { maxWords = 6, titleCase = false } = {}) {
	let text = String(value == null ? '' : value)
		.replace(/["'`]/g, '')
		.replace(/\s+/g, ' ')
		.trim()
	if (!text) return ''
	const words = text.split(' ')
	if (words.length > maxWords) text = words.slice(0, maxWords).join(' ')
	if (titleCase) text = text.replace(/\b[\p{L}\p{N}][\p{L}\p{N}'-]*/gu, (w) => w.charAt(0).toUpperCase() + w.slice(1))
	return text
}

/** True when a phrase carries at least one word that actually describes something. */
function hasSpecificWord(value) {
	return tokenise(value).some((token) => classify(token) === 'specific')
}

/** Drop anything the model produced that is banned, empty, or duplicated. */
function normaliseDesign(input) {
	// Defence in depth: callStructured already unwraps a single-object array, but
	// this function is also used directly by tests and ad-hoc tooling.
	const raw = Array.isArray(input) ? input.find((e) => e && typeof e === 'object' && !Array.isArray(e)) : input
	if (!raw || typeof raw !== 'object') return null

	const dedupe = (values, opts) => {
		const seen = new Set()
		const out = []
		for (const value of values || []) {
			const phrase = cleanPhrase(value, opts)
			if (!phrase || !hasSpecificWord(phrase) || isPlaceholder(phrase)) continue
			const key = tokenise(phrase).join(' ')
			if (!key || seen.has(key)) continue
			seen.add(key)
			out.push(phrase)
		}
		return out
	}

	const motifs = []
	const motifSeen = new Set()
	for (const entry of Array.isArray(raw.motifs) ? raw.motifs : []) {
		const term = cleanPhrase(entry && entry.term, { maxWords: 3 }).toLowerCase()
		if (!term || !hasSpecificWord(term) || isPlaceholder(term)) continue
		const key = tokenise(term).join(' ')
		if (motifSeen.has(key)) continue
		motifSeen.add(key)
		const prominence = Math.max(1, Math.min(10, Number(entry && entry.prominence) || 5))
		motifs.push({ term, prominence })
	}
	motifs.sort((a, b) => b.prominence - a.prominence)

	const subjectPrimary = (() => {
		const value = cleanPhrase(raw.subject_primary, { maxWords: 4, titleCase: true })
		if (value && hasSpecificWord(value) && !isPlaceholder(value)) return value
		// The model refused to commit — promote the strongest motif instead.
		return motifs.length ? cleanPhrase(motifs[0].term, { maxWords: 3, titleCase: true }) : ''
	})()

	const subjectSecondary = (() => {
		const value = cleanPhrase(raw.subject_secondary, { maxWords: 4, titleCase: true })
		if (!value || !hasSpecificWord(value) || isPlaceholder(value)) return ''
		return tokenise(value).join(' ') === tokenise(subjectPrimary).join(' ') ? '' : value
	})()

	return {
		visualSummary: cleanPhrase(raw.visual_summary, { maxWords: 90 }),
		subjectPrimary,
		subjectSecondary,
		motifs: motifs.slice(0, 12),
		// Printed text is kept verbatim (case included) — it is a literal quote.
		printedText: [...new Set((Array.isArray(raw.printed_text) ? raw.printed_text : [])
			.map((t) => cleanPhrase(t, { maxWords: 8 }))
			.filter((t) => t && t.length <= 60))].slice(0, 6),
		artStyle: cleanPhrase(raw.art_style, { maxWords: 4 }).toLowerCase(),
		finish: cleanPhrase(raw.finish, { maxWords: 4 }).toLowerCase(),
		composition: cleanPhrase(raw.composition, { maxWords: 4 }).toLowerCase(),
		colorStory: cleanPhrase(raw.color_story, { maxWords: 10 }).toLowerCase(),
		aesthetic: cleanPhrase(raw.aesthetic, { maxWords: 1 }).toLowerCase(),
		differentiators: dedupe(raw.differentiators, { maxWords: 8 }).slice(0, 5),
		searchPhrases: dedupe((Array.isArray(raw.search_phrases) ? raw.search_phrases : []).map((p) => String(p || '').toLowerCase()), { maxWords: 6 }).slice(0, 10),
		titleKeywords: dedupe(raw.title_keywords, { maxWords: 3, titleCase: true }).slice(0, 10),
		confidence: Math.max(0, Math.min(100, Number(raw.confidence) || 0)),
	}
}

/** True when the fingerprint carries enough signal to be worth using. */
function isUsableDesign(design) {
	if (!design) return false
	return Boolean(design.subjectPrimary || design.motifs.length || design.printedText.length || design.titleKeywords.length)
}

/**
 * Run the design pass.
 *
 * @param {object} client                    OpenAI-compatible vision client
 * @param {object} args
 * @param {Array<{path:string,mime:string}>} args.images
 * @param {Array<object>} [args.imageAnalysis]  Phase 1 facts used to pick frames
 * @param {object|string} [args.productType]
 * @param {function} args.callStructured     injected caller (shared retry/JSON logic)
 * @param {function} args.encodeImage        injected image encoder (shared downscaling)
 * @returns {Promise<object|null>} normalised fingerprint, or null when unusable
 */
async function analyzeDesign(client, { images, imageAnalysis, productType, callStructured, encodeImage }) {
	if (!images || !images.length) return null
	const pt = productTypes.getProductType(productType)
	const chosen = pickDesignImages(images, imageAnalysis, config.copy.designImages)

	const content = [{ type: 'text', text: buildDesignPrompt(chosen.length, pt) }]
	for (let i = 0; i < chosen.length; i++) {
		content.push({ type: 'text', text: `\n${i === 0 ? 'IMAGE 1 (HERO SHOT)' : `IMAGE ${i + 1}`}:` })
		// Always full detail here: the whole point of this pass is reading small
		// printed elements that a downscaled/low-detail tile would erase.
		content.push(await encodeImage(chosen[i].path, chosen[i].mime, config.openai.visionDetail))
	}

	const messages = [
		{
			role: 'system',
			content: `You are a forensic product-design analyst for Etsy merchandising. You describe exactly what is depicted on a ${pt.deviceNoun} using concrete, searchable nouns. You never use empty marketing adjectives, never invent details you cannot see, and never return a description that would fit a different product. Return only valid JSON matching the schema.`,
		},
		{ role: 'user', content },
	]

	const parsed = await callStructured(client, {
		messages,
		schema: DESIGN_SCHEMA,
		maxTokens: config.openai.visionMaxTokens ? Math.min(8000, config.openai.visionMaxTokens) : 0,
		model: config.openai.visionModel,
		reasoningEffort: config.openai.reasoningEffort,
		temperature: 0.2,
	})

	const design = normaliseDesign(parsed)
	if (!isUsableDesign(design)) return null
	return { ...design, imageRanks: chosen.map((c) => c.rank) }
}

/**
 * Fold the fingerprint back into the legacy Phase 1 `product_summary` shape.
 *
 * Everything downstream (Etsy attributes, the Inspector, cached items created
 * before this pass existed) reads `design_subject` / `design_motifs` /
 * `design_aesthetic`, so the richer signal is mirrored onto those fields rather
 * than replacing them. Mutates and returns the summary.
 *
 * @param {object} productSummary
 * @param {object|null} design
 * @returns {object} the same summary object
 */
function applyDesignToSummary(productSummary, design) {
	const summary = productSummary || {}
	if (!isUsableDesign(design)) return summary

	if (design.subjectPrimary) summary.design_subject = design.subjectPrimary

	const existing = Array.isArray(summary.design_motifs) ? summary.design_motifs : []
	const merged = []
	const seen = new Set()
	for (const term of [...design.motifs.map((m) => m.term), ...existing]) {
		const phrase = String(term || '').trim().toLowerCase()
		if (!phrase || !hasSpecificWord(phrase)) continue
		const key = tokenise(phrase).join(' ')
		if (seen.has(key)) continue
		seen.add(key)
		merged.push(phrase)
	}
	if (merged.length) summary.design_motifs = merged.slice(0, 12)
	if (design.aesthetic) summary.design_aesthetic = design.aesthetic

	// `design_features` feeds the description; enrich it with the physical facts
	// the QA pass has no field for (finish, art style, printed text).
	const features = [summary.design_features, design.finish, design.artStyle, design.composition]
		.map((f) => String(f || '').trim())
		.filter(Boolean)
	if (design.printedText.length) features.push(`text on case: ${design.printedText.join(', ')}`)
	if (features.length) summary.design_features = [...new Set(features)].join('; ').slice(0, 400)

	return summary
}

/** Compact, prompt-ready rendering of the fingerprint for the copy model. */
function designFactsBlock(design) {
	if (!isUsableDesign(design)) return ''
	const lines = ['=== DESIGN FINGERPRINT (vision pass — GROUND TRUTH, the title MUST reflect this) ===']
	if (design.visualSummary) lines.push(`What is on the product: ${design.visualSummary}`)
	if (design.subjectPrimary) lines.push(`PRIMARY SUBJECT: ${design.subjectPrimary}`)
	if (design.subjectSecondary) lines.push(`Secondary subject: ${design.subjectSecondary}`)
	if (design.motifs.length) lines.push(`Motifs (most prominent first): ${design.motifs.map((m) => `${m.term} (${m.prominence}/10)`).join(', ')}`)
	if (design.printedText.length) lines.push(`Text printed ON the product (verbatim): ${design.printedText.map((t) => `"${t}"`).join(', ')}`)
	if (design.artStyle) lines.push(`Art style: ${design.artStyle}`)
	if (design.finish) lines.push(`Finish / material effect: ${design.finish}`)
	if (design.composition) lines.push(`Composition: ${design.composition}`)
	if (design.colorStory) lines.push(`Colour story: ${design.colorStory}`)
	if (design.aesthetic) lines.push(`Aesthetic (the ONLY vibe word permitted in the title): ${design.aesthetic}`)
	if (design.differentiators.length) lines.push(`What makes it different: ${design.differentiators.join('; ')}`)
	if (design.titleKeywords.length) lines.push(`Ranked title keywords (strongest first): ${design.titleKeywords.join(' | ')}`)
	if (design.searchPhrases.length) lines.push(`Real buyer searches this must rank for: ${design.searchPhrases.join('; ')}`)
	lines.push(`Fingerprint confidence: ${design.confidence}/100`)
	return lines.join('\n')
}

module.exports = {
	analyzeDesign,
	normaliseDesign,
	applyDesignToSummary,
	designFactsBlock,
	pickDesignImages,
	isUsableDesign,
	DESIGN_SCHEMA,
	BANNED_TERMS,
}
