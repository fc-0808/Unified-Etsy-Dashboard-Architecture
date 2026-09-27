'use strict'

/**
 * Local visual prior for phone-snap → listing-photo matching.
 *
 * Full-image dHash cannot recover a table snap of a packaged case against a
 * studio shot of the same print (Hamming lands in the random band). Pastel
 * camera-bumper hues also shift under plastic wrap and warm indoor light, so
 * they are not a primary key.
 *
 * What *is* stable is the dark ink of the print and the mid-tone colour of
 * the artwork: a dense Kuromi sticker collage with a KUROMI bar is a very
 * different occupancy grid (and Lab chroma) from a sparse repeating-face
 * wash or a pink gothic collage. After cropping away the table / cyc /
 * hands, those signatures demote outliers. Absolute cosine is often weak
 * on snap-vs-studio pairs, so scores are also min-max normalised *inside
 * the shortlist* for the LLM rerank without inventing a confident match.
 *
 * No extra vendor. Sharp only. Failures return null and lexical rank stands.
 */

const sharp = require('sharp')

const PROBE_WIDTH = 140
const PROBE_HEIGHT = 210
const SIGN_WIDTH = 48
const SIGN_HEIGHT = 80
const GRID_COLS = 5
const GRID_ROWS = 8
const HUE_BINS = 8

function clamp(n, lo, hi) {
	return Math.min(hi, Math.max(lo, n))
}

function rgbToHsv(r, g, b) {
	r /= 255
	g /= 255
	b /= 255
	const max = Math.max(r, g, b)
	const min = Math.min(r, g, b)
	const d = max - min
	let h = 0
	if (d) {
		if (max === r) h = ((g - b) / d) % 6
		else if (max === g) h = (b - r) / d + 2
		else h = (r - g) / d + 4
		h *= 60
		if (h < 0) h += 360
	}
	return { h, s: max === 0 ? 0 : d / max, v: max }
}

function rgbToLab(r, g, b) {
	let R = r / 255
	let G = g / 255
	let B = b / 255
	R = R > 0.04045 ? ((R + 0.055) / 1.055) ** 2.4 : R / 12.92
	G = G > 0.04045 ? ((G + 0.055) / 1.055) ** 2.4 : G / 12.92
	B = B > 0.04045 ? ((B + 0.055) / 1.055) ** 2.4 : B / 12.92
	let x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047
	let y = R * 0.2126 + G * 0.7152 + B * 0.0722
	let z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883
	const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
	const fx = f(x)
	const fy = f(y)
	const fz = f(z)
	return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

function isIgnoredBackground(hsv, lab) {
	if (lab[0] > 91 && hsv.s < 0.1) return true
	if (lab[0] < 8) return true
	const wood =
		hsv.h >= 16 &&
		hsv.h <= 52 &&
		hsv.s >= 0.16 &&
		hsv.s <= 0.7 &&
		lab[0] > 26 &&
		lab[0] < 82 &&
		lab[2] > 8
	if (wood) return true
	const skin =
		hsv.h >= 8 &&
		hsv.h <= 42 &&
		hsv.s >= 0.14 &&
		hsv.s <= 0.55 &&
		lab[0] > 42 &&
		lab[0] < 84 &&
		lab[1] > 10 &&
		lab[2] > 4
	return Boolean(skin)
}

function readRgb(raw, width, x, y) {
	const i = (y * width + x) * 3
	return [raw[i], raw[i + 1], raw[i + 2]]
}

function productBBox(raw, width, height) {
	const col = new Array(width).fill(0)
	const row = new Array(height).fill(0)
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const [r, g, b] = readRgb(raw, width, x, y)
			const hsv = rgbToHsv(r, g, b)
			const lab = rgbToLab(r, g, b)
			if (isIgnoredBackground(hsv, lab)) continue
			col[x]++
			row[y]++
		}
	}
	const colThresh = Math.max(3, height * 0.1)
	const rowThresh = Math.max(3, width * 0.1)
	let x0 = 0
	let x1 = width - 1
	while (x0 < width && col[x0] < colThresh) x0++
	while (x1 > x0 && col[x1] < colThresh) x1--
	let y0 = 0
	let y1 = height - 1
	while (y0 < height && row[y0] < rowThresh) y0++
	while (y1 > y0 && row[y1] < rowThresh) y1--
	const bw = x1 - x0 + 1
	const bh = y1 - y0 + 1
	if (bw < width * 0.28 || bh < height * 0.35) {
		return { left: 0, top: 0, width, height }
	}
	const padX = Math.max(1, Math.round(bw * 0.02))
	const padY = Math.max(1, Math.round(bh * 0.015))
	const left = Math.max(0, x0 - padX)
	const top = Math.max(0, y0 - padY)
	return {
		left,
		top,
		width: Math.min(width - left, bw + padX * 2),
		height: Math.min(height - top, bh + padY * 2),
	}
}

