'use strict';

/**
 * Catalog-only restore — bring back product photos / listing caches / supplier
 * stall names from a pre-offboard SQLite snapshot WITHOUT undeleting the shops.
 *
 * WHY THIS EXISTS
 * ---------------
 * Shop offboarding (`scripts/remove-shop.js`) now keeps the product corpus by
 * default (listings remapped to `__catalog_archive__`, photos/hashes/merges
 * stay). Pass `--purge-catalog` only when those rows must also go. This restore
 * is the counterpart for backups taken before that default, or after a purge:
 * it copies photos, titles, variation images and "same product" merges without
 * undeleting the shop. The market catalog (`product_map.shop_name` = a physical
 * stall, not an Etsy shop) is never treated as shop operations.
 *
 * Restoring `shops`, receipts, tokens, ledger, sync, inventory or growth
 * snapshots would silently undelete the suspended shops. This tool refuses.
 *
 * DESIGN
 * ------
 *   • Dry-run by default. `--yes` is required to write.
 *   • Source is ATTACH'd read-only. Destination writes run in one IMMEDIATE
 *     transaction — crash-safe, never a half-restored catalog.
 *   • Column intersection. Backup and live schemas may drift; only columns
 *     present in BOTH are copied. Live-only columns keep their defaults.
 *   • Collision policy. Etsy listing ids are globally unique, so a live row
 *     with the same id belonging to a *remaining* shop is left untouched
 *     (row + children). A previous catalog restore (same archived shop_id)
 *     is idempotent: missing child rows are filled, existing rows are kept.
 *   • Listings are restored with their original `shop_id` as provenance.
 *     There is no FK from listings → shops, and operational surfaces JOIN
 *     `shops`, so the archived shops do not reappear in the Listings / Growth
 *     UIs. Catalog image resolution and find-by-photo read listings directly
 *     and therefore see the recovered photos.
 *   • `product_map` is never wholesale-replaced. Empty supplier / cost /
 *     identity fields on rows that belong to recovered listing titles are
 *     filled from the backup; non-empty live values win. Missing rows for
 *     those titles are inserted. Aliases are remapped by title_norm so
 *     AUTOINCREMENT ids never leak across databases.
 *   • Default source: the `pre-remove-batch-6-*.db` snapshot. `--all-history`
 *     walks every etsy_dashboard backup (older shop offboards included) and
 *     then PROMOTES every recovered listing into `product_map`, because the
 *     Product Catalog / Sourcing picker only shows product_map rows that have
 *     a photo. Restored listings without a catalog row stay invisible.
 *   • Live-shop listing ids that were later pruned from Etsy are restored
 *     under `__catalog_archive__` so they cannot reappear on the Listings tab
 *     or be wiped by the next shop sync.
 *
 * USAGE
 * -----
 *   node scripts/restore-shop-catalog.js
 *   node scripts/restore-shop-catalog.js --all-history --yes
 *   node scripts/restore-shop-catalog.js CuteiPhoneCasesFInds --from D:\backup.db --yes
 *
 * FLAGS
 *   --yes, --commit     Apply the restore (otherwise dry-run).
 *   --all-history       Every backup + every shop + promote listings to catalog.
 *   --promote-only      Only write missing product_map rows / title aliases.
 *   --from <path>       Backup SQLite to read from (ignored with --all-history).
 *   --db <path>         Destination database (defaults to config.json db_path).
 *   --no-db-backup      Skip snapshotting the live database before writing.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const { loadConfig } = require('../src/config/schema');
const { CATALOG_ARCHIVE_SHOP_ID } = require('../src/shops/catalog-archive');

class RestoreError extends Error {
	constructor(message) {
		super(message);
		this.name = 'RestoreError';
	}
}

const c = {
	dim: (s) => `\x1b[2m${s}\x1b[0m`,
	bold: (s) => `\x1b[1m${s}\x1b[0m`,
	red: (s) => `\x1b[31m${s}\x1b[0m`,
	green: (s) => `\x1b[32m${s}\x1b[0m`,
	yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

function fail(msg) {
	throw new RestoreError(msg);
}

/** Etsy shop_ids whose product catalog this tool recovers by default. */
const DEFAULT_ARCHIVED_SHOP_IDS = Object.freeze([
	'Y2KASEofficial',
	'LUVKASEofficial',
	'Y2KASEshop',
	'KawaiiiPhoneCases',
	'CuteiPhoneCasesFinds',
	'CuteiPhoneCasesGoods',
	'Y2KASEowo',
	'Y2KASEstore',
	'CuteCasesOnly',
	'iPhoneCutestStuff',
]);

const MANUAL_SHOP_ID = '__manual__';

/**
 * Tables that are shop operations, not product catalog. Restoring any of these
 * would undelete a suspended shop. The copier never writes them; tests pin it.
 */
const NEVER_RESTORE_TABLES = Object.freeze(new Set([
	'shops',
	'groups',
	'receipts',
	'transactions',
	'ledger_entries',
	'etsy_payments',
	'sync_log',
	'events',
	'listing_inventory',
	'listing_metric_snapshots',
	'shop_health_snapshots',
	'etsy_reviews',
	'bulk_jobs',
	'bulk_job_items',
	'catalog_rollout_jobs',
	'catalog_rollout_items',
	'operations_checklist_completions',
	'shop_listing_settings',
	'route_assignments',
	'route_manual_items',
	'receipt_item_purchase',
	'order_issues',
	'order_exchanges',
	'growth_manual_comparisons',
	'growth_manual_listing_imports',
	'growth_manual_listing_rows',
]));

/**
 * Listing-scoped catalog tables copied from the backup. `listings` itself is
 * the parent and is copied first. `id` on style images is omitted so the live
 * AUTOINCREMENT assigns fresh keys.
 */
const LISTING_COPY_TABLES = Object.freeze([
	{ table: 'listings', skipColumns: [] },
	{ table: 'listing_images', skipColumns: [] },
	{ table: 'listing_image_data', skipColumns: [] },
	{ table: 'listing_phash', skipColumns: [] },
	{ table: 'listing_vemb', skipColumns: [] },
	{ table: 'listing_style_images', skipColumns: ['id'] },
	{ table: 'listing_variation_images', skipColumns: [] },
	{ table: 'listing_variation_image_state', skipColumns: [] },
]);

