'use strict'

/**
 * Curated reference catalog of third-party characters that may appear on source
 * images. Identification does NOT imply a license or permission to list them.
 * It exists to make AI character identification
 * accurate and auditable: the vision model is given these *distinguishing
 * visual cues* so it discriminates between look-alikes (e.g. a white-and-blue
 * Tamagotchi device vs. Cinnamoroll the puppy) instead of guessing from colour
 * alone, and we can validate / normalise whatever it returns.
 *
 * Each entry:
 *   name      canonical display name
 *   franchise rights holder / line
 *   destRoot  listings-root folder for this IP house (Sanrio, Miffy, …)
 *   nest      when true, file under destRoot/<Character>/
 *   aliases   alternative spellings the model might emit
 *   hints     extra folder-name tokens (CN/EN) used only by the cheap matcher
 *   cues      SHORT, decisive visual signatures (what to actually look for)
 *   confuses  common look-alikes (helps the model rule them out)
 */

const path = require('path')
const os = require('os')

const CATALOG = [
	// ── Sanrio ────────────────────────────────────────────────────────────────
	{ name: 'Cinnamoroll', franchise: 'Sanrio', destRoot: 'Sanrio', nest: true, aliases: ['cinnamon'], hints: ['玉桂狗', '大耳狗', '肉桂狗', 'シナモロール', 'cinnamoroll'], cues: 'chubby white puppy, very long floppy ears that let it fly, blue eyes, small blue/pink cheeks, curled cinnamon-roll tail', confuses: 'Pochacco (white dog, SHORT ears), generic white bunny, Tamagotchi (a device, not an animal)' },
	{ name: 'Hello Kitty', franchise: 'Sanrio', destRoot: 'Sanrio', nest: true, aliases: ['kitty', 'kitty white'], hints: ['hellokitty', 'hello kitty', '凯蒂猫', '凱蒂貓', 'kt猫', 'KT猫', 'ハローキティ'], cues: 'white cat head, red/pink bow on left ear, NO mouth, yellow oval nose, three whiskers each side', confuses: 'other white cats — the missing mouth + side bow is decisive' },
	{ name: 'My Melody', franchise: 'Sanrio', destRoot: 'Sanrio', nest: true, aliases: ['melody'], hints: ['mymelody', 'my melody', '美乐蒂', '美樂蒂', 'マイメロディ'], cues: 'white rabbit wearing a pink (sometimes red) hood with ears poking through, often a flower by the face', confuses: 'Kuromi (white face but BLACK jester hood + pink skull)' },
	{ name: 'Kuromi', franchise: 'Sanrio', destRoot: 'Sanrio', nest: true, aliases: [], hints: ['库洛米', '酷洛米', 'クロミ', 'kuromi'], cues: 'white face, BLACK jester/devil hood with a pink skull on it, little fangs, mischievous look', confuses: 'My Melody (pink hood, no skull)' },
	{ name: 'Pompompurin', franchise: 'Sanrio', destRoot: 'Sanrio', nest: true, aliases: ['pom pom purin', 'purin'], hints: ['pompompurin', '布丁狗', 'ポムポムプリン'], cues: 'golden-tan round Labrador puppy with a brown beret, lies flat', confuses: 'plain brown bears' },
	{ name: 'Pochacco', franchise: 'Sanrio', destRoot: 'Sanrio', nest: true, aliases: [], hints: ['pochacco', '帕恰狗', 'ポチャッコ'], cues: 'white dog with black floppy SHORT ears, black oval nose, sporty', confuses: 'Cinnamoroll (much longer ears)' },
	{ name: 'Keroppi', franchise: 'Sanrio', destRoot: 'Sanrio', nest: true, aliases: ['kero'], hints: ['keroppi', '可罗皮', 'けろけろけろっぴ'], cues: 'green frog, large round eyes set wide apart, V-shaped mouth, white belly', confuses: '' },
	{ name: 'Little Twin Stars', franchise: 'Sanrio', destRoot: 'Sanrio', nest: true, aliases: ['kiki and lala', 'kiki lala'], hints: ['双星仙子', 'kikilala', 'キキララ'], cues: 'twin star children (blue-haired boy Kiki, pink-haired girl Lala), stars and pastel sky', confuses: '' },
	{ name: 'Gudetama', franchise: 'Sanrio', destRoot: 'Sanrio', nest: true, aliases: [], hints: ['gudetama', '蛋黄哥', 'ぐでたま'], cues: 'lazy egg yolk with tiny arms/legs, droopy expression, often on egg white', confuses: '' },
	{ name: 'Badtz-Maru', franchise: 'Sanrio', destRoot: 'Sanrio', nest: true, aliases: ['badtz maru'], hints: ['badtzmaru', '酷企鹅', 'バッドばつ丸'], cues: 'black-and-white penguin with a spiky tuft of hair, pointy beak', confuses: '' },
	{ name: 'Tuxedo Sam', franchise: 'Sanrio', destRoot: 'Sanrio', nest: true, aliases: [], hints: ['tuxedosam', '山姆企鹅'], cues: 'chubby blue-and-white penguin wearing a bow tie', confuses: 'Badtz-Maru (black, spiky hair)' },

	// ── San-X ───────────────────────────────────────────────────────────────
	{ name: 'Rilakkuma', franchise: 'San-X', destRoot: 'San-X', nest: true, aliases: ['relax bear'], hints: ['rilakkuma', '轻松熊', '拉拉熊', 'リラックマ'], cues: 'soft brown bear with a red zipper/seam on the back, rounded ears, no nose tip colour', confuses: 'Korilakkuma (white), Pompompurin (yellow dog)' },
	{ name: 'Korilakkuma', franchise: 'San-X', destRoot: 'San-X', nest: true, aliases: ['kori'], hints: ['korilakkuma', '小白熊', 'コリラックマ'], cues: 'small WHITE bear with red cheeks and a red button on the chest', confuses: 'Rilakkuma (brown), generic white bear' },
	{ name: 'Sumikko Gurashi', franchise: 'San-X', destRoot: 'San-X', nest: true, aliases: ['sumikko'], hints: ['sumikkogurashi', '角落生物', 'すみっコ'], cues: 'group of timid pastel corner-dwelling blobs (penguin, cat, bear, tonkatsu)', confuses: '' },

	// ── Bandai / WiZ ────────────────────────────────────────────────────────
	{ name: 'Tamagotchi', franchise: 'Bandai', destRoot: 'Tamagotchi', nest: false, aliases: ['tamagochi', 'tamagotch', 'virtual pet'], hints: ['tamagotchi', '拓麻歌子', '塔麻可吉'], cues: 'an EGG-SHAPED handheld DEVICE (not an animal): oval body, a small square pixel screen, 3 buttons, often a keychain loop; pixel-art creatures like Mametchi may appear on the screen', confuses: 'Cinnamoroll / white animals — Tamagotchi is a gadget shaped like an egg, look for the screen + buttons' },
	{ name: 'Chiikawa', franchise: 'Nagano', destRoot: 'Chiikawa', nest: false, aliases: ['hachiware', 'usagi'], hints: ['chiikawa', '吉伊卡哇', 'ちいかわ'], cues: 'tiny round pale critters; Hachiware is a blue-eared white cat, Usagi a yellow rabbit, often teary big eyes', confuses: '' },

	// ── Pokemon ───────────────────────────────────────────────────────────────
	{ name: 'Pikachu', franchise: 'Pokemon', destRoot: 'Pokemon', nest: true, aliases: [], hints: ['pikachu', '皮卡丘'], cues: 'yellow mouse, long pointed ears with black tips, red cheeks, brown back stripes, lightning-bolt tail', confuses: '' },
	{ name: 'Eevee', franchise: 'Pokemon', destRoot: 'Pokemon', nest: true, aliases: [], hints: ['eevee', '伊布'], cues: 'brown fox/dog with a large fluffy cream neck ruff and bushy tail', confuses: '' },
	{ name: 'Gengar', franchise: 'Pokemon', destRoot: 'Pokemon', nest: true, aliases: [], hints: ['gengar', '耿鬼'], cues: 'round purple ghost with spiky back, wide toothy grin, red eyes', confuses: '' },

	// ── Other popular IP ───────────────────────────────────────────────────────
	{ name: 'Snoopy', franchise: 'Peanuts', destRoot: 'Peanuts', nest: false, aliases: ['peanuts'], hints: ['snoopy', '史努比'], cues: 'white beagle with black ears, simple line art, often with Woodstock (yellow bird)', confuses: 'white dogs — Snoopy is flat line-art, black ears' },
	{ name: 'Stitch', franchise: 'Disney', destRoot: 'Disney', nest: true, aliases: ['lilo and stitch', 'experiment 626'], hints: ['史迪奇', '史迪仔', 'stitch'], cues: 'blue koala-like alien, big dark eyes, long ears, wide toothy mouth, 4 limbs', confuses: '' },
	{ name: 'Mickey Mouse', franchise: 'Disney', destRoot: 'Disney', nest: true, aliases: ['mickey'], hints: ['mickey mouse', '米老鼠', '米奇'], cues: 'black mouse head with two perfectly round black ears, red shorts', confuses: 'Minnie (adds a bow)' },
	{ name: 'Minnie Mouse', franchise: 'Disney', destRoot: 'Disney', nest: true, aliases: ['minnie'], hints: ['minnie mouse', '米妮'], cues: 'mouse head with round ears + a big polka-dot bow', confuses: 'Mickey (no bow)' },
	{ name: 'Winnie the Pooh', franchise: 'Disney', destRoot: 'Disney', nest: true, aliases: ['pooh', 'pooh bear'], hints: ['winnie the pooh', '小熊维尼', '維尼'], cues: 'yellow-gold bear in a small red shirt, round tummy', confuses: 'Pompompurin (dog with beret), Rilakkuma (brown)' },
	{ name: 'Totoro', franchise: 'Studio Ghibli', destRoot: 'Ghibli', nest: false, aliases: ['my neighbor totoro'], hints: ['totoro', '龙猫', '龍貓'], cues: 'large grey forest spirit, white belly with grey chevrons, big round eyes, whiskers, holds a leaf', confuses: '' },
	{ name: 'Kuromi', franchise: 'Sanrio', destRoot: 'Sanrio', nest: true, aliases: [] }, // (dup-safe; matcher dedupes by name)
	{ name: 'Miffy', franchise: 'Mercis', destRoot: 'Miffy', nest: false, aliases: ['nijntje'], hints: ['miffy', '米菲', '米飛'], cues: 'simple white rabbit, tall straight ears, x-shaped mouth, flat colour blocks', confuses: 'My Melody (wears a hood)' },
	{ name: 'Doraemon', franchise: 'Fujiko Pro', destRoot: 'Doraemon', nest: false, aliases: [], hints: ['doraemon', '哆啦A梦', '哆啦A夢', '机器猫'], cues: 'blue robot cat, white face, red nose, whiskers, bell collar, belly pocket', confuses: '' },
	{ name: 'Molang', franchise: 'Molang', destRoot: 'Molang', nest: false, aliases: [], hints: ['molang', '土豆兔'], cues: 'plump pure-white rounded rabbit, tiny eyes, very minimal features', confuses: 'Korilakkuma (red cheeks/button), Cinnamoroll (long ears)' },
	{ name: 'Smiski', franchise: 'Dreams', destRoot: 'Smiski', nest: false, aliases: [], hints: ['smiski'], cues: 'soft green glow-in-the-dark humanoid figures in shy poses', confuses: '' },
	{ name: 'Care Bears', franchise: 'Care Bears', destRoot: 'Care Bears', nest: false, aliases: ['care bear'], hints: ['carebears', '爱心熊'], cues: 'colourful bears each with a belly badge/symbol, rainbow palette', confuses: '' },
]

