'use strict';

/**
 * Smoke test — validates every shop that has tokens in tokens.json.
 *
 * Tests the full production path per shop:
 *   1. Proxy chain resolves to expected exit IP (once per group)
 *   2. Access token obtained/refreshed via proxy (TokenManager)
 *   3. Etsy API ping confirms x-api-key format is accepted
 *   4. GET /application/shops/{shop_id} returns shop metadata
 *   5. GET /application/shops/{shop_id}/receipts fetches recent orders
 *   6. Receipts written to etsy_dashboard.db via upsertReceipt
 *   7. DB read-back confirms rows landed correctly
 *
 * Run: node scripts/smoke-test.js
 *
 * Prerequisites: VPN + IPFoxy active, tokens.json populated for at least one shop.
 */

const path = require('path');
const { loadConfig, getAllShops, findShopContext, usesGroupProxy } = require('../src/config/schema');
const { TokenManager } = require('../src/auth/token-manager');
const { createGroupProxyClient, verifyGroupProxy } = require('../src/proxy/factory');
const { buildShopClient, ping, getShop, getReceipts } = require('../src/etsy/client');
const { initDb, syncConfigToDb, upsertReceipt } = require('../src/db/setup');

const TOKENS_PATH = path.resolve(__dirname, '../tokens.json');
const RECEIPT_LIMIT  = 5; // fetch only 5 receipts per shop to stay well inside QPD budget

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pass(msg)  { return `  ✓  ${msg}`; }
function fail(msg)  { return `  ✗  ${msg}`; }
function info(msg)  { return `     ${msg}`; }
function ms(n)      { return `${n}ms`; }

function printSeparator(char = '─', width = 72) {
  console.log('  ' + char.repeat(width));
}

// ─── Per-shop test ─────────────────────────────────────────────────────────────

