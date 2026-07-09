#!/usr/bin/env node
/**
 * tunnel.js — one-command "put the dashboard online" launcher.
 *
 * What it does, in order:
 *   1. Makes sure the dashboard server is running (starts it if it isn't).
 *   2. Starts a Cloudflare Tunnel to it (free, secure HTTPS, no router ports).
 *   3. Prints the phone link (…/shop) in a big banner so your shopping employee
 *      can open it from anywhere.
 *
 * Usage:
 *   npm run tunnel            Start the tunnel in this window (Ctrl+C to stop).
 *   npm run tunnel:install    Install the permanent tunnel as a background
 *                             service so it auto-starts on boot (needs a token
 *                             + admin rights). No terminal to keep open.
 *   npm run tunnel:uninstall  Remove that background service.
 *
 * Two modes, chosen automatically:
 *   • PERMANENT  — when CLOUDFLARE_TUNNEL_TOKEN is set in .env. Stable, bookmark-
 *                  able URL (e.g. https://shop.your-domain.com/shop).
 *   • TEMPORARY  — no token. Free random *.trycloudflare.com URL (changes each run).
 *
 * Keep this window open while people are shopping — closing it (or your PC going
 * to sleep) takes the link offline. The dashboard's data always stays on THIS
 * computer; the tunnel is just a secure doorway to it.
 *
 * Requirements: cloudflared. Install once with:
 *   Windows : winget install --id Cloudflare.cloudflared
 *   macOS   : brew install cloudflared
 *   Linux   : see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
 */

'use strict'

require('dotenv').config()

const net = require('net')
const path = require('path')
const dns = require('dns').promises
const { spawn, spawnSync } = require('child_process')

// Cloudflare tunnel edge — used to bypass the SRV lookup when a DNS-hijacking
// VPN/proxy is present (common on this project's Etsy-proxy machines). cloudflared
// normally discovers its edge via an SRV record (_v2-origintunneld._tcp.
// argotunnel.com). Some VPN resolvers return SERVFAIL for SRV, which kills the
// tunnel. When we detect that, we resolve the edge's plain A records ourselves
// (which such resolvers DO answer) and hand cloudflared the IPs via --edge, and
// force QUIC (UDP 7844), since those environments also tend to block TCP 7844.
const EDGE_HOSTS = ['region1.v2.argotunnel.com', 'region2.v2.argotunnel.com']
// Last-resort anycast IPs if even A-record resolution is blocked.
const EDGE_FALLBACK_IPS = ['198.41.192.67', '198.41.192.77', '198.41.200.193', '198.41.200.23']
const EDGE_PORT = 7844

const PORT = Number(process.env.PORT) || 4000
const ORIGIN = `http://localhost:${PORT}`
const PROJECT_ROOT = path.resolve(__dirname, '..')
const IS_WIN = process.platform === 'win32'

// A permanent, bookmarkable tunnel is used when a token is present in .env
// (CLOUDFLARE_TUNNEL_TOKEN). Otherwise we fall back to a free, temporary
// *.trycloudflare.com URL that changes every run. CLOUDFLARE_TUNNEL_HOSTNAME is
// the public hostname you mapped to this PC in the Cloudflare dashboard (e.g.
// shop.example.com) — used only to print the link.
const TUNNEL_TOKEN = (process.env.CLOUDFLARE_TUNNEL_TOKEN || '').trim()
const TUNNEL_HOSTNAME = (process.env.CLOUDFLARE_TUNNEL_HOSTNAME || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')

const C = {
	reset: '\x1b[0m',
	bold: '\x1b[1m',
	dim: '\x1b[2m',
	green: '\x1b[32m',
	cyan: '\x1b[36m',
	yellow: '\x1b[33m',
	red: '\x1b[31m',
}

const children = []
let shuttingDown = false

function log(msg) {
	console.log(msg)
}

/** Is something already listening on the dashboard port? */
function isPortOpen(port) {
	return new Promise((resolve) => {
		const sock = net.connect({ host: '127.0.0.1', port }, () => {
			sock.destroy()
			resolve(true)
		})
		sock.on('error', () => resolve(false))
		sock.setTimeout(1500, () => {
			sock.destroy()
			resolve(false)
		})
	})
}

async function waitForServer(timeoutMs) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (await isPortOpen(PORT)) return true
		await new Promise((r) => setTimeout(r, 1000))
	}
	return false
}

