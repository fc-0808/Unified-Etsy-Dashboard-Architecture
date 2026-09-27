'use strict';

/**
 * Provider-neutral group proxy factory.
 *
 * Traffic path per API request is selected explicitly:
 *
 *   system_tunnel:
 *     Node.js → IPFoxy SOCKS5 (TCP carried by the OS VPN/TUN) → Etsy
 *
 *   local_socks5:
 *     Node.js → local VPN SOCKS5 → IPFoxy SOCKS5 → Etsy
 *
 * Built on the proven chain from test_proxy.js, wrapped into an https.Agent
 * subclass so axios can use it as a standard agent drop-in.
 */

const crypto = require('crypto');
const https = require('https');
const net = require('net');
const tls = require('tls');
const axios = require('axios');
const { SocksClient } = require('socks');
const { usesGroupProxy } = require('../config/schema');
const {
  TRANSPORT_MODES,
  coerceNetworkTransport,
  describeNetworkTransport,
  formatProxyEndpoint,
  parseSocks5ProxyUrl,
} = require('./transport');

// Route-check identity only (the public-IP preflight). Shop API calls and token
// refreshes replace this with a per-shop User-Agent from src/etsy/user-agent.js.
const APP_VERSION = (() => {
  try { return require('../../package.json').version || '0.0.0'; }
  catch { return '0.0.0'; }
})();
const ETSY_USER_AGENT = `Unified-Etsy-Dashboard/${APP_VERSION} (+node)`;
const DEFAULT_VERIFICATION_TTL_MS = 5 * 60 * 1000;
const DEFAULT_VERIFICATION_ATTEMPTS = 3;

/**
 * Parse "socks5://user:pass@host:port" into the object socks library expects.
 * @param {string} url
 * @returns {{ ipaddress: string, port: number, type: 5, userId: string, password: string }}
 */
function parseProxyUrl(url) {
  return parseSocks5ProxyUrl(url);
}

/**
 * Custom HTTPS agent that routes every connection through the mandatory group
 * SOCKS5 proxy, optionally preceded by an explicit local VPN SOCKS5 hop.
 *
 * Extends https.Agent so axios treats it as a standard drop-in.
 * Overrides createConnection to build the SOCKS socket + TLS manually.
 */
class GroupProxyAgent extends https.Agent {
  /**
   * @param {object|number} networkTransport - Normalized transport, or legacy port
   * @param {string} ipfoxyProxyUrl - Full SOCKS5 URL for the IPFoxy proxy
   * @param {object} [agentOptions] - Standard https.Agent options (keepAlive, maxSockets, etc.)
   */
  constructor(networkTransport, ipfoxyProxyUrl, agentOptions = {}) {
    const {
      connectTimeoutMs = 15_000,
      ...httpsAgentOptions
    } = agentOptions;
    super({ keepAlive: true, maxSockets: 5, maxFreeSockets: 2, ...httpsAgentOptions });
    this.connectTimeoutMs = connectTimeoutMs;
    this.networkTransport = coerceNetworkTransport(networkTransport);
    const groupProxy = parseProxyUrl(ipfoxyProxyUrl);
    const proxies = [groupProxy];
    if (this.networkTransport.mode === TRANSPORT_MODES.LOCAL_SOCKS5) {
      proxies.unshift({
        ipaddress: this.networkTransport.local_host,
        port: this.networkTransport.local_port,
        type: 5,
      });
    }
    // Proxy credentials are operational secrets. Keep the required in-memory
    // structures non-enumerable so routine agent/error inspection cannot print
    // them accidentally.
    Object.defineProperties(this, {
      ipfoxyProxy: { value: groupProxy },
      proxies: { value: proxies },
    });
    // Explicit marker consumed by buildShopClient's fail-closed check. A generic
    // https.Agent is not enough proof that the configured group proxy is present.
    this.proxyEnforced = true;
  }

