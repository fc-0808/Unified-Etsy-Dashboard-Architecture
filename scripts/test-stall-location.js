'use strict'
/**
 * Tests for stall locations — which BUILDING a stall is in, which floor, and the
 * order a shopper walks them.
 *
 * We buy from several markets now (通信 / 太平洋 / 康乐 / 康乐北区 / 汇通 / 经济) and a
 * stall outside the home market carries its market as a prefix, e.g.
 * "康乐北区5A40-42". Everything downstream — Shopping Mode's route order and its
 * Overview tree, the desktop supplier sort, the Excel export — hangs off parsing
 * that prefix correctly, so this file pins the behaviour that is expensive to get
 * wrong:
 *
 *   · A market prefix must never be mistaken for part of the stall code, and a
 *     longer market name must win over a shorter one that prefixes it
 *     (康乐北区 is NOT 康乐).
 *   · Floors are read AFTER the prefix is stripped, so 通信518 is on 5F.
 *   · Stops sort market-first, so a trip is walked one building at a time.
 *   · The parser is duplicated into two shipped pages (they are plain HTML, not
 *     modules). Both copies are extracted from the real files and run against
 *     the server module here, so a copy that drifts fails the build instead of
 *     quietly sending a shopper to the wrong building.
 *   · The Overview tree groups Section → Building → Floor → Stall, folds away
 *     finished branches, and keeps every leaf pointing at the right card.
 *   · Every market is presented identically in the route — same markup, same
 *     phrasing, same colours — so a shopper tells one leg from the next by
 *     reading its name rather than by having learnt that the home market is
 *     drawn differently from the rest.
 *
 * Run: `node scripts/test-stall-location.js`
 * Exit code 0 = all assertions pass, 1 = a regression was detected.
 */

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const server = require('../src/route/stall-location')

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m'
let passed = 0, failed = 0
const failures = []
const queue = []
const group = (name) => queue.push({ group: name })
const test = (name, fn) => queue.push({ name, fn })

// ── Extract each page's copy of the parser straight out of the shipped file ──
const START = '// ══ STALL LOCATION ══'
const END = '// ══ END STALL LOCATION ══'

function extract(file, start, end) {
	const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8')
	const a = source.indexOf(start)
	const b = source.indexOf(end)
	if (a < 0 || b <= a) {
		console.error(`${RED}Could not locate the sentinels in ${file}.${RESET}`)
		console.error(`${DIM}Expected "${start}" … "${end}".${RESET}`)
		process.exit(1)
	}
	return source.slice(a, b)
}

/**
 * Compile a page's parser block into the same shape the server module exports,
 * so the two can be compared field for field. The pages prefix their identifiers
 * differently (index.html shares one global scope with everything else), which
 * is why the names to export are passed in.
 */
function compileMirror(file, names) {
	const src = extract(file, START, END)
	const returns = Object.entries(names)
		.map(([as, local]) => `${as}: ${local}`)
		.join(', ')
	return new Function(`${src}\nreturn { ${returns} }`)()
}

const mirrors = [
	{
		file: 'public/shop.html',
		api: compileMirror('public/shop.html', { parseStall: 'parseStall', stallFloor: 'stallFloor', locationSortKey: 'locationSortKey', BUILDINGS: 'BUILDINGS', HOME_BUILDING_ID: 'HOME_BUILDING_ID' }),
	},
	{
		file: 'public/index.html',
		api: compileMirror('public/index.html', {
			parseStall: '_parseStall',
			stallFloor: '_stallFloor',
			locationSortKey: '_locationSortKey',
			supplierIdentityKey: '_supplierIdentityKey',
			BUILDINGS: '_BUILDINGS',
			HOME_BUILDING_ID: '_HOME_BUILDING_ID',
		}),
	},
]

