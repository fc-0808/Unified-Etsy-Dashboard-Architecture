'use strict';

/**
 * Regression test — 4PX default logistics-product selection.
 *
 * Guards the business rule that orders shipped with 4PX default to POSTLINK-LW
 * (S5058 / "postlink-s5058") when the destination supports it, and fall back to
 * QC otherwise:
 *   1. Docs-verified S5058 coverage — supported countries default to S5058, and
 *      unsupported ones default to QC.
 *   2. Live-catalogue availability is authoritative — when a destination product
 *      list is supplied, S5058 is chosen iff it is actually in that list.
 *   3. Per-country overrides win (Belgium → QC) even where PostLink is documented.
 *   4. Config default is honoured before the hard-coded QC fallback.
 *
 * Run: `node scripts/test-4px-product-preference.js`  (exit 0 = pass, 1 = fail)
 */

const {
	FOURPX_POSTLINK_S5058_CODE,
	FOURPX_US_ISLAND_PH_CODE,
	FOURPX_DEFAULT_FALLBACK_PRODUCT,
	FOURPX_POSTLINK_S5058_COUNTRIES,
	FOURPX_COUNTRY_DEFAULT_PRODUCT,
	isPostlinkS5058Available,
	resolveLogisticsProduct,
	isRemoteIslandZipRejection,
	resolveUsIslandZipFallback,
	isUsIslandPhAddress,
	normalizeUsZip5,
	extractPostCodeFrom4pxError,
} = require('../src/fourpx/product-preference');

let failures = 0;
function assert(cond, msg) {
	if (cond) { console.log(`  ok  — ${msg}`); }
	else { failures++; console.error(`  FAIL — ${msg}`); }
}

const S5058 = FOURPX_POSTLINK_S5058_CODE; // 'S5058'
const S5118 = FOURPX_US_ISLAND_PH_CODE; // 'S5118'
const QC = FOURPX_DEFAULT_FALLBACK_PRODUCT; // 'QC'

console.log('4PX default logistics-product selection test\n');

// 1. Docs-verified coverage: supported destinations default to POSTLINK-S5058.
{
	for (const cc of ['US', 'GB', 'DE', 'FR', 'AU', 'CA', 'NZ', 'BR', 'SG']) {
		assert(isPostlinkS5058Available(cc), `${cc}: POSTLINK-S5058 is available (docs coverage)`);
		assert(resolveLogisticsProduct({ country: cc }) === S5058, `${cc}: defaults to ${S5058}`);
	}
	// Case-insensitive country input still resolves.
	assert(resolveLogisticsProduct({ country: 'us' }) === S5058, 'lower-case "us" still defaults to S5058');
}

// 2. Unsupported destinations fall back to QC.
{
	for (const cc of ['JP', 'KR', 'MX', 'HK', 'TW', 'ZA', 'IN', 'RU']) {
		assert(!isPostlinkS5058Available(cc), `${cc}: POSTLINK-S5058 is NOT available`);
		assert(resolveLogisticsProduct({ country: cc }) === QC, `${cc}: falls back to ${QC}`);
	}
	// Empty / unknown country → QC.
	assert(resolveLogisticsProduct({ country: '' }) === QC, 'empty country falls back to QC');
	assert(resolveLogisticsProduct({}) === QC, 'missing country falls back to QC');
}

// 3. Live catalogue is authoritative when supplied.
{
	const withS5058 = [{ logistics_product_code: 'S5058' }, { logistics_product_code: 'QC' }];
	const withoutS5058 = [{ logistics_product_code: 'QC' }, { logistics_product_code: 'FXEC' }];

	// A country NOT in the static set still gets S5058 if the live list has it.
	assert(resolveLogisticsProduct({ country: 'JP', availableProducts: withS5058 }) === S5058,
		'JP with S5058 in live catalogue → S5058 (live list authoritative)');

	// A country in the static set falls back to QC when the live list omits S5058.
	assert(resolveLogisticsProduct({ country: 'US', availableProducts: withoutS5058 }) === QC,
		'US without S5058 in live catalogue → QC');

	// Matched by POSTLINK-LW display name, not just the code.
	const byName = [{ logistics_product_code: 'X1', logistics_product_name: 'POSTLINK-LW' }, { logistics_product_code: 'QC' }];
	assert(isPostlinkS5058Available('JP', byName), 'POSTLINK-LW display name counts as available');

	// Sole-product catalogue: use the only product on offer.
	const sole = [{ logistics_product_code: 'FXEC' }];
	assert(resolveLogisticsProduct({ country: 'ZA', availableProducts: sole }) === 'FXEC',
		'sole-product catalogue selects the only product');

	// Empty catalogue → no default (null), so the UI prompts the operator.
	assert(resolveLogisticsProduct({ country: 'ZA', availableProducts: [] }) === null,
		'empty catalogue → null (no default to pre-select)');
}

