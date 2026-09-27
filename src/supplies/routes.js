'use strict'

const fs = require('fs')
const path = require('path')
const express = require('express')
const {
	CATEGORIES,
	ITEM_FAMILIES,
	UOMS,
	migrateSuppliesSchema,
	resolvePhotosDir,
	seedIfEmpty,
	ensureBalanceRow,
	applyMovement,
	getItem,
	wantsPurge,
	detachItemFromOpenCounts,
	retireSupplyItem,
	purgeSupplyItem,
	listLowStock,
	listNeedsPurchase,
	clearNeedsPurchase,
	setNeedsPurchase,
	markPurchased,
	decorateItem,
	mimeForPhoto,
	persistPhotoData,
	normalizeSupplierUrl,
	normalizeCurrency,
	normalizeMoney,
	resolveReceiveCost,
	summarizeSpend,
	warmupThumbnails,
	daysSince,
	ITEM_SELECT,
	allocateSku,
	assertNameAvailable,
	normalizeItemName,
	nextSortOrder,
	placeItem,
	resolveItemFamily,
	escapeLikePattern,
	unlinkOrphanPhoto,
} = require('./core')

let thumbnails = null
try {
	thumbnails = require('../listings/thumbnails')
} catch {
	thumbnails = null
}

const { applyStoredImageHeaders } = require('../route/stored-image-security')

/**
 * Mount shipping-supplies inventory routes on the UED Express app.
 * Uses the shared UED SQLite DB and existing session auth (req.auth).
 *
 * @param {import('express').Application} app
 * @param {{ db: import('better-sqlite3').Database, dbPath: string }} opts
 */
