'use strict';

/**
 * SQLite database setup and access layer.
 *
 * Uses better-sqlite3 (synchronous API) which is ideal for a local single-user
 * application — no connection pooling needed, zero-latency reads from UI.
 *
 * Schema:
 *   groups      — your 4 proxy-isolated shop groups
 *   shops       — all 20 shops, each belonging to a group
 *   receipts    — Etsy orders (one receipt = one order/transaction set)
 *   transactions— line items within a receipt
 *   sync_log    — history of every background sync attempt
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

/** @type {Database.Database | null} */
let _db = null;

/**
 * Initialize the database at the given path.
 * Creates the file and all tables if they don't exist.
 * Safe to call on every startup — uses IF NOT EXISTS throughout.
 *
 * @param {string} dbPath - Absolute path to the .db file
 * @returns {Database.Database}
 */
function initDb(dbPath) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);

  // WAL mode: allows concurrent reads while a write is in progress.
  // Critical for the sync worker writing while the UI reads.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    -- ─────────────────────────────────────────────
    -- Groups table: your 4 proxy-isolated groups
    -- ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS groups (
      group_id    TEXT PRIMARY KEY,
      label       TEXT NOT NULL,
      proxy_host  TEXT,
      created_at  INTEGER DEFAULT (strftime('%s', 'now'))
    );

    -- ─────────────────────────────────────────────
    -- Shops table: all 20 Etsy shops
    -- ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS shops (
      shop_id       TEXT PRIMARY KEY,
      group_id      TEXT NOT NULL REFERENCES groups(group_id),
      shop_name     TEXT NOT NULL,
      last_synced_at INTEGER,
      total_orders  INTEGER DEFAULT 0,
      created_at    INTEGER DEFAULT (strftime('%s', 'now'))
    );

    -- ─────────────────────────────────────────────
    -- Receipts: one per Etsy order
    -- ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS receipts (
      receipt_id        INTEGER PRIMARY KEY,
      shop_id           TEXT NOT NULL REFERENCES shops(shop_id),
      group_id          TEXT NOT NULL,
      buyer_user_id     INTEGER,
      buyer_email       TEXT,
      name              TEXT,
      status            TEXT,
      is_shipped        INTEGER DEFAULT 0,
      is_paid           INTEGER DEFAULT 0,
      grandtotal_amount REAL,
      grandtotal_currency TEXT,
      subtotal_amount   REAL,
      discount_amount   REAL,
      shipping_cost     REAL,
      total_tax_cost    REAL,
      message_from_buyer TEXT,
      message_from_seller TEXT,
      shipment_details  TEXT,
      etsy_created_at   INTEGER,
      etsy_updated_at   INTEGER,
      synced_at         INTEGER DEFAULT (strftime('%s', 'now')),
      raw_json          TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_receipts_shop_id ON receipts(shop_id);
    CREATE INDEX IF NOT EXISTS idx_receipts_group_id ON receipts(group_id);
    CREATE INDEX IF NOT EXISTS idx_receipts_status ON receipts(status);
    CREATE INDEX IF NOT EXISTS idx_receipts_etsy_created ON receipts(etsy_created_at DESC);

    -- ─────────────────────────────────────────────
    -- Transactions: line items within a receipt
    -- ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS transactions (
      transaction_id    INTEGER PRIMARY KEY,
      receipt_id        INTEGER NOT NULL REFERENCES receipts(receipt_id),
      shop_id           TEXT NOT NULL,
      listing_id        INTEGER,
      title             TEXT,
      quantity          INTEGER,
      price_amount      REAL,
      price_currency    TEXT,
      variations        TEXT,
      raw_json          TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_receipt ON transactions(receipt_id);

    -- ─────────────────────────────────────────────
    -- Sync log: audit trail of every sync attempt
    -- ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS sync_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id         TEXT NOT NULL,
      group_id        TEXT NOT NULL,
      started_at      INTEGER NOT NULL,
      completed_at    INTEGER,
      receipts_synced INTEGER DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'running',
      egress_ip       TEXT,
      error_message   TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sync_log_shop ON sync_log(shop_id, started_at DESC);

    -- ─────────────────────────────────────────────
    -- Listing image cache: listing_id → thumbnail URL
    -- Populated by the sync worker; avoids re-fetching on every cycle.
    -- ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS listing_images (
      listing_id INTEGER PRIMARY KEY,
      url        TEXT,
      cached_at  INTEGER DEFAULT (strftime('%s', 'now'))
    );

    -- ─────────────────────────────────────────────
    -- Listings cache — synced on-demand from the Listings tab
    -- ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS listings (
      listing_id           INTEGER PRIMARY KEY,
      shop_id              TEXT    NOT NULL,
      title                TEXT,
      description          TEXT,
      price_amount         REAL,
      price_currency       TEXT,
      quantity             INTEGER,
      state                TEXT,
      views                INTEGER DEFAULT 0,
      num_favorers         INTEGER DEFAULT 0,
      tags                 TEXT,
      primary_image_url    TEXT,
      listing_url          TEXT,
      taxonomy_id          INTEGER,
      shipping_profile_id  INTEGER,
      return_policy_id     INTEGER,
      who_made             TEXT,
      when_made            TEXT,
      is_customizable      INTEGER DEFAULT 0,
      created_timestamp    INTEGER,
      updated_timestamp    INTEGER,
      synced_at            INTEGER DEFAULT (strftime('%s', 'now'))
    );

    -- ─────────────────────────────────────────────
    -- Listing inventory — per-product (variation combination) stock levels
    -- One row per Etsy "product" (which is one variation combination, e.g. Style×Model)
    -- ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS listing_inventory (
      listing_id        INTEGER  NOT NULL,
      product_id        INTEGER  NOT NULL,
      offering_id       INTEGER,
      style_value       TEXT,            -- extracted from property_values where property_name='Style'
      secondary_value   TEXT,            -- second dimension value if present (e.g. iPhone Model)
      property_values   TEXT,            -- JSON — full array of property_values objects
      quantity          INTEGER  NOT NULL DEFAULT 0,
      is_enabled        INTEGER  NOT NULL DEFAULT 1,
      price_amount      REAL,
      price_currency    TEXT,
      synced_at         INTEGER  DEFAULT (strftime('%s', 'now')),
      PRIMARY KEY (listing_id, product_id)
    );

    -- ─────────────────────────────────────────────
    -- Events log — auto-restock, zero-stock alerts, manual actions
    -- ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type      TEXT    NOT NULL,  -- ZERO_STOCK | AUTO_RESTOCK | ORDER_RESTOCK | RESTOCK_FAILED | MANUAL_RESTOCK | INV_SYNC | LOW_STOCK
      shop_name       TEXT,
      listing_id      INTEGER,
      listing_title   TEXT,
      style_value     TEXT,
      detail          TEXT,              -- human-readable message
      meta            TEXT,              -- JSON — extra structured data
      created_at      INTEGER  DEFAULT (strftime('%s', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_events_type    ON events(event_type);

    -- ─────────────────────────────────────────────
    -- Conversations: Etsy buyer/seller message threads
    -- Populated by the conversation sync pass (server cron + manual trigger).
    -- NOTE: Etsy's public v3 API does not expose conversations.
    -- These are synced via Etsy's undocumented internal v3 endpoints,
    -- which require the conversations_r / conversations_w OAuth scopes.
    -- ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS conversations (
      convo_id          TEXT    PRIMARY KEY,
      shop_id           TEXT    NOT NULL REFERENCES shops(shop_id),
      group_id          TEXT    NOT NULL,
      buyer_user_id     INTEGER,
      buyer_name        TEXT,
      subject           TEXT,
      status            TEXT    DEFAULT 'unread',
      unread_count      INTEGER DEFAULT 0,
      last_message_at   INTEGER,
      linked_receipt_id INTEGER,
      synced_at         INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_convos_shop_time ON conversations(shop_id, last_message_at DESC);
    CREATE INDEX IF NOT EXISTS idx_convos_status    ON conversations(status);

    -- ─────────────────────────────────────────────
    -- Conversation messages: individual messages within a thread
    -- ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS conversation_messages (
      message_id   TEXT    PRIMARY KEY,
      convo_id     TEXT    NOT NULL REFERENCES conversations(convo_id),
      shop_id      TEXT    NOT NULL,
      sender_type  TEXT    NOT NULL,  -- 'buyer' | 'seller'
      body         TEXT,
      created_at   INTEGER,
      read_at      INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_convo_msgs_convo ON conversation_messages(convo_id, created_at);

    -- ─────────────────────────────────────────────
    -- Route assignments — the human-in-the-loop layer for the Shopping Route
    -- Generator (replaces the OSP Tkinter "Orders Dashboard").
    --
    -- One row per order line-item, keyed by (receipt_id, item_key) where
    -- item_key = normalize(title)[:50] — the SAME key OSP uses for its status
    -- cache and de-duplication.  This survives re-syncs (title is stable) and
    -- maps 1:1 onto OSP's route_statuses_cache.json keys.
    --
    --   charm_code / charm_shop  — manual charm assignment (overrides catalog)
    --   status_* (case/grip/charm)— Pending | Purchased | Out of Stock | Out of Production
    --   excluded                  — 1 = drop this line from the next route
    -- ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS route_assignments (
      receipt_id   INTEGER NOT NULL,
      item_key     TEXT    NOT NULL,
      title        TEXT,
      charm_code   TEXT    DEFAULT '',
      charm_shop   TEXT    DEFAULT '',
      status_case  TEXT    DEFAULT 'Pending',
      status_grip  TEXT    DEFAULT 'Pending',
      status_charm TEXT    DEFAULT 'Pending',
      excluded     INTEGER DEFAULT 0,
      updated_at   INTEGER DEFAULT (strftime('%s','now')),
      PRIMARY KEY (receipt_id, item_key)
    );

    -- ─────────────────────────────────────────────────────────────────
    -- product_assignments: remember supplier + charm per product title
    --   item_key = normalised 50-char title hash (same as route_assignments)
    --   These are applied as defaults for NEW orders so the user never
    --   has to re-assign a well-known product's supplier or charm.
    -- ─────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS product_assignments (
      item_key       TEXT    PRIMARY KEY,
      title          TEXT,
      supplier_shop  TEXT    DEFAULT '',
      supplier_stall TEXT    DEFAULT '',
      charm_code     TEXT    DEFAULT '',
      charm_shop     TEXT    DEFAULT '',
      updated_at     INTEGER DEFAULT (strftime('%s','now'))
    );

    -- ─────────────────────────────────────────────────────────────────
    -- supplier_directory: the authoritative master list of supplier shops,
    --   imported from supplier_catalog.xlsx → "Suppliers" sheet.
    --   Drives the supplier picker so the user always chooses from the
    --   exact, real shop names + stall locations.
    -- ─────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS supplier_directory (
      shop_name  TEXT NOT NULL,
      stall      TEXT DEFAULT '',
      mall       TEXT DEFAULT '',
      floor      TEXT DEFAULT '',
      address    TEXT DEFAULT '',
      notes      TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT (strftime('%s','now')),
      PRIMARY KEY (shop_name, stall)
    );

    -- ─────────────────────────────────────────────────────────────────
    -- product_map: authoritative product-title → supplier + charm mapping
    --   imported from supplier_catalog.xlsx → "Product Map" sheet.
    --   Lower priority than manual product_assignments but higher than
    --   OSP catalog (PDF-parsed guesses).  Full replace on each import.
    -- ─────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS product_map (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title_norm  TEXT    NOT NULL UNIQUE,
      title       TEXT    NOT NULL DEFAULT '',
      shop_name   TEXT    DEFAULT '',
      stall       TEXT    DEFAULT '',
      charm_shop  TEXT    DEFAULT '',
      charm_code  TEXT    DEFAULT '',
      sort_order  INTEGER DEFAULT 0,
      updated_at  INTEGER DEFAULT (strftime('%s','now'))
    );

    -- ─────────────────────────────────────────────────────────────────
    -- charm_shop_directory: master list of charm shops, imported from
    --   supplier_catalog.xlsx → "Charm Shops" sheet (exact name + stall).
    -- ─────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS charm_shop_directory (
      shop_name  TEXT NOT NULL,
      stall      TEXT DEFAULT '',
      notes      TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT (strftime('%s','now')),
      PRIMARY KEY (shop_name, stall)
    );

    -- ─────────────────────────────────────────────────────────────────
    -- charm_library: UED-authoritative list of physical charms, seeded
    --   from OSP's charm_manifest.json then editable in-app (CRUD).
    --   Images live in <osp_project_dir>/data/charm_images/<image_file>.
    -- ─────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS charm_library (
      code               TEXT PRIMARY KEY,
      sku                TEXT DEFAULT '',
      default_charm_shop TEXT DEFAULT '',
      notes              TEXT DEFAULT '',
      image_file         TEXT DEFAULT '',
      sort_order         INTEGER DEFAULT 0,
      updated_at         INTEGER DEFAULT (strftime('%s','now'))
    );
  `);

  // ── Migrations ────────────────────────────────────────────────────────────
  // SQLite doesn't support ALTER TABLE ADD COLUMN IF NOT EXISTS, so we check
  // the column list manually and only add if missing.

  const syncLogCols = db.pragma('table_info(sync_log)').map((c) => c.name);
  if (!syncLogCols.includes('egress_ip')) {
    db.exec(`ALTER TABLE sync_log ADD COLUMN egress_ip TEXT`);
  }

  // Shipping address + product columns on receipts — added after initial release.
  const receiptCols = db.pragma('table_info(receipts)').map((c) => c.name);
  const newReceiptCols = [
    ['shipping_first_line',  'TEXT'],
    ['shipping_second_line', 'TEXT'],
    ['shipping_city',        'TEXT'],
    ['shipping_state',       'TEXT'],
    ['shipping_zip',         'TEXT'],
    ['shipping_country_iso', 'TEXT'],
    ['first_product_title',  'TEXT'],
    ['first_listing_id',     'INTEGER'],
    ['first_quantity',       'INTEGER'],
    ['first_ship_by',        'INTEGER'],
    ['first_variations',     'TEXT'],
    ['all_transactions',       'TEXT'],
    ['formatted_address',      'TEXT'],
    // App-level team note — stored locally only, not synced to Etsy
    ['team_note',              'TEXT'],
    // Shipment tracking (extracted from receipt.shipments[0])
    ['tracking_code',          'TEXT'],
    ['carrier_name',           'TEXT'],
    // Legacy column — was_shipped does not exist in Etsy v3 API (ShopReceiptShipment schema
    // has no such field). This column is always 0 and retained only for schema compatibility.
    ['shipment_was_shipped',   'INTEGER'],
    // Exact Unix epoch when Etsy sent the buyer the shipment notification =
    // the moment the shipping label was created. Sourced from
    // shipments[0].shipment_notification_timestamp in the Etsy v3 API response.
    // Used as the authoritative "label created at" timestamp for pre-transit detection.
    ['shipment_notified_at',   'INTEGER'],
    // Unix epoch when the carrier (e.g. 4PX) confirmed receipt of the package (first scan).
    // NULL = package not yet confirmed by carrier = genuinely Pre-transit.
    // Populated by the carrier tracking checker (src/tracking/checker.js) called from
    // the sync worker. The pre-transit filter uses carrier_confirmed_at IS NULL as its
    // primary signal — once this is set, the order moves from Pre-transit to In-transit.
    ['carrier_confirmed_at',   'INTEGER'],
    // Unix epoch when we last successfully called the carrier tracking API for this receipt.
    // Used to avoid re-checking too frequently (rate limiting). NULL = never checked.
    // Re-checked every TRACKING_RECHECK_HOURS (see sync worker) once confirmed_at is set.
    ['tracking_checked_at',    'INTEGER'],

    // ── 4PX Order Creation Integration ────────────────────────────────────────
    // Populated by the dashboard's "Create 4PX Shipment" feature (Pass via /api/4px/create-order).
    // NULL on all columns = no 4PX order has been created through the dashboard yet.

    // 4PX internal consignment number (ds_consignment_no from ds.xms.order.create response).
    // Used for label retrieval (ds.xms.label.get) and order cancellation (ds.xms.order.cancel).
    ['fourpx_consignment_no',  'TEXT'],
    // 4PX public tracking number (4px_tracking_no) — this is what gets shared with the buyer
    // and what's used for tracking queries. Distinct from ds_consignment_no.
    ['fourpx_tracking_no',     'TEXT'],
    // URL to the shipping label PDF/IMG as returned by ds.xms.label.get.
    // Cached here to avoid re-calling the 4PX label API on every page load.
    ['fourpx_label_url',       'TEXT'],
    // Lifecycle status of the 4PX order created through our dashboard.
    // Values: 'created' | 'label_fetched' | 'cancelled' | 'error'
    ['fourpx_order_status',    'TEXT'],
    // Unix epoch when the 4PX order was created via the dashboard. Immutable once set.
    ['fourpx_created_at',      'INTEGER'],
  ];
  const addedCols = [];
  for (const [col, type] of newReceiptCols) {
    if (!receiptCols.includes(col)) {
      db.exec(`ALTER TABLE receipts ADD COLUMN ${col} ${type}`);
      addedCols.push(col);
    }
  }

  // Backfill the new columns from raw_json for all existing receipts.
  if (addedCols.length > 0) {
    const rows = db.prepare('SELECT receipt_id, raw_json FROM receipts WHERE raw_json IS NOT NULL').all();
    const stmt = db.prepare(`
      UPDATE receipts SET
        shipping_first_line  = @first_line,
        shipping_second_line = @second_line,
        shipping_city        = @city,
        shipping_state       = @state,
        shipping_zip         = @zip,
        shipping_country_iso = @country_iso,
        first_product_title  = @title,
        first_listing_id     = @listing_id,
        first_quantity       = @quantity,
        first_ship_by        = @ship_by,
        first_variations     = @variations,
        all_transactions     = @all_transactions,
        formatted_address    = @formatted_address,
        tracking_code        = @tracking_code,
        carrier_name         = @carrier_name,
        shipment_was_shipped = @shipment_was_shipped,
        shipment_notified_at = @shipment_notified_at
      WHERE receipt_id = @receipt_id
    `);
    const backfill = db.transaction(() => {
      for (const row of rows) {
        try {
          const r = JSON.parse(row.raw_json);
          const txs = Array.isArray(r.transactions) ? r.transactions : [];
          const tx = txs[0] ?? null;
          const ship = Array.isArray(r.shipments) ? r.shipments[0] : null;
          stmt.run({
            receipt_id:  row.receipt_id,
            first_line:  r.first_line  ?? null,
            second_line: r.second_line ?? null,
            city:        r.city        ?? null,
            state:       r.state       ?? null,
            zip:         r.zip         ?? null,
            country_iso: r.country_iso ?? null,
            title:       tx?.title      ?? null,
            listing_id:  tx?.listing_id ?? null,
            quantity:    tx?.quantity   ?? null,
            ship_by:     tx?.expected_ship_date ?? null,
            variations:  tx?.variations ? JSON.stringify(tx.variations) : null,
            all_transactions: txs.length > 0 ? JSON.stringify(txs.map(t => ({
              listing_id: t.listing_id ?? null,
              title:      t.title      ?? null,
              quantity:   t.quantity   ?? null,
              expected_ship_date: t.expected_ship_date ?? null,
              variations: t.variations ?? [],
            }))) : null,
            formatted_address:    r.formatted_address ?? null,
            tracking_code:        ship?.tracking_code   ?? null,
            carrier_name:         ship?.carrier_name    ?? null,
            // was_shipped does not exist in Etsy v3 API; retained for schema compatibility only
            shipment_was_shipped: ship != null ? (ship.was_shipped ? 1 : 0) : null,
            shipment_notified_at: ship?.shipment_notification_timestamp ?? null,
          });
        } catch { /* skip malformed rows */ }
      }
    });
    backfill();
  }

  // Create the shipment_notified_at index now that the column is guaranteed to exist
  // (either it was just added above, or it was already in the schema from a previous run).
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_receipts_notified_at       ON receipts(shipment_notified_at DESC);
    CREATE INDEX IF NOT EXISTS idx_receipts_carrier_confirmed ON receipts(carrier_confirmed_at);
    CREATE INDEX IF NOT EXISTS idx_receipts_tracking_checked  ON receipts(tracking_checked_at);
    CREATE INDEX IF NOT EXISTS idx_receipts_fourpx_consignment ON receipts(fourpx_consignment_no)
  `);

  // If shipment_notified_at already exists but wasn't populated during the backfill
  // (e.g., column existed but was NULL), backfill it from raw_json now.
  const nullNotified = db.prepare(`
    SELECT COUNT(*) as cnt FROM receipts
    WHERE shipment_notified_at IS NULL AND is_shipped = 1
    AND raw_json LIKE '%shipment_notification_timestamp%'
  `).get();
  if (nullNotified.cnt > 0) {
    const rows = db.prepare(`
      SELECT receipt_id, raw_json FROM receipts
      WHERE shipment_notified_at IS NULL AND is_shipped = 1 AND raw_json IS NOT NULL
    `).all();
    const upd = db.prepare(`
      UPDATE receipts SET shipment_notified_at = ? WHERE receipt_id = ?
    `);
    const fill = db.transaction(() => {
      for (const row of rows) {
        try {
          const raw = JSON.parse(row.raw_json);
          const ship = Array.isArray(raw.shipments) ? raw.shipments[0] : null;
          const ts = ship?.shipment_notification_timestamp ?? null;
          if (ts) upd.run(ts, row.receipt_id);
        } catch { /* skip */ }
      }
    });
    fill();
    console.log(`[db] Backfilled shipment_notified_at for ${nullNotified.cnt} receipt(s)`);
  }

  // ── route_assignments migrations ─────────────────────────────────────────
  // Add new columns that weren't in the original CREATE TABLE.
  const routeCols = db.pragma('table_info(route_assignments)').map(c => c.name);
  const newRouteCols = [
    // Manual supplier overrides — let the user correct a wrong catalog match
    // or fill in a supplier for items not yet in the OSP catalog.
    ['supplier_shop_override', 'TEXT', "''"],
    ['supplier_stall_override', 'TEXT', "''"],
  ];
  for (const [col, type, dflt] of newRouteCols) {
    if (!routeCols.includes(col)) {
      db.exec(`ALTER TABLE route_assignments ADD COLUMN ${col} ${type} DEFAULT ${dflt}`);
    }
  }

  // sort_order for supplier_directory — preserves the Excel row order
  const supDirCols = db.pragma('table_info(supplier_directory)').map(c => c.name);
  if (!supDirCols.includes('sort_order')) {
    db.exec('ALTER TABLE supplier_directory ADD COLUMN sort_order INTEGER DEFAULT 0');
  }

  // sort_order for charm_shop_directory — preserves the Excel / insertion order
  const charmDirCols = db.pragma('table_info(charm_shop_directory)').map(c => c.name);
  if (!charmDirCols.includes('sort_order')) {
    db.exec('ALTER TABLE charm_shop_directory ADD COLUMN sort_order INTEGER DEFAULT 0');
  }

  _db = db;
  return db;
}

/**
 * Get the active database instance.
 * Throws if initDb() has not been called yet.
 * @returns {Database.Database}
 */
function getDb() {
  if (!_db) throw new Error('Database not initialized. Call initDb() first.');
  return _db;
}

/**
 * Upsert a group record from config.
 * @param {Database.Database} db
 * @param {{ group_id: string, label: string, proxy: string }} group
 */
function upsertGroup(db, group) {
  const { usesGroupProxy } = require('../config/schema');
  const proxyHost = (() => {
    if (!usesGroupProxy(group)) return 'direct';
    try {
      return new URL(group.proxy).hostname;
    } catch {
      return group.proxy;
    }
  })();

  db.prepare(`
    INSERT INTO groups (group_id, label, proxy_host)
    VALUES (@group_id, @label, @proxy_host)
    ON CONFLICT(group_id) DO UPDATE SET
      label      = excluded.label,
      proxy_host = excluded.proxy_host
  `).run({ group_id: group.group_id, label: group.label, proxy_host: proxyHost });
}

/**
 * Upsert a shop record from config.
 * @param {Database.Database} db
 * @param {{ shop_id: string, shop_name: string, group_id: string }} shop
 */
function upsertShop(db, shop) {
  db.prepare(`
    INSERT INTO shops (shop_id, group_id, shop_name)
    VALUES (@shop_id, @group_id, @shop_name)
    ON CONFLICT(shop_id) DO UPDATE SET
      shop_name = excluded.shop_name,
      group_id  = excluded.group_id
  `).run({ shop_id: shop.shop_id, group_id: shop.group_id, shop_name: shop.shop_name });
}

/**
 * Sync config groups and shops into the database on startup.
 * Ensures DB reflects any changes made to config.json.
 *
 * @param {Database.Database} db
 * @param {import('../config/schema').AppConfig} config
 */
function syncConfigToDb(db, config) {
  const upsertAll = db.transaction(() => {
    for (const group of config.groups) {
      upsertGroup(db, group);
      for (const shop of group.shops) {
        upsertShop(db, { ...shop, group_id: group.group_id });
      }
    }
  });
  upsertAll();
}

/**
 * Save or update a receipt (order) fetched from Etsy API.
 * Uses INSERT OR REPLACE so re-syncing the same receipt updates it in place.
 *
 * @param {Database.Database} db
 * @param {string} shopId
 * @param {string} groupId
 * @param {object} receipt - Raw receipt object from Etsy API response
 */
function upsertReceipt(db, shopId, groupId, receipt) {
  // Etsy Money objects: { amount: integer, divisor: integer, currency_code: string }
  // divisor is the actual divisor (e.g. 100 → divide by 100), NOT an exponent.
  const money = (obj) => (obj && obj.divisor ? obj.amount / obj.divisor : null);
  const currency = (obj) => (obj ? obj.currency_code : null);

  const firstTx   = Array.isArray(receipt.transactions) && receipt.transactions.length > 0
    ? receipt.transactions[0]
    : null;
  const firstShip = Array.isArray(receipt.shipments) && receipt.shipments.length > 0
    ? receipt.shipments[0]
    : null;

  db.prepare(`
    INSERT INTO receipts (
      receipt_id, shop_id, group_id,
      buyer_user_id, buyer_email, name,
      status, is_shipped, is_paid,
      grandtotal_amount, grandtotal_currency,
      subtotal_amount, discount_amount,
      shipping_cost, total_tax_cost,
      message_from_buyer, message_from_seller,
      shipping_first_line, shipping_second_line,
      shipping_city, shipping_state, shipping_zip, shipping_country_iso,
      first_product_title, first_listing_id,
      first_quantity, first_ship_by, first_variations,
      all_transactions, formatted_address,
      tracking_code, carrier_name, shipment_was_shipped, shipment_notified_at,
      etsy_created_at, etsy_updated_at,
      synced_at, raw_json
    ) VALUES (
      @receipt_id, @shop_id, @group_id,
      @buyer_user_id, @buyer_email, @name,
      @status, @is_shipped, @is_paid,
      @grandtotal_amount, @grandtotal_currency,
      @subtotal_amount, @discount_amount,
      @shipping_cost, @total_tax_cost,
      @message_from_buyer, @message_from_seller,
      @shipping_first_line, @shipping_second_line,
      @shipping_city, @shipping_state, @shipping_zip, @shipping_country_iso,
      @first_product_title, @first_listing_id,
      @first_quantity, @first_ship_by, @first_variations,
      @all_transactions, @formatted_address,
      @tracking_code, @carrier_name, @shipment_was_shipped, @shipment_notified_at,
      @etsy_created_at, @etsy_updated_at,
      strftime('%s', 'now'), @raw_json
    )
    ON CONFLICT(receipt_id) DO UPDATE SET
      status               = excluded.status,
      is_shipped           = excluded.is_shipped,
      is_paid              = excluded.is_paid,
      grandtotal_amount    = excluded.grandtotal_amount,
      message_from_seller  = excluded.message_from_seller,
      shipping_first_line  = excluded.shipping_first_line,
      shipping_second_line = excluded.shipping_second_line,
      shipping_city        = excluded.shipping_city,
      shipping_state       = excluded.shipping_state,
      shipping_zip         = excluded.shipping_zip,
      shipping_country_iso = excluded.shipping_country_iso,
      first_product_title  = excluded.first_product_title,
      first_listing_id     = excluded.first_listing_id,
      first_quantity       = excluded.first_quantity,
      first_ship_by        = excluded.first_ship_by,
      first_variations     = excluded.first_variations,
      all_transactions     = excluded.all_transactions,
      formatted_address    = excluded.formatted_address,
      tracking_code        = excluded.tracking_code,
      carrier_name         = excluded.carrier_name,
      shipment_was_shipped = excluded.shipment_was_shipped,
      -- Only update shipment_notified_at when it is newly set; never overwrite a real
      -- timestamp with NULL (re-sync may omit the shipments array for non-shipped orders).
      shipment_notified_at = COALESCE(excluded.shipment_notified_at, shipment_notified_at),
      -- Never overwrite a carrier confirmation once written — external tracking sets this
      -- once and it should survive subsequent receipt re-syncs from Etsy.
      carrier_confirmed_at = COALESCE(carrier_confirmed_at, excluded.carrier_confirmed_at),
      etsy_updated_at      = excluded.etsy_updated_at,
      synced_at            = excluded.synced_at,
      raw_json             = excluded.raw_json
  `).run({
    receipt_id: receipt.receipt_id,
    shop_id: shopId,
    group_id: groupId,
    buyer_user_id: receipt.buyer_user_id ?? null,
    buyer_email: receipt.buyer_email ?? null,
    name: receipt.name ?? null,
    status: receipt.status ?? null,
    is_shipped: receipt.is_shipped ? 1 : 0,
    is_paid: receipt.is_paid ? 1 : 0,
    grandtotal_amount: money(receipt.grandtotal),
    grandtotal_currency: currency(receipt.grandtotal),
    subtotal_amount: money(receipt.subtotal),
    discount_amount: money(receipt.discount_amt),
    shipping_cost: money(receipt.total_shipping_cost),
    total_tax_cost: money(receipt.total_tax_cost),
    message_from_buyer: receipt.message_from_buyer ?? null,
    message_from_seller: receipt.message_from_seller ?? null,
    shipping_first_line:  receipt.first_line  ?? null,
    shipping_second_line: receipt.second_line ?? null,
    shipping_city:        receipt.city        ?? null,
    shipping_state:       receipt.state       ?? null,
    shipping_zip:         receipt.zip         ?? null,
    shipping_country_iso: receipt.country_iso ?? null,
    first_product_title:  firstTx?.title             ?? null,
    first_listing_id:     firstTx?.listing_id         ?? null,
    first_quantity:       firstTx?.quantity            ?? null,
    first_ship_by:        firstTx?.expected_ship_date  ?? null,
    first_variations:     firstTx?.variations ? JSON.stringify(firstTx.variations) : null,
    all_transactions: receipt.transactions?.length > 0
      ? JSON.stringify(receipt.transactions.map((t) => ({
          listing_id:         t.listing_id         ?? null,
          title:              t.title              ?? null,
          quantity:           t.quantity           ?? null,
          expected_ship_date: t.expected_ship_date ?? null,
          variations:         t.variations         ?? [],
        })))
      : null,
    formatted_address:    receipt.formatted_address ?? null,
    tracking_code:        firstShip?.tracking_code  ?? null,
    carrier_name:         firstShip?.carrier_name   ?? null,
    // was_shipped does not exist in Etsy v3 API — always null/0; retained for schema compat
    shipment_was_shipped: firstShip != null ? (firstShip.was_shipped ? 1 : 0) : null,
    // shipment_notification_timestamp: exact epoch when Etsy notified the buyer = label creation time
    shipment_notified_at: firstShip?.shipment_notification_timestamp ?? null,
    etsy_created_at: receipt.create_timestamp ?? null,
    etsy_updated_at: receipt.update_timestamp ?? null,
    raw_json: JSON.stringify(receipt),
  });
}

/**
 * Save or update a transaction (line item) within a receipt.
 * @param {Database.Database} db
 * @param {string} shopId
 * @param {object} transaction - Raw transaction object from Etsy API
 */
function upsertTransaction(db, shopId, transaction) {
  const money = (obj) => (obj ? obj.amount / Math.pow(10, obj.divisor || 2) : null);
  const currency = (obj) => (obj ? obj.currency_code : null);

  db.prepare(`
    INSERT INTO transactions (
      transaction_id, receipt_id, shop_id,
      listing_id, title, quantity,
      price_amount, price_currency, variations, raw_json
    ) VALUES (
      @transaction_id, @receipt_id, @shop_id,
      @listing_id, @title, @quantity,
      @price_amount, @price_currency, @variations, @raw_json
    )
    ON CONFLICT(transaction_id) DO UPDATE SET
      quantity       = excluded.quantity,
      price_amount   = excluded.price_amount,
      variations     = excluded.variations,
      raw_json       = excluded.raw_json
  `).run({
    transaction_id: transaction.transaction_id,
    receipt_id: transaction.receipt_id,
    shop_id: shopId,
    listing_id: transaction.listing_id ?? null,
    title: transaction.title ?? null,
    quantity: transaction.quantity ?? null,
    price_amount: money(transaction.price),
    price_currency: currency(transaction.price),
    variations: transaction.variations ? JSON.stringify(transaction.variations) : null,
    raw_json: JSON.stringify(transaction),
  });
}

/**
 * Write a sync log entry and return its inserted row ID.
 * @param {Database.Database} db
 * @param {string} shopId
 * @param {string} groupId
 * @param {string|null} [egressIp] - Verified exit IP for this group's proxy chain
 * @returns {number} The log entry ID
 */
function startSyncLog(db, shopId, groupId, egressIp = null) {
  const result = db.prepare(`
    INSERT INTO sync_log (shop_id, group_id, started_at, status, egress_ip)
    VALUES (@shop_id, @group_id, strftime('%s', 'now'), 'running', @egress_ip)
  `).run({ shop_id: shopId, group_id: groupId, egress_ip: egressIp });
  return result.lastInsertRowid;
}

/**
 * Mark a sync log entry as completed or failed.
 * @param {Database.Database} db
 * @param {number} logId
 * @param {'success'|'error'} status
 * @param {number} [receiptsSynced=0]
 * @param {string|null} [errorMessage=null]
 */
function finishSyncLog(db, logId, status, receiptsSynced = 0, errorMessage = null) {
  db.prepare(`
    UPDATE sync_log SET
      completed_at    = strftime('%s', 'now'),
      status          = @status,
      receipts_synced = @receipts_synced,
      error_message   = @error_message
    WHERE id = @id
  `).run({ id: logId, status, receipts_synced: receiptsSynced, error_message: errorMessage });
}

/**
 * Update the shop's last_synced_at and total_orders count.
 * @param {Database.Database} db
 * @param {string} shopId
 */
function updateShopSyncTime(db, shopId) {
  db.prepare(`
    UPDATE shops SET
      last_synced_at = strftime('%s', 'now'),
      total_orders   = (SELECT COUNT(*) FROM receipts WHERE shop_id = @shop_id)
    WHERE shop_id = @shop_id
  `).run({ shop_id: shopId });
}

/**
 * Cache a listing image URL.
 * @param {Database.Database} db
 * @param {number} listingId
 * @param {string} url
 */
function upsertListingImage(db, listingId, url) {
  db.prepare(`
    INSERT INTO listing_images (listing_id, url, cached_at)
    VALUES (?, ?, strftime('%s', 'now'))
    ON CONFLICT(listing_id) DO UPDATE SET url = excluded.url, cached_at = excluded.cached_at
  `).run(listingId, url);
}

/**
 * Upsert a listing from the Etsy API response into the local cache.
 * @param {import('better-sqlite3').Database} db
 * @param {string} shopId
 * @param {object} listing - raw Etsy listing object
 */
function upsertListing(db, shopId, listing) {
  const primaryImage = Array.isArray(listing.images) && listing.images.length > 0
    ? listing.images[0].url_570xN || listing.images[0].url_fullxfull || null
    : null;

  db.prepare(`
    INSERT INTO listings (
      listing_id, shop_id, title, description,
      price_amount, price_currency, quantity, state,
      views, num_favorers, tags, primary_image_url, listing_url,
      taxonomy_id, shipping_profile_id, return_policy_id,
      who_made, when_made, is_customizable,
      created_timestamp, updated_timestamp, synced_at
    ) VALUES (
      @listing_id, @shop_id, @title, @description,
      @price_amount, @price_currency, @quantity, @state,
      @views, @num_favorers, @tags, @primary_image_url, @listing_url,
      @taxonomy_id, @shipping_profile_id, @return_policy_id,
      @who_made, @when_made, @is_customizable,
      @created_timestamp, @updated_timestamp, strftime('%s', 'now')
    )
    ON CONFLICT(listing_id) DO UPDATE SET
      title               = excluded.title,
      description         = excluded.description,
      price_amount        = excluded.price_amount,
      price_currency      = excluded.price_currency,
      quantity            = excluded.quantity,
      state               = excluded.state,
      views               = excluded.views,
      num_favorers        = excluded.num_favorers,
      tags                = excluded.tags,
      primary_image_url   = excluded.primary_image_url,
      listing_url         = excluded.listing_url,
      taxonomy_id         = excluded.taxonomy_id,
      shipping_profile_id = excluded.shipping_profile_id,
      return_policy_id    = excluded.return_policy_id,
      who_made            = excluded.who_made,
      when_made           = excluded.when_made,
      is_customizable     = excluded.is_customizable,
      updated_timestamp   = excluded.updated_timestamp,
      synced_at           = strftime('%s', 'now')
  `).run({
    listing_id:          listing.listing_id,
    shop_id:             shopId,
    title:               listing.title || null,
    description:         listing.description || null,
    price_amount:        listing.price ? listing.price.amount / listing.price.divisor : null,
    price_currency:      listing.price ? listing.price.currency_code : null,
    quantity:            listing.quantity ?? null,
    state:               listing.state || null,
    views:               listing.views ?? 0,
    num_favorers:        listing.num_favorers ?? 0,
    tags:                Array.isArray(listing.tags) ? JSON.stringify(listing.tags) : null,
    primary_image_url:   primaryImage,
    listing_url:         listing.url || null,
    taxonomy_id:         listing.taxonomy_id ?? null,
    shipping_profile_id: listing.shipping_profile_id ?? null,
    return_policy_id:    listing.return_policy_id ?? null,
    who_made:            listing.who_made || null,
    when_made:           listing.when_made || null,
    is_customizable:     listing.is_customizable ? 1 : 0,
    created_timestamp:   listing.created_timestamp ?? null,
    updated_timestamp:   listing.updated_timestamp ?? null,
  });
}

/**
 * Upsert one inventory product row (one variation combination).
 * Extracts 'Style' and a secondary property automatically.
 */
function upsertListingInventory(db, listingId, product, offering) {
  const propValues = product.property_values || [];

  // Extract the 'Style' property value (case-insensitive match)
  const styleProp = propValues.find(
    (p) => p.property_name && p.property_name.toLowerCase() === 'style'
  );
  // Extract the secondary property (everything except Style)
  const secondaryProp = propValues.find(
    (p) => p.property_name && p.property_name.toLowerCase() !== 'style'
  );

  const styleVal     = styleProp?.values?.[0] || propValues.map(p => p.values?.[0]).filter(Boolean).join(' / ') || null;
  const secondaryVal = secondaryProp?.values?.[0] || null;

  db.prepare(`
    INSERT INTO listing_inventory
      (listing_id, product_id, offering_id, style_value, secondary_value,
       property_values, quantity, is_enabled, price_amount, price_currency, synced_at)
    VALUES
      (@listing_id, @product_id, @offering_id, @style_value, @secondary_value,
       @property_values, @quantity, @is_enabled, @price_amount, @price_currency,
       strftime('%s','now'))
    ON CONFLICT(listing_id, product_id) DO UPDATE SET
      offering_id     = excluded.offering_id,
      style_value     = excluded.style_value,
      secondary_value = excluded.secondary_value,
      property_values = excluded.property_values,
      quantity        = excluded.quantity,
      is_enabled      = excluded.is_enabled,
      price_amount    = excluded.price_amount,
      price_currency  = excluded.price_currency,
      synced_at       = strftime('%s','now')
  `).run({
    listing_id:      listingId,
    product_id:      product.product_id,
    offering_id:     offering?.offering_id ?? null,
    style_value:     styleVal,
    secondary_value: secondaryVal,
    property_values: JSON.stringify(propValues),
    quantity:        offering?.quantity ?? 0,
    is_enabled:      offering?.is_enabled ? 1 : 0,
    price_amount:    offering?.price ? offering.price.amount / offering.price.divisor : null,
    price_currency:  offering?.price?.currency_code ?? null,
  });
}

/**
 * Log an event (zero-stock alert, auto-restock, error, etc.)
 */
function logEvent(db, { event_type, shop_name, listing_id, listing_title, style_value, detail, meta }) {
  db.prepare(`
    INSERT INTO events (event_type, shop_name, listing_id, listing_title, style_value, detail, meta)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    event_type,
    shop_name   || null,
    listing_id  || null,
    listing_title || null,
    style_value || null,
    detail      || null,
    meta ? JSON.stringify(meta) : null,
  );
}

/**
 * Update the carrier tracking result for a single receipt.
 *
 * Called by the sync worker's tracking-check pass (Pass D) after querying
 * the 4PX API (or another carrier). This is the only place carrier_confirmed_at
 * should be written — upsertReceipt intentionally preserves it via COALESCE.
 *
 * @param {Database.Database} db
 * @param {number} receiptId
 * @param {object} params
 * @param {number|null} params.carrierConfirmedAt  - Unix epoch of first carrier scan; null if pre-transit
 * @param {number}      params.trackingCheckedAt   - Unix epoch of this check (always set)
 */
function updateCarrierStatus(db, receiptId, { carrierConfirmedAt, trackingCheckedAt }) {
  db.prepare(`
    UPDATE receipts SET
      carrier_confirmed_at = COALESCE(carrier_confirmed_at, @carrier_confirmed_at),
      tracking_checked_at  = @tracking_checked_at
    WHERE receipt_id = @receipt_id
  `).run({
    receipt_id:           receiptId,
    carrier_confirmed_at: carrierConfirmedAt ?? null,
    tracking_checked_at:  trackingCheckedAt,
  });
}

/**
 * Persist the result of a 4PX shipping order created through the dashboard.
 *
 * Called immediately after a successful ds.xms.order.create API response.
 * Idempotent — safe to call multiple times (e.g. to update label_url after
 * a ds.xms.label.get call). fourpx_created_at is set only on first write.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number|string} receiptId
 * @param {object} opts
 * @param {string|null} [opts.consignmentNo]   ds_consignment_no from 4PX
 * @param {string|null} [opts.trackingNo]      4px_tracking_no from 4PX
 * @param {string|null} [opts.labelUrl]        Shipping label PDF URL (from label.get)
 * @param {string}      [opts.status]          'created' | 'label_fetched' | 'cancelled' | 'error'
 */
function upsertFourpxShipment(db, receiptId, {
  consignmentNo = null,
  trackingNo    = null,
  labelUrl      = null,
  status        = 'created',
} = {}) {
  db.prepare(`
    UPDATE receipts SET
      fourpx_consignment_no = COALESCE(fourpx_consignment_no, @consignmentNo),
      fourpx_tracking_no    = COALESCE(fourpx_tracking_no,    @trackingNo),
      fourpx_label_url      = @labelUrl,
      fourpx_order_status   = @status,
      fourpx_created_at     = COALESCE(fourpx_created_at,     @now)
    WHERE receipt_id = @receiptId
  `).run({
    receiptId,
    consignmentNo,
    trackingNo,
    labelUrl,
    status,
    now: Math.floor(Date.now() / 1000),
  });
}

/**
 * Upsert a conversation thread from Etsy's undocumented conversations API.
 * Safe to call on re-sync — updates status and last_message_at.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} shopId
 * @param {string} groupId
 * @param {object} convo  - Raw conversation object from Etsy internal API
 */
function upsertConversation(db, shopId, groupId, convo) {
  // Resolve the last message timestamp from either a dedicated field or message array
  const msgs = Array.isArray(convo.messages) ? convo.messages : [];
  const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
  const lastMsgAt = convo.last_message_at
    ?? convo.create_timestamp
    ?? lastMsg?.created_timestamp
    ?? null;

  db.prepare(`
    INSERT INTO conversations (
      convo_id, shop_id, group_id,
      buyer_user_id, buyer_name, subject,
      status, unread_count, last_message_at,
      linked_receipt_id, synced_at
    ) VALUES (
      @convo_id, @shop_id, @group_id,
      @buyer_user_id, @buyer_name, @subject,
      @status, @unread_count, @last_message_at,
      @linked_receipt_id, strftime('%s','now')
    )
    ON CONFLICT(convo_id) DO UPDATE SET
      buyer_name        = excluded.buyer_name,
      subject           = excluded.subject,
      status            = excluded.status,
      unread_count      = excluded.unread_count,
      last_message_at   = excluded.last_message_at,
      linked_receipt_id = COALESCE(excluded.linked_receipt_id, linked_receipt_id),
      synced_at         = strftime('%s','now')
  `).run({
    convo_id:          String(convo.conversation_id ?? convo.convo_id),
    shop_id:           shopId,
    group_id:          groupId,
    buyer_user_id:     convo.buyer_user_id   ?? null,
    buyer_name:        convo.buyer_name      ?? convo.buyer?.login_name ?? null,
    subject:           convo.subject         ?? convo.title ?? null,
    status:            convo.is_read === false ? 'unread' : (convo.status ?? 'read'),
    unread_count:      convo.unread_count    ?? (convo.is_read === false ? 1 : 0),
    last_message_at:   lastMsgAt,
    linked_receipt_id: convo.receipt_id      ?? null,
  });
}

/**
 * Upsert a single message within a conversation thread.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} convoId
 * @param {string} shopId
 * @param {object} msg   - Raw message object from Etsy internal API
 */
function upsertConversationMessage(db, convoId, shopId, msg) {
  // Determine sender: the message is from the buyer unless it's from the shop owner
  const senderType = (msg.sender_user_id && msg.seller_user_id &&
    String(msg.sender_user_id) === String(msg.seller_user_id))
    ? 'seller'
    : 'buyer';

  db.prepare(`
    INSERT INTO conversation_messages (
      message_id, convo_id, shop_id,
      sender_type, body, created_at
    ) VALUES (
      @message_id, @convo_id, @shop_id,
      @sender_type, @body, @created_at
    )
    ON CONFLICT(message_id) DO UPDATE SET
      body       = excluded.body,
      created_at = excluded.created_at
  `).run({
    message_id:  String(msg.message_id ?? msg.id),
    convo_id:    convoId,
    shop_id:     shopId,
    sender_type: senderType,
    body:        msg.message_text ?? msg.body ?? msg.text ?? null,
    created_at:  msg.created_timestamp ?? msg.create_date ?? null,
  });
}

/**
 * Mark a conversation as read locally (does not call the Etsy API).
 * The API call to Etsy is made separately in the server route.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} convoId
 */
function markConversationReadLocal(db, convoId) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    UPDATE conversations SET status = 'read', unread_count = 0 WHERE convo_id = @convo_id
  `).run({ convo_id: convoId });
  db.prepare(`
    UPDATE conversation_messages SET read_at = @now WHERE convo_id = @convo_id AND read_at IS NULL
  `).run({ convo_id: convoId, now });
}

// ─── Route assignments ────────────────────────────────────────────────────────

const _VALID_STATUSES = new Set(['Pending', 'Purchased', 'Out of Stock', 'Out of Production']);

/**
 * Insert or update a single order line's route assignment.
 * Only the provided fields are changed; omitted fields keep their stored value
 * (or the column default on first insert).
 *
 * @param {Database.Database} db
 * @param {object} a
 * @param {number} a.receipt_id
 * @param {string} a.item_key   - normalize(title)[:50]
 * @param {string} [a.title]
 * @param {string} [a.charm_code]
 * @param {string} [a.charm_shop]
 * @param {string} [a.status_case]
 * @param {string} [a.status_grip]
 * @param {string} [a.status_charm]
 * @param {boolean|number} [a.excluded]
 * @returns {object} the resulting row
 */
function upsertRouteAssignment(db, a) {
  if (a.receipt_id == null || !a.item_key) {
    throw new Error('upsertRouteAssignment requires receipt_id and item_key');
  }

  const existing = db.prepare(
    'SELECT * FROM route_assignments WHERE receipt_id = ? AND item_key = ?'
  ).get(a.receipt_id, a.item_key) || {};

  const clampStatus = (v, fallback) =>
    (v != null && _VALID_STATUSES.has(v)) ? v : (fallback ?? 'Pending');

  const row = {
    receipt_id:              a.receipt_id,
    item_key:                a.item_key,
    title:                   a.title        ?? existing.title        ?? '',
    charm_code:              a.charm_code   ?? existing.charm_code   ?? '',
    charm_shop:              a.charm_shop   ?? existing.charm_shop   ?? '',
    status_case:             clampStatus(a.status_case,  existing.status_case),
    status_grip:             clampStatus(a.status_grip,  existing.status_grip),
    status_charm:            clampStatus(a.status_charm, existing.status_charm),
    excluded:                a.excluded != null ? (a.excluded ? 1 : 0) : (existing.excluded ?? 0),
    supplier_shop_override:  a.supplier_shop_override  ?? existing.supplier_shop_override  ?? '',
    supplier_stall_override: a.supplier_stall_override ?? existing.supplier_stall_override ?? '',
    updated_at:              Math.floor(Date.now() / 1000),
  };

  db.prepare(`
    INSERT INTO route_assignments
      (receipt_id, item_key, title, charm_code, charm_shop,
       status_case, status_grip, status_charm, excluded,
       supplier_shop_override, supplier_stall_override, updated_at)
    VALUES
      (@receipt_id, @item_key, @title, @charm_code, @charm_shop,
       @status_case, @status_grip, @status_charm, @excluded,
       @supplier_shop_override, @supplier_stall_override, @updated_at)
    ON CONFLICT(receipt_id, item_key) DO UPDATE SET
      title                   = excluded.title,
      charm_code              = excluded.charm_code,
      charm_shop              = excluded.charm_shop,
      status_case             = excluded.status_case,
      status_grip             = excluded.status_grip,
      status_charm            = excluded.status_charm,
      excluded                = excluded.excluded,
      supplier_shop_override  = excluded.supplier_shop_override,
      supplier_stall_override = excluded.supplier_stall_override,
      updated_at              = excluded.updated_at
  `).run(row);

  return row;
}

/**
 * Fetch every saved route assignment as a map keyed by `${receipt_id}\x00${item_key}`.
 * @param {Database.Database} db
 * @returns {Record<string, object>}
 */
function getAllRouteAssignments(db) {
  const map = {};
  db.prepare('SELECT * FROM route_assignments').all().forEach((a) => {
    map[`${a.receipt_id}\x00${a.item_key}`] = a;
  });
  return map;
}

/**
 * Upsert a per-product default assignment (supplier + charm remembered by title).
 * Only updates a field when a non-empty value is explicitly provided, so partial
 * updates never overwrite existing data with blanks.
 *
 * @param {Database.Database} db
 * @param {{ item_key: string, title?: string,
 *           supplier_shop?: string, supplier_stall?: string,
 *           charm_code?: string, charm_shop?: string }} a
 */
function upsertProductAssignment(db, a) {
  if (!a.item_key) throw new Error('upsertProductAssignment requires item_key');

  const existing = db.prepare(
    'SELECT * FROM product_assignments WHERE item_key = ?'
  ).get(a.item_key) || {};

  // Only overwrite a field when the caller supplies a non-empty value.
  const pick = (next, prev) => (next != null && next !== '') ? next : (prev ?? '');

  const row = {
    item_key:       a.item_key,
    title:          pick(a.title,          existing.title),
    supplier_shop:  pick(a.supplier_shop,  existing.supplier_shop),
    supplier_stall: pick(a.supplier_stall, existing.supplier_stall),
    charm_code:     pick(a.charm_code,     existing.charm_code),
    charm_shop:     pick(a.charm_shop,     existing.charm_shop),
    updated_at:     Math.floor(Date.now() / 1000),
  };

  db.prepare(`
    INSERT INTO product_assignments
      (item_key, title, supplier_shop, supplier_stall, charm_code, charm_shop, updated_at)
    VALUES
      (@item_key, @title, @supplier_shop, @supplier_stall, @charm_code, @charm_shop, @updated_at)
    ON CONFLICT(item_key) DO UPDATE SET
      title          = excluded.title,
      supplier_shop  = excluded.supplier_shop,
      supplier_stall = excluded.supplier_stall,
      charm_code     = excluded.charm_code,
      charm_shop     = excluded.charm_shop,
      updated_at     = excluded.updated_at
  `).run(row);

  return row;
}

/**
 * Fetch every product assignment as a map keyed by item_key.
 * @param {Database.Database} db
 * @returns {Record<string, object>}
 */
function getAllProductAssignments(db) {
  const map = {};
  try {
    db.prepare('SELECT * FROM product_assignments').all().forEach(a => {
      map[a.item_key] = a;
    });
  } catch { /* table may not exist on first run before server restart */ }
  return map;
}

/**
 * Replace the entire supplier_directory in one transaction.
 * @param {Database.Database} db
 * @param {Array<{shop_name,stall,mall,floor,address,notes}>} rows
 * @returns {number} number of rows written
 */
function replaceSupplierDirectory(db, rows) {
  const now = Math.floor(Date.now() / 1000);
  const ins = db.prepare(`
    INSERT INTO supplier_directory (shop_name, stall, mall, floor, address, notes, sort_order, updated_at)
    VALUES (@shop_name, @stall, @mall, @floor, @address, @notes, @sort_order, @updated_at)
    ON CONFLICT(shop_name, stall) DO UPDATE SET
      mall = excluded.mall, floor = excluded.floor,
      address = excluded.address, notes = excluded.notes,
      sort_order = excluded.sort_order,
      updated_at = excluded.updated_at
  `);
  const tx = db.transaction((list) => {
    db.prepare('DELETE FROM supplier_directory').run();
    for (const r of list) {
      ins.run({
        shop_name:  String(r.shop_name || '').trim(),
        stall:      String(r.stall     || '').trim(),
        mall:       String(r.mall      || '').trim(),
        floor:      String(r.floor     || '').trim(),
        address:    String(r.address   || '').trim(),
        notes:      String(r.notes     || '').trim(),
        sort_order: typeof r.sort_order === 'number' ? r.sort_order : 9999,
        updated_at: now,
      });
    }
  });
  const valid = rows.filter(r => String(r.shop_name || '').trim());
  tx(valid);
  return valid.length;
}

/**
 * Replace the entire charm_shop_directory in one transaction.
 * @param {Database.Database} db
 * @param {Array<{shop_name,stall,notes}>} rows
 * @returns {number} number of rows written
 */
function replaceCharmShopDirectory(db, rows) {
  const now = Math.floor(Date.now() / 1000);
  const ins = db.prepare(`
    INSERT INTO charm_shop_directory (shop_name, stall, notes, sort_order, updated_at)
    VALUES (@shop_name, @stall, @notes, @sort_order, @updated_at)
    ON CONFLICT(shop_name, stall) DO UPDATE SET
      notes = excluded.notes, sort_order = excluded.sort_order, updated_at = excluded.updated_at
  `);
  const tx = db.transaction((list) => {
    db.prepare('DELETE FROM charm_shop_directory').run();
    list.forEach((r, idx) => {
      ins.run({
        shop_name: String(r.shop_name || '').trim(),
        stall:     String(r.stall || '').trim(),
        notes:     String(r.notes || '').trim(),
        sort_order: typeof r.sort_order === 'number' ? r.sort_order : idx,
        updated_at: now,
      });
    });
  });
  const valid = rows.filter(r => String(r.shop_name || '').trim());
  tx(valid);
  return valid.length;
}

/** Re-pack charm_shop_directory sort_order = 0..N-1 in current order. */
function renumberCharmShopDirectory(db) {
  const rows = db.prepare('SELECT shop_name, stall FROM charm_shop_directory ORDER BY sort_order ASC, rowid ASC').all();
  const upd = db.prepare(
    'UPDATE charm_shop_directory SET sort_order = @so WHERE shop_name = @shop AND stall = @stall'
  );
  const tx = db.transaction(() => {
    rows.forEach((r, i) => upd.run({ so: i, shop: r.shop_name, stall: r.stall }));
  });
  tx();
}

/**
 * Insert a new charm shop, appended at the end of the list, then renumber.
 * @throws {Error} with code 'REQUIRED' or 'DUPLICATE'
 */
function insertCharmShopDirectoryRow(db, r) {
  const shop  = String(r.shop_name || '').trim();
  const stall = String(r.stall || '').trim();
  if (!shop) throw Object.assign(new Error('Shop name is required.'), { code: 'REQUIRED' });

  const exists = db.prepare(
    'SELECT 1 FROM charm_shop_directory WHERE shop_name = ? AND stall = ?'
  ).get(shop, stall);
  if (exists) {
    throw Object.assign(new Error('A charm shop with this name and stall already exists.'), { code: 'DUPLICATE' });
  }

  const maxRow = db.prepare('SELECT MAX(sort_order) AS m FROM charm_shop_directory').get();
  const nextSort = (maxRow && typeof maxRow.m === 'number' ? maxRow.m : -1) + 1;

  db.prepare(`
    INSERT INTO charm_shop_directory (shop_name, stall, notes, sort_order, updated_at)
    VALUES (?, ?, ?, ?, strftime('%s','now'))
  `).run(shop, stall, String(r.notes || '').trim(), nextSort);

  renumberCharmShopDirectory(db);
  return { shop_name: shop, stall };
}

/**
 * Update a charm shop. Because (shop_name, stall) is the composite PK, a change
 * to either field is performed as delete-then-insert, preserving the original
 * list position. Unspecified fields fall back to the existing row's values.
 * @throws {Error} with code 'REQUIRED', 'NOT_FOUND', or 'DUPLICATE'
 */
function updateCharmShopDirectoryRow(db, r) {
  const oShop = String(r.orig_shop_name || '').trim();
  const oStall = String(r.orig_stall || '').trim();
  const nShop = String(r.shop_name || '').trim();
  const nStall = String(r.stall || '').trim();
  if (!nShop) throw Object.assign(new Error('Shop name is required.'), { code: 'REQUIRED' });

  const cur = db.prepare(
    'SELECT * FROM charm_shop_directory WHERE shop_name = ? AND stall = ?'
  ).get(oShop, oStall);
  if (!cur) throw Object.assign(new Error('Charm shop not found.'), { code: 'NOT_FOUND' });

  if (nShop !== oShop || nStall !== oStall) {
    const clash = db.prepare(
      'SELECT 1 FROM charm_shop_directory WHERE shop_name = ? AND stall = ?'
    ).get(nShop, nStall);
    if (clash) {
      throw Object.assign(new Error('Another charm shop already uses this name and stall.'), { code: 'DUPLICATE' });
    }
  }

  const keepSort = cur.sort_order;
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM charm_shop_directory WHERE shop_name = ? AND stall = ?').run(oShop, oStall);
    db.prepare(`
      INSERT INTO charm_shop_directory (shop_name, stall, notes, sort_order, updated_at)
      VALUES (?, ?, ?, ?, strftime('%s','now'))
    `).run(nShop, nStall,
      String(r.notes != null ? r.notes : (cur.notes || '')).trim(),
      keepSort);
  });
  tx();

  renumberCharmShopDirectory(db);
  return { shop_name: nShop, stall: nStall };
}

/** Delete a charm shop by its composite key, then renumber. Returns rows removed. */
function deleteCharmShopDirectoryRow(db, { shop_name, stall }) {
  const shop = String(shop_name || '').trim();
  const st   = String(stall || '').trim();
  const info = db.prepare(
    'DELETE FROM charm_shop_directory WHERE shop_name = ? AND stall = ?'
  ).run(shop, st);
  renumberCharmShopDirectory(db);
  return info.changes;
}

// ── charm_library (the physical charms) ─────────────────────────────────────

/** Return the charm library in sort_order. */
function getCharmLibrary(db) {
  try {
    return db.prepare('SELECT * FROM charm_library ORDER BY sort_order ASC, code ASC').all();
  } catch { return []; }
}

/** Look up a single charm by code. */
function getCharmByCode(db, code) {
  try {
    return db.prepare('SELECT * FROM charm_library WHERE code = ?').get(String(code || '').trim());
  } catch { return undefined; }
}

/** Replace the entire charm library in one transaction (seed / re-sync). */
function replaceCharmLibrary(db, rows) {
  const now = Math.floor(Date.now() / 1000);
  const ins = db.prepare(`
    INSERT INTO charm_library (code, sku, default_charm_shop, notes, image_file, sort_order, updated_at)
    VALUES (@code, @sku, @default_charm_shop, @notes, @image_file, @sort_order, @updated_at)
    ON CONFLICT(code) DO UPDATE SET
      sku = excluded.sku, default_charm_shop = excluded.default_charm_shop,
      notes = excluded.notes, image_file = excluded.image_file,
      sort_order = excluded.sort_order, updated_at = excluded.updated_at
  `);
  const tx = db.transaction((list) => {
    db.prepare('DELETE FROM charm_library').run();
    list.forEach((r, idx) => {
      ins.run({
        code:               String(r.code || '').trim(),
        sku:                String(r.sku || '').trim(),
        default_charm_shop: String(r.default_charm_shop || '').trim(),
        notes:              String(r.notes || '').trim(),
        image_file:         String(r.image_file || '').trim(),
        sort_order:         typeof r.sort_order === 'number' ? r.sort_order : idx,
        updated_at:         now,
      });
    });
  });
  const valid = rows.filter(r => String(r.code || '').trim());
  tx(valid);
  return valid.length;
}

/** Re-pack charm_library sort_order = 0..N-1 in current order. */
function renumberCharmLibrary(db) {
  const rows = db.prepare('SELECT code FROM charm_library ORDER BY sort_order ASC, code ASC').all();
  const upd = db.prepare('UPDATE charm_library SET sort_order = @so WHERE code = @code');
  const tx = db.transaction(() => { rows.forEach((r, i) => upd.run({ so: i, code: r.code })); });
  tx();
}

/**
 * Insert a new charm, appended at the end, then renumber.
 * @throws {Error} with code 'REQUIRED' or 'DUPLICATE'
 */
function insertCharmLibraryRow(db, r) {
  const code = String(r.code || '').trim();
  if (!code) throw Object.assign(new Error('Charm code is required.'), { code: 'REQUIRED' });
  if (getCharmByCode(db, code)) {
    throw Object.assign(new Error(`Charm code "${code}" already exists.`), { code: 'DUPLICATE' });
  }
  const maxRow = db.prepare('SELECT MAX(sort_order) AS m FROM charm_library').get();
  const nextSort = (maxRow && typeof maxRow.m === 'number' ? maxRow.m : -1) + 1;
  db.prepare(`
    INSERT INTO charm_library (code, sku, default_charm_shop, notes, image_file, sort_order, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, strftime('%s','now'))
  `).run(code,
    String(r.sku || '').trim(),
    String(r.default_charm_shop || '').trim(),
    String(r.notes || '').trim(),
    String(r.image_file || '').trim(),
    nextSort);
  renumberCharmLibrary(db);
  return { code };
}

/**
 * Update a charm. Supports renaming the code (the PK) by delete-then-insert,
 * preserving the original list position. Unspecified fields fall back to the
 * existing row's values.
 * @throws {Error} with code 'REQUIRED', 'NOT_FOUND', or 'DUPLICATE'
 */
function updateCharmLibraryRow(db, r) {
  const oCode = String(r.orig_code || '').trim();
  const nCode = String(r.code || '').trim();
  if (!nCode) throw Object.assign(new Error('Charm code is required.'), { code: 'REQUIRED' });

  const cur = getCharmByCode(db, oCode);
  if (!cur) throw Object.assign(new Error('Charm not found.'), { code: 'NOT_FOUND' });

  if (nCode !== oCode && getCharmByCode(db, nCode)) {
    throw Object.assign(new Error(`Charm code "${nCode}" already exists.`), { code: 'DUPLICATE' });
  }

  const keepSort = cur.sort_order;
  const next = {
    code:               nCode,
    sku:                r.sku                != null ? String(r.sku).trim()                : (cur.sku || ''),
    default_charm_shop: r.default_charm_shop != null ? String(r.default_charm_shop).trim() : (cur.default_charm_shop || ''),
    notes:              r.notes              != null ? String(r.notes).trim()              : (cur.notes || ''),
    image_file:         r.image_file         != null ? String(r.image_file).trim()         : (cur.image_file || ''),
  };
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM charm_library WHERE code = ?').run(oCode);
    db.prepare(`
      INSERT INTO charm_library (code, sku, default_charm_shop, notes, image_file, sort_order, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, strftime('%s','now'))
    `).run(next.code, next.sku, next.default_charm_shop, next.notes, next.image_file, keepSort);
  });
  tx();
  renumberCharmLibrary(db);
  return next;
}

