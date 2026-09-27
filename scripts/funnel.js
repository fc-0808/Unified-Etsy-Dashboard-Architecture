#!/usr/bin/env node
/**
 * Configure, verify, and (when necessary) repair the dashboard's Tailscale
 * Funnel. A saved Funnel rule is not proof that the public route works: private
 * MagicDNS can still reach the app while stale ingress state drops every mobile
 * TLS handshake. This launcher resolves the public relay addresses through DoH
 * and tests /api/health through those addresses with the real hostname/SNI.
 *
 * Usage:
 *   npm run funnel          Enable + externally verify; self-heal if stale.
 *   npm run funnel:check    Read-only public-path check.
 *   npm run funnel:watch    Monitor an already-enabled Funnel and repair it.
 *   npm run funnel:stop     Disable the public URL.
 */

'use strict'

require('dotenv').config({ quiet: true })

const fs = require('fs')
const http = require('node:http')
const net = require('net')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('child_process')
const { probePublicFunnel } = require('../src/server/funnel-health')

const PORT = Number(process.env.PORT) || 4000
const IS_WIN = process.platform === 'win32'
const LOCAL_HEALTH_TIMEOUT_MS = 4_000
const PUBLIC_PROBE_TIMEOUT_MS = 10_000
const WATCH_INTERVAL_MS = 2 * 60 * 1_000
const WATCH_STARTUP_DELAY_MS = 15_000
const WATCH_FAILURE_THRESHOLD = 2
const WATCH_REPAIR_COOLDOWN_MS = 30 * 60 * 1_000
const REPAIR_LOCK_PATH = path.join(os.tmpdir(), 'etsy-dashboard-funnel-repair.lock')

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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
	return spawnSync(bin, args, {
		encoding: 'utf8',
		shell: IS_WIN,
		timeout: 30_000,
		windowsHide: true,
		...opts,
	})
}

function commandOutput(result) {
	return `${result && result.stdout || ''}${result && result.stderr || ''}`.trim()
}

function isPortOpen(port, timeoutMs = 1_200) {
	return new Promise((resolve) => {
		const s = net.connect({ host: '127.0.0.1', port }, () => {
			s.destroy()
			resolve(true)
		})
		s.on('error', () => resolve(false))
		s.setTimeout(timeoutMs, () => {
			s.destroy()
			resolve(false)
		})
	})
}

function localHealth(timeoutMs = LOCAL_HEALTH_TIMEOUT_MS) {
	return new Promise((resolve) => {
		let settled = false
		const finish = (result) => {
			if (settled) return
			settled = true
			resolve(result)
		}
		const req = http.get(
			{
				host: '127.0.0.1',
				port: PORT,
				path: '/api/health',
				headers: { Accept: 'application/json', 'User-Agent': 'etsy-dashboard-funnel-health/1.0' },
			},
			(res) => {
				res.setEncoding('utf8')
				let body = ''
				res.on('data', (chunk) => {
					body += chunk
					if (body.length > 16 * 1024) res.destroy(new Error('Health response was unexpectedly large'))
				})
				res.on('end', () => {
					let payload = null
					try {
						payload = JSON.parse(body)
					} catch {}
					const ok = res.statusCode === 200 && payload && payload.ok === true
					finish({ ok, statusCode: res.statusCode || 0, error: ok ? null : `Unexpected HTTP ${res.statusCode || 0}` })
				})
				res.on('error', (err) => finish({ ok: false, statusCode: res.statusCode || 0, error: err.message }))
			},
		)
		req.setTimeout(timeoutMs, () => req.destroy(new Error('Local dashboard health check timed out')))
		req.on('error', (err) => finish({ ok: false, statusCode: 0, error: err.message }))
	})
}

function readNodeState(bin) {
	const result = ts(bin, ['status', '--json'])
	if (result.status !== 0 || !result.stdout) {
		throw new Error(commandOutput(result) || 'Tailscale status is unavailable')
	}
	let state
	try {
		state = JSON.parse(result.stdout)
	} catch {
		throw new Error('Tailscale returned invalid status JSON')
	}
	const hostname = String(state.Self && state.Self.DNSName || '').replace(/\.$/, '')
	return {
		backendState: String(state.BackendState || ''),
		hostname,
		online: state.Self ? state.Self.Online !== false : false,
	}
}

