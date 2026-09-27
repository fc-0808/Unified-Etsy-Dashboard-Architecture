'use strict'

/**
 * carrier-tracking.js — the ONE way the Orders list answers
 * "what is this parcel's latest 4PX scan?"
 *
 * WHY THIS MODULE EXISTS
 * ----------------------------------------------------------------------------
 * Etsy never publishes carrier scans. The packing bench's old Pre-transit /
 * In-transit pill is a local approximation from `carrier_confirmed_at`, so a
 * recently packaged row can still say "Pre-transit" after 4PX has already
 * moved the parcel — and it never shows the actual latest event (the line a
 * packer reads on track.4px.com / the parcel-route modal).
 *
 * The background tracking worker already persists a snapshot on every receipt
 * from the official Open Platform method `tr.order.tracking.get` (v1.0.0,
 * `deliveryOrderNo`, English via `language=en` — see src/tracking/checker.js
 * and https://open.4px.com/v2/doc). The Shipping tab lists from that snapshot.
 * This module is the same snapshot, shaped for the Orders card, so Recently
 * packaged can surface "Shipment in transit · NANCHENG, CN · 9h ago" and
 * highlight the abnormal ones without calling 4PX once per row.
 *
 * Live event history stays on GET /api/4px/track (the modal). Opening the
 * modal persists that same snapshot back onto the receipt so Recently
 * packaged and the Shipping tab cannot disagree. The list itself must never
 * fan out to the carrier — 2 000 packaged parcels would trip rate limits
 * and freeze the bench.
 *
 * FILTER VOCABULARY (Recently packaged only)
 * ----------------------------------------------------------------------------
 *   all        — every sealed parcel in the current day/scope
 *   attention  — disposed, exception, stuck (critical), delayed (warning),
 *                or label-only that the health engine already flagged as
 *                critically late for pickup
 *   moving     — in_transit and not attention
 *   awaiting   — pre_transit / unchecked, not attention (normal right after packing)
 *   delivered  — delivered and not attention
 *
 * Counts describe the WHOLE current day/scope, not the selected tracking
 * chip, so clicking Attention never blanks the other chips.
 */

const FILTERS = Object.freeze(['all', 'attention', 'moving', 'awaiting', 'delivered'])

/** Lifecycle pill copy. Kept ASCII — the UI forbids decorative emoji. */
const STATUS_LABELS = Object.freeze({
	pre_transit: 'Pre-transit',
	in_transit: 'In transit',
	delivered: 'Delivered',
	exception: 'Exception',
	unknown: 'Unknown',
})

const KIND_LABELS = Object.freeze({
	disposed: 'Disposed',
	exception: 'Exception',
	stuck: 'Stuck',
	delayed: 'Delayed',
	label_only: 'Label only',
	delivered: 'Delivered',
	moving: 'In transit',
	awaiting: 'Pre-transit',
	unchecked: 'Awaiting 4PX',
	unknown: 'Unknown',
})

/**
 * Columns {@link selectSql} adds. Deleted from the orders payload after
 * {@link shapeForApi} so a consumer cannot half-read a raw column and miss
 * the attention flag the chip actually keys on.
 */
const API_INTERNAL_FIELDS = Object.freeze([
	'tracking_status',
	'tracking_last_event',
	'tracking_last_event_at',
	'tracking_last_location',
	'tracking_health',
	'tracking_health_reason',
	'tracking_is_disposed',
	'tracking_checked_at',
	'tracking_last_error',
	'tracking_delivered_at',
])

/**
 * Abnormal 4PX snapshot. Mirrors the Shipping board's actionable set
 * (disposed / exception / critical / warning) without importing the huge
 * setup.js SQL graph. Fresh pre-transit with no health verdict is NOT
 * attention — that is the expected state until 4PX collects the parcel.
 *
 * @param {string} [alias='r']
 */
function attentionSql(alias = 'r') {
	const a = _alias(alias)
	return `(
    COALESCE(${a}.tracking_status, '') != 'delivered'
    AND ${a}.tracking_delivered_at IS NULL
    AND (
      COALESCE(${a}.tracking_is_disposed, 0) = 1
      OR COALESCE(${a}.tracking_status, '') = 'exception'
      OR COALESCE(${a}.tracking_health, '') IN ('critical', 'warning')
    )
  )`
}

