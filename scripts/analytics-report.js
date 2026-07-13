'use strict'

/**
 * analytics-report.js — comprehensive shop / product / order analytics.
 *
 * Produces a board-grade performance report across every Etsy shop from the
 * live dashboard database. It is intentionally read-only and side-effect free
 * apart from writing report artifacts, so it is safe to run at any time
 * (including while the sync worker and server are live, thanks to WAL).
 *
 * WHAT IT COMPUTES
 *   • Business overview .... GMV, net, AOV, refund rate, ad efficiency, 4PX,
 *                            month-over-month trend across every month on file.
 *   • Per-shop scorecard ... orders, GMV, AOV, ledger net, ads (spend, per-order,
 *                            % of gross), refunds (amount, % of gross), MoM order
 *                            growth, live listing count, orders-per-listing, and a
 *                            rule-based classification + tailored scale-up action.
 *   • Per-product .......... top sellers by units and by revenue, charm / MagSafe
 *                            attach rate, and each shop's single best seller.
 *   • Per-order ............ AOV buckets, items-per-order, discount usage,
 *                            destination-country mix, day-of-week seasonality.
 *
 * OUTPUT
 *   • output/analytics-report.json ... full machine-readable dataset
 *   • output/analytics-report.md ..... human-readable report + per-shop playbooks
 *   • console .......................... executive summary
 *
 * USAGE
 *   node scripts/analytics-report.js                 # auto: latest month vs prior
 *   node scripts/analytics-report.js --current 2026-07 --baseline 2026-06
 *   node scripts/analytics-report.js --out output/july-report
 *   node scripts/analytics-report.js --cny-hkd 1.08  # 4PX CNY→HKD rate (default 1.08)
 *
 * All money is HKD (every shop's Etsy payout currency) unless labelled CNY (4PX).
 * "Net" matches the dashboard definition: sum of all ledger categories except
 * `transfer` (payouts move the balance but are not earnings).
 */

const fs = require('fs')
const path = require('path')
const { initDb } = require('../src/db/setup')
const { loadConfig } = require('../src/config/schema')

// ─── CLI args ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
	const out = {}
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i]
		if (a.startsWith('--')) {
			const key = a.slice(2)
			const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'
			out[key] = val
		}
	}
	return out
}
const args = parseArgs(process.argv)
const CNY_HKD = Number(args['cny-hkd'] || 1.08)
const OUT_BASE = args.out || 'output/analytics-report'

// ─── thresholds for the recommendation engine ───────────────────────────────
// Tuned to this business (multi-shop kawaii/Y2K phone cases, HKD payouts).
const T = {
	refundHighPct: 7, // refund > 7% of gross ⇒ quality/fulfillment problem
	refundWatchPct: 5, // 5–7% ⇒ keep an eye on it
	adsPerOrderHigh: 25, // HKD ad cost per order above this = inefficient
	adsPctHigh: 12, // ads > 12% of gross = over-spending
	scaleMinOrders: 20, // a shop needs real volume before we call it "scale"
	deadMaxOrders: 3, // at/under this in the current window = idle/dead
	strongGrowth: 15, // MoM order growth % considered strong
	decline: -15, // MoM order growth % considered a decline
}

// ─── helpers ─────────────────────────────────────────────────────────────────
const hkd = (n) => (n == null ? '—' : Math.round(n).toLocaleString('en-US'))
const pct = (n) => (n == null ? '—' : n.toFixed(1) + '%')
const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10)
const safeDiv = (a, b) => (b ? a / b : null)

function main() {
	const cfg = loadConfig()
	const db = initDb(cfg.db_path)

	// Establish which months exist and pick current/baseline windows.
	const months = db
		.prepare(`
			SELECT strftime('%Y-%m', datetime(etsy_created_at,'unixepoch')) AS m, COUNT(*) n
			FROM receipts WHERE etsy_created_at IS NOT NULL
			GROUP BY m ORDER BY m`)
		.all()
		.filter((r) => r.m)
	const allMonths = months.map((r) => r.m)
	const current = args.current || allMonths[allMonths.length - 1]
	const baseline = args.baseline || allMonths[allMonths.length - 2] || current

	const latestOrder = db
		.prepare(`SELECT MAX(datetime(etsy_created_at,'unixepoch')) x FROM receipts`)
		.get().x
	const latestLedger = db
		.prepare(`SELECT MAX(datetime(create_date,'unixepoch')) x FROM ledger_entries`)
		.get().x

	const report = {
		generated_at: new Date().toISOString(),
		db_path: cfg.db_path,
		currency: 'HKD',
		cny_hkd_rate: CNY_HKD,
		window: { current, baseline, latest_order: latestOrder, latest_ledger: latestLedger },
		overview: buildOverview(db, allMonths),
		shops: buildShops(db, current, baseline),
		products: buildProducts(db, current, baseline),
		orders: buildOrders(db, current, baseline),
	}

	// Derive per-shop recommendations from the computed metrics.
	for (const s of report.shops.rows) s.recommendation = recommend(s)

	writeArtifacts(report)
	printSummary(report)
}

