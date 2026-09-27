'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const CATEGORIES = Object.freeze([
	{ slug: 'bags', name: 'Bags', sort_order: 10 },
	{ slug: 'boxes', name: 'Boxes', sort_order: 20 },
	{ slug: 'mailers', name: 'Mailers', sort_order: 30 },
	{ slug: 'bubble_wrap', name: 'Bubble Wrap', sort_order: 40 },
	{ slug: 'tape', name: 'Tape', sort_order: 50 },
	{ slug: 'stickers', name: 'Stickers', sort_order: 60 },
	{ slug: 'cards', name: 'Cards & Inserts', sort_order: 70 },
	{ slug: 'seals', name: 'Seals', sort_order: 80 },
	{ slug: 'misc', name: 'Misc', sort_order: 90 },
])

const ITEM_FAMILIES = Object.freeze({
	stickers: Object.freeze([
		{ slug: 'hello_kitty', name: 'Hello Kitty' },
		{ slug: 'kuromi', name: 'Kuromi' },
		{ slug: 'cinnamoroll', name: 'Cinnamoroll' },
		{ slug: 'my_melody', name: 'My Melody' },
		{ slug: 'miffy', name: 'Miffy' },
		{ slug: 'mametchi', name: 'Mametchi' },
		{ slug: 'other', name: 'Other stickers' },
	]),
})

const FAMILY_INFER_RULES = Object.freeze([
	['hello_kitty', /hello\s*kitty|凯蒂/i],
	['kuromi', /kuromi|库洛米/i],
	['cinnamoroll', /cinnamoroll|玉桂狗|大耳狗|肉桂狗/i],
	['my_melody', /my\s*melody|美乐蒂/i],
	['miffy', /miffy|米菲/i],
	['mametchi', /mametchi|mamechi|玛梅吉/i],
])

const UOMS = new Set(['each', 'roll', 'sheet', 'pack', 'box'])
const CURRENCIES = new Set(['USD', 'CNY', 'HKD', 'EUR', 'GBP', 'JPY'])
const CARD_THUMB_WIDTH = 240
const DETAIL_THUMB_WIDTH = 480
const STORED_PHOTO_MAX = 960
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024
const ITEM_NAME_MAX = 120

const ITEM_COLUMN_MIGRATIONS = Object.freeze([
	['unit_cost', 'REAL'],
	['currency', "TEXT NOT NULL DEFAULT 'USD'"],
	['supplier_name', 'TEXT'],
	['supplier_url', 'TEXT'],
	['name_zh', 'TEXT'],
	['sort_order', 'INTEGER NOT NULL DEFAULT 0'],
	['family', 'TEXT'],
	['needs_purchase', 'INTEGER NOT NULL DEFAULT 0'],
	['needs_purchase_at', 'TEXT'],
	['needs_purchase_by', 'TEXT'],
	['purchased_at', 'TEXT'],
	['purchased_by', 'TEXT'],
])

const MOVEMENT_COLUMN_MIGRATIONS = Object.freeze([
	['unit_cost', 'REAL'],
	['cost_total', 'REAL'],
	['currency', 'TEXT'],
])

function trySharp() {
	try {
		return require('sharp')
	} catch {
		return null
	}
}

