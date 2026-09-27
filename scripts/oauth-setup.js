'use strict';

/**
 * One-time OAuth 2.0 setup wizard for each Etsy shop.
 *
 * What this script does:
 *   1. Lists all unauthenticated shops from config.json
 *   2. Lets you choose a shop to authenticate
 *   3. Generates the PKCE code challenge + OAuth URL
 *   4. Starts a local callback server on port 3003
 *   5. You open the URL in a browser signed in as the authorized shop owner
 *   6. After you authorize, Etsy redirects to localhost:3003/oauth/redirect
 *   7. The script exchanges the auth code for access_token + refresh_token
 *   8. Saves tokens to tokens.json (gitignored)
 *
 * Run: npm run oauth:setup
 *
 * For a configured proxied group, API-key checks and token exchange use that
 * route and fail closed if it is unavailable.
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
require('dotenv').config({ quiet: true });

const crypto = require('crypto');
const http = require('http');
const path = require('path');
const readline = require('readline');
const axios = require('axios');
const { loadConfig, getAllShops, findShopContext, usesGroupProxy } = require('../src/config/schema');
const { TokenManager } = require('../src/auth/token-manager');
const {
  createGroupProxyClient,
  describeGroupRoute,
  verifyGroupProxy,
} = require('../src/proxy/factory');
const { shopUserAgent } = require('../src/etsy/user-agent');

const REDIRECT_URI = 'http://localhost:3003/oauth/redirect';
const CALLBACK_PORT = 3003;
const ETSY_TOKEN_URL = 'https://api.etsy.com/v3/public/oauth/token';
const ETSY_OAUTH_URL = 'https://www.etsy.com/oauth/connect';

// Scopes required for this dashboard.
// Etsy's public OAuth v3 does not expose conversation scopes. Buyer messages are
// copied by the operator and pasted into Etsy manually; no undocumented endpoint
// is used.
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

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Interactive shop selector ────────────────────────────────────────────────

function parseShopArg() {
  const flagged = process.argv.find((a) => a.startsWith('--shop='));
  if (flagged) return flagged.slice('--shop='.length).trim();
  const idx = process.argv.indexOf('--shop');
  if (idx >= 0) return String(process.argv[idx + 1] || '').trim();
  return '';
}

async function selectShop(config, tokenManager) {
  const allShops = getAllShops(config);
  const shopArg = parseShopArg();
  if (shopArg) {
    const needle = shopArg.toLowerCase();
    const match = allShops.find(
      (s) => String(s.shop_id).toLowerCase() === needle || String(s.shop_name).toLowerCase() === needle
    );
    if (!match) {
      console.error(`\n  No shop in config.json matches --shop=${shopArg}\n`);
      return null;
    }
    return match;
  }

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
  let markListening;
  const listening = new Promise((resolve) => {
    markListening = resolve;
  });
  const codePromise = new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const server = http.createServer((req, res) => {
      if (!req.url.startsWith('/oauth/redirect')) {
        res.writeHead(404);
        res.end();
        return;
      }
      if (settled) {
        res.writeHead(409, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('This OAuth callback has already been consumed.');
        return;
      }

      const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');
      const errorDescription = url.searchParams.get('error_description') || '';

      // Validate state for success AND error callbacks before reflecting any
      // provider-controlled text or settling the flow.
      if (state !== expectedState) {
        res.writeHead(400, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
          'X-Content-Type-Options': 'nosniff',
        });
        res.end('<h2>State Mismatch</h2><p>CSRF check failed. Try running oauth:setup again.</p>');
        finish(new Error('State mismatch — possible CSRF attack. Run setup again.'));
        return;
      }

      if (error) {
        res.writeHead(400, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(`<h2>Authorization Failed</h2><p>${escapeHtml(error)}: ${escapeHtml(errorDescription)}</p>`);
        finish(new Error(`Etsy authorization error: ${error} — ${errorDescription}`));
        return;
      }

      if (!code) {
        res.writeHead(400, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
          'X-Content-Type-Options': 'nosniff',
        });
        res.end('<h2>No Code</h2><p>No authorization code received.</p>');
        finish(new Error('No authorization code in redirect URL.'));
        return;
      }

      // Success page shown in the browser after authorization
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(`
        <html><body style="font-family:sans-serif;padding:40px;max-width:500px;margin:0 auto">
          <h2 style="color:#2E7D32">Authorization Successful</h2>
          <p>You can close this tab and return to the terminal.</p>
          <p style="color:#666;font-size:13px">Authorization was received. The terminal will confirm after the token exchange is saved safely.</p>
        </body></html>
      `);

      finish(null, code);
    });

    function finish(err, code) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        if (server.listening) server.close();
      } catch {
        /* listen failures may leave no open server to close */
      }
      if (err) reject(err);
      else resolve(code);
    }

    server.once('error', (err) => {
      markListening();
      finish(err);
    });
    server.listen(CALLBACK_PORT, '127.0.0.1', () => {
      console.log(`\n  Callback server listening at http://localhost:${CALLBACK_PORT}/oauth/redirect`);
      markListening();
    });

    // Timeout after 15 minutes so the shop owner can sign in and approve scopes.
    timer = setTimeout(() => {
      finish(new Error('OAuth timeout — no redirect received within 15 minutes.'));
    }, 15 * 60 * 1000);
  });
  return { codePromise, listening };
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
 * @param {string|number} shopId
 * @returns {Promise<number>} application_id from openapi-ping
 */