// ─── OVERVIEW: full monthly trend ────────────────────────────────────────────
function buildOverview(db, allMonths) {
	const monthly = allMonths.map((m) => {
		const o = db
			.prepare(`
				SELECT COUNT(*) orders, ROUND(SUM(grandtotal_amount),2) gmv, ROUND(AVG(grandtotal_amount),2) aov
				FROM receipts WHERE strftime('%Y-%m', datetime(etsy_created_at,'unixepoch'))=?`)
			.get(m)
		const l = db
			.prepare(`
				SELECT
					ROUND(SUM(CASE WHEN category='sales'  THEN amount_cents ELSE 0 END)/100.0,2) gross,
					ROUND(SUM(CASE WHEN category='ads'    THEN amount_cents ELSE 0 END)/100.0,2) ads,
					ROUND(SUM(CASE WHEN category='refund' THEN amount_cents ELSE 0 END)/100.0,2) refund,
					ROUND(SUM(CASE WHEN category<>'transfer' THEN amount_cents ELSE 0 END)/100.0,2) net
				FROM ledger_entries WHERE strftime('%Y-%m', datetime(create_date,'unixepoch'))=?`)
			.get(m)
		const f = db
			.prepare(`
				SELECT ROUND(SUM(COALESCE(fourpx_freight_amount,0)),2) freight_cny,
					   SUM(CASE WHEN fourpx_freight_amount IS NULL THEN 1 ELSE 0 END) missing
				FROM receipts WHERE strftime('%Y-%m', datetime(etsy_created_at,'unixepoch'))=?`)
			.get(m)
		const gross = l.gross || 0
		return {
			month: m,
			orders: o.orders,
			gmv: o.gmv,
			aov: o.aov,
			gross,
			ads: l.ads,
			refund: l.refund,
			net: l.net,
			net_after_4px: round1((l.net || 0) - (f.freight_cny || 0) * CNY_HKD),
			freight_cny: f.freight_cny,
			ads_pct_gross: round1(safeDiv(Math.abs(l.ads || 0), gross) * 100),
			refund_pct_gross: round1(safeDiv(Math.abs(l.refund || 0), gross) * 100),
		}
	})
	return { monthly }
}

