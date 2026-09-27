'use strict'

/**
 * address-review.js — stage 1 of military / Australia shipping: do not shop
 * this order until an owner has looked at the destination.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------------------------------------------------------------
 * Two destination classes routinely fail or stall at the carrier:
 *
 *   1. US military mail (APO / FPO / DPO, PSC/CMR/UNIT BOX, AA/AE/AP, BFPO).
 *      4PX rejects these at label-create time — after the products are already
 *      bought. The example that drove this:
 *        Tyra Jackson
 *        PSC 80 BOX 15628
 *        APO, AP 96367-0059
 *        United States
 *
 *   2. Every Australia address. Those lanes need a human to confirm the
 *      destination will actually accept the parcel before anyone walks a stall.
 *
 * Process: detect → Address review queue → owner decides:
 *   • Mark reviewed → address is OK; employees may shop.
 *   • Can't ship    → Issues / on hold (`shipping_address`).
 * Orders already on Issues / on hold are treated as already reviewed and
 * never sit in this queue. The Address review tab splits To review (live
 * hold) from Reviewed (owner already marked the address OK).
 *
 * The hold is receipt-level (the whole order ships to one address), not a
 * per-line fulfilment issue. It is stamped on every Etsy sync and manual
 * create/update, survives re-sync, re-opens when the address changes after a
 * prior review, and is the only thing that may release it (an owner POST).
 *
 * Consumers import the SQL fragments and the shopping-block helper from here so
 * the buy queue, Route, Shopping Mode, pack/seal, and 4PX create can never
 * disagree about which orders are held.
 */

const crypto = require('crypto')

const REASON_MILITARY = 'military'
const REASON_AUSTRALIA = 'australia'
const REASONS = Object.freeze([REASON_MILITARY, REASON_AUSTRALIA])

const EVENT_OPENED = 'opened'
const EVENT_UPDATED = 'updated'
const EVENT_CLEARED = 'cleared'
const EVENT_REOPENED = 'reopened'
const EVENT_AUTO_RELEASED = 'auto_released'

const ACTOR_SYNC = 'sync'
const ACTOR_SYSTEM = 'system'

const REASON_LABELS = Object.freeze({
	[REASON_MILITARY]: 'Military address',
	[REASON_AUSTRALIA]: 'Australia',
})

/** Columns this module owns. Never written by upsertReceipt's INSERT list. */
const RECEIPT_COLUMNS = Object.freeze([
	['address_review_required_at', 'INTEGER'],
	['address_review_cleared_at', 'INTEGER'],
	['address_review_cleared_by', 'TEXT'],
	['address_review_reason', 'TEXT'],
	['address_review_note', 'TEXT'],
	['address_review_fingerprint', 'TEXT'],
])

const API_INTERNAL_FIELDS = Object.freeze([
	'address_review_required_at',
	'address_review_cleared_at',
	'address_review_cleared_by',
	'address_review_reason',
	'address_review_note',
	'address_review_fingerprint',
])

const NOTE_MAX = 500

// USPS overseas military ZIP ranges (5-digit):
//   AE (Armed Forces Europe / Middle East / Africa / Canada): 090xx–098xx
//   AA (Armed Forces Americas):                               340xx
//   AP (Armed Forces Pacific):                                962xx–966xx
const MILITARY_ZIP_RANGES = Object.freeze([
	[9000, 9899],
	[34000, 34099],
	[96200, 96699],
])

const MILITARY_STATES = new Set(['AA', 'AE', 'AP'])
const APO_CITIES = new Set(['APO', 'FPO', 'DPO'])

const AU_COUNTRIES = new Set(['AU', 'AUS', 'AUSTRALIA', 'COMMONWEALTH OF AUSTRALIA'])
const US_COUNTRIES = new Set(['US', 'USA', 'UNITED STATES', 'UNITED STATES OF AMERICA'])

