'use strict'

/**
 * Map an Etsy listing onto its Listing History product folder.
 *
 * This is the Route-tab "Needs supplier" locate: the operator needs the local
 * archive (Chinese folder name + original photos) to ask a stall or fill
 * Edit supplier. The History path is NEVER a supplier.
 *
 * Cheapest accurate cascade (no vision, no embeddings):
 *
 *   1. listing_id → bulk_job_items.product_folder basename (how it was listed)
 *   2. Match that name under History/<shop>/ only (shop-root invariant)
 *   3. Persist the mapping so the next dashboard load is a JOIN
 *
 * UPDATE CONTRACT
 * ----------------------------------------------------------------------------
 * Re-running is the point. `updateListingMap` is incremental:
 *
 *   • skip when bulk_name + shop still match AND folder_path still exists
 *   • retry `missing` (History may have gained the batch)
 *   • re-resolve when the bulk folder name changed or the path vanished
 *   • a known Etsy shop never lands in `_Unassigned`
 *
 * Walk of History is cached in-process for a short window so a batch of
 * unmatched listings shares one directory scan.
 */

const fs = require('fs')
const path = require('path')
const catalog = require('./history-catalog')

const MAX_LOCATE = 200
const WALK_CACHE_MS = 30000
const MISSING_RETRY_SEC = 60
const SOURCE_BULK_NAME = 'bulk_name'
const STATUS_RESOLVED = 'resolved'
const STATUS_MISSING = 'missing'
const STATUS_UNMAPPED = 'unmapped'

let _walkCache = { root: '', at: 0, folders: null }

function nowSec() {
	return Math.floor(Date.now() / 1000)
}

function normalizeProductName(name) {
	return String(name || '')
		.normalize('NFC')
		.replace(/_variants$/i, '')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase()
}

function batchHintFromDownloads(folderPath) {
	const parts = String(folderPath || '')
		.split(/[/\\]/)
		.filter(Boolean)
	if (parts.length < 2) return ''
	return parts[parts.length - 2]
}

function listingIdOf(value) {
	const n = Number(value)
	if (!Number.isInteger(n) || n <= 0) return 0
	return n
}

function uniqueListingIds(values) {
	const out = []
	const seen = new Set()
	for (const value of Array.isArray(values) ? values : []) {
		const id = listingIdOf(value)
		if (!id || seen.has(id)) continue
		seen.add(id)
		out.push(id)
		if (out.length >= MAX_LOCATE) break
	}
	return out
}

function invalidateWalkCache() {
	_walkCache = { root: '', at: 0, folders: null }
}

function foldersSnapshot(root) {
	const resolved = path.resolve(root)
	const now = Date.now()
	if (_walkCache.folders && _walkCache.root === resolved && now - _walkCache.at < WALK_CACHE_MS) {
		return _walkCache.folders
	}
	const folders = catalog.walkProductFolders(resolved, { imagesPerFolder: 1 })
	_walkCache = { root: resolved, at: now, folders }
	return folders
}

function scoreCandidate(folder, shop, batchHint) {
	let score = 0
	if (shop && catalog.sameHistoryShop(folder.shop, shop)) score += 100
	if (shop && !catalog.isUnassignedShop(shop) && catalog.isUnassignedShop(folder.shop)) score -= 200
	if (batchHint && folder.batch === batchHint) score += 50
	if (batchHint && folder.batch && folder.batch === batchHint.replace(/_ICDA$/i, '_iPhoneCasesDesignArt')) score += 40
	return score
}