// ─── SHOPS: per-shop scorecard for the current window vs baseline ────────────
function buildShops(db, current, baseline) {
	const shopRows = db.prepare(`SELECT shop_id, shop_name FROM shops`).all()
	const listingCounts = new Map(
		db
			.prepare(`SELECT shop_id, COUNT(*) n FROM listings GROUP BY shop_id`)
			.all()
			.map((r) => [r.shop_id, r.n])
	)

	// LIKE-FOR-LIKE MoM: the current month may be partial (MTD). Comparing a
	// 12-day month to a full 30-day baseline would make every shop look like it
	// is collapsing. Instead we compare the *same day-of-month window* in both
	// months (e.g. Jul 1–12 vs Jun 1–12) — the standard MTD-vs-SPLM method.
	const curMaxDay =
		db
			.prepare(`
				SELECT MAX(CAST(strftime('%d', datetime(etsy_created_at,'unixepoch')) AS INT)) d
				FROM receipts WHERE strftime('%Y-%m', datetime(etsy_created_at,'unixepoch'))=?`)
			.get(current).d || 31
	const dd = String(curMaxDay).padStart(2, '0')
	const curFrom = `${current}-01`
	const curTo = `${current}-${dd}`
	const baseFrom = `${baseline}-01`
	const baseTo = `${baseline}-${dd}`
	const partial = curMaxDay < daysInMonth(current)

	const ordersInRange = (shopId, from, to) =>
		db
			.prepare(`
				SELECT COUNT(*) orders
				FROM receipts
				WHERE shop_id=? AND strftime('%Y-%m-%d', datetime(etsy_created_at,'unixepoch')) BETWEEN ? AND ?`)
			.get(shopId, from, to).orders

	const ordersFor = (shopId, m) =>
		db
			.prepare(`
				SELECT COUNT(*) orders, ROUND(SUM(grandtotal_amount),2) gmv, ROUND(AVG(grandtotal_amount),2) aov
				FROM receipts
				WHERE shop_id=? AND strftime('%Y-%m', datetime(etsy_created_at,'unixepoch'))=?`)
			.get(shopId, m)

	const ledgerFor = (shopId, m) =>
		db
			.prepare(`
				SELECT
					ROUND(SUM(CASE WHEN category='sales'  THEN amount_cents ELSE 0 END)/100.0,2) gross,
					ROUND(SUM(CASE WHEN category='ads'    THEN amount_cents ELSE 0 END)/100.0,2) ads,
					ROUND(SUM(CASE WHEN category='refund' THEN amount_cents ELSE 0 END)/100.0,2) refund,
					ROUND(SUM(CASE WHEN category<>'transfer' THEN amount_cents ELSE 0 END)/100.0,2) net
				FROM ledger_entries
				WHERE shop_id=? AND strftime('%Y-%m', datetime(create_date,'unixepoch'))=?`)
			.get(shopId, m)

	const rows = shopRows
		.map((s) => {
			const cur = ordersFor(s.shop_id, current)
			const led = ledgerFor(s.shop_id, current)
			const gross = led.gross || 0
			const ads = Math.abs(led.ads || 0)
			const refund = Math.abs(led.refund || 0)
			const listings = listingCounts.get(s.shop_id) || 0
			// like-for-like windows
			const curWin = ordersInRange(s.shop_id, curFrom, curTo)
			const baseWin = ordersInRange(s.shop_id, baseFrom, baseTo)
			const growth = baseWin ? ((curWin - baseWin) / baseWin) * 100 : curWin ? 100 : 0
			return {
				shop_id: s.shop_id,
				shop: s.shop_name,
				orders_current: cur.orders,
				orders_current_window: curWin,
				orders_baseline_window: baseWin,
				order_growth_pct: round1(growth),
				gmv: cur.gmv,
				aov: cur.aov,
				gross,
				net: led.net,
				ads,
				ads_per_order: round1(safeDiv(ads, cur.orders)),
				ads_pct_gross: round1(safeDiv(ads, gross) * 100),
				refund,
				refund_pct_gross: round1(safeDiv(refund, gross) * 100),
				listings,
				orders_per_listing: round1(safeDiv(cur.orders, listings)),
			}
		})
		.filter((r) => r.shop !== 'Manual Orders')
		.sort((a, b) => b.orders_current - a.orders_current)

	const totalOrders = rows.reduce((a, r) => a + r.orders_current, 0)
	const top2 = rows.slice(0, 2).reduce((a, r) => a + r.orders_current, 0)
	return {
		rows,
		concentration_top2_pct: round1(safeDiv(top2, totalOrders) * 100),
		total_orders: totalOrders,
		comparison: { partial, curFrom, curTo, baseFrom, baseTo, days: curMaxDay },
	}
}

function daysInMonth(ym) {
	const [y, m] = ym.split('-').map(Number)
	return new Date(y, m, 0).getDate()
}

