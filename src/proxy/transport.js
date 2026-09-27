'use strict';

/**
 * Provider-neutral description of how this process reaches each configured
 * group proxy.
 *
 * system_tunnel:
 *   The operating system owns the VPN/TUN route through a virtual network
 *   adapter. The application connects straight to the group SOCKS5
 *   proxy; the OS tunnel carries that TCP connection.
 *
 * local_socks5:
 *   A VPN client exposes an explicit loopback SOCKS5 listener. The application
 *   builds a two-hop chain through that listener and then the group proxy.
 */
const TRANSPORT_MODES = Object.freeze({
  SYSTEM_TUNNEL: 'system_tunnel',
  LOCAL_SOCKS5: 'local_socks5',
});

const LEGACY_DEFAULT_LOCAL_PORT = 7897;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function assertDisplayValue(value, field, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string') {
    throw new Error(`config.json: network_transport.${field} must be a string.`);
  }
  const clean = value.trim();
  if (!clean || clean.length > 80 || /[\u0000-\u001f\u007f]/.test(clean)) {
    throw new Error(
      `config.json: network_transport.${field} must be 1-80 printable characters.`
    );
  }
  return clean;
}

function assertPort(value, field = 'local_port') {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `config.json: network_transport.${field} must be an integer from 1 to 65535.`
    );
  }
  return port;
}

/**
 * Validate and normalize a network transport block.
 *
 * Passing no explicit block preserves compatibility with installations that
 * still use the old top-level vpn_local_port setting.
 *
 * @param {object|null|undefined} raw
 * @param {{ legacyVpnPort?: number|null, useLegacyDefault?: boolean }} [options]
 */
function normalizeNetworkTransport(raw, {
  legacyVpnPort = null,
  useLegacyDefault = true,
} = {}) {
  if (raw == null) {
    const port = legacyVpnPort == null && useLegacyDefault
      ? LEGACY_DEFAULT_LOCAL_PORT
      : legacyVpnPort;
    if (port == null) {
      throw new Error('config.json: network_transport is required.');
    }
    return {
      mode: TRANSPORT_MODES.LOCAL_SOCKS5,
      provider: 'Local VPN',
      interface_name: null,
      local_host: '127.0.0.1',
      local_port: assertPort(port),
    };
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('config.json: network_transport must be an object.');
  }

  const mode = String(raw.mode || '').trim().toLowerCase();
  if (!Object.values(TRANSPORT_MODES).includes(mode)) {
    throw new Error(
      'config.json: network_transport.mode must be "system_tunnel" or "local_socks5".'
    );
  }

  // Canonical normalized objects carry the inapplicable fields as null, so all
  // known keys are accepted and mode-specific non-null values are rejected below.
  const allowedKeys = new Set([
    'mode',
    'provider',
    'interface_name',
    'local_host',
    'local_port',
  ]);
  const unknownKeys = Object.keys(raw).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length) {
    throw new Error(
      `config.json: unknown network_transport field(s): ${unknownKeys.join(', ')}.`
    );
  }

  const provider = assertDisplayValue(
    raw.provider,
    'provider',
    mode === TRANSPORT_MODES.SYSTEM_TUNNEL ? 'System tunnel' : 'Local VPN'
  );

  if (mode === TRANSPORT_MODES.SYSTEM_TUNNEL) {
    if (raw.local_host != null || raw.local_port != null) {
      throw new Error(
        'config.json: system_tunnel does not use local_host/local_port. ' +
        'A VPN client UI may display an internal port, but the application must not dial it.'
      );
    }
    return {
      mode,
      provider,
      interface_name: raw.interface_name == null
        ? null
        : assertDisplayValue(raw.interface_name, 'interface_name', null),
      local_host: null,
      local_port: null,
    };
  }

  if (raw.interface_name != null) {
    throw new Error(
      'config.json: local_socks5 does not use interface_name.'
    );
  }
  const localHost = String(raw.local_host || '127.0.0.1').trim().toLowerCase();
  if (!LOOPBACK_HOSTS.has(localHost)) {
    throw new Error(
      'config.json: network_transport.local_host must be loopback ' +
      '(127.0.0.1, ::1, or localhost).'
    );
  }

  return {
    mode,
    provider,
    interface_name: null,
    local_host: localHost,
    local_port: assertPort(raw.local_port),
  };
}

/**
 * Accept the normalized object used by production plus the old numeric
 * constructor argument used by legacy integrations/tests.
 */
function coerceNetworkTransport(value) {
  if (typeof value === 'number') {
    return normalizeNetworkTransport(null, { legacyVpnPort: value });
  }
  return normalizeNetworkTransport(value);
}

function describeNetworkTransport(value) {
  const transport = coerceNetworkTransport(value);
  if (transport.mode === TRANSPORT_MODES.SYSTEM_TUNNEL) {
    const adapter = transport.interface_name
      ? ` (${transport.interface_name} adapter)`
      : '';
    return `${transport.provider} system tunnel${adapter}`;
  }
  return `${transport.provider} SOCKS5 ${transport.local_host}:${transport.local_port}`;
}

/**
 * Parse a group SOCKS5 URL without ever including credentials in errors/logs.
 */
function parseSocks5ProxyUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new Error('proxy must be a valid socks5:// URL.');
  }
  if (parsed.protocol !== 'socks5:') {
    throw new Error('proxy protocol must be socks5://.');
  }
  if (!parsed.hostname) {
    throw new Error('proxy host is missing.');
  }
  if (!parsed.port) {
    throw new Error('proxy port is missing.');
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('proxy port must be an integer from 1 to 65535.');
  }
  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw new Error('proxy URL must not contain a path, query, or fragment.');
  }

  return {
    ipaddress: parsed.hostname.replace(/^\[|\]$/g, ''),
    port,
    type: 5,
    userId: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  };
}

function formatProxyEndpoint(proxy) {
  const host = String(proxy.ipaddress || '');
  return `${host.includes(':') ? `[${host}]` : host}:${proxy.port}`;
}

module.exports = {
  TRANSPORT_MODES,
  LEGACY_DEFAULT_LOCAL_PORT,
  normalizeNetworkTransport,
  coerceNetworkTransport,
  describeNetworkTransport,
  parseSocks5ProxyUrl,
  formatProxyEndpoint,
};
