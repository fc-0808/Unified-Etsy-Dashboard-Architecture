'use strict'

/**
 * History → IP-character archive (copy, never move).
 *
 * Production filing is a cascade, not "send every JPEG to chat-vision":
 *
 *   1. Manifest cache (same product_key + hero signature) — $0
 *   2. Strong unique folder-name match against the catalog — $0
 *   3. Accurate pass: up to 3 photos at 1280px, hero in high detail
 *   4. A second independent look when the character is a known look-alike,
 *      the folder name disagrees, the art is a collage, or confidence is under 90
 *   5. Route by confidence: auto-copy / review / originals
 *      A later accurate pass retires a copy it no longer agrees with.
 *
 * Source folders under History are read-only. Destinations live in the
 * sibling listings root (Sanrio/Hello Kitty/…, Miffy/…, Originals/…).
 */

const fs = require('fs')
const path = require('path')
const {
	REVIEW_FOLDER,
	ORIGINALS_FOLDER,
	normaliseCharacter,
	isGenericCharacterName,
	matchNameHints,
	destinationFor,
	defaultListingsRoot,
	stableCopyId,
} = require('./character-catalog')
const history = require('./history-catalog')
const vision = require('./character-sort-vision')

const NAME_AUTO_CONFIDENCE = 92
const AUTO_CONFIDENCE = 80
const REVIEW_CONFIDENCE = 55
const ACCURATE_PASS = 'accurate-v2'
const VISION_USD_PER_CALL = 0.002
const LOOKALIKE_GROUPS = [
	['Miffy', 'My Melody', 'Molang', 'Korilakkuma'],
	['Cinnamoroll', 'Pochacco'],
	['Kuromi', 'My Melody'],
	['Rilakkuma', 'Korilakkuma', 'Pompompurin', 'Winnie the Pooh'],
	['Hello Kitty', 'Minnie Mouse'],
	['Tamagotchi', 'Cinnamoroll'],
]
const SKIP_COPY_NAMES = new Set(['thumbs.db', '.ds_store', 'desktop.ini'])
const DEFAULT_MANIFEST_DIR = () => path.join(require('./config').config.projectRoot, 'data', 'character-sort')

function nowSec() {
	return Math.floor(Date.now() / 1000)
}

function statSafe(p) {
	try {
		return fs.statSync(p)
	} catch {
		return null
	}
}

function readDirSafe(dir) {
	try {
		return fs.readdirSync(dir, { withFileTypes: true })
	} catch {
		return []
	}
}

function heroSignature(disk) {
	const hero = disk && disk.images && disk.images[0]
	if (!hero) return `${disk.product_key}::none`
	return `${disk.product_key}::${hero.filename}::${hero.mtime_ms || 0}::${hero.bytes || 0}`
}

function hintText(disk) {
	const names = [disk.product, disk.batch, disk.product_key]
	for (const img of disk.images || []) names.push(img.filename)
	return names.filter(Boolean).join(' / ')
}

function loadManifest(dir) {
	const file = path.join(dir, 'manifest.jsonl')
	const byKey = new Map()
	if (!fs.existsSync(file)) return { file, byKey }
	const raw = fs.readFileSync(file, 'utf8')
	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) continue
		try {
			const row = JSON.parse(line)
			if (row && row.product_key) byKey.set(row.product_key, row)
		} catch {
			/* skip corrupt line */
		}
	}
	return { file, byKey }
}

function appendManifest(file, record) {
	fs.mkdirSync(path.dirname(file), { recursive: true })
	fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8')
}

function writeReport(dir, report) {
	fs.mkdirSync(dir, { recursive: true })
	fs.writeFileSync(path.join(dir, 'last-run.json'), JSON.stringify(report, null, 2), 'utf8')
}

