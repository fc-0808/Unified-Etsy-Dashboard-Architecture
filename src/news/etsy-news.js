'use strict'

/**
 * Daily Etsy seller briefing.
 *
 * Shop Manager is not scraped, and this module never calls the Etsy Open API.
 * It reads a fixed allowlist of public documents:
 *
 *   • Etsy Help Center JSON (official articles + the Newly Crafted changelog)
 *   • Etsy Status RSS (official outages)
 *   • eRank, Marketplace Pulse, and Value Added Resource, kept only when the
 *     item actually mentions Etsy
 *   • Google News, kept only when the outlet is on PRESS_HOSTS
 *
 * A shop's IPFoxy proxy is intentionally not used. Public pages go out on the
 * normal route and, if that fails, through the same local SOCKS listener the
 * exchange-rate feed already falls back to. Item links are checked against the
 * source's own hosts so a feed cannot point the desk at an arbitrary site.
 */

const fs = require('fs')
const https = require('https')
const path = require('path')
const { TRANSPORT_MODES, coerceNetworkTransport } = require('../proxy/transport')

const FRESH_MS = 30 * 60 * 1000
const MAX_AGE_MS = 200 * 24 * 60 * 60 * 1000
const HELP_EDIT_MS = 45 * 24 * 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 12000
const MAX_BYTES = 1_500_000
const MAX_ITEMS_PER_SOURCE = 60
const MAX_ITEMS_RESPONSE = 100
const CACHE_VERSION = 1
const CACHE_FILE = 'etsy-news.json'
const NEWLY_CRAFTED_ID = 10603291042967

const HELP_CREATED_URL =
	'https://help.etsy.com/api/v2/help_center/en-us/articles.json?sort_by=created_at&sort_order=desc&per_page=100'
const HELP_UPDATED_URL =
	'https://help.etsy.com/api/v2/help_center/en-us/articles.json?sort_by=updated_at&sort_order=desc&per_page=30'
const HELP_CRAFTED_URL =
	`https://help.etsy.com/api/v2/help_center/en-us/articles/${NEWLY_CRAFTED_ID}.json`

const WINDOWS = Object.freeze([7, 30, 90, 180])
const KINDS = Object.freeze(['all', 'official', 'status', 'research', 'analysis', 'press'])

const MONTHS = Object.freeze({
	january: 0,
	february: 1,
	march: 2,
	april: 3,
	may: 4,
	june: 5,
	july: 6,
	august: 7,
	september: 8,
	october: 9,
	november: 10,
	december: 11,
})

/** Old help articles are noisy. A recent edit is kept only when the title is a policy change, not a how-to. */
const HELP_EDIT_RE =
	/\b(fee schedule|new requirement|requirements for|tariff|tariffs|epr|directive|vacation mode|shared access|star seller|offsite ads|purchase protection)\b/i
const HELP_HOWTO_RE = /^(how|what|why|where|when|can i)\b/i

/**
 * Newsrooms and specialist seller publications. Google News is the transport;
 * this list is the editorial filter. Finance-column speculation and SEO blogs
 * are left off on purpose.
 */
const PRESS_HOSTS = Object.freeze([
	'apnews.com',
	'reuters.com',
	'bloomberg.com',
	'wsj.com',
	'nytimes.com',
	'washingtonpost.com',
	'ft.com',
	'theguardian.com',
	'bbc.com',
	'bbc.co.uk',
	'cnn.com',
	'nbcnews.com',
	'abcnews.go.com',
	'cbsnews.com',
	'usatoday.com',
	'npr.org',
	'axios.com',
	'cnbc.com',
	'fortune.com',
	'forbes.com',
	'businessinsider.com',
	'theverge.com',
	'techcrunch.com',
	'wired.com',
	'arstechnica.com',
	'pymnts.com',
	'digitalcommerce360.com',
	'modernretail.co',
	'practicalecommerce.com',
	'ecommercebytes.com',
	'retailbrew.com',
	'marketplace.org',
	'valueaddedresource.net',
	'marketplacepulse.com',
])

