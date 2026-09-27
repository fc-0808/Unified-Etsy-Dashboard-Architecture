'use strict'

/**
 * Regression tests — Ready-to-pack "Not yet shipped" isolation.
 *
 * The packing queue MIXES Needs-shipping (unshipped) with Pre-transit (label
 * created early). A packer who wants to select-and-ship must isolate the
 * unshipped half without leaving the queue, and the mixed All view must list
 * those unshipped rows first. The SQL, counts, sort, API wiring and packing
 * chips all have to agree — a client-side hide would lie across pagination.
 *
 * Run: `node scripts/test-pack-ship-filter.js`  (or `npm run test:pack-ship-filter`)
 */

const os = require('os')
const path = require('path')
const fs = require('fs')
const { JSDOM } = require('jsdom')
const { initDb } = require('../src/db/setup')
const packQueue = require('../src/orders/pack-queue')

let failures = 0
function assert(cond, msg) {
	if (cond) console.log(`  ok  — ${msg}`)
	else {
		failures++
		console.error(`  FAIL — ${msg}`)
	}
}

const CONFIG = { pre_transit_days: 30 }
const NOW = Math.floor(Date.now() / 1000)
const DAY = 24 * 3600
const TX = JSON.stringify([{ title: 'Plain Sticker Pack', listing_id: 555, quantity: 1, variations: [] }])

function packIds(db, shipFilter, sortSql) {
	const sql = `SELECT r.receipt_id FROM receipts r
     WHERE ${packQueue.readyToPackShipStateSql(CONFIG, 'r')}
       AND ${packQueue.excludeOpenExchangeSql('r')}
       AND ${packQueue.excludeOpenAddressReviewSql('r')}
       AND r.packaged_at IS NULL
       AND ${packQueue.shipFilterSql(shipFilter, 'r')}
     ORDER BY ${sortSql}`
	return db.prepare(sql).all().map((x) => x.receipt_id)
}

function seed(db) {
	db.prepare('INSERT INTO groups (group_id, label) VALUES (?,?)').run('G1', 'Group 1')
	db.prepare('INSERT INTO shops (shop_id, group_id, shop_name) VALUES (?,?,?)').run('SHOP_A', 'G1', 'TestShop')

	const ins = db.prepare(`
    INSERT INTO receipts
      (receipt_id, shop_id, group_id, name, status, is_paid, is_shipped,
       tracking_code, shipment_notified_at, carrier_confirmed_at, packaged_at,
       etsy_created_at, all_transactions, source)
    VALUES
      (@receipt_id, @shop_id, @group_id, @name, @status, @is_paid, @is_shipped,
       @tracking_code, @shipment_notified_at, @carrier_confirmed_at, @packaged_at,
       @etsy_created_at, @all_transactions, @source)
  `)
	const base = {
		shop_id: 'SHOP_A',
		group_id: 'G1',
		is_paid: 1,
		is_shipped: 0,
		tracking_code: null,
		shipment_notified_at: null,
		carrier_confirmed_at: null,
		packaged_at: null,
		etsy_created_at: NOW - 3600,
		all_transactions: TX,
		source: null,
	}

	// Unshipped, older — must lead the mixed list under unshipped_first.
	ins.run({ ...base, receipt_id: 2001, name: 'UnshippedOld', status: 'Paid', etsy_created_at: NOW - 3 * DAY })
	// Unshipped, newer.
	ins.run({ ...base, receipt_id: 2002, name: 'UnshippedNew', status: 'Paid', etsy_created_at: NOW - DAY })
	// Pre-transit label created EARLIER than both unshipped rows. Must still
	// sort AFTER them under unshipped_first, and be the labeled chip.
	ins.run({
		...base,
		receipt_id: 2003,
		name: 'LabeledEarly',
		status: 'Paid',
		is_shipped: 1,
		tracking_code: '4PXTESTLAB',
		shipment_notified_at: NOW - 4 * DAY,
		carrier_confirmed_at: null,
		etsy_created_at: NOW - 5 * DAY,
	})
	// Carrier-confirmed in-transit — not in Ready-to-pack at all.
	ins.run({
		...base,
		receipt_id: 2004,
		name: 'InTransit',
		status: 'Paid',
		is_shipped: 1,
		tracking_code: '4PXTESTIT',
		shipment_notified_at: NOW - DAY,
		carrier_confirmed_at: NOW - 3600,
	})
	// Cancelled unshipped — never packable.
	ins.run({ ...base, receipt_id: 2005, name: 'Cancelled', status: 'Canceled' })
	// Already packaged unshipped — left the packing queue.
	ins.run({ ...base, receipt_id: 2006, name: 'Packaged', status: 'Paid', packaged_at: NOW - 60 })
}

