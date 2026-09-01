'use strict'

/**
 * Local-only, per-listing Etsy Stats comparison.
 *
 * Etsy does not provide Shop Stats through Open API v3 or its normal listing
 * CSV export. This module accepts two tables copied manually from Shop Manager,
 * joins them by listing ID (or normalized title), validates equal 7/28-day
 * periods, and stores normalized aggregate listing metrics. Raw pasted text and
 * buyer/order identity are never persisted.
 */

const crypto = require('crypto')

const MAX_PASTE_CHARS = 500_000
const MAX_ROWS = 1_000
const MAX_TITLE_CHARS = 300
const MAX_NOTE_CHARS = 500
const MAX_COUNT = 1_000_000_000
const MAX_MONEY = 1_000_000_000_000
const ALLOWED_WINDOW_DAYS = Object.freeze([7, 28])

const HEADER_ALIASES = Object.freeze({
  listing_id: ['listing id', 'listing_id', 'id', '商品 id', '商品编号'],
  title: ['listing', 'listing title', 'title', 'item', 'item title', '商品', '商品标题', '标题'],
  views: ['views', 'listing views', 'view', '浏览', '浏览量'],
  favorites: ['favorites', 'favourites', 'favorite', 'favourite', '收藏', '收藏数'],
  orders: ['orders', 'order', 'sales', '订单', '订单数'],
  revenue: ['revenue', 'sales revenue', '收入', '营收', '销售额'],
})

const SECTION_ALIASES = Object.freeze({
  current: ['current', 'current listings', 'current period', 'this period', '本期商品', '当前商品', '当前周期商品'],
  baseline: ['previous', 'previous listings', 'previous period', 'prior listings', 'baseline listings', '上期商品', '上一期商品', '前期商品'],
})

function detailImportError(message, field, code = 'INVALID_GROWTH_LISTING_IMPORT') {
  const err = new Error(message)
  err.status = 400
  err.code = code
  if (field) err.field = field
  return err
}

function normalizeLabel(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\uFEFF/, '')
    .replace(/[：:_-]+/g, ' ')
    .replace(/\s+/g, ' ')
}

function canonicalHeader(value) {
  const normalized = normalizeLabel(value)
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.map(normalizeLabel).includes(normalized)) return field
  }
  return null
}

function matchSection(value) {
  const normalized = normalizeLabel(value).replace(/[.:：]+$/, '')
  for (const [role, aliases] of Object.entries(SECTION_ALIASES)) {
    if (aliases.map(normalizeLabel).includes(normalized)) return role
  }
  return null
}

