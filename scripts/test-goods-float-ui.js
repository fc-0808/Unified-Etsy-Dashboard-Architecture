'use strict'

/**
 * Pins the Earnings-tab manufacturer goods UI so the editor, cost-view toggle,
 * and i18n phrases cannot drift apart from the float API.
 */

const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { JSDOM } = require('jsdom')

const html = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8')
const domain = fs.readFileSync(path.resolve(__dirname, '../src/finance/goods-float.js'), 'utf8')
const server = fs.readFileSync(path.resolve(__dirname, '../src/server/index.js'), 'utf8')
const setup = fs.readFileSync(path.resolve(__dirname, '../src/db/setup.js'), 'utf8')

let failures = 0
async function test(name, fn) {
	try {
		await fn()
		console.log(`  ok  - ${name}`)
	} catch (error) {
		failures += 1
		console.error(`  FAIL - ${name}`)
		console.error(`    ${error.stack || error.message}`)
	}
}

async function main() {
	console.log('Manufacturer goods float UI contract tests\n')

	await test('earnings markup has the goods section and cost-view toggle', () => {
		assert.match(html, /id="earnViewGoods"/)
		assert.match(html, /onclick="setEarnCostView\('goods'\)"/)
		assert.match(html, /id="earnGoodsSection"/)
		assert.match(html, /id="earnGoodsCards"/)
		assert.match(html, /id="earnGoodsEditor"/)
		assert.match(html, /id="earnGoodsSaveStatus"/)
		assert.match(html, />Manufacturing</)
		assert.match(html, />Transfers this period</)
		assert.match(html, />\+ Goods</)
		assert.match(html, /id="earnGoodsUpload"[^>]*multiple/)
		assert.match(html, /Select one or more overlapping bills/)
		assert.match(html, /\/api\/finance\/goods-float\/screenshots\/import/)
		assert.match(html, /id="earnGoodsLightbox"/)
		assert.match(html, /id="earnGoodsLightboxImg"/)
		assert.match(html, /openGoodsFloatScreenshot/)
		assert.match(html, /closeGoodsFloatScreenshot/)
		assert.match(html, /_goodsBillsHtml/)
		assert.match(html, /onGoodsFloatScreenshot/)
		assert.match(html, /importGoodsFloatScreenshot/)
		assert.match(html, /addGoodsFloatTransfer/)
		assert.match(html, /commitGoodsFloatTransferTime/)
		assert.match(html, /deleteGoodsFloatTransfer/)
		assert.match(html, /deleteGoodsFloatScreenshot/)
		assert.match(html, /retryGoodsFloatScreenshot/)
		assert.match(html, /recoverPendingGoodsBills/)
		assert.match(html, /id="earnGoodsLightboxDelete"/)
	})

	await test('earnings tab has a sticky jump bar to each finance section', () => {
		assert.match(html, /id="earnChrome"/)
		assert.match(html, /class="earn-chrome"/)
		assert.match(html, /position:\s*sticky/)
		assert.match(html, /id="earnJump"/)
		assert.match(html, /onclick="jumpToEarnSection\('earnSectionOverview'\)"/)
		assert.match(html, /onclick="jumpToEarnSection\('earnSectionFees'\)"/)
		assert.match(html, /onclick="jumpToEarnSection\('earnSectionShipping'\)"/)
		assert.match(html, /onclick="jumpToEarnSection\('earnGoodsSection'\)"/)
		assert.match(html, /onclick="jumpToEarnSection\('earnSectionOrders'\)"/)
		assert.match(html, /id="earnSectionOverview"/)
		assert.match(html, /id="earnSectionFees"/)
		assert.match(html, /id="earnSectionShipping"/)
		assert.match(html, /id="earnSectionOrders"/)
		assert.match(html, /data-earn-section="overview"/)
		assert.match(html, /data-earn-section="fees"/)
		assert.match(html, /data-earn-section="shipping"/)
		assert.match(html, /data-earn-section="goods"/)
		assert.match(html, /data-earn-section="orders"/)
		assert.match(html, /function jumpToEarnSection\(/)
		assert.match(html, /function initEarnChrome\(/)
		assert.match(html, /initEarnChrome\(\)/)
		assert.match(html, />Overall</)
		assert.match(html, />Etsy fees</)
		assert.match(html, />Shipping costs</)
		assert.match(html, />Manufacturing</)
	})

	await test('earnings loader fetches the goods-float API next to 4PX shipping', () => {
		assert.match(html, /\/api\/finance\/goods-float\?/)
		assert.match(html, /renderEarnGoods\(\)/)
		assert.match(html, /persistGoodsFloatMonth/)
		assert.match(html, /adjustGoodsFloatMonth/)
		assert.match(html, /\/api\/finance\/goods-float\/screenshots/)
		assert.match(html, /method: 'PATCH'/)
		assert.match(html, /method: 'DELETE'/)
		assert.match(html, /_earnIncludeGoods/)
		assert.match(html, /_earnGoodsAppliesToNet/)
		assert.match(html, /88800/)
	})

	await test('cost view treats goods as an independent deduction, not a replacement for 4PX', () => {
		assert.match(html, /_earnIncludeGoods = !_earnIncludeGoods/)
		assert.match(html, /view === 'etsy'[\s\S]*_earnIncludeGoods = false/)
		assert.match(html, /_earnHeadlineLabel\(shipConv != null, goodsApplied\)/)
		assert.match(html, /Net after 4PX & goods/)
		assert.match(html, /Company-level cost — not allocated to a single shop/)
		assert.match(
			html,
			/function renderEarnSummary\(summary\)[\s\S]*const shipOn = _earnCostView === 'combined'[\s\S]*const shipConv = shipOn &&/,
		)
	})

	await test('renderEarnSummary paints Etsy-only activity without a shipOn ReferenceError', async () => {
		const start = html.indexOf('function renderEarnSummary(summary)')
		const end = html.indexOf('function renderEarnBreakdown(summary)', start)
		assert.ok(start > 0 && end > start)
		const snippet = html.slice(start, end)
		const dom = new JSDOM(
			`<!doctype html><html><body>
			<select id="earnShop"><option value="" selected>All shops</option></select>
			<select id="earnRange"><option value="mtd" selected>This month</option></select>
			<div id="earnSummaryCards"></div>
		</body></html>`,
			{ url: 'http://127.0.0.1:4000/', pretendToBeVisual: true, runScripts: 'dangerously' },
		)
		const { window } = dom
		window._earnCostView = 'etsy'
		window._earnIncludeGoods = false
		window._earnGoods = { deductible: true, total_cents: 0, transfer_count: 0, amount_per_transfer_cents: 88800 }
		window._shippingCnyByPayoutCurrency = () => ({ USD: 12 })
		window._cnyConvert = () => 1.5
		window._earnGoodsAppliesToNet = () => false
		window._goodsCnyCents = () => 0
		window._cnyCentsIn = (cents) => cents
		window.earnMoney = (cents) => String((cents || 0) / 100)
		window.earnCcyLabel = (ccy) => ccy || 'USD'
		window._earnRangeSpan = () => ({ from: 1, to: 2, dates: '1 Sep – 18 Sep', label: 'This month' })
		window.eval(`${snippet}\nwindow.__renderEarnSummary = renderEarnSummary;`)
		window.__renderEarnSummary({
			byCurrency: [{ currency: 'USD', net_cents: 10000, gross_cents: 20000 }],
			byCategory: [],
			balances: [{ currency: 'USD', balance_cents: 5000 }],
			monthToDate: { from: 1, label: 'September', byCurrency: [{ currency: 'USD', net_cents: 10000 }] },
		})
		assert.match(window.document.getElementById('earnSummaryCards').innerHTML, /Activity summary/)
		assert.doesNotMatch(window.document.getElementById('earnSummaryCards').textContent, /shipOn is not defined/)
	})

	await test('writes send the stored version so two tabs cannot clobber each other', () => {
		assert.match(html, /method: 'PUT'/)
		assert.match(html, /version: latest && latest\.stored \? latest\.version : 0/)
		assert.match(html, /res\.status === 409/)
		assert.match(html, /_earnGoodsSaves/)
	})

	await test('Chinese dictionary covers the new earnings phrases', () => {
		const required = [
			"'+ Goods': '+ 货成本'",
			"'Manufacturer goods cost': '厂家货成本'",
			"'Transfers this period': '本期间转账次数'",
			"'How goods cost works': '货成本说明'",
			"'Net after goods': '扣除货成本后净利'",
			"'Net after 4PX & goods': '扣除 4PX 与货成本后净利'",
			"'Company-level cost — not allocated to a single shop.': '公司级成本 — 不按单店分摊。'",
			"Overall: '总览'",
			"'Etsy fees': 'Etsy 费用'",
			"'Shipping costs': '运费'",
			"Manufacturing: '厂家货'",
			"'Earnings sections': '收益分区'",
			"'Upload WeChat bill': '上传微信账单'",
			"'Select one or more overlapping bills': '可一次选多张互有重叠的账单'",
			"'Confirm these 888 wires': '确认这些 888 转账'",
			"'Add ¥888 wire': '补记一笔 ¥888'",
			"'From WeChat bill': '来自微信账单'",
			"'Saved WeChat bills': '已保存的微信账单'",
			"'bills show this wire': '张账单都有这一笔'",
			"'Delete this ¥888 wire?': '删除这一笔 ¥888 转账？'",
			"'Delete WeChat bill': '删除微信账单'",
			"'Delete bill': '删除账单'",
			"'View bill': '查看账单'",
			"'View WeChat bill': '查看微信账单'",
		]
		for (const phrase of required) {
			assert.ok(html.includes(phrase), `missing i18n entry ${phrase}`)
		}
	})

	await test('server and database setup install the goods-float module once', () => {
		assert.match(setup, /goodsFloat\.ensureSchema\(db\)/)
		assert.match(server, /goodsFloat\.installRoutes\(app/)
		assert.match(domain, /CREATE TABLE IF NOT EXISTS goods_float_months/)
		assert.match(domain, /CREATE TABLE IF NOT EXISTS goods_float_revisions/)
		assert.match(domain, /CREATE TABLE IF NOT EXISTS goods_float_transfers/)
		assert.match(domain, /CREATE TABLE IF NOT EXISTS goods_float_screenshots/)
		assert.match(domain, /function deleteScreenshot/)
		assert.match(domain, /autoImportPreview/)
		assert.match(domain, /GOODS_FLOAT_HAS_TIMED_TRANSFERS/)
		assert.match(domain, /GOODS_FLOAT_DUPLICATE_TRANSFER/)
		assert.match(domain, /function deleteScreenshot/)
		assert.match(domain, /function reparseScreenshot/)
		assert.match(domain, /auto_imported/)
	})

	await test('editor renders the month stepper and PUTs a new count with the stored version', async () => {
		const start = html.indexOf('// ── Manufacturer goods float (Earnings tab)')
		const fmt = html.indexOf('function _fmtMoney(v, ccy)', start)
		const scope = html.indexOf('function _earnScopeLabel()', fmt)
		const scopeEnd = html.indexOf('function _earnRangeSpan()', scope)
		assert.ok(start > 0 && fmt > start && scope > fmt && scopeEnd > scope)
		const controller = html.slice(start, fmt) + html.slice(fmt, scopeEnd)

		const putCalls = []
		const summaryAfter = {
			transfer_count: 6,
			total_cents: 532800,
			amount_per_transfer_cents: 88800,
			deductible: true,
			shop_id: null,
			window: { covers_partial_month: false, months: ['2026-09'] },
			screenshots: [
				{
					id: 7,
					image_url: '/api/finance/goods-float/screenshots/7/image?v=1',
					created_at: 1758180000,
					uploaded_at: '2026-09-18 08:42',
					transfer_count: 1,
				},
			],
			transfers: [
				{
					id: 3,
					transferred_at: 1757589240,
					local_datetime: '2026-09-11 17:54',
					amount_cents: 88800,
					title: '转账-来自Walter',
					source: 'screenshot',
					screenshot_id: 7,
					version: 1,
				},
			],
			months: [
				{
					period_ym: '2026-09',
					transfer_count: 6,
					amount_per_transfer_cents: 88800,
					total_cents: 532800,
					stored: true,
					version: 2,
					updated_by: 'walter',
					updated_at: Math.floor(Date.now() / 1000),
				},
			],
		}

		const dom = new JSDOM(
			`<!doctype html><html><body>
			<select id="earnShop"><option value="" selected>All shops</option></select>
			<select id="earnRange"><option value="mtd" selected>This month</option></select>
			<span id="earnGoodsScope"></span>
			<div id="earnGoodsCards"></div>
			<div id="earnGoodsEditor"></div>
			<span id="earnGoodsSaveStatus"></span>
			<div id="earnGoodsLightbox" class="earn-goods-lb">
				<div class="earn-goods-lb-bar">
					<strong id="earnGoodsLightboxCap"></strong>
					<button type="button" id="earnGoodsLightboxDelete">Delete bill</button>
					<button type="button" id="earnGoodsLightboxClose">Close</button>
				</div>
				<img id="earnGoodsLightboxImg" alt="">
			</div>
		</body></html>`,
			{ url: 'http://127.0.0.1:4000/', pretendToBeVisual: true, runScripts: 'dangerously' },
		)
		const { window } = dom
		window.API = ''
		window.I18N = { t: (s) => s, get: () => 'en' }
		window.escHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		window.escAttr = window.escHtml
		window.jsAttr = (value) => String(value ?? '').replace(/'/g, "\\'")
		window._cnyConvert = () => 74.5
		window.earnQuery = () => new window.URLSearchParams('from=1756656000')
		window.renderEarnSummary = () => {}
		window._earnIncludeGoods = true
		window._earnSummary = { byCurrency: [] }
		window._earnGoodsMax = 999
		window._earnGoodsSaves = new Map()
		window._earnGoodsReview = null
		window._earnGoodsBusy = false
		window._earnGoods = {
			transfer_count: 5,
			total_cents: 444000,
			amount_per_transfer_cents: 88800,
			deductible: true,
			shop_id: null,
			window: { covers_partial_month: true, months: ['2026-09'] },
			screenshots: [
				{
					id: 7,
					image_url: '/api/finance/goods-float/screenshots/7/image?v=1',
					created_at: 1758180000,
					uploaded_at: '2026-09-18 08:42',
					transfer_count: 1,
				},
			],
			transfers: [
				{
					id: 3,
					transferred_at: 1757589240,
					local_datetime: '2026-09-11 17:54',
					amount_cents: 88800,
					title: '转账-来自Walter',
					source: 'screenshot',
					screenshot_id: 7,
					version: 1,
				},
			],
			months: [
				{
					period_ym: '2026-09',
					transfer_count: 5,
					amount_per_transfer_cents: 88800,
					total_cents: 444000,
					stored: true,
					version: 1,
					updated_by: 'walter',
					updated_at: 1758180000,
				},
			],
		}
		window.fetch = async (url, opts) => {
			putCalls.push({ url: String(url), opts })
			return {
				status: 200,
				ok: true,
				async json() {
					return { ok: true, month: summaryAfter.months[0], summary: summaryAfter }
				},
			}
		}

		window.eval(`${controller}
window.__goodsUi = {
	renderEarnGoods,
	persistGoodsFloatMonth,
	adjustGoodsFloatMonth,
	_parseGoodsCount,
	openGoodsFloatScreenshot,
	closeGoodsFloatScreenshot,
	setGoodsReview(review) { _earnGoodsReview = review },
};`)

		assert.equal(window.__goodsUi._parseGoodsCount('12abc'), 12)
		assert.equal(window.__goodsUi._parseGoodsCount('5000'), 999)
		window.__goodsUi.renderEarnGoods()
		const input = window.document.querySelector('#earnGoodsEditor .earn-goods-month input')
		assert.ok(input)
		assert.equal(input.value, '5')
		assert.ok(window.document.getElementById('earnGoodsUpload'))
		assert.equal(window.document.getElementById('earnGoodsUpload').multiple, true)
		assert.ok(window.document.getElementById('earnGoodsBills'))
		assert.ok(window.document.querySelector('#earnGoodsBills .earn-goods-thumb-del'))
		assert.match(window.document.getElementById('earnGoodsEditor').textContent, /Saved WeChat bills/)
		assert.match(window.document.getElementById('earnGoodsEditor').textContent, /Select one or more overlapping bills/)
		assert.match(window.document.getElementById('earnGoodsEditor').textContent, /View bill/)
		assert.match(window.document.getElementById('earnGoodsCards').textContent, /5/)
		assert.match(window.document.getElementById('earnGoodsScope').textContent, /All shops/)
		assert.match(window.document.getElementById('earnGoodsCards').textContent, /whole calendar months/)

		window.__goodsUi.openGoodsFloatScreenshot(7)
		assert.match(window.document.getElementById('earnGoodsLightbox').className, /\bopen\b/)
		assert.match(window.document.getElementById('earnGoodsLightboxImg').getAttribute('src') || '', /\/screenshots\/7\/image/)
		window.__goodsUi.closeGoodsFloatScreenshot()
		assert.equal(window.document.getElementById('earnGoodsLightbox').classList.contains('open'), false)

		window.__goodsUi.setGoodsReview({
			screenshot: { id: 7, image_url: '/api/finance/goods-float/screenshots/7/image?v=1' },
			screenshots: [
				{ id: 7, image_url: '/api/finance/goods-float/screenshots/7/image?v=1' },
				{ id: 8, image_url: '/api/finance/goods-float/screenshots/8/image?v=1' },
			],
			screenshot_ids: [7, 8],
			ignored_count: 6,
			wires: [
				{
					fingerprint: 'overlap',
					transferred_at: 1757589240,
					local_datetime: '2026-09-11 17:54',
					amount_cents: 88800,
					title: '转账-来自Walter',
					already_recorded: false,
					seen_on_bills: 2,
					screenshot_ids: [7, 8],
				},
			],
		})
		window.__goodsUi.renderEarnGoods()
		assert.match(window.document.getElementById('earnGoodsReview').textContent, /2 bills show this wire/)
		assert.equal(window.document.querySelectorAll('#earnGoodsReview .earn-goods-thumb').length, 2)

		await window.__goodsUi.persistGoodsFloatMonth('2026-09', 6)
		assert.equal(putCalls.length, 1)
		assert.match(putCalls[0].url, /\/api\/finance\/goods-float\/2026-09/)
		assert.equal(putCalls[0].opts.method, 'PUT')
		assert.equal(JSON.parse(putCalls[0].opts.body).transfer_count, 6)
		assert.equal(JSON.parse(putCalls[0].opts.body).version, 1)
		assert.equal(window.document.querySelector('#earnGoodsEditor .earn-goods-month input').value, '6')
		assert.equal(window.document.getElementById('earnGoodsSaveStatus').textContent, 'Saved')
	})

	await test('jumpToEarnSection activates the matching pill and scrolls', async () => {
		const start = html.indexOf('let _earnJumpLock = null')
		const end = html.indexOf('async function initEarnings()', start)
		assert.ok(start > 0 && end > start)
		const snippet = html.slice(start, end)
		const dom = new JSDOM(
			`<!doctype html><html><body>
			<div class="topbar" style="height:56px"></div>
			<div id="tab-earnings">
				<div id="earnChrome" style="height:90px"></div>
				<nav id="earnJump">
					<button type="button" class="earn-jump-btn is-active" data-earn-target="earnSectionOverview">Overall</button>
					<button type="button" class="earn-jump-btn" data-earn-target="earnGoodsSection">Manufacturing</button>
				</nav>
				<section id="earnSectionOverview" data-earn-section="overview"></section>
				<section id="earnGoodsSection" data-earn-section="goods"></section>
			</div>
		</body></html>`,
			{ url: 'http://127.0.0.1:4000/', pretendToBeVisual: true, runScripts: 'dangerously' },
		)
		const { window } = dom
		const scrolls = []
		window.scrollTo = (opts) => scrolls.push(opts)
		window.matchMedia = () => ({ matches: true })
		window.eval(`${snippet}\nwindow.jumpToEarnSection = jumpToEarnSection;`)
		window.jumpToEarnSection('earnGoodsSection')
		assert.equal(window.document.querySelector('[data-earn-target="earnGoodsSection"]').classList.contains('is-active'), true)
		assert.equal(window.document.querySelector('[data-earn-target="earnSectionOverview"]').classList.contains('is-active'), false)
		assert.equal(window.document.querySelector('[data-earn-target="earnGoodsSection"]').getAttribute('aria-current'), 'true')
		assert.equal(scrolls.length, 1)
		assert.equal(scrolls[0].behavior, 'auto')
	})

	if (failures) {
		console.error(`\n${failures} goods-float UI test(s) failed`)
		process.exit(1)
	}
	console.log('\nAll goods-float UI tests passed')
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
