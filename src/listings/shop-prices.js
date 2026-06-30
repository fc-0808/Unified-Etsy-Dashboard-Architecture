'use strict';

/**
 * Derive a shop's CURRENT per-style prices from the locally-cached inventory of
 * its existing live listings (the `listing_inventory` table the sync worker
 * keeps fresh). These become the default variation prices for new bulk listings
 * so they match what the shop already charges — no spreadsheet guesswork.
 *
 * The cached offerings carry the full property_values JSON, including the
 * "Styles" custom property (id 514) whose value (e.g. "Case+Charm") maps 1:1 to
 * our internal style keys. Prices are aggregated per style with a median (robust
 * to the odd outlier / mispriced listing).
 */

const { STYLE_KEYS, normaliseStyleLabel } = require('./pricing');

const PROP_STYLES = 514;

function median(nums) {
  if (!nums.length) return null;
  const s = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Extract the Styles label from a cached offering's property_values JSON. */
function styleKeyFromProps(propsJson) {
  let props;
  try { props = JSON.parse(propsJson || '[]'); } catch { return null; }
  if (!Array.isArray(props)) return null;
  const styleProp =
    props.find((p) => p.property_id === PROP_STYLES) ||
    props.find((p) => p.property_name && /^styles?$/i.test(p.property_name));
  const label = styleProp?.values?.[0];
  return label ? normaliseStyleLabel(label) : null;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} shopId   config/listings shop_id (e.g. "Y2KASEofficial")
 * @returns {{ prices: Record<string,number>, counts: Record<string,number>,
 *             currency: string|null, listingCount: number, hasData: boolean }}
 */
function getShopCurrentStylePrices(db, shopId) {
  const empty = { prices: {}, counts: {}, currency: null, listingCount: 0, hasData: false };
  if (!db || !shopId) return empty;

  let rows = [];
  try {
    rows = db.prepare(`
      SELECT li.price_amount, li.price_currency, li.property_values, li.listing_id
      FROM listing_inventory li
      JOIN listings l ON l.listing_id = li.listing_id
      WHERE l.shop_id = ?
        AND li.is_enabled = 1
        AND li.price_amount IS NOT NULL
        AND li.price_amount > 0
    `).all(shopId);
  } catch {
    return empty;
  }
  if (!rows.length) return empty;

  const buckets = {};          // styleKey → number[]
  const currencyTally = {};    // currency → count
  const listingSet = new Set();
  for (const r of rows) {
    const key = styleKeyFromProps(r.property_values);
    if (!key || !STYLE_KEYS.includes(key)) continue;
    (buckets[key] ||= []).push(Number(r.price_amount));
    if (r.price_currency) currencyTally[r.price_currency] = (currencyTally[r.price_currency] || 0) + 1;
    listingSet.add(r.listing_id);
  }

  const prices = {};
  const counts = {};
  for (const key of STYLE_KEYS) {
    if (buckets[key] && buckets[key].length) {
      const m = median(buckets[key]);
      if (Number.isFinite(m) && m > 0) {
        prices[key] = Math.round(m * 100) / 100;
        counts[key] = buckets[key].length;
      }
    }
  }

  const currency = Object.entries(currencyTally).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  return {
    prices,
    counts,
    currency,
    listingCount: listingSet.size,
    hasData: Object.keys(prices).length > 0,
  };
}

/**
 * Resolve the default per-style prices for a new bulk run: the shop's current
 * prices take precedence, with the 4-currency master sheet filling any style the
 * shop doesn't currently sell. Returns the merged map + provenance for the UI.
 *
 * @param {object} args
 * @param {import('better-sqlite3').Database} args.db
 * @param {string} args.shopId
 * @param {Record<string,number>} [args.sheetPrices]  fallback (spreadsheet) prices
 * @returns {{ prices:Record<string,number>, source:Record<string,'shop'|'sheet'>, shop:object }}
 */
function resolveDefaultPrices({ db, shopId, sheetPrices = {} }) {
  const shop = getShopCurrentStylePrices(db, shopId);
  const prices = {};
  const source = {};
  for (const key of STYLE_KEYS) {
    if (Number.isFinite(shop.prices[key])) { prices[key] = shop.prices[key]; source[key] = 'shop'; }
    else if (Number.isFinite(sheetPrices[key])) { prices[key] = sheetPrices[key]; source[key] = 'sheet'; }
  }
  return { prices, source, shop };
}

module.exports = { getShopCurrentStylePrices, resolveDefaultPrices, styleKeyFromProps };
