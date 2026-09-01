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
	res.setHeader('Content-Type', mime)
	res.setHeader('X-Content-Type-Options', 'nosniff')
	res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
	res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
	res.setHeader('Cache-Control', cacheControl)
	res.send(image.data)
	return true
}

module.exports = {
	SAFE_MIME,
	safeStoredImageMime,
	sendStoredImage,
}
