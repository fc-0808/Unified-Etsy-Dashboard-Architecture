'use strict'

const MAX_TRACKING_CODE_LENGTH = 100
const MAX_CARRIER_NAME_LENGTH = 80

function validationError(message) {
	const err = new Error(message)
	err.code = 'VALIDATION'
	err.status = 400
	return err
}

/**
 * Normalize a user-supplied carrier tracking identifier.
 *
 * Tracking codes are operational identifiers, not free-form notes. Restricting
 * them to printable identifier characters prevents control/log injection and
 * removes an entire class of HTML/inline-handler hazards at the storage boundary.
 */
function normalizeTrackingCode(value, { allowEmpty = false } = {}) {
	if (value == null) value = ''
	if (typeof value !== 'string') throw validationError('Tracking number must be text.')
	const code = value.trim()
	if (!code) {
		if (allowEmpty) return ''
		throw validationError('A tracking number is required.')
	}
	if (code.length > MAX_TRACKING_CODE_LENGTH) {
		throw validationError(`Tracking number must be ${MAX_TRACKING_CODE_LENGTH} characters or fewer.`)
	}
	if (!/^[A-Za-z0-9][A-Za-z0-9 ._:/-]*$/.test(code)) {
		throw validationError('Tracking number contains unsupported characters.')
	}
	return code
}

/** Strict 4PX identifier accepted by live carrier-proxy routes. */
function normalizeFourpxTrackingCode(value) {
	const code = normalizeTrackingCode(value)
	if (!/^4PX[A-Za-z0-9]{6,40}$/i.test(code)) {
		throw validationError('Invalid 4PX tracking number.')
	}
	return code.toUpperCase()
}

/**
 * Identifier accepted by 4PX's tracking lookup.
 *
 * The official contract allows up to 50 characters and demonstrates a
 * downstream UPS-style number; 4PX-issued numbers are not contractually
 * required to start with "4PX". Callers must independently prove the identifier
 * belongs to a 4PX consignment before using this broader validator.
 */
function normalizeFourpxLookupCode(value) {
	const code = normalizeTrackingCode(value)
	if (code.length > 50 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(code)) {
		throw validationError('Invalid 4PX tracking lookup identifier.')
	}
	return code.toUpperCase()
}

function normalizeCarrierName(value, { fallback = '4PX' } = {}) {
	if (value == null || value === '') return fallback
	if (typeof value !== 'string') throw validationError('Carrier name must be text.')
	const name = value.trim() || fallback
	if (name.length > MAX_CARRIER_NAME_LENGTH) {
		throw validationError(`Carrier name must be ${MAX_CARRIER_NAME_LENGTH} characters or fewer.`)
	}
	if (/[\u0000-\u001f\u007f<>"'`\\]/.test(name)) {
		throw validationError('Carrier name contains unsupported characters.')
	}
	return name
}

module.exports = {
	MAX_TRACKING_CODE_LENGTH,
	MAX_CARRIER_NAME_LENGTH,
	normalizeTrackingCode,
	normalizeFourpxTrackingCode,
	normalizeFourpxLookupCode,
	normalizeCarrierName,
}
