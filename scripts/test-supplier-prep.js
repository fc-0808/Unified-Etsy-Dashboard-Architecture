'use strict'
/**
 * Tests for the supplier WeChat prep-list builder (public/shop-supplier-prep.js).
 *
 * Pins the contract that Shopping Mode uses when an employee taps "发给供应商":
 *   · Only Pending units appear (Purchased / OOS are not a prepare ask).
 *   · Cases group by phone model; grips / integral charms are model-agnostic.
 *   · Sourced charms at the same stall are included with code + qty.
 *   · Exchanges are never part of the payload (swaps ≠ purchases).
 *   · Output labels stay Simplified Chinese for market staff on WeChat.
 *   · Phone cases are 手机壳; AirPods cases are 耳机壳 (item line and 合计).
 *   · Prep photos letterbox (contain) so charms and dangling beads are whole.
 *   · Text fallback stays readable without photos.
 *
 * Run: `node scripts/test-supplier-prep.js`
 */

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const Prep = require('../public/shop-supplier-prep')

const GREEN = '\x1b[32m',
	RED = '\x1b[31m',
	BOLD = '\x1b[1m',
	RESET = '\x1b[0m'
let passed = 0,
	failed = 0

function check(name, cond, detail) {
	if (cond) {
		passed++
		console.log(`  ${GREEN}✓${RESET} ${name}`)
	} else {
		failed++
		console.log(`  ${RED}✗ ${name}${RESET}${detail ? ' — ' + detail : ''}`)
	}
}

function eq(actual, expected, name) {
	try {
		assert.deepStrictEqual(actual, expected)
		check(name, true)
	} catch (err) {
		check(name, false, err.message)
	}
}

console.log(`\n${BOLD}Supplier prep list${RESET}\n`)

