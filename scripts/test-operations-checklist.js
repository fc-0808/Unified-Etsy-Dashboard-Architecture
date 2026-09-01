'use strict'

const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const { initDb, syncConfigToDb } = require('../src/db/setup')
const checklist = require('../src/operations/checklist')

let failures = 0
function test(name, fn) {
	try {
		fn()
		console.log(`  ok  - ${name}`)
	} catch (error) {
		failures += 1
		console.error(`  FAIL - ${name}`)
		console.error(`    ${error.stack || error.message}`)
	}
}

function expectChecklistError(fn, code) {
	assert.throws(fn, (error) => {
		assert.equal(error instanceof checklist.ChecklistError, true)
		assert.equal(error.code, code)
		return true
	})
}

const NOW = new Date('2026-08-29T04:00:00.000Z') // Saturday noon in Shanghai.
const db = initDb(':memory:')
syncConfigToDb(db, {
	groups: [{
		group_id: 'g1',
		label: 'Group One',
		proxy: 'direct',
		shops: [
			{
				shop_id: 'alpha',
				shop_name: 'Alpha Shop',
				api_key: 'test-key-a',
				shared_secret: 'test-secret-a',
			},
			{
				shop_id: 'beta',
				shop_name: 'Beta Shop',
				api_key: 'test-key-b',
				shared_secret: 'test-secret-b',
			},
		],
	}],
})

console.log('Operations checklist domain tests\n')

test('uses the configured business timezone at the UTC date boundary', () => {
	assert.equal(
		checklist.dateKeyInTimeZone(
			new Date('2026-08-23T16:05:00.000Z'),
			'Asia/Shanghai',
		),
		'2026-08-24',
	)
	assert.equal(
		checklist.dateKeyInTimeZone(
			new Date('2026-08-23T16:05:00.000Z'),
			'UTC',
		),
		'2026-08-23',
	)
})

test('derives an ISO Monday-to-Sunday week without locale-dependent dates', () => {
	assert.equal(checklist.isoWeekday('2026-08-24'), 1)
	assert.equal(checklist.isoWeekday('2026-08-30'), 7)
	assert.equal(checklist.weekStartFor('2026-08-29'), '2026-08-24')
	assert.equal(checklist.addDays('2026-12-31', 1), '2027-01-01')
})

test('rejects malformed and impossible calendar dates', () => {
	expectChecklistError(() => checklist.parseDateKey('08/29/2026'), 'INVALID_CHECKLIST_DATE')
	expectChecklistError(() => checklist.parseDateKey('2026-02-30'), 'INVALID_CHECKLIST_DATE')
})

test('builds daily, Monday-Friday, and Saturday schedules per shop', () => {
	const payload = checklist.buildChecklist(db, {
		now: NOW,
		timeZone: 'Asia/Shanghai',
	})
	assert.equal(payload.source, 'local_sqlite')
	assert.equal(payload.etsy_api_calls, 0)
	assert.equal(payload.version, 2)
	assert.equal(payload.today, '2026-08-29')
	assert.equal(payload.week_start, '2026-08-24')
	assert.equal(payload.week_end, '2026-08-30')
	assert.deepEqual(payload.shops.map((shop) => shop.shop_id), ['alpha', 'beta'])
	assert.equal(payload.tasks.length, 5)
	const issueTask = payload.tasks.find((task) => task.id === 'order_issues')
	assert.equal(issueTask.title.en, 'Resolve Issues / on hold')
	assert.match(issueTask.instructions.en, /Contact every buyer/)
	assert.match(issueTask.instructions.en, /deactivate an out-of-production listing/)
	assert.equal(payload.tasks.some((task) => task.id === 'listing_availability'), false)

	const monday = payload.days[0]
	const tuesday = payload.days[1]
	const friday = payload.days[4]
	const saturday = payload.days[5]
	const sunday = payload.days[6]
	assert.deepEqual(
		monday.task_ids,
		[
			'messages',
			'order_issues',
			'stuck_shipping',
			'temporary_auto_reply',
		],
	)
	assert.equal(monday.total, 2)
	assert.equal(monday.checks_total, 8)
	assert.equal(tuesday.total, 2)
	assert.equal(tuesday.checks_total, 6)
	assert.equal(friday.task_ids.includes('temporary_auto_reply'), true)
	assert.equal(saturday.task_ids.includes('weekly_sale'), true)
	assert.equal(saturday.task_ids.includes('temporary_auto_reply'), false)
	assert.equal(saturday.total, 2)
	assert.equal(saturday.checks_total, 8)
	assert.equal(sunday.total, 2)
	assert.equal(sunday.checks_total, 6)
	assert.equal(saturday.is_today, true)
	assert.equal(sunday.is_future, true)
})