function isFourpxSql(alias = 'r') {
	const a = _alias(alias)
	return `(
    ${a}.fourpx_consignment_no IS NOT NULL
    OR ${a}.tracking_code LIKE '4PX%'
    OR NULLIF(TRIM(${a}.fourpx_tracking_no), '') IS NOT NULL
  )`
}

function movingSql(alias = 'r') {
	const a = _alias(alias)
	return `(${isFourpxSql(a)} AND COALESCE(${a}.tracking_status, '') = 'in_transit' AND NOT ${attentionSql(a)})`
}

function awaitingSql(alias = 'r') {
	const a = _alias(alias)
	return `(
    ${isFourpxSql(a)}
    AND COALESCE(${a}.tracking_status, 'pre_transit') IN ('pre_transit', 'unknown', '')
    AND NOT ${attentionSql(a)}
  )`
}

function deliveredSql(alias = 'r') {
	const a = _alias(alias)
	return `(${isFourpxSql(a)} AND COALESCE(${a}.tracking_status, '') = 'delivered' AND NOT ${attentionSql(a)})`
}

/**
 * Extra ORDER BY for the Attention chip: worst first, then oldest last scan
 * so the packer works the longest-silent problems before a fresh exception.
 *
 * @param {string} [alias='r']
 */
function attentionSortSql(alias = 'r') {
	const a = _alias(alias)
	return `CASE
      WHEN COALESCE(${a}.tracking_is_disposed, 0) = 1 THEN 0
      WHEN COALESCE(${a}.tracking_status, '') = 'exception' THEN 1
      WHEN COALESCE(${a}.tracking_health, '') = 'critical' THEN 2
      WHEN COALESCE(${a}.tracking_health, '') = 'warning' THEN 3
      ELSE 4
    END ASC,
    COALESCE(${a}.tracking_last_event_at, 0) ASC`
}

/**
 * Restrict the current receipts scope to a tracking chip.
 * Unknown / empty / 'all' is unrestricted so an old client cannot empty the list.
 *
 * @param {string} filter
 * @param {string} [alias='r']
 * @returns {string}
 */
function filterSql(filter, alias = 'r') {
	const key = normalizeFilter(filter)
	if (key === 'attention') return attentionSql(alias)
	if (key === 'moving') return movingSql(alias)
	if (key === 'awaiting') return awaitingSql(alias)
	if (key === 'delivered') return deliveredSql(alias)
	return '1 = 1'
}

function normalizeFilter(value) {
	const key = String(value || 'all')
		.trim()
		.toLowerCase()
	return FILTERS.includes(key) ? key : 'all'
}

/**
 * SELECT projection {@link shapeForApi} consumes. Owned here so a column
 * rename cannot land on one side of the reader only.
 *
 * @param {string} [alias='r']
 * @returns {string}
 */
function selectSql(alias = 'r') {
	const a = _alias(alias)
	return `${a}.tracking_status,
      ${a}.tracking_last_event,
      ${a}.tracking_last_event_at,
      ${a}.tracking_last_location,
      ${a}.tracking_health,
      ${a}.tracking_health_reason,
      ${a}.tracking_is_disposed,
      ${a}.tracking_checked_at,
      ${a}.tracking_last_error,
      ${a}.tracking_delivered_at`
}

/**
 * True when this receipt is a 4PX parcel we can look up. Same ownership
 * rule as the tracking worker: consignment, dedicated 4PX number, or a
 * tracking code that is itself a 4PX identifier.
 *
 * @param {object} row
 * @returns {boolean}
 */
function isFourpxReceipt(row) {
	if (!row) return false
	if (row.fourpx_consignment_no) return true
	if (String(row.fourpx_tracking_no || '').trim()) return true
	return /^4PX/i.test(String(row.tracking_code || '').trim())
}

/**
 * Shape the persisted 4PX snapshot for one order card.
 *
 * null when this is not a 4PX parcel — the card keeps its local
 * Pre-transit / In-transit pill and never pretends to have a carrier scan.
 *
 * @param {object} row
 * @returns {object|null}
 */
