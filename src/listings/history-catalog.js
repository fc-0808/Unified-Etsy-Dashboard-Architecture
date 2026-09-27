'use strict'

/**
 * Listing History catalog — the on-disk product archive.
 *
 * Layout (always treated as "a folder of images = one physical product"):
 *
 *   <History>/
 *     iPhoneCasesDesignArt/           Etsy shop (first-level folder)
 *       0904_iPhoneCasesDesignArt/    batch (date + shop slug)
 *         粉色线条猫咪16+13_variants/ product — original_01.jpg, …
 *     iPhoneCasesByTwily/
 *     Y2KASEofficial/
 *       0616_Y2KASEofficial/1/
 *     _Unassigned/                    ONLY when the Etsy shop is unknown
 *
 * Shop-root invariant
 * -------------------
 * A listing from an Etsy shop always archives under that shop's first-level
 * History folder — never another shop, and never `_Unassigned` once the shop
 * is known. Example:
 *
 *   iPhoneCasesDesignArt listing
 *     → <History>/iPhoneCasesDesignArt/<batch>/<product>/
 *   IPhoneCasesByTwily listing
 *     → <History>/iPhoneCasesByTwily/<batch>/<product>/
 *
 * Default History root:
 *   %USERPROFILE%\OneDrive\Documents\E-Commerce\Etsy\Listings\History
 *
 * Etsy `shop_id` casing may differ from the on-disk folder
 * (`IPhoneCasesDesignArt` vs `iPhoneCasesDesignArt`). Matching is
 * case-insensitive; returned paths use the on-disk folder name.
 *
 * Identity is the POSIX-relative product key (`iPhoneCasesDesignArt/0904_…/…`),
 * not the absolute path, so OneDrive rearranges and drive-letter changes
 * do not fork the visual index.
 *
 * This module has no AI / network dependency. Schema + walk live here so
 * `initDb` can create tables without pulling the embedding stack.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { IMAGE_EXTS, VIDEO_EXTS, naturalCompare, scanProductFolder } = require('./scanner')
const { config } = require('./config')

const SKIP_DIR_NAMES = new Set([
	'.git',
	'.svn',
	'.ds_store',
	'node_modules',
	'__pycache__',
	'_archive',
	'archive',
	'$recycle.bin',
	'system volume information',
])

const DEFAULT_IMAGES_PER_FOLDER = 3
const MAX_WALK_DEPTH = 5
const UNASSIGNED_SHOP = '_Unassigned'

function defaultHistoryRoot() {
	const fromCfg = String((config.history && config.history.root) || process.env.LISTINGS_HISTORY_ROOT || '').trim()
	if (fromCfg) return path.resolve(fromCfg)
	return path.resolve(os.homedir(), 'OneDrive', 'Documents', 'E-Commerce', 'Etsy', 'Listings', 'History')
}

function imagesPerFolder(value) {
	const fallback = (config.history && config.history.imagesPerFolder) || DEFAULT_IMAGES_PER_FOLDER
	const n = value == null ? fallback : Number(value)
	if (!Number.isFinite(n)) return DEFAULT_IMAGES_PER_FOLDER
	return Math.min(8, Math.max(1, Math.round(n)))
}

function toPosix(rel) {
	return String(rel || '')
		.replace(/\\/g, '/')
		.replace(/^\/+/, '')
		.replace(/\/+$/, '')
}

function productKeyFromParts(parts) {
	return toPosix((Array.isArray(parts) ? parts : []).filter(Boolean).join('/'))
}

function parseProductKey(key) {
	const parts = toPosix(key).split('/').filter(Boolean)
	return {
		shop: parts[0] || '',
		batch: parts.length > 2 ? parts[1] : '',
		product: parts.length ? parts[parts.length - 1] : '',
		parts,
	}
}

function normalizeShopKey(shop) {
	return String(shop || '').trim()
}

function sameHistoryShop(a, b) {
	const left = normalizeShopKey(a).toLowerCase()
	const right = normalizeShopKey(b).toLowerCase()
	return Boolean(left && right && left === right)
}

function isUnassignedShop(shop) {
	return sameHistoryShop(shop, UNASSIGNED_SHOP)
}

function listHistoryShopDirs(root) {
	const resolved = path.resolve(root)
	const out = []
	for (const entry of readDirSafe(resolved)) {
		if (!entry.isDirectory() || skipDirName(entry.name)) continue
		out.push(entry.name)
	}
	return out
}

function listKnownHistoryShops(opts = {}) {
	const root = path.resolve(opts.root || defaultHistoryRoot())
	const byLower = new Map()
	const add = (name) => {
		const n = normalizeShopKey(name)
		if (!n) return
		const key = n.toLowerCase()
		if (!byLower.has(key)) byLower.set(key, n)
	}
	for (const dir of listHistoryShopDirs(root)) add(dir)
	if (opts.db) {
		try {
			for (const row of opts.db.prepare('SELECT DISTINCT shop FROM history_folder').all()) add(row.shop)
		} catch {
			/* index may not exist yet */
		}
	}
	return [...byLower.values()]
}