function darkOccupancy(gray) {
	const sorted = Array.from(gray).sort((a, b) => a - b)
	const p20 = sorted[Math.floor(sorted.length * 0.2)]
	const p40 = sorted[Math.floor(sorted.length * 0.4)]
	const thresh = clamp(Math.round(p20 * 0.65 + p40 * 0.35), 38, 96)
	const grid = []
	for (let gy = 0; gy < GRID_ROWS; gy++) {
		for (let gx = 0; gx < GRID_COLS; gx++) {
			const x0 = Math.floor((gx * SIGN_WIDTH) / GRID_COLS)
			const x1 = Math.floor(((gx + 1) * SIGN_WIDTH) / GRID_COLS)
			const y0 = Math.floor((gy * SIGN_HEIGHT) / GRID_ROWS)
			const y1 = Math.floor(((gy + 1) * SIGN_HEIGHT) / GRID_ROWS)
			let dark = 0
			let n = 0
			for (let y = y0; y < y1; y++) {
				for (let x = x0; x < x1; x++) {
					if (gray[y * SIGN_WIDTH + x] <= thresh) dark++
					n++
				}
			}
			grid.push(n ? dark / n : 0)
		}
	}
	return { grid, thresh }
}

function gridStats(grid) {
	const n = grid.length
	const mass = grid.reduce((s, v) => s + v, 0)
	const mean = n ? mass / n : 0
	let varSum = 0
	for (const v of grid) varSum += (v - mean) ** 2
	return { mass, mean, variance: n ? varSum / n : 0 }
}

function chromaSignature(rgb) {
	const bins = new Array(HUE_BINS).fill(0)
	let n = 0
	let sL = 0
	let sA = 0
	let sB = 0
	const pixels = SIGN_WIDTH * SIGN_HEIGHT
	for (let i = 0; i < pixels; i++) {
		const r = rgb[i * 3]
		const g = rgb[i * 3 + 1]
		const b = rgb[i * 3 + 2]
		const hsv = rgbToHsv(r, g, b)
		if (hsv.s < 0.18 || hsv.v < 0.22 || hsv.v > 0.94) continue
		const lab = rgbToLab(r, g, b)
		if (isIgnoredBackground(hsv, lab)) continue
		const bin = Math.min(HUE_BINS - 1, Math.floor(hsv.h / (360 / HUE_BINS)))
		bins[bin] += hsv.s * hsv.v
		sL += lab[0]
		sA += lab[1]
		sB += lab[2]
		n++
	}
	return {
		bins,
		chromaMass: pixels ? n / pixels : 0,
		centroid: n >= 24 ? { L: sL / n, a: sA / n, b: sB / n } : null,
	}
}

function cosine(a, b) {
	if (!a || !b || a.length !== b.length) return 0
	let dot = 0
	let na = 0
	let nb = 0
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i]
		na += a[i] * a[i]
		nb += b[i] * b[i]
	}
	if (na < 1e-8 || nb < 1e-8) return 0
	return clamp(dot / Math.sqrt(na * nb), 0, 1)
}

function chromaDeltaE(a, b) {
	if (!a || !b) return null
	const dL = a.L - b.L
	const da = a.a - b.a
	const db = a.b - b.b
	return Math.sqrt(dL * dL + da * da + db * db)
}