const REVIEW_FOLDER = '_CharacterReview'
const ORIGINALS_FOLDER = 'Originals'
const OTHERS_FOLDER = 'OthersChars'
const MIXED_FOLDER = '_Mixed'

const GENERIC_CHARACTER_RE = /kawaii character|unknown|generic|^none$|n\/a|^various$|^original$|^no character$|sanrio characters/i

// Latin tokens that are too common to auto-file from a folder name alone.
const WEAK_LATIN = new Set([
	'kitty', 'melody', 'cinnamon', 'pooh', 'kero', 'purin', 'stitch',
	'mickey', 'minnie', 'peanuts', 'usagi', 'kori', 'sumikko',
])

const FRANCHISE_DEST = {
	sanrio: { destRoot: 'Sanrio', nest: true },
	'san-x': { destRoot: 'San-X', nest: true },
	mercis: { destRoot: 'Miffy', nest: false },
	disney: { destRoot: 'Disney', nest: true },
	pokemon: { destRoot: 'Pokemon', nest: true },
	bandai: { destRoot: 'Tamagotchi', nest: false },
	peanuts: { destRoot: 'Peanuts', nest: false },
	'studio ghibli': { destRoot: 'Ghibli', nest: false },
	'fujiko pro': { destRoot: 'Doraemon', nest: false },
	nagano: { destRoot: 'Chiikawa', nest: false },
	molang: { destRoot: 'Molang', nest: false },
	dreams: { destRoot: 'Smiski', nest: false },
	'care bears': { destRoot: 'Care Bears', nest: false },
}

