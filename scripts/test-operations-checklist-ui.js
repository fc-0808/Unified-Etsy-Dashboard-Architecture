'use strict'

const assert = require('node:assert/strict')
const { JSDOM, VirtualConsole } = require('jsdom')

const { initDb, syncConfigToDb } = require('../src/db/setup')
const checklistDomain = require('../src/operations/checklist')
const createOperationsChecklist = require('../public/operations-checklist')

const NOW = new Date('2026-08-29T04:00:00.000Z')

function fixturePayload() {
	const db = initDb(':memory:')
	try {
		syncConfigToDb(db, {
			groups: [{
				group_id: 'g1',
				label: 'Group One',
				proxy: 'direct',
				shops: [
					{
						shop_id: 'alpha',
						shop_name: 'Alpha Shop',
						api_key: 'ui-key-a',
						shared_secret: 'ui-secret-a',
					},
					{
						shop_id: 'beta',
						shop_name: 'Beta Shop',
						api_key: 'ui-key-b',
						shared_secret: 'ui-secret-b',
					},
				],
			}],
		})
		return checklistDomain.buildChecklist(db, {
			now: NOW,
			timeZone: 'Asia/Shanghai',
		})
	} finally {
		db.close()
	}
}

function clone(value) {
	return JSON.parse(JSON.stringify(value))
}

function makeResponse(status, body) {
	return {
		ok: status >= 200 && status < 300,
		status,
		async json() {
			return clone(body)
		},
	}
}

async function waitFor(predicate, message, timeoutMs = 1500) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (predicate()) return
		await new Promise((resolve) => setTimeout(resolve, 5))
	}
	throw new Error(message)
}

async function makeEnv({
	capabilities = ['operations:checklist', 'orders:read', 'shipping:admin'],
	payload = fixturePayload(),
	language = 'en',
	fetchError = null,
} = {}) {
	const virtualConsole = new VirtualConsole()
	virtualConsole.on('jsdomError', () => {})
	const dom = new JSDOM(
		`<!doctype html>
		<html lang="en">
			<body>
				<select id="filterShipped">
					<option value="all">All</option>
					<option value="issues">Issues</option>
				</select>
				<select id="filterShop">
					<option value="">All shops</option>
					<option value="alpha">Alpha Shop</option>
					<option value="beta">Beta Shop</option>
				</select>
				<input id="filterOrderSearch" value="123">
				<input id="filterDateFrom" type="date" value="2026-08-29">
				<input id="filterDateTo" type="date" value="2026-08-29">
				<button id="dateClearBtn" class="visible">Clear dates</button>
				<select id="shipStatusFilter">
					<option value="all">All</option>
					<option value="stuck">Stuck</option>
				</select>
				<select id="shipOutreachFilter">
					<option value="all">All</option>
					<option value="needed">Needs message</option>
				</select>
				<select id="shipShopFilter">
					<option value="">All shops</option>
					<option value="alpha">Alpha Shop</option>
					<option value="beta">Beta Shop</option>
				</select>
				<select id="shipRange">
					<option value="30">30 days</option>
					<option value="all">All dates</option>
				</select>
			</body>
		</html>`,
		{
			url: 'http://127.0.0.1:4000/',
			pretendToBeVisual: true,
			virtualConsole,
		},
	)
	const { window } = dom
	Object.defineProperty(window.document, 'visibilityState', {
		configurable: true,
		value: 'visible',
	})
	window.__AUTH = { capabilities }
	window.localStorage.setItem('dashboardLang', language)
	window.scrollTo = () => {}
	window.__shownTabs = []
	window.showTab = (name) => window.__shownTabs.push(name)
	window.__issueFilterCalls = []
	window.setIssueFilter = (value) => window.__issueFilterCalls.push(value)

	const serverState = clone(payload)
	const calls = []
	window.fetch = async (url, options = {}) => {
		calls.push({
			url: String(url),
			options: {
				...options,
				headers: options.headers ? { ...options.headers } : undefined,
			},
		})
		if (fetchError) throw fetchError
		if ((options.method || 'GET') === 'GET') {
			return makeResponse(200, serverState)
		}

		const body = JSON.parse(options.body)
		const keyOf = (entry) =>
			`${entry.work_date}\u0000${entry.task_id}\u0000${entry.shop_id}`
		const key = keyOf(body)
		const existingIndex = serverState.completions.findIndex(
			(entry) => keyOf(entry) === key,
		)
		if (body.completed) {
			const completion = existingIndex >= 0
				? serverState.completions[existingIndex]
				: {
					work_date: body.work_date,
					task_id: body.task_id,
					shop_id: body.shop_id,
					shop_name: serverState.shops.find((shop) => shop.shop_id === body.shop_id)?.shop_name,
					completed_at: NOW.getTime(),
					completed_by: 'alice',
				}
			if (existingIndex < 0) serverState.completions.push(completion)
			return makeResponse(200, {
				ok: true,
				changed: existingIndex < 0,
				completion,
			})
		}
		if (
			existingIndex >= 0
			&& body.expected_completed_at !== serverState.completions[existingIndex].completed_at
		) {
			return makeResponse(409, {
				error: 'Stale checklist state',
				code: 'STALE_CHECKLIST_STATE',
			})
		}
		const removed = existingIndex >= 0
		if (removed) serverState.completions.splice(existingIndex, 1)
		return makeResponse(200, {
			ok: true,
			changed: removed,
			completion: null,
		})
	}

	const widget = createOperationsChecklist(window)
	const mounted = await widget.init()
	return {
		dom,
		window,
		document: window.document,
		widget,
		mounted,
		calls,
		serverState,
	}
}