const PRODUCT_MAP_FILL_TEXT = Object.freeze([
	'shop_name',
	'stall',
	'charm_shop',
	'charm_code',
	'canonical_product_key',
	'product_type',
]);
const PRODUCT_MAP_FILL_NUM = Object.freeze(['cost_case', 'cost_grip']);

const BATCH6_BACKUP_RE = /^etsy_dashboard\.pre-remove-batch-6-.*\.db$/i;

function parseArgs(argv) {
	const flags = new Set();
	const positional = [];
	let from = null;
	let dbPath = null;
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		if (a === '--from' || a === '--db') {
			const val = argv[i + 1];
			if (!val || String(val).startsWith('--')) fail(`${a} requires a path.`);
			if (a === '--from') from = val;
			else dbPath = val;
			i += 1;
			continue;
		}
		if (a.startsWith('--from=')) {
			from = a.slice('--from='.length);
			continue;
		}
		if (a.startsWith('--db=')) {
			dbPath = a.slice('--db='.length);
			continue;
		}
		if (a.startsWith('--')) flags.add(a);
		else positional.push(...String(a).split(',').map((s) => s.trim()).filter(Boolean));
	}
	return { shopIds: [...new Set(positional)], flags, from, dbPath };
}

function tsStamp() {
	return new Date().toISOString().replace(/[:.]/g, '-');
}

function quoteIdent(name) {
	return `"${String(name).replace(/"/g, '""')}"`;
}

function sqlString(value) {
	return `'${String(value).replace(/'/g, "''")}'`;
}

function placeholders(prefix, count) {
	return Array.from({ length: count }, (_, i) => `@${prefix}${i}`).join(', ');
}

function bindList(prefix, values) {
	const params = {};
	values.forEach((v, i) => { params[`${prefix}${i}`] = v; });
	return params;
}

function normalizeTitle(text) {
	return String(text ?? '')
		.replace(/\|/g, ',')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase();
}

function isBlankText(value) {
	return value == null || String(value).trim() === '';
}

function isBlankNum(value) {
	return value == null || value === '';
}

function tableExistsIn(db, schema, name) {
	return !!db.prepare(
		`SELECT 1 FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`,
	).get(name);
}

function columnNames(db, schema, table) {
	return db.prepare(`PRAGMA ${schema}.table_info(${quoteIdent(table)})`).all().map((col) => col.name);
}

function commonColumns(db, table, skipColumns = []) {
	const skip = new Set(skipColumns);
	const live = new Set(columnNames(db, 'main', table));
	return columnNames(db, 'bak', table).filter((name) => live.has(name) && !skip.has(name));
}

function toAttachPath(filePath) {
	return path.resolve(filePath).replace(/\\/g, '/');
}

function findDefaultCatalogBackup(dbPath) {
	const dir = path.join(path.dirname(dbPath), 'backups');
	if (!fs.existsSync(dir)) return null;
	const matches = fs.readdirSync(dir).filter((name) => BATCH6_BACKUP_RE.test(name));
	if (!matches.length) return null;
	matches.sort((a, b) => {
		const am = fs.statSync(path.join(dir, a)).mtimeMs;
		const bm = fs.statSync(path.join(dir, b)).mtimeMs;
		return bm - am;
	});
	return path.join(dir, matches[0]);
}

function listCatalogBackups(dbPath) {
	const dir = path.join(path.dirname(dbPath), 'backups');
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter((name) => /^etsy_dashboard(?:\.pre-remove-|-).*\.db$/i.test(name))
		.filter((name) => !/pre-restore-catalog/i.test(name))
		.filter((name) => !/^route_engine/i.test(name))
		.map((name) => {
			const full = path.join(dir, name);
			return { name, path: full, mtime: fs.statSync(full).mtimeMs };
		})
		.sort((a, b) => b.mtime - a.mtime);
}

function operatedShopIds(db) {
	if (!tableExistsIn(db, 'main', 'shops')) return [];
	return db
		.prepare('SELECT shop_id FROM shops WHERE shop_id NOT IN (?, ?)')
		.all(MANUAL_SHOP_ID, CATALOG_ARCHIVE_SHOP_ID)
		.map((row) => row.shop_id);
}

function listingCopyContext(db, shopIds) {
	const idList = placeholders('id', shopIds.length);
	const params = idParams(shopIds);
	const operated = operatedShopIds(db);
	const opList = operated.length ? placeholders('op', operated.length) : '';
	if (operated.length) Object.assign(params, bindList('op', operated));
	return { idList, opList, params, operated };
}

function withAttachedBackup(db, sourcePath, fn) {
	const attached = toAttachPath(sourcePath);
	try { db.exec('DETACH DATABASE bak'); } catch { /* nothing attached */ }
	db.exec(`ATTACH DATABASE ${sqlString(attached)} AS bak`);
	try {
		return fn();
	} finally {
		try { db.exec('DETACH DATABASE bak'); } catch { /* already detached */ }
	}
}

/**
 * Eligible listing ids: owned by the requested shops in the backup, and not
 * colliding with a listing that a still-operated shop currently owns.
 */
function eligibleListingsSql(idList, opList) {
	const collision = opList
		? `AND NOT EXISTS (
			SELECT 1 FROM main.listings m
			WHERE m.listing_id = b.listing_id
			  AND m.shop_id IN (${opList})
		)`
		: `AND NOT EXISTS (
			SELECT 1 FROM main.listings m
			WHERE m.listing_id = b.listing_id
			  AND m.shop_id NOT IN (${idList})
		)`;
	return `
		SELECT b.listing_id
		FROM bak.listings b
		WHERE b.shop_id IN (${idList})
		  ${collision}
	`;
}

function idParams(shopIds) {
	return bindList('id', shopIds);
}

function emptyTableStats() {
	const stats = {};
	for (const spec of LISTING_COPY_TABLES) stats[spec.table] = { source: 0, insert: 0, skip: 0 };
	stats.product_merges = { source: 0, insert: 0, skip: 0 };
	stats.product_map = { insert: 0, fill: 0, skipped_keep: 0 };
	stats.product_map_title_aliases = { insert: 0 };
	stats.promote = { insert: 0, alias: 0, canonical_fill: 0, reactivate: 0 };
	return stats;
}