const PRESS_URL =
	'https://news.google.com/rss/search?q=' +
	encodeURIComponent('Etsy (seller OR fees OR policy OR payments OR "Star Seller" OR search OR advertising) when:30d') +
	'&hl=en-US&gl=US&ceid=US:en'

const KIND_RANK = Object.freeze({
	official: 5,
	status: 4,
	analysis: 3,
	research: 2,
	press: 1,
})

const SOURCES = Object.freeze([
	Object.freeze({
		id: 'etsy-help',
		name: 'Etsy Help Center',
		kind: 'official',
		home: `https://help.etsy.com/hc/en-us/articles/${NEWLY_CRAFTED_ID}`,
		reliability: 'Official Etsy Help Center, including the Newly Crafted seller changelog.',
	}),
	Object.freeze({
		id: 'etsy-status',
		name: 'Etsy Status',
		kind: 'status',
		url: 'https://www.etsystatus.com/history.rss',
		linkHosts: Object.freeze(['etsystatus.com']),
		home: 'https://www.etsystatus.com/',
		reliability: "Etsy's own status page for outages and incidents.",
	}),
	Object.freeze({
		id: 'erank',
		name: 'eRank',
		kind: 'research',
		url: 'https://help.erank.com/feed/',
		linkHosts: Object.freeze(['erank.com']),
		requireEtsy: true,
		home: 'https://help.erank.com/blog/',
		reliability: 'eRank publishes Etsy search and trend reports. Posts that do not mention Etsy are left out.',
	}),
	Object.freeze({
		id: 'marketplace-pulse',
		name: 'Marketplace Pulse',
		kind: 'analysis',
		url: 'https://www.marketplacepulse.com/articles/recent.atom',
		linkHosts: Object.freeze(['marketplacepulse.com']),
		requireEtsy: true,
		home: 'https://www.marketplacepulse.com/',
		reliability: 'Independent marketplace research. Only articles that mention Etsy are kept.',
	}),
	Object.freeze({
		id: 'value-added-resource',
		name: 'Value Added Resource',
		kind: 'analysis',
		url: 'https://www.valueaddedresource.net/rss/',
		linkHosts: Object.freeze(['valueaddedresource.net']),
		requireEtsy: true,
		home: 'https://www.valueaddedresource.net/',
		reliability: 'Seller-policy reporting. Only articles that mention Etsy are kept.',
	}),
	Object.freeze({
		id: 'press',
		name: 'Press',
		kind: 'press',
		url: PRESS_URL,
		linkHosts: Object.freeze(['news.google.com']),
		home: PRESS_URL,
		reliability: 'Google News results limited to a fixed list of newsrooms.',
	}),
])

function hostAllowed(hostname, hosts) {
	const host = String(hostname || '').toLowerCase().replace(/\.$/, '')
	return hosts.some((allowed) => host === allowed || host.endsWith('.' + allowed))
}

function isPublicHttps(urlString) {
	let url
	try {
		url = new URL(urlString)
	} catch {
		return false
	}
	if (url.username || url.password) return false
	if (url.protocol !== 'https:') return false
	const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
	if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false
	if (host.includes(':')) return false
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false
	if (!/^[a-z0-9.-]+$/.test(host) || !host.includes('.')) return false
	return true
}

function decodeEntities(value) {
	return String(value || '')
		.replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
			const code = parseInt(hex, 16)
			return Number.isFinite(code) ? String.fromCodePoint(code) : ''
		})
		.replace(/&#(\d+);/g, (_, dec) => {
			const code = Number(dec)
			return Number.isFinite(code) ? String.fromCodePoint(code) : ''
		})
		.replace(/&quot;/g, '"')
		.replace(/&apos;|&#39;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&')
		.replace(/&nbsp;/g, ' ')
}

function cleanText(value) {
	const withoutCdata = String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
	const stripped = withoutCdata
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
	return decodeEntities(stripped).replace(/\s+/g, ' ').trim()
}

function clip(text, max) {
	const clean = cleanText(text)
	if (clean.length <= max) return clean
	const cut = clean.slice(0, max - 1)
	const space = cut.lastIndexOf(' ')
	return (space > 80 ? cut.slice(0, space) : cut).trimEnd() + '…'
}

