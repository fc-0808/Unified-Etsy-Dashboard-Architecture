'use strict'

/**
 * Etsy news briefing: allowlisted sources, feed parsing, and the owner-only route.
 * No live network. Fixtures stand in for the Help Center, status page, and feeds.
 *
 * Run: node scripts/test-etsy-news.js
 */

const assert = require('node:assert/strict')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const express = require('express')

const news = require('../src/news/etsy-news')
const { installRoutes } = require('../src/news/routes')

const NOW = Date.parse('2026-09-27T12:00:00Z')
const CRAFTED_URL = 'https://help.etsy.com/hc/en-us/articles/10603291042967'

const CRAFTED_HTML = [
	'<h2 id="m1">September 2026</h2>',
	'<h3 id="h_sep">Shared access to your shop</h3>',
	'<p>Invite a teammate without sharing the password.</p>',
	'<h2 id="m2">June 2026</h2>',
	'<h3 id="h_jun">Tariffs estimator</h3>',
	'<p>Estimate duties before you buy a label.</p>',
].join('')

function fixtures(url) {
	if (url.includes('sort_by=created_at')) {
		return JSON.stringify({
			articles: [
				{
					id: 11,
					draft: false,
					title: 'Etsy adds shared shop access',
					html_url: 'https://help.etsy.com/hc/en-us/articles/11',
					created_at: '2026-09-18T20:46:32Z',
					updated_at: '2026-09-18T20:46:32Z',
					body: '<p>Owners can invite staff.</p>',
				},
				{
					id: news.NEWLY_CRAFTED_ID,
					draft: false,
					title: 'Newly Crafted: Etsy Updates for Your Shop',
					html_url: CRAFTED_URL,
					created_at: '2022-11-30T19:11:58Z',
					updated_at: '2026-09-27T04:07:15Z',
					body: '<p>Overview page.</p>',
				},
			],
		})
	}
	if (url.includes('sort_by=updated_at')) {
		return JSON.stringify({
			articles: [
				{
					id: 12,
					draft: false,
					title: 'How to photograph your items',
					html_url: 'https://help.etsy.com/hc/en-us/articles/12',
					created_at: '2024-01-01T00:00:00Z',
					updated_at: '2026-09-20T00:00:00Z',
					body: '<p>Use daylight.</p>',
				},
				{
					id: 13,
					draft: false,
					title: 'Etsy fee schedule',
					html_url: 'https://help.etsy.com/hc/en-us/articles/13',
					created_at: '2024-01-01T00:00:00Z',
					updated_at: '2026-09-20T00:00:00Z',
					body: '<p>Transaction fees changed.</p>',
				},
				{
					id: 14,
					draft: false,
					title: 'Countries Eligible for Etsy Payments',
					html_url: 'https://help.etsy.com/hc/en-us/articles/14',
					created_at: '2020-01-01T00:00:00Z',
					updated_at: '2026-09-27T00:00:00Z',
					body: '<p>Reference list.</p>',
				},
			],
		})
	}
	if (url.includes(`/articles/${news.NEWLY_CRAFTED_ID}.json`)) {
		return JSON.stringify({
			article: {
				id: news.NEWLY_CRAFTED_ID,
				title: 'Newly Crafted',
				html_url: CRAFTED_URL,
				updated_at: '2026-09-27T04:07:15Z',
				body: CRAFTED_HTML,
			},
		})
	}
	if (url.includes('etsystatus.com')) {
		return `<?xml version="1.0"?><rss version="2.0"><channel><item><title><![CDATA[Site Issues]]></title><link>https://www.etsystatus.com/incidents/abc</link><pubDate>Wed, 19 Aug 2026 14:57:19 GMT</pubDate><description>Checkout is slow.</description></item></channel></rss>`
	}
	if (url.includes('erank.com')) {
		return `<?xml version="1.0"?><rss version="2.0"><channel>
			<item><title>Australia’s Top Etsy Keywords</title><link>https://help.erank.com/blog/etsy-au</link><pubDate>Fri, 07 Aug 2026 12:00:00 GMT</pubDate><description>What Etsy shoppers search.</description></item>
			<item><title>Amazon’s Top Keywords</title><link>https://help.erank.com/blog/amazon</link><pubDate>Sat, 08 Aug 2026 12:00:00 GMT</pubDate><description>Amazon only.</description></item>
			<item><title>Phish</title><link>https://evil.example/etsy</link><pubDate>Sat, 08 Aug 2026 12:00:00 GMT</pubDate><description>Etsy bait.</description></item>
		</channel></rss>`
	}
	if (url.includes('marketplacepulse.com')) {
		return `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
			<entry><title>Etsy seller fees change</title><link rel="alternate" href="http://www.marketplacepulse.com/articles/etsy-fees"/><updated>2026-09-01T15:10:00Z</updated><summary>Etsy updated fees.</summary></entry>
			<entry><title>Amazon opens seller central</title><link rel="alternate" href="https://www.marketplacepulse.com/articles/amazon"/><updated>2026-09-02T15:10:00Z</updated><summary>A different marketplace.</summary></entry>
		</feed>`
	}
	if (url.includes('valueaddedresource.net')) {
		return `<?xml version="1.0"?><rss version="2.0"><channel><item><title>eBay listing delays</title><link>https://www.valueaddedresource.net/ebay-delays/</link><pubDate>Mon, 21 Sep 2026 12:00:00 GMT</pubDate><description>Not this marketplace.</description></item></channel></rss>`
	}
	if (url.includes('news.google.com')) {
		return `<?xml version="1.0"?><rss version="2.0"><channel>
			<item><title>Etsy adds shared shop access - NBC News</title><link>https://news.google.com/rss/articles/nbc</link><pubDate>Fri, 18 Sep 2026 12:00:00 GMT</pubDate><description>Staff access.</description><source url="https://www.nbcnews.com">NBC News</source></item>
			<item><title>Etsy explains the new fee policy</title><link>https://news.google.com/rss/articles/reuters</link><pubDate>Thu, 17 Sep 2026 12:00:00 GMT</pubDate><description>Fees.</description><source url="https://www.reuters.com">Reuters</source></item>
			<item><title>Warehouse labor costs rise</title><link>https://news.google.com/rss/articles/labor</link><pubDate>Thu, 17 Sep 2026 12:00:00 GMT</pubDate><source url="https://www.reuters.com">Reuters</source></item>
			<item><title>What could the stock do</title><link>https://news.google.com/rss/articles/yahoo</link><pubDate>Fri, 18 Sep 2026 12:00:00 GMT</pubDate><source url="https://finance.yahoo.com">Yahoo Finance</source></item>
		</channel></rss>`
	}
	throw new Error('unexpected url ' + url)
}

