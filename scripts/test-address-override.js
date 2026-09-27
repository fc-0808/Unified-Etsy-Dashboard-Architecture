'use strict'

/**
 * Ship-to correction — a buyer messages a new address, the Orders column shows
 * it, and Ship with 4PX prefills from it. Etsy checkout columns stay put, and
 * a later sync must not put the old address back on the review hold.
 *
 * Run: node scripts/test-address-override.js
 */

const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const addressOverride = require('../src/orders/address-override')
const addressReview = require('../src/orders/address-review')
const { initDb, upsertReceipt } = require('../src/db/setup')

const ROOT = path.resolve(__dirname, '..')
const HTML = path.join(ROOT, 'public', 'index.html')
const TYRA = Object.freeze({
	name: 'Tyra Jackson',
	first_line: 'PSC 80 BOX 15628',
	second_line: '',
	city: 'APO',
	state: 'AP',
	zip: '96367-0059',
	country_iso: 'US',
})
const PORTLAND = Object.freeze({
	name: 'Jamie Lee',
	first_line: '123 SW Main St',
	second_line: 'Apt 4',
	city: 'Portland',
	state: 'OR',
	zip: '97204',
	country_iso: 'US',
	note: 'Buyer messaged this address on Etsy',
})
const SYDNEY = Object.freeze({
	name: 'Alex Chen',
	first_line: '12 Example Street',
	second_line: '',
	city: 'Sydney',
	state: 'NSW',
	zip: '2000',
	country_iso: 'AU',
})

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

function throwsCode(fn) {
	try {
		fn()
		return ''
	} catch (err) {
		return err.code || ''
	}
}

console.log('\n  Validation\n')
{
	const ok = addressOverride.validateAddress({ ...PORTLAND, country_iso: 'usa', state: 'or', zip: '97204' })
	check('USA / or normalises to US / OR', ok.country_iso === 'US' && ok.state === 'OR' && ok.name === 'Jamie Lee')
	check('UK alias and postcode spacing', addressOverride.validateAddress({ name: 'Ann Smith', first_line: '10 Downing Street', city: 'London', zip: 'sw1a1aa', country_iso: 'UK' }).country_iso === 'GB')
	check(
		'UK postcode gains the space carriers expect',
		addressOverride.validateAddress({ name: 'Ann Smith', first_line: '10 Downing Street', city: 'London', zip: 'sw1a1aa', country_iso: 'UK' }).zip === 'SW1A 1AA',
	)
	check(
		'Canadian postal code gains its space',
		addressOverride.validateAddress({ name: 'Ann Smith', first_line: '1 King St', city: 'Toronto', state: 'on', zip: 'm5v2t6', country_iso: 'CA' }).zip === 'M5V 2T6',
	)
	const bad = (() => {
		try {
			addressOverride.validateAddress({ name: 'A', first_line: 'x', city: '', state: 'XX', zip: '12', country_iso: 'ZZ' })
			return null
		} catch (err) {
			return err
		}
	})()
	check('a broken address is VALIDATION, not a partial save', bad && bad.code === 'VALIDATION' && bad.fields.name && bad.fields.first_line && bad.fields.city && bad.fields.country_iso)
	check('ISO set rejects ZZ and accepts US', addressOverride.ISO_ALPHA2.size >= 240 && addressOverride.ISO_ALPHA2.has('US') && !addressOverride.ISO_ALPHA2.has('ZZ'))
}