function routeClassification(result, thresholds) {
	const autoAt = thresholds.autoConfidence
	const reviewAt = thresholds.reviewConfidence
	const name = result.name || ''
	const generic = result.generic === true || result.isOriginal === true || isGenericCharacterName(name)
	const confidence = Number(result.confidence) || 0

	if (generic && confidence >= autoAt) {
		return { decision: 'original', reason: 'confident original / no licensed mascot' }
	}
	if (result.known && confidence >= autoAt && !result.isCollage) {
		return { decision: 'auto', reason: 'known character above auto threshold' }
	}
	if (result.known && confidence >= autoAt && result.isCollage) {
		return { decision: 'auto', reason: 'collage with a dominant catalog character' }
	}
	if (!result.known && name && !generic && confidence >= autoAt) {
		return { decision: 'auto', reason: 'named character above auto threshold' }
	}
	if (confidence >= reviewAt || name) {
		return { decision: 'review', reason: 'below auto threshold or ambiguous collage' }
	}
	return { decision: 'review', reason: 'low confidence' }
}

function classifyFromName(disk) {
	const hits = matchNameHints(hintText(disk))
	const strong = hits.filter((h) => h.strength === 'strong')
	const uniqueStrong = []
	const seen = new Set()
	for (const hit of strong) {
		if (seen.has(hit.name)) continue
		seen.add(hit.name)
		uniqueStrong.push(hit)
	}
	if (uniqueStrong.length === 1) {
		const hit = uniqueStrong[0]
		return {
			layer: 'name',
			name: hit.name,
			franchise: hit.franchise,
			known: true,
			generic: false,
			confidence: NAME_AUTO_CONFIDENCE,
			isCollage: false,
			isOriginal: false,
			hint: hit.matched,
			reasoning: `unique strong folder-name match: "${hit.matched}"`,
		}
	}
	return {
		layer: 'name-miss',
		hits,
		hint: hits.map((h) => h.matched).join(', '),
	}
}

function cachedReusable(prev, disk, opts = {}) {
	if (!prev) return false
	// A name-only pass records "needs vision" as a placeholder. That must not
	// freeze the folder and skip the paid classifier on the next run.
	if (prev.layer === 'needs-vision' || prev.decision === 'error') return false
	// Zero confidence is not a decision. Retry it on the next run.
	if ((Number(prev.confidence) || 0) <= 0) return false
	if (opts.pass && prev.pass !== opts.pass) return false
	if (prev.hero_signature && prev.hero_signature === heroSignature(disk)) return true
	return false
}

function inLookalikeFamily(name) {
	return LOOKALIKE_GROUPS.some((group) => group.includes(name))
}

function sameIdentity(a, b) {
	if (!a || !b) return false
	if (a.generic && b.generic) return Boolean(a.isOriginal) === Boolean(b.isOriginal)
	return Boolean(a.name) && a.name === b.name
}

function needsSecondLook(classified, nameResult) {
	if (!classified) return false
	if (classified.generic && classified.isOriginal && classified.confidence >= 90 && nameResult.layer !== 'name') {
		return false
	}
	if (classified.isCollage) return true
	if ((Number(classified.confidence) || 0) < 90) return true
	if (nameResult.layer === 'name' && nameResult.name !== classified.name) return true
	if (inLookalikeFamily(classified.name) && (Number(classified.confidence) || 0) < 96) return true
	return false
}

function buildRecord(disk, classified, routed, dest, extra = {}) {
	return {
		product_key: disk.product_key,
		shop: disk.shop,
		batch: disk.batch,
		product: disk.product,
		source_path: disk.folder_path,
		hero_signature: heroSignature(disk),
		layer: classified.layer,
		name: classified.name || '',
		franchise: classified.franchise || '',
		known: Boolean(classified.known),
		generic: Boolean(classified.generic),
		confidence: Number(classified.confidence) || 0,
		is_collage: Boolean(classified.isCollage),
		decision: routed.decision,
		reason: routed.reason,
		hint: classified.hint || '',
		reasoning: classified.reasoning || '',
		dest_relative: dest.relative,
		dest_path: extra.destPath || '',
		copied: Boolean(extra.copied),
		skipped: extra.skipped || '',
		vision_calls: Number(extra.visionCalls) || 0,
		pass: extra.pass || '',
		classified_at: nowSec(),
		copied_at: extra.copied ? nowSec() : null,
	}
}

