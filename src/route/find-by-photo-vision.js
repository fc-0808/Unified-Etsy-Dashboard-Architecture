'use strict'

/**
 * Visual locate for phone snaps that dHash cannot recover.
 *
 * Listing-photo dHash is excellent at "this JPEG is the same file (or a light
 * crop) as the catalog shot". It is blind to a phone snap of the physical
 * product on a table: Hamming 48–168, indistinguishable from random.
 *
 * This module is the second path. It reuses the shop's existing vision
 * provider (VISION_API_KEY / OpenRouter / OpenAI — same stack as listing
 * design-fingerprint) and never invents a second vendor:
 *
 *   1. DESCRIBE  the query photo → subject, characters, bumper colour,
 *      printed text, composition, motifs. MagSafe rings, grips, the phone
 *      body, packaging and the table are NOT the product.
 *   2. RETRIEVE  over product_map titles with identity-aware scoring:
 *      catalog character names are a gate, layout-genre stuffing
 *      ("sticker collage", "Sanrio") is weak, bumper colour is strong.
 *      A Hello Kitty collage cannot beat the stall that stocks this Kuromi.
 *   3. LOCAL PRIOR  a dark-ink layout grid demotes listings whose print
 *      silhouette is an outlier (a grip case vs a sticker collage) without
 *      pretending it can tell two Kuromi collages apart.
 *   4. RERANK    listing thumbnails against the snap when the lexical
 *      winner is not a unique print name, and ALWAYS for character products
 *      — many stalls share "Kuromi" in the title. Skipped when one title
 *      leads with a distinctive print name ("Pastel Polka Dots").
 *      FIND_BY_PHOTO_RERANK=0 turns the LLM pass off; local retrieve remains.
 *
 * The live provider is never required at require()-time. Tests inject
 * `{ describe, rerank }` and CI never hits the network.
 */

const sharp = require('sharp')
const { config } = require('../listings/config')
const { tokenise, classify } = require('../listings/title-quality')
const { CHARACTERS, catalogPromptBlock, normaliseCharacter } = require('../listings/character-catalog')
const { normalizeTitle } = require('./dashboard')
const { resolveLocation } = require('../sourcing/catalog-view')
const visual = require('./find-by-photo-visual')

const QUERY_EDGE = 512
const THUMB_EDGE = 256
const QUERY_JPEG_QUALITY = 70
const THUMB_JPEG_QUALITY = 62
const LEXICAL_POOL = 28
const RERANK_CAP = 6
const VISUAL_SCORE_CAP = 16
const MAX_RESULTS = 8
const AMBIGUOUS_RESULTS = 5
const MIN_SCORE = 2.8
const VISION_TIMEOUT_MS = 35000
const DESCRIBE_MAX_TOKENS = 500
const RERANK_MAX_TOKENS = 400

/**
 * Words that describe a *genre* of print, not a unique product. Catalog titles
 * stuff "sticker collage" / "Sanrio" / "glitter" into every character case;
 * treating them as strong specific terms is how a Hello Kitty collage outranks
 * the stall that actually stocks this Kuromi.
 */
const WEAK_PRINT = new Set([
	'sticker',
	'collage',
	'scrapbook',
	'decal',
	'glitter',
	'holographic',
	'sparkle',
	'iridescent',
	'shimmer',
	'anime',
	'sanrio',
	'star',
	'bow',
	'heart',
	'skull',
	'y2kase',
])

/** Light morphology so "Starry Cover" overlaps a describe-pass motif of "Stars". */
const TOKEN_CANON = {
	starry: 'star',
	glittery: 'glitter',
	sparkly: 'sparkle',
}

const CONF_FROM_VISION = [
	{ min: 88, id: 'exact' },
	{ min: 72, id: 'likely' },
	{ min: 55, id: 'possible' },
	{ min: 40, id: 'weak' },
]

function strings(value) {
	if (!Array.isArray(value)) return []
	const out = []
	const seen = new Set()
	for (const entry of value) {
		const text = typeof entry === 'string' ? entry : entry && typeof entry.term === 'string' ? entry.term : ''
		const trimmed = text.replace(/\s+/g, ' ').trim()
		if (!trimmed) continue
		const key = trimmed.toLowerCase()
		if (seen.has(key)) continue
		seen.add(key)
		out.push(trimmed)
		if (out.length >= 12) break
	}
	return out
}

function clip(value, max) {
	return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max)
}

function firstColorPhrase(fp) {
	const fromList = (list) => {
		for (const entry of list || []) {
			const text = clip(entry, 40)
			if (!text) continue
			if (meaningfulTokens(text).some((tok) => classify(tok) === 'color')) return text
		}
		return ''
	}
	return fromList(fp.colors) || fromList(fp.motifs) || fromList(fp.search_phrases)
}

function expandBareSubject(fp) {
	const subject = clip(fp.subject, 80)
	const subjectToks = meaningfulTokens(subject)
	if (!subjectToks.length) return fp
	if (subjectToks.some((tok) => classify(tok) === 'color')) return fp
	if (!subjectToks.some((tok) => classify(tok) === 'specific')) return fp
	const colorPhrase = firstColorPhrase(fp)
	if (!colorPhrase) return fp
	return { ...fp, subject: clip(`${colorPhrase} ${subject}`, 80) }
}

function normalizeFingerprint(raw) {
	const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
	const motifs = strings(src.motifs)
	const subject = clip(src.subject || src.subject_primary, 80)
	const characters = []
	const seenChar = new Set()
	for (const entry of strings(src.characters)) {
		const hit = normaliseCharacter(entry)
		const name = hit.known ? hit.name : clip(entry, 40)
		if (!name) continue
		const key = name.toLowerCase()
		if (seenChar.has(key)) continue
		seenChar.add(key)
		characters.push(name)
	}
	return expandBareSubject({
		product_type: clip(src.product_type, 40) || 'iphone_case',
		visual_summary: clip(src.visual_summary, 400),
		subject,
		motifs,
		colors: strings(src.colors),
		printed_text: strings(src.printed_text),
		characters,
		composition: clip(src.composition, 40).toLowerCase(),
		bumper_color: clip(src.bumper_color, 40),
		has_magsafe: Boolean(src.has_magsafe),
		has_charm: Boolean(src.has_charm),
		has_grip: Boolean(src.has_grip),
		search_phrases: strings(src.search_phrases),
		confidence: Math.max(0, Math.min(100, Number(src.confidence) || 0)),
	})
}

