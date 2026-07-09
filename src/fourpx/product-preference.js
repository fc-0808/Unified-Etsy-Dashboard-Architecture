'use strict';

/**
 * 4PX default logistics-product selection — single source of truth.
 *
 * BUSINESS RULE
 * ─────────────
 * When shipping an order with 4PX we default to POSTLINK-LW (product code
 * "S5058", a.k.a. "postlink-s5058") whenever that product is available for the
 * destination country. If POSTLINK-S5058 is NOT offered for the destination we
 * fall back to QC (a worldwide quality-controlled line), unless a per-country
 * override says otherwise.
 *
 * WHY A SHARED MODULE
 * ───────────────────
 * The same preference must be applied in three places, so it lives here once:
 *   1. The server exposes the preferred code + country map via GET /api/4px/config
 *      so the browser drawer pre-selects the right product per order.
 *   2. The curated FOURPX_PRODUCT_CATALOG (server fallback for direct-customer API
 *      keys that can't call ds.xms.logistics_product.getlist) sources S5058's
 *      country coverage from FOURPX_POSTLINK_S5058_COUNTRIES here.
 *   3. create4pxShipmentForReceipt() uses resolveLogisticsProduct() as a
 *      server-side safety net so an order still gets the correct default even if a
 *      caller (API client, retry job) omits logistics_product_code.
 *
 * DOCS VERIFICATION (POSTLINK / 联邮通 coverage)
 * ─────────────────────────────────────────────
 * Verified against 4PX's official product documentation (open.4px.com/v2/doc and
 * express.4px.com/html_new/products2.htm). 4PX PostLink ("联邮通") ordinary +
 * registered mail is documented to serve "32 European countries + the United
 * States + Australia", and PostLink-LW ("Light Weight", the ≤500 g letter tier =
 * S5058) publishes size limits specifically for UK/Europe, Australia and the US.
 * Third-party carrier references (ParcelPanel, parcelsapp) additionally list
 * Canada, Brazil, New Zealand and Singapore/Vietnam/Thailand as PostLink
 * destinations. FOURPX_POSTLINK_S5058_COUNTRIES below encodes that verified
 * coverage; every other destination falls back to QC.
 *
 * The AUTHORITATIVE availability check is still the live 4PX product list when we
 * have it: resolveLogisticsProduct() prefers S5058 when the destination's actual
 * product catalogue contains it, and only uses the static country set as a
 * fallback for accounts/paths where no live catalogue is available.
 *
 * @module src/fourpx/product-preference
 */

/** POSTLINK-LW logistics product code (a.k.a. "postlink-s5058"). */
const FOURPX_POSTLINK_S5058_CODE = 'S5058';

/** Final fallback product when POSTLINK-S5058 is not available for a destination. */
const FOURPX_DEFAULT_FALLBACK_PRODUCT = 'QC';

// ── Region groupings (ISO-3166 alpha-2) ─────────────────────────────────────────
// The 27 EU member states form the customs union 4PX PostLink serves across
// Europe. Belgium (BE) is intentionally handled by the per-country override below
// rather than the general S5058 default, so it is excluded here.
const _EU_EXCL_BE = [
	'DE', 'FR', 'NL', 'IT', 'ES', 'PL', 'SE', 'AT', 'PT', 'CZ',
	'HU', 'RO', 'SK', 'FI', 'DK', 'IE', 'HR', 'SI', 'LT', 'LV',
	'EE', 'BG', 'GR', 'LU', 'MT', 'CY',
];
// United Kingdom + EFTA / non-EU Western Europe also covered by PostLink.
const _EUROPE_NON_EU = ['GB', 'NO', 'CH', 'IS', 'LI'];
// Non-European destinations documented for PostLink.
const _AMERICAS = ['US', 'CA', 'BR'];
const _OCEANIA = ['AU', 'NZ'];
const _ASIA = ['SG', 'VN', 'TH'];

/**
 * Destination countries (ISO-3166 alpha-2) where POSTLINK-LW (S5058) is available,
 * per 4PX's documented PostLink coverage. Used both as the curated catalogue's
 * S5058 country scope and as the fallback availability check when no live product
 * list is on hand.
 *
 * @type {ReadonlySet<string>}
 */
const FOURPX_POSTLINK_S5058_COUNTRIES = new Set([
	..._EU_EXCL_BE,
	..._EUROPE_NON_EU,
	..._AMERICAS,
	..._OCEANIA,
	..._ASIA,
]);

/**
 * Per-country product overrides. These win over the general S5058 default and
 * encode destination-specific business rules learned from live shipping.
 *
 * Belgium (BE): the account's S5058 lane to Belgium is unreliable, so BE always
 * defaults to QC even though PostLink documents general Belgian coverage.
 *
 * @type {Readonly<Record<string, string>>}
 */