// ─── PRODUCTS: bestsellers + attach rates ────────────────────────────────────
function buildProducts(db, current, baseline) {
	const winStart = `${baseline}-01`
	const byUnits = db
		.prepare(`
			SELECT t.title,
				   SUM(t.quantity) units,
				   COUNT(DISTINCT t.receipt_id) orders,
				   ROUND(AVG(t.price_amount),2) avg_price,
				   ROUND(SUM(t.price_amount * t.quantity),2) revenue
			FROM transactions t JOIN receipts r ON r.receipt_id=t.receipt_id
			WHERE datetime(r.etsy_created_at,'unixepoch') >= ?
			GROUP BY t.title ORDER BY units DESC LIMIT 25`)
		.all(winStart)

	const byRevenue = db
		.prepare(`
			SELECT t.title, SUM(t.quantity) units, ROUND(SUM(t.price_amount * t.quantity),2) revenue
			FROM transactions t JOIN receipts r ON r.receipt_id=t.receipt_id
			WHERE datetime(r.etsy_created_at,'unixepoch') >= ?
			GROUP BY t.title ORDER BY revenue DESC LIMIT 15`)
		.all(winStart)

	// keyword attach rates (title-based; charms & MagSafe are the AOV levers)
	const attach = db
		.prepare(`
			SELECT
				COUNT(*) lines,
				SUM(CASE WHEN lower(t.title) LIKE '%charm%' THEN 1 ELSE 0 END) charm,
				SUM(CASE WHEN lower(t.title) LIKE '%magsafe%' THEN 1 ELSE 0 END) magsafe,
				SUM(CASE WHEN lower(t.title) LIKE '%grip%' THEN 1 ELSE 0 END) grip,
				ROUND(AVG(CASE WHEN lower(t.title) LIKE '%magsafe%' THEN t.price_amount END),2) magsafe_avg_price,
				ROUND(AVG(CASE WHEN lower(t.title) NOT LIKE '%magsafe%' THEN t.price_amount END),2) nonmagsafe_avg_price
			FROM transactions t JOIN receipts r ON r.receipt_id=t.receipt_id
			WHERE datetime(r.etsy_created_at,'unixepoch') >= ?`)
		.get(winStart)

	// per-shop bestseller
	const perShopBest = db
		.prepare(`
			SELECT shop, title, units FROM (
				SELECT s.shop_name shop, t.title, SUM(t.quantity) units,
					ROW_NUMBER() OVER (PARTITION BY s.shop_id ORDER BY SUM(t.quantity) DESC) rn
				FROM transactions t
				JOIN receipts r ON r.receipt_id=t.receipt_id
				JOIN shops s ON s.shop_id=r.shop_id
				WHERE datetime(r.etsy_created_at,'unixepoch') >= ?
				GROUP BY s.shop_id, t.title
			) WHERE rn=1 ORDER BY units DESC`)
		.all(winStart)

	return {
		window_from: winStart,
		by_units: byUnits,
		by_revenue: byRevenue,
		attach_rates: {
			lines: attach.lines,
			charm_pct: round1(safeDiv(attach.charm, attach.lines) * 100),
			magsafe_pct: round1(safeDiv(attach.magsafe, attach.lines) * 100),
			grip_pct: round1(safeDiv(attach.grip, attach.lines) * 100),
			magsafe_avg_price: attach.magsafe_avg_price,
			nonmagsafe_avg_price: attach.nonmagsafe_avg_price,
			magsafe_aov_lift_pct: round1(
				safeDiv(attach.magsafe_avg_price - attach.nonmagsafe_avg_price, attach.nonmagsafe_avg_price) * 100
			),
		},
		per_shop_bestseller: perShopBest,
	}
}

