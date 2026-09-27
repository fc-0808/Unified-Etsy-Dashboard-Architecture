'use strict'

/**
 * WeChat Pay / 微信账单 rows → shopper-float wires.
 *
 * Walter wires ¥888 to the in-person shopper each time she runs out of cash.
 * A screenshot of WeChat's transfer search mixes those wires with unrelated
 * small payments. This module is the deterministic classifier: given structured
 * rows (from vision or a test fixture), it keeps only the 888 wires and stamps
 * each one with a timezone-correct unix time and an idempotency fingerprint.
 *
 * Two sides of the same wire must collapse to one fingerprint:
 *   employee bill  "转账-来自Walter" +888.00
 *   owner bill     "转账-转给天生好运甜美鱼" -888.00
 * Both are the same cash movement when they share minute + amount.
 */

const DEFAULT_TIME_ZONE = 'Asia/Shanghai'
const DEFAULT_AMOUNT_CNY_CENTS = 88800
const OWNER_ALIASES = Object.freeze(['walter', '沃尔特'])

function normalizeTimeZone(value) {
	const zone = String(value || '').trim() || DEFAULT_TIME_ZONE
	try {
		new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date())
		return zone
	} catch {
		return DEFAULT_TIME_ZONE
	}
}

function datePartsInTimeZone(date, timeZone) {
	const instant = date instanceof Date ? date : new Date(date)
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone: normalizeTimeZone(timeZone),
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hourCycle: 'h23',
	}).formatToParts(instant)
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

function unixFromZonedLocal(parts, timeZone = DEFAULT_TIME_ZONE) {
	const year = Number(parts.year)
	const month = Number(parts.month)
	const day = Number(parts.day)
	const hour = Number(parts.hour || 0)
	const minute = Number(parts.minute || 0)
	const second = Number(parts.second || 0)
	if (![year, month, day].every((n) => Number.isInteger(n) && n > 0)) return null
	if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null
	const want = Date.UTC(year, month - 1, day, hour, minute, second)
	if (!Number.isFinite(want)) return null
	let instant = want
	const zone = normalizeTimeZone(timeZone)
	for (let i = 0; i < 4; i++) {
		const gotParts = datePartsInTimeZone(new Date(instant), zone)
		const got = Date.UTC(gotParts.year, gotParts.month - 1, gotParts.day, gotParts.hour, gotParts.minute, gotParts.second)
		const delta = got - want
		if (delta === 0) break
		instant -= delta
	}
	return Math.floor(instant / 1000)
}

function foldName(value) {
	return String(value || '')
		.normalize('NFKC')
		.replace(/\s+/g, '')
		.toLowerCase()
}

function isOwnerName(value) {
	const folded = foldName(value)
	if (!folded) return false
	return OWNER_ALIASES.some((alias) => folded === alias || folded.includes(alias))
}

function parseAmountCents(value) {
	if (value == null || value === '') return null
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) return null
		return Math.round(Math.abs(value) * (Math.abs(value) >= 1000 ? 1 : 100))
	}
	const raw = String(value).replace(/[¥￥,\s]/g, '').replace(/CNY|RMB|元/gi, '')
	const match = raw.match(/([+-]?)(\d+(?:\.\d{1,2})?)/)
	if (!match) return null
	return Math.round(Math.abs(Number(match[2])) * 100)
}

function parseSignedAmount(value) {
	const cents = parseAmountCents(value)
	if (cents == null) return null
	const raw = String(value)
	const negative = /^\s*-/.test(raw) || /^-/.test(raw.replace(/[¥￥,\s]/g, ''))
	return { cents, negative }
}

