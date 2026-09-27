'use strict'

/**
 * Visual embeddings for find-by-photo: stored float32 vectors, cosine kNN.
 *
 * Run: node scripts/test-find-by-photo-embed.js
 */

const assert = require('node:assert/strict')
const { initDb } = require('../src/db/setup')
const { normalizeTitle } = require('../src/route/dashboard')
const embed = require('../src/route/product-image-embed')
const find = require('../src/route/find-by-photo')
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

async function colorJpeg(r, g, b) {
	return sharp({
		create: { width: 48, height: 64, channels: 3, background: { r, g, b } },
	})
		.jpeg()
		.toBuffer()
}

async function gridEmbed(buf) {
	const { data, info } = await sharp(buf)
		.resize(4, 4, { fit: 'fill' })
		.removeAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true })
	const vec = new Float32Array(info.width * info.height * 3)
	for (let i = 0; i < vec.length; i++) vec[i] = data[i] / 255
	return vec
}

function seedListing(db, id, title) {
	db.prepare("INSERT INTO listings (listing_id, shop_id, title, state) VALUES (?, 'S1', ?, 'active')").run(id, title)
}

function seedMap(db, title, shop, stall) {
	db.prepare(
		`INSERT INTO product_map (title_norm, title, shop_name, stall, canonical_product_key, status)
		 VALUES (?, ?, ?, ?, NULL, 'active')`,
	).run(normalizeTitle(title), title, shop, stall)
}

console.log('\nFind by photo embeddings\n')

test('embedding blob round-trips a float32 vector', () => {
	const vec = new Float32Array([0.1, -0.2, 0.3, 0.4])
	const blob = embed.embeddingToBlob(vec)
	const back = embed.blobToEmbedding(blob)
	assert.equal(back.length, 4)
	assert.ok(Math.abs(back[0] - 0.1) < 1e-6)
	assert.ok(Math.abs(back[1] + 0.2) < 1e-6)
	blob.writeFloatLE(9, 0)
	assert.ok(Math.abs(back[0] - 0.1) < 1e-6)
})

test('cosine of identical unit vectors is 1', () => {
	const a = new Float32Array([0.6, 0.8])
	assert.equal(embed.cosine(a, a), 1)
	assert.ok(embed.cosine(a, new Float32Array([0.8, -0.6])) < 0.2)
})

test('confidence bands use the measured Gemini phone-snap cutoffs', () => {
	assert.equal(embed.confidenceForCosine(0.937, 0.905, true), 'exact')
	assert.equal(embed.confidenceForCosine(0.915, 0.88, true), 'likely')
	assert.equal(embed.confidenceForCosine(0.915, 0.91, true), 'possible')
	assert.equal(embed.confidenceForCosine(0.89, null, true), 'possible')
	assert.equal(embed.confidenceForCosine(0.8, null, true), 'weak')
	assert.equal(embed.confidenceForCosine(0.7, null, true), 'distant')
})

test('rankByEmbedding returns the nearest stored listing', () => {
	const index = [
		{ listing_id: 1, vec: new Float32Array([1, 0, 0]) },
		{ listing_id: 2, vec: new Float32Array([0, 1, 0]) },
		{ listing_id: 3, vec: new Float32Array([0.2, 0.98, 0]) },
	]
	const ranked = embed.rankByEmbedding(index, new Float32Array([0, 1, 0]), { limit: 2 })
	assert.equal(ranked[0].listing_id, 2)
	assert.ok(ranked[0].score > ranked[1].score)
})

test('rankByEmbedding keeps the max cosine across query views', () => {
	const index = [
		{ listing_id: 1, vec: new Float32Array([1, 0, 0]) },
		{ listing_id: 2, vec: new Float32Array([0, 1, 0]) },
	]
	const ranked = embed.rankByEmbedding(index, [new Float32Array([0.2, 0, 0]), new Float32Array([0, 1, 0])], { limit: 2 })
	assert.equal(ranked[0].listing_id, 2)
	assert.ok(ranked[0].score > 0.99)
})

test('missingEmbeddingIds includes listings whose photo sha drifted', () => {
	const db = initDb(':memory:')
	const { PRODUCT_HASH_ALGO } = require('../src/route/product-image-hash')
	seedListing(db, 9, 'Drifted photo')
	db.prepare('INSERT INTO listing_image_data (listing_id, data) VALUES (?, ?)').run(9, Buffer.from('hello-bytes'))
	const algo = embed.embedAlgo()
	const vec = new Float32Array(8).fill(0.1)
	db.prepare(
		`INSERT INTO listing_vemb (listing_id, algo, dim, sha, embedding)
		 VALUES (?, ?, ?, ?, ?)`,
	).run(9, algo, 8, 'old-sha', embed.embeddingToBlob(vec))
	db.prepare(
		`INSERT INTO listing_phash (listing_id, phash, design_phash, sha, algo)
		 VALUES (9, ?, ?, 'new-sha', ?)`,
	).run('0'.repeat(64), '0'.repeat(64), PRODUCT_HASH_ALGO)
	assert.ok(embed.missingEmbeddingIds(db).includes(9))
	db.close()
})

