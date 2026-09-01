'use strict'

/**
 * Regression — Route-tab manual order line identity must be ONE key everywhere.
 *
 * A buyer who ordered Case+Grip+Charm for four different listings (Elle's
 * Y2KASE order) marked several components Purchased in mobile Shopping Mode.
 * Coming back to the Orders tab, only one Charm ✓ showed, and Ready-to-pack /
 * the needs-purchase rollup ignored the rest — because the Orders tab derived
 * `lineItemKey(title, listing_id)` while Shopping Mode wrote under the
 * `lineItemKeyWithVariant(…)` keys stored in `route_manual_items`.
 *
 * This suite pins the contract that prevents that split:
 *   1. Pure alignLineKeys / canonicalizeLineKey behaviour (no DB).
 *   2. End-to-end: create a multi-item manual order, mark purchased under the
 *      canonical key, then confirm orderLineItems-style resolution + buy-queue
 *      classification + Orders-tab alias writes all see the same state.
 *   3. Startup heal merges a ghost (plain-key) assignment onto the canonical row.
 *
 * Run: `node scripts/test-manual-line-identity.js`
 */

const {
	initDb,
	createRouteManualOrder,
	upsertRouteAssignment,
	healManualLineKeyAliases,
	MANUAL_SHOP_ID,
} = require('../src/db/setup')
const routeDashboard = require('../src/route/dashboard')
const buyQueue = require('../src/orders/buy-queue')
const lineIdentity = require('../src/orders/line-identity')

let failures = 0
function assert(cond, msg) {
	if (cond) console.log(`  ok  — ${msg}`)
	else {
		failures++
		console.error(`  FAIL — ${msg}`)
	}
}

function line(title, extras = {}) {
	const listingId = extras.listing_id != null ? extras.listing_id : null
	return {
		source: 'catalog',
		title,
		listing_id: listingId,
		phone_model: extras.phone_model || '',
		style: extras.style || '',
		quantity: 1,
		shop_name: 'Manual Orders',
		item_key:
			extras.item_key ||
			routeDashboard.lineItemKeyWithVariant(title, listingId, extras.phone_model || '', extras.style || ''),
	}
}

console.log('Manual line-identity regression test\n')

// ── 1. Pure alignment ──────────────────────────────────────────────────────
{
	console.log('1. alignLineKeys prefers stored variant keys over derived plain keys')
	const txs = [
		{
			title: 'Cute Rilakkuma MAGSAFE Case with Strawberry Shaker Grip & Charm, Kawaii Pink Clear Cover',
			listing_id: 4460710495,
			quantity: 1,
			variations: [
				{ formatted_name: 'Phone Model', formatted_value: 'iPhone 14/13' },
				{ formatted_name: 'Style', formatted_value: 'Case+Grip+Charm' },
			],
		},
		{
			title: 'Fuzzy Miffy MagSafe Phone Case with Plush Bunny Grip & Beaded Charm',
			listing_id: 4485759413,
			quantity: 1,
			variations: [
				{ formatted_name: 'Phone Model', formatted_value: 'iPhone 14/13' },
				{ formatted_name: 'Style', formatted_value: 'Case+Grip+Charm' },
			],
		},
	]
	const stored = [
		routeDashboard.lineItemKeyWithVariant(txs[0].title, txs[0].listing_id, 'iPhone 14/13', 'Case+Grip+Charm'),
		routeDashboard.lineItemKeyWithVariant(txs[1].title, txs[1].listing_id, 'iPhone 14/13', 'Case+Grip+Charm'),
	]
	const keys = lineIdentity.alignLineKeys(txs, stored)
	assert(keys[0] === stored[0], 'first line resolves to its variant key')
	assert(keys[1] === stored[1], 'second line resolves to its variant key')
	assert(keys[0] !== lineIdentity.derivedLineKey(txs[0]), 'variant key is NOT the plain product key')
	assert(keys[0].includes('#V'), 'resolved key carries the #V variant marker')

	const etsyKeys = lineIdentity.alignLineKeys(txs, [])
	assert(etsyKeys[0] === lineIdentity.derivedLineKey(txs[0]), 'Etsy orders (no sidecars) keep the plain key')
}