function migrateSuppliesSchema(db) {
	db.exec(`
		CREATE TABLE IF NOT EXISTS supply_categories (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			slug TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL,
			sort_order INTEGER NOT NULL DEFAULT 0
		);

		CREATE TABLE IF NOT EXISTS supply_items (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			sku TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL,
			name_zh TEXT,
			family TEXT,
			category_id INTEGER NOT NULL REFERENCES supply_categories(id),
			uom TEXT NOT NULL CHECK (uom IN ('each', 'roll', 'sheet', 'pack', 'box')),
			reorder_point REAL NOT NULL DEFAULT 0 CHECK (reorder_point >= 0),
			reorder_qty REAL NOT NULL DEFAULT 0 CHECK (reorder_qty >= 0),
			photo_file TEXT,
			notes TEXT,
			active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
			unit_cost REAL,
			currency TEXT NOT NULL DEFAULT 'USD',
			supplier_name TEXT,
			supplier_url TEXT,
			needs_purchase INTEGER NOT NULL DEFAULT 0 CHECK (needs_purchase IN (0, 1)),
			needs_purchase_at TEXT,
			needs_purchase_by TEXT,
			purchased_at TEXT,
			purchased_by TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE TABLE IF NOT EXISTS supply_balances (
			item_id INTEGER PRIMARY KEY REFERENCES supply_items(id) ON DELETE CASCADE,
			qty_on_hand REAL NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE TABLE IF NOT EXISTS supply_movements (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			item_id INTEGER NOT NULL REFERENCES supply_items(id),
			kind TEXT NOT NULL CHECK (kind IN ('receive', 'consume', 'count_adjust', 'manual_adjust')),
			qty_delta REAL NOT NULL,
			qty_before REAL NOT NULL,
			qty_after REAL NOT NULL,
			unit_cost REAL,
			cost_total REAL,
			currency TEXT,
			actor TEXT,
			note TEXT,
			ref_type TEXT,
			ref_id INTEGER,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE TABLE IF NOT EXISTS supply_count_sessions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			status TEXT NOT NULL CHECK (status IN ('open', 'submitted', 'cancelled')),
			started_by TEXT NOT NULL,
			submitted_by TEXT,
			notes TEXT,
			started_at TEXT NOT NULL DEFAULT (datetime('now')),
			submitted_at TEXT,
			cancelled_at TEXT
		);

		CREATE TABLE IF NOT EXISTS supply_count_lines (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id INTEGER NOT NULL REFERENCES supply_count_sessions(id) ON DELETE CASCADE,
			item_id INTEGER NOT NULL REFERENCES supply_items(id),
			expected_qty REAL NOT NULL,
			counted_qty REAL,
			variance REAL,
			counted_at TEXT,
			UNIQUE (session_id, item_id)
		);

		CREATE INDEX IF NOT EXISTS idx_supply_items_category ON supply_items(category_id);
		CREATE INDEX IF NOT EXISTS idx_supply_items_active ON supply_items(active);
		CREATE INDEX IF NOT EXISTS idx_supply_movements_item ON supply_movements(item_id, created_at DESC);
		CREATE INDEX IF NOT EXISTS idx_supply_movements_created ON supply_movements(created_at DESC);
		CREATE INDEX IF NOT EXISTS idx_supply_sessions_status ON supply_count_sessions(status);
		CREATE INDEX IF NOT EXISTS idx_supply_count_lines_session ON supply_count_lines(session_id);
	`)
	ensureItemColumns(db)
	ensureMovementColumns(db)
	backfillLocalizedCatalog(db)
	backfillItemSortOrder(db)
	backfillItemFamilies(db)
}

function ensureItemColumns(db) {
	ensureTableColumns(db, 'supply_items', ITEM_COLUMN_MIGRATIONS)
}

function ensureMovementColumns(db) {
	ensureTableColumns(db, 'supply_movements', MOVEMENT_COLUMN_MIGRATIONS)
}

