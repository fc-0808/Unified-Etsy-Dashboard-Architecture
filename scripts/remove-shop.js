'use strict';

/**
 * Shop offboarding tool — permanently remove one or more Etsy shops and their
 * *shop operations* from this dashboard (config.json, tokens.json and SQLite).
 * The product catalog (photos, listing caches, supplier stall rows) is kept
 * by default so Sourcing / the order picker keep working after a suspension.
 *
 * WHY THIS EXISTS
 * ---------------
 * `config.json` is the single source of truth for which shops the dashboard
 * knows about, and on every startup `syncConfigToDb()` prunes shops that were
 * removed from it. That prune is DELIBERATELY conservative: it refuses to delete
 * a shop that still has rows in the database (receipts, ledger, listings, …) so
 * that order history is never lost by an accidental config edit.
 *
 * That safety net is exactly what stands in the way when a shop is GONE FOR GOOD
 * (e.g. Etsy suspended it) and you genuinely want every trace of it erased. This
 * tool is the deliberate, auditable "hard delete" counterpart to that safety net.
 *
 * DESIGN (how a top-tier team ships a destructive data operation)
 * ---------------------------------------------------------------
 *   • Dry-run by default. Nothing is mutated unless you pass --yes. The dry run
 *     prints the exact rows that WOULD be deleted, per table, so the blast radius
 *     is reviewed before anything happens.
 *   • Batch-atomic. One or many shop ids are accepted. Every database delete
 *     runs inside a single transaction — it either all applies or nothing does.
 *     A crash mid-way can never leave a half-deleted shop behind, and a six-shop
 *     suspension is one backup + one rewrite, not six.
 *   • Reversible. Before mutating, it snapshots config.json, tokens.json and the
 *     database to timestamped backups, so a mistake is one copy away from undo.
 *   • Complete for shop operations. It walks the ownership graph — rows keyed
 *     by shop_id, rows reachable through the shop's receipts (line items,
 *     issues, exchanges, route assignments, shipping ledgers, 4PX intents…)
 *     and operational listing rows (inventory quantities), plus name/key-scoped
 *     tables (events, bulk jobs, listing settings, the operations checklist).
 *     A dynamic backstop sweeps any future shop-scoped table so this never
 *     silently goes stale as the schema grows.
 *   • Catalog-preserving by default. Listing photos, perceptual hashes,
 *     embeddings, variation images and "same product" merges stay. Those
 *     listings are remapped to `__catalog_archive__` (no `shops` row) so they
 *     cannot reappear on the Listings tab or be wiped by the next shop sync.
 *     Pass `--purge-catalog` only when the photos themselves must also go.
 *   • Surgical. It keys strictly off the named shops' id/name. Shops that merely
 *     share an Etsy app key (api_key) are untouched — only per-shop data is
 *     removed. Market-supplier tables whose `shop_name` column means a physical
 *     stall (product_map, supplier_directory, charm shops) are never purged by
 *     name, even if a stall happens to share a string with a removed Etsy shop.
 *   • Idempotent. Re-running after a successful removal is a clean no-op.
 *
 * USAGE
 * -----
 *   node scripts/remove-shop.js <shop_id> [shop_id…]     # dry run (review only)
 *   node scripts/remove-shop.js <shop_id> [shop_id…] --yes
 *   npm run shop:remove -- <shop_id>,<shop_id> --yes
 *
 * FLAGS
 *   --yes, --commit     Actually perform the removal (otherwise dry-run).
 *   --keep-catalog      Default. Keep listing photos / hashes / merges; archive listings.
 *   --purge-catalog     Also delete listing photos and the listing rows themselves.
 *   --no-db-backup      Skip the database snapshot (config/tokens are still backed up).
 *   --keep-config       Do not touch config.json.
 *   --keep-tokens       Do not touch tokens.json.
 *   --no-reload         Do not notify a running dashboard to hot-reload afterwards.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const Database = require('better-sqlite3');

const { loadConfig } = require('../src/config/schema');
const { CATALOG_ARCHIVE_SHOP_ID, CATALOG_KEEP_TABLE_SET } = require('../src/shops/catalog-archive');

const CONFIG_PATH = path.resolve(__dirname, '../config.json');
const TOKENS_PATH = path.resolve(__dirname, '../tokens.json');
const MANUAL_SHOP_ID = '__manual__';
const MANUAL_GROUP_ID = '__manual__';

class OffboardError extends Error {
	constructor(message) {
		super(message);
		this.name = 'OffboardError';
	}
}

// ── tiny console helpers ───────────────────────────────────────────────────
const c = {
	dim: (s) => `\x1b[2m${s}\x1b[0m`,
	bold: (s) => `\x1b[1m${s}\x1b[0m`,
	red: (s) => `\x1b[31m${s}\x1b[0m`,
	green: (s) => `\x1b[32m${s}\x1b[0m`,
	yellow: (s) => `\x1b[33m${s}\x1b[0m`,
	cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

function fail(msg) {
	throw new OffboardError(msg);
}

function parseArgs(argv) {
	const flags = new Set();
	const positional = [];
	for (const a of argv) {
		if (a.startsWith('--')) flags.add(a);
		else positional.push(...String(a).split(',').map((s) => s.trim()).filter(Boolean));
	}
	return { shopIds: [...new Set(positional)], flags };
}

function tsStamp() {
	return new Date().toISOString().replace(/[:.]/g, '-');
}

function quoteIdent(name) {
	return `"${String(name).replace(/"/g, '""')}"`;
}

function tableExists(db, name) {
	return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`).get(name);
}

function placeholders(prefix, count) {
	return Array.from({ length: count }, (_, i) => `@${prefix}${i}`).join(', ');
}

function bindList(prefix, values) {
	const params = {};
	values.forEach((v, i) => { params[`${prefix}${i}`] = v; });
	return params;
}

/** Back up a text file to "<file>.bak-<ts>" and return the backup path. */
function backupTextFile(filePath) {
	if (!fs.existsSync(filePath)) return null;
	const dest = `${filePath}.bak-${tsStamp()}`;
	fs.copyFileSync(filePath, dest);
	return dest;
}