function countTableCopy(db, spec, ctx) {
	const { idList, opList, params } = ctx;
	if (!tableExistsIn(db, 'bak', spec.table) || !tableExistsIn(db, 'main', spec.table)) {
		return { source: 0, insert: 0, skip: 0 };
	}
	const eligible = eligibleListingsSql(idList, opList);
	const source = spec.table === 'listings'
		? db.prepare(`SELECT COUNT(*) AS n FROM bak.listings WHERE shop_id IN (${idList})`).get(params).n
		: db.prepare(`SELECT COUNT(*) AS n FROM bak.${quoteIdent(spec.table)} WHERE listing_id IN (SELECT listing_id FROM bak.listings WHERE shop_id IN (${idList}))`).get(params).n;

	let insertSql;
	if (spec.table === 'listings') {
		insertSql = `SELECT COUNT(*) AS n FROM bak.listings b
			WHERE b.listing_id IN (${eligible})
			  AND NOT EXISTS (SELECT 1 FROM main.listings m WHERE m.listing_id = b.listing_id)`;
	} else if (spec.table === 'listing_style_images') {
		insertSql = `SELECT COUNT(*) AS n FROM bak.listing_style_images b
			WHERE b.listing_id IN (${eligible})
			  AND NOT EXISTS (
				SELECT 1 FROM main.listing_style_images m
				WHERE m.listing_id = b.listing_id AND m.style_key = b.style_key
			  )`;
	} else if (spec.table === 'listing_variation_images') {
		insertSql = `SELECT COUNT(*) AS n FROM bak.listing_variation_images b
			WHERE b.listing_id IN (${eligible})
			  AND NOT EXISTS (
				SELECT 1 FROM main.listing_variation_images m
				WHERE m.listing_id = b.listing_id AND m.style_key = b.style_key
			  )`;
	} else {
		insertSql = `SELECT COUNT(*) AS n FROM bak.${quoteIdent(spec.table)} b
			WHERE b.listing_id IN (${eligible})
			  AND NOT EXISTS (
				SELECT 1 FROM main.${quoteIdent(spec.table)} m WHERE m.listing_id = b.listing_id
			  )`;
	}
	const insert = db.prepare(insertSql).get(params).n;
	return { source, insert, skip: Math.max(0, source - insert) };
}

function countProductMerges(db, ctx) {
	const { idList, opList, params } = ctx;
	if (!tableExistsIn(db, 'bak', 'product_merges') || !tableExistsIn(db, 'main', 'product_merges')) {
		return { source: 0, insert: 0, skip: 0 };
	}
	const eligible = eligibleListingsSql(idList, opList);
	const source = db.prepare(`
		SELECT COUNT(*) AS n FROM bak.product_merges
		WHERE listing_a IN (SELECT listing_id FROM bak.listings WHERE shop_id IN (${idList}))
		   OR listing_b IN (SELECT listing_id FROM bak.listings WHERE shop_id IN (${idList}))
	`).get(params).n;
	const insert = db.prepare(`
		SELECT COUNT(*) AS n FROM bak.product_merges b
		WHERE (b.listing_a IN (${eligible}) OR b.listing_b IN (${eligible}))
		  AND b.listing_a IN (SELECT listing_id FROM main.listings UNION SELECT listing_id FROM (${eligible}))
		  AND b.listing_b IN (SELECT listing_id FROM main.listings UNION SELECT listing_id FROM (${eligible}))
		  AND NOT EXISTS (
			SELECT 1 FROM main.product_merges m
			WHERE m.listing_a = b.listing_a AND m.listing_b = b.listing_b
		  )
	`).get(params).n;
	return { source, insert, skip: Math.max(0, source - insert) };
}

function recoveredTitleNorms(db, idList, params) {
	const norms = new Set();
	if (!tableExistsIn(db, 'bak', 'listings')) return norms;
	for (const row of db.prepare(`SELECT title FROM bak.listings WHERE shop_id IN (${idList})`).all(params)) {
		const tn = normalizeTitle(row.title);
		if (tn) norms.add(tn);
	}
	return norms;
}

function reconcileProductMap(db, recoveredNorms, apply) {
	const stats = { insert: 0, fill: 0, skipped_keep: 0 };
	if (!recoveredNorms.size) return stats;
	if (!tableExistsIn(db, 'bak', 'product_map') || !tableExistsIn(db, 'main', 'product_map')) return stats;

	const bakRows = db.prepare('SELECT * FROM bak.product_map').all();
	const liveByNorm = new Map(
		db.prepare('SELECT * FROM main.product_map').all().map((row) => [row.title_norm, row]),
	);
	const insertCols = commonColumns(db, 'product_map', ['id']);
	const insertSql = insertCols.length
		? db.prepare(`
			INSERT INTO main.product_map (${insertCols.map(quoteIdent).join(', ')})
			VALUES (${insertCols.map((col) => `@${col}`).join(', ')})
		`)
		: null;
	const now = Math.floor(Date.now() / 1000);

	for (const bak of bakRows) {
		const bakNorm = String(bak.title_norm || normalizeTitle(bak.title) || '');
		if (!bakNorm) continue;
		if (!recoveredNorms.has(bakNorm) && !recoveredNorms.has(normalizeTitle(bak.title))) continue;

		const live = liveByNorm.get(bakNorm) || liveByNorm.get(bak.title_norm);
		if (!live) {
			stats.insert += 1;
			if (apply && insertSql) {
				const payload = {};
				for (const col of insertCols) payload[col] = bak[col];
				if (insertCols.includes('updated_at')) payload.updated_at = now;
				insertSql.run(payload);
			}
			continue;
		}

		const patch = {};
		for (const col of PRODUCT_MAP_FILL_TEXT) {
			if (!(col in live) || !(col in bak)) continue;
			if (isBlankText(live[col]) && !isBlankText(bak[col])) patch[col] = bak[col];
		}
		for (const col of PRODUCT_MAP_FILL_NUM) {
			if (!(col in live) || !(col in bak)) continue;
			if (isBlankNum(live[col]) && !isBlankNum(bak[col])) patch[col] = bak[col];
		}
		if (!Object.keys(patch).length) {
			stats.skipped_keep += 1;
			continue;
		}
		stats.fill += 1;
		if (apply) {
			const cols = Object.keys(patch);
			if (columnNames(db, 'main', 'product_map').includes('updated_at')) {
				cols.push('updated_at');
				patch.updated_at = now;
			}
			const sql = `UPDATE product_map SET ${cols.map((col) => `${quoteIdent(col)} = ?`).join(', ')} WHERE id = ?`;
			const info = db.prepare(sql).run(...cols.map((col) => patch[col]), live.id);
			if (info.changes !== 1) {
				fail(`product_map fill for id ${live.id} (${bakNorm}) wrote ${info.changes} row(s).`);
			}
			Object.assign(live, patch);
		}
	}
	return stats;
}