function publicQuery(fp) {
	if (!fp) return null
	const n = normalizeFingerprint(fp)
	if (!n.subject && !n.motifs.length && !n.visual_summary) return null
	return {
		product_type: n.product_type,
		subject: n.subject,
		motifs: n.motifs.slice(0, 6),
		visual_summary: n.visual_summary,
		characters: extractCharacters(n).slice(0, 4),
		composition: n.composition,
		bumper_color: n.bumper_color,
		confidence: n.confidence,
	}
}

function catalogNameNeedles() {
	return CHARACTERS.map((entry) => {
		const variants = [entry.name, ...(entry.aliases || []).filter((alias) => tokenise(alias).length >= 2)]
		return {
			name: entry.name,
			needles: variants.map((name) => tokenise(name)).filter((toks) => toks.length),
		}
	})
}

const CATALOG_NAME_NEEDLES = catalogNameNeedles()

function charactersInText(text) {
	const tokens = tokenise(text)
	if (!tokens.length) return []
	const found = []
	const seen = new Set()
	for (const entry of CATALOG_NAME_NEEDLES) {
		if (entry.needles.some((needle) => hasContiguous(tokens, needle))) {
			if (seen.has(entry.name)) continue
			seen.add(entry.name)
			found.push(entry.name)
		}
	}
	return found
}

function extractCharacters(fingerprint) {
	const fp = fingerprint && typeof fingerprint === 'object' ? fingerprint : {}
	const ordered = []
	const seen = new Set()
	const addNames = (value) => {
		for (const name of charactersInText(value)) {
			if (seen.has(name)) continue
			seen.add(name)
			ordered.push(name)
		}
		const direct = normaliseCharacter(value)
		if (direct.known && !seen.has(direct.name)) {
			seen.add(direct.name)
			ordered.push(direct.name)
		}
	}
	for (const name of strings(fp.characters)) addNames(name)
	addNames(fp.subject)
	for (const motif of strings(fp.motifs)) addNames(motif)
	for (const printed of strings(fp.printed_text)) addNames(printed)
	return ordered
}

function hasDistinctivePrintName(fingerprint) {
	const fp = normalizeFingerprint(fingerprint)
	const charToks = new Set(extractCharacters(fp).flatMap((name) => tokenise(name)))
	return meaningfulTokens(fp.subject).some((tok) => {
		if (charToks.has(tok) || WEAK_PRINT.has(tok)) return false
		const klass = classify(tok)
		return klass === 'specific'
	})
}

function tokenWeight(role, klass, token) {
	if (token === 'magsafe' || token === 'magnetic') return 0.45
	if (klass === 'filler' || klass === 'device') return 0
	if (role === 'character') return klass === 'specific' ? 4.6 : 0.4
	if (role === 'bumper') return 2.4
	if (WEAK_PRINT.has(token)) return 0.28
	if (klass === 'aesthetic') return 0.2
	if (klass === 'color') return 0.55
	if (role === 'printed') return 3.5
	if (role === 'subject') return 3.2
	if (role === 'motif') return 2.6
	if (role === 'phrase') return 2.2
	if (role === 'summary') return 1.4
	return 2.2
}

function addToken(into, token, role) {
	const klass = classify(token)
	const weight = tokenWeight(role, klass, token)
	if (!weight) return
	const prev = into.get(token)
	if (!prev || weight > prev.weight) into.set(token, { token, klass, weight, role })
}

function collectTokens(into, text, role) {
	for (const token of tokenise(text)) {
		addToken(into, token, role)
		const canon = TOKEN_CANON[token]
		if (canon) addToken(into, canon, role)
	}
}

function catalogTokenSet(tokens) {
	const set = new Set(tokens)
	for (const token of tokens) {
		const canon = TOKEN_CANON[token]
		if (canon) set.add(canon)
	}
	return set
}

function meaningfulTokens(text) {
	return tokenise(text).filter((tok) => {
		const klass = classify(tok)
		return klass !== 'filler' && klass !== 'device'
	})
}

function firstContiguousIndex(hay, needle) {
	if (!needle.length || needle.length > hay.length) return -1
	for (let i = 0; i + needle.length <= hay.length; i++) {
		let ok = true
		for (let j = 0; j < needle.length; j++) {
			if (hay[i + j] !== needle[j]) {
				ok = false
				break
			}
		}
		if (ok) return i
	}
	return -1
}

function hasContiguous(hay, needle) {
	return firstContiguousIndex(hay, needle) !== -1
}

function titleLeadsWith(hay, needle) {
	if (needle.length < 2 || hay.length < needle.length) return false
	return needle.every((tok, i) => hay[i] === tok)
}

function productTypeMultiplier(title, productType) {
	const air = /\bairpods?\b/i.test(title || '')
	const phone = /\biphone\b/i.test(title || '')
	const kind = String(productType || 'iphone_case')
	if (kind === 'airpods_case' || kind === 'airpods') {
		if (phone && !air) return 0.12
		return 1
	}
	if (air && !phone) return 0.12
	return 1
}

const BUMPER_SYNONYMS = {
	lavender: ['lavender', 'lilac', 'purple'],
	lilac: ['lilac', 'lavender', 'purple'],
	purple: ['purple', 'lavender', 'lilac'],
	pink: ['pink', 'rose'],
	red: ['red'],
	blue: ['blue'],
	black: ['black'],
	green: ['green', 'mint'],
	white: ['white'],
	yellow: ['yellow'],
}

function bumperColorTerms(color) {
	const key = tokenise(color)[0]
	if (!key) return []
	return BUMPER_SYNONYMS[key] || [key]
}