async function computeVisualSignature(buf) {
	if (!Buffer.isBuffer(buf) || buf.length < 32) return null
	let probe
	try {
		probe = await sharp(buf, { failOn: 'none' })
			.rotate()
			.resize(PROBE_WIDTH, PROBE_HEIGHT, { fit: 'inside' })
			.removeAlpha()
			.raw()
			.toBuffer({ resolveWithObject: true })
	} catch {
		return null
	}
	if (!probe || !probe.data || probe.info.width < 8 || probe.info.height < 8) return null
	const box = productBBox(probe.data, probe.info.width, probe.info.height)
	let rgb
	try {
		rgb = await sharp(probe.data, {
			raw: { width: probe.info.width, height: probe.info.height, channels: 3 },
		})
			.extract({
				left: box.left,
				top: box.top,
				width: Math.max(8, box.width),
				height: Math.max(8, box.height),
			})
			.resize(SIGN_WIDTH, SIGN_HEIGHT, { fit: 'fill' })
			.raw()
			.toBuffer()
	} catch {
		return null
	}
	let gray
	try {
		gray = await sharp(rgb, {
			raw: { width: SIGN_WIDTH, height: SIGN_HEIGHT, channels: 3 },
		})
			.greyscale()
			.normalize()
			.raw()
			.toBuffer()
	} catch {
		return null
	}
	const { grid } = darkOccupancy(gray)
	const stats = gridStats(grid)
	const chroma = chromaSignature(rgb)
	return { grid, ...stats, hues: chroma.bins, chromaMass: chroma.chromaMass, centroid: chroma.centroid }
}

function layoutSimilarity(a, b) {
	if (!a || !b || !a.grid || !b.grid) return 0
	return cosine(a.grid, b.grid)
}

function hueSimilarity(a, b) {
	if (!a || !b || !a.hues || !b.hues) return 0
	if ((a.chromaMass || 0) < 0.04 || (b.chromaMass || 0) < 0.04) return 0
	return cosine(a.hues, b.hues)
}

function visualDistance(a, b) {
	return 1 - layoutSimilarity(a, b)
}

function visualSimilarity(a, b) {
	return layoutSimilarity(a, b)
}

function visualConfidence(similarity) {
	const n = Number(similarity)
	if (!Number.isFinite(n)) return 'distant'
	if (n >= 0.82) return 'likely'
	if (n >= 0.68) return 'possible'
	if (n >= 0.55) return 'weak'
	return 'distant'
}

/**
 * Dense sticker collages have much more dark ink than a repeating-face wash
 * on a pastel field. Ratio is on the occupancy-grid *sum*, not the mean.
 */
function massMismatch(querySig, candidateSig) {
	const q = Number(querySig && querySig.mass) || 0
	const c = Number(candidateSig && candidateSig.mass) || 0
	if (q < 1) return false
	if (c < 0.15) return true
	const ratio = c / q
	if (ratio < 0.42 || ratio > 2.4) return true
	const qv = Number(querySig && querySig.variance) || 0
	const cv = Number(candidateSig && candidateSig.variance) || 0
	if (qv >= 0.05 && cv > 0 && cv / qv < 0.48) return true
	return false
}

function hueMismatch(querySig, candidateSig) {
	if (!querySig || !candidateSig) return false
	if ((querySig.chromaMass || 0) < 0.05 || (candidateSig.chromaMass || 0) < 0.05) return false
	const hist = hueSimilarity(querySig, candidateSig)
	const delta = chromaDeltaE(querySig.centroid, candidateSig.centroid)
	if (delta == null) return false
	// Snap-vs-studio hue histograms are noisy; only a large Lab shift is a miss.
	return delta >= 32 && hist < 0.55
}

function outlierFactor(querySig, candidateSig) {
	let factor = 1
	if (massMismatch(querySig, candidateSig)) factor *= 0.28
	if (hueMismatch(querySig, candidateSig)) factor *= 0.42
	return factor
}

/**
 * Absolute cosine on phone-snap vs studio-shot pairs is often low even for
 * the true print. Rank *inside this shortlist* so the best layout still
 * floats up; if nobody separates, visual is treated as unknown.
 */
function relativeVisualScores(items, { minSpan = 0.02 } = {}) {
	const list = Array.isArray(items) ? items : []
	const vals = list.map((item) =>
		Number.isFinite(item && item.layout_similarity) ? item.layout_similarity : 0,
	)
	if (!vals.length) return list
	const max = Math.max(...vals)
	const min = Math.min(...vals)
	if (max - min < minSpan) {
		return list.map((item) => ({ ...item, visual_similarity: null, visual_distance: null }))
	}
	return list.map((item, i) => {
		const rel = 0.28 + 0.72 * ((vals[i] - min) / (max - min))
		return { ...item, visual_similarity: rel, visual_distance: 1 - rel }
	})
}

