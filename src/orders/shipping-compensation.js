'use strict'

/**
 * 4PX compensation desk — the working list of tracking numbers the operator
 * will send to 4PX for refund / compensation on abnormal parcels.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------------------------------------------------------------
 * The Shipping board already knows which parcels are disposed, stuck, delayed
 * or exceptional, and each row already has a private claim note. That is not
 * the same question as "which tracking numbers am I sending to 4PX today?".
 *
 * Operators copy numbers out of the board, a 4PX ticket, or a portal dump and
 * need a durable, de-duplicated list they control: add, mark contacted, mark
 * paid, copy the paste-list for the 4PX conversation. Numbers that are not
 * (yet) on the parcel board still belong here — a 4PX ticket does not wait
 * for our cache to catch up.
 *
 * This table is the source of truth for that working set. Receipt claim
 * columns stay the per-parcel editor on the board; we only JOIN them for
 * context (shop, buyer, health) when a tracking number matches.
 *
 * Contract:
 *   · tracking_key is unique, canonical (uppercase, no spaces/hyphens)
 *   · classic 4PX ids (`4PX` + 6–40 alphanumerics) are always accepted
 *   · other identifier-shaped tokens are accepted only when they uniquely
 *     match an active 4PX parcel (so a ticket dump cannot create junk rows)
 *   · bulk add is partial-success: valid new rows land, duplicates and
 *     invalid tokens are reported, never rolled back
 */

const { normalizeFourpxTrackingCode, normalizeTrackingCode } = require('../tracking/validation')

const STATUSES = Object.freeze(['queued', 'contacted', 'compensated', 'declined', 'closed'])
const OPEN_STATUSES = Object.freeze(['queued', 'contacted'])
const SETTLED_STATUSES = Object.freeze(['compensated', 'declined', 'closed'])
const REASONS = Object.freeze(['disposed', 'stuck', 'delayed', 'exception', 'other'])
const STATUS_FILTERS = Object.freeze(['all', 'open', 'queued', 'contacted', 'settled', ...SETTLED_STATUSES])

const MAX_NOTE_LENGTH = 2000
const MAX_ADD_PER_REQUEST = 200
const MAX_OPEN_CASES = 2000
const MAX_LIST = 500
const MAX_ACTOR_LENGTH = 80
const MAX_TRACKING_KEY_LENGTH = 50

/** Classic 4PX public tracking codes. Same shape the buyer-notice scanner uses. */
const FOURPX_TRACKING_RE = /4PX[A-Za-z0-9]{6,40}/gi
const IDENTIFIER_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{7,49}$/

const PARCEL_TRACKING_SQL = `COALESCE(
  CASE WHEN r.tracking_code LIKE '4PX%' THEN NULLIF(TRIM(r.tracking_code), '') END,
  NULLIF(TRIM(r.fourpx_tracking_no), ''),
  CASE WHEN r.fourpx_consignment_no IS NOT NULL THEN NULLIF(TRIM(r.tracking_code), '') END,
  NULL
)`

const ACTIVE_FOURPX_SQL = `(
  (r.fourpx_consignment_no IS NOT NULL OR r.tracking_code LIKE '4PX%' OR NULLIF(TRIM(r.fourpx_tracking_no), '') IS NOT NULL)
  AND COALESCE(r.fourpx_order_status, '') != 'cancelled'
  AND r.archived_at IS NULL
)`

class CompensationError extends Error {
	constructor(message, { status = 400, code = 'COMPENSATION_INVALID' } = {}) {
		super(message)
		this.name = 'CompensationError'
		this.status = status
		this.code = code
	}
}

