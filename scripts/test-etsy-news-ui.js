'use strict'

/**
 * News tab renderer against the real dashboard markup.
 *
 * Run: node scripts/test-etsy-news-ui.js
 */

const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { JSDOM } = require('jsdom')

const html = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8')
const start = html.indexOf('<div id="tab-news"')
const end = html.indexOf('<!-- ── SHIPPING tab', start)
assert.ok(start > 0 && end > start, 'News panel must sit in the dashboard before Shipping')
const panel = html.slice(start, end)

const createNews = require('../public/news.js')

function mount() {
	const dom = new JSDOM(`<!doctype html><body>${panel}</body>`, { url: 'http://127.0.0.1:4000/' })
	const api = createNews(dom.window)
	return { window: dom.window, document: dom.window.document, api }
}

function sample(overrides = {}) {
	return {
		fetched_at: Date.now(),
		stale: false,
		sources: [
			{
				id: 'etsy-help',
				name: 'Etsy Help Center',
				kind: 'official',
				ok: true,
				item_count: 1,
				home: 'https://help.etsy.com/hc/en-us/articles/10603291042967',
				reliability: 'Official Etsy Help Center, including the Newly Crafted seller changelog.',
			},
		],
		items: [
			{
				id: 'help:1',
				title: 'Shared access to your shop',
				url: 'https://help.etsy.com/hc/en-us/articles/11',
				published_at: '2026-09-18T20:46:32.000Z',
				summary: 'Owners can invite staff.',
				source_id: 'etsy-help',
				source_name: 'Etsy Help Center',
				kind: 'official',
			},
		],
		...overrides,
	}
}

let failed = 0
async function test(name, fn) {
	try {
		await fn()
		console.log(`  ok  ${name}`)
	} catch (err) {
		failed++
		console.error(`  FAIL ${name}`)
		console.error(err && err.stack ? err.stack : err)
	}
}

async function main() {
	await test('the tab is wired like the other dashboard sections', () => {
		assert.match(html, /<link rel="stylesheet" href="\/news\.css" \/>/)
		assert.match(html, /<script src="\/news\.js" defer><\/script>/)
		assert.match(html, /data-tab="news"\s+data-cap="news:read"/)
		assert.match(html, /if \(name === 'news' && window\.UEDNews\) window\.UEDNews\.open\(\)/)
		assert.match(html, /id="newsWindow"/)
		assert.match(html, /id="newsKind"/)
		assert.match(html, /id="newsRefreshBtn"/)
		assert.match(html, /id="newsList"/)
		assert.equal((html.match(/id="tab-news"/g) || []).length, 1)
	})

	await test('external titles are text, and only https links are clickable', () => {
		const { document, api } = mount()
		api.renderBriefing(
			sample({
				items: [
					{
						id: 'bad',
						title: '<img src=x onerror=alert(1)>',
						url: 'javascript:alert(1)',
						published_at: '2026-09-18T20:46:32.000Z',
						summary: '<script>alert(1)</script>',
						source_name: '<b>Etsy</b>',
						kind: 'official',
					},
					{
						id: 'good',
						title: 'Shared access to your shop',
						url: 'https://help.etsy.com/hc/en-us/articles/11',
						published_at: '2026-09-18T20:46:32.000Z',
						month: '2026-09',
						summary: 'Owners can invite staff.',
						source_name: 'Etsy Help Center',
						kind: 'official',
					},
				],
			}),
			'ready',
		)
		assert.equal(document.querySelector('img'), null)
		assert.equal(document.querySelector('script'), null)
		assert.equal(document.querySelector('b'), null)
		const cards = [...document.querySelectorAll('.news-card')]
		assert.equal(cards.length, 2)
		assert.equal(cards[0].querySelector('a'), null)
		assert.equal(cards[0].querySelector('h3').textContent, '<img src=x onerror=alert(1)>')
		assert.equal(cards[0].querySelector('.news-summary').textContent, '<script>alert(1)</script>')
		const link = cards[1].querySelector('h3 a')
		assert.equal(link.getAttribute('href'), 'https://help.etsy.com/hc/en-us/articles/11')
		assert.equal(link.getAttribute('target'), '_blank')
		assert.match(link.getAttribute('rel'), /noopener/)
		assert.equal(cards[1].querySelector('.news-kind').textContent, 'Official')
		assert.match(cards[1].textContent, /September 2026/)
		assert.equal(document.querySelector('#newsCount').textContent, '2 updates')
		assert.equal(document.querySelector('#newsList').hidden, false)
	})

	await test('an empty window and a failed load have their own states', () => {
		const { document, api } = mount()
		api.renderBriefing(sample({ items: [], sources: [] }), 'ready')
		assert.equal(document.querySelector('#newsPageState').hidden, false)
		assert.equal(document.querySelector('#newsPageState').textContent, 'No updates in this window')
		assert.equal(document.querySelector('#newsList').hidden, true)

		api.renderBriefing(null, 'error')
		assert.equal(document.querySelector('#newsPageState').textContent, 'Could not load the briefing')
		assert.ok(document.querySelector('#newsStatus').classList.contains('is-error'))
	})

	await test('refresh asks the server to fetch again, and a bad payload does not throw', async () => {
		const { window, document, api } = mount()
		const calls = []
		window.fetch = async (url) => {
			calls.push(String(url))
			if (String(url).includes('refresh=1')) {
				return { ok: false, text: async () => '{"error":"nope"}' }
			}
			return {
				ok: true,
				text: async () => JSON.stringify(sample()),
			}
		}
		await api.open()
		assert.match(calls[0], /window=90/)
		assert.match(calls[0], /kind=all/)
		assert.equal(document.querySelectorAll('.news-card').length, 1)
		document.querySelector('#newsRefreshBtn').click()
		await new Promise((resolve) => setTimeout(resolve, 30))
		assert.match(calls[1], /refresh=1/)
		assert.equal(document.querySelector('#newsPageState').textContent, 'Could not load the briefing')
	})

	if (failed) {
		console.error(`\n${failed} failed`)
		process.exit(1)
	}
	console.log('\nPASS — Etsy news UI')
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