  /**
   * Called by Node's https module before each request.
   * Returns a TLS socket established through the configured SOCKS route.
   *
   * @param {object} options - Connection options from https.request
   * @param {Function} callback - (err, socket) callback
   */
  createConnection(options, callback) {
    let completed = false;
    const finish = (err, socket) => {
      if (completed) return;
      completed = true;
      callback(err, socket);
    };
    const destination = {
      host: options.host || options.hostname,
      port: options.port || 443,
    };

    const connect = this.proxies.length === 1
      ? SocksClient.createConnection({
          proxy: this.proxies[0],
          destination,
          command: 'connect',
          timeout: this.connectTimeoutMs,
        })
      : SocksClient.createConnectionChain({
          proxies: this.proxies,
          destination,
          command: 'connect',
          timeout: this.connectTimeoutMs,
        });

    connect
      .then(({ socket: rawSocket }) => {
        let tlsSocket;
        try {
          tlsSocket = tls.connect({
            socket: rawSocket,
            servername: options.servername || destination.host,
            rejectUnauthorized: options.rejectUnauthorized !== false,
          });
        } catch (err) {
          rawSocket.destroy();
          finish(err);
          return;
        }

        const handshakeTimer = setTimeout(() => {
          const err = new Error(
            `TLS handshake timed out after ${this.connectTimeoutMs}ms`
          );
          err.code = 'ETIMEDOUT';
          tlsSocket.destroy(err);
        }, this.connectTimeoutMs);
        if (typeof handshakeTimer.unref === 'function') handshakeTimer.unref();

        tlsSocket.once('secureConnect', () => {
          clearTimeout(handshakeTimer);
          finish(null, tlsSocket);
        });
        tlsSocket.once('error', (err) => {
          clearTimeout(handshakeTimer);
          if (completed) return;
          // SOCKS connected but TLS failed. Destroy the underlying socket so
          // transient failures cannot leak file descriptors.
          rawSocket.destroy();
          finish(err);
        });
      })
      .catch((err) => finish(err));
  }

  /**
   * Human-readable description of this agent's routing.
   * Used in logs and sync worker output.
   */
  get description() {
    return `${describeNetworkTransport(this.networkTransport)} → ` +
      `IPFoxy SOCKS5 ${formatProxyEndpoint(this.ipfoxyProxy)}`;
  }
}

// Backward-compatible export name for integrations that constructed the old
// two-hop agent directly. Numeric first arguments still select local_socks5.
const TwoHopSocksAgent = GroupProxyAgent;

/**
 * Cache of axios instances keyed by group_id.
 * Avoids recreating agents on every API call.
 * @type {Map<string, import('axios').AxiosInstance>}
 */
const _instanceCache = new Map();

/**
 * Axios instance for groups with proxy: "direct" — no group SOCKS5 proxy.
 * @param {object} groupConfig
 * @param {boolean} [forceNew=false]
 * @returns {import('axios').AxiosInstance}
 */
function createDirectGroupClient(groupConfig, forceNew = false) {
  const routeKey = 'direct';
  const previous = _instanceCache.get(groupConfig.group_id);
  if (!forceNew && previous?._routeKey === routeKey) {
    return previous;
  }
  if (previous?._agent) previous._agent.destroy();

  const instance = axios.create({
    baseURL: 'https://openapi.etsy.com/v3',
    // Route selection is owned by config, never ambient HTTP(S)_PROXY variables.
    proxy: false,
    timeout: 30_000,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': ETSY_USER_AGENT,
    },
  });

  instance._groupId = groupConfig.group_id;
  instance._direct = true;
  instance._proxyEnforced = false;
  instance._egressVerifiedAt = 0;
  instance._verifiedEgressIp = null;
  instance._agent = null;
  instance._routeKey = routeKey;
  instance._routeDescription = 'direct';

  _instanceCache.set(groupConfig.group_id, instance);
  return instance;
}

/**
 * Create (or retrieve from cache) an axios instance for a specific shop group.
 * Each proxied group gets a dedicated agent so credentials and connection state
 * cannot be mixed.
 *
 * @param {object} groupConfig - A single entry from config.json groups[]
 * @param {object|number} networkTransport - From config.network_transport
 * @param {boolean} [forceNew=false] - Bypass cache and create a fresh instance
 * @returns {import('axios').AxiosInstance}
 */