function buildQueryModel(fingerprint) {
	const fp = normalizeFingerprint(fingerprint)
	const characters = extractCharacters(fp)
	const primaryCharacter = characters[0] || ''
	const weights = new Map()
	collectTokens(weights, fp.subject, 'subject')
	for (const motif of fp.motifs) collectTokens(weights, motif, 'motif')
	for (const phrase of fp.search_phrases) collectTokens(weights, phrase, 'phrase')
	for (const printed of fp.printed_text) collectTokens(weights, printed, 'printed')
	for (const color of fp.colors) collectTokens(weights, color, 'motif')
	collectTokens(weights, fp.bumper_color, 'bumper')
	for (const syn of bumperColorTerms(fp.bumper_color)) collectTokens(weights, syn, 'bumper')
	collectTokens(weights, fp.visual_summary, 'summary')
	for (const name of characters) collectTokens(weights, name, 'character')

	const phrases = []
	const seen = new Set()
	const addPhrase = (phrase, role) => {
		if (!phrase) return
		const key = phrase.toLowerCase()
		if (seen.has(key)) return
		const tokens = meaningfulTokens(phrase)
		if (!tokens.length) return
		seen.add(key)
		phrases.push({
			phrase,
			role,
			tokens,
			specificCount: tokens.filter((tok) => classify(tok) === 'specific' && !WEAK_PRINT.has(tok)).length,
			weakOnly: tokens.every((tok) => WEAK_PRINT.has(tok) || classify(tok) !== 'specific'),
		})
	}
	addPhrase(fp.subject, 'subject')
	for (const motif of fp.motifs) addPhrase(motif, 'motif')
	for (const printed of fp.printed_text) addPhrase(printed, 'printed')
	if (primaryCharacter) addPhrase(primaryCharacter, 'character')

	return {
		weights,
		phrases,
		subjectTokens: meaningfulTokens(fp.subject),
		product_type: fp.product_type,
		has_magsafe: fp.has_magsafe,
		has_charm: fp.has_charm,
		has_grip: fp.has_grip,
		characters,
		primaryCharacter,
		characterSet: new Set(characters),
		bumperColor: fp.bumper_color,
		composition: fp.composition,
		empty: weights.size === 0 && !phrases.length,
	}
}

function distinctiveExtras(item) {
	const charToks = new Set()
	for (const name of item.characters || []) {
		for (const tok of tokenise(name)) charToks.add(tok)
	}
	let n = 0
	for (const tok of item.set) {
		if (charToks.has(tok) || WEAK_PRINT.has(tok)) continue
		const klass = classify(tok)
		if (klass === 'filler' || klass === 'device' || klass === 'color' || klass === 'aesthetic') continue
		n++
	}
	return n
}

function idfFactor(token, df, nDocs) {
	const docs = Math.max(1, nDocs)
	const seen = df.get(token) || 0
	return Math.min(3.2, 0.65 + 0.55 * Math.log((docs + 1) / (seen + 1)))
}

function phraseBonus(role, specificCount, weakOnly) {
	if (weakOnly) return 0.35
	if (role === 'character') return 9
	if (role === 'subject') return 8 + 1.5 * specificCount
	if (role === 'printed') return 5
	return 2.2 + specificCount
}

function scoreRow(item, query, df, nDocs) {
	let overlap = 0
	let specificHits = 0
	for (const { token, klass, weight } of query.weights.values()) {
		if (!item.set.has(token)) continue
		const contrib = Math.min(5, weight * idfFactor(token, df, nDocs))
		overlap += contrib
		if (klass === 'specific' && !WEAK_PRINT.has(token)) specificHits += 1
	}
	const distinctiveTitleCount = Math.max(
		4,
		[...item.set].filter((tok) => classify(tok) === 'specific' && !WEAK_PRINT.has(tok)).length,
	)
	overlap *= Math.min(1.06, Math.max(0.9, 4.8 / Math.sqrt(distinctiveTitleCount)))

	let score = overlap
	let phraseHits = 0
	let contiguousSubject = false
	const credited = []
	const alreadyCovered = (tokens) =>
		credited.some((prev) => tokens.every((tok) => prev.includes(tok)) && prev.length >= tokens.length)

	for (const { tokens, role, specificCount, weakOnly } of query.phrases) {
		if (!tokens.length) continue
		const contiguous = hasContiguous(item.tokens, tokens)
		if (!contiguous) continue
		if (alreadyCovered(tokens)) continue
		credited.push(tokens)
		phraseHits += 1
		if (role === 'subject') contiguousSubject = true
		score += phraseBonus(role, specificCount, weakOnly)
	}

	const titleLead = titleLeadsWith(item.tokens, query.subjectTokens)
	if (titleLead) score += 6
	else if (contiguousSubject) {
		score += 1.5
		const idx = firstContiguousIndex(item.tokens, query.subjectTokens)
		if (idx === 1) score += 3.2
		else if (idx > 1 && idx <= 3) score += 1.1
	}

	if (query.primaryCharacter) {
		const hitPrimary = item.characters.has(query.primaryCharacter)
		const hitSupport = query.characters.slice(1).some((name) => item.characters.has(name))
		if (!hitPrimary && !hitSupport) {
			return { score: 0, specificHits: 0, phraseHits: 0, contiguousSubject: false, titleLead: false }
		}
		if (hitPrimary) score += 12
		else score += 2.5
		if (hitPrimary && hitSupport) score += 0.45
		let extra = 0
		for (const name of item.characters) {
			if (!query.characterSet.has(name)) extra += 1
		}
		if (extra) score -= 12 * extra
	}

	if (query.bumperColor && bumperColorTerms(query.bumperColor).some((term) => item.set.has(term))) {
		score += 5.5
	}
	if (query.has_magsafe && item.set.has('magsafe')) score += 0.4
	if (!query.has_magsafe && item.set.has('magsafe')) score -= 1.8
	if (query.has_charm && (item.set.has('charm') || item.set.has('挂件'))) score += 0.5
	if (query.has_grip && (item.set.has('grip') || item.set.has('holder'))) score += 0.35
	if (!query.has_grip && (item.set.has('grip') || item.set.has('holder') || item.set.has('shaker'))) {
		score -= 1.6
	}
	if (query.composition === 'sticker_collage') {
		const collageish = item.set.has('sticker') || item.set.has('collage') || item.set.has('decal')
		const gripish = item.set.has('grip') || item.set.has('holder') || item.set.has('shaker')
		if (gripish && !collageish) score -= 2.2
	}
	if (query.primaryCharacter && distinctiveExtras(item) < 1) score *= 0.72

	score *= productTypeMultiplier(item.row && item.row.title, query.product_type)
	if (score < 0) score = 0

	// Hardware and colour-only overlap is how every MagSafe case used to win.
	// A real print name always contributes at least one specific token.
	if (specificHits < 1 && !query.primaryCharacter) {
		return { score: 0, specificHits: 0, phraseHits: 0, contiguousSubject: false, titleLead: false }
	}
	if (specificHits < 1 && query.primaryCharacter && score < MIN_SCORE) {
		return { score: 0, specificHits: 0, phraseHits: 0, contiguousSubject: false, titleLead: false }
	}
	return { score, specificHits, phraseHits, contiguousSubject, titleLead }
}

