'use strict'

/**
 * address-override.js — the ship-to address we actually print, when it is no
 * longer the one Etsy checked out with.
 *
 * Buyers message a corrected address on Etsy. Etsy v3 has no "update this
 * receipt's ship-to" call, and the next shop sync would overwrite any edit we
 * made to the shipping_* columns. The override is therefore a local record:
 *
 *   • receipts.shipping_* / formatted_address stay the Etsy checkout address
 *   • address_override_* is the address the parcel must use
 *   • the Orders list, the 4PX drawer and the bulk wizard all read the
 *     effective address (override when present, otherwise Etsy)
 *
 * Address review (military / Australia) is re-evaluated against that same
 * effective address, including on the next Etsy sync — otherwise a sync would
 * reopen a hold for the old APO box after the operator had already corrected
 * it to a civilian street.
 *
 * A label that already exists is not rewritten here. The row locks once it is
 * shipped or holds an active 4PX consignment; cancel the shipment, then save
 * the address, then create the label again.
 */

const addressReview = require('./address-review')

const RECEIPT_COLUMNS = Object.freeze([
	['address_override_json', 'TEXT'],
	['address_override_at', 'INTEGER'],
	['address_override_by', 'TEXT'],
	['address_override_note', 'TEXT'],
	['address_override_base_fp', 'TEXT'],
])

const API_INTERNAL_FIELDS = Object.freeze([
	'address_override_json',
	'address_override_at',
	'address_override_by',
	'address_override_note',
	'address_override_base_fp',
])

const NOTE_MAX = 500
const ACTOR_MAX = 80

const LIMITS = Object.freeze({
	name: 70,
	first_line: 100,
	second_line: 80,
	city: 64,
	state: 40,
	zip: 16,
})

const EVENT_SAVED = 'saved'
const EVENT_REVERTED = 'reverted'

/** 4PX and Etsy both speak ISO 3166-1 alpha-2. UK/USA-style aliases fold first. */
const COUNTRY_ALIASES = Object.freeze({
	UK: 'GB',
	USA: 'US',
	AUS: 'AU',
	CAN: 'CA',
	MEX: 'MX',
	GBR: 'GB',
})

// Officially assigned alpha-2 codes, plus XK (Kosovo), which carriers accept
// even though it is user-assigned in ISO. Kept as one string so a missing code
// is a diff, not a scattered Set literal.
const ISO_ALPHA2 = new Set(
	`AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW`.split(
		/\s+/,
	),
)

/** Last line of the Orders-tab address block. Unknown codes stay as ISO. */
const COUNTRY_LABELS = Object.freeze({
	US: 'United States',
	CA: 'Canada',
	GB: 'United Kingdom',
	AU: 'Australia',
	MX: 'Mexico',
	DE: 'Germany',
	FR: 'France',
	IT: 'Italy',
	ES: 'Spain',
	NL: 'Netherlands',
	IE: 'Ireland',
	NZ: 'New Zealand',
	JP: 'Japan',
	KR: 'South Korea',
	SG: 'Singapore',
	SE: 'Sweden',
	NO: 'Norway',
	DK: 'Denmark',
	FI: 'Finland',
	BE: 'Belgium',
	AT: 'Austria',
	CH: 'Switzerland',
	PL: 'Poland',
	PT: 'Portugal',
	BR: 'Brazil',
	PR: 'Puerto Rico',
	IN: 'India',
	PH: 'Philippines',
	IL: 'Israel',
	AE: 'United Arab Emirates',
	HK: 'Hong Kong',
})

const US_STATES = new Set(
	`AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY AA AE AP`.split(
		/\s+/,
	),
)
const CA_PROVINCES = new Set('AB BC MB NB NL NS NT NU ON PE QC SK YT'.split(/\s+/))
const AU_STATES = new Set('NSW VIC QLD SA WA TAS NT ACT'.split(/\s+/))

const LOCK_MESSAGES = Object.freeze({
	cancelled: 'This order is cancelled, so there is no shipment to update.',
	shipped: 'This order is already shipped. The address on the label cannot be changed here.',
	label: 'A 4PX label already exists for this order. Cancel that shipment before changing the ship-to address, then create the label again.',
})

