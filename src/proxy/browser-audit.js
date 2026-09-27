'use strict';

/**
 * Read-only audit of AdsPower profile proxy configuration.
 *
 * This module never starts a browser, opens Etsy, reads cookies, changes a
 * profile, or exposes proxy/account credentials. It only queries the documented
 * profile-list endpoint and compares non-secret network metadata with config.
 */

const axios = require('axios');
const { execFileSync } = require('child_process');
const net = require('net');
const os = require('os');
const { parseSocks5ProxyUrl, formatProxyEndpoint } = require('./transport');

const DEFAULT_ADSPOWER_API_URL = 'http://127.0.0.1:50325';
const ADSPOWER_FIREWALL_RULE = 'UnifiedEtsyDashboard-Block-AdsPower-LocalAPI';

function cleanText(value, max = 200) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * API credentials must never be sent anywhere except a loopback AdsPower API.
 */
function normalizeAdsPowerApiUrl(value = DEFAULT_ADSPOWER_API_URL) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error('ADSPOWER_LOCAL_API_URL must be a valid loopback HTTP URL.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'http:' || !['127.0.0.1', '::1', 'localhost'].includes(host)) {
    throw new Error('ADSPOWER_LOCAL_API_URL must use HTTP on loopback only.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('ADSPOWER_LOCAL_API_URL must not contain credentials, query, or fragment.');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('ADSPOWER_LOCAL_API_URL must not contain a path.');
  }
  const port = Number(url.port || 50325);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('ADSPOWER_LOCAL_API_URL has an invalid port.');
  }
  return `http://${host === '::1' ? '[::1]' : host}:${port}`;
}

/**
 * Resolve effective shop → profile metadata without treating it as authorization
 * or using it to launch/automate a browser.
 */
function collectProfileAssignments(config) {
  const byProfile = new Map();
  const missing = [];

  for (const group of config.groups || []) {
    const proxyValue = group?.proxy;
    const proxied = typeof proxyValue === 'string'
      && !['', 'direct', 'none', 'false'].includes(proxyValue.trim().toLowerCase());
    if (!proxied) continue;
    for (const shop of group.shops || []) {
      const rawId = shop.adspower_profile_id ?? group.adspower_profile_id;
      const profileId = cleanText(rawId, 100);
      if (!profileId) {
        missing.push({
          group_id: String(group.group_id),
          shop_id: String(shop.shop_id),
        });
        continue;
      }

      if (!byProfile.has(profileId)) {
        byProfile.set(profileId, {
          profile_id: profileId,
          group_ids: new Set(),
          shop_ids: new Set(),
          expected_endpoints: new Set(),
          expected_ips: new Set(),
        });
      }
      const assignment = byProfile.get(profileId);
      assignment.group_ids.add(String(group.group_id));
      assignment.shop_ids.add(String(shop.shop_id));

      if (group.proxy && typeof group.proxy === 'string') {
        try {
          assignment.expected_endpoints.add(
            formatProxyEndpoint(parseSocks5ProxyUrl(group.proxy)).toLowerCase()
          );
        } catch {
          // The main config validator reports malformed proxy URLs. Keep this
          // collector pure and let the caller surface the configuration error.
        }
      }
      const expected = group.expected_egress_ip == null
        ? []
        : (Array.isArray(group.expected_egress_ip)
            ? group.expected_egress_ip
            : [group.expected_egress_ip]);
      for (const ip of expected) {
        const normalized = String(ip).trim();
        if (net.isIP(normalized)) assignment.expected_ips.add(normalized);
      }
    }
  }

  return {
    assignments: [...byProfile.values()],
    missing,
  };
}

/**
 * Drop every account secret returned by AdsPower. Platform usernames,
 * passwords, cookies and proxy credentials are intentionally never retained.
 */