function reconcileProductMapAliases(db, recoveredNorms, apply) {
	const stats = { insert: 0 };
	if (!recoveredNorms.size) return stats;
	if (!tableExistsIn(db, 'bak', 'product_map_title_aliases')) return stats;
	if (!tableExistsIn(db, 'main', 'product_map_title_aliases')) return stats;
	if (!tableExistsIn(db, 'bak', 'product_map') || !tableExistsIn(db, 'main', 'product_map')) return stats;

	const bakProducts = new Map(
		db.prepare('SELECT id, title_norm, title FROM bak.product_map').all().map((row) => [row.id, row]),
	);
	const liveByNorm = new Map(
		db.prepare('SELECT id, title_norm FROM main.product_map').all().map((row) => [row.title_norm, row]),
	);
	const liveAlias = db.prepare('SELECT 1 FROM main.product_map_title_aliases WHERE title_norm = ?');
	const insert = apply
		? db.prepare(`
			INSERT INTO main.product_map_title_aliases (title_norm, product_id, title, created_at)
			VALUES (@title_norm, @product_id, @title, @created_at)
		`)
		: null;

	for (const alias of db.prepare('SELECT * FROM bak.product_map_title_aliases').all()) {
		const parent = bakProducts.get(alias.product_id);
		if (!parent) continue;
		const parentNorm = String(parent.title_norm || '');
		if (!recoveredNorms.has(parentNorm) && !recoveredNorms.has(normalizeTitle(alias.title))) continue;
		const liveParent = liveByNorm.get(parentNorm);
		if (!liveParent) continue;
		if (liveAlias.get(alias.title_norm)) continue;
		stats.insert += 1;
		if (insert) {
			insert.run({
				title_norm: alias.title_norm,
				product_id: liveParent.id,
				title: alias.title || '',
				created_at: alias.created_at || Math.floor(Date.now() / 1000),
			});
		}
	}
	return stats;
}

function copyListingTable(db, spec, ctx) {
	const { idList, opList, params, operated } = ctx;
	if (!tableExistsIn(db, 'bak', spec.table) || !tableExistsIn(db, 'main', spec.table)) return 0;
	const cols = commonColumns(db, spec.table, spec.skipColumns);
	if (!cols.length) return 0;
	const colSql = cols.map(quoteIdent).join(', ');
	const eligible = eligibleListingsSql(idList, opList);
	const selectSql = (spec.table === 'listings' && cols.includes('shop_id') && operated.length)
		? cols.map((col) => {
			if (col === 'shop_id') {
				return `CASE WHEN b.shop_id IN (${opList}) THEN ${sqlString(CATALOG_ARCHIVE_SHOP_ID)} ELSE b.shop_id END`;
			}
			return `b.${quoteIdent(col)}`;
		}).join(', ')
		: cols.map((col) => `b.${quoteIdent(col)}`).join(', ');
	const res = db.prepare(`
		INSERT OR IGNORE INTO main.${quoteIdent(spec.table)} (${colSql})
		SELECT ${selectSql} FROM bak.${quoteIdent(spec.table)} b
		WHERE b.listing_id IN (${eligible})
	`).run(params);
	return res.changes;
}

function copyProductMerges(db, ctx) {
	const { idList, opList, params } = ctx;
	if (!tableExistsIn(db, 'bak', 'product_merges') || !tableExistsIn(db, 'main', 'product_merges')) return 0;
	const cols = commonColumns(db, 'product_merges');
	if (!cols.length) return 0;
	const colSql = cols.map(quoteIdent).join(', ');
	const eligible = eligibleListingsSql(idList, opList);
	const res = db.prepare(`
		INSERT OR IGNORE INTO main.product_merges (${colSql})
		SELECT ${cols.map((col) => `b.${quoteIdent(col)}`).join(', ')} FROM bak.product_merges b
		WHERE (b.listing_a IN (${eligible}) OR b.listing_b IN (${eligible}))
		  AND b.listing_a IN (SELECT listing_id FROM main.listings)
		  AND b.listing_b IN (SELECT listing_id FROM main.listings)
	`).run(params);
	return res.changes;
}

function listingHasPhoto(row) {
	return !isBlankText(row.primary_image_url) || !isBlankText(row.image_url);
}

function loadMainPromoteRows(db) {
	if (!tableExistsIn(db, 'main', 'listings')) return [];
	const hasPhash = tableExistsIn(db, 'main', 'listing_phash');
	const hasImages = tableExistsIn(db, 'main', 'listing_images');
	return db.prepare(`
		SELECT l.listing_id, l.title, l.primary_image_url
			${hasPhash ? ', p.canonical_key' : ', NULL AS canonical_key'}
			${hasImages ? `, (SELECT i.url FROM listing_images i
				WHERE i.listing_id = l.listing_id AND i.url IS NOT NULL AND i.url <> ''
				LIMIT 1) AS image_url` : ', NULL AS image_url'}
		FROM listings l
		${hasPhash ? 'LEFT JOIN listing_phash p ON p.listing_id = l.listing_id' : ''}
		WHERE l.shop_id IS NOT NULL
		  AND l.shop_id <> ${sqlString(MANUAL_SHOP_ID)}
		  AND l.title IS NOT NULL AND TRIM(l.title) <> ''
	`).all();
}