/**
 * Tables whose `shop_name` (or similar) column is a MARKET stall / catalog
 * vendor, not an Etsy shop. Purging them by the removed Etsy shop's name would
 * delete unrelated supplier data if a stall string ever collided.
 */
const NEVER_PURGE_TABLES = new Set([
	'supplier_directory',
	'product_map',
	'product_map_title_aliases',
	'charm_shop_directory',
	'charm_library',
	'charm_shops',
	'charm_purchase_progress',
	'sourcing_suppliers',
	'sourcing_packages',
	'audit_log',
	'users',
	'app_locks',
	'fourpx_balance',
	'fourpx_pickup_appointments',
	'goods_float_months',
	'goods_float_revisions',
	'goods_float_screenshots',
	'goods_float_transfers',
	'goods_float_transfer_screenshots',
]);

/**
 * Ordered delete plan. Children first, parents last, so foreign-key-style
 * subqueries (receipts / listings / bulk_jobs / growth imports) still resolve
 * while running.
 *
 * Each step: { table, where }. `where` may reference @idN (shop ids) and @nmN
 * (name/key identifiers).
 *
 * @param {string[]} ids
 * @param {string[]} names
 */
function buildPlan(ids, names) {
	if (!ids.length) throw new OffboardError('buildPlan requires at least one shop id.');
	const nameIds = names.length ? names : ids;
	const idList = placeholders('id', ids.length);
	const nameList = placeholders('nm', nameIds.length);
	const params = { ...bindList('id', ids), ...bindList('nm', nameIds) };

	const receiptSub = `receipt_id IN (SELECT receipt_id FROM receipts WHERE shop_id IN (${idList}))`;
	const listingSub = `listing_id IN (SELECT listing_id FROM listings WHERE shop_id IN (${idList}))`;
	const bulkJobSub = `job_id IN (SELECT job_id FROM bulk_jobs WHERE shop_key IN (${nameList}) OR shop_name IN (${nameList}))`;
	const growthImportSub = `import_id IN (SELECT id FROM growth_manual_listing_imports WHERE shop_id IN (${idList}))`;

	const steps = [
		// Rows reachable through the shop's RECEIPTS (order line-item workflow).
		{ table: 'route_assignments', where: receiptSub },
		{ table: 'receipt_item_purchase', where: receiptSub },
		{ table: 'order_issues', where: receiptSub },
		{ table: 'order_exchanges', where: receiptSub },
		{ table: 'order_line_substitutions', where: receiptSub },
		{ table: 'order_address_review_events', where: receiptSub },
		{ table: 'shipping_buyer_notices', where: receiptSub },
		{ table: 'shipping_alert_reviews', where: receiptSub },
		{ table: 'shipping_alert_incidents', where: receiptSub },
		{ table: 'shipping_compensation_cases', where: receiptSub },
		{ table: 'etsy_completion_intents', where: receiptSub },
		{ table: 'fourpx_pickup_appointment_orders', where: receiptSub },

		// Rows reachable through the shop's LISTINGS (inventory + image caches).
		{ table: 'listing_inventory', where: listingSub },
		{ table: 'listing_images', where: listingSub },
		{ table: 'listing_image_data', where: listingSub },
		{ table: 'listing_phash', where: listingSub },
		{ table: 'listing_vemb', where: listingSub },
		{ table: 'listing_style_images', where: listingSub },
		{ table: 'listing_variation_images', where: listingSub },
		{ table: 'listing_variation_image_state', where: listingSub },
		{ table: 'product_merges', where: `listing_a IN (SELECT listing_id FROM listings WHERE shop_id IN (${idList})) OR listing_b IN (SELECT listing_id FROM listings WHERE shop_id IN (${idList}))` },

		// Bulk-create job items (reachable through bulk_jobs).
		{ table: 'bulk_job_items', where: bulkJobSub },

		// Growth listing-import children before their parent import rows.
		{ table: 'growth_manual_listing_rows', where: growthImportSub },

		// Rows keyed directly by shop_id.
		{ table: 'transactions', where: `shop_id IN (${idList})` },
		{ table: 'etsy_payments', where: `shop_id IN (${idList})` },
		{ table: 'ledger_entries', where: `shop_id IN (${idList})` },
		{ table: 'sync_log', where: `shop_id IN (${idList})` },
		{ table: 'listing_metric_snapshots', where: `shop_id IN (${idList})` },
		{ table: 'shop_health_snapshots', where: `shop_id IN (${idList})` },
		{ table: 'etsy_reviews', where: `shop_id IN (${idList})` },
		{ table: 'growth_manual_comparisons', where: `shop_id IN (${idList})` },
		{ table: 'growth_manual_listing_imports', where: `shop_id IN (${idList})` },
		{ table: 'catalog_rollout_items', where: `shop_id IN (${idList}) OR shop_name IN (${nameList})` },
		{ table: 'receipts', where: `shop_id IN (${idList})` },
		{ table: 'listings', where: `shop_id IN (${idList})` },

		// Name / key scoped tables.
		{ table: 'events', where: `shop_name IN (${nameList})` },
		{ table: 'route_manual_items', where: `shop_name IN (${nameList})` },
		{ table: 'shop_listing_settings', where: `shop_key IN (${nameList})` },
		{ table: 'bulk_jobs', where: `shop_key IN (${nameList}) OR shop_name IN (${nameList})` },
		{ table: 'operations_checklist_completions', where: `subject_type = 'shop' AND (subject_id IN (${idList}) OR subject_label IN (${nameList}))` },
	];

	return { steps, params };
}