// ── The corpus every implementation is compared on ──────────────────────────
// Every stall code the live catalog holds, plus the inputs that have historically
// broken naive parsers: casing, full-width forms, placeholders, non-strings, a
// market that prefixes another, and a market nobody has registered yet.
const CATALOG_STALLS = [
	'4A53', '4A56', '4C14', '4C21', '4C86', '5888', '5A01-03', '5A01-05', '5A05', '5A10', '5A12', '5A13', '5A22', '5A31',
	'5B13', '5B15', '5B16', '5B17', '5B19', '5B25', '5B31', '5B38', '5C05', '5C09', '5C13', '5C15', '5C20', '5C21',
	'5C25', '5C26', '5C27', '5C33', '5C51', '5C52-53', '5C55', '5C61', '5C66', '5C67', '5C70', '5C72', '5D19',
	'A2-29', 'A2-30', 'A2-33', 'A2-36', 'A2001', 'A2006', 'A203A', 'A204A-2', 'A207', 'A208', 'A209', 'A210', 'A211',
	'A213', 'A215', 'A217', 'A220', 'A220A', 'A221', 'A222', 'A223', 'A228', 'A231', 'A232', 'A233', 'A236B', 'A237',
	'A238', 'A239', 'A240', 'A247', 'A257', 'A258A', 'A260', 'A262', 'A265', 'A266', 'A267', 'A276', 'A278', 'A279',
	'A282', 'A285', 'A290', 'A295',
	'太平洋1B111', '太平洋3A73', '康乐5A17', '康乐北区4D29', '康乐北区4D32', '康乐北区4H33', '康乐北区5A40-42',
	'康乐北区5C34-39', '汇通A138-139', '汇通A146', '汇通A999', '汇通B028', '经济5D100', '经济5D16', '经济5D91', '通信518',
]
const EDGE_STALLS = [
	'', '   ', '—', '–', '-', '???', null, undefined, 5031,
	'a2-29', 'Ａ２-２９', '５Ｃ２６', '汇通 A146', ' 康乐北区5A40-42 ', '康乐北5C01', '康乐', '汇通',
	'通信 518', '新市场B12', '曼哈广场', 'B028', 'X1', '9', 'A9-9',
]
const CORPUS = [...CATALOG_STALLS, ...EDGE_STALLS]

// ── Parsing ─────────────────────────────────────────────────────────────────
group('Reading a stall code')

test('a bare code belongs to the home market', () => {
	const loc = server.parseStall('A2-29')
	assert.strictEqual(loc.buildingId, 'tongxin')
	assert.strictEqual(loc.isHome, true)
	assert.strictEqual(loc.code, 'A2-29')
	assert.strictEqual(loc.floor, 2)
})

test('a market prefix is split off and never left in the code', () => {
	const loc = server.parseStall('康乐北区5A40-42')
	assert.strictEqual(loc.buildingId, 'kangle-north')
	assert.strictEqual(loc.code, '5A40-42', 'the code shown on the booth is what a shopper looks for')
	assert.strictEqual(loc.floor, 5)
	assert.strictEqual(loc.isHome, false)
})

test('the longer market name wins over the shorter one it starts with', () => {
	// 康乐 and 康乐北区 are different buildings. Matching the short one first
	// would file every 康乐北区 stall in the wrong building AND leave "北区" glued
	// to the front of the stall code.
	assert.strictEqual(server.parseStall('康乐北区4D32').buildingId, 'kangle-north')
	assert.strictEqual(server.parseStall('康乐北区4D32').code, '4D32')
	assert.strictEqual(server.parseStall('康乐5A17').buildingId, 'kangle')
	assert.strictEqual(server.parseStall('康乐5A17').code, '5A17')
})

test('the floor is read after the prefix comes off', () => {
	// The whole point: "通信518" used to read as floor-unknown because the parser
	// met a Chinese character first and gave up, so it sank into "Other".
	assert.strictEqual(server.stallFloor('通信518'), 5)
	assert.strictEqual(server.stallFloor('太平洋1B111'), 1)
	assert.strictEqual(server.stallFloor('经济5D91'), 5)
})

