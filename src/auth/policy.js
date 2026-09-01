/**
 * policy.js — the ONE place that answers "who is allowed to do what".
 *
 * WHY THIS EXISTS
 * ----------------------------------------------------------------------------
 * Access used to be expressed as two flat regex allowlists inside access.js
 * (PACKER_ALLOW / SHOPPER_ALLOW). That worked while an employee could only pack
 * and ship, but it had three problems that show up the moment their job grows:
 *
 *   1. A permission had no NAME. "Can Mei edit the charm library?" could only be
 *      answered by reading regexes, so nobody could review the rules.
 *   2. The browser re-derived permissions independently (`ROLE.isPacker()` plus
 *      a `.owner-only` CSS class). Two implementations of one policy drift, and
 *      when they drift the UI either hides something the user may do or offers a
 *      button that 403s.
 *   3. Adding a role or widening one meant touching both lists AND the HTML.
 *
 * The fix is the standard RBAC shape: named CAPABILITIES, a role → capability
 * map, and an ordered endpoint ACL that says which capability each API needs.
 * The server enforces from this table and SHIPS THE SAME TABLE to the browser
 * (see access.js `/auth-session.js`), so the UI hides exactly what the server
 * would refuse — one definition, two consumers.
 *
 * SECURITY MODEL (unchanged, just expressed differently)
 *   • `owner` is a superuser: it bypasses the ACL entirely (capability '*').
 *   • Every other role is DENY-BY-DEFAULT. An endpoint with no matching rule is
 *     refused, so adding a new API is safe by construction — it starts private.
 *   • Rules are FIRST-MATCH-WINS, like a firewall ACL. Order matters, and the
 *     narrow rules are deliberately placed above the broad ones (e.g. the
 *     image reads and the "open on the server's desktop" endpoints sit above the
 *     catch-all `GET /api/route/*`).
 *   • UI capability checks are a convenience, never a control. The browser is
 *     told what it may show; the server independently decides what it may do.
 */

// ── Capabilities ─────────────────────────────────────────────────────────────
// Every entry is a permission a human can reason about in a sentence. Keep the
// descriptions honest — they are what a future reader (or an auditor) will use
// to decide whether a role is over-privileged.
const CAPABILITIES = Object.freeze({
	// Session / shell
	'app:session': 'Sign in and read own identity + the shop list',
	'app:shell': 'Dashboard shell reads: order summary (revenue stripped), events, FX rates, import-tax identifiers',
	'dashboard:view': 'Open the full desktop dashboard (rather than the mobile shopping route)',
	'dashboard:remote': 'Open the full desktop dashboard from OUTSIDE the office LAN (through the tunnel)',

	// Orders / fulfilment
	'orders:read': 'Read the order list and per-order issues',
	'orders:notes': 'Read and write the private team note on an order',
	'orders:purchase': 'Flag orders as needing purchase and mark products/components bought',
	'orders:verify': 'Confirm an order’s products are physically in hand',
	'orders:pack': 'Mark orders packaged / unpackaged',
	'orders:ship': 'Ship an order and maintain its tracking number',
	'shipping:4px': 'Create, download and print 4PX labels; refresh 4PX tracking',
	'shipping:pickup': 'Book, reprint and cancel a 4PX door-to-door pickup (揽收预约) for sealed parcels',
	'exchanges:manage': 'Open and cancel wrong-model exchanges',
	'exchanges:resolve': 'Mark a wrong-model exchange done / reopen it',

	// Shopping route
	'route:images': 'View product, charm, substitution and floor-map images',
	'route:read': 'Read the Orders Sorting Dashboard, catalogs, charm library and generated files',
	'route:assign': 'Set per-line charm, supplier, purchase status, exclusions and manual lines',
	'route:catalog': 'Create/update/delete charms, charm shops, suppliers and the product catalog',
	'route:generate': 'Run the shopping-route generator and import an edited status workbook',
	'route:merges': 'Declare that two listings are the same physical product',
	'route:local-open': 'Open a generated file in a desktop app ON THE SERVER machine',
	'shop:route': 'Use the mobile shopping route (live list, status updates, costs)',

	// Back office
	'sourcing:manage': 'Maintain the sourcing library (design suppliers and their product zips)',

	// Owner-only surfaces. These have no ACL rules — `owner` bypasses the ACL —
	// but they are named here so the UI can gate tabs from the same vocabulary.
	'operations:checklist': 'View and update the shared manual daily/weekly operations checklist',
	'finance:read': 'See earnings, payouts and revenue figures',
	'listings:manage': 'Create, edit and publish Etsy listings',
	'shops:admin': 'Manage shops, OAuth tokens and sync settings',
	'shipping:admin': 'Manage shipping profiles and carrier configuration',
	'admin:users': 'Manage employee accounts and read the audit log / shift reports',
})