/**
 * Map an Etsy shop_id onto History/<shop>/.
 * Returns the on-disk folder name when it exists (case-insensitive).
 * A known shop never resolves to `_Unassigned`.
 */
function resolveHistoryShop(shopId, opts = {}) {
	const wanted = normalizeShopKey(shopId)
	if (!wanted) return null
	const historyRoot = path.resolve(opts.root || defaultHistoryRoot())
	const known = listKnownHistoryShops({ root: historyRoot, db: opts.db })
	const exact = known.find((name) => name === wanted)
	const ci = known.find((name) => name.toLowerCase() === wanted.toLowerCase())
	const shop = exact || ci || wanted
	if (isUnassignedShop(shop) && !isUnassignedShop(wanted)) {
		return {
			shop: wanted,
			folder_path: path.join(historyRoot, wanted),
			exists: false,
		}
	}
	const folderPath = path.join(historyRoot, shop)
	const st = statSafe(folderPath)
	return {
		shop,
		folder_path: folderPath,
		exists: Boolean(st && st.isDirectory()),
	}
}

function historyShopRoot(shopId, opts = {}) {
	const resolved = resolveHistoryShop(shopId, opts)
	return resolved ? resolved.folder_path : null
}

function folderBelongsToShop(folderShop, shopId) {
	if (!normalizeShopKey(shopId)) return true
	return sameHistoryShop(folderShop, shopId)
}

/**
 * Etsy listing id encoded in a query filename (Cursor assets, bulk exports).
 * Example: `…_images_4569379722_Kitty_Cat_Mug-….jpg`
 */
function listingIdFromQueryName(name) {
	const s = String(name || '')
	const tagged = s.match(/_images_(\d{9,12})(?:[_-]|$)/i)
	if (tagged) return tagged[1]
	const basename = path.basename(s, path.extname(s))
	if (/^\d{9,12}$/.test(basename)) return basename
	const lead = basename.match(/^(\d{9,12})[_-]/)
	return lead ? lead[1] : ''
}

function skipDirName(name) {
	const n = String(name || '').trim()
	if (!n || n.startsWith('.')) return true
	return SKIP_DIR_NAMES.has(n.toLowerCase())
}

/**
 * True when `target` is the History root or a path inside it.
 * Uses `path.relative` so `..` and alternate drive letters cannot sneak out.
 */
function isInsideRoot(root, target) {
	if (!root || !target) return false
	const base = path.resolve(root)
	const full = path.resolve(target)
	if (process.platform === 'win32') {
		if (base.toLowerCase() === full.toLowerCase()) return true
	} else if (base === full) {
		return true
	}
	const rel = path.relative(base, full)
	if (!rel) return true
	if (path.isAbsolute(rel)) return false
	const segs = rel.split(/[/\\]/)
	return segs.every((seg) => seg !== '..')
}

function safeResolveUnder(root, target) {
	const full = path.resolve(target)
	if (!isInsideRoot(root, full)) return null
	return full
}

function readDirSafe(dir) {
	try {
		return fs.readdirSync(dir, { withFileTypes: true })
	} catch {
		return []
	}
}

function statSafe(p) {
	try {
		return fs.statSync(p)
	} catch {
		return null
	}
}

function isImageName(name) {
	return IMAGE_EXTS.has(path.extname(String(name || '')).toLowerCase())
}

function folderHasImages(dir) {
	for (const entry of readDirSafe(dir)) {
		if (entry.isFile() && isImageName(entry.name)) return true
	}
	return false
}