function sanitizeAdsPowerProfile(profile) {
  const proxy = profile?.user_proxy_config && typeof profile.user_proxy_config === 'object'
    ? profile.user_proxy_config
    : {};
  const profileIp = cleanText(profile?.ip, 80);
  return {
    profile_id: cleanText(profile?.profile_id, 100),
    profile_no: cleanText(profile?.profile_no, 100),
    proxy_soft: cleanText(proxy.proxy_soft, 80).toLowerCase(),
    proxy_type: cleanText(proxy.proxy_type, 40).toLowerCase(),
    proxy_host: cleanText(proxy.proxy_host, 255).toLowerCase(),
    proxy_port: cleanText(proxy.proxy_port, 10),
    last_known_ip: net.isIP(profileIp) ? profileIp : null,
    ip_country: cleanText(profile?.ip_country, 8).toUpperCase() || null,
    has_saved_proxy_id: Boolean(cleanText(profile?.fbcc_proxy_acc_id, 100)),
  };
}

async function queryAdsPowerProfiles({
  apiKey,
  baseUrl = DEFAULT_ADSPOWER_API_URL,
  profileIds,
  routeExpectations = null,
  networkTransport = null,
  verifyRoute = null,
  request = (url, body, options) => axios.post(url, body, options),
} = {}) {
  const token = String(apiKey || '').trim();
  if (!token) {
    const err = new Error(
      'ADSPOWER_API_KEY is required for the read-only profile audit. ' +
      'Copy it from AdsPower → Automation → API into the gitignored .env file.'
    );
    err.code = 'ADSPOWER_API_KEY_MISSING';
    throw err;
  }
  const ids = [...new Set((profileIds || []).map((id) => cleanText(id, 100)).filter(Boolean))];
  if (!ids.length) return [];

  const safeBase = normalizeAdsPowerApiUrl(baseUrl);
  let response;
  try {
    response = await request(
      `${safeBase}/api/v2/browser-profile/list`,
      { profile_id: ids, page: 1, limit: Math.min(100, Math.max(ids.length, 1)) },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        proxy: false,
        timeout: 8_000,
        maxContentLength: 2 * 1024 * 1024,
        maxBodyLength: 256 * 1024,
        validateStatus: () => true,
      }
    );
  } catch (cause) {
    const err = new Error(`AdsPower Local API is unavailable: ${cleanText(cause.message)}.`);
    err.code = 'ADSPOWER_API_UNAVAILABLE';
    err.cause = cause;
    throw err;
  }

  if (response?.status && (response.status < 200 || response.status >= 300)) {
    const err = new Error(`AdsPower Local API returned HTTP ${response.status}.`);
    err.code = 'ADSPOWER_API_HTTP_ERROR';
    throw err;
  }
  const body = response?.data;
  if (!body || Number(body.code) !== 0 || !Array.isArray(body.data?.list)) {
    const err = new Error(
      `AdsPower profile query failed: ${cleanText(body?.msg || 'invalid response')}.`
    );
    err.code = 'ADSPOWER_API_QUERY_FAILED';
    throw err;
  }

  const expectedFor = (profileId) => {
    if (routeExpectations instanceof Map) return routeExpectations.get(profileId);
    if (routeExpectations && typeof routeExpectations === 'object') {
      return routeExpectations[profileId];
    }
    return null;
  };
  const verifier = verifyRoute || (
    routeExpectations
      ? require('./factory').verifyGroupProxy
      : null
  );

  const profiles = [];
  for (const rawProfile of body.data.list) {
    const profile = sanitizeAdsPowerProfile(rawProfile);
    const expectedIp = String(expectedFor(profile.profile_id) || '').trim();
    if (expectedIp && typeof verifier === 'function') {
      try {
        const proxy = rawProfile?.user_proxy_config || {};
        const proxyType = String(proxy.proxy_type || '').trim().toLowerCase();
        const proxySoft = String(proxy.proxy_soft || '').trim().toLowerCase();
        const host = String(proxy.proxy_host || '').trim();
        const port = Number(proxy.proxy_port);
        if (
          proxySoft === 'no_proxy'
          || proxySoft.includes('auto')
          || proxyType !== 'socks5'
          || !host
          || !Number.isInteger(port)
          || port < 1
          || port > 65535
        ) {
          throw new Error('profile does not contain a static SOCKS5 proxy configuration');
        }
        const user = String(proxy.proxy_user || '');
        const password = String(proxy.proxy_password || '');
        const auth = user || password
          ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}@`
          : '';
        const hostPart = host.includes(':') ? `[${host.replace(/^\[|\]$/g, '')}]` : host;
        const observedIp = await verifier({
          group_id: `browser_audit_${profile.profile_id}`,
          proxy: `socks5://${auth}${hostPart}:${port}`,
          expected_egress_ip: expectedIp,
        }, networkTransport);
        profile.route_check = {
          ok: true,
          observed_ip: observedIp,
          error: null,
        };
      } catch (cause) {
        profile.route_check = {
          ok: false,
          observed_ip: null,
          error: cleanText(cause.message || 'route verification failed'),
        };
      }
    }
    profiles.push(profile);
  }
  return profiles;
}

