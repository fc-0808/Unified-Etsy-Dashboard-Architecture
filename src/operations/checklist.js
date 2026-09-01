'use strict'

/**
 * Manual operations checklist.
 *
 * This module deliberately has no Etsy client, token manager, HTTP client, or
 * background job dependency. It derives a Monday-to-Sunday schedule, reads the
 * configured shop identities already present in SQLite, and stores human
 * attestations. The work itself remains manual in Etsy Shop Manager.
 */

const DEFAULT_TIME_ZONE = 'Asia/Shanghai'
const MANUAL_SHOP_ID = '__manual__'
const MANUAL_GROUP_ID = '__manual__'
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/
const SUBJECT_TYPE = 'shop'

const DAILY = Object.freeze([1, 2, 3, 4, 5, 6, 7])
// This is the operator-defined working order already used by every dashboard
// shop table/dropdown (public/index.html → SHOP_DISPLAY_ORDER). Keep unknown or
// newly-added shops at the end in their stable database order.
const SHOP_DISPLAY_ORDER = Object.freeze([
	'Y2KASEofficial',
	'LUVKASEofficial',
	'Y2KASEshop',
	'Y2KiPhoneCases',
	'KawaiiiPhoneCases',
	'IPhoneCasesDesignArt',
	'IPhoneCasesByTwily',
	'CuteiPhoneCasesFinds',
	'CuteiPhoneCasesGoods',
])
const SHOP_DISPLAY_RANK = new Map(
	SHOP_DISPLAY_ORDER.map((name, index) => [name.toLowerCase(), index]),
)

/**
 * Stable task ids are persisted; copy can evolve without invalidating history.
 * ISO weekdays use Monday=1 through Sunday=7.
 */
const TASKS = Object.freeze([
	Object.freeze({
		id: 'messages',
		schedule: 'daily',
		weekdays: DAILY,
		title: Object.freeze({
			en: 'Check and reply to messages',
			zh: '检查并回复消息',
		}),
		instructions: Object.freeze({
			en: 'Sign in to this shop in Etsy Shop Manager. Review unread conversations and reply wherever a buyer is waiting.',
			zh: '登录此店铺的 Etsy 店铺管理后台，检查未读会话，并回复所有等待答复的买家。',
		}),
	}),
	Object.freeze({
		id: 'order_issues',
		schedule: 'daily',
		weekdays: DAILY,
		workflow: 'orders_issues',
		workflow_capability: 'orders:read',
		title: Object.freeze({
			en: 'Resolve Issues / on hold',
			zh: '处理异常 / 暂挂订单',
		}),
		instructions: Object.freeze({
			en: 'Open Orders > Issues / on hold. Contact every buyer who has not been reached and mark the buyer notified. Then manually deactivate an out-of-production listing or remove only the unavailable model, and mark the listing handled.',
			zh: '打开“订单 > 异常 / 暂挂”。联系所有尚未收到通知的买家并标记“已通知买家”；然后手动停用已停产商品或仅移除无法供应的型号，并标记“商品已处理”。',
		}),
	}),
	Object.freeze({
		id: 'stuck_shipping',
		schedule: 'daily',
		weekdays: DAILY,
		workflow: 'shipping_outreach',
		workflow_capability: 'shipping:admin',
		title: Object.freeze({
			en: 'Contact buyers for stuck parcels',
			zh: '联系包裹滞留的买家',
		}),
		instructions: Object.freeze({
			en: 'Open Shipping > Stuck - action needed > Needs message. Contact each affected buyer on Etsy, then mark the buyer message sent in UED.',
			zh: '打开“物流跟踪 > 滞留 - 需要处理 > 需要消息”，在 Etsy 联系每位受影响的买家，然后在 UED 标记消息已发送。',
		}),
	}),
	Object.freeze({
		id: 'temporary_auto_reply',
		schedule: 'monday_friday',
		weekdays: Object.freeze([1, 5]),
		title: Object.freeze({
			en: 'Renew temporary auto-reply',
			zh: '续期临时自动回复',
		}),
		instructions: Object.freeze({
			en: 'In Etsy Shop Manager, renew this shop\'s temporary auto-reply for the maximum permitted duration. Scheduled every Monday and Friday.',
			zh: '在 Etsy 店铺管理后台，将此店铺的临时自动回复续期至允许的最长时限。每周一和周五执行。',
		}),
	}),
	Object.freeze({
		id: 'weekly_sale',
		schedule: 'saturday',
		weekdays: Object.freeze([6]),
		title: Object.freeze({
			en: 'Renew the weekly 50% sale',
			zh: '续期每周五折促销',
		}),
		instructions: Object.freeze({
			en: 'In Marketing > Sales and Discounts > Run a sale, schedule 50% off the entire shop from this Saturday through next Saturday.',
			zh: '在“营销 > 促销与折扣 > 举办促销”中，为全店设置五折活动，时间从本周六至下周六。',
		}),
	}),
])