function parseWeChatDateTime(value, timeZone = DEFAULT_TIME_ZONE) {
	if (value == null || value === '') return null
	if (typeof value === 'number' && Number.isFinite(value)) {
		if (value > 1e12) return Math.floor(value / 1000)
		if (value > 1e9) return Math.floor(value)
	}
	const text = String(value).trim()
	const chinese = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/)
	if (chinese) {
		return unixFromZonedLocal(
			{
				year: Number(chinese[1]),
				month: Number(chinese[2]),
				day: Number(chinese[3]),
				hour: chinese[4] != null ? Number(chinese[4]) : 12,
				minute: chinese[5] != null ? Number(chinese[5]) : 0,
				second: chinese[6] != null ? Number(chinese[6]) : 0,
			},
			timeZone,
		)
	}
	const iso = text.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/)
	if (iso) {
		return unixFromZonedLocal(
			{
				year: Number(iso[1]),
				month: Number(iso[2]),
				day: Number(iso[3]),
				hour: iso[4] != null ? Number(iso[4]) : 12,
				minute: iso[5] != null ? Number(iso[5]) : 0,
				second: iso[6] != null ? Number(iso[6]) : 0,
			},
			timeZone,
		)
	}
	return null
}

function inferDirection(row, signed) {
	const title = String(row.title || '')
	const explicit = String(row.direction || '').toLowerCase()
	if (explicit === 'in' || explicit === 'out') return explicit
	if (/来自|from/i.test(title)) return 'in'
	if (/转给|to\b|转出/i.test(title)) return 'out'
	if (signed && signed.negative) return 'out'
	if (row.amount != null && /^\s*-/.test(String(row.amount))) return 'out'
	return 'in'
}

function counterpartyOf(row, direction) {
	const titled = String(row.title || '')
	const fromMatch = titled.match(/来自\s*([^\s-]+)/)
	const toMatch = titled.match(/转给\s*([^\s-]+)/)
	if (direction === 'in' && fromMatch) return fromMatch[1]
	if (direction === 'out' && toMatch) return toMatch[1]
	return String(row.counterparty || row.payer_name || row.payee_name || '').trim()
}

function isFloatWire(row, { amountCents = DEFAULT_AMOUNT_CNY_CENTS } = {}) {
	if (!row || row.amount_cents !== amountCents) return false
	const title = String(row.title || '')
	const counterparty = counterpartyOf(row, row.direction)
	const mentionsOwner = isOwnerName(counterparty) || isOwnerName(title) || /来自\s*walter/i.test(title)
	// Employee bill: "转账-来自Walter +888". Anyone else's +888 is ignored.
	if (row.direction === 'in') return mentionsOwner
	// Owner bill: "转账-转给采购员 −888". The ¥888 amount is the discriminator;
	// small 转给 amounts (snacks, taxis) never reach this branch.
	return true
}

function fingerprintFor(transferredAt, amountCents) {
	const minute = Math.floor(Number(transferredAt) / 60) * 60
	return `${minute}|${amountCents}`
}

function normalizeBillRow(raw, { timeZone = DEFAULT_TIME_ZONE, amountCents = DEFAULT_AMOUNT_CNY_CENTS } = {}) {
	const signed = parseSignedAmount(raw.amount != null ? raw.amount : raw.amount_cents != null ? raw.amount_cents / 100 : '')
	const cents = raw.amount_cents != null ? Math.abs(Number(raw.amount_cents)) : signed && signed.cents
	if (!Number.isInteger(cents) || cents <= 0) return null
	const direction = inferDirection(raw, signed)
	const transferredAt =
		raw.transferred_at != null
			? parseWeChatDateTime(raw.transferred_at, timeZone)
			: parseWeChatDateTime(raw.local_datetime || raw.raw_date || raw.datetime || raw.date, timeZone)
	if (transferredAt == null) return null
	const title = String(raw.title || '').trim()
	const counterparty = counterpartyOf({ ...raw, title, direction }, direction)
	const payer_name = direction === 'in' ? counterparty || 'Walter' : 'Walter'
	const payee_name = direction === 'out' ? counterparty : ''
	const row = {
		title,
		counterparty,
		direction,
		amount_cents: cents,
		currency: 'CNY',
		transferred_at: transferredAt,
		payer_name,
		payee_name,
		raw_date: String(raw.raw_date || raw.local_datetime || raw.datetime || '').trim(),
	}
	row.is_float_wire = isFloatWire(row, { amountCents })
	row.fingerprint = fingerprintFor(transferredAt, cents)
	return row
}