const WIN_RESERVED = new Set(['con', 'prn', 'aux', 'nul', 'com1', 'com2', 'com3', 'com4', 'lpt1', 'lpt2', 'lpt3'])

// Deduplicate by name (keep the richest cue set) — guards against accidental dups.
const _byName = new Map()
for (const c of CATALOG) {
	const prev = _byName.get(c.name)
	if (!prev || (c.cues || '').length > (prev.cues || '').length) _byName.set(c.name, c)
}
const CHARACTERS = [..._byName.values()]

/**
 * Compact reference block for the vision prompt — names grouped with the
 * single most decisive cue, so the model discriminates look-alikes.
 */
function catalogPromptBlock() {
	const lines = CHARACTERS.filter((c) => c.cues).map((c) => `- ${c.name} (${c.franchise}): ${c.cues}${c.confuses ? `  [NOT: ${c.confuses}]` : ''}`)
	return lines.join('\n')
}

/** Lowercase lookup of name/alias → canonical entry. */
const _lookup = new Map()
for (const c of CHARACTERS) {
	_lookup.set(c.name.toLowerCase(), c)
	for (const a of c.aliases || []) _lookup.set(String(a).toLowerCase(), c)
	for (const h of c.hints || []) _lookup.set(String(h).toLowerCase(), c)
}

