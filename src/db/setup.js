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
const { deriveVariationLabels } = require('../inventory/helpers');

/** @type {Database.Database | null} */
let _db = null;

// ── Manual-order home (synthetic shop/group) ────────────────────────────────
// Manual orders are real `receipts` rows, so they need a shop_id that satisfies
// the receipts→shops foreign key AND the JOIN shops in /api/orders and the Route
// dashboard. Rather than misattribute them to a real Etsy shop (or force the
// operator to pick one — the Route "Add Order" flow has no shop), every manual
// order belongs to a single dedicated, synthetic "Manual Orders" shop. It is
// seeded idempotently on startup and deliberately hidden from /api/shops so it
// never pollutes the Shops overview, listing/create/events/bulk selectors, or
// token accounting (it has no Etsy credentials).
const MANUAL_GROUP_ID = '__manual__';
const MANUAL_SHOP_ID  = '__manual__';
const MANUAL_SHOP_NAME = 'Manual Orders';

/**
 * Idempotently seed the synthetic group + shop that own every manual order.
 * Safe to call on every startup.
 * @param {Database.Database} db
 */
function seedManualOrderShop(db) {
  db.prepare(`
    INSERT INTO groups (group_id, label, proxy_host)
    VALUES (@group_id, @label, 'direct')
    ON CONFLICT(group_id) DO UPDATE SET label = excluded.label
  `).run({ group_id: MANUAL_GROUP_ID, label: MANUAL_SHOP_NAME });

  db.prepare(`
    INSERT INTO shops (shop_id, group_id, shop_name)
    VALUES (@shop_id, @group_id, @shop_name)
    ON CONFLICT(shop_id) DO UPDATE SET shop_name = excluded.shop_name, group_id = excluded.group_id
  `).run({ shop_id: MANUAL_SHOP_ID, group_id: MANUAL_GROUP_ID, shop_name: MANUAL_SHOP_NAME });
}

/**
 * Decode HTML entities in a string returned by the Etsy API.
 *
 * Etsy's receipt API HTML-encodes certain characters in text fields
 * (e.g. buyer names: "Timothy O&#39;Keefe" instead of "Timothy O'Keefe").
 * Storing the raw HTML-encoded value causes shipping carriers (4PX, etc.)
 * to reject the name with encoding/validation errors.
 *
 * Handles:
 *   &#NNN;   decimal numeric references  (e.g. &#39; → ')
 *   &#xHH;   hex numeric references      (e.g. &#x27; → ')
 *   Named:   &amp; &lt; &gt; &quot; &apos; &nbsp;
 *
 * @param {*} value
 * @returns {string|null}
 */