function ensureTableColumns(db, table, migrations) {
	const cols = new Set(db.pragma(`table_info(${table})`).map((c) => c.name))
	for (const [name, decl] of migrations) {
		if (!cols.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`)
	}
}

function backfillLocalizedCatalog(db) {
	const cols = new Set(db.pragma('table_info(supply_items)').map((c) => c.name))
	if (!cols.has('name_zh')) return
	let catalogSeed
	try {
		catalogSeed = require('./catalog-seed')
	} catch {
		return
	}
	const bySku = new Map(catalogSeed.map((row) => [row.sku, row]))
	const update = db.prepare(`
		UPDATE supply_items
		SET name_zh = ?
		WHERE id = ? AND (name_zh IS NULL OR TRIM(name_zh) = '')
	`)
	const rows = db.prepare('SELECT id, sku FROM supply_items').all()
	const tx = db.transaction(() => {
		for (const row of rows) {
			const zh = bySku.get(row.sku)?.name_zh
			if (zh) update.run(zh, row.id)
		}
	})
	tx()
}

function familyListFor(categorySlug) {
	return ITEM_FAMILIES[categorySlug] || null
}

function inferFamilyFromText(text, categorySlug) {
	const list = familyListFor(categorySlug)
	if (!list) return null
	const s = String(text || '')
	for (const [slug, re] of FAMILY_INFER_RULES) {
		if (re.test(s) && list.some((f) => f.slug === slug)) return slug
	}
	return list.some((f) => f.slug === 'other') ? 'other' : list[0].slug
}

function resolveItemFamily({ categorySlug, family, name, nameZh, currentFamily } = {}) {
	const list = familyListFor(categorySlug)
	if (!list) return null
	if (family !== undefined && family !== null) {
		const slug = String(family).trim()
		if (!slug) return list.some((f) => f.slug === 'other') ? 'other' : list[0].slug
		return list.some((f) => f.slug === slug) ? slug : 'other'
	}
	if (currentFamily && list.some((f) => f.slug === currentFamily)) return currentFamily
	return inferFamilyFromText(`${name || ''} ${nameZh || ''}`, categorySlug)
}

function backfillItemFamilies(db) {
	const cols = new Set(db.pragma('table_info(supply_items)').map((c) => c.name))
	if (!cols.has('family')) return
	let catalogSeed
	try {
		catalogSeed = require('./catalog-seed')
	} catch {
		return
	}
	const bySku = new Map(catalogSeed.map((row) => [row.sku, row]))
	const rows = db.prepare(`
		SELECT i.id, i.sku, i.name, i.name_zh, i.family, c.slug AS category_slug
		FROM supply_items i
		JOIN supply_categories c ON c.id = i.category_id
		WHERE i.family IS NULL OR TRIM(i.family) = ''
	`).all()
	if (!rows.length) return
	const update = db.prepare('UPDATE supply_items SET family = ? WHERE id = ?')
	const tx = db.transaction(() => {
		for (const row of rows) {
			const seeded = bySku.get(row.sku)
			const next = resolveItemFamily({
				categorySlug: row.category_slug,
				family: seeded && seeded.family != null ? seeded.family : undefined,
				name: row.name,
				nameZh: row.name_zh,
			})
			if (next) update.run(next, row.id)
		}
	})
	tx()
}

function backfillItemSortOrder(db) {
	const cols = new Set(db.pragma('table_info(supply_items)').map((c) => c.name))
	if (!cols.has('sort_order')) return
	const cats = db.prepare('SELECT id FROM supply_categories').all()
	const list = db.prepare(`
		SELECT id, sort_order FROM supply_items
		WHERE category_id = ?
		ORDER BY sort_order ASC, name ASC, id ASC
	`)
	const update = db.prepare('UPDATE supply_items SET sort_order = ? WHERE id = ?')
	const tx = db.transaction(() => {
		for (const cat of cats) {
			const rows = list.all(cat.id)
			if (!rows.length) continue
			if (rows.every((r) => Number(r.sort_order) > 0)) continue
			rows.forEach((row, i) => update.run((i + 1) * 10, row.id))
		}
	})
	tx()
}

function nextSortOrder(db, categoryId, family) {
	const row =
		family == null || family === ''
			? db.prepare(`
				SELECT MAX(sort_order) AS m FROM supply_items
				WHERE category_id = ? AND IFNULL(family, '') = ''
			`).get(categoryId)
			: db.prepare(`
				SELECT MAX(sort_order) AS m FROM supply_items
				WHERE category_id = ? AND family = ?
			`).get(categoryId, family)
	return (Number(row && row.m) || 0) + 10
}

function reindexCategory(db, categoryId, orderedIds) {
	const update = db.prepare('UPDATE supply_items SET sort_order = ?, updated_at = datetime(\'now\') WHERE id = ?')
	orderedIds.forEach((id, i) => update.run((i + 1) * 10, id))
}

function placeItem(db, { itemId, categoryId, beforeId = null, family } = {}) {
	const item = db.prepare('SELECT id, category_id, family FROM supply_items WHERE id = ?').get(itemId)
	if (!item) throw httpError(404, 'Item not found')
	const dest = Number(categoryId)
	if (!Number.isFinite(dest) || dest <= 0) throw httpError(400, 'Invalid category')
	const destCat = db.prepare('SELECT id, slug FROM supply_categories WHERE id = ?').get(dest)
	if (!destCat) throw httpError(400, 'Invalid category')
	const before = beforeId == null || beforeId === '' ? null : Number(beforeId)
	if (before != null && (!Number.isFinite(before) || before <= 0)) {
		throw httpError(400, 'Invalid before_id')
	}

	const nextFamily = resolveItemFamily({
		categorySlug: destCat.slug,
		family,
		currentFamily: item.family,
	})
	if (before === item.id && dest === item.category_id && (nextFamily || null) === (item.family || null)) {
		return getItem(db, item.id)
	}

	db.transaction(() => {
		db.prepare(`
			UPDATE supply_items
			SET category_id = ?, family = ?, updated_at = datetime('now')
			WHERE id = ?
		`).run(dest, nextFamily, item.id)

		const siblings =
			nextFamily == null
				? db.prepare(`
					SELECT id FROM supply_items
					WHERE category_id = ? AND id != ? AND IFNULL(family, '') = ''
					ORDER BY sort_order ASC, id ASC
				`).all(dest, item.id)
				: db.prepare(`
					SELECT id FROM supply_items
					WHERE category_id = ? AND id != ? AND family = ?
					ORDER BY sort_order ASC, id ASC
				`).all(dest, item.id, nextFamily)
		const ids = siblings.map((row) => row.id)
		const idx = before ? ids.indexOf(before) : -1
		if (idx < 0) ids.push(item.id)
		else ids.splice(idx, 0, item.id)
		reindexCategory(db, dest, ids)
	})()

	return getItem(db, item.id)
}

function allocateSku(db, name) {
	const ascii = String(name || '')
		.normalize('NFKD')
		.replace(/[^\x00-\x7F]/g, '')
		.replace(/[^A-Za-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.toUpperCase()
		.slice(0, 40)
	const base = fromSkuBase(ascii)
	const exists = db.prepare('SELECT 1 FROM supply_items WHERE sku = ?')
	let sku = base
	let n = 2
	while (exists.get(sku)) {
		sku = `${base.slice(0, 50)}-${n}`
		n += 1
	}
	return sku
}

function fromSkuBase(ascii) {
	if (ascii && ascii.length >= 2) return ascii
	const stamp = Date.now().toString(36).toUpperCase()
	return `SUP-${stamp}`
}

function assertNameAvailable(db, { name, nameZh, excludeId = 0 }) {
	const candidates = [...new Set([name, nameZh].map((v) => String(v || '').trim()).filter(Boolean))]
	if (!candidates.length) return
	const row = db.prepare(`
		SELECT id FROM supply_items
		WHERE active = 1
			AND id != ?
			AND (
				name IN (${candidates.map(() => '?').join(', ')})
				OR IFNULL(name_zh, '') IN (${candidates.map(() => '?').join(', ')})
			)
		LIMIT 1
	`).get(excludeId, ...candidates, ...candidates)
	if (row) {
		throw httpError(409, 'A supply with this name already exists')
	}
}

function resolvePhotosDir(dbPath) {
	return path.join(path.dirname(path.resolve(dbPath)), 'supplies-photos')
}

function resolveSeedDir() {
	return path.resolve(__dirname, '../../assets/supplies-seed')
}

function projectRoot() {
	return path.resolve(__dirname, '../..')
}

function mimeForPhoto(file) {
	const ext = path.extname(String(file || '')).toLowerCase()
	if (ext === '.png') return 'image/png'
	if (ext === '.webp') return 'image/webp'
	if (ext === '.gif') return 'image/gif'
	return 'image/jpeg'
}

function escapeLikePattern(raw) {
	return String(raw).replace(/\\/g, '\\\\').replace(/[%_]/g, '\\$&')
}

function looksLikeRasterImage(buf) {
	if (!Buffer.isBuffer(buf) || buf.length < 12) return false
	if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true
	if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true
	if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return true
	return false
}

function unlinkOrphanPhoto(db, photosDir, filename) {
	if (!filename) return false
	const base = path.basename(String(filename))
	if (base !== filename || /[\\/]/.test(filename)) return false
	if (!/^[A-Za-z0-9._-]+$/.test(base)) return false
	const used = db.prepare('SELECT 1 FROM supply_items WHERE photo_file = ? LIMIT 1').get(base)
	if (used) return false
	try {
		fs.unlinkSync(path.join(photosDir, base))
		return true
	} catch {
		return false
	}
}

function photoUrlFor(photoFile, width) {
	if (!photoFile) return null
	const base = `/api/supplies/photos/${encodeURIComponent(photoFile)}`
	const n = Number(width)
	if (Number.isFinite(n) && n > 0) return `${base}?w=${Math.floor(n)}`
	return base
}

function decorateItem(item) {
	if (!item) return null
	const families = familyListFor(item.category_slug) || []
	let family = item.family || null
	if (families.length) {
		family = families.some((f) => f.slug === family) ? family : 'other'
	} else {
		family = null
	}
	const fam = families.find((f) => f.slug === family)
	return {
		...item,
		family,
		family_name: fam ? fam.name : null,
		is_low: Number(item.is_low) ? 1 : 0,
		needs_purchase: Number(item.needs_purchase) ? 1 : 0,
		purchased_at: item.purchased_at || null,
		purchased_by: item.purchased_by || null,
		photo_path: photoUrlFor(item.photo_file),
		photo_thumb: photoUrlFor(item.photo_file, CARD_THUMB_WIDTH),
		photo_detail: photoUrlFor(item.photo_file, DETAIL_THUMB_WIDTH),
	}
}

function ensureBalanceRow(db, itemId) {
	db.prepare(`
		INSERT OR IGNORE INTO supply_balances (item_id, qty_on_hand)
		VALUES (?, 0)
	`).run(itemId)
}

function applyMovement(db, {
	itemId,
	kind,
	qtyDelta,
	actor = null,
	note = null,
	refType = null,
	refId = null,
	unitCost = null,
	costTotal = null,
	currency = null,
}) {
	return db.transaction(() => {
		const bal = db.prepare('SELECT qty_on_hand FROM supply_balances WHERE item_id = ?').get(itemId)
		if (!bal) {
			const err = new Error('Unknown item balance')
			err.status = 404
			throw err
		}

		const qtyBefore = Number(bal.qty_on_hand)
		const delta = Number(qtyDelta)
		if (!Number.isFinite(delta) || delta === 0) {
			const err = new Error('qty_delta must be a non-zero number')
			err.status = 400
			throw err
		}

		const qtyAfter = Math.round((qtyBefore + delta) * 1000) / 1000
		if (qtyAfter < 0) {
			const err = new Error('Stock cannot go negative')
			err.status = 400
			throw err
		}

		db.prepare(`
			UPDATE supply_balances
			SET qty_on_hand = ?, updated_at = datetime('now')
			WHERE item_id = ?
		`).run(qtyAfter, itemId)

		const info = db.prepare(`
			INSERT INTO supply_movements
				(item_id, kind, qty_delta, qty_before, qty_after, unit_cost, cost_total, currency, actor, note, ref_type, ref_id)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			itemId,
			kind,
			delta,
			qtyBefore,
			qtyAfter,
			unitCost,
			costTotal,
			currency,
			actor,
			note,
			refType,
			refId,
		)

		return {
			movementId: Number(info.lastInsertRowid),
			itemId,
			kind,
			qtyDelta: delta,
			qtyBefore,
			qtyAfter,
			unit_cost: unitCost,
			cost_total: costTotal,
			currency,
		}
	})()
}