function isGenericCharacterName(raw) {
	const cleaned = String(raw || '').trim()
	if (!cleaned) return true
	return GENERIC_CHARACTER_RE.test(cleaned)
}

/**
 * Normalise a free-text character name to a catalog entry when possible.
 * Returns { name, franchise, known, destRoot, nest } — falls back to the cleaned input.
 */
function normaliseCharacter(raw) {
	const cleaned = String(raw || '').trim()
	if (!cleaned) return { name: '', franchise: '', known: false, destRoot: '', nest: true }
	if (isGenericCharacterName(cleaned)) {
		return { name: cleaned, franchise: '', known: false, destRoot: '', nest: true, generic: true }
	}
	const exact = _lookup.get(cleaned.toLowerCase())
	if (exact) return packEntry(exact)
	// Loose contains-match (e.g. "Cinnamoroll puppy")
	const low = cleaned.toLowerCase()
	let best = null
	let bestLen = 0
	for (const [key, entry] of _lookup) {
		if (key.length >= 4 && low.includes(key) && key.length > bestLen) {
			best = entry
			bestLen = key.length
		}
	}
	if (best) return packEntry(best)
	return { name: cleaned, franchise: '', known: false, destRoot: '', nest: true }
}

function packEntry(entry) {
	return {
		name: entry.name,
		franchise: entry.franchise,
		known: true,
		destRoot: entry.destRoot || '',
		nest: entry.nest !== false,
	}
}

