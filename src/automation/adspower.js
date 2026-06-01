'use strict';

/**
 * AdsPower Local API client.
 *
 * Auto-detects the actual base URL and port by reading the `local_api` file
 * that AdsPower writes to disk on every start — handles non-default ports
 * (e.g. 54385 instead of 50325) automatically.
 *
 * Supports API Key authentication (Bearer token) when AdsPower has
 * "API verification" enabled in Settings → API & MCP → Generate.
 *
 * File location (Windows): %APPDATA%\adspower_global\cwd_global\source\local_api
 * File location (Mac/Linux): ~/.config/adspower_global/cwd_global/source/local_api
 *
 * Docs: https://localapi-doc-en.adspower.com/docs/FFMFMf
 */

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');

// ── Port / URL auto-detection ────────────────────────────────────────────────

const LOCAL_API_CANDIDATES = [
  // Windows
  path.join(os.homedir(), 'AppData', 'Roaming', 'adspower_global', 'cwd_global', 'source', 'local_api'),
  // Mac / Linux
  path.join(os.homedir(), '.config', 'adspower_global', 'cwd_global', 'source', 'local_api'),
];

/**
 * Read the real AdsPower base URL from the local_api file AdsPower writes
 * on each start. Re-reads every call so port changes are picked up live.
 */
function base() {
  if (process.env.ADSPOWER_URL) return process.env.ADSPOWER_URL.replace(/\/$/, '');
  for (const p of LOCAL_API_CANDIDATES) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8').trim().replace(/\/$/, '');
        if (raw.startsWith('http')) return raw;
      }
    } catch { /* continue to next candidate */ }
  }
  return 'http://local.adspower.net:50325';
}

// ── API Key support ───────────────────────────────────────────────────────────
// Required when "API verification" is ON in AdsPower Settings → API & MCP.
// Set via env var ADSPOWER_API_KEY or call setApiKey() at runtime.
let _apiKey = process.env.ADSPOWER_API_KEY || null;

function setApiKey(key) { _apiKey = key ? String(key).trim() : null; }
function getApiKey()    { return _apiKey; }

function authHeaders() {
  return _apiKey ? { Authorization: `Bearer ${_apiKey}` } : {};
}

const TIMEOUT = { timeout: 10_000 };

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Check whether AdsPower is running and its Local API is reachable.
 * Also returns the detected base URL so callers can surface it in the UI.
 *
 * @returns {Promise<{ok: boolean, url: string, version?: string, error?: string}>}
 */
async function checkStatus() {
  const url = base();
  try {
    const { data } = await axios.get(`${url}/status`, {
      headers: authHeaders(),
      timeout: 3_000,
    });
    return { ok: data.code === 0, url, version: data.data?.version };
  } catch (err) {
    // 401 means API key is required but missing/wrong
    if (err.response?.status === 401) {
      return { ok: false, url, error: 'API key required — enable in AdsPower → Settings → API & MCP → Generate' };
    }
    return { ok: false, url, error: err.message };
  }
}

/**
 * List all browser profiles in AdsPower.
 * Returns an array of { user_id, name, remark, created_time, ... }
 *
 * @param {{ page?: number, pageSize?: number, groupId?: string }} opts
 */
async function listProfiles({ page = 1, pageSize = 100, groupId } = {}) {
  const params = { page, page_size: pageSize };
  if (groupId) params.group_id = groupId;

  const { data } = await axios.get(`${base()}/api/v1/user/list`, {
    params,
    headers: authHeaders(),
    ...TIMEOUT,
  });
  if (data.code !== 0) throw new Error(`AdsPower listProfiles: ${data.msg}`);
  return data.data?.list || [];
}

/**
 * Open a browser profile and return the Playwright/Puppeteer CDP WebSocket URL.
 *
 * @param {string} profileId   - AdsPower user_id (profile ID)
 * @param {{ headless?: boolean }} opts
 * @returns {Promise<string>}  - ws://127.0.0.1:XXXX/devtools/browser/... CDP URL
 */
async function openProfile(profileId, { headless = false } = {}) {
  const { data } = await axios.get(`${base()}/api/v1/browser/start`, {
    params: {
      user_id:   profileId,
      open_tabs: 1,
      headless:  headless ? 1 : 0,
      cdp_mask:  1,  // mask CDP detection (anti-bot)
    },
    headers: authHeaders(),
    timeout: 30_000,
  });
  if (data.code !== 0) throw new Error(`AdsPower openProfile(${profileId}): ${data.msg}`);
  const wsUrl = data.data?.ws?.puppeteer;
  if (!wsUrl) throw new Error(`AdsPower returned no CDP URL for profile ${profileId}`);
  return wsUrl;
}

/**
 * Close/stop a browser profile gracefully.
 * Safe to call even if the profile is not running.
 *
 * @param {string} profileId
 */
async function closeProfile(profileId) {
  try {
    await axios.get(`${base()}/api/v1/browser/stop`, {
      params:  { user_id: profileId },
      headers: authHeaders(),
      ...TIMEOUT,
    });
  } catch { /* best effort — profile may already be closed */ }
}

/**
 * Check if a specific profile is currently open.
 * @param {string} profileId
 * @returns {Promise<boolean>}
 */
async function isProfileOpen(profileId) {
  try {
    const { data } = await axios.get(`${base()}/api/v1/browser/active`, {
      params:  { user_id: profileId },
      headers: authHeaders(),
      ...TIMEOUT,
    });
    return data.code === 0 && data.data?.status === 'Active';
  } catch {
    return false;
  }
}

module.exports = { checkStatus, listProfiles, openProfile, closeProfile, isProfileOpen, setApiKey, getApiKey, base };