/**
 * Check whether AdsPower's "Local API" is accidentally reachable through this
 * machine's non-loopback IPv4 addresses. Requests never leave the host because
 * candidates come exclusively from os.networkInterfaces().
 */
async function findAdsPowerLanExposures({
  apiKey,
  baseUrl = DEFAULT_ADSPOWER_API_URL,
  networkInterfaces = os.networkInterfaces(),
  request = (url, options) => axios.get(url, options),
} = {}) {
  const token = String(apiKey || '').trim();
  if (!token) return [];
  const safeBase = new URL(normalizeAdsPowerApiUrl(baseUrl));
  const port = safeBase.port || '50325';
  const addresses = [...new Set(
    Object.values(networkInterfaces || {})
      .flat()
      .filter((entry) =>
        entry
        && (entry.family === 'IPv4' || entry.family === 4)
        && !entry.internal
        && net.isIPv4(entry.address)
        && !entry.address.startsWith('169.254.')
      )
      .map((entry) => entry.address)
  )].slice(0, 20);

  const checked = await Promise.all(addresses.map(async (address) => {
    try {
      const response = await request(`http://${address}:${port}/status`, {
        headers: { Authorization: `Bearer ${token}` },
        proxy: false,
        timeout: 2_000,
        validateStatus: () => true,
      });
      return response?.status >= 200
        && response.status < 300
        && Number(response.data?.code) === 0
        ? address
        : null;
    } catch {
      return null;
    }
  }));
  return checked.filter(Boolean);
}

function hasWindowsAdsPowerFirewallBlock({
  port = 50325,
  platform = process.platform,
  run = (script) => execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 5_000 }
  ),
} = {}) {
  if (platform !== 'win32') return null;
  const safePort = Number(port);
  if (!Number.isInteger(safePort) || safePort < 1 || safePort > 65535) return false;
  const script = [
    `$r = Get-NetFirewallRule -Name '${ADSPOWER_FIREWALL_RULE}' -ErrorAction SilentlyContinue`,
    'if (-not $r) { Write-Output "MISSING"; exit 0 }',
    '$p = $r | Get-NetFirewallPortFilter',
    `if ($r.Enabled -eq 'True' -and $r.Direction -eq 'Inbound' -and $r.Action -eq 'Block' -and $p.Protocol -eq 'TCP' -and [string]$p.LocalPort -eq '${safePort}') {`,
    '  Write-Output "SECURE"',
    '} else { Write-Output "INVALID" }',
  ].join('; ');
  try {
    return String(run(script)).trim() === 'SECURE';
  } catch {
    return false;
  }
}