{
	console.log('\n2. Same listing, two models — each claims its own variant key')
	const title = 'Shared Design Case'
	const listingId = 999
	const txs = [
		{
			title,
			listing_id: listingId,
			variations: [
				{ formatted_name: 'Phone Model', formatted_value: 'iPhone 15 Pro' },
				{ formatted_name: 'Style', formatted_value: 'Case Only' },
			],
		},
		{
			title,
			listing_id: listingId,
			variations: [
				{ formatted_name: 'Phone Model', formatted_value: 'iPhone 16' },
				{ formatted_name: 'Style', formatted_value: 'Case Only' },
			],
		},
	]
	const stored = [
		routeDashboard.lineItemKeyWithVariant(title, listingId, 'iPhone 15 Pro', 'Case Only'),
		routeDashboard.lineItemKeyWithVariant(title, listingId, 'iPhone 16', 'Case Only'),
	]
	const keys = lineIdentity.alignLineKeys(txs, stored)
	assert(keys[0] === stored[0] && keys[1] === stored[1], 'each model maps to its own stored key')
	assert(keys[0] !== keys[1], 'the two lines stay distinct')
}

{
	console.log('\n3. canonicalizeLineKey redirects an unambiguous plain alias')
	const plain = routeDashboard.lineItemKey('Solo Case', 111)
	const variant = routeDashboard.lineItemKeyWithVariant('Solo Case', 111, 'iPhone 15', 'Case Only')
	assert(lineIdentity.canonicalizeLineKey(plain, [variant]) === variant, 'plain → unique variant')
	assert(lineIdentity.canonicalizeLineKey(variant, [variant]) === variant, 'already-canonical is a no-op')
	assert(lineIdentity.canonicalizeLineKey(plain, []) === plain, 'no sidecars → leave alone')

	const v1 = routeDashboard.lineItemKeyWithVariant('Duo', 222, 'iPhone 15', 'Case Only')
	const v2 = routeDashboard.lineItemKeyWithVariant('Duo', 222, 'iPhone 16', 'Case Only')
	const plainDuo = routeDashboard.lineItemKey('Duo', 222)
	assert(
		lineIdentity.canonicalizeLineKey(plainDuo, [v1, v2]) === plainDuo,
		'ambiguous plain alias is NOT guessed',
	)
}

{
	console.log('\n4. Dedup family (~2, ~3) is claimed in order')
	const title = 'Custom Upload'
	const base = routeDashboard.lineItemKey(title, null)
	const txs = [{ title, listing_id: null, variations: [] }, { title, listing_id: null, variations: [] }]
	const stored = [base, `${base}~2`]
	const keys = lineIdentity.alignLineKeys(txs, stored)
	assert(keys[0] === base && keys[1] === `${base}~2`, 'identical custom lines claim base then ~2')
}

