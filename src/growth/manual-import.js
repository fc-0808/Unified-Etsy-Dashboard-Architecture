'use strict'

/**
 * Local-only Etsy Stats import.
 *
 * The Growth tab deliberately accepts a small, explicit comparison instead of
 * scraping Shop Manager or silently querying Etsy. Pasted text is parsed in
 * memory and is never persisted; only the normalized aggregate metrics below
 * are stored. No buyer, order, listing, or customer identifiers are accepted.
 */

const crypto = require('crypto')

const MAX_PASTE_CHARS = 20_000
const MAX_NOTE_CHARS = 500
const ALLOWED_WINDOW_DAYS = Object.freeze([7, 28])
const MAX_COUNT = 1_000_000_000
const MAX_MONEY = 1_000_000_000_000

const PERIOD_FIELDS = Object.freeze([
  'visits',
  'views',
  'orders',
  'revenue',
  'conversion_rate',
  'favorites',
  'ad_spend',
  'ad_orders',
])

const FIELD_ALIASES = Object.freeze({
  start: ['start', 'start date', 'from', '开始', '开始日期', '起始日期'],
  end: ['end', 'end date', 'to', '结束', '结束日期', '截止日期'],
  visits: ['visits', 'visit', '访客', '访问', '访问量'],
  views: ['views', 'listing views', 'view', '浏览', '浏览量'],
  orders: ['orders', 'order', '订单', '订单数'],
  revenue: ['revenue', 'sales', 'sales revenue', '销售额', '收入', '营收'],
  conversion_rate: ['conversion rate', 'conversion', '转化率'],
  favorites: ['favorites', 'favourites', 'favorite', 'favourite', '收藏', '收藏数'],
  ad_spend: ['ad spend', 'ads spend', 'advertising spend', 'marketing spend', '广告花费', '广告支出'],
  ad_orders: ['ad orders', 'orders from ads', 'advertising orders', '广告订单', '广告订单数'],
  currency: ['currency', '币种', '货币'],
  review_average: ['rating', 'review average', 'average rating', '评分', '平均评分'],
  review_count: ['review count', 'reviews', '评价数', '评论数'],
  listing_active_count: ['active listings', 'active listing count', '在售商品', '活跃商品数'],
  listing_expired_count: ['expired listings', 'expired listing count', '过期商品', '过期商品数'],
  listing_sold_out_count: ['sold out listings', 'sold-out listings', '售罄商品', '售罄商品数'],
  is_vacation: ['vacation mode', 'on vacation', '假期模式'],
})

const SECTION_ALIASES = Object.freeze({
  current: ['current', 'current period', 'this period', '本期', '当前', '当前周期'],
  baseline: ['previous', 'previous period', 'prior', 'prior period', 'baseline', '上期', '上一期', '前期'],
  health: ['health', 'shop health', 'current shop health', '店铺状态', '店铺健康'],
})

function importError(message, field, code = 'INVALID_GROWTH_IMPORT') {
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
    .replace(/[：:_-]+/g, ' ')
    .replace(/\s+/g, ' ')
}

function parseIsoDate(value, field) {
  const text = String(value ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw importError(`${field} must use YYYY-MM-DD.`, field)
  }
  const ms = Date.parse(`${text}T00:00:00Z`)
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== text) {
    throw importError(`${field} is not a real calendar date.`, field)
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
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
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
  const n = Number(text)
  if (!Number.isFinite(n)) return NaN
  return negativeParens ? -Math.abs(n) : n
}

function optionalCount(value, field) {
  const n = cleanNumericText(value)
  if (n == null) return null
  if (!Number.isInteger(n) || n < 0 || n > MAX_COUNT) {
    throw importError(`${field} must be a whole number from 0 to ${MAX_COUNT.toLocaleString()}.`, field)
  }
  return n
}

function requiredCount(value, field) {
  const n = optionalCount(value, field)
  if (n == null) throw importError(`${field} is required.`, field)
  return n
}

function optionalMoney(value, field) {
  const n = cleanNumericText(value)
  if (n == null) return null
  if (!Number.isFinite(n) || n < 0 || n > MAX_MONEY) {
    throw importError(`${field} must be a non-negative amount.`, field)
  }
  return Math.round(n * 100) / 100
}

