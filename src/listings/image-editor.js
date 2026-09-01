'use strict'
/**
 * Non-destructive crop / rotate for local product photos.
 *
 * Supplier photos arrive framed for the supplier's own listing, not ours: the
 * case sits off-centre, a watermark rides the edge, or the shot is padded with
 * dead space that Etsy's square search tile then crops badly. The Inspector
 * lets an operator re-frame a photo before the draft is created; this module is
 * the part that actually rewrites the pixels.
 *
 * Three properties make it safe to point at a supplier's only copy of a photo:
 *
 *  • Reversible. The pristine file is copied into a `_originals/` subfolder the
 *    first time a photo is edited, so `restore()` always gets the operator back
 *    to exactly what arrived, however many crops later.
 *  • Atomic. The new bytes are written to a temp file in the same directory and
 *    renamed over the original, so a crash or a concurrent reader can never
 *    observe a half-written photo.
 *  • In place. The filename never changes, which is what lets the rest of the
 *    pipeline stay oblivious: the image plan (`preview.imageOrder`), the
 *    variation-photo links (style → rank) and the Etsy upload all address
 *    photos by filename and keep working untouched. The thumbnail cache keys on
 *    mtime+size, so a crop invalidates it automatically.
 *
 * Geometry contract with the browser: the crop rectangle arrives in the pixel
 * space of the EXIF-oriented image *after* the requested rotation — exactly the
 * frame the operator dragged the box in, since browsers auto-orient `<img>`
 * too. `render()` reproduces that frame with `autoOrient().rotate(deg)` before
 * extracting, so what was previewed is what gets written.
 */

const fs = require('fs')
const path = require('path')

let sharp = null
try {
	sharp = require('sharp')
} catch {
	// Optional dependency — callers surface a clear "editing unavailable" error.
}

/** Subfolder holding the pristine copy of every edited photo. */
const ORIGINALS_DIR = '_originals'

/** Smallest crop we will render, per side, in source pixels. */
const MIN_SIDE = 48

/** Quarter turns are the only rotations offered — no resampling, no guesswork. */
const ROTATIONS = new Set([0, 90, 180, 270])

/**
 * Formats we can re-encode back into the same file. Anything else is refused
 * rather than silently converted: a changed extension would mean a changed
 * filename, and the image plan addresses photos by name.
 */
const ENCODABLE = new Set(['jpeg', 'png', 'webp', 'gif'])

function err(message, status) {
	const e = new Error(message)
	e.status = status
	return e
}

/** @returns {boolean} whether pixel editing is possible in this install. */
function isAvailable() {
	return sharp !== null
}

/** Clamp `v` into [lo, hi]; non-finite input collapses to `lo`. */
function clamp(v, lo, hi) {
	if (!Number.isFinite(v)) return lo
	return v < lo ? lo : v > hi ? hi : v
}

/**
 * Coerce a requested rotation to one of the four quarter turns.
 * Anything unrecognised means "don't rotate" rather than an error — a bad
 * rotation should never be able to fail an otherwise valid crop.
 * @param {*} raw
 * @returns {0|90|180|270}
 */
function normaliseRotation(raw) {
	const n = Math.round(Number(raw))
	if (!Number.isFinite(n)) return 0
	const deg = ((n % 360) + 360) % 360
	return ROTATIONS.has(deg) ? deg : 0
}

/**
 * The frame the operator sees: source dimensions after EXIF orientation and
 * after the requested quarter turn.
 * @param {{width:number,height:number}} oriented
 * @param {number} rotation
 * @returns {{width:number,height:number}}
 */
function frameSize(oriented, rotation) {
	return rotation === 90 || rotation === 270
		? { width: oriented.height, height: oriented.width }
		: { width: oriented.width, height: oriented.height }
}

/**
 * Snap a requested rectangle to whole pixels inside `frame`.
 *
 * The browser measures in CSS pixels and divides by a fractional scale, so its
 * numbers land a fraction off the edge routinely. Clamping (rather than
 * rejecting) is deliberate: a one-pixel rounding disagreement must not fail an
 * operator's crop. Only a genuinely unusable rectangle — smaller than
 * MIN_SIDE — is an error.
 *
 * @param {{left?:number,top?:number,width?:number,height?:number}} spec
 * @param {{width:number,height:number}} frame
 * @returns {{left:number,top:number,width:number,height:number}}
 */