function decodeHtmlEntities(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return value;
  return value
    .replace(/&#(\d+);/g,      (_, n)   => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/gi,  '&')
    .replace(/&lt;/gi,   '<')
    .replace(/&gt;/gi,   '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

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

  // WAL mode: concurrent reads while writes are in progress (server + sync worker).
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // ── Performance PRAGMAs ────────────────────────────────────────────────────
  // busy_timeout: retry for up to 5 s before throwing SQLITE_BUSY when two
  //   processes race to write. Without this the server throws immediately if
  //   the sync worker holds the write lock, causing "database is locked" errors
  //   on route-assignment saves, manual-order creates, etc.
  db.pragma('busy_timeout = 5000');

  // synchronous = NORMAL: safe for WAL mode (power-failure can only lose the
  //   last committed transaction, never corrupt the file), and 3-5× faster
  //   than the default FULL because it skips the expensive pre-write fsync.
  db.pragma('synchronous = NORMAL');

  // cache_size = -65536: 64 MB page cache (default is -2000 = 2 MB).
  //   Keeping the receipt + listing pages hot in memory cuts read latency for
  //   the Orders and Listings tabs from ~20 ms to <1 ms after the first load.
  db.pragma('cache_size = -65536');

  // mmap_size = 256 MB: memory-mapped I/O.  Reads bypass pread() syscalls and
  //   go straight from the OS page cache to the process address space — a
  //   meaningful win on Windows where syscall overhead is higher than on Linux.
  db.pragma('mmap_size = 268435456');

  // temp_store = MEMORY: sort / index-build temp tables live in RAM, not the
  //   temp-file directory.  Avoids extra I/O during ORDER BY / GROUP BY on the
  //   large receipts table.
  db.pragma('temp_store = MEMORY');

  // wal_autocheckpoint = 10000: checkpoint the WAL into the main DB file every
  //   10 000 pages (≈ 40 MB) rather than the default 1 000 pages.  Reduces
  //   checkpoint overhead during heavy sync cycles; the WAL stays small and
  //   readable-by-readers throughout.
  db.pragma('wal_autocheckpoint = 10000');

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
    -- Payment-account ledger entries — the authoritative financial record.
    -- One row per Etsy ledger entry (sale posting, fee, tax, refund, payout).
    -- Amounts are integer minor units (cents) in the shop's PAYOUT currency.
    -- receipt_id is our resolved attribution (NULL for shop-level entries like
    -- subscriptions, listing renewals, Etsy Ads, and disbursements).
    -- ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS ledger_entries (
      entry_id        INTEGER PRIMARY KEY,
      shop_id         TEXT NOT NULL,
      sequence_number INTEGER,
      amount_cents    INTEGER NOT NULL,
      currency        TEXT,
      ledger_type     TEXT,
      reference_type  TEXT,
      reference_id    TEXT,
      description     TEXT,
      balance_cents   INTEGER,
      create_date     INTEGER,
      receipt_id      INTEGER,
      category        TEXT,
      synced_at       INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_ledger_shop_date ON ledger_entries(shop_id, create_date DESC);
    CREATE INDEX IF NOT EXISTS idx_ledger_receipt   ON ledger_entries(receipt_id);
    CREATE INDEX IF NOT EXISTS idx_ledger_category  ON ledger_entries(shop_id, category);

    -- payment_id → receipt_id map (the /payments money fields are unreliable, but
    -- this linkage is solid; used to attribute gross & processing-fee entries).
    CREATE TABLE IF NOT EXISTS etsy_payments (
      payment_id INTEGER PRIMARY KEY,
      shop_id    TEXT,
      receipt_id INTEGER,
      synced_at  INTEGER DEFAULT (strftime('%s', 'now'))
    );

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
    -- App-wide advisory locks (cross-process mutex)
    -- Used to guarantee that only ONE process runs a given background job at a
    -- time — even if several copies of the server/worker are accidentally
    -- launched at once (PM2 + a stray IDE/terminal instance, the standalone
    -- sync worker alongside the embedded scheduler, etc.).
    -- A lock is "held" while heartbeat_at is within its TTL; a crashed holder's
    -- lock is reclaimed automatically once the heartbeat goes stale.
    -- ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS app_locks (
      name         TEXT PRIMARY KEY,
      owner        TEXT,
      acquired_at  INTEGER,
      heartbeat_at INTEGER
    );

    -- ─────────────────────────────────────────────
    -- 4PX prepaid balance snapshot (single row, id=1).
    -- 4PX does NOT expose account balance via its Open API, so the operator records
    -- the balance from the b.4px.com portal here; the dashboard then estimates the
    -- live remaining balance by subtracting 4PX shipping billed since the snapshot.
    -- ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS fourpx_balance (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      amount      REAL,           -- balance as recorded from the portal
      currency    TEXT,           -- e.g. 'CNY'
      as_of       INTEGER,        -- unix epoch the balance was accurate as of
      note        TEXT,
      updated_at  INTEGER
    );

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
    -- Listing image data cache: listing_id → raw JPEG bytes
    -- Populated on first route generation; never re-fetched unless the row is
    -- deleted.  Stores the full 570px image bytes so the shopping-route Excel
    -- files get real product photos without hitting the CDN on every run.
    -- ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS listing_image_data (
      listing_id INTEGER PRIMARY KEY,
      data       BLOB    NOT NULL,
      cached_at  INTEGER DEFAULT (strftime('%s', 'now'))
    );

    -- ─────────────────────────────────────────────
    -- Perceptual image hash: listing_id → dHash of its primary image. Used to
    -- link the SAME physical product across shops (different listings / titles,
    -- but the same design image) so the shopping route can unify their orders.
    -- The sha column is the byte-hash of the source image the phash was computed
    -- from, so we recompute only when the cached image actually changes.
    -- ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS listing_phash (
      listing_id  INTEGER PRIMARY KEY,
      phash       TEXT    NOT NULL,
      sha         TEXT    NOT NULL,
      algo        TEXT,
      canonical_key TEXT,
      computed_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    -- Durable audit trail for supplier purchase prices. Catalog/Excel imports
    -- must never make a manually recorded price unrecoverable again.
    CREATE TABLE IF NOT EXISTS product_price_history (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      canonical_key  TEXT,
      title_norm     TEXT NOT NULL,
      component      TEXT NOT NULL CHECK(component IN ('case','grip')),
      old_cost       REAL,
      new_cost       REAL,
      changed_at     INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_price_history_product
      ON product_price_history(canonical_key, title_norm, changed_at DESC);

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
    -- receipt_item_purchase: per LINE-ITEM "needs purchase" tracking for the
    --   Orders tab. An order can contain several products; when it is created
    --   pre-transit (a label was made to hit the ship-by deadline) some products
    --   may already be in stock while others still have to be bought. This table
    --   records, per line-item, whether that specific product still needs buying.
    --
    --   The ORDER-level flag receipts.needs_purchase_at is a denormalised rollup
    --   of these rows (set while ANY line still needs purchase; cleared when all
    --   are bought). That rollup is what the Orders "Needs purchase" filter and the
    --   Route auto-include query read, so partial-purchase orders stay in the
    --   purchasing queue until every outstanding product is bought.
    --
    --   item_key matches route/dashboard.lineItemKey(title, listing_id) so a line
    --   here lines up 1:1 with its Route-tab row (which adds per-component status).
    --
    --   needs_purchase: 1 = still to buy, 0 = purchased.
    -- ─────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS receipt_item_purchase (
      receipt_id     INTEGER NOT NULL,
      item_key       TEXT    NOT NULL,
      title          TEXT,
      needs_purchase INTEGER NOT NULL DEFAULT 1,
      note           TEXT,
      flagged_at     INTEGER,
      purchased_at   INTEGER,
      updated_at     INTEGER DEFAULT (strftime('%s','now')),
      PRIMARY KEY (receipt_id, item_key)
    );
    CREATE INDEX IF NOT EXISTS idx_rip_receipt ON receipt_item_purchase(receipt_id);
    CREATE INDEX IF NOT EXISTS idx_rip_outstanding ON receipt_item_purchase(receipt_id, needs_purchase);

    -- ─────────────────────────────────────────────────────────────────
    -- route_manual_items: operator-created route line-items that do NOT
    --   originate from a synced Etsy receipt. Added via the Route tab's
    --   "Add Order" → product picker / custom-product flow.
    --
    --   Each row owns a synthetic NEGATIVE receipt_id (= -id) so it never
    --   collides with a real Etsy receipt and slots straight into the
    --   existing receipt_id-keyed assignment / status / exclude machinery.
    --
    --   • Catalog picks  carry a real listing_id + image_url (CDN) so the
    --     supplier match and route image pipeline work unchanged.
    --   • Custom products store uploaded bytes in image_data/image_mime and
    --     are served via GET /api/route/manual-image/:id.
    -- ─────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS route_manual_items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id  INTEGER NOT NULL UNIQUE,
      item_key    TEXT    NOT NULL,
      title       TEXT    NOT NULL,
      phone_model TEXT    DEFAULT '',
      style       TEXT    DEFAULT '',
      quantity    INTEGER DEFAULT 1,
      shop_name   TEXT    DEFAULT '',
      listing_id  INTEGER,
      image_url   TEXT    DEFAULT '',
      image_data  BLOB,
      image_mime  TEXT    DEFAULT '',
      source      TEXT    DEFAULT 'manual',
      created_at  INTEGER DEFAULT (strftime('%s','now'))
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
      canonical_product_key TEXT,
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

    -- ─────────────────────────────────────────────────────────────────
    -- charm_purchase_progress: how many physical pieces of a given charm
    --   code the operator has already bought / has in stock. Used by the
    --   "Charms to Buy" list to show purchased vs. still-to-buy quantities
    --   independent of how many orders need it. Keyed by charm code.
    -- ─────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS charm_purchase_progress (
      charm_code    TEXT PRIMARY KEY,
      purchased_qty INTEGER NOT NULL DEFAULT 0,
      updated_at    INTEGER DEFAULT (strftime('%s','now'))
    );

    -- ─────────────────────────────────────────────────────────────────
    -- Bulk Listing Creator
    -- ─────────────────────────────────────────────────────────────────

    -- Cache of per-shop Etsy listing settings (shipping/return/partner/
    --   section/taxonomy + resolved defaults). Refreshed on a TTL.
    CREATE TABLE IF NOT EXISTS shop_listing_settings (
      shop_key   TEXT PRIMARY KEY,
      data_json  TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );

    -- One row per bulk-create job (a run over one shop's input folder).
    CREATE TABLE IF NOT EXISTS bulk_jobs (
      job_id       TEXT PRIMARY KEY,
      shop_key     TEXT NOT NULL,
      shop_name    TEXT,
      input_path   TEXT NOT NULL,
      state        TEXT NOT NULL DEFAULT 'queued',  -- queued|running|paused|done|error|cancelled
      target_state TEXT NOT NULL DEFAULT 'draft',   -- draft|published
      dry_run      INTEGER NOT NULL DEFAULT 0,
      total        INTEGER NOT NULL DEFAULT 0,
      completed    INTEGER NOT NULL DEFAULT 0,
      failed       INTEGER NOT NULL DEFAULT 0,
      options_json TEXT,
      error        TEXT,
      created_at   INTEGER DEFAULT (strftime('%s','now')),
      started_at   INTEGER,
      finished_at  INTEGER
    );

    -- One row per product (folder) within a bulk job. Enables idempotent
    --   resume: AI/upload/inventory steps are checkpointed in checkpoint_json.
    CREATE TABLE IF NOT EXISTS bulk_job_items (
      job_id          TEXT NOT NULL,
      product_folder  TEXT NOT NULL,
      product_name    TEXT,
      seq             INTEGER,                         -- natural-sort position (1,2,3…) from the scanner
      status          TEXT NOT NULL DEFAULT 'pending', -- pending|ai_done|created|images_done|inventory_done|done|failed
      listing_id      INTEGER,
      listing_url     TEXT,
      title           TEXT,
      error           TEXT,
      ai_json         TEXT,
      checkpoint_json TEXT,
      preview_json    TEXT,                            -- full inspection payload (copy + variations + image order + settings)
      published_at    INTEGER,                         -- epoch when the draft was published to Etsy
      reviewed_at     INTEGER,                         -- epoch when the operator marked the listing manually reviewed
      excluded        INTEGER NOT NULL DEFAULT 0,      -- 1 = operator excluded this product from Etsy creation
      updated_at      INTEGER DEFAULT (strftime('%s','now')),
      PRIMARY KEY (job_id, product_folder)
    );

    -- ─────────────────────────────────────────────
    -- Purchase-sync version history (audit trail)
    -- One immutable row per "Sync purchase status" upload, so the owner can
    -- always trace back EXACTLY which orders were marked purchased, on what
    -- date/time, from which workbook. The payload_json column stores the full
    -- report (orders changed, before/after per component, ready-to-ship roster,
    -- warnings) so a past run can be re-opened or re-exported byte-for-byte.
    -- ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS purchase_sync_runs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      file_name       TEXT,
      updated_orders  INTEGER NOT NULL DEFAULT 0,
      updated_lines   INTEGER NOT NULL DEFAULT 0,
      became_ready    INTEGER NOT NULL DEFAULT 0,
      cleared_queue   INTEGER NOT NULL DEFAULT 0,
      ready_in_file   INTEGER NOT NULL DEFAULT 0,
      orders_in_file  INTEGER NOT NULL DEFAULT 0,
      summary_json    TEXT,
      payload_json    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_purchase_sync_runs_created ON purchase_sync_runs(created_at DESC);

    -- ─────────────────────────────────────────────────────────────────
    -- order_issues: structured fulfilment-exception workflow for orders whose
    --   product can no longer be supplied as the buyer ordered it. Replaces the
    --   ad-hoc "archive with a reason" overload for two concrete situations:
    --
    --     • out_of_production — the manufacturer discontinued the product, so the
    --                           whole listing must be removed from Etsy and the
    --                           buyer asked to switch design or take a refund.
    --     • model_unavailable — the supplier no longer offers the phone model the
    --                           buyer chose, so that model must be removed from the
    --                           Etsy listing and the buyer asked to switch or refund.
    --     • other             — any other operator-defined blocker.
    --
    --   One row per AFFECTED LINE-ITEM, keyed by (receipt_id, item_key) — the SAME
    --   listing-scoped key route/dashboard.lineItemKey(title, listing_id) uses — so
    --   an open issue maps 1:1 onto its Route-tab row and ONLY that product is held
    --   out of the purchasing Route (the order's other products keep flowing).
    --
    --   Lifecycle (status): 'open' → 'resolved'. While OPEN the line is excluded
    --   from the Route's purchasing dashboard + generation (we must never buy a
    --   product the buyer may cancel/swap). RESOLVED issues are kept for the record
    --   and stop excluding the line.
    --
    --   Operator workflow checklist (each step stamps an epoch when done):
    --     buyer_notified_at  — operator messaged the buyer on Etsy (Etsy API v3 has
    --                          no messaging endpoint, so this records a manual send).
    --     listing_handled_at — the Etsy listing action was carried out, recorded in
    --                          listing_action: 'deleted' | 'model_removed' | 'none'.
    --     resolved_at        — issue closed; resolution: 'switched' | 'refunded' |
    --                          'cancelled' | 'other'.
    --
    --   Purely local/operational; never overwritten by upsertReceipt re-syncs.
    -- ─────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS order_issues (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id         INTEGER NOT NULL,
      item_key           TEXT    NOT NULL,
      listing_id         INTEGER,
      title              TEXT,
      phone_model        TEXT,
      issue_type         TEXT    NOT NULL,
      status             TEXT    NOT NULL DEFAULT 'open',
      note               TEXT,
      buyer_notified_at  INTEGER,
      listing_handled_at INTEGER,
      listing_action     TEXT,
      resolution         TEXT,
      created_at         INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at         INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      resolved_at        INTEGER,
      UNIQUE(receipt_id, item_key)
    );
    CREATE INDEX IF NOT EXISTS idx_order_issues_receipt ON order_issues(receipt_id);
    CREATE INDEX IF NOT EXISTS idx_order_issues_status  ON order_issues(status);

    -- ─────────────────────────────────────────────────────────────────
    -- order_exchanges: "wrong-model swap" workflow for line-items we ALREADY
    --   physically hold, but in the WRONG phone model. The correct product
    --   exists at the supplier — we simply carry the in-hand piece back to the
    --   stall and swap it for the model the order actually needs.
    --
    --   Why this is its OWN concept (not "Purchased", not order_issues):
    --     • It must NOT be bought again — we have the item — so it is held out of
    --       the purchasing Route exactly like a fully-purchased line. Operators
    --       used to fake this by marking the components "Purchased", which hid the
    --       fact that a physical exchange is still owed and let staff ship the
    --       WRONG model.
    --     • It is NOT a fulfilment exception (order_issues): the buyer still gets
    --       exactly what they ordered, so there is no buyer message / listing
    --       delete / refund workflow. It is a shopping-trip task, not a customer
    --       problem.
    --
    --   One row per affected LINE-ITEM, keyed by (receipt_id, item_key) — the same
    --   listing-scoped key route/dashboard.lineItemKey(title, listing_id) uses — so
    --   an open exchange maps 1:1 onto its Route-tab row.
    --
    --   have_model    — the model we currently hold (wrong), e.g. "iPhone 17 Pro".
    --   need_model    — the model the order requires, e.g. "iPhone 17 Pro Max".
    --   components    — comma list of the pieces to swap: any of case,grip,charm.
    --   supplier_shop / supplier_stall — where to carry it for the swap (defaults
    --                   captured from the route's supplier resolution at flag time).
    --
    --   Lifecycle (status): 'open' → 'done'. While OPEN the line is held out of the
    --   purchasing Route (we have it) but surfaced in a dedicated "To exchange"
    --   bucket so staff know to swap it on the next trip. Marking it done stamps
    --   done_at; the server then flips the affected component statuses to Purchased
    --   so the order becomes genuinely complete + ready to ship.
    --
    --   Purely local/operational; never overwritten by upsertReceipt re-syncs.
    -- ─────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS order_exchanges (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id     INTEGER NOT NULL,
      item_key       TEXT    NOT NULL,
      listing_id     INTEGER,
      title          TEXT,
      have_model     TEXT,
      need_model     TEXT,
      components     TEXT    NOT NULL DEFAULT '',
      supplier_shop  TEXT,
      supplier_stall TEXT,
      status         TEXT    NOT NULL DEFAULT 'open',
      note           TEXT,
      created_at     INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at     INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      done_at        INTEGER,
      UNIQUE(receipt_id, item_key)
    );
    CREATE INDEX IF NOT EXISTS idx_order_exchanges_receipt ON order_exchanges(receipt_id);
    CREATE INDEX IF NOT EXISTS idx_order_exchanges_status  ON order_exchanges(status);

    -- ─────────────────────────────────────────────────────────────────
    -- order_line_substitutions: LOCAL "design switch" override for an order
    --   line whose original product cannot be supplied. After a fulfilment
    --   issue is flagged and the buyer agrees to switch (instead of a refund),
    --   the operator picks a replacement design — from the product catalog or a
    --   custom upload — and we record it here.
    --
    --   This is a NON-DESTRUCTIVE OVERRIDE LAYER: the Etsy receipt/transaction
    --   is never modified and NOTHING is pushed to Etsy. The dashboard simply
    --   RENDERS and PURCHASES the replacement design for this line instead of the
    --   original — so the switched product flows back into the Orders/Route
    --   purchasing queue and is bought like any other item.
    --
    --   One row per affected LINE-ITEM, keyed by (receipt_id, item_key) — the
    --   SAME listing-scoped key route/dashboard.lineItemKey(title, listing_id)
    --   uses — so the override maps 1:1 onto the order line and its Route row,
    --   and the line's purchase status (route_assignments) stays linked.
    --
    --   new_title / new_style / new_phone_model drive what we buy: the title
    --   feeds supplier matching, the style feeds Case/Grip/Charm detection, and
    --   the model rides along (the buyer may switch model too). Images come from
    --   either a catalog CDN url (image_url) OR uploaded bytes (image_data).
    -- ─────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS order_line_substitutions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id        INTEGER NOT NULL,
      item_key          TEXT    NOT NULL,
      original_title    TEXT,
      new_title         TEXT    NOT NULL,
      new_style         TEXT,
      new_phone_model   TEXT,
      source            TEXT,            -- 'catalog' | 'custom'
      source_listing_id INTEGER,
      image_url         TEXT,            -- catalog CDN thumbnail
      image_data        BLOB,            -- uploaded custom image bytes
      image_mime        TEXT,
      note              TEXT,
      created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at        INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      UNIQUE(receipt_id, item_key)
    );
    CREATE INDEX IF NOT EXISTS idx_order_subs_receipt ON order_line_substitutions(receipt_id);

    -- ─────────────────────────────────────────────────────────────────
    -- listing_style_images — operator-supplied CLARIFYING image for a
    --   product VARIANT, keyed by (listing_id, style).
    --
    --   Etsy gives one primary image per listing, so a line bought as
    --   "Grip 3 Only" still shows the full case+grip hero shot — ambiguous
    --   for whoever sources or packs it. This override says "for THIS
    --   variant show THIS photo" and applies to every order (past + future)
    --   of the same listing+style, everywhere the line is rendered.
    --
    --   It changes ONLY the displayed image — never the title, style,
    --   supplier or purchase state (unlike order_line_substitutions). A
    --   design switch always wins over it (the switched product is a
    --   different item with its own image).
    --
    --   style_key is the normalized style ('' = the whole listing, when the
    --   product has no style variation); style_value keeps the human label.
    -- ─────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS listing_style_images (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id  INTEGER NOT NULL,
      style_key   TEXT    NOT NULL DEFAULT '',   -- normalized style value ('' = whole listing)
      style_value TEXT    NOT NULL DEFAULT '',   -- human-readable style as displayed
      image_data  BLOB    NOT NULL,              -- uploaded image bytes
      image_mime  TEXT    NOT NULL DEFAULT 'image/png',
      note        TEXT    DEFAULT '',
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      UNIQUE(listing_id, style_key)
    );
    CREATE INDEX IF NOT EXISTS idx_listing_style_images_listing ON listing_style_images(listing_id);
  `);

  // ── Migrations ────────────────────────────────────────────────────────────
  // SQLite doesn't support ALTER TABLE ADD COLUMN IF NOT EXISTS, so we check
  // the column list manually and only add if missing.

  const syncLogCols = db.pragma('table_info(sync_log)').map((c) => c.name);
  if (!syncLogCols.includes('egress_ip')) {
    db.exec(`ALTER TABLE sync_log ADD COLUMN egress_ip TEXT`);
  }

  // Persisted AI-drafted buyer message + its timestamp on a fulfilment issue, so
  // an operator who generates a message once sees the same copy when they reopen
  // the issue (instead of losing it or regenerating a different one every time).
  const orderIssueCols = db.pragma('table_info(order_issues)').map((c) => c.name);
  if (!orderIssueCols.includes('buyer_message')) {
    db.exec(`ALTER TABLE order_issues ADD COLUMN buyer_message TEXT`);
  }
  if (!orderIssueCols.includes('buyer_message_at')) {
    db.exec(`ALTER TABLE order_issues ADD COLUMN buyer_message_at INTEGER`);
  }
  // Provenance of an issue: 'shop' = auto-flagged from Shopping Mode (a shopper
  // set a component to Discontinued / No-model), else 'manual' (operator). Lets
  // the auto-flag be safely reverted without ever clobbering operator work.
  if (!orderIssueCols.includes('source')) {
    db.exec(`ALTER TABLE order_issues ADD COLUMN source TEXT`);
  }

  // Persisted active-listing count per shop (Overview "Active Listings" column).
  // Cached here so the Overview renders a real number instantly and reliably,
  // independent of any live Etsy round-trip. Refreshed on every sync via getShop.
  const shopCols = db.pragma('table_info(shops)').map((c) => c.name);
  if (!shopCols.includes('listing_active_count')) {
    db.exec(`ALTER TABLE shops ADD COLUMN listing_active_count INTEGER`);
  }
  if (!shopCols.includes('listing_count_synced_at')) {
    db.exec(`ALTER TABLE shops ADD COLUMN listing_count_synced_at INTEGER`);
  }
  // High-water mark (max ledger create_date synced) for incremental earnings sync.
  if (!shopCols.includes('ledger_synced_at')) {
    db.exec(`ALTER TABLE shops ADD COLUMN ledger_synced_at INTEGER`);
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

    // ── 4PX Shipping Cost (freight) ───────────────────────────────────────────
    // Populated by the freight sync pass (src/workers/sync.js → runFreightSyncPass)
    // and the on-demand endpoints, which call ds.xms.order.getFreight for orders
    // that have a 4PX consignment. 4PX only finalizes (bills) the freight AFTER it
    // physically weighs the parcel, so the cost has a lifecycle:
    //   NULL/'pending' = consignment exists but 4PX hasn't computed a charge yet.
    //   'billed'       = 4PX returned a real freight charge (authoritative cost).
    //   'error'        = the last freight query failed (see fourpx_freight_fetched_at).

    // Total billed freight charge — the headline shipping cost for this order.
    ['fourpx_freight_amount',   'REAL'],
    // ISO currency of fourpx_freight_amount as returned by 4PX (e.g. 'USD', 'CNY').
    ['fourpx_freight_currency', 'TEXT'],
    // Chargeable/billed weight 4PX used to compute the freight, in GRAMS (best-effort).
    ['fourpx_billed_weight_g',  'INTEGER'],
    // JSON array of the itemized fee breakdown ([{type,name,amount,currency}, …]).
    // Stored so the UI can show "freight + fuel + remote-area surcharge" detail.
    ['fourpx_freight_breakdown','TEXT'],
    // Cost lifecycle status:
    //   'pending'   = consignment exists, no cost resolved yet.
    //   'estimated' = live rate-card cost from ds.xms.estimated_cost.get (available
    //                 immediately; what the 4PX portal shows at measurement time).
    //   'billed'    = truly-settled cost from ds.xms.order.getFreight (authoritative;
    //                 supersedes an estimate once 4PX financially settles the order).
    //   'error'     = the last cost query failed.
    ['fourpx_freight_status',   'TEXT'],
    // Unix epoch of the last successful (or attempted) freight query for this order.
    // Used to rate-limit re-queries in the sync worker. NULL = never queried.
    ['fourpx_freight_fetched_at','INTEGER'],
    // The logistics_product_code used for this shipment (e.g. 'S5058'), captured at
    // order-creation time. Needed to price the order via ds.xms.estimated_cost.get.
    ['fourpx_product_code',     'TEXT'],
    // The DECLARED parcel weight (grams) sent at order-creation time. Used as the
    // weight input to the estimated-cost lookup until 4PX returns a billed charge weight.
    ['fourpx_weight_g',         'INTEGER'],

    // ── 4PX parcel tracking snapshot (Shipping tab) ───────────────────────────
    // Cached by the tracking sync pass so the Shipping tab can list every parcel's
    // live status (and flag "stuck" ones) without making a 4PX API call per row.
    // The authoritative, full event history is fetched on demand via /api/4px/track.

    // Canonical lifecycle status from the carrier feed:
    //   'pre_transit' | 'in_transit' | 'delivered' | 'exception' | 'unknown'
    ['tracking_status',         'TEXT'],
    // Human-readable description of the MOST RECENT tracking event (e.g.
    // "Customs check" / "Released from customs: customs cleared.").
    ['tracking_last_event',     'TEXT'],
    // Unix epoch of the most recent tracking event. The Shipping tab uses
    // (now - this) to compute "days since last update" and flag stuck parcels.
    ['tracking_last_event_at',  'INTEGER'],
    // Location string of the most recent event (e.g. "LAX", "Nancheng, China").
    ['tracking_last_location',  'TEXT'],
    // Unix epoch when the parcel was delivered (terminal). NULL until delivered.
    ['tracking_delivered_at',   'INTEGER'],
    // Stuck/delay verdict from analyzeTrackingHealth (which inspects the FULL event
    // history: customs loops, repeated scans, no-movement, long transit). Persisted
    // so the Shipping tab's "stuck" filter/cards match the timeline modal exactly,
    // since the full-history heuristics can't be re-derived from a single SQL row.
    //   'ok' | 'warning' | 'critical'   (NULL = not yet analysed)
    ['tracking_health',         'TEXT'],
    // Primary human-readable reason behind a non-ok health verdict (for the list
    // tooltip), e.g. "7 customs scans with no delivery — likely held at customs."
    ['tracking_health_reason',  'TEXT'],

    // ── Operator Archive (stuck pre-transit orders) ───────────────────────────
    // Sometimes a shipping label is created with the WRONG tracking number, so the
    // order is stuck showing "Pre-transit" forever even though the parcel is really
    // in transit or already delivered (the carrier never scans the bogus number, so
    // carrier_confirmed_at never gets set). The operator can manually archive such an
    // order to remove it from the active Orders views WITHOUT cancelling it on Etsy
    // or losing the historical record.
    //
    // NULL          = active (visible in normal views).
    // Non-NULL      = Unix epoch when the operator archived the order. Surfaces only
    //                 in the dedicated "Archived" view (shipped=archived) and is
    //                 preserved across Etsy re-syncs (this column is never written by
    //                 upsertReceipt, so ON CONFLICT leaves it untouched).
    ['archived_at',            'INTEGER'],
    // Optional free-text reason captured at archive time, e.g.
    // "wrong tracking number — parcel already delivered". Cleared on restore.
    ['archive_reason',         'TEXT'],

    // ── Needs-purchase / out-of-stock flag (pre-transit orders) ────────────────
    // As order volume grows, products frequently go out of stock right as the Etsy
    // ship-by deadline arrives. The operator buys time by creating a shipping label
    // and marking the order shipped on Etsy (so it becomes "Pre-transit"), but the
    // physical product STILL has to be purchased. Because such orders are already
    // is_shipped = 1, the default purchasing queries (which look at unshipped orders)
    // would otherwise drop them — and they'd silently never get bought.
    //
    // This flag lets the operator explicitly mark a pre-transit order as "still out
    // of stock — needs purchase". Flagged orders are surfaced in a dedicated Orders
    // view AND automatically merged into the Route (purchasing) dashboard, server-side
    // and durably, so they reliably get bought regardless of which browser is used.
    //
    // NULL     = not flagged.
    // Non-NULL = Unix epoch when the operator marked it as needing purchase.
    // Preserved across Etsy re-syncs (never written by upsertReceipt, so ON CONFLICT
    // leaves it untouched). Cleared once the product has actually been purchased.
    ['needs_purchase_at',      'INTEGER'],
    // Optional free-text note captured when flagging, e.g. "switched buyer to design B".
    ['needs_purchase_note',    'TEXT'],

    // ── Packaged flag (pre-transit orders) ────────────────────────────────────
    // Operator-set flag indicating the physical parcel has been fully assembled
    // (all products picked, packed, and labelled) and is physically ready for
    // carrier pickup — distinct from "shipped" (Etsy label created) and from
    // "in transit" (carrier first scan).
    //
    // Workflow: order ships on Etsy to meet the deadline → Pre-transit view →
    // operator physically packs the order → clicks "Mark packaged" →
    // packaged_at is set. The pre-transit view can then be filtered to show
    // only "Not yet packaged" or "Packaged", letting the operator track exactly
    // which parcels are still sitting on the packing bench vs. ready for pickup.
    //
    // NULL     = not yet packaged.
    // Non-NULL = Unix epoch when the operator marked it as packaged.
    // Preserved across Etsy re-syncs (never written by upsertReceipt, so
    // ON CONFLICT leaves it untouched). Can be cleared (unmark) if set in error.
    ['packaged_at',            'INTEGER'],

    // ── Order origin ──────────────────────────────────────────────────────────
    // Distinguishes how a receipt entered the system:
    //   'etsy'   = synced from the Etsy API (the default for every real order).
    //   'manual' = operator-created directly in the Orders tab ("New manual order")
    //              for off-Etsy / replacement / wholesale orders. Manual orders carry
    //              a NEGATIVE receipt_id (≤ -1e9) so they never collide with Etsy's
    //              positive receipt ids, are never pushed to or fetched from Etsy, and
    //              are skipped by the sync worker. They still flow through the SAME
    //              packaging, 4PX-shipping and label machinery as Etsy orders.
    // ALTER ... ADD COLUMN with a DEFAULT backfills every existing row to 'etsy'.
    ['source',                 "TEXT DEFAULT 'etsy'"],
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
    CREATE INDEX IF NOT EXISTS idx_receipts_fourpx_consignment ON receipts(fourpx_consignment_no);
    CREATE INDEX IF NOT EXISTS idx_receipts_archived_at       ON receipts(archived_at);
    CREATE INDEX IF NOT EXISTS idx_receipts_needs_purchase    ON receipts(needs_purchase_at);
    CREATE INDEX IF NOT EXISTS idx_receipts_packaged_at       ON receipts(packaged_at);
    CREATE INDEX IF NOT EXISTS idx_receipts_source            ON receipts(source)
  `);

  // If shipment_notified_at already exists but wasn't populated during the backfill
  // (e.g., column existed but was NULL), backfill it from raw_json now.
  // Note: the LIKE '%shipment_notification_timestamp%' was removed — it caused a
  // full table scan on raw_json (O(n) text match) on every startup.  The index on
  // shipment_notified_at + is_shipped is fast enough; the inner loop only parses
  // JSON for rows that actually need a value set, so there's no extra overhead.
  const nullNotified = db.prepare(`
    SELECT COUNT(*) as cnt FROM receipts
    WHERE shipment_notified_at IS NULL AND is_shipped = 1
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

  // Repair locally-completed orders that never got a shipment_notification_timestamp
  // from Etsy (they were shipped/completed from the dashboard while the receipt
  // sync was paused/rate-limited, so raw_json has no shipment yet). Without a
  // shipment_notified_at they fail the Pre-transit / Ready-to-pack filters and are
  // wrongly treated as In-transit, vanishing from the pack queue. Stamp an ACCURATE
  // proxy ship time (when the 4PX shipment / order was last touched) — never "now",
  // so the pre_transit_days window stays correct: genuinely old orders still read as
  // In-transit, recent ones correctly read as Pre-transit / Ready-to-pack. Idempotent
  // and effectively one-time: new local completions stamp the field themselves.
  const repaired = db.prepare(`
    UPDATE receipts
    SET shipment_notified_at = COALESCE(fourpx_created_at, etsy_updated_at, synced_at)
    WHERE shipment_notified_at IS NULL
      AND is_shipped = 1
      AND tracking_code IS NOT NULL
      AND COALESCE(fourpx_created_at, etsy_updated_at, synced_at) IS NOT NULL
  `).run();
  if (repaired.changes > 0) {
    console.log(`[db] Repaired shipment_notified_at for ${repaired.changes} locally-completed order(s) (restores Ready-to-pack/Pre-transit)`);
  }

  // ── route_assignments migrations ─────────────────────────────────────────
  // Add new columns that weren't in the original CREATE TABLE.
  const routeCols = db.pragma('table_info(route_assignments)').map(c => c.name);
  const newRouteCols = [
    // Manual supplier overrides — let the user correct a wrong catalog match
    // or fill in a supplier for items not yet in the OSP catalog.
    ['supplier_shop_override', 'TEXT', "''"],
    ['supplier_stall_override', 'TEXT', "''"],
    // Durable "removed from the Orders Sorting Dashboard" marker. When set (a unix
    // timestamp), the line is permanently dropped from the route dashboard view AND
    // from route generation — without touching the underlying Etsy receipt. NULL =
    // active. This is distinct from `excluded` (which keeps the line visible for
    // reference but skips it in the next generated route). Reversible via Restore.
    ['dismissed_at', 'INTEGER', 'NULL'],
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

  // cost columns — wholesale purchase price shown on the mobile shopping route so
  // the shopper can pay the supplier (e.g. via WeChat) without asking the owner.
  //   product_map.cost_case / cost_grip = case & grip prices, priced SEPARATELY
  //     (same supplier stall, but each component has its own price)
  //   charm_library.cost                = charm price per code (paid at charm stall)
  // REAL + nullable (NULL = "not priced yet"). Preserved by every other product_map
  // / charm write because those ON CONFLICT updates never mention these columns.
  const pmCols = db.pragma('table_info(product_map)').map(c => c.name);
  if (!pmCols.includes('cost_case')) db.exec('ALTER TABLE product_map ADD COLUMN cost_case REAL');
  if (!pmCols.includes('cost_grip')) db.exec('ALTER TABLE product_map ADD COLUMN cost_grip REAL');
  if (!pmCols.includes('canonical_product_key')) db.exec('ALTER TABLE product_map ADD COLUMN canonical_product_key TEXT');
  // Retire the earlier single combined `cost` column (only ever briefly present,
  // no meaningful data): fold any value into cost_case, then drop it. Guarded so
  // it's a no-op once removed / on SQLite builds without DROP COLUMN.
  if (pmCols.includes('cost')) {
    try {
      db.exec('UPDATE product_map SET cost_case = cost WHERE cost IS NOT NULL AND cost_case IS NULL');
      db.exec('ALTER TABLE product_map DROP COLUMN cost');
    } catch (e) {
      console.warn('[db] could not drop legacy product_map.cost:', e.message);
    }
  }
  const clCols = db.pragma('table_info(charm_library)').map(c => c.name);
  if (!clCols.includes('cost')) db.exec('ALTER TABLE charm_library ADD COLUMN cost REAL');

  const phashCols = db.pragma('table_info(listing_phash)').map(c => c.name);
  if (!phashCols.includes('algo')) db.exec('ALTER TABLE listing_phash ADD COLUMN algo TEXT');
  if (!phashCols.includes('canonical_key')) db.exec('ALTER TABLE listing_phash ADD COLUMN canonical_key TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_listing_phash_canonical ON listing_phash(canonical_key)');

  // seq for bulk_job_items — preserves the scanner's natural-sort order
  //   (1, 2, 3 … 10, 11) instead of SQLite's lexicographic text order
  //   (1, 10, 11, 2, 20). Without this the processing order AND the progress
  //   table both render folders out of human order.
  // preview_json   — full inspection payload (copy + variations + image order +
  //                  settings) computed at generation time, so the Inspector can
  //                  render everything with zero recomputation / Etsy calls.
  // published_at   — epoch when a created draft was published to Etsy.
  const bulkItemCols = db.pragma('table_info(bulk_job_items)').map(c => c.name);
  if (!bulkItemCols.includes('seq')) {
    db.exec('ALTER TABLE bulk_job_items ADD COLUMN seq INTEGER');
  }
  if (!bulkItemCols.includes('preview_json')) {
    db.exec('ALTER TABLE bulk_job_items ADD COLUMN preview_json TEXT');
  }
  if (!bulkItemCols.includes('published_at')) {
    db.exec('ALTER TABLE bulk_job_items ADD COLUMN published_at INTEGER');
  }
  // reviewed_at — epoch when the operator marked the listing manually reviewed
  // ("good to go"). Drives the review badge, the reviewed counter, and the
  // create-drafts confirmation guard.
  if (!bulkItemCols.includes('reviewed_at')) {
    db.exec('ALTER TABLE bulk_job_items ADD COLUMN reviewed_at INTEGER');
  }
  // excluded — operator flagged this product to be SKIPPED when the dry-run is
  // promoted to real Etsy drafts (kept in the list for context, never created).
  if (!bulkItemCols.includes('excluded')) {
    db.exec('ALTER TABLE bulk_job_items ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0');
  }
  // auto_resume_count — how many times a job has been auto-resumed after an
  // interrupted (crashed/restarted) run without making fresh progress. Caps a
  // crash-loop: it's reset to 0 whenever an item completes, so steady progress
  // keeps the budget topped up and only repeated no-progress crashes exhaust it.
  const bulkJobCols = db.pragma('table_info(bulk_jobs)').map(c => c.name);
  if (!bulkJobCols.includes('auto_resume_count')) {
    db.exec('ALTER TABLE bulk_jobs ADD COLUMN auto_resume_count INTEGER NOT NULL DEFAULT 0');
  }
  // Backfill seq for items created before the column existed, using the same
  // natural-sort the scanner applies (so legacy jobs also read 1,2,3…10,11 and
  // become inspectable by seq).
  const needsBackfill = db.prepare('SELECT COUNT(*) AS n FROM bulk_job_items WHERE seq IS NULL').get().n;
  if (needsBackfill > 0) {
    const naturalKey = (s) => {
      const m = String(s || '').match(/\d+/);
      return m ? parseInt(m[0], 10) : Number.MAX_SAFE_INTEGER;
    };
    const jobIds = db.prepare('SELECT DISTINCT job_id FROM bulk_job_items WHERE seq IS NULL').all().map((r) => r.job_id);
    const setSeq = db.prepare('UPDATE bulk_job_items SET seq = ? WHERE job_id = ? AND product_folder = ?');
    const tx = db.transaction((jids) => {
      for (const jid of jids) {
        const rows = db.prepare('SELECT product_folder, product_name FROM bulk_job_items WHERE job_id = ?').all(jid);
        rows.sort((a, b) => naturalKey(a.product_name) - naturalKey(b.product_name)
          || String(a.product_name).localeCompare(String(b.product_name), undefined, { numeric: true }));
        rows.forEach((r, i) => setSeq.run(i + 1, jid, r.product_folder));
      }
    });
    tx(jobIds);
  }

  // One-time remap of title-prefix keys → listing-scoped keys (fixes charm
  // assignments bleeding across different products that share a title prefix).
  migrateRouteKeysToListingScope(db);

  // One-time migration of the retired "Archive" feature into the Issues system.
  // Out-of-production archives become open per-line Issues; everything else is
  // restored to the active views. Idempotent (it only ever looks at still-archived
  // rows, and clears archived_at as it goes).
  migrateArchivedOrdersToIssues(db);

  // Self-heal any line that is BOTH switched to a new design AND still flagged
  // on-hold, when the switch is the more recent decision. Such a line was being
  // silently withheld from the purchasing route (a switch is meant to un-hold the
  // line, but a resolve that never ran / legacy data left the issue open). This
  // resolves those stale holds so the switched product flows back into shopping.
  // Idempotent — only touches open issues actually superseded by a substitution.
  healSupersededSubstitutionIssues(db);

  // Surface every line whose CURRENT purchase status is terminal (Out of
  // Production / Model Unavailable) as an open fulfilment issue. Heals orders
  // marked terminal on a surface that historically didn't bridge to issues (the
  // desktop Route tab, the Orders-tab per-component control, the bulk route-status
  // import) — they were "on hold" in status yet missing from Issues/on-hold. Runs
  // AFTER the supersede heal so the two never fight. Idempotent.
  reconcileTerminalStatusIssues(db);

  // Synthetic shop/group that owns every manual order (must exist before any
  // manual receipt is inserted, to satisfy the receipts→shops foreign key).
  seedManualOrderShop(db);

  // Backfill the transactions table from already-stored receipts.raw_json so
  // per-order earnings attribution (transaction-fee → receipt) works for the
  // full order history without spending any Etsy API calls. Idempotent.
  backfillTransactionsFromReceipts(db);

  // Self-heal ledger categories against the current rules (e.g. so disbursements
  // are always treated as transfers and excluded from net earnings). Cheap and
  // idempotent — only rewrites rows whose category actually changed.
  recategorizeLedgerEntries(db);

  _db = db;
  return db;
}

/**
 * Populate the `transactions` table from each receipt's stored raw_json.
 * Etsy includes the full `transactions[]` array in the receipt payload we
 * already cache, so this is a pure local reshape — no network calls.
 * Only runs work when there are receipts that have no transactions row yet.
 *
 * @param {Database.Database} db
 */
function backfillTransactionsFromReceipts(db) {
  try {
    const pending = db.prepare(`
      SELECT r.receipt_id, r.shop_id, r.raw_json
      FROM receipts r
      WHERE r.raw_json IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.receipt_id = r.receipt_id)
    `).all();
    if (!pending.length) return;

    let inserted = 0;
    const run = db.transaction((rows) => {
      for (const row of rows) {
        let parsed;
        try { parsed = JSON.parse(row.raw_json); } catch { continue; }
        const txs = Array.isArray(parsed?.transactions) ? parsed.transactions : [];
        for (const tx of txs) {
          if (tx && tx.transaction_id) {
            upsertTransaction(db, row.shop_id, { ...tx, receipt_id: tx.receipt_id ?? row.receipt_id });
            inserted++;
          }
        }
      }
    });
    run(pending);
    if (inserted) console.log(`[db] Backfilled ${inserted} transaction(s) from ${pending.length} receipt(s) for earnings attribution`);
  } catch (err) {
    console.error('[db] transaction backfill failed (non-fatal):', err.message);
  }
}

// Local copies of the dashboard's key helpers. Duplicated here (instead of
// importing src/route/dashboard.js) to avoid a require cycle — dashboard.js
// already depends on this module.
function _normTitleForKey(text) {
  return String(text ?? '').replace(/\|/g, ',').replace(/\s+/g, ' ').trim().toLowerCase();
}
function _baseTitleKey(title) {
  return _normTitleForKey(title).slice(0, 50);
}

/**
 * Migrate `route_assignments` and `product_assignments` from the legacy
 * 50-char title key to the listing-scoped key `${titleKey}#L${listing_id}`.
 *
 * Two different products (listings) that share the same first 50 title
 * characters previously collided onto one key, so a charm assigned to one bled
 * onto the other. We rewrite each saved assignment to be scoped by the listing
 * id resolved from the orders. When a legacy key maps to MORE than one listing
 * (the collision case) the assignment is fanned out to every matching listing,
 * so the current values are preserved and the line-items become independently
 * editable. Rows whose product can no longer be found in any order are left
 * untouched (harmless fallback).
 *
 * Idempotent: guarded by PRAGMA user_version and a per-row marker check.
 *
 * @param {Database.Database} db
 */
function migrateRouteKeysToListingScope(db) {
  const MARKER = '#L';
  try {
    if (db.pragma('user_version', { simple: true }) >= 1) return;
  } catch { /* fall through and attempt the migration */ }

  // Build resolvers from every order's line-items:
  //   perReceipt: receipt_id → (baseKey → Set<listing_id>)
  //   global:     baseKey → Set<listing_id>   (across all orders)
  const perReceipt = new Map();
  const global = new Map();
  let recs = [];
  try {
    recs = db.prepare(
      "SELECT receipt_id, all_transactions FROM receipts WHERE all_transactions IS NOT NULL AND all_transactions <> ''"
    ).all();
  } catch { recs = []; }

  for (const r of recs) {
    let txs = [];
    try { txs = JSON.parse(r.all_transactions || '[]'); } catch { continue; }
    if (!Array.isArray(txs)) continue;
    for (const t of txs) {
      const bk = _baseTitleKey(t.title || '');
      const lid = t.listing_id != null ? String(t.listing_id).trim() : '';
      if (!bk || !lid) continue;
      if (!perReceipt.has(r.receipt_id)) perReceipt.set(r.receipt_id, new Map());
      const m = perReceipt.get(r.receipt_id);
      if (!m.has(bk)) m.set(bk, new Set());
      m.get(bk).add(lid);
      if (!global.has(bk)) global.set(bk, new Set());
      global.get(bk).add(lid);
    }
  }

  const scoped = (base, lid) => `${base}${MARKER}${lid}`;

  const tx = db.transaction(() => {
    // ── route_assignments ──────────────────────────────────────────────────
    let raRows = [];
    try { raRows = db.prepare('SELECT * FROM route_assignments').all(); } catch { raRows = []; }

    const insRA = db.prepare(`
      INSERT OR IGNORE INTO route_assignments
        (receipt_id, item_key, title, charm_code, charm_shop,
         status_case, status_grip, status_charm, excluded,
         supplier_shop_override, supplier_stall_override, updated_at)
      VALUES
        (@receipt_id, @item_key, @title, @charm_code, @charm_shop,
         @status_case, @status_grip, @status_charm, @excluded,
         @supplier_shop_override, @supplier_stall_override, @updated_at)
    `);
    const delRA = db.prepare('DELETE FROM route_assignments WHERE receipt_id = ? AND item_key = ?');

    for (const a of raRows) {
      if (typeof a.item_key === 'string' && a.item_key.includes(MARKER)) continue; // already scoped
      const listings = perReceipt.get(a.receipt_id)?.get(a.item_key);
      if (!listings || listings.size === 0) continue;                              // unresolved → leave as-is
      for (const lid of listings) {
        insRA.run({
          receipt_id:              a.receipt_id,
          item_key:                scoped(a.item_key, lid),
          title:                   a.title ?? '',
          charm_code:              a.charm_code ?? '',
          charm_shop:              a.charm_shop ?? '',
          status_case:             a.status_case ?? 'Pending',
          status_grip:             a.status_grip ?? 'Pending',
          status_charm:            a.status_charm ?? 'Pending',
          excluded:                a.excluded ?? 0,
          supplier_shop_override:  a.supplier_shop_override ?? '',
          supplier_stall_override: a.supplier_stall_override ?? '',
          updated_at:              a.updated_at ?? Math.floor(Date.now() / 1000),
        });
      }
      delRA.run(a.receipt_id, a.item_key);
    }

    // ── product_assignments ────────────────────────────────────────────────
    let paRows = [];
    try { paRows = db.prepare('SELECT * FROM product_assignments').all(); } catch { paRows = []; }

    const insPA = db.prepare(`
      INSERT OR IGNORE INTO product_assignments
        (item_key, title, supplier_shop, supplier_stall, charm_code, charm_shop, updated_at)
      VALUES
        (@item_key, @title, @supplier_shop, @supplier_stall, @charm_code, @charm_shop, @updated_at)
    `);
    const delPA = db.prepare('DELETE FROM product_assignments WHERE item_key = ?');

    for (const a of paRows) {
      if (typeof a.item_key === 'string' && a.item_key.includes(MARKER)) continue;
      const listings = global.get(a.item_key);
      if (!listings || listings.size === 0) continue;
      for (const lid of listings) {
        insPA.run({
          item_key:       scoped(a.item_key, lid),
          title:          a.title ?? '',
          supplier_shop:  a.supplier_shop ?? '',
          supplier_stall: a.supplier_stall ?? '',
          charm_code:     a.charm_code ?? '',
          charm_shop:     a.charm_shop ?? '',
          updated_at:     a.updated_at ?? Math.floor(Date.now() / 1000),
        });
      }
      delPA.run(a.item_key);
    }
  });

  try {
    tx();
    db.pragma('user_version = 1');
  } catch (err) {
    console.error('[db] listing-scope key migration failed (left data untouched):', err.message);
  }
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
 * Reconcile the DB against config.json by removing shops (and now-empty groups)
 * that were deleted from config — making config.json the single source of truth.
 *
 * SAFETY: this NEVER destroys order history. A shop is pruned only when it has
 * zero rows in EVERY table that references it (receipts, transactions, events,
 * listings, sync_log, route assignments, etc.). If any dependent
 * data exists, the shop is kept and a warning is logged so the operator can
 * decide what to do. The synthetic "Manual Orders" shop/group is always
 * protected. The set of dependent tables is discovered dynamically from the
 * schema, so it stays correct as new shop_id-bearing tables are added.
 *
 * @param {Database.Database} db
 * @param {Set<string>} configShopIds   - shop_ids present in config.json
 * @param {Set<string>} configGroupIds  - group_ids present in config.json
 */
function pruneRemovedShops(db, configShopIds, configGroupIds) {
  // Tables (other than `shops` itself) that carry a shop_id column.
  const dependentTables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('shops', 'sqlite_sequence')`)
    .all()
    .map((r) => r.name)
    .filter((name) =>
      db.prepare(`PRAGMA table_info("${name}")`).all().some((col) => col.name === 'shop_id')
    );

  const dbShops = db.prepare('SELECT shop_id, group_id FROM shops').all();
  for (const { shop_id: shopId } of dbShops) {
    if (shopId === MANUAL_SHOP_ID) continue;       // never prune the synthetic shop
    if (configShopIds.has(shopId)) continue;       // still in config — keep

    let dependentRows = 0;
    for (const table of dependentTables) {
      dependentRows += db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE shop_id = ?`).get(shopId).n;
      if (dependentRows > 0) break;
    }

    if (dependentRows > 0) {
      console.warn(
        `[config-sync] Shop "${shopId}" was removed from config.json but still has ` +
        `data in the database — keeping it to preserve history. Delete its data ` +
        `manually if you intend to remove it permanently.`
      );
      continue;
    }

    db.prepare('DELETE FROM shops WHERE shop_id = ?').run(shopId);
    console.log(`[config-sync] Pruned shop "${shopId}" (removed from config.json, no data).`);
  }

  // Prune now-empty groups that no longer exist in config (except the synthetic one).
  const dbGroups = db.prepare('SELECT group_id FROM groups').all();
  for (const { group_id: groupId } of dbGroups) {
    if (groupId === MANUAL_GROUP_ID) continue;
    if (configGroupIds.has(groupId)) continue;
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM shops WHERE group_id = ?').get(groupId).n;
    if (remaining === 0) {
      db.prepare('DELETE FROM groups WHERE group_id = ?').run(groupId);
      console.log(`[config-sync] Pruned empty group "${groupId}" (removed from config.json).`);
    }
  }
}

/**
 * Sync config groups and shops into the database on startup.
 * Ensures DB reflects any changes made to config.json — additions and updates
 * are upserted, and shops/groups removed from config are pruned (when safe) so
 * config.json remains the single source of truth.
 *
 * @param {Database.Database} db
 * @param {import('../config/schema').AppConfig} config
 */
function syncConfigToDb(db, config) {
  const sync = db.transaction(() => {
    const configShopIds = new Set();
    const configGroupIds = new Set();
    for (const group of config.groups) {
      configGroupIds.add(group.group_id);
      upsertGroup(db, group);
      for (const shop of group.shops) {
        configShopIds.add(shop.shop_id);
        upsertShop(db, { ...shop, group_id: group.group_id });
      }
    }
    pruneRemovedShops(db, configShopIds, configGroupIds);
  });
  sync();
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
      -- Protect these fields from being overwritten with NULL when the Etsy API
      -- returns an incomplete payload (e.g. Pass B "recently-updated" queries
      -- sometimes return receipts whose transactions[] array is empty or whose
      -- expected_ship_date has not yet been computed).  COALESCE means: use the
      -- new value if it is non-NULL, otherwise keep what we already have.
      -- This is safe because a legitimately-changed value (new ship date, title
      -- edit, address correction) will always arrive as a non-NULL string from
      -- Etsy — the only source of NULL here is a transient API gap.
      first_product_title  = COALESCE(excluded.first_product_title, first_product_title),
      first_listing_id     = COALESCE(excluded.first_listing_id,    first_listing_id),
      first_quantity       = COALESCE(excluded.first_quantity,       first_quantity),
      first_ship_by        = COALESCE(excluded.first_ship_by,        first_ship_by),
      first_variations     = COALESCE(excluded.first_variations,     first_variations),
      all_transactions     = COALESCE(excluded.all_transactions,     all_transactions),
      formatted_address    = COALESCE(excluded.formatted_address,    formatted_address),
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
    name: decodeHtmlEntities(receipt.name ?? null),
    status: receipt.status ?? null,
    is_shipped: receipt.is_shipped ? 1 : 0,
    is_paid: receipt.is_paid ? 1 : 0,
    grandtotal_amount: money(receipt.grandtotal),
    grandtotal_currency: currency(receipt.grandtotal),
    subtotal_amount: money(receipt.subtotal),
    discount_amount: money(receipt.discount_amt),
    shipping_cost: money(receipt.total_shipping_cost),
    total_tax_cost: money(receipt.total_tax_cost),
    message_from_buyer: decodeHtmlEntities(receipt.message_from_buyer ?? null),
    message_from_seller: decodeHtmlEntities(receipt.message_from_seller ?? null),
    shipping_first_line:  decodeHtmlEntities(receipt.first_line  ?? null),
    shipping_second_line: decodeHtmlEntities(receipt.second_line ?? null),
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
  // Etsy Money objects: { amount: integer, divisor: integer, currency_code: string }
  // divisor is the ACTUAL divisor (e.g. 100 → divide by 100 to get dollars),
  // NOT a decimal exponent. Using Math.pow(10, divisor) is wrong: for USD
  // divisor=100 that yields 10^100 (a googol), storing prices as ~0.
  const money = (obj) => (obj && obj.divisor ? obj.amount / obj.divisor : null);
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

// ─────────────────────────────────────────────────────────────────────────────
// Earnings / payment-account ledger
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize an Etsy ledger entry into a coarse accounting category used by the
 * Finance tab's breakdown. Driven by ledger_type (falling back to description).
 * @param {string} ledgerType
 * @param {string} [description]
 * @returns {'sales'|'processing_fee'|'transaction_fee'|'tax'|'ads'|'listing_fee'|'subscription'|'refund'|'shipping_label'|'transfer'|'other'}
 */
function categorizeLedgerEntry(ledgerType, description, referenceType) {
  const t  = String(ledgerType || description || '').toLowerCase();
  const rt = String(referenceType || '').toLowerCase();

  // ── Transfers / funding events — money moving between the Etsy balance and the
  // seller's bank/card, NOT earnings. These MUST be excluded from net, or the
  // total collapses to just the current undisbursed balance.
  // Detected primarily by reference_type because Etsy's ledger_type strings vary
  // (e.g. the disbursement type is "DISBURSE2", not "disbursement").
  if (rt === 'disbursement' || rt === 'recoupment' || rt === 'billing_payment' ||
      t.includes('disburse') || t.includes('recoup') ||
      t.includes('bill_payment') || t.includes('billing_payment') ||
      t.includes('deposit') || t.includes('withdrawal') || t.includes('payout')) {
    return 'transfer';
  }

  if (t.includes('payment_gross') || t === 'payment')          return 'sales';
  if (t.includes('processing_fee'))                            return 'processing_fee'; // incl. vat_on_processing_fees
  if (t.includes('regulatory'))                                return 'regulatory_fee';
  if (t.includes('shipping_transaction') || t.includes('transaction')) return 'transaction_fee';
  if (t.includes('shipping_label') || t.includes('postage'))   return 'shipping_label';
  if (t.includes('sales_tax') || t.includes('vat'))            return 'tax';
  if (t.includes('prolist') || t.includes('offsite') || t.includes('etsy_ads') || t.includes('ads')) return 'ads';
  if (t.includes('subscription') || t.includes('tier_') || t.includes('etsy_plus')) return 'subscription';
  if (t.includes('renew') || t.includes('listing') || t.includes('publish')) return 'listing_fee';
  if (t.includes('refund'))                                    return 'refund';
  if (t.includes('misc') || t.includes('credit'))             return 'credit';
  return 'other';
}

/**
 * Resolve which receipt a ledger entry belongs to, using the entry's reference
 * fields plus our local payment→receipt and transaction→receipt maps.
 * Returns null for shop-level entries (subscriptions, ads, payouts, …).
 */
function resolveLedgerReceiptId(db, entry) {
  const refType = String(entry.reference_type || '').toLowerCase();
  const refId   = entry.reference_id != null ? String(entry.reference_id) : null;
  if (!refId) return null;

  if (refType === 'receipt') return Number(refId);

  if (refType === 'shop_payment' || refType === 'processing_fee' || refType === 'payment') {
    const row = db.prepare('SELECT receipt_id FROM etsy_payments WHERE payment_id = ?').get(refId);
    return row?.receipt_id ?? null;
  }

  if (refType === 'transaction') {
    const row = db.prepare('SELECT receipt_id FROM transactions WHERE transaction_id = ?').get(refId);
    return row?.receipt_id ?? null;
  }

  return null;
}

/** Upsert a payment_id → receipt_id mapping row. */
function upsertEtsyPayment(db, shopId, paymentId, receiptId) {
  if (paymentId == null || receiptId == null) return;
  db.prepare(`
    INSERT INTO etsy_payments (payment_id, shop_id, receipt_id, synced_at)
    VALUES (@payment_id, @shop_id, @receipt_id, strftime('%s','now'))
    ON CONFLICT(payment_id) DO UPDATE SET
      receipt_id = excluded.receipt_id,
      synced_at  = excluded.synced_at
  `).run({ payment_id: Number(paymentId), shop_id: shopId, receipt_id: Number(receiptId) });
}

/**
 * Upsert one ledger entry, computing its category and resolved receipt_id.
 * @param {Database.Database} db
 * @param {string} shopId
 * @param {object} e - raw PaymentAccountLedgerEntry from Etsy
 * @returns {number} the resolved receipt_id, or 0/NULL-ish if shop-level
 */
function upsertLedgerEntry(db, shopId, e) {
  const category   = categorizeLedgerEntry(e.ledger_type, e.description, e.reference_type);
  const receiptId  = resolveLedgerReceiptId(db, e);
  db.prepare(`
    INSERT INTO ledger_entries (
      entry_id, shop_id, sequence_number, amount_cents, currency,
      ledger_type, reference_type, reference_id, description,
      balance_cents, create_date, receipt_id, category, synced_at
    ) VALUES (
      @entry_id, @shop_id, @sequence_number, @amount_cents, @currency,
      @ledger_type, @reference_type, @reference_id, @description,
      @balance_cents, @create_date, @receipt_id, @category, strftime('%s','now')
    )
    ON CONFLICT(entry_id) DO UPDATE SET
      amount_cents   = excluded.amount_cents,
      balance_cents  = excluded.balance_cents,
      description    = excluded.description,
      receipt_id     = COALESCE(excluded.receipt_id, ledger_entries.receipt_id),
      category       = excluded.category,
      synced_at      = excluded.synced_at
  `).run({
    entry_id:        Number(e.entry_id),
    shop_id:         shopId,
    sequence_number: e.sequence_number ?? null,
    amount_cents:    Math.round(Number(e.amount) || 0),
    currency:        e.currency ?? null,
    ledger_type:     e.ledger_type ?? null,
    reference_type:  e.reference_type ?? null,
    reference_id:    e.reference_id != null ? String(e.reference_id) : null,
    description:     e.description ?? null,
    balance_cents:   e.balance != null ? Math.round(Number(e.balance)) : null,
    create_date:     e.create_date ?? e.created_timestamp ?? null,
    receipt_id:      receiptId,
    category,
  });
  return receiptId;
}

/**
 * Recompute the stored `category` for every ledger row using the current
 * categorization logic. Categories are a pure function of (ledger_type,
 * reference_type), so this is a fast local reshape (no API calls) that
 * self-heals historical rows whenever the rules change. Idempotent.
 * @returns {number} rows updated
 */
function recategorizeLedgerEntries(db) {
  let pairs;
  try {
    pairs = db.prepare('SELECT DISTINCT ledger_type, reference_type FROM ledger_entries').all();
  } catch { return 0; }
  if (!pairs.length) return 0;

  const upd = db.prepare(`
    UPDATE ledger_entries SET category = @cat
    WHERE ledger_type IS @lt AND reference_type IS @rt AND category IS NOT @cat
  `);
  let changed = 0;
  const run = db.transaction(() => {
    for (const p of pairs) {
      const cat = categorizeLedgerEntry(p.ledger_type, null, p.reference_type);
      changed += upd.run({ cat, lt: p.ledger_type, rt: p.reference_type }).changes;
    }
  });
  run();
  if (changed) console.log(`[db] Re-categorized ${changed} ledger entr${changed === 1 ? 'y' : 'ies'} to current rules`);
  return changed;
}

/**
 * Re-resolve receipt_id for ledger rows that are still unattributed but now
 * have a payment/transaction mapping available. Returns the number updated.
 */
function reattributeLedgerEntries(db, shopId) {
  const rows = db.prepare(`
    SELECT entry_id, reference_type, reference_id
    FROM ledger_entries
    WHERE shop_id = ? AND receipt_id IS NULL AND reference_id IS NOT NULL
  `).all(shopId);
  let updated = 0;
  const upd = db.prepare('UPDATE ledger_entries SET receipt_id = ? WHERE entry_id = ?');
  const run = db.transaction(() => {
    for (const r of rows) {
      const rid = resolveLedgerReceiptId(db, r);
      if (rid != null) { upd.run(rid, r.entry_id); updated++; }
    }
  });
  run();
  return updated;
}

/** Update a shop's ledger high-water mark (max create_date synced). */
function updateShopLedgerSyncTime(db, shopId, epoch) {
  db.prepare('UPDATE shops SET ledger_synced_at = ? WHERE shop_id = ?')
    .run(Math.trunc(epoch), shopId);
}

/**
 * Earnings summary grouped by shop and currency for a date window.
 * Net excludes 'transfer' (disbursements/payouts) since those move the balance
 * out to the bank rather than representing earnings.
 *
 * @param {Database.Database} db
 * @param {object} opts
 * @param {number} [opts.from] - unix seconds inclusive
 * @param {number} [opts.to]   - unix seconds inclusive
 * @param {string} [opts.shopId] - limit to one shop
 * @returns {{ byShop: object[], byCurrency: object[], byCategory: object[] }}
 */
function getEarningsSummary(db, opts = {}) {
  // Columns are qualified with the `l.` (ledger_entries) alias because byShop
  // joins the shops table, which also has a shop_id column — an unqualified
  // reference would be "ambiguous column name: shop_id".
  const where = ['1=1'];
  const params = {};
  if (opts.from != null) { where.push('l.create_date >= @from'); params.from = opts.from; }
  if (opts.to   != null) { where.push('l.create_date <= @to');   params.to   = opts.to; }
  if (opts.shopId)       { where.push('l.shop_id = @shopId');     params.shopId = opts.shopId; }
  const W = where.join(' AND ');

  const byShop = db.prepare(`
    SELECT l.shop_id, s.shop_name, l.currency,
      SUM(CASE WHEN l.category='sales'    THEN l.amount_cents ELSE 0 END) AS gross_cents,
      SUM(CASE WHEN l.category IN ('processing_fee','transaction_fee','regulatory_fee','ads','listing_fee','subscription','shipping_label','credit','other') THEN l.amount_cents ELSE 0 END) AS fees_cents,
      SUM(CASE WHEN l.category='tax'      THEN l.amount_cents ELSE 0 END) AS tax_cents,
      SUM(CASE WHEN l.category='refund'   THEN l.amount_cents ELSE 0 END) AS refund_cents,
      SUM(CASE WHEN l.category<>'transfer' THEN l.amount_cents ELSE 0 END) AS net_cents,
      COUNT(*) AS entries
    FROM ledger_entries l
    LEFT JOIN shops s ON s.shop_id = l.shop_id
    WHERE ${W}
    GROUP BY l.shop_id, l.currency
    ORDER BY net_cents DESC
  `).all(params);

  const byCurrency = db.prepare(`
    SELECT l.currency,
      SUM(CASE WHEN l.category='sales' THEN l.amount_cents ELSE 0 END) AS gross_cents,
      SUM(CASE WHEN l.category<>'transfer' THEN l.amount_cents ELSE 0 END) AS net_cents,
      SUM(CASE WHEN l.category NOT IN ('sales','transfer','tax','refund') THEN l.amount_cents ELSE 0 END) AS fees_cents,
      SUM(CASE WHEN l.category='tax' THEN l.amount_cents ELSE 0 END) AS tax_cents,
      SUM(CASE WHEN l.category='refund' THEN l.amount_cents ELSE 0 END) AS refund_cents
    FROM ledger_entries l
    WHERE ${W}
    GROUP BY l.currency
  `).all(params);

  const byCategory = db.prepare(`
    SELECT l.currency, l.category,
      SUM(l.amount_cents) AS amount_cents, COUNT(*) AS entries
    FROM ledger_entries l
    WHERE ${W}
    GROUP BY l.currency, l.category
    ORDER BY l.currency, amount_cents
  `).all(params);

  return { byShop, byCurrency, byCategory };
}

/**
 * Net profit for the current calendar month, per currency.
 *
 * Etsy's "Activity summary" headlines the month-to-date net profit ("Your
 * current net profit on Etsy for this month is …"), independent of any custom
 * date range the seller has chosen. We surface the same figure so the dashboard
 * reconciles 1:1 with what Etsy shows, regardless of the Earnings tab's range
 * filter. The month boundary is computed in the server's local time — the same
 * frame Etsy uses for the seller's shop — and the window is open-ended on the
 * upper side so it always means "month start → now".
 *
 * @param {Database.Database} db
 * @param {object} opts
 * @param {string} [opts.shopId] - limit to one shop
 * @param {number} [opts.now]    - unix seconds, for deterministic testing
 * @returns {{ from: number, label: string,
 *             byCurrency: { currency: string, gross_cents: number,
 *               net_cents: number, marketing_cents: number }[] }}
 */
function getCurrentMonthNet(db, opts = {}) {
  const now = opts.now != null ? new Date(opts.now * 1000) : new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const from = Math.floor(start.getTime() / 1000);
  const label = start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const where = ['l.create_date >= @from'];
  const params = { from };
  if (opts.shopId) { where.push('l.shop_id = @shopId'); params.shopId = opts.shopId; }
  const W = where.join(' AND ');

  const byCurrency = db.prepare(`
    SELECT l.currency,
      SUM(CASE WHEN l.category='sales' THEN l.amount_cents ELSE 0 END) AS gross_cents,
      SUM(CASE WHEN l.category<>'transfer' THEN l.amount_cents ELSE 0 END) AS net_cents,
      SUM(CASE WHEN l.category='ads' THEN l.amount_cents ELSE 0 END) AS marketing_cents
    FROM ledger_entries l
    WHERE ${W}
    GROUP BY l.currency
  `).all(params);

  return { from, label, byCurrency };
}

/**
 * Per-order earnings for a date window: groups attributed ledger entries by
 * receipt and joins order metadata. Offsite-Ads (ads) entries are shop-level
 * and not included per order.
 */
function getPerOrderEarnings(db, opts = {}) {
  const where = ['l.receipt_id IS NOT NULL'];
  const params = {};
  if (opts.from != null) { where.push('l.create_date >= @from'); params.from = opts.from; }
  if (opts.to   != null) { where.push('l.create_date <= @to');   params.to   = opts.to; }
  if (opts.shopId)       { where.push('l.shop_id = @shopId');     params.shopId = opts.shopId; }
  params.limit  = Math.min(opts.limit ?? 500, 2000);
  params.offset = opts.offset ?? 0;
  const W = where.join(' AND ');

  const rows = db.prepare(`
    SELECT
      l.receipt_id, l.shop_id, l.currency,
      s.shop_name,
      r.name AS buyer_name, r.etsy_created_at,
      r.grandtotal_amount, r.grandtotal_currency,
      -- 4PX shipment identity + resolved freight (estimate → billed). These are 1:1
      -- with the receipt, so MAX() just satisfies the GROUP BY deterministically.
      -- The public 4PX number is the Etsy-synced tracking_code (buyer-facing / the
      -- parcel actually moving), falling back to a dashboard-created fourpx_tracking_no.
      MAX(COALESCE(CASE WHEN r.tracking_code LIKE '4PX%' THEN r.tracking_code END, r.fourpx_tracking_no)) AS fourpx_tracking_no,
      MAX(r.fourpx_consignment_no)  AS fourpx_consignment_no,
      MAX(r.fourpx_freight_amount)  AS fourpx_freight_amount,
      MAX(r.fourpx_freight_currency) AS fourpx_freight_currency,
      MAX(r.fourpx_freight_status)  AS fourpx_freight_status,
      MAX(r.carrier_confirmed_at)   AS carrier_confirmed_at,
      SUM(CASE WHEN l.category='sales'  THEN l.amount_cents ELSE 0 END) AS gross_cents,
      SUM(CASE WHEN l.category='tax'    THEN l.amount_cents ELSE 0 END) AS tax_cents,
      SUM(CASE WHEN l.category='refund' THEN l.amount_cents ELSE 0 END) AS refund_cents,
      SUM(CASE WHEN l.category IN ('processing_fee','transaction_fee','listing_fee','shipping_label','other') THEN l.amount_cents ELSE 0 END) AS fees_cents,
      SUM(CASE WHEN l.category<>'transfer' THEN l.amount_cents ELSE 0 END) AS net_cents,
      MAX(l.create_date) AS posted_date
    FROM ledger_entries l
    LEFT JOIN shops s    ON s.shop_id    = l.shop_id
    LEFT JOIN receipts r ON r.receipt_id = l.receipt_id
    WHERE ${W}
    GROUP BY l.receipt_id, l.currency
    ORDER BY posted_date DESC
    LIMIT @limit OFFSET @offset
  `).all(params);

  const total = db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT l.receipt_id FROM ledger_entries l
      WHERE ${W} GROUP BY l.receipt_id, l.currency
    )
  `).get(params).n;

  return { rows, total };
}

/** Quick per-shop ledger coverage stats for the UI (counts + last synced). */
function getLedgerStats(db) {
  return db.prepare(`
    SELECT shop_id,
      COUNT(*) AS entries,
      MIN(create_date) AS first_date,
      MAX(create_date) AS last_date
    FROM ledger_entries GROUP BY shop_id
  `).all();
}

/**
 * Current payment-account balance per shop + currency.
 *
 * Etsy's `balance_cents` on each ledger entry is the running balance of the
 * payment account immediately AFTER that entry posts (like a bank statement's
 * running total). The current balance is therefore the balance on the most
 * recent entry. "Most recent" is the row with the greatest (create_date,
 * entry_id) — create_date is always present and entry_id is a monotonic PK, so
 * this tiebreak is deterministic even when several entries share a timestamp.
 *
 * Balances are point-in-time, so they are intentionally NOT filtered by a date
 * window — only (optionally) by shop. Currency is the shop's payout currency;
 * a shop only ever has one, but we group defensively in case Etsy ever returns
 * mixed-currency rows. Returns one row per shop+currency.
 *
 * @param {Database.Database} db
 * @param {object} opts
 * @param {string} [opts.shopId] - limit to one shop
 * @returns {{ shop_id: string, shop_name: string|null, currency: string|null,
 *             balance_cents: number, create_date: number|null }[]}
 */
function getShopBalances(db, opts = {}) {
  const where = ['l.balance_cents IS NOT NULL'];
  const params = {};
  if (opts.shopId) { where.push('l.shop_id = @shopId'); params.shopId = opts.shopId; }
  const W = where.join(' AND ');

  return db.prepare(`
    SELECT l.shop_id, s.shop_name, l.currency, l.balance_cents, l.create_date
    FROM ledger_entries l
    LEFT JOIN shops s ON s.shop_id = l.shop_id
    WHERE ${W}
      AND NOT EXISTS (
        SELECT 1 FROM ledger_entries l2
        WHERE l2.shop_id = l.shop_id
          AND l2.currency IS l.currency
          AND l2.balance_cents IS NOT NULL
          AND ( l2.create_date > l.create_date
                OR (l2.create_date = l.create_date AND l2.entry_id > l.entry_id) )
      )
    ORDER BY l.shop_id
  `).all(params);
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
 * Mark a sync log entry as completed, failed, or paused.
 *
 * 'rate_limited' is a transient, self-resolving state: the shop's API key hit
 * Etsy's daily (QPD) budget. It is recorded distinctly from 'error' so the UI
 * can surface it as an amber "will resume automatically" notice rather than a
 * red failure that looks like it needs human action.
 *
 * @param {Database.Database} db
 * @param {number} logId
 * @param {'success'|'error'|'rate_limited'} status
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

// ─── Cross-process advisory lock ──────────────────────────────────────────────
//
// A tiny mutex stored in SQLite so multiple OS processes that share the same DB
// file (PM2-managed server, a stray IDE instance, the standalone sync worker…)
// can coordinate. Only the holder whose heartbeat is fresh "owns" the lock;
// once the heartbeat goes stale (holder crashed or was killed) any other process
// may reclaim it. Acquisition is atomic via a single conditional UPDATE/INSERT
// inside an IMMEDIATE transaction, so two racing processes can never both win.

/**
 * Try to acquire a named advisory lock.
 *
 * @param {Database.Database} db
 * @param {string} name      - Lock name (e.g. 'sync_cycle')
 * @param {string} owner     - Unique owner id for this process (e.g. `${host}:${pid}`)
 * @param {number} ttlSec    - Seconds after which an un-renewed lock is considered stale
 * @returns {boolean} true if the lock was acquired by this owner
 */
function acquireLock(db, name, owner, ttlSec) {
  const txn = db.transaction(() => {
    const now = Math.floor(Date.now() / 1000);
    const staleBefore = now - ttlSec;
    const row = db.prepare('SELECT owner, heartbeat_at FROM app_locks WHERE name = ?').get(name);

    if (!row) {
      db.prepare(`INSERT INTO app_locks (name, owner, acquired_at, heartbeat_at)
                  VALUES (?, ?, ?, ?)`).run(name, owner, now, now);
      return true;
    }

    // Already ours, or the previous holder's heartbeat is stale → (re)claim it.
    if (row.owner === owner || (row.heartbeat_at ?? 0) < staleBefore) {
      db.prepare(`UPDATE app_locks SET owner = ?, acquired_at = ?, heartbeat_at = ?
                  WHERE name = ?`).run(owner, now, now, name);
      return true;
    }

    return false; // held by a live owner
  });

  try {
    return txn.immediate();
  } catch {
    // If two processes race the same write, SQLite raises SQLITE_BUSY for the
    // loser — treat that as "did not acquire" rather than throwing.
    return false;
  }
}

/**
 * Refresh the heartbeat on a lock this process holds, so long-running jobs
 * keep the lock alive past its TTL. No-op if we are not the current owner.
 * @returns {boolean} true if the heartbeat was refreshed (we still hold it)
 */
function renewLock(db, name, owner) {
  const now = Math.floor(Date.now() / 1000);
  const res = db.prepare(`UPDATE app_locks SET heartbeat_at = ? WHERE name = ? AND owner = ?`)
    .run(now, name, owner);
  return res.changes > 0;
}

/**
 * Release a lock we hold. No-op if another process now owns it.
 */
function releaseLock(db, name, owner) {
  db.prepare('DELETE FROM app_locks WHERE name = ? AND owner = ?').run(name, owner);
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
 * Persist a shop's active-listing count (from the Etsy Shop object).
 * Stored on the shops table so the Overview can render it instantly without a
 * live API call, and stamped with the fetch time so the UI can flag staleness.
 * @param {Database.Database} db
 * @param {string} shopId
 * @param {number} count
 */
function updateShopListingCount(db, shopId, count) {
  if (count == null || Number.isNaN(Number(count))) return;
  db.prepare(`
    UPDATE shops SET
      listing_active_count    = @count,
      listing_count_synced_at = strftime('%s', 'now')
    WHERE shop_id = @shop_id
  `).run({ shop_id: shopId, count: Math.trunc(Number(count)) });
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
 * Return cached image bytes for a listing, or null if not yet fetched.
 * @param {Database.Database} db
 * @param {number} listingId
 * @returns {Buffer|null}
 */
function getListingImageData(db, listingId) {
  try {
    const row = db.prepare('SELECT data FROM listing_image_data WHERE listing_id = ?').get(listingId);
    if (row && row.data && row.data.length > 0) return row.data;
  } catch { /* table not yet initialized on very first start */ }
  return null;
}

/**
 * Persist raw image bytes for a listing to the local cache.
 * Upserts so repeated calls are idempotent.
 * @param {Database.Database} db
 * @param {number} listingId
 * @param {Buffer} data
 */
function upsertListingImageData(db, listingId, data) {
  db.prepare(`
    INSERT INTO listing_image_data (listing_id, data, cached_at)
    VALUES (?, ?, strftime('%s', 'now'))
    ON CONFLICT(listing_id) DO UPDATE
      SET data = excluded.data, cached_at = excluded.cached_at
  `).run(listingId, data);
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
 * Reconcile the local listings cache for one shop+state against what Etsy just
 * returned, deleting rows Etsy no longer lists in that state.
 *
 * Why this exists: a listings sync only UPSERTs, so a listing that was deleted
 * on Etsy — or moved out of the synced state (e.g. active → sold_out/expired) —
 * would otherwise linger forever in the local cache. That makes the Listings tab
 * show stale "old" listings and bury the real, current ones. Pruning the rows the
 * sync did NOT see makes the local cache a faithful mirror of the shop's Etsy
 * listings for that state.
 *
 * Safety: the caller must only invoke this after a full, successful pagination of
 * the state AND only when `seenIds` is non-empty — never prune against an empty
 * result set, or a transient empty page would wipe the whole cache.
 *
 * The listing's dependent inventory rows are removed in the same transaction so
 * no orphaned `listing_inventory` rows are left behind.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} shopId            - config shop_id (matches listings.shop_id)
 * @param {string} state             - the concrete Etsy state just enumerated
 * @param {Set<number>} seenIds      - listing_ids Etsy returned for this state
 * @returns {number} count of stale listings removed
 */
function pruneStaleListings(db, shopId, state, seenIds) {
  if (!seenIds || seenIds.size === 0) return 0; // never prune against an empty sync

  const local = db
    .prepare('SELECT listing_id FROM listings WHERE shop_id = ? AND state = ?')
    .all(shopId, state);

  const stale = local
    .map((r) => r.listing_id)
    .filter((id) => !seenIds.has(id));

  if (!stale.length) return 0;

  const delInventory = db.prepare('DELETE FROM listing_inventory WHERE listing_id = ?');
  const delListing   = db.prepare('DELETE FROM listings WHERE listing_id = ?');
  const prune = db.transaction((ids) => {
    for (const id of ids) {
      delInventory.run(id);
      delListing.run(id);
    }
  });
  prune(stale);

  return stale.length;
}

/**
 * Upsert one inventory product row (one variation combination).
 * Extracts 'Style' and a secondary property automatically.
 */
function upsertListingInventory(db, listingId, product, offering) {
  const propValues = product.property_values || [];

  // Robustly split the variation into its style vs. model dimensions so the
  // stored style_value is always the clean, restock-relevant label (model
  // stripped) regardless of how the shop named its properties.
  const { styleVal, secondaryVal } = deriveVariationLabels(propValues);

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
 * Reconcile a single listing's cached inventory against the products Etsy just
 * returned, deleting variation rows for products that no longer exist (a variation
 * removed on Etsy). Keeps the per-variation price/stock strip a faithful mirror
 * instead of showing phantom styles that were deleted upstream.
 *
 * Safety: only prunes when `seenProductIds` is non-empty, so a listing that
 * momentarily returned no inventory never gets its cache wiped.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} listingId
 * @param {Set<number>} seenProductIds - product_ids present in the fresh fetch
 * @returns {number} count of stale variation rows removed
 */
function pruneStaleInventory(db, listingId, seenProductIds) {
  if (!seenProductIds || seenProductIds.size === 0) return 0;

  const local = db
    .prepare('SELECT product_id FROM listing_inventory WHERE listing_id = ?')
    .all(listingId);

  const stale = local
    .map((r) => r.product_id)
    .filter((pid) => !seenProductIds.has(pid));

  if (!stale.length) return 0;

  const del = db.prepare('DELETE FROM listing_inventory WHERE listing_id = ? AND product_id = ?');
  const prune = db.transaction((ids) => {
    for (const pid of ids) del.run(listingId, pid);
  });
  prune(stale);

  return stale.length;
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
 * Persist the logistics product + declared weight chosen when a 4PX shipment is
 * created, so the order can later be priced via ds.xms.estimated_cost.get.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number|string} receiptId
 * @param {object} opts
 * @param {string|null} [opts.productCode]  logistics_product_code (e.g. 'S5058').
 * @param {number|null} [opts.weightG]      Declared parcel weight in grams.
 */
function recordFourpxShipmentInputs(db, receiptId, { productCode = null, weightG = null } = {}) {
  db.prepare(`
    UPDATE receipts SET
      fourpx_product_code = COALESCE(@productCode, fourpx_product_code),
      fourpx_weight_g     = COALESCE(@weightG,     fourpx_weight_g)
    WHERE receipt_id = @receiptId
  `).run({
    receiptId,
    productCode: productCode || null,
    weightG: Number.isFinite(weightG) ? Math.round(weightG) : null,
  });
}

/**
 * Persist a resolved 4PX shipping cost for one receipt.
 *
 * Implements the estimate→billed lifecycle. Read-then-write so the rules are
 * explicit and a weaker result never overwrites a stronger one:
 *   - 'billed'    : authoritative — always written; supersedes any estimate.
 *   - 'estimated' : written only when the order is not already 'billed'.
 *   - 'pending' / 'error' : only the status + fetched_at change; any previously
 *                   resolved amount is preserved (we never blank a known cost).
 * fourpx_freight_fetched_at is always stamped so the sync worker can rate-limit.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number|string} receiptId
 * @param {object} opts
 * @param {'pending'|'estimated'|'billed'|'error'} opts.status
 * @param {number|null} [opts.totalFee]        Total freight charge / estimate.
 * @param {string|null} [opts.currency]        Currency of totalFee (e.g. 'CNY', 'USD').
 * @param {number|null} [opts.billedWeightG]   Billed/charge weight in grams.
 * @param {Array|null}  [opts.feeItems]        Itemized fee breakdown (serialized to JSON).
 */
function recordFourpxFreight(db, receiptId, {
  status,
  totalFee      = null,
  currency      = null,
  billedWeightG = null,
  feeItems      = null,
} = {}) {
  const now = Math.floor(Date.now() / 1000);
  const cur = db.prepare('SELECT fourpx_freight_status AS s FROM receipts WHERE receipt_id = ?').get(receiptId);
  const curStatus = cur ? cur.s : null;

  const hasAmount = totalFee !== null && totalFee !== undefined;
  // Decide whether to overwrite the stored amount fields.
  const writeAmount =
    (status === 'billed' && hasAmount) ||
    (status === 'estimated' && hasAmount && curStatus !== 'billed');

  // Decide the status to store. Never downgrade billed→estimated/pending, and never
  // overwrite an existing estimate with a bare 'pending' (keep the useful estimate).
  let writeStatus = status;
  if (curStatus === 'billed' && status !== 'billed') writeStatus = 'billed';
  else if (curStatus === 'estimated' && (status === 'pending')) writeStatus = 'estimated';

  if (writeAmount) {
    db.prepare(`
      UPDATE receipts SET
        fourpx_freight_amount    = @totalFee,
        fourpx_freight_currency  = @currency,
        fourpx_billed_weight_g   = @billedWeightG,
        fourpx_freight_breakdown = @breakdown,
        fourpx_freight_status    = @status,
        fourpx_freight_fetched_at = @now
      WHERE receipt_id = @receiptId
    `).run({
      receiptId,
      totalFee,
      currency: currency ?? null,
      billedWeightG: billedWeightG ?? null,
      breakdown: Array.isArray(feeItems) && feeItems.length ? JSON.stringify(feeItems) : null,
      status: writeStatus,
      now,
    });
  } else {
    // Status / timestamp only — preserve any previously resolved amount.
    db.prepare(`
      UPDATE receipts SET
        fourpx_freight_status    = @status,
        fourpx_freight_fetched_at = @now
      WHERE receipt_id = @receiptId
    `).run({ receiptId, status: writeStatus, now });
  }
}

/**
 * Aggregate 4PX shipping cost per shop for the finance/earnings views.
 *
 * Groups by shop + currency (4PX may bill different lanes in different currencies,
 * though CN accounts settle in CNY) and reports the resolved total plus how the
 * cost was sourced (billed vs estimated) so the UI can flag estimate confidence.
 *
 * The window is applied on the ORDER date (etsy_created_at), not the label-creation
 * date, so the shipping cost is matched to the revenue period of the sale it belongs
 * to (COGS-style matching) and the totals track the Earnings date range. Filtering
 * by label-creation date would make every range that covers the (recent) period in
 * which the 4PX feature was used return an identical total.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [opts]
 * @param {number} [opts.from]    Unix epoch lower bound on the order date.
 * @param {number} [opts.to]      Unix epoch upper bound on the order date.
 * @param {string} [opts.shopId]  Restrict to one shop.
 * @returns {{rows: Array, byShop: object}}
 */
function getFourpxShippingSummary(db, { from, to, shopId } = {}) {
  // A 4PX shipment is any receipt with a dashboard-created consignment OR a 4PX
  // tracking number synced from Etsy (covers shipments made directly on the portal).
  const clauses = ["(r.fourpx_consignment_no IS NOT NULL OR r.tracking_code LIKE '4PX%')", "COALESCE(r.fourpx_order_status,'') != 'cancelled'"];
  const params = {};
  // COALESCE so manual orders (which may lack etsy_created_at) fall back to their
  // 4PX label-creation date rather than dropping out of every window.
  if (from) { clauses.push('COALESCE(r.etsy_created_at, r.fourpx_created_at) >= @from'); params.from = from; }
  if (to)   { clauses.push('COALESCE(r.etsy_created_at, r.fourpx_created_at) <= @to');   params.to = to; }
  if (shopId) { clauses.push('r.shop_id = @shopId'); params.shopId = shopId; }
  const where = `WHERE ${clauses.join(' AND ')}`;

  // Resolved cost per shop + currency (only rows that actually have an amount).
  const rows = db.prepare(`
    SELECT r.shop_id, s.shop_name,
           COALESCE(r.fourpx_freight_currency, 'CNY') AS currency,
           COUNT(*)                                                              AS priced_orders,
           SUM(CASE WHEN r.fourpx_freight_status = 'billed'    THEN 1 ELSE 0 END) AS billed_orders,
           SUM(CASE WHEN r.fourpx_freight_status = 'estimated' THEN 1 ELSE 0 END) AS estimated_orders,
           SUM(r.fourpx_freight_amount)                                          AS total_cost
    FROM receipts r
    JOIN shops s ON s.shop_id = r.shop_id
    ${where} AND r.fourpx_freight_amount IS NOT NULL
    GROUP BY r.shop_id, currency
    ORDER BY s.shop_name
  `).all(params);

  // Lifecycle counts per shop (how many shipments still await any cost at all).
  const counts = db.prepare(`
    SELECT r.shop_id, s.shop_name,
           COUNT(*) AS total_orders,
           SUM(CASE WHEN r.fourpx_freight_status = 'billed'    THEN 1 ELSE 0 END) AS billed,
           SUM(CASE WHEN r.fourpx_freight_status = 'estimated' THEN 1 ELSE 0 END) AS estimated,
           SUM(CASE WHEN r.fourpx_freight_amount IS NULL THEN 1 ELSE 0 END)       AS unpriced
    FROM receipts r
    JOIN shops s ON s.shop_id = r.shop_id
    ${where}
    GROUP BY r.shop_id
    ORDER BY s.shop_name
  `).all(params);

  const byShop = {};
  for (const c of counts) {
    byShop[c.shop_id] = {
      shop_id: c.shop_id,
      shop_name: c.shop_name,
      total_orders: c.total_orders,
      billed: c.billed,
      estimated: c.estimated,
      unpriced: c.unpriced,
      totals: {}, // currency → { amount, orders, billed, estimated }
    };
  }
  for (const r of rows) {
    const shop = byShop[r.shop_id];
    if (!shop) continue;
    shop.totals[r.currency] = {
      amount: +(r.total_cost ?? 0).toFixed(2),
      orders: r.priced_orders,
      billed: r.billed_orders,
      estimated: r.estimated_orders,
    };
  }
  return { rows, byShop };
}

// ─── 4PX parcel tracking (Shipping tab) ────────────────────────────────────────

/**
 * Persist a tracking snapshot for one receipt (from the tracking sync pass).
 *
 * Always stamps tracking_checked_at. Only overwrites the status fields when a
 * meaningful snapshot is supplied, and never blanks a known delivered timestamp.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number|string} receiptId
 * @param {object} snap
 * @param {string|null} [snap.status]         Canonical status.
 * @param {number|null} [snap.firstScanAt]    Epoch of first carrier scan (→ carrier_confirmed_at).
 * @param {number|null} [snap.lastEventAt]    Epoch of most recent event.
 * @param {string|null} [snap.lastEvent]      Most recent event description.
 * @param {string|null} [snap.lastLocation]   Most recent event location.
 * @param {number|null} [snap.deliveredAt]    Epoch when delivered.
 * @param {number}      [snap.checkedAt]      Epoch of this check (defaults to now).
 */
function updateTrackingDetail(db, receiptId, {
  status = null,
  firstScanAt = null,
  lastEventAt = null,
  lastEvent = null,
  lastLocation = null,
  deliveredAt = null,
  health = null,        // analyzeTrackingHealth output { severity, reasons, ... }
  checkedAt = Math.floor(Date.now() / 1000),
} = {}) {
  // Health is recomputed on every successful check (it's a function of the live
  // timeline), so unlike the COALESCE'd fields it is written directly when provided.
  const healthSeverity = health ? (health.severity || 'ok') : null;
  const healthReason = health && Array.isArray(health.reasons) && health.reasons.length ? health.reasons[0] : null;
  db.prepare(`
    UPDATE receipts SET
      tracking_status        = COALESCE(@status, tracking_status),
      tracking_last_event    = COALESCE(@lastEvent, tracking_last_event),
      tracking_last_event_at = COALESCE(@lastEventAt, tracking_last_event_at),
      tracking_last_location = COALESCE(@lastLocation, tracking_last_location),
      tracking_delivered_at  = COALESCE(tracking_delivered_at, @deliveredAt),
      tracking_health        = COALESCE(@healthSeverity, tracking_health),
      tracking_health_reason = CASE WHEN @healthSeverity IS NOT NULL THEN @healthReason ELSE tracking_health_reason END,
      carrier_confirmed_at   = COALESCE(carrier_confirmed_at, @firstScanAt),
      tracking_checked_at    = @checkedAt
    WHERE receipt_id = @receiptId
  `).run({
    receiptId,
    status,
    lastEvent,
    lastEventAt: lastEventAt ?? null,
    lastLocation,
    deliveredAt: deliveredAt ?? null,
    healthSeverity,
    healthReason,
    firstScanAt: firstScanAt ?? null,
    checkedAt,
  });
}

/**
 * SQL fragment that flags a parcel as "stuck/delayed". Primary signal is the
 * persisted health verdict (analyzeTrackingHealth over the full event history:
 * customs loops, repeated scans, long transit, no movement). As a safety net it
 * also flags any in-transit parcel with no scan for `stuckDays` even if health
 * hasn't been computed yet. Delivered parcels are never stuck (health = 'ok').
 * Parameterised on @stuckCutoff (epoch).
 */
const STUCK_SQL = `(r.tracking_health = 'critical')`;

/** SQL fragment for a "delayed" parcel (slow but not critically stuck). */
const DELAYED_SQL = `(r.tracking_health = 'warning')`;

/** Effective ship date for windowing: Etsy shipment → 4PX label → order date. */
const SHIP_DATE_SQL = `COALESCE(r.shipment_notified_at, r.fourpx_created_at, r.etsy_created_at)`;
/** Most recent carrier activity (last scan, else last successful check). */
const LAST_ACTIVITY_SQL = `COALESCE(r.tracking_last_event_at, r.tracking_checked_at, 0)`;

/**
 * Build the Shipping-tab date-window predicate — used IDENTICALLY by the parcel
 * list (getShipments) and the summary cards (getShippingStats) so the two can
 * never disagree.
 *
 * WHY THIS IS NOT A PLAIN SHIP-DATE FILTER
 * ────────────────────────────────────────
 * A parcel becomes "stuck" precisely BECAUSE it has been in the system a long
 * time — a customs loop or a carrier stall drags on for weeks. Filtering the
 * board purely by ship date therefore hides the very parcels the operator most
 * needs to act on: the longer a parcel is stuck, the more certain a naive
 * "Last 30 days" (ship-date) window is to drop it. That was the reported bug —
 * parcels visibly stuck in customs for over a month never appeared in the tab.
 *
 * SEMANTICS
 * ──────────
 * A parcel belongs in window [from, to] when EITHER:
 *   (a) it SHIPPED within the window (historical/volume view — includes delivered
 *       parcels so the counts remain a faithful record of the period), OR
 *   (b) it is an OPEN parcel (not delivered) that had carrier ACTIVITY within the
 *       window. This keeps every still-in-flight parcel on the board regardless of
 *       how long ago it shipped, while the "activity within window" bound naturally
 *       excludes long-abandoned parcels that have gone silent (carrier stopped
 *       scanning ≈ effectively delivered) — so the board never fills with stale noise.
 *
 * Mutates `params` with @from / @to as needed. Returns a SQL fragment, or null
 * when no window is requested ("All").
 *
 * @param {{from?:number, to?:number}} opts
 * @param {object} params  Bound-parameter object to extend.
 * @returns {string|null}
 */
function buildShipWindowClause(opts, params) {
  const hasFrom = opts.from != null;
  const hasTo   = opts.to != null;
  if (!hasFrom && !hasTo) return null; // "All" — no windowing

  // (a) ship-date within the window
  const shipParts = [];
  if (hasFrom) { shipParts.push(`${SHIP_DATE_SQL} >= @from`); params.from = opts.from; }
  if (hasTo)   { shipParts.push(`${SHIP_DATE_SQL} <= @to`);   params.to   = opts.to; }
  const shipRange = `(${shipParts.join(' AND ')})`;

  // (b) open parcel with carrier activity within the window
  const actParts = [];
  if (hasFrom) actParts.push(`${LAST_ACTIVITY_SQL} >= @from`);
  if (hasTo)   actParts.push(`${LAST_ACTIVITY_SQL} <= @to`);
  const openActive =
    `(r.tracking_delivered_at IS NULL ` +
    `AND COALESCE(r.tracking_status, 'unknown') != 'delivered' ` +
    `AND ${actParts.join(' AND ')})`;

  return `(${shipRange} OR ${openActive})`;
}

/**
 * List 4PX shipments for the Shipping tab with their cached tracking snapshot,
 * freight cost, and a computed `is_stuck` flag. Supports filtering by canonical
 * status, a "stuck" filter, shop, and a tracking-number/buyer search.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [opts]
 * @param {string} [opts.status]    Canonical status filter, or 'stuck'.
 * @param {string} [opts.shopId]
 * @param {string} [opts.q]         Search tracking number or buyer name.
 * @param {number} [opts.stuckDays] Days of no movement to consider stuck (default 10).
 * @param {number} [opts.limit]
 * @param {number} [opts.offset]
 * @returns {{rows: Array, total: number}}
 */
function getShipments(db, opts = {}) {
  const where = ["(r.fourpx_consignment_no IS NOT NULL OR r.tracking_code LIKE '4PX%')"];
  const params = { limit: Math.min(opts.limit ?? 100, 1000), offset: opts.offset ?? 0 };

  if (opts.shopId) { where.push('r.shop_id = @shopId'); params.shopId = opts.shopId; }
  // Date window: ship-date OR still-open-and-active (see buildShipWindowClause).
  // This is what keeps long-stuck parcels (shipped weeks ago, still not delivered)
  // on the board instead of falling out of a naive ship-date window.
  const winClause = buildShipWindowClause(opts, params);
  if (winClause) where.push(winClause);
  if (opts.q) {
    where.push('(r.tracking_code LIKE @q OR r.fourpx_tracking_no LIKE @q OR r.name LIKE @q)');
    params.q = `%${opts.q}%`;
  }
  if (opts.status === 'stuck') {
    where.push(STUCK_SQL);
  } else if (opts.status === 'delayed') {
    where.push(DELAYED_SQL);
  } else if (opts.status && opts.status !== 'all') {
    where.push('COALESCE(r.tracking_status,\'unknown\') = @status');
    params.status = opts.status;
  }
  const W = where.join(' AND ');

  // Parcel identity: prefer the Etsy-synced 4PX tracking_code (what the buyer sees
  // and what's actually moving) over a dashboard-created fourpx_tracking_no, because
  // when they differ the dashboard label may have been abandoned/re-created. For the
  // common case (dashboard label == Etsy tracking) the two are identical.
  const trackingNoExpr = `COALESCE(CASE WHEN r.tracking_code LIKE '4PX%' THEN r.tracking_code END, r.fourpx_tracking_no)`;

  const rows = db.prepare(`
    SELECT
      r.receipt_id, r.shop_id, s.shop_name, r.name AS buyer_name,
      r.shipping_country_iso, r.etsy_created_at,
      ${trackingNoExpr} AS tracking_no,
      r.fourpx_consignment_no,
      r.tracking_status, r.tracking_last_event, r.tracking_last_event_at,
      r.tracking_last_location, r.tracking_delivered_at,
      r.tracking_health, r.tracking_health_reason,
      r.carrier_confirmed_at, r.tracking_checked_at,
      r.shipment_notified_at,
      r.fourpx_freight_amount, r.fourpx_freight_currency, r.fourpx_freight_status,
      CASE WHEN ${STUCK_SQL} THEN 1 ELSE 0 END AS is_stuck
    FROM receipts r
    JOIN shops s ON s.shop_id = r.shop_id
    WHERE ${W}
    ORDER BY
      CASE WHEN ${STUCK_SQL} THEN 0 ELSE 1 END ASC,
      COALESCE(r.tracking_last_event_at, r.shipment_notified_at, r.etsy_created_at) DESC
    LIMIT @limit OFFSET @offset
  `).all(params);

  const total = db.prepare(`SELECT COUNT(*) AS n FROM receipts r WHERE ${W}`).get(params).n;
  return { rows, total };
}

/**
 * Summary counts for the Shipping tab cards: total 4PX shipments plus a count per
 * canonical status and the number currently stuck.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [opts]
 * @param {number} [opts.stuckDays]
 * @param {string} [opts.shopId]
 * @returns {{total:number, pre_transit:number, in_transit:number, delivered:number, exception:number, unknown:number, stuck:number}}
 */
function getShippingStats(db, opts = {}) {
  const where = ["(r.fourpx_consignment_no IS NOT NULL OR r.tracking_code LIKE '4PX%')"];
  const params = {};
  if (opts.shopId) { where.push('r.shop_id = @shopId'); params.shopId = opts.shopId; }
  // Same window logic as the parcel list so the cards and the table always agree.
  const winClause = buildShipWindowClause(opts, params);
  if (winClause) where.push(winClause);
  const W = where.join(' AND ');

  return db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN COALESCE(r.tracking_status,'unknown')='pre_transit' THEN 1 ELSE 0 END) AS pre_transit,
      SUM(CASE WHEN r.tracking_status='in_transit' THEN 1 ELSE 0 END) AS in_transit,
      SUM(CASE WHEN r.tracking_status='delivered'  THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN r.tracking_status='exception'  THEN 1 ELSE 0 END) AS exception,
      SUM(CASE WHEN COALESCE(r.tracking_status,'unknown')='unknown' THEN 1 ELSE 0 END) AS unknown,
      SUM(CASE WHEN ${STUCK_SQL} THEN 1 ELSE 0 END) AS stuck,
      SUM(CASE WHEN ${DELAYED_SQL} THEN 1 ELSE 0 END) AS delayed
    FROM receipts r
    WHERE ${W}
  `).get(params);
}

/**
 * Record the operator's current 4PX prepaid balance (from the b.4px.com portal).
 * Single-row upsert — the latest snapshot replaces the previous one.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} opts
 * @param {number} opts.amount           Balance amount from the portal.
 * @param {string} [opts.currency='CNY'] Currency of the amount.
 * @param {number} [opts.asOf]           Epoch the balance is accurate as of (default now).
 * @param {string} [opts.note]
 */
function setFourpxBalance(db, { amount, currency = 'CNY', asOf, note = null } = {}) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO fourpx_balance (id, amount, currency, as_of, note, updated_at)
    VALUES (1, @amount, @currency, @asOf, @note, @now)
    ON CONFLICT(id) DO UPDATE SET
      amount = @amount, currency = @currency, as_of = @asOf, note = @note, updated_at = @now
  `).run({ amount, currency: (currency || 'CNY').toUpperCase(), asOf: asOf ?? now, note, now });
}

/**
 * Current 4PX balance status: the recorded snapshot plus a checkbook-style estimate
 * of the remaining balance = snapshot − 4PX shipping billed since the snapshot date.
 *
 * "Billed since" sums resolved freight (billed or estimated) for 4PX shipments whose
 * ship/label date is on/after the snapshot's as_of, in the snapshot currency. This is
 * an ESTIMATE (4PX has no balance API); the operator re-syncs the snapshot from the
 * portal whenever they recharge or want an exact figure.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ configured: boolean, amount: number|null, currency: string|null,
 *   as_of: number|null, note: string|null, spent_since: number, billed_orders: number,
 *   estimated_orders: number, estimated_remaining: number|null }}
 */
function getFourpxBalanceStatus(db) {
  const snap = db.prepare('SELECT amount, currency, as_of, note FROM fourpx_balance WHERE id = 1').get();
  if (!snap) {
    return { configured: false, amount: null, currency: null, as_of: null, note: null,
             spent_since: 0, billed_orders: 0, estimated_orders: 0, estimated_remaining: null };
  }
  const currency = snap.currency || 'CNY';
  const spent = db.prepare(`
    SELECT
      COALESCE(SUM(r.fourpx_freight_amount), 0) AS spent,
      SUM(CASE WHEN r.fourpx_freight_status = 'billed'    THEN 1 ELSE 0 END) AS billed_orders,
      SUM(CASE WHEN r.fourpx_freight_status = 'estimated' THEN 1 ELSE 0 END) AS estimated_orders
    FROM receipts r
    WHERE (r.fourpx_consignment_no IS NOT NULL OR r.tracking_code LIKE '4PX%')
      AND r.fourpx_freight_amount IS NOT NULL
      AND COALESCE(r.fourpx_freight_currency, 'CNY') = @currency
      AND COALESCE(r.shipment_notified_at, r.fourpx_created_at, r.etsy_created_at) >= @asOf
  `).get({ currency, asOf: snap.as_of });

  const spentSince = +(spent.spent || 0).toFixed(2);
  return {
    configured: true,
    amount: snap.amount,
    currency,
    as_of: snap.as_of,
    note: snap.note,
    spent_since: spentSince,
    billed_orders: spent.billed_orders || 0,
    estimated_orders: spent.estimated_orders || 0,
    estimated_remaining: +(snap.amount - spentSince).toFixed(2),
  };
}

// ─── Route assignments ────────────────────────────────────────────────────────

const _VALID_STATUSES = new Set(['Pending', 'Purchased', 'Out of Stock', 'Out of Production', 'Wrong Stall', 'Model Unavailable']);

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
 * Mark (or unmark) a single order line as removed from the Orders Sorting
 * Dashboard. A removed line is durably hidden from the route dashboard and
 * excluded from route generation, but the underlying receipt is never touched.
 *
 * Implemented as an upsert so a line that has no other saved assignment yet
 * (e.g. a freshly-synced order the operator never edited) can still be removed.
 * Only the dismissal marker is changed; charm / status / supplier fields are
 * preserved. Works for real receipts and manual items alike — both are keyed by
 * (receipt_id, item_key), with manual items carrying a negative receipt_id.
 *
 * @param {Database.Database} db
 * @param {{ receipt_id: number, item_key: string, title?: string, dismissed: boolean }} a
 * @returns {{ receipt_id: number, item_key: string, dismissed_at: number|null }}
 */
function setRouteDismissed(db, a) {
  if (a.receipt_id == null || !a.item_key) {
    throw new Error('setRouteDismissed requires receipt_id and item_key');
  }
  const now = Math.floor(Date.now() / 1000);
  const dismissedAt = a.dismissed ? now : null;

  db.prepare(`
    INSERT INTO route_assignments (receipt_id, item_key, title, dismissed_at, updated_at)
    VALUES (@receipt_id, @item_key, @title, @dismissed_at, @updated_at)
    ON CONFLICT(receipt_id, item_key) DO UPDATE SET
      dismissed_at = excluded.dismissed_at,
      updated_at   = excluded.updated_at
  `).run({
    receipt_id:   Number(a.receipt_id),
    item_key:     String(a.item_key),
    title:        a.title ?? '',
    dismissed_at: dismissedAt,
    updated_at:   now,
  });

  return { receipt_id: Number(a.receipt_id), item_key: String(a.item_key), dismissed_at: dismissedAt };
}

/**
 * Clear any "removed" markers on every line of a receipt. Used when the operator
 * explicitly pulls an order back into the dashboard via "Add Order", which is an
 * unambiguous intent to un-remove it.
 * @param {Database.Database} db
 * @param {number} receiptId
 * @returns {number} number of rows un-dismissed
 */
function clearDismissedByReceipt(db, receiptId) {
  try {
    const info = db.prepare(
      'UPDATE route_assignments SET dismissed_at = NULL WHERE receipt_id = ? AND dismissed_at IS NOT NULL'
    ).run(Number(receiptId));
    return info.changes || 0;
  } catch { return 0; }
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

// ─── Product Catalog ⇄ Route assignment consistency ─────────────────────────
//
// Supplier + charm for a product are stored, by design, in TWO denormalised
// tables that buildRouteRows() merges by priority:
//
//   • product_assignments — keyed by the listing-scoped key
//       `normalizeTitle(title)[:50]#L{listing_id}`. Written when the operator
//       edits a supplier/charm in the Orders Sorting Dashboard (Route tab).
//       These act as per-product defaults for every future order of the product.
//   • product_map          — keyed by the FULL `title_norm`
//       (`normalizeTitle(title)`, no slice, no `#L`). This is what the Product
//       Catalog modal reads and writes, and what Excel import populates.
//
// Historically there was NO sync between the two: an edit in the Route tab
// updated product_assignments only, so the Product Catalog (which reads
// product_map) never reflected it — products looked "Not set" even after the
// operator had assigned a supplier. The three helpers below keep the two views
// consistent at the PRODUCT level, in both directions, so the catalog always
// shows the effective supplier/charm that route generation will actually use.
//
// Per-ORDER overrides (route_assignments.supplier_*_override) are intentionally
// NOT touched — those are deliberate one-off exceptions for a single order.

/**
 * Write product-level supplier/charm into the Product Catalog (product_map),
 * keyed by the full normalised title. Merge semantics:
 *   • a field left `undefined` is preserved (never clobbered),
 *   • a field given as a string (including '') is written verbatim.
 * Creates the catalog row when the product isn't catalogued yet, so a supplier
 * assigned in the Route tab makes the product appear — and be "filled" — in the
 * Product Catalog immediately.
 *
 * @param {Database.Database} db
 * @param {{ title: string, supplier_shop?: string, supplier_stall?: string,
 *           charm_code?: string, charm_shop?: string }} patch
 * @returns {{ id: number, title_norm: string, changed: boolean } | null}
 */
function mergeProductMapSupplierCharm(db, patch) {
  const title = String(patch.title || '').trim();
  if (!title) return null;
  const titleNorm = _normTitleForKey(title);
  if (!titleNorm) return null;

  const now = Math.floor(Date.now() / 1000);
  // undefined → keep previous; defined → use the trimmed provided value (incl. '')
  const choose = (next, prev) => (next === undefined ? (prev ?? '') : String(next ?? '').trim());

  const existing = db.prepare('SELECT * FROM product_map WHERE title_norm = ?').get(titleNorm);

  if (existing) {
    const next = {
      id:         existing.id,
      shop_name:  choose(patch.supplier_shop,  existing.shop_name),
      stall:      choose(patch.supplier_stall, existing.stall),
      charm_shop: choose(patch.charm_shop,     existing.charm_shop),
      charm_code: choose(patch.charm_code,     existing.charm_code),
      updated_at: now,
    };
    const unchanged =
      next.shop_name  === (existing.shop_name  ?? '') &&
      next.stall      === (existing.stall      ?? '') &&
      next.charm_shop === (existing.charm_shop ?? '') &&
      next.charm_code === (existing.charm_code ?? '');
    if (unchanged) return { id: existing.id, title_norm: titleNorm, changed: false };

    db.prepare(`
      UPDATE product_map
      SET shop_name = @shop_name, stall = @stall,
          charm_shop = @charm_shop, charm_code = @charm_code, updated_at = @updated_at
      WHERE id = @id
    `).run(next);
    return { id: existing.id, title_norm: titleNorm, changed: true };
  }

  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM product_map').get().m;
  const info = db.prepare(`
    INSERT INTO product_map (title_norm, title, shop_name, stall, charm_shop, charm_code, sort_order, updated_at)
    VALUES (@title_norm, @title, @shop_name, @stall, @charm_shop, @charm_code, @sort_order, @updated_at)
  `).run({
    title_norm: titleNorm,
    title,
    shop_name:  choose(patch.supplier_shop,  ''),
    stall:      choose(patch.supplier_stall, ''),
    charm_shop: choose(patch.charm_shop,     ''),
    charm_code: choose(patch.charm_code,     ''),
    sort_order: maxOrder + 1,
    updated_at: now,
  });
  return { id: info.lastInsertRowid, title_norm: titleNorm, changed: true };
}

/**
 * Push a Product Catalog edit out to every matching product_assignments row, so
 * a change made in the catalog modal takes immediate effect on the Route tab
 * (where product_assignments outranks product_map). Matches by the listing-
 * scoped key family `${base}` / `${base}#L{listing_id}` where
 * base = full title_norm sliced to 50 chars. The catalog is treated as
 * authoritative here, so values (including clears) are written verbatim.
 *
 * Does NOT create new product_assignments rows — when none exist, buildRouteRows
 * already falls back to product_map, so the edit is honoured anyway.
 *
 * @param {Database.Database} db
 * @param {{ title: string, shop_name?: string, stall?: string,
 *           charm_shop?: string, charm_code?: string }} row
 * @returns {number} number of product_assignments rows updated
 */
function syncProductMapToAssignments(db, row) {
  const titleNorm = _normTitleForKey(row.title || '');
  if (!titleNorm) return 0;
  const base = titleNorm.slice(0, 50);

  const info = db.prepare(`
    UPDATE product_assignments
    SET supplier_shop = @supplier_shop, supplier_stall = @supplier_stall,
        charm_shop = @charm_shop, charm_code = @charm_code, updated_at = @updated_at
    WHERE item_key = @base OR item_key LIKE @like
  `).run({
    supplier_shop:  String(row.shop_name  || '').trim(),
    supplier_stall: String(row.stall      || '').trim(),
    charm_shop:     String(row.charm_shop || '').trim(),
    charm_code:     String(row.charm_code || '').trim(),
    base,
    like: base + '#L%',
    updated_at: Math.floor(Date.now() / 1000),
  });
  return info.changes;
}

/**
 * One-time/idempotent reconciliation that backfills product_map from every
 * supplier/charm the operator has already saved in product_assignments. Run at
 * startup so historical Route-tab edits (made before write-through existed)
 * become visible in the Product Catalog. Last write wins when several listing-
 * scoped assignments collapse onto the same product title (ordered by updated_at).
 *
 * Only fields the operator actually set are propagated: an assignment that has a
 * supplier but no charm never blanks an existing catalog charm, and vice-versa.
 *
 * @param {Database.Database} db
 * @returns {{ ok: boolean, filled: number, created: number }}
 */
function reconcileAssignmentsToProductMap(db) {
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT item_key, title, supplier_shop, supplier_stall, charm_code, charm_shop, updated_at
      FROM product_assignments
      ORDER BY updated_at ASC, item_key ASC
    `).all();
  } catch { return { ok: false, filled: 0, created: 0 }; }

  let filled = 0, created = 0;
  const tx = db.transaction(() => {
    for (const a of rows) {
      const title = String(a.title || '').trim();
      if (!title) continue;

      const hasSupplier = !!(a.supplier_shop || a.supplier_stall);
      const hasCharm    = !!(a.charm_code || a.charm_shop);
      if (!hasSupplier && !hasCharm) continue;

      const patch = { title };
      if (hasSupplier) {
        patch.supplier_shop  = a.supplier_shop  || '';
        patch.supplier_stall = a.supplier_stall || '';
      }
      if (hasCharm) {
        patch.charm_code = a.charm_code || '';
        patch.charm_shop = a.charm_shop || '';
      }

      const existedBefore = db.prepare('SELECT 1 FROM product_map WHERE title_norm = ?')
        .get(_normTitleForKey(title));
      const r = mergeProductMapSupplierCharm(db, patch);
      if (r && r.changed) { existedBefore ? filled++ : created++; }
    }
  });
  tx();
  return { ok: true, filled, created };
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

// ─── Charm purchase progress (purchased / in-stock quantity per charm) ────────

/**
 * Return all charm purchase-progress rows as a { charm_code: purchased_qty } map.
 * @param {import('better-sqlite3').Database} db
 * @returns {Record<string, number>}
 */
function getCharmPurchaseProgress(db) {
  const out = {};
  try {
    db.prepare('SELECT charm_code, purchased_qty FROM charm_purchase_progress').all()
      .forEach(r => { out[r.charm_code] = r.purchased_qty; });
  } catch { /* table may not exist before first migration */ }
  return out;
}

/**
 * Set the purchased / in-stock quantity for a charm code. A quantity of 0 is
 * stored explicitly (a deliberate "none purchased yet" state).
 * @param {import('better-sqlite3').Database} db
 * @param {string} charmCode
 * @param {number} qty  Clamped to >= 0.
 * @returns {{ charm_code: string, purchased_qty: number }}
 */
function setCharmPurchaseProgress(db, charmCode, qty) {
  const code = String(charmCode || '').trim();
  if (!code) { const e = new Error('charm_code is required.'); e.code = 'REQUIRED'; throw e; }
  const n = Math.max(0, Math.floor(Number(qty) || 0));
  db.prepare(`
    INSERT INTO charm_purchase_progress (charm_code, purchased_qty, updated_at)
    VALUES (@code, @qty, @now)
    ON CONFLICT(charm_code) DO UPDATE SET purchased_qty = excluded.purchased_qty, updated_at = excluded.updated_at
  `).run({ code, qty: n, now: Math.floor(Date.now() / 1000) });
  return { charm_code: code, purchased_qty: n };
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
  // Excel is authoritative for supplier/charm fields, but app-managed identity
  // and costs must survive a full-sheet re-import.
  const existingByNorm = new Map(
    db.prepare('SELECT title_norm, cost_case, cost_grip, canonical_product_key FROM product_map')
      .all()
      .map(r => [r.title_norm, r]),
  );
  const ins = db.prepare(`
    INSERT INTO product_map (
      title_norm, title, shop_name, stall, charm_shop, charm_code,
      canonical_product_key, cost_case, cost_grip, sort_order, updated_at
    )
    VALUES (
      @title_norm, @title, @shop_name, @stall, @charm_shop, @charm_code,
      @canonical_product_key, @cost_case, @cost_grip, @sort_order, @updated_at
    )
    ON CONFLICT(title_norm) DO UPDATE SET
      title      = excluded.title,
      shop_name  = excluded.shop_name,
      stall      = excluded.stall,
      charm_shop = excluded.charm_shop,
      charm_code = excluded.charm_code,
      canonical_product_key = excluded.canonical_product_key,
      cost_case  = excluded.cost_case,
      cost_grip  = excluded.cost_grip,
      sort_order = excluded.sort_order,
      updated_at = excluded.updated_at
  `);
  const tx = db.transaction((list) => {
    db.prepare('DELETE FROM product_map').run();
    for (const r of list) {
      const prior = existingByNorm.get(String(r.title_norm || '').trim()) || {};
      ins.run({
        title_norm: String(r.title_norm || '').trim(),
        title:      String(r.title      || '').trim(),
        shop_name:  String(r.shop_name  || '').trim(),
        stall:      String(r.stall      || '').trim(),
        charm_shop: String(r.charm_shop || '').trim(),
        charm_code: String(r.charm_code || '').trim(),
        canonical_product_key: String(r.canonical_product_key || prior.canonical_product_key || '').trim() || null,
        cost_case: r.cost_case == null ? (prior.cost_case ?? null) : r.cost_case,
        cost_grip: r.cost_grip == null ? (prior.cost_grip ?? null) : r.cost_grip,
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

/** Normalise cost input → a non-negative number, or null to clear. */
function _normCost(cost) {
  if (cost === null || cost === undefined || cost === '') return null;
  const n = Number(cost);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100; // 2 dp
}

/**
 * Set the per-component purchase cost(s) for a product (by title). Case and grip
 * are priced separately. Pass only the field(s) you want to change:
 *   undefined → keep the existing value; a number/''/null → set (null clears).
 * Creates the product_map row if it doesn't exist yet; the supplier/charm mapping
 * already on the row is preserved.
 * @returns {{ title_norm: string, cost_case: number|null, cost_grip: number|null }}
 */
function setProductCost(db, { title, cost_case, cost_grip }) {
  const t = String(title || '').trim();
  if (!t) { const e = new Error('Product title is required.'); e.code = 'REQUIRED'; throw e; }
  const titleNorm = t.replace(/\|/g, ',').replace(/\s+/g, ' ').toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  const existing = db.prepare('SELECT id, cost_case, cost_grip, canonical_product_key FROM product_map WHERE title_norm = ?').get(titleNorm);
  const nextCase = cost_case === undefined ? (existing ? existing.cost_case : null) : _normCost(cost_case);
  const nextGrip = cost_grip === undefined ? (existing ? existing.cost_grip : null) : _normCost(cost_grip);
  const history = db.prepare(`
    INSERT INTO product_price_history
      (canonical_key, title_norm, component, old_cost, new_cost, changed_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const writeHistory = () => {
    if (cost_case !== undefined && (existing?.cost_case ?? null) !== nextCase) {
      history.run(existing?.canonical_product_key || null, titleNorm, 'case', existing?.cost_case ?? null, nextCase, now);
    }
    if (cost_grip !== undefined && (existing?.cost_grip ?? null) !== nextGrip) {
      history.run(existing?.canonical_product_key || null, titleNorm, 'grip', existing?.cost_grip ?? null, nextGrip, now);
    }
  };
  if (existing) {
    db.prepare('UPDATE product_map SET cost_case = @cc, cost_grip = @cg, updated_at = @now WHERE title_norm = @tn')
      .run({ cc: nextCase, cg: nextGrip, now, tn: titleNorm });
    // One physical product can have many Etsy listing titles. Price is a
    // physical-product fact, so keep every canonical alias in sync.
    if (existing.canonical_product_key) {
      db.prepare(
        'UPDATE product_map SET cost_case = @cc, cost_grip = @cg, updated_at = @now WHERE canonical_product_key = @pk',
      ).run({ cc: nextCase, cg: nextGrip, now, pk: existing.canonical_product_key });
    }
    writeHistory();
  } else {
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM product_map').get().m;
    db.prepare('INSERT INTO product_map (title_norm, title, cost_case, cost_grip, sort_order, updated_at) VALUES (@tn, @t, @cc, @cg, @so, @now)')
      .run({ tn: titleNorm, t, cc: nextCase, cg: nextGrip, so: maxOrder + 1, now });
    writeHistory();
  }
  return { title_norm: titleNorm, cost_case: nextCase, cost_grip: nextGrip };
}

/**
 * Set the purchase cost for a charm (by code). Creates a minimal charm_library
 * row if the code isn't catalogued yet.
 * @returns {{ code: string, cost: number|null }}
 */
function setCharmCost(db, { code, cost }) {
  const cd = String(code || '').trim();
  if (!cd) { const e = new Error('Charm code is required.'); e.code = 'REQUIRED'; throw e; }
  const c = _normCost(cost);
  const now = Math.floor(Date.now() / 1000);
  const existing = db.prepare('SELECT code FROM charm_library WHERE code = ?').get(cd);
  if (existing) {
    db.prepare('UPDATE charm_library SET cost = @c, updated_at = @now WHERE code = @cd').run({ c, now, cd });
  } else {
    db.prepare('INSERT INTO charm_library (code, cost, updated_at) VALUES (@cd, @c, @now)').run({ cd, c, now });
  }
  return { code: cd, cost: c };
}

/**
 * Return all product_map rows as an array, optionally filtered by a search
 * term (case-insensitive substring match on title, shop_name, or stall).
 * @param {Database.Database} db
 * @param {string} [q]  Optional search string.
 * @returns {Array}
 */
function getProductMap(db, q) {
  const all = db.prepare('SELECT * FROM product_map ORDER BY sort_order ASC, title ASC').all();
  if (!q) return all;
  const lq = q.toLowerCase();
  return all.filter(r =>
    (r.title      || '').toLowerCase().includes(lq) ||
    (r.shop_name  || '').toLowerCase().includes(lq) ||
    (r.stall      || '').toLowerCase().includes(lq) ||
    (r.charm_shop || '').toLowerCase().includes(lq) ||
    (r.charm_code || '').toLowerCase().includes(lq),
  );
}

function _syncCanonicalProductMapFields(db, titleNorm, fields) {
  const row = db.prepare('SELECT canonical_product_key FROM product_map WHERE title_norm = ?').get(titleNorm);
  if (!row?.canonical_product_key) return;
  db.prepare(`
    UPDATE product_map SET
      shop_name = @shop_name,
      stall = @stall,
      charm_shop = @charm_shop,
      charm_code = @charm_code,
      updated_at = @updated_at
    WHERE canonical_product_key = @canonical_product_key
  `).run({
    canonical_product_key: row.canonical_product_key,
    shop_name: String(fields.shop_name || '').trim(),
    stall: String(fields.stall || '').trim(),
    charm_shop: String(fields.charm_shop || '').trim(),
    charm_code: String(fields.charm_code || '').trim(),
    updated_at: Math.floor(Date.now() / 1000),
  });
}

/**
 * Insert or update a single product_map row.
 * Conflict resolution is by title_norm (UNIQUE).
 * @param {Database.Database} db
 * @param {{ title, shop_name?, stall?, charm_shop?, charm_code?, sort_order? }} row
 * @returns {{ id: number, title_norm: string }}
 */
function upsertProductMapRow(db, row) {
  const title = String(row.title || '').trim();
  if (!title) { const e = new Error('Product title is required.'); e.code = 'REQUIRED'; throw e; }

  const titleNorm = title
    .replace(/\|/g, ',')
    .replace(/\s+/g, ' ')
    .toLowerCase();

  const now = Math.floor(Date.now() / 1000);
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM product_map').get().m;

  const info = db.prepare(`
    INSERT INTO product_map (
      title_norm, title, shop_name, stall, charm_shop, charm_code,
      canonical_product_key, sort_order, updated_at
    )
    VALUES (
      @title_norm, @title, @shop_name, @stall, @charm_shop, @charm_code,
      @canonical_product_key, @sort_order, @updated_at
    )
    ON CONFLICT(title_norm) DO UPDATE SET
      title      = excluded.title,
      shop_name  = excluded.shop_name,
      stall      = excluded.stall,
      charm_shop = excluded.charm_shop,
      charm_code = excluded.charm_code,
      canonical_product_key = COALESCE(excluded.canonical_product_key, product_map.canonical_product_key),
      updated_at = excluded.updated_at
  `).run({
    title_norm: titleNorm,
    title,
    shop_name:  String(row.shop_name  || '').trim(),
    stall:      String(row.stall      || '').trim(),
    charm_shop: String(row.charm_shop || '').trim(),
    charm_code: String(row.charm_code || '').trim(),
    canonical_product_key: String(row.canonical_product_key || '').trim() || null,
    sort_order: typeof row.sort_order === 'number' ? row.sort_order : maxOrder + 1,
    updated_at: now,
  });

  const id = info.lastInsertRowid
    ? info.lastInsertRowid
    : db.prepare('SELECT id FROM product_map WHERE title_norm = ?').get(titleNorm).id;

  _syncCanonicalProductMapFields(db, titleNorm, row);
  return { id, title_norm: titleNorm };
}

/**
 * Update an existing product_map row in-place by its surrogate `id`.
 * Unlike upsertProductMapRow, this preserves the row's position and can
 * change the title (and hence title_norm) without creating a duplicate.
 * Throws DUPLICATE if the new title_norm already belongs to a *different* row.
 * @param {Database.Database} db
 * @param {{ id, title, shop_name?, stall?, charm_shop?, charm_code? }} row
 */
function updateProductMapRowById(db, row) {
  const id    = Number(row.id);
  const title = String(row.title || '').trim();
  if (!title) { const e = new Error('Product title is required.'); e.code = 'REQUIRED'; throw e; }

  const titleNorm = title
    .replace(/\|/g, ',')
    .replace(/\s+/g, ' ')
    .toLowerCase();

  // Guard: another row already owns this normalised title.
  const clash = db.prepare('SELECT id FROM product_map WHERE title_norm = ? AND id <> ?').get(titleNorm, id);
  if (clash) {
    const e = new Error(`A catalog entry with a matching title already exists (id ${clash.id}).`);
    e.code = 'DUPLICATE'; throw e;
  }

  const now  = Math.floor(Date.now() / 1000);
  const existing = db.prepare('SELECT canonical_product_key FROM product_map WHERE id = ?').get(id);
  const info = db.prepare(`
    UPDATE product_map
    SET title_norm = @title_norm, title = @title, shop_name = @shop_name, stall = @stall,
        charm_shop = @charm_shop, charm_code = @charm_code,
        canonical_product_key = @canonical_product_key, updated_at = @updated_at
    WHERE id = @id
  `).run({
    id,
    title_norm: titleNorm,
    title,
    shop_name:  String(row.shop_name  || '').trim(),
    stall:      String(row.stall      || '').trim(),
    charm_shop: String(row.charm_shop || '').trim(),
    charm_code: String(row.charm_code || '').trim(),
    canonical_product_key: row.canonical_product_key === undefined
      ? (existing?.canonical_product_key || null)
      : (String(row.canonical_product_key || '').trim() || null),
    updated_at: now,
  });

  if (info.changes === 0) {
    const e = new Error('Entry not found.'); e.code = 'NOT_FOUND'; throw e;
  }
  _syncCanonicalProductMapFields(db, titleNorm, row);
}

/**
 * Delete a product_map row by its surrogate `id`.
 * @param {Database.Database} db
 * @param {number|string} id
 * @returns {boolean}  true when a row was actually deleted
 */
function deleteProductMapRow(db, id) {
  const info = db.prepare('DELETE FROM product_map WHERE id = ?').run(Number(id));
  return info.changes > 0;
}

// ─── Manual route items ─────────────────────────────────────────────────────

/**
 * Insert a manual (operator-created) route line-item and assign it a stable
 * synthetic NEGATIVE receipt_id so it integrates with the receipt_id-keyed
 * route_assignments / status / exclude machinery without colliding with any
 * real Etsy receipt.
 *
 * @param {Database.Database} db
 * @param {object} row
 * @param {string} row.item_key   - line-item key (see route/dashboard.lineItemKey)
 * @param {string} row.title
 * @param {string} [row.phone_model]
 * @param {string} [row.style]
 * @param {number} [row.quantity]
 * @param {string} [row.shop_name]
 * @param {number|null} [row.listing_id]
 * @param {string} [row.image_url]   - CDN/remote URL (catalog picks)
 * @param {Buffer|null} [row.image_data] - uploaded image bytes (custom products)
 * @param {string} [row.image_mime]
 * @param {string} [row.source]      - 'catalog' | 'custom'
 * @returns {{ id: number, receipt_id: number }}
 */
function insertManualItem(db, row) {
  const title = String(row.title || '').trim();
  if (!title) { const e = new Error('Product title is required.'); e.code = 'REQUIRED'; throw e; }
  if (!row.item_key) { const e = new Error('item_key is required.'); e.code = 'REQUIRED'; throw e; }

  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO route_manual_items
        (receipt_id, item_key, title, phone_model, style, quantity, shop_name,
         listing_id, image_url, image_data, image_mime, source, created_at)
      VALUES
        (0, @item_key, @title, @phone_model, @style, @quantity, @shop_name,
         @listing_id, @image_url, @image_data, @image_mime, @source, strftime('%s','now'))
    `).run({
      item_key:    String(row.item_key),
      title,
      phone_model: String(row.phone_model || '').trim(),
      style:       String(row.style || '').trim(),
      quantity:    Math.max(1, parseInt(row.quantity, 10) || 1),
      shop_name:   String(row.shop_name || '').trim(),
      listing_id:  row.listing_id != null && String(row.listing_id).trim() !== '' ? Number(row.listing_id) : null,
      image_url:   String(row.image_url || '').trim(),
      image_data:  row.image_data && row.image_data.length ? row.image_data : null,
      image_mime:  String(row.image_mime || '').trim(),
      source:      row.source === 'catalog' ? 'catalog' : (row.source === 'custom' ? 'custom' : 'manual'),
    });
    const id = Number(info.lastInsertRowid);
    // receipt_id: either an EXPLICIT id supplied by the caller (used to LINK this
    // route sidecar to its companion manual ORDER in `receipts`, so they share one
    // id across both tabs), or a synthetic negative id derived from the row id.
    const explicit = Number(row.receipt_id);
    const receiptId = Number.isInteger(explicit) && explicit < 0 ? explicit : -id;
    db.prepare('UPDATE route_manual_items SET receipt_id = ? WHERE id = ?').run(receiptId, id);
    return { id, receipt_id: receiptId };
  });
  return tx();
}

// ─── Order issues (fulfilment-exception workflow) ───────────────────────────

/** Issue types the workflow understands. */
const ISSUE_TYPES = ['out_of_production', 'model_unavailable', 'other'];
/** Listing actions recorded when the Etsy listing has been handled. */
const ISSUE_LISTING_ACTIONS = ['deleted', 'model_removed', 'none'];
/** Resolutions recorded when an issue is closed. */
const ISSUE_RESOLUTIONS = ['switched', 'refunded', 'cancelled', 'other'];

/**
 * Map of `${receipt_id}\x00${item_key}` → issue row, for ONLY open issues.
 * Used by the Route dashboard to hold affected line-items out of purchasing.
 * @param {Database.Database} db
 * @returns {Map<string, object>}
 */
function getOpenIssueMap(db) {
  const map = new Map();
  try {
    db.prepare("SELECT * FROM order_issues WHERE status = 'open'").all()
      .forEach((r) => map.set(`${r.receipt_id}\x00${r.item_key}`, r));
  } catch { /* table may not exist yet on first run */ }
  return map;
}

/**
 * All issues for a set of receipts (open + resolved), keyed by receipt_id.
 * @param {Database.Database} db
 * @param {Array<number>} receiptIds
 * @returns {Object<number, Array<object>>}
 */
function getIssuesForReceipts(db, receiptIds) {
  const out = {};
  const ids = (receiptIds || []).map(Number).filter(Number.isInteger);
  if (!ids.length) return out;
  try {
    const ph = ids.map(() => '?').join(',');
    db.prepare(`SELECT * FROM order_issues WHERE receipt_id IN (${ph})`)
      .all(ids)
      .forEach((r) => { (out[r.receipt_id] ||= []).push(r); });
  } catch { /* table may not exist yet */ }
  return out;
}

/** All issues for one receipt (open + resolved), newest first. */
function getIssuesForReceipt(db, receiptId) {
  try {
    return db.prepare('SELECT * FROM order_issues WHERE receipt_id = ? ORDER BY created_at DESC, id DESC').all(Number(receiptId));
  } catch { return []; }
}

/** Fetch one issue by id, or null. */
function getIssueById(db, id) {
  try { return db.prepare('SELECT * FROM order_issues WHERE id = ?').get(Number(id)) || null; }
  catch { return null; }
}

/** Fetch the (single) issue for a line-item, or null. */
function getOrderIssue(db, receiptId, itemKey) {
  try {
    return db.prepare('SELECT * FROM order_issues WHERE receipt_id = ? AND item_key = ?')
      .get(Number(receiptId), String(itemKey)) || null;
  } catch { return null; }
}

/**
 * Create or update (re-open) the issue for a line-item. Keyed by
 * (receipt_id, item_key); re-flagging an existing line updates its type/note
 * and re-opens it (clearing any prior resolution) so the workflow restarts.
 *
 * @param {Database.Database} db
 * @param {object} p - { receipt_id, item_key, listing_id?, title?, phone_model?, issue_type, note?, source? }
 * @returns {object} the upserted issue row
 */
function upsertOrderIssue(db, p) {
  const now = Math.floor(Date.now() / 1000);
  const issueType = ISSUE_TYPES.includes(p.issue_type) ? p.issue_type : 'other';
  // `source` records who last (re-)raised the issue: whoever calls upsert is
  // asserting it now, so they take ownership. Callers guard WHEN they upsert
  // (e.g. Shopping Mode never upserts over an actively-worked operator issue), so
  // overwriting source here is always the intended, current owner.
  db.prepare(`
    INSERT INTO order_issues
      (receipt_id, item_key, listing_id, title, phone_model, issue_type, status, note, source, created_at, updated_at)
    VALUES
      (@receipt_id, @item_key, @listing_id, @title, @phone_model, @issue_type, 'open', @note, @source, @now, @now)
    ON CONFLICT(receipt_id, item_key) DO UPDATE SET
      listing_id  = COALESCE(excluded.listing_id, listing_id),
      title       = COALESCE(excluded.title, title),
      phone_model = COALESCE(excluded.phone_model, phone_model),
      issue_type  = excluded.issue_type,
      note        = COALESCE(excluded.note, note),
      source      = excluded.source,
      status      = 'open',
      resolution  = NULL,
      resolved_at = NULL,
      -- Re-flagging a line whose PREVIOUS issue was already RESOLVED is a brand-new
      -- problem (classically: the buyer switched design, and the replacement is now
      -- also unavailable). Reset the buyer-contact workflow so a fresh, correct
      -- message is drafted for the current design instead of showing the stale
      -- "buyer already messaged" state and the old copy about the abandoned design.
      -- Merely retyping an already-OPEN issue keeps the operator's progress intact.
      buyer_notified_at  = CASE WHEN status <> 'open' THEN NULL ELSE buyer_notified_at END,
      listing_handled_at = CASE WHEN status <> 'open' THEN NULL ELSE listing_handled_at END,
      listing_action     = CASE WHEN status <> 'open' THEN NULL ELSE listing_action END,
      buyer_message      = CASE WHEN status <> 'open' THEN NULL ELSE buyer_message END,
      buyer_message_at   = CASE WHEN status <> 'open' THEN NULL ELSE buyer_message_at END,
      updated_at  = excluded.updated_at
  `).run({
    receipt_id:  Number(p.receipt_id),
    item_key:    String(p.item_key),
    listing_id:  p.listing_id != null ? Number(p.listing_id) : null,
    title:       p.title != null ? String(p.title) : null,
    phone_model: p.phone_model != null ? String(p.phone_model) : null,
    issue_type:  issueType,
    note:        p.note != null ? String(p.note) : null,
    source:      p.source === 'shop' ? 'shop' : 'manual',
    now,
  });
  return db.prepare('SELECT * FROM order_issues WHERE receipt_id = ? AND item_key = ?')
    .get(Number(p.receipt_id), String(p.item_key));
}

/**
 * Patch workflow fields on an issue (notify / handle-listing / resolve / reopen).
 * Only the provided keys are written. Returns the updated row, or null if absent.
 *
 * @param {Database.Database} db
 * @param {number} id
 * @param {object} patch - any of { buyer_notified_at, listing_handled_at,
 *   listing_action, status, resolution, resolved_at, note, buyer_message,
 *   buyer_message_at }
 * @returns {object|null}
 */
function patchOrderIssue(db, id, patch) {
  const existing = getIssueById(db, id);
  if (!existing) return null;
  const allowed = ['buyer_notified_at', 'listing_handled_at', 'listing_action',
    'status', 'resolution', 'resolved_at', 'note',
    'buyer_message', 'buyer_message_at', 'source'];
  const sets = [];
  const params = { id: Number(id), now: Math.floor(Date.now() / 1000) };
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) {
      sets.push(`${k} = @${k}`);
      params[k] = patch[k];
    }
  }
  if (!sets.length) return existing;
  sets.push('updated_at = @now');
  db.prepare(`UPDATE order_issues SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return getIssueById(db, id);
}

/** Permanently delete an issue. Returns true when a row was removed. */
function deleteOrderIssue(db, id) {
  try { return db.prepare('DELETE FROM order_issues WHERE id = ?').run(Number(id)).changes > 0; }
  catch { return false; }
}

/**
 * One-time migration that retires the old "Archive" feature in favour of the
 * Issues / on-hold system.
 *
 * For every still-archived receipt (archived_at IS NOT NULL):
 *   • If its archive_reason indicates the product is OUT OF PRODUCTION, open a
 *     per-line-item Issue (issue_type='out_of_production') for each transaction,
 *     so the line is held out of the purchasing Route exactly as a freshly-flagged
 *     issue would be. Existing issues for a line are left untouched (no clobber).
 *   • Then clear archived_at so the order returns to the active views and the row
 *     is never reprocessed on a later startup. archive_reason is intentionally
 *     LEFT in place as a dormant historical breadcrumb (the column is retired,
 *     not dropped).
 *
 * Idempotent: once archived_at has been cleared the WHERE filter excludes the row,
 * so re-running does nothing (and never re-opens an issue the operator resolved).
 *
 * @param {Database.Database} db
 */
function migrateArchivedOrdersToIssues(db) {
  let archived;
  try {
    archived = db.prepare(
      "SELECT receipt_id, archive_reason, all_transactions FROM receipts WHERE archived_at IS NOT NULL"
    ).all();
  } catch { return; } // archived_at column absent (fresh DB) → nothing to do
  if (!archived.length) return;

  // Lazy require to avoid a circular top-level dependency (route/dashboard pulls
  // from this module). By migration time both modules are fully loaded.
  let lineItemKey, parseVariations;
  try {
    ({ lineItemKey, parseVariations } = require('../route/dashboard'));
  } catch { /* fall back below */ }

  const OUT_OF_PROD_RE = /out of production/i;
  let migratedOrders = 0, createdIssues = 0;

  const tx = db.transaction(() => {
    for (const r of archived) {
      const reason = String(r.archive_reason || '');
      if (OUT_OF_PROD_RE.test(reason) && lineItemKey) {
        let txs = [];
        try { txs = JSON.parse(r.all_transactions || '[]'); } catch { txs = []; }
        if (!Array.isArray(txs)) txs = [];
        for (const t of txs) {
          const title = (t.title || '').trim();
          if (!title) continue;
          const itemKey = lineItemKey(title, t.listing_id);
          // Don't clobber an issue the operator may already have created.
          const exists = db.prepare(
            'SELECT 1 FROM order_issues WHERE receipt_id = ? AND item_key = ?'
          ).get(r.receipt_id, itemKey);
          if (exists) continue;
          let phoneModel = '';
          try { phoneModel = parseVariations ? (parseVariations(t.variations).phoneModel || '') : ''; } catch {}
          upsertOrderIssue(db, {
            receipt_id:  r.receipt_id,
            item_key:    itemKey,
            listing_id:  t.listing_id || null,
            title,
            phone_model: phoneModel || null,
            issue_type:  'out_of_production',
            note:        'Migrated from Archive: ' + reason.slice(0, 200),
          });
          createdIssues++;
        }
      }
      // Restore to active views; keep archive_reason as a dormant breadcrumb.
      db.prepare('UPDATE receipts SET archived_at = NULL WHERE receipt_id = ?').run(r.receipt_id);
      migratedOrders++;
    }
  });
  tx();

  if (migratedOrders) {
    console.log(`[db] Retired Archive → Issues: processed ${migratedOrders} archived order(s), opened ${createdIssues} issue(s).`);
  }
}

/**
 * Self-heal lines that are BOTH switched to a new design AND still flagged
 * on-hold, where the switch supersedes the hold.
 *
 * WHY: a design switch is the operator's explicit "buy this replacement instead"
 * decision, so the line must flow into purchasing. It was being silently pulled
 * back out because the line still carried an OPEN fulfilment issue — either a
 * stale pre-switch flag that never resolved, or (the real culprit) an AUTOMATED
 * Shopping-Mode re-raise that fired after the switch and reversed it. The route
 * builder withholds any open-issue line, so the switched product dropped out of
 * the shopping route entirely and the buyer's item was missed.
 *
 * This closes those superseded holds as `resolution='switched'`, using the exact
 * same precedence rule the route enforces at read time
 * (route/dashboard.substitutionSupersedesIssue): pure recency — an open issue is
 * superseded only when the switch is AT LEAST AS RECENT as it (a pre-switch flag
 * the switch resolved). An issue raised AFTER the switch reflects a NEW problem
 * with the replacement and is deliberately left open (it belongs in Issues).
 * Idempotent: after healing there are no superseded open issues left to touch.
 *
 * @param {Database.Database} db
 */
function healSupersededSubstitutionIssues(db) {
  let result;
  try {
    result = db.prepare(`
      UPDATE order_issues
         SET status      = 'resolved',
             resolution  = 'switched',
             resolved_at = strftime('%s','now'),
             updated_at  = strftime('%s','now')
       WHERE status = 'open'
         AND EXISTS (
           SELECT 1 FROM order_line_substitutions s
            WHERE s.receipt_id = order_issues.receipt_id
              AND s.item_key   = order_issues.item_key
              AND s.updated_at >= order_issues.updated_at  -- switch is at least as recent
         )
    `).run();
  } catch { return; } // either table absent on a fresh DB → nothing to heal
  if (result.changes > 0) {
    console.log(`[db] Un-held ${result.changes} switched line(s) whose on-hold flag was superseded by a design switch.`);
  }
}

/**
 * Surface every line whose CURRENT purchase status is terminal (Out of Production
 * / Model Unavailable) as an OPEN fulfilment issue, so it appears in Issues/on-hold
 * and is held out of purchasing — exactly as if it had been flagged.
 *
 * WHY: the purchase-status → issue bridge historically ran only on the mobile
 * shopping route. Terminal statuses set from the desktop Route tab, the Orders-tab
 * per-component control, or the bulk route-status import never became issues, so
 * those orders read "Out of Production" yet were silently absent from Issues/on-
 * hold. The live bridge now fires from every surface; this reconciles the rows
 * that pre-date the fix. Idempotent — after healing, matching lines have an open
 * issue, so re-runs are no-ops.
 *
 * Conservative & context-correct, mirroring the live bridge (syncAssignmentIssue):
 *   • skips lines that already have an OPEN issue (already held),
 *   • never resurrects a line the operator deliberately CLOSED (resolution
 *     'refunded' / 'cancelled') — only re-raises otherwise,
 *   • severity: a discontinued product (out_of_production) outranks an unavailable
 *     model, and
 *   • a SWITCHED line's title/model follow the replacement design, never the
 *     original the buyer left behind.
 *
 * @param {Database.Database} db
 */
function reconcileTerminalStatusIssues(db) {
  let lineItemKey, parseVariations;
  try { ({ lineItemKey, parseVariations } = require('../route/dashboard')); } catch { /* fall back below */ }

  let rows;
  try {
    rows = db.prepare(`
      SELECT receipt_id, item_key, title, status_case, status_grip, status_charm
        FROM route_assignments
       WHERE status_case  IN ('Out of Production','Model Unavailable')
          OR status_grip  IN ('Out of Production','Model Unavailable')
          OR status_charm IN ('Out of Production','Model Unavailable')
    `).all();
  } catch { return; } // table absent on a fresh DB → nothing to reconcile
  if (!rows.length) return;

  let created = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const existing = db.prepare('SELECT status, resolution FROM order_issues WHERE receipt_id = ? AND item_key = ?')
        .get(r.receipt_id, r.item_key);
      if (existing && existing.status === 'open') continue;                                             // already held
      if (existing && (existing.resolution === 'refunded' || existing.resolution === 'cancelled')) continue; // deliberately closed

      const statuses = [r.status_case, r.status_grip, r.status_charm];
      const type = statuses.includes('Out of Production') ? 'out_of_production'
                 : statuses.includes('Model Unavailable') ? 'model_unavailable'
                 : null;
      if (!type) continue;

      // Context follows the switched design when present, else the ordered line.
      const sub = getSubstitutionForLine(db, r.receipt_id, r.item_key);
      let title = (sub && sub.new_title) || r.title || null;
      let listingId = null;
      let phoneModel = (sub && sub.new_phone_model) || null;
      if (lineItemKey) {
        try {
          const txns = db.prepare('SELECT title, listing_id, variations FROM transactions WHERE receipt_id = ?').all(r.receipt_id);
          const m = txns.find((t) => lineItemKey(t.title, t.listing_id) === r.item_key);
          if (m) {
            listingId = m.listing_id != null ? Number(m.listing_id) : null;
            if (!title) title = m.title;
            if (!phoneModel && parseVariations) { try { phoneModel = parseVariations(m.variations).phoneModel || null; } catch { /* best effort */ } }
          }
        } catch { /* best effort */ }
      }

      upsertOrderIssue(db, {
        receipt_id:  r.receipt_id,
        item_key:    r.item_key,
        listing_id:  listingId,
        title,
        phone_model: phoneModel,
        issue_type:  type,
        source:      'shop',
      });
      created++;
    }
  });
  tx();
  if (created) {
    console.log(`[db] Reconciled ${created} on-hold line(s): terminal purchase status now surfaced as a fulfilment issue.`);
  }
}

// ─── Order exchanges (wrong-model in-person swap workflow) ───────────────────

/** Component pieces an exchange can cover. */
const EXCHANGE_COMPONENTS = ['case', 'grip', 'charm'];

/**
 * Normalise a components input (array or comma string) to a clean, ordered,
 * de-duplicated "case,grip,charm"-style string containing only valid pieces.
 * @param {string|string[]|null|undefined} input
 * @returns {string}
 */
function normalizeExchangeComponents(input) {
  let parts = [];
  if (Array.isArray(input)) parts = input;
  else if (typeof input === 'string') parts = input.split(',');
  const set = new Set(parts.map((p) => String(p).trim().toLowerCase()).filter(Boolean));
  return EXCHANGE_COMPONENTS.filter((c) => set.has(c)).join(',');
}

/**
 * Map of `${receipt_id}\x00${item_key}` → exchange row, for ONLY open exchanges.
 * Used by the Route dashboard to hold affected line-items out of purchasing while
 * surfacing them in the dedicated "To exchange" bucket.
 * @param {Database.Database} db
 * @returns {Map<string, object>}
 */
function getOpenExchangeMap(db) {
  const map = new Map();
  try {
    db.prepare("SELECT * FROM order_exchanges WHERE status = 'open'").all()
      .forEach((r) => map.set(`${r.receipt_id}\x00${r.item_key}`, r));
  } catch { /* table may not exist yet on first run */ }
  return map;
}

/**
 * All exchanges for a set of receipts (open + done), keyed by receipt_id.
 * @param {Database.Database} db
 * @param {Array<number>} receiptIds
 * @returns {Object<number, Array<object>>}
 */
function getExchangesForReceipts(db, receiptIds) {
  const out = {};
  const ids = (receiptIds || []).map(Number).filter(Number.isInteger);
  if (!ids.length) return out;
  try {
    const ph = ids.map(() => '?').join(',');
    db.prepare(`SELECT * FROM order_exchanges WHERE receipt_id IN (${ph})`)
      .all(ids)
      .forEach((r) => { (out[r.receipt_id] ||= []).push(r); });
  } catch { /* table may not exist yet */ }
  return out;
}

/** All exchanges for one receipt (open + done), newest first. */
function getExchangesForReceipt(db, receiptId) {
  try {
    return db.prepare('SELECT * FROM order_exchanges WHERE receipt_id = ? ORDER BY created_at DESC, id DESC').all(Number(receiptId));
  } catch { return []; }
}

/** Fetch one exchange by id, or null. */
function getExchangeById(db, id) {
  try { return db.prepare('SELECT * FROM order_exchanges WHERE id = ?').get(Number(id)) || null; }
  catch { return null; }
}

/**
 * Create or update (re-open) the wrong-model exchange for a line-item. Keyed by
 * (receipt_id, item_key); re-flagging an existing line updates its details and
 * re-opens it (clearing any prior done stamp) so the swap is owed again.
 *
 * @param {Database.Database} db
 * @param {object} p - { receipt_id, item_key, listing_id?, title?, have_model?,
 *   need_model?, components?, supplier_shop?, supplier_stall?, note? }
 * @returns {object} the upserted exchange row
 */
function upsertOrderExchange(db, p) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO order_exchanges
      (receipt_id, item_key, listing_id, title, have_model, need_model,
       components, supplier_shop, supplier_stall, status, note, created_at, updated_at)
    VALUES
      (@receipt_id, @item_key, @listing_id, @title, @have_model, @need_model,
       @components, @supplier_shop, @supplier_stall, 'open', @note, @now, @now)
    ON CONFLICT(receipt_id, item_key) DO UPDATE SET
      listing_id     = COALESCE(excluded.listing_id, listing_id),
      title          = COALESCE(excluded.title, title),
      have_model     = COALESCE(excluded.have_model, have_model),
      need_model     = COALESCE(excluded.need_model, need_model),
      components     = excluded.components,
      supplier_shop  = COALESCE(excluded.supplier_shop, supplier_shop),
      supplier_stall = COALESCE(excluded.supplier_stall, supplier_stall),
      note           = COALESCE(excluded.note, note),
      status         = 'open',
      done_at        = NULL,
      updated_at     = excluded.updated_at
  `).run({
    receipt_id:     Number(p.receipt_id),
    item_key:       String(p.item_key),
    listing_id:     p.listing_id != null ? Number(p.listing_id) : null,
    title:          p.title != null ? String(p.title) : null,
    have_model:     p.have_model != null ? String(p.have_model) : null,
    need_model:     p.need_model != null ? String(p.need_model) : null,
    components:     normalizeExchangeComponents(p.components),
    supplier_shop:  p.supplier_shop != null ? String(p.supplier_shop) : null,
    supplier_stall: p.supplier_stall != null ? String(p.supplier_stall) : null,
    note:           p.note != null ? String(p.note) : null,
    now,
  });
  return db.prepare('SELECT * FROM order_exchanges WHERE receipt_id = ? AND item_key = ?')
    .get(Number(p.receipt_id), String(p.item_key));
}

/**
 * Patch workflow fields on an exchange (mark done / reopen / edit note).
 * Only the provided keys are written. Returns the updated row, or null if absent.
 *
 * @param {Database.Database} db
 * @param {number} id
 * @param {object} patch - any of { status, done_at, note, have_model, need_model,
 *   components, supplier_shop, supplier_stall }
 * @returns {object|null}
 */
function patchOrderExchange(db, id, patch) {
  const existing = getExchangeById(db, id);
  if (!existing) return null;
  const allowed = ['status', 'done_at', 'note', 'have_model', 'need_model',
    'components', 'supplier_shop', 'supplier_stall'];
  const sets = [];
  const params = { id: Number(id), now: Math.floor(Date.now() / 1000) };
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) {
      sets.push(`${k} = @${k}`);
      params[k] = k === 'components' ? normalizeExchangeComponents(patch[k]) : patch[k];
    }
  }
  if (!sets.length) return existing;
  sets.push('updated_at = @now');
  db.prepare(`UPDATE order_exchanges SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return getExchangeById(db, id);
}

