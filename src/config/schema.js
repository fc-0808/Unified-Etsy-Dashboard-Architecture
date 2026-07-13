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
 * @property {string}  [refresh_token]        - Optional backup refresh token. Primary store is tokens.json.
 *                                              Run 'npm run oauth:setup' — tokens.json is auto-populated.
 * @property {string}  [adspower_profile_id]  - AdsPower user_id for this shop's browser profile.
 *                                              When set, the Messages tab (and Discounts tab) use AdsPower
 *                                              CDP to open/automate this shop's browser rather than launching
 *                                              a fresh Playwright instance. This is the RECOMMENDED mode:
 *                                              it reuses AdsPower's per-profile proxy routing + anti-detect
 *                                              fingerprint, meaning the session is identical to normal human
 *                                              use. Find the user_id in AdsPower → select a profile → the
 *                                              numeric ID shown in the URL or profile list.
 *                                              Can also be set at the group level as a default for all shops
 *                                              in the group (shop-level overrides group-level).
 * @property {object}  [email_imap]   - IMAP credentials for email-notification sync (read-only fallback).
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
 * @property {number}        tracking_edit_days           - Window (in days) during which Etsy permits editing the
 *                                                          tracking number of a shipped receipt. Default: 3 days.
 * @property {number}        recently_packaged_days       - Look-back window (in days) for the packer's
 *                                                          "Recently packaged" review queue: orders whose
 *                                                          packaged_at falls within this window, newest first,
 *                                                          so a mispacked parcel can be caught and fixed shortly
 *                                                          after sealing. Default: 7 days.
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
 *                                                          Required sub-fields: first_name, country, city, post_code.
 *                                                          post_code MUST be present — 4PX rejects orders without it
 *                                                          with error DS000000 ("shipper's postcode is required").
 *                                                          Optional: last_name, company, phone, state, street.
 *                                                          Aliases postcode/postal_code/zip are auto-normalised.
 * @property {string|null}   fourpx_warehouse_code        - 4PX warehouse/drop-off code for order creation,
 *                                                          e.g. "CNSZX01" for the Shenzhen warehouse.
 *                                                          Corresponds to deliver_type_info.warehouse_code.
 * @property {string|null}   fourpx_default_product       - Fallback logistics product when
 *                                                          POSTLINK-S5058 (S5058) is not offered
 *                                                          for a destination (e.g. "QC").
 *                                                          The UI always prefers S5058 when listed.
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
 * Normalize and validate the fourpx_sender block.
 *
 * 1. Returns null if the sender is not configured (feature disabled).
 * 2. Resolves common post_code alias spellings so a user who writes
 *    "postcode", "postal_code", "zip", or "zipcode" instead of "post_code"
 *    still gets a working config instead of a silent DS000000 failure.
 * 3. Emits a startup warning when post_code is still absent after alias
 *    resolution, so the problem surfaces immediately in logs rather than
 *    at shipment-creation time.
 *
 * @param {object|null|undefined} sender  Raw value from config.json
 * @returns {object|null}
 */
