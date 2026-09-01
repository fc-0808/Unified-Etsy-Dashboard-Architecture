'use strict'

/**
 * Deterministic quality gate for generated listing titles.
 *
 * The failure mode this exists to kill: an LLM that has been told "this is a
 * kawaii Y2K shop" happily writes "Clear Kawaii Y2K iPhone Case, Cute Aesthetic
 * Cover for iPhone 17 16 15" for EVERY product. That title is grammatical,
 * on-brand, the right length — and completely interchangeable between a
 * strawberry case and a Hello Kitty case. It ranks for nothing because it
 * describes nothing.
 *
 * So the pipeline does not trust the model's self-assessment. Every title is
 * scored here against the design facts the vision pass extracted, using pure
 * string logic (no API call, no randomness). A title that fails is sent back to
 * the model with a specific, actionable critique — the same way a senior
 * copy editor would reject it.
 *
 * Vocabulary classes:
 *   FILLER    — structural words + product nouns. Carry zero design signal.
 *   AESTHETIC — vibe adjectives (kawaii, y2k, coquette…). Legitimate SEO in
 *               small doses, but a title made of ONLY these is the bug.
 *   COLOR     — real buyer keywords, but not design-descriptive on their own.
 *   DEVICE    — model/compatibility tokens. Mandatory, never "specific".
 *
 * Anything left over is a SPECIFIC term — the actual content of the title.
 */

// Structural words, product nouns, and empty marketing adjectives.
const FILLER = new Set([
	'a', 'an', 'and', 'for', 'the', 'with', 'of', 'in', 'on', 'to', 'or', 'by', 'from', 'your',
	'case', 'cases', 'cover', 'covers', 'casing', 'shell', 'skin', 'protector', 'accessory', 'accessories',
	'phone', 'mobile', 'cell', 'cellphone', 'smartphone', 'device',
	'gift', 'gifts', 'gifting', 'her', 'him', 'she', 'he', 'them', 'you',
	'women', 'woman', 'womens', 'girl', 'girls', 'girlfriend', 'teen', 'teens', 'bestie', 'friend', 'bff', 'sister', 'mom',
	'best', 'new', 'hot', 'top', 'must', 'have', 'perfect', 'great', 'good', 'nice', 'amazing', 'awesome',
	'beautiful', 'gorgeous', 'stunning', 'lovely', 'pretty', 'adorable', 'charming', 'sweet', 'fun', 'funny',
	'unique', 'special', 'custom', 'handmade', 'quality', 'premium', 'luxury', 'designer', 'exclusive',
	'design', 'designs', 'designed', 'pattern', 'patterns', 'print', 'printed', 'prints', 'style', 'styles', 'themed', 'theme',
	'character', 'characters', 'mascot', 'motif', 'motifs', 'graphic', 'graphics', 'art', 'artwork',
	'soft', 'slim', 'thin', 'durable', 'shockproof', 'protective', 'protection', 'drop', 'proof',
	'silicone', 'tpu', 'plastic', 'rubber', 'material',
	'compatible', 'compatibility', 'fits', 'fit', 'model', 'models', 'series', 'edition', 'version',
	'shop', 'store', 'brand', 'official', 'set', 'bundle', 'piece', 'pack', 'pcs',
])

// Vibe adjectives. Useful once; a title built from three of them is the bug.
const AESTHETIC = new Set([
	'kawaii', 'cute', 'aesthetic', 'y2k', 'coquette', 'girly', 'trendy', 'chic', 'stylish', 'cool',
	'harajuku', 'fairycore', 'cottagecore', 'gothic', 'goth', 'preppy', 'retro', 'vintage', 'vsco',
	'minimalist', 'boho', 'grunge', 'dreamy', 'whimsical', 'quirky', 'funky', 'playful', 'youthful',
])

// Colours are real buyer keywords but describe no subject matter.
const COLOR = new Set([
	'beige', 'black', 'blue', 'bronze', 'brown', 'clear', 'transparent', 'copper', 'gold', 'golden',
	'gray', 'grey', 'green', 'orange', 'pink', 'purple', 'rainbow', 'red', 'rose', 'silver', 'white',
	'yellow', 'pastel', 'neon', 'multicolor', 'multicolour', 'colorful', 'colourful', 'light', 'dark',
	'baby', 'hot', 'lilac', 'lavender', 'mint', 'cream', 'ivory', 'nude', 'teal', 'coral', 'peach',
])

