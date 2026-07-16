'use strict';

/**
 * Shop offboarding tool — permanently remove ONE Etsy shop and all of its data
 * from this dashboard (config.json, tokens.json and the SQLite database).
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
 *   • Atomic. Every database delete runs inside a single transaction — it either
 *     all applies or nothing does. A crash mid-way can never leave a half-deleted
 *     shop behind.
 *   • Reversible. Before mutating, it snapshots config.json, tokens.json and the
 *     database to timestamped backups, so a mistake is one copy away from undo.
 *   • Complete. It walks the full ownership graph — rows keyed directly by
 *     shop_id, rows reachable through the shop's receipts (line items, issues,
 *     exchanges, route assignments…) and through its listings (inventory, image
 *     caches, per-variant overrides), plus name/key-scoped tables (events, bulk
 *     jobs, listing settings). A dynamic backstop sweeps any future shop-scoped
 *     table so this never silently goes stale as the schema grows.
 *   • Surgical. It keys strictly off the ONE shop's id/name. Shops that merely
 *     share an Etsy app key (api_key) are untouched — only per-shop data is removed.
 *   • Idempotent. Re-running after a successful removal is a clean no-op.
 *
 * USAGE
 * -----
 *   node scripts/remove-shop.js <shop_id>              # dry run (review only)
 *   node scripts/remove-shop.js <shop_id> --yes        # perform the removal
 *   npm run shop:remove -- <shop_id> --yes
 *
 * FLAGS
 *   --yes, --commit     Actually perform the removal (otherwise dry-run).
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
const { catalogDbPath } = require('../src/route/engine-paths');

const CONFIG_PATH = path.resolve(__dirname, '../config.json');
const TOKENS_PATH = path.resolve(__dirname, '../tokens.json');

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
	console.error(`\n  ${c.red('✗')} ${msg}\n`);
	process.exit(1);
}

function parseArgs(argv) {
	const flags = new Set();
	const positional = [];
	for (const a of argv) {
		if (a.startsWith('--')) flags.add(a);
		else positional.push(a);
	}
	return { shopId: positional[0], flags };
}

function tsStamp() {
	return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Back up a text file to "<file>.bak-<ts>" and return the backup path. */
function backupTextFile(filePath) {
	if (!fs.existsSync(filePath)) return null;
	const dest = `${filePath}.bak-${tsStamp()}`;
	fs.copyFileSync(filePath, dest);
	return dest;
}

/**
 * Ordered delete plan. Children first, parents last, so foreign-key-style
 * subqueries (receipts / listings / bulk_jobs) still resolve while running.
 *
 * Each step: { table, where, params }. `where` may reference @id (the shop_id)
 * and the dynamically-built name placeholders (@nm0, @nm1, …).
 *
 * @param {string} id           shop_id
 * @param {string[]} names      distinct identifiers to match name/key columns
 */
function buildPlan(id, names) {
	// Build "col IN (@nm0, @nm1, …)" with a matching params object.
	const nameParams = {};
	names.forEach((v, i) => { nameParams[`nm${i}`] = v; });
	const nameList = names.map((_, i) => `@nm${i}`).join(', ');
	const params = { id, ...nameParams };

	const receiptSub = `receipt_id IN (SELECT receipt_id FROM receipts WHERE shop_id = @id)`;
	const listingSub = `listing_id IN (SELECT listing_id FROM listings WHERE shop_id = @id)`;
	const bulkJobSub = `job_id IN (SELECT job_id FROM bulk_jobs WHERE shop_key IN (${nameList}) OR shop_name IN (${nameList}))`;

	const steps = [
		// Rows reachable through the shop's RECEIPTS (order line-item workflow).
		{ table: 'route_assignments', where: receiptSub },
		{ table: 'receipt_item_purchase', where: receiptSub },
		{ table: 'order_issues', where: receiptSub },
		{ table: 'order_exchanges', where: receiptSub },
		{ table: 'order_line_substitutions', where: receiptSub },

		// Rows reachable through the shop's LISTINGS (inventory + image caches).
		{ table: 'listing_inventory', where: listingSub },
		{ table: 'listing_images', where: listingSub },
		{ table: 'listing_image_data', where: listingSub },
		{ table: 'listing_phash', where: listingSub },
		{ table: 'listing_style_images', where: listingSub },

		// Bulk-create job items (reachable through bulk_jobs).
		{ table: 'bulk_job_items', where: bulkJobSub },

		// Rows keyed directly by shop_id.
		{ table: 'transactions', where: `shop_id = @id` },
		{ table: 'etsy_payments', where: `shop_id = @id` },
		{ table: 'ledger_entries', where: `shop_id = @id` },
		{ table: 'sync_log', where: `shop_id = @id` },
		{ table: 'receipts', where: `shop_id = @id` },
		{ table: 'listings', where: `shop_id = @id` },

		// Name / key scoped tables.
		{ table: 'events', where: `shop_name IN (${nameList})` },
		{ table: 'route_manual_items', where: `shop_name IN (${nameList})` },
		{ table: 'shop_listing_settings', where: `shop_key IN (${nameList})` },
		{ table: 'bulk_jobs', where: `shop_key IN (${nameList}) OR shop_name IN (${nameList})` },
	];

	return { steps, params };
}