function resolveDestPath(listingsRoot, dest) {
	const root = path.resolve(listingsRoot)
	const full = path.resolve(root, ...dest.parts)
	if (!history.isInsideRoot(root, full)) {
		throw new Error(`Refusing destination outside listings root: ${full}`)
	}
	return full
}

function assertCopySafe({ sourcePath, destPath, historyRoot, listingsRoot }) {
	const src = path.resolve(sourcePath)
	const dest = path.resolve(destPath)
	const hist = path.resolve(historyRoot)
	const list = path.resolve(listingsRoot)
	if (!history.isInsideRoot(hist, src)) {
		throw new Error(`Refusing to read a source outside History: ${src}`)
	}
	if (history.isInsideRoot(hist, dest)) {
		throw new Error(`Refusing to write a copy inside History: ${dest}`)
	}
	if (!history.isInsideRoot(list, dest)) {
		throw new Error(`Refusing to write a copy outside listings root: ${dest}`)
	}
	if (src.toLowerCase() === dest.toLowerCase()) {
		throw new Error('Source and destination are the same path')
	}
}

function destHasPayload(destPath) {
	const st = statSafe(destPath)
	if (!st || !st.isDirectory()) return false
	return readDirSafe(destPath).some((entry) => entry.isFile() || entry.isDirectory())
}

function copyProductFolder(sourcePath, destPath) {
	fs.mkdirSync(path.dirname(destPath), { recursive: true })
	fs.cpSync(sourcePath, destPath, {
		recursive: true,
		errorOnExist: false,
		force: false,
		filter: (src) => !SKIP_COPY_NAMES.has(path.basename(src).toLowerCase()),
	})
}

function shouldCopy(decision, opts) {
	// Name-only is the free pass. Placeholders are not copies.
	if (opts.nameOnly && decision !== 'auto') return false
	if (decision === 'auto') return true
	if (decision === 'original') return opts.copyOriginals !== false
	if (decision === 'review') return opts.copyReview !== false
	return false
}

function estimateCost({ folders = 0, nameHits = 0, cached = 0, visionCalls = 0 } = {}) {
	const pendingVision = Math.max(0, folders - nameHits - cached)
	const calls = Number.isFinite(Number(visionCalls)) ? Number(visionCalls) : pendingVision
	return {
		folders,
		name_hits: nameHits,
		cached,
		estimated_vision_calls: calls,
		usd_per_call: VISION_USD_PER_CALL,
		estimated_usd: Math.round(calls * VISION_USD_PER_CALL * 1000) / 1000,
		naive_all_images_usd: Math.round(folders * 8 * 0.0025 * 100) / 100,
	}
}

async function mapPool(items, concurrency, worker) {
	const out = new Array(items.length)
	let next = 0
	const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
		while (next < items.length) {
			const i = next++
			out[i] = await worker(items[i], i)
		}
	})
	await Promise.all(workers)
	return out
}

function thresholdsFrom(opts = {}) {
	const cfg = (() => {
		try {
			return require('./config').config.characterSort || {}
		} catch {
			return {}
		}
	})()
	const auto = Number(opts.autoConfidence)
	const review = Number(opts.reviewConfidence)
	return {
		autoConfidence: Number.isFinite(auto) ? auto : (Number(cfg.autoConfidence) || AUTO_CONFIDENCE),
		reviewConfidence: Number.isFinite(review) ? review : (Number(cfg.reviewConfidence) || REVIEW_CONFIDENCE),
	}
}

/**
 * Classify one product folder. `opts.identify` injects a fake vision function.
 */
function packVision(identified, nameResult) {
	const norm = normaliseCharacter(identified.name)
	return {
		layer: 'vision',
		name: identified.name,
		franchise: identified.franchise || norm.franchise,
		known: identified.known || norm.known,
		generic: identified.generic || norm.generic === true,
		confidence: identified.confidence,
		isCollage: identified.isCollage,
		isOriginal: identified.isOriginal,
		hint: nameResult.hint || '',
		reasoning: identified.reasoning || '',
	}
}