const tmpPath = path.join(os.tmpdir(), `pack-ship-filter-${process.pid}-${Date.now()}.db`)
const db = initDb(tmpPath)
const ROOT = path.resolve(__dirname, '..')
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8')
const serverSrc = fs.readFileSync(path.join(ROOT, 'src/server/index.js'), 'utf8')
const moduleSrc = fs.readFileSync(path.join(ROOT, 'src/orders/pack-queue.js'), 'utf8')

console.log('Ready-to-pack ship-state sub-filter\n')

try {
	seed(db)

	assert(packQueue.normalizeShipFilter('unshipped') === 'unshipped', 'normalize accepts unshipped')
	assert(packQueue.normalizeShipFilter('labeled') === 'labeled', 'normalize accepts labeled')
	assert(packQueue.normalizeShipFilter('LABELLED') === 'all', 'British spelling does not silently match labeled')
	assert(packQueue.normalizeShipFilter('nope') === 'all', 'garbage filter becomes all — never empties the queue')
	assert(packQueue.normalizeShipFilter('') === 'all', 'blank filter becomes all')
	assert(packQueue.normalizeShipFilter(null) === 'all', 'null filter becomes all')
	assert(Array.isArray(packQueue.SHIP_FILTERS) && packQueue.SHIP_FILTERS.join(',') === 'all,unshipped,labeled', 'SHIP_FILTERS is the canonical chip set')

	assert(packQueue.shipFilterSql('all') === '1 = 1', 'all is unrestricted SQL')
	assert(packQueue.shipFilterSql('unshipped').includes('is_shipped'), 'unshipped SQL names is_shipped')
	assert(packQueue.shipFilterSql('unshipped').includes('COALESCE'), 'unshipped treats NULL as not-yet-shipped')
	assert(packQueue.shipFilterSql('labeled').includes('is_shipped = 1'), 'labeled SQL is is_shipped = 1')

	const mixed = packIds(db, 'all', 'r.receipt_id')
	assert(mixed.includes(2001) && mixed.includes(2002) && mixed.includes(2003), `mixed queue holds both unshipped and labeled (got: ${mixed.join(', ')})`)
	assert(!mixed.includes(2004), 'in-transit is out of Ready-to-pack')
	assert(!mixed.includes(2005), 'cancelled is out of Ready-to-pack')
	assert(!mixed.includes(2006), 'already-packaged is out of Ready-to-pack')

	const unshipped = packIds(db, 'unshipped', 'r.receipt_id')
	assert(unshipped.join(',') === '2001,2002', `unshipped chip is only Needs-shipping (got: ${unshipped.join(',')})`)
	assert(!unshipped.includes(2003), 'unshipped chip excludes the labelled parcel')

	const labeled = packIds(db, 'labeled', 'r.receipt_id')
	assert(labeled.join(',') === '2003', `labeled chip is only Pre-transit (got: ${labeled.join(',')})`)
	assert(!labeled.includes(2001) && !labeled.includes(2002), 'labeled chip excludes unshipped parcels')

	const extraWhere = `${packQueue.readyToPackShipStateSql(CONFIG, 'r')} AND ${packQueue.excludeOpenExchangeSql('r')} AND ${packQueue.excludeOpenAddressReviewSql('r')} AND r.packaged_at IS NULL`
	const counts = packQueue.listShipCounts(db, { extraWhere })
	assert(counts.all === 3 && counts.unshipped === 2 && counts.labeled === 1, `ship_counts splits 2 unshipped + 1 labeled of 3 (got ${counts.unshipped}+${counts.labeled} of ${counts.all})`)
	assert(counts.all === counts.unshipped + counts.labeled, 'all === unshipped + labeled on this scope')

	const labeledCounts = packQueue.listShipCounts(db, {
		extraWhere: `(${extraWhere}) AND ${packQueue.shipFilterSql('unshipped', 'r')}`,
	})
	assert(labeledCounts.unshipped === 2, 'a counts query CAN be scoped — the API must not do this for the chips')

	const sorted = packIds(db, 'all', packQueue.unshippedFirstSortSql('r'))
	assert(sorted.join(',') === '2001,2002,2003', `unshipped_first lists unshipped (oldest first) then labeled, even when the label is older (got: ${sorted.join(',')})`)
	assert(sorted[0] === 2001 && sorted[1] === 2002, 'within unshipped, oldest created-at wins')
	assert(sorted[sorted.length - 1] === 2003, 'the labelled parcel is last despite the earliest created-at')
} finally {
	try {
		db.close()
	} catch {}
	try {
		fs.unlinkSync(tmpPath)
	} catch {}
}