const ITEM_SELECT = `
	i.id, i.sku, i.name, i.name_zh, i.family, i.uom, i.reorder_point, i.reorder_qty,
	i.photo_file, i.notes, i.active, i.updated_at, i.created_at,
	i.unit_cost, i.currency, i.supplier_name, i.supplier_url, i.sort_order,
	i.needs_purchase, i.needs_purchase_at, i.needs_purchase_by,
	i.purchased_at, i.purchased_by,
	c.id AS category_id, c.slug AS category_slug, c.name AS category_name,
	b.qty_on_hand,
	CASE WHEN b.qty_on_hand <= i.reorder_point THEN 1 ELSE 0 END AS is_low
`

function getItem(db, idOrSku) {
	return db.prepare(`
		SELECT ${ITEM_SELECT}
		FROM supply_items i
		JOIN supply_categories c ON c.id = i.category_id
		JOIN supply_balances b ON b.item_id = i.id
		WHERE i.id = ? OR i.sku = ?
	`).get(idOrSku, idOrSku) || null
}

function wantsPurge(query) {
	const raw = query && query.purge
	return raw === '1' || raw === 'true' || raw === true || raw === 1
}

function detachItemFromOpenCounts(db, itemId) {
	const id = Number(itemId)
	if (!Number.isFinite(id) || id <= 0) return
	db.prepare(`
		DELETE FROM supply_count_lines
		WHERE item_id = ?
			AND session_id IN (SELECT id FROM supply_count_sessions WHERE status = 'open')
	`).run(id)
}

