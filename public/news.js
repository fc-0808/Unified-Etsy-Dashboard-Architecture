'use strict'

/**
 * News tab. The server returns an already-filtered briefing; this file only
 * renders it. Titles and summaries are external text, so they are assigned
 * with textContent and links must already be https.
 */
;(function bootstrapNews(root, factory) {
	if (typeof module === 'object' && module.exports) {
		module.exports = factory
		return
	}
	root.UEDNews = factory(root)
})(typeof window !== 'undefined' ? window : globalThis, function createNews(window) {
	const document = window.document
	const KIND_LABEL = {
		official: 'Official',
		status: 'Status',
		research: 'Research',
		analysis: 'Analysis',
		press: 'Press',
	}

	const state = {
		windowDays: '90',
		kind: 'all',
		payload: null,
		loading: false,
		loadedAt: 0,
		queued: null,
	}

	function $(id) {
		return document.getElementById(id)
	}

	function el(tag, className, text) {
		const node = document.createElement(tag)
		if (className) node.className = className
		if (text != null) node.textContent = text
		return node
	}

	function locale() {
		return window.I18N && window.I18N.get && window.I18N.get() === 'zh' ? 'zh-CN' : 'en-US'
	}

	function safeUrl(value) {
		try {
			const url = new URL(String(value || ''))
			if (url.protocol !== 'https:') return ''
			return url.toString()
		} catch {
			return ''
		}
	}

	function formatWhen(item) {
		if (item.month && /^\d{4}-\d{2}$/.test(item.month)) {
			const [year, month] = item.month.split('-').map(Number)
			return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString(locale(), {
				month: 'long',
				year: 'numeric',
				timeZone: 'UTC',
			})
		}
		const ms = Date.parse(item.published_at || '')
		if (!Number.isFinite(ms)) return ''
		return new Date(ms).toLocaleDateString(locale(), { month: 'short', day: 'numeric', year: 'numeric' })
	}

	function setBusy(busy) {
		const button = $('newsRefreshBtn')
		if (button) button.disabled = busy
		const list = $('newsList')
		if (list) list.setAttribute('aria-busy', busy ? 'true' : 'false')
	}

	function showState(mode, message) {
		const panel = $('newsPageState')
		const list = $('newsList')
		if (!panel || !list) return
		if (mode === 'ready') {
			panel.hidden = true
			list.hidden = false
			return
		}
		panel.hidden = false
		panel.classList.toggle('is-error', mode === 'error')
		panel.textContent = message
		if (mode === 'error' || !state.payload) list.hidden = true
	}

	function renderStatus(payload, mode) {
		const box = $('newsStatus')
		const title = $('newsStatusTitle')
		const detail = $('newsStatusDetail')
		const count = $('newsCount')
		if (!box || !title || !detail || !count) return
		box.classList.remove('is-ready', 'is-stale', 'is-error')
		if (mode === 'error') {
			box.classList.add('is-error')
			title.textContent = 'Could not load the briefing'
			detail.textContent = 'Refresh to try again'
			count.textContent = ''
			return
		}
		if (mode === 'loading' && !payload) {
			title.textContent = 'Loading the briefing…'
			detail.textContent = 'Checking official and saved sources'
			count.textContent = ''
			return
		}
		const sources = (payload && payload.sources) || []
		const ok = sources.filter((source) => source.ok).length
		const items = (payload && payload.items) || []
		if (payload && payload.stale) box.classList.add('is-stale')
		else box.classList.add('is-ready')
		title.textContent = payload && payload.stale ? 'Saved copy — refresh to try again' : 'Up to date'
		detail.textContent = sources.length ? `${ok} of ${sources.length} sources updated` : ''
		if (payload && payload.stale) detail.textContent = 'Some sources are showing their last saved items'
		count.textContent = `${items.length} updates`
	}

	function renderSources(sources) {
		const host = $('newsSources')
		if (!host) return
		host.replaceChildren()
		for (const source of sources || []) {
			const row = el('div', 'news-source' + (source.ok ? '' : ' is-down'))
			const name = el('div')
			const label = el('span', 'news-source-name', source.name || source.id)
			const home = safeUrl(source.home)
			if (home) {
				const link = el('a', null, source.name || source.id)
				link.href = home
				link.target = '_blank'
				link.rel = 'noopener noreferrer'
				label.replaceChildren(link)
			}
			name.appendChild(label)
			const meta = source.ok ? `${source.item_count || 0} collected` : source.error || 'unavailable'
			name.appendChild(el('span', 'news-source-meta', meta))
			row.appendChild(name)
			if (source.reliability) row.appendChild(el('div', null, source.reliability))
			host.appendChild(row)
		}
	}

	function renderItems(items) {
		const list = $('newsList')
		if (!list) return
		list.replaceChildren()
		if (!items.length) {
			showState('empty', 'No updates in this window')
			return
		}
		showState('ready')
		for (const item of items) {
			const card = el('article', 'news-card')
			const top = el('div', 'news-card-top')
			const kindKey = Object.prototype.hasOwnProperty.call(KIND_LABEL, item.kind) ? item.kind : 'official'
			top.appendChild(el('span', `news-kind news-kind--${kindKey}`, KIND_LABEL[kindKey]))
			top.appendChild(el('span', null, item.source_name || ''))
			const when = formatWhen(item)
			if (when) top.appendChild(el('span', null, when))
			card.appendChild(top)
			const heading = el('h3')
			const href = safeUrl(item.url)
			if (href) {
				const link = el('a', null, item.title || '')
				link.href = href
				link.target = '_blank'
				link.rel = 'noopener noreferrer'
				heading.appendChild(link)
			} else {
				heading.textContent = item.title || ''
			}
			card.appendChild(heading)
			if (item.summary) card.appendChild(el('p', 'news-summary', item.summary))
			list.appendChild(card)
		}
	}

	function renderBriefing(payload, mode) {
		state.payload = payload
		renderStatus(payload, mode)
		if (mode === 'error') {
			showState('error', 'Could not load the briefing')
			return
		}
		if (mode === 'loading' && !payload) {
			showState('loading', 'Loading the briefing…')
			return
		}
		renderItems((payload && payload.items) || [])
		renderSources((payload && payload.sources) || [])
	}

	async function load(options) {
		const force = Boolean(options && options.refresh)
		if (state.loading) {
			state.queued = options || {}
			return
		}
		state.loading = true
		setBusy(true)
		if (!state.payload) renderBriefing(null, 'loading')
		const params = new URLSearchParams({
			window: state.windowDays,
			kind: state.kind,
		})
		if (force) params.set('refresh', '1')
		try {
			const res = await window.fetch('/api/news?' + params.toString(), { credentials: 'same-origin' })
			const text = await res.text()
			let body = null
			try {
				body = text ? JSON.parse(text) : null
			} catch {
				body = null
			}
			if (!res.ok || !body || !Array.isArray(body.items)) {
				renderBriefing(state.payload, 'error')
				return
			}
			state.loadedAt = Date.now()
			renderBriefing(body, 'ready')
		} catch {
			renderBriefing(state.payload, 'error')
		} finally {
			state.loading = false
			setBusy(false)
			if (state.queued) {
				const next = state.queued
				state.queued = null
				await load(next)
			}
		}
	}

	function bind() {
		const windowSelect = $('newsWindow')
		const kindSelect = $('newsKind')
		const refresh = $('newsRefreshBtn')
		if (windowSelect && !windowSelect.dataset.newsBound) {
			windowSelect.dataset.newsBound = '1'
			windowSelect.addEventListener('change', () => {
				state.windowDays = windowSelect.value
				void load()
			})
		}
		if (kindSelect && !kindSelect.dataset.newsBound) {
			kindSelect.dataset.newsBound = '1'
			kindSelect.addEventListener('change', () => {
				state.kind = kindSelect.value
				void load()
			})
		}
		if (refresh && !refresh.dataset.newsBound) {
			refresh.dataset.newsBound = '1'
			refresh.addEventListener('click', () => {
				void load({ refresh: true })
			})
		}
	}

	function open() {
		bind()
		const fresh = state.loadedAt && Date.now() - state.loadedAt < 30 * 60 * 1000
		if (!fresh) return load()
	}

	return { open, load, renderBriefing, safeUrl }
})