function ensureSchema(db) {
	if (!db || typeof db.exec !== 'function') {
		throw new TypeError('A SQLite database is required.')
	}
	db.exec(`
		CREATE TABLE IF NOT EXISTS shipping_compensation_cases (
			id             INTEGER PRIMARY KEY AUTOINCREMENT,
			tracking_no    TEXT    NOT NULL,
			tracking_key   TEXT    NOT NULL,
			receipt_id     INTEGER,
			status         TEXT    NOT NULL DEFAULT 'queued',
			reason         TEXT,
			note           TEXT,
			contacted_at   INTEGER,
			resolved_at    INTEGER,
			created_by     TEXT,
			created_at     INTEGER NOT NULL,
			updated_by     TEXT,
			updated_at     INTEGER NOT NULL,
			CHECK (length(tracking_no) BETWEEN 8 AND 50),
			CHECK (length(tracking_key) BETWEEN 8 AND 50),
			CHECK (status IN ('queued', 'contacted', 'compensated', 'declined', 'closed')),
			CHECK (reason IS NULL OR reason IN ('disposed', 'stuck', 'delayed', 'exception', 'other')),
			CHECK (note IS NULL OR length(note) <= ${MAX_NOTE_LENGTH})
		);
		CREATE UNIQUE INDEX IF NOT EXISTS idx_ship_comp_tracking_key
			ON shipping_compensation_cases(tracking_key);
		CREATE INDEX IF NOT EXISTS idx_ship_comp_status_updated
			ON shipping_compensation_cases(status, updated_at DESC, id DESC);
		CREATE INDEX IF NOT EXISTS idx_ship_comp_receipt
			ON shipping_compensation_cases(receipt_id);
	`)
}

function nowSec(now) {
	if (typeof now === 'function') now = now()
	if (now instanceof Date) return Math.floor(now.getTime() / 1000)
	if (Number.isFinite(Number(now)) && Number(now) > 1e9 && Number(now) < 1e12) {
		return Math.floor(Number(now))
	}
	if (Number.isFinite(Number(now)) && Number(now) > 1e12) {
		return Math.floor(Number(now) / 1000)
	}
	return Math.floor(Date.now() / 1000)
}

function sanitizeActor(actor) {
	const raw = actor == null ? '' : String(actor).trim()
	if (!raw) return null
	return raw.slice(0, MAX_ACTOR_LENGTH)
}

function canonicalizeTrackingKey(raw) {
	return String(raw || '')
		.toUpperCase()
		.replace(/[\s\-]/g, '')
}

function isClassicFourpxTracking(key) {
	try {
		return normalizeFourpxTrackingCode(key) === key
	} catch {
		return false
	}
}

function isIdentifierToken(token) {
	const trimmed = String(token || '').trim()
	if (!trimmed || trimmed.length > MAX_TRACKING_KEY_LENGTH) return false
	if (!IDENTIFIER_TOKEN_RE.test(trimmed)) return false
	try {
		normalizeTrackingCode(trimmed)
		return true
	} catch {
		return false
	}
}

/**
 * Pull candidate tracking numbers out of free text or an array.
 *
 * Classic `4PX…` ids are harvested with a regex so a 4PX ticket dump, a CSV
 * column, or a board copy all work. Remaining identifier-shaped tokens are
 * kept for a later receipt lookup — they are not stored unless they match.
 *
 * @param {string|string[]} input
 * @returns {{ classic: string[], lookup: string[] }} canonical keys, first-seen order
 */
function extractTrackingCandidates(input) {
	const chunks = Array.isArray(input) ? input.map((v) => (v == null ? '' : String(v))) : [input == null ? '' : String(input)]
	const classic = []
	const lookup = []
	const seen = new Set()

	const pushClassic = (raw) => {
		const key = canonicalizeTrackingKey(raw)
		if (!key || seen.has(key) || !isClassicFourpxTracking(key)) return
		seen.add(key)
		classic.push(key)
	}
	const pushLookup = (raw) => {
		const key = canonicalizeTrackingKey(raw)
		if (!key || seen.has(key)) return
		if (isClassicFourpxTracking(key)) {
			pushClassic(key)
			return
		}
		// Names, shop titles and currency labels sneak into ticket dumps.
		// Real 4PX lookup identifiers always carry several digits (a brand
		// name like Y2KiPhoneCases has one) and are never a money amount.
		if ((key.match(/\d/g) || []).length < 4) return
		if (/^(CNY|USD|EUR|GBP|CAD|AUD)[\d.]+$/i.test(key)) return
		if (/^\d+(\.\d+)?$/.test(key)) return
		if (!isIdentifierToken(raw) && !isIdentifierToken(key)) return
		seen.add(key)
		lookup.push(key)
	}

	for (const chunk of chunks) {
		if (!chunk) continue
		FOURPX_TRACKING_RE.lastIndex = 0
		for (const match of chunk.matchAll(FOURPX_TRACKING_RE)) pushClassic(match[0])
		for (const token of chunk.split(/[\s,;|，、]+/)) {
			const trimmed = token.trim()
			if (!trimmed) continue
			pushLookup(trimmed)
		}
	}

	return { classic, lookup }
}