/** Tables managed explicitly above — excluded from the dynamic backstop. */
const EXPLICIT_TABLES = new Set([
	'route_assignments', 'receipt_item_purchase', 'order_issues', 'order_exchanges',
	'order_line_substitutions', 'order_address_review_events', 'shipping_buyer_notices',
	'shipping_alert_reviews', 'shipping_alert_incidents', 'shipping_compensation_cases',
	'etsy_completion_intents', 'fourpx_pickup_appointment_orders',
	'listing_inventory', 'listing_images', 'listing_image_data',
	'listing_phash', 'listing_vemb', 'listing_style_images', 'listing_variation_images',
	'listing_variation_image_state', 'product_merges', 'bulk_job_items',
	'growth_manual_listing_rows', 'transactions', 'etsy_payments',
	'ledger_entries', 'sync_log', 'listing_metric_snapshots', 'shop_health_snapshots',
	'etsy_reviews', 'growth_manual_comparisons', 'growth_manual_listing_imports',
	'catalog_rollout_items', 'receipts', 'listings', 'events', 'route_manual_items',
	'shop_listing_settings', 'bulk_jobs', 'operations_checklist_completions',
	'shops', 'groups',
]);

const SHOP_LINK_COLUMNS = ['shop_id', 'shop_name', 'shop_key'];