function readFunnelConfig(bin) {
	const result = ts(bin, ['funnel', 'status', '--json'])
	if (result.status !== 0 || !result.stdout) {
		throw new Error(commandOutput(result) || 'Tailscale Funnel status is unavailable')
	}
	try {
		return JSON.parse(result.stdout)
	} catch {
		throw new Error('Tailscale returned invalid Funnel status JSON')
	}
}

function isFunnelEnabled(config, hostname) {
	const expected = `${String(hostname || '').toLowerCase()}:443`
	return Object.entries(config && config.AllowFunnel || {}).some(
		([hostPort, enabled]) => enabled === true && hostPort.toLowerCase() === expected,
	)
}

function configureFunnel(bin) {
	const result = ts(bin, ['funnel', '--bg', '--yes', String(PORT)])
	if (result.status === 0) return { ok: true, output: commandOutput(result) }
	return { ok: false, output: commandOutput(result) || 'Tailscale rejected the Funnel configuration' }
}

async function waitForTailscale(bin, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs
	let lastError = ''
	while (Date.now() < deadline) {
		try {
			const state = readNodeState(bin)
			if (state.backendState === 'Running' && state.online && state.hostname) return state
			lastError = `state=${state.backendState || 'unknown'}, online=${state.online}`
		} catch (err) {
			lastError = err.message
		}
		await sleep(1_000)
	}
	throw new Error(`Tailscale did not become ready within ${Math.ceil(timeoutMs / 1_000)}s${lastError ? ` (${lastError})` : ''}`)
}

async function verifyPublic(hostname, attempts = 1) {
	let result = null
	for (let n = 1; n <= attempts; n += 1) {
		result = await probePublicFunnel(hostname, { timeoutMs: PUBLIC_PROBE_TIMEOUT_MS })
		if (result.ok) return result
		if (n < attempts) await sleep(2_000)
	}
	return result
}

function describeProbeFailure(result) {
	if (!result) return 'No public probe result'
	return result.reason || 'All public Funnel ingress probes failed'
}

function printInstallHelp() {
	log(`\n${C.red}${C.bold}✖ Tailscale is not installed.${C.reset}\n`)
	log('Install it once, then run "npm run funnel" again:\n')
	if (IS_WIN) log(`  ${C.cyan}winget install --id Tailscale.Tailscale${C.reset}`)
	else if (process.platform === 'darwin') log(`  ${C.cyan}brew install tailscale${C.reset}  ${C.dim}(or the Mac App Store app)${C.reset}`)
	else log(`  ${C.cyan}curl -fsSL https://tailscale.com/install.sh | sh${C.reset}`)
	log('')
}

function banner(url, probe) {
	const shopUrl = `${url}/shop`
	const line = '═'.repeat(Math.max(shopUrl.length, 40) + 6)
	log('')
	log(`${C.green}${line}${C.reset}`)
	log(`${C.green}║${C.reset}  ${C.bold}🛒  Shopping Route is ONLINE${C.reset}  ${C.dim}(public path verified)${C.reset}`)
	log(`${C.green}║${C.reset}`)
	log(`${C.green}║${C.reset}  Give your employees this link (it never changes):`)
	log(`${C.green}║${C.reset}  ${C.bold}${C.cyan}${shopUrl}${C.reset}`)
	log(`${C.green}║${C.reset}`)
	if (probe && probe.healthyAddress) {
		log(`${C.green}║${C.reset}  ${C.dim}Verified through public ingress ${probe.healthyAddress}.${C.reset}`)
		log(`${C.green}║${C.reset}`)
	}
	log(`${C.green}║${C.reset}  ${C.dim}It stays up whenever this PC is on — no window to keep open.${C.reset}`)
	log(`${C.green}║${C.reset}  ${C.dim}Sign in with a "shopper" account (npm run user -- add mei shopper).${C.reset}`)
	log(`${C.green}║${C.reset}  ${C.dim}Turn it off any time with:  npm run funnel:stop${C.reset}`)
	log(`${C.green}${line}${C.reset}\n`)
}

