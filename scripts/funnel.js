#!/usr/bin/env node
/**
 * funnel.js — expose the dashboard on a FREE, STABLE, always-on public URL using
 * Tailscale Funnel. Unlike the Cloudflare quick tunnel (random URL that changes
 * every run) this gives a permanent HTTPS address like
 *     https://<your-pc>.<tailnet>.ts.net
 * with NO domain to buy and NO port to forward. Your employees just open the
 * link — no app on their phones.
 *
 * Why it's "always-on": the Tailscale installer runs a background service, and
 * Funnel config persists across reboots — so once enabled it stays up whenever
 * this PC is on. You do NOT need `tunnel:install` for this.
 *
 * Usage:
 *   npm run funnel         Enable the public URL (prints the link) and keep it on.
 *   npm run funnel:stop    Turn the public URL off.
 *
 * One-time prerequisites (the script tells you if any are missing):
 *   1. Install Tailscale:   winget install --id Tailscale.Tailscale
 *   2. Sign in:             tailscale up      (opens a browser once)
 *   3. Enable Funnel for your tailnet when prompted (a link is printed once).
 */

'use strict'

require('dotenv').config()

const fs = require('fs')
const net = require('net')
const { spawnSync } = require('child_process')

const PORT = Number(process.env.PORT) || 4000
const IS_WIN = process.platform === 'win32'

const C = {
	reset: '\x1b[0m',
	bold: '\x1b[1m',
	dim: '\x1b[2m',
	green: '\x1b[32m',
	cyan: '\x1b[36m',
	yellow: '\x1b[33m',
	red: '\x1b[31m',
}
const log = (m) => console.log(m)

/** Locate the tailscale CLI (PATH, or the default Windows/macOS install path). */
function findTailscale() {
	const probe = spawnSync('tailscale', ['version'], { shell: IS_WIN, encoding: 'utf8' })
	if (!probe.error && probe.status === 0) return 'tailscale'
	const candidates = IS_WIN
		? ['C:\\Program Files\\Tailscale\\tailscale.exe']
		: ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/bin/tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale']
	for (const p of candidates) {
		try {
			if (fs.existsSync(p)) return p
		} catch {}
	}
	return null
}

function ts(bin, args, opts = {}) {
	return spawnSync(bin, args, { encoding: 'utf8', shell: IS_WIN, ...opts })
}

function isPortOpen(port) {
	return new Promise((resolve) => {
		const s = net.connect({ host: '127.0.0.1', port }, () => {
			s.destroy()
			resolve(true)
		})
		s.on('error', () => resolve(false))
		s.setTimeout(1200, () => {
			s.destroy()
			resolve(false)
		})
	})
}

function printInstallHelp() {
	log(`\n${C.red}${C.bold}✖ Tailscale is not installed.${C.reset}\n`)
	log('Install it once, then run "npm run funnel" again:\n')
	if (IS_WIN) log(`  ${C.cyan}winget install --id Tailscale.Tailscale${C.reset}`)
	else if (process.platform === 'darwin') log(`  ${C.cyan}brew install tailscale${C.reset}  ${C.dim}(or the Mac App Store app)${C.reset}`)
	else log(`  ${C.cyan}curl -fsSL https://tailscale.com/install.sh | sh${C.reset}`)
	log('')
}

function banner(url) {
	const shopUrl = `${url}/shop`
	const line = '═'.repeat(Math.max(shopUrl.length, 40) + 6)
	log('')
	log(`${C.green}${line}${C.reset}`)
	log(`${C.green}║${C.reset}  ${C.bold}🛒  Shopping Route is ONLINE${C.reset}  ${C.dim}(permanent · always-on)${C.reset}`)
	log(`${C.green}║${C.reset}`)
	log(`${C.green}║${C.reset}  Give your employees this link (it never changes):`)
	log(`${C.green}║${C.reset}  ${C.bold}${C.cyan}${shopUrl}${C.reset}`)
	log(`${C.green}║${C.reset}`)
	log(`${C.green}║${C.reset}  ${C.dim}It stays up whenever this PC is on — no window to keep open.${C.reset}`)
	log(`${C.green}║${C.reset}  ${C.dim}Sign in with a "shopper" account (npm run user -- add mei shopper).${C.reset}`)
	log(`${C.green}║${C.reset}  ${C.dim}Turn it off any time with:  npm run funnel:stop${C.reset}`)
	log(`${C.green}${line}${C.reset}\n`)
}

