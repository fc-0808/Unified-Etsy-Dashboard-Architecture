'use strict';

/**
 * Regression test — Assign Charm (and the inline Add-Order charm picker) must
 * present the library as SECTIONS, one per charm shop · stall, in shopping walk
 * order — never as a flat wall of CH-##### codes in library sort_order.
 *
 * Pins the behaviour that is expensive to get wrong in the field:
 *   · Same-stall charms sit together (彩虹 · 2D21 before 一樂潮品 · 2C666 when
 *     stall order says so — never interleaved by numeric code).
 *   · Bare charm stall codes re-home to 龙胜 (not 通信), matching Shopping Mode.
 *   · Charms with no supplier/stall sink into one trailing section.
 *   · Within a stall+shop, codes stay numeric-stable (CH-00002 before CH-00010).
 *   · One section per shop AND stall — a merchant with two booths is two stops.
 *   · The grid container is the SCROLLER holding the sections; leaving it set to
 *     `display:grid` collapses every section into one row, so that is pinned too.
 *   · The supplier dropdown above the scroller is drawn from those same sections,
 *     so a choice can never offer a jump to a section the grid did not lay out.
 *   · The sort/group helpers and the wiring are extracted from the live
 *     public/index.html, so a drift in the shipped page fails this test instead
 *     of quietly reshuffling the grid an operator shops from.
 *
 * Run: `node scripts/test-charm-picker-sort.js`
 * Exit code 0 = all assertions pass, 1 = a regression was detected.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
	try {
		fn();
		passed++;
		console.log(`  ${GREEN}ok${RESET}  — ${name}`);
	} catch (err) {
		failed++;
		failures.push({ name, err });
		console.log(`  ${RED}FAIL${RESET} — ${name}`);
		console.log(`       ${DIM}${err.message}${RESET}`);
	}
}

function extract(file, start, end) {
	const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
	const a = source.indexOf(start);
	const b = source.indexOf(end);
	if (a < 0 || b <= a) {
		console.error(`${RED}Could not locate the sentinels in ${file}.${RESET}`);
		console.error(`${DIM}Expected "${start}" … "${end}".${RESET}`);
		process.exit(1);
	}
	return source.slice(a, b + end.length);
}

// Compile the live STALL + CHARM location blocks from index.html into a callable API.
// Stub `_charmShopStall` so the sort key falls back to default_charm_shop_stall on
// each charm row (the same field GET /api/route/charms already enriches).
function compilePickerSort() {
	const stall = extract('public/index.html', '// ══ STALL LOCATION ══', '// ══ END STALL LOCATION ══');
	const charm = extract('public/index.html', '// ══ CHARM LOCATION ══', '// ══ END CHARM LOCATION ══');
	const factory = new Function(`
		${stall}
		${charm}
		function _charmShopStall() { return ''; }
		return {
			charmLoc: _charmLoc,
			charmLocationSortKey: _charmLocationSortKey,
			charmSupplierSortKey: _charmSupplierSortKey,
			sortCharmsForPicker: _sortCharmsForPicker,
			charmGroupsForPicker: _charmGroupsForPicker,
		};
	`);
	return factory();
}

const api = compilePickerSort();
const PAGE = fs.readFileSync(path.resolve(__dirname, '..', 'public/index.html'), 'utf8');

/** The source of one top-level function in the shipped page. */
function fnSource(name, chars = 2600) {
	const at = PAGE.indexOf(`function ${name}(`);
	assert.ok(at > 0, `${name}() must exist in public/index.html`);
	return PAGE.slice(at, at + chars);
}

const charm = (code, shop, stall) => ({ code, default_charm_shop: shop, default_charm_shop_stall: stall });

console.log(`\n${BOLD}Charm picker supplier/location sort${RESET}\n`);

