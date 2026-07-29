'use strict'

/**
 * Regression test — canonical product identity resolution.
 *
 * Guards `resolveProductIdentity` in `src/route/product-similarity.js`, the pure
 * union-find the shopping route uses to decide which order lines share ONE
 * product card. It composes three tiers of evidence, and this test pins the
 * ordering + guarantees of each:
 *
 *   1. the guarded VISUAL heuristic (two known, different stalls never fuse),
 *   2. DETERMINISTIC same-product tokens — a shared catalog title or bulk source
 *      folder is a fact, so it merges even across stalls. This is the tier that
 *      fixed "one catalog product rendered as two cards quoting two different
 *      prices": product_map keys supplier/charm/cost by the normalised title and
 *      enforces it UNIQUE, so identity MUST be at least as coarse as that,
 *   3. FORCED operator merges — the human-in-the-loop residual for one product
 *      photographed differently by two shops, which no automatic signal reaches.
 *
 * It also pins that the canonical key is DERIVED from group membership
 * (`P-<smallest listing id>`), so the same product keeps the same key across
 * re-hashes, re-syncs and restarts.
 *
 * Run: `node scripts/test-product-identity.js`
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

// 256-bit hex hashes at known Hamming distances (the same trick the sibling
// similarity test uses), so we can craft exact visual bands without real images.
const ZERO = '0'.repeat(64)
const hashWithTail = (lowHex) => (ZERO.slice(0, 64 - lowHex.length) + lowHex).toLowerCase()
const D6 = hashWithTail('3f') // 6 set bits → a STRONG visual match against ZERO
// Mutually UNRELATED hashes: each sets a disjoint run of 40 bits, so any two are
// 80 apart and each is 40 from ZERO — well outside every visual band. Fixtures
// must use distinct ones, or the visual tier merges them and masks the assertion.
const far = (slot) => {
	const nibbles = new Array(64).fill('0')
	for (let i = 0; i < 10; i++) nibbles[slot * 10 + i] = 'f'
	return nibbles.join('')
}
const [FAR_A, FAR_B, FAR_C, FAR_D] = [far(1), far(2), far(3), far(4)]

const stall = (...codes) => new Set(codes)
const keysOf = (result, ...ids) => ids.map((id) => result.keyByListing.get(id))
const sameKey = (result, ...ids) => new Set(keysOf(result, ...ids)).size === 1

console.log('Canonical product identity regression test\n')

// ── Visual tier: unchanged behaviour, still guarded by supplier ──
{
	const r = S.resolveProductIdentity({
		listings: [
			{ listing_id: 100, phash: ZERO, stalls: stall('5C61') },
			{ listing_id: 200, phash: D6, stalls: stall('5C61') },
			{ listing_id: 300, phash: D6, stalls: stall('3A10') },
			{ listing_id: 400, phash: FAR_A, stalls: stall('5C61') },
		],
	})
	assert(sameKey(r, 100, 200), 'a STRONG visual match at the same stall resolves to one product')
	assert(!sameKey(r, 100, 300), 'a STRONG visual match across two known, different stalls stays separate')
	assert(!sameKey(r, 100, 400), 'a far-apart photo at the same stall stays separate')
	assert(r.stats.visual === 1, 'exactly one visual edge was applied')
}

// ── Deterministic tier: shared catalog title ──
{
	// The live bug: ONE catalog product (product_map keys cost/supplier by this
	// exact normalised title, UNIQUE) listed twice with different photos, so the
	// visual tier can't see it and the route drew two cards with two prices.
	const title = 'kawaii monchhichi magsafe case with magnetic grip stand, red bumper clear cover'
	const r = S.resolveProductIdentity({
		listings: [
			{ listing_id: 4466319861, phash: ZERO, stalls: stall('A2-33'), identityKeys: [`title:${title}`] },
			{ listing_id: 4466337928, phash: FAR_A, stalls: stall('A2-33'), identityKeys: [`title:${title}`] },
			{ listing_id: 4466400000, phash: FAR_B, stalls: stall('A2-33'), identityKeys: ['title:an entirely different design'] },
		],
	})
	assert(sameKey(r, 4466319861, 4466337928), 'two listings sharing a catalog title resolve to ONE product despite unrelated photos')
	assert(!sameKey(r, 4466319861, 4466400000), 'a different catalog title stays a different product')
	assert(r.stats.deterministic === 1 && r.stats.byToken.title === 1, 'the merge is attributed to the title token')
}

// ── Deterministic tier: shared bulk source folder ──
{
	const folder = 'folder:C:\\Users\\shop\\Downloads\\0723_airpods\\imd耳机彩色蘑菇'
	const r = S.resolveProductIdentity({
		listings: [
			{ listing_id: 4542687034, phash: ZERO, identityKeys: [folder] },
			// Same design folder, different shop, different stall on file: the folder is
			// ground truth (the bulk lister BUILT both listings from it), so it wins.
			{ listing_id: 4544373363, phash: FAR_A, stalls: stall('汇通A146'), identityKeys: [folder.toUpperCase()] },
		],
	})
	assert(sameKey(r, 4542687034, 4544373363), 'listings built from the same source folder resolve to one product (case-insensitive path)')
	assert(r.stats.byToken.folder === 1, 'the merge is attributed to the folder token')
}

// ── Deterministic tokens are transitive and never fuse unrelated tokens ──
{
	const r = S.resolveProductIdentity({
		listings: [
			{ listing_id: 10, phash: ZERO, identityKeys: ['title:one product'] },
			{ listing_id: 20, phash: FAR_A, identityKeys: ['title:one product', 'folder:/designs/a'] },
			{ listing_id: 30, phash: FAR_B, identityKeys: ['folder:/designs/a'] },
			{ listing_id: 40, phash: FAR_C, identityKeys: ['folder:/designs/b'] },
		],
	})
	assert(sameKey(r, 10, 20, 30), 'identity composes transitively across different token kinds')
	assert(!sameKey(r, 10, 40), 'a listing sharing no token with the group stays out of it')
}

// ── Blank / absent tokens must never group anything ──
{
	const r = S.resolveProductIdentity({
		listings: [
			{ listing_id: 1, phash: ZERO, identityKeys: ['title:', '   ', null, undefined] },
			{ listing_id: 2, phash: FAR_A, identityKeys: ['   ', ''] },
			{ listing_id: 3, phash: FAR_B },
		],
	})
	assert(!sameKey(r, 1, 2) && !sameKey(r, 2, 3), 'empty/whitespace tokens never group listings')
	assert(r.stats.deterministic === 0, 'no deterministic edge is recorded for empty tokens')
	assert(S.identityToken('  Mixed   Case  ') === 'mixed case', 'identityToken collapses whitespace and case')
	assert(S.identityToken('   ') === null && S.identityToken(null) === null, 'identityToken rejects blank input')
}

// ── Operator tier: the human-in-the-loop residual (the reported bug) ──
{
	// The real pair: one Monchhichi case listed by two shops with completely
	// different lifestyle photos (measured dHash distance 112 of 256 — no better
	// than random) and only loosely similar titles, so nothing automatic links
	// them. The shopper at stall A2-33 declares it; that must be final.
	const listings = [
		{ listing_id: 4490497497, phash: ZERO, title: 'Cute Monchhichi MAGSAFE Case with 3D Character Grip, Kawaii Red Clear Cover', stalls: stall('A2-33') },
		{ listing_id: 4530764043, phash: FAR_A, title: 'Monchhichi Clear MAGSAFE Phone Case with Grip, Kawaii Y2K Cute Aesthetic Cover', stalls: stall('A2-33') },
	]
	const before = S.resolveProductIdentity({ listings })
	assert(!sameKey(before, 4490497497, 4530764043), 'without an operator merge the two photos of one product stay two cards (the reported bug)')

	const after = S.resolveProductIdentity({ listings, forcedPairs: [{ listing_a: 4530764043, listing_b: 4490497497 }] })
	assert(sameKey(after, 4490497497, 4530764043), 'an operator merge unifies them into one product card')
	assert(after.stats.operator === 1, 'the merge is attributed to the operator tier')
	assert(keysOf(after, 4490497497)[0] === 'P-4490497497', 'the canonical key is derived from the smallest listing id, so it is stable')

	// Tuple form (what the DB edge list yields when spread) works identically.
	const tuple = S.resolveProductIdentity({ listings, forcedPairs: [[4530764043, 4490497497]] })
	assert(sameKey(tuple, 4490497497, 4530764043), 'forced pairs accept [a, b] tuples as well as row objects')

	// An operator merge outranks the supplier guard: the same product can legitimately
	// be recorded at two stalls (one alias mapped, one not yet corrected).
	const crossStall = S.resolveProductIdentity({
		listings: [listings[0], { ...listings[1], stalls: stall('3A10') }],
		forcedPairs: [[4530764043, 4490497497]],
	})
	assert(sameKey(crossStall, 4490497497, 4530764043), 'an operator merge is honoured even across two known, different stalls')
}

// ── Group shape + key stability ──
{
	const listings = [
		{ listing_id: 900, phash: ZERO, identityKeys: ['title:x'] },
		{ listing_id: 500, phash: FAR_A, identityKeys: ['title:x'] },
		{ listing_id: 700, phash: FAR_B, identityKeys: ['title:y'] },
	]
	const r = S.resolveProductIdentity({ listings })
	assert(r.groups.length === 2, 'every listing lands in exactly one group')
	const merged = r.groups.find((g) => g.listing_ids.length === 2)
	assert(merged.key === 'P-500' && merged.listing_ids.join(',') === '500,900', 'group members are sorted and keyed by the smallest id')
	// Re-running on a reordered input (as a re-sync would) must not move the key.
	const reordered = S.resolveProductIdentity({ listings: [listings[2], listings[1], listings[0]] })
	assert(keysOf(reordered, 900)[0] === 'P-500', 'the canonical key is independent of input order')
	assert(S.canonicalProductKey([900, 500, 700]) === 'P-500', 'canonicalProductKey picks the smallest id')
	assert(S.canonicalProductKey([]) === null, 'canonicalProductKey has no key for an empty group')
}

// ── Degenerate input must not throw ──
{
	const empty = S.resolveProductIdentity()
	assert(empty.groups.length === 0 && empty.keyByListing.size === 0, 'resolving with no input yields an empty result')
	const junk = S.resolveProductIdentity({ listings: [{ listing_id: 'nope', phash: ZERO }], forcedPairs: [null, [1], {}] })
	assert(junk.groups.length === 0, 'a listing without a usable id is dropped rather than crashing')
}

// ── Candidate ranking is an ordering hint only ──
{
	const a = { title: 'Cute Monchhichi MAGSAFE Case with 3D Character Grip', designPhash: ZERO }
	const b = { title: 'Monchhichi Clear MAGSAFE Phone Case with Grip', designPhash: D6 }
	const c = { title: 'Rilakkuma Bear Honey Yellow Glitter Case', designPhash: FAR_D }
	assert(S.mergeCandidateRank(a, b) > S.mergeCandidateRank(a, c), 'a plausible candidate ranks above an unrelated one')
	assert(S.mergeCandidateRank(a, {}) === 0, 'a candidate with no comparable signal ranks last')
}

console.log('')
if (failures > 0) {
	console.error(`${failures} assertion(s) FAILED`)
	process.exit(1)
}
console.log('All assertions passed.')
