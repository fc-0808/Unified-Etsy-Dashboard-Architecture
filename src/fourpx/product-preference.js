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
 *   2. The curated FOURPX_RECOMMENDED_PRODUCTS shortlist (server fallback for API
 *      keys that can't call ds.xms.logistics_product.getlist) sources S5058's
 *      country coverage from FOURPX_POSTLINK_S5058_COUNTRIES here.
 *   3. create4pxShipmentForReceipt() uses resolveLogisticsProduct() as a
 *      server-side safety net so an order still gets the correct default even if a
 *      caller (API client, retry job) omits logistics_product_code.
 *
 * EXPEDITED ORDERS ARE THE EXCEPTION
 * ──────────────────────────────────
 * The POSTLINK-LW default is an ECONOMY lane. When the Etsy buyer paid extra to
 * upgrade their shipping (`ShopReceiptTransaction.shipping_upgrade`, surfaced by
 * src/orders/shipping-upgrade.js), that default is exactly wrong, so those orders
 * resolve down the express chain instead — see the "Express lanes" section below.
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
 * US REMOTE / ISLAND ZIPS
 * ──────────────────────
 * POSTLINK-LW rejects Hawaii / Alaska / Guam / Puerto Rico / USVI ZIPs with
 * 4PX error 010109005 ("remote ZIP codes, no service"). resolveUsIslandZipFallback()
 * only returns S5118 (US-ISLAND-PH) when THAT rejection is paired with an address
 * that independently confirms an S5118 territory (state or ZIP). Continental US
 * S5058 failures never auto-flip. create4pxShipmentForReceipt then retries once
 * on a fresh ref so bulk "Ship with 4PX" does not leave a Failed island row.
 *
 * @module src/fourpx/product-preference
 */

/** POSTLINK-LW logistics product code (a.k.a. "postlink-s5058"). */
const FOURPX_POSTLINK_S5058_CODE = 'S5058';

/**
 * US-ISLAND-PH — the only lane 4PX accepts for US remote/island ZIPs
 * (Hawaii / Alaska / Guam / Puerto Rico / US Virgin Islands, plus PH).
 * S5058 (POSTLINK-LW) rejects those ZIPs with error 010109005 ("remote ZIP
 * codes, no service"); create4pxShipmentForReceipt auto-retries once on this
 * code when that happens. See resolveUsIslandZipFallback().
 */
const FOURPX_US_ISLAND_PH_CODE = 'S5118';

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

// ── Express lanes (orders the buyer paid to upgrade) ─────────────────────────
//
// WHY THIS SECTION EXISTS
// An Etsy buyer who selects a shipping upgrade at checkout pays a separate fee
// for SPEED. The default above is deliberately the opposite of speed: POSTLINK-LW
// is the cheap ≤500 g economy letter tier, which is the right answer for an
// ordinary order and the WRONG answer for an upgraded one — booking an express
// order onto it silently converts a paid 3–5 day promise into a ~20 day economy
// transit. So an expedited order resolves down a different candidate chain.
//
// WHICH CODES
// Only codes 4PX actually sells, and only ones the dashboard already ships in its
// curated shortlist with tier 'express' (see FOURPX_RECOMMENDED_PRODUCTS in
// src/server/index.js). A logistics product code cannot be guessed — an unknown
// code is rejected by ds.xms.order.create — so this list is deliberately short
// and is asserted against the curated shortlist by
// scripts/test-express-orders.js, which fails if the two ever drift.
//
//   S5063 — POSTLINK China–US Fast Track (联邮通中美快线). US-only expedited
//           postal line, ~5–9 days. The fastest lane the account holds for the
//           single biggest destination, so it leads for US.
//   PX    — POSTLINK Priority Registered (联邮通优先挂号). The genuine worldwide
//           priority upgrade over QC/S5058, with signature scans.
//
// Neither is a courier (DHL/FedEx) lane: switching an account onto a commercial
// courier product changes the price bracket materially, so that stays an explicit
// operator decision. What we owe the operator is the fastest lane we KNOW is
// available, pre-selected, plus a visible warning when they pick a slower one.
const FOURPX_EXPRESS_WORLDWIDE = Object.freeze(['PX']);
const FOURPX_EXPRESS_BY_COUNTRY = Object.freeze({ US: ['S5063', 'PX'] });

/**
 * 4PX `transport_mode` values that mean "this lane is faster than postal".
 * ds.xms.logistics_product.getlist returns a different product set per mode:
 * 1 = Express/Commercial, 2 = Priority air, 3 = Postal/registered, 4 = COD.
 * Only 1 and 2 are speed lanes. See src/fourpx/orders.js#getLogisticsProducts.
 * @type {ReadonlySet<string>}
 */
const FOURPX_EXPRESS_TRANSPORT_MODES = new Set(['1', '2']);

/** Product NAMES that identify an express/priority lane when no mode is present. */
const _EXPRESS_NAME_RE = /express|priority|优先|快线|特快|快递|fast[\s-]?track/i;

/**
 * Ordered express candidate codes for a destination, strongest first.
 *
 * @param {string} country  ISO-3166 alpha-2 destination.
 * @returns {string[]}
 */
function expressCandidates(country) {
	const cc = _normCountry(country);
	const specific = FOURPX_EXPRESS_BY_COUNTRY[cc] || [];
	// De-duped union: country-specific lanes first, then the worldwide priority
	// lane, so a US order tries the Fast Track before falling back to PX.
	return [...new Set([...specific, ...FOURPX_EXPRESS_WORLDWIDE])];
}

/**
 * Is this catalogue entry a lane that actually delivers faster than postal?
 *
 * Checked in order of trustworthiness: 4PX's own `transport_mode` (authoritative,
 * present on every live catalogue entry), then the curated shortlist's `tier`,
 * then the display name. The name check is last because it is the only signal
 * that can be fooled by marketing wording.
 *
 * @param {object} product  A live 4PX product or a curated shortlist entry.
 * @returns {boolean}
 */
function isExpressProduct(product) {
	if (!product) return false;
	const mode = product.transport_mode;
	if (mode != null && FOURPX_EXPRESS_TRANSPORT_MODES.has(String(mode))) return true;
	const label = (product.transport_mode_label ?? '').toString().toLowerCase();
	if (label === 'express' || label === 'priority') return true;
	if ((product.tier ?? '').toString().toLowerCase() === 'express') return true;
	// A known express code is express even in a catalogue that reports no mode.
	const code = _codeOf(product).toUpperCase();
	if (code && (FOURPX_EXPRESS_WORLDWIDE.includes(code) || Object.values(FOURPX_EXPRESS_BY_COUNTRY).some((list) => list.includes(code)))) return true;
	const name = (product.logistics_product_name ?? product.name ?? '').toString();
	return !!name && _EXPRESS_NAME_RE.test(name);
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
 * When `expedited` is set — the buyer paid Etsy extra for faster shipping — the
 * chain is REPLACED by the express candidates for the destination (see
 * expressCandidates), then ANY express lane the live catalogue happens to offer,
 * and only then falls through to the standard chain above. The fall-through
 * matters: a destination with no express lane must still produce a bookable
 * product, because refusing to pre-select one would leave the operator staring at
 * an empty picker on the most time-critical order in the queue.
 *
 * When a live product catalogue is supplied, the resolved code is only returned
 * if it actually exists in that catalogue; otherwise the next candidate is tried,
 * so we never pre-select a product the destination can't use.
 *
 * @param {object} input
 * @param {string} input.country                        ISO-3166 alpha-2 destination.
 * @param {Array<object>|null} [input.availableProducts=null]  Destination product list, if known.
 * @param {string|null} [input.configDefault=null]      config.fourpx_default_product.
 * @param {boolean} [input.expedited=false]             Buyer paid for a shipping upgrade.
 * @returns {string|null}  The chosen logistics product code, or null when a
 *                         catalogue was supplied and no candidate is valid for it.
 */
function resolveLogisticsProduct({ country, availableProducts = null, configDefault = null, expedited = false } = {}) {
	const cc = _normCountry(country);
	const catalogue = Array.isArray(availableProducts) ? availableProducts : null;
	const inCatalogue = (code) => !catalogue || (code && catalogue.some((p) => _codeOf(p).toUpperCase() === code.toUpperCase()));

	if (expedited) {
		for (const code of expressCandidates(cc)) {
			if (inCatalogue(code)) return code;
		}
		// Nothing from the curated express list is on offer here, but the live
		// catalogue may still carry an express/priority lane we don't curate. Taking
		// it beats silently dropping the parcel onto economy.
		const fromCatalogue = catalogue?.find((p) => isExpressProduct(p));
		if (fromCatalogue) return _codeOf(fromCatalogue) || null;
		// Fall through to the standard chain below.
	}

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

/**
 * @typedef {object} ExpressAdvisory
 * @property {boolean} express     Is the selected code a speed lane?
 * @property {string}  recommended The express code we would pre-select ('' if none).
 * @property {boolean} downgraded  True when an EXPEDITED order is about to be
 *                                 booked onto a lane that is not a speed lane.
 */

/**
 * Assess a chosen logistics product against a buyer-paid shipping upgrade.
 *
 * This is the "are you sure?" behind the drawer's express notice and the
 * server-side warning: an expedited order booked onto POSTLINK-LW is a silent
 * downgrade of something the buyer paid for, and the operator has to be told
 * BEFORE the label is paid for, because a created 4PX order is not free to undo.
 *
 * It only ever ADVISES. The operator keeps the final word — a lane can be
 * legitimately chosen for cost, weight or battery restrictions — so nothing here
 * blocks a shipment.
 *
 * @param {object} input
 * @param {string} input.country                        ISO-3166 alpha-2 destination.
 * @param {string} input.selectedCode                   Product code about to be booked.
 * @param {Array<object>|null} [input.availableProducts=null]  Destination product list, if known.
 * @param {boolean} [input.expedited=false]             Buyer paid for a shipping upgrade.
 * @returns {ExpressAdvisory}
 */
function assessExpressChoice({ country, selectedCode, availableProducts = null, expedited = false } = {}) {
	const want = (selectedCode || '').toString().trim().toUpperCase();
	const catalogue = Array.isArray(availableProducts) ? availableProducts : null;
	const entry = catalogue?.find((p) => _codeOf(p).toUpperCase() === want) || null;
	// With no catalogue entry to inspect, membership of the curated express list is
	// the only evidence available — hence the synthetic entry rather than `false`,
	// which would flag a correctly-chosen PX shipment as a downgrade.
	const express = want ? isExpressProduct(entry || { logistics_product_code: want }) : false;
	const recommended = expedited ? resolveLogisticsProduct({ country, availableProducts, expedited: true }) || '' : '';
	return { express, recommended, downgraded: !!expedited && !!want && !express };
}

// ── US remote / island ZIP auto-fallback (S5058 → S5118) ───────────────────────
//
// 4PX's POSTLINK-LW (S5058) covers the continental US but rejects Hawaii, Alaska,
// Guam, Puerto Rico, USVI (and a few other "remote") ZIPs with a business error
// that looks like:
//   "recipient_info.post_code,…,consignee's postcode:… remote ZIP codes, no service;"
//   error_code: 010109005
//
// The only bookable lane for those ZIPs on this account is US-ISLAND-PH (S5118).
// Operators shipping in bulk cannot open every failed row to switch the product,
// so create4pxShipmentForReceipt consults resolveUsIslandZipFallback() and, when
// eligible, retries on S5118 with a FRESH ref_no.
//
// CRITICAL — not every S5058 failure may auto-switch. A continental US order that
// fails for VAT / street / phone / DS000007 / transient reasons must stay failed
// on S5058 so the operator can fix the real problem. Auto-fallback requires BOTH:
//   (a) 4PX's remote/island ZIP rejection, AND
//   (b) the recipient address independently confirming an S5118 territory
//       (HI / AK / PR / GU / VI / AS / MP) via state or ZIP.
// Reusing the rejected S5058 ref races 4PX's "Ref_no in processing" (DS000007)
// lock — see mintShipOrderFallbackRef() in orders.js.

/**
 * First 5 digits of a US ZIP / ZIP+4. Empty when fewer than 5 digits are present.
 * @param {string|number|null|undefined} postCode
 * @returns {string}
 */
function normalizeUsZip5(postCode) {
	const digits = String(postCode == null ? '' : postCode).replace(/\D/g, '');
	return digits.length >= 5 ? digits.slice(0, 5) : '';
}

/**
 * Pull a ZIP out of a 4PX remote-ZIP rejection message when the structured
 * recipient payload is missing one. 4PX embeds it as:
 *   "recipient_info.post_code,96817,consignee's postcode:…"
 * @param {Error|string|object|null|undefined} error
 * @returns {string} 5-digit ZIP or ''
 */
function extractPostCodeFrom4pxError(error) {
	const msg = String(error && error.message != null ? error.message : error || '');
	const m = msg.match(/post[_ ]?code\s*,\s*(\d{5})\b/i)
		|| msg.match(/\bpost(?:al)?\s*code[:\s,]+(\d{5})\b/i);
	return m ? m[1] : '';
}

/**
 * True when the recipient is in a territory US-ISLAND-PH (S5118) is meant to
 * serve: Hawaii, Alaska, Puerto Rico, Guam, US Virgin Islands, American Samoa,
 * Northern Mariana Islands. Confirmed via state/territory code OR ZIP range —
 * never by the 4PX error alone, so a misclassified continental rejection cannot
 * silently book the island lane.
 *
 * @param {object} [input]
 * @param {string} [input.postCode]
 * @param {string} [input.state]
 * @returns {boolean}
 */
function isUsIslandPhAddress({ postCode = '', state = '' } = {}) {
	const st = String(state || '').trim().toUpperCase();
	if (['HI', 'AK', 'PR', 'GU', 'VI', 'AS', 'MP'].includes(st)) return true;
	if (/^(HAWAII|ALASKA|PUERTO\s*RICO|GUAM|VIRGIN\s*ISLANDS|AMERICAN\s*SAMOA|NORTHERN\s*MARIANA)/i.test(st)) {
		return true;
	}

	const zip = normalizeUsZip5(postCode);
	if (!zip) return false;
	const n = Number(zip);
	if (!Number.isFinite(n)) return false;

	// Hawaii 96701–96898 (96799 American Samoa is also non-continental).
	if (n >= 96701 && n <= 96898) return true;
	if (zip === '96799') return true;
	// Alaska 99501–99950.
	if (n >= 99501 && n <= 99950) return true;
	// Puerto Rico 00601–00799 and 00901–00988 (as integers 601–799 / 901–988).
	if (n >= 601 && n <= 799) return true;
	if (n >= 901 && n <= 988) return true;
	// US Virgin Islands 00801–00851.
	if (n >= 801 && n <= 851) return true;
	// Guam 96910–96932.
	if (n >= 96910 && n <= 96932) return true;
	// Northern Mariana Islands 96950–96952.
	if (n >= 96950 && n <= 96952) return true;
	return false;
}

/**
 * True when a 4PX create rejection is the remote/island-ZIP "no service" error.
 * Matches the human-readable message AND the stable 010109005 business code so a
 * wording change on 4PX's side does not silently disable the fallback.
 *
 * @param {Error|string|object|null|undefined} error
 * @returns {boolean}
 */
function isRemoteIslandZipRejection(error) {
	if (error == null) return false;
	const code = String(error.code || '').trim();
	if (code === '010109005') return true;
	const msg = String(error.message || error || '');
	if (/010109005/.test(msg)) return true;
	return /remote ZIP codes?, ?no service/i.test(msg);
}

/**
 * Decide whether a failed create should be retried on US-ISLAND-PH (S5118).
 *
 * Eligibility (ALL must hold):
 *   1. Destination is the United States.
 *   2. The attempted product was POSTLINK-LW (S5058 / POSTLINK-S5058).
 *   3. 4PX rejected with the remote/island ZIP error (isRemoteIslandZipRejection).
 *   4. The recipient address independently confirms an S5118 territory
 *      (isUsIslandPhAddress) — ZIP and/or state — so continental US S5058
 *      failures never auto-flip to the island lane.
 *
 * Returns the fallback product code, or null when no auto-retry should happen.
 *
 * @param {object} input
 * @param {string} input.country                         ISO-3166 alpha-2 destination.
 * @param {string} input.selectedCode                    Product code that just failed.
 * @param {Error|string|object|null} [input.error=null]  The 4PX rejection.
 * @param {string} [input.postCode='']                   Recipient ZIP / postal code.
 * @param {string} [input.state='']                      Recipient state / territory.
 * @returns {string|null}
 */
function resolveUsIslandZipFallback({
	country,
	selectedCode,
	error = null,
	postCode = '',
	state = '',
} = {}) {
	if (_normCountry(country) !== 'US') return null;
	const from = (selectedCode || '').toString().trim().toUpperCase();
	if (from !== FOURPX_POSTLINK_S5058_CODE && from !== 'POSTLINK-S5058') return null;
	if (!isRemoteIslandZipRejection(error)) return null;

	const zip = normalizeUsZip5(postCode) || extractPostCodeFrom4pxError(error);
	if (!isUsIslandPhAddress({ postCode: zip, state })) return null;
	return FOURPX_US_ISLAND_PH_CODE;
}

module.exports = {
	FOURPX_POSTLINK_S5058_CODE,
	FOURPX_US_ISLAND_PH_CODE,
	FOURPX_DEFAULT_FALLBACK_PRODUCT,
	FOURPX_POSTLINK_S5058_COUNTRIES,
	FOURPX_COUNTRY_DEFAULT_PRODUCT,
	FOURPX_EXPRESS_WORLDWIDE,
	FOURPX_EXPRESS_BY_COUNTRY,
	FOURPX_EXPRESS_TRANSPORT_MODES,
	isPostlinkS5058Available,
	isExpressProduct,
	expressCandidates,
	resolveLogisticsProduct,
	assessExpressChoice,
	normalizeUsZip5,
	extractPostCodeFrom4pxError,
	isUsIslandPhAddress,
	isRemoteIslandZipRejection,
	resolveUsIslandZipFallback,
};