/** Permanently delete an exchange. Returns true when a row was removed. */
function deleteOrderExchange(db, id) {
  try { return db.prepare('DELETE FROM order_exchanges WHERE id = ?').run(Number(id)).changes > 0; }
  catch { return false; }
}

// ─── Order line substitutions (local "design switch" override) ──────────────
//
// Non-destructive: NEVER touches Etsy. Records that an order line should be
// RENDERED and PURCHASED as a replacement design chosen by the operator after
// the buyer agreed to switch. See the order_line_substitutions table comment.

/** Fields safe to expose to the UI/Route (never the raw image BLOB). */
const _SUB_PUBLIC_COLS = `
  id, receipt_id, item_key, original_title, new_title, new_style,
  new_phone_model, source, source_listing_id, image_url,
  (image_data IS NOT NULL AND length(image_data) > 0) AS has_image_data,
  image_mime, note, created_at, updated_at`;

/**
 * Map of `${receipt_id}\x00${item_key}` → substitution (metadata only), for use
 * by the Route builder to override a line's product with the switched design.
 * @param {Database.Database} db
 * @returns {Map<string, object>}
 */
function getSubstitutionMap(db) {
  const map = new Map();
  try {
    db.prepare(`SELECT ${_SUB_PUBLIC_COLS} FROM order_line_substitutions`).all()
      .forEach((r) => map.set(`${r.receipt_id}\x00${r.item_key}`, r));
  } catch { /* table may not exist yet on first run */ }
  return map;
}

