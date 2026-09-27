'use strict'

/**
 * UI contract: find-supplier-from-a-photo lives on Sourcing, not Shopping Mode.
 *
 * Run: node scripts/test-find-by-photo-ui.js
 */

const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { JSDOM, VirtualConsole } = require('jsdom')

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
		console.error(`         ${err.stack || err.message}`)
	}
}

function waitFor(fn, label, ms = 2500) {
	const start = Date.now()
	return new Promise((resolve, reject) => {
		const tick = () => {
			try {
				if (fn()) return resolve()
			} catch {
				/* not yet */
			}
			if (Date.now() - start > ms) return reject(new Error(label || 'timeout'))
			setTimeout(tick, 15)
		}
		tick()
	})
}

function click(window, el) {
	assert.ok(el, 'click target exists')
	el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
}

function jsonResponse(body) {
	return {
		status: 200,
		ok: true,
		headers: {
			get(name) {
				return String(name).toLowerCase() === 'content-type' ? 'application/json' : null
			},
		},
		json: async () => body,
	}
}

function installCameraMocks(window) {
	Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
	const track = {
		kind: 'video',
		stopped: false,
		stop() {
			this.stopped = true
		},
	}
	const stream = {
		getTracks() {
			return [track]
		},
		getVideoTracks() {
			return [track]
		},
	}
	const constraintsLog = []
	Object.defineProperty(window.navigator, 'mediaDevices', {
		configurable: true,
		value: {
			getUserMedia: async (constraints) => {
				constraintsLog.push(constraints)
				return stream
			},
			enumerateDevices: async () => [
				{ kind: 'videoinput', deviceId: 'back' },
				{ kind: 'videoinput', deviceId: 'front' },
			],
		},
	})
	Object.defineProperty(window.HTMLVideoElement.prototype, 'videoWidth', {
		configurable: true,
		get() {
			return this.srcObject ? 1280 : 0
		},
	})
	Object.defineProperty(window.HTMLVideoElement.prototype, 'videoHeight', {
		configurable: true,
		get() {
			return this.srcObject ? 720 : 0
		},
	})
	window.HTMLVideoElement.prototype.play = async function play() {}
	window.HTMLCanvasElement.prototype.getContext = function getContext() {
		return { drawImage() {} }
	}
	window.HTMLCanvasElement.prototype.toBlob = function toBlob(cb, type) {
		cb(new window.Blob([Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])], { type: type || 'image/jpeg' }))
	}
	return { stream, track, constraintsLog }
}

function mountSourcing(opts = {}) {
	const scriptStart = sourcingHtml.lastIndexOf('<script>')
	const scriptEnd = sourcingHtml.lastIndexOf('</script>')
	const script = sourcingHtml.slice(scriptStart + '<script>'.length, scriptEnd)
	const shell = sourcingHtml.slice(0, scriptStart) + sourcingHtml.slice(scriptEnd + '</script>'.length)
	const virtualConsole = new VirtualConsole()
	const errors = []
	virtualConsole.on('jsdomError', (err) => errors.push(err))
	const photoPosts = []
	const dom = new JSDOM(shell, {
		url: 'http://127.0.0.1/',
		runScripts: 'dangerously',
		pretendToBeVisual: true,
		virtualConsole,
	})
	const { window } = dom
	window.EventSource = class {
		close() {}
	}
	if (opts.camera) installCameraMocks(window)
	window.fetch = async (input, init = {}) => {
		const url = String(input)
		if (url.includes('/api/auth/me')) return jsonResponse({ user: 'tester', authEnabled: false })
		if (url.includes('/api/sourcing/meta')) return jsonResponse({ categories: [], statuses: [], product_types: [], gap_types: [] })
		if (url.includes('/api/sourcing/catalog')) {
			return jsonResponse({
				products: [],
				suppliers: [],
				charm_shops: [],
				totals: { products: 0, suppliers: 0, charm_shops: 0, charms: 0, by_type: {}, by_gap: {}, with_price: 0, ready: 0 },
			})
		}
		if (url.includes('/api/sourcing/suppliers')) return jsonResponse({ suppliers: [] })
		if (url.includes('/api/sourcing/find-by-photo')) {
			photoPosts.push({ url, init })
			return jsonResponse(opts.photoResponse || { matches: [], reason: 'index_empty' })
		}
		return jsonResponse({})
	}
	window.eval(script)
	return { window, doc: window.document, errors, photoPosts }
}

const ROOT = path.resolve(__dirname, '..')
const sourcingHtml = fs.readFileSync(path.join(ROOT, 'public/sourcing.html'), 'utf8')
const shopHtml = fs.readFileSync(path.join(ROOT, 'public/shop.html'), 'utf8')
const findByPhotoJs = fs.readFileSync(path.join(ROOT, 'src/route/find-by-photo.js'), 'utf8')

