'use strict'

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

const Database = require('better-sqlite3')
const fs = require('fs')
const path = require('path')
const { deriveVariationLabels } = require('../inventory/helpers')
const { canonicalizeStyleKey } = require('../listings/variation-images')
const { normalizeTrackingCode, normalizeCarrierName } = require('../tracking/validation')
// Imported (rather than re-expressed as SQL LIKE patterns) so the cached-row
// repair below and the live carrier classifier can never disagree about what
// counts as a delivered parcel.
const { analyzeTrackingHealth, isDeliveredText, eventShowsPostCustomsProgress, CUSTOMS_CLEAR_RE } = require('../tracking/checker')
const { composeShippingBuyerNotice, checkShippingNoticeCompliance, ETSY_SOLD_ORDER_URL } = require('../support/shipping-buyer-notice')
const stallLocation = require('../route/stall-location')
const charmNotes = require('../route/charm-notes')
const etsyCompletion = require('../orders/etsy-completion')
const operationsChecklist = require('../operations/checklist')
// Reads Etsy's per-transaction `shipping_upgrade` and turns it into the stored
// express facts. Namespaced so the call sites below name the contract they are
// persisting rather than looking like local helpers.
const shippingUpgrade = require('../orders/shipping-upgrade')
// The pickup-window policy lives with the rest of the 揽收预约 rules, so the
// query below and the config loader cannot drift apart on what "still waiting
// for a driver" means.
const { DEFAULT_AWAITING_DAYS: FOURPX_PICKUP_AWAITING_DAYS, normalizeAwaitingDays } = require('../fourpx/collect')

/** @type {Database.Database | null} */
let _db = null

// ── Manual-order home (synthetic shop/group) ────────────────────────────────
// Manual orders are real `receipts` rows, so they need a shop_id that satisfies
// the receipts→shops foreign key AND the JOIN shops in /api/orders and the Route
// dashboard. Rather than misattribute them to a real Etsy shop (or force the
// operator to pick one — the Route "Add Order" flow has no shop), every manual
// order belongs to a single dedicated, synthetic "Manual Orders" shop. It is
// seeded idempotently on startup and deliberately hidden from /api/shops so it
// never pollutes the Shops overview, listing/create/events/bulk selectors, or
// token accounting (it has no Etsy credentials).
const MANUAL_GROUP_ID = '__manual__'
const MANUAL_SHOP_ID = '__manual__'
const MANUAL_SHOP_NAME = 'Manual Orders'

/**
 * Idempotently seed the synthetic group + shop that own every manual order.
 * Safe to call on every startup.
 * @param {Database.Database} db
 */
function seedManualOrderShop(db) {
	db.prepare(
		`
    INSERT INTO groups (group_id, label, proxy_host)
    VALUES (@group_id, @label, 'direct')
    ON CONFLICT(group_id) DO UPDATE SET label = excluded.label
  `,
	).run({ group_id: MANUAL_GROUP_ID, label: MANUAL_SHOP_NAME })

	db.prepare(
		`
    INSERT INTO shops (shop_id, group_id, shop_name)
    VALUES (@shop_id, @group_id, @shop_name)
    ON CONFLICT(shop_id) DO UPDATE SET shop_name = excluded.shop_name, group_id = excluded.group_id
  `,
	).run({ shop_id: MANUAL_SHOP_ID, group_id: MANUAL_GROUP_ID, shop_name: MANUAL_SHOP_NAME })
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
	if (value == null) return null
	if (typeof value !== 'string') return value
	return value
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&apos;/gi, "'")
		.replace(/&nbsp;/gi, ' ')
}

/**
 * Drop columns left behind by a removed feature, so an existing database
 * converges on the schema the code actually uses instead of accumulating dead
 * columns forever.
 *
 * Deliberately best-effort. `ALTER TABLE … DROP COLUMN` refuses on a column
 * that a surviving index, view or trigger still depends on, and a startup
 * migration must never be the reason the dashboard won't boot: an un-dropped
 * column is inert (nothing reads or writes it), so we log and carry on.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Record<string, string[]>} byTable  table name → columns to retire
 */
function dropRetiredColumns(db, byTable) {
	for (const [table, columns] of Object.entries(byTable)) {
		const existing = new Set(db.pragma(`table_info(${table})`).map((c) => c.name))
		for (const column of columns) {
			if (!existing.has(column)) continue
			try {
				db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`)
			} catch (err) {
				console.warn(`[db] could not drop retired column ${table}.${column}: ${err.message}`)
			}
		}
	}
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
	const dir = path.dirname(dbPath)
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true })
	}

	const db = new Database(dbPath)

	// WAL mode: concurrent reads while writes are in progress (server + sync worker).
	db.pragma('journal_mode = WAL')
	db.pragma('foreign_keys = ON')

	// ── Performance PRAGMAs ────────────────────────────────────────────────────
	// busy_timeout: retry for up to 5 s before throwing SQLITE_BUSY when two
	//   processes race to write. Without this the server throws immediately if
	//   the sync worker holds the write lock, causing "database is locked" errors
	//   on route-assignment saves, manual-order creates, etc.
	db.pragma('busy_timeout = 5000')

	// synchronous = NORMAL: safe for WAL mode (power-failure can only lose the
	//   last committed transaction, never corrupt the file), and 3-5× faster
	//   than the default FULL because it skips the expensive pre-write fsync.
	db.pragma('synchronous = NORMAL')

	// cache_size = -65536: 64 MB page cache (default is -2000 = 2 MB).
	//   Keeping the receipt + listing pages hot in memory cuts read latency for
	//   the Orders and Listings tabs from ~20 ms to <1 ms after the first load.
	db.pragma('cache_size = -65536')

	// mmap_size = 256 MB: memory-mapped I/O.  Reads bypass pread() syscalls and
	//   go straight from the OS page cache to the process address space — a
	//   meaningful win on Windows where syscall overhead is higher than on Linux.
	db.pragma('mmap_size = 268435456')

	// temp_store = MEMORY: sort / index-build temp tables live in RAM, not the
	//   temp-file directory.  Avoids extra I/O during ORDER BY / GROUP BY on the
	//   large receipts table.
	db.pragma('temp_store = MEMORY')

	// wal_autocheckpoint = 10000: checkpoint the WAL into the main DB file every
	//   10 000 pages (≈ 40 MB) rather than the default 1 000 pages.  Reduces
	//   checkpoint overhead during heavy sync cycles; the WAL stays small and
	//   readable-by-readers throughout.
	db.pragma('wal_autocheckpoint = 10000')

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
    CREATE INDEX IF NOT EXISTS idx_receipts_shop_created ON receipts(shop_id, etsy_created_at DESC);

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
    -- 4PX tracking refresh runs
    -- Durable job telemetry for the Shipping tab. A dedicated row per run makes
    -- scheduler/manual activity observable across process restarts and preserves
    -- the last useful result when no browser is open.
    -- ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS tracking_sync_runs (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger           TEXT NOT NULL DEFAULT 'scheduled',
      status            TEXT NOT NULL DEFAULT 'running',
      started_at        INTEGER NOT NULL,
      completed_at      INTEGER,
      candidate_count   INTEGER DEFAULT 0,
      checked_count     INTEGER DEFAULT 0,
      updated_count     INTEGER DEFAULT 0,
      pre_transit       INTEGER DEFAULT 0,
      in_transit        INTEGER DEFAULT 0,
      delivered         INTEGER DEFAULT 0,
      exception_count   INTEGER DEFAULT 0,
      unknown_count     INTEGER DEFAULT 0,
      error_count       INTEGER DEFAULT 0,
      backlog_remaining INTEGER DEFAULT 0,
      duration_ms       INTEGER,
      error_message     TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tracking_sync_runs_started
      ON tracking_sync_runs(started_at DESC);

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
    -- 4PX collection-appointment (揽收预约) ledger.
    --
    -- One row per pickup this dashboard asked 4PX to schedule. It is an OUTBOX,
    -- not a mirror of 4PX state: the Open Platform publishes create/cancel/print
    -- for appointments but NO query method, so 4PX's own 已分配/已揽收/已交仓
    -- progression is only visible in the portal. Everything stored here is a
    -- record of what WE submitted, which is what makes the double-book guard and
    -- the "cancel / reprint this appointment" actions possible offline.
    --
    -- The surrogate id exists because the row is written BEFORE the API call:
    -- ds.xms.api.collect.create.order takes no client idempotency key, so a lost
    -- response leaves it genuinely unknown whether a driver was dispatched. The
    -- row is inserted as 'submitting', then resolved to 'submitted' (with the
    -- collect_no 4PX returned), 'failed' (4PX definitively rejected it — nothing
    -- booked) or 'unknown' (transport died mid-flight — check the portal before
    -- rebooking). A retry can therefore never silently double-book.
    --
    -- status: 'submitting' | 'submitted' | 'failed' | 'unknown' | 'cancelled'
    -- ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS fourpx_pickup_appointments (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      collect_no      TEXT UNIQUE,        -- 4PX 预约单号 (null until it answers)
      reserve_date    TEXT NOT NULL,      -- YYYY-MM-DD exactly as sent as reserve_time
      status          TEXT NOT NULL DEFAULT 'submitting',
      contact_name    TEXT,
      contact_phone   TEXT,
      country         TEXT,
      province        TEXT,
      city            TEXT,
      district        TEXT,
      street          TEXT,
      detail_address  TEXT,
      zip_code        TEXT,
      parcel_count    INTEGER NOT NULL DEFAULT 0,  -- parcels attached at booking time
      form_url        TEXT,               -- cached 打印预约单 PDF (lazily fetched)
      error_message   TEXT,               -- why a 'failed'/'unknown' row ended there
      created_by      TEXT,
      created_at      INTEGER NOT NULL,
      resolved_at     INTEGER,            -- when the API call came back either way
      cancelled_at    INTEGER,
      cancelled_by    TEXT,
      cancel_reason   TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_fourpx_pickup_appt_date
      ON fourpx_pickup_appointments(reserve_date DESC, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_fourpx_pickup_appt_status
      ON fourpx_pickup_appointments(status, reserve_date DESC);

    -- Which sealed parcels each appointment was booked for. 4PX's appointment
    -- carries no parcel list, so this is purely OUR record of the hand-over —
    -- it is what lets the bench see "these 14 parcels are on Thursday's pickup"
    -- and stops the same parcel being counted into two open appointments.
    CREATE TABLE IF NOT EXISTS fourpx_pickup_appointment_orders (
      appointment_id INTEGER NOT NULL,
      receipt_id     INTEGER NOT NULL,
      tracking_no    TEXT,
      PRIMARY KEY (appointment_id, receipt_id)
    );

    CREATE INDEX IF NOT EXISTS idx_fourpx_pickup_appt_orders_receipt
      ON fourpx_pickup_appointment_orders(receipt_id);

    -- ─────────────────────────────────────────────
    -- Shipping alert review ledger (morning-review inbox state).
    -- One row per parcel the operator has explicitly marked reviewed. Absence of
    -- a row means "new, needs attention", which is why this is a ledger of
    -- acknowledgements rather than a flag on the receipts table.
    --
    -- severity_rank is the rank AT REVIEW TIME, so an escalation
    -- (delayed -> stuck -> disposed) re-alerts while a de-escalation (the parcel
    -- started moving again) stays quiet. Rows are pruned once a parcel leaves the
    -- abnormal set, so a later recurrence is treated as a fresh incident instead
    -- of being permanently silenced by a stale acknowledgement.
    -- ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS shipping_alert_reviews (
      receipt_id    INTEGER PRIMARY KEY,
      abnormal_kind TEXT    NOT NULL,  -- 'disposed'|'stuck'|'delayed'|'exception'
      severity_rank INTEGER NOT NULL,  -- rank at review time (see SHIPPING_ALERT_SEVERITY_RANK)
      reviewed_at   INTEGER NOT NULL,
      reviewed_by   TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_shipping_alert_reviews_reviewed
      ON shipping_alert_reviews(reviewed_at DESC);

    -- ─────────────────────────────────────────────
    -- Shipping alert incident ledger (when we LEARNED a parcel went bad).
    -- The sibling of shipping_alert_reviews: that table records the operator's
    -- acknowledgement, this one records the machine's observation. One row per
    -- open incident, created the first time a parcel appears in the abnormal set
    -- and deleted when it leaves it, so a relapse opens a genuinely new incident.
    --
    -- It exists because no receipts column can answer "since when?". A carrier
    -- back-dates its events, so a disposal discovered at 03:00 today can carry a
    -- 30-day-old event timestamp — which is exactly the row a morning reviewer
    -- would skim past as old news. first_seen_at/flagged_at are OUR clock, so
    -- the board can say "flagged 5h ago" honestly.
    --
    -- flagged_at tracks the peak: a delayed parcel that turns disposed is new
    -- work, so its flagged_at moves forward with the escalation while
    -- first_seen_at keeps the age of the underlying incident. Both are derived
    -- from the carrier check that produced the state, never from wall-clock at
    -- read time, so the same parcel dates identically however late we look.
    -- ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS shipping_alert_incidents (
      receipt_id    INTEGER PRIMARY KEY,
      first_kind    TEXT    NOT NULL,  -- 'disposed'|'stuck'|'delayed'|'exception'
      first_rank    INTEGER NOT NULL,  -- see SHIPPING_ALERT_SEVERITY_RANK
      first_seen_at INTEGER NOT NULL,
      peak_kind     TEXT    NOT NULL,  -- worst kind observed in this incident
      peak_rank     INTEGER NOT NULL,
      flagged_at    INTEGER NOT NULL   -- when it reached peak_rank
    );

    CREATE INDEX IF NOT EXISTS idx_shipping_alert_incidents_flagged
      ON shipping_alert_incidents(flagged_at DESC);

    -- ─────────────────────────────────────────────
    -- Shipping buyer-outreach log (stuck / disposed parcels).
    -- Etsy v3 has no messaging API, so this is NOT a send record — it is the
    -- operator's attestation that they pasted a message into the Etsy thread.
    -- Append-only: a stuck notice stays when the parcel later becomes disposed,
    -- so the modal can say "you already wrote about the stall; this is the
    -- disposal follow-up". The current snapshot lives on receipts
    -- (shipping_buyer_notified_*) for cheap board filters.
    -- ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS shipping_buyer_notices (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id   INTEGER NOT NULL,
      notice_kind  TEXT    NOT NULL,  -- 'stuck'|'disposed' at send time
      notified_at  INTEGER NOT NULL,
      notified_by  TEXT,
      message_body TEXT,
      tracking_no  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_shipping_buyer_notices_receipt
      ON shipping_buyer_notices(receipt_id, notified_at DESC);

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
      -- Design-region hash: the same dHash computed over only the LOWER part of
      -- the image, dropping the top camera-cutout band. The SAME case design
      -- photographed on different phone models differs mainly in that top band, so
      -- this lets re-lists of one product (across models) match when the full-image
      -- hash can't. Nullable for legacy rows until re-hashed.
      design_phash TEXT,
      sha         TEXT    NOT NULL,
      algo        TEXT,
      canonical_key TEXT,
      computed_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    -- ─────────────────────────────────────────────
    -- Operator-declared "same product" merges (human-in-the-loop override).
    -- Perceptual-hash unification only links listings whose images look alike.
    -- When two listings are physically the SAME supplier product but their Etsy
    -- photos differ (different angle, model, or promo shot), the hash can't see
    -- it. An operator records the equivalence here and the canonical reconciler
    -- honours it as a FORCED union edge — so their orders merge into one product
    -- card on the shopping route. Edges are stored undirected + de-duplicated
    -- (listing_a < listing_b); a connected component = one product.
    -- ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS product_merges (
      listing_a  INTEGER NOT NULL,
      listing_b  INTEGER NOT NULL,
      note       TEXT    DEFAULT '',
      created_by TEXT    DEFAULT '',
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      PRIMARY KEY (listing_a, listing_b),
      CHECK (listing_a < listing_b)
    );
    CREATE INDEX IF NOT EXISTS idx_product_merges_b ON product_merges(listing_b);

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
      ending_timestamp     INTEGER,
      featured_rank       INTEGER,
      shop_section_id      INTEGER,
      has_variations       INTEGER,
      should_auto_renew    INTEGER,
      image_count          INTEGER,
      processing_min       INTEGER,
      processing_max      INTEGER,
      synced_at            INTEGER DEFAULT (strftime('%s', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_listings_shop_id ON listings(shop_id);
    CREATE INDEX IF NOT EXISTS idx_listings_shop_state ON listings(shop_id, state);

    -- Historical optional API listing-metric snapshots. Open API v3 has no
    -- Stats endpoint; collection into this table is disabled unless Etsy has
    -- authorized the analytics use in writing and both config gates are on.
    -- One row per listing per UTC day.
    CREATE TABLE IF NOT EXISTS listing_metric_snapshots (
      listing_id     INTEGER NOT NULL,
      shop_id        TEXT    NOT NULL,
      captured_on   TEXT    NOT NULL,
      views          INTEGER,
      num_favorers   INTEGER,
      quantity       INTEGER,
      state          TEXT,
      PRIMARY KEY (listing_id, captured_on)
    );
    CREATE INDEX IF NOT EXISTS idx_listing_snap_shop_day
      ON listing_metric_snapshots(shop_id, captured_on);

    -- Historical optional shop-health snapshots, governed by the same API
    -- analytics authorization gates as listing_metric_snapshots.
    CREATE TABLE IF NOT EXISTS shop_health_snapshots (
      shop_id                 TEXT NOT NULL,
      captured_on             TEXT NOT NULL,
      listing_active_count   INTEGER,
      listing_inactive_count INTEGER,
      listing_sold_out_count INTEGER,
      listing_expired_count   INTEGER,
      listing_draft_count    INTEGER,
      num_favorers            INTEGER,
      transaction_sold_count  INTEGER,
      review_count           INTEGER,
      review_average          REAL,
      is_vacation             INTEGER,
      PRIMARY KEY (shop_id, captured_on)
    );

    -- Shop reviews from GET /shops/{id}/reviews. No buyer identity is stored.
    CREATE TABLE IF NOT EXISTS etsy_reviews (
      transaction_id     INTEGER PRIMARY KEY,
      shop_id            TEXT    NOT NULL,
      listing_id         INTEGER,
      rating             INTEGER,
      review             TEXT,
      language           TEXT,
      image_url          TEXT,
      created_timestamp  INTEGER,
      updated_timestamp  INTEGER,
      synced_at          INTEGER DEFAULT (strftime('%s', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_shop_created
      ON etsy_reviews(shop_id, created_timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_reviews_shop_rating
      ON etsy_reviews(shop_id, rating);

    -- Manually entered Etsy Shop Manager statistics. One row is an auditable,
    -- like-for-like comparison (current period vs an equal-length baseline).
    -- This is the default Growth data source: importing here performs zero Etsy
    -- API calls and stores no buyer/order identity or pasted source text.
    CREATE TABLE IF NOT EXISTS growth_manual_comparisons (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      import_key               TEXT    NOT NULL UNIQUE,
      shop_id                  TEXT    NOT NULL REFERENCES shops(shop_id) ON DELETE CASCADE,
      window_days              INTEGER NOT NULL,
      current_start            TEXT    NOT NULL,
      current_end              TEXT    NOT NULL,
      baseline_start           TEXT    NOT NULL,
      baseline_end             TEXT    NOT NULL,
      current_visits           INTEGER,
      baseline_visits          INTEGER,
      current_views            INTEGER,
      baseline_views           INTEGER,
      current_orders           INTEGER NOT NULL,
      baseline_orders          INTEGER NOT NULL,
      current_revenue          REAL,
      baseline_revenue         REAL,
      currency                 TEXT,
      current_conversion_rate  REAL,
      baseline_conversion_rate REAL,
      current_favorites        INTEGER,
      baseline_favorites       INTEGER,
      current_ad_spend         REAL,
      baseline_ad_spend        REAL,
      current_ad_orders        INTEGER,
      baseline_ad_orders       INTEGER,
      review_average           REAL,
      review_count             INTEGER,
      listing_active_count     INTEGER,
      listing_expired_count    INTEGER,
      listing_sold_out_count   INTEGER,
      is_vacation              INTEGER,
      note                     TEXT,
      quality_warnings         TEXT,
      imported_by              TEXT,
      imported_at              INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_growth_manual_shop_window
      ON growth_manual_comparisons(shop_id, window_days, imported_at DESC, id DESC);

    -- Optional per-listing Etsy Stats comparison, pasted manually from Shop
    -- Manager. Raw text is never stored. Rows contain aggregate listing metrics
    -- only (no buyer/order identity) and support a deeper local funnel analysis.
    CREATE TABLE IF NOT EXISTS growth_manual_listing_imports (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      import_key     TEXT    NOT NULL UNIQUE,
      shop_id        TEXT    NOT NULL REFERENCES shops(shop_id) ON DELETE CASCADE,
      window_days    INTEGER NOT NULL,
      current_start  TEXT    NOT NULL,
      current_end    TEXT    NOT NULL,
      baseline_start TEXT    NOT NULL,
      baseline_end   TEXT    NOT NULL,
      currency       TEXT,
      note           TEXT,
      warnings_json  TEXT,
      imported_by    TEXT,
      imported_at    INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_growth_listing_import_shop
      ON growth_manual_listing_imports(shop_id, window_days, imported_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS growth_manual_listing_rows (
      import_id          INTEGER NOT NULL REFERENCES growth_manual_listing_imports(id) ON DELETE CASCADE,
      row_key            TEXT    NOT NULL,
      listing_id         TEXT,
      title              TEXT    NOT NULL,
      current_views      INTEGER NOT NULL,
      baseline_views     INTEGER NOT NULL,
      current_favorites  INTEGER,
      baseline_favorites INTEGER,
      current_orders     INTEGER NOT NULL,
      baseline_orders    INTEGER NOT NULL,
      current_revenue    REAL,
      baseline_revenue   REAL,
      PRIMARY KEY (import_id, row_key)
    );
    CREATE INDEX IF NOT EXISTS idx_growth_listing_rows_listing
      ON growth_manual_listing_rows(listing_id);

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
    CREATE INDEX IF NOT EXISTS idx_events_listing_type_time
      ON events(listing_id, event_type, created_at DESC);

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
    --   Every sidecar shares the companion manual ORDER's negative
    --   receipt_id (the receipts row). One buyer order can therefore
    --   carry several products — the same shape as a real Etsy receipt
    --   with multiple transactions. Assignments / status / exclude stay
    --   keyed by (receipt_id, item_key) per line.
    --
    --   • Catalog picks  carry a real listing_id + image_url (CDN) so the
    --     supplier match and route image pipeline work unchanged.
    --   • Custom products store uploaded bytes in image_data/image_mime and
    --     are served via GET /api/route/manual-image/:id.
    -- ─────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS route_manual_items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id  INTEGER NOT NULL,
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
    CREATE INDEX IF NOT EXISTS idx_route_manual_items_receipt ON route_manual_items(receipt_id);

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
      status      TEXT    NOT NULL DEFAULT 'active',
      retired_at  INTEGER,
      retired_reason TEXT DEFAULT '',
      retired_by  TEXT    DEFAULT '',
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
      policy_confirmed_at INTEGER,                      -- epoch of explicit Creativity/IP/photo attestation
      policy_confirmed_by TEXT,                         -- dashboard user who made the attestation
      policy_attestation TEXT,                          -- versioned JSON booleans; never license documents/secrets
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
    CREATE INDEX IF NOT EXISTS idx_order_issues_receipt_open
      ON order_issues(receipt_id) WHERE status = 'open';

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

    -- ─────────────────────────────────────────────────────────────────
    -- listing_variation_images — Etsy-native Styles → photo mapping.
    --
    -- GET /listings/{id}/variation-images returns {value, image_id} per
    -- style (e.g. "Case 1 + Grip 1" → image 7). Orders only carry the
    -- style string, so we join image_id to the listing's Images catalog
    -- at sync time and cache the CDN URL here. Operator Fix Image
    -- (listing_style_images) still wins when present.
    --
    -- listing_variation_image_state records the last successful fetch,
    -- including listings with ZERO mappings, so we do not re-hit Etsy
    -- every cycle for listings that have no variation photos.
    -- ─────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS listing_variation_images (
      listing_id  INTEGER NOT NULL,
      style_key   TEXT    NOT NULL,
      style_value TEXT    NOT NULL DEFAULT '',
      image_id    INTEGER,
      url         TEXT    NOT NULL,
      value_id    INTEGER,
      property_id INTEGER,
      cached_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      PRIMARY KEY (listing_id, style_key)
    );
    CREATE INDEX IF NOT EXISTS idx_listing_variation_images_listing
      ON listing_variation_images(listing_id);

    CREATE TABLE IF NOT EXISTS listing_variation_image_state (
      listing_id    INTEGER PRIMARY KEY,
      fetched_at    INTEGER NOT NULL,
      mapping_count INTEGER NOT NULL DEFAULT 0
    );

    -- ─────────────────────────────────────────────────────────────────
    -- SOURCING LIBRARY (design intake from WeChat/QQ suppliers)
    --
    -- Distinct from supplier_directory (which is the physical shopping-mall
    -- stall map used by the in-person Shopping Route). This is the back-office
    -- registry the owner + employee use to catalogue the *design* suppliers who
    -- publish zipped product folders on WeChat / QQ, and to file each downloaded
    -- zip against the supplier it came from and the product type it contains.
    --
    -- sourcing_suppliers — the master supplier list (name + location + the chat
    --   handles the employee needs to reach them). name is UNIQUE (case-folded
    --   uniqueness is enforced in the accessor) so a supplier is never entered
    --   twice. Deleting a supplier cascades to its packages (files removed by
    --   the route layer, which owns the on-disk store).
    -- ─────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS sourcing_suppliers (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL,
      location   TEXT    NOT NULL DEFAULT '',
      wechat     TEXT    NOT NULL DEFAULT '',
      qq         TEXT    NOT NULL DEFAULT '',
      notes      TEXT    NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sourcing_suppliers_name ON sourcing_suppliers(name COLLATE NOCASE);

    -- sourcing_packages — one row per uploaded zip folder of product designs.
    --   The zip BYTES live on disk under <data>/sourcing-library/<supplierId>/
    --   <category>/<stored_name> (zips are large + binary — never a good fit for
    --   a SQLite BLOB); this table is the searchable, sortable index over them.
    --   category is constrained to the three product types the shop sells so the
    --   library can be filtered by phone case / grip / charm. sha256 lets us
    --   detect a byte-identical re-upload; status tracks the intake workflow.
    CREATE TABLE IF NOT EXISTS sourcing_packages (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id       INTEGER NOT NULL REFERENCES sourcing_suppliers(id) ON DELETE CASCADE,
      category          TEXT    NOT NULL,           -- 'phone_case' | 'grip' | 'charm'
      title             TEXT    NOT NULL DEFAULT '',
      original_filename TEXT    NOT NULL DEFAULT '',
      stored_name       TEXT    NOT NULL,           -- unique on-disk file name (never trusted from client)
      size_bytes        INTEGER NOT NULL DEFAULT 0,
      sha256            TEXT    NOT NULL DEFAULT '',
      status            TEXT    NOT NULL DEFAULT 'new', -- new | in_progress | listed | archived
      notes             TEXT    NOT NULL DEFAULT '',
      uploaded_by       TEXT    NOT NULL DEFAULT '',
      created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at        INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sourcing_packages_supplier ON sourcing_packages(supplier_id);
    CREATE INDEX IF NOT EXISTS idx_sourcing_packages_category ON sourcing_packages(category);
  `)

	// Durable "this order still owes Etsy a completion" ledger. Its DDL lives with
	// the state machine that maintains it (src/orders/etsy-completion.js) so the
	// table and its semantics can never drift apart.
	etsyCompletion.ensureSchema(db)
	// Human attestations for the Monday-to-Sunday operations checklist. The
	// feature is local-only: this schema has no Etsy client or token dependency.
	operationsChecklist.ensureSchema(db)

	// ── Migrations ────────────────────────────────────────────────────────────
	// SQLite doesn't support ALTER TABLE ADD COLUMN IF NOT EXISTS, so we check
	// the column list manually and only add if missing.

	const syncLogCols = db.pragma('table_info(sync_log)').map((c) => c.name)
	if (!syncLogCols.includes('egress_ip')) {
		db.exec(`ALTER TABLE sync_log ADD COLUMN egress_ip TEXT`)
	}

	// Persisted AI-drafted buyer message + its timestamp on a fulfilment issue, so
	// an operator who generates a message once sees the same copy when they reopen
	// the issue (instead of losing it or regenerating a different one every time).
	const orderIssueCols = db.pragma('table_info(order_issues)').map((c) => c.name)
	if (!orderIssueCols.includes('buyer_message')) {
		db.exec(`ALTER TABLE order_issues ADD COLUMN buyer_message TEXT`)
	}
	if (!orderIssueCols.includes('buyer_message_at')) {
		db.exec(`ALTER TABLE order_issues ADD COLUMN buyer_message_at INTEGER`)
	}
	// Provenance of an issue: 'shop' = auto-flagged from Shopping Mode (a shopper
	// set a component to Discontinued / No-model), else 'manual' (operator). Lets
	// the auto-flag be safely reverted without ever clobbering operator work.
	if (!orderIssueCols.includes('source')) {
		db.exec(`ALTER TABLE order_issues ADD COLUMN source TEXT`)
	}

	// Persisted active-listing count per shop (Overview "Active Listings" column).
	// Cached here so the Overview renders a real number instantly and reliably,
	// independent of any live Etsy round-trip. Refreshed on every sync via getShop.
	const shopCols = db.pragma('table_info(shops)').map((c) => c.name)
	if (!shopCols.includes('listing_active_count')) {
		db.exec(`ALTER TABLE shops ADD COLUMN listing_active_count INTEGER`)
	}
	if (!shopCols.includes('listing_count_synced_at')) {
		db.exec(`ALTER TABLE shops ADD COLUMN listing_count_synced_at INTEGER`)
	}
	// High-water mark (max ledger create_date synced) for incremental earnings sync.
	if (!shopCols.includes('ledger_synced_at')) {
		db.exec(`ALTER TABLE shops ADD COLUMN ledger_synced_at INTEGER`)
	}
	// Shop health used by the Growth tab. GET /shops/{id} already runs on a
	// 6-hour TTL; these columns persist the ranking-relevant fields so diagnosis
	// never needs a live Etsy round-trip on page load.
	const shopHealthCols = [
		['num_favorers', 'INTEGER'],
		['transaction_sold_count', 'INTEGER'],
		['review_count', 'INTEGER'],
		['review_average', 'REAL'],
		['is_vacation', 'INTEGER'],
		['catalog_health_synced_at', 'INTEGER'],
		['reviews_synced_at', 'INTEGER'],
	]
	for (const [name, type] of shopHealthCols) {
		if (!shopCols.includes(name)) db.exec(`ALTER TABLE shops ADD COLUMN ${name} ${type}`)
	}

	const listingCols = db.pragma('table_info(listings)').map((c) => c.name)
	const listingHealthCols = [
		['ending_timestamp', 'INTEGER'],
		['featured_rank', 'INTEGER'],
		['shop_section_id', 'INTEGER'],
		['has_variations', 'INTEGER'],
		['should_auto_renew', 'INTEGER'],
		['image_count', 'INTEGER'],
		['processing_min', 'INTEGER'],
		['processing_max', 'INTEGER'],
	]
	for (const [name, type] of listingHealthCols) {
		if (!listingCols.includes(name)) db.exec(`ALTER TABLE listings ADD COLUMN ${name} ${type}`)
	}
	db.exec(`CREATE INDEX IF NOT EXISTS idx_listings_shop_state ON listings(shop_id, state)`)
	db.exec(`
    CREATE TABLE IF NOT EXISTS listing_metric_snapshots (
      listing_id     INTEGER NOT NULL,
      shop_id        TEXT    NOT NULL,
      captured_on    TEXT    NOT NULL,
      views          INTEGER,
      num_favorers   INTEGER,
      quantity       INTEGER,
      state          TEXT,
      PRIMARY KEY (listing_id, captured_on)
    )
  `)
	db.exec(`CREATE INDEX IF NOT EXISTS idx_listing_snap_shop_day ON listing_metric_snapshots(shop_id, captured_on)`)
	db.exec(`
    CREATE TABLE IF NOT EXISTS shop_health_snapshots (
      shop_id                 TEXT NOT NULL,
      captured_on             TEXT NOT NULL,
      listing_active_count    INTEGER,
      listing_inactive_count  INTEGER,
      listing_sold_out_count INTEGER,
      listing_expired_count   INTEGER,
      listing_draft_count     INTEGER,
      num_favorers            INTEGER,
      transaction_sold_count  INTEGER,
      review_count            INTEGER,
      review_average          REAL,
      is_vacation             INTEGER,
      PRIMARY KEY (shop_id, captured_on)
    )
  `)
	db.exec(`
    CREATE TABLE IF NOT EXISTS etsy_reviews (
      transaction_id     INTEGER PRIMARY KEY,
      shop_id            TEXT    NOT NULL,
      listing_id         INTEGER,
      rating             INTEGER,
      review             TEXT,
      language           TEXT,
      image_url          TEXT,
      created_timestamp  INTEGER,
      updated_timestamp  INTEGER,
      synced_at          INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `)
	db.exec(`CREATE INDEX IF NOT EXISTS idx_reviews_shop_created ON etsy_reviews(shop_id, created_timestamp DESC)`)
	db.exec(`CREATE INDEX IF NOT EXISTS idx_reviews_shop_rating ON etsy_reviews(shop_id, rating)`)
	db.exec(`
    CREATE TABLE IF NOT EXISTS growth_manual_comparisons (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      import_key               TEXT    NOT NULL UNIQUE,
      shop_id                  TEXT    NOT NULL REFERENCES shops(shop_id) ON DELETE CASCADE,
      window_days              INTEGER NOT NULL,
      current_start            TEXT    NOT NULL,
      current_end              TEXT    NOT NULL,
      baseline_start           TEXT    NOT NULL,
      baseline_end             TEXT    NOT NULL,
      current_visits           INTEGER,
      baseline_visits          INTEGER,
      current_views            INTEGER,
      baseline_views           INTEGER,
      current_orders           INTEGER NOT NULL,
      baseline_orders          INTEGER NOT NULL,
      current_revenue          REAL,
      baseline_revenue         REAL,
      currency                 TEXT,
      current_conversion_rate  REAL,
      baseline_conversion_rate REAL,
      current_favorites        INTEGER,
      baseline_favorites       INTEGER,
      current_ad_spend         REAL,
      baseline_ad_spend        REAL,
      current_ad_orders        INTEGER,
      baseline_ad_orders       INTEGER,
      review_average           REAL,
      review_count             INTEGER,
      listing_active_count     INTEGER,
      listing_expired_count    INTEGER,
      listing_sold_out_count   INTEGER,
      is_vacation              INTEGER,
      note                     TEXT,
      quality_warnings         TEXT,
      imported_by              TEXT,
      imported_at              INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )
  `)
	db.exec(`CREATE INDEX IF NOT EXISTS idx_growth_manual_shop_window ON growth_manual_comparisons(shop_id, window_days, imported_at DESC, id DESC)`)
	db.exec(`
    CREATE TABLE IF NOT EXISTS growth_manual_listing_imports (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      import_key     TEXT    NOT NULL UNIQUE,
      shop_id        TEXT    NOT NULL REFERENCES shops(shop_id) ON DELETE CASCADE,
      window_days    INTEGER NOT NULL,
      current_start  TEXT    NOT NULL,
      current_end    TEXT    NOT NULL,
      baseline_start TEXT    NOT NULL,
      baseline_end   TEXT    NOT NULL,
      currency       TEXT,
      note           TEXT,
      warnings_json  TEXT,
      imported_by    TEXT,
      imported_at    INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )
  `)
	db.exec(`CREATE INDEX IF NOT EXISTS idx_growth_listing_import_shop ON growth_manual_listing_imports(shop_id, window_days, imported_at DESC, id DESC)`)
	db.exec(`
    CREATE TABLE IF NOT EXISTS growth_manual_listing_rows (
      import_id          INTEGER NOT NULL REFERENCES growth_manual_listing_imports(id) ON DELETE CASCADE,
      row_key            TEXT    NOT NULL,
      listing_id         TEXT,
      title              TEXT    NOT NULL,
      current_views      INTEGER NOT NULL,
      baseline_views     INTEGER NOT NULL,
      current_favorites  INTEGER,
      baseline_favorites INTEGER,
      current_orders     INTEGER NOT NULL,
      baseline_orders    INTEGER NOT NULL,
      current_revenue    REAL,
      baseline_revenue   REAL,
      PRIMARY KEY (import_id, row_key)
    )
  `)
	db.exec(`CREATE INDEX IF NOT EXISTS idx_growth_listing_rows_listing ON growth_manual_listing_rows(listing_id)`)

	// Shipping address + product columns on receipts — added after initial release.
	const receiptCols = db.pragma('table_info(receipts)').map((c) => c.name)
	const newReceiptCols = [
		['shipping_first_line', 'TEXT'],
		['shipping_second_line', 'TEXT'],
		['shipping_city', 'TEXT'],
		['shipping_state', 'TEXT'],
		['shipping_zip', 'TEXT'],
		['shipping_country_iso', 'TEXT'],
		['first_product_title', 'TEXT'],
		['first_listing_id', 'INTEGER'],
		['first_quantity', 'INTEGER'],
		['first_ship_by', 'INTEGER'],
		['first_variations', 'TEXT'],
		['all_transactions', 'TEXT'],
		['formatted_address', 'TEXT'],
		// App-level team note — stored locally only, not synced to Etsy
		['team_note', 'TEXT'],
		// Shipment tracking (extracted from receipt.shipments[0])
		['tracking_code', 'TEXT'],
		['carrier_name', 'TEXT'],
		// Legacy column — was_shipped does not exist in Etsy v3 API (ShopReceiptShipment schema
		// has no such field). This column is always 0 and retained only for schema compatibility.
		['shipment_was_shipped', 'INTEGER'],
		// Exact Unix epoch when Etsy sent the buyer the shipment notification =
		// the moment the shipping label was created. Sourced from
		// shipments[0].shipment_notification_timestamp in the Etsy v3 API response.
		// Used as the authoritative "label created at" timestamp for pre-transit detection.
		['shipment_notified_at', 'INTEGER'],
		// Unix epoch when the carrier (e.g. 4PX) confirmed receipt of the package (first scan).
		// NULL = package not yet confirmed by carrier = genuinely Pre-transit.
		// Populated by the carrier tracking checker (src/tracking/checker.js) called from
		// the sync worker. The pre-transit filter uses carrier_confirmed_at IS NULL as its
		// primary signal — once this is set, the order moves from Pre-transit to In-transit.
		['carrier_confirmed_at', 'INTEGER'],
		// Unix epoch when we last successfully called the carrier tracking API for this receipt.
		// Used to avoid re-checking too frequently (rate limiting). NULL = never checked.
		// Re-checked every TRACKING_RECHECK_HOURS (see sync worker) once confirmed_at is set.
		['tracking_checked_at', 'INTEGER'],

		// ── 4PX Order Creation Integration ────────────────────────────────────────
		// Populated by the dashboard's "Create 4PX Shipment" feature (Pass via /api/4px/create-order).
		// NULL on all columns = no 4PX order has been created through the dashboard yet.

		// 4PX internal consignment number (ds_consignment_no from ds.xms.order.create response).
		// Used for label retrieval (ds.xms.label.get) and order cancellation (ds.xms.order.cancel).
		['fourpx_consignment_no', 'TEXT'],
		// Deterministic customer reference used to reconcile an ambiguous create.
		['fourpx_ref_no', 'TEXT'],
		// 4PX public tracking number (4px_tracking_no) — this is what gets shared with the buyer
		// and what's used for tracking queries. Distinct from ds_consignment_no.
		['fourpx_tracking_no', 'TEXT'],
		// URL to the shipping label PDF/IMG as returned by ds.xms.label.get.
		// Cached here to avoid re-calling the 4PX label API on every page load.
		['fourpx_label_url', 'TEXT'],
		// Lifecycle status of the 4PX order created through our dashboard.
		// Values: 'created' | 'label_fetched' | 'cancelled' | 'error'
		['fourpx_order_status', 'TEXT'],
		// Unix epoch when the 4PX order was created via the dashboard. Immutable once set.
		['fourpx_created_at', 'INTEGER'],

		// ── 4PX Shipping Cost (freight) ───────────────────────────────────────────
		// Populated by the freight sync pass (src/workers/sync.js → runFreightSyncPass)
		// and the on-demand endpoints, which call ds.xms.order.getFreight for orders
		// that have a 4PX consignment. 4PX only finalizes (bills) the freight AFTER it
		// physically weighs the parcel, so the cost has a lifecycle:
		//   NULL/'pending' = consignment exists but 4PX hasn't computed a charge yet.
		//   'billed'       = 4PX returned a real freight charge (authoritative cost).
		//   'error'        = the last freight query failed (see fourpx_freight_fetched_at).

		// Total billed freight charge — the headline shipping cost for this order.
		['fourpx_freight_amount', 'REAL'],
		// ISO currency of fourpx_freight_amount as returned by 4PX (e.g. 'USD', 'CNY').
		['fourpx_freight_currency', 'TEXT'],
		// Chargeable/billed weight 4PX used to compute the freight, in GRAMS (best-effort).
		['fourpx_billed_weight_g', 'INTEGER'],
		// JSON array of the itemized fee breakdown ([{type,name,amount,currency}, …]).
		// Stored so the UI can show "freight + fuel + remote-area surcharge" detail.
		['fourpx_freight_breakdown', 'TEXT'],
		// Cost lifecycle status:
		//   'pending'   = consignment exists, no cost resolved yet.
		//   'estimated' = live rate-card cost from ds.xms.estimated_cost.get (available
		//                 immediately; what the 4PX portal shows at measurement time).
		//   'billed'    = truly-settled cost from ds.xms.order.getFreight (authoritative;
		//                 supersedes an estimate once 4PX financially settles the order).
		//   'error'     = the last cost query failed.
		['fourpx_freight_status', 'TEXT'],
		// Unix epoch of the last successful (or attempted) freight query for this order.
		// Used to rate-limit re-queries in the sync worker. NULL = never queried.
		['fourpx_freight_fetched_at', 'INTEGER'],
		// The logistics_product_code used for this shipment (e.g. 'S5058'), captured at
		// order-creation time. Needed to price the order via ds.xms.estimated_cost.get.
		['fourpx_product_code', 'TEXT'],
		// The DECLARED parcel weight (grams) sent at order-creation time. Used as the
		// weight input to the estimated-cost lookup until 4PX returns a billed charge weight.
		['fourpx_weight_g', 'INTEGER'],

		// ── 4PX parcel tracking snapshot (Shipping tab) ───────────────────────────
		// Cached by the tracking sync pass so the Shipping tab can list every parcel's
		// live status (and flag "stuck" ones) without making a 4PX API call per row.
		// The authoritative, full event history is fetched on demand via /api/4px/track.

		// Canonical lifecycle status from the carrier feed:
		//   'pre_transit' | 'in_transit' | 'delivered' | 'exception' | 'unknown'
		['tracking_status', 'TEXT'],
		// Human-readable description of the MOST RECENT tracking event (e.g.
		// "Customs check" / "Released from customs: customs cleared.").
		['tracking_last_event', 'TEXT'],
		// Unix epoch of the most recent tracking event. The Shipping tab uses
		// (now - this) to compute "days since last update" and flag stuck parcels.
		['tracking_last_event_at', 'INTEGER'],
		// Location string of the most recent event (e.g. "LAX", "Nancheng, China").
		['tracking_last_location', 'TEXT'],
		// Unix epoch when the parcel was delivered (terminal). NULL until delivered.
		['tracking_delivered_at', 'INTEGER'],
		// Stuck/delay verdict from analyzeTrackingHealth (which inspects the FULL event
		// history: customs loops, repeated scans, no-movement, long transit). Persisted
		// so the Shipping tab's "stuck" filter/cards match the timeline modal exactly,
		// since the full-history heuristics can't be re-derived from a single SQL row.
		//   'ok' | 'warning' | 'critical'   (NULL = not yet analysed)
		['tracking_health', 'TEXT'],
		// Primary human-readable reason behind a non-ok health verdict (for the list
		// tooltip), e.g. "7 customs scans with no delivery — likely held at customs."
		['tracking_health_reason', 'TEXT'],
		// Explicit disposal verdict from the shared tracking detector. Do not infer
		// this with broad SQL text matching ("disposition" is not "disposal").
		['tracking_is_disposed', 'INTEGER DEFAULT 0'],
		// Carrier-check failure state. Successful snapshots clear all four fields.
		// Transient failures keep tracking_checked_at honest (an attempt happened) but
		// use tracking_next_check_at for a shorter exponential retry cadence.
		['tracking_last_error', 'TEXT'],
		['tracking_error_at', 'INTEGER'],
		['tracking_error_count', 'INTEGER DEFAULT 0'],
		['tracking_next_check_at', 'INTEGER'],

		// ── Shipping claim / compensation notes (4PX abnormal parcels) ────────────
		// Dedicated to the Shipping tab — intentionally SEPARATE from receipts.team_note
		// (Orders/Route packing notes). Used to record evidence and claim state while
		// escalating disposed / stuck / exception parcels to 4PX for compensation.
		//
		// shipping_claim_status:
		//   NULL | 'none'     = not yet working a claim
		//   'investigating'   = reviewing timeline / gathering evidence
		//   'claimed'         = filed with 4PX (awaiting outcome)
		//   'compensated'     = 4PX paid / credited
		//   'closed'          = abandoned / not eligible / resolved without payout
		// Preserved across Etsy re-syncs (never written by upsertReceipt).
		['shipping_claim_note', 'TEXT'],
		['shipping_claim_status', 'TEXT'],
		['shipping_claim_updated_at', 'INTEGER'],
		// Snapshot of the latest Etsy buyer-outreach for a stuck/disposed parcel.
		// History is shipping_buyer_notices; these columns power the board filter.
		// Cleared when a brand-new incident opens (relapse), so a previous send
		// cannot hide a new stall. Not written by upsertReceipt.
		['shipping_buyer_notified_at', 'INTEGER'],
		['shipping_buyer_notice_kind', 'TEXT'],
		['shipping_buyer_notified_by', 'TEXT'],
		['shipping_buyer_notice_body', 'TEXT'],

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
		['archived_at', 'INTEGER'],
		// Optional free-text reason captured at archive time, e.g.
		// "wrong tracking number — parcel already delivered". Cleared on restore.
		['archive_reason', 'TEXT'],

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
		['needs_purchase_at', 'INTEGER'],
		// Optional free-text note captured when flagging, e.g. "switched buyer to design B".
		['needs_purchase_note', 'TEXT'],

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
		['packaged_at', 'INTEGER'],

		// ── Purchase-completion cohort stamp ────────────────────────────────────────
		// Unix epoch marking the moment this order became FULLY purchased (its last
		// outstanding component/line flipped to Purchased so `orderHasOutstanding`
		// went false). This is the "you finished shopping for this order" timestamp —
		// distinct from packaged_at (packing) and shipment_notified_at (shipping).
		//
		// WHY: the shopper buys an order's items on one trip; the packer packs them the
		// NEXT morning. This stamp lets the packing queue surface exactly "the orders I
		// shopped yesterday / on my last trip" (see the `purchased_cohort` filter),
		// instead of an undifferentiated pile of everything ever purchased — so a
		// shopped-but-never-packed order can't silently hide in the backlog.
		//
		// Re-stamped every time an order transitions outstanding → fully-purchased
		// (a returned/out-of-stock line that gets re-bought updates it), and cleared
		// back to NULL if the order falls back to outstanding. Preserved across Etsy
		// re-syncs (never written by upsertReceipt).
		['purchase_completed_at', 'INTEGER'],

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
		['source', "TEXT DEFAULT 'etsy'"],

		// ── Buyer-purchased shipping upgrade (Express) ────────────────────────────
		// Etsy attaches a shipping upgrade to a LISTING's shipping profile, so the
		// signal arrives per transaction as `transactions[].shipping_upgrade` — the
		// seller's own name for the option the buyer paid extra for ("Express"),
		// and null for ordinary shipping. These columns are the receipt-level rollup
		// computed by src/orders/shipping-upgrade.js, which is also what decides the
		// badge, the filter, the sort and the 4PX lane recommendation — one module,
		// so those four can never disagree.
		//
		// Per-LINE detail additionally lives inside all_transactions (each entry
		// gains shipping_upgrade / shipping_method), because a multi-line order can
		// have one upgraded line and one standard line.

		// Headline upgrade name exactly as Etsy reported it, e.g. "Express".
		// Distinct names on a multi-line order are joined with ' · '. NULL = the
		// buyer took standard shipping (the overwhelming majority of orders).
		['shipping_upgrade', 'TEXT'],
		// Etsy's `shipping_method` for the same lines. Populated on the same
		// occasions as shipping_upgrade (it is null for standard shipping too) and
		// kept because it names the actual service the buyer was shown at checkout.
		['shipping_method', 'TEXT'],
		// Classified tier of the strongest upgrade on the order:
		//   'express' | 'priority' | 'expedited' | 'service'   (NULL = no upgrade)
		// 'service' is a paid upgrade that is NOT about speed (insurance, signature).
		['shipping_upgrade_tier', 'TEXT'],
		// The one boolean fulfilment acts on: the buyer paid for SPEED, so this
		// parcel jumps the picking/packing queue and must travel on an express lane.
		// Stored (rather than derived in every query) so it can be indexed, sorted
		// and filtered in SQL, and so a card always agrees with the row the filter
		// returned. 0 for standard shipping AND for non-speed upgrades.
		['is_expedited', 'INTEGER DEFAULT 0'],
	]
	const addedCols = []
	for (const [col, type] of newReceiptCols) {
		if (!receiptCols.includes(col)) {
			db.exec(`ALTER TABLE receipts ADD COLUMN ${col} ${type}`)
			addedCols.push(col)
		}
	}

	// Backfill the new columns from raw_json for all existing receipts.
	if (addedCols.length > 0) {
		const rows = db.prepare('SELECT receipt_id, raw_json FROM receipts WHERE raw_json IS NOT NULL').all()
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
    `)
		const backfill = db.transaction(() => {
			for (const row of rows) {
				try {
					const r = JSON.parse(row.raw_json)
					const txs = Array.isArray(r.transactions) ? r.transactions : []
					const tx = txs[0] ?? null
					const ship = Array.isArray(r.shipments) ? r.shipments[0] : null
					stmt.run({
						receipt_id: row.receipt_id,
						first_line: r.first_line ?? null,
						second_line: r.second_line ?? null,
						city: r.city ?? null,
						state: r.state ?? null,
						zip: r.zip ?? null,
						country_iso: r.country_iso ?? null,
						title: tx?.title ?? null,
						listing_id: tx?.listing_id ?? null,
						quantity: tx?.quantity ?? null,
						ship_by: tx?.expected_ship_date ?? null,
						variations: tx?.variations ? JSON.stringify(tx.variations) : null,
						all_transactions:
							txs.length > 0
								? JSON.stringify(
										txs.map((t) => ({
											listing_id: t.listing_id ?? null,
											title: t.title ?? null,
											quantity: t.quantity ?? null,
											expected_ship_date: t.expected_ship_date ?? null,
											variations: t.variations ?? [],
										})),
									)
								: null,
						formatted_address: r.formatted_address ?? null,
						tracking_code: ship?.tracking_code ?? null,
						carrier_name: ship?.carrier_name ?? null,
						// was_shipped does not exist in Etsy v3 API; retained for schema compatibility only
						shipment_was_shipped: ship != null ? (ship.was_shipped ? 1 : 0) : null,
						shipment_notified_at: ship?.shipment_notification_timestamp ?? null,
					})
				} catch {
					/* skip malformed rows */
				}
			}
		})
		backfill()
	}

	// Buyer-purchased shipping upgrades are recoverable for the WHOLE order
	// history, because every synced receipt keeps its raw Etsy payload. Run the
	// dedicated backfill only when one of those columns was just introduced, so
	// an existing install gets its express orders flagged on the very first boot
	// after this upgrade instead of waiting for each order to be re-synced.
	if (addedCols.some((c) => SHIPPING_UPGRADE_COLUMNS.includes(c))) {
		backfillShippingUpgrades(db)
	}

	// Create the shipment_notified_at index now that the column is guaranteed to exist
	// (either it was just added above, or it was already in the schema from a previous run).
	db.exec(`
    CREATE INDEX IF NOT EXISTS idx_receipts_notified_at       ON receipts(shipment_notified_at DESC);
    CREATE INDEX IF NOT EXISTS idx_receipts_carrier_confirmed ON receipts(carrier_confirmed_at);
    CREATE INDEX IF NOT EXISTS idx_receipts_tracking_checked  ON receipts(tracking_checked_at);
    CREATE INDEX IF NOT EXISTS idx_receipts_tracking_code     ON receipts(tracking_code);
    CREATE INDEX IF NOT EXISTS idx_receipts_fourpx_tracking   ON receipts(fourpx_tracking_no);
    CREATE INDEX IF NOT EXISTS idx_receipts_tracking_poll
      ON receipts(tracking_delivered_at, tracking_checked_at, carrier_confirmed_at, tracking_health);
    CREATE INDEX IF NOT EXISTS idx_receipts_tracking_disposed ON receipts(tracking_is_disposed);
    CREATE INDEX IF NOT EXISTS idx_receipts_tracking_next_check ON receipts(tracking_next_check_at);
    CREATE INDEX IF NOT EXISTS idx_receipts_fourpx_consignment ON receipts(fourpx_consignment_no);
    CREATE INDEX IF NOT EXISTS idx_receipts_archived_at       ON receipts(archived_at);
    CREATE INDEX IF NOT EXISTS idx_receipts_needs_purchase    ON receipts(needs_purchase_at);
    CREATE INDEX IF NOT EXISTS idx_receipts_packaged_at       ON receipts(packaged_at);
    CREATE INDEX IF NOT EXISTS idx_receipts_purchase_completed ON receipts(purchase_completed_at);
    CREATE INDEX IF NOT EXISTS idx_receipts_source            ON receipts(source);
    -- PARTIAL index: express orders are a small minority of the table, and every
    -- query that touches this column is looking for the ones that ARE expedited
    -- (the badge rollup, the Express filter, the "express first" sort). Indexing
    -- only those rows keeps it tiny while still answering all three.
    CREATE INDEX IF NOT EXISTS idx_receipts_expedited
      ON receipts(is_expedited) WHERE is_expedited = 1
  `)

	// If shipment_notified_at already exists but wasn't populated during the backfill
	// (e.g., column existed but was NULL), backfill it from raw_json now.
	// Note: the LIKE '%shipment_notification_timestamp%' was removed — it caused a
	// full table scan on raw_json (O(n) text match) on every startup.  The index on
	// shipment_notified_at + is_shipped is fast enough; the inner loop only parses
	// JSON for rows that actually need a value set, so there's no extra overhead.
	const nullNotified = db
		.prepare(
			`
    SELECT COUNT(*) as cnt FROM receipts
    WHERE shipment_notified_at IS NULL AND is_shipped = 1
  `,
		)
		.get()
	if (nullNotified.cnt > 0) {
		const rows = db
			.prepare(
				`
      SELECT receipt_id, raw_json FROM receipts
      WHERE shipment_notified_at IS NULL AND is_shipped = 1 AND raw_json IS NOT NULL
    `,
			)
			.all()
		const upd = db.prepare(`
      UPDATE receipts SET shipment_notified_at = ? WHERE receipt_id = ?
    `)
		const fill = db.transaction(() => {
			for (const row of rows) {
				try {
					const raw = JSON.parse(row.raw_json)
					const ship = Array.isArray(raw.shipments) ? raw.shipments[0] : null
					const ts = ship?.shipment_notification_timestamp ?? null
					if (ts) upd.run(ts, row.receipt_id)
				} catch {
					/* skip */
				}
			}
		})
		fill()
		console.log(`[db] Backfilled shipment_notified_at for ${nullNotified.cnt} receipt(s)`)
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
	const repaired = db
		.prepare(
			`
    UPDATE receipts
    SET shipment_notified_at = COALESCE(fourpx_created_at, etsy_updated_at, synced_at)
    WHERE shipment_notified_at IS NULL
      AND is_shipped = 1
      AND tracking_code IS NOT NULL
      AND COALESCE(fourpx_created_at, etsy_updated_at, synced_at) IS NOT NULL
  `,
		)
		.run()
	if (repaired.changes > 0) {
		console.log(`[db] Repaired shipment_notified_at for ${repaired.changes} locally-completed order(s) (restores Ready-to-pack/Pre-transit)`)
	}

	// ── route_assignments migrations ─────────────────────────────────────────
	// Add new columns that weren't in the original CREATE TABLE.
	const routeCols = db.pragma('table_info(route_assignments)').map((c) => c.name)
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
		// ── Verification (two-person integrity) ─────────────────────────────────────
		// "Purchased" is asserted by the SHOPPER in the field; "verified" is confirmed
		// by the PACKER the next morning when the physical item is actually in hand.
		// Keeping them separate turns the morning check into a real audit gate (the
		// packing queue can require verified, not merely purchased) and records WHO
		// confirmed it. verified_at = unix epoch of the confirmation (NULL = not yet
		// verified); verified_by = the confirming operator's username.
		['verified_at', 'INTEGER', 'NULL'],
		['verified_by', 'TEXT', "''"],
	]
	for (const [col, type, dflt] of newRouteCols) {
		if (!routeCols.includes(col)) {
			db.exec(`ALTER TABLE route_assignments ADD COLUMN ${col} ${type} DEFAULT ${dflt}`)
		}
	}

	// receipt_item_purchase — mirror the verification columns onto no-component
	// lines (which track a single binary needs_purchase flag) so the verify gate is
	// uniform across every line-item, however its purchase state is modelled.
	const ripCols = db.pragma('table_info(receipt_item_purchase)').map((c) => c.name)
	if (!ripCols.includes('verified_at')) db.exec('ALTER TABLE receipt_item_purchase ADD COLUMN verified_at INTEGER')
	if (!ripCols.includes('verified_by')) db.exec("ALTER TABLE receipt_item_purchase ADD COLUMN verified_by TEXT DEFAULT ''")

	// sort_order for supplier_directory — preserves the Excel row order
	const supDirCols = db.pragma('table_info(supplier_directory)').map((c) => c.name)
	if (!supDirCols.includes('sort_order')) {
		db.exec('ALTER TABLE supplier_directory ADD COLUMN sort_order INTEGER DEFAULT 0')
	}

	// sort_order for charm_shop_directory — preserves the Excel / insertion order
	const charmDirCols = db.pragma('table_info(charm_shop_directory)').map((c) => c.name)
	if (!charmDirCols.includes('sort_order')) {
		db.exec('ALTER TABLE charm_shop_directory ADD COLUMN sort_order INTEGER DEFAULT 0')
	}

	// cost columns — wholesale purchase price shown on the mobile shopping route so
	// the shopper can pay the supplier (e.g. via WeChat) without asking the owner.
	//   product_map.cost_case / cost_grip = case & grip prices, priced SEPARATELY
	//     (same supplier stall, but each component has its own price)
	//   charm_library.cost                = charm price per code (paid at charm stall)
	// REAL + nullable (NULL = "not priced yet"). Preserved by every other product_map
	// / charm write because those ON CONFLICT updates never mention these columns.
	const pmCols = db.pragma('table_info(product_map)').map((c) => c.name)
	if (!pmCols.includes('cost_case')) db.exec('ALTER TABLE product_map ADD COLUMN cost_case REAL')
	if (!pmCols.includes('cost_grip')) db.exec('ALTER TABLE product_map ADD COLUMN cost_grip REAL')
	if (!pmCols.includes('canonical_product_key')) db.exec('ALTER TABLE product_map ADD COLUMN canonical_product_key TEXT')
	// product_type — the operator's explicit classification of a catalog row
	// ('iphone_case' | 'airpods_case' | 'grip' | 'charm' | 'other'; see
	// src/sourcing/catalog.js). NULL means "derive it from the title", which is
	// what every historical row does and what almost every row will keep doing —
	// so there is nothing to backfill and no import to re-run. It is only ever
	// written when the operator CORRECTS a derivation in the Sourcing Catalog.
	if (!pmCols.includes('product_type')) db.exec('ALTER TABLE product_map ADD COLUMN product_type TEXT')
	// Catalog lifecycle. A retired row is deliberately retained as a tombstone:
	// active pickers hide it, while route resolution can see that the product was
	// intentionally removed and must not fall through to the legacy OSP catalog.
	if (!pmCols.includes('status')) db.exec("ALTER TABLE product_map ADD COLUMN status TEXT NOT NULL DEFAULT 'active'")
	if (!pmCols.includes('retired_at')) db.exec('ALTER TABLE product_map ADD COLUMN retired_at INTEGER')
	if (!pmCols.includes('retired_reason')) db.exec("ALTER TABLE product_map ADD COLUMN retired_reason TEXT DEFAULT ''")
	if (!pmCols.includes('retired_by')) db.exec("ALTER TABLE product_map ADD COLUMN retired_by TEXT DEFAULT ''")
	db.exec("UPDATE product_map SET status = 'active' WHERE status IS NULL OR trim(status) = ''")
	db.exec('CREATE INDEX IF NOT EXISTS idx_product_map_status_sort ON product_map(status, sort_order, title)')
	// Retire the earlier single combined `cost` column (only ever briefly present,
	// no meaningful data): fold any value into cost_case, then drop it. Guarded so
	// it's a no-op once removed / on SQLite builds without DROP COLUMN.
	if (pmCols.includes('cost')) {
		try {
			db.exec('UPDATE product_map SET cost_case = cost WHERE cost IS NOT NULL AND cost_case IS NULL')
			db.exec('ALTER TABLE product_map DROP COLUMN cost')
		} catch (e) {
			console.warn('[db] could not drop legacy product_map.cost:', e.message)
		}
	}
	const clCols = db.pragma('table_info(charm_library)').map((c) => c.name)
	if (!clCols.includes('cost')) db.exec('ALTER TABLE charm_library ADD COLUMN cost REAL')
	// Retire charm_library.sku — the imported "SKU / label" string (e.g.
	// CHM-SANRIO-HK-PINK-STRWB). The charm CODE is the identity the operator,
	// the orders and the shopping route all use; the label only ever restated it
	// in a longer form and crowded every picker card. Dropped rather than left
	// dead so nothing can start writing to it again. Guarded: a no-op once gone,
	// and on SQLite builds without DROP COLUMN support the column simply stays
	// (nothing reads or writes it either way). The route engine's own copy of
	// charm_library is a SEPARATE database and keeps its column — see
	// syncCharmTablesToEngine().
	if (clCols.includes('sku')) {
		try {
			db.exec('ALTER TABLE charm_library DROP COLUMN sku')
		} catch (e) {
			console.warn('[db] could not drop legacy charm_library.sku:', e.message)
		}
	}
	// Charms seeded from the manifest carry its generated "Auto-import <when>.
	// Fill SKU (C)…" instruction in Notes — now an instruction to fill a field
	// that no longer exists, sitting in the one free-text field a charm has.
	// Matched in JS (SQLite has no regex) by a pattern narrow enough that a note
	// an operator wrote can never match; see src/route/charm-notes.js. Naturally
	// idempotent: once cleared there is nothing left to match.
	try {
		const stale = db
			.prepare("SELECT code, notes FROM charm_library WHERE notes <> ''")
			.all()
			.filter((r) => charmNotes.isImportBoilerplateNote(r.notes))
		if (stale.length) {
			const clear = db.prepare("UPDATE charm_library SET notes = '' WHERE code = ?")
			db.transaction(() => {
				for (const r of stale) clear.run(r.code)
			})()
			console.log(`[db] cleared the stale "fill in the SKU" import note from ${stale.length} charm(s).`)
		}
	} catch (e) {
		console.warn('[db] could not clear legacy charm import notes:', e.message)
	}

	const phashCols = db.pragma('table_info(listing_phash)').map((c) => c.name)
	if (!phashCols.includes('algo')) db.exec('ALTER TABLE listing_phash ADD COLUMN algo TEXT')
	if (!phashCols.includes('canonical_key')) db.exec('ALTER TABLE listing_phash ADD COLUMN canonical_key TEXT')
	if (!phashCols.includes('design_phash')) db.exec('ALTER TABLE listing_phash ADD COLUMN design_phash TEXT')
	db.exec('CREATE INDEX IF NOT EXISTS idx_listing_phash_canonical ON listing_phash(canonical_key)')

	// seq for bulk_job_items — preserves the scanner's natural-sort order
	//   (1, 2, 3 … 10, 11) instead of SQLite's lexicographic text order
	//   (1, 10, 11, 2, 20). Without this the processing order AND the progress
	//   table both render folders out of human order.
	// preview_json   — full inspection payload (copy + variations + image order +
	//                  settings) computed at generation time, so the Inspector can
	//                  render everything with zero recomputation / Etsy calls.
	// published_at   — epoch when a created draft was published to Etsy.
	const bulkItemCols = db.pragma('table_info(bulk_job_items)').map((c) => c.name)
	if (!bulkItemCols.includes('seq')) {
		db.exec('ALTER TABLE bulk_job_items ADD COLUMN seq INTEGER')
	}
	if (!bulkItemCols.includes('preview_json')) {
		db.exec('ALTER TABLE bulk_job_items ADD COLUMN preview_json TEXT')
	}
	if (!bulkItemCols.includes('published_at')) {
		db.exec('ALTER TABLE bulk_job_items ADD COLUMN published_at INTEGER')
	}
	// reviewed_at — epoch when the operator marked the listing manually reviewed
	// ("good to go"). Drives the review badge, the reviewed counter, and the
	// create-drafts confirmation guard.
	if (!bulkItemCols.includes('reviewed_at')) {
		db.exec('ALTER TABLE bulk_job_items ADD COLUMN reviewed_at INTEGER')
	}
	// A generic "reviewed" click is not enough for marketplace policy. These
	// fields record an explicit, versioned operator attestation before any
	// generated preview may be sent to Etsy as a draft or published.
	if (!bulkItemCols.includes('policy_confirmed_at')) {
		db.exec('ALTER TABLE bulk_job_items ADD COLUMN policy_confirmed_at INTEGER')
	}
	if (!bulkItemCols.includes('policy_confirmed_by')) {
		db.exec('ALTER TABLE bulk_job_items ADD COLUMN policy_confirmed_by TEXT')
	}
	if (!bulkItemCols.includes('policy_attestation')) {
		db.exec('ALTER TABLE bulk_job_items ADD COLUMN policy_attestation TEXT')
	}
	// excluded — operator flagged this product to be SKIPPED when the dry-run is
	// promoted to real Etsy drafts (kept in the list for context, never created).
	if (!bulkItemCols.includes('excluded')) {
		db.exec('ALTER TABLE bulk_job_items ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0')
	}
	// auto_resume_count — how many times a job has been auto-resumed after an
	// interrupted (crashed/restarted) run without making fresh progress. Caps a
	// crash-loop: it's reset to 0 whenever an item completes, so steady progress
	// keeps the budget topped up and only repeated no-progress crashes exhaust it.
	const bulkJobCols = db.pragma('table_info(bulk_jobs)').map((c) => c.name)
	if (!bulkJobCols.includes('auto_resume_count')) {
		db.exec('ALTER TABLE bulk_jobs ADD COLUMN auto_resume_count INTEGER NOT NULL DEFAULT 0')
	}

	// Retire the design-supplier ("which QQ/WeChat chat did this design come
	// from?") schema. Attribution was inferred from the import folder's name, but
	// those folders are named after the Etsy SHOP the drop was published to and a
	// single one mixes designs from many chats — so the columns could never hold
	// a true answer and were dropped along with the feature. Databases created
	// before this point still carry them; reclaim the space here so `table_info`
	// reflects what the code actually uses.
	dropRetiredColumns(db, {
		bulk_jobs: ['supplier_id', 'supplier_name', 'supplier_source'],
		bulk_job_items: ['supplier_id', 'supplier_name', 'supplier_source', 'supplier_confidence', 'supplier_evidence'],
		sourcing_suppliers: ['aliases'],
	})
	db.exec('DROP TABLE IF EXISTS listing_provenance')

	// Backfill seq for items created before the column existed, using the same
	// natural-sort the scanner applies (so legacy jobs also read 1,2,3…10,11 and
	// become inspectable by seq).
	const needsBackfill = db.prepare('SELECT COUNT(*) AS n FROM bulk_job_items WHERE seq IS NULL').get().n
	if (needsBackfill > 0) {
		const naturalKey = (s) => {
			const m = String(s || '').match(/\d+/)
			return m ? parseInt(m[0], 10) : Number.MAX_SAFE_INTEGER
		}
		const jobIds = db
			.prepare('SELECT DISTINCT job_id FROM bulk_job_items WHERE seq IS NULL')
			.all()
			.map((r) => r.job_id)
		const setSeq = db.prepare('UPDATE bulk_job_items SET seq = ? WHERE job_id = ? AND product_folder = ?')
		const tx = db.transaction((jids) => {
			for (const jid of jids) {
				const rows = db.prepare('SELECT product_folder, product_name FROM bulk_job_items WHERE job_id = ?').all(jid)
				rows.sort((a, b) => naturalKey(a.product_name) - naturalKey(b.product_name) || String(a.product_name).localeCompare(String(b.product_name), undefined, { numeric: true }))
				rows.forEach((r, i) => setSeq.run(i + 1, jid, r.product_folder))
			}
		})
		tx(jobIds)
	}

	// One-time remap of title-prefix keys → listing-scoped keys (fixes charm
	// assignments bleeding across different products that share a title prefix).
	migrateRouteKeysToListingScope(db)

	// Drop the legacy UNIQUE(receipt_id) on route_manual_items so one manual
	// order can carry several products (one sidecar per line, shared receipt_id).
	migrateRouteManualItemsSharedReceipt(db)

	// Merge any alias-keyed per-line rows (plain title#Llisting) onto the
	// canonical variant key stored in route_manual_items. Without this, a charm
	// marked Purchased from the Orders tab (which used to derive the plain key)
	// sits invisible beside the real Shopping Mode / Route-tab row.
	healManualLineKeyAliases(db)

	// One-time migration of the retired "Archive" feature into the Issues system.
	// Out-of-production archives become open per-line Issues; everything else is
	// restored to the active views. Idempotent (it only ever looks at still-archived
	// rows, and clears archived_at as it goes).
	migrateArchivedOrdersToIssues(db)

	// Collapse letter-case twins in supplier_directory / charm_shop_directory
	// (汇通A146 vs 汇通a146) and rewrite every stored reference onto the spelling
	// we kept. Idempotent — a clean directory is a no-op. Prevents the greyed-out
	// "ext" picker card that Manage cannot delete.
	migrateSupplierBoothIdentityDuplicates(db)
	migrateCharmShopBoothIdentityDuplicates(db)

	// Self-heal any line that is BOTH switched to a new design AND still flagged
	// on-hold, when the switch is the more recent decision. Such a line was being
	// silently withheld from the purchasing route (a switch is meant to un-hold the
	// line, but a resolve that never ran / legacy data left the issue open). This
	// resolves those stale holds so the switched product flows back into shopping.
	// Idempotent — only touches open issues actually superseded by a substitution.
	healSupersededSubstitutionIssues(db)

	// Surface every line whose CURRENT purchase status is terminal (Out of
	// Production / Model Unavailable) as an open fulfilment issue. Heals orders
	// marked terminal on a surface that historically didn't bridge to issues (the
	// desktop Route tab, the Orders-tab per-component control, the bulk route-status
	// import) — they were "on hold" in status yet missing from Issues/on-hold. Runs
	// AFTER the supersede heal so the two never fight. Idempotent.
	reconcileTerminalStatusIssues(db)

	// Synthetic shop/group that owns every manual order (must exist before any
	// manual receipt is inserted, to satisfy the receipts→shops foreign key).
	seedManualOrderShop(db)

	// Backfill the transactions table from already-stored receipts.raw_json so
	// per-order earnings attribution (transaction-fee → receipt) works for the
	// full order history without spending any Etsy API calls. Idempotent.
	backfillTransactionsFromReceipts(db)

	// Self-heal ledger categories against the current rules (e.g. so disbursements
	// are always treated as transfers and excluded from net earnings). Cheap and
	// idempotent — only rewrites rows whose category actually changed.
	recategorizeLedgerEntries(db)

	_db = db
	return db
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
		const pending = db
			.prepare(
				`
      SELECT r.receipt_id, r.shop_id, r.raw_json
      FROM receipts r
      WHERE r.raw_json IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.receipt_id = r.receipt_id)
    `,
			)
			.all()
		if (!pending.length) return

		let inserted = 0
		const run = db.transaction((rows) => {
			for (const row of rows) {
				let parsed
				try {
					parsed = JSON.parse(row.raw_json)
				} catch {
					continue
				}
				const txs = Array.isArray(parsed?.transactions) ? parsed.transactions : []
				for (const tx of txs) {
					if (tx && tx.transaction_id) {
						upsertTransaction(db, row.shop_id, { ...tx, receipt_id: tx.receipt_id ?? row.receipt_id })
						inserted++
					}
				}
			}
		})
		run(pending)
		if (inserted) console.log(`[db] Backfilled ${inserted} transaction(s) from ${pending.length} receipt(s) for earnings attribution`)
	} catch (err) {
		console.error('[db] transaction backfill failed (non-fatal):', err.message)
	}
}

/**
 * Drop the legacy UNIQUE(receipt_id) on `route_manual_items`.
 *
 * Originally each sidecar WAS the order (receipt_id = -id). Route-tab "Add
 * Order" now creates a real `receipts` row first and links every product line
 * to it, so a buyer who ordered three cases must produce three sidecars that
 * SHARE one receipt_id. SQLite cannot ALTER away a column UNIQUE, so we
 * rebuild the table. Idempotent: a database that already allows shared
 * receipt_ids is a no-op besides ensuring the lookup index exists.
 *
 * @param {import('better-sqlite3').Database} db
 */
function migrateRouteManualItemsSharedReceipt(db) {
	let uniqueOnReceipt = false
	try {
		const indexes = db.pragma('index_list(route_manual_items)')
		for (const idx of indexes) {
			if (!idx.unique) continue
			const cols = db.pragma(`index_info("${idx.name}")`)
			if (cols.length === 1 && cols[0].name === 'receipt_id') {
				uniqueOnReceipt = true
				break
			}
		}
	} catch {
		return
	}

	if (!uniqueOnReceipt) {
		try {
			db.exec('CREATE INDEX IF NOT EXISTS idx_route_manual_items_receipt ON route_manual_items(receipt_id)')
		} catch {
			/* table may not exist yet */
		}
		return
	}

	db.exec(`
    CREATE TABLE route_manual_items__shared_receipt (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id  INTEGER NOT NULL,
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
    INSERT INTO route_manual_items__shared_receipt
      (id, receipt_id, item_key, title, phone_model, style, quantity, shop_name,
       listing_id, image_url, image_data, image_mime, source, created_at)
    SELECT id, receipt_id, item_key, title, phone_model, style, quantity, shop_name,
           listing_id, image_url, image_data, image_mime, source, created_at
    FROM route_manual_items;
    DROP TABLE route_manual_items;
    ALTER TABLE route_manual_items__shared_receipt RENAME TO route_manual_items;
    CREATE INDEX IF NOT EXISTS idx_route_manual_items_receipt ON route_manual_items(receipt_id);
  `)

	try {
		const maxId = Number(db.prepare('SELECT MAX(id) AS m FROM route_manual_items').get()?.m) || 0
		db.prepare("DELETE FROM sqlite_sequence WHERE name = 'route_manual_items'").run()
		db.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES ('route_manual_items', ?)").run(maxId)
	} catch {
		/* sqlite_sequence is absent on some builds; AUTOINCREMENT still works from MAX(id) */
	}

	console.log('[db] route_manual_items: receipt_id is now shareable across line items of one order')
}

// Local copies of the dashboard's key helpers. Duplicated here (instead of
// importing src/route/dashboard.js) to avoid a require cycle — dashboard.js
// already depends on this module.
function _normTitleForKey(text) {
	return String(text ?? '')
		.replace(/\|/g, ',')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase()
}
function _baseTitleKey(title) {
	return _normTitleForKey(title).slice(0, 50)
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
	const MARKER = '#L'
	try {
		if (db.pragma('user_version', { simple: true }) >= 1) return
	} catch {
		/* fall through and attempt the migration */
	}

	// Build resolvers from every order's line-items:
	//   perReceipt: receipt_id → (baseKey → Set<listing_id>)
	//   global:     baseKey → Set<listing_id>   (across all orders)
	const perReceipt = new Map()
	const global = new Map()
	let recs = []
	try {
		recs = db.prepare("SELECT receipt_id, all_transactions FROM receipts WHERE all_transactions IS NOT NULL AND all_transactions <> ''").all()
	} catch {
		recs = []
	}

	for (const r of recs) {
		let txs = []
		try {
			txs = JSON.parse(r.all_transactions || '[]')
		} catch {
			continue
		}
		if (!Array.isArray(txs)) continue
		for (const t of txs) {
			const bk = _baseTitleKey(t.title || '')
			const lid = t.listing_id != null ? String(t.listing_id).trim() : ''
			if (!bk || !lid) continue
			if (!perReceipt.has(r.receipt_id)) perReceipt.set(r.receipt_id, new Map())
			const m = perReceipt.get(r.receipt_id)
			if (!m.has(bk)) m.set(bk, new Set())
			m.get(bk).add(lid)
			if (!global.has(bk)) global.set(bk, new Set())
			global.get(bk).add(lid)
		}
	}

	const scoped = (base, lid) => `${base}${MARKER}${lid}`

	const tx = db.transaction(() => {
		// ── route_assignments ──────────────────────────────────────────────────
		let raRows = []
		try {
			raRows = db.prepare('SELECT * FROM route_assignments').all()
		} catch {
			raRows = []
		}

		const insRA = db.prepare(`
      INSERT OR IGNORE INTO route_assignments
        (receipt_id, item_key, title, charm_code, charm_shop,
         status_case, status_grip, status_charm, excluded,
         supplier_shop_override, supplier_stall_override, updated_at)
      VALUES
        (@receipt_id, @item_key, @title, @charm_code, @charm_shop,
         @status_case, @status_grip, @status_charm, @excluded,
         @supplier_shop_override, @supplier_stall_override, @updated_at)
    `)
		const delRA = db.prepare('DELETE FROM route_assignments WHERE receipt_id = ? AND item_key = ?')

		for (const a of raRows) {
			if (typeof a.item_key === 'string' && a.item_key.includes(MARKER)) continue // already scoped
			const listings = perReceipt.get(a.receipt_id)?.get(a.item_key)
			if (!listings || listings.size === 0) continue // unresolved → leave as-is
			for (const lid of listings) {
				insRA.run({
					receipt_id: a.receipt_id,
					item_key: scoped(a.item_key, lid),
					title: a.title ?? '',
					charm_code: a.charm_code ?? '',
					charm_shop: a.charm_shop ?? '',
					status_case: a.status_case ?? 'Pending',
					status_grip: a.status_grip ?? 'Pending',
					status_charm: a.status_charm ?? 'Pending',
					excluded: a.excluded ?? 0,
					supplier_shop_override: a.supplier_shop_override ?? '',
					supplier_stall_override: a.supplier_stall_override ?? '',
					updated_at: a.updated_at ?? Math.floor(Date.now() / 1000),
				})
			}
			delRA.run(a.receipt_id, a.item_key)
		}

		// ── product_assignments ────────────────────────────────────────────────
		let paRows = []
		try {
			paRows = db.prepare('SELECT * FROM product_assignments').all()
		} catch {
			paRows = []
		}

		const insPA = db.prepare(`
      INSERT OR IGNORE INTO product_assignments
        (item_key, title, supplier_shop, supplier_stall, charm_code, charm_shop, updated_at)
      VALUES
        (@item_key, @title, @supplier_shop, @supplier_stall, @charm_code, @charm_shop, @updated_at)
    `)
		const delPA = db.prepare('DELETE FROM product_assignments WHERE item_key = ?')

		for (const a of paRows) {
			if (typeof a.item_key === 'string' && a.item_key.includes(MARKER)) continue
			const listings = global.get(a.item_key)
			if (!listings || listings.size === 0) continue
			for (const lid of listings) {
				insPA.run({
					item_key: scoped(a.item_key, lid),
					title: a.title ?? '',
					supplier_shop: a.supplier_shop ?? '',
					supplier_stall: a.supplier_stall ?? '',
					charm_code: a.charm_code ?? '',
					charm_shop: a.charm_shop ?? '',
					updated_at: a.updated_at ?? Math.floor(Date.now() / 1000),
				})
			}
			delPA.run(a.item_key)
		}
	})

	try {
		tx()
		db.pragma('user_version = 1')
	} catch (err) {
		console.error('[db] listing-scope key migration failed (left data untouched):', err.message)
	}
}

/**
 * Merge alias-keyed per-line rows onto the canonical `route_manual_items.item_key`.
 *
 * Background: Route-tab manual orders store lines under a per-variant key
 * (`…#L<listing>#V<model>|<style>`). Older Orders-tab / rollup code derived the
 * plain product key (`…#L<listing>`) and wrote purchase status / issues under
 * THAT name — creating a "ghost" row Shopping Mode never sees. Once readers are
 * fixed to use the canonical key, those ghosts would otherwise linger forever
 * and keep reporting a stale Charm ✓ while the real line looks unbought (or
 * vice versa).
 *
 * Rules (idempotent, never invents data):
 *   1. Only consider rows whose receipt has ≥1 route_manual_items sidecar.
 *   2. A row whose item_key IS a stored sidecar key is already canonical — skip.
 *   3. An alias maps to a sidecar only when exactly ONE sidecar shares the same
 *      stripped product identity (`stripLineVariantKey`). Ambiguous aliases
 *      (two variants of the same listing) are left alone — guessing would
 *      corrupt a different product's state.
 *   4. When both alias and canonical rows exist, merge field-by-field preferring
 *      non-default / more-recent values, then DELETE the alias.
 *   5. When only the alias exists, RENAME it onto the canonical key.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ merged: number, renamed: number }}
 */
function healManualLineKeyAliases(db) {
	let stripLineVariantKey
	try {
		;({ stripLineVariantKey } = require('../route/dashboard'))
	} catch {
		return { merged: 0, renamed: 0 }
	}

	const sidecarsByReceipt = new Map()
	try {
		for (const m of db.prepare('SELECT receipt_id, item_key FROM route_manual_items ORDER BY id ASC').all()) {
			if (!sidecarsByReceipt.has(m.receipt_id)) sidecarsByReceipt.set(m.receipt_id, [])
			sidecarsByReceipt.get(m.receipt_id).push(m.item_key)
		}
	} catch {
		return { merged: 0, renamed: 0 }
	}
	if (!sidecarsByReceipt.size) return { merged: 0, renamed: 0 }

	/** @param {string} status */
	const statusRank = (status) => {
		switch (status) {
			case 'Purchased':
				return 4
			case 'Out of Stock':
			case 'Wrong Stall':
				return 3
			case 'Out of Production':
			case 'Model Unavailable':
				return 2
			default:
				return 1 // Pending / unknown
		}
	}

	/**
	 * Prefer the more progressed component status; ties break toward the newer row.
	 * @param {string|null|undefined} a
	 * @param {string|null|undefined} b
	 * @param {number} aAt
	 * @param {number} bAt
	 */
	const pickStatus = (a, b, aAt, bAt) => {
		const sa = a || 'Pending'
		const sb = b || 'Pending'
		const ra = statusRank(sa)
		const rb = statusRank(sb)
		if (ra !== rb) return ra > rb ? sa : sb
		return (bAt || 0) >= (aAt || 0) ? sb : sa
	}

	let merged = 0
	let renamed = 0

	const run = db.transaction(() => {
		// ── route_assignments ──────────────────────────────────────────────────
		let raRows = []
		try {
			raRows = db.prepare('SELECT * FROM route_assignments').all()
		} catch {
			raRows = []
		}

		const getRA = db.prepare('SELECT * FROM route_assignments WHERE receipt_id = ? AND item_key = ?')
		const delRA = db.prepare('DELETE FROM route_assignments WHERE receipt_id = ? AND item_key = ?')
		const updRAKey = db.prepare('UPDATE route_assignments SET item_key = ? WHERE receipt_id = ? AND item_key = ?')
		const upsertRA = db.prepare(`
      INSERT INTO route_assignments
        (receipt_id, item_key, title, charm_code, charm_shop,
         status_case, status_grip, status_charm, excluded,
         supplier_shop_override, supplier_stall_override, updated_at,
         dismissed_at, verified_at, verified_by)
      VALUES
        (@receipt_id, @item_key, @title, @charm_code, @charm_shop,
         @status_case, @status_grip, @status_charm, @excluded,
         @supplier_shop_override, @supplier_stall_override, @updated_at,
         @dismissed_at, @verified_at, @verified_by)
      ON CONFLICT(receipt_id, item_key) DO UPDATE SET
        title = excluded.title,
        charm_code = CASE WHEN excluded.charm_code <> '' THEN excluded.charm_code ELSE route_assignments.charm_code END,
        charm_shop = CASE WHEN excluded.charm_shop <> '' THEN excluded.charm_shop ELSE route_assignments.charm_shop END,
        status_case = excluded.status_case,
        status_grip = excluded.status_grip,
        status_charm = excluded.status_charm,
        excluded = MAX(route_assignments.excluded, excluded.excluded),
        supplier_shop_override = CASE
          WHEN excluded.supplier_shop_override <> '' THEN excluded.supplier_shop_override
          ELSE route_assignments.supplier_shop_override END,
        supplier_stall_override = CASE
          WHEN excluded.supplier_stall_override <> '' THEN excluded.supplier_stall_override
          ELSE route_assignments.supplier_stall_override END,
        updated_at = MAX(route_assignments.updated_at, excluded.updated_at),
        dismissed_at = COALESCE(route_assignments.dismissed_at, excluded.dismissed_at),
        verified_at = COALESCE(route_assignments.verified_at, excluded.verified_at),
        verified_by = CASE
          WHEN route_assignments.verified_at IS NOT NULL THEN route_assignments.verified_by
          ELSE excluded.verified_by END
    `)

		for (const ghost of raRows) {
			const stored = sidecarsByReceipt.get(ghost.receipt_id)
			if (!stored || !stored.length) continue
			if (stored.includes(ghost.item_key)) continue

			const base = stripLineVariantKey(ghost.item_key)
			const matches = stored.filter((k) => stripLineVariantKey(k) === base)
			if (matches.length !== 1) continue
			const canonical = matches[0]
			if (canonical === ghost.item_key) continue

			const existing = getRA.get(ghost.receipt_id, canonical)
			if (!existing) {
				updRAKey.run(canonical, ghost.receipt_id, ghost.item_key)
				renamed++
				continue
			}

			const aAt = Number(existing.updated_at) || 0
			const bAt = Number(ghost.updated_at) || 0
			upsertRA.run({
				receipt_id: ghost.receipt_id,
				item_key: canonical,
				title: existing.title || ghost.title || '',
				charm_code: existing.charm_code || ghost.charm_code || '',
				charm_shop: existing.charm_shop || ghost.charm_shop || '',
				status_case: pickStatus(existing.status_case, ghost.status_case, aAt, bAt),
				status_grip: pickStatus(existing.status_grip, ghost.status_grip, aAt, bAt),
				status_charm: pickStatus(existing.status_charm, ghost.status_charm, aAt, bAt),
				excluded: existing.excluded || ghost.excluded ? 1 : 0,
				supplier_shop_override: existing.supplier_shop_override || ghost.supplier_shop_override || '',
				supplier_stall_override: existing.supplier_stall_override || ghost.supplier_stall_override || '',
				updated_at: Math.max(aAt, bAt),
				dismissed_at: existing.dismissed_at ?? ghost.dismissed_at ?? null,
				verified_at: existing.verified_at ?? ghost.verified_at ?? null,
				verified_by: existing.verified_at ? existing.verified_by || '' : ghost.verified_by || '',
			})
			delRA.run(ghost.receipt_id, ghost.item_key)
			merged++
		}

		// ── receipt_item_purchase / order_issues / order_exchanges / substitutions ─
		// These tables are UNIQUE(receipt_id, item_key). Prefer the canonical row when
		// both exist (it is what the UI reads after the fix); otherwise rename.
		const simpleTables = [
			{ table: 'receipt_item_purchase', prefer: 'canonical' },
			{ table: 'order_issues', prefer: 'canonical' },
			{ table: 'order_exchanges', prefer: 'canonical' },
			{ table: 'order_line_substitutions', prefer: 'canonical' },
		]

		for (const { table } of simpleTables) {
			let rows = []
			try {
				rows = db.prepare(`SELECT receipt_id, item_key FROM ${table}`).all()
			} catch {
				continue
			}
			const exists = db.prepare(`SELECT 1 AS ok FROM ${table} WHERE receipt_id = ? AND item_key = ?`)
			const del = db.prepare(`DELETE FROM ${table} WHERE receipt_id = ? AND item_key = ?`)
			const rename = db.prepare(`UPDATE ${table} SET item_key = ? WHERE receipt_id = ? AND item_key = ?`)

			for (const ghost of rows) {
				const stored = sidecarsByReceipt.get(ghost.receipt_id)
				if (!stored || !stored.length) continue
				if (stored.includes(ghost.item_key)) continue

				const base = stripLineVariantKey(ghost.item_key)
				const matches = stored.filter((k) => stripLineVariantKey(k) === base)
				if (matches.length !== 1) continue
				const canonical = matches[0]
				if (canonical === ghost.item_key) continue

				if (exists.get(ghost.receipt_id, canonical)) {
					del.run(ghost.receipt_id, ghost.item_key)
					merged++
				} else {
					try {
						rename.run(canonical, ghost.receipt_id, ghost.item_key)
						renamed++
					} catch {
						// Race with a concurrent insert of the canonical key — drop the alias.
						del.run(ghost.receipt_id, ghost.item_key)
						merged++
					}
				}
			}
		}
	})

	try {
		run()
	} catch (err) {
		console.error('[db] manual line-key alias heal failed (left data untouched):', err.message)
		return { merged: 0, renamed: 0 }
	}

	if (merged || renamed) {
		console.log(`[db] Healed manual line-key aliases: ${merged} merged, ${renamed} renamed onto route_manual_items keys.`)
	}
	return { merged, renamed }
}

/**
 * Get the active database instance.
 * Throws if initDb() has not been called yet.
 * @returns {Database.Database}
 */
function getDb() {
	if (!_db) throw new Error('Database not initialized. Call initDb() first.')
	return _db
}

/**
 * Upsert a group record from config.
 * @param {Database.Database} db
 * @param {{ group_id: string, label: string, proxy: string }} group
 */
function upsertGroup(db, group) {
	const { usesGroupProxy } = require('../config/schema')
	const proxyHost = (() => {
		if (!usesGroupProxy(group)) return 'direct'
		try {
			return new URL(group.proxy).hostname
		} catch {
			return group.proxy
		}
	})()

	db.prepare(
		`
    INSERT INTO groups (group_id, label, proxy_host)
    VALUES (@group_id, @label, @proxy_host)
    ON CONFLICT(group_id) DO UPDATE SET
      label      = excluded.label,
      proxy_host = excluded.proxy_host
  `,
	).run({ group_id: group.group_id, label: group.label, proxy_host: proxyHost })
}

/**
 * Upsert a shop record from config.
 * @param {Database.Database} db
 * @param {{ shop_id: string, shop_name: string, group_id: string }} shop
 */
function upsertShop(db, shop) {
	db.prepare(
		`
    INSERT INTO shops (shop_id, group_id, shop_name)
    VALUES (@shop_id, @group_id, @shop_name)
    ON CONFLICT(shop_id) DO UPDATE SET
      shop_name = excluded.shop_name,
      group_id  = excluded.group_id
  `,
	).run({ shop_id: shop.shop_id, group_id: shop.group_id, shop_name: shop.shop_name })
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
			db
				.prepare(`PRAGMA table_info("${name}")`)
				.all()
				.some((col) => col.name === 'shop_id'),
		)

	const dbShops = db.prepare('SELECT shop_id, group_id FROM shops').all()
	for (const { shop_id: shopId } of dbShops) {
		if (shopId === MANUAL_SHOP_ID) continue // never prune the synthetic shop
		if (configShopIds.has(shopId)) continue // still in config — keep

		let dependentRows = 0
		for (const table of dependentTables) {
			dependentRows += db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE shop_id = ?`).get(shopId).n
			if (dependentRows > 0) break
		}

		if (dependentRows > 0) {
			console.warn(`[config-sync] Shop "${shopId}" was removed from config.json but still has ` + `data in the database — keeping it to preserve history. Delete its data ` + `manually if you intend to remove it permanently.`)
			continue
		}

		db.prepare('DELETE FROM shops WHERE shop_id = ?').run(shopId)
		console.log(`[config-sync] Pruned shop "${shopId}" (removed from config.json, no data).`)
	}

	// Prune now-empty groups that no longer exist in config (except the synthetic one).
	const dbGroups = db.prepare('SELECT group_id FROM groups').all()
	for (const { group_id: groupId } of dbGroups) {
		if (groupId === MANUAL_GROUP_ID) continue
		if (configGroupIds.has(groupId)) continue
		const remaining = db.prepare('SELECT COUNT(*) AS n FROM shops WHERE group_id = ?').get(groupId).n
		if (remaining === 0) {
			db.prepare('DELETE FROM groups WHERE group_id = ?').run(groupId)
			console.log(`[config-sync] Pruned empty group "${groupId}" (removed from config.json).`)
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
		const configShopIds = new Set()
		const configGroupIds = new Set()
		for (const group of config.groups) {
			configGroupIds.add(group.group_id)
			upsertGroup(db, group)
			for (const shop of group.shops) {
				configShopIds.add(shop.shop_id)
				upsertShop(db, { ...shop, group_id: group.group_id })
			}
		}
		pruneRemovedShops(db, configShopIds, configGroupIds)
	})
	sync()
}

// ── Buyer-purchased shipping upgrades (Express) ───────────────────────────────

/**
 * The receipt columns that hold the shipping-upgrade rollup. Listed once so the
 * migration knows exactly which additions should trigger the history backfill.
 * @type {ReadonlyArray<string>}
 */
const SHIPPING_UPGRADE_COLUMNS = Object.freeze(['shipping_upgrade', 'shipping_method', 'shipping_upgrade_tier', 'is_expedited'])

/**
 * Recover the express flag for every already-synced order from its stored Etsy
 * payload.
 *
 * WHY THIS IS SAFE AND EXACT
 * Every synced receipt keeps `raw_json` — the verbatim ShopReceipt Etsy returned,
 * including each transaction's `shipping_upgrade`. So this is not a heuristic
 * reconstruction: it derives precisely the values the next sync of that order
 * would write, and it is idempotent (re-running it produces the same rows).
 *
 * Per-line detail is merged into the EXISTING all_transactions blob rather than
 * regenerated, so any locally-added key on those entries survives. When the
 * stored line count and the raw line count disagree — the one case where an
 * index-wise merge could attach an upgrade to the wrong product — the blob is
 * left untouched and the next ordinary sync repairs it. Showing no per-line chip
 * is recoverable; labelling the wrong line "Express" is not.
 *
 * Manual orders (no raw_json) are skipped: they never had an Etsy checkout, so
 * their is_expedited correctly stays at the column default of 0.
 *
 * @param {Database.Database} db
 * @returns {{scanned: number, expedited: number}}
 */
function backfillShippingUpgrades(db) {
	const rows = db.prepare('SELECT receipt_id, raw_json, all_transactions FROM receipts WHERE raw_json IS NOT NULL').all()
	if (rows.length === 0) return { scanned: 0, expedited: 0 }

	const stmt = db.prepare(`
    UPDATE receipts SET
      shipping_upgrade      = @shipping_upgrade,
      shipping_method       = @shipping_method,
      shipping_upgrade_tier = @shipping_upgrade_tier,
      is_expedited          = @is_expedited,
      all_transactions      = COALESCE(@all_transactions, all_transactions)
    WHERE receipt_id = @receipt_id
  `)

	let expedited = 0
	const run = db.transaction(() => {
		for (const row of rows) {
			let raw
			try {
				raw = JSON.parse(row.raw_json)
			} catch {
				continue // malformed payload — the next sync will replace it
			}
			const rollup = shippingUpgrade.deriveFromReceipt(raw)
			if (rollup.expedited) expedited++

			// Merge the two per-line fields into the stored transaction list, matching
			// by position only when both lists describe the same number of lines.
			let mergedTransactions = null
			if (rollup.upgradedLines > 0 && row.all_transactions) {
				try {
					const stored = JSON.parse(row.all_transactions)
					const rawTxs = Array.isArray(raw.transactions) ? raw.transactions : []
					if (Array.isArray(stored) && stored.length === rawTxs.length) {
						mergedTransactions = JSON.stringify(
							stored.map((line, i) => ({
								...line,
								shipping_upgrade: shippingUpgrade.normalizeUpgradeName(rawTxs[i]?.shipping_upgrade) || null,
								shipping_method: shippingUpgrade.normalizeUpgradeName(rawTxs[i]?.shipping_method) || null,
							})),
						)
					}
				} catch {
					/* leave the stored blob alone */
				}
			}

			stmt.run({
				receipt_id: row.receipt_id,
				shipping_upgrade: rollup.name || null,
				shipping_method: rollup.method || null,
				shipping_upgrade_tier: rollup.tier || null,
				is_expedited: rollup.expedited ? 1 : 0,
				all_transactions: mergedTransactions,
			})
		}
	})
	run()

	if (expedited > 0) {
		console.log(`[db] Shipping upgrades: flagged ${expedited} express order(s) from ${rows.length} synced receipt(s).`)
	}
	return { scanned: rows.length, expedited }
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
	const money = (obj) => (obj && obj.divisor ? obj.amount / obj.divisor : null)
	const currency = (obj) => (obj ? obj.currency_code : null)

	const firstTx = Array.isArray(receipt.transactions) && receipt.transactions.length > 0 ? receipt.transactions[0] : null
	const firstShip = Array.isArray(receipt.shipments) && receipt.shipments.length > 0 ? receipt.shipments[0] : null

	// Buyer-purchased shipping upgrade, rolled up from transactions[].shipping_upgrade.
	// `hasTransactions` gates the write below: Etsy's "recently-updated" pass can
	// return a receipt with an EMPTY transactions[] array, which would otherwise
	// clear a real Express flag and quietly demote the order back into the normal
	// queue — the same transient-gap hazard the COALESCE'd columns guard against.
	const hasTransactions = Array.isArray(receipt.transactions) && receipt.transactions.length > 0
	const upgrade = shippingUpgrade.deriveFromReceipt(receipt)

	db.prepare(
		`
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
      shipping_upgrade, shipping_method, shipping_upgrade_tier, is_expedited,
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
      @shipping_upgrade, @shipping_method, @shipping_upgrade_tier, @is_expedited,
      @etsy_created_at, @etsy_updated_at,
      strftime('%s', 'now'), @raw_json
    )
    ON CONFLICT(receipt_id) DO UPDATE SET
      status               = excluded.status,
      -- Shipping completion is monotonic locally. A sparse/stale Etsy response
      -- must not resurrect a fulfilled order as unshipped.
      is_shipped           = MAX(is_shipped, excluded.is_shipped),
      is_paid              = MAX(is_paid, excluded.is_paid),
      buyer_user_id        = COALESCE(excluded.buyer_user_id, buyer_user_id),
      buyer_email          = COALESCE(excluded.buyer_email, buyer_email),
      name                 = COALESCE(excluded.name, name),
      grandtotal_amount    = COALESCE(excluded.grandtotal_amount, grandtotal_amount),
      grandtotal_currency  = COALESCE(excluded.grandtotal_currency, grandtotal_currency),
      subtotal_amount      = COALESCE(excluded.subtotal_amount, subtotal_amount),
      discount_amount      = COALESCE(excluded.discount_amount, discount_amount),
      shipping_cost        = COALESCE(excluded.shipping_cost, shipping_cost),
      total_tax_cost       = COALESCE(excluded.total_tax_cost, total_tax_cost),
      message_from_buyer   = COALESCE(excluded.message_from_buyer, message_from_buyer),
      message_from_seller  = COALESCE(excluded.message_from_seller, message_from_seller),
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
      -- Protect tracking against transient NULLs, same rationale as the fields
      -- above: a Pass B / non-shipped re-sync often returns a receipt with an
      -- empty shipments[] array (firstShip == null → tracking_code param NULL).
      -- Writing that NULL raw would wipe a tracking number set by a prior sync or
      -- by external 4PX tracking (updateTrackingDetail). COALESCE keeps the
      -- existing value while still accepting a genuinely-changed non-NULL code.
      tracking_code        = COALESCE(excluded.tracking_code, tracking_code),
      carrier_name         = COALESCE(excluded.carrier_name,  carrier_name),
      -- A buyer-visible tracking correction identifies a different parcel.
      -- Never carry the old number's terminal/status/error snapshot onto it.
      carrier_confirmed_at = CASE
        WHEN excluded.tracking_code IS NOT NULL
         AND COALESCE(excluded.tracking_code, '') != COALESCE(tracking_code, '') COLLATE NOCASE
        THEN NULL ELSE carrier_confirmed_at END,
      tracking_checked_at = CASE
        WHEN excluded.tracking_code IS NOT NULL
         AND COALESCE(excluded.tracking_code, '') != COALESCE(tracking_code, '') COLLATE NOCASE
        THEN NULL ELSE tracking_checked_at END,
      tracking_status = CASE
        WHEN excluded.tracking_code IS NOT NULL
         AND COALESCE(excluded.tracking_code, '') != COALESCE(tracking_code, '') COLLATE NOCASE
        THEN NULL ELSE tracking_status END,
      tracking_last_event = CASE
        WHEN excluded.tracking_code IS NOT NULL
         AND COALESCE(excluded.tracking_code, '') != COALESCE(tracking_code, '') COLLATE NOCASE
        THEN NULL ELSE tracking_last_event END,
      tracking_last_event_at = CASE
        WHEN excluded.tracking_code IS NOT NULL
         AND COALESCE(excluded.tracking_code, '') != COALESCE(tracking_code, '') COLLATE NOCASE
        THEN NULL ELSE tracking_last_event_at END,
      tracking_last_location = CASE
        WHEN excluded.tracking_code IS NOT NULL
         AND COALESCE(excluded.tracking_code, '') != COALESCE(tracking_code, '') COLLATE NOCASE
        THEN NULL ELSE tracking_last_location END,
      tracking_delivered_at = CASE
        WHEN excluded.tracking_code IS NOT NULL
         AND COALESCE(excluded.tracking_code, '') != COALESCE(tracking_code, '') COLLATE NOCASE
        THEN NULL ELSE tracking_delivered_at END,
      tracking_health = CASE
        WHEN excluded.tracking_code IS NOT NULL
         AND COALESCE(excluded.tracking_code, '') != COALESCE(tracking_code, '') COLLATE NOCASE
        THEN NULL ELSE tracking_health END,
      tracking_health_reason = CASE
        WHEN excluded.tracking_code IS NOT NULL
         AND COALESCE(excluded.tracking_code, '') != COALESCE(tracking_code, '') COLLATE NOCASE
        THEN NULL ELSE tracking_health_reason END,
      tracking_is_disposed = CASE
        WHEN excluded.tracking_code IS NOT NULL
         AND COALESCE(excluded.tracking_code, '') != COALESCE(tracking_code, '') COLLATE NOCASE
        THEN 0 ELSE tracking_is_disposed END,
      tracking_last_error = CASE
        WHEN excluded.tracking_code IS NOT NULL
         AND COALESCE(excluded.tracking_code, '') != COALESCE(tracking_code, '') COLLATE NOCASE
        THEN NULL ELSE tracking_last_error END,
      tracking_error_at = CASE
        WHEN excluded.tracking_code IS NOT NULL
         AND COALESCE(excluded.tracking_code, '') != COALESCE(tracking_code, '') COLLATE NOCASE
        THEN NULL ELSE tracking_error_at END,
      tracking_error_count = CASE
        WHEN excluded.tracking_code IS NOT NULL
         AND COALESCE(excluded.tracking_code, '') != COALESCE(tracking_code, '') COLLATE NOCASE
        THEN 0 ELSE tracking_error_count END,
      tracking_next_check_at = CASE
        WHEN excluded.tracking_code IS NOT NULL
         AND COALESCE(excluded.tracking_code, '') != COALESCE(tracking_code, '') COLLATE NOCASE
        THEN NULL ELSE tracking_next_check_at END,
      shipment_was_shipped = MAX(shipment_was_shipped, excluded.shipment_was_shipped),
      -- Only update shipment_notified_at when it is newly set; never overwrite a real
      -- timestamp with NULL (re-sync may omit the shipments array for non-shipped orders).
      shipment_notified_at = COALESCE(excluded.shipment_notified_at, shipment_notified_at),
      -- Shipping upgrade: written ONLY when the payload actually carried lines.
      -- A plain COALESCE would be wrong in the other direction here — an order
      -- whose upgrade was refunded/removed on Etsy must be able to go back to
      -- standard — so the transaction-presence flag decides, and a payload with
      -- an empty transactions[] array leaves all four values exactly as they were.
      shipping_upgrade      = CASE WHEN @has_transactions = 1 THEN excluded.shipping_upgrade      ELSE shipping_upgrade      END,
      shipping_method       = CASE WHEN @has_transactions = 1 THEN excluded.shipping_method       ELSE shipping_method       END,
      shipping_upgrade_tier = CASE WHEN @has_transactions = 1 THEN excluded.shipping_upgrade_tier ELSE shipping_upgrade_tier END,
      is_expedited          = CASE WHEN @has_transactions = 1 THEN excluded.is_expedited          ELSE is_expedited          END,
      etsy_updated_at      = excluded.etsy_updated_at,
      synced_at            = excluded.synced_at,
      raw_json             = excluded.raw_json
  `,
	).run({
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
		shipping_first_line: decodeHtmlEntities(receipt.first_line ?? null),
		shipping_second_line: decodeHtmlEntities(receipt.second_line ?? null),
		shipping_city: receipt.city ?? null,
		shipping_state: receipt.state ?? null,
		shipping_zip: receipt.zip ?? null,
		shipping_country_iso: receipt.country_iso ?? null,
		first_product_title: firstTx?.title ?? null,
		first_listing_id: firstTx?.listing_id ?? null,
		first_quantity: firstTx?.quantity ?? null,
		first_ship_by: firstTx?.expected_ship_date ?? null,
		first_variations: firstTx?.variations ? JSON.stringify(firstTx.variations) : null,
		all_transactions: hasTransactions
			? JSON.stringify(
					receipt.transactions.map((t) => ({
						listing_id: t.listing_id ?? null,
						title: t.title ?? null,
						quantity: t.quantity ?? null,
						expected_ship_date: t.expected_ship_date ?? null,
						variations: t.variations ?? [],
						// Etsy attaches a shipping upgrade to a LISTING, so a multi-line order
						// can have one Express line and one standard line. Kept per line so the
						// packing bench can see WHICH product the buyer paid to rush.
						shipping_upgrade: shippingUpgrade.normalizeUpgradeName(t.shipping_upgrade) || null,
						shipping_method: shippingUpgrade.normalizeUpgradeName(t.shipping_method) || null,
					})),
				)
			: null,
		formatted_address: receipt.formatted_address ?? null,
		tracking_code: firstShip?.tracking_code ?? null,
		carrier_name: firstShip?.carrier_name ?? null,
		// was_shipped does not exist in Etsy v3 API — always null/0; retained for schema compat
		shipment_was_shipped: firstShip != null ? (firstShip.was_shipped ? 1 : 0) : null,
		// shipment_notification_timestamp: exact epoch when Etsy notified the buyer = label creation time
		shipment_notified_at: firstShip?.shipment_notification_timestamp ?? null,
		has_transactions: hasTransactions ? 1 : 0,
		shipping_upgrade: upgrade.name || null,
		shipping_method: upgrade.method || null,
		shipping_upgrade_tier: upgrade.tier || null,
		is_expedited: upgrade.expedited ? 1 : 0,
		etsy_created_at: receipt.create_timestamp ?? null,
		etsy_updated_at: receipt.update_timestamp ?? null,
		raw_json: JSON.stringify(receipt),
	})
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
	const money = (obj) => (obj && obj.divisor ? obj.amount / obj.divisor : null)
	const currency = (obj) => (obj ? obj.currency_code : null)

	db.prepare(
		`
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
  `,
	).run({
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
	})
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
	const t = String(ledgerType || description || '').toLowerCase()
	const rt = String(referenceType || '').toLowerCase()

	// ── Transfers / funding events — money moving between the Etsy balance and the
	// seller's bank/card, NOT earnings. These MUST be excluded from net, or the
	// total collapses to just the current undisbursed balance.
	// Detected primarily by reference_type because Etsy's ledger_type strings vary
	// (e.g. the disbursement type is "DISBURSE2", not "disbursement").
	if (rt === 'disbursement' || rt === 'recoupment' || rt === 'billing_payment' || t.includes('disburse') || t.includes('recoup') || t.includes('bill_payment') || t.includes('billing_payment') || t.includes('deposit') || t.includes('withdrawal') || t.includes('payout')) {
		return 'transfer'
	}

	if (t.includes('payment_gross') || t === 'payment') return 'sales'
	if (t.includes('processing_fee')) return 'processing_fee' // incl. vat_on_processing_fees
	if (t.includes('regulatory')) return 'regulatory_fee'
	if (t.includes('shipping_transaction') || t.includes('transaction')) return 'transaction_fee'
	if (t.includes('shipping_label') || t.includes('postage')) return 'shipping_label'
	if (t.includes('sales_tax') || t.includes('vat')) return 'tax'
	if (t.includes('prolist') || t.includes('offsite') || t.includes('etsy_ads') || t.includes('ads')) return 'ads'
	if (t.includes('subscription') || t.includes('tier_') || t.includes('etsy_plus')) return 'subscription'
	if (t.includes('renew') || t.includes('listing') || t.includes('publish')) return 'listing_fee'
	if (t.includes('refund')) return 'refund'
	if (t.includes('misc') || t.includes('credit')) return 'credit'
	return 'other'
}

/**
 * Resolve which receipt a ledger entry belongs to, using the entry's reference
 * fields plus our local payment→receipt and transaction→receipt maps.
 * Returns null for shop-level entries (subscriptions, ads, payouts, …).
 */
function resolveLedgerReceiptId(db, entry) {
	const refType = String(entry.reference_type || '').toLowerCase()
	const refId = entry.reference_id != null ? String(entry.reference_id) : null
	if (!refId) return null

	if (refType === 'receipt') return Number(refId)

	if (refType === 'shop_payment' || refType === 'processing_fee' || refType === 'payment') {
		const row = db.prepare('SELECT receipt_id FROM etsy_payments WHERE payment_id = ?').get(refId)
		return row?.receipt_id ?? null
	}

	if (refType === 'transaction') {
		const row = db.prepare('SELECT receipt_id FROM transactions WHERE transaction_id = ?').get(refId)
		return row?.receipt_id ?? null
	}

	return null
}

/** Upsert a payment_id → receipt_id mapping row. */
function upsertEtsyPayment(db, shopId, paymentId, receiptId) {
	if (paymentId == null || receiptId == null) return
	db.prepare(
		`
    INSERT INTO etsy_payments (payment_id, shop_id, receipt_id, synced_at)
    VALUES (@payment_id, @shop_id, @receipt_id, strftime('%s','now'))
    ON CONFLICT(payment_id) DO UPDATE SET
      receipt_id = excluded.receipt_id,
      synced_at  = excluded.synced_at
  `,
	).run({ payment_id: Number(paymentId), shop_id: shopId, receipt_id: Number(receiptId) })
}

/**
 * Upsert one ledger entry, computing its category and resolved receipt_id.
 * @param {Database.Database} db
 * @param {string} shopId
 * @param {object} e - raw PaymentAccountLedgerEntry from Etsy
 * @returns {number} the resolved receipt_id, or 0/NULL-ish if shop-level
 */
function upsertLedgerEntry(db, shopId, e) {
	const category = categorizeLedgerEntry(e.ledger_type, e.description, e.reference_type)
	const receiptId = resolveLedgerReceiptId(db, e)
	db.prepare(
		`
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
  `,
	).run({
		entry_id: Number(e.entry_id),
		shop_id: shopId,
		sequence_number: e.sequence_number ?? null,
		amount_cents: Math.round(Number(e.amount) || 0),
		currency: e.currency ?? null,
		ledger_type: e.ledger_type ?? null,
		reference_type: e.reference_type ?? null,
		reference_id: e.reference_id != null ? String(e.reference_id) : null,
		description: e.description ?? null,
		balance_cents: e.balance != null ? Math.round(Number(e.balance)) : null,
		create_date: e.create_date ?? e.created_timestamp ?? null,
		receipt_id: receiptId,
		category,
	})
	return receiptId
}

/**
 * Recompute the stored `category` for every ledger row using the current
 * categorization logic. Categories are a pure function of (ledger_type,
 * reference_type), so this is a fast local reshape (no API calls) that
 * self-heals historical rows whenever the rules change. Idempotent.
 * @returns {number} rows updated
 */
function recategorizeLedgerEntries(db) {
	let pairs
	try {
		pairs = db.prepare('SELECT DISTINCT ledger_type, reference_type FROM ledger_entries').all()
	} catch {
		return 0
	}
	if (!pairs.length) return 0

	const upd = db.prepare(`
    UPDATE ledger_entries SET category = @cat
    WHERE ledger_type IS @lt AND reference_type IS @rt AND category IS NOT @cat
  `)
	let changed = 0
	const run = db.transaction(() => {
		for (const p of pairs) {
			const cat = categorizeLedgerEntry(p.ledger_type, null, p.reference_type)
			changed += upd.run({ cat, lt: p.ledger_type, rt: p.reference_type }).changes
		}
	})
	run()
	if (changed) console.log(`[db] Re-categorized ${changed} ledger entr${changed === 1 ? 'y' : 'ies'} to current rules`)
	return changed
}

/**
 * Re-resolve receipt_id for ledger rows that are still unattributed but now
 * have a payment/transaction mapping available. Returns the number updated.
 */
function reattributeLedgerEntries(db, shopId) {
	const rows = db
		.prepare(
			`
    SELECT entry_id, reference_type, reference_id
    FROM ledger_entries
    WHERE shop_id = ? AND receipt_id IS NULL AND reference_id IS NOT NULL
  `,
		)
		.all(shopId)
	let updated = 0
	const upd = db.prepare('UPDATE ledger_entries SET receipt_id = ? WHERE entry_id = ?')
	const run = db.transaction(() => {
		for (const r of rows) {
			const rid = resolveLedgerReceiptId(db, r)
			if (rid != null) {
				upd.run(rid, r.entry_id)
				updated++
			}
		}
	})
	run()
	return updated
}

/** Update a shop's ledger high-water mark (max create_date synced). */
function updateShopLedgerSyncTime(db, shopId, epoch) {
	db.prepare('UPDATE shops SET ledger_synced_at = ? WHERE shop_id = ?').run(Math.trunc(epoch), shopId)
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
	const where = ['1=1']
	const params = {}
	if (opts.from != null) {
		where.push('l.create_date >= @from')
		params.from = opts.from
	}
	if (opts.to != null) {
		where.push('l.create_date <= @to')
		params.to = opts.to
	}
	if (opts.shopId) {
		where.push('l.shop_id = @shopId')
		params.shopId = opts.shopId
	}
	const W = where.join(' AND ')

	const byShop = db
		.prepare(
			`
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
  `,
		)
		.all(params)

	const byCurrency = db
		.prepare(
			`
    SELECT l.currency,
      SUM(CASE WHEN l.category='sales' THEN l.amount_cents ELSE 0 END) AS gross_cents,
      SUM(CASE WHEN l.category<>'transfer' THEN l.amount_cents ELSE 0 END) AS net_cents,
      SUM(CASE WHEN l.category NOT IN ('sales','transfer','tax','refund') THEN l.amount_cents ELSE 0 END) AS fees_cents,
      SUM(CASE WHEN l.category='tax' THEN l.amount_cents ELSE 0 END) AS tax_cents,
      SUM(CASE WHEN l.category='refund' THEN l.amount_cents ELSE 0 END) AS refund_cents
    FROM ledger_entries l
    WHERE ${W}
    GROUP BY l.currency
  `,
		)
		.all(params)

	const byCategory = db
		.prepare(
			`
    SELECT l.currency, l.category,
      SUM(l.amount_cents) AS amount_cents, COUNT(*) AS entries
    FROM ledger_entries l
    WHERE ${W}
    GROUP BY l.currency, l.category
    ORDER BY l.currency, amount_cents
  `,
		)
		.all(params)

	return { byShop, byCurrency, byCategory }
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
	const now = opts.now != null ? new Date(opts.now * 1000) : new Date()
	const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0)
	const from = Math.floor(start.getTime() / 1000)
	const label = start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

	const where = ['l.create_date >= @from']
	const params = { from }
	if (opts.shopId) {
		where.push('l.shop_id = @shopId')
		params.shopId = opts.shopId
	}
	const W = where.join(' AND ')

	const byCurrency = db
		.prepare(
			`
    SELECT l.currency,
      SUM(CASE WHEN l.category='sales' THEN l.amount_cents ELSE 0 END) AS gross_cents,
      SUM(CASE WHEN l.category<>'transfer' THEN l.amount_cents ELSE 0 END) AS net_cents,
      SUM(CASE WHEN l.category='ads' THEN l.amount_cents ELSE 0 END) AS marketing_cents
    FROM ledger_entries l
    WHERE ${W}
    GROUP BY l.currency
  `,
		)
		.all(params)

	return { from, label, byCurrency }
}

/**
 * Per-order earnings for a date window: groups attributed ledger entries by
 * receipt and joins order metadata. Offsite-Ads (ads) entries are shop-level
 * and not included per order.
 */
function getPerOrderEarnings(db, opts = {}) {
	const where = ['l.receipt_id IS NOT NULL']
	const params = {}
	if (opts.from != null) {
		where.push('l.create_date >= @from')
		params.from = opts.from
	}
	if (opts.to != null) {
		where.push('l.create_date <= @to')
		params.to = opts.to
	}
	if (opts.shopId) {
		where.push('l.shop_id = @shopId')
		params.shopId = opts.shopId
	}
	params.limit = Math.min(opts.limit ?? 500, 2000)
	params.offset = opts.offset ?? 0
	const W = where.join(' AND ')

	const rows = db
		.prepare(
			`
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
  `,
		)
		.all(params)

	const total = db
		.prepare(
			`
    SELECT COUNT(*) AS n FROM (
      SELECT l.receipt_id FROM ledger_entries l
      WHERE ${W} GROUP BY l.receipt_id, l.currency
    )
  `,
		)
		.get(params).n

	return { rows, total }
}

/** Quick per-shop ledger coverage stats for the UI (counts + last synced). */
function getLedgerStats(db) {
	return db
		.prepare(
			`
    SELECT shop_id,
      COUNT(*) AS entries,
      MIN(create_date) AS first_date,
      MAX(create_date) AS last_date
    FROM ledger_entries GROUP BY shop_id
  `,
		)
		.all()
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
	const where = ['l.balance_cents IS NOT NULL']
	const params = {}
	if (opts.shopId) {
		where.push('l.shop_id = @shopId')
		params.shopId = opts.shopId
	}
	const W = where.join(' AND ')

	return db
		.prepare(
			`
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
  `,
		)
		.all(params)
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
	const result = db
		.prepare(
			`
    INSERT INTO sync_log (shop_id, group_id, started_at, status, egress_ip)
    VALUES (@shop_id, @group_id, strftime('%s', 'now'), 'running', @egress_ip)
  `,
		)
		.run({ shop_id: shopId, group_id: groupId, egress_ip: egressIp })
	return result.lastInsertRowid
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
	db.prepare(
		`
    UPDATE sync_log SET
      completed_at    = strftime('%s', 'now'),
      status          = @status,
      receipts_synced = @receipts_synced,
      error_message   = @error_message
    WHERE id = @id
  `,
	).run({ id: logId, status, receipts_synced: receiptsSynced, error_message: errorMessage })
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
		const now = Math.floor(Date.now() / 1000)
		const staleBefore = now - ttlSec
		const row = db.prepare('SELECT owner, heartbeat_at FROM app_locks WHERE name = ?').get(name)

		if (!row) {
			db.prepare(
				`INSERT INTO app_locks (name, owner, acquired_at, heartbeat_at)
                  VALUES (?, ?, ?, ?)`,
			).run(name, owner, now, now)
			return true
		}

		// Already ours, or the previous holder's heartbeat is stale → (re)claim it.
		if (row.owner === owner || (row.heartbeat_at ?? 0) < staleBefore) {
			db.prepare(
				`UPDATE app_locks SET owner = ?, acquired_at = ?, heartbeat_at = ?
                  WHERE name = ?`,
			).run(owner, now, now, name)
			return true
		}

		return false // held by a live owner
	})

	try {
		return txn.immediate()
	} catch {
		// If two processes race the same write, SQLite raises SQLITE_BUSY for the
		// loser — treat that as "did not acquire" rather than throwing.
		return false
	}
}

/**
 * Refresh the heartbeat on a lock this process holds, so long-running jobs
 * keep the lock alive past its TTL. No-op if we are not the current owner.
 * @returns {boolean} true if the heartbeat was refreshed (we still hold it)
 */
function renewLock(db, name, owner) {
	const now = Math.floor(Date.now() / 1000)
	const res = db.prepare(`UPDATE app_locks SET heartbeat_at = ? WHERE name = ? AND owner = ?`).run(now, name, owner)
	return res.changes > 0
}

/**
 * Release a lock we hold. No-op if another process now owns it.
 */
function releaseLock(db, name, owner) {
	db.prepare('DELETE FROM app_locks WHERE name = ? AND owner = ?').run(name, owner)
}

// ─── 4PX tracking refresh telemetry ──────────────────────────────────────────

/**
 * Start a durable tracking-refresh run record.
 *
 * Any old "running" rows are marked interrupted first. A healthy concurrent run
 * cannot reach this function because the tracking advisory lock is acquired
 * before it, so a leftover running row necessarily belongs to a crashed process.
 *
 * @param {Database.Database} db
 * @param {string} trigger
 * @returns {number} inserted run id
 */
function startTrackingSyncRun(db, trigger = 'scheduled') {
	const now = Math.floor(Date.now() / 1000)
	const txn = db.transaction(() => {
		db.prepare(
			`
      UPDATE tracking_sync_runs
      SET status = 'interrupted',
          completed_at = COALESCE(completed_at, @now),
          duration_ms = COALESCE(duration_ms, MAX(0, (@now - started_at) * 1000)),
          error_message = COALESCE(error_message, 'Previous process stopped before the tracking refresh completed.')
      WHERE status = 'running'
    `,
		).run({ now })

		const result = db
			.prepare(
				`
      INSERT INTO tracking_sync_runs (trigger, status, started_at)
      VALUES (@trigger, 'running', @now)
    `,
			)
			.run({ trigger: String(trigger || 'scheduled').slice(0, 32), now })

		// Retain enough history for diagnostics without growing the local DB forever.
		db.prepare(
			`
      DELETE FROM tracking_sync_runs
      WHERE id NOT IN (
        SELECT id FROM tracking_sync_runs ORDER BY started_at DESC, id DESC LIMIT 200
      )
    `,
		).run()

		return Number(result.lastInsertRowid)
	})
	return txn()
}

/**
 * Finish a tracking-refresh run with its aggregate outcome.
 *
 * @param {Database.Database} db
 * @param {number} runId
 * @param {object} summary
 */
function finishTrackingSyncRun(db, runId, summary = {}) {
	const completedAt = Math.floor(Date.now() / 1000)
	const status = ['error', 'partial', 'interrupted'].includes(summary.status) ? summary.status : 'success'
	db.prepare(
		`
    UPDATE tracking_sync_runs SET
      status = @status,
      completed_at = @completedAt,
      candidate_count = @candidateCount,
      checked_count = @checkedCount,
      updated_count = @updatedCount,
      pre_transit = @preTransit,
      in_transit = @inTransit,
      delivered = @delivered,
      exception_count = @exceptionCount,
      unknown_count = @unknownCount,
      error_count = @errorCount,
      backlog_remaining = @backlogRemaining,
      duration_ms = @durationMs,
      error_message = @errorMessage
    WHERE id = @runId
  `,
	).run({
		runId,
		status,
		completedAt,
		candidateCount: Number(summary.candidateCount || 0),
		checkedCount: Number(summary.checkedCount || 0),
		updatedCount: Number(summary.updatedCount || 0),
		preTransit: Number(summary.preTransit || 0),
		inTransit: Number(summary.inTransit || 0),
		delivered: Number(summary.delivered || 0),
		exceptionCount: Number(summary.exception || 0),
		unknownCount: Number(summary.unknown || 0),
		errorCount: Number(summary.errors || 0),
		backlogRemaining: Number(summary.backlogRemaining || 0),
		durationMs: Number.isFinite(summary.durationMs) ? Math.max(0, Math.round(summary.durationMs)) : null,
		errorMessage: summary.error ? String(summary.error).slice(0, 2000) : null,
	})
}

/**
 * Persist bounded progress while a tracking run is active so a newly-opened
 * Shipping tab can show real progress even if it missed the SSE start event.
 */
function updateTrackingSyncRunProgress(db, runId, summary = {}) {
	db.prepare(
		`
    UPDATE tracking_sync_runs SET
      candidate_count = @candidateCount,
      checked_count = @checkedCount,
      updated_count = @updatedCount,
      pre_transit = @preTransit,
      in_transit = @inTransit,
      delivered = @delivered,
      exception_count = @exceptionCount,
      unknown_count = @unknownCount,
      error_count = @errorCount
    WHERE id = @runId AND status = 'running'
  `,
	).run({
		runId,
		candidateCount: Number(summary.candidateCount || summary.total || 0),
		checkedCount: Number(summary.checkedCount || summary.checked || 0),
		updatedCount: Number(summary.updatedCount || 0),
		preTransit: Number(summary.preTransit || 0),
		inTransit: Number(summary.inTransit || 0),
		delivered: Number(summary.delivered || 0),
		exceptionCount: Number(summary.exception || 0),
		unknownCount: Number(summary.unknown || 0),
		errorCount: Number(summary.errors || 0),
	})
}

/**
 * Latest persisted tracking-refresh run, or null before the first run.
 * @param {Database.Database} db
 * @returns {object|null}
 */
function getLatestTrackingSyncRun(db) {
	return (
		db
			.prepare(
				`
    SELECT *
    FROM tracking_sync_runs
    ORDER BY started_at DESC, id DESC
    LIMIT 1
  `,
			)
			.get() || null
	)
}

/**
 * Update the shop's last_synced_at and total_orders count.
 * @param {Database.Database} db
 * @param {string} shopId
 */
function updateShopSyncTime(db, shopId) {
	db.prepare(
		`
    UPDATE shops SET
      last_synced_at = strftime('%s', 'now'),
      total_orders   = (SELECT COUNT(*) FROM receipts WHERE shop_id = @shop_id)
    WHERE shop_id = @shop_id
  `,
	).run({ shop_id: shopId })
}

/**
 * UTC calendar date (YYYY-MM-DD) used as the snapshot grain. Etsy tabulates
 * listing.views once per day; mixing local-timezone days would split a single
 * tabulation across two rows.
 * @param {number} [nowMs]
 * @returns {string}
 */
function utcToday(nowMs = Date.now()) {
	return new Date(nowMs).toISOString().slice(0, 10)
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
	if (count == null || Number.isNaN(Number(count))) return
	updateShopHealth(db, shopId, { listing_active_count: count })
}

/**
 * Persist ranking-relevant shop fields from GET /shops/{shop_id} and take
 * today's shop-health snapshot. Missing fields are left unchanged so a
 * listing-count-only refresh cannot wipe review/vacation data.
 * @param {import('better-sqlite3').Database} db
 * @param {string} shopId
 * @param {object} shopData
 * @param {object} [extra]
 */
function updateShopHealth(db, shopId, shopData = {}, extra = {}) {
	if (!shopId) return
	const listingActive = shopData.listing_active_count ?? extra.listing_active_count
	const now = Math.floor(Date.now() / 1000)
	const row = {
		shop_id: shopId,
		listing_active_count: listingActive != null && !Number.isNaN(Number(listingActive)) ? Math.trunc(Number(listingActive)) : null,
		num_favorers: shopData.num_favorers != null ? Math.trunc(Number(shopData.num_favorers)) : null,
		transaction_sold_count: shopData.transaction_sold_count != null ? Math.trunc(Number(shopData.transaction_sold_count)) : null,
		review_count: shopData.review_count != null ? Math.trunc(Number(shopData.review_count)) : null,
		review_average: shopData.review_average != null && Number.isFinite(Number(shopData.review_average)) ? Number(shopData.review_average) : null,
		is_vacation: typeof shopData.is_vacation === 'boolean' ? (shopData.is_vacation ? 1 : 0) : shopData.is_vacation != null ? (shopData.is_vacation ? 1 : 0) : null,
		listing_count_synced_at: listingActive != null && !Number.isNaN(Number(listingActive)) ? now : null,
	}

	const current = db.prepare('SELECT * FROM shops WHERE shop_id = ?').get(shopId)
	if (!current) return

	db.prepare(
		`
    UPDATE shops SET
      listing_active_count    = COALESCE(@listing_active_count, listing_active_count),
      listing_count_synced_at = COALESCE(@listing_count_synced_at, listing_count_synced_at),
      num_favorers             = COALESCE(@num_favorers, num_favorers),
      transaction_sold_count  = COALESCE(@transaction_sold_count, transaction_sold_count),
      review_count             = COALESCE(@review_count, review_count),
      review_average           = COALESCE(@review_average, review_average),
      is_vacation              = COALESCE(@is_vacation, is_vacation)
    WHERE shop_id = @shop_id
  `,
	).run(row)

	upsertShopHealthSnapshot(db, shopId, {
		listing_active_count: row.listing_active_count,
		num_favorers: row.num_favorers,
		transaction_sold_count: row.transaction_sold_count,
		review_count: row.review_count,
		review_average: row.review_average,
		is_vacation: row.is_vacation,
		...extra,
	})
}

/**
 * Upsert today's shop-health snapshot. Null fields in `fields` leave the stored
 * value in place so a listing-count refresh cannot wipe catalog-state counts.
 * @param {import('better-sqlite3').Database} db
 * @param {string} shopId
 * @param {object} fields
 * @param {string} [capturedOn]
 */
function upsertShopHealthSnapshot(db, shopId, fields = {}, capturedOn = utcToday()) {
	if (!shopId || !capturedOn) return
	const existing = db.prepare('SELECT * FROM shop_health_snapshots WHERE shop_id = ? AND captured_on = ?').get(shopId, capturedOn) || {}
	const pick = (key) => {
		const v = fields[key]
		return v == null ? (existing[key] ?? null) : v
	}
	db.prepare(
		`
    INSERT INTO shop_health_snapshots (
      shop_id, captured_on,
      listing_active_count, listing_inactive_count, listing_sold_out_count,
      listing_expired_count, listing_draft_count,
      num_favorers, transaction_sold_count, review_count, review_average, is_vacation
    ) VALUES (
      @shop_id, @captured_on,
      @listing_active_count, @listing_inactive_count, @listing_sold_out_count,
      @listing_expired_count, @listing_draft_count,
      @num_favorers, @transaction_sold_count, @review_count, @review_average, @is_vacation
    )
    ON CONFLICT(shop_id, captured_on) DO UPDATE SET
      listing_active_count    = COALESCE(excluded.listing_active_count, listing_active_count),
      listing_inactive_count  = COALESCE(excluded.listing_inactive_count, listing_inactive_count),
      listing_sold_out_count  = COALESCE(excluded.listing_sold_out_count, listing_sold_out_count),
      listing_expired_count   = COALESCE(excluded.listing_expired_count, listing_expired_count),
      listing_draft_count     = COALESCE(excluded.listing_draft_count, listing_draft_count),
      num_favorers             = COALESCE(excluded.num_favorers, num_favorers),
      transaction_sold_count  = COALESCE(excluded.transaction_sold_count, transaction_sold_count),
      review_count            = COALESCE(excluded.review_count, review_count),
      review_average           = COALESCE(excluded.review_average, review_average),
      is_vacation              = COALESCE(excluded.is_vacation, is_vacation)
  `,
	).run({
		shop_id: shopId,
		captured_on: capturedOn,
		listing_active_count: pick('listing_active_count'),
		listing_inactive_count: pick('listing_inactive_count'),
		listing_sold_out_count: pick('listing_sold_out_count'),
		listing_expired_count: pick('listing_expired_count'),
		listing_draft_count: pick('listing_draft_count'),
		num_favorers: pick('num_favorers'),
		transaction_sold_count: pick('transaction_sold_count'),
		review_count: pick('review_count'),
		review_average: pick('review_average'),
		is_vacation: pick('is_vacation'),
	})
}

function markCatalogHealthSynced(db, shopId, atSec = Math.floor(Date.now() / 1000)) {
	if (!shopId) return
	db.prepare('UPDATE shops SET catalog_health_synced_at = ? WHERE shop_id = ?').run(atSec, shopId)
}

function markReviewsSynced(db, shopId, atSec = Math.floor(Date.now() / 1000)) {
	if (!shopId) return
	db.prepare('UPDATE shops SET reviews_synced_at = ? WHERE shop_id = ?').run(atSec, shopId)
}

/**
 * Daily listing-metric snapshot. Same-day syncs overwrite so the last
 * tabulated views for that UTC day win.
 * @param {import('better-sqlite3').Database} db
 * @param {string} shopId
 * @param {object} listing
 * @param {string} [capturedOn]
 */
function snapshotListingMetrics(db, shopId, listing, capturedOn = utcToday()) {
	if (!listing?.listing_id || !shopId || !capturedOn) return
	const views = listing.views == null ? null : Number(listing.views)
	db.prepare(
		`
    INSERT INTO listing_metric_snapshots (
      listing_id, shop_id, captured_on, views, num_favorers, quantity, state
    ) VALUES (
      @listing_id, @shop_id, @captured_on, @views, @num_favorers, @quantity, @state
    )
    ON CONFLICT(listing_id, captured_on) DO UPDATE SET
      views        = excluded.views,
      num_favorers = excluded.num_favorers,
      quantity     = excluded.quantity,
      state        = excluded.state
  `,
	).run({
		listing_id: listing.listing_id,
		shop_id: shopId,
		captured_on: capturedOn,
		views: Number.isFinite(views) ? Math.trunc(views) : null,
		num_favorers: listing.num_favorers == null ? null : Math.trunc(Number(listing.num_favorers)),
		quantity: listing.quantity == null ? null : Math.trunc(Number(listing.quantity)),
		state: listing.state || null,
	})
}

const MAX_REVIEW_TEXT = 2000

/**
 * Upsert a shop review. Buyer identity is never persisted.
 * @param {import('better-sqlite3').Database} db
 * @param {string} shopId
 * @param {object} review
 */
function upsertEtsyReview(db, shopId, review) {
	const transactionId = Number(review?.transaction_id)
	if (!shopId || !Number.isInteger(transactionId) || transactionId <= 0) return
	const created = review.created_timestamp ?? review.create_timestamp ?? null
	const updated = review.updated_timestamp ?? review.update_timestamp ?? created
	const text = review.review == null ? null : String(review.review).slice(0, MAX_REVIEW_TEXT)
	const rating = review.rating == null ? null : Math.trunc(Number(review.rating))
	db.prepare(
		`
    INSERT INTO etsy_reviews (
      transaction_id, shop_id, listing_id, rating, review, language, image_url,
      created_timestamp, updated_timestamp, synced_at
    ) VALUES (
      @transaction_id, @shop_id, @listing_id, @rating, @review, @language, @image_url,
      @created_timestamp, @updated_timestamp, strftime('%s', 'now')
    )
    ON CONFLICT(transaction_id) DO UPDATE SET
      listing_id         = excluded.listing_id,
      rating              = excluded.rating,
      review              = excluded.review,
      language            = excluded.language,
      image_url           = excluded.image_url,
      updated_timestamp   = excluded.updated_timestamp,
      synced_at           = strftime('%s', 'now')
  `,
	).run({
		transaction_id: transactionId,
		shop_id: shopId,
		listing_id: review.listing_id == null ? null : Number(review.listing_id),
		rating: Number.isFinite(rating) ? Math.min(5, Math.max(1, rating)) : null,
		review: text,
		language: review.language || null,
		image_url: review.image_url_fullxfull || null,
		created_timestamp: created == null ? null : Math.trunc(Number(created)),
		updated_timestamp: updated == null ? null : Math.trunc(Number(updated)),
	})
}

/**
 * Cache a listing image URL.
 * @param {Database.Database} db
 * @param {number} listingId
 * @param {string} url
 */
function upsertListingImage(db, listingId, url) {
	db.prepare(
		`
    INSERT INTO listing_images (listing_id, url, cached_at)
    VALUES (?, ?, strftime('%s', 'now'))
    ON CONFLICT(listing_id) DO UPDATE SET url = excluded.url, cached_at = excluded.cached_at
  `,
	).run(listingId, url)
}

/**
 * Return cached image bytes for a listing, or null if not yet fetched.
 * @param {Database.Database} db
 * @param {number} listingId
 * @returns {Buffer|null}
 */
function getListingImageData(db, listingId) {
	try {
		const row = db.prepare('SELECT data FROM listing_image_data WHERE listing_id = ?').get(listingId)
		if (row && row.data && row.data.length > 0) return row.data
	} catch {
		/* table not yet initialized on very first start */
	}
	return null
}

/**
 * Persist raw image bytes for a listing to the local cache.
 * Upserts so repeated calls are idempotent.
 * @param {Database.Database} db
 * @param {number} listingId
 * @param {Buffer} data
 */
function upsertListingImageData(db, listingId, data) {
	db.prepare(
		`
    INSERT INTO listing_image_data (listing_id, data, cached_at)
    VALUES (?, ?, strftime('%s', 'now'))
    ON CONFLICT(listing_id) DO UPDATE
      SET data = excluded.data, cached_at = excluded.cached_at
  `,
	).run(listingId, data)
}

/**
 * Upsert a listing from the Etsy API response into the local cache.
 * @param {import('better-sqlite3').Database} db
 * @param {string} shopId
 * @param {object} listing - raw Etsy listing object
 * @param {{ analyticsMetrics?: boolean, snapshotMetrics?: boolean }} [options]
 *   View/favorite persistence and daily snapshots are opt-in because Etsy API
 *   Terms require written authorization for analytics use. snapshotMetrics
 *   implies analyticsMetrics.
 */
function upsertListing(db, shopId, listing, options = {}) {
	const primaryImage = Array.isArray(listing.images) && listing.images.length > 0 ? listing.images[0].url_570xN || listing.images[0].url_fullxfull || null : null
	const imageCount = Array.isArray(listing.images) ? listing.images.length : listing.image_count == null ? null : Number(listing.image_count)
	const includeAnalytics = options.analyticsMetrics === true || options.snapshotMetrics === true

	db.prepare(
		`
    INSERT INTO listings (
      listing_id, shop_id, title, description,
      price_amount, price_currency, quantity, state,
      views, num_favorers, tags, primary_image_url, listing_url,
      taxonomy_id, shipping_profile_id, return_policy_id,
      who_made, when_made, is_customizable,
      created_timestamp, updated_timestamp,
      ending_timestamp, featured_rank, shop_section_id,
      has_variations, should_auto_renew, image_count,
      processing_min, processing_max, synced_at
    ) VALUES (
      @listing_id, @shop_id, @title, @description,
      @price_amount, @price_currency, @quantity, @state,
      @views, @num_favorers, @tags, @primary_image_url, @listing_url,
      @taxonomy_id, @shipping_profile_id, @return_policy_id,
      @who_made, @when_made, @is_customizable,
      @created_timestamp, @updated_timestamp,
      @ending_timestamp, @featured_rank, @shop_section_id,
      @has_variations, @should_auto_renew, @image_count,
      @processing_min, @processing_max, strftime('%s', 'now')
    )
    ON CONFLICT(listing_id) DO UPDATE SET
      title               = excluded.title,
      description         = excluded.description,
      price_amount        = excluded.price_amount,
      price_currency      = excluded.price_currency,
      quantity            = excluded.quantity,
      state               = excluded.state,
      views               = CASE
                              WHEN @include_analytics = 1 AND excluded.views IS NOT NULL THEN excluded.views
                              ELSE listings.views
                            END,
      num_favorers        = CASE
                              WHEN @include_analytics = 1 AND excluded.num_favorers IS NOT NULL THEN excluded.num_favorers
                              ELSE listings.num_favorers
                            END,
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
      ending_timestamp    = excluded.ending_timestamp,
      featured_rank       = excluded.featured_rank,
      shop_section_id     = excluded.shop_section_id,
      has_variations      = excluded.has_variations,
      should_auto_renew   = excluded.should_auto_renew,
      image_count         = excluded.image_count,
      processing_min      = excluded.processing_min,
      processing_max      = excluded.processing_max,
      synced_at           = strftime('%s', 'now')
  `,
	).run({
		listing_id: listing.listing_id,
		shop_id: shopId,
		title: listing.title || null,
		description: listing.description || null,
		price_amount: listing.price ? listing.price.amount / listing.price.divisor : null,
		price_currency: listing.price ? listing.price.currency_code : null,
		quantity: listing.quantity ?? null,
		state: listing.state || null,
		views: includeAnalytics && listing.views != null ? Number(listing.views) : null,
		num_favorers: includeAnalytics && listing.num_favorers != null ? Number(listing.num_favorers) : null,
		include_analytics: includeAnalytics ? 1 : 0,
		tags: Array.isArray(listing.tags) ? JSON.stringify(listing.tags) : null,
		primary_image_url: primaryImage,
		listing_url: listing.url || null,
		taxonomy_id: listing.taxonomy_id ?? null,
		shipping_profile_id: listing.shipping_profile_id ?? null,
		return_policy_id: listing.return_policy_id ?? null,
		who_made: listing.who_made || null,
		when_made: listing.when_made || null,
		is_customizable: listing.is_customizable ? 1 : 0,
		created_timestamp: listing.created_timestamp ?? listing.creation_timestamp ?? null,
		updated_timestamp: listing.updated_timestamp ?? listing.last_modified_timestamp ?? null,
		ending_timestamp: listing.ending_timestamp ?? null,
		featured_rank: listing.featured_rank ?? null,
		shop_section_id: listing.shop_section_id ?? null,
		has_variations: listing.has_variations == null ? null : listing.has_variations ? 1 : 0,
		should_auto_renew: listing.should_auto_renew == null ? null : listing.should_auto_renew ? 1 : 0,
		image_count: Number.isFinite(imageCount) ? imageCount : null,
		processing_min: listing.processing_min ?? null,
		processing_max: listing.processing_max ?? null,
	})
	if (options.snapshotMetrics === true) snapshotListingMetrics(db, shopId, listing)
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
	if (!seenIds || seenIds.size === 0) return 0 // never prune against an empty sync

	const local = db.prepare('SELECT listing_id FROM listings WHERE shop_id = ? AND state = ?').all(shopId, state)

	const stale = local.map((r) => r.listing_id).filter((id) => !seenIds.has(id))

	if (!stale.length) return 0

	const delInventory = db.prepare('DELETE FROM listing_inventory WHERE listing_id = ?')
	const delListing = db.prepare('DELETE FROM listings WHERE listing_id = ?')
	const prune = db.transaction((ids) => {
		for (const id of ids) {
			delInventory.run(id)
			delListing.run(id)
		}
	})
	prune(stale)

	return stale.length
}

/**
 * Upsert one inventory product row (one variation combination).
 * Extracts 'Style' and a secondary property automatically.
 */
function upsertListingInventory(db, listingId, product, offering) {
	const propValues = product.property_values || []

	// Robustly split the variation into its style vs. model dimensions so the
	// stored style_value is always the clean, restock-relevant label (model
	// stripped) regardless of how the shop named its properties.
	const { styleVal, secondaryVal } = deriveVariationLabels(propValues)

	db.prepare(
		`
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
  `,
	).run({
		listing_id: listingId,
		product_id: product.product_id,
		offering_id: offering?.offering_id ?? null,
		style_value: styleVal,
		secondary_value: secondaryVal,
		property_values: JSON.stringify(propValues),
		quantity: offering?.quantity ?? 0,
		is_enabled: offering?.is_enabled ? 1 : 0,
		price_amount: offering?.price ? offering.price.amount / offering.price.divisor : null,
		price_currency: offering?.price?.currency_code ?? null,
	})
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
	if (!seenProductIds || seenProductIds.size === 0) return 0

	const local = db.prepare('SELECT product_id FROM listing_inventory WHERE listing_id = ?').all(listingId)

	const stale = local.map((r) => r.product_id).filter((pid) => !seenProductIds.has(pid))

	if (!stale.length) return 0

	const del = db.prepare('DELETE FROM listing_inventory WHERE listing_id = ? AND product_id = ?')
	const prune = db.transaction((ids) => {
		for (const pid of ids) del.run(listingId, pid)
	})
	prune(stale)

	return stale.length
}

/**
 * Log an event (zero-stock alert, auto-restock, error, etc.)
 */
function logEvent(db, { event_type, shop_name, listing_id, listing_title, style_value, detail, meta }) {
	db.prepare(
		`
    INSERT INTO events (event_type, shop_name, listing_id, listing_title, style_value, detail, meta)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
	).run(event_type, shop_name || null, listing_id || null, listing_title || null, style_value || null, detail || null, meta ? JSON.stringify(meta) : null)
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
	db.prepare(
		`
    UPDATE receipts SET
      carrier_confirmed_at = COALESCE(carrier_confirmed_at, @carrier_confirmed_at),
      tracking_checked_at  = @tracking_checked_at
    WHERE receipt_id = @receipt_id
  `,
	).run({
		receipt_id: receiptId,
		carrier_confirmed_at: carrierConfirmedAt ?? null,
		tracking_checked_at: trackingCheckedAt,
	})
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
 * @param {string|null} [opts.refNo]           Customer reference sent to 4PX
 * @param {string|null} [opts.consignmentNo]   ds_consignment_no from 4PX
 * @param {string|null} [opts.trackingNo]      4px_tracking_no from 4PX
 * @param {string|null} [opts.labelUrl]        Shipping label PDF URL (from label.get)
 * @param {string}      [opts.status]          'created' | 'label_fetched' | 'cancelled' | 'error'
 * @param {boolean}     [opts.replaceExisting] Replace a previously-cancelled shipment
 */
function upsertFourpxShipment(db, receiptId, { refNo = null, consignmentNo = null, trackingNo = null, labelUrl = null, status = 'created', replaceExisting = false } = {}) {
	db.prepare(
		`
    UPDATE receipts SET
      fourpx_ref_no          = COALESCE(@refNo, fourpx_ref_no),
      fourpx_consignment_no = CASE WHEN @replaceExisting = 1
        THEN @consignmentNo ELSE COALESCE(fourpx_consignment_no, @consignmentNo) END,
      fourpx_tracking_no    = CASE WHEN @replaceExisting = 1
        THEN @trackingNo ELSE COALESCE(fourpx_tracking_no, @trackingNo) END,
      fourpx_label_url      = CASE WHEN @replaceExisting = 1
        THEN @labelUrl ELSE COALESCE(@labelUrl, fourpx_label_url) END,
      fourpx_order_status   = @status,
      fourpx_created_at     = CASE WHEN @replaceExisting = 1
        THEN @now ELSE COALESCE(fourpx_created_at, @now) END
    WHERE receipt_id = @receiptId
  `,
	).run({
		receiptId,
		refNo,
		consignmentNo,
		trackingNo,
		labelUrl,
		status,
		replaceExisting: replaceExisting ? 1 : 0,
		now: Math.floor(Date.now() / 1000),
	})
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
 * @param {boolean} [opts.replaceExisting]  Reset inputs/freight for a replacement shipment.
 */
function recordFourpxShipmentInputs(db, receiptId, { productCode = null, weightG = null, replaceExisting = false } = {}) {
	if (replaceExisting) {
		db.prepare(
			`
      UPDATE receipts SET
        fourpx_product_code       = @productCode,
        fourpx_weight_g           = @weightG,
        fourpx_freight_amount     = NULL,
        fourpx_freight_currency   = NULL,
        fourpx_billed_weight_g    = NULL,
        fourpx_freight_breakdown  = NULL,
        fourpx_freight_status     = 'pending',
        fourpx_freight_fetched_at = NULL,
        carrier_confirmed_at      = NULL,
        tracking_checked_at       = NULL,
        tracking_next_check_at    = NULL,
        tracking_status           = NULL,
        tracking_last_event_at    = NULL,
        tracking_last_event       = NULL,
        tracking_last_location    = NULL,
        tracking_delivered_at     = NULL,
        tracking_health           = NULL,
        tracking_health_reason    = NULL,
        tracking_is_disposed      = 0,
        shipping_claim_note       = NULL,
        shipping_claim_status     = NULL,
        shipping_claim_updated_at = NULL,
        shipping_buyer_notified_at = NULL,
        shipping_buyer_notice_kind = NULL,
        shipping_buyer_notified_by = NULL,
        shipping_buyer_notice_body = NULL
      WHERE receipt_id = @receiptId
    `,
		).run({
			receiptId,
			productCode: productCode || null,
			weightG: Number.isFinite(weightG) ? Math.round(weightG) : null,
		})
		return
	}
	db.prepare(
		`
    UPDATE receipts SET
      fourpx_product_code = COALESCE(@productCode, fourpx_product_code),
      fourpx_weight_g     = COALESCE(@weightG,     fourpx_weight_g)
    WHERE receipt_id = @receiptId
  `,
	).run({
		receiptId,
		productCode: productCode || null,
		weightG: Number.isFinite(weightG) ? Math.round(weightG) : null,
	})
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
function recordFourpxFreight(db, receiptId, { status, totalFee = null, currency = null, billedWeightG = null, feeItems = null } = {}) {
	const now = Math.floor(Date.now() / 1000)
	const cur = db.prepare('SELECT fourpx_freight_status AS s FROM receipts WHERE receipt_id = ?').get(receiptId)
	const curStatus = cur ? cur.s : null

	const hasAmount = totalFee !== null && totalFee !== undefined
	// Decide whether to overwrite the stored amount fields.
	const writeAmount = (status === 'billed' && hasAmount) || (status === 'estimated' && hasAmount && curStatus !== 'billed')

	// Decide the status to store. Never downgrade billed→estimated/pending, and never
	// overwrite an existing estimate with a bare 'pending' (keep the useful estimate).
	let writeStatus = status
	if (curStatus === 'billed' && status !== 'billed') writeStatus = 'billed'
	else if (curStatus === 'estimated' && status === 'pending') writeStatus = 'estimated'

	if (writeAmount) {
		db.prepare(
			`
      UPDATE receipts SET
        fourpx_freight_amount    = @totalFee,
        fourpx_freight_currency  = @currency,
        fourpx_billed_weight_g   = @billedWeightG,
        fourpx_freight_breakdown = @breakdown,
        fourpx_freight_status    = @status,
        fourpx_freight_fetched_at = @now
      WHERE receipt_id = @receiptId
    `,
		).run({
			receiptId,
			totalFee,
			currency: currency ?? null,
			billedWeightG: billedWeightG ?? null,
			breakdown: Array.isArray(feeItems) && feeItems.length ? JSON.stringify(feeItems) : null,
			status: writeStatus,
			now,
		})
	} else {
		// Status / timestamp only — preserve any previously resolved amount.
		db.prepare(
			`
      UPDATE receipts SET
        fourpx_freight_status    = @status,
        fourpx_freight_fetched_at = @now
      WHERE receipt_id = @receiptId
    `,
		).run({ receiptId, status: writeStatus, now })
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 4PX collection appointments (揽收预约) — the pickup outbox.
//
// See the fourpx_pickup_appointments DDL above for why this is an outbox rather
// than a mirror of 4PX state, and why a row exists before the API call.
// ─────────────────────────────────────────────────────────────────────────────

/** Every state a pickup-appointment row can be in. */
const FOURPX_PICKUP_STATUSES = Object.freeze(['submitting', 'submitted', 'failed', 'unknown', 'cancelled'])

/**
 * States in which a driver may actually be coming, so the parcels are spoken
 * for and a second booking for the same day would be a double dispatch.
 *
 * 'unknown' is included deliberately: when the transport died mid-call we do
 * not know whether 4PX booked it, and the safe reading of "maybe booked" is
 * "treat it as booked and make the human check the portal".
 */
const FOURPX_PICKUP_BLOCKING_STATUSES = Object.freeze(['submitting', 'submitted', 'unknown'])

/** A 'submitting' row older than this was orphaned by a crash mid-call. */
const FOURPX_PICKUP_SUBMITTING_STALE_SEC = 10 * 60

const _PICKUP_BLOCKING_SQL = FOURPX_PICKUP_BLOCKING_STATUSES.map((s) => `'${s}'`).join(', ')

/** Receipts that are cancelled/refunded are never part of a pickup. */
const _PICKUP_LIVE_RECEIPT_SQL = "r.status NOT IN ('Canceled', 'Cancelled', 'Fully Refunded', 'Fully refunded')"

/**
 * Reserve a pickup-appointment row BEFORE calling 4PX.
 *
 * Writing first is what makes an unacknowledged booking recoverable: if the
 * process dies between here and the response, the row survives as 'submitting'
 * and is later reported as 'unknown' instead of vanishing and inviting a
 * double-book.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} opts
 * @param {string} opts.reserveDate  YYYY-MM-DD sent as reserve_time
 * @param {object} opts.pickup       normalized pickup_info
 * @param {string|null} [opts.createdBy]
 * @returns {number} the new row's id
 */
function openFourpxPickupAppointment(db, { reserveDate, pickup = {}, createdBy = null } = {}) {
	const info = db
		.prepare(
			`
    INSERT INTO fourpx_pickup_appointments (
      reserve_date, status, contact_name, contact_phone, country, province,
      city, district, street, detail_address, zip_code, created_by, created_at
    ) VALUES (
      @reserveDate, 'submitting', @name, @phone, @country, @province,
      @city, @district, @street, @detailAddress, @zipCode, @createdBy, @now
    )
  `,
		)
		.run({
			reserveDate,
			name: pickup.name ?? null,
			phone: pickup.phone ?? null,
			country: pickup.country ?? null,
			province: pickup.province ?? null,
			city: pickup.city ?? null,
			district: pickup.district ?? null,
			street: pickup.street ?? null,
			detailAddress: pickup.detail_address ?? null,
			zipCode: pickup.zip_code ?? null,
			createdBy,
			now: Math.floor(Date.now() / 1000),
		})
	return Number(info.lastInsertRowid)
}

/**
 * Record the outcome of the create call against a reserved row.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} id
 * @param {object} opts
 * @param {'submitted'|'failed'|'unknown'} opts.status
 * @param {string|null} [opts.collectNo]     required for 'submitted'
 * @param {string|null} [opts.errorMessage]
 */
function resolveFourpxPickupAppointment(db, id, { status, collectNo = null, errorMessage = null } = {}) {
	if (!FOURPX_PICKUP_STATUSES.includes(status)) {
		throw new Error(`resolveFourpxPickupAppointment: unknown status "${status}"`)
	}
	db.prepare(
		`
    UPDATE fourpx_pickup_appointments
       SET collect_no    = COALESCE(@collectNo, collect_no),
           status        = @status,
           error_message = @errorMessage,
           resolved_at   = @now
     WHERE id = @id
  `,
	).run({
		id,
		collectNo: collectNo || null,
		status,
		errorMessage: errorMessage ? String(errorMessage).slice(0, 500) : null,
		now: Math.floor(Date.now() / 1000),
	})
}

/**
 * Attach the sealed parcels this pickup was booked for, and cache their count.
 *
 * Idempotent (INSERT OR IGNORE) so a partially-applied write can be replayed.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} id
 * @param {{receipt_id: number, tracking_no?: string|null}[]} parcels
 * @returns {number} how many parcels are attached afterwards
 */
function attachFourpxPickupParcels(db, id, parcels = []) {
	const insert = db.prepare(`
    INSERT OR IGNORE INTO fourpx_pickup_appointment_orders (appointment_id, receipt_id, tracking_no)
    VALUES (@id, @receiptId, @trackingNo)
  `)
	const apply = db.transaction((rows) => {
		for (const p of rows) {
			const receiptId = Number(p && p.receipt_id)
			if (!Number.isFinite(receiptId)) continue
			insert.run({ id, receiptId, trackingNo: (p && p.tracking_no) || null })
		}
		const { n } = db.prepare('SELECT COUNT(*) AS n FROM fourpx_pickup_appointment_orders WHERE appointment_id = ?').get(id)
		db.prepare('UPDATE fourpx_pickup_appointments SET parcel_count = ? WHERE id = ?').run(n, id)
		return n
	})
	return apply(Array.isArray(parcels) ? parcels : [])
}

/** Cache the appointment-form PDF URL returned by 打印预约单. */
function setFourpxPickupFormUrl(db, id, formUrl) {
	db.prepare('UPDATE fourpx_pickup_appointments SET form_url = ? WHERE id = ?').run(formUrl || null, id)
}

/**
 * Mark an appointment cancelled locally (after 4PX confirmed the cancellation).
 *
 * The parcel attachments are removed so those parcels immediately count as
 * awaiting pickup again — a cancelled pickup must not leave a parcel invisibly
 * "already booked".
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} id
 * @param {object} [opts]
 * @param {string|null} [opts.by]
 * @param {string|null} [opts.reason]
 */
function cancelFourpxPickupAppointment(db, id, { by = null, reason = null } = {}) {
	const apply = db.transaction(() => {
		db.prepare(
			`
      UPDATE fourpx_pickup_appointments
         SET status = 'cancelled', cancelled_at = @now, cancelled_by = @by, cancel_reason = @reason
       WHERE id = @id
    `,
		).run({ id, now: Math.floor(Date.now() / 1000), by, reason: reason || null })
		db.prepare('DELETE FROM fourpx_pickup_appointment_orders WHERE appointment_id = ?').run(id)
		db.prepare('UPDATE fourpx_pickup_appointments SET parcel_count = 0 WHERE id = ?').run(id)
	})
	apply()
}

/**
 * Look up one appointment by row id or by the 4PX appointment number.
 * @returns {object|null}
 */
function getFourpxPickupAppointment(db, { id = null, collectNo = null } = {}) {
	if (id != null) {
		return db.prepare('SELECT * FROM fourpx_pickup_appointments WHERE id = ?').get(id) || null
	}
	if (collectNo) {
		return db.prepare('SELECT * FROM fourpx_pickup_appointments WHERE collect_no = ?').get(collectNo) || null
	}
	return null
}

/**
 * The live appointment for a given date, if any — the double-book guard.
 * @returns {object|null}
 */
function findActiveFourpxPickupAppointment(db, reserveDate) {
	return (
		db
			.prepare(
				`
    SELECT * FROM fourpx_pickup_appointments
     WHERE reserve_date = ?
       AND status IN (${_PICKUP_BLOCKING_SQL})
     ORDER BY created_at DESC
     LIMIT 1
  `,
			)
			.get(reserveDate) || null
	)
}

/**
 * Demote 'submitting' rows abandoned by a crash to 'unknown', so they stop
 * looking like an in-flight request forever while still blocking a blind rebook.
 *
 * @returns {number} rows demoted
 */
function pruneStaleFourpxPickupAppointments(db, nowMs = Date.now()) {
	const cutoff = Math.floor(nowMs / 1000) - FOURPX_PICKUP_SUBMITTING_STALE_SEC
	return db
		.prepare(
			`
    UPDATE fourpx_pickup_appointments
       SET status = 'unknown',
           resolved_at = COALESCE(resolved_at, @now),
           error_message = COALESCE(error_message,
             'The dashboard stopped before 4PX answered. Check 揽收预约 in the 4PX portal before booking this day again.')
     WHERE status = 'submitting' AND created_at < @cutoff
  `,
		)
		.run({ cutoff, now: Math.floor(nowMs / 1000) }).changes
}

/**
 * Recent pickup appointments, newest first, with their attached parcels.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [opts]
 * @param {number} [opts.limit=20]
 * @param {number} [opts.windowDays=30]  ignore anything booked longer ago
 * @returns {object[]}
 */
function listFourpxPickupAppointments(db, { limit = 20, windowDays = 30 } = {}) {
	const cap = Math.min(200, Math.max(1, Math.floor(Number(limit) || 20)))
	const cutoff = Math.floor(Date.now() / 1000) - Math.max(1, Math.floor(Number(windowDays) || 30)) * 86_400
	const rows = db
		.prepare(
			`
    SELECT * FROM fourpx_pickup_appointments
     WHERE created_at >= @cutoff
     ORDER BY created_at DESC
     LIMIT @cap
  `,
		)
		.all({ cutoff, cap })
	if (!rows.length) return []
	const parcels = db
		.prepare(
			`
    SELECT appointment_id, receipt_id, tracking_no
      FROM fourpx_pickup_appointment_orders
     WHERE appointment_id IN (${rows.map(() => '?').join(',')})
  `,
		)
		.all(...rows.map((r) => r.id))
	const byAppointment = new Map()
	for (const p of parcels) {
		if (!byAppointment.has(p.appointment_id)) byAppointment.set(p.appointment_id, [])
		byAppointment.get(p.appointment_id).push({ receipt_id: p.receipt_id, tracking_no: p.tracking_no })
	}
	return rows.map((r) => ({ ...r, parcels: byAppointment.get(r.id) || [] }))
}

/**
 * Sealed 4PX parcels that no live appointment covers — i.e. what the driver
 * still has to be booked for.
 *
 * "Sealed and still here" is the conjunction of five independent facts, all of
 * which have to hold or the parcel is not waiting on a pickup at all:
 *   • packaged_at        — a packer physically sealed it
 *   • a 4PX consignment  — it has a paid 4PX label to hand over
 *   • carrier_confirmed_at IS NULL — 4PX has not scanned it yet (once scanned,
 *     it is in the network and a pickup is moot)
 *   • no blocking appointment row — nobody has already booked it
 *   • sealed within `withinDays` — see below
 *
 * WHY THE RECENCY BOUND IS PART OF THE DEFINITION
 * ────────────────────────────────────────────────────────────────────────────
 * "Not scanned by 4PX" is a weaker signal than it looks: carrier_confirmed_at
 * is only ever set by a successful tracking lookup, so a parcel that was handed
 * over months ago but whose tracking never resolved still reads as unscanned
 * forever. On a live database that is dozens of long-gone parcels, and counting
 * them would make the pickup bar shout about 37 parcels "waiting" when the bench
 * is empty — the fastest way to teach an operator to ignore a number.
 *
 * A parcel sealed weeks ago is not waiting for today's van; it is a TRACKING
 * problem, which the dashboard already surfaces elsewhere. So the pickup view
 * only claims what a driver could plausibly still collect.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [opts]
 * @param {number} [opts.withinDays=7]  lookback window, clamped to [1, 90]
 * @returns {{receipt_id: number, tracking_no: string|null, packaged_at: number, buyer_name: string|null}[]}
 */
function listParcelsAwaitingFourpxPickup(db, { withinDays = FOURPX_PICKUP_AWAITING_DAYS } = {}) {
	const cutoff = Math.floor(Date.now() / 1000) - normalizeAwaitingDays(withinDays) * 86_400
	return db
		.prepare(
			`
    SELECT r.receipt_id,
           COALESCE(r.fourpx_tracking_no, r.fourpx_consignment_no) AS tracking_no,
           r.packaged_at,
           r.name AS buyer_name
      FROM receipts r
     WHERE r.packaged_at IS NOT NULL
       AND r.packaged_at >= @cutoff
       AND COALESCE(r.fourpx_tracking_no, r.fourpx_consignment_no) IS NOT NULL
       AND COALESCE(r.fourpx_order_status, '') != 'cancelled'
       AND r.carrier_confirmed_at IS NULL
       AND ${_PICKUP_LIVE_RECEIPT_SQL}
       AND NOT EXISTS (
         SELECT 1
           FROM fourpx_pickup_appointment_orders ao
           JOIN fourpx_pickup_appointments a ON a.id = ao.appointment_id
          WHERE ao.receipt_id = r.receipt_id
            AND a.status IN (${_PICKUP_BLOCKING_SQL})
       )
     ORDER BY r.packaged_at ASC
  `,
		)
		.all({ cutoff })
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
	const clauses = ["(r.fourpx_consignment_no IS NOT NULL OR r.tracking_code LIKE '4PX%')", "COALESCE(r.fourpx_order_status,'') != 'cancelled'"]
	const params = {}
	// COALESCE so manual orders (which may lack etsy_created_at) fall back to their
	// 4PX label-creation date rather than dropping out of every window.
	if (from) {
		clauses.push('COALESCE(r.etsy_created_at, r.fourpx_created_at) >= @from')
		params.from = from
	}
	if (to) {
		clauses.push('COALESCE(r.etsy_created_at, r.fourpx_created_at) <= @to')
		params.to = to
	}
	if (shopId) {
		clauses.push('r.shop_id = @shopId')
		params.shopId = shopId
	}
	const where = `WHERE ${clauses.join(' AND ')}`

	// Resolved cost per shop + currency (only rows that actually have an amount).
	const rows = db
		.prepare(
			`
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
  `,
		)
		.all(params)

	// Lifecycle counts per shop (how many shipments still await any cost at all).
	const counts = db
		.prepare(
			`
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
  `,
		)
		.all(params)

	const byShop = {}
	for (const c of counts) {
		byShop[c.shop_id] = {
			shop_id: c.shop_id,
			shop_name: c.shop_name,
			total_orders: c.total_orders,
			billed: c.billed,
			estimated: c.estimated,
			unpriced: c.unpriced,
			totals: {}, // currency → { amount, orders, billed, estimated }
		}
	}
	for (const r of rows) {
		const shop = byShop[r.shop_id]
		if (!shop) continue
		shop.totals[r.currency] = {
			amount: +(r.total_cost ?? 0).toFixed(2),
			orders: r.priced_orders,
			billed: r.billed_orders,
			estimated: r.estimated_orders,
		}
	}
	return { rows, byShop }
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
function updateTrackingDetail(
	db,
	receiptId,
	{
		status = null,
		firstScanAt = null,
		lastEventAt = null,
		lastEvent = null,
		lastLocation = null,
		deliveredAt = null,
		health = null, // analyzeTrackingHealth output { severity, reasons, ... }
		checkedAt = Math.floor(Date.now() / 1000),
	} = {},
) {
	// Health is recomputed on every successful check (it's a function of the live
	// timeline), so unlike the COALESCE'd fields it is written directly when provided.
	const healthSeverity = health ? health.severity || 'ok' : null
	const healthReason = health && Array.isArray(health.reasons) && health.reasons.length ? health.reasons[0] : null
	const isDisposed = health ? (health.isDisposed ? 1 : 0) : null
	db.prepare(
		`
    UPDATE receipts SET
      tracking_status        = COALESCE(@status, tracking_status),
      tracking_last_event    = COALESCE(@lastEvent, tracking_last_event),
      tracking_last_event_at = COALESCE(@lastEventAt, tracking_last_event_at),
      tracking_last_location = COALESCE(@lastLocation, tracking_last_location),
      -- Disposal is a contradictory terminal correction: it must clear a stale
      -- delivered timestamp or the alert inbox's open-parcel guard can hide it.
      -- Other non-delivery snapshots remain monotonic and cannot regress a
      -- confirmed delivery merely because an aggregate carrier status lagged.
      tracking_delivered_at  = CASE
        WHEN @isDisposed = 1 THEN NULL
        ELSE COALESCE(tracking_delivered_at, @deliveredAt)
      END,
      tracking_health        = COALESCE(@healthSeverity, tracking_health),
      tracking_health_reason = CASE WHEN @healthSeverity IS NOT NULL THEN @healthReason ELSE tracking_health_reason END,
      tracking_is_disposed   = CASE WHEN @healthSeverity IS NOT NULL THEN @isDisposed ELSE tracking_is_disposed END,
      tracking_last_error    = CASE WHEN @status IS NOT NULL THEN NULL ELSE tracking_last_error END,
      tracking_error_at      = CASE WHEN @status IS NOT NULL THEN NULL ELSE tracking_error_at END,
      tracking_error_count   = CASE WHEN @status IS NOT NULL THEN 0 ELSE tracking_error_count END,
      tracking_next_check_at = CASE WHEN @status IS NOT NULL THEN NULL ELSE tracking_next_check_at END,
      carrier_confirmed_at   = COALESCE(carrier_confirmed_at, @firstScanAt),
      tracking_checked_at    = @checkedAt
    WHERE receipt_id = @receiptId
  `,
	).run({
		receiptId,
		status,
		lastEvent,
		lastEventAt: lastEventAt ?? null,
		lastLocation,
		deliveredAt: deliveredAt ?? null,
		healthSeverity,
		healthReason,
		isDisposed,
		firstScanAt: firstScanAt ?? null,
		checkedAt,
	})
}

/**
 * Persist one failed carrier attempt and schedule an exponential retry.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number|string} receiptId
 * @param {{error?:string, checkedAt?:number, baseRetryMinutes?:number, maxRetryMinutes?:number}} opts
 * @returns {{errorCount:number,nextCheckAt:number}}
 */
function recordTrackingCheckFailure(db, receiptId, { error = 'Carrier tracking request failed', checkedAt = Math.floor(Date.now() / 1000), baseRetryMinutes = 15, maxRetryMinutes = 120 } = {}) {
	const current = db.prepare('SELECT COALESCE(tracking_error_count, 0) AS n FROM receipts WHERE receipt_id = ?').get(receiptId)
	const errorCount = Math.min(20, Number(current?.n || 0) + 1)
	const base = Math.max(1, Number(baseRetryMinutes) || 15)
	const ceiling = Math.max(base, Number(maxRetryMinutes) || 120)
	const retryMinutes = Math.min(ceiling, base * 2 ** Math.min(errorCount - 1, 8))
	const nextCheckAt = checkedAt + Math.round(retryMinutes * 60)
	db.prepare(
		`
    UPDATE receipts SET
      tracking_checked_at = @checkedAt,
      tracking_last_error = @error,
      tracking_error_at = @checkedAt,
      tracking_error_count = @errorCount,
      tracking_next_check_at = @nextCheckAt
    WHERE receipt_id = @receiptId
  `,
	).run({
		receiptId,
		checkedAt,
		error: String(error || 'Carrier tracking request failed').slice(0, 1000),
		errorCount,
		nextCheckAt,
	})
	return { errorCount, nextCheckAt }
}

/**
 * SQL fragment for a parcel whose critical verdict is ONLY "4PX has never
 * scanned/accepted this label" (analyzeTrackingHealth's pre_transit branch is
 * the sole path that can produce a critical verdict while tracking_status is
 * still 'pre_transit'). That is a fulfillment gap on OUR side — the parcel
 * needs to be dropped off / handed to the carrier — not a carrier-side stall,
 * so it is deliberately kept out of Stuck (which implies "chase 4PX") and out
 * of the buyer-outreach / alert-inbox queues. It gets its own filter/count so
 * operators can still find and act on it without it inflating Stuck.
 */
const LABEL_ONLY_SQL = `(r.tracking_health = 'critical' AND COALESCE(r.tracking_status, 'unknown') = 'pre_transit')`

/**
 * SQL fragment that flags a parcel as Stuck. Primary signal is the persisted
 * health verdict from analyzeTrackingHealth (severity = 'critical': active
 * customs hold, prolonged silence, or carrier exception). Label-only parcels
 * that never got a carrier-acceptance scan are excluded — see LABEL_ONLY_SQL.
 * Delivered and warning/Delayed parcels are never Stuck. Disposed parcels are
 * filtered out by callers that use the dedicated compensation queue.
 */
const STUCK_SQL = `(r.tracking_health = 'critical' AND NOT ${LABEL_ONLY_SQL})`

/** SQL fragment for a "delayed" parcel (slow but not critically stuck). */
const DELAYED_SQL = `(r.tracking_health = 'warning')`

/**
 * SQL fragment for carrier-disposed parcels — the compensation-claim queue.
 * Matches cached last-event / location / health-reason text so already-synced
 * rows surface immediately even before the next live tracking refresh rewrites
 * tracking_status to exception. Case-insensitive via LOWER().
 */
const DISPOSAL_SQL_EN_TERMS = Object.freeze(['parcel disposal', 'parcel disposed', 'disposal authorized', 'shipment has been destroyed', 'shipment was destroyed', 'shipment destroyed', 'parcel has been destroyed', 'parcel was destroyed', 'package has been destroyed', 'package was destroyed', 'overseas service provider destroyed', 'abandon due to prohibited or restricted items'])
const DISPOSAL_SQL_CN_TERMS = Object.freeze(['销毁', '弃件', '报废'])

/** Build equivalent cached-row disposal predicates with or without table aliases. */
function disposalTextSql(columns) {
	const checks = []
	for (const column of columns) {
		for (const term of DISPOSAL_SQL_EN_TERMS) {
			checks.push(`LOWER(COALESCE(${column}, '')) LIKE '%${term}%'`)
		}
		for (const term of DISPOSAL_SQL_CN_TERMS) {
			checks.push(`COALESCE(${column}, '') LIKE '%${term}%'`)
		}
	}
	return `(${checks.join('\n  OR ')})`
}

const DISPOSAL_TEXT_SQL = disposalTextSql(['r.tracking_last_event', 'r.tracking_last_location'])
const DISPOSAL_ROW_TEXT_SQL = disposalTextSql(['tracking_last_event', 'tracking_last_location'])
const DISPOSAL_SQL = `(COALESCE(r.tracking_is_disposed, 0) = 1 OR ${DISPOSAL_TEXT_SQL})`

/** Stuck or disposed — the two kinds that need an Etsy buyer message. Delayed is watch-only. */
const OUTREACH_ELIGIBLE_SQL = `(${DISPOSAL_SQL} OR (${STUCK_SQL} AND NOT ${DISPOSAL_SQL}))`

/**
 * Operator has not yet attested a send for the CURRENT kind.
 *
 * A stuck send does not cover a later disposal (the copy and the ask both
 * change). Relapse is handled by clearing the snapshot when a new incident
 * opens, so this fragment stays a cheap receipts-only predicate.
 */
const OUTREACH_NEEDED_SQL = `(
  ${OUTREACH_ELIGIBLE_SQL}
  AND (
    r.shipping_buyer_notified_at IS NULL
    OR (${DISPOSAL_SQL} AND COALESCE(r.shipping_buyer_notice_kind, '') != 'disposed')
  )
)`

const OUTREACH_STATUS_SQL = `(
  CASE
    WHEN NOT ${OUTREACH_ELIGIBLE_SQL} THEN NULL
    WHEN r.shipping_buyer_notified_at IS NULL THEN 'needed'
    WHEN ${DISPOSAL_SQL} AND COALESCE(r.shipping_buyer_notice_kind, '') != 'disposed' THEN 'follow_up'
    ELSE 'sent'
  END
)`

/** Shared Shipping-board scope: real, non-cancelled, non-archived 4PX parcels. */
const FOURPX_ACTIVE_SHIPMENT_SQL = `(
  (r.fourpx_consignment_no IS NOT NULL OR r.tracking_code LIKE '4PX%' OR NULLIF(TRIM(r.fourpx_tracking_no), '') IS NOT NULL)
  AND COALESCE(r.fourpx_order_status, '') != 'cancelled'
  AND r.archived_at IS NULL
)`

const SHIPMENT_TRACKING_NO_SQL = `COALESCE(
  NULLIF(TRIM(r.fourpx_tracking_no), ''),
  CASE WHEN r.fourpx_consignment_no IS NOT NULL THEN NULLIF(TRIM(r.tracking_code), '') END,
  CASE WHEN r.tracking_code LIKE '4PX%' THEN r.tracking_code END,
  NULL
)`

/** Allowed shipping_claim_status values (Shipping-tab compensation workflow). */
const SHIPPING_CLAIM_STATUSES = Object.freeze(['none', 'investigating', 'claimed', 'compensated', 'closed'])
const MAX_SHIPPING_CLAIM_NOTE_LENGTH = 4000
const MAX_SHIPPING_NOTICE_BODY_LENGTH = 4000

/**
 * Persist a Shipping-tab compensation claim note/status on a receipt.
 * Clears status back to NULL when set to 'none'/empty so filters stay clean.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number|string} receiptId
 * @param {{ note?: string|null, status?: string|null }} patch
 * @returns {{ ok: boolean, error?: string, shipping_claim_note?: string|null,
 *   shipping_claim_status?: string|null, shipping_claim_updated_at?: number|null }}
 */
function updateShippingClaim(db, receiptId, patch = {}) {
	const row = db
		.prepare(
			`SELECT shipping_claim_note, shipping_claim_status, shipping_claim_updated_at,
            tracking_code, fourpx_tracking_no, fourpx_consignment_no,
            fourpx_order_status, archived_at
     FROM receipts WHERE receipt_id = ?`,
		)
		.get(receiptId)
	if (!row) return { ok: false, error: 'Order not found' }
	const isFourpx = row.fourpx_consignment_no || /^4PX/i.test(row.tracking_code || '') || /^4PX/i.test(row.fourpx_tracking_no || '')
	if (!isFourpx || row.fourpx_order_status === 'cancelled' || row.archived_at != null) {
		return { ok: false, error: 'Active 4PX parcel not found' }
	}

	let note = row.shipping_claim_note
	let status = row.shipping_claim_status

	if (Object.prototype.hasOwnProperty.call(patch, 'note')) {
		if (patch.note != null && typeof patch.note !== 'string') {
			return { ok: false, error: 'Claim note must be text' }
		}
		const n = patch.note == null ? '' : patch.note
		if (n.length > MAX_SHIPPING_CLAIM_NOTE_LENGTH) {
			return { ok: false, error: `Claim note must be ${MAX_SHIPPING_CLAIM_NOTE_LENGTH} characters or fewer` }
		}
		note = n.trim() ? n : null
	}
	if (Object.prototype.hasOwnProperty.call(patch, 'status')) {
		if (patch.status != null && typeof patch.status !== 'string') {
			return { ok: false, error: 'Claim status must be text' }
		}
		const raw = patch.status == null ? '' : patch.status.trim().toLowerCase()
		if (!raw || raw === 'none') {
			status = null
		} else if (!SHIPPING_CLAIM_STATUSES.includes(raw)) {
			return { ok: false, error: `Invalid claim status "${raw}". Allowed: ${SHIPPING_CLAIM_STATUSES.join(', ')}` }
		} else {
			status = raw
		}
	}

	const updatedAt = Math.floor(Date.now() / 1000)
	db.prepare(
		`
    UPDATE receipts SET
      shipping_claim_note = @note,
      shipping_claim_status = @status,
      shipping_claim_updated_at = @updatedAt
    WHERE receipt_id = @receiptId
  `,
	).run({ receiptId, note, status, updatedAt })

	return {
		ok: true,
		shipping_claim_note: note,
		shipping_claim_status: status,
		shipping_claim_updated_at: updatedAt,
	}
}

const CLEAR_SHIPPING_BUYER_NOTICE_SQL = `
  UPDATE receipts SET
    shipping_buyer_notified_at = NULL,
    shipping_buyer_notice_kind = NULL,
    shipping_buyer_notified_by = NULL,
    shipping_buyer_notice_body = NULL
  WHERE receipt_id = @receiptId
`

function _currentOutreachKind(row) {
	if (!row) return null
	const disposed = Number(row.is_disposed) === 1
	const stuck = Number(row.is_stuck) === 1
	if (disposed) return 'disposed'
	if (stuck) return 'stuck'
	return null
}

function _outreachStatusFromRow(row) {
	const kind = _currentOutreachKind(row)
	if (!kind) return 'ineligible'
	if (!row.shipping_buyer_notified_at) return 'needed'
	if (kind === 'disposed' && row.shipping_buyer_notice_kind !== 'disposed') return 'follow_up'
	return 'sent'
}

/**
 * Load the buyer-outreach desk for one parcel: eligibility, the current
 * policy-safe draft, and every send already attested.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number|string} receiptId
 */
function getShippingBuyerNotice(db, receiptId) {
	const row = db
		.prepare(
			`
    SELECT
      r.receipt_id, r.shop_id, s.shop_name, r.name AS buyer_name,
      r.shipping_country_iso, r.first_product_title,
      r.tracking_last_event, r.tracking_health_reason,
      ${SHIPMENT_TRACKING_NO_SQL} AS tracking_no,
      CASE WHEN ${STUCK_SQL} THEN 1 ELSE 0 END AS is_stuck,
      CASE WHEN ${DISPOSAL_SQL} THEN 1 ELSE 0 END AS is_disposed,
      r.shipping_buyer_notified_at, r.shipping_buyer_notice_kind,
      r.shipping_buyer_notified_by, r.shipping_buyer_notice_body,
      r.fourpx_order_status, r.archived_at,
      r.fourpx_consignment_no, r.tracking_code, r.fourpx_tracking_no
    FROM receipts r
    JOIN shops s ON s.shop_id = r.shop_id
    WHERE r.receipt_id = ?
  `,
		)
		.get(receiptId)

	if (!row) return { ok: false, error: 'Order not found', status: 404 }

	const isFourpx = row.fourpx_consignment_no || /^4PX/i.test(row.tracking_code || '') || /^4PX/i.test(row.fourpx_tracking_no || '')
	if (!isFourpx || row.fourpx_order_status === 'cancelled' || row.archived_at != null) {
		return { ok: false, error: 'Active 4PX parcel not found', status: 400 }
	}

	const kind = _currentOutreachKind(row)
	const outreachStatus = _outreachStatusFromRow(row)
	let draft = null
	if (kind) {
		draft = composeShippingBuyerNotice({
			kind,
			shopName: row.shop_name,
			buyerName: row.buyer_name,
			trackingNo: row.tracking_no,
			lastEvent: row.tracking_last_event || row.tracking_health_reason,
			country: row.shipping_country_iso,
		})
	}

	const history = db
		.prepare(
			`
    SELECT id, notice_kind, notified_at, notified_by, tracking_no
    FROM shipping_buyer_notices
    WHERE receipt_id = ?
    ORDER BY notified_at DESC, id DESC
    LIMIT 20
  `,
		)
		.all(receiptId)

	return {
		ok: true,
		receipt_id: row.receipt_id,
		shop_name: row.shop_name,
		buyer_name: row.buyer_name,
		tracking_no: row.tracking_no,
		last_event: row.tracking_last_event,
		country: row.shipping_country_iso,
		current_kind: kind,
		eligible: !!kind,
		outreach_status: outreachStatus,
		notified_at: row.shipping_buyer_notified_at ?? null,
		notified_by: row.shipping_buyer_notified_by ?? null,
		notice_kind: row.shipping_buyer_notice_kind ?? null,
		last_message: row.shipping_buyer_notice_body ?? null,
		draft,
		history,
		etsy_order_url: ETSY_SOLD_ORDER_URL(row.receipt_id),
	}
}

/**
 * Attest that the operator pasted a buyer message into the Etsy conversation.
 * Does not send anything — Etsy has no messaging API.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number|string} receiptId
 * @param {{ message?: string|null, notifiedBy?: string|null }} [opts]
 */
function recordShippingBuyerNotice(db, receiptId, opts = {}) {
	const state = getShippingBuyerNotice(db, receiptId)
	if (!state.ok) return state
	if (!state.eligible) {
		return { ok: false, error: 'Buyer outreach is only recorded for stuck or disposed parcels', status: 400 }
	}

	const draft = state.draft
	let body = opts.message == null || opts.message === '' ? draft.message : String(opts.message)
	body = body.trim()
	if (!body) return { ok: false, error: 'Message text is required', status: 400 }
	if (body.length > MAX_SHIPPING_NOTICE_BODY_LENGTH) {
		return { ok: false, error: `Message must be ${MAX_SHIPPING_NOTICE_BODY_LENGTH} characters or fewer`, status: 400 }
	}
	const compliance = checkShippingNoticeCompliance(body)
	if (!compliance.ok) {
		return { ok: false, error: 'That message contains content Etsy prohibits in buyer conversations', status: 400, compliance }
	}

	const notifiedAt = Math.floor(Date.now() / 1000)
	const notifiedBy = opts.notifiedBy ? String(opts.notifiedBy).slice(0, 120) : null
	const kind = state.current_kind

	db.transaction(() => {
		db.prepare(
			`
      INSERT INTO shipping_buyer_notices (receipt_id, notice_kind, notified_at, notified_by, message_body, tracking_no)
      VALUES (@receiptId, @kind, @notifiedAt, @notifiedBy, @body, @trackingNo)
    `,
		).run({
			receiptId: state.receipt_id,
			kind,
			notifiedAt,
			notifiedBy,
			body,
			trackingNo: state.tracking_no || null,
		})
		db.prepare(
			`
      UPDATE receipts SET
        shipping_buyer_notified_at = @notifiedAt,
        shipping_buyer_notice_kind = @kind,
        shipping_buyer_notified_by = @notifiedBy,
        shipping_buyer_notice_body = @body
      WHERE receipt_id = @receiptId
    `,
		).run({ receiptId: state.receipt_id, notifiedAt, kind, notifiedBy, body })
	})()

	return getShippingBuyerNotice(db, receiptId)
}

/**
 * Undo the latest send attestation for this incident (the snapshot), leaving
 * older history intact. Used when the operator marked sent by mistake.
 */
function clearShippingBuyerNotice(db, receiptId) {
	const state = getShippingBuyerNotice(db, receiptId)
	if (!state.ok) return state

	db.transaction(() => {
		const last = db
			.prepare(
				`
      SELECT id FROM shipping_buyer_notices
      WHERE receipt_id = ?
      ORDER BY notified_at DESC, id DESC
      LIMIT 1
    `,
			)
			.get(state.receipt_id)
		if (last) {
			db.prepare('DELETE FROM shipping_buyer_notices WHERE id = ?').run(last.id)
		}
		const prev = db
			.prepare(
				`
      SELECT notice_kind, notified_at, notified_by, message_body
      FROM shipping_buyer_notices
      WHERE receipt_id = ?
      ORDER BY notified_at DESC, id DESC
      LIMIT 1
    `,
			)
			.get(state.receipt_id)
		if (prev) {
			// Restore the prior send so undoing a disposed follow-up returns the
			// parcel to follow_up (stuck already sent) instead of wiping the desk.
			db.prepare(
				`
        UPDATE receipts SET
          shipping_buyer_notified_at = @notifiedAt,
          shipping_buyer_notice_kind = @kind,
          shipping_buyer_notified_by = @notifiedBy,
          shipping_buyer_notice_body = @body
        WHERE receipt_id = @receiptId
      `,
			).run({
				receiptId: state.receipt_id,
				notifiedAt: prev.notified_at,
				kind: prev.notice_kind,
				notifiedBy: prev.notified_by,
				body: prev.message_body,
			})
		} else {
			db.prepare(CLEAR_SHIPPING_BUYER_NOTICE_SQL).run({ receiptId: state.receipt_id })
		}
	})()

	return getShippingBuyerNotice(db, receiptId)
}

function resetShippingBuyerNoticeSnapshot(db, receiptIds) {
	const ids = [...new Set((receiptIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))]
	if (!ids.length) return 0
	return db
		.prepare(
			`
    UPDATE receipts SET
      shipping_buyer_notified_at = NULL,
      shipping_buyer_notice_kind = NULL,
      shipping_buyer_notified_by = NULL,
      shipping_buyer_notice_body = NULL
    WHERE receipt_id IN (${ids.map(() => '?').join(',')})
      AND shipping_buyer_notified_at IS NOT NULL
  `,
		)
		.run(...ids).changes
}

/**
 * Soft-reclassify cached parcels whose last event/location already screams
 * disposal but whose tracking_status / health were persisted before disposal
 * detection existed. Idempotent — safe to call on Shipping-tab load.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {number} Rows updated
 */
function backfillDisposedTrackingFlags(db) {
	const reason = 'Parcel disposed or destroyed by carrier — review 4PX claim eligibility.'
	const legacyReason = 'Parcel disposed by carrier — eligible for a 4PX compensation claim.'
	const result = db
		.prepare(
			`
    UPDATE receipts SET
      tracking_status = 'exception',
      tracking_health = 'critical',
      tracking_is_disposed = 1,
      tracking_delivered_at = NULL,
      tracking_health_reason = CASE
        WHEN tracking_health_reason = @legacyReason THEN @reason
        WHEN LOWER(COALESCE(tracking_health_reason, '')) LIKE '%parcel dispos%'
          OR LOWER(COALESCE(tracking_health_reason, '')) LIKE '%disposal authorized%'
          OR LOWER(COALESCE(tracking_health_reason, '')) LIKE '%destroy%'
        THEN tracking_health_reason
        ELSE @reason
      END
    WHERE (fourpx_consignment_no IS NOT NULL OR tracking_code LIKE '4PX%' OR NULLIF(TRIM(fourpx_tracking_no), '') IS NOT NULL)
      AND COALESCE(fourpx_order_status, '') != 'cancelled'
      AND archived_at IS NULL
      AND ${DISPOSAL_ROW_TEXT_SQL}
      AND (
        COALESCE(tracking_status, '') != 'exception'
        OR COALESCE(tracking_health, '') != 'critical'
        OR COALESCE(tracking_is_disposed, 0) != 1
        OR tracking_delivered_at IS NOT NULL
        OR tracking_health_reason = @legacyReason
      )
  `,
		)
		.run({ reason, legacyReason })
	return result.changes || 0
}

/**
 * Reclassify cached parcels whose last carrier event is a delivery terminal but
 * whose stored status still says in transit / exception.
 *
 * Needed because most last-mile partners never use the word "delivered" — a
 * completed hand-off arrives as "Secure delivery (Enclosed porch)", "ENTREGADO"
 * or "The recipient has picked up the shipment". Rows written before the
 * classifier understood that wording sit at in_transit forever, and because a
 * delivered parcel never gets another scan, the no-movement rule then reports
 * them as stuck. This repairs them from the text already on the row instead of
 * waiting for a carrier sweep that would not change anything.
 *
 * Matching is delegated to the carrier module's detector, so this cannot drift
 * from live classification. Candidates are narrowed in SQL first (open 4PX
 * parcels that have a cached event), which keeps the JS pass small.
 *
 * Idempotent — safe to call on every Shipping-tab load.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {number} Rows updated
 */
function backfillDeliveredTrackingFlags(db) {
	const candidates = db
		.prepare(
			`
    SELECT receipt_id, tracking_last_event, tracking_last_location, tracking_last_event_at
    FROM receipts
    WHERE (fourpx_consignment_no IS NOT NULL OR tracking_code LIKE '4PX%' OR NULLIF(TRIM(fourpx_tracking_no), '') IS NOT NULL)
      AND COALESCE(fourpx_order_status, '') != 'cancelled'
      AND archived_at IS NULL
      AND COALESCE(tracking_status, '') != 'delivered'
      AND COALESCE(tracking_last_event, '') != ''
      -- A disposed parcel is terminal; never let a delivery-shaped phrase
      -- elsewhere on the row overwrite that verdict.
      AND COALESCE(tracking_is_disposed, 0) = 0
  `,
		)
		.all()

	const delivered = candidates.filter((row) => isDeliveredText(row.tracking_last_event, row.tracking_last_location))
	if (!delivered.length) return 0

	const update = db.prepare(`
    UPDATE receipts SET
      tracking_status        = 'delivered',
      tracking_health        = 'ok',
      tracking_health_reason = NULL,
      tracking_delivered_at  = COALESCE(tracking_delivered_at, @deliveredAt)
    WHERE receipt_id = @receiptId
  `)
	const run = db.transaction(() => {
		let changed = 0
		for (const row of delivered) {
			changed += update.run({
				receiptId: row.receipt_id,
				deliveredAt: row.tracking_last_event_at ?? null,
			}).changes
		}
		return changed
	})
	return run() || 0
}

/**
 * Clear stale "customs scans / held at customs" health verdicts when the cached
 * last event already shows destination-network or last-mile progress.
 *
 * Needed because the previous analyzer counted EVERY event containing the word
 * "customs" — including "Released from customs: customs cleared" — so healthy
 * lanes that finished import clearance and moved to "Handed over to last mile"
 * / "Arrived at Origin Hub" / "Departed Destination Hub" stayed Stuck forever.
 * The live analyzer is stage-aware now; this repairs rows already cached before
 * the next carrier refresh rewrites them.
 *
 * Idempotent — safe to call once per process alongside the other legacy repairs.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {number} Rows updated
 */
function backfillFalseCustomsStuckFlags(db) {
	const candidates = db
		.prepare(
			`
    SELECT receipt_id, tracking_last_event, tracking_health_reason
    FROM receipts
    WHERE (fourpx_consignment_no IS NOT NULL OR tracking_code LIKE '4PX%' OR NULLIF(TRIM(fourpx_tracking_no), '') IS NOT NULL)
      AND COALESCE(fourpx_order_status, '') != 'cancelled'
      AND archived_at IS NULL
      AND tracking_health IN ('critical', 'warning')
      AND COALESCE(tracking_is_disposed, 0) = 0
      AND COALESCE(tracking_status, '') NOT IN ('delivered', 'exception')
      AND COALESCE(tracking_last_event, '') != ''
      AND (
        LOWER(COALESCE(tracking_health_reason, '')) LIKE '%customs scans with no delivery%'
        OR LOWER(COALESCE(tracking_health_reason, '')) LIKE '%customs holds with no clearance%'
        OR LOWER(COALESCE(tracking_health_reason, '')) LIKE '%customs cleared and re-checked%'
        OR LOWER(COALESCE(tracking_health_reason, '')) LIKE '%stuck in a customs loop%'
        OR LOWER(COALESCE(tracking_health_reason, '')) LIKE '%likely held at customs%'
        OR LOWER(COALESCE(tracking_health_reason, '')) LIKE '%possible re-inspection%'
      )
  `,
		)
		.all()

	const healed = candidates.filter((row) => {
		const last = row.tracking_last_event || ''
		// Destination / last-mile progress, OR a clearance as the newest scan —
		// neither is an active customs hold, so the stale loop verdict is wrong.
		return eventShowsPostCustomsProgress(last) || CUSTOMS_CLEAR_RE.test(last)
	})
	if (!healed.length) return 0

	const update = db.prepare(`
    UPDATE receipts SET
      tracking_health        = 'ok',
      tracking_health_reason = NULL
    WHERE receipt_id = @receiptId
      AND tracking_health IN ('critical', 'warning')
      AND COALESCE(tracking_is_disposed, 0) = 0
  `)
	const run = db.transaction(() => {
		let changed = 0
		for (const row of healed) {
			changed += update.run({ receiptId: row.receipt_id }).changes
		}
		return changed
	})
	return run() || 0
}

/**
 * Queue cached rows whose severity may increase under the corrected age policy.
 *
 * A single cached event is enough to identify candidates, but not enough to
 * publish an authoritative verdict: old adapters may have dropped a delivered
 * event code/location. Clear only the freshness timestamp so the locked carrier
 * worker rechecks the complete timeline on startup. Existing health stays visible
 * until that check succeeds; a transient API failure therefore cannot invent or
 * erase an alert.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{stuckDays?:number,nowEpoch?:number}} [opts]
 * @returns {number} Rows queued
 */
function queueOverdueTrackingRechecks(db, opts = {}) {
	const configuredNow = Number(opts.nowEpoch)
	const nowEpoch = Number.isFinite(configuredNow) ? Math.floor(configuredNow) : Math.floor(Date.now() / 1000)
	const candidates = db
		.prepare(
			`
    SELECT receipt_id, tracking_status, tracking_last_event,
           tracking_last_location, tracking_last_event_at, tracking_health
    FROM receipts
    WHERE (fourpx_consignment_no IS NOT NULL OR tracking_code LIKE '4PX%' OR NULLIF(TRIM(fourpx_tracking_no), '') IS NOT NULL)
      AND COALESCE(fourpx_order_status, '') != 'cancelled'
      AND archived_at IS NULL
      AND tracking_delivered_at IS NULL
      AND tracking_status IN ('pre_transit', 'in_transit')
      AND tracking_last_event_at IS NOT NULL
      AND tracking_checked_at IS NOT NULL
      AND tracking_last_error IS NULL
      AND COALESCE(tracking_is_disposed, 0) = 0
      AND COALESCE(tracking_health, 'ok') IN ('ok', 'warning')
  `,
		)
		.all()

	const rank = { ok: 0, warning: 1, critical: 2 }
	const due = candidates
		.map((row) => {
			const health = analyzeTrackingHealth(
				[
					{
						timestamp: row.tracking_last_event_at,
						description: row.tracking_last_event,
						location: row.tracking_last_location,
					},
				],
				row.tracking_status,
				{ stuckDays: opts.stuckDays, nowEpoch },
			)
			return { row, health }
		})
		.filter(({ row, health }) => (rank[health.severity] || 0) > (rank[row.tracking_health || 'ok'] || 0))

	if (!due.length) return 0
	const update = db.prepare(`
    UPDATE receipts SET
      tracking_checked_at = NULL,
      tracking_next_check_at = NULL
    WHERE receipt_id = @receiptId
      AND tracking_checked_at IS NOT NULL
  `)
	return db.transaction(() => {
		let changed = 0
		for (const { row } of due) {
			changed += update.run({ receiptId: row.receipt_id }).changes
		}
		return changed
	})()
}

/** Effective ship date for windowing: Etsy shipment → 4PX label → order date. */
const SHIP_DATE_SQL = `COALESCE(r.shipment_notified_at, r.fourpx_created_at, r.etsy_created_at)`
/** Most recent carrier activity (last scan, else last successful check). */
const LAST_ACTIVITY_SQL = `COALESCE(r.tracking_last_event_at, r.tracking_checked_at, 0)`

/**
 * Build the Shipping-tab date-window predicate — used IDENTICALLY by the parcel
 * list (getShipments) and the summary cards (getShippingStats) so the two can
 * never disagree.
 *
 * SEMANTICS
 * ──────────
 * A parcel belongs in window [from, to] when EITHER:
 *   (a) it SHIPPED within the window (historical/volume view — includes delivered
 *       parcels so the counts remain a faithful record of the period), OR
 *   (b) it is an OPEN parcel (not delivered) that had carrier ACTIVITY within the
 *       window (so a recently-scanned stall still shows even if it shipped earlier).
 *
 * Stuck / disposed parcels do NOT bypass the window. "Last 30 days" must mean
 * what the control says — switch Period to "All dates" to see the full backlog.
 *
 * Mutates `params` with @from / @to as needed. Returns a SQL fragment, or null
 * when no window is requested ("All").
 *
 * @param {{from?:number, to?:number}} opts
 * @param {object} params  Bound-parameter object to extend.
 * @returns {string|null}
 */
function buildShipWindowClause(opts, params) {
	const hasFrom = opts.from != null && Number.isFinite(Number(opts.from))
	const hasTo = opts.to != null && Number.isFinite(Number(opts.to))
	if (!hasFrom && !hasTo) return null // "All" — no windowing

	// (a) ship-date within the window
	const shipParts = []
	if (hasFrom) {
		shipParts.push(`${SHIP_DATE_SQL} >= @from`)
		params.from = opts.from
	}
	if (hasTo) {
		shipParts.push(`${SHIP_DATE_SQL} <= @to`)
		params.to = opts.to
	}
	const shipRange = `(${shipParts.join(' AND ')})`

	// (b) open parcel with carrier activity within the window
	const actParts = []
	if (hasFrom) actParts.push(`${LAST_ACTIVITY_SQL} >= @from`)
	if (hasTo) actParts.push(`${LAST_ACTIVITY_SQL} <= @to`)
	const openActive = `(r.tracking_delivered_at IS NULL ` + `AND COALESCE(r.tracking_status, 'unknown') != 'delivered' ` + `AND ${actParts.join(' AND ')})`

	return `(${shipRange} OR ${openActive})`
}

/**
 * List 4PX shipments for the Shipping tab with their cached tracking snapshot,
 * freight cost, and a computed `is_stuck` flag. Supports filtering by canonical
 * status, a "stuck" filter, shop, and a tracking-number/buyer search.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [opts]
 * @param {string} [opts.status]    Canonical status filter, or 'stuck'/'delayed'/'disposed'.
 * @param {string} [opts.shopId]
 * @param {string} [opts.q]         Search tracking number or buyer name.
 * @param {string} [opts.claimStatus] Filter by shipping_claim_status (or 'open' = investigating|claimed).
 * @param {string} [opts.alertState] 'new' → only parcels not yet acknowledged at their current severity.
 * @param {string} [opts.outreach] 'needed' | 'sent' — buyer-message attestation filter.
 * @param {number} [opts.stuckDays] Days of no movement to consider stuck (default 10).
 * @param {number} [opts.limit]
 * @param {number} [opts.offset]
 * @returns {{rows: Array, total: number}}
 */
function getShipments(db, opts = {}) {
	const where = [FOURPX_ACTIVE_SHIPMENT_SQL]
	const rawLimit = Number(opts.limit)
	const rawOffset = Number(opts.offset)
	const params = {
		limit: Number.isFinite(rawLimit) ? Math.min(1000, Math.max(1, Math.floor(rawLimit))) : 100,
		offset: Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0,
	}

	if (opts.shopId) {
		where.push('r.shop_id = @shopId')
		params.shopId = opts.shopId
	}
	// Date window: ship-date OR still-open-and-active (see buildShipWindowClause).
	// This is what keeps long-stuck parcels (shipped weeks ago, still not delivered)
	// on the board instead of falling out of a naive ship-date window.
	const winClause = buildShipWindowClause(opts, params)
	if (winClause) where.push(winClause)
	if (opts.q) {
		where.push('(r.tracking_code LIKE @q OR r.fourpx_tracking_no LIKE @q OR r.name LIKE @q)')
		params.q = `%${opts.q}%`
	}
	if (opts.status === 'stuck') {
		// Operational cards are intentionally disjoint: disposal has its own
		// compensation queue, so "Stuck" means other critical parcels.
		where.push(`(${STUCK_SQL} AND NOT ${DISPOSAL_SQL})`)
	} else if (opts.status === 'label_only') {
		where.push(`(${LABEL_ONLY_SQL} AND NOT ${DISPOSAL_SQL})`)
	} else if (opts.status === 'delayed') {
		where.push(DELAYED_SQL)
	} else if (opts.status === 'disposed') {
		where.push(DISPOSAL_SQL)
	} else if (opts.status && opts.status !== 'all') {
		where.push("COALESCE(r.tracking_status,'unknown') = @status")
		params.status = opts.status
	}
	if (opts.claimStatus === 'open') {
		where.push(`r.shipping_claim_status IN ('investigating', 'claimed')`)
	} else if (opts.claimStatus && opts.claimStatus !== 'all') {
		if (opts.claimStatus === 'none') {
			where.push(`(r.shipping_claim_status IS NULL OR r.shipping_claim_status = 'none')`)
		} else {
			where.push('r.shipping_claim_status = @claimStatus')
			params.claimStatus = opts.claimStatus
		}
	}
	// "Show me only what I haven't triaged yet" — the same set the morning-review
	// banner counts, so the board and the banner can never contradict each other.
	if (opts.alertState === 'new') where.push(NEW_ALERT_SQL)
	if (opts.outreach === 'needed') {
		where.push(OUTREACH_NEEDED_SQL)
	} else if (opts.outreach === 'sent') {
		where.push(`(${OUTREACH_ELIGIBLE_SQL} AND NOT ${OUTREACH_NEEDED_SQL} AND r.shipping_buyer_notified_at IS NOT NULL)`)
	}
	const W = where.join(' AND ')

	const rows = db
		.prepare(
			`
    SELECT
      r.receipt_id, r.shop_id, s.shop_name, r.name AS buyer_name,
      r.shipping_country_iso, r.etsy_created_at,
      ${SHIPMENT_TRACKING_NO_SQL} AS tracking_no,
      CASE WHEN ${SHIPMENT_TRACKING_NO_SQL} IS NOT NULL THEN 1 ELSE 0 END AS tracking_lookup_supported,
      r.fourpx_consignment_no,
      r.tracking_status, r.tracking_last_event, r.tracking_last_event_at,
      r.tracking_last_location, r.tracking_delivered_at,
      r.tracking_health, r.tracking_health_reason,
      r.carrier_confirmed_at, r.tracking_checked_at,
      r.tracking_last_error, r.tracking_error_at, r.tracking_error_count, r.tracking_next_check_at,
      r.shipment_notified_at,
      r.fourpx_freight_amount, r.fourpx_freight_currency, r.fourpx_freight_status,
      r.shipping_claim_note, r.shipping_claim_status, r.shipping_claim_updated_at,
      r.shipping_buyer_notified_at, r.shipping_buyer_notice_kind,
      r.shipping_buyer_notified_by,
      CASE WHEN ${STUCK_SQL} THEN 1 ELSE 0 END AS is_stuck,
      CASE WHEN ${LABEL_ONLY_SQL} AND NOT ${DISPOSAL_SQL} THEN 1 ELSE 0 END AS is_label_only,
      CASE WHEN ${DISPOSAL_SQL} THEN 1 ELSE 0 END AS is_disposed,
      CASE WHEN ${NEW_ALERT_SQL} THEN 1 ELSE 0 END AS is_new_alert,
      CASE WHEN ${ABNORMAL_OPEN_SQL} THEN ${ABNORMAL_KIND_SQL} END AS alert_kind,
      ai.first_seen_at AS alert_first_seen_at,
      ai.flagged_at    AS alert_flagged_at,
      ai.peak_kind     AS alert_peak_kind,
      ar.reviewed_at   AS alert_reviewed_at,
      ar.reviewed_by   AS alert_reviewed_by,
      ${OUTREACH_STATUS_SQL} AS outreach_status,
      CASE WHEN ${OUTREACH_NEEDED_SQL} THEN 1 ELSE 0 END AS outreach_needed
    FROM receipts r
    JOIN shops s ON s.shop_id = r.shop_id${ALERT_LEDGER_JOIN_SQL}
    WHERE ${W}
    ORDER BY
      CASE WHEN ${NEW_ALERT_SQL} THEN 0 ELSE 1 END ASC,
      CASE WHEN ${OUTREACH_NEEDED_SQL} THEN 0 ELSE 1 END ASC,
      CASE WHEN ${DISPOSAL_SQL} THEN 0 ELSE 1 END ASC,
      CASE WHEN ${STUCK_SQL} THEN 0 ELSE 1 END ASC,
      COALESCE(r.tracking_last_event_at, r.shipment_notified_at, r.etsy_created_at) DESC,
      r.receipt_id DESC
    LIMIT @limit OFFSET @offset
  `,
		)
		.all(params)

	const total = db.prepare(`SELECT COUNT(*) AS n FROM receipts r${ALERT_LEDGER_JOIN_SQL} WHERE ${W}`).get(params).n
	return { rows, total }
}

/**
 * Summary counts for the Shipping tab cards: total 4PX shipments plus a count per
 * canonical status and the number currently stuck.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [opts]
 * @param {number} [opts.stuckDays]
 * @param {string} [opts.shopId]
 * @returns {{total:number, pre_transit:number, in_transit:number, delivered:number, exception:number, unknown:number, stuck:number, label_only:number, delayed:number, disposed:number, claims_open:number, outreach_needed:number}}
 */
function getShippingStats(db, opts = {}) {
	const where = [FOURPX_ACTIVE_SHIPMENT_SQL]
	const params = {}
	if (opts.shopId) {
		where.push('r.shop_id = @shopId')
		params.shopId = opts.shopId
	}
	if (opts.q) {
		where.push('(r.tracking_code LIKE @q OR r.fourpx_tracking_no LIKE @q OR r.name LIKE @q)')
		params.q = `%${opts.q}%`
	}
	// Same window logic as the parcel list so the cards and the table always agree.
	const winClause = buildShipWindowClause(opts, params)
	if (winClause) where.push(winClause)
	const W = where.join(' AND ')

	return db
		.prepare(
			`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN COALESCE(r.tracking_status,'unknown')='pre_transit' THEN 1 ELSE 0 END) AS pre_transit,
      SUM(CASE WHEN r.tracking_status='in_transit' THEN 1 ELSE 0 END) AS in_transit,
      SUM(CASE WHEN r.tracking_status='delivered'  THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN r.tracking_status='exception'  THEN 1 ELSE 0 END) AS exception,
      SUM(CASE WHEN COALESCE(r.tracking_status,'unknown')='unknown' THEN 1 ELSE 0 END) AS unknown,
      SUM(CASE WHEN ${STUCK_SQL} AND NOT ${DISPOSAL_SQL} THEN 1 ELSE 0 END) AS stuck,
      SUM(CASE WHEN ${LABEL_ONLY_SQL} AND NOT ${DISPOSAL_SQL} THEN 1 ELSE 0 END) AS label_only,
      SUM(CASE WHEN ${DELAYED_SQL} THEN 1 ELSE 0 END) AS delayed,
      SUM(CASE WHEN ${DISPOSAL_SQL} THEN 1 ELSE 0 END) AS disposed,
      SUM(CASE WHEN r.shipping_claim_status IN ('investigating', 'claimed') THEN 1 ELSE 0 END) AS claims_open,
      SUM(CASE WHEN ${OUTREACH_NEEDED_SQL} THEN 1 ELSE 0 END) AS outreach_needed
    FROM receipts r
    WHERE ${W}
  `,
		)
		.get(params)
}

/** Open, undelivered parcels that need operator attention on the Shipping desk. */
const ABNORMAL_OPEN_SQL = `(
  ${DISPOSAL_SQL}
  OR (
    r.tracking_delivered_at IS NULL
    AND COALESCE(r.tracking_status, 'unknown') != 'delivered'
    AND (
      ${STUCK_SQL}
      OR ${DELAYED_SQL}
      OR COALESCE(r.tracking_status, 'unknown') = 'exception'
    )
  )
)`

/**
 * Ordered severity of an abnormal parcel — the single source of truth shared by
 * the alert query, the review ledger and the escalation comparison.
 *
 * Ranking mirrors the operator's action priority: a disposed parcel needs a
 * compensation claim, a stuck one needs chasing, a delayed one is a watch item,
 * and a bare carrier `exception` with no health verdict yet is the weakest
 * signal. Higher rank = more urgent.
 */
const SHIPPING_ALERT_SEVERITY_RANK = Object.freeze({
	disposed: 4,
	stuck: 3,
	delayed: 2,
	exception: 1,
	unknown: 0,
})

/** SQL form of SHIPPING_ALERT_SEVERITY_RANK. Must stay in step with it. */
const ABNORMAL_KIND_SQL = `(
  CASE
    WHEN ${DISPOSAL_SQL} THEN 'disposed'
    WHEN ${STUCK_SQL} THEN 'stuck'
    WHEN ${DELAYED_SQL} THEN 'delayed'
    WHEN COALESCE(r.tracking_status, 'unknown') = 'exception' THEN 'exception'
    ELSE 'unknown'
  END
)`
const ABNORMAL_SEVERITY_RANK_SQL = `(
  CASE
    WHEN ${DISPOSAL_SQL} THEN ${SHIPPING_ALERT_SEVERITY_RANK.disposed}
    WHEN ${STUCK_SQL} THEN ${SHIPPING_ALERT_SEVERITY_RANK.stuck}
    WHEN ${DELAYED_SQL} THEN ${SHIPPING_ALERT_SEVERITY_RANK.delayed}
    WHEN COALESCE(r.tracking_status, 'unknown') = 'exception' THEN ${SHIPPING_ALERT_SEVERITY_RANK.exception}
    ELSE ${SHIPPING_ALERT_SEVERITY_RANK.unknown}
  END
)`

/** Every parcel currently in the abnormal-open set, for review-ledger hygiene. */
const ABNORMAL_OPEN_RECEIPT_IDS_SQL = `
  SELECT r.receipt_id FROM receipts r
  WHERE ${FOURPX_ACTIVE_SHIPMENT_SQL} AND ${ABNORMAL_OPEN_SQL}
`

/**
 * The epoch at which the dashboard can honestly claim it LEARNED about a
 * parcel's current abnormal state — the carrier check that produced it, not the
 * moment somebody happened to open the tab.
 *
 * Carriers back-date events (a disposal scan can arrive with a 30-day-old
 * timestamp), so the event clock cannot answer "is this new to me?". The check
 * clock can. Clamped to @now so a bad cached timestamp can never date an
 * incident into the future and outrank real work forever.
 */
const ALERT_DETECTED_AT_SQL = `MIN(@now, COALESCE(r.tracking_checked_at, r.tracking_last_event_at, @now))`

/**
 * Not yet acknowledged at the parcel's CURRENT severity: never reviewed, or
 * escalated past the rank it was reviewed at.
 *
 * The single definition of "new", shared by the alert inbox, the parcel board
 * and the board's filter. It is deliberately computed from the live severity
 * rather than the incident ledger's peak, so a parcel that improved after being
 * reviewed cannot re-announce itself, and the two views can never disagree.
 * Requires `ar` from ALERT_LEDGER_JOIN_SQL.
 */
const ALERT_UNREVIEWED_SQL = `(ar.receipt_id IS NULL OR ${ABNORMAL_SEVERITY_RANK_SQL} > ar.severity_rank)`

/** Abnormal, still open, and not acknowledged at this severity. */
const NEW_ALERT_SQL = `(${ABNORMAL_OPEN_SQL} AND ${ALERT_UNREVIEWED_SQL})`

/**
 * Attaches both alert ledgers to a `receipts r` query. Neither can multiply
 * rows — receipt_id is the primary key of both — so this is safe to add to
 * aggregate and COUNT queries as well as row queries.
 */
const ALERT_LEDGER_JOIN_SQL = `
    LEFT JOIN shipping_alert_incidents ai ON ai.receipt_id = r.receipt_id
    LEFT JOIN shipping_alert_reviews   ar ON ar.receipt_id = r.receipt_id`

/**
 * Reconcile the incident ledger with the parcels that are abnormal right now:
 * open a row for each newly-abnormal parcel, move `flagged_at`/`peak_*` forward
 * when one escalates, and close rows for parcels that recovered.
 *
 * Every timestamp is derived from the carrier check that produced the state
 * (ALERT_DETECTED_AT_SQL) rather than from wall-clock at call time, which makes
 * this function safe to run at any cadence: a parcel that went stuck overnight
 * dates from the overnight check whether we reconcile at 03:00 or at 09:00.
 * A no-op in steady state — no writes at all when nothing changed.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [opts]
 * @param {number} [opts.now] Epoch seconds; injectable for tests.
 * @returns {{ opened: number, escalated: number, closed: number }}
 */
function syncShippingAlertIncidents(db, opts = {}) {
	const now = Number.isFinite(Number(opts.now)) ? Math.floor(Number(opts.now)) : Math.floor(Date.now() / 1000)

	// Recovered first, so an escalation pass never touches a row that is on its
	// way out, and a relapse always lands on a brand-new incident row.
	const closed = db.prepare(`
    DELETE FROM shipping_alert_incidents
    WHERE receipt_id NOT IN (${ABNORMAL_OPEN_RECEIPT_IDS_SQL})
  `)

	const opened = db.prepare(`
    INSERT OR IGNORE INTO shipping_alert_incidents (
      receipt_id, first_kind, first_rank, first_seen_at, peak_kind, peak_rank, flagged_at
    )
    SELECT
      r.receipt_id,
      ${ABNORMAL_KIND_SQL}, ${ABNORMAL_SEVERITY_RANK_SQL}, ${ALERT_DETECTED_AT_SQL},
      ${ABNORMAL_KIND_SQL}, ${ABNORMAL_SEVERITY_RANK_SQL}, ${ALERT_DETECTED_AT_SQL}
    FROM receipts r
    WHERE ${FOURPX_ACTIVE_SHIPMENT_SQL} AND ${ABNORMAL_OPEN_SQL}
  `)

	// Only upward moves are recorded. A parcel that eases from stuck back to
	// delayed keeps its peak, because the operator's outstanding task hasn't
	// changed — and re-dating it downward would push it back up the board.
	// MAX() keeps flagged_at monotonic even against a nonsense cached check time.
	const escalated = db.prepare(`
    UPDATE shipping_alert_incidents AS ai SET
      peak_kind  = (SELECT ${ABNORMAL_KIND_SQL} FROM receipts r WHERE r.receipt_id = ai.receipt_id),
      peak_rank  = (SELECT ${ABNORMAL_SEVERITY_RANK_SQL} FROM receipts r WHERE r.receipt_id = ai.receipt_id),
      flagged_at = MAX(ai.first_seen_at, (SELECT ${ALERT_DETECTED_AT_SQL} FROM receipts r WHERE r.receipt_id = ai.receipt_id))
    WHERE (SELECT ${ABNORMAL_SEVERITY_RANK_SQL} FROM receipts r WHERE r.receipt_id = ai.receipt_id) > ai.peak_rank
  `)

	return db.transaction(() => {
		// Capture ids that will become NEW incident rows (first open or relapse)
		// BEFORE the insert, so we can clear a stale "already messaged" snapshot
		// without wiping history in shipping_buyer_notices.
		const pending = db
			.prepare(
				`
      SELECT r.receipt_id AS receipt_id FROM receipts r
      WHERE ${FOURPX_ACTIVE_SHIPMENT_SQL} AND ${ABNORMAL_OPEN_SQL}
        AND r.receipt_id NOT IN (SELECT receipt_id FROM shipping_alert_incidents)
    `,
			)
			.all()
			.map((r) => r.receipt_id)

		const result = {
			closed: closed.run().changes,
			opened: opened.run({ now }).changes,
			escalated: escalated.run({ now }).changes,
		}
		if (pending.length) resetShippingBuyerNoticeSnapshot(db, pending)
		return result
	})()
}

/**
 * Drop review rows for parcels that are no longer abnormal (delivered, cancelled,
 * archived, or recovered). Without this a parcel that goes stuck → reviewed →
 * moving again → stuck again would stay silent forever, hiding a genuinely new
 * incident behind a stale acknowledgement.
 *
 * Skipped entirely when the ledger is empty, which is the common case.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {number} rows removed
 */
function pruneShippingAlertReviews(db) {
	const any = db.prepare('SELECT 1 FROM shipping_alert_reviews LIMIT 1').get()
	if (!any) return 0
	return db
		.prepare(
			`
    DELETE FROM shipping_alert_reviews
    WHERE receipt_id NOT IN (${ABNORMAL_OPEN_RECEIPT_IDS_SQL})
  `,
		)
		.run().changes
}

/**
 * Bring both alert ledgers in line with the current abnormal set: the incident
 * ledger (what the machine has observed) and the review ledger (what the
 * operator has acknowledged).
 *
 * This is the one hygiene entry point. Call it after any pass that can change a
 * parcel's health — the carrier sweep does, and the read paths do too so a
 * dashboard opened days later still shows correct incident ages.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [opts] Forwarded to syncShippingAlertIncidents.
 * @returns {{ opened:number, escalated:number, closed:number, reviews_pruned:number }}
 */
function syncShippingAlertLedger(db, opts = {}) {
	const incidents = syncShippingAlertIncidents(db, opts)
	return { ...incidents, reviews_pruned: pruneShippingAlertReviews(db) }
}

/**
 * Mark abnormal parcels as reviewed at their CURRENT severity, so they drop out
 * of the "new" set until they escalate. Passing no ids reviews every parcel that
 * is currently new — the "Mark all reviewed" action.
 *
 * Unknown, delivered and already-reviewed-at-this-severity parcels are ignored
 * rather than erroring, so a stale browser tab can never poison the ledger.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [opts]
 * @param {Array<number|string>} [opts.receiptIds] Omit/empty to review all new alerts.
 * @param {string} [opts.reviewedBy]               Session username, for the audit trail.
 * @returns {{ reviewed: number, receipt_ids: number[] }}
 */
function reviewShippingAlerts(db, opts = {}) {
	const reviewedBy = opts.reviewedBy ? String(opts.reviewedBy).slice(0, 120) : null
	const reviewedAt = Math.floor(Date.now() / 1000)

	const requested = Array.isArray(opts.receiptIds) ? [...new Set(opts.receiptIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))] : null
	// An explicit empty array is a no-op, not "review everything" — only an absent
	// list means "all". This keeps a buggy caller from clearing the whole inbox.
	if (requested && requested.length === 0) return { reviewed: 0, receipt_ids: [] }

	const scope = [FOURPX_ACTIVE_SHIPMENT_SQL, ABNORMAL_OPEN_SQL]
	const params = { reviewedAt, reviewedBy }
	if (requested) {
		scope.push(`r.receipt_id IN (${requested.map((_, i) => `@id${i}`).join(', ')})`)
		requested.forEach((id, i) => {
			params[`id${i}`] = id
		})
	}

	const rows = db
		.prepare(
			`
    SELECT r.receipt_id, ${ABNORMAL_KIND_SQL} AS abnormal_kind, ${ABNORMAL_SEVERITY_RANK_SQL} AS severity_rank
    FROM receipts r
    LEFT JOIN shipping_alert_reviews ar ON ar.receipt_id = r.receipt_id
    WHERE ${scope.join(' AND ')}
      AND (ar.receipt_id IS NULL OR ${ABNORMAL_SEVERITY_RANK_SQL} > ar.severity_rank)
  `,
		)
		.all(params)

	if (!rows.length) return { reviewed: 0, receipt_ids: [] }

	const upsert = db.prepare(`
    INSERT INTO shipping_alert_reviews (receipt_id, abnormal_kind, severity_rank, reviewed_at, reviewed_by)
    VALUES (@receiptId, @kind, @rank, @reviewedAt, @reviewedBy)
    ON CONFLICT(receipt_id) DO UPDATE SET
      abnormal_kind = @kind,
      severity_rank = @rank,
      reviewed_at   = @reviewedAt,
      reviewed_by   = @reviewedBy
  `)
	db.transaction(() => {
		for (const row of rows) {
			upsert.run({
				receiptId: row.receipt_id,
				kind: row.abnormal_kind,
				rank: row.severity_rank,
				reviewedAt,
				reviewedBy,
			})
		}
	})()

	return { reviewed: rows.length, receipt_ids: rows.map((r) => r.receipt_id) }
}

/**
 * Actionable abnormal parcels for the Shipping morning-review alert. Unlike the
 * paginated parcel list, this intentionally ignores date-window filters so a
 * long-silent stuck/disposed parcel still surfaces even when the default board
 * is scoped to "Last 30 days".
 *
 * Each alert carries `is_new`: true when the parcel has never been reviewed, or
 * when it escalated past the severity it was reviewed at. That is what turns the
 * standing abnormal list into a morning inbox — the operator sees what changed
 * since they last worked the queue, not the same backlog every day.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [opts]
 * @param {string} [opts.shopId]
 * @param {number} [opts.limit]
 * @returns {{ alerts: Array, summary: object }}
 */
function getShippingAlerts(db, opts = {}) {
	// Self-heal both ledgers first: open incidents for parcels that just turned
	// abnormal, and drop acknowledgements for parcels that recovered so a relapse
	// alerts again instead of being silenced forever by a stale review.
	try {
		syncShippingAlertLedger(db, opts)
	} catch (err) {
		// Hygiene must never take down the morning review.
		console.warn('[4px] shipping alert ledger sync failed:', err.message)
	}

	const where = [FOURPX_ACTIVE_SHIPMENT_SQL, ABNORMAL_OPEN_SQL]
	// Kept separate because better-sqlite3 rejects named parameters a statement
	// does not use, and the count query has no LIMIT.
	const scopeParams = {}
	if (opts.shopId) {
		where.push('r.shop_id = @shopId')
		scopeParams.shopId = opts.shopId
	}
	const rawLimit = Number(opts.limit)
	const params = {
		...scopeParams,
		limit: Number.isFinite(rawLimit) ? Math.min(500, Math.max(1, Math.floor(rawLimit))) : 200,
	}
	const W = where.join(' AND ')

	const trackingNoExpr = SHIPMENT_TRACKING_NO_SQL

	const rows = db
		.prepare(
			`
    SELECT
      r.receipt_id,
      r.shop_id,
      s.shop_name,
      r.name AS buyer_name,
      ${trackingNoExpr} AS tracking_no,
      CASE WHEN ${trackingNoExpr} IS NOT NULL THEN 1 ELSE 0 END AS tracking_lookup_supported,
      r.tracking_status,
      r.tracking_last_event,
      r.tracking_last_event_at,
      r.tracking_health,
      r.tracking_health_reason,
      r.tracking_checked_at,
      ${ABNORMAL_KIND_SQL} AS abnormal_kind,
      ${ABNORMAL_SEVERITY_RANK_SQL} AS severity_rank,
      CASE WHEN ${DISPOSAL_SQL} THEN 1 ELSE 0 END AS is_disposed,
      CASE WHEN ${STUCK_SQL} THEN 1 ELSE 0 END AS is_stuck,
      ai.first_seen_at,
      ai.flagged_at,
      ar.reviewed_at,
      ar.reviewed_by,
      CASE WHEN ${ALERT_UNREVIEWED_SQL} THEN 1 ELSE 0 END AS is_new
    FROM receipts r
    JOIN shops s ON s.shop_id = r.shop_id${ALERT_LEDGER_JOIN_SQL}
    WHERE ${W}
    ORDER BY
      is_new DESC,
      severity_rank DESC,
      -- Newest incident first inside a severity band, so "what happened while I
      -- was asleep" reads top-down. Carrier event age is the fallback for rows
      -- whose incident predates the ledger.
      COALESCE(ai.flagged_at, r.tracking_last_event_at, r.tracking_checked_at, 0) DESC,
      r.receipt_id DESC
    LIMIT @limit
  `,
		)
		.all(params)

	// Counted over the WHOLE abnormal set, not the page above. The banner leads
	// with "N new parcels need action", so that number has to be the truth even
	// when the row list is capped — an understated alert count is worse than no
	// alert at all.
	const counts = db
		.prepare(
			`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN ${DISPOSAL_SQL} THEN 1 ELSE 0 END) AS disposed,
      SUM(CASE WHEN NOT ${DISPOSAL_SQL} AND ${STUCK_SQL} THEN 1 ELSE 0 END) AS stuck,
      SUM(CASE WHEN NOT ${DISPOSAL_SQL} AND NOT ${STUCK_SQL} AND ${DELAYED_SQL} THEN 1 ELSE 0 END) AS delayed,
      SUM(CASE WHEN ${ABNORMAL_KIND_SQL} = 'exception' THEN 1 ELSE 0 END) AS exception,
      SUM(CASE WHEN ${ALERT_UNREVIEWED_SQL} THEN 1 ELSE 0 END) AS new_total,
      SUM(CASE WHEN ${ALERT_UNREVIEWED_SQL} AND ${ABNORMAL_KIND_SQL} = 'disposed' THEN 1 ELSE 0 END) AS new_disposed,
      SUM(CASE WHEN ${ALERT_UNREVIEWED_SQL} AND ${ABNORMAL_KIND_SQL} = 'stuck' THEN 1 ELSE 0 END) AS new_stuck,
      SUM(CASE WHEN ${ALERT_UNREVIEWED_SQL} AND ${ABNORMAL_KIND_SQL} = 'delayed' THEN 1 ELSE 0 END) AS new_delayed,
      SUM(CASE WHEN ${ALERT_UNREVIEWED_SQL} AND ${ABNORMAL_KIND_SQL} = 'exception' THEN 1 ELSE 0 END) AS new_exception,
      MAX(CASE WHEN ${ALERT_UNREVIEWED_SQL} THEN ai.flagged_at END) AS newest_flagged_at,
      MAX(ar.reviewed_at) AS last_reviewed_at
    FROM receipts r${ALERT_LEDGER_JOIN_SQL}
    WHERE ${W}
  `,
		)
		.get(scopeParams)

	const summary = {
		total: Number(counts.total || 0),
		disposed: Number(counts.disposed || 0),
		stuck: Number(counts.stuck || 0),
		delayed: Number(counts.delayed || 0),
		exception: Number(counts.exception || 0),
		// The morning-review half: how much of the standing backlog is actually new.
		new_total: Number(counts.new_total || 0),
		new_disposed: Number(counts.new_disposed || 0),
		new_stuck: Number(counts.new_stuck || 0),
		new_delayed: Number(counts.new_delayed || 0),
		new_exception: Number(counts.new_exception || 0),
		// When the most recent still-untriaged incident was detected. Lets the
		// banner answer "did anything happen overnight?" without the operator
		// reading a single row.
		newest_flagged_at: counts.newest_flagged_at ?? null,
		last_reviewed_at: counts.last_reviewed_at ?? null,
		// How much of the abnormal set the `alerts` array actually carries, so the
		// caller can say "+N more" honestly instead of guessing.
		returned: rows.length,
	}

	const alerts = rows.map((row) => ({
		receipt_id: row.receipt_id,
		shop_id: row.shop_id,
		shop_name: row.shop_name,
		buyer_name: row.buyer_name,
		tracking_no: row.tracking_no,
		tracking_lookup_supported: !!row.tracking_lookup_supported,
		tracking_status: row.tracking_status,
		tracking_last_event: row.tracking_last_event,
		tracking_last_event_at: row.tracking_last_event_at,
		tracking_health: row.tracking_health,
		tracking_health_reason: row.tracking_health_reason,
		tracking_checked_at: row.tracking_checked_at,
		abnormal_kind: row.abnormal_kind,
		severity_rank: row.severity_rank,
		is_disposed: !!row.is_disposed,
		is_stuck: !!row.is_stuck,
		is_new: !!row.is_new,
		// Our clock, not the carrier's: when this incident opened and when it last
		// got worse. Null only for a parcel abnormal since before the ledger.
		first_seen_at: row.first_seen_at ?? null,
		flagged_at: row.flagged_at ?? null,
		reviewed_at: row.reviewed_at ?? null,
		reviewed_by: row.reviewed_by ?? null,
	}))

	return { alerts, summary }
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
	const now = Math.floor(Date.now() / 1000)
	db.prepare(
		`
    INSERT INTO fourpx_balance (id, amount, currency, as_of, note, updated_at)
    VALUES (1, @amount, @currency, @asOf, @note, @now)
    ON CONFLICT(id) DO UPDATE SET
      amount = @amount, currency = @currency, as_of = @asOf, note = @note, updated_at = @now
  `,
	).run({ amount, currency: (currency || 'CNY').toUpperCase(), asOf: asOf ?? now, note, now })
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
	const snap = db.prepare('SELECT amount, currency, as_of, note FROM fourpx_balance WHERE id = 1').get()
	if (!snap) {
		return { configured: false, amount: null, currency: null, as_of: null, note: null, spent_since: 0, billed_orders: 0, estimated_orders: 0, estimated_remaining: null }
	}
	const currency = snap.currency || 'CNY'
	const spent = db
		.prepare(
			`
    SELECT
      COALESCE(SUM(r.fourpx_freight_amount), 0) AS spent,
      SUM(CASE WHEN r.fourpx_freight_status = 'billed'    THEN 1 ELSE 0 END) AS billed_orders,
      SUM(CASE WHEN r.fourpx_freight_status = 'estimated' THEN 1 ELSE 0 END) AS estimated_orders
    FROM receipts r
    WHERE (r.fourpx_consignment_no IS NOT NULL OR r.tracking_code LIKE '4PX%')
      AND r.fourpx_freight_amount IS NOT NULL
      AND COALESCE(r.fourpx_freight_currency, 'CNY') = @currency
      AND COALESCE(r.shipment_notified_at, r.fourpx_created_at, r.etsy_created_at) >= @asOf
  `,
		)
		.get({ currency, asOf: snap.as_of })

	const spentSince = +(spent.spent || 0).toFixed(2)
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
	}
}

// ─── Route assignments ────────────────────────────────────────────────────────

const _VALID_STATUSES = new Set(['Pending', 'Purchased', 'Out of Stock', 'Out of Production', 'Wrong Stall', 'Model Unavailable'])

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
		throw new Error('upsertRouteAssignment requires receipt_id and item_key')
	}

	// This used to SELECT the row, merge the patch in JavaScript, then overwrite
	// every column. Two dashboard processes could both read the same old row and
	// the later partial write would erase the earlier component update. One UPSERT
	// with per-field presence flags makes the merge atomic inside SQLite.
	const validCase = a.status_case != null && _VALID_STATUSES.has(a.status_case)
	const validGrip = a.status_grip != null && _VALID_STATUSES.has(a.status_grip)
	const validCharm = a.status_charm != null && _VALID_STATUSES.has(a.status_charm)
	const params = {
		receipt_id: a.receipt_id,
		item_key: a.item_key,
		title: a.title ?? '',
		charm_code: a.charm_code ?? '',
		charm_shop: a.charm_shop ?? '',
		status_case: validCase ? a.status_case : 'Pending',
		status_grip: validGrip ? a.status_grip : 'Pending',
		status_charm: validCharm ? a.status_charm : 'Pending',
		excluded: a.excluded ? 1 : 0,
		supplier_shop_override: a.supplier_shop_override ?? '',
		supplier_stall_override: a.supplier_stall_override ?? '',
		updated_at: Math.floor(Date.now() / 1000),
		has_title: a.title != null ? 1 : 0,
		has_charm_code: a.charm_code != null ? 1 : 0,
		has_charm_shop: a.charm_shop != null ? 1 : 0,
		has_status_case: validCase ? 1 : 0,
		has_status_grip: validGrip ? 1 : 0,
		has_status_charm: validCharm ? 1 : 0,
		has_excluded: a.excluded != null ? 1 : 0,
		has_supplier_shop: a.supplier_shop_override != null ? 1 : 0,
		has_supplier_stall: a.supplier_stall_override != null ? 1 : 0,
	}

	return db
		.prepare(
			`
    INSERT INTO route_assignments
      (receipt_id, item_key, title, charm_code, charm_shop,
       status_case, status_grip, status_charm, excluded,
       supplier_shop_override, supplier_stall_override, updated_at)
    VALUES
      (@receipt_id, @item_key, @title, @charm_code, @charm_shop,
       @status_case, @status_grip, @status_charm, @excluded,
       @supplier_shop_override, @supplier_stall_override, @updated_at)
    ON CONFLICT(receipt_id, item_key) DO UPDATE SET
      title = CASE
        WHEN @has_title = 1 THEN excluded.title
        ELSE route_assignments.title
      END,
      charm_code = CASE
        WHEN @has_charm_code = 1 THEN excluded.charm_code
        ELSE route_assignments.charm_code
      END,
      charm_shop = CASE
        WHEN @has_charm_shop = 1 THEN excluded.charm_shop
        ELSE route_assignments.charm_shop
      END,
      status_case = CASE
        WHEN @has_status_case = 1 THEN excluded.status_case
        ELSE route_assignments.status_case
      END,
      status_grip = CASE
        WHEN @has_status_grip = 1 THEN excluded.status_grip
        ELSE route_assignments.status_grip
      END,
      status_charm = CASE
        WHEN @has_status_charm = 1 THEN excluded.status_charm
        ELSE route_assignments.status_charm
      END,
      excluded = CASE
        WHEN @has_excluded = 1 THEN excluded.excluded
        ELSE route_assignments.excluded
      END,
      supplier_shop_override = CASE
        WHEN @has_supplier_shop = 1 THEN excluded.supplier_shop_override
        ELSE route_assignments.supplier_shop_override
      END,
      supplier_stall_override = CASE
        WHEN @has_supplier_stall = 1 THEN excluded.supplier_stall_override
        ELSE route_assignments.supplier_stall_override
      END,
      updated_at              = excluded.updated_at
    RETURNING *
  `,
		)
		.get(params)
}

/**
 * One order line's stored assignment, or null when the line was never edited.
 * Callers that must know what a write CHANGED (rather than just its result) read
 * this first — inside the same transaction as the write.
 *
 * @param {Database.Database} db
 * @param {number} receiptId
 * @param {string} itemKey
 * @returns {object|null}
 */
function getRouteAssignment(db, receiptId, itemKey) {
	if (receiptId == null || !itemKey) return null
	return db.prepare('SELECT * FROM route_assignments WHERE receipt_id = ? AND item_key = ?').get(Number(receiptId), String(itemKey)) || null
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
		throw new Error('setRouteDismissed requires receipt_id and item_key')
	}
	const now = Math.floor(Date.now() / 1000)
	const dismissedAt = a.dismissed ? now : null

	db.prepare(
		`
    INSERT INTO route_assignments (receipt_id, item_key, title, dismissed_at, updated_at)
    VALUES (@receipt_id, @item_key, @title, @dismissed_at, @updated_at)
    ON CONFLICT(receipt_id, item_key) DO UPDATE SET
      dismissed_at = excluded.dismissed_at,
      updated_at   = excluded.updated_at
  `,
	).run({
		receipt_id: Number(a.receipt_id),
		item_key: String(a.item_key),
		title: a.title ?? '',
		dismissed_at: dismissedAt,
		updated_at: now,
	})

	return { receipt_id: Number(a.receipt_id), item_key: String(a.item_key), dismissed_at: dismissedAt }
}

/**
 * Set (or clear) the VERIFICATION stamp on a single order line. "Verified" means a
 * packer physically confirmed the item is in hand — a distinct, stronger signal
 * than the shopper's "Purchased" assertion. Upsert so a line with no prior saved
 * assignment can still be verified. Only the verification fields change; charm /
 * status / supplier fields are preserved. Works for real + manual receipts alike.
 *
 * @param {Database.Database} db
 * @param {{ receipt_id:number, item_key:string, title?:string, verified:boolean, by?:string }} a
 * @returns {{ receipt_id:number, item_key:string, verified_at:number|null, verified_by:string }}
 */
function setRouteVerified(db, a) {
	if (a.receipt_id == null || !a.item_key) {
		throw new Error('setRouteVerified requires receipt_id and item_key')
	}
	const now = Math.floor(Date.now() / 1000)
	const verifiedAt = a.verified ? now : null
	const verifiedBy = a.verified ? String(a.by || '').slice(0, 60) : ''
	db.prepare(
		`
    INSERT INTO route_assignments (receipt_id, item_key, title, verified_at, verified_by, updated_at)
    VALUES (@receipt_id, @item_key, @title, @verified_at, @verified_by, @updated_at)
    ON CONFLICT(receipt_id, item_key) DO UPDATE SET
      verified_at = excluded.verified_at,
      verified_by = excluded.verified_by,
      updated_at  = excluded.updated_at
  `,
	).run({
		receipt_id: Number(a.receipt_id),
		item_key: String(a.item_key),
		title: a.title ?? '',
		verified_at: verifiedAt,
		verified_by: verifiedBy,
		updated_at: now,
	})
	return { receipt_id: Number(a.receipt_id), item_key: String(a.item_key), verified_at: verifiedAt, verified_by: verifiedBy }
}

/**
 * Verify (or unverify) a NO-COMPONENT line tracked in receipt_item_purchase.
 *
 * Upsert (not update-only): a no-component product that was in stock is "in hand"
 * without ever having been flagged to buy, so it may have NO purchase row yet — but
 * the packer must still be able to verify it (otherwise such an order could never
 * satisfy the verify gate and would be stranded). On insert we therefore create the
 * row as needs_purchase = 0 (in hand). On conflict we ONLY stamp the verification
 * fields — needs_purchase / flagged_at / purchased_at are left exactly as they were.
 *
 * @param {Database.Database} db
 * @param {{ receipt_id:number, item_key:string, title?:string, verified:boolean, by?:string }} a
 * @returns {number} rows changed
 */
function setItemPurchaseVerified(db, a) {
	const now = Math.floor(Date.now() / 1000)
	const verifiedAt = a.verified ? now : null
	const verifiedBy = a.verified ? String(a.by || '').slice(0, 60) : ''
	try {
		const info = db
			.prepare(
				`
      INSERT INTO receipt_item_purchase (receipt_id, item_key, title, needs_purchase, verified_at, verified_by, updated_at)
      VALUES (@receipt_id, @item_key, @title, 0, @verified_at, @verified_by, @updated_at)
      ON CONFLICT(receipt_id, item_key) DO UPDATE SET
        verified_at = excluded.verified_at,
        verified_by = excluded.verified_by,
        title       = COALESCE(excluded.title, title),
        updated_at  = excluded.updated_at
    `,
			)
			.run({
				receipt_id: Number(a.receipt_id),
				item_key: String(a.item_key),
				title: a.title ?? null,
				verified_at: verifiedAt,
				verified_by: verifiedBy,
				updated_at: now,
			})
		return info.changes || 0
	} catch {
		return 0
	}
}

/**
 * Clear any VERIFICATION stamp on a single line whenever it is no longer confirmed
 * in hand (its purchase status regressed). Keeps verification honest without the
 * caller having to reason about which storage table backs the line.
 * @param {Database.Database} db
 */
function clearRouteVerified(db, receiptId, itemKey) {
	try {
		db.prepare("UPDATE route_assignments SET verified_at = NULL, verified_by = '' WHERE receipt_id = ? AND item_key = ?").run(Number(receiptId), String(itemKey))
	} catch {
		/* ignore */
	}
	try {
		db.prepare("UPDATE receipt_item_purchase SET verified_at = NULL, verified_by = '' WHERE receipt_id = ? AND item_key = ?").run(Number(receiptId), String(itemKey))
	} catch {
		/* ignore */
	}
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
		const info = db.prepare('UPDATE route_assignments SET dismissed_at = NULL WHERE receipt_id = ? AND dismissed_at IS NOT NULL').run(Number(receiptId))
		return info.changes || 0
	} catch {
		return 0
	}
}

// SQLite builds differ in their variable limit. Keep scoped dashboard reads
// comfortably below even conservative limits, and make the bound explicit for
// tests/performance reviews.
const _DB_SCOPE_CHUNK_SIZE = 500

function _integerScope(scope) {
	if (scope == null) return null
	return [...new Set([...scope].map(Number).filter(Number.isInteger))]
}

function _stringScope(scope) {
	if (scope == null) return null
	return [...new Set([...scope].map((value) => String(value)).filter(Boolean))]
}

function _forEachScopeChunk(values, visit) {
	for (let i = 0; i < values.length; i += _DB_SCOPE_CHUNK_SIZE) {
		visit(values.slice(i, i + _DB_SCOPE_CHUNK_SIZE))
	}
}

/**
 * Fetch every saved route assignment as a map keyed by `${receipt_id}\x00${item_key}`.
 * @param {Database.Database} db
 * @param {Iterable<number>} [receiptIds] optional receipt scope; [] means none
 * @returns {Record<string, object>}
 */
function getAllRouteAssignments(db, receiptIds) {
	const map = {}
	const ids = _integerScope(receiptIds)
	const add = (a) => {
		map[`${a.receipt_id}\x00${a.item_key}`] = a
	}
	if (ids === null) {
		db.prepare('SELECT * FROM route_assignments').all().forEach(add)
	} else {
		_forEachScopeChunk(ids, (chunk) => {
			const ph = chunk.map(() => '?').join(',')
			db.prepare(`SELECT * FROM route_assignments WHERE receipt_id IN (${ph})`).all(chunk).forEach(add)
		})
	}
	return map
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
	if (!a.item_key) throw new Error('upsertProductAssignment requires item_key')

	const existing = db.prepare('SELECT * FROM product_assignments WHERE item_key = ?').get(a.item_key) || {}

	// Only overwrite a field when the caller supplies a non-empty value.
	const pick = (next, prev) => (next != null && next !== '' ? next : (prev ?? ''))

	const row = {
		item_key: a.item_key,
		title: pick(a.title, existing.title),
		supplier_shop: pick(a.supplier_shop, existing.supplier_shop),
		supplier_stall: pick(a.supplier_stall, existing.supplier_stall),
		charm_code: pick(a.charm_code, existing.charm_code),
		charm_shop: pick(a.charm_shop, existing.charm_shop),
		updated_at: Math.floor(Date.now() / 1000),
	}

	db.prepare(
		`
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
  `,
	).run(row)

	return row
}

/**
 * One product's saved defaults, or null. Callers that must know what a write
 * CHANGED read this before writing.
 *
 * @param {Database.Database} db
 * @param {string} itemKey - product-defaults key (routeDashboard.productDefaultsKey)
 * @returns {object|null}
 */
function getProductAssignment(db, itemKey) {
	if (!itemKey) return null
	try {
		return db.prepare('SELECT * FROM product_assignments WHERE item_key = ?').get(String(itemKey)) || null
	} catch {
		return null // table may not exist on first run before server restart
	}
}

/**
 * Fetch every product assignment as a map keyed by item_key.
 * @param {Database.Database} db
 * @param {Iterable<string>} [itemKeys] optional item-key scope; [] means none
 * @returns {Record<string, object>}
 */
function getAllProductAssignments(db, itemKeys) {
	const map = {}
	const keys = _stringScope(itemKeys)
	try {
		const add = (a) => {
			map[a.item_key] = a
		}
		if (keys === null) {
			db.prepare('SELECT * FROM product_assignments').all().forEach(add)
		} else {
			_forEachScopeChunk(keys, (chunk) => {
				const ph = chunk.map(() => '?').join(',')
				db.prepare(`SELECT * FROM product_assignments WHERE item_key IN (${ph})`).all(chunk).forEach(add)
			})
		}
	} catch {
		/* table may not exist on first run before server restart */
	}
	return map
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
	const title = String(patch.title || '').trim()
	if (!title) return null
	const titleNorm = _normTitleForKey(title)
	if (!titleNorm) return null

	const now = Math.floor(Date.now() / 1000)
	// undefined → keep previous; defined → use the trimmed provided value (incl. '')
	const choose = (next, prev) => (next === undefined ? (prev ?? '') : String(next ?? '').trim())

	const existing = db.prepare('SELECT * FROM product_map WHERE title_norm = ?').get(titleNorm)

	if (existing) {
		const next = {
			id: existing.id,
			shop_name: choose(patch.supplier_shop, existing.shop_name),
			stall: choose(patch.supplier_stall, existing.stall),
			charm_shop: choose(patch.charm_shop, existing.charm_shop),
			charm_code: choose(patch.charm_code, existing.charm_code),
			updated_at: now,
		}
		const unchanged = next.shop_name === (existing.shop_name ?? '') && next.stall === (existing.stall ?? '') && next.charm_shop === (existing.charm_shop ?? '') && next.charm_code === (existing.charm_code ?? '')
		if (unchanged) return { id: existing.id, title_norm: titleNorm, changed: false }

		db.prepare(
			`
      UPDATE product_map
      SET shop_name = @shop_name, stall = @stall,
          charm_shop = @charm_shop, charm_code = @charm_code, updated_at = @updated_at
      WHERE id = @id
    `,
		).run(next)
		return { id: existing.id, title_norm: titleNorm, changed: true }
	}

	const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM product_map').get().m
	const info = db
		.prepare(
			`
    INSERT INTO product_map (title_norm, title, shop_name, stall, charm_shop, charm_code, sort_order, updated_at)
    VALUES (@title_norm, @title, @shop_name, @stall, @charm_shop, @charm_code, @sort_order, @updated_at)
  `,
		)
		.run({
			title_norm: titleNorm,
			title,
			shop_name: choose(patch.supplier_shop, ''),
			stall: choose(patch.supplier_stall, ''),
			charm_shop: choose(patch.charm_shop, ''),
			charm_code: choose(patch.charm_code, ''),
			sort_order: maxOrder + 1,
			updated_at: now,
		})
	return { id: info.lastInsertRowid, title_norm: titleNorm, changed: true }
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
	const titleNorm = _normTitleForKey(row.title || '')
	if (!titleNorm) return 0
	const base = titleNorm.slice(0, 50)
	const assignments = db.prepare('SELECT item_key, title FROM product_assignments').all()
	const update = db.prepare(
		`UPDATE product_assignments
		 SET supplier_shop = @supplier_shop, supplier_stall = @supplier_stall,
		     charm_shop = @charm_shop, charm_code = @charm_code, updated_at = @updated_at
		 WHERE item_key = @item_key`,
	)
	const values = {
		supplier_shop: String(row.shop_name || '').trim(),
		supplier_stall: String(row.stall || '').trim(),
		charm_shop: String(row.charm_shop || '').trim(),
		charm_code: String(row.charm_code || '').trim(),
		updated_at: Math.floor(Date.now() / 1000),
	}
	let changed = 0
	for (const assignment of assignments) {
		const exactTitle = assignment.title && _normTitleForKey(assignment.title) === titleNorm
		const safeLegacy = !assignment.title && assignment.item_key === base
		if (exactTitle || safeLegacy) {
			changed += update.run({ ...values, item_key: assignment.item_key }).changes
		}
	}
	return changed
}

/**
 * One Product Catalog row, by id or by product title, or null.
 * Callers that must know what a catalog edit CHANGED read this before writing.
 *
 * @param {Database.Database} db
 * @param {{ id?: number|string, title?: string }} ref
 * @returns {object|null}
 */
function getProductMapRow(db, ref) {
	const id = Number(ref && ref.id)
	if (Number.isInteger(id) && id > 0) {
		return db.prepare('SELECT * FROM product_map WHERE id = ?').get(id) || null
	}
	const titleNorm = _normTitleForKey((ref && ref.title) || '')
	if (!titleNorm) return null
	return db.prepare('SELECT * FROM product_map WHERE title_norm = ?').get(titleNorm) || null
}

/** Purchase status meaning "the recorded stall is wrong" (src/route/sourcing.js). */
const WRONG_STALL_STATUS = 'Wrong Stall'

/** What a cleared Wrong Stall becomes — sourcing.RESOLVED_STATUS. */
const RESOLVED_WRONG_STALL_STATUS = 'Pending'

/** Component status fields cleared by a correction to each kind of location. */
const _WRONG_STALL_FIELDS = {
	supplier: ['status_case', 'status_grip'],
	charm: ['status_charm'],
}

/**
 * When an order line's location for each kind actually COMES FROM the product
 * level, i.e. the line has no override of its own to outrank it (the priority
 * chain buildRouteRows applies). A line that keeps its own hand-entered stall
 * did not move when the product's did, so a product-level fix is no answer to
 * its report — see resolveWrongStallForProduct.
 */
const _WRONG_STALL_INHERITS = {
	supplier: "COALESCE(supplier_shop_override, '') = '' AND COALESCE(supplier_stall_override, '') = ''",
	charm: "COALESCE(charm_code, '') = '' AND COALESCE(charm_shop, '') = ''",
}

/**
 * Clear the "Wrong Stall" flags that a PRODUCT-level location correction answers.
 *
 * A per-product truth (the Product Catalog, or the default saved from the Route
 * tab) answers the report on every outstanding order line that INHERITS it — not
 * only the line the operator happened to be looking at, and not lines pinned to
 * their own stall. Flags are reset to Pending: both statuses are "outstanding"
 * work (src/orders/buy-queue.js), so nothing changes about what an order owes —
 * only where to go for it.
 *
 * Scoped by WHICH location moved, so fixing a supplier stall never silently
 * closes a separate complaint about the charm stall (or the other way round).
 *
 * @param {Database.Database} db
 * @param {string} title - the product title whose recorded location changed
 * @param {{ supplier?: boolean, charm?: boolean }} moved - locations that changed
 * @returns {object[]} the route_assignments rows that were reset
 */
function resolveWrongStallForProduct(db, title, moved) {
	const base = _baseTitleKey(title)
	if (!base) return []

	// One clause per moved location: flagged on a component that location covers,
	// AND taking that location from the product level. Column names come from the
	// fixed whitelists above; every value is bound.
	const clauses = []
	const resets = []
	for (const [kind, cols] of Object.entries(_WRONG_STALL_FIELDS)) {
		if (!moved || !moved[kind]) continue
		const inherits = _WRONG_STALL_INHERITS[kind]
		clauses.push(`(${inherits}) AND (${cols.map((f) => `${f} = @wrong`).join(' OR ')})`)
		for (const f of cols) {
			resets.push(`${f} = CASE WHEN ${f} = @wrong AND (${inherits}) THEN @resolved ELSE ${f} END`)
		}
	}
	if (!clauses.length) return []

	// Listing-scoped keys (`base#L<listing_id>`) and the legacy bare key both
	// belong to the same product.
	const scope = `(item_key = @base OR item_key LIKE @like) AND (${clauses.map((c) => `(${c})`).join(' OR ')})`
	const params = { base, like: `${base}#L%`, wrong: WRONG_STALL_STATUS }

	const affected = db.prepare(`SELECT receipt_id, item_key FROM route_assignments WHERE ${scope}`).all(params)
	if (!affected.length) return []

	db.prepare(`UPDATE route_assignments SET ${resets.join(', ')}, updated_at = @now WHERE ${scope}`).run({ ...params, resolved: RESOLVED_WRONG_STALL_STATUS, now: Math.floor(Date.now() / 1000) })

	const read = db.prepare('SELECT * FROM route_assignments WHERE receipt_id = ? AND item_key = ?')
	return affected.map((a) => read.get(a.receipt_id, a.item_key)).filter(Boolean)
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
	let rows = []
	try {
		rows = db
			.prepare(
				`
      SELECT item_key, title, supplier_shop, supplier_stall, charm_code, charm_shop, updated_at
      FROM product_assignments
      ORDER BY updated_at ASC, item_key ASC
    `,
			)
			.all()
	} catch {
		return { ok: false, filled: 0, created: 0 }
	}

	let filled = 0,
		created = 0
	const tx = db.transaction(() => {
		for (const a of rows) {
			const title = String(a.title || '').trim()
			if (!title) continue

			const hasSupplier = !!(a.supplier_shop || a.supplier_stall)
			const hasCharm = !!(a.charm_code || a.charm_shop)
			if (!hasSupplier && !hasCharm) continue

			const patch = { title }
			if (hasSupplier) {
				patch.supplier_shop = a.supplier_shop || ''
				patch.supplier_stall = a.supplier_stall || ''
			}
			if (hasCharm) {
				patch.charm_code = a.charm_code || ''
				patch.charm_shop = a.charm_shop || ''
			}

			const existedBefore = db.prepare('SELECT 1 FROM product_map WHERE title_norm = ?').get(_normTitleForKey(title))
			const r = mergeProductMapSupplierCharm(db, patch)
			if (r && r.changed) {
				existedBefore ? filled++ : created++
			}
		}
	})
	tx()
	return { ok: true, filled, created }
}

// ── Supplier / charm-shop booth identity ─────────────────────────────────────
// A booth is (shop, stall). Letter case and NFKC/dash spelling must never invent
// a second booth for the same physical stop — that is what painted the greyed
// "ext" twin (汇通A146 vs 汇通a146) Manage could not delete. Every write path
// (Excel replace, in-app CRUD, startup heal) folds through these helpers.

/**
 * Prefer the more complete / more canonical spelling of a booth when two rows
 * fold to the same identity. Uppercase stall letters win (A146 over a146);
 * richer metadata wins next; earlier sort_order is the last tiebreak.
 */
function preferBoothRow(a, b) {
	const filled = (r) => ['mall', 'floor', 'address', 'notes'].filter((k) => String(r[k] || '').trim()).length
	const fa = filled(a)
	const fb = filled(b)
	if (fa !== fb) return fa > fb ? a : b
	const upper = (s) => (String(s || '').match(/[A-Z]/g) || []).length
	const ua = upper(a.stall)
	const ub = upper(b.stall)
	if (ua !== ub) return ua > ub ? a : b
	const sa = typeof a.sort_order === 'number' ? a.sort_order : 9999
	const sb = typeof b.sort_order === 'number' ? b.sort_order : 9999
	if (sa !== sb) return sa < sb ? a : b
	return a
}

/**
 * Collapse a list of booth rows to one per supplierIdentityKey, keeping the
 * preferred spelling. Used by Excel replace so a dirty workbook cannot reseed
 * case twins into the directory.
 * @param {Array<{shop_name?:*,stall?:*,[k:string]:*}>} rows
 * @returns {Array<object>}
 */
function foldBoothRowsByIdentity(rows) {
	const byKey = new Map()
	for (const raw of rows || []) {
		const shop = String(raw.shop_name || '').trim()
		if (!shop) continue
		const stall = String(raw.stall || '').trim()
		const k = stallLocation.supplierIdentityKey(shop, stall)
		if (!k || k === '\x00') continue
		const next = { ...raw, shop_name: shop, stall }
		const cur = byKey.get(k)
		byKey.set(k, cur ? preferBoothRow(cur, next) : next)
	}
	return [...byKey.values()]
}

/**
 * Build identity → canonical {shop, stall} from a directory table.
 * When two directory rows already share an identity, preferBoothRow picks one
 * and the losers are listed so the migration can delete them.
 */
function _boothCanonIndex(rows) {
	const byKey = new Map() // key → { keep, losers: [] }
	for (const r of rows) {
		const k = stallLocation.supplierIdentityKey(r.shop_name, r.stall)
		if (!k || k === '\x00') continue
		const g = byKey.get(k)
		if (!g) {
			byKey.set(k, { keep: r, losers: [] })
			continue
		}
		const winner = preferBoothRow(g.keep, r)
		if (winner.shop_name === g.keep.shop_name && winner.stall === g.keep.stall) {
			g.losers.push(r)
		} else {
			g.losers.push(g.keep)
			g.keep = r
		}
	}
	return byKey
}

/**
 * Rewrite every stored (shop, stall) pair that matches a directory identity
 * onto that identity's canonical spelling. Idempotent.
 */
function _canonizeBoothPairTable(db, sqlSelect, sqlUpdate, canonByKey) {
	let changed = 0
	const rows = db.prepare(sqlSelect).all()
	const upd = db.prepare(sqlUpdate)
	for (const r of rows) {
		const shop = String(r.shop || '').trim()
		const stall = String(r.stall || '').trim()
		if (!shop && !stall) continue
		const k = stallLocation.supplierIdentityKey(shop, stall)
		const hit = canonByKey.get(k)
		if (!hit) continue
		const keep = hit.keep
		if (shop === keep.shop_name && stall === keep.stall) continue
		upd.run(keep.shop_name, keep.stall, r.rowid)
		changed++
	}
	return changed
}

/**
 * Collapse case-variant twins already sitting in supplier_directory, then
 * rewrite product_map / product_assignments / route_assignments / model_fix
 * onto the spelling we kept. Safe to run on every boot — no-op when clean.
 * @returns {{removed:number, rewritten:number}}
 */
function migrateSupplierBoothIdentityDuplicates(db) {
	let removed = 0
	let rewritten = 0
	try {
		const rows = getSupplierDirectory(db)
		if (!rows.length) return { removed: 0, rewritten: 0 }
		const byKey = _boothCanonIndex(rows)
		const del = db.prepare('DELETE FROM supplier_directory WHERE shop_name = ? AND stall = ?')
		const tx = db.transaction(() => {
			for (const g of byKey.values()) {
				for (const loser of g.losers) {
					del.run(loser.shop_name, loser.stall)
					removed++
				}
			}
		})
		tx()
		rewritten = canonizeSupplierBoothReferences(db)
		if (removed) renumberSupplierDirectory(db)
	} catch (e) {
		console.warn('[db] supplier booth-identity heal skipped:', e.message)
	}
	if (removed || rewritten) {
		console.log(`[db] Supplier booth identity: removed ${removed} case-twin(s), rewrote ${rewritten} reference(s).`)
	}
	return { removed, rewritten }
}

/**
 * Point every known supplier shop+stall column at the directory's canonical
 * spelling for that booth. Returns how many rows were rewritten.
 */
function canonizeSupplierBoothReferences(db) {
	const byKey = _boothCanonIndex(getSupplierDirectory(db))
	if (!byKey.size) return 0
	let n = 0
	const tx = db.transaction(() => {
		// product_map — authoritative title → supplier map
		try {
			n += _canonizeBoothPairTable(
				db,
				`SELECT rowid AS rowid, shop_name AS shop, stall AS stall FROM product_map
         WHERE COALESCE(shop_name,'') <> '' OR COALESCE(stall,'') <> ''`,
				`UPDATE product_map SET shop_name = ?, stall = ? WHERE rowid = ?`,
				byKey,
			)
		} catch {
			/* table may be mid-migrate */
		}
		// product_assignments — remembered defaults per product
		try {
			n += _canonizeBoothPairTable(
				db,
				`SELECT rowid AS rowid, supplier_shop AS shop, supplier_stall AS stall FROM product_assignments
         WHERE COALESCE(supplier_shop,'') <> '' OR COALESCE(supplier_stall,'') <> ''`,
				`UPDATE product_assignments SET supplier_shop = ?, supplier_stall = ? WHERE rowid = ?`,
				byKey,
			)
		} catch {
			/* */
		}
		// route_assignments — per-line overrides the picker writes
		try {
			n += _canonizeBoothPairTable(
				db,
				`SELECT rowid AS rowid, supplier_shop_override AS shop, supplier_stall_override AS stall FROM route_assignments
         WHERE COALESCE(supplier_shop_override,'') <> '' OR COALESCE(supplier_stall_override,'') <> ''`,
				`UPDATE route_assignments SET supplier_shop_override = ?, supplier_stall_override = ? WHERE rowid = ?`,
				byKey,
			)
		} catch {
			/* */
		}
		// order_exchanges — where to carry a model swap
		try {
			n += _canonizeBoothPairTable(
				db,
				`SELECT rowid AS rowid, supplier_shop AS shop, supplier_stall AS stall FROM order_exchanges
         WHERE COALESCE(supplier_shop,'') <> '' OR COALESCE(supplier_stall,'') <> ''`,
				`UPDATE order_exchanges SET supplier_shop = ?, supplier_stall = ? WHERE rowid = ?`,
				byKey,
			)
		} catch {
			/* */
		}
	})
	tx()
	return n
}

/**
 * Same heal for charm_shop_directory — case twins there would break the
 * Assign Charm "Manage shops" list the same way.
 */
function migrateCharmShopBoothIdentityDuplicates(db) {
	let removed = 0
	let rewritten = 0
	try {
		const rows = getCharmShopDirectory(db)
		if (!rows.length) return { removed: 0, rewritten: 0 }
		const byKey = _boothCanonIndex(rows)
		const del = db.prepare('DELETE FROM charm_shop_directory WHERE shop_name = ? AND stall = ?')
		const tx = db.transaction(() => {
			for (const g of byKey.values()) {
				for (const loser of g.losers) {
					del.run(loser.shop_name, loser.stall)
					removed++
				}
			}
		})
		tx()
		rewritten = canonizeCharmShopBoothReferences(db)
		if (removed) renumberCharmShopDirectory(db)
	} catch (e) {
		console.warn('[db] charm-shop booth-identity heal skipped:', e.message)
	}
	if (removed || rewritten) {
		console.log(`[db] Charm-shop booth identity: removed ${removed} case-twin(s), rewrote ${rewritten} reference(s).`)
	}
	return { removed, rewritten }
}

function canonizeCharmShopBoothReferences(db) {
	const byKey = _boothCanonIndex(getCharmShopDirectory(db))
	if (!byKey.size) return 0

	// Charm references elsewhere are usually shop-name only (stall lives on the
	// directory). Fold shop spelling case-insensitively onto the directory form.
	const shopCanon = new Map() // lower(shop) → canonical shop_name
	for (const g of byKey.values()) {
		const ks = String(g.keep.shop_name || '').trim()
		if (!ks) continue
		const low = ks.toLowerCase()
		if (!shopCanon.has(low)) shopCanon.set(low, ks)
	}

	let n = 0
	const rewriteShopCol = (selectSql, updateSql) => {
		try {
			const rows = db.prepare(selectSql).all()
			const upd = db.prepare(updateSql)
			for (const r of rows) {
				const shop = String(r.shop || '').trim()
				if (!shop) continue
				const keep = shopCanon.get(shop.toLowerCase())
				if (!keep || keep === shop) continue
				upd.run(keep, r.rowid)
				n++
			}
		} catch {
			/* table may be absent mid-migrate */
		}
	}

	const tx = db.transaction(() => {
		rewriteShopCol(`SELECT rowid AS rowid, charm_shop AS shop FROM product_map WHERE COALESCE(charm_shop,'') <> ''`, `UPDATE product_map SET charm_shop = ? WHERE rowid = ?`)
		rewriteShopCol(`SELECT rowid AS rowid, charm_shop AS shop FROM product_assignments WHERE COALESCE(charm_shop,'') <> ''`, `UPDATE product_assignments SET charm_shop = ? WHERE rowid = ?`)
		rewriteShopCol(`SELECT rowid AS rowid, default_charm_shop AS shop FROM charm_library WHERE COALESCE(default_charm_shop,'') <> ''`, `UPDATE charm_library SET default_charm_shop = ? WHERE rowid = ?`)
	})
	tx()
	return n
}

/**
 * Replace the entire supplier_directory in one transaction.
 * Rows that only differ by letter case / NFKC / dash spelling of the same
 * booth collapse to one — Excel and hand edits have historically produced
 * twins like `汇通A146` / `汇通a146`, which then painted a greyed-out
 * "ext" card Manage could not delete.
 * @param {Database.Database} db
 * @param {Array<{shop_name,stall,mall,floor,address,notes}>} rows
 * @returns {number} number of rows written
 */
function replaceSupplierDirectory(db, rows) {
	const now = Math.floor(Date.now() / 1000)
	const ins = db.prepare(`
    INSERT INTO supplier_directory (shop_name, stall, mall, floor, address, notes, sort_order, updated_at)
    VALUES (@shop_name, @stall, @mall, @floor, @address, @notes, @sort_order, @updated_at)
    ON CONFLICT(shop_name, stall) DO UPDATE SET
      mall = excluded.mall, floor = excluded.floor,
      address = excluded.address, notes = excluded.notes,
      sort_order = excluded.sort_order,
      updated_at = excluded.updated_at
  `)
	const folded = foldBoothRowsByIdentity(rows)
	const tx = db.transaction((list) => {
		db.prepare('DELETE FROM supplier_directory').run()
		for (const r of list) {
			ins.run({
				shop_name: String(r.shop_name || '').trim(),
				stall: String(r.stall || '').trim(),
				mall: String(r.mall || '').trim(),
				floor: String(r.floor || '').trim(),
				address: String(r.address || '').trim(),
				notes: String(r.notes || '').trim(),
				sort_order: typeof r.sort_order === 'number' ? r.sort_order : 9999,
				updated_at: now,
			})
		}
	})
	tx(folded)
	// After a full replace, rewrite any leftover assignments that still carry a
	// discarded spelling onto the row we kept.
	canonizeSupplierBoothReferences(db)
	return folded.length
}

/**
 * Replace the entire charm_shop_directory in one transaction.
 * Same identity fold as suppliers — a charm shop is also one booth.
 * @param {Database.Database} db
 * @param {Array<{shop_name,stall,notes}>} rows
 * @returns {number} number of rows written
 */
function replaceCharmShopDirectory(db, rows) {
	const now = Math.floor(Date.now() / 1000)
	const ins = db.prepare(`
    INSERT INTO charm_shop_directory (shop_name, stall, notes, sort_order, updated_at)
    VALUES (@shop_name, @stall, @notes, @sort_order, @updated_at)
    ON CONFLICT(shop_name, stall) DO UPDATE SET
      notes = excluded.notes, sort_order = excluded.sort_order, updated_at = excluded.updated_at
  `)
	const folded = foldBoothRowsByIdentity(rows)
	const tx = db.transaction((list) => {
		db.prepare('DELETE FROM charm_shop_directory').run()
		list.forEach((r, idx) => {
			ins.run({
				shop_name: String(r.shop_name || '').trim(),
				stall: String(r.stall || '').trim(),
				notes: String(r.notes || '').trim(),
				sort_order: typeof r.sort_order === 'number' ? r.sort_order : idx,
				updated_at: now,
			})
		})
	})
	tx(folded)
	canonizeCharmShopBoothReferences(db)
	return folded.length
}

/** Re-pack charm_shop_directory sort_order = 0..N-1 in current order. */
function renumberCharmShopDirectory(db) {
	const rows = db.prepare('SELECT shop_name, stall FROM charm_shop_directory ORDER BY sort_order ASC, rowid ASC').all()
	const upd = db.prepare('UPDATE charm_shop_directory SET sort_order = @so WHERE shop_name = @shop AND stall = @stall')
	const tx = db.transaction(() => {
		rows.forEach((r, i) => upd.run({ so: i, shop: r.shop_name, stall: r.stall }))
	})
	tx()
}

/**
 * Insert a new charm shop, appended at the end of the list, then renumber.
 * @throws {Error} with code 'REQUIRED' or 'DUPLICATE'
 */
function insertCharmShopDirectoryRow(db, r) {
	const shop = String(r.shop_name || '').trim()
	const stall = String(r.stall || '').trim()
	if (!shop) throw Object.assign(new Error('Shop name is required.'), { code: 'REQUIRED' })

	const want = stallLocation.supplierIdentityKey(shop, stall)
	const clash = getCharmShopDirectory(db).find((row) => stallLocation.supplierIdentityKey(row.shop_name, row.stall) === want)
	if (clash) {
		throw Object.assign(new Error('A charm shop with this name and stall already exists.'), { code: 'DUPLICATE' })
	}

	const maxRow = db.prepare('SELECT MAX(sort_order) AS m FROM charm_shop_directory').get()
	const nextSort = (maxRow && typeof maxRow.m === 'number' ? maxRow.m : -1) + 1

	db.prepare(
		`
    INSERT INTO charm_shop_directory (shop_name, stall, notes, sort_order, updated_at)
    VALUES (?, ?, ?, ?, strftime('%s','now'))
  `,
	).run(shop, stall, String(r.notes || '').trim(), nextSort)

	renumberCharmShopDirectory(db)
	return { shop_name: shop, stall }
}

/**
 * Update a charm shop. Because (shop_name, stall) is the composite PK, a change
 * to either field is performed as delete-then-insert, preserving the original
 * list position. Unspecified fields fall back to the existing row's values.
 * @throws {Error} with code 'REQUIRED', 'NOT_FOUND', or 'DUPLICATE'
 */
function updateCharmShopDirectoryRow(db, r) {
	const oShop = String(r.orig_shop_name || '').trim()
	const oStall = String(r.orig_stall || '').trim()
	const nShop = String(r.shop_name || '').trim()
	const nStall = String(r.stall || '').trim()
	if (!nShop) throw Object.assign(new Error('Shop name is required.'), { code: 'REQUIRED' })

	const cur = db.prepare('SELECT * FROM charm_shop_directory WHERE shop_name = ? AND stall = ?').get(oShop, oStall)
	if (!cur) throw Object.assign(new Error('Charm shop not found.'), { code: 'NOT_FOUND' })

	if (nShop !== oShop || nStall !== oStall) {
		const want = stallLocation.supplierIdentityKey(nShop, nStall)
		const clash = getCharmShopDirectory(db).find((row) => {
			if (row.shop_name === oShop && row.stall === oStall) return false
			return stallLocation.supplierIdentityKey(row.shop_name, row.stall) === want
		})
		if (clash) {
			throw Object.assign(new Error('Another charm shop already uses this name and stall.'), { code: 'DUPLICATE' })
		}
	}

	const keepSort = cur.sort_order
	const tx = db.transaction(() => {
		db.prepare('DELETE FROM charm_shop_directory WHERE shop_name = ? AND stall = ?').run(oShop, oStall)
		db.prepare(
			`
      INSERT INTO charm_shop_directory (shop_name, stall, notes, sort_order, updated_at)
      VALUES (?, ?, ?, ?, strftime('%s','now'))
    `,
		).run(nShop, nStall, String(r.notes != null ? r.notes : cur.notes || '').trim(), keepSort)
	})
	tx()

	renumberCharmShopDirectory(db)
	return { shop_name: nShop, stall: nStall }
}

/** Delete a charm shop by its composite key, then renumber. Returns rows removed. */
function deleteCharmShopDirectoryRow(db, { shop_name, stall }) {
	const shop = String(shop_name || '').trim()
	const st = String(stall || '').trim()
	const info = db.prepare('DELETE FROM charm_shop_directory WHERE shop_name = ? AND stall = ?').run(shop, st)
	renumberCharmShopDirectory(db)
	return info.changes
}

// ── charm_library (the physical charms) ─────────────────────────────────────

/** Return the charm library in sort_order. */
function getCharmLibrary(db) {
	try {
		return db.prepare('SELECT * FROM charm_library ORDER BY sort_order ASC, code ASC').all()
	} catch {
		return []
	}
}

/** Look up a single charm by code. */
function getCharmByCode(db, code) {
	try {
		return db.prepare('SELECT * FROM charm_library WHERE code = ?').get(String(code || '').trim())
	} catch {
		return undefined
	}
}

/** Replace the entire charm library in one transaction (seed / re-sync). */
function replaceCharmLibrary(db, rows) {
	const now = Math.floor(Date.now() / 1000)
	const ins = db.prepare(`
    INSERT INTO charm_library (code, default_charm_shop, notes, image_file, sort_order, updated_at)
    VALUES (@code, @default_charm_shop, @notes, @image_file, @sort_order, @updated_at)
    ON CONFLICT(code) DO UPDATE SET
      default_charm_shop = excluded.default_charm_shop,
      notes = excluded.notes, image_file = excluded.image_file,
      sort_order = excluded.sort_order, updated_at = excluded.updated_at
  `)
	const tx = db.transaction((list) => {
		db.prepare('DELETE FROM charm_library').run()
		list.forEach((r, idx) => {
			ins.run({
				code: String(r.code || '').trim(),
				default_charm_shop: String(r.default_charm_shop || '').trim(),
				notes: String(r.notes || '').trim(),
				image_file: String(r.image_file || '').trim(),
				sort_order: typeof r.sort_order === 'number' ? r.sort_order : idx,
				updated_at: now,
			})
		})
	})
	const valid = rows.filter((r) => String(r.code || '').trim())
	tx(valid)
	return valid.length
}

/** Re-pack charm_library sort_order = 0..N-1 in current order. */
function renumberCharmLibrary(db) {
	const rows = db.prepare('SELECT code FROM charm_library ORDER BY sort_order ASC, code ASC').all()
	const upd = db.prepare('UPDATE charm_library SET sort_order = @so WHERE code = @code')
	const tx = db.transaction(() => {
		rows.forEach((r, i) => upd.run({ so: i, code: r.code }))
	})
	tx()
}

/**
 * Insert a new charm, appended at the end, then renumber.
 * @throws {Error} with code 'REQUIRED' or 'DUPLICATE'
 */
function insertCharmLibraryRow(db, r) {
	const code = String(r.code || '').trim()
	if (!code) throw Object.assign(new Error('Charm code is required.'), { code: 'REQUIRED' })
	if (getCharmByCode(db, code)) {
		throw Object.assign(new Error(`Charm code "${code}" already exists.`), { code: 'DUPLICATE' })
	}
	const maxRow = db.prepare('SELECT MAX(sort_order) AS m FROM charm_library').get()
	const nextSort = (maxRow && typeof maxRow.m === 'number' ? maxRow.m : -1) + 1
	db.prepare(
		`
    INSERT INTO charm_library (code, default_charm_shop, notes, image_file, sort_order, updated_at)
    VALUES (?, ?, ?, ?, ?, strftime('%s','now'))
  `,
	).run(code, String(r.default_charm_shop || '').trim(), String(r.notes || '').trim(), String(r.image_file || '').trim(), nextSort)
	renumberCharmLibrary(db)
	return { code }
}

/**
 * Update a charm. Supports renaming the code (the PK) by delete-then-insert,
 * preserving the original list position. Unspecified fields fall back to the
 * existing row's values.
 * @throws {Error} with code 'REQUIRED', 'NOT_FOUND', or 'DUPLICATE'
 */
function updateCharmLibraryRow(db, r) {
	const oCode = String(r.orig_code || '').trim()
	const nCode = String(r.code || '').trim()
	if (!nCode) throw Object.assign(new Error('Charm code is required.'), { code: 'REQUIRED' })

	const cur = getCharmByCode(db, oCode)
	if (!cur) throw Object.assign(new Error('Charm not found.'), { code: 'NOT_FOUND' })

	if (nCode !== oCode && getCharmByCode(db, nCode)) {
		throw Object.assign(new Error(`Charm code "${nCode}" already exists.`), { code: 'DUPLICATE' })
	}

	const keepSort = cur.sort_order
	const next = {
		code: nCode,
		default_charm_shop: r.default_charm_shop != null ? String(r.default_charm_shop).trim() : cur.default_charm_shop || '',
		notes: r.notes != null ? String(r.notes).trim() : cur.notes || '',
		image_file: r.image_file != null ? String(r.image_file).trim() : cur.image_file || '',
	}
	const tx = db.transaction(() => {
		db.prepare('DELETE FROM charm_library WHERE code = ?').run(oCode)
		db.prepare(
			`
      INSERT INTO charm_library (code, default_charm_shop, notes, image_file, sort_order, updated_at)
      VALUES (?, ?, ?, ?, ?, strftime('%s','now'))
    `,
		).run(next.code, next.default_charm_shop, next.notes, next.image_file, keepSort)
		// A deliberate code rename is the ONLY legitimate way a (normally stable)
		// charm code changes. Carry every existing reference over to the new code so
		// orders keep pointing at the same physical charm instead of being orphaned.
		if (nCode !== oCode) {
			const rn = { [oCode]: nCode }
			_remapCharmCodeColumn(db, 'route_assignments', rn)
			_remapCharmCodeColumn(db, 'product_assignments', rn)
			try {
				_remapCharmCodeColumn(db, 'product_map', rn)
			} catch {
				/* optional table */
			}
			// charm_purchase_progress is keyed by charm_code (PK) and tracks how many
			// physical pieces of this charm have been bought — a stock count that must
			// follow the charm across a rename, exactly like the assignment references
			// above. Clear any stale orphan row for the new code first so the two-phase
			// swap in _remapCharmCodeColumn can't hit a PK collision.
			try {
				db.prepare('DELETE FROM charm_purchase_progress WHERE charm_code = ?').run(nCode)
				_remapCharmCodeColumn(db, 'charm_purchase_progress', rn)
			} catch {
				/* table may not exist before first migration */
			}
		}
	})
	tx()
	renumberCharmLibrary(db)
	return next
}

/** Delete a charm by code, then renumber. Returns the deleted row (for image cleanup). */
function deleteCharmLibraryRow(db, code) {
	const c = String(code || '').trim()
	const row = getCharmByCode(db, c)
	db.prepare('DELETE FROM charm_library WHERE code = ?').run(c)
	renumberCharmLibrary(db)
	return row || null
}

/** Remap a charm_code column across a table using a two-phase (collision-safe) swap. */
function _remapCharmCodeColumn(db, table, renameMap) {
	const pairs = Object.entries(renameMap)
	if (!pairs.length) return
	const toTmp = db.prepare(`UPDATE ${table} SET charm_code = ? WHERE charm_code = ?`)
	// Phase 1: old → sentinel (avoids chained-rename collisions like 1→2, 2→3).
	for (const [oldC] of pairs) toTmp.run(`\x00reorder\x00${oldC}`, oldC)
	// Phase 2: sentinel → new.
	for (const [oldC, newC] of pairs) toTmp.run(newC, `\x00reorder\x00${oldC}`)
}

/**
 * Reorder the charm library to match `newOrder` (an array of the CURRENT codes
 * in the desired visual order) by updating ONLY each charm's `sort_order`.
 *
 * Charm CODES are STABLE, permanent identities. A charm keeps its code — and
 * therefore its image file and every `route_assignments` / `product_assignments`
 * / `product_map` reference — no matter where it is dragged. Reordering is a
 * pure DISPLAY concern, so it can NEVER change which physical charm an order is
 * assigned to, and never renames a file on disk.
 *
 * (Historically this renumbered codes by position — CH-00001, CH-00002, … — and
 * then had to remap every reference across three tables AND rename every image
 * on disk to keep the physical charm's identity intact. That multi-step rename
 * was fragile: any inconsistency between the code remap and the image rename
 * repointed an order at the WRONG physical charm and/or orphaned its image. A
 * charm code the operator assigned (e.g. CH-00065) must not silently mutate just
 * because the list was sorted. Decoupling identity from position deletes that
 * whole class of bugs.)
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} newOrder current codes in the desired order (full permutation)
 * @returns {{ reordered: number }}
 * @throws {Error} code 'REQUIRED' when newOrder isn't a full permutation.
 */
function reorderCharmLibrary(db, newOrder) {
	const rows = getCharmLibrary(db)
	const known = new Set(rows.map((r) => r.code))

	const seen = new Set()
	const finalOrder = []
	for (const raw of newOrder || []) {
		const c = String(raw || '').trim()
		if (known.has(c) && !seen.has(c)) {
			finalOrder.push(c)
			seen.add(c)
		}
	}
	if (finalOrder.length !== rows.length) {
		throw Object.assign(new Error('Reorder list must include every charm exactly once.'), { code: 'REQUIRED' })
	}

	const upd = db.prepare('UPDATE charm_library SET sort_order = @so WHERE code = @code')
	db.transaction(() => {
		finalOrder.forEach((code, i) => upd.run({ so: i, code }))
	})()

	return { reordered: finalOrder.length }
}

// ─── Charm purchase progress (purchased / in-stock quantity per charm) ────────

/**
 * Return all charm purchase-progress rows as a { charm_code: purchased_qty } map.
 * @param {import('better-sqlite3').Database} db
 * @returns {Record<string, number>}
 */
function getCharmPurchaseProgress(db) {
	const out = {}
	try {
		db.prepare('SELECT charm_code, purchased_qty FROM charm_purchase_progress')
			.all()
			.forEach((r) => {
				out[r.charm_code] = r.purchased_qty
			})
	} catch {
		/* table may not exist before first migration */
	}
	return out
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
	const code = String(charmCode || '').trim()
	if (!code) {
		const e = new Error('charm_code is required.')
		e.code = 'REQUIRED'
		throw e
	}
	const n = Math.max(0, Math.floor(Number(qty) || 0))
	db.prepare(
		`
    INSERT INTO charm_purchase_progress (charm_code, purchased_qty, updated_at)
    VALUES (@code, @qty, @now)
    ON CONFLICT(charm_code) DO UPDATE SET purchased_qty = excluded.purchased_qty, updated_at = excluded.updated_at
  `,
	).run({ code, qty: n, now: Math.floor(Date.now() / 1000) })
	return { charm_code: code, purchased_qty: n }
}

/** Return the supplier directory in Excel row order. */
function getSupplierDirectory(db) {
	try {
		return db.prepare('SELECT * FROM supplier_directory ORDER BY sort_order ASC').all()
	} catch {
		return []
	}
}

/**
 * Compare two supplier rows in walking order — market, then floor, then stall,
 * then shop name — using the shared stall parser, so the directory lists in the
 * same sequence the Route tab and Shopping Mode send a shopper round in.
 * Raw `<`/`>` (not localeCompare) keeps the code-point ordering Python uses.
 */
function _cmpSupplier(a, b) {
	const ka = stallLocation.locationSortKey(a.stall, a.shop_name)
	const kb = stallLocation.locationSortKey(b.stall, b.shop_name)
	return ka < kb ? -1 : ka > kb ? 1 : 0
}

/** Re-sort the whole directory by the OSP key and rewrite sort_order = 0..N-1. */
function renumberSupplierDirectory(db) {
	const rows = db.prepare('SELECT shop_name, stall FROM supplier_directory').all()
	rows.sort(_cmpSupplier)
	const upd = db.prepare('UPDATE supplier_directory SET sort_order = @so WHERE shop_name = @shop AND stall = @stall')
	const tx = db.transaction(() => {
		rows.forEach((r, i) => upd.run({ so: i, shop: r.shop_name, stall: r.stall }))
	})
	tx()
}

/**
 * Insert a single new supplier into the directory, then renumber.
 * @throws {Error} with code 'REQUIRED' or 'DUPLICATE'
 */
function insertSupplierDirectoryRow(db, r) {
	const shop = String(r.shop_name || '').trim()
	const stall = String(r.stall || '').trim()
	if (!shop) throw Object.assign(new Error('Shop name is required.'), { code: 'REQUIRED' })

	// Case / NFKC / dash folding — `汇通A146` and `汇通a146` are one booth.
	const want = stallLocation.supplierIdentityKey(shop, stall)
	const clash = getSupplierDirectory(db).find((row) => stallLocation.supplierIdentityKey(row.shop_name, row.stall) === want)
	if (clash) {
		throw Object.assign(new Error('A supplier with this shop name and stall already exists.'), { code: 'DUPLICATE' })
	}

	db.prepare(
		`
    INSERT INTO supplier_directory (shop_name, stall, mall, floor, address, notes, sort_order, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 9999, strftime('%s','now'))
  `,
	).run(shop, stall, String(r.mall || '').trim(), String(r.floor || '').trim(), String(r.address || '').trim(), String(r.notes || '').trim())

	renumberSupplierDirectory(db)
	return { shop_name: shop, stall }
}

/**
 * Rewrite one supplier booth identity everywhere it is referenced.
 *
 * Supplier names and stalls are denormalised snapshots by design, so changing
 * the directory's composite key has to be an atomic fan-out. Shop-only rows are
 * included when the old shop had a single booth. They are materialised onto the
 * new stall because Route resolution does not consult supplier_directory after
 * a product-level default has won.
 */
function _rewriteSupplierBoothReferences(db, from, to, includeShopOnly) {
	const oldShop = String(from.shop_name || '').trim()
	const oldStall = String(from.stall || '').trim()
	const newShop = String(to.shop_name || '').trim()
	const newStall = String(to.stall || '').trim()
	const oldKey = stallLocation.supplierIdentityKey(oldShop, oldStall)
	const oldShopKey = String(oldShop).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
	let changed = 0

	const specs = [
		['product_map', 'shop_name', 'stall'],
		['product_assignments', 'supplier_shop', 'supplier_stall'],
		['route_assignments', 'supplier_shop_override', 'supplier_stall_override'],
		['order_exchanges', 'supplier_shop', 'supplier_stall'],
	]
	for (const [table, shopCol, stallCol] of specs) {
		const rows = db.prepare(`SELECT rowid AS rowid, ${shopCol} AS shop, ${stallCol} AS stall FROM ${table}`).all()
		const update = db.prepare(`UPDATE ${table} SET ${shopCol} = ?, ${stallCol} = ? WHERE rowid = ?`)
		for (const row of rows) {
			const rowShop = String(row.shop || '').trim()
			const rowStall = String(row.stall || '').trim()
			const exact = stallLocation.supplierIdentityKey(rowShop, rowStall) === oldKey
			const shopOnly =
				includeShopOnly &&
				!rowStall &&
				String(rowShop).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase() === oldShopKey
			if (!exact && !shopOnly) continue
			update.run(newShop, newStall, row.rowid)
			changed++
		}
	}
	return changed
}

/** Active products whose supplier resolves to one directory booth. */
function _productsAtSupplierBooth(db, shop, stall, includeShopOnly) {
	const boothKey = stallLocation.supplierIdentityKey(shop, stall)
	const shopKey = String(shop || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
	return db
		.prepare("SELECT id, title, title_norm, canonical_product_key, shop_name, stall FROM product_map WHERE status = 'active'")
		.all()
		.filter((row) => {
			const rowShop = String(row.shop_name || '').trim()
			const rowStall = String(row.stall || '').trim()
			if (stallLocation.supplierIdentityKey(rowShop, rowStall) === boothKey) return true
			return (
				includeShopOnly &&
				!rowStall &&
				String(rowShop).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase() === shopKey
			)
		})
}

/** Saved product defaults that still point at one supplier booth. */
function _productAssignmentsAtSupplierBooth(db, shop, stall, includeShopOnly) {
	const boothKey = stallLocation.supplierIdentityKey(shop, stall)
	const shopKey = String(shop || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
	return db
		.prepare(
			`SELECT item_key, title, supplier_shop AS shop_name, supplier_stall AS stall
			 FROM product_assignments
			 WHERE COALESCE(supplier_shop, '') <> '' OR COALESCE(supplier_stall, '') <> ''`,
		)
		.all()
		.filter((row) => {
			const rowShop = String(row.shop_name || '').trim()
			const rowStall = String(row.stall || '').trim()
			if (stallLocation.supplierIdentityKey(rowShop, rowStall) === boothKey) return true
			return (
				includeShopOnly &&
				!rowStall &&
				String(rowShop).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase() === shopKey
			)
		})
}

/** Per-order supplier overrides that still point at one supplier booth. */
function _routeOverridesAtSupplierBooth(db, shop, stall, includeShopOnly) {
	const boothKey = stallLocation.supplierIdentityKey(shop, stall)
	const shopKey = String(shop || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
	return db
		.prepare(
			`SELECT rowid, receipt_id, item_key, title,
			        supplier_shop_override AS shop_name,
			        supplier_stall_override AS stall
			 FROM route_assignments
			 WHERE COALESCE(supplier_shop_override, '') <> ''
			    OR COALESCE(supplier_stall_override, '') <> ''`,
		)
		.all()
		.filter((row) => {
			const rowShop = String(row.shop_name || '').trim()
			const rowStall = String(row.stall || '').trim()
			if (stallLocation.supplierIdentityKey(rowShop, rowStall) === boothKey) return true
			return (
				includeShopOnly &&
				!rowStall &&
				String(rowShop).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase() === shopKey
			)
		})
}

/**
 * Record that a title with no product_map row was intentionally discontinued.
 * This tombstone is what prevents Route from rediscovering the deleted booth
 * through the lower-priority legacy OSP catalog.
 */
function _ensureRetiredProductTombstone(db, { title, shop, stall, reason, by, now }) {
	const cleanTitle = String(title || '').trim()
	const titleNorm = _normTitleForKey(cleanTitle)
	if (!titleNorm) return false
	const existing = db
		.prepare('SELECT id, status, shop_name, stall FROM product_map WHERE title_norm = ?')
		.get(titleNorm)
	if (existing) {
		// A blank active mapping would otherwise invite the legacy OSP matcher to
		// repopulate the supplier being deleted. Retire it as the explicit
		// fallback-suppression record. A mapping to another real booth remains.
		if (
			existing.status === 'active' &&
			!String(existing.shop_name || '').trim() &&
			!String(existing.stall || '').trim()
		) {
			db.prepare(
				`UPDATE product_map
				 SET shop_name = ?, stall = ?, status = 'retired', retired_at = ?,
				     retired_reason = ?, retired_by = ?, updated_at = ?
				 WHERE id = ?`,
			).run(String(shop || '').trim(), String(stall || '').trim(), now, reason, by, now, existing.id)
			return true
		}
		return false
	}
	const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM product_map').get().m
	db.prepare(
		`INSERT INTO product_map
			(title_norm, title, shop_name, stall, status, retired_at,
			 retired_reason, retired_by, sort_order, updated_at)
		 VALUES (?, ?, ?, ?, 'retired', ?, ?, ?, ?, ?)`,
	).run(titleNorm, cleanTitle, String(shop || '').trim(), String(stall || '').trim(), now, reason, by, maxOrder + 1, now)
	return true
}

/**
 * Update a supplier. Because (shop_name, stall) is the composite PK, a change
 * to either field is performed as delete-then-insert inside one transaction.
 * Unspecified fields fall back to the existing row's values.
 * @throws {Error} with code 'REQUIRED', 'NOT_FOUND', or 'DUPLICATE'
 */
function updateSupplierDirectoryRow(db, r) {
	const oShop = String(r.orig_shop_name || '').trim()
	const oStall = String(r.orig_stall || '').trim()
	const nShop = String(r.shop_name || '').trim()
	const nStall = String(r.stall || '').trim()
	if (!nShop) throw Object.assign(new Error('Shop name is required.'), { code: 'REQUIRED' })

	const cur = db.prepare('SELECT * FROM supplier_directory WHERE shop_name = ? AND stall = ?').get(oShop, oStall)
	if (!cur) throw Object.assign(new Error('Supplier not found.'), { code: 'NOT_FOUND' })

	const shopBooths = getSupplierDirectory(db).filter(
		(row) =>
			String(row.shop_name || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase() ===
			String(oShop).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase(),
	)
	if (nShop !== oShop || nStall !== oStall) {
		const want = stallLocation.supplierIdentityKey(nShop, nStall)
		const clash = getSupplierDirectory(db).find((row) => {
			if (row.shop_name === oShop && row.stall === oStall) return false
			return stallLocation.supplierIdentityKey(row.shop_name, row.stall) === want
		})
		if (clash) {
			throw Object.assign(new Error('Another supplier already uses this shop name and stall.'), { code: 'DUPLICATE' })
		}
	}

	const tx = db.transaction(() => {
		db.prepare('DELETE FROM supplier_directory WHERE shop_name = ? AND stall = ?').run(oShop, oStall)
		db.prepare(
			`
      INSERT INTO supplier_directory (shop_name, stall, mall, floor, address, notes, sort_order, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 9999, strftime('%s','now'))
    `,
		).run(nShop, nStall, String(r.mall != null ? r.mall : cur.mall || '').trim(), String(r.floor != null ? r.floor : cur.floor || '').trim(), String(r.address != null ? r.address : cur.address || '').trim(), String(r.notes != null ? r.notes : cur.notes || '').trim())
		if (nShop !== oShop || nStall !== oStall) {
			_rewriteSupplierBoothReferences(
				db,
				{ shop_name: oShop, stall: oStall },
				{ shop_name: nShop, stall: nStall },
				shopBooths.length === 1,
			)
		}
	})
	tx()

	renumberSupplierDirectory(db)
	return { shop_name: nShop, stall: nStall }
}

/**
 * Delete a supplier by composite key.
 *
 * A booth with active catalog products is protected by default. Callers that
 * explicitly confirm `retire_products` retire those product mappings in the
 * same transaction, making them disappear from every active picker without
 * erasing completed-order history.
 */
function deleteSupplierDirectoryRow(db, { shop_name, stall, retire_products = false, retired_reason = '', retired_by = '' }) {
	const shop = String(shop_name || '').trim()
	const st = String(stall || '').trim()
	const supplier = db.prepare('SELECT * FROM supplier_directory WHERE shop_name = ? AND stall = ?').get(shop, st)
	if (!supplier) return { removed: 0, retired_products: 0, retired_rows: [] }

	const sameShop = getSupplierDirectory(db).filter(
		(row) =>
			String(row.shop_name || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase() ===
			String(shop).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase(),
	)
	const products = _productsAtSupplierBooth(db, shop, st, sameShop.length === 1)
	const savedDefaults = _productAssignmentsAtSupplierBooth(db, shop, st, sameShop.length === 1)
	const routeOverrides = _routeOverridesAtSupplierBooth(db, shop, st, sameShop.length === 1)
	const activeReferences = new Set([
		...products.map((row) => `product:${row.id}`),
		...savedDefaults.map((row) => `assignment:${row.item_key}`),
		...routeOverrides.map((row) => `route:${row.receipt_id}:${row.item_key}`),
	]).size
	if (activeReferences && !retire_products) {
		throw Object.assign(
			new Error(
				`${activeReferences} active product reference${activeReferences === 1 ? '' : 's'} still use this supplier. Reassign them first, or confirm that they should all be discontinued.`,
			),
			{ code: 'IN_USE', product_count: activeReferences },
		)
	}

	const now = Math.floor(Date.now() / 1000)
	const reason = String(retired_reason || `Supplier removed: ${shop}${st ? ` · ${st}` : ''}`).trim().slice(0, 500)
	const by = String(retired_by || '').trim().slice(0, 120)
	let assignmentsRemoved = 0
	let routeOverridesCleared = 0
	let tombstonesCreated = 0
	const tx = db.transaction(() => {
		if (products.length) {
			const retire = db.prepare(
				"UPDATE product_map SET status = 'retired', retired_at = ?, retired_reason = ?, retired_by = ?, updated_at = ? WHERE id = ? AND status = 'active'",
			)
			for (const row of products) {
				retire.run(now, reason, by, now, row.id)
				assignmentsRemoved += _deleteProductAssignmentsForTitle(db, row.title)
			}
		}
		for (const row of [...savedDefaults, ...routeOverrides]) {
			tombstonesCreated += Number(
				_ensureRetiredProductTombstone(db, {
					title: row.title,
					shop,
					stall: st,
					reason,
					by,
					now,
				}),
			)
		}
		const deleteAssignment = db.prepare('DELETE FROM product_assignments WHERE item_key = ?')
		for (const row of savedDefaults) assignmentsRemoved += deleteAssignment.run(row.item_key).changes
		const clearRouteOverride = db.prepare(
			`UPDATE route_assignments
			 SET supplier_shop_override = '', supplier_stall_override = '', updated_at = ?
			 WHERE rowid = ?`,
		)
		for (const row of routeOverrides) routeOverridesCleared += clearRouteOverride.run(now, row.rowid).changes
		db.prepare('DELETE FROM supplier_directory WHERE shop_name = ? AND stall = ?').run(shop, st)
	})
	tx()
	renumberSupplierDirectory(db)
	return {
		removed: 1,
		retired_products: products.length,
		retired_rows: products.map((row) => ({ id: row.id, title: row.title })),
		assignments_removed: assignmentsRemoved,
		route_overrides_cleared: routeOverridesCleared,
		tombstones_created: tombstonesCreated,
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// SOURCING LIBRARY — design-supplier registry + uploaded-zip index.
//
// These accessors follow the same contract as the rest of this module: they take
// `db` as the first arg, throw Error objects tagged with a `.code`
// ('REQUIRED' | 'DUPLICATE' | 'NOT_FOUND') that the HTTP layer maps to a status,
// and never touch the filesystem (the route layer owns the on-disk zip store and
// deletes files alongside the rows these functions remove).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List sourcing suppliers (newest-updated first within sort_order), each with a
 * live package count per category so the UI can render the sidebar in one query.
 */
function getSourcingSuppliers(db) {
	const rows = db.prepare('SELECT * FROM sourcing_suppliers ORDER BY sort_order ASC, name COLLATE NOCASE ASC').all()
	// Aggregate package counts by (supplier, category) in a single pass.
	const counts = db.prepare('SELECT supplier_id, category, COUNT(*) AS n FROM sourcing_packages GROUP BY supplier_id, category').all()
	const byId = new Map()
	for (const c of counts) {
		if (!byId.has(c.supplier_id)) byId.set(c.supplier_id, { total: 0, by_category: {} })
		const e = byId.get(c.supplier_id)
		e.total += c.n
		e.by_category[c.category] = c.n
	}
	return rows.map((r) => ({
		...r,
		package_count: byId.get(r.id) ? byId.get(r.id).total : 0,
		package_counts: byId.get(r.id) ? byId.get(r.id).by_category : {},
	}))
}

/** Fetch a single sourcing supplier by id, or null. */
function getSourcingSupplierById(db, id) {
	const n = parseInt(id, 10)
	if (!Number.isInteger(n)) return null
	return db.prepare('SELECT * FROM sourcing_suppliers WHERE id = ?').get(n) || null
}

/**
 * Create a sourcing supplier.
 * @throws {Error} code 'REQUIRED' (blank name) or 'DUPLICATE' (name taken)
 * @returns the inserted row
 */
function insertSourcingSupplier(db, r) {
	const name = String(r.name || '').trim()
	if (!name) throw Object.assign(new Error('Supplier name is required.'), { code: 'REQUIRED' })
	const clash = db.prepare('SELECT 1 FROM sourcing_suppliers WHERE name = ? COLLATE NOCASE').get(name)
	if (clash) throw Object.assign(new Error('A supplier with this name already exists.'), { code: 'DUPLICATE' })
	const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM sourcing_suppliers').get().m
	const now = Math.floor(Date.now() / 1000)
	const info = db
		.prepare(
			`
    INSERT INTO sourcing_suppliers (name, location, wechat, qq, notes, sort_order, created_at, updated_at)
    VALUES (@name, @location, @wechat, @qq, @notes, @sort, @now, @now)
  `,
		)
		.run({
			name,
			location: String(r.location || '').trim(),
			wechat: String(r.wechat || '').trim(),
			qq: String(r.qq || '').trim(),
			notes: String(r.notes || '').trim(),
			sort: maxSort + 1,
			now,
		})
	return getSourcingSupplierById(db, info.lastInsertRowid)
}

/**
 * Update a sourcing supplier. Unspecified fields keep their current value.
 * @throws {Error} code 'NOT_FOUND', 'REQUIRED', or 'DUPLICATE'
 */
function updateSourcingSupplier(db, id, r) {
	const cur = getSourcingSupplierById(db, id)
	if (!cur) throw Object.assign(new Error('Supplier not found.'), { code: 'NOT_FOUND' })
	const name = r.name != null ? String(r.name).trim() : cur.name
	if (!name) throw Object.assign(new Error('Supplier name is required.'), { code: 'REQUIRED' })
	if (name.toLowerCase() !== String(cur.name).toLowerCase()) {
		const clash = db.prepare('SELECT 1 FROM sourcing_suppliers WHERE name = ? COLLATE NOCASE AND id <> ?').get(name, cur.id)
		if (clash) throw Object.assign(new Error('A supplier with this name already exists.'), { code: 'DUPLICATE' })
	}
	db.prepare(
		`
    UPDATE sourcing_suppliers
       SET name = @name, location = @location, wechat = @wechat, qq = @qq, notes = @notes,
           updated_at = @now
     WHERE id = @id
  `,
	).run({
		id: cur.id,
		name,
		location: r.location != null ? String(r.location).trim() : cur.location,
		wechat: r.wechat != null ? String(r.wechat).trim() : cur.wechat,
		qq: r.qq != null ? String(r.qq).trim() : cur.qq,
		notes: r.notes != null ? String(r.notes).trim() : cur.notes,
		now: Math.floor(Date.now() / 1000),
	})
	return getSourcingSupplierById(db, cur.id)
}

/**
 * Delete a sourcing supplier and (via ON DELETE CASCADE) all its package rows.
 * Returns the list of package rows removed so the caller can delete their files
 * from disk. Runs in a transaction so the DB is never left half-deleted.
 * @throws {Error} code 'NOT_FOUND'
 */
function deleteSourcingSupplier(db, id) {
	const cur = getSourcingSupplierById(db, id)
	if (!cur) throw Object.assign(new Error('Supplier not found.'), { code: 'NOT_FOUND' })
	const pkgs = db.prepare('SELECT * FROM sourcing_packages WHERE supplier_id = ?').all(cur.id)
	const tx = db.transaction(() => {
		// Explicit child delete first: ON DELETE CASCADE requires foreign_keys=ON,
		// which we set, but deleting explicitly keeps the intent obvious + portable.
		db.prepare('DELETE FROM sourcing_packages WHERE supplier_id = ?').run(cur.id)
		db.prepare('DELETE FROM sourcing_suppliers WHERE id = ?').run(cur.id)
	})
	tx()
	return { supplier: cur, packages: pkgs }
}

/**
 * List packages, optionally filtered by supplier, category and a free-text query
 * (matched against title + original filename + notes). Newest first.
 * @param {{ supplier_id?, category?, q? }} [opts]
 */
function getSourcingPackages(db, opts = {}) {
	const where = []
	const params = {}
	if (opts.supplier_id != null && opts.supplier_id !== '') {
		where.push('supplier_id = @supplier_id')
		params.supplier_id = parseInt(opts.supplier_id, 10)
	}
	if (opts.category) {
		where.push('category = @category')
		params.category = String(opts.category)
	}
	const q = String(opts.q || '').trim()
	if (q) {
		where.push('(title LIKE @q OR original_filename LIKE @q OR notes LIKE @q)')
		params.q = `%${q}%`
	}
	const sql = 'SELECT * FROM sourcing_packages' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY created_at DESC, id DESC'
	return db.prepare(sql).all(params)
}

/** Fetch a single package row by id, or null. */
function getSourcingPackageById(db, id) {
	const n = parseInt(id, 10)
	if (!Number.isInteger(n)) return null
	return db.prepare('SELECT * FROM sourcing_packages WHERE id = ?').get(n) || null
}

/**
 * Insert a package index row after its bytes are safely on disk. Validation of
 * the category / supplier existence happens in the route layer (which also owns
 * the file); this just records the metadata.
 * @returns the inserted row
 */
function insertSourcingPackage(db, r) {
	const now = Math.floor(Date.now() / 1000)
	const info = db
		.prepare(
			`
    INSERT INTO sourcing_packages
      (supplier_id, category, title, original_filename, stored_name, size_bytes, sha256, status, notes, uploaded_by, created_at, updated_at)
    VALUES
      (@supplier_id, @category, @title, @original_filename, @stored_name, @size_bytes, @sha256, @status, @notes, @uploaded_by, @now, @now)
  `,
		)
		.run({
			supplier_id: parseInt(r.supplier_id, 10),
			category: String(r.category),
			title: String(r.title || '').trim(),
			original_filename: String(r.original_filename || '').trim(),
			stored_name: String(r.stored_name),
			size_bytes: parseInt(r.size_bytes, 10) || 0,
			sha256: String(r.sha256 || ''),
			status: String(r.status || 'new'),
			notes: String(r.notes || '').trim(),
			uploaded_by: String(r.uploaded_by || '').trim(),
			now,
		})
	return getSourcingPackageById(db, info.lastInsertRowid)
}

/**
 * Update a package's editable metadata (title, category, status, notes). The
 * stored bytes / filename / hash are immutable once uploaded.
 * @throws {Error} code 'NOT_FOUND'
 */
function updateSourcingPackage(db, id, r) {
	const cur = getSourcingPackageById(db, id)
	if (!cur) throw Object.assign(new Error('Package not found.'), { code: 'NOT_FOUND' })
	db.prepare(
		`
    UPDATE sourcing_packages
       SET title = @title, category = @category, status = @status, notes = @notes, updated_at = @now
     WHERE id = @id
  `,
	).run({
		id: cur.id,
		title: r.title != null ? String(r.title).trim() : cur.title,
		category: r.category != null ? String(r.category) : cur.category,
		status: r.status != null ? String(r.status) : cur.status,
		notes: r.notes != null ? String(r.notes).trim() : cur.notes,
		now: Math.floor(Date.now() / 1000),
	})
	return getSourcingPackageById(db, cur.id)
}

/**
 * Delete a package row and return it (so the caller can remove its file).
 * @throws {Error} code 'NOT_FOUND'
 */
function deleteSourcingPackage(db, id) {
	const cur = getSourcingPackageById(db, id)
	if (!cur) throw Object.assign(new Error('Package not found.'), { code: 'NOT_FOUND' })
	db.prepare('DELETE FROM sourcing_packages WHERE id = ?').run(cur.id)
	return cur
}

/** Return the charm shop directory. */
function getCharmShopDirectory(db) {
	try {
		return db.prepare('SELECT * FROM charm_shop_directory ORDER BY sort_order ASC, rowid ASC').all()
	} catch {
		return []
	}
}

/**
 * Merge the "Product Map" sheet into the application-owned catalog.
 *
 * Excel is an import source, not a destructive mirror: in-app rows omitted from
 * the sheet survive, and retired tombstones are never silently reactivated by a
 * stale workbook. An explicit Product Catalog POST is the restore operation.
 *
 * @param {Database.Database} db
 * @param {Array<{title_norm,title,shop_name,stall,charm_shop,charm_code,sort_order}>} rows
 * @returns {number} number of rows written
 */
function replaceProductMap(db, rows) {
	const now = Math.floor(Date.now() / 1000)
	// Excel is authoritative for supplier/charm fields, but app-managed identity,
	// costs and the product-type override must survive a full-sheet re-import —
	// the sheet has no column for any of them, so an un-preserved value would be
	// silently erased the next time the operator pressed "re-import".
	const existingByNorm = new Map(
		db
			.prepare('SELECT title_norm, cost_case, cost_grip, canonical_product_key, product_type FROM product_map')
			.all()
			.map((r) => [r.title_norm, r]),
	)
	const ins = db.prepare(`
    INSERT INTO product_map (
      title_norm, title, shop_name, stall, charm_shop, charm_code,
      canonical_product_key, cost_case, cost_grip, product_type, sort_order, updated_at
    )
    VALUES (
      @title_norm, @title, @shop_name, @stall, @charm_shop, @charm_code,
      @canonical_product_key, @cost_case, @cost_grip, @product_type, @sort_order, @updated_at
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
      product_type = excluded.product_type,
      sort_order = excluded.sort_order,
      updated_at = excluded.updated_at
  `)
	const tx = db.transaction((list) => {
		for (const r of list) {
			const prior = existingByNorm.get(String(r.title_norm || '').trim()) || {}
			ins.run({
				title_norm: String(r.title_norm || '').trim(),
				title: String(r.title || '').trim(),
				shop_name: String(r.shop_name || '').trim(),
				stall: String(r.stall || '').trim(),
				charm_shop: String(r.charm_shop || '').trim(),
				charm_code: String(r.charm_code || '').trim(),
				canonical_product_key: String(r.canonical_product_key || prior.canonical_product_key || '').trim() || null,
				cost_case: r.cost_case == null ? (prior.cost_case ?? null) : r.cost_case,
				cost_grip: r.cost_grip == null ? (prior.cost_grip ?? null) : r.cost_grip,
				product_type: String(r.product_type || prior.product_type || '').trim() || null,
				sort_order: typeof r.sort_order === 'number' ? r.sort_order : 9999,
				updated_at: now,
			})
		}
	})
	const valid = rows.filter((r) => String(r.title_norm || '').trim())
	tx(valid)
	return valid.length
}

/**
 * Return the product map keyed by normalised title for O(1) lookup.
 * Omitting `titleNorms` preserves the historical full-map behaviour; an
 * explicitly empty scope returns an empty map without touching the table.
 *
 * @param {Database.Database} db
 * @param {Iterable<string>} [titleNorms]
 */
function getProductMapByNorm(db, titleNorms) {
	const map = new Map()
	const norms = _stringScope(titleNorms)
	const add = (r) => map.set(r.title_norm, r)
	if (norms === null) {
		db.prepare('SELECT * FROM product_map ORDER BY sort_order ASC').all().forEach(add)
	} else {
		_forEachScopeChunk(norms, (chunk) => {
			const ph = chunk.map(() => '?').join(',')
			db.prepare(`SELECT * FROM product_map WHERE title_norm IN (${ph}) ORDER BY sort_order ASC`).all(chunk).forEach(add)
		})
	}
	return map
}

/** Normalise cost input → a non-negative number, or null to clear. */
function _normCost(cost) {
	if (cost === null || cost === undefined || cost === '') return null
	const n = Number(cost)
	if (!Number.isFinite(n) || n < 0) return null
	return Math.round(n * 100) / 100 // 2 dp
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
	const t = String(title || '').trim()
	if (!t) {
		const e = new Error('Product title is required.')
		e.code = 'REQUIRED'
		throw e
	}
	const titleNorm = t.replace(/\|/g, ',').replace(/\s+/g, ' ').toLowerCase()
	const now = Math.floor(Date.now() / 1000)
	const existing = db
		.prepare(
			'SELECT id, cost_case, cost_grip, canonical_product_key, shop_name, stall FROM product_map WHERE title_norm = ?',
		)
		.get(titleNorm)
	const nextCase = cost_case === undefined ? (existing ? existing.cost_case : null) : _normCost(cost_case)
	const nextGrip = cost_grip === undefined ? (existing ? existing.cost_grip : null) : _normCost(cost_grip)
	const history = db.prepare(`
    INSERT INTO product_price_history
      (canonical_key, title_norm, component, old_cost, new_cost, changed_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
	const writeHistory = () => {
		if (cost_case !== undefined && (existing?.cost_case ?? null) !== nextCase) {
			history.run(existing?.canonical_product_key || null, titleNorm, 'case', existing?.cost_case ?? null, nextCase, now)
		}
		if (cost_grip !== undefined && (existing?.cost_grip ?? null) !== nextGrip) {
			history.run(existing?.canonical_product_key || null, titleNorm, 'grip', existing?.cost_grip ?? null, nextGrip, now)
		}
	}
	if (existing) {
		db.prepare('UPDATE product_map SET cost_case = @cc, cost_grip = @cg, updated_at = @now WHERE title_norm = @tn').run({ cc: nextCase, cg: nextGrip, now, tn: titleNorm })
		// One supplier offer can have many Etsy listing titles. Keep those aliases
		// in sync without overwriting a different booth's wholesale price for the
		// same physical design.
		if (existing.canonical_product_key) {
			const supplierKey = stallLocation.supplierIdentityKey(existing.shop_name, existing.stall)
			const aliases = db
				.prepare(
					"SELECT id, shop_name, stall FROM product_map WHERE canonical_product_key = ? AND status = 'active'",
				)
				.all(existing.canonical_product_key)
			const updateAlias = db.prepare(
				'UPDATE product_map SET cost_case = @cc, cost_grip = @cg, updated_at = @now WHERE id = @id',
			)
			for (const alias of aliases) {
				if (stallLocation.supplierIdentityKey(alias.shop_name, alias.stall) === supplierKey) {
					updateAlias.run({ id: alias.id, cc: nextCase, cg: nextGrip, now })
				}
			}
		}
		writeHistory()
	} else {
		const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM product_map').get().m
		db.prepare('INSERT INTO product_map (title_norm, title, cost_case, cost_grip, sort_order, updated_at) VALUES (@tn, @t, @cc, @cg, @so, @now)').run({ tn: titleNorm, t, cc: nextCase, cg: nextGrip, so: maxOrder + 1, now })
		writeHistory()
	}
	return { title_norm: titleNorm, cost_case: nextCase, cost_grip: nextGrip }
}

/**
 * Set the purchase cost for a charm (by code). Creates a minimal charm_library
 * row if the code isn't catalogued yet.
 * @returns {{ code: string, cost: number|null }}
 */
function setCharmCost(db, { code, cost }) {
	const cd = String(code || '').trim()
	if (!cd) {
		const e = new Error('Charm code is required.')
		e.code = 'REQUIRED'
		throw e
	}
	const c = _normCost(cost)
	const now = Math.floor(Date.now() / 1000)
	const existing = db.prepare('SELECT code FROM charm_library WHERE code = ?').get(cd)
	if (existing) {
		db.prepare('UPDATE charm_library SET cost = @c, updated_at = @now WHERE code = @cd').run({ c, now, cd })
	} else {
		db.prepare('INSERT INTO charm_library (code, cost, updated_at) VALUES (@cd, @c, @now)').run({ cd, c, now })
	}
	return { code: cd, cost: c }
}

/**
 * Return active product_map rows as an array, optionally filtered by a search
 * term (case-insensitive substring match on title, shop_name, or stall).
 * Retired rows remain queryable through getProductMapRow/getProductMapByNorm so
 * route resolution can distinguish an intentional removal from a missing row.
 * @param {Database.Database} db
 * @param {string} [q]  Optional search string.
 * @returns {Array}
 */
function getProductMap(db, q) {
	const all = db.prepare("SELECT * FROM product_map WHERE status = 'active' ORDER BY sort_order ASC, title ASC").all()
	if (!q) return all
	const lq = q.toLowerCase()
	return all.filter((r) => (r.title || '').toLowerCase().includes(lq) || (r.shop_name || '').toLowerCase().includes(lq) || (r.stall || '').toLowerCase().includes(lq) || (r.charm_shop || '').toLowerCase().includes(lq) || (r.charm_code || '').toLowerCase().includes(lq))
}

function _syncCanonicalProductMapFields(db, titleNorm, fields, previous = null) {
	const row = db
		.prepare('SELECT id, title, canonical_product_key, shop_name, stall FROM product_map WHERE title_norm = ?')
		.get(titleNorm)
	if (!row?.canonical_product_key) return row ? [row.title] : []
	const sourceSupplier = stallLocation.supplierIdentityKey(
		previous ? previous.shop_name : row.shop_name,
		previous ? previous.stall : row.stall,
	)
	const members = db
		.prepare(
			"SELECT id, title, shop_name, stall FROM product_map WHERE canonical_product_key = ? AND status = 'active'",
		)
		.all(row.canonical_product_key)
	const update = db.prepare(
		`UPDATE product_map SET
		   shop_name = @shop_name, stall = @stall,
		   charm_shop = @charm_shop, charm_code = @charm_code,
		   updated_at = @updated_at
		 WHERE id = @id`,
	)
	const values = {
		shop_name: String(fields.shop_name || '').trim(),
		stall: String(fields.stall || '').trim(),
		charm_shop: String(fields.charm_shop || '').trim(),
		charm_code: String(fields.charm_code || '').trim(),
		updated_at: Math.floor(Date.now() / 1000),
	}
	const affectedTitles = []
	const tx = db.transaction(() => {
		for (const member of members) {
			const sameOffer =
				member.id === row.id ||
				stallLocation.supplierIdentityKey(member.shop_name, member.stall) === sourceSupplier
			if (sameOffer) {
				update.run({ id: member.id, ...values })
				affectedTitles.push(member.title)
			}
		}
	})
	tx()
	return affectedTitles
}

/**
 * Insert or update a single product_map row.
 * Conflict resolution is by title_norm (UNIQUE).
 *
 * `product_type` follows the same rule as `canonical_product_key`: an absent or
 * blank value KEEPS whatever the row already had, so a create-or-update call
 * that doesn't mention the classification can never erase one. Clearing an
 * override back to "derive from the title" is done through
 * updateProductMapRowById, which is the by-id editor and can express it.
 *
 * @param {Database.Database} db
 * @param {{ title, shop_name?, stall?, charm_shop?, charm_code?, product_type?, sort_order? }} row
 * @returns {{ id: number, title_norm: string }}
 */
function upsertProductMapRow(db, row) {
	const title = String(row.title || '').trim()
	if (!title) {
		const e = new Error('Product title is required.')
		e.code = 'REQUIRED'
		throw e
	}

	const titleNorm = title.replace(/\|/g, ',').replace(/\s+/g, ' ').toLowerCase()

	const now = Math.floor(Date.now() / 1000)
	const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM product_map').get().m
	const existingBefore = db.prepare('SELECT * FROM product_map WHERE title_norm = ?').get(titleNorm) || null

	const info = db
		.prepare(
			`
    INSERT INTO product_map (
      title_norm, title, shop_name, stall, charm_shop, charm_code,
      canonical_product_key, product_type, status, retired_at, retired_reason,
      retired_by, sort_order, updated_at
    )
    VALUES (
      @title_norm, @title, @shop_name, @stall, @charm_shop, @charm_code,
      @canonical_product_key, @product_type, 'active', NULL, '', '',
      @sort_order, @updated_at
    )
    ON CONFLICT(title_norm) DO UPDATE SET
      title      = excluded.title,
      shop_name  = excluded.shop_name,
      stall      = excluded.stall,
      charm_shop = excluded.charm_shop,
      charm_code = excluded.charm_code,
      canonical_product_key = COALESCE(excluded.canonical_product_key, product_map.canonical_product_key),
      product_type = COALESCE(excluded.product_type, product_map.product_type),
      status = 'active',
      retired_at = NULL,
      retired_reason = '',
      retired_by = '',
      updated_at = excluded.updated_at
  `,
		)
		.run({
			title_norm: titleNorm,
			title,
			shop_name: String(row.shop_name || '').trim(),
			stall: String(row.stall || '').trim(),
			charm_shop: String(row.charm_shop || '').trim(),
			charm_code: String(row.charm_code || '').trim(),
			canonical_product_key: String(row.canonical_product_key || '').trim() || null,
			product_type: String(row.product_type || '').trim() || null,
			sort_order: typeof row.sort_order === 'number' ? row.sort_order : maxOrder + 1,
			updated_at: now,
		})

	// `lastInsertRowid` is not defined by SQLite for the UPDATE arm of an UPSERT
	// and may contain an unrelated prior insert. Read the unique key back.
	const id = db.prepare('SELECT id FROM product_map WHERE title_norm = ?').get(titleNorm).id

	const affectedTitles = _syncCanonicalProductMapFields(db, titleNorm, row, existingBefore)
	return { id, title_norm: titleNorm, affected_titles: affectedTitles }
}

/**
 * Update an active product_map row in-place by its surrogate `id`.
 *
 * Product titles are immutable identities: changing one in-place would strand
 * historical orders under the old title and re-enable the legacy supplier
 * fallback. The safe workflow is add the corrected title, then retire the old
 * one. Retired rows likewise require the explicit POST restore path.
 *
 * `product_type` is tri-state, like `canonical_product_key`: omit the key to
 * leave the classification alone, pass a type id to override the title-derived
 * one, or pass '' to clear the override and go back to deriving it.
 *
 * @param {Database.Database} db
 * @param {{ id, title, shop_name?, stall?, charm_shop?, charm_code?, product_type? }} row
 */
function updateProductMapRowById(db, row) {
	const id = Number(row.id)
	const title = String(row.title || '').trim()
	if (!title) {
		const e = new Error('Product title is required.')
		e.code = 'REQUIRED'
		throw e
	}

	const titleNorm = title.replace(/\|/g, ',').replace(/\s+/g, ' ').toLowerCase()
	const now = Math.floor(Date.now() / 1000)
	const existing = db.prepare('SELECT * FROM product_map WHERE id = ?').get(id)
	if (!existing) throw Object.assign(new Error('Entry not found.'), { code: 'NOT_FOUND' })
	if (existing.status !== 'active') {
		throw Object.assign(
			new Error('This product was discontinued by another update. Restore it explicitly before editing.'),
			{ code: 'CONFLICT' },
		)
	}
	if (titleNorm !== existing.title_norm) {
		throw Object.assign(
			new Error('Product titles are immutable. Add the corrected title as a new product, then discontinue this entry.'),
			{ code: 'IMMUTABLE' },
		)
	}
	const info = db
		.prepare(
			`
    UPDATE product_map
    SET title = @title, shop_name = @shop_name, stall = @stall,
        charm_shop = @charm_shop, charm_code = @charm_code,
        canonical_product_key = @canonical_product_key, product_type = @product_type,
        updated_at = @updated_at
    WHERE id = @id AND status = 'active'
  `,
		)
		.run({
			id,
			title,
			shop_name: String(row.shop_name || '').trim(),
			stall: String(row.stall || '').trim(),
			charm_shop: String(row.charm_shop || '').trim(),
			charm_code: String(row.charm_code || '').trim(),
			canonical_product_key: row.canonical_product_key === undefined ? existing?.canonical_product_key || null : String(row.canonical_product_key || '').trim() || null,
			product_type: row.product_type === undefined ? existing?.product_type || null : String(row.product_type || '').trim() || null,
			updated_at: now,
		})

	if (info.changes === 0) {
		const e = new Error('Entry not found.')
		e.code = 'NOT_FOUND'
		throw e
	}
	return {
		affected_titles: _syncCanonicalProductMapFields(db, titleNorm, row, existing),
	}
}

/** Remove stale product-level defaults that would otherwise outrank the catalog. */
function _deleteProductAssignmentsForTitle(db, title) {
	const titleNorm = _normTitleForKey(title || '')
	if (!titleNorm) return 0
	const base = titleNorm.slice(0, 50)
	const rows = db.prepare('SELECT item_key, title FROM product_assignments').all()
	const del = db.prepare('DELETE FROM product_assignments WHERE item_key = ?')
	let removed = 0
	for (const row of rows) {
		// Modern rows carry their full title, which avoids both LIKE wildcard
		// expansion and collisions between long titles sharing the first 50 chars.
		// A title-less legacy bare key is safe; a scoped key is intentionally left
		// alone because there is not enough information to attribute it.
		const exactTitle = row.title && _normTitleForKey(row.title) === titleNorm
		const safeLegacy = !row.title && row.item_key === base
		if (exactTitle || safeLegacy) removed += del.run(row.item_key).changes
	}
	return removed
}

/**
 * Retire a catalog product by id while preserving its historical identity.
 *
 * By default every active title alias carrying the same canonical physical
 * product key is retired together; a supplier cascade can opt out because a
 * canonical product may still be available from a different booth.
 *
 * @param {Database.Database} db
 * @param {number|string} id
 * @param {{ aliases?: boolean, reason?: string, by?: string }} [opts]
 * @returns {{removed:number, rows:Array<{id:number,title:string}>, assignments_removed:number}}
 */
function deleteProductMapRow(db, id, opts = {}) {
	const target = db.prepare("SELECT * FROM product_map WHERE id = ? AND status = 'active'").get(Number(id))
	if (!target) return { removed: 0, rows: [], assignments_removed: 0 }

	const aliases = opts.aliases !== false && String(target.canonical_product_key || '').trim()
	const targetSupplier = stallLocation.supplierIdentityKey(target.shop_name, target.stall)
	const rows = aliases
		? db
				.prepare(
					"SELECT id, title, shop_name, stall FROM product_map WHERE canonical_product_key = ? AND status = 'active' ORDER BY id",
				)
				.all(target.canonical_product_key)
				.filter(
					(row) =>
						stallLocation.supplierIdentityKey(row.shop_name, row.stall) === targetSupplier,
				)
		: [{ id: target.id, title: target.title }]
	const now = Math.floor(Date.now() / 1000)
	const reason = String(opts.reason || 'Removed from Product Catalog').trim().slice(0, 500)
	const by = String(opts.by || '').trim().slice(0, 120)
	let assignmentsRemoved = 0

	const retire = db.transaction(() => {
		const update = db.prepare(
			"UPDATE product_map SET status = 'retired', retired_at = ?, retired_reason = ?, retired_by = ?, updated_at = ? WHERE id = ? AND status = 'active'",
		)
		let removed = 0
		for (const row of rows) {
			removed += update.run(now, reason, by, now, row.id).changes
			assignmentsRemoved += _deleteProductAssignmentsForTitle(db, row.title)
		}
		return removed
	})
	const removed = retire()
	return { removed, rows, assignments_removed: assignmentsRemoved }
}

// ─── Manual route items ─────────────────────────────────────────────────────

/**
 * Insert a manual (operator-created) route line-item.
 *
 * When `row.receipt_id` is a negative integer it is used as-is — this is how
 * several products on ONE buyer order share a companion `receipts` row. When
 * omitted, a synthetic negative id is derived from the sidecar's own row id
 * (legacy path for sidecars that pre-date the linked-order model).
 *
 * @param {Database.Database} db
 * @param {object} row
 * @param {string} row.item_key   - line-item key (see route/dashboard.lineItemKey)
 * @param {string} row.title
 * @param {number} [row.receipt_id] - shared parent order id (negative)
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
	const title = String(row.title || '').trim()
	if (!title) {
		const e = new Error('Product title is required.')
		e.code = 'REQUIRED'
		throw e
	}
	if (!row.item_key) {
		const e = new Error('item_key is required.')
		e.code = 'REQUIRED'
		throw e
	}

	const tx = db.transaction(() => {
		const explicit = Number(row.receipt_id)
		const hasExplicit = Number.isInteger(explicit) && explicit < 0
		const info = db
			.prepare(
				`
      INSERT INTO route_manual_items
        (receipt_id, item_key, title, phone_model, style, quantity, shop_name,
         listing_id, image_url, image_data, image_mime, source, created_at)
      VALUES
        (@receipt_id, @item_key, @title, @phone_model, @style, @quantity, @shop_name,
         @listing_id, @image_url, @image_data, @image_mime, @source, strftime('%s','now'))
    `,
			)
			.run({
				receipt_id: hasExplicit ? explicit : 0,
				item_key: String(row.item_key),
				title,
				phone_model: String(row.phone_model || '').trim(),
				style: String(row.style || '').trim(),
				quantity: Math.max(1, parseInt(row.quantity, 10) || 1),
				shop_name: String(row.shop_name || '').trim(),
				listing_id: row.listing_id != null && String(row.listing_id).trim() !== '' ? Number(row.listing_id) : null,
				image_url: String(row.image_url || '').trim(),
				image_data: row.image_data && row.image_data.length ? row.image_data : null,
				image_mime: String(row.image_mime || '').trim(),
				source: row.source === 'catalog' ? 'catalog' : row.source === 'custom' ? 'custom' : 'manual',
			})
		const id = Number(info.lastInsertRowid)
		const receiptId = hasExplicit ? explicit : -id
		if (!hasExplicit) {
			db.prepare('UPDATE route_manual_items SET receipt_id = ? WHERE id = ?').run(receiptId, id)
		}
		return { id, receipt_id: receiptId }
	})
	return tx()
}

/** Hard cap on products per Route-tab manual order (one buyer, one shipment). */
const MAX_ROUTE_MANUAL_ITEMS = 40

/**
 * Create a Route-tab manual order: one `receipts` row + one sidecar per line,
 * sharing a single receipt_id so a buyer who ordered several products is one
 * order in both the Orders tab and the Route dashboard.
 *
 * Caller supplies a fully-normalised `items` array (title, item_key, optional
 * image buffer, optional charm). This helper is atomic: a failure rolls back
 * the receipt AND every sidecar.
 *
 * @param {Database.Database} db
 * @param {object} payload
 * @param {Array<object>} payload.items
 * @returns {{ receipt_id: number, items: Array<{id:number, receipt_id:number, item_key:string, title:string}> }}
 */
function createRouteManualOrder(db, payload) {
	const rawItems = Array.isArray(payload?.items) ? payload.items : []
	if (!rawItems.length) {
		const e = new Error('At least one product is required.')
		e.code = 'REQUIRED'
		throw e
	}
	if (rawItems.length > MAX_ROUTE_MANUAL_ITEMS) {
		const e = new Error(`A manual order can contain at most ${MAX_ROUTE_MANUAL_ITEMS} products.`)
		e.code = 'REQUIRED'
		throw e
	}

	const usedKeys = new Set()
	const lines = rawItems.map((it, idx) => {
		const title = String(it.title || '').trim()
		if (!title) {
			const e = new Error(`Product ${idx + 1} is missing a title.`)
			e.code = 'REQUIRED'
			throw e
		}
		let itemKey = String(it.item_key || '').trim()
		if (!itemKey) {
			const e = new Error(`Product ${idx + 1} is missing an item_key.`)
			e.code = 'REQUIRED'
			throw e
		}
		if (usedKeys.has(itemKey)) {
			let n = 2
			let candidate = `${itemKey}~${n}`
			while (usedKeys.has(candidate)) {
				n += 1
				candidate = `${itemKey}~${n}`
			}
			itemKey = candidate
		}
		usedKeys.add(itemKey)
		const phoneModel = String(it.phone_model || '').trim()
		const style = String(it.style || '').trim()
		const variations = []
		if (phoneModel) variations.push({ formatted_name: 'Phone Model', formatted_value: phoneModel })
		if (style) variations.push({ formatted_name: 'Style', formatted_value: style })
		return {
			title,
			item_key: itemKey,
			phone_model: phoneModel,
			style,
			quantity: Math.max(1, parseInt(it.quantity, 10) || 1),
			shop_name: String(it.shop_name || '').trim(),
			listing_id: it.listing_id != null && String(it.listing_id).trim() !== '' ? Number(it.listing_id) : null,
			image_url: String(it.image_url || '').trim(),
			image_data: it.image_data && it.image_data.length ? it.image_data : null,
			image_mime: String(it.image_mime || '').trim(),
			source: it.source === 'catalog' ? 'catalog' : it.source === 'custom' ? 'custom' : 'manual',
			charm_code: String(it.charm_code || '').trim(),
			charm_shop: String(it.charm_shop || '').trim(),
			variations,
		}
	})

	const tx = db.transaction(() => {
		const order = insertManualOrder(db, {
			shop_id: payload.shop_id,
			items: lines.map((l) => ({
				title: l.title,
				quantity: l.quantity,
				listing_id: l.listing_id,
				variations: l.variations,
			})),
		})

		const created = []
		for (const line of lines) {
			const sidecar = insertManualItem(db, {
				receipt_id: order.receipt_id,
				item_key: line.item_key,
				title: line.title,
				phone_model: line.phone_model,
				style: line.style,
				quantity: line.quantity,
				shop_name: line.shop_name,
				listing_id: line.listing_id,
				image_url: line.image_url,
				image_data: line.image_data,
				image_mime: line.image_mime,
				source: line.source,
			})
			if (line.charm_code) {
				try {
					upsertRouteAssignment(db, {
						receipt_id: sidecar.receipt_id,
						item_key: line.item_key,
						title: line.title,
						charm_code: line.charm_code,
						charm_shop: line.charm_shop,
					})
				} catch (e) {
					console.warn('[route] manual-order charm assignment warning:', e.message)
				}
			}
			created.push({
				id: sidecar.id,
				receipt_id: sidecar.receipt_id,
				item_key: line.item_key,
				title: line.title,
			})
		}
		return { receipt_id: order.receipt_id, items: created }
	})
	return tx()
}

// ─── Order issues (fulfilment-exception workflow) ───────────────────────────

/** Issue types the workflow understands. */
const ISSUE_TYPES = ['out_of_production', 'model_unavailable', 'other']
/** Listing actions recorded when the Etsy listing has been handled. */
const ISSUE_LISTING_ACTIONS = ['deleted', 'model_removed', 'none']
/** Resolutions recorded when an issue is closed. */
const ISSUE_RESOLUTIONS = ['switched', 'refunded', 'cancelled', 'other']

/**
 * Map of `${receipt_id}\x00${item_key}` → issue row, for ONLY open issues.
 * Used by the Route dashboard to hold affected line-items out of purchasing.
 * @param {Database.Database} db
 * @param {Iterable<number>} [receiptIds] optional receipt scope; [] means none
 * @returns {Map<string, object>}
 */
function getOpenIssueMap(db, receiptIds) {
	const map = new Map()
	const ids = _integerScope(receiptIds)
	try {
		const add = (r) => map.set(`${r.receipt_id}\x00${r.item_key}`, r)
		if (ids === null) {
			db.prepare("SELECT * FROM order_issues WHERE status = 'open'").all().forEach(add)
		} else {
			_forEachScopeChunk(ids, (chunk) => {
				const ph = chunk.map(() => '?').join(',')
				db.prepare(`SELECT * FROM order_issues WHERE status = 'open' AND receipt_id IN (${ph})`).all(chunk).forEach(add)
			})
		}
	} catch {
		/* table may not exist yet on first run */
	}
	return map
}

/**
 * All issues for a set of receipts (open + resolved), keyed by receipt_id.
 * @param {Database.Database} db
 * @param {Array<number>} receiptIds
 * @returns {Object<number, Array<object>>}
 */
function getIssuesForReceipts(db, receiptIds) {
	const out = {}
	const ids = (receiptIds || []).map(Number).filter(Number.isInteger)
	if (!ids.length) return out
	try {
		const ph = ids.map(() => '?').join(',')
		db.prepare(`SELECT * FROM order_issues WHERE receipt_id IN (${ph})`)
			.all(ids)
			.forEach((r) => {
				;(out[r.receipt_id] ||= []).push(r)
			})
	} catch {
		/* table may not exist yet */
	}
	return out
}

/** All issues for one receipt (open + resolved), newest first. */
function getIssuesForReceipt(db, receiptId) {
	try {
		return db.prepare('SELECT * FROM order_issues WHERE receipt_id = ? ORDER BY created_at DESC, id DESC').all(Number(receiptId))
	} catch {
		return []
	}
}

/** Fetch one issue by id, or null. */
function getIssueById(db, id) {
	try {
		return db.prepare('SELECT * FROM order_issues WHERE id = ?').get(Number(id)) || null
	} catch {
		return null
	}
}

/** Fetch the (single) issue for a line-item, or null. */
function getOrderIssue(db, receiptId, itemKey) {
	try {
		return db.prepare('SELECT * FROM order_issues WHERE receipt_id = ? AND item_key = ?').get(Number(receiptId), String(itemKey)) || null
	} catch {
		return null
	}
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
	const now = Math.floor(Date.now() / 1000)
	const issueType = ISSUE_TYPES.includes(p.issue_type) ? p.issue_type : 'other'
	// `source` records who last (re-)raised the issue: whoever calls upsert is
	// asserting it now, so they take ownership. Callers guard WHEN they upsert
	// (e.g. Shopping Mode never upserts over an actively-worked operator issue), so
	// overwriting source here is always the intended, current owner.
	db.prepare(
		`
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
  `,
	).run({
		receipt_id: Number(p.receipt_id),
		item_key: String(p.item_key),
		listing_id: p.listing_id != null ? Number(p.listing_id) : null,
		title: p.title != null ? String(p.title) : null,
		phone_model: p.phone_model != null ? String(p.phone_model) : null,
		issue_type: issueType,
		note: p.note != null ? String(p.note) : null,
		source: p.source === 'shop' ? 'shop' : 'manual',
		now,
	})
	return db.prepare('SELECT * FROM order_issues WHERE receipt_id = ? AND item_key = ?').get(Number(p.receipt_id), String(p.item_key))
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
	const existing = getIssueById(db, id)
	if (!existing) return null
	const allowed = ['buyer_notified_at', 'listing_handled_at', 'listing_action', 'status', 'resolution', 'resolved_at', 'note', 'buyer_message', 'buyer_message_at', 'source']
	const sets = []
	const params = { id: Number(id), now: Math.floor(Date.now() / 1000) }
	for (const k of allowed) {
		if (Object.prototype.hasOwnProperty.call(patch, k)) {
			sets.push(`${k} = @${k}`)
			params[k] = patch[k]
		}
	}
	if (!sets.length) return existing
	sets.push('updated_at = @now')
	db.prepare(`UPDATE order_issues SET ${sets.join(', ')} WHERE id = @id`).run(params)
	return getIssueById(db, id)
}

/** Permanently delete an issue. Returns true when a row was removed. */
function deleteOrderIssue(db, id) {
	try {
		return db.prepare('DELETE FROM order_issues WHERE id = ?').run(Number(id)).changes > 0
	} catch {
		return false
	}
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
	let archived
	try {
		archived = db.prepare('SELECT receipt_id, archive_reason, all_transactions FROM receipts WHERE archived_at IS NOT NULL').all()
	} catch {
		return
	} // archived_at column absent (fresh DB) → nothing to do
	if (!archived.length) return

	// Lazy require to avoid a circular top-level dependency (route/dashboard pulls
	// from this module). By migration time both modules are fully loaded.
	let lineItemKey, parseVariations
	try {
		;({ lineItemKey, parseVariations } = require('../route/dashboard'))
	} catch {
		/* fall back below */
	}

	const OUT_OF_PROD_RE = /out of production/i
	let migratedOrders = 0,
		createdIssues = 0

	const tx = db.transaction(() => {
		for (const r of archived) {
			const reason = String(r.archive_reason || '')
			if (OUT_OF_PROD_RE.test(reason) && lineItemKey) {
				let txs = []
				try {
					txs = JSON.parse(r.all_transactions || '[]')
				} catch {
					txs = []
				}
				if (!Array.isArray(txs)) txs = []
				for (const t of txs) {
					const title = (t.title || '').trim()
					if (!title) continue
					const itemKey = lineItemKey(title, t.listing_id)
					// Don't clobber an issue the operator may already have created.
					const exists = db.prepare('SELECT 1 FROM order_issues WHERE receipt_id = ? AND item_key = ?').get(r.receipt_id, itemKey)
					if (exists) continue
					let phoneModel = ''
					try {
						phoneModel = parseVariations ? parseVariations(t.variations).phoneModel || '' : ''
					} catch {}
					upsertOrderIssue(db, {
						receipt_id: r.receipt_id,
						item_key: itemKey,
						listing_id: t.listing_id || null,
						title,
						phone_model: phoneModel || null,
						issue_type: 'out_of_production',
						note: 'Migrated from Archive: ' + reason.slice(0, 200),
					})
					createdIssues++
				}
			}
			// Restore to active views; keep archive_reason as a dormant breadcrumb.
			db.prepare('UPDATE receipts SET archived_at = NULL WHERE receipt_id = ?').run(r.receipt_id)
			migratedOrders++
		}
	})
	tx()

	if (migratedOrders) {
		console.log(`[db] Retired Archive → Issues: processed ${migratedOrders} archived order(s), opened ${createdIssues} issue(s).`)
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
	let result
	try {
		result = db
			.prepare(
				`
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
    `,
			)
			.run()
	} catch {
		return
	} // either table absent on a fresh DB → nothing to heal
	if (result.changes > 0) {
		console.log(`[db] Un-held ${result.changes} switched line(s) whose on-hold flag was superseded by a design switch.`)
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
	let lineItemKey, parseVariations
	try {
		;({ lineItemKey, parseVariations } = require('../route/dashboard'))
	} catch {
		/* fall back below */
	}

	let rows
	try {
		rows = db
			.prepare(
				`
      SELECT receipt_id, item_key, title, status_case, status_grip, status_charm
        FROM route_assignments
       WHERE status_case  IN ('Out of Production','Model Unavailable')
          OR status_grip  IN ('Out of Production','Model Unavailable')
          OR status_charm IN ('Out of Production','Model Unavailable')
    `,
			)
			.all()
	} catch {
		return
	} // table absent on a fresh DB → nothing to reconcile
	if (!rows.length) return

	let created = 0
	const tx = db.transaction(() => {
		for (const r of rows) {
			const existing = db.prepare('SELECT status, resolution FROM order_issues WHERE receipt_id = ? AND item_key = ?').get(r.receipt_id, r.item_key)
			if (existing && existing.status === 'open') continue // already held
			if (existing && (existing.resolution === 'refunded' || existing.resolution === 'cancelled')) continue // deliberately closed

			const statuses = [r.status_case, r.status_grip, r.status_charm]
			const type = statuses.includes('Out of Production') ? 'out_of_production' : statuses.includes('Model Unavailable') ? 'model_unavailable' : null
			if (!type) continue

			// Context follows the switched design when present, else the ordered line.
			const sub = getSubstitutionForLine(db, r.receipt_id, r.item_key)
			let title = (sub && sub.new_title) || r.title || null
			let listingId = null
			let phoneModel = (sub && sub.new_phone_model) || null
			try {
				// Prefer the transactions table; fall back to receipts.all_transactions so
				// manual orders (no Etsy sync) still resolve title / listing / model.
				// Match by the canonical line key (variant-aware) so a `#V…` assignment
				// finds its transaction instead of looking like a context-free ghost.
				const lineIdentity = require('../orders/line-identity')
				let txns = []
				try {
					txns = db.prepare('SELECT title, listing_id, variations FROM transactions WHERE receipt_id = ?').all(r.receipt_id)
				} catch {
					txns = []
				}
				if (!txns.length) {
					try {
						const row = db.prepare('SELECT all_transactions FROM receipts WHERE receipt_id = ?').get(r.receipt_id)
						txns = JSON.parse(row?.all_transactions || '[]')
						if (!Array.isArray(txns)) txns = []
					} catch {
						txns = []
					}
				}
				const m = lineIdentity.findTransactionByLineKey(db, r.receipt_id, txns, r.item_key) || (lineItemKey && txns.find((t) => lineItemKey(t.title, t.listing_id) === r.item_key)) || null
				if (m) {
					listingId = m.listing_id != null ? Number(m.listing_id) : null
					if (!title) title = m.title
					if (!phoneModel && parseVariations) {
						try {
							phoneModel = parseVariations(m.variations).phoneModel || null
						} catch {
							/* best effort */
						}
					}
				}
			} catch {
				/* best effort */
			}

			upsertOrderIssue(db, {
				receipt_id: r.receipt_id,
				item_key: r.item_key,
				listing_id: listingId,
				title,
				phone_model: phoneModel,
				issue_type: type,
				source: 'shop',
			})
			created++
		}
	})
	tx()
	if (created) {
		console.log(`[db] Reconciled ${created} on-hold line(s): terminal purchase status now surfaced as a fulfilment issue.`)
	}
}

// ─── Order exchanges (wrong-model in-person swap workflow) ───────────────────

/** Component pieces an exchange can cover. */
const EXCHANGE_COMPONENTS = ['case', 'grip', 'charm']

/**
 * Normalise a components input (array or comma string) to a clean, ordered,
 * de-duplicated "case,grip,charm"-style string containing only valid pieces.
 * @param {string|string[]|null|undefined} input
 * @returns {string}
 */
function normalizeExchangeComponents(input) {
	let parts = []
	if (Array.isArray(input)) parts = input
	else if (typeof input === 'string') parts = input.split(',')
	const set = new Set(parts.map((p) => String(p).trim().toLowerCase()).filter(Boolean))
	return EXCHANGE_COMPONENTS.filter((c) => set.has(c)).join(',')
}

/**
 * Map of `${receipt_id}\x00${item_key}` → exchange row, for ONLY open exchanges.
 * Used by the Route dashboard to hold affected line-items out of purchasing while
 * surfacing them in the dedicated "To exchange" bucket.
 * @param {Database.Database} db
 * @param {Iterable<number>} [receiptIds] optional receipt scope; [] means none
 * @returns {Map<string, object>}
 */
function getOpenExchangeMap(db, receiptIds) {
	const map = new Map()
	const ids = _integerScope(receiptIds)
	try {
		const add = (r) => map.set(`${r.receipt_id}\x00${r.item_key}`, r)
		if (ids === null) {
			db.prepare("SELECT * FROM order_exchanges WHERE status = 'open'").all().forEach(add)
		} else {
			_forEachScopeChunk(ids, (chunk) => {
				const ph = chunk.map(() => '?').join(',')
				db.prepare(`SELECT * FROM order_exchanges WHERE status = 'open' AND receipt_id IN (${ph})`).all(chunk).forEach(add)
			})
		}
	} catch {
		/* table may not exist yet on first run */
	}
	return map
}

/**
 * All exchanges for a set of receipts (open + done), keyed by receipt_id.
 * @param {Database.Database} db
 * @param {Array<number>} receiptIds
 * @returns {Object<number, Array<object>>}
 */
function getExchangesForReceipts(db, receiptIds) {
	const out = {}
	const ids = (receiptIds || []).map(Number).filter(Number.isInteger)
	if (!ids.length) return out
	try {
		const ph = ids.map(() => '?').join(',')
		db.prepare(`SELECT * FROM order_exchanges WHERE receipt_id IN (${ph})`)
			.all(ids)
			.forEach((r) => {
				;(out[r.receipt_id] ||= []).push(r)
			})
	} catch {
		/* table may not exist yet */
	}
	return out
}

/** All exchanges for one receipt (open + done), newest first. */
function getExchangesForReceipt(db, receiptId) {
	try {
		return db.prepare('SELECT * FROM order_exchanges WHERE receipt_id = ? ORDER BY created_at DESC, id DESC').all(Number(receiptId))
	} catch {
		return []
	}
}

/** Fetch one exchange by id, or null. */
function getExchangeById(db, id) {
	try {
		return db.prepare('SELECT * FROM order_exchanges WHERE id = ?').get(Number(id)) || null
	} catch {
		return null
	}
}

/**
 * Create or update (re-open) the wrong-model exchange for a line-item. Keyed by
 * (receipt_id, item_key); re-flagging an existing line updates its details and
 * re-opens it (clearing any prior done stamp) so the fix is owed again.
 *
 * `have_model` is written VERBATIM rather than COALESCEd, because blanking it is
 * a meaningful edit: it is the field that decides whether the fix is a SWAP (we
 * hold the wrong model) or a BUY (we hold nothing and must purchase the correct
 * model) — see routeDashboard.exchangeIntent. Preserving a stale have_model made
 * "I no longer have that item, I'll just buy the right one" impossible to
 * record, silently pinning the line to the swap workflow.
 *
 * @param {Database.Database} db
 * @param {object} p - { receipt_id, item_key, listing_id?, title?, have_model?,
 *   need_model?, components?, supplier_shop?, supplier_stall?, note? }
 * @returns {object} the upserted exchange row
 */
function upsertOrderExchange(db, p) {
	const now = Math.floor(Date.now() / 1000)
	db.prepare(
		`
    INSERT INTO order_exchanges
      (receipt_id, item_key, listing_id, title, have_model, need_model,
       components, supplier_shop, supplier_stall, status, note, created_at, updated_at)
    VALUES
      (@receipt_id, @item_key, @listing_id, @title, @have_model, @need_model,
       @components, @supplier_shop, @supplier_stall, 'open', @note, @now, @now)
    ON CONFLICT(receipt_id, item_key) DO UPDATE SET
      listing_id     = COALESCE(excluded.listing_id, listing_id),
      title          = COALESCE(excluded.title, title),
      have_model     = excluded.have_model,
      need_model     = COALESCE(excluded.need_model, need_model),
      components     = excluded.components,
      supplier_shop  = COALESCE(excluded.supplier_shop, supplier_shop),
      supplier_stall = COALESCE(excluded.supplier_stall, supplier_stall),
      note           = COALESCE(excluded.note, note),
      status         = 'open',
      done_at        = NULL,
      updated_at     = excluded.updated_at
  `,
	).run({
		receipt_id: Number(p.receipt_id),
		item_key: String(p.item_key),
		listing_id: p.listing_id != null ? Number(p.listing_id) : null,
		title: p.title != null ? String(p.title) : null,
		have_model: p.have_model != null ? String(p.have_model) : null,
		need_model: p.need_model != null ? String(p.need_model) : null,
		components: normalizeExchangeComponents(p.components),
		supplier_shop: p.supplier_shop != null ? String(p.supplier_shop) : null,
		supplier_stall: p.supplier_stall != null ? String(p.supplier_stall) : null,
		note: p.note != null ? String(p.note) : null,
		now,
	})
	return db.prepare('SELECT * FROM order_exchanges WHERE receipt_id = ? AND item_key = ?').get(Number(p.receipt_id), String(p.item_key))
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
	const existing = getExchangeById(db, id)
	if (!existing) return null
	const allowed = ['status', 'done_at', 'note', 'have_model', 'need_model', 'components', 'supplier_shop', 'supplier_stall']
	const sets = []
	const params = { id: Number(id), now: Math.floor(Date.now() / 1000) }
	for (const k of allowed) {
		if (Object.prototype.hasOwnProperty.call(patch, k)) {
			sets.push(`${k} = @${k}`)
			params[k] = k === 'components' ? normalizeExchangeComponents(patch[k]) : patch[k]
		}
	}
	if (!sets.length) return existing
	sets.push('updated_at = @now')
	db.prepare(`UPDATE order_exchanges SET ${sets.join(', ')} WHERE id = @id`).run(params)
	return getExchangeById(db, id)
}

/** Permanently delete an exchange. Returns true when a row was removed. */
function deleteOrderExchange(db, id) {
	try {
		return db.prepare('DELETE FROM order_exchanges WHERE id = ?').run(Number(id)).changes > 0
	} catch {
		return false
	}
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
  image_mime, note, created_at, updated_at`

/**
 * Map of `${receipt_id}\x00${item_key}` → substitution (metadata only), for use
 * by the Route builder to override a line's product with the switched design.
 * @param {Database.Database} db
 * @param {Iterable<number>} [receiptIds] optional receipt scope; [] means none
 * @returns {Map<string, object>}
 */
function getSubstitutionMap(db, receiptIds) {
	const map = new Map()
	const ids = _integerScope(receiptIds)
	try {
		const add = (r) => map.set(`${r.receipt_id}\x00${r.item_key}`, r)
		if (ids === null) {
			db.prepare(`SELECT ${_SUB_PUBLIC_COLS} FROM order_line_substitutions`).all().forEach(add)
		} else {
			_forEachScopeChunk(ids, (chunk) => {
				const ph = chunk.map(() => '?').join(',')
				db.prepare(`SELECT ${_SUB_PUBLIC_COLS} FROM order_line_substitutions WHERE receipt_id IN (${ph})`).all(chunk).forEach(add)
			})
		}
	} catch {
		/* table may not exist yet on first run */
	}
	return map
}

/**
 * All substitutions for a set of receipts (metadata only), keyed by receipt_id.
 * @param {Database.Database} db
 * @param {Array<number>} receiptIds
 * @returns {Object<number, Array<object>>}
 */
function getSubstitutionsForReceipts(db, receiptIds) {
	const out = {}
	const ids = [...new Set((receiptIds || []).map(Number).filter(Number.isInteger))]
	if (!ids.length) return out
	try {
		for (let i = 0; i < ids.length; i += 500) {
			const chunk = ids.slice(i, i + 500)
			const ph = chunk.map(() => '?').join(',')
			db.prepare(`SELECT ${_SUB_PUBLIC_COLS} FROM order_line_substitutions WHERE receipt_id IN (${ph})`)
				.all(chunk)
				.forEach((r) => {
					;(out[r.receipt_id] ||= []).push(r)
				})
		}
	} catch {
		/* table may not exist yet */
	}
	return out
}

/** The substitution for one line (metadata only), or null. */
function getSubstitutionForLine(db, receiptId, itemKey) {
	try {
		return db.prepare(`SELECT ${_SUB_PUBLIC_COLS} FROM order_line_substitutions WHERE receipt_id = ? AND item_key = ?`).get(Number(receiptId), String(itemKey)) || null
	} catch {
		return null
	}
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
	const now = Math.floor(Date.now() / 1000)
	const hasImage = Object.prototype.hasOwnProperty.call(p, 'image_data')
	const existing = getSubstitutionForLine(db, p.receipt_id, p.item_key)

	if (existing) {
		// Update in place; only overwrite the image when a new one was supplied.
		const sets = ['original_title = COALESCE(@original_title, original_title)', 'new_title = @new_title', 'new_style = @new_style', 'new_phone_model = @new_phone_model', 'source = @source', 'source_listing_id = @source_listing_id', 'image_url = @image_url', 'note = @note', 'updated_at = @now']
		if (hasImage) {
			sets.push('image_data = @image_data', 'image_mime = @image_mime')
		}
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
			image_data: hasImage ? p.image_data || null : null,
			image_mime: hasImage ? (p.image_mime != null ? String(p.image_mime) : null) : null,
			note: p.note != null ? String(p.note) : null,
			now,
		})
	} else {
		db.prepare(
			`
      INSERT INTO order_line_substitutions
        (receipt_id, item_key, original_title, new_title, new_style, new_phone_model,
         source, source_listing_id, image_url, image_data, image_mime, note, created_at, updated_at)
      VALUES
        (@receipt_id, @item_key, @original_title, @new_title, @new_style, @new_phone_model,
         @source, @source_listing_id, @image_url, @image_data, @image_mime, @note, @now, @now)
    `,
		).run({
			receipt_id: Number(p.receipt_id),
			item_key: String(p.item_key),
			original_title: p.original_title != null ? String(p.original_title) : null,
			new_title: String(p.new_title),
			new_style: p.new_style != null ? String(p.new_style) : null,
			new_phone_model: p.new_phone_model != null ? String(p.new_phone_model) : null,
			source: p.source != null ? String(p.source) : null,
			source_listing_id: p.source_listing_id != null ? Number(p.source_listing_id) : null,
			image_url: p.image_url != null ? String(p.image_url) : null,
			image_data: hasImage ? p.image_data || null : null,
			image_mime: hasImage ? (p.image_mime != null ? String(p.image_mime) : null) : null,
			note: p.note != null ? String(p.note) : null,
			now,
		})
	}
	return getSubstitutionForLine(db, p.receipt_id, p.item_key)
}

/** Remove the design switch for a line. Returns true when a row was removed. */
function deleteOrderSubstitution(db, receiptId, itemKey) {
	try {
		return db.prepare('DELETE FROM order_line_substitutions WHERE receipt_id = ? AND item_key = ?').run(Number(receiptId), String(itemKey)).changes > 0
	} catch {
		return false
	}
}

/** Fetch a substitution's stored image bytes + mime, or null. */
function getSubstitutionImage(db, id) {
	try {
		const row = db.prepare('SELECT image_data, image_mime FROM order_line_substitutions WHERE id = ?').get(Number(id))
		if (row && row.image_data && row.image_data.length) {
			return { data: row.image_data, mime: row.image_mime || 'image/png' }
		}
	} catch {
		/* table may not exist yet */
	}
	return null
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
	return String(style == null ? '' : style)
		.trim()
		.toLowerCase()
		.replace(/\s+/g, ' ')
}

/**
 * Public columns for a style-image row — everything EXCEPT the BLOB, so callers
 * can list/inspect overrides cheaply without pulling image bytes.
 */
const _STYLE_IMG_META_COLS = 'id, listing_id, style_key, style_value, image_mime, note, created_at, updated_at'

/**
 * Create or replace the clarifying image for a (listing_id, style) variant.
 *
 * @param {Database.Database} db
 * @param {object} p - { listing_id, style_value?, image_data(Buffer),
 *   image_mime?, note? }
 * @returns {object} the upserted row (metadata only)
 */
function upsertListingStyleImage(db, p) {
	const listingId = Number(p.listing_id)
	const styleValue = String(p.style_value == null ? '' : p.style_value).trim()
	const styleKey = normalizeStyleKey(styleValue)
	db.prepare(
		`
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
  `,
	).run({
		listing_id: listingId,
		style_key: styleKey,
		style_value: styleValue,
		image_data: p.image_data,
		image_mime: p.image_mime != null ? String(p.image_mime) : 'image/png',
		note: p.note != null ? String(p.note) : '',
	})
	return db.prepare(`SELECT ${_STYLE_IMG_META_COLS} FROM listing_style_images WHERE listing_id = ? AND style_key = ?`).get(listingId, styleKey)
}

/** Remove the override for a (listing_id, style). Returns true when one existed. */
function deleteListingStyleImage(db, listingId, styleValue) {
	try {
		return db.prepare('DELETE FROM listing_style_images WHERE listing_id = ? AND style_key = ?').run(Number(listingId), normalizeStyleKey(styleValue)).changes > 0
	} catch {
		return false
	}
}

/** Metadata (no BLOB) for one (listing_id, style) override, or null. */
function getListingStyleImageMeta(db, listingId, styleValue) {
	try {
		return db.prepare(`SELECT ${_STYLE_IMG_META_COLS} FROM listing_style_images WHERE listing_id = ? AND style_key = ?`).get(Number(listingId), normalizeStyleKey(styleValue)) || null
	} catch {
		return null
	}
}

/** Fetch a style-image's stored bytes + mime by row id, or null. */
function getListingStyleImage(db, id) {
	try {
		const row = db.prepare('SELECT image_data, image_mime FROM listing_style_images WHERE id = ?').get(Number(id))
		if (row && row.image_data && row.image_data.length) {
			return { data: row.image_data, mime: row.image_mime || 'image/png' }
		}
	} catch {
		/* table may not exist yet */
	}
	return null
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
	const out = {}
	const ids = _integerScope(listingIds) || []
	if (!ids.length) return out
	try {
		_forEachScopeChunk(ids, (chunk) => {
			const ph = chunk.map(() => '?').join(',')
			db.prepare(`SELECT id, listing_id, style_key, image_mime, updated_at FROM listing_style_images WHERE listing_id IN (${ph})`)
				.all(chunk)
				.forEach((r) => {
					out[`${r.listing_id}\x00${r.style_key}`] = { id: r.id, image_mime: r.image_mime, updated_at: r.updated_at }
				})
		})
	} catch {
		/* table may not exist yet */
	}
	return out
}

/**
 * Replace the cached Etsy variation-image mapping for one listing. An empty
 * `rows` array still stamps fetched_at so listings with no variation photos
 * are not re-fetched every sync cycle.
 *
 * @param {Database.Database} db
 * @param {number} listingId
 * @param {Array<{style_key?:string, style_value?:string, image_id?:number, url:string, value_id?:number, property_id?:number}>} rows
 */
function replaceListingVariationImages(db, listingId, rows) {
	const id = Number(listingId)
	if (!Number.isInteger(id) || id <= 0) return
	const list = Array.isArray(rows) ? rows : []
	const persist = db.transaction(() => {
		db.prepare('DELETE FROM listing_variation_images WHERE listing_id = ?').run(id)
		const ins = db.prepare(`
      INSERT INTO listing_variation_images
        (listing_id, style_key, style_value, image_id, url, value_id, property_id, cached_at)
      VALUES
        (@listing_id, @style_key, @style_value, @image_id, @url, @value_id, @property_id,
         strftime('%s','now'))
    `)
		const seen = new Set()
		let mappingCount = 0
		for (const row of list) {
			const styleValue = String(row?.style_value == null ? '' : row.style_value).trim()
			const styleKey = String(row?.style_key || canonicalizeStyleKey(styleValue))
			const url = String(row?.url || '').trim()
			if (!styleKey || !url || seen.has(styleKey)) continue
			seen.add(styleKey)
			ins.run({
				listing_id: id,
				style_key: styleKey,
				style_value: styleValue,
				image_id: row.image_id != null && Number.isInteger(Number(row.image_id)) ? Number(row.image_id) : null,
				url,
				value_id: row.value_id != null && Number.isInteger(Number(row.value_id)) ? Number(row.value_id) : null,
				property_id: row.property_id != null && Number.isInteger(Number(row.property_id)) ? Number(row.property_id) : null,
			})
			mappingCount += 1
		}
		db.prepare(
			`
      INSERT INTO listing_variation_image_state (listing_id, fetched_at, mapping_count)
      VALUES (?, strftime('%s','now'), ?)
      ON CONFLICT(listing_id) DO UPDATE SET
        fetched_at = excluded.fetched_at,
        mapping_count = excluded.mapping_count
    `,
		).run(id, mappingCount)
	})
	persist()
}

/**
 * Batch-load cached Etsy variation photos for a set of listings.
 *
 * Two indexes over the same rows: `byValue` keyed by
 * `${listing_id}\x00${value_id}` (exact — survives a style rename) and
 * `byStyle` keyed by `${listing_id}\x00${style_key}` (label fallback).
 *
 * @param {Database.Database} db
 * @param {Iterable<number>} listingIds
 * @returns {{byStyle: Object<string, object>, byValue: Object<string, object>}}
 */
function getListingVariationImageMap(db, listingIds) {
	const out = { byStyle: {}, byValue: {} }
	const ids = _integerScope(listingIds) || []
	if (!ids.length) return out
	try {
		_forEachScopeChunk(ids, (chunk) => {
			const ph = chunk.map(() => '?').join(',')
			db.prepare(`SELECT listing_id, style_key, style_value, url, image_id, value_id, cached_at FROM listing_variation_images WHERE listing_id IN (${ph})`)
				.all(chunk)
				.forEach((r) => {
					if (!r.url) return
					const entry = {
						url: r.url,
						image_id: r.image_id,
						style_value: r.style_value || '',
						cached_at: r.cached_at,
					}
					out.byStyle[`${r.listing_id}\x00${r.style_key}`] = entry
					if (r.value_id != null) out.byValue[`${r.listing_id}\x00${r.value_id}`] = entry
				})
		})
	} catch {
		/* table may not exist yet */
	}
	return out
}

/**
 * Listing IDs whose variation-image cache is missing or older than `ttlSec`.
 * Never-fetched listings sort first so new orders populate before a refresh
 * of already-cached listings.
 *
 * @param {Database.Database} db
 * @param {Iterable<number>} listingIds
 * @param {number} ttlSec
 * @returns {number[]}
 */
function listingIdsNeedingVariationRefresh(db, listingIds, ttlSec) {
	const ids = [...new Set([...(listingIds || [])].map(Number).filter((id) => Number.isInteger(id) && id > 0))]
	if (!ids.length) return []
	const ttl = Math.max(0, Number(ttlSec) || 0)
	const now = Math.floor(Date.now() / 1000)
	const fetchedAt = new Map()
	try {
		const ph = ids.map(() => '?').join(',')
		db.prepare(`SELECT listing_id, fetched_at FROM listing_variation_image_state WHERE listing_id IN (${ph})`)
			.all(ids)
			.forEach((r) => fetchedAt.set(Number(r.listing_id), Number(r.fetched_at) || 0))
	} catch {
		/* table may not exist yet — treat every id as never-fetched */
	}

	return ids
		.filter((id) => {
			const at = fetchedAt.get(id)
			if (at == null || at <= 0) return true
			return now - at >= ttl
		})
		.sort((a, b) => {
			const aAt = fetchedAt.get(a) || 0
			const bAt = fetchedAt.get(b) || 0
			if (aAt !== bAt) return aAt - bAt
			return a - b
		})
}

/**
 * Return all manual route items (metadata only — no image BLOB), newest first.
 * @param {Database.Database} db
 * @returns {Array}
 */
function getManualItems(db) {
	try {
		return db
			.prepare(
				`
      SELECT id, receipt_id, item_key, title, phone_model, style, quantity,
             shop_name, listing_id, image_url,
             (image_data IS NOT NULL) AS has_image_data, image_mime, source, created_at
      FROM route_manual_items
      ORDER BY created_at DESC, id DESC
    `,
			)
			.all()
	} catch {
		return []
	}
}

/**
 * Fetch a manual item's stored image bytes + mime, or null.
 * @param {Database.Database} db
 * @param {number} id
 * @returns {{ data: Buffer, mime: string }|null}
 */
function getManualItemImage(db, id) {
	try {
		const row = db.prepare('SELECT image_data, image_mime FROM route_manual_items WHERE id = ?').get(Number(id))
		if (row && row.image_data && row.image_data.length) {
			return { data: row.image_data, mime: row.image_mime || 'image/png' }
		}
	} catch {
		/* table may not exist yet */
	}
	return null
}

/**
 * Delete a manual item by its synthetic receipt_id, also clearing any
 * route_assignments (charm / status / exclude) attached to it.
 * @param {Database.Database} db
 * @param {number} receiptId  negative synthetic receipt id
 * @returns {boolean} true when a row was deleted
 */
function deleteManualItemByReceipt(db, receiptId) {
	return purgeManualOrder(db, receiptId)
}

/**
 * Delete ONE product line of a manual order.
 *
 * A manual order can carry several products, so deleting a single Route row
 * must not take its siblings (and the buyer's address / shipment) with it. The
 * line's sidecar, per-line assignment and purchase rows are removed, and the
 * matching transaction is dropped from the companion receipt so the Orders tab
 * agrees. Deleting the LAST remaining line is a full teardown — an order with
 * no products is not an order.
 *
 * @param {Database.Database} db
 * @param {number} receiptId  the shared (negative) manual receipt id
 * @param {string} itemKey    the line to remove; empty means "the whole order"
 * @returns {{ removed: boolean, purged: boolean, remaining: number }}
 */
function deleteManualOrderLine(db, receiptId, itemKey) {
	const rid = Number(receiptId)
	const key = String(itemKey || '').trim()
	if (!key) {
		return { removed: purgeManualOrder(db, rid), purged: true, remaining: 0 }
	}

	const tx = db.transaction(() => {
		let sidecars = []
		try {
			sidecars = db.prepare('SELECT id, item_key, title, listing_id FROM route_manual_items WHERE receipt_id = ? ORDER BY id ASC').all(rid)
		} catch {
			sidecars = []
		}

		const target = sidecars.find((s) => s.item_key === key)
		// Unknown line, or the order's only line: fall back to the full teardown so
		// a legacy sidecar (or the last product) is never left half-deleted.
		if (!target || sidecars.length <= 1) {
			return { removed: purgeManualOrder(db, rid), purged: true, remaining: 0 }
		}

		let removed = 0
		try {
			removed += db.prepare('DELETE FROM route_manual_items WHERE id = ?').run(target.id).changes
		} catch {
			/* table may not exist */
		}
		for (const sql of ['DELETE FROM route_assignments WHERE receipt_id = ? AND item_key = ?', 'DELETE FROM receipt_item_purchase WHERE receipt_id = ? AND item_key = ?']) {
			try {
				db.prepare(sql).run(rid, key)
			} catch {
				/* table may not exist */
			}
		}

		// Keep the companion receipt in step: drop the transaction that matches this
		// product's canonical line key. Matching by title+listing alone is wrong when
		// the same listing appears twice with different models/styles — those share
		// title+listing but are distinct `#V…` sidecars.
		try {
			const row = db.prepare('SELECT all_transactions FROM receipts WHERE receipt_id = ?').get(rid)
			let txs = []
			try {
				txs = JSON.parse(row?.all_transactions || '[]')
			} catch {
				txs = []
			}
			if (Array.isArray(txs) && txs.length) {
				let idx = -1
				try {
					const lineIdentity = require('../orders/line-identity')
					const keys = lineIdentity.alignLineKeys(
						txs,
						sidecars.map((s) => s.item_key),
					)
					idx = keys.indexOf(key)
				} catch {
					idx = -1
				}
				if (idx === -1) {
					idx = txs.findIndex((t) => String(t.title || '').trim() === String(target.title || '').trim() && (t.listing_id == null ? null : Number(t.listing_id)) === (target.listing_id == null ? null : Number(target.listing_id)))
				}
				if (idx !== -1) {
					txs.splice(idx, 1)
					if (txs.length === 0) {
						return { removed: purgeManualOrder(db, rid), purged: true, remaining: 0 }
					}
					db.prepare(
						`
            UPDATE receipts SET
              all_transactions    = @all_transactions,
              first_product_title = @first_product_title,
              first_listing_id    = @first_listing_id,
              first_quantity      = @first_quantity,
              etsy_updated_at     = @now
            WHERE receipt_id = @receipt_id AND source = 'manual'
          `,
					).run({
						receipt_id: rid,
						all_transactions: JSON.stringify(txs),
						first_product_title: txs[0].title || '',
						first_listing_id: txs[0].listing_id ?? null,
						first_quantity: txs[0].quantity ?? 1,
						now: Math.floor(Date.now() / 1000),
					})
				}
			}
		} catch {
			/* receipt rollups are best-effort — the sidecar is already gone */
		}

		return { removed: removed > 0, purged: false, remaining: sidecars.length - 1 }
	})
	return tx()
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
	const rid = Number(receiptId)
	const tx = db.transaction(() => {
		let removed = 0
		for (const sql of ['DELETE FROM route_assignments WHERE receipt_id = ?', 'DELETE FROM receipt_item_purchase WHERE receipt_id = ?', 'DELETE FROM transactions WHERE receipt_id = ?', 'DELETE FROM route_manual_items WHERE receipt_id = ?', "DELETE FROM receipts WHERE receipt_id = ? AND source = 'manual'"]) {
			try {
				removed += db.prepare(sql).run(rid).changes
			} catch {
				/* table may not exist */
			}
		}
		return removed > 0
	})
	return tx()
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

const MANUAL_RECEIPT_ID_FLOOR = -1_000_000_000

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
	const row = db.prepare('SELECT MIN(receipt_id) AS m FROM receipts').get()
	const currentMin = Number.isFinite(row?.m) ? row.m : 0
	return Math.min(currentMin, MANUAL_RECEIPT_ID_FLOOR) - 1
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
	const lines = []
	if (a.name) lines.push(a.name)
	if (a.first_line) lines.push(a.first_line)
	if (a.second_line) lines.push(a.second_line)
	const cityLine = [a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')
	if (cityLine) lines.push(cityLine)
	if (a.country_iso) lines.push(String(a.country_iso).toUpperCase())
	return lines.join('\n')
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
const MANUAL_ORDER_NAME_PLACEHOLDER = 'Manual order'
function _normaliseManualOrder(p, opts = {}) {
	const requireName = opts.requireName !== false
	let name = String(p.name || '').trim()
	if (!name) {
		if (requireName) {
			const e = new Error('Buyer name is required.')
			e.code = 'REQUIRED'
			throw e
		}
		name = MANUAL_ORDER_NAME_PLACEHOLDER
	}

	const items = (Array.isArray(p.items) ? p.items : [])
		.map((it) => ({
			listing_id: it.listing_id != null && String(it.listing_id).trim() !== '' ? Number(it.listing_id) : null,
			title: String(it.title || '').trim(),
			quantity: Math.max(1, parseInt(it.quantity, 10) || 1),
			expected_ship_date: null,
			variations: Array.isArray(it.variations) ? it.variations : [],
		}))
		.filter((it) => it.title)
	if (items.length === 0) {
		const e = new Error('At least one line item with a title is required.')
		e.code = 'REQUIRED'
		throw e
	}

	const countryIso =
		String(p.shipping_country_iso || '')
			.trim()
			.toUpperCase() || null
	const addr = {
		name,
		first_line: String(p.shipping_first_line || '').trim() || null,
		second_line: String(p.shipping_second_line || '').trim() || null,
		city: String(p.shipping_city || '').trim() || null,
		state: String(p.shipping_state || '').trim() || null,
		zip: String(p.shipping_zip || '').trim() || null,
		country_iso: countryIso,
	}

	const grandtotal = p.grandtotal_amount != null && String(p.grandtotal_amount).trim() !== '' ? Number(p.grandtotal_amount) : null

	return {
		name,
		buyer_email: String(p.buyer_email || '').trim() || null,
		shipping_first_line: addr.first_line,
		shipping_second_line: addr.second_line,
		shipping_city: addr.city,
		shipping_state: addr.state,
		shipping_zip: addr.zip,
		shipping_country_iso: addr.country_iso,
		formatted_address: _buildFormattedAddress(addr),
		first_product_title: items[0].title,
		first_listing_id: items[0].listing_id,
		first_quantity: items[0].quantity,
		all_transactions: JSON.stringify(items),
		grandtotal_amount: Number.isFinite(grandtotal) ? grandtotal : null,
		grandtotal_currency:
			String(p.grandtotal_currency || '')
				.trim()
				.toUpperCase() || null,
		message_from_buyer: String(p.message_from_buyer || '').trim() || null,
		team_note: String(p.team_note || '').trim() || null,
	}
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
	let shopId = String(payload.shop_id || '').trim() || MANUAL_SHOP_ID
	let groupId = String(payload.group_id || '').trim()
	if (!groupId) {
		const shopRow = db.prepare('SELECT group_id FROM shops WHERE shop_id = ?').get(shopId)
		groupId = shopRow?.group_id || MANUAL_GROUP_ID
		if (!shopRow) shopId = MANUAL_SHOP_ID // unknown shop → fall back to manual home
	}

	const v = _normaliseManualOrder(payload, { requireName: !!payload.requireName })
	const now = Math.floor(Date.now() / 1000)

	const tx = db.transaction(() => {
		const receiptId = nextManualReceiptId(db)
		db.prepare(
			`
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
    `,
		).run({ ...v, receipt_id: receiptId, shop_id: shopId, group_id: groupId, now })
		return { receipt_id: receiptId }
	})
	return tx()
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
	const rid = Number(receiptId)
	const existing = db.prepare('SELECT source FROM receipts WHERE receipt_id = ?').get(rid)
	if (!existing) {
		const e = new Error('Order not found.')
		e.code = 'NOT_FOUND'
		throw e
	}
	if (existing.source !== 'manual') {
		const e = new Error('Only manual orders can be edited.')
		e.code = 'FORBIDDEN'
		throw e
	}

	const v = _normaliseManualOrder(payload)
	const now = Math.floor(Date.now() / 1000)
	const info = db
		.prepare(
			`
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
  `,
		)
		.run({ ...v, receipt_id: rid, now })
	return info.changes > 0
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
	const rid = Number(receiptId)
	const existing = db.prepare('SELECT source FROM receipts WHERE receipt_id = ?').get(rid)
	// A receipts row that is NOT manual must never be deleted here. (A receipt-less
	// route sidecar — no receipts row at all — is fine to purge.)
	if (existing && existing.source !== 'manual') {
		const e = new Error('Only manual orders can be deleted.')
		e.code = 'FORBIDDEN'
		throw e
	}
	return purgeManualOrder(db, rid)
}

/**
 * Toggle the LOCAL shipped state of a manual order (manual orders are never
 * pushed to Etsy, so "shipped" here is a purely local flag the operator sets
 * — e.g. from the integrated "Ship with 4PX" auto-complete step, which creates
 * the label + tracking and then flips this flag). source must be 'manual'.
 *
 * CRITICAL — why this stamps `shipment_notified_at`:
 * Shipping is DECOUPLED from packaging. Marking an order shipped (a label
 * exists / it is on its way) does NOT mean the operator has physically packed
 * it, so a just-shipped-but-not-yet-packaged parcel MUST stay in the
 * "📦 To pack & ship" queue until it is packaged. That queue
 * (packQueue.readyToPackShipStateSql) only keeps a shipped order when it looks
 * PRE-TRANSIT: is_shipped=1 AND tracking_code IS NOT NULL AND
 * shipment_notified_at IS NOT NULL (recent) AND carrier_confirmed_at IS NULL.
 * If we set is_shipped=1 WITHOUT stamping shipment_notified_at, the order fails
 * the Pre-transit branch AND is caught by the In-transit filter's
 * `shipment_notified_at IS NULL` clause — so it silently vanishes from the pack
 * queue even though it was never packaged. Stamping it here (COALESCE preserves
 * any earlier real timestamp) makes a manual ship behave EXACTLY like the Etsy
 * ship path (shipEtsyReceipt) and the manual add-tracking path
 * (setManualOrderTracking), which both already do this. carrier_confirmed_at /
 * tracking_checked_at are reset so the parcel legitimately re-enters life as
 * Pre-transit until the carrier physically scans it.
 *
 * Un-shipping reverts cleanly to "needs shipping" and CLEARS the shipment
 * timestamps (mirroring setManualOrderTracking's clear path) so a later re-ship
 * gets a fresh Pre-transit window instead of a stale, already-expired one.
 * (tracking_code itself is left intact — it is carrier metadata, not ship state.)
 *
 * @param {Database.Database} db
 * @param {number} receiptId
 * @param {boolean} shipped
 * @returns {boolean} true when updated
 */
function setManualOrderShipped(db, receiptId, shipped) {
	const rid = Number(receiptId)
	const existing = db.prepare('SELECT source FROM receipts WHERE receipt_id = ?').get(rid)
	if (!existing) {
		const e = new Error('Order not found.')
		e.code = 'NOT_FOUND'
		throw e
	}
	if (existing.source !== 'manual') {
		const e = new Error('Only manual orders can be marked shipped locally.')
		e.code = 'FORBIDDEN'
		throw e
	}
	const now = Math.floor(Date.now() / 1000)
	const info = shipped
		? db
				.prepare(
					`
        UPDATE receipts SET
          is_shipped           = 1,
          status               = 'Completed',
          shipment_notified_at = COALESCE(shipment_notified_at, @now),
          carrier_confirmed_at = NULL,
          tracking_checked_at  = NULL
        WHERE receipt_id = @rid AND source = 'manual'
      `,
				)
				.run({ now, rid })
		: db
				.prepare(
					`
        UPDATE receipts SET
          is_shipped           = 0,
          status               = 'Paid',
          shipment_notified_at = NULL,
          carrier_confirmed_at = NULL,
          tracking_checked_at  = NULL
        WHERE receipt_id = @rid AND source = 'manual'
      `,
				)
				.run({ rid })
	return info.changes > 0
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
	const rid = Number(receiptId)
	const existing = db.prepare('SELECT source, tracking_code, carrier_name FROM receipts WHERE receipt_id = ?').get(rid)
	if (!existing) {
		const e = new Error('Order not found.')
		e.code = 'NOT_FOUND'
		throw e
	}
	if (existing.source !== 'manual') {
		const e = new Error('Only manual orders can have a tracking number set this way.')
		e.code = 'FORBIDDEN'
		throw e
	}

	const tracking = normalizeTrackingCode(opts.tracking_code, { allowEmpty: true })
	const carrier = normalizeCarrierName(opts.carrier_name, { fallback: '4PX' })
	const now = Math.floor(Date.now() / 1000)

	// Clearing the tracking number reverts the manual order to "needs shipping".
	if (!tracking) {
		const info = db
			.prepare(
				`
      UPDATE receipts SET
        tracking_code        = NULL,
        carrier_name         = NULL,
        fourpx_tracking_no   = NULL,
        tracking_status      = NULL,
        tracking_last_event  = NULL,
        tracking_last_event_at = NULL,
        tracking_last_location = NULL,
        tracking_delivered_at = NULL,
        tracking_health      = NULL,
        tracking_health_reason = NULL,
        tracking_is_disposed = 0,
        tracking_checked_at  = NULL,
        carrier_confirmed_at = NULL,
        tracking_last_error  = NULL,
        tracking_error_at    = NULL,
        tracking_error_count = 0,
        tracking_next_check_at = NULL,
        shipment_notified_at = NULL,
        is_shipped           = 0,
        status               = 'Paid'
      WHERE receipt_id = ? AND source = 'manual'
    `,
			)
			.run(rid)
		return info.changes > 0
	}

	// Only treat it as a 4PX number (and so light up the 4PX label/route features)
	// when it actually is one — by carrier or by the "4PX…" tracking prefix.
	const is4px = /4px/i.test(carrier) || /^4PX/i.test(tracking)
	if (String(existing.tracking_code || '').trim() === tracking) {
		const info = db
			.prepare(
				`
      UPDATE receipts SET
        carrier_name = @carrier,
        fourpx_tracking_no = @fourpxTracking,
        is_shipped = 1,
        status = 'Completed',
        shipment_notified_at = COALESCE(shipment_notified_at, @now)
      WHERE receipt_id = @rid AND source = 'manual'
    `,
			)
			.run({ carrier, fourpxTracking: is4px ? tracking : null, now, rid })
		return info.changes > 0
	}

	const info = db
		.prepare(
			`
    UPDATE receipts SET
      tracking_code        = @tracking,
      carrier_name         = @carrier,
      fourpx_tracking_no   = @fourpxTracking,
      tracking_status      = NULL,
      tracking_last_event  = NULL,
      tracking_last_event_at = NULL,
      tracking_last_location = NULL,
      tracking_delivered_at = NULL,
      tracking_health      = NULL,
      tracking_health_reason = NULL,
      tracking_is_disposed = 0,
      tracking_checked_at  = NULL,
      carrier_confirmed_at = NULL,
      tracking_last_error  = NULL,
      tracking_error_at    = NULL,
      tracking_error_count = 0,
      tracking_next_check_at = NULL,
      is_shipped           = 1,
      status               = 'Completed',
      shipment_notified_at = COALESCE(shipment_notified_at, @now)
    WHERE receipt_id = @rid AND source = 'manual'
  `,
		)
		.run({ tracking, carrier, fourpxTracking: is4px ? tracking : null, now, rid })
	return info.changes > 0
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
	const info = db
		.prepare(
			`
    INSERT INTO purchase_sync_runs
      (created_at, file_name, updated_orders, updated_lines, became_ready,
       cleared_queue, ready_in_file, orders_in_file, summary_json, payload_json)
    VALUES
      (strftime('%s','now'), @file_name, @updated_orders, @updated_lines, @became_ready,
       @cleared_queue, @ready_in_file, @orders_in_file, @summary_json, @payload_json)
  `,
		)
		.run({
			file_name: file_name || null,
			updated_orders: Number(summary.updated_orders || 0),
			updated_lines: Number(summary.updated_lines || 0),
			became_ready: Number(summary.became_ready || 0),
			cleared_queue: Number(summary.cleared_from_queue || 0),
			ready_in_file: Number(summary.ready_in_file || 0),
			orders_in_file: Number(summary.orders_in_file || 0),
			summary_json: JSON.stringify(summary || {}),
			payload_json: JSON.stringify(payload || {}),
		})
	return Number(info.lastInsertRowid)
}

/**
 * List recent purchase-sync runs (newest first) without the heavy payload blob.
 * @param {Database.Database} db
 * @param {number} [limit=100]
 * @returns {Array<object>}
 */
function listPurchaseSyncRuns(db, limit = 100) {
	try {
		return db
			.prepare(
				`
      SELECT id, created_at, file_name, updated_orders, updated_lines,
             became_ready, cleared_queue, ready_in_file, orders_in_file
      FROM purchase_sync_runs
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `,
			)
			.all(Math.max(1, Math.min(1000, Number(limit) || 100)))
	} catch {
		return []
	}
}

/**
 * Fetch one purchase-sync run with its full stored report payload.
 * @param {Database.Database} db
 * @param {number} id
 * @returns {object|null} the original report object (plus run_id / created_at)
 */
function getPurchaseSyncRun(db, id) {
	try {
		const row = db.prepare('SELECT * FROM purchase_sync_runs WHERE id = ?').get(Number(id))
		if (!row) return null
		let payload = {}
		try {
			payload = JSON.parse(row.payload_json || '{}')
		} catch {
			payload = {}
		}
		payload.run_id = row.id
		payload.generated_at = payload.generated_at || new Date(row.created_at * 1000).toISOString()
		if (!payload.file) payload.file = row.file_name || null
		return payload
	} catch {
		return null
	}
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
	setRouteVerified,
	setItemPurchaseVerified,
	clearRouteVerified,
	clearDismissedByReceipt,
	getRouteAssignment,
	getAllRouteAssignments,
	upsertProductAssignment,
	getProductAssignment,
	getAllProductAssignments,
	replaceSupplierDirectory,
	replaceCharmShopDirectory,
	foldBoothRowsByIdentity,
	preferBoothRow,
	migrateSupplierBoothIdentityDuplicates,
	migrateCharmShopBoothIdentityDuplicates,
	canonizeSupplierBoothReferences,
	canonizeCharmShopBoothReferences,
	replaceProductMap,
	getProductMap,
	mergeProductMapSupplierCharm,
	syncProductMapToAssignments,
	getProductMapRow,
	resolveWrongStallForProduct,
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
	replaceListingVariationImages,
	getListingVariationImageMap,
	listingIdsNeedingVariationRefresh,
	insertManualItem,
	createRouteManualOrder,
	MAX_ROUTE_MANUAL_ITEMS,
	migrateRouteManualItemsSharedReceipt,
	healManualLineKeyAliases,
	getManualItems,
	getManualItemImage,
	deleteManualItemByReceipt,
	deleteManualOrderLine,
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
	getSourcingSuppliers,
	getSourcingSupplierById,
	insertSourcingSupplier,
	updateSourcingSupplier,
	deleteSourcingSupplier,
	getSourcingPackages,
	getSourcingPackageById,
	insertSourcingPackage,
	updateSourcingPackage,
	deleteSourcingPackage,
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
	backfillShippingUpgrades,
	SHIPPING_UPGRADE_COLUMNS,
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
	startTrackingSyncRun,
	updateTrackingSyncRunProgress,
	finishTrackingSyncRun,
	getLatestTrackingSyncRun,
	updateShopSyncTime,
	updateShopListingCount,
	updateShopHealth,
	upsertShopHealthSnapshot,
	snapshotListingMetrics,
	upsertEtsyReview,
	markCatalogHealthSynced,
	markReviewsSynced,
	utcToday,
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
	FOURPX_PICKUP_STATUSES,
	FOURPX_PICKUP_BLOCKING_STATUSES,
	FOURPX_PICKUP_SUBMITTING_STALE_SEC,
	FOURPX_PICKUP_AWAITING_DAYS,
	openFourpxPickupAppointment,
	resolveFourpxPickupAppointment,
	attachFourpxPickupParcels,
	setFourpxPickupFormUrl,
	cancelFourpxPickupAppointment,
	getFourpxPickupAppointment,
	findActiveFourpxPickupAppointment,
	pruneStaleFourpxPickupAppointments,
	listFourpxPickupAppointments,
	listParcelsAwaitingFourpxPickup,
	getFourpxShippingSummary,
	updateTrackingDetail,
	recordTrackingCheckFailure,
	getShipments,
	getShippingStats,
	getShippingAlerts,
	reviewShippingAlerts,
	pruneShippingAlertReviews,
	syncShippingAlertIncidents,
	syncShippingAlertLedger,
	SHIPPING_ALERT_SEVERITY_RANK,
	updateShippingClaim,
	getShippingBuyerNotice,
	recordShippingBuyerNotice,
	clearShippingBuyerNotice,
	MAX_SHIPPING_NOTICE_BODY_LENGTH,
	backfillDisposedTrackingFlags,
	backfillDeliveredTrackingFlags,
	backfillFalseCustomsStuckFlags,
	queueOverdueTrackingRechecks,
	SHIPPING_CLAIM_STATUSES,
	MAX_SHIPPING_CLAIM_NOTE_LENGTH,
	setFourpxBalance,
	getFourpxBalanceStatus,
}
