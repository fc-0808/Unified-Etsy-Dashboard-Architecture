'use strict'

const fs = require('fs')
const path = require('path')
const { allAppleStyles, SAMSUNG_STYLES, skuCode, RAW_SHOTS } = require('./hangze-buyer-catalog')

const root = path.resolve(__dirname, '..', 'assets', 'buyer-lookbooks')
const printDir = path.join(root, 'print')
const repliesDir = path.join(root, 'replies')
const pdfDir = path.join(root, 'pdfs')
let failed = 0

function assert(cond, msg) {
	if (!cond) {
		failed += 1
		console.error('FAIL', msg)
	} else {
		console.log('ok ', msg)
	}
}

const appleStyles = allAppleStyles()
assert(appleStyles.length === 33, 'catalog has 33 Apple styles')
assert(new Set(appleStyles.map((s) => s.id)).size === 33, 'Apple style ids are unique')
assert(new Set(appleStyles.map((s) => s.name)).size === 33, 'Apple style names are unique')
assert(SAMSUNG_STYLES.length === 6, 'catalog has 6 Samsung styles')
assert(skuCode(3) === '03', 'style numbers pad to two digits')

for (const name of ['etsy-reply-apple.txt', 'etsy-reply-samsung.txt']) {
		const text = fs.readFileSync(path.join(repliesDir, name), 'utf8')
	assert(!/https?:\/\//i.test(text), `${name} has no URLs`)
	assert(!/wechat|whatsapp|paypal/i.test(text), `${name} has no off-platform apps`)
	assert(/etsy/i.test(text), `${name} keeps the order on Etsy`)
}

const appleReply = fs.readFileSync(path.join(repliesDir, 'etsy-reply-apple.txt'), 'utf8')
const samsungReply = fs.readFileSync(path.join(repliesDir, 'etsy-reply-samsung.txt'), 'utf8')
assert(/page 5/i.test(appleReply), 'Apple reply points to the model list page')
assert(/page 2/i.test(samsungReply), 'Samsung reply points to the model list page')
assert(/33 styles/i.test(appleReply), 'Apple reply mentions 33 styles')
assert(/two revisions/i.test(appleReply) && /two revisions/i.test(samsungReply), 'replies include two revisions')
assert(/iPhone 12 Pro Max/i.test(appleReply) && /No\. 03/i.test(appleReply) && /Full-wrap film/i.test(appleReply), 'Apple reply includes a numbered style example')
assert(/Samsung Galaxy S24 Ultra/i.test(samsungReply) && /No\. 02/i.test(samsungReply) && /Full-wrap film/i.test(samsungReply), 'Samsung reply includes a numbered style example')

const appleHtml = fs.readFileSync(path.join(printDir, 'apple.html'), 'utf8')
const samsungHtml = fs.readFileSync(path.join(printDir, 'samsung.html'), 'utf8')
const listingApple = fs.readFileSync(path.join(printDir, 'listing-apple.html'), 'utf8')
const howItWorks = fs.readFileSync(path.join(printDir, 'listing-how-it-works.html'), 'utf8')
assert((appleHtml.match(/class="step"/g) || []).length === 5, 'Apple how-to has 5 steps')
assert(appleHtml.includes('2 revisions') && appleHtml.includes('Pay'), 'Apple how-to splits proof and pay')
assert(howItWorks.includes('2 revisions') && howItWorks.includes('Pay on Etsy'), 'listing how-to shows revisions then pay')
assert(howItWorks.includes('icons/step-phone.png'), 'listing how-to uses Y2KASE step icons')
assert(howItWorks.includes('iPhone 12 Pro Max') && howItWorks.includes('No. 03') && howItWorks.includes('Full-wrap film'), 'listing how-to shows a reply example')
assert(appleHtml.includes('iPhone 12 Pro Max') && appleHtml.includes('No. 03') && appleHtml.includes('Full-wrap film'), 'Apple PDF shows a reply example')
assert(appleHtml.includes('Style index'), 'Apple PDF includes a style index')
assert(samsungHtml.includes('Style index'), 'Samsung PDF includes a style index')
assert(!/paypal|wechat|whatsapp/i.test(howItWorks), 'listing how-to stays on Etsy')
assert(!appleHtml.includes('class="previews"'), 'Apple PDF has no duplicate photo grid')
assert((appleHtml.match(/<h3>MagSafe wrap<\/h3>/g) || []).length === 1, 'Apple lists MagSafe wrap once')
assert((appleHtml.match(/<section class="page/g) || []).length === 5, 'Apple PDF has five pages')
assert((samsungHtml.match(/<section class="page/g) || []).length === 2, 'Samsung PDF has two pages')
assert(appleHtml.includes('iPhone 18 Pro Max') && appleHtml.includes('iPhone 11 Pro Max'), 'Apple PDF lists iPhone models')
assert(samsungHtml.includes('Samsung Galaxy S26 Ultra') && samsungHtml.includes('Samsung Galaxy S22'), 'Samsung PDF lists Galaxy models')
assert((samsungHtml.match(/<h3>/g) || []).length === 6, 'Samsung lists 6 styles')

const appleNames = [...appleHtml.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1])
assert(appleNames.length === 33, `Apple lists 33 styles (got ${appleNames.length})`)
assert(new Set(appleNames).size === 33, 'Apple lookbook names are unique')
assert(appleHtml.includes('class="sku">03<') && appleHtml.includes('Full-wrap film'), 'Full-wrap film is style 03')
for (const st of appleStyles) {
	const code = skuCode(st.num)
	assert(appleHtml.includes(`class="sku">${code}</span>`), `Apple lookbook numbers ${st.name} as ${code}`)
	assert(listingApple.includes(st.name), `listing image includes ${st.name}`)
	assert(listingApple.includes(`class="sku">${code}</span>`), `listing image numbers ${st.name} as ${code}`)
}

assert(!/hangze|wechat|whatsapp|13246686861/i.test(appleHtml + samsungHtml), 'buyer HTML has no factory contact')
assert(!/¥|批发|来图定制价/.test(appleHtml + samsungHtml), 'buyer HTML has no factory prices')
assert(!/gold is discontinued/i.test(appleHtml), 'buyer copy does not use factory leftover language')
assert((appleHtml.match(/11–18 Pro Max/g) || []).length === 4, 'limited Pro Max styles include 18')
assert(!appleHtml.includes('11–17 Pro Max'), 'no leftover 11–17 Pro Max tags')
assert(appleHtml.includes('11–18 · no Mini'), 'wave wrap includes 18')
assert(!appleHtml.includes('11–17 · no Mini'), 'no leftover 11–17 wave tag')
assert(appleHtml.includes('15–18 Pro Max'), 'macaron includes 18')
assert(!appleHtml.includes('15–17 Pro Max'), 'no leftover 15–17 macaron tag')

for (const st of appleStyles.concat(SAMSUNG_STYLES)) {
	assert(Boolean(st.feel) && Boolean(st.material) && Boolean(st.print), `${st.name} lists feel, material, and print`)
}
assert(appleStyles.some((st) => /sand pink/.test(st.colors)), 'Painted glass lists sand pink')
assert(appleStyles.some((st) => st.colors === 'Silver, pink, green, blue, plum'), 'Metallic glass lists named colors')
assert(appleStyles.some((st) => st.colors === '6 shell colors'), 'Iridescent lists 6 colors without inventing names')
assert(appleStyles.some((st) => /microfiber/.test(`${st.feel} ${st.material}`)), 'velvet / macaron mention microfiber lining')
assert(appleHtml.includes('class="facts"') && samsungHtml.includes('class="facts"'), 'lookbooks include spec rows')
assert(appleHtml.includes('<dt>Feel</dt>') && appleHtml.includes('<dt>Material</dt>'), 'Apple cards list Hangze feel and material columns')
assert(samsungHtml.includes('<dt>Feel</dt>') && samsungHtml.includes('<dt>Material</dt>'), 'Samsung cards list Hangze feel and material columns')
assert(appleHtml.includes('sand pink') && appleHtml.includes('Black, white, sand pink, lilac'), 'Apple PDF lists painted-glass colors')
assert(appleHtml.includes('6 shell colors') && appleHtml.includes('microfiber lining'), 'Apple PDF lists iridescent colors and lined shells')
assert(appleHtml.includes('<dt>Color</dt>') && appleHtml.includes('If the card lists one'), 'Apple order card asks for color when listed')
assert(howItWorks.includes('Add a color if the card lists one'), 'listing how-to mentions color without a fourth numbered step')
assert(/color or finish/i.test(appleReply) && /color or finish/i.test(samsungReply), 'replies ask for color when the card lists one')
assert(/color, feel, material, and print/.test(appleReply) && /color, feel, material, and print/.test(samsungReply), 'replies name the four spec columns')
assert(!/TPA\+PC|TPU\+亚克力|热转印|彩绘/.test(appleHtml + samsungHtml), 'buyer HTML has no factory stack jargon')
assert(fs.existsSync(path.join(printDir, 'samples', '_raw', 'magsafe-wrap-cat.jpg')), 'MagSafe wrap uses the new WeChat photo')
assert(RAW_SHOTS['magsafe-wrap'].fit === 'contain', 'MagSafe wrap keeps the full case in the frame')
assert(appleHtml.includes('preserveAspectRatio="xMidYMid meet"'), 'MagSafe wrap PDF photo keeps the full case')
assert(listingApple.includes('tile contain magsafe'), 'listing MagSafe wrap shows the full case')
assert((appleHtml.match(/Shown unprinted/g) || []).length === 1, 'only Crystal glaze stays marked unprinted')
assert(appleStyles.filter((st) => st.magsafe).length === 2, 'Apple MagSafe is two styles')
assert(SAMSUNG_STYLES.filter((st) => st.magsafe).length === 1, 'Samsung MagSafe is one style')
assert((appleHtml.match(/class="card magsafe"/g) || []).length === 2, 'Apple PDF marks two MagSafe cards')
assert((samsungHtml.match(/class="card magsafe"/g) || []).length === 1, 'Samsung PDF marks one MagSafe card')
assert(appleHtml.includes('band-ms') && appleHtml.includes('band-wrap'), 'Apple page 1 splits MagSafe from wrap')
assert(appleHtml.includes('only these two') && appleHtml.includes('no MagSafe'), 'MagSafe band states it is only 01–02')
assert(/MagSafe is No\. 01 and No\. 02 only/.test(appleReply), 'Apple reply names MagSafe styles')
assert(/MagSafe is No\. 05 only/.test(samsungReply), 'Samsung reply names the MagSafe style')
assert(/designs we created/.test(appleReply) && /designs we created/.test(samsungReply), 'replies say ready-made cases are our designs')
assert(/ready-made/.test(appleReply) && /ready-made/.test(samsungReply), 'replies name ready-made shop cases')
assert(/more polished than a custom print/.test(appleReply) && /more polished than a custom print/.test(samsungReply), 'replies say ready-made looks more finished than custom')
assert(/your own artwork/.test(appleReply) && /your own artwork/.test(samsungReply), 'replies keep custom as the PDF path')
assert(/^Hi ♡/m.test(appleReply) && /^Hi ♡/m.test(samsungReply), 'replies open in Y2KASE voice')
assert(/Y2KASE\s*$/m.test(appleReply.trim()) && /Y2KASE\s*$/m.test(samsungReply.trim()), 'replies sign off as Y2KASE')
assert(listingApple.includes('ms-badge') && listingApple.includes('No. 01'), 'listing image badges MagSafe styles')

for (const name of [
	'Y2KASE-Apple-custom-case-lookbook.pdf',
	'Y2KASE-Samsung-custom-case-lookbook.pdf',
]) {
	const file = path.join(pdfDir, name)
	assert(fs.existsSync(file) && fs.statSync(file).size > 10000, `${name} exists`)
}

if (failed) {
	console.error(`${failed} assertion(s) failed`)
	process.exit(1)
}
console.log('All assertions passed.')