/**
 * Discover any OTHER table carrying a shop-scoped column, so a shop-owned table
 * added to the schema in the future is still purged without editing this script.
 * Returns extra plan steps. Market-supplier tables are skipped on purpose.
 */
function backstopSteps(db, ids, names) {
	const nameIds = names.length ? names : ids;
	const idList = placeholders('id', ids.length);
	const nameList = placeholders('nm', nameIds.length);
	const tables = db
		.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
		.all()
		.map((r) => r.name)
		.filter((name) => !EXPLICIT_TABLES.has(name) && !NEVER_PURGE_TABLES.has(name));

	const steps = [];
	for (const table of tables) {
		const cols = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all().map((col) => col.name);
		const clauses = [];
		if (cols.includes('shop_id')) clauses.push(`shop_id IN (${idList})`);
		if (cols.includes('shop_name')) clauses.push(`shop_name IN (${nameList})`);
		if (cols.includes('shop_key')) clauses.push(`shop_key IN (${nameList})`);
		if (clauses.length) steps.push({ table, where: clauses.join(' OR '), backstop: true });
	}
	return steps;
}

function collectSteps(db, ids, names, options = {}) {
	const keepCatalog = options.keepCatalog !== false;
	const { steps: coreSteps, params } = buildPlan(ids, names);
	const extraSteps = backstopSteps(db, ids, names);
	let steps = [...coreSteps, ...extraSteps];
	if (keepCatalog) {
		steps = steps.filter((step) => !CATALOG_KEEP_TABLE_SET.has(step.table));
	}
	return { steps, params, keepCatalog };
}

function countCatalogKeep(db, ids, params) {
	const idList = placeholders('id', ids.length);
	const listingSub = `listing_id IN (SELECT listing_id FROM listings WHERE shop_id IN (${idList}))`;
	const rows = [];
	if (tableExists(db, 'listings')) {
		const n = db.prepare(`SELECT COUNT(*) AS n FROM listings WHERE shop_id IN (${idList})`).get(params).n;
		if (n) rows.push(['listings', n]);
	}
	for (const table of ['listing_images', 'listing_image_data', 'listing_phash', 'listing_vemb',
		'listing_style_images', 'listing_variation_images', 'listing_variation_image_state']) {
		if (!tableExists(db, table)) continue;
		const n = db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)} WHERE ${listingSub}`).get(params).n;
		if (n) rows.push([table, n]);
	}
	if (tableExists(db, 'product_merges')) {
		const n = db.prepare(`
			SELECT COUNT(*) AS n FROM product_merges
			WHERE listing_a IN (SELECT listing_id FROM listings WHERE shop_id IN (${idList}))
			   OR listing_b IN (SELECT listing_id FROM listings WHERE shop_id IN (${idList}))
		`).get(params).n;
		if (n) rows.push(['product_merges', n]);
	}
	return rows;
}

function archiveShopListings(db, ids, params) {
	if (!tableExists(db, 'listings')) return 0;
	const idList = placeholders('id', ids.length);
	const res = db.prepare(`
		UPDATE listings
		   SET shop_id = @archiveShop
		 WHERE shop_id IN (${idList})
		   AND shop_id <> @manualShop
		   AND shop_id <> @archiveShop
	`).run({
		...params,
		archiveShop: CATALOG_ARCHIVE_SHOP_ID,
		manualShop: MANUAL_SHOP_ID,
	});
	return res.changes;
}

function countStep(db, step, params) {
	if (!tableExists(db, step.table)) return 0;
	return db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(step.table)} WHERE ${step.where}`).get(params).n;
}

/**
 * Rewrite catalog_rollout_jobs.shop_names (a JSON array of Etsy shop names) so a
 * multi-shop job that still has remaining shops keeps those shops, while a job
 * that only targeted removed shops is deleted.
 */