function lexicalConfidence(row) {
	const score = Number(row && row.score) || 0
	const specificHits = Number(row && row.specificHits) || 0
	const phraseHits = Number(row && row.phraseHits) || 0
	if ((specificHits >= 3 && score >= 8) || (phraseHits >= 1 && specificHits >= 2 && score >= 7)) return 'likely'
	if ((specificHits >= 2 && score >= 4.5) || (phraseHits >= 1 && score >= 5)) return 'possible'
	if (score >= MIN_SCORE) return 'weak'
	return 'distant'
}

function visionConfidence(score) {
	const n = Number(score)
	if (!Number.isFinite(n)) return 'distant'
	for (const band of CONF_FROM_VISION) {
		if (n >= band.min) return band.id
	}
	return 'distant'
}

function uniqueLexicalWinner(scored, fingerprint) {
	if (!scored.length) return false
	if (fingerprint && !hasDistinctivePrintName(fingerprint)) return false
	const top = scored[0]
	if (top.specificHits < 2 || top.score < 8) return false
	if (!top.titleLead || !top.contiguousSubject) return false
	const second = scored[1]
	if (!second) return true
	return !second.titleLead
}

function needsVisualRerank(scored, fingerprint) {
	if (!scored.length) return false
	if (fingerprint && extractCharacters(fingerprint).length) return true
	return !uniqueLexicalWinner(scored, fingerprint)
}

function catalogKey(row) {
	const ck = String((row && row.canonical_product_key) || '').trim()
	if (ck) return 'ck:' + ck
	const tn = String((row && row.title_norm) || '').trim()
	if (tn) return 'tn:' + tn
	if (row && row.id != null) return 'id:' + Number(row.id)
	return 'title:' + String((row && row.title) || '')
}

function preferActive(rows) {
	const map = new Map()
	for (const row of rows) {
		const key = catalogKey(row)
		const prev = map.get(key)
		if (!prev || (prev.status !== 'active' && row.status === 'active')) map.set(key, row)
	}
	return [...map.values()]
}

function loadCatalogRows(db) {
	let rows = []
	try {
		rows = db.prepare(
			'SELECT id, title, title_norm, shop_name, stall, canonical_product_key, status FROM product_map',
		).all()
	} catch {
		return []
	}
	return preferActive(rows).filter((row) => String(row.title || '').trim())
}

function loadListingLookups(db) {
	const byNorm = new Map()
	const byCanon = new Map()
	try {
		for (const row of db.prepare('SELECT listing_id, title FROM listings WHERE title IS NOT NULL').all()) {
			const tn = normalizeTitle(row.title)
			if (tn && !byNorm.has(tn)) byNorm.set(tn, Number(row.listing_id))
		}
	} catch {
		/* stripped test schemas omit listings */
	}
	try {
		for (const row of db.prepare(
			`SELECT listing_id, canonical_key FROM listing_phash
			 WHERE canonical_key IS NOT NULL AND TRIM(canonical_key) != ''`,
		).all()) {
			const ck = String(row.canonical_key || '').trim()
			if (ck && !byCanon.has(ck)) byCanon.set(ck, Number(row.listing_id))
		}
	} catch {
		/* listing_phash optional */
	}
	return { byNorm, byCanon }
}

function listingIdFor(row, lookups) {
	const ck = String((row && row.canonical_product_key) || '').trim()
	if (ck && lookups.byCanon.has(ck)) return lookups.byCanon.get(ck)
	const tn = String((row && row.title_norm) || normalizeTitle(row && row.title) || '').trim()
	if (tn && lookups.byNorm.has(tn)) return lookups.byNorm.get(tn)
	return null
}

function listingImageBytes(db, listingId) {
	if (!listingId) return null
	try {
		const row = db.prepare('SELECT data FROM listing_image_data WHERE listing_id = ?').get(listingId)
		if (row && row.data && row.data.length) return row.data
	} catch {
		return null
	}
	return null
}

function scoreCatalogRows(rows, fingerprint, lookups) {
	const query = buildQueryModel(fingerprint)
	if (query.empty) return []
	const prepared = []
	for (const row of rows) {
		const tokens = tokenise(row.title || '')
		prepared.push({
			row,
			tokens,
			set: catalogTokenSet(tokens),
			characters: new Set(charactersInText(row.title || '')),
		})
	}
	const nDocs = Math.max(1, prepared.length)
	const df = new Map()
	for (const item of prepared) {
		for (const token of item.set) df.set(token, (df.get(token) || 0) + 1)
	}

	const scored = []
	for (const item of prepared) {
		const bits = scoreRow(item, query, df, nDocs)
		if (bits.score < MIN_SCORE) continue
		const listingId = listingIdFor(item.row, lookups || { byNorm: new Map(), byCanon: new Map() })
		scored.push({
			...item.row,
			title_norm: item.row.title_norm || normalizeTitle(item.row.title),
			listing_id: listingId,
			score: bits.score,
			specificHits: bits.specificHits,
			phraseHits: bits.phraseHits,
			contiguousSubject: bits.contiguousSubject,
			titleLead: bits.titleLead,
		})
	}
	scored.sort(
		(a, b) =>
			Number(b.titleLead) - Number(a.titleLead) ||
			Number(b.contiguousSubject) - Number(a.contiguousSubject) ||
			b.score - a.score ||
			(String(b.shop_name || '').trim() ? 1 : 0) - (String(a.shop_name || '').trim() ? 1 : 0) ||
			String(a.title || '').localeCompare(String(b.title || '')),
	)
	return scored.slice(0, LEXICAL_POOL)
}

function toVisionMatch(row, confidence) {
	const listingId = row.listing_id ? Number(row.listing_id) : null
	const shopName = String(row.shop_name || '').trim()
	const stall = String(row.stall || '').trim()
	const title = String(row.title || '').trim()
	return {
		listing_id: listingId,
		title,
		title_norm: String(row.title_norm || normalizeTitle(title)).trim(),
		shop_name: shopName,
		stall,
		location: resolveLocation(stall, shopName),
		image_url: listingId ? `/api/route/listing-image/${listingId}?w=300` : '',
		distance: null,
		confidence,
		match_kind: 'vision',
		vision_evidence: row.vision_evidence || 'lexical',
		canonical_product_key: String(row.canonical_product_key || '').trim(),
		catalog_id: row.id != null ? Number(row.id) : null,
		vision_score: Number(row.score) || 0,
	}
}

function isVisualOutlier(row) {
	return Boolean(row && (row.mass_outlier || row.hue_outlier || row.layout_outlier))
}