function acquireRepairLock() {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		let fd = null
		try {
			fd = fs.openSync(REPAIR_LOCK_PATH, 'wx')
			fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }))
			return () => {
				try {
					fs.closeSync(fd)
				} catch {}
				try {
					fs.unlinkSync(REPAIR_LOCK_PATH)
				} catch {}
			}
		} catch (err) {
			if (fd !== null) {
				try {
					fs.closeSync(fd)
				} catch {}
				try {
					fs.unlinkSync(REPAIR_LOCK_PATH)
				} catch {}
			}
			if (err.code !== 'EEXIST') throw err
			try {
				const ageMs = Date.now() - fs.statSync(REPAIR_LOCK_PATH).mtimeMs
				if (ageMs > 5 * 60 * 1_000) {
					fs.unlinkSync(REPAIR_LOCK_PATH)
					continue
				}
			} catch {}
			return null
		}
	}
	return null
}

async function waitForRepairLock(timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs
	do {
		const release = acquireRepairLock()
		if (release) return release
		await sleep(500)
	} while (Date.now() < deadline)
	return null
}

async function reconnectAndRestore(bin) {
	const release = acquireRepairLock()
	if (!release) return { ok: false, skipped: true, error: 'another Funnel repair is already running' }
	try {
		const down = ts(bin, ['down'])
		if (down.status !== 0) {
			return { ok: false, error: commandOutput(down) || 'tailscale down failed' }
		}
		await sleep(2_000)
		const up = ts(bin, ['up'])
		if (up.status !== 0) {
			// One extra attempt avoids leaving Tailscale disconnected after a
			// transient CLI/control-service race.
			await sleep(2_000)
			const retry = ts(bin, ['up'])
			if (retry.status !== 0) {
				return { ok: false, error: commandOutput(retry) || commandOutput(up) || 'tailscale up failed' }
			}
		}
		const state = await waitForTailscale(bin)
		const configured = configureFunnel(bin)
		if (!configured.ok) return { ok: false, error: configured.output, state }
		await sleep(8_000)
		return { ok: true, state }
	} catch (err) {
		return { ok: false, error: err.message }
	} finally {
		release()
	}
}

async function stopFunnel(bin) {
	log(`${C.dim}Turning the public URL off…${C.reset}`)
	// Serialize disable against a watchdog repair. If a repair was already in
	// flight, stopping after it completes guarantees the user's final intent wins.
	const release = await waitForRepairLock()
	if (!release) {
		log(`${C.yellow}Could not disable while another Funnel repair was still running. Retry in a moment.${C.reset}\n`)
		return false
	}
	try {
		let result = ts(bin, ['funnel', 'reset'])
		if (result.status !== 0) result = ts(bin, ['serve', 'reset'])
		if (result.status === 0) {
			log(`${C.green}✓ Public URL disabled. The watchdog will respect this setting.${C.reset}\n`)
			return true
		}
		log(`${C.yellow}Could not disable automatically: ${commandOutput(result) || 'unknown error'}${C.reset}\n`)
		return false
	} finally {
		release()
	}
}

async function checkFunnel(bin, { quiet = false } = {}) {
	let state
	try {
		state = readNodeState(bin)
	} catch (err) {
		return { ok: false, conclusive: false, reason: err.message }
	}
	if (state.backendState !== 'Running' || !state.online || !state.hostname) {
		return {
			ok: false,
			conclusive: true,
			reason: `Tailscale is not ready (state=${state.backendState || 'unknown'}, online=${state.online})`,
			state,
		}
	}
	const local = await localHealth()
	if (!local.ok) {
		return { ok: false, conclusive: true, reason: `Local dashboard is unhealthy: ${local.error}`, state, local }
	}
	let config
	try {
		config = readFunnelConfig(bin)
	} catch (err) {
		return { ok: false, conclusive: false, reason: err.message, state, local }
	}
	if (!isFunnelEnabled(config, state.hostname)) {
		return { ok: false, conclusive: true, disabled: true, reason: 'Funnel is disabled', state, local, config }
	}
	if (!quiet) log(`${C.dim}Checking the real public ingress path (not private MagicDNS)…${C.reset}`)
	const publicProbe = await verifyPublic(state.hostname)
	return {
		...publicProbe,
		state,
		local,
		config,
		reason: publicProbe.ok ? null : describeProbeFailure(publicProbe),
	}
}