// ── Cases + grips at one stall ───────────────────────────────────────────────
{
	const group = {
		section: 'cg',
		shop: 'leo',
		stall: '汇通A146',
		loc: { code: 'A146', buildingLabel: { zh: '汇通', en: 'Huitong' } },
		rows: [
			{
				product_key: 'p:pink-bear',
				title: 'Pink Bear Case',
				phone_model: 'iPhone 14/13',
				image_url: '/api/route/listing-image/1?w=300',
				has_case: true,
				has_grip: true,
				quantity: 1,
				status_case: 'Pending',
				status_grip: 'Pending',
			},
			{
				product_key: 'p:pink-bear',
				title: 'Pink Bear Case',
				phone_model: 'iPhone 15',
				image_url: '/api/route/listing-image/1?w=300',
				has_case: true,
				has_grip: false,
				quantity: 2,
				status_case: 'Pending',
			},
			{
				product_key: 'p:mint',
				title: 'Mint Case',
				phone_model: 'iPhone 17 Pro Max',
				image_url: '/api/route/listing-image/2?w=300',
				has_case: true,
				has_grip: true,
				quantity: 2,
				status_case: 'Out of Stock',
				status_grip: 'Purchased',
			},
			{
				product_key: 'p:bought',
				title: 'Already Bought',
				phone_model: 'iPhone 16',
				image_url: '/api/route/listing-image/3?w=300',
				has_case: true,
				quantity: 1,
				status_case: 'Purchased',
			},
		],
		charmAggs: [
			{
				charm_code: 'B88',
				charm_image_version: 'v1',
				qty: 3,
				rows: [
					{ charm_code: 'B88', quantity: 2, status_charm: 'Pending' },
					{ charm_code: 'B88', quantity: 1, status_charm: 'Purchased' },
				],
			},
		],
		exRows: [{ exchange_id: 'x1', have_model: 'iPhone 13', need_model: 'iPhone 14' }],
	}

	const prep = Prep.buildSupplierPrep(group, {
		buildingLabel: '汇通',
		stallCode: 'A146',
		date: '2026-08-25',
		charmImageUrl: (code, v) => `/api/route/charm-image?code=${code}&v=${v}`,
	})

	check('not empty when pending work remains', !prep.empty)
	eq(prep.title, '备货清单', 'Chinese title')
	eq(prep.shop, 'leo', 'shop name')
	eq(prep.stall, 'A146', 'stall code without market prefix')
	eq(prep.building, '汇通', 'building label ZH')
	eq(prep.date, '2026-08-25', 'date stamp')
	check('filename is WeChat-safe PNG', /^备货-leo-汇通A146-2026-08-25\.png$/.test(prep.filename), prep.filename)
	check('includes pending and out-of-stock products; fully purchased excluded', prep.products.length === 2)
	const pink = prep.products.find((p) => p.lines.some((ln) => ln.model === 'iPhone 14/13'))
	check('pending product card present', !!pink)
	eq(pink.imageUrl, '/api/route/listing-image/1?w=960', 'product image uses sharp export width')
	eq(
		pink.lines,
		[
			{ kind: 'case', family: 'iphone', label: '手机壳', model: 'iPhone 15', qty: 2 },
			{ kind: 'case', family: 'iphone', label: '手机壳', model: 'iPhone 14/13', qty: 1 },
			{ kind: 'grip', label: '支架', model: null, qty: 1 },
		],
		'case models newest-first + grip batch',
	)
	eq(pink.fit, 'contain', 'product card letterboxes the listing photo')
	const mint = prep.products.find((p) => p.lines.some((ln) => ln.model === 'iPhone 17 Pro Max'))
	check('out-of-stock case included on prep sheet', !!mint)
	eq(
		mint && mint.lines.find((ln) => ln.model === 'iPhone 17 Pro Max'),
		{ kind: 'case', family: 'iphone', label: '手机壳', model: 'iPhone 17 Pro Max', qty: 2 },
		'OOS case listed like any other line',
	)
	eq(
		prep.charms,
		[{ imageUrl: '/api/route/charm-image?code=B88&v=v1', code: 'B88', qty: 2, fit: 'contain' }],
		'non-purchased charm qty only',
	)
	eq(prep.totals, { case: 5, airpods: 0, ipad: 0, watch: 0, grip: 1, charm: 2, items: 3 }, 'component totals include OOS')
	check('exchanges never appear on the prep list', !JSON.stringify(prep).includes('exchange'))

	const text = Prep.prepToText(prep)
	check('text fallback names the stall', text.includes('汇通') && text.includes('A146') && text.includes('leo'))
	check('text lists OOS model without status tag', text.includes('iPhone 17 Pro Max') && !text.includes('缺货'))
	check('text lists charm code', text.includes('B88'))
	check('text asks supplier to prepare', text.includes('请提前备好'))
	check('phone-case 合计 uses 手机壳', /合计：手机壳 ×5/.test(text) && !text.includes('耳机壳'))
}

// ── Charm-only stall ─────────────────────────────────────────────────────────
{
	const prep = Prep.buildSupplierPrep(
		{
			section: 'charm',
			shop: '挂件王',
			stall: '龙胜B12',
			loc: { code: 'B12', buildingLabel: { zh: '龙胜' } },
			aggs: [
				{
					charm_code: 'C01',
					rows: [{ charm_code: 'C01', quantity: 4, status_charm: 'Pending' }],
				},
				{
					charm_code: 'C02',
					rows: [{ charm_code: 'C02', quantity: 1, status_charm: 'Purchased' }],
				},
			],
		},
		{ buildingLabel: '龙胜', stallCode: 'B12', date: new Date('2026-08-25T08:00:00Z') },
	)
	eq(prep.products.length, 0, 'charm stall has no product cards')
	eq(prep.charms.length, 1, 'purchased charm omitted')
	eq(prep.charms[0].code, 'C01', 'pending charm kept')
	eq(prep.charms[0].qty, 4, 'charm qty')
	eq(prep.totals.charm, 4, 'charm total')
}