// Device / compatibility tokens (plus any bare number).
const DEVICE = new Set([
	'iphone', 'airpods', 'airpod', 'apple', 'samsung', 'galaxy', 'pixel',
	'pro', 'max', 'plus', 'mini', 'ultra', 'air', 'gen', 'generation',
	'magsafe', 'mag', 'safe', 'magnetic', 'magnet', 'wireless', 'charging', 'charger',
])

// Placeholder phrases that mean the pipeline gave up. Never allowed to ship.
const PLACEHOLDER_PATTERNS = [
	/\bkawaii\s+character\b/i,
	/\bcute\s+character\b/i,
	/\banime\s+character\b/i,
	/\bgeneric\s+character\b/i,
	/\bcartoon\s+character\b/i,
	/\bunknown\b/i,
	/\bn\/a\b/i,
	/\bcharacter\s+(?:phone\s+)?case\b/i,
	/\bvarious\s+characters?\b/i,
]

const DEFAULT_MIN_SCORE = 70
const MAX_AESTHETIC_WORDS = 1
const IDEAL_MAX_WORDS = 15
const RECOMMENDED_MAX_WORDS = 20
const ETSY_MAX_LENGTH = 140

// ── Tokenisation ─────────────────────────────────────────────────────────────

/** Lowercase, strip accents/punctuation, collapse whitespace. */
function normaliseText(value) {
	return String(value == null ? '' : value)
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
}

/**
 * Light singulariser. Correctness matters less than CONSISTENCY: both sides of
 * every comparison are stemmed with this same function, so "cherries" matches
 * "cherry" and "dots" matches "dot" regardless of how odd an individual stem
 * looks in isolation.
 */