async function askVision(disk, opts, nameResult, shotCount, independent) {
	const images = (disk.images || []).slice(0, shotCount)
	const hint = independent ? '' : (nameResult.hint || hintText(disk))
	const identified = await vision.identifyProduct(images, {
		hint,
		identify: opts.identify,
		client: opts.client,
		edge: opts.accurate ? 1280 : 768,
		heroDetail: opts.accurate ? 'high' : 'low',
	})
	return identified
}

async function classifyFolder(disk, opts = {}) {
	const thresholds = thresholdsFrom(opts)
	const nameResult = classifyFromName(disk)
	if (nameResult.layer === 'name' && !opts.accurate) {
		const routed = routeClassification(nameResult, thresholds)
		const dest = destinationFor({
			...nameResult,
			decision: routed.decision,
			productKey: disk.product_key,
		})
		return { classified: nameResult, routed, dest, visionCalls: 0 }
	}

	if (opts.nameOnly) {
		const classified = {
			layer: 'needs-vision',
			name: '',
			franchise: '',
			known: false,
			generic: true,
			confidence: 0,
			hint: nameResult.hint || '',
			reasoning: 'name-only mode — vision skipped',
		}
		return {
			classified,
			routed: { decision: 'review', reason: 'name-only mode — no unique strong folder-name match' },
			dest: destinationFor({ ...classified, decision: 'review', productKey: disk.product_key, name: 'needs-vision' }),
			visionCalls: 0,
		}
	}

	const shotCount = opts.accurate ? 3 : (opts.escalate && (disk.images || []).length > 1 ? 2 : 1)
	let identified
	try {
		identified = await askVision(disk, opts, nameResult, shotCount)
	} catch (err) {
		if (err && err.code === 'VISION_DISABLED') {
			const classified = {
				layer: 'needs-vision',
				name: '',
				franchise: '',
				known: false,
				generic: true,
				confidence: 0,
				hint: nameResult.hint || '',
				reasoning: 'vision not configured',
			}
			return {
				classified,
				routed: { decision: 'review', reason: 'vision not configured — name layer had no unique strong match' },
				dest: destinationFor({ ...classified, decision: 'review', productKey: disk.product_key, name: 'needs-vision' }),
				visionCalls: 0,
			}
		}
		const classified = {
			layer: 'vision-error',
			name: '',
			franchise: '',
			known: false,
			generic: true,
			confidence: 0,
			hint: nameResult.hint || '',
			reasoning: String(err && err.message ? err.message : err).slice(0, 200),
		}
		return {
			classified,
			routed: { decision: 'review', reason: 'vision call failed — queued for review' },
			dest: destinationFor({ ...classified, decision: 'review', productKey: disk.product_key, name: 'vision-error' }),
			visionCalls: 1,
		}
	}
	if (!identified) {
		const classified = {
			layer: 'vision-empty',
			name: '',
			franchise: '',
			known: false,
			generic: true,
			confidence: 0,
			reasoning: 'vision returned nothing',
		}
		const routed = { decision: 'review', reason: 'vision returned nothing' }
		return {
			classified,
			routed,
			dest: destinationFor({ ...classified, decision: 'review', productKey: disk.product_key }),
			visionCalls: 1,
		}
	}

	let classified = packVision(identified, nameResult)
	let visionCalls = 1

	if (opts.accurate && needsSecondLook(classified, nameResult)) {
		try {
			const secondRaw = await askVision(disk, opts, { hint: '' }, shotCount, true)
			if (secondRaw) {
				visionCalls += 1
				const second = packVision(secondRaw, { hint: '' })
				const firstName = classified.name
				const firstConf = classified.confidence
				if (sameIdentity(classified, second)) {
					classified.confidence = Math.min(firstConf, second.confidence)
					if (nameResult.layer === 'name' && nameResult.name === classified.name && classified.confidence >= 80) {
						classified.confidence = Math.max(classified.confidence, 90)
					}
					classified.layer = 'vision-confirmed'
					classified.reasoning = [classified.reasoning, second.reasoning].filter(Boolean).join(' | ').slice(0, 400)
				} else {
					classified.confidence = Math.min(firstConf, second.confidence, 69)
					classified.layer = 'vision-split'
					classified.reasoning = `disagreement: ${firstName} vs ${second.name}. ${second.reasoning || ''}`.slice(0, 400)
				}
			}
		} catch (err) {
			classified.reasoning = `${classified.reasoning} | second look failed: ${err.message || err}`.slice(0, 400)
		}
	} else if (!opts.accurate) {
		const mid = classified.confidence >= thresholds.reviewConfidence && classified.confidence < thresholds.autoConfidence
		if (mid && !opts.escalate && (disk.images || []).length > 1 && opts.allowEscalate !== false) {
			const second = await classifyFolder(disk, { ...opts, escalate: true })
			return { ...second, visionCalls: (second.visionCalls || 1) + 1 }
		}
	}

	const routed = routeClassification(classified, thresholds)
	const dest = destinationFor({
		...classified,
		decision: routed.decision,
		productKey: disk.product_key,
	})
	return { classified, routed, dest, visionCalls }
}

