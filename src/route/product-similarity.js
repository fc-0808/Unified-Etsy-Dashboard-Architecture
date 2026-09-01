'use strict'

/**
 * Canonical product identity — the pure decision logic that answers ONE question:
 * "are these two listings the same physical supplier product?"
 *
 * WHY THIS MODULE EXISTS
 * ----------------------------------------------------------------------------
 * The shopping route unifies orders of the SAME product into a single card so a
 * shopper buys it once (with a row per phone model). Identity is discovered
 * automatically from each listing's primary-image perceptual hash (dHash). A
 * pure visual match is decisive, but genuine RE-LISTS of one product routinely
 * carry a lightly edited photo — a newly added charm, a different angle, a promo
 * overlay — that lands just OUTSIDE the strict visual band. Those orders then
 * split into duplicate product cards on the route (the exact bug this fixes).
 *
 * Rather than loosen the visual threshold globally (which would fuse unrelated
 * designs that happen to look alike), this uses precision-first, multi-signal
 * entity resolution:
 *
 *   • STRONG band  (distance <= STRONG_DISTANCE): a decisive visual match. Merge
 *     as long as the two listings aren't known to live at different stalls.
 *   • DESIGN-TITLE match: the two photos may be COMPOSITIONALLY unrelated
 *     (a lifestyle shot of someone holding the phone vs. a flat-lay of the bare
 *     case vs. a re-shoot without the bundled charm) — see "WHERE THE VISUAL
 *     SIGNAL RUNS OUT" below for why no visual band can ever bridge that. But a
 *     seller who re-lists one physical design routinely reuses the SAME listing
 *     title verbatim except for the phone model AND optional marketing/accessory
 *     fluff ("… & Charm", "… Now", "… Aesthetic"). Once boilerplate, model words,
 *     marketing fluff, and optional accessory callouts are stripped, an EXACT
 *     set match — or a near-containment (one title's tokens are a high-Jaccard
 *     subset of the other's) — is a far stronger claim than the >= 0.5 Jaccard
 *     floor the CORROBORATED band already trusts. Strong enough to stand alone
 *     with no visual corroboration, gated only by a shared stall (never bridges
 *     two different suppliers) and a minimum token count (never merges on one
 *     generic word that slipped past the stopword list).
 *   • DESIGN-REGION match: the SAME case design photographed on two different phone
 *     models differs mainly in the top camera-cutout band, which alone can push the
 *     full-image hash well past WIDE. A second hash computed over only the LOWER
 *     (design) region ignores that band, so those re-lists match. Because a
 *     design-only match discards evidence, it's gated by a shared stall AND a
 *     minimal title agreement (defends against sparse "clear case" collisions).
 *   • CORROBORATED band ((STRONG, WIDE]): a near-miss full-image photo. Merge ONLY
 *     when TWO independent signals agree — the listings share a supplier stall AND
 *     their titles are strongly similar. Two agreeing weak signals beat one
 *     strong-but-fuzzy one, so recall improves without sacrificing precision.
 *   • Otherwise: never an automatic merge (operators can still force one via the
 *     product_merges override — see the "Same product" control on the shopping
 *     route, which calls exactly this override for the residual cases nothing
 *     automatic can reach).
 *
 * WHERE THE VISUAL SIGNAL RUNS OUT (and what replaces it)
 * ----------------------------------------------------------------------------
 * All of the visual bands compare ONE photo per listing, so they only reach
 * re-lists that reused (or lightly edited) the same photo. When two shops list
 * the same physical product with genuinely DIFFERENT lifestyle photos, the hash
 * carries no signal at all: measured across this catalog, same-stall pairs of
 * different photos are spread over Hamming distance 48–168 (mode ≈ 120, i.e. ≈
 * half of 256 bits — indistinguishable from random), while true same-photo
 * pairs sit at 0–16. There is no threshold between those two facts. Title
 * similarity alone doesn't safely separate them either at a LOOSE threshold
 * (real same-product pairs can land below unrelated ones that merely share
 * generic wording) — which is why the DESIGN-TITLE tier above demands an EXACT
 * set match rather than a similarity score, and why `resolveProductIdentity`
 * below composes the heuristics with signals that are true by construction:
 *
 *   • DETERMINISTIC equivalences — facts the rest of the system already treats
 *     as one product: listings sharing a normalised catalog title (the UNIQUE
 *     key of product_map, which carries the supplier/charm/cost for it), or
 *     created from the same bulk-lister source design folder. Honouring these
 *     doesn't add risk; it REMOVES an inconsistency, because otherwise one
 *     catalog product can render as two cards showing two different prices.
 *   • OPERATOR merges — the human-in-the-loop residual, recorded durably in
 *     product_merges. The shopper is standing at the stall holding the product,
 *     which is the only reliable "same design?" sensor we have for the pairs
 *     that reach neither an exact title match nor a shared catalog identity.
 *
 * Everything here is a PURE function of its inputs (no DB, no globals), so the
 * server, scripts, and the regression test all share one source of truth.
 */