const TASK_BY_ID = new Map(TASKS.map((task) => [task.id, task]))

class ChecklistError extends Error {
	constructor(message, { status = 400, code = 'INVALID_CHECKLIST_REQUEST', field = null, current = null } = {}) {
		super(message)
		this.name = 'ChecklistError'
		this.status = status
		this.code = code
		this.field = field
		this.current = current
	}
}

function ensureSchema(db) {
	db.exec(`
		CREATE TABLE IF NOT EXISTS operations_checklist_completions (
			work_date     TEXT NOT NULL,
			task_id       TEXT NOT NULL,
			subject_type  TEXT NOT NULL DEFAULT 'shop',
			subject_id    TEXT NOT NULL,
			subject_label TEXT NOT NULL,
			completed_at  INTEGER NOT NULL,
			completed_by  TEXT NOT NULL,
			PRIMARY KEY (work_date, task_id, subject_type, subject_id),
			CHECK (length(work_date) = 10),
			CHECK (length(task_id) BETWEEN 1 AND 80),
			CHECK (subject_type = 'shop'),
			CHECK (length(subject_id) BETWEEN 1 AND 200),
			CHECK (length(subject_label) BETWEEN 1 AND 200),
			CHECK (length(completed_by) BETWEEN 1 AND 80)
		);
		CREATE INDEX IF NOT EXISTS idx_operations_checklist_date
			ON operations_checklist_completions(work_date, task_id);
	`)
}

function normalizeTimeZone(value) {
	const zone = String(value || '').trim() || DEFAULT_TIME_ZONE
	try {
		new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date())
		return zone
	} catch {
		return DEFAULT_TIME_ZONE
	}
}

function dateKeyInTimeZone(now = new Date(), timeZone = DEFAULT_TIME_ZONE) {
	const date = now instanceof Date ? now : new Date(now)
	if (!Number.isFinite(date.getTime())) {
		throw new ChecklistError('The checklist clock is invalid.', {
			status: 500,
			code: 'INVALID_CHECKLIST_CLOCK',
		})
	}
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone: normalizeTimeZone(timeZone),
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).formatToParts(date)
	const part = (type) => parts.find((entry) => entry.type === type)?.value
	return `${part('year')}-${part('month')}-${part('day')}`
}

function parseDateKey(value, field = 'work_date') {
	const key = String(value || '')
	if (!DATE_KEY_RE.test(key)) {
		throw new ChecklistError(`${field} must use YYYY-MM-DD format.`, {
			code: 'INVALID_CHECKLIST_DATE',
			field,
		})
	}
	const [year, month, day] = key.split('-').map(Number)
	const date = new Date(Date.UTC(year, month - 1, day))
	if (
		date.getUTCFullYear() !== year
		|| date.getUTCMonth() !== month - 1
		|| date.getUTCDate() !== day
	) {
		throw new ChecklistError(`${field} is not a valid calendar date.`, {
			code: 'INVALID_CHECKLIST_DATE',
			field,
		})
	}
	return key
}

function addDays(dateKey, amount) {
	const key = parseDateKey(dateKey)
	const [year, month, day] = key.split('-').map(Number)
	const date = new Date(Date.UTC(year, month - 1, day + Number(amount || 0)))
	return [
		String(date.getUTCFullYear()).padStart(4, '0'),
		String(date.getUTCMonth() + 1).padStart(2, '0'),
		String(date.getUTCDate()).padStart(2, '0'),
	].join('-')
}

function isoWeekday(dateKey) {
	const key = parseDateKey(dateKey)
	const [year, month, day] = key.split('-').map(Number)
	const sundayBased = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
	return sundayBased === 0 ? 7 : sundayBased
}

function weekStartFor(dateKey) {
	const key = parseDateKey(dateKey)
	return addDays(key, 1 - isoWeekday(key))
}

function scheduledTasksFor(dateKey) {
	const weekday = isoWeekday(dateKey)
	return TASKS.filter((task) => task.weekdays.includes(weekday))
}