/** Tables managed explicitly above — excluded from the dynamic backstop. */
const EXPLICIT_TABLES = new Set([
	'route_assignments', 'receipt_item_purchase', 'order_issues', 'order_exchanges',
	'order_line_substitutions', 'listing_inventory', 'listing_images', 'listing_image_data',
	'listing_phash', 'listing_style_images', 'bulk_job_items', 'transactions', 'etsy_payments',
	'ledger_entries', 'sync_log', 'receipts', 'listings', 'events', 'route_manual_items',
	'shop_listing_settings', 'bulk_jobs', 'shops', 'groups',
]);

const SHOP_LINK_COLUMNS = ['shop_id', 'shop_name', 'shop_key'];

/**
 * Discover any OTHER table carrying a shop-scoped column, so a shop-owned table
 * added to the schema in the future is still purged without editing this script.
 * Returns extra plan steps.
 */
function backstopSteps(db, id, names) {
	const nameList = names.map((_, i) => `@nm${i}`).join(', ');
	const tables = db
		.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
		.all()
		.map((r) => r.name)
		.filter((name) => !EXPLICIT_TABLES.has(name));

	const steps = [];
	for (const table of tables) {
		const cols = db.prepare(`PRAGMA table_info("${table}")`).all().map((col) => col.name);
		const clauses = [];
		if (cols.includes('shop_id')) clauses.push(`shop_id = @id`);
		if (cols.includes('shop_name')) clauses.push(`shop_name IN (${nameList})`);
		if (cols.includes('shop_key')) clauses.push(`shop_key IN (${nameList})`);
		if (clauses.length) steps.push({ table, where: clauses.join(' OR '), backstop: true });
	}
	return steps;
}

function countStep(db, step, params) {
	return db.prepare(`SELECT COUNT(*) AS n FROM "${step.table}" WHERE ${step.where}`).get(params).n;
}