// dHash Hamming-distance bands (out of 256 bits). STRONG is a near-exact visual
// match; WIDE is the widest a corroborated near-miss may span.
const PRODUCT_MERGE_STRONG_DISTANCE = 6
const PRODUCT_MERGE_WIDE_DISTANCE = 12
// Minimum Jaccard title similarity (0..1 over distinctive tokens) required to
// corroborate a near-miss FULL-image visual match.
const PRODUCT_MERGE_TITLE_SIM = 0.5
// Design-region (camera-band-excluded) hash thresholds. The design hash is a much
// stronger signal that the artwork itself matches, so its distance bar is tight
// and its title floor is lower than the full-image corroborated band.
const DESIGN_MERGE_STRONG_DISTANCE = 6
const DESIGN_MERGE_TITLE_SIM = 0.3
// Minimum number of distinctive tokens BOTH titles must contribute for an exact
// design-title match to fire. Guards against two unrelated listings colliding on
// a single generic word (e.g. "clear") that isn't in the stopword list.
const DESIGN_TITLE_EXACT_MIN_TOKENS = 2

// Boilerplate carried by nearly every phone-case title (phone models, format
// words, generic gift phrasing). Stripped before comparing titles so similarity
// reflects the DISTINCTIVE design words ("my melody", "tamagotchi", "leopard"),
// not the shared scaffolding every listing repeats. Colours are deliberately
// KEPT (a "Purple Kuromi" and "Blue Kuromi" are different products to buy).
const PRODUCT_TITLE_STOPWORDS = new Set([
	'iphone', 'pro', 'max', 'plus', 'se', 'mini', 'ultra', 'magsafe',
	'17', '16', '15', '14', '13', '12', '11', 'xr', 'xs', 'x', '8', '7',
	'for', 'her', 'him', 'with', 'and', 'the', 'of', 'w', 'case', 'cover', 'phone', 'gift', 'set',
	// Marketing fluff that sellers append/drop between re-lists of the SAME design
	// ("… Gift for Her Now" vs "… Aesthetic"). Stripping these is what lets the
	// DESIGN-TITLE tier see "Usahana Pink Heart Grip & Charm" and "Usahana Pink
	// Heart Grip" as one product despite unrelated lifestyle vs studio photos.
	'now', 'new', 'aesthetic', 'cute', 'kawaii', 'y2k', 'coquette', 'style', 'idea', 'bundle',
	// Accessory callouts that usually do NOT change the shelf SKU — the same
	// physical case is routinely re-titled with/without "charm" / "beaded strap".
	'charm', 'beaded', 'wristlet', 'strap', 'lanyard',
])
// Minimum Jaccard similarity required when one title's distinctive tokens are a
// STRICT SUBSET of the other's (one listing added optional accessory/fluff words
// the other omitted). Tighter than PRODUCT_MERGE_TITLE_SIM so a tiny shared core
// can't drag in a much longer unrelated title.
const DESIGN_TITLE_CONTAIN_SIM = 0.75

// Identity resolution compares EVERY pair of hashed listings, so the Hamming
// distance below is the hot loop of the whole feature (~600k calls at today's
// catalog size, and it grows quadratically). These two tables make each call 32
// byte-XORs plus table lookups instead of BigInt arithmetic: a nibble-wise
// popcount, and a memo of the hex→bytes parse (the same few thousand hash
// strings are compared over and over, so parsing once is essentially free).
const POPCOUNT = (() => {
	const table = new Uint8Array(256)
	for (let i = 1; i < 256; i++) table[i] = (i & 1) + table[i >> 1]
	return table
})()
const PHASH_RE = /^[0-9a-f]{64}$/i
const PHASH_BYTES_MAX = 20000
const _phashBytes = new Map()

/** A 256-bit hex hash as 32 bytes, or null when missing/malformed. Memoised. */
function phashBytes(hex) {
	const s = String(hex == null ? '' : hex)
	if (!PHASH_RE.test(s)) return null
	const key = s.toLowerCase()
	const hit = _phashBytes.get(key)
	if (hit) return hit
	const bytes = new Uint8Array(32)
	for (let i = 0; i < 32; i++) bytes[i] = parseInt(key.slice(i * 2, i * 2 + 2), 16)
	// Hash strings are bounded by the catalog size; the cap is only a guard
	// against unbounded growth in a long-lived process.
	if (_phashBytes.size >= PHASH_BYTES_MAX) _phashBytes.clear()
	_phashBytes.set(key, bytes)
	return bytes
}