function parseDelimitedLine(line, delimiter) {
  if (delimiter === '\t') return String(line).split('\t').map((cell) => cell.trim())
  const cells = []
  let current = ''
  let quoted = false
  const text = String(line)
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        current += '"'
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (char === delimiter && !quoted) {
      cells.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  if (quoted) throw detailImportError('A CSV row contains an unclosed quote.', 'text', 'INVALID_GROWTH_LISTING_CSV')
  cells.push(current.trim())
  return cells
}

function chooseDelimiter(line) {
  if (String(line).includes('\t')) return '\t'
  if (String(line).includes(',')) return ','
  return null
}

function cleanNumericText(value) {
  if (typeof value === 'number') return value
  let text = String(value ?? '').trim()
  if (!text) return null
  const negativeParens = /^\(.*\)$/.test(text)
  text = text
    .replace(/[,%\s\u00a0']/g, '')
    .replace(/HK\$|US\$|CA\$|AU\$|CN¥|RMB|HKD|USD|CAD|AUD|CNY|EUR|GBP/gi, '')
    .replace(/[^\d.+-]/g, '')
  if (!text) return null
  const number = Number(text)
  if (!Number.isFinite(number)) return NaN
  return negativeParens ? -Math.abs(number) : number
}

function normalizeCount(value, field, { required = false } = {}) {
  const number = cleanNumericText(value)
  if (number == null) {
    if (required) throw detailImportError(`${field} is required.`, field)
    return null
  }
  if (!Number.isInteger(number) || number < 0 || number > MAX_COUNT) {
    throw detailImportError(`${field} must be a whole number from 0 to ${MAX_COUNT.toLocaleString()}.`, field)
  }
  return number
}

function normalizeMoney(value, field) {
  const number = cleanNumericText(value)
  if (number == null) return null
  if (!Number.isFinite(number) || number < 0 || number > MAX_MONEY) {
    throw detailImportError(`${field} must be a non-negative amount.`, field)
  }
  return Math.round(number * 100) / 100
}

function normalizeTitle(value, field) {
  const title = String(value ?? '').trim().replace(/\s+/g, ' ')
  if (!title) throw detailImportError(`${field} is required.`, field)
  if (title.length > MAX_TITLE_CHARS) {
    throw detailImportError(`${field} is too long (maximum ${MAX_TITLE_CHARS} characters).`, field)
  }
  return title
}

function normalizeListingId(value, field) {
  const listingId = String(value ?? '').trim()
  if (!listingId) return null
  if (!/^\d{1,32}$/.test(listingId)) {
    throw detailImportError(`${field} must contain only digits.`, field)
  }
  return listingId
}

function listingMatchKey(listingId, title) {
  return listingId ? `id:${listingId}` : `title:${normalizeLabel(title)}`
}

function parsePastedListingStats(text) {
  const raw = String(text ?? '').trim()
  if (!raw) throw detailImportError('Paste listing Stats tables first.', 'text', 'EMPTY_GROWTH_LISTING_PASTE')
  if (raw.length > MAX_PASTE_CHARS) {
    throw detailImportError(`Pasted text is too large (maximum ${MAX_PASTE_CHARS.toLocaleString()} characters).`, 'text')
  }

  const tables = { current: new Map(), baseline: new Map() }
  let role = null
  let headers = null
  let delimiter = null
  let rowNumber = 0

  for (const sourceLine of raw.split(/\r?\n/)) {
    rowNumber += 1
    const line = sourceLine.trim()
    if (!line) continue
    const section = matchSection(line)
    if (section) {
      role = section
      headers = null
      delimiter = null
      continue
    }
    if (!role) continue

    if (!headers) {
      delimiter = chooseDelimiter(line)
      if (!delimiter) continue
      const cells = parseDelimitedLine(line, delimiter)
      headers = cells.map(canonicalHeader)
      if (!headers.includes('title') && !headers.includes('listing_id')) {
        headers = null
        continue
      }
      if (!headers.includes('views') || !headers.includes('orders')) {
        throw detailImportError(
          `${role} header must include Views and Orders.`,
          'text',
          'MISSING_GROWTH_LISTING_COLUMNS'
        )
      }
      continue
    }

    const cells = parseDelimitedLine(line, delimiter)
    const source = {}
    headers.forEach((header, index) => {
      if (header && source[header] == null) source[header] = cells[index] ?? ''
    })
    if (!Object.values(source).some((value) => String(value).trim())) continue

    const prefix = `${role} row ${rowNumber}`
    const listingId = normalizeListingId(source.listing_id, `${prefix}.listing_id`)
    const title = source.title
      ? normalizeTitle(source.title, `${prefix}.title`)
      : `Listing ${listingId}`
    const key = listingMatchKey(listingId, title)
    if (tables[role].has(key)) {
      throw detailImportError(
        `Duplicate ${role} listing "${title}". Use a Listing ID to disambiguate identical titles.`,
        'text',
        'DUPLICATE_GROWTH_LISTING'
      )
    }
    tables[role].set(key, {
      listing_id: listingId,
      title,
      views: normalizeCount(source.views, `${prefix}.views`, { required: true }),
      favorites: normalizeCount(source.favorites, `${prefix}.favorites`),
      orders: normalizeCount(source.orders, `${prefix}.orders`, { required: true }),
      revenue: normalizeMoney(source.revenue, `${prefix}.revenue`),
    })
    if (tables[role].size > MAX_ROWS) {
      throw detailImportError(`Each table can contain at most ${MAX_ROWS.toLocaleString()} listings.`, 'text')
    }
  }

  if (!tables.current.size || !tables.baseline.size) {
    throw detailImportError(
      'Include CURRENT LISTINGS and PREVIOUS LISTINGS sections, each with a header and rows.',
      'text',
      'MISSING_GROWTH_LISTING_SECTION'
    )
  }

  const rows = []
  let currentOnly = 0
  let baselineOnly = 0
  for (const [key, current] of tables.current) {
    const baseline = tables.baseline.get(key)
    if (!baseline) {
      currentOnly += 1
      continue
    }
    rows.push({
      listing_id: current.listing_id || baseline.listing_id,
      title: current.title || baseline.title,
      current,
      baseline,
    })
  }
  for (const key of tables.baseline.keys()) {
    if (!tables.current.has(key)) baselineOnly += 1
  }
  if (!rows.length) {
    throw detailImportError(
      'No listings matched between periods. Include Listing ID in both tables, or keep titles identical.',
      'text',
      'NO_MATCHED_GROWTH_LISTINGS'
    )
  }

  const warnings = []
  if (currentOnly) warnings.push(`${currentOnly} current-period listing(s) had no previous-period match and were excluded.`)
  if (baselineOnly) warnings.push(`${baselineOnly} previous-period listing(s) had no current-period match and were excluded.`)
  if (rows.some((row) => !row.listing_id)) {
    warnings.push('Some rows were matched by exact normalized title. Include Listing ID when possible so title edits cannot break matching.')
  }
  rows.sort((a, b) => b.current.views - a.current.views || a.title.localeCompare(b.title))

  return {
    rows,
    matched_rows: rows.length,
    current_rows: tables.current.size,
    baseline_rows: tables.baseline.size,
    warnings,
  }
}

function parseIsoDate(value, field) {
  const text = String(value ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw detailImportError(`${field} must use YYYY-MM-DD.`, field)
  }
  const ms = Date.parse(`${text}T00:00:00Z`)
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== text) {
    throw detailImportError(`${field} is not a real calendar date.`, field)
  }
  return text
}

function dateMs(iso) {
  return Date.parse(`${iso}T00:00:00Z`)
}

function inclusiveDays(start, end) {
  return Math.floor((dateMs(end) - dateMs(start)) / 86_400_000) + 1
}

function localCalendarDate(nowMs) {
  const date = new Date(nowMs)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function normalizeCurrency(value, needsCurrency) {
  const raw = String(value ?? '').trim().toUpperCase()
  const aliases = { 'HK$': 'HKD', RMB: 'CNY', 'CN¥': 'CNY', 'US$': 'USD', 'CA$': 'CAD', 'AU$': 'AUD', '£': 'GBP', '€': 'EUR' }
  const currency = aliases[raw] || raw
  if (!currency) {
    if (needsCurrency) throw detailImportError('currency is required when revenue is entered.', 'currency')
    return null
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw detailImportError('currency must be a three-letter ISO code such as HKD, USD, or CNY.', 'currency')
  }
  return currency
}

function normalizeListingDetailImport(input, { nowMs = Date.now() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw detailImportError('Listing detail payload must be an object.')
  }
  const shopId = String(input.shop_id ?? '').trim()
  if (!shopId || shopId.length > 128) throw detailImportError('shop_id is required.', 'shop_id')

  const current = {
    start: parseIsoDate(input.current?.start, 'current.start'),
    end: parseIsoDate(input.current?.end, 'current.end'),
  }
  const baseline = {
    start: parseIsoDate(input.baseline?.start, 'baseline.start'),
    end: parseIsoDate(input.baseline?.end, 'baseline.end'),
  }
  if (dateMs(current.end) < dateMs(current.start)) {
    throw detailImportError('current.end cannot be before current.start.', 'current.end')
  }
  if (dateMs(baseline.end) < dateMs(baseline.start)) {
    throw detailImportError('baseline.end cannot be before baseline.start.', 'baseline.end')
  }
  const currentDays = inclusiveDays(current.start, current.end)
  const baselineDays = inclusiveDays(baseline.start, baseline.end)
  if (currentDays !== baselineDays) {
    throw detailImportError(`Current and previous periods must be the same length (${currentDays} vs ${baselineDays} days).`, 'baseline')
  }
  if (!ALLOWED_WINDOW_DAYS.includes(currentDays)) {
    throw detailImportError('Comparison window must be exactly 7 or 28 days.', 'current')
  }
  if (dateMs(baseline.end) >= dateMs(current.start)) {
    throw detailImportError('Previous period must end before the current period starts.', 'baseline.end')
  }
  if (dateMs(current.end) > dateMs(localCalendarDate(nowMs))) {
    throw detailImportError('Current period cannot end in the future.', 'current.end')
  }

  if (!Array.isArray(input.rows) || !input.rows.length) {
    throw detailImportError('At least one matched listing row is required.', 'rows')
  }
  if (input.rows.length > MAX_ROWS) {
    throw detailImportError(`At most ${MAX_ROWS.toLocaleString()} listing rows can be saved per import.`, 'rows')
  }

  const seen = new Set()
  const rows = input.rows.map((source, index) => {
    const prefix = `rows[${index}]`
    const listingId = normalizeListingId(source?.listing_id, `${prefix}.listing_id`)
    const title = normalizeTitle(source?.title, `${prefix}.title`)
    const rowKeySource = listingMatchKey(listingId, title)
    if (seen.has(rowKeySource)) {
      throw detailImportError(`Duplicate listing "${title}".`, prefix, 'DUPLICATE_GROWTH_LISTING')
    }
    seen.add(rowKeySource)
    const normalized = {
      row_key: crypto.createHash('sha256').update(rowKeySource).digest('hex').slice(0, 32),
      listing_id: listingId,
      title,
      current_views: normalizeCount(source?.current?.views, `${prefix}.current.views`, { required: true }),
      baseline_views: normalizeCount(source?.baseline?.views, `${prefix}.baseline.views`, { required: true }),
      current_favorites: normalizeCount(source?.current?.favorites, `${prefix}.current.favorites`),
      baseline_favorites: normalizeCount(source?.baseline?.favorites, `${prefix}.baseline.favorites`),
      current_orders: normalizeCount(source?.current?.orders, `${prefix}.current.orders`, { required: true }),
      baseline_orders: normalizeCount(source?.baseline?.orders, `${prefix}.baseline.orders`, { required: true }),
      current_revenue: normalizeMoney(source?.current?.revenue, `${prefix}.current.revenue`),
      baseline_revenue: normalizeMoney(source?.baseline?.revenue, `${prefix}.baseline.revenue`),
    }
    return normalized
  })

  const needsCurrency = rows.some((row) => row.current_revenue != null || row.baseline_revenue != null)
  const warnings = Array.isArray(input.warnings)
    ? input.warnings.map((warning) => String(warning).trim().slice(0, 500)).filter(Boolean).slice(0, 20)
    : []
  const expectedBaselineEnd = new Date(dateMs(current.start) - 86_400_000).toISOString().slice(0, 10)
  if (baseline.end !== expectedBaselineEnd) {
    warnings.push('The periods are equal length but not adjacent; external seasonality may affect the comparison.')
  }
  const importKey = String(input.import_key ?? '').trim() || crypto.randomUUID()
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(importKey)) {
    throw detailImportError('import_key is invalid.', 'import_key')
  }

  return {
    import_key: importKey,
    shop_id: shopId,
    window_days: currentDays,
    current,
    baseline,
    currency: normalizeCurrency(input.currency, needsCurrency),
    note: String(input.note ?? '').trim().slice(0, MAX_NOTE_CHARS) || null,
    warnings: [...new Set(warnings)],
    rows,
  }
}

function importTotals(rows) {
  const sum = (field) => rows.reduce((total, row) => total + (Number(row[field]) || 0), 0)
  const sumNullable = (field) => rows.some((row) => row[field] != null) ? sum(field) : null
  const sumMoney = (field) => {
    const total = sumNullable(field)
    return total == null ? null : Math.round(total * 100) / 100
  }
  return {
    current: {
      views: sum('current_views'),
      favorites: sumNullable('current_favorites'),
      orders: sum('current_orders'),
      revenue: sumMoney('current_revenue'),
    },
    baseline: {
      views: sum('baseline_views'),
      favorites: sumNullable('baseline_favorites'),
      orders: sum('baseline_orders'),
      revenue: sumMoney('baseline_revenue'),
    },
  }
}

function rowToListingDetailImport(db, row, { includeRows = true } = {}) {
  if (!row) return null
  const rows = includeRows
    ? db.prepare(
      `SELECT row_key, listing_id, title,
              current_views, baseline_views,
              current_favorites, baseline_favorites,
              current_orders, baseline_orders,
              current_revenue, baseline_revenue
       FROM growth_manual_listing_rows
       WHERE import_id = ?
       ORDER BY current_views DESC, title COLLATE NOCASE`
    ).all(row.id)
    : []
  let warnings = []
  try { warnings = JSON.parse(row.warnings_json || '[]') } catch { warnings = [] }
  return {
    id: row.id,
    import_key: row.import_key,
    shop_id: row.shop_id,
    shop_name: row.shop_name ?? null,
    window_days: row.window_days,
    current: { start: row.current_start, end: row.current_end },
    baseline: { start: row.baseline_start, end: row.baseline_end },
    currency: row.currency ?? null,
    note: row.note ?? null,
    warnings,
    imported_by: row.imported_by ?? null,
    imported_at: row.imported_at,
    imported_at_iso: row.imported_at ? new Date(row.imported_at * 1000).toISOString() : null,
    row_count: Number(row.row_count ?? rows.length),
    totals: includeRows ? importTotals(rows) : null,
    rows,
  }
}

function getListingDetailImportByKey(db, importKey, options) {
  const row = db.prepare(
    `SELECT i.*, s.shop_name,
            (SELECT COUNT(*) FROM growth_manual_listing_rows r WHERE r.import_id = i.id) AS row_count
     FROM growth_manual_listing_imports i
     JOIN shops s ON s.shop_id = i.shop_id
     WHERE i.import_key = ?`
  ).get(importKey)
  return rowToListingDetailImport(db, row, options)
}

function saveListingDetailImport(db, input, { importedBy = null, nowMs = Date.now() } = {}) {
  const normalized = normalizeListingDetailImport(input, { nowMs })
  const existing = getListingDetailImportByKey(db, normalized.import_key)
  if (existing) return { detail: existing, deduplicated: true }

  const shop = db.prepare('SELECT shop_id FROM shops WHERE shop_id = ?').get(normalized.shop_id)
  if (!shop) throw detailImportError('Shop was not found.', 'shop_id', 'GROWTH_SHOP_NOT_FOUND')

  const insert = db.transaction(() => {
    const result = db.prepare(
      `INSERT INTO growth_manual_listing_imports (
         import_key, shop_id, window_days,
         current_start, current_end, baseline_start, baseline_end,
         currency, note, warnings_json, imported_by
       ) VALUES (
         @import_key, @shop_id, @window_days,
         @current_start, @current_end, @baseline_start, @baseline_end,
         @currency, @note, @warnings_json, @imported_by
       )`
    ).run({
      import_key: normalized.import_key,
      shop_id: normalized.shop_id,
      window_days: normalized.window_days,
      current_start: normalized.current.start,
      current_end: normalized.current.end,
      baseline_start: normalized.baseline.start,
      baseline_end: normalized.baseline.end,
      currency: normalized.currency,
      note: normalized.note,
      warnings_json: JSON.stringify(normalized.warnings),
      imported_by: importedBy ? String(importedBy).slice(0, 128) : null,
    })
    const insertRow = db.prepare(
      `INSERT INTO growth_manual_listing_rows (
         import_id, row_key, listing_id, title,
         current_views, baseline_views,
         current_favorites, baseline_favorites,
         current_orders, baseline_orders,
         current_revenue, baseline_revenue
       ) VALUES (
         @import_id, @row_key, @listing_id, @title,
         @current_views, @baseline_views,
         @current_favorites, @baseline_favorites,
         @current_orders, @baseline_orders,
         @current_revenue, @baseline_revenue
       )`
    )
    for (const row of normalized.rows) insertRow.run({ import_id: result.lastInsertRowid, ...row })
    return result.lastInsertRowid
  })

  let id
  try {
    id = insert()
  } catch (err) {
    if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      const duplicate = getListingDetailImportByKey(db, normalized.import_key)
      if (duplicate) return { detail: duplicate, deduplicated: true }
    }
    throw err
  }
  const detail = rowToListingDetailImport(db, db.prepare(
    `SELECT i.*, s.shop_name,
            (SELECT COUNT(*) FROM growth_manual_listing_rows r WHERE r.import_id = i.id) AS row_count
     FROM growth_manual_listing_imports i
     JOIN shops s ON s.shop_id = i.shop_id
     WHERE i.id = ?`
  ).get(id))
  return { detail, deduplicated: false }
}

function listListingDetailImports(db, { shopId = null, limit = 25, includeRows = false } = {}) {
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 25))
  const rows = shopId
    ? db.prepare(
      `SELECT i.*, s.shop_name,
              (SELECT COUNT(*) FROM growth_manual_listing_rows r WHERE r.import_id = i.id) AS row_count
       FROM growth_manual_listing_imports i
       JOIN shops s ON s.shop_id = i.shop_id
       WHERE i.shop_id = ?
       ORDER BY i.imported_at DESC, i.id DESC
       LIMIT ?`
    ).all(shopId, safeLimit)
    : db.prepare(
      `SELECT i.*, s.shop_name,
              (SELECT COUNT(*) FROM growth_manual_listing_rows r WHERE r.import_id = i.id) AS row_count
       FROM growth_manual_listing_imports i
       JOIN shops s ON s.shop_id = i.shop_id
       ORDER BY i.imported_at DESC, i.id DESC
       LIMIT ?`
    ).all(safeLimit)
  return rows.map((row) => rowToListingDetailImport(db, row, { includeRows }))
}