async function scoreSignatures(querySig, items) {
	if (!Array.isArray(items)) return []
	const out = []
	for (const item of items) {
		let sig = item && item.signature
		if (!sig && item && Buffer.isBuffer(item.jpeg)) {
			try {
				sig = await computeVisualSignature(item.jpeg)
			} catch {
				sig = null
			}
		}
		const layout = querySig && sig ? layoutSimilarity(querySig, sig) : 0
		const hue = querySig && sig ? hueSimilarity(querySig, sig) : 0
		const massOut = querySig && sig ? massMismatch(querySig, sig) : false
		const hueOut = querySig && sig ? hueMismatch(querySig, sig) : false
		const factor = querySig && sig ? outlierFactor(querySig, sig) : 1
		const base = Number(item && item.score) || 0
		out.push({
			...item,
			signature: sig || null,
			layout_similarity: layout,
			hue_similarity: hue,
			mass_outlier: massOut,
			hue_outlier: hueOut,
			score: base * factor,
		})
	}
	return relativeVisualScores(out)
}

function blendRankScore(item) {
	const lexical = Math.max(0, Number(item && (item.score != null ? item.score : item.row && item.row.score)) || 0)
	const lexicalNorm = clamp(lexical / 24, 0, 1.15)
	const visual = item && Number.isFinite(item.visual_similarity) ? item.visual_similarity : null
	if (visual == null) return lexicalNorm
	return 0.42 * lexicalNorm + 0.58 * visual
}

function compareBlended(a, b) {
	const aOut = Number(Boolean(a && (a.mass_outlier || a.hue_outlier || a.layout_outlier)))
	const bOut = Number(Boolean(b && (b.mass_outlier || b.hue_outlier || b.layout_outlier)))
	if (aOut !== bOut) return aOut - bOut
	const delta = blendRankScore(b) - blendRankScore(a)
	if (Math.abs(delta) > 1e-6) return delta
	const va = Number.isFinite(a.visual_similarity) ? a.visual_similarity : -1
	const vb = Number.isFinite(b.visual_similarity) ? b.visual_similarity : -1
	if (va !== vb) return vb - va
	return (Number(b.score) || 0) - (Number(a.score) || 0)
}

async function cropProductJpeg(buf, { edge = 384, quality = 72 } = {}) {
	if (!Buffer.isBuffer(buf) || buf.length < 32) return null
	let probe
	try {
		probe = await sharp(buf, { failOn: 'none' })
			.rotate()
			.resize(PROBE_WIDTH, PROBE_HEIGHT, { fit: 'inside' })
			.removeAlpha()
			.raw()
			.toBuffer({ resolveWithObject: true })
	} catch {
		return null
	}
	if (!probe || !probe.data || probe.info.width < 8 || probe.info.height < 8) return null
	const box = productBBox(probe.data, probe.info.width, probe.info.height)
	const area = (box.width * box.height) / (probe.info.width * probe.info.height)
	if (!(area > 0.12 && area < 0.88)) return null
	let meta
	try {
		meta = await sharp(buf, { failOn: 'none' }).rotate().metadata()
	} catch {
		return null
	}
	const srcW = Number(meta.width) || 0
	const srcH = Number(meta.height) || 0
	if (srcW < 16 || srcH < 16) return null
	const scaleX = srcW / probe.info.width
	const scaleY = srcH / probe.info.height
	const left = Math.max(0, Math.min(srcW - 8, Math.floor(box.left * scaleX)))
	const top = Math.max(0, Math.min(srcH - 8, Math.floor(box.top * scaleY)))
	const width = Math.max(8, Math.min(srcW - left, Math.round(box.width * scaleX)))
	const height = Math.max(8, Math.min(srcH - top, Math.round(box.height * scaleY)))
	if (width < 16 || height < 16) return null
	try {
		return await sharp(buf, { failOn: 'none' })
			.rotate()
			.extract({ left, top, width, height })
			.resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
			.jpeg({ quality, mozjpeg: false })
			.toBuffer()
	} catch {
		return null
	}
}

module.exports = {
	PROBE_WIDTH,
	SIGN_WIDTH,
	GRID_COLS,
	GRID_ROWS,
	cropProductJpeg,
	computeVisualSignature,
	massMismatch,
	hueMismatch,
	chromaDeltaE,
	hueSimilarity,
	layoutSimilarity,
	visualDistance,
	visualSimilarity,
	visualConfidence,
	relativeVisualScores,
	scoreSignatures,
	blendRankScore,
	compareBlended,
}