function retireSupplyItem(db, itemId) {
	const id = Number(itemId)
	if (!Number.isFinite(id) || id <= 0) throw httpError(404, 'Item not found')
	db.transaction(() => {
		db.prepare(`
			UPDATE supply_items
			SET active = 0, updated_at = datetime('now')
			WHERE id = ?
		`).run(id)
		detachItemFromOpenCounts(db, id)
	})()
	const item = getItem(db, id)
	if (!item) throw httpError(404, 'Item not found')
	return item
}

function purgeSupplyItem(db, photosDir, item) {
	if (!item || item.id == null) throw httpError(404, 'Item not found')
	if (item.active) throw httpError(409, 'Retire this supply before deleting it permanently')
	const photoFile = item.photo_file
	db.transaction(() => {
		db.prepare('DELETE FROM supply_count_lines WHERE item_id = ?').run(item.id)
		db.prepare('DELETE FROM supply_movements WHERE item_id = ?').run(item.id)
		db.prepare('DELETE FROM supply_items WHERE id = ?').run(item.id)
	})()
	unlinkOrphanPhoto(db, photosDir, photoFile)
}

function listLowStock(db) {
	return db.prepare(`
		SELECT ${ITEM_SELECT},
			(i.reorder_point - b.qty_on_hand) AS deficit
		FROM supply_items i
		JOIN supply_categories c ON c.id = i.category_id
		JOIN supply_balances b ON b.item_id = i.id
		WHERE i.active = 1 AND b.qty_on_hand <= i.reorder_point
		ORDER BY deficit DESC, i.name ASC
	`).all()
}

function listNeedsPurchase(db) {
	return db.prepare(`
		SELECT ${ITEM_SELECT}
		FROM supply_items i
		JOIN supply_categories c ON c.id = i.category_id
		JOIN supply_balances b ON b.item_id = i.id
		WHERE i.active = 1 AND i.needs_purchase = 1
		ORDER BY i.needs_purchase_at DESC, i.name ASC
	`).all()
}

function clearNeedsPurchase(db, itemId) {
	db.prepare(`
		UPDATE supply_items
		SET needs_purchase = 0,
			needs_purchase_at = NULL,
			needs_purchase_by = NULL,
			updated_at = datetime('now')
		WHERE id = ? AND needs_purchase != 0
	`).run(itemId)
}

function markPurchased(db, idOrSku, actor) {
	const item = getItem(db, idOrSku)
	if (!item || !item.active) throw httpError(404, 'Item not found or inactive')
	if (Number(item.needs_purchase)) {
		db.prepare(`
			UPDATE supply_items
			SET needs_purchase = 0,
				needs_purchase_at = NULL,
				needs_purchase_by = NULL,
				purchased_at = datetime('now'),
				purchased_by = ?,
				updated_at = datetime('now')
			WHERE id = ?
		`).run(actor || null, item.id)
	}
	const updated = decorateItem(getItem(db, item.id))
	if (!updated) throw httpError(404, 'Item not found or inactive')
	return updated
}

function setNeedsPurchase(db, idOrSku, needed, actor) {
	const item = getItem(db, idOrSku)
	if (!item || !item.active) throw httpError(404, 'Item not found or inactive')
	if (needed) {
		db.prepare(`
			UPDATE supply_items
			SET needs_purchase = 1,
				needs_purchase_at = datetime('now'),
				needs_purchase_by = ?,
				updated_at = datetime('now')
			WHERE id = ?
		`).run(actor || null, item.id)
	} else {
		clearNeedsPurchase(db, item.id)
	}
	const updated = decorateItem(getItem(db, item.id))
	if (!updated) throw httpError(404, 'Item not found or inactive')
	return updated
}

