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
 *   · Text fallback stays readable without photos.
 *
 * Run: `node scripts/test-supplier-prep.js`
 */

const assert = require('assert')
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
			{ kind: 'case', label: '壳', model: 'iPhone 15', qty: 2 },
			{ kind: 'case', label: '壳', model: 'iPhone 14/13', qty: 1 },
			{ kind: 'grip', label: '支架', model: null, qty: 1 },
		],
		'case models newest-first + grip batch',
	)
	const mint = prep.products.find((p) => p.lines.some((ln) => ln.model === 'iPhone 17 Pro Max'))
	check('out-of-stock case included on prep sheet', !!mint)
	eq(
		mint && mint.lines.find((ln) => ln.model === 'iPhone 17 Pro Max'),
		{ kind: 'case', label: '壳', model: 'iPhone 17 Pro Max', qty: 2 },
		'OOS case listed like any other line',
	)
	eq(prep.charms, [{ imageUrl: '/api/route/charm-image?code=B88&v=v1', code: 'B88', qty: 2 }], 'non-purchased charm qty only')
	eq(prep.totals, { case: 5, grip: 1, charm: 2, items: 3 }, 'component totals include OOS')
	check('exchanges never appear on the prep list', !JSON.stringify(prep).includes('exchange'))

	const text = Prep.prepToText(prep)
	check('text fallback names the stall', text.includes('汇通') && text.includes('A146') && text.includes('leo'))
	check('text lists OOS model without status tag', text.includes('iPhone 17 Pro Max') && !text.includes('缺货'))
	check('text lists charm code', text.includes('B88'))
	check('text asks supplier to prepare', text.includes('请提前备好'))
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
	eq(prep.charms.length, 0, 'no sourced-charm card for integral')
	eq(prep.totals, { case: 1, grip: 0, charm: 1, items: 1 }, 'integral charm counted in totals')
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
			products: [{ imageUrl: '', lines: [{ kind: 'case', label: '壳', model: 'iPhone 16', qty: 1 }] }],
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