test('never includes the synthetic Manual Orders shop', () => {
	const payload = checklist.buildChecklist(db, {
		now: NOW,
		timeZone: 'Asia/Shanghai',
	})
	assert.equal(payload.shops.some((shop) => shop.shop_id === '__manual__'), false)
})

test('uses the exact operator-defined shop sequence shared by other tabs', () => {
	const orderedDb = initDb(':memory:')
	try {
		const names = [
			'CuteiPhoneCasesGoods',
			'KawaiiiPhoneCases',
			'IPhoneCasesByTwily',
			'Y2KASEshop',
			'LUVKASEofficial',
			'CuteiPhoneCasesFinds',
			'Y2KiPhoneCases',
			'IPhoneCasesDesignArt',
			'Y2KASEofficial',
		]
		syncConfigToDb(orderedDb, {
			groups: [{
				group_id: 'shops',
				label: 'Shops',
				proxy: 'direct',
				shops: names.map((shop_name, index) => ({
					shop_id: `shop-${index}`,
					shop_name,
					api_key: `key-${index}`,
					shared_secret: `secret-${index}`,
				})),
			}],
		})
		assert.deepEqual(
			checklist.listShops(orderedDb).map((shop) => shop.shop_name),
			checklist.SHOP_DISPLAY_ORDER,
		)
	} finally {
		orderedDb.close()
	}
})

test('persists a per-shop attestation with actor and stable shop snapshot', () => {
	const saved = checklist.setCompletion(
		db,
		{
			work_date: '2026-08-29',
			task_id: 'messages',
			shop_id: 'alpha',
			completed: true,
		},
		{
			actor: 'alice',
			now: NOW,
			timeZone: 'Asia/Shanghai',
		},
	)
	assert.equal(saved.changed, true)
	assert.equal(saved.completion.completed_by, 'alice')
	assert.equal(saved.completion.completed_at, NOW.getTime())
	assert.equal(saved.completion.shop_name, 'Alpha Shop')

	db.prepare('UPDATE shops SET shop_name = ? WHERE shop_id = ?').run(
		'Alpha Renamed',
		'alpha',
	)
	const persisted = checklist.getCompletion(
		db,
		'2026-08-29',
		'messages',
		'alpha',
	)
	assert.equal(persisted.shop_name, 'Alpha Shop')
	db.prepare('UPDATE shops SET shop_name = ? WHERE shop_id = ?').run(
		'Alpha Shop',
		'alpha',
	)
})

test('a retry is idempotent and cannot steal the first operator attribution', () => {
	const retry = checklist.setCompletion(
		db,
		{
			work_date: '2026-08-29',
			task_id: 'messages',
			shop_id: 'alpha',
			completed: true,
		},
		{
			actor: 'bob',
			now: new Date(NOW.getTime() + 60_000),
			timeZone: 'Asia/Shanghai',
		},
	)
	assert.equal(retry.changed, false)
	assert.equal(retry.completion.completed_by, 'alice')
	assert.equal(retry.completion.completed_at, NOW.getTime())
})

test('week summaries count completed shops while retaining task diagnostics', () => {
	const payload = checklist.buildChecklist(db, {
		now: NOW,
		timeZone: 'Asia/Shanghai',
	})
	const saturday = payload.days.find((day) => day.date === '2026-08-29')
	assert.equal(saturday.completed, 0)
	assert.equal(saturday.remaining, 2)
	assert.equal(saturday.checks_completed, 1)
	assert.equal(saturday.checks_remaining, 7)
	assert.equal(payload.completions.length, 1)
})