function normalizeStatus(value, { required = false } = {}) {
	if (value == null || value === '') {
		if (required) throw new CompensationError('A status is required.', { code: 'COMPENSATION_STATUS_REQUIRED' })
		return null
	}
	if (typeof value !== 'string') {
		throw new CompensationError('Status must be text.', { code: 'COMPENSATION_STATUS_TYPE' })
	}
	const status = value.trim().toLowerCase()
	if (!STATUSES.includes(status)) {
		throw new CompensationError(`Invalid status "${status}". Allowed: ${STATUSES.join(', ')}.`, {
			code: 'COMPENSATION_STATUS_INVALID',
		})
	}
	return status
}

function normalizeFilter(value) {
	const raw = value == null || value === '' ? 'all' : String(value).trim().toLowerCase()
	if (!STATUS_FILTERS.includes(raw)) {
		throw new CompensationError(`Invalid status filter "${raw}". Allowed: ${STATUS_FILTERS.join(', ')}.`, {
			code: 'COMPENSATION_FILTER_INVALID',
		})
	}
	return raw
}

function normalizeReason(value) {
	if (value == null || value === '') return null
	if (typeof value !== 'string') {
		throw new CompensationError('Reason must be text.', { code: 'COMPENSATION_REASON_TYPE' })
	}
	const reason = value.trim().toLowerCase()
	if (!REASONS.includes(reason)) {
		throw new CompensationError(`Invalid reason "${reason}". Allowed: ${REASONS.join(', ')}.`, {
			code: 'COMPENSATION_REASON_INVALID',
		})
	}
	return reason
}

function normalizeNote(value) {
	if (value == null) return null
	if (typeof value !== 'string') {
		throw new CompensationError('Note must be text.', { code: 'COMPENSATION_NOTE_TYPE' })
	}
	if (value.length > MAX_NOTE_LENGTH) {
		throw new CompensationError(`Note must be ${MAX_NOTE_LENGTH} characters or fewer.`, {
			code: 'COMPENSATION_NOTE_TOO_LONG',
		})
	}
	const trimmed = value.trim()
	return trimmed ? trimmed : null
}

function parsePositiveId(value, field = 'id') {
	const id = Number(value)
	if (!Number.isInteger(id) || id <= 0) {
		throw new CompensationError(`A positive ${field} is required.`, { status: 400, code: 'COMPENSATION_ID_INVALID' })
	}
	return id
}

function reasonFromParcel(row) {
	if (!row) return null
	if (Number(row.tracking_is_disposed) === 1) return 'disposed'
	if (row.tracking_health === 'critical') return 'stuck'
	if (row.tracking_health === 'warning') return 'delayed'
	if (row.tracking_status === 'exception') return 'exception'
	return null
}

const PARCEL_LOOKUP_SQL = `
	SELECT
		r.receipt_id,
		r.shop_id,
		s.shop_name,
		r.name AS buyer_name,
		${PARCEL_TRACKING_SQL} AS tracking_no,
		r.tracking_status,
		r.tracking_health,
		r.tracking_health_reason,
		r.tracking_is_disposed,
		r.fourpx_freight_amount,
		r.fourpx_freight_currency,
		r.shipment_notified_at,
		r.etsy_created_at
	FROM receipts r
	LEFT JOIN shops s ON s.shop_id = r.shop_id
	WHERE ${ACTIVE_FOURPX_SQL}
	  AND (
		UPPER(REPLACE(REPLACE(TRIM(COALESCE(r.tracking_code, '')), ' ', ''), '-', '')) = @key
		OR UPPER(REPLACE(REPLACE(TRIM(COALESCE(r.fourpx_tracking_no, '')), ' ', ''), '-', '')) = @key
		OR UPPER(REPLACE(REPLACE(TRIM(COALESCE(r.fourpx_consignment_no, '')), ' ', ''), '-', '')) = @key
	  )
	ORDER BY COALESCE(r.shipment_notified_at, r.etsy_created_at, 0) DESC, r.receipt_id DESC
	LIMIT 2
`