test('bare charm stall codes re-home to 龙胜 (not 通信)', () => {
	const loc = api.charmLoc('2D21');
	assert.strictEqual(loc.buildingId, 'longsheng', `expected longsheng, got ${loc.buildingId}`);
	assert.strictEqual(loc.code, '2D21');
	assert.strictEqual(loc.isHome, false);
});

test('explicit market prefixes keep their building', () => {
	const loc = api.charmLoc('经济5D100');
	assert.strictEqual(loc.buildingId, 'jingji');
	assert.strictEqual(loc.code, '5D100');
});

test('Assign Charm clusters by stall, then shop — not by CH code', () => {
	// Intentionally out of code order: CH-00001 (一樂) sits between two 彩虹 codes
	// in the library, which is exactly the screenshot defect.
	const input = [
		{ code: 'CH-00001', default_charm_shop: '一樂潮品', default_charm_shop_stall: '2C666' },
		{ code: 'CH-00002', default_charm_shop: '彩虹', default_charm_shop_stall: '2D21' },
		{ code: 'CH-00013', default_charm_shop: '一樂潮品', default_charm_shop_stall: '2C666' },
		{ code: 'CH-00003', default_charm_shop: '彩虹', default_charm_shop_stall: '2D21' },
		{ code: 'CH-00099', default_charm_shop: '', default_charm_shop_stall: '' },
	];
	const codes = api.sortCharmsForPicker(input).map((c) => c.code);

	// Stall 2C666 < 2D21 lexicographically within 龙胜 F2 → 一樂 group first.
	assert.deepStrictEqual(
		codes,
		['CH-00001', 'CH-00013', 'CH-00002', 'CH-00003', 'CH-00099'],
		`got ${codes.join(', ')}`,
	);
});

test('same stall+shop keeps numeric code order (CH-00002 before CH-00010)', () => {
	const input = [
		{ code: 'CH-00010', default_charm_shop: '彩虹', default_charm_shop_stall: '2D21' },
		{ code: 'CH-00002', default_charm_shop: '彩虹', default_charm_shop_stall: '2D21' },
	];
	const codes = api.sortCharmsForPicker(input).map((c) => c.code);
	assert.deepStrictEqual(codes, ['CH-00002', 'CH-00010']);
});

test('unlocated charms always sort after located ones', () => {
	const input = [
		{ code: 'CH-00050', default_charm_shop: '', default_charm_shop_stall: '' },
		{ code: 'CH-00001', default_charm_shop: '彩虹', default_charm_shop_stall: '2D21' },
		{ code: 'CH-00051', default_charm_shop: '', default_charm_shop_stall: '' },
	];
	const codes = api.sortCharmsForPicker(input).map((c) => c.code);
	assert.deepStrictEqual(codes, ['CH-00001', 'CH-00050', 'CH-00051']);
});

test('sort is stable / non-mutating on the input array', () => {
	const input = [
		{ code: 'CH-00003', default_charm_shop: '彩虹', default_charm_shop_stall: '2D21' },
		{ code: 'CH-00001', default_charm_shop: '一樂潮品', default_charm_shop_stall: '2C666' },
	];
	const before = input.map((c) => c.code).join(',');
	api.sortCharmsForPicker(input);
	assert.strictEqual(input.map((c) => c.code).join(','), before, 'input array must not be mutated');
});

// ── Sections ────────────────────────────────────────────────────────────────

test('the library is cut into one section per shop · stall, in walking order', () => {
	const groups = api.charmGroupsForPicker([
		charm('CH-00013', '一樂潮品', '2C666'),
		charm('CH-00002', '彩虹', '2D21'),
		charm('CH-00001', '一樂潮品', '2C666'),
		charm('CH-00003', '彩虹', '2D21'),
	]);
	assert.strictEqual(groups.length, 2, `expected 2 sections, got ${groups.length}`);
	assert.deepStrictEqual(
		groups.map((g) => [g.shop, g.stall, g.charms.length]),
		[
			['一樂潮品', '2C666', 2],
			['彩虹', '2D21', 2],
		],
	);
	assert.deepStrictEqual(groups[0].charms.map((c) => c.code), ['CH-00001', 'CH-00013']);
});