/** Delete a charm by code, then renumber. Returns the deleted row (for image cleanup). */
function deleteCharmLibraryRow(db, code) {
  const c = String(code || '').trim();
  const row = getCharmByCode(db, c);
  db.prepare('DELETE FROM charm_library WHERE code = ?').run(c);
  renumberCharmLibrary(db);
  return row || null;
}

/** Remap a charm_code column across a table using a two-phase (collision-safe) swap. */
function _remapCharmCodeColumn(db, table, renameMap) {
  const pairs = Object.entries(renameMap);
  if (!pairs.length) return;
  const toTmp   = db.prepare(`UPDATE ${table} SET charm_code = ? WHERE charm_code = ?`);
  // Phase 1: old → sentinel (avoids chained-rename collisions like 1→2, 2→3).
  for (const [oldC] of pairs) toTmp.run(`\x00reorder\x00${oldC}`, oldC);
  // Phase 2: sentinel → new.
  for (const [oldC, newC] of pairs) toTmp.run(newC, `\x00reorder\x00${oldC}`);
}

/**
 * Reorder the charm library to match `newOrder` (an array of current codes in
 * the desired visual order) and renumber codes sequentially by position
 * (CH-00001, CH-00002, …) — mirroring OSP's reorder_charm_library_rows.
 *
 * The physical charm (sku, shop, notes, image) travels with its position; the
 * code is positional. Every charm_code reference in route_assignments,
 * product_assignments and product_map is remapped so existing assignments keep
 * pointing at the same physical charm.
 *
 * @returns {{ renameMap: Object<string,string>, renames: Array<{oldCode,newCode,ext}> }}
 *          renames lists the image files that must be renamed on disk.
 * @throws {Error} code 'REQUIRED' when newOrder isn't a full permutation.
 */
