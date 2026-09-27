/**
 * shop-supplier-prep.js — supplier-facing prep list for WeChat messaging.
 *
 * ONE shared module, TWO consumers:
 *   1. Shopping Mode (shop.html) — builds a clean per-stall 备货清单 and renders
 *      it as a long PNG the shopper can share in WeChat (no internal UI leaked).
 *   2. A Node regression test — exercises the pure payload builder so a stall's
 *      models / quantities / images can never silently drift from the floor list.
 *
 * WHY THIS EXISTS
 * ----------------------------------------------------------------------------
 * Shoppers used to screenshot the dark shopping-mode UI and forward that to
 * suppliers. That is hard to read on a stall phone, and it exposes our ops
 * chrome (mark-bought, prices, merge controls). The industry pattern for this
 * (pickup prep sheets, B2B WeChat 长图) is a light, photo+model document with
 * only what the supplier needs to pull off the shelf before we arrive.
 *
 * DESIGN NOTES
 *   • Payload is derived from the SAME stall group shape the route renderer
 *     already builds (rows / charmAggs / loc) — never by scraping the DOM.
 *   • Includes every component that still needs supplier action (Pending, OOS,
 *     discontinued, no model…) except Purchased and Wrong Stall — wrong-stall
 *     lines belong at another booth, not on this supplier's prep sheet.
 *   • Exchanges (swaps) are excluded — they are not purchases to prep.
 *   • Labels are always Simplified Chinese: the recipients are market staff.
 *     Phone cases are 手机壳; AirPods cases are 耳机壳 (and iPad 平板壳 /
 *     watch 表带) so a mixed 合计 line is unambiguous on WeChat.
 *   • Prep photos are letterboxed (object-fit: contain), never cover-cropped.
 *     Charms are tall and cases often have dangling beads — cover hid both.
 *   • Canvas rendering lives here so the page stays thin; Node never calls it.
 */
