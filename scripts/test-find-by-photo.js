'use strict'

/**
 * Find-supplier-from-a-photo: decode, rank, join to product_map.shop_name,
 * and the vision path that recovers phone snaps dHash cannot.
 *
 * Run: node scripts/test-find-by-photo.js
 */

const assert = require('node:assert/strict')
const { initDb } = require('../src/db/setup')
const { computeDHash, computeDesignHash, PRODUCT_HASH_ALGO } = require('../src/route/product-image-hash')
const find = require('../src/route/find-by-photo')
const vision = require('../src/route/find-by-photo-vision')
const { normalizeTitle } = require('../src/route/dashboard')
const sharp = require('sharp')

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const RESET = '\x1b[0m'
let passed = 0
let failed = 0

const jobs = []
function test(name, fn) {
	jobs.push({ name, fn })
}

const ZERO = '0'.repeat(64)
const hashWithTail = (lowHex) => (ZERO.slice(0, 64 - lowHex.length) + lowHex).toLowerCase()
const D0 = ZERO
const D6 = hashWithTail('3f')
const D81 = hashWithTail('1' + 'f'.repeat(20))

const TINY_PNG =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function seedListing(db, id, title) {
	db.prepare("INSERT INTO listings (listing_id, shop_id, title, state) VALUES (?, 'S1', ?, 'active')").run(id, title)
}

function seedMap(db, title, shop, stall, canonical) {
	db.prepare(
		`INSERT INTO product_map (title_norm, title, shop_name, stall, canonical_product_key, status)
		 VALUES (?, ?, ?, ?, ?, 'active')`,
	).run(normalizeTitle(title), title, shop, stall, canonical || null)
}

