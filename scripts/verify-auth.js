/**
 * verify-auth.js — end-to-end proof that Owner/Employee access control works.
 *
 * Suite A — env bootstrap accounts (password only), including the employee's
 *           full authority over the shopping route.
 * Suite B — named DB-backed accounts: per-user login, the offboarding kill-switch,
 *           and login rate-limiting.
 * Suite C — the `shopper` role stays confined to the mobile shopping route even
 *           though the employee role was widened.
 *
 * Everything runs on throwaway ports against an in-memory DB — it never touches
 * your real server, database, or .env passwords.  Run any time:
 *     npm run verify:auth
 */

process.env.DASHBOARD_OWNER_PASSWORD = process.env.DASHBOARD_OWNER_PASSWORD || 'test-owner-pw'
process.env.DASHBOARD_PACKER_PASSWORD = process.env.DASHBOARD_PACKER_PASSWORD || 'test-packer-pw'
process.env.DASHBOARD_SHOPPER_PASSWORD = process.env.DASHBOARD_SHOPPER_PASSWORD || 'test-shopper-pw'
process.env.DASHBOARD_AUTH_SECRET = process.env.DASHBOARD_AUTH_SECRET || 'offline-auth-test-secret-32-bytes-minimum'

const express = require('express')
const Database = require('better-sqlite3')
const { createAuth } = require('../src/auth/access')
const { createUserStore } = require('../src/auth/user-store')

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
	if (cond) {
		pass++
		console.log(`  \x1b[32m✓\x1b[0m ${name}`)
	} else {
		fail++
		console.log(`  \x1b[31m✗ ${name}\x1b[0m ${extra}`)
	}
}
const setCookies = (resp) => (typeof resp.headers.getSetCookie === 'function' ? resp.headers.getSetCookie() : [])
const cookieHeader = (resp) =>
	setCookies(resp)
		.map((c) => c.split(';')[0])
		.join('; ')