// ── Integral (AirPods) charm shops with the case ─────────────────────────────
{
	const prep = Prep.buildSupplierPrep({
		section: 'cg',
		shop: 'AirStall',
		stall: '4A53',
		loc: { code: '4A53' },
		rows: [
			{
				product_key: 'p:air',
				title: 'AirPods Case',
				phone_model: 'AirPods 4',
				image_url: '/api/route/listing-image/9?w=300',
				has_case: true,
				has_charm: true,
				charm_integral: true,
				quantity: 1,
				status_case: 'Pending',
				status_charm: 'Pending',
			},
		],
		charmAggs: [],
	})
	eq(prep.products[0].lines.map((l) => l.kind), ['case', 'charm'], 'integral charm is a product line, not a sourced charm')
	eq(prep.products[0].lines[0], { kind: 'case', family: 'airpods', label: '耳机壳', model: 'AirPods 4', qty: 1 }, 'AirPods case is 耳机壳, not 手机壳')
	eq(prep.charms.length, 0, 'no sourced-charm card for integral')
	eq(prep.totals, { case: 0, airpods: 1, ipad: 0, watch: 0, grip: 0, charm: 1, items: 1 }, 'integral charm counted in totals; AirPods not lumped into 手机壳')
	const airText = Prep.prepToText(prep)
	check('text names 耳机壳 for the AirPods line', airText.includes('1. 耳机壳 AirPods 4 ×1'))
	check('合计 uses 耳机壳, not 手机壳, when there are no phone cases', /合计：耳机壳 ×1 · 挂件 ×1/.test(airText) && !/合计：手机壳 ×/.test(airText))
}

// ── Empty when everything is bought ──────────────────────────────────────────
{
	const prep = Prep.buildSupplierPrep({
		section: 'cg',
		shop: 'leo',
		stall: 'A146',
		loc: { code: 'A146' },
		rows: [
			{
				product_key: 'p:x',
				title: 'X',
				phone_model: 'iPhone 16',
				has_case: true,
				quantity: 1,
				status_case: 'Purchased',
			},
		],
		charmAggs: [],
	})
	check('empty when nothing pending', prep.empty)
	eq(Prep.prepToText(prep), '', 'no text for empty prep')
}

// ── Wrong-stall lines excluded ───────────────────────────────────────────────
{
	const prep = Prep.buildSupplierPrep({
		section: 'cg',
		shop: 'leo',
		stall: 'A146',
		loc: { code: 'A146' },
		rows: [
			{
				product_key: 'p:wrong',
				title: 'Wrong booth case',
				phone_model: 'iPhone 16',
				image_url: '/api/route/listing-image/9?w=300',
				has_case: true,
				quantity: 1,
				status_case: 'Wrong Stall',
			},
			{
				product_key: 'p:ok',
				title: 'Good case',
				phone_model: 'iPhone 15',
				image_url: '/api/route/listing-image/10?w=300',
				has_case: true,
				quantity: 1,
				status_case: 'Pending',
			},
		],
		charmAggs: [],
	})
	eq(prep.products.length, 1, 'wrong-stall product omitted')
	eq(prep.products[0].lines[0].model, 'iPhone 15', 'only the real stall ask remains')
	eq(prep.totals.case, 1, 'wrong-stall qty not counted')
	check('wrong stall never appears in text', !Prep.prepToText(prep).includes('iPhone 16'))
}

// ── Out-of-stock charms included ─────────────────────────────────────────────
{
	const prep = Prep.buildSupplierPrep({
		section: 'charm',
		shop: '挂件王',
		stall: 'B12',
		loc: { code: 'B12' },
		aggs: [
			{
				charm_code: 'Z99',
				rows: [{ charm_code: 'Z99', quantity: 2, status_charm: 'Out of Stock' }],
			},
		],
	})
	eq(prep.charms.length, 1, 'OOS charm on prep sheet')
	eq(prep.totals.charm, 2, 'OOS charm qty in totals')
}

// ── Sharp listing photos for export ───────────────────────────────────────────
{
	eq(
		Prep.upgradePrepImageUrl('/api/route/listing-image/42?w=300'),
		'/api/route/listing-image/42?w=960',
		'bump card thumbnail to export resolution',
	)
	eq(
		Prep.upgradePrepImageUrl('/api/route/listing-image/42'),
		'/api/route/listing-image/42?w=960',
		'add w= when missing',
	)
	eq(
		Prep.upgradePrepImageUrl('https://i.etsystatic.com/il_300x300.abc.jpg'),
		'https://i.etsystatic.com/il_794xN.abc.jpg',
		'Etsy CDN thumb upscaled',
	)
}