function selectFloatWires(rows, opts = {}) {
	const timeZone = normalizeTimeZone(opts.timeZone)
	const amountCents = opts.amountCents || DEFAULT_AMOUNT_CNY_CENTS
	const seen = new Set()
	const wires = []
	const ignored = []
	for (const raw of Array.isArray(rows) ? rows : []) {
		const row = normalizeBillRow(raw, { timeZone, amountCents })
		if (!row) {
			ignored.push({ raw, reason: 'unreadable' })
			continue
		}
		if (!row.is_float_wire) {
			ignored.push({ row, reason: 'not_float_wire' })
			continue
		}
		if (seen.has(row.fingerprint)) {
			ignored.push({ row, reason: 'duplicate_in_screenshot' })
			continue
		}
		seen.add(row.fingerprint)
		wires.push(row)
	}
	wires.sort((a, b) => b.transferred_at - a.transferred_at)
	return { wires, ignored }
}

function screenshotFixtureFromWalterBill() {
	return [
		{ title: '转账-转给天生好运甜美鱼', amount: '-22.00', raw_date: '2026年9月11日 17:54' },
		{ title: '转账-来自Walter', amount: '+888.00', raw_date: '2026年9月11日 17:54' },
		{ title: '转账-转给天生好运甜美鱼', amount: '-83.00', raw_date: '2026年9月9日 18:21' },
		{ title: '转账-来自Walter', amount: '+888.00', raw_date: '2026年9月9日 18:20' },
		{ title: '转账-转给天生好运甜美鱼', amount: '-15.00', raw_date: '2026年9月7日 17:25' },
		{ title: '转账-来自Walter', amount: '+888.00', raw_date: '2026年9月7日 17:25' },
		{ title: '转账-来自Walter', amount: '+888.00', raw_date: '2026年9月7日 16:36' },
		{ title: '转账-来自Walter', amount: '+888.00', raw_date: '2026年9月3日 17:41' },
		{ title: '转账-来自Walter', amount: '+888.00', raw_date: '2026年9月1日 17:30' },
	]
}

function screenshotFixtureNewerWalterBill() {
	return [
		{ title: '转账-来自Walter', amount: '+888.00', raw_date: '2026年9月15日 17:12' },
		{ title: '转账-来自Walter', amount: '+888.00', raw_date: '2026年9月14日 17:18' },
		{ title: '转账-转给天生好运甜美鱼', amount: '-22.00', raw_date: '2026年9月11日 17:54' },
		{ title: '转账-来自Walter', amount: '+888.00', raw_date: '2026年9月11日 17:54' },
		{ title: '转账-转给天生好运甜美鱼', amount: '-83.00', raw_date: '2026年9月9日 18:21' },
		{ title: '转账-来自Walter', amount: '+888.00', raw_date: '2026年9月9日 18:20' },
		{ title: '转账-转给天生好运甜美鱼', amount: '-15.00', raw_date: '2026年9月7日 17:25' },
		{ title: '转账-来自Walter', amount: '+888.00', raw_date: '2026年9月7日 17:25' },
		{ title: '转账-来自Walter', amount: '+888.00', raw_date: '2026年9月7日 16:36' },
	]
}

module.exports = {
	DEFAULT_TIME_ZONE,
	DEFAULT_AMOUNT_CNY_CENTS,
	OWNER_ALIASES,
	normalizeTimeZone,
	datePartsInTimeZone,
	unixFromZonedLocal,
	foldName,
	isOwnerName,
	parseAmountCents,
	parseWeChatDateTime,
	normalizeBillRow,
	selectFloatWires,
	fingerprintFor,
	screenshotFixtureFromWalterBill,
	screenshotFixtureNewerWalterBill,
}
