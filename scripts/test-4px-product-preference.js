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
	FOURPX_DEFAULT_FALLBACK_PRODUCT,
	FOURPX_POSTLINK_S5058_COUNTRIES,
	FOURPX_COUNTRY_DEFAULT_PRODUCT,
	isPostlinkS5058Available,
	resolveLogisticsProduct,
} = require('../src/fourpx/product-preference');

let failures = 0;
function assert(cond, msg) {
	if (cond) { console.log(`  ok  — ${msg}`); }
	else { failures++; console.error(`  FAIL — ${msg}`); }
}

const S5058 = FOURPX_POSTLINK_S5058_CODE; // 'S5058'
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

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failing assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