function reorderCharmLibrary(db, newOrder) {
  const rows   = getCharmLibrary(db);
  const byCode = new Map(rows.map(r => [r.code, r]));

  const seen = new Set();
  const finalOrder = [];
  for (const raw of (newOrder || [])) {
    const c = String(raw || '').trim();
    if (byCode.has(c) && !seen.has(c)) { finalOrder.push(c); seen.add(c); }
  }
  if (finalOrder.length !== rows.length) {
    throw Object.assign(new Error('Reorder list must include every charm exactly once.'), { code: 'REQUIRED' });
  }

  // Detect code prefix + numeric width from the existing codes.
  let pfx = 'CH-', maxW = 0;
  for (const r of rows) {
    const m = /^([A-Za-z]+-+)(\d+)$/.exec(r.code);
    if (m) { if (pfx === 'CH-') pfx = m[1].toUpperCase(); maxW = Math.max(maxW, m[2].length); }
  }
  const width = Math.max(maxW, String(finalOrder.length).length, 5);

  const renameMap = {};
  const renames   = [];
  const newRows = finalOrder.map((code, i) => {
    const newCode = `${pfx}${String(i + 1).padStart(width, '0')}`;
    const cur = byCode.get(code);
    let imageFile = cur.image_file || '';
    if (newCode !== code) {
      renameMap[code] = newCode;
      if (cur.image_file) {
        const dot = cur.image_file.lastIndexOf('.');
        const ext = dot >= 0 ? cur.image_file.slice(dot + 1) : 'png';
        imageFile = `${newCode}.${ext}`;
        renames.push({ oldCode: code, newCode, ext });
      }
    }
    return {
      code: newCode, sku: cur.sku, default_charm_shop: cur.default_charm_shop,
      notes: cur.notes, image_file: imageFile, sort_order: i,
    };
  });

  const tx = db.transaction(() => {
    replaceCharmLibrary(db, newRows);
    if (Object.keys(renameMap).length) {
      _remapCharmCodeColumn(db, 'route_assignments',   renameMap);
      _remapCharmCodeColumn(db, 'product_assignments', renameMap);
      try { _remapCharmCodeColumn(db, 'product_map',    renameMap); } catch {}
    }
  });
  tx();

  return { renameMap, renames };
}

