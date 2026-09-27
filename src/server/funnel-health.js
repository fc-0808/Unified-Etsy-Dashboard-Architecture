'use strict'

const https = require('node:https')
const net = require('node:net')

const DEFAULT_TIMEOUT_MS = 8_000
const MAX_RESPONSE_BYTES = 16 * 1024
const PUBLIC_DOH_ENDPOINTS = Object.freeze([
	(hostname) => ({
		url: `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
		headers: { Accept: 'application/dns-json' },
	}),
	(hostname) => ({
		url: `https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=A`,
		headers: { Accept: 'application/json' },
	}),
])

/**
 * The machine's normal resolver intentionally returns its private 100.x
 * Tailscale address while it is connected to the tailnet. A successful request
 * to that address proves only private Serve/MagicDNS reachability; it says
 * nothing about Funnel's public ingress. Only globally routable answers from a
 * public resolver are valid for the external health check.
 */
function isPublicAddress(value) {
	const address = String(value || '').trim().toLowerCase()
	const family = net.isIP(address)
	if (family === 4) {
		const octets = address.split('.').map(Number)
		const [a, b, c] = octets
		if (
			a === 0
			|| a === 10
			|| a === 127
			|| (a === 169 && b === 254)
			|| (a === 172 && b >= 16 && b <= 31)
			|| (a === 192 && b === 168)
			|| (a === 100 && b >= 64 && b <= 127)
			|| (a === 192 && b === 0 && c === 2)
			|| (a === 198 && b === 51 && c === 100)
			|| (a === 203 && b === 0 && c === 113)
			|| a >= 224
		) {
			return false
		}
		return true
	}
	if (family === 6) {
		return !(
			address === '::'
			|| address === '::1'
			|| /^f[cd]/.test(address)
			|| /^fe[89ab]/.test(address)
			|| /^2001:db8(?::|$)/.test(address)
		)
	}
	return false
}

function extractDnsAddresses(payload) {
	if (!payload || Number(payload.Status) !== 0 || !Array.isArray(payload.Answer)) return []
	const addresses = []
	for (const answer of payload.Answer) {
		const candidate = String(answer && answer.data || '').trim()
		if (Number(answer && answer.type) !== 1 || !isPublicAddress(candidate)) continue
		if (!addresses.includes(candidate)) addresses.push(candidate)
	}
	return addresses
}

function getJson(url, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
	return new Promise((resolve, reject) => {
		let settled = false
		const finish = (fn, value) => {
			if (settled) return
			settled = true
			fn(value)
		}
		const req = https.get(
			url,
			{
				headers: {
					Accept: 'application/json',
					'User-Agent': 'etsy-dashboard-funnel-health/1.0',
					...headers,
				},
			},
			(res) => {
				if (res.statusCode !== 200) {
					res.resume()
					finish(reject, new Error(`DNS-over-HTTPS returned HTTP ${res.statusCode}`))
					return
				}
				res.setEncoding('utf8')
				let body = ''
				res.on('data', (chunk) => {
					body += chunk
					if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
						res.destroy(new Error('DNS-over-HTTPS response was unexpectedly large'))
					}
				})
				res.on('end', () => {
					try {
						finish(resolve, JSON.parse(body))
					} catch {
						finish(reject, new Error('DNS-over-HTTPS returned invalid JSON'))
					}
				})
				res.on('error', (err) => finish(reject, err))
			},
		)
		req.setTimeout(timeoutMs, () => req.destroy(new Error('DNS-over-HTTPS request timed out')))
		req.on('error', (err) => finish(reject, err))
	})
}

async function resolvePublicIngress(
	hostname,
	{
		fetchJson = getJson,
		providers = PUBLIC_DOH_ENDPOINTS,
		timeoutMs = DEFAULT_TIMEOUT_MS,
	} = {},
) {
	const queries = providers.map(async (buildRequest) => {
		const request = buildRequest(hostname)
		const payload = await fetchJson(request.url, {
			headers: request.headers,
			timeoutMs,
		})
		return extractDnsAddresses(payload)
	})
	const settled = await Promise.allSettled(queries)
	const addresses = []
	const errors = []
	for (const result of settled) {
		if (result.status === 'fulfilled') {
			for (const address of result.value) {
				if (!addresses.includes(address)) addresses.push(address)
			}
		} else {
			errors.push(result.reason && result.reason.message ? result.reason.message : String(result.reason))
		}
	}
	return {
		addresses,
		providersAnswered: settled.length - errors.length,
		providersQueried: settled.length,
		errors,
	}
}

/**
 * Build a Node lookup callback pinned to one public ingress address. Keeping the
 * original hostname in the HTTPS request preserves both TLS SNI and certificate
 * validation while bypassing this machine's private MagicDNS answer.
 */
function createForcedLookup(address) {
	const family = net.isIP(address)
	if (!family) throw new Error(`Invalid ingress address: ${address}`)
	return function forcedLookup(_hostname, options, callback) {
		if (options && typeof options === 'object' && options.all) {
			callback(null, [{ address, family }])
			return
		}
		callback(null, address, family)
	}
}

function probeIngressAddress({
	hostname,
	address,
	path = '/api/health',
	timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
	return new Promise((resolve) => {
		const startedAt = Date.now()
		let settled = false
		const finish = (result) => {
			if (settled) return
			settled = true
			resolve({
				address,
				latencyMs: Date.now() - startedAt,
				...result,
			})
		}
		const req = https.request(
			{
				protocol: 'https:',
				hostname,
				port: 443,
				path,
				method: 'GET',
				servername: hostname,
				lookup: createForcedLookup(address),
				agent: false,
				rejectUnauthorized: true,
				headers: {
					Accept: 'application/json',
					'Cache-Control': 'no-cache',
					'User-Agent': 'etsy-dashboard-funnel-health/1.0',
				},
			},
			(res) => {
				res.setEncoding('utf8')
				let body = ''
				res.on('data', (chunk) => {
					body += chunk
					if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
						res.destroy(new Error('Health response was unexpectedly large'))
					}
				})
				res.on('end', () => {
					let payload = null
					try {
						payload = JSON.parse(body)
					} catch {}
					const ok = res.statusCode === 200 && payload && payload.ok === true
					finish({
						ok,
						statusCode: res.statusCode || 0,
						error: ok ? null : `Unexpected health response (HTTP ${res.statusCode || 0})`,
					})
				})
				res.on('error', (err) => finish({ ok: false, statusCode: res.statusCode || 0, error: err.message }))
			},
		)
		req.setTimeout(timeoutMs, () => req.destroy(new Error('Public Funnel probe timed out')))
		req.on('error', (err) => finish({ ok: false, statusCode: 0, error: err.message }))
		req.end()
	})
}

async function probePublicFunnel(
	hostname,
	{
		resolveIngress = resolvePublicIngress,
		probeAddress = probeIngressAddress,
		timeoutMs = DEFAULT_TIMEOUT_MS,
	} = {},
) {
	let resolution
	try {
		resolution = await resolveIngress(hostname, { timeoutMs })
	} catch (err) {
		return {
			ok: false,
			conclusive: false,
			addresses: [],
			attempts: [],
			reason: `Could not query public DNS: ${err.message}`,
		}
	}
	if (!resolution.addresses.length) {
		const suffix = resolution.errors.length ? ` (${resolution.errors.join('; ')})` : ''
		return {
			ok: false,
			conclusive: false,
			addresses: [],
			attempts: [],
			reason: `Public DNS returned no globally routable Funnel ingress address${suffix}`,
		}
	}

	const attempts = await Promise.all(
		resolution.addresses.map((address) =>
			Promise.resolve(probeAddress({ hostname, address, timeoutMs })).catch((err) => ({
				address,
				ok: false,
				statusCode: 0,
				error: err.message,
			})),
		),
	)
	const healthy = attempts.find((attempt) => attempt.ok)
	return {
		ok: !!healthy,
		conclusive: true,
		addresses: resolution.addresses,
		attempts,
		healthyAddress: healthy ? healthy.address : null,
		reason: healthy
			? null
			: attempts.map((attempt) => `${attempt.address}: ${attempt.error || `HTTP ${attempt.statusCode}`}`).join('; '),
	}
}

module.exports = {
	DEFAULT_TIMEOUT_MS,
	PUBLIC_DOH_ENDPOINTS,
	createForcedLookup,
	extractDnsAddresses,
	getJson,
	isPublicAddress,
	probeIngressAddress,
	probePublicFunnel,
	resolvePublicIngress,
}