async function enableAndVerify(bin) {
	let state
	try {
		state = await waitForTailscale(bin, 10_000)
	} catch (err) {
		log(`${C.yellow}Tailscale is installed but not ready: ${err.message}${C.reset}`)
		log(`Run ${C.cyan}tailscale up${C.reset}, finish sign-in if prompted, then retry.\n`)
		return false
	}
	const local = await localHealth()
	if (!local.ok && !(await isPortOpen(PORT))) {
		log(`${C.yellow}⚠ The dashboard is not running on http://localhost:${PORT}.${C.reset}`)
		log(`  Start it first (${C.cyan}npm run auto:start${C.reset}), then run this again.\n`)
		return false
	}
	if (!local.ok) {
		log(`${C.red}The process on port ${PORT} is not a healthy dashboard: ${local.error}.${C.reset}\n`)
		return false
	}
	log(`${C.dim}Enabling Tailscale Funnel → http://localhost:${PORT} …${C.reset}`)
	const configured = configureFunnel(bin)
	if (!configured.ok) {
		log(`\n${C.red}Could not enable Funnel.${C.reset}`)
		if (configured.output) process.stdout.write(`${C.dim}${configured.output}${C.reset}\n`)
		const m = configured.output.match(/https:\/\/login\.tailscale\.com\/\S+/)
		if (m) {
			log(`\n${C.yellow}One-time step:${C.reset} open this link, enable Funnel for your tailnet, then run "npm run funnel" again:`)
			log(`  ${C.cyan}${m[0]}${C.reset}\n`)
		} else {
			log(`${C.dim}If it mentions enabling Funnel, follow the printed link, enable it, then retry.${C.reset}\n`)
		}
		return false
	}

	await sleep(2_000)
	let probe = await verifyPublic(state.hostname, 2)
	if (probe.ok) {
		banner(`https://${state.hostname}`, probe)
		return true
	}
	if (!probe.conclusive) {
		log(`${C.red}Funnel is configured, but public reachability could not be verified.${C.reset}`)
		log(`  ${describeProbeFailure(probe)}`)
		log(`  No network restart was attempted because the diagnosis is inconclusive.\n`)
		return false
	}

	log(`${C.yellow}Funnel is saved but its public TLS path is stale:${C.reset}`)
	log(`  ${describeProbeFailure(probe)}`)
	log(`${C.dim}Reconnecting Tailscale once, then restoring and rechecking Funnel…${C.reset}`)
	const repaired = await reconnectAndRestore(bin)
	if (!repaired.ok) {
		log(`${C.red}Automatic repair failed: ${repaired.error}.${C.reset}\n`)
		return false
	}
	state = repaired.state
	probe = await verifyPublic(state.hostname, 3)
	if (!probe.ok) {
		log(`${C.red}Funnel is still not publicly reachable after a guarded reconnect.${C.reset}`)
		log(`  ${describeProbeFailure(probe)}`)
		log(`  Run ${C.cyan}npm run funnel:check${C.reset} after checking the Tailscale admin console.\n`)
		return false
	}
	log(`${C.green}✓ Stale Tailscale ingress state repaired.${C.reset}`)
	banner(`https://${state.hostname}`, probe)
	return true
}

function watchLog(state, nextState, message) {
	if (state.lastStatus !== nextState || nextState === 'repairing' || nextState === 'repair-failed') {
		log(`[funnel/watch] ${message}`)
		state.lastStatus = nextState
	}
}

