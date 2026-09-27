'use strict'

/**
 * Supplies tab UI contract: packing-inventory workspace, not a six-tab maze.
 *
 * Static source checks plus a jsdom mount so the shipped controller actually
 * paints Inventory / Activity, thumbnail URLs, restock + CRUD, and the
 * low-stock banner.
 *
 * Run: node scripts/test-supplies-ui.js
 */

const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { JSDOM, VirtualConsole } = require('jsdom')

const JS = fs.readFileSync(path.resolve(__dirname, '../public/supplies.js'), 'utf8')
const CSS = fs.readFileSync(path.resolve(__dirname, '../public/supplies.css'), 'utf8')
const HTML = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8')
const createSupplies = require('../public/supplies')

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const RESET = '\x1b[0m'
let passed = 0
let failed = 0

function test(name, fn) {
	try {
		fn()
		passed++
		console.log(`  ${GREEN}ok${RESET}  — ${name}`)
	} catch (err) {
		failed++
		console.error(`  ${RED}FAIL${RESET} — ${name}`)
		console.error(`         ${err.message}`)
	}
}

async function testAsync(name, fn) {
	try {
		await fn()
		passed++
		console.log(`  ${GREEN}ok${RESET}  — ${name}`)
	} catch (err) {
		failed++
		console.error(`  ${RED}FAIL${RESET} — ${name}`)
		console.error(`         ${err.message}`)
	}
}