test('the home market floor rules are unchanged', () => {
	assert.strictEqual(server.stallFloor('A2-29'), 2, 'the A block is 2F whatever its digits say')
	assert.strictEqual(server.stallFloor('A2001'), 2)
	assert.strictEqual(server.stallFloor('4C14'), 4)
	assert.strictEqual(server.stallFloor('5A05'), 5)
	assert.strictEqual(server.stallFloor('5B31-32'), 5)
})

test('an unreadable floor stays unknown rather than being guessed', () => {
	// 汇通's numbering hasn't been surveyed. Inventing a storey from "A138" would
	// send a shopper up the wrong stairs; "unknown" merely lists it last.
	for (const stall of ['汇通A138-139', '汇通A146', '汇通B028']) {
		assert.strictEqual(server.stallFloor(stall), server.UNKNOWN_FLOOR, stall)
	}
	assert.strictEqual(server.parseStall('汇通A138-139').buildingId, 'huitong', 'the building is still known')
})

test('a market nobody registered becomes a stop of its own', () => {
	const loc = server.parseStall('新市场B12')
	assert.strictEqual(loc.located, true)
	assert.strictEqual(loc.registered, false)
	assert.strictEqual(loc.code, 'B12')
	assert.strictEqual(loc.buildingLabel.zh, '新市场')
	assert.notStrictEqual(loc.buildingId, server.HOME_BUILDING_ID, 'must not be filed under the home market')
})

test('placeholders and blanks are unlocated, not a building', () => {
	for (const stall of ['', '   ', '—', '-', '???', null, undefined]) {
		const loc = server.parseStall(stall)
		assert.strictEqual(loc.located, false, JSON.stringify(stall))
		assert.strictEqual(loc.buildingId, '')
		assert.strictEqual(loc.floor, server.UNKNOWN_FLOOR)
	}
})

test('full-width and spaced spellings land on the same stall', () => {
	assert.strictEqual(server.parseStall('Ａ２-２９').code, 'A2-29')
	assert.strictEqual(server.parseStall('Ａ２-２９').floor, 2)
	assert.strictEqual(server.parseStall('汇通 A146').code, 'A146')
	assert.strictEqual(server.parseStall(' 康乐北区5A40-42 ').code, '5A40-42')
})

// ── Walking order ───────────────────────────────────────────────────────────
group('Walking order')

test('stops are grouped by market before floor', () => {
	// The bug this replaces: sorting on floor alone interleaved the home market's
	// 5C26 with 康乐北区5A40-42 and 经济5D91 — buildings a taxi ride apart.
	const walked = ['经济5D91', '5C26', '康乐北区5A40-42', 'A2-29', '太平洋1B111', '康乐5A17']
		.sort((a, b) => {
			const ka = server.locationSortKey(a, ''), kb = server.locationSortKey(b, '')
			return ka < kb ? -1 : ka > kb ? 1 : 0
		})
	// The shopper's walk: 经济 → 通信 → 康乐北区 (and its 康乐 half) → 太平洋 → 汇通.
	assert.deepStrictEqual(walked, ['经济5D91', 'A2-29', '5C26', '康乐北区5A40-42', '康乐5A17', '太平洋1B111'])
})

test('inside a market, floors run in order and unknown floors come last', () => {
	const walked = ['汇通A146', '汇通B028', '汇通A138-139']
		.concat(['康乐北区5A40-42', '康乐北区4D29'])
		.sort((a, b) => {
			const ka = server.locationSortKey(a, ''), kb = server.locationSortKey(b, '')
			return ka < kb ? -1 : ka > kb ? 1 : 0
		})
	assert.deepStrictEqual(walked, ['康乐北区4D29', '康乐北区5A40-42', '汇通A138-139', '汇通A146', '汇通B028'])
})