function installRoutes(app, { db, dbPath, warmup = true } = {}) {
	migrateSuppliesSchema(db)
	const photosDir = resolvePhotosDir(dbPath)
	const seed = seedIfEmpty(db, { photosDir })
	if (seed.seeded) {
		console.log(`[supplies] seeded ${seed.items} packaging SKUs`)
	}
	if (warmup) warmupThumbnails(photosDir)

	const router = express.Router()

	function actorOf(req) {
		return (req.auth && req.auth.user) || 'unknown'
	}

	function requireOwner(req, res, next) {
		if (!req.auth || req.auth.role !== 'owner') {
			return res.status(403).json({ error: 'Owner only' })
		}
		next()
	}

	function safePhotoName(name) {
		const base = path.basename(String(name || ''))
		if (!base || base !== name || /[\\/]/.test(name)) return null
		if (!/^[A-Za-z0-9._-]+$/.test(base)) return null
		return base
	}

	router.get('/photos/:file', async (req, res) => {
		const file = safePhotoName(req.params.file)
		if (!file) return res.status(400).json({ error: 'Invalid photo name' })
		const resolvedDir = path.resolve(photosDir)
		const full = path.resolve(photosDir, file)
		if (full !== resolvedDir && !full.startsWith(resolvedDir + path.sep)) {
			return res.status(400).json({ error: 'Invalid photo name' })
		}
		if (!fs.existsSync(full)) return res.status(404).json({ error: 'Photo not found' })

		const width = thumbnails ? thumbnails.normaliseWidth(req.query.w) : null
		if (width && thumbnails && thumbnails.isAvailable()) {
			try {
				const thumb = await thumbnails.getThumbnail(full, width)
				if (thumb) {
					if (!applyStoredImageHeaders(res, thumb.mime, 'private, max-age=31536000, immutable')) {
						return res.status(415).end()
					}
					res.setHeader('ETag', thumb.etag)
					if (req.headers['if-none-match'] === thumb.etag) return res.status(304).end()
					return fs
						.createReadStream(thumb.path)
						.on('error', () => {
							if (!res.headersSent) res.status(500).end()
						})
						.pipe(res)
				}
			} catch (err) {
				console.warn('[supplies] thumbnail failed, serving original:', err.message)
			}
		}

		if (!applyStoredImageHeaders(res, mimeForPhoto(file), 'private, max-age=86400')) {
			return res.status(415).end()
		}
		res.sendFile(full)
	})

	router.get('/categories', (_req, res) => {
		const rows = db.prepare(`
			SELECT c.*,
				(SELECT COUNT(*) FROM supply_items i WHERE i.category_id = c.id AND i.active = 1) AS item_count
			FROM supply_categories c
			ORDER BY c.sort_order ASC, c.name ASC
		`).all()
		res.json({ categories: rows.length ? rows : CATEGORIES, families: ITEM_FAMILIES })
	})

	router.get('/items', (req, res) => {
		const { category, family, q, active } = req.query
		const where = []
		const params = {}

		if (category) {
			where.push('c.slug = @category')
			params.category = String(category)
		}
		if (family) {
			where.push('i.family = @family')
			params.family = String(family)
		}
		if (active === '1' || active === '0') {
			where.push('i.active = @active')
			params.active = Number(active)
		} else if (active !== 'all') {
			where.push('i.active = 1')
		}
		if (q && String(q).trim()) {
			where.push("(i.name LIKE @q ESCAPE '\\' OR IFNULL(i.name_zh, '') LIKE @q ESCAPE '\\' OR i.sku LIKE @q ESCAPE '\\' OR IFNULL(i.notes, '') LIKE @q ESCAPE '\\' OR IFNULL(i.supplier_name, '') LIKE @q ESCAPE '\\' OR IFNULL(i.family, '') LIKE @q ESCAPE '\\')")
			params.q = `%${escapeLikePattern(String(q).trim())}%`
		}

		const rows = db.prepare(`
			SELECT ${ITEM_SELECT}
			FROM supply_items i
			JOIN supply_categories c ON c.id = i.category_id
			JOIN supply_balances b ON b.item_id = i.id
			${where.length ? `WHERE ${where.join(' AND ')}` : ''}
			ORDER BY
				c.sort_order ASC,
				i.sort_order ASC,
				i.id ASC
		`).all(params)

		res.json({ items: rows.map(decorateItem) })
	})

	router.get('/items/:id', (req, res) => {
		const item = decorateItem(getItem(db, req.params.id))
		if (!item) return res.status(404).json({ error: 'Item not found' })
		res.json({ item })
	})

	router.post('/items/:id/needs-purchase', (req, res) => {
		try {
			const needed = parseBoolFlag(req.body && req.body.needed, 'needed')
			const item = setNeedsPurchase(db, req.params.id, needed, actorOf(req))
			res.json({ item })
		} catch (err) {
			res.status(err.status || 500).json({ error: err.message })
		}
	})

	router.post('/items/:id/purchased', requireOwner, (req, res) => {
		try {
			const purchased = parseBoolFlag(req.body && req.body.purchased, 'purchased')
			if (!purchased) {
				return res.status(400).json({ error: 'purchased must be true' })
			}
			const item = markPurchased(db, req.params.id, actorOf(req))
			res.json({ item })
		} catch (err) {
			res.status(err.status || 500).json({ error: err.message })
		}
	})

	router.post('/items', async (req, res) => {
		try {
			const body = normalizeItemBody(req.body)
			if (!body.sku) body.sku = allocateSku(db, body.name_zh || body.name)
			if (db.prepare('SELECT id FROM supply_items WHERE sku = ?').get(body.sku)) {
				return res.status(409).json({ error: 'SKU already exists' })
			}
			assertNameAvailable(db, { name: body.name, nameZh: body.name_zh })
			const cat = resolveCategory(db, body)
			if (!cat) return res.status(400).json({ error: 'Invalid category' })
			const family = resolveItemFamily({
				categorySlug: cat.slug,
				family: body.family,
				name: body.name,
				nameZh: body.name_zh,
			})

			const photoFile = await persistPhotoData(photosDir, body.sku, req.body.photo_data)

			let id
			try {
				id = db.transaction(() => {
					const info = db.prepare(`
						INSERT INTO supply_items
							(sku, name, name_zh, family, category_id, uom, reorder_point, reorder_qty, photo_file, notes, active,
							 unit_cost, currency, supplier_name, supplier_url, sort_order)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
					`).run(
						body.sku,
						body.name,
						body.name_zh ?? null,
						family,
						cat.id,
						body.uom,
						body.reorder_point,
						body.reorder_qty,
						photoFile,
						body.notes ?? null,
						body.unit_cost ?? null,
						body.currency || 'USD',
						body.supplier_name ?? null,
						body.supplier_url ?? null,
						nextSortOrder(db, cat.id, family),
					)
					const itemId = Number(info.lastInsertRowid)
					ensureBalanceRow(db, itemId)
					attachItemToOpenCount(db, itemId)
					return itemId
				})()
			} catch (err) {
				if (photoFile) unlinkOrphanPhoto(db, photosDir, photoFile)
				throw err
			}

			res.status(201).json({ item: decorateItem(getItem(db, id)) })
		} catch (err) {
			res.status(err.status || 400).json({ error: err.message || 'Create failed' })
		}
	})

	router.patch('/items/:id', async (req, res) => {
		try {
			const current = getItem(db, req.params.id)
			if (!current) return res.status(404).json({ error: 'Item not found' })
			const body = normalizeItemBody(req.body, { partial: true })

			let categoryId = current.category_id
			if (body.category_id || body.category_slug) {
				const cat = resolveCategory(db, body)
				if (!cat) return res.status(400).json({ error: 'Invalid category' })
				categoryId = cat.id
			}

			const nextSku = body.sku ?? current.sku
			if (nextSku !== current.sku) {
				const clash = db.prepare('SELECT id FROM supply_items WHERE sku = ? AND id != ?').get(nextSku, current.id)
				if (clash) return res.status(409).json({ error: 'SKU already exists' })
			}

			const nextName = body.name ?? current.name
			const nextNameZh = body.name_zh !== undefined ? body.name_zh : current.name_zh
			assertNameAvailable(db, { name: nextName, nameZh: nextNameZh, excludeId: current.id })

			const destCat = db.prepare('SELECT slug FROM supply_categories WHERE id = ?').get(categoryId)
			const family = resolveItemFamily({
				categorySlug: destCat && destCat.slug,
				family: Object.prototype.hasOwnProperty.call(body, 'family') ? body.family : undefined,
				name: nextName,
				nameZh: nextNameZh,
				currentFamily: current.family,
			})

			let photoFile = current.photo_file
			if (req.body.photo_data) {
				photoFile = (await persistPhotoData(photosDir, nextSku, req.body.photo_data)) || photoFile
			}

			let sortOrder = current.sort_order
			if (categoryId !== current.category_id || family !== current.family) {
				sortOrder = nextSortOrder(db, categoryId, family)
			}

			try {
				db.transaction(() => {
					db.prepare(`
						UPDATE supply_items SET
							sku = ?, name = ?, name_zh = ?, family = ?, category_id = ?, uom = ?,
							reorder_point = ?, reorder_qty = ?, photo_file = ?, notes = ?,
							active = ?, unit_cost = ?, currency = ?, supplier_name = ?, supplier_url = ?,
							sort_order = ?, updated_at = datetime('now')
						WHERE id = ?
					`).run(
						nextSku,
						nextName,
						nextNameZh ?? null,
						family,
						categoryId,
						body.uom ?? current.uom,
						body.reorder_point ?? current.reorder_point,
						body.reorder_qty ?? current.reorder_qty,
						photoFile,
						body.notes !== undefined ? body.notes : current.notes,
						body.active !== undefined ? body.active : current.active,
						body.unit_cost !== undefined ? body.unit_cost : current.unit_cost,
						body.currency ?? current.currency ?? 'USD',
						body.supplier_name !== undefined ? body.supplier_name : current.supplier_name,
						body.supplier_url !== undefined ? body.supplier_url : current.supplier_url,
						sortOrder,
						current.id,
					)
					const nextActive = body.active !== undefined ? body.active : current.active
					if (nextActive) attachItemToOpenCount(db, current.id)
					else detachItemFromOpenCounts(db, current.id)
				})()
			} catch (err) {
				if (photoFile && photoFile !== current.photo_file) {
					unlinkOrphanPhoto(db, photosDir, photoFile)
				}
				throw err
			}
			if (photoFile && photoFile !== current.photo_file) {
				unlinkOrphanPhoto(db, photosDir, current.photo_file)
			}

			res.json({ item: decorateItem(getItem(db, current.id)) })
		} catch (err) {
			res.status(err.status || 400).json({ error: err.message || 'Update failed' })
		}
	})

	router.post('/items/reorder', (req, res) => {
		try {
			const itemId = Number(req.body.item_id)
			if (!Number.isFinite(itemId) || itemId <= 0) {
				return res.status(400).json({ error: 'item_id is required' })
			}
			const current = getItem(db, itemId)
			if (!current) return res.status(404).json({ error: 'Item not found' })
			const cat = req.body.category_slug || req.body.category_id
				? resolveCategory(db, req.body)
				: resolveCategory(db, { category_id: current.category_id })
			if (!cat) return res.status(400).json({ error: 'Invalid category' })
			const beforeId = req.body.before_id == null || req.body.before_id === '' ? null : Number(req.body.before_id)
			const family = Object.prototype.hasOwnProperty.call(req.body, 'family') ? req.body.family : undefined
			const item = decorateItem(placeItem(db, { itemId, categoryId: cat.id, beforeId, family }))
			res.json({ item })
		} catch (err) {
			res.status(err.status || 400).json({ error: err.message || 'Reorder failed' })
		}
	})

	router.delete('/items/:id', (req, res) => {
		const current = getItem(db, req.params.id)
		if (!current) return res.status(404).json({ error: 'Item not found' })
		try {
			if (wantsPurge(req.query)) {
				purgeSupplyItem(db, photosDir, current)
				return res.json({ deleted: true, archived: false, item: null })
			}
			if (!current.active) {
				return res.json({ item: decorateItem(current), archived: true, deleted: false })
			}
			const item = decorateItem(retireSupplyItem(db, current.id))
			res.json({ item, archived: true, deleted: false })
		} catch (err) {
			res.status(err.status || 400).json({ error: err.message || 'Delete failed' })
		}
	})

	router.post('/receive', (req, res) => {
		try {
			res.status(201).json(mutateStock(db, req, { kind: 'receive', sign: 1, defaultNote: 'Stock received' }))
		} catch (err) {
			res.status(err.status || 400).json({ error: err.message || 'Receive failed' })
		}
	})

	router.post('/consume', (req, res) => {
		try {
			res.status(201).json(mutateStock(db, req, { kind: 'consume', sign: -1, defaultNote: 'Stock consumed' }))
		} catch (err) {
			res.status(err.status || 400).json({ error: err.message || 'Consume failed' })
		}
	})

	router.post('/adjust', requireOwner, (req, res) => {
		try {
			const item = resolveActiveItem(db, req.body)
			const qtyDelta = Number(req.body.qty_delta)
			if (!Number.isFinite(qtyDelta) || qtyDelta === 0) {
				return res.status(400).json({ error: 'qty_delta must be a non-zero number' })
			}
			const movement = db.transaction(() => applyMovement(db, {
				itemId: item.id,
				kind: 'manual_adjust',
				qtyDelta,
				actor: actorOf(req),
				note: String(req.body.note || '').trim() || 'Manual adjustment',
			}))()
			res.status(201).json({ movement, item: decorateItem(getItem(db, item.id)) })
		} catch (err) {
			res.status(err.status || 400).json({ error: err.message || 'Adjust failed' })
		}
	})

	router.get('/movements', (req, res) => {
		const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500)
		const itemId = req.query.item_id ? Number(req.query.item_id) : null
		const sql = `
			SELECT m.*, i.sku, i.name AS item_name, i.name_zh AS item_name_zh
			FROM supply_movements m
			JOIN supply_items i ON i.id = m.item_id
			${itemId ? 'WHERE m.item_id = ?' : ''}
			ORDER BY m.id DESC
			LIMIT ?
		`
		const rows = itemId ? db.prepare(sql).all(itemId, limit) : db.prepare(sql).all(limit)
		res.json({ movements: rows })
	})

	router.get('/spend', requireOwner, (req, res) => {
		try {
			const fromUtc = parseUtcBound(req.query.from, 'from')
			const toUtc = parseUtcBound(req.query.to, 'to')
			const fromMs = sqliteUtcToMs(fromUtc)
			const toMs = sqliteUtcToMs(toUtc)
			if (!(toMs > fromMs)) {
				return res.status(400).json({ error: 'to must be after from' })
			}
			if (toMs - fromMs > 400 * 24 * 60 * 60 * 1000) {
				return res.status(400).json({ error: 'Spend range cannot exceed 400 days' })
			}
			res.json(summarizeSpend(db, { fromUtc, toUtc }))
		} catch (err) {
			res.status(err.status || 400).json({ error: err.message || 'Spend failed' })
		}
	})

	router.get('/alerts', (_req, res) => {
		const lowStock = listLowStock(db).map(decorateItem)

		const lastCount = db.prepare(`
			SELECT id, submitted_at, started_at, status
			FROM supply_count_sessions
			WHERE status = 'submitted'
			ORDER BY submitted_at DESC
			LIMIT 1
		`).get() || null

		const openCount = db.prepare(`
			SELECT id, started_at, started_by
			FROM supply_count_sessions
			WHERE status = 'open'
			ORDER BY id DESC
			LIMIT 1
		`).get() || null

		const needsPurchase = listNeedsPurchase(db).map(decorateItem)

		res.json({
			low_stock: lowStock,
			low_stock_count: lowStock.length,
			needs_purchase: needsPurchase,
			needs_purchase_count: needsPurchase.length,
			last_submitted_count: lastCount,
			open_count: openCount,
			days_since_count: daysSince(lastCount && lastCount.submitted_at),
		})
	})

	router.get('/counts/current', (_req, res) => {
		const open = getOpenSession(db)
		res.json({ session: open ? hydrateSession(db, open.id) : null })
	})

	router.get('/counts', (req, res) => {
		const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100)
		const rows = db.prepare(`
			SELECT
				s.*,
				(SELECT COUNT(*) FROM supply_count_lines cl WHERE cl.session_id = s.id) AS line_count,
				(SELECT COUNT(*) FROM supply_count_lines cl
					WHERE cl.session_id = s.id AND cl.counted_qty IS NOT NULL) AS counted_count,
				(SELECT COUNT(*) FROM supply_count_lines cl
					WHERE cl.session_id = s.id
						AND cl.counted_qty IS NOT NULL
						AND cl.variance IS NOT NULL
						AND cl.variance != 0) AS variance_count
			FROM supply_count_sessions s
			ORDER BY s.id DESC
			LIMIT ?
		`).all(limit)
		res.json({ sessions: rows })
	})

	router.get('/counts/:id', (req, res) => {
		const session = hydrateSession(db, req.params.id)
		if (!session) return res.status(404).json({ error: 'Count session not found' })
		res.json({ session })
	})

	router.post('/counts', (req, res) => {
		try {
			const open = getOpenSession(db)
			if (open) {
				return res.status(409).json({
					error: 'A count session is already open',
					session: hydrateSession(db, open.id),
				})
			}

			const notes = req.body?.notes ? String(req.body.notes).trim() : null
			const sessionId = db.transaction(() => {
				const info = db.prepare(`
					INSERT INTO supply_count_sessions (status, started_by, notes)
					VALUES ('open', ?, ?)
				`).run(actorOf(req), notes)

				const items = db.prepare(`
					SELECT i.id AS item_id, b.qty_on_hand
					FROM supply_items i
					JOIN supply_balances b ON b.item_id = i.id
					WHERE i.active = 1
				`).all()

				const insertLine = db.prepare(`
					INSERT INTO supply_count_lines (session_id, item_id, expected_qty)
					VALUES (?, ?, ?)
				`)
				for (const item of items) {
					insertLine.run(info.lastInsertRowid, item.item_id, item.qty_on_hand)
				}
				return Number(info.lastInsertRowid)
			})()

			res.status(201).json({ session: hydrateSession(db, sessionId) })
		} catch (err) {
			res.status(err.status || 400).json({ error: err.message || 'Could not start count' })
		}
	})

	router.put('/counts/:id/lines', (req, res) => {
		try {
			const session = db.prepare('SELECT * FROM supply_count_sessions WHERE id = ?').get(req.params.id)
			if (!session) return res.status(404).json({ error: 'Count session not found' })
			if (session.status !== 'open') return res.status(409).json({ error: 'Count session is not open' })

			const lines = Array.isArray(req.body?.lines) ? req.body.lines : [req.body]
			if (!lines.length) return res.status(400).json({ error: 'No lines provided' })

			const update = db.prepare(`
				UPDATE supply_count_lines
				SET counted_qty = ?, variance = (? - expected_qty), counted_at = datetime('now')
				WHERE session_id = ? AND item_id = ?
			`)
			const clear = db.prepare(`
				UPDATE supply_count_lines
				SET counted_qty = NULL, variance = NULL, counted_at = NULL
				WHERE session_id = ? AND item_id = ?
			`)

			db.transaction(() => {
				for (const line of lines) {
					const itemId = Number(line.item_id)
					if (!Number.isInteger(itemId)) {
						const err = new Error('item_id is required')
						err.status = 400
						throw err
					}
					const existing = db.prepare(`
						SELECT id FROM supply_count_lines WHERE session_id = ? AND item_id = ?
					`).get(session.id, itemId)
					if (!existing) {
						const err = new Error(`Item ${itemId} is not in this count`)
						err.status = 400
						throw err
					}
					if (line.counted_qty === null || line.counted_qty === '' || line.counted_qty === undefined) {
						clear.run(session.id, itemId)
						continue
					}
					const counted = Number(line.counted_qty)
					if (!Number.isFinite(counted) || counted < 0) {
						const err = new Error('counted_qty must be a non-negative number')
						err.status = 400
						throw err
					}
					update.run(counted, counted, session.id, itemId)
				}
			})()

			res.json({ session: hydrateSession(db, session.id) })
		} catch (err) {
			res.status(err.status || 400).json({ error: err.message || 'Could not save count lines' })
		}
	})

	router.post('/counts/:id/submit', (req, res) => {
		try {
			const session = db.prepare('SELECT * FROM supply_count_sessions WHERE id = ?').get(req.params.id)
			if (!session) return res.status(404).json({ error: 'Count session not found' })
			if (session.status !== 'open') return res.status(409).json({ error: 'Count session is not open' })

			const requireComplete = req.body?.require_complete !== false
			const lines = db.prepare('SELECT * FROM supply_count_lines WHERE session_id = ?').all(session.id)
			const uncounted = lines.filter((l) => l.counted_qty == null)
			if (requireComplete && uncounted.length) {
				return res.status(400).json({
					error: `${uncounted.length} item(s) still need a count`,
					uncounted_item_ids: uncounted.map((l) => l.item_id),
				})
			}

			const movements = db.transaction(() => {
				const out = []
				for (const line of lines) {
					if (line.counted_qty == null) continue
					const counted = Number(line.counted_qty)
					const expected = Number(line.expected_qty)
					const variance = Math.round((counted - expected) * 1000) / 1000
					db.prepare(`
						UPDATE supply_count_lines
						SET counted_qty = ?, variance = ?, counted_at = COALESCE(counted_at, datetime('now'))
						WHERE id = ?
					`).run(counted, variance, line.id)
					if (variance === 0) continue
					out.push(applyMovement(db, {
						itemId: line.item_id,
						kind: 'count_adjust',
						qtyDelta: variance,
						actor: actorOf(req),
						note: `Count session #${session.id}`,
						refType: 'count_session',
						refId: session.id,
					}))
				}
				db.prepare(`
					UPDATE supply_count_sessions
					SET status = 'submitted',
						submitted_by = ?,
						submitted_at = datetime('now'),
						notes = COALESCE(?, notes)
					WHERE id = ?
				`).run(actorOf(req), req.body?.notes ? String(req.body.notes).trim() : null, session.id)
				return out
			})()

			res.json({ session: hydrateSession(db, session.id), movements })
		} catch (err) {
			res.status(err.status || 400).json({ error: err.message || 'Submit failed' })
		}
	})

	router.post('/counts/:id/cancel', (req, res) => {
		const session = db.prepare('SELECT * FROM supply_count_sessions WHERE id = ?').get(req.params.id)
		if (!session) return res.status(404).json({ error: 'Count session not found' })
		if (session.status !== 'open') {
			return res.status(409).json({ error: 'Only open sessions can be cancelled' })
		}
		db.prepare(`
			UPDATE supply_count_sessions
			SET status = 'cancelled', cancelled_at = datetime('now'),
				notes = COALESCE(?, notes)
			WHERE id = ?
		`).run(req.body?.notes ? String(req.body.notes).trim() : null, session.id)
		res.json({ session: hydrateSession(db, session.id) })
	})

	app.use('/api/supplies', router)
}

