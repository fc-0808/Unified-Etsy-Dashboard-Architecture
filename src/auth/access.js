/**
 * access.js — server-side authentication & role-based authorization.
 *
 * WHY THIS EXISTS
 * ----------------------------------------------------------------------------
 * The dashboard's "Packing Mode" hides earnings in the browser, but UI hiding is
 * NOT a security control — anyone with DevTools can call the API directly. The
 * only trustworthy place to enforce "the employee cannot see earnings" is the
 * server. This module is that gate. (See OWASP CWE-862 "Missing Authorization":
 * authorization must be resolved server-side from a trusted source, never from
 * the client.)
 *
 * DESIGN (small — no session store, no new deps)
 *   • Three roles: `owner` (superuser), `packer` (the employee: fulfilment and
 *     the whole shopping route) and `shopper` (mobile in-person shopping only).
 *   • WHAT each role may do lives in policy.js, not here. This file resolves the
 *     identity and applies that policy; policy.js is the reviewable table.
 *   • Identity is either a NAMED account (username + password, from the DB-backed
 *     user store) or a BOOTSTRAP env password (DASHBOARD_OWNER/PACKER_PASSWORD)
 *     so the owner can never be locked out. Named accounts add accountability +
 *     clean offboarding (see user-store.js).
 *   • On login we set a signed, HttpOnly cookie (`sid`) carrying the identity. It
 *     is HMAC-SHA256 signed (unforgeable) and HttpOnly (JS/XSS can't read it).
 *     Two non-secret cookies (`role`, `user`) are set purely so the page can
 *     render instantly — the server ignores them and always authorizes from `sid`.
 *   • Non-owner authorization is DENY-BY-DEFAULT: an endpoint with no rule in
 *     policy.js is refused, so a newly added API starts private.
 *   • Named sessions are re-validated every request against the store, so
 *     disabling a user or bumping their token_version logs them out INSTANTLY —
 *     the offboarding kill-switch.
 *   • Login is rate-limited per IP to blunt brute-force.
 *   • `GET /auth-session.js` hands the page its OWN capability list from the same
 *     policy, so the UI hides exactly what the server would refuse. It is a
 *     rendering hint, never a control — see the note on that route.
 *
 * BACKWARD COMPATIBILITY / NO LOCKOUT
 *   Auth turns on only when DASHBOARD_OWNER_PASSWORD is set. With no password
 *   configured the dashboard behaves exactly as before (single trusted owner).
 */

const crypto = require('crypto')
const path = require('path')
const express = require('express')
const policy = require('./policy')
const { isLocalDashboardRequest } = require('../server/network-policy')

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

// ── Login rate limiting ────────────────────────────────────────────────────
const RL_MAX_FAILS = 5 // consecutive failures before lockout
const RL_LOCK_MS = 15 * 60 * 1000 // lockout duration
const RL_MAX_ENTRIES = 10_000

function timingSafeEqualStr(a, b) {
	// Hash both inputs to a fixed length before comparing. This avoids leaking the
	// expected string length and keeps timingSafeEqual's precondition trivial.
	const ah = crypto.createHash('sha256').update(String(a)).digest()
	const bh = crypto.createHash('sha256').update(String(b)).digest()
	return crypto.timingSafeEqual(ah, bh)
}

function parseCookies(header) {
	const out = {}
	if (!header) return out
	for (const part of header.split(';')) {
		const i = part.indexOf('=')
		if (i < 0) continue
		const k = part.slice(0, i).trim()
		const raw = part.slice(i + 1).trim()
		let v
		try {
			v = decodeURIComponent(raw)
		} catch {
			// A malformed percent escape in an attacker-controlled Cookie header
			// invalidates that cookie; it must not turn every request into a 500.
			continue
		}
		if (k) out[k] = v
	}
	return out
}

/**
 * @param {object} [opts]
 * @param {object} [opts.store] optional user store (see user-store.js). When
 *   provided, named-account logins are enabled alongside the env bootstrap.
 */