function rewriteCatalogRolloutJobs(db, names) {
	if (!tableExists(db, 'catalog_rollout_jobs')) return { updated: 0, deleted: 0 };
	const removed = new Set(names.map(String));
	const jobs = db.prepare('SELECT job_id, shop_names FROM catalog_rollout_jobs').all();
	let updated = 0;
	let deleted = 0;
	for (const job of jobs) {
		let parsed;
		try { parsed = JSON.parse(job.shop_names || '[]'); } catch { continue; }
		if (!Array.isArray(parsed) || parsed.length === 0) continue;
		const next = parsed.filter((n) => !removed.has(String(n)));
		if (next.length === parsed.length) continue;
		if (next.length === 0) {
			if (tableExists(db, 'catalog_rollout_items')) {
				db.prepare('DELETE FROM catalog_rollout_items WHERE job_id = ?').run(job.job_id);
			}
			db.prepare('DELETE FROM catalog_rollout_jobs WHERE job_id = ?').run(job.job_id);
			deleted += 1;
		} else {
			db.prepare('UPDATE catalog_rollout_jobs SET shop_names = ? WHERE job_id = ?').run(JSON.stringify(next), job.job_id);
			updated += 1;
		}
	}
	return { updated, deleted };
}

/**
 * Delete every shop-owned row for the given ids/names inside a transaction.
 * @returns {Record<string, number>} table → rows deleted
 */
function applyDatabasePurge(db, ids, names, options = {}) {
	const keepCatalog = options.keepCatalog !== false;
	const { steps, params } = collectSteps(db, ids, names, { keepCatalog });
	const deleted = {};
	let archivedListings = 0;
	const purge = db.transaction(() => {
		for (const step of steps) {
			if (!tableExists(db, step.table)) continue;
			const res = db.prepare(`DELETE FROM ${quoteIdent(step.table)} WHERE ${step.where}`).run(params);
			if (res.changes > 0) deleted[step.table] = (deleted[step.table] || 0) + res.changes;
		}

		const rollout = rewriteCatalogRolloutJobs(db, names);
		if (rollout.deleted > 0) deleted['catalog_rollout_jobs'] = (deleted['catalog_rollout_jobs'] || 0) + rollout.deleted;

		if (keepCatalog) {
			archivedListings = archiveShopListings(db, ids, params);
		}

		const ownedGroups = db.prepare(`
			SELECT DISTINCT group_id FROM shops
			WHERE shop_id IN (${placeholders('id', ids.length)})
			  AND group_id <> @manualGroup
		`).all({ ...params, manualGroup: MANUAL_GROUP_ID });

		const shopRes = db.prepare(`DELETE FROM shops WHERE shop_id IN (${placeholders('id', ids.length)})`).run(params);
		if (shopRes.changes > 0) deleted['shops'] = shopRes.changes;

		for (const row of ownedGroups) {
			if (!row.group_id || row.group_id === MANUAL_GROUP_ID) continue;
			const remaining = db.prepare('SELECT COUNT(*) AS n FROM shops WHERE group_id = ?').get(row.group_id).n;
			if (remaining !== 0) continue;
			const gRes = db.prepare('DELETE FROM groups WHERE group_id = ?').run(row.group_id);
			if (gRes.changes > 0) deleted['groups'] = (deleted['groups'] || 0) + gRes.changes;
		}
	});
	purge();
	if (keepCatalog && archivedListings) deleted.listings_archived = archivedListings;
	return deleted;
}

/**
 * Rewrite config.json with the shops removed. Empty groups are pruned.
 * Preserves the file's 2-space JSON style.
 * @returns {{ groupPruned: string[] }}
 */
function removeShopsFromConfigFile(configPath, shopIds) {
	const remove = new Set(shopIds);
	const raw = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
	const groupPruned = [];
	for (const g of raw.groups || []) {
		const before = (g.shops || []).length;
		g.shops = (g.shops || []).filter((s) => !remove.has(s.shop_id));
		if (g.shops.length !== before && g.shops.length === 0) groupPruned.push(g.group_id);
	}
	if (groupPruned.length) raw.groups = (raw.groups || []).filter((g) => (g.shops || []).length > 0);
	fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf8');
	return { groupPruned };
}

/** Remove shops' entries from tokens.json (2-space JSON style). */
function removeShopsFromTokensFile(tokensPath, shopIds) {
	const store = JSON.parse(fs.readFileSync(tokensPath, 'utf8') || '{}');
	let removed = 0;
	for (const id of shopIds) {
		if (Object.prototype.hasOwnProperty.call(store, id)) {
			delete store[id];
			removed += 1;
		}
	}
	fs.writeFileSync(tokensPath, JSON.stringify(store, null, 2), 'utf8');
	return removed;
}

/** True when removing shopId empties its config group. */
function groupWouldEmpty(group, remainingIds) {
	if (!group) return false;
	const drop = new Set(remainingIds);
	return (group.shops || []).filter((s) => !drop.has(s.shop_id)).length === 0;
}