function buildApp(store) {
	const app = express()
	app.use(express.json())
	const auth = createAuth(store ? { store } : {})
	auth.install(app)
	app.get('/', (_req, res) => res.send('<html>dashboard</html>'))
	app.get('/api/finance/summary', (_req, res) => res.json({ earnings: 123456 }))
	app.get('/api/etsy/budget', (_req, res) => res.json({ budget: 1 }))
	app.get('/api/orders', (_req, res) => res.json({ orders: [], total: 0 }))
	app.post('/api/orders/:id/ship', (_req, res) => res.json({ ok: true }))
	// Needs-purchase (buy) queue — the employee-facing purchase-state surface.
	app.post('/api/orders/:id/needs-purchase', (_req, res) => res.json({ ok: true }))
	app.post('/api/orders/:id/clear-needs-purchase', (_req, res) => res.json({ ok: true }))
	app.post('/api/orders/:id/items/component-status', (_req, res) => res.json({ ok: true }))
	app.post('/api/orders/:id/items/purchase-state', (_req, res) => res.json({ ok: true }))
	app.post('/api/orders/bulk-needs-purchase', (_req, res) => res.json({ ok: true }))
	// Wrong-model exchange ("Fix model") — create/remove/done/reopen are packer-safe
	// (local order_exchanges table only, no finance/listings/Etsy).
	app.post('/api/orders/:id/exchanges', (_req, res) => res.json({ ok: true, exchange: { id: 1 } }))
	app.delete('/api/exchanges/:id', (_req, res) => res.json({ ok: true }))
	app.post('/api/exchanges/:id/done', (_req, res) => res.json({ ok: true }))
	app.post('/api/exchanges/:id/reopen', (_req, res) => res.json({ ok: true }))
	// Shopping route — the employee owns this surface end to end.
	app.get('/api/route/charms-to-buy', (_req, res) => res.json({ ok: true, rows: [], charms: [], charm_shops: [], progress: {} }))
	app.get('/api/route/dashboard', (_req, res) => res.json({ rows: [] }))
	app.post('/api/route/assign', (_req, res) => res.json({ ok: true }))
	app.post('/api/route/dismiss', (_req, res) => res.json({ ok: true }))
	app.get('/api/route/charms', (_req, res) => res.json({ charms: [] }))
	app.post('/api/route/charms', (_req, res) => res.json({ ok: true }))
	app.put('/api/route/charms', (_req, res) => res.json({ ok: true }))
	app.delete('/api/route/charms', (_req, res) => res.json({ ok: true }))
	app.post('/api/route/suppliers', (_req, res) => res.json({ ok: true }))
	app.delete('/api/route/charm-shops', (_req, res) => res.json({ ok: true }))
	app.put('/api/route/product-map', (_req, res) => res.json({ ok: true }))
	app.post('/api/route/manual-order', (_req, res) => res.json({ ok: true }))
	app.post('/api/route/generate', (_req, res) => res.json({ ok: true }))
	app.post('/api/route/import-status', (_req, res) => res.json({ ok: true }))
	app.get('/api/route/charm-image', (_req, res) => res.json({ ok: true }))
	app.get('/api/shop/route', (_req, res) => res.json({ rows: [] }))
	// Opening a file in a desktop app happens on the SERVER's machine, so it stays
	// with whoever is sitting at it.
	app.get('/api/route/open', (_req, res) => res.json({ ok: true }))
	// Manual (off-Etsy) orders: pack/ship + tracking are employee-safe; create/edit/delete are not.
	app.post('/api/orders/manual', (_req, res) => res.json({ created: true }))
	app.put('/api/orders/manual/:id', (_req, res) => res.json({ ok: true }))
	app.delete('/api/orders/manual/:id', (_req, res) => res.json({ ok: true }))
	app.post('/api/orders/manual/:id/shipped', (_req, res) => res.json({ ok: true }))
	app.post('/api/orders/manual/:id/tracking', (_req, res) => res.json({ ok: true }))
	app.post('/api/listings', (_req, res) => res.json({ created: true }))
	app.use('/api', (_req, res) => res.status(404).json({ error: 'unknown' }))
	return app
}
const listen = (app) => new Promise((resolve) => { const s = app.listen(0, () => resolve(s)) })
const login = (base, body) => fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