/**
 * All substitutions for a set of receipts (metadata only), keyed by receipt_id.
 * @param {Database.Database} db
 * @param {Array<number>} receiptIds
 * @returns {Object<number, Array<object>>}
 */
function getSubstitutionsForReceipts(db, receiptIds) {
  const out = {};
  const ids = (receiptIds || []).map(Number).filter(Number.isInteger);
  if (!ids.length) return out;
  try {
    const ph = ids.map(() => '?').join(',');
    db.prepare(`SELECT ${_SUB_PUBLIC_COLS} FROM order_line_substitutions WHERE receipt_id IN (${ph})`)
      .all(ids)
      .forEach((r) => { (out[r.receipt_id] ||= []).push(r); });
  } catch { /* table may not exist yet */ }
  return out;
}

/** The substitution for one line (metadata only), or null. */
function getSubstitutionForLine(db, receiptId, itemKey) {
  try {
    return db.prepare(`SELECT ${_SUB_PUBLIC_COLS} FROM order_line_substitutions WHERE receipt_id = ? AND item_key = ?`)
      .get(Number(receiptId), String(itemKey)) || null;
  } catch { return null; }
}

/**
 * Create or update the design switch for a line. Keyed by (receipt_id, item_key).
 * When image_data is provided it replaces the stored image; when it's undefined
 * the existing image is kept (so metadata-only edits don't wipe an upload).
 *
 * @param {Database.Database} db
 * @param {object} p - { receipt_id, item_key, original_title?, new_title,
 *   new_style?, new_phone_model?, source?, source_listing_id?, image_url?,
 *   image_data?(Buffer|null), image_mime?, note? }
 * @returns {object} the upserted substitution (metadata only)
 */