function optionalRate(value, field) {
  const n = cleanNumericText(value)
  if (n == null) return null
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    throw importError(`${field} must be between 0 and 100.`, field)
  }
  return Math.round(n * 100) / 100
}

function optionalBoolean(value, field) {
  if (value == null || value === '') return null
  if (typeof value === 'boolean') return value
  if (value === 1 || value === 0) return value === 1
  const text = normalizeLabel(value)
  if (['yes', 'true', 'on', 'enabled', '1', '是', '开启', '已开启'].includes(text)) return true
  if (['no', 'false', 'off', 'disabled', '0', '否', '关闭', '未开启'].includes(text)) return false
  throw importError(`${field} must be yes or no.`, field)
}

function normalizeCurrency(value, needsCurrency) {
  const raw = String(value ?? '').trim().toUpperCase()
  const aliases = { 'HK$': 'HKD', RMB: 'CNY', 'CN¥': 'CNY', 'US$': 'USD', 'CA$': 'CAD', 'AU$': 'AUD', '£': 'GBP', '€': 'EUR' }
  const currency = aliases[raw] || raw
  if (!currency) {
    if (needsCurrency) throw importError('currency is required when revenue or ad spend is entered.', 'currency')
    return null
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw importError('currency must be a three-letter ISO code such as HKD, USD, or CNY.', 'currency')
  }
  return currency
}

function normalizePeriod(raw, role) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const period = {
    start: parseIsoDate(source.start, `${role}.start`),
    end: parseIsoDate(source.end, `${role}.end`),
    visits: optionalCount(source.visits, `${role}.visits`),
    views: optionalCount(source.views, `${role}.views`),
    orders: requiredCount(source.orders, `${role}.orders`),
    revenue: optionalMoney(source.revenue, `${role}.revenue`),
    conversion_rate: optionalRate(source.conversion_rate, `${role}.conversion_rate`),
    favorites: optionalCount(source.favorites, `${role}.favorites`),
    ad_spend: optionalMoney(source.ad_spend, `${role}.ad_spend`),
    ad_orders: optionalCount(source.ad_orders, `${role}.ad_orders`),
  }
  if (dateMs(period.end) < dateMs(period.start)) {
    throw importError(`${role}.end cannot be before ${role}.start.`, `${role}.end`)
  }
  if (period.visits == null && period.views == null) {
    throw importError(`${role} needs visits or views so traffic can be compared.`, `${role}.visits`)
  }
  if (period.conversion_rate == null && period.visits > 0) {
    period.conversion_rate = Math.round((period.orders / period.visits) * 10_000) / 100
  }
  return period
}

