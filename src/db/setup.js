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
      error_message   TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sync_log_shop ON sync_log(shop_id, started_at DESC);
  `);

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
  const money = (obj) => (obj ? obj.amount / Math.pow(10, obj.divisor || 2) : null);
  const currency = (obj) => (obj ? obj.currency_code : null);

  db.prepare(`
    INSERT INTO receipts (
      receipt_id, shop_id, group_id,
      buyer_user_id, buyer_email, name,
      status, is_shipped, is_paid,
      grandtotal_amount, grandtotal_currency,
      subtotal_amount, discount_amount,
      shipping_cost, total_tax_cost,
      message_from_buyer, message_from_seller,
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
      @etsy_created_at, @etsy_updated_at,
      strftime('%s', 'now'), @raw_json
    )
    ON CONFLICT(receipt_id) DO UPDATE SET
      status              = excluded.status,
      is_shipped          = excluded.is_shipped,
      is_paid             = excluded.is_paid,
      grandtotal_amount   = excluded.grandtotal_amount,
      message_from_seller = excluded.message_from_seller,
      etsy_updated_at     = excluded.etsy_updated_at,
      synced_at           = excluded.synced_at,
      raw_json            = excluded.raw_json
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
 * @returns {number} The log entry ID
 */
function startSyncLog(db, shopId, groupId) {
  const result = db.prepare(`
    INSERT INTO sync_log (shop_id, group_id, started_at, status)
    VALUES (@shop_id, @group_id, strftime('%s', 'now'), 'running')
  `).run({ shop_id: shopId, group_id: groupId });
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

module.exports = {
  initDb,
  getDb,
  syncConfigToDb,
  upsertReceipt,
  upsertTransaction,
  startSyncLog,
  finishSyncLog,
  updateShopSyncTime,
};
