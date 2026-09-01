/**
 * test-access-policy.js — pins the access policy so a change to it is deliberate.
 *
 * verify-auth.js proves the middleware WIRING works end-to-end over HTTP. This
 * suite tests the table itself, which is cheaper and catches a different class
 * of mistake:
 *
 *   • Rule ORDER. The ACL is first-match-wins, so a broad rule placed above a
 *     narrow one silently widens access. The route surface has exactly this
 *     shape (`GET /api/route/*` sits under several tighter rules), and nothing
 *     about reading the file tells you the order is still right.
 *   • DRIFT between the server policy and the UI. The dashboard hides tabs from
 *     `data-cap` attributes in public/index.html; if those stop matching
 *     TAB_CAPABILITY, an employee is shown a tab whose API 403s (or is denied a
 *     tab they may use). The HTML is asserted against the policy here.
 *   • TYPOS. A capability granted to a role, required by a rule, or written into
 *     the HTML that does not exist in CAPABILITIES fails closed and silently —
 *     the permission simply never matches.
 *
 *     npm run test:access-policy
 */

const fs = require('fs')
const path = require('path')
const policy = require('../src/auth/policy')

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

// ── 1. Vocabulary ────────────────────────────────────────────────────────────
console.log('\n  Every capability in use is a declared capability\n')
{
	const known = new Set(Object.keys(policy.CAPABILITIES))
	const unknown = (list, where) => list.filter((c) => c !== policy.ALL && !known.has(c)).map((c) => `${where}:${c}`)

	const offenders = [
		...Object.entries(policy.ROLE_CAPABILITIES).flatMap(([role, caps]) => unknown([...caps], `role ${role}`)),
		...unknown(
			policy.API_RULES.map((r) => r.cap),
			'rule',
		),
		...unknown(Object.values(policy.TAB_CAPABILITY), 'tab'),
	]
	check('No role, rule or tab references an undeclared capability', offenders.length === 0, offenders.join(', '))

	// The other direction: a declared capability nothing consults is dead weight
	// at best, and at worst the survivor of a rename whose call sites moved on.
	// Capabilities checked in code rather than by an ACL rule: the page guard in
	// access.js and the staff-admin routes in src/server/index.js.
	const CHECKED_IN_CODE = ['dashboard:view', 'dashboard:remote', 'admin:users', 'operations:checklist']
	const consulted = new Set([...policy.API_RULES.map((r) => r.cap), ...Object.values(policy.TAB_CAPABILITY), ...CHECKED_IN_CODE])
	const dead = [...known].filter((c) => !consulted.has(c))
	check('No declared capability is unused', dead.length === 0, dead.join(', '))
}