/** Return the supplier directory in Excel row order. */
function getSupplierDirectory(db) {
  try {
    return db.prepare('SELECT * FROM supplier_directory ORDER BY sort_order ASC').all();
  } catch { return []; }
}

/**
 * Derive the "floor" number from a stall code — a faithful port of OSP's
 * _stall_floor() in generate_shopping_route.py, so the supplier list orders
 * identically to the "Suppliers" sheet of supplier_catalog.xlsx.
 *
 *   A2xxx / A2-xx        → 2   (A-block is hard-coded to floor 2)
 *   leading single digit → that digit   ("4C14" → 4, "5A05" → 5)
 *   embedded <digit><letter> → that digit   ("太平洋3A73" → 3, "康乐北区4D32" → 4)
 *   blank / — / ???      → 999  (sort to the very end)
 *
 * NOTE: only the FIRST digit is used (A2001 → 2, not 2001); this matches OSP.
 */
function _supplierFloor(stall) {
  const s = String(stall || '').trim();
  if (!s || s === '—' || s === '???') return 999;
  if (/^A2/i.test(s)) return 2;        // A-block (A2xxx / A2-xx) lives on floor 2
  let m = s.match(/^(\d)/);            // leading single digit, e.g. 4C14 → 4
  if (m) return parseInt(m[1], 10);
  m = s.match(/(\d)[A-Za-z]/);         // embedded digit before a letter, e.g. 3A73 → 3
  if (m) return parseInt(m[1], 10);
  return 999;
}