function httpError(status, message) {
	const err = new Error(message)
	err.status = status
	return err
}

function normalizeItemName(raw, { required = false } = {}) {
	const name = String(raw ?? '').replace(/\s+/g, ' ').trim()
	if (!name) {
		if (required) throw httpError(400, 'Name is required')
		return null
	}
	if (name.length > ITEM_NAME_MAX) throw httpError(400, 'Name is too long')
	return name
}

function normalizeSupplierUrl(raw) {
	if (raw == null || raw === '') return null
	const text = String(raw).trim()
	if (!text) return null
	let parsed
	try {
		parsed = new URL(text)
	} catch {
		throw httpError(400, 'Supplier link must be a valid http(s) URL')
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw httpError(400, 'Supplier link must be http or https')
	}
	if (parsed.username || parsed.password) {
		throw httpError(400, 'Supplier link cannot include credentials')
	}
	return parsed.toString()
}

function normalizeCurrency(raw, { required = false } = {}) {
	if (raw == null || raw === '') {
		if (required) throw httpError(400, 'Currency is required')
		return undefined
	}
	const code = String(raw).trim().toUpperCase()
	if (!CURRENCIES.has(code)) throw httpError(400, 'Unsupported currency')
	return code
}

function normalizeMoney(raw, field) {
	if (raw == null || raw === '') return null
	const n = Number(raw)
	if (!Number.isFinite(n) || n < 0) throw httpError(400, `Invalid ${field}`)
	return Math.round(n * 100) / 100
}

function roundMoney(n) {
	return Math.round(Number(n) * 100) / 100
}

function resolveReceiveCost(item, body, qty) {
	const hasTotal = body && body.cost_total !== undefined && body.cost_total !== null && body.cost_total !== ''
	const hasUnit = body && body.unit_cost !== undefined && body.unit_cost !== null && body.unit_cost !== ''
	const explicit = Boolean(hasTotal || hasUnit)
	const currency = explicit && body && body.currency !== undefined && body.currency !== null && body.currency !== ''
		? normalizeCurrency(body.currency)
		: (item.currency || 'USD')
	let unitCost = null
	let costTotal = null
	if (hasTotal) {
		costTotal = normalizeMoney(body.cost_total, 'cost_total')
		unitCost = qty > 0 && costTotal != null ? Math.round((costTotal / qty) * 10000) / 10000 : null
	} else if (hasUnit) {
		unitCost = normalizeMoney(body.unit_cost, 'unit_cost')
		costTotal = unitCost == null ? null : roundMoney(unitCost * qty)
	} else if (item && item.unit_cost != null && Number.isFinite(Number(item.unit_cost))) {
		unitCost = Number(item.unit_cost)
		costTotal = roundMoney(unitCost * qty)
	}
	return { unitCost, costTotal, currency: currency || item.currency || 'USD', explicit }
}

function summarizeSpend(db, { fromUtc, toUtc }) {
	const lines = db.prepare(`
		SELECT
			m.id, m.item_id, m.qty_delta AS qty, m.unit_cost, m.cost_total, m.currency,
			m.created_at, m.actor, m.note,
			i.sku, i.name AS item_name, i.name_zh AS item_name_zh, i.uom,
			i.supplier_name, i.supplier_url
		FROM supply_movements m
		JOIN supply_items i ON i.id = m.item_id
		WHERE m.kind = 'receive'
			AND m.cost_total IS NOT NULL
			AND m.created_at >= ?
			AND m.created_at < ?
		ORDER BY m.created_at DESC, m.id DESC
	`).all(fromUtc, toUtc)

	const byCur = new Map()
	for (const line of lines) {
		const code = line.currency || 'USD'
		const row = byCur.get(code) || { currency: code, amount: 0, qty: 0, receives: 0 }
		row.amount = roundMoney(row.amount + Number(line.cost_total))
		row.qty = Math.round((row.qty + Number(line.qty)) * 1000) / 1000
		row.receives += 1
		byCur.set(code, row)
	}

	return {
		from: fromUtc,
		to: toUtc,
		totals: [...byCur.values()],
		lines,
		receive_count: lines.length,
	}
}

