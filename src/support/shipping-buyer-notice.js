'use strict'

/**
 * Buyer-outreach copy for stuck and disposed 4PX parcels.
 *
 * Etsy Open API v3 has no shop-to-buyer messaging endpoint, so the operator
 * pastes the draft into the Etsy conversation by hand.
 *
 *   · one deterministic template per kind (stuck vs disposed), filled with the
 *     order's real name / shop / tracking;
 *   · carrier "last event" strings are never quoted into the buyer message.
 */

const NOTICE_KINDS = Object.freeze(['stuck', 'disposed'])
const ETSY_SOLD_ORDER_URL = (receiptId) => `https://www.etsy.com/your/orders/sold?order_id=${receiptId}`

function firstName(name) {
	const n = String(name || '').trim()
	if (!n) return ''
	if (n.includes(',')) return n.split(',').pop().trim().split(/\s+/)[0]
	return n.split(/\s+/)[0]
}

function normalizeKind(kind) {
	return kind === 'disposed' ? 'disposed' : kind === 'stuck' ? 'stuck' : null
}

/**
 * Build the ready-to-paste Etsy message for one stuck or disposed parcel.
 *
 * `lastEvent` is accepted for call-site compatibility / logging but is never
 * interpolated into the buyer-facing body — carrier scan text is not safe to
 * quote on Etsy.
 *
 * @param {object} ctx
 * @param {'stuck'|'disposed'} ctx.kind
 * @param {string} [ctx.shopName]
 * @param {string} [ctx.buyerName]
 * @param {string} [ctx.trackingNo]
 * @param {string} [ctx.lastEvent] Ignored in the message body (operator-only).
 * @param {string} [ctx.country]
 * @returns {{ kind: string, message: string }}
 */
function composeShippingBuyerNotice(ctx = {}) {
	const kind = normalizeKind(ctx.kind)
	if (!kind) {
		const err = new Error('Buyer outreach is only drafted for stuck or disposed parcels')
		err.status = 400
		throw err
	}

	const shop = String(ctx.shopName || '').trim() || 'our shop'
	const buyer = firstName(ctx.buyerName) || 'there'
	const tracking = String(ctx.trackingNo || '').trim()
	const trackingLine = tracking
		? `Your tracking number is ${tracking} (it is also on your Etsy receipt).`
		: 'Your tracking number is on your Etsy receipt.'
	const dest = String(ctx.country || '').trim()
	const destLine = dest ? ` The destination on the order is ${dest}.` : ''

	let message
	if (kind === 'stuck') {
		message =
			`Hi ${buyer},\n\n` +
			`Thank you for your order from ${shop}.\n\n` +
			`Your parcel has not moved with the carrier for some time. ${trackingLine}${destLine}\n\n` +
			`This sometimes happens when the delivery address on file cannot be confirmed. Please contact the carrier shown on that tracking and ask them to confirm or update the delivery address. If they need a correction from us, reply here on Etsy with the updated address and we will pass it on.\n\n` +
			`We are watching the tracking as well and will update you in this Etsy conversation. Please keep all replies here on Etsy so we can help you quickly.\n\n` +
			`Warmly,\n` +
			`The ${shop} Team`
	} else {
		message =
			`Hi ${buyer},\n\n` +
			`Thank you for your order from ${shop}.\n\n` +
			`The carrier has marked your parcel as disposed or undeliverable, which usually happens after delivery could not be completed — often because the address could not be confirmed. ${trackingLine}${destLine}\n\n` +
			`Please contact the carrier shown on that tracking and ask whether the address can still be updated, or whether the parcel has already been processed. Reply here on Etsy with anything they tell you so we can keep helping.\n\n` +
			`We are following up with the carrier on our side too, and we will share next steps in this Etsy conversation. Please keep all communication here on Etsy.\n\n` +
			`Warmly,\n` +
			`The ${shop} Team`
	}

	return { kind, message }
}

module.exports = {
	NOTICE_KINDS,
	ETSY_SOLD_ORDER_URL,
	firstName,
	normalizeKind,
	composeShippingBuyerNotice,
}
