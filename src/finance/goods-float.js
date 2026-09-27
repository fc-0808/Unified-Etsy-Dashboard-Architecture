'use strict'

/**
 * Manufacturer shopping float — cost of goods on the Earnings tab.
 *
 * The owner (Walter) wires a fixed RMB amount (¥888) to the in-person shopper
 * each time she runs out of cash at the manufacturers. That cash is COGS: it is
 * not an Etsy ledger line and it is not 4PX freight.
 *
 * Source of truth is the timed wire: unix seconds in the business timezone
 * (Asia/Shanghai, same frame as the operations checklist). A WeChat 账单
 * screenshot is transcribed by vision, then a deterministic classifier keeps
 * only the 888-from-Walter / 888-to-shopper rows and fingerprints each one at
 * minute+amount so the employee's "+888 来自Walter" and Walter's own
 * "−888 转给采购员" collapse to one event.
 *
 * Calendar-month counts remain as a fallback for months that have no timed
 * events yet (the original stepper). The moment a month has even one dated
 * wire, that month's stepper is locked and the Earnings window counts only
 * events whose transferred_at falls inside [from, to].
 *
 * The float is portfolio-level. It is not allocated across shops — there is
 * no honest key to do that — so a single-shop Earnings filter still lets the
 * owner edit, but must not subtract the whole company float from that shop's net.
 */

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const wechatBill = require('./wechat-bill')
const wechatBillVision = require('./wechat-bill-vision')
const { safeStoredImageMime, sendStoredImage } = require('../route/stored-image-security')

const DEFAULT_TIME_ZONE = 'Asia/Shanghai'
const CURRENCY = 'CNY'
const DEFAULT_AMOUNT_CNY_CENTS = 88800
const MAX_TRANSFER_COUNT = 999
const MAX_AMOUNT_CNY_CENTS = 10_000_00
const MAX_NOTE_LENGTH = 280
const MAX_ACTOR_LENGTH = 80
const MAX_NAME_LENGTH = 80
const MAX_VIRTUAL_MONTHS = 36
const MAX_REVISIONS_IN_PAYLOAD = 20
const MAX_TRANSFERS_IN_PAYLOAD = 250
const MAX_WIRES_PER_SCREENSHOT = 80
const MAX_SCREENSHOTS_IN_PAYLOAD = 100
const MAX_BATCH_IMAGES = 12
const MAX_IMAGE_BYTES = 12 * 1024 * 1024
const SCREENSHOT_CACHE_CONTROL = 'private, max-age=31536000, immutable'
const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/
const SOURCE_MANUAL = 'manual'
const SOURCE_SCREENSHOT = 'screenshot'

class GoodsFloatError extends Error {
	constructor(message, { status = 400, code = 'INVALID_GOODS_FLOAT', field = null, current = null } = {}) {
		super(message)
		this.name = 'GoodsFloatError'
		this.status = status
		this.code = code
		this.field = field
		this.current = current
	}
}