function mentionsEtsy(item) {
	return /\betsy\b/i.test(`${item.title || ''} ${item.summary || ''}`)
}

function tagText(block, names) {
	for (const name of names) {
		const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i')
		const match = block.match(re)
		if (match) return cleanText(match[1])
	}
	return ''
}

function rssLink(block) {
	const text = block.match(/<link>([\s\S]*?)<\/link>/i)
	if (text) return cleanText(text[1])
	const href = block.match(/<link\b[^>]*\bhref="([^"]+)"/i)
	return href ? decodeEntities(href[1]) : ''
}

function atomLink(block) {
	let fallback = ''
	for (const tag of block.matchAll(/<link\b([^>]*)\/?>/gi)) {
		const attrs = tag[1]
		const href = (attrs.match(/\bhref="([^"]+)"/i) || [])[1]
		if (!href) continue
		const rel = (attrs.match(/\brel="([^"]+)"/i) || [])[1] || 'alternate'
		const decoded = decodeEntities(href)
		if (rel === 'alternate') return decoded
		if (!fallback) fallback = decoded
	}
	return fallback
}

function parseWhen(value) {
	const ms = Date.parse(String(value || '').trim())
	return Number.isFinite(ms) ? new Date(ms).toISOString() : ''
}

function withinAge(iso, now) {
	const ms = Date.parse(iso)
	if (!Number.isFinite(ms)) return false
	if (ms > now + 36 * 60 * 60 * 1000) return false
	return now - ms <= MAX_AGE_MS
}

function normalizeItemLink(raw, hosts) {
	if (!raw) return ''
	let url
	try {
		url = new URL(raw.trim())
	} catch {
		return ''
	}
	if (url.protocol === 'http:' && hostAllowed(url.hostname, hosts)) url.protocol = 'https:'
	if (!isPublicHttps(url.toString())) return ''
	if (!hostAllowed(url.hostname, hosts)) return ''
	for (const key of [...url.searchParams.keys()]) {
		if (key.toLowerCase().startsWith('utm_')) url.searchParams.delete(key)
	}
	return url.toString()
}

function parseFeed(xml, source) {
	const body = String(xml || '').replace(/^\uFEFF/, '')
	const atom = /<feed[\s>]/i.test(body) && /http:\/\/www\.w3\.org\/2005\/Atom/i.test(body)
	const blocks = atom
		? [...body.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)]
		: [...body.matchAll(/<item\b[\s\S]*?<\/item>/gi)]
	if (!blocks.length && !/<(rss|feed)\b/i.test(body)) {
		const err = new Error('unreadable feed')
		throw err
	}
	const items = []
	for (const match of blocks) {
		const block = match[0]
		const title = clip(tagText(block, ['title']), 300)
		if (!title) continue
		const rawLink = atom ? atomLink(block) : rssLink(block)
		const url = normalizeItemLink(rawLink, source.linkHosts)
		if (!url) continue
		const published = parseWhen(
			tagText(block, atom ? ['published', 'updated'] : ['pubDate', 'dc:date', 'updated']),
		)
		if (!published) continue
		const summary = clip(tagText(block, ['description', 'summary', 'content:encoded', 'content']), 360)
			.replace(/\s*The post [\s\S]+? appeared first on [\s\S]+$/i, '')
			.trim()
		const sourceTag = block.match(/<source\b([^>]*)>([\s\S]*?)<\/source>/i)
		const sourceUrl = sourceTag ? decodeEntities((sourceTag[1].match(/\burl="([^"]+)"/i) || [])[1] || '') : ''
		const sourceName = sourceTag ? cleanText(sourceTag[2]) : ''
		items.push({
			id: `${source.id}:${url}`,
			title,
			url,
			published_at: published,
			summary,
			source_id: source.id,
			source_name: source.kind === 'press' && sourceName ? sourceName : source.name,
			kind: source.kind,
			press_source_url: sourceUrl,
		})
	}
	return items
}

function parseMonthHeading(text) {
	const match = String(text || '')
		.trim()
		.match(/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})$/i)
	if (!match) return null
	const name = match[1]
	const year = Number(match[2])
	const month = MONTHS[name.toLowerCase()]
	const label = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase()
	return { label: `${label} ${year}`, year, month, key: `${year}-${String(month + 1).padStart(2, '0')}` }
}