function normalizeManualComparison(input, { nowMs = Date.now() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw importError('Manual stats payload must be an object.')
  }
  const shopId = String(input.shop_id ?? '').trim()
  if (!shopId || shopId.length > 128) throw importError('shop_id is required.', 'shop_id')

  const current = normalizePeriod(input.current, 'current')
  const baseline = normalizePeriod(input.baseline, 'baseline')
  const currentDays = inclusiveDays(current.start, current.end)
  const baselineDays = inclusiveDays(baseline.start, baseline.end)
  const comparableTraffic =
    (current.visits != null && baseline.visits != null) ||
    (current.views != null && baseline.views != null)
  if (!comparableTraffic) {
    throw importError('Use the same traffic metric (visits or views) in both periods.', 'baseline.visits')
  }
  if (currentDays !== baselineDays) {
    throw importError(`Current and previous periods must be the same length (${currentDays} vs ${baselineDays} days).`, 'baseline')
  }
  if (!ALLOWED_WINDOW_DAYS.includes(currentDays)) {
    throw importError('Comparison window must be exactly 7 or 28 days to match the Growth report.', 'current')
  }
  if (dateMs(baseline.end) >= dateMs(current.start)) {
    throw importError('Previous period must end before the current period starts.', 'baseline.end')
  }
  // The dashboard and Etsy Shop Manager are operated on this workstation.
  // Compare against its local calendar day, not UTC, so a Hong Kong morning
  // does not reject "today" as one day in the future.
  const today = localCalendarDate(nowMs)
  if (dateMs(current.end) > dateMs(today)) {
    throw importError('Current period cannot end in the future.', 'current.end')
  }

  const healthInput = input.health && typeof input.health === 'object' ? input.health : {}
  const health = {
    review_average: optionalRate(healthInput.review_average, 'health.review_average'),
    review_count: optionalCount(healthInput.review_count, 'health.review_count'),
    listing_active_count: optionalCount(healthInput.listing_active_count, 'health.listing_active_count'),
    listing_expired_count: optionalCount(healthInput.listing_expired_count, 'health.listing_expired_count'),
    listing_sold_out_count: optionalCount(healthInput.listing_sold_out_count, 'health.listing_sold_out_count'),
    is_vacation: optionalBoolean(healthInput.is_vacation, 'health.is_vacation'),
  }
  if (health.review_average != null && health.review_average > 5) {
    throw importError('health.review_average must be between 0 and 5.', 'health.review_average')
  }

  const warnings = []
  const expectedBaselineEnd = new Date(dateMs(current.start) - 86_400_000).toISOString().slice(0, 10)
  if (baseline.end !== expectedBaselineEnd) {
    warnings.push('The periods are equal length but not adjacent; external seasonality may affect the comparison.')
  }
  for (const [role, period] of [['current', current], ['baseline', baseline]]) {
    if (period.visits > 0 && period.conversion_rate != null) {
      const derived = Math.round((period.orders / period.visits) * 10_000) / 100
      if (Math.abs(derived - period.conversion_rate) > 0.25) {
        warnings.push(`${role} conversion rate differs from orders ÷ visits (${derived}%). Etsy may be using a different attribution window.`)
      }
    }
  }

  const needsCurrency = [current.revenue, baseline.revenue, current.ad_spend, baseline.ad_spend].some((v) => v != null)
  const note = String(input.note ?? '').trim().slice(0, MAX_NOTE_CHARS) || null
  const importKeyRaw = String(input.import_key ?? '').trim()
  const importKey = importKeyRaw || crypto.randomUUID()
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(importKey)) {
    throw importError('import_key is invalid.', 'import_key')
  }

  return {
    import_key: importKey,
    shop_id: shopId,
    window_days: currentDays,
    current,
    baseline,
    currency: normalizeCurrency(input.currency, needsCurrency),
    health,
    note,
    warnings,
  }
}

function rowToComparison(row) {
  if (!row) return null
  const period = (prefix) => Object.fromEntries(PERIOD_FIELDS.map((field) => [field, row[`${prefix}_${field}`] ?? null]))
  return {
    id: row.id,
    import_key: row.import_key,
    shop_id: row.shop_id,
    shop_name: row.shop_name ?? null,
    window_days: row.window_days,
    current: { start: row.current_start, end: row.current_end, ...period('current') },
    baseline: { start: row.baseline_start, end: row.baseline_end, ...period('baseline') },
    currency: row.currency ?? null,
    health: {
      review_average: row.review_average ?? null,
      review_count: row.review_count ?? null,
      listing_active_count: row.listing_active_count ?? null,
      listing_expired_count: row.listing_expired_count ?? null,
      listing_sold_out_count: row.listing_sold_out_count ?? null,
      is_vacation: row.is_vacation == null ? null : row.is_vacation === 1,
    },
    note: row.note ?? null,
    warnings: (() => {
      try { return JSON.parse(row.quality_warnings || '[]') }
      catch { return [] }
    })(),
    imported_by: row.imported_by ?? null,
    imported_at: row.imported_at,
    imported_at_iso: row.imported_at ? new Date(row.imported_at * 1000).toISOString() : null,
  }
}

