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

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  MIN_SYNC_INTERVAL_MINUTES,
  MIN_INV_WATCH_INTERVAL_MINUTES,
  analyzeSuspensionRisks,
  enforceConfigCompliance,
} = require('../compliance/suspension-guard');
const { normalizeTaxIdOverrides } = require('../compliance/destination-tax');
// The 4PX pickup-address rules (field names, aliases, documented length limits)
// live with the API adapter that transmits them, so config validation and the
// live request can never disagree about what a valid pickup address is.
const {
  normalizePickupInfo,
  normalizeMaxDaysAhead,
  normalizeAwaitingDays,
  DEFAULT_PICKUP_TIMEZONE,
  DEFAULT_MAX_DAYS_AHEAD,
} = require('../fourpx/collect');

// Config location. Defaults to the repo-root config.json, but can be overridden
// with DASHBOARD_CONFIG_PATH — used to stand up an ISOLATED instance (e.g. an
// integration test or a second local instance) against a throwaway config + DB
// without touching the real config.json. Backward-compatible: unset → same as before.
const CONFIG_PATH = process.env.DASHBOARD_CONFIG_PATH
  ? path.resolve(process.env.DASHBOARD_CONFIG_PATH)
  : path.resolve(__dirname, '../../config.json');

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
 * @property {string}  [adspower_profile_id]  - Legacy operator metadata only.
 *                                              This application must not automate or scrape Etsy's website;
 *                                              use documented Open API endpoints and manual browser actions.
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
const DEFAULT_OPERATIONS_TIMEZONE = 'Asia/Shanghai';

/** Resolve a trusted config path, including Windows-style %ENV_VAR% tokens. */
function resolveConfigPath(value) {
  const expanded = String(value).replace(/%([^%]+)%/g, (match, name) => {
    const replacement = process.env[name];
    return replacement == null || replacement === '' ? match : replacement;
  });
  return path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(path.dirname(CONFIG_PATH), expanded);
}

function defaultDbPath() {
  let dataRoot;
  if (process.platform === 'win32') {
    dataRoot = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  } else if (process.platform === 'darwin') {
    dataRoot = path.join(os.homedir(), 'Library', 'Application Support');
  } else {
    dataRoot = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  }
  return path.join(dataRoot, 'EtsyDashboard', 'etsy_dashboard.db');
}

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
 * @property {number}        recently_packaged_days       - Legacy hint returned on /api/orders for
 *                                                          API compatibility. The Recently packaged
 *                                                          queue now lists full packing history;
 *                                                          day chips + archive picker replace the
 *                                                          old rolling window. Default: 7.
 * @property {number}        etsy_completion_sweep_minutes - Floor interval for the ship-recovery reconciler that
 *                                                          completes 4PX-labelled orders which were never finished
 *                                                          on Etsy. Default: 5 minutes.
 * @property {boolean}       require_verify_before_pack   - When true, an order must be packer-VERIFIED (items
 *                                                          confirmed in hand), not merely shopper-Purchased,
 *                                                          before it enters the "To pack & ship" queue.
 *                                                          Default: false (no behavior change).
 * @property {string}        db_path                      - Path to SQLite database file
 * @property {string}        operations_timezone          - IANA zone used to decide checklist
 *                                                          dates and Monday-to-Sunday boundaries
 *                                                          (default "Asia/Shanghai").
 * @property {string|null}   route_engine_data_dir        - Optional mutable route-engine
 *                                                          data directory, kept outside
 *                                                          cloud-synced source trees.
 * @property {GroupConfig[]} groups                       - All shop groups
 * @property {boolean}       etsy_multi_key_approved     - Written Etsy approval for multiple keys in this application (default false).
 * @property {boolean}       catalog_health_sync          - Explicit opt-in daily API listing/review snapshot (default false).
 * @property {boolean}       etsy_api_analytics_approved  - True only with Etsy's written authorization for API analytics (default false).
 * @property {number}        catalog_health_interval_hours - Minimum hours between catalog-health walks per shop (default 24, min 12).
 * @property {boolean}       auto_restock_enabled         - Auto-restock zero-stock offerings (default false, opt-in).
 *                                                          Set true only when every automatic quantity increase
 *                                                          is fulfillable. False = alert-only (log ZERO_STOCK, no PUT).
 * @property {number}        restock_quantity             - Target quantity for every offering when restocking
 *                                                          (default 3). Minimum 1.
 * @property {number}        inv_watch_interval_minutes   - Periodic full-inventory sweep interval in minutes
 *                                                          (default 240 = 4 h, minimum 60).
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
 * @property {object|null}   fourpx_pickup                - Default COLLECTION address a 4PX driver
 *                                                          comes to (揽收预约). Pre-fills the pickup
 *                                                          booking dialog; the packer may edit it.
 *                                                          Fields: name, phone, country, province,
 *                                                          city, district, street (optional),
 *                                                          detail_address, zip_code (optional).
 *                                                          Incomplete values warn, never throw —
 *                                                          the dialog can complete them.
 * @property {boolean}       fourpx_pickup_booking        - Whether the pickup-booking feature is
 *                                                          offered at all (default true).
 * @property {string}        fourpx_pickup_timezone       - IANA zone the pickup CALENDAR is read in
 *                                                          (default "Asia/Shanghai"). 4PX reads
 *                                                          reserve_time as a local date at the
 *                                                          pickup address.
 * @property {number}        fourpx_pickup_max_days_ahead - Bookable window in days including today
 *                                                          (default 14, max 60).
 * @property {number}        fourpx_pickup_awaiting_days  - How recently a parcel must have been
 *                                                          sealed to count as still waiting for a
 *                                                          4PX driver (default 7, max 90).
 */

