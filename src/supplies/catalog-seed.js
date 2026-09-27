'use strict'

/**
 * Shipping supplies catalog seed for UED.
 * Photos live in assets/supplies-seed/<sku>.jpg (studio-backed catalog
 * tiles) and are copied into the runtime photos directory next to the
 * SQLite file on first seed. Phone snapshots are kept in
 * assets/supplies-seed/original/ so a restyle can keep the real product.
 *
 * `sku` is an internal photo/filename key and is never shown in the tab.
 * Names and categories describe what is actually in that photo — the files
 * were not named after their contents, so identity follows the picture.
 */
module.exports = Object.freeze([
	{ sku: 'STK-HELLO-KITTY-ROLL', name: 'Hello Kitty Sticker Roll', name_zh: '凯蒂猫贴纸卷', category: 'stickers', family: 'hello_kitty', uom: 'roll', reorder_point: 1, reorder_qty: 2, notes: 'Decorative package stickers' },
	{ sku: 'STK-KUROMI-ROLL', name: 'Kuromi Sticker Roll', name_zh: '库洛米贴纸卷', category: 'stickers', family: 'kuromi', uom: 'roll', reorder_point: 1, reorder_qty: 2 },
	{ sku: 'STK-CINNAMOROLL-ROLL', name: 'Miffy Round Sticker Roll', name_zh: '米菲圆形贴纸卷', category: 'stickers', family: 'miffy', uom: 'roll', reorder_point: 1, reorder_qty: 2 },
	{ sku: 'STK-POMPOMPURIN-ROLL', name: 'Mametchi Computer Sticker Roll', name_zh: '玛梅吉电脑贴纸卷', category: 'stickers', family: 'mametchi', uom: 'roll', reorder_point: 1, reorder_qty: 2 },
	{ sku: 'STK-KEROPPI-ROLL', name: 'My Melody Label Roll', name_zh: '美乐蒂标签贴纸卷', category: 'stickers', family: 'my_melody', uom: 'roll', reorder_point: 1, reorder_qty: 2 },
	{ sku: 'STK-MYMELODY-ROLL', name: 'My Melody Dessert Tape Roll', name_zh: '美乐蒂甜点胶带卷', category: 'stickers', family: 'my_melody', uom: 'roll', reorder_point: 1, reorder_qty: 2 },
	{ sku: 'STK-LITTLE-TWIN-ROLL', name: 'Mametchi Face Sticker Roll', name_zh: '玛梅吉表情贴纸卷', category: 'stickers', family: 'mametchi', uom: 'roll', reorder_point: 1, reorder_qty: 2 },
	{ sku: 'STK-BADTZ-ROLL', name: 'Miffy Snack Sticker Roll', name_zh: '米菲零食贴纸卷', category: 'stickers', family: 'miffy', uom: 'roll', reorder_point: 1, reorder_qty: 2 },
	{ sku: 'STK-MAMECHI-ROLL', name: 'Kuromi Comic Sticker Roll', name_zh: '库洛米漫画贴纸卷', category: 'stickers', family: 'kuromi', uom: 'roll', reorder_point: 1, reorder_qty: 2 },
	{ sku: 'STK-MYMELODY-SQUARE-ROLL', name: 'Hello Kitty Ice Cream Sticker Roll', name_zh: '凯蒂猫冰淇淋贴纸卷', category: 'stickers', family: 'hello_kitty', uom: 'roll', reorder_point: 1, reorder_qty: 2 },
	{ sku: 'STK-ASSORTED-CHAR-ROLL-A', name: 'Cinnamoroll Sticker Roll', name_zh: '玉桂狗贴纸卷', category: 'stickers', family: 'cinnamoroll', uom: 'roll', reorder_point: 1, reorder_qty: 2 },
	{ sku: 'STK-ASSORTED-CHAR-ROLL-B', name: 'Miffy and Friends Sticker Roll', name_zh: '米菲与好友贴纸卷', category: 'stickers', family: 'miffy', uom: 'roll', reorder_point: 1, reorder_qty: 2 },
	{ sku: 'STK-ASSORTED-CHAR-ROLL-C', name: 'Gold Thank You Seal Roll', name_zh: '烫金感谢贴纸卷', category: 'stickers', family: 'other', uom: 'roll', reorder_point: 1, reorder_qty: 2 },
	{ sku: 'STK-KUROMI-PACK-63', name: 'Kuromi Sticker Box (63 pcs)', name_zh: '库洛米贴纸盒（63张）', category: 'stickers', family: 'kuromi', uom: 'box', reorder_point: 2, reorder_qty: 5, notes: 'Waterproof sticker box, 60+3 unique' },
	{ sku: 'STK-PURPLE-BOW', name: 'Cinnamoroll Sticker Box (63 pcs)', name_zh: '玉桂狗贴纸盒（63张）', category: 'stickers', family: 'cinnamoroll', uom: 'box', reorder_point: 2, reorder_qty: 5, notes: 'Waterproof sticker box, 60+3 unique' },
	{ sku: 'STK-THANKYOU-HEART-SHEET', name: 'Bow and Bunny Sticker', name_zh: '蝴蝶结小兔贴纸', category: 'stickers', family: 'other', uom: 'each', reorder_point: 20, reorder_qty: 50 },
	{ sku: 'BAG-CLEAR-PATTERN', name: 'Thank You Heart Seal Stickers', name_zh: '爱心感谢封口贴', category: 'stickers', family: 'other', uom: 'sheet', reorder_point: 10, reorder_qty: 30, notes: 'Dusty rose thank-you seals' },
	{ sku: 'BBW-CLEAR-STD', name: 'Rose Sticker Pack', name_zh: '玫瑰贴纸包', category: 'stickers', family: 'other', uom: 'pack', reorder_point: 2, reorder_qty: 5 },
	{ sku: 'CRD-Y2KASE-THANKYOU', name: 'Y2KASE Brand Card', name_zh: '品牌宣传卡', category: 'cards', uom: 'each', reorder_point: 50, reorder_qty: 200 },
	{ sku: 'CRD-Y2KASE-CLUB', name: 'Y2KASE Club Welcome Card', name_zh: '俱乐部欢迎卡', category: 'cards', uom: 'each', reorder_point: 50, reorder_qty: 200, notes: 'QR code to y2kase.com' },
	{ sku: 'TAP-PINK-PACKING', name: 'Pink Packing Tape', name_zh: '粉色打包胶带', category: 'tape', uom: 'roll', reorder_point: 2, reorder_qty: 6 },
	{ sku: 'MSC-ELASTIC-PINK', name: 'Pink Heart Bubble Wrap', name_zh: '粉色爱心气泡膜', category: 'bubble_wrap', uom: 'pack', reorder_point: 2, reorder_qty: 5 },
	{ sku: 'BBW-PINK-HEART', name: 'Pink Bubble Mailer', name_zh: '粉色气泡袋', category: 'mailers', uom: 'each', reorder_point: 25, reorder_qty: 100 },
	{ sku: 'MLR-PINK-BUBBLE', name: 'Pink and Lavender Elastic Bands', name_zh: '粉紫橡皮筋', category: 'misc', uom: 'pack', reorder_point: 2, reorder_qty: 5 },
	{ sku: 'BAG-BOWKNOT-CLEAR', name: 'Blue Security Seals', name_zh: '蓝色防拆封条', category: 'seals', uom: 'pack', reorder_point: 1, reorder_qty: 3, notes: 'Count packs, not individual serials' },
	{ sku: 'BAG-PINK-POLY-A', name: 'Pink Diamond Ziplock Bag', name_zh: '粉白菱格自封袋', category: 'bags', uom: 'each', reorder_point: 50, reorder_qty: 200 },
	{ sku: 'BAG-PINK-POLY-B', name: 'Miffy Clear Gift Bag', name_zh: '米菲透明袋', category: 'bags', uom: 'each', reorder_point: 50, reorder_qty: 200 },
	{ sku: 'BAG-BLUE-WOVEN', name: 'Purple Bowknot Clear Bag', name_zh: '紫色蝴蝶结透明袋', category: 'bags', uom: 'each', reorder_point: 50, reorder_qty: 200 },
	{ sku: 'BOX-PINK-MAILER-M', name: 'Blue Woven Shipping Sack', name_zh: '蓝色编织袋', category: 'bags', uom: 'each', reorder_point: 5, reorder_qty: 20 },
	{ sku: 'BOX-LAVENDER-MAILER', name: 'Lavender Mailer Box', name_zh: '薰衣草纸箱', category: 'boxes', uom: 'each', reorder_point: 20, reorder_qty: 100 },
	{ sku: 'BOX-PINK-MAILER-S', name: 'Pink Mailer Box (Small)', name_zh: '粉色纸箱（小）', category: 'boxes', uom: 'each', reorder_point: 20, reorder_qty: 100 },
	{ sku: 'SEL-4PX-SECURITY', name: 'Pink Mailer Box (Medium)', name_zh: '粉色纸箱（中）', category: 'boxes', uom: 'each', reorder_point: 15, reorder_qty: 80 },
])
