'use strict'

/**
 * Behavioral test for the shipped Growth renderer. The controller is extracted
 * from public/index.html and executed against the real Growth markup in JSDOM,
 * so empty-state/card regressions cannot hide behind static string assertions.
 */

const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { JSDOM } = require('jsdom')

const html = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8')
const startMarker = '// ── Growth / catalog health'
const endMarker = '// Routed from handleSyncEvent()'
const start = html.indexOf(startMarker)
const end = html.indexOf(endMarker, start)
assert.ok(start >= 0 && end > start, 'Growth controller markers must exist')

const dom = new JSDOM(html, {
	url: 'http://127.0.0.1:4000/',
	runScripts: 'outside-only',
})
const { window } = dom
window.API = ''
window.confirm = () => true
window.sortShopsForDisplay = (rows) => rows
window.escHtml = (value) => String(value ?? '')
	.replace(/&/g, '&amp;')
	.replace(/</g, '&lt;')
	.replace(/>/g, '&gt;')
	.replace(/"/g, '&quot;')
window.escAttr = window.escHtml
window.fetchJson = async () => ({})

const controller = html.slice(start, end)
window.eval(`${controller}
window.__growthUiTest = {
	renderGrowth,
	renderGrowthWatch,
	renderGrowthCadence,
	renderGrowthListingInsights,
	setGrowthPageState,
	growthListingIssueLabel,
};`)

const report = {
	window: { days: 7 },
	collection: {
		api_calls_on_page_load: 0,
		message: 'Manual mode',
	},
	compliance: {
		status: 'elevated',
		risks: [{ level: 'high', title: 'Multi-key approval missing' }],
	},
	coverage: {
		shops: 2,
		manual_shops: 0,
		latest_manual_import_at: null,
	},
	portfolio: {
		orders_current: 30,
		orders_baseline: 40,
		orders_growth_pct: -25,
		traffic_metric: null,
		traffic_delta: null,
		traffic_growth_pct: null,
		manual_shops: 0,
		shops_vacation: 0,
		shops_expired: 0,
		conversion_rate: null,
	},
	scope: { scope: 'shop' },
	shops: [
		{
			shop_id: 'alpha',
			shop_name: 'Alpha',
			data_source: 'local_sync',
			orders_current: 10,
			orders_growth_pct: -33.3,
			traffic_delta: null,
			review_average: null,
			expired_count: 0,
			late_ship_rate_pct: 0,
			primary_cause: 'sales_drop',
			severity: 'high',
		},
		{
			shop_id: 'beta',
			shop_name: 'Beta',
			data_source: 'local_sync',
			orders_current: 20,
			orders_growth_pct: -20,
			traffic_delta: null,
			review_average: 4.9,
			expired_count: 0,
			late_ship_rate_pct: 0,
			primary_cause: 'healthy',
			severity: 'ok',
		},
	],
	actions: [{
		severity: 'high',
		title: 'Orders down',
		shop_name: 'Alpha',
		why: 'Sales declined.',
		how: 'Import Stats and diagnose traffic.',
	}],
	cadence: {
		principle: 'Quality experiments, not a daily-listing hack',
		summary: 'A temporary boost is not the strategy.',
		evaluation: 'Review at 14 and 28 days.',
		portfolio_target_min: 2,
		portfolio_target_max: 2,
		fix_first_count: 0,
		measure_first_count: 2,
		shops: [
			{ shop_id: 'alpha', target_min: 1, target_max: 1, target_label: '1 / week', headline: 'Measure first', rationale: 'Get a baseline.', next_steps: ['Import Stats.'] },
			{ shop_id: 'beta', target_min: 1, target_max: 1, target_label: '1 / week', headline: 'Measure first', rationale: 'Get a baseline.', next_steps: ['Import Stats.'] },
		],
		quality_gate: [
			'Use all 13 tag slots with varied phrases.',
			'Lead with one clear product image.',
		],
		traffic_methods: [{
			title: 'Find demand inside Etsy',
			action: 'Use Marketplace Insights.',
			evidence: 'official',
			url: 'https://help.etsy.com/hc/en-us/articles/35122361353239',
		}],
		evidence: [
			{ label: 'How Etsy Search Works', url: 'https://www.etsy.com/seller-handbook/article/how-etsy-search-works/375461474487' },
		],
	},
	watchlist: {
		expired: [],
		sold_out: [],
		ending_soon: [],
		zero_views: [{ listing_id: 1, shop_id: 'alpha', title: 'No-view listing', views: 0 }],
		weak_titles: [],
		traffic_drop_listings: [],
	},
	reviews: { low_recent: [] },
}

let passed = 0
function test(name, fn) {
	fn()
	passed += 1
	console.log(`  ok  — ${name}`)
}

test('initial explicit page state replaces partial blank boxes', () => {
	const state = window.document.getElementById('growthPageState')
	const dashboard = window.document.getElementById('growthDashboard')
	assert.equal(state.hidden, false)
	assert.equal(dashboard.hidden, true)
})

window.__growthUiTest.renderGrowth(report)

test('successful render atomically swaps loading state for dashboard', () => {
	assert.equal(window.document.getElementById('growthPageState').hidden, true)
	assert.equal(window.document.getElementById('growthDashboard').hidden, false)
})

test('four useful KPIs render without dash-only placeholder cards', () => {
	const cards = [...window.document.querySelectorAll('#growthStats .growth-kpi-card')]
	assert.equal(cards.length, 4)
	assert.ok(cards.every((card) => card.textContent.trim() && !/^—$/.test(card.textContent.trim())))
	assert.match(cards[1].textContent, /0\/2/)
})

test('elevated marketplace compliance is visible beside growth work', () => {
	const banner = window.document.getElementById('growthComplianceBanner')
	assert.equal(banner.hidden, false)
	assert.match(banner.textContent, /Multi-key approval missing/)
})

test('window mismatch explains why existing manual data is not selected', () => {
	const mismatch = JSON.parse(JSON.stringify(report))
	mismatch.window.days = 28
	mismatch.coverage.manual_other_window_shops = 1
	window.__growthUiTest.renderGrowth(mismatch)
	assert.match(window.document.getElementById('growthCoverage').textContent, /No 28-day manual comparison/)
	window.__growthUiTest.renderGrowth(report)
})

test('missing traffic becomes an inline import action', () => {
	const buttons = window.document.querySelectorAll('#growthShopRows .growth-inline-import')
	assert.equal(buttons.length, 2)
	assert.equal(buttons[0].dataset.shop, 'alpha')
})

test('scorecard rows carry labelled mobile-card semantics', () => {
	const rows = [...window.document.querySelectorAll('#growthShopRows .growth-score-row')]
	assert.equal(rows.length, 2)
	assert.equal(rows[0].querySelectorAll('td[data-label]').length, 8)
	assert.match(html, /#tab-growth \.growth-score-table \.growth-score-row td::before/)
})

test('watchlist omits empty categories instead of drawing blank cards', () => {
	const cards = window.document.querySelectorAll('#growthWatch .growth-watch-card')
	assert.equal(cards.length, 1)
	assert.match(cards[0].textContent, /No tabulated views/)
	assert.equal(window.document.getElementById('growthWatchSection').hidden, false)
})

test('rights-review queue shows total count and complete local export', () => {
	window.__growthUiTest.renderGrowthWatch({
		rights_review: [{ listing_id: 9, title: 'Hello Kitty Case', rights_holder: 'Sanrio', character: 'Hello Kitty' }],
		rights_review_total: 12,
	})
	const card = window.document.querySelector('#growthWatch .growth-watch-card.is-risk')
	assert.ok(card)
	assert.match(card.textContent, /12/)
	assert.match(card.textContent, /Sanrio/)
	assert.equal(card.querySelector('.growth-watch-export').getAttribute('href'), '/api/growth/rights-review.csv')
})

test('empty review section is removed from the page', () => {
	assert.equal(window.document.getElementById('growthReviewsSection').hidden, true)
})

test('manual per-listing insight groups render without empty cards', () => {
	window.__growthUiTest.renderGrowthListingInsights([{
		import: {
			shop_id: 'alpha',
			shop_name: 'Alpha',
			window_days: 7,
			current: { start: '2026-08-22', end: '2026-08-28' },
			row_count: 2,
			warnings: [],
		},
		totals: {
			current: { views: 210, orders: 4 },
			baseline: { views: 160, orders: 1 },
		},
		groups: {
			conversion_fixes: [{
				listing_id: '102',
				title: '<Viewed, no orders>',
				current: { views: 90, orders: 0 },
				changes: { views_pct: -10 },
			}],
			traffic_losses: [],
			interest_not_sales: [],
			winners: [{
				listing_id: '101',
				title: 'Winner',
				current: { views: 120, orders: 4 },
				changes: { views_pct: 100 },
			}],
			no_traction: [],
		},
	}])
	const section = window.document.getElementById('growthListingInsightsSection')
	const groups = section.querySelectorAll('.growth-listing-group')
	assert.equal(section.hidden, false)
	assert.equal(groups.length, 2)
	assert.match(section.textContent, /Views, no orders/)
	assert.equal(section.querySelector('script'), null)
	assert.match(section.innerHTML, /&lt;Viewed, no orders&gt;/)
})

test('cadence panel states the non-daily principle and cites evidence', () => {
	const panel = window.document.getElementById('growthCadence')
	assert.match(panel.textContent, /temporary boost/i)
	assert.match(panel.textContent, /1 \/ shop/)
	assert.match(panel.textContent, /Pre-publish quality gate/)
	assert.equal(panel.querySelectorAll('.growth-quality-gate:not(.growth-traffic-playbook) li').length, 2)
	assert.match(panel.textContent, /Traffic growth playbook/)
	assert.equal(panel.querySelectorAll('.growth-traffic-playbook li').length, 1)
	const link = panel.querySelector('a')
	assert.ok(link.hostname.endsWith('etsy.com'))
})

test('current title guidance issue labels are human-readable', () => {
	assert.equal(window.__growthUiTest.growthListingIssueLabel('title_not_scannable'), 'Title over 15 words')
	assert.equal(window.__growthUiTest.growthListingIssueLabel('unused_tag_slots'), 'Unused tag slots')
})

console.log(`\nPASS — Growth UI: ${passed} behavioral checks`)
dom.window.close()