function auditProfileAssignment(assignment, profile) {
  const errors = [];
  const warnings = [];
  const groups = [...assignment.group_ids];
  const endpoints = [...assignment.expected_endpoints];
  const expectedIps = [...assignment.expected_ips];

  if (groups.length !== 1 || endpoints.length > 1) {
    errors.push(
      'The same AdsPower profile is mapped to groups with different network identities.'
    );
  }
  if (!profile) {
    errors.push('Configured AdsPower profile was not returned by the Local API.');
    return { ok: false, errors, warnings };
  }
  if (!profile.proxy_soft || profile.proxy_soft === 'no_proxy') {
    errors.push('AdsPower profile is configured without a proxy.');
  }
  if (profile.proxy_soft.includes('auto') || profile.proxy_type.includes('rotat')) {
    errors.push('AdsPower profile uses an automatic/rotating proxy, not a static assignment.');
  }

  const actualEndpoint = profile.proxy_host && profile.proxy_port
    ? `${profile.proxy_host.includes(':') ? `[${profile.proxy_host}]` : profile.proxy_host}:` +
      profile.proxy_port
    : null;
  const endpointMatches = actualEndpoint
    ? endpoints.some((endpoint) => endpoint === actualEndpoint.toLowerCase())
    : false;
  const ipMatches = profile.last_known_ip
    ? expectedIps.includes(profile.last_known_ip)
    : false;

  if (profile.last_known_ip && expectedIps.length && !ipMatches) {
    errors.push(
      `AdsPower last-known exit ${profile.last_known_ip} does not match the configured static pin.`
    );
  }
  if (actualEndpoint && endpoints.length && !endpointMatches && !ipMatches) {
    errors.push('AdsPower proxy endpoint does not match this group’s configured proxy.');
  }
  if (!profile.last_known_ip && !endpointMatches) {
    errors.push(
      'AdsPower returned neither a matching proxy endpoint nor a verified last-known exit.'
    );
  } else if (!profile.last_known_ip) {
    warnings.push('Run AdsPower “Check Proxy” so the profile records its current public exit.');
  }
  if (!expectedIps.length) {
    warnings.push('The group has no expected_egress_ip pin.');
  }

  return { ok: errors.length === 0, errors, warnings };
}

function auditAdsPowerProfiles(config, profiles) {
  const { assignments, missing } = collectProfileAssignments(config);
  const byId = new Map((profiles || []).map((profile) => [profile.profile_id, profile]));
  const results = assignments.map((assignment) => ({
    profile_id: assignment.profile_id,
    group_ids: [...assignment.group_ids],
    shop_count: assignment.shop_ids.size,
    ...auditProfileAssignment(assignment, byId.get(assignment.profile_id)),
  }));
  return {
    ok: missing.length === 0 && results.every((result) => result.ok),
    configured_profile_count: assignments.length,
    missing,
    results,
  };
}

function auditDeclaredBrowserProfiles(declarations, profiles) {
  const byId = new Map((profiles || []).map((profile) => [profile.profile_id, profile]));
  const results = (declarations || []).map((declaration) => {
    const profile = byId.get(declaration.profile_id);
    const errors = [];
    const warnings = [];
    if (!profile) {
      errors.push('Declared AdsPower profile was not returned by the Local API.');
    } else {
      if (!profile.proxy_soft || profile.proxy_soft === 'no_proxy') {
        errors.push('AdsPower profile is configured without a proxy.');
      }
      if (profile.proxy_soft.includes('auto') || profile.proxy_type.includes('rotat')) {
        errors.push('AdsPower profile uses an automatic/rotating proxy.');
      }
      if (profile.proxy_type !== 'socks5') {
        errors.push('AdsPower profile is not configured for SOCKS5.');
      }
      if (
        profile.last_known_ip
        && profile.last_known_ip !== declaration.expected_egress_ip
      ) {
        errors.push(
          `AdsPower last-known exit ${profile.last_known_ip} does not match ` +
          `${declaration.expected_egress_ip}.`
        );
      }
      if (!profile.route_check) {
        errors.push('No live proxy-route check was performed.');
      } else if (!profile.route_check.ok) {
        errors.push(profile.route_check.error || 'Live proxy-route check failed.');
      }
      if (!profile.last_known_ip) {
        warnings.push('AdsPower has no last-known IP; use its Check Proxy action.');
      }
    }
    return {
      profile_id: declaration.profile_id,
      label: declaration.label,
      expected_egress_ip: declaration.expected_egress_ip,
      observed_ip: profile?.route_check?.observed_ip || null,
      ok: errors.length === 0,
      errors,
      warnings,
    };
  });
  return {
    ok: results.every((result) => result.ok),
    results,
  };
}

module.exports = {
  DEFAULT_ADSPOWER_API_URL,
  ADSPOWER_FIREWALL_RULE,
  normalizeAdsPowerApiUrl,
  collectProfileAssignments,
  sanitizeAdsPowerProfile,
  queryAdsPowerProfiles,
  findAdsPowerLanExposures,
  hasWindowsAdsPowerFirewallBlock,
  auditProfileAssignment,
  auditAdsPowerProfiles,
  auditDeclaredBrowserProfiles,
};