// ─── ORDERS: distributions & seasonality ─────────────────────────────────────
function buildOrders(db, current, baseline) {
	const winStart = `${baseline}-01`
	const aovBuckets = db
		.prepare(`
			SELECT CASE
				WHEN grandtotal_amount < 150 THEN '1. <150'
				WHEN grandtotal_amount < 250 THEN '2. 150–250'
				WHEN grandtotal_amount < 350 THEN '3. 250–350'
				WHEN grandtotal_amount < 500 THEN '4. 350–500'
				ELSE '5. 500+' END bucket,
				COUNT(*) orders
			FROM receipts WHERE datetime(etsy_created_at,'unixepoch') >= ?
			GROUP BY bucket ORDER BY bucket`)
		.all(winStart)

	const dow = db
		.prepare(`
			SELECT CASE strftime('%w', datetime(etsy_created_at,'unixepoch'))
				WHEN '0' THEN 'Sun' WHEN '1' THEN 'Mon' WHEN '2' THEN 'Tue'
				WHEN '3' THEN 'Wed' WHEN '4' THEN 'Thu' WHEN '5' THEN 'Fri' ELSE 'Sat' END dow,
				COUNT(*) orders
			FROM receipts WHERE datetime(etsy_created_at,'unixepoch') >= ?
			GROUP BY strftime('%w', datetime(etsy_created_at,'unixepoch'))
			ORDER BY strftime('%w', datetime(etsy_created_at,'unixepoch'))`)
		.all(winStart)

	const country = db
		.prepare(`
			SELECT shipping_country_iso country, COUNT(*) orders, ROUND(SUM(grandtotal_amount),2) gmv
			FROM receipts WHERE datetime(etsy_created_at,'unixepoch') >= ? AND shipping_country_iso IS NOT NULL
			GROUP BY shipping_country_iso ORDER BY orders DESC LIMIT 10`)
		.all(winStart)

	const buyers = db
		.prepare(`
			SELECT COUNT(DISTINCT buyer_user_id) buyers, COUNT(*) orders
			FROM receipts WHERE datetime(etsy_created_at,'unixepoch') >= ? AND buyer_user_id IS NOT NULL`)
		.get(winStart)

	const disc = db
		.prepare(`
			SELECT COUNT(*) total,
				SUM(CASE WHEN discount_amount>0 THEN 1 ELSE 0 END) discounted,
				ROUND(AVG(CASE WHEN discount_amount>0 THEN discount_amount END),2) avg_discount
			FROM receipts WHERE datetime(etsy_created_at,'unixepoch') >= ?`)
		.get(winStart)

	const multi = db
		.prepare(`
			SELECT
				AVG(items) avg_items,
				SUM(CASE WHEN items>1 THEN 1 ELSE 0 END) multi_orders,
				COUNT(*) total
			FROM (
				SELECT r.receipt_id, COALESCE(SUM(t.quantity),1) items
				FROM receipts r LEFT JOIN transactions t ON t.receipt_id=r.receipt_id
				WHERE datetime(r.etsy_created_at,'unixepoch') >= ?
				GROUP BY r.receipt_id)`)
		.get(winStart)

	return {
		window_from: winStart,
		aov_buckets: aovBuckets,
		day_of_week: dow,
		country_mix: country,
		buyers: {
			unique: buyers.buyers,
			orders: buyers.orders,
			orders_per_buyer: round1((buyers.orders / buyers.buyers) * 1000) / 1000,
		},
		discount: {
			total: disc.total,
			discounted: disc.discounted,
			discounted_pct: round1(safeDiv(disc.discounted, disc.total) * 100),
			avg_discount: disc.avg_discount,
		},
		basket: {
			avg_items: round1(multi.avg_items),
			multi_item_orders: multi.multi_orders,
			multi_item_pct: round1(safeDiv(multi.multi_orders, multi.total) * 100),
		},
	}
}

// ─── RECOMMENDATION ENGINE ───────────────────────────────────────────────────
// Rule-based classification → a concrete, numbers-backed scale-up action.
function recommend(s) {
	const tags = []
	let tier
	// A refund/ads ratio is only trustworthy above a minimum gross; on tiny
	// denominators one refund can look catastrophic, so we gate those tiers.
	const grossReliable = (s.gross || 0) >= 3000
	const g = (v) => (v >= 0 ? '+' : '') + v // signed growth
	const growthStr = `${g(s.order_growth_pct)}% MoM (like-for-like ${s.orders_current_window} vs ${s.orders_baseline_window})`

	if (s.orders_current <= T.deadMaxOrders && s.orders_baseline_window <= T.deadMaxOrders) {
		tier = 'MOTHBALL'
		tags.push(
			`Idle (${s.orders_current} orders). Cut all ad spend${s.ads > 0 ? ` (saving ~HKD ${hkd(s.ads)}/mo)` : ''}; keep organic only. Do not open a new shop while this sits dormant.`
		)
	} else if (grossReliable && (s.refund_pct_gross || 0) >= T.refundHighPct) {
		tier = 'FIX-QUALITY'
		tags.push(
			`Refunds ${pct(s.refund_pct_gross)} of gross (>${T.refundHighPct}%). Audit fulfillment (wrong model / transit) and listing accuracy before spending more. Each refund also burns ads + fees + 4PX.`
		)
	} else if (s.orders_current >= T.scaleMinOrders && s.order_growth_pct >= 0) {
		tier = 'SCALE'
		tags.push(
			`Proven engine (${s.orders_current} orders, ${growthStr}, ads ${pct(s.ads_pct_gross)} of gross). Add ad budget while ROAS holds and clone its bestsellers into weaker shops.`
		)
	} else if (s.order_growth_pct <= T.decline && s.orders_current > T.deadMaxOrders) {
		tier = 'RESCUE'
		tags.push(
			`Declining ${growthStr} on ${s.orders_current} orders. 2-week sprint: check reviews, stockouts on hero SKUs, ad-creative fatigue, and search rank. If flat after 2 weeks, cut ads to organic-only.`
		)
	} else if (grossReliable && ((s.ads_per_order || 0) > T.adsPerOrderHigh || (s.ads_pct_gross || 0) > T.adsPctHigh)) {
		tier = 'REWORK-ADS'
		tags.push(
			`Inefficient spend (HKD ${s.ads_per_order}/order, ${pct(s.ads_pct_gross)} of gross). Cap ads to top listings only; rewrite the weakest 15 titles/photos, then re-enable budget.`
		)
	} else {
		tier = 'MAINTAIN'
		tags.push(
			`Stable mid-tier (${s.orders_current} orders, ${growthStr}). Receive winner clones weekly; light ads only on listings that already convert.`
		)
	}

	// Universal levers
	if (s.orders_per_listing != null && s.orders_per_listing < 0.15 && s.listings > 60) {
		tags.push(
			`Low listing efficiency (${s.orders_per_listing} orders/listing across ${s.listings} listings) — prune dead SKUs; catalogue size is not converting.`
		)
	}
	if ((s.refund_pct_gross || 0) >= T.refundWatchPct && (s.refund_pct_gross || 0) < T.refundHighPct) {
		tags.push(`Watch refunds (${pct(s.refund_pct_gross)} of gross), trending toward the ${T.refundHighPct}% action line.`)
	}
	if (tier === 'SCALE' && (s.aov || 0) > 0) {
		tags.push(`Push AOV: add MagSafe+grip+charm variants of every plain winner (bundles sell higher).`)
	}

	return { tier, actions: tags }
}