function createGroupClient(groupConfig, networkTransport, forceNew = false) {
  if (!usesGroupProxy(groupConfig)) {
    return createDirectGroupClient(groupConfig, forceNew);
  }
  if (
    groupConfig?.expected_egress_ip == null
    || groupConfig.expected_egress_ip === ''
    || (Array.isArray(groupConfig.expected_egress_ip)
      && groupConfig.expected_egress_ip.length === 0)
  ) {
    const err = new Error(
      `Refusing to create an unpinned proxy route for group ` +
      `${groupConfig?.group_id || 'unknown'}.`
    );
    err.code = 'PROXY_EGRESS_PIN_REQUIRED';
    throw err;
  }

  const transport = coerceNetworkTransport(networkTransport);
  const routeKey = crypto
    .createHash('sha256')
    .update(JSON.stringify({ proxy: groupConfig.proxy, transport }))
    .digest('hex');
  const previous = _instanceCache.get(groupConfig.group_id);
  if (!forceNew && previous?._routeKey === routeKey) {
    return previous;
  }

  // A forced rebuild replaces the cached instance. Destroy its keep-alive
  // sockets first so config reloads cannot orphan them.
  if (previous?._agent) previous._agent.destroy();

  const agent = new GroupProxyAgent(transport, groupConfig.proxy);

  const instance = axios.create({
    baseURL: 'https://openapi.etsy.com/v3',
    httpsAgent: agent,
    // Prevent axios from replacing the mandatory SOCKS agent with an ambient
    // HTTP(S)_PROXY environment route.
    proxy: false,
    timeout: 30_000,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': ETSY_USER_AGENT,
    },
  });

  // Attach group metadata for debugging and logging
  instance._groupId = groupConfig.group_id;
  instance._direct = false;
  instance._proxyEnforced = true;
  instance._egressVerifiedAt = 0;
  instance._verifiedEgressIp = null;
  instance._agent = agent;
  instance._routeKey = routeKey;
  instance._routeDescription = agent.description;
  instance._assertProxyRoute = (requestConfig) => {
    if (
      requestConfig?.httpsAgent !== agent
      || requestConfig?.proxy !== false
      || agent.proxyEnforced !== true
    ) {
      const err = new Error(
        `Request attempted to override the configured proxy route for group ${groupConfig.group_id}.`
      );
      err.code = 'PROXY_ROUTE_OVERRIDE_BLOCKED';
      throw err;
    }
    return requestConfig;
  };
  instance.interceptors.request.use(instance._assertProxyRoute);
  instance._ensureEgressVerified = async (
    maxAgeMs = DEFAULT_VERIFICATION_TTL_MS
  ) => {
    const verified = await getVerifiedGroupClient(
      groupConfig,
      transport,
      { maxAgeMs }
    );
    if (verified.client !== instance) {
      const err = new Error(
        `Proxy route changed while group ${groupConfig.group_id} was active.`
      );
      err.code = 'PROXY_ROUTE_CHANGED';
      throw err;
    }
    return verified.egressIp;
  };

  _instanceCache.set(groupConfig.group_id, instance);
  return instance;
}

/**
 * Create an axios instance pre-configured for a specific shop group's proxy chain.
 * This instance does NOT have auth headers set — use buildShopClient() from
 * src/etsy/client.js to add the per-shop x-api-key + Authorization headers.
 *
 * Separation of concerns:
 *   - factory.js  → handles network routing (which IP/proxy to use)
 *   - client.js   → handles API auth (which credentials to send)
 *
 * Usage in sync worker:
 *   const { client: proxyClient } =
 *     await getVerifiedGroupClient(group, config.network_transport);
 *   const accessToken = await tokenManager.getAccessToken(shop.shop_id, ...);
 *   const shopClient  = buildShopClient(proxyClient, shop.api_key, shop.shared_secret, accessToken, null, { shopId: shop.shop_id });
 *   const receipts    = await getReceipts(shopClient, shop.shop_id);
 *
 * @param {object} groupConfig
 * @param {object|number} networkTransport
 * @param {boolean} [forceNew=false]
 * @returns {import('axios').AxiosInstance}
 */
function createGroupProxyClient(groupConfig, networkTransport, forceNew = false) {
  return createGroupClient(groupConfig, networkTransport, forceNew);
}

/**
 * Fetch a route's public IP with a small bounded retry budget. This endpoint is
 * read-only and outside Etsy, so replaying a transient connection failure cannot
 * duplicate a marketplace action or consume Etsy API quota.
 */
async function fetchExitIpWithRetry(client, {
  maxAttempts = DEFAULT_VERIFICATION_ATTEMPTS,
  baseDelayMs = 500,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onRetry = (err, attempt) => console.warn(
    `[proxy] Egress preflight failed (${err.code || err.message}); ` +
    `retrying ${attempt + 1}/${maxAttempts}.`
  ),
} = {}) {
  const attempts = Number.isInteger(maxAttempts)
    ? Math.min(5, Math.max(1, maxAttempts))
    : DEFAULT_VERIFICATION_ATTEMPTS;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await client.get('https://api.ipify.org?format=json', {
        baseURL: '',
        timeout: 15_000,
      });
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      const retryable = !err.response
        || status === 408
        || status === 425
        || status === 429
        || status >= 500;
      if (!retryable || attempt >= attempts) break;
      try { onRetry(err, attempt); } catch { /* diagnostics must not break routing */ }
      const delay = baseDelayMs * (2 ** (attempt - 1));
      await sleep(delay);
    }
  }
  throw lastError;
}