function stem(word) {
	if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`
	if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us')) return word.slice(0, -1)
	return word
}

function tokenise(value) {
	const text = normaliseText(value)
	return text ? text.split(' ').map(stem) : []
}

function classify(token) {
	if (!token) return 'filler'
	if (/^\d+$/.test(token)) return 'device'
	if (DEVICE.has(token)) return 'device'
	if (COLOR.has(token)) return 'color'
	if (AESTHETIC.has(token)) return 'aesthetic'
	if (FILLER.has(token)) return 'filler'
	if (token.length <= 2) return 'filler'
	return 'specific'
}

/** True when `term` (one or more words) is expressed in the title's tokens. */
function titleContainsTerm(titleTokens, term) {
	const wanted = tokenise(term)
	if (!wanted.length) return false

	// Exact contiguous phrase match.
	for (let i = 0; i + wanted.length <= titleTokens.length; i++) {
		let hit = true
		for (let j = 0; j < wanted.length; j++) {
			if (titleTokens[i + j] !== wanted[j]) { hit = false; break }
		}
		if (hit) return true
	}

	// Head-noun match: "pink bow" is satisfied by a title containing "Bow".
	// Only the term's own meaningful words count, so "cute case" can never match.
	const meaningful = wanted.filter((w) => classify(w) === 'specific')
	if (!meaningful.length) return false
	const present = new Set(titleTokens)
	return meaningful.some((w) => present.has(w))
}

// ── Scoring ──────────────────────────────────────────────────────────────────

/**
 * Build the evaluation context for a product from whatever design signal the
 * pipeline managed to extract. Callers pass the richest source they have; every
 * field is optional and the gate degrades gracefully as signal disappears.
 *
 * @param {object} [args]
 * @param {string} [args.characterName]   identified third-party character ("" / generic when none)
 * @param {boolean} [args.characterIsGeneric]
 * @param {object} [args.designAnalysis]  normalised design fingerprint
 * @param {object} [args.productSummary]  Phase 1 summary (legacy fallback)
 * @param {string} [args.devicePhrase]    exact device string the title must carry
 * @returns {{subject:string, designTerms:string[], devicePhrase:string}}
 */
function buildTitleContext(args = {}) {
	const design = args.designAnalysis || {}
	const summary = args.productSummary || {}

	const characterName = String(args.characterName || '').trim()
	const characterUsable = characterName && !args.characterIsGeneric && !isPlaceholder(characterName)

	const subject = characterUsable
		? characterName
		: String(design.subjectPrimary || summary.design_subject || '').trim()

	// Ranked, de-duplicated concrete terms the title should reflect. Order is
	// meaningful — the repair prompt shows the strongest first.
	const raw = [
		characterUsable ? characterName : '',
		design.subjectPrimary || '',
		design.subjectSecondary || '',
		...(Array.isArray(design.motifs) ? design.motifs.map((m) => (m && m.term) || '') : []),
		design.artStyle || '',
		design.finish || '',
		...(Array.isArray(design.printedText) ? design.printedText : []),
		summary.design_subject || '',
		...(Array.isArray(summary.design_motifs) ? summary.design_motifs : []),
	]

	const seen = new Set()
	const designTerms = []
	for (const entry of raw) {
		const term = String(entry || '').trim()
		if (!term) continue
		const key = tokenise(term).join(' ')
		if (!key || seen.has(key)) continue
		// A "term" made entirely of filler/aesthetic words is not a design term.
		if (!tokenise(term).some((t) => classify(t) === 'specific')) continue
		seen.add(key)
		designTerms.push(term)
	}

	return { subject, designTerms, devicePhrase: String(args.devicePhrase || '').trim() }
}

/** True when the string is one of the "we gave up" placeholders. */
function isPlaceholder(value) {
	const text = String(value || '')
	return PLACEHOLDER_PATTERNS.some((re) => re.test(text))
}

/**
 * Score a title 0-100 against the product's real design facts.
 *
 * Hard issues (`fatal: true`) always fail the gate regardless of score — those
 * are the cases where the title is actively wrong or interchangeable, not
 * merely weak.
 *
 * @param {string} title
 * @param {{subject?:string, designTerms?:string[], devicePhrase?:string}} [context]
 * @param {{minScore?:number}} [opts]
 * @returns {{
 *   score:number, ok:boolean, issues:Array<{code:string,message:string,fatal:boolean}>,
 *   critique:string, specificTerms:string[], matchedDesignTerms:string[],
 *   missingDesignTerms:string[], aestheticWords:string[], length:number,
 *   subjectPresent:boolean, devicePhrasePresent:boolean, evaluated:boolean
 * }}
 */
function scoreTitle(title, context = {}, opts = {}) {
	const minScore = Number.isFinite(opts.minScore) ? opts.minScore : DEFAULT_MIN_SCORE
	const text = String(title || '').trim()
	const tokens = tokenise(text)
	const subject = String(context.subject || '').trim()
	const designTerms = (context.designTerms || []).filter(Boolean)
	const devicePhrase = String(context.devicePhrase || '').trim()

	const issues = []
	const add = (code, message, fatal) => issues.push({ code, message, fatal: Boolean(fatal) })

	if (!text) {
		return {
			score: 0, ok: false, issues: [{ code: 'empty', message: 'The title is empty.', fatal: true }],
			critique: 'The title is empty.', specificTerms: [], matchedDesignTerms: [], missingDesignTerms: designTerms,
			aestheticWords: [], length: 0, subjectPresent: false, devicePhrasePresent: false, evaluated: true,
		}
	}

	// Which of the real design terms actually made it into the title.
	const matchedDesignTerms = designTerms.filter((term) => titleContainsTerm(tokens, term))
	const missingDesignTerms = designTerms.filter((term) => !matchedDesignTerms.includes(term))

	const specificTerms = [...new Set(tokens.filter((t) => classify(t) === 'specific'))]
	const aestheticWords = tokens.filter((t) => classify(t) === 'aesthetic')
	const subjectPresent = subject ? titleContainsTerm(tokens, subject) : false
	const devicePhrasePresent = devicePhrase ? titleContainsTerm(tokens, devicePhrase) : true

	// When the vision pass found nothing concrete AND there is no character, the
	// product genuinely may be a plain case. Score length/format only — failing
	// such a title forever would just burn tokens on an unwinnable repair loop.
	const evaluated = Boolean(subject || designTerms.length)

	if (isPlaceholder(text)) {
		add('placeholder_subject', 'The title uses a placeholder like "Kawaii Character" instead of naming what is actually on the case.', true)
	}
	if (text.length > ETSY_MAX_LENGTH) {
		add('too_long', `The title is ${text.length} characters — Etsy rejects anything over ${ETSY_MAX_LENGTH}.`, true)
	}
	if (tokens.length > RECOMMENDED_MAX_WORDS) {
		add('too_wordy', `The title is ${tokens.length} words. Etsy's current guidance favors clear, scannable titles and suggests considering fewer than ${IDEAL_MAX_WORDS} words.`, false)
	}
	if (evaluated && subject && !subjectPresent) {
		add('subject_missing', `The title never mentions the product's actual subject "${subject}".`, true)
	}
	if (evaluated && designTerms.length >= 2 && matchedDesignTerms.length === 0) {
		add('design_terms_missing', `The title reflects none of the real design details (${designTerms.slice(0, 6).join(', ')}).`, true)
	}
	if (evaluated && designTerms.length === 1 && matchedDesignTerms.length === 0) {
		add('design_terms_missing', `The title does not mention the one design detail found on the case ("${designTerms[0]}").`, true)
	}
	if (evaluated && !specificTerms.length) {
		add('no_specific_terms', 'Every word in the title is generic filler — it would fit any phone case in the shop.', true)
	}
	if (aestheticWords.length > MAX_AESTHETIC_WORDS) {
		// List them with multiplicity, so "kawaii ×2" reads as the repetition it is.
		const counts = new Map()
		for (const word of aestheticWords) counts.set(word, (counts.get(word) || 0) + 1)
		const listed = [...counts.entries()].map(([word, n]) => (n > 1 ? `${word} ×${n}` : word)).join(', ')
		add('aesthetic_spam', `The title stacks ${aestheticWords.length} vibe words (${listed}) where at most ${MAX_AESTHETIC_WORDS} belong.`, false)
	}
	if (devicePhrase && !devicePhrasePresent) {
		add('device_missing', `The title must carry the exact device coverage "${devicePhrase}".`, false)
	}

	// ── Weighted score ────────────────────────────────────────────────────────
	let score = 0
	if (evaluated) {
		const designTarget = Math.min(3, Math.max(1, designTerms.length))
		score += 40 * Math.min(1, matchedDesignTerms.length / designTarget)
		score += subject ? (subjectPresent ? 25 : 0) : 25 * Math.min(1, matchedDesignTerms.length / designTarget)
		score += 15 * Math.min(1, specificTerms.length / 4)
	} else {
		// Nothing to be specific about — award the content points and judge format.
		score += 80
	}
	score += tokens.length <= IDEAL_MAX_WORDS ? 10 : tokens.length <= RECOMMENDED_MAX_WORDS ? 5 : 0
	score += aestheticWords.length <= MAX_AESTHETIC_WORDS ? 10 : 0
	if (!devicePhrasePresent) score -= 10
	if (isPlaceholder(text)) score -= 40

	score = Math.max(0, Math.min(100, Math.round(score)))
	const ok = score >= minScore && !issues.some((i) => i.fatal)

	return {
		score, ok, issues, critique: buildCritique(issues), specificTerms, matchedDesignTerms,
		missingDesignTerms, aestheticWords: [...new Set(aestheticWords)], length: text.length,
		wordCount: tokens.length,
		subjectPresent, devicePhrasePresent, evaluated,
	}
}