/**
 * Compare two supplier rows the way OSP sorts the Suppliers sheet:
 * floor number, then stall (code-point), then shop name (code-point).
 * Uses raw `<`/`>` (not localeCompare) to match Python's code-point ordering.
 */
function _cmpSupplier(a, b) {
  const fa = _supplierFloor(a.stall), fb = _supplierFloor(b.stall);
  if (fa !== fb) return fa - fb;
  const sa = String(a.stall || '').toLowerCase(), sb = String(b.stall || '').toLowerCase();
  if (sa !== sb) return sa < sb ? -1 : 1;
  const na = String(a.shop_name || '').toLowerCase(), nb = String(b.shop_name || '').toLowerCase();
  return na < nb ? -1 : na > nb ? 1 : 0;
}

/** Re-sort the whole directory by the OSP key and rewrite sort_order = 0..N-1. */
function renumberSupplierDirectory(db) {
  const rows = db.prepare('SELECT shop_name, stall FROM supplier_directory').all();
  rows.sort(_cmpSupplier);
  const upd = db.prepare(
    'UPDATE supplier_directory SET sort_order = @so WHERE shop_name = @shop AND stall = @stall'
  );
  const tx = db.transaction(() => {
    rows.forEach((r, i) => upd.run({ so: i, shop: r.shop_name, stall: r.stall }));
  });
  tx();
}