const RE_APO_TOKEN = /\b(?:APO|FPO|DPO)\b/
const RE_BFPO = /\bBFPO\b/
const RE_CFPO = /\bCFPO\b/
const RE_ARMED_FORCES = /\bARMED\s+FORCES\b/
const RE_POST_OFFICE = /\b(?:ARMY|FLEET|DIPLOMATIC)\s+POST\s+OFFICE\b/
const RE_PSC = /\bPSC\s+\d+(?:\s+BOX\s+\d+)?\b/
const RE_CMR = /\bCMR\s+\d+(?:\s+BOX\s+\d+)?\b/
const RE_UNIT_BOX = /\bUNIT\s+\d+\s+BOX\s+\d+\b/

function assertAlias(alias) {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new TypeError('Invalid SQL alias')
	return alias
}

function str(value) {
	if (value == null) return ''
	return String(value).trim()
}

function upper(value) {
	return str(value).toUpperCase()
}

function collapseWs(value) {
	return upper(value).replace(/\s+/g, ' ').trim()
}

function canonicalCountry(iso) {
	const c = upper(iso)
	if (US_COUNTRIES.has(c)) return 'US'
	if (AU_COUNTRIES.has(c)) return 'AU'
	return c
}

function canonicalMilitaryCity(city) {
	const c = collapseWs(city)
	if (!c) return c
	const first = c.split(/[^A-Z]+/)[0]
	return APO_CITIES.has(first) ? first : c
}

function canonicalMilitaryState(state) {
	const s = collapseWs(state)
	if (!s) return s
	const token = s.split(/[^A-Z]+/).find((t) => MILITARY_STATES.has(t))
	return token || s
}

/**
 * Collapse an incoming address (Etsy receipt, receipts row, or manual payload)
 * onto one canonical shape so detect / fingerprint / persist never read different
 * field names.
 *
 * @param {object} input
 * @returns {{name:string, first_line:string, second_line:string, city:string, state:string, zip:string, country_iso:string, formatted_address:string}}
 */
function normalizeAddress(input) {
	const src = input && typeof input === 'object' ? input : {}
	const country = upper(src.country_iso || src.shipping_country_iso || src.country)
	return {
		name: str(src.name || src.buyer_name),
		first_line: str(src.first_line || src.shipping_first_line),
		second_line: str(src.second_line || src.shipping_second_line),
		city: str(src.city || src.shipping_city),
		state: str(src.state || src.shipping_state),
		zip: str(src.zip || src.shipping_zip),
		country_iso: country,
		formatted_address: str(src.formatted_address),
	}
}

function hasEnoughAddress(addr) {
	const a = normalizeAddress(addr)
	return !!(a.country_iso || a.city || a.state || a.zip || a.first_line || a.second_line || a.formatted_address)
}

function zip5(zip) {
	const digits = String(zip || '').replace(/\D/g, '')
	if (digits.length < 5) return null
	return digits.slice(0, 5)
}

function zip5Number(zip) {
	const five = zip5(zip)
	if (!five) return null
	const n = parseInt(five, 10)
	return Number.isFinite(n) ? n : null
}

function isMilitaryZip(zip) {
	const n = zip5Number(zip)
	if (n == null) return false
	return MILITARY_ZIP_RANGES.some(([lo, hi]) => n >= lo && n <= hi)
}

function countryLooksUS(iso) {
	return !iso || US_COUNTRIES.has(iso)
}

function countryIsAustralia(iso) {
	return AU_COUNTRIES.has(iso)
}

function stateIsMilitary(state) {
	const s = upper(state)
	if (MILITARY_STATES.has(s)) return true
	// Etsy sometimes stores "AP 96367" or "APO AP" in the state field.
	const token = s.split(/[^A-Z]+/).find((t) => MILITARY_STATES.has(t) || APO_CITIES.has(t))
	return !!token
}

function cityIsMilitary(city) {
	const c = upper(city)
	if (!c) return false
	if (APO_CITIES.has(c)) return true
	const first = c.split(/[^A-Z]+/)[0]
	return APO_CITIES.has(first)
}