async function suiteA() {
	console.log('\n  Suite A — env bootstrap accounts (password only)\n')
	const server = await listen(buildApp(null))
	const base = `http://127.0.0.1:${server.address().port}`

	let r = await fetch(base + '/api/orders', { redirect: 'manual' })
	check('Unauthenticated API blocked (401)', r.status === 401, `got ${r.status}`)
	r = await fetch(base + '/', { redirect: 'manual' })
	check('Unauthenticated dashboard → /login (302)', r.status === 302 && r.headers.get('location') === '/login', `got ${r.status}`)

	r = await login(base, { password: process.env.DASHBOARD_PACKER_PASSWORD })
	const packer = cookieHeader(r)
	check('Employee (env) login → role "packer"', r.status === 200 && (await r.clone().json()).role === 'packer')
	const sid = setCookies(r).find((c) => c.startsWith('sid=')) || ''
	check('Session cookie is HttpOnly', /httponly/i.test(sid))

	r = await fetch(base + '/api/finance/summary', { headers: { cookie: packer } })
	check('Employee BLOCKED from earnings (403)', r.status === 403, `got ${r.status}`)
	r = await fetch(base + '/api/orders', { headers: { cookie: packer } })
	check('Employee CAN see orders (200)', r.status === 200, `got ${r.status}`)
	const remoteHeaders = {
		cookie: packer,
		'x-forwarded-for': '203.0.113.10, 127.0.0.1',
		'x-forwarded-proto': 'https',
	}
	r = await fetch(base + '/api/orders', { headers: remoteHeaders })
	check('Remote employee is BLOCKED from desktop order APIs (403)', r.status === 403 && (await r.clone().json()).code === 'REMOTE_SCOPE_RESTRICTED', `got ${r.status}`)
	r = await fetch(base + '/api/shop/route', { headers: remoteHeaders })
	check('Remote employee retains the mobile shopping route (200)', r.status === 200, `got ${r.status}`)
	r = await fetch(base + '/', { headers: remoteHeaders, redirect: 'manual' })
	check('Remote employee dashboard page redirects to /shop', r.status === 302 && r.headers.get('location') === '/shop', `got ${r.status}`)
	r = await fetch(base + '/api/orders/5/ship', { method: 'POST', headers: { cookie: packer, 'Content-Type': 'application/json' }, body: '{}' })
	check('Employee CAN ship an order (200)', r.status === 200, `got ${r.status}`)

	// Needs-purchase (buy) queue — employees source products and mark them bought.
	const post = (path) => fetch(base + path, { method: 'POST', headers: { cookie: packer, 'Content-Type': 'application/json' }, body: '{}' })
	r = await post('/api/orders/5/items/component-status')
	check('Employee CAN set a component purchase status (200)', r.status === 200, `got ${r.status}`)
	r = await post('/api/orders/5/items/purchase-state')
	check('Employee CAN mark a product purchased (200)', r.status === 200, `got ${r.status}`)
	r = await post('/api/orders/5/needs-purchase')
	check('Employee CAN flag an order needs-purchase (200)', r.status === 200, `got ${r.status}`)
	r = await post('/api/orders/5/clear-needs-purchase')
	check('Employee CAN clear an order needs-purchase (200)', r.status === 200, `got ${r.status}`)
	// Bulk needs-purchase is the same decision as the per-order flag, applied to a
	// selection — it powers "Send to Route", so the employee has it too.
	r = await post('/api/orders/bulk-needs-purchase')
	check('Employee CAN bulk-flag orders needs-purchase (200)', r.status === 200, `got ${r.status}`)

	// Wrong-model exchange ("Fix model") — an employee sourcing the buy queue can
	// flag a design-right/model-wrong line to swap, and manage that exchange.
	r = await post('/api/orders/5/exchanges')
	check('Employee CAN flag a wrong-model exchange (200)', r.status === 200, `got ${r.status}`)
	r = await post('/api/exchanges/9/done')
	check('Employee CAN mark an exchange done (200)', r.status === 200, `got ${r.status}`)
	r = await post('/api/exchanges/9/reopen')
	check('Employee CAN reopen an exchange (200)', r.status === 200, `got ${r.status}`)
	r = await fetch(base + '/api/orders/9/exchanges', { method: 'GET', headers: { cookie: packer } })
	check('Employee BLOCKED from a non-allowlisted method on exchanges (403)', r.status === 403, `got ${r.status}`)
	r = await fetch(base + '/api/exchanges/9', { method: 'DELETE', headers: { cookie: packer } })
	check('Employee CAN remove an exchange (200)', r.status === 200, `got ${r.status}`)

	// Shopping route — the employee runs the Orders Sorting Dashboard and owns the
	// case/grip/charm master data behind it, so read, per-line writes, catalog CRUD
	// and generation must all pass.
	const get = (path) => fetch(base + path, { headers: { cookie: packer } })
	const send = (method, path) => fetch(base + path, { method, headers: { cookie: packer, 'Content-Type': 'application/json' }, body: '{}' })

	r = await get('/api/route/charms-to-buy')
	check('Employee CAN read the charm shopping list (200)', r.status === 200, `got ${r.status}`)
	r = await get('/api/route/dashboard')
	check('Employee CAN open the Orders Sorting Dashboard (200)', r.status === 200, `got ${r.status}`)
	r = await get('/api/route/charm-image?code=CH-1')
	check('Employee CAN load charm images (200)', r.status === 200, `got ${r.status}`)
	r = await post('/api/route/assign')
	check('Employee CAN assign a route line (200)', r.status === 200, `got ${r.status}`)
	r = await post('/api/route/dismiss')
	check('Employee CAN remove a line from the route (200)', r.status === 200, `got ${r.status}`)
	r = await post('/api/route/manual-order')
	check('Employee CAN add an order to the route (200)', r.status === 200, `got ${r.status}`)

	// Full CRUD on the case/grip/charm catalog.
	r = await get('/api/route/charms')
	check('Employee CAN read the charm library (200)', r.status === 200, `got ${r.status}`)
	r = await post('/api/route/charms')
	check('Employee CAN create a charm (200)', r.status === 200, `got ${r.status}`)
	r = await send('PUT', '/api/route/charms')
	check('Employee CAN update a charm (200)', r.status === 200, `got ${r.status}`)
	r = await send('DELETE', '/api/route/charms')
	check('Employee CAN delete a charm (200)', r.status === 200, `got ${r.status}`)
	r = await post('/api/route/suppliers')
	check('Employee CAN add a supplier (200)', r.status === 200, `got ${r.status}`)
	r = await send('DELETE', '/api/route/charm-shops')
	check('Employee CAN delete a charm shop (200)', r.status === 200, `got ${r.status}`)
	r = await send('PUT', '/api/route/product-map')
	check('Employee CAN edit the product catalog (200)', r.status === 200, `got ${r.status}`)
	r = await post('/api/route/generate')
	check('Employee CAN generate the shopping route (200)', r.status === 200, `got ${r.status}`)
	r = await post('/api/route/import-status')
	check('Employee CAN import a purchase-status workbook (200)', r.status === 200, `got ${r.status}`)

	// …but launching a desktop app happens on the server's machine, not theirs.
	r = await get('/api/route/open?file=shopping_route.xlsx')
	check('Employee BLOCKED from opening a file on the server desktop (403)', r.status === 403, `got ${r.status}`)

	// Manual orders in the packing queue: pack/ship + tracking allowed; edit/delete/create not.
	r = await post('/api/orders/manual/-5/shipped')
	check('Employee CAN mark a manual order shipped (200)', r.status === 200, `got ${r.status}`)
	r = await post('/api/orders/manual/-5/tracking')
	check('Employee CAN add manual-order tracking (200)', r.status === 200, `got ${r.status}`)
	r = await post('/api/orders/manual')
	check('Employee BLOCKED from creating a manual order (403)', r.status === 403, `got ${r.status}`)
	r = await fetch(base + '/api/orders/manual/-5', { method: 'DELETE', headers: { cookie: packer } })
	check('Employee BLOCKED from deleting a manual order (403)', r.status === 403, `got ${r.status}`)

	r = await login(base, { password: process.env.DASHBOARD_OWNER_PASSWORD })
	const owner = cookieHeader(r)
	r = await fetch(base + '/api/finance/summary', { headers: { cookie: owner } })
	check('Owner CAN see earnings (200)', r.status === 200)

	r = await fetch(base + '/api/finance/summary', { headers: { cookie: 'sid=eyJyb2xlIjoib3duZXIifQ.forged; role=owner' } })
	check('Forged cookie rejected (401)', r.status === 401, `got ${r.status}`)
	r = await fetch(base + '/api/finance/summary', { headers: { cookie: 'sid=%E0%A4%A; role=owner' } })
	check('Malformed cookie is rejected without crashing middleware (401)', r.status === 401, `got ${r.status}`)
	r = await login(base, { password: 'x'.repeat(1025) })
	check('Oversized login input is rejected before hashing (400)', r.status === 400, `got ${r.status}`)

	// The browser is told its own permissions by the server, from the same table
	// the gate enforces — that is what keeps the UI from offering a 403.
	r = await fetch(base + '/auth-session.js', { headers: { cookie: packer } })
	const shim = await r.text()
	const caps = JSON.parse(shim.replace(/^window\.__AUTH=/, '').replace(/;$/, ''))
	check('Session bootstrap declares the employee role', caps.role === 'packer', shim.slice(0, 120))
	check('Session bootstrap grants route control', caps.capabilities.includes('route:catalog') && caps.capabilities.includes('route:assign'))
	check('Session bootstrap withholds earnings', !caps.capabilities.includes('finance:read'))
	check('Session bootstrap is never cached', /no-store/.test(r.headers.get('cache-control') || ''))

	r = await fetch(base + '/api/auth/login', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'x-forwarded-proto': 'https' },
		body: JSON.stringify({ password: process.env.DASHBOARD_OWNER_PASSWORD }),
	})
	const secureCookie = cookieHeader(r)
	check('TLS-terminated login marks the session cookie Secure', /secure/i.test(setCookies(r).find((c) => c.startsWith('sid=')) || ''))
	r = await fetch(base + '/api/auth/logout', {
		method: 'POST',
		headers: { cookie: secureCookie, 'x-forwarded-proto': 'https' },
	})
	const clearedSid = setCookies(r).find((c) => c.startsWith('sid=')) || ''
	check('HTTPS logout clears sid with matching Secure/SameSite attributes', /sid=;/.test(clearedSid) && /secure/i.test(clearedSid) && /samesite=lax/i.test(clearedSid))

	server.close()
}