function loadBakPromoteRows(db, ctx) {
	if (!ctx || !tableExistsIn(db, 'bak', 'listings')) return [];
	const eligible = eligibleListingsSql(ctx.idList, ctx.opList);
	const hasPhash = tableExistsIn(db, 'bak', 'listing_phash');
	const hasImages = tableExistsIn(db, 'bak', 'listing_images');
	return db.prepare(`
		SELECT b.listing_id, b.title, b.primary_image_url
			${hasPhash ? ', p.canonical_key' : ', NULL AS canonical_key'}
			${hasImages ? `, (SELECT i.url FROM bak.listing_images i
				WHERE i.listing_id = b.listing_id AND i.url IS NOT NULL AND i.url <> ''
				LIMIT 1) AS image_url` : ', NULL AS image_url'}
		FROM bak.listings b
		${hasPhash ? 'LEFT JOIN bak.listing_phash p ON p.listing_id = b.listing_id' : ''}
		WHERE b.listing_id IN (${eligible})
		  AND b.title IS NOT NULL AND TRIM(b.title) <> ''
	`).all(ctx.params);
}

/**
 * The Product Catalog / Sourcing picker only shows `product_map` rows that
 * resolve to a photo. Restored listings are invisible until they become
 * catalog rows (or aliases of a row that already has a photo). Group by
 * listing_phash.canonical_key when present, else by title_norm.
 */
function promoteListingsToProductMap(db, apply, ctx = null) {
	const stats = { insert: 0, alias: 0, canonical_fill: 0, reactivate: 0 };
	if (!tableExistsIn(db, 'main', 'product_map')) return stats;

	const byListing = new Map();
	if (!apply) {
		for (const row of loadBakPromoteRows(db, ctx)) byListing.set(Number(row.listing_id), row);
	}
	for (const row of loadMainPromoteRows(db)) byListing.set(Number(row.listing_id), row);
	if (!byListing.size) return stats;

	const liveRows = db.prepare('SELECT * FROM main.product_map').all();
	const liveByNorm = new Map(liveRows.map((row) => [row.title_norm, row]));
	const liveByCanonical = new Map();
	for (const row of liveRows) {
		const key = String(row.canonical_product_key || '').trim();
		if (key && !liveByCanonical.has(key)) liveByCanonical.set(key, row);
	}

	const hasAliasTable = tableExistsIn(db, 'main', 'product_map_title_aliases');
	const existingAliases = new Set();
	if (hasAliasTable) {
		for (const row of db.prepare('SELECT title_norm FROM main.product_map_title_aliases').all()) {
			existingAliases.add(row.title_norm);
		}
	}

	const groups = new Map();
	for (const row of byListing.values()) {
		const titleNorm = normalizeTitle(row.title);
		if (!titleNorm) continue;
		const canon = String(row.canonical_key || '').trim();
		const groupKey = canon ? `k:${canon}` : `t:${titleNorm}`;
		let group = groups.get(groupKey);
		if (!group) {
			group = { canonical: canon, members: [] };
			groups.set(groupKey, group);
		}
		group.members.push({
			title_norm: titleNorm,
			title: String(row.title || '').trim(),
			hasPhoto: listingHasPhoto(row),
		});
	}

	const pmCols = new Set(columnNames(db, 'main', 'product_map'));
	let maxOrder = pmCols.has('sort_order')
		? db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM main.product_map').get().m
		: 0;
	const now = Math.floor(Date.now() / 1000);
	const insertAlias = apply && hasAliasTable
		? db.prepare(`
			INSERT OR IGNORE INTO main.product_map_title_aliases (title_norm, product_id, title, created_at)
			VALUES (@title_norm, @product_id, @title, @created_at)
		`)
		: null;
	const fillCanonical = apply && pmCols.has('canonical_product_key')
		? db.prepare('UPDATE product_map SET canonical_product_key = ?, updated_at = ? WHERE id = ?')
		: null;
	const reactivateSql = apply && pmCols.has('status')
		? db.prepare(`
			UPDATE product_map
			   SET status = 'active', retired_at = NULL, retired_reason = '', retired_by = '', updated_at = ?
			 WHERE id = ?
		`)
		: null;

	const insertProduct = (payload) => {
		const row = { title_norm: payload.title_norm, title: payload.title };
		if (pmCols.has('shop_name')) row.shop_name = '';
		if (pmCols.has('stall')) row.stall = '';
		if (pmCols.has('charm_shop')) row.charm_shop = '';
		if (pmCols.has('charm_code')) row.charm_code = '';
		if (pmCols.has('canonical_product_key')) row.canonical_product_key = payload.canonical_product_key;
		if (pmCols.has('status')) row.status = 'active';
		if (pmCols.has('sort_order')) row.sort_order = payload.sort_order;
		if (pmCols.has('updated_at')) row.updated_at = payload.updated_at;
		const names = Object.keys(row);
		return db.prepare(`
			INSERT OR IGNORE INTO product_map (${names.map(quoteIdent).join(', ')})
			VALUES (${names.map((name) => `@${name}`).join(', ')})
		`).run(row);
	};

	const addAlias = (product, member) => {
		if (!hasAliasTable || !product) return;
		if (member.title_norm === product.title_norm) return;
		if (liveByNorm.has(member.title_norm)) return;
		if (existingAliases.has(member.title_norm)) return;
		stats.alias += 1;
		existingAliases.add(member.title_norm);
		if (insertAlias && Number(product.id) > 0) {
			insertAlias.run({
				title_norm: member.title_norm,
				product_id: product.id,
				title: member.title || '',
				created_at: now,
			});
		}
	};

	for (const group of groups.values()) {
		const byNorm = new Map();
		for (const member of group.members) {
			const prev = byNorm.get(member.title_norm);
			if (!prev || (member.hasPhoto && !prev.hasPhoto)) byNorm.set(member.title_norm, member);
		}
		const members = [...byNorm.values()];
		if (!members.length) continue;

		let product = null;
		for (const member of members) {
			product = liveByNorm.get(member.title_norm);
			if (product) break;
		}
		if (!product && group.canonical) product = liveByCanonical.get(group.canonical);

		if (!product) {
			if (!members.some((member) => member.hasPhoto)) continue;
			const best = members.slice().sort((a, b) => {
				if (a.hasPhoto !== b.hasPhoto) return a.hasPhoto ? -1 : 1;
				return a.title_norm.localeCompare(b.title_norm);
			})[0];
			stats.insert += 1;
			maxOrder += 1;
			const newRow = {
				id: apply ? 0 : -stats.insert,
				title_norm: best.title_norm,
				title: best.title,
				canonical_product_key: group.canonical || null,
				status: 'active',
			};
			if (apply) {
				const info = insertProduct({
					title_norm: best.title_norm,
					title: best.title,
					canonical_product_key: group.canonical || null,
					sort_order: maxOrder,
					updated_at: now,
				});
				if (info.changes === 1) newRow.id = Number(info.lastInsertRowid);
				else {
					const existing = db.prepare('SELECT * FROM product_map WHERE title_norm = ?').get(best.title_norm);
					if (existing) {
						stats.insert -= 1;
						product = existing;
						liveByNorm.set(existing.title_norm, existing);
					}
				}
			}
			if (!product) {
				liveByNorm.set(best.title_norm, newRow);
				if (group.canonical && !liveByCanonical.has(group.canonical)) {
					liveByCanonical.set(group.canonical, newRow);
				}
				product = newRow;
			}
		}

		if (product && String(product.status || '') === 'retired') {
			stats.reactivate += 1;
			if (reactivateSql) reactivateSql.run(now, product.id);
			product.status = 'active';
		}

		if (group.canonical && pmCols.has('canonical_product_key')) {
			for (const member of members) {
				const row = liveByNorm.get(member.title_norm);
				if (!row || row.id < 0) continue;
				if (!isBlankText(row.canonical_product_key)) continue;
				stats.canonical_fill += 1;
				if (fillCanonical) fillCanonical.run(group.canonical, now, row.id);
				row.canonical_product_key = group.canonical;
				if (!liveByCanonical.has(group.canonical)) liveByCanonical.set(group.canonical, row);
			}
			if (product.id > 0 && isBlankText(product.canonical_product_key)) {
				stats.canonical_fill += 1;
				if (fillCanonical) fillCanonical.run(group.canonical, now, product.id);
				product.canonical_product_key = group.canonical;
				if (!liveByCanonical.has(group.canonical)) liveByCanonical.set(group.canonical, product);
			}
		}

		for (const member of members) addAlias(product, member);
	}

	return stats;
}