// ─── OUTPUT ──────────────────────────────────────────────────────────────────
function writeArtifacts(report) {
	const outAbs = path.resolve(OUT_BASE)
	fs.mkdirSync(path.dirname(outAbs), { recursive: true })
	fs.writeFileSync(outAbs + '.json', JSON.stringify(report, null, 2))
	fs.writeFileSync(outAbs + '.md', renderMarkdown(report))
	console.log(`\nArtifacts written:\n  ${outAbs}.json\n  ${outAbs}.md`)
}

function renderMarkdown(r) {
	const L = []
	const w = r.window
	L.push(`# Etsy Portfolio Analytics Report`)
	L.push('')
	L.push(`_Generated ${r.generated_at} · currency HKD · 4PX rate ${r.cny_hkd_rate} CNY/HKD_`)
	L.push('')
	L.push(`**Reporting window:** current \`${w.current}\` vs baseline \`${w.baseline}\``)
	L.push(`**Data freshness:** latest order ${w.latest_order} · latest ledger ${w.latest_ledger}`)
	L.push('')

	L.push(`## 1. Business overview (monthly trend)`)
	L.push('')
	L.push(`| Month | Orders | GMV | Gross | Net | Net after 4PX | Ads % | Refund % | AOV |`)
	L.push(`|---|--:|--:|--:|--:|--:|--:|--:|--:|`)
	for (const m of r.overview.monthly) {
		L.push(
			`| ${m.month} | ${m.orders} | ${hkd(m.gmv)} | ${hkd(m.gross)} | ${hkd(m.net)} | ${hkd(m.net_after_4px)} | ${pct(m.ads_pct_gross)} | ${pct(m.refund_pct_gross)} | ${hkd(m.aov)} |`
		)
	}
	L.push('')

	L.push(`## 2. Per-shop scorecard (${w.current})`)
	L.push('')
	const cmp = r.shops.comparison
	L.push(`Portfolio concentration: top-2 shops = **${pct(r.shops.concentration_top2_pct)}** of orders.`)
	if (cmp.partial) {
		L.push('')
		L.push(
			`> **MoM is like-for-like:** \`${w.current}\` is a partial month, so growth compares \`${cmp.curFrom}…${cmp.curTo}\` against \`${cmp.baseFrom}…${cmp.baseTo}\` (first ${cmp.days} days of each). The **Orders** column shows month-to-date totals.`
		)
	}
	L.push('')
	L.push(`| Shop | Orders (MTD) | MoM (LfL) | GMV | AOV | Net | Ads/ord | Ads% | Refund% | Listings | Ord/List | Tier |`)
	L.push(`|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|:--|`)
	for (const s of r.shops.rows) {
		L.push(
			`| ${s.shop} | ${s.orders_current} | ${s.order_growth_pct >= 0 ? '+' : ''}${s.order_growth_pct}% | ${hkd(s.gmv)} | ${hkd(s.aov)} | ${hkd(s.net)} | ${s.ads_per_order ?? '—'} | ${pct(s.ads_pct_gross)} | ${pct(s.refund_pct_gross)} | ${s.listings} | ${s.orders_per_listing ?? '—'} | ${s.recommendation.tier} |`
		)
	}
	L.push('')

	L.push(`## 3. Per-shop scale-up playbooks`)
	L.push('')
	for (const s of r.shops.rows) {
		L.push(`### ${s.shop} — ${s.recommendation.tier}`)
		L.push(
			`${s.orders_current} orders (${s.order_growth_pct >= 0 ? '+' : ''}${s.order_growth_pct}% MoM) · AOV HKD ${hkd(s.aov)} · net HKD ${hkd(s.net)} · ads ${pct(s.ads_pct_gross)} of gross · refunds ${pct(s.refund_pct_gross)}`
		)
		L.push('')
		for (const a of s.recommendation.actions) L.push(`- ${a}`)
		L.push('')
	}

	L.push(`## 4. Products`)
	L.push('')
	L.push(
		`Charm attach **${pct(r.products.attach_rates.charm_pct)}** · MagSafe **${pct(r.products.attach_rates.magsafe_pct)}** · grip **${pct(r.products.attach_rates.grip_pct)}**. ` +
			`MagSafe avg price HKD ${hkd(r.products.attach_rates.magsafe_avg_price)} vs non-MagSafe HKD ${hkd(r.products.attach_rates.nonmagsafe_avg_price)} (**+${pct(r.products.attach_rates.magsafe_aov_lift_pct)} AOV lift**).`
	)
	L.push('')
	L.push(`### Top sellers by units (since ${r.products.window_from})`)
	L.push('')
	L.push(`| Product | Units | Orders | Avg price | Revenue |`)
	L.push(`|---|--:|--:|--:|--:|`)
	for (const p of r.products.by_units.slice(0, 15)) {
		L.push(`| ${clip(p.title)} | ${p.units} | ${p.orders} | ${hkd(p.avg_price)} | ${hkd(p.revenue)} |`)
	}
	L.push('')
	L.push(`### Each shop's #1 seller`)
	L.push('')
	L.push(`| Shop | Bestseller | Units |`)
	L.push(`|---|---|--:|`)
	for (const p of r.products.per_shop_bestseller) L.push(`| ${p.shop} | ${clip(p.title)} | ${p.units} |`)
	L.push('')

	L.push(`## 5. Order economics & seasonality (since ${r.orders.window_from})`)
	L.push('')
	L.push(
		`Repeat rate **${r.orders.buyers.orders_per_buyer} orders/buyer** · discount usage **${pct(r.orders.discount.discounted_pct)}** (avg HKD ${hkd(r.orders.discount.avg_discount)}) · basket **${r.orders.basket.avg_items} items** (multi-item ${pct(r.orders.basket.multi_item_pct)}).`
	)
	L.push('')
	L.push(`**AOV distribution:** ` + r.orders.aov_buckets.map((b) => `${b.bucket}=${b.orders}`).join(' · '))
	L.push('')
	L.push(`**Top destinations:** ` + r.orders.country_mix.map((c) => `${c.country} ${c.orders}`).join(' · '))
	L.push('')
	L.push(`**Day-of-week:** ` + r.orders.day_of_week.map((d) => `${d.dow} ${d.orders}`).join(' · '))
	L.push('')
	return L.join('\n')
}

const clip = (s) => (s && s.length > 52 ? s.slice(0, 52) + '…' : s || '')

function printSummary(r) {
	const cur = r.overview.monthly.find((m) => m.month === r.window.current) || {}
	console.log('\n════════ EXECUTIVE SUMMARY ════════')
	console.log(`Window: ${r.window.current} (vs ${r.window.baseline})   Data → ${r.window.latest_order}`)
	console.log(
		`Current month: ${cur.orders} orders · GMV HKD ${hkd(cur.gmv)} · net HKD ${hkd(cur.net)} · ads ${pct(cur.ads_pct_gross)} · refunds ${pct(cur.refund_pct_gross)}`
	)
	console.log(`Top-2 concentration: ${pct(r.shops.concentration_top2_pct)}`)
	console.log('\nShop tiers:')
	const byTier = {}
	for (const s of r.shops.rows) (byTier[s.recommendation.tier] ||= []).push(s.shop)
	for (const [tier, list] of Object.entries(byTier)) console.log(`  ${tier.padEnd(12)} ${list.join(', ')}`)
	console.log('═══════════════════════════════════')
}

main()