console.log('\nAPI + packing UI wiring\n')

assert(moduleSrc.includes('function normalizeShipFilter'), 'pack-queue owns normalizeShipFilter')
assert(moduleSrc.includes('function shipFilterSql'), 'pack-queue owns shipFilterSql')
assert(moduleSrc.includes('function listShipCounts'), 'pack-queue owns listShipCounts')
assert(moduleSrc.includes('function unshippedFirstSortSql'), 'pack-queue owns unshippedFirstSortSql')

assert(serverSrc.includes("req.query.shipped === 'ready_to_pack' && focusReceiptId == null"), 'ship_counts only run on Ready-to-pack, never on a receipt lookup')
assert(serverSrc.includes('packQueue.listShipCounts'), 'the handler reads counts from the shared helper')
assert(serverSrc.includes('packQueue.normalizeShipFilter(req.query.ship_filter)'), 'the handler canonicalises ship_filter')
assert(serverSrc.includes('packQueue.shipFilterSql(shipFilter, \'r\')') || serverSrc.includes('packQueue.shipFilterSql(shipFilter, "r")'), 'the handler applies shipFilterSql after the counts')
assert(serverSrc.includes('ship_counts: shipCounts'), 'the response exposes ship_counts')
assert(serverSrc.includes("unshipped_first: packQueue.unshippedFirstSortSql('r')"), 'sort=unshipped_first is the shared ORDER BY')
assert(serverSrc.includes('ship_filter — ready_to_pack view only'), 'the public /api/orders contract documents ship_filter')

