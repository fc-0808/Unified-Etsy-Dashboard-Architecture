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
 *   • Two roles: `owner` (full access) and `packer` (packing/shipping only).
 *   • Identity is either a NAMED account (username + password, from the DB-backed
 *     user store) or a BOOTSTRAP env password (DASHBOARD_OWNER/PACKER_PASSWORD)
 *     so the owner can never be locked out. Named accounts add accountability +
 *     clean offboarding (see user-store.js).
 *   • On login we set a signed, HttpOnly cookie (`sid`) carrying the identity. It
 *     is HMAC-SHA256 signed (unforgeable) and HttpOnly (JS/XSS can't read it).
 *     Two non-secret cookies (`role`, `user`) are set purely so the page can
 *     render instantly — the server ignores them and always authorizes from `sid`.
 *   • Packer authorization is DENY-BY-DEFAULT: only an explicit allowlist of
 *     packing endpoints passes; everything else (finance, listings, admin…) 403s.
 *   • Named sessions are re-validated every request against the store, so
 *     disabling a user or bumping their token_version logs them out INSTANTLY —
 *     the offboarding kill-switch.
 *   • Login is rate-limited per IP to blunt brute-force.
 *
 * BACKWARD COMPATIBILITY / NO LOCKOUT
 *   Auth turns on only when DASHBOARD_OWNER_PASSWORD is set. With no password
 *   configured the dashboard behaves exactly as before (single trusted owner).
 */

const crypto = require('crypto')
const path = require('path')

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

// ── Login rate limiting ────────────────────────────────────────────────────
const RL_MAX_FAILS = 5 // consecutive failures before lockout
const RL_LOCK_MS = 15 * 60 * 1000 // lockout duration

// Endpoints a `packer` session may call. Anything not matched is denied (403).
// Matched against the full request path (no query). { m: method|'*', re }.
const PACKER_ALLOW = [
	{ m: 'GET', re: /^\/api\/health$/ },
	{ m: 'GET', re: /^\/api\/auth\/me$/ },
	{ m: 'GET', re: /^\/api\/shops$/ },
	{ m: 'GET', re: /^\/api\/shops\/listing-counts$/ },
	{ m: 'GET', re: /^\/api\/summary$/ },
	{ m: 'GET', re: /^\/api\/events$/ },
	{ m: 'GET', re: /^\/api\/exchange-rates$/ },
	{ m: 'GET', re: /^\/api\/orders$/ },
	{ m: '*', re: /^\/api\/orders\/[^/]+\/note$/ },
	{ m: 'GET', re: /^\/api\/orders\/[^/]+\/issues$/ },
	// Needs-purchase (buy) queue — an employee working the floor sees the
	// "still have to BUY these" list (Orders → Need-to-purchase preset) and marks
	// products/components purchased as they source them. This is the SAME
	// purchase-state surface a `shopper` gets through /api/shop/assign, just
	// exposed on the Orders tab; it only ever mutates purchase status (never
	// finance/listings/admin), so it stays inside the packer's remit.
	{ m: 'POST', re: /^\/api\/orders\/[^/]+\/needs-purchase$/ },
	{ m: 'POST', re: /^\/api\/orders\/[^/]+\/clear-needs-purchase$/ },
	{ m: 'POST', re: /^\/api\/orders\/[^/]+\/items\/component-status$/ },
	{ m: 'POST', re: /^\/api\/orders\/[^/]+\/items\/purchase-state$/ },
	// Verification (two-person integrity gate) — the packer confirms an order's
	// products are physically in hand each morning before packing. Only ever
	// stamps verification state (never finance/listings/admin), so it belongs in
	// the packer's remit alongside the purchase-status surface above.
	{ m: 'POST', re: /^\/api\/orders\/[^/]+\/items\/verify$/ },
	{ m: 'POST', re: /^\/api\/orders\/[^/]+\/verify-all$/ },
	{ m: 'POST', re: /^\/api\/orders\/bulk-verify$/ },
	{ m: 'POST', re: /^\/api\/orders\/[^/]+\/mark-packaged$/ },
	{ m: 'POST', re: /^\/api\/orders\/[^/]+\/unmark-packaged$/ },
	{ m: 'POST', re: /^\/api\/orders\/bulk-mark-packaged$/ },
	{ m: 'POST', re: /^\/api\/orders\/[^/]+\/ship$/ },
	{ m: 'POST', re: /^\/api\/orders\/[^/]+\/update-tracking$/ },
	// Manual (off-Etsy) orders can land in the packing queue too. A packer may pack
	// and ship them (local shipped toggle + tracking) exactly as they ship Etsy
	// orders — but NOT create/edit/delete them (owner catalog actions, kept off the
	// list; those controls are hidden in the packer UI).
	{ m: 'POST', re: /^\/api\/orders\/manual\/[^/]+\/shipped$/ },
	{ m: 'POST', re: /^\/api\/orders\/manual\/[^/]+\/tracking$/ },
	{ m: 'GET', re: /^\/api\/4px\/config$/ },
	{ m: 'GET', re: /^\/api\/4px\/products$/ },
	{ m: 'GET', re: /^\/api\/4px\/order\/[^/]+$/ },
	{ m: 'GET', re: /^\/api\/4px\/freight\/[^/]+$/ },
	{ m: 'POST', re: /^\/api\/4px\/create-order$/ },
	{ m: 'GET', re: /^\/api\/4px\/label\/[^/]+$/ },
	{ m: 'GET', re: /^\/api\/4px\/label-download\/[^/]+$/ },
	{ m: 'GET', re: /^\/api\/4px\/label-print\/[^/]+$/ },
	{ m: 'POST', re: /^\/api\/4px\/bulk-create-order$/ },
	{ m: 'GET', re: /^\/api\/4px\/bulk-labels\.zip$/ },
	{ m: 'POST', re: /^\/api\/4px\/bulk-complete$/ },
	{ m: 'GET', re: /^\/api\/4px\/track\/[^/]+$/ },
	{ m: 'POST', re: /^\/api\/4px\/track\/refresh\/[^/]+$/ },
	// Shopping Mode — a packer may also do the in-person shopping (view the route
	// and flip purchase statuses). Same surface a dedicated `shopper` gets; still
	// NO earnings/listings/admin. Keeps one employee able to both pack AND shop.
	{ m: 'GET', re: /^\/api\/shop\/route$/ },
	{ m: 'GET', re: /^\/api\/shop\/stream$/ },
	{ m: 'POST', re: /^\/api\/shop\/assign$/ },
	{ m: 'POST', re: /^\/api\/shop\/cost$/ },
	// "Same product" declarations — see the shopper allowlist below for why the
	// person on the shop floor is the right (and only) judge of this.
	{ m: 'POST', re: /^\/api\/route\/product-merges$/ },
	{ m: 'DELETE', re: /^\/api\/route\/product-merges$/ },
	// Wrong-model exchange ("Fix model") — a packer working the buy queue may flag a
	// line whose design is right but the phone model is wrong, so the correct model
	// is tracked and the line is held out of buying until swapped. These only touch
	// the local order_exchanges table (no finance / listings / Etsy), so they belong
	// in the packer's fulfilment remit alongside done/reopen.
	{ m: 'POST', re: /^\/api\/orders\/[^/]+\/exchanges$/ },
	{ m: 'DELETE', re: /^\/api\/exchanges\/[^/]+$/ },
	{ m: 'POST', re: /^\/api\/exchanges\/[^/]+\/done$/ },
	{ m: 'POST', re: /^\/api\/exchanges\/[^/]+\/reopen$/ },
	{ m: 'GET', re: /^\/api\/route\/floor-map$/ },
	{ m: 'GET', re: /^\/api\/route\/listing-image\/[^/]+$/ },
	{ m: 'GET', re: /^\/api\/route\/manual-image\/[^/]+$/ },
	{ m: 'GET', re: /^\/api\/route\/substitution-image\/[^/]+$/ },
	{ m: 'GET', re: /^\/api\/route\/charm-image$/ },
	// Sourcing Library — the employee's back-office job: register the WeChat/QQ
	// design suppliers and file the zipped product folders they publish. It only
	// ever touches the sourcing_* tables + the on-disk zip store (never finance,
	// listings, Etsy or admin), so the whole surface is in the packer's remit.
	{ m: '*', re: /^\/api\/sourcing\/.*/ },
	// Read-only charm shopping list for the Need-to-purchase tab (aggregated charm
	// pieces + supplier/stall + progress). Status changes go through the per-item
	// component-status endpoint above, so this stays a read of purchasing data.
	{ m: 'GET', re: /^\/api\/route\/charms-to-buy$/ },
]

// Endpoints a `shopper` session may call — the mobile shopping-route experience
// ONLY. Deny-by-default like the packer gate: a shopper never reaches earnings,
// listings, orders admin, 4PX, users, etc. Matched against the path (no query).
const SHOPPER_ALLOW = [
	{ m: 'GET', re: /^\/api\/health$/ },
	{ m: 'GET', re: /^\/api\/auth\/me$/ },
	{ m: 'GET', re: /^\/api\/shops$/ }, // shop filter dropdown
	{ m: 'GET', re: /^\/api\/shop\/route$/ }, // live route rows
	{ m: 'GET', re: /^\/api\/shop\/stream$/ }, // real-time SSE feed
	{ m: 'POST', re: /^\/api\/shop\/assign$/ }, // update a purchase status
	{ m: 'POST', re: /^\/api\/shop\/cost$/ }, // set a product/charm purchase cost
	// Declare / undo "these listings are the same physical product". Two shops
	// routinely photograph one product differently, which no image hash can link,
	// so the same order splits into two cards and gets bought twice. The shopper
	// at the stall is holding the product and is the only reliable judge — this
	// writes purchasing metadata only (product_merges), never finance/listings.
	{ m: 'POST', re: /^\/api\/route\/product-merges$/ },
	{ m: 'DELETE', re: /^\/api\/route\/product-merges$/ },
	{ m: 'POST', re: /^\/api\/exchanges\/[^/]+\/done$/ }, // mark a wrong-model swap done
	{ m: 'POST', re: /^\/api\/exchanges\/[^/]+\/reopen$/ }, // undo a swap-done
	{ m: 'GET', re: /^\/api\/route\/floor-map$/ }, // in-person supplier map
	{ m: 'GET', re: /^\/api\/route\/listing-image\/[^/]+$/ }, // product photos
	{ m: 'GET', re: /^\/api\/route\/manual-image\/[^/]+$/ }, // manual-item photos
	{ m: 'GET', re: /^\/api\/route\/substitution-image\/[^/]+$/ }, // switched-design photos
	{ m: 'GET', re: /^\/api\/route\/charm-image$/ }, // charm photos
]

function timingSafeEqualStr(a, b) {
	const ab = Buffer.from(String(a))
	const bb = Buffer.from(String(b))
	if (ab.length !== bb.length) {
		crypto.timingSafeEqual(ab, ab)
		return false
	}
	return crypto.timingSafeEqual(ab, bb)
}

function parseCookies(header) {
	const out = {}
	if (!header) return out
	for (const part of header.split(';')) {
		const i = part.indexOf('=')
		if (i < 0) continue
		const k = part.slice(0, i).trim()
		const v = part.slice(i + 1).trim()
		if (k) out[k] = decodeURIComponent(v)
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

	const secret =
		process.env.DASHBOARD_AUTH_SECRET ||
		crypto.createHash('sha256').update('etsy-dashboard-auth::' + ownerPw + '::' + packerPw + '::' + shopperPw).digest('hex')

	// IP → { fails, lockedUntil }
	const rateState = new Map()
	const clientIp = (req) => req.ip || (req.socket && req.socket.remoteAddress) || 'unknown'
	function isLocked(req) {
		const s = rateState.get(clientIp(req))
		return !!(s && s.lockedUntil && s.lockedUntil > Date.now())
	}
	function noteFailure(req) {
		const ip = clientIp(req)
		const s = rateState.get(ip) || { fails: 0, lockedUntil: 0 }
		s.fails += 1
		if (s.fails >= RL_MAX_FAILS) s.lockedUntil = Date.now() + RL_LOCK_MS
		rateState.set(ip, s)
	}
	function noteSuccess(req) {
		rateState.delete(clientIp(req))
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
			if (!obj || (obj.role !== 'owner' && obj.role !== 'packer' && obj.role !== 'shopper')) return null
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

	function packerGate(req, res, next) {
		if (!isApi(req)) return next()
		if (!enabled) return next()
		if (!req.auth || req.auth.role !== 'packer') return next() // owner: unrestricted
		if (req.path === '/api/health' || req.path.startsWith('/api/auth/')) return next()
		const ok = PACKER_ALLOW.some((rule) => (rule.m === '*' || rule.m === req.method) && rule.re.test(req.path))
		if (ok) return next()
		return res.status(403).json({ error: 'This action is not available in Packing Mode.', code: 'FORBIDDEN_ROLE' })
	}

	function shopperGate(req, res, next) {
		if (!isApi(req)) return next()
		if (!enabled) return next()
		if (!req.auth || req.auth.role !== 'shopper') return next() // owner/packer handled elsewhere
		if (req.path === '/api/health' || req.path.startsWith('/api/auth/')) return next()
		const ok = SHOPPER_ALLOW.some((rule) => (rule.m === '*' || rule.m === req.method) && rule.re.test(req.path))
		if (ok) return next()
		return res.status(403).json({ error: 'This action is not available in Shopping Mode.', code: 'FORBIDDEN_ROLE' })
	}

	// Is this request coming from the local office LAN (vs. through the public
	// tunnel)? A tunnel proxies the request and therefore stamps X-Forwarded-*
	// headers; a direct LAN/localhost hit has none. We also treat localhost and
	// private-IP hosts as local. This lets packers use Packing Mode in the office
	// but be shopping-only when they open the same site remotely.
	function isLocalRequest(req) {
		const h = req.headers || {}
		if (h['x-forwarded-for'] || h['x-forwarded-host']) return false
		if (String(h['x-forwarded-proto'] || '').toLowerCase() === 'https') return false
		// Strip the optional :port. IPv6 hosts arrive bracketed (e.g. "[::1]:3000"),
		// so unwrap the brackets before comparing rather than naively split(':').
		let host = String(h.host || '').toLowerCase().trim()
		if (host.startsWith('[')) {
			host = host.slice(1, host.indexOf(']') === -1 ? host.length : host.indexOf(']'))
		} else {
			host = host.split(':')[0]
		}
		if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true
		if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true
		if (/^169\.254\./.test(host)) return true // link-local
		// Unknown host with no proxy headers → be conservative (shopping-only).
		return false
	}

	// The page a role should land on after sign-in.
	//   owner   → full dashboard.
	//   shopper → mobile Shopping Route (always; this role never packs).
	//   packer  → Packing Mode (dashboard) on the LAN, but Shopping Route when
	//             reached remotely through the tunnel.
	function landingFor(role, req) {
		if (role === 'owner') return '/'
		if (role === 'shopper') return '/shop'
		return isLocalRequest(req) ? '/' : '/shop'
	}

	function requirePage(req, res, next) {
		if (!enabled) return next()
		const isDash = req.path === '/' || req.path === '/index.html'
		const isShop = req.path === '/shop' || req.path === '/shop.html'
		const isSourcing = req.path === '/sourcing' || req.path === '/sourcing.html'
		if (!isDash && !isShop && !isSourcing) return next()
		if (!req.auth || !req.auth.role) return res.redirect('/login')
		// Guard the full dashboard: a shopper is always bounced to /shop; a packer
		// is bounced only when NOT on the LAN (so Packing Mode is excluded through
		// the tunnel but available in the office).
		if (isDash && req.auth.role !== 'owner') {
			if (req.auth.role === 'shopper' || !isLocalRequest(req)) return res.redirect('/shop')
		}
		// Sourcing Library is a desk task for the owner + packer. A shopper (mobile
		// in-person shopping only) never sources, so bounce them to their route.
		if (isSourcing && req.auth.role === 'shopper') return res.redirect('/shop')
		return next()
	}

	function requireOwner(req, res, next) {
		if (!enabled) return next()
		if (req.auth && req.auth.role === 'owner') return next()
		return res.status(403).json({ error: 'Owner access required', code: 'FORBIDDEN_ROLE' })
	}

	function setSessionCookies(req, res, session) {
		const secure = req.secure || req.headers['x-forwarded-proto'] === 'https'
		const token = sign({ ...session, iat: Date.now(), exp: Date.now() + SESSION_MAX_AGE_MS })
		res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', secure, maxAge: SESSION_MAX_AGE_MS, path: '/' })
		// Non-secret UI hints so the page renders instantly. Server never trusts these.
		res.cookie('role', session.role, { httpOnly: false, sameSite: 'lax', secure, maxAge: SESSION_MAX_AGE_MS, path: '/' })
		res.cookie('user', session.user, { httpOnly: false, sameSite: 'lax', secure, maxAge: SESSION_MAX_AGE_MS, path: '/' })
	}

	function clearSessionCookies(res) {
		res.clearCookie('sid', { path: '/' })
		res.clearCookie('role', { path: '/' })
		res.clearCookie('user', { path: '/' })
	}

	function install(app) {
		app.use(attach)

		app.get('/login', (_req, res) => {
			res.sendFile(path.resolve(__dirname, '../../public/login.html'))
		})

		app.post('/api/auth/login', (req, res) => {
			if (!enabled) return res.json({ role: 'owner', user: 'owner', authDisabled: true, redirect: '/' })
			if (isLocked(req)) {
				return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.', code: 'RATE_LIMITED' })
			}
			const username = ((req.body && req.body.username) || '').trim()
			const password = (req.body && req.body.password) || ''

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
				noteFailure(req)
				return res.status(401).json({ error: 'Incorrect username or password' })
			}
			noteSuccess(req)
			setSessionCookies(req, res, session)
			res.json({ role: session.role, user: session.user, redirect: landingFor(session.role, req) })
		})

		app.post('/api/auth/logout', (_req, res) => {
			clearSessionCookies(res)
			res.json({ ok: true })
		})

		app.get('/api/auth/me', (req, res) => {
			res.json({ role: (req.auth && req.auth.role) || null, user: (req.auth && req.auth.user) || null, authEnabled: enabled })
		})

		app.use(requirePage)
		app.use(requireApiAuth)
		app.use(packerGate)
		app.use(shopperGate)
	}

	return { enabled, install, requireOwner, attach, requireApiAuth, packerGate, shopperGate, requirePage, landingFor, _rateState: rateState }
}

module.exports = { createAuth }