function isManagedCopy(destPath, productKey, listingsRoot, historyRoot) {
	if (!destPath) return false
	const full = path.resolve(destPath)
	const list = path.resolve(listingsRoot)
	const hist = path.resolve(historyRoot)
	if (!history.isInsideRoot(list, full)) return false
	if (history.isInsideRoot(hist, full)) return false
	const id = stableCopyId(productKey)
	if (!id || id.length < 3) return false
	return path.basename(full).includes(id)
}

function retireStaleCopy({ prev, destPath, productKey, listingsRoot, historyRoot }) {
	const old = prev && prev.dest_path
	if (!old) return false
	if (path.resolve(old).toLowerCase() === path.resolve(destPath).toLowerCase()) return false
	if (!isManagedCopy(old, productKey, listingsRoot, historyRoot)) return false
	fs.rmSync(old, { recursive: true, force: true })
	return true
}

function walkTargets(opts = {}) {
	const historyRoot = path.resolve(opts.historyRoot || history.defaultHistoryRoot())
	const perFolder = opts.imagesPerFolder || (opts.accurate ? 3 : 2)
	const folders = history.walkProductFolders(historyRoot, { imagesPerFolder: perFolder })
	let list = folders
	if (opts.shop) {
		const shop = String(opts.shop).toLowerCase()
		list = list.filter((row) => String(row.shop || '').toLowerCase() === shop)
	}
	if (opts.productKey) {
		list = list.filter((row) => row.product_key === opts.productKey)
	}
	if (Number.isFinite(Number(opts.offset)) && Number(opts.offset) > 0) {
		list = list.slice(Number(opts.offset))
	}
	if (Number.isFinite(Number(opts.limit)) && Number(opts.limit) > 0) {
		list = list.slice(0, Number(opts.limit))
	}
	return { historyRoot, folders: list, scanned: folders.length }
}

/**
 * Full classify + optional copy run. Safe to re-run: cached signatures skip
 * vision; existing dest folders skip copy.
 */