// ── 5. End-to-end: purchase under variant key is visible to buy-queue ───────
{
	console.log('\n5. Shopping Mode purchase under variant key is visible to buy-queue + rollup readers')
	const db = initDb(':memory:')
	const created = createRouteManualOrder(db, {
		shop_id: MANUAL_SHOP_ID,
		items: [
			line('Cute Rilakkuma Case', {
				listing_id: 4460710495,
				phone_model: 'iPhone 14/13',
				style: 'Case+Grip+Charm',
			}),
			line('Fuzzy Miffy Case', {
				listing_id: 4485759413,
				phone_model: 'iPhone 14/13',
				style: 'Case+Grip+Charm',
			}),
			line('Pink Miffy Case', {
				listing_id: 4445222607,
				phone_model: 'iPhone 17 Pro',
				style: 'Case+Grip+Charm',
			}),
			line('Yellow Winter Miffy Case', {
				listing_id: 4445232802,
				phone_model: 'iPhone 14 Pro Max',
				style: 'Case+Grip+Charm',
			}),
		],
	})
	assert(created.items.length === 4, `created 4 sidecars (got ${created.items.length})`)
	assert(
		created.items.every((it) => it.item_key.includes('#V')),
		'every sidecar uses a variant key',
	)

	// Mark ALL components Purchased under the CANONICAL keys (what Shopping Mode does).
	for (const it of created.items) {
		upsertRouteAssignment(db, {
			receipt_id: created.receipt_id,
			item_key: it.item_key,
			title: it.title,
			status_case: 'Purchased',
			status_grip: 'Purchased',
			status_charm: 'Purchased',
		})
	}

	const receipt = db.prepare('SELECT receipt_id, all_transactions FROM receipts WHERE receipt_id = ?').get(created.receipt_id)
	let txs = []
	try {
		txs = JSON.parse(receipt.all_transactions || '[]')
	} catch {
		txs = []
	}

	// The bug: plain keys miss every assignment.
	const plainMisses = txs.every((t) => {
		const plain = routeDashboard.lineItemKey(t.title, t.listing_id)
		const row = db.prepare('SELECT 1 FROM route_assignments WHERE receipt_id = ? AND item_key = ?').get(created.receipt_id, plain)
		return !row
	})
	assert(plainMisses, 'plain title+listing keys do NOT find the Shopping Mode rows (the bug)')

	// The fix: alignLineKeys finds them all.
	const keys = lineIdentity.receiptLineKeys(db, created.receipt_id, txs)
	assert(keys.length === 4, 'resolver returns one key per transaction')
	assert(
		keys.every((k, i) => k === created.items[i].item_key),
		'resolved keys match the stored sidecar keys 1:1',
	)
	assert(
		keys.every((k) => {
			const a = db.prepare('SELECT status_case, status_grip, status_charm FROM route_assignments WHERE receipt_id = ? AND item_key = ?').get(created.receipt_id, k)
			return a && a.status_case === 'Purchased' && a.status_grip === 'Purchased' && a.status_charm === 'Purchased'
		}),
		'every resolved key reads Purchased/Purchased/Purchased',
	)

	const classified = buyQueue.classifyPurchaseState(db, [receipt])
	assert(classified.ready.has(created.receipt_id), 'buy-queue classifies the order as ready (fully purchased)')
	assert(!classified.outstanding.has(created.receipt_id), 'buy-queue does NOT leave it outstanding')

	// Alias write: Orders tab POSTs the plain key → must land on the variant row.
	const plainRilakkuma = routeDashboard.lineItemKey(txs[0].title, txs[0].listing_id)
	const canon = lineIdentity.canonicalLineKey(db, created.receipt_id, plainRilakkuma)
	assert(canon === created.items[0].item_key, 'Orders-tab plain key canonicalises to the variant key')
	upsertRouteAssignment(db, {
		receipt_id: created.receipt_id,
		item_key: canon,
		status_case: 'Out of Stock',
	})
	const after = db
		.prepare('SELECT status_case FROM route_assignments WHERE receipt_id = ? AND item_key = ?')
		.get(created.receipt_id, created.items[0].item_key)
	assert(after.status_case === 'Out of Stock', 'canonicalised write updates the Shopping Mode row')
	assert(
		!db.prepare('SELECT 1 FROM route_assignments WHERE receipt_id = ? AND item_key = ?').get(created.receipt_id, plainRilakkuma),
		'no ghost row was created under the plain key',
	)

	db.close()
}

