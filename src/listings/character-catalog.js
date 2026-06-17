'use strict'

/**
 * Curated reference catalog of the kawaii / Y2K characters that show up on the
 * phone cases this tool lists. It exists to make AI character identification
 * accurate and auditable: the vision model is given these *distinguishing
 * visual cues* so it discriminates between look-alikes (e.g. a white-and-blue
 * Tamagotchi device vs. Cinnamoroll the puppy) instead of guessing from colour
 * alone, and we can validate / normalise whatever it returns.
 *
 * Each entry:
 *   name      canonical display name
 *   franchise rights holder / line
 *   aliases   alternative spellings the model might emit
 *   cues      SHORT, decisive visual signatures (what to actually look for)
 *   confuses  common look-alikes (helps the model rule them out)
 */

const CATALOG = [
	// ── Sanrio ────────────────────────────────────────────────────────────────
	{ name: 'Cinnamoroll', franchise: 'Sanrio', aliases: ['cinnamon'], cues: 'chubby white puppy, very long floppy ears that let it fly, blue eyes, small blue/pink cheeks, curled cinnamon-roll tail', confuses: 'Pochacco (white dog, SHORT ears), generic white bunny, Tamagotchi (a device, not an animal)' },
	{ name: 'Hello Kitty', franchise: 'Sanrio', aliases: ['kitty', 'kitty white'], cues: 'white cat head, red/pink bow on left ear, NO mouth, yellow oval nose, three whiskers each side', confuses: 'other white cats — the missing mouth + side bow is decisive' },
	{ name: 'My Melody', franchise: 'Sanrio', aliases: ['melody'], cues: 'white rabbit wearing a pink (sometimes red) hood with ears poking through, often a flower by the face', confuses: 'Kuromi (white face but BLACK jester hood + pink skull)' },
	{ name: 'Kuromi', franchise: 'Sanrio', aliases: [], cues: 'white face, BLACK jester/devil hood with a pink skull on it, little fangs, mischievous look', confuses: 'My Melody (pink hood, no skull)' },
	{ name: 'Pompompurin', franchise: 'Sanrio', aliases: ['pom pom purin', 'purin'], cues: 'golden-tan round Labrador puppy with a brown beret, lies flat', confuses: 'plain brown bears' },
	{ name: 'Pochacco', franchise: 'Sanrio', aliases: [], cues: 'white dog with black floppy SHORT ears, black oval nose, sporty', confuses: 'Cinnamoroll (much longer ears)' },
	{ name: 'Keroppi', franchise: 'Sanrio', aliases: ['kero'], cues: 'green frog, large round eyes set wide apart, V-shaped mouth, white belly', confuses: '' },
	{ name: 'Little Twin Stars', franchise: 'Sanrio', aliases: ['kiki and lala', 'kiki lala'], cues: 'twin star children (blue-haired boy Kiki, pink-haired girl Lala), stars and pastel sky', confuses: '' },
	{ name: 'Gudetama', franchise: 'Sanrio', aliases: [], cues: 'lazy egg yolk with tiny arms/legs, droopy expression, often on egg white', confuses: '' },
	{ name: 'Badtz-Maru', franchise: 'Sanrio', aliases: ['badtz maru'], cues: 'black-and-white penguin with a spiky tuft of hair, pointy beak', confuses: '' },
	{ name: 'Tuxedo Sam', franchise: 'Sanrio', aliases: [], cues: 'chubby blue-and-white penguin wearing a bow tie', confuses: 'Badtz-Maru (black, spiky hair)' },

	// ── San-X ───────────────────────────────────────────────────────────────
	{ name: 'Rilakkuma', franchise: 'San-X', aliases: ['relax bear'], cues: 'soft brown bear with a red zipper/seam on the back, rounded ears, no nose tip colour', confuses: 'Korilakkuma (white), Pompompurin (yellow dog)' },
	{ name: 'Korilakkuma', franchise: 'San-X', aliases: ['kori'], cues: 'small WHITE bear with red cheeks and a red button on the chest', confuses: 'Rilakkuma (brown), generic white bear' },
	{ name: 'Sumikko Gurashi', franchise: 'San-X', aliases: ['sumikko'], cues: 'group of timid pastel corner-dwelling blobs (penguin, cat, bear, tonkatsu)', confuses: '' },

	// ── Bandai / WiZ ────────────────────────────────────────────────────────
	{ name: 'Tamagotchi', franchise: 'Bandai', aliases: ['tamagochi', 'tamagotch', 'virtual pet'], cues: 'an EGG-SHAPED handheld DEVICE (not an animal): oval body, a small square pixel screen, 3 buttons, often a keychain loop; pixel-art creatures like Mametchi may appear on the screen', confuses: 'Cinnamoroll / white animals — Tamagotchi is a gadget shaped like an egg, look for the screen + buttons' },
	{ name: 'Chiikawa', franchise: 'Nagano', aliases: ['hachiware', 'usagi'], cues: 'tiny round pale critters; Hachiware is a blue-eared white cat, Usagi a yellow rabbit, often teary big eyes', confuses: '' },

	// ── Pokemon ───────────────────────────────────────────────────────────────
	{ name: 'Pikachu', franchise: 'Pokemon', aliases: [], cues: 'yellow mouse, long pointed ears with black tips, red cheeks, brown back stripes, lightning-bolt tail', confuses: '' },
	{ name: 'Eevee', franchise: 'Pokemon', aliases: [], cues: 'brown fox/dog with a large fluffy cream neck ruff and bushy tail', confuses: '' },
	{ name: 'Gengar', franchise: 'Pokemon', aliases: [], cues: 'round purple ghost with spiky back, wide toothy grin, red eyes', confuses: '' },

	// ── Other popular IP ───────────────────────────────────────────────────────
	{ name: 'Snoopy', franchise: 'Peanuts', aliases: ['peanuts'], cues: 'white beagle with black ears, simple line art, often with Woodstock (yellow bird)', confuses: 'white dogs — Snoopy is flat line-art, black ears' },
	{ name: 'Stitch', franchise: 'Disney', aliases: ['lilo and stitch', 'experiment 626'], cues: 'blue koala-like alien, big dark eyes, long ears, wide toothy mouth, 4 limbs', confuses: '' },
	{ name: 'Mickey Mouse', franchise: 'Disney', aliases: ['mickey'], cues: 'black mouse head with two perfectly round black ears, red shorts', confuses: 'Minnie (adds a bow)' },
	{ name: 'Minnie Mouse', franchise: 'Disney', aliases: ['minnie'], cues: 'mouse head with round ears + a big polka-dot bow', confuses: 'Mickey (no bow)' },
	{ name: 'Winnie the Pooh', franchise: 'Disney', aliases: ['pooh', 'pooh bear'], cues: 'yellow-gold bear in a small red shirt, round tummy', confuses: 'Pompompurin (dog with beret), Rilakkuma (brown)' },
	{ name: 'Totoro', franchise: 'Studio Ghibli', aliases: ['my neighbor totoro'], cues: 'large grey forest spirit, white belly with grey chevrons, big round eyes, whiskers, holds a leaf', confuses: '' },
	{ name: 'Kuromi', franchise: 'Sanrio', aliases: [] }, // (dup-safe; matcher dedupes by name)
	{ name: 'Miffy', franchise: 'Mercis', aliases: ['nijntje'], cues: 'simple white rabbit, tall straight ears, x-shaped mouth, flat colour blocks', confuses: 'My Melody (wears a hood)' },
	{ name: 'Doraemon', franchise: 'Fujiko Pro', aliases: [], cues: 'blue robot cat, white face, red nose, whiskers, bell collar, belly pocket', confuses: '' },
	{ name: 'Molang', franchise: 'Molang', aliases: [], cues: 'plump pure-white rounded rabbit, tiny eyes, very minimal features', confuses: 'Korilakkuma (red cheeks/button), Cinnamoroll (long ears)' },
	{ name: 'Smiski', franchise: 'Dreams', aliases: [], cues: 'soft green glow-in-the-dark humanoid figures in shy poses', confuses: '' },
	{ name: 'Care Bears', franchise: 'Care Bears', aliases: ['care bear'], cues: 'colourful bears each with a belly badge/symbol, rainbow palette', confuses: '' },
]

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
}

/**
 * Normalise a free-text character name to a catalog entry when possible.
 * Returns { name, franchise, known } — falls back to the cleaned input.
 */
function normaliseCharacter(raw) {
	const cleaned = String(raw || '').trim()
	if (!cleaned) return { name: '', franchise: '', known: false }
	const exact = _lookup.get(cleaned.toLowerCase())
	if (exact) return { name: exact.name, franchise: exact.franchise, known: true }
	// Loose contains-match (e.g. "Cinnamoroll puppy")
	const low = cleaned.toLowerCase()
	for (const [key, entry] of _lookup) {
		if (low.includes(key) && key.length >= 4) {
			return { name: entry.name, franchise: entry.franchise, known: true }
		}
	}
	return { name: cleaned, franchise: '', known: false }
}

module.exports = {
	CHARACTERS,
	catalogPromptBlock,
	normaliseCharacter,
}
