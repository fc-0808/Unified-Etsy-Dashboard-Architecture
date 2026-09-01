'use strict'

/**
 * Where a supplier stall physically IS — the one place that answers it.
 *
 * Sourcing no longer happens in a single market. A stall code carries its
 * building as a prefix when it sits outside the home market, e.g.
 *
 *   A2-29             → home market, 2F, stall A2-29
 *   5C26              → home market, 5F, stall 5C26
 *   太平洋1B111        → Taipingyang, 1F, stall 1B111
 *   康乐北区5A40-42    → Kangle North, 5F, stall 5A40-42
 *   汇通A138-139       → Huitong, floor unknown, stall A138-139
 *
 * Parsing that prefix is what lets every view group a shopping route the way a
 * shopper actually walks it: finish one BUILDING, then the next — rather than
 * bouncing between markets because two unrelated stalls happen to share a floor
 * number. Before this, "5楼" mixed the home market's 5C26 with 康乐北区5A40-42
 * and 经济5D91, which are a taxi ride apart.
 *
 * Contract notes for anyone extending this:
 *
 *   • `stallFloor()` keeps its historical contract exactly — a floor number, or
 *     999 when it can't be read. The only behavioural change is that the floor
 *     is now read from the code AFTER the building prefix is stripped, which
 *     recovers floors that used to be lost (e.g. 通信518 → 5, previously 999).
 *   • Floor rules are deliberately NOT generalised beyond the home market's
 *     scheme. Inventing a floor for a numbering system we haven't surveyed
 *     (汇通A138) would send a shopper to the wrong storey; leaving it unknown
 *     just lists the stall at the end of its building, which is honest.
 *   • BUILDINGS[].order is the walking order of the trip. It is the single knob
 *     to turn when the route between markets changes.
 *
 * Mirrored, character for character in behaviour, by:
 *   • public/shop.html  (Shopping Mode — the phone route)
 *   • public/index.html (`_pmStallFloor` — the desktop product-map catalog)
 *   • route-engine/src/generate_shopping_route.py (`_stall_floor`)
 * `scripts/test-stall-location.js` fails the build if the shop.html mirror ever
 * drifts from this file.
 */

/**
 * The market the 2F / 5F floor plans in floor-map.js were surveyed in, and the
 * one a bare stall code (A2-29, 5C26) belongs to. Stalls there are recorded
 * without a prefix because, historically, it was the only place we bought from.
 */
const HOME_BUILDING_ID = 'tongxin'

/**
 * Buildings we shop, in walking order. `aliases` are the prefixes actually
 * typed into the catalog — list every spelling in use; the longest match wins,
 * so '康乐北区' can never be swallowed by '康乐'.
 */
const BUILDINGS = [
	{ id: 'jingji',       order: 10, label: { en: 'Jingji',       zh: '经济'     }, aliases: ['经济'] },
	{ id: 'tongxin',      order: 20, label: { en: 'Tongxin',      zh: '通信'     }, aliases: ['通信', '通信城', '通信市场'] },
	{ id: 'kangle-north', order: 30, label: { en: 'Kangle North', zh: '康乐北区' }, aliases: ['康乐北区', '康乐北'] },
	// 康乐 is the same complex as 康乐北区, so it stays pinned beside it whatever
	// the rest of the route does.
	{ id: 'kangle',       order: 31, label: { en: 'Kangle',       zh: '康乐'     }, aliases: ['康乐'] },
	{ id: 'taipingyang',  order: 40, label: { en: 'Taipingyang',  zh: '太平洋'   }, aliases: ['太平洋'] },
	{ id: 'huitong',      order: 50, label: { en: 'Huitong',      zh: '汇通'     }, aliases: ['汇通'] },
	// The charm market. Its stalls are recorded with bare codes just like the
	// home case/grip market, so it has no prefix to parse — it is only ever
	// reached by the charm re-home in Shopping Mode (see shop.html `charmLoc`),
	// which is why its alias list is empty. It sits last because the charm leg of
	// the trip is walked after the cases and grips.
	{ id: 'longsheng',    order: 60, label: { en: 'Longsheng',    zh: '龙胜'     }, aliases: [] },
]

/** A market we haven't registered yet, named by whatever prefix was typed. */
const UNREGISTERED_ORDER = 9000
/** No stall code at all — nothing to walk to, so it sorts dead last. */
const UNLOCATED_ORDER = 9999
/** Floor sentinel kept from the original `stallFloor` contract. */
const UNKNOWN_FLOOR = 999

/**
 * Codes that mean "not recorded". Tested after normalisation, so every dash
 * spelling the catalog has ever held collapses onto '-'.
 */
const PLACEHOLDER_CODES = new Set(['-', '???'])

/**
 * Alias → building, longest first, so a longer market name is always preferred
 * over a shorter one that prefixes it.
 */
const ALIAS_INDEX = BUILDINGS
	.flatMap((b) => b.aliases.map((alias) => ({ alias, upper: alias.toUpperCase(), building: b })))
	.sort((a, b) => b.alias.length - a.alias.length)

const BUILDING_BY_ID = new Map(BUILDINGS.map((b) => [b.id, b]))

/**
 * Normalise a raw catalog value for parsing: full-width digits and letters
 * (Ａ２-２９) are folded to ASCII so they match the same rules, and the exotic
 * dashes people paste are folded to '-'.
 * @param {*} stall
 * @returns {string}
 */
