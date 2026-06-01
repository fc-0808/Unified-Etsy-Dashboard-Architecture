'use strict';

/**
 * Two-hop SOCKS5 proxy factory.
 *
 * Traffic path per API request:
 *   Node.js → localhost:vpnPort (VPN SOCKS5) → IPFoxy SOCKS5 → openapi.etsy.com
 *
 * Etsy sees only the IPFoxy static residential HK IP.
 * Your ISP sees only encrypted VPN traffic — cannot observe IPFoxy or Etsy.
 *
 * Built on the proven chain from test_proxy.js, wrapped into an https.Agent
 * subclass so axios can use it as a standard agent drop-in.
 */

const https = require('https');
const tls = require('tls');
const axios = require('axios');
const { SocksClient } = require('socks');
const { usesGroupProxy } = require('../config/schema');

/**
 * Parse "socks5://user:pass@host:port" into the object socks library expects.
 * @param {string} url
 * @returns {{ ipaddress: string, port: number, type: 5, userId: string, password: string }}
 */
function parseProxyUrl(url) {
  const u = new URL(url);
  return {
    ipaddress: u.hostname,
    port: parseInt(u.port, 10),
    type: 5,
    userId: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
  };
}

/**
 * Custom HTTPS agent that routes every connection through the two-hop SOCKS5 chain:
 *   [localhost:vpnPort] → [ipfoxyProxy] → destination
 *
 * Extends https.Agent so axios treats it as a standard drop-in.
 * Overrides createConnection to build the chain socket + TLS manually,
 * mirroring the approach that test_proxy.js already validated.
 */
class TwoHopSocksAgent extends https.Agent {
  /**
   * @param {number} vpnPort - Local VPN SOCKS5 port (e.g. 7897)
   * @param {string} ipfoxyProxyUrl - Full SOCKS5 URL for the IPFoxy proxy
   * @param {object} [agentOptions] - Standard https.Agent options (keepAlive, maxSockets, etc.)
   */
  constructor(vpnPort, ipfoxyProxyUrl, agentOptions = {}) {
    super({ keepAlive: true, maxSockets: 5, ...agentOptions });
    this.vpnProxy = { ipaddress: '127.0.0.1', port: vpnPort, type: 5 };
    this.ipfoxyProxy = parseProxyUrl(ipfoxyProxyUrl);
    this._vpnPort = vpnPort;
    this._ipfoxyUrl = ipfoxyProxyUrl;
  }

  /**
   * Called by Node's https module before each request.
   * Returns a TLS socket established through the two-hop chain.
   *
   * @param {object} options - Connection options from https.request
   * @param {Function} callback - (err, socket) callback
   */
  createConnection(options, callback) {
    const destination = {
      host: options.host || options.hostname,
      port: options.port || 443,
    };

    SocksClient.createConnectionChain({
      proxies: [this.vpnProxy, this.ipfoxyProxy],
      destination,
      command: 'connect',
    })
      .then(({ socket: rawSocket }) => {
        const tlsSocket = tls.connect({
          socket: rawSocket,
          servername: options.servername || destination.host,
          rejectUnauthorized: options.rejectUnauthorized !== false,
        });

        tlsSocket.once('secureConnect', () => callback(null, tlsSocket));
        tlsSocket.once('error', (err) => callback(err));
      })
      .catch((err) => callback(err));
  }

  /**
   * Human-readable description of this agent's routing.
   * Used in logs and sync worker output.
   */
  get description() {
    return `VPN:${this._vpnPort} → IPFoxy:${this.ipfoxyProxy.ipaddress}:${this.ipfoxyProxy.port}`;
  }
}

/**
 * Cache of axios instances keyed by group_id.
 * Avoids recreating agents on every API call.
 * @type {Map<string, import('axios').AxiosInstance>}
 */
const _instanceCache = new Map();

/**
 * Create (or retrieve from cache) an axios instance for a specific shop group.
 * The instance routes all traffic through that group's VPN → IPFoxy chain.
 *
 * Each group gets its own dedicated agent so connections are never mixed
 * between groups — Etsy will always see the correct static IP per group.
 *
 * @param {object} groupConfig - A single entry from config.json groups[]
 * @param {string} groupConfig.group_id
 * @param {string} groupConfig.proxy - SOCKS5 URL for this group's IPFoxy proxy
 * @param {number} vpnPort - From config.vpn_local_port
 * @param {boolean} [forceNew=false] - Bypass cache and create a fresh instance
 * @returns {import('axios').AxiosInstance}
 */
/**
 * Axios instance for groups with proxy: "direct" — no VPN/IPFoxy chain.
 * @param {object} groupConfig
 * @param {boolean} [forceNew=false]
 * @returns {import('axios').AxiosInstance}
 */
function createDirectGroupClient(groupConfig, forceNew = false) {
  if (!forceNew && _instanceCache.has(groupConfig.group_id)) {
    return _instanceCache.get(groupConfig.group_id);
  }

  const instance = axios.create({
    baseURL: 'https://openapi.etsy.com/v3',
    timeout: 30_000,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  });

  instance._groupId = groupConfig.group_id;
  instance._direct = true;
  instance._agent = null;

  _instanceCache.set(groupConfig.group_id, instance);
  return instance;
}

function createGroupClient(groupConfig, vpnPort, forceNew = false) {
  if (!usesGroupProxy(groupConfig)) {
    return createDirectGroupClient(groupConfig, forceNew);
  }

  if (!forceNew && _instanceCache.has(groupConfig.group_id)) {
    return _instanceCache.get(groupConfig.group_id);
  }

  const agent = new TwoHopSocksAgent(vpnPort, groupConfig.proxy);

  const instance = axios.create({
    baseURL: 'https://openapi.etsy.com/v3',
    httpsAgent: agent,
    timeout: 30_000,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  });

  // Attach group metadata for debugging and logging
  instance._groupId = groupConfig.group_id;
  instance._agent = agent;

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
 *   const proxyClient = createGroupClient(group, vpnPort);
 *   const accessToken = await tokenManager.getAccessToken(shop.shop_id, ...);
 *   const shopClient  = buildShopClient(proxyClient, shop.api_key, shop.shared_secret, accessToken);
 *   const receipts    = await getReceipts(shopClient, shop.shop_id);
 *
 * @param {object} groupConfig
 * @param {number} vpnPort
 * @param {boolean} [forceNew=false]
 * @returns {import('axios').AxiosInstance}
 */
function createGroupProxyClient(groupConfig, vpnPort, forceNew = false) {
  return createGroupClient(groupConfig, vpnPort, forceNew);
}

/**
 * Verify the proxy chain is working by fetching the exit IP.
 * Returns the IP string that the internet sees for this group.
 *
 * @param {object} groupConfig
 * @param {number} vpnPort
 * @returns {Promise<string>} The exit IP address
 */
async function verifyGroupProxy(groupConfig, vpnPort) {
  const client = createGroupClient(groupConfig, vpnPort, true);
  const response = await client.get('https://api.ipify.org?format=json', {
    baseURL: '',
    timeout: 15_000,
  });
  return response.data.ip;
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
}

module.exports = {
  TwoHopSocksAgent,
  createDirectGroupClient,
  createGroupClient,
  createGroupProxyClient,
  verifyGroupProxy,
  groupUsesProxy,
  clearClientCache,
  parseProxyUrl,
};