function streetHaystack(addr) {
	const a = normalizeAddress(addr)
	return [a.first_line, a.second_line, a.city, a.state, a.zip, a.formatted_address]
		.filter(Boolean)
		.join('\n')
		.toUpperCase()
}

function formattedLines(formatted) {
	return str(formatted)
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean)
}

function isAustralia(addr) {
	const a = normalizeAddress(addr)
	if (countryIsAustralia(a.country_iso)) return true
	const lines = formattedLines(a.formatted_address).map((l) => l.toUpperCase())
	if (lines.some((l) => AU_COUNTRIES.has(l))) return true
	// A trailing ", AU" / " AUSTRALIA" on the last line when country_iso is empty.
	if (!a.country_iso) {
		const last = lines[lines.length - 1] || ''
		if (/\bAUSTRALIA\b/.test(last)) return true
		if (/(^|,\s*)AU$/.test(last)) return true
	}
	return false
}

function isMilitary(addr) {
	const a = normalizeAddress(addr)
	const hay = streetHaystack(a)
	const signals = []

	if (cityIsMilitary(a.city)) signals.push('city')
	if (stateIsMilitary(a.state)) signals.push('state')
	if (RE_APO_TOKEN.test(hay)) signals.push('apo_token')
	if (RE_BFPO.test(hay) || RE_CFPO.test(hay)) signals.push('forces_po')
	if (RE_ARMED_FORCES.test(hay) || RE_POST_OFFICE.test(hay)) signals.push('armed_forces')
	if (RE_PSC.test(hay)) signals.push('psc')
	if (RE_CMR.test(hay)) signals.push('cmr')

	const unitBox = RE_UNIT_BOX.test(hay)
	const strong = signals.length > 0
	if (unitBox && (strong || (countryLooksUS(a.country_iso) && isMilitaryZip(a.zip)))) {
		signals.push('unit_box')
	}

	if (countryLooksUS(a.country_iso) && isMilitaryZip(a.zip)) signals.push('zip')

	return signals.length > 0
}

/**
 * Classify an address. Pure — no I/O.
 *
 * @param {object} addr
 * @returns {{ required:boolean, reasons:string[], reason:string|null, labels:string[], title:string, signals:{australia:boolean, military:boolean} }}
 */
function detect(addr) {
	const australia = isAustralia(addr)
	const military = isMilitary(addr)
	const reasons = []
	if (military) reasons.push(REASON_MILITARY)
	if (australia) reasons.push(REASON_AUSTRALIA)
	const labels = reasons.map((r) => REASON_LABELS[r])
	return {
		required: reasons.length > 0,
		reasons,
		reason: reasons.length ? reasons.join(',') : null,
		labels,
		title: labels.length ? labels.join(' · ') : '',
		signals: { australia, military },
	}
}

function parseReasons(reason) {
	return String(reason || '')
		.split(',')
		.map((s) => s.trim())
		.filter((r) => REASONS.includes(r))
}

function labelsFor(reasons) {
	return (reasons || []).map((r) => REASON_LABELS[r]).filter(Boolean)
}

function titleFor(reasons) {
	return labelsFor(reasons).join(' · ')
}

/**
 * Stable hash of the *shipping* fields (not formatted_address, which Etsy may
 * re-wrap without the address actually changing). Same address → same hash so a
 * re-sync of an already-approved order does not re-open the hold.
 */
function fingerprint(addr) {
	const a = normalizeAddress(addr)
	const canonical = [
		collapseWs(a.first_line),
		collapseWs(a.second_line),
		canonicalMilitaryCity(a.city),
		canonicalMilitaryState(a.state),
		zip5(a.zip) || collapseWs(a.zip),
		canonicalCountry(a.country_iso),
	].join('\n')
	return crypto.createHash('sha256').update(canonical).digest('hex')
}

function isOpenRow(row) {
	return !!(row && row.address_review_required_at != null && row.address_review_cleared_at == null)
}

function openSql(alias = 'r') {
	const a = assertAlias(alias)
	return `(${a}.address_review_required_at IS NOT NULL AND ${a}.address_review_cleared_at IS NULL)`
}

