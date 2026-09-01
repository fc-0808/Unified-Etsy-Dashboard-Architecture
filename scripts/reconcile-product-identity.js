'use strict'

/**
 * One-shot: re-run canonical product identity against the live DB and persist
 * updated listing_phash.canonical_key values. Used after identity-logic changes
 * so the shopping route picks up merges without waiting for the next image
 * hydration cycle.
 *
 * Run: node scripts/reconcile-product-identity.js
 */

const path = require('path')
const Database = require('better-sqlite3')
const productSimilarity = require('../src/route/product-similarity')
const productMerges = require('../src/route/product-merges')
const routeDashboard = require('../src/route/dashboard')

const PRODUCT_HASH_ALGO = 'dhash256-v2'

const dbPath = path.join(process.env.LOCALAPPDATA || '', 'EtsyDashboard', 'etsy_dashboard.db')
const db = new Database(dbPath)

function collectProductIdentityTokens(listingIds) {
	const tokens = new Map()
	const wanted = new Set(listingIds.map(Number))
	const add = (listingId, token) => {
		const id = Number(listingId)
		if (!wanted.has(id) || !token) return
		if (!tokens.has(id)) tokens.set(id, [])
		const list = tokens.get(id)
		if (!list.includes(token)) list.push(token)
	}
	const addTitle = (listingId, title) => {
		const norm = routeDashboard.normalizeTitle(title || '')
		if (norm) add(listingId, `title:${norm}`)
	}
	try {
		db.prepare("SELECT DISTINCT listing_id, title FROM transactions WHERE listing_id IS NOT NULL AND title IS NOT NULL AND trim(title) <> ''")
			.all()
			.forEach((r) => addTitle(r.listing_id, r.title))
	} catch (e) {
		console.warn('transaction titles unavailable:', e.message)
	}
	try {
		db.prepare("SELECT listing_id, title FROM listings WHERE listing_id IS NOT NULL AND title IS NOT NULL AND trim(title) <> ''")
			.all()
			.forEach((r) => addTitle(r.listing_id, r.title))
	} catch {
		/* optional */
	}
	try {
		db.prepare("SELECT listing_id, product_folder FROM bulk_job_items WHERE listing_id IS NOT NULL AND product_folder IS NOT NULL AND trim(product_folder) <> ''")
			.all()
			.forEach((r) => add(r.listing_id, `folder:${r.product_folder}`))
	} catch {
		/* optional */
	}
	return tokens
}

const rows = db.prepare('SELECT listing_id, phash, design_phash, canonical_key FROM listing_phash WHERE algo = ? ORDER BY listing_id').all(PRODUCT_HASH_ALGO)
if (!rows.length) {
	console.log('No listing_phash rows — nothing to reconcile.')
	process.exit(0)
}

const productByTitle = new Map()
db.prepare('SELECT title_norm, stall FROM product_map')
	.all()
	.forEach((r) =>
		productByTitle.set(
			r.title_norm,
			String(r.stall || '')
				.replace(/\s+/g, '')
				.toUpperCase(),
		),
	)

const stallsByListing = new Map()
const titleByListing = new Map()
db.prepare('SELECT DISTINCT listing_id, title FROM transactions WHERE listing_id IS NOT NULL')
	.all()
	.forEach((r) => {
		const lid = Number(r.listing_id)
		if (!titleByListing.has(lid) && r.title) titleByListing.set(lid, r.title)
		const stall = productByTitle.get(routeDashboard.normalizeTitle(r.title))
		if (!stall) return
		if (!stallsByListing.has(lid)) stallsByListing.set(lid, new Set())
		stallsByListing.get(lid).add(stall)
	})

const identityTokens = collectProductIdentityTokens(rows.map((r) => Number(r.listing_id)))
const resolved = productSimilarity.resolveProductIdentity({
	listings: rows.map((row) => ({
		listing_id: Number(row.listing_id),
		phash: row.phash,
		designPhash: row.design_phash,
		title: titleByListing.get(Number(row.listing_id)),
		stalls: stallsByListing.get(Number(row.listing_id)),
		identityKeys: identityTokens.get(Number(row.listing_id)),
	})),
	forcedPairs: productMerges.getMergeEdges(db),
})

const update = db.prepare('UPDATE listing_phash SET canonical_key = ? WHERE listing_id = ?')
let updated = 0
const changed = []
const tx = db.transaction(() => {
	for (const row of rows) {
		const key = resolved.keyByListing.get(Number(row.listing_id))
		if (!key || row.canonical_key === key) continue
		update.run(key, row.listing_id)
		updated++
		changed.push({ listing_id: Number(row.listing_id), from: row.canonical_key, to: key })
	}
})
tx()

console.log(`Reconciled ${updated} listing key(s) across ${resolved.groups.length} product(s)`)
console.log('stats:', resolved.stats)

// Show the Usahana pair specifically
const focus = [4545666488, 4541247998, 4539223596]
console.log('\nUsahana / Rainbow Bunny keys after reconcile:')
for (const id of focus) {
	const row = db.prepare('SELECT canonical_key FROM listing_phash WHERE listing_id = ?').get(id)
	const title = titleByListing.get(id) || ''
	console.log(`  #${id} → ${row?.canonical_key || '-'} | ${title.slice(0, 70)}`)
}

if (changed.length && changed.length <= 40) {
	console.log('\nChanged keys:')
	for (const c of changed) console.log(`  #${c.listing_id}: ${c.from} → ${c.to}`)
} else if (changed.length) {
	console.log(`\n(${changed.length} keys changed; showing first 20)`)
	for (const c of changed.slice(0, 20)) console.log(`  #${c.listing_id}: ${c.from} → ${c.to}`)
}

db.close()