test('compare-and-delete rejects a stale uncheck from another screen', () => {
	expectChecklistError(
		() => checklist.setCompletion(
			db,
			{
				work_date: '2026-08-29',
				task_id: 'messages',
				shop_id: 'alpha',
				completed: false,
				expected_completed_at: NOW.getTime() - 1,
			},
			{
				actor: 'bob',
				now: NOW,
				timeZone: 'Asia/Shanghai',
			},
		),
		'STALE_CHECKLIST_STATE',
	)
	assert.ok(
		checklist.getCompletion(db, '2026-08-29', 'messages', 'alpha'),
	)
})

test('a matching uncheck removes current state and a retry remains idempotent', () => {
	const removed = checklist.setCompletion(
		db,
		{
			work_date: '2026-08-29',
			task_id: 'messages',
			shop_id: 'alpha',
			completed: false,
			expected_completed_at: NOW.getTime(),
		},
		{
			actor: 'alice',
			now: NOW,
			timeZone: 'Asia/Shanghai',
		},
	)
	assert.equal(removed.changed, true)
	assert.equal(removed.completion, null)
	const retry = checklist.setCompletion(
		db,
		{
			work_date: '2026-08-29',
			task_id: 'messages',
			shop_id: 'alpha',
			completed: false,
		},
		{
			actor: 'alice',
			now: NOW,
			timeZone: 'Asia/Shanghai',
		},
	)
	assert.equal(retry.changed, false)
})

test('future dates, closed weeks, wrong schedules, and unknown shops fail closed', () => {
	expectChecklistError(
		() => checklist.setCompletion(
			db,
			{
				work_date: '2026-08-30',
				task_id: 'messages',
				shop_id: 'alpha',
				completed: true,
			},
			{ now: NOW, timeZone: 'Asia/Shanghai' },
		),
		'FUTURE_CHECKLIST_DATE',
	)
	expectChecklistError(
		() => checklist.setCompletion(
			db,
			{
				work_date: '2026-08-23',
				task_id: 'messages',
				shop_id: 'alpha',
				completed: true,
			},
			{ now: NOW, timeZone: 'Asia/Shanghai' },
		),
		'CHECKLIST_WEEK_CLOSED',
	)
	expectChecklistError(
		() => checklist.setCompletion(
			db,
			{
				work_date: '2026-08-29',
				task_id: 'temporary_auto_reply',
				shop_id: 'alpha',
				completed: true,
			},
			{ now: NOW, timeZone: 'Asia/Shanghai' },
		),
		'CHECKLIST_TASK_NOT_SCHEDULED',
	)
	expectChecklistError(
		() => checklist.setCompletion(
			db,
			{
				work_date: '2026-08-29',
				task_id: 'messages',
				shop_id: 'missing',
				completed: true,
			},
			{ now: NOW, timeZone: 'Asia/Shanghai' },
		),
		'CHECKLIST_SHOP_NOT_FOUND',
	)
	expectChecklistError(
		() => checklist.setCompletion(
			db,
			{
				work_date: '2026-08-29',
				task_id: 'messages',
				shop_id: '__manual__',
				completed: true,
			},
			{ now: NOW, timeZone: 'Asia/Shanghai' },
		),
		'CHECKLIST_SHOP_NOT_FOUND',
	)
})

test('the checklist domain has no Etsy or network client dependency', () => {
	const source = fs.readFileSync(
		path.resolve(__dirname, '../src/operations/checklist.js'),
		'utf8',
	)
	const imports = [
		...source.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
	].map((match) => match[1])
	assert.deepEqual(imports, [])
	assert.equal(/\bfetch\s*\(|\baxios\b|TokenManager|buildShopClient/.test(source), false)
})

db.close()

console.log('')
if (failures) {
	console.error(`${failures} operations checklist assertion(s) failed.`)
	process.exit(1)
}
console.log('All operations checklist domain assertions passed.')