function excludeOpenIssuesSql(alias = 'r') {
	const a = assertAlias(alias)
	return `NOT EXISTS (SELECT 1 FROM order_issues oi WHERE oi.receipt_id = ${a}.receipt_id AND oi.status = 'open')`
}

/** Address-review worklist: open hold, and not already on Issues / on hold. */
function queueSql(alias = 'r') {
	return `(${openSql(alias)} AND ${excludeOpenIssuesSql(alias)})`
}

const FILTER_PENDING = 'pending'
const FILTER_REVIEWED = 'reviewed'
const AR_FILTERS = Object.freeze([FILTER_PENDING, FILTER_REVIEWED])

function normalizeFilter(value) {
	return String(value || '').trim().toLowerCase() === FILTER_REVIEWED ? FILTER_REVIEWED : FILTER_PENDING
}

/**
 * Owner already marked the address OK (employees may shop). Auto-release /
 * leftover-on-hold stamps (`sync` / `system`) stay out — those were not an
 * owner review. Open Issues rows stay out too: they belong on Issues.
 */
function reviewedSql(alias = 'r') {
	const a = assertAlias(alias)
	return `(${a}.address_review_required_at IS NOT NULL
    AND ${a}.address_review_cleared_at IS NOT NULL
    AND IFNULL(${a}.address_review_cleared_by, '') NOT IN ('${ACTOR_SYNC}', '${ACTOR_SYSTEM}')
    AND ${excludeOpenIssuesSql(a)})`
}

function filterSql(alias, filter) {
	return normalizeFilter(filter) === FILTER_REVIEWED ? reviewedSql(alias) : queueSql(alias)
}

function excludeOpenSql(alias = 'r') {
	return `NOT ${openSql(alias)}`
}

function receiptHasOpenIssue(db, receiptId) {
	try {
		return !!db.prepare("SELECT 1 FROM order_issues WHERE receipt_id = ? AND status = 'open' LIMIT 1").get(Number(receiptId))
	} catch {
		return false
	}
}

function selectSql(alias = 'r') {
	const prefix = alias === '' ? '' : `${assertAlias(alias)}.`
	return [
		`${prefix}address_review_required_at`,
		`${prefix}address_review_cleared_at`,
		`${prefix}address_review_cleared_by`,
		`${prefix}address_review_reason`,
		`${prefix}address_review_note`,
		`${prefix}address_review_fingerprint`,
	].join(', ')
}

function receiptsHaveColumns(db) {
	try {
		return db.pragma('table_info(receipts)').some((c) => c.name === 'address_review_required_at')
	} catch {
		return false
	}
}

function shapeForApi(row, opts = {}) {
	if (!row || row.address_review_required_at == null) return null
	const reasons = parseReasons(row.address_review_reason)
	const open = row.address_review_cleared_at == null && !opts.onHold
	return {
		required: open,
		reasons,
		labels: labelsFor(reasons),
		title: titleFor(reasons) || 'Address review',
		required_at: row.address_review_required_at,
		cleared_at: row.address_review_cleared_at || null,
		cleared_by: row.address_review_cleared_by || null,
		note: row.address_review_note || null,
	}
}

function shoppingBlockMessage(reasons) {
	const title = titleFor(reasons) || 'this destination'
	return `This order is held for address review (${title}). An owner must confirm the address will work for shipping before anyone shops or ships it.`
}

/**
 * Receipt ids in `receiptIds` that currently have an open address-review hold.
 * Used by bulk purchase so a mixed selection cannot shop a military / Australia
 * order by riding along with ordinary receipts.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Array<number|string>} receiptIds
 * @returns {Set<number>}
 */
function openIdSet(db, receiptIds) {
	const ids = [...new Set((receiptIds || []).map(Number).filter(Number.isInteger))]
	if (!ids.length || !receiptsHaveColumns(db)) return new Set()
	try {
		const placeholders = ids.map(() => '?').join(',')
		return new Set(
			db
				.prepare(
					`SELECT r.receipt_id FROM receipts r
           WHERE r.receipt_id IN (${placeholders}) AND ${openSql('r')}`,
				)
				.all(...ids)
				.map((row) => Number(row.receipt_id)),
		)
	} catch {
		return new Set()
	}
}