function lookupParcel(db, trackingKey) {
	const rows = db.prepare(PARCEL_LOOKUP_SQL).all({ key: trackingKey })
	if (!rows.length) return null
	if (rows.length > 1) {
		// Two live parcels sharing an identifier is rare; still pick the newest
		// rather than refusing the add — the operator can correct the link later.
		return rows[0]
	}
	return rows[0]
}

function shapeCase(row) {
	if (!row) return null
	const receiptId = row.receipt_id != null ? Number(row.receipt_id) : null
	const linked = Number.isInteger(receiptId) && receiptId > 0 && (row.parcel_present == null || Number(row.parcel_present) === 1)
	return {
		id: Number(row.id),
		tracking_no: row.tracking_no,
		status: row.status,
		reason: row.reason || null,
		note: row.note || null,
		receipt_id: linked ? receiptId : null,
		shop_id: linked ? row.shop_id || null : null,
		shop_name: linked ? row.shop_name || null : null,
		buyer_name: linked ? row.buyer_name || null : null,
		parcel_status: linked ? row.tracking_status || null : null,
		parcel_health: linked ? row.tracking_health || null : null,
		is_disposed: linked ? Number(row.tracking_is_disposed) === 1 : false,
		tracking_health_reason: linked ? row.tracking_health_reason || null : null,
		freight_amount: linked && row.fourpx_freight_amount != null ? Number(row.fourpx_freight_amount) : null,
		freight_currency: linked ? row.fourpx_freight_currency || null : null,
		linked: !!linked,
		created_at: row.created_at != null ? Number(row.created_at) : null,
		updated_at: row.updated_at != null ? Number(row.updated_at) : null,
		contacted_at: row.contacted_at != null ? Number(row.contacted_at) : null,
		resolved_at: row.resolved_at != null ? Number(row.resolved_at) : null,
		created_by: row.created_by || null,
		updated_by: row.updated_by || null,
	}
}

const CASE_SELECT_SQL = `
	SELECT
		c.id, c.tracking_no, c.tracking_key, c.status, c.reason, c.note,
		c.receipt_id, c.contacted_at, c.resolved_at,
		c.created_by, c.created_at, c.updated_by, c.updated_at,
		r.shop_id, s.shop_name, r.name AS buyer_name,
		r.tracking_status, r.tracking_health, r.tracking_health_reason,
		r.tracking_is_disposed, r.fourpx_freight_amount, r.fourpx_freight_currency,
		CASE WHEN r.receipt_id IS NULL THEN 0 ELSE 1 END AS parcel_present
	FROM shipping_compensation_cases c
	LEFT JOIN receipts r ON r.receipt_id = c.receipt_id
	LEFT JOIN shops s ON s.shop_id = r.shop_id
`

function getCaseById(db, id) {
	ensureSchema(db)
	const row = db.prepare(`${CASE_SELECT_SQL} WHERE c.id = ?`).get(id)
	return shapeCase(row)
}

function countOpenCases(db) {
	const row = db
		.prepare(`SELECT COUNT(*) AS n FROM shipping_compensation_cases WHERE status IN ('queued', 'contacted')`)
		.get()
	return Number(row && row.n) || 0
}

