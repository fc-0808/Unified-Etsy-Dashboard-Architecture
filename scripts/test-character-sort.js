'use strict'

/**
 * History character filing: name cascade, destination policy, copy safety.
 * Tests never hit a vision provider — identify is injected.
 *
 * Run: node scripts/test-character-sort.js
 */

const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const catalog = require('../src/listings/character-catalog')
const sort = require('../src/listings/character-sort')
const history = require('../src/listings/history-catalog')

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const RESET = '\x1b[0m'
let passed = 0
let failed = 0
const jobs = []

function test(name, fn) {
	jobs.push({ name, fn })
}

function tmpRoot(prefix) {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function writeTree(root, spec) {
	for (const [rel, files] of Object.entries(spec)) {
		const dir = path.join(root, ...rel.split('/'))
		fs.mkdirSync(dir, { recursive: true })
		for (const [name, buf] of Object.entries(files)) {
			fs.writeFileSync(path.join(dir, name), buf)
		}
	}
}

const JPEG = Buffer.from(
	'/9j/4AAQSkZJRgABAQAAAQABAAD/2wAAAAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI/9k=',
	'base64',
)

console.log('\nHistory character sort\n')

test('strong Chinese / English folder names match the catalog uniquely', () => {
	const miffy = catalog.matchNameHints('0616_米菲小兔16+13')
	assert.equal(miffy.filter((h) => h.strength === 'strong' && h.name === 'Miffy').length, 1)

	const melody = catalog.matchNameHints('美乐蒂 粉色连帽')
	assert.equal(melody.some((h) => h.name === 'My Melody' && h.strength === 'strong'), true)

	const kuromi = catalog.matchNameHints('库洛米_black_hood')
	assert.equal(kuromi[0].name, 'Kuromi')
	assert.equal(kuromi[0].strength, 'strong')

	const cinnamon = catalog.matchNameHints('玉桂狗 cinnamoroll case')
	assert.equal(cinnamon.some((h) => h.name === 'Cinnamoroll' && h.strength === 'strong'), true)
})

test('common-word aliases stay weak so a generic kitty bow is not auto-filed', () => {
	const hits = catalog.matchNameHints('cute kitty bow 16')
	assert.ok(hits.length === 0 || hits.every((h) => h.strength === 'weak'))
	const name = sort.classifyFromName({ product: 'cute kitty bow 16', batch: '', product_key: 'x/y/cute kitty bow 16', images: [] })
	assert.equal(name.layer, 'name-miss')
})

test('hello kitty and kt猫 are strong enough to auto-file', () => {
	const a = sort.classifyFromName({ product: 'hellokitty pink', batch: '', product_key: 'shop/b/hellokitty pink', images: [] })
	assert.equal(a.layer, 'name')
	assert.equal(a.name, 'Hello Kitty')
	assert.equal(a.confidence, sort.NAME_AUTO_CONFIDENCE)

	const b = sort.classifyFromName({ product: 'KT猫透明壳', batch: '', product_key: 'shop/b/KT猫透明壳', images: [] })
	assert.equal(b.layer, 'name')
	assert.equal(b.name, 'Hello Kitty')
})

test('a name-only placeholder does not block a later vision pass', async () => {
	const root = tmpRoot('char-sort-cache-')
	const historyRoot = path.join(root, 'History')
	const listingsRoot = path.join(root, 'Listings')
	writeTree(historyRoot, {
		'Shop/b/4': { '1.jpg': JPEG },
	})
	const opts = {
		historyRoot,
		listingsRoot,
		manifestDir: path.join(root, 'manifest'),
		apply: true,
		nameOnly: true,
	}
	const first = await sort.runSort(opts)
	assert.equal(first.summary.needs_vision, 1)
	assert.equal(first.summary.copied, 0)
	const second = await sort.runSort({
		...opts,
		nameOnly: false,
		identify: async () => ({
			name: 'Miffy',
			franchise: 'Mercis',
			known: true,
			generic: false,
			confidence: 94,
			isCollage: false,
			isOriginal: false,
			reasoning: 'x mouth',
		}),
	})
	assert.equal(second.summary.cached, 0)
	assert.equal(second.summary.vision, 1)
	assert.equal(second.summary.copied, 1)
	assert.equal(second.records[0].name, 'Miffy')
})

test('name-only mode skips vision and does not invent a character', async () => {
	const disk = {
		product_key: 'shop/b/4',
		product: '4',
		batch: 'b',
		images: [{ path: '/tmp/a.jpg', filename: '1.jpg' }],
	}
	const result = await sort.classifyFolder(disk, {
		nameOnly: true,
		identify: async () => {
			throw new Error('vision must not run in name-only mode')
		},
	})
	assert.equal(result.classified.layer, 'needs-vision')
	assert.equal(result.routed.decision, 'review')
	assert.equal(result.visionCalls, 0)
})

test('numeric History folders have no name signal', () => {
	const name = sort.classifyFromName({
		product: '12',
		batch: '0616_Y2KASEofficial',
		product_key: 'Y2KASEofficial/0616_Y2KASEofficial/12',
		images: [{ filename: '1.jpg' }],
	})
	assert.equal(name.layer, 'name-miss')
})

test('Sanrio nests the character; Miffy stays flat', () => {
	const sanrio = catalog.destinationFor({
		name: 'Hello Kitty',
		franchise: 'Sanrio',
		known: true,
		decision: 'auto',
		productKey: 'Y2KASEofficial/0616_Y2KASEofficial/1',
	})
	assert.equal(sanrio.destRoot, 'Sanrio')
	assert.equal(sanrio.characterFolder, 'Hello Kitty')
	assert.equal(sanrio.parts[0], 'Sanrio')
	assert.equal(sanrio.parts[1], 'Hello Kitty')
	assert.equal(sanrio.parts[2], 'Y2KASEofficial__0616_Y2KASEofficial__1')

	const miffy = catalog.destinationFor({
		name: 'Miffy',
		franchise: 'Mercis',
		known: true,
		decision: 'auto',
		productKey: 'Y2KASEofficial/0616_Y2KASEofficial/4',
	})
	assert.equal(miffy.destRoot, 'Miffy')
	assert.equal(miffy.characterFolder, '')
	assert.equal(miffy.parts.length, 2)
	assert.equal(miffy.parts[0], 'Miffy')
})

test('review and originals never write into an IP character folder', () => {
	const review = catalog.destinationFor({
		name: 'Hello Kitty',
		franchise: 'Sanrio',
		known: true,
		decision: 'review',
		productKey: 'shop/b/9',
	})
	assert.equal(review.destRoot, catalog.REVIEW_FOLDER)
	assert.ok(review.parts[1].startsWith('maybe-Hello Kitty'))

	const original = catalog.destinationFor({
		name: 'kawaii character',
		generic: true,
		decision: 'original',
		productKey: 'shop/b/8',
	})
	assert.equal(original.destRoot, catalog.ORIGINALS_FOLDER)
	assert.equal(original.parts[0], 'Originals')
})

test('unknown named IP files under OthersChars/<name>', () => {
	const dest = catalog.destinationFor({
		name: 'Labubu',
		franchise: '',
		known: false,
		decision: 'auto',
		productKey: 'shop/b/3',
	})
	assert.equal(dest.destRoot, catalog.OTHERS_FOLDER)
	assert.equal(dest.characterFolder, 'Labubu')
})

test('destination names strip Windows-illegal characters', () => {
	assert.equal(catalog.sanitizeFolderName('Hello<Kitty>:?*'), 'Hello Kitty')
	assert.equal(catalog.sanitizeFolderName('CON'), '_CON')
	assert.equal(catalog.stableCopyId('shop/batch/1'), 'shop__batch__1')
})

test('confidence routing: auto / review / original', () => {
	const auto = sort.routeClassification({ name: 'Kuromi', known: true, confidence: 88 }, { autoConfidence: 80, reviewConfidence: 55 })
	assert.equal(auto.decision, 'auto')

	const review = sort.routeClassification({ name: 'Kuromi', known: true, confidence: 62 }, { autoConfidence: 80, reviewConfidence: 55 })
	assert.equal(review.decision, 'review')

	const original = sort.routeClassification({ name: 'original', generic: true, isOriginal: true, confidence: 90 }, { autoConfidence: 80, reviewConfidence: 55 })
	assert.equal(original.decision, 'original')
})

test('dry-run classifies by name and does not copy', async () => {
	const root = tmpRoot('char-sort-dry-')
	const historyRoot = path.join(root, 'History')
	const listingsRoot = path.join(root, 'Listings')
	writeTree(historyRoot, {
		'Y2KASEofficial/0616_Y2KASEofficial/米菲白兔': { '1.jpg': JPEG, 'note.txt': Buffer.from('keep') },
	})
	const report = await sort.runSort({
		historyRoot,
		listingsRoot,
		manifestDir: path.join(root, 'manifest'),
		apply: false,
		identify: async () => {
			throw new Error('vision must not run when the folder name is a unique strong match')
		},
	})
	assert.equal(report.summary.selected, 1)
	assert.equal(report.summary.name, 1)
	assert.equal(report.summary.auto, 1)
	assert.equal(report.summary.copied, 0)
	assert.equal(report.records[0].name, 'Miffy')
	assert.ok(!fs.existsSync(path.join(listingsRoot, 'Miffy')))
	assert.ok(fs.existsSync(path.join(historyRoot, 'Y2KASEofficial', '0616_Y2KASEofficial', '米菲白兔', '1.jpg')))
})

test('apply copies into the character folder and leaves History untouched', async () => {
	const root = tmpRoot('char-sort-copy-')
	const historyRoot = path.join(root, 'History')
	const listingsRoot = path.join(root, 'Listings')
	writeTree(historyRoot, {
		'SanrioShop/0701_SanrioShop/库洛米黑帽': { '1.jpg': JPEG, '2.png': JPEG },
	})
	const report = await sort.runSort({
		historyRoot,
		listingsRoot,
		manifestDir: path.join(root, 'manifest'),
		apply: true,
		identify: async () => {
			throw new Error('vision must not run')
		},
	})
	assert.equal(report.summary.copied, 1)
	assert.equal(report.records[0].name, 'Kuromi')
	const dest = path.join(listingsRoot, 'Sanrio', 'Kuromi', 'SanrioShop__0701_SanrioShop__库洛米黑帽')
	assert.ok(fs.existsSync(path.join(dest, '1.jpg')))
	assert.ok(fs.existsSync(path.join(dest, '2.png')))
	assert.ok(fs.existsSync(path.join(historyRoot, 'SanrioShop', '0701_SanrioShop', '库洛米黑帽', '1.jpg')))
})

test('apply is idempotent: a second run does not duplicate or overwrite', async () => {
	const root = tmpRoot('char-sort-idemp-')
	const historyRoot = path.join(root, 'History')
	const listingsRoot = path.join(root, 'Listings')
	writeTree(historyRoot, {
		'Shop/b/美乐蒂粉帽': { '1.jpg': JPEG },
	})
	const opts = {
		historyRoot,
		listingsRoot,
		manifestDir: path.join(root, 'manifest'),
		apply: true,
		identify: async () => {
			throw new Error('vision must not run')
		},
	}
	const first = await sort.runSort(opts)
	assert.equal(first.summary.copied, 1)
	const marker = path.join(listingsRoot, 'Sanrio', 'My Melody', 'Shop__b__美乐蒂粉帽', 'operator.txt')
	fs.writeFileSync(marker, 'do not clobber')
	const second = await sort.runSort(opts)
	assert.equal(second.summary.copied, 0)
	assert.equal(second.summary.already_copied, 1)
	assert.equal(fs.readFileSync(marker, 'utf8'), 'do not clobber')
})

test('vision injection files a numeric folder and never writes into History', async () => {
	const root = tmpRoot('char-sort-vision-')
	const historyRoot = path.join(root, 'History')
	const listingsRoot = path.join(root, 'Listings')
	writeTree(historyRoot, {
		'Y2KASEofficial/0616_Y2KASEofficial/12': { '1.jpg': JPEG },
	})
	let calls = 0
	const report = await sort.runSort({
		historyRoot,
		listingsRoot,
		manifestDir: path.join(root, 'manifest'),
		apply: true,
		identify: async () => {
			calls += 1
			return { name: 'Cinnamoroll', franchise: 'Sanrio', known: true, generic: false, confidence: 91, isCollage: false, isOriginal: false, reasoning: 'long floppy ears' }
		},
	})
	assert.equal(calls, 1)
	assert.equal(report.summary.vision, 1)
	assert.equal(report.summary.auto, 1)
	assert.equal(report.records[0].dest_relative, 'Sanrio/Cinnamoroll/Y2KASEofficial__0616_Y2KASEofficial__12')
	assert.ok(fs.existsSync(path.join(listingsRoot, 'Sanrio', 'Cinnamoroll', 'Y2KASEofficial__0616_Y2KASEofficial__12', '1.jpg')))
	assert.ok(history.isInsideRoot(historyRoot, path.join(historyRoot, 'Y2KASEofficial', '0616_Y2KASEofficial', '12')))
	assert.ok(!history.isInsideRoot(historyRoot, path.join(listingsRoot, 'Sanrio', 'Cinnamoroll', 'Y2KASEofficial__0616_Y2KASEofficial__12')))
})

test('low-confidence vision goes to the review queue instead of Sanrio', async () => {
	const root = tmpRoot('char-sort-review-')
	const historyRoot = path.join(root, 'History')
	const listingsRoot = path.join(root, 'Listings')
	writeTree(historyRoot, {
		'Shop/b/7': { '1.jpg': JPEG },
	})
	const report = await sort.runSort({
		historyRoot,
		listingsRoot,
		manifestDir: path.join(root, 'manifest'),
		apply: true,
		allowEscalate: false,
		identify: async () => ({
			name: 'Miffy',
			franchise: 'Mercis',
			known: true,
			generic: false,
			confidence: 58,
			isCollage: false,
			isOriginal: false,
			reasoning: 'maybe a white rabbit',
		}),
	})
	assert.equal(report.records[0].decision, 'review')
	assert.equal(report.records[0].dest_relative.startsWith('_CharacterReview/'), true)
	assert.ok(!fs.existsSync(path.join(listingsRoot, 'Miffy')))
	assert.ok(fs.existsSync(path.join(listingsRoot, '_CharacterReview')))
})

test('copy safety refuses a destination inside History', () => {
	const historyRoot = 'C:\\Users\\w088s\\OneDrive\\Documents\\E-Commerce\\Etsy\\Listings\\History'
	const listingsRoot = 'C:\\Users\\w088s\\OneDrive\\Documents\\E-Commerce\\Etsy\\Listings'
	assert.throws(() => {
		sort.assertCopySafe({
			sourcePath: path.join(historyRoot, 'Y2KASEofficial', '1'),
			destPath: path.join(historyRoot, 'Miffy', '1'),
			historyRoot,
			listingsRoot,
		})
	}, /inside History/)
})

test('mid-confidence escalate calls vision a second time with more images', async () => {
	const disk = {
		product_key: 'shop/b/4',
		product: '4',
		batch: 'b',
		shop: 'shop',
		folder_path: '/tmp/not-used',
		images: [
			{ path: '/tmp/a.jpg', filename: '1.jpg', mtime_ms: 1, bytes: 10 },
			{ path: '/tmp/b.jpg', filename: '2.jpg', mtime_ms: 1, bytes: 10 },
		],
	}
	let calls = 0
	const result = await sort.classifyFolder(disk, {
		identify: async (images) => {
			calls += 1
			return {
				name: 'Stitch',
				franchise: 'Disney',
				known: true,
				generic: false,
				confidence: calls === 1 ? 60 : 86,
				isCollage: false,
				isOriginal: false,
				reasoning: images.length > 1 ? 'confirmed on image 2' : 'unsure',
			}
		},
	})
	assert.equal(calls, 2)
	assert.equal(result.routed.decision, 'auto')
	assert.equal(result.classified.name, 'Stitch')
	assert.equal(result.dest.destRoot, 'Disney')
})

test('accurate mode confirms a folder-name hit with a second look', async () => {
	const disk = {
		product_key: 'shop/b/米菲',
		product: '米菲',
		batch: 'b',
		shop: 'shop',
		folder_path: '/tmp/not-used',
		images: [
			{ path: '/tmp/a.jpg', filename: '1.jpg' },
			{ path: '/tmp/b.jpg', filename: '2.jpg' },
			{ path: '/tmp/c.jpg', filename: '3.jpg' },
		],
	}
	let calls = 0
	const result = await sort.classifyFolder(disk, {
		accurate: true,
		identify: async (images) => {
			calls += 1
			assert.equal(images.length, 3)
			return { name: 'Miffy', franchise: 'Mercis', known: true, generic: false, confidence: 88, isCollage: false, isOriginal: false, reasoning: 'x mouth, tall ears' }
		},
	})
	assert.equal(calls, 2)
	assert.equal(result.classified.layer, 'vision-confirmed')
	assert.equal(result.classified.name, 'Miffy')
	assert.ok(result.classified.confidence >= 90)
	assert.equal(result.routed.decision, 'auto')
})

test('accurate mode sends a look-alike disagreement to review', async () => {
	const disk = {
		product_key: 'shop/b/4',
		product: '4',
		batch: 'b',
		images: [{ path: '/tmp/a.jpg', filename: '1.jpg' }, { path: '/tmp/b.jpg', filename: '2.jpg' }],
	}
	let calls = 0
	const result = await sort.classifyFolder(disk, {
		accurate: true,
		identify: async () => {
			calls += 1
			if (calls === 1) return { name: 'Miffy', franchise: 'Mercis', known: true, generic: false, confidence: 92, isCollage: false, isOriginal: false, reasoning: 'white rabbit' }
			return { name: 'My Melody', franchise: 'Sanrio', known: true, generic: false, confidence: 90, isCollage: false, isOriginal: false, reasoning: 'pink hood' }
		},
	})
	assert.equal(calls, 2)
	assert.equal(result.classified.layer, 'vision-split')
	assert.equal(result.routed.decision, 'review')
	assert.ok(result.classified.confidence < 80)
})

test('accurate pass retires an earlier copy that it no longer agrees with', async () => {
	const root = tmpRoot('char-sort-retire-')
	const historyRoot = path.join(root, 'History')
	const listingsRoot = path.join(root, 'Listings')
	const manifestDir = path.join(root, 'manifest')
	writeTree(historyRoot, { 'Shop/b/4': { '1.jpg': JPEG, '2.jpg': JPEG, '3.jpg': JPEG } })
	const stale = path.join(listingsRoot, 'Miffy', 'Shop__b__4')
	fs.mkdirSync(stale, { recursive: true })
	fs.writeFileSync(path.join(stale, '1.jpg'), JPEG)
	fs.mkdirSync(manifestDir, { recursive: true })
	fs.writeFileSync(path.join(manifestDir, 'manifest.jsonl'), JSON.stringify({
		product_key: 'Shop/b/4',
		pass: '',
		layer: 'vision',
		name: 'Miffy',
		franchise: 'Mercis',
		known: true,
		confidence: 95,
		decision: 'auto',
		dest_path: stale,
		dest_relative: 'Miffy/Shop__b__4',
		copied: true,
		hero_signature: 'stale',
	}) + '\n')
	const report = await sort.runSort({
		historyRoot,
		listingsRoot,
		manifestDir,
		apply: true,
		accurate: true,
		pass: sort.ACCURATE_PASS,
		copyReview: false,
		identify: async () => ({
			name: 'Hello Kitty',
			franchise: 'Sanrio',
			known: true,
			generic: false,
			confidence: 96,
			isCollage: false,
			isOriginal: false,
			reasoning: 'red bow, no mouth',
		}),
	})
	assert.equal(report.summary.retired, 1)
	assert.equal(report.summary.copied, 1)
	assert.equal(fs.existsSync(stale), false)
	assert.ok(fs.existsSync(path.join(listingsRoot, 'Sanrio', 'Hello Kitty', 'Shop__b__4', '1.jpg')))
	assert.ok(fs.existsSync(path.join(historyRoot, 'Shop', 'b', '4', '1.jpg')))
})

test('cost model is cheaper than naive all-image vision', () => {
	const cost = sort.estimateCost({ folders: 2220, nameHits: 80, cached: 0 })
	assert.ok(cost.estimated_usd < 5)
	assert.ok(cost.naive_all_images_usd > 20)
})

test('existing listing-generation catalogue helpers still resolve aliases', () => {
	const a = catalog.normaliseCharacter('玉桂狗')
	assert.equal(a.known, true)
	assert.equal(a.name, 'Cinnamoroll')
	assert.equal(a.franchise, 'Sanrio')
	const b = catalog.normaliseCharacter('kawaii character')
	assert.equal(b.generic, true)
})

async function run() {
	for (const job of jobs) {
		try {
			await job.fn()
			passed++
			console.log(`${GREEN}ok${RESET}  ${job.name}`)
		} catch (err) {
			failed++
			console.log(`${RED}FAIL${RESET}  ${job.name}`)
			console.log('    ' + (err.stack || err.message || err))
		}
	}
	console.log('')
	console.log(failed ? `${RED}${failed} failed${RESET}, ${passed} passed` : `${GREEN}${passed} passed${RESET}`)
	if (failed) process.exit(1)
}

run()