console.log('\n  Persist, display, sync\n')
const db = initDb(':memory:')
try {
	db.prepare('INSERT INTO groups (group_id, label) VALUES (?, ?)').run('G1', 'Group 1')
	db.prepare('INSERT INTO shops (shop_id, group_id, shop_name) VALUES (?, ?, ?)').run('S1', 'G1', 'TestShop')

	db.prepare(
		`INSERT INTO receipts (
      receipt_id, shop_id, group_id, name, status, is_paid, is_shipped,
      shipping_first_line, shipping_city, shipping_state, shipping_zip, shipping_country_iso,
      formatted_address, etsy_created_at, source
    ) VALUES (
      501, 'S1', 'G1', @name, 'Paid', 1, 0,
      @first_line, @city, @state, @zip, @country_iso,
      @formatted, 1, 'etsy'
    )`,
	).run({
		...TYRA,
		formatted: 'Tyra Jackson\nPSC 80 BOX 15628\nAPO, AP 96367-0059\nUnited States',
	})

	check('Tyra opens military review before any correction', addressReview.applyToReceipt(db, 501, TYRA).action === addressReview.EVENT_OPENED)

	const saved = addressOverride.save(db, 501, PORTLAND, { actor: 'packer', note: PORTLAND.note })
	check('saving a civilian address releases the military hold', saved.review.action === addressReview.EVENT_AUTO_RELEASED)
	check('the response is the address 4PX will print', saved.effective.shipping_first_line === '123 SW Main St' && saved.effective.shipping_city === 'Portland' && saved.effective.buyer_name === 'Jamie Lee')
	check('formatted address leads with the new name and keeps a readable country', saved.effective.formatted_address.startsWith('Jamie Lee\n123 SW Main St\nApt 4\n') && saved.effective.formatted_address.endsWith('United States'))

	const stored = db.prepare('SELECT name, shipping_first_line, shipping_city, address_override_json, address_override_by, address_override_note FROM receipts WHERE receipt_id = 501').get()
	check('Etsy checkout columns are untouched', stored.name === 'Tyra Jackson' && stored.shipping_first_line === 'PSC 80 BOX 15628' && stored.shipping_city === 'APO')
	check('the correction is stored beside them', JSON.parse(stored.address_override_json).first_line === '123 SW Main St' && stored.address_override_by === 'packer' && stored.address_override_note === PORTLAND.note)

	const row = db.prepare(`SELECT name AS buyer_name, shipping_first_line, shipping_second_line, shipping_city, shipping_state, shipping_zip, shipping_country_iso, formatted_address, ${addressOverride.selectSql('')} FROM receipts WHERE receipt_id = 501`).get()
	const snap = addressOverride.applyDisplay(row)
	check('the orders row shows the corrected ship-to', row.buyer_name === 'Jamie Lee' && row.shipping_city === 'Portland' && row.shipping_zip === '97204' && row.formatted_address.includes('123 SW Main St'))
	check('the row remembers it was corrected, and Etsy has not drifted yet', snap && snap.active && snap.etsy_drifted === false && snap.etsy.city === 'APO')

	db.prepare(`UPDATE receipts SET shipping_city = 'FPO', shipping_state = 'AE' WHERE receipt_id = 501`).run()
	const driftedRow = db.prepare(`SELECT name AS buyer_name, shipping_first_line, shipping_second_line, shipping_city, shipping_state, shipping_zip, shipping_country_iso, formatted_address, ${addressOverride.selectSql('')} FROM receipts WHERE receipt_id = 501`).get()
	const drifted = addressOverride.applyDisplay(driftedRow)
	check('an Etsy change after the correction is flagged, and the saved address still wins', drifted.etsy_drifted === true && driftedRow.shipping_city === 'Portland')

	// Put the checkout address back, then re-sync the original military receipt.
	db.prepare(`UPDATE receipts SET shipping_city = 'APO', shipping_state = 'AP' WHERE receipt_id = 501`).run()
	upsertReceipt(db, 'S1', 'G1', {
		receipt_id: 501,
		name: 'Tyra Jackson',
		first_line: 'PSC 80 BOX 15628',
		city: 'APO',
		state: 'AP',
		zip: '96367-0059',
		country_iso: 'US',
		formatted_address: 'Tyra Jackson\nPSC 80 BOX 15628\nAPO, AP 96367-0059\nUnited States',
		status: 'Paid',
		is_paid: true,
		is_shipped: false,
		transactions: [{ title: 'Case', quantity: 1, listing_id: 1 }],
		shipments: [],
	})
	const afterSync = db.prepare('SELECT shipping_city, address_override_json, address_review_cleared_at, address_review_reason FROM receipts WHERE receipt_id = 501').get()
	check('a re-sync keeps the correction', JSON.parse(afterSync.address_override_json).city === 'Portland')
	check('a re-sync of the old APO box does not reopen address review', afterSync.address_review_cleared_at != null && afterSync.shipping_city === 'APO')

	const events = addressOverride.eventsForReceipt(db, 501)
	check('the correction is audited', events.some((e) => e.event === 'saved' && e.actor === 'packer'))

	const same = addressOverride.save(db, 501, TYRA, { actor: 'packer' })
	check('saving the Etsy address back is a revert', same.reverted === true && same.active === false && same.effective.shipping_city === 'APO')
	check('reverting to APO re-opens military review', same.review.action === addressReview.EVENT_REOPENED)
	check('revert removes the stored correction', db.prepare('SELECT address_override_json FROM receipts WHERE receipt_id = 501').get().address_override_json == null)

	const again = addressOverride.save(db, 501, PORTLAND, { actor: 'owner' })
	check('the correction can be saved again', again.active === true)
	const reverted = addressOverride.revert(db, 501, { actor: 'owner' })
	check('DELETE-style revert clears it', reverted.reverted === true && reverted.active === false)

	addressOverride.save(db, 501, PORTLAND, { actor: 'owner' })
	db.prepare(`UPDATE receipts SET is_shipped = 1 WHERE receipt_id = 501`).run()
	check('a shipped order refuses another edit', throwsCode(() => addressOverride.save(db, 501, SYDNEY, { actor: 'owner' })) === 'LOCKED')
	check('a shipped order also refuses revert', throwsCode(() => addressOverride.revert(db, 501, { actor: 'owner' })) === 'LOCKED')
	db.prepare(`UPDATE receipts SET is_shipped = 0, fourpx_consignment_no = 'DS1', fourpx_order_status = 'created' WHERE receipt_id = 501`).run()
	check('an active 4PX label locks the address', throwsCode(() => addressOverride.save(db, 501, SYDNEY)) === 'LOCKED')
	db.prepare(`UPDATE receipts SET fourpx_order_status = 'cancelled' WHERE receipt_id = 501`).run()
	const afterCancel = addressOverride.save(db, 501, SYDNEY, { actor: 'owner' })
	check('cancelling the label unlocks the address', afterCancel.active === true && afterCancel.effective.shipping_country_iso === 'AU')
	check('changing the correction to Australia opens address review', afterCancel.review.action === addressReview.EVENT_OPENED || afterCancel.review.action === addressReview.EVENT_REOPENED)

	check('a missing order is NOT_FOUND', throwsCode(() => addressOverride.save(db, 999, PORTLAND)) === 'NOT_FOUND')
	check('addressForReview falls back to Etsy when nothing is saved', addressOverride.addressForReview(db, 404, PORTLAND) === PORTLAND)
} finally {
	db.close()
}