function ensureSchema(db) {
	if (!db || typeof db.exec !== 'function') {
		throw new TypeError('A SQLite database is required.')
	}
	db.exec(`
		CREATE TABLE IF NOT EXISTS goods_float_months (
			period_ym                  TEXT    PRIMARY KEY,
			transfer_count             INTEGER NOT NULL DEFAULT 0,
			amount_per_transfer_cents  INTEGER NOT NULL DEFAULT 88800,
			currency                   TEXT    NOT NULL DEFAULT 'CNY',
			note                       TEXT    NOT NULL DEFAULT '',
			updated_by                 TEXT    NOT NULL DEFAULT '',
			created_at                 INTEGER NOT NULL,
			updated_at                 INTEGER NOT NULL,
			version                    INTEGER NOT NULL DEFAULT 1,
			CHECK (period_ym GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
			CHECK (transfer_count >= 0 AND transfer_count <= 999),
			CHECK (amount_per_transfer_cents >= 1 AND amount_per_transfer_cents <= 1000000),
			CHECK (currency = 'CNY'),
			CHECK (length(note) <= 280),
			CHECK (length(updated_by) <= 80),
			CHECK (version >= 1)
		);
		CREATE TABLE IF NOT EXISTS goods_float_revisions (
			id                         INTEGER PRIMARY KEY AUTOINCREMENT,
			period_ym                  TEXT    NOT NULL,
			prev_count                 INTEGER,
			next_count                 INTEGER NOT NULL,
			prev_amount_cents          INTEGER,
			next_amount_cents          INTEGER NOT NULL,
			note                       TEXT    NOT NULL DEFAULT '',
			changed_by                 TEXT    NOT NULL DEFAULT '',
			changed_at                 INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_goods_float_revisions_period
			ON goods_float_revisions(period_ym, changed_at DESC, id DESC);

		CREATE TABLE IF NOT EXISTS goods_float_screenshots (
			id              INTEGER PRIMARY KEY AUTOINCREMENT,
			sha256          TEXT    NOT NULL,
			mime            TEXT    NOT NULL,
			byte_size       INTEGER NOT NULL,
			original_name   TEXT    NOT NULL DEFAULT '',
			stored_name     TEXT    NOT NULL,
			extracted_json  TEXT    NOT NULL DEFAULT '',
			status          TEXT    NOT NULL DEFAULT 'uploaded',
			error           TEXT    NOT NULL DEFAULT '',
			created_by      TEXT    NOT NULL DEFAULT '',
			created_at      INTEGER NOT NULL,
			parsed_at       INTEGER,
			imported_at     INTEGER,
			CHECK (length(sha256) = 64),
			CHECK (byte_size > 0),
			CHECK (status IN ('uploaded', 'parsed', 'imported', 'failed')),
			CHECK (length(original_name) <= 180),
			CHECK (length(created_by) <= 80)
		);
		CREATE UNIQUE INDEX IF NOT EXISTS idx_goods_float_screenshots_sha256
			ON goods_float_screenshots(sha256);

		CREATE TABLE IF NOT EXISTS goods_float_transfers (
			id              INTEGER PRIMARY KEY AUTOINCREMENT,
			transferred_at  INTEGER NOT NULL,
			amount_cents    INTEGER NOT NULL DEFAULT 88800,
			currency        TEXT    NOT NULL DEFAULT 'CNY',
			payer_name      TEXT    NOT NULL DEFAULT 'Walter',
			payee_name      TEXT    NOT NULL DEFAULT '',
			source          TEXT    NOT NULL DEFAULT 'manual',
			fingerprint     TEXT    NOT NULL,
			screenshot_id   INTEGER,
			title           TEXT    NOT NULL DEFAULT '',
			note            TEXT    NOT NULL DEFAULT '',
			created_by      TEXT    NOT NULL DEFAULT '',
			updated_by      TEXT    NOT NULL DEFAULT '',
			created_at      INTEGER NOT NULL,
			updated_at      INTEGER NOT NULL,
			version         INTEGER NOT NULL DEFAULT 1,
			CHECK (amount_cents >= 1 AND amount_cents <= 1000000),
			CHECK (currency = 'CNY'),
			CHECK (source IN ('manual', 'screenshot')),
			CHECK (length(fingerprint) > 0 AND length(fingerprint) <= 80),
			CHECK (length(payer_name) <= 80),
			CHECK (length(payee_name) <= 80),
			CHECK (length(title) <= 180),
			CHECK (length(note) <= 280),
			CHECK (length(created_by) <= 80),
			CHECK (length(updated_by) <= 80),
			CHECK (version >= 1)
		);
		CREATE UNIQUE INDEX IF NOT EXISTS idx_goods_float_transfers_fingerprint
			ON goods_float_transfers(fingerprint);
		CREATE INDEX IF NOT EXISTS idx_goods_float_transfers_at
			ON goods_float_transfers(transferred_at DESC, id DESC);
		CREATE INDEX IF NOT EXISTS idx_goods_float_transfers_screenshot
			ON goods_float_transfers(screenshot_id);
		CREATE TABLE IF NOT EXISTS goods_float_transfer_screenshots (
			transfer_id    INTEGER NOT NULL,
			screenshot_id  INTEGER NOT NULL,
			PRIMARY KEY (transfer_id, screenshot_id)
		);
		CREATE INDEX IF NOT EXISTS idx_goods_float_transfer_screenshots_shot
			ON goods_float_transfer_screenshots(screenshot_id);
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

function asDate(now) {
	if (now instanceof Date) {
		if (!Number.isFinite(now.getTime())) {
			throw new GoodsFloatError('The goods-float clock is invalid.', {
				status: 500,
				code: 'INVALID_GOODS_FLOAT_CLOCK',
			})
		}
		return now
	}
	if (now == null) return new Date()
	const date = new Date(now)
	if (!Number.isFinite(date.getTime())) {
		throw new GoodsFloatError('The goods-float clock is invalid.', {
			status: 500,
			code: 'INVALID_GOODS_FLOAT_CLOCK',
		})
	}
	return date
}

function unixSeconds(now) {
	return Math.floor(asDate(now).getTime() / 1000)
}

function datePartsInTimeZone(date, timeZone) {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone: normalizeTimeZone(timeZone),
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hourCycle: 'h23',
	}).formatToParts(asDate(date))
	const pick = (type) => parts.find((entry) => entry.type === type)?.value
	let hour = Number(pick('hour'))
	if (hour === 24) hour = 0
	return {
		year: Number(pick('year')),
		month: Number(pick('month')),
		day: Number(pick('day')),
		hour,
		minute: Number(pick('minute')),
		second: Number(pick('second')),
	}
}

function periodYmFromDate(date, timeZone = DEFAULT_TIME_ZONE) {
	const parts = datePartsInTimeZone(date, timeZone)
	return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}`
}

function periodYmFromUnix(unixSecondsValue, timeZone = DEFAULT_TIME_ZONE) {
	const seconds = Number(unixSecondsValue)
	if (!Number.isFinite(seconds)) {
		throw new GoodsFloatError('A unix timestamp is required.', {
			code: 'INVALID_GOODS_FLOAT_TIME',
		})
	}
	return periodYmFromDate(new Date(seconds * 1000), timeZone)
}

function dateKeyFromUnix(unixSecondsValue, timeZone = DEFAULT_TIME_ZONE) {
	const parts = datePartsInTimeZone(new Date(Number(unixSecondsValue) * 1000), timeZone)
	return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

function formatLocalDateTime(unixSecondsValue, timeZone = DEFAULT_TIME_ZONE) {
	const parts = datePartsInTimeZone(new Date(Number(unixSecondsValue) * 1000), timeZone)
	const pad = (n) => String(n).padStart(2, '0')
	return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`
}

function formatLocalDateTimeZh(unixSecondsValue, timeZone = DEFAULT_TIME_ZONE) {
	const parts = datePartsInTimeZone(new Date(Number(unixSecondsValue) * 1000), timeZone)
	const pad = (n) => String(n).padStart(2, '0')
	return `${parts.year}年${parts.month}月${parts.day}日 ${pad(parts.hour)}:${pad(parts.minute)}`
}

function parsePeriodYm(value, field = 'period_ym') {
	const key = String(value || '').trim()
	if (!PERIOD_RE.test(key)) {
		throw new GoodsFloatError(`${field} must use YYYY-MM format.`, {
			code: 'INVALID_GOODS_FLOAT_PERIOD',
			field,
		})
	}
	const year = Number(key.slice(0, 4))
	const month = Number(key.slice(5, 7))
	if (year < 2000 || year > 2100) {
		throw new GoodsFloatError(`${field} is outside the supported year range.`, {
			code: 'INVALID_GOODS_FLOAT_PERIOD',
			field,
		})
	}
	return { period_ym: key, year, month }
}

function lastDateKeyOfMonth(periodYm) {
	const { year, month } = parsePeriodYm(periodYm)
	const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
	return `${periodYm}-${String(lastDay).padStart(2, '0')}`
}

function monthIndex(periodYm) {
	const { year, month } = parsePeriodYm(periodYm)
	return year * 12 + month
}

function periodYmFromIndex(index) {
	const year = Math.floor((index - 1) / 12)
	const month = index - year * 12
	return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`
}

function compareYm(a, b) {
	return monthIndex(a) - monthIndex(b)
}

function enumerateMonths(startYm, endYm) {
	const start = monthIndex(startYm)
	const end = monthIndex(endYm)
	if (end < start) return []
	const out = []
	for (let index = start; index <= end; index++) out.push(periodYmFromIndex(index))
	return out
}

function monthStartUnix(periodYm, timeZone = DEFAULT_TIME_ZONE) {
	const { year, month } = parsePeriodYm(periodYm)
	const unix = wechatBill.unixFromZonedLocal({ year, month, day: 1, hour: 0, minute: 0, second: 0 }, timeZone)
	if (unix == null) {
		throw new GoodsFloatError('Could not resolve the month start.', {
			status: 500,
			code: 'INVALID_GOODS_FLOAT_TIME',
			field: 'period_ym',
		})
	}
	return unix
}

function monthEndUnix(periodYm, timeZone = DEFAULT_TIME_ZONE) {
	const { year, month } = parsePeriodYm(periodYm)
	const nextMonth = month === 12 ? 1 : month + 1
	const nextYear = month === 12 ? year + 1 : year
	const unix = wechatBill.unixFromZonedLocal(
		{ year: nextYear, month: nextMonth, day: 1, hour: 0, minute: 0, second: 0 },
		timeZone,
	)
	if (unix == null) {
		throw new GoodsFloatError('Could not resolve the month end.', {
			status: 500,
			code: 'INVALID_GOODS_FLOAT_TIME',
			field: 'period_ym',
		})
	}
	return unix
}

function parseUnixQuery(value, field) {
	if (value == null || value === '') return undefined
	if (typeof value === 'number') {
		if (!Number.isInteger(value)) {
			throw new GoodsFloatError(`${field} must be a unix timestamp in seconds.`, {
				code: 'INVALID_GOODS_FLOAT_TIME',
				field,
			})
		}
		return value
	}
	const raw = String(value).trim()
	if (raw === '') return undefined
	if (!/^-?\d+$/.test(raw)) {
		throw new GoodsFloatError(`${field} must be a unix timestamp in seconds.`, {
			code: 'INVALID_GOODS_FLOAT_TIME',
			field,
		})
	}
	return Number(raw)
}

function parseBoundedInt(value, { field, min, max, required = true } = {}) {
	if (value == null || value === '') {
		if (required) {
			throw new GoodsFloatError(`${field} is required.`, {
				code: 'INVALID_GOODS_FLOAT_NUMBER',
				field,
			})
		}
		return undefined
	}
	let parsed
	if (typeof value === 'number') {
		parsed = value
	} else if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
		parsed = Number(value.trim())
	} else {
		throw new GoodsFloatError(`${field} must be an integer.`, {
			code: 'INVALID_GOODS_FLOAT_NUMBER',
			field,
		})
	}
	if (!Number.isInteger(parsed)) {
		throw new GoodsFloatError(`${field} must be an integer.`, {
			code: 'INVALID_GOODS_FLOAT_NUMBER',
			field,
		})
	}
	if (parsed < min || parsed > max) {
		throw new GoodsFloatError(`${field} must be between ${min} and ${max}.`, {
			code: 'GOODS_FLOAT_OUT_OF_RANGE',
			field,
		})
	}
	return parsed
}

function parsePositiveId(value, field = 'id') {
	const parsed = parseBoundedInt(value, { field, min: 1, max: Number.MAX_SAFE_INTEGER })
	return parsed
}

function sanitizeNote(value) {
	if (value == null) return undefined
	const note = String(value)
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
		.trim()
	if (note.length > MAX_NOTE_LENGTH) {
		throw new GoodsFloatError(`note must be at most ${MAX_NOTE_LENGTH} characters.`, {
			code: 'INVALID_GOODS_FLOAT_NOTE',
			field: 'note',
		})
	}
	return note
}

function sanitizeActor(value) {
	const actor = String(value || '')
		.replace(/[\u0000-\u001F\u007F]/g, '')
		.trim()
		.slice(0, MAX_ACTOR_LENGTH)
	return actor || 'owner'
}

function sanitizeName(value, field, { fallback = '' } = {}) {
	if (value == null) return fallback
	const name = String(value)
		.replace(/[\u0000-\u001F\u007F]/g, '')
		.trim()
		.slice(0, MAX_NAME_LENGTH)
	return name || fallback
}

function sanitizeTitle(value) {
	return String(value || '')
		.replace(/[\u0000-\u001F\u007F]/g, '')
		.trim()
		.slice(0, 180)
}

function totalCents(count, amountPerTransferCents) {
	return count * amountPerTransferCents
}

function virtualMonth(periodYm, defaults = {}) {
	const amount = defaults.amount_per_transfer_cents || DEFAULT_AMOUNT_CNY_CENTS
	const count = 0
	return {
		period_ym: periodYm,
		transfer_count: count,
		amount_per_transfer_cents: amount,
		currency: CURRENCY,
		total_cents: 0,
		note: '',
		updated_by: '',
		created_at: null,
		updated_at: null,
		version: 0,
		stored: false,
		source: 'empty',
		event_count: 0,
		timed_locked: false,
	}
}

function shapeMonth(row, extras = {}) {
	if (!row) return null
	const transfer_count = extras.transfer_count != null ? extras.transfer_count : Number(row.transfer_count) || 0
	const amount_per_transfer_cents = Number(row.amount_per_transfer_cents) || DEFAULT_AMOUNT_CNY_CENTS
	return {
		period_ym: row.period_ym,
		transfer_count,
		amount_per_transfer_cents,
		currency: row.currency || CURRENCY,
		total_cents: totalCents(transfer_count, amount_per_transfer_cents),
		note: row.note || '',
		updated_by: row.updated_by || '',
		created_at: row.created_at ?? null,
		updated_at: row.updated_at ?? null,
		version: Number(row.version) || 0,
		stored: true,
		source: extras.source || 'month_count',
		event_count: extras.event_count || 0,
		timed_locked: extras.timed_locked === true,
	}
}

function getMonth(db, periodYm) {
	const { period_ym } = parsePeriodYm(periodYm)
	const row = db
		.prepare(
			`
			SELECT period_ym, transfer_count, amount_per_transfer_cents, currency,
			       note, updated_by, created_at, updated_at, version
			FROM goods_float_months
			WHERE period_ym = ?
		`,
		)
		.get(period_ym)
	return row ? shapeMonth(row) : virtualMonth(period_ym)
}

function listStoredMonths(db) {
	return db
		.prepare(
			`
			SELECT period_ym, transfer_count, amount_per_transfer_cents, currency,
			       note, updated_by, created_at, updated_at, version
			FROM goods_float_months
			ORDER BY period_ym ASC
		`,
		)
		.all()
		.map((row) => shapeMonth(row))
}

function listRevisions(db, periodYm, { limit = MAX_REVISIONS_IN_PAYLOAD } = {}) {
	const { period_ym } = parsePeriodYm(periodYm)
	const take = Math.min(Math.max(Number(limit) || MAX_REVISIONS_IN_PAYLOAD, 1), 100)
	return db
		.prepare(
			`
			SELECT id, period_ym, prev_count, next_count, prev_amount_cents, next_amount_cents,
			       note, changed_by, changed_at
			FROM goods_float_revisions
			WHERE period_ym = ?
			ORDER BY changed_at DESC, id DESC
			LIMIT ?
		`,
		)
		.all(period_ym, take)
}

function listEventPeriodKeys(db, timeZone) {
	const zone = normalizeTimeZone(timeZone)
	const rows = db.prepare('SELECT DISTINCT transferred_at FROM goods_float_transfers').all()
	const keys = new Set()
	for (const row of rows) keys.add(periodYmFromUnix(row.transferred_at, zone))
	return [...keys].sort(compareYm)
}

function countTransfersInMonth(db, periodYm, timeZone) {
	const start = monthStartUnix(periodYm, timeZone)
	const end = monthEndUnix(periodYm, timeZone)
	const row = db
		.prepare(
			`
			SELECT COUNT(*) AS n
			FROM goods_float_transfers
			WHERE transferred_at >= ? AND transferred_at < ?
		`,
		)
		.get(start, end)
	return Number(row && row.n) || 0
}

function listTransfersBetween(db, startUnix, endUnixExclusive) {
	return db
		.prepare(
			`
			SELECT id, transferred_at, amount_cents, currency, payer_name, payee_name,
			       source, fingerprint, screenshot_id, title, note,
			       created_by, updated_by, created_at, updated_at, version
			FROM goods_float_transfers
			WHERE transferred_at >= ? AND transferred_at < ?
			ORDER BY transferred_at DESC, id DESC
		`,
		)
		.all(startUnix, endUnixExclusive)
}

function listTransfersInWindow(db, { from, to, timeZone, now, limit = MAX_TRANSFERS_IN_PAYLOAD } = {}) {
	const zone = normalizeTimeZone(timeZone)
	const endUnix = to != null ? to : unixSeconds(now)
	const take = Math.min(Math.max(Number(limit) || MAX_TRANSFERS_IN_PAYLOAD, 1), 1000)
	const rows =
		from == null
			? db
					.prepare(
						`
				SELECT id, transferred_at, amount_cents, currency, payer_name, payee_name,
				       source, fingerprint, screenshot_id, title, note,
				       created_by, updated_by, created_at, updated_at, version
				FROM goods_float_transfers
				WHERE transferred_at <= ?
				ORDER BY transferred_at DESC, id DESC
				LIMIT ?
			`,
					)
					.all(endUnix, take)
			: db
					.prepare(
						`
				SELECT id, transferred_at, amount_cents, currency, payer_name, payee_name,
				       source, fingerprint, screenshot_id, title, note,
				       created_by, updated_by, created_at, updated_at, version
				FROM goods_float_transfers
				WHERE transferred_at >= ? AND transferred_at <= ?
				ORDER BY transferred_at DESC, id DESC
				LIMIT ?
			`,
					)
					.all(from, endUnix, take)
	const transfers = rows.map((row) => shapeTransfer(row, zone))
	const linked = screenshotIdsByTransferIds(db, transfers)
	return transfers.map((transfer) => withScreenshotLinks(db, transfer, linked.get(transfer.id)))
}

function uniquePositiveIds(values) {
	const ids = []
	const seen = new Set()
	for (const value of Array.isArray(values) ? values : []) {
		const id = Number(value)
		if (!Number.isInteger(id) || id < 1 || seen.has(id)) continue
		seen.add(id)
		ids.push(id)
	}
	return ids
}

function screenshotIdsForTransfer(db, transferId, fallbackId) {
	const rows = db
		.prepare(
			`
			SELECT screenshot_id
			FROM goods_float_transfer_screenshots
			WHERE transfer_id = ?
			ORDER BY screenshot_id
		`,
		)
		.all(Number(transferId))
	return mergeScreenshotIds(
		rows.map((row) => Number(row.screenshot_id)),
		fallbackId,
	)
}

function screenshotIdsByTransferIds(db, transfers) {
	const map = new Map()
	const ids = uniquePositiveIds((transfers || []).map((row) => row && row.id))
	if (!ids.length) return map
	const rows = db
		.prepare(
			`
			SELECT transfer_id, screenshot_id
			FROM goods_float_transfer_screenshots
			WHERE transfer_id IN (${ids.map(() => '?').join(',')})
			ORDER BY screenshot_id
		`,
		)
		.all(...ids)
	for (const row of rows) {
		const transferId = Number(row.transfer_id)
		if (!map.has(transferId)) map.set(transferId, [])
		map.get(transferId).push(Number(row.screenshot_id))
	}
	return map
}

function mergeScreenshotIds(linkedIds, fallbackId) {
	const ids = uniquePositiveIds(linkedIds)
	const fallback = Number(fallbackId)
	if (Number.isInteger(fallback) && fallback > 0 && !ids.includes(fallback)) ids.unshift(fallback)
	return ids
}

function withScreenshotLinks(db, transfer, linkedIds) {
	if (!transfer) return transfer
	const ids = mergeScreenshotIds(
		Array.isArray(linkedIds) ? linkedIds : screenshotIdsForTransfer(db, transfer.id, transfer.screenshot_id),
		transfer.screenshot_id,
	)
	transfer.screenshot_ids = ids
	if (!transfer.image_url && ids[0]) {
		transfer.image_url = `/api/finance/goods-float/screenshots/${ids[0]}/image?v=${ids[0]}`
	}
	return transfer
}

function getTransfer(db, id, timeZone = DEFAULT_TIME_ZONE) {
	const row = db
		.prepare(
			`
			SELECT id, transferred_at, amount_cents, currency, payer_name, payee_name,
			       source, fingerprint, screenshot_id, title, note,
			       created_by, updated_by, created_at, updated_at, version
			FROM goods_float_transfers
			WHERE id = ?
		`,
		)
		.get(parsePositiveId(id, 'transfer_id'))
	if (!row) {
		throw new GoodsFloatError('That transfer was not found.', {
			status: 404,
			code: 'GOODS_FLOAT_TRANSFER_NOT_FOUND',
			field: 'id',
		})
	}
	return withScreenshotLinks(db, shapeTransfer(row, timeZone))
}

function shapeTransfer(row, timeZone = DEFAULT_TIME_ZONE) {
	if (!row) return null
	const zone = normalizeTimeZone(timeZone)
	const transferred_at = Number(row.transferred_at)
	return {
		id: Number(row.id),
		transferred_at,
		local_datetime: formatLocalDateTime(transferred_at, zone),
		local_datetime_zh: formatLocalDateTimeZh(transferred_at, zone),
		date_key: dateKeyFromUnix(transferred_at, zone),
		period_ym: periodYmFromUnix(transferred_at, zone),
		amount_cents: Number(row.amount_cents) || DEFAULT_AMOUNT_CNY_CENTS,
		currency: row.currency || CURRENCY,
		payer_name: row.payer_name || 'Walter',
		payee_name: row.payee_name || '',
		source: row.source || SOURCE_MANUAL,
		fingerprint: row.fingerprint,
		screenshot_id: row.screenshot_id == null ? null : Number(row.screenshot_id),
		screenshot_ids: [],
		image_url:
			row.screenshot_id == null
				? null
				: `/api/finance/goods-float/screenshots/${Number(row.screenshot_id)}/image?v=${Number(row.screenshot_id)}`,
		title: row.title || '',
		note: row.note || '',
		created_by: row.created_by || '',
		updated_by: row.updated_by || '',
		created_at: row.created_at ?? null,
		updated_at: row.updated_at ?? null,
		version: Number(row.version) || 0,
	}
}

function resolveTransferredAt(body, timeZone) {
	const zone = normalizeTimeZone(timeZone)
	if (body.local_datetime != null && String(body.local_datetime).trim()) {
		const unix = wechatBill.parseWeChatDateTime(body.local_datetime, zone)
		if (unix == null) {
			throw new GoodsFloatError('local_datetime could not be read. Use YYYY-MM-DD HH:mm or 2026年9月11日 17:54.', {
				code: 'INVALID_GOODS_FLOAT_TIME',
				field: 'local_datetime',
			})
		}
		return unix
	}
	if (body.transferred_at != null && body.transferred_at !== '') {
		const unix = wechatBill.parseWeChatDateTime(body.transferred_at, zone)
		if (unix == null) {
			throw new GoodsFloatError('transferred_at must be a unix timestamp or a local datetime.', {
				code: 'INVALID_GOODS_FLOAT_TIME',
				field: 'transferred_at',
			})
		}
		return unix
	}
	throw new GoodsFloatError('A transfer date and time is required.', {
		code: 'INVALID_GOODS_FLOAT_TIME',
		field: 'local_datetime',
	})
}

function assertFingerprintFree(db, fingerprint, exceptId = null) {
	const row = exceptId
		? db.prepare('SELECT id FROM goods_float_transfers WHERE fingerprint = ? AND id != ?').get(fingerprint, exceptId)
		: db.prepare('SELECT id FROM goods_float_transfers WHERE fingerprint = ?').get(fingerprint)
	if (row) {
		throw new GoodsFloatError('That ¥888 wire is already recorded at this minute.', {
			status: 409,
			code: 'GOODS_FLOAT_DUPLICATE_TRANSFER',
			field: 'fingerprint',
			current: { id: row.id, fingerprint },
		})
	}
}

function insertTransferRow(db, fields) {
	const result = db
		.prepare(
			`
			INSERT INTO goods_float_transfers (
				transferred_at, amount_cents, currency, payer_name, payee_name,
				source, fingerprint, screenshot_id, title, note,
				created_by, updated_by, created_at, updated_at, version
			) VALUES (
				@transferred_at, @amount_cents, 'CNY', @payer_name, @payee_name,
				@source, @fingerprint, @screenshot_id, @title, @note,
				@created_by, @updated_by, @created_at, @updated_at, 1
			)
		`,
		)
		.run(fields)
	return Number(result.lastInsertRowid)
}

function createTransfer(db, body = {}, { actor, now, timeZone = DEFAULT_TIME_ZONE } = {}) {
	ensureSchema(db)
	const zone = normalizeTimeZone(timeZone)
	const transferredAt = resolveTransferredAt(body, zone)
	const amountCents =
		parseBoundedInt(body.amount_cents, {
			field: 'amount_cents',
			min: 1,
			max: MAX_AMOUNT_CNY_CENTS,
			required: false,
		}) ?? DEFAULT_AMOUNT_CNY_CENTS
	if (amountCents !== DEFAULT_AMOUNT_CNY_CENTS) {
		throw new GoodsFloatError(`Only the shopper float of ¥${DEFAULT_AMOUNT_CNY_CENTS / 100} is recorded here.`, {
			code: 'GOODS_FLOAT_AMOUNT_LOCKED',
			field: 'amount_cents',
		})
	}
	const fingerprint = wechatBill.fingerprintFor(transferredAt, amountCents)
	const changedBy = sanitizeActor(actor)
	const changedAt = unixSeconds(now)
	const persist = db.transaction(() => {
		assertFingerprintFree(db, fingerprint)
		const id = insertTransferRow(db, {
			transferred_at: transferredAt,
			amount_cents: amountCents,
			payer_name: sanitizeName(body.payer_name, 'payer_name', { fallback: 'Walter' }),
			payee_name: sanitizeName(body.payee_name, 'payee_name'),
			source: SOURCE_MANUAL,
			fingerprint,
			screenshot_id: null,
			title: sanitizeTitle(body.title || '转账-来自Walter'),
			note: sanitizeNote(body.note) || '',
			created_by: changedBy,
			updated_by: changedBy,
			created_at: changedAt,
			updated_at: changedAt,
		})
		return getTransfer(db, id, zone)
	})
	return persist()
}

function updateTransfer(db, id, body = {}, { actor, now, timeZone = DEFAULT_TIME_ZONE } = {}) {
	ensureSchema(db)
	const zone = normalizeTimeZone(timeZone)
	const transferId = parsePositiveId(id, 'transfer_id')
	const expectedVersion = parseBoundedInt(body.version, {
		field: 'version',
		min: 1,
		max: Number.MAX_SAFE_INTEGER,
		required: false,
	})
	const persist = db.transaction(() => {
		const existing = db.prepare('SELECT * FROM goods_float_transfers WHERE id = ?').get(transferId)
		if (!existing) {
			throw new GoodsFloatError('That transfer was not found.', {
				status: 404,
				code: 'GOODS_FLOAT_TRANSFER_NOT_FOUND',
				field: 'id',
			})
		}
		if (expectedVersion != null && Number(existing.version) !== expectedVersion) {
			throw new GoodsFloatError('This transfer was updated elsewhere. Reload and try again.', {
				status: 409,
				code: 'GOODS_FLOAT_VERSION_CONFLICT',
				field: 'version',
				current: shapeTransfer(existing, zone),
			})
		}
		let transferredAt = existing.transferred_at
		if (body.local_datetime != null || body.transferred_at != null) {
			transferredAt = resolveTransferredAt(body, zone)
		}
		const amountCents = existing.amount_cents
		const fingerprint = wechatBill.fingerprintFor(transferredAt, amountCents)
		if (fingerprint !== existing.fingerprint) assertFingerprintFree(db, fingerprint, transferId)
		const nextPayer =
			body.payer_name === undefined ? existing.payer_name : sanitizeName(body.payer_name, 'payer_name', { fallback: 'Walter' })
		const nextPayee = body.payee_name === undefined ? existing.payee_name : sanitizeName(body.payee_name, 'payee_name')
		const nextTitle = body.title === undefined ? existing.title : sanitizeTitle(body.title)
		const nextNote = body.note === undefined ? existing.note : sanitizeNote(body.note) || ''
		if (
			Number(existing.transferred_at) === transferredAt &&
			existing.fingerprint === fingerprint &&
			existing.payer_name === nextPayer &&
			existing.payee_name === nextPayee &&
			existing.title === nextTitle &&
			existing.note === nextNote
		) {
			return { transfer: shapeTransfer(existing, zone), unchanged: true }
		}
		const result = db
			.prepare(
				`
				UPDATE goods_float_transfers
				SET transferred_at = @transferred_at,
				    fingerprint = @fingerprint,
				    payer_name = @payer_name,
				    payee_name = @payee_name,
				    title = @title,
				    note = @note,
				    updated_by = @updated_by,
				    updated_at = @updated_at,
				    version = version + 1
				WHERE id = @id AND version = @version
			`,
			)
			.run({
				id: transferId,
				transferred_at: transferredAt,
				fingerprint,
				payer_name: nextPayer,
				payee_name: nextPayee,
				title: nextTitle,
				note: nextNote,
				updated_by: sanitizeActor(actor),
				updated_at: unixSeconds(now),
				version: existing.version,
			})
		if (result.changes !== 1) {
			const latest = db.prepare('SELECT * FROM goods_float_transfers WHERE id = ?').get(transferId)
			throw new GoodsFloatError('This transfer was updated elsewhere. Reload and try again.', {
				status: 409,
				code: 'GOODS_FLOAT_VERSION_CONFLICT',
				field: 'version',
				current: latest ? shapeTransfer(latest, zone) : null,
			})
		}
		return { transfer: getTransfer(db, transferId, zone), unchanged: false }
	})
	return persist()
}

function deleteTransfer(db, id) {
	ensureSchema(db)
	const transferId = parsePositiveId(id, 'transfer_id')
	const existing = db.prepare('SELECT * FROM goods_float_transfers WHERE id = ?').get(transferId)
	if (!existing) {
		throw new GoodsFloatError('That transfer was not found.', {
			status: 404,
			code: 'GOODS_FLOAT_TRANSFER_NOT_FOUND',
			field: 'id',
		})
	}
	db.transaction(() => {
		db.prepare('DELETE FROM goods_float_transfer_screenshots WHERE transfer_id = ?').run(transferId)
		db.prepare('DELETE FROM goods_float_transfers WHERE id = ?').run(transferId)
	})()
	return { ok: true, deleted_id: transferId, fingerprint: existing.fingerprint }
}

function listPeriodKeysForWindow({ from, to, timeZone, now, storedKeys, eventKeys = [] }) {
	const zone = normalizeTimeZone(timeZone)
	const nowUnix = unixSeconds(now)
	const endUnix = to != null ? to : nowUnix
	const endYm = periodYmFromUnix(endUnix, zone)
	const currentYm = periodYmFromUnix(nowUnix, zone)
	const stored = [...new Set([...storedKeys, ...eventKeys])].sort(compareYm)

	if (from == null) {
		const keys = new Set(stored)
		keys.add(currentYm)
		return [...keys].sort(compareYm)
	}

	const startYm = periodYmFromUnix(from, zone)
	if (compareYm(startYm, endYm) > 0) {
		throw new GoodsFloatError('from must be at or before to.', {
			code: 'INVALID_GOODS_FLOAT_WINDOW',
			field: 'from',
		})
	}

	const distance = monthIndex(endYm) - monthIndex(startYm) + 1
	if (distance <= MAX_VIRTUAL_MONTHS) return enumerateMonths(startYm, endYm)

	const keys = stored.filter((ym) => compareYm(ym, startYm) >= 0 && compareYm(ym, endYm) <= 0)
	if (compareYm(currentYm, startYm) >= 0 && compareYm(currentYm, endYm) <= 0 && !keys.includes(currentYm)) {
		keys.push(currentYm)
		keys.sort(compareYm)
	}
	return keys
}

function windowCoversPartialMonth({ from, to, timeZone, now, months }) {
	if (!months.length) return false
	if (from == null) return false
	const zone = normalizeTimeZone(timeZone)
	const endUnix = to != null ? to : unixSeconds(now)
	const startDay = dateKeyFromUnix(from, zone)
	const endDay = dateKeyFromUnix(endUnix, zone)
	const firstYm = months[0]
	const lastYm = months[months.length - 1]
	const fromIsMonthStart = startDay === `${firstYm}-01`
	const toIsMonthEnd = endDay === lastDateKeyOfMonth(lastYm)
	return !(fromIsMonthStart && toIsMonthEnd)
}

function inWindow(transferredAt, from, to) {
	if (from != null && transferredAt < from) return false
	if (to != null && transferredAt > to) return false
	return true
}

function buildWindowSummary(db, { from, to, shopId = null, timeZone = DEFAULT_TIME_ZONE, now } = {}) {
	ensureSchema(db)
	const zone = normalizeTimeZone(timeZone)
	const nowDate = asDate(now)
	const stored = listStoredMonths(db)
	const storedByYm = Object.fromEntries(stored.map((row) => [row.period_ym, row]))
	const eventKeys = listEventPeriodKeys(db, zone)
	const monthKeys = listPeriodKeysForWindow({
		from,
		to,
		timeZone: zone,
		now: nowDate,
		storedKeys: stored.map((row) => row.period_ym),
		eventKeys,
	})

	const firstYm = monthKeys[0]
	const lastYm = monthKeys[monthKeys.length - 1]
	const monthSpanEvents =
		firstYm && lastYm ? listTransfersBetween(db, monthStartUnix(firstYm, zone), monthEndUnix(lastYm, zone)) : []
	const eventsByYm = new Map()
	for (const row of monthSpanEvents) {
		const ym = periodYmFromUnix(row.transferred_at, zone)
		if (!eventsByYm.has(ym)) eventsByYm.set(ym, [])
		eventsByYm.get(ym).push(row)
	}

	const endUnix = to != null ? to : unixSeconds(nowDate)
	const months = monthKeys.map((periodYm) => {
		const base = storedByYm[periodYm] || virtualMonth(periodYm)
		const monthEvents = eventsByYm.get(periodYm) || []
		if (monthEvents.length) {
			const inRange = monthEvents.filter((row) => inWindow(row.transferred_at, from, endUnix))
			return {
				...base,
				transfer_count: inRange.length,
				total_cents: totalCents(inRange.length, base.amount_per_transfer_cents || DEFAULT_AMOUNT_CNY_CENTS),
				source: 'events',
				event_count: monthEvents.length,
				timed_locked: true,
			}
		}
		return {
			...base,
			source: base.stored ? 'month_count' : 'empty',
			event_count: 0,
			timed_locked: false,
		}
	})

	const usedEvents = months.some((row) => row.source === 'events')
	const usedCounts = months.some((row) => row.source === 'month_count' && row.transfer_count > 0)
	const transfer_count = months.reduce((sum, row) => sum + row.transfer_count, 0)
	const total_cents = months.reduce((sum, row) => sum + row.total_cents, 0)
	const currentYm = periodYmFromDate(nowDate, zone)
	const current = months.find((row) => row.period_ym === currentYm) || storedByYm[currentYm] || virtualMonth(currentYm)
	const shopFilter = shopId == null || shopId === '' ? null : String(shopId)
	const partialLegacy = usedCounts && windowCoversPartialMonth({
		from,
		to,
		timeZone: zone,
		now: nowDate,
		months: months.filter((row) => row.source === 'month_count').map((row) => row.period_ym),
	})

	return {
		currency: CURRENCY,
		amount_per_transfer_cents: DEFAULT_AMOUNT_CNY_CENTS,
		timezone: zone,
		grain: usedEvents && usedCounts ? 'mixed' : usedEvents ? 'timed_event' : 'calendar_month',
		portfolio: true,
		deductible: shopFilter == null,
		shop_id: shopFilter,
		window: {
			from: from ?? null,
			to: to ?? null,
			months: months.map((row) => row.period_ym),
			covers_partial_month: partialLegacy,
		},
		transfer_count,
		total_cents,
		event_count: months.reduce((sum, row) => sum + (row.source === 'events' ? row.transfer_count : 0), 0),
		months,
		transfers: listTransfersInWindow(db, { from, to: endUnix, timeZone: zone, now: nowDate }),
		screenshots: listScreenshots(db, { timeZone: zone }),
		current_month: current,
	}
}

function rejectIfMonthHasEvents(db, periodYm, timeZone) {
	const count = countTransfersInMonth(db, periodYm, timeZone)
	if (count > 0) {
		const month = getMonth(db, periodYm)
		throw new GoodsFloatError(
			'This month already has timed ¥888 wires. Add, edit, or delete a dated transfer instead of changing the month total.',
			{
				status: 409,
				code: 'GOODS_FLOAT_HAS_TIMED_TRANSFERS',
				field: 'period_ym',
				current: { ...month, timed_transfer_count: count, timed_locked: true },
			},
		)
	}
}

function setMonthCount(db, periodYm, body = {}, { actor, now, timeZone = DEFAULT_TIME_ZONE } = {}) {
	ensureSchema(db)
	const { period_ym } = parsePeriodYm(periodYm)
	rejectIfMonthHasEvents(db, period_ym, timeZone)
	const transfer_count = parseBoundedInt(body.transfer_count, {
		field: 'transfer_count',
		min: 0,
		max: MAX_TRANSFER_COUNT,
	})
	const amount_per_transfer_cents = parseBoundedInt(body.amount_per_transfer_cents, {
		field: 'amount_per_transfer_cents',
		min: 1,
		max: MAX_AMOUNT_CNY_CENTS,
		required: false,
	})
	const note = sanitizeNote(body.note)
	const expectedVersion = parseBoundedInt(body.version, {
		field: 'version',
		min: 0,
		max: Number.MAX_SAFE_INTEGER,
		required: false,
	})
	const changedBy = sanitizeActor(actor)
	const changedAt = unixSeconds(now)

	const persist = db.transaction(() => {
		rejectIfMonthHasEvents(db, period_ym, timeZone)
		const existing = db
			.prepare(
				`
				SELECT period_ym, transfer_count, amount_per_transfer_cents, currency,
				       note, updated_by, created_at, updated_at, version
				FROM goods_float_months
				WHERE period_ym = ?
			`,
			)
			.get(period_ym)

		if (existing) {
			if (expectedVersion != null && Number(existing.version) !== expectedVersion) {
				throw new GoodsFloatError('This month was updated elsewhere. Reload and try again.', {
					status: 409,
					code: 'GOODS_FLOAT_VERSION_CONFLICT',
					field: 'version',
					current: shapeMonth(existing),
				})
			}
			const nextAmount = amount_per_transfer_cents ?? existing.amount_per_transfer_cents
			const nextNote = note === undefined ? existing.note : note
			if (
				Number(existing.transfer_count) === transfer_count &&
				Number(existing.amount_per_transfer_cents) === nextAmount &&
				existing.note === nextNote
			) {
				return { month: shapeMonth(existing), unchanged: true }
			}

			const result = db
				.prepare(
					`
					UPDATE goods_float_months
					SET transfer_count = @transfer_count,
					    amount_per_transfer_cents = @amount_per_transfer_cents,
					    note = @note,
					    updated_by = @updated_by,
					    updated_at = @updated_at,
					    version = version + 1
					WHERE period_ym = @period_ym AND version = @version
				`,
				)
				.run({
					period_ym,
					transfer_count,
					amount_per_transfer_cents: nextAmount,
					note: nextNote,
					updated_by: changedBy,
					updated_at: changedAt,
					version: existing.version,
				})
			if (result.changes !== 1) {
				const latest = db.prepare('SELECT * FROM goods_float_months WHERE period_ym = ?').get(period_ym)
				throw new GoodsFloatError('This month was updated elsewhere. Reload and try again.', {
					status: 409,
					code: 'GOODS_FLOAT_VERSION_CONFLICT',
					field: 'version',
					current: latest ? shapeMonth(latest) : virtualMonth(period_ym),
				})
			}
			db.prepare(
				`
				INSERT INTO goods_float_revisions (
					period_ym, prev_count, next_count, prev_amount_cents, next_amount_cents,
					note, changed_by, changed_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			`,
			).run(
				period_ym,
				existing.transfer_count,
				transfer_count,
				existing.amount_per_transfer_cents,
				nextAmount,
				nextNote,
				changedBy,
				changedAt,
			)
		} else {
			if (expectedVersion != null && expectedVersion !== 0) {
				throw new GoodsFloatError('This month was updated elsewhere. Reload and try again.', {
					status: 409,
					code: 'GOODS_FLOAT_VERSION_CONFLICT',
					field: 'version',
					current: virtualMonth(period_ym),
				})
			}
			const nextAmount = amount_per_transfer_cents ?? DEFAULT_AMOUNT_CNY_CENTS
			const nextNote = note === undefined ? '' : note
			db.prepare(
				`
				INSERT INTO goods_float_months (
					period_ym, transfer_count, amount_per_transfer_cents, currency, note,
					updated_by, created_at, updated_at, version
				) VALUES (?, ?, ?, 'CNY', ?, ?, ?, ?, 1)
			`,
			).run(period_ym, transfer_count, nextAmount, nextNote, changedBy, changedAt, changedAt)
			db.prepare(
				`
				INSERT INTO goods_float_revisions (
					period_ym, prev_count, next_count, prev_amount_cents, next_amount_cents,
					note, changed_by, changed_at
				) VALUES (?, NULL, ?, NULL, ?, ?, ?, ?)
			`,
			).run(period_ym, transfer_count, nextAmount, nextNote, changedBy, changedAt)
		}

		return {
			month: getMonth(db, period_ym),
			unchanged: false,
		}
	})

	return persist()
}

function adjustMonthCount(db, periodYm, body = {}, opts = {}) {
	const delta = parseBoundedInt(body.delta, {
		field: 'delta',
		min: -MAX_TRANSFER_COUNT,
		max: MAX_TRANSFER_COUNT,
	})
	rejectIfMonthHasEvents(db, periodYm, opts.timeZone || DEFAULT_TIME_ZONE)
	const current = getMonth(db, periodYm)
	if (body.version != null && current.stored && Number(current.version) !== Number(body.version)) {
		throw new GoodsFloatError('This month was updated elsewhere. Reload and try again.', {
			status: 409,
			code: 'GOODS_FLOAT_VERSION_CONFLICT',
			field: 'version',
			current,
		})
	}
	const next = current.transfer_count + delta
	if (next < 0 || next > MAX_TRANSFER_COUNT) {
		throw new GoodsFloatError(`transfer_count must be between 0 and ${MAX_TRANSFER_COUNT}.`, {
			code: 'GOODS_FLOAT_OUT_OF_RANGE',
			field: 'transfer_count',
			current,
		})
	}
	return setMonthCount(
		db,
		periodYm,
		{
			transfer_count: next,
			version: current.stored ? current.version : 0,
			note: body.note,
			amount_per_transfer_cents: body.amount_per_transfer_cents,
		},
		opts,
	)
}

function sha256Hex(buffer) {
	return crypto.createHash('sha256').update(buffer).digest('hex')
}

function extForMime(mime) {
	if (mime === 'image/png') return 'png'
	if (mime === 'image/webp') return 'webp'
	if (mime === 'image/gif') return 'gif'
	if (mime === 'image/avif') return 'avif'
	return 'jpg'
}

function ensureScreenshotsDir(screenshotsDir) {
	const dir = String(screenshotsDir || '').trim()
	if (!dir) {
		throw new GoodsFloatError('Screenshot storage is not configured.', {
			status: 503,
			code: 'GOODS_FLOAT_SCREENSHOTS_UNAVAILABLE',
		})
	}
	fs.mkdirSync(dir, { recursive: true })
	return path.resolve(dir)
}

function screenshotFilePath(screenshotsDir, storedName) {
	const base = path.basename(String(storedName || ''))
	if (!base || base !== storedName || !/^[a-f0-9]{64}\.(jpg|jpeg|png|webp|gif|avif)$/i.test(base)) {
		throw new GoodsFloatError('Screenshot file name is invalid.', {
			status: 400,
			code: 'INVALID_GOODS_FLOAT_IMAGE',
			field: 'stored_name',
		})
	}
	return path.join(path.resolve(screenshotsDir), base)
}

function screenshotImageUrl(row) {
	const id = Number(row && row.id)
	if (!Number.isInteger(id) || id < 1) return null
	const version = Number(row.created_at) || id
	return `/api/finance/goods-float/screenshots/${id}/image?v=${version}`
}

function shapeScreenshot(row, extras = {}) {
	if (!row) return null
	return {
		id: Number(row.id),
		sha256: row.sha256,
		mime: row.mime,
		byte_size: Number(row.byte_size) || 0,
		original_name: row.original_name || '',
		status: row.status,
		error: row.error || '',
		created_by: row.created_by || '',
		created_at: row.created_at ?? null,
		parsed_at: row.parsed_at ?? null,
		imported_at: row.imported_at ?? null,
		transfer_count: Number(row.transfer_count) || extras.transfer_count || 0,
		image_url: screenshotImageUrl(row),
		...extras,
	}
}

function listScreenshots(db, { timeZone = DEFAULT_TIME_ZONE, limit = MAX_SCREENSHOTS_IN_PAYLOAD } = {}) {
	ensureSchema(db)
	const zone = normalizeTimeZone(timeZone)
	const take = Math.min(Math.max(Number(limit) || MAX_SCREENSHOTS_IN_PAYLOAD, 1), 200)
	return db
		.prepare(
			`
			SELECT s.id, s.sha256, s.mime, s.byte_size, s.original_name, s.stored_name,
			       s.status, s.error, s.created_by, s.created_at, s.parsed_at, s.imported_at,
			       s.extracted_json,
			       (
			         SELECT COUNT(*) FROM (
			           SELECT t.id AS transfer_id
			           FROM goods_float_transfers t
			           WHERE t.screenshot_id = s.id
			           UNION
			           SELECT j.transfer_id
			           FROM goods_float_transfer_screenshots j
			           WHERE j.screenshot_id = s.id
			         )
			       ) AS transfer_count
			FROM goods_float_screenshots s
			ORDER BY s.created_at DESC, s.id DESC
			LIMIT ?
		`,
		)
		.all(take)
		.map((row) => {
			const classified = classifyScreenshotRows(parseStoredExtraction(row), zone)
			return {
				...shapeScreenshot(row, { wire_count: classified.wires.length }),
				uploaded_at: formatLocalDateTime(row.created_at, zone),
				uploaded_at_zh: formatLocalDateTimeZh(row.created_at, zone),
				pending: row.status === 'parsed' && classified.wires.length > 0,
			}
		})
}

function getScreenshotRow(db, id) {
	const row = db.prepare('SELECT * FROM goods_float_screenshots WHERE id = ?').get(parsePositiveId(id, 'screenshot_id'))
	if (!row) {
		throw new GoodsFloatError('That screenshot was not found.', {
			status: 404,
			code: 'GOODS_FLOAT_SCREENSHOT_NOT_FOUND',
			field: 'id',
		})
	}
	return row
}

function parseStoredExtraction(row) {
	if (!row || !row.extracted_json) return []
	try {
		const parsed = JSON.parse(row.extracted_json)
		if (Array.isArray(parsed)) return parsed
		if (parsed && Array.isArray(parsed.rows)) return parsed.rows
		return []
	} catch {
		return []
	}
}

function classifyScreenshotRows(rows, timeZone) {
	const classified = wechatBill.selectFloatWires(rows, {
		timeZone,
		amountCents: DEFAULT_AMOUNT_CNY_CENTS,
	})
	return {
		wires: classified.wires.slice(0, MAX_WIRES_PER_SCREENSHOT),
		ignored: classified.ignored,
		ignored_count: classified.ignored.length,
	}
}

function previewFromScreenshot(db, row, timeZone) {
	const classified = classifyScreenshotRows(parseStoredExtraction(row), timeZone)
	const fingerprints = classified.wires.map((wire) => wire.fingerprint)
	const existing =
		fingerprints.length === 0
			? []
			: db
					.prepare(
						`SELECT id, fingerprint FROM goods_float_transfers WHERE fingerprint IN (${fingerprints.map(() => '?').join(',')})`,
					)
					.all(...fingerprints)
	const existingByFp = Object.fromEntries(existing.map((item) => [item.fingerprint, item.id]))
	return {
		screenshot: shapeScreenshot(row),
		wires: classified.wires.map((wire) => ({
			...wire,
			local_datetime: formatLocalDateTime(wire.transferred_at, timeZone),
			local_datetime_zh: formatLocalDateTimeZh(wire.transferred_at, timeZone),
			already_recorded: Boolean(existingByFp[wire.fingerprint]),
			existing_id: existingByFp[wire.fingerprint] || null,
		})),
		ignored_count: classified.ignored_count,
		already_recorded_count: classified.wires.filter((wire) => existingByFp[wire.fingerprint]).length,
	}
}

async function parseScreenshotBytes({ buffer, mime, extractBill, timeZone, originalName }) {
	try {
		if (typeof extractBill === 'function') {
			const extracted = await extractBill({ buffer, mime, timeZone, originalName })
			const rows = Array.isArray(extracted) ? extracted : extracted && extracted.rows
			if (!Array.isArray(rows)) {
				throw new GoodsFloatError('The screenshot parser did not return transfer rows.', {
					status: 502,
					code: 'GOODS_FLOAT_VISION_FAILED',
				})
			}
			return { rows, model: extracted && extracted.model ? extracted.model : 'injected' }
		}
		const extracted = await wechatBillVision.extractBillRows({ buffer, mime })
		return { rows: extracted.rows || [], model: extracted.model || '' }
	} catch (error) {
		if (error instanceof GoodsFloatError) throw error
		throw new GoodsFloatError(error.message || 'Could not read the WeChat bill screenshot.', {
			status: error.status || 502,
			code: error.code || 'GOODS_FLOAT_VISION_FAILED',
		})
	}
}

function collectScreenshotItems(body = {}) {
	const raw = Array.isArray(body.images) ? body.images.filter((item) => item != null && item !== '') : []
	if (raw.length > MAX_BATCH_IMAGES) {
		throw new GoodsFloatError(`Upload at most ${MAX_BATCH_IMAGES} screenshots at a time.`, {
			code: 'GOODS_FLOAT_TOO_MANY_IMAGES',
			field: 'images',
		})
	}
	if (raw.length) {
		return raw.map((item, index) => {
			if (item && typeof item === 'object') return { ...item, _field: `images[${index}]` }
			return { image_b64: item, _field: `images[${index}]` }
		})
	}
	return [{ ...body, _field: 'image_b64' }]
}

function decodeScreenshotItem(item = {}, field = 'image_b64') {
	const decoded = wechatBillVision.decodeBase64Image(item.image_b64 || item.image || item.data_url, item.image_mime)
	if (!decoded.data) {
		throw new GoodsFloatError('A WeChat bill screenshot image is required.', {
			code: 'INVALID_GOODS_FLOAT_IMAGE',
			field,
		})
	}
	if (decoded.data.length > MAX_IMAGE_BYTES) {
		throw new GoodsFloatError('Screenshot is too large (max 12 MB).', {
			code: 'GOODS_FLOAT_IMAGE_TOO_LARGE',
			field,
		})
	}
	const mime = wechatBillVision.sniffImageMime(decoded.data) || safeStoredImageMime(decoded.mime)
	if (!safeStoredImageMime(mime)) {
		throw new GoodsFloatError('Upload a JPEG, PNG or WebP screenshot of the WeChat bill.', {
			code: 'INVALID_GOODS_FLOAT_IMAGE',
			field,
		})
	}
	return {
		data: decoded.data,
		mime,
		originalName: sanitizeTitle(item.original_name || item.filename || ''),
	}
}

function existingTransfersByFingerprint(db, fingerprints) {
	if (!fingerprints.length) return {}
	const rows = db
		.prepare(
			`SELECT id, fingerprint FROM goods_float_transfers WHERE fingerprint IN (${fingerprints.map(() => '?').join(',')})`,
		)
		.all(...fingerprints)
	return Object.fromEntries(rows.map((item) => [item.fingerprint, item.id]))
}

function mergeBatchPreview(db, previews, timeZone) {
	const zone = normalizeTimeZone(timeZone)
	const byFp = new Map()
	const screenshots = []
	let ignoredCount = 0
	let reusedCount = 0
	for (const preview of Array.isArray(previews) ? previews : []) {
		if (preview && preview.screenshot) screenshots.push(preview.screenshot)
		ignoredCount += Number(preview && preview.ignored_count) || 0
		if (preview && preview.reused) reusedCount += 1
		const screenshotId = preview && preview.screenshot ? Number(preview.screenshot.id) : 0
		for (const wire of (preview && preview.wires) || []) {
			const fingerprint = String(wire.fingerprint || '')
			if (!fingerprint) continue
			const existing = byFp.get(fingerprint)
			if (!existing) {
				byFp.set(fingerprint, {
					...wire,
					screenshot_id: screenshotId || wire.screenshot_id || null,
					screenshot_ids: screenshotId ? [screenshotId] : uniquePositiveIds(wire.screenshot_ids),
					seen_on_bills: screenshotId ? 1 : uniquePositiveIds(wire.screenshot_ids).length || 1,
				})
				continue
			}
			if (screenshotId && !existing.screenshot_ids.includes(screenshotId)) {
				existing.screenshot_ids.push(screenshotId)
				existing.seen_on_bills = existing.screenshot_ids.length
			}
		}
	}
	const wires = [...byFp.values()].sort((a, b) => Number(b.transferred_at) - Number(a.transferred_at))
	const existingByFp = existingTransfersByFingerprint(
		db,
		wires.map((wire) => wire.fingerprint),
	)
	const decorated = wires.map((wire) => ({
		...wire,
		local_datetime: wire.local_datetime || formatLocalDateTime(wire.transferred_at, zone),
		local_datetime_zh: wire.local_datetime_zh || formatLocalDateTimeZh(wire.transferred_at, zone),
		already_recorded: Boolean(existingByFp[wire.fingerprint]),
		existing_id: existingByFp[wire.fingerprint] || null,
		seen_on_bills: Array.isArray(wire.screenshot_ids) ? wire.screenshot_ids.length : Number(wire.seen_on_bills) || 1,
	}))
	return {
		screenshot: screenshots[0] || null,
		screenshots,
		screenshot_ids: screenshots.map((shot) => Number(shot.id)),
		wires: decorated,
		ignored_count: ignoredCount,
		already_recorded_count: decorated.filter((wire) => wire.already_recorded).length,
		reused: reusedCount > 0 && reusedCount === screenshots.length,
		reused_count: reusedCount,
	}
}

async function ingestOneScreenshot(
	db,
	{ data, mime, originalName },
	{ actor, now, timeZone = DEFAULT_TIME_ZONE, screenshotsDir, extractBill, force = false } = {},
) {
	const zone = normalizeTimeZone(timeZone)
	const hash = sha256Hex(data)
	const dir = ensureScreenshotsDir(screenshotsDir)
	const storedName = `${hash}.${extForMime(mime)}`
	const changedBy = sanitizeActor(actor)
	const changedAt = unixSeconds(now)

	const existing = db.prepare('SELECT * FROM goods_float_screenshots WHERE sha256 = ?').get(hash)
	if (!force && existing && existing.status !== 'failed' && existing.extracted_json) {
		return { ...previewFromScreenshot(db, existing, zone), reused: true }
	}

	const filePath = path.join(dir, storedName)
	if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, data)

	let screenshotId = existing && existing.id
	if (!screenshotId) {
		const inserted = db
			.prepare(
				`
				INSERT INTO goods_float_screenshots (
					sha256, mime, byte_size, original_name, stored_name, extracted_json,
					status, error, created_by, created_at, parsed_at, imported_at
				) VALUES (?, ?, ?, ?, ?, '', 'uploaded', '', ?, ?, NULL, NULL)
			`,
			)
			.run(hash, mime, data.length, originalName, storedName, changedBy, changedAt)
		screenshotId = Number(inserted.lastInsertRowid)
	}

	try {
		const extracted = await parseScreenshotBytes({
			buffer: data,
			mime,
			extractBill,
			timeZone: zone,
			originalName,
		})
		db.prepare(
			`
			UPDATE goods_float_screenshots
			SET extracted_json = ?, status = 'parsed', error = '', parsed_at = ?, mime = ?, byte_size = ?
			WHERE id = ?
		`,
		).run(JSON.stringify({ rows: extracted.rows, model: extracted.model || '' }), changedAt, mime, data.length, screenshotId)
		const row = getScreenshotRow(db, screenshotId)
		return { ...previewFromScreenshot(db, row, zone), reused: false }
	} catch (error) {
		db.prepare(
			`
			UPDATE goods_float_screenshots
			SET status = 'failed', error = ?, parsed_at = ?
			WHERE id = ?
		`,
		).run(String(error.message || 'parse failed').slice(0, 500), changedAt, screenshotId)
		throw error
	}
}