function resolveCategory(db, body) {
	return db.prepare('SELECT id, slug FROM supply_categories WHERE id = ? OR slug = ?')
		.get(body.category_id || null, body.category_slug || null) || null
}

function resolveActiveItem(db, body) {
	const key = body.item_id ?? body.sku
	if (key == null || key === '') {
		const err = new Error('item_id or sku is required')
		err.status = 400
		throw err
	}
	const item = getItem(db, key)
	if (!item || !item.active) {
		const err = new Error('Item not found or inactive')
		err.status = 404
		throw err
	}
	return item
}

function mutateStock(db, req, { kind, sign, defaultNote }) {
	const item = resolveActiveItem(db, req.body)
	const qty = Number(req.body.qty)
	if (!Number.isFinite(qty) || qty <= 0) {
		const err = new Error('qty must be a positive number')
		err.status = 400
		throw err
	}
	const cost = kind === 'receive' ? resolveReceiveCost(item, req.body || {}, qty) : null
	const movement = db.transaction(() => {
		const mv = applyMovement(db, {
			itemId: item.id,
			kind,
			qtyDelta: sign * qty,
			actor: (req.auth && req.auth.user) || 'unknown',
			note: String(req.body.note || '').trim() || defaultNote,
			unitCost: cost ? cost.unitCost : null,
			costTotal: cost ? cost.costTotal : null,
			currency: cost ? cost.currency : null,
		})
		if (kind === 'receive') {
			clearNeedsPurchase(db, item.id)
			if (cost && cost.explicit && cost.unitCost != null) {
				db.prepare(`
					UPDATE supply_items
					SET unit_cost = ?, currency = ?, updated_at = datetime('now')
					WHERE id = ?
				`).run(cost.unitCost, cost.currency || item.currency || 'USD', item.id)
			}
		}
		return mv
	})()
	return { movement, item: decorateItem(getItem(db, item.id)) }
}