function summarizeCases(db) {
	const row = db
		.prepare(
			`
		SELECT
			COUNT(*) AS total,
			SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
			SUM(CASE WHEN status = 'contacted' THEN 1 ELSE 0 END) AS contacted,
			SUM(CASE WHEN status = 'compensated' THEN 1 ELSE 0 END) AS compensated,
			SUM(CASE WHEN status = 'declined' THEN 1 ELSE 0 END) AS declined,
			SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed
		FROM shipping_compensation_cases
	`,
		)
		.get()
	const queued = Number(row && row.queued) || 0
	const contacted = Number(row && row.contacted) || 0
	const compensated = Number(row && row.compensated) || 0
	const declined = Number(row && row.declined) || 0
	const closed = Number(row && row.closed) || 0
	return {
		total: Number(row && row.total) || 0,
		queued,
		contacted,
		compensated,
		declined,
		closed,
		open: queued + contacted,
		settled: compensated + declined + closed,
	}
}

function statusWhere(filter, params) {
	if (filter === 'all') return '1 = 1'
	if (filter === 'open') {
		params.open1 = 'queued'
		params.open2 = 'contacted'
		return 'c.status IN (@open1, @open2)'
	}
	if (filter === 'settled') {
		params.s1 = 'compensated'
		params.s2 = 'declined'
		params.s3 = 'closed'
		return 'c.status IN (@s1, @s2, @s3)'
	}
	params.status = filter
	return 'c.status = @status'
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ status?: string, q?: string, limit?: number, offset?: number }} [opts]
 */