function productHintFromKey(key) {
	const blob = toPosix(key).toLowerCase()
	if (/\bairpods?\b/.test(blob) || /air[-_]?pods/.test(blob)) return 'airpods_case'
	if (/\bwatch\b/.test(blob) || /watch[-_]?band/.test(blob)) return 'watch_band'
	if (/\bipad\b/.test(blob)) return 'ipad_case'
	return 'iphone_case'
}

/**
 * Walk History and yield one record per product folder (a directory that
 * itself contains image files). Nested `_archive` folders are skipped;
 * we never recurse *into* a product folder, so archived leftovers cannot
 * become a second identity.
 *
 * @param {string} root
 * @returns {Array<{
 *   product_key: string,
 *   folder_path: string,
 *   shop: string,
 *   batch: string,
 *   product: string,
 *   product_hint: string,
 *   image_count: number,
 *   mtime_ms: number,
 *   images: Array<{path:string, filename:string, mime:string, rank:number, bytes:number, mtime_ms:number}>
 * }>}
 */
function walkProductFolders(root, opts = {}) {
	const resolved = path.resolve(root)
	const maxImages = imagesPerFolder(opts.imagesPerFolder)
	const out = []

	const visit = (dir, depth, parts) => {
		if (depth > MAX_WALK_DEPTH) return
		if (folderHasImages(dir)) {
			const scanned = scanProductFolder(dir, { maxImages })
			if (!scanned.imageCount) return
			const st = statSafe(dir)
			const images = scanned.images.map((img) => {
				const fileStat = statSafe(img.path)
				return {
					path: img.path,
					filename: img.filename,
					mime: img.mime,
					rank: img.rank,
					bytes: fileStat ? Number(fileStat.size) || 0 : 0,
					mtime_ms: fileStat ? Math.floor(fileStat.mtimeMs) : 0,
				}
			})
			const key = productKeyFromParts(parts)
			if (!key) return
			out.push({
				product_key: key,
				folder_path: dir,
				shop: parts[0] || '',
				batch: parts.length > 2 ? parts[1] : '',
				product: parts[parts.length - 1] || '',
				product_hint: productHintFromKey(key),
				image_count: scanned.imageCount,
				mtime_ms: st ? Math.floor(st.mtimeMs) : 0,
				images,
			})
			return
		}
		for (const entry of readDirSafe(dir)) {
			if (!entry.isDirectory() || skipDirName(entry.name)) continue
			visit(path.join(dir, entry.name), depth + 1, parts.concat(entry.name))
		}
	}

	const rootStat = statSafe(resolved)
	if (!rootStat || !rootStat.isDirectory()) return out
	for (const entry of readDirSafe(resolved)) {
		if (!entry.isDirectory() || skipDirName(entry.name)) continue
		visit(path.join(resolved, entry.name), 1, [entry.name])
	}
	out.sort((a, b) => a.product_key.localeCompare(b.product_key, undefined, { numeric: true, sensitivity: 'base' }))
	return out
}

function countHistoryTree(root) {
	const folders = walkProductFolders(root, { imagesPerFolder: 1 })
	let shops = 0
	const seenShop = new Set()
	for (const row of folders) {
		if (row.shop && !seenShop.has(row.shop)) {
			seenShop.add(row.shop)
			shops++
		}
	}
	return {
		root: path.resolve(root),
		exists: Boolean(statSafe(root) && statSafe(root).isDirectory()),
		shops,
		folders: folders.length,
		product_keys: folders.map((row) => row.product_key),
	}
}

