'use strict';

/**
 * Complete pending 4PX orders on Etsy.
 *
 * WHAT / WHY
 * ----------
 * When you bulk-create 4PX shipments, each order gets a real 4PX tracking number
 * stored on its receipt (fourpx_tracking_no / 4PX… tracking_code / consignment),
 * but the order is only marked SHIPPED on Etsy by a second step ("Complete orders
 * on Etsy"). If that second step is interrupted, you are left with orders that
 * have a genuine label but are still "Not shipped" on Etsy — late shipments,
 * which is exactly what hurts a shop.
 *
 * This tool finds every such order (has a 4PX shipment, is_shipped = 0, is a real
 * Etsy order) and completes it on Etsy with its OWN stored tracking number —
 * headless, no dashboard UI required. It reuses the exact same production path
 * the dashboard uses (per-group proxy chain, TokenManager, createReceiptShipment)
 * so OpSec (correct egress IP per group) is preserved.
 *
 * SAFETY (how a top team ships a bulk write)
 * ------------------------------------------
 *   • Dry-run by default — prints the plan; pass --yes to execute.
 *   • Paced — a short pause between each ship and a cooldown between chunks, so
 *     the burst of buyer ship-notifications stays human-like (anti-abuse).
 *   • Fail-closed proxy — a proxied group is verified once; if its exit IP can't
 *     be confirmed the whole group is skipped rather than shipped from a wrong IP.
 *   • Idempotent-ish — an order already shipped is skipped; a per-order Etsy error
 *     never blocks the rest; re-running only picks up what is still pending.
 *   • Mirrors local state exactly like the dashboard (is_shipped, tracking,
 *     shipment_notified_at, resets carrier confirmation for the tracking poller).
 *
 * USAGE
 *   node scripts/complete-4px-pending.js                 # dry run (review)
 *   node scripts/complete-4px-pending.js --yes           # do it
 *   node scripts/complete-4px-pending.js --yes --shop Y2KASEshop
 *   npm run complete:4px -- --yes
 *
 * FLAGS
 *   --yes, --commit        Actually complete the orders (otherwise dry-run).
 *   --shop <shop_id>       Only this shop.
 *   --limit <n>            Cap how many orders to complete this run.
 *   --per-request-ms <n>   Override pause between ships (default from guard).
 *   --inter-batch-ms <n>   Override cooldown between chunks (default from guard).
 *   --carrier <name>       Carrier label sent to Etsy (default "4PX").
 */

const path = require('path');
const Database = require('better-sqlite3');

const { loadConfig, usesGroupProxy } = require('../src/config/schema');
const { TokenManager } = require('../src/auth/token-manager');
const { buildShopClient, resolveShopId, createReceiptShipment } = require('../src/etsy/client');
const { createGroupProxyClient, verifyGroupProxy } = require('../src/proxy/factory');
const {
	BULK_SHIP_CHUNK_SIZE,
	BULK_SHIP_INTER_REQUEST_MS,
	BULK_SHIP_INTER_BATCH_MS,
	sleep,
} = require('../src/compliance/suspension-guard');

const TOKENS_PATH = path.resolve(__dirname, '../tokens.json');

const c = {
	dim: (s) => `\x1b[2m${s}\x1b[0m`,
	bold: (s) => `\x1b[1m${s}\x1b[0m`,
	red: (s) => `\x1b[31m${s}\x1b[0m`,
	green: (s) => `\x1b[32m${s}\x1b[0m`,
	yellow: (s) => `\x1b[33m${s}\x1b[0m`,
	cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

function parseArgs(argv) {
	const flags = new Set();
	const opts = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--shop') opts.shop = argv[++i];
		else if (a === '--limit') opts.limit = parseInt(argv[++i], 10);
		else if (a === '--per-request-ms') opts.perRequestMs = parseInt(argv[++i], 10);
		else if (a === '--inter-batch-ms') opts.interBatchMs = parseInt(argv[++i], 10);
		else if (a === '--carrier') opts.carrier = argv[++i];
		else if (a.startsWith('--')) flags.add(a);
	}
	return { flags, opts };
}

/** Pick the best 4PX tracking number for an order, mirroring the dashboard's rule. */
function pickTracking(row) {
	if (row.fourpx_tracking_no) return String(row.fourpx_tracking_no).trim();
	if (row.tracking_code && String(row.tracking_code).startsWith('4PX')) return String(row.tracking_code).trim();
	if (row.fourpx_consignment_no) return String(row.fourpx_consignment_no).trim();
	return '';
}

