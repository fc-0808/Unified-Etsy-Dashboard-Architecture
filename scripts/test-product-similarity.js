'use strict'

/**
 * Regression test — canonical product identity (same-product detection).
 *
 * Guards the pure decision logic in `src/route/product-similarity.js` that the
 * shopping route uses to unify orders of one physical product into a single
 * card. Specifically it pins the behaviour that fixed the "same product shown as
 * two separate cards" bug: a re-listed product whose photo was lightly edited
 * (perceptual-hash distance JUST above the strict visual band) must still merge
 * when a shared stall AND a similar title corroborate it — while genuinely
 * different designs must never fuse.
 *
 * Run: `node scripts/test-product-similarity.js`
 * Exit code 0 = all assertions pass, 1 = a regression was detected.
 */

const S = require('../src/route/product-similarity')

let failures = 0
function assert(cond, msg) {
	if (cond) {
		console.log(`  ok  — ${msg}`)
	} else {
		failures++
		console.error(`  FAIL — ${msg}`)
	}
}

// Build a 256-bit hex hash whose Hamming distance from the all-zero hash equals
// the number of set bits in `lowHex` (a short hex tail). Lets us craft exact
// distances without real images.
const ZERO = '0'.repeat(64)
const hashWithTail = (lowHex) => (ZERO.slice(0, 64 - lowHex.length) + lowHex).toLowerCase()
const D6 = hashWithTail('3f') //   0x3f  = 6 set bits  → distance 6 (STRONG edge)
const D9 = hashWithTail('1ff') //  0x1ff = 9 set bits  → distance 9 (corroborated band)
const D13 = hashWithTail('1fff') // 0x1fff = 13 set bits → distance 13 (beyond WIDE)
const D14 = hashWithTail('3fff') // 0x3fff = 14 set bits → distance 14 (Chiikawa full-image gap)

const stall = (...codes) => new Set(codes)

console.log('Canonical product identity regression test\n')

// ── phashDistance ──
assert(S.phashDistance(ZERO, ZERO) === 0, 'identical hashes are distance 0')
assert(S.phashDistance(ZERO, D6) === 6, 'a 6-bit tail is distance 6')
assert(S.phashDistance(ZERO, D9) === 9, 'a 9-bit tail is distance 9')
assert(S.phashDistance('nothex', D9) === 256, 'a malformed hash reads as max distance (never similar)')
assert(S.phashDistance('', '') === 256, 'empty hashes read as max distance')

// ── Title similarity ──
assert(S.productTitleSimilarity('Kawaii Miffy Case', 'Kawaii Miffy Case') === 1, 'identical distinctive wording → similarity 1')
assert(S.productTitleSimilarity('Hello Kitty Case', 'Tamagotchi Case') === 0, 'no shared design words → similarity 0 (boilerplate stripped)')
{
	// The real screenshot pair — two re-lists of the "My Melody Liquid Glitter Case".
	const a = 'My Melody Liquid Glitter Case iPhone 17 16 15 14 13 Pro Max, Pink Quicksand Star Cover & Charm, Kawaii Strawberry Coquette Gift for Her'
	const b = 'Kawaii My Melody Liquid Glitter Case with Charm, Y2K Coquette Pink Bunny Phone Cover iPhone 17 16 15 14 13 Pro Max, Sparkle Anime Gift'
	assert(S.productTitleSimilarity(a, b) >= S.PRODUCT_MERGE_TITLE_SIM, 'the two My Melody re-list titles clear the corroboration threshold')
}
assert(S.productTitleSimilarity('', 'anything') === 0, 'an empty title never corroborates')

// ── stall helpers ──
assert(S.stallsOverlap(stall('5C61'), stall('5C61')) === true, 'shared stall overlaps')
assert(S.stallsOverlap(stall('5C61'), stall('3A10')) === false, 'different stalls do not overlap')
assert(S.stallsOverlap(stall('5C61'), new Set()) === false, 'an unknown stall never overlaps (strict)')
assert(S.supplierCompatible(stall('5C61'), new Set()) === true, 'an unknown stall is supplier-compatible (permissive) for the strong band')
assert(S.supplierCompatible(stall('5C61'), stall('3A10')) === false, 'two known, different stalls are NOT supplier-compatible')