function upsertOrderSubstitution(db, p) {
  const now = Math.floor(Date.now() / 1000);
  const hasImage = Object.prototype.hasOwnProperty.call(p, 'image_data');
  const existing = getSubstitutionForLine(db, p.receipt_id, p.item_key);

  if (existing) {
    // Update in place; only overwrite the image when a new one was supplied.
    const sets = [
      'original_title = COALESCE(@original_title, original_title)',
      'new_title = @new_title',
      'new_style = @new_style',
      'new_phone_model = @new_phone_model',
      'source = @source',
      'source_listing_id = @source_listing_id',
      'image_url = @image_url',
      'note = @note',
      'updated_at = @now',
    ];
    if (hasImage) { sets.push('image_data = @image_data', 'image_mime = @image_mime'); }
    db.prepare(`UPDATE order_line_substitutions SET ${sets.join(', ')} WHERE receipt_id = @receipt_id AND item_key = @item_key`).run({
      receipt_id: Number(p.receipt_id),
      item_key: String(p.item_key),
      original_title: p.original_title != null ? String(p.original_title) : null,
      new_title: String(p.new_title),
      new_style: p.new_style != null ? String(p.new_style) : null,
      new_phone_model: p.new_phone_model != null ? String(p.new_phone_model) : null,
      source: p.source != null ? String(p.source) : null,
      source_listing_id: p.source_listing_id != null ? Number(p.source_listing_id) : null,
      image_url: p.image_url != null ? String(p.image_url) : null,
      image_data: hasImage ? (p.image_data || null) : null,
      image_mime: hasImage ? (p.image_mime != null ? String(p.image_mime) : null) : null,
      note: p.note != null ? String(p.note) : null,
      now,
    });
  } else {
    db.prepare(`
      INSERT INTO order_line_substitutions
        (receipt_id, item_key, original_title, new_title, new_style, new_phone_model,
         source, source_listing_id, image_url, image_data, image_mime, note, created_at, updated_at)
      VALUES
        (@receipt_id, @item_key, @original_title, @new_title, @new_style, @new_phone_model,
         @source, @source_listing_id, @image_url, @image_data, @image_mime, @note, @now, @now)
    `).run({
      receipt_id: Number(p.receipt_id),
      item_key: String(p.item_key),
      original_title: p.original_title != null ? String(p.original_title) : null,
      new_title: String(p.new_title),
      new_style: p.new_style != null ? String(p.new_style) : null,
      new_phone_model: p.new_phone_model != null ? String(p.new_phone_model) : null,
      source: p.source != null ? String(p.source) : null,
      source_listing_id: p.source_listing_id != null ? Number(p.source_listing_id) : null,
      image_url: p.image_url != null ? String(p.image_url) : null,
      image_data: hasImage ? (p.image_data || null) : null,
      image_mime: hasImage ? (p.image_mime != null ? String(p.image_mime) : null) : null,
      note: p.note != null ? String(p.note) : null,
      now,
    });
  }
  return getSubstitutionForLine(db, p.receipt_id, p.item_key);
}

