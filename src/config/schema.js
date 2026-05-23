'use strict';

/**
 * Configuration loader and validator.
 *
 * Loads config.json from the project root, validates the multi-group schema,
 * and provides typed accessors for the rest of the application.
 *
 * config.json is gitignored and NEVER committed. Use config.example.json
 * as the schema reference.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.resolve(__dirname, '../../config.json');

/**
 * @typedef {object} ShopConfig
 * @property {string}  shop_id        - Etsy shop name or numeric shop ID
 * @property {string}  shop_name      - Human-readable label for the dashboard
 * @property {string}  owner_email    - Email of the Etsy account that owns this shop (for oauth:setup)
 * @property {string}  api_key        - Etsy app keystring (first part of x-api-key header)
 * @property {string}  shared_secret  - Etsy app shared secret (second part of x-api-key)
 *                                      x-api-key header sent to Etsy = "keystring:shared_secret"
 * @property {string}  [refresh_token] - Optional backup refresh token. Primary store is tokens.json.
 *                                       Run 'npm run oauth:setup' — tokens.json is auto-populated.
 */

/**
 * @typedef {object} GroupConfig
 * @property {string}       group_id  - Unique identifier (e.g. "group_hk_passport")
 * @property {string}       label     - Human-readable display name
 * @property {string}       proxy     - SOCKS5 proxy URL for this group (e.g. "socks5://user:pass@host:port")
 * @property {ShopConfig[]} shops     - Shops belonging to this group
 */

/**
 * @typedef {object} AppConfig
 * @property {number}        vpn_local_port          - Local VPN SOCKS5 port (default 7897)
 * @property {number}        sync_interval_minutes   - Background sync interval (default 60)
 * @property {number}        max_orders_per_sync     - Orders fetched per shop per sync (default 100)
 * @property {string}        db_path                 - Path to SQLite database file
 * @property {GroupConfig[]} groups                  - All shop groups
 */

/**
 * Validate that a shop entry has all required fields.
 * @param {object} shop
 * @param {string} groupId - For error messages
 * @param {number} shopIndex
 */
function validateShop(shop, groupId, shopIndex) {
  // Required fields — must be present and non-empty
  const required = ['shop_id', 'shop_name', 'api_key', 'shared_secret'];
  for (const field of required) {
    if (!shop[field] || typeof shop[field] !== 'string' || shop[field].trim() === '') {
      throw new Error(
        `config.json: groups[${groupId}].shops[${shopIndex}].${field} is missing or empty.\n` +
          `  api_key:       keystring from etsy.com/developers/your-apps\n` +
          `  shared_secret: click the eye icon next to the keystring in the developer portal`
      );
    }
  }

  // Check for unfilled FILL_IN_ placeholders in required fields
  for (const field of required) {
    if (shop[field].startsWith('FILL_IN_')) {
      throw new Error(
        `config.json: groups[${groupId}].shops[${shopIndex}].${field} still has a placeholder value ("${shop[field]}"). ` +
          `Open config.json and replace it with your real Etsy credentials.`
      );
    }
  }

  // refresh_token is OPTIONAL in config.json.
  // Primary token store is tokens.json (managed automatically by TokenManager via oauth:setup).
  // If provided here, validate its format as a backup cross-check.
  if (shop.refresh_token && typeof shop.refresh_token === 'string') {
    if (shop.refresh_token.startsWith('FILL_IN_')) {
      throw new Error(
        `config.json: groups[${groupId}].shops[${shopIndex}].refresh_token has a placeholder value. ` +
          `Either remove the field or run 'npm run oauth:setup' and paste the real token.`
      );
    }
    if (!shop.refresh_token.includes('.')) {
      throw new Error(
        `config.json: groups[${groupId}].shops[${shopIndex}].refresh_token format looks invalid. ` +
          `Etsy tokens have format "12345678.xxxxx" (numeric user ID prefix). ` +
          `Run 'npm run oauth:setup' to obtain a valid token.`
      );
    }
  }
}

/**
 * Validate that a group entry has all required fields.
 * @param {object} group
 * @param {number} index
 */
function validateGroup(group, index) {
  if (!group.group_id || typeof group.group_id !== 'string') {
    throw new Error(`config.json: groups[${index}].group_id is missing.`);
  }
  if (!group.label || typeof group.label !== 'string') {
    throw new Error(`config.json: groups[${group.group_id}].label is missing.`);
  }
  if (!group.proxy || typeof group.proxy !== 'string') {
    throw new Error(`config.json: groups[${group.group_id}].proxy is missing.`);
  }
  if (!group.proxy.startsWith('socks5://')) {
    throw new Error(
      `config.json: groups[${group.group_id}].proxy must be a socks5:// URL. Got: ${group.proxy}`
    );
  }
  if (!Array.isArray(group.shops) || group.shops.length === 0) {
    throw new Error(`config.json: groups[${group.group_id}].shops must be a non-empty array.`);
  }
  group.shops.forEach((shop, i) => validateShop(shop, group.group_id, i));
}

/**
 * Load and validate config.json.
 * Throws a descriptive error if the file is missing or invalid.
 *
 * @returns {AppConfig}
 */
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `config.json not found at ${CONFIG_PATH}.\n` +
        `Copy config.example.json to config.json and fill in your credentials.`
    );
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    throw new Error(`config.json is not valid JSON: ${err.message}`);
  }

  // Validate top-level structure
  if (!Array.isArray(raw.groups) || raw.groups.length === 0) {
    throw new Error('config.json: "groups" must be a non-empty array.');
  }

  raw.groups.forEach((group, i) => validateGroup(group, i));

  // Apply defaults for optional fields
  const config = {
    vpn_local_port: raw.vpn_local_port ?? 7897,
    sync_interval_minutes: raw.sync_interval_minutes ?? 60,
    max_orders_per_sync: raw.max_orders_per_sync ?? 100,
    db_path: raw.db_path
      ? path.resolve(path.dirname(CONFIG_PATH), raw.db_path)
      : path.resolve(__dirname, '../../data/etsy_dashboard.db'),
    groups: raw.groups,
  };

  return config;
}

/**
 * Find the group config that owns a given shop_id.
 * @param {AppConfig} config
 * @param {string} shopId
 * @returns {{ group: GroupConfig, shop: ShopConfig } | null}
 */
function findShopContext(config, shopId) {
  for (const group of config.groups) {
    const shop = group.shops.find((s) => s.shop_id === shopId);
    if (shop) return { group, shop };
  }
  return null;
}

/**
 * Flatten all shops across all groups into a single array,
 * each entry enriched with its parent group_id and proxy.
 *
 * Useful for the sync worker that iterates over all shops.
 *
 * @param {AppConfig} config
 * @returns {Array<ShopConfig & { group_id: string, group_label: string, proxy: string }>}
 */
function getAllShops(config) {
  return config.groups.flatMap((group) =>
    group.shops.map((shop) => ({
      ...shop,
      group_id: group.group_id,
      group_label: group.label,
      proxy: group.proxy,
      owner_email: shop.owner_email ?? null,
    }))
  );
}

module.exports = { loadConfig, findShopContext, getAllShops };