/**
 * Hamming distance between two hex-encoded 256-bit dHashes. Returns 256 (max /
 * "no match") when either hash is missing or malformed, so a bad hash can never
 * accidentally read as similar.
 */
function phashDistance(a, b) {
	const x = phashBytes(a)
	const y = phashBytes(b)
	if (!x || !y) return 256
	let count = 0
	for (let i = 0; i < 32; i++) count += POPCOUNT[x[i] ^ y[i]]
	return count
}

// Same hot-loop concern as phashBytes above: resolveProductIdentity calls this
// for every same-stall pair, and the same handful of titles recur across many
// order lines, so memoising the tokenisation (a lowercase + regex split) pays
// for itself the same way the hash-byte memo does.
const TITLE_TOKENS_MAX = 20000
const _titleTokens = new Map()

/** Distinctive-token set for a product title (non-alphanumerics + boilerplate removed). Memoised. */
function productTitleTokens(title) {
	const key = String(title || '')
	const hit = _titleTokens.get(key)
	if (hit) return hit
	const words = key
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()
		.split(/\s+/)
	const set = new Set()
	for (const w of words) if (w.length > 1 && !PRODUCT_TITLE_STOPWORDS.has(w)) set.add(w)
	if (_titleTokens.size >= TITLE_TOKENS_MAX) _titleTokens.clear()
	_titleTokens.set(key, set)
	return set
}

/** Jaccard similarity (0..1) between two ALREADY-TOKENISED distinctive-token sets. */
function tokenSetSimilarity(A, B) {
	if (!A.size || !B.size) return 0
	let inter = 0
	for (const w of A) if (B.has(w)) inter++
	return inter / (A.size + B.size - inter)
}

/** True when two non-empty token sets contain exactly the same tokens. */
function tokenSetsEqual(A, B) {
	if (!A.size || A.size !== B.size) return false
	for (const w of A) if (!B.has(w)) return false
	return true
}

/** True when every token in `small` also appears in `large` (and small is non-empty). */
function tokenSetContained(small, large) {
	if (!small.size || small.size > large.size) return false
	for (const w of small) if (!large.has(w)) return false
	return true
}

/**
 * DESIGN-TITLE decision over two already-tokenised titles: exact match, or one
 * title's tokens being a near-complete subset of the other's (re-list that
 * added/dropped optional accessory words). Both sides need enough tokens so a
 * single shared generic word can never fire this path alone.
 */
function designTitlesMatch(tokensA, tokensB) {
	if (tokensA.size < DESIGN_TITLE_EXACT_MIN_TOKENS || tokensB.size < DESIGN_TITLE_EXACT_MIN_TOKENS) return false
	if (tokenSetsEqual(tokensA, tokensB)) return true
	const smaller = tokensA.size <= tokensB.size ? tokensA : tokensB
	const larger = tokensA.size <= tokensB.size ? tokensB : tokensA
	return tokenSetContained(smaller, larger) && tokenSetSimilarity(tokensA, tokensB) >= DESIGN_TITLE_CONTAIN_SIM
}

/** Jaccard similarity (0..1) over two titles' distinctive tokens. */
function productTitleSimilarity(a, b) {
	return tokenSetSimilarity(productTitleTokens(a), productTitleTokens(b))
}

/** True when two stall sets both have a known stall and share at least one. */
function stallsOverlap(aStalls, bStalls) {
	if (!aStalls || !bStalls || !aStalls.size || !bStalls.size) return false
	for (const s of aStalls) if (bStalls.has(s)) return true
	return false
}

/**
 * Supplier compatibility guard for the STRONG band: two KNOWN, different stalls
 * must never auto-merge (guards against a reused generic/promo image linking
 * unrelated products). An unknown stall on either side is permissive.
 */
function supplierCompatible(aStalls, bStalls) {
	if (!aStalls?.size || !bStalls?.size) return true
	return stallsOverlap(aStalls, bStalls)
}

/**
 * The core decision. Each listing is `{ phash, designPhash, title, stalls }`
 * where `stalls` is a Set of normalised stall codes (may be empty/undefined when
 * unknown) and `designPhash` is the optional camera-band-excluded hash. Returns
 * true when the two listings should be unified into one product.
 */
