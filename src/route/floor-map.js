'use strict'

/**
 * Physical floor layout of the supplier mall, recorded on-site. Powers the
 * in-person "Map" view in Shopping Mode so a shopper can locate the stalls they
 * need to visit and walk them in order.
 *
 * This is REFERENCE data (positions / walking order). Live shop names are looked
 * up from supplier_directory by stall code when available, falling back to the
 * name recorded here — so the map stays in sync with the catalog automatically.
 *
 * Structure:
 *   floors → corridors (physical aisles, left→right)
 *     → sides (the two faces of an aisle: 'a' = one side, 'b' = the other)
 *       → blocks (a run of stalls, broken where a cross-corridor lets you walk
 *                 through — rendered as a gap)
 *         → stalls ({ code, name? })
 *
 * A stall WITHOUT a name is one we don't usually shop at; it's shown faint, for
 * orientation only. Codes are transcribed exactly as recorded on-site.
 */

const FLOOR_MAPS = [
	{
		mall: '',
		floor: 2,
		label: { en: '2F', zh: '2楼' },
		// Landmarks live in the central walkway between the two corridors. The
		// elevator sits at the near (bottom) end, between A275 (左b) and A2-21 (右a).
		landmarks: [{ type: 'elevator', label: { en: 'Elevator', zh: '电梯' }, at: 'center-bottom' }],
		corridors: [
			{
				id: 'left',
				label: { en: 'Left corridor', zh: '左走廊' },
				sides: [
					{
						id: '左a',
						label: '左a',
						blocks: [
							[{ code: 'A201-202' }, { code: 'A203' }, { code: 'A203A', name: '鼎基' }, { code: 'A204A-2', name: 'nnn.' }, { code: 'A204A' }, { code: 'A205A' }, { code: 'A205', name: '鑫宣' }],
							[
								{ code: 'A207', name: 'KK' },
								{ code: 'A208', name: '洽洽' },
								{ code: 'A209', name: '舒克' },
								{ code: 'A210', name: '兴发' },
								{ code: 'A211', name: '鲸喜' },
							],
							[
								{ code: 'A212', name: '幼儿园' },
								{ code: 'A213', name: '有糖' },
								{ code: 'A217', name: 'xx' },
								{ code: 'A215', name: '喜壳' },
							],
							[{ code: 'A2008', name: '女同学' }],
							[{ code: 'A253', name: 'M' }],
							// End cap: a horizontal row of shops beyond the last cross-corridor.
							[{ code: 'A220', name: '三馬' }],
						],
					},
					{
						id: '左b',
						label: '左b',
						blocks: [
							[{ code: 'A275' }, { code: 'A276' }, { code: 'A278', name: '兔兔' }, { code: 'A279-280', name: '鑫明诺' }, { code: 'A281', name: 'JL 俊琳' }, { code: 'A282', name: '飓风' }],
							[{ code: 'A285', name: '亦森' }, { code: 'A286' }, { code: 'A288-289' }, { code: 'A290', name: 'MY' }],
							[{ code: 'A262-263', name: '艾雅饰' }, { code: 'A261' }, { code: 'A260', name: '麦加' }, { code: 'A258' }, { code: 'A258A', name: 'PP' }, { code: 'A257', name: '平川' }, { code: 'A2006', name: '马萨米' }],
							// End cap: horizontal row beyond the last cross-corridor.
							[{ code: 'A220A', name: 'NICE耐思' }],
						],
					},
				],
			},
			{
				id: 'right',
				label: { en: 'Right corridor', zh: '右走廊' },
				sides: [
					{
						id: '右a',
						label: '右a',
						blocks: [
							[{ code: 'A2-21' }],
							[{ code: 'A275' }, { code: 'A256' }, { code: 'A2-29' }, { code: 'A2-30' }],
							[{ code: 'A2-32' }, { code: 'A2-33', name: '壳引力' }, { code: 'A2-35' }, { code: 'A2-36', name: '33' }],
							[{ code: 'A295', name: 'MJ' }, { code: 'A265', name: '半橙' }, { code: 'A266', name: '13' }, { code: 'A267', name: '芝士' }, { code: 'A269-270' }, { code: 'A270A' }, { code: 'A2006' }],
							// End cap: horizontal row beyond the last cross-corridor.
							[{ code: 'A222', name: 'Domi' }],
						],
					},
					{
						id: '右b',
						label: '右b',
						blocks: [
							[{ code: 'A248' }, { code: 'A247', name: 'HA HA HA' }, { code: 'A245' }, { code: 'A244' }, { code: 'A243' }, { code: 'A242' }, { code: 'A240' }, { code: 'A2-16' }, { code: 'A239', name: '328' }, { code: 'A238', name: '勤立' }, { code: 'A237', name: '卷卷' }, { code: 'A236B' }, { code: 'A236' }, { code: 'A235' }, { code: 'A233', name: '麦麦' }, { code: 'A232', name: '財神' }, { code: 'A231' }, { code: 'A230' }, { code: 'A228-229' }, { code: 'A225-227' }],
							// End cap: horizontal row beyond the last cross-corridor.
							[{ code: 'A223', name: '虎山' }],
						],
					},
				],
			},
		],
	},
	{
		mall: '',
		floor: 5,
		label: { en: '5F', zh: '5楼' },
		// The elevator core is vertically aligned across the building, so it sits in
		// the same central-walkway position as on 2F.
		landmarks: [{ type: 'elevator', label: { en: 'Elevator', zh: '电梯' }, at: 'center-bottom' }],
		// 5F is transcribed in on-site reading order (first stall = TOP of screen).
		// The renderer flips each side vertically, so we store the reverse of the
		// desired display: the last stall listed here (e.g. 5B39) shows at the
		// bottom and the first (5B01) at the top.
		corridors: [
			{
				id: 'left',
				label: { en: 'Left corridor', zh: '左走廊' },
				sides: [
					{
						id: '左a',
						label: '左a',
						blocks: [
							[
								{ code: '5B39' },
								{ code: '5B38', name: '起货' },
								{ code: '5B37' },
								{ code: '5B36' },
								{ code: '5B35' },
								{ code: '5B33' },
								{ code: '5B31-32', name: 'kiki' },
								{ code: '5B29-30' },
								{ code: '5B28' },
								{ code: '5B27' },
								{ code: '5B26' },
								{ code: '5B25' },
								{ code: '5B23' },
								{ code: '5B21-22' },
								{ code: '5B20' },
								{ code: '5B19', name: '九九' },
								{ code: '5B18' },
								{ code: '5B17', name: '优加' },
								{ code: '5B16', name: '连家' },
								{ code: '5B15' },
								{ code: '5B13', name: '热麦' },
								{ code: '5B11-12', name: '火曼树' },
							],
							[{ code: '5B02-03', name: '安邦仕' }, { code: '5B01' }],
						],
					},
					{
						id: '左b',
						label: '左b',
						blocks: [
							[{ code: '5C32' }, { code: '5C33' }, { code: '5C35' }, { code: '5C36' }, { code: '5C37' }, { code: '5C38' }],
							[{ code: '5C39' }, { code: '5C51', name: '小五' }, { code: '5C52' }, { code: '5C53' }, { code: '5C55', name: 'BOM' }, { code: '5C56' }],
							[{ code: '5C57' }, { code: '5C58' }, { code: '5C59' }, { code: '5C61', name: '元气' }, { code: '5C63', name: 'BF' }],
							[{ code: '5C65' }, { code: '5C66' }, { code: '5C67', name: 'zz' }, { code: '5C68' }, { code: '5C70' }, { code: '5C71-72' }],
						],
					},
				],
			},
			{
				id: 'right',
				label: { en: 'Right corridor', zh: '右走廊' },
				sides: [
					{
						id: '右a',
						label: '右a',
						blocks: [
							[{ code: '5C31' }, { code: '5C30' }, { code: '5C29' }, { code: '5C28' }, { code: '5C27' }, { code: '5C26', name: 'inin' }],
							[{ code: '5C25', name: '已清' }, { code: '5C23' }, { code: '5C22' }, { code: '5C21', name: 'yk优壳' }, { code: '5C20', name: 'yk98' }, { code: '5C19' }, { code: '5C18' }],
							[{ code: '5C17' }, { code: '5C16' }, { code: '5C15', name: '超有铭' }, { code: '5C13', name: '小诗妹' }, { code: '5C11' }, { code: '5C10' }],
							[{ code: '5C09', name: 'V8' }, { code: '5C08' }, { code: '5C03-07', name: '凡品' }, { code: '5C02' }, { code: '5C01' }],
						],
					},
					{
						id: '右b',
						label: '右b',
						blocks: [
							[
								{ code: '5A31', name: '橙小姐' },
								{ code: '5A29' },
								{ code: '5A28' },
								{ code: '5A27' },
								{ code: '5A26' },
								{ code: '5A25' },
								{ code: '5A22-23', name: 'Timi' },
								{ code: '5A21' },
								{ code: '5A20' },
								{ code: '5A19' },
								{ code: '5A18', name: 'Gaga' },
								{ code: '5A17', name: '新星' },
								{ code: '5A16' },
								{ code: '5A15' },
								{ code: '5A13', name: '唯爆' },
								{ code: '5A12', name: '大柿禧' },
								{ code: '5A11' },
								{ code: '5A10', name: '圆圆' },
								{ code: '5A09' },
								{ code: '5A06-07' },
								{ code: '5A05', name: '米缇' },
								{ code: '5A03' },
							],
						],
					},
				],
			},
		],
	},
]