const tests = []
function test(name, fn) {
	tests.push({ name, fn })
}

test('fails closed when the session lacks checklist permission', async () => {
	const env = await makeEnv({ capabilities: ['orders:read'] })
	try {
		assert.equal(env.mounted, false)
		assert.equal(env.document.getElementById('opsChecklistRoot'), null)
		assert.equal(env.calls.length, 0)
	} finally {
		env.widget.destroy()
		env.dom.window.close()
	}
})

test('groups the current Saturday schedule into one compact section per shop', async () => {
	const env = await makeEnv()
	try {
		assert.equal(env.mounted, true)
		const root = env.document.getElementById('opsChecklistRoot')
		assert.ok(root)
		assert.equal(root.classList.contains('is-open'), false)
		assert.equal(
			root.querySelector('.ops-checklist-edge-progress').textContent,
			'0/2 complete',
		)
		assert.equal(root.querySelector('#opsChecklistBadge').textContent, '2')
		assert.equal(root.querySelectorAll('.ops-checklist-shop').length, 2)
		assert.equal(root.querySelectorAll('.ops-checklist-task-section').length, 8)
		assert.equal(root.querySelectorAll('.ops-checklist-task-check').length, 8)
		assert.deepEqual(
			[...root.querySelectorAll('.ops-checklist-shop-name')].map((node) => node.textContent),
			['Alpha Shop', 'Beta Shop'],
		)
		assert.equal(
			root.querySelectorAll(
				'.ops-checklist-task-section[data-task-id="weekly_sale"]',
			).length,
			2,
		)
		assert.equal(
			root.querySelectorAll(
				'.ops-checklist-task-section[data-task-id="order_issues"]',
			).length,
			2,
		)
		assert.equal(
			root.querySelector(
				'.ops-checklist-task-section[data-task-id="listing_availability"]',
			),
			null,
		)
		assert.match(
			root.querySelector(
				'.ops-checklist-task-section[data-task-id="order_issues"] h4',
			).textContent,
			/Resolve Issues/,
		)
		assert.equal(
			root.querySelector(
				'.ops-checklist-task-section[data-task-id="temporary_auto_reply"]',
			),
			null,
		)
		assert.equal(
			root.querySelector('#opsChecklistManualNote').textContent,
			'Manual workflow only - 0 Etsy API calls',
		)
	} finally {
		env.widget.destroy()
		env.dom.window.close()
	}
})

test('renders shops in the canonical order supplied by the checklist API', async () => {
	const payload = fixturePayload()
	payload.shops = checklistDomain.SHOP_DISPLAY_ORDER.map((shop_name, index) => ({
		shop_id: `ordered-${index}`,
		shop_name,
		group_id: 'g1',
	}))
	const env = await makeEnv({ payload })
	try {
		assert.deepEqual(
			[...env.document.querySelectorAll('.ops-checklist-shop-name')]
				.map((node) => node.textContent),
			checklistDomain.SHOP_DISPLAY_ORDER,
		)
		assert.equal(
			env.document.querySelector('.ops-checklist-edge-progress').textContent,
			'0/9 complete',
		)
	} finally {
		env.widget.destroy()
		env.dom.window.close()
	}
})