// ── Mixed stall: phone 手机壳 and AirPods 耳机壳 stay separate ────────────────
{
	const prep = Prep.buildSupplierPrep({
		section: 'cg',
		shop: 'MixedStall',
		stall: 'A1',
		loc: { code: 'A1' },
		rows: [
			{
				product_key: 'p:phone',
				title: 'Pink Bear Case',
				phone_model: 'iPhone 16',
				has_case: true,
				quantity: 5,
				status_case: 'Pending',
			},
			{
				product_key: 'p:air',
				title: 'Polka AirPods Case',
				phone_model: 'AirPods Pro 2',
				has_case: true,
				quantity: 5,
				status_case: 'Pending',
			},
		],
		charmAggs: [],
	})
	eq(prep.totals.case, 5, 'phone cases stay in 手机壳')
	eq(prep.totals.airpods, 5, 'AirPods cases are not added to 手机壳')
	const phoneLine = prep.products.find((p) => p.lines.some((ln) => ln.model === 'iPhone 16'))
	const airLine = prep.products.find((p) => p.lines.some((ln) => ln.model === 'AirPods Pro 2'))
	eq(phoneLine && phoneLine.lines[0].label, '手机壳', 'phone line uses 手机壳')
	eq(airLine && airLine.lines[0].label, '耳机壳', 'AirPods line uses 耳机壳')
	const text = Prep.prepToText(prep)
	check('item lines distinguish the two shells', text.includes('手机壳 iPhone 16 ×5') && text.includes('耳机壳 AirPods Pro 2 ×5'))
	eq(Prep.summaryParts(prep.totals), ['手机壳 ×5', '耳机壳 ×5'], '合计 lists both nouns')
	check('合计 does not collapse AirPods into 手机壳 ×10', !/合计：手机壳 ×10/.test(text) && /合计：手机壳 ×5 · 耳机壳 ×5/.test(text))
}

// ── Title-only AirPods (no model variation) ──────────────────────────────────
{
	const prep = Prep.buildSupplierPrep({
		section: 'cg',
		shop: 'AirStall',
		stall: '4A53',
		loc: { code: '4A53' },
		rows: [
			{
				product_key: 'p:legacy-air',
				title: 'Cute AirPods Case with Bear Charm',
				phone_model: '',
				has_case: true,
				quantity: 2,
				status_case: 'Pending',
			},
		],
		charmAggs: [],
	})
	eq(prep.products[0].lines[0].label, '耳机壳', 'title fallback still classifies AirPods')
	eq(prep.totals.airpods, 2, 'title-only AirPods counted as 耳机壳')
	eq(prep.totals.case, 0, 'title-only AirPods not counted as phone 手机壳')
}

// ── iPad case is 平板壳 ──────────────────────────────────────────────────────
{
	const prep = Prep.buildSupplierPrep({
		section: 'cg',
		shop: 'PadStall',
		stall: 'B1',
		loc: { code: 'B1' },
		rows: [
			{
				product_key: 'p:pad',
				title: 'Bow iPad Case',
				phone_model: 'Pro 2022 11"',
				has_case: true,
				quantity: 1,
				status_case: 'Pending',
			},
		],
		charmAggs: [],
	})
	eq(prep.products[0].lines[0], { kind: 'case', family: 'ipad', label: '平板壳', model: 'Pro 2022 11"', qty: 1 }, 'iPad uses 平板壳')
	eq(prep.totals.ipad, 1, 'iPad total')
	eq(prep.totals.case, 0, 'iPad not lumped into phone 手机壳')
}