// ── shouldMergeProducts: STRONG band ──
assert(S.shouldMergeProducts({ phash: ZERO, stalls: stall('5C61') }, { phash: D6, stalls: stall('5C61') }) === true, 'STRONG visual match at the same stall merges')
assert(S.shouldMergeProducts({ phash: ZERO, stalls: stall('5C61') }, { phash: D6, stalls: new Set() }) === true, 'STRONG visual match merges even when one stall is unknown')
assert(S.shouldMergeProducts({ phash: ZERO, stalls: stall('5C61') }, { phash: D6, stalls: stall('3A10') }) === false, 'STRONG visual match does NOT merge across two known, different stalls')

// ── shouldMergeProducts: CORROBORATED band (the bug fix) ──
const myMelodyA = { phash: ZERO, title: 'My Melody Liquid Glitter Case iPhone 17 16 15 14 13 Pro Max, Pink Quicksand Star Cover & Charm, Kawaii Coquette Gift', stalls: stall('5C61') }
const myMelodyB = { phash: D9, title: 'Kawaii My Melody Liquid Glitter Case with Charm, Y2K Coquette Pink Bunny Cover iPhone 17 16 15 14 13 Pro Max, Sparkle Gift', stalls: stall('5C61') }
assert(S.shouldMergeProducts(myMelodyA, myMelodyB) === true, 'CORROBORATED near-miss (dist 9, same stall, similar title) merges — the screenshot fix')
assert(
	S.shouldMergeProducts(myMelodyA, { ...myMelodyB, stalls: stall('3A10') }) === false,
	'a near-miss at a DIFFERENT stall does NOT merge (corroboration fails)',
)
assert(
	S.shouldMergeProducts(myMelodyA, { ...myMelodyB, title: 'Cute Rilakkuma Bear Honey Case with Mushroom Charm' }) === false,
	'a near-miss with a DISSIMILAR title does NOT merge (corroboration fails)',
)
assert(
	S.shouldMergeProducts(myMelodyA, { phash: D13, title: myMelodyB.title, stalls: stall('5C61') }) === false,
	'beyond the WIDE distance, even a matching stall + title does NOT auto-merge',
)
assert(
	S.shouldMergeProducts({ phash: ZERO, title: 'x', stalls: new Set() }, { phash: D9, title: 'x', stalls: new Set() }) === false,
	'a near-miss with unknown stalls does NOT merge (no corroborating stall signal)',
)

// ── shouldMergeProducts: DESIGN-REGION band (same design, different phone model) ──
// The real Chiikawa case: full-image hashes are far apart (dist 14, camera band
// differs by model) but the design-region hashes match, same stall, similar title.
const chiikawaA = {
	phash: ZERO,
	designPhash: ZERO,
	title: 'Chiikawa Clear Phone Case with Charm, Kawaii Y2K Cute Aesthetic Cover iPhone 17 16 15 Pro Max, Gift for Chiikawa Fans',
	stalls: stall('5C61'),
}
const chiikawaB = {
	phash: D14,
	designPhash: D6,
	title: 'Chiikawa Pink Cute Case with Beaded Wristlet Charm, Kawaii Clear Pink Cover iPhone 17 16 15 14 13 Pro Max, Y2K Coquette Aesthetic',
	stalls: stall('5C61'),
}
assert(S.shouldMergeProducts(chiikawaA, chiikawaB) === true, 'DESIGN-REGION match (far full hash, close design hash, same stall, similar title) merges — the Chiikawa fix')
assert(
	S.shouldMergeProducts(chiikawaA, { ...chiikawaB, stalls: stall('3A10') }) === false,
	'a design-region match at a DIFFERENT stall does NOT merge',
)
assert(
	S.shouldMergeProducts(chiikawaA, { ...chiikawaB, title: 'Rilakkuma Bear Honey Yellow Glitter Case Mushroom Charm' }) === false,
	'a design-region match with an unrelated title does NOT merge (below the design title floor)',
)
assert(
	S.shouldMergeProducts(chiikawaA, { ...chiikawaB, designPhash: D9 }) === false,
	'a design hash beyond the tight design band does NOT merge on the design signal alone',
)
assert(
	S.shouldMergeProducts({ ...chiikawaA, designPhash: null }, { ...chiikawaB, designPhash: null }) === false,
	'without design hashes, a far full-image pair (dist 14) stays separate',
)

console.log('')
if (failures > 0) {
	console.error(`${failures} assertion(s) FAILED`)
	process.exit(1)
}
console.log('All assertions passed.')