async function main() {
	const stop = process.argv[2] === '--stop'
	log(`${C.bold}Unified Dashboard — Tailscale Funnel${C.reset}\n`)

	const TS = findTailscale()
	if (!TS) {
		printInstallHelp()
		process.exit(1)
	}

	if (stop) {
		log(`${C.dim}Turning the public URL off…${C.reset}`)
		let r = ts(TS, ['funnel', 'reset'], { stdio: 'inherit' })
		if (r.status !== 0) r = ts(TS, ['serve', 'reset'], { stdio: 'inherit' })
		log(r.status === 0 ? `${C.green}✓ Public URL disabled.${C.reset}\n` : `${C.yellow}Could not disable automatically — run:  tailscale funnel reset${C.reset}\n`)
		return
	}

	// Confirm signed in + get this machine's stable Tailscale hostname.
	const st = ts(TS, ['status', '--json'])
	if (st.status !== 0 || !st.stdout) {
		log(`${C.yellow}Tailscale is installed but not signed in yet.${C.reset}`)
		log(`Run this once (a browser opens to log in), then run "npm run funnel" again:\n`)
		log(`  ${C.cyan}tailscale up${C.reset}\n`)
		process.exit(1)
	}
	let dns = ''
	try {
		const j = JSON.parse(st.stdout)
		dns = ((j.Self && j.Self.DNSName) || '').replace(/\.$/, '')
	} catch {}
	if (!dns) {
		log(`${C.red}Couldn't read your Tailscale hostname. Make sure "tailscale up" completed, then retry.${C.reset}\n`)
		process.exit(1)
	}

	if (!(await isPortOpen(PORT))) {
		log(`${C.yellow}⚠ The dashboard doesn't seem to be running on http://localhost:${PORT}.${C.reset}`)
		log(`  Start it first (e.g. ${C.cyan}npm run auto:start${C.reset} or ${C.cyan}npm start${C.reset}), then run this again.`)
		log(`  ${C.dim}(Enabling the funnel now would just show an error page until the server is up.)${C.reset}\n`)
		process.exit(1)
	}

	// Enable Funnel in the background (persists across reboots via the Tailscale
	// service). Maps the public HTTPS root to the local dashboard port.
	log(`${C.dim}Enabling Tailscale Funnel → http://localhost:${PORT} …${C.reset}`)
	const r = ts(TS, ['funnel', '--bg', String(PORT)])
	const out = `${r.stdout || ''}${r.stderr || ''}`.trim()
	if (r.status !== 0) {
		log(`\n${C.red}Could not enable Funnel.${C.reset}`)
		if (out) process.stdout.write(`${C.dim}${out}${C.reset}\n`)
		// Tailscale prints a one-time link to enable Funnel for the tailnet.
		const m = out.match(/https:\/\/login\.tailscale\.com\/\S+/)
		if (m) {
			log(`\n${C.yellow}One-time step:${C.reset} open this link, enable Funnel for your tailnet, then run "npm run funnel" again:`)
			log(`  ${C.cyan}${m[0]}${C.reset}\n`)
		} else {
			log(`${C.dim}If it mentions enabling Funnel, follow the printed link, enable it, then retry.${C.reset}\n`)
		}
		process.exit(1)
	}

	banner(`https://${dns}`)
}

main().catch((e) => {
	log(`${C.red}Funnel setup failed: ${e.message}${C.reset}`)
	process.exit(1)
})