test('the shop name only ever breaks a tie', () => {
	const a = server.locationSortKey('康乐北区4D32', 'jy')
	const b = server.locationSortKey('康乐北区4D32', '加满')
	assert.notStrictEqual(a, b)
	assert.ok(a < b, 'two shops at one stall stay adjacent, ordered by name')
})

test('stalls of unregistered markets sort after every registered one', () => {
	const key = (s) => server.locationSortKey(s, '')
	assert.ok(key('经济5D91') < key('新市场B12'))
})

group('Supplier booth identity')

test('letter case never invents a second booth for the same stop', () => {
	assert.strictEqual(
		server.supplierIdentityKey('leo', '汇通A146'),
		server.supplierIdentityKey('Leo', '汇通a146'),
		'A146 / a146 must fold to one booth — otherwise the picker paints a greyed-out twin Manage cannot delete',
	)
	assert.strictEqual(server.supplierIdentityKey('HAN', 'A2-29'), server.supplierIdentityKey('han', 'a2-29'))
})

test('two different stalls at the same shop stay distinct', () => {
	assert.notStrictEqual(server.supplierIdentityKey('TwoStall', '5C26'), server.supplierIdentityKey('TwoStall', '5C27'))
})

test('NFKC and dash spelling fold the same way normalizeStall does', () => {
	assert.strictEqual(server.supplierIdentityKey('V8', 'A2-29'), server.supplierIdentityKey('V8', 'Ａ２-２９'))
	assert.strictEqual(server.supplierIdentityKey('V8', 'A2–29'), server.supplierIdentityKey('V8', 'A2-29'))
})

// ── The shipped copies must agree with this module ──────────────────────────
group('Page copies match the server parser')

for (const mirror of mirrors) {
	test(`${mirror.file} parses every stall identically`, () => {
		for (const stall of CORPUS) {
			assert.deepStrictEqual(
				mirror.api.parseStall(stall),
				server.parseStall(stall),
				`${mirror.file} disagrees about ${JSON.stringify(stall)} — re-sync it with src/route/stall-location.js`,
			)
			assert.strictEqual(mirror.api.stallFloor(stall), server.stallFloor(stall), `${mirror.file} floor for ${JSON.stringify(stall)}`)
			assert.strictEqual(
				mirror.api.locationSortKey(stall, 'shop'),
				server.locationSortKey(stall, 'shop'),
				`${mirror.file} sort key for ${JSON.stringify(stall)}`,
			)
			if (mirror.api.supplierIdentityKey) {
				assert.strictEqual(
					mirror.api.supplierIdentityKey('leo', stall),
					server.supplierIdentityKey('leo', stall),
					`${mirror.file} supplier identity for ${JSON.stringify(stall)}`,
				)
			}
		}
	})

	test(`${mirror.file} registers the same markets in the same order`, () => {
		assert.strictEqual(mirror.api.HOME_BUILDING_ID, server.HOME_BUILDING_ID)
		assert.deepStrictEqual(
			mirror.api.BUILDINGS.map((b) => [b.id, b.order, b.aliases.join('/')]),
			server.BUILDINGS.map((b) => [b.id, b.order, b.aliases.join('/')]),
			'a market added on one side only would split the route in two',
		)
	})
}

// ── Charms are shopped in their own market ──────────────────────────────────
group('Charm market (龙胜)')

// Compile the charm re-home out of shop.html, standing on the same parser block
// the page uses, so the test runs the shipped logic rather than a copy.
const charmLoc = (() => {
	const stallBlock = extract('public/shop.html', START, END)
	const charmBlock = extract('public/shop.html', '// ══ CHARM LOCATION ══', '// ══ END CHARM LOCATION ══')
	return new Function(`${stallBlock}\n${charmBlock}\nreturn charmLoc`)()
})()