function listShops(db) {
	const shops = db
		.prepare(`
			SELECT shop_id, shop_name, group_id
			FROM shops
			WHERE shop_id <> @manual_shop
			  AND group_id <> @manual_group
			ORDER BY group_id ASC, shop_name COLLATE NOCASE ASC, shop_id ASC
		`)
		.all({ manual_shop: MANUAL_SHOP_ID, manual_group: MANUAL_GROUP_ID })
		.map((shop) => ({
			shop_id: String(shop.shop_id),
			shop_name: String(shop.shop_name),
			group_id: String(shop.group_id),
		}))
	return shops
		.map((shop, index) => ({ shop, index }))
		.sort((a, b) => {
			const rank = (entry) =>
				SHOP_DISPLAY_RANK.get(entry.shop.shop_name.toLowerCase())
				?? SHOP_DISPLAY_ORDER.length
			return rank(a) - rank(b) || a.index - b.index
		})
		.map(({ shop }) => shop)
}

function listWeekCompletions(db, weekStart, weekEnd, shopIds) {
	if (!shopIds.size) return []
	return db
		.prepare(`
			SELECT
				work_date,
				task_id,
				subject_id AS shop_id,
				subject_label AS shop_name,
				completed_at,
				completed_by
			FROM operations_checklist_completions
			WHERE work_date BETWEEN ? AND ?
			  AND subject_type = ?
			ORDER BY work_date ASC, task_id ASC, subject_id ASC
		`)
		.all(weekStart, weekEnd, SUBJECT_TYPE)
		.filter((row) => shopIds.has(String(row.shop_id)) && TASK_BY_ID.has(row.task_id))
		.map((row) => ({
			...row,
			shop_id: String(row.shop_id),
			completed_at: Number(row.completed_at),
		}))
}

function summarizeDays({ weekStart, today, shops, completions }) {
	const completedKeys = new Set(
		completions.map((row) => `${row.work_date}\u0000${row.task_id}\u0000${row.shop_id}`),
	)
	return Array.from({ length: 7 }, (_, index) => {
		const date = addDays(weekStart, index)
		const taskIds = scheduledTasksFor(date).map((task) => task.id)
		let checksCompleted = 0
		let shopsCompleted = 0
		for (const shop of shops) {
			let shopChecks = 0
			for (const taskId of taskIds) {
				if (completedKeys.has(`${date}\u0000${taskId}\u0000${shop.shop_id}`)) {
					shopChecks += 1
				}
			}
			checksCompleted += shopChecks
			if (taskIds.length > 0 && shopChecks === taskIds.length) {
				shopsCompleted += 1
			}
		}
		const total = taskIds.length > 0 ? shops.length : 0
		const checksTotal = taskIds.length * shops.length
		return {
			date,
			iso_weekday: index + 1,
			is_today: date === today,
			is_past: date < today,
			is_future: date > today,
			task_ids: taskIds,
			total,
			completed: shopsCompleted,
			remaining: Math.max(0, total - shopsCompleted),
			checks_total: checksTotal,
			checks_completed: checksCompleted,
			checks_remaining: Math.max(0, checksTotal - checksCompleted),
		}
	})
}

function buildChecklist(db, { now = new Date(), timeZone = DEFAULT_TIME_ZONE } = {}) {
	ensureSchema(db)
	const normalizedZone = normalizeTimeZone(timeZone)
	const today = dateKeyInTimeZone(now, normalizedZone)
	const weekStart = weekStartFor(today)
	const weekEnd = addDays(weekStart, 6)
	const shops = listShops(db)
	const completions = listWeekCompletions(
		db,
		weekStart,
		weekEnd,
		new Set(shops.map((shop) => shop.shop_id)),
	)
	const days = summarizeDays({ weekStart, today, shops, completions })
	const todaySummary = days.find((day) => day.is_today)

	return {
		version: 2,
		source: 'local_sqlite',
		etsy_api_calls: 0,
		time_zone: normalizedZone,
		generated_at: (now instanceof Date ? now : new Date(now)).getTime(),
		today,
		week_start: weekStart,
		week_end: weekEnd,
		shops,
		tasks: TASKS,
		completions,
		days,
		today_summary: todaySummary,
	}
}