function ensureSchema(db) {
	if (!db || typeof db.exec !== 'function') throw new Error('history catalog needs a sqlite handle')
	db.exec(`
		CREATE TABLE IF NOT EXISTS history_folder (
			id              INTEGER PRIMARY KEY,
			product_key     TEXT    NOT NULL UNIQUE,
			folder_path     TEXT    NOT NULL,
			shop            TEXT    NOT NULL,
			batch           TEXT    NOT NULL DEFAULT '',
			product         TEXT    NOT NULL,
			product_hint    TEXT    NOT NULL DEFAULT 'iphone_case',
			hero_filename   TEXT,
			image_count     INTEGER NOT NULL DEFAULT 0,
			indexed_images  INTEGER NOT NULL DEFAULT 0,
			mtime_ms        INTEGER,
			status          TEXT    NOT NULL DEFAULT 'active',
			indexed_at      INTEGER
		);
		CREATE INDEX IF NOT EXISTS idx_history_folder_status ON history_folder(status);
		CREATE INDEX IF NOT EXISTS idx_history_folder_shop ON history_folder(shop, batch);

		CREATE TABLE IF NOT EXISTS history_image (
			id            INTEGER PRIMARY KEY,
			folder_id     INTEGER NOT NULL REFERENCES history_folder(id) ON DELETE CASCADE,
			filename      TEXT    NOT NULL,
			bytes         INTEGER,
			mtime_ms      INTEGER,
			sha           TEXT    NOT NULL,
			role          TEXT    NOT NULL DEFAULT 'extra',
			phash         TEXT,
			design_phash  TEXT,
			hash_algo     TEXT,
			dim           INTEGER,
			embed_algo    TEXT,
			embedding     BLOB,
			computed_at   INTEGER,
			UNIQUE(folder_id, filename)
		);
		CREATE INDEX IF NOT EXISTS idx_history_image_folder ON history_image(folder_id);
		CREATE INDEX IF NOT EXISTS idx_history_image_sha ON history_image(sha);
		CREATE INDEX IF NOT EXISTS idx_history_image_embed ON history_image(embed_algo);

		CREATE TABLE IF NOT EXISTS history_index_meta (
			key         TEXT PRIMARY KEY,
			value       TEXT NOT NULL,
			updated_at  INTEGER
		);

		CREATE TABLE IF NOT EXISTS history_match_log (
			id            INTEGER PRIMARY KEY,
			created_at    INTEGER NOT NULL,
			query_sha     TEXT,
			query_name    TEXT,
			folder_id     INTEGER,
			product_key   TEXT,
			confidence    TEXT,
			source        TEXT,
			score         REAL,
			action        TEXT,
			payload_json  TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_history_match_log_created ON history_match_log(created_at);

		CREATE TABLE IF NOT EXISTS history_listing_map (
			listing_id    INTEGER PRIMARY KEY,
			shop          TEXT    NOT NULL DEFAULT '',
			history_shop  TEXT    NOT NULL DEFAULT '',
			bulk_name     TEXT    NOT NULL DEFAULT '',
			bulk_folder   TEXT    NOT NULL DEFAULT '',
			folder_id     INTEGER,
			product_key   TEXT,
			folder_path   TEXT,
			folder_name   TEXT,
			source        TEXT    NOT NULL DEFAULT '',
			status        TEXT    NOT NULL DEFAULT 'missing',
			updated_at    INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_history_listing_map_status ON history_listing_map(status);
		CREATE INDEX IF NOT EXISTS idx_history_listing_map_shop ON history_listing_map(shop);
	`)
}

function publicFolder(row) {
	if (!row) return null
	return {
		id: Number(row.id),
		product_key: row.product_key,
		folder_path: row.folder_path,
		shop: row.shop,
		batch: row.batch,
		product: row.product,
		product_hint: row.product_hint,
		hero_filename: row.hero_filename,
		image_count: Number(row.image_count) || 0,
		indexed_images: Number(row.indexed_images) || 0,
		status: row.status,
		indexed_at: row.indexed_at != null ? Number(row.indexed_at) : null,
	}
}

module.exports = {
	SKIP_DIR_NAMES,
	DEFAULT_IMAGES_PER_FOLDER,
	MAX_WALK_DEPTH,
	UNASSIGNED_SHOP,
	IMAGE_EXTS,
	VIDEO_EXTS,
	defaultHistoryRoot,
	imagesPerFolder,
	toPosix,
	productKeyFromParts,
	parseProductKey,
	normalizeShopKey,
	sameHistoryShop,
	isUnassignedShop,
	listHistoryShopDirs,
	listKnownHistoryShops,
	resolveHistoryShop,
	historyShopRoot,
	folderBelongsToShop,
	listingIdFromQueryName,
	skipDirName,
	isInsideRoot,
	safeResolveUnder,
	productHintFromKey,
	walkProductFolders,
	countHistoryTree,
	ensureSchema,
	publicFolder,
	naturalCompare,
}