function normalizeStall(stall) {
	return String(stall == null ? '' : stall)
		.normalize('NFKC')
		.replace(/[–—―]/g, '-')
		.trim()
}

/**
 * Floor number from a stall code that has already had its building prefix
 * stripped. These are the home market's rules, unchanged since OSP.
 * @param {string} code
 * @returns {number} floor, or 999 when unreadable
 */
function floorFromCode(code) {
	if (!code) return UNKNOWN_FLOOR
	if (/^A2/i.test(code)) return 2 // the A block is 2F, whatever the digits say
	let m = /^(\d)/.exec(code)
	if (m) return Number(m[1])
	m = /(\d)[A-Za-z]/.exec(code)
	if (m) return Number(m[1])
	return UNKNOWN_FLOOR
}

/**
 * Split a stall code into the building it belongs to and the code within that
 * building.
 *
 * A recognised prefix wins. Failing that, a leading run of non-ASCII characters
 * is treated as an unregistered market and becomes a building of its own — so
 * the first time someone types a new market it shows up as its own stop on the
 * route instead of silently polluting the home market. Anything else is the
 * home market, which is how bare codes have always been recorded.
 *
 * @param {*} stall raw catalog value
 * @returns {{buildingId:string, buildingOrder:number, buildingLabel:{en:string,zh:string},
 *           isHome:boolean, registered:boolean, located:boolean,
 *           code:string, floor:number, raw:string}}
 */
function parseStall(stall) {
	const raw = normalizeStall(stall)
	if (!raw || PLACEHOLDER_CODES.has(raw)) {
		return {
			buildingId: '',
			buildingOrder: UNLOCATED_ORDER,
			buildingLabel: { en: '', zh: '' },
			isHome: false,
			registered: false,
			located: false,
			code: '',
			floor: UNKNOWN_FLOOR,
			raw,
		}
	}

	// Compared slice-wise rather than via startsWith on an uppercased copy: a
	// case fold can change a string's length, and the offset we slice at has to
	// stay an index into `raw`.
	const hit = ALIAS_INDEX.find((a) => raw.slice(0, a.alias.length).toUpperCase() === a.upper)
	if (hit) return located(hit.building, hit.building.order, raw.slice(hit.alias.length).trim(), raw, true)

	const foreign = /^([^\x00-\x7F]+)/.exec(raw)
	if (foreign) {
		const name = foreign[1].trim()
		return located(
			{ id: 'x:' + name, label: { en: name, zh: name } },
			UNREGISTERED_ORDER,
			raw.slice(foreign[1].length).trim(),
			raw,
			false,
		)
	}

	const home = BUILDING_BY_ID.get(HOME_BUILDING_ID)
	return located(home, home.order, raw, raw, true)
}

function located(building, order, code, raw, registered) {
	return {
		buildingId: building.id,
		buildingOrder: order,
		buildingLabel: building.label,
		isHome: building.id === HOME_BUILDING_ID,
		registered,
		located: true,
		code,
		floor: floorFromCode(code),
		raw,
	}
}

/**
 * Floor number parsed from a stall code — the historical entry point, kept so
 * every existing caller keeps working.
 * @param {*} stall
 * @returns {number} floor, or 999 when unreadable
 */
function stallFloor(stall) {
	return parseStall(stall).floor
}

/** Unknown floors sort after every real one, never before floor 0. */
function floorSortValue(floor) {
	return floor != null && floor !== UNKNOWN_FLOOR && floor !== '' ? Number(floor) : 9999
}

/**
 * The order a shopper walks the route: building, then floor, then stall code,
 * then shop name as a stable tiebreak. Every view sorts on this string so the
 * phone, the desktop table and the Excel export agree on the sequence.
 *
 * @param {*} stall
 * @param {*} shop
 * @returns {string} comparable with plain < / > (code-unit order, so Chinese
 *                   shop names sort identically everywhere)
 */
function locationSortKey(stall, shop) {
	const loc = parseStall(stall)
	return [
		String(loc.buildingOrder).padStart(4, '0'),
		loc.buildingId, // keeps unregistered markets apart at the same order
		String(floorSortValue(loc.floor)).padStart(4, '0'),
		loc.code.toLowerCase(),
		String(shop == null ? '' : shop).trim().toLowerCase(),
	].join('\x00')
}

/**
 * Identity for ONE supplier booth — the shop plus the stall that distinguishes
 * it from that shop's other booths.
 *
 * Folded the way operators actually mean it: letter case and NFKC/dash spelling
 * never invent a second booth for the same physical stop. So
 * `leo` + `汇通A146` and `Leo` + `汇通a146` are the same booth, and the
 * supplier picker / directory CRUD treat them as one — without this, an order
 * assigned with a differently-cased stall shows up as a greyed-out "ext" twin
 * that Manage cannot delete (it is not a directory row).
 *
 * @param {*} shop
 * @param {*} stall
 * @returns {string}
 */
function supplierIdentityKey(shop, stall) {
	const s = String(shop == null ? '' : shop)
		.trim()
		.replace(/\s+/g, ' ')
		.toLowerCase()
	const t = normalizeStall(stall).toLowerCase()
	return `${s}\x00${t}`
}

module.exports = {
	HOME_BUILDING_ID,
	BUILDINGS,
	UNKNOWN_FLOOR,
	UNLOCATED_ORDER,
	UNREGISTERED_ORDER,
	normalizeStall,
	parseStall,
	stallFloor,
	floorSortValue,
	locationSortKey,
	supplierIdentityKey,
}
