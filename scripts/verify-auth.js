/**
 * verify-auth.js — end-to-end proof that Owner/Employee access control works.
 *
 * Suite A — env bootstrap accounts (password only).
 * Suite B — named DB-backed accounts: per-user login, the offboarding kill-switch,
 *           and login rate-limiting.
 *
 * Everything runs on throwaway ports against an in-memory DB — it never touches
 * your real server, database, or .env passwords.  Run any time:
 *     npm run verify:auth
 */

process.env.DASHBOARD_OWNER_PASSWORD = process.env.DASHBOARD_OWNER_PASSWORD || 'test-owner-pw'
process.env.DASHBOARD_PACKER_PASSWORD = process.env.DASHBOARD_PACKER_PASSWORD || 'test-packer-pw'

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
	// Charm shopping list: read-only bundle is employee-safe; the full route planner is not.
	app.get('/api/route/charms-to-buy', (_req, res) => res.json({ ok: true, rows: [], charms: [], charm_shops: [], progress: {} }))
	app.get('/api/route/dashboard', (_req, res) => res.json({ rows: [] }))
	app.post('/api/route/assign', (_req, res) => res.json({ ok: true }))
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
	// Bulk needs-purchase stays owner-only (the packer UI never exposes it).
	r = await post('/api/orders/bulk-needs-purchase')
	check('Employee BLOCKED from bulk needs-purchase (403)', r.status === 403, `got ${r.status}`)

	// Charms-to-buy list is read-only + employee-safe; the owner route planner and
	// its assign endpoint stay blocked (employees persist via component-status).
	r = await fetch(base + '/api/route/charms-to-buy', { headers: { cookie: packer } })
	check('Employee CAN read the charm shopping list (200)', r.status === 200, `got ${r.status}`)
	r = await fetch(base + '/api/route/dashboard', { headers: { cookie: packer } })
	check('Employee BLOCKED from the owner route planner (403)', r.status === 403, `got ${r.status}`)
	r = await post('/api/route/assign')
	check('Employee BLOCKED from route/assign (403)', r.status === 403, `got ${r.status}`)

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
	server.close()
}

async function suiteB() {
	console.log('\n  Suite B — named accounts, offboarding kill-switch, rate limiting\n')
	const db = new Database(':memory:')
	const store = createUserStore(db)
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

;(async () => {
	await suiteA()
	await suiteB()
	console.log(`\n  ${pass} passed, ${fail} failed\n`)
	process.exit(fail ? 1 : 0)
})()