function shapeForApi(row) {
	if (!isFourpxReceipt(row)) return null

	const status = _text(row.tracking_status) || 'unknown'
	const lastEvent = _text(row.tracking_last_event)
	const lastLocation = _text(row.tracking_last_location)
	const health = _text(row.tracking_health)
	const healthReason = _text(row.tracking_health_reason)
	const lastError = _text(row.tracking_last_error)
	const disposed = row.tracking_is_disposed === 1 || row.tracking_is_disposed === true
	const kind = classifyKind({ status, health, disposed, checkedAt: row.tracking_checked_at })
	const attention = kind === 'disposed' || kind === 'exception' || kind === 'stuck' || kind === 'delayed' || kind === 'label_only'
	const tone = attention ? (kind === 'delayed' || kind === 'label_only' ? 'warning' : 'critical') : kind === 'delivered' ? 'ok' : kind === 'moving' ? 'ok' : 'info'

	return {
		status: STATUS_LABELS[status] ? status : 'unknown',
		label: KIND_LABELS[kind] || STATUS_LABELS[status] || STATUS_LABELS.unknown,
		kind,
		tone,
		attention,
		last_event: lastEvent,
		last_event_at: _epoch(row.tracking_last_event_at),
		last_location: lastLocation,
		health: health || null,
		health_reason: healthReason,
		is_disposed: disposed,
		checked_at: _epoch(row.tracking_checked_at),
		last_error: lastError,
		delivered_at: _epoch(row.tracking_delivered_at),
	}
}

/**
 * Operational kind for the pill. A confirmed delivery always wins leftover
 * health — a delivered parcel with a stale "no scan for 13 days" verdict is
 * delivered, not stuck. Disposal still wins over delivery (carrier destroyed
 * the parcel). Health then wins over a coarse in-transit lifecycle so a stuck
 * moving parcel never reads as healthy.
 *
 * @param {{status:string, health:string, disposed:boolean, checkedAt:*}} snap
 */
function classifyKind({ status, health, disposed, checkedAt } = {}) {
	if (disposed) return 'disposed'
	if (status === 'delivered') return 'delivered'
	if (status === 'exception') return 'exception'
	if (health === 'critical' && status === 'pre_transit') return 'label_only'
	if (health === 'critical') return 'stuck'
	if (health === 'warning') return 'delayed'
	if (status === 'in_transit') return 'moving'
	if (status === 'pre_transit') return 'awaiting'
	if (!checkedAt && (!status || status === 'unknown')) return 'unchecked'
	return 'unknown'
}

/**
 * Chip sizes for the Recently packaged 4PX strip.
 * Independent of the selected tracking chip; respects the caller's WHERE
 * (dedup, shop, day cohort) so a Tuesday Attention count is Tuesday's.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [opts]
 * @param {string} [opts.extraWhere='1 = 1']
 * @param {object} [opts.params={}]
 * @returns {{ total:number, attention:number, moving:number, awaiting:number, delivered:number }}
 */
function listCounts(db, opts = {}) {
	const extraWhere = opts.extraWhere || '1 = 1'
	const params = opts.params || {}
	const empty = { total: 0, attention: 0, moving: 0, awaiting: 0, delivered: 0 }
	try {
		const row = db
			.prepare(
				`SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN ${attentionSql('r')} THEN 1 ELSE 0 END) AS attention,
            SUM(CASE WHEN ${movingSql('r')} THEN 1 ELSE 0 END) AS moving,
            SUM(CASE WHEN ${awaitingSql('r')} THEN 1 ELSE 0 END) AS awaiting,
            SUM(CASE WHEN ${deliveredSql('r')} THEN 1 ELSE 0 END) AS delivered
           FROM receipts r
          WHERE (${extraWhere})`,
			)
			.get(params)
		return {
			total: Number(row?.total) || 0,
			attention: Number(row?.attention) || 0,
			moving: Number(row?.moving) || 0,
			awaiting: Number(row?.awaiting) || 0,
			delivered: Number(row?.delivered) || 0,
		}
	} catch {
		return empty
	}
}

function _alias(alias) {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(alias) ? alias : 'r'
}

function _text(value) {
	if (value == null) return ''
	const text = String(value).replace(/\s+/g, ' ').trim()
	return text
}

function _epoch(value) {
	const n = Number(value)
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

module.exports = {
	FILTERS,
	STATUS_LABELS,
	KIND_LABELS,
	API_INTERNAL_FIELDS,
	isFourpxSql,
	attentionSql,
	movingSql,
	awaitingSql,
	deliveredSql,
	attentionSortSql,
	filterSql,
	normalizeFilter,
	selectSql,
	isFourpxReceipt,
	shapeForApi,
	classifyKind,
	listCounts,
}