async function main() {
	const { shopId, flags } = parseArgs(process.argv.slice(2));
	const commit = flags.has('--yes') || flags.has('--commit');
	const doDbBackup = !flags.has('--no-db-backup');
	const touchConfig = !flags.has('--keep-config');
	const touchTokens = !flags.has('--keep-tokens');
	const doReload = !flags.has('--no-reload');

	if (!shopId) {
		fail('Usage: node scripts/remove-shop.js <shop_id> [--yes] [--no-db-backup] [--keep-config] [--keep-tokens] [--no-reload]');
	}

	const config = loadConfig();

	// ── Resolve the shop from config (source of truth) ─────────────────────────
	let group = null;
	let shop = null;
	for (const g of config.groups) {
		const found = (g.shops || []).find((s) => s.shop_id === shopId);
		if (found) { group = g; shop = found; break; }
	}

	// Open the DB (readonly for the dry run; writable for the commit) and resolve
	// the shop_name from the DB too when config no longer has the shop.
	const dbPath = config.db_path;
	if (!fs.existsSync(dbPath)) fail(`Database not found at ${dbPath}.`);

	const roDb = new Database(dbPath, { readonly: true });
	const dbShop = roDb.prepare('SELECT shop_id, shop_name, group_id FROM shops WHERE shop_id = ?').get(shopId);

	const inTokens = fs.existsSync(TOKENS_PATH)
		&& Object.prototype.hasOwnProperty.call(JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8') || '{}'), shopId);

	if (!shop && !dbShop && !inTokens) {
		roDb.close();
		console.log(`\n  ${c.green('✓')} Shop ${c.bold(shopId)} is already absent from config.json, tokens.json and the database. Nothing to do.\n`);
		return;
	}

	// Distinct identifiers to match name/key-scoped columns.
	const shopName = shop?.shop_name || dbShop?.shop_name || shopId;
	const groupId = group?.group_id || dbShop?.group_id || null;
	const names = [...new Set([shopId, shopName])];

	const { steps: coreSteps, params } = buildPlan(shopId, names);
	const extraSteps = backstopSteps(roDb, shopId, names);
	const allSteps = [...coreSteps, ...extraSteps];

	// ── Report header ──────────────────────────────────────────────────────────
	console.log('');
	console.log(`  ${c.bold('Etsy shop offboarding')} ${commit ? c.red('· LIVE RUN') : c.yellow('· DRY RUN (no changes)')}`);
	console.log(`  ${c.dim('─'.repeat(62))}`);
	console.log(`  Shop id     : ${c.bold(shopId)}`);
	console.log(`  Shop name   : ${shopName}`);
	console.log(`  Group       : ${groupId ?? c.dim('(not in config)')}`);
	console.log(`  In config   : ${shop ? c.green('yes') : c.dim('no')}`);
	console.log(`  In tokens   : ${inTokens ? c.green('yes') : c.dim('no')}`);
	console.log(`  In database : ${dbShop ? c.green('yes') : c.dim('no')}`);
	if (shop) {
		const masked = `${String(shop.api_key || '').slice(0, 6)}…`;
		const sharers = (group.shops || []).filter((s) => s.shop_id !== shopId && s.api_key === shop.api_key).map((s) => s.shop_id);
		console.log(`  App key     : ${masked} ${sharers.length ? c.yellow(`(shared with ${sharers.join(', ')} — those shops are NOT affected)`) : ''}`);
	}
	console.log('');

	// ── Row counts (the blast radius) ────────────────────────────────────────
	console.log(`  ${c.bold('Database rows targeted:')}`);
	let total = 0;
	const nonZero = [];
	for (const step of allSteps) {
		const n = countStep(roDb, step, params);
		if (n > 0) {
			nonZero.push([step.table, n, step.backstop]);
			total += n;
		}
	}
	if (nonZero.length === 0) {
		console.log(`    ${c.dim('(no data rows found)')}`);
	} else {
		for (const [table, n, isBackstop] of nonZero) {
			const tag = isBackstop ? c.yellow(' [dynamic]') : '';
			console.log(`    ${table.padEnd(26)} ${String(n).padStart(6)}${tag}`);
		}
	}
	console.log(`    ${c.dim('─'.repeat(34))}`);
	console.log(`    ${'TOTAL'.padEnd(26)} ${String(total).padStart(6)} row(s), plus the shop row`);
	roDb.close();

	console.log('');
	console.log(`  ${c.bold('Files:')}`);
	console.log(`    config.json  : ${touchConfig && shop ? c.red('remove shop entry') + (groupWouldEmpty(group, shopId) ? c.red(' + prune empty group') : '') : c.dim('unchanged')}`);
	console.log(`    tokens.json  : ${touchTokens && inTokens ? c.red('remove token entry') : c.dim('unchanged')}`);
	console.log('');

	if (!commit) {
		console.log(`  ${c.yellow('DRY RUN')} — nothing was changed.`);
		console.log(`  Re-run with ${c.bold('--yes')} to perform the removal.\n`);
		return;
	}

	// ── LIVE RUN ────────────────────────────────────────────────────────────
	// 1) Backups (reversibility).
	console.log(`  ${c.bold('Creating backups…')}`);
	if (doDbBackup) {
		const backupDir = path.join(path.dirname(dbPath), 'backups');
		fs.mkdirSync(backupDir, { recursive: true });
		const dbBackup = path.join(backupDir, `etsy_dashboard.pre-remove-${shopId}-${tsStamp()}.db`);
		const bkDb = new Database(dbPath, { readonly: true });
		await bkDb.backup(dbBackup);
		bkDb.close();
		console.log(`    database : ${c.dim(dbBackup)}`);
	} else {
		console.log(`    database : ${c.yellow('skipped (--no-db-backup)')}`);
	}
	if (touchConfig && shop) {
		const b = backupTextFile(CONFIG_PATH);
		if (b) console.log(`    config   : ${c.dim(b)}`);
	}
	if (touchTokens && inTokens) {
		const b = backupTextFile(TOKENS_PATH);
		if (b) console.log(`    tokens   : ${c.dim(b)}`);
	}

	// 2) Delete DB rows atomically.
	console.log(`\n  ${c.bold('Purging database…')}`);
	const db = new Database(dbPath);
	const deleted = {};
	const purge = db.transaction(() => {
		for (const step of allSteps) {
			const res = db.prepare(`DELETE FROM "${step.table}" WHERE ${step.where}`).run(params);
			if (res.changes > 0) deleted[step.table] = (deleted[step.table] || 0) + res.changes;
		}
		// The shop row itself.
		const shopRes = db.prepare('DELETE FROM shops WHERE shop_id = ?').run(shopId);
		if (shopRes.changes > 0) deleted['shops'] = shopRes.changes;

		// Prune the group if it now has no shops (and it is not the synthetic one).
		if (groupId && groupId !== '__manual__') {
			const remaining = db.prepare('SELECT COUNT(*) AS n FROM shops WHERE group_id = ?').get(groupId).n;
			if (remaining === 0) {
				const gRes = db.prepare('DELETE FROM groups WHERE group_id = ?').run(groupId);
				if (gRes.changes > 0) deleted['groups'] = gRes.changes;
			}
		}
	});
	purge();
	db.pragma('wal_checkpoint(TRUNCATE)');
	db.close();

	const deletedTables = Object.keys(deleted);
	if (deletedTables.length === 0) {
		console.log(`    ${c.dim('(no rows were present)')}`);
	} else {
		for (const t of deletedTables) {
			console.log(`    ${c.green('✓')} ${t.padEnd(26)} ${String(deleted[t]).padStart(6)} deleted`);
		}
	}

	// 3) Edit config.json (remove shop, prune empty group).
	if (touchConfig && shop) {
		const rewritten = removeShopFromConfigFile(CONFIG_PATH, shopId);
		console.log(`\n  ${c.green('✓')} config.json — removed ${c.bold(shopId)}${rewritten.groupPruned ? ` and pruned empty group "${rewritten.groupPruned}"` : ''}.`);
	}

	// 4) Edit tokens.json (remove token entry).
	if (touchTokens && inTokens) {
		removeShopFromTokensFile(TOKENS_PATH, shopId);
		console.log(`  ${c.green('✓')} tokens.json — removed OAuth tokens for ${c.bold(shopId)}.`);
	}

	// 5) Hot-reload a running dashboard so it drops the shop immediately.
	if (doReload) {
		const reloaded = await notifyReload();
		if (reloaded) console.log(`  ${c.green('✓')} Notified the running dashboard — it dropped the shop live (no restart needed).`);
		else console.log(`  ${c.dim('•')} No running dashboard detected on the configured port — it will pick up the change on next start.`);
	}

	console.log(`\n  ${c.green(c.bold('Done.'))} Shop ${c.bold(shopId)} has been fully removed.\n`);
}

/** True when removing shopId empties its config group. */
function groupWouldEmpty(group, shopId) {
	if (!group) return false;
	return (group.shops || []).filter((s) => s.shop_id !== shopId).length === 0;
}

/**
 * Rewrite config.json with the shop removed. If the shop's group becomes empty
 * it is removed too. Preserves the file's 2-space JSON style.
 * @returns {{ groupPruned: string|null }}
 */
function removeShopFromConfigFile(configPath, shopId) {
	const raw = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
	let groupPruned = null;
	for (const g of raw.groups || []) {
		const before = (g.shops || []).length;
		g.shops = (g.shops || []).filter((s) => s.shop_id !== shopId);
		if (g.shops.length !== before && g.shops.length === 0) groupPruned = g.group_id;
	}
	if (groupPruned) raw.groups = raw.groups.filter((g) => g.shops.length > 0);
	fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf8');
	return { groupPruned };
}

/** Remove a shop's entry from tokens.json (2-space JSON style). */
function removeShopFromTokensFile(tokensPath, shopId) {
	const store = JSON.parse(fs.readFileSync(tokensPath, 'utf8') || '{}');
	delete store[shopId];
	fs.writeFileSync(tokensPath, JSON.stringify(store, null, 2), 'utf8');
}

/** Best-effort POST /api/admin/reload-tokens to a locally running dashboard. */
function notifyReload() {
	const port = Number(process.env.PORT) || 4000;
	return new Promise((resolve) => {
		const req = http.request(
			{ hostname: 'localhost', port, path: '/api/admin/reload-tokens', method: 'POST', timeout: 3000 },
			(res) => { res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 300); }
		);
		req.on('error', () => resolve(false));
		req.on('timeout', () => { req.destroy(); resolve(false); });
		req.end();
	});
}

main().catch((err) => {
	console.error(`\n  ${c.red('Unexpected error:')} ${err.stack || err.message}\n`);
	process.exit(1);
});