test('a bare charm code is shopped in 龙胜, not the home case/grip market', () => {
	const loc = charmLoc('2C666')
	assert.strictEqual(loc.buildingId, 'longsheng')
	assert.strictEqual(loc.buildingLabel.zh, '龙胜')
	assert.strictEqual(loc.isHome, false)
	assert.strictEqual(loc.code, '2C666', 'the booth code is untouched')
	assert.strictEqual(loc.floor, 2, 'and so is the floor')
})

test('a charm stall that names another market keeps it', () => {
	assert.strictEqual(charmLoc('康乐北区4D32').buildingId, 'kangle-north')
	assert.strictEqual(charmLoc('太平洋1B111').buildingId, 'taipingyang')
})

test('a charm with no stall stays unlocated', () => {
	const loc = charmLoc('')
	assert.strictEqual(loc.located, false)
	assert.strictEqual(loc.buildingId, '')
})

test('龙胜 sorts after the case/grip markets, since its leg is walked last', () => {
	const key = (loc) => `${String(loc.buildingOrder).padStart(4, '0')}\x00${loc.buildingId}`
	assert.ok(key(charmLoc('康乐北区4D32')) < key(charmLoc('2C666')))
	assert.ok(key(server.parseStall('汇通A146')) < key(charmLoc('2C666')))
	assert.ok(key(charmLoc('2C666')) < key(server.parseStall('新市场B12')), 'but still ahead of unknown markets')
})

// ── The Overview tree, run from the shipped source ──────────────────────────
group('Overview tree')

/**
 * The collaborators a render block reads, stubbed at the Chinese locale. Only
 * what the block actually touches is supplied, so a block that grows a new
 * dependency fails loudly here instead of silently rendering something else.
 */
function stubs(LAST_GROUPS) {
	return {
		LAST_GROUPS,
		UNKNOWN_FLOOR: server.UNKNOWN_FLOOR,
		groupRemaining: (g) => g.remaining,
		buildingLabel: (loc) => loc.buildingLabel.zh || '其他',
		floorLabel: (n) => `${n}楼`,
		esc: (s) => String(s),
		t: (k) => ({ secCG: '手机壳 / 支架', secCharm: '挂件', otherFloor: '其他', supplierNotSet: '未匹配供应商', charmNotSet: '未设置' }[k] || k),
	}
}

/** Compile one sentinel-delimited block of shop.html against those stubs. */
function compileBlock(start, end, exports, groups) {
	const src = extract('public/shop.html', start, end)
	const deps = stubs(groups)
	return new Function(...Object.keys(deps), `${src}\nreturn { ${exports.join(', ')} }`)(...Object.values(deps))
}

/**
 * Compile the drawer's tree builder out of shop.html and run it against stub
 * groups, so the test exercises the real grouping rather than a copy of it.
 */
function makeTree(groups) {
	const api = compileBlock('// ══ ROUTE TREE ══', '// ══ END ROUTE TREE ══', ['buildTree', 'treeNodeHtml', 'treeCollapsed', 'treeExpanded', 'treeNodeCollapsed'], groups)
	return { ...api, tree: api.buildTree() }
}

/** The same, for the market dividers that open each leg of the route list. */
function makeList(groups) {
	return compileBlock('// ══ ROUTE LIST ══', '// ══ END ROUTE LIST ══', ['buildingLegRemaining', 'buildingDividerHtml'], groups)
}

/**
 * A rendered stop, as render() hands it to the tree. Charm stops arrive already
 * re-homed to 龙胜 (render() calls charmLoc), so the fixture mirrors that.
 */
const stop = (stall, shop, remaining, section = 'cg') => ({ loc: section === 'charm' ? charmLoc(stall) : server.parseStall(stall), stall, shop, section, remaining })

const ROUTE = [
	stop('A2-29', 'HAN', 3),
	stop('A2-33', '壳引力', 7),
	stop('5C26', 'inin', 1),
	stop('康乐北区5A40-42', '热点', 7),
	stop('太平洋1B111', '潮品汇', 1),
	stop('汇通A138-139', '塔下', 1),
	stop('汇通A146', 'leo', 2),
	stop('', '', 2),
	stop('2D21', '彩虹', 8, 'charm'),
	stop('2C666', '一乐潮品', 4, 'charm'),
]