function assertAllowlist(table) {
	if (NEVER_RESTORE_TABLES.has(table)) {
		fail(`Refusing to restore operational table "${table}".`);
	}
}

/**
 * Resolve requested identifiers against the SOURCE database (shop_id or
 * shop_name, case-insensitive). Unknown names that still own listings are
 * accepted so a backup taken after `shops` was pruned can still restore.
 */
function resolveSourceShops(sourceDb, requestedIds) {
	const wanted = (requestedIds && requestedIds.length)
		? requestedIds
		: [...DEFAULT_ARCHIVED_SHOP_IDS];
	const shops = tableExistsIn(sourceDb, 'main', 'shops')
		? sourceDb.prepare('SELECT shop_id, shop_name FROM shops').all()
		: [];
	const byId = new Map(shops.map((s) => [String(s.shop_id).toLowerCase(), s]));
	const byName = new Map(shops.map((s) => [String(s.shop_name).toLowerCase(), s]));
	const listingCounts = new Map();
	for (const row of sourceDb.prepare('SELECT shop_id, COUNT(*) AS n FROM listings GROUP BY shop_id').all()) {
		listingCounts.set(row.shop_id, row.n);
	}

	const targets = [];
	const missing = [];
	const seen = new Set();
	for (const raw of wanted) {
		const key = String(raw).toLowerCase();
		const shop = byId.get(key) || byName.get(key);
		let shopId = shop?.shop_id;
		if (!shopId) {
			shopId = [...listingCounts.keys()].find((id) => String(id).toLowerCase() === key) || raw;
		}
		if (seen.has(shopId)) continue;
		const listings = listingCounts.get(shopId) || 0;
		if (!shop && listings === 0) {
			missing.push(raw);
			continue;
		}
		seen.add(shopId);
		targets.push({
			shopId,
			shopName: shop?.shop_name || shopId,
			listings,
		});
	}
	return { targets, missing, wanted };
}

function resolveAllHistoryShops(sourceDb) {
	if (!tableExistsIn(sourceDb, 'main', 'listings')) {
		return { targets: [], missing: [], wanted: [] };
	}
	const rows = sourceDb.prepare(`
		SELECT shop_id, COUNT(*) AS n
		FROM listings
		WHERE shop_id IS NOT NULL AND TRIM(shop_id) <> '' AND shop_id <> ?
		GROUP BY shop_id
		ORDER BY n DESC
	`).all(MANUAL_SHOP_ID);
	const targets = rows.map((row) => ({
		shopId: row.shop_id,
		shopName: row.shop_id,
		listings: row.n,
	}));
	return { targets, missing: [], wanted: targets.map((t) => t.shopId) };
}

function planFromAttached(db, shopIds) {
	if (!shopIds.length) fail('planFromAttached requires at least one shop id.');
	for (const spec of LISTING_COPY_TABLES) assertAllowlist(spec.table);
	assertAllowlist('product_merges');

	const ctx = listingCopyContext(db, shopIds);
	const stats = emptyTableStats();
	for (const spec of LISTING_COPY_TABLES) {
		stats[spec.table] = countTableCopy(db, spec, ctx);
	}
	stats.product_merges = countProductMerges(db, ctx);
	const norms = recoveredTitleNorms(db, ctx.idList, ctx.params);
	stats.product_map = reconcileProductMap(db, norms, false);
	stats.product_map_title_aliases = reconcileProductMapAliases(db, norms, false);
	stats.recovered_title_norms = norms.size;
	stats.promote = promoteListingsToProductMap(db, false, ctx);
	return stats;
}