// ── 6. Startup heal merges a ghost assignment onto the canonical row ───────
{
	console.log('\n6. healManualLineKeyAliases merges a ghost plain-key row onto the variant key')
	const db = initDb(':memory:')
	const title = 'Cute Rilakkuma MAGSAFE Case with Strawberry Shaker Grip & Charm'
	const listingId = 4460710495
	const created = createRouteManualOrder(db, {
		shop_id: MANUAL_SHOP_ID,
		items: [line(title, { listing_id: listingId, phone_model: 'iPhone 14/13', style: 'Case+Grip+Charm' })],
	})
	const canonical = created.items[0].item_key
	const plain = routeDashboard.lineItemKey(title, listingId)
	assert(canonical !== plain, 'fixture uses a variant key distinct from the plain key')

	// Canonical row: what Shopping Mode wrote (partial).
	upsertRouteAssignment(db, {
		receipt_id: created.receipt_id,
		item_key: canonical,
		title,
		status_case: 'Out of Stock',
		status_grip: 'Purchased',
		status_charm: 'Purchased',
	})
	// Ghost row: what a stale Orders-tab client wrote under the plain key.
	db.prepare(`
		INSERT INTO route_assignments
			(receipt_id, item_key, title, status_case, status_grip, status_charm, verified_at, verified_by, updated_at)
		VALUES (?, ?, ?, 'Pending', 'Pending', 'Purchased', 12345, 'hope', 999)
	`).run(created.receipt_id, plain, title)

	const result = healManualLineKeyAliases(db)
	assert(result.merged === 1, `heal merged exactly one ghost (got merged=${result.merged})`)
	assert(
		!db.prepare('SELECT 1 FROM route_assignments WHERE receipt_id = ? AND item_key = ?').get(created.receipt_id, plain),
		'ghost plain-key row is gone',
	)
	const healed = db
		.prepare('SELECT status_case, status_grip, status_charm, verified_at, verified_by FROM route_assignments WHERE receipt_id = ? AND item_key = ?')
		.get(created.receipt_id, canonical)
	assert(healed.status_case === 'Out of Stock', 'merged case status prefers Out of Stock over Pending')
	assert(healed.status_grip === 'Purchased', 'merged grip status stays Purchased')
	assert(healed.status_charm === 'Purchased', 'merged charm status stays Purchased')
	assert(healed.verified_at === 12345 && healed.verified_by === 'hope', 'verification stamp survives the merge')

	// Idempotent.
	const again = healManualLineKeyAliases(db)
	assert(again.merged === 0 && again.renamed === 0, 're-running heal is a no-op')

	db.close()
}

// ── 7. Heal renames a lone ghost (no canonical row yet) ────────────────────
{
	console.log('\n7. healManualLineKeyAliases renames a lone ghost onto the variant key')
	const db = initDb(':memory:')
	const title = 'Pink Miffy MagSafe Case'
	const listingId = 4445222607
	const created = createRouteManualOrder(db, {
		shop_id: MANUAL_SHOP_ID,
		items: [line(title, { listing_id: listingId, phone_model: 'iPhone 17 Pro', style: 'Case+Grip+Charm' })],
	})
	const canonical = created.items[0].item_key
	const plain = routeDashboard.lineItemKey(title, listingId)

	db.prepare(`
		INSERT INTO route_assignments
			(receipt_id, item_key, title, status_case, status_grip, status_charm, updated_at)
		VALUES (?, ?, ?, 'Purchased', 'Purchased', 'Purchased', 1)
	`).run(created.receipt_id, plain, title)

	const result = healManualLineKeyAliases(db)
	assert(result.renamed === 1, `heal renamed the lone ghost (got renamed=${result.renamed})`)
	const row = db
		.prepare('SELECT status_case, status_grip, status_charm FROM route_assignments WHERE receipt_id = ? AND item_key = ?')
		.get(created.receipt_id, canonical)
	assert(!!row && row.status_case === 'Purchased', 'purchase state now lives under the canonical key')
	assert(
		!db.prepare('SELECT 1 FROM route_assignments WHERE receipt_id = ? AND item_key = ?').get(created.receipt_id, plain),
		'plain-key row is gone after rename',
	)
	db.close()
}

if (failures) {
	console.error(`\n${failures} assertion(s) failed.`)
	process.exit(1)
}
console.log('\nAll manual line-identity assertions passed.')