;(function (root, factory) {
	if (typeof module === 'object' && module.exports) {
		module.exports = factory()
	} else {
		root.ShopSupplierPrep = factory()
	}
})(typeof self !== 'undefined' ? self : this, function () {
	'use strict'

	const COMP = {
		case: { key: 'case', flag: 'has_case', status: 'status_case', label: '手机壳' },
		grip: { key: 'grip', flag: 'has_grip', status: 'status_grip', label: '支架' },
		charm: { key: 'charm', flag: 'has_charm', status: 'status_charm', label: '挂件' },
	}

	const FAMILY_IPHONE = 'iphone'
	const FAMILY_AIRPODS = 'airpods'
	const FAMILY_WATCH = 'watch'
	const FAMILY_IPAD = 'ipad'

	/**
	 * Stall-facing case noun per device family. Matches catalog label_zh
	 * (src/sourcing/catalog.js): 手机壳 / 耳机壳 / 平板壳 / 表带. Never lump
	 * AirPods into the phone-case noun on the sheet (item line or 合计).
	 */
	const CASE_LABEL = {
		[FAMILY_IPHONE]: '手机壳',
		[FAMILY_AIRPODS]: '耳机壳',
		[FAMILY_IPAD]: '平板壳',
		[FAMILY_WATCH]: '表带',
	}

	// Byte-identical to src/listings/product-types.js — this file also loads in
	// the phone browser and cannot require() that module. test-supplier-prep.js
	// pins the literals so a registry tweak cannot silently split classification.
	const AIRPODS_RE = /air\s*pods?/i
	const WATCH_MODEL_RE = /apple\s*watch|\b\d{2}(?:\s*\/\s*\d{2})*\s*mm\b/i
	const WATCH_TITLE_RE = /apple\s*watch|watch\s*band|watch\s*strap/i
	const IPAD_MODEL_RE = /\bipad\b|\b\d{1,2}(?:\.\d)?\s*(?:"|″|”|-?\s?inch\b)/i
	const IPAD_TITLE_RE = /\bipad\b|\btablet\b/i

	const PREP_EXCLUDED = new Set(['Purchased', 'Wrong Stall'])
	/** Source pixels for listing photos embedded in the export (max server resize). */
	const PREP_SOURCE_WIDTH = 960
	/** Identification photos: show the whole object (charms, dangling beads). */
	const FIT_CONTAIN = 'contain'
	const FIT_COVER = 'cover'
	/** Keep letterboxed photos off the rounded-rect clip so tips are not eaten. */
	const CONTAIN_INSET = 16

	function normTitle(s) {
		return String(s || '')
			.replace(/\|/g, ',')
			.replace(/\s+/g, ' ')
			.trim()
			.toLowerCase()
	}

	function productKeyOf(r) {
		return r.product_key || 't:' + normTitle(r.title)
	}

	function isIntegralCharm(r) {
		return !!(r && r.charm_integral && r.has_charm)
	}

	function isBlankModel(model) {
		const m = String(model || '').trim()
		return !m || m === '—'
	}

	/**
	 * Device family of a shopping-route row. Same rules as
	 * product-types.deviceFamilyOf: the model variation is authoritative;
	 * title is only a fallback when the model is blank. An integral charm
	 * is AirPods by definition (the charm ships attached to the case).
	 *
	 * @param {string} [model]
	 * @param {string} [title]
	 * @returns {'iphone'|'airpods'|'watch'|'ipad'}
	 */
	function deviceFamilyOf(model, title) {
		const m = String(model ?? '').trim()
		if (!isBlankModel(m)) {
			if (WATCH_MODEL_RE.test(m)) return FAMILY_WATCH
			if (IPAD_MODEL_RE.test(m)) return FAMILY_IPAD
			return AIRPODS_RE.test(m) ? FAMILY_AIRPODS : FAMILY_IPHONE
		}
		const t = String(title ?? '')
		if (AIRPODS_RE.test(t)) return FAMILY_AIRPODS
		if (WATCH_TITLE_RE.test(t)) return FAMILY_WATCH
		if (IPAD_TITLE_RE.test(t)) return FAMILY_IPAD
		return FAMILY_IPHONE
	}

	/**
	 * Family for a case-line group. Integral-charm rows win (AirPods), else
	 * the first row's model/title. Passing the group (not the grouped model
	 * key) matters: the key may be "—" while the title still names AirPods.
	 *
	 * @param {object|object[]} rows
	 * @returns {'iphone'|'airpods'|'watch'|'ipad'}
	 */
	function caseFamilyOf(rows) {
		const list = Array.isArray(rows) ? rows : rows ? [rows] : []
		for (const r of list) {
			if (r && r.charm_integral) return FAMILY_AIRPODS
		}
		const sample = list[0] || {}
		return deviceFamilyOf(sample.phone_model, sample.title)
	}

	function caseLabelForFamily(family) {
		return CASE_LABEL[family] || CASE_LABEL[FAMILY_IPHONE]
	}

	function emptyTotals() {
		return { case: 0, airpods: 0, ipad: 0, watch: 0, grip: 0, charm: 0, items: 0 }
	}

	function addCaseTotal(totals, family, qty) {
		if (!qty) return
		if (family === FAMILY_AIRPODS) totals.airpods += qty
		else if (family === FAMILY_IPAD) totals.ipad += qty
		else if (family === FAMILY_WATCH) totals.watch += qty
		else totals.case += qty
	}

	/**
	 * WeChat 合计 fragments, only the buckets that have quantity.
	 * Phone 手机壳 and AirPods 耳机壳 are separate so a mixed stall is readable.
	 * @param {{case?:number, airpods?:number, ipad?:number, watch?:number, grip?:number, charm?:number}} totals
	 * @returns {string[]}
	 */
	function summaryParts(totals) {
		const t = totals || {}
		const parts = []
		if (t.case) parts.push(CASE_LABEL[FAMILY_IPHONE] + ' ×' + t.case)
		if (t.airpods) parts.push(CASE_LABEL[FAMILY_AIRPODS] + ' ×' + t.airpods)
		if (t.ipad) parts.push(CASE_LABEL[FAMILY_IPAD] + ' ×' + t.ipad)
		if (t.watch) parts.push(CASE_LABEL[FAMILY_WATCH] + ' ×' + t.watch)
		if (t.grip) parts.push(COMP.grip.label + ' ×' + t.grip)
		if (t.charm) parts.push(COMP.charm.label + ' ×' + t.charm)
		return parts
	}

	/**
	 * Destination rect for drawing `imgW`×`imgH` into a square well.
	 * `contain` letterboxes (whole object visible); `cover` fills and crops.
	 * Exported so Node tests can pin that a tall charm is not centre-cropped.
	 *
	 * @param {number} imgW
	 * @param {number} imgH
	 * @param {number} boxX
	 * @param {number} boxY
	 * @param {number} boxSize
	 * @param {string} [fit]
	 * @param {number} [inset]
	 * @returns {{x:number, y:number, w:number, h:number}}
	 */
	function imageDrawRect(imgW, imgH, boxX, boxY, boxSize, fit, inset) {
		const mode = fit === FIT_COVER ? FIT_COVER : FIT_CONTAIN
		const pad = mode === FIT_COVER ? 0 : inset == null ? CONTAIN_INSET : inset
		const inner = Math.max(1, boxSize - pad * 2)
		const iw = Math.max(Number(imgW) || 0, 1)
		const ih = Math.max(Number(imgH) || 0, 1)
		const scale = mode === FIT_COVER ? Math.max(boxSize / iw, boxSize / ih) : Math.min(inner / iw, inner / ih)
		const dw = iw * scale
		const dh = ih * scale
		return {
			x: boxX + (boxSize - dw) / 2,
			y: boxY + (boxSize - dh) / 2,
			w: dw,
			h: dh,
		}
	}

	function isPrepLine(status) {
		return !PREP_EXCLUDED.has(status || 'Pending')
	}

	function prepRows(rows, statusField) {
		return (rows || []).filter((r) => isPrepLine(r[statusField]))
	}

	function prepQty(rows, statusField) {
		let n = 0
		for (const r of rows || []) {
			if (!isPrepLine(r[statusField])) continue
			n += r.quantity || 1
		}
		return n
	}

	function formatDate(d) {
		const x = d instanceof Date ? d : new Date(d || Date.now())
		if (Number.isNaN(x.getTime())) return ''
		const y = x.getFullYear()
		const m = String(x.getMonth() + 1).padStart(2, '0')
		const day = String(x.getDate()).padStart(2, '0')
		return y + '-' + m + '-' + day
	}

	function defaultCharmImageUrl(code, version) {
		const c = String(code || '').trim()
		if (!c) return ''
		const base = '/api/route/charm-image?code=' + encodeURIComponent(c)
		return version ? base + '&v=' + encodeURIComponent(version) : base
	}

	/**
	 * Request a sharper variant of a route listing photo for the export canvas.
	 * Card thumbnails in the shopping UI use w=300; the prep sheet needs more
	 * pixels so supplier staff can read the design on WeChat.
	 * @param {string} url
	 * @returns {string}
	 */
	function upgradePrepImageUrl(url) {
		const s = String(url || '').trim()
		if (!s) return s
		if (s.includes('/api/route/listing-image/')) {
			try {
				const u = new URL(s, 'https://local.invalid')
				u.searchParams.set('w', String(PREP_SOURCE_WIDTH))
				return u.pathname + u.search
			} catch {
				if (/[?&]w=\d+/.test(s)) return s.replace(/([?&])w=\d+/, '$1w=' + PREP_SOURCE_WIDTH)
				return s + (s.includes('?') ? '&' : '?') + 'w=' + PREP_SOURCE_WIDTH
			}
		}
		if (/il_300x300\./.test(s)) return s.replace('il_300x300.', 'il_794xN.')
		if (/il_570xN\./.test(s)) return s.replace('il_570xN.', 'il_794xN.')
		return s
	}

	function isIOS() {
		if (typeof navigator === 'undefined') return false
		const ua = navigator.userAgent || ''
		if (/iPad|iPhone|iPod/.test(ua)) return true
		// iPadOS 13+ reports MacIntel.
		return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
	}

	/**
	 * Build a supplier-facing prep document from one Shopping Mode stall group.
	 *
	 * @param {object} group  LAST_GROUPS entry (cg or charm section)
	 * @param {object} [opts]
	 * @param {string} [opts.buildingLabel]  Market name (e.g. 汇通)
	 * @param {string} [opts.stallCode]      Booth code without market prefix
	 * @param {Date|string|number} [opts.date]
	 * @param {(code:string, version?:string)=>string} [opts.charmImageUrl]
	 * @returns {{
	 *   empty: boolean,
	 *   title: string,
	 *   shop: string,
	 *   stall: string,
	 *   building: string,
	 *   date: string,
	 *   filename: string,
	 *   products: Array<{imageUrl:string, fit:string, lines:Array<{kind:string,family?:string,label:string,model:string|null,qty:number}>}>,
	 *   charms: Array<{imageUrl:string, code:string, qty:number, fit:string}>,
	 *   totals: {case:number, airpods:number, ipad:number, watch:number, grip:number, charm:number, items:number}
	 * }}
	 */
	function buildSupplierPrep(group, opts) {
		opts = opts || {}
		const g = group || {}
		const charmUrl = typeof opts.charmImageUrl === 'function' ? opts.charmImageUrl : defaultCharmImageUrl
		const shop = String(g.shop || '').trim()
		const stallFull = String(g.stall || '').trim()
		const stall =
			String(opts.stallCode || (g.loc && g.loc.code) || stallFull || '')
				.trim() || stallFull
		const building = String(opts.buildingLabel || (g.loc && g.loc.buildingLabel) || '').trim()
		const date = formatDate(opts.date)

		const products = []
		const totals = emptyTotals()

		if (g.section !== 'charm') {
			const byProduct = new Map()
			for (const r of g.rows || []) {
				const k = productKeyOf(r)
				if (!byProduct.has(k)) byProduct.set(k, [])
				byProduct.get(k).push(r)
			}
			const buckets = [...byProduct.values()].sort((a, b) =>
				String(a[0].title || '').localeCompare(String(b[0].title || ''), undefined, {
					numeric: true,
					sensitivity: 'base',
				}),
			)
			for (const lines of buckets) {
				const caseLines = prepRows(
					lines.filter((r) => r.has_case),
					COMP.case.status,
				)
				const gripLines = prepRows(
					lines.filter((r) => r.has_grip),
					COMP.grip.status,
				)
				const charmLines = prepRows(lines.filter(isIntegralCharm), COMP.charm.status)
				if (!caseLines.length && !gripLines.length && !charmLines.length) continue

				const entryLines = []
				const byModel = new Map()
				for (const line of caseLines) {
					const key = String(line.phone_model || '—').trim() || '—'
					if (!byModel.has(key)) byModel.set(key, [])
					byModel.get(key).push(line)
				}
				const models = [...byModel.entries()].sort((a, b) =>
					b[0].localeCompare(a[0], undefined, { numeric: true, sensitivity: 'base' }),
				)
				for (const [model, modelRows] of models) {
					const qty = prepQty(modelRows, COMP.case.status)
					if (!qty) continue
					const family = caseFamilyOf(modelRows)
					entryLines.push({
						kind: 'case',
						family,
						label: caseLabelForFamily(family),
						model,
						qty,
					})
					addCaseTotal(totals, family, qty)
				}
				if (gripLines.length) {
					const qty = prepQty(gripLines, COMP.grip.status)
					if (qty) {
						entryLines.push({ kind: 'grip', label: COMP.grip.label, model: null, qty })
						totals.grip += qty
					}
				}
				if (charmLines.length) {
					const qty = prepQty(charmLines, COMP.charm.status)
					if (qty) {
						entryLines.push({ kind: 'charm', label: COMP.charm.label, model: null, qty })
						totals.charm += qty
					}
				}
				if (!entryLines.length) continue
				const imageUrl = upgradePrepImageUrl(String(lines[0].image_url || '').trim())
				products.push({ imageUrl, fit: FIT_CONTAIN, lines: entryLines })
				totals.items += 1
			}
		}

		const charmAggs = g.section === 'charm' ? g.aggs || [] : g.charmAggs || []
		const charms = []
		for (const a of charmAggs) {
			const rows = prepRows(a.rows || [], COMP.charm.status)
			const qty = prepQty(rows, COMP.charm.status)
			if (!qty) continue
			const code = String(a.charm_code || (rows[0] && rows[0].charm_code) || '').trim()
			const version =
				a.charm_image_version || (rows[0] && rows[0].charm_image_version) || ''
			charms.push({
				imageUrl: code ? charmUrl(code, version) : '',
				code: code || '未指定挂件',
				qty,
				fit: FIT_CONTAIN,
			})
			totals.charm += qty
			totals.items += 1
		}

		const empty = products.length === 0 && charms.length === 0
		const place = [building, stall].filter(Boolean).join(' ')
		const nameBits = [shop || '供应商', place || stallFull].filter(Boolean)
		const filenameSafe = nameBits
			.join('-')
			.replace(/[\\/:*?"<>|]+/g, '_')
			.replace(/\s+/g, '')
		const filename = '备货-' + (filenameSafe || '供应商') + (date ? '-' + date : '') + '.png'

		return {
			empty,
			title: '备货清单',
			shop: shop || '供应商',
			stall,
			building,
			date,
			filename,
			products,
			charms,
			totals,
		}
	}

	/**
	 * Plain-text WeChat paste fallback (no photos). Always Chinese.
	 * @param {ReturnType<typeof buildSupplierPrep>} prep
	 * @returns {string}
	 */
	function prepToText(prep) {
		if (!prep || prep.empty) return ''
		const head = [
			'【' + prep.title + '】',
			[prep.building, prep.stall, prep.shop].filter(Boolean).join(' · '),
			prep.date ? '日期 ' + prep.date : '',
		]
			.filter(Boolean)
			.join('\n')
		const blocks = []
		let i = 1
		for (const p of prep.products) {
			const parts = p.lines.map((ln) => {
				if (ln.kind === 'case') return ln.label + ' ' + ln.model + ' ×' + ln.qty
				return ln.label + ' ×' + ln.qty
			})
			blocks.push(i++ + '. ' + parts.join(' + '))
		}
		for (const c of prep.charms) {
			blocks.push(i++ + '. 挂件 ' + c.code + ' ×' + c.qty)
		}
		const summary = summaryParts(prep.totals)
		return (
			head +
			'\n\n' +
			blocks.join('\n') +
			(summary.length ? '\n\n合计：' + summary.join(' · ') : '') +
			'\n\n请提前备好以上商品，我们稍后到店取货。谢谢！'
		)
	}

	// ── Canvas long-image (browser only) ─────────────────────────────────────

	const CANVAS = {
		width: 900,
		pad: 36,
		gap: 18,
		innerPad: 22,
		textGap: 16,
		lineH: 44,
		labelFont: 26,
		qtyFont: 28,
		radius: 14,
		bg: '#f4f5f7',
		card: '#ffffff',
		border: '#e2e5eb',
		text: '#1a1d26',
		muted: '#6b7280',
		accent: '#ea580c',
		case: '#2563eb',
		airpods: '#0f766e',
		ipad: '#0369a1',
		watch: '#b45309',
		grip: '#ea580c',
		charm: '#7c3aed',
	}

	function roundRect(ctx, x, y, w, h, r) {
		const rr = Math.min(r, w / 2, h / 2)
		ctx.beginPath()
		ctx.moveTo(x + rr, y)
		ctx.arcTo(x + w, y, x + w, y + h, rr)
		ctx.arcTo(x + w, y + h, x, y + h, rr)
		ctx.arcTo(x, y + h, x, y, rr)
		ctx.arcTo(x, y, x + w, y, rr)
		ctx.closePath()
	}

	function loadImage(url) {
		return new Promise((resolve) => {
			if (!url || typeof Image === 'undefined') return resolve(null)
			const img = new Image()
			img.decoding = 'async'
			img.onload = () => resolve(img)
			img.onerror = () => resolve(null)
			img.src = url
		})
	}

	function kindColor(kind, family) {
		if (kind === 'grip') return CANVAS.grip
		if (kind === 'charm') return CANVAS.charm
		if (family === FAMILY_AIRPODS) return CANVAS.airpods
		if (family === FAMILY_IPAD) return CANVAS.ipad
		if (family === FAMILY_WATCH) return CANVAS.watch
		return CANVAS.case
	}

	function cardHeight(lineCount, imageSize) {
		const innerPad = CANVAS.innerPad
		const textH = Math.max(1, lineCount) * CANVAS.lineH
		return innerPad + imageSize + CANVAS.textGap + textH + innerPad
	}

	function drawThumb(ctx, img, imgUrl, x, y, size, fit) {
		const thumb = size || 0
		if (thumb <= 0) return
		roundRect(ctx, x, y, thumb, thumb, 14)
		ctx.fillStyle = img ? '#ffffff' : '#eef0f4'
		ctx.fill()
		if (img) {
			ctx.save()
			roundRect(ctx, x, y, thumb, thumb, 14)
			ctx.clip()
			const r = imageDrawRect(img.width, img.height, x, y, thumb, fit || FIT_CONTAIN, CONTAIN_INSET)
			ctx.drawImage(img, r.x, r.y, r.w, r.h)
			ctx.restore()
		} else {
			ctx.fillStyle = CANVAS.muted
			ctx.font = '400 16px "PingFang SC","Microsoft YaHei",sans-serif'
			ctx.textBaseline = 'top'
			ctx.fillText(imgUrl ? '无图' : '', x + thumb / 2 - 16, y + thumb / 2 - 8)
		}
		ctx.strokeStyle = CANVAS.border
		ctx.lineWidth = 1
		roundRect(ctx, x, y, thumb, thumb, 14)
		ctx.stroke()
	}

	function drawLineRow(ctx, label, qty, color, x, y) {
		ctx.textBaseline = 'top'
		ctx.fillStyle = color
		ctx.font = '700 ' + CANVAS.labelFont + 'px "PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif'
		ctx.fillText(label, x, y)
		const lw = ctx.measureText(label).width
		ctx.fillStyle = CANVAS.text
		ctx.font = '700 ' + CANVAS.qtyFont + 'px "PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif'
		ctx.fillText('×' + qty, x + lw + 14, y - 1)
	}

	/**
	 * Rasterize a prep document to a PNG Blob (WeChat-friendly long image).
	 * @param {ReturnType<typeof buildSupplierPrep>} prep
	 * @param {object} [opts]
	 * @param {(n:number,total:number)=>void} [opts.onProgress]
	 * @returns {Promise<Blob>}
	 */
	async function renderPrepImage(prep, opts) {
		opts = opts || {}
		if (!prep || prep.empty) throw new Error('Nothing to prepare at this stall.')
		if (typeof document === 'undefined') throw new Error('Canvas render requires a browser.')

		const urls = []
		for (const p of prep.products) if (p.imageUrl) urls.push(p.imageUrl)
		for (const c of prep.charms) if (c.imageUrl) urls.push(c.imageUrl)
		const unique = [...new Set(urls)]
		const images = new Map()
		let loaded = 0
		await Promise.all(
			unique.map(async (u) => {
				images.set(u, await loadImage(u))
				loaded++
				if (opts.onProgress) opts.onProgress(loaded, unique.length)
			}),
		)

		const W = CANVAS.width
		const pad = CANVAS.pad
		const gap = CANVAS.gap
		const contentW = W - pad * 2
		const innerPad = CANVAS.innerPad
		const imageSize = contentW - innerPad * 2

		let height = pad + 46 + 34
		if (prep.date) height += 28
		height += 12
		for (const p of prep.products) height += cardHeight(p.lines.length, imageSize) + gap
		for (const c of prep.charms) height += cardHeight(1, imageSize) + gap
		height += 36 + 40 + pad

		const canvas = document.createElement('canvas')
		canvas.width = W
		canvas.height = Math.ceil(height)
		const ctx = canvas.getContext('2d')
		ctx.fillStyle = CANVAS.bg
		ctx.fillRect(0, 0, W, canvas.height)
		ctx.textBaseline = 'top'

		let y = pad
		ctx.fillStyle = CANVAS.text
		ctx.font = '700 36px "PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif'
		ctx.fillText(prep.title, pad, y)
		y += 46

		ctx.fillStyle = CANVAS.accent
		ctx.font = '700 24px "PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif'
		ctx.fillText([prep.building, prep.stall, prep.shop].filter(Boolean).join(' · '), pad, y)
		y += 34

		if (prep.date) {
			ctx.fillStyle = CANVAS.muted
			ctx.font = '400 17px "PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif'
			ctx.fillText('日期 ' + prep.date, pad, y)
			y += 28
		}
		y += 12

		function paintCard(imgUrl, rows, fit) {
			const img = imgUrl ? images.get(imgUrl) : null
			const h = cardHeight(rows.length, imageSize)
			roundRect(ctx, pad, y, contentW, h, CANVAS.radius)
			ctx.fillStyle = CANVAS.card
			ctx.fill()
			ctx.strokeStyle = CANVAS.border
			ctx.lineWidth = 1
			ctx.stroke()

			const ix = pad + innerPad
			const iy = y + innerPad
			drawThumb(ctx, img, imgUrl, ix, iy, imageSize, fit || FIT_CONTAIN)
			let ty = iy + imageSize + CANVAS.textGap
			const textX = pad + innerPad
			for (const row of rows) {
				drawLineRow(ctx, row.label, row.qty, row.color, textX, ty)
				ty += CANVAS.lineH
			}
			y += h + gap
		}

		for (const p of prep.products) {
			paintCard(
				p.imageUrl,
				p.lines.map((ln) => ({
					label: ln.kind === 'case' ? ln.label + '  ' + ln.model : ln.label,
					qty: ln.qty,
					color: kindColor(ln.kind, ln.family),
				})),
				p.fit,
			)
		}
		for (const ch of prep.charms) {
			paintCard(ch.imageUrl, [{ label: '挂件  ' + ch.code, qty: ch.qty, color: CANVAS.charm }], ch.fit)
		}

		const summary = summaryParts(prep.totals)
		ctx.fillStyle = CANVAS.text
		ctx.font = '700 18px "PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif'
		ctx.fillText('合计：' + summary.join(' · '), pad, y)
		y += 28
		ctx.fillStyle = CANVAS.muted
		ctx.font = '400 15px "PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif'
		ctx.fillText('请提前备好以上商品，我们稍后到店取货。谢谢！', pad, y)

		return new Promise((resolve, reject) => {
			if (canvas.toBlob) {
				canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG encode failed'))), 'image/png')
			} else {
				try {
					const data = canvas.toDataURL('image/png')
					const bin = atob(data.split(',')[1])
					const arr = new Uint8Array(bin.length)
					for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
					resolve(new Blob([arr], { type: 'image/png' }))
				} catch (err) {
					reject(err)
				}
			}
		})
	}

	/**
	 * Trigger a file download for a Blob (desktop / Android fallback).
	 * @param {Blob} blob
	 * @param {string} filename
	 */
	function downloadBlob(blob, filename) {
		const url = URL.createObjectURL(blob)
		const a = document.createElement('a')
		a.href = url
		a.download = filename || 'prep.png'
		a.rel = 'noopener'
		document.body.appendChild(a)
		a.click()
		a.remove()
		setTimeout(() => URL.revokeObjectURL(url), 4000)
	}

	/**
	 * Save the prep PNG to the device photo library.
	 *
	 * iOS Safari / PWA has no direct Photos API — the supported path is the system
	 * share sheet → 「存储图像」 (Save Image). When that is unavailable we signal
	 * `longpress` so the page can open a full-screen preview the employee can
	 * long-press to save.
	 *
	 * @param {Blob} blob
	 * @param {string} filename
	 * @returns {Promise<'saved'|'downloaded'|'longpress'|'aborted'|'unsupported'>}
	 */
	async function savePrepToPhotos(blob, filename) {
		if (!blob) return 'unsupported'
		const file = new File([blob], filename || 'prep.png', { type: blob.type || 'image/png' })
		const shareData = { files: [file] }
		if (typeof navigator !== 'undefined' && navigator.share && navigator.canShare) {
			try {
				if (navigator.canShare(shareData)) {
					await navigator.share(shareData)
					return 'saved'
				}
			} catch (err) {
				if (err && err.name === 'AbortError') return 'aborted'
			}
		}
		if (isIOS()) return 'longpress'
		try {
			downloadBlob(blob, filename)
			return 'downloaded'
		} catch {
			return 'unsupported'
		}
	}

	/**
	 * Share via Web Share API when the OS accepts image files (WeChat etc.).
	 * @param {Blob} blob
	 * @param {string} filename
	 * @param {string} [text]
	 * @returns {Promise<'shared'|'unsupported'|'aborted'>}
	 */
	async function sharePrepBlob(blob, filename, text) {
		if (typeof navigator === 'undefined' || !navigator.share || !navigator.canShare) {
			return 'unsupported'
		}
		const file = new File([blob], filename || 'prep.png', { type: blob.type || 'image/png' })
		const data = { files: [file], title: '备货清单', text: text || '' }
		try {
			if (!navigator.canShare(data)) return 'unsupported'
			await navigator.share(data)
			return 'shared'
		} catch (err) {
			if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) return 'aborted'
			return 'unsupported'
		}
	}

	return {
		COMP,
		CASE_LABEL,
		FAMILY_IPHONE,
		FAMILY_AIRPODS,
		FAMILY_WATCH,
		FAMILY_IPAD,
		FIT_CONTAIN,
		FIT_COVER,
		CONTAIN_INSET,
		PREP_EXCLUDED,
		PREP_SOURCE_WIDTH,
		buildSupplierPrep,
		prepToText,
		summaryParts,
		renderPrepImage,
		upgradePrepImageUrl,
		imageDrawRect,
		deviceFamilyOf,
		caseFamilyOf,
		caseLabelForFamily,
		isIOS,
		isPrepLine,
		prepRows,
		prepQty,
		downloadBlob,
		savePrepToPhotos,
		sharePrepBlob,
		formatDate,
		normTitle,
		productKeyOf,
		isIntegralCharm,
	}
})
