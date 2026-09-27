'use strict'

/**
 * Provenance shop_id for catalog listings that no longer belong to an
 * operated Etsy shop.
 *
 * There is never a `shops` row for this id. Operational surfaces (Listings,
 * Growth, shop sync) JOIN `shops` or enumerate config shops, so archived
 * listings cannot reappear as a live shop or be wiped by `pruneStaleListings`.
 * Catalog image resolution, find-by-photo and Sourcing read `listings`
 * directly and therefore still see the photos.
 */
const CATALOG_ARCHIVE_SHOP_ID = '__catalog_archive__'

/**
 * Listing-scoped product corpus. Offboarding an Etsy shop must not delete
 * these rows when the operator wants the catalog to keep working. Inventory
 * quantities, receipts and tokens are shop operations and are not in this set.
 */
const CATALOG_KEEP_TABLES = Object.freeze([
	'listings',
	'listing_images',
	'listing_image_data',
	'listing_phash',
	'listing_vemb',
	'listing_style_images',
	'listing_variation_images',
	'listing_variation_image_state',
	'product_merges',
])

const CATALOG_KEEP_TABLE_SET = new Set(CATALOG_KEEP_TABLES)

module.exports = {
	CATALOG_ARCHIVE_SHOP_ID,
	CATALOG_KEEP_TABLES,
	CATALOG_KEEP_TABLE_SET,
}
