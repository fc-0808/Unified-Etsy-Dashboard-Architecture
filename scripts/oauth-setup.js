'use strict';

/**
 * One-time OAuth 2.0 setup wizard for each Etsy shop.
 *
 * Run this script ONCE for each shop inside its correct AdsPower browser profile
 * while the group's IPFoxy IP is active. This ensures the token is bound to the
 * same IP identity that will make all future API calls.
 *
 * What this script does:
 *   1. Lists all unauthenticated shops from config.json
 *   2. Lets you choose a shop to authenticate
 *   3. Generates the PKCE code challenge + OAuth URL
 *   4. Starts a local callback server on port 3003
 *   5. You open the URL in your browser (AdsPower profile for that group)
 *   6. After you authorize, Etsy redirects to localhost:3003/oauth/redirect
 *   7. The script exchanges the auth code for access_token + refresh_token
 *   8. Saves tokens to tokens.json (gitignored)
 *
 * Run: npm run oauth:setup
 *
 * OpSec note: Run this from within the correct AdsPower profile's browser,
 * NOT your system browser. The OAuth authorization page must be visited from
 * the group's designated IPFoxy IP to avoid linking the token to your home IP.
 *
 * IMPORTANT: For proxied groups this script routes BOTH the API-key ping and the
 * authorization-code → token exchange through the group's VPN→IPFoxy chain — the
 * exact same path the running dashboard uses for token refresh and every API call.
 * This guarantees Etsy only ever sees the group's single static residential IP for
 * a shop, from the very first grant onward (never the operator's home IP). The VPN
 * (localhost:vpn_local_port) must therefore be running when you set up a proxied
 * shop; the script fails closed with a clear message if the chain is unreachable.
 * Direct groups (proxy: "direct") intentionally use no proxy.
 *
 * Required scopes (what we request):
 *   transactions_r  — read orders and receipts
 *   transactions_w  — create shipment tracking (mark orders as shipped)
 *   shops_r         — read shop info
 *   shops_w         — update shop settings
 *   listings_r      — read all listings including inactive
 *   listings_w      — create and edit listings
 *   listings_d      — delete listings
 */

// Load .env so PORT (and any other overrides) match what the running server
// uses — the post-OAuth hot-reload notification must hit the same port the
// dashboard actually listens on.
require('dotenv').config();

const crypto = require('crypto');
const http = require('http');
const path = require('path');
const readline = require('readline');
const axios = require('axios');
const { loadConfig, getAllShops, findShopContext, usesGroupProxy } = require('../src/config/schema');
const { TokenManager } = require('../src/auth/token-manager');
const { createGroupProxyClient, verifyGroupProxy } = require('../src/proxy/factory');

const REDIRECT_URI = 'http://localhost:3003/oauth/redirect';
const CALLBACK_PORT = 3003;
const ETSY_TOKEN_URL = 'https://api.etsy.com/v3/public/oauth/token';
const ETSY_OAUTH_URL = 'https://www.etsy.com/oauth/connect';

// Scopes required for this dashboard.
// NOTE: Etsy's public OAuth v3 does NOT expose conversation scopes.
// The messaging feature uses existing tokens with the scopes below.
// If the undocumented conversation endpoints are accessible, they work
// with these scopes. If not, the UI degrades gracefully with an "Open on Etsy"
// fallback link directly to the conversation thread.
const REQUIRED_SCOPES = [
  'transactions_r',
  'transactions_w',
  'shops_r',
  'shops_w',
  'listings_r',
  'listings_w',
  'listings_d',
].join(' ');

// ─── PKCE helpers ─────────────────────────────────────────────────────────────