/** Best-effort POST /api/admin/reload-tokens to a locally running dashboard.
 *  @returns {Promise<'ok'|'auth'|'down'>}
 */
function notifyReload() {
	const port = Number(process.env.PORT) || 4000;
	return new Promise((resolve) => {
		const req = http.request(
			{ hostname: 'localhost', port, path: '/api/admin/reload-tokens', method: 'POST', timeout: 3000 },
			(res) => {
				res.resume();
				if (res.statusCode >= 200 && res.statusCode < 300) return resolve('ok');
				if (res.statusCode === 401 || res.statusCode === 403) return resolve('auth');
				resolve('down');
			}
		);
		req.on('error', () => resolve('down'));
		req.on('timeout', () => { req.destroy(); resolve('down'); });
		req.end();
	});
}

function readTokensShopIds(tokensPath) {
	if (!fs.existsSync(tokensPath)) return new Set();
	try {
		const store = JSON.parse(fs.readFileSync(tokensPath, 'utf8') || '{}');
		return new Set(Object.keys(store));
	} catch {
		return new Set();
	}
}

function resolveTargets(config, db, tokenIds, shopIds) {
	const byId = new Map();
	for (const g of config.groups || []) {
		for (const s of g.shops || []) {
			byId.set(s.shop_id, { group: g, shop: s });
		}
	}

	const targets = [];
	const missing = [];
	for (const shopId of shopIds) {
		if (shopId === MANUAL_SHOP_ID) {
			fail(`Refusing to remove the synthetic Manual Orders shop (${MANUAL_SHOP_ID}).`);
		}
		const found = byId.get(shopId) || { group: null, shop: null };
		const dbShop = db.prepare('SELECT shop_id, shop_name, group_id FROM shops WHERE shop_id = ?').get(shopId);
		const inTokens = tokenIds.has(shopId);
		if (!found.shop && !dbShop && !inTokens) {
			missing.push(shopId);
			continue;
		}
		targets.push({
			shopId,
			shop: found.shop,
			group: found.group,
			dbShop,
			inTokens,
			shopName: found.shop?.shop_name || dbShop?.shop_name || shopId,
			groupId: found.group?.group_id || dbShop?.group_id || null,
		});
	}
	return { targets, missing };
}