test('stops are filed Section → Building → Floor → Stall', () => {
	const { tree } = makeTree(ROUTE)
	const cg = tree[0]
	assert.strictEqual(cg.type, 'section')
	assert.deepStrictEqual(
		cg.children.map((b) => [b.type, b.label]),
		[['building', '通信'], ['building', '康乐北区'], ['building', '太平洋'], ['building', '汇通'], ['building', '其他']],
		'markets appear in walking order, with the unlocated bucket last',
	)
	const tongxin = cg.children[0]
	assert.deepStrictEqual(tongxin.children.map((f) => f.label), ['2楼', '5楼'])
	assert.deepStrictEqual(tongxin.children[0].children.map((l) => `${l.label} ${l.sub}`), ['HAN A2-29', '壳引力 A2-33'])
})

test('the charm section files its stops under 龙胜, not 通信', () => {
	const { tree } = makeTree(ROUTE)
	const charm = tree[1]
	assert.strictEqual(charm.label, '挂件')
	assert.deepStrictEqual(charm.children.map((b) => b.label), ['龙胜'], 'charms are shopped in their own market')
	const floor = charm.children[0].children[0]
	assert.strictEqual(floor.label, '2楼')
	assert.deepStrictEqual(floor.children.map((l) => `${l.label} ${l.sub}`), ['彩虹 2D21', '一乐潮品 2C666'])
})

test('a market prefix is dropped from the leaf a shopper reads', () => {
	const { tree } = makeTree(ROUTE)
	const kangle = tree[0].children.find((b) => b.label === '康乐北区')
	assert.strictEqual(kangle.children[0].children[0].sub, '5A40-42', 'the booth is signed 5A40-42, not 康乐北区5A40-42')
})

test('stalls with no readable floor hang off their market directly', () => {
	// An "Other floor" node inside 汇通 would add a tap and say nothing: every
	// stall there is floor-unknown.
	const { tree } = makeTree(ROUTE)
	const huitong = tree[0].children.find((b) => b.label === '汇通')
	assert.deepStrictEqual(huitong.children.map((n) => n.type), ['leaf', 'leaf'])
	assert.deepStrictEqual(huitong.children.map((n) => n.label), ['塔下', 'leo'])
})

test('counts roll up from stalls to floors to markets to the section', () => {
	const { tree } = makeTree(ROUTE)
	const cg = tree[0]
	assert.strictEqual(cg.remaining, 3 + 7 + 1 + 1 + 7 + 1 + 2 + 2)
	const tongxin = cg.children[0]
	assert.strictEqual(tongxin.remaining, 11)
	assert.strictEqual(tongxin.children[0].remaining, 10, '2楼 = HAN 3 + 壳引力 7')
	assert.strictEqual(tree[1].remaining, 12, 'charms are their own section')
})

test('every leaf still points at the card it names', () => {
	const { tree } = makeTree(ROUTE)
	const leaves = []
	const walk = (n) => (n.type === 'leaf' ? leaves.push(n) : n.children.forEach(walk))
	tree.forEach(walk)
	assert.strictEqual(leaves.length, ROUTE.length, 'no stop may be lost in the tree')
	for (const leaf of leaves) {
		const g = ROUTE[leaf.gidx]
		assert.strictEqual(leaf.remaining, g.remaining)
		assert.strictEqual(leaf.label, g.shop || (g.section === 'charm' ? '未设置' : '未匹配供应商'))
	}
	assert.deepStrictEqual([...leaves].map((l) => l.gidx).sort((a, b) => a - b), ROUTE.map((_, i) => i))
})

