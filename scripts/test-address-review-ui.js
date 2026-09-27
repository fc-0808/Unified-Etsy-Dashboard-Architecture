'use strict'

/**
 * Regression test — Address-review queue, banner, and Mark-reviewed action must
 * exist in the Orders UI, without decorative emoji or repeating teal column
 * bars. Mark reviewed releases the order to shop; Can't ship moves it to
 * Issues / on hold. Orders already on Issues are not in this queue.
 *
 * Run: node scripts/test-address-review-ui.js
 */

const fs = require('fs')
const path = require('path')

const PAGE = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8')

let failures = 0
function assert(cond, msg) {
	if (cond) console.log(`  ok  — ${msg}`)
	else {
		failures++
		console.error(`  FAIL — ${msg}`)
	}
}

console.log('Address-review UI regression test\n')

assert(/<option value="address_review">Address review<\/option>/.test(PAGE), 'Orders filter has an Address review option')
assert(/id="addressReviewBanner"/.test(PAGE), 'the address-review banner is present')
assert(/data-cap="orders:address-review"/.test(PAGE), 'the banner is gated on the owner-only capability')
assert(/onclick="showAddressReviewQueue\(\)"/.test(PAGE), 'the banner opens the Address review queue')
assert(/>Review addresses →</.test(PAGE), 'the banner action is labelled without emoji')
assert(/function updateAddressReviewBanner\(/.test(PAGE), 'banner count is driven from the API payload')
assert(/function showAddressReviewQueue\(/.test(PAGE), 'queue switcher sets shipped=address_review')
assert(/shippedEl\.value = 'address_review'/.test(PAGE), '…and writes that value onto the Status control')
assert(/function clearAddressReview\(/.test(PAGE), 'Mark reviewed posts to clear-address-review')
assert(/\/clear-address-review'/.test(PAGE), '…against the owner-only endpoint')
assert(/ROLE\.can\('orders:address-review'\)/.test(PAGE), 'the review button is hidden for packers in dynamically rendered rows')
assert(/class="address-review-badge"/.test(PAGE), 'held rows render a military / Australia badge')
assert(!/class="address-review-callout"/.test(PAGE), 'held rows do not render a coloured callout box')
assert(!/addressReviewOpen \? ' is-address-review'/.test(PAGE), 'held rows do not add a per-cell accent class')
assert(!/inset 3px 0 0 #14b8a6/.test(PAGE) && !/tr\.order-row\.is-address-review/.test(PAGE), 'no repeating teal inset bars on every column')
assert(/function holdAddressReview\(/.test(PAGE), "Can't ship posts to hold-address-review")
assert(/\/hold-address-review'/.test(PAGE), '…against the owner-only hold endpoint')
assert(/>Can't ship</.test(PAGE), "the not-okay action is labelled Can't ship")
assert(/address_review\.required\) && !\(Number\(o\.on_hold_items\) > 0\)/.test(PAGE), 'orders already on Issues do not show Address-review actions')
assert(/if \(shipped === 'address_review'\)/.test(PAGE) && /on_hold_items/.test(PAGE) && /t\.issue\.on_hold/.test(PAGE), 'Address review view drops rows that are already on Issues')
assert(/ready to shop/.test(PAGE), 'Mark reviewed copy says the order is ready to shop')
assert(/addressReviewOpen \? '' : isManual/.test(PAGE), 'Complete order is hidden while the hold is open')
assert(/!_employeeView && !addressReviewOpen/.test(PAGE), 'Flag issue is hidden while the hold is open')
assert(/showPurchaseChips = !addressReviewOpen &&/.test(PAGE), 'Case/Grip/Charm chips are hidden while the hold is open')
assert(/rowIsPreTransit && !addressReviewOpen/.test(PAGE), 'Mark needs purchase is hidden while the hold is open')
assert(/!addressReviewOpen && \(!!o\.needs_purchase_at/.test(PAGE), 'Mark purchased is hidden while the hold is open')
assert(/showPurchaseControls && !addressReviewOpen/.test(PAGE), 'Mark packaged is hidden while the hold is open')
assert(/addressReviewOpen \? '' : `<button class="btn-4px"/.test(PAGE), 'Ship with 4PX is hidden while the hold is open')
assert(/\(!o\.is_shipped \|\| rowIsPreTransit\) && !addressReviewOpen/.test(PAGE), 'bulk-select checkboxes skip held orders')
assert(/id="arSubFilter"/.test(PAGE), 'Address review has To review / Reviewed chips')
assert(/function setArFilter\(/.test(PAGE), 'the chips switch ar_filter')
assert(/>To review</.test(PAGE), 'To review chip is labelled without emoji')
assert(/>Reviewed</.test(PAGE), 'Reviewed chip is labelled without emoji')
assert(/params\.set\('ar_filter', 'reviewed'\)/.test(PAGE), 'Reviewed sends ar_filter=reviewed')
assert(/data\.ar_counts/.test(PAGE) && /function updateArSubCounts\(/.test(PAGE), 'chip counts come from ar_counts')
assert(/is-reviewed/.test(PAGE), 'already-reviewed rows show a Reviewed badge')
assert(/data\.address_review_count/.test(PAGE), 'the banner reads address_review_count from GET /api/orders')
assert(/on-queue/.test(PAGE), 'the banner hides Review addresses when already on that queue')
assert(/shipping_address:/.test(PAGE) && /label: 'Shipping address'/.test(PAGE), 'Issues workflow understands shipping_address')
assert(/filter\(\(\[k\]\) => k !== 'shipping_address'\)/.test(PAGE), 'Flag-issue picker does not offer shipping_address')
assert(/'Address review': '地址审核'/.test(PAGE), 'Address review is in the Chinese dictionary')
assert(/'To review': '待审核'/.test(PAGE), 'To review is in the Chinese dictionary')
assert(/Reviewed: '已审核'/.test(PAGE), 'Reviewed is in the Chinese dictionary')
assert(/'Mark reviewed': '已审核，可采购'/.test(PAGE), 'Mark reviewed is in the Chinese dictionary')
assert(/"Can't ship": '无法发货'/.test(PAGE), "Can't ship is in the Chinese dictionary")
assert(/'Military address': '军方地址'/.test(PAGE), 'Military address is in the Chinese dictionary')
assert(/'Review addresses →': '去审核地址 →'/.test(PAGE), 'the banner action is in the Chinese dictionary')
assert(!/📦[^"]*Address review/.test(PAGE) && !/🛒[^"]*Address review/.test(PAGE), 'the Address review label is not prefixed with a decorative emoji')

console.log('')
if (failures > 0) {
	console.error(`${failures} assertion(s) FAILED`)
	process.exit(1)
}
console.log('All assertions passed.')