async function ingestScreenshots(
	db,
	body = {},
	{ actor, now, timeZone = DEFAULT_TIME_ZONE, screenshotsDir, extractBill } = {},
) {
	ensureSchema(db)
	const zone = normalizeTimeZone(timeZone)
	const items = collectScreenshotItems(body)
	const previews = []
	for (const item of items) {
		const decoded = decodeScreenshotItem(item, item._field || 'image_b64')
		previews.push(
			await ingestOneScreenshot(
				db,
				decoded,
				{ actor, now, timeZone: zone, screenshotsDir, extractBill },
			),
		)
	}
	const preview = mergeBatchPreview(db, previews, zone)
	return autoImportPreview(db, preview, { actor, now, timeZone: zone })
}

function autoImportPreview(db, preview, { actor, now, timeZone = DEFAULT_TIME_ZONE } = {}) {
	const ids = uniquePositiveIds(preview && preview.screenshot_ids)
	if (!ids.length || !preview.wires || !preview.wires.length) {
		return {
			...preview,
			auto_imported: true,
			imported: [],
			imported_count: 0,
			skipped: [],
			skipped_count: 0,
		}
	}
	const imported = importScreenshots(db, ids, {}, { actor, now, timeZone })
	const zone = normalizeTimeZone(timeZone)
	const refreshed = mergeBatchPreview(
		db,
		ids.map((id) => previewFromScreenshot(db, getScreenshotRow(db, id), zone)),
		zone,
	)
	return {
		...refreshed,
		reused: Boolean(preview && preview.reused),
		reused_count: Number(preview && preview.reused_count) || 0,
		auto_imported: true,
		imported: imported.imported,
		imported_count: imported.imported_count,
		skipped: imported.skipped,
		skipped_count: imported.skipped_count,
	}
}