function saveManualComparison(db, input, { importedBy = null, nowMs = Date.now() } = {}) {
  const normalized = normalizeManualComparison(input, { nowMs })
  const existing = db.prepare(
    `SELECT m.*, s.shop_name
     FROM growth_manual_comparisons m
     JOIN shops s ON s.shop_id = m.shop_id
     WHERE m.import_key = ?`
  ).get(normalized.import_key)
  if (existing) return { comparison: rowToComparison(existing), deduplicated: true }

  const shop = db.prepare('SELECT shop_id FROM shops WHERE shop_id = ?').get(normalized.shop_id)
  if (!shop) throw importError('Shop was not found.', 'shop_id', 'GROWTH_SHOP_NOT_FOUND')

  const row = {
    import_key: normalized.import_key,
    shop_id: normalized.shop_id,
    window_days: normalized.window_days,
    current_start: normalized.current.start,
    current_end: normalized.current.end,
    baseline_start: normalized.baseline.start,
    baseline_end: normalized.baseline.end,
    currency: normalized.currency,
    review_average: normalized.health.review_average,
    review_count: normalized.health.review_count,
    listing_active_count: normalized.health.listing_active_count,
    listing_expired_count: normalized.health.listing_expired_count,
    listing_sold_out_count: normalized.health.listing_sold_out_count,
    is_vacation: normalized.health.is_vacation == null ? null : normalized.health.is_vacation ? 1 : 0,
    note: normalized.note,
    quality_warnings: JSON.stringify(normalized.warnings),
    imported_by: importedBy ? String(importedBy).slice(0, 128) : null,
  }
  for (const role of ['current', 'baseline']) {
    for (const field of PERIOD_FIELDS) row[`${role}_${field}`] = normalized[role][field]
  }

  const columns = Object.keys(row)
  const sql = `
    INSERT INTO growth_manual_comparisons (${columns.join(', ')})
    VALUES (${columns.map((key) => `@${key}`).join(', ')})
  `
  let result
  try {
    result = db.prepare(sql).run(row)
  } catch (err) {
    if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      const duplicate = db.prepare(
        `SELECT m.*, s.shop_name
         FROM growth_manual_comparisons m
         JOIN shops s ON s.shop_id = m.shop_id
         WHERE m.import_key = ?`
      ).get(normalized.import_key)
      if (duplicate) return { comparison: rowToComparison(duplicate), deduplicated: true }
    }
    throw err
  }
  const inserted = db.prepare(
    `SELECT m.*, s.shop_name
     FROM growth_manual_comparisons m
     JOIN shops s ON s.shop_id = m.shop_id
     WHERE m.id = ?`
  ).get(result.lastInsertRowid)
  return { comparison: rowToComparison(inserted), deduplicated: false }
}

function listManualComparisons(db, { shopId = null, limit = 50 } = {}) {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50))
  const rows = shopId
    ? db.prepare(
        `SELECT m.*, s.shop_name
         FROM growth_manual_comparisons m
         JOIN shops s ON s.shop_id = m.shop_id
         WHERE m.shop_id = ?
         ORDER BY m.imported_at DESC, m.id DESC
         LIMIT ?`
      ).all(shopId, safeLimit)
    : db.prepare(
        `SELECT m.*, s.shop_name
         FROM growth_manual_comparisons m
         JOIN shops s ON s.shop_id = m.shop_id
         ORDER BY m.imported_at DESC, m.id DESC
         LIMIT ?`
      ).all(safeLimit)
  return rows.map(rowToComparison)
}

function latestManualComparisons(db, { windowDays = null, shopId = null } = {}) {
  const conditions = []
  const params = {}
  if (windowDays != null) {
    conditions.push('m.window_days = @window_days')
    params.window_days = Number(windowDays)
  }
  if (shopId) {
    conditions.push('m.shop_id = @shop_id')
    params.shop_id = shopId
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const rows = db.prepare(
    `SELECT m.*, s.shop_name
     FROM growth_manual_comparisons m
     JOIN shops s ON s.shop_id = m.shop_id
     JOIN (
       SELECT m.shop_id, MAX(m.id) AS max_id
       FROM growth_manual_comparisons m
       ${where}
       GROUP BY m.shop_id
     ) latest ON latest.max_id = m.id
     ORDER BY s.shop_name`
  ).all(params)
  return new Map(rows.map((row) => [row.shop_id, rowToComparison(row)]))
}

function deleteManualComparison(db, id) {
  const numericId = Number(id)
  if (!Number.isInteger(numericId) || numericId <= 0) {
    throw importError('Import id must be a positive integer.', 'id')
  }
  const result = db.prepare('DELETE FROM growth_manual_comparisons WHERE id = ?').run(numericId)
  return result.changes === 1
}

function matchSection(line) {
  const normalized = normalizeLabel(line).replace(/[.]+$/, '')
  for (const [section, aliases] of Object.entries(SECTION_ALIASES)) {
    if (aliases.includes(normalized)) return section
  }
  return null
}

function splitLabelAndValue(line) {
  const explicit = String(line).match(/^\s*([^:\t：=]+?)\s*[:\t：=]\s*(.*?)\s*$/)
  if (explicit) return [normalizeLabel(explicit[1]), explicit[2].trim()]
  const normalized = normalizeLabel(line)
  const aliases = Object.entries(FIELD_ALIASES)
    .flatMap(([field, values]) => values.map((alias) => [field, normalizeLabel(alias)]))
    .sort((a, b) => b[1].length - a[1].length)
  for (const [, alias] of aliases) {
    if (normalized === alias) return [alias, '']
    if (normalized.startsWith(`${alias} `)) {
      const raw = String(line).trim()
      return [alias, raw.slice(raw.toLowerCase().indexOf(alias) + alias.length).trim()]
    }
  }
  return [null, null]
}

function canonicalField(label) {
  const normalized = normalizeLabel(label)
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    if (aliases.map(normalizeLabel).includes(normalized)) return field
  }
  return null
}

