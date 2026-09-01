'use strict'

;(function bootstrapOperationsChecklist(root, factory) {
	if (typeof module === 'object' && module.exports) {
		module.exports = factory
		return
	}
	const checklist = factory(root)
	root.UEDOperationsChecklist = checklist
	checklist.autoInit()
})(typeof window !== 'undefined' ? window : globalThis, function createOperationsChecklist(window) {
	const document = window.document
	const CAPABILITY = 'operations:checklist'
	const ENDPOINT = '/api/operations/checklist'
	const OPEN_STORAGE_KEY = 'uedOperationsChecklistOpen'
	const LANGUAGE_STORAGE_KEY = 'dashboardLang'
	const POLL_MS = 60_000
	const COMPLETION_KEY_SEPARATOR = '\u0000'

	const COPY = {
		en: {
			edgeTitle: 'Checklist',
			edgeLoading: 'Loading',
			edgeOpen: 'Open operations checklist',
			edgeProgress: (done, total) => `${done}/${total} complete`,
			kicker: 'Operations',
			title: 'Daily checklist',
			close: 'Close checklist',
			manualOnly: 'Manual workflow only - 0 Etsy API calls',
			loadingTitle: 'Loading this week',
			loadingBody: 'Reading the shared checklist from local UED data.',
			errorTitle: 'Checklist unavailable',
			errorBody: 'The saved checklist could not be loaded.',
			retry: 'Try again',
			weekOf: 'Week of',
			timezone: (zone) => `${zone} business time`,
			today: 'Today',
			pastDay: 'Past day',
			futureDay: 'Scheduled',
			itemsComplete: (done, total) => `${done} of ${total} shops complete`,
			futureNotice: 'Future days are available for planning, but cannot be checked off in advance.',
			noShops: 'No active shops are configured. Add a shop before using this checklist.',
			noTasks: 'No tasks are scheduled for this day.',
			scheduleDaily: 'Daily',
			scheduleMondayFriday: 'Monday and Friday',
			scheduleSaturday: 'Saturday',
			taskProgress: (done, total) => `${done}/${total} tasks complete`,
			doneBy: (user, when) => `Done by ${user} - ${when}`,
			saving: 'Saving...',
			notStarted: 'Not completed yet',
			finished: 'Finished',
			tasksHeading: 'Tasks for this shop',
			openWorkflow: 'Open',
			openIssues: 'Open Issues / on hold',
			openShipping: 'Open stuck shipping',
			savedAt: (when) => `Updated ${when}`,
			source: 'Saved in UED',
			saveFailed: 'That change was not saved. The latest shared state has been reloaded.',
			navigationFailed: 'That UED workspace is not available on this page.',
			changeSaved: 'Shop checklist updated.',
			dayNames: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
		},
		zh: {
			edgeTitle: '清单',
			edgeLoading: '加载中',
			edgeOpen: '打开运营清单',
			edgeProgress: (done, total) => `已完成 ${done}/${total}`,
			kicker: '运营',
			title: '每日清单',
			close: '关闭清单',
			manualOnly: '仅手动操作 - 0 次 Etsy API 调用',
			loadingTitle: '正在加载本周清单',
			loadingBody: '正在从 UED 本地数据读取共享清单。',
			errorTitle: '清单暂不可用',
			errorBody: '无法加载已保存的清单。',
			retry: '重试',
			weekOf: '本周',
			timezone: (zone) => `${zone} 运营时间`,
			today: '今天',
			pastDay: '过去日期',
			futureDay: '已排期',
			itemsComplete: (done, total) => `已完成 ${done}/${total} 个店铺`,
			futureNotice: '可查看未来日期以便规划，但不能提前勾选。',
			noShops: '尚未配置有效店铺。请先添加店铺再使用此清单。',
			noTasks: '当天没有安排任务。',
			scheduleDaily: '每天',
			scheduleMondayFriday: '周一和周五',
			scheduleSaturday: '周六',
			taskProgress: (done, total) => `已完成 ${done}/${total} 项任务`,
			doneBy: (user, when) => `${user} 完成 - ${when}`,
			saving: '保存中...',
			notStarted: '尚未完成',
			finished: '已完成',
			tasksHeading: '此店铺的任务',
			openWorkflow: '打开',
			openIssues: '打开异常 / 暂挂',
			openShipping: '打开滞留物流',
			savedAt: (when) => `更新于 ${when}`,
			source: '已保存至 UED',
			saveFailed: '更改未保存，已重新加载最新共享状态。',
			navigationFailed: '此页面无法打开对应的 UED 工作区。',
			changeSaved: '店铺清单已更新。',
			dayNames: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'],
		},
	}

	const state = {
		root: null,
		data: null,
		selectedDate: null,
		expanded: new Set(),
		autoExpandedDates: new Set(),
		pending: new Map(),
		open: false,
		loading: false,
		loadPromise: null,
		lastLoadedAt: 0,
		transientError: '',
		transientErrorTimer: null,
		pollTimer: null,
		channel: null,
		destroyed: false,
	}

	function language() {
		try {
			if (window.localStorage.getItem(LANGUAGE_STORAGE_KEY) === 'zh') return 'zh'
		} catch {
			// Storage can be unavailable in hardened/private browser contexts.
		}
		return String(document?.documentElement?.lang || '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
	}

	function t(key, ...args) {
		const value = COPY[language()][key] ?? COPY.en[key] ?? key
		return typeof value === 'function' ? value(...args) : value
	}

	function localized(value) {
		if (value && typeof value === 'object') {
			return String(value[language()] || value.en || Object.values(value)[0] || '')
		}
		return String(value || '')
	}

	function capabilities() {
		return Array.isArray(window.__AUTH?.capabilities)
			? window.__AUTH.capabilities
			: []
	}

	function can(capability) {
		const available = capabilities()
		return available.includes('*') || available.includes(capability)
	}

	function canMount() {
		return !!document?.body && can(CAPABILITY)
	}

	function completionKey(workDate, taskId, shopId) {
		return [workDate, taskId, shopId].join(COMPLETION_KEY_SEPARATOR)
	}

	function dateFromKey(key) {
		const [year, month, day] = String(key).split('-').map(Number)
		return new Date(Date.UTC(year, month - 1, day))
	}

	function dateNumber(key) {
		return Number(String(key).slice(8, 10))
	}

	function formatWeek(startKey, endKey) {
		const locale = language() === 'zh' ? 'zh-CN' : 'en-US'
		const start = dateFromKey(startKey)
		const end = dateFromKey(endKey)
		if (language() === 'zh') {
			const fmt = new Intl.DateTimeFormat(locale, {
				month: 'numeric',
				day: 'numeric',
				timeZone: 'UTC',
			})
			return `${fmt.format(start)} - ${fmt.format(end)}`
		}
		const startText = new Intl.DateTimeFormat(locale, {
			month: 'short',
			day: 'numeric',
			timeZone: 'UTC',
		}).format(start)
		const endText = new Intl.DateTimeFormat(locale, {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
			timeZone: 'UTC',
		}).format(end)
		return `${startText} - ${endText}`
	}

	function formatSelectedDay(day) {
		if (day.is_today) return t('today')
		const locale = language() === 'zh' ? 'zh-CN' : 'en-US'
		return new Intl.DateTimeFormat(locale, {
			weekday: 'long',
			month: 'short',
			day: 'numeric',
			timeZone: 'UTC',
		}).format(dateFromKey(day.date))
	}

	function formatTimestamp(timestamp, options = {}) {
		const value = Number(timestamp)
		if (!Number.isFinite(value)) return ''
		const locale = language() === 'zh' ? 'zh-CN' : 'en-US'
		const sameDay = options.sameDay !== false
		const format = sameDay
			? { hour: 'numeric', minute: '2-digit' }
			: { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
		return new Intl.DateTimeFormat(locale, {
			...format,
			timeZone: state.data?.time_zone || undefined,
		}).format(new Date(value))
	}

	function scheduleLabel(schedule) {
		if (schedule === 'monday_friday') return t('scheduleMondayFriday')
		if (schedule === 'saturday') return t('scheduleSaturday')
		return t('scheduleDaily')
	}

	function element(tag, className, text) {
		const node = document.createElement(tag)
		if (className) node.className = className
		if (text != null) node.textContent = String(text)
		return node
	}

	function createShell() {
		const root = element('div', 'ops-checklist-root')
		root.id = 'opsChecklistRoot'
		root.innerHTML = `
			<button type="button" class="ops-checklist-edge" id="opsChecklistEdge"
				aria-controls="opsChecklistPanel" aria-expanded="false">
				<svg class="ops-checklist-edge-icon" viewBox="0 0 24 24" aria-hidden="true">
					<rect x="4" y="3.5" width="16" height="17" rx="2.5"></rect>
					<path d="m7.5 9 1.5 1.5 2.5-3"></path>
					<path d="M13.5 9h3"></path>
					<path d="m7.5 15 1.5 1.5 2.5-3"></path>
					<path d="M13.5 15h3"></path>
				</svg>
				<span class="ops-checklist-edge-copy">
					<span class="ops-checklist-edge-title"></span>
					<span class="ops-checklist-edge-progress"></span>
				</span>
				<span class="ops-checklist-edge-badge" id="opsChecklistBadge" hidden></span>
			</button>
			<div class="ops-checklist-backdrop" id="opsChecklistBackdrop">
				<aside class="ops-checklist-panel" id="opsChecklistPanel"
					aria-labelledby="opsChecklistTitle" aria-hidden="true">
					<header class="ops-checklist-header">
						<div class="ops-checklist-header-row">
							<div>
								<div class="ops-checklist-kicker"></div>
								<h2 class="ops-checklist-title" id="opsChecklistTitle"></h2>
							</div>
							<button type="button" class="ops-checklist-close" id="opsChecklistClose">
								<svg viewBox="0 0 16 16" aria-hidden="true">
									<path d="M3 3l10 10M13 3 3 13"></path>
								</svg>
							</button>
						</div>
						<div class="ops-checklist-manual-note">
							<span class="ops-checklist-manual-dot" aria-hidden="true"></span>
							<span id="opsChecklistManualNote"></span>
						</div>
					</header>
					<div class="ops-checklist-body" id="opsChecklistBody"></div>
					<footer class="ops-checklist-footer">
						<span class="ops-checklist-saved" id="opsChecklistSaved"></span>
						<span class="ops-checklist-source" id="opsChecklistSource"></span>
					</footer>
					<div class="ops-checklist-live" id="opsChecklistLive" role="status" aria-live="polite"></div>
				</aside>
			</div>
		`
		document.body.appendChild(root)
		state.root = root

		root.querySelector('#opsChecklistEdge').addEventListener('click', () => setOpen(true, { focus: true }))
		root.querySelector('#opsChecklistClose').addEventListener('click', () => setOpen(false, { restoreFocus: true }))
		root.querySelector('#opsChecklistBackdrop').addEventListener('click', (event) => {
			if (event.target === event.currentTarget) {
				setOpen(false, { restoreFocus: true })
			}
		})
		renderChrome()
	}

	function renderChrome() {
		if (!state.root) return
		const edge = state.root.querySelector('#opsChecklistEdge')
		const close = state.root.querySelector('#opsChecklistClose')
		state.root.querySelector('.ops-checklist-edge-title').textContent = t('edgeTitle')
		state.root.querySelector('.ops-checklist-kicker').textContent = t('kicker')
		state.root.querySelector('.ops-checklist-title').textContent = t('title')
		state.root.querySelector('#opsChecklistManualNote').textContent = t('manualOnly')
		state.root.querySelector('#opsChecklistSource').textContent = t('source')
		edge.setAttribute('aria-label', t('edgeOpen'))
		close.setAttribute('aria-label', t('close'))
		close.title = t('close')
	}

	function readStoredOpen() {
		try {
			return window.localStorage.getItem(OPEN_STORAGE_KEY) === '1'
		} catch {
			return false
		}
	}

	function persistOpen(open) {
		try {
			window.localStorage.setItem(OPEN_STORAGE_KEY, open ? '1' : '0')
		} catch {
			// The control remains usable for this session without persistence.
		}
	}

	function setOpen(open, { focus = false, restoreFocus = false } = {}) {
		if (!state.root) return
		state.open = !!open
		state.root.classList.toggle('is-open', state.open)
		const edge = state.root.querySelector('#opsChecklistEdge')
		const panel = state.root.querySelector('#opsChecklistPanel')
		edge.setAttribute('aria-expanded', String(state.open))
		edge.tabIndex = state.open ? -1 : 0
		panel.setAttribute('aria-hidden', String(!state.open))
		panel.inert = !state.open
		persistOpen(state.open)
		if (state.open) {
			refresh({ silent: true })
			if (focus) state.root.querySelector('#opsChecklistClose').focus()
		} else if (restoreFocus) {
			edge.focus()
		}
	}

	function setTransientError(message) {
		state.transientError = String(message || '')
		if (state.transientErrorTimer) window.clearTimeout(state.transientErrorTimer)
		state.transientErrorTimer = window.setTimeout(() => {
			state.transientError = ''
			state.transientErrorTimer = null
			render()
		}, 7000)
	}

	function announce(message) {
		const live = state.root?.querySelector('#opsChecklistLive')
		if (!live) return
		live.textContent = ''
		window.setTimeout(() => {
			if (live.isConnected) live.textContent = String(message || '')
		}, 20)
	}

	function renderState(kind, message) {
		const body = state.root.querySelector('#opsChecklistBody')
		body.replaceChildren()
		const stateNode = element('div', 'ops-checklist-state')
		const card = element('div', 'ops-checklist-state-card')
		if (kind === 'loading') card.appendChild(element('div', 'ops-checklist-spinner'))
		card.appendChild(element('strong', '', kind === 'loading' ? t('loadingTitle') : t('errorTitle')))
		card.appendChild(element('div', '', message || (kind === 'loading' ? t('loadingBody') : t('errorBody'))))
		if (kind === 'error') {
			const retry = element('button', 'ops-checklist-retry', t('retry'))
			retry.type = 'button'
			retry.addEventListener('click', () => refresh())
			card.appendChild(retry)
		}
		stateNode.appendChild(card)
		body.appendChild(stateNode)
		state.root.querySelector('.ops-checklist-edge-progress').textContent = t('edgeLoading')
		state.root.querySelector('#opsChecklistSaved').textContent = ''
	}

	function assertPayload(data) {
		if (
			!data
			|| data.version !== 2
			|| !Array.isArray(data.shops)
			|| !Array.isArray(data.tasks)
			|| !Array.isArray(data.completions)
			|| !Array.isArray(data.days)
			|| data.days.length !== 7
			|| typeof data.today !== 'string'
		) {
			throw new Error('The server returned an invalid checklist response.')
		}
		return data
	}

	function recomputeDaySummaries() {
		if (!state.data) return
		const completed = new Set(
			state.data.completions.map((entry) =>
				completionKey(entry.work_date, entry.task_id, entry.shop_id),
			),
		)
		for (const day of state.data.days) {
			const taskIds = Array.isArray(day.task_ids) ? day.task_ids : []
			let checksDone = 0
			let shopsDone = 0
			for (const shop of state.data.shops) {
				let shopChecks = 0
				for (const taskId of taskIds) {
					if (completed.has(completionKey(day.date, taskId, shop.shop_id))) {
						shopChecks += 1
					}
				}
				checksDone += shopChecks
				if (taskIds.length > 0 && shopChecks === taskIds.length) shopsDone += 1
			}
			day.total = taskIds.length > 0 ? state.data.shops.length : 0
			day.completed = shopsDone
			day.remaining = Math.max(0, day.total - shopsDone)
			day.checks_total = taskIds.length * state.data.shops.length
			day.checks_completed = checksDone
			day.checks_remaining = Math.max(0, day.checks_total - checksDone)
		}
		state.data.today_summary = state.data.days.find((day) => day.date === state.data.today) || null
	}

	async function refresh({ silent = false } = {}) {
		if (!state.root || state.destroyed) return false
		if (state.loading) return state.loadPromise
		state.loading = true
		if (!silent || !state.data) renderState('loading')
		state.loadPromise = (async () => {
			try {
				const response = await window.fetch(ENDPOINT, {
					method: 'GET',
					credentials: 'same-origin',
					cache: 'no-store',
					headers: { Accept: 'application/json' },
				})
				const body = await response.json().catch(() => null)
				if (!response.ok) {
					throw new Error(body?.error || `Checklist request failed (${response.status}).`)
				}
				const priorWeek = state.data?.week_start
				state.data = assertPayload(body)
				recomputeDaySummaries()
				if (
					!state.selectedDate
					|| priorWeek !== state.data.week_start
					|| !state.data.days.some((day) => day.date === state.selectedDate)
				) {
					state.selectedDate = state.data.today
					state.expanded.clear()
					state.autoExpandedDates.clear()
				}
				state.lastLoadedAt = Date.now()
				state.transientError = ''
				render()
				return true
			} catch (error) {
				if (!silent || !state.data) {
					renderState('error', error.message || t('errorBody'))
				} else {
					setTransientError(error.message || t('errorBody'))
					render()
				}
				return false
			} finally {
				state.loading = false
				state.loadPromise = null
			}
		})()
		return state.loadPromise
	}

	function completionMap() {
		return new Map(
			(state.data?.completions || []).map((entry) => [
				completionKey(entry.work_date, entry.task_id, entry.shop_id),
				entry,
			]),
		)
	}

	function taskMap() {
		return new Map((state.data?.tasks || []).map((task) => [task.id, task]))
	}

	function workflowLabel(workflow) {
		if (workflow === 'orders_issues') return t('openIssues')
		if (workflow === 'shipping_outreach') return t('openShipping')
		return t('openWorkflow')
	}

	function canOpenWorkflow(task) {
		return !!task.workflow
			&& (!task.workflow_capability || can(task.workflow_capability))
			&& typeof window.showTab === 'function'
	}

	function setSelectValue(id, value) {
		const select = document.getElementById(id)
		if (!select) return false
		const wanted = String(value ?? '')
		const optionExists = [...select.options].some((option) => option.value === wanted)
		select.value = optionExists ? wanted : ''
		return true
	}

	function openWorkflow(task, shopId) {
		if (!task?.workflow || typeof window.showTab !== 'function') {
			setTransientError(t('navigationFailed'))
			render()
			return
		}

		let opened = false
		if (task.workflow === 'orders_issues') {
			const status = document.getElementById('filterShipped')
			if (status) status.value = 'issues'
			setSelectValue('filterShop', shopId)
			const search = document.getElementById('filterOrderSearch')
			if (search) search.value = ''
			const dateFrom = document.getElementById('filterDateFrom')
			const dateTo = document.getElementById('filterDateTo')
			if (dateFrom) dateFrom.value = ''
			if (dateTo) dateTo.value = ''
			document.getElementById('dateClearBtn')?.classList.remove('visible')
			window.showTab('orders')
			if (typeof window.setIssueFilter === 'function') window.setIssueFilter('active')
			opened = true
		}
		if (task.workflow === 'shipping_outreach') {
			setSelectValue('shipStatusFilter', 'stuck')
			setSelectValue('shipOutreachFilter', 'needed')
			setSelectValue('shipShopFilter', shopId)
			setSelectValue('shipRange', '30')
			window.showTab('shipping')
			opened = true
		}

		if (!opened) {
			setTransientError(t('navigationFailed'))
			render()
			return
		}
		setOpen(true)
		try {
			window.scrollTo({ top: 0, behavior: 'smooth' })
		} catch {
			window.scrollTo(0, 0)
		}
	}

	function shopCompletionState(day, shop, tasks, completions) {
		const rows = tasks
			.map((task) => completions.get(
				completionKey(day.date, task.id, shop.shop_id),
			))
			.filter(Boolean)
		return {
			completed: tasks.length > 0 && rows.length === tasks.length,
			completions: rows,
		}
	}

	function renderTaskSection({
		day,
		task,
		index,
		shop,
		completions,
	}) {
		const key = completionKey(day.date, task.id, shop.shop_id)
		const saved = completions.get(key) || null
		const optimistic = state.pending.get(key)
		const checked = optimistic == null ? !!saved : optimistic
		const section = element(
			'section',
			`ops-checklist-task-section${checked ? ' is-complete' : ''}`,
		)
		section.dataset.taskId = task.id
		const head = element('div', 'ops-checklist-task-section-head')
		head.appendChild(element('span', 'ops-checklist-task-number', index + 1))
		const title = element('div', 'ops-checklist-task-section-title')
		title.appendChild(element('h4', '', localized(task.title)))
		title.appendChild(element('span', '', scheduleLabel(task.schedule)))
		head.appendChild(title)
		if (canOpenWorkflow(task)) {
			const button = element('button', 'ops-checklist-workflow', workflowLabel(task.workflow))
			button.type = 'button'
			button.dataset.workflow = task.workflow
			button.dataset.shopId = String(shop.shop_id)
			button.addEventListener('click', () => openWorkflow(task, String(shop.shop_id)))
			head.appendChild(button)
		}
		section.appendChild(head)
		section.appendChild(
			element('p', 'ops-checklist-instructions', localized(task.instructions)),
		)
		const completion = element(
			'div',
			`ops-checklist-task-completion${checked ? ' is-complete' : ''}`,
		)
		const label = element('label', 'ops-checklist-task-completion-label')
		const checkbox = element('input', 'ops-checklist-task-check')
		checkbox.type = 'checkbox'
		checkbox.checked = checked
		checkbox.disabled = !!day.is_future || state.pending.has(key)
		checkbox.dataset.workDate = day.date
		checkbox.dataset.taskId = task.id
		checkbox.dataset.shopId = String(shop.shop_id)
		checkbox.setAttribute(
			'aria-label',
			`${t('finished')} - ${localized(task.title)} - ${shop.shop_name}`,
		)
		checkbox.addEventListener('change', () => {
			updateCompletion({
				workDate: day.date,
				taskId: task.id,
				shopId: String(shop.shop_id),
				completed: checkbox.checked,
				existing: saved,
			})
		})
		label.appendChild(checkbox)
		label.appendChild(
			element('span', 'ops-checklist-task-completion-label-text', state.pending.has(key) ? t('saving') : t('finished')),
		)
		const statusText = saved
			? t(
				'doneBy',
				saved.completed_by || 'operator',
				formatTimestamp(saved.completed_at, {
					sameDay: day.date === state.data.today,
				}),
			)
			: t('notStarted')
		label.appendChild(element('span', 'ops-checklist-task-completion-status', statusText))
		completion.appendChild(label)
		section.appendChild(completion)
		return section
	}

	function renderShop({
		day,
		shop,
		shopIndex,
		tasks,
		completions,
	}) {
		const saved = shopCompletionState(day, shop, tasks, completions)
		let completedTasks = saved.completions.length
		for (const task of tasks) {
			const key = completionKey(day.date, task.id, shop.shop_id)
			if (!state.pending.has(key)) continue
			const wasSaved = completions.has(key)
			const willBeSaved = state.pending.get(key)
			if (willBeSaved && !wasSaved) completedTasks += 1
			if (!willBeSaved && wasSaved) completedTasks -= 1
		}
		const checked = tasks.length > 0 && completedTasks === tasks.length
		const details = element(
			'details',
			`ops-checklist-shop${checked ? ' is-complete' : ''}`,
		)
		details.dataset.shopId = String(shop.shop_id)
		const expandedKey = `${day.date}:shop:${shop.shop_id}`
		details.open = state.expanded.has(expandedKey)
		details.addEventListener('toggle', () => {
			if (details.open) state.expanded.add(expandedKey)
			else state.expanded.delete(expandedKey)
		})

		const summary = element('summary')
		summary.appendChild(
			element(
				'span',
				'ops-checklist-shop-status',
				checked ? '✓' : shopIndex + 1,
			),
		)
		const heading = element('span', 'ops-checklist-shop-heading')
		heading.appendChild(
			element('span', 'ops-checklist-shop-name', shop.shop_name),
		)
		heading.appendChild(
			element(
				'span',
				'ops-checklist-shop-meta',
				t('taskProgress', completedTasks, tasks.length),
			),
		)
		summary.appendChild(heading)
		summary.appendChild(element('span', 'ops-checklist-chevron'))
		details.appendChild(summary)

		const content = element('div', 'ops-checklist-shop-content')
		content.appendChild(
			element('div', 'ops-checklist-tasks-heading', t('tasksHeading')),
		)
		const taskSections = element('div', 'ops-checklist-task-sections')
		tasks.forEach((task, index) => {
			taskSections.appendChild(renderTaskSection({
				day,
				task,
				index,
				shop,
				completions,
			}))
		})
		content.appendChild(taskSections)
		details.appendChild(content)
		return details
	}

	function ensureDefaultExpanded(day, tasks, completions) {
		if (state.autoExpandedDates.has(day.date)) return
		state.autoExpandedDates.add(day.date)
		const firstIncomplete = state.data.shops.find(
			(shop) => !shopCompletionState(day, shop, tasks, completions).completed,
		)
		if (firstIncomplete) {
			state.expanded.add(`${day.date}:shop:${firstIncomplete.shop_id}`)
		}
	}

	function render() {
		if (!state.root || !state.data) return
		renderChrome()
		recomputeDaySummaries()
		const body = state.root.querySelector('#opsChecklistBody')
		body.replaceChildren()

		const today = state.data.today_summary || {
			completed: 0,
			total: 0,
			remaining: 0,
		}
		const todayComplete = today.total > 0 && today.remaining === 0
		state.root.classList.toggle('is-complete', todayComplete)
		state.root.querySelector('.ops-checklist-edge-progress').textContent =
			t('edgeProgress', today.completed, today.total)
		const badge = state.root.querySelector('#opsChecklistBadge')
		badge.hidden = today.total === 0
		badge.textContent = todayComplete ? '✓' : String(today.remaining)
		state.root.querySelector('#opsChecklistEdge').setAttribute(
			'aria-label',
			`${t('edgeOpen')}. ${t('edgeProgress', today.completed, today.total)}.`,
		)

		const weekMeta = element('div', 'ops-checklist-week-meta')
		const weekCopy = element('div')
		weekCopy.appendChild(element('div', 'ops-checklist-week-label', `${t('weekOf')} ${formatWeek(state.data.week_start, state.data.week_end)}`))
		weekMeta.appendChild(weekCopy)
		weekMeta.appendChild(element('div', 'ops-checklist-timezone', t('timezone', state.data.time_zone)))
		body.appendChild(weekMeta)

		const week = element('div', 'ops-checklist-week')
		week.setAttribute('role', 'group')
		week.setAttribute('aria-label', `${t('weekOf')} ${formatWeek(state.data.week_start, state.data.week_end)}`)
		state.data.days.forEach((day, index) => {
			const complete = day.total > 0 && day.remaining === 0
			const selected = day.date === state.selectedDate
			const button = element(
				'button',
				[
					'ops-checklist-day',
					selected ? 'is-selected' : '',
					day.is_today ? 'is-today' : '',
					day.is_future ? 'is-future' : '',
					complete ? 'is-complete' : '',
				].filter(Boolean).join(' '),
			)
			button.type = 'button'
			button.setAttribute('aria-pressed', String(selected))
			if (day.is_today) button.setAttribute('aria-current', 'date')
			button.dataset.date = day.date
			button.appendChild(element('span', 'ops-checklist-day-name', t('dayNames')[index]))
			button.appendChild(element('span', 'ops-checklist-day-number', dateNumber(day.date)))
			button.appendChild(element('span', 'ops-checklist-day-ratio', `${day.completed}/${day.total}`))
			button.addEventListener('click', () => {
				state.selectedDate = day.date
				render()
			})
			week.appendChild(button)
		})
		body.appendChild(week)

		const selectedDay =
			state.data.days.find((day) => day.date === state.selectedDate)
			|| state.data.days.find((day) => day.is_today)
			|| state.data.days[0]
		state.selectedDate = selectedDay.date
		const percent = selectedDay.total
			? Math.round((selectedDay.completed / selectedDay.total) * 100)
			: 0
		const dayHead = element(
			'div',
			`ops-checklist-day-head${selectedDay.total > 0 && selectedDay.remaining === 0 ? ' is-complete' : ''}`,
		)
		const dayHeadCopy = element('div')
		dayHeadCopy.appendChild(element('div', 'ops-checklist-day-title', formatSelectedDay(selectedDay)))
		dayHeadCopy.appendChild(
			element(
				'div',
				'ops-checklist-day-sub',
				selectedDay.is_future
					? t('futureDay')
					: selectedDay.is_past
						? t('pastDay')
						: state.data.time_zone,
			),
		)
		dayHead.appendChild(dayHeadCopy)
		dayHead.appendChild(
			element(
				'div',
				'ops-checklist-day-count',
				`${selectedDay.completed}/${selectedDay.total}`,
			),
		)
		const progress = element('div', 'ops-checklist-progress')
		const progressBar = element('span')
		progressBar.style.width = `${percent}%`
		progress.appendChild(progressBar)
		dayHead.appendChild(progress)
		dayHead.setAttribute('aria-label', t('itemsComplete', selectedDay.completed, selectedDay.total))
		body.appendChild(dayHead)

		if (state.transientError) {
			body.appendChild(element('div', 'ops-checklist-notice', state.transientError))
		}
		if (selectedDay.is_future) {
			body.appendChild(element('div', 'ops-checklist-notice', t('futureNotice')))
		}

		const tasksById = taskMap()
		const tasks = selectedDay.task_ids
			.map((id) => tasksById.get(id))
			.filter(Boolean)
		const completions = completionMap()
		ensureDefaultExpanded(selectedDay, tasks, completions)
		const shopList = element('div', 'ops-checklist-shop-list')
		if (!tasks.length) {
			shopList.appendChild(element('div', 'ops-checklist-empty', t('noTasks')))
		} else if (!state.data.shops.length) {
			shopList.appendChild(element('div', 'ops-checklist-empty', t('noShops')))
		} else {
			state.data.shops.forEach((shop, shopIndex) => {
				shopList.appendChild(renderShop({
					day: selectedDay,
					shop,
					shopIndex,
					tasks,
					completions,
				}))
			})
		}
		body.appendChild(shopList)

		const loaded = state.lastLoadedAt || state.data.generated_at
		state.root.querySelector('#opsChecklistSaved').textContent = loaded
			? t('savedAt', formatTimestamp(loaded))
			: ''
	}

	function applyCompletion(workDate, taskId, shopId, completion) {
		const key = completionKey(workDate, taskId, shopId)
		state.data.completions = state.data.completions.filter(
			(entry) =>
				completionKey(entry.work_date, entry.task_id, entry.shop_id) !== key,
		)
		if (completion) state.data.completions.push(completion)
		recomputeDaySummaries()
	}

	function advanceToNextShop(workDate, shopId) {
		const day = state.data.days.find((entry) => entry.date === workDate)
		if (!day) return
		const tasksById = taskMap()
		const tasks = day.task_ids.map((id) => tasksById.get(id)).filter(Boolean)
		const completions = completionMap()
		const currentIndex = state.data.shops.findIndex(
			(shop) => String(shop.shop_id) === String(shopId),
		)
		const ordered = [
			...state.data.shops.slice(currentIndex + 1),
			...state.data.shops.slice(0, Math.max(0, currentIndex)),
		]
		const next = ordered.find(
			(shop) => !shopCompletionState(day, shop, tasks, completions).completed,
		)
		state.expanded.delete(`${workDate}:shop:${shopId}`)
		if (next) state.expanded.add(`${workDate}:shop:${next.shop_id}`)
	}

	async function updateCompletion({
		workDate,
		taskId,
		shopId,
		completed,
		existing,
	}) {
		const key = completionKey(workDate, taskId, shopId)
		if (state.pending.has(key)) return
		state.pending.set(key, !!completed)
		render()
		try {
			const requestBody = {
				work_date: workDate,
				task_id: taskId,
				shop_id: shopId,
				completed: !!completed,
			}
			if (!completed && existing?.completed_at) {
				requestBody.expected_completed_at = Number(existing.completed_at)
			}
			const response = await window.fetch(ENDPOINT, {
				method: 'PUT',
				credentials: 'same-origin',
				cache: 'no-store',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(requestBody),
			})
			const body = await response.json().catch(() => null)
			if (!response.ok || !body?.ok) {
				throw new Error(body?.error || `Checklist update failed (${response.status}).`)
			}
			applyCompletion(workDate, taskId, shopId, body.completion || null)
			if (completed) {
				const day = state.data.days.find((entry) => entry.date === workDate)
				const shop = state.data.shops.find(
					(entry) => String(entry.shop_id) === String(shopId),
				)
				const tasksById = taskMap()
				const tasks = (day?.task_ids || [])
					.map((id) => tasksById.get(id))
					.filter(Boolean)
				if (
					day
					&& shop
					&& shopCompletionState(
						day,
						shop,
						tasks,
						completionMap(),
					).completed
				) {
					advanceToNextShop(workDate, shopId)
				}
			}
			state.transientError = ''
			announce(t('changeSaved'))
			if (state.channel) state.channel.postMessage({ type: 'changed' })
		} catch (error) {
			setTransientError(error.message || t('saveFailed'))
			await refresh({ silent: true })
			if (!state.transientError) setTransientError(t('saveFailed'))
		} finally {
			state.pending.delete(key)
			render()
		}
	}

	function handleFocus() {
		if (Date.now() - state.lastLoadedAt > 30_000) refresh({ silent: true })
	}

	function handleVisibility() {
		if (document.visibilityState === 'visible') handleFocus()
	}

	function handleKeydown(event) {
		if (event.key === 'Escape' && state.open) {
			event.preventDefault()
			setOpen(false, { restoreFocus: true })
		}
	}

	function installRefreshHooks() {
		window.addEventListener('focus', handleFocus)
		document.addEventListener('visibilitychange', handleVisibility)
		document.addEventListener('keydown', handleKeydown)
		state.pollTimer = window.setInterval(() => {
			if (document.visibilityState !== 'hidden') refresh({ silent: true })
		}, POLL_MS)
		if (typeof window.BroadcastChannel === 'function') {
			state.channel = new window.BroadcastChannel('ued-operations-checklist')
			state.channel.addEventListener('message', (event) => {
				if (event.data?.type === 'changed') refresh({ silent: true })
			})
		}
	}

	function init() {
		if (state.root || state.destroyed) return Promise.resolve(!!state.root)
		if (!canMount()) return Promise.resolve(false)
		createShell()
		installRefreshHooks()
		setOpen(readStoredOpen())
		return refresh()
	}

	function autoInit() {
		if (!document) return
		if (document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', () => init(), { once: true })
		} else {
			init()
		}
	}

	function destroy() {
		state.destroyed = true
		if (state.pollTimer) window.clearInterval(state.pollTimer)
		if (state.transientErrorTimer) window.clearTimeout(state.transientErrorTimer)
		if (state.channel) state.channel.close()
		window.removeEventListener('focus', handleFocus)
		document?.removeEventListener('visibilitychange', handleVisibility)
		document?.removeEventListener('keydown', handleKeydown)
		state.root?.remove()
		state.root = null
	}

	return {
		autoInit,
		init,
		refresh,
		open: () => setOpen(true, { focus: true }),
		close: () => setOpen(false, { restoreFocus: true }),
		destroy,
	}
})