async function main() {
	const { shopIds, flags } = parseArgs(process.argv.slice(2));
	const commit = flags.has('--yes') || flags.has('--commit');
	const doDbBackup = !flags.has('--no-db-backup');
	const touchConfig = !flags.has('--keep-config');
	const touchTokens = !flags.has('--keep-tokens');
	const doReload = !flags.has('--no-reload');
	if (flags.has('--purge-catalog') && flags.has('--keep-catalog')) {
		fail('Pass either --keep-catalog (default) or --purge-catalog, not both.');
	}
	const keepCatalog = !flags.has('--purge-catalog');

	if (!shopIds.length) {
		fail('Usage: node scripts/remove-shop.js <shop_id> [shop_id…] [--yes] [--purge-catalog] [--no-db-backup] [--keep-config] [--keep-tokens] [--no-reload]');
	}
	if (shopIds.includes(CATALOG_ARCHIVE_SHOP_ID)) {
		fail(`Refusing to remove the catalog archive shop (${CATALOG_ARCHIVE_SHOP_ID}).`);
	}

	const config = loadConfig();
	const dbPath = config.db_path;
	if (!fs.existsSync(dbPath)) fail(`Database not found at ${dbPath}.`);

	const tokenIds = readTokensShopIds(TOKENS_PATH);
	const roDb = new Database(dbPath, { readonly: true });
	const { targets, missing } = resolveTargets(config, roDb, tokenIds, shopIds);

	if (!targets.length) {
		roDb.close();
		if (missing.length) {
			console.log(`\n  ${c.green('✓')} ${missing.map((id) => c.bold(id)).join(', ')} already absent from config.json, tokens.json and the database. Nothing to do.\n`);
		}
		return;
	}

	const ids = targets.map((t) => t.shopId);
	const names = [...new Set(targets.flatMap((t) => [t.shopId, t.shopName]))];
	const { steps, params } = collectSteps(roDb, ids, names, { keepCatalog });

	console.log('');
	console.log(`  ${c.bold('Etsy shop offboarding')} ${commit ? c.red('· LIVE RUN') : c.yellow('· DRY RUN (no changes)')}`);
	console.log(`  ${c.dim('─'.repeat(62))}`);
	console.log(`  Catalog     : ${keepCatalog ? c.green('kept (listings archived, photos stay)') : c.red('purged with the shop')}`);
	for (const t of targets) {
		console.log(`  Shop id     : ${c.bold(t.shopId)}`);
		console.log(`  Shop name   : ${t.shopName}`);
		console.log(`  Group       : ${t.groupId ?? c.dim('(not in config)')}`);
		console.log(`  In config   : ${t.shop ? c.green('yes') : c.dim('no')}`);
		console.log(`  In tokens   : ${t.inTokens ? c.green('yes') : c.dim('no')}`);
		console.log(`  In database : ${t.dbShop ? c.green('yes') : c.dim('no')}`);
		if (t.shop) {
			const masked = `${String(t.shop.api_key || '').slice(0, 6)}…`;
			const sharers = (t.group.shops || [])
				.filter((s) => !ids.includes(s.shop_id) && s.api_key === t.shop.api_key)
				.map((s) => s.shop_id);
			console.log(`  App key     : ${masked} ${sharers.length ? c.yellow(`(shared with ${sharers.join(', ')} — those shops are NOT affected)`) : ''}`);
		}
		console.log('');
	}
	if (missing.length) {
		console.log(`  ${c.dim('Already absent:')} ${missing.join(', ')}`);
		console.log('');
	}

	let total = 0;
	const nonZero = [];
	for (const step of steps) {
		const n = countStep(roDb, step, params);
		if (n > 0) {
			nonZero.push([step.table, n, step.backstop]);
			total += n;
		}
	}
	if (keepCatalog) {
		const kept = countCatalogKeep(roDb, ids, params);
		if (kept.length) {
			console.log(`  ${c.bold('Product catalog (kept):')}`);
			for (const [table, n] of kept) {
				const note = table === 'listings' ? c.dim(`  → ${CATALOG_ARCHIVE_SHOP_ID}`) : '';
				console.log(`    ${table.padEnd(34)} ${String(n).padStart(6)}${note}`);
			}
			console.log('');
		}
	}
	console.log(`  ${c.bold(keepCatalog ? 'Shop operations (deleted):' : 'Rows deleted:')}`);
	if (nonZero.length === 0) {
		console.log(`    ${c.dim('(no data rows found)')}`);
	} else {
		for (const [table, n, isBackstop] of nonZero) {
			const tag = isBackstop ? c.yellow(' [dynamic]') : '';
			console.log(`    ${table.padEnd(34)} ${String(n).padStart(6)}${tag}`);
		}
	}
	console.log(`    ${c.dim('─'.repeat(42))}`);
	console.log(`    ${'TOTAL'.padEnd(34)} ${String(total).padStart(6)} row(s), plus ${ids.length} shop row(s)`);
	roDb.close();

	const configHits = targets.filter((t) => t.shop);
	const tokenHits = targets.filter((t) => t.inTokens);
	const groupsEmptied = [...new Set(
		configHits.filter((t) => groupWouldEmpty(t.group, ids)).map((t) => t.groupId).filter(Boolean),
	)];

	console.log('');
	console.log(`  ${c.bold('Files:')}`);
	console.log(`    config.json  : ${touchConfig && configHits.length ? c.red(`remove ${configHits.length} shop ${configHits.length === 1 ? 'entry' : 'entries'}`) + (groupsEmptied.length ? c.red(` + prune empty group(s) ${groupsEmptied.join(', ')}`) : '') : c.dim('unchanged')}`);
	console.log(`    tokens.json  : ${touchTokens && tokenHits.length ? c.red(`remove ${tokenHits.length} token ${tokenHits.length === 1 ? 'entry' : 'entries'}`) : c.dim('unchanged')}`);
	console.log('');

	if (!commit) {
		console.log(`  ${c.yellow('DRY RUN')} — nothing was changed.`);
		console.log(`  Re-run with ${c.bold('--yes')} to perform the removal.\n`);
		return;
	}

	console.log(`  ${c.bold('Creating backups…')}`);
	if (doDbBackup) {
		const backupDir = path.join(path.dirname(dbPath), 'backups');
		fs.mkdirSync(backupDir, { recursive: true });
		const label = ids.length === 1 ? ids[0] : `batch-${ids.length}`;
		const dbBackup = path.join(backupDir, `etsy_dashboard.pre-remove-${label}-${tsStamp()}.db`);
		const bkDb = new Database(dbPath, { readonly: true });
		await bkDb.backup(dbBackup);
		bkDb.close();
		console.log(`    database : ${c.dim(dbBackup)}`);
	} else {
		console.log(`    database : ${c.yellow('skipped (--no-db-backup)')}`);
	}
	if (touchConfig && configHits.length) {
		const b = backupTextFile(CONFIG_PATH);
		if (b) console.log(`    config   : ${c.dim(b)}`);
	}
	if (touchTokens && tokenHits.length) {
		const b = backupTextFile(TOKENS_PATH);
		if (b) console.log(`    tokens   : ${c.dim(b)}`);
	}

	console.log(`\n  ${c.bold('Purging database…')}`);
	const db = new Database(dbPath);
	db.pragma('busy_timeout = 60000');
	db.pragma('foreign_keys = ON');
	const deleted = applyDatabasePurge(db, ids, names, { keepCatalog });
	try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* file DBs only */ }
	db.close();

	const deletedTables = Object.keys(deleted).filter((t) => t !== 'listings_archived');
	if (deletedTables.length === 0) {
		console.log(`    ${c.dim('(no operational rows were present)')}`);
	} else {
		for (const t of deletedTables) {
			console.log(`    ${c.green('✓')} ${t.padEnd(34)} ${String(deleted[t]).padStart(6)} deleted`);
		}
	}
	if (deleted.listings_archived) {
		console.log(`    ${c.green('✓')} ${'listings'.padEnd(34)} ${String(deleted.listings_archived).padStart(6)} archived → ${CATALOG_ARCHIVE_SHOP_ID}`);
	}

	if (touchConfig && configHits.length) {
		const rewritten = removeShopsFromConfigFile(CONFIG_PATH, ids);
		const pruned = rewritten.groupPruned.length
			? ` and pruned empty group(s) ${rewritten.groupPruned.map((g) => `"${g}"`).join(', ')}`
			: '';
		console.log(`\n  ${c.green('✓')} config.json — removed ${c.bold(ids.join(', '))}${pruned}.`);
	}

	if (touchTokens && tokenHits.length) {
		removeShopsFromTokensFile(TOKENS_PATH, ids);
		console.log(`  ${c.green('✓')} tokens.json — removed OAuth tokens for ${c.bold(tokenHits.map((t) => t.shopId).join(', '))}.`);
	}

	if (doReload) {
		const reloaded = await notifyReload();
		if (reloaded === 'ok') {
			console.log(`  ${c.green('✓')} Notified the running dashboard — it dropped the shop(s) live (no restart needed).`);
		} else if (reloaded === 'auth') {
			console.log(`  ${c.yellow('!')} Dashboard is running but reload-tokens requires a signed-in owner session.`);
			console.log(`    ${c.dim('Restart the dashboard (or reload from Shops & Sync) so it drops the removed shops from memory.')}`);
		} else {
			console.log(`  ${c.dim('•')} No running dashboard detected on the configured port — it will pick up the change on next start.`);
		}
	}

	console.log(`\n  ${c.green(c.bold('Done.'))} Removed shop operations for ${c.bold(ids.join(', '))}${keepCatalog ? '; product catalog kept.' : '.'}\n`);
}

module.exports = {
	OffboardError,
	MANUAL_SHOP_ID,
	CATALOG_ARCHIVE_SHOP_ID,
	NEVER_PURGE_TABLES,
	EXPLICIT_TABLES,
	SHOP_LINK_COLUMNS,
	parseArgs,
	buildPlan,
	backstopSteps,
	collectSteps,
	countStep,
	countCatalogKeep,
	tableExists,
	rewriteCatalogRolloutJobs,
	applyDatabasePurge,
	archiveShopListings,
	removeShopsFromConfigFile,
	removeShopsFromTokensFile,
	groupWouldEmpty,
};

if (require.main === module) {
	main().catch((err) => {
		if (err instanceof OffboardError) {
			console.error(`\n  ${c.red('✗')} ${err.message}\n`);
			process.exit(1);
		}
		console.error(`\n  ${c.red('Unexpected error:')} ${err.stack || err.message}\n`);
		process.exit(1);
	});
}
