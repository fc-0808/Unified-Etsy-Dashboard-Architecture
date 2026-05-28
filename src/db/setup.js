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
    ['all_transactions',     'TEXT'],
    ['formatted_address',    'TEXT'],
    // App-level team note — stored locally only, not synced to Etsy
    ['team_note',            'TEXT'],
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
        formatted_address    = @formatted_address
      WHERE receipt_id = @receipt_id
    `);
    const backfill = db.transaction(() => {
      for (const row of rows) {
        try {
          const r = JSON.parse(row.raw_json);
          const txs = Array.isArray(r.transactions) ? r.transactions : [];
          const tx = txs[0] ?? null;
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
            formatted_address: r.formatted_address ?? null,
          });
        } catch { /* skip malformed rows */ }
      }
    });
    backfill();
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
  const proxyHost = (() => {
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

  const firstTx = Array.isArray(receipt.transactions) && receipt.transactions.length > 0
    ? receipt.transactions[0]
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
    formatted_address: receipt.formatted_address ?? null,
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

module.exports = {
  initDb,
  getDb,
  syncConfigToDb,
  upsertReceipt,
  upsertTransaction,
  upsertListingImage,
  upsertListing,
  startSyncLog,
  finishSyncLog,
  updateShopSyncTime,
};