function getCompletion(db, workDate, taskId, shopId) {
	const row = db
		.prepare(`
			SELECT
				work_date,
				task_id,
				subject_id AS shop_id,
				subject_label AS shop_name,
				completed_at,
				completed_by
			FROM operations_checklist_completions
			WHERE work_date = ?
			  AND task_id = ?
			  AND subject_type = ?
			  AND subject_id = ?
		`)
		.get(workDate, taskId, SUBJECT_TYPE, shopId)
	if (!row) return null
	return { ...row, shop_id: String(row.shop_id), completed_at: Number(row.completed_at) }
}

function validateChecklistTarget(db, input, { now, timeZone }) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new ChecklistError('A JSON request body is required.', {
			code: 'INVALID_CHECKLIST_BODY',
		})
	}
	const workDate = parseDateKey(input.work_date)
	const shopId = String(input.shop_id || '').trim()
	if (!shopId || shopId.length > 200) {
		throw new ChecklistError('shop_id is required.', {
			code: 'INVALID_CHECKLIST_SHOP',
			field: 'shop_id',
		})
	}
	if (typeof input.completed !== 'boolean') {
		throw new ChecklistError('completed must be true or false.', {
			code: 'INVALID_CHECKLIST_COMPLETION',
			field: 'completed',
		})
	}

	const today = dateKeyInTimeZone(now, timeZone)
	const weekStart = weekStartFor(today)
	const weekEnd = addDays(weekStart, 6)
	if (workDate < weekStart || workDate > weekEnd) {
		throw new ChecklistError('Only the current Monday-to-Sunday checklist can be changed.', {
			status: 409,
			code: 'CHECKLIST_WEEK_CLOSED',
			field: 'work_date',
		})
	}
	if (workDate > today) {
		throw new ChecklistError('A future checklist day cannot be completed in advance.', {
			status: 409,
			code: 'FUTURE_CHECKLIST_DATE',
			field: 'work_date',
		})
	}

	const shop = db
		.prepare(`
			SELECT shop_id, shop_name
			FROM shops
			WHERE shop_id = ?
			  AND shop_id <> ?
			  AND group_id <> ?
		`)
		.get(shopId, MANUAL_SHOP_ID, MANUAL_GROUP_ID)
	if (!shop) {
		throw new ChecklistError('The selected shop is not active in this dashboard.', {
			status: 404,
			code: 'CHECKLIST_SHOP_NOT_FOUND',
			field: 'shop_id',
		})
	}

	return {
		workDate,
		shop: {
			shop_id: String(shop.shop_id),
			shop_name: String(shop.shop_name),
		},
		completed: input.completed,
	}
}

function validateCompletionInput(db, input, context) {
	const target = validateChecklistTarget(db, input, context)
	const taskId = String(input.task_id || '').trim()
	if (!TASK_BY_ID.has(taskId)) {
		throw new ChecklistError('Unknown checklist task.', {
			code: 'UNKNOWN_CHECKLIST_TASK',
			field: 'task_id',
		})
	}
	const task = TASK_BY_ID.get(taskId)
	if (!task.weekdays.includes(isoWeekday(target.workDate))) {
		throw new ChecklistError('This task is not scheduled for the selected day.', {
			status: 409,
			code: 'CHECKLIST_TASK_NOT_SCHEDULED',
			field: 'task_id',
		})
	}

	let expectedCompletedAt = null
	if (input.expected_completed_at != null) {
		expectedCompletedAt = Number(input.expected_completed_at)
		if (!Number.isSafeInteger(expectedCompletedAt) || expectedCompletedAt <= 0) {
			throw new ChecklistError('expected_completed_at must be a positive integer timestamp.', {
				code: 'INVALID_CHECKLIST_REVISION',
				field: 'expected_completed_at',
			})
		}
	}

	return {
		...target,
		taskId,
		expectedCompletedAt,
	}
}

function normalizeActor(value) {
	const actor = String(value || '').trim()
	return (actor || 'owner').slice(0, 80)
}