/**
 * Insert a single new supplier into the directory, then renumber.
 * @throws {Error} with code 'REQUIRED' or 'DUPLICATE'
 */
function insertSupplierDirectoryRow(db, r) {
  const shop  = String(r.shop_name || '').trim();
  const stall = String(r.stall || '').trim();
  if (!shop) throw Object.assign(new Error('Shop name is required.'), { code: 'REQUIRED' });

  const exists = db.prepare(
    'SELECT 1 FROM supplier_directory WHERE shop_name = ? AND stall = ?'
  ).get(shop, stall);
  if (exists) {
    throw Object.assign(new Error('A supplier with this shop name and stall already exists.'), { code: 'DUPLICATE' });
  }

  db.prepare(`
    INSERT INTO supplier_directory (shop_name, stall, mall, floor, address, notes, sort_order, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 9999, strftime('%s','now'))
  `).run(shop, stall,
    String(r.mall || '').trim(),
    String(r.floor || '').trim(),
    String(r.address || '').trim(),
    String(r.notes || '').trim());

  renumberSupplierDirectory(db);
  return { shop_name: shop, stall };
}

/**
 * Update a supplier. Because (shop_name, stall) is the composite PK, a change
 * to either field is performed as delete-then-insert inside one transaction.
 * Unspecified fields fall back to the existing row's values.
 * @throws {Error} with code 'REQUIRED', 'NOT_FOUND', or 'DUPLICATE'
 */