function clearRetrievedWinner(scored) {
	if (!scored.length) return false
	const top = scored[0]
	if (isVisualOutlier(top)) return false
	const second = scored[1]
	if (!second) return (Number(top.score) || 0) >= 10
	if (isVisualOutlier(second) && (Number(top.score) || 0) >= MIN_SCORE * 2) return true
	return (Number(top.score) || 0) >= 16 && (Number(top.score) || 0) >= (Number(second.score) || 0) * 1.18
}

function matchesFromLexical(scored, fingerprint) {
	const unique = uniqueLexicalWinner(scored, fingerprint)
	const clear = unique || clearRetrievedWinner(scored)
	const limit = unique ? MAX_RESULTS : AMBIGUOUS_RESULTS
	const out = []
	for (let i = 0; i < scored.length; i++) {
		const row = scored[i]
		let confidence = lexicalConfidence(row)
		if (unique && i > 0 && (confidence === 'exact' || confidence === 'likely')) confidence = 'possible'
		if (!unique && !clear && confidence === 'likely') confidence = 'possible'
		if (clear && i === 0 && (confidence === 'possible' || confidence === 'weak')) confidence = 'likely'
		if (confidence === 'distant') continue
		out.push(toVisionMatch({ ...row, vision_evidence: 'lexical' }, confidence))
		if (out.length >= limit) break
	}
	return out
}

function applyRerank(scored, decisions, fingerprint) {
	const byIndex = new Map()
	for (const decision of Array.isArray(decisions) ? decisions : []) {
		const index = Number(decision && decision.index)
		if (!Number.isInteger(index) || index < 1) continue
		const samePrint = decision.same_print !== false
		if (!samePrint) continue
		const confidence = visionConfidence(decision.confidence)
		if (confidence === 'distant') continue
		const row = scored[index - 1]
		if (!row || byIndex.has(index)) continue
		byIndex.set(index, toVisionMatch({ ...row, vision_evidence: 'rerank' }, confidence))
	}
	const rank = { exact: 0, likely: 1, possible: 2, weak: 3, distant: 4 }
	const ranked = [...byIndex.entries()]
		.map((entry) => entry[1])
		.sort((a, b) => (rank[a.confidence] ?? 9) - (rank[b.confidence] ?? 9) || String(a.title).localeCompare(String(b.title)))
	if (ranked.length) return ranked.slice(0, MAX_RESULTS)
	return matchesFromLexical(scored, fingerprint)
}

function hasVisionProvider() {
	return Boolean(String((config.openai && config.openai.visionApiKey) || '').trim())
}

function visionIsEnabled(opts) {
	if (opts && opts.vision === false) return false
	if (opts && opts.vision && typeof opts.vision === 'object') return true
	if (/^(0|false|off)$/i.test(String(process.env.FIND_BY_PHOTO_VISION || ''))) return false
	return hasVisionProvider()
}