assert(html.includes('id="packShipFilter"'), 'To pack & ship has a ship-state chip strip')
assert(html.includes('setPackShipFilter'), 'the chip strip has a setter')
assert(html.includes("params.set('ship_filter'"), 'fetchOrders sends ship_filter= for the unshipped chip')
assert(html.includes('data.ship_counts'), 'the chips are painted from ship_counts on the same response')
assert(html.includes('data-ship="unshipped"'), 'Not yet shipped is a first-class chip, not a client-side hide')
assert(html.includes('data-ship="labeled"'), 'Label created is a first-class chip')
assert(html.includes("sort: 'unshipped_first'"), 'packing-mode To pack & ship defaults to unshipped-first')
assert(html.includes('value="unshipped_first"'), 'the owner sort dropdown offers Not yet shipped first')
assert(html.includes("packShipFilter !== 'labeled'"), 'bulk Ship with 4PX hides on the labelled-only chip')
assert(html.includes('function resetPackShipFilter'), 'leaving the queue clears the chip')
assert(html.includes("resetPackShipFilter(key === 'topack' ? 'labeled' : 'all')"), 'packing-mode To pack & ship lands on Label created')
assert(html.includes("resetPackShipFilter('labeled')"), 'a packing-mode refresh sets Label created before the first orders fetch')
assert(html.includes("for (const k of ['shipped', 'shop_id', 'date_from', 'date_to', 'packaged', 'purchase', 'expedited', 'ship_filter', 'ar_filter']) params.delete(k)"), 'order-number lookup does not keep a stale ship_filter')
assert(html.includes('aria-label="Filter by shipment state"'), 'the chip strip is named for assistive tech')
assert(html.includes('Not yet shipped'), 'the unshipped chip uses operator language, not is_shipped=0')
assert(html.includes('Label created'), 'the labelled chip uses packing language, not Pre-transit jargon')
assert(html.includes("'Not yet shipped': '尚未发货'"), 'Chinese packing mode translates Not yet shipped')
assert(html.includes("'Label created': '已建单'"), 'Chinese packing mode translates Label created')
assert(
	html.includes('Opens on “Label created” so you pack parcels that already have a shipping label'),
	'the To pack & ship hint says Label created is the default view',
)
assert(
	html.includes('Use “Not yet shipped” to isolate orders that still need “Ship with 4PX”'),
	'the To pack & ship hint still tells the packer about the unshipped chip',
)
assert(!/📦/.test(html.match(/id="packShipFilter"[\s\S]{0,1200}/)?.[0] || ''), 'the ship-state chips do not lead with decorative emoji')

console.log('\nPacking Mode chip default (runtime)\n')

const chipMarkup = html.match(/<div class="np-subfilter" id="packShipFilter"[\s\S]*?<\/div>/)?.[0] || ''
assert(chipMarkup.includes('data-ship="labeled"'), 'chip markup extracted for the runtime harness')
const fnStart = html.indexOf("let packShipFilter = 'all'")
const fnEnd = html.indexOf('function setPackShipFilter', fnStart)
const fnSrc = fnStart >= 0 && fnEnd > fnStart ? html.slice(fnStart, fnEnd) : ''
assert(fnSrc.includes('function resetPackShipFilter'), 'ship-filter functions extracted from the shipped page')

const packShipDom = new JSDOM(
	`<!DOCTYPE html><html><body>
${chipMarkup}
<script>
${fnSrc}
window.__packShip = {
	get() { return packShipFilter },
	reset: resetPackShipFilter,
	apply(key) { resetPackShipFilter(key === 'topack' ? 'labeled' : 'all') },
	active() {
		const on = document.querySelector('#packShipFilter .np-sub-btn.active')
		return on ? on.dataset.ship : null
	},
}
</script>
</body></html>`,
	{ runScripts: 'dangerously' },
)
const packShip = packShipDom.window.__packShip
assert(packShip && packShip.get() === 'all', 'owner / first paint still starts on All')
assert(packShip.active() === 'all', 'All is the markup-active chip before Packing Mode init')

packShip.reset('labeled')
assert(packShip.get() === 'labeled', 'a packing-mode refresh selects Label created')
assert(packShip.active() === 'labeled', 'the Label created chip is painted active after refresh')
assert(packShipDom.window.document.querySelector('[data-ship="labeled"]').getAttribute('aria-pressed') === 'true', 'Label created is aria-pressed after refresh')

packShip.apply('needpurchase')
assert(packShip.get() === 'all', 'leaving To pack & ship clears the chip back to All')

packShip.apply('topack')
assert(packShip.get() === 'labeled', 're-entering To pack & ship lands on Label created')
assert(packShip.active() === 'labeled', 're-entering To pack & ship paints Label created active')

packShip.reset()
assert(packShip.get() === 'all', 'owner Status dropdown still resets to All when given no argument')
assert(packShip.active() === 'all', 'owner reset paints All active')

console.log(failures ? `\n${failures} failure(s)` : '\nAll pack-ship-filter checks passed.')
process.exit(failures ? 1 : 0)
