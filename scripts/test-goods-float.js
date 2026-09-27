'use strict'

/**
 * Manufacturer shopping float — calendar-month COGS ledger used by Earnings.
 *
 * Covers timezone month boundaries, PUT/adjust semantics, optimistic concurrency,
 * window rollups, and the HTTP contract installed on a throwaway Express app.
 * No Etsy, tokens, or live dashboard process.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const express = require('express')
const Database = require('better-sqlite3')

const { initDb } = require('../src/db/setup')
const goodsFloat = require('../src/finance/goods-float')
const wechatBill = require('../src/finance/wechat-bill')

let failures = 0
function test(name, fn) {
	const run = async () => {
		try {
			await fn()
			console.log(`  ok  - ${name}`)
		} catch (error) {
			failures += 1
			console.error(`  FAIL - ${name}`)
			console.error(`    ${error.stack || error.message}`)
		}
	}
	return run()
}

function expectError(fn, code) {
	assert.throws(fn, (error) => {
		assert.equal(error instanceof goodsFloat.GoodsFloatError, true)
		assert.equal(error.code, code)
		return true
	})
}

function memoryDb() {
	const db = new Database(':memory:')
	goodsFloat.ensureSchema(db)
	return db
}

const SHANGHAI_SEP_START = new Date('2026-08-31T16:00:00.000Z') // 2026-09-01 00:00 CST
const NOW = new Date('2026-09-18T00:42:00.000Z') // 08:42 CST on the user's screenshot day

console.log('Manufacturer goods float domain tests\n')

async function main() {
	await test('initDb installs the goods-float tables', () => {
		const db = initDb(':memory:')
		try {
			const months = db.prepare(`SELECT name FROM sqlite_master WHERE name = 'goods_float_months'`).get()
			const revisions = db.prepare(`SELECT name FROM sqlite_master WHERE name = 'goods_float_revisions'`).get()
			const transfers = db.prepare(`SELECT name FROM sqlite_master WHERE name = 'goods_float_transfers'`).get()
			const shots = db.prepare(`SELECT name FROM sqlite_master WHERE name = 'goods_float_screenshots'`).get()
			const links = db.prepare(`SELECT name FROM sqlite_master WHERE name = 'goods_float_transfer_screenshots'`).get()
			assert.ok(months)
			assert.ok(revisions)
			assert.ok(transfers)
			assert.ok(shots)
			assert.ok(links)
		} finally {
			db.close()
		}
	})

	await test('uses Asia/Shanghai at the UTC date boundary for the calendar month', () => {
		assert.equal(goodsFloat.periodYmFromDate(SHANGHAI_SEP_START, 'Asia/Shanghai'), '2026-09')
		assert.equal(goodsFloat.periodYmFromDate(new Date('2026-08-31T15:59:59.000Z'), 'Asia/Shanghai'), '2026-08')
		assert.equal(goodsFloat.periodYmFromDate(SHANGHAI_SEP_START, 'UTC'), '2026-08')
		assert.equal(goodsFloat.periodYmFromUnix(Math.floor(NOW.getTime() / 1000), 'Asia/Shanghai'), '2026-09')
	})

	await test('rejects malformed, impossible, and out-of-range periods', () => {
		expectError(() => goodsFloat.parsePeriodYm('2026/09'), 'INVALID_GOODS_FLOAT_PERIOD')
		expectError(() => goodsFloat.parsePeriodYm('2026-13'), 'INVALID_GOODS_FLOAT_PERIOD')
		expectError(() => goodsFloat.parsePeriodYm('1999-12'), 'INVALID_GOODS_FLOAT_PERIOD')
		expectError(() => goodsFloat.parsePeriodYm(''), 'INVALID_GOODS_FLOAT_PERIOD')
	})

	await test('enumerates months across a year boundary', () => {
		assert.deepEqual(goodsFloat.enumerateMonths('2025-11', '2026-02'), ['2025-11', '2025-12', '2026-01', '2026-02'])
		assert.equal(goodsFloat.lastDateKeyOfMonth('2026-09'), '2026-09-30')
		assert.equal(goodsFloat.lastDateKeyOfMonth('2024-02'), '2024-02-29')
	})

	await test('stores ¥888 × N and preserves the per-transfer amount on later count edits', () => {
		const db = memoryDb()
		try {
			const first = goodsFloat.setMonthCount(
				db,
				'2026-09',
				{ transfer_count: 3 },
				{ actor: 'walter', now: NOW },
			)
			assert.equal(first.unchanged, false)
			assert.equal(first.month.transfer_count, 3)
			assert.equal(first.month.amount_per_transfer_cents, 88800)
			assert.equal(first.month.total_cents, 266400)
			assert.equal(first.month.currency, 'CNY')
			assert.equal(first.month.version, 1)
			assert.equal(first.month.stored, true)
			assert.equal(first.month.updated_by, 'walter')

			const second = goodsFloat.setMonthCount(
				db,
				'2026-09',
				{ transfer_count: 5, version: 1 },
				{ actor: 'walter', now: NOW },
			)
			assert.equal(second.month.transfer_count, 5)
			assert.equal(second.month.amount_per_transfer_cents, 88800)
			assert.equal(second.month.total_cents, 444000)
			assert.equal(second.month.version, 2)
		} finally {
			db.close()
		}
	})

	await test('treats an identical PUT as a no-op and does not bump the revision', () => {
		const db = memoryDb()
		try {
			goodsFloat.setMonthCount(db, '2026-09', { transfer_count: 2 }, { actor: 'walter', now: NOW })
			const again = goodsFloat.setMonthCount(
				db,
				'2026-09',
				{ transfer_count: 2, version: 1 },
				{ actor: 'walter', now: NOW },
			)
			assert.equal(again.unchanged, true)
			assert.equal(again.month.version, 1)
			assert.equal(goodsFloat.listRevisions(db, '2026-09').length, 1)
		} finally {
			db.close()
		}
	})

	await test('optimistic concurrency rejects a stale version and returns the current row', () => {
		const db = memoryDb()
		try {
			goodsFloat.setMonthCount(db, '2026-09', { transfer_count: 1 }, { actor: 'walter', now: NOW })
			goodsFloat.setMonthCount(db, '2026-09', { transfer_count: 4, version: 1 }, { actor: 'mei', now: NOW })
			expectError(
				() =>
					goodsFloat.setMonthCount(
						db,
						'2026-09',
						{ transfer_count: 9, version: 1 },
						{ actor: 'walter', now: NOW },
					),
				'GOODS_FLOAT_VERSION_CONFLICT',
			)
			try {
				goodsFloat.setMonthCount(db, '2026-09', { transfer_count: 9, version: 1 }, { actor: 'walter', now: NOW })
			} catch (error) {
				assert.equal(error.status, 409)
				assert.equal(error.current.transfer_count, 4)
				assert.equal(error.current.version, 2)
			}
		} finally {
			db.close()
		}
	})

	await test('adjust increments and refuses to walk through zero or the cap', () => {
		const db = memoryDb()
		try {
			const up = goodsFloat.adjustMonthCount(db, '2026-09', { delta: 1 }, { actor: 'walter', now: NOW })
			assert.equal(up.month.transfer_count, 1)
			expectError(
				() => goodsFloat.adjustMonthCount(db, '2026-09', { delta: -2, version: 1 }, { actor: 'walter', now: NOW }),
				'GOODS_FLOAT_OUT_OF_RANGE',
			)
			expectError(
				() => goodsFloat.setMonthCount(db, '2026-09', { transfer_count: 1000 }, { actor: 'walter', now: NOW }),
				'GOODS_FLOAT_OUT_OF_RANGE',
			)
			expectError(
				() => goodsFloat.setMonthCount(db, '2026-09', { transfer_count: 1.5 }, { actor: 'walter', now: NOW }),
				'INVALID_GOODS_FLOAT_NUMBER',
			)
		} finally {
			db.close()
		}
	})

	await test('records an auditable revision trail for every real change', () => {
		const db = memoryDb()
		try {
			goodsFloat.setMonthCount(db, '2026-09', { transfer_count: 2, note: 'first' }, { actor: 'walter', now: NOW })
			goodsFloat.setMonthCount(
				db,
				'2026-09',
				{ transfer_count: 3, version: 1, note: 'top-up' },
				{ actor: 'mei', now: NOW },
			)
			const revisions = goodsFloat.listRevisions(db, '2026-09')
			assert.equal(revisions.length, 2)
			assert.equal(revisions[0].next_count, 3)
			assert.equal(revisions[0].prev_count, 2)
			assert.equal(revisions[0].changed_by, 'mei')
			assert.equal(revisions[0].note, 'top-up')
			assert.equal(revisions[1].prev_count, null)
			assert.equal(revisions[1].next_count, 2)
		} finally {
			db.close()
		}
	})

	await test('rolls overlapping calendar months into the selected earnings window', () => {
		const db = memoryDb()
		try {
			goodsFloat.setMonthCount(db, '2026-08', { transfer_count: 2 }, { actor: 'walter', now: NOW })
			goodsFloat.setMonthCount(db, '2026-09', { transfer_count: 5 }, { actor: 'walter', now: NOW })
			const from = Math.floor(new Date('2026-08-20T00:00:00+08:00').getTime() / 1000)
			const to = Math.floor(NOW.getTime() / 1000)
			const summary = goodsFloat.buildWindowSummary(db, {
				from,
				to,
				timeZone: 'Asia/Shanghai',
				now: NOW,
			})
			assert.deepEqual(summary.window.months, ['2026-08', '2026-09'])
			assert.equal(summary.transfer_count, 7)
			assert.equal(summary.total_cents, 7 * 88800)
			assert.equal(summary.covers_partial_month ?? summary.window.covers_partial_month, true)
			assert.equal(summary.deductible, true)
			assert.equal(summary.portfolio, true)
			assert.equal(summary.current_month.period_ym, '2026-09')
			assert.equal(summary.current_month.transfer_count, 5)
		} finally {
			db.close()
		}
	})

	await test('does not allocate the company float onto a single-shop filter', () => {
		const db = memoryDb()
		try {
			goodsFloat.setMonthCount(db, '2026-09', { transfer_count: 4 }, { actor: 'walter', now: NOW })
			const summary = goodsFloat.buildWindowSummary(db, {
				shopId: 'Y2KiPhoneCases',
				timeZone: 'Asia/Shanghai',
				now: NOW,
			})
			assert.equal(summary.deductible, false)
			assert.equal(summary.shop_id, 'Y2KiPhoneCases')
			assert.equal(summary.transfer_count, 4)
		} finally {
			db.close()
		}
	})

	await test('all-time includes stored months plus the current month even when empty', () => {
		const db = memoryDb()
		try {
			goodsFloat.setMonthCount(db, '2026-01', { transfer_count: 1 }, { actor: 'walter', now: NOW })
			const summary = goodsFloat.buildWindowSummary(db, { timeZone: 'Asia/Shanghai', now: NOW })
			assert.ok(summary.window.months.includes('2026-01'))
			assert.ok(summary.window.months.includes('2026-09'))
			assert.equal(summary.window.from, null)
			const september = summary.months.find((row) => row.period_ym === '2026-09')
			assert.equal(september.stored, false)
			assert.equal(september.transfer_count, 0)
		} finally {
			db.close()
		}
	})

	await test('long windows do not invent dozens of empty months', () => {
		const db = memoryDb()
		try {
			goodsFloat.setMonthCount(db, '2020-01', { transfer_count: 1 }, { actor: 'walter', now: NOW })
			const from = Math.floor(Date.UTC(2015, 0, 1) / 1000)
			const to = Math.floor(NOW.getTime() / 1000)
			const summary = goodsFloat.buildWindowSummary(db, {
				from,
				to,
				timeZone: 'UTC',
				now: NOW,
			})
			assert.ok(summary.window.months.length <= 3)
			assert.ok(summary.window.months.includes('2020-01'))
			assert.ok(summary.window.months.includes('2026-09'))
		} finally {
			db.close()
		}
	})

	await test('HTTP PUT then GET round-trips the count for the earnings window', async () => {
		const db = memoryDb()
		const app = express()
		app.use(express.json())
		app.use((req, _res, next) => {
			req.auth = { user: 'walter', role: 'owner' }
			next()
		})
		goodsFloat.installRoutes(app, {
			db,
			timeZone: 'Asia/Shanghai',
			now: () => NOW,
		})
		const server = http.createServer(app)
		await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
		const { port } = server.address()
		const base = `http://127.0.0.1:${port}`
		try {
			const put = await fetch(`${base}/api/finance/goods-float/2026-09`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ transfer_count: 6 }),
			})
			assert.equal(put.status, 200)
			const putBody = await put.json()
			assert.equal(putBody.ok, true)
			assert.equal(putBody.month.transfer_count, 6)
			assert.equal(putBody.summary.total_cents, 6 * 88800)
			assert.equal(put.headers.get('cache-control'), 'no-store')

			const from = Math.floor(new Date(2026, 8, 1).getTime() / 1000)
			const get = await fetch(`${base}/api/finance/goods-float?from=${from}`)
			assert.equal(get.status, 200)
			const got = await get.json()
			assert.equal(got.transfer_count, 6)
			assert.equal(got.months[0].period_ym, '2026-09')

			const stale = await fetch(`${base}/api/finance/goods-float/2026-09`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ transfer_count: 1, version: 0 }),
			})
			assert.equal(stale.status, 409)
			const conflict = await stale.json()
			assert.equal(conflict.code, 'GOODS_FLOAT_VERSION_CONFLICT')
			assert.equal(conflict.current.transfer_count, 6)

			const bump = await fetch(`${base}/api/finance/goods-float/2026-09/adjust`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ delta: 1, version: 1 }),
			})
			assert.equal(bump.status, 200)
			assert.equal((await bump.json()).month.transfer_count, 7)

			const bad = await fetch(`${base}/api/finance/goods-float/nope`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ transfer_count: 1 }),
			})
			assert.equal(bad.status, 400)
		} finally {
			await new Promise((resolve) => server.close(resolve))
			db.close()
		}
	})

	await test('WeChat bill classifier keeps the six 888-from-Walter wires and drops snacks', () => {
		const classified = wechatBill.selectFloatWires(wechatBill.screenshotFixtureFromWalterBill(), {
			timeZone: 'Asia/Shanghai',
		})
		assert.equal(classified.wires.length, 6)
		assert.equal(classified.ignored.length, 3)
		assert.deepEqual(
			classified.wires.map((row) => goodsFloat.formatLocalDateTime(row.transferred_at, 'Asia/Shanghai')),
			['2026-09-11 17:54', '2026-09-09 18:20', '2026-09-07 17:25', '2026-09-07 16:36', '2026-09-03 17:41', '2026-09-01 17:30'],
		)
		assert.ok(classified.ignored.every((item) => item.row && item.row.amount_cents !== 88800))
		assert.equal(classified.wires[0].payer_name, 'Walter')
		assert.equal(classified.wires[2].fingerprint !== classified.wires[3].fingerprint, true)
	})

	await test('overlapping WeChat bills collapse to eight unique 888 wires', () => {
		const classified = wechatBill.selectFloatWires(
			[...wechatBill.screenshotFixtureNewerWalterBill(), ...wechatBill.screenshotFixtureFromWalterBill()],
			{ timeZone: 'Asia/Shanghai' },
		)
		assert.equal(classified.wires.length, 8)
		assert.deepEqual(
			classified.wires.map((row) => goodsFloat.formatLocalDateTime(row.transferred_at, 'Asia/Shanghai')),
			[
				'2026-09-15 17:12',
				'2026-09-14 17:18',
				'2026-09-11 17:54',
				'2026-09-09 18:20',
				'2026-09-07 17:25',
				'2026-09-07 16:36',
				'2026-09-03 17:41',
				'2026-09-01 17:30',
			],
		)
		const fingerprints = new Set(classified.wires.map((row) => row.fingerprint))
		assert.equal(fingerprints.size, 8)
	})

	await test('employee +888 and owner −888 at the same minute share one fingerprint', () => {
		const incoming = wechatBill.normalizeBillRow(
			{ title: '转账-来自Walter', amount: '+888.00', raw_date: '2026年9月11日 17:54' },
			{ timeZone: 'Asia/Shanghai' },
		)
		const outgoing = wechatBill.normalizeBillRow(
			{ title: '转账-转给天生好运甜美鱼', amount: '-888.00', raw_date: '2026年9月11日 17:54' },
			{ timeZone: 'Asia/Shanghai' },
		)
		assert.equal(incoming.is_float_wire, true)
		assert.equal(outgoing.is_float_wire, true)
		assert.equal(incoming.fingerprint, outgoing.fingerprint)
		assert.equal(incoming.amount_cents, 88800)
		assert.equal(outgoing.direction, 'out')
	})

	await test('timed wires are the window total; leftover month counts only fill empty months', () => {
		const db = memoryDb()
		try {
			goodsFloat.setMonthCount(db, '2026-08', { transfer_count: 2 }, { actor: 'walter', now: NOW })
			const classified = wechatBill.selectFloatWires(wechatBill.screenshotFixtureFromWalterBill(), {
				timeZone: 'Asia/Shanghai',
			})
			for (const wire of classified.wires) {
				goodsFloat.createTransfer(
					db,
					{
						local_datetime: goodsFloat.formatLocalDateTime(wire.transferred_at, 'Asia/Shanghai'),
						title: wire.title,
						payer_name: wire.payer_name,
					},
					{ actor: 'walter', now: NOW, timeZone: 'Asia/Shanghai' },
				)
			}
			expectError(
				() => goodsFloat.setMonthCount(db, '2026-09', { transfer_count: 9 }, { actor: 'walter', now: NOW, timeZone: 'Asia/Shanghai' }),
				'GOODS_FLOAT_HAS_TIMED_TRANSFERS',
			)

			const mtdFrom = Math.floor(new Date('2026-09-01T00:00:00+08:00').getTime() / 1000)
			const mtd = goodsFloat.buildWindowSummary(db, {
				from: mtdFrom,
				to: Math.floor(NOW.getTime() / 1000),
				timeZone: 'Asia/Shanghai',
				now: NOW,
			})
			assert.equal(mtd.grain, 'timed_event')
			assert.equal(mtd.transfer_count, 6)
			assert.equal(mtd.total_cents, 6 * 88800)
			assert.equal(mtd.window.covers_partial_month, false)
			assert.equal(mtd.transfers.length, 6)
			assert.equal(mtd.transfers[0].local_datetime, '2026-09-11 17:54')
			assert.match(mtd.transfers[0].local_datetime_zh, /2026年9月11日/)

			const last7From = Math.floor(NOW.getTime() / 1000) - 7 * 86400
			const last7 = goodsFloat.buildWindowSummary(db, {
				from: last7From,
				to: Math.floor(NOW.getTime() / 1000),
				timeZone: 'Asia/Shanghai',
				now: NOW,
			})
			assert.equal(last7.transfer_count, 1)
			assert.equal(last7.transfers[0].local_datetime, '2026-09-11 17:54')

			const mixedFrom = Math.floor(new Date('2026-08-20T00:00:00+08:00').getTime() / 1000)
			const mixed = goodsFloat.buildWindowSummary(db, {
				from: mixedFrom,
				to: Math.floor(NOW.getTime() / 1000),
				timeZone: 'Asia/Shanghai',
				now: NOW,
			})
			assert.equal(mixed.grain, 'mixed')
			assert.equal(mixed.transfer_count, 8)
			const august = mixed.months.find((row) => row.period_ym === '2026-08')
			const september = mixed.months.find((row) => row.period_ym === '2026-09')
			assert.equal(august.source, 'month_count')
			assert.equal(august.transfer_count, 2)
			assert.equal(september.source, 'events')
			assert.equal(september.timed_locked, true)
			assert.equal(september.transfer_count, 6)
		} finally {
			db.close()
		}
	})

	await test('PATCH and DELETE update a dated wire without double-counting the minute', () => {
		const db = memoryDb()
		try {
			const created = goodsFloat.createTransfer(
				db,
				{ local_datetime: '2026年9月11日 17:54', payer_name: 'Walter' },
				{ actor: 'walter', now: NOW, timeZone: 'Asia/Shanghai' },
			)
			assert.equal(created.local_datetime, '2026-09-11 17:54')
			expectError(
				() =>
					goodsFloat.createTransfer(
						db,
						{ local_datetime: '2026-09-11 17:54', payer_name: 'Walter' },
						{ actor: 'walter', now: NOW, timeZone: 'Asia/Shanghai' },
					),
				'GOODS_FLOAT_DUPLICATE_TRANSFER',
			)
			const moved = goodsFloat.updateTransfer(
				db,
				created.id,
				{ local_datetime: '2026-09-11 18:01', version: created.version },
				{ actor: 'walter', now: NOW, timeZone: 'Asia/Shanghai' },
			)
			assert.equal(moved.unchanged, false)
			assert.equal(moved.transfer.local_datetime, '2026-09-11 18:01')
			assert.equal(moved.transfer.version, created.version + 1)
			goodsFloat.deleteTransfer(db, created.id)
			assert.equal(goodsFloat.listTransfersInWindow(db, { timeZone: 'Asia/Shanghai', now: NOW }).length, 0)
		} finally {
			db.close()
		}
	})

	await test('screenshot upload parses with an injected reader and import is idempotent', async () => {
		const db = memoryDb()
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ued-goods-float-'))
		const png = Buffer.from(
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
			'base64',
		)
		let extractCalls = 0
		const app = express()
		app.use(express.json({ limit: '2mb' }))
		app.use((req, _res, next) => {
			req.auth = { user: 'walter', role: 'owner' }
			next()
		})
		goodsFloat.installRoutes(app, {
			db,
			timeZone: 'Asia/Shanghai',
			now: () => NOW,
			screenshotsDir: tmp,
			extractBill: async () => {
				extractCalls += 1
				return { rows: wechatBill.screenshotFixtureFromWalterBill() }
			},
		})
		const server = http.createServer(app)
		await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
		const { port } = server.address()
		const base = `http://127.0.0.1:${port}`
		const payload = {
			image_b64: `data:image/png;base64,${png.toString('base64')}`,
			original_name: 'wechat-bill.png',
		}
		try {
			const parsed = await fetch(`${base}/api/finance/goods-float/screenshots`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload),
			})
			assert.equal(parsed.status, 200)
			const preview = await parsed.json()
			assert.equal(preview.ok, true)
			assert.equal(preview.auto_imported, true)
			assert.equal(preview.imported_count, 6)
			assert.equal(preview.wires.length, 6)
			assert.equal(preview.ignored_count, 3)
			assert.equal(preview.wires.every((row) => row.already_recorded === true), true)
			assert.equal(preview.summary.transfer_count, 6)
			assert.equal(extractCalls, 1)

			const again = await fetch(`${base}/api/finance/goods-float/screenshots`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload),
			})
			assert.equal(again.status, 200)
			const reused = await again.json()
			assert.equal(reused.reused, true)
			assert.equal(extractCalls, 1)

			const imported = await fetch(`${base}/api/finance/goods-float/screenshots/${preview.screenshot.id}/import`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			})
			assert.equal(imported.status, 200)
			const importedBody = await imported.json()
			assert.equal(importedBody.imported_count, 0)
			assert.equal(importedBody.summary.transfer_count, 6)
			assert.equal(importedBody.summary.transfers[0].local_datetime, '2026-09-11 17:54')

			const secondImport = await fetch(`${base}/api/finance/goods-float/screenshots/${preview.screenshot.id}/import`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			})
			assert.equal(secondImport.status, 200)
			assert.equal((await secondImport.json()).imported_count, 0)

			const image = await fetch(`${base}/api/finance/goods-float/screenshots/${preview.screenshot.id}/image`)
			assert.equal(image.status, 200)
			assert.match(image.headers.get('content-type'), /image\/png/)
			assert.equal(image.headers.get('x-content-type-options'), 'nosniff')
			assert.match(image.headers.get('cache-control') || '', /immutable/)

			assert.equal(importedBody.summary.screenshots.length, 1)
			assert.equal(importedBody.summary.screenshots[0].id, preview.screenshot.id)
			assert.equal(importedBody.summary.screenshots[0].transfer_count, 6)
			assert.match(importedBody.summary.screenshots[0].image_url, /\/image\?v=/)
			assert.match(importedBody.summary.transfers[0].image_url, /\/screenshots\/\d+\/image/)

			const listed = await fetch(`${base}/api/finance/goods-float/screenshots`)
			assert.equal(listed.status, 200)
			const listedBody = await listed.json()
			assert.equal(listedBody.screenshots.length, 1)
			assert.equal(listedBody.screenshots[0].id, preview.screenshot.id)

			const locked = await fetch(`${base}/api/finance/goods-float/2026-09`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ transfer_count: 1 }),
			})
			assert.equal(locked.status, 409)
			assert.equal((await locked.json()).code, 'GOODS_FLOAT_HAS_TIMED_TRANSFERS')

			for (const transfer of importedBody.summary.transfers) {
				const del = await fetch(`${base}/api/finance/goods-float/transfers/${transfer.id}`, { method: 'DELETE' })
				assert.equal(del.status, 200)
			}
			const stillListed = await fetch(`${base}/api/finance/goods-float/screenshots`)
			assert.equal((await stillListed.json()).screenshots.length, 1)
			const stillImage = await fetch(`${base}/api/finance/goods-float/screenshots/${preview.screenshot.id}/image`)
			assert.equal(stillImage.status, 200)
			const afterDelete = await fetch(`${base}/api/finance/goods-float`)
			const afterBody = await afterDelete.json()
			assert.equal(afterBody.transfers.length, 0)
			assert.equal(afterBody.screenshots.length, 1)
			assert.equal(afterBody.screenshots[0].transfer_count, 0)
		} finally {
			await new Promise((resolve) => server.close(resolve))
			db.close()
			fs.rmSync(tmp, { recursive: true, force: true })
		}
	})

	await test('batch upload merges overlapping bills into unique 888 wires', async () => {
		const db = memoryDb()
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ued-goods-float-batch-'))
		const pngA = Buffer.from(
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
			'base64',
		)
		const pngB = Buffer.from(
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADAgH/pK3L4wAAAABJRU5ErkJggg==',
			'base64',
		)
		assert.equal(pngA.equals(pngB), false)
		const app = express()
		app.use(express.json({ limit: '2mb' }))
		app.use((req, _res, next) => {
			req.auth = { user: 'walter', role: 'owner' }
			next()
		})
		goodsFloat.installRoutes(app, {
			db,
			timeZone: 'Asia/Shanghai',
			now: () => NOW,
			screenshotsDir: tmp,
			extractBill: async ({ originalName }) => {
				const name = String(originalName || '')
				if (name.includes('newer')) return { rows: wechatBill.screenshotFixtureNewerWalterBill() }
				return { rows: wechatBill.screenshotFixtureFromWalterBill() }
			},
		})
		const server = http.createServer(app)
		await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
		const { port } = server.address()
		const base = `http://127.0.0.1:${port}`
		try {
			const parsed = await fetch(`${base}/api/finance/goods-float/screenshots`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					images: [
						{
							image_b64: `data:image/png;base64,${pngA.toString('base64')}`,
							original_name: 'wechat-newer.png',
						},
						{
							image_b64: `data:image/png;base64,${pngB.toString('base64')}`,
							original_name: 'wechat-older.png',
						},
					],
				}),
			})
			assert.equal(parsed.status, 200)
			const preview = await parsed.json()
			assert.equal(preview.ok, true)
			assert.equal(preview.auto_imported, true)
			assert.equal(preview.imported_count, 8)
			assert.equal(preview.screenshots.length, 2)
			assert.equal(preview.screenshot_ids.length, 2)
			assert.equal(preview.wires.length, 8)
			assert.deepEqual(
				preview.wires.map((row) => row.local_datetime),
				[
					'2026-09-15 17:12',
					'2026-09-14 17:18',
					'2026-09-11 17:54',
					'2026-09-09 18:20',
					'2026-09-07 17:25',
					'2026-09-07 16:36',
					'2026-09-03 17:41',
					'2026-09-01 17:30',
				],
			)
			const overlap = preview.wires.find((row) => row.local_datetime === '2026-09-11 17:54')
			assert.ok(overlap)
			assert.equal(overlap.seen_on_bills, 2)
			assert.equal(overlap.screenshot_ids.length, 2)
			assert.equal(preview.wires.filter((row) => row.seen_on_bills === 2).length, 4)
			assert.equal(preview.summary.transfer_count, 8)
			const overlapSaved = preview.summary.transfers.find((row) => row.local_datetime === '2026-09-11 17:54')
			assert.ok(overlapSaved)
			assert.equal(overlapSaved.screenshot_ids.length, 2)
			assert.equal(new Set(preview.summary.transfers.map((row) => row.fingerprint)).size, 8)
			assert.equal(
				preview.summary.screenshots.every((shot) => Number(shot.transfer_count) === 6),
				true,
			)

			const imported = await fetch(`${base}/api/finance/goods-float/screenshots/import`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ screenshot_ids: preview.screenshot_ids }),
			})
			assert.equal(imported.status, 200)
			const importedBody = await imported.json()
			assert.equal(importedBody.imported_count, 0)
			assert.equal(importedBody.summary.transfer_count, 8)

			const newerId = preview.screenshot_ids[0]
			const olderId = preview.screenshot_ids[1]
			const removed = await fetch(`${base}/api/finance/goods-float/screenshots/${newerId}`, { method: 'DELETE' })
			assert.equal(removed.status, 200)
			const removedBody = await removed.json()
			assert.ok(removedBody.deleted_transfer_count >= 2)
			assert.equal(removedBody.summary.screenshots.some((shot) => Number(shot.id) === Number(newerId)), false)
			assert.equal(removedBody.summary.screenshots.some((shot) => Number(shot.id) === Number(olderId)), true)
			assert.equal(removedBody.summary.transfer_count, 6)
			const stillOverlap = removedBody.summary.transfers.find((row) => row.local_datetime === '2026-09-11 17:54')
			assert.ok(stillOverlap)
			assert.equal(stillOverlap.screenshot_ids.includes(Number(olderId)), true)
			assert.equal(stillOverlap.screenshot_ids.includes(Number(newerId)), false)
			assert.equal(
				removedBody.summary.transfers.some((row) => row.local_datetime === '2026-09-15 17:12'),
				false,
			)

			const gone = await fetch(`${base}/api/finance/goods-float/screenshots/${newerId}/image`)
			assert.equal(gone.status, 404)
		} finally {
			await new Promise((resolve) => server.close(resolve))
			db.close()
			fs.rmSync(tmp, { recursive: true, force: true })
		}
	})

	await test('parsed bills that never got imported recover without re-uploading', async () => {
		const db = memoryDb()
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ued-goods-float-pending-'))
		const app = express()
		app.use(express.json({ limit: '2mb' }))
		app.use((req, _res, next) => {
			req.auth = { user: 'walter', role: 'owner' }
			next()
		})
		goodsFloat.installRoutes(app, {
			db,
			timeZone: 'Asia/Shanghai',
			now: () => NOW,
			screenshotsDir: tmp,
		})
		const server = http.createServer(app)
		await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
		const { port } = server.address()
		const base = `http://127.0.0.1:${port}`
		const hash = 'ab'.repeat(32)
		const changedAt = Math.floor(NOW.getTime() / 1000)
		try {
			db.prepare(
				`
				INSERT INTO goods_float_screenshots (
					sha256, mime, byte_size, original_name, stored_name, extracted_json,
					status, error, created_by, created_at, parsed_at, imported_at
				) VALUES (?, 'image/png', 12, 'stuck.png', ?, ?, 'parsed', '', 'walter', ?, ?, NULL)
			`,
			).run(
				hash,
				`${hash}.png`,
				JSON.stringify({ rows: wechatBill.screenshotFixtureFromWalterBill() }),
				changedAt,
				changedAt,
			)
			const listed = await fetch(`${base}/api/finance/goods-float`)
			assert.equal(listed.status, 200)
			const listedBody = await listed.json()
			assert.equal(listedBody.transfer_count, 0)
			assert.equal(listedBody.screenshots[0].status, 'parsed')
			assert.equal(listedBody.screenshots[0].pending, true)
			assert.equal(listedBody.screenshots[0].wire_count, 6)

			const recovered = await fetch(`${base}/api/finance/goods-float/screenshots/import`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			})
			assert.equal(recovered.status, 200)
			const recoveredBody = await recovered.json()
			assert.equal(recoveredBody.imported_count, 6)
			assert.equal(recoveredBody.summary.transfer_count, 6)
			assert.equal(recoveredBody.summary.screenshots[0].status, 'imported')
		} finally {
			await new Promise((resolve) => server.close(resolve))
			db.close()
			fs.rmSync(tmp, { recursive: true, force: true })
		}
	})

	await test('failed reads stay on the gallery and can be retried or deleted', async () => {
		const db = memoryDb()
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ued-goods-float-retry-'))
		const png = Buffer.from(
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
			'base64',
		)
		let shouldFail = true
		const app = express()
		app.use(express.json({ limit: '2mb' }))
		app.use((req, _res, next) => {
			req.auth = { user: 'walter', role: 'owner' }
			next()
		})
		goodsFloat.installRoutes(app, {
			db,
			timeZone: 'Asia/Shanghai',
			now: () => NOW,
			screenshotsDir: tmp,
			extractBill: async () => {
				if (shouldFail) {
					const error = new Error('vision down')
					error.status = 502
					throw error
				}
				return { rows: wechatBill.screenshotFixtureFromWalterBill() }
			},
		})
		const server = http.createServer(app)
		await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
		const { port } = server.address()
		const base = `http://127.0.0.1:${port}`
		try {
			const failed = await fetch(`${base}/api/finance/goods-float/screenshots`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ image_b64: `data:image/png;base64,${png.toString('base64')}` }),
			})
			assert.equal(failed.status, 502)
			const listed = await fetch(`${base}/api/finance/goods-float`)
			const listedBody = await listed.json()
			assert.equal(listedBody.screenshots.length, 1)
			assert.equal(listedBody.screenshots[0].status, 'failed')
			assert.equal(listedBody.transfer_count, 0)
			const shotId = listedBody.screenshots[0].id

			shouldFail = false
			const retried = await fetch(`${base}/api/finance/goods-float/screenshots/${shotId}/retry`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: '{}',
			})
			assert.equal(retried.status, 200)
			const retriedBody = await retried.json()
			assert.equal(retriedBody.imported_count, 6)
			assert.equal(retriedBody.summary.transfer_count, 6)

			const removed = await fetch(`${base}/api/finance/goods-float/screenshots/${shotId}`, { method: 'DELETE' })
			assert.equal(removed.status, 200)
			const removedBody = await removed.json()
			assert.equal(removedBody.deleted_transfer_count, 6)
			const after = await fetch(`${base}/api/finance/goods-float`)
			const afterBody = await after.json()
			assert.equal(afterBody.screenshots.length, 0)
			assert.equal(afterBody.transfer_count, 0)
		} finally {
			await new Promise((resolve) => server.close(resolve))
			db.close()
			fs.rmSync(tmp, { recursive: true, force: true })
		}
	})

	if (failures) {
		console.error(`\n${failures} goods-float test(s) failed`)
		process.exit(1)
	}
	console.log('\nAll goods-float tests passed')
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