function sqliteUtcToMs(value) {
	const ms = Date.parse(String(value).replace(' ', 'T') + 'Z')
	if (!Number.isFinite(ms)) {
		const err = new Error('Invalid date')
		err.status = 400
		throw err
	}
	return ms
}

function parseUtcBound(raw, field) {
	if (raw == null || String(raw).trim() === '') {
		const err = new Error(`${field} is required`)
		err.status = 400
		throw err
	}
	const text = String(raw).trim()
	if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
		return `${text} 00:00:00`
	}
	if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) {
		return text
	}
	const iso = text.includes('T') ? text : text.replace(' ', 'T')
	const stamped = /Z$|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`
	const ms = Date.parse(stamped)
	if (!Number.isFinite(ms)) {
		const err = new Error(`Invalid ${field}`)
		err.status = 400
		throw err
	}
	return new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
}

function parseBoolFlag(raw, field) {
	const name = field || 'needed'
	if (raw === undefined || raw === null || raw === '') {
		const err = new Error(`${name} is required`)
		err.status = 400
		throw err
	}
	if (raw === true || raw === 1 || raw === '1' || raw === 'true') return true
	if (raw === false || raw === 0 || raw === '0' || raw === 'false') return false
	const err = new Error(`${name} must be true or false`)
	err.status = 400
	throw err
}

function normalizeItemBody(raw, { partial = false } = {}) {
	const body = {}
	if (raw.sku != null && String(raw.sku).trim() !== '') {
		body.sku = String(raw.sku).trim().toUpperCase()
	} else if (!partial && raw.sku != null && String(raw.sku).trim() === '') {
		body.sku = ''
	}
	if (raw.name != null || !partial) {
		body.name = normalizeItemName(raw.name, { required: true })
	}
	if (raw.name_zh !== undefined) {
		body.name_zh = normalizeItemName(raw.name_zh, { required: false })
	}
	if (raw.category_id != null) body.category_id = Number(raw.category_id)
	if (raw.category_slug != null) body.category_slug = String(raw.category_slug).trim()
	if (raw.category != null) body.category_slug = String(raw.category).trim()
	if (raw.family !== undefined) {
		const slug = raw.family == null ? '' : String(raw.family).trim()
		body.family = slug || null
	}

	if (raw.uom != null || !partial) {
		body.uom = String(raw.uom || '').trim().toLowerCase()
		if (!UOMS.has(body.uom)) {
			const err = new Error('Invalid unit of measure')
			err.status = 400
			throw err
		}
	}
	if (raw.reorder_point != null || !partial) {
		body.reorder_point = Number(raw.reorder_point ?? 0)
		if (!Number.isFinite(body.reorder_point) || body.reorder_point < 0) {
			const err = new Error('Invalid reorder_point')
			err.status = 400
			throw err
		}
	}
	if (raw.reorder_qty != null || !partial) {
		body.reorder_qty = Number(raw.reorder_qty ?? 0)
		if (!Number.isFinite(body.reorder_qty) || body.reorder_qty < 0) {
			const err = new Error('Invalid reorder_qty')
			err.status = 400
			throw err
		}
	}
	if (raw.notes !== undefined) {
		body.notes = raw.notes == null || raw.notes === '' ? null : String(raw.notes)
	}
	if (raw.active !== undefined) {
		body.active = raw.active === true || raw.active === 1 || raw.active === '1' ? 1 : 0
	}
	if (raw.unit_cost !== undefined || !partial) {
		body.unit_cost = normalizeMoney(raw.unit_cost, 'unit_cost')
	}
	if (raw.currency !== undefined || !partial) {
		const currency = normalizeCurrency(raw.currency, { required: false })
		body.currency = currency || 'USD'
	}
	if (raw.supplier_name !== undefined || !partial) {
		const name = String(raw.supplier_name || '').trim()
		body.supplier_name = name || null
	}
	if (raw.supplier_url !== undefined || !partial) {
		body.supplier_url = normalizeSupplierUrl(raw.supplier_url)
	}
	return body
}

function getOpenSession(db) {
	return db.prepare(`
		SELECT * FROM supply_count_sessions WHERE status = 'open' ORDER BY id DESC LIMIT 1
	`).get() || null
}

function attachItemToOpenCount(db, itemId) {
	const open = getOpenSession(db)
	if (!open) return
	const bal = db.prepare('SELECT qty_on_hand FROM supply_balances WHERE item_id = ?').get(itemId)
	db.prepare(`
		INSERT OR IGNORE INTO supply_count_lines (session_id, item_id, expected_qty)
		VALUES (?, ?, ?)
	`).run(open.id, itemId, bal ? Number(bal.qty_on_hand) : 0)
}

function hydrateSession(db, sessionId) {
	const session = db.prepare('SELECT * FROM supply_count_sessions WHERE id = ?').get(sessionId)
	if (!session) return null

	const lines = db.prepare(`
		SELECT
			cl.*,
			i.sku, i.name, i.name_zh, i.family, i.uom, i.photo_file, i.reorder_point, i.reorder_qty,
			i.unit_cost, i.currency, i.supplier_name, i.supplier_url, i.sort_order,
			i.needs_purchase, i.needs_purchase_at, i.needs_purchase_by,
			i.purchased_at, i.purchased_by,
			c.slug AS category_slug, c.name AS category_name, c.sort_order AS category_sort
		FROM supply_count_lines cl
		JOIN supply_items i ON i.id = cl.item_id
		JOIN supply_categories c ON c.id = i.category_id
		WHERE cl.session_id = ?
		ORDER BY c.sort_order ASC, i.sort_order ASC, i.id ASC
	`).all(sessionId).map((line) => decorateItem({
		...line,
		is_low: 0,
	}))

	const counted = lines.filter((l) => l.counted_qty != null).length
	const variances = lines.filter((l) => l.counted_qty != null && Number(l.variance) !== 0)

	return {
		...session,
		progress: {
			total: lines.length,
			counted,
			remaining: lines.length - counted,
			variance_count: variances.length,
		},
		lines,
	}
}

module.exports = {
	installRoutes,
}