test('searchByPhoto locates the shop from stored visual embeddings without reading titles', async () => {
	const db = initDb(':memory:')
	const crimson = await colorJpeg(220, 20, 60)
	const navy = await colorJpeg(20, 40, 200)
	const crimsonTitle = 'Crimson Heart Phone Case iPhone 15'
	const navyTitle = 'Navy Grid Phone Case iPhone 15'
	seedListing(db, 801, crimsonTitle)
	seedListing(db, 802, navyTitle)
	seedMap(db, crimsonTitle, 'jy', '4C21')
	seedMap(db, navyTitle, '领尚', '4C86')
	const algo = embed.embedAlgo()
	for (const [id, buf] of [
		[801, crimson],
		[802, navy],
	]) {
		const vec = await embed.computeEmbedding(buf, { embed: gridEmbed })
		db.prepare(
			`INSERT INTO listing_vemb (listing_id, algo, dim, sha, embedding)
			 VALUES (?, ?, ?, ?, ?)`,
		).run(id, algo, vec.length, 'sha-' + id, embed.embeddingToBlob(vec))
	}
	const result = await find.searchByPhoto(
		db,
		{ photo_data: 'data:image/jpeg;base64,' + crimson.toString('base64') },
		{ vision: false, embed: gridEmbed },
	)
	assert.equal(result.source, 'embed')
	assert.equal(result.reason, null)
	assert.ok(result.matches.length >= 1)
	assert.equal(result.matches[0].shop_name, 'jy')
	assert.equal(result.matches[0].stall, '4C21')
	assert.equal(result.matches[0].match_kind, 'embed')
	assert.ok(result.matches[0].confidence === 'exact' || result.matches[0].confidence === 'likely')
	assert.ok(!result.matches.some((row) => row.shop_name === '领尚' && row.confidence === 'exact'))
	db.close()
})

test('searchByPhoto drops unmatched listings when a catalog shop is in the shortlist', async () => {
	const db = initDb(':memory:')
	const queryRed = await colorJpeg(220, 20, 60)
	const mappedRed = await colorJpeg(180, 24, 70)
	const navy = await colorJpeg(20, 40, 200)
	const mappedTitle = 'Mapped Crimson Heart Phone Case'
	const navyTitle = 'Navy Grid Phone Case iPhone 15'
	seedListing(db, 801, mappedTitle)
	seedListing(db, 802, navyTitle)
	seedListing(db, 803, 'Unmapped Crimson Clone')
	seedMap(db, mappedTitle, 'jy', '4C21')
	seedMap(db, navyTitle, '领尚', '4C86')
	const algo = embed.embedAlgo()
	for (const [id, buf] of [
		[801, mappedRed],
		[802, navy],
		[803, queryRed],
	]) {
		const vec = await embed.computeEmbedding(buf, { embed: gridEmbed })
		db.prepare(
			`INSERT INTO listing_vemb (listing_id, algo, dim, sha, embedding)
			 VALUES (?, ?, ?, ?, ?)`,
		).run(id, algo, vec.length, 'sha-' + id, embed.embeddingToBlob(vec))
	}
	const result = await find.searchByPhoto(
		db,
		{ photo_data: 'data:image/jpeg;base64,' + queryRed.toString('base64') },
		{ vision: false, embed: gridEmbed },
	)
	assert.equal(result.source, 'embed')
	assert.ok(!result.matches.some((row) => row.listing_id === 803))
	assert.equal(result.matches[0].shop_name, 'jy')
	assert.equal(result.matches[0].stall, '4C21')
	db.close()
})

test('backfillListingEmbeddings indexes missing photos with an injected embedder', async () => {
	const db = initDb(':memory:')
	const crimson = await colorJpeg(220, 20, 60)
	seedListing(db, 901, 'Crimson')
	db.prepare('INSERT INTO listing_image_data (listing_id, data) VALUES (?, ?)').run(901, crimson)
	const n = await embed.backfillListingEmbeddings(db, { embed: gridEmbed })
	assert.equal(n, 1)
	assert.equal(embed.listingVembCount(db), 1)
	db.close()
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