function createAuth(opts = {}) {
	const store = opts.store || null
	const ownerPw = process.env.DASHBOARD_OWNER_PASSWORD || ''
	const packerPw = process.env.DASHBOARD_PACKER_PASSWORD || ''
	const shopperPw = process.env.DASHBOARD_SHOPPER_PASSWORD || ''
	// Auth is enabled if an env owner password is set OR any named user exists.
	let namedUsers = 0
	try {
		namedUsers = store ? store.count() : 0
	} catch {
		namedUsers = 0
	}
	const enabled = !!ownerPw || namedUsers > 0

	const configuredSecret = process.env.DASHBOARD_AUTH_SECRET || ''
	if (configuredSecret && Buffer.byteLength(configuredSecret, 'utf8') < 32) {
		throw new Error('DASHBOARD_AUTH_SECRET must contain at least 32 bytes')
	}
	if (enabled && !configuredSecret) {
		throw new Error(
			'DASHBOARD_AUTH_SECRET is required whenever authentication is enabled. ' +
			'Generate one with `npm run auth:generate-secret`.',
		)
	}
	const secret =
		configuredSecret ||
		crypto.createHash('sha256').update('etsy-dashboard-auth::' + ownerPw + '::' + packerPw + '::' + shopperPw).digest('hex')

	// `ip:<address>` and `user:<normalized username>` → { fails, lockedUntil }.
	// The username bucket prevents distributed-IP guessing of one named account;
	// blank-username bootstrap logins remain IP-limited.
	const rateState = new Map()
	const clientIp = (req) => req.ip || (req.socket && req.socket.remoteAddress) || 'unknown'
	const rateKeys = (req, username = '') => {
		const keys = [`ip:${clientIp(req)}`]
		const user = String(username || '').trim().toLowerCase()
		if (user) keys.push(`user:${user}`)
		return keys
	}
	function pruneRateState(now = Date.now()) {
		for (const [key, state] of rateState) {
			if (
				(state.lockedUntil && state.lockedUntil <= now)
				|| (!state.lockedUntil && now - (state.lastAttemptAt || 0) > RL_LOCK_MS)
			) {
				rateState.delete(key)
			}
		}
		while (rateState.size >= RL_MAX_ENTRIES) {
			const oldest = rateState.keys().next().value
			if (oldest === undefined) break
			rateState.delete(oldest)
		}
	}
	function isLocked(req, username = '') {
		const now = Date.now()
		return rateKeys(req, username).some((key) => {
			const state = rateState.get(key)
			return !!(state && state.lockedUntil && state.lockedUntil > now)
		})
	}
	function noteFailure(req, username = '') {
		pruneRateState()
		for (const key of rateKeys(req, username)) {
			const state = rateState.get(key) || { fails: 0, lockedUntil: 0, lastAttemptAt: 0 }
			state.fails += 1
			state.lastAttemptAt = Date.now()
			if (state.fails >= RL_MAX_FAILS) state.lockedUntil = Date.now() + RL_LOCK_MS
			rateState.set(key, state)
		}
	}
	function noteSuccess(req, username = '') {
		for (const key of rateKeys(req, username)) rateState.delete(key)
	}

	function sign(payloadObj) {
		const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url')
		const mac = crypto.createHmac('sha256', secret).update(payload).digest('base64url')
		return payload + '.' + mac
	}

	function verify(token) {
		if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return null
		const idx = token.indexOf('.')
		const payload = token.slice(0, idx)
		const mac = token.slice(idx + 1)
		const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url')
		if (!timingSafeEqualStr(mac, expected)) return null
		try {
			const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
			// The role must be one the policy knows about, so a cookie minted by an
			// older build (or a role that has since been retired) fails closed.
			if (!obj || !Object.prototype.hasOwnProperty.call(policy.ROLE_CAPABILITIES, obj.role)) return null
			if (obj.exp && Date.now() > obj.exp) return null
			return obj
		} catch {
			return null
		}
	}

	function roleForPassword(pw) {
		if (!pw) return null
		if (ownerPw && timingSafeEqualStr(pw, ownerPw)) return 'owner'
		if (packerPw && timingSafeEqualStr(pw, packerPw)) return 'packer'
		if (shopperPw && timingSafeEqualStr(pw, shopperPw)) return 'shopper'
		return null
	}

	const isApi = (req) => req.path.startsWith('/api/') || req.path === '/api'

	// ── Middleware ────────────────────────────────────────────────────────────

	// Resolve the session from the signed cookie → req.auth = { role, user }.
	// Named sessions are re-checked against the store every request (kill-switch).
	function attach(req, _res, next) {
		if (!enabled) {
			req.auth = { role: 'owner', user: 'owner', authDisabled: true }
			return next()
		}
		const cookies = parseCookies(req.headers.cookie)
		const obj = verify(cookies.sid)
		if (!obj) {
			req.auth = null
			return next()
		}
		if (obj.src === 'user' && store) {
			// Named account — must still exist, be active, and match token_version.
			const v = store.validateSession(obj.user, obj.tv)
			req.auth = v ? { role: v.role, user: v.username } : null
		} else {
			// Env bootstrap account (or legacy session): valid as signed.
			req.auth = { role: obj.role, user: obj.user || obj.role }
		}
		next()
	}

	function requireApiAuth(req, res, next) {
		if (!isApi(req)) return next()
		if (!enabled) return next()
		if (req.path === '/api/health' || req.path.startsWith('/api/auth/')) return next()
		if (req.auth && req.auth.role) return next()
		return res.status(401).json({ error: 'Not signed in', code: 'AUTH_REQUIRED' })
	}

	// Human-readable 403 copy, keyed by role, so the operator is told what their
	// account is for rather than being shown a bare "forbidden".
	const DENIED_MESSAGE = {
		packer: 'Your account does not have permission for this action.',
		shopper: 'This action is not available in Shopping Mode.',
	}

	// The one authorization gate. `owner` short-circuits inside authorizeApi;
	// every other role is resolved against the capability table in policy.js and
	// denied when no rule grants it.
	function roleGate(req, res, next) {
		if (!isApi(req)) return next()
		if (!enabled) return next()
		if (!req.auth || !req.auth.role) return next() // requireApiAuth already 401'd
		if (req.path === '/api/health' || req.path.startsWith('/api/auth/')) return next()
		const verdict = policy.authorizeApi(req.auth.role, req.method, req.path)
		if (
			verdict.allowed
			&& !isLocalRequest(req)
			&& !policy.roleCan(req.auth.role, 'dashboard:remote')
			&& !policy.roleCan('shopper', verdict.capability)
		) {
			return res.status(403).json({
				error: 'This permission is available only from the trusted office network.',
				code: 'REMOTE_SCOPE_RESTRICTED',
				required: 'dashboard:remote',
			})
		}
		if (verdict.allowed) return next()
		return res.status(403).json({
			error: DENIED_MESSAGE[req.auth.role] || 'Your account does not have permission for this action.',
			code: 'FORBIDDEN_ROLE',
			// Which permission was missing. Lets the UI log a precise reason and
			// gives the owner an exact thing to grant, instead of "it 403s".
			required: verdict.capability,
		})
	}

	/**
	 * Guard a single route on a named capability.
	 *
	 * The gate above already covers everything, but declaring the requirement at
	 * the route itself keeps the intent visible where the handler lives (and is a
	 * second, independent check if a policy rule is ever mis-ordered).
	 */
	function requireCapability(capability) {
		return function (req, res, next) {
			if (!enabled) return next()
			if (req.auth && policy.roleCan(req.auth.role, capability)) return next()
			return res.status(403).json({ error: 'You do not have permission for this action.', code: 'FORBIDDEN_ROLE', required: capability })
		}
	}

	// Is this request coming from the local office LAN (vs. through the public
	// tunnel)? Direct private peers are local. A reverse-proxied request is local
	// only when every address in its forwarded chain is private; a public hop makes
	// it remote. This supports office nginx/mDNS without trusting a spoofed prefix.
	function isLocalRequest(req) {
		return isLocalDashboardRequest(req)
	}

	// May this role open the full desktop dashboard from where it is asking?
	// `dashboard:view` is the role-level answer; `dashboard:remote` additionally
	// allows it through the public tunnel. Employees hold the first but not the
	// second, so the desktop dashboard stays an in-office surface for them while
	// the mobile Shopping Route works from anywhere.
	function canOpenDashboard(role, req) {
		if (!policy.roleCan(role, 'dashboard:view')) return false
		return isLocalRequest(req) || policy.roleCan(role, 'dashboard:remote')
	}

	// The page a role should land on after sign-in: the dashboard when they can
	// open it here, otherwise the mobile Shopping Route.
	function landingFor(role, req) {
		return canOpenDashboard(role, req) ? '/' : '/shop'
	}

	function requirePage(req, res, next) {
		if (!enabled) return next()
		const isDash = req.path === '/' || req.path === '/index.html'
		const isShop = req.path === '/shop' || req.path === '/shop.html'
		const isSourcing = req.path === '/sourcing' || req.path === '/sourcing.html'
		if (!isDash && !isShop && !isSourcing) return next()
		if (!req.auth || !req.auth.role) return res.redirect('/login')
		if (isDash && !canOpenDashboard(req.auth.role, req)) return res.redirect('/shop')
		// Sourcing Library is desk work. A shopper (mobile in-person shopping only)
		// never sources, so bounce them to their route.
		if (isSourcing && !policy.roleCan(req.auth.role, 'sourcing:manage')) return res.redirect('/shop')
		return next()
	}

	function setSessionCookies(req, res, session) {
		const secure = req.secure || req.headers['x-forwarded-proto'] === 'https'
		const token = sign({ ...session, iat: Date.now(), exp: Date.now() + SESSION_MAX_AGE_MS })
		res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', secure, maxAge: SESSION_MAX_AGE_MS, path: '/' })
		// Non-secret UI hints so the page renders instantly. Server never trusts these.
		res.cookie('role', session.role, { httpOnly: false, sameSite: 'lax', secure, maxAge: SESSION_MAX_AGE_MS, path: '/' })
		res.cookie('user', session.user, { httpOnly: false, sameSite: 'lax', secure, maxAge: SESSION_MAX_AGE_MS, path: '/' })
	}

	function clearSessionCookies(req, res) {
		const secure = req.secure || req.headers['x-forwarded-proto'] === 'https'
		const common = { sameSite: 'lax', secure, path: '/' }
		res.clearCookie('sid', { ...common, httpOnly: true })
		res.clearCookie('role', { ...common, httpOnly: false })
		res.clearCookie('user', { ...common, httpOnly: false })
	}

	function install(app) {
		app.use(attach)

		app.get('/login', (_req, res) => {
			res.sendFile(path.resolve(__dirname, '../../public/login.html'))
		})

		app.post('/api/auth/login', express.json({ limit: '16kb', strict: true }), (req, res) => {
			if (!enabled) return res.json({ role: 'owner', user: 'owner', authDisabled: true, redirect: '/' })
			const username = ((req.body && req.body.username) || '').trim()
			const password = (req.body && req.body.password) || ''
			if (username.length > 80 || typeof password !== 'string' || password.length > 1024) {
				noteFailure(req)
				return res.status(400).json({ error: 'Invalid sign-in request' })
			}
			if (isLocked(req, username)) {
				return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.', code: 'RATE_LIMITED' })
			}

			let session = null
			if (username) {
				// Named-account login (DB-backed).
				const u = store ? store.verify(username, password) : null
				if (u) session = { src: 'user', user: u.username, role: u.role, tv: u.token_version }
			} else {
				// Bootstrap env-password login (no username).
				const role = roleForPassword(password)
				if (role) session = { src: 'env', user: role, role }
			}

			if (!session) {
				noteFailure(req, username)
				return res.status(401).json({ error: 'Incorrect username or password' })
			}
			noteSuccess(req, username)
			setSessionCookies(req, res, session)
			res.json({ role: session.role, user: session.user, redirect: landingFor(session.role, req) })
		})

		app.post('/api/auth/logout', (req, res) => {
			clearSessionCookies(req, res)
			res.json({ ok: true })
		})

		app.get('/api/auth/me', (req, res) => {
			res.json(sessionDescriptor(req))
		})

		// Hand the page its own permissions, from the same table the gate above
		// enforces. Served as a synchronous script (not a fetch) so the first paint
		// already knows which tabs and controls exist — no flash of a button the
		// user may not press, and no second round-trip before the UI settles.
		//
		// This is a RENDERING HINT. Tampering with it only changes what the browser
		// draws; every request is still authorized server-side from the signed `sid`
		// cookie. `no-store` keeps it in step with the policy after a deploy or a
		// role change, which a cookie-carried copy could not do.
		app.get('/auth-session.js', (req, res) => {
			res.type('application/javascript')
			res.set('Cache-Control', 'no-store')
			res.send('window.__AUTH=' + JSON.stringify(sessionDescriptor(req)) + ';')
		})

		app.use(requirePage)
		app.use(requireApiAuth)
		app.use(roleGate)
	}

	/**
	 * Everything the browser needs to render the right UI for this session.
	 *
	 * `previewCapabilities` is what an EMPLOYEE would hold. The owner's "Preview
	 * Packing Mode" toggle renders against it, so the preview shows exactly what
	 * staff see instead of an approximation that drifts from the real policy.
	 */
	function sessionDescriptor(req) {
		const role = (req.auth && req.auth.role) || null
		return {
			authEnabled: enabled,
			role,
			user: (req.auth && req.auth.user) || null,
			capabilities: enabled ? policy.capabilitiesFor(role) : policy.capabilitiesFor('owner'),
			previewCapabilities: policy.capabilitiesFor('packer'),
			tabs: policy.TAB_CAPABILITY,
		}
	}

	return { enabled, install, requireCapability, attach, requireApiAuth, roleGate, requirePage, landingFor, sessionDescriptor, _rateState: rateState }
}

module.exports = { createAuth }