// ── 2. Rule order ────────────────────────────────────────────────────────────
// First-match-wins, so these assertions are really "the narrow rule still sits
// above the broad one". Each pair below is a case where getting it wrong hands
// out more access than intended.
console.log('\n  First-match-wins ordering resolves to the tighter rule\n')
{
	const resolves = (method, path, cap) => check(`${method} ${path} → ${cap}`, policy.requiredCapability(method, path) === cap, `got ${policy.requiredCapability(method, path)}`)

	// Reads that must stay narrower than the catch-all route read.
	resolves('GET', '/api/route/charm-image', 'route:images')
	resolves('GET', '/api/route/floor-map', 'route:images')
	resolves('GET', '/api/route/listing-image/44', 'route:images')
	resolves('GET', '/api/route/variation-image/44', 'route:images')
	// Launching a desktop app on the server is NOT an ordinary route read.
	resolves('GET', '/api/route/open', 'route:local-open')
	// The catch-all itself.
	resolves('GET', '/api/route/dashboard', 'route:read')
	resolves('GET', '/api/route/charms', 'route:read')
	// Writes are always explicit — a write must never fall into the read rule.
	resolves('POST', '/api/route/charms', 'route:catalog')
	resolves('DELETE', '/api/route/charms', 'route:catalog')
	resolves('POST', '/api/route/charms/reorder', 'route:catalog')
	resolves('POST', '/api/route/assign', 'route:assign')
	resolves('POST', '/api/route/generate', 'route:generate')
	// `resolve` is the shop-floor half of exchanges and must not be swallowed by
	// the broader `manage` rules.
	resolves('POST', '/api/exchanges/7/done', 'exchanges:resolve')
	resolves('DELETE', '/api/exchanges/7', 'exchanges:manage')
	// Shipping scheduler telemetry and manual batch trigger remain an owner/admin
	// operation even though per-parcel refresh is delegated with shipping:4px.
	resolves('GET', '/api/4px/tracking-sync/status', 'shipping:admin')
	resolves('POST', '/api/4px/tracking-sync/run', 'shipping:admin')
	resolves('GET', '/api/4px/shipping-alerts', 'shipping:admin')
	resolves('POST', '/api/4px/shipping-alerts/review', 'shipping:admin')
	resolves('GET', '/api/4px/shipments/123/buyer-notice', 'shipping:admin')
	resolves('POST', '/api/4px/shipments/123/buyer-notice', 'shipping:admin')
	resolves('POST', '/api/4px/track/refresh/123', 'shipping:4px')
	resolves('GET', '/api/sourcing/suppliers', 'sourcing:manage')
	// A query string can never be used to dodge a rule (paths are matched bare).
	check('Rules match the path, never the query string', policy.requiredCapability('GET', '/api/route/open') === 'route:local-open')

	// Deny-by-default: an endpoint nobody delegated has no rule at all.
	const undelegated = [
		'/api/users',
		'/api/audit',
		'/api/earnings',
		'/api/listings',
		'/api/config',
		'/api/growth',
		'/api/growth/manual',
		'/api/growth/manual/listings',
		'/api/growth/manual/listings/1',
		'/api/growth/rights-review.csv',
		'/api/bulk/run',
		'/api/bulk/jobs/job-1/publish',
		'/api/sync/trigger-all',
		'/api/admin/suspension-risk',
	]
	check(
		'Undelegated endpoints have no rule (deny-by-default)',
		undelegated.every((p) => policy.requiredCapability('GET', p) === null && policy.requiredCapability('POST', p) === null),
	)
	check(
		'Growth import deletion remains owner-only',
		policy.requiredCapability('DELETE', '/api/growth/manual/1') === null &&
		policy.requiredCapability('DELETE', '/api/growth/manual/listings/1') === null,
	)
	check(
		'PATCH /api/inventory/auto-restock has no delegated rule (owner-only)',
		policy.requiredCapability('PATCH', '/api/inventory/auto-restock') === null,
	)
	check(
		'Operations checklist has no delegated rule (owner-only)',
		policy.requiredCapability('GET', '/api/operations/checklist') === null
			&& policy.requiredCapability('PUT', '/api/operations/checklist') === null,
	)
}

// ── 3. The access matrix ─────────────────────────────────────────────────────
// The headline outcome of this change: the employee runs the whole shopping
// route; the shopper is untouched; neither reaches the business itself.
console.log('\n  Access matrix\n')
{
	const MATRIX = [
		// [method, path, owner, packer, shopper]
		['GET', '/api/route/dashboard', true, true, false],
		['POST', '/api/route/assign', true, true, false],
		['POST', '/api/route/dismiss', true, true, false],
		['POST', '/api/route/charms', true, true, false],
		['PUT', '/api/route/charms', true, true, false],
		['DELETE', '/api/route/charms', true, true, false],
		['POST', '/api/route/charm-shops', true, true, false],
		['DELETE', '/api/route/suppliers', true, true, false],
		['PUT', '/api/route/product-map', true, true, false],
		['POST', '/api/route/manual-order', true, true, false],
		['POST', '/api/route/generate', true, true, false],
		['POST', '/api/route/import-status', true, true, false],
		['GET', '/api/route/charm-image', true, true, true],
		['POST', '/api/route/product-merges', true, true, true],
		['GET', '/api/route/open', true, false, false],
		['POST', '/api/route/supplier-catalog/open', true, false, false],
		['GET', '/api/orders', true, true, false],
		['POST', '/api/orders/1/ship', true, true, false],
		['POST', '/api/orders/manual', true, false, false],
		['GET', '/api/operations/checklist', true, false, false],
		['PUT', '/api/operations/checklist', true, false, false],
		['GET', '/api/4px/tracking-sync/status', true, false, false],
		['POST', '/api/4px/tracking-sync/run', true, false, false],
		['GET', '/api/sourcing/suppliers', true, true, false],
		['GET', '/api/users', true, false, false],
		['GET', '/api/audit', true, false, false],
		['GET', '/api/earnings', true, false, false],
		['POST', '/api/bulk/run', true, false, false],
		['POST', '/api/bulk/jobs/job-1/publish', true, false, false],
		['POST', '/api/sync/trigger-all', true, false, false],
		['GET', '/api/admin/suspension-risk', true, false, false],
		['PATCH', '/api/inventory/auto-restock', true, false, false],
	]

	for (const [method, p, ...expected] of MATRIX) {
		const roles = ['owner', 'packer', 'shopper']
		const actual = roles.map((r) => policy.authorizeApi(r, method, p).allowed)
		const ok = roles.every((_, i) => actual[i] === expected[i])
		const fmt = (v) => roles.map((r, i) => `${r}=${v[i] ? 'allow' : 'deny'}`).join(' ')
		check(`${method} ${p} — ${fmt(expected)}`, ok, `got ${fmt(actual)}`)
	}

	check('Owner is a superuser (allowed even with no matching rule)', policy.authorizeApi('owner', 'POST', '/api/some/brand/new/thing').allowed)
	check('An unknown role is denied everything', !policy.authorizeApi('intern', 'GET', '/api/orders').allowed)
	check('A new endpoint starts private for the employee', !policy.authorizeApi('packer', 'POST', '/api/some/brand/new/thing').allowed)
	check('A denial reports which capability was missing', policy.authorizeApi('shopper', 'GET', '/api/route/dashboard').capability === 'route:read')
}