function updateSupplierDirectoryRow(db, r) {
  const oShop = String(r.orig_shop_name || '').trim();
  const oStall = String(r.orig_stall || '').trim();
  const nShop = String(r.shop_name || '').trim();
  const nStall = String(r.stall || '').trim();
  if (!nShop) throw Object.assign(new Error('Shop name is required.'), { code: 'REQUIRED' });

  const cur = db.prepare(
    'SELECT * FROM supplier_directory WHERE shop_name = ? AND stall = ?'
  ).get(oShop, oStall);
  if (!cur) throw Object.assign(new Error('Supplier not found.'), { code: 'NOT_FOUND' });

  if (nShop !== oShop || nStall !== oStall) {
    const clash = db.prepare(
      'SELECT 1 FROM supplier_directory WHERE shop_name = ? AND stall = ?'
    ).get(nShop, nStall);
    if (clash) {
      throw Object.assign(new Error('Another supplier already uses this shop name and stall.'), { code: 'DUPLICATE' });
    }
  }

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM supplier_directory WHERE shop_name = ? AND stall = ?').run(oShop, oStall);
    db.prepare(`
      INSERT INTO supplier_directory (shop_name, stall, mall, floor, address, notes, sort_order, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 9999, strftime('%s','now'))
    `).run(nShop, nStall,
      String(r.mall    != null ? r.mall    : (cur.mall    || '')).trim(),
      String(r.floor   != null ? r.floor   : (cur.floor   || '')).trim(),
      String(r.address != null ? r.address : (cur.address || '')).trim(),
      String(r.notes   != null ? r.notes   : (cur.notes   || '')).trim());
  });
  tx();

  renumberSupplierDirectory(db);
  return { shop_name: nShop, stall: nStall };
}

