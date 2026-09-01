'use strict'

/**
 * shipping-upgrade.js — the ONE way to answer "did this buyer pay extra for
 * faster shipping?"
 *
 * WHY THIS MODULE EXISTS
 * ----------------------------------------------------------------------------
 * When a buyer upgrades to Express at checkout they pay a real, separate fee for
 * SPEED (HKD 119.99 on the order that prompted this module). Etsy shows it in
 * the seller's order manager as "Express" under "Selected by buyer", and it
 * changes what we owe that buyer: the parcel must be picked, packed and handed
 * to the carrier ahead of the standard queue, and it must travel on an express
 * lane — not the cheap postal line the dashboard defaults to.
 *
 * Before this module the dashboard could not see any of that. Every order looked
 * identical on the card, so an express order could sit behind forty standard ones
 * on the bench and then ship POSTLINK economy for a 20-day transit. The buyer
 * paid for speed and got none: a refund, a case, and a shop-quality hit. Making
 * the upgrade INVISIBLE is the bug; this module is the single place that decides
 * it, so a badge, a filter, a sort and the 4PX lane picker can never disagree.
 *
 * WHERE THE SIGNAL COMES FROM (Etsy Open API v3)
 * ----------------------------------------------------------------------------
 * `ShopReceiptTransaction.shipping_upgrade` — "The name of the shipping upgrade
 * selected for this listing. Default value is null." It is the authoritative,
 * documented field, and it is PER TRANSACTION because Etsy attaches shipping
 * upgrades to a listing's shipping profile, not to the receipt. A two-line order
 * can therefore have one upgraded line and one standard line.
 *
 * `ShopReceiptTransaction.shipping_method` is its companion ("Name of the
 * selected shipping method") and is populated on the same occasions. Both are
 * null for ordinary shipping — verified against Etsy's own issue tracker
 * (etsy/open-api#271: "shipping_method is always null unless someone chose to
 * Upgrade their Shipping"). That is exactly the property we want: a NON-NULL
 * value means money changed hands for a shipping upgrade. Nothing has to be
 * inferred from prices, and no extra API call or OAuth scope is needed — the
 * fields already arrive inside the receipts the sync worker fetches.
 *
 * WHY WE CLASSIFY THE NAME AT ALL
 * ----------------------------------------------------------------------------
 * Etsy stores the SELLER'S OWN label for the upgrade, not an enum: a shop names
 * its upgrades in Shop Manager, so the same idea reaches us as "Express",
 * "Expedited Shipping", "USPS Priority Mail", "DHL Express", "加急快递"… We keep
 * two separate facts so neither has to be guessed:
 *
 *   1. `expedited` — a BOOLEAN we act on (badge, filter, sort, lane choice).
 *   2. `tier` + `label` — how to DESCRIBE it, from a curated keyword table.
 *
 * The raw name is always carried through and displayed verbatim, so an upgrade
 * whose wording we have never seen still shows the buyer's actual choice.
 *
 * FAIL-SAFE DIRECTION
 * ----------------------------------------------------------------------------
 * An upgrade whose name matches nothing is treated as EXPEDITED. Etsy's own
 * description of the feature is "establish a price for a shipping option, such
 * as an alternate carrier or faster delivery", so a paid upgrade is a speed
 * upgrade unless it is recognisably something else (insurance, signature, gift
 * wrap — the NON_SPEED table below). Over-prioritising one parcel costs a few
 * minutes of picking order; under-prioritising it costs the sale. We choose the
 * recoverable error deliberately, and the raw name on the card lets a human
 * correct the impression instantly.
 *
 * Everything here is a pure function of Etsy data, so it is exhaustively unit
 * tested without a database or a network (scripts/test-express-orders.js).
 */

// ── Tier vocabulary ───────────────────────────────────────────────────────────
// Ranked weakest → strongest. The rank is what lets an order with two upgraded
// lines report ONE headline tier: the fastest promise made to the buyer is the
// promise the whole parcel has to keep, because the lines ship together.
const TIER_RANK = Object.freeze({
	service: 1, // paid upgrade, but not a speed upgrade (insurance, signature…)
	expedited: 2, // faster than standard, unspecified how much
	priority: 3, // a named priority/first-class service
	express: 4, // express / overnight / next-day
})

/** Short operator-facing label per tier. Kept ASCII — the UI forbids emoji. */
const TIER_LABELS = Object.freeze({
	service: 'Shipping upgrade',
	expedited: 'Expedited',
	priority: 'Priority',
	express: 'Express',
})