console.log('\nFind by photo UI\n')

test('Sourcing exposes camera capture plus a gallery file picker', () => {
	assert.match(sourcingHtml, /id="catFindPhoto"/)
	assert.match(sourcingHtml, /data-act="cat-find-photo"/)
	assert.match(sourcingHtml, /id="catFindPhotoFile"/)
	assert.match(sourcingHtml, /id="findPhotoModal"/)
	assert.match(sourcingHtml, /accept="image\/jpeg,image\/png,image\/webp"/)
	assert.match(sourcingHtml, /\/api\/sourcing\/find-by-photo/)
	assert.match(sourcingHtml, /id="supFindPhoto"/)
	assert.match(sourcingHtml, /function revealSupplierFromPhoto/)
	assert.match(sourcingHtml, /function findSupplierForPhotoMatch/)
	assert.match(sourcingHtml, /function shouldAutoLocatePhoto/)
	assert.match(sourcingHtml, /function findPhotoEmptyCopy/)
	assert.match(sourcingHtml, /function compressPhotoForUpload/)
	assert.match(sourcingHtml, /function hydrateFindPhotoMatches/)
	assert.match(sourcingHtml, /function findPhotoCatalogProduct/)
	assert.match(sourcingHtml, /function revealProductInOpenDrawer/)
	assert.match(sourcingHtml, /openSupplierDrawer\(idx, \{ skipFocus: true \}\)/)
	assert.match(sourcingHtml, /data-product-id=/)
	assert.match(sourcingHtml, /createImageBitmap/)
	assert.match(sourcingHtml, /findPhotoShop:\s*\{\s*en:\s*'Find shop from photo'/)
	assert.match(sourcingHtml, /findPhotoLookedFor:\s*\{\s*en:\s*'Looked for'/)
	assert.match(sourcingHtml, /findPhotoNeedVision:/)
	assert.match(sourcingHtml, /findPhotoVisionFail:/)
	assert.match(sourcingHtml, /findPhotoVisual:\s*\{\s*en:\s*'Photo match'/)
	assert.match(sourcingHtml, /data\.query/)
	assert.match(sourcingHtml, /match_kind === 'vision'/)
	assert.match(sourcingHtml, /match_kind === 'embed'/)
	assert.match(sourcingHtml, /vision_evidence === 'rerank'/)
	assert.match(sourcingHtml, /data-act="cat-find-photo-again"/)
	assert.match(sourcingHtml, /findPhoto:\s*\{\s*en:\s*'Find by photo',\s*zh:\s*'拍照找货'/)
	assert.match(sourcingHtml, /navigator\.mediaDevices/)
	assert.match(sourcingHtml, /getUserMedia/)
	assert.match(sourcingHtml, /data-act="find-photo-camera"/)
	assert.match(sourcingHtml, /data-act="find-photo-shutter"/)
	assert.match(sourcingHtml, /data-act="find-photo-upload"/)
	assert.match(sourcingHtml, /data-act="find-photo-flip"/)
	assert.match(sourcingHtml, /playsinline/)
	assert.match(sourcingHtml, /function startFindPhotoCamera/)
	assert.match(sourcingHtml, /function captureFindPhotoFromCamera/)
	assert.match(sourcingHtml, /function stopFindPhotoCamera/)
	assert.match(sourcingHtml, /findPhotoTake:\s*\{\s*en:\s*'Take photo with camera'/)
	assert.match(sourcingHtml, /findPhotoUpload:\s*\{\s*en:\s*'Choose from this device'/)
})

test('File picker is gallery-only: no capture= so desktop still gets a file dialog', () => {
	const input = sourcingHtml.match(/<input[^>]*id="catFindPhotoFile"[^>]*>/)
	assert.ok(input, 'hidden file input markup exists')
	assert.doesNotMatch(input[0], /\bcapture=/)
	assert.doesNotMatch(sourcingHtml, /id="catFindPhotoFile"[^>]*\bcapture=/)
})

test('Sourcing photo lookup is not wired through shopping or route APIs', () => {
	assert.doesNotMatch(sourcingHtml, /\/api\/shop\/find-by-photo/)
	assert.doesNotMatch(sourcingHtml, /\/api\/route\/find-by-photo/)
	assert.match(findByPhotoJs, /app\.post\('\/api\/sourcing\/find-by-photo'/)
	assert.doesNotMatch(findByPhotoJs, /\/api\/shop\/find-by-photo/)
	assert.doesNotMatch(findByPhotoJs, /\/api\/route\/find-by-photo/)
})

test('Shopping Mode does not expose find-by-photo', () => {
	assert.doesNotMatch(shopHtml, /id="photoFindBtn"/)
	assert.doesNotMatch(shopHtml, /id="photoFindFile"/)
	assert.doesNotMatch(shopHtml, /id="photoFindBg"/)
	assert.doesNotMatch(shopHtml, /\/api\/shop\/find-by-photo/)
	assert.doesNotMatch(shopHtml, /\/api\/sourcing\/find-by-photo/)
	assert.doesNotMatch(shopHtml, /\/api\/route\/find-by-photo/)
	assert.doesNotMatch(shopHtml, /Find by photo/)
	assert.doesNotMatch(shopHtml, /拍照找货/)
})

;(async () => {
	await testAsync('Find by photo / Find shop from photo open a camera-or-files picker', async () => {
		const { window, doc, errors } = mountSourcing({ camera: true })
		const input = doc.getElementById('catFindPhotoFile')
		assert.ok(input, 'hidden file input exists')
		assert.equal(input.hasAttribute('capture'), false)
		let clicked = false
		input.click = () => {
			clicked = true
		}
		click(window, doc.getElementById('catFindPhoto'))
		assert.equal(doc.getElementById('findPhotoModal').classList.contains('open'), true)
		assert.equal(clicked, false, 'opening the tool does not jump to the file picker')
		assert.match(doc.getElementById('findPhotoBody').textContent, /Take photo with camera/)
		assert.match(doc.getElementById('findPhotoBody').textContent, /Choose from this device/)
		assert.ok(doc.querySelector('[data-act="find-photo-camera"]'))
		assert.ok(doc.querySelector('[data-act="find-photo-upload"]'))

		click(window, doc.querySelector('[data-act="find-photo-upload"]'))
		assert.equal(clicked, true, 'Choose from this device opens the file picker')

		clicked = false
		click(window, doc.getElementById('supFindPhoto'))
		assert.equal(clicked, false)
		assert.match(doc.getElementById('findPhotoBody').textContent, /Take photo with camera/)

		click(window, doc.querySelector('[data-act="cat-find-photo-again"]'))
		assert.equal(clicked, false, 'Try another photo returns to the picker, not the file dialog')
		assert.match(doc.getElementById('findPhotoBody').textContent, /Choose from this device/)
		await new Promise((resolve) => setTimeout(resolve, 40))
		if (errors.length) throw new Error(errors.map((e) => (e && e.stack) || e).join('\n'))
	})

	await testAsync('Live camera capture POSTs find-by-photo and releases the track', async () => {
		const { window, doc, errors, photoPosts } = mountSourcing({
			camera: true,
			photoResponse: { matches: [], reason: 'index_empty' },
		})
		click(window, doc.getElementById('supFindPhoto'))
		click(window, doc.querySelector('[data-act="find-photo-camera"]'))
		await waitFor(() => {
			const shutter = doc.getElementById('findPhotoShutter')
			const video = doc.getElementById('findPhotoLive')
			return shutter && !shutter.disabled && video && video.getAttribute('playsinline') !== null
		}, 'live preview ready')
		assert.ok(doc.querySelector('[data-act="find-photo-flip"]'), 'flip camera is available')
		assert.ok(doc.querySelector('#findPhotoBody [data-act="find-photo-upload"]'), 'file choose remains on the live view')
		click(window, doc.getElementById('findPhotoShutter'))
		await waitFor(() => photoPosts.length === 1, 'camera frame uploaded to find-by-photo')
		const body = JSON.parse(photoPosts[0].init.body || '{}')
		assert.match(String(body.photo_data || ''), /^data:image\/jpeg;base64,/)
		await waitFor(() => !doc.getElementById('findPhotoLive'), 'preview torn down after capture')
		if (errors.length) throw new Error(errors.map((e) => (e && e.stack) || e).join('\n'))
	})

	await testAsync('Closing the modal stops the camera track', async () => {
		const { window, doc } = mountSourcing({ camera: true })
		click(window, doc.getElementById('catFindPhoto'))
		click(window, doc.querySelector('[data-act="find-photo-camera"]'))
		await waitFor(() => doc.getElementById('findPhotoShutter') && !doc.getElementById('findPhotoShutter').disabled, 'camera started')
		const video = doc.getElementById('findPhotoLive')
		const stream = video && video.srcObject
		assert.ok(stream, 'preview has a stream')
		const track = stream.getTracks()[0]
		click(window, doc.querySelector('[data-act="close"][data-target="findPhotoModal"]'))
		assert.equal(doc.getElementById('findPhotoModal').classList.contains('open'), false)
		assert.equal(track.stopped, true)
	})

	if (failed) {
		console.error(`\n${failed} failed, ${passed} passed`)
		process.exit(1)
	}
	console.log(`\n${passed} passed`)
})()