test('opens, persists, and closes accessibly with Escape', async () => {
	const env = await makeEnv()
	try {
		const root = env.document.getElementById('opsChecklistRoot')
		const edge = root.querySelector('#opsChecklistEdge')
		edge.click()
		assert.equal(root.classList.contains('is-open'), true)
		assert.equal(edge.getAttribute('aria-expanded'), 'true')
		assert.equal(
			root.querySelector('#opsChecklistPanel').getAttribute('aria-hidden'),
			'false',
		)
		assert.equal(env.window.localStorage.getItem('uedOperationsChecklistOpen'), '1')

		env.document.dispatchEvent(
			new env.window.KeyboardEvent('keydown', {
				key: 'Escape',
				bubbles: true,
				cancelable: true,
			}),
		)
		assert.equal(root.classList.contains('is-open'), false)
		assert.equal(edge.getAttribute('aria-expanded'), 'false')
		assert.equal(env.window.localStorage.getItem('uedOperationsChecklistOpen'), '0')
	} finally {
		env.widget.destroy()
		env.dom.window.close()
	}
})

test('each task must be finished separately before the shop advances', async () => {
	const env = await makeEnv()
	try {
		const selectorFor = (taskId) =>
			'.ops-checklist-task-check[data-work-date="2026-08-29"]'
			+ `[data-task-id="${taskId}"][data-shop-id="alpha"]`
		const selector = selectorFor('messages')
		let checkbox = env.document.querySelector(selector)
		assert.equal(checkbox.checked, false)
		checkbox.click()
		await waitFor(
			() => env.calls.some((call) => call.options.method === 'PUT')
				&& env.document.querySelector(selector)?.checked === true
				&& !env.document.querySelector(selector)?.disabled,
			'completion did not settle',
		)

		const put = env.calls.find((call) => call.options.method === 'PUT')
		assert.deepEqual(JSON.parse(put.options.body), {
			work_date: '2026-08-29',
			task_id: 'messages',
			shop_id: 'alpha',
			completed: true,
		})
		assert.equal(put.url, '/api/operations/checklist')
		assert.equal(env.serverState.completions.length, 1)
		assert.equal(
			env.document.querySelector('.ops-checklist-edge-progress').textContent,
			'0/2 complete',
		)
		assert.equal(env.document.querySelector('#opsChecklistBadge').textContent, '2')
		assert.equal(
			env.document.querySelector(selector)
				.closest('.ops-checklist-task-completion')
				.querySelector('.ops-checklist-task-completion-status')
				.textContent
				.includes('alice'),
			true,
		)
		assert.equal(
			env.document.querySelector(
				'.ops-checklist-shop[data-shop-id="alpha"] .ops-checklist-shop-meta',
			).textContent,
			'1/4 tasks complete',
		)

		const remainingTasks = ['order_issues', 'stuck_shipping', 'weekly_sale']
		for (let index = 0; index < remainingTasks.length; index += 1) {
			const taskSelector = selectorFor(remainingTasks[index])
			env.document.querySelector(taskSelector).click()
			await waitFor(
				() =>
					env.calls.filter((call) => call.options.method === 'PUT').length
						=== index + 2
					&& env.document.querySelector(taskSelector)?.checked === true
					&& !env.document.querySelector(taskSelector)?.disabled,
				`${remainingTasks[index]} did not settle`,
			)
		}
		assert.equal(env.serverState.completions.length, 4)
		assert.equal(
			env.document.querySelector('.ops-checklist-edge-progress').textContent,
			'1/2 complete',
		)
		assert.equal(env.document.querySelector('#opsChecklistBadge').textContent, '1')
		assert.equal(
			env.document.querySelector(
				'.ops-checklist-shop[data-shop-id="alpha"]',
			).open,
			false,
		)
		assert.equal(
			env.document.querySelector(
				'.ops-checklist-shop[data-shop-id="beta"]',
			).open,
			true,
		)

		checkbox = env.document.querySelector(selector)
		checkbox.click()
		await waitFor(
			() => env.calls.filter((call) => call.options.method === 'PUT').length === 5
				&& env.document.querySelector(selector)?.checked === false
				&& !env.document.querySelector(selector)?.disabled,
			'uncheck did not settle',
		)
		const uncheckBody = JSON.parse(
			env.calls.filter((call) => call.options.method === 'PUT')[4].options.body,
		)
		assert.equal(uncheckBody.completed, false)
		assert.equal(uncheckBody.expected_completed_at, NOW.getTime())
		assert.equal(env.serverState.completions.length, 3)
		assert.equal(
			env.calls.every((call) => call.url === '/api/operations/checklist'),
			true,
		)
	} finally {
		env.widget.destroy()
		env.dom.window.close()
	}
})

