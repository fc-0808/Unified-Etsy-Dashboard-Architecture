'use strict'

/**
 * HTTP surface for Listing History visual search.
 *
 * Owner-only (no ACL rule → deny-by-default for employees), same as the
 * rest of `/api/bulk/*`. Update is async so a 2,200-folder embed backfill
 * cannot pin the request thread; the UI polls `/update` GET for progress.
 *
 * POST /match accepts `shop` / `shop_id` / `listing_id`. When the Etsy
 * shop is known, results are limited to History/<shop>/ (example:
 * iPhoneCasesDesignArt → …\History\iPhoneCasesDesignArt).
 *
 * POST /locate maps listing ids onto History folders by bulk folder name
 * (incremental). POST /open accepts folder_id or listing_id.
 */

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const catalog = require('./history-catalog')
const index = require('./history-index')
const match = require('./history-match')
const locate = require('./history-locate')
const thumbnails = require('./thumbnails')
const { applyStoredImageHeaders } = require('../route/stored-image-security')
const { mimeForImage } = require('./scanner')

function httpError(status, message) {
	const err = new Error(message)
	err.status = status
	return err
}

function decodeBodyPhotos(body) {
	const out = []
	if (!body || typeof body !== 'object') throw httpError(400, 'Upload a JPEG, PNG, or WebP photo')
	if (Array.isArray(body.photos) && body.photos.length) {
		if (body.photos.length > 20) throw httpError(400, 'At most 20 photos per request')
		for (const item of body.photos) {
			const raw = item && (item.photo_data || item.image_b64)
			out.push({
				name: item && item.name ? String(item.name).slice(0, 180) : null,
				buf: match.decodePhotoData(raw),
				shop: item && (item.shop || item.shop_id) ? String(item.shop || item.shop_id) : '',
				listing_id: item && item.listing_id ? String(item.listing_id) : '',
			})
		}
		return out
	}
	const raw = body.photo_data || body.image_b64
	out.push({
		name: body.name ? String(body.name).slice(0, 180) : null,
		buf: match.decodePhotoData(raw),
		shop: body.shop || body.shop_id ? String(body.shop || body.shop_id) : '',
		listing_id: body.listing_id ? String(body.listing_id) : '',
	})
	return out
}

function openFolder(fp) {
	if (process.platform === 'win32') {
		spawn('explorer', [fp], { detached: true, stdio: 'ignore' }).unref()
		return
	}
	if (process.platform === 'darwin') {
		spawn('open', [fp], { detached: true, stdio: 'ignore' }).unref()
		return
	}
	spawn('xdg-open', [fp], { detached: true, stdio: 'ignore' }).unref()
}

function mimeFromName(filename) {
	try {
		return mimeForImage(path.extname(filename))
	} catch {
		return 'image/jpeg'
	}
}