function endOfMonthIso(year, monthIndex) {
	return new Date(Date.UTC(year, monthIndex + 1, 0, 12, 0, 0)).toISOString()
}

/**
 * Newly Crafted is one living article. Month headings are h2; each seller-facing
 * change under them is an h3. The newest month is dated from the article's
 * updated_at so a refresh today sorts to the top. Older months use the last
 * day of that month, which is when that section was current.
 */
function parseNewlyCrafted(article, now = Date.now()) {
	const body = String((article && article.body) || '')
	const pageUrl = String((article && (article.html_url || article.url)) || '')
	const updated = parseWhen(article && (article.updated_at || article.edited_at))
	const marks = []
	for (const match of body.matchAll(/<(h2|h3)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
		marks.push({
			tag: match[1].toLowerCase(),
			attrs: match[2] || '',
			text: cleanText(match[3]),
			index: match.index,
			end: match.index + match[0].length,
		})
	}
	let month = null
	let newestKey = ''
	for (const mark of marks) {
		if (mark.tag !== 'h2') continue
		const parsed = parseMonthHeading(mark.text)
		if (parsed) {
			newestKey = parsed.key
			break
		}
	}
	const items = []
	for (let i = 0; i < marks.length; i++) {
		const mark = marks[i]
		if (mark.tag === 'h2') {
			const parsed = parseMonthHeading(mark.text)
			if (parsed) month = parsed
			continue
		}
		if (!month || !mark.text) continue
		const next = marks[i + 1]
		const chunk = body.slice(mark.end, next ? next.index : body.length)
		const paragraphs = [...chunk.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((part) => cleanText(part[1])).filter(Boolean)
		const idMatch = mark.attrs.match(/\bid="([^"]+)"/)
		const anchor = idMatch ? `#${idMatch[1]}` : ''
		const url = normalizeItemLink(pageUrl, ['help.etsy.com'])
		if (!url) continue
		const published = month.key === newestKey && updated ? updated : endOfMonthIso(month.year, month.month)
		if (!withinAge(published, now)) continue
		items.push({
			id: `crafted:${idMatch ? idMatch[1] : month.key + ':' + mark.text}`,
			title: clip(mark.text, 300),
			url: url + anchor,
			published_at: published,
			month: month.key,
			summary: clip(paragraphs.join(' '), 360),
			source_id: 'etsy-help',
			source_name: 'Etsy Help Center',
			kind: 'official',
		})
	}
	return items
}

function helpUrl(article) {
	return normalizeItemLink(article && (article.html_url || article.url), ['help.etsy.com'])
}

function keepCreatedHelp(article, now) {
	if (!article || article.draft || Number(article.id) === NEWLY_CRAFTED_ID) return false
	const created = Date.parse(article.created_at || '')
	if (!Number.isFinite(created)) return false
	return now - created <= MAX_AGE_MS && now - created >= -36 * 60 * 60 * 1000
}

function keepEditedHelp(article, now) {
	if (!article || article.draft || Number(article.id) === NEWLY_CRAFTED_ID) return false
	const updated = Date.parse(article.updated_at || article.edited_at || '')
	if (!Number.isFinite(updated)) return false
	if (now - updated > HELP_EDIT_MS || updated > now + 36 * 60 * 60 * 1000) return false
	const title = String(article.title || article.name || '')
	if (HELP_HOWTO_RE.test(title)) return false
	return HELP_EDIT_RE.test(title)
}

function helpItem(article, publishedAt) {
	const url = helpUrl(article)
	const title = clip(article.title || article.name || '', 300)
	const published = parseWhen(publishedAt)
	if (!url || !title || !published) return null
	const paragraphs = [...String(article.body || '').matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
		.map((part) => cleanText(part[1]))
		.filter((text) => text && !/^quick answer:?$/i.test(text))
	return {
		id: `help:${article.id}`,
		title,
		url,
		published_at: published,
		summary: clip(paragraphs[0] || '', 360),
		source_id: 'etsy-help',
		source_name: 'Etsy Help Center',
		kind: 'official',
	}
}

function parseHelpPayload(createdPayload, updatedPayload, now = Date.now()) {
	const created = (createdPayload && createdPayload.articles) || []
	const updated = (updatedPayload && updatedPayload.articles) || []
	const byId = new Map()
	for (const article of created) {
		if (!keepCreatedHelp(article, now)) continue
		const item = helpItem(article, article.created_at)
		if (item) byId.set(article.id, item)
	}
	for (const article of updated) {
		if (byId.has(article.id) || !keepEditedHelp(article, now)) continue
		const item = helpItem(article, article.updated_at || article.edited_at)
		if (item) byId.set(article.id, item)
	}
	return [...byId.values()]
}

function stripOutletSuffix(title, sourceName) {
	const suffix = ` - ${sourceName || ''}`
	if (sourceName && title.endsWith(suffix)) return title.slice(0, -suffix.length).trim()
	return title
}

function acceptFeedItems(items, source, now) {
	const accepted = []
	for (const raw of items) {
		if (!withinAge(raw.published_at, now)) continue
		const item = source.kind === 'press'
			? { ...raw, title: stripOutletSuffix(raw.title, raw.source_name) }
			: raw
		if (!item.title) continue
		if (source.requireEtsy && !mentionsEtsy(item)) continue
		if (source.kind === 'press') {
			if (!/\betsy\b/i.test(item.title)) continue
			let sourceHost = ''
			try {
				sourceHost = new URL(item.press_source_url).hostname
			} catch {
				continue
			}
			if (!hostAllowed(sourceHost, PRESS_HOSTS)) continue
		}
		accepted.push(item)
		if (accepted.length >= MAX_ITEMS_PER_SOURCE) break
	}
	return accepted
}

function normTitle(title) {
	return String(title || '')
		.toLowerCase()
		.replace(/&/g, ' and ')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()
}

function dedupeItems(items) {
	const byUrl = new Map()
	for (const item of items) {
		const key = item.url
		const prev = byUrl.get(key)
		if (!prev || (KIND_RANK[item.kind] || 0) > (KIND_RANK[prev.kind] || 0)) byUrl.set(key, item)
	}
	const byTitle = new Map()
	for (const item of byUrl.values()) {
		const key = normTitle(item.title)
		const prev = byTitle.get(key)
		if (!prev || (KIND_RANK[item.kind] || 0) > (KIND_RANK[prev.kind] || 0)) byTitle.set(key, item)
	}
	return [...byTitle.values()].sort((a, b) => {
		const delta = Date.parse(b.published_at) - Date.parse(a.published_at)
		if (delta) return delta
		return a.title.localeCompare(b.title)
	})
}

function sourceStatus(source, extra) {
	return {
		id: source.id,
		name: source.name,
		kind: source.kind,
		home: source.home,
		reliability: source.reliability,
		ok: false,
		error: '',
		item_count: 0,
		...extra,
	}
}

function publicError(err) {
	const msg = String((err && err.message) || '')
	if (/^HTTP \d{3}$/.test(msg)) return msg
	if (msg === 'timeout' || msg === 'unexpected page' || msg === 'unreadable feed' || msg === 'too many redirects' || msg === 'response too large') {
		return msg
	}
	return 'unavailable'
}

function looksLikePayload(body) {
	const start = String(body || '').replace(/^\uFEFF/, '').trimStart().slice(0, 80).toLowerCase()
	return start.startsWith('{') || start.startsWith('[') || start.startsWith('<?xml') || start.startsWith('<rss') || start.startsWith('<feed')
}

function httpsGet(url, { agent, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
	return new Promise((resolve, reject) => {
		const req = https.get(
			url,
			{
				agent,
				headers: {
					'User-Agent': 'Unified-Etsy-Dashboard/1.0',
					Accept: 'application/rss+xml, application/atom+xml, application/xml, application/json, text/xml, */*',
				},
			},
			(res) => {
				const status = res.statusCode || 0
				if ([301, 302, 303, 307, 308].includes(status)) {
					res.resume()
					resolve({ status, location: res.headers.location || '', body: '' })
					return
				}
				const chunks = []
				let size = 0
				res.on('data', (chunk) => {
					size += chunk.length
					if (size > MAX_BYTES) {
						req.destroy()
						reject(new Error('response too large'))
						return
					}
					chunks.push(chunk)
				})
				res.on('end', () => {
					resolve({ status, location: '', body: Buffer.concat(chunks).toString('utf8') })
				})
			},
		)
		req.on('error', (err) => reject(new Error(err.code || err.message || 'unavailable')))
		req.setTimeout(timeoutMs, () => {
			req.destroy()
			reject(new Error('timeout'))
		})
	})
}

async function fetchPublicText(url, { request = httpsGet, agent } = {}) {
	let current = url
	for (let hop = 0; hop < 5; hop++) {
		if (!isPublicHttps(current)) throw new Error('unexpected page')
		const res = await request(current, { agent })
		if ([301, 302, 303, 307, 308].includes(res.status)) {
			if (!res.location) throw new Error('unexpected page')
			current = new URL(res.location, current).href
			continue
		}
		if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`)
		if (!looksLikePayload(res.body)) throw new Error('unexpected page')
		return res.body
	}
	throw new Error('too many redirects')
}

async function socksAgentFor(networkTransport) {
	if (networkTransport == null) return null
	const transport = coerceNetworkTransport(networkTransport)
	if (transport.mode !== TRANSPORT_MODES.LOCAL_SOCKS5) return null
	try {
		const mod = await import('socks-proxy-agent')
		const Agent = mod.SocksProxyAgent || mod.default
		if (!Agent) return null
		const host = transport.local_host === '::1' ? '[::1]' : transport.local_host
		return new Agent(`socks5h://${host}:${transport.local_port}`)
	} catch {
		return null
	}
}

async function fetchSourceText(url, { request, networkTransport } = {}) {
	try {
		return await fetchPublicText(url, { request })
	} catch (directError) {
		const agent = await socksAgentFor(networkTransport)
		if (!agent) throw directError
		return fetchPublicText(url, { request, agent })
	}
}

function readJson(text) {
	try {
		return JSON.parse(String(text || '').replace(/^\uFEFF/, ''))
	} catch {
		const err = new Error('unreadable feed')
		throw err
	}
}

async function collectSources({ fetchText, now = Date.now() }) {
	const results = await Promise.all(
		SOURCES.map(async (source) => {
			try {
				if (source.id === 'etsy-help') {
					const [createdRaw, updatedRaw, craftedRaw] = await Promise.all([
						fetchText(HELP_CREATED_URL),
						fetchText(HELP_UPDATED_URL),
						fetchText(HELP_CRAFTED_URL),
					])
					const crafted = readJson(craftedRaw)
					const items = dedupeItems([
						...parseNewlyCrafted(crafted.article || crafted, now),
						...parseHelpPayload(readJson(createdRaw), readJson(updatedRaw), now),
					]).slice(0, MAX_ITEMS_PER_SOURCE)
					return { source, items, ok: true }
				}
				const xml = await fetchText(source.url)
				const items = acceptFeedItems(parseFeed(xml, source), source, now)
				return { source, items, ok: true }
			} catch (err) {
				return { source, items: [], ok: false, error: publicError(err) }
			}
		}),
	)
	const items = []
	const sources = results.map((result) => {
		items.push(...result.items)
		return sourceStatus(result.source, {
			ok: result.ok,
			error: result.error || '',
			item_count: result.items.length,
		})
	})
	return { items: dedupeItems(items), sources }
}

function stripPrivate(item) {
	return {
		id: item.id,
		title: item.title,
		url: item.url,
		published_at: item.published_at,
		month: item.month || '',
		summary: item.summary || '',
		source_id: item.source_id,
		source_name: item.source_name,
		kind: item.kind,
	}
}

function parseNewsQuery(query) {
	const rawWindow = query.window == null || query.window === '' ? 90 : Number(query.window)
	if (!WINDOWS.includes(rawWindow)) return { error: 'window must be 7, 30, 90, or 180' }
	const kind = query.kind == null || query.kind === '' ? 'all' : String(query.kind)
	if (!KINDS.includes(kind)) return { error: 'kind must be all, official, status, research, analysis, or press' }
	const refresh = query.refresh === '1' || query.refresh === 'true'
	return { windowDays: rawWindow, kind, refresh }
}

function filterBriefing(briefing, { windowDays = 90, kind = 'all', now = Date.now() } = {}) {
	const cutoff = now - windowDays * 24 * 60 * 60 * 1000
	const items = (briefing.items || [])
		.filter((item) => {
			if (kind !== 'all' && item.kind !== kind) return false
			const ms = Date.parse(item.published_at)
			return Number.isFinite(ms) && ms >= cutoff
		})
		.slice(0, MAX_ITEMS_RESPONSE)
		.map(stripPrivate)
	return {
		fetched_at: briefing.fetched_at || null,
		stale: Boolean(briefing.stale),
		window_days: windowDays,
		kind,
		note: 'Gathered from public feeds and the Etsy Help Center. This does not call the Etsy Open API or Shop Manager.',
		sources: briefing.sources || [],
		items,
	}
}

function createBriefingService({
	cacheDir = null,
	networkTransport = null,
	now = Date.now,
	fetchText = null,
	log = () => {},
} = {}) {
	const cachePath = cacheDir ? path.join(cacheDir, CACHE_FILE) : null
	let memory = null
	let inFlight = null

	function readDisk() {
		if (!cachePath) return null
		try {
			const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
			if (!parsed || parsed.version !== CACHE_VERSION || !Array.isArray(parsed.items)) return null
			return {
				fetched_at: Number(parsed.fetched_at) || 0,
				stale: false,
				items: parsed.items,
				sources: Array.isArray(parsed.sources) ? parsed.sources : [],
			}
		} catch (err) {
			if (err.code !== 'ENOENT') log(`[news] could not read the saved briefing: ${err.message}`)
			return null
		}
	}

	function writeDisk(payload) {
		if (!cachePath) return
		try {
			fs.mkdirSync(path.dirname(cachePath), { recursive: true })
			const body = JSON.stringify({
				version: CACHE_VERSION,
				fetched_at: payload.fetched_at,
				items: payload.items,
				sources: payload.sources,
			})
			const tmp = `${cachePath}.${process.pid}.tmp`
			fs.writeFileSync(tmp, body)
			fs.renameSync(tmp, cachePath)
		} catch (err) {
			log(`[news] could not save the briefing: ${err.message}`)
		}
	}

	async function refresh(previous) {
		const transportFetch = (url) => fetchSourceText(url, { request: httpsGet, networkTransport })
		const collected = await collectSources({
			fetchText: fetchText || transportFetch,
			now: now(),
		})
		const failed = new Set(collected.sources.filter((source) => !source.ok).map((source) => source.id))
		let items = collected.items
		let stale = false
		if (previous && failed.size) {
			const kept = previous.items.filter((item) => failed.has(item.source_id))
			if (kept.length) {
				items = dedupeItems([...collected.items, ...kept])
				stale = true
			}
		}
		const payload = {
			fetched_at: now(),
			stale,
			items,
			sources: collected.sources,
		}
		memory = payload
		writeDisk(payload)
		const ok = payload.sources.filter((source) => source.ok).length
		log(`[news] briefing: ${payload.items.length} item(s), ${ok}/${payload.sources.length} sources`)
		return payload
	}

	async function load({ refresh: force = false } = {}) {
		const cached = memory || readDisk()
		if (cached && !memory) memory = cached
		if (!force && cached && now() - cached.fetched_at < FRESH_MS) return cached
		if (!force && inFlight) return inFlight
		const run = refresh(cached).catch((err) => {
			if (cached) return { ...cached, stale: true }
			throw err
		})
		inFlight = run
		try {
			return await run
		} finally {
			if (inFlight === run) inFlight = null
		}
	}

	return { load }
}

module.exports = {
	SOURCES,
	PRESS_HOSTS,
	WINDOWS,
	KINDS,
	NEWLY_CRAFTED_ID,
	isPublicHttps,
	parseFeed,
	parseNewlyCrafted,
	parseHelpPayload,
	parseNewsQuery,
	filterBriefing,
	fetchPublicText,
	createBriefingService,
}