async function verifyApiKeyActive(keystring, sharedSecret, proxyClient, shopId) {
  try {
    if (proxyClient?._proxyEnforced === true && !proxyClient._egressVerifiedAt) {
      throw new Error('Group-proxy egress has not passed its preflight check.');
    }
    const client = proxyClient ?? axios;
    const { data } = await client.get('https://api.etsy.com/v3/application/openapi-ping', {
      baseURL: '', // full URL — don't prepend the proxy client's /v3 baseURL
      headers: {
        'x-api-key': `${keystring}:${sharedSecret}`,
        'User-Agent': shopUserAgent(shopId),
      },
      proxy: false,
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

async function exchangeCodeForTokens(keystring, authCode, codeVerifier, proxyClient, shopId) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: keystring,
    redirect_uri: REDIRECT_URI,
    code: authCode,
    code_verifier: codeVerifier,
  });

  // Route through the configured group transport when supplied. This keeps
  // runtime networking deterministic; it does not alter Etsy authorization.
  if (proxyClient?._proxyEnforced === true && !proxyClient._egressVerifiedAt) {
    throw new Error('Group-proxy egress has not passed its preflight check.');
  }
  const client = proxyClient ?? axios;
  const { data } = await client.post(ETSY_TOKEN_URL, body.toString(), {
    baseURL: '', // full URL — don't prepend the proxy client's /v3 baseURL
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': shopUserAgent(shopId),
    },
    proxy: false,
    timeout: 30_000,
  });
  return data;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n' + '═'.repeat(65));
  console.log('  Etsy Dashboard — OAuth 2.0 Setup Wizard');
  console.log('═'.repeat(65));

  console.log(`
  Network check — proxied groups (socks5:// in config.json):
  ─────────────────────────────────────────────────────────────
  Complete OAuth in the browser as the shop owner. Proxied groups
  use that route for the API-key check and token exchange.
  ─────────────────────────────────────────────────────────────
`);

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`\n  Config error: ${err.message}\n`);
    process.exit(1);
  }

  const tokensPath = process.env.DASHBOARD_TOKENS_PATH
    ? path.resolve(process.env.DASHBOARD_TOKENS_PATH)
    : path.resolve(__dirname, '../tokens.json');
  const tokenManager = new TokenManager(tokensPath);
  const shop = await selectShop(config, tokenManager);
  if (!shop) process.exit(0);

  const shopCtx = findShopContext(config, shop.shop_id);
  const isDirect = shopCtx && !usesGroupProxy(shopCtx.group);

  console.log(`\n  Setting up OAuth for: ${shop.shop_name} (${shop.shop_id})`);
  console.log(`  Owner email:  ${shop.owner_email || 'not set in config'}`);
  console.log(`  Group:        ${shop.group_label}`);
  console.log(
    `  Routing:      ${isDirect ? 'direct (no proxy)' : describeGroupRoute(shopCtx.group, config.network_transport)}`
  );
  console.log(`  API key:      ${shop.api_key.slice(0, 8)}...`);

  // Build the SAME network path the runtime uses for this shop. Proxied groups
  // route the ping + token exchange through the configured group transport.
  // Fail closed if it is unavailable rather than silently changing egress.
  let proxyClient = null;
  if (!isDirect) {
    console.log('\n  Verifying the configured transport and group proxy...');
    try {
      const egressIp = await verifyGroupProxy(shopCtx.group, config.network_transport);
      proxyClient = createGroupProxyClient(shopCtx.group, config.network_transport);
      console.log(`  ✓ Proxy verified — Etsy will see exit IP ${egressIp}`);
      console.log('  ► Confirm this is the network route approved for this application.');
    } catch (err) {
      console.error(
        `\n  ✗ Could not reach this group's proxy chain: ${err.message}\n\n` +
          `  Start the configured VPN/TUN transport and make sure the group's\n` +
          `  configured proxy is active, then re-run oauth:setup. Refusing to continue\n` +
          `  rather than silently changing the application's network route.\n`
      );
      process.exit(1);
    }
  }

  console.log('\n  Verifying API key with Etsy (openapi-ping)...');
  try {
    const appId = await verifyApiKeyActive(shop.api_key, shop.shared_secret, proxyClient, shop.shop_id);
    console.log(`  ✓ API key active — application_id ${appId}`);
  } catch (err) {
    console.error(`\n  ${err.message}\n`);
    process.exit(1);
  }
  console.log('');
  console.log('  ► Open a browser window controlled by the authorized shop owner.');
  console.log(`  ► Log into Etsy.com as: ${shop.owner_email || 'the shop owner'}`);
  if (!isDirect) {
    console.log('  ► Keep the application’s approved proxy route active (see network note above).');
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

  const { codePromise, listening } = waitForAuthCode(state);
  try {
    await listening;
  } catch (err) {
    console.error(`\n  Could not start callback server: ${err.message}\n`);
    process.exit(1);
  }

  console.log('\n  ─────────────────────────────────────────────────────────');
  console.log('  Requested scopes:');
  REQUIRED_SCOPES.split(' ').forEach((s) => console.log(`    • ${s}`));
  console.log('\n  OAuth URL (open manually as the authorized shop owner):');
  console.log('\n  ' + oauthUrl);
  console.log('\n  ─────────────────────────────────────────────────────────');
  console.log('\n  Waiting for authorization...');

  let authCode;
  try {
    authCode = await codePromise;
  } catch (err) {
    console.error(`\n  Authorization failed: ${err.message}\n`);
    process.exit(1);
  }

  console.log('\n  Authorization code received. Exchanging for tokens...');

  let tokenData;
  try {
    tokenData = await exchangeCodeForTokens(shop.api_key, authCode, codeVerifier, proxyClient, shop.shop_id);
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
