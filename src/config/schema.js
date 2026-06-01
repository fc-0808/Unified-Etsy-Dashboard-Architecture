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
 * @property {string|null|false} proxy - SOCKS5 URL for proxied groups, or "direct"/null/false for no proxy
 * @property {ShopConfig[]} shops     - Shops belonging to this group
 */

/** Values that mean "route API traffic directly (no VPN/IPFoxy chain)". */
const DIRECT_PROXY_MARKERS = new Set(['', 'direct', 'none', 'false']);

/**
 * Whether a group routes Etsy API calls through the VPN → IPFoxy chain.
 * @param {{ proxy?: string|null|false }} group
 * @returns {boolean}
 */
function usesGroupProxy(group) {
  const p = group?.proxy;
  if (p === null || p === false) return false;
  if (typeof p === 'string') return !DIRECT_PROXY_MARKERS.has(p.trim().toLowerCase());
  return true;
}

/**
 * @typedef {object} AppConfig
 * @property {number}        vpn_local_port               - Local VPN SOCKS5 port (default 7897)
 * @property {number}        sync_interval_minutes        - Background receipt sync interval (default 60)
 * @property {number}        max_orders_per_sync          - Orders fetched per shop per sync (default 100)
 * @property {number}        pre_transit_days             - Upper bound (in days) for how far back we query
 *                                                          carrier tracking for unconfirmed orders. With the
 *                                                          4PX API integration active, carrier_confirmed_at IS NULL
 *                                                          is the true pre-transit signal. Default: 30 days.
 * @property {string}        db_path                      - Path to SQLite database file
 * @property {GroupConfig[]} groups                       - All shop groups
 * @property {boolean}       auto_restock_enabled         - Auto-restock zero-stock offerings (default true).
 *                                                          Set false to alert-only (log ZERO_STOCK, no PUT).
 * @property {number}        restock_quantity             - Target quantity for every offering when restocking
 *                                                          (default 3). Minimum 1.
 * @property {number}        inv_watch_interval_minutes   - Periodic full-inventory sweep interval in minutes
 *                                                          (default 240 = 4 h, minimum 15).
 *                                                          Order-triggered checks fire immediately on every
 *                                                          receipt sync and are not affected by this value.
 * @property {string|null}   fourpx_app_key               - 4PX Open Platform AppKey for carrier tracking API.
 *                                                          Register at https://open.4px.com.
 *                                                          When set, uses the authenticated official API
 *                                                          (tr.order.tracking.get) for precise pre-transit
 *                                                          detection. Recommended over the public fallback.
 * @property {string|null}   fourpx_app_secret            - 4PX Open Platform AppSecret paired with fourpx_app_key.
 * @property {object|null}   fourpx_sender                - Sender (shipper) address for 4PX order creation.
 *                                                          Required to use the "Create 4PX Shipment" feature.
 *                                                          Fields: first_name, [last_name], [company], [phone],
 *                                                          country (ISO-2), city, [state], [street], [post_code].
 * @property {string|null}   fourpx_warehouse_code        - 4PX warehouse/drop-off code for order creation,
 *                                                          e.g. "CNSZX01" for the Shenzhen warehouse.
 *                                                          Corresponds to deliver_type_info.warehouse_code.
 * @property {string|null}   fourpx_default_product       - Default logistics product code for new orders,
 *                                                          e.g. "BDS". Used to pre-select the dropdown in
 *                                                          the shipment drawer. Users can override per order.
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
  if (usesGroupProxy(group)) {
    if (!group.proxy || typeof group.proxy !== 'string') {
      throw new Error(`config.json: groups[${group.group_id}].proxy is missing.`);
    }
    if (!group.proxy.startsWith('socks5://')) {
      throw new Error(
        `config.json: groups[${group.group_id}].proxy must be a socks5:// URL, or "direct" for no proxy. Got: ${group.proxy}`
      );
    }
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
    // Strip a leading UTF-8 BOM if present — some editors (and PowerShell's
    // Set-Content -Encoding UTF8) prepend one, which JSON.parse rejects.
    const text = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
    raw = JSON.parse(text);
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
    // How many days after label creation an order is still considered "Pre-transit".
    // The Etsy v3 Receipt API does NOT expose carrier scan status — there is no field that
    // distinguishes "label created, not yet scanned" from "in transit". 4PX and similar
    // Chinese cross-border carriers can take anywhere from 2 to 14+ days for their first
    // carrier scan, and the timing is inconsistent within the same batch. This window is
    // therefore a best-effort approximation: all orders labeled within the window are shown
    // as "Pre-transit" unless carrier_confirmed_at has been set by an external tracking
    // integration. 14 days is recommended — it catches genuine stragglers (packages that
    // 4PX hasn't scanned after 8+ days, which are legitimately still pre-transit) while
    // keeping the list bounded to recent shipments. Operators who prefer a tighter list
    // can lower this value (e.g. 5) at the cost of missing slow-scan packages.
    pre_transit_days: raw.pre_transit_days ?? 30,
    db_path: raw.db_path
      ? path.resolve(path.dirname(CONFIG_PATH), raw.db_path)
      : path.resolve(__dirname, '../../data/etsy_dashboard.db'),
    groups: raw.groups,

    // ── Inventory auto-restock ─────────────────────────────────────────────
    // Set auto_restock_enabled: false in config.json for alert-only mode
    // (logs ZERO_STOCK events but never calls the Etsy PUT endpoint).
    auto_restock_enabled: raw.auto_restock_enabled !== false,
    // Target quantity for every offering when restocking (default 3, minimum 1).
    restock_quantity: typeof raw.restock_quantity === 'number'
      ? Math.max(1, Math.floor(raw.restock_quantity))
      : 3,
    // How often the full-shop inventory sweep runs in minutes (default 4h, min 15m).
    // Order-triggered checks fire on every receipt sync regardless of this value.
    inv_watch_interval_minutes: typeof raw.inv_watch_interval_minutes === 'number'
      ? Math.max(15, Math.floor(raw.inv_watch_interval_minutes))
      : 240,

    // ── 4PX Official Tracking API ──────────────────────────────────────────────
    // Register at https://open.4px.com to obtain an AppKey + AppSecret.
    // When set, the sync worker uses the authenticated tr.order.tracking.get
    // endpoint (official 4PX Open Platform API) instead of the public web API.
    // This is the preferred integration — it is rate-limit–safe, officially
    // supported, and returns the same structured tracking event data.
    fourpx_app_key:    raw.fourpx_app_key    ?? null,
    fourpx_app_secret: raw.fourpx_app_secret ?? null,

    // ── 4PX Shipping Order Creation ────────────────────────────────────────────
    // These fields enable the "Create 4PX Shipment" feature in the Orders tab.
    // fourpx_sender:           Shipper address (your warehouse in China).
    // fourpx_warehouse_code:   4PX warehouse code where you drop off packages.
    //                          e.g. "CNSZX01" (Shenzhen SZX warehouse).
    //                          Leave null to omit from the API request.
    // fourpx_default_product:  Default logistics product code, e.g. "BDS".
    //                          Used to pre-select the dropdown in the drawer.
    fourpx_sender:           raw.fourpx_sender           ?? null,
    fourpx_warehouse_code:   raw.fourpx_warehouse_code   ?? null,
    fourpx_default_product:  raw.fourpx_default_product  ?? null,

    // ── Shopping Route Generator (Orders Sorting Program) integration ──────────
    // Set osp_project_dir to the absolute path of the Orders_sorting_program
    // project.  The Route tab calls src/generate_shopping_route.py via
    // osp_python (default: 'python') to produce shopping_route.xlsx without
    // any manual PDF exports.
    osp_project_dir: raw.osp_project_dir || null,
    osp_python:      raw.osp_python      || 'python',
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
 * @returns {Array<ShopConfig & { group_id: string, group_label: string, proxy: string|null, uses_proxy: boolean }>}
 */
function getAllShops(config) {
  return config.groups.flatMap((group) =>
    group.shops.map((shop) => ({
      ...shop,
      group_id: group.group_id,
      group_label: group.label,
      proxy: usesGroupProxy(group) ? group.proxy : null,
      uses_proxy: usesGroupProxy(group),
      owner_email: shop.owner_email ?? null,
    }))
  );
}

module.exports = { loadConfig, findShopContext, getAllShops, usesGroupProxy };