async function suiteB() {
	console.log('\n  Suite B — named accounts, offboarding kill-switch, rate limiting\n')
	const db = new Database(':memory:')
	const store = createUserStore(db)
	let weakPasswordRejected = false
	try {
		store.add({ username: 'weak', password: 'short', role: 'packer', createdBy: 'test' })
	} catch {
		weakPasswordRejected = true
	}
	check('Named accounts enforce the 12-character minimum', weakPasswordRejected)
	const mei = store.add({ username: 'mei', password: 'packer-pass-1', role: 'packer', createdBy: 'test' })
	store.add({ username: 'boss', password: 'owner-pass-1', role: 'owner', createdBy: 'test' })

	const server = await listen(buildApp(store))
	const base = `http://127.0.0.1:${server.address().port}`

	// Named employee login.
	let r = await login(base, { username: 'mei', password: 'packer-pass-1' })
	const meiCookie = cookieHeader(r)
	const meiBody = await r.json()
	check('Named employee "mei" logs in → role "packer"', r.status === 200 && meiBody.role === 'packer' && meiBody.user === 'mei', JSON.stringify(meiBody))
	r = await fetch(base + '/api/finance/summary', { headers: { cookie: meiCookie } })
	check('Named employee BLOCKED from earnings (403)', r.status === 403, `got ${r.status}`)
	r = await fetch(base + '/api/orders', { headers: { cookie: meiCookie } })
	check('Named employee CAN see orders (200)', r.status === 200, `got ${r.status}`)

	// Wrong username/password.
	r = await login(base, { username: 'mei', password: 'wrong' })
	check('Wrong password for named user rejected (401)', r.status === 401, `got ${r.status}`)

	// Offboarding kill-switch: disable → live session dies instantly.
	store.setActive(mei.id, false)
	r = await fetch(base + '/api/orders', { headers: { cookie: meiCookie } })
	check('Disabling employee kills their live session (401)', r.status === 401, `got ${r.status}`)
	r = await login(base, { username: 'mei', password: 'packer-pass-1' })
	check('Disabled employee cannot log back in (401)', r.status === 401, `got ${r.status}`)

	// Owner named account still works and sees earnings.
	r = await login(base, { username: 'boss', password: 'owner-pass-1' })
	const bossCookie = cookieHeader(r)
	r = await fetch(base + '/api/finance/summary', { headers: { cookie: bossCookie } })
	check('Named owner "boss" CAN see earnings (200)', r.status === 200, `got ${r.status}`)

	// Rate limiting: 5 bad attempts → locked out (429).
	let lastStatus = 0
	for (let i = 0; i < 5; i++) {
		const rr = await login(base, { username: 'ghost', password: 'nope' })
		lastStatus = rr.status
	}
	r = await login(base, { username: 'ghost', password: 'nope' })
	check('Login rate-limited after repeated failures (429)', r.status === 429, `got ${r.status} (5th=${lastStatus})`)

	server.close()
}