console.log('\n  Paste parser (the one in the page)\n')
{
	const html = fs.readFileSync(HTML, 'utf8')
	const start = html.indexOf('// ══ ADDRESS-UPDATE-PARSE ══')
	const end = html.indexOf('// ══ END ADDRESS-UPDATE-PARSE ══')
	check('the page carries the paste parser', start > 0 && end > start)
	const src = html.slice(start, end)
	const parsedFn = vm.runInNewContext(`${src}\nparsePastedShipAddress`)
	const pasted = parsedFn('Jane Doe\n695 S Santa Fe Ave\nApt 317\nLos Angeles, CA 90021-1300\nUnited States')
	check(
		'a buyer message splits into the 4PX fields',
		pasted.ok && pasted.name === 'Jane Doe' && pasted.first_line === '695 S Santa Fe Ave' && pasted.second_line === 'Apt 317' && pasted.city === 'Los Angeles' && pasted.state === 'CA' && pasted.zip === '90021-1300' && pasted.country_iso === 'US',
		JSON.stringify(pasted),
	)
	const noName = parsedFn('695 S Santa Fe Ave\nLos Angeles, CA 90021\nUnited States')
	check('a paste with no name leaves the name for the form to keep', noName.ok && noName.name === '' && noName.first_line === '695 S Santa Fe Ave' && noName.city === 'Los Angeles')
	check('a one-line paste is refused rather than guessed', parsedFn('123 Main St').ok === false)
	check('the ship-to cell offers Update address', html.includes('openAddressUpdate(') && html.includes('>Update address</button>'))
	check('Ship with 4PX announces the saved address', html.includes('id="fpxAddressOverrideNotice"') && html.includes('o.address_override && o.address_override.active'))
	check('the bulk wizard labels an updated address', html.includes('ship.updated') && html.includes('>Address updated</span>'))
	const server = fs.readFileSync(path.join(ROOT, 'src', 'server', 'index.js'), 'utf8')
	check('the orders list overlays the correction before the row is sent', server.includes('addressOverride.applyDisplay(r)') && server.includes('address_override: addressOverrideSnap'))
	const setup = fs.readFileSync(path.join(ROOT, 'src', 'db', 'setup.js'), 'utf8')
	check('Etsy sync judges the corrected address', setup.includes('addressOverride.addressForReview(db, receipt.receipt_id, etsyAddr)'))
}

console.log(`\n${failed ? 'FAILED' : 'ok'} — ${passed} passed, ${failed} failed\n`)
if (failed) process.exit(1)