function base64URLEncode(buffer) {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function generatePKCE() {
  const codeVerifier = base64URLEncode(crypto.randomBytes(32));
  const codeChallenge = base64URLEncode(
    crypto.createHash('sha256').update(codeVerifier).digest()
  );
  const state = base64URLEncode(crypto.randomBytes(16));
  return { codeVerifier, codeChallenge, state };
}

// ─── Interactive shop selector ────────────────────────────────────────────────

async function selectShop(config, tokenManager) {
  const allShops = getAllShops(config);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const question = (q) => new Promise((res) => rl.question(q, res));

  console.log('\n  Shops in config.json:\n');
  console.log(
    '  #   Shop Name               Owner Email                      Group             Status'
  );
  console.log('  ' + '─'.repeat(95));

  allShops.forEach((shop, i) => {
    const hasToken  = tokenManager.hasTokens(shop.shop_id) ? '✓ done' : '✗ needs setup';
    const num       = `[${i + 1}]`.padEnd(4);
    const name      = (shop.shop_name || shop.shop_id).padEnd(24);
    const email     = (shop.owner_email || '(no email in config)').padEnd(33);
    const group     = shop.group_label.padEnd(18);
    console.log(`  ${num}${name}${email}${group}${hasToken}`);
  });

  console.log('');
  console.log('  TIP: Before clicking the OAuth URL, open a new INCOGNITO browser window');
  console.log('       and log into Etsy.com with the "Owner Email" shown above for that shop.');
  console.log('');

  const answer = await question('  Enter the number of the shop to authenticate (or q to quit): ');
  rl.close();

  if (answer.toLowerCase() === 'q') return null;

  const idx = parseInt(answer, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= allShops.length) {
    console.error('  Invalid selection.');
    return null;
  }
  return allShops[idx];
}

// ─── Local callback server ────────────────────────────────────────────────────

/**
 * Start a temporary local HTTP server to capture the OAuth redirect.
 * Returns a Promise that resolves with the authorization code.
 *
 * @param {string} expectedState - CSRF protection: must match the state in the redirect
 * @returns {Promise<string>} The authorization code
 */
function waitForAuthCode(expectedState) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url.startsWith('/oauth/redirect')) {
        res.writeHead(404);
        res.end();
        return;
      }

      const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<h2>Authorization Failed</h2><p>${error}: ${url.searchParams.get('error_description')}</p>`);
        server.close();
        reject(new Error(`Etsy authorization error: ${error} — ${url.searchParams.get('error_description')}`));
        return;
      }

      if (state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h2>State Mismatch</h2><p>CSRF check failed. Try running oauth:setup again.</p>');
        server.close();
        reject(new Error('State mismatch — possible CSRF attack. Run setup again.'));
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h2>No Code</h2><p>No authorization code received.</p>');
        server.close();
        reject(new Error('No authorization code in redirect URL.'));
        return;
      }

      // Success page shown in the browser after authorization
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html><body style="font-family:sans-serif;padding:40px;max-width:500px;margin:0 auto">
          <h2 style="color:#2E7D32">Authorization Successful</h2>
          <p>You can close this tab and return to the terminal.</p>
          <p style="color:#666;font-size:13px">Tokens have been saved to tokens.json.</p>
        </body></html>
      `);

      server.close();
      resolve(code);
    });

    server.listen(CALLBACK_PORT, () => {
      console.log(`\n  Callback server listening at http://localhost:${CALLBACK_PORT}/oauth/redirect`);
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('OAuth timeout — no redirect received within 5 minutes.'));
    }, 5 * 60 * 1000);
  });
}

// ─── API key preflight ─────────────────────────────────────────────────────────

/**
 * Verify the Etsy app keystring + shared secret are active before OAuth.
 * Pending or mis-copied keys return 403 and produce "application not recognized" in the browser.
 *
 * @param {string} keystring
 * @param {string} sharedSecret
 * @param {import('axios').AxiosInstance} [proxyClient] - Group proxy client for
 *        proxied groups so this preflight egresses on the same IP as every other
 *        call for this shop. Falls back to a direct connection when omitted.
 * @returns {Promise<number>} application_id from openapi-ping
 */
async function verifyApiKeyActive(keystring, sharedSecret, proxyClient) {
  try {
    const client = proxyClient ?? axios;
    const { data } = await client.get('https://api.etsy.com/v3/application/openapi-ping', {
      baseURL: '', // full URL — don't prepend the proxy client's /v3 baseURL
      headers: { 'x-api-key': `${keystring}:${sharedSecret}` },
      timeout: 15_000,
    });
    return data.application_id;
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data?.error ?? err.message;
    if (status === 403 || status === 401) {
      throw new Error(
        `Etsy rejected this app's API credentials (HTTP ${status}: ${detail}).\n\n` +
          `  This is why the browser shows "application is not recognized".\n\n` +
          `  Check https://www.etsy.com/developers/your-apps for this shop's app:\n` +
          `    1. Status must be Approved (not Pending Approval).\n` +
          `    2. Re-copy keystring + shared secret (eye icon) into config.json.\n` +
          `    3. Callback URL on THIS app must be exactly:\n` +
          `       ${REDIRECT_URI}\n`
      );
    }
    throw new Error(`Could not reach Etsy to verify API key: ${detail}`);
  }
}