test('one merchant with two booths is two sections, not one', () => {
	const groups = api.charmGroupsForPicker([
		charm('CH-00001', '彩虹', '2D21'),
		charm('CH-00002', '彩虹', '3A10'),
	]);
	assert.strictEqual(groups.length, 2, 'a shop at two stalls is two stops on the route');
	assert.deepStrictEqual(groups.map((g) => g.stall), ['2D21', '3A10']);
});

test('a section carries its market and floor for the header', () => {
	const [g] = api.charmGroupsForPicker([charm('CH-00001', '彩虹', '2D21')]);
	assert.strictEqual(g.located, true);
	assert.strictEqual(g.market.en, 'Longsheng');
	assert.strictEqual(g.market.zh, '龙胜');
	assert.strictEqual(g.floor, 2, `expected floor 2, got ${g.floor}`);
});

test('a shop with no stall recorded is still its own section, floor unknown', () => {
	const [g] = api.charmGroupsForPicker([charm('CH-00001', '彩虹', '')]);
	assert.strictEqual(g.located, true, 'a named shop is a real section');
	assert.strictEqual(g.stall, '');
	assert.strictEqual(g.floor, null, 'an unreadable floor must be null, never the 999 sentinel');
});

test('charms with no supplier collapse into ONE trailing section', () => {
	const groups = api.charmGroupsForPicker([
		charm('CH-00050', '', ''),
		charm('CH-00001', '彩虹', '2D21'),
		charm('CH-00051', '', ''),
	]);
	assert.strictEqual(groups.length, 2);
	const last = groups[groups.length - 1];
	assert.strictEqual(last.located, false, 'the unset section must be last');
	assert.deepStrictEqual(last.charms.map((c) => c.code), ['CH-00050', 'CH-00051']);
});

test('every charm survives grouping exactly once', () => {
	const input = [
		charm('CH-00001', '彩虹', '2D21'),
		charm('CH-00002', '一樂潮品', '2C666'),
		charm('CH-00003', '', ''),
		charm('CH-00004', '汇通店', '汇通A146'),
	];
	const out = api.charmGroupsForPicker(input).flatMap((g) => g.charms);
	assert.deepStrictEqual(out.map((c) => c.code).sort(), input.map((c) => c.code).sort());
});

// ── Wiring in the shipped page ──────────────────────────────────────────────

test('renderCharmGrid renders sections outside manage mode', () => {
	const src = fnSource('renderCharmGrid');
	assert.ok(src.includes('_charmGroupsForPicker'), 'pick mode must group by supplier');
	assert.ok(src.includes('charm-group-head') || src.includes('_charmGroupHeadHtml'), 'each section needs its header');
	assert.ok(src.includes('_charmManageMode'), 'manage mode must stay a flat library-order grid');
});

test('manage mode keeps ONE flat grid so drag-to-reorder still works', () => {
	const src = fnSource('renderCharmGrid');
	const manage = src.slice(src.indexOf('if (_charmManageMode)'), src.indexOf('_charmGroupsForPicker'));
	assert.ok(manage.includes('charm-group-grid'), 'manage mode renders a single grid');
	assert.ok(!manage.includes('_charmGroupHeadHtml'), 'manage mode must NOT render supplier headers');
});

test('the grid container is displayed as the section SCROLLER, not a grid', () => {
	const src = fnSource('_applyCharmModalView', 1400);
	assert.ok(
		/grid\.style\.display\s*=\s*showGrid\s*\?\s*'block'/.test(src),
		"charmGrid must be display:block — 'grid' collapses every section into one row",
	);
});

test('inline Add-Order charm table shares the same sections', () => {
	const src = fnSource('renderAoCharmTable', 3200);
	assert.ok(src.includes('_charmGroupsForPicker'), 'Add-Order picker must share Assign Charm grouping');
	assert.ok(src.includes('ao-charm-group-row'), 'sections need a header row');
});