const FOURPX_COUNTRY_DEFAULT_PRODUCT = Object.freeze({ BE: 'QC' });

/**
 * Normalise a country value to an upper-case ISO-3166 alpha-2 code.
 * @param {string} country
 * @returns {string}
 */
function _normCountry(country) {
	return (country || '').toString().trim().toUpperCase();
}

/**
 * Read a logistics product code off the many shapes 4PX / the dashboard use.
 * @param {object} p
 * @returns {string}
 */
function _codeOf(p) {
	if (!p) return '';
	return (p.logistics_product_code ?? p.code ?? '').toString();
}

/**
 * Decide whether POSTLINK-LW (S5058) is available for a destination.
 *
 * When an explicit product catalogue is supplied (e.g. the live response from
 * ds.xms.logistics_product.getlist, or the curated fallback for a country), that
 * catalogue is authoritative: S5058 is "available" iff it is listed there — matched
 * by code (S5058 / POSTLINK-S5058) or by a POSTLINK-LW display name. When no
 * catalogue is supplied, fall back to the docs-verified country set.
 *
 * @param {string} country                       ISO-3166 alpha-2 destination.
 * @param {Array<object>|null} [availableProducts=null]  Destination product list, if known.
 * @returns {boolean}
 */
function isPostlinkS5058Available(country, availableProducts = null) {
	if (Array.isArray(availableProducts)) {
		return availableProducts.some((p) => {
			const code = _codeOf(p).toUpperCase();
			if (code === FOURPX_POSTLINK_S5058_CODE || code === 'POSTLINK-S5058') return true;
			const name = (p.logistics_product_name ?? p.name ?? '').toString();
			return /POSTLINK[-\s]?LW/i.test(name) || /postlink[-\s]?s5058/i.test(name);
		});
	}
	return FOURPX_POSTLINK_S5058_COUNTRIES.has(_normCountry(country));
}

/**
 * Resolve the default 4PX logistics product code for a destination.
 *
 * Selection order (identical to the browser drawer's _fpxPickLogisticsProduct):
 *   1. POSTLINK-LW (S5058) when it is available for the destination.
 *   2. A per-country override (FOURPX_COUNTRY_DEFAULT_PRODUCT), e.g. BE → QC.
 *   3. The caller's configured default (config.fourpx_default_product).
 *   4. QC — the worldwide fallback.
 *
 * When a live product catalogue is supplied, the resolved code is only returned
 * if it actually exists in that catalogue; otherwise the next candidate is tried,
 * so we never pre-select a product the destination can't use.
 *
 * @param {object} input
 * @param {string} input.country                        ISO-3166 alpha-2 destination.
 * @param {Array<object>|null} [input.availableProducts=null]  Destination product list, if known.
 * @param {string|null} [input.configDefault=null]      config.fourpx_default_product.
 * @returns {string|null}  The chosen logistics product code, or null when a
 *                         catalogue was supplied and no candidate is valid for it.
 */
function resolveLogisticsProduct({ country, availableProducts = null, configDefault = null } = {}) {
	const cc = _normCountry(country);
	const catalogue = Array.isArray(availableProducts) ? availableProducts : null;
	const inCatalogue = (code) => !catalogue || (code && catalogue.some((p) => _codeOf(p).toUpperCase() === code.toUpperCase()));

	// 1. Prefer POSTLINK-LW (S5058) when the destination offers it.
	if (isPostlinkS5058Available(cc, catalogue) && inCatalogue(FOURPX_POSTLINK_S5058_CODE)) {
		return FOURPX_POSTLINK_S5058_CODE;
	}

	// 2–4. Per-country override → configured default → QC. Skip any candidate that
	//       isn't valid for a supplied catalogue.
	const candidates = [
		FOURPX_COUNTRY_DEFAULT_PRODUCT[cc],
		configDefault,
		FOURPX_DEFAULT_FALLBACK_PRODUCT,
	];
	for (const code of candidates) {
		if (code && inCatalogue(code)) return code;
	}

	// A catalogue was supplied but none of our candidates are in it. Fall back to
	// the sole product if there is exactly one, else signal "no default".
	if (catalogue && catalogue.length === 1) return _codeOf(catalogue[0]) || null;
	return catalogue ? null : FOURPX_DEFAULT_FALLBACK_PRODUCT;
}

module.exports = {
	FOURPX_POSTLINK_S5058_CODE,
	FOURPX_DEFAULT_FALLBACK_PRODUCT,
	FOURPX_POSTLINK_S5058_COUNTRIES,
	FOURPX_COUNTRY_DEFAULT_PRODUCT,
	isPostlinkS5058Available,
	resolveLogisticsProduct,
};