/** Confirm cloudflared is installed and runnable. */
function hasCloudflared() {
	const r = spawnSync('cloudflared', ['--version'], { shell: IS_WIN, encoding: 'utf8' })
	return !r.error && r.status === 0
}

function withTimeout(promise, ms, fallback) {
	return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallback), ms))])
}

/** Does the resolver answer the SRV record cloudflared needs? */
async function srvWorks() {
	try {
		const recs = await withTimeout(dns.resolveSrv('_v2-origintunneld._tcp.argotunnel.com'), 4000, null)
		return Array.isArray(recs) && recs.length > 0
	} catch {
		return false
	}
}

/** Resolve Cloudflare edge A records (works even when SRV is blocked). */
async function resolveEdgeIps() {
	const ips = []
	for (const host of EDGE_HOSTS) {
		try {
			const a = await withTimeout(dns.resolve4(host), 4000, [])
			for (const ip of a.slice(0, 3)) if (!ips.includes(ip)) ips.push(ip)
		} catch {}
	}
	return ips.length ? ips : EDGE_FALLBACK_IPS.slice()
}

/**
 * Extra cloudflared args to survive a DNS-hijacking VPN. Returns [] on a normal
 * network (so cloudflared behaves exactly as designed).
 */
async function edgeBypassArgs() {
	if (await srvWorks()) return []
	log(`${C.dim}Detected a resolver that can't do SRV lookups (VPN/proxy) — using direct edge + QUIC.${C.reset}`)
	const ips = await resolveEdgeIps()
	const args = ['--protocol', 'quic']
	for (const ip of ips) args.push('--edge', `${ip}:${EDGE_PORT}`)
	return args
}

function printInstallHelp() {
	log(`\n${C.red}${C.bold}✖ cloudflared is not installed.${C.reset}\n`)
	log('Install it once, then run "npm run tunnel" again:\n')
	if (IS_WIN) {
		log(`  ${C.cyan}winget install --id Cloudflare.cloudflared${C.reset}`)
		log(`  ${C.dim}(or download the .exe: https://github.com/cloudflare/cloudflared/releases/latest)${C.reset}`)
	} else if (process.platform === 'darwin') {
		log(`  ${C.cyan}brew install cloudflared${C.reset}`)
	} else {
		log(`  ${C.cyan}See https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/${C.reset}`)
	}
	log('')
}

function startServer() {
	log(`${C.dim}Dashboard not running — starting it…${C.reset}`)
	const child = spawn(process.execPath, [path.join('src', 'server', 'index.js')], {
		cwd: PROJECT_ROOT,
		stdio: 'inherit',
		env: process.env,
	})
	child.on('exit', (code) => {
		if (!shuttingDown) {
			log(`${C.red}Dashboard server exited (code ${code}). Shutting down tunnel.${C.reset}`)
			shutdown(1)
		}
	})
	children.push(child)
}

