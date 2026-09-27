'use strict'

/**
 * Operator-facing Etsy shop roster.
 *
 * config.json is the live source of which shops the dashboard operates.
 * This module only encodes the human working order and the listing-copy
 * fallback for shops that still exist. Keep the matching list in
 * public/index.html (SHOP_DISPLAY_ORDER) identical — the page is a static
 * HTML file and cannot require() this module.
 *
 * Unknown or newly-added shops sort after this list, in their stable
 * database / server order.
 */

const SHOP_DISPLAY_ORDER = Object.freeze([
	'Y2KiPhoneCases',
	'IPhoneCasesByTwily',
	'CuteCasesMore',
])

const SHOP_DISPLAY_RANK = new Map(
	SHOP_DISPLAY_ORDER.map((name, index) => [name.toLowerCase(), index]),
)

/** Fallback shop name for listing-copy prompts when a caller omitted one. */
const DEFAULT_LISTING_SHOP_NAME = 'Y2KiPhoneCases'

function shopDisplayRank(shopName) {
	const key = String(shopName || '').toLowerCase()
	if (!key) return SHOP_DISPLAY_ORDER.length
	const rank = SHOP_DISPLAY_RANK.get(key)
	return rank === undefined ? SHOP_DISPLAY_ORDER.length : rank
}

module.exports = {
	SHOP_DISPLAY_ORDER,
	SHOP_DISPLAY_RANK,
	DEFAULT_LISTING_SHOP_NAME,
	shopDisplayRank,
}