/** Delete a supplier by its composite key, then renumber. Returns rows removed. */
function deleteSupplierDirectoryRow(db, { shop_name, stall }) {
  const shop = String(shop_name || '').trim();
  const st   = String(stall || '').trim();
  const info = db.prepare(
    'DELETE FROM supplier_directory WHERE shop_name = ? AND stall = ?'
  ).run(shop, st);
  renumberSupplierDirectory(db);
  return info.changes;
}

/** Return the charm shop directory. */
function getCharmShopDirectory(db) {
  try {
    return db.prepare('SELECT * FROM charm_shop_directory ORDER BY sort_order ASC, rowid ASC').all();
  } catch { return []; }
}

/**
 * Replace the entire product_map in one transaction.
 * Each row comes from the "Product Map" sheet of supplier_catalog.xlsx.
 * @param {Database.Database} db
 * @param {Array<{title_norm,title,shop_name,stall,charm_shop,charm_code,sort_order}>} rows
 * @returns {number} number of rows written
 */
function replaceProductMap(db, rows) {
  const now = Math.floor(Date.now() / 1000);
  const ins = db.prepare(`
    INSERT INTO product_map (title_norm, title, shop_name, stall, charm_shop, charm_code, sort_order, updated_at)
    VALUES (@title_norm, @title, @shop_name, @stall, @charm_shop, @charm_code, @sort_order, @updated_at)
    ON CONFLICT(title_norm) DO UPDATE SET
      title      = excluded.title,
      shop_name  = excluded.shop_name,
      stall      = excluded.stall,
      charm_shop = excluded.charm_shop,
      charm_code = excluded.charm_code,
      sort_order = excluded.sort_order,
      updated_at = excluded.updated_at
  `);
  const tx = db.transaction((list) => {
    db.prepare('DELETE FROM product_map').run();
    for (const r of list) {
      ins.run({
        title_norm: String(r.title_norm || '').trim(),
        title:      String(r.title      || '').trim(),
        shop_name:  String(r.shop_name  || '').trim(),
        stall:      String(r.stall      || '').trim(),
        charm_shop: String(r.charm_shop || '').trim(),
        charm_code: String(r.charm_code || '').trim(),
        sort_order: typeof r.sort_order === 'number' ? r.sort_order : 9999,
        updated_at: now,
      });
    }
  });
  const valid = rows.filter(r => String(r.title_norm || '').trim());
  tx(valid);
  return valid.length;
}

/** Return the product map keyed by normalised title for O(1) lookup. */
function getProductMapByNorm(db) {
  const map = new Map();
  try {
    db.prepare('SELECT * FROM product_map ORDER BY sort_order ASC').all()
      .forEach(r => map.set(r.title_norm, r));
  } catch { /* table may not exist before first import */ }
  return map;
}

module.exports = {
  initDb,
  getDb,
  syncConfigToDb,
  upsertRouteAssignment,
  getAllRouteAssignments,
  upsertProductAssignment,
  getAllProductAssignments,
  replaceSupplierDirectory,
  replaceCharmShopDirectory,
  replaceProductMap,
  getSupplierDirectory,
  getCharmShopDirectory,
  getProductMapByNorm,
  insertSupplierDirectoryRow,
  updateSupplierDirectoryRow,
  deleteSupplierDirectoryRow,
  renumberSupplierDirectory,
  insertCharmShopDirectoryRow,
  updateCharmShopDirectoryRow,
  deleteCharmShopDirectoryRow,
  renumberCharmShopDirectory,
  getCharmLibrary,
  getCharmByCode,
  replaceCharmLibrary,
  insertCharmLibraryRow,
  updateCharmLibraryRow,
  deleteCharmLibraryRow,
  renumberCharmLibrary,
  reorderCharmLibrary,
  upsertReceipt,
  upsertTransaction,
  upsertListingImage,
  upsertListing,
  upsertListingInventory,
  logEvent,
  updateCarrierStatus,
  startSyncLog,
  finishSyncLog,
  updateShopSyncTime,
  upsertFourpxShipment,
  upsertConversation,
  upsertConversationMessage,
  markConversationReadLocal,
};
