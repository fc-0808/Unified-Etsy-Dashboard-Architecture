'use strict'

/**
 * Address-review hold — military mail and every Australia destination must be
 * flagged before anyone shops the products.
 *
 * Pins the detector, the receipt-level persist rules (open / stay-cleared /
 * reopen-on-change / auto-release), and the shopping/packing/seal/route
 * exclusions so those surfaces can never disagree about which orders are held.
 *
 * Run: node scripts/test-address-review.js
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const addressReview = require('../src/orders/address-review')
const buyQueue = require('../src/orders/buy-queue')
const packQueue = require('../src/orders/pack-queue')
const { unsealableReasons } = require('../src/orders/seal-guard')
const routeDashboard = require('../src/route/dashboard')
const policy = require('../src/auth/policy')
const { initDb, insertManualOrder, upsertRouteAssignment, openShippingAddressHold, closeShippingAddressHolds, getIssuesForReceipt, upsertOrderIssue, ISSUE_TYPE_SHIPPING_ADDRESS } = require('../src/db/setup')

const ROOT = path.resolve(__dirname, '..')
const TYRA = Object.freeze({
	name: 'Tyra Jackson',
	first_line: 'PSC 80 BOX 15628',
	city: 'APO',
	state: 'AP',
	zip: '96367-0059',
	country_iso: 'US',
	formatted_address: 'Tyra Jackson\nPSC 80 BOX 15628\nAPO, AP 96367-0059\nUnited States',
})
const SYDNEY = Object.freeze({
	name: 'Alex Chen',
	first_line: '12 Example Street',
	city: 'Sydney',
	state: 'NSW',
	zip: '2000',
	country_iso: 'AU',
})
const PORTLAND = Object.freeze({
	name: 'Jamie Lee',
	first_line: '123 SW Main St',
	city: 'Portland',
	state: 'OR',
	zip: '97204',
	country_iso: 'US',
})
const TX = JSON.stringify([
	{
		title: 'Kawaii Frog MAGSAFE Case',
		listing_id: 555,
		quantity: 1,
		variations: [{ formatted_name: 'Style', formatted_value: 'Case Only' }],
	},
])
const NOW = Math.floor(Date.now() / 1000)

let passed = 0
let failed = 0
function check(name, cond, extra = '') {
	if (cond) {
		passed++
		console.log(`  ok  — ${name}`)
	} else {
		failed++
		console.error(`  FAIL — ${name}${extra ? `  ${extra}` : ''}`)
	}
}

function expectDetect(name, addr, reasons) {
	const d = addressReview.detect(addr)
	check(
		`${name} → ${reasons.length ? reasons.join('+') : 'clear'}`,
		d.required === reasons.length > 0 && reasons.every((r) => d.reasons.includes(r)) && d.reasons.length === reasons.length,
		`got required=${d.required} reasons=${JSON.stringify(d.reasons)}`,
	)
}

console.log('\n  Detector\n')
{
	expectDetect('Tyra Jackson PSC 80 BOX / APO AP 96367', TYRA, [addressReview.REASON_MILITARY])
	expectDetect(
		'the same address as formatted_address only',
		{ formatted_address: TYRA.formatted_address },
		[addressReview.REASON_MILITARY],
	)
	expectDetect('FPO AE + ZIP 09012', { city: 'FPO', state: 'AE', zip: '09012', country_iso: 'US' }, [addressReview.REASON_MILITARY])
	expectDetect('DPO AA + ZIP 34002', { city: 'DPO', state: 'AA', zip: '34002', country_iso: 'USA' }, [addressReview.REASON_MILITARY])
	expectDetect('AP ZIP 96205 without city', { zip: '96205', country_iso: 'US' }, [addressReview.REASON_MILITARY])
	expectDetect('CMR 409 BOX 12', { first_line: 'CMR 409 BOX 12', country_iso: 'US' }, [addressReview.REASON_MILITARY])
	expectDetect('UNIT 2050 BOX 4190 + military ZIP', { first_line: 'UNIT 2050 BOX 4190', zip: '96278', country_iso: 'US' }, [addressReview.REASON_MILITARY])
	expectDetect('BFPO 123', { first_line: 'BFPO 123', formatted_address: 'BFPO 123\nUnited Kingdom' }, [addressReview.REASON_MILITARY])
	expectDetect('Fleet Post Office', { first_line: 'Fleet Post Office', city: 'FPO', state: 'AP' }, [addressReview.REASON_MILITARY])
	expectDetect('Australia ISO AU', SYDNEY, [addressReview.REASON_AUSTRALIA])
	expectDetect('Australia as AUS', { ...SYDNEY, country_iso: 'AUS' }, [addressReview.REASON_AUSTRALIA])
	expectDetect(
		'Australia from formatted last line',
		{ first_line: '1 Collins St', formatted_address: '1 Collins St\nMelbourne VIC 3000\nAustralia' },
		[addressReview.REASON_AUSTRALIA],
	)
	expectDetect('Portland civilian US', PORTLAND, [])
	expectDetect('empty payload', {}, [])
	expectDetect('civilian UNIT without military ZIP', { first_line: 'UNIT 5 BOX 10', city: 'Austin', state: 'TX', zip: '78701', country_iso: 'US' }, [])
}

console.log('\n  Fingerprint stability\n')
{
	const a = addressReview.fingerprint(TYRA)
	const b = addressReview.fingerprint({
		...TYRA,
		city: 'APO AP',
		state: 'AP 96367-0059',
		zip: '96367',
		country_iso: 'UNITED STATES',
		first_line: '  PSC   80   BOX  15628  ',
	})
	check('APO AP / ZIP+4 / UNITED STATES / extra spaces hash the same as the canonical Tyra address', a === b)
	check('a different PSC box is a different address', a !== addressReview.fingerprint({ ...TYRA, first_line: 'PSC 80 BOX 99999' }))
	check('Sydney and Portland do not share a fingerprint', addressReview.fingerprint(SYDNEY) !== addressReview.fingerprint(PORTLAND))
}

console.log('\n  Persist, queues, seal, route\n')
const db = initDb(':memory:')
try {
	db.prepare('INSERT INTO groups (group_id, label) VALUES (?, ?)').run('G1', 'Group 1')
	db.prepare('INSERT INTO shops (shop_id, group_id, shop_name) VALUES (?, ?, ?)').run('S1', 'G1', 'TestShop')

	const ins = db.prepare(`
    INSERT INTO receipts (
      receipt_id, shop_id, group_id, name, status, is_paid, is_shipped,
      shipping_first_line, shipping_city, shipping_state, shipping_zip, shipping_country_iso,
      formatted_address, etsy_created_at, all_transactions, source
    ) VALUES (
      @id, 'S1', 'G1', @name, 'Paid', 1, 0,
      @first_line, @city, @state, @zip, @country_iso,
      @formatted_address, @created, @tx, 'etsy'
    )`)

	const add = (id, addr) =>
		ins.run({
			id,
			name: addr.name || 'Buyer',
			first_line: addr.first_line || null,
			city: addr.city || null,
			state: addr.state || null,
			zip: addr.zip || null,
			country_iso: addr.country_iso || null,
			formatted_address: addr.formatted_address || null,
			created: NOW - id,
			tx: TX,
		})

	add(101, TYRA)
	add(102, SYDNEY)
	add(103, PORTLAND)
	add(104, TYRA)

	check('incomplete re-sync is a no-op', addressReview.applyToReceipt(db, 101, {}).action === 'skipped_incomplete')
	check('Tyra opens as military', addressReview.applyToReceipt(db, 101, TYRA).action === addressReview.EVENT_OPENED)
	check('Sydney opens as Australia', addressReview.applyToReceipt(db, 102, SYDNEY).action === addressReview.EVENT_OPENED)
	check('Portland never opens', addressReview.applyToReceipt(db, 103, PORTLAND).action === 'none')
	check('second apply on the same Tyra address is already_open', addressReview.applyToReceipt(db, 101, TYRA).action === 'already_open')

	const block = addressReview.shoppingBlock(db, 101)
	check('shoppingBlock names the military hold', !!(block && block.reasons.includes('military') && /address review/i.test(block.message)))
	check('Portland is not shopping-blocked', addressReview.shoppingBlock(db, 103) == null)
	check('openIdSet reports the two held receipts', [...addressReview.openIdSet(db, [101, 102, 103, 999])].sort().join(',') === '101,102')
	check('openReviewCount is 2', addressReview.openReviewCount(db) === 2)

	const buyIds = db
		.prepare(`SELECT r.receipt_id FROM receipts r WHERE ${buyQueue.needsPurchaseScopeSql({}, 'r')} ORDER BY r.receipt_id`)
		.all()
		.map((r) => r.receipt_id)
	check('Need-to-purchase excludes held military and Australia', buyIds.includes(103) && !buyIds.includes(101) && !buyIds.includes(102))

	const reviewIds = db
		.prepare(
			`SELECT r.receipt_id FROM receipts r
       WHERE ${addressReview.queueSql('r')}
         AND ${buyQueue.needsPurchaseScopeSql({}, 'r', { excludeAddressReview: false })}
       ORDER BY r.receipt_id`,
		)
		.all()
		.map((r) => r.receipt_id)
	check('Address-review queue is the complement (101, 102)', reviewIds.join(',') === '101,102')

	const packIds = db
		.prepare(
			`SELECT r.receipt_id FROM receipts r
       WHERE ${packQueue.readyToPackShipStateSql({}, 'r')}
         AND ${packQueue.excludeOpenExchangeSql('r')}
         AND ${packQueue.excludeOpenAddressReviewSql('r')}
         AND r.packaged_at IS NULL
       ORDER BY r.receipt_id`,
		)
		.all()
		.map((r) => r.receipt_id)
	check('Ready-to-pack excludes held receipts', packIds.includes(103) && !packIds.includes(101) && !packIds.includes(102))

	upsertRouteAssignment(db, { receipt_id: 101, item_key: routeDashboard.lineItemKey('Kawaii Frog MAGSAFE Case', 555), title: 'Kawaii Frog MAGSAFE Case', status_case: 'Purchased' })
	check(
		'seal-guard blocks a fully purchased military order',
		/address review/i.test(unsealableReasons(db, [101]).get(101) || ''),
	)
	check('seal-guard does not mention Portland', !unsealableReasons(db, [103]).has(103) || !/address review/i.test(unsealableReasons(db, [103]).get(103) || ''))

	const routeRows = routeDashboard.buildRouteRows(db, {}, {})
	const routeReceipts = new Set(routeRows.map((r) => Number(r.receipt_id)))
	check('Route dashboard omits held receipts', !routeReceipts.has(101) && !routeReceipts.has(102) && routeReceipts.has(103))
	const tagged = routeDashboard.buildRouteRows(db, {}, { receipt_id: 101 })
	check('single-receipt lookup still returns the held order, tagged', tagged.length > 0 && tagged[0].address_review && tagged[0].address_review.required === true)

	const cleared = addressReview.clearReview(db, 101, { actor: 'hope', note: '4PX will accept APO AP' })
	check('owner clear stamps cleared_by', cleared.ok && cleared.address_review.required === false && cleared.address_review.cleared_by === 'hope')
	check('re-sync of the same Tyra address stays cleared', addressReview.applyToReceipt(db, 101, TYRA).action === 'still_cleared')
	check('Tyra is no longer on the Address-review queue after the owner reviews', addressReview.shoppingBlock(db, 101) == null)
	check('Need-to-purchase scope admits Tyra after the address-review hold clears', db.prepare(`SELECT r.receipt_id FROM receipts r WHERE ${buyQueue.needsPurchaseScopeSql({}, 'r')} AND r.receipt_id = 101`).get() != null)

	const moved = addressReview.applyToReceipt(db, 101, { ...TYRA, first_line: 'PSC 80 BOX 99999' })
	check('a later address change re-opens the hold', moved.action === addressReview.EVENT_REOPENED)
	check('shopping is blocked again after the address change', !!addressReview.shoppingBlock(db, 101))

	addressReview.clearReview(db, 101, { actor: 'hope' })
	const released = addressReview.applyToReceipt(db, 101, PORTLAND)
	check('switching a held-then-cleared order to a civilian US address stays clear', released.action === 'none' || released.action === addressReview.EVENT_AUTO_RELEASED)

	addressReview.applyToReceipt(db, 104, TYRA)
	const auto = addressReview.applyToReceipt(db, 104, PORTLAND)
	check('an open hold auto-releases when the address is no longer military/AU', auto.action === addressReview.EVENT_AUTO_RELEASED)
	check('auto-released receipt is not shopping-blocked', addressReview.shoppingBlock(db, 104) == null)

	let notOpen = null
	try {
		addressReview.clearReview(db, 103, { actor: 'hope' })
	} catch (err) {
		notOpen = err.code
	}
	check('clearing a civilian order is NOT_OPEN', notOpen === 'NOT_OPEN')

	addressReview.applyToReceipt(db, 102, SYDNEY)
	addressReview.clearReview(db, 102, { actor: 'hope' })
	const reopened = addressReview.reopenReview(db, 102, SYDNEY, { actor: 'hope', note: 'need to recheck AU lane' })
	check('owner can reopen an approved Australia address', reopened.ok && reopened.address_review.required === true)

	add(105, TYRA)
	db.prepare("UPDATE receipts SET status = 'Canceled' WHERE receipt_id = 105").run()
	add(106, SYDNEY)
	db.prepare('UPDATE receipts SET packaged_at = ? WHERE receipt_id = 106').run(NOW)
	add(107, TYRA)
	const backfill = addressReview.backfillOpenOrders(db)
	check('backfill opens the still-actionable Tyra order', backfill.opened >= 1)
	check('backfill skips cancelled military mail', addressReview.shoppingBlock(db, 105) == null)
	check('backfill skips already-packaged Australia', addressReview.shoppingBlock(db, 106) == null)
	check('backfill stamped receipt 107', !!addressReview.shoppingBlock(db, 107))

	const manual = insertManualOrder(db, {
		shop_id: 'S1',
		name: 'Manual APO',
		shipping_first_line: TYRA.first_line,
		shipping_city: TYRA.city,
		shipping_state: TYRA.state,
		shipping_zip: TYRA.zip,
		shipping_country_iso: TYRA.country_iso,
		items: [{ title: 'Manual case', quantity: 1 }],
	})
	check('manual APO order is held on insert', !!addressReview.shoppingBlock(db, manual.receipt_id))

	const frogKey = routeDashboard.lineItemKey('Kawaii Frog MAGSAFE Case', 555)
	const inReviewQueue = (id) =>
		db
			.prepare(
				`SELECT 1 FROM receipts r WHERE r.receipt_id = ? AND ${addressReview.queueSql('r')} AND ${buyQueue.needsPurchaseScopeSql({}, 'r', { excludeAddressReview: false })}`,
			)
			.get(id) != null
	const inReviewedList = (id) => db.prepare(`SELECT 1 FROM receipts r WHERE r.receipt_id = ? AND ${addressReview.reviewedSql('r')}`).get(id) != null

	add(108, TYRA)
	addressReview.applyToReceipt(db, 108, TYRA)
	addressReview.clearReview(db, 108, { actor: 'hope' })
	check('Mark reviewed leaves no shipping_address issue', getIssuesForReceipt(db, 108).length === 0)
	check('Mark reviewed unblocks shopping', addressReview.shoppingBlock(db, 108) == null)
	const classified = buyQueue.classifyPurchaseState(db, [{ receipt_id: 108, all_transactions: TX }])
	check('Mark reviewed order is in To buy', buyQueue.resolveNeedsPurchaseSet(classified, 'tobuy').has(108))
	check('Mark reviewed order is on the Reviewed chip', inReviewedList(108) && !inReviewQueue(108))
	check('filterSql pending is the live hold', addressReview.filterSql('r', 'pending') === addressReview.queueSql('r'))
	check('filterSql reviewed is the reviewed list', addressReview.filterSql('r', 'reviewed') === addressReview.reviewedSql('r'))
	check('normalizeFilter defaults to pending', addressReview.normalizeFilter('nope') === 'pending')

	add(109, TYRA)
	addressReview.applyToReceipt(db, 109, TYRA)
	check('an unreviewed military order is on the Address-review queue', inReviewQueue(109))
	upsertOrderIssue(db, { receipt_id: 109, item_key: frogKey, title: 'Kawaii Frog MAGSAFE Case', issue_type: 'out_of_production' })
	check('Address-review queue omits an order already on Issues', !inReviewQueue(109))
	check('Issues orders are not on the Reviewed chip either', !inReviewedList(109))
	const droppedHolds = addressReview.releaseReviewsAlreadyOnHold(db)
	check('releaseReviewsAlreadyOnHold clears leftover address holds on Issues orders', droppedHolds.released >= 1 && addressReview.shoppingBlock(db, 109) == null)
	check(
		'sync treats on-hold as already reviewed',
		addressReview.applyToReceipt(db, 109, TYRA).action === 'already_on_hold' && addressReview.shoppingBlock(db, 109) == null,
	)
	const skipped = openShippingAddressHold(db, 109, [{ item_key: frogKey, title: 'Kawaii Frog MAGSAFE Case' }])
	check('does not overwrite an already-open out-of-production issue', skipped.opened === 0 && skipped.skipped_open === 1)
	check(
		'existing OOP issue stays OOP',
		getIssuesForReceipt(db, 109).some((i) => i.item_key === frogKey && i.issue_type === 'out_of_production' && i.status === 'open'),
	)

	add(110, TYRA)
	addressReview.applyToReceipt(db, 110, TYRA)
	addressReview.clearReview(db, 110, { actor: 'hope' })
	const cannotShip = openShippingAddressHold(db, 110, [{ item_key: frogKey, title: 'Kawaii Frog MAGSAFE Case', listing_id: 555 }], { labels: ['Military address'] })
	check("Can't ship opens a shipping_address issue", cannotShip.opened === 1)
	check(
		"Can't ship lands on Issues / on hold",
		getIssuesForReceipt(db, 110).some((i) => i.item_key === frogKey && i.issue_type === ISSUE_TYPE_SHIPPING_ADDRESS && i.status === 'open'),
	)
	check("Can't ship leaves the Address-review queue", !inReviewQueue(110) && addressReview.shoppingBlock(db, 110) == null)
	check("Can't ship is not on the Reviewed chip", !inReviewedList(110))
	const heldClassified = buyQueue.classifyPurchaseState(db, [{ receipt_id: 110, all_transactions: TX }])
	check("Can't ship order is onHold", heldClassified.onHold.has(110))
	const closed = closeShippingAddressHolds(db, 110)
	check('undoing a hold resolves shipping_address issues', closed.closed === 1)

	add(111, TYRA)
	addressReview.applyToReceipt(db, 111, TYRA)
	addressReview.clearReview(db, 111, { actor: 'hope' })
	const emptyHold = openShippingAddressHold(db, 111, [], { labels: ['Australia'] })
	check('receipt with no line items still gets an address hold row', emptyHold.opened === 1)
	check(
		'fallback item_key is __address__',
		getIssuesForReceipt(db, 111).some((i) => i.item_key === '__address__' && i.status === 'open'),
	)

	check('openSql rejects a hostile alias', (() => {
		try {
			addressReview.openSql('r;DROP')
			return false
		} catch (err) {
			return err instanceof TypeError
		}
	})())
	check('selectSql allows an empty alias for unprefixed columns', addressReview.selectSql('') === 'address_review_required_at, address_review_cleared_at, address_review_cleared_by, address_review_reason, address_review_note, address_review_fingerprint')
} finally {
	db.close()
}

console.log('\n  Policy and wiring\n')
{
	check('packer cannot approve an address', policy.roleCan('packer', 'orders:address-review') === false)
	check('shopper cannot approve an address', policy.roleCan('shopper', 'orders:address-review') === false)
	check('owner can approve an address', policy.roleCan('owner', 'orders:address-review') === true)
	check(
		'clear-address-review is owner-only',
		policy.authorizeApi('packer', 'POST', '/api/orders/1/clear-address-review').allowed === false &&
			policy.authorizeApi('owner', 'POST', '/api/orders/1/clear-address-review').allowed === true,
	)

	check(
		'hold-address-review is owner-only',
		policy.authorizeApi('packer', 'POST', '/api/orders/1/hold-address-review').allowed === false &&
			policy.authorizeApi('owner', 'POST', '/api/orders/1/hold-address-review').allowed === true,
	)

	const serverSrc = fs.readFileSync(path.join(ROOT, 'src/server/index.js'), 'utf8')
	check('Needs-shipping excludes open address holds', serverSrc.includes("req.query.shipped === 'false'") && /shipped === 'false'[\s\S]{0,400}addressReview\.excludeOpenSql/.test(serverSrc))
	check('bulk needs-purchase skips held receipt ids', serverSrc.includes('skipped_address_review') && serverSrc.includes('addressReview.openIdSet'))
	check('4PX create throws ADDRESS_REVIEW_REQUIRED', serverSrc.includes('throwIfAddressReviewBlocks(receipt_id)'))
	check('Shopping Mode assign is blocked', /rejectIfAddressReviewBlocks\(res, receiptId\)/.test(serverSrc) && serverSrc.includes("app.post('/api/shop/assign'"))
	check('Route assign blocks purchase-status changes', serverSrc.includes('hasStatusChange && rejectIfAddressReviewBlocks'))
	check('ship-by deadlines omit held receipts', /collectShippingDeadlines[\s\S]{0,900}addressReview\.excludeOpenSql/.test(serverSrc))

	const setupSrc = fs.readFileSync(path.join(ROOT, 'src/db/setup.js'), 'utf8')
	check('schema columns come from the module SSoT', setupSrc.includes('...addressReview.RECEIPT_COLUMNS'))
	const clearStart = serverSrc.indexOf("app.post('/api/orders/:receipt_id/clear-address-review'")
	const holdStart = serverSrc.indexOf("app.post('/api/orders/:receipt_id/hold-address-review'")
	check('hold-address-review endpoint exists', holdStart > 0)
	check('Mark reviewed does not open Issues', clearStart >= 0 && holdStart > clearStart && !serverSrc.slice(clearStart, holdStart).includes('openShippingAddressHold'))
	check("Can't ship opens a shipping_address Issues hold", holdStart > 0 && serverSrc.slice(holdStart, holdStart + 1200).includes('openShippingAddressHold'))
	check('Address-review filter uses the chip SQL', serverSrc.includes('addressReview.filterSql'))
	check('GET /api/orders returns ar_counts for the chips', serverSrc.includes('ar_counts') && serverSrc.includes('listFilterCounts'))
	check('Reviewed chip filters by reviewed-at', serverSrc.includes('address_review_cleared_at >= @ar_cleared_from'))
	check('To review ignores placement date', serverSrc.includes("ignoreDates = req.query.shipped === 'address_review'"))
	check('GET /api/orders releases leftover holds on Issues orders', serverSrc.includes('releaseReviewsAlreadyOnHold'))
	check(
		'Address-review API drops on-hold rows after enrich',
		serverSrc.includes("req.query.shipped === 'address_review'") &&
			/if \(req\.query\.shipped === 'address_review'\) \{[\s\S]{0,500}on_hold_items/.test(serverSrc),
	)
	check('reopen-address-review closes shipping_address holds', serverSrc.includes('closeShippingAddressHolds'))
	check('upsertReceipt re-evaluates the hold after address columns land', setupSrc.includes('addressReview.applyToReceipt'))
	check('address-review events keep Issues complementary', setupSrc.includes('followAddressReviewAction'))
}

console.log('')
if (failed) {
	console.error(`${failed} assertion(s) FAILED (${passed} passed)`)
	process.exit(1)
}
console.log(`All ${passed} assertions passed.`)