test('the drawer opens on the markets alone, with nothing unfolded under them', () => {
	// A shopper opening the drawer wants the shape of the trip — which markets,
	// how much is left in each — not 30 stalls they have to scroll past.
	const { tree, treeNodeCollapsed } = makeTree(ROUTE)
	for (const sec of tree) {
		assert.strictEqual(treeNodeCollapsed(sec), false, `${sec.label} is open, so its markets are on screen`)
		for (const bld of sec.children) {
			assert.strictEqual(treeNodeCollapsed(bld), true, `${bld.label} starts folded`)
		}
	}
})

test('opening a market shows its floors and stalls in one tap', () => {
	const { tree, treeNodeCollapsed, treeExpanded } = makeTree(ROUTE)
	const tongxin = tree[0].children[0]
	treeExpanded.add(tongxin.id)
	assert.strictEqual(treeNodeCollapsed(tongxin), false)
	for (const floor of tongxin.children) {
		assert.strictEqual(treeNodeCollapsed(floor), false, 'no second tap to reach the stalls')
	}
})

test('a finished branch folds itself away, and a shopper can override either way', () => {
	const done = [stop('A2-29', 'HAN', 0), stop('5C26', 'inin', 2)]
	const { tree, treeNodeCollapsed, treeCollapsed, treeExpanded } = makeTree(done)
	const tongxin = tree[0].children[0]
	const [f2, f5] = tongxin.children
	assert.strictEqual(treeNodeCollapsed(f2), true, 'nothing left on 2楼 → out of the way')
	assert.strictEqual(treeNodeCollapsed(f5), false, 'still work on 5楼 → stays open')

	treeExpanded.add(f2.id)
	assert.strictEqual(treeNodeCollapsed(f2), false, 're-opening a finished floor sticks')
	treeCollapsed.add(f5.id)
	assert.strictEqual(treeNodeCollapsed(f5), true, 'folding an unfinished floor sticks too')
	treeExpanded.add(tongxin.id)
	assert.strictEqual(treeNodeCollapsed(tongxin), false, 'and a market a shopper opened stays open')
})

test('a market node renders its caret, name and count — and nothing else', () => {
	const { tree, treeNodeHtml } = makeTree(ROUTE)
	const html = treeNodeHtml(tree[0].children[0])
	assert.ok(html.includes('class="trow building"'), 'markets are their own row type')
	assert.ok(html.includes('data-toggle="sec:cg:bld:tongxin"'), 'and are collapsible by a stable id')
	assert.ok(html.includes('<span class="tcaret">▾</span>'))
	assert.ok(html.includes('>11</span>'))
	assert.ok(html.includes('data-gidx="0"'), 'leaves keep the index render() gave them')
	// The row is read at arm's length in a market aisle: market name, how much is
	// left, nothing competing with either.
	assert.ok(!html.includes('摊位'), 'no stall tally clutters the row')
})

test('a market with nothing left is badged with a tick instead of a count', () => {
	const { tree, treeNodeHtml } = makeTree([stop('太平洋1B111', '潮品汇', 0)])
	const html = treeNodeHtml(tree[0].children[0])
	assert.ok(html.includes('class="tnode bld collapsed"'))
	assert.ok(html.includes('tcount z'))
	assert.ok(html.includes('>✓</span>'))
})

// ── The route list, run from the shipped source ─────────────────────────────
group('Route list')

/** The class list on a rendered element, so two markets can be compared. */
const classOf = (html, tag) => (new RegExp(`<${tag} class="([^"]*)"`).exec(html) || [, ''])[1]

test('every market is announced in exactly the same way', () => {
	// The regression this guards: the home market used to be drawn in the body
	// colour with a grey rule while every other market got the place colour, so
	// two legs of one trip looked like two different kinds of thing.
	// Rendered as the first stop of its own route, so the two differ by nothing
	// but the market they name.
	const divider = (stall) => {
		const groups = [stop(stall, 'HAN', 3)]
		return makeList(groups).buildingDividerHtml(groups[0], 0)
	}
	const home = divider('A2-29')
	const away = divider('经济5D91')
	assert.strictEqual(classOf(home, 'div'), 'bdiv', 'no per-market modifier')
	assert.strictEqual(
		home.replace('通信', '·'),
		away.replace('经济', '·'),
		'only the name may differ between two markets',
	)
})