/**
 * Validate that a shop entry has all required fields.
 * @param {object} shop
 * @param {string} groupId - For error messages
 * @param {number} shopIndex
 */
function validateShop(shop, groupId, shopIndex) {
  const isPlaceholder = (value) =>
    /(?:FILL_IN_|YOUR_|REPLACE_)/i.test(String(value || ''));
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

  // A copied example must fail before any network call until credentials are real.
  for (const field of required) {
    if (isPlaceholder(shop[field])) {
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
    if (isPlaceholder(shop.refresh_token)) {
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
 * Normalize the fourpx_pickup block — the default door-to-door COLLECTION
 * address 4PX sends a driver to (揽收预约 → 新建预约 → 揽收地址).
 *
 * This is NOT fourpx_sender. fourpx_sender is the shipper printed on every
 * parcel label and is validated strictly because a bad value breaks shipment
 * creation. This block only PRE-FILLS the pickup dialog, and the packer can
 * complete or correct it there before booking, so an incomplete value must
 * WARN rather than abort startup: refusing to boot over an optional
 * convenience default would take the whole dashboard down with it.
 *
 * @param {object|null|undefined} raw  Raw value from config.json
 * @returns {object|null} normalized pickup_info, or null when not configured
 */
function normalizeFourpxPickup(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { pickup, problems } = normalizePickupInfo(raw, { partial: true });
  if (problems.length) {
    console.warn(
      '[config] fourpx_pickup is incomplete, so the 4PX pickup dialog will open ' +
      `with blanks for the packer to fill in: ${problems.join(' ')}`
    );
  }
  return Object.keys(pickup).length ? pickup : null;
}

/**
 * Resolve the IANA timezone the pickup calendar is read in.
 *
 * Validated here rather than at request time: an unknown zone makes
 * Intl.DateTimeFormat throw, and the failure would otherwise surface as an
 * opaque 500 the first time a packer opened the booking dialog.
 *
 * @param {string|null|undefined} raw
 * @returns {string} a usable IANA zone
 */
function normalizeFourpxPickupTimezone(raw) {
  const zone = raw ? String(raw).trim() : '';
  if (!zone) return DEFAULT_PICKUP_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date());
    return zone;
  } catch {
    console.warn(
      `[config] fourpx_pickup_timezone "${zone}" is not a recognised IANA timezone — ` +
      `falling back to ${DEFAULT_PICKUP_TIMEZONE}.`
    );
    return DEFAULT_PICKUP_TIMEZONE;
  }
}

/**
 * Resolve the business calendar used by the manual operations checklist.
 * Keeping this server-authoritative means two employees in different browser
 * timezones still see and update the same Monday-to-Sunday work week.
 */
function normalizeOperationsTimezone(raw) {
  const zone = raw ? String(raw).trim() : '';
  if (!zone) return DEFAULT_OPERATIONS_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date());
    return zone;
  } catch {
    console.warn(
      `[config] operations_timezone "${zone}" is not a recognised IANA timezone — ` +
      `falling back to ${DEFAULT_OPERATIONS_TIMEZONE}.`
    );
    return DEFAULT_OPERATIONS_TIMEZONE;
  }
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
  // review/anti-abuse trigger. analyzeSuspensionRisks() collects every signal;
  // enforceConfigCompliance() refuses to start on critical violations. Platform
  // allocations are not locally overridable.
  const complianceRisks = analyzeSuspensionRisks({
    groups: raw.groups,
    sync_interval_minutes: raw.sync_interval_minutes,
    inv_watch_interval_minutes: raw.inv_watch_interval_minutes,
    auto_restock_enabled: raw.auto_restock_enabled,
    etsy_multi_key_approved: raw.etsy_multi_key_approved,
    catalog_health_sync: raw.catalog_health_sync,
    etsy_api_analytics_approved: raw.etsy_api_analytics_approved,
  });
  enforceConfigCompliance(raw, complianceRisks);

  // ── Marketplace import-tax identifiers ───────────────────────────────────────
  // Validated here, at the only moment a typo is still cheap: from this point on
  // the value is shown to packers as the number to write on a parcel and handed
  // to the carrier as customs data. A bad entry is dropped (never silently
  // used) so the reviewed built-in value applies instead.
  const { identifiers: marketplaceTaxIds, problems: taxIdProblems } =
    normalizeTaxIdOverrides(raw.marketplace_tax_ids);
  for (const problem of taxIdProblems) console.warn(`[config] ${problem}`);
  // fourpx_ioss_no predates the registry and stays authoritative for the 4PX
  // field. If it disagrees with the IOSS number the packing bench shows, the
  // label and the bench are telling two different stories — say so once.
  const iossOverride = marketplaceTaxIds.EU_IOSS;
  if (raw.fourpx_ioss_no && iossOverride) {
    const shipped = String(raw.fourpx_ioss_no).trim().toUpperCase().replace(/\s+/g, '');
    if (shipped !== iossOverride.toUpperCase().replace(/\s+/g, '')) {
      console.warn(
        `[config] fourpx_ioss_no (${shipped}) differs from marketplace_tax_ids.EU_IOSS ` +
        `(${iossOverride}). 4PX will receive the former and the packing bench will show ` +
        'the latter. Make them match unless the difference is deliberate.'
      );
    }
  }

  // Apply defaults for optional fields
  const config = {
    vpn_local_port: raw.vpn_local_port ?? 7897,
    sync_interval_minutes: typeof raw.sync_interval_minutes === 'number'
      ? Math.max(MIN_SYNC_INTERVAL_MINUTES, Math.floor(raw.sync_interval_minutes))
      : 60,
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
    // Legacy hint returned on /api/orders (recently_packaged_days). The Recently
    // packaged queue now lists full packing history; day chips + archive picker
    // replaced the old rolling window. Default: 7.
    recently_packaged_days: typeof raw.recently_packaged_days === 'number' && raw.recently_packaged_days >= 1
      ? Math.floor(raw.recently_packaged_days)
      : 7,
    // How often the ship-recovery reconciler sweeps for orders that hold a paid
    // 4PX label but were never completed on Etsy (see the Etsy-completion ledger
    // in src/orders/etsy-completion.js). This is only the FLOOR: a sweep is also
    // scheduled right after every label is created, so the normal recovery time
    // is under a minute. The interval exists to catch orders stranded while the
    // dashboard was down. Default: 5 minutes (minimum 1).
    etsy_completion_sweep_minutes: typeof raw.etsy_completion_sweep_minutes === 'number' && raw.etsy_completion_sweep_minutes >= 1
      ? Math.floor(raw.etsy_completion_sweep_minutes)
      : 5,
    // Two-person integrity gate. When true, an order is only packable once a packer
    // has VERIFIED its products are physically in hand (not merely marked Purchased
    // by the shopper) — the "To pack & ship" queue then shows verified orders only,
    // and the "Verify purchases" worklist is where unverified-but-purchased orders
    // wait. Off by default so existing single-operator shops see no behavior change.
    require_verify_before_pack: raw.require_verify_before_pack === true,
    db_path: raw.db_path
      ? resolveConfigPath(raw.db_path)
      : defaultDbPath(),
    groups: raw.groups,
    // One canonical business calendar for the shared manual checklist. This is
    // independent from browser locale and from the 4PX pickup calendar.
    operations_timezone: normalizeOperationsTimezone(raw.operations_timezone),

    // ── Inventory auto-restock ─────────────────────────────────────────────
    // Safe default is alert-only. Enable explicitly only when physical inventory
    // is authoritative and every automatic quantity increase is fulfillable.
    auto_restock_enabled: raw.auto_restock_enabled === true,
    // Target quantity for every offering when restocking (default 3, minimum 1).
    restock_quantity: typeof raw.restock_quantity === 'number'
      ? Math.max(1, Math.floor(raw.restock_quantity))
      : 3,
    // How often the full-shop inventory sweep runs in minutes (default 4h, min 60m).
    // Order-triggered checks fire on every receipt sync regardless of this value.
    inv_watch_interval_minutes: typeof raw.inv_watch_interval_minutes === 'number'
      ? Math.max(MIN_INV_WATCH_INTERVAL_MINUTES, Math.floor(raw.inv_watch_interval_minutes))
      : 240,

    // ── 4PX Official Tracking API ──────────────────────────────────────────────
    // Register at https://open.4px.com to obtain an AppKey + AppSecret.
    // When set, the sync worker uses the authenticated tr.order.tracking.get
    // endpoint (official 4PX Open Platform API) instead of the public web API.
    // This is the preferred integration — it is rate-limit–safe, officially
    // supported, and returns the same structured tracking event data.
    fourpx_app_key:    raw.fourpx_app_key    ?? null,
    fourpx_app_secret: raw.fourpx_app_secret ?? null,
    // Independent parcel-status worker. It wakes frequently, but only calls 4PX
    // for snapshots whose phase-specific cache TTL has expired. This keeps the
    // Shipping board current without coupling it to the slower Etsy receipt sync.
    fourpx_tracking_sync: raw.fourpx_tracking_sync === false ? false : true,
    fourpx_tracking_interval_minutes:
      typeof raw.fourpx_tracking_interval_minutes === 'number'
        ? Math.min(24 * 60, Math.max(5, Math.floor(raw.fourpx_tracking_interval_minutes)))
        : 15,
    fourpx_tracking_window_days:
      typeof raw.fourpx_tracking_window_days === 'number'
        ? Math.min(365, Math.max(30, Math.floor(raw.fourpx_tracking_window_days)))
        : 120,
    // Open parcels older than the hot window still need eventual terminal truth.
    // Recheck that long tail weekly by default instead of silently abandoning it.
    fourpx_tracking_long_tail_recheck_hours:
      typeof raw.fourpx_tracking_long_tail_recheck_hours === 'number'
        ? Math.min(30 * 24, Math.max(24, raw.fourpx_tracking_long_tail_recheck_hours))
        : 168,
    fourpx_tracking_pre_recheck_hours:
      typeof raw.fourpx_tracking_pre_recheck_hours === 'number' && raw.fourpx_tracking_pre_recheck_hours > 0
        ? Math.min(72, Math.max(0.25, raw.fourpx_tracking_pre_recheck_hours))
        : 2,
    fourpx_tracking_transit_recheck_hours:
      typeof raw.fourpx_tracking_transit_recheck_hours === 'number' && raw.fourpx_tracking_transit_recheck_hours > 0
        ? Math.min(168, Math.max(0.5, raw.fourpx_tracking_transit_recheck_hours))
        : 6,
    fourpx_tracking_max_per_cycle:
      typeof raw.fourpx_tracking_max_per_cycle === 'number'
        ? Math.min(1000, Math.max(1, Math.floor(raw.fourpx_tracking_max_per_cycle)))
        : 250,
    fourpx_tracking_request_delay_ms:
      typeof raw.fourpx_tracking_request_delay_ms === 'number'
        ? Math.min(5000, Math.max(100, Math.floor(raw.fourpx_tracking_request_delay_ms)))
        : 250,
    fourpx_tracking_error_retry_minutes:
      typeof raw.fourpx_tracking_error_retry_minutes === 'number'
        ? Math.min(120, Math.max(1, raw.fourpx_tracking_error_retry_minutes))
        : 15,
    fourpx_tracking_error_retry_max_minutes:
      typeof raw.fourpx_tracking_error_retry_max_minutes === 'number'
        ? Math.min(24 * 60, Math.max(5, raw.fourpx_tracking_error_retry_max_minutes))
        : 120,

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

    // ── 4PX pickup booking (揽收预约) ──────────────────────────────────────────
    // Lets the packing bench book 4PX's door-to-door collection for the parcels
    // it just sealed (ds.xms.api.collect.create.order), instead of the operator
    // logging into b.4px.com to do it by hand.
    // fourpx_pickup:            default COLLECTION address the driver comes to.
    //                           Pre-fills the booking dialog; the packer may edit
    //                           it per booking. Distinct from fourpx_sender (the
    //                           shipper printed on the label).
    // fourpx_pickup_booking:    set false to hide the feature entirely.
    // fourpx_pickup_timezone:   IANA zone the pickup CALENDAR is read in. 4PX
    //                           interprets reserve_time as a local date at the
    //                           pickup address, so a dashboard running in another
    //                           zone must not use its own "today".
    // fourpx_pickup_max_days_ahead: how far out the date picker offers, in days
    //                           including today (matches 4PX's own picker).
    // fourpx_pickup_awaiting_days: how recently a parcel must have been sealed to
    //                           count as still waiting for a driver. "4PX has not
    //                           scanned it" alone is not enough — a parcel handed
    //                           over months ago whose tracking never resolved still
    //                           reads as unscanned, and counting those turns the
    //                           pickup bar into a number nobody believes.
    fourpx_pickup:           normalizeFourpxPickup(raw.fourpx_pickup),
    fourpx_pickup_booking:   raw.fourpx_pickup_booking === false ? false : true,
    fourpx_pickup_timezone:  normalizeFourpxPickupTimezone(raw.fourpx_pickup_timezone),
    fourpx_pickup_max_days_ahead: raw.fourpx_pickup_max_days_ahead == null
                               ? DEFAULT_MAX_DAYS_AHEAD
                               : normalizeMaxDaysAhead(raw.fourpx_pickup_max_days_ahead),
    fourpx_pickup_awaiting_days: normalizeAwaitingDays(raw.fourpx_pickup_awaiting_days),

    // ── Growth data collection ─────────────────────────────────────────────────
    // Manual aggregate Stats imports are the safe default and need no Etsy call.
    // The Aug 18 2026 API Terms require Etsy's written authorization before API
    // content is requested for analytics. Both booleans must be explicitly true;
    // the compliance guard rejects a sync flag without the approval attestation.
    // Growth is manual-first. Merely opening the tab never calls Etsy, and the
    // optional catalog walk stays OFF unless the operator explicitly opts in.
    etsy_multi_key_approved: raw.etsy_multi_key_approved === true,
    catalog_health_sync: raw.catalog_health_sync === true,
    etsy_api_analytics_approved: raw.etsy_api_analytics_approved === true,
    catalog_health_interval_hours: typeof raw.catalog_health_interval_hours === 'number'
      ? Math.max(12, Math.min(168, Math.floor(raw.catalog_health_interval_hours)))
      : 24,

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
    // Shipping tab upstream silence / carrier-acceptance threshold. Destination
    // stages receive a longer derived grace period. Bounded to 3–30 days.
    fourpx_stuck_days: typeof raw.fourpx_stuck_days === 'number' && raw.fourpx_stuck_days > 0
                               ? Math.min(30, Math.max(3, Math.round(raw.fourpx_stuck_days))) : 10,

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
    // The 4PX pickup appointment form (打印预约单) prints through this same block:
    // 4PX issues it as a 95 × 95 mm square barcode label, not an office document,
    // so it belongs on the same stock and the same 1-bit crisp path. Giving it
    // its own printer settings would only create a second thing to misconfigure.

    // ── EU IOSS / VAT compliance ───────────────────────────────────────────────
    // fourpx_ioss_no:  Import One-Stop Shop (IOSS) registration number used for
    //                  EU-bound parcels with a declared value ≤ €150. 4PX maps it
    //                  to the order's `ioss_no` field (per the official model). For
    //                  marketplace sales the platform's IOSS number is used (e.g.
    //                  Etsy's). The server attaches it automatically to every EU27
    //                  destination so customs clears the parcel as VAT-prepaid.
    //                  Format: "IM" + 10 digits (12 chars, no spaces).
    //                  Leave null to use the registry value in
    //                  src/compliance/destination-tax.js.
    // fourpx_vat_no / fourpx_eori_no: optional EU VAT / EORI identifiers, attached
    //                  to EU destinations when present.
    fourpx_ioss_no:          (raw.fourpx_ioss_no && String(raw.fourpx_ioss_no).trim()) || null,
    fourpx_vat_no:           (raw.fourpx_vat_no  && String(raw.fourpx_vat_no).trim())  || null,
    fourpx_eori_no:          (raw.fourpx_eori_no && String(raw.fourpx_eori_no).trim()) || null,

    // ── Marketplace import-tax identifiers (packing bench + customs data) ──────
    // Etsy collects VAT/GST at checkout for the EU, UK, Norway, Switzerland,
    // Australia and New Zealand, and the parcel has to carry its registration
    // number for the destination or the buyer is billed a second time on
    // delivery. src/compliance/destination-tax.js ships a reviewed value for
    // every scheme; this block overrides one when Etsy changes a number (or when
    // selling through a different marketplace) without waiting for a code change.
    //
    //   "marketplace_tax_ids": { "UK_VAT": "370 6004 28", "EU_IOSS": "IM3720000224" }
    //
    // Keys: EU_IOSS, UK_VAT, NO_VOEC, CH_VAT, AU_GST, NZ_GST. Each value is
    // format- and checksum-validated at load; an entry that fails is ignored with
    // a warning and the built-in value is used, because a mistyped tax number
    // written onto every parcel is worse than a stale one.
    marketplace_tax_ids:     marketplaceTaxIds,
    // 4PX requires an email on Etsy-origin shipments. Prefer the buyer email
    // captured on the receipt; this explicit shop contact is the fallback when
    // Etsy does not return one for the account/region.
    fourpx_default_recipient_email:
      (raw.fourpx_default_recipient_email && String(raw.fourpx_default_recipient_email).trim()) || null,

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
    route_engine_data_dir: raw.route_engine_data_dir
      ? resolveConfigPath(raw.route_engine_data_dir)
      : null,
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
 * Canonical predicate for the auto-restock write path.
 *
 * loadConfig() already coerces the raw JSON with `=== true` (missing/invalid
 * values become false). Every restock call site must use this helper so a
 * future default change cannot silently re-enable Etsy inventory PUTs.
 *
 * @param {AppConfig|object|null|undefined} config
 * @returns {boolean}
 */
function isAutoRestockEnabled(config) {
  return config != null && config.auto_restock_enabled === true;
}

/**
 * Keys an operator may change at runtime without a process restart.
 * Secrets, shop topology, and proxy settings are intentionally absent —
 * those still require an edit + reload/restart.
 */
const RUNTIME_PATCHABLE = Object.freeze({
  auto_restock_enabled: (v) => v === true || v === false,
  restock_quantity: (v) => Number.isInteger(v) && v >= 1 && v <= 999,
});

/**
 * Atomic JSON write (temp + fsync + rename), same durability contract as
 * TokenManager._save. On Windows rename-over-existing is supported by Node.
 *
 * @param {string} destPath
 * @param {object} value
 */
function atomicWriteJson(destPath, value) {
  const dir = path.dirname(destPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(
    dir,
    `.${path.basename(destPath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );
  let fd = null;
  try {
    fd = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, destPath);
    try { fs.chmodSync(destPath, 0o600); } catch { /* platform/filesystem */ }
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch { /* best effort */ }
  }
}

/**
 * Persist a small allowlisted patch to config.json and return the reloaded
 * AppConfig. Rolls back the file if the patched JSON fails validation.
 *
 * @param {Record<string, unknown>} partial
 * @returns {AppConfig}
 */
function patchRuntimeSettings(partial) {
  if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
    throw new Error('patchRuntimeSettings: expected an object of settings');
  }

  const allowed = {};
  for (const [key, value] of Object.entries(partial)) {
    const check = RUNTIME_PATCHABLE[key];
    if (!check) {
      throw new Error(`Cannot patch config key "${key}" at runtime`);
    }
    if (!check(value)) {
      throw new Error(`Invalid value for ${key}`);
    }
    allowed[key] = value;
  }
  if (!Object.keys(allowed).length) {
    throw new Error('No settings to patch');
  }

  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`config.json not found at ${CONFIG_PATH}`);
  }

  const rawText = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
  let raw;
  try {
    raw = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`config.json is not valid JSON: ${err.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('config.json: top-level value must be an object');
  }

  const next = { ...raw, ...allowed };
  const backupPath = `${CONFIG_PATH}.bak-${process.pid}`;
  fs.copyFileSync(CONFIG_PATH, backupPath);
  try {
    atomicWriteJson(CONFIG_PATH, next);
    const loaded = loadConfig();
    try { fs.unlinkSync(backupPath); } catch { /* best effort */ }
    return loaded;
  } catch (err) {
    try { fs.copyFileSync(backupPath, CONFIG_PATH); } catch { /* best effort */ }
    try { fs.unlinkSync(backupPath); } catch { /* best effort */ }
    throw err;
  }
}

/**
 * Re-read config.json into an existing in-memory object so every holder of
 * that reference (HTTP handlers, embedded cron, standalone worker) sees the
 * new values without a process restart. On parse/validation failure the
 * previous object is left untouched.
 *
 * @param {AppConfig} config
 * @returns {AppConfig}
 */
function refreshConfigInPlace(config) {
  if (!config || typeof config !== 'object') return config;
  try {
    const fresh = loadConfig();
    for (const key of Object.keys(config)) {
      if (!Object.prototype.hasOwnProperty.call(fresh, key)) delete config[key];
    }
    Object.assign(config, fresh);
  } catch (err) {
    console.warn(`[config] reload skipped, keeping previous: ${err.message}`);
  }
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
      // Legacy operator metadata; never used as authorization or to automate Etsy.
      adspower_profile_id: shop.adspower_profile_id ?? group.adspower_profile_id ?? null,
    }))
  );
}

module.exports = {
  loadConfig,
  isAutoRestockEnabled,
  patchRuntimeSettings,
  refreshConfigInPlace,
  findShopContext,
  getAllShops,
  usesGroupProxy,
  resolveConfigPath,
  defaultDbPath,
};