/**
 * Widening the employee role must not widen the shopper role with it. The
 * shopper is the in-person mobile account: it may work its route and nothing
 * else, and this suite is what proves the two roles stayed independent.
 */
async function suiteC() {
	console.log('\n  Suite C — the shopper role stays confined to the mobile route\n')
	const server = await listen(buildApp(null))
	const base = `http://127.0.0.1:${server.address().port}`

	let r = await login(base, { password: process.env.DASHBOARD_SHOPPER_PASSWORD })
	const shopper = cookieHeader(r)
	check('Shopper (env) login → role "shopper"', r.status === 200 && (await r.clone().json()).role === 'shopper')
	check('Shopper lands on the mobile route', (await r.clone().json()).redirect === '/shop')

	const get = (path) => fetch(base + path, { headers: { cookie: shopper } })
	const post = (path) => fetch(base + path, { method: 'POST', headers: { cookie: shopper, 'Content-Type': 'application/json' }, body: '{}' })

	r = await get('/api/route/charm-image?code=CH-1')
	check('Shopper CAN load charm images (200)', r.status === 200, `got ${r.status}`)
	r = await post('/api/exchanges/9/done')
	check('Shopper CAN mark an exchange done (200)', r.status === 200, `got ${r.status}`)

	r = await get('/api/route/dashboard')
	check('Shopper BLOCKED from the sorting dashboard (403)', r.status === 403, `got ${r.status}`)
	r = await post('/api/route/charms')
	check('Shopper BLOCKED from charm CRUD (403)', r.status === 403, `got ${r.status}`)
	r = await post('/api/route/generate')
	check('Shopper BLOCKED from route generation (403)', r.status === 403, `got ${r.status}`)
	r = await get('/api/orders')
	check('Shopper BLOCKED from the order list (403)', r.status === 403, `got ${r.status}`)
	r = await get('/api/finance/summary')
	check('Shopper BLOCKED from earnings (403)', r.status === 403, `got ${r.status}`)

	// A denial names the permission that was missing, so an owner has something
	// actionable instead of a bare 403.
	const body = await r.json()
	check('Denial names the missing permission', body.code === 'FORBIDDEN_ROLE' && 'required' in body, JSON.stringify(body))

	r = await fetch(base + '/', { headers: { cookie: shopper }, redirect: 'manual' })
	check('Shopper redirected off the desktop dashboard (302 → /shop)', r.status === 302 && r.headers.get('location') === '/shop', `got ${r.status}`)

	server.close()
}

async function suiteD() {
	console.log('\n  Suite D — secret configuration fails closed\n')
	const previous = process.env.DASHBOARD_AUTH_SECRET
	delete process.env.DASHBOARD_AUTH_SECRET
	let missingRejected = false
	try {
		createAuth()
	} catch {
		missingRejected = true
	}
	check('Auth requires a session secret when enabled', missingRejected)

	process.env.DASHBOARD_AUTH_SECRET = 'too-short'
	let rejected = false
	try {
		createAuth()
	} catch {
		rejected = true
	} finally {
		if (previous === undefined) delete process.env.DASHBOARD_AUTH_SECRET
		else process.env.DASHBOARD_AUTH_SECRET = previous
	}
	check('Auth rejects an explicitly weak session secret', rejected)
}

;(async () => {
	await suiteA()
	await suiteB()
	await suiteC()
	await suiteD()
	console.log(`\n  ${pass} passed, ${fail} failed\n`)
	process.exit(fail ? 1 : 0)
})()