// ── Name classification tables ────────────────────────────────────────────────
// Evaluated in order; the FIRST table that matches wins. Speed tables come
// first so a compound name like "Insured Express" is read as Express rather than
// as insurance. Patterns are deliberately narrow: they must not fire on an
// ordinary shipping-profile name, only on an upgrade the buyer actively bought.
//
// Both Latin and Simplified-Chinese wordings are covered because this dashboard
// runs bilingual shops (see the I18N layer in public/index.html) and a seller may
// have named the upgrade in either language.
const TIER_PATTERNS = Object.freeze([
	{
		tier: 'express',
		// "Express", "Overnight", "Next day", "1-2 day", plus the integrator
		// courier brands that only exist as express products.
		re: /\bexpress\b|\bovernight\b|\bnext[\s-]?(business[\s-]?)?day\b|\b1[\s-]?2[\s-]?day\b|\bdhl\b|\bfedex\b|\bups\b|\bems\b|特快|快递|加急|快线|次日/i,
	},
	{
		tier: 'priority',
		// USPS/Royal Mail style named services that are a genuine step up.
		re: /\bpriorit\w*|\bfirst[\s-]?class\b|\b1st[\s-]?class\b|\btracked\s*24\b|优先/i,
	},
	{
		tier: 'expedited',
		// "Expedited", "Faster shipping", "Rush", "Quick dispatch".
		// Deliberately NOT matching the bare word "upgrade": it appears in every
		// kind of upgrade name and carries no speed information, so matching it
		// would swallow "Packaging upgrade" before the non-speed table below can
		// see it. An unrecognised name already lands on this tier anyway.
		re: /\bexpedit\w*|\bfast(er|est)?\b|\brush\b|\bquick\w*\b|\bspeed\w*\b|加快|加速/i,
	},
])

// Paid upgrades that buy something OTHER than speed. Checked only after every
// speed table has missed, so these never mask a real express upgrade.
const NON_SPEED_RE =
	/\binsur\w*|\bsignature\b|\bsigned[\s-]?for\b|\bgift[\s-]?wrap\w*|\bpackag\w*|\bprotect\w*|保险|签收|礼品/i

/** Badge/label budget. Long enough for "Expedited Shipping (2-4 business days)". */
const MAX_UPGRADE_NAME_LEN = 80

/**
 * Is this a value Etsy would consider "an upgrade was selected"?
 *
 * Etsy sends `null` for standard shipping, but a handful of shops have been seen
 * to carry an empty or whitespace-only string, which means the same thing.
 *
 * @param {unknown} value  A raw `shipping_upgrade` / `shipping_method` value.
 * @returns {boolean}
 */
function hasUpgrade(value) {
	return typeof value === 'string' && value.trim().length > 0
}

/**
 * Trim an Etsy-supplied upgrade name to something safe to store and display.
 *
 * Etsy HTML-encodes seller-entered text in places, and an over-long name would
 * blow out a badge, so this collapses whitespace and caps the length. The value
 * is never used as an identifier — only shown to an operator — so a cap is safe.
 *
 * @param {unknown} value
 * @returns {string}  '' when there is no upgrade.
 */
function normalizeUpgradeName(value) {
	if (!hasUpgrade(value)) return ''
	return value.trim().replace(/\s+/g, ' ').slice(0, MAX_UPGRADE_NAME_LEN)
}

/**
 * @typedef {object} UpgradeClassification
 * @property {'express'|'priority'|'expedited'|'service'|null} tier
 *           null when there is no upgrade at all.
 * @property {string}  label      Short operator label ('Express', 'Priority', …).
 * @property {string}  name       The upgrade name exactly as Etsy reported it.
 * @property {boolean} expedited  True when this upgrade bought SPEED.
 */

/**
 * Classify one Etsy `shipping_upgrade` name.
 *
 * @param {unknown} rawName  `transactions[].shipping_upgrade` from Etsy.
 * @returns {UpgradeClassification}
 */
function classifyUpgrade(rawName) {
	const name = normalizeUpgradeName(rawName)
	if (!name) return { tier: null, label: '', name: '', expedited: false }

	for (const { tier, re } of TIER_PATTERNS) {
		if (re.test(name)) return { tier, label: TIER_LABELS[tier], name, expedited: true }
	}
	if (NON_SPEED_RE.test(name)) {
		return { tier: 'service', label: TIER_LABELS.service, name, expedited: false }
	}
	// Unrecognised wording. See "FAIL-SAFE DIRECTION" in the module header: a
	// paid upgrade we cannot name is still treated as a speed upgrade, and the
	// raw name travels with it so a human sees exactly what the buyer picked.
	return { tier: 'expedited', label: TIER_LABELS.expedited, name, expedited: true }
}

/**
 * @typedef {object} ReceiptShippingUpgrade
 * @property {string}      name      Headline upgrade name (distinct names joined
 *                                   with ' · ' when a multi-line order carries
 *                                   more than one). '' when there is none.
 * @property {string}      method    Etsy's `shipping_method` for the same lines.
 * @property {string|null} tier      Strongest tier across the order's lines.
 * @property {string}      label     Operator label for that tier.
 * @property {boolean}     expedited True when ANY line bought speed.
 * @property {number}      lines     Total transaction count on the receipt.
 * @property {number}      upgradedLines  How many of them carry an upgrade.
 */