async function testShop(shopCtx, tokenManager, proxyClient, db) {
  const { shop, group } = shopCtx;
  const start = Date.now();
  const lines = [];

  try {
    // ── Step 1: Token refresh via proxy ────────────────────────────────────────
    let accessToken;
    try {
      accessToken = await tokenManager.getAccessToken(
        shop.shop_id,
        shop.api_key,
        shop.refresh_token ?? null,
        proxyClient
      );
      lines.push(pass(`Token      valid (refreshed through proxy if needed)`));
    } catch (err) {
      lines.push(fail(`Token      FAILED: ${err.message}`));
      return { ok: false, elapsed: Date.now() - start, lines };
    }

    // ── Step 2: Build authenticated shop client ────────────────────────────────
    const shopClient = buildShopClient(proxyClient, shop.api_key, shop.shared_secret, accessToken);

    // ── Step 3: API ping (validates x-api-key format) ─────────────────────────
    try {
      const pong = await ping(shopClient);
      lines.push(pass(`API ping   accepted  (application_id: ${pong.application_id})`));
    } catch (err) {
      const status = err.response?.status ?? '—';
      const detail = err.response?.data?.error_description ?? err.message;
      lines.push(fail(`API ping   HTTP ${status}: ${detail}`));
      if (status === 401 || status === 403) {
        lines.push(info('           → Check that x-api-key = keystring:shared_secret in config.json'));
      }
      return { ok: false, elapsed: Date.now() - start, lines };
    }

    // ── Step 4: Shop info (validates shop_id resolves + shops_r scope) ────────
    let shopData;
    try {
      shopData = await getShop(shopClient, shop.shop_id);
      lines.push(pass(
        `Shop info  name="${shopData.shop_name}"  ` +
        `currency=${shopData.currency_code}  ` +
        `active_listings=${shopData.listing_active_count ?? 0}`
      ));
    } catch (err) {
      const status = err.response?.status ?? '—';
      const detail = err.response?.data?.error ?? err.message;
      lines.push(fail(`Shop info  HTTP ${status}: ${detail}`));
      if (status === 404) {
        lines.push(info(`           → shop_id "${shop.shop_id}" not found — verify it matches the Etsy shop URL`));
      }
      return { ok: false, elapsed: Date.now() - start, lines };
    }

    // ── Step 5: Receipts fetch (validates transactions_r scope) ───────────────
    let fetchedReceipts = [];
    try {
      const result = await getReceipts(shopClient, shop.shop_id, { limit: RECEIPT_LIMIT });
      fetchedReceipts = result.results ?? [];
      lines.push(pass(`Receipts   fetched ${fetchedReceipts.length} (of ${result.count ?? '?'} total on Etsy)`));
    } catch (err) {
      const status = err.response?.status ?? '—';
      const detail = err.response?.data?.error ?? err.message;
      lines.push(fail(`Receipts   HTTP ${status}: ${detail}`));
      if (status === 403) {
        lines.push(info(`           → Missing transactions_r scope — re-run oauth:setup for this shop`));
      }
      return { ok: false, elapsed: Date.now() - start, lines };
    }

    // ── Step 6: Write to SQLite ────────────────────────────────────────────────
    let written = 0;
    try {
      for (const receipt of fetchedReceipts) {
        upsertReceipt(db, shop.shop_id, group.group_id, receipt);
        written++;
      }
      lines.push(pass(`DB write   ${written} receipts written to etsy_dashboard.db`));
    } catch (err) {
      lines.push(fail(`DB write   FAILED: ${err.message}`));
      return { ok: false, elapsed: Date.now() - start, lines };
    }

    // ── Step 7: DB read-back verification ─────────────────────────────────────
    try {
      const row = db.prepare('SELECT COUNT(*) AS c FROM receipts WHERE shop_id = ?').get(shop.shop_id);
      lines.push(pass(`DB verify  ${row.c} receipts total in DB for this shop`));
    } catch (err) {
      lines.push(fail(`DB verify  FAILED: ${err.message}`));
      return { ok: false, elapsed: Date.now() - start, lines };
    }

    return { ok: true, elapsed: Date.now() - start, lines, shopData, written };

  } catch (err) {
    lines.push(fail(`Unexpected error: ${err.message}`));
    return { ok: false, elapsed: Date.now() - start, lines };
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n' + '═'.repeat(74));
  console.log('  Etsy Dashboard — Smoke Test');
  console.log('═'.repeat(74));

  // Load config
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`\n  Config error: ${err.message}\n`);
    process.exit(1);
  }

  // Load token manager
  const tokenManager = new TokenManager(TOKENS_PATH);

  // Find shops that have tokens
  const allShops = getAllShops(config);
  const shopsTested = allShops.filter((s) => tokenManager.hasTokens(s.shop_id));

  if (shopsTested.length === 0) {
    console.error('\n  No shops have tokens yet. Run: npm run oauth:setup\n');
    process.exit(1);
  }

  console.log(`\n  ${shopsTested.length} shop(s) to test (have tokens in tokens.json):`);
  shopsTested.forEach((s, i) =>
    console.log(`    ${i + 1}. ${s.shop_name.padEnd(28)} ${s.group_label}`)
  );

  // Open SQLite DB and sync config → ensures every shop in config has a DB row
  let db;
  try {
    db = initDb(config.db_path);
    syncConfigToDb(db, config);
  } catch (err) {
    console.error(`\n  DB error: ${err.message}\n`);
    process.exit(1);
  }

  // Verify proxy chains (once per group)
  console.log('\n  Verifying proxy chains...\n');
  const proxyClients = new Map();  // group_id → axios instance
  const proxyIPs = new Map();      // group_id → exit IP
  const groupIds = [...new Set(shopsTested.map((s) => s.group_id))];

  for (const groupId of groupIds) {
    const group = config.groups.find((g) => g.group_id === groupId);
    try {
      const exitIp = await verifyGroupProxy(group, config.vpn_local_port);
      proxyIPs.set(groupId, exitIp);
      proxyClients.set(groupId, createGroupProxyClient(group, config.vpn_local_port));
      const routeLabel = usesGroupProxy(group) ? 'Proxy' : 'Direct';
      console.log(pass(`${routeLabel} [${groupId}]  exit IP = ${exitIp}`));
    } catch (err) {
      console.log(fail(`Network [${groupId}]  FAILED: ${err.message}`));
      if (usesGroupProxy(group)) {
        console.log(info('  → Is your VPN connected? Is IPFoxy active?'));
      }
      console.log('');
      // Still continue — we'll report failure per shop for this group
      proxyClients.set(groupId, null);
    }
  }

  // Run per-shop tests
  let passed = 0;
  let failed = 0;

  for (let i = 0; i < shopsTested.length; i++) {
    const shop = shopsTested[i];
    const groupCtx = findShopContext(config, shop.shop_id);
    const proxyClient = proxyClients.get(shop.group_id);

    console.log('');
    printSeparator();
    console.log(
      `  [${i + 1}/${shopsTested.length}]  ${shop.shop_name.padEnd(26)}` +
      `  group: ${shop.group_id}`
    );
    console.log(info(`API key:   ${shop.api_key.slice(0, 8)}...  ` +
      `exit IP: ${proxyIPs.get(shop.group_id) ?? '(proxy failed)'}`));
    console.log('');

    if (!proxyClient) {
      console.log(fail('SKIPPED — proxy chain failed for this group'));
      failed++;
      continue;
    }

    const result = await testShop(groupCtx, tokenManager, proxyClient, db);
    result.lines.forEach((l) => console.log(l));

    const elapsed = ms(result.elapsed);
    if (result.ok) {
      console.log('');
      console.log(`  ✓  PASS  (${elapsed})`);
      passed++;
    } else {
      console.log('');
      console.log(`  ✗  FAIL  (${elapsed})`);
      failed++;
    }
  }

  // Summary
  console.log('');
  printSeparator('═');
  const totalReceipts = db.prepare('SELECT COUNT(*) AS c FROM receipts').get().c;
  console.log(`  DB total:  ${totalReceipts} receipts across all shops in etsy_dashboard.db`);
  printSeparator();
  console.log(`  Result:    ${passed}/${shopsTested.length} PASSED  |  ${failed} FAILED`);

  if (failed === 0) {
    console.log('');
    console.log('  All tests passed. OAuth tokens, proxy routing, and DB writes are working.');
    console.log('  Next: run oauth:setup for the remaining shops, then re-run this test.');
  } else {
    console.log('');
    console.log('  One or more shops failed. Review errors above before proceeding.');
  }
  console.log('');

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n  Fatal error:', err.message);
  process.exit(1);
});