/**
 * Verify the proxy chain is working by fetching the exit IP.
 * Returns the IP string that the internet sees for this group.
 *
 * @param {object} groupConfig
 * @param {object|number} networkTransport
 * @returns {Promise<string>} The exit IP address
 */
async function verifyGroupProxy(groupConfig, networkTransport) {
  const client = createGroupClient(groupConfig, networkTransport);
  // A failed re-check must not leave a stale "verified" marker for a subsequent
  // Etsy client build.
  client._egressVerifiedAt = 0;
  client._verifiedEgressIp = null;
  const response = await fetchExitIpWithRetry(client);
  const ip = String(response.data?.ip || '').trim();
  if (net.isIP(ip) === 0) {
    const err = new Error('Proxy verification returned no valid public IP address.');
    err.code = 'PROXY_VERIFY_INVALID_IP';
    throw err;
  }

  const expected = groupConfig?.expected_egress_ip;
  if (expected != null && expected !== '') {
    const allowed = (Array.isArray(expected) ? expected : [expected])
      .map((value) => String(value).trim());
    if (!allowed.includes(ip)) {
      const err = new Error(
        `Configured egress-IP check failed for group ${groupConfig.group_id}: ` +
        `observed ${ip}, expected ${allowed.join(' or ')}.`
      );
      err.code = 'PROXY_EGRESS_IP_MISMATCH';
      err.observedIp = ip;
      throw err;
    }
  }
  client._egressVerifiedAt = Date.now();
  client._verifiedEgressIp = ip;
  return ip;
}

/** @type {Map<string, Promise<{ client: import('axios').AxiosInstance, egressIp: string }>>} */
const _verificationPromises = new Map();

/**
 * Return a route that has passed a recent public-egress preflight. Concurrent
 * callers for the same group/route share one check, avoiding an ipify burst.
 */
async function getVerifiedGroupClient(
  groupConfig,
  networkTransport,
  { maxAgeMs = DEFAULT_VERIFICATION_TTL_MS, force = false } = {}
) {
  let client = createGroupClient(groupConfig, networkTransport);
  const age = client._egressVerifiedAt
    ? Date.now() - client._egressVerifiedAt
    : Infinity;
  if (!force && age >= 0 && age <= maxAgeMs && client._verifiedEgressIp) {
    return { client, egressIp: client._verifiedEgressIp };
  }

  const verificationKey = `${groupConfig.group_id}:${client._routeKey}`;
  if (!_verificationPromises.has(verificationKey)) {
    const pending = verifyGroupProxy(groupConfig, networkTransport)
      .then((egressIp) => {
        // Route-key matching makes this the same instance unless configuration
        // changed during the check; in that case, do not bless the new route.
        client = createGroupClient(groupConfig, networkTransport);
        if (client._verifiedEgressIp !== egressIp) {
          const err = new Error(
            `Network route changed while group ${groupConfig.group_id} was being verified.`
          );
          err.code = 'PROXY_ROUTE_CHANGED_DURING_VERIFY';
          throw err;
        }
        return { client, egressIp };
      })
      .finally(() => _verificationPromises.delete(verificationKey));
    _verificationPromises.set(verificationKey, pending);
  }
  return _verificationPromises.get(verificationKey);
}

function describeGroupRoute(groupConfig, networkTransport) {
  if (!usesGroupProxy(groupConfig)) return 'direct';
  const proxy = parseProxyUrl(groupConfig.proxy);
  return `${describeNetworkTransport(networkTransport)} → ` +
    `IPFoxy SOCKS5 ${formatProxyEndpoint(proxy)}`;
}

/** @returns {boolean} */
function groupUsesProxy(groupConfig) {
  return usesGroupProxy(groupConfig);
}

/**
 * Flush the agent cache. Call after updating config.json at runtime.
 */
function clearClientCache() {
  _instanceCache.forEach((instance) => {
    if (instance._agent) instance._agent.destroy();
  });
  _instanceCache.clear();
  _verificationPromises.clear();
}

module.exports = {
  GroupProxyAgent,
  TwoHopSocksAgent,
  createDirectGroupClient,
  createGroupClient,
  createGroupProxyClient,
  getVerifiedGroupClient,
  verifyGroupProxy,
  groupUsesProxy,
  clearClientCache,
  describeGroupRoute,
  fetchExitIpWithRetry,
  parseProxyUrl,
  DEFAULT_VERIFICATION_TTL_MS,
  DEFAULT_VERIFICATION_ATTEMPTS,
};
