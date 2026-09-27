'use strict'

/**
 * Perceptual dHash used as canonical product identity across Etsy shops.
 *
 * The SAME physical product is listed separately in each shop (different
 * listing_id and often a different SEO title), so title cannot link them.
 * A raw byte hash only matches byte-identical uploads; shops re-encode and
 * resize, so we use a 17×16 grayscale gradient dHash which is stable across
 * encoding and scaling.
 *
 * v2 adds a second, camera-band-excluded "design" hash. Bumping PRODUCT_HASH_ALGO
 * forces a one-time re-hash of every cached listing image so both fingerprints
 * exist and stay consistent.
 *
 * This module is the single implementation. The shopping-route identity
 * reconciler and the employee "find supplier from a photo" search must never
 * drift onto a second algorithm.
 */

const sharp = require('sharp')

const PRODUCT_HASH_ALGO = 'dhash256-v2'
// Fraction of the image height (from the top) occupied by the phone's camera
// cutout, which varies by phone model for the SAME case design. The design hash
// drops this band so re-lists across models still match. 5 of 21 rows ≈ 24%.
const DESIGN_HASH_DROP_ROWS = 5

// dHash over a grid: compare each grayscale pixel to its right neighbour, reading
// `rows` rows (skipping the first `dropRows`) × 16 comparisons → 256 bits. With
// dropRows=0 this is the full-image hash; with dropRows>0 it excludes the top
// band (camera cutout) to yield a design-region hash. The 256-bit fingerprint
// keeps visual similarity robust while avoiding the original 64-bit collisions.
async function computeDHashGrid(buf, dropRows) {
	const totalRows = 16 + dropRows
	const raw = await sharp(buf).greyscale().resize(17, totalRows, { fit: 'fill' }).raw().toBuffer()
	let hash = 0n
	let bit = 0n
	for (let r = 0; r < 16; r++) {
		const row = r + dropRows
		for (let col = 0; col < 16; col++) {
			if (raw[row * 17 + col] < raw[row * 17 + col + 1]) hash |= 1n << bit
			bit++
		}
	}
	return hash.toString(16).padStart(64, '0')
}

// Full-image perceptual hash (cross-shop / byte-independent product identity).
function computeDHash(buf) {
	return computeDHashGrid(buf, 0)
}

// Design-region hash: same dHash with the top camera band dropped, so the SAME
// case design photographed on different phone models still matches.
function computeDesignHash(buf) {
	return computeDHashGrid(buf, DESIGN_HASH_DROP_ROWS)
}

module.exports = {
	PRODUCT_HASH_ALGO,
	DESIGN_HASH_DROP_ROWS,
	computeDHashGrid,
	computeDHash,
	computeDesignHash,
}