function assertAlias(alias) {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new TypeError('Invalid SQL alias')
	return alias
}

function str(value) {
	if (value == null) return ''
	return String(value)
}

function fail(message, code, extra) {
	const e = new Error(message)
	e.code = code
	if (extra) Object.assign(e, extra)
	return e
}

function decodeBasicEntities(value) {
	return str(value)
		.replace(/&#(\d+);/g, (_, n) => {
			const c = Number(n)
			return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : _
		})
		.replace(/&#x([0-9a-f]+);/gi, (_, n) => {
			const c = parseInt(n, 16)
			return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : _
		})
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&')
}

/** One line of an address field: no control chars, no raw newlines, trimmed. */
function cleanField(value) {
	return decodeBasicEntities(value)
		.replace(/[\u0000-\u001F\u007F]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
}

function upper(value) {
	return cleanField(value).toUpperCase()
}

function clip(value, max) {
	const s = cleanField(value)
	return s.length > max ? s.slice(0, max) : s
}

function countryLabel(iso) {
	const code = upper(iso)
	return COUNTRY_LABELS[code] || code
}

/**
 * The multi-line block the Orders tab copies and renders.
 * Name / street / "City, ST ZIP" / country — the same shape Etsy uses.
 *
 * @param {{name?:string, first_line?:string, second_line?:string, city?:string, state?:string, zip?:string, country_iso?:string}} a
 * @returns {string}
 */
function buildFormattedAddress(a) {
	const src = a || {}
	const lines = []
	if (src.name) lines.push(src.name)
	if (src.first_line) lines.push(src.first_line)
	if (src.second_line) lines.push(src.second_line)
	const cityLine = [src.city, [src.state, src.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')
	if (cityLine) lines.push(cityLine)
	if (src.country_iso) lines.push(countryLabel(src.country_iso))
	return lines.join('\n')
}

function canonicalCountry(raw) {
	const token = upper(raw).replace(/\./g, '')
	if (!token) return ''
	if (COUNTRY_ALIASES[token]) return COUNTRY_ALIASES[token]
	if (ISO_ALPHA2.has(token)) return token
	return token
}

/**
 * Operator input → the canonical address we store and print.
 * Throws VALIDATION with `fields` naming every problem at once, so the form
 * can mark each box instead of failing one field per click.
 *
 * @param {object} input
 * @returns {{name:string, first_line:string, second_line:string, city:string, state:string, zip:string, country_iso:string}}
 */
function validateAddress(input) {
	const src = input && typeof input === 'object' ? input : {}
	const errors = {}
	const name = clip(src.name, LIMITS.name + 40)
	const first = clip(src.first_line ?? src.shipping_first_line, LIMITS.first_line + 40)
	const second = clip(src.second_line ?? src.shipping_second_line, LIMITS.second_line + 40)
	const city = clip(src.city ?? src.shipping_city, LIMITS.city + 40)
	let state = clip(src.state ?? src.shipping_state, LIMITS.state + 20)
	let zip = clip(src.zip ?? src.shipping_zip ?? src.post_code, LIMITS.zip + 20)
	const country = canonicalCountry(src.country_iso ?? src.shipping_country_iso ?? src.country)

	if (!name || name.length < 2) errors.name = 'Enter the recipient’s full name.'
	else if (name.length > LIMITS.name) errors.name = `Name must be ${LIMITS.name} characters or fewer.`
	else if (!/\p{L}/u.test(name)) errors.name = 'Name must include letters.'

	if (!first || first.length < 3) errors.first_line = 'Enter the street address.'
	else if (first.length > LIMITS.first_line) errors.first_line = `Street must be ${LIMITS.first_line} characters or fewer.`

	if (second.length > LIMITS.second_line) errors.second_line = `Apt / unit must be ${LIMITS.second_line} characters or fewer.`

	if (!city || city.length < 2) errors.city = 'Enter the city.'
	else if (city.length > LIMITS.city) errors.city = `City must be ${LIMITS.city} characters or fewer.`

	if (!country || country.length !== 2 || !ISO_ALPHA2.has(country)) {
		errors.country_iso = 'Country must be a 2-letter code, for example US.'
	}

	if (country === 'US' || country === 'CA' || country === 'AU') state = state.toUpperCase()
	if (country === 'CA') {
		const compact = zip.toUpperCase().replace(/[^A-Z0-9]/g, '')
		zip = /^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(compact) ? `${compact.slice(0, 3)} ${compact.slice(3)}` : zip.toUpperCase()
	} else if (country === 'GB') {
		const compact = zip.toUpperCase().replace(/[^A-Z0-9]/g, '')
		zip = /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(compact) ? `${compact.slice(0, -3)} ${compact.slice(-3)}` : zip.toUpperCase()
	}

	if (country === 'US') {
		if (!US_STATES.has(state)) errors.state = 'US state must be a 2-letter code, for example CA. Military mail uses AA, AE or AP.'
		if (!/^\d{5}(?:-\d{4})?$/.test(zip)) errors.zip = 'US ZIP must be 5 digits, or ZIP+4 (12345-6789).'
	} else if (country === 'CA') {
		if (!CA_PROVINCES.has(state)) errors.state = 'Canadian province must be a code, for example ON.'
		if (!/^[A-Z]\d[A-Z] \d[A-Z]\d$/.test(zip)) errors.zip = 'Canadian postal code must look like A1A 1A1.'
	} else if (country === 'AU') {
		if (!AU_STATES.has(state)) errors.state = 'Australian state must be a code, for example NSW.'
		if (!/^\d{4}$/.test(zip)) errors.zip = 'Australian postcode must be 4 digits.'
	} else if (country === 'GB') {
		if (state.length > LIMITS.state) errors.state = `State must be ${LIMITS.state} characters or fewer.`
		if (!/^[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$/.test(zip)) errors.zip = 'UK postcode must look like SW1A 1AA.'
	} else if (ISO_ALPHA2.has(country)) {
		if (state.length > LIMITS.state) errors.state = `State must be ${LIMITS.state} characters or fewer.`
		if (zip && (zip.length < 2 || zip.length > LIMITS.zip || !/^[A-Z0-9][A-Z0-9 -]{0,14}[A-Z0-9]$/i.test(zip))) {
			errors.zip = 'Postal code looks invalid for this country.'
		}
	}

	if (Object.keys(errors).length) {
		throw fail('Check the highlighted address fields.', 'VALIDATION', { fields: errors })
	}

	return {
		name,
		first_line: first,
		second_line: second,
		city,
		state,
		zip,
		country_iso: country,
	}
}

function clipNote(note) {
	if (typeof note !== 'string') return null
	const trimmed = cleanField(note)
	if (!trimmed) return null
	return trimmed.slice(0, NOTE_MAX)
}

function clipActor(actor) {
	const s = cleanField(actor)
	return (s || 'owner').slice(0, ACTOR_MAX)
}

/**
 * Why this row refuses an address edit. Empty string means it can be edited.
 * The label already paid for is not a draft — changing the ship-to under it
 * would make the column and the parcel disagree.
 *
 * @param {object} row
 * @returns {''|'cancelled'|'shipped'|'label'}
 */
function lockReason(row) {
	if (!row) return 'cancelled'
	const status = cleanField(row.status).toLowerCase()
	if (status === 'canceled' || status === 'cancelled' || status === 'fully refunded') return 'cancelled'
	if (Number(row.is_shipped) === 1) return 'shipped'
	if (row.fourpx_consignment_no && cleanField(row.fourpx_order_status) !== 'cancelled') return 'label'
	return ''
}

function lockMessage(reason) {
	return LOCK_MESSAGES[reason] || 'This address can no longer be changed.'
}

function etsyFromRow(row) {
	const src = row || {}
	return {
		name: cleanField(src.buyer_name || src.name),
		first_line: cleanField(src.shipping_first_line),
		second_line: cleanField(src.shipping_second_line),
		city: cleanField(src.shipping_city),
		state: cleanField(src.shipping_state),
		zip: cleanField(src.shipping_zip),
		country_iso: upper(src.shipping_country_iso),
		formatted_address: str(src.formatted_address).trim(),
	}
}

function parseStored(row) {
	if (!row || row.address_override_json == null || row.address_override_json === '') return null
	let obj
	try {
		obj = JSON.parse(row.address_override_json)
	} catch {
		return null
	}
	if (!obj || typeof obj !== 'object') return null
	const address = {
		name: cleanField(obj.name),
		first_line: cleanField(obj.first_line),
		second_line: cleanField(obj.second_line),
		city: cleanField(obj.city),
		state: cleanField(obj.state),
		zip: cleanField(obj.zip),
		country_iso: upper(obj.country_iso),
	}
	if (!address.first_line && !address.city && !address.zip) return null
	return { address }
}

function sameAddress(a, b) {
	if (addressReview.fingerprint(a) !== addressReview.fingerprint(b)) return false
	return cleanField(a.name).toUpperCase() === cleanField(b.name).toUpperCase()
}

function fieldsFromAddress(address) {
	return {
		buyer_name: address.name || '',
		shipping_first_line: address.first_line || '',
		shipping_second_line: address.second_line || '',
		shipping_city: address.city || '',
		shipping_state: address.state || '',
		shipping_zip: address.zip || '',
		shipping_country_iso: address.country_iso || '',
		formatted_address: buildFormattedAddress(address),
	}
}

function etsyFields(row) {
	const etsy = etsyFromRow(row)
	const formatted = etsy.formatted_address || buildFormattedAddress(etsy)
	return {
		buyer_name: etsy.name || '',
		shipping_first_line: etsy.first_line,
		shipping_second_line: etsy.second_line,
		shipping_city: etsy.city,
		shipping_state: etsy.state,
		shipping_zip: etsy.zip,
		shipping_country_iso: etsy.country_iso,
		formatted_address: formatted,
	}
}

function publicSnap(row, etsy) {
	const stored = parseStored(row)
	if (!stored) return null
	const fields = fieldsFromAddress(stored.address)
	const base = cleanField(row.address_override_base_fp)
	return {
		active: true,
		...stored.address,
		formatted_address: fields.formatted_address,
		updated_at: row.address_override_at || null,
		updated_by: row.address_override_by || null,
		note: row.address_override_note || null,
		etsy_drifted: !!(base && addressReview.fingerprint(etsy) !== base),
		etsy: {
			name: etsy.name,
			first_line: etsy.first_line,
			second_line: etsy.second_line,
			city: etsy.city,
			state: etsy.state,
			zip: etsy.zip,
			country_iso: etsy.country_iso,
			formatted_address: etsy.formatted_address || buildFormattedAddress(etsy),
		},
	}
}

/**
 * Overlay the effective ship-to onto an Orders-list row, in place.
 * Returns the public override (or null when this order still uses Etsy).
 * Never throws — a bad JSON blob must not blank the order list.
 *
 * @param {object} row
 * @returns {object|null}
 */
function applyDisplay(row) {
	try {
		if (!row || typeof row !== 'object') return null
		const etsy = etsyFromRow(row)
		const snap = publicSnap(row, etsy)
		if (!snap) return null
		const fields = fieldsFromAddress(snap)
		row.buyer_name = fields.buyer_name
		row.shipping_first_line = fields.shipping_first_line
		row.shipping_second_line = fields.shipping_second_line
		row.shipping_city = fields.shipping_city
		row.shipping_state = fields.shipping_state
		row.shipping_zip = fields.shipping_zip
		row.shipping_country_iso = fields.shipping_country_iso
		row.formatted_address = fields.formatted_address
		if ('country_iso_raw' in row) row.country_iso_raw = fields.shipping_country_iso
		return snap
	} catch (err) {
		console.error('[address-override] display overlay failed:', err.message)
		return null
	}
}

function selectSql(alias = 'r') {
	const prefix = alias === '' ? '' : `${assertAlias(alias)}.`
	return [
		`${prefix}address_override_json`,
		`${prefix}address_override_at`,
		`${prefix}address_override_by`,
		`${prefix}address_override_note`,
		`${prefix}address_override_base_fp`,
	].join(', ')
}

function receiptsHaveColumns(db) {
	try {
		return db.pragma('table_info(receipts)').some((c) => c.name === 'address_override_json')
	} catch {
		return false
	}
}

function ensureEventsTable(db) {
	db.exec(`
    CREATE TABLE IF NOT EXISTS order_address_override_events (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id        INTEGER NOT NULL,
      event             TEXT    NOT NULL,
      address_json      TEXT,
      etsy_json         TEXT,
      base_fingerprint  TEXT,
      actor             TEXT,
      note              TEXT,
      created_at        INTEGER NOT NULL
    )
  `)
	db.exec(`CREATE INDEX IF NOT EXISTS idx_addr_override_events_receipt ON order_address_override_events(receipt_id, id DESC)`)
}

const LOAD_SQL = `
  SELECT receipt_id, name, status, is_shipped, source,
         shipping_first_line, shipping_second_line, shipping_city, shipping_state,
         shipping_zip, shipping_country_iso, formatted_address,
         fourpx_consignment_no, fourpx_order_status,
         address_override_json, address_override_at, address_override_by,
         address_override_note, address_override_base_fp
  FROM receipts WHERE receipt_id = ?
`

function loadReceipt(db, receiptId) {
	const row = db.prepare(LOAD_SQL).get(receiptId)
	if (row) row.buyer_name = row.name
	return row || null
}

function insertEvent(db, { receiptId, event, address, etsy, baseFp, actor, note, now }) {
	try {
		db.prepare(
			`INSERT INTO order_address_override_events
        (receipt_id, event, address_json, etsy_json, base_fingerprint, actor, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			receiptId,
			event,
			address ? JSON.stringify(address) : null,
			etsy ? JSON.stringify(etsy) : null,
			baseFp || null,
			actor || null,
			note || null,
			now,
		)
	} catch {
		// The receipt columns are the operational source of truth. A missing
		// audit table on a partial fixture must not refuse the correction.
	}
}

function clearColumns(db, receiptId) {
	db.prepare(
		`UPDATE receipts SET
       address_override_json = NULL,
       address_override_at = NULL,
       address_override_by = NULL,
       address_override_note = NULL,
       address_override_base_fp = NULL
     WHERE receipt_id = ?`,
	).run(receiptId)
}

function reviewAgainst(db, receiptId, addr, now) {
	return addressReview.applyToReceipt(db, receiptId, addr, {
		actor: addressReview.ACTOR_SYSTEM,
		now,
	})
}

function resultFrom(row, review, extra) {
	const etsy = etsyFromRow(row)
	const snap = publicSnap(row, etsy)
	const effective = snap ? fieldsFromAddress(snap) : etsyFields(row)
	return {
		active: !!snap,
		address_override: snap,
		effective,
		review,
		...extra,
	}
}

/**
 * Address that address-review must judge. An override wins over the Etsy
 * payload a sync just wrote, so a re-sync cannot put the old APO box back on
 * hold after the operator corrected it.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number|string} receiptId
 * @param {object} etsyAddr  what Etsy (or the caller) says the address is
 * @returns {object}
 */
function addressForReview(db, receiptId, etsyAddr) {
	try {
		const row = loadReceipt(db, Number(receiptId))
		if (!row) return etsyAddr
		const stored = parseStored(row)
		if (!stored) return etsyAddr
		return {
			...stored.address,
			formatted_address: buildFormattedAddress(stored.address),
		}
	} catch {
		return etsyAddr
	}
}

/**
 * Save the ship-to the parcel must use. Saving the Etsy address back is a
 * revert, not a second copy of the same destination.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number|string} receiptId
 * @param {object} input
 * @param {{ actor?:string, note?:string, now?:number }} [opts]
 */
function save(db, receiptId, input, opts = {}) {
	const id = Number(receiptId)
	if (!Number.isInteger(id)) throw fail('Order not found.', 'NOT_FOUND')
	const now = opts.now ?? Math.floor(Date.now() / 1000)
	const actor = clipActor(opts.actor)
	const note = clipNote(opts.note != null ? opts.note : input && input.note)

	const tx = db.transaction(() => {
		const row = loadReceipt(db, id)
		if (!row) throw fail('Order not found.', 'NOT_FOUND')
		const lock = lockReason(row)
		if (lock) throw fail(lockMessage(lock), 'LOCKED', { lock })

		const next = validateAddress(input)
		const etsy = etsyFromRow(row)
		if (sameAddress(next, etsy)) {
			const had = !!parseStored(row)
			if (had) {
				clearColumns(db, id)
				insertEvent(db, { receiptId: id, event: EVENT_REVERTED, address: next, etsy, actor, note, now })
			}
			const fresh = loadReceipt(db, id)
			const review = reviewAgainst(db, id, etsy, now)
			return resultFrom(fresh, review, { unchanged: !had, reverted: had })
		}

		const baseFp = addressReview.fingerprint(etsy)
		db.prepare(
			`UPDATE receipts SET
         address_override_json = @json,
         address_override_at = @now,
         address_override_by = @actor,
         address_override_note = @note,
         address_override_base_fp = @fp
       WHERE receipt_id = @id`,
		).run({
			json: JSON.stringify(next),
			now,
			actor,
			note,
			fp: baseFp,
			id,
		})
		insertEvent(db, {
			receiptId: id,
			event: EVENT_SAVED,
			address: next,
			etsy,
			baseFp,
			actor,
			note,
			now,
		})
		const fresh = loadReceipt(db, id)
		const review = reviewAgainst(db, id, { ...next, formatted_address: buildFormattedAddress(next) }, now)
		return resultFrom(fresh, review, { unchanged: false, reverted: false })
	})
	return tx()
}

/**
 * Drop the override. The column and the 4PX form go back to the Etsy address.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number|string} receiptId
 * @param {{ actor?:string, now?:number }} [opts]
 */
function revert(db, receiptId, opts = {}) {
	const id = Number(receiptId)
	if (!Number.isInteger(id)) throw fail('Order not found.', 'NOT_FOUND')
	const now = opts.now ?? Math.floor(Date.now() / 1000)
	const actor = clipActor(opts.actor)

	const tx = db.transaction(() => {
		const row = loadReceipt(db, id)
		if (!row) throw fail('Order not found.', 'NOT_FOUND')
		const lock = lockReason(row)
		if (lock) throw fail(lockMessage(lock), 'LOCKED', { lock })
		const etsy = etsyFromRow(row)
		const had = !!parseStored(row)
		if (had) {
			clearColumns(db, id)
			insertEvent(db, { receiptId: id, event: EVENT_REVERTED, etsy, actor, now })
		}
		const fresh = loadReceipt(db, id)
		const review = reviewAgainst(db, id, etsy, now)
		return resultFrom(fresh, review, { unchanged: !had, reverted: had })
	})
	return tx()
}

function eventsForReceipt(db, receiptId) {
	try {
		return db
			.prepare(
				`SELECT id, receipt_id, event, address_json, etsy_json, base_fingerprint, actor, note, created_at
         FROM order_address_override_events
         WHERE receipt_id = ?
         ORDER BY id ASC`,
			)
			.all(Number(receiptId))
	} catch {
		return []
	}
}

module.exports = {
	RECEIPT_COLUMNS,
	API_INTERNAL_FIELDS,
	NOTE_MAX,
	EVENT_SAVED,
	EVENT_REVERTED,
	LOCK_MESSAGES,
	ISO_ALPHA2,
	buildFormattedAddress,
	validateAddress,
	lockReason,
	lockMessage,
	applyDisplay,
	addressForReview,
	selectSql,
	receiptsHaveColumns,
	ensureEventsTable,
	save,
	revert,
	eventsForReceipt,
	sameAddress,
	etsyFromRow,
}