function banner(url, permanent) {
	const shopUrl = url ? `${url}/shop` : null
	const width = Math.max((shopUrl || '').length, 40) + 6
	const line = '═'.repeat(width)
	log('')
	log(`${C.green}${line}${C.reset}`)
	log(`${C.green}║${C.reset}  ${C.bold}🛒  Shopping Route is ONLINE${C.reset}  ${permanent ? C.dim + '(permanent link)' + C.reset : C.dim + '(temporary link)' + C.reset}`)
	log(`${C.green}║${C.reset}`)
	if (shopUrl) {
		log(`${C.green}║${C.reset}  Open this on the phone:`)
		log(`${C.green}║${C.reset}  ${C.bold}${C.cyan}${shopUrl}${C.reset}`)
		log(`${C.green}║${C.reset}`)
		log(`${C.green}║${C.reset}  ${C.dim}Full dashboard: ${url}${C.reset}`)
	} else {
		log(`${C.green}║${C.reset}  ${C.bold}Tunnel connected.${C.reset}`)
		log(`${C.green}║${C.reset}  Open your configured hostname + /shop on the phone,`)
		log(`${C.green}║${C.reset}  e.g. ${C.cyan}https://shop.your-domain.com/shop${C.reset}`)
		log(`${C.green}║${C.reset}  ${C.dim}(set CLOUDFLARE_TUNNEL_HOSTNAME in .env to show it here)${C.reset}`)
	}
	log(`${C.green}║${C.reset}  ${C.dim}Sign in with a "shopper" account (npm run user -- add mei shopper)${C.reset}`)
	log(`${C.green}${line}${C.reset}`)
	if (permanent) {
		log(`${C.yellow}Keep this window open (or install as a service — see .env.example).${C.reset}`)
		log(`${C.dim}Press Ctrl+C to take it offline.${C.reset}\n`)
	} else {
		log(`${C.yellow}Keep this window open. Press Ctrl+C to take it offline.${C.reset}\n`)
	}
}

/** Free temporary tunnel — random *.trycloudflare.com URL that changes each run. */
async function startQuickTunnel() {
	log(`${C.dim}Opening a temporary Cloudflare Tunnel to ${ORIGIN}…${C.reset}`)
	log(`${C.dim}(Tip: set CLOUDFLARE_TUNNEL_TOKEN in .env for a permanent link.)${C.reset}`)
	const extra = await edgeBypassArgs()
	const child = spawn('cloudflared', ['tunnel', '--no-autoupdate', ...extra, '--url', ORIGIN], {
		cwd: PROJECT_ROOT,
		shell: IS_WIN,
	})
	children.push(child)

	let urlShown = false
	const scan = (buf) => {
		const text = buf.toString()
		if (!urlShown) {
			const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)
			if (m) {
				urlShown = true
				banner(m[0], false)
			}
		}
		if (/ERR|error|failed/i.test(text) && !/Thank you for trying/i.test(text)) {
			process.stderr.write(`${C.dim}${text}${C.reset}`)
		}
	}
	child.stdout.on('data', scan)
	child.stderr.on('data', scan)
	child.on('exit', (code) => {
		if (!shuttingDown) {
			log(`${C.red}Tunnel exited (code ${code}).${C.reset}`)
			shutdown(1)
		}
	})
}

/** Permanent named tunnel — stable hostname, config managed in Cloudflare. */
async function startNamedTunnel() {
	log(`${C.dim}Connecting your permanent Cloudflare Tunnel to ${ORIGIN}…${C.reset}`)
	const extra = await edgeBypassArgs()
	const child = spawn('cloudflared', ['tunnel', '--no-autoupdate', ...extra, 'run', '--token', TUNNEL_TOKEN], {
		cwd: PROJECT_ROOT,
		shell: IS_WIN,
	})
	children.push(child)

	let ready = false
	const scan = (buf) => {
		const text = buf.toString()
		// A named tunnel prints no URL; it logs when a connection registers.
		if (!ready && /Registered tunnel connection|Connection [a-f0-9-]+ registered|connIndex/i.test(text)) {
			ready = true
			banner(TUNNEL_HOSTNAME ? `https://${TUNNEL_HOSTNAME}` : null, true)
		}
		// Common, actionable failures.
		if (/token is invalid|invalid tunnel|Unauthorized|failed to parse token|error parsing token/i.test(text)) {
			log(`${C.red}${C.bold}✖ The tunnel token was rejected.${C.reset}`)
			log(`  Re-copy CLOUDFLARE_TUNNEL_TOKEN from Cloudflare → Zero Trust → Networks → Tunnels → your tunnel → Configure.`)
		}
		if (/ERR|error|failed/i.test(text) && !/Thank you for trying/i.test(text)) {
			process.stderr.write(`${C.dim}${text}${C.reset}`)
		}
	}
	child.stdout.on('data', scan)
	child.stderr.on('data', scan)
	child.on('exit', (code) => {
		if (!shuttingDown) {
			log(`${C.red}Tunnel exited (code ${code}).${C.reset}`)
			shutdown(1)
		}
	})
}