function latestListingDetailImports(db, { windowDays = null, shopId = null } = {}) {
  const conditions = []
  const params = {}
  if (windowDays != null) {
    conditions.push('i.window_days = @window_days')
    params.window_days = Number(windowDays)
  }
  if (shopId) {
    conditions.push('i.shop_id = @shop_id')
    params.shop_id = String(shopId)
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const rows = db.prepare(
    `SELECT i.*, s.shop_name,
            (SELECT COUNT(*) FROM growth_manual_listing_rows r WHERE r.import_id = i.id) AS row_count
     FROM growth_manual_listing_imports i
     JOIN shops s ON s.shop_id = i.shop_id
     JOIN (
       SELECT i.shop_id, MAX(i.id) AS max_id
       FROM growth_manual_listing_imports i
       ${where}
       GROUP BY i.shop_id
     ) latest ON latest.max_id = i.id
     ORDER BY s.shop_name`
  ).all(params)
  return new Map(rows.map((row) => [row.shop_id, rowToListingDetailImport(db, row)]))
}

function deleteListingDetailImport(db, id) {
  const numericId = Number(id)
  if (!Number.isInteger(numericId) || numericId <= 0) {
    throw detailImportError('Import id must be a positive integer.', 'id')
  }
  const result = db.prepare('DELETE FROM growth_manual_listing_imports WHERE id = ?').run(numericId)
  return result.changes === 1
}

function percentChange(current, baseline) {
  if (baseline === 0) return current === 0 ? 0 : null
  return Math.round(((current - baseline) / baseline) * 10_000) / 100
}

function conversionProxy(orders, views) {
  if (!views) return null
  return Math.round((orders / views) * 10_000) / 100
}

function buildListingDetailInsights(detail) {
  if (!detail?.rows?.length) return null
  const evidenceFloor = detail.window_days === 7 ? 10 : 20
  const rows = detail.rows.map((row) => {
    const currentConversion = conversionProxy(row.current_orders, row.current_views)
    const baselineConversion = conversionProxy(row.baseline_orders, row.baseline_views)
    return {
      listing_id: row.listing_id,
      title: row.title,
      current: {
        views: row.current_views,
        favorites: row.current_favorites,
        orders: row.current_orders,
        revenue: row.current_revenue,
        conversion_proxy: currentConversion,
      },
      baseline: {
        views: row.baseline_views,
        favorites: row.baseline_favorites,
        orders: row.baseline_orders,
        revenue: row.baseline_revenue,
        conversion_proxy: baselineConversion,
      },
      changes: {
        views_pct: percentChange(row.current_views, row.baseline_views),
        favorites_pct: row.current_favorites == null || row.baseline_favorites == null
          ? null
          : percentChange(row.current_favorites, row.baseline_favorites),
        orders_pct: percentChange(row.current_orders, row.baseline_orders),
        revenue_pct: row.current_revenue == null || row.baseline_revenue == null
          ? null
          : percentChange(row.current_revenue, row.baseline_revenue),
        conversion_points: currentConversion == null || baselineConversion == null
          ? null
          : Math.round((currentConversion - baselineConversion) * 100) / 100,
      },
    }
  })

  const byViews = (a, b) => b.current.views - a.current.views || a.title.localeCompare(b.title)
  const candidates = {
    conversion_fixes: rows
      .filter((row) => row.current.views >= evidenceFloor && row.current.orders === 0)
      .sort(byViews),
    traffic_losses: rows
      .filter((row) => row.baseline.views >= evidenceFloor && row.current.views <= row.baseline.views * 0.7)
      .sort((a, b) => (a.changes.views_pct ?? 0) - (b.changes.views_pct ?? 0)),
    winners: rows
      .filter((row) => row.current.orders > 0 && (
        row.current.orders > row.baseline.orders ||
        (row.current.revenue != null && row.baseline.revenue != null && row.current.revenue > row.baseline.revenue)
      ))
      .sort((a, b) => b.current.orders - a.current.orders || byViews(a, b)),
    interest_not_sales: rows
      .filter((row) => (
        row.current.favorites != null &&
        row.baseline.favorites != null &&
        row.current.favorites > row.baseline.favorites &&
        row.current.orders <= row.baseline.orders
      ))
      .sort((a, b) => (b.current.favorites - b.baseline.favorites) - (a.current.favorites - a.baseline.favorites)),
    no_traction: rows
      .filter((row) => row.current.views < 3 && row.baseline.views < 3)
      .sort((a, b) => a.current.views - b.current.views || a.title.localeCompare(b.title)),
  }
  const groupCounts = Object.fromEntries(Object.entries(candidates).map(([key, values]) => [key, values.length]))
  const groups = Object.fromEntries(Object.entries(candidates).map(([key, values]) => [key, values.slice(0, 20)]))

  return {
    source: 'manual_listing_stats',
    zero_api_calls: true,
    import: {
      id: detail.id,
      shop_id: detail.shop_id,
      shop_name: detail.shop_name,
      window_days: detail.window_days,
      current: detail.current,
      baseline: detail.baseline,
      currency: detail.currency,
      imported_at_iso: detail.imported_at_iso,
      row_count: detail.row_count,
      warnings: detail.warnings,
    },
    totals: detail.totals,
    evidence_floor_views: evidenceFloor,
    group_counts: groupCounts,
    groups,
  }
}

module.exports = {
  parsePastedListingStats,
  normalizeListingDetailImport,
  saveListingDetailImport,
  listListingDetailImports,
  latestListingDetailImports,
  deleteListingDetailImport,
  buildListingDetailInsights,
  MAX_PASTE_CHARS,
  MAX_ROWS,
  ALLOWED_WINDOW_DAYS,
}
