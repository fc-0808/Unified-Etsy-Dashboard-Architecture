'use strict'

/**
 * UED Supplies tab — packing materials used to ship orders (boxes, stickers,
 * mailers, tape…). Daily count is a focused shelf walk: photo first, then
 * Looks right / Need to buy. Flagged buys surface on Orders. The owner
 * confirms them with Mark purchased (order placed) or Restock (boxes arrived).
 * Restock snapshots the price paid so Activity can total a month or custom
 * range. Each SKU can store a shop link; on a phone that link stays in-tab
 * so Taobao / 1688 can hand off to the app. Automatic reorder-point
 * looks right until an employee taps Need to buy. Employees share catalog
 * write with the owner (names, photos, prices, links, add/retire). The owner
 * still confirms Mark purchased and sees period spend totals.
 */
;(function bootstrapSupplies(root, factory) {
	if (typeof module === 'object' && module.exports) {
		module.exports = factory
		return
	}
	const api = factory(root)
	root.UEDSupplies = api
	if (root.document && typeof api.refreshAlerts === 'function') {
		if (root.document.readyState === 'loading') {
			root.document.addEventListener('DOMContentLoaded', () => api.refreshAlerts())
		} else {
			api.refreshAlerts()
		}
	}
})(typeof window !== 'undefined' ? window : globalThis, function createSupplies(window) {
	const document = window.document

	const state = {
		mounted: false,
		view: 'inventory',
		counting: false,
		categories: [],
		items: [],
		alerts: null,
		countSession: null,
		countEditItemId: null,
		restockItemId: null,
		includeArchived: false,
		filterQ: '',
		filterCategory: '',
		filterFamily: '',
		filterNeedsPurchase: false,
		purchaseQueueOpen: false,
		filterCountPending: false,
		familiesByCategory: {},
		replacePhotoItemId: null,
		pendingCatalogPhoto: null,
		catalogPreviewUrl: null,
		menuItemId: null,
		menuToggle: null,
		spendPreset: 'this-month',
		spend: null,
	}

	const NAME_MAX_LEN = 120
	const rename = {
		commit: null,
		suppressCardClick: false,
		suppressTimer: 0,
	}

	function $(id) {
		return document.getElementById(id)
	}

	function isOwner() {
		const auth = window.__AUTH
		if (auth && typeof auth.role === 'string' && auth.role && auth.role !== 'owner') return false
		if (auth && auth.role === 'owner') return true
		if (auth && Array.isArray(auth.capabilities) && auth.capabilities.includes('*')) return true
		return typeof window.ROLE !== 'undefined' && window.ROLE.can && window.ROLE.can('listings:manage')
	}

	function canManageCatalog() {
		const auth = window.__AUTH
		if (auth && Array.isArray(auth.capabilities) && (auth.capabilities.includes('*') || auth.capabilities.includes('supplies:manage'))) {
			return true
		}
		if (typeof window.ROLE !== 'undefined' && window.ROLE.can) {
			if (window.ROLE.can('supplies:manage') || window.ROLE.can('listings:manage')) return true
		}
		return isOwner()
	}

	async function api(path, options = {}) {
		const opts = {
			credentials: 'same-origin',
			headers: { ...(options.headers || {}) },
			...options,
		}
		if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof window.FormData)) {
			opts.headers['Content-Type'] = 'application/json'
			opts.body = JSON.stringify(opts.body)
		}
		const res = await window.fetch(path, opts)
		const text = await res.text()
		let data = null
		try {
			data = text ? JSON.parse(text) : null
		} catch {
			data = { error: text || 'Bad response' }
		}
		if (!res.ok) {
			const err = new Error((data && data.error) || `Request failed (${res.status})`)
			err.status = res.status
			err.data = data
			throw err
		}
		return data
	}

	function escapeHtml(s) {
		return String(s ?? '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
	}

	function t(s) {
		if (s == null || s === '') return s
		const i18n = window.I18N
		if (i18n && typeof i18n.t === 'function') return i18n.t(String(s))
		return String(s)
	}

	function safeHttpUrl(url) {
		if (!url || typeof url !== 'string') return null
		try {
			const parsed = new URL(url)
			if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
			return parsed.href
		} catch {
			return null
		}
	}

	function fmtQty(n, uom = '') {
		const v = Number(n)
		if (!Number.isFinite(v)) return uom ? `— ${uom}` : '—'
		const s = Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000)
		return uom ? `${s} ${uom}` : s
	}

	function fmtMoney(amount, currency = 'USD') {
		const n = Number(amount)
		if (!Number.isFinite(n)) return null
		const locale = window.I18N && typeof window.I18N.get === 'function' && window.I18N.get() === 'zh' ? 'zh-CN' : undefined
		try {
			return new Intl.NumberFormat(locale, {
				style: 'currency',
				currency: currency || 'USD',
				maximumFractionDigits: 2,
			}).format(n)
		} catch {
			return `${n.toFixed(2)} ${currency || ''}`.trim()
		}
	}

	function isZh() {
		return window.I18N && typeof window.I18N.get === 'function' && window.I18N.get() === 'zh'
	}

	function displayName(item) {
		if (!item) return ''
		if (isZh()) return item.name_zh || t(item.name) || item.name || ''
		return item.name || item.name_zh || ''
	}

	function normalizeTypedName(value) {
		return String(value || '').replace(/\s+/g, ' ').trim()
	}

	function nameMarkup(itemId, label) {
		const shown = escapeHtml(label)
		if (!canManageCatalog()) {
			return `<strong class="sup-name" data-i18n-skip>${shown}</strong>`
		}
		const hint = escapeHtml(t('Click to rename'))
		return `<button type="button" class="sup-name" data-i18n-skip data-rename="${itemId}" data-stop="1" draggable="false" title="${hint}">${shown}</button>`
	}

	function searchText(item) {
		return [
			item.sku,
			item.name,
			item.name_zh,
			item.category_name,
			item.category_name ? t(item.category_name) : '',
			item.family,
			item.family_name,
			item.family_name ? t(item.family_name) : '',
			item.supplier_name,
			item.notes,
			displayName(item),
		]
			.filter(Boolean)
			.join(' ')
			.toLowerCase()
	}

	const countWriteSeq = new Map()
	let inventoryLoadGen = 0
	let logLoadGen = 0
	let spendLoadGen = 0

	function errorMessage(err) {
		const msg = err && err.message ? err.message : String(err || '')
		return t(msg)
	}

	async function withBusy(el, fn) {
		if (el && (el.disabled || el.dataset.busy === '1')) return false
		if (el) {
			el.dataset.busy = '1'
			el.disabled = true
		}
		try {
			await fn()
			return true
		} finally {
			if (el) {
				el.dataset.busy = ''
				el.disabled = false
			}
		}
	}

	function formatTimestamp(sqliteDate) {
		if (!sqliteDate) return '—'
		const ms = Date.parse(String(sqliteDate).replace(' ', 'T') + 'Z')
		if (!Number.isFinite(ms)) return String(sqliteDate)
		const locale = isZh() ? 'zh-CN' : undefined
		try {
			return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms))
		} catch {
			return new Date(ms).toLocaleString()
		}
	}

	function toast(msg) {
		const text = t(msg)
		if (typeof window.showToast === 'function') {
			window.showToast(text)
			return
		}
		const el = $('supToast')
		if (!el) return
		el.textContent = text
		el.hidden = false
		clearTimeout(toast._t)
		toast._t = setTimeout(() => {
			el.hidden = true
		}, 2400)
	}

	function anyModalOpen() {
		return [...document.querySelectorAll('#suppliesRoot dialog')].some((d) => d.open)
	}

	function photoMarkup(item, { eager = false, detail = false, className = 'sup-photo' } = {}) {
		const src = detail ? item.photo_detail || item.photo_thumb : item.photo_thumb || item.photo_path
		if (!src) return `<div class="${className} placeholder">${escapeHtml(t('No photo'))}</div>`
		const path = item.photo_path || src.split('?')[0]
		const srcset = item.photo_path
			? `${escapeHtml(path)}?w=240 240w, ${escapeHtml(path)}?w=480 480w`
			: ''
		const sizes = detail ? '320px' : '(max-width: 820px) 96px, 128px'
		const loading = eager ? 'eager' : 'lazy'
		const priority = eager ? 'high' : 'low'
		return `<img class="${className}" src="${escapeHtml(src)}"${srcset ? ` srcset="${srcset}" sizes="${sizes}"` : ''} alt="" width="240" height="240" loading="${loading}" fetchpriority="${priority}" decoding="async" />`
	}

	function prefersShopAppHandoff() {
		try {
			return Boolean(window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches)
		} catch {
			return false
		}
	}

	function buyLink(item, labelOrOpts) {
		const href = safeHttpUrl(item && item.supplier_url)
		if (!href) return ''
		const opts = typeof labelOrOpts === 'string' ? { label: labelOrOpts } : labelOrOpts && typeof labelOrOpts === 'object' ? labelOrOpts : {}
		const caption = opts.label || 'Buy'
		const title = item.supplier_name ? `${t('Buy')} · ${item.supplier_name}` : t('Open purchase link')
		const handoff = prefersShopAppHandoff()
		const target = handoff ? '' : ' target="_blank"'
		const variant = opts.variant || 'text'
		let cls = 'sup-buy-open'
		if (variant === 'overlay') cls += ' sup-buy-overlay'
		else if (variant === 'button') cls += ' sup-btn sup-btn-buy-open'
		else cls += ' sup-link'
		return `<a class="${cls}" href="${escapeHtml(href)}"${target} rel="noopener noreferrer" data-stop="1" title="${escapeHtml(title)}">${escapeHtml(t(caption))}</a>`
	}

	function buyOverlayHtml(item) {
		if (!isActiveItem(item)) return ''
		return buyLink(item, { variant: 'overlay', label: 'Buy now' })
	}

	function isActiveItem(item) {
		return Boolean(item && item.active)
	}

	function recordId(rec) {
		return rec && (rec.id || rec.item_id)
	}

	function isCountRecord(rec) {
		return Boolean(rec && Object.prototype.hasOwnProperty.call(rec, 'counted_qty'))
	}

	function formatStepperQty(n) {
		const v = Number(n)
		if (!Number.isFinite(v)) return '—'
		return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000)
	}

	function expectedQty(line) {
		const n = Number(line && line.expected_qty)
		return Number.isFinite(n) ? n : 0
	}

	function isNeedsPurchase(rec) {
		return Number(rec && rec.needs_purchase) === 1 || rec?.needs_purchase === true
	}

	function buyCount(alerts) {
		if (!alerts) return 0
		if (alerts.needs_purchase_count != null) return Number(alerts.needs_purchase_count) || 0
		return (alerts.needs_purchase || []).length
	}

	function lineIsCounted(line) {
		return Boolean(line && line.counted_qty != null)
	}

	function remainingUncountedLines() {
		return ((state.countSession && state.countSession.lines) || []).filter((line) => !lineIsCounted(line))
	}

	function flaggedBuyLines() {
		return ((state.countSession && state.countSession.lines) || []).filter(isNeedsPurchase)
	}

	function isEmptyExpectedUncounted(line) {
		return !lineIsCounted(line) && expectedQty(line) === 0
	}

	function countQtyPillLabel(line) {
		if (lineIsCounted(line)) return t(`Counted ${fmtQty(line.counted_qty, line.uom)}`)
		return t(fmtQty(line.expected_qty, line.uom))
	}

	function countProgressText(p, buyN) {
		const counted = Number(p && p.counted) || 0
		const total = Number(p && p.total) || 0
		const remaining = Number(p && p.remaining) || 0
		const off = Number(p && p.variance_count) || 0
		const n = Number(buyN) || 0
		if (!remaining) {
			if (n && off) return t(`${counted}/${total} checked · ${off} off · ${n} to buy`)
			if (n) return t(`${counted}/${total} checked · ${n} to buy`)
			if (off) return t(`${counted}/${total} checked · ${off} off`)
			return t(`${counted}/${total} checked`)
		}
		if (n && off) return t(`${counted}/${total} checked · ${remaining} left · ${off} off · ${n} to buy`)
		if (n) return t(`${counted}/${total} checked · ${remaining} left · ${n} to buy`)
		if (off) return t(`${counted}/${total} checked · ${remaining} left · ${off} off`)
		return t(`${counted}/${total} checked · ${remaining} left`)
	}

	function peekAdjacentCountItemId(itemId) {
		const id = Number(itemId)
		const cards = [...document.querySelectorAll('#supCountGrid article[data-item-id]')]
		const idx = cards.findIndex((el) => Number(el.dataset.itemId) === id)
		if (idx < 0) return null
		const neighbor = cards[idx + 1] || cards[idx - 1]
		if (!neighbor) return null
		const nextId = Number(neighbor.dataset.itemId)
		return Number.isFinite(nextId) && nextId !== id ? nextId : null
	}

	function focusCountCard(itemId) {
		if (itemId == null) return
		const el = document.querySelector(`#supCountGrid article[data-item-id="${itemId}"]`)
		if (!el || typeof el.focus !== 'function') return
		try {
			el.focus({ preventScroll: true })
		} catch {
			try {
				el.focus()
			} catch {
				/* jsdom */
			}
		}
	}

	function recomputeCountProgress() {
		if (!state.countSession || !Array.isArray(state.countSession.lines)) return
		const lines = state.countSession.lines
		const counted = lines.filter((line) => lineIsCounted(line)).length
		state.countSession.progress = {
			total: lines.length,
			counted,
			remaining: lines.length - counted,
			variance_count: lines.filter((line) => lineIsCounted(line) && Number(line.variance) !== 0).length,
		}
	}

	function countVarianceLabel(line) {
		if (!lineIsCounted(line)) return ''
		const v = Number(line.variance) || 0
		if (v === 0) return t('Looks right')
		const mag = formatStepperQty(Math.abs(v))
		return v > 0 ? t(`${mag} extra`) : t(`${mag} short`)
	}

	function countStatusLabel(line) {
		const flagged = isNeedsPurchase(line)
		const variance = lineIsCounted(line) ? countVarianceLabel(line) : ''
		if (flagged && variance && variance !== t('Looks right')) return `${t('Need to buy')} · ${variance}`
		if (flagged) return t('Need to buy')
		return variance
	}

	function needsPurchaseButtonHtml(rec) {
		const id = recordId(rec)
		if (!id) return ''
		if (isNeedsPurchase(rec)) {
			return `<button type="button" class="sup-btn sup-btn-ghost sup-btn-sm" data-needs-purchase="0" data-item-id="${id}">${escapeHtml(t('Cancel buy'))}</button>`
		}
		return `<button type="button" class="sup-btn sup-btn-ghost sup-btn-sm sup-btn-remind" data-needs-purchase="1" data-item-id="${id}">${escapeHtml(t('Need to buy'))}</button>`
	}

	function countCheckHtml(line) {
		const buy = needsPurchaseButtonHtml(line)
		if (lineIsCounted(line)) {
			const flagged = isNeedsPurchase(line)
			const off = Number(line.variance) !== 0
			const statusClass = flagged ? ' is-buy' : off ? ' is-off' : ' is-match'
			return `<div class="sup-count-check" data-stop="1">
					<div class="sup-count-status${statusClass}">${escapeHtml(countStatusLabel(line))}</div>
					${buy}
				</div>`
		}
		const match = `<button type="button" class="sup-btn sup-btn-primary sup-btn-sm" data-count-match="${line.item_id}">${escapeHtml(t('Looks right'))}</button>`
		if (isEmptyExpectedUncounted(line)) {
			return `<div class="sup-count-check is-choice-pair is-empty-expected" data-stop="1">
					${match}
					${buy}
				</div>`
		}
		return `<div class="sup-count-check has-none" data-stop="1">
					${match}
					${buy}
					<button type="button" class="sup-btn sup-btn-ghost sup-btn-sm" data-count-none="${line.item_id}">${escapeHtml(t('None'))}</button>
				</div>`
	}

	function ownerMenuToggleHtml(rec) {
		if (!canManageCatalog()) return ''
		const id = recordId(rec)
		if (!id) return ''
		const label = escapeHtml(t('More actions'))
		return `<button type="button" class="sup-menu-toggle" data-menu="${id}" data-stop="1" draggable="false" aria-haspopup="menu" aria-expanded="false" aria-controls="supCardMenu" aria-label="${label}" title="${label}"><span class="sup-menu-dots" aria-hidden="true"></span></button>`
	}

	function ownerMenuItemsHtml(rec) {
		const id = recordId(rec)
		if (!id) return ''
		const counting = isCountRecord(rec)
		const retired = !counting && !isActiveItem(rec)
		const items = [
			`<button type="button" role="menuitem" class="sup-menu-item" data-replace-photo="${id}">${escapeHtml(t('Replace photo'))}</button>`,
			`<button type="button" role="menuitem" class="sup-menu-item" data-edit="${id}">${escapeHtml(t('Edit'))}</button>`,
			`<div class="sup-menu-sep" role="separator"></div>`,
		]
		if (retired) {
			items.push(
				`<button type="button" role="menuitem" class="sup-menu-item" data-restore="${id}">${escapeHtml(t('Restore'))}</button>`,
				`<button type="button" role="menuitem" class="sup-menu-item is-danger" data-purge="${id}">${escapeHtml(t('Delete permanently'))}</button>`,
			)
		} else {
			items.push(
				`<button type="button" role="menuitem" class="sup-menu-item is-danger" data-remove="${id}">${escapeHtml(t('Remove'))}</button>`,
			)
		}
		return items.join('')
	}

	function cardHeadHtml(rec) {
		return `<div class="sup-card-head">
					${nameMarkup(recordId(rec), displayName(rec))}
					${ownerMenuToggleHtml(rec)}
				</div>`
	}

	function cardIdentityAttrs(rec) {
		const label = displayName(rec)
		if (!label) return ''
		const safe = escapeHtml(label)
		return ` aria-label="${safe}" title="${safe}"`
	}

	function inventoryPrimaryHtml(item) {
		if (!isActiveItem(item)) return ''
		return `<div class="sup-card-primary">
					${needsPurchaseButtonHtml(item)}
					<button type="button" class="sup-btn sup-btn-ghost sup-btn-sm" data-restock="${item.id}">${escapeHtml(t('Restock'))}</button>
					${buyLink(item)}
				</div>`
	}

	function countStepperHtml(line) {
		const counted = lineIsCounted(line)
		const shown = counted ? line.counted_qty : line.expected_qty
		const label = countQtyPillLabel(line)
		return `<div class="sup-stepper${counted ? '' : ' is-idle'}" data-stop="1">
					<button type="button" data-count-delta="-1" data-item-id="${line.item_id}" aria-label="${escapeHtml(t('Decrease'))}">−</button>
					<button type="button" class="sup-stepper-val" data-count-edit="${line.item_id}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${escapeHtml(formatStepperQty(shown))}</button>
					<button type="button" data-count-delta="1" data-item-id="${line.item_id}" aria-label="${escapeHtml(t('Increase'))}">+</button>
				</div>`
	}

	function closeCardMenu(restoreFocus) {
		const panel = $('supCardMenu')
		const toggle = state.menuToggle
		if (panel) {
			panel.hidden = true
			panel.innerHTML = ''
			panel.style.left = ''
			panel.style.top = ''
		}
		if (toggle && toggle.isConnected) toggle.setAttribute('aria-expanded', 'false')
		state.menuItemId = null
		state.menuToggle = null
		if (restoreFocus && toggle && toggle.isConnected) {
			try {
				toggle.focus()
			} catch {
				/* jsdom */
			}
		}
	}

	function positionCardMenu(toggle) {
		const panel = $('supCardMenu')
		if (!panel || panel.hidden || !toggle) return
		const rect = toggle.getBoundingClientRect()
		const vw = window.innerWidth || 320
		const vh = window.innerHeight || 480
		const pad = 8
		const mw = Math.max(panel.offsetWidth || 0, 188)
		const mh = panel.offsetHeight || 0
		let left = rect.right - mw
		if (left < pad) left = pad
		if (left + mw > vw - pad) left = Math.max(pad, vw - mw - pad)
		let top = rect.bottom + 4
		if (mh && top + mh > vh - pad && rect.top - 4 - mh >= pad) top = rect.top - 4 - mh
		if (top < pad) top = pad
		panel.style.left = `${Math.round(left)}px`
		panel.style.top = `${Math.round(top)}px`
	}

	function openCardMenu(toggle) {
		if (!canManageCatalog() || !toggle) return
		const itemId = Number(toggle.dataset.menu)
		if (!Number.isFinite(itemId) || itemId <= 0) return
		if (state.menuItemId === itemId && state.menuToggle === toggle) {
			closeCardMenu(true)
			return
		}
		const rec = findRecord(itemId)
		if (!rec) return
		closeCardMenu()
		const panel = $('supCardMenu')
		if (!panel) return
		state.menuItemId = itemId
		state.menuToggle = toggle
		toggle.setAttribute('aria-expanded', 'true')
		panel.setAttribute('aria-label', t('More actions'))
		panel.innerHTML = ownerMenuItemsHtml(rec)
		panel.hidden = false
		positionCardMenu(toggle)
		const first = panel.querySelector('[role="menuitem"]')
		try {
			first?.focus()
		} catch {
			/* jsdom */
		}
	}

	function menuItems() {
		const panel = $('supCardMenu')
		return panel ? [...panel.querySelectorAll('[role="menuitem"]')] : []
	}

	function handleMenuKeydown(e) {
		const items = menuItems()
		if (!items.length) return
		const i = Math.max(0, items.indexOf(e.target))
		if (e.key === 'Escape') {
			e.preventDefault()
			e.stopPropagation()
			closeCardMenu(true)
			return
		}
		if (e.key === 'ArrowDown' || e.key === 'Down') {
			e.preventDefault()
			items[(i + 1) % items.length].focus()
			return
		}
		if (e.key === 'ArrowUp' || e.key === 'Up') {
			e.preventDefault()
			items[(i - 1 + items.length) % items.length].focus()
			return
		}
		if (e.key === 'Home') {
			e.preventDefault()
			items[0].focus()
			return
		}
		if (e.key === 'End') {
			e.preventDefault()
			items[items.length - 1].focus()
			return
		}
		if (e.key === 'Tab') closeCardMenu()
	}

	function mount() {
		const rootEl = $('suppliesRoot')
		if (!rootEl || state.mounted) return
		state.mounted = true
		rootEl.innerHTML = shellHtml()
		wire()
		refreshOwnerBits()
	}

	function shellHtml() {
		return `
			<div class="sup-shell">
				<section class="sup-hero" aria-labelledby="supPageTitle">
					<div class="sup-hero-copy">
						<div class="sup-eyebrow">${escapeHtml(t('Packing operations'))}</div>
						<h2 id="supPageTitle">${escapeHtml(t('Packing supplies'))}</h2>
						<p>${escapeHtml(t('Boxes, stickers, mailers and the other materials we buy to ship orders. Tap Need to buy when something is running low.'))}</p>
					</div>
					<div class="sup-live-panel" id="supLivePanel">
						<div class="sup-live-top">
							<span class="sup-live-dot" aria-hidden="true"></span>
							<div>
								<div class="sup-live-title" id="supLiveTitle">${escapeHtml(t('Stock looks healthy'))}</div>
								<div class="sup-live-detail" id="supLiveDetail">${escapeHtml(t('No submitted count yet.'))}</div>
							</div>
						</div>
						<div class="sup-live-numbers">
							<span id="supLiveItems">—</span>
							<span><strong id="supLiveBuy">—</strong> ${escapeHtml(t('To buy'))}</span>
						</div>
						<div class="sup-live-actions">
							<button type="button" class="sup-btn sup-btn-primary" id="supStartCount">${escapeHtml(t('Start daily count'))}</button>
						</div>
					</div>
				</section>
				<nav class="sup-tabs" role="tablist" aria-label="${escapeHtml(t('Supplies views'))}">
					<button type="button" class="sup-tab active" role="tab" aria-selected="true" data-sup-view="inventory"><span class="sup-tab-label">${escapeHtml(t('Inventory'))}</span></button>
					<button type="button" class="sup-tab" role="tab" aria-selected="false" data-sup-view="log"><span class="sup-tab-label">${escapeHtml(t('Activity'))}</span></button>
				</nav>

				<section class="sup-panel active" data-sup-panel="inventory">
					<div id="supAlertBanner"></div>
					<div class="sup-workspace-pin">
						<div id="supCountBar" class="sup-count-bar" hidden></div>
						<div id="supBuyQueue" class="sup-buy-queue" hidden></div>
						<div class="sup-toolbar">
							<div class="sup-filter-cluster">
								<label class="sup-control sup-search-control">
									<span>${escapeHtml(t('Search'))}</span>
									<input type="search" id="supSearch" placeholder="${escapeHtml(t('Search name, supplier…'))}" autocomplete="off" />
								</label>
								<div class="sup-control sup-category-control">
									<span>${escapeHtml(t('Category'))}</span>
									<div class="sup-chips" id="supCategoryChips"></div>
								</div>
							</div>
							<div class="sup-toolbar-actions">
								<button type="button" class="sup-btn sup-btn-primary catalog-write" id="supNewItem" hidden>${escapeHtml(t('Add supply'))}</button>
								<button type="button" class="sup-chip warn" id="supBuyChip" aria-pressed="false">${escapeHtml(t('To buy'))}</button>
								<button type="button" class="sup-chip catalog-write" id="supArchivedChip" hidden aria-pressed="false">${escapeHtml(t('Show retired'))}</button>
							</div>
						</div>
						<div class="sup-chips sup-family-row" id="supFamilyChips" hidden></div>
					</div>
					<div id="supInventoryGrid" class="sup-catalog"></div>
					<div id="supCountGrid" class="sup-catalog" hidden></div>
				</section>

				<section class="sup-panel" data-sup-panel="log">
					<section id="supSpendPanel" class="sup-spend owner-only" hidden>
						<div class="sup-list-head">
							<div>
								<h3>${escapeHtml(t('Purchase cost'))}</h3>
								<p>${escapeHtml(t('What you paid when boxes arrived.'))}</p>
							</div>
						</div>
						<div class="sup-spend-toolbar">
							<div class="sup-spend-presets" role="group" aria-label="${escapeHtml(t('Purchase cost'))}">
								<button type="button" class="sup-chip active" data-spend-preset="this-month">${escapeHtml(t('This month'))}</button>
								<button type="button" class="sup-chip" data-spend-preset="last-month">${escapeHtml(t('Last month'))}</button>
								<button type="button" class="sup-chip" data-spend-preset="custom">${escapeHtml(t('Custom range'))}</button>
							</div>
							<label class="sup-control">
								<span>${escapeHtml(t('From date'))}</span>
								<input type="date" id="supSpendFrom" />
							</label>
							<label class="sup-control">
								<span>${escapeHtml(t('To date'))}</span>
								<input type="date" id="supSpendTo" />
							</label>
							<button type="button" class="sup-btn sup-btn-primary" id="supSpendApply">${escapeHtml(t('Show spend'))}</button>
						</div>
						<div id="supSpendSummary"></div>
						<div id="supSpendList" class="sup-table-wrap"></div>
					</section>
					<div class="sup-history">
						<section>
							<div class="sup-list-head">
								<div>
									<h3>${escapeHtml(t('Daily counts'))}</h3>
									<p>${escapeHtml(t('Submitted shelf counts and how they moved on-hand stock.'))}</p>
								</div>
							</div>
							<div id="supSessionsList" class="sup-table-wrap"></div>
						</section>
						<section>
							<div class="sup-list-head">
								<div>
									<h3>${escapeHtml(t('Stock movements'))}</h3>
									<p>${escapeHtml(t('Restocks, counts and other quantity changes.'))}</p>
								</div>
							</div>
							<div id="supMovementsList" class="sup-table-wrap"></div>
						</section>
					</div>
				</section>
			</div>

			<dialog id="supCountModal" class="sup-modal">
				<form method="dialog" id="supCountModalForm" class="sup-modal-card">
					<div id="supCountModalPhotoWrap"></div>
					<div class="sup-modal-body">
						<h3 id="supCountModalName" class="sup-name" style="margin:4px 0" data-i18n-skip></h3>
						<p id="supCountModalMeta" class="sup-meta"></p>
						<p id="supCountModalHint" class="sup-meta"></p>
						<div class="sup-count-modal-shortcuts" id="supCountModalShortcuts">
							<button type="button" class="sup-btn sup-btn-primary" id="supCountModalMatch">${escapeHtml(t('Looks right'))}</button>
							<button type="button" class="sup-btn sup-btn-ghost sup-btn-remind" id="supCountModalBuy">${escapeHtml(t('Need to buy'))}</button>
							<button type="button" class="sup-btn sup-btn-ghost" id="supCountModalNone">${escapeHtml(t('None on shelf'))}</button>
						</div>
						<label class="sup-field"><span>${escapeHtml(t('How many are on the shelf?'))}</span><input id="supCountModalQty" type="number" min="0" step="any" required /></label>
						<div class="sup-modal-actions">
							<button type="button" class="sup-btn sup-btn-ghost" id="supCountModalClear">${escapeHtml(t('Clear'))}</button>
							<button type="submit" class="sup-btn sup-btn-primary">${escapeHtml(t('Save count'))}</button>
						</div>
					</div>
					<button type="button" class="sup-modal-close" id="supCountModalClose" aria-label="${escapeHtml(t('Close'))}">×</button>
				</form>
			</dialog>

			<dialog id="supSubmitModal" class="sup-modal">
				<div class="sup-modal-card sup-modal-wide">
					<h3 style="margin:0 0 6px">${escapeHtml(t("Submit today's count?"))}</h3>
					<p id="supSubmitSummary" class="sup-meta"></p>
					<p id="supSubmitPending" class="sup-meta" hidden></p>
					<div id="supSubmitVariances" class="sup-table-wrap"></div>
					<div class="sup-modal-actions">
						<button type="button" class="sup-btn sup-btn-ghost" id="supSubmitMatchRest" hidden>${escapeHtml(t('The rest look right'))}</button>
						<button type="button" class="sup-btn sup-btn-ghost" id="supSubmitCancel">${escapeHtml(t('Back'))}</button>
						<button type="button" class="sup-btn sup-btn-primary" id="supSubmitConfirm">${escapeHtml(t('Confirm submit'))}</button>
					</div>
					<button type="button" class="sup-modal-close" id="supSubmitClose" aria-label="${escapeHtml(t('Close'))}">×</button>
				</div>
			</dialog>

			<dialog id="supRestockModal" class="sup-modal">
				<form id="supRestockForm" class="sup-modal-card">
					<div id="supRestockPhotoWrap"></div>
					<div class="sup-modal-body">
						<h3 id="supRestockName" class="sup-name" style="margin:4px 0" data-i18n-skip></h3>
						<p id="supRestockMeta" class="sup-meta"></p>
						<div id="supRestockBuy" class="sup-restock-buy"></div>
						<label class="sup-field"><span>${escapeHtml(t('Quantity received'))}</span><input id="supRestockQty" type="number" min="0.001" step="any" inputmode="decimal" required /></label>
						<div class="sup-restock-cost">
							<label class="sup-field"><span>${escapeHtml(t('Unit price paid'))}</span><input id="supRestockCost" type="number" min="0" step="0.01" inputmode="decimal" placeholder="${escapeHtml(t('Optional'))}" /></label>
							<label class="sup-field"><span>${escapeHtml(t('Currency'))}</span>
								<select id="supRestockCurrency">
									<option value="USD">USD</option>
									<option value="CNY">CNY</option>
									<option value="HKD">HKD</option>
									<option value="EUR">EUR</option>
									<option value="GBP">GBP</option>
									<option value="JPY">JPY</option>
								</select>
							</label>
						</div>
						<p id="supRestockTotal" class="sup-restock-total">${escapeHtml(t('This restock: —'))}</p>
						<p class="sup-field-hint">${escapeHtml(t('Leave blank to reuse last paid price.'))}</p>
						<label class="sup-field"><span>${escapeHtml(t('Note (order / supplier)'))}</span><input id="supRestockNote" maxlength="200" placeholder="${escapeHtml(t('Optional'))}" /></label>
						<p id="supRestockError" class="sup-error" hidden></p>
						<div class="sup-modal-actions">
							<button type="button" class="sup-btn sup-btn-ghost" id="supRestockCancel">${escapeHtml(t('Cancel'))}</button>
							<button type="submit" class="sup-btn sup-btn-primary">${escapeHtml(t('Add to stock'))}</button>
						</div>
					</div>
					<button type="button" class="sup-modal-close" id="supRestockClose" aria-label="${escapeHtml(t('Close'))}">×</button>
				</form>
			</dialog>

			<dialog id="supCatalogModal" class="sup-modal">
				<form id="supCatalogForm" class="sup-modal-card sup-modal-wide">
					<h3 id="supCatalogTitle" style="margin:0 0 12px">${escapeHtml(t('Edit supply'))}</h3>
					<input type="hidden" id="supCatalogId" />
					<input type="hidden" id="supCatalogSku" />
					<div class="sup-form-grid">
						<label class="sup-field sup-span"><span>${escapeHtml(t('Name'))}</span><input id="supCatalogName" required maxlength="120" data-i18n-skip /></label>
						<details class="sup-field sup-span" id="supCatalogAltWrap">
							<summary id="supCatalogAltLabel">${escapeHtml(t('Chinese name'))}</summary>
							<input id="supCatalogAltName" maxlength="120" data-i18n-skip placeholder="${escapeHtml(t('Optional'))}" />
						</details>
						<label class="sup-field sup-span"><span>${escapeHtml(t('Category'))}</span>
							<div id="supCatalogCategoryPicker" class="sup-category-picker"></div>
							<select id="supCatalogCategory" class="sup-visually-hidden" required></select>
						</label>
						<label class="sup-field sup-span" id="supCatalogFamilyWrap" hidden>
							<span>${escapeHtml(t('Series'))}</span>
							<div id="supCatalogFamilyPicker" class="sup-category-picker"></div>
							<input type="hidden" id="supCatalogFamily" />
						</label>
						<label class="sup-field"><span>${escapeHtml(t('Unit'))}</span>
							<select id="supCatalogUom" required>
								<option value="each">${escapeHtml(t('each'))}</option>
								<option value="roll">${escapeHtml(t('roll'))}</option>
								<option value="sheet">${escapeHtml(t('sheet'))}</option>
								<option value="pack">${escapeHtml(t('pack'))}</option>
								<option value="box">${escapeHtml(t('box'))}</option>
							</select>
						</label>
						<label class="sup-field"><span>${escapeHtml(t('Reorder when at or below'))}</span><input id="supCatalogReorderPoint" type="number" min="0" step="any" required /></label>
						<label class="sup-field"><span>${escapeHtml(t('Suggested buy qty'))}</span><input id="supCatalogReorderQty" type="number" min="0" step="any" required /></label>
						<label class="sup-field"><span>${escapeHtml(t('Unit cost'))}</span><input id="supCatalogCost" type="number" min="0" step="0.01" inputmode="decimal" placeholder="${escapeHtml(t('Optional'))}" /><small class="sup-field-hint">${escapeHtml(t('Last paid unit price. Restock uses this if you leave the price blank.'))}</small></label>
						<label class="sup-field"><span>${escapeHtml(t('Currency'))}</span>
							<select id="supCatalogCurrency">
								<option value="USD">USD</option>
								<option value="CNY">CNY</option>
								<option value="HKD">HKD</option>
								<option value="EUR">EUR</option>
								<option value="GBP">GBP</option>
								<option value="JPY">JPY</option>
							</select>
						</label>
						<label class="sup-field"><span>${escapeHtml(t('Supplier name'))}</span><input id="supCatalogSupplierName" maxlength="120" placeholder="${escapeHtml(t('Taobao / Amazon / …'))}" data-i18n-skip /></label>
						<label class="sup-field sup-span"><span>${escapeHtml(t('Supplier link'))}</span><input id="supCatalogSupplierUrl" type="url" inputmode="url" enterkeyhint="go" maxlength="500" placeholder="https://" /><small class="sup-field-hint">${escapeHtml(t('Taobao / 1688 / Amazon link. On a phone this opens the shop app.'))}</small></label>
						<label class="sup-field sup-span"><span>${escapeHtml(t('Notes'))}</span><input id="supCatalogNotes" maxlength="240" /></label>
						<div class="sup-field sup-span" id="supCatalogPhotoField">
							<span>${escapeHtml(t('Photo'))}</span>
							<div class="sup-catalog-photo" id="supCatalogPhotoDrop">
								<div id="supCatalogPhotoPreview" class="sup-catalog-photo-preview"></div>
								<div class="sup-catalog-photo-copy">
									<strong id="supCatalogPhotoAction">${escapeHtml(t('Add photo'))}</strong>
									<span>${escapeHtml(t('Drop a photo here or browse'))}</span>
								</div>
								<input id="supCatalogPhoto" class="sup-visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" />
							</div>
						</div>
						<label class="sup-field sup-span sup-check" id="supCatalogActiveWrap" hidden>
							<input id="supCatalogActive" type="checkbox" checked />
							<span class="sup-check-label">${escapeHtml(t('Active (uncheck to retire outdated stock)'))}</span>
						</label>
					</div>
					<p id="supCatalogError" class="sup-error" hidden></p>
					<div class="sup-modal-actions">
						<div class="sup-modal-danger">
							<button type="button" class="sup-btn sup-btn-ghost sup-btn-danger" id="supCatalogArchive" hidden>${escapeHtml(t('Remove'))}</button>
							<button type="button" class="sup-btn sup-btn-ghost" id="supCatalogRestore" hidden>${escapeHtml(t('Restore'))}</button>
							<button type="button" class="sup-btn sup-btn-ghost sup-btn-danger" id="supCatalogPurge" hidden>${escapeHtml(t('Delete permanently'))}</button>
						</div>
						<button type="button" class="sup-btn sup-btn-ghost" id="supCatalogCancel">${escapeHtml(t('Cancel'))}</button>
						<button type="submit" class="sup-btn sup-btn-primary">${escapeHtml(t('Save supply'))}</button>
					</div>
					<button type="button" class="sup-modal-close" id="supCatalogClose" aria-label="${escapeHtml(t('Close'))}">×</button>
				</form>
			</dialog>

			<div id="supCardMenu" class="sup-menu" hidden role="menu"></div>
			<div id="supToast" hidden></div>
			<input id="supReplacePhoto" type="file" accept="image/jpeg,image/png,image/webp" hidden />
		`
	}

	function refreshOwnerBits() {
		const owner = isOwner()
		const catalog = canManageCatalog()
		document.querySelectorAll('#suppliesRoot .owner-only').forEach((el) => {
			el.hidden = !owner
		})
		document.querySelectorAll('#suppliesRoot .catalog-write').forEach((el) => {
			el.hidden = !catalog
		})
	}

	function setView(name) {
		closeCardMenu()
		state.view = name
		document.querySelectorAll('#suppliesRoot .sup-tab').forEach((btn) => {
			const on = btn.dataset.supView === name
			btn.classList.toggle('active', on)
			btn.setAttribute('aria-selected', on ? 'true' : 'false')
		})
		document.querySelectorAll('#suppliesRoot .sup-panel').forEach((panel) => {
			panel.classList.toggle('active', panel.dataset.supPanel === name)
		})
		refreshView()
	}

	async function refreshView() {
		if (state.view === 'log') return loadLog()
		return loadInventory()
	}

	function paintNavBadge(count) {
		const btn = document.querySelector('.tabs .tab[data-tab="supplies"]')
		if (!btn) return
		let badge = btn.querySelector('.sup-nav-badge')
		const n = Number(count) || 0
		if (!n) {
			if (badge) badge.remove()
			return
		}
		if (!badge) {
			badge = document.createElement('span')
			badge.className = 'sup-nav-badge'
			btn.appendChild(badge)
		}
		badge.setAttribute('aria-label', n === 1 ? t('1 packing supply to buy') : t(`${n} packing supplies to buy`))
		badge.textContent = String(n)
	}

	function familiesForCategory(slug) {
		return state.familiesByCategory[slug] || []
	}

	function renderCategoryChips() {
		const wrap = $('supCategoryChips')
		if (!wrap) return
		const all = [{ slug: '', name: 'All' }, ...state.categories]
		wrap.innerHTML = all
			.map(
				(c) =>
					`<button type="button" class="sup-chip${state.filterCategory === (c.slug || '') ? ' active' : ''}" data-cat="${escapeHtml(c.slug || '')}">${escapeHtml(t(c.name))}</button>`,
			)
			.join('')
		renderFamilyChips()
	}

	function renderFamilyChips() {
		const wrap = $('supFamilyChips')
		if (!wrap) return
		const families = familiesForCategory(state.filterCategory)
		if (!families.length) {
			wrap.hidden = true
			wrap.innerHTML = ''
			return
		}
		wrap.hidden = false
		const chips = [{ slug: '', name: 'All characters' }, ...families]
		wrap.innerHTML = chips
			.map(
				(f) =>
					`<button type="button" class="sup-chip${state.filterFamily === (f.slug || '') ? ' active' : ''}" data-cat="${escapeHtml(state.filterCategory)}" data-family="${escapeHtml(f.slug || '')}">${escapeHtml(t(f.name))}</button>`,
			)
			.join('')
	}

	function itemMatchesFilters(item) {
		if (!state.includeArchived && !item.active) return false
		if (state.filterNeedsPurchase && !isNeedsPurchase(item)) return false
		if (state.filterCategory && item.category_slug !== state.filterCategory) return false
		if (state.filterFamily && (item.family || 'other') !== state.filterFamily) return false
		const q = state.filterQ.trim().toLowerCase()
		if (!q) return true
		return searchText(item).includes(q)
	}

	function countLineMatchesScope(line) {
		if (state.filterCategory && line.category_slug !== state.filterCategory) return false
		if (state.filterFamily && (line.family || 'other') !== state.filterFamily) return false
		const q = state.filterQ.trim().toLowerCase()
		if (q && !searchText(line).includes(q)) return false
		return true
	}

	function countWalkHidesCounted() {
		if (!state.counting || !state.filterCountPending) return false
		const lines = state.countSession?.lines
		if (!Array.isArray(lines) || !lines.length) return false
		return lines.some((line) => countLineMatchesScope(line) && !lineIsCounted(line))
	}

	function releaseCountWalkIfComplete() {
		if (!state.filterCountPending) return
		if (!state.counting || !state.countSession) {
			state.filterCountPending = false
			return
		}
		if (Number(state.countSession.progress?.remaining) === 0) state.filterCountPending = false
	}

	function countLineMatchesFilters(line, hideCounted) {
		if (hideCounted && lineIsCounted(line)) return false
		return countLineMatchesScope(line)
	}

	function lastCountNote(alerts) {
		if (!alerts || alerts.days_since_count == null) return t('No submitted count yet.')
		return t(`Last count ${alerts.days_since_count}d ago.`)
	}

	function buyInstruction() {
		return t('Employees marked these while packing. Tap Mark purchased after you order them. Restock when they arrive.')
	}

	function paintBuyChip() {
		const btn = $('supBuyChip')
		if (!btn) return
		const n = buyCount(state.alerts)
		btn.innerHTML = n
			? `${escapeHtml(t('To buy'))}<span class="sup-chip-count">${n}</span>`
			: escapeHtml(t('To buy'))
		btn.classList.toggle('active', state.filterNeedsPurchase)
		btn.setAttribute('aria-pressed', state.filterNeedsPurchase ? 'true' : 'false')
	}

	function buyTitle(n) {
		return n === 1 ? t('1 packing supply to buy') : t(`${n} packing supplies to buy`)
	}

	function flaggedPurchaseItems() {
		return (state.items || []).filter((item) => isActiveItem(item) && isNeedsPurchase(item))
	}

	function buyQueueItemHtml(item) {
		const who = item.needs_purchase_by ? t(`Flagged by ${item.needs_purchase_by}`) : ''
		const qty =
			Number(item.reorder_qty) > 0
				? t(`${fmtQty(item.qty_on_hand, item.uom)} on hand · buy ${fmtQty(item.reorder_qty, item.uom)}`)
				: t(fmtQty(item.qty_on_hand, item.uom))
		return `<article class="sup-buy-row" data-item-id="${item.id}">
				${photoMarkup(item, { eager: true })}
				<div class="sup-buy-row-copy">
					<strong data-i18n-skip>${escapeHtml(displayName(item))}</strong>
					<div class="sup-meta">${escapeHtml(qty)}${who ? ` · ${escapeHtml(who)}` : ''}</div>
				</div>
				<div class="sup-buy-row-actions">
					${buyLink(item, { variant: 'button', label: 'Buy now' })}
					<button type="button" class="sup-btn sup-btn-purchased" data-mark-purchased="${item.id}">${escapeHtml(t('Mark purchased'))}</button>
					<button type="button" class="sup-btn sup-btn-ghost" data-restock="${item.id}">${escapeHtml(t('Restock'))}</button>
					<button type="button" class="sup-btn sup-btn-ghost" data-needs-purchase="0" data-item-id="${item.id}">${escapeHtml(t('Not needed'))}</button>
				</div>
			</article>`
	}

	function renderBuyQueue() {
		const host = $('supBuyQueue')
		if (!host) return
		const items = flaggedPurchaseItems()
		const open = isOwner() && state.purchaseQueueOpen && items.length > 0
		host.hidden = !open
		if (!open) {
			host.innerHTML = ''
			return
		}
		host.innerHTML = `
			<div class="sup-buy-queue-head">
				<div>
					<strong id="supBuyQueueTitle">${escapeHtml(buyTitle(items.length))}</strong>
					<p class="sup-meta">${escapeHtml(buyInstruction())}</p>
				</div>
				<button type="button" class="sup-btn sup-btn-ghost sup-btn-sm" id="supBuyQueueClose">${escapeHtml(t('Close'))}</button>
			</div>
			<div class="sup-buy-queue-list">
				${items.map(buyQueueItemHtml).join('')}
			</div>`
	}

	function closeBuyQueue() {
		state.purchaseQueueOpen = false
		state.filterNeedsPurchase = false
		paintBuyChip()
		renderBuyQueue()
		renderInventoryGrid()
	}

	function renderHeroStatus() {
		const panel = $('supLivePanel')
		if (!panel) return
		const alerts = state.alerts || {}
		const buy = buyCount(alerts)
		const active = state.items.filter((item) => item.active !== 0 && item.active !== false).length
		const counting = Boolean(state.counting && state.countSession)
		panel.classList.toggle('is-counting', counting)
		panel.classList.toggle('is-warn', !counting && buy > 0)
		panel.classList.toggle('is-ok', !counting && buy === 0)
		if ($('supLiveTitle')) {
			$('supLiveTitle').textContent = counting
				? t('Daily count in progress')
				: buy
					? buyTitle(buy)
					: t('Stock looks healthy')
		}
		if ($('supLiveDetail')) {
			$('supLiveDetail').textContent = counting
				? lastCountNote(alerts)
				: buy
					? buyInstruction()
					: `${t('Nothing is out of stock until someone taps Need to buy.')} ${lastCountNote(alerts)}`
		}
		if ($('supLiveItems')) {
			$('supLiveItems').textContent = active === 1 ? t('1 item') : t(`${active} items`)
		}
		if ($('supLiveBuy')) $('supLiveBuy').textContent = String(buy)
		paintBuyChip()
	}

	function renderAlertBanner() {
		const host = $('supAlertBanner')
		const alerts = state.alerts
		const buyN = buyCount(alerts)
		paintNavBadge(buyN)
		paintOrdersBuy(alerts)
		if (state.mounted) {
			renderHeroStatus()
			renderBuyQueue()
		}
		if (!host) return
		if (!alerts || !buyN) {
			host.innerHTML = ''
			return
		}
		host.innerHTML = `
			<section class="sup-banner" aria-labelledby="supAlertTitle">
				<div class="sup-banner-head">
					<span class="sup-banner-icon" aria-hidden="true">!</span>
					<div class="sup-banner-copy">
						<div class="sup-banner-title" id="supAlertTitle">${escapeHtml(buyTitle(buyN))}</div>
						<div class="sup-banner-sub">${escapeHtml(buyInstruction())}</div>
					</div>
					<div class="sup-banner-actions">
						<button type="button" class="sup-btn sup-btn-sm" id="supShowBuy">${escapeHtml(t('Show these'))}</button>
					</div>
				</div>
			</section>`
	}

	function paintOrdersBuy(alerts) {
		const host = document.getElementById('ordersSuppliesBuy')
		if (!host) return
		const n = buyCount(alerts)
		if (!n) {
			host.hidden = true
			host.innerHTML = ''
			return
		}
		host.hidden = false
		host.innerHTML = `
			<button type="button" class="ov-supplies-buy-card" id="ordersSuppliesBuyBtn">
				<span class="ov-supplies-buy-count">${n}</span>
				<span class="ov-supplies-buy-copy">
					<strong>${escapeHtml(buyTitle(n))}</strong>
					<span>${escapeHtml(buyInstruction())}</span>
				</span>
				<span class="ov-supplies-buy-action">${escapeHtml(t('To buy'))}</span>
			</button>`
		$('ordersSuppliesBuyBtn')?.addEventListener('click', () => {
			showToBuy()
			if (typeof window.showTab === 'function') window.showTab('supplies')
		})
	}

	function renderCountBar() {
		const bar = $('supCountBar')
		const startBtn = $('supStartCount')
		if (!bar) return
		const counting = Boolean(state.counting && state.countSession)
		document.querySelector('#suppliesRoot .sup-shell')?.classList.toggle('is-counting', counting)
		if (!counting) {
			document.querySelector('#suppliesRoot .sup-shell')?.classList.remove('is-count-review')
			bar.hidden = true
			bar.removeAttribute('role')
			bar.removeAttribute('aria-label')
			if (startBtn) {
				startBtn.hidden = false
				startBtn.textContent = t('Start daily count')
			}
			renderHeroStatus()
			return
		}
		releaseCountWalkIfComplete()
		const p = state.countSession.progress || { counted: 0, total: 0, remaining: 0, variance_count: 0 }
		const remaining = Number(p.remaining) || 0
		const pct = p.total ? Math.round((p.counted / p.total) * 100) : 0
		const buyN = flaggedBuyLines().length
		const progress = countProgressText(p, buyN)
		const hint = remaining
			? t('They look right until something is out. Tap Need to buy to remind us.')
			: t('Review the shelf, then tap Review & submit.')
		document.querySelector('#suppliesRoot .sup-shell')?.classList.toggle('is-count-review', remaining === 0)
		bar.hidden = false
		bar.setAttribute('role', 'region')
		bar.setAttribute('aria-label', t('Shelf check'))
		bar.innerHTML = `
			<div class="sup-count-copy">
				<strong>${escapeHtml(t('Shelf check'))}</strong>
				<div class="sup-meta" role="status">${escapeHtml(progress)}</div>
				<div class="sup-count-hint">${escapeHtml(hint)}</div>
			</div>
			<div class="sup-actions">
				${remaining ? `<button type="button" class="sup-chip${state.filterCountPending ? ' active' : ''}" id="supCountPendingChip" aria-pressed="${state.filterCountPending ? 'true' : 'false'}">${escapeHtml(t('To check'))}<span class="sup-chip-count">${remaining}</span></button>` : ''}
				${remaining ? `<button type="button" class="sup-btn sup-btn-ghost" id="supCountMatchRest">${escapeHtml(t('The rest look right'))}</button>` : ''}
				<button type="button" class="sup-btn sup-btn-ghost" id="supCancelCount">${escapeHtml(t('Cancel'))}</button>
				<button type="button" class="sup-btn sup-btn-primary" id="supSubmitCount">${escapeHtml(t('Review & submit'))}</button>
			</div>
			<div class="sup-progress" aria-hidden="true"><span style="width:${pct}%"></span></div>`
		if (startBtn) startBtn.hidden = true
		renderHeroStatus()
		$('supCountPendingChip')?.addEventListener('click', () => {
			state.filterCountPending = !state.filterCountPending
			renderCountBar()
			renderInventoryGrid()
		})
		$('supCountMatchRest')?.addEventListener('click', (e) => confirmRemainingMatch(e.currentTarget))
		$('supCancelCount')?.addEventListener('click', cancelCount)
		$('supSubmitCount')?.addEventListener('click', openSubmitModal)
	}

	function inventoryCardHtml(item, index) {
		const catalog = canManageCatalog()
		const price = catalog ? fmtMoney(item.unit_cost, item.currency) : null
		const retired = !isActiveItem(item)
		const arrange = catalog ? ' draggable="true"' : ''
		const qtyTitle = price ? escapeHtml(t(`${price} / ${item.uom}`)) : ''
		return `
			<article class="sup-card${isNeedsPurchase(item) ? ' is-buy' : ''}${retired ? ' is-archived' : ''}" data-item-id="${item.id}" data-key="item-${item.id}" data-cat="${escapeHtml(item.category_slug || '')}" data-family="${escapeHtml(item.family || '')}"${cardIdentityAttrs(item)}${arrange}>
				<div class="sup-card-media">
					${photoMarkup(item, { eager: index < 12 })}
					${buyOverlayHtml(item)}
					<span class="sup-pill" data-role="qty"${qtyTitle ? ` title="${qtyTitle}"` : ''}>${escapeHtml(t(fmtQty(item.qty_on_hand, item.uom)))}</span>
				</div>
				<div class="sup-card-body">
					${cardHeadHtml(item)}
					${price ? `<div class="sup-meta sup-card-price">${escapeHtml(t(`${price} / ${item.uom}`))}</div>` : ''}
					${retired ? `<div class="sup-meta" data-retired-flag>${escapeHtml(t('· retired'))}</div>` : ''}
					${inventoryPrimaryHtml(item)}
				</div>
			</article>`
	}

	function countCardHtml(line, index) {
		const counted = lineIsCounted(line)
		const variance = counted && Number(line.variance) !== 0
		const emptyExpected = isEmptyExpectedUncounted(line)
		const qtyLabel = countQtyPillLabel(line)
		const arrange = canManageCatalog() ? ' draggable="true"' : ''
		return `
			<article class="sup-card${counted ? ' is-counted' : ''}${variance ? ' has-variance' : ''}${isNeedsPurchase(line) ? ' is-buy' : ''}${emptyExpected ? ' is-empty-expected' : ''}" data-item-id="${line.item_id}" data-key="count-${line.item_id}" data-cat="${escapeHtml(line.category_slug || '')}" data-family="${escapeHtml(line.family || '')}" tabindex="0"${cardIdentityAttrs(line)}${arrange}>
				<div class="sup-card-media">
					${photoMarkup(line, { eager: index < 16 })}
					<span class="sup-pill" data-role="qty">${escapeHtml(qtyLabel)}</span>
				</div>
				<div class="sup-card-body">
					${cardHeadHtml(line)}
					${countCheckHtml(line)}
					${countStepperHtml(line)}
				</div>
			</article>`
	}

	function applyCardClasses(el, rec) {
		el.classList.remove('is-low')
		el.classList.toggle('is-buy', isNeedsPurchase(rec))
		el.classList.toggle('is-archived', rec.active === 0 || rec.active === false)
		if (Object.prototype.hasOwnProperty.call(rec, 'counted_qty')) {
			const counted = rec.counted_qty != null
			el.classList.toggle('is-counted', counted)
			el.classList.toggle('has-variance', counted && Number(rec.variance) !== 0)
			el.classList.toggle('is-empty-expected', isEmptyExpectedUncounted(rec))
		} else {
			el.classList.remove('is-empty-expected')
		}
	}

	function syncCardPhoto(el, rec) {
		const next = rec.photo_thumb || rec.photo_path
		if (!next) return
		const img = el.querySelector('img.sup-photo')
		const nextPath = (rec.photo_path || next).split('?')[0]
		if (img) {
			const currentPath = (img.getAttribute('src') || '').split('?')[0]
			if (currentPath === nextPath) return
			img.src = next
			if (rec.photo_path) {
				img.srcset = `${rec.photo_path}?w=240 240w, ${rec.photo_path}?w=480 480w`
			}
			img.loading = 'eager'
			return
		}
		const host = el.querySelector('.sup-photo')
		if (!host) return
		const wrap = document.createElement('div')
		wrap.innerHTML = photoMarkup(rec, { eager: true }).trim()
		host.replaceWith(wrap.firstElementChild)
	}

	function refreshKeyedCard(el, rec) {
		applyCardClasses(el, rec)
		syncCardPhoto(el, rec)
		syncRetiredMeta(el, rec)
		syncCardActions(el, rec)
		syncCountCheck(el, rec)
		const nameEl = el.querySelector('.sup-name')
		if (nameEl && !el.querySelector('.sup-name-input') && (rec.name || rec.name_zh)) {
			const label = displayName(rec)
			nameEl.textContent = label
			if (label) {
				el.setAttribute('aria-label', label)
				el.setAttribute('title', label)
			}
		}
		const qty = el.querySelector('[data-role="qty"]')
		if (qty) {
			if (rec.qty_on_hand != null && rec.counted_qty === undefined) {
				qty.textContent = t(fmtQty(rec.qty_on_hand, rec.uom))
			}
			if (rec.counted_qty !== undefined) {
				qty.textContent = countQtyPillLabel(rec)
			}
		}
		syncCountStepper(el, rec)
		if (state.menuItemId && Number(el.dataset.itemId) === state.menuItemId) {
			const toggle = el.querySelector('[data-menu]')
			if (toggle) {
				state.menuToggle = toggle
				positionCardMenu(toggle)
			}
		}
	}

	function syncCountStepper(el, rec) {
		if (!isCountRecord(rec)) return
		const stepper = el.querySelector('.sup-stepper')
		if (stepper) stepper.classList.toggle('is-idle', !lineIsCounted(rec))
		const stepperVal = el.querySelector('.sup-stepper-val')
		if (!stepperVal) return
		const shown = rec.counted_qty != null ? rec.counted_qty : rec.expected_qty
		stepperVal.textContent = formatStepperQty(shown)
		const label = countQtyPillLabel(rec)
		stepperVal.setAttribute('aria-label', label)
		stepperVal.setAttribute('title', label)
	}

	function syncCountCheck(el, rec) {
		if (!isCountRecord(rec)) return
		const body = el.querySelector('.sup-card-body')
		if (!body) return
		const html = countCheckHtml(rec)
		const wrap = document.createElement('div')
		wrap.innerHTML = html.trim()
		const next = wrap.firstElementChild
		if (!next) return
		const host = el.querySelector('.sup-count-check')
		if (host) {
			host.replaceWith(next)
			return
		}
		const stepper = body.querySelector('.sup-stepper')
		if (stepper) stepper.insertAdjacentElement('beforebegin', next)
		else body.insertAdjacentHTML('beforeend', html)
	}

	function syncRetiredMeta(el, rec) {
		if (isCountRecord(rec)) return
		const body = el.querySelector('.sup-card-body')
		if (!body) return
		const meta = body.querySelector('[data-retired-flag]')
		const retired = !isActiveItem(rec)
		if (retired && !meta) {
			const head = body.querySelector('.sup-card-head')
			if (head) head.insertAdjacentHTML('afterend', `<div class="sup-meta" data-retired-flag>${escapeHtml(t('· retired'))}</div>`)
			else body.insertAdjacentHTML('afterbegin', `<div class="sup-meta" data-retired-flag>${escapeHtml(t('· retired'))}</div>`)
			return
		}
		if (!retired && meta) meta.remove()
	}

	function syncCardActions(el, rec) {
		if (isCountRecord(rec)) return
		const body = el.querySelector('.sup-card-body')
		if (!body) return
		const retired = !isActiveItem(rec)
		let host = el.querySelector('.sup-card-primary')
		if (retired) {
			if (host) host.remove()
			return
		}
		const html = inventoryPrimaryHtml(rec)
		if (!html) return
		if (!host) {
			body.insertAdjacentHTML('beforeend', html)
			return
		}
		const wrap = document.createElement('div')
		wrap.innerHTML = html.trim()
		if (wrap.firstElementChild) host.replaceWith(wrap.firstElementChild)
	}

	function groupByCategory(records) {
		const bySlug = new Map()
		for (const rec of records) {
			const slug = rec.category_slug || 'misc'
			if (!bySlug.has(slug)) bySlug.set(slug, [])
			bySlug.get(slug).push(rec)
		}
		const sections = []
		const seen = new Set()
		for (const cat of state.categories) {
			const rows = bySlug.get(cat.slug)
			if (!rows?.length) continue
			sections.push({ slug: cat.slug, name: cat.name, records: rows })
			seen.add(cat.slug)
		}
		for (const [slug, rows] of bySlug) {
			if (seen.has(slug)) continue
			sections.push({ slug, name: rows[0].category_name || 'Misc', records: rows })
		}
		return sections
	}

	function familyMetaOf(rec) {
		const list = familiesForCategory(rec.category_slug)
		if (!list.length) return null
		return list.find((f) => f.slug === rec.family) || list.find((f) => f.slug === 'other') || { slug: 'other', name: 'Other stickers' }
	}

	function groupSectionRecords(section) {
		const families = familiesForCategory(section.slug)
		if (!families.length) return [{ family: null, records: section.records }]
		const byFam = new Map()
		for (const rec of section.records) {
			const fam = familyMetaOf(rec)
			const key = fam?.slug || 'other'
			if (!byFam.has(key)) byFam.set(key, [])
			byFam.get(key).push(rec)
		}
		const groups = []
		const seen = new Set()
		for (const fam of families) {
			const rows = byFam.get(fam.slug)
			if (!rows?.length) continue
			groups.push({ family: fam, records: rows })
			seen.add(fam.slug)
		}
		for (const [slug, rows] of byFam) {
			if (seen.has(slug)) continue
			groups.push({ family: { slug, name: slug }, records: rows })
		}
		return groups
	}

	function sectionMetaLabel(records, counting) {
		if (!counting) {
			return records.length === 1 ? t('1 item') : t(`${records.length} items`)
		}
		if (countWalkHidesCounted()) {
			return records.length === 1 ? t('1 to check') : t(`${records.length} to check`)
		}
		const counted = records.filter((r) => r.counted_qty != null).length
		return t(`${counted}/${records.length} counted · ${records.length - counted} remaining`)
	}

	function makeSectionEl(slug) {
		const sectionEl = document.createElement('section')
		sectionEl.className = 'sup-section'
		sectionEl.dataset.cat = slug
		sectionEl.id = `sup-section-${slug}`
		sectionEl.innerHTML = `
			<header class="sup-section-head">
				<div class="sup-section-heading">
					<h3 class="sup-section-title"></h3>
					<span class="sup-section-meta"></span>
				</div>
				<div class="sup-family-jumps" hidden></div>
			</header>
			<div class="sup-section-body"></div>`
		return sectionEl
	}

	function fillKeyedGrid(grid, records, { existingCards, keyOf, htmlOf, counting }, photoIndex) {
		const gridFrag = document.createDocumentFragment()
		let nextIndex = photoIndex
		for (const rec of records) {
			const key = keyOf(rec)
			let el = existingCards.get(key)
			if (!el) {
				const wrap = document.createElement('div')
				wrap.innerHTML = htmlOf(rec, nextIndex).trim()
				el = wrap.firstElementChild
			} else {
				refreshKeyedCard(el, rec)
				existingCards.delete(key)
			}
			if (el) {
				el.dataset.cat = rec.category_slug || ''
				el.dataset.family = rec.family || ''
				gridFrag.appendChild(el)
			}
			nextIndex += 1
		}
		grid.replaceChildren(gridFrag)
		return nextIndex
	}

	function syncSectionedCatalog(container, records, { keyOf, htmlOf, matches, counting }) {
		if (!container) return
		const visible = matches ? records.filter(matches) : records
		if (!visible.length) {
			container.innerHTML = emptyCatalogHtml()
			return
		}

		const existingCards = new Map()
		for (const el of container.querySelectorAll('[data-key]')) {
			existingCards.set(el.dataset.key, el)
		}
		const existingSections = new Map()
		for (const el of container.querySelectorAll('.sup-section[data-cat]')) {
			existingSections.set(el.dataset.cat, el)
		}

		const frag = document.createDocumentFragment()
		let photoIndex = 0
		for (const section of groupByCategory(visible)) {
			let sectionEl = existingSections.get(section.slug)
			if (!sectionEl) sectionEl = makeSectionEl(section.slug)
			sectionEl.dataset.cat = section.slug
			sectionEl.id = `sup-section-${section.slug}`
			const title = sectionEl.querySelector('.sup-section-title')
			const meta = sectionEl.querySelector('.sup-section-meta')
			const jumps = sectionEl.querySelector('.sup-family-jumps')
			const body = sectionEl.querySelector('.sup-section-body') || sectionEl
			if (title) title.textContent = t(section.name)
			if (meta) meta.textContent = sectionMetaLabel(section.records, counting)

			const groups = groupSectionRecords(section)
			if (jumps) {
				jumps.hidden = true
				jumps.innerHTML = ''
			}

			const bodyFrag = document.createDocumentFragment()
			for (const group of groups) {
				if (group.family) {
					const sub = document.createElement('div')
					sub.className = 'sup-subsection'
					sub.dataset.family = group.family.slug
					sub.dataset.cat = section.slug
					sub.id = `sup-family-${section.slug}-${group.family.slug}`
					sub.innerHTML = `
						<header class="sup-subsection-head">
							<h4 class="sup-subsection-title">${escapeHtml(t(group.family.name))}</h4>
							<span class="sup-subsection-meta">${escapeHtml(sectionMetaLabel(group.records, counting))}</span>
						</header>
						<div class="sup-grid"></div>`
					photoIndex = fillKeyedGrid(sub.querySelector('.sup-grid'), group.records, { existingCards, keyOf, htmlOf, counting }, photoIndex)
					bodyFrag.appendChild(sub)
				} else {
					const grid = document.createElement('div')
					grid.className = 'sup-grid'
					photoIndex = fillKeyedGrid(grid, group.records, { existingCards, keyOf, htmlOf, counting }, photoIndex)
					bodyFrag.appendChild(grid)
				}
			}
			if (body) body.replaceChildren(bodyFrag)
			frag.appendChild(sectionEl)
		}
		container.replaceChildren(frag)
		if (state.menuToggle && !state.menuToggle.isConnected) closeCardMenu()
	}

	function emptyCatalogHtml() {
		const filtered = t('No packing supplies match these filters.')
		if (!canManageCatalog()) return `<div class="sup-empty">${escapeHtml(filtered)}</div>`
		const source = state.counting ? state.countSession?.lines : state.items
		if (Array.isArray(source) && source.length) {
			return `<div class="sup-empty">${escapeHtml(filtered)}</div>`
		}
		return `<div class="sup-empty">
					<p>${escapeHtml(t('No packing supplies yet.'))}</p>
					<button type="button" class="sup-btn sup-btn-primary" data-new-item="1">${escapeHtml(t('Add supply'))}</button>
				</div>`
	}

	function renderInventoryGrid() {
		const inv = $('supInventoryGrid')
		const count = $('supCountGrid')
		if (state.counting && state.countSession) {
			releaseCountWalkIfComplete()
			if (inv) inv.hidden = true
			if (count) count.hidden = false
			const hideCounted = countWalkHidesCounted()
			syncSectionedCatalog(count, state.countSession.lines, {
				keyOf: (line) => `count-${line.item_id}`,
				htmlOf: countCardHtml,
				counting: true,
				matches: (line) => countLineMatchesFilters(line, hideCounted),
			})
			return
		}
		if (count) count.hidden = true
		if (inv) inv.hidden = false
		syncSectionedCatalog(inv, state.items, {
			keyOf: (item) => `item-${item.id}`,
			htmlOf: inventoryCardHtml,
			matches: itemMatchesFilters,
		})
	}

	function patchItem(updated) {
		state.items = state.items.map((item) => (item.id === updated.id ? { ...item, ...updated } : item))
		if (state.countSession?.lines) {
			state.countSession.lines = state.countSession.lines.map((line) =>
				line.item_id === updated.id
					? {
							...line,
							name: updated.name,
							name_zh: updated.name_zh,
							category_slug: updated.category_slug || line.category_slug,
							category_name: updated.category_name || line.category_name,
							family: updated.family,
							family_name: updated.family_name,
							sort_order: updated.sort_order != null ? updated.sort_order : line.sort_order,
							photo_file: updated.photo_file,
							photo_path: updated.photo_path,
							photo_thumb: updated.photo_thumb,
							photo_detail: updated.photo_detail,
							needs_purchase: updated.needs_purchase,
							needs_purchase_at: updated.needs_purchase_at,
							needs_purchase_by: updated.needs_purchase_by,
							purchased_at: updated.purchased_at,
							purchased_by: updated.purchased_by,
							qty_on_hand: updated.qty_on_hand != null ? updated.qty_on_hand : line.qty_on_hand,
							is_low: updated.is_low != null ? updated.is_low : line.is_low,
						}
					: line,
			)
		}
		syncAlertsFromItems()
		if (!buyCount(state.alerts)) {
			state.purchaseQueueOpen = false
			state.filterNeedsPurchase = false
			paintBuyChip()
		}
		renderAlertBanner()
		renderInventoryGrid()
	}

	function syncAlertsFromItems() {
		if (!state.items.length && !state.alerts) return
		const active = state.items.filter((item) => item.active !== 0 && item.active !== false)
		const buy = active.filter(isNeedsPurchase)
		const low = active.filter((item) => item.is_low)
		state.alerts = {
			...(state.alerts || {}),
			needs_purchase: buy,
			needs_purchase_count: buy.length,
			low_stock: low,
			low_stock_count: low.length,
		}
	}

	function openPhotoPicker(itemId) {
		if (!canManageCatalog()) {
			toast('Owner only')
			return
		}
		state.replacePhotoItemId = Number(itemId)
		const input = $('supReplacePhoto')
		if (!input) return
		input.value = ''
		input.click()
	}

	async function replacePhotoFromFile(file) {
		const itemId = state.replacePhotoItemId
		if (!itemId || !file) return
		if (!isImageFile(file)) {
			state.replacePhotoItemId = null
			toast('Photo must be a JPEG, PNG or WebP')
			return
		}
		try {
			const photo_data = await readFileAsDataUrl(file)
			const data = await api(`/api/supplies/items/${itemId}`, { method: 'PATCH', body: { photo_data } })
			patchItem(data.item)
			toast('Photo updated')
		} catch (err) {
			toast(errorMessage(err))
		} finally {
			state.replacePhotoItemId = null
		}
	}

	function findRecord(itemId) {
		const id = Number(itemId)
		return state.items.find((item) => item.id === id) || state.countSession?.lines.find((line) => line.item_id === id) || null
	}

	function isImageFile(file) {
		if (!file) return false
		if (/^image\/(jpeg|jpg|png|webp)$/i.test(file.type || '')) return true
		return /\.(jpe?g|png|webp)$/i.test(file.name || '')
	}

	function handleNewSupplyEvent(e) {
		if (!canManageCatalog()) return false
		const hit = e.target.closest('[data-new-item]')
		if (!hit) return false
		e.preventDefault()
		e.stopPropagation()
		openCatalogModal(null)
		return true
	}

	function handlePhotoReplaceEvent(e) {
		if (!canManageCatalog()) return false
		const hit = e.target.closest('[data-replace-photo]')
		if (!hit) return false
		e.preventDefault()
		e.stopPropagation()
		openPhotoPicker(hit.dataset.replacePhoto)
		return true
	}

	function handleOwnerAction(e) {
		if (!canManageCatalog()) return false
		if (handleNewSupplyEvent(e)) {
			closeCardMenu()
			return true
		}
		if (handlePhotoReplaceEvent(e)) {
			closeCardMenu()
			return true
		}
		const remove = e.target.closest('[data-remove]')
		if (remove) {
			e.preventDefault()
			e.stopPropagation()
			closeCardMenu()
			removeSupply(Number(remove.dataset.remove), { btn: remove })
			return true
		}
		const restore = e.target.closest('[data-restore]')
		if (restore) {
			e.preventDefault()
			e.stopPropagation()
			closeCardMenu()
			restoreSupply(Number(restore.dataset.restore), restore)
			return true
		}
		const purge = e.target.closest('[data-purge]')
		if (purge) {
			e.preventDefault()
			e.stopPropagation()
			closeCardMenu()
			removeSupply(Number(purge.dataset.purge), { purge: true, btn: purge })
			return true
		}
		const edit = e.target.closest('[data-edit]')
		if (edit) {
			e.preventDefault()
			e.stopPropagation()
			closeCardMenu()
			openCatalogModal(Number(edit.dataset.edit))
			return true
		}
		return false
	}

	function droppedImageFile(e) {
		const files = e.dataTransfer && e.dataTransfer.files
		if (!files || !files.length) return null
		const file = files[0]
		return isImageFile(file) ? file : null
	}

	function isFileDrag(e) {
		const types = e.dataTransfer && e.dataTransfer.types
		if (!types) return false
		return [...types].includes('Files')
	}

	function markRenameDismissed() {
		rename.suppressCardClick = true
		if (rename.suppressTimer) window.clearTimeout(rename.suppressTimer)
		rename.suppressTimer = window.setTimeout(() => {
			rename.suppressCardClick = false
			rename.suppressTimer = 0
		}, 400)
	}

	function handleNameActivate(e) {
		if (!canManageCatalog()) return false
		if (e.target.closest('.sup-name-input')) return false
		const nameEl = e.target.closest('[data-rename]')
		if (!nameEl) return false
		e.preventDefault()
		e.stopPropagation()
		beginRename(nameEl)
		return true
	}

	function beginRename(nameEl) {
		if (!canManageCatalog()) {
			toast('Owner only')
			return
		}
		if (!nameEl || nameEl.classList.contains('sup-name-input')) return
		const itemId = Number(nameEl.dataset.rename)
		if (!Number.isFinite(itemId) || itemId <= 0) return
		const rec = findRecord(itemId)
		if (!rec) return
		if (typeof rename.commit === 'function') rename.commit(true)
		if (!nameEl.parentNode) return

		const originalDisplay = displayName(rec)
		const input = document.createElement('input')
		input.type = 'text'
		input.className = 'sup-name-input'
		input.value = originalDisplay
		input.maxLength = NAME_MAX_LEN
		input.setAttribute('data-stop', '1')
		input.setAttribute('aria-label', t('Name'))
		input.setAttribute('autocomplete', 'off')
		input.setAttribute('autocapitalize', 'off')
		input.setAttribute('spellcheck', 'false')
		input.setAttribute('enterkeyhint', 'done')

		nameEl.replaceWith(input)

		let closed = false
		const restoreHost = (text) => {
			nameEl.textContent = text
			if (input.parentNode) input.replaceWith(nameEl)
		}

		const finish = (save) => {
			if (closed) return
			closed = true
			if (rename.commit === finish) rename.commit = null
			markRenameDismissed()

			const next = normalizeTypedName(input.value)
			if (!save || next === originalDisplay) {
				restoreHost(originalDisplay)
				if (!save) {
					try {
						nameEl.focus()
					} catch {
						/* jsdom */
					}
				}
				return
			}
			if (!next) {
				restoreHost(originalDisplay)
				toast('Name is required')
				return
			}
			restoreHost(next)
			persistInlineName(itemId, next)
		}

		rename.commit = finish
		input.addEventListener('keydown', (e) => {
			e.stopPropagation()
			if (e.isComposing || e.keyCode === 229) return
			if (e.key === 'Enter') {
				e.preventDefault()
				finish(true)
			} else if (e.key === 'Escape') {
				e.preventDefault()
				finish(false)
			}
		})
		input.addEventListener('click', (e) => e.stopPropagation())
		input.addEventListener('mousedown', (e) => e.stopPropagation())
		input.addEventListener('pointerdown', (e) => e.stopPropagation())
		input.addEventListener('dragstart', (e) => e.preventDefault())
		input.addEventListener('blur', () => finish(true))
		try {
			input.focus()
			input.select()
		} catch {
			/* jsdom */
		}
	}

	async function persistInlineName(itemId, next) {
		try {
			const body = isZh() ? { name_zh: next } : { name: next }
			const data = await api(`/api/supplies/items/${itemId}`, { method: 'PATCH', body })
			if (!data || !data.item) throw new Error('Update failed')
			patchItem(data.item)
			toast('Name saved')
		} catch (err) {
			const host = document.querySelector(`#suppliesRoot [data-rename="${itemId}"]`)
			const rec = findRecord(itemId)
			if (host && rec && !host.classList.contains('sup-name-input')) host.textContent = displayName(rec)
			toast(errorMessage(err))
		}
	}

	const drag = { id: null, moved: false }

	function clearDropMarks() {
		document
			.querySelectorAll('#tab-supplies .is-drop-before, #tab-supplies .is-drop-after, #tab-supplies .is-drop-target')
			.forEach((el) => el.classList.remove('is-drop-before', 'is-drop-after', 'is-drop-target'))
	}

	async function persistPlacement(itemId, dest) {
		if (!canManageCatalog() || !itemId || !dest?.categorySlug) return
		try {
			const body = {
				item_id: itemId,
				category_slug: dest.categorySlug,
				before_id: dest.beforeId,
			}
			if (dest.family !== undefined) body.family = dest.family
			await api('/api/supplies/items/reorder', {
				method: 'POST',
				body,
			})
			await loadInventory()
		} catch (err) {
			toast(errorMessage(err))
			await loadInventory()
		}
	}

	function dropTargetFromEvent(e) {
		const familyChip = e.target.closest('#supFamilyChips [data-family]')
		if (familyChip) {
			return {
				categorySlug: familyChip.dataset.cat || 'stickers',
				beforeId: null,
				family: familyChip.dataset.family || undefined,
			}
		}
		const chip = e.target.closest('#supCategoryChips [data-cat]')
		if (chip && chip.dataset.cat) {
			const categorySlug = chip.dataset.cat
			return {
				categorySlug,
				beforeId: null,
				family: familiesForCategory(categorySlug).length ? undefined : null,
			}
		}
		const overCard = e.target.closest('.sup-card[data-item-id]')
		const subsection = e.target.closest('.sup-subsection[data-family]')
		const section = e.target.closest('.sup-section[data-cat]')
		if (!section) return null
		const categorySlug = section.dataset.cat
		let family
		if (subsection) family = subsection.dataset.family
		else if (!familiesForCategory(categorySlug).length) family = null
		if (!overCard || Number(overCard.dataset.itemId) === drag.id) {
			return { categorySlug, beforeId: null, family }
		}
		const rect = overCard.getBoundingClientRect()
		const after = e.clientX > rect.left + rect.width / 2
		if (!after) return { categorySlug, beforeId: Number(overCard.dataset.itemId), family }
		let next = overCard.nextElementSibling
		while (next && Number(next.dataset.itemId) === drag.id) next = next.nextElementSibling
		return {
			categorySlug,
			beforeId: next && next.dataset.itemId ? Number(next.dataset.itemId) : null,
			family,
		}
	}

	function wireArrange(container) {
		if (!container) return
		container.addEventListener('contextmenu', (e) => {
			if (handlePhotoReplaceEvent(e)) return
			const nameEl = e.target.closest('[data-rename]')
			if (!nameEl || !container.contains(nameEl)) return
			e.preventDefault()
			e.stopPropagation()
			beginRename(nameEl)
		})
		container.addEventListener('dragstart', (e) => {
			if (!canManageCatalog()) return
			if (e.target.closest('button, a, input, textarea, .sup-stepper, [data-stop], .sup-name-input, .sup-menu-toggle')) {
				e.preventDefault()
				return
			}
			const card = e.target.closest('.sup-card[data-item-id]')
			if (!card) return
			closeCardMenu()
			drag.id = Number(card.dataset.itemId)
			drag.moved = true
			card.classList.add('is-dragging')
			try {
				e.dataTransfer.effectAllowed = 'move'
				e.dataTransfer.setData('text/plain', String(drag.id))
			} catch {
				/* jsdom */
			}
		})
		container.addEventListener('dragend', () => {
			document.querySelectorAll('#tab-supplies .sup-card.is-dragging').forEach((el) => el.classList.remove('is-dragging'))
			clearDropMarks()
			setTimeout(() => {
				drag.moved = false
				drag.id = null
			}, 80)
		})
		container.addEventListener('dragover', (e) => {
			if (canManageCatalog() && isFileDrag(e) && drag.id == null) {
				const card = e.target.closest('.sup-card[data-item-id]')
				if (!card) return
				e.preventDefault()
				if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
				clearDropMarks()
				card.classList.add('is-drop-target')
				return
			}
			if (drag.id == null) return
			e.preventDefault()
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
			clearDropMarks()
			const card = e.target.closest('.sup-card[data-item-id]')
			const subsection = e.target.closest('.sup-subsection[data-family]')
			const section = e.target.closest('.sup-section[data-cat]')
			if (card && Number(card.dataset.itemId) !== drag.id) {
				const rect = card.getBoundingClientRect()
				card.classList.add(e.clientX > rect.left + rect.width / 2 ? 'is-drop-after' : 'is-drop-before')
			} else if (subsection) {
				subsection.classList.add('is-drop-target')
			} else if (section) {
				section.classList.add('is-drop-target')
			}
		})
		container.addEventListener('drop', (e) => {
			if (canManageCatalog() && drag.id == null) {
				const file = droppedImageFile(e)
				const card = e.target.closest('.sup-card[data-item-id]')
				if (file && card) {
					e.preventDefault()
					clearDropMarks()
					state.replacePhotoItemId = Number(card.dataset.itemId)
					replacePhotoFromFile(file)
					return
				}
			}
			if (drag.id == null) return
			e.preventDefault()
			const itemId = drag.id
			const dest = dropTargetFromEvent(e)
			clearDropMarks()
			if (!dest) return
			persistPlacement(itemId, dest)
		})
	}

	async function loadCategories() {
		const data = await api('/api/supplies/categories')
		state.categories = data.categories || []
		state.familiesByCategory = data.families || {}
		const sel = $('supCatalogCategory')
		if (sel) {
			sel.innerHTML = state.categories
				.map((c) => `<option value="${escapeHtml(c.slug)}">${escapeHtml(t(c.name))}</option>`)
				.join('')
		}
		paintCategoryPicker($('supCatalogCategory')?.value || '')
		paintFamilyPicker($('supCatalogFamily')?.value || '', $('supCatalogCategory')?.value || '')
		renderCategoryChips()
	}

	function paintCategoryPicker(selectedSlug) {
		const host = $('supCatalogCategoryPicker')
		if (!host) return
		host.innerHTML = state.categories
			.map(
				(c) =>
					`<button type="button" class="sup-chip${(selectedSlug || '') === c.slug ? ' active' : ''}" data-pick-cat="${escapeHtml(c.slug)}">${escapeHtml(t(c.name))}</button>`,
			)
			.join('')
		paintFamilyPicker($('supCatalogFamily')?.value || '', selectedSlug)
	}

	function paintFamilyPicker(selectedSlug, categorySlug) {
		const wrap = $('supCatalogFamilyWrap')
		const host = $('supCatalogFamilyPicker')
		const input = $('supCatalogFamily')
		const families = familiesForCategory(categorySlug)
		if (wrap) wrap.hidden = !families.length
		if (!host) return
		if (!families.length) {
			host.innerHTML = ''
			if (input) input.value = ''
			return
		}
		const current = families.some((f) => f.slug === selectedSlug) ? selectedSlug : families[0].slug
		if (input) input.value = current
		host.innerHTML = families
			.map(
				(f) =>
					`<button type="button" class="sup-chip${current === f.slug ? ' active' : ''}" data-pick-family="${escapeHtml(f.slug)}">${escapeHtml(t(f.name))}</button>`,
			)
			.join('')
	}

	async function loadInventory() {
		closeCardMenu()
		const gen = ++inventoryLoadGen
		await loadCategories()
		if (gen !== inventoryLoadGen) return
		const params = new URLSearchParams({ active: state.includeArchived ? 'all' : '1' })
		const [itemsData, alertsData, countData] = await Promise.all([
			api(`/api/supplies/items?${params}`),
			api('/api/supplies/alerts'),
			api('/api/supplies/counts/current'),
		])
		if (gen !== inventoryLoadGen) return
		state.items = itemsData.items || []
		state.alerts = alertsData
		state.countSession = countData.session
		const nextCounting = Boolean(countData.session)
		if (nextCounting && !state.counting) state.filterCountPending = true
		if (!nextCounting) state.filterCountPending = false
		state.counting = nextCounting
		preloadThumbs(state.counting ? countData.session.lines : state.items)
		renderAlertBanner()
		renderCountBar()
		renderInventoryGrid()
		paintBuyChip()
		$('supArchivedChip')?.classList.toggle('active', state.includeArchived)
	}

	function preloadThumbs(records) {
		if (!window.Image) return
		for (const rec of (records || []).slice(0, 8)) {
			const src = rec.photo_thumb || rec.photo_path
			if (!src) continue
			const img = new window.Image()
			img.decoding = 'async'
			img.src = src
		}
	}

	async function loadLog() {
		const gen = ++logLoadGen
		const [sessions, movements] = await Promise.all([
			api('/api/supplies/counts?limit=20'),
			api('/api/supplies/movements?limit=40'),
			isOwner() ? loadSpend() : Promise.resolve(),
		])
		if (gen !== logLoadGen) return
		if (!isOwner()) renderSpend()
		$('supSessionsList').innerHTML = sessions.sessions?.length
			? `<table><thead><tr><th>#</th><th>${escapeHtml(t('Status'))}</th><th>${escapeHtml(t('Progress'))}</th><th>${escapeHtml(t('When'))}</th></tr></thead><tbody>
				${sessions.sessions
					.map(
						(s) => `<tr>
					<td>${s.id}</td><td>${escapeHtml(t(s.status))}</td>
					<td>${s.counted_count}/${s.line_count}${s.variance_count ? ` · Δ${s.variance_count}` : ''}</td>
					<td>${escapeHtml(formatTimestamp(s.submitted_at || s.started_at))}</td>
				</tr>`,
					)
					.join('')}
			</tbody></table>`
			: `<div class="sup-empty">${escapeHtml(t('No daily counts yet.'))}</div>`

		$('supMovementsList').innerHTML = movements.movements?.length
			? `<table><thead><tr><th>${escapeHtml(t('When'))}</th><th>${escapeHtml(t('Item'))}</th><th>${escapeHtml(t('Kind'))}</th><th>Δ</th><th>${escapeHtml(t('After'))}</th></tr></thead><tbody>
				${movements.movements
					.map(
						(m) => `<tr>
					<td>${escapeHtml(formatTimestamp(m.created_at))}</td>
					<td data-i18n-skip>${escapeHtml(displayName({ name: m.item_name, name_zh: m.item_name_zh }))}</td>
					<td>${escapeHtml(t(m.kind))}</td>
					<td>${escapeHtml(t(fmtQty(m.qty_delta)))}</td>
					<td>${escapeHtml(t(fmtQty(m.qty_after)))}</td>
				</tr>`,
					)
					.join('')}
			</tbody></table>`
			: `<div class="sup-empty">${escapeHtml(t('No stock movements yet.'))}</div>`
	}

	function ymdLocal(d) {
		const y = d.getFullYear()
		const m = String(d.getMonth() + 1).padStart(2, '0')
		const day = String(d.getDate()).padStart(2, '0')
		return `${y}-${m}-${day}`
	}

	function parseLocalDateStart(ymd) {
		if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null
		const [y, m, d] = ymd.split('-').map(Number)
		return new Date(y, m - 1, d)
	}

	function spendRangeUtc() {
		if (state.spendPreset === 'custom') {
			const from = parseLocalDateStart($('supSpendFrom')?.value)
			const toDay = parseLocalDateStart($('supSpendTo')?.value)
			if (!from || !toDay) throw new Error(t('Pick a start and end date'))
			if (toDay < from) throw new Error(t('End date must be on or after the start date'))
			const to = new Date(toDay.getFullYear(), toDay.getMonth(), toDay.getDate() + 1)
			return { from: from.toISOString(), to: to.toISOString() }
		}
		const now = new Date()
		const monthOffset = state.spendPreset === 'last-month' ? -1 : 0
		const from = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1)
		const to = new Date(now.getFullYear(), now.getMonth() + monthOffset + 1, 1)
		return { from: from.toISOString(), to: to.toISOString() }
	}

	function paintSpendRangeControls() {
		const custom = state.spendPreset === 'custom'
		const fromEl = $('supSpendFrom')
		const toEl = $('supSpendTo')
		if (!custom) {
			const now = new Date()
			const monthOffset = state.spendPreset === 'last-month' ? -1 : 0
			const start = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1)
			const end = new Date(now.getFullYear(), now.getMonth() + monthOffset + 1, 0)
			if (fromEl) fromEl.value = ymdLocal(start)
			if (toEl) toEl.value = ymdLocal(end)
		}
		if (fromEl) fromEl.disabled = !custom
		if (toEl) toEl.disabled = !custom
		document.querySelectorAll('#supSpendPanel [data-spend-preset]').forEach((btn) => {
			btn.classList.toggle('active', btn.dataset.spendPreset === state.spendPreset)
		})
	}

	function renderSpend() {
		const panel = $('supSpendPanel')
		if (!panel) return
		panel.hidden = !isOwner()
		if (!isOwner()) return
		paintSpendRangeControls()
		const summary = $('supSpendSummary')
		const list = $('supSpendList')
		if (!summary || !list) return
		if (state.spend && state.spend.error) {
			summary.innerHTML = `<p class="sup-error">${escapeHtml(state.spend.error)}</p>`
			list.innerHTML = ''
			return
		}
		const totals = (state.spend && state.spend.totals) || []
		const lines = (state.spend && state.spend.lines) || []
		if (!totals.length) {
			summary.innerHTML = `<p class="sup-meta">${escapeHtml(t('No restock cost in this period.'))}</p>`
			list.innerHTML = ''
			return
		}
		summary.innerHTML = `<div class="sup-spend-totals">${totals
			.map(
				(row) => `<div class="sup-spend-total">
					<strong>${escapeHtml(fmtMoney(row.amount, row.currency) || '')}</strong>
					<span class="sup-meta">${escapeHtml(t(`${row.receives} restocks`))} · ${escapeHtml(t(fmtQty(row.qty)))}</span>
				</div>`,
			)
			.join('')}</div>`
		list.innerHTML = `<table><thead><tr><th>${escapeHtml(t('When'))}</th><th>${escapeHtml(t('Item'))}</th><th>${escapeHtml(t('Qty'))}</th><th>${escapeHtml(t('Paid'))}</th><th></th></tr></thead><tbody>
			${lines
				.map((line) => {
					const rec = { name: line.item_name, name_zh: line.item_name_zh, supplier_url: line.supplier_url, supplier_name: line.supplier_name }
					const money = fmtMoney(line.cost_total, line.currency) || ''
					return `<tr>
						<td>${escapeHtml(formatTimestamp(line.created_at))}</td>
						<td data-i18n-skip>${escapeHtml(displayName(rec))}</td>
						<td>${escapeHtml(t(fmtQty(line.qty, line.uom)))}</td>
						<td>${escapeHtml(money)}</td>
						<td>${buyLink(rec, { variant: 'text', label: 'Buy' })}</td>
					</tr>`
				})
				.join('')}
		</tbody></table>`
	}

	async function loadSpend() {
		if (!isOwner()) {
			renderSpend()
			return
		}
		const gen = ++spendLoadGen
		paintSpendRangeControls()
		let range
		try {
			range = spendRangeUtc()
		} catch (err) {
			if (gen !== spendLoadGen) return
			state.spend = { error: errorMessage(err), totals: [], lines: [] }
			renderSpend()
			return
		}
		try {
			const data = await api(`/api/supplies/spend?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`)
			if (gen !== spendLoadGen) return
			state.spend = data
			renderSpend()
		} catch (err) {
			if (gen !== spendLoadGen) return
			state.spend = { error: errorMessage(err), totals: [], lines: [] }
			renderSpend()
		}
	}

	function openCountModal(itemId) {
		const line = state.countSession?.lines.find((l) => l.item_id === itemId)
		if (!line) return
		closeCardMenu()
		state.countEditItemId = itemId
		$('supCountModalPhotoWrap').innerHTML = photoMarkup(line, { eager: true, detail: true })
		$('supCountModalName').textContent = displayName(line)
		$('supCountModalMeta').textContent = t(`${t(line.category_name)} · system has ${fmtQty(line.expected_qty, line.uom)}`)
		if ($('supCountModalHint')) {
			$('supCountModalHint').textContent = t('They look right until something is out. Tap Need to buy to remind us. Type a number only when the pile is off.')
		}
		const expected = expectedQty(line)
		const empty = isEmptyExpectedUncounted(line)
		$('supCountModalQty').value = lineIsCounted(line) ? line.counted_qty : expected
		$('supCountModalShortcuts')?.classList.toggle('is-empty-expected', empty)
		const matchBtn = $('supCountModalMatch')
		if (matchBtn) {
			matchBtn.classList.add('sup-btn-primary')
			matchBtn.classList.remove('sup-btn-ghost')
		}
		if ($('supCountModalNone')) $('supCountModalNone').hidden = expected === 0
		const buyBtn = $('supCountModalBuy')
		if (buyBtn) {
			const flagged = isNeedsPurchase(line)
			buyBtn.textContent = flagged ? t('Cancel buy') : t('Need to buy')
			buyBtn.dataset.needsPurchase = flagged ? '0' : '1'
		}
		$('supCountModal').showModal()
		setTimeout(() => {
			$('supCountModalQty')?.focus()
		}, 40)
	}

	function openRestockModal(itemId) {
		const item = state.items.find((i) => i.id === itemId)
		if (!item) return
		closeCardMenu()
		state.restockItemId = itemId
		$('supRestockPhotoWrap').innerHTML = photoMarkup(item, { eager: true, detail: true })
		$('supRestockName').textContent = displayName(item)
		$('supRestockMeta').textContent = t(
			`${fmtQty(item.qty_on_hand, item.uom)} on hand · reorder at ${fmtQty(item.reorder_point, item.uom)} · suggested buy ${fmtQty(item.reorder_qty, item.uom)}`,
		)
		$('supRestockBuy').innerHTML = buyLink(item, { variant: 'button', label: 'Buy now' })
		$('supRestockQty').value = item.is_low && Number(item.reorder_qty) > 0 ? item.reorder_qty : ''
		$('supRestockCost').value = item.unit_cost == null || item.unit_cost === '' ? '' : item.unit_cost
		$('supRestockCurrency').value = item.currency || 'USD'
		$('supRestockNote').value = ''
		$('supRestockError').hidden = true
		paintRestockTotal()
		$('supRestockModal').showModal()
		setTimeout(() => $('supRestockQty').focus(), 40)
	}

	function restockUnitCost() {
		const typed = $('supRestockCost')?.value
		if (typed != null && String(typed).trim() !== '') {
			const n = Number(typed)
			return Number.isFinite(n) ? n : null
		}
		const item = state.items.find((i) => i.id === state.restockItemId)
		const inherited = item && item.unit_cost != null ? Number(item.unit_cost) : null
		return Number.isFinite(inherited) ? inherited : null
	}

	function restockCurrency() {
		const typed = $('supRestockCost')?.value
		if (typed != null && String(typed).trim() !== '') return $('supRestockCurrency')?.value || 'USD'
		const item = state.items.find((i) => i.id === state.restockItemId)
		return (item && item.currency) || $('supRestockCurrency')?.value || 'USD'
	}

	function paintRestockTotal() {
		const el = $('supRestockTotal')
		if (!el) return
		const qty = Number($('supRestockQty')?.value)
		const unit = restockUnitCost()
		if (!Number.isFinite(qty) || qty <= 0 || unit == null) {
			el.textContent = t('This restock: —')
			return
		}
		const money = fmtMoney(Math.round(qty * unit * 100) / 100, restockCurrency())
		el.textContent = t(`This restock: ${money || '—'}`)
	}

	function currentCatalogItem() {
		const id = $('supCatalogId')?.value
		if (!id) return null
		return state.items.find((item) => String(item.id) === String(id)) || null
	}

	function revokeCatalogPreview() {
		if (!state.catalogPreviewUrl) return
		try {
			URL.revokeObjectURL(state.catalogPreviewUrl)
		} catch {
			/* ignore */
		}
		state.catalogPreviewUrl = null
	}

	function setPendingCatalogPhoto(file) {
		state.pendingCatalogPhoto = file || null
		paintCatalogPhotoPreview(currentCatalogItem())
	}

	function paintCatalogPhotoPreview(item) {
		const preview = $('supCatalogPhotoPreview')
		const action = $('supCatalogPhotoAction')
		if (!preview) return
		revokeCatalogPreview()
		const file = state.pendingCatalogPhoto
		if (file && isImageFile(file)) {
			try {
				state.catalogPreviewUrl = URL.createObjectURL(file)
			} catch {
				state.catalogPreviewUrl = null
			}
			if (state.catalogPreviewUrl) {
				preview.innerHTML = `<img src="${escapeHtml(state.catalogPreviewUrl)}" alt="" width="88" height="88" />`
			} else {
				preview.innerHTML = `<div class="sup-photo placeholder">${escapeHtml(t('Photo'))}</div>`
			}
			if (action) action.textContent = t('Replace photo')
			return
		}
		if (item && (item.photo_detail || item.photo_thumb || item.photo_path)) {
			preview.innerHTML = photoMarkup(item, { eager: true, detail: true })
			if (action) action.textContent = t('Replace photo')
			return
		}
		preview.innerHTML = `<div class="sup-photo placeholder">${escapeHtml(t('No photo'))}</div>`
		if (action) action.textContent = t('Add photo')
	}

	function revealSupply(itemId) {
		const id = Number(itemId)
		if (!Number.isFinite(id) || id <= 0) return
		const card = document.querySelector(`#tab-supplies .sup-card[data-item-id="${id}"]`)
		if (!card) return
		card.classList.add('is-just-added')
		if (typeof card.scrollIntoView === 'function') {
			card.scrollIntoView({ block: 'nearest', inline: 'nearest' })
		}
		window.setTimeout(() => card.classList.remove('is-just-added'), 1800)
	}

	function resetCatalogFiltersForNewItem() {
		if (!state.filterQ && !state.filterNeedsPurchase && !state.filterCategory && !state.filterFamily) return
		state.filterQ = ''
		state.filterNeedsPurchase = false
		state.purchaseQueueOpen = false
		state.filterCategory = ''
		state.filterFamily = ''
		if ($('supSearch')) $('supSearch').value = ''
		$('supBuyChip')?.classList.remove('active')
		$('supBuyChip')?.setAttribute('aria-pressed', 'false')
		renderCategoryChips()
		renderFamilyChips()
	}

	function openCatalogModal(id) {
		if (!canManageCatalog()) return
		closeCardMenu()
		const item = id ? state.items.find((i) => i.id === id) : null
		$('supCatalogTitle').textContent = item ? t('Edit supply') : t('New packing supply')
		$('supCatalogId').value = item ? item.id : ''
		$('supCatalogSku').value = item?.sku || ''
		if (isZh()) {
			$('supCatalogAltLabel').textContent = t('English name')
			$('supCatalogName').value = item ? displayName(item) : ''
			$('supCatalogAltName').value = item?.name || ''
		} else {
			$('supCatalogAltLabel').textContent = t('Chinese name')
			$('supCatalogName').value = item?.name || ''
			$('supCatalogAltName').value = item?.name_zh || ''
		}
		$('supCatalogCategory').value = item?.category_slug || state.categories[0]?.slug || ''
		paintCategoryPicker($('supCatalogCategory').value)
		paintFamilyPicker(item?.family || '', $('supCatalogCategory').value)
		$('supCatalogUom').value = item?.uom || 'each'
		$('supCatalogReorderPoint').value = item?.reorder_point ?? 0
		$('supCatalogReorderQty').value = item?.reorder_qty ?? 0
		$('supCatalogCost').value = item?.unit_cost ?? ''
		$('supCatalogCurrency').value = item?.currency || 'USD'
		$('supCatalogSupplierName').value = item?.supplier_name || ''
		$('supCatalogSupplierUrl').value = item?.supplier_url || ''
		$('supCatalogNotes').value = item?.notes || ''
		$('supCatalogActive').checked = item ? !!item.active : true
		if ($('supCatalogPhoto')) $('supCatalogPhoto').value = ''
		state.pendingCatalogPhoto = null
		$('supCatalogError').hidden = true
		paintCatalogChrome(item)
		paintCatalogPhotoPreview(item)
		$('supCatalogModal').showModal()
		window.setTimeout(() => $('supCatalogName')?.focus(), 40)
	}

	function paintCatalogChrome(item) {
		const existing = Boolean(item)
		const activeWrap = $('supCatalogActiveWrap')
		if (activeWrap) activeWrap.hidden = !existing
		paintCatalogDanger(item)
	}

	function paintCatalogDanger(item) {
		const existing = Boolean(item)
		const active = isActiveItem(item)
		const archiveBtn = $('supCatalogArchive')
		const restoreBtn = $('supCatalogRestore')
		const purgeBtn = $('supCatalogPurge')
		if (archiveBtn) archiveBtn.hidden = !existing || !active
		if (restoreBtn) restoreBtn.hidden = !existing || active
		if (purgeBtn) purgeBtn.hidden = !existing || active
	}

	function confirmRemoveSupply({ purge } = {}) {
		if (purge) return window.confirm(t('Delete this supply permanently? This cannot be undone.'))
		return window.confirm(t('Retire this supply? It stays in history but leaves the daily count.'))
	}

	function showCatalogError(err) {
		const el = $('supCatalogError')
		if (!el) {
			toast(errorMessage(err))
			return
		}
		el.hidden = false
		el.textContent = errorMessage(err)
	}

	async function removeSupply(itemId, { purge = false, btn } = {}) {
		if (!canManageCatalog()) return
		const id = Number(itemId)
		if (!Number.isFinite(id) || id <= 0) return
		if (!findRecord(id)) return
		if (!confirmRemoveSupply({ purge })) return
		try {
			await withBusy(btn, async () => {
				const path = purge ? `/api/supplies/items/${id}?purge=1` : `/api/supplies/items/${id}`
				const result = await api(path, { method: 'DELETE' })
				$('supCatalogModal')?.close()
				await loadInventory()
				toast(result && result.deleted ? 'Supply deleted' : 'Supply retired')
			})
		} catch (err) {
			if ($('supCatalogModal')?.open) showCatalogError(err)
			else toast(errorMessage(err))
		}
	}

	async function restoreSupply(itemId, btn) {
		if (!canManageCatalog()) return
		const id = Number(itemId)
		if (!Number.isFinite(id) || id <= 0) return
		if (!findRecord(id)) return
		try {
			await withBusy(btn, async () => {
				await api(`/api/supplies/items/${id}`, { method: 'PATCH', body: { active: 1 } })
				$('supCatalogModal')?.close()
				await loadInventory()
				toast('Supply restored')
			})
		} catch (err) {
			if ($('supCatalogModal')?.open) showCatalogError(err)
			else toast(errorMessage(err))
		}
	}

	function readFileAsDataUrl(file) {
		return new Promise((resolve, reject) => {
			const reader = new FileReader()
			reader.onload = () => resolve(reader.result)
			reader.onerror = () => reject(new Error(t('Could not read photo')))
			reader.readAsDataURL(file)
		})
	}

	function applyCountQtyLocally(itemId, countedQty) {
		if (!state.countSession || !Array.isArray(state.countSession.lines)) return
		const line = state.countSession.lines.find((l) => l.item_id === itemId)
		if (!line) return
		if (countedQty == null || countedQty === '') {
			line.counted_qty = null
			line.variance = null
		} else {
			const qty = Number(countedQty)
			line.counted_qty = qty
			line.variance = Math.round((qty - Number(line.expected_qty)) * 1000) / 1000
		}
		recomputeCountProgress()
	}

	function mergeRemoteCountLines(remoteSession, claimedSeqs) {
		if (!remoteSession || !state.countSession) return
		const remoteById = new Map((remoteSession.lines || []).map((line) => [line.item_id, line]))
		for (const [itemId, seq] of claimedSeqs) {
			if (countWriteSeq.get(itemId) !== seq) continue
			const remote = remoteById.get(itemId)
			const local = state.countSession.lines.find((line) => line.item_id === itemId)
			if (!local || !remote) continue
			local.counted_qty = remote.counted_qty
			local.variance = remote.variance
			if (remote.counted_at != null) local.counted_at = remote.counted_at
		}
		if (remoteSession.id) state.countSession.id = remoteSession.id
		if (remoteSession.status) state.countSession.status = remoteSession.status
		recomputeCountProgress()
	}

	async function saveCountLines(updates) {
		if (!state.countSession || !updates.length) return
		const snapshots = new Map()
		const claimedSeqs = new Map()
		for (const update of updates) {
			const itemId = update.itemId
			const line = state.countSession.lines.find((row) => row.item_id === itemId)
			if (!line) continue
			snapshots.set(itemId, { counted_qty: line.counted_qty, variance: line.variance })
			const seq = (countWriteSeq.get(itemId) || 0) + 1
			countWriteSeq.set(itemId, seq)
			claimedSeqs.set(itemId, seq)
			applyCountQtyLocally(itemId, update.countedQty)
		}
		if (!claimedSeqs.size) return
		const hidesCounted = countWalkHidesCounted()
		const pendingBeforeRelease = state.filterCountPending
		const onlyId = claimedSeqs.size === 1 ? [...claimedSeqs.keys()][0] : null
		const focusId = onlyId == null ? null : hidesCounted ? peekAdjacentCountItemId(onlyId) : onlyId
		releaseCountWalkIfComplete()
		renderCountBar()
		renderInventoryGrid()
		if (focusId != null) focusCountCard(focusId)
		try {
			const data = await api(`/api/supplies/counts/${state.countSession.id}/lines`, {
				method: 'PUT',
				body: {
					lines: updates
						.filter((update) => claimedSeqs.has(update.itemId))
						.map((update) => ({ item_id: update.itemId, counted_qty: update.countedQty })),
				},
			})
			mergeRemoteCountLines(data.session, claimedSeqs)
			renderCountBar()
			renderInventoryGrid()
			if (focusId != null) focusCountCard(focusId)
		} catch (err) {
			for (const [itemId, seq] of claimedSeqs) {
				if (countWriteSeq.get(itemId) !== seq) continue
				const snap = snapshots.get(itemId)
				if (snap) applyCountQtyLocally(itemId, snap.counted_qty)
			}
			state.filterCountPending = pendingBeforeRelease
			renderCountBar()
			renderInventoryGrid()
			toast(errorMessage(err))
			throw err
		}
	}

	async function saveCountQty(itemId, countedQty) {
		return saveCountLines([{ itemId, countedQty }])
	}

	function confirmMatch(itemId, btn) {
		const line = state.countSession?.lines.find((row) => row.item_id === itemId)
		if (!line) return
		return withBusy(btn, () => saveCountQty(itemId, expectedQty(line))).catch(() => {})
	}

	function confirmNone(itemId, btn) {
		if (!state.countSession?.lines.find((row) => row.item_id === itemId)) return
		return withBusy(btn, () => saveCountQty(itemId, 0)).catch(() => {})
	}

	function confirmNeedToBuy(itemId, needed, btn) {
		const line = state.countSession?.lines.find((row) => row.item_id === itemId)
		return withBusy(btn, async () => {
			if (needed && line && !lineIsCounted(line)) {
				await saveCountQty(itemId, expectedQty(line))
			}
			try {
				const data = await api(`/api/supplies/items/${itemId}/needs-purchase`, {
					method: 'POST',
					body: { needed: Boolean(needed) },
				})
				if (data && data.item) patchItem(data.item)
			} catch (err) {
				toast(errorMessage(err))
				throw err
			}
		})
	}

	function handleNeedsPurchaseClick(e) {
		const btn = e.target.closest('[data-needs-purchase]')
		if (!btn) return false
		e.preventDefault()
		e.stopPropagation()
		confirmNeedToBuy(Number(btn.dataset.itemId), btn.dataset.needsPurchase !== '0', btn).catch(() => {})
		return true
	}

	function confirmMarkPurchased(itemId, btn) {
		return withBusy(btn, async () => {
			try {
				const data = await api(`/api/supplies/items/${itemId}/purchased`, {
					method: 'POST',
					body: { purchased: true },
				})
				if (data && data.item) patchItem(data.item)
				toast('Marked purchased')
			} catch (err) {
				toast(errorMessage(err))
				throw err
			}
		})
	}

	function handleMarkPurchasedClick(e) {
		const btn = e.target.closest('[data-mark-purchased]')
		if (!btn) return false
		e.preventDefault()
		e.stopPropagation()
		confirmMarkPurchased(Number(btn.dataset.markPurchased), btn).catch(() => {})
		return true
	}

	async function confirmRemainingMatch(btn) {
		const remaining = remainingUncountedLines()
		if (!remaining.length) return
		const n = remaining.length
		if (!window.confirm(t(`Mark ${n} unchecked supplies as looking right? You will not need to tap each one.`))) return
		try {
			const ran = await withBusy(btn, () =>
				saveCountLines(remaining.map((line) => ({ itemId: line.item_id, countedQty: expectedQty(line) }))),
			)
			if (ran && $('supSubmitModal')?.open) openSubmitModal()
		} catch {
			// toast already shown
		}
	}

	function adjustCount(itemId, delta) {
		const line = state.countSession?.lines.find((l) => l.item_id === itemId)
		if (!line) return
		const base = line.counted_qty != null ? Number(line.counted_qty) : Number(line.expected_qty) || 0
		const next = Math.max(0, Math.round((base + delta) * 1000) / 1000)
		return saveCountQty(itemId, next).catch(() => {})
	}

	async function startCount() {
		try {
			const data = await api('/api/supplies/counts', { method: 'POST', body: {} })
			state.countSession = data.session
			state.counting = true
			state.filterCountPending = true
			state.view = 'inventory'
			setView('inventory')
			toast('Daily count started')
		} catch (err) {
			if (err.status === 409 && err.data?.session) {
				state.countSession = err.data.session
				state.counting = true
				state.filterCountPending = true
				await loadInventory()
				toast('Resumed open count')
			} else toast(errorMessage(err))
		}
	}

	async function cancelCount() {
		if (!state.countSession) return
		if (!window.confirm(t('Cancel this shelf check? Anything already checked will be discarded.'))) return
		try {
			await api(`/api/supplies/counts/${state.countSession.id}/cancel`, { method: 'POST', body: {} })
			state.countSession = null
			state.counting = false
			state.filterCountPending = false
			await loadInventory()
			toast('Count cancelled')
		} catch (err) {
			toast(errorMessage(err))
		}
	}

	function openSubmitModal() {
		if (!state.countSession) return
		const p = state.countSession.progress || { counted: 0, remaining: 0 }
		const remaining = Number(p.remaining) || 0
		const variances = state.countSession.lines.filter((l) => l.counted_qty != null && Number(l.variance) !== 0)
		const buyN = flaggedBuyLines().length
		let summary = remaining
			? t(`${p.counted} checked · ${remaining} not opened`)
			: t(`${p.counted} items counted · ${variances.length} will adjust on-hand stock`)
		if (buyN) summary = `${summary} · ${t(`${buyN} to buy`)}`
		$('supSubmitSummary').textContent = summary
		const pendingEl = $('supSubmitPending')
		if (pendingEl) {
			pendingEl.hidden = remaining === 0
			pendingEl.textContent = remaining ? t('Unchecked supplies keep their current on-hand quantity.') : ''
		}
		const matchRest = $('supSubmitMatchRest')
		if (matchRest) matchRest.hidden = remaining === 0
		$('supSubmitVariances').innerHTML = variances.length
			? `<table><thead><tr><th>${escapeHtml(t('Item'))}</th><th>${escapeHtml(t('Expected'))}</th><th>${escapeHtml(t('Counted'))}</th><th>Δ</th></tr></thead><tbody>
				${variances
					.map(
						(l) => `<tr>
					<td data-i18n-skip>${escapeHtml(displayName(l))}</td>
					<td>${escapeHtml(t(fmtQty(l.expected_qty, l.uom)))}</td><td>${escapeHtml(t(fmtQty(l.counted_qty, l.uom)))}</td><td>${escapeHtml(t(fmtQty(l.variance, l.uom)))}</td>
				</tr>`,
					)
					.join('')}
			</tbody></table>`
			: `<div class="sup-empty">${escapeHtml(t(remaining ? 'No variances yet — unchecked supplies will keep current on-hand.' : 'No variances — shelf already matches the system.'))}</div>`
		$('supSubmitModal').showModal()
	}

	function wire() {
		const rootEl = $('suppliesRoot')
		rootEl.addEventListener(
			'click',
			(e) => {
				const toggle = e.target.closest('[data-menu]')
				if (!toggle || !rootEl.contains(toggle)) return
				e.preventDefault()
				e.stopPropagation()
				openCardMenu(toggle)
			},
			true,
		)
		const menuPanel = $('supCardMenu')
		menuPanel?.addEventListener('click', (e) => {
			if (handleOwnerAction(e)) return
		})
		menuPanel?.addEventListener('keydown', handleMenuKeydown)
		document.addEventListener('pointerdown', (e) => {
			if (!state.menuItemId) return
			if (e.target.closest('#supCardMenu, [data-menu]')) return
			closeCardMenu()
		})
		document.addEventListener('keydown', (e) => {
			if (e.key !== 'Escape') return
			if (anyModalOpen()) return
			if (!state.menuItemId) return
			e.preventDefault()
			closeCardMenu(true)
		})
		window.addEventListener('resize', () => {
			if (state.menuToggle) positionCardMenu(state.menuToggle)
		})
		window.addEventListener(
			'scroll',
			() => {
				if (state.menuItemId) closeCardMenu()
			},
			true,
		)

		document.querySelectorAll('#suppliesRoot .sup-tab').forEach((btn) => {
			btn.addEventListener('click', () => setView(btn.dataset.supView))
		})

		$('supStartCount').addEventListener('click', startCount)
		$('supNewItem').addEventListener('click', () => openCatalogModal(null))

		$('supSearch').addEventListener('input', () => {
			state.filterQ = $('supSearch').value
			renderInventoryGrid()
		})

		$('supCategoryChips').addEventListener('click', (e) => {
			const btn = e.target.closest('[data-cat]')
			if (!btn) return
			state.filterCategory = btn.dataset.cat || ''
			state.filterFamily = ''
			renderCategoryChips()
			renderInventoryGrid()
		})
		$('supFamilyChips').addEventListener('click', (e) => {
			const btn = e.target.closest('[data-family]')
			if (!btn) return
			state.filterFamily = btn.dataset.family || ''
			renderFamilyChips()
			renderInventoryGrid()
		})

		$('supBuyChip').addEventListener('click', () => {
			state.filterNeedsPurchase = !state.filterNeedsPurchase
			state.purchaseQueueOpen = isOwner() && state.filterNeedsPurchase
			paintBuyChip()
			renderBuyQueue()
			renderInventoryGrid()
		})

		$('supArchivedChip').addEventListener('click', async () => {
			state.includeArchived = !state.includeArchived
			$('supArchivedChip').classList.toggle('active', state.includeArchived)
			await loadInventory()
		})

		$('supBuyQueue').addEventListener('click', (e) => {
			if (e.target.id === 'supBuyQueueClose') {
				closeBuyQueue()
				return
			}
			if (handleMarkPurchasedClick(e)) return
			if (handleNeedsPurchaseClick(e)) return
			const restock = e.target.closest('[data-restock]')
			if (restock) {
				e.preventDefault()
				openRestockModal(Number(restock.dataset.restock))
			}
		})

		$('supAlertBanner').addEventListener('click', (e) => {
			if (e.target.id === 'supShowBuy') {
				showToBuy()
				return
			}
			const restock = e.target.closest('[data-restock]')
			if (restock) openRestockModal(Number(restock.dataset.restock))
		})

		$('supReplacePhoto')?.addEventListener('change', (e) => {
			const file = e.target.files && e.target.files[0]
			e.target.value = ''
			if (file) replacePhotoFromFile(file)
		})

		$('supInventoryGrid').addEventListener('click', (e) => {
			if (drag.moved) return
			const jump = e.target.closest('[data-jump-family]')
			if (jump) {
				e.preventDefault()
				const target = document.getElementById(`sup-family-${jump.dataset.jumpCat}-${jump.dataset.jumpFamily}`)
				target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
				return
			}
			if (handleNameActivate(e)) return
			if (handleOwnerAction(e)) return
			if (handleNeedsPurchaseClick(e)) return
			if (e.target.closest('[data-stop], .sup-name-input, [data-menu]')) return
			const restock = e.target.closest('[data-restock]')
			if (restock) {
				e.preventDefault()
				openRestockModal(Number(restock.dataset.restock))
				return
			}
			const card = e.target.closest('[data-item-id]')
			if (!card) return
			if (rename.suppressCardClick) return
			if (canManageCatalog()) openCatalogModal(Number(card.dataset.itemId))
			else openRestockModal(Number(card.dataset.itemId))
		})

		$('supCountGrid').addEventListener('click', (e) => {
			if (drag.moved) return
			const jump = e.target.closest('[data-jump-family]')
			if (jump) {
				e.preventDefault()
				const target = document.getElementById(`sup-family-${jump.dataset.jumpCat}-${jump.dataset.jumpFamily}`)
				target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
				return
			}
			if (handleNameActivate(e)) return
			if (handleOwnerAction(e)) return
			if (handleNeedsPurchaseClick(e)) return
			const matchBtn = e.target.closest('[data-count-match]')
			if (matchBtn) {
				e.preventDefault()
				e.stopPropagation()
				confirmMatch(Number(matchBtn.dataset.countMatch), matchBtn)
				return
			}
			const noneBtn = e.target.closest('[data-count-none]')
			if (noneBtn) {
				e.preventDefault()
				e.stopPropagation()
				confirmNone(Number(noneBtn.dataset.countNone), noneBtn)
				return
			}
			const deltaBtn = e.target.closest('[data-count-delta]')
			if (deltaBtn) {
				e.preventDefault()
				e.stopPropagation()
				adjustCount(Number(deltaBtn.dataset.itemId), Number(deltaBtn.dataset.countDelta))
				return
			}
			const editQty = e.target.closest('[data-count-edit]')
			if (editQty) {
				e.preventDefault()
				e.stopPropagation()
				openCountModal(Number(editQty.dataset.countEdit))
				return
			}
			if (e.target.closest('[data-stop], .sup-name-input, [data-menu]')) return
			const card = e.target.closest('[data-item-id]')
			if (!card) return
			if (rename.suppressCardClick) return
			openCountModal(Number(card.dataset.itemId))
		})
		$('supCountGrid').addEventListener('keydown', (e) => {
			if (e.key !== 'Enter' && e.key !== ' ') return
			if (e.target.closest('[data-count-delta], [data-count-edit], [data-count-match], [data-count-none], [data-needs-purchase], [data-remove], [data-replace-photo], [data-new-item], [data-menu], input, textarea, select, [data-rename], .sup-name-input, .sup-menu-toggle')) return
			const card = e.target.closest('[data-item-id]')
			if (!card) return
			e.preventDefault()
			openCountModal(Number(card.dataset.itemId))
		})

		wireArrange($('supInventoryGrid'))
		wireArrange($('supCountGrid'))
		$('supCategoryChips').addEventListener('dragover', (e) => {
			const btn = e.target.closest('[data-cat]')
			if (!btn || !btn.dataset.cat || drag.id == null) return
			e.preventDefault()
			clearDropMarks()
			btn.classList.add('is-drop-target')
		})
		$('supCategoryChips').addEventListener('dragleave', (e) => {
			const btn = e.target.closest('[data-cat]')
			btn?.classList.remove('is-drop-target')
		})
		$('supCategoryChips').addEventListener('drop', (e) => {
			const btn = e.target.closest('[data-cat]')
			if (!btn || !btn.dataset.cat || drag.id == null) return
			e.preventDefault()
			const itemId = drag.id
			clearDropMarks()
			persistPlacement(itemId, {
				categorySlug: btn.dataset.cat,
				beforeId: null,
				family: familiesForCategory(btn.dataset.cat).length ? undefined : null,
			})
		})
		$('supFamilyChips').addEventListener('dragover', (e) => {
			const btn = e.target.closest('[data-family]')
			if (!btn || !btn.dataset.family || drag.id == null) return
			e.preventDefault()
			clearDropMarks()
			btn.classList.add('is-drop-target')
		})
		$('supFamilyChips').addEventListener('dragleave', (e) => {
			const btn = e.target.closest('[data-family]')
			btn?.classList.remove('is-drop-target')
		})
		$('supFamilyChips').addEventListener('drop', (e) => {
			const btn = e.target.closest('[data-family]')
			if (!btn || !btn.dataset.family || drag.id == null) return
			e.preventDefault()
			const itemId = drag.id
			clearDropMarks()
			persistPlacement(itemId, {
				categorySlug: btn.dataset.cat || 'stickers',
				beforeId: null,
				family: btn.dataset.family,
			})
		})

		$('supCountModalClose').addEventListener('click', () => $('supCountModal').close())
		$('supCountModalMatch')?.addEventListener('click', async () => {
			if (!state.countEditItemId || !state.countSession) return
			const line = state.countSession.lines.find((row) => row.item_id === state.countEditItemId)
			if (!line) return
			try {
				const ran = await withBusy($('supCountModalMatch'), () => saveCountQty(state.countEditItemId, expectedQty(line)))
				if (ran) $('supCountModal').close()
			} catch {
				// toast already shown
			}
		})
		$('supCountModalBuy')?.addEventListener('click', async () => {
			if (!state.countEditItemId || !state.countSession) return
			const buyBtn = $('supCountModalBuy')
			try {
				const ran = await confirmNeedToBuy(state.countEditItemId, buyBtn.dataset.needsPurchase !== '0', buyBtn)
				if (ran) $('supCountModal').close()
			} catch {
				// toast already shown
			}
		})
		$('supCountModalNone')?.addEventListener('click', async () => {
			if (!state.countEditItemId || !state.countSession) return
			try {
				const ran = await withBusy($('supCountModalNone'), () => saveCountQty(state.countEditItemId, 0))
				if (ran) $('supCountModal').close()
			} catch {
				// toast already shown
			}
		})
		$('supCountModalClear').addEventListener('click', async () => {
			if (!state.countEditItemId || !state.countSession) return
			try {
				const ran = await withBusy($('supCountModalClear'), () => saveCountQty(state.countEditItemId, null))
				if (ran) $('supCountModal').close()
			} catch {
				// toast already shown
			}
		})
		$('supCountModalForm').addEventListener('submit', async (e) => {
			e.preventDefault()
			if (!state.countEditItemId || !state.countSession) return
			const submitBtn = e.submitter || $('supCountModalForm').querySelector('button[type="submit"]')
			try {
				const ran = await withBusy(submitBtn, () => saveCountQty(state.countEditItemId, Number($('supCountModalQty').value)))
				if (ran) $('supCountModal').close()
			} catch {
				// toast already shown
			}
		})

		$('supSubmitCancel').addEventListener('click', () => $('supSubmitModal').close())
		$('supSubmitClose').addEventListener('click', () => $('supSubmitModal').close())
		$('supSubmitMatchRest')?.addEventListener('click', (e) => confirmRemainingMatch(e.currentTarget))
		$('supSubmitConfirm').addEventListener('click', async () => {
			const btn = $('supSubmitConfirm')
			try {
				await withBusy(btn, async () => {
					const remaining = Number(state.countSession?.progress?.remaining) || 0
					const result = await api(`/api/supplies/counts/${state.countSession.id}/submit`, {
						method: 'POST',
						body: { require_complete: remaining === 0 },
					})
					$('supSubmitModal').close()
					state.countSession = null
					state.counting = false
					state.filterCountPending = false
					await loadInventory()
					toast(`Submitted · ${result.movements.length} adjustment(s)`)
				})
			} catch (err) {
				toast(errorMessage(err))
			}
		})

		$('supRestockCancel').addEventListener('click', () => $('supRestockModal').close())
		$('supRestockClose').addEventListener('click', () => $('supRestockModal').close())
		$('supRestockQty')?.addEventListener('input', paintRestockTotal)
		$('supRestockCost')?.addEventListener('input', paintRestockTotal)
		$('supRestockCurrency')?.addEventListener('change', paintRestockTotal)
		$('supRestockForm').addEventListener('submit', async (e) => {
			e.preventDefault()
			$('supRestockError').hidden = true
			const submitBtn = e.submitter || $('supRestockForm').querySelector('button[type="submit"]')
			try {
				await withBusy(submitBtn, async () => {
					const body = {
						item_id: state.restockItemId,
						qty: Number($('supRestockQty').value),
						note: $('supRestockNote').value.trim() || undefined,
					}
					const costRaw = $('supRestockCost').value.trim()
					if (costRaw !== '') {
						body.unit_cost = Number(costRaw)
						body.currency = $('supRestockCurrency').value
					}
					const result = await api('/api/supplies/receive', {
						method: 'POST',
						body,
					})
					$('supRestockModal').close()
					patchItem(result.item)
					toast(`Restocked. On-hand now ${fmtQty(result.item.qty_on_hand, result.item.uom)}`)
				})
			} catch (err) {
				$('supRestockError').hidden = false
				$('supRestockError').textContent = errorMessage(err)
			}
		})

		$('supSpendPanel')?.addEventListener('click', (e) => {
			const preset = e.target.closest('[data-spend-preset]')
			if (preset) {
				state.spendPreset = preset.dataset.spendPreset
				paintSpendRangeControls()
				if (state.spendPreset !== 'custom') void loadSpend()
				return
			}
			if (e.target.closest('#supSpendApply')) void loadSpend()
		})
		$('supSpendFrom')?.addEventListener('change', () => {
			if (state.spendPreset === 'custom') void loadSpend()
		})
		$('supSpendTo')?.addEventListener('change', () => {
			if (state.spendPreset === 'custom') void loadSpend()
		})

		$('supCatalogCancel').addEventListener('click', () => $('supCatalogModal').close())
		$('supCatalogClose').addEventListener('click', () => $('supCatalogModal').close())
		$('supCatalogModal')?.addEventListener('close', () => {
			revokeCatalogPreview()
			state.pendingCatalogPhoto = null
			if ($('supCatalogPhoto')) $('supCatalogPhoto').value = ''
		})
		$('supCatalogPhotoDrop')?.addEventListener('click', (e) => {
			if (e.target.closest('#supCatalogPhoto')) return
			e.preventDefault()
			$('supCatalogPhoto')?.click()
		})
		$('supCatalogPhotoDrop')?.addEventListener('dragover', (e) => {
			if (!isFileDrag(e)) return
			e.preventDefault()
			e.stopPropagation()
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
			$('supCatalogPhotoDrop')?.classList.add('is-drop-target')
		})
		$('supCatalogPhotoDrop')?.addEventListener('dragleave', (e) => {
			if (e.target !== $('supCatalogPhotoDrop') && $('supCatalogPhotoDrop')?.contains(e.relatedTarget)) return
			$('supCatalogPhotoDrop')?.classList.remove('is-drop-target')
		})
		$('supCatalogPhotoDrop')?.addEventListener('drop', (e) => {
			e.preventDefault()
			e.stopPropagation()
			$('supCatalogPhotoDrop')?.classList.remove('is-drop-target')
			const file = droppedImageFile(e)
			if (!file) {
				toast('Photo must be a JPEG, PNG or WebP')
				return
			}
			setPendingCatalogPhoto(file)
		})
		$('supCatalogPhoto')?.addEventListener('change', (e) => {
			const file = e.target.files && e.target.files[0]
			if (!file) {
				setPendingCatalogPhoto(null)
				return
			}
			if (!isImageFile(file)) {
				e.target.value = ''
				setPendingCatalogPhoto(null)
				showCatalogError(new Error(t('Photo must be a JPEG, PNG or WebP')))
				return
			}
			setPendingCatalogPhoto(file)
		})
		$('supCatalogCategory')?.addEventListener('change', () => paintCategoryPicker($('supCatalogCategory').value))
		$('supCatalogCategoryPicker')?.addEventListener('click', (e) => {
			const btn = e.target.closest('[data-pick-cat]')
			if (!btn) return
			$('supCatalogCategory').value = btn.dataset.pickCat
			paintCategoryPicker(btn.dataset.pickCat)
		})
		$('supCatalogFamilyPicker')?.addEventListener('click', (e) => {
			const btn = e.target.closest('[data-pick-family]')
			if (!btn) return
			paintFamilyPicker(btn.dataset.pickFamily, $('supCatalogCategory').value)
		})
		$('supCatalogArchive')?.addEventListener('click', () => {
			const id = $('supCatalogId').value
			if (!id) return
			removeSupply(id, { btn: $('supCatalogArchive') })
		})
		$('supCatalogRestore')?.addEventListener('click', () => {
			const id = $('supCatalogId').value
			if (!id) return
			restoreSupply(id, $('supCatalogRestore'))
		})
		$('supCatalogPurge')?.addEventListener('click', () => {
			const id = $('supCatalogId').value
			if (!id) return
			removeSupply(id, { purge: true, btn: $('supCatalogPurge') })
		})
		$('supCatalogForm').addEventListener('submit', async (e) => {
			e.preventDefault()
			$('supCatalogError').hidden = true
			const submitBtn = e.submitter || $('supCatalogForm').querySelector('button[type="submit"]')
			const id = $('supCatalogId').value
			const primary = $('supCatalogName').value.trim()
			const alt = $('supCatalogAltName').value.trim()
			const current = id ? state.items.find((i) => String(i.id) === String(id)) : null
			const body = {
				name: isZh() ? alt || current?.name || primary : primary,
				name_zh: isZh() ? primary : alt || current?.name_zh || null,
				category_slug: $('supCatalogCategory').value,
				family: familiesForCategory($('supCatalogCategory').value).length ? $('supCatalogFamily').value || null : null,
				uom: $('supCatalogUom').value,
				reorder_point: Number($('supCatalogReorderPoint').value),
				reorder_qty: Number($('supCatalogReorderQty').value),
				unit_cost: $('supCatalogCost').value === '' ? null : Number($('supCatalogCost').value),
				currency: $('supCatalogCurrency').value,
				supplier_name: $('supCatalogSupplierName').value.trim(),
				supplier_url: $('supCatalogSupplierUrl').value.trim(),
				notes: $('supCatalogNotes').value.trim(),
				active: $('supCatalogActive').checked ? 1 : 0,
			}
			try {
				await withBusy(submitBtn, async () => {
					const file = state.pendingCatalogPhoto || ($('supCatalogPhoto').files && $('supCatalogPhoto').files[0])
					if (file) {
						if (!isImageFile(file)) throw new Error(t('Photo must be a JPEG, PNG or WebP'))
						body.photo_data = await readFileAsDataUrl(file)
					}
					const creating = !id
					const result = creating
						? await api('/api/supplies/items', { method: 'POST', body })
						: await api(`/api/supplies/items/${id}`, { method: 'PATCH', body })
					$('supCatalogModal').close()
					if (creating) resetCatalogFiltersForNewItem()
					await loadInventory()
					const savedId = result?.item?.id || Number(id)
					if (creating && savedId) revealSupply(savedId)
					toast('Supply saved')
				})
			} catch (err) {
				$('supCatalogError').hidden = false
				$('supCatalogError').textContent = errorMessage(err)
			}
		})
	}

	async function load() {
		mount()
		refreshOwnerBits()
		if (anyModalOpen()) return
		try {
			await refreshView()
		} catch (err) {
			toast(errorMessage(err))
		}
	}

	async function refreshAlerts() {
		try {
			const alerts = await api('/api/supplies/alerts')
			state.alerts = alerts
			renderAlertBanner()
		} catch {
			// Login or network errors should not block the rest of the dashboard.
		}
	}

	function showToBuy() {
		state.filterNeedsPurchase = true
		state.purchaseQueueOpen = isOwner()
		state.view = 'inventory'
		if (state.mounted) {
			setView('inventory')
			paintBuyChip()
			renderBuyQueue()
			renderInventoryGrid()
			const queue = $('supBuyQueue')
			if (queue && !queue.hidden && typeof queue.scrollIntoView === 'function') {
				queue.scrollIntoView({ block: 'start' })
			}
		}
	}

	return { load, mount, refreshAlerts, showToBuy }
})