function listParsedScreenshotIds(db) {
	ensureSchema(db)
	return db
		.prepare(`SELECT id FROM goods_float_screenshots WHERE status = 'parsed' ORDER BY id`)
		.all()
		.map((row) => Number(row.id))
}

function importParsedScreenshots(db, { actor, now, timeZone = DEFAULT_TIME_ZONE } = {}) {
	const ids = listParsedScreenshotIds(db)
	if (!ids.length) {
		return {
			ok: true,
			imported: [],
			imported_count: 0,
			skipped: [],
			skipped_count: 0,
			screenshots: [],
			screenshot_ids: [],
		}
	}
	const zone = normalizeTimeZone(timeZone)
	const merged = mergeBatchPreview(
		db,
		ids.map((id) => previewFromScreenshot(db, getScreenshotRow(db, id), zone)),
		zone,
	)
	if (!merged.wires.length) {
		return {
			ok: true,
			imported: [],
			imported_count: 0,
			skipped: [],
			skipped_count: 0,
			screenshots: ids.map((id) => shapeScreenshot(getScreenshotRow(db, id))),
			screenshot_ids: ids,
		}
	}
	return importScreenshots(db, ids, {}, { actor, now, timeZone: zone })
}

async function ingestScreenshot(db, body = {}, opts = {}) {
	return ingestScreenshots(db, body, opts)
}