async function runSort(opts = {}) {
	const { historyRoot, folders, scanned } = walkTargets(opts)
	const listingsRoot = path.resolve(opts.listingsRoot || path.join(historyRoot, '..'))
	const manifestDir = path.resolve(opts.manifestDir || DEFAULT_MANIFEST_DIR())
	const apply = opts.apply === true
	const concurrency = Math.min(4, Math.max(1, Number(opts.concurrency) || 2))
	const manifest = loadManifest(manifestDir)
	const summary = {
		scanned,
		selected: folders.length,
		cached: 0,
		name: 0,
		vision: 0,
		needs_vision: 0,
		auto: 0,
		review: 0,
		original: 0,
		copied: 0,
		already_copied: 0,
		retired: 0,
		skipped: 0,
		errors: 0,
		vision_calls: 0,
	}
	const records = []

	const processOne = async (disk) => {
		try {
			const prev = manifest.byKey.get(disk.product_key)
			let classified
			let routed
			let dest
			let visionCalls = 0
			if (cachedReusable(prev, disk, opts) && opts.force !== true) {
				classified = {
					layer: 'cache',
					name: prev.name,
					franchise: prev.franchise,
					known: prev.known,
					generic: prev.generic,
					confidence: prev.confidence,
					isCollage: prev.is_collage,
					hint: prev.hint,
					reasoning: prev.reasoning,
				}
				routed = { decision: prev.decision, reason: prev.reason || 'cached' }
				dest = destinationFor({
					...classified,
					decision: routed.decision,
					productKey: disk.product_key,
				})
				summary.cached++
			} else {
				const result = await classifyFolder(disk, opts)
				classified = result.classified
				routed = result.routed
				dest = result.dest
				visionCalls = result.visionCalls || 0
				if (classified.layer === 'name') summary.name++
				else if (classified.layer === 'needs-vision') summary.needs_vision++
				else summary.vision++
			}

			if (routed.decision === 'auto') summary.auto++
			else if (routed.decision === 'original') summary.original++
			else summary.review++
			summary.vision_calls += visionCalls

			const destPath = resolveDestPath(listingsRoot, dest)
			let copied = false
			let skipped = ''
			if (apply && opts.pass && prev && prev.pass !== opts.pass && retireStaleCopy({
				prev,
				destPath,
				productKey: disk.product_key,
				listingsRoot,
				historyRoot,
			})) {
				summary.retired++
			}
			if (!apply || !shouldCopy(routed.decision, opts)) {
				skipped = apply ? `decision ${routed.decision} is not in the copy set` : 'dry-run'
				if (!apply) summary.skipped++
			} else {
				assertCopySafe({ sourcePath: disk.folder_path, destPath, historyRoot, listingsRoot })
				if (destHasPayload(destPath) && opts.overwrite !== true) {
					skipped = 'destination already has files'
					summary.already_copied++
				} else {
					copyProductFolder(disk.folder_path, destPath)
					copied = true
					summary.copied++
				}
			}

			const record = buildRecord(disk, classified, routed, dest, { destPath, copied, skipped, visionCalls, pass: opts.pass || '' })
			records.push(record)
			const durable = record.layer !== 'needs-vision' && record.decision !== 'error' && (Number(record.confidence) || 0) > 0
			if ((apply || opts.persistDryRun) && durable) {
				appendManifest(manifest.file, record)
				manifest.byKey.set(record.product_key, record)
			}
			if (typeof opts.onRecord === 'function') opts.onRecord(record)
			return record
		} catch (err) {
			summary.errors++
			const record = {
				product_key: disk.product_key,
				source_path: disk.folder_path,
				decision: 'error',
				reason: err.message || String(err),
				classified_at: nowSec(),
			}
			records.push(record)
			if (typeof opts.onRecord === 'function') opts.onRecord(record)
			return record
		}
	}

	await mapPool(folders, concurrency, processOne)

	const nameHits = summary.name
	const report = {
		started_at: nowSec(),
		apply,
		history_root: historyRoot,
		listings_root: listingsRoot,
		manifest: manifest.file,
		summary,
		cost: estimateCost({
			folders: folders.length,
			nameHits,
			cached: summary.cached,
			visionCalls: summary.vision_calls,
		}),
		records,
	}
	writeReport(manifestDir, {
		started_at: report.started_at,
		apply,
		history_root: historyRoot,
		listings_root: listingsRoot,
		summary,
		cost: report.cost,
	})
	return report
}

function publicRecord(row) {
	if (!row) return null
	return {
		product_key: row.product_key,
		name: row.name,
		franchise: row.franchise,
		confidence: row.confidence,
		decision: row.decision,
		layer: row.layer,
		dest_relative: row.dest_relative,
		copied: row.copied,
		reason: row.reason,
	}
}

module.exports = {
	AUTO_CONFIDENCE,
	REVIEW_CONFIDENCE,
	NAME_AUTO_CONFIDENCE,
	ACCURATE_PASS,
	VISION_USD_PER_CALL,
	REVIEW_FOLDER,
	ORIGINALS_FOLDER,
	heroSignature,
	hintText,
	loadManifest,
	routeClassification,
	classifyFromName,
	classifyFolder,
	walkTargets,
	runSort,
	resolveDestPath,
	assertCopySafe,
	copyProductFolder,
	estimateCost,
	shouldCopy,
	publicRecord,
	defaultListingsRoot,
	stableCopyId,
}
