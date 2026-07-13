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
 * when catalog data uses one unit of a combined stall, e.g. A279 or A280 while
 * the floor plan records A279-280. Short hyphenated codes such as A2-21 are unit
 * codes, not ranges, and are intentionally left untouched.
 */
function stallCodeAliases(code) {
	const normalized = normalizeStallCode(code)
	if (!normalized) return []
	const out = new Set([normalized])
	const match = /^([A-Z]+)(\d{3,})-(\d{3,})$/.exec(normalized)
	if (match) {
		const start = Number(match[2])
		const end = Number(match[3])
		if (end >= start && end - start <= 20) {
			for (let value = start; value <= end; value++) out.add(`${match[1]}${value}`)
		}
	}
	return [...out]
}

module.exports = { FLOOR_MAPS, normalizeStallCode, stallCodeAliases }