function linkTransferScreenshot(db, transferId, screenshotId) {
	const tid = Number(transferId)
	const sid = Number(screenshotId)
	if (!Number.isInteger(tid) || tid < 1 || !Number.isInteger(sid) || sid < 1) return
	db.prepare(
		`
		INSERT OR IGNORE INTO goods_float_transfer_screenshots (transfer_id, screenshot_id)
		VALUES (?, ?)
	`,
	).run(tid, sid)
	const current = db.prepare('SELECT screenshot_id FROM goods_float_transfers WHERE id = ?').get(tid)
	if (current && current.screenshot_id == null) {
		db.prepare('UPDATE goods_float_transfers SET screenshot_id = ? WHERE id = ?').run(sid, tid)
	}
}

function parseScreenshotIdList(raw, fallbackId) {
	const source = Array.isArray(raw) ? raw : raw != null && raw !== '' ? [raw] : fallbackId != null ? [fallbackId] : []
	const ids = []
	const seen = new Set()
	for (const value of source) {
		const id = parsePositiveId(value, 'screenshot_id')
		if (seen.has(id)) continue
		seen.add(id)
		ids.push(id)
	}
	return ids
}

function importScreenshots(
	db,
	screenshotIds,
	body = {},
	{ actor, now, timeZone = DEFAULT_TIME_ZONE } = {},
) {
	ensureSchema(db)
	const zone = normalizeTimeZone(timeZone)
	const ids = parseScreenshotIdList(screenshotIds)
	if (!ids.length) {
		throw new GoodsFloatError('Select at least one WeChat bill to import.', {
			code: 'GOODS_FLOAT_NO_WIRES',
			field: 'screenshot_ids',
		})
	}
	const rows = ids.map((id) => getScreenshotRow(db, id))
	for (const row of rows) {
		if (row.status === 'failed' || !row.extracted_json) {
			throw new GoodsFloatError('This screenshot has not been read yet. Upload it again.', {
				code: 'GOODS_FLOAT_SCREENSHOT_NOT_PARSED',
			})
		}
	}
	const merged = mergeBatchPreview(
		db,
		rows.map((row) => previewFromScreenshot(db, row, zone)),
		zone,
	)
	if (!merged.wires.length) {
		throw new GoodsFloatError('No ¥888 wires were selected to import.', {
			code: 'GOODS_FLOAT_NO_WIRES',
		})
	}
	const wanted = Array.isArray(body.fingerprints)
		? new Set(body.fingerprints.map((item) => String(item)))
		: null
	const changedBy = sanitizeActor(actor)
	const changedAt = unixSeconds(now)
	const imported = []
	const skipped = []
	const persist = db.transaction(() => {
		for (const wire of merged.wires) {
			const existing = db.prepare('SELECT id FROM goods_float_transfers WHERE fingerprint = ?').get(wire.fingerprint)
			const chosen = !wanted || wanted.has(wire.fingerprint)
			if (existing) {
				if (chosen) skipped.push({ fingerprint: wire.fingerprint, id: existing.id, reason: 'already_recorded' })
				for (const screenshotId of wire.screenshot_ids || []) linkTransferScreenshot(db, existing.id, screenshotId)
				continue
			}
			if (!chosen) continue
			const screenshotId = Number((wire.screenshot_ids && wire.screenshot_ids[0]) || ids[0]) || null
			const id = insertTransferRow(db, {
				transferred_at: wire.transferred_at,
				amount_cents: wire.amount_cents,
				payer_name: sanitizeName(wire.payer_name, 'payer_name', { fallback: 'Walter' }),
				payee_name: sanitizeName(wire.payee_name, 'payee_name'),
				source: SOURCE_SCREENSHOT,
				fingerprint: wire.fingerprint,
				screenshot_id: screenshotId,
				title: sanitizeTitle(wire.title),
				note: '',
				created_by: changedBy,
				updated_by: changedBy,
				created_at: changedAt,
				updated_at: changedAt,
			})
			for (const shotId of wire.screenshot_ids || []) linkTransferScreenshot(db, id, shotId)
			imported.push(getTransfer(db, id, zone))
		}
		db.prepare(
			`
			UPDATE goods_float_screenshots
			SET status = 'imported', imported_at = ?
			WHERE id IN (${ids.map(() => '?').join(',')})
		`,
		).run(changedAt, ...ids)
	})
	persist()
	return {
		ok: true,
		screenshot: shapeScreenshot(getScreenshotRow(db, ids[0])),
		screenshots: ids.map((id) => shapeScreenshot(getScreenshotRow(db, id))),
		imported,
		skipped,
		imported_count: imported.length,
		skipped_count: skipped.length,
	}
}