/** Capability granted to a superuser. Matches every check. */
const ALL = '*'

// ── Roles ────────────────────────────────────────────────────────────────────
//
// `packer` is the EMPLOYEE role. It owns fulfilment end-to-end — sourcing the
// products, running the shopping route, packing and shipping — and is trusted
// with the whole Route tab (the Orders Sorting Dashboard plus CRUD on the
// case/grip/charm data behind it). What it still cannot reach is the business
// itself: earnings, Etsy listings, shop/OAuth settings and user administration.
//
// `shopper` is the narrower in-person role: the mobile shopping route only.
const ROLE_CAPABILITIES = Object.freeze({
	owner: Object.freeze([ALL]),

	packer: Object.freeze([
		'app:session',
		'app:shell',
		'dashboard:view',
		'orders:read',
		'orders:notes',
		'orders:purchase',
		'orders:verify',
		'orders:pack',
		'orders:ship',
		'shipping:4px',
		// The person who sealed the parcels is the one who knows they are ready to
		// hand over, so booking the collection is part of the packing job — not an
		// owner errand that leaves sealed parcels sitting on the bench overnight.
		'shipping:pickup',
		'exchanges:manage',
		'exchanges:resolve',
		'route:images',
		'route:read',
		'route:assign',
		'route:catalog',
		'route:generate',
		'route:merges',
		'shop:route',
		'sourcing:manage',
	]),

	shopper: Object.freeze(['app:session', 'route:images', 'route:merges', 'exchanges:resolve', 'shop:route']),
})