function seedHash(db, listingId, phash, designPhash, canonical) {
	db.prepare(
		`INSERT INTO listing_phash (listing_id, phash, design_phash, sha, algo, canonical_key)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	).run(listingId, phash, designPhash || phash, 'sha-' + listingId, PRODUCT_HASH_ALGO, canonical || null)
}

console.log('\nFind by photo\n')

test('decodePhotoData rejects empty / non-image payloads', () => {
	assert.throws(() => find.decodePhotoData(''), (err) => err.status === 400)
	assert.throws(() => find.decodePhotoData('not-an-image'), (err) => err.status === 400)
	assert.throws(() => find.decodePhotoData('data:image/svg+xml;base64,AAAA'), (err) => err.status === 400)
	assert.throws(() => find.decodePhotoData('data:text/html;base64,AAAA'), (err) => err.status === 400)
})

test('decodePhotoData accepts a PNG data URL', () => {
	const buf = find.decodePhotoData(TINY_PNG)
	assert.ok(Buffer.isBuffer(buf) && buf.length > 0)
})

test('confidence bands match the advertised Hamming cutoffs', () => {
	assert.equal(find.confidenceFor(0), 'exact')
	assert.equal(find.confidenceFor(6), 'exact')
	assert.equal(find.confidenceFor(7), 'likely')
	assert.equal(find.confidenceFor(12), 'likely')
	assert.equal(find.confidenceFor(13), 'possible')
	assert.equal(find.confidenceFor(24), 'possible')
	assert.equal(find.confidenceFor(25), 'weak')
	assert.equal(find.confidenceFor(48), 'weak')
	assert.equal(find.confidenceFor(49), 'distant')
	assert.equal(find.confidenceFor(Number.NaN), 'distant')
})

test('rankAndJoin returns the catalog shop name for a close hash', () => {
	const db = initDb(':memory:')
	const title = 'Kawaii Pink Heart Case iPhone 16 Pro'
	seedListing(db, 101, title)
	seedMap(db, title, 'V8 Case Shop', '5C61')
	seedHash(db, 101, D6, D6)
	const matches = find.rankAndJoin(db, { full: D0, design: D0, crop: D0 }, db.prepare('SELECT listing_id, phash, design_phash, canonical_key FROM listing_phash').all())
	assert.equal(matches.length, 1)
	assert.equal(matches[0].shop_name, 'V8 Case Shop')
	assert.equal(matches[0].stall, '5C61')
	assert.equal(matches[0].distance, 6)
	assert.equal(matches[0].confidence, 'exact')
	assert.equal(matches[0].image_url, '/api/route/listing-image/101?w=300')
	assert.equal(matches[0].location.located, true)
	db.close()
})

test('rankAndJoin drops listings beyond the scan cap and dedupes the same catalog title', () => {
	const db = initDb(':memory:')
	const title = 'Shared Catalog Title Case'
	seedListing(db, 1, title)
	seedListing(db, 2, title)
	seedListing(db, 3, 'Unrelated Distant Product')
	seedMap(db, title, 'HAN Booth', 'A2-21')
	seedMap(db, 'Unrelated Distant Product', 'Other Shop', '3A10')
	seedHash(db, 1, D6, D6)
	seedHash(db, 2, D0, D0)
	seedHash(db, 3, D81, D81)
	const matches = find.rankAndJoin(db, { full: D0, design: D0, crop: D0 }, db.prepare('SELECT listing_id, phash, design_phash, canonical_key FROM listing_phash').all())
	assert.equal(matches.length, 1)
	assert.equal(matches[0].listing_id, 2)
	assert.equal(matches[0].shop_name, 'HAN Booth')
	assert.ok(matches.every((m) => m.distance <= find.SCAN_CAP))
	db.close()
})

test('searchByPhoto reports index_empty when nothing is hashed yet', async () => {
	const db = initDb(':memory:')
	const result = await find.searchByPhoto(db, { photo_data: TINY_PNG }, { vision: false })
	assert.equal(result.reason, 'index_empty')
	assert.deepEqual(result.matches, [])
	assert.equal(result.index_size, 0)
	db.close()
})

test('searchByPhoto still exact-matches a listing photo after the working-size hash', async () => {
	const db = initDb(':memory:')
	const buf = await sharp({
		create: { width: 48, height: 48, channels: 3, background: { r: 220, g: 20, b: 60 } },
	})
		.png()
		.toBuffer()
	const other = await sharp({
		create: { width: 48, height: 48, channels: 3, background: { r: 20, g: 40, b: 200 } },
	})
		.png()
		.toBuffer()
	const title = 'Crimson Heart Phone Case iPhone 15'
	const otherTitle = 'Navy Grid Phone Case iPhone 15'
	seedListing(db, 501, title)
	seedListing(db, 502, otherTitle)
	seedMap(db, title, 'Tongxin V8', '5C61')
	seedMap(db, otherTitle, 'Jingji Other', '经济5D100')
	seedHash(db, 501, await computeDHash(buf), await computeDesignHash(buf))
	seedHash(db, 502, await computeDHash(other), await computeDesignHash(other))
	const result = await find.searchByPhoto(db, { photo_data: 'data:image/png;base64,' + buf.toString('base64') }, { vision: false })
	assert.equal(result.reason, null)
	assert.equal(result.source, 'phash')
	assert.ok(result.matches.length >= 1)
	assert.equal(result.matches[0].shop_name, 'Tongxin V8')
	assert.equal(result.matches[0].stall, '5C61')
	assert.equal(result.matches[0].distance, 0)
	assert.equal(result.matches[0].confidence, 'exact')
	db.close()
})

const LEO_STALL = '汇通A146'
const POLKA_FP = {
	product_type: 'iphone_case',
	visual_summary: 'Clear iPhone case with pastel polka dots and a silver MagSafe ring, photographed on fabric.',
	subject: 'Pastel Polka Dots',
	motifs: ['polka dots', 'pastel circles', 'colored dots'],
	colors: ['pastel', 'pink', 'mint', 'yellow'],
	printed_text: ['soo ot'],
	has_magsafe: true,
	has_charm: false,
	has_grip: true,
	search_phrases: ['pastel polka dots iphone case', 'pastel dots magsafe'],
	confidence: 86,
}

function seedLeoCatalog(db) {
	seedMap(db, 'Pastel Polka Dots From leo MAGSAFE iPhone Case', 'leo', LEO_STALL)
	seedMap(db, 'Monkey Pink MAGSAFE iPhone Case', 'leo', LEO_STALL)
	seedMap(db, 'Pastel Starfield Pink iPhone Case', 'leo', LEO_STALL)
	seedMap(db, 'Pastel Stars Pink iPhone Case with charm', 'leo', LEO_STALL)
	seedMap(db, 'Pink Lily Flower MAGSAFE Case iPhone', 'leo', LEO_STALL)
	seedMap(db, 'Kuromi Bow Black iPhone Case', 'HAN Booth', 'A2-21')
}

test('lexical retrieve ranks leo pastel polka dots first from a phone-snap fingerprint', () => {
	const db = initDb(':memory:')
	seedLeoCatalog(db)
	const rows = vision.loadCatalogRows(db)
	const scored = vision.scoreCatalogRows(rows, POLKA_FP, { byNorm: new Map(), byCanon: new Map() })
	assert.ok(scored.length >= 1)
	assert.match(scored[0].title, /Pastel Polka Dots/i)
	assert.equal(scored[0].shop_name, 'leo')
	assert.equal(scored[0].stall, LEO_STALL)
	assert.equal(vision.lexicalConfidence(scored[0]), 'likely')
	assert.equal(vision.uniqueLexicalWinner(scored), true)
	assert.ok(scored.every((row) => !/Lily|Starfield|Stars Pink|Monkey/i.test(row.title)))
	db.close()
})

test('a title that leads with the print name beats other polka-dot cases', () => {
	const db = initDb(':memory:')
	seedMap(
		db,
		'Kawaii My Melody MAGSAFE Case with Grip & Beaded Charm, Pink Polka Dot Coquette Cover iPhone 17, Y2K Pastel Gift',
		'财神',
		'A232',
	)
	seedMap(
		db,
		'Pastel Polka Dots Frosted Clear Pink MAGSAFE iPhone Case with Beaded Strap, Cover for iPhone 17',
		'leo',
		LEO_STALL,
	)
	seedMap(
		db,
		'Pink Bunny MAGSAFE Case with Bunny Grip, Kawaii Pastel Polka-Dot Clear Cover iPhone 17',
		'鼎基',
		'A203A',
	)
	seedMap(db, 'Polka Dot Pink AirPods Case, Kawaii Cover for AirPods Pro', 'leo', LEO_STALL)
	const scored = vision.scoreCatalogRows(vision.loadCatalogRows(db), POLKA_FP, { byNorm: new Map(), byCanon: new Map() })
	assert.ok(scored.length >= 1)
	assert.equal(scored[0].shop_name, 'leo')
	assert.match(scored[0].title, /Pastel Polka Dots Frosted/i)
	assert.equal(scored[0].titleLead, true)
	assert.equal(vision.uniqueLexicalWinner(scored), true)
	assert.ok(!scored.some((row) => /AirPods/i.test(row.title) && row.score >= scored[0].score))
	db.close()
})

test('a unique vision winner stays likely and other polka cases drop to possible', async () => {
	const db = initDb(':memory:')
	seedMap(
		db,
		'Kawaii My Melody MAGSAFE Case with Grip & Beaded Charm, Pink Polka Dot Coquette Cover iPhone 17, Y2K Pastel Gift',
		'财神',
		'A232',
	)
	seedMap(
		db,
		'Pastel Polka Dots Frosted Clear Pink MAGSAFE iPhone Case with Beaded Strap, Cover for iPhone 17',
		'leo',
		LEO_STALL,
	)
	seedMap(
		db,
		'Pink Bunny MAGSAFE Case with Bunny Grip, Kawaii Pastel Polka-Dot Clear Cover iPhone 17',
		'鼎基',
		'A203A',
	)
	const result = await find.searchByPhoto(
		db,
		{ photo_data: TINY_PNG },
		{ vision: { describe: async () => POLKA_FP } },
	)
	assert.equal(result.matches[0].shop_name, 'leo')
	assert.equal(result.matches[0].confidence, 'likely')
	assert.ok(result.matches.slice(1).every((row) => row.confidence !== 'likely' && row.confidence !== 'exact'))
	db.close()
})

test('MagSafe hardware plus a colour does not rank every MagSafe case', () => {
	const db = initDb(':memory:')
	seedLeoCatalog(db)
	const scored = vision.scoreCatalogRows(vision.loadCatalogRows(db), {
		subject: 'iPhone Case',
		motifs: [],
		colors: ['pink'],
		has_magsafe: true,
		search_phrases: ['magsafe iphone case'],
	}, { byNorm: new Map(), byCanon: new Map() })
	assert.equal(scored.length, 0)
	db.close()
})

test('searchByPhoto reports vision_unavailable when the catalog exists but vision is off', async () => {
	const db = initDb(':memory:')
	seedLeoCatalog(db)
	const result = await find.searchByPhoto(db, { photo_data: TINY_PNG }, { vision: false })
	assert.equal(result.reason, 'vision_unavailable')
	assert.deepEqual(result.matches, [])
	db.close()
})

test('searchByPhoto skips vision when dHash already has an exact listing match', async () => {
	const db = initDb(':memory:')
	const buf = await sharp({
		create: { width: 48, height: 48, channels: 3, background: { r: 220, g: 20, b: 60 } },
	})
		.png()
		.toBuffer()
	const title = 'Crimson Heart Phone Case iPhone 15'
	seedListing(db, 501, title)
	seedMap(db, title, 'Tongxin V8', '5C61')
	seedHash(db, 501, await computeDHash(buf), await computeDesignHash(buf))
	let described = false
	const result = await find.searchByPhoto(
		db,
		{ photo_data: 'data:image/png;base64,' + buf.toString('base64') },
		{
			vision: {
				describe: async () => {
					described = true
					throw new Error('vision must not run on an exact hash hit')
				},
			},
		},
	)
	assert.equal(described, false)
	assert.equal(result.source, 'phash')
	assert.equal(result.matches[0].shop_name, 'Tongxin V8')
	db.close()
})

test('searchByPhoto locates leo from a phone-snap fingerprint when hashes cannot', async () => {
	const db = initDb(':memory:')
	seedLeoCatalog(db)
	seedListing(db, 1, 'Unrelated Distant Product')
	seedHash(db, 1, D81, D81)
	let described = 0
	const result = await find.searchByPhoto(
		db,
		{ photo_data: TINY_PNG },
		{
			vision: {
				describe: async () => {
					described += 1
					return POLKA_FP
				},
			},
		},
	)
	assert.equal(described, 1)
	assert.equal(result.reason, null)
	assert.equal(result.source, 'vision')
	assert.ok(result.matches.length >= 1)
	assert.equal(result.matches[0].shop_name, 'leo')
	assert.equal(result.matches[0].stall, LEO_STALL)
	assert.equal(result.matches[0].match_kind, 'vision')
	assert.equal(result.matches[0].confidence, 'likely')
	assert.equal(result.query.subject, 'Pastel Polka Dots')
	db.close()
})

test('searchByPhoto reports vision_failed when describe throws', async () => {
	const db = initDb(':memory:')
	seedLeoCatalog(db)
	const result = await find.searchByPhoto(
		db,
		{ photo_data: TINY_PNG },
		{
			vision: {
				describe: async () => {
					throw new Error('provider down')
				},
			},
		},
	)
	assert.equal(result.reason, 'vision_failed')
	assert.deepEqual(result.matches, [])
	db.close()
})

const BARE_POLKA_FP = {
	product_type: 'iphone_case',
	subject: 'Polka Dots',
	motifs: ['polka dots'],
	colors: [],
	search_phrases: ['polka dot iphone case', 'polka dots magsafe'],
	has_magsafe: true,
	confidence: 70,
}

function seedCrowdedPolka(db) {
	seedMap(db, 'Red Polka Dot MagSafe Case with Heart Cherry Grip, Retro Coquette Cover iPhone 17', '有米', '5C52-53')
	seedMap(db, '3D Plush Angel Wing MagSafe Case Kawaii Cat Ear Cover iPhone 17', '唯爆', '5A13')
	seedMap(db, 'Clear Polka Dot MAGSAFE Case with Pink Strawberry Shaker Grip & Beaded Charm', '卷卷', 'A237')
	seedMap(
		db,
		'Coquette Satin Flower MAGSAFE Case with Grip & Charm, Kawaii Blue Pink Polka Dot Cover iPhone 17',
		'ONE',
		'5A01-03',
	)
	seedMap(db, 'Cute 3D Plush Bear Pink Polka Dot Case w/ Star Charm, Coquette Bow Aesthetic Cover', '橙小姐', '5A31')
	seedMap(db, 'Cute Kawaii Bunny & Bear Case with Beaded Charm, Clear Polka Dot Black White Cover', '丰达', 'A211')
	seedMap(db, 'Cute Melanie Miffy Bunny MagSafe Case with Magnetic Grip & Charm, Polka Dot Cover', '亦森', 'A285')
	seedMap(
		db,
		'Pastel Polka Dots Frosted Clear Pink MAGSAFE iPhone Case with Beaded Strap, Cover for iPhone 17',
		'leo',
		LEO_STALL,
	)
}

test('a bare Polka Dots subject is not a unique shop winner on a crowded catalog', () => {
	const db = initDb(':memory:')
	seedCrowdedPolka(db)
	const scored = vision.scoreCatalogRows(vision.loadCatalogRows(db), BARE_POLKA_FP, {
		byNorm: new Map(),
		byCanon: new Map(),
	})
	assert.equal(vision.uniqueLexicalWinner(scored), false)
	assert.equal(vision.needsVisualRerank(scored), true)
	const lexical = vision.matchesFromLexical(scored)
	assert.ok(lexical.length >= 1)
	assert.ok(lexical.length <= vision.AMBIGUOUS_RESULTS)
	assert.ok(lexical.every((row) => row.confidence !== 'likely' && row.confidence !== 'exact'))
	assert.ok(scored.slice(0, vision.RERANK_CAP).some((row) => row.shop_name === 'leo'))
	db.close()
})

test('a colour-family on a generic Polka Dots subject recovers the pastel leo title', () => {
	const db = initDb(':memory:')
	seedCrowdedPolka(db)
	const fp = vision.normalizeFingerprint({ ...BARE_POLKA_FP, colors: ['pastel'] })
	assert.match(fp.subject, /pastel/i)
	const scored = vision.scoreCatalogRows(vision.loadCatalogRows(db), fp, { byNorm: new Map(), byCanon: new Map() })
	assert.equal(scored[0].shop_name, 'leo')
	assert.equal(scored[0].titleLead, true)
	assert.equal(vision.uniqueLexicalWinner(scored), true)
	assert.equal(vision.needsVisualRerank(scored), false)
	db.close()
})

test('visual rerank keeps only the same-print pastel case among crowded polka shops', async () => {
	const db = initDb(':memory:')
	seedCrowdedPolka(db)
	let reranked = false
	const result = await find.searchByPhoto(
		db,
		{ photo_data: TINY_PNG },
		{
			vision: {
				describe: async () => BARE_POLKA_FP,
				rerank: async ({ candidates }) => {
					reranked = true
					const idx = candidates.findIndex((c) => /Pastel Polka Dots/i.test(c.title))
					assert.ok(idx >= 0, 'leo must sit in the visual shortlist')
					return [{ index: idx + 1, same_print: true, confidence: 91, reason: 'same pastel dots' }]
				},
			},
		},
	)
	assert.equal(reranked, true)
	assert.equal(result.matches.length, 1)
	assert.equal(result.matches[0].shop_name, 'leo')
	assert.equal(result.matches[0].stall, LEO_STALL)
	assert.equal(result.matches[0].confidence, 'exact')
	assert.equal(result.matches[0].match_kind, 'vision')
	db.close()
})

test('vision matches attach the listing thumbnail even without a rerank pass', async () => {
	const db = initDb(':memory:')
	const title = 'Pastel Polka Dots From leo MAGSAFE iPhone Case'
	seedLeoCatalog(db)
	seedListing(db, 777, title)
	const result = await find.searchByPhoto(
		db,
		{ photo_data: TINY_PNG },
		{ vision: { describe: async () => POLKA_FP } },
	)
	assert.equal(result.matches[0].shop_name, 'leo')
	assert.equal(result.matches[0].listing_id, 777)
	assert.equal(result.matches[0].image_url, '/api/route/listing-image/777?w=300')
	db.close()
})

const KUROMI_COLLAGE_FP = {
	product_type: 'iphone_case',
	visual_summary:
		'Clear sparkle iPhone case with a lavender camera bumper, dense Kuromi sticker collage, My Melody accents, and a KUROMI logo bar at the bottom.',
	subject: 'Kuromi Sticker Collage',
	motifs: ['kuromi', 'sticker collage', 'my melody', 'holographic stars'],
	colors: ['purple', 'lavender'],
	printed_text: ['KUROMI'],
	characters: ['Kuromi', 'My Melody'],
	composition: 'sticker_collage',
	bumper_color: 'lavender',
	has_magsafe: false,
	has_charm: false,
	has_grip: false,
	search_phrases: ['kuromi sticker collage iphone case', 'kuromi clear purple glitter case'],
	confidence: 88,
}

function seedKuromiCrowd(db) {
	seedMap(
		db,
		'Kawaii Kuromi Case with Goth Beaded Charm, Cute Purple Clear Starry Cover iPhone 17 16 15 14 13 Pro Max, Y2K Coquette Aesthetic Gift',
		'jy',
		'4C21',
	)
	seedMap(
		db,
		'Kuromi Phone Case Clear Purple, Kawaii Y2K Cute iPhone Case with Charm, Glitter Star Bow Heart Skull Cover for iPhone 17 16 15 Pro Max Gift',
		'jy',
		'4C21',
	)
	seedMap(
		db,
		'Kuromi Clear Phone Case with Charm, Kawaii Y2K Sanrio Sticker Collage Cute Cover for iPhone 17 16 15 14 13 Pro Max, Gift Ideas',
		'领尚',
		'4C86',
	)
	seedMap(
		db,
		'Cute Sanrio Sticker Collage Clear Case with Red Bow Charm, Kawaii Hello Kitty Cover iPhone 17 16 15 14 13 Pro Max, Y2K Aesthetic Gift',
		'连家',
		'5B16',
	)
	seedMap(
		db,
		'Kuromi Style My Melody Glitter Case w/ 3D Grip Charm, Goth Jirai Kei Cover iPhone 17 16 15 14 Pro Max, Dark Cute Anime Bow Gift',
		'mj',
		'A295',
	)
	seedMap(
		db,
		'3D Cat Charm Clear Cat Sticker Collage White iPhone Case with Star Strap, Cover for iPhone 17 16 15 Pro Max, Gift for Her',
		'耐壳',
		'4A53',
	)
	seedMap(
		db,
		'Kawaii Sanrio MagSafe Shaker Case with Hello Kitty Grip Charm, Cute Pink Kuromi My Melody Cover iPhone 17',
		'亦森',
		'A285',
	)
	seedMap(db, 'Cute Kuromi Case Purple Star Clear iPhone Cover', '', 'A233')
}

test('charactersInText reads catalog names and ignores stuffed franchise words', () => {
	assert.deepEqual(vision.charactersInText('Kawaii Kuromi Case with Goth Beaded Charm'), ['Kuromi'])
	assert.ok(vision.charactersInText('Cute Sanrio Sticker Collage Hello Kitty Cover').includes('Hello Kitty'))
	assert.ok(!vision.charactersInText('Cute Sanrio Sticker Collage Hello Kitty Cover').includes('Kuromi'))
	assert.ok(vision.charactersInText('Kuromi Style My Melody Glitter Case').includes('Kuromi'))
	assert.ok(vision.charactersInText('Kuromi Style My Melody Glitter Case').includes('My Melody'))
})

test('a Kuromi collage fingerprint is not a unique lexical shop winner', () => {
	assert.equal(vision.hasDistinctivePrintName(KUROMI_COLLAGE_FP), false)
	assert.deepEqual(vision.extractCharacters(KUROMI_COLLAGE_FP)[0], 'Kuromi')
})

test('character gate keeps JY in the Kuromi shortlist and drops Hello Kitty collages', () => {
	const db = initDb(':memory:')
	seedKuromiCrowd(db)
	const scored = vision.scoreCatalogRows(vision.loadCatalogRows(db), KUROMI_COLLAGE_FP, {
		byNorm: new Map(),
		byCanon: new Map(),
	})
	assert.equal(vision.uniqueLexicalWinner(scored, KUROMI_COLLAGE_FP), false)
	assert.equal(vision.needsVisualRerank(scored, KUROMI_COLLAGE_FP), true)
	assert.ok(
		scored.some((row) => row.shop_name === 'jy' && /Kuromi/i.test(row.title)),
		'JY Kuromi titles must survive SEO-stuffed collage titles',
	)
	assert.ok(scored.slice(0, vision.RERANK_CAP).some((row) => row.shop_name === 'jy'))
	assert.ok(!scored.some((row) => row.shop_name === '连家'))
	assert.ok(!scored.some((row) => row.shop_name === '耐壳'))
	assert.ok(scored.every((row) => /kuromi|my melody/i.test(row.title)))
	const jy = scored.filter((row) => row.shop_name === 'jy')
	const stuffed = scored.find((row) => row.shop_name === '领尚')
	const sparse = scored.find((row) => row.stall === 'A233')
	assert.ok(jy.length)
	assert.ok(stuffed)
	assert.equal(scored[0].shop_name, 'jy')
	assert.equal(scored[0].stall, '4C21')
	assert.ok(
		jy[0].score >= stuffed.score * 0.85,
		'JY short-title Kuromi must not be drowned by sticker-collage stuffing',
	)
	if (sparse) assert.ok(sparse.score < jy[0].score, 'generic purple-star Kuromi must not beat JY')
	db.close()
})

test('visual rerank of a Kuromi snap picks JY even when collage keywords point elsewhere', async () => {
	const db = initDb(':memory:')
	seedKuromiCrowd(db)
	let reranked = false
	const result = await find.searchByPhoto(
		db,
		{ photo_data: TINY_PNG },
		{
			vision: {
				describe: async () => KUROMI_COLLAGE_FP,
				rerank: async ({ candidates }) => {
					reranked = true
					const idx = candidates.findIndex((c) => c.shop_name === 'jy' && /Kawaii Kuromi Case/i.test(c.title))
					assert.ok(idx >= 0, 'JY must sit in the visual shortlist, not only SEO collage titles')
					return [{ index: idx + 1, same_print: true, confidence: 94, reason: 'same lavender Kuromi collage and KUROMI logo bar' }]
				},
			},
		},
	)
	assert.equal(reranked, true)
	assert.equal(result.matches[0].shop_name, 'jy')
	assert.equal(result.matches[0].stall, '4C21')
	assert.equal(result.matches[0].confidence, 'exact')
	assert.ok(!result.matches.some((row) => row.shop_name === '连家'))
	db.close()
})

test('an extra Hello Kitty in the title is penalised when the snap is a Kuromi print', () => {
	const db = initDb(':memory:')
	seedKuromiCrowd(db)
	const scored = vision.scoreCatalogRows(vision.loadCatalogRows(db), KUROMI_COLLAGE_FP, {
		byNorm: new Map(),
		byCanon: new Map(),
	})
	const mixed = scored.find((row) => row.shop_name === '亦森')
	const grip = scored.find((row) => row.shop_name === 'mj')
	const jy = scored.find((row) => row.shop_name === 'jy')
	assert.ok(jy)
	if (mixed) assert.ok(mixed.score < jy.score, 'Hello Kitty + Kuromi stuffing must lose to a Kuromi-primary title')
	if (grip) assert.ok(grip.score < jy.score, 'a grip-case title must lose to a flat collage snap')
	db.close()
})

test('starry cover titles share a Stars motif with the query', () => {
	const db = initDb(':memory:')
	seedMap(db, 'Kawaii Kuromi Case Cute Purple Clear Starry Cover', 'jy', '4C21')
	seedMap(db, 'Cute Kuromi Case Purple Star Clear iPhone Cover', '', 'A233')
	const scored = vision.scoreCatalogRows(vision.loadCatalogRows(db), KUROMI_COLLAGE_FP, {
		byNorm: new Map(),
		byCanon: new Map(),
	})
	assert.equal(scored[0].shop_name, 'jy')
	const sparse = scored.find((row) => row.stall === 'A233')
	assert.ok(sparse)
	assert.ok(scored[0].score > sparse.score)
	db.close()
})

test('a contact sheet of two listing thumbs is a single JPEG', async () => {
	const left = await sharp({
		create: { width: 80, height: 120, channels: 3, background: { r: 200, g: 160, b: 210 } },
	})
		.jpeg()
		.toBuffer()
	const right = await sharp({
		create: { width: 90, height: 90, channels: 3, background: { r: 40, g: 40, b: 50 } },
	})
		.jpeg()
		.toBuffer()
	const sheet = await vision.composePairSheet(left, right)
	const meta = await sharp(sheet).metadata()
	assert.equal(meta.format, 'jpeg')
	assert.equal(meta.width, 480)
	assert.equal(meta.height, 240)
})

;(async () => {
	for (const job of jobs) {
		try {
			await job.fn()
			passed++
			console.log(`  ${GREEN}ok${RESET}  — ${job.name}`)
		} catch (err) {
			failed++
			console.error(`  ${RED}FAIL${RESET} — ${job.name}`)
			console.error(`         ${err.message}`)
		}
	}
	if (failed) {
		console.error(`\n${failed} failed, ${passed} passed`)
		process.exit(1)
	}
	console.log(`\n${passed} passed`)
})()