function importScreenshot(
	db,
	screenshotId,
	body = {},
	{ actor, now, timeZone = DEFAULT_TIME_ZONE } = {},
) {
	return importScreenshots(db, [screenshotId], body, { actor, now, timeZone })
}

function linkedTransferIdsForScreenshot(db, screenshotId) {
	const sid = Number(screenshotId)
	const fromJunction = db
		.prepare('SELECT transfer_id FROM goods_float_transfer_screenshots WHERE screenshot_id = ?')
		.all(sid)
		.map((row) => Number(row.transfer_id))
	const fromPrimary = db
		.prepare('SELECT id FROM goods_float_transfers WHERE screenshot_id = ?')
		.all(sid)
		.map((row) => Number(row.id))
	return uniquePositiveIds([...fromJunction, ...fromPrimary])
}

function deleteScreenshot(db, screenshotId, screenshotsDir) {
	ensureSchema(db)
	const row = getScreenshotRow(db, screenshotId)
	const persist = db.transaction(() => {
		const transferIds = linkedTransferIdsForScreenshot(db, row.id)
		db.prepare('DELETE FROM goods_float_transfer_screenshots WHERE screenshot_id = ?').run(row.id)
		const deletedTransfers = []
		for (const transferId of transferIds) {
			const remaining = db
				.prepare('SELECT screenshot_id FROM goods_float_transfer_screenshots WHERE transfer_id = ? ORDER BY screenshot_id')
				.all(transferId)
			const transfer = db.prepare('SELECT id, source, screenshot_id FROM goods_float_transfers WHERE id = ?').get(transferId)
			if (!transfer) continue
			if (!remaining.length && transfer.source === SOURCE_SCREENSHOT) {
				db.prepare('DELETE FROM goods_float_transfers WHERE id = ?').run(transferId)
				deletedTransfers.push(transferId)
				continue
			}
			const nextShot = remaining[0] ? Number(remaining[0].screenshot_id) : null
			if (Number(transfer.screenshot_id) === Number(row.id)) {
				db.prepare('UPDATE goods_float_transfers SET screenshot_id = ? WHERE id = ?').run(nextShot, transferId)
			}
		}
		db.prepare('DELETE FROM goods_float_screenshots WHERE id = ?').run(row.id)
		return {
			ok: true,
			deleted_id: Number(row.id),
			deleted_transfer_ids: deletedTransfers,
			deleted_transfer_count: deletedTransfers.length,
		}
	})
	const result = persist()
	try {
		const filePath = screenshotFilePath(screenshotsDir, row.stored_name)
		if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
	} catch {
		/* keep the DB delete even if the file is already gone */
	}
	return result
}