function shouldMergeProducts(a, b) {
	const aStalls = a && a.stalls
	const bStalls = b && b.stalls

	// 1. STRONG full-image match: decisive on its own (supplier-compatible only).
	const dFull = phashDistance(a && a.phash, b && b.phash)
	if (dFull <= PRODUCT_MERGE_STRONG_DISTANCE) return supplierCompatible(aStalls, bStalls)

	// Every remaining path requires the listings to actually share a known stall.
	if (!stallsOverlap(aStalls, bStalls)) return false
	const titleTokensA = productTitleTokens(a && a.title)
	const titleTokensB = productTitleTokens(b && b.title)

	// 2. DESIGN-TITLE match: no visual signal is usable at all (the two photos
	//    may be entirely different compositions — see the module doc), but the
	//    DISTINCTIVE title words agree once boilerplate, phone-model, marketing
	//    fluff, and optional accessory callouts are stripped. Covers exact
	//    equality AND near-containment (one re-list added "& Charm" / "Now").
	if (designTitlesMatch(titleTokensA, titleTokensB)) return true

	const titleSim = tokenSetSimilarity(titleTokensA, titleTokensB)

	// 3. DESIGN-REGION match: the artwork matches once the camera band is ignored
	//    (same design across phone models). Tight distance + a low title floor.
	if (a && b && a.designPhash && b.designPhash) {
		const dDesign = phashDistance(a.designPhash, b.designPhash)
		if (dDesign <= DESIGN_MERGE_STRONG_DISTANCE && titleSim >= DESIGN_MERGE_TITLE_SIM) return true
	}

	// 4. CORROBORATED near-miss full-image band: shared stall AND similar title.
	if (dFull <= PRODUCT_MERGE_WIDE_DISTANCE && titleSim >= PRODUCT_MERGE_TITLE_SIM) return true

	return false
}

// ── Deterministic identity tokens ────────────────────────────────────────────

/**
 * Normalise a deterministic identity token (catalog title, source folder path)
 * for EXACT comparison: collapse whitespace, drop case. Returns null for an
 * empty/absent token so it can never group listings by accident.
 */
function identityToken(value) {
	const s = String(value == null ? '' : value)
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase()
	return s || null
}

/**
 * The durable key for a resolved product: `P-<smallest listing id>`. Derived
 * from the group's membership rather than assigned, so the same product keeps
 * the same key across re-hashes, re-syncs and restarts (and every alias of it
 * agrees) as long as its members don't change.
 */
function canonicalProductKey(listingIds) {
	const ids = (Array.isArray(listingIds) ? listingIds : []).map(Number).filter(Number.isFinite)
	return ids.length ? `P-${Math.min(...ids)}` : null
}

/** Prefix of a namespaced identity token (`title:…` → `title`), for stats. */
function tokenNamespace(token) {
	const i = token.indexOf(':')
	return i > 0 ? token.slice(0, i) : '*'
}

/**
 * Resolve every listing into a physical-product group (union-find over the
 * identity graph) and hand back its durable canonical key.
 *
 * Each entry of `listings` is `{ listing_id, phash, designPhash, title, stalls,
 * identityKeys }`, where `stalls` is a Set of normalised stall codes (may be
 * empty when unknown) and `identityKeys` is an optional array of NAMESPACED
 * deterministic tokens (e.g. `title:<normalised title>`, `folder:<path>`).
 * `forcedPairs` carries operator-declared merges as `[a, b]` tuples or
 * `{ listing_a, listing_b }` rows.
 *
 * Edges are applied in increasing order of authority, and the supplier guard —
 * two groups with KNOWN, disjoint stalls never fuse — applies to the heuristic
 * pass only:
 *   1. VISUAL heuristic (`shouldMergeProducts`), guarded. Runs first, so it
 *      judges each listing on the stall(s) it is actually known at rather than
 *      on a wider set it inherited from a deterministic group.
 *   2. DETERMINISTIC tokens — a shared token is a fact, so it bypasses the
 *      guard (a product legitimately sold from one stall under two listings).
 *   3. OPERATOR merges — a deliberate human decision outranks every heuristic.
 *
 * @returns {{ keyByListing: Map<number, string>, groups: Array<{key: string, listing_ids: number[]}>, stats: object }}
 */