/** Remove the design switch for a line. Returns true when a row was removed. */
function deleteOrderSubstitution(db, receiptId, itemKey) {
  try {
    return db.prepare('DELETE FROM order_line_substitutions WHERE receipt_id = ? AND item_key = ?')
      .run(Number(receiptId), String(itemKey)).changes > 0;
  } catch { return false; }
}

/** Fetch a substitution's stored image bytes + mime, or null. */
function getSubstitutionImage(db, id) {
  try {
    const row = db.prepare('SELECT image_data, image_mime FROM order_line_substitutions WHERE id = ?').get(Number(id));
    if (row && row.image_data && row.image_data.length) {
      return { data: row.image_data, mime: row.image_mime || 'image/png' };
    }
  } catch { /* table may not exist yet */ }
  return null;
}

// ─── Per-variant clarifying images (listing_id + style → uploaded photo) ──────

/**
 * Normalize a style label into a stable lookup key. Must be applied identically
 * on write and on every read so "Grip 3 Only", "grip 3 only" and "  Grip 3
 * Only " all map to the same override. An empty style means "the whole listing".
 *
 * @param {string} style
 * @returns {string}
 */
function normalizeStyleKey(style) {
  return String(style == null ? '' : style).trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Public columns for a style-image row — everything EXCEPT the BLOB, so callers
 * can list/inspect overrides cheaply without pulling image bytes.
 */
const _STYLE_IMG_META_COLS =
  'id, listing_id, style_key, style_value, image_mime, note, created_at, updated_at';

/**
 * Create or replace the clarifying image for a (listing_id, style) variant.
 *
 * @param {Database.Database} db
 * @param {object} p - { listing_id, style_value?, image_data(Buffer),
 *   image_mime?, note? }
 * @returns {object} the upserted row (metadata only)
 */
function upsertListingStyleImage(db, p) {
  const listingId = Number(p.listing_id);
  const styleValue = String(p.style_value == null ? '' : p.style_value).trim();
  const styleKey = normalizeStyleKey(styleValue);
  db.prepare(`
    INSERT INTO listing_style_images
      (listing_id, style_key, style_value, image_data, image_mime, note, created_at, updated_at)
    VALUES
      (@listing_id, @style_key, @style_value, @image_data, @image_mime, @note,
       strftime('%s','now'), strftime('%s','now'))
    ON CONFLICT(listing_id, style_key) DO UPDATE SET
      style_value = excluded.style_value,
      image_data  = excluded.image_data,
      image_mime  = excluded.image_mime,
      note        = excluded.note,
      updated_at  = strftime('%s','now')
  `).run({
    listing_id: listingId,
    style_key: styleKey,
    style_value: styleValue,
    image_data: p.image_data,
    image_mime: p.image_mime != null ? String(p.image_mime) : 'image/png',
    note: p.note != null ? String(p.note) : '',
  });
  return db.prepare(`SELECT ${_STYLE_IMG_META_COLS} FROM listing_style_images WHERE listing_id = ? AND style_key = ?`)
    .get(listingId, styleKey);
}

/** Remove the override for a (listing_id, style). Returns true when one existed. */
function deleteListingStyleImage(db, listingId, styleValue) {
  try {
    return db.prepare('DELETE FROM listing_style_images WHERE listing_id = ? AND style_key = ?')
      .run(Number(listingId), normalizeStyleKey(styleValue)).changes > 0;
  } catch { return false; }
}

/** Metadata (no BLOB) for one (listing_id, style) override, or null. */
function getListingStyleImageMeta(db, listingId, styleValue) {
  try {
    return db.prepare(`SELECT ${_STYLE_IMG_META_COLS} FROM listing_style_images WHERE listing_id = ? AND style_key = ?`)
      .get(Number(listingId), normalizeStyleKey(styleValue)) || null;
  } catch { return null; }
}

/** Fetch a style-image's stored bytes + mime by row id, or null. */
function getListingStyleImage(db, id) {
  try {
    const row = db.prepare('SELECT image_data, image_mime FROM listing_style_images WHERE id = ?').get(Number(id));
    if (row && row.image_data && row.image_data.length) {
      return { data: row.image_data, mime: row.image_mime || 'image/png' };
    }
  } catch { /* table may not exist yet */ }
  return null;
}

/**
 * Batch-load style-image overrides for a set of listings, so a page of orders /
 * route rows resolves its thumbnails in ONE query. Keyed by
 * `${listing_id}\x00${style_key}` → { id, image_mime, updated_at }.
 *
 * @param {Database.Database} db
 * @param {Iterable<number>} listingIds
 * @returns {Object<string, {id:number, image_mime:string, updated_at:number}>}
 */
function getListingStyleImageMap(db, listingIds) {
  const out = {};
  const ids = [...new Set([...(listingIds || [])].map(Number).filter(Number.isInteger))];
  if (!ids.length) return out;
  try {
    const ph = ids.map(() => '?').join(',');
    db.prepare(`SELECT id, listing_id, style_key, image_mime, updated_at FROM listing_style_images WHERE listing_id IN (${ph})`)
      .all(ids)
      .forEach((r) => {
        out[`${r.listing_id}\x00${r.style_key}`] = { id: r.id, image_mime: r.image_mime, updated_at: r.updated_at };
      });
  } catch { /* table may not exist yet */ }
  return out;
}

/**
 * Return all manual route items (metadata only — no image BLOB), newest first.
 * @param {Database.Database} db
 * @returns {Array}
 */
function getManualItems(db) {
  try {
    return db.prepare(`
      SELECT id, receipt_id, item_key, title, phone_model, style, quantity,
             shop_name, listing_id, image_url,
             (image_data IS NOT NULL) AS has_image_data, image_mime, source, created_at
      FROM route_manual_items
      ORDER BY created_at DESC, id DESC
    `).all();
  } catch { return []; }
}

/**
 * Fetch a manual item's stored image bytes + mime, or null.
 * @param {Database.Database} db
 * @param {number} id
 * @returns {{ data: Buffer, mime: string }|null}
 */
function getManualItemImage(db, id) {
  try {
    const row = db.prepare('SELECT image_data, image_mime FROM route_manual_items WHERE id = ?').get(Number(id));
    if (row && row.image_data && row.image_data.length) {
      return { data: row.image_data, mime: row.image_mime || 'image/png' };
    }
  } catch { /* table may not exist yet */ }
  return null;
}

/**
 * Delete a manual item by its synthetic receipt_id, also clearing any
 * route_assignments (charm / status / exclude) attached to it.
 * @param {Database.Database} db
 * @param {number} receiptId  negative synthetic receipt id
 * @returns {boolean} true when a row was deleted
 */
function deleteManualItemByReceipt(db, receiptId) {
  return purgeManualOrder(db, receiptId);
}

/**
 * Fully remove a manual order from EVERY table it can touch, given its shared
 * receipt_id. A manual order may exist as a `receipts` row (Orders tab), a
 * `route_manual_items` sidecar (Route tab), or both — plus per-line assignment /
 * purchase rows. This single, idempotent purge is the one true teardown used by
 * BOTH the Route-tab and Orders-tab delete endpoints so neither can ever leave a
 * half-deleted ghost in the other tab.
 *
 * @param {Database.Database} db
 * @param {number} receiptId  the shared (negative) manual receipt id
 * @returns {boolean} true when at least one row was removed
 */
function purgeManualOrder(db, receiptId) {
  const rid = Number(receiptId);
  const tx = db.transaction(() => {
    let removed = 0;
    for (const sql of [
      'DELETE FROM route_assignments WHERE receipt_id = ?',
      'DELETE FROM receipt_item_purchase WHERE receipt_id = ?',
      'DELETE FROM transactions WHERE receipt_id = ?',
      'DELETE FROM route_manual_items WHERE receipt_id = ?',
      "DELETE FROM receipts WHERE receipt_id = ? AND source = 'manual'",
    ]) {
      try { removed += db.prepare(sql).run(rid).changes; } catch { /* table may not exist */ }
    }
    return removed > 0;
  });
  return tx();
}

// ─── Manual ORDERS (Orders tab) ─────────────────────────────────────────────
//
// A manual order is an operator-created `receipts` row — a FULL order with a
// buyer name + shipping address + line items — for sales that did not come from
// the Etsy API (off-Etsy sales, replacements, wholesale, etc.). It lives in the
// SAME `receipts` table as synced Etsy orders so it automatically flows through
// every existing Orders-tab capability (packaging, 4PX label creation, tracking,
// notes, archive). Two invariants keep it safely separated from real Etsy data:
//
//   • receipt_id is NEGATIVE and ≤ -1e9 (MANUAL_RECEIPT_ID_FLOOR), so it can
//     never collide with Etsy's positive ids nor with the small negative ids the
//     Route tab assigns to route_manual_items.
//   • source = 'manual', so the sync worker, Etsy-ship and edit-tracking paths
//     all skip it (an Etsy API call for a fabricated receipt would 404).

const MANUAL_RECEIPT_ID_FLOOR = -1_000_000_000;

/**
 * Allocate the next unique negative receipt_id for a manual order.
 * Always returns a value ≤ MANUAL_RECEIPT_ID_FLOOR - 1, strictly below the
 * current minimum receipt_id, so it is guaranteed unique and clearly outside the
 * Etsy (positive) and Route-manual-item (small negative) id ranges.
 *
 * @param {Database.Database} db
 * @returns {number}
 */
function nextManualReceiptId(db) {
  const row = db.prepare('SELECT MIN(receipt_id) AS m FROM receipts').get();
  const currentMin = Number.isFinite(row?.m) ? row.m : 0;
  return Math.min(currentMin, MANUAL_RECEIPT_ID_FLOOR) - 1;
}

/**
 * Build the multi-line formatted_address string the Orders tab renders/copies,
 * matching the shape Etsy's own formatted_address uses:
 *   Name
 *   Street line 1
 *   Street line 2
 *   City, State ZIP
 *   COUNTRY
 *
 * @param {object} a  { name, first_line, second_line, city, state, zip, country_iso }
 * @returns {string}
 */
function _buildFormattedAddress(a) {
  const lines = [];
  if (a.name)        lines.push(a.name);
  if (a.first_line)  lines.push(a.first_line);
  if (a.second_line) lines.push(a.second_line);
  const cityLine = [a.city, [a.state, a.zip].filter(Boolean).join(' ')]
    .filter(Boolean).join(', ');
  if (cityLine) lines.push(cityLine);
  if (a.country_iso) lines.push(String(a.country_iso).toUpperCase());
  return lines.join('\n');
}

/**
 * Normalise an incoming manual-order payload into the column values + derived
 * fields (all_transactions JSON, formatted_address, first_* rollups) used by the
 * receipts table. Shared by insert + update so both paths stay identical.
 *
 * @param {object} p  operator-supplied fields
 * @param {object} [opts]
 * @param {boolean} [opts.requireName=true]  When false (Route "Add Order" path),
 *        a missing buyer name is allowed and falls back to a clear placeholder
 *        the operator fills in later from the Orders tab.
 * @returns {object}  normalised values keyed by receipts column name
 */
const MANUAL_ORDER_NAME_PLACEHOLDER = 'Manual order';
function _normaliseManualOrder(p, opts = {}) {
  const requireName = opts.requireName !== false;
  let name = String(p.name || '').trim();
  if (!name) {
    if (requireName) { const e = new Error('Buyer name is required.'); e.code = 'REQUIRED'; throw e; }
    name = MANUAL_ORDER_NAME_PLACEHOLDER;
  }

  const items = (Array.isArray(p.items) ? p.items : [])
    .map((it) => ({
      listing_id: it.listing_id != null && String(it.listing_id).trim() !== '' ? Number(it.listing_id) : null,
      title:      String(it.title || '').trim(),
      quantity:   Math.max(1, parseInt(it.quantity, 10) || 1),
      expected_ship_date: null,
      variations: Array.isArray(it.variations) ? it.variations : [],
    }))
    .filter((it) => it.title);
  if (items.length === 0) { const e = new Error('At least one line item with a title is required.'); e.code = 'REQUIRED'; throw e; }

  const countryIso = String(p.shipping_country_iso || '').trim().toUpperCase() || null;
  const addr = {
    name,
    first_line:  String(p.shipping_first_line  || '').trim() || null,
    second_line: String(p.shipping_second_line || '').trim() || null,
    city:        String(p.shipping_city  || '').trim() || null,
    state:       String(p.shipping_state || '').trim() || null,
    zip:         String(p.shipping_zip   || '').trim() || null,
    country_iso: countryIso,
  };

  const grandtotal = p.grandtotal_amount != null && String(p.grandtotal_amount).trim() !== ''
    ? Number(p.grandtotal_amount) : null;

  return {
    name,
    buyer_email:          String(p.buyer_email || '').trim() || null,
    shipping_first_line:  addr.first_line,
    shipping_second_line: addr.second_line,
    shipping_city:        addr.city,
    shipping_state:       addr.state,
    shipping_zip:         addr.zip,
    shipping_country_iso: addr.country_iso,
    formatted_address:    _buildFormattedAddress(addr),
    first_product_title:  items[0].title,
    first_listing_id:     items[0].listing_id,
    first_quantity:       items[0].quantity,
    all_transactions:     JSON.stringify(items),
    grandtotal_amount:    Number.isFinite(grandtotal) ? grandtotal : null,
    grandtotal_currency:  String(p.grandtotal_currency || '').trim().toUpperCase() || null,
    message_from_buyer:   String(p.message_from_buyer || '').trim() || null,
    team_note:            String(p.team_note || '').trim() || null,
  };
}

/**
 * Create a manual order as a real `receipts` row. Returns the new (negative)
 * receipt_id. The order is marked paid + unshipped so it lands in the default
 * "Needs shipping" Orders view exactly like a fresh Etsy order.
 *
 * @param {Database.Database} db
 * @param {object} payload  { shop_id, group_id, name, buyer_email, phone,
 *                            shipping_*, items[], grandtotal_amount, ... }
 * @returns {{ receipt_id: number }}
 */
function insertManualOrder(db, payload) {
  // Manual orders default to the synthetic "Manual Orders" shop. A real shop may
  // still be supplied (e.g. to attribute an off-Etsy order to a specific shop),
  // in which case its group is resolved automatically.
  let shopId  = String(payload.shop_id  || '').trim() || MANUAL_SHOP_ID;
  let groupId = String(payload.group_id || '').trim();
  if (!groupId) {
    const shopRow = db.prepare('SELECT group_id FROM shops WHERE shop_id = ?').get(shopId);
    groupId = shopRow?.group_id || MANUAL_GROUP_ID;
    if (!shopRow) shopId = MANUAL_SHOP_ID; // unknown shop → fall back to manual home
  }

  const v = _normaliseManualOrder(payload, { requireName: !!payload.requireName });
  const now = Math.floor(Date.now() / 1000);

  const tx = db.transaction(() => {
    const receiptId = nextManualReceiptId(db);
    db.prepare(`
      INSERT INTO receipts (
        receipt_id, shop_id, group_id, buyer_user_id, buyer_email, name,
        status, is_shipped, is_paid, grandtotal_amount, grandtotal_currency,
        message_from_buyer, shipping_first_line, shipping_second_line,
        shipping_city, shipping_state, shipping_zip, shipping_country_iso,
        first_product_title, first_listing_id, first_quantity, all_transactions,
        formatted_address, team_note, etsy_created_at, etsy_updated_at,
        synced_at, source
      ) VALUES (
        @receipt_id, @shop_id, @group_id, NULL, @buyer_email, @name,
        'Paid', 0, 1, @grandtotal_amount, @grandtotal_currency,
        @message_from_buyer, @shipping_first_line, @shipping_second_line,
        @shipping_city, @shipping_state, @shipping_zip, @shipping_country_iso,
        @first_product_title, @first_listing_id, @first_quantity, @all_transactions,
        @formatted_address, @team_note, @now, @now,
        @now, 'manual'
      )
    `).run({ ...v, receipt_id: receiptId, shop_id: shopId, group_id: groupId, now });
    return { receipt_id: receiptId };
  });
  return tx();
}

/**
 * Update an existing manual order's buyer / address / items. Refuses to touch a
 * synced Etsy order (source must be 'manual'). Address-derived fields are
 * recomputed from the new values.
 *
 * @param {Database.Database} db
 * @param {number} receiptId
 * @param {object} payload  same shape as insertManualOrder (minus shop/group)
 * @returns {boolean} true when a manual order row was updated
 */
function updateManualOrder(db, receiptId, payload) {
  const rid = Number(receiptId);
  const existing = db.prepare('SELECT source FROM receipts WHERE receipt_id = ?').get(rid);
  if (!existing) { const e = new Error('Order not found.'); e.code = 'NOT_FOUND'; throw e; }
  if (existing.source !== 'manual') { const e = new Error('Only manual orders can be edited.'); e.code = 'FORBIDDEN'; throw e; }

  const v = _normaliseManualOrder(payload);
  const now = Math.floor(Date.now() / 1000);
  const info = db.prepare(`
    UPDATE receipts SET
      name                 = @name,
      buyer_email          = @buyer_email,
      grandtotal_amount    = @grandtotal_amount,
      grandtotal_currency  = @grandtotal_currency,
      message_from_buyer   = @message_from_buyer,
      shipping_first_line  = @shipping_first_line,
      shipping_second_line = @shipping_second_line,
      shipping_city        = @shipping_city,
      shipping_state       = @shipping_state,
      shipping_zip         = @shipping_zip,
      shipping_country_iso = @shipping_country_iso,
      first_product_title  = @first_product_title,
      first_listing_id     = @first_listing_id,
      first_quantity       = @first_quantity,
      all_transactions     = @all_transactions,
      formatted_address    = @formatted_address,
      team_note            = COALESCE(@team_note, team_note),
      etsy_updated_at      = @now
    WHERE receipt_id = @receipt_id AND source = 'manual'
  `).run({ ...v, receipt_id: rid, now });
  return info.changes > 0;
}

/**
 * Delete a manual order and its dependent per-line rows. Refuses to delete a
 * synced Etsy order. The caller is responsible for blocking deletion while a 4PX
 * shipment still exists (cancel it first) — this helper only enforces source.
 *
 * @param {Database.Database} db
 * @param {number} receiptId
 * @returns {boolean} true when a manual order row was deleted
 */
function deleteManualOrder(db, receiptId) {
  const rid = Number(receiptId);
  const existing = db.prepare('SELECT source FROM receipts WHERE receipt_id = ?').get(rid);
  // A receipts row that is NOT manual must never be deleted here. (A receipt-less
  // route sidecar — no receipts row at all — is fine to purge.)
  if (existing && existing.source !== 'manual') {
    const e = new Error('Only manual orders can be deleted.'); e.code = 'FORBIDDEN'; throw e;
  }
  return purgeManualOrder(db, rid);
}

/**
 * Toggle the LOCAL shipped state of a manual order (manual orders are never
 * pushed to Etsy, so "shipped" here is a purely local flag the operator sets
 * once a manual order has left the warehouse). source must be 'manual'.
 *
 * @param {Database.Database} db
 * @param {number} receiptId
 * @param {boolean} shipped
 * @returns {boolean} true when updated
 */
function setManualOrderShipped(db, receiptId, shipped) {
  const rid = Number(receiptId);
  const existing = db.prepare('SELECT source FROM receipts WHERE receipt_id = ?').get(rid);
  if (!existing) { const e = new Error('Order not found.'); e.code = 'NOT_FOUND'; throw e; }
  if (existing.source !== 'manual') { const e = new Error('Only manual orders can be marked shipped locally.'); e.code = 'FORBIDDEN'; throw e; }
  const info = shipped
    ? db.prepare("UPDATE receipts SET is_shipped = 1, status = 'Completed' WHERE receipt_id = ? AND source = 'manual'").run(rid)
    : db.prepare("UPDATE receipts SET is_shipped = 0, status = 'Paid'      WHERE receipt_id = ? AND source = 'manual'").run(rid);
  return info.changes > 0;
}

/**
 * Attach (or clear) a tracking number on a manual order so its package can be
 * tracked, without going through the integrated "Ship with 4PX" flow. Use this
 * when the parcel already has a 4PX (or other carrier) tracking number obtained
 * outside the dashboard.
 *
 * Setting a number mirrors it into BOTH `tracking_code` (which drives pre-transit
 * detection and the live-route tracking link in the UI) and `fourpx_tracking_no`
 * — the latter only when it is a genuine 4PX number, so the 4PX label-download /
 * tracking integrations are offered for it but never for an unrelated carrier.
 * It also marks the order locally shipped (manual orders never touch Etsy) and
 * stamps `shipment_notified_at` so the order behaves exactly like a 4PX-shipped
 * one. Passing an empty tracking number clears it and reverts the order to the
 * local "needs shipping" state.
 *
 * @param {Database.Database} db
 * @param {number} receiptId
 * @param {object} [opts]
 * @param {string} [opts.tracking_code]  Tracking number; empty/omitted clears it.
 * @param {string} [opts.carrier_name='4PX']
 * @returns {boolean} true when updated
 */
function setManualOrderTracking(db, receiptId, opts = {}) {
  const rid = Number(receiptId);
  const existing = db.prepare('SELECT source FROM receipts WHERE receipt_id = ?').get(rid);
  if (!existing) { const e = new Error('Order not found.'); e.code = 'NOT_FOUND'; throw e; }
  if (existing.source !== 'manual') {
    const e = new Error('Only manual orders can have a tracking number set this way.');
    e.code = 'FORBIDDEN';
    throw e;
  }

  const tracking = String(opts.tracking_code || '').trim();
  const carrier  = String(opts.carrier_name  || '').trim() || '4PX';
  const now = Math.floor(Date.now() / 1000);

  // Clearing the tracking number reverts the manual order to "needs shipping".
  if (!tracking) {
    const info = db.prepare(`
      UPDATE receipts SET
        tracking_code        = NULL,
        carrier_name         = NULL,
        fourpx_tracking_no   = NULL,
        shipment_notified_at = NULL,
        is_shipped           = 0,
        status               = 'Paid'
      WHERE receipt_id = ? AND source = 'manual'
    `).run(rid);
    return info.changes > 0;
  }

  // Only treat it as a 4PX number (and so light up the 4PX label/route features)
  // when it actually is one — by carrier or by the "4PX…" tracking prefix.
  const is4px = /4px/i.test(carrier) || /^4PX/i.test(tracking);

  const info = db.prepare(`
    UPDATE receipts SET
      tracking_code        = @tracking,
      carrier_name         = @carrier,
      fourpx_tracking_no   = @fourpxTracking,
      is_shipped           = 1,
      status               = 'Completed',
      shipment_notified_at = COALESCE(shipment_notified_at, @now)
    WHERE receipt_id = @rid AND source = 'manual'
  `).run({ tracking, carrier, fourpxTracking: is4px ? tracking : null, now, rid });
  return info.changes > 0;
}

// ─── Purchase-sync version history ──────────────────────────────────────────

/**
 * Persist one purchase-status sync as an immutable audit record.
 *
 * @param {Database.Database} db
 * @param {object} run
 * @param {string|null} run.file_name   - source workbook name
 * @param {object}      run.summary     - counts (updated_orders, became_ready, …)
 * @param {object}      run.payload     - full report ({ orders, ready, warnings, … })
 * @returns {number} the new run id (auto-increment)
 */
function recordPurchaseSyncRun(db, { file_name = null, summary = {}, payload = {} } = {}) {
  const info = db.prepare(`
    INSERT INTO purchase_sync_runs
      (created_at, file_name, updated_orders, updated_lines, became_ready,
       cleared_queue, ready_in_file, orders_in_file, summary_json, payload_json)
    VALUES
      (strftime('%s','now'), @file_name, @updated_orders, @updated_lines, @became_ready,
       @cleared_queue, @ready_in_file, @orders_in_file, @summary_json, @payload_json)
  `).run({
    file_name:      file_name || null,
    updated_orders: Number(summary.updated_orders || 0),
    updated_lines:  Number(summary.updated_lines || 0),
    became_ready:   Number(summary.became_ready || 0),
    cleared_queue:  Number(summary.cleared_from_queue || 0),
    ready_in_file:  Number(summary.ready_in_file || 0),
    orders_in_file: Number(summary.orders_in_file || 0),
    summary_json:   JSON.stringify(summary || {}),
    payload_json:   JSON.stringify(payload || {}),
  });
  return Number(info.lastInsertRowid);
}

/**
 * List recent purchase-sync runs (newest first) without the heavy payload blob.
 * @param {Database.Database} db
 * @param {number} [limit=100]
 * @returns {Array<object>}
 */
function listPurchaseSyncRuns(db, limit = 100) {
  try {
    return db.prepare(`
      SELECT id, created_at, file_name, updated_orders, updated_lines,
             became_ready, cleared_queue, ready_in_file, orders_in_file
      FROM purchase_sync_runs
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(1000, Number(limit) || 100)));
  } catch { return []; }
}

/**
 * Fetch one purchase-sync run with its full stored report payload.
 * @param {Database.Database} db
 * @param {number} id
 * @returns {object|null} the original report object (plus run_id / created_at)
 */
function getPurchaseSyncRun(db, id) {
  try {
    const row = db.prepare('SELECT * FROM purchase_sync_runs WHERE id = ?').get(Number(id));
    if (!row) return null;
    let payload = {};
    try { payload = JSON.parse(row.payload_json || '{}'); } catch { payload = {}; }
    payload.run_id = row.id;
    payload.generated_at = payload.generated_at || new Date(row.created_at * 1000).toISOString();
    if (!payload.file) payload.file = row.file_name || null;
    return payload;
  } catch { return null; }
}

module.exports = {
  initDb,
  getDb,
  syncConfigToDb,
  recordPurchaseSyncRun,
  listPurchaseSyncRuns,
  getPurchaseSyncRun,
  upsertRouteAssignment,
  setRouteDismissed,
  clearDismissedByReceipt,
  getAllRouteAssignments,
  upsertProductAssignment,
  getAllProductAssignments,
  replaceSupplierDirectory,
  replaceCharmShopDirectory,
  replaceProductMap,
  getProductMap,
  mergeProductMapSupplierCharm,
  syncProductMapToAssignments,
  reconcileAssignmentsToProductMap,
  upsertProductMapRow,
  updateProductMapRowById,
  deleteProductMapRow,
  ISSUE_TYPES,
  ISSUE_LISTING_ACTIONS,
  ISSUE_RESOLUTIONS,
  getOpenIssueMap,
  getIssuesForReceipts,
  getIssuesForReceipt,
  getIssueById,
  getOrderIssue,
  upsertOrderIssue,
  patchOrderIssue,
  deleteOrderIssue,
  EXCHANGE_COMPONENTS,
  normalizeExchangeComponents,
  getOpenExchangeMap,
  getExchangesForReceipts,
  getExchangesForReceipt,
  getExchangeById,
  upsertOrderExchange,
  patchOrderExchange,
  deleteOrderExchange,
  getSubstitutionMap,
  getSubstitutionsForReceipts,
  getSubstitutionForLine,
  upsertOrderSubstitution,
  deleteOrderSubstitution,
  getSubstitutionImage,
  normalizeStyleKey,
  upsertListingStyleImage,
  deleteListingStyleImage,
  getListingStyleImageMeta,
  getListingStyleImage,
  getListingStyleImageMap,
  insertManualItem,
  getManualItems,
  getManualItemImage,
  deleteManualItemByReceipt,
  nextManualReceiptId,
  insertManualOrder,
  updateManualOrder,
  deleteManualOrder,
  purgeManualOrder,
  setManualOrderShipped,
  setManualOrderTracking,
  seedManualOrderShop,
  MANUAL_SHOP_ID,
  MANUAL_GROUP_ID,
  MANUAL_SHOP_NAME,
  getSupplierDirectory,
  getCharmShopDirectory,
  getProductMapByNorm,
  setProductCost,
  setCharmCost,
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
  getCharmPurchaseProgress,
  setCharmPurchaseProgress,
  upsertReceipt,
  upsertTransaction,
  upsertListingImage,
  getListingImageData,
  upsertListingImageData,
  upsertListing,
  pruneStaleListings,
  upsertListingInventory,
  pruneStaleInventory,
  logEvent,
  updateCarrierStatus,
  startSyncLog,
  finishSyncLog,
  acquireLock,
  renewLock,
  releaseLock,
  updateShopSyncTime,
  updateShopListingCount,
  updateShopLedgerSyncTime,
  upsertLedgerEntry,
  upsertEtsyPayment,
  reattributeLedgerEntries,
  recategorizeLedgerEntries,
  categorizeLedgerEntry,
  getEarningsSummary,
  getCurrentMonthNet,
  getPerOrderEarnings,
  getLedgerStats,
  getShopBalances,
  backfillTransactionsFromReceipts,
  upsertFourpxShipment,
  recordFourpxFreight,
  recordFourpxShipmentInputs,
  getFourpxShippingSummary,
  updateTrackingDetail,
  getShipments,
  getShippingStats,
  setFourpxBalance,
  getFourpxBalanceStatus,
};