async function persistPhotoData(photosDir, sku, photoData) {
	if (!photoData || typeof photoData !== 'string') return null
	const match = /^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/i.exec(photoData.trim())
	if (!match) throw httpError(400, 'photo_data must be a base64 data URL (jpeg/png/webp)')
	const buf = Buffer.from(match[2], 'base64')
	if (!buf.length) throw httpError(400, 'Photo is empty')
	if (buf.length > MAX_UPLOAD_BYTES) throw httpError(400, 'Photo is too large (max 8 MB)')

	fs.mkdirSync(photosDir, { recursive: true })
	const stem = `${String(sku).replace(/[^A-Za-z0-9_-]/g, '_')}-${Date.now()}`
	const sharp = trySharp()
	if (sharp) {
		try {
			const out = await sharp(buf, { failOn: 'none' })
				.rotate()
				.resize({
					width: STORED_PHOTO_MAX,
					height: STORED_PHOTO_MAX,
					fit: 'inside',
					withoutEnlargement: true,
				})
				.webp({ quality: 80, effort: 4 })
				.toBuffer()
			if (out && out.length) {
				const file = `${stem}.webp`
				fs.writeFileSync(path.join(photosDir, file), out)
				return file
			}
		} catch {
			// Fall through to the original bytes when sharp cannot transcode.
		}
	}

	if (!looksLikeRasterImage(buf)) {
		throw httpError(400, 'photo_data must be a base64 data URL (jpeg/png/webp)')
	}
	const ext = match[1].toLowerCase() === 'jpg' ? 'jpg' : match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase()
	const file = `${stem}.${ext}`
	fs.writeFileSync(path.join(photosDir, file), buf)
	return file
}

function transcodeSeedPhotosSync(jobs) {
	if (!jobs.length) return { ok: true, usedSharp: false }
	if (!trySharp()) return { ok: false, usedSharp: false }

	const manifest = path.join(os.tmpdir(), `ued-supply-seed-${process.pid}-${Date.now()}.json`)
	fs.writeFileSync(manifest, JSON.stringify(jobs))
	const code = `
		'use strict';
		const fs = require('fs');
		const sharp = require('sharp');
		const jobs = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
		const max = ${STORED_PHOTO_MAX};
		(async () => {
			for (const job of jobs) {
				await sharp(job.src, { failOn: 'none' })
					.rotate()
					.resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true })
					.webp({ quality: 78, effort: 4 })
					.toFile(job.dest);
			}
		})().catch((err) => {
			console.error(err && err.stack ? err.stack : err);
			process.exit(1);
		});
	`
	try {
		execFileSync(process.execPath, ['-e', code, '--', manifest], {
			cwd: projectRoot(),
			windowsHide: true,
			timeout: 180000,
			stdio: ['ignore', 'pipe', 'pipe'],
			encoding: 'utf8',
		})
		return { ok: true, usedSharp: true }
	} catch (err) {
		const detail = String((err && err.stderr) || (err && err.message) || err).slice(0, 400)
		console.warn('[supplies] seed photo transcode failed, copying originals:', detail)
		return { ok: false, usedSharp: true, error: detail }
	} finally {
		try { fs.unlinkSync(manifest) } catch { /* tmp cleanup */ }
	}
}

function importSeedPhotos(photosDir, seedDir, rows) {
	fs.mkdirSync(photosDir, { recursive: true })
	const jobs = []
	const assigned = new Map()

	for (const row of rows) {
		const seedPhoto = path.join(seedDir, `${row.sku}.jpg`)
		if (!fs.existsSync(seedPhoto)) continue
		const webpName = `${row.sku}.webp`
		const jpgName = `${row.sku}.jpg`
		jobs.push({ src: seedPhoto, dest: path.join(photosDir, webpName), jpgName, webpName, sku: row.sku })
	}

	const result = transcodeSeedPhotosSync(jobs.map((j) => ({ src: j.src, dest: j.dest })))
	for (const job of jobs) {
		if (result.ok && fs.existsSync(job.dest) && fs.statSync(job.dest).size > 0) {
			assigned.set(job.sku, job.webpName)
			continue
		}
		const fallback = path.join(photosDir, job.jpgName)
		fs.copyFileSync(job.src, fallback)
		assigned.set(job.sku, job.jpgName)
	}
	return assigned
}

function isCatalogSeedPhoto(sku, photoFile) {
	if (!sku || !photoFile) return false
	const base = path.basename(String(photoFile))
	const stem = String(sku).replace(/[^A-Za-z0-9._-]/g, '_')
	return base === `${stem}.webp` || base === `${stem}.jpg` || base === `${stem}.jpeg` || base === `${stem}.png`
}

function reimportSeedPhotos(db, { photosDir, seedDir = resolveSeedDir(), onlySeedNamed = true } = {}) {
	migrateSuppliesSchema(db)
	fs.mkdirSync(photosDir, { recursive: true })
	const catalogSeed = require('./catalog-seed')
	const photosBySku = importSeedPhotos(photosDir, seedDir, catalogSeed)
	const rows = db.prepare('SELECT id, sku, photo_file FROM supply_items').all()
	const update = db.prepare(`
		UPDATE supply_items
		SET photo_file = ?, updated_at = datetime('now')
		WHERE id = ?
	`)
	let updated = 0
	let skippedCustom = 0
	for (const row of rows) {
		const next = photosBySku.get(row.sku)
		if (!next) continue
		if (onlySeedNamed && row.photo_file && !isCatalogSeedPhoto(row.sku, row.photo_file)) {
			skippedCustom += 1
			continue
		}
		const previous = row.photo_file
		if (previous !== next) {
			update.run(next, row.id)
			if (previous && previous !== next) unlinkOrphanPhoto(db, photosDir, previous)
		}
		updated += 1
	}
	return {
		updated,
		skippedCustom,
		photos: photosBySku.size,
	}
}