function normalizeFourpxSender(sender) {
  if (!sender || typeof sender !== 'object') return null;

  const normalized = { ...sender };

  // Resolve post_code aliases — many users naturally write one of these variants.
  // Priority: post_code > postcode > postal_code > zip > zipcode
  if (!normalized.post_code) {
    const alias =
      normalized.postcode    ||
      normalized.postal_code ||
      normalized.zip         ||
      normalized.zipcode;
    if (alias) {
      normalized.post_code = String(alias).trim();
      // Remove the alias key so the payload stays clean
      delete normalized.postcode;
      delete normalized.postal_code;
      delete normalized.zip;
      delete normalized.zipcode;
      console.warn(
        '[config] fourpx_sender: auto-resolved post_code alias. ' +
        'Rename the field to "post_code" in config.json to silence this warning.'
      );
    }
  }

  if (!normalized.post_code?.trim()) {
    // Fail fast at startup rather than silently produce DS000000 at order-creation time.
    // Australia and several other destinations trigger strict sender-postcode validation
    // on the 4PX side; a missing postcode causes every shipment to those countries to fail.
    throw new Error(
      'config.json: fourpx_sender.post_code is required. ' +
      '4PX rejects every shipment order that lacks a sender postcode (error DS000000). ' +
      'Add "post_code": "<your warehouse ZIP>" to the fourpx_sender block in config.json ' +
      'and restart the server.'
    );
  }

  return normalized;
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

  // ── OpSec: enforce Etsy's Personal Access "5 shops per app key" limit ─────────
  // Etsy caps each app (keystring) at 5 authorized shops. Exceeding it is itself a
  // review/anti-abuse trigger, so surface it loudly at startup rather than letting
  // a 6th shop silently attach to a key. This is a WARNING (never fatal) so an
  // operator mid-migration is not locked out of the dashboard.
  const ETSY_SHOPS_PER_KEY = 5;
  const shopsPerKey = new Map();
  for (const group of raw.groups) {
    for (const shop of group.shops) {
      const key = shop.api_key;
      if (!key) continue;
      if (!shopsPerKey.has(key)) shopsPerKey.set(key, []);
      shopsPerKey.get(key).push(shop.shop_name || shop.shop_id);
    }
  }
  for (const [key, names] of shopsPerKey) {
    if (names.length > ETSY_SHOPS_PER_KEY) {
      const masked = `${String(key).slice(0, 6)}…`;
      console.warn(
        `[config] ⚠ API key ${masked} is mapped to ${names.length} shops ` +
        `(${names.join(', ')}), exceeding Etsy's Personal Access limit of ${ETSY_SHOPS_PER_KEY} ` +
        `shops per app key. Move the extra shop(s) to a separate app/key to avoid an ` +
        `Etsy anti-abuse review.`
      );
    }
  }

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
    // Window (in days) during which Etsy allows the tracking number on a shipped
    // receipt to be edited/re-submitted. Etsy's policy is ~3 days from the ship
    // notification; after that, re-submitting tracking is rejected by their API.
    // We use this to gate the "Edit tracking" action in the Orders tab so operators
    // get a clear, pre-emptive message instead of an opaque Etsy 4xx error. The
    // value is advisory on our side — Etsy remains the source of truth and any call
    // outside the window will still surface Etsy's own rejection. Default: 3 days.
    tracking_edit_days: raw.tracking_edit_days ?? 3,
    // Look-back window (in days) for the packer's "Recently packaged" review queue.
    // After sealing a parcel and marking it packaged, the operator has a short window
    // to notice a mistake (wrong item, wrong buyer, wrong model) and correct it. This
    // bounds that review list to genuinely recent work so it stays a fast, actionable
    // audit view rather than an ever-growing archive. Sorted by packaged_at DESC.
    // Default: 7 days (minimum 1). Raise it for a longer safety net.
    recently_packaged_days: typeof raw.recently_packaged_days === 'number' && raw.recently_packaged_days >= 1
      ? Math.floor(raw.recently_packaged_days)
      : 7,
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
    //                          REQUIRED sub-fields: first_name, country, city, post_code.
    //                          post_code is mandatory — 4PX rejects orders without it
    //                          with error DS000000 ("shipper's postcode is required").
    // fourpx_warehouse_code:   4PX warehouse code where you drop off packages.
    //                          e.g. "CNSZX01" (Shenzhen SZX warehouse).
    //                          Leave null to omit from the API request.
    // fourpx_default_product:  Default logistics product code, e.g. "BDS".
    //                          Used to pre-select the dropdown in the drawer.
    fourpx_sender:           normalizeFourpxSender(raw.fourpx_sender),
    fourpx_warehouse_code:   raw.fourpx_warehouse_code   ?? null,
    fourpx_default_product:  raw.fourpx_default_product  ?? null,

    // ── 4PX shipping-cost (freight) sync ───────────────────────────────────────
    // The sync worker polls ds.xms.order.getFreight for every 4PX order until 4PX
    // bills it, then surfaces the per-order/per-shop shipping cost in the dashboard.
    // fourpx_freight_sync:          set false to disable the extra API traffic.
    // fourpx_freight_recheck_hours: how often an as-yet-unbilled order is re-queried
    //                               (4PX only bills after weighing the parcel).
    fourpx_freight_sync:     raw.fourpx_freight_sync === false ? false : true,
    fourpx_freight_recheck_hours: typeof raw.fourpx_freight_recheck_hours === 'number' && raw.fourpx_freight_recheck_hours > 0
                               ? raw.fourpx_freight_recheck_hours : 6,
    // Fallback parcel weight (grams) used to price a 4PX order via the rate card
    // (ds.xms.estimated_cost.get) when the order has no stored declared weight
    // (e.g. orders created before weight capture). 100 g suits small phone cases.
    fourpx_default_weight_g: typeof raw.fourpx_default_weight_g === 'number' && raw.fourpx_default_weight_g > 0
                               ? Math.round(raw.fourpx_default_weight_g) : 100,
    // Currency 4PX settles freight in (CN accounts: CNY/RMB). Stamped on estimated
    // costs and used as the conversion source for the Earnings "true net" view.
    fourpx_settlement_currency: (raw.fourpx_settlement_currency && String(raw.fourpx_settlement_currency).trim().toUpperCase()) || 'CNY',
    // Shipping tab "stuck" threshold: an in-transit parcel with no new carrier scan
    // for this many days is flagged as stuck (e.g. held at customs). Default 10.
    fourpx_stuck_days: typeof raw.fourpx_stuck_days === 'number' && raw.fourpx_stuck_days > 0
                               ? Math.round(raw.fourpx_stuck_days) : 10,

    // ── Shipping-label printing (thermal label printer) ────────────────────────
    // The "Print label" button rasterizes the 4PX label PDF to a pure 1-bit
    // black/white bitmap at the printer's NATIVE resolution and prints it 1:1.
    // This is the only way to keep the dense barcode crisp/scannable: any
    // grayscale/anti-aliased resample (what Adobe "Fit" and the browser do)
    // softens the bars into fuzzy grey and can make them unreadable.
    //
    // label_print_mode:
    //   'auto'   → silent direct-to-printer on Windows when label_printer_name
    //              resolves to an installed printer; otherwise open the PDF in
    //              the OS default app (Adobe) so the operator can print manually.
    //   'silent' → always print directly (errors if the printer is missing).
    //   'open'   → always just open the PDF in the default app (no direct print).
    label_print_mode:    ['auto', 'silent', 'open'].includes(raw.label_print_mode)
                           ? raw.label_print_mode : 'auto',
    // Exact Windows printer name (Control Panel → Devices and Printers).
    label_printer_name:  (raw.label_printer_name && String(raw.label_printer_name).trim()) || 'Deli DL-720W',
    // Physical label media size in millimetres (the printer's loaded stock).
    label_width_mm:      typeof raw.label_width_mm  === 'number' && raw.label_width_mm  > 0 ? raw.label_width_mm  : 80,
    label_height_mm:     typeof raw.label_height_mm === 'number' && raw.label_height_mm > 0 ? raw.label_height_mm : 80,
    // Printer head resolution in dots-per-inch (Deli DL-720W = 203 dpi / 8 dpmm).
    label_dpi:           typeof raw.label_dpi === 'number' && raw.label_dpi >= 96 ? Math.floor(raw.label_dpi) : 203,
    // Binarisation cutoff (0–255): pixels darker than this become solid black.
    // Higher = bolder bars/text. 160 keeps thin barcode bars solid without bleed.
    label_print_threshold: typeof raw.label_print_threshold === 'number'
                           ? Math.min(255, Math.max(1, Math.floor(raw.label_print_threshold))) : 160,
    // Copies per print job.
    label_print_copies:  typeof raw.label_print_copies === 'number' && raw.label_print_copies >= 1
                           ? Math.floor(raw.label_print_copies) : 1,

    // ── EU IOSS / VAT compliance ───────────────────────────────────────────────
    // fourpx_ioss_no:  Import One-Stop Shop (IOSS) registration number used for
    //                  EU-bound parcels with a declared value ≤ €150. 4PX maps it
    //                  to the order's `ioss_no` field (per the official model). For
    //                  marketplace sales the platform's IOSS number is used (e.g.
    //                  Etsy's). The server attaches it automatically to every EU27
    //                  destination so customs clears the parcel as VAT-prepaid.
    //                  Format: "IM" + 10 digits (12 chars, no spaces).
    // fourpx_vat_no / fourpx_eori_no: optional EU VAT / EORI identifiers, attached
    //                  to EU destinations when present.
    fourpx_ioss_no:          (raw.fourpx_ioss_no && String(raw.fourpx_ioss_no).trim()) || null,
    fourpx_vat_no:           (raw.fourpx_vat_no  && String(raw.fourpx_vat_no).trim())  || null,
    fourpx_eori_no:          (raw.fourpx_eori_no && String(raw.fourpx_eori_no).trim()) || null,

    // ── Shopping Route Generator (Orders Sorting Program) integration ──────────
    // Set osp_project_dir to the absolute path of the Orders_sorting_program
    // project.  The Route tab calls src/generate_shopping_route.py via
    // osp_python (default: 'python') to produce shopping_route.xlsx without
    // any manual PDF exports.
    // ── Self-contained route engine (vendored — no external program needed) ──
    // route_engine_dir is the project root of THIS dashboard's own copy of the
    // shopping-route generator. It contains src/generate_shopping_route.py plus
    // its data/ (supplier_catalog.xlsx, charm_images, charm_manifest.json,
    // etsy_orders.db), cache/ and input/ subdirs. Defaults to
    // <dashboard project>/route-engine. The dashboard NO LONGER depends on the
    // separate Orders Sorting Program; osp_project_dir is kept only as a
    // legacy fallback for installs that have not been migrated.
    route_engine_dir: (raw.route_engine_dir && String(raw.route_engine_dir).trim()) || null,
    osp_project_dir: raw.osp_project_dir || null,
    osp_python:      raw.osp_python      || 'python',
    // Where the generated shopping-route files (full / simple / Chinese) are
    // written. Defaults to <dashboard project>/output when unset, so the route
    // files always live inside THIS program's folder.
    osp_output_dir:  (raw.osp_output_dir && String(raw.osp_output_dir).trim()) || null,
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
      // Shop-level adspower_profile_id wins; fall back to group-level default.
      // This allows one profile per group (shared proxy container) or a dedicated
      // profile per shop depending on how AdsPower is configured.
      adspower_profile_id: shop.adspower_profile_id ?? group.adspower_profile_id ?? null,
    }))
  );
}

module.exports = { loadConfig, findShopContext, getAllShops, usesGroupProxy };