async function reparseScreenshot(
	db,
	screenshotId,
	{ actor, now, timeZone = DEFAULT_TIME_ZONE, screenshotsDir, extractBill } = {},
) {
	ensureSchema(db)
	const zone = normalizeTimeZone(timeZone)
	const row = getScreenshotRow(db, screenshotId)
	const image = readScreenshotImage(db, row.id, screenshotsDir)
	const preview = await ingestOneScreenshot(
		db,
		{ data: image.data, mime: image.mime || row.mime, originalName: row.original_name },
		{ actor, now, timeZone: zone, screenshotsDir, extractBill, force: true },
	)
	return autoImportPreview(db, mergeBatchPreview(db, [preview], zone), { actor, now, timeZone: zone })
}

function readScreenshotImage(db, screenshotId, screenshotsDir) {
	const row = getScreenshotRow(db, screenshotId)
	const filePath = screenshotFilePath(screenshotsDir, row.stored_name)
	if (!fs.existsSync(filePath)) {
		throw new GoodsFloatError('The screenshot file is missing from disk.', {
			status: 404,
			code: 'GOODS_FLOAT_SCREENSHOT_MISSING_FILE',
		})
	}
	return { mime: row.mime, data: fs.readFileSync(filePath) }
}

function jsonError(res, error) {
	const known = error instanceof GoodsFloatError
	if (!known) console.error('[goods-float]', error && error.message)
	res.status((known && error.status) || 500).json({
		error: known ? error.message : 'Could not update manufacturer goods cost.',
		code: (known && error.code) || 'GOODS_FLOAT_FAILED',
		field: (known && error.field) || null,
		current: (known && error.current) || null,
	})
}

