'use strict'

/**
 * Security boundary for operator-uploaded image bytes.
 *
 * Upload metadata is descriptive, never authoritative. Only passive raster MIME
 * types may be served, `nosniff` prevents HTML bytes disguised as a PNG from being
 * reinterpreted, and a sandboxed CSP makes direct top-level navigation inert.
 * SVG is intentionally excluded because it is an active document format.
 */

const SAFE_MIME = new Map([
	['image/png', 'image/png'],
	['image/jpeg', 'image/jpeg'],
	['image/jpg', 'image/jpeg'],
	['image/webp', 'image/webp'],
	['image/gif', 'image/gif'],
	['image/avif', 'image/avif'],
])

function safeStoredImageMime(value) {
	const mime = String(value || '')
		.split(';', 1)[0]
		.trim()
		.toLowerCase()
	return SAFE_MIME.get(mime) || null
}

/**
 * Apply the passive-image response headers used for operator-uploaded bytes.
 * Use this when streaming a file instead of buffering it through sendStoredImage.
 *
 * @param {import('express').Response} res
 * @param {string} [mime]
 * @param {string} [cacheControl]
 * @returns {string|null} the normalised MIME, or null when the type is not safe
 */
function applyStoredImageHeaders(res, mime, cacheControl = 'private, max-age=300') {
	const safe = safeStoredImageMime(mime)
	if (!safe) return null
	res.setHeader('Content-Type', safe)
	res.setHeader('X-Content-Type-Options', 'nosniff')
	res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
	res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
	if (cacheControl) res.setHeader('Cache-Control', cacheControl)
	return safe
}

/**
 * Send uploaded bytes through a passive-image-only response.
 *
 * @param {import('express').Response} res
 * @param {{data:Buffer, mime?:string}} image
 * @param {string} [cacheControl]
 * @returns {boolean} true when bytes were sent; false when the MIME was rejected
 */
function sendStoredImage(res, image, cacheControl = 'private, max-age=300') {
	const mime = safeStoredImageMime(image?.mime)
	if (!mime || !image?.data) {
		res.status(415).end()
		return false
	}
	applyStoredImageHeaders(res, mime, cacheControl)
	res.send(image.data)
	return true
}

module.exports = {
	SAFE_MIME,
	safeStoredImageMime,
	applyStoredImageHeaders,
	sendStoredImage,
}