function normaliseCrop(spec, frame) {
	const fw = Math.max(1, Math.round(frame.width))
	const fh = Math.max(1, Math.round(frame.height))
	const s = spec || {}
	const left = clamp(Math.round(Number(s.left)), 0, fw - 1)
	const top = clamp(Math.round(Number(s.top)), 0, fh - 1)
	const width = clamp(Math.round(Number(s.width ?? fw)), 1, fw - left)
	const height = clamp(Math.round(Number(s.height ?? fh)), 1, fh - top)

	const min = Math.min(MIN_SIDE, fw, fh)
	if (width < min || height < min) {
		throw err(`That crop is too small — keep at least ${min}\u00d7${min} pixels.`, 400)
	}
	return { left, top, width, height }
}

/** True when this crop+rotation would reproduce the source pixel for pixel. */
function isNoop(rect, frame, rotation) {
	return (
		rotation === 0 &&
		rect.left === 0 &&
		rect.top === 0 &&
		rect.width === Math.round(frame.width) &&
		rect.height === Math.round(frame.height)
	)
}

/** Path of the pristine copy kept for `srcPath`. */
function originalPathFor(srcPath) {
	return path.join(path.dirname(srcPath), ORIGINALS_DIR, path.basename(srcPath))
}

/** Whether a pristine copy is on hand to restore. */
function hasOriginal(srcPath) {
	try {
		return fs.statSync(originalPathFor(srcPath)).size > 0
	} catch {
		return false
	}
}

/**
 * Dimensions and format of a photo as the browser will display it — i.e. with
 * the EXIF orientation already applied, which is what `<img>.naturalWidth`
 * reports and therefore the space the crop box is dragged in.
 *
 * @param {string} srcPath
 * @returns {Promise<{format:string,width:number,height:number}>}
 */
async function readGeometry(srcPath) {
	if (!sharp) throw err('Photo editing is unavailable on this install.', 503)
	let meta
	try {
		meta = await sharp(srcPath, { failOn: 'none' }).metadata()
	} catch {
		throw err('That file could not be read as an image.', 400)
	}
	// EXIF orientations 5–8 are the quarter turns, which transpose the stored
	// dimensions relative to how the photo is displayed.
	const transposed = meta.orientation >= 5 && meta.orientation <= 8
	const width = transposed ? meta.height : meta.width
	const height = transposed ? meta.width : meta.height
	if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
		throw err('That file could not be read as an image.', 400)
	}
	return { format: String(meta.format || '').toLowerCase(), width, height }
}

/**
 * Re-encode into the source's own format. Settings favour fidelity over bytes:
 * these files are uploaded to Etsy once and never served from here, and a
 * visibly softened re-crop of a product photo is worth far more than the disk
 * space saved.
 */
function encode(pipeline, format) {
	switch (format) {
		case 'jpeg':
			return pipeline.jpeg({ quality: 92, chromaSubsampling: '4:4:4', mozjpeg: true })
		case 'png':
			return pipeline.png({ compressionLevel: 9 })
		case 'webp':
			return pipeline.webp({ quality: 92 })
		case 'gif':
			// Etsy flattens listing images anyway, so the first frame is all that
			// would ever have been shown to a buyer.
			return pipeline.gif()
		default:
			throw err('Only JPG, PNG, GIF and WebP photos can be cropped.', 400)
	}
}

/**
 * Render the cropped bytes without touching disk.
 *
 * @param {string} srcPath
 * @param {{format:string}} geometry  from readGeometry()
 * @param {number} rotation           0 | 90 | 180 | 270
 * @param {{left:number,top:number,width:number,height:number}} rect
 * @returns {Promise<{data:Buffer,width:number,height:number}>}
 */
async function render(srcPath, geometry, rotation, rect) {
	if (!sharp) throw err('Photo editing is unavailable on this install.', 503)
	if (!ENCODABLE.has(geometry.format)) {
		throw err('Only JPG, PNG, GIF and WebP photos can be cropped.', 400)
	}

	// `animated: false` keeps the pipeline on a single frame. Extracting from an
	// animated GIF's filmstrip representation would slice through every frame.
	let pipeline = sharp(srcPath, { failOn: 'none', animated: false }).autoOrient()
	if (rotation) pipeline = pipeline.rotate(rotation)
	pipeline = pipeline.extract(rect)
	// Carry the source's colour profile through so a wide-gamut photo does not
	// shift hue on the way to Etsy. Other metadata (notably the EXIF orientation
	// tag, which we have just baked into the pixels) is deliberately dropped.
	if (typeof pipeline.keepIccProfile === 'function') pipeline = pipeline.keepIccProfile()

	let out
	try {
		out = await encode(pipeline, geometry.format).toBuffer({ resolveWithObject: true })
	} catch (e) {
		if (e && e.status) throw e
		throw err(`Could not crop this photo: ${e.message}`, 400)
	}
	if (!out.data || !out.data.length) throw err('Cropping produced an empty image.', 500)
	return { data: out.data, width: out.info.width, height: out.info.height }
}