/** Render the issue list as the actionable feedback sent back to the model. */
function buildCritique(issues) {
	if (!issues.length) return ''
	return issues.map((i, n) => `${n + 1}. ${i.message}`).join('\n')
}

// ── Deterministic clean-up ───────────────────────────────────────────────────

/**
 * Non-destructive last-mile fixes applied to every title:
 *   • drop the "Kawaii Character" style placeholder wording
 *   • drop a repeated vibe word ("Cute … Cute") that only wastes characters
 *
 * Deliberately conservative: it never removes a DISTINCT word, because a title
 * that reads well is worth more than one extra keyword slot, and the prompt +
 * gate + repair loop already handle genuine genericness.
 *
 * @param {string} title
 * @returns {string}
 */
function tidyTitle(title) {
	let text = String(title || '')
	if (!text) return ''

	// "Kawaii Character" / "Cute Character" → keep the adjective, drop the noun.
	// A named franchise ("Sanrio Characters") is left alone: it is a real query.
	text = text.replace(/\b(kawaii|cute|anime|cartoon|generic)\s+characters?\b/gi, '$1')

	// Remove second and later occurrences of the same vibe word.
	const seen = new Set()
	text = text.replace(/[A-Za-z0-9]+/g, (word) => {
		const key = stem(word.toLowerCase())
		if (!AESTHETIC.has(key)) return word
		if (seen.has(key)) return ''
		seen.add(key)
		return word
	})

	// Drop a dangling trailing "Gift" when the title already says Gift earlier
	// ("… Gift for Her Gift"). Trimming from the END is always safe; removing a
	// mid-sentence repeat is not, so it is left to the model.
	text = text.replace(/^(.*\bgifts?\b.*?)[\s,]+gifts?[\s,]*$/i, '$1')

	return text
		.replace(/\s{2,}/g, ' ')
		.replace(/\s+([,.])/g, '$1')
		.replace(/,\s*,+/g, ',')
		.replace(/^[\s,]+/, '')
		.replace(/[\s,]+$/, '')
		.trim()
}

module.exports = {
	scoreTitle,
	buildTitleContext,
	tidyTitle,
	isPlaceholder,
	normaliseText,
	tokenise,
	classify,
	titleContainsTerm,
	FILLER,
	AESTHETIC,
	COLOR,
	DEVICE,
	DEFAULT_MIN_SCORE,
	ETSY_MAX_LENGTH,
}