test('a milestone carries a market name and what is left there — nothing else', () => {
	const groups = [stop('汇通A138-139', '塔下', 1), stop('汇通A146', 'leo', 2)]
	const html = makeList(groups).buildingDividerHtml(groups[0], 0)
	assert.ok(html.includes('<span class="bname">汇通</span>'))
	assert.ok(html.includes('<span class="bcount">3</span>'), 'the count spans the whole leg, not one stall')
	assert.ok(!/摊位|stall/i.test(html), 'the stall tally is gone')
	assert.strictEqual((html.match(/<span/g) || []).length, 2, 'a name and a count, and no third thing')
})

test('the leg count stops at the next market and at the next section', () => {
	const groups = [
		stop('A2-29', 'HAN', 3),
		stop('5C26', 'inin', 1),
		stop('经济5D91', '鼎火火', 4),
		stop('2C666', '一乐潮品', 9, 'charm'),
	]
	const { buildingLegRemaining } = makeList(groups)
	assert.strictEqual(buildingLegRemaining(0), 4, '通信 is two stalls, both counted')
	assert.strictEqual(buildingLegRemaining(2), 4, 'and 经济 does not absorb them')
	assert.strictEqual(buildingLegRemaining(3), 9, 'a section boundary ends a leg')
})

test('a market the shopper has finished is ticked off', () => {
	const groups = [stop('太平洋1B111', '潮品汇', 0)]
	const html = makeList(groups).buildingDividerHtml(groups[0], 0)
	assert.ok(html.includes('<span class="bcount done">✓</span>'))
})

test('a stall header states the shop and the booth code, and nowhere else', () => {
	// The market belongs to the divider that opens the leg, and it is said once
	// there. A shopper walking one market at a time is already standing in the
	// building a per-shop chip would name, so repeating it above every stall was
	// noise between them and the two things they actually read to find the booth.
	const source = fs.readFileSync(path.resolve(__dirname, '..', 'public/shop.html'), 'utf8')
	assert.ok(!/class="floor/.test(source), 'a location chip is back on the stall headers')
	assert.ok(!/areaChipHtml/.test(source), 'and the renderer that built it is back too')
	const heads = source.match(/<div class="ghead[\s\S]*?<\/div>/g) || []
	assert.ok(heads.length >= 2, 'the stall headers should still be found in the source')
	for (const head of heads) {
		assert.ok(head.includes('<span class="shop">'), 'a header still names its shop')
		assert.ok(!head.includes('floor'), 'and carries no floor or market chip')
	}
})

test('a stop with no stall code is filed under a market of its own', () => {
	const groups = [stop('', '', 2)]
	const html = makeList(groups).buildingDividerHtml(groups[0], 0)
	assert.strictEqual(classOf(html, 'div'), 'bdiv none')
	assert.ok(html.includes('<span class="bname">其他</span>'))
})

// ── Runner ──────────────────────────────────────────────────────────────────
console.log(`\n${BOLD}Stall locations — buildings, floors and walking order${RESET}\n`)
for (const item of queue) {
	if (item.group) {
		console.log(`${DIM}${item.group}${RESET}`)
		continue
	}
	try {
		item.fn()
		passed++
		console.log(`  ${GREEN}✓${RESET} ${item.name}`)
	} catch (err) {
		failed++
		failures.push({ name: item.name, err })
		console.log(`  ${RED}✗${RESET} ${item.name}`)
	}
}
if (failures.length) {
	console.log(`\n${RED}${BOLD}Failures${RESET}`)
	for (const f of failures) console.log(`\n  ${RED}${f.name}${RESET}\n  ${f.err.message.split('\n').join('\n  ')}`)
}
console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)