// ── 4. The dashboard UI agrees with the policy ───────────────────────────────
console.log('\n  public/index.html tab gating matches the policy\n')
{
	const html = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8')

	// Pull `data-tab="x" data-cap="y"` off the tab buttons.
	const fromHtml = {}
	for (const m of html.matchAll(/data-tab="([^"]+)"\s+data-cap="([^"]+)"/g)) fromHtml[m[1]] = m[2]

	const expected = policy.TAB_CAPABILITY
	const tabsMatch = Object.keys(expected).length === Object.keys(fromHtml).length && Object.entries(expected).every(([tab, cap]) => fromHtml[tab] === cap)
	check('Every tab declares the capability the policy assigns it', tabsMatch, `html=${JSON.stringify(fromHtml)}`)

	// A tab can have the right button/capability yet still render a blank page if
	// showTab() forgets its panel ID. Pin the navigation registry to the same
	// policy vocabulary (the Growth regression that motivated this assertion).
	const registry = html.match(/const TAB_IDS = \[([^\]]+)\]/)
	const registeredTabs = registry ? [...registry[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : []
	const registeredSetMatches =
		registeredTabs.length === Object.keys(expected).length &&
		registeredTabs.every((tab) => Object.prototype.hasOwnProperty.call(expected, tab))
	check(
		'showTab registers every dashboard panel exactly once',
		registeredSetMatches,
		`showTab=${JSON.stringify(registeredTabs)}`,
	)

	// Any data-cap anywhere in the page must be a real capability, or the element
	// is hidden forever by a typo that nothing else would report.
	const known = new Set(Object.keys(policy.CAPABILITIES))
	const used = [...new Set([...html.matchAll(/data-cap="([^"]+)"/g)].map((m) => m[1]))]
	const bogus = used.filter((c) => !known.has(c))
	check(`All ${used.length} data-cap values in the page are declared capabilities`, bogus.length === 0, bogus.join(', '))

	// Which tabs each role actually ends up with. This is the same computation
	// ROLE.allowedTabs() performs in the browser (tab `data-cap` filtered by the
	// session's capabilities), run against the real attributes parsed out of the
	// page — so it pins the visible result, not just the underlying permissions.
	const tabsFor = (role) => Object.keys(fromHtml).filter((tab) => policy.roleCan(role, fromHtml[tab]))
	const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x))

	const ownerTabs = tabsFor('owner')
	check('Owner keeps every tab', sameSet(ownerTabs, Object.keys(policy.TAB_CAPABILITY)), ownerTabs.join(','))

	const employeeTabs = tabsFor('packer')
	check('Employee sees exactly Orders + Route', sameSet(employeeTabs, ['orders', 'route']), employeeTabs.join(','))
	check('…so the tab bar is shown (more than one tab)', employeeTabs.length > 1)

	const shopperTabs = tabsFor('shopper')
	check('Shopper sees no dashboard tabs at all', shopperTabs.length === 0, shopperTabs.join(','))

	// The page must load its permissions from the server.
	check('The page loads the session bootstrap', /<script src="\/auth-session\.js"><\/script>/.test(html))
	// The old blanket "hide the tab bar from employees" rule must stay gone, or
	// the Route tab is unreachable however the policy is written.
	check('The tab bar is no longer hidden wholesale in packing mode', !/body\.mode-packer\s+\.tabs\s*\{[^}]*display:\s*none/.test(html))
}

console.log(`\n  ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