/**
 * If this receipt is currently held, return a block object the API can turn
 * into HTTP 409. Returns null when shopping is allowed (including when the
 * columns have not been migrated yet).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number|string} receiptId
 * @returns {{ message:string, reasons:string[], labels:string[], title:string }|null}
 */
function shoppingBlock(db, receiptId) {
	try {
		const row = db
			.prepare(
				`SELECT address_review_required_at, address_review_cleared_at, address_review_reason
         FROM receipts WHERE receipt_id = ?`,
			)
			.get(Number(receiptId))
		if (!isOpenRow(row)) return null
		const reasons = parseReasons(row.address_review_reason)
		return {
			message: shoppingBlockMessage(reasons),
			reasons,
			labels: labelsFor(reasons),
			title: titleFor(reasons) || 'Address review',
		}
	} catch {
		return null
	}
}

function insertEvent(db, { receiptId, event, reason, fingerprint: fp, actor, note, now }) {
	try {
		db.prepare(
			`INSERT INTO order_address_review_events
        (receipt_id, event, reason, fingerprint, actor, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run(receiptId, event, reason || null, fp || null, actor || null, note || null, now)
	} catch {
		// Additive table may be missing on a partial fixture — the receipt columns
		// are the operational source of truth.
	}
}

function readCurrent(db, receiptId) {
	return db
		.prepare(
			`SELECT address_review_required_at, address_review_cleared_at, address_review_cleared_by,
              address_review_reason, address_review_note, address_review_fingerprint
       FROM receipts WHERE receipt_id = ?`,
		)
		.get(receiptId)
}

/**
 * Re-evaluate a receipt against the current address. Idempotent:
 *   • matching + never seen     → open
 *   • matching + already open   → refresh reason/fingerprint
 *   • matching + cleared, same  → stay cleared (re-sync of an approved address)
 *   • matching + cleared, new   → re-open (buyer changed the address)
 *   • not matching + open       → auto-release (address was corrected)
 *   • incomplete payload        → no-op (a sparse Etsy re-sync must not flap)
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} receiptId
 * @param {object} addr
 * @param {{ actor?:string, now?:number }} [opts]
 * @returns {{ action:string, detection:object }}
 */
function applyToReceipt(db, receiptId, addr, opts = {}) {
	const id = Number(receiptId)
	if (!Number.isInteger(id)) return { action: 'invalid', detection: detect({}) }
	const now = opts.now ?? Math.floor(Date.now() / 1000)
	const actor = str(opts.actor) || ACTOR_SYNC
	const detection = detect(addr)

	let current
	try {
		current = readCurrent(db, id)
	} catch {
		return { action: 'unavailable', detection }
	}
	if (!current) return { action: 'missing', detection }

	if (!hasEnoughAddress(addr)) return { action: 'skipped_incomplete', detection }

	const fp = fingerprint(addr)
	const open = isOpenRow(current)
	const onHold = receiptHasOpenIssue(db, id)

	// Already on Issues / on hold = the owner has already reviewed this order.
	// Drop it from Address review and never reopen while an issue is still open.
	if (onHold) {
		if (open) {
			db.prepare(
				`UPDATE receipts SET
           address_review_cleared_at = @now,
           address_review_cleared_by = @actor,
           address_review_note = COALESCE(address_review_note, @note),
           address_review_fingerprint = @fp
         WHERE receipt_id = @id AND address_review_cleared_at IS NULL`,
			).run({
				now,
				actor,
				note: 'Already on Issues / on hold',
				fp,
				id,
			})
			insertEvent(db, {
				receiptId: id,
				event: EVENT_CLEARED,
				reason: current.address_review_reason,
				fingerprint: current.address_review_fingerprint || fp,
				actor,
				note: 'Already on Issues / on hold',
				now,
			})
		}
		return { action: 'already_on_hold', detection }
	}

	if (!detection.required) {
		if (open) {
			db.prepare(
				`UPDATE receipts SET
           address_review_cleared_at = @now,
           address_review_cleared_by = @actor,
           address_review_note = COALESCE(address_review_note, @note),
           address_review_fingerprint = @fp
         WHERE receipt_id = @id`,
			).run({
				now,
				actor,
				note: 'Auto-released: address no longer requires review',
				fp,
				id,
			})
			insertEvent(db, {
				receiptId: id,
				event: EVENT_AUTO_RELEASED,
				reason: current.address_review_reason,
				fingerprint: fp,
				actor,
				note: 'Address no longer matches military / Australia rules',
				now,
			})
			return { action: EVENT_AUTO_RELEASED, detection }
		}
		return { action: 'none', detection }
	}

	if (open) {
		if (current.address_review_reason !== detection.reason || current.address_review_fingerprint !== fp) {
			db.prepare(
				`UPDATE receipts SET
           address_review_reason = @reason,
           address_review_fingerprint = @fp
         WHERE receipt_id = @id`,
			).run({ reason: detection.reason, fp, id })
			insertEvent(db, {
				receiptId: id,
				event: EVENT_UPDATED,
				reason: detection.reason,
				fingerprint: fp,
				actor,
				now,
			})
			return { action: EVENT_UPDATED, detection }
		}
		return { action: 'already_open', detection }
	}

	if (current.address_review_cleared_at != null && current.address_review_fingerprint === fp) {
		return { action: 'still_cleared', detection }
	}

	const event = current.address_review_cleared_at != null ? EVENT_REOPENED : EVENT_OPENED
	db.prepare(
		`UPDATE receipts SET
       address_review_required_at = @now,
       address_review_cleared_at = NULL,
       address_review_cleared_by = NULL,
       address_review_note = NULL,
       address_review_reason = @reason,
       address_review_fingerprint = @fp
     WHERE receipt_id = @id`,
	).run({ now, reason: detection.reason, fp, id })
	insertEvent(db, {
		receiptId: id,
		event,
		reason: detection.reason,
		fingerprint: fp,
		actor,
		note: event === EVENT_REOPENED ? 'Address changed after a prior approval' : null,
		now,
	})
	return { action: event, detection }
}

function clipNote(note) {
	if (typeof note !== 'string') return null
	const trimmed = note.trim()
	if (!trimmed) return null
	return trimmed.slice(0, NOTE_MAX)
}

/**
 * Owner approval: the address is OK to ship, employees may shop.
 * Stamps the current fingerprint so a later re-sync of the SAME address stays
 * cleared, while a later address change re-opens.
 */
function clearReview(db, receiptId, opts = {}) {
	const id = Number(receiptId)
	const now = opts.now ?? Math.floor(Date.now() / 1000)
	const actor = str(opts.actor) || 'owner'
	const note = clipNote(opts.note)
	const current = readCurrent(db, id)
	if (!current) {
		const e = new Error('Order not found.')
		e.code = 'NOT_FOUND'
		throw e
	}
	if (!isOpenRow(current)) {
		const e = new Error('This order is not waiting on address review.')
		e.code = 'NOT_OPEN'
		throw e
	}
	db.prepare(
		`UPDATE receipts SET
       address_review_cleared_at = @now,
       address_review_cleared_by = @actor,
       address_review_note = @note
     WHERE receipt_id = @id AND address_review_cleared_at IS NULL`,
	).run({ now, actor, note, id })
	insertEvent(db, {
		receiptId: id,
		event: EVENT_CLEARED,
		reason: current.address_review_reason,
		fingerprint: current.address_review_fingerprint,
		actor,
		note,
		now,
	})
	return { ok: true, receipt_id: id, address_review: shapeForApi({ ...current, address_review_cleared_at: now, address_review_cleared_by: actor, address_review_note: note }) }
}

/**
 * Owner undo: put an approved address back on hold. Only valid while the
 * current address still matches the rules (otherwise there is nothing to hold).
 */
function reopenReview(db, receiptId, addr, opts = {}) {
	const id = Number(receiptId)
	const now = opts.now ?? Math.floor(Date.now() / 1000)
	const actor = str(opts.actor) || 'owner'
	const note = clipNote(opts.note)
	const current = readCurrent(db, id)
	if (!current) {
		const e = new Error('Order not found.')
		e.code = 'NOT_FOUND'
		throw e
	}
	if (isOpenRow(current)) {
		const e = new Error('This order is already on address review.')
		e.code = 'ALREADY_OPEN'
		throw e
	}
	const detection = detect(addr)
	if (!detection.required) {
		const e = new Error('This address no longer matches military or Australia review rules.')
		e.code = 'NOT_REQUIRED'
		throw e
	}
	const fp = fingerprint(addr)
	db.prepare(
		`UPDATE receipts SET
       address_review_required_at = @now,
       address_review_cleared_at = NULL,
       address_review_cleared_by = NULL,
       address_review_note = @note,
       address_review_reason = @reason,
       address_review_fingerprint = @fp
     WHERE receipt_id = @id`,
	).run({ now, note, reason: detection.reason, fp, id })
	insertEvent(db, {
		receiptId: id,
		event: EVENT_REOPENED,
		reason: detection.reason,
		fingerprint: fp,
		actor,
		note,
		now,
	})
	return { ok: true, receipt_id: id, address_review: shapeForApi({ address_review_required_at: now, address_review_cleared_at: null, address_review_reason: detection.reason, address_review_note: note }) }
}

/**
 * Stamp every still-actionable unpaid-for-shopping order whose address matches.
 * Idempotent — already-open / already-cleared rows are no-ops via applyToReceipt.
 * Scoped to unpackaged, paid, not-cancelled receipts so a historical delivered
 * APO order is not dragged into today's review queue.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ scanned:number, opened:number }}
 */
function backfillOpenOrders(db) {
	if (!receiptsHaveColumns(db)) return { scanned: 0, opened: 0 }
	let rows
	try {
		rows = db
			.prepare(
				`SELECT receipt_id, name, shipping_first_line, shipping_second_line,
                shipping_city, shipping_state, shipping_zip, shipping_country_iso,
                formatted_address
         FROM receipts
         WHERE is_paid = 1
           AND packaged_at IS NULL
           AND status NOT IN ('Canceled', 'Cancelled', 'Fully Refunded', 'Fully refunded')
           AND address_review_required_at IS NULL
           AND address_review_cleared_at IS NULL`,
			)
			.all()
	} catch {
		return { scanned: 0, opened: 0 }
	}
	let opened = 0
	const run = db.transaction((list) => {
		for (const row of list) {
			const result = applyToReceipt(db, row.receipt_id, row, { actor: ACTOR_SYSTEM })
			if (result.action === EVENT_OPENED || result.action === EVENT_REOPENED) opened++
		}
	})
	run(rows)
	return { scanned: rows.length, opened }
}

/**
 * How many orders are waiting on an owner address check right now — the same
 * set the Address-review Orders filter lists (minus date / shop narrowing).
 * Cheap indexed COUNT for the banner.
 */
function openReviewCount(db, extraWhere = '1 = 1', params = {}) {
	if (!receiptsHaveColumns(db)) return 0
	try {
		const row = db
			.prepare(
				`SELECT COUNT(*) AS n
         FROM receipts r
         WHERE ${queueSql('r')}
           AND (${extraWhere})`,
			)
			.get(params)
		return (row && row.n) || 0
	} catch {
		return 0
	}
}

/**
 * Sizes of the Address-review To review / Reviewed chips. Callers pass the
 * extra WHERE for each chip (To review is the live hold; Reviewed may use a
 * reviewed-at date window). Counts describe the WHOLE queue, independent of
 * which chip is selected, so they stay put as the owner clicks between them.
 *
 * @returns {{ pending:number, reviewed:number }}
 */
function listFilterCounts(db, opts = {}) {
	if (!receiptsHaveColumns(db)) return { pending: 0, reviewed: 0 }
	const pendingWhere = opts.pendingWhere || '1 = 1'
	const reviewedWhere = opts.reviewedWhere || '1 = 1'
	const pendingParams = opts.pendingParams || {}
	const reviewedParams = opts.reviewedParams || {}
	try {
		const pending = db
			.prepare(`SELECT COUNT(*) AS n FROM receipts r WHERE ${queueSql('r')} AND (${pendingWhere})`)
			.get(pendingParams)
		const reviewed = db
			.prepare(`SELECT COUNT(*) AS n FROM receipts r WHERE ${reviewedSql('r')} AND (${reviewedWhere})`)
			.get(reviewedParams)
		return { pending: (pending && pending.n) || 0, reviewed: (reviewed && reviewed.n) || 0 }
	} catch {
		return { pending: 0, reviewed: 0 }
	}
}

/**
 * Orders already on Issues / on hold have been reviewed. Clear any leftover
 * Address-review hold so they cannot appear in that queue — even before the
 * next Etsy sync runs applyToReceipt.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ released: number }}
 */
function releaseReviewsAlreadyOnHold(db) {
	if (!receiptsHaveColumns(db)) return { released: 0 }
	const now = Math.floor(Date.now() / 1000)
	try {
		const info = db
			.prepare(
				`UPDATE receipts
            SET address_review_cleared_at = @now,
                address_review_cleared_by = @actor,
                address_review_note = COALESCE(address_review_note, @note)
          WHERE address_review_required_at IS NOT NULL
            AND address_review_cleared_at IS NULL
            AND EXISTS (
              SELECT 1 FROM order_issues oi
               WHERE oi.receipt_id = receipts.receipt_id AND oi.status = 'open'
            )`,
			)
			.run({ now, actor: ACTOR_SYSTEM, note: 'Already on Issues / on hold' })
		return { released: info.changes || 0 }
	} catch {
		return { released: 0 }
	}
}

function eventsForReceipt(db, receiptId) {
	try {
		return db
			.prepare(
				`SELECT id, event, reason, actor, note, created_at
         FROM order_address_review_events
         WHERE receipt_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 50`,
			)
			.all(Number(receiptId))
	} catch {
		return []
	}
}

function ensureEventsTable(db) {
	db.exec(`
    CREATE TABLE IF NOT EXISTS order_address_review_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id   INTEGER NOT NULL,
      event        TEXT    NOT NULL,
      reason       TEXT,
      fingerprint  TEXT,
      actor        TEXT,
      note         TEXT,
      created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_address_review_events_receipt
      ON order_address_review_events(receipt_id, created_at DESC);
  `)
}

module.exports = {
	REASON_MILITARY,
	REASON_AUSTRALIA,
	REASONS,
	REASON_LABELS,
	EVENT_OPENED,
	EVENT_UPDATED,
	EVENT_CLEARED,
	EVENT_REOPENED,
	EVENT_AUTO_RELEASED,
	ACTOR_SYNC,
	ACTOR_SYSTEM,
	RECEIPT_COLUMNS,
	API_INTERNAL_FIELDS,
	NOTE_MAX,
	normalizeAddress,
	hasEnoughAddress,
	detect,
	parseReasons,
	labelsFor,
	titleFor,
	fingerprint,
	isOpenRow,
	openSql,
	queueSql,
	reviewedSql,
	filterSql,
	FILTER_PENDING,
	FILTER_REVIEWED,
	AR_FILTERS,
	normalizeFilter,
	excludeOpenIssuesSql,
	excludeOpenSql,
	selectSql,
	receiptsHaveColumns,
	shapeForApi,
	openIdSet,
	shoppingBlock,
	shoppingBlockMessage,
	applyToReceipt,
	clearReview,
	reopenReview,
	backfillOpenOrders,
	releaseReviewsAlreadyOnHold,
	openReviewCount,
	listFilterCounts,
	eventsForReceipt,
	ensureEventsTable,
	isMilitary,
	isAustralia,
	zip5,
}
