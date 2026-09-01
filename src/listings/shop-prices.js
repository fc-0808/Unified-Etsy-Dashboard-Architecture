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

const { normaliseStyleLabel } = require('./pricing');
const productTypes = require('./product-types');

function median(nums) {
  if (!nums.length) return null;
  const s = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Extract the priced-axis label from a cached offering's property_values JSON
 * and resolve it to `productType`'s style key.
 *
 * The priced axis is always Etsy custom property 514, but its NAME differs per
 * product line ("Styles" for a case, "Band Size" for a watch band), so the id
 * is matched first and the name only as a legacy fallback. Resolution is scoped
 * to the product type, which is what stops a shop that sells both lines from
 * pricing one line's variations off the other's listings.
 */
function styleKeyFromProps(propsJson, productType) {
  let props;
  try { props = JSON.parse(propsJson || '[]'); } catch { return null; }
  if (!Array.isArray(props)) return null;
  const propId = productTypes.stylePropertyFor(productType).id;
  const styleProp =
    props.find((p) => p.property_id === propId) ||
    props.find((p) => p.property_name && /^styles?$/i.test(p.property_name));
  const label = styleProp?.values?.[0];
  return label ? normaliseStyleLabel(label, productType) : null;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} shopId   config/listings shop_id (e.g. "Y2KASEofficial")
 * @param {string|object} [productType]  defaults to the iPhone case line
 * @returns {{ prices: Record<string,number>, counts: Record<string,number>,
 *             currency: string|null, listingCount: number, hasData: boolean }}
 */
function getShopCurrentStylePrices(db, shopId, productType) {
  const STYLE_KEYS = productTypes.styleKeysFor(productType);
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
    const key = styleKeyFromProps(r.property_values, productType);
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
 * Resolve the default per-style prices for a new bulk run.
 *
 * For a line priced from the 4-currency master sheet (the cases) the shop's own
 * current prices win: they are the most accurate statement of what this shop
 * actually charges, and the sheet only fills the gaps.
 *
 * For a line that carries its OWN price book on its descriptor (the Apple Watch
 * band) the book wins instead. That price is an explicit, curated decision
 * rather than a median inferred from whatever happens to be listed, so it must
 * not drift as old listings are repriced. Either way the operator can override
 * any value in the Variation Prices card before the run.
 *
 * Finally, any style the product type LINKS to another (e.g. an iPhone case's
 * "Grip Only" is declared to always match "Case Only" — see `priceLinksFor`)
 * is snapped to its anchor's just-resolved value, overriding whatever its own
 * shop/sheet lookup found. This runs last so it always reflects the anchor's
 * final price, from whichever source won it.
 *
 * @param {object} args
 * @param {import('better-sqlite3').Database} args.db
 * @param {string} args.shopId
 * @param {Record<string,number>} [args.sheetPrices]  fallback (spreadsheet / price-book) prices
 * @param {string|object} [args.productType]          defaults to the iPhone case line
 * @returns {{ prices:Record<string,number>, source:Record<string,'shop'|'sheet'>, shop:object }}
 */
function resolveDefaultPrices({ db, shopId, sheetPrices = {}, productType }) {
  const shop = getShopCurrentStylePrices(db, shopId, productType);
  const bookWins = productTypes.hasOwnPriceBook(productType);
  const prices = {};
  const source = {};
  for (const key of productTypes.styleKeysFor(productType)) {
    const sheet = Number.isFinite(sheetPrices[key]) ? sheetPrices[key] : null;
    const own = Number.isFinite(shop.prices[key]) ? shop.prices[key] : null;
    const useSheet = bookWins ? sheet != null : own == null;
    const value = useSheet ? sheet : own;
    if (value == null) continue;
    prices[key] = value;
    source[key] = useSheet ? 'sheet' : 'shop';
  }

  for (const [dependent, anchor] of Object.entries(productTypes.priceLinksFor(productType))) {
    if (prices[anchor] == null) continue; // anchor unresolved — leave the dependent as-is rather than blanking it
    prices[dependent] = prices[anchor];
    source[dependent] = source[anchor];
  }

  return { prices, source, shop };
}

module.exports = { getShopCurrentStylePrices, resolveDefaultPrices, styleKeyFromProps };