async function main() {
	const { flags, opts } = parseArgs(process.argv.slice(2));
	const commit = flags.has('--yes') || flags.has('--commit');
	const carrier = (opts.carrier || '4PX').trim();
	const perRequestMs = Number.isFinite(opts.perRequestMs) ? opts.perRequestMs : BULK_SHIP_INTER_REQUEST_MS;
	const interBatchMs = Number.isFinite(opts.interBatchMs) ? opts.interBatchMs : BULK_SHIP_INTER_BATCH_MS;

	const config = loadConfig();
	const db = new Database(config.db_path);
	const tokenManager = new TokenManager(TOKENS_PATH);

	// ── Find pending orders: has a 4PX shipment, not shipped on Etsy, real order ──
	const rows = db.prepare(`
		SELECT receipt_id, shop_id, group_id, status, is_shipped,
		       tracking_code, fourpx_tracking_no, fourpx_consignment_no,
		       fourpx_order_status
		FROM receipts
		WHERE is_shipped = 0
		  AND COALESCE(source, 'etsy') != 'manual'
		  AND (
		        fourpx_tracking_no IS NOT NULL
		     OR fourpx_consignment_no IS NOT NULL
		     OR tracking_code LIKE '4PX%'
		      )
		  AND status NOT IN ('Canceled','Cancelled','Fully Refunded','Fully refunded')
		ORDER BY receipt_id ASC
	`).all()
		.filter((r) => (opts.shop ? r.shop_id === opts.shop : true))
		.filter((r) => pickTracking(r));

	const pending = Number.isFinite(opts.limit) ? rows.slice(0, opts.limit) : rows;

	// Resolve shop/group config per order up front; drop orphans (shop removed from config).
	const shopIndex = new Map(); // shop_id -> { shopCfg, groupCfg }
	for (const group of config.groups) {
		for (const shop of group.shops) shopIndex.set(shop.shop_id, { shopCfg: shop, groupCfg: group });
	}
	const actionable = [];
	const orphaned = [];
	for (const r of pending) {
		const ctx = shopIndex.get(r.shop_id);
		if (!ctx) { orphaned.push(r); continue; }
		actionable.push({ ...r, ...ctx, tracking: pickTracking(r) });
	}

	// ── Report ────────────────────────────────────────────────────────────────
	console.log('');
	console.log(`  ${c.bold('Complete pending 4PX orders on Etsy')} ${commit ? c.red('· LIVE RUN') : c.yellow('· DRY RUN (no changes)')}`);
	console.log(`  ${c.dim('─'.repeat(64))}`);
	const byShop = {};
	for (const r of actionable) byShop[r.shop_id] = (byShop[r.shop_id] || 0) + 1;
	const shopLines = Object.entries(byShop).sort((a, b) => b[1] - a[1]);
	console.log(`  Pending Etsy orders with a 4PX label: ${c.bold(actionable.length)}`);
	for (const [shop, n] of shopLines) console.log(`    ${shop.padEnd(24)} ${String(n).padStart(4)}`);
	if (orphaned.length) console.log(`  ${c.yellow(`Skipping ${orphaned.length} order(s) whose shop is not in config.json`)}`);
	const chunks = Math.ceil(actionable.length / BULK_SHIP_CHUNK_SIZE);
	const etaSec = actionable.length > 1
		? Math.round(((actionable.length - 1) * perRequestMs + Math.max(0, chunks - 1) * interBatchMs) / 1000)
		: 0;
	console.log(`  Pacing: ${perRequestMs}ms/ship, ${interBatchMs}ms every ${BULK_SHIP_CHUNK_SIZE} — ~${Math.max(1, Math.round(etaSec / 60))} min`);
	console.log('');

	if (!actionable.length) {
		console.log(`  ${c.green('Nothing pending — every 4PX order is already completed on Etsy.')}\n`);
		db.close();
		return;
	}

	if (!commit) {
		console.log(`  ${c.yellow('DRY RUN')} — re-run with ${c.bold('--yes')} to complete these on Etsy.\n`);
		db.close();
		return;
	}

	// ── Execute: group-aware, proxy-verified, paced ─────────────────────────────
	const markShipped = db.prepare(
		`UPDATE receipts SET
		   is_shipped = 1,
		   tracking_code = ?,
		   carrier_name = ?,
		   status = 'Completed',
		   shipment_notified_at = COALESCE(shipment_notified_at, strftime('%s','now')),
		   carrier_confirmed_at = NULL,
		   tracking_checked_at = NULL
		 WHERE receipt_id = ?`
	);

	const groupProxyOk = new Map();     // group_id -> boolean (verified once)
	const shopClientCache = new Map();  // shop_id -> { client, numericShopId }
	let done = 0, failed = 0, skipped = 0;
	const failures = [];

	for (const [idx, o] of actionable.entries()) {
		// Chunk cooldown + inter-request pacing.
		if (idx > 0) {
			if (idx % BULK_SHIP_CHUNK_SIZE === 0) {
				console.log(`  ${c.dim(`— chunk boundary — cooling down ${Math.round(interBatchMs / 1000)}s —`)}`);
				await sleep(interBatchMs);
			} else {
				await sleep(perRequestMs);
			}
		}

		const proxied = usesGroupProxy(o.groupCfg);

		// Verify each proxied group's egress once; skip the group's orders on failure
		// (never ship from the wrong IP).
		if (proxied && !groupProxyOk.has(o.groupCfg.group_id)) {
			try {
				const ip = await verifyGroupProxy(o.groupCfg, config.vpn_local_port);
				groupProxyOk.set(o.groupCfg.group_id, true);
				console.log(`  ${c.cyan('proxy')} ${o.groupCfg.group_id} verified — exit IP ${ip}`);
			} catch (err) {
				groupProxyOk.set(o.groupCfg.group_id, false);
				console.error(`  ${c.red('proxy FAIL')} ${o.groupCfg.group_id}: ${err.message} — skipping this group's orders`);
			}
		}
		if (proxied && groupProxyOk.get(o.groupCfg.group_id) === false) {
			skipped++;
			continue;
		}

		try {
			// Build (and cache) an authenticated client per shop.
			let cached = shopClientCache.get(o.shop_id);
			if (!cached) {
				const proxyClient = createGroupProxyClient(o.groupCfg, config.vpn_local_port);
				const accessToken = await tokenManager.getAccessToken(
					o.shopCfg.shop_id, o.shopCfg.api_key, o.shopCfg.refresh_token ?? null, proxyClient
				);
				const client = buildShopClient(proxyClient, o.shopCfg.api_key, o.shopCfg.shared_secret, accessToken, null, {
					priority: 'critical',
					requireProxy: proxied,
				});
				const numericShopId = await resolveShopId(client, o.shopCfg.shop_id);
				cached = { client, numericShopId };
				shopClientCache.set(o.shop_id, cached);
			}

			await createReceiptShipment(cached.client, cached.numericShopId, o.receipt_id, {
				tracking_code: o.tracking,
				carrier_name: carrier,
			});
			markShipped.run(o.tracking, carrier, o.receipt_id);
			done++;
			console.log(`  ${c.green('✓')} #${o.receipt_id} ${o.shop_id.padEnd(22)} ${o.tracking}  ${c.dim(`(${done}/${actionable.length})`)}`);
		} catch (err) {
			const body = err.response?.data;
			const msg = (typeof body === 'object' ? body?.error_description || body?.error : null) || err.message;
			// Etsy rejects re-shipping an order already completed on their side — treat
			// that as "already done" and reconcile local state instead of a failure.
			if (/already/i.test(String(msg)) && /ship|track/i.test(String(msg))) {
				markShipped.run(o.tracking, carrier, o.receipt_id);
				done++;
				console.log(`  ${c.green('✓')} #${o.receipt_id} ${o.shop_id.padEnd(22)} already shipped on Etsy — reconciled`);
			} else {
				failed++;
				failures.push({ receipt_id: o.receipt_id, shop_id: o.shop_id, error: msg });
				console.error(`  ${c.red('✗')} #${o.receipt_id} ${o.shop_id.padEnd(22)} ${msg}`);
			}
		}
	}

	console.log('');
	console.log(`  ${c.bold('Summary')}`);
	console.log(`    Completed : ${c.green(done)}`);
	console.log(`    Failed    : ${failed ? c.red(failed) : failed}`);
	if (skipped) console.log(`    Skipped   : ${c.yellow(skipped)} (proxy not verified)`);
	if (failures.length) {
		console.log(`\n  ${c.bold('Failures (re-run to retry — completed orders are skipped):')}`);
		for (const f of failures) console.log(`    #${f.receipt_id} ${f.shop_id}: ${f.error}`);
	}
	console.log('');

	db.close();
}

main().catch((err) => {
	console.error(`\n  ${c.red('Unexpected error:')} ${err.stack || err.message}\n`);
	process.exit(1);
});