function pickFolder(folders, bulkName, shop, batchHint) {
	if (!bulkName) return { winner: null, how: 'no_bulk_name', candidates: 0 }
	const shopKnown = Boolean(shop && !catalog.isUnassignedShop(shop))
	const haystack = shopKnown
		? folders.filter((f) => catalog.sameHistoryShop(f.shop, shop) && !catalog.isUnassignedShop(f.shop))
		: folders
	const exact = haystack.filter((f) => f.product === bulkName)
	const stripped = haystack.filter((f) => normalizeProductName(f.product) === normalizeProductName(bulkName))
	const pool = exact.length ? exact : stripped
	if (!pool.length) {
		const elsewhere = shopKnown
			? folders.some((f) => {
					const nameHit = f.product === bulkName || normalizeProductName(f.product) === normalizeProductName(bulkName)
					return nameHit && (catalog.isUnassignedShop(f.shop) || !catalog.sameHistoryShop(f.shop, shop))
				})
			: false
		return { winner: null, how: elsewhere ? 'unassigned-blocked' : 'none', candidates: 0 }
	}
	if (pool.length === 1) {
		return { winner: pool[0], how: exact.length ? 'name-exact' : 'name-stripped', candidates: 1 }
	}
	const ranked = pool
		.map((f) => ({ f, score: scoreCandidate(f, shop, batchHint) }))
		.sort((a, b) => b.score - a.score || String(a.f.product_key).localeCompare(String(b.f.product_key)))
	if (ranked[0].score > ranked[1].score) {
		return { winner: ranked[0].f, how: exact.length ? 'name-exact+batch' : 'name-stripped+batch', candidates: pool.length }
	}
	return { winner: null, how: 'name-ambiguous', candidates: pool.length }
}

function folderIdForKey(db, productKey) {
	if (!productKey) return null
	try {
		const row = db.prepare('SELECT id FROM history_folder WHERE product_key = ?').get(productKey)
		return row && row.id != null ? Number(row.id) : null
	} catch {
		return null
	}
}

function inputsForListing(db, listingId, opts = {}) {
	const id = listingIdOf(listingId)
	let shop = catalog.normalizeShopKey(opts.shop || opts.shop_id || '')
	let title = ''
	try {
		const listing = db.prepare('SELECT listing_id, shop_id, title FROM listings WHERE listing_id = ?').get(id)
		if (listing) {
			if (!shop) shop = catalog.normalizeShopKey(listing.shop_id)
			title = listing.title || ''
		}
	} catch {
		/* listings table always exists after initDb; keep going without it */
	}
	let bulkFolder = ''
	let bulkName = ''
	try {
		const bulk = db
			.prepare(
				`SELECT product_folder, product_name
				 FROM bulk_job_items
				 WHERE listing_id = ?
				 ORDER BY updated_at DESC`,
			)
			.get(id)
		if (bulk) {
			bulkFolder = bulk.product_folder || ''
			bulkName = bulkFolder ? path.basename(bulkFolder) : bulk.product_name || ''
		}
	} catch {
		/* bulk table may be empty */
	}
	return {
		listing_id: id,
		shop,
		title,
		bulk_folder: bulkFolder,
		bulk_name: bulkName,
	}
}

function getMapRow(db, listingId) {
	const id = listingIdOf(listingId)
	if (!id) return null
	try {
		return db.prepare('SELECT * FROM history_listing_map WHERE listing_id = ?').get(id) || null
	} catch {
		return null
	}
}