// ── Endpoint ACL ─────────────────────────────────────────────────────────────
// Ordered, first-match-wins. `m` is an HTTP method or '*'. `re` is matched
// against req.path (never the query string, so a rule cannot be bypassed with
// `?`). Anything unmatched is denied for every non-owner role.
//
// Only endpoints a NON-OWNER may reach need a rule; the owner never consults
// this table. Keeping owner-only APIs out of it is deliberate — the table then
// reads as "the delegated surface", which is the thing worth reviewing.
const API_RULES = Object.freeze([
	// ── Session / shell ──────────────────────────────────────────────────────
	{ m: 'GET', re: /^\/api\/health$/, cap: 'app:session' },
	{ m: 'GET', re: /^\/api\/auth\/me$/, cap: 'app:session' },
	{ m: 'GET', re: /^\/api\/shops$/, cap: 'app:session' },
	{ m: 'GET', re: /^\/api\/shops\/listing-counts$/, cap: 'app:shell' },
	{ m: 'GET', re: /^\/api\/summary$/, cap: 'app:shell' },
	{ m: 'GET', re: /^\/api\/events$/, cap: 'app:shell' },
	{ m: 'GET', re: /^\/api\/exchange-rates$/, cap: 'app:shell' },
	// The packing bench cannot pack an international parcel without the import-tax
	// identifier and declared value for its destination, so this read is part of
	// the shell rather than a privileged lookup. It exposes published marketplace
	// registration numbers only — nothing about the shop's own finances.
	{ m: 'GET', re: /^\/api\/compliance\/destination-tax$/, cap: 'app:shell' },

	// ── Orders ───────────────────────────────────────────────────────────────
	{ m: 'GET', re: /^\/api\/orders$/, cap: 'orders:read' },
	{ m: 'GET', re: /^\/api\/orders\/[^/]+\/issues$/, cap: 'orders:read' },
	{ m: '*', re: /^\/api\/orders\/[^/]+\/note$/, cap: 'orders:notes' },

	// Purchasing (the buy queue). An employee sourcing on the floor marks
	// products and components bought; the bulk variants are the same decision
	// applied to a selection, so they carry the same capability.
	{ m: 'POST', re: /^\/api\/orders\/[^/]+\/needs-purchase$/, cap: 'orders:purchase' },
	{ m: 'POST', re: /^\/api\/orders\/[^/]+\/clear-needs-purchase$/, cap: 'orders:purchase' },
	{ m: 'POST', re: /^\/api\/orders\/bulk-needs-purchase$/, cap: 'orders:purchase' },
	{ m: 'POST', re: /^\/api\/orders\/[^/]+\/items\/component-status$/, cap: 'orders:purchase' },
	{ m: 'POST', re: /^\/api\/orders\/[^/]+\/items\/purchase-state$/, cap: 'orders:purchase' },

	// Verification (two-person integrity gate before packing).
	{ m: 'POST', re: /^\/api\/orders\/[^/]+\/items\/verify$/, cap: 'orders:verify' },
	{ m: 'POST', re: /^\/api\/orders\/[^/]+\/verify-all$/, cap: 'orders:verify' },
	{ m: 'POST', re: /^\/api\/orders\/bulk-verify$/, cap: 'orders:verify' },

	// Packing.
	{ m: 'POST', re: /^\/api\/orders\/[^/]+\/mark-packaged$/, cap: 'orders:pack' },
	{ m: 'POST', re: /^\/api\/orders\/[^/]+\/unmark-packaged$/, cap: 'orders:pack' },
	{ m: 'POST', re: /^\/api\/orders\/bulk-mark-packaged$/, cap: 'orders:pack' },

	// Shipping. Manual (off-Etsy) orders can be packed and shipped like any
	// other, but creating/editing/deleting one stays an owner catalog action and
	// therefore has no rule here.
	{ m: 'POST', re: /^\/api\/orders\/[^/]+\/ship$/, cap: 'orders:ship' },
	{ m: 'POST', re: /^\/api\/orders\/[^/]+\/update-tracking$/, cap: 'orders:ship' },
	// Ship recovery: finish an order that already has a paid 4PX label but was
	// never completed on Etsy. It ships an order, so it is the same permission —
	// and the packer who created the label is exactly who should be able to
	// finish it. `complete-pending-4px` is the same action over the backlog.
	{ m: 'POST', re: /^\/api\/orders\/complete-pending-4px$/, cap: 'orders:ship' },
	{ m: 'POST', re: /^\/api\/orders\/[^/]+\/complete-with-4px$/, cap: 'orders:ship' },
	{ m: 'POST', re: /^\/api\/orders\/manual\/[^/]+\/shipped$/, cap: 'orders:ship' },
	{ m: 'POST', re: /^\/api\/orders\/manual\/[^/]+\/tracking$/, cap: 'orders:ship' },

	// 4PX label lifecycle.
	{ m: 'GET', re: /^\/api\/4px\/config$/, cap: 'shipping:4px' },
	{ m: 'GET', re: /^\/api\/4px\/products$/, cap: 'shipping:4px' },
	{ m: 'GET', re: /^\/api\/4px\/order\/[^/]+$/, cap: 'shipping:4px' },
	{ m: 'GET', re: /^\/api\/4px\/freight\/[^/]+$/, cap: 'shipping:4px' },
	{ m: 'POST', re: /^\/api\/4px\/create-order$/, cap: 'shipping:4px' },
	{ m: 'GET', re: /^\/api\/4px\/label\/[^/]+$/, cap: 'shipping:4px' },
	{ m: 'GET', re: /^\/api\/4px\/label-download\/[^/]+$/, cap: 'shipping:4px' },
	{ m: 'GET', re: /^\/api\/4px\/label-print\/[^/]+$/, cap: 'shipping:4px' },
	{ m: 'POST', re: /^\/api\/4px\/bulk-create-order$/, cap: 'shipping:4px' },
	{ m: 'GET', re: /^\/api\/4px\/bulk-labels\.zip$/, cap: 'shipping:4px' },
	{ m: 'POST', re: /^\/api\/4px\/bulk-complete$/, cap: 'shipping:4px' },
	{ m: 'GET', re: /^\/api\/4px\/track\/[^/]+$/, cap: 'shipping:4px' },
	{ m: 'POST', re: /^\/api\/4px\/track\/refresh\/[^/]+$/, cap: 'shipping:4px' },

	// 4PX door-to-door pickup (揽收预约). Its own capability rather than a reuse
	// of `shipping:4px`: booking a collection commits a carrier visit to the
	// premises, which is a different kind of act from printing a label that was
	// already paid for, and it can be withheld from a packer without also taking
	// away their ability to ship.
	{ m: 'GET', re: /^\/api\/4px\/pickup\/options$/, cap: 'shipping:pickup' },
	{ m: 'GET', re: /^\/api\/4px\/pickup\/appointments$/, cap: 'shipping:pickup' },
	{ m: 'POST', re: /^\/api\/4px\/pickup\/appointments$/, cap: 'shipping:pickup' },
	{ m: 'POST', re: /^\/api\/4px\/pickup\/appointments\/[^/]+\/cancel$/, cap: 'shipping:pickup' },
	{ m: 'GET', re: /^\/api\/4px\/pickup\/appointments\/[^/]+\/form$/, cap: 'shipping:pickup' },
	{ m: 'POST', re: /^\/api\/4px\/pickup\/appointments\/[^/]+\/print$/, cap: 'shipping:pickup' },
	// Shipping tab list / stats / balance / claim notes (owner ops desk).
	{ m: 'GET', re: /^\/api\/4px\/shipping-stats$/, cap: 'shipping:admin' },
	{ m: 'GET', re: /^\/api\/4px\/shipping-alerts$/, cap: 'shipping:admin' },
	{ m: 'POST', re: /^\/api\/4px\/shipping-alerts\/review$/, cap: 'shipping:admin' },
	{ m: 'GET', re: /^\/api\/4px\/shipping-summary$/, cap: 'shipping:admin' },
	{ m: 'GET', re: /^\/api\/4px\/tracking-sync\/status$/, cap: 'shipping:admin' },
	{ m: 'POST', re: /^\/api\/4px\/tracking-sync\/run$/, cap: 'shipping:admin' },
	{ m: 'GET', re: /^\/api\/4px\/shipments$/, cap: 'shipping:admin' },
	{ m: 'GET', re: /^\/api\/4px\/shipments\/export\.csv$/, cap: 'shipping:admin' },
	{ m: 'PUT', re: /^\/api\/4px\/shipments\/[^/]+\/claim$/, cap: 'shipping:admin' },
	{ m: 'GET', re: /^\/api\/4px\/shipments\/[^/]+\/buyer-notice$/, cap: 'shipping:admin' },
	{ m: 'POST', re: /^\/api\/4px\/shipments\/[^/]+\/buyer-notice$/, cap: 'shipping:admin' },
	{ m: 'GET', re: /^\/api\/4px\/balance$/, cap: 'shipping:admin' },
	{ m: 'POST', re: /^\/api\/4px\/balance$/, cap: 'shipping:admin' },

	// Wrong-model exchanges. `resolve` is the shop-floor half (the shopper has
	// it too); `manage` opens and cancels them.
	{ m: 'POST', re: /^\/api\/exchanges\/[^/]+\/done$/, cap: 'exchanges:resolve' },
	{ m: 'POST', re: /^\/api\/exchanges\/[^/]+\/reopen$/, cap: 'exchanges:resolve' },
	{ m: 'POST', re: /^\/api\/orders\/[^/]+\/exchanges$/, cap: 'exchanges:manage' },
	{ m: 'DELETE', re: /^\/api\/exchanges\/[^/]+$/, cap: 'exchanges:manage' },

	// ── Mobile shopping route ────────────────────────────────────────────────
	{ m: 'GET', re: /^\/api\/shop\/route$/, cap: 'shop:route' },
	{ m: 'GET', re: /^\/api\/shop\/stream$/, cap: 'shop:route' },
	{ m: 'POST', re: /^\/api\/shop\/assign$/, cap: 'shop:route' },
	{ m: 'POST', re: /^\/api\/shop\/cost$/, cap: 'shop:route' },

	// ── Shopping route (desktop) ─────────────────────────────────────────────
	//
	// NARROW RULES FIRST — everything below the images/merges/local-open block
	// falls through to the catch-all `GET /api/route/*` read rule, so a rule that
	// must stay tighter than `route:read` has to appear above it.

	// Images: the only slice of the route a `shopper` may read.
	{ m: 'GET', re: /^\/api\/route\/floor-map$/, cap: 'route:images' },
	{ m: 'GET', re: /^\/api\/route\/listing-image\/[^/]+$/, cap: 'route:images' },
	{ m: 'GET', re: /^\/api\/route\/variation-image\/[^/]+$/, cap: 'route:images' },
	{ m: 'GET', re: /^\/api\/route\/manual-image\/[^/]+$/, cap: 'route:images' },
	{ m: 'GET', re: /^\/api\/route\/substitution-image\/[^/]+$/, cap: 'route:images' },
	{ m: 'GET', re: /^\/api\/route\/style-image\/[^/]+$/, cap: 'route:images' },
	{ m: 'GET', re: /^\/api\/route\/charm-image$/, cap: 'route:images' },

	// "These two listings are the same physical product" — the person holding the
	// product at the stall is the only reliable judge, so both floor roles get it.
	{ m: 'POST', re: /^\/api\/route\/product-merges$/, cap: 'route:merges' },
	{ m: 'DELETE', re: /^\/api\/route\/product-merges$/, cap: 'route:merges' },

	// Launching a desktop app happens on the SERVER's machine, so it only makes
	// sense for whoever is sitting at it. Remote staff download instead — the UI
	// falls back to the download link when this capability is missing.
	{ m: 'GET', re: /^\/api\/route\/open$/, cap: 'route:local-open' },
	{ m: 'POST', re: /^\/api\/route\/supplier-catalog\/open$/, cap: 'route:local-open' },

	// Generation is a long-running job that rewrites the shared workbooks, and
	// importing a status workbook rewrites purchase state in bulk. Both are
	// route work, but they are named separately so they can be withheld.
	{ m: 'POST', re: /^\/api\/route\/generate$/, cap: 'route:generate' },
	{ m: 'POST', re: /^\/api\/route\/import-status$/, cap: 'route:generate' },

	// Catalog CRUD: charms, charm shops, suppliers, product map. This is the
	// "case / grip / charm" master data behind the Orders Sorting Dashboard.
	// Only the WRITES are listed — the matching GETs fall through to `route:read`
	// below, so a read-only role stays possible without editing these rules.
	{ m: 'POST', re: /^\/api\/route\/charms$/, cap: 'route:catalog' },
	{ m: 'PUT', re: /^\/api\/route\/charms$/, cap: 'route:catalog' },
	{ m: 'DELETE', re: /^\/api\/route\/charms$/, cap: 'route:catalog' },
	{ m: 'POST', re: /^\/api\/route\/charms\/resync$/, cap: 'route:catalog' },
	{ m: 'POST', re: /^\/api\/route\/charms\/reorder$/, cap: 'route:catalog' },
	{ m: 'POST', re: /^\/api\/route\/charm-from-supplier$/, cap: 'route:catalog' },
	{ m: 'POST', re: /^\/api\/route\/charm-shops$/, cap: 'route:catalog' },
	{ m: 'PUT', re: /^\/api\/route\/charm-shops$/, cap: 'route:catalog' },
	{ m: 'DELETE', re: /^\/api\/route\/charm-shops$/, cap: 'route:catalog' },
	{ m: 'POST', re: /^\/api\/route\/suppliers$/, cap: 'route:catalog' },
	{ m: 'PUT', re: /^\/api\/route\/suppliers$/, cap: 'route:catalog' },
	{ m: 'DELETE', re: /^\/api\/route\/suppliers$/, cap: 'route:catalog' },
	{ m: 'POST', re: /^\/api\/route\/import-suppliers$/, cap: 'route:catalog' },
	{ m: 'POST', re: /^\/api\/route\/product-map$/, cap: 'route:catalog' },
	{ m: 'PUT', re: /^\/api\/route\/product-map$/, cap: 'route:catalog' },
	{ m: 'DELETE', re: /^\/api\/route\/product-map$/, cap: 'route:catalog' },
	{ m: 'POST', re: /^\/api\/route\/product-map\/reconcile$/, cap: 'route:catalog' },

	// Per-line decisions on the sorting dashboard: charm/supplier assignment,
	// component purchase status, exclusions, removals and manual lines.
	{ m: 'POST', re: /^\/api\/route\/assign$/, cap: 'route:assign' },
	{ m: 'POST', re: /^\/api\/route\/dismiss$/, cap: 'route:assign' },
	{ m: 'POST', re: /^\/api\/route\/charm-progress$/, cap: 'route:assign' },
	{ m: 'POST', re: /^\/api\/route\/manual-order$/, cap: 'route:assign' },
	{ m: 'DELETE', re: /^\/api\/route\/manual-order$/, cap: 'route:assign' },

	// Catch-all READ for the rest of the route surface (dashboard, config, job
	// status, charms-to-buy, product catalog exports, generated-file listing and
	// downloads, sync history…). Reads only — every write above is explicit.
	{ m: 'GET', re: /^\/api\/route\//, cap: 'route:read' },

	// ── Sourcing catalog ─────────────────────────────────────────────────────
	// The Sourcing page's catalog view is a PROJECTION of the route master data
	// (product_map + the supplier/charm directories), not a store of its own — so
	// it carries the same permission as reading that data on the Route tab rather
	// than the sourcing library's. Its writes are not here at all: they go to the
	// /api/route/* endpoints above, which already require `route:catalog`. Sits
	// ABOVE the sourcing catch-all, which would otherwise swallow it.
	{ m: 'GET', re: /^\/api\/sourcing\/catalog(?:\/|$)/, cap: 'route:read' },

	// ── Sourcing library ─────────────────────────────────────────────────────
	{ m: '*', re: /^\/api\/sourcing\//, cap: 'sourcing:manage' },
])

// ── Dashboard tabs ───────────────────────────────────────────────────────────
// The capability each top-level tab needs. The browser mirrors these in
// `data-cap` attributes on the tab buttons; scripts/test-access-policy.js
// asserts the two never drift apart.
const TAB_CAPABILITY = Object.freeze({
	overview: 'finance:read',
	orders: 'orders:read',
	listings: 'listings:manage',
	bulk: 'listings:manage',
	events: 'shops:admin',
	shops: 'shops:admin',
	earnings: 'finance:read',
	growth: 'finance:read',
	shipping: 'shipping:admin',
	route: 'route:read',
})

// ── Queries ──────────────────────────────────────────────────────────────────

/** @returns {readonly string[]} the capabilities held by `role` (empty if unknown). */
function capabilitiesFor(role) {
	return ROLE_CAPABILITIES[role] || []
}

/** @returns {boolean} whether `role` holds `capability` (superusers hold all). */
function roleCan(role, capability) {
	const caps = capabilitiesFor(role)
	return caps.includes(ALL) || caps.includes(capability)
}

/**
 * First-match-wins ACL lookup.
 * @returns {string|null} the capability this endpoint requires, or null when no
 *   rule covers it (which means: denied for everyone but a superuser).
 */
function requiredCapability(method, path) {
	for (const rule of API_RULES) {
		if ((rule.m === '*' || rule.m === method) && rule.re.test(path)) return rule.cap
	}
	return null
}

/**
 * Decide a single API request.
 * @returns {{ allowed: boolean, capability: string|null }} `capability` is the
 *   permission that was required — useful for a precise 403 message and for the
 *   audit log.
 */
function authorizeApi(role, method, path) {
	if (roleCan(role, ALL)) return { allowed: true, capability: ALL }
	const capability = requiredCapability(method, path)
	if (!capability) return { allowed: false, capability: null }
	return { allowed: roleCan(role, capability), capability }
}

module.exports = {
	ALL,
	CAPABILITIES,
	ROLE_CAPABILITIES,
	API_RULES,
	TAB_CAPABILITY,
	capabilitiesFor,
	roleCan,
	requiredCapability,
	authorizeApi,
}