function readWindowQuery(req) {
	return {
		from: parseUnixQuery(req.query.from, 'from'),
		to: parseUnixQuery(req.query.to, 'to'),
		shopId: req.query.shop_id ? String(req.query.shop_id) : null,
	}
}

function installRoutes(
	app,
	{ db, timeZone = DEFAULT_TIME_ZONE, now = () => new Date(), screenshotsDir = '', extractBill = null } = {},
) {
	if (!app || typeof app.get !== 'function' || typeof app.put !== 'function') {
		throw new TypeError('An Express application is required.')
	}
	if (!db || typeof db.prepare !== 'function') {
		throw new TypeError('A SQLite database is required.')
	}
	ensureSchema(db)
	const currentTimeZone = () => normalizeTimeZone(typeof timeZone === 'function' ? timeZone() : timeZone)
	const currentNow = () => (typeof now === 'function' ? now() : now)
	const currentDir = () => (typeof screenshotsDir === 'function' ? screenshotsDir() : screenshotsDir)
	const actorOf = (req) => sanitizeActor((req.auth && (req.auth.user || req.auth.role)) || 'owner')
	const writeOpts = (req) => ({
		actor: actorOf(req),
		now: currentNow(),
		timeZone: currentTimeZone(),
	})
	const windowSummary = (req) =>
		buildWindowSummary(db, {
			...readWindowQuery(req),
			timeZone: currentTimeZone(),
			now: currentNow(),
		})

	app.get('/api/finance/goods-float', (req, res) => {
		try {
			res.set('Cache-Control', 'no-store')
			res.json(windowSummary(req))
		} catch (error) {
			jsonError(res, error)
		}
	})

	app.get('/api/finance/goods-float/screenshots', (req, res) => {
		try {
			res.set('Cache-Control', 'no-store')
			res.json({
				ok: true,
				screenshots: listScreenshots(db, { timeZone: currentTimeZone() }),
			})
		} catch (error) {
			jsonError(res, error)
		}
	})

	app.post('/api/finance/goods-float/screenshots', async (req, res) => {
		try {
			const preview = await ingestScreenshots(db, req.body || {}, {
				...writeOpts(req),
				screenshotsDir: currentDir(),
				extractBill,
			})
			res.set('Cache-Control', 'no-store')
			res.json({ ok: true, ...preview, summary: windowSummary(req) })
		} catch (error) {
			jsonError(res, error)
		}
	})

	app.post('/api/finance/goods-float/screenshots/import', (req, res) => {
		try {
			const body = req.body || {}
			const ids = body.screenshot_ids || body.ids
			const result = Array.isArray(ids) && ids.length
				? importScreenshots(db, ids, body, writeOpts(req))
				: importParsedScreenshots(db, writeOpts(req))
			res.set('Cache-Control', 'no-store')
			res.json({
				...result,
				summary: windowSummary(req),
			})
		} catch (error) {
			jsonError(res, error)
		}
	})

	app.post('/api/finance/goods-float/screenshots/:id/import', (req, res) => {
		try {
			const result = importScreenshot(db, req.params.id, req.body || {}, writeOpts(req))
			res.set('Cache-Control', 'no-store')
			res.json({
				...result,
				summary: windowSummary(req),
			})
		} catch (error) {
			jsonError(res, error)
		}
	})

	app.post('/api/finance/goods-float/screenshots/:id/retry', async (req, res) => {
		try {
			const preview = await reparseScreenshot(db, req.params.id, {
				...writeOpts(req),
				screenshotsDir: currentDir(),
				extractBill,
			})
			res.set('Cache-Control', 'no-store')
			res.json({ ok: true, ...preview, summary: windowSummary(req) })
		} catch (error) {
			jsonError(res, error)
		}
	})

	app.delete('/api/finance/goods-float/screenshots/:id', (req, res) => {
		try {
			const result = deleteScreenshot(db, req.params.id, currentDir())
			res.set('Cache-Control', 'no-store')
			res.json({
				...result,
				summary: windowSummary(req),
			})
		} catch (error) {
			jsonError(res, error)
		}
	})

	app.get('/api/finance/goods-float/screenshots/:id/image', (req, res) => {
		try {
			const image = readScreenshotImage(db, req.params.id, currentDir())
			if (!sendStoredImage(res, image, SCREENSHOT_CACHE_CONTROL)) {
				res.status(415).end()
			}
		} catch (error) {
			jsonError(res, error)
		}
	})

	app.post('/api/finance/goods-float/transfers', (req, res) => {
		try {
			const transfer = createTransfer(db, req.body || {}, writeOpts(req))
			res.set('Cache-Control', 'no-store')
			res.json({
				ok: true,
				transfer,
				summary: windowSummary(req),
			})
		} catch (error) {
			jsonError(res, error)
		}
	})

	app.patch('/api/finance/goods-float/transfers/:id', (req, res) => {
		try {
			const result = updateTransfer(db, req.params.id, req.body || {}, writeOpts(req))
			res.set('Cache-Control', 'no-store')
			res.json({
				ok: true,
				unchanged: result.unchanged,
				transfer: result.transfer,
				summary: windowSummary(req),
			})
		} catch (error) {
			jsonError(res, error)
		}
	})

	app.delete('/api/finance/goods-float/transfers/:id', (req, res) => {
		try {
			const result = deleteTransfer(db, req.params.id)
			res.set('Cache-Control', 'no-store')
			res.json({
				...result,
				summary: windowSummary(req),
			})
		} catch (error) {
			jsonError(res, error)
		}
	})

	app.get('/api/finance/goods-float/:period_ym', (req, res) => {
		try {
			const month = getMonth(db, req.params.period_ym)
			res.set('Cache-Control', 'no-store')
			res.json({
				ok: true,
				month,
				revisions: month.stored ? listRevisions(db, month.period_ym) : [],
			})
		} catch (error) {
			jsonError(res, error)
		}
	})

	app.put('/api/finance/goods-float/:period_ym', (req, res) => {
		try {
			const result = setMonthCount(db, req.params.period_ym, req.body || {}, writeOpts(req))
			res.set('Cache-Control', 'no-store')
			res.json({
				ok: true,
				unchanged: result.unchanged,
				month: result.month,
				summary: windowSummary(req),
			})
		} catch (error) {
			jsonError(res, error)
		}
	})

	app.post('/api/finance/goods-float/:period_ym/adjust', (req, res) => {
		try {
			const result = adjustMonthCount(db, req.params.period_ym, req.body || {}, writeOpts(req))
			res.set('Cache-Control', 'no-store')
			res.json({
				ok: true,
				unchanged: result.unchanged,
				month: result.month,
				summary: windowSummary(req),
			})
		} catch (error) {
			jsonError(res, error)
		}
	})
}

module.exports = {
	DEFAULT_TIME_ZONE,
	CURRENCY,
	DEFAULT_AMOUNT_CNY_CENTS,
	MAX_TRANSFER_COUNT,
	MAX_VIRTUAL_MONTHS,
	GoodsFloatError,
	ensureSchema,
	normalizeTimeZone,
	periodYmFromDate,
	periodYmFromUnix,
	dateKeyFromUnix,
	formatLocalDateTime,
	formatLocalDateTimeZh,
	parsePeriodYm,
	lastDateKeyOfMonth,
	enumerateMonths,
	parseUnixQuery,
	monthStartUnix,
	monthEndUnix,
	getMonth,
	listStoredMonths,
	listRevisions,
	listTransfersInWindow,
	getTransfer,
	createTransfer,
	updateTransfer,
	deleteTransfer,
	ingestScreenshot,
	ingestScreenshots,
	importScreenshot,
	importScreenshots,
	importParsedScreenshots,
	reparseScreenshot,
	deleteScreenshot,
	listScreenshots,
	buildWindowSummary,
	setMonthCount,
	adjustMonthCount,
	installRoutes,
}
