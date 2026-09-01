'use strict'

/**
 * One-shot migration: strip decorative emoji from operator-facing UI copy.
 * Keeps typographic symbols (✓ × + ← →) where they are standard UI affordances.
 *
 * Run: node scripts/strip-ui-emojis.js
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const FILES = ['public/index.html', 'public/shop.html', 'public/sourcing.html'].map((f) => path.join(ROOT, f))

/** Longest-first exact string replacements (English + mirrored Chinese values). */
const PAIRS = [
	// ── Top bar & mode toggles ───────────────────────────────────────────
	['👁 Preview Packing Mode', 'Preview Packing Mode'],
	['👁 预览打包模式', '预览打包模式'],
	['✅ Exit Packing Mode', 'Exit Packing Mode'],
	['✅ 退出打包模式', '退出打包模式'],
	['📦 Packing Mode', 'Packing Mode'],
	['📦 打包模式', '打包模式'],
	['🛒 Shopping Mode', 'Shopping Mode'],
	['🗂️ Sourcing', 'Sourcing'],
	['🗂️ 货源库', '货源库'],
	['👥 Team', 'Team'],
	['👥 团队', '团队'],
	['📋 Activity log', 'Activity log'],
	['📋 Activity', 'Activity'],
	['📋 操作记录', '操作记录'],
	['🚪 Log out', 'Log out'],
	['🚪 退出登录', '退出登录'],
	['🚪 <span data-i18n="logout">Log out</span>', '<span data-i18n="logout">Log out</span>'],

	// ── Packer queues ────────────────────────────────────────────────────
	['🔎 Verify purchases', 'Verify purchases'],
	['📦 To pack &amp; ship', 'To pack &amp; ship'],
	['📦 To pack & ship', 'To pack & ship'],
	['📦 待打包发货', '待打包发货'],
	['✅ Recently packaged', 'Recently packaged'],
	['✅ 最近已打包', '最近已打包'],
	['🛒 Need to purchase', 'Need to purchase'],
	['🛒 待采购', '待采购'],
	['✨ Charms to buy', 'Charms to buy'],
	['✨ 待购吊饰', '待购吊饰'],
	['🛒 To buy', 'To buy'],

	// ── Order / fulfilment actions ───────────────────────────────────────
	['📦 Mark packaged', 'Mark packaged'],
	['📦 标记已打包', '标记已打包'],
	['📦 Ship with 4PX', 'Ship with 4PX'],
	['📦 用 4PX 发货', '用 4PX 发货'],
	['📦 View shipment', 'View shipment'],
	['📦 查看运单', '查看运单'],
	['📦 Create Shipment', 'Create Shipment'],
	['🛒 Mark needs purchase', 'Mark needs purchase'],
	['🛒 标记需采购', '标记需采购'],
	['↻ Recreate 4PX shipment', 'Recreate 4PX shipment'],

	// ── Sync / refresh prefixes (label already names the action) ─────────
	['↻ Backfill all orders', 'Backfill all orders'],
	['↻ 回补全部订单', '回补全部订单'],
	['↻ Backfilling…', 'Backfilling…'],
	['↻ Sync earnings', 'Sync earnings'],
	['↻ 同步收益', '同步收益'],
	['↻ Syncing…', 'Syncing…'],
	['↻ Sync listings', 'Sync listings'],
	['↻ 同步商品', '同步商品'],
	['↻ Sync inventory', 'Sync inventory'],
	['↻ 同步库存', '同步库存'],
	['↻ Sync from Etsy', 'Sync from Etsy'],
	['↻ Refresh', 'Refresh'],
	['↻ 刷新', '刷新'],
	['↻ Restock', 'Restock'],
	['<span aria-hidden="true">↻</span> Update due parcels', 'Update due parcels'],
	['<span aria-hidden="true">↻</span> Reload view', 'Reload view'],
	['<span class="sl-spin">↻</span> Sync all shops', '<span class="sl-spin">⟳</span> Sync all shops'],

	// ── Bulk listings ────────────────────────────────────────────────────
	['💲 Edit all prices', 'Edit all prices'],
	['📤 Create Etsy drafts', 'Create Etsy drafts'],
	['🚀 Publish all drafts', 'Publish all drafts'],
	['🚀 Publish to Etsy', 'Publish to Etsy'],
	['📱 Set iPhone models ▾', 'Set iPhone models ▾'],
	['🚫 Exclude', 'Exclude'],
	['🗑 Delete', 'Delete'],

	// ── Route tab ────────────────────────────────────────────────────────
	['📥 Sync purchase status…', 'Sync purchase status…'],
	['📂 Open files', 'Open files'],
	['⚡ Generate Shopping Route', 'Generate Shopping Route'],
	['📦 From product catalog', 'From product catalog'],
	['📦 从商品目录', '从商品目录'],
	['✚ Custom product', 'Custom product'],
	['✚ 自定义商品', '自定义商品'],
	['🧾 This order', 'This order'],
	['🧾 本订单', '本订单'],
	['Product Catalog', 'Product Catalog'],
	['<span class="ra-ic">✨</span><span class="ra-label">Charms to buy</span>', '<span class="ra-label">Charms to buy</span>'],
	['<span class="ra-ic">＋</span><span class="ra-label">Add Order</span>', '<span class="ra-label">Add Order</span>'],
	['<span class="ra-ic">📋</span><span class="ra-label">Product Catalog</span>', '<span class="ra-label">Product Catalog</span>'],
	['<span class="ra-ic">⬇</span><span class="ra-label">Export images</span>', '<span class="ra-label">Export images</span>'],
	['<span class="ra-ic">↻</span>', ''],

	// ── Pickup bar ───────────────────────────────────────────────────────
	['🚚 <span>Book 4PX pickup</span>', '<span>Book 4PX pickup</span>'],
	['🖨 Print form', 'Print form'],
	['🖨 Print', 'Print'],
	['🖨 Printing…', 'Printing…'],
	['🚚 4PX collecting ', '4PX collecting '],

	// ── Badges & status copy ─────────────────────────────────────────────
	['🔄 Switched', 'Switched'],
	['🔄 Change design', 'Change design'],
	['🔄 Switch this order', 'Switch this order'],
	['🔄 Switch to a new design', 'Switch to a new design'],
	['🔄 Order switched — now in your purchasing queue', 'Order switched — now in your purchasing queue'],
	['🛒 Buy new model', 'Buy new model'],
	['🔁 Wrong generation', 'Wrong generation'],
	['🔁 Wrong model', 'Wrong model'],
	['🔁 Exchange', 'Exchange'],
	['🔁 to swap', 'to swap'],
	['🛒 to buy', 'to buy'],
	['✅ bought', 'bought'],
	['✅ swapped', 'swapped'],

	// ── Hints & toasts (leading emoji only) ──────────────────────────────
	['🛒 These orders still need products bought.', 'These orders still need products bought.'],
	['🛒 这些订单还有商品需要采购。', '这些订单还有商品需要采购。'],
	['🔎 Check yesterday’s shopping against each order.', 'Check yesterday’s shopping against each order.'],
	['👉 Ready to pack — every item here has been verified in hand.', 'Ready to pack — every item here has been verified in hand.'],
	['👉 These are ready to pack.', 'These are ready to pack.'],
	['👉 这些订单可以打包了。', '这些订单可以打包了。'],
	['📋 Message copied', 'Message copied'],
	['📦 Order marked as packaged', 'Order marked as packaged'],
	['📷 Variant image updated — showing everywhere', 'Variant image updated — showing everywhere'],
	['✨ Regenerating…', 'Regenerating…'],
	['✨ Generating…', 'Generating…'],
	['✨ Message drafted — review, then copy', 'Message drafted — review, then copy'],
	['🛒 Updated — buy the corrected model', 'Updated — buy the corrected model'],
	['🔁 Updated — swap it at the supplier', 'Updated — swap it at the supplier'],
	['🛒 Flagged to buy the correct model & held out of the normal buy list', 'Flagged to buy the correct model & held out of the normal buy list'],
	['🔁 Flagged to swap & held out of buying', 'Flagged to swap & held out of buying'],
	['⚠ Could not run ship recovery:', 'Could not run ship recovery:'],
	['⚠ ', 'Note: '],
	['⬇ Download all labels (ZIP)', 'Download all labels (ZIP)'],
	['⬇ 下载全部面单（ZIP）', '下载全部面单（ZIP）'],
	['⬇ Export CSV', 'Export CSV'],
	['⬇ 导出 CSV', '导出 CSV'],

	// ── Modal / misc titles ──────────────────────────────────────────────
	['📋 Copy details for 4PX claim', 'Copy details for 4PX claim'],
	['📋 Copy details for 4PX complaint', 'Copy details for 4PX complaint'],
	['✎ Apply & regenerate copy', 'Apply & regenerate copy'],
	['✎ <span data-i18n="edit">Edit</span>', '<span data-i18n="edit">Edit</span>'],
	['🗑 <span data-i18n="delete">Delete</span>', '<span data-i18n="delete">Delete</span>'],

	// ── Placeholders (image failed / missing) ────────────────────────────
	["textContent:'🛍️'", "textContent:'—'"],
	["textContent:'📦'", "textContent:'—'"],
	['>🛍️<', '>—<'],
	['>📦<', '>—<'],
	['>🖼️<', '>—<'],
	['>🖼<', '>—<'],
	["document.createTextNode('🛍️')", "document.createTextNode('—')"],

	// ── Close affordance: emoji × → typographic × ───────────────────────
	['✕ Cancel pickup', 'Cancel pickup'],
	['✕ Cancelled', 'Cancelled'],
	['✕ Clear', 'Clear'],
	['✕ Unmark packaged', 'Unmark packaged'],
	['✕ 取消已打包', '取消已打包'],
	['✕ Cancel', 'Cancel'],
	['✕', '×'],

	// ── Decorative icon spans to remove ──────────────────────────────────
	['<span class="dlb-icon" aria-hidden="true">⏱</span>\n\t\t\t\t\t', ''],
	['<span class="order-search-icon">🔎</span>\n\t\t\t\t\t\t', ''],
	['<span class="date-range-icon">📅</span>\n\t\t\t\t\t\t', ''],
	['<span class="date-range-icon">📅</span>', ''],
	['<span class="order-search-icon">🔎</span>', ''],
	['<span class="ao-search-icon">🔍</span>', ''],
	['<span class="route-pin-icon" aria-hidden="true">📍</span>', ''],
	['<span class="exbuytag">🛒</span>', ''],
	['<span class="manual-order-btn-ic">＋</span> ', ''],
	['<span class="manual-order-btn-ic">＋</span>', ''],

	// ── CSS pseudo-elements ──────────────────────────────────────────────
	["content: '⏱ ';", "content: '';",],
	["content: '🔗';", "content: '';",],

	// ── Issue modal inline ───────────────────────────────────────────────
	['🔄 This line was already switched to', 'This line was already switched to'],

	// ── Sourcing location lines ──────────────────────────────────────────
	['<i>📍</i>', ''],
	['<i>🔗</i>', ''],
	['📍 ${', '${'],

	// ── Pass 2: remaining operator-facing emoji ──────────────────────────
	['<span class="dlb-icon" aria-hidden="true">⏱</span>', ''],
	['>📄 PDF<', '>PDF<'],
	['>↻ Retry / Resume<', '>Retry / Resume<'],
	['↻ Retry failed', 'Retry failed'],
	['↻ Retry / Resume', 'Retry / Resume'],
	['↻ <span data-i18n="refresh">Refresh</span>', '<span data-i18n="refresh">Refresh</span>'],
	["head.append(document.createTextNode('📦 '))", "head.append(document.createTextNode(''))"],
	["pdf.textContent = '📄'", "pdf.textContent = 'PDF'"],
	["icon: '🚚'", "icon: ''"],
	["icon: '📦'", "icon: ''"],
	["icon: '🗑'", "icon: ''"],
	["icon: '⚠️'", "icon: ''"],
	['`🛍️`', '`—`'],
	['>📷 Image set<', '>Image set<'],
	['>📷 Fix image<', '>Fix image<'],
	['>📷<', '>Img<'],
	['title="Custom variant image">📷</span>', 'title="Custom variant image"></span>'],
	['>🔁 Fix model<', '>Fix model<'],
	['>✎ Edit tracking ·', '>Edit tracking ·'],
	['>✎ Edit<', '>Edit<'],
	['>✎ Manual</div>', '>Manual</div>'],
	['>✎</button>', '>Edit</button>'],
	['>✎ Apply &amp; regenerate copy<', '>Apply &amp; regenerate copy<'],
	['>✎ Apply & regenerate copy<', '>Apply & regenerate copy<'],
	['>📋 Copy message<', '>Copy message<'],
	['>🗂️ From your catalog<', '>From your catalog<'],
	['>⬆️ Custom upload<', '>Custom upload<'],
	['>🔁 Change models<', '>Change models<'],
	['🔁 <strong>', '<strong>'],
	['<span class="arrow">🛒</span>', '<span class="arrow">→</span>'],
	['`🛒 Buy correct model:', '`Buy correct model:'],
	['`🔁 Swap to:', '`Swap to:'],
	['`✅ ${_doneExchangeTxs.length} models corrected`', '`${_doneExchangeTxs.length} models corrected`'],
	['`✅ Pack ${need}`', '`Pack ${need}`'],
	['`🔁 Model fix needed ·', '`Model fix needed ·'],
	['>◷ Completing on Etsy', '>Completing on Etsy'],
	['`◷ ${left} order', '`${left} order'],
	["showRouteToast('◷ A ship-recovery", "showRouteToast('A ship-recovery"],
	['<span>◷</span> 4PX is still preparing', '<span>Pending</span> 4PX is still preparing'],
	['const icon = disposed || health.severity === \'critical\' ? \'⛔\' : \'⚠\'', "const icon = disposed || health.severity === 'critical' ? '!' : '!'"],
	['<span class="customs-warn" data-i18n-skip>⚠</span>', '<span class="customs-warn" data-i18n-skip>!</span>'],
	['<span class="dup-icon">⚠</span>', '<span class="dup-icon">!</span>'],
	['<span class="bulk-error-ico">⚠</span>', '<span class="bulk-error-ico">!</span>'],
	['<span style="color:var(--red)">⚠</span>', '<span style="color:var(--red)">!</span>'],
	['<span>⚠</span>', '<span>!</span>'],
	['⛔ <b>', 'Blocked: <b>'],
	['⛔ ${escHtml', 'Blocked: ${escHtml'],
	['⛔ Will skip', 'Will skip'],
	["chip('multi', '🧩 Multiple products'", "chip('multi', 'Multiple products'"],
	['${p.image_count}🖼', '${p.image_count} img'],
	[' 🎬', ' video'],
	['>✨ No character', '>No character'],
	['<strong>✨ No character</strong>', '<strong>No character</strong>'],
	['>✏️ Custom (type your own)', '>Custom (type your own)'],
	['<span class="bins-thumb-zoom" aria-hidden="true">🔍</span>', ''],
	['<span class="bulk-inspect-hint">🔍 inspect</span>', '<span class="bulk-inspect-hint">inspect</span>'],
	['📱 ${escHtml(deviceLabel)}', '${escHtml(deviceLabel)}'],
	['`📥 ${escHtml(f.name)}`', '`${escHtml(f.name)}`'],
	['span.textContent = \'🛍️\'', "span.textContent = '—'"],
	['nothing changed this time. ✅<br/>', 'nothing changed this time.<br/>'],
	['<span class="ao-charm-teaser-icon">🔗</span>', ''],
	['<div id="charmEditPreviewPh" class="charm-editor-preview-ph">🔗</div>', '<div id="charmEditPreviewPh" class="charm-editor-preview-ph">—</div>'],
	['<button class="pm-tool" onclick="pmReconcile()" title="Fill blank supplier/charm cells from the route-engine catalog (exact title matches only)">🔗</button>', '<button class="pm-tool" onclick="pmReconcile()" title="Fill blank supplier/charm cells from the route-engine catalog (exact title matches only)">Link</button>'],
	['<button class="pm-tool" onclick="pmImportFromExcel()" title="Re-import from supplier_catalog.xlsx — replaces the catalog with the Excel Product Map sheet">↻</button>', '<button class="pm-tool" onclick="pmImportFromExcel()" title="Re-import from supplier_catalog.xlsx — replaces the catalog with the Excel Product Map sheet">Import</button>'],
	['<a class="pm-tool" href="/api/route/product-map/export.csv" download title="Download the current catalog as a CSV file">⬇</a>', '<a class="pm-tool" href="/api/route/product-map/export.csv" download title="Download the current catalog as a CSV file">CSV</a>'],
	['<span class="pm-search-icon">🔍</span>', ''],
	['<span>＋</span> Add entry', 'Add entry'],
	['>＋ Add buyer &amp; address<', '>Add buyer & address<'],
	['>＋ Add photos<', '>Add photos<'],
	['>＋ Add charm shop<', '>Add charm shop<'],
	['>↻ 90°<', '>Rotate 90°<'],
	['Retry ↻', 'Retry'],
	['title="Restock all styles → qty 3">↻</button>', 'title="Restock all styles → qty 3">Restock</button>'],
	['<span aria-hidden="true">↻</span> Updating…', 'Updating…'],
	['<span aria-hidden="true">↻</span><span class="ship-refresh-label"> Check carrier</span>', '<span class="ship-refresh-label">Check carrier</span>'],
	['<span class="${isSyncing ? \'sl-spin\' : \'\'}">↻</span>', '<span class="${isSyncing ? \'sl-spin\' : \'\'}">⟳</span>'],
	['Click <strong>“↻ Retry / Resume”</strong>', 'Click <strong>“Retry / Resume”</strong>'],
	['\\n\\n🚫 ${excludedCount}', '\\n\\n${excludedCount} excluded'],
	['Tap a <strong>🖼 photo</strong>', 'Tap a <strong>photo</strong>'],
	['<span class="bulk-step-txt">✎ Regenerating copy…</span>', '<span class="bulk-step-txt">Regenerating copy…</span>'],
	['`📦 Marked ${json.changed}', '`Marked ${json.changed}'],
	['`🛒 Buy: ${escHtml(need)}`', '`Buy: ${escHtml(need)}`'],
	['`🔁 Swap: ${escHtml(have)}', '`Swap: ${escHtml(have)}`'],
	['{ re: /^✎ Edit tracking', '{ re: /^Edit tracking'],
	['`✎ 修改物流单号', '`修改物流单号'],
	["if (p.startsWith('⚠'))", "if (p.startsWith('!'))"],
	['${q.ok ? \'✓\' : \'⚠\'}', "${q.ok ? '✓' : '!'}"],

	// ── Pass 3: route, bulk, modals, metrics ─────────────────────────────
	['🧩 <b>', 'Multiple: <b>'],
	['🎬 Video:', 'Video:'],
	['+ `📥 ${escHtml(f.name)}`', '+ `${escHtml(f.name)}`'],
	['<h2>📋 Purchase Status Sync Report</h2>', '<h2>Purchase Status Sync Report</h2>'],
	['>⬇ Download Excel<', '>Download Excel<'],
	['>⬇ CSV<', '>CSV<'],
	['>⬇ Excel<', '>Excel<'],
	['>📋 Copy<', '>Copy<'],
	['>⬇</a>', '>DL</a>'],
	["f.icon || '📄'", "f.icon || ''"],
	['msg = `📍 Added', 'msg = `Added'],
	['>＋ Add new supplier<', '>Add new supplier<'],
	["deleteSupplierEntry('${escAttr(s.shop)}','${escAttr(s.stall)}')\">🗑</button>", "deleteSupplierEntry('${escAttr(s.shop)}','${escAttr(s.stall)}')\">Del</button>"],
	['🔗 <b>', 'Charms: <b>'],
	['📍 <b>', 'Matched: <b>'],
	['🔁 <b>', 'Exchange: <b>'],
	['🛒 <b>', 'Model fix: <b>'],
	['🗑 <b>', 'Removed: <b>'],
	['>🗑 Removed</span>', '>Removed</span>'],
	['>📍 Wrong stall</span>', '>Wrong stall</span>'],
	['>🛒 Buy <span', '>Buy <span'],
	['>🔁 <span class="swap-have"', '>Swap: <span class="swap-have"'],
	["removeRouteRow(${target})\">🗑</button>", "removeRouteRow(${target})\">Remove</button>"],
	['${code ? \'＝\' : \'＋\'} Supplier', '${code ? \'=\' : \'+\'} Supplier'],
	['onclick="openCharmModal(${target})">🔗</div>', 'onclick="openCharmModal(${target})">—</div>'],
	['` · 📍${escHtml(stall)}`', '` · ${escHtml(stall)}`'],
	['onclick="openCharmModal(${target})">＋</div>', 'onclick="openCharmModal(${target})">+</div>'],
	['<span class="plus">＋</span>', '<span class="plus">+</span>'],
	['>🗑</button>', '>Del</button>'],
	['font-size:22px;color:var(--muted)">🔗</div>', 'font-size:12px;color:var(--muted)">—</div>'],
	['>✎ Change</button>', '>Change</button>'],
	['Click “＋ Add charm shop”', 'Click “Add charm shop”'],
	['>＋ Add item</button>', '>Add item</button>'],
	['>📍 Send to Route</button>', '>Send to Route</button>'],
	['<div class="modal-title">📷 Variant image</div>', '<div class="modal-title">Variant image</div>'],
	['<div class="modal-title">🔁 Wrong-model exchange</div>', '<div class="modal-title">Wrong-model exchange</div>'],
	['<div class="modal-title">🚚 Book 4PX pickup</div>', '<div class="modal-title">Book 4PX pickup</div>'],
	['>📄 View PDF</button>', '>View PDF</button>'],
	['<label class="modal-label">⚡ Smart paste', '<label class="modal-label">Smart paste'],
	['have ? `🔁 Swap the wrong', 'have ? `Swap the wrong'],
	['` : `🛒 Nothing to swap', '` : `Nothing to swap'],
]

function applyPairs(text) {
	let out = text
	for (const [from, to] of PAIRS) {
		if (!from) continue
		out = out.split(from).join(to)
	}
	return out
}

let changed = 0
for (const file of FILES) {
	if (!fs.existsSync(file)) continue
	const before = fs.readFileSync(file, 'utf8')
	const after = applyPairs(before)
	if (after !== before) {
		fs.writeFileSync(file, after, 'utf8')
		changed++
		console.log(`Updated ${path.relative(ROOT, file)}`)
	}
}

if (!changed) console.log('No files changed.')
else console.log(`\nDone — ${changed} file(s) updated.`)