function resolveMappedPath(root, folderPath) {
	if (!folderPath) return null
	const direct = catalog.safeResolveUnder(root, folderPath)
	if (direct) return direct
	const rel = String(folderPath)
		.replace(/^[/\\]+/, '')
		.replace(/\//g, path.sep)
	if (!rel || rel.split(/[/\\]/).some((seg) => seg === '..')) return null
	return catalog.safeResolveUnder(root, path.join(root, rel))
}

function pathStillThere(folderPath, root) {
	const full = resolveMappedPath(root, folderPath)
	if (!full) return false
	try {
		return fs.existsSync(full) && fs.statSync(full).isDirectory()
	} catch {
		return false
	}
}

function isFresh(row, input, root, opts) {
	if (!row || opts.force) return false
	if (String(row.bulk_name || '') !== String(input.bulk_name || '')) return false
	if (input.shop && row.shop && !catalog.sameHistoryShop(row.shop, input.shop) && !catalog.sameHistoryShop(row.history_shop, input.shop)) {
		return false
	}
	if (row.status === STATUS_RESOLVED) {
		if (input.shop && row.history_shop && !catalog.folderBelongsToShop(row.history_shop, input.shop)) return false
		return pathStillThere(row.folder_path, root)
	}
	if (row.status === STATUS_MISSING) {
		const age = nowSec() - Number(row.updated_at || 0)
		return age >= 0 && age < MISSING_RETRY_SEC
	}
	return false
}

function publicMap(row, listingId, opts = {}) {
	const includePath = opts.includePath === true
	if (!row) {
		return {
			listing_id: listingIdOf(listingId) || null,
			status: STATUS_UNMAPPED,
			folder_name: '',
			folder_path: '',
			product_key: '',
			folder_id: null,
			history_shop: '',
			source: '',
		}
	}
	return {
		listing_id: Number(row.listing_id),
		status: row.status || STATUS_MISSING,
		folder_name: row.folder_name || '',
		folder_path: includePath ? row.folder_path || '' : '',
		product_key: row.product_key || '',
		folder_id: row.folder_id != null ? Number(row.folder_id) : null,
		history_shop: row.history_shop || '',
		source: row.source || '',
	}
}

function upsertMap(db, record) {
	db.prepare(
		`INSERT INTO history_listing_map (
			listing_id, shop, history_shop, bulk_name, bulk_folder,
			folder_id, product_key, folder_path, folder_name,
			source, status, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(listing_id) DO UPDATE SET
			shop = excluded.shop,
			history_shop = excluded.history_shop,
			bulk_name = excluded.bulk_name,
			bulk_folder = excluded.bulk_folder,
			folder_id = excluded.folder_id,
			product_key = excluded.product_key,
			folder_path = excluded.folder_path,
			folder_name = excluded.folder_name,
			source = excluded.source,
			status = excluded.status,
			updated_at = excluded.updated_at`,
	).run(
		record.listing_id,
		record.shop || '',
		record.history_shop || '',
		record.bulk_name || '',
		record.bulk_folder || '',
		record.folder_id,
		record.product_key || null,
		record.folder_path || null,
		record.folder_name || null,
		record.source || '',
		record.status,
		nowSec(),
	)
}

function resolveOne(db, input, folders, root) {
	const shopScope = catalog.resolveHistoryShop(input.shop, { root, db })
	const picked = pickFolder(folders, input.bulk_name, input.shop, batchHintFromDownloads(input.bulk_folder))
	if (picked.winner && !pathStillThere(picked.winner.folder_path, root)) {
		invalidateWalkCache()
		picked.winner = null
		picked.how = 'vanished'
	}
	if (!picked.winner) {
		return {
			listing_id: input.listing_id,
			shop: input.shop,
			history_shop: shopScope ? shopScope.shop : '',
			bulk_name: input.bulk_name,
			bulk_folder: input.bulk_folder,
			folder_id: null,
			product_key: null,
			folder_path: null,
			folder_name: null,
			source: picked.how,
			status: STATUS_MISSING,
		}
	}
	const winner = picked.winner
	return {
		listing_id: input.listing_id,
		shop: input.shop,
		history_shop: winner.shop,
		bulk_name: input.bulk_name,
		bulk_folder: input.bulk_folder,
		folder_id: winner.id != null ? Number(winner.id) : folderIdForKey(db, winner.product_key),
		product_key: winner.product_key,
		folder_path: winner.folder_path,
		folder_name: winner.product,
		source: SOURCE_BULK_NAME,
		status: STATUS_RESOLVED,
	}
}

/**
 * Incrementally map listing ids onto History folders.
 *
 * @param {object} db
 * @param {Array<number|{listing_id:number, shop?:string}>} items
 * @param {{ root?: string, force?: boolean, refresh?: boolean, folders?: object[] }} [opts]
 */
function updateListingMap(db, items, opts = {}) {
	catalog.ensureSchema(db)
	const root = path.resolve(opts.root || catalog.defaultHistoryRoot())
	if (opts.refresh) invalidateWalkCache()

	const deduped = []
	const seen = new Set()
	let capped = false
	for (const raw of Array.isArray(items) ? items : []) {
		let listingId = 0
		let shop = ''
		if (raw && typeof raw === 'object') {
			listingId = listingIdOf(raw.listing_id)
			shop = raw.shop || raw.shop_id || ''
		} else {
			listingId = listingIdOf(raw)
		}
		if (!listingId || seen.has(listingId)) continue
		if (deduped.length >= MAX_LOCATE) {
			capped = true
			break
		}
		seen.add(listingId)
		deduped.push({ listing_id: listingId, shop })
	}

	const snapshot = {
		checked: deduped.length,
		skipped: 0,
		resolved: 0,
		missing: 0,
		updated: 0,
		capped,
	}
	if (!deduped.length) return { ...snapshot, maps: [] }

	const prepared = []
	for (const item of deduped) {
		const input = inputsForListing(db, item.listing_id, { shop: item.shop })
		const existing = getMapRow(db, item.listing_id)
		prepared.push({ item, input, existing, fresh: isFresh(existing, input, root, opts) })
	}

	const needWalk = prepared.some((row) => !row.fresh)
	const folders = needWalk ? (opts.folders != null ? opts.folders : foldersSnapshot(root)) : []

	const maps = []
	const write = db.transaction(() => {
		for (const row of prepared) {
			if (row.fresh) {
				snapshot.skipped++
				if (row.existing.status === STATUS_RESOLVED) snapshot.resolved++
				else snapshot.missing++
				maps.push(publicMap(row.existing, row.item.listing_id, { includePath: true }))
				continue
			}
			const record = resolveOne(db, row.input, folders, root)
			upsertMap(db, record)
			snapshot.updated++
			if (record.status === STATUS_RESOLVED) snapshot.resolved++
			else snapshot.missing++
			maps.push(publicMap(record, row.item.listing_id, { includePath: true }))
		}
	})
	write()
	return { ...snapshot, maps }
}

function loadMapByIds(db, listingIds) {
	catalog.ensureSchema(db)
	const ids = uniqueListingIds(listingIds)
	const out = new Map()
	if (!ids.length) return out
	const placeholders = ids.map(() => '?').join(',')
	try {
		for (const row of db.prepare(`SELECT * FROM history_listing_map WHERE listing_id IN (${placeholders})`).all(...ids)) {
			out.set(Number(row.listing_id), row)
		}
	} catch {
		return out
	}
	return out
}

function collectRouteLocateItems(db, rows, root) {
	const items = []
	const seen = new Set()
	for (const row of Array.isArray(rows) ? rows : []) {
		if (!row || row.sourcing_reason !== 'not_in_catalog') continue
		if (row.dismissed || row.excluded) continue
		const id = listingIdOf(row.product_listing_id || row.listing_id)
		if (!id || seen.has(id)) continue
		seen.add(id)
		items.push({ listing_id: id, shop: row.shop_id || row.shop || '' })
	}
	if (!items.length) return []
	const pending = []
	for (const item of items) {
		const input = inputsForListing(db, item.listing_id, { shop: item.shop })
		const existing = getMapRow(db, item.listing_id)
		if (isFresh(existing, input, root, {})) continue
		pending.push(item)
	}
	return pending
}

/**
 * Attach a public `history_folder` onto Route rows that are not in catalog.
 * Wrong-stall lines already have a location — they are left alone.
 * Sourced lines get `null`. Omits local `folder_path` so packers on
 * GET /api/route/dashboard never receive a machine path.
 *
 * With `{ locate: true }` (dashboard GET), unmatched listings are mapped
 * incrementally before the JOIN so future "Needs supplier" products show a
 * folder without a client click.
 */
function attachHistoryFolders(db, rows, opts = {}) {
	if (!Array.isArray(rows) || !rows.length) return rows
	catalog.ensureSchema(db)
	const root = path.resolve(opts.root || catalog.defaultHistoryRoot())
	if (opts.locate) {
		const items = collectRouteLocateItems(db, rows, root)
		if (items.length) {
			updateListingMap(db, items, { root, folders: opts.folders, refresh: false })
		}
	}
	const ids = []
	for (const row of rows) {
		if (!row || row.sourcing_reason !== 'not_in_catalog') continue
		const id = listingIdOf(row.product_listing_id || row.listing_id)
		if (id) ids.push(id)
	}
	const map = loadMapByIds(db, ids)
	for (const row of rows) {
		if (!row) continue
		if (row.sourcing_reason !== 'not_in_catalog') {
			row.history_folder = null
			continue
		}
		const id = listingIdOf(row.product_listing_id || row.listing_id)
		row.history_folder = publicMap(id ? map.get(id) : null, id, { includePath: false })
	}
	return rows
}

function syncMissingFolders(db, opts = {}) {
	catalog.ensureSchema(db)
	const root = path.resolve(opts.root || catalog.defaultHistoryRoot())
	let marked = 0
	let rows = []
	try {
		rows = db.prepare("SELECT listing_id, folder_path, product_key FROM history_listing_map WHERE status = 'resolved'").all()
	} catch {
		return { marked: 0 }
	}
	const missingKeys = new Set()
	try {
		for (const row of db.prepare("SELECT product_key FROM history_folder WHERE status = 'missing'").all()) {
			if (row.product_key) missingKeys.add(row.product_key)
		}
	} catch {
		/* index may be empty */
	}
	const upd = db.prepare(
		`UPDATE history_listing_map
		 SET status = 'missing', updated_at = ?
		 WHERE listing_id = ?`,
	)
	const tx = db.transaction(() => {
		for (const row of rows) {
			const gone = missingKeys.has(row.product_key) || !pathStillThere(row.folder_path, root)
			if (!gone) continue
			upd.run(nowSec(), row.listing_id)
			marked++
		}
	})
	tx()
	return { marked }
}

function resolveOpenPath(db, opts = {}) {
	catalog.ensureSchema(db)
	const root = path.resolve(opts.root || catalog.defaultHistoryRoot())
	const folderId = Number(opts.folder_id)
	if (Number.isInteger(folderId) && folderId > 0) {
		let row = null
		try {
			row = db.prepare('SELECT * FROM history_folder WHERE id = ?').get(folderId)
		} catch {
			row = null
		}
		if (!row) {
			const err = new Error('Folder is not in the History index')
			err.status = 404
			throw err
		}
		const fp = resolveMappedPath(root, row.folder_path)
		if (!fp) {
			const err = new Error('Folder is outside the History root')
			err.status = 400
			throw err
		}
		if (!fs.existsSync(fp)) {
			const err = new Error('Folder is not on disk')
			err.status = 404
			throw err
		}
		return { folder_path: fp, product_key: row.product_key, folder_id: Number(row.id), folder_name: row.product }
	}

	const listingId = listingIdOf(opts.listing_id)
	if (!listingId) {
		const err = new Error('Need a listing id or folder id')
		err.status = 400
		throw err
	}
	updateListingMap(db, [{ listing_id: listingId, shop: opts.shop }], { root, force: !!opts.force })
	const mapped = getMapRow(db, listingId)
	if (!mapped || mapped.status !== STATUS_RESOLVED || !mapped.folder_path) {
		const err = new Error('No History folder for that listing')
		err.status = 404
		throw err
	}
	const fp = resolveMappedPath(root, mapped.folder_path)
	if (!fp || !fs.existsSync(fp)) {
		const err = new Error('Folder is not on disk')
		err.status = 404
		throw err
	}
	return {
		folder_path: fp,
		product_key: mapped.product_key,
		folder_id: mapped.folder_id != null ? Number(mapped.folder_id) : null,
		folder_name: mapped.folder_name,
		listing_id: listingId,
	}
}

module.exports = {
	MAX_LOCATE,
	MISSING_RETRY_SEC,
	SOURCE_BULK_NAME,
	STATUS_RESOLVED,
	STATUS_MISSING,
	STATUS_UNMAPPED,
	normalizeProductName,
	pickFolder,
	inputsForListing,
	getMapRow,
	publicMap,
	updateListingMap,
	loadMapByIds,
	attachHistoryFolders,
	syncMissingFolders,
	resolveOpenPath,
	invalidateWalkCache,
	uniqueListingIds,
	listingIdOf,
}
