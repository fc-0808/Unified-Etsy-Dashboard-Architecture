'use strict';

function normalizeAddress(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^for=/, '')
    .replace(/^["\[]/, '')
    .replace(/["\]]$/, '')
    .replace(/^::ffff:/, '');
}

function isPrivateAddress(value) {
  const address = normalizeAddress(value);
  return address === '::1'
    || address === '127.0.0.1'
    || /^10\./.test(address)
    || /^192\.168\./.test(address)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(address)
    || /^169\.254\./.test(address)
    || /^(?:fc|fd)[0-9a-f]{2}:/.test(address)
    || /^fe[89ab][0-9a-f]:/.test(address);
}

function resolveListenHost({
  authEnabled,
  allowUnauthenticatedNetwork = false,
  requestedHost = '',
} = {}) {
  if (!authEnabled && !allowUnauthenticatedNetwork) return '127.0.0.1';
  return String(requestedHost || '').trim() || '0.0.0.0';
}

function isLocalDashboardRequest(req) {
  const headers = req?.headers || {};
  const peer = req?.socket?.remoteAddress;
  if (!isPrivateAddress(peer)) return false;

  const forwardedFor = String(headers['x-forwarded-for'] || '').trim();
  if (forwardedFor) {
    const chain = forwardedFor.split(',').map((part) => part.trim()).filter(Boolean);
    // Requiring the entire forwarded chain to remain private prevents a remote
    // client from prepending a spoofed private address to its real public hop.
    return chain.length > 0 && chain.every(isPrivateAddress);
  }

  // A proxy marker without a client-address chain cannot prove LAN origin.
  if (headers['x-forwarded-host'] || headers['x-forwarded-proto']) return false;
  return true;
}

module.exports = {
  isPrivateAddress,
  isLocalDashboardRequest,
  resolveListenHost,
};
