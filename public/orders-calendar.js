'use strict'

/**
 * Orders date-range calendar.
 *
 * Replaces the native `<input type="date">` popover on the Orders filter so
 * each day can show how many orders were placed that local calendar day.
 * The hidden date inputs stay the source of truth (`loadOrders` and the
 * existing tests still read `.value`).
 *
 * Counts come from GET /api/orders/calendar-counts — the same placement clock
 * as `date_from` / `date_to`.
 */
;(function bootstrapOrdersCalendar(root, factory) {
	const api = factory(root)
	if (typeof module === 'object' && module.exports) module.exports = api
	if (root) root.ORDERS_CALENDAR = api
})(typeof window !== 'undefined' ? window : globalThis, function createOrdersCalendarApi(root) {
	const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/
	const MAX_COUNT_LABEL = 99
	const CACHE_TTL_MS = 60 * 1000
	const CHEVRON_LEFT =
		'<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M7.75 2.25L3.75 6l4 3.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
	const CHEVRON_RIGHT =
		'<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M4.25 2.25L8.25 6l-4 3.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'

	function pad2(n) {
		return String(n).padStart(2, '0')
	}

	function isoFromParts(year, month, day) {
		return `${year}-${pad2(month)}-${pad2(day)}`
	}

	function isoFromDate(d) {
		return isoFromParts(d.getFullYear(), d.getMonth() + 1, d.getDate())
	}

	function parseIsoDay(value) {
		const m = ISO_DAY.exec(String(value || '').trim())
		if (!m) return null
		const year = Number(m[1])
		const month = Number(m[2])
		const day = Number(m[3])
		const local = new Date(year, month - 1, day, 0, 0, 0, 0)
		if (local.getFullYear() !== year || local.getMonth() !== month - 1 || local.getDate() !== day) return null
		return { iso: `${m[1]}-${m[2]}-${m[3]}`, year, month, day, date: local }
	}

	function addMonths(year, month, delta) {
		const d = new Date(year, month - 1 + delta, 1)
		return { year: d.getFullYear(), month: d.getMonth() + 1 }
	}

	/**
	 * Six-week Sunday-or-Monday grid covering `year`/`month` (1–12).
	 * Always 42 cells so the popover never jumps height between months.
	 */
	function monthGrid(year, month, weekStartsOn) {
		const startOn = weekStartsOn === 1 ? 1 : 0
		const first = new Date(year, month - 1, 1)
		const leading = (first.getDay() - startOn + 7) % 7
		const origin = new Date(year, month - 1, 1 - leading)
		const cells = []
		for (let i = 0; i < 42; i++) {
			const d = new Date(origin.getFullYear(), origin.getMonth(), origin.getDate() + i)
			cells.push({
				iso: isoFromDate(d),
				year: d.getFullYear(),
				month: d.getMonth() + 1,
				day: d.getDate(),
				inMonth: d.getMonth() === month - 1,
			})
		}
		return cells
	}

	function gridRange(year, month, weekStartsOn) {
		const cells = monthGrid(year, month, weekStartsOn)
		return { from: cells[0].iso, to: cells[cells.length - 1].iso, cells }
	}

	function heatLevel(count, max) {
		const n = Number(count) || 0
		if (n <= 0 || max <= 0) return 0
		if (max === 1) return 1
		const t = n / max
		if (t <= 0.25) return 1
		if (t <= 0.5) return 2
		if (t <= 0.75) return 3
		return 4
	}

	function compactCount(n) {
		const count = Number(n) || 0
		if (count <= 0) return ''
		if (count > MAX_COUNT_LABEL) return `${MAX_COUNT_LABEL}+`
		return String(count)
	}

	function weekdayLabels(weekStartsOn, locale) {
		const startOn = weekStartsOn === 1 ? 1 : 0
		const style = locale && String(locale).startsWith('zh') ? 'narrow' : 'short'
		const labels = []
		for (let i = 0; i < 7; i++) {
			const dow = (startOn + i) % 7
			const d = new Date(Date.UTC(2026, 1, 1 + dow))
			labels.push(d.toLocaleDateString(locale || 'en-US', { weekday: style, timeZone: 'UTC' }))
		}
		return labels
	}

	function t(s) {
		try {
			if (root && root.I18N && typeof root.I18N.t === 'function') return root.I18N.t(s)
		} catch {
			/* ignore */
		}
		return s
	}

	function activeLocale() {
		try {
			if (root && root.I18N && root.I18N.get() === 'zh') return 'zh-CN'
		} catch {
			/* ignore */
		}
		return 'en-US'
	}

	function weekStartForLocale(locale) {
		return locale && String(locale).startsWith('zh') ? 1 : 0
	}

	function monthTitle(year, month, locale) {
		return new Date(year, month - 1, 1).toLocaleDateString(locale || 'en-US', { month: 'long', year: 'numeric' })
	}

	function countPhrase(n) {
		if (n === 1) return t('1 order')
		return t(`${n} orders`)
	}

	function dayAriaLabel(cell, count, locale) {
		const dateText = new Date(cell.year, cell.month - 1, cell.day).toLocaleDateString(locale || 'en-US', {
			weekday: 'long',
			month: 'long',
			day: 'numeric',
			year: 'numeric',
		})
		if (!count) return `${dateText}. ${t('No orders')}`
		return `${dateText}. ${countPhrase(count)}`
	}

	function nativeValueDesc(win) {
		const Ctor = win && win.HTMLInputElement
		if (!Ctor || !Ctor.prototype) return null
		return Object.getOwnPropertyDescriptor(Ctor.prototype, 'value')
	}

	function mount(options) {
		const doc = (options && options.document) || (root && root.document)
		if (!doc) return null
		const win = (options && options.window) || doc.defaultView || root
		const fromInput = options.fromInput
		const toInput = options.toInput
		if (!fromInput || !toInput) return null

		const wrap = options.wrap || fromInput.closest('.date-range-wrap') || fromInput.parentElement
		if (!wrap) return null
		const shopSelect = options.shopSelect || doc.getElementById('filterShop')
		const fetchFn = options.fetch || (win && win.fetch && win.fetch.bind(win))
		const nowFn = options.now || (() => new Date())
		const onChange = options.onChange || (() => {})

		wrap.classList.add('has-orders-cal')

		const panel = doc.createElement('div')
		panel.id = 'ordersCalendarPopover'
		panel.className = 'orders-cal'
		panel.hidden = true
		panel.setAttribute('role', 'dialog')
		panel.setAttribute('aria-modal', 'true')
		panel.setAttribute('aria-labelledby', 'ordersCalTitle')
		panel.innerHTML = `
			<div class="orders-cal-head">
				<button type="button" class="orders-cal-nav" data-cal-nav="-1" aria-label="${t('Previous month')}">${CHEVRON_LEFT}</button>
				<div class="orders-cal-title" id="ordersCalTitle"></div>
				<button type="button" class="orders-cal-nav" data-cal-nav="1" aria-label="${t('Next month')}">${CHEVRON_RIGHT}</button>
			</div>
			<div class="orders-cal-weekdays" aria-hidden="true"></div>
			<div class="orders-cal-grid" role="grid"></div>
			<div class="orders-cal-foot">
				<div class="orders-cal-summary" data-cal-summary></div>
				<div class="orders-cal-actions">
					<button type="button" class="orders-cal-foot-btn" data-cal-clear>${t('Clear')}</button>
					<button type="button" class="orders-cal-foot-btn" data-cal-today>${t('Today')}</button>
				</div>
			</div>`
		doc.body.appendChild(panel)

		const titleEl = panel.querySelector('#ordersCalTitle')
		const weekdaysEl = panel.querySelector('.orders-cal-weekdays')
		const gridEl = panel.querySelector('.orders-cal-grid')
		const summaryEl = panel.querySelector('[data-cal-summary]')
		const prevBtn = panel.querySelector('[data-cal-nav="-1"]')
		const nextBtn = panel.querySelector('[data-cal-nav="1"]')
		const clearBtn = panel.querySelector('[data-cal-clear]')
		const todayBtn = panel.querySelector('[data-cal-today]')

		const state = {
			open: false,
			field: 'from',
			year: nowFn().getFullYear(),
			month: nowFn().getMonth() + 1,
			counts: Object.create(null),
			loading: false,
			loadError: false,
			cache: new Map(),
			abort: null,
			restoreFocus: null,
		}

		const valueDesc = nativeValueDesc(win)
		function readValue(input) {
			return valueDesc ? valueDesc.get.call(input) : input.value
		}
		function writeValue(input, next) {
			if (valueDesc) valueDesc.set.call(input, next)
			else input.value = next
		}

		function locale() {
			return options.locale || activeLocale()
		}

		function weekStartsOn() {
			if (options.weekStartsOn === 0 || options.weekStartsOn === 1) return options.weekStartsOn
			return weekStartForLocale(locale())
		}

		function todayIso() {
			return isoFromDate(nowFn())
		}

		function shopId() {
			return (shopSelect && shopSelect.value) || ''
		}

		function cacheKey(from, to, shop) {
			return `${from}|${to}|${shop}`
		}

		function closeSelects() {
			try {
				if ((win.OFT_CSEL || root.OFT_CSEL) && typeof (win.OFT_CSEL || root.OFT_CSEL).closeAll === 'function') {
					;(win.OFT_CSEL || root.OFT_CSEL).closeAll()
				}
			} catch {
				/* ignore */
			}
		}

		function escapeAttr(s) {
			return String(s ?? '')
				.replace(/&/g, '&amp;')
				.replace(/"/g, '&quot;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;')
		}

		function markEditing() {
			fromInput.classList.toggle('is-cal-editing', state.open && state.field === 'from')
			toInput.classList.toggle('is-cal-editing', state.open && state.field === 'to')
			wrap.classList.toggle('is-cal-open', state.open)
			fromInput.setAttribute('aria-expanded', state.open && state.field === 'from' ? 'true' : 'false')
			toInput.setAttribute('aria-expanded', state.open && state.field === 'to' ? 'true' : 'false')
		}

		function position() {
			if (panel.hidden) return
			const anchor = wrap.getBoundingClientRect()
			const vw = win.innerWidth || doc.documentElement.clientWidth
			const vh = win.innerHeight || doc.documentElement.clientHeight
			const width = panel.offsetWidth || 318
			const height = panel.offsetHeight || 360
			let left = anchor.left
			let top = anchor.bottom + 6
			if (left + width > vw - 8) left = Math.max(8, vw - width - 8)
			if (left < 8) left = 8
			if (top + height > vh - 8 && anchor.top - 6 - height >= 8) top = anchor.top - 6 - height
			panel.style.left = `${Math.round(left)}px`
			panel.style.top = `${Math.round(top)}px`
		}

		function inRange(iso, from, to) {
			if (!from || !to || from === to) return false
			const a = from < to ? from : to
			const b = from < to ? to : from
			return iso > a && iso < b
		}

		function render() {
			const loc = locale()
			const startOn = weekStartsOn()
			const { cells } = gridRange(state.year, state.month, startOn)
			const fromVal = readValue(fromInput)
			const toVal = readValue(toInput)
			const today = todayIso()
			const fieldLabel = state.field === 'to' ? t('End date') : t('Start date')
			const activeDate = gridEl.contains(doc.activeElement) ? doc.activeElement.getAttribute('data-date') : null
			titleEl.innerHTML = `${escapeAttr(monthTitle(state.year, state.month, loc))}<span class="orders-cal-field">${escapeAttr(fieldLabel)}</span>`
			panel.setAttribute('aria-label', t('Order calendar'))

			weekdaysEl.innerHTML = weekdayLabels(startOn, loc)
				.map((label) => `<span class="orders-cal-wd">${escapeAttr(label)}</span>`)
				.join('')

			let max = 0
			let monthTotal = 0
			for (const cell of cells) {
				const n = state.counts[cell.iso] || 0
				if (n > max) max = n
				if (cell.inMonth) monthTotal += n
			}

			const html = cells
				.map((cell) => {
					const count = state.counts[cell.iso] || 0
					const heat = heatLevel(count, max)
					const selected = cell.iso === fromVal || cell.iso === toVal
					const cls = [
						'orders-cal-day',
						cell.inMonth ? '' : 'is-outside',
						cell.iso === today ? 'is-today' : '',
						selected ? 'is-selected' : '',
						inRange(cell.iso, fromVal, toVal) ? 'is-in-range' : '',
						cell.iso === fromVal ? 'is-range-start' : '',
						cell.iso === toVal ? 'is-range-end' : '',
					]
						.filter(Boolean)
						.join(' ')
					const countHtml = state.loading
						? '<span class="orders-cal-count is-loading"></span>'
						: `<span class="orders-cal-count">${compactCount(count)}</span>`
					const current = cell.iso === today ? ' aria-current="date"' : ''
					return `<button type="button" class="${cls}" role="gridcell" data-date="${cell.iso}" data-heat="${heat}" tabindex="-1" aria-label="${escapeAttr(dayAriaLabel(cell, count, loc))}" aria-pressed="${selected ? 'true' : 'false'}"${current}>
						<span class="orders-cal-num">${cell.day}</span>
						${countHtml}
					</button>`
				})
				.join('')
			gridEl.innerHTML = html

			summaryEl.classList.toggle('is-error', state.loadError)
			if (state.loadError) summaryEl.textContent = t('Counts unavailable')
			else if (state.loading) summaryEl.textContent = t('Loading…')
			else if (!monthTotal) summaryEl.textContent = t('No orders this month')
			else summaryEl.textContent = t(`${monthTotal} this month`)

			const focusIso = activeDate && cells.some((c) => c.iso === activeDate) ? activeDate : preferredFocusIso(fromVal, toVal, today, cells)
			const focusBtn = gridEl.querySelector(`[data-date="${focusIso}"]`) || gridEl.querySelector('.orders-cal-day')
			gridEl.querySelectorAll('.orders-cal-day').forEach((btn) => btn.setAttribute('tabindex', btn === focusBtn ? '0' : '-1'))
			if (activeDate && focusBtn) focusBtn.focus()
			position()
		}

		function preferredFocusIso(fromVal, toVal, today, cells) {
			const preferred = state.field === 'to' ? toVal || fromVal || today : fromVal || today
			if (cells.some((c) => c.iso === preferred)) return preferred
			const inMonth = cells.find((c) => c.inMonth)
			return inMonth ? inMonth.iso : cells[0].iso
		}

		function focusGridDate(iso) {
			const btn = gridEl.querySelector(`[data-date="${iso}"]`)
			if (!btn) return
			gridEl.querySelectorAll('.orders-cal-day').forEach((el) => el.setAttribute('tabindex', el === btn ? '0' : '-1'))
			btn.focus()
		}

		async function loadCounts() {
			if (!fetchFn) {
				state.counts = Object.create(null)
				state.loading = false
				state.loadError = false
				if (state.open) render()
				return
			}
			const { from, to } = gridRange(state.year, state.month, weekStartsOn())
			const key = cacheKey(from, to, shopId())
			const hit = state.cache.get(key)
			if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
				state.counts = hit.counts
				state.loading = false
				state.loadError = false
				if (state.open) render()
				return
			}
			if (state.abort) state.abort.abort()
			const ac = typeof win.AbortController === 'function' ? new win.AbortController() : null
			state.abort = ac
			state.loading = true
			state.loadError = false
			if (state.open) render()
			try {
				const params = new URLSearchParams({ from, to })
				if (shopId()) params.set('shop_id', shopId())
				const res = await fetchFn(`/api/orders/calendar-counts?${params}`, {
					credentials: 'same-origin',
					signal: ac ? ac.signal : undefined,
				})
				if (!res || !res.ok) throw new Error('bad response')
				const body = typeof res.json === 'function' ? await res.json() : res.body
				const counts = (body && body.counts) || Object.create(null)
				state.cache.set(key, { at: Date.now(), counts })
				state.counts = counts
				state.loadError = false
			} catch (err) {
				if (err && err.name === 'AbortError') return
				state.counts = Object.create(null)
				state.loadError = true
			} finally {
				if (state.abort === ac) state.abort = null
				state.loading = false
			}
			if (state.open) render()
		}

		function showMonth(year, month) {
			const next = addMonths(year, month, 0)
			state.year = next.year
			state.month = next.month
			if (state.open) {
				render()
				loadCounts()
			}
		}

		function open(field, opts) {
			const nextField = field === 'to' ? 'to' : 'from'
			const silent = opts && opts.silent
			closeSelects()
			state.field = nextField
			state.restoreFocus = (opts && opts.restoreFocus) || (nextField === 'to' ? toInput : fromInput)
			const seed = parseIsoDay(readValue(nextField === 'to' ? toInput : fromInput)) || parseIsoDay(todayIso())
			state.year = seed.year
			state.month = seed.month
			state.open = true
			panel.hidden = false
			markEditing()
			render()
			position()
			loadCounts()
			if (!silent) {
				const fromVal = readValue(fromInput)
				const toVal = readValue(toInput)
				const { cells } = gridRange(state.year, state.month, weekStartsOn())
				focusGridDate(preferredFocusIso(fromVal, toVal, todayIso(), cells))
			}
		}

		function close(opts) {
			if (!state.open) return
			state.open = false
			panel.hidden = true
			if (state.abort) {
				state.abort.abort()
				state.abort = null
			}
			markEditing()
			const restore = state.restoreFocus
			state.restoreFocus = null
			if (!opts || opts.restore !== false) {
				try {
					restore && restore.focus && restore.focus()
				} catch {
					/* ignore */
				}
			}
		}

		function emitChange() {
			const input = state.field === 'to' ? toInput : fromInput
			input.dispatchEvent(new win.Event('change', { bubbles: true }))
			try {
				if (typeof onChange === 'function') onChange()
			} catch {
				/* page loadOrders may not exist in tests */
			}
		}

		function applyIso(iso) {
			const parsed = parseIsoDay(iso)
			if (!parsed) return
			if (state.field === 'from') {
				writeValue(fromInput, parsed.iso)
				const toVal = readValue(toInput)
				if (toVal && parsed.iso > toVal) writeValue(toInput, parsed.iso)
			} else {
				writeValue(toInput, parsed.iso)
				const fromVal = readValue(fromInput)
				if (fromVal && parsed.iso < fromVal) writeValue(fromInput, parsed.iso)
			}
			close()
			emitChange()
		}

		function shiftFocus(fromIso, days) {
			const parsed = parseIsoDay(fromIso)
			if (!parsed) return
			const next = new Date(parsed.year, parsed.month - 1, parsed.day + days)
			const iso = isoFromDate(next)
			if (next.getMonth() + 1 !== state.month || next.getFullYear() !== state.year) {
				state.year = next.getFullYear()
				state.month = next.getMonth() + 1
				render()
				loadCounts().then(() => focusGridDate(iso))
				return
			}
			focusGridDate(iso)
		}

		function onGridKey(e, iso) {
			const startOn = weekStartsOn()
			if (e.key === 'ArrowLeft') {
				e.preventDefault()
				shiftFocus(iso, -1)
			} else if (e.key === 'ArrowRight') {
				e.preventDefault()
				shiftFocus(iso, 1)
			} else if (e.key === 'ArrowUp') {
				e.preventDefault()
				shiftFocus(iso, -7)
			} else if (e.key === 'ArrowDown') {
				e.preventDefault()
				shiftFocus(iso, 7)
			} else if (e.key === 'Home') {
				e.preventDefault()
				const parsed = parseIsoDay(iso)
				const delta = (parsed.date.getDay() - startOn + 7) % 7
				shiftFocus(iso, -delta)
			} else if (e.key === 'End') {
				e.preventDefault()
				const parsed = parseIsoDay(iso)
				const delta = 6 - ((parsed.date.getDay() - startOn + 7) % 7)
				shiftFocus(iso, delta)
			} else if (e.key === 'PageUp') {
				e.preventDefault()
				const next = addMonths(state.year, state.month, e.shiftKey ? -12 : -1)
				const parsed = parseIsoDay(iso)
				const target = new Date(next.year, next.month - 1, Math.min(parsed.day, 28))
				state.year = next.year
				state.month = next.month
				render()
				loadCounts().then(() => focusGridDate(isoFromDate(target)))
			} else if (e.key === 'PageDown') {
				e.preventDefault()
				const next = addMonths(state.year, state.month, e.shiftKey ? 12 : 1)
				const parsed = parseIsoDay(iso)
				const target = new Date(next.year, next.month - 1, Math.min(parsed.day, 28))
				state.year = next.year
				state.month = next.month
				render()
				loadCounts().then(() => focusGridDate(isoFromDate(target)))
			} else if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault()
				applyIso(iso)
			}
		}

		function focusables() {
			return [...panel.querySelectorAll('button:not([disabled])')]
		}

		function trapTab(e) {
			if (!state.open || e.key !== 'Tab') return
			const items = focusables()
			if (!items.length) return
			const first = items[0]
			const last = items[items.length - 1]
			if (e.shiftKey && doc.activeElement === first) {
				e.preventDefault()
				last.focus()
			} else if (!e.shiftKey && doc.activeElement === last) {
				e.preventDefault()
				first.focus()
			}
		}

		function bindInput(input, field) {
			input.setAttribute('aria-haspopup', 'dialog')
			input.setAttribute('aria-expanded', 'false')
			input.setAttribute('aria-controls', 'ordersCalendarPopover')
			input.setAttribute('autocomplete', 'off')
			input.setAttribute('readonly', '')
			input.addEventListener('click', (e) => {
				e.preventDefault()
				e.stopPropagation()
				if (state.open && state.field === field) close()
				else open(field)
			})
			input.addEventListener('keydown', (e) => {
				if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || (e.altKey && e.key === 'ArrowDown')) {
					e.preventDefault()
					open(field)
				}
			})
			if (typeof input.showPicker === 'function') {
				input.showPicker = function showOrdersCal() {
					open(field)
				}
			}
			if (valueDesc) {
				Object.defineProperty(input, 'value', {
					configurable: true,
					enumerable: true,
					get() {
						return valueDesc.get.call(this)
					},
					set(v) {
						valueDesc.set.call(this, v)
						if (state.open) render()
					},
				})
			}
		}

		prevBtn.addEventListener('click', () => {
			const next = addMonths(state.year, state.month, -1)
			showMonth(next.year, next.month)
		})
		nextBtn.addEventListener('click', () => {
			const next = addMonths(state.year, state.month, 1)
			showMonth(next.year, next.month)
		})
		clearBtn.addEventListener('click', () => {
			if (state.field === 'from') writeValue(fromInput, '')
			else writeValue(toInput, '')
			close()
			emitChange()
		})
		todayBtn.addEventListener('click', () => applyIso(todayIso()))
		gridEl.addEventListener('click', (e) => {
			const btn = e.target.closest('[data-date]')
			if (!btn) return
			applyIso(btn.getAttribute('data-date'))
		})
		gridEl.addEventListener('keydown', (e) => {
			const btn = e.target.closest('[data-date]')
			if (!btn) return
			onGridKey(e, btn.getAttribute('data-date'))
		})
		panel.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') {
				e.preventDefault()
				e.stopImmediatePropagation()
				close()
				return
			}
			trapTab(e)
		})

		function onDocPointer(e) {
			if (!state.open) return
			if (panel.contains(e.target) || wrap.contains(e.target)) return
			close({ restore: false })
		}
		function onSelectOpen(e) {
			if (!state.open) return
			if (e.target && e.target.closest && e.target.closest('.oft-csel-trigger')) close({ restore: false })
		}
		function onViewport() {
			if (state.open) position()
		}

		doc.addEventListener('mousedown', onDocPointer, true)
		doc.addEventListener('click', onSelectOpen, true)
		win.addEventListener('resize', onViewport)
		win.addEventListener('scroll', onViewport, true)
		if (shopSelect) {
			shopSelect.addEventListener('change', () => {
				state.cache.clear()
				if (state.open) loadCounts()
			})
		}

		bindInput(fromInput, 'from')
		bindInput(toInput, 'to')

		return {
			open,
			close,
			isOpen: () => state.open,
			getState: () => state,
			destroy() {
				close({ restore: false })
				doc.removeEventListener('mousedown', onDocPointer, true)
				doc.removeEventListener('click', onSelectOpen, true)
				win.removeEventListener('resize', onViewport)
				win.removeEventListener('scroll', onViewport, true)
				panel.remove()
				wrap.classList.remove('has-orders-cal', 'is-cal-open')
				fromInput.classList.remove('is-cal-editing')
				toInput.classList.remove('is-cal-editing')
				fromInput.removeAttribute('readonly')
				toInput.removeAttribute('readonly')
			},
		}
	}

	function autoMount() {
		if (!root || !root.document) return null
		const fromInput = root.document.getElementById('filterDateFrom')
		const toInput = root.document.getElementById('filterDateTo')
		if (!fromInput || !toInput || fromInput._ordersCal) return null
		const instance = mount({
			fromInput,
			toInput,
		})
		fromInput._ordersCal = instance
		return instance
	}

	function boot() {
		autoMount()
	}

	if (root && root.document) {
		if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', boot)
		else boot()
	}

	return {
		parseIsoDay,
		isoFromDate,
		monthGrid,
		gridRange,
		heatLevel,
		compactCount,
		weekdayLabels,
		addMonths,
		mount,
		autoMount,
	}
})