function applyFromAttached(db, shopIds) {
	if (!shopIds.length) fail('applyFromAttached requires at least one shop id.');
	const ctx = listingCopyContext(db, shopIds);
	const written = {};

	const run = db.transaction(() => {
		for (const spec of LISTING_COPY_TABLES) {
			assertAllowlist(spec.table);
			const n = copyListingTable(db, spec, ctx);
			if (n) written[spec.table] = n;
		}
		assertAllowlist('product_merges');
		const merges = copyProductMerges(db, ctx);
		if (merges) written.product_merges = merges;

		const norms = recoveredTitleNorms(db, ctx.idList, ctx.params);
		const pm = reconcileProductMap(db, norms, true);
		if (pm.insert) written.product_map_insert = pm.insert;
		if (pm.fill) written.product_map_fill = pm.fill;
		const aliases = reconcileProductMapAliases(db, norms, true);
		if (aliases.insert) written.product_map_title_aliases = aliases.insert;
	});
	run();
	return written;
}

function planRestore(destDb, sourcePath, shopIds) {
	if (!sourcePath || !fs.existsSync(sourcePath)) fail(`Backup not found: ${sourcePath || '(empty path)'}`);
	return withAttachedBackup(destDb, sourcePath, () => planFromAttached(destDb, shopIds));
}

function applyRestore(destDb, sourcePath, shopIds) {
	if (!sourcePath || !fs.existsSync(sourcePath)) fail(`Backup not found: ${sourcePath || '(empty path)'}`);
	const destPath = typeof destDb.name === 'string' ? destDb.name : '';
	if (destPath && path.resolve(destPath) === path.resolve(sourcePath)) {
		fail('Source and destination databases are the same file.');
	}
	return withAttachedBackup(destDb, sourcePath, () => applyFromAttached(destDb, shopIds));
}

function totalInserts(stats) {
	let n = 0;
	for (const spec of LISTING_COPY_TABLES) n += stats[spec.table]?.insert || 0;
	n += stats.product_merges?.insert || 0;
	n += stats.product_map?.insert || 0;
	n += stats.product_map?.fill || 0;
	n += stats.product_map_title_aliases?.insert || 0;
	n += stats.promote?.insert || 0;
	n += stats.promote?.alias || 0;
	n += stats.promote?.canonical_fill || 0;
	n += stats.promote?.reactivate || 0;
	return n;
}

function printPromote(promote) {
	const p = promote || {};
	console.log(`    catalog promote insert / alias     ${String(p.insert || 0).padStart(6)} / ${String(p.alias || 0)}`);
	console.log(`    catalog promote canonical fill     ${String(p.canonical_fill || 0).padStart(6)}`);
	if (p.reactivate) {
		console.log(`    catalog promote reactivate         ${String(p.reactivate).padStart(6)}`);
	}
}

function printStats(stats, { promote = true } = {}) {
	const rows = [];
	for (const spec of LISTING_COPY_TABLES) {
		const s = stats[spec.table];
		if (!s || (s.source === 0 && s.insert === 0)) continue;
		rows.push([spec.table, s.source, s.insert, s.skip]);
	}
	const merges = stats.product_merges;
	if (merges && (merges.source || merges.insert)) {
		rows.push(['product_merges', merges.source, merges.insert, merges.skip]);
	}
	if (!rows.length) {
		console.log(`    ${c.dim('(no listing catalog rows to copy)')}`);
	} else {
		console.log(`    ${'table'.padEnd(34)} ${'src'.padStart(6)} ${'add'.padStart(6)} ${'skip'.padStart(6)}`);
		for (const [table, source, insert, skip] of rows) {
			console.log(`    ${table.padEnd(34)} ${String(source).padStart(6)} ${String(insert).padStart(6)} ${String(skip).padStart(6)}`);
		}
	}
	const pm = stats.product_map || {};
	console.log(`    product_map fill / insert          ${String(pm.fill || 0).padStart(6)} / ${String(pm.insert || 0)}`);
	console.log(`    product_map aliases insert         ${String(stats.product_map_title_aliases?.insert || 0).padStart(6)}`);
	if (promote) printPromote(stats.promote);
}

function resolveBackupTargets(sourcePath, requestedIds, allHistory) {
	const sourceDb = new Database(sourcePath, { readonly: true });
	try {
		return allHistory && !(requestedIds && requestedIds.length)
			? resolveAllHistoryShops(sourceDb)
			: resolveSourceShops(sourceDb, requestedIds);
	} finally {
		sourceDb.close();
	}
}

function mergeWritten(into, written) {
	for (const [key, value] of Object.entries(written || {})) {
		into[key] = (into[key] || 0) + value;
	}
	return into;
}

async function snapshotDestination(destPath, label) {
	const backupDir = path.join(path.dirname(destPath), 'backups');
	fs.mkdirSync(backupDir, { recursive: true });
	const dbBackup = path.join(backupDir, `etsy_dashboard.${label}-${tsStamp()}.db`);
	const bkDb = new Database(destPath, { readonly: true });
	try {
		await bkDb.backup(dbBackup);
	} finally {
		bkDb.close();
	}
	return dbBackup;
}