function listCases(db, opts = {}) {
	ensureSchema(db)
	const filter = normalizeFilter(opts.status)
	const rawLimit = Number(opts.limit)
	const rawOffset = Number(opts.offset)
	const params = {
		limit: Number.isFinite(rawLimit) ? Math.min(MAX_LIST, Math.max(1, Math.floor(rawLimit))) : 200,
		offset: Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0,
	}
	const where = [statusWhere(filter, params)]
	const q = opts.q == null ? '' : String(opts.q).trim()
	if (q) {
		if (q.length > 80) {
			throw new CompensationError('Search must be 80 characters or fewer.', { code: 'COMPENSATION_SEARCH_TOO_LONG' })
		}
		params.q = `%${q.replace(/[%_]/g, '')}%`
		where.push(`(
			c.tracking_no LIKE @q
			OR IFNULL(c.note, '') LIKE @q
			OR IFNULL(s.shop_name, '') LIKE @q
			OR IFNULL(r.name, '') LIKE @q
		)`)
	}
	const W = where.join(' AND ')
	const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM shipping_compensation_cases c LEFT JOIN receipts r ON r.receipt_id = c.receipt_id LEFT JOIN shops s ON s.shop_id = r.shop_id WHERE ${W}`).get(params).n) || 0
	const rows = db
		.prepare(
			`
		${CASE_SELECT_SQL}
		WHERE ${W}
		ORDER BY
			CASE c.status
				WHEN 'queued' THEN 0
				WHEN 'contacted' THEN 1
				WHEN 'compensated' THEN 2
				WHEN 'declined' THEN 3
				ELSE 4
			END,
			c.updated_at DESC,
			c.id DESC
		LIMIT @limit OFFSET @offset
	`,
		)
		.all(params)
	const trackingKeys = db.prepare('SELECT tracking_key FROM shipping_compensation_cases').all().map((row) => row.tracking_key)
	return {
		cases: rows.map(shapeCase),
		total,
		limit: params.limit,
		offset: params.offset,
		filter,
		tracking_keys: trackingKeys,
		summary: summarizeCases(db),
	}
}

function timestampsForStatus(status, existing, at) {
	let contactedAt = existing ? existing.contacted_at : null
	let resolvedAt = existing ? existing.resolved_at : null
	if (status === 'queued') {
		contactedAt = null
		resolvedAt = null
	} else if (status === 'contacted') {
		if (!contactedAt) contactedAt = at
		resolvedAt = null
	} else if (SETTLED_STATUSES.includes(status)) {
		if (!contactedAt) contactedAt = at
		if (!resolvedAt) resolvedAt = at
	}
	return { contactedAt, resolvedAt }
}

function insertCase(db, { trackingKey, parcel, status, reason, note, actor, at }) {
	const displayNo = (parcel && parcel.tracking_no && canonicalizeTrackingKey(parcel.tracking_no) === trackingKey
		? String(parcel.tracking_no).trim()
		: trackingKey)
	const info = db
		.prepare(
			`
		INSERT INTO shipping_compensation_cases (
			tracking_no, tracking_key, receipt_id, status, reason, note,
			contacted_at, resolved_at, created_by, created_at, updated_by, updated_at
		) VALUES (
			@tracking_no, @tracking_key, @receipt_id, @status, @reason, @note,
			@contacted_at, @resolved_at, @created_by, @created_at, @updated_by, @updated_at
		)
	`,
		)
		.run({
			tracking_no: displayNo,
			tracking_key: trackingKey,
			receipt_id: parcel ? parcel.receipt_id : null,
			status,
			reason: reason || reasonFromParcel(parcel),
			note,
			contacted_at: timestampsForStatus(status, null, at).contactedAt,
			resolved_at: timestampsForStatus(status, null, at).resolvedAt,
			created_by: actor,
			created_at: at,
			updated_by: actor,
			updated_at: at,
		})
	return getCaseById(db, Number(info.lastInsertRowid))
}

/**
 * Add one or many tracking numbers to the desk.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ tracking_numbers?: string|string[], tracking_number?: string, note?: string, reason?: string, status?: string }} body
 * @param {{ actor?: string, now?: number|Date|Function }} [opts]
 */
function addCases(db, body = {}, opts = {}) {
	ensureSchema(db)
	const actor = sanitizeActor(opts.actor)
	const at = nowSec(opts.now)
	const status = normalizeStatus(body.status) || 'queued'
	const reason = normalizeReason(body.reason)
	const note = Object.prototype.hasOwnProperty.call(body, 'note') ? normalizeNote(body.note) : null

	const rawInput = body.tracking_numbers != null ? body.tracking_numbers : body.tracking_number
	if (rawInput != null && typeof rawInput !== 'string' && !Array.isArray(rawInput)) {
		throw new CompensationError('Tracking numbers must be text or a list of tracking numbers.', {
			code: 'COMPENSATION_INPUT_TYPE',
		})
	}
	if (rawInput == null || (typeof rawInput === 'string' && !rawInput.trim()) || (Array.isArray(rawInput) && rawInput.length === 0)) {
		throw new CompensationError('Paste at least one 4PX tracking number.', { code: 'COMPENSATION_EMPTY' })
	}

	const { classic, lookup } = extractTrackingCandidates(rawInput)
	const invalid = []
	const duplicates = []
	const added = []

	const lookupKeys = []
	for (const key of lookup) {
		const parcel = lookupParcel(db, key)
		if (parcel) lookupKeys.push(key)
		else invalid.push({ tracking: key, error: 'Not a recognised 4PX tracking number, and it does not match a parcel on the board.' })
	}

	const keys = [...classic, ...lookupKeys]
	if (!keys.length) {
		throw new CompensationError(
			invalid.length
				? 'None of those look like 4PX tracking numbers. Paste 4PX… codes, or an identifier that already exists on the parcel board.'
				: 'Paste at least one 4PX tracking number.',
			{ code: 'COMPENSATION_NONE_VALID', details: { invalid } },
		)
	}
	if (keys.length > MAX_ADD_PER_REQUEST) {
		throw new CompensationError(`Add at most ${MAX_ADD_PER_REQUEST} tracking numbers at a time.`, {
			code: 'COMPENSATION_TOO_MANY',
		})
	}

	const existingByKey = new Map()
	const placeholders = keys.map((_, i) => `@k${i}`).join(',')
	const existingParams = {}
	keys.forEach((key, i) => {
		existingParams[`k${i}`] = key
	})
	for (const row of db.prepare(`SELECT id, tracking_key, tracking_no, status FROM shipping_compensation_cases WHERE tracking_key IN (${placeholders})`).all(existingParams)) {
		existingByKey.set(row.tracking_key, row)
	}

	const newKeys = keys.filter((key) => !existingByKey.has(key))
	const openNow = countOpenCases(db)
	const wouldOpen = status === 'queued' || status === 'contacted' ? newKeys.length : 0
	if (openNow + wouldOpen > MAX_OPEN_CASES) {
		throw new CompensationError(`The compensation desk already has ${openNow.toLocaleString()} open tracking numbers (limit ${MAX_OPEN_CASES.toLocaleString()}). Settle or remove some before adding more.`, {
			code: 'COMPENSATION_CAPACITY',
		})
	}

	const persist = db.transaction(() => {
		for (const key of keys) {
			const already = existingByKey.get(key)
			if (already) {
				duplicates.push({
					id: Number(already.id),
					tracking_no: already.tracking_no,
					status: already.status,
				})
				continue
			}
			const parcel = lookupParcel(db, key)
			try {
				const created = insertCase(db, { trackingKey: key, parcel, status, reason, note, actor, at })
				added.push(created)
				existingByKey.set(key, { id: created.id, tracking_key: key, tracking_no: created.tracking_no, status: created.status })
			} catch (err) {
				if (err && (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.code === 'SQLITE_CONSTRAINT')) {
					const row = db.prepare('SELECT id, tracking_no, status FROM shipping_compensation_cases WHERE tracking_key = ?').get(key)
					if (row) {
						duplicates.push({ id: Number(row.id), tracking_no: row.tracking_no, status: row.status })
						continue
					}
				}
				throw err
			}
		}
	})
	persist()

	return {
		added,
		duplicates,
		invalid,
		added_count: added.length,
		duplicate_count: duplicates.length,
		invalid_count: invalid.length,
		summary: summarizeCases(db),
	}
}

function patchCase(db, id, body = {}, opts = {}) {
	ensureSchema(db)
	const caseId = parsePositiveId(id)
	const actor = sanitizeActor(opts.actor)
	const at = nowSec(opts.now)
	const existing = db.prepare('SELECT * FROM shipping_compensation_cases WHERE id = ?').get(caseId)
	if (!existing) {
		throw new CompensationError('That tracking number is not on the compensation desk.', {
			status: 404,
			code: 'COMPENSATION_NOT_FOUND',
		})
	}

	const patch = {}
	if (Object.prototype.hasOwnProperty.call(body, 'status')) {
		patch.status = normalizeStatus(body.status, { required: true })
	}
	if (Object.prototype.hasOwnProperty.call(body, 'note')) {
		patch.note = normalizeNote(body.note)
	}
	if (Object.prototype.hasOwnProperty.call(body, 'reason')) {
		patch.reason = normalizeReason(body.reason)
	}
	if (!Object.keys(patch).length) {
		throw new CompensationError('Provide status, note, and/or reason.', { code: 'COMPENSATION_EMPTY_PATCH' })
	}

	const nextStatus = patch.status || existing.status
	const times = timestampsForStatus(nextStatus, existing, at)
	db.prepare(
		`
		UPDATE shipping_compensation_cases SET
			status = @status,
			note = @note,
			reason = @reason,
			contacted_at = @contacted_at,
			resolved_at = @resolved_at,
			updated_by = @updated_by,
			updated_at = @updated_at
		WHERE id = @id
	`,
	).run({
		id: caseId,
		status: nextStatus,
		note: Object.prototype.hasOwnProperty.call(patch, 'note') ? patch.note : existing.note,
		reason: Object.prototype.hasOwnProperty.call(patch, 'reason') ? patch.reason : existing.reason,
		contacted_at: times.contactedAt,
		resolved_at: times.resolvedAt,
		updated_by: actor,
		updated_at: at,
	})
	return getCaseById(db, caseId)
}

function removeCase(db, id) {
	ensureSchema(db)
	const caseId = parsePositiveId(id)
	const existing = db.prepare('SELECT id, tracking_no FROM shipping_compensation_cases WHERE id = ?').get(caseId)
	if (!existing) {
		throw new CompensationError('That tracking number is not on the compensation desk.', {
			status: 404,
			code: 'COMPENSATION_NOT_FOUND',
		})
	}
	db.prepare('DELETE FROM shipping_compensation_cases WHERE id = ?').run(caseId)
	return { id: caseId, tracking_no: existing.tracking_no, summary: summarizeCases(db) }
}

/**
 * Plain-text paste list for the 4PX portal / ticket. One tracking number per line.
 * @param {Array<{ tracking_no?: string }>} cases
 */
function formatTrackingList(cases) {
	const seen = new Set()
	const lines = []
	for (const row of cases || []) {
		const no = String(row && row.tracking_no ? row.tracking_no : '').trim()
		if (!no || seen.has(no)) continue
		seen.add(no)
		lines.push(no)
	}
	return lines.join('\n')
}

/**
 * Ready-to-paste note for a 4PX compensation ticket.
 * @param {Array<object>} cases
 */
function formatFourpxMessage(cases) {
	const rows = (cases || []).filter((row) => row && row.tracking_no)
	const lines = ['请协助处理以下异常件的赔偿/退款：', 'Please review the following abnormal parcels for refund / compensation:', '']
	rows.forEach((row, i) => {
		const bits = [row.tracking_no]
		if (row.reason) bits.push(row.reason)
		if (row.shop_name || row.buyer_name) bits.push([row.shop_name, row.buyer_name].filter(Boolean).join(' · '))
		if (row.note) bits.push(row.note)
		lines.push(`${i + 1}. ${bits.join('  —  ')}`)
	})
	if (!rows.length) return ''
	return lines.join('\n')
}

function jsonError(res, error) {
	const status = Number(error && error.status) || 500
	const payload = { error: error && error.message ? error.message : 'Compensation desk failed.' }
	if (error && error.code) payload.code = error.code
	if (error && error.details) payload.details = error.details
	res.status(status).json(payload)
}

function installRoutes(app, { db } = {}) {
	if (!app || typeof app.get !== 'function') {
		throw new TypeError('An Express application is required.')
	}
	if (!db || typeof db.prepare !== 'function') {
		throw new TypeError('A SQLite database is required.')
	}
	ensureSchema(db)
	const actorOf = (req) => (req.auth && (req.auth.user || req.auth.role)) || null

	app.get('/api/4px/compensation-cases', (req, res) => {
		try {
			res.set('Cache-Control', 'no-store')
			const result = listCases(db, {
				status: req.query.status,
				q: req.query.q,
				limit: req.query.limit,
				offset: req.query.offset,
			})
			res.json({ ...result, generated_at: Math.floor(Date.now() / 1000) })
		} catch (error) {
			jsonError(res, error)
		}
	})

	app.post('/api/4px/compensation-cases', (req, res) => {
		try {
			const result = addCases(db, req.body || {}, { actor: actorOf(req) })
			res.status(result.added_count ? 201 : 200).json({ success: true, ...result, generated_at: Math.floor(Date.now() / 1000) })
		} catch (error) {
			jsonError(res, error)
		}
	})

	app.patch('/api/4px/compensation-cases/:id', (req, res) => {
		try {
			const row = patchCase(db, req.params.id, req.body || {}, { actor: actorOf(req) })
			res.json({ success: true, case: row, summary: summarizeCases(db) })
		} catch (error) {
			jsonError(res, error)
		}
	})

	app.delete('/api/4px/compensation-cases/:id', (req, res) => {
		try {
			const result = removeCase(db, req.params.id)
			res.json({ success: true, ...result })
		} catch (error) {
			jsonError(res, error)
		}
	})
}

module.exports = {
	STATUSES,
	OPEN_STATUSES,
	SETTLED_STATUSES,
	REASONS,
	STATUS_FILTERS,
	MAX_NOTE_LENGTH,
	MAX_ADD_PER_REQUEST,
	MAX_OPEN_CASES,
	CompensationError,
	ensureSchema,
	extractTrackingCandidates,
	canonicalizeTrackingKey,
	listCases,
	addCases,
	patchCase,
	removeCase,
	getCaseById,
	summarizeCases,
	formatTrackingList,
	formatFourpxMessage,
	installRoutes,
}