test('shows future tasks for planning but disables every future checkbox', async () => {
	const env = await makeEnv()
	try {
		env.document.querySelector(
			'.ops-checklist-day[data-date="2026-08-30"]',
		).click()
		const futureChecks = [
			...env.document.querySelectorAll('.ops-checklist-task-check'),
		]
		assert.equal(futureChecks.length, 6)
		assert.equal(futureChecks.every((checkbox) => checkbox.disabled), true)
		assert.ok(env.document.querySelector('.ops-checklist-notice'))
	} finally {
		env.widget.destroy()
		env.dom.window.close()
	}
})

test('opens the scoped Issues and Shipping queues while keeping the checklist open', async () => {
	const env = await makeEnv()
	try {
		env.widget.open()
		env.document.querySelector(
			'.ops-checklist-shop[data-shop-id="alpha"] '
				+ '.ops-checklist-task-section[data-task-id="order_issues"] '
				+ '.ops-checklist-workflow[data-shop-id="alpha"]',
		).click()
		assert.deepEqual(env.window.__shownTabs, ['orders'])
		assert.deepEqual(env.window.__issueFilterCalls, ['active'])
		assert.equal(env.document.getElementById('filterShipped').value, 'issues')
		assert.equal(env.document.getElementById('filterShop').value, 'alpha')
		assert.equal(env.document.getElementById('filterOrderSearch').value, '')
		assert.equal(env.document.getElementById('filterDateFrom').value, '')
		assert.equal(env.document.getElementById('filterDateTo').value, '')
		assert.equal(env.document.getElementById('dateClearBtn').classList.contains('visible'), false)
		assert.equal(
			env.document.getElementById('opsChecklistRoot').classList.contains('is-open'),
			true,
		)
		assert.equal(env.window.localStorage.getItem('uedOperationsChecklistOpen'), '1')

		env.document.querySelector(
			'.ops-checklist-shop[data-shop-id="beta"] '
				+ '.ops-checklist-task-section[data-task-id="stuck_shipping"] '
				+ '.ops-checklist-workflow[data-shop-id="beta"]',
		).click()
		assert.deepEqual(env.window.__shownTabs, ['orders', 'shipping'])
		assert.equal(env.document.getElementById('shipStatusFilter').value, 'stuck')
		assert.equal(env.document.getElementById('shipOutreachFilter').value, 'needed')
		assert.equal(env.document.getElementById('shipShopFilter').value, 'beta')
		assert.equal(env.document.getElementById('shipRange').value, '30')
		assert.equal(
			env.document.getElementById('opsChecklistRoot').classList.contains('is-open'),
			true,
		)
	} finally {
		env.widget.destroy()
		env.dom.window.close()
	}
})

test('renders hostile shop names as text rather than executable markup', async () => {
	const payload = fixturePayload()
	payload.shops[0].shop_name =
		'<img id="checklist-owned" src=x onerror="window.__owned=true">'
	const env = await makeEnv({ payload })
	try {
		assert.equal(env.document.getElementById('checklist-owned'), null)
		assert.equal(env.window.__owned, undefined)
		assert.equal(
			[
				...env.document.querySelectorAll('.ops-checklist-shop-name'),
			].some((node) => node.textContent.includes('<img id="checklist-owned"')),
			true,
		)
	} finally {
		env.widget.destroy()
		env.dom.window.close()
	}
})

test('uses the dashboard language preference for its own dynamic UI', async () => {
	const env = await makeEnv({ language: 'zh' })
	try {
		assert.equal(
			env.document.querySelector('.ops-checklist-title').textContent,
			'每日清单',
		)
		assert.equal(
			env.document.querySelector('.ops-checklist-edge-title').textContent,
			'清单',
		)
		assert.equal(
			env.document.querySelector('#opsChecklistManualNote').textContent,
			'仅手动操作 - 0 次 Etsy API 调用',
		)
	} finally {
		env.widget.destroy()
		env.dom.window.close()
	}
})

async function main() {
	console.log('Operations checklist UI tests\n')
	let failures = 0
	for (const entry of tests) {
		try {
			await entry.fn()
			console.log(`  ok  - ${entry.name}`)
		} catch (error) {
			failures += 1
			console.error(`  FAIL - ${entry.name}`)
			console.error(`    ${error.stack || error.message}`)
		}
	}
	console.log('')
	if (failures) {
		console.error(`${failures} operations checklist UI assertion(s) failed.`)
		process.exitCode = 1
		return
	}
	console.log('All operations checklist UI assertions passed.')
}

main().catch((error) => {
	console.error(error.stack || error.message)
	process.exitCode = 1
})