/**
 * Roll every transaction on a receipt up into the ONE shipping-upgrade fact the
 * order is worked from.
 *
 * The rollup is deliberately "any line wins, strongest tier wins": the lines of
 * an Etsy receipt go into one parcel, so a single express line makes the whole
 * parcel express. Reporting the strongest tier is what stops a two-line order
 * from being prioritised as merely "Expedited" when the buyer actually paid for
 * Express on one of the lines.
 *
 * @param {{transactions?: Array<object>}} receipt  A raw Etsy ShopReceipt.
 * @returns {ReceiptShippingUpgrade}
 */
function deriveFromReceipt(receipt) {
	const txs = Array.isArray(receipt?.transactions) ? receipt.transactions : []
	const empty = { name: '', method: '', tier: null, label: '', expedited: false, lines: txs.length, upgradedLines: 0 }
	if (!txs.length) return empty

	const names = []
	const methods = []
	let best = null
	let expedited = false
	let upgradedLines = 0

	for (const tx of txs) {
		const cls = classifyUpgrade(tx?.shipping_upgrade)
		if (!cls.tier) continue
		upgradedLines++
		if (cls.expedited) expedited = true
		if (!names.includes(cls.name)) names.push(cls.name)
		if (!best || TIER_RANK[cls.tier] > TIER_RANK[best]) best = cls.tier
		const method = normalizeUpgradeName(tx?.shipping_method)
		if (method && !methods.includes(method)) methods.push(method)
	}

	if (!best) return empty
	return {
		name: names.join(' · '),
		method: methods.join(' · '),
		tier: best,
		label: TIER_LABELS[best],
		expedited,
		lines: txs.length,
		upgradedLines,
	}
}

/**
 * Shape the persisted receipt columns into the object the API returns and the
 * page renders. Reading the STORED tier (rather than re-classifying the name)
 * keeps a rendered badge identical to the value the filter and the sort used,
 * even if the keyword tables are later refined.
 *
 * @param {object} row  A `receipts` row projected with {@link selectSql}.
 * @param {Array<object>} [transactions]  Parsed `all_transactions`, when the
 *        caller already has it, so the card can say "1 of 2 lines".
 * @returns {(ReceiptShippingUpgrade & {expedited: boolean})|null}
 *          null for every ordinary order — the overwhelming majority — so a
 *          consumer can branch on presence alone.
 */
function shapeForApi(row, transactions = null) {
	const name = normalizeUpgradeName(row?.shipping_upgrade_name)
	if (!name) return null

	const storedTier = typeof row?.shipping_upgrade_tier === 'string' ? row.shipping_upgrade_tier : ''
	const tier = Object.prototype.hasOwnProperty.call(TIER_RANK, storedTier) ? storedTier : classifyUpgrade(name).tier
	const txs = Array.isArray(transactions) ? transactions : []
	return {
		name,
		method: normalizeUpgradeName(row?.shipping_upgrade_method),
		tier,
		label: TIER_LABELS[tier] || TIER_LABELS.expedited,
		// The stored flag is authoritative: it is the column the SQL filter and
		// the sort read, so the badge must agree with it rather than re-deriving.
		expedited: row?.is_expedited === 1 || row?.is_expedited === true,
		lines: txs.length,
		upgradedLines: txs.filter((t) => hasUpgrade(t?.shipping_upgrade)).length,
	}
}

/**
 * The SELECT projection {@link shapeForApi} consumes.
 *
 * It is owned here, next to the reader, because the column names cannot be used
 * verbatim in the orders payload: `shipping_upgrade` would collide with the
 * shaped object of the same name, and `shipping_method` reads like one of the
 * receipt's `shipping_*` ADDRESS fields. Keeping the projection and the reader in
 * one module means an alias can never be renamed on one side only — the same
 * reason `actionableOrderSql` and the pack-queue predicates live beside their
 * consumers.
 *
 * @param {string} [alias='r']  Table alias for `receipts` in the caller's query.
 * @returns {string}  Comma-terminated column list, safe to inline in a SELECT.
 */
function selectSql(alias = 'r') {
	const a = /^[A-Za-z_][A-Za-z0-9_]*$/.test(alias) ? alias : 'r'
	return `${a}.shipping_upgrade AS shipping_upgrade_name,
      ${a}.shipping_method  AS shipping_upgrade_method,
      ${a}.shipping_upgrade_tier,
      ${a}.is_expedited`
}

/** Field names {@link selectSql} adds that must not reach the API payload raw. */
const API_INTERNAL_FIELDS = Object.freeze(['shipping_upgrade_name', 'shipping_upgrade_method', 'shipping_upgrade_tier'])

module.exports = {
	TIER_RANK,
	TIER_LABELS,
	MAX_UPGRADE_NAME_LEN,
	API_INTERNAL_FIELDS,
	hasUpgrade,
	normalizeUpgradeName,
	classifyUpgrade,
	deriveFromReceipt,
	shapeForApi,
	selectSql,
}