function resolveProductIdentity(input = {}) {
	const listings = Array.isArray(input.listings) ? input.listings : []
	const parent = listings.map((_, i) => i)
	// Stall sets accumulate as groups merge, so the guard below reasons about the
	// whole group's known locations, not just the two listings being compared.
	const groupStalls = listings.map((l) => new Set((l && l.stalls) || []))
	const stats = { visual: 0, deterministic: 0, operator: 0, byToken: {} }

	const root = (i) => {
		while (parent[i] !== i) {
			parent[i] = parent[parent[i]]
			i = parent[i]
		}
		return i
	}
	const join = (a, b, force) => {
		a = root(a)
		b = root(b)
		if (a === b) return false
		const as = groupStalls[a]
		const bs = groupStalls[b]
		if (!force && as.size && bs.size) {
			let overlap = false
			for (const stall of as) {
				if (bs.has(stall)) {
					overlap = true
					break
				}
			}
			if (!overlap) return false
		}
		parent[b] = a
		for (const stall of bs) as.add(stall)
		return true
	}

	// 1. Visual heuristic (guarded).
	for (let i = 0; i < listings.length; i++) {
		for (let j = i + 1; j < listings.length; j++) {
			if (shouldMergeProducts(listings[i], listings[j]) && join(i, j, false)) stats.visual++
		}
	}

	// 2. Deterministic tokens: everything sharing a token is one product. Edges
	//    are drawn star-wise from the first holder, which is enough to connect
	//    the whole set while staying O(members).
	const byToken = new Map()
	listings.forEach((l, i) => {
		for (const raw of (l && l.identityKeys) || []) {
			const token = identityToken(raw)
			if (!token) continue
			if (!byToken.has(token)) byToken.set(token, [])
			byToken.get(token).push(i)
		}
	})
	for (const [token, members] of byToken) {
		const ns = tokenNamespace(token)
		for (let k = 1; k < members.length; k++) {
			if (!join(members[0], members[k], true)) continue
			stats.deterministic++
			stats.byToken[ns] = (stats.byToken[ns] || 0) + 1
		}
	}

	// 3. Operator-declared merges — the final word.
	const indexById = new Map()
	listings.forEach((l, i) => {
		const id = Number(l && l.listing_id)
		if (Number.isFinite(id)) indexById.set(id, i)
	})
	for (const pair of Array.isArray(input.forcedPairs) ? input.forcedPairs : []) {
		if (!pair) continue
		const ia = indexById.get(Number(Array.isArray(pair) ? pair[0] : pair.listing_a))
		const ib = indexById.get(Number(Array.isArray(pair) ? pair[1] : pair.listing_b))
		if (ia != null && ib != null && join(ia, ib, true)) stats.operator++
	}

	const members = new Map()
	listings.forEach((l, i) => {
		const r = root(i)
		if (!members.has(r)) members.set(r, [])
		members.get(r).push(Number(l && l.listing_id))
	})
	const keyByListing = new Map()
	const groups = []
	for (const ids of members.values()) {
		const sorted = ids.filter(Number.isFinite).sort((a, b) => a - b)
		const key = canonicalProductKey(sorted)
		if (!key) continue
		for (const id of sorted) keyByListing.set(id, key)
		groups.push({ key, listing_ids: sorted })
	}
	groups.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
	return { keyByListing, groups, stats }
}

/**
 * Ordering hint for the operator's "is this the same product?" picker — a 0..1
 * rank, NEVER a claim of identity. It exists only to put the most plausible
 * candidate at the top of a short list the human then judges from the photos;
 * measurements on real data show no title/visual score reliably separates
 * same-product pairs from unrelated ones at this stage, so the UI must not
 * present this as a suggestion.
 */
function mergeCandidateRank(a, b) {
	const titleSim = productTitleSimilarity(a && a.title, b && b.title)
	const dDesign = phashDistance(a && a.designPhash, b && b.designPhash)
	const visual = dDesign >= 256 ? 0 : 1 - dDesign / 256
	return Math.round((titleSim * 0.85 + visual * 0.15) * 1000) / 1000
}

module.exports = {
	PRODUCT_MERGE_STRONG_DISTANCE,
	PRODUCT_MERGE_WIDE_DISTANCE,
	PRODUCT_MERGE_TITLE_SIM,
	DESIGN_MERGE_STRONG_DISTANCE,
	DESIGN_MERGE_TITLE_SIM,
	DESIGN_TITLE_EXACT_MIN_TOKENS,
	DESIGN_TITLE_CONTAIN_SIM,
	PRODUCT_TITLE_STOPWORDS,
	phashDistance,
	productTitleTokens,
	productTitleSimilarity,
	tokenSetSimilarity,
	tokenSetsEqual,
	tokenSetContained,
	designTitlesMatch,
	stallsOverlap,
	supplierCompatible,
	shouldMergeProducts,
	identityToken,
	canonicalProductKey,
	resolveProductIdentity,
	mergeCandidateRank,
}
