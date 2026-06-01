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
 * Required scopes (what we request):
 *   transactions_r  — read orders and receipts
 *   transactions_w  — create shipment tracking (mark orders as shipped)
 *   shops_r         — read shop info
 *   shops_w         — update shop settings
 *   listings_r      — read all listings including inactive
 *   listings_w      — create and edit listings
 *   listings_d      — delete listings
 */

const crypto = require('crypto');
const http = require('http');
const path = require('path');
const readline = require('readline');
const axios = require('axios');
const { loadConfig, getAllShops, findShopContext, usesGroupProxy } = require('../src/config/schema');
const { TokenManager } = require('../src/auth/token-manager');

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
 * @returns {Promise<number>} application_id from openapi-ping
 */
async function verifyApiKeyActive(keystring, sharedSecret) {
  try {
    const { data } = await axios.get('https://api.etsy.com/v3/application/openapi-ping', {
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
          `  Check https://www.etsy.com/developers/your-apps for "cutecasesonly-inventory-sync":\n` +
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

async function exchangeCodeForTokens(keystring, authCode, codeVerifier) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: keystring,
    redirect_uri: REDIRECT_URI,
    code: authCode,
    code_verifier: codeVerifier,
  });

  const { data } = await axios.post(ETSY_TOKEN_URL, body.toString(), {
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
  console.log('\n  Verifying API key with Etsy (openapi-ping)...');
  try {
    const appId = await verifyApiKeyActive(shop.api_key, shop.shared_secret);
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
    tokenData = await exchangeCodeForTokens(shop.api_key, authCode, codeVerifier);
  } catch (err) {
    const desc = err.response?.data?.error_description ?? err.message;
    console.error(`\n  Token exchange failed: ${desc}\n`);
    process.exit(1);
  }

  tokenManager.storeTokens(shop.shop_id, tokenData);

  console.log('\n  ═══════════════════════════════════════════════════════════');
  console.log('  SUCCESS — Tokens saved to tokens.json');
  console.log('  ═══════════════════════════════════════════════════════════');
  console.log(`\n  Shop:          ${shop.shop_name}`);
  console.log(`  User ID:       ${tokenData.access_token.split('.')[0]}`);
  console.log(`  Access token:  valid for 1 hour (auto-refreshed by TokenManager)`);
  console.log(`  Refresh token: valid for 90 days`);
  console.log(`\n  tokens.json is gitignored — it will never be committed.`);
  console.log(`\n  Run 'npm run oauth:setup' again to authenticate the next shop.\n`);
}

main().catch((err) => {
  console.error('\n  Unexpected error:', err.message);
  process.exit(1);
});