// 4. Per-country override wins over the general S5058 default.
{
	assert(FOURPX_COUNTRY_DEFAULT_PRODUCT.BE === 'QC', 'Belgium override configured as QC');
	assert(!FOURPX_POSTLINK_S5058_COUNTRIES.has('BE'), 'Belgium excluded from S5058 coverage set');
	assert(resolveLogisticsProduct({ country: 'BE' }) === QC, 'Belgium defaults to QC (override)');
}

// 5. Configured default is used before the hard-coded QC fallback.
{
	assert(resolveLogisticsProduct({ country: 'JP', configDefault: 'FXEC' }) === 'FXEC',
		'unsupported country uses config default (FXEC) over QC');
	// But POSTLINK-S5058 still wins over a config default where it's available.
	assert(resolveLogisticsProduct({ country: 'US', configDefault: 'FXEC' }) === S5058,
		'S5058 still preferred over config default where available');
}

// 6. US remote/island ZIP auto-fallback: S5058 → S5118.
// The exact failure from a Hawaii/Alaska/PR ZIP booked on POSTLINK-LW — 4PX
// returns 010109005 ("remote ZIP codes, no service"). Bulk Ship-with-4PX must
// switch to US-ISLAND-PH automatically — BUT only when the address itself
// confirms an S5118 territory. A continental US S5058 failure must never flip.
{
	console.log('\nUS remote/island ZIP fallback (S5058 → S5118)');
	assert(S5118 === 'S5118', 'US-ISLAND-PH code is S5118');

	const islandMsg = "recipient_info.post_code,96817,consignee's postcode:Only 5-10 digits; remote ZIP codes, no service;";
	const islandErr = Object.assign(new Error(islandMsg), { code: '010109005' });

	assert(isRemoteIslandZipRejection(islandErr), 'detects remote ZIP rejection by message + code');
	assert(isRemoteIslandZipRejection({ code: '010109005', message: 'anything' }), '…and by the stable 010109005 code alone');
	assert(isRemoteIslandZipRejection(islandMsg), '…and by a bare message string');
	assert(!isRemoteIslandZipRejection(new Error('VAT number is required')), 'other 4PX errors are not island-ZIP rejections');
	assert(!isRemoteIslandZipRejection(null) && !isRemoteIslandZipRejection(undefined), 'null/undefined are not island-ZIP rejections');

	assert(normalizeUsZip5('96817-1234') === '96817', 'ZIP+4 normalises to 5 digits');
	assert(normalizeUsZip5('00601') === '00601', 'PR ZIP keeps its leading zeros as a 5-digit string');
	assert(extractPostCodeFrom4pxError(islandErr) === '96817', 'ZIP is recoverable from the 4PX rejection text');

	assert(isUsIslandPhAddress({ postCode: '96817', state: 'HI' }), 'Honolulu ZIP is S5118-eligible');
	assert(isUsIslandPhAddress({ postCode: '99501', state: '' }), 'Anchorage ZIP is S5118-eligible without state');
	assert(isUsIslandPhAddress({ postCode: '', state: 'PR' }), 'Puerto Rico state alone is S5118-eligible');
	assert(isUsIslandPhAddress({ postCode: '96910' }), 'Guam ZIP is S5118-eligible');
	assert(isUsIslandPhAddress({ postCode: '00802' }), 'USVI ZIP is S5118-eligible');
	assert(!isUsIslandPhAddress({ postCode: '90210', state: 'CA' }), 'Beverly Hills is NOT S5118-eligible');
	assert(!isUsIslandPhAddress({ postCode: '10001', state: 'NY' }), 'Manhattan is NOT S5118-eligible');
	assert(!isUsIslandPhAddress({ postCode: '', state: '' }), 'empty address is NOT S5118-eligible');

	assert(
		resolveUsIslandZipFallback({ country: 'US', selectedCode: S5058, error: islandErr, postCode: '96817', state: 'HI' }) === S5118,
		'US + S5058 + remote ZIP error + HI address → retry on S5118',
	);
	assert(
		resolveUsIslandZipFallback({ country: 'us', selectedCode: 'postlink-s5058', error: islandErr, postCode: '96817' }) === S5118,
		'case-insensitive country + ZIP-only confirmation also resolve to S5118',
	);
	assert(
		resolveUsIslandZipFallback({ country: 'US', selectedCode: 'S5058', error: { code: '010109005', message: islandMsg } }) === S5118,
		'ZIP embedded in the 4PX error is enough to confirm the territory',
	);
	assert(
		resolveUsIslandZipFallback({ country: 'US', selectedCode: S5058, error: islandErr, state: 'AK' }) === S5118,
		'Alaska state alone (with remote ZIP error) resolves to S5118',
	);

	// Negative cases — must NOT auto-switch.
	assert(
		resolveUsIslandZipFallback({ country: 'CA', selectedCode: S5058, error: islandErr, postCode: '96817' }) === null,
		'non-US destination never auto-switches',
	);
	assert(
		resolveUsIslandZipFallback({ country: 'US', selectedCode: 'PX', error: islandErr, postCode: '96817' }) === null,
		'a deliberately chosen non-S5058 lane is left alone',
	);
	assert(
		resolveUsIslandZipFallback({ country: 'US', selectedCode: S5118, error: islandErr, postCode: '96817' }) === null,
		'already on S5118 does not loop',
	);
	assert(
		resolveUsIslandZipFallback({ country: 'US', selectedCode: S5058, error: new Error('VAT number is required'), postCode: '96817' }) === null,
		'unrelated S5058 failures do not switch to the island lane',
	);
	assert(
		resolveUsIslandZipFallback({ country: 'US', selectedCode: S5058, error: null, postCode: '96817' }) === null,
		'missing error does not invent a fallback',
	);
	assert(
		resolveUsIslandZipFallback({ country: 'US', selectedCode: S5058, error: islandErr, postCode: '90210', state: 'CA' }) === null,
		'continental US address does NOT auto-switch even when 4PX said remote ZIP',
	);
	assert(
		resolveUsIslandZipFallback({ country: 'US', selectedCode: S5058, error: { code: '010109005', message: 'remote ZIP codes, no service' } }) === null,
		'remote ZIP error alone (no ZIP/state evidence) does NOT auto-switch',
	);

	// Wiring: the shared create path (single-order + bulk) must actually call it.
	// A classifier that nothing invokes is a silent regression waiting to happen.
	const fs = require('fs');
	const path = require('path');
	const serverSrc = fs.readFileSync(path.join(__dirname, '../src/server/index.js'), 'utf8');
	assert(/resolveUsIslandZipFallback/.test(serverSrc), 'server imports resolveUsIslandZipFallback');
	assert(/auto-retrying with \$\{fallbackCode\}/.test(serverSrc) || /auto-retrying with/.test(serverSrc),
		'…and retries the create on US-ISLAND-PH inside create4pxShipmentForReceipt');
	assert(/mintShipOrderFallbackRef/.test(serverSrc) && /createWithIslandZipFallback/.test(serverSrc),
		'…on a FRESH ref (not the rejected S5058 ref) so DS000007 cannot strand the row');
	assert(/isRefInProcessingRejection/.test(serverSrc) && /waitAndAdoptRef/.test(serverSrc),
		'…and DS000007 waits/adopts before surfacing "already being submitted"');
	assert(/postCode: enrichedRecipient\.post_code/.test(serverSrc) && /resolveIslandFallback/.test(serverSrc),
		'…and passes the recipient ZIP/state so continental US cannot auto-flip');
	assert(/productFallback/.test(serverSrc), '…and surfaces the switch on the create / bulk result');
	const pageSrc = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
	assert(/productFallback/.test(pageSrc) && /US-ISLAND-PH/.test(pageSrc),
		'bulk wizard shows when a row was auto-switched to US-ISLAND-PH');
	assert(/function _fbxShipToFromOrder\(o\)/.test(pageSrc) && /fbx-row-shipto/.test(pageSrc),
		'bulk wizard rows show the ship-to address for pre-label verification');
	assert(/shipTo: _fbxShipToFromOrder\(o\)/.test(pageSrc), '…built when the modal opens from the orders cache');
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failing assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