function setCompletion(
	db,
	input,
	{
		actor = 'owner',
		now = new Date(),
		timeZone = DEFAULT_TIME_ZONE,
	} = {},
) {
	ensureSchema(db)
	const normalizedZone = normalizeTimeZone(timeZone)
	const currentTime = now instanceof Date ? now : new Date(now)
	if (!Number.isFinite(currentTime.getTime())) {
		throw new ChecklistError('The checklist clock is invalid.', {
			status: 500,
			code: 'INVALID_CHECKLIST_CLOCK',
		})
	}
	const validated = validateCompletionInput(db, input, {
		now: currentTime,
		timeZone: normalizedZone,
	})
	const { workDate, taskId, shop, completed, expectedCompletedAt } = validated
	const existing = getCompletion(db, workDate, taskId, shop.shop_id)

	if (completed) {
		if (existing) {
			return { changed: false, completion: existing }
		}
		const completedAt = currentTime.getTime()
		const inserted = db.prepare(`
			INSERT INTO operations_checklist_completions (
				work_date,
				task_id,
				subject_type,
				subject_id,
				subject_label,
				completed_at,
				completed_by
			)
			VALUES (
				@work_date,
				@task_id,
				@subject_type,
				@subject_id,
				@subject_label,
				@completed_at,
				@completed_by
			)
			ON CONFLICT(work_date, task_id, subject_type, subject_id) DO NOTHING
		`).run({
			work_date: workDate,
			task_id: taskId,
			subject_type: SUBJECT_TYPE,
			subject_id: shop.shop_id,
			subject_label: shop.shop_name,
			completed_at: completedAt,
			completed_by: normalizeActor(actor),
		})
		const saved = getCompletion(db, workDate, taskId, shop.shop_id)
		return {
			changed: inserted.changes === 1,
			completion: saved,
		}
	}

	if (!existing) {
		return { changed: false, completion: null }
	}
	if (
		expectedCompletedAt != null
		&& expectedCompletedAt !== existing.completed_at
	) {
		throw new ChecklistError('This checklist item changed on another screen. Refresh and try again.', {
			status: 409,
			code: 'STALE_CHECKLIST_STATE',
			current: existing,
		})
	}
	const removed = db
		.prepare(`
			DELETE FROM operations_checklist_completions
			WHERE work_date = ?
			  AND task_id = ?
			  AND subject_type = ?
			  AND subject_id = ?
			  AND completed_at = ?
		`)
		.run(workDate, taskId, SUBJECT_TYPE, shop.shop_id, existing.completed_at)
	if (removed.changes !== 1) {
		throw new ChecklistError('This checklist item changed on another screen. Refresh and try again.', {
			status: 409,
			code: 'STALE_CHECKLIST_STATE',
			current: getCompletion(db, workDate, taskId, shop.shop_id),
		})
	}
	return { changed: true, completion: null }
}

function installRoutes(app, {
	db,
	timeZone = DEFAULT_TIME_ZONE,
	now = () => new Date(),
} = {}) {
	if (!app || typeof app.get !== 'function' || typeof app.put !== 'function') {
		throw new TypeError('An Express application is required.')
	}
	if (!db || typeof db.prepare !== 'function') {
		throw new TypeError('A SQLite database is required.')
	}
	ensureSchema(db)
	const currentTimeZone = () => normalizeTimeZone(
		typeof timeZone === 'function' ? timeZone() : timeZone,
	)

	app.get('/api/operations/checklist', (_req, res) => {
		try {
			res.set('Cache-Control', 'no-store')
			res.json(buildChecklist(db, {
				now: now(),
				timeZone: currentTimeZone(),
			}))
		} catch (error) {
			console.error('[operations-checklist] read failed:', error.message)
			res.status(error.status || 500).json({
				error: error.status ? error.message : 'Could not load the operations checklist.',
				code: error.code || 'CHECKLIST_READ_FAILED',
				field: error.field || null,
			})
		}
	})

	app.put('/api/operations/checklist', (req, res) => {
		try {
			const result = setCompletion(db, req.body, {
				actor: req.auth?.user || req.auth?.role || 'owner',
				now: now(),
				timeZone: currentTimeZone(),
			})
			res.set('Cache-Control', 'no-store')
			res.json({
				ok: true,
				...result,
			})
		} catch (error) {
			if (!(error instanceof ChecklistError)) {
				console.error('[operations-checklist] update failed:', error.message)
			}
			res.status(error.status || 500).json({
				error: error.status ? error.message : 'Could not update the operations checklist.',
				code: error.code || 'CHECKLIST_UPDATE_FAILED',
				field: error.field || null,
				current: error.current || null,
			})
		}
	})

}

module.exports = {
	DEFAULT_TIME_ZONE,
	SHOP_DISPLAY_ORDER,
	TASKS,
	ChecklistError,
	ensureSchema,
	normalizeTimeZone,
	dateKeyInTimeZone,
	parseDateKey,
	addDays,
	isoWeekday,
	weekStartFor,
	scheduledTasksFor,
	listShops,
	buildChecklist,
	getCompletion,
	setCompletion,
	installRoutes,
}