async function startTunnel() {
	if (TUNNEL_TOKEN) await startNamedTunnel()
	else await startQuickTunnel()
}

function shutdown(code) {
	if (shuttingDown) return
	shuttingDown = true
	log(`\n${C.dim}Closing tunnel…${C.reset}`)
	for (const c of children) {
		try {
			c.kill()
		} catch {}
	}
	setTimeout(() => process.exit(code ?? 0), 300)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

/** Install the permanent tunnel as an OS service (auto-starts on boot). */
function installService() {
	log(`${C.bold}Install permanent tunnel as a background service${C.reset}\n`)
	if (!hasCloudflared()) {
		printInstallHelp()
		process.exit(1)
	}
	if (!TUNNEL_TOKEN) {
		log(`${C.red}✖ CLOUDFLARE_TUNNEL_TOKEN is not set in .env.${C.reset}`)
		log(`  A background service needs a permanent tunnel token. See .env.example for setup.\n`)
		process.exit(1)
	}
	log(`${C.dim}Installing service (this needs Administrator rights on Windows)…${C.reset}`)
	const r = spawnSync('cloudflared', ['service', 'install', TUNNEL_TOKEN], { stdio: 'inherit', shell: IS_WIN })
	if (r.status === 0) {
		log(`\n${C.green}✓ Tunnel service installed and started.${C.reset}`)
		log(`  It now runs on boot — no terminal needed. Your ${C.cyan}${TUNNEL_HOSTNAME ? 'https://' + TUNNEL_HOSTNAME + '/shop' : 'permanent URL'}${C.reset} stays online whenever this PC is on.`)
		log(`  ${C.yellow}Make sure the dashboard itself also auto-starts${C.reset} (npm run auto:install / PM2).`)
		log(`  Remove it later with:  npm run tunnel:uninstall\n`)
	} else {
		log(`\n${C.red}✖ Service install failed.${C.reset}`)
		log(`  On Windows, run your terminal ${C.bold}as Administrator${C.reset} and try again.\n`)
		process.exit(1)
	}
}

/** Remove the tunnel background service. */
function uninstallService() {
	log(`${C.bold}Remove tunnel background service${C.reset}\n`)
	if (!hasCloudflared()) {
		printInstallHelp()
		process.exit(1)
	}
	const r = spawnSync('cloudflared', ['service', 'uninstall'], { stdio: 'inherit', shell: IS_WIN })
	if (r.status === 0) log(`\n${C.green}✓ Tunnel service removed.${C.reset}\n`)
	else {
		log(`\n${C.red}✖ Service uninstall failed.${C.reset} Run as Administrator and retry.\n`)
		process.exit(1)
	}
}

async function main() {
	const mode = process.argv[2]
	if (mode === '--install-service') return installService()
	if (mode === '--uninstall-service') return uninstallService()

	log(`${C.bold}Unified Dashboard — Online Tunnel${C.reset}\n`)

	if (!hasCloudflared()) {
		printInstallHelp()
		process.exit(1)
	}

	if (await isPortOpen(PORT)) {
		log(`${C.green}✓${C.reset} Dashboard already running on ${ORIGIN}`)
	} else {
		startServer()
		log(`${C.dim}Waiting for the dashboard to come up…${C.reset}`)
		const up = await waitForServer(45000)
		if (!up) {
			log(`${C.red}Dashboard didn't start within 45s. Check the logs above.${C.reset}`)
			shutdown(1)
			return
		}
		log(`${C.green}✓${C.reset} Dashboard is up on ${ORIGIN}`)
	}

	await startTunnel()
}

main().catch((e) => {
	log(`${C.red}Tunnel launcher failed: ${e.message}${C.reset}`)
	shutdown(1)
})