function run() {
	console.log('Supplies UI contract\n')

	test('dashboard still hosts the supplies root and assets', () => {
		assert.match(HTML, /id="tab-supplies"/)
		assert.match(HTML, /id="suppliesRoot"/)
		assert.match(HTML, /href="\/supplies\.css"/)
		assert.match(HTML, /src="\/supplies\.js"/)
		assert.match(HTML, /id="ordersSuppliesBuy"/)
		assert.doesNotMatch(HTML, /id="overviewSuppliesBuy"/)
		assert.match(JS, /paintOrdersBuy/)
	})

	test('the six confusing subtabs are gone', () => {
		assert.doesNotMatch(JS, /data-sup-tab="count"/)
		assert.doesNotMatch(JS, /data-sup-tab="stock"/)
		assert.doesNotMatch(JS, /data-sup-tab="receive"/)
		assert.doesNotMatch(JS, /data-sup-tab="alerts"/)
		assert.doesNotMatch(JS, /data-sup-tab="history"/)
		assert.doesNotMatch(JS, /data-sup-tab="catalog"/)
		assert.equal([...JS.matchAll(/data-sup-view="/g)].length, 2)
		assert.match(JS, /data-sup-view="inventory"/)
		assert.match(JS, /data-sup-view="log"/)
		assert.match(JS, /t\('Inventory'\)/)
		assert.match(JS, /t\('Activity'\)/)
	})

	test('copy describes packing materials, not a generic catalog', () => {
		assert.match(JS, /Packing supplies/)
		assert.match(JS, /Boxes, stickers, mailers/)
		assert.match(JS, /Tap Need to buy when something is running low/)
		assert.match(JS, /Need to buy/)
		assert.match(JS, /Mark purchased/)
		assert.match(JS, /Start daily count/)
		assert.match(JS, /Add supply/)
		assert.doesNotMatch(JS, /id="supLowChip"/)
		assert.doesNotMatch(JS, /id="supLiveLow"/)
	})

	test('restock snapshots unit cost and phones open shop apps in-tab', () => {
		assert.match(JS, /\/api\/supplies\/spend/)
		assert.match(JS, /id="supSpendPanel"/)
		assert.match(JS, /id="supRestockCost"/)
		assert.match(JS, /function prefersShopAppHandoff/)
		assert.match(JS, /sup-buy-overlay/)
		assert.match(JS, /unit_cost/)
		assert.doesNotMatch(JS, /↗/)
		assert.match(CSS, /\.sup-buy-overlay/)
		assert.match(CSS, /min-height:\s*48px/)
		assert.match(CSS, /min-height:\s*52px/)
	})

	test('Simplified Chinese dictionary covers supplies chrome and details', () => {
		const i18n = loadDashboardI18n()
		const mustTranslate = [
			'Packing supplies',
			'Packing operations',
			'Boxes, stickers, mailers and the other materials we buy to ship orders. Tap Need to buy when something is running low.',
			'Add supply',
			'Add photo',
			'Drop a photo here or browse',
			'No packing supplies yet.',
			'Start daily count',
			'Inventory',
			'Activity',
			'Needs restock',
			'To buy',
			'Need to buy',
			'Cancel buy',
			'Mark purchased',
			'Marked purchased',
			'Not needed',
			'Employees marked these while packing. Tap Mark purchased after you order them. Restock when they arrive.',
			'Nothing is out of stock until someone taps Need to buy.',
			'Show retired',
			'Search name, supplier…',
			'Bags',
			'Boxes',
			'Mailers',
			'Bubble Wrap',
			'Tape',
			'Stickers',
			'Hello Kitty',
			'Kuromi',
			'Cinnamoroll',
			'My Melody',
			'Miffy',
			'Mametchi',
			'Other stickers',
			'Series',
			'All characters',
			'Cards & Inserts',
			'Seals',
			'Misc',
			'All',
			'Restock',
			'Show these',
			'Daily count in progress',
			'Shelf check',
			'Review & submit',
			'Daily counts',
			'Submitted shelf counts and how they moved on-hand stock.',
			'Stock movements',
			'Restocks, counts and other quantity changes.',
			'How many are on the shelf?',
			'Save count',
			"Submit today's count?",
			'Confirm submit',
			'Quantity received',
			'Add to stock',
			'Unit price paid',
			'This restock: —',
			'Leave blank to reuse last paid price.',
			'Last paid unit price. Restock uses this if you leave the price blank.',
			'Taobao / 1688 / Amazon link. On a phone this opens the shop app.',
			'Open purchase link',
			'Buy now',
			'Purchase cost',
			'What you paid when boxes arrived.',
			'Last month',
			'Custom range',
			'Show spend',
			'No restock cost in this period.',
			'Pick a start and end date',
			'End date must be on or after the start date',
			'Paid',
			'Edit supply',
			'New packing supply',
			'Reorder when at or below',
			'Suggested buy qty',
			'Unit cost',
			'Supplier name',
			'Supplier link',
			'Active (uncheck to retire outdated stock)',
			'Retire',
			'Remove',
			'Restore',
			'Delete permanently',
			'Save supply',
			'No photo',
			'No packing supplies match these filters.',
			'No daily counts yet.',
			'No stock movements yet.',
			'No variances — shelf already matches the system.',
			'Buy replacements, then tap Restock when the shipment arrives so on-hand stays accurate.',
			'Cancel this shelf check? Anything already checked will be discarded.',
			'Retire this supply? It stays in history but leaves the daily count.',
			'Delete this supply permanently? This cannot be undone.',
			'Supply restored',
			'Supply deleted',
			'each',
			'roll',
			'sheet',
			'pack',
			'box',
			'receive',
			'count_adjust',
			'Chinese name',
			'English name',
			'Decrease',
			'Increase',
			'1 item',
			'Click to rename',
			'More actions',
			'Name saved',
			'Name is too long',
			'Replace photo',
			'Photo updated',
			'Photo must be a JPEG, PNG or WebP',
			'Pink Mailer Box (Small)',
			'Purple Bowknot Clear Bag',
			'Blue Security Seals',
			'Miffy Clear Gift Bag',
			'Looks right',
			'None on shelf',
			'The rest look right',
			'To check',
			'1 to check',
			'Look at the photo. Looks right = fine. Need to buy = we should purchase.',
			'Looks right = fine. Need to buy = we should purchase. Type a number only when the pile is off.',
			'They look right until something is out. Tap Need to buy to remind us.',
			'They look right until something is out. Tap Need to buy to remind us. Type a number only when the pile is off.',
			'Review the shelf, then tap Review & submit.',
			'Unchecked supplies keep their current on-hand quantity.',
			'No variances yet — unchecked supplies will keep current on-hand.',
			'Count, restock and edit packing-supplies inventory',
		]
		for (const s of mustTranslate) {
			const zh = i18n.t(s)
			assert.notEqual(zh, s, `missing Chinese for ${JSON.stringify(s)}`)
			assert.match(zh, /[\u4e00-\u9fff]/, `Chinese missing in ${JSON.stringify(s)} → ${JSON.stringify(zh)}`)
		}
		assert.equal(i18n.t('Packing supplies'), '包材')
		assert.equal(i18n.t('Inventory'), '库存')
		assert.equal(i18n.t('Activity'), '操作记录')
		assert.equal(i18n.t('Restock'), '补货')
		assert.equal(i18n.t('32 packing supplies need restock'), '32 项包材需要补货')
		assert.equal(i18n.t('0 each on hand · buy 200 each'), '库存 0 个 · 建议采购 200 个')
		assert.equal(i18n.t('4 roll on hand · reorder at 2 roll · suggested buy 6 roll'), '库存 4 卷 · 补货点 2 卷 · 建议采购 6 卷')
		assert.equal(i18n.t('Boxes · system has 4 each'), 'Boxes · 系统库存 4 个')
		assert.equal(i18n.t('Counted 12 each'), '已盘 12 个')
		assert.equal(i18n.t('0/32 counted · 32 remaining'), '已盘 0/32 · 剩余 32')
		assert.equal(i18n.t('0/32 checked · 32 left'), '已核 0/32 · 未核 32')
		assert.equal(i18n.t('Looks right'), '没错')
		assert.equal(i18n.t('Shelf check'), '货架核对')
		assert.equal(i18n.t('3/31 checked · 28 left · 1 to buy'), '已核 3/31 · 未核 28 · 要买 1')
		assert.equal(i18n.t('6/6 checked'), '已核 6/6')
		assert.equal(i18n.t('Review the shelf, then tap Review & submit.'), '核对一遍货架，然后点「核对并提交」。')
		assert.equal(i18n.t('2/31 checked · 29 left · 1 off · 2 to buy'), '已核 2/31 · 未核 29 · 1 项数量不对 · 要买 2')
		assert.equal(i18n.t('1 to buy'), '要买 1')
		assert.equal(i18n.t('Need to buy'), '要买')
		assert.equal(i18n.t('They look right until something is out. Tap Need to buy to remind us.'), '默认都没错。发现缺货再点「要买」提醒采购。')
		assert.equal(i18n.t('Mark purchased'), '标记已买')
		assert.equal(i18n.t('Not needed'), '不用买')
		assert.equal(i18n.t('Flagged by mei'), 'mei 标记要买')
		assert.equal(i18n.t('To buy'), '待采购')
		assert.equal(i18n.t('2 packing supplies to buy'), '2 项包材要采购')
		assert.equal(i18n.t('2 short'), '少了 2')
		assert.equal(
			i18n.t('Mark 30 unchecked supplies as looking right? You will not need to tap each one.'),
			'将 30 项未核包材记为没错？不必逐项点选。',
		)
		assert.equal(i18n.t('Pink Mailer Box (Small)'), '粉色纸箱（小）')
		assert.equal(i18n.t('Purple Bowknot Clear Bag'), '紫色蝴蝶结透明袋')
		assert.equal(i18n.t('Blue Security Seals'), '蓝色防拆封条')
		assert.equal(i18n.t('Miffy Clear Gift Bag'), '米菲透明袋')
		assert.equal(i18n.t('Click to rename'), '点击即可改名称')
		assert.equal(i18n.t('More actions'), '更多操作')
		assert.equal(i18n.t('1 item'), '1 项')
		assert.equal(i18n.t('5 items'), '5 项')
		assert.equal(i18n.t('Replace photo'), '更换照片')
		assert.equal(i18n.t('Add photo'), '添加照片')
		assert.equal(i18n.t('Add supply'), '添加包材')
		assert.equal(i18n.t('Photo updated'), '照片已更新')
		assert.equal(i18n.t('Purchase cost'), '采购成本')
		assert.equal(i18n.t('Buy now'), '去购买')
		assert.equal(i18n.t('This restock: —'), '本次补货：—')
		assert.equal(i18n.t('This restock: US$80.00'), '本次补货：US$80.00')
		assert.equal(i18n.t('2 restocks'), '2 次补货')
		assert.equal(i18n.t('Hello Kitty'), '凯蒂猫')
		assert.equal(i18n.t('Other stickers'), '其他贴纸')
		assert.equal(i18n.t('All characters'), '全部角色')
	})

	test('every static t() phrase in supplies.js localises', () => {
		const i18n = loadDashboardI18n()
		const phrases = [
			...JS.matchAll(/\bt\(\s*'((?:\\'|[^'])*)'\s*\)/g),
			...JS.matchAll(/\bt\(\s*"((?:\\"|[^"])*)"\s*\)/g),
		].map((m) => m[1].replace(/\\'/g, "'").replace(/\\"/g, '"'))
		assert.ok(phrases.length > 40, `expected many t() phrases, got ${phrases.length}`)
		for (const s of phrases) {
			const zh = i18n.t(s)
			assert.notEqual(zh, s, `untranslated supplies phrase: ${JSON.stringify(s)}`)
		}
	})

	test('count bar uses the designed chrome class', () => {
		assert.match(JS, /id="supCountBar" class="sup-count-bar"/)
		assert.match(CSS, /\.sup-count-bar/)
		assert.match(JS, /data-count-match/)
		assert.match(JS, /require_complete: remaining === 0/)
		assert.doesNotMatch(JS, /item\(s\) still need a count/)
	})

	test('shelf check is a dedicated walk, not a catalog with a progress bar', () => {
		assert.match(JS, /t\('Shelf check'\)/)
		assert.match(JS, /is-choice-pair is-empty-expected/)
		assert.match(JS, /They look right until something is out/)
		assert.match(JS, /sup-btn-remind/)
		assert.match(JS, /function countWalkHidesCounted/)
		assert.match(JS, /Review the shelf, then tap Review & submit/)
		assert.doesNotMatch(JS, /Every supply in this view is checked/)
		assert.match(CSS, /#tab-supplies \.sup-shell\.is-counting #supBuyChip/)
		assert.match(CSS, /#tab-supplies \.sup-shell\.is-counting \.sup-tabs/)
		assert.match(CSS, /#tab-supplies \.sup-shell\.is-counting \.sup-hero/)
		assert.match(CSS, /#tab-supplies \.sup-shell\.is-counting #supAlertBanner/)
		assert.match(CSS, /\.sup-btn-remind/)
		assert.doesNotMatch(CSS, /\.sup-count-check\.is-empty-expected \.sup-btn-buy/)
		assert.match(CSS, /\.sup-count-modal-shortcuts\.is-empty-expected/)
		assert.doesNotMatch(JS, /System \$\{fmtQty/)
	})

	test('owner confirms purchases in a queue, not by automatic low stock', () => {
		assert.match(JS, /id="supBuyQueue"/)
		assert.match(JS, /data-mark-purchased/)
		assert.match(JS, /\/api\/supplies\/items\/\$\{itemId\}\/purchased/)
		assert.match(JS, /function showToBuy/)
		assert.match(CSS, /\.sup-buy-queue/)
		assert.match(CSS, /\.sup-btn-purchased/)
		assert.doesNotMatch(JS, /id="supLowChip"/)
	})

	test('page chrome matches shipping, orders and route', () => {
		assert.match(JS, /class="sup-hero"/)
		assert.match(JS, /class="sup-toolbar"/)
		assert.match(JS, /class="sup-live-panel"/)
		assert.match(JS, /Packing operations/)
		assert.match(CSS, /\.sup-hero/)
		assert.match(CSS, /\.sup-toolbar/)
		assert.match(CSS, /\.sup-eyebrow/)
		assert.match(CSS, /\.sup-live-panel/)
		assert.match(CSS, /var\(--accent\)/)
	})

	test('catalog notes are free text, not dictionary keys', () => {
		assert.doesNotMatch(JS, /t\(item\.notes\)/)
		assert.match(JS, /item\?\.notes \|\| ''/)
	})

	test('mutating actions ignore a second click while in flight', () => {
		assert.match(JS, /async function withBusy/)
		assert.match(JS, /dataset\.busy/)
	})

	test('activity timestamps are formatted from SQLite UTC', () => {
		assert.match(JS, /function formatTimestamp/)
		assert.match(JS, /replace\(' ', 'T'\) \+ 'Z'/)
		assert.doesNotMatch(JS, /escapeHtml\(m\.created_at\)/)
		assert.doesNotMatch(JS, /escapeHtml\(s\.submitted_at \|\| s\.started_at\)/)
	})

	test('cards request cached thumbnails instead of original photos', () => {
		assert.match(JS, /photo_thumb/)
		assert.match(JS, /\?w=240/)
		assert.match(JS, /\?w=480/)
		assert.match(JS, /loading="\$\{loading\}"/)
		assert.match(JS, /decoding="async"/)
		assert.match(JS, /fetchpriority/)
		assert.match(JS, /srcset/)
		assert.match(CSS, /content-visibility:\s*auto/)
	})

	test('CRUD, prices and supplier links live on the same inventory surface', () => {
		assert.match(JS, /supCatalogCost/)
		assert.match(JS, /supCatalogSupplierUrl/)
		assert.match(JS, /supCatalogSupplierName/)
		assert.match(JS, /method: 'DELETE'/)
		assert.match(JS, /data-restock/)
		assert.match(JS, /data-edit/)
		assert.match(JS, /data-remove/)
		assert.match(JS, /data-restore/)
		assert.match(JS, /data-purge/)
		assert.match(JS, /purge=1/)
		assert.match(JS, /safeHttpUrl/)
		assert.match(JS, /rel="noopener noreferrer"/)
	})

	test('sticker cards are grouped by character family', () => {
		assert.match(JS, /sup-subsection/)
		assert.match(JS, /groupSectionRecords/)
		assert.match(JS, /id="supFamilyChips"/)
		assert.match(CSS, /\.sup-subsection/)
		assert.match(CSS, /\.sup-family-jumps/)
	})

	test('inventory catalog is grouped into category sections', () => {
		assert.match(JS, /syncSectionedCatalog/)
		assert.match(JS, /groupByCategory/)
		assert.match(JS, /class="sup-catalog"/)
		assert.match(CSS, /\.sup-catalog/)
		assert.match(CSS, /\.sup-section-head/)
		assert.match(CSS, /position:\s*sticky/)
		assert.match(CSS, /display:\s*contents/)
		assert.match(CSS, /minmax\(\s*min\(148px,\s*100%\)/)
		assert.match(CSS, /8\.25rem minmax\(0,\s*1fr\)/)
		assert.match(JS, /class="sup-workspace-pin"/)
		assert.match(CSS, /\.sup-workspace-pin/)
	})

	test('each card photo can be replaced from the overflow menu', () => {
		assert.match(JS, /data-replace-photo/)
		assert.match(JS, /id="supReplacePhoto"/)
		assert.match(JS, /photo_data/)
		assert.match(JS, /replacePhotoFromFile/)
		assert.match(JS, /data-menu/)
		assert.match(JS, /More actions/)
		assert.match(CSS, /\.sup-menu-toggle/)
		assert.match(CSS, /\.sup-menu-item/)
		assert.doesNotMatch(JS, /sup-photo-replace/)
		assert.doesNotMatch(CSS, /\.sup-photo-replace/)
		assert.doesNotMatch(JS, /sup-photo-wrap/)
		assert.doesNotMatch(CSS, /\.sup-photo-wrap/)
	})

	test('Add supply stays in the sticky toolbar so it survives daily count', () => {
		assert.match(JS, /id="supNewItem"/)
		assert.match(JS, /sup-toolbar-actions[\s\S]{0,500}id="supNewItem"/)
		assert.doesNotMatch(JS, /sup-live-actions[\s\S]{0,300}id="supNewItem"/)
		assert.match(JS, /openCatalogModal\(null\)/)
		assert.match(JS, /New packing supply/)
		assert.match(CSS, /#supNewItem/)
	})

	test('catalog form hides empty series, keeps Active beside its checkbox, and honors [hidden]', () => {
		assert.match(JS, /id="supCatalogActiveWrap"/)
		assert.match(JS, /class="sup-check-label"/)
		assert.match(JS, /sup-field sup-span sup-check/)
		assert.match(JS, /paintCatalogChrome/)
		assert.match(CSS, /#tab-supplies \[hidden\][\s\S]{0,40}display:\s*none/)
		assert.match(CSS, /\.sup-field\.sup-check/)
		assert.match(CSS, /\.sup-check-label/)
		assert.match(CSS, /grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(0,\s*1fr\)/)
		assert.match(JS, /supCatalogSupplierUrl[\s\S]{0,80}sup-span|class="sup-field sup-span"[\s\S]{0,120}supCatalogSupplierUrl/)
	})

	test('owner CRUD lives in an overflow menu so the photo and stepper stay clear', () => {
		assert.match(JS, /id="supCardMenu"/)
		assert.match(JS, /openCardMenu/)
		assert.match(JS, /function canManageCatalog/)
		assert.match(JS, /catalog-write/)
		assert.match(JS, /sup-menu-toggle/)
		assert.match(JS, /sup-stepper-val/)
		assert.match(JS, /data-count-edit/)
		assert.match(CSS, /\.sup-card-head/)
		assert.match(CSS, /\.sup-card-primary/)
		assert.match(CSS, /grid-template-columns:\s*1fr minmax\(2\.4rem,\s*auto\) 1fr/)
		assert.match(CSS, /@media \(max-width:\s*820px\)[\s\S]*\.sup-card \.sup-name[\s\S]*clip:\s*rect\(0,\s*0,\s*0,\s*0\)/)
		assert.match(CSS, /@media \(max-width:\s*820px\)[\s\S]*\.sup-card-head[\s\S]*position:\s*absolute/)
		assert.match(CSS, /@media \(max-width:\s*820px\)[\s\S]*\.sup-card-head[\s\S]*pointer-events:\s*none/)
		assert.match(CSS, /max-width:\s*calc\(100% - 44px\)/)
		assert.doesNotMatch(JS, /sup-card-actions/)
		assert.doesNotMatch(CSS, /\.sup-card-actions/)
		assert.doesNotMatch(
			JS,
			/sup-card-media[\s\S]{0,400}data-remove/,
			'Remove must not overlay the photo',
		)
		assert.doesNotMatch(
			JS,
			/sup-stepper[\s\S]{0,200}data-remove/,
			'Remove must not sit beside the stepper',
		)
	})

	test('names can be renamed in place and cards can be dragged', () => {
		assert.match(JS, /data-rename/)
		assert.match(JS, /beginRename/)
		assert.match(JS, /Click to rename/)
		assert.match(JS, /isComposing/)
		assert.match(JS, /handleNameActivate/)
		assert.match(JS, /\/api\/supplies\/items\/reorder/)
		assert.match(JS, /draggable="true"/)
		assert.match(JS, /contextmenu/)
		assert.match(CSS, /\.sup-name-input/)
		assert.match(CSS, /cursor:\s*text/)
		assert.match(CSS, /cursor:\s*grab/)
	})

	return Promise.all([
		testAsync('owner inventory paints two views, a restock banner, and thumbnail cards', async () => {
			const { dom, api } = mountDom({ role: 'owner' })
			api.mount()
			await api.load()
			const root = dom.window.document.getElementById('suppliesRoot')
			const tabs = [...root.querySelectorAll('.sup-tab')].map((el) => el.textContent.trim())
			assert.deepEqual(tabs, ['Inventory', 'Activity'])
			assert.equal(root.querySelectorAll('.sup-tab').length, 2)
			assert.ok(root.querySelector('.sup-hero'), 'hero matches shipping/route page chrome')
			assert.ok(root.querySelector('.sup-toolbar'), 'filters sit in a labeled toolbar')
			assert.equal(root.querySelector('#supLiveLow'), null, 'automatic low stock is not an operational alarm')
			assert.equal(root.querySelector('#supLowChip'), null)
			assert.equal(root.querySelector('#supLiveBuy').textContent, '0')
			assert.match(root.textContent, /Stock looks healthy/)
			assert.doesNotMatch(root.textContent, /needs restock/)
			assert.ok(root.querySelector('#supBuyChip'), 'To buy chip is in the toolbar')
			const primary = root.querySelector('#supInventoryGrid [data-item-id="1"] .sup-card-primary')
			const remind = primary.querySelector('button')
			assert.equal(remind.getAttribute('data-needs-purchase'), '1', 'Need to buy is the reminder on each card')
			assert.ok(remind.classList.contains('sup-btn-remind'), 'Need to buy is quiet until something is actually out')
			assert.equal(remind.classList.contains('sup-btn-buy'), false)
			assert.ok(root.querySelector('[data-needs-purchase="1"]'), 'inventory cards can be marked Need to buy')
			const img = root.querySelector('#supInventoryGrid img.sup-photo')
			assert.ok(img, 'inventory card has a photo')
			assert.match(img.getAttribute('src'), /\?w=240/)
			assert.equal(img.getAttribute('loading'), 'eager')
			assert.equal(img.getAttribute('decoding'), 'async')
			assert.ok(root.querySelector('[data-restock]'), 'restock action is on the card')
			assert.ok(root.querySelector('[data-menu]'), 'owner can open item actions')
			assert.equal(root.querySelector('#supInventoryGrid [data-remove]'), null, 'remove is not on the card surface')
			assert.equal(root.querySelector('#supInventoryGrid [data-edit]'), null, 'edit lives in the overflow menu')
			assert.doesNotMatch(root.querySelector('#supInventoryGrid').textContent, /BOX-PINK-MAILER-S/)
			assert.doesNotMatch(root.querySelector('#supInventoryGrid').textContent, /TAP-PINK-PACKING/)
			assert.match(CSS, /dialog\.sup-modal\[open\]/)
			assert.match(CSS, /justify-content:\s*center/)
			assert.ok(root.querySelector('a.sup-link[href^="https://www.uline.com"]'), 'supplier link is a safe https URL')
			assert.ok(root.querySelector('#supInventoryGrid a.sup-buy-overlay'), 'photo has a large Buy control for phones')
			assert.ok(root.querySelector('#supSpendPanel'), 'Activity hosts the purchase-cost panel')
			assert.equal(root.querySelector('#supNewItem').hidden, false)
			assert.ok(root.querySelector('#supNewItem').closest('.sup-toolbar'), 'Add supply stays in the catalog toolbar')
			assert.equal(root.querySelector('.sup-hero #supNewItem'), null, 'Add supply is not trapped in the hero')
			const badge = dom.window.document.querySelector('.tabs .tab[data-tab="supplies"] .sup-nav-badge')
			assert.equal(badge, null, 'nav badge is the purchase list, not automatic low stock')
			const boxes = root.querySelector('#supInventoryGrid .sup-section[data-cat="boxes"]')
			const tape = root.querySelector('#supInventoryGrid .sup-section[data-cat="tape"]')
			assert.ok(boxes, 'boxes sit in their own section')
			assert.ok(tape, 'tape sits in its own section')
			assert.equal(root.querySelectorAll('#supInventoryGrid .sup-section').length, 3)
			assert.equal(boxes.querySelector('.sup-section-title').textContent, 'Boxes')
			assert.equal(tape.querySelector('.sup-section-title').textContent, 'Tape')
			assert.ok(boxes.querySelector('[data-item-id="1"]'))
			assert.ok(boxes.querySelector('[data-item-id="6"]'))
			assert.ok(tape.querySelector('[data-item-id="2"]'))
			assert.equal(boxes.querySelector('.sup-section-meta').textContent, '2 items')
			const stickers = root.querySelector('#supInventoryGrid .sup-section[data-cat="stickers"]')
			assert.ok(stickers, 'stickers sit in their own section')
			assert.ok(stickers.querySelector('.sup-subsection[data-family="hello_kitty"]'), 'Hello Kitty is a sticker subclass')
			assert.ok(stickers.querySelector('.sup-subsection[data-family="kuromi"]'), 'Kuromi is a sticker subclass')
			assert.equal(stickers.querySelectorAll('.sup-subsection[data-family="hello_kitty"] .sup-card').length, 2)
			assert.equal(stickers.querySelectorAll('.sup-subsection[data-family="kuromi"] .sup-card').length, 1)
			assert.match(stickers.querySelector('.sup-subsection[data-family="hello_kitty"] .sup-subsection-title').textContent, /Hello Kitty/)
			root.querySelector('#supCategoryChips [data-cat="stickers"]').click()
			assert.equal(root.querySelector('#supFamilyChips').hidden, false)
			assert.match(root.querySelector('#supFamilyChips').textContent, /Hello Kitty/)
			root.querySelector('#supFamilyChips [data-family="kuromi"]').click()
			assert.equal(root.querySelectorAll('#supInventoryGrid .sup-card').length, 1)
			assert.ok(root.querySelector('#supInventoryGrid [data-item-id="5"]'))
			root.querySelector('#supCategoryChips [data-cat=""]').click()
			assert.equal(root.querySelector('.sup-card').getAttribute('draggable'), 'true')
			const name = root.querySelector('#supInventoryGrid .sup-name')
			assert.equal(name.tagName, 'BUTTON')
			assert.equal(name.getAttribute('title'), 'Click to rename')
			name.click()
			assert.ok(root.querySelector('#supInventoryGrid input.sup-name-input'), 'click opens an inline name field')
			assert.equal(dom.window.document.getElementById('supCatalogModal').hasAttribute('open'), false, 'renaming does not open the edit dialog')
			assert.ok(root.querySelector('#supReplacePhoto'), 'hidden photo picker is mounted')
			assert.ok(root.querySelector('#supCountBar.sup-count-bar'), 'daily count bar uses the designed chrome')
			assert.equal(root.querySelector('.sup-photo-replace'), null, 'replace control is not on the photo')
			assert.equal(root.querySelector('#supInventoryGrid .sup-card-media button'), null, 'photo has no action buttons')
			assert.equal(root.querySelector('#supInventoryGrid .sup-card-media [data-remove]'), null, 'remove is not on the photo')
			let pickerOpened = false
			root.querySelector('#supReplacePhoto').click = () => {
				pickerOpened = true
			}
			const menu = openItemMenu(root, 1)
			assert.ok(menu.querySelector('[data-edit]'), 'owner can edit a supply from the menu')
			assert.ok(menu.querySelector('[data-remove]'), 'owner can remove a supply from the menu')
			assert.ok(menu.querySelector('[data-replace-photo]'), 'card photo is replaceable from the menu')
			menu.querySelector('[data-replace-photo]').click()
			assert.equal(pickerOpened, true, 'menu replace control opens the photo picker')
			assert.equal(dom.window.document.getElementById('supCatalogModal').hasAttribute('open'), false, 'replacing a photo does not open the edit dialog')
		}),
		testAsync('employees share catalog CRUD with the owner', async () => {
			const { dom, api } = mountDom({ role: 'packer' })
			api.mount()
			await api.load()
			const root = dom.window.document.getElementById('suppliesRoot')
			assert.equal(root.querySelector('#supNewItem').hidden, false, 'employees can add a supply')
			assert.equal(root.querySelector('#supArchivedChip').hidden, false, 'employees can show retired stock')
			assert.ok(root.querySelector('[data-menu]'), 'employees get the catalog overflow')
			assert.equal(root.querySelector('#supBuyQueue').hidden, true, 'purchase queue stays owner-only')
			assert.match(root.querySelector('#supInventoryGrid [data-item-id="1"]').textContent, /0\.80|\$0\.8/)
			assert.equal(root.querySelector('.sup-card').getAttribute('draggable'), 'true')
			const name = root.querySelector('#supInventoryGrid .sup-name')
			assert.equal(name.tagName, 'BUTTON')
			assert.equal(name.hasAttribute('data-rename'), true)
			name.click()
			assert.ok(root.querySelector('input.sup-name-input'), 'employees can rename in place')
			const menu = openItemMenu(root, 1)
			assert.ok(menu.querySelector('[data-edit]'), 'employees can edit a supply')
			assert.ok(menu.querySelector('[data-remove]'), 'employees can retire a supply')
			assert.ok(menu.querySelector('[data-replace-photo]'), 'employees can replace photos')
			menu.querySelector('[data-edit]').click()
			assert.equal(dom.window.document.getElementById('supCatalogModal').hasAttribute('open'), true, 'edit opens the catalog form')
			assert.equal(dom.window.document.getElementById('supCatalogName').value, 'Pink Mailer Box (Small)')
		}),
		testAsync('inventory filter keeps the existing thumbnail node (no image reload)', async () => {
			const { dom, api } = mountDom({ role: 'owner' })
			api.mount()
			await api.load()
			const grid = dom.window.document.getElementById('supInventoryGrid')
			const tapeImg = grid.querySelector('[data-item-id="2"] img.sup-photo')
			assert.ok(tapeImg)
			dom.window.document.getElementById('supSearch').value = 'Tape'
			dom.window.document.getElementById('supSearch').dispatchEvent(new dom.window.Event('input', { bubbles: true }))
			assert.equal(grid.querySelectorAll('article.sup-card').length, 1)
			assert.equal(grid.querySelectorAll('.sup-section').length, 1)
			assert.equal(grid.querySelector('.sup-section').dataset.cat, 'tape')
			assert.equal(grid.querySelector('[data-item-id="2"] img.sup-photo'), tapeImg)
			dom.window.document.getElementById('supSearch').value = ''
			dom.window.document.getElementById('supSearch').dispatchEvent(new dom.window.Event('input', { bubbles: true }))
			assert.equal(grid.querySelectorAll('article.sup-card').length, 6)
			assert.equal(grid.querySelectorAll('.sup-section').length, 3)
			assert.equal(grid.querySelector('[data-item-id="2"] img.sup-photo'), tapeImg)
			dom.window.document.querySelector('#supCategoryChips [data-cat="tape"]').click()
			assert.equal(grid.querySelectorAll('.sup-section').length, 1)
			assert.equal(grid.querySelector('.sup-section').dataset.cat, 'tape')
			assert.equal(grid.querySelector('[data-item-id="2"] img.sup-photo'), tapeImg)
		}),
		testAsync('Simplified Chinese localises inventory, activity, restock and catalog details', async () => {
			const { dom, api } = mountDom({ role: 'owner', lang: 'zh' })
			api.mount()
			await api.load()
			const root = dom.window.document.getElementById('suppliesRoot')
			const tabs = [...root.querySelectorAll('.sup-tab')].map((el) => el.textContent.trim())
			assert.deepEqual(tabs, ['库存', '操作记录'])
			assert.match(root.textContent, /包材/)
			assert.match(root.textContent, /包材作业/)
			assert.match(root.textContent, /库存正常/)
			assert.doesNotMatch(root.textContent, /1 项包材需要补货/)
			assert.doesNotMatch(root.textContent, /需补货/)
			assert.match(root.textContent, /要买/)
			assert.match(root.textContent, /添加包材/)
			assert.match(root.textContent, /开始每日盘点/)
			assert.match(root.textContent, /显示已停用/)
			assert.match(root.textContent, /纸箱/)
			assert.match(root.textContent, /胶带/)
			assert.match(root.textContent, /全部/)
			assert.match(root.textContent, /贴纸/)
			assert.match(root.textContent, /凯蒂猫/)
			assert.match(root.textContent, /库洛米/)
			const zhBoxes = root.querySelector('#supInventoryGrid .sup-section[data-cat="boxes"] .sup-section-title')
			const zhTape = root.querySelector('#supInventoryGrid .sup-section[data-cat="tape"] .sup-section-title')
			assert.equal(zhBoxes.textContent, '纸箱')
			assert.equal(zhTape.textContent, '胶带')
			assert.equal(root.querySelector('#supInventoryGrid .sup-section[data-cat="boxes"] .sup-section-meta').textContent, '2 项')
			assert.ok([...root.querySelectorAll('[data-restock]')].some((el) => el.textContent.includes('补货')))
			const zhMenu = openItemMenu(root, 1)
			assert.equal(root.querySelector('#supInventoryGrid [data-menu]').getAttribute('title'), '更多操作')
			assert.ok([...zhMenu.querySelectorAll('[data-edit]')].some((el) => el.textContent.includes('编辑')))
			assert.ok([...zhMenu.querySelectorAll('[data-remove]')].some((el) => el.textContent.includes('移除')))
			assert.ok([...zhMenu.querySelectorAll('[data-replace-photo]')].some((el) => el.textContent.includes('更换照片')))
			assert.match(root.querySelector('#supSearch').getAttribute('placeholder'), /搜索名称/)
			assert.match(root.textContent, /粉色纸箱（小）/)
			assert.doesNotMatch(root.textContent, /Pink Mailer Box/)
			assert.doesNotMatch(root.textContent, /BOX-PINK-MAILER-S/)

			root.querySelector('.sup-tab[data-sup-view="log"]').click()
			await new Promise((r) => setTimeout(r, 20))
			assert.match(root.textContent, /每日盘点/)
			assert.match(root.textContent, /库存流水/)
			assert.match(root.textContent, /采购成本/)
			assert.match(root.textContent, /暂无每日盘点记录/)
			assert.match(root.textContent, /暂无库存流水/)

			root.querySelector('.sup-tab[data-sup-view="inventory"]').click()
			await new Promise((r) => setTimeout(r, 20))
			root.querySelector('[data-restock]').click()
			assert.match(dom.window.document.getElementById('supRestockModal').textContent, /入库数量/)
			assert.match(dom.window.document.getElementById('supRestockModal').textContent, /加入库存/)
			assert.match(dom.window.document.getElementById('supRestockModal').textContent, /进货单价/)
			assert.match(dom.window.document.getElementById('supRestockModal').textContent, /本次补货/)
			assert.match(dom.window.document.getElementById('supRestockModal').textContent, /去购买/)
			assert.match(dom.window.document.getElementById('supRestockMeta').textContent, /库存/)
			assert.match(dom.window.document.getElementById('supRestockMeta').textContent, /补货点/)
			dom.window.document.getElementById('supRestockModal').close()

			openItemMenu(root, 1).querySelector('[data-edit]').click()
			assert.equal(dom.window.document.getElementById('supCatalogTitle').textContent, '编辑包材')
			assert.equal(dom.window.document.getElementById('supCatalogActiveWrap').hidden, false, 'edit keeps the active control')
			assert.match(dom.window.document.getElementById('supCatalogActiveWrap').textContent, /启用/)
			assert.match(dom.window.document.getElementById('supCatalogModal').textContent, /名称/)
			assert.match(dom.window.document.getElementById('supCatalogModal').textContent, /类别/)
			assert.doesNotMatch(dom.window.document.getElementById('supCatalogModal').textContent, /货号/)
			assert.match(dom.window.document.getElementById('supCatalogModal').textContent, /单位成本/)
			assert.match(dom.window.document.getElementById('supCatalogModal').textContent, /供应商链接/)
			assert.match(dom.window.document.getElementById('supCatalogModal').textContent, /保存包材/)
			assert.match(dom.window.document.getElementById('supCatalogModal').textContent, /停用/)
			assert.match(dom.window.document.getElementById('supCatalogModal').textContent, /移除/)
			assert.match(dom.window.document.getElementById('supCatalogUom').textContent, /个/)
			assert.match(dom.window.document.getElementById('supCatalogUom').textContent, /卷/)
			assert.equal(root.querySelector('#supInventoryGrid .sup-name').getAttribute('title'), '点击即可改名称')
		}),
		testAsync('clicking a supply name edits it in place without opening the card', async () => {
			const { dom, api, fetches } = mountDom({ role: 'owner' })
			api.mount()
			await api.load()
			const root = dom.window.document.getElementById('suppliesRoot')
			const card = root.querySelector('#supInventoryGrid [data-item-id="1"]')
			const name = card.querySelector('.sup-name')
			assert.equal(name.textContent, 'Pink Mailer Box (Small)')
			name.click()
			const input = root.querySelector('input.sup-name-input')
			assert.ok(input, 'name click opens an editor')
			assert.equal(input.value, 'Pink Mailer Box (Small)')
			assert.equal(input.maxLength, 120)
			assert.equal(dom.window.document.getElementById('supCatalogModal').hasAttribute('open'), false)

			input.value = '   Lavender Shelf Box   '
			fireKey(input, 'Enter')
			await tick()
			const saved = root.querySelector('#supInventoryGrid [data-item-id="1"] .sup-name')
			assert.equal(saved.textContent, 'Lavender Shelf Box')
			assert.equal(saved.tagName, 'BUTTON')
			const patches = fetches.filter((f) => f.method === 'PATCH')
			assert.equal(patches.length, 1)
			assert.deepEqual(JSON.parse(patches[0].body), { name: 'Lavender Shelf Box' })
			assert.match(root.querySelector('#supToast').textContent, /Name saved/)
			assert.equal(dom.window.document.getElementById('supCatalogModal').hasAttribute('open'), false)

			saved.click()
			const again = root.querySelector('input.sup-name-input')
			fireKey(again, 'Enter')
			await tick()
			assert.equal(fetches.filter((f) => f.method === 'PATCH').length, 1, 'unchanged name does not PATCH')
		}),
		testAsync('inline rename Escape cancels and empty names are rejected', async () => {
			const { dom, api, fetches } = mountDom({ role: 'owner' })
			api.mount()
			await api.load()
			const root = dom.window.document.getElementById('suppliesRoot')
			const name = root.querySelector('#supInventoryGrid [data-item-id="1"] .sup-name')
			name.click()
			const input = root.querySelector('input.sup-name-input')
			input.value = 'Should Not Save'
			fireKey(input, 'Escape')
			const restored = root.querySelector('#supInventoryGrid [data-item-id="1"] .sup-name')
			assert.equal(restored.textContent, 'Pink Mailer Box (Small)')
			assert.equal(fetches.filter((f) => f.method === 'PATCH').length, 0)

			restored.click()
			const empty = root.querySelector('input.sup-name-input')
			empty.value = '   '
			fireKey(empty, 'Enter')
			await tick()
			assert.equal(root.querySelector('#supInventoryGrid [data-item-id="1"] .sup-name').textContent, 'Pink Mailer Box (Small)')
			assert.equal(fetches.filter((f) => f.method === 'PATCH').length, 0)
			assert.match(root.querySelector('#supToast').textContent, /Name is required/)
		}),
		testAsync('inline rename conflict restores the previous name', async () => {
			const { dom, api } = mountDom({ role: 'owner' })
			api.mount()
			await api.load()
			const root = dom.window.document.getElementById('suppliesRoot')
			root.querySelector('#supInventoryGrid [data-item-id="1"] .sup-name').click()
			const input = root.querySelector('input.sup-name-input')
			input.value = 'Pink Packing Tape'
			fireKey(input, 'Enter')
			await tick()
			assert.equal(root.querySelector('#supInventoryGrid [data-item-id="1"] .sup-name').textContent, 'Pink Mailer Box (Small)')
			assert.match(root.querySelector('#supToast').textContent, /A supply with this name already exists/)
		}),
		testAsync('clicking the card body still opens the catalog editor', async () => {
			const { dom, api } = mountDom({ role: 'owner' })
			api.mount()
			await api.load()
			const root = dom.window.document.getElementById('suppliesRoot')
			root.querySelector('#supInventoryGrid [data-item-id="1"] [data-role="qty"]').click()
			assert.equal(dom.window.document.getElementById('supCatalogModal').hasAttribute('open'), true)
		}),
		testAsync('Chinese inventory click-to-rename writes the Chinese name', async () => {
			const { dom, api, fetches } = mountDom({ role: 'owner', lang: 'zh' })
			api.mount()
			await api.load()
			const root = dom.window.document.getElementById('suppliesRoot')
			const name = root.querySelector('#supInventoryGrid [data-item-id="1"] .sup-name')
			assert.equal(name.textContent, '粉色纸箱（小）')
			assert.equal(name.getAttribute('title'), '点击即可改名称')
			name.click()
			const input = root.querySelector('input.sup-name-input')
			input.value = '货架测试纸箱'
			fireKey(input, 'Enter')
			await tick()
			assert.equal(root.querySelector('#supInventoryGrid [data-item-id="1"] .sup-name').textContent, '货架测试纸箱')
			const patches = fetches.filter((f) => f.method === 'PATCH')
			assert.equal(patches.length, 1)
			assert.deepEqual(JSON.parse(patches[0].body), { name_zh: '货架测试纸箱' })
		}),
		testAsync('daily count click-to-rename does not open the count dialog', async () => {
			const { dom, api, fetches } = mountDom({ role: 'owner', counting: true })
			api.mount()
			await api.load()
			const root = dom.window.document.getElementById('suppliesRoot')
			const name = root.querySelector('#supCountGrid [data-item-id="1"] .sup-name')
			assert.ok(name, 'count cards show a name')
			assert.equal(name.tagName, 'BUTTON')
			name.click()
			assert.ok(root.querySelector('#supCountGrid input.sup-name-input'), 'count name is editable in place')
			assert.equal(dom.window.document.getElementById('supCountModal').hasAttribute('open'), false)
			const input = root.querySelector('#supCountGrid input.sup-name-input')
			input.value = 'Counted Box'
			fireKey(input, 'Enter')
			await tick()
			assert.equal(root.querySelector('#supCountGrid [data-item-id="1"] .sup-name').textContent, 'Counted Box')
			const patches = fetches.filter((f) => f.method === 'PATCH')
			assert.equal(patches.length, 1)
			assert.deepEqual(JSON.parse(patches[0].body), { name: 'Counted Box' })
			assert.equal(dom.window.document.getElementById('supCountModal').hasAttribute('open'), false)
		}),
		testAsync('owner count cards expose remove in the overflow menu without opening the count dialog', async () => {
			const { dom, api, fetches } = mountDom({ role: 'owner', counting: true })
			api.mount()
			await api.load()
			const root = dom.window.document.getElementById('suppliesRoot')
			const card = root.querySelector('#supCountGrid [data-item-id="1"]')
			assert.equal(card.querySelector('.sup-photo-replace'), null, 'replace is not on the photo')
			assert.equal(card.querySelector('.sup-card-media button'), null, 'photo has no action buttons')
			assert.equal(card.querySelector('.sup-card-media [data-remove]'), null, 'Remove is not on the photo')
			assert.equal(card.querySelector('[data-remove]'), null, 'Remove is not on the card surface')
			assert.ok(card.querySelector('.sup-card-body .sup-stepper'), 'count stepper stays in the body')
			assert.ok(card.querySelector('[data-count-match]'), 'Looks right is the primary shelf-check action')
			assert.ok(card.querySelector('[data-count-match]').classList.contains('sup-btn-primary'), 'stocked shelves lead with Looks right')
			assert.ok(card.querySelector('[data-needs-purchase="1"]'), 'Need to buy sits on every count card')
			assert.ok(card.querySelector('[data-count-none]'), 'None is available when the book is not zero')
			assert.ok(card.querySelector('.sup-stepper-val'), 'stepper shows the current quantity')
			assert.equal(card.querySelector('.sup-stepper-val').textContent, '4')
			assert.doesNotMatch(card.querySelector('[data-role="qty"]').textContent, /System/)
			let pickerOpened = false
			root.querySelector('#supReplacePhoto').click = () => {
				pickerOpened = true
			}
			const menu = openItemMenu(root, 1)
			assert.equal(dom.window.document.getElementById('supCountModal').hasAttribute('open'), false, 'opening the menu does not open the count dialog')
			assert.ok(menu.querySelector('[data-replace-photo]'), 'Replace photo lives in the overflow menu')
			menu.querySelector('[data-replace-photo]').click()
			assert.equal(pickerOpened, true, 'menu replace opens the picker during count')
			assert.equal(dom.window.document.getElementById('supCountModal').hasAttribute('open'), false, 'replacing a photo does not open the count dialog')
			openItemMenu(root, 1)
			const remove = root.querySelector('#supCardMenu [data-remove]')
			assert.ok(remove, 'Remove is in the overflow menu')
			dom.window.confirm = () => true
			remove.click()
			await tick()
			assert.equal(dom.window.document.getElementById('supCountModal').hasAttribute('open'), false)
			const deletes = fetches.filter((f) => f.method === 'DELETE')
			assert.equal(deletes.length, 1)
			assert.equal(deletes[0].url, '/api/supplies/items/1')
		}),
		testAsync('employees confirm the shelf and can still open catalog actions', async () => {
			const { dom, api } = mountDom({ role: 'packer', counting: true })
			api.mount()
			await api.load()
			const root = dom.window.document.getElementById('suppliesRoot')
			const card = root.querySelector('#supCountGrid [data-item-id="1"]')
			assert.ok(card.querySelector('[data-count-match]'), 'employees get Looks right')
			assert.ok(card.querySelector('[data-needs-purchase="1"]'), 'employees can mark Need to buy')
			assert.ok(card.querySelector('[data-count-none]'), 'employees can mark a supply empty')
			assert.ok(card.querySelector('.sup-stepper'), 'employees can still adjust a number')
			assert.ok(card.querySelector('[data-menu]'), 'catalog overflow stays available during a shelf check')
			assert.equal(root.querySelector('#supNewItem').hidden, false, 'Add supply stays available during a shelf check')
			assert.ok(root.querySelector('#supCountPendingChip.active'), 'To check is on so the list shrinks as you go')
			assert.ok(root.querySelector('#supCountMatchRest'), 'remaining lines can be confirmed in one tap')
			assert.match(root.querySelector('#supCountBar strong').textContent, /Shelf check/)
			assert.doesNotMatch(root.querySelector('#supCountBar').textContent, /Daily count in progress/)
			const menu = openItemMenu(root, 1)
			assert.equal(dom.window.document.getElementById('supCountModal').hasAttribute('open'), false, 'opening the menu does not open the count dialog')
			assert.ok(menu.querySelector('[data-edit]'), 'employees can edit during a shelf check')
			assert.ok(menu.querySelector('[data-replace-photo]'), 'employees can replace photos during a shelf check')
		}),
		testAsync('empty shelves still look right until someone taps Need to buy', async () => {
			const { dom, api } = mountDom({ role: 'packer', counting: true })
			api.mount()
			await api.load()
			const root = dom.window.document.getElementById('suppliesRoot')
			const card = root.querySelector('#supCountGrid [data-item-id="6"]')
			assert.ok(card, 'zero-on-hand SKUs still appear in the walk')
			assert.equal(card.classList.contains('is-empty-expected'), true)
			const pair = card.querySelector('.sup-count-check.is-choice-pair.is-empty-expected')
			assert.ok(pair, 'empty book qty uses the two-choice layout')
			const actions = [...pair.querySelectorAll('button')]
			assert.ok(actions[0].hasAttribute('data-count-match'), 'Looks right is the default on an empty shelf')
			assert.equal(actions[0].classList.contains('sup-btn-primary'), true)
			assert.equal(actions[1].getAttribute('data-needs-purchase'), '1')
			assert.ok(actions[1].classList.contains('sup-btn-remind'), 'Need to buy is the quiet reminder')
			assert.equal(actions[1].classList.contains('sup-btn-buy'), false)
			assert.equal(card.querySelector('[data-count-none]'), null, 'None is omitted when expected is already zero')
			assert.doesNotMatch(card.querySelector('[data-role="qty"]').textContent, /System/)
			assert.match(card.querySelector('[data-role="qty"]').textContent, /0/)
			card.querySelector('.sup-card-media').click()
			const modal = dom.window.document.getElementById('supCountModal')
			assert.equal(modal.hasAttribute('open'), true)
			assert.equal(dom.window.document.getElementById('supCountModalNone').hidden, true)
			assert.ok(dom.window.document.getElementById('supCountModalShortcuts').classList.contains('is-empty-expected'))
			assert.equal(dom.window.document.getElementById('supCountModalMatch').classList.contains('sup-btn-primary'), true)
			assert.ok(dom.window.document.getElementById('supCountModalBuy').classList.contains('sup-btn-remind'))
		}),
		testAsync('Looks right records expected qty and leaves the To check list', async () => {
			const { dom, api, fetches } = mountDom({ role: 'packer', counting: true })
			api.mount()
			await api.load()
			const root = dom.window.document.getElementById('suppliesRoot')
			const card = root.querySelector('#supCountGrid [data-item-id="1"]')
			card.querySelector('[data-count-match]').click()
			assert.equal(dom.window.document.getElementById('supCountModal').hasAttribute('open'), false, 'Matches does not open the number dialog')
			await tick()
			const puts = fetches.filter((f) => f.method === 'PUT' && f.url === '/api/supplies/counts/9/lines')
			assert.equal(puts.length, 1, 'saves the confirmed line')
			assert.deepEqual(JSON.parse(puts[0].body), { lines: [{ item_id: 1, counted_qty: 4 }] })
			assert.equal(root.querySelector('#supCountGrid [data-item-id="1"]'), null, 'checked cards leave the To check list')
			root.querySelector('#supCountPendingChip').click()
			const reviewed = root.querySelector('#supCountGrid [data-item-id="1"]')
			assert.ok(reviewed, 'turning off To check shows checked cards')
			assert.equal(reviewed.classList.contains('is-counted'), true)
			assert.match(reviewed.querySelector('.sup-count-status').textContent, /Looks right/)
			const remind = reviewed.querySelector('[data-needs-purchase="1"]')
			assert.ok(remind, 'Need to buy stays available as a reminder')
			assert.ok(remind.classList.contains('sup-btn-remind'))
			assert.equal(remind.classList.contains('sup-btn-buy'), false, 'Need to buy is not the alarm once it looks right')
		}),
		testAsync('finishing a category keeps those cards on screen instead of an empty walk', async () => {
			const { dom, api } = mountDom({ role: 'packer', counting: true })
			api.mount()
			await api.load()
			const root = dom.window.document.getElementById('suppliesRoot')
			root.querySelector('#supCategoryChips [data-cat="tape"]').click()
			assert.ok(root.querySelector('#supCountGrid [data-item-id="2"]'), 'tape walk has the only tape SKU')
			assert.equal(root.querySelector('#supCountGrid [data-item-id="1"]'), null)
			root.querySelector('#supCountGrid [data-item-id="2"] [data-count-match]').click()
			await tick()
			const reviewed = root.querySelector('#supCountGrid [data-item-id="2"]')
			assert.ok(reviewed, 'the last SKU in this view stays on screen')
			assert.equal(reviewed.classList.contains('is-counted'), true)
			assert.equal(root.querySelector('.sup-empty'), null)
			assert.ok(root.querySelector('#supCountPendingChip.active'), 'To check stays on so All still walks the rest')
			root.querySelector('#supCategoryChips [data-cat=""]').click()
			assert.equal(root.querySelector('#supCountGrid [data-item-id="2"]'), null, 'checked tape leaves the remaining walk')
			assert.ok(root.querySelector('#supCountGrid [data-item-id="1"]'), 'unchecked SKUs stay in the walk')
		}),
		testAsync('checking the last remaining supply brings the shelf back for review', async () => {
			const { dom, api, items } = mountDom({ role: 'packer', counting: true })
			api.mount()
			await api.load()
			const root = dom.window.document.getElementById('suppliesRoot')
			for (const item of items.slice(0, -1)) {
				const card = root.querySelector(`#supCountGrid [data-item-id="${item.id}"]`)
				assert.ok(card, `unchecked ${item.id} is still in the walk`)
				card.querySelector('[data-count-match]').click()
				await tick()
				assert.equal(root.querySelector(`#supCountGrid [data-item-id="${item.id}"]`), null)
			}
			const last = items[items.length - 1]
			root.querySelector(`#supCountGrid [data-item-id="${last.id}"] [data-count-match]`).click()
			await tick()
			assert.equal(root.querySelector('.sup-empty'), null, 'finishing the walk does not blank the shelf')
			assert.equal(root.querySelectorAll('#supCountGrid article.is-counted').length, items.length)
			assert.ok(root.querySelector(`#supCountGrid [data-item-id="${last.id}"]`))
			assert.equal(root.querySelector('#supCountPendingChip'), null)
			assert.ok(root.querySelector('#supSubmitCount'))
			assert.match(root.querySelector('#supCountBar .sup-meta').textContent, /6\/6 checked/)
		}),
		testAsync('Need to buy during a shelf check flags the SKU for the owner and leaves To check', async () => {
			const { dom, api, fetches } = mountDom({ role: 'packer', counting: true })
			api.mount()
			await api.load()
			const root = dom.window.document.getElementById('suppliesRoot')
			const card = root.querySelector('#supCountGrid [data-item-id="1"]')
			card.querySelector('[data-needs-purchase="1"]').click()
			await tick()
			const puts = fetches.filter((f) => f.method === 'PUT' && f.url === '/api/supplies/counts/9/lines')
			assert.equal(puts.length, 1, 'Need to buy also records the shelf as looking right')
			assert.deepEqual(JSON.parse(puts[0].body), { lines: [{ item_id: 1, counted_qty: 4 }] })
			const posts = fetches.filter((f) => f.method === 'POST' && f.url === '/api/supplies/items/1/needs-purchase')
			assert.equal(posts.length, 1, 'flags the SKU for purchase')
			assert.deepEqual(JSON.parse(posts[0].body), { needed: true })
			assert.equal(root.querySelector('#supCountGrid [data-item-id="1"]'), null, 'flagged cards leave the To check list')
			root.querySelector('#supCountPendingChip').click()
			const flagged = root.querySelector('#supCountGrid [data-item-id="1"]')
			assert.ok(flagged, 'turning off To check shows the flagged card')
			assert.equal(flagged.classList.contains('is-buy'), true)
			assert.match(flagged.querySelector('.sup-count-status').textContent, /Need to buy/)
			assert.ok(flagged.querySelector('[data-needs-purchase="0"]'), 'Cancel buy is available after flagging')
			assert.match(root.querySelector('#supCountBar .sup-meta').textContent, /to buy/)
			const badge = dom.window.document.querySelector('.tabs .tab[data-tab="supplies"] .sup-nav-badge')
			assert.ok(badge, 'owner UED shows a purchase badge')
			assert.equal(badge.textContent, '1')
			assert.equal(root.querySelector('#supLiveBuy').textContent, '1')
			assert.match(root.querySelector('#supBuyChip').textContent, /To buy/)
		}),
		testAsync('Orders To buy opens a purchase queue so the owner can mark purchased during a count', async () => {
			const { dom, api, fetches } = mountDom({ role: 'owner', counting: true })
			api.mount()
			await api.load()
			const root = dom.window.document.getElementById('suppliesRoot')
			root.querySelector('#supCountGrid [data-item-id="1"] [data-needs-purchase="1"]').click()
			await tick()
			api.showToBuy()
			const queue = root.querySelector('#supBuyQueue')
			assert.equal(queue.hidden, false, 'queue is visible during an open count')
			assert.ok(queue.querySelector('[data-mark-purchased="1"]'), 'Mark purchased is on the flagged SKU')
			assert.match(queue.textContent, /Mark purchased/)
			assert.ok(queue.querySelector('[data-restock="1"]'), 'Restock remains for when the boxes arrive')
			queue.querySelector('[data-mark-purchased="1"]').click()
			await tick()
			const posts = fetches.filter((f) => f.method === 'POST' && f.url === '/api/supplies/items/1/purchased')
			assert.equal(posts.length, 1, 'records that the owner ordered it')
			assert.deepEqual(JSON.parse(posts[0].body), { purchased: true })
			assert.equal(root.querySelector('#supBuyQueue').hidden, true, 'queue closes when the list is empty')
			assert.equal(dom.window.document.querySelector('.tabs .tab[data-tab="supplies"] .sup-nav-badge'), null)
		}),
		testAsync('inventory Need to buy marks the To buy list without a daily count', async () => {
			const { dom, api, fetches } = mountDom({ role: 'packer' })
			api.mount()
			await api.load()
			const root = dom.window.document.getElementById('suppliesRoot')
			root.querySelector('#supInventoryGrid [data-item-id="2"] [data-needs-purchase="1"]').click()
			await tick()
			const posts = fetches.filter((f) => f.method === 'POST' && f.url === '/api/supplies/items/2/needs-purchase')
			assert.equal(posts.length, 1)
			assert.deepEqual(JSON.parse(posts[0].body), { needed: true })
			const card = root.querySelector('#supInventoryGrid [data-item-id="2"]')
			assert.equal(card.classList.contains('is-buy'), true)
			assert.ok(card.querySelector('[data-needs-purchase="0"]'))
			const badge = dom.window.document.querySelector('.tabs .tab[data-tab="supplies"] .sup-nav-badge')
			assert.equal(badge.textContent, '1')
			root.querySelector('#supBuyChip').click()
			assert.ok(root.querySelector('#supBuyChip.active'), 'To buy filter is on')
			assert.ok(root.querySelector('#supInventoryGrid [data-item-id="2"]'))
			assert.equal(root.querySelector('#supInventoryGrid [data-item-id="1"]'), null, 'unflagged SKUs leave the To buy list')
			assert.equal(root.querySelector('#supBuyQueue').hidden, true, 'packers do not get Mark purchased')
		}),
		testAsync('None records zero and stepper plus/minus still save', async () => {
			const { dom, api, fetches } = mountDom({ role: 'owner', counting: true })
			api.mount()
			await api.load()
			const root = dom.window.document.getElementById('suppliesRoot')
			root.querySelector('#supCountGrid [data-item-id="1"] [data-count-none]').click()
			await tick()
			let puts = fetches.filter((f) => f.method === 'PUT' && f.url === '/api/supplies/counts/9/lines')
			assert.equal(puts.length, 1)
			assert.deepEqual(JSON.parse(puts[0].body), { lines: [{ item_id: 1, counted_qty: 0 }] })
			root.querySelector('#supCountPendingChip').click()
			const plus = root.querySelector('#supCountGrid [data-item-id="2"] [data-count-delta="1"]')
			assert.ok(plus, 'stepper plus is clickable even with data-stop on the wrapper')
			plus.click()
			await tick()
			puts = fetches.filter((f) => f.method === 'PUT' && f.url === '/api/supplies/counts/9/lines')
			assert.equal(puts.length, 2)
			assert.deepEqual(JSON.parse(puts[1].body), { lines: [{ item_id: 2, counted_qty: 9 }] })
		}),
		testAsync('count dialog prefills the book qty and Review & submit works with lines left', async () => {
			const { dom, api, fetches } = mountDom({ role: 'packer', counting: true })
			api.mount()
			await api.load()
			const root = dom.window.document.getElementById('suppliesRoot')
			root.querySelector('#supCountGrid [data-item-id="1"] .sup-card-media').click()
			assert.equal(dom.window.document.getElementById('supCountModal').hasAttribute('open'), true)
			assert.equal(dom.window.document.getElementById('supCountModalQty').value, '4')
			dom.window.document.getElementById('supCountModal').close()
			root.querySelector('#supSubmitCount').click()
			const submit = dom.window.document.getElementById('supSubmitModal')
			assert.equal(submit.hasAttribute('open'), true, 'submit is not blocked by remaining lines')
			assert.match(dom.window.document.getElementById('supSubmitSummary').textContent, /not opened/)
			assert.equal(dom.window.document.getElementById('supSubmitMatchRest').hidden, false)
			root.querySelector('#supSubmitConfirm').click()
			await tick()
			const posts = fetches.filter((f) => f.method === 'POST' && f.url === '/api/supplies/counts/9/submit')
			assert.equal(posts.length, 1)
			assert.deepEqual(JSON.parse(posts[0].body), { require_complete: false })
		}),
		testAsync('The rest look right confirms every remaining line in one request', async () => {
			const { dom, api, fetches, items } = mountDom({ role: 'owner', counting: true })
			api.mount()
			await api.load()
			const root = dom.window.document.getElementById('suppliesRoot')
			dom.window.confirm = () => true
			root.querySelector('#supCountMatchRest').click()
			await tick()
			const puts = fetches.filter((f) => f.method === 'PUT' && f.url === '/api/supplies/counts/9/lines')
			assert.equal(puts.length, 1)
			const body = JSON.parse(puts[0].body)
			assert.equal(body.lines.length, items.length)
			assert.deepEqual(
				body.lines,
				items.map((item) => ({ item_id: item.id, counted_qty: item.qty_on_hand })),
			)
			assert.equal(root.querySelector('.sup-empty'), null, 'the checked shelf stays on screen')
			assert.equal(root.querySelectorAll('#supCountGrid article.is-counted').length, items.length)
			assert.equal(root.querySelector('#supCountPendingChip'), null, 'To check leaves once nothing remains')
			assert.match(root.querySelector('#supCountBar .sup-meta').textContent, /6\/6 checked/)
			assert.doesNotMatch(root.querySelector('#supCountBar .sup-meta').textContent, /0 left/)
			assert.match(root.querySelector('#supCountBar .sup-count-hint').textContent, /Review the shelf/)
			assert.ok(root.querySelector('#supSubmitCount'), 'Review & submit is the next action')
			assert.ok(root.querySelector('.sup-shell.is-count-review'))
		}),
		testAsync('owner can add a supply during a daily count', async () => {
			const { dom, api } = mountDom({ role: 'owner', counting: true })
			api.mount()
			await api.load()
			const root = dom.window.document.getElementById('suppliesRoot')
			assert.ok(root.querySelector('.sup-shell.is-counting'), 'daily count hides the hero')
			assert.match(CSS, /#tab-supplies \.sup-shell\.is-counting #supBuyChip[\s\S]{0,80}display:\s*none/)
			assert.doesNotMatch(
				CSS,
				/#tab-supplies \.sup-shell\.is-counting \.sup-toolbar-actions[\s\S]{0,40}display:\s*none/,
				'Add supply stays visible during a shelf check',
			)
			assert.match(CSS, /#tab-supplies \.sup-shell\.is-counting \.sup-tabs[\s\S]{0,40}display:\s*none/)
			const add = root.querySelector('#supNewItem')
			assert.ok(add, 'Add supply is mounted')
			assert.equal(add.hidden, false, 'owner can add a supply during a shelf check')
			assert.ok(add.closest('.sup-toolbar'), 'Add supply lives in the sticky toolbar')
			assert.ok(add.closest('.sup-toolbar-actions'))
			assert.equal(add.closest('.sup-hero'), null)
			add.click()
			assert.equal(dom.window.document.getElementById('supCatalogModal').hasAttribute('open'), true)
			assert.equal(dom.window.document.getElementById('supCatalogTitle').textContent, 'New packing supply')
			assert.equal(dom.window.document.getElementById('supCatalogPhotoAction').textContent, 'Add photo')
			assert.match(dom.window.document.getElementById('supCatalogModal').textContent, /Drop a photo here or browse/)
			assert.equal(dom.window.document.getElementById('supCatalogActiveWrap').hidden, true, 'new supplies are active — no retire checkbox')
			assert.equal(dom.window.document.getElementById('supCatalogFamilyWrap').hidden, true, 'empty series row stays hidden')
			assert.equal(dom.window.document.getElementById('supCatalogActive').checked, true)
		}),
		testAsync('owner can create a packing supply from the catalog form', async () => {
			const { dom, api, fetches } = mountDom({ role: 'owner' })
			api.mount()
			await api.load()
			const root = dom.window.document.getElementById('suppliesRoot')
			root.querySelector('#supNewItem').click()
			const modal = dom.window.document.getElementById('supCatalogModal')
			assert.equal(modal.hasAttribute('open'), true)
			assert.equal(dom.window.document.getElementById('supCatalogTitle').textContent, 'New packing supply')
			assert.equal(dom.window.document.getElementById('supCatalogActiveWrap').hidden, true)
			dom.window.document.getElementById('supCatalogName').value = 'Clear Mailer Bag'
			dom.window.document.getElementById('supCatalogCategory').value = 'boxes'
			dom.window.document.getElementById('supCatalogUom').value = 'each'
			dom.window.document.getElementById('supCatalogReorderPoint').value = '10'
			dom.window.document.getElementById('supCatalogReorderQty').value = '50'
			dom.window.document.getElementById('supCatalogForm').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
			await tick()
			const posts = fetches.filter((f) => f.method === 'POST' && f.url === '/api/supplies/items')
			assert.equal(posts.length, 1, 'creates the supply')
			assert.equal(JSON.parse(posts[0].body).name, 'Clear Mailer Bag')
			assert.equal(JSON.parse(posts[0].body).category_slug, 'boxes')
			assert.equal(JSON.parse(posts[0].body).active, 1)
			assert.equal(modal.hasAttribute('open'), false)
			assert.ok(root.querySelector('#supInventoryGrid [data-item-id="7"]'), 'new card appears in inventory')
			assert.equal(root.querySelector('#supInventoryGrid [data-item-id="7"] .sup-name').textContent, 'Clear Mailer Bag')
			assert.match(root.querySelector('#supToast').textContent, /Supply saved/)
		}),
		testAsync('owner can create a supply during count and it joins the open session', async () => {
			const { dom, api, fetches } = mountDom({ role: 'owner', counting: true })
			api.mount()
			await api.load()
			const root = dom.window.document.getElementById('suppliesRoot')
			root.querySelector('#supNewItem').click()
			dom.window.document.getElementById('supCatalogName').value = 'Extra Bubble Wrap'
			dom.window.document.getElementById('supCatalogForm').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
			await tick()
			assert.equal(fetches.filter((f) => f.method === 'POST' && f.url === '/api/supplies/items').length, 1)
			assert.ok(root.querySelector('#supCountGrid [data-item-id="7"]'), 'new item is on the count board')
			assert.ok(root.querySelector('#supCountGrid [data-item-id="7"] .sup-stepper'), 'new count line has a stepper')
			assert.ok(root.querySelector('#supCountGrid [data-item-id="7"] [data-count-match]'), 'new count line can be confirmed')
			assert.ok(root.querySelector('#supCountGrid [data-item-id="7"] .sup-count-check.is-empty-expected'), 'new supplies start at zero and use the empty-shelf choices')
		}),
		testAsync('owner can remove a supply from the inventory card', async () => {
			const { dom, api, fetches } = mountDom({ role: 'owner' })
			api.mount()
			await api.load()
			const root = dom.window.document.getElementById('suppliesRoot')
			const menu = openItemMenu(root, 1)
			const remove = menu.querySelector('[data-remove]')
			assert.ok(remove, 'Remove is in the overflow menu')
			assert.equal(remove.textContent.trim(), 'Remove')
			let asked = ''
			dom.window.confirm = (msg) => {
				asked = String(msg)
				return true
			}
			remove.click()
			await tick()
			assert.match(asked, /Retire this supply/)
			const deletes = fetches.filter((f) => f.method === 'DELETE')
			assert.equal(deletes.length, 1)
			assert.equal(deletes[0].url, '/api/supplies/items/1')
			assert.equal(deletes[0].search, '')
			assert.equal(root.querySelector('#supInventoryGrid [data-item-id="1"]'), null)
			assert.match(root.querySelector('#supToast').textContent, /Supply retired/)
		}),
		testAsync('cancelling remove confirm does not call DELETE', async () => {
			const { dom, api, fetches } = mountDom({ role: 'owner' })
			api.mount()
			await api.load()
			const root = dom.window.document.getElementById('suppliesRoot')
			let asked = 0
			dom.window.confirm = () => {
				asked += 1
				return false
			}
			root.querySelector('[data-menu]').click()
			root.querySelector('#supCardMenu [data-remove]').click()
			await tick()
			assert.equal(asked, 1)
			assert.equal(fetches.filter((f) => f.method === 'DELETE').length, 0)
			assert.ok(root.querySelector('#supInventoryGrid [data-item-id="1"]'))
		}),
		testAsync('retired supplies can be restored or deleted permanently', async () => {
			const { dom, api, fetches } = mountDom({ role: 'owner' })
			api.mount()
			await api.load()
			const root = dom.window.document.getElementById('suppliesRoot')
			dom.window.confirm = () => true
			openItemMenu(root, 2).querySelector('[data-remove]').click()
			await tick()
			assert.equal(root.querySelector('#supInventoryGrid [data-item-id="2"]'), null)
			root.querySelector('#supArchivedChip').click()
			await tick()
			const retired = root.querySelector('#supInventoryGrid [data-item-id="2"]')
			assert.ok(retired, 'retired card returns when Show retired is on')
			assert.ok(retired.classList.contains('is-archived'))
			assert.equal(retired.querySelector('[data-restock]'), null)
			const retiredMenu = openItemMenu(root, 2)
			assert.ok(retiredMenu.querySelector('[data-restore]'), 'retired card can be restored')
			assert.ok(retiredMenu.querySelector('[data-purge]'), 'retired card can be deleted permanently')
			assert.equal(retiredMenu.querySelector('[data-remove]'), null)
			retiredMenu.querySelector('[data-restore]').click()
			await tick()
			const restored = root.querySelector('#supInventoryGrid [data-item-id="2"]')
			assert.ok(restored)
			assert.equal(restored.classList.contains('is-archived'), false)
			const restoredMenu = openItemMenu(root, 2)
			assert.ok(restoredMenu.querySelector('[data-remove]'))
			const patches = fetches.filter((f) => f.method === 'PATCH')
			assert.equal(patches.length, 1)
			assert.deepEqual(JSON.parse(patches[0].body), { active: 1 })
			assert.match(root.querySelector('#supToast').textContent, /Supply restored/)
			restoredMenu.querySelector('[data-remove]').click()
			await tick()
			const again = root.querySelector('#supInventoryGrid [data-item-id="2"]')
			assert.ok(again, 'retired card stays visible while Show retired is on')
			const purgeMenu = openItemMenu(root, 2)
			assert.ok(purgeMenu.querySelector('[data-purge]'))
			purgeMenu.querySelector('[data-purge]').click()
			await tick()
			const purges = fetches.filter((f) => f.method === 'DELETE' && f.search.includes('purge=1'))
			assert.equal(purges.length, 1)
			assert.equal(root.querySelector('#supInventoryGrid [data-item-id="2"]'), null)
			assert.match(root.querySelector('#supToast').textContent, /Supply deleted/)
		}),
		testAsync('catalog modal remove retires the open supply', async () => {
			const { dom, api, fetches } = mountDom({ role: 'owner' })
			api.mount()
			await api.load()
			const root = dom.window.document.getElementById('suppliesRoot')
			dom.window.confirm = () => true
			openItemMenu(root, 1).querySelector('[data-edit]').click()
			const archive = dom.window.document.getElementById('supCatalogArchive')
			assert.equal(archive.hidden, false)
			assert.equal(dom.window.document.getElementById('supCatalogRestore').hidden, true)
			archive.click()
			await tick()
			assert.equal(fetches.filter((f) => f.method === 'DELETE').length, 1)
			assert.equal(dom.window.document.getElementById('supCatalogModal').hasAttribute('open'), false)
		}),
		testAsync('restock records the price paid and shows a live total', async () => {
			const { dom, api, fetches, items } = mountDom({ role: 'packer' })
			api.mount()
			await api.load()
			const root = dom.window.document.getElementById('suppliesRoot')
			root.querySelector('[data-restock]').click()
			const qty = dom.window.document.getElementById('supRestockQty')
			const cost = dom.window.document.getElementById('supRestockCost')
			const total = dom.window.document.getElementById('supRestockTotal')
			assert.equal(cost.value, '0.8')
			qty.value = '10'
			qty.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
			assert.match(total.textContent, /8/)
			cost.value = '2.5'
			cost.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
			assert.match(total.textContent, /25/)
			dom.window.document.getElementById('supRestockCurrency').value = 'CNY'
			dom.window.document.querySelector('#supRestockForm button[type="submit"]').click()
			await tick()
			const recv = fetches.filter((f) => f.method === 'POST' && f.url === '/api/supplies/receive')
			assert.equal(recv.length, 1)
			assert.deepEqual(JSON.parse(recv[0].body), {
				item_id: 1,
				qty: 10,
				unit_cost: 2.5,
				currency: 'CNY',
			})
			assert.equal(items[0].qty_on_hand, 14)
			assert.equal(items[0].unit_cost, 2.5)
			assert.equal(items[0].currency, 'CNY')
		}),
		testAsync('owner activity totals restock cost for a period', async () => {
			const { dom, api, fetches } = mountDom({ role: 'owner' })
			api.mount()
			await api.load()
			const root = dom.window.document.getElementById('suppliesRoot')
			root.querySelector('.sup-tab[data-sup-view="log"]').click()
			await tick()
			const panel = root.querySelector('#supSpendPanel')
			assert.equal(panel.hidden, false)
			assert.match(panel.textContent, /Purchase cost/)
			assert.ok(fetches.some((f) => f.url === '/api/supplies/spend'))
			assert.match(root.querySelector('#supSpendSummary').textContent, /12\.5/)
			assert.match(root.querySelector('#supSpendList').textContent, /Pink Mailer Box/)
			assert.ok(root.querySelector('#supSpendList a.sup-buy-open'))
		}),
		testAsync('employees do not load purchase-cost totals', async () => {
			const { dom, api, fetches } = mountDom({ role: 'packer' })
			api.mount()
			await api.load()
			const root = dom.window.document.getElementById('suppliesRoot')
			root.querySelector('.sup-tab[data-sup-view="log"]').click()
			await tick()
			assert.equal(root.querySelector('#supSpendPanel').hidden, true)
			assert.equal(
				fetches.some((f) => f.url === '/api/supplies/spend'),
				false,
			)
		}),
		testAsync('phone buy links stay in-tab so shop apps can open', async () => {
			const { dom, api } = mountDom({ role: 'packer' })
			dom.window.matchMedia = (query) => ({
				matches: String(query).includes('pointer: coarse') && String(query).includes('hover: none'),
				media: query,
				addListener() {},
				removeListener() {},
				addEventListener() {},
				removeEventListener() {},
				dispatchEvent() {
					return false
				},
			})
			api.mount()
			await api.load()
			const root = dom.window.document.getElementById('suppliesRoot')
			const overlay = root.querySelector('#supInventoryGrid .sup-buy-overlay')
			assert.ok(overlay, 'photo overlay is the phone Buy control')
			assert.equal(overlay.getAttribute('href'), 'https://www.uline.com/example')
			assert.equal(overlay.getAttribute('target'), null)
			const textLink = root.querySelector('#supInventoryGrid a.sup-link.sup-buy-open')
			assert.ok(textLink)
			assert.equal(textLink.getAttribute('target'), null)
			assert.doesNotMatch(textLink.textContent, /↗/)
			root.querySelector('[data-restock]').click()
			const restockBuy = dom.window.document.querySelector('#supRestockBuy a.sup-buy-open')
			assert.ok(restockBuy)
			assert.equal(restockBuy.getAttribute('target'), null)
			assert.equal(restockBuy.getAttribute('href'), 'https://www.uline.com/example')
		}),
	])
}

function fireKey(el, key) {
	const win = el.ownerDocument.defaultView
	el.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

function openItemMenu(root, itemId) {
	const card = root.querySelector(`[data-item-id="${itemId}"]`)
	assert.ok(card, `card ${itemId} is on screen`)
	const toggle = card.querySelector('[data-menu]')
	assert.ok(toggle, `menu toggle for item ${itemId}`)
	const menu = root.querySelector('#supCardMenu')
	const alreadyOpen = toggle.getAttribute('aria-expanded') === 'true' && menu && !menu.hidden
	if (!alreadyOpen) toggle.click()
	const open = root.querySelector('#supCardMenu')
	assert.ok(open && !open.hidden, 'overflow menu is open')
	return open
}

function tick(ms = 20) {
	return new Promise((r) => setTimeout(r, ms))
}

function jsonResponse(status, body) {
	return {
		ok: status >= 200 && status < 300,
		status,
		text: async () => JSON.stringify(body),
	}
}

function applyReceive(items, body) {
	const item = items.find((row) => row.id === Number(body.item_id))
	if (!item || !item.active) return jsonResponse(404, { error: 'Item not found or inactive' })
	const qty = Number(body.qty)
	if (!Number.isFinite(qty) || qty <= 0) return jsonResponse(400, { error: 'qty must be a positive number' })
	item.qty_on_hand = Math.round((Number(item.qty_on_hand) + qty) * 1000) / 1000
	const explicit = body.unit_cost !== undefined && body.unit_cost !== null && body.unit_cost !== ''
	const unit = explicit ? Number(body.unit_cost) : item.unit_cost == null ? null : Number(item.unit_cost)
	if (explicit && Number.isFinite(unit)) {
		item.unit_cost = unit
		if (body.currency) item.currency = body.currency
	}
	item.needs_purchase = 0
	item.needs_purchase_at = null
	item.needs_purchase_by = null
	const costTotal = unit == null || !Number.isFinite(Number(unit)) ? null : Math.round(Number(unit) * qty * 100) / 100
	return jsonResponse(201, {
		movement: {
			itemId: item.id,
			kind: 'receive',
			qtyDelta: qty,
			unit_cost: unit,
			cost_total: costTotal,
			currency: body.currency || item.currency || 'USD',
		},
		item: { ...item },
	})
}

function applyItemPatch(items, id, body) {
	const item = items.find((row) => row.id === id)
	if (!item) return jsonResponse(404, { error: 'Item not found' })
	const taken = (value) =>
		items.some((row) => row.id !== id && row.active !== 0 && (row.name === value || row.name_zh === value))
	if (Object.prototype.hasOwnProperty.call(body, 'name')) {
		const name = String(body.name || '').replace(/\s+/g, ' ').trim()
		if (!name) return jsonResponse(400, { error: 'Name is required' })
		if (name.length > 120) return jsonResponse(400, { error: 'Name is too long' })
		if (taken(name)) return jsonResponse(409, { error: 'A supply with this name already exists' })
		item.name = name
	}
	if (Object.prototype.hasOwnProperty.call(body, 'name_zh')) {
		const nameZh = String(body.name_zh || '').replace(/\s+/g, ' ').trim() || null
		if (nameZh && nameZh.length > 120) return jsonResponse(400, { error: 'Name is too long' })
		if (nameZh && taken(nameZh)) return jsonResponse(409, { error: 'A supply with this name already exists' })
		item.name_zh = nameZh
	}
	if (Object.prototype.hasOwnProperty.call(body, 'active')) {
		item.active = body.active === true || body.active === 1 || body.active === '1' ? 1 : 0
	}
	if (body.photo_data) {
		item.photo_file = `${item.sku}.webp`
		item.photo_path = `/api/supplies/photos/${item.sku}.webp`
		item.photo_thumb = `${item.photo_path}?w=240`
		item.photo_detail = `${item.photo_path}?w=480`
	}
	return jsonResponse(200, { item: { ...item } })
}

function applyItemCreate(items, body, countSession) {
	const name = String(body.name || '').replace(/\s+/g, ' ').trim()
	if (!name) return jsonResponse(400, { error: 'Name is required' })
	if (items.some((row) => row.active !== 0 && (row.name === name || row.name_zh === name))) {
		return jsonResponse(409, { error: 'A supply with this name already exists' })
	}
	const nextId = items.reduce((max, row) => Math.max(max, row.id), 0) + 1
	const categorySlug = body.category_slug || 'boxes'
	const categoryName = { boxes: 'Boxes', tape: 'Tape', stickers: 'Stickers' }[categorySlug] || 'Boxes'
	const item = {
		id: nextId,
		sku: `SKU-${nextId}`,
		name,
		name_zh: body.name_zh || null,
		category_slug: categorySlug,
		category_name: categoryName,
		family: body.family || null,
		family_name: null,
		uom: body.uom || 'each',
		qty_on_hand: 0,
		reorder_point: Number(body.reorder_point) || 0,
		reorder_qty: Number(body.reorder_qty) || 0,
		is_low: 0,
		active: 1,
		unit_cost: body.unit_cost ?? null,
		currency: body.currency || 'USD',
		supplier_name: body.supplier_name || null,
		supplier_url: body.supplier_url || null,
		photo_file: body.photo_data ? `SKU-${nextId}.webp` : null,
		photo_path: body.photo_data ? `/api/supplies/photos/SKU-${nextId}.webp` : null,
		photo_thumb: body.photo_data ? `/api/supplies/photos/SKU-${nextId}.webp?w=240` : null,
		photo_detail: body.photo_data ? `/api/supplies/photos/SKU-${nextId}.webp?w=480` : null,
	}
	items.push(item)
	if (countSession && Array.isArray(countSession.lines)) {
		countSession.lines.push({
			...item,
			item_id: item.id,
			expected_qty: 0,
			counted_qty: null,
			variance: 0,
		})
		const counted = countSession.lines.filter((line) => line.counted_qty != null).length
		countSession.progress = {
			total: countSession.lines.length,
			counted,
			remaining: countSession.lines.length - counted,
			variance_count: countSession.lines.filter((line) => line.counted_qty != null && Number(line.variance) !== 0).length,
		}
	}
	return jsonResponse(201, { item: { ...item } })
}

function applyItemDelete(items, id, { purge = false } = {}) {
	const index = items.findIndex((row) => row.id === id)
	if (index < 0) return jsonResponse(404, { error: 'Item not found' })
	const item = items[index]
	if (purge) {
		if (item.active) return jsonResponse(409, { error: 'Retire this supply before deleting it permanently' })
		items.splice(index, 1)
		return jsonResponse(200, { deleted: true, archived: false, item: null })
	}
	item.active = 0
	return jsonResponse(200, { item: { ...item }, archived: true, deleted: false })
}

function applyCountLines(session, body) {
	if (!session) return jsonResponse(404, { error: 'Count session not found' })
	const rows = Array.isArray(body.lines) ? body.lines : [body]
	for (const row of rows) {
		const line = session.lines.find((entry) => entry.item_id === Number(row.item_id))
		if (!line) continue
		if (row.counted_qty === null || row.counted_qty === '' || row.counted_qty === undefined) {
			line.counted_qty = null
			line.variance = 0
		} else {
			line.counted_qty = Number(row.counted_qty)
			line.variance = Math.round((line.counted_qty - Number(line.expected_qty)) * 1000) / 1000
		}
	}
	const counted = session.lines.filter((line) => line.counted_qty != null).length
	session.progress = {
		total: session.lines.length,
		counted,
		remaining: session.lines.length - counted,
		variance_count: session.lines.filter((line) => line.counted_qty != null && Number(line.variance) !== 0).length,
	}
	return jsonResponse(200, { session })
}

function applyNeedsPurchase(items, session, id, body) {
	const item = items.find((row) => row.id === id)
	if (!item) return jsonResponse(404, { error: 'Item not found or inactive' })
	const needed = body.needed !== false && body.needed !== 0 && body.needed !== '0'
	item.needs_purchase = needed ? 1 : 0
	item.needs_purchase_at = needed ? '2026-09-15 00:00:00' : null
	item.needs_purchase_by = needed ? 'mei' : null
	if (session && Array.isArray(session.lines)) {
		const line = session.lines.find((entry) => entry.item_id === id)
		if (line) {
			line.needs_purchase = item.needs_purchase
			line.needs_purchase_at = item.needs_purchase_at
			line.needs_purchase_by = item.needs_purchase_by
		}
	}
	return jsonResponse(200, { item: { ...item } })
}

function applyMarkPurchased(items, session, id) {
	const item = items.find((row) => row.id === id)
	if (!item) return jsonResponse(404, { error: 'Item not found or inactive' })
	item.needs_purchase = 0
	item.needs_purchase_at = null
	item.needs_purchase_by = null
	item.purchased_at = '2026-09-17 00:00:00'
	item.purchased_by = 'walter'
	if (session && Array.isArray(session.lines)) {
		const line = session.lines.find((entry) => entry.item_id === id)
		if (line) {
			line.needs_purchase = 0
			line.needs_purchase_at = null
			line.needs_purchase_by = null
			line.purchased_at = item.purchased_at
			line.purchased_by = item.purchased_by
		}
	}
	return jsonResponse(200, { item: { ...item } })
}

run()
	.then(() => {
		if (failed) {
			console.error(`\n${failed} assertion(s) FAILED`)
			process.exit(1)
		}
		console.log(`\n${passed} assertion(s) passed.`)
	})
	.catch((err) => {
		console.error(err)
		process.exit(1)
	})

function fixtureItems() {
	return [
		{
			id: 1,
			sku: 'BOX-PINK-MAILER-S',
			name: 'Pink Mailer Box (Small)',
			name_zh: '粉色纸箱（小）',
			category_slug: 'boxes',
			category_name: 'Boxes',
			uom: 'each',
			qty_on_hand: 4,
			reorder_point: 20,
			reorder_qty: 100,
			is_low: 1,
			active: 1,
			unit_cost: 0.8,
			currency: 'USD',
			supplier_name: 'Uline',
			supplier_url: 'https://www.uline.com/example',
			photo_file: 'BOX-PINK-MAILER-S.webp',
			photo_path: '/api/supplies/photos/BOX-PINK-MAILER-S.webp',
			photo_thumb: '/api/supplies/photos/BOX-PINK-MAILER-S.webp?w=240',
			photo_detail: '/api/supplies/photos/BOX-PINK-MAILER-S.webp?w=480',
		},
		{
			id: 2,
			sku: 'TAP-PINK-PACKING',
			name: 'Pink Packing Tape',
			name_zh: '粉色打包胶带',
			category_slug: 'tape',
			category_name: 'Tape',
			uom: 'roll',
			qty_on_hand: 8,
			reorder_point: 2,
			reorder_qty: 6,
			is_low: 0,
			active: 1,
			unit_cost: 2.5,
			currency: 'USD',
			supplier_name: null,
			supplier_url: null,
			photo_file: 'TAP-PINK-PACKING.webp',
			photo_path: '/api/supplies/photos/TAP-PINK-PACKING.webp',
			photo_thumb: '/api/supplies/photos/TAP-PINK-PACKING.webp?w=240',
			photo_detail: '/api/supplies/photos/TAP-PINK-PACKING.webp?w=480',
		},
		{
			id: 3,
			sku: 'STK-HELLO-KITTY-ROLL',
			name: 'Hello Kitty Sticker Roll',
			name_zh: '凯蒂猫贴纸卷',
			category_slug: 'stickers',
			category_name: 'Stickers',
			family: 'hello_kitty',
			family_name: 'Hello Kitty',
			uom: 'roll',
			qty_on_hand: 2,
			reorder_point: 1,
			reorder_qty: 2,
			is_low: 0,
			active: 1,
			unit_cost: null,
			currency: 'USD',
			supplier_name: null,
			supplier_url: null,
			photo_file: 'STK-HELLO-KITTY-ROLL.webp',
			photo_path: '/api/supplies/photos/STK-HELLO-KITTY-ROLL.webp',
			photo_thumb: '/api/supplies/photos/STK-HELLO-KITTY-ROLL.webp?w=240',
			photo_detail: '/api/supplies/photos/STK-HELLO-KITTY-ROLL.webp?w=480',
		},
		{
			id: 4,
			sku: 'STK-MYMELODY-SQUARE-ROLL',
			name: 'Hello Kitty Ice Cream Sticker Roll',
			name_zh: '凯蒂猫冰淇淋贴纸卷',
			category_slug: 'stickers',
			category_name: 'Stickers',
			family: 'hello_kitty',
			family_name: 'Hello Kitty',
			uom: 'roll',
			qty_on_hand: 1,
			reorder_point: 1,
			reorder_qty: 2,
			is_low: 0,
			active: 1,
			unit_cost: null,
			currency: 'USD',
			supplier_name: null,
			supplier_url: null,
			photo_file: 'STK-MYMELODY-SQUARE-ROLL.webp',
			photo_path: '/api/supplies/photos/STK-MYMELODY-SQUARE-ROLL.webp',
			photo_thumb: '/api/supplies/photos/STK-MYMELODY-SQUARE-ROLL.webp?w=240',
			photo_detail: '/api/supplies/photos/STK-MYMELODY-SQUARE-ROLL.webp?w=480',
		},
		{
			id: 5,
			sku: 'STK-KUROMI-ROLL',
			name: 'Kuromi Sticker Roll',
			name_zh: '库洛米贴纸卷',
			category_slug: 'stickers',
			category_name: 'Stickers',
			family: 'kuromi',
			family_name: 'Kuromi',
			uom: 'roll',
			qty_on_hand: 3,
			reorder_point: 1,
			reorder_qty: 2,
			is_low: 0,
			active: 1,
			unit_cost: null,
			currency: 'USD',
			supplier_name: null,
			supplier_url: null,
			photo_file: 'STK-KUROMI-ROLL.webp',
			photo_path: '/api/supplies/photos/STK-KUROMI-ROLL.webp',
			photo_thumb: '/api/supplies/photos/STK-KUROMI-ROLL.webp?w=240',
			photo_detail: '/api/supplies/photos/STK-KUROMI-ROLL.webp?w=480',
		},
		{
			id: 6,
			sku: 'BOX-LAVENDER-MAILER',
			name: 'Lavender Mailer Box',
			name_zh: '薰衣草纸箱',
			category_slug: 'boxes',
			category_name: 'Boxes',
			uom: 'each',
			qty_on_hand: 0,
			reorder_point: 0,
			reorder_qty: 0,
			is_low: 0,
			active: 1,
			unit_cost: 0.7,
			currency: 'USD',
			supplier_name: null,
			supplier_url: null,
			photo_file: 'BOX-LAVENDER-MAILER.webp',
			photo_path: '/api/supplies/photos/BOX-LAVENDER-MAILER.webp',
			photo_thumb: '/api/supplies/photos/BOX-LAVENDER-MAILER.webp?w=240',
			photo_detail: '/api/supplies/photos/BOX-LAVENDER-MAILER.webp?w=480',
		},
	]
}

function mockFetch(routes) {
	return async (url) => {
		const abs = new URL(String(url), 'http://127.0.0.1/')
		const hit = routes[abs.pathname] || routes[url]
		if (!hit) {
			return {
				ok: false,
				status: 404,
				text: async () => JSON.stringify({ error: `unmocked ${url}` }),
			}
		}
		const body = typeof hit === 'function' ? hit(abs.pathname + abs.search) : hit
		return {
			ok: true,
			status: 200,
			text: async () => JSON.stringify(body),
		}
	}
}

function mountDom({ role = 'owner', lang = 'en', counting = false } = {}) {
	const virtualConsole = new VirtualConsole()
	virtualConsole.on('jsdomError', (err) => {
		if (String(err.message || err).includes('Not implemented: navigation')) return
		if (String(err.message || err).includes('Not implemented: HTMLDialogElement')) return
	})
	const dom = new JSDOM(
		`<!doctype html><html><body>
			<nav class="tabs"><button type="button" class="tab" data-tab="supplies">Supplies</button></nav>
			<div id="tab-supplies"><div id="suppliesRoot"></div></div>
		</body></html>`,
		{ url: 'http://127.0.0.1/', pretendToBeVisual: true, virtualConsole },
	)
	const dialogProto = dom.window.HTMLDialogElement && dom.window.HTMLDialogElement.prototype
	if (dialogProto) {
		dialogProto.showModal = function showModal() {
			this.setAttribute('open', '')
		}
		dialogProto.close = function close() {
			this.removeAttribute('open')
		}
	}
	if (lang === 'zh') dom.window.I18N = loadDashboardI18n()
	dom.window.__AUTH = { role, capabilities: role === 'owner' ? ['*'] : ['supplies:manage'] }
	dom.window.ROLE = { can: (cap) => role === 'owner' || cap === 'supplies:manage' }
	const items = fixtureItems()
	const fetches = []
	const countSession = counting
		? {
				id: 9,
				status: 'open',
				progress: { counted: 0, total: items.length, remaining: items.length, variance_count: 0 },
				lines: items.map((item) => ({
					...item,
					item_id: item.id,
					expected_qty: item.qty_on_hand,
					counted_qty: null,
					variance: 0,
				})),
			}
		: null
	const sessionHolder = { session: countSession }
	const baseFetch = mockFetch({
		'/api/supplies/categories': {
			categories: [
				{ slug: 'boxes', name: 'Boxes' },
				{ slug: 'tape', name: 'Tape' },
				{ slug: 'stickers', name: 'Stickers' },
			],
			families: {
				stickers: [
					{ slug: 'hello_kitty', name: 'Hello Kitty' },
					{ slug: 'kuromi', name: 'Kuromi' },
					{ slug: 'cinnamoroll', name: 'Cinnamoroll' },
					{ slug: 'my_melody', name: 'My Melody' },
					{ slug: 'miffy', name: 'Miffy' },
					{ slug: 'mametchi', name: 'Mametchi' },
					{ slug: 'other', name: 'Other stickers' },
				],
			},
		},
		'/api/supplies/items': (url) => {
			const abs = new URL(String(url), 'http://127.0.0.1/')
			const active = abs.searchParams.get('active')
			let list = items
			if (active === '0') list = items.filter((item) => !item.active)
			else if (active !== 'all') list = items.filter((item) => item.active)
			return { items: list }
		},
		'/api/supplies/alerts': () => ({
			low_stock: items.filter((item) => item.is_low && item.active),
			low_stock_count: items.filter((item) => item.is_low && item.active).length,
			needs_purchase: items.filter((item) => item.needs_purchase && item.active),
			needs_purchase_count: items.filter((item) => item.needs_purchase && item.active).length,
			open_count: null,
			days_since_count: 0,
		}),
		'/api/supplies/counts/current': () => ({ session: sessionHolder.session }),
		'/api/supplies/counts': { sessions: [] },
		'/api/supplies/movements': { movements: [] },
		'/api/supplies/spend': () => ({
			from: '2026-09-01 00:00:00',
			to: '2026-10-01 00:00:00',
			totals: [{ currency: 'USD', amount: 12.5, qty: 10, receives: 1 }],
			lines: [
				{
					id: 11,
					item_id: 1,
					qty: 10,
					unit_cost: 1.25,
					cost_total: 12.5,
					currency: 'USD',
					created_at: '2026-09-10 08:00:00',
					actor: 'walter',
					note: 'Taobao',
					sku: 'BOX-PINK-MAILER-S',
					item_name: 'Pink Mailer Box (Small)',
					item_name_zh: '粉色纸箱（小）',
					uom: 'each',
					supplier_name: 'Uline',
					supplier_url: 'https://www.uline.com/example',
				},
			],
			receive_count: 1,
		}),
	})
	dom.window.fetch = async (url, options = {}) => {
		const abs = new URL(String(url), 'http://127.0.0.1/')
		const method = String(options.method || 'GET').toUpperCase()
		fetches.push({ method, url: abs.pathname, search: abs.search || '', body: options.body || null })
		if (method === 'PUT' && /^\/api\/supplies\/counts\/\d+\/lines$/.test(abs.pathname)) {
			let body = {}
			if (options.body) {
				body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body
			}
			return applyCountLines(sessionHolder.session, body)
		}
		if (method === 'POST' && /^\/api\/supplies\/counts\/\d+\/submit$/.test(abs.pathname)) {
			sessionHolder.session = null
			return jsonResponse(200, { movements: [] })
		}
		if (method === 'POST' && /^\/api\/supplies\/counts\/\d+\/cancel$/.test(abs.pathname)) {
			sessionHolder.session = null
			return jsonResponse(200, { ok: true })
		}
		if (method === 'POST' && /^\/api\/supplies\/items\/\d+\/needs-purchase$/.test(abs.pathname)) {
			const id = Number(abs.pathname.split('/')[4])
			let body = {}
			if (options.body) {
				body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body
			}
			return applyNeedsPurchase(items, sessionHolder.session, id, body)
		}
		if (method === 'POST' && /^\/api\/supplies\/items\/\d+\/purchased$/.test(abs.pathname)) {
			const id = Number(abs.pathname.split('/')[4])
			return applyMarkPurchased(items, sessionHolder.session, id)
		}
		if (method === 'PATCH' && /^\/api\/supplies\/items\/\d+$/.test(abs.pathname)) {
			const id = Number(abs.pathname.split('/').pop())
			let body = {}
			if (options.body) {
				body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body
			}
			return applyItemPatch(items, id, body)
		}
		if (method === 'POST' && abs.pathname === '/api/supplies/items') {
			let body = {}
			if (options.body) {
				body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body
			}
			return applyItemCreate(items, body, countSession)
		}
		if (method === 'DELETE' && /^\/api\/supplies\/items\/\d+$/.test(abs.pathname)) {
			const id = Number(abs.pathname.split('/').pop())
			return applyItemDelete(items, id, { purge: abs.searchParams.get('purge') === '1' })
		}
		if (method === 'POST' && abs.pathname === '/api/supplies/receive') {
			let body = {}
			if (options.body) {
				body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body
			}
			return applyReceive(items, body)
		}
		return baseFetch(url, options)
	}
	const api = createSupplies(dom.window)
	return { dom, api, fetches, items }
}

function loadDashboardI18n() {
	const dictStart = HTML.indexOf('const I18N_DICT = {')
	const dictEnd = HTML.indexOf('const I18N_SUPPLY_UOM', dictStart)
	assert.ok(dictStart >= 0 && dictEnd > dictStart, 'I18N_DICT must exist')
	const dictLiteral = HTML.slice(HTML.indexOf('{', dictStart), HTML.lastIndexOf('}', dictEnd) + 1)
	const dict = new Function(`return (${dictLiteral})`)()
	const uomStart = HTML.indexOf('const I18N_SUPPLY_UOM = {', dictEnd)
	const uomEnd = HTML.indexOf('const I18N_PATTERNS', uomStart)
	const uomLiteral = HTML.slice(HTML.indexOf('{', uomStart), HTML.lastIndexOf('}', uomEnd) + 1)
	const I18N_SUPPLY_UOM = new Function(`return (${uomLiteral})`)()
	const patStart = HTML.indexOf('const I18N_PATTERNS = [', uomEnd)
	const patEnd = HTML.indexOf('const I18N = (() => {', patStart)
	assert.ok(patStart >= 0 && patEnd > patStart, 'I18N_PATTERNS must exist')
	const patternsLiteral = HTML.slice(HTML.indexOf('[', patStart), HTML.lastIndexOf(']', patEnd) + 1)
	const patterns = new Function('I18N_SUPPLY_UOM', `return (${patternsLiteral})`)(I18N_SUPPLY_UOM)
	return {
		get: () => 'zh',
		t(s) {
			if (s == null || s === '') return s
			const raw = String(s)
			const trimmed = raw.trim()
			let zh = dict[trimmed]
			if (zh == null) {
				for (const p of patterns) {
					const m = trimmed.match(p.re)
					if (m) {
						zh = p.zh(m)
						break
					}
				}
			}
			if (zh == null || zh === trimmed) return raw
			return raw.replace(trimmed, zh)
		},
	}
}
