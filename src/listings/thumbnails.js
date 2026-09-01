'use strict'
/**
 * On-demand thumbnail cache for local product photos.
 *
 * Supplier photos are ~1750×1750 and ~1 MB each. The Inspector paints them into
 * ~72 px tiles, so opening one product used to transfer ~17 MB and force the
 * browser to decode ~50 megapixels to fill a few hundred pixels of screen.
 *
 * This module renders a small WebP once per (file, width), caches it on disk
 * keyed by the source file's mtime+size, and hands the route a strong ETag. A
 * replaced photo changes the key, so a stale thumbnail can never be served.
 *
 * Everything here degrades gracefully: if sharp is unavailable or a file is not
 * a decodable image, the caller falls back to streaming the original bytes.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

let sharp = null
try {
	sharp = require('sharp')
} catch {
	// Optional dependency — callers fall back to the original file.
}

/**
 * Allowlisted output widths. An open-ended `?w=` would let a caller fill the
 * cache with thousands of near-identical renders, so requests are snapped to
 * the nearest supported size instead.
 */
const WIDTHS = [160, 240, 480, 960]

const CACHE_DIR = path.join(os.tmpdir(), 'etsy-dashboard-thumbs')
const CACHE_MAX_BYTES = 512 * 1024 * 1024
const PRUNE_EVERY = 500

// Collapse duplicate work: the Inspector opens ~17 tiles at once and React-less
// re-renders can re-request the same tile while the first render is in flight.
const inFlight = new Map()
let writesSincePrune = 0

/** @returns {boolean} whether thumbnailing is possible in this install. */
function isAvailable() {
	return sharp !== null
}

/**
 * Snap a requested width to the nearest allowlisted size.
 * @param {*} raw
 * @returns {number|null} null when no resize was asked for
 */
function normaliseWidth(raw) {
	if (raw == null || raw === '') return null
	const n = Number(raw)
	if (!Number.isFinite(n) || n <= 0) return null
	if (n >= WIDTHS[WIDTHS.length - 1]) return WIDTHS[WIDTHS.length - 1]
	return WIDTHS.find((w) => w >= n) || WIDTHS[WIDTHS.length - 1]
}

/**
 * Content-addressed key. mtime+size means a replaced photo yields a new key,
 * which is what makes the year-long immutable cache header safe.
 */
function cacheKey(stat, width) {
	return crypto
		.createHash('sha1')
		.update(`${stat.size}:${Math.floor(stat.mtimeMs)}:${width}:webp:v1`)
		.digest('hex')
}

/**
 * Best-effort cache eviction. Thumbnails are ~15 KB, but a large catalogue can
 * still accumulate, so trim the least-recently-modified entries past the cap.
 * Never throws — a failed prune must not break image serving.
 */
function pruneCache() {
	try {
		const names = fs.readdirSync(CACHE_DIR)
		const files = []
		let total = 0
		for (const name of names) {
			try {
				const full = path.join(CACHE_DIR, name)
				const st = fs.statSync(full)
				if (!st.isFile()) continue
				files.push({ full, size: st.size, at: st.mtimeMs })
				total += st.size
			} catch { /* vanished mid-sweep */ }
		}
		if (total <= CACHE_MAX_BYTES) return
		files.sort((a, b) => a.at - b.at)
		for (const f of files) {
			if (total <= CACHE_MAX_BYTES) break
			try {
				fs.unlinkSync(f.full)
				total -= f.size
			} catch { /* already gone */ }
		}
	} catch { /* cache dir missing or unreadable */ }
}

/**
 * Render (or fetch from cache) a thumbnail for a local image.
 *
 * @param {string} srcPath absolute path to the source image
 * @param {number} width   target width (already normalised)
 * @returns {Promise<{path:string,mime:string,etag:string}|null>}
 *          null when thumbnailing is unavailable or the file cannot be decoded,
 *          signalling the caller to stream the original instead.
 */
async function getThumbnail(srcPath, width) {
	if (!sharp || !width) return null

	let stat
	try {
		stat = fs.statSync(srcPath)
	} catch {
		return null
	}
	if (!stat.isFile()) return null

	const key = cacheKey(stat, width)
	const outPath = path.join(CACHE_DIR, `${key}.webp`)
	const result = { path: outPath, mime: 'image/webp', etag: `"${key}"` }

	// A non-empty cache entry is authoritative: the key already encodes the
	// source's identity, so no revalidation against disk is needed.
	try {
		if (fs.statSync(outPath).size > 0) return result
	} catch { /* cache miss */ }

	if (inFlight.has(key)) return inFlight.get(key)

	const job = (async () => {
		try {
			fs.mkdirSync(CACHE_DIR, { recursive: true })
			const buf = await sharp(srcPath, { failOn: 'none' })
				.rotate() // honour EXIF orientation
				.resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
				.webp({ quality: 78, effort: 4 })
				.toBuffer()

			// Write via a unique temp name then rename, so a concurrent reader can
			// never observe a half-written file.
			const tmp = `${outPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
			fs.writeFileSync(tmp, buf)
			try {
				fs.renameSync(tmp, outPath)
			} catch {
				// Another worker won the race; its bytes are equally valid.
				try { fs.unlinkSync(tmp) } catch { /* best effort */ }
			}

			if (++writesSincePrune >= PRUNE_EVERY) {
				writesSincePrune = 0
				setImmediate(pruneCache)
			}
			return result
		} catch {
			return null // not a decodable image → caller streams the original
		} finally {
			inFlight.delete(key)
		}
	})()

	inFlight.set(key, job)
	return job
}

module.exports = { isAvailable, normaliseWidth, getThumbnail, pruneCache, WIDTHS, CACHE_DIR }