function hasCjk(s) {
	return /[\u3400-\u9fff]/.test(s)
}

function tokenPresent(haystack, needle) {
	const n = String(needle || '').trim()
	if (!n) return false
	const hay = String(haystack || '')
	if (hasCjk(n)) return hay.includes(n)
	const lowHay = hay.toLowerCase()
	const lowNeedle = n.toLowerCase()
	if (lowNeedle.length <= 2) return false
	if (lowNeedle.includes(' ')) return lowHay.includes(lowNeedle)
	const re = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(lowNeedle)}(?:[^a-z0-9]|$)`, 'i')
	return re.test(lowHay)
}

function escapeRegExp(s) {
	return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function needleStrength(needle) {
	const n = String(needle || '').trim()
	if (!n) return 'weak'
	if (hasCjk(n)) return n.length >= 2 ? 'strong' : 'weak'
	const compact = n.toLowerCase().replace(/[\s_-]+/g, '')
	if (WEAK_LATIN.has(n.toLowerCase()) || WEAK_LATIN.has(compact)) return 'weak'
	if (compact.length >= 6) return 'strong'
	if (n.includes(' ') && compact.length >= 8) return 'strong'
	return compact.length >= 5 ? 'strong' : 'weak'
}

/**
 * Cheap, offline match of folder / file names against the catalog.
 * Longest needle wins per character. Multiple characters → caller must not auto-file.
 */
function matchNameHints(text) {
	const hay = String(text || '')
	if (!hay.trim()) return []
	const hits = []
	for (const entry of CHARACTERS) {
		const needles = [
			{ needle: entry.name, strength: needleStrength(entry.name) },
			...(entry.aliases || []).map((needle) => ({ needle, strength: needleStrength(needle) })),
			...(entry.hints || []).map((needle) => ({ needle, strength: needleStrength(needle) })),
		].sort((a, b) => String(b.needle).length - String(a.needle).length)

		let best = null
		for (const row of needles) {
			if (!tokenPresent(hay, row.needle)) continue
			if (!best || String(row.needle).length > String(best.needle).length) best = row
		}
		if (best) {
			hits.push({
				name: entry.name,
				franchise: entry.franchise,
				destRoot: entry.destRoot || '',
				nest: entry.nest !== false,
				matched: best.needle,
				strength: best.strength,
			})
		}
	}
	hits.sort((a, b) => {
		if (a.strength !== b.strength) return a.strength === 'strong' ? -1 : 1
		return String(b.matched).length - String(a.matched).length
	})
	return hits
}

function franchiseDest(franchise) {
	const key = String(franchise || '').trim().toLowerCase()
	return FRANCHISE_DEST[key] || null
}

function sanitizeFolderName(name) {
	let s = String(name || '')
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/[. ]+$/g, '')
	if (!s) s = 'Unknown'
	if (WIN_RESERVED.has(s.toLowerCase())) s = `_${s}`
	return s.slice(0, 80)
}

function stableCopyId(productKey) {
	return sanitizeFolderName(String(productKey || '').replace(/\\/g, '/').replace(/\//g, '__'))
}

function defaultHistoryRootFromEnv() {
	const fromEnv = String(process.env.LISTINGS_HISTORY_ROOT || '').trim()
	if (fromEnv) return path.resolve(fromEnv)
	return path.resolve(os.homedir(), 'OneDrive', 'Documents', 'E-Commerce', 'Etsy', 'Listings', 'History')
}

function defaultListingsRoot() {
	const fromEnv = String(process.env.LISTINGS_ROOT || '').trim()
	if (fromEnv) return path.resolve(fromEnv)
	return path.resolve(defaultHistoryRootFromEnv(), '..')
}

/**
 * Resolve where a classified product should be copied.
 * Identification is a filing signal, never a license.
 *
 * @returns {{
 *   destRoot: string,
 *   characterFolder: string,
 *   parts: string[],
 *   relative: string,
 * }}
 */
function destinationFor(input = {}) {
	const decision = String(input.decision || 'review')
	const copyId = stableCopyId(input.productKey || input.product_key || 'unknown')
	const name = String(input.name || '').trim()
	const franchise = String(input.franchise || '').trim()
	const known = input.known === true
	const generic = input.generic === true || isGenericCharacterName(name)

	if (decision === 'review') {
		const guess = sanitizeFolderName(known ? name : name || 'unknown')
		const reviewName = sanitizeFolderName(`maybe-${guess}__${copyId}`).slice(0, 100)
		return {
			destRoot: REVIEW_FOLDER,
			characterFolder: '',
			parts: [REVIEW_FOLDER, reviewName],
			relative: path.posix.join(REVIEW_FOLDER, reviewName),
		}
	}

	if (decision === 'original' || (generic && decision !== 'auto-unknown')) {
		return {
			destRoot: ORIGINALS_FOLDER,
			characterFolder: '',
			parts: [ORIGINALS_FOLDER, copyId],
			relative: path.posix.join(ORIGINALS_FOLDER, copyId),
		}
	}

	if (/sanrio characters/i.test(name) || (generic && /sanrio/i.test(franchise))) {
		return {
			destRoot: 'Sanrio',
			characterFolder: MIXED_FOLDER,
			parts: ['Sanrio', MIXED_FOLDER, copyId],
			relative: path.posix.join('Sanrio', MIXED_FOLDER, copyId),
		}
	}

	if (known) {
		const packed = normaliseCharacter(name)
		const destRoot = packed.destRoot || (franchiseDest(packed.franchise || franchise) || {}).destRoot || OTHERS_FOLDER
		const nest = packed.destRoot ? packed.nest : ((franchiseDest(packed.franchise || franchise) || {}).nest !== false)
		const characterFolder = nest && destRoot.toLowerCase() !== packed.name.toLowerCase()
			? sanitizeFolderName(packed.name)
			: ''
		const parts = characterFolder ? [destRoot, characterFolder, copyId] : [destRoot, copyId]
		return {
			destRoot,
			characterFolder,
			parts,
			relative: parts.join('/'),
		}
	}

	const house = franchiseDest(franchise)
	if (house && name) {
		const characterFolder = house.nest ? sanitizeFolderName(name) : ''
		const parts = characterFolder ? [house.destRoot, characterFolder, copyId] : [house.destRoot, copyId]
		return { destRoot: house.destRoot, characterFolder, parts, relative: parts.join('/') }
	}

	const otherName = sanitizeFolderName(name || 'Unknown')
	return {
		destRoot: OTHERS_FOLDER,
		characterFolder: otherName,
		parts: [OTHERS_FOLDER, otherName, copyId],
		relative: path.posix.join(OTHERS_FOLDER, otherName, copyId),
	}
}

module.exports = {
	CHARACTERS,
	REVIEW_FOLDER,
	ORIGINALS_FOLDER,
	OTHERS_FOLDER,
	MIXED_FOLDER,
	catalogPromptBlock,
	normaliseCharacter,
	isGenericCharacterName,
	matchNameHints,
	franchiseDest,
	sanitizeFolderName,
	stableCopyId,
	defaultListingsRoot,
	destinationFor,
}