function seedIfEmpty(db, { photosDir, seedDir = resolveSeedDir() } = {}) {
	migrateSuppliesSchema(db)
	fs.mkdirSync(photosDir, { recursive: true })

	const itemCount = db.prepare('SELECT COUNT(*) AS n FROM supply_items').get().n
	if (itemCount > 0) return { seeded: false, items: itemCount }

	const catalogSeed = require('./catalog-seed')
	const photosBySku = importSeedPhotos(photosDir, seedDir, catalogSeed)

	db.transaction(() => {
		const insertCat = db.prepare(`
			INSERT INTO supply_categories (slug, name, sort_order)
			VALUES (@slug, @name, @sort_order)
		`)
		for (const cat of CATEGORIES) insertCat.run(cat)

		const catBySlug = Object.fromEntries(
			db.prepare('SELECT id, slug FROM supply_categories').all().map((r) => [r.slug, r.id]),
		)

		const insertItem = db.prepare(`
			INSERT INTO supply_items
				(sku, name, name_zh, family, category_id, uom, reorder_point, reorder_qty, photo_file, notes, active,
				 unit_cost, currency, supplier_name, supplier_url, sort_order)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'USD', ?, ?, ?)
		`)

		const nextOrder = Object.create(null)
		for (const row of catalogSeed) {
			const categoryId = catBySlug[row.category]
			if (!categoryId) continue
			const family = resolveItemFamily({
				categorySlug: row.category,
				family: row.family,
				name: row.name,
				nameZh: row.name_zh,
			})
			const orderKey = `${categoryId}:${family || ''}`
			nextOrder[orderKey] = (nextOrder[orderKey] || 0) + 10
			const info = insertItem.run(
				row.sku,
				row.name,
				row.name_zh || null,
				family,
				categoryId,
				row.uom,
				row.reorder_point,
				row.reorder_qty,
				photosBySku.get(row.sku) || null,
				row.notes || null,
				row.unit_cost != null ? Number(row.unit_cost) : null,
				row.supplier_name || null,
				row.supplier_url || null,
				nextOrder[orderKey],
			)
			ensureBalanceRow(db, info.lastInsertRowid)
		}
	})()

	return {
		seeded: true,
		items: db.prepare('SELECT COUNT(*) AS n FROM supply_items').get().n,
	}
}

function warmupThumbnails(photosDir) {
	let thumbs
	try {
		thumbs = require('../listings/thumbnails')
	} catch {
		return
	}
	if (!thumbs.isAvailable()) return
	let names
	try {
		names = fs.readdirSync(photosDir)
	} catch {
		return
	}
	setImmediate(async () => {
		for (const name of names) {
			const full = path.join(photosDir, name)
			try {
				await thumbs.getThumbnail(full, CARD_THUMB_WIDTH)
				await thumbs.getThumbnail(full, DETAIL_THUMB_WIDTH)
			} catch {
				// Warmup is best-effort; a bad file must not take down the tab.
			}
		}
	})
}

function daysSince(sqliteDate) {
	if (!sqliteDate) return null
	const then = Date.parse(String(sqliteDate).replace(' ', 'T') + 'Z')
	if (!Number.isFinite(then)) return null
	return Math.floor((Date.now() - then) / (24 * 60 * 60 * 1000))
}

module.exports = {
	CATEGORIES,
	ITEM_FAMILIES,
	UOMS,
	CURRENCIES,
	CARD_THUMB_WIDTH,
	DETAIL_THUMB_WIDTH,
	ITEM_NAME_MAX,
	ITEM_SELECT,
	migrateSuppliesSchema,
	ensureItemColumns,
	ensureMovementColumns,
	resolvePhotosDir,
	resolveSeedDir,
	ensureBalanceRow,
	applyMovement,
	resolveReceiveCost,
	summarizeSpend,
	seedIfEmpty,
	reimportSeedPhotos,
	isCatalogSeedPhoto,
	getItem,
	wantsPurge,
	detachItemFromOpenCounts,
	retireSupplyItem,
	purgeSupplyItem,
	listLowStock,
	listNeedsPurchase,
	clearNeedsPurchase,
	markPurchased,
	setNeedsPurchase,
	photoUrlFor,
	decorateItem,
	mimeForPhoto,
	escapeLikePattern,
	looksLikeRasterImage,
	unlinkOrphanPhoto,
	persistPhotoData,
	normalizeSupplierUrl,
	normalizeCurrency,
	normalizeMoney,
	warmupThumbnails,
	daysSince,
	httpError,
	normalizeItemName,
	allocateSku,
	assertNameAvailable,
	backfillLocalizedCatalog,
	backfillItemSortOrder,
	backfillItemFamilies,
	familyListFor,
	inferFamilyFromText,
	resolveItemFamily,
	nextSortOrder,
	placeItem,
}