test('pick-mode cards drop the shop line the section header already states', () => {
	const src = fnSource('_charmCardHtml', 2600);
	const manageBranch = src.indexOf('if (_charmManageMode)');
	assert.ok(manageBranch > 0, 'manage branch must exist');
	assert.ok(src.slice(manageBranch).includes('charm-card-shop'), 'manage cards keep the shop line (flat list)');
	assert.ok(!src.slice(0, manageBranch).includes('charm-card-shop'), 'pick cards must not repeat the section header');
});

test('the supplier dropdown is drawn from the same sections as the grid', () => {
	const src = fnSource('renderCharmGrid');
	assert.ok(/_renderCharmJumpRail\(groups\)/.test(src), 'the dropdown must be fed the groups the grid lays out — anything else can offer a jump to a section that is not there');
	const manage = src.slice(src.indexOf('if (_charmManageMode)'), src.indexOf('_charmGroupsForPicker'));
	assert.ok(manage.includes('_renderCharmJumpRail'), 'manage mode must stand the dropdown down — a flat list has no sections to jump between');
});

// ── Presentation contract ───────────────────────────────────────────────────

test('the supplier dropdown sits above the scroller and never clips', () => {
	const tools = PAGE.indexOf('class="charm-modal-tools"');
	const jump = PAGE.indexOf('id="charmJump"');
	const grid = PAGE.indexOf('id="charmGrid"');
	assert.ok(tools > 0 && jump > tools && grid > jump, 'the dropdown must sit between the toolbar and the grid: inside the scroller it would scroll away from the charms it steers');
	assert.ok(PAGE.includes('id="charmJumpSelect"'), 'a native <select> is the control that cannot clip');
	assert.ok(PAGE.includes('for="charmJumpSelect"'), 'the select needs an associated label');
	assert.ok(!PAGE.includes('cj-chip'), 'the overflowing chip rail must be gone');
});

test('scrolling the picker drives the dropdown', () => {
	const at = PAGE.indexOf('<div class="charm-grid"');
	assert.ok(at > 0, 'the charm grid must exist');
	const tag = PAGE.slice(at, PAGE.indexOf('>', at) + 1);
	assert.ok(tag.includes('onscroll="_onCharmGridScroll()"'), 'without the scroll hook the dropdown cannot follow the operator down the list');
});

test('section headers are sticky, so the shop is always on screen', () => {
	const at = PAGE.indexOf('.charm-group-head {');
	assert.ok(at > 0, '.charm-group-head must be styled');
	const rule = PAGE.slice(at, PAGE.indexOf('}', at));
	assert.ok(/position:\s*sticky/.test(rule), 'the header must pin while its charms scroll');
	assert.ok(/top:\s*0/.test(rule), 'it must pin to the top of the scroller');
});

test('the picker is mobile-responsive: sections reflow under 768px', () => {
	const mq = PAGE.indexOf('@media (max-width: 768px) {', PAGE.indexOf('.charm-modal-tools {'));
	assert.ok(mq > 0, 'the charm sub-menu mobile block must exist');
	const block = PAGE.slice(mq, mq + 4000);
	assert.ok(block.includes('.charm-group-grid'), 'the section grid must retune its columns on a phone');
	assert.ok(block.includes('.charm-group-head'), 'the section header must reflow on a phone');
	assert.ok(block.includes('.cj-select'), 'the supplier dropdown must stay usable on a phone');
});

console.log('');
if (failed) {
	console.log(`${RED}${BOLD}${failed} failed${RESET}, ${passed} passed`);
	for (const f of failures) {
		console.log(`\n${RED}• ${f.name}${RESET}\n${f.err.stack}`);
	}
	process.exit(1);
}
console.log(`${GREEN}${BOLD}All ${passed} assertions passed.${RESET}`);
process.exit(0);