// ── Charm photos are letterboxed, never cover-cropped ────────────────────────
{
	eq(Prep.FIT_CONTAIN, 'contain', 'contain is the public fit token')
	const box = 400
	const contained = Prep.imageDrawRect(100, 200, 0, 0, box, Prep.FIT_CONTAIN, Prep.CONTAIN_INSET)
	check('contain keeps a tall charm inside the well', contained.y >= 0 && contained.y + contained.h <= box)
	check('contain preserves aspect (portrait stays portrait)', Math.abs(contained.w / contained.h - 0.5) < 0.001)
	check('contain inset keeps the charm off the rounded clip', contained.y >= Prep.CONTAIN_INSET - 0.5)
	const covered = Prep.imageDrawRect(100, 200, 0, 0, box, Prep.FIT_COVER, Prep.CONTAIN_INSET)
	check('cover would crop the same charm (the old bug)', covered.y < 0 && covered.y + covered.h > box)
	eq(Prep.caseFamilyOf({ phone_model: 'AirPods 4', title: 'Case' }), 'airpods', 'AirPods model → airpods')
	eq(Prep.caseFamilyOf({ phone_model: 'iPhone 16', title: 'AirPods-print phone case' }), 'iphone', 'model wins over AirPods in the title')
	eq(Prep.caseFamilyOf({ charm_integral: true, has_charm: true, phone_model: '', title: 'Case' }), 'airpods', 'integral charm is AirPods')
}

// ── Discriminators stay aligned with the product-type registry ────────────────
{
	const prepSrc = fs.readFileSync(path.join(__dirname, '../public/shop-supplier-prep.js'), 'utf8')
	const registrySrc = fs.readFileSync(path.join(__dirname, '../src/listings/product-types.js'), 'utf8')
	const shopSrc = fs.readFileSync(path.join(__dirname, '../public/shop.html'), 'utf8')
	const literalOf = (src, name) => {
		const m = new RegExp(name + ' = (/.+?/i)\\s*;?\\s*$', 'm').exec(src)
		return m && m[1]
	}
	eq(literalOf(prepSrc, 'WATCH_MODEL_RE'), literalOf(registrySrc, 'WATCH_MODEL_RE'), 'watch model regex matches product-types')
	eq(literalOf(prepSrc, 'WATCH_TITLE_RE'), literalOf(registrySrc, 'WATCH_TITLE_RE'), 'watch title regex matches product-types')
	eq(literalOf(prepSrc, 'IPAD_MODEL_RE'), literalOf(registrySrc, 'IPAD_MODEL_RE'), 'iPad model regex matches product-types')
	eq(literalOf(prepSrc, 'IPAD_TITLE_RE'), literalOf(registrySrc, 'IPAD_TITLE_RE'), 'iPad title regex matches product-types')
	check('AirPods discriminator matches product-types', prepSrc.includes('/air\\s*pods?/i') && registrySrc.includes('/air\\s*pods?/i'))
	check('shopping-list thumbs letterbox instead of cover-cropping dangling charms', /\.thumb\s*\{[^}]*object-fit:\s*contain/.test(shopSrc))
	check('shopping-list thumbs no longer cover-crop', !/\.thumb\s*\{[^}]*object-fit:\s*cover/.test(shopSrc))
	check('prep canvas draws thumbs through imageDrawRect', prepSrc.includes('imageDrawRect(img.width, img.height'))
	check('prep canvas default fit is contain, not cover', /fit \|\| FIT_CONTAIN/.test(prepSrc) && !/Math\.max\(thumb \//.test(prepSrc))
}

// ── Canvas helpers stay browser-only ─────────────────────────────────────────
;(async () => {
	let message = ''
	try {
		await Prep.renderPrepImage({ empty: true })
	} catch (err) {
		message = String(err && err.message)
	}
	check('renderPrepImage rejects empty prep', /Nothing to prepare/i.test(message), message)

	message = ''
	try {
		await Prep.renderPrepImage({
			empty: false,
			products: [{ imageUrl: '', lines: [{ kind: 'case', label: '手机壳', model: 'iPhone 16', qty: 1 }] }],
			charms: [],
			totals: { case: 1, grip: 0, charm: 0, items: 1 },
		})
	} catch (err) {
		message = String(err && err.message)
	}
	check('renderPrepImage refuses to run under Node', /browser/i.test(message), message)

	console.log(`\n${passed} passed, ${failed} failed\n`)
	process.exit(failed ? 1 : 0)
})()