function installRoutes(app, { db } = {}) {
	if (!app || !db) throw new Error('history-routes needs app and db')
	catalog.ensureSchema(db)

	app.get('/api/listings/history/status', (req, res) => {
		try {
			res.json(index.status(db))
		} catch (err) {
			res.status(500).json({ error: err.message || 'History status failed' })
		}
	})

	app.post('/api/listings/history/update', async (req, res) => {
		try {
			const body = req.body || {}
			const embed = body.embed !== false && body.hash_only !== true
			const wait = body.wait === true
			const result = await index.updateIndex(db, {
				embed,
				wait,
				root: body.root,
				concurrency: body.concurrency,
			})
			res.json({
				ok: true,
				accepted: result.accepted,
				job: result.job,
				snapshot: result.snapshot || null,
				status: index.status(db),
			})
		} catch (err) {
			const status = Number(err.status) || 500
			res.status(status).json({ error: err.message || 'History index update failed' })
		}
	})

	app.get('/api/listings/history/update', (req, res) => {
		try {
			res.json({ job: index.cloneJob(), status: index.status(db) })
		} catch (err) {
			res.status(500).json({ error: err.message || 'History index status failed' })
		}
	})

	app.post('/api/listings/history/match', async (req, res) => {
		try {
			const body = req.body || {}
			const photos = decodeBodyPhotos(body)
			const rerank = body.rerank
			const result = await match.matchPhotos(db, photos, {
				rerank: rerank === false ? false : rerank,
				log: true,
				shop: body.shop || body.shop_id || '',
				listing_id: body.listing_id || '',
			})
			res.json(result)
		} catch (err) {
			const status = Number(err.status) || 500
			res.status(status).json({ error: err.message || 'History match failed' })
		}
	})

	app.post('/api/listings/history/locate', (req, res) => {
		try {
			const body = req.body || {}
			const force = body.force === true
			const items = []
			if (Array.isArray(body.items) && body.items.length) {
				for (const item of body.items) {
					if (!item) continue
					items.push({ listing_id: item.listing_id, shop: item.shop || item.shop_id || body.shop || '' })
				}
			} else if (Array.isArray(body.listing_ids) && body.listing_ids.length) {
				for (const id of body.listing_ids) items.push({ listing_id: id, shop: body.shop || body.shop_id || '' })
			} else if (body.listing_id) {
				items.push({ listing_id: body.listing_id, shop: body.shop || body.shop_id || '' })
			}
			if (!items.length) throw httpError(400, 'Need at least one listing id')
			if (body.refresh === true) locate.invalidateWalkCache()
			const result = locate.updateListingMap(db, items, { force })
			res.json({
				ok: true,
				checked: result.checked,
				skipped: result.skipped,
				resolved: result.resolved,
				missing: result.missing,
				updated: result.updated,
				capped: result.capped === true,
				maps: result.maps,
			})
		} catch (err) {
			const status = Number(err.status) || 500
			res.status(status).json({ error: err.message || 'History locate failed' })
		}
	})

	app.post('/api/listings/history/open', (req, res) => {
		try {
			const body = req.body || {}
			const opened = locate.resolveOpenPath(db, {
				folder_id: body.folder_id || req.query.folder_id,
				listing_id: body.listing_id || req.query.listing_id,
				shop: body.shop || body.shop_id || '',
				force: body.force === true,
			})
			openFolder(opened.folder_path)
			try {
				index.logMatch(db, {
					query_sha: null,
					query_name: opened.listing_id ? String(opened.listing_id) : opened.folder_name,
					folder_id: opened.folder_id,
					product_key: opened.product_key,
					confidence: 'exact',
					source: 'open',
					action: 'open',
				})
			} catch {
				/* opening must not fail because the audit log did */
			}
			res.json({ ok: true, ...opened })
		} catch (err) {
			const status = Number(err.status) || 500
			res.status(status).json({ error: err.message || 'Could not open folder' })
		}
	})

	app.get('/api/listings/history/image/:folderId', async (req, res) => {
		try {
			const row = index.getFolderById(db, req.params.folderId)
			if (!row) return res.status(404).end()
			const hero = index.heroImage(db, row.id)
			const root = catalog.defaultHistoryRoot()
			const imgPath = index.resolveHeroPath(root, row, hero)
			if (!imgPath || !fs.existsSync(imgPath)) return res.status(404).end()
			const mime = mimeFromName(hero && hero.filename)
			if (!applyStoredImageHeaders(res, mime, 'private, max-age=300')) return res.status(415).end()

			const width = thumbnails.normaliseWidth(req.query.w)
			const thumb = width ? await thumbnails.getThumbnail(imgPath, width) : null
			if (thumb) {
				res.setHeader('ETag', thumb.etag)
				res.setHeader('Content-Type', thumb.mime)
				res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
				if (req.headers['if-none-match'] === thumb.etag) return res.status(304).end()
				return fs
					.createReadStream(thumb.path)
					.on('error', () => {
						if (!res.headersSent) res.status(500).end()
					})
					.pipe(res)
			}
			fs.createReadStream(imgPath)
				.on('error', () => {
					if (!res.headersSent) res.status(500).end()
				})
				.pipe(res)
		} catch (err) {
			if (!res.headersSent) res.status(500).json({ error: err.message || 'Image failed' })
		}
	})
}

module.exports = {
	installRoutes,
	decodeBodyPhotos,
}