/**
 * Write `data` over `destPath` atomically: a temp file in the same directory
 * (same filesystem, so the rename is a metadata operation) swapped in with a
 * single rename. `.tmp` keeps the in-flight file out of every image scan.
 */
function writeAtomic(destPath, data) {
	const dir = path.dirname(destPath)
	const tmp = path.join(dir, `.${path.basename(destPath)}.${process.pid}.${Date.now()}.tmp`)
	try {
		fs.writeFileSync(tmp, data)
		fs.renameSync(tmp, destPath)
	} catch (e) {
		try {
			fs.unlinkSync(tmp)
		} catch {
			/* nothing to clean up */
		}
		throw err(`Could not save the cropped photo: ${e.message}`, 500)
	}
}

/**
 * Copy the current file aside as the pristine original, once. Later crops
 * deliberately do NOT refresh it: "revert" must mean "as it arrived", not "as
 * it was before the last edit".
 */
function preserveOriginal(srcPath) {
	const dest = originalPathFor(srcPath)
	if (hasOriginal(srcPath)) return dest
	try {
		fs.mkdirSync(path.dirname(dest), { recursive: true })
		fs.copyFileSync(srcPath, dest)
	} catch (e) {
		// Without a recoverable original this stops being a safe edit, so refuse
		// rather than quietly destroying the supplier's only copy.
		throw err(`Could not back up the original photo before cropping: ${e.message}`, 500)
	}
	return dest
}

/**
 * Crop (and optionally rotate) a photo in place, preserving the original.
 *
 * @param {string} srcPath absolute path to the photo
 * @param {{left?:number,top?:number,width?:number,height?:number,rotate?:number}} spec
 *        rectangle in the EXIF-oriented, post-rotation pixel space
 * @returns {Promise<{changed:boolean,width:number,height:number,bytes:number,
 *                    format:string,rotate:number,
 *                    rect:{left:number,top:number,width:number,height:number}}>}
 */
async function crop(srcPath, spec) {
	const geometry = await readGeometry(srcPath)
	const rotation = normaliseRotation(spec && spec.rotate)
	const frame = frameSize(geometry, rotation)
	const rect = normaliseCrop(spec, frame)

	const base = {
		format: geometry.format,
		rotate: rotation,
		rect,
	}
	// Re-encoding an untouched photo would only cost it a generation of quality.
	if (isNoop(rect, frame, rotation)) {
		return { ...base, changed: false, width: frame.width, height: frame.height, bytes: 0 }
	}

	const { data, width, height } = await render(srcPath, geometry, rotation, rect)
	preserveOriginal(srcPath)
	writeAtomic(srcPath, data)
	return { ...base, changed: true, width, height, bytes: data.length }
}

/**
 * Put the pristine photo back and forget the edit.
 *
 * @param {string} srcPath
 * @returns {Promise<{width:number,height:number}>} the restored dimensions
 */
async function restore(srcPath) {
	const original = originalPathFor(srcPath)
	if (!hasOriginal(srcPath)) throw err('No original is stored for this photo.', 404)
	let data
	try {
		data = fs.readFileSync(original)
	} catch (e) {
		throw err(`Could not read the stored original: ${e.message}`, 500)
	}
	writeAtomic(srcPath, data)
	// Only drop the backup once the restore has landed, so a failed write leaves
	// the operator with something to retry against.
	try {
		fs.unlinkSync(original)
	} catch {
		/* a stale backup is harmless — it is simply re-used next time */
	}
	try {
		const geometry = await readGeometry(srcPath)
		return { width: geometry.width, height: geometry.height }
	} catch {
		return { width: 0, height: 0 }
	}
}

module.exports = {
	isAvailable,
	crop,
	restore,
	readGeometry,
	render,
	hasOriginal,
	originalPathFor,
	normaliseRotation,
	normaliseCrop,
	frameSize,
	isNoop,
	ORIGINALS_DIR,
	MIN_SIDE,
}