// ─── Token exchange ────────────────────────────────────────────────────────────

async function exchangeCodeForTokens(keystring, authCode, codeVerifier, proxyClient) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: keystring,
    redirect_uri: REDIRECT_URI,
    code: authCode,
    code_verifier: codeVerifier,
  });

  // Route through the group proxy (when supplied) so the token grant is bound to
  // the SAME residential IP as the browser authorization and all future refreshes
  // — never the operator's home IP.
  const client = proxyClient ?? axios;
  const { data } = await client.post(ETSY_TOKEN_URL, body.toString(), {
    baseURL: '', // full URL — don't prepend the proxy client's /v3 baseURL
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return data;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n' + '═'.repeat(65));
  console.log('  Etsy Dashboard — OAuth 2.0 Setup Wizard');
  console.log('═'.repeat(65));

  console.log(`
  OpSec — proxied groups (socks5:// in config.json):
  ─────────────────────────────────────────────────────────────
  When the OAuth URL opens, visit it from the AdsPower profile
  for that shop's group, with that group's IPFoxy proxy active.

  Direct groups (proxy: "direct"): use a normal browser logged in
  as the shop owner. No VPN or IPFoxy required for those shops.
  ─────────────────────────────────────────────────────────────
`);

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`\n  Config error: ${err.message}\n`);
    process.exit(1);
  }

  const tokensPath = path.resolve(__dirname, '../tokens.json');
  const tokenManager = new TokenManager(tokensPath);
  const shop = await selectShop(config, tokenManager);
  if (!shop) process.exit(0);

  const shopCtx = findShopContext(config, shop.shop_id);
  const isDirect = shopCtx && !usesGroupProxy(shopCtx.group);

  console.log(`\n  Setting up OAuth for: ${shop.shop_name} (${shop.shop_id})`);
  console.log(`  Owner email:  ${shop.owner_email || 'not set in config'}`);
  console.log(`  Group:        ${shop.group_label}`);
  console.log(`  Routing:      ${isDirect ? 'direct (no proxy)' : 'VPN → IPFoxy proxy'}`);
  console.log(`  API key:      ${shop.api_key.slice(0, 8)}...`);

  // Build the SAME network path the runtime uses for this shop. Proxied groups
  // route the ping + token exchange through the group's VPN→IPFoxy chain so Etsy
  // only ever sees the group's static residential IP — identical to token refresh
  // and every API call. Doing the exchange over the operator's home IP instead
  // would bind the initial grant to a different IP than every later call (and, if
  // all shops are set up from one machine, link them to a shared IP). Fail closed
  // if the chain is unreachable rather than silently falling back to the home IP.
  let proxyClient = null;
  if (!isDirect) {
    console.log('\n  Verifying the group proxy chain (VPN → IPFoxy)...');
    try {
      const egressIp = await verifyGroupProxy(shopCtx.group, config.vpn_local_port);
      proxyClient = createGroupProxyClient(shopCtx.group, config.vpn_local_port);
      console.log(`  ✓ Proxy verified — Etsy will see exit IP ${egressIp}`);
      console.log('  ► Confirm this IP matches the AdsPower profile you authorize in.');
    } catch (err) {
      console.error(
        `\n  ✗ Could not reach this group's proxy chain: ${err.message}\n\n` +
          `  Start the VPN (localhost:${config.vpn_local_port}) and make sure the group's\n` +
          `  IPFoxy proxy is active, then re-run oauth:setup. Refusing to continue so the\n` +
          `  token is never exchanged over the wrong IP.\n`
      );
      process.exit(1);
    }
  }

  console.log('\n  Verifying API key with Etsy (openapi-ping)...');
  try {
    const appId = await verifyApiKeyActive(shop.api_key, shop.shared_secret, proxyClient);
    console.log(`  ✓ API key active — application_id ${appId}`);
  } catch (err) {
    console.error(`\n  ${err.message}\n`);
    process.exit(1);
  }
  console.log('');
  console.log('  ► Open a NEW INCOGNITO browser window NOW.');
  console.log(`  ► Log into Etsy.com as: ${shop.owner_email || 'the shop owner'}`);
  if (!isDirect) {
    console.log('  ► Use the AdsPower profile + IPFoxy IP for this group (see OpSec note above).');
  }
  console.log('  ► Then open the OAuth URL below in that same incognito window.');

  // Generate PKCE values
  const { codeVerifier, codeChallenge, state } = generatePKCE();

  // Build OAuth URL
  const oauthParams = new URLSearchParams({
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: REQUIRED_SCOPES,
    client_id: shop.api_key,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  const oauthUrl = `${ETSY_OAUTH_URL}?${oauthParams.toString()}`;

  console.log('\n  ─────────────────────────────────────────────────────────');
  console.log('  Requested scopes:');
  REQUIRED_SCOPES.split(' ').forEach((s) => console.log(`    • ${s}`));
  console.log('\n  OAuth URL (open this in the AdsPower profile for this group):');
  console.log('\n  ' + oauthUrl);
  console.log('\n  ─────────────────────────────────────────────────────────');
  console.log('\n  Waiting for authorization...');

  let authCode;
  try {
    authCode = await waitForAuthCode(state);
  } catch (err) {
    console.error(`\n  Authorization failed: ${err.message}\n`);
    process.exit(1);
  }

  console.log('\n  Authorization code received. Exchanging for tokens...');

  let tokenData;
  try {
    tokenData = await exchangeCodeForTokens(shop.api_key, authCode, codeVerifier, proxyClient);
  } catch (err) {
    const desc = err.response?.data?.error_description ?? err.message;
    console.error(`\n  Token exchange failed: ${desc}\n`);
    process.exit(1);
  }

  // Record the granted scopes (Etsy grants exactly what was approved here) so the
  // app can pre-flight permission errors later. Prefer the scope echoed by Etsy,
  // else the scopes we requested.
  tokenManager.storeTokens(shop.shop_id, {
    ...tokenData,
    scopes: tokenData.scope ? String(tokenData.scope).trim().split(/\s+/) : REQUIRED_SCOPES.split(' '),
  });

  console.log('\n  ═══════════════════════════════════════════════════════════');
  console.log('  SUCCESS — Tokens saved to tokens.json');
  console.log('  ═══════════════════════════════════════════════════════════');
  console.log(`\n  Shop:          ${shop.shop_name}`);
  console.log(`  User ID:       ${tokenData.access_token.split('.')[0]}`);
  console.log(`  Access token:  valid for 1 hour (auto-refreshed by TokenManager)`);
  console.log(`  Refresh token: valid for 90 days`);
  console.log(`\n  tokens.json is gitignored — it will never be committed.`);
  console.log(`\n  Run 'npm run oauth:setup' again to authenticate the next shop.\n`);

  // Hot-reload the running server so it picks up the new token immediately,
  // without requiring a PM2 restart. The dashboard listens on PORT (default
  // 4000 — see src/server/index.js), so the notification MUST target the same
  // port or the server keeps serving its stale in-memory token store.
  const serverPort = Number(process.env.PORT) || 4000;
  const reloaded = await new Promise((resolve) => {
    const req = http.request(
      { hostname: 'localhost', port: serverPort, path: '/api/admin/reload-tokens', method: 'POST', timeout: 3000 },
      (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      }
    );
    req.on('error', () => resolve(false)); // server not running — handled below
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });

  if (reloaded) {
    console.log(`  ✓ Running server notified on port ${serverPort} — tokens reloaded, no restart needed.\n`);
  } else {
    console.log(
      `  ⚠ Could not reach a running dashboard on port ${serverPort} to hot-reload tokens.\n` +
      `    If the dashboard is open, restart it (or set PORT in .env to match) so it\n` +
      `    picks up the new token. Newly-started servers load tokens.json automatically.\n`
    );
  }
}

main().catch((err) => {
  console.error('\n  Unexpected error:', err.message);
  process.exit(1);
});