async function main() {
	const parsed = parseArgs(process.argv.slice(2));
	const commit = parsed.flags.has('--yes') || parsed.flags.has('--commit');
	const doDbBackup = !parsed.flags.has('--no-db-backup');
	const allHistory = parsed.flags.has('--all-history');
	const promoteOnly = parsed.flags.has('--promote-only');

	const config = loadConfig();
	const destPath = parsed.dbPath || config.db_path;
	if (!destPath || !fs.existsSync(destPath)) fail(`Database not found at ${destPath}.`);

	console.log('');
	console.log(`  ${c.bold('Catalog-only restore')} ${commit ? c.yellow('· LIVE RUN') : c.yellow('· DRY RUN (no changes)')}`);
	console.log(`  ${c.dim('─'.repeat(62))}`);
	console.log(`  Destination : ${c.dim(destPath)}`);
	if (allHistory) console.log(`  Scope        : ${c.bold('all backups + every shop + catalog promote')}`);
	if (promoteOnly) console.log(`  Scope        : ${c.bold('promote listings → product_map only')}`);
	console.log(`  ${c.bold('Will NOT restore:')} shops, receipts, tokens, inventory, ledger, sync, growth.`);
	console.log('');

	const jobs = [];
	if (!promoteOnly) {
		const backups = allHistory
			? listCatalogBackups(destPath)
			: (() => {
				const sourcePath = parsed.from || findDefaultCatalogBackup(destPath);
				if (!sourcePath) fail('No pre-remove-batch-6 backup found. Pass --from <backup.db> or --all-history.');
				return [{ name: path.basename(sourcePath), path: sourcePath, mtime: 0 }];
			})();
		if (!backups.length) fail('No catalog backups found under the destination backups directory.');

		for (const bak of backups) {
			if (!bak.path || !fs.existsSync(bak.path)) continue;
			if (path.resolve(bak.path) === path.resolve(destPath)) continue;
			let resolved;
			try {
				resolved = resolveBackupTargets(bak.path, parsed.shopIds, allHistory);
			} catch (err) {
				console.log(`  ${c.yellow('skip')} ${bak.name}: ${err.message}`);
				continue;
			}
			if (!resolved.targets.length) continue;
			jobs.push({
				name: bak.name,
				path: bak.path,
				targets: resolved.targets,
				missing: resolved.missing,
				shopIds: resolved.targets.map((t) => t.shopId),
			});
		}
		if (!jobs.length) {
			fail('None of the requested shops have listings in the selected backups.');
		}
	}

	const destRo = new Database(destPath, { readonly: true });
	const plans = [];
	let promoteStats = { insert: 0, alias: 0, canonical_fill: 0, reactivate: 0 };
	try {
		for (const job of jobs) {
			console.log(`  ${c.bold(job.name)}`);
			for (const t of job.targets.slice(0, 12)) {
				console.log(`    ${t.shopId}  ${c.dim(`(${t.listings} listing${t.listings === 1 ? '' : 's'})`)}`);
			}
			if (job.targets.length > 12) {
				console.log(`    ${c.dim(`… ${job.targets.length - 12} more shop(s)`)}`);
			}
			if (job.missing?.length) console.log(`    ${c.dim('Not in this backup:')} ${job.missing.join(', ')}`);
			const stats = planRestore(destRo, job.path, job.shopIds);
			printStats(stats, { promote: jobs.length === 1 });
			console.log('');
			plans.push(stats);
		}
		promoteStats = jobs.length === 1 && plans[0]?.promote
			? plans[0].promote
			: promoteListingsToProductMap(destRo, false);
	} finally {
		destRo.close();
	}

	if (jobs.length !== 1) {
		console.log(`  ${c.bold('Catalog promote (live listings already in destination):')}`);
		printPromote(promoteStats);
		if (jobs.length > 1) {
			console.log(`    ${c.dim('Newly copied listings are promoted after --yes.')}`);
		}
		console.log('');
	}

	const listingAdds = plans.reduce((n, stats) => n + totalInserts({ ...stats, promote: { insert: 0, alias: 0, canonical_fill: 0, reactivate: 0 } }), 0);
	const promoteAdds = (promoteStats.insert || 0) + (promoteStats.alias || 0)
		+ (promoteStats.canonical_fill || 0) + (promoteStats.reactivate || 0);

	if (!commit) {
		console.log(`  ${c.yellow('DRY RUN')} — nothing was changed.`);
		console.log(`  Re-run with ${c.bold('--yes')}${allHistory || promoteOnly ? '' : ' (or --all-history --yes)'} to restore the product catalog.\n`);
		return;
	}

	if (listingAdds === 0 && promoteAdds === 0 && !allHistory) {
		console.log(`  ${c.green('✓')} Catalog already restored — nothing to write.\n`);
		return;
	}

	console.log(`  ${c.bold('Creating a destination snapshot…')}`);
	if (doDbBackup) {
		const dbBackup = await snapshotDestination(destPath, 'pre-restore-catalog');
		console.log(`    database : ${c.dim(dbBackup)}`);
	} else {
		console.log(`    database : ${c.yellow('skipped (--no-db-backup)')}`);
	}

	console.log(`\n  ${c.bold('Copying catalog rows…')}`);
	const dest = new Database(destPath);
	dest.pragma('busy_timeout = 60000');
	dest.pragma('foreign_keys = ON');
	const written = {};
	let promoted = { insert: 0, alias: 0, canonical_fill: 0, reactivate: 0 };
	try {
		for (const job of jobs) {
			console.log(`    ${c.dim(job.name)}`);
			mergeWritten(written, applyRestore(dest, job.path, job.shopIds));
		}
		promoted = promoteListingsToProductMap(dest, true);
		if (promoted.insert) written.catalog_promote_insert = promoted.insert;
		if (promoted.alias) written.catalog_promote_alias = promoted.alias;
		if (promoted.canonical_fill) written.catalog_promote_canonical = promoted.canonical_fill;
		if (promoted.reactivate) written.catalog_promote_reactivate = promoted.reactivate;
		try { dest.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* memory / no WAL */ }
	} finally {
		dest.close();
	}

	const keys = Object.keys(written);
	if (!keys.length) {
		console.log(`    ${c.dim('(no rows were inserted — already present)')}`);
	} else {
		for (const table of keys) {
			console.log(`    ${c.green('✓')} ${table.padEnd(34)} ${String(written[table]).padStart(6)} written`);
		}
	}

	console.log(`\n  ${c.green(c.bold('Done.'))} Product catalog restored. Shops / orders / tokens were not.\n`);
}

module.exports = {
	RestoreError,
	DEFAULT_ARCHIVED_SHOP_IDS,
	NEVER_RESTORE_TABLES,
	LISTING_COPY_TABLES,
	MANUAL_SHOP_ID,
	CATALOG_ARCHIVE_SHOP_ID,
	parseArgs,
	normalizeTitle,
	findDefaultCatalogBackup,
	listCatalogBackups,
	resolveSourceShops,
	resolveAllHistoryShops,
	planRestore,
	applyRestore,
	promoteListingsToProductMap,
	totalInserts,
};

if (require.main === module) {
	main().catch((err) => {
		if (err instanceof RestoreError) {
			console.error(`\n  ${c.red('✗')} ${err.message}\n`);
			process.exit(1);
		}
		console.error(`\n  ${c.red('Unexpected error:')} ${err.stack || err.message}\n`);
		process.exit(1);
	});
}