function request(port, query) {
	return new Promise((resolve, reject) => {
		const req = http.get(`http://127.0.0.1:${port}/api/news${query || ''}`, (res) => {
			const chunks = []
			res.on('data', (chunk) => chunks.push(chunk))
			res.on('end', () => {
				const text = Buffer.concat(chunks).toString('utf8')
				let body = null
				try {
					body = JSON.parse(text)
				} catch {
					body = text
				}
				resolve({ status: res.statusCode, body })
			})
		})
		req.on('error', reject)
	})
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
	await test('public https rejects loopback, raw IPs, and credentials', () => {
		assert.equal(news.isPublicHttps('https://help.etsy.com/hc/en-us'), true)
		assert.equal(news.isPublicHttps('http://help.etsy.com/x'), false)
		assert.equal(news.isPublicHttps('https://127.0.0.1/x'), false)
		assert.equal(news.isPublicHttps('https://user:pass@help.etsy.com/x'), false)
		assert.equal(news.isPublicHttps('https://169.254.169.254/latest'), false)
	})

	await test('redirects cannot leave https or land on a private host', async () => {
		await assert.rejects(() =>
			news.fetchPublicText('https://example.com/start', {
				request: async () => ({ status: 302, location: 'http://127.0.0.1/secret', body: '' }),
			}),
		)
		const body = await news.fetchPublicText('https://example.com/start', {
			request: async (url) => {
				if (url.endsWith('/start')) return { status: 302, location: '/feed.xml', body: '' }
				return { status: 200, body: '<?xml version="1.0"?><rss version="2.0"></rss>' }
			},
		})
		assert.match(body, /<rss/)
		await assert.rejects(
			() => news.fetchPublicText('https://example.com/blocked', { request: async () => ({ status: 200, location: '', body: '<html>Just a moment...</html>' }) }),
			/unexpected page/,
		)
	})

	await test('Newly Crafted months become separate official updates', () => {
		const items = news.parseNewlyCrafted(
			{ html_url: CRAFTED_URL, updated_at: '2026-09-27T04:07:15Z', body: CRAFTED_HTML },
			NOW,
		)
		assert.equal(items.length, 2)
		assert.equal(items[0].title, 'Shared access to your shop')
		assert.equal(items[0].month, '2026-09')
		assert.equal(items[0].published_at, '2026-09-27T04:07:15.000Z')
		assert.equal(items[0].url, CRAFTED_URL + '#h_sep')
		assert.match(items[0].summary, /teammate/)
		assert.equal(items[1].title, 'Tariffs estimator')
		assert.equal(items[1].published_at, '2026-06-30T12:00:00.000Z')
	})

	await test('help articles keep new posts and recent policy edits, not old how-tos', () => {
		const created = JSON.parse(fixtures('https://help.etsy.com/api/v2/help_center/en-us/articles.json?sort_by=created_at'))
		const updated = JSON.parse(fixtures('https://help.etsy.com/api/v2/help_center/en-us/articles.json?sort_by=updated_at'))
		const items = news.parseHelpPayload(created, updated, NOW)
		const titles = items.map((item) => item.title).sort()
		assert.deepEqual(titles, ['Etsy adds shared shop access', 'Etsy fee schedule'])
		const fee = items.find((item) => item.title === 'Etsy fee schedule')
		assert.equal(fee.published_at, '2026-09-20T00:00:00.000Z')
	})

	await test('query rejects unknown window and kind', () => {
		assert.equal(news.parseNewsQuery({ window: '2' }).error, 'window must be 7, 30, 90, or 180')
		assert.equal(news.parseNewsQuery({ kind: 'rumor' }).error, 'kind must be all, official, status, research, analysis, or press')
		assert.deepEqual(news.parseNewsQuery({}), { windowDays: 90, kind: 'all', refresh: false })
		assert.equal(news.parseNewsQuery({ refresh: '1' }).refresh, true)
	})

	await test('briefing keeps Etsy items from vetted sources and drops the rest', async () => {
		const seen = []
		const service = news.createBriefingService({
			now: () => NOW,
			fetchText: async (url) => {
				seen.push(url)
				return fixtures(url)
			},
		})
		const loaded = await service.load({ refresh: true })
		assert.ok(seen.every((url) => url.startsWith('https://')))
		assert.equal(loaded.sources.filter((source) => source.ok).length, news.SOURCES.length)
		const titles = loaded.items.map((item) => item.title)
		assert.ok(titles.includes('Shared access to your shop'))
		assert.ok(titles.includes('Tariffs estimator'))
		assert.ok(titles.includes('Etsy fee schedule'))
		assert.ok(titles.includes('Australia’s Top Etsy Keywords'))
		assert.ok(titles.includes('Etsy seller fees change'))
		assert.ok(titles.includes('Site Issues'))
		assert.ok(!titles.includes('Amazon’s Top Keywords'))
		assert.ok(!titles.includes('Amazon opens seller central'))
		assert.ok(!titles.includes('eBay listing delays'))
		assert.ok(!titles.includes('Phish'))
		assert.ok(!titles.includes('What could the stock do'))
		assert.ok(!titles.includes('Warehouse labor costs rise'))
		const shared = loaded.items.filter((item) => item.title === 'Etsy adds shared shop access')
		assert.equal(shared.length, 1)
		assert.equal(shared[0].kind, 'official')
		assert.equal(shared[0].source_name, 'Etsy Help Center')
		const pulse = loaded.items.find((item) => item.title === 'Etsy seller fees change')
		assert.equal(pulse.url, 'https://www.marketplacepulse.com/articles/etsy-fees')
		const press = loaded.items.find((item) => item.source_name === 'Reuters')
		assert.ok(press)
		assert.equal(press.kind, 'press')

		const week = news.filterBriefing(loaded, { windowDays: 7, kind: 'all', now: NOW })
		assert.ok(week.items.some((item) => item.title === 'Shared access to your shop'))
		assert.ok(!week.items.some((item) => item.title === 'Tariffs estimator'))
		const official = news.filterBriefing(loaded, { windowDays: 90, kind: 'official', now: NOW })
		assert.ok(official.items.every((item) => item.kind === 'official'))
		assert.equal(official.note.includes('Shop Manager'), true)
	})

	await test('a fresh saved briefing is reused, and a failed source keeps its last items', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etsy-news-'))
		let calls = 0
		let statusDown = false
		const clock = { t: NOW }
		const fetchText = async (url) => {
			calls++
			if (statusDown && url.includes('etsystatus.com')) throw new Error('timeout')
			return fixtures(url)
		}
		const first = news.createBriefingService({ cacheDir: dir, now: () => clock.t, fetchText })
		const opened = await first.load()
		assert.ok(opened.items.some((item) => item.source_id === 'etsy-status'))
		const afterOpen = calls
		const second = news.createBriefingService({ cacheDir: dir, now: () => clock.t, fetchText })
		await second.load()
		assert.equal(calls, afterOpen)

		statusDown = true
		clock.t += 31 * 60 * 1000
		const refreshed = await second.load({ refresh: true })
		assert.equal(refreshed.stale, true)
		assert.ok(refreshed.items.some((item) => item.source_id === 'etsy-status'))
		assert.equal(refreshed.sources.find((source) => source.id === 'etsy-status').ok, false)
		assert.equal(refreshed.sources.find((source) => source.id === 'etsy-status').error, 'timeout')
		fs.rmSync(dir, { recursive: true, force: true })
	})

	await test('the route validates the query and does not accept a client URL', async () => {
		const app = express()
		const loads = []
		installRoutes(app, {
			service: {
				async load(opts) {
					loads.push(opts)
					return {
						fetched_at: Date.now(),
						stale: false,
						items: [
							{
								id: 'help:1',
								title: 'Shared access',
								url: 'https://help.etsy.com/hc/en-us/articles/1',
								published_at: new Date().toISOString(),
								summary: 'Invite staff.',
								source_id: 'etsy-help',
								source_name: 'Etsy Help Center',
								kind: 'official',
								press_source_url: 'https://should-not-leak.example',
							},
						],
						sources: [{ id: 'etsy-help', name: 'Etsy Help Center', ok: true, item_count: 1 }],
					}
				},
			},
		})
		const server = await new Promise((resolve) => {
			const handle = app.listen(0, '127.0.0.1', () => resolve(handle))
		})
		try {
			const bad = await request(server.address().port, '?window=2')
			assert.equal(bad.status, 400)
			const ok = await request(server.address().port, '?window=7&kind=official&refresh=1')
			assert.equal(ok.status, 200)
			assert.equal(ok.body.items.length, 1)
			assert.equal(ok.body.items[0].press_source_url, undefined)
			assert.equal(loads[0].refresh, true)
			const ignored = await request(server.address().port, '?url=https://evil.example/feed')
			assert.equal(ignored.status, 200)
			assert.equal(ignored.body.items[0].url, 'https://help.etsy.com/hc/en-us/articles/1')
		} finally {
			await new Promise((resolve) => server.close(resolve))
		}
	})

	if (failed) {
		console.error(`\n${failed} failed`)
		process.exit(1)
	}
	console.log('\nPASS — Etsy news briefing')
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