/**
 * Normalise a stall code so the live route stall and the map stall match
 * regardless of casing / spaces / dash style.
 * @param {string} code
 * @returns {string}
 */
function normalizeStallCode(code) {
	return String(code || '')
		.trim()
		.toUpperCase()
		.replace(/\s+/g, '')
		.replace(/[–—]/g, '-')
}

/**
 * Return all equivalent codes for a physical stall/range. This fixes map links
 * when catalog data uses one unit of a combined stall, e.g. A279 (or A280) while
 * the floor plan records A279-280, or 5B31 while the plan records 5B31-32.
 *
 * A code expands only when the two numbers share the same width and span a small
 * range — so genuine merged stalls (A279-280, 5B31-32, 5C03-07) expand, while
 * single-unit codes whose numbers differ in width (A2-21, A2-16) are left as-is.
 */
function stallCodeAliases(code) {
	const normalized = normalizeStallCode(code)
	if (!normalized) return []
	const out = new Set([normalized])
	// Prefix is letters, optionally led by a floor digit (A…, 5B…, 5C…).
	const match = /^([0-9]*[A-Z]+)(\d+)-(\d+)$/.exec(normalized)
	if (match) {
		const [, prefix, startStr, endStr] = match
		const start = Number(startStr)
		const end = Number(endStr)
		if (startStr.length === endStr.length && end >= start && end - start <= 20) {
			for (let value = start; value <= end; value++) out.add(`${prefix}${String(value).padStart(startStr.length, '0')}`)
		}
	}
	return [...out]
}

module.exports = { FLOOR_MAPS, normalizeStallCode, stallCodeAliases }