async function watchCycle(bin, watchState) {
	const check = await checkFunnel(bin, { quiet: true })
	if (check.ok) {
		watchState.failures = 0
		watchLog(watchState, 'healthy', `Public route healthy via ${check.healthyAddress}.`)
		return
	}
	if (check.disabled) {
		watchState.failures = 0
		watchLog(watchState, 'disabled', 'Funnel is disabled; monitoring without re-enabling it.')
		return
	}
	if (!check.conclusive) {
		watchState.failures = 0
		watchLog(watchState, 'indeterminate', `Check inconclusive; leaving the network unchanged (${check.reason}).`)
		return
	}
	if (!check.state || check.state.backendState !== 'Running' || !check.state.online || !check.local || !check.local.ok) {
		watchState.failures = 0
		watchLog(watchState, 'dependency-down', `Waiting for dependencies (${check.reason}).`)
		return
	}

	watchState.failures += 1
	watchLog(
		watchState,
		'public-failure',
		`Public route failed ${watchState.failures}/${WATCH_FAILURE_THRESHOLD}; local dashboard remains healthy (${check.reason}).`,
	)
	if (watchState.failures < WATCH_FAILURE_THRESHOLD) return
	const sinceRepair = Date.now() - watchState.lastRepairAt
	if (watchState.lastRepairAt && sinceRepair < WATCH_REPAIR_COOLDOWN_MS) {
		watchLog(
			watchState,
			'cooldown',
			`Repair cooldown active for ${Math.ceil((WATCH_REPAIR_COOLDOWN_MS - sinceRepair) / 60_000)} more minute(s).`,
		)
		return
	}

	watchLog(watchState, 'repairing', 'Confirmed ingress failure; performing one guarded Tailscale reconnect.')
	watchState.lastRepairAt = Date.now()
	const repaired = await reconnectAndRestore(bin)
	if (!repaired.ok) {
		watchLog(watchState, 'repair-failed', `Repair failed: ${repaired.error}.`)
		return
	}
	const verification = await verifyPublic(repaired.state.hostname, 3)
	if (!verification.ok) {
		watchLog(watchState, 'repair-failed', `Reconnect completed but public verification failed: ${describeProbeFailure(verification)}.`)
		return
	}
	watchState.failures = 0
	watchLog(watchState, 'healthy', `Public route recovered via ${verification.healthyAddress}.`)
}

let watchStopping = false
let wakeWatch = null
function watchDelay(ms) {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			wakeWatch = null
			resolve()
		}, ms)
		wakeWatch = () => {
			clearTimeout(timer)
			wakeWatch = null
			resolve()
		}
	})
}

async function watch(bin) {
	const state = { failures: 0, lastRepairAt: 0, lastStatus: '' }
	log(`[funnel/watch] Starting after ${WATCH_STARTUP_DELAY_MS / 1_000}s; checks run every ${WATCH_INTERVAL_MS / 60_000} minutes.`)
	await watchDelay(WATCH_STARTUP_DELAY_MS)
	while (!watchStopping) {
		try {
			await watchCycle(bin, state)
		} catch (err) {
			watchLog(state, 'cycle-error', `Unexpected check error; leaving the network unchanged (${err.message}).`)
		}
		if (!watchStopping) await watchDelay(WATCH_INTERVAL_MS)
	}
}

async function watchWhenAvailable() {
	let missingLogged = false
	while (!watchStopping) {
		const bin = findTailscale()
		if (bin) return watch(bin)
		if (!missingLogged) {
			log('[funnel/watch] Tailscale is not installed; watchdog is idle and will check again in 2 minutes.')
			missingLogged = true
		}
		await watchDelay(WATCH_INTERVAL_MS)
	}
}

async function main() {
	const mode = process.argv[2] || '--ensure'
	if (!['--ensure', '--stop', '--check', '--watch'].includes(mode)) {
		log(`Usage: node scripts/funnel.js [--ensure|--check|--watch|--stop]`)
		process.exitCode = 2
		return
	}
	if (mode !== '--watch') log(`${C.bold}Unified Dashboard — Tailscale Funnel${C.reset}\n`)
	if (mode === '--watch') {
		await watchWhenAvailable()
		return
	}
	const bin = findTailscale()
	if (!bin) {
		printInstallHelp()
		process.exitCode = 1
		return
	}
	if (mode === '--stop') {
		if (!(await stopFunnel(bin))) process.exitCode = 1
		return
	}
	if (mode === '--check') {
		const result = await checkFunnel(bin)
		if (result.ok) {
			log(`${C.green}✓ Public Funnel is healthy via ${result.healthyAddress}:443.${C.reset}`)
			log(`  https://${result.state.hostname}/shop\n`)
		} else {
			log(`${C.red}✖ Public Funnel check failed: ${result.reason}.${C.reset}\n`)
			process.exitCode = 1
		}
		return
	}
	if (!(await enableAndVerify(bin))) process.exitCode = 1
}

if (require.main === module) {
	process.on('SIGINT', () => {
		watchStopping = true
		if (wakeWatch) wakeWatch()
	})
	process.on('SIGTERM', () => {
		watchStopping = true
		if (wakeWatch) wakeWatch()
	})

	main().catch((e) => {
		log(`${C.red}Funnel setup failed: ${e.message}${C.reset}`)
		process.exitCode = 1
	})
}

module.exports = {
	isFunnelEnabled,
}