function parseTabularText(lines) {
  if (lines.length < 3 || !lines[0].includes('\t')) return null
  const headers = lines[0].split('\t').map((value) => canonicalField(value) || normalizeLabel(value))
  const periodIndex = headers.findIndex((value) => ['period', '时期', '周期'].includes(value))
  if (periodIndex < 0) return null
  const output = { current: {}, baseline: {}, health: {} }
  let recognized = 0
  for (const line of lines.slice(1)) {
    const cells = line.split('\t')
    const role = matchSection(cells[periodIndex])
    if (role !== 'current' && role !== 'baseline') continue
    headers.forEach((field, index) => {
      if (['start', 'end', ...PERIOD_FIELDS].includes(field) && cells[index] != null && cells[index].trim()) {
        output[role][field] = cells[index].trim()
        recognized += 1
      } else if (field === 'currency' && cells[index]?.trim()) {
        output.currency = cells[index].trim()
        recognized += 1
      }
    })
  }
  return recognized ? { ...output, recognized_fields: recognized, warnings: [] } : null
}

function parsePastedStatsText(text) {
  const raw = String(text ?? '').trim()
  if (!raw) throw importError('Paste Etsy Stats text first.', 'text', 'EMPTY_GROWTH_PASTE')
  if (raw.length > MAX_PASTE_CHARS) {
    throw importError(`Pasted text is too large (maximum ${MAX_PASTE_CHARS.toLocaleString()} characters).`, 'text')
  }
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw)
      return { ...parsed, recognized_fields: Object.keys(parsed).length, warnings: [] }
    } catch {
      throw importError('The pasted JSON is invalid.', 'text')
    }
  }

  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const tabular = parseTabularText(lines)
  if (tabular) return tabular

  const output = { current: {}, baseline: {}, health: {} }
  const warnings = []
  let section = null
  let recognized = 0
  for (const line of lines) {
    const nextSection = matchSection(line.replace(/[:：]\s*$/, ''))
    if (nextSection) {
      section = nextSection
      continue
    }
    if ((section === 'current' || section === 'baseline')) {
      const dates = [...line.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)].map((match) => match[1])
      if (dates.length >= 2) {
        output[section].start = dates[0]
        output[section].end = dates[1]
        recognized += 2
        continue
      }
    }
    const [label, value] = splitLabelAndValue(line)
    const field = canonicalField(label)
    if (!field || value == null || value === '') continue
    if (field === 'currency') {
      output.currency = value
      recognized += 1
    } else if (['review_average', 'review_count', 'listing_active_count', 'listing_expired_count', 'listing_sold_out_count', 'is_vacation'].includes(field)) {
      output.health[field] = value
      recognized += 1
    } else if (section === 'current' || section === 'baseline') {
      output[section][field] = value
      recognized += 1
    }
  }
  if (!recognized) {
    throw importError('No supported fields were recognized. Use the template shown in the import panel.', 'text', 'UNRECOGNIZED_GROWTH_PASTE')
  }
  if (!Object.keys(output.current).length || !Object.keys(output.baseline).length) {
    warnings.push('Include CURRENT and PREVIOUS sections so UED can make a like-for-like comparison.')
  }
  return { ...output, recognized_fields: recognized, warnings }
}

module.exports = {
  normalizeManualComparison,
  parsePastedStatsText,
  saveManualComparison,
  listManualComparisons,
  latestManualComparisons,
  deleteManualComparison,
  rowToComparison,
  MAX_PASTE_CHARS,
  ALLOWED_WINDOW_DAYS,
}
