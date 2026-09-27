'use strict';

/**
 * Per-shop User-Agent for requests a third party attributes to an application.
 *
 * The product token is derived from shop_id, so every current shop and any shop
 * added later sends a distinct program name. Recipients do not see one shared
 * dashboard identity for every shop.
 */

const crypto = require('crypto');

const APP_VERSION = (() => {
  try { return require('../../package.json').version || '0.0.0'; }
  catch { return '0.0.0'; }
})();

/**
 * Stable User-Agent for one shop. The same shop_id always produces the same
 * string; two different shop ids never collapse into one token.
 *
 * @param {string|number} shopId
 * @returns {string}
 */
function shopUserAgent(shopId) {
  if (shopId == null) {
    throw new Error('A shop id is required to build a unique User-Agent.');
  }
  const raw = String(shopId).trim();
  if (!raw || /[\u0000-\u001F\u007F]/.test(raw)) {
    throw new Error('A shop id is required to build a unique User-Agent.');
  }
  const slug = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  const product = slug === raw
    ? slug
    : `${slug || 'shop'}-${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 8)}`;
  return `${product}/${APP_VERSION} (Etsy Open API; +node)`;
}

module.exports = {
  APP_VERSION,
  shopUserAgent,
};