let _OpenAI = null
function liveOpenAiClient() {
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

function isReasoningModel(model) {
	if (/qwen/i.test(model || '')) return false
	return /^(gpt-5|o1|o3|o4)/.test(model || '')
}

function isExternalReasoningModel(model) {
	return /qwen|glm|deepseek|grok/i.test(model || '')
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

function unwrapParsed(parsed) {
	if (Array.isArray(parsed)) {
		const objects = parsed.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
		if (objects.length) return objects[0]
	}
	return parsed
}

function contentText(content) {
	if (typeof content === 'string') return content
	if (Array.isArray(content)) {
		return content.map((part) => (typeof part === 'string' ? part : (part && part.text) || '')).join('')
	}
	return ''
}

async function callJson(client, { messages, schema, maxTokens, temperature }) {
	const useModel = config.openai.visionModel || 'gpt-5.4'
	const openaiReasoning = isReasoningModel(useModel)
	const externalReasoning = isExternalReasoningModel(useModel)
	let dropReasoning = false
	const build = (format) => {
		const body = { model: useModel, messages, response_format: format }
		if (openaiReasoning) {
			const effort = config.openai.reasoningEffort
			if (effort && effort !== 'default') body.reasoning_effort = effort
		} else {
			body.temperature = temperature == null ? 0 : temperature
			if (maxTokens) body.max_tokens = maxTokens
		}
		if (externalReasoning && !dropReasoning) {
			// OpenRouter: enabled:false turns thinking off. exclude:true still thinks.
			body.reasoning = { enabled: false }
		}
		return body
	}

	let format = externalReasoning
		? { type: 'json_object' }
		: { type: 'json_schema', json_schema: schema }
	let lastErr = null
	for (let attempt = 1; attempt <= 2; attempt++) {
		let resp
		try {
			resp = await client.chat.completions.create(build(format))
		} catch (err) {
			lastErr = err
			const body = err.response?.data?.error?.message || err.error?.message || err.message || ''
			if (format.type === 'json_schema' && /response_format|json_schema|not supported/i.test(body)) {
				format = { type: 'json_object' }
				continue
			}
			if (externalReasoning && !dropReasoning && /reasoning|thinking|not supported/i.test(body)) {
				dropReasoning = true
				continue
			}
			const status = err.status || err.response?.status
			const timeoutLike = /timeout|aborted|ETIMEDOUT/i.test(err.message || '')
			if (timeoutLike) throw err
			const transient =
				/ECONNRESET|ENOTFOUND/i.test(err.message || '') ||
				status === 429 ||
				(status >= 500 && status < 600)
			if (transient && attempt < 2) continue
			throw err
		}
		const raw = contentText(resp.choices?.[0]?.message?.content)
		if (!raw.trim()) {
			lastErr = new Error('Vision model returned an empty response')
			continue
		}
		try {
			return unwrapParsed(JSON.parse(extractJson(raw)))
		} catch (err) {
			lastErr = err
		}
	}
	throw lastErr || new Error('Vision model returned unparsable JSON')
}

function imagePart(jpeg, detail) {
	return {
		type: 'image_url',
		image_url: { url: 'data:image/jpeg;base64,' + jpeg.toString('base64'), detail: detail || 'low' },
	}
}

async function encodeJpeg(buf, edge, quality) {
	return sharp(buf, { failOn: 'none' })
		.rotate()
		.resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
		.jpeg({ quality, mozjpeg: false })
		.toBuffer()
}

const DESCRIBE_SCHEMA = {
	name: 'photo_locate_fingerprint',
	strict: true,
	schema: {
		type: 'object',
		additionalProperties: false,
		properties: {
			product_type: { type: 'string' },
			subject: { type: 'string' },
			visual_summary: { type: 'string' },
			motifs: { type: 'array', items: { type: 'string' } },
			colors: { type: 'array', items: { type: 'string' } },
			printed_text: { type: 'array', items: { type: 'string' } },
			characters: { type: 'array', items: { type: 'string' } },
			composition: { type: 'string' },
			bumper_color: { type: 'string' },
			search_phrases: { type: 'array', items: { type: 'string' } },
		},
		required: [
			'product_type',
			'subject',
			'visual_summary',
			'motifs',
			'colors',
			'printed_text',
			'characters',
			'composition',
			'bumper_color',
			'search_phrases',
		],
	},
}

const DESCRIBE_PROMPT = `Name the printed design on this phone snapshot for catalog search. JSON only.

Ignore the phone body, MagSafe ring, grip/charm accessories, plastic packaging, and the table/background. Only the print on the case.

Known characters (use these exact names when they are visible ON THE PRINT, not on a dangling charm):
${catalogPromptBlock()}

subject: 2–6 words, Title Case. MUST include the distinctive trait a listing title would use — colour family (Pastel, Red), primary character, or named print. Never return bare "Polka Dots" or "iPhone Case" when the print has a colour or name; write "Pastel Polka Dots", "Pink Lily Flower", "Kuromi Sticker Collage".
characters: characters actually drawn on the case, primary first. Empty array if none. Never list a character that is not on this print.
composition: sticker_collage | centered_character | geometric | floral | text | other
bumper_color: colour of the camera-island RING (Lavender, Pink, Red, Blue, Black). "" if the ring is clear or missing. This is NOT MagSafe.
printed_text: exact words printed on the case (e.g. KUROMI). Empty if none.
visual_summary: one sentence of the print layout, bumper colour, and any logo bar.
colors: 1–3 colour-family words for the PRINT and bumper, not the table.
motifs: conventional name plus visual synonyms.
search_phrases: 3 short queries for THIS exact print.
product_type: iphone_case | airpods_case | charm | watch_band | other`

function rerankPrompt(fingerprint, candidates) {
	const fp = normalizeFingerprint(fingerprint)
	const chars = extractCharacters(fp)
	const lines = candidates.map((c, i) => {
		const photo = c.jpeg ? 'listing photo attached' : 'title only, no listing photo'
		return `${i + 1}. ${c.title} — shop ${c.shop_name || '?'} (${photo})`
	})
	return `QUERY is a phone snapshot of a physical product (often still in packaging, on a table). Candidates 1..${candidates.length} are catalog listings. Studio lighting, hands, and backgrounds will differ — match the PRINTED ARTWORK.

Printed design on QUERY:
subject: ${fp.subject || '(none)'}
characters: ${chars.join(', ') || '(none)'}
composition: ${fp.composition || '(none)'}
bumper_color: ${fp.bumper_color || '(none)'}
printed_text: ${(fp.printed_text || []).join(', ') || '(none)'}
motifs: ${fp.motifs.join(', ') || '(none)'}
summary: ${fp.visual_summary || '(none)'}

${lines.join('\n')}

Return every listing whose PRINTED DESIGN is the same product as QUERY, best first, at most 3.
QUERY is often a packaged table snap; candidates are studio shots. Lighting, hands, plastic wrap, and background WILL differ. That is not a mismatch.
same_print=true when the artwork layout matches: the same sticker arrangement, camera-bumper colour, and printed logo bar.
Same character franchise is NOT enough. A Kuromi collage with a lavender bumper and a KUROMI logo bar is not the same print as a pink gothic Kuromi collage or a Hello Kitty collage.
A shared MagSafe ring, a shared clear case, or a shared keyword like "sticker collage" is NOT a match.
If you see the same print, return it with confidence 70–95 even when the photo style differs. Empty matches only when no candidate shows that artwork.`
}

const RERANK_SCHEMA = {
	name: 'photo_locate_rerank',
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

async function liveDescribe(jpeg) {
	const client = liveOpenAiClient()
	if (!client) throw new Error('Vision provider is not configured')
	const parsed = await callJson(client, {
		schema: DESCRIBE_SCHEMA,
		maxTokens: DESCRIBE_MAX_TOKENS,
		temperature: 0,
		messages: [
			{ role: 'system', content: DESCRIBE_PROMPT },
			{
				role: 'user',
				content: [
					{ type: 'text', text: 'QUERY print name as JSON.' },
					imagePart(jpeg, 'high'),
				],
			},
		],
	})
	return normalizeFingerprint(parsed)
}

function payloadTooLarge(err) {
	const status = Number(err && (err.status || (err.response && err.response.status))) || 0
	const body = String((err && (err.message || (err.error && err.error.message))) || '')
	return status === 400 || status === 413 || /too many|image|payload|context length|max.*token/i.test(body)
}

async function liveRerankOnce(client, { queryJpeg, fingerprint, candidates }) {
	const content = [{ type: 'text', text: rerankPrompt(fingerprint, candidates) }, imagePart(queryJpeg, 'low')]
	for (let i = 0; i < candidates.length; i++) {
		const jpeg = candidates[i].jpeg
		if (!jpeg) continue
		content.push({ type: 'text', text: `Candidate ${i + 1}` })
		content.push(imagePart(jpeg, 'low'))
	}
	const parsed = await callJson(client, {
		schema: RERANK_SCHEMA,
		maxTokens: RERANK_MAX_TOKENS,
		temperature: 0,
		messages: [
			{
				role: 'system',
				content:
					'You match catalog listing photos to a phone snapshot by printed artwork. Same character is not the same product. Lighting, packaging, and hands will differ.',
			},
			{ role: 'user', content },
		],
	})
	return Array.isArray(parsed && parsed.matches) ? parsed.matches : []
}

const SHEET_TILE = 240

async function fitSheetTile(buf, edge) {
	const inner = await sharp(buf, { failOn: 'none' })
		.rotate()
		.resize(edge, edge, { fit: 'inside' })
		.jpeg({ quality: 72, mozjpeg: false })
		.toBuffer()
	const meta = await sharp(inner, { failOn: 'none' }).metadata()
	const width = Number(meta.width) || edge
	const height = Number(meta.height) || edge
	const left = Math.max(0, Math.floor((edge - width) / 2))
	const top = Math.max(0, Math.floor((edge - height) / 2))
	return sharp({
		create: { width: edge, height: edge, channels: 3, background: { r: 18, g: 18, b: 24 } },
	})
		.composite([{ input: inner, left, top }])
		.jpeg({ quality: 72, mozjpeg: false })
		.toBuffer()
}

async function composePairSheet(queryJpeg, listingJpeg) {
	const [left, right] = await Promise.all([
		fitSheetTile(queryJpeg, SHEET_TILE),
		fitSheetTile(listingJpeg, SHEET_TILE),
	])
	return sharp({
		create: {
			width: SHEET_TILE * 2,
			height: SHEET_TILE,
			channels: 3,
			background: { r: 12, g: 12, b: 16 },
		},
	})
		.composite([
			{ input: left, left: 0, top: 0 },
			{ input: right, left: SHEET_TILE, top: 0 },
		])
		.jpeg({ quality: 74, mozjpeg: false })
		.toBuffer()
}

function sheetRerankPrompt(fingerprint, candidate) {
	const fp = normalizeFingerprint(fingerprint)
	const chars = extractCharacters(fp)
	return `This single image is a contact sheet.
LEFT = QUERY: a phone snapshot of a physical product (often still in packaging, on a table).
RIGHT = CATALOG listing photo (usually a studio shot).

Listing title: ${candidate.title || ''}
Shop: ${candidate.shop_name || '?'}

Printed design on QUERY:
subject: ${fp.subject || '(none)'}
characters: ${chars.join(', ') || '(none)'}
composition: ${fp.composition || '(none)'}
bumper_color: ${fp.bumper_color || '(none)'}
printed_text: ${(fp.printed_text || []).join(', ') || '(none)'}
summary: ${fp.visual_summary || '(none)'}

Match the PRINTED ARTWORK. Lighting, hands, plastic wrap, and background WILL differ. That is not a mismatch.
same_print=true only when the artwork layout matches: sticker arrangement, camera-bumper colour, and any printed logo bar.
Same character franchise is NOT enough. A Kuromi collage with a lavender bumper and a KUROMI logo bar is not a pink gothic Kuromi collage or a repeating-face wash.
Return JSON matches for index 1 only. Empty matches if the prints differ.`
}

async function liveRerankSheet(client, { sheetJpeg, fingerprint, candidate }) {
	const parsed = await callJson(client, {
		schema: RERANK_SCHEMA,
		maxTokens: RERANK_MAX_TOKENS,
		temperature: 0,
		messages: [
			{
				role: 'system',
				content:
					'You match a catalog listing photo to a phone snapshot by printed artwork. The user image is a left/right contact sheet. Same character is not the same product.',
			},
			{
				role: 'user',
				content: [{ type: 'text', text: sheetRerankPrompt(fingerprint, candidate) }, imagePart(sheetJpeg, 'high')],
			},
		],
	})
	return Array.isArray(parsed && parsed.matches) ? parsed.matches : []
}

async function liveRerank({ queryJpeg, fingerprint, candidates }) {
	const client = liveOpenAiClient()
	if (!client) throw new Error('Vision provider is not configured')
	const pool = Array.isArray(candidates) ? candidates : []
	const photoIdx = []
	for (let i = 0; i < pool.length; i++) {
		if (pool[i] && pool[i].jpeg) photoIdx.push(i)
	}
	if (!photoIdx.length) {
		return liveRerankOnce(client, { queryJpeg, fingerprint, candidates: pool.slice(0, RERANK_CAP) })
	}

	const batchIdx = photoIdx.slice(0, 2)
	try {
		const batch = batchIdx.map((i) => pool[i])
		const raw = await liveRerankOnce(client, { queryJpeg, fingerprint, candidates: batch })
		return (Array.isArray(raw) ? raw : [])
			.map((d) => {
				const local = Number(d && d.index)
				if (!Number.isInteger(local) || local < 1 || local > batchIdx.length) return null
				return { ...d, index: batchIdx[local - 1] + 1 }
			})
			.filter(Boolean)
	} catch (err) {
		if (!payloadTooLarge(err)) throw err
		if (process.env.FIND_BY_PHOTO_DEBUG) {
			console.error('[find-by-photo-vision] batch rerank failed, contact-sheet fallback:', err && err.message)
		}
	}

	const decisions = []
	const cap = Math.min(2, photoIdx.length)
	for (let n = 0; n < cap; n++) {
		const i = photoIdx[n]
		let sheet
		try {
			sheet = await composePairSheet(queryJpeg, pool[i].jpeg)
		} catch {
			continue
		}
		let one = []
		try {
			one = await liveRerankSheet(client, { sheetJpeg: sheet, fingerprint, candidate: pool[i] })
		} catch (err) {
			if (process.env.FIND_BY_PHOTO_DEBUG) {
				console.error('[find-by-photo-vision] sheet rerank failed:', n, err && err.message)
			}
			if (payloadTooLarge(err)) break
			continue
		}
		for (const d of one) {
			if (!d || d.same_print === false) continue
			const conf = Number(d.confidence)
			if (!Number.isFinite(conf) || conf < 40) continue
			decisions.push({ ...d, index: i + 1 })
			if (conf >= 78) return decisions
		}
	}
	return decisions
}

function liveRerankEnabled() {
	return !/^(0|false|off)$/i.test(String(process.env.FIND_BY_PHOTO_RERANK || ''))
}

function liveVisionClient() {
	const client = { describe: liveDescribe }
	if (liveRerankEnabled()) client.rerank = liveRerank
	return client
}

function resolveVisionClient(injected) {
	if (injected && typeof injected === 'object') return injected
	return liveVisionClient()
}

async function prepareQueryJpeg(buf) {
	return encodeJpeg(buf, QUERY_EDGE, QUERY_JPEG_QUALITY)
}

function demoteLayoutOutliers(items) {
	const vals = items
		.map((item) => Number(item && item.layout_similarity))
		.filter((n) => Number.isFinite(n) && n > 0)
	if (vals.length < 3) return items
	const sorted = [...vals].sort((a, b) => a - b)
	const median = sorted[Math.floor(sorted.length / 2)]
	if (median < 0.12) return items
	const floor = median * 0.72
	return items.map((item) => {
		const layout = Number(item && item.layout_similarity)
		if (!Number.isFinite(layout) || layout <= 0 || layout >= floor) return item
		const nextScore = (Number(item.score != null ? item.score : item.row && item.row.score) || 0) * 0.3
		const row = item.row ? { ...item.row, score: nextScore } : item.row
		return { ...item, row, score: nextScore, layout_outlier: true }
	})
}

function compareRetrieved(a, b, fingerprint) {
	if (fingerprint && hasDistinctivePrintName(fingerprint)) {
		return (
			Number(b.titleLead) - Number(a.titleLead) ||
			Number(b.contiguousSubject) - Number(a.contiguousSubject) ||
			(b.score || 0) - (a.score || 0) ||
			String(a.title || '').localeCompare(String(b.title || ''))
		)
	}
	const aOut = Number(isVisualOutlier(a))
	const bOut = Number(isVisualOutlier(b))
	if (aOut !== bOut) return aOut - bOut
	const named = (row) => (String((row && row.shop_name) || '').trim() ? 1 : 0)
	if (named(a) !== named(b) && Math.abs((Number(b.score) || 0) - (Number(a.score) || 0)) < 3) {
		return named(b) - named(a)
	}
	return (
		(Number(b.score) || 0) - (Number(a.score) || 0) ||
		named(b) - named(a) ||
		String(a.title || '').localeCompare(String(b.title || ''))
	)
}

function mergeVisualAdjustments(scored, visuallyScored, fingerprint) {
	const byKey = new Map()
	for (const item of visuallyScored || []) {
		if (item && item.row) byKey.set(catalogKey(item.row), item)
	}
	const adjusted = scored.map((row) => {
		const hit = byKey.get(catalogKey(row))
		if (!hit) return row
		const score = Number(hit.score != null ? hit.score : row.score)
		return {
			...row,
			score: Number.isFinite(score) ? score : row.score,
			layout_similarity: hit.layout_similarity,
			hue_similarity: hit.hue_similarity,
			layout_outlier: Boolean(hit.layout_outlier),
			mass_outlier: Boolean(hit.mass_outlier),
			hue_outlier: Boolean(hit.hue_outlier),
		}
	})
	adjusted.sort((a, b) => compareRetrieved(a, b, fingerprint))
	return adjusted
}

async function attachThumbs(db, scored) {
	return Promise.all(
		(Array.isArray(scored) ? scored : []).map(async (row) => {
			let jpeg = null
			const bytes = listingImageBytes(db, row.listing_id)
			if (bytes) {
				try {
					jpeg = await encodeJpeg(bytes, THUMB_EDGE, THUMB_JPEG_QUALITY)
				} catch {
					jpeg = null
				}
			}
			return {
				title: row.title,
				shop_name: row.shop_name,
				stall: row.stall,
				jpeg,
				row,
				score: Number(row.score) || 0,
			}
		}),
	)
}

async function searchWithVision(db, imageBuf, injected, opts = {}) {
	const rows = loadCatalogRows(db)
	if (!rows.length) return { matches: [], query: null }

	const client = resolveVisionClient(injected)
	if (typeof client.describe !== 'function') {
		return { matches: [], query: null, error: 'vision_unavailable' }
	}

	const queryJpeg =
		opts && Buffer.isBuffer(opts.queryJpeg) ? opts.queryJpeg : await prepareQueryJpeg(imageBuf)
	let fingerprint
	try {
		fingerprint = normalizeFingerprint(await client.describe(queryJpeg))
	} catch (err) {
		if (process.env.FIND_BY_PHOTO_DEBUG) {
			console.error('[find-by-photo-vision] describe failed:', err && err.message)
		}
		return { matches: [], query: null, error: 'vision_failed' }
	}
	const lookups = loadListingLookups(db)
	let scored = scoreCatalogRows(rows, fingerprint, lookups)
	if (!scored.length) return { matches: [], query: fingerprint }

	const preview = scored.slice(0, VISUAL_SCORE_CAP)
	const withThumbs = await attachThumbs(db, preview)
	let visuallyScored = withThumbs
	try {
		const querySig = await visual.computeVisualSignature(queryJpeg)
		if (querySig) {
			visuallyScored = demoteLayoutOutliers(await visual.scoreSignatures(querySig, withThumbs))
			scored = mergeVisualAdjustments(scored, visuallyScored, fingerprint)
		}
	} catch {
		/* local prior is best-effort */
	}

	const canRerank = typeof client.rerank === 'function'
	if (!canRerank || !needsVisualRerank(scored, fingerprint)) {
		return { matches: matchesFromLexical(scored, fingerprint), query: fingerprint }
	}

	const shortlist = scored.slice(0, RERANK_CAP)
	const byKey = new Map()
	for (const item of visuallyScored) {
		if (item && item.row) byKey.set(catalogKey(item.row), item)
	}
	const candidates = shortlist.map((row) => {
		const hit = byKey.get(catalogKey(row))
		return {
			title: row.title,
			shop_name: row.shop_name,
			stall: row.stall,
			jpeg: hit ? hit.jpeg : null,
			row,
		}
	})
	let decisions = []
	try {
		decisions = await client.rerank({ queryJpeg, fingerprint, candidates })
		if (process.env.FIND_BY_PHOTO_DEBUG) {
			console.error(
				'[find-by-photo-vision] rerank',
				JSON.stringify({
					n: candidates.length,
					photos: candidates.filter((c) => c.jpeg).length,
					decisions,
				}),
			)
		}
	} catch (err) {
		if (process.env.FIND_BY_PHOTO_DEBUG) {
			const detail = (err && (err.response && err.response.data || err.error)) || ''
			console.error(
				'[find-by-photo-vision] rerank failed:',
				err && err.message,
				err && err.status,
				typeof detail === 'string' ? detail.slice(0, 400) : JSON.stringify(detail).slice(0, 400),
			)
		}
		return { matches: matchesFromLexical(scored, fingerprint), query: fingerprint }
	}
	return { matches: applyRerank(shortlist, decisions, fingerprint), query: fingerprint }
}

module.exports = {
	QUERY_EDGE,
	MIN_SCORE,
	MAX_RESULTS,
	WEAK_PRINT,
	normalizeFingerprint,
	publicQuery,
	buildQueryModel,
	scoreCatalogRows,
	lexicalConfidence,
	visionConfidence,
	uniqueLexicalWinner,
	hasDistinctivePrintName,
	extractCharacters,
	charactersInText,
	hasVisionProvider,
	visionIsEnabled,
	searchWithVision,
	matchesFromLexical,
	applyRerank,
	loadCatalogRows,
	prepareQueryJpeg,
	needsVisualRerank,
	clearRetrievedWinner,
	composePairSheet,
	TOKEN_CANON,
	AMBIGUOUS_RESULTS,
	RERANK_CAP,
	LEXICAL_POOL,
}
