'use strict'

/**
 * END-TO-END integration test — the Sourcing page's HTTP layer.
 *
 * scripts/test-sourcing.js already covers the pure helpers and the DB accessors.
 * This test covers the layer between them: the /api/sourcing/* endpoints, which
 * is where the genuinely risky code lives — a STREAMING upload that writes to a
 * temp file while hashing, magic-byte validation before the bytes are accepted,
 * the temp→final rename, the on-disk move when a package is re-categorised, and
 * file cleanup on delete/cascade. None of that is exercised by a unit test, so it
 * is driven here against the ACTUAL Express server (booted on an isolated
 * throwaway config + database via DASHBOARD_CONFIG_PATH, auth disabled).
 *
 * The invariants under test:
 *   1. The on-disk store and the sourcing_packages index never disagree — every
 *      accepted upload has exactly one file, and every removal takes its file.
 *   2. A rejected or ABANDONED upload leaves NOTHING behind. Half-written `.part`
 *      files would silently accumulate on a feature sized for 500 MB folders.
 *   3. Untrusted client input (filename, category, supplier id) can never escape
 *      the library root or land unsanitised on disk.
 *
 * Section [8] covers the page's other half — the product CATALOG. That one is
 * READ from /api/sourcing/catalog and WRITTEN through /api/route/*, so the
 * invariant it pins is the split itself: an edit posted to one endpoint must
 * appear in the other's response, or the page's save-then-refresh cycle throws
 * the operator's work away. The projection's own logic (classification, stall
 * inference, gaps, rollups) is covered in depth against a direct database by
 * scripts/test-sourcing-catalog.js.
 *
 * Run: `node scripts/test-sourcing-api.js`   (exit 0 = pass, 1 = regression)
 */

const os = require('os')
const path = require('path')
const fs = require('fs')
const http = require('http')
const crypto = require('crypto')
const { spawn } = require('child_process')

let failures = 0
function assert(cond, msg) {
	if (cond) console.log(`  ok  — ${msg}`)
	else {
		failures++
		console.error(`  FAIL — ${msg}`)
	}
}

const PORT = 4600 + (process.pid % 300)
const BASE = `http://127.0.0.1:${PORT}`
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcing-api-'))
const dbPath = path.join(tmpDir, 'test.db')
const cfgPath = path.join(tmpDir, 'config.json')
// Must mirror the server's SOURCING_ROOT derivation: <dir of db_path>/sourcing-library.
const storeRoot = path.join(tmpDir, 'sourcing-library')

// ── Fixtures ────────────────────────────────────────────────────────────────────
// A genuinely valid empty ZIP: the 22-byte End-Of-Central-Directory record.
const EMPTY_ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)])
// A larger payload with the local-file-header magic, for size/hash assertions.
const BIG_ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), crypto.randomBytes(64 * 1024)])
const NOT_A_ZIP = Buffer.from('%PDF-1.7\nnot a zip at all')

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

/** Every file under the on-disk store, as paths relative to the store root. */
function walkStore(dir = storeRoot, prefix = '') {
	let out = []
	let entries
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true })
	} catch {
		return out
	}
	for (const e of entries) {
		const rel = prefix ? `${prefix}/${e.name}` : e.name
		if (e.isDirectory()) out = out.concat(walkStore(path.join(dir, e.name), rel))
		else out.push(rel)
	}
	return out
}

const partFiles = () => walkStore().filter((f) => f.endsWith('.part'))

/**
 * Give the server a beat to finish the async cleanup that follows a rejected
 * upload (the temp file is unlinked once its write stream emits 'close', which is
 * a tick or two after the HTTP response). Without this the assertions could read
 * the disk mid-teardown and report a leak that isn't one — the point is to catch a
 * .part file that is stranded PERMANENTLY, not one that is milliseconds from gone.
 */
const settle = () => new Promise((r) => setTimeout(r, 250))

function writeConfig() {
	fs.writeFileSync(
		cfgPath,
		JSON.stringify({
			db_path: dbPath,
			sync_interval_minutes: 999999, // effectively never during the test
			groups: [
				{
					group_id: 'G1',
					label: 'Test Group',
					proxy: 'direct',
					shops: [{ shop_id: 'S1', shop_name: 'TestShop', api_key: 'sourcingtestkey000000001', shared_secret: 'sourcingsecret000001' }],
				},
			],
		}),
		'utf8',
	)
}

function api(pathAndQuery, opts = {}) {
	return fetch(BASE + pathAndQuery, opts).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
}

/** Upload a buffer as a raw octet-stream body, exactly as the browser XHR does. */
function upload(query, buf) {
	return fetch(`${BASE}/api/sourcing/packages/upload?${new URLSearchParams(query)}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/octet-stream' },
		body: buf,
	}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
}

/**
 * Start an upload, send only the first chunk, then destroy the socket — the exact
 * shape of a user closing the tab or cancelling a slow transfer. Declaring a
 * Content-Length far larger than what we send is what makes the server see an
 * INCOMPLETE request (req.complete === false) rather than a clean end.
 */
function abortMidUpload(query) {
	return new Promise((resolve) => {
		const req = http.request(
			{
				host: '127.0.0.1',
				port: PORT,
				method: 'POST',
				path: `/api/sourcing/packages/upload?${new URLSearchParams(query)}`,
				headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(BIG_ZIP.length * 4) },
			},
			() => {},
		)
		req.on('error', () => {}) // destroying our own request surfaces here — expected
		req.write(BIG_ZIP.subarray(0, 4096), () => {
			setTimeout(() => {
				req.destroy()
				// Give the server a beat to run its 'close' handler.
				setTimeout(resolve, 400)
			}, 60)
		})
	})
}

async function waitForHealth(child, timeoutMs = 20000) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (child.exitCode != null) throw new Error(`server exited early (code ${child.exitCode})`)
		try {
			const r = await fetch(BASE + '/api/health')
			if (r.ok) return true
		} catch {
			/* not up yet */
		}
		await new Promise((res) => setTimeout(res, 400))
	}
	throw new Error('server did not become healthy in time')
}

async function main() {
	writeConfig()

	const child = spawn(process.execPath, [path.resolve(__dirname, '../src/server/index.js')], {
		env: {
			...process.env,
			PORT: String(PORT),
			DASHBOARD_CONFIG_PATH: cfgPath,
			DASHBOARD_OWNER_PASSWORD: '',
			DASHBOARD_PACKER_PASSWORD: '',
			DASHBOARD_SHOPPER_PASSWORD: '',
		},
		stdio: ['ignore', 'ignore', 'pipe'],
	})
	let stderr = ''
	child.stderr.on('data', (d) => (stderr += d.toString()))

	try {
		await waitForHealth(child)

		// ── Taxonomy ────────────────────────────────────────────────────────────
		console.log('\n[1] Taxonomy + supplier CRUD')
		const meta = await api('/api/sourcing/meta')
		assert(
			meta.status === 200 && (meta.body.categories || []).map((c) => c.id).join(',') === 'phone_case,grip,charm',
			'GET /meta returns the three product categories in order',
		)
		assert((meta.body.statuses || []).some((s) => s.id === 'new'), 'GET /meta returns the workflow statuses')

		// ── Supplier CRUD ───────────────────────────────────────────────────────
		const created = await api('/api/sourcing/suppliers', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Huaqiangbei Cases', location: 'HQB', wechat: 'wx-hqb', qq: '812345678' }),
		})
		assert(created.status === 200 && created.body.supplier.id > 0, 'POST /suppliers creates a supplier')
		const supId = created.body.supplier.id
		assert(Array.isArray(created.body.suppliers), 'the create response returns the refreshed supplier list')
		// The chat handles are the point of this registry (these suppliers publish on
		// WeChat/QQ), so assert they round-trip rather than being quietly dropped.
		assert(created.body.supplier.wechat === 'wx-hqb' && created.body.supplier.qq === '812345678', `the WeChat/QQ handles persist (got "${created.body.supplier.wechat}"/"${created.body.supplier.qq}")`)
		const listedHandles = (created.body.suppliers || []).find((s) => s.id === supId)
		assert(listedHandles && listedHandles.wechat === 'wx-hqb', 'and are returned by the supplier list the UI renders from')

		const dup = await api('/api/sourcing/suppliers', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'huaqiangbei cases' }),
		})
		assert(dup.status === 409, `a case-insensitive duplicate name is rejected with 409 (got ${dup.status})`)

		const blank = await api('/api/sourcing/suppliers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '   ' }) })
		assert(blank.status === 400, `a blank supplier name is rejected with 400 (got ${blank.status})`)

		const renamed = await api(`/api/sourcing/suppliers/${supId}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ location: 'Futian' }),
		})
		assert(renamed.status === 200 && renamed.body.supplier.location === 'Futian' && renamed.body.supplier.name === 'Huaqiangbei Cases', 'PUT /suppliers/:id patches one field, keeps the rest')
		assert(renamed.body.supplier.wechat === 'wx-hqb' && renamed.body.supplier.qq === '812345678', 'a partial update preserves the untouched chat handles')
		const missing = await api('/api/sourcing/suppliers/99999', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x' }) })
		assert(missing.status === 404, `PUT on a missing supplier is 404 (got ${missing.status})`)

		// ── Upload: the happy path ──────────────────────────────────────────────
		console.log('\n[2] Streaming upload')
		const up = await upload({ supplier_id: supId, category: 'phone_case', filename: 'Spring Cases.zip' }, BIG_ZIP)
		assert(up.status === 200 && up.body.package.id > 0, `a valid zip uploads (got ${up.status})`)
		const pkg = up.body.package
		assert(pkg.size_bytes === BIG_ZIP.length, `the recorded size matches the bytes sent (${pkg.size_bytes} vs ${BIG_ZIP.length})`)
		assert(pkg.sha256 === sha256(BIG_ZIP), 'the sha256 is computed over the streamed bytes correctly')
		assert(pkg.title === 'Spring Cases', 'the title is derived from the filename when not supplied')
		assert(pkg.status === 'new', 'a fresh package starts at status "new"')

		const onDisk = path.join(storeRoot, String(supId), 'phone_case', pkg.stored_name)
		assert(fs.existsSync(onDisk), 'the bytes are stored at <root>/<supplierId>/<category>/<stored_name>')
		assert(Buffer.compare(fs.readFileSync(onDisk), BIG_ZIP) === 0, 'the stored file is byte-identical to what was uploaded')
		assert(partFiles().length === 0, 'the temp .part file was renamed away, not left behind')
		assert(pkg.stored_name !== 'Spring Cases.zip' && /^\d+-[0-9a-f]+\.zip$/.test(pkg.stored_name), 'the on-disk name is a generated token, never the client filename')

		// An empty-but-valid zip is legitimate and must be accepted.
		const upEmptyZip = await upload({ supplier_id: supId, category: 'charm', filename: 'nothing-yet.zip' }, EMPTY_ZIP)
		assert(upEmptyZip.status === 200, `a valid EMPTY zip archive (PK\\x05\\x06) is accepted (got ${upEmptyZip.status})`)

		// ── Upload: every rejection path leaves no trace ────────────────────────
		console.log('\n[3] Upload rejections leave nothing on disk')
		const notZip = await upload({ supplier_id: supId, category: 'grip', filename: 'sneaky.zip' }, NOT_A_ZIP)
		assert(notZip.status === 400 && notZip.body.code === 'NOT_ZIP', `a non-zip payload is rejected with NOT_ZIP (got ${notZip.status}/${notZip.body && notZip.body.code})`)

		// CONCURRENTLY, because the leak this guards is a race and a lone sequential
		// upload almost never loses it. fs.createWriteStream() opens the temp file
		// asynchronously; when the event loop is busy the first chunk arrives before
		// that open lands, so unlinking on rejection returns ENOENT (silently — the
		// unlink helper only warns) and the still-pending open then re-creates the
		// file. Cleanup must therefore wait for the stream to close. Measured at 196
		// of 200 rejected uploads stranded a file before that fix, 0 after.
		const batch = await Promise.all(
			Array.from({ length: 12 }, (_, i) => upload({ supplier_id: supId, category: 'grip', filename: `sneaky-${i}.zip` }, NOT_A_ZIP)),
		)
		assert(
			batch.every((r) => r.status === 400 && r.body.code === 'NOT_ZIP'),
			`a concurrent burst of non-zip uploads is all rejected (${batch.filter((r) => r.status === 400).length}/12)`,
		)
		await settle()
		assert(partFiles().length === 0, `rejected uploads leave NO orphaned .part files, even under concurrency (found ${partFiles().length}: ${partFiles().slice(0, 3).join(', ') || 'none'})`)

		const empties = await Promise.all(
			Array.from({ length: 6 }, () => upload({ supplier_id: supId, category: 'grip', filename: 'empty.zip' }, Buffer.alloc(0))),
		)
		assert(
			empties.every((r) => r.status === 400 && r.body.code === 'EMPTY'),
			`an empty body is rejected with EMPTY (${empties.filter((r) => r.status === 400).length}/6)`,
		)
		await settle()
		assert(partFiles().length === 0, `empty uploads leave no .part file behind (found ${partFiles().length}: ${partFiles().slice(0, 3).join(', ') || 'none'})`)

		const badSupplier = await upload({ supplier_id: 99999, category: 'grip', filename: 'x.zip' }, EMPTY_ZIP)
		assert(badSupplier.status === 404, `uploading to an unknown supplier is 404 (got ${badSupplier.status})`)
		const badCategory = await upload({ supplier_id: supId, category: 'weapons', filename: 'x.zip' }, EMPTY_ZIP)
		assert(badCategory.status === 400, `an unknown category is rejected with 400 (got ${badCategory.status})`)
		assert(!fs.existsSync(path.join(storeRoot, String(supId), 'weapons')), 'no directory is created for an invalid category')

		// An ABANDONED upload (tab closed, Wi-Fi dropped, Cancel pressed) must not
		// orphan its half-written temp file. Node surfaces both abort shapes — RST
		// and a graceful mid-body FIN — as an ECONNRESET 'error' on the request, so
		// the handler's req.on('error') cleanup is what keeps the store clean. This
		// assertion fails with a stranded .part file the moment that is dropped, and
		// stranded parts are exactly what would fill the volume on a feature sized
		// for 500 MB folders, where cancelling a slow upload is routine.
		const beforeAbort = (await api(`/api/sourcing/packages?supplier_id=${supId}`)).body.packages.length
		await abortMidUpload({ supplier_id: supId, category: 'grip', filename: 'abandoned.zip' })
		await settle()
		assert(partFiles().length === 0, `an ABORTED upload leaves no orphaned .part file (found ${partFiles().join(', ') || 'none'})`)
		const afterAbort = (await api(`/api/sourcing/packages?supplier_id=${supId}`)).body.packages
		assert(afterAbort.length === beforeAbort, `an aborted upload creates no index row (${beforeAbort} → ${afterAbort.length})`)

		// Path traversal in the client-supplied filename must be neutralised.
		const traversal = await upload({ supplier_id: supId, category: 'grip', filename: '../../../../evil.zip' }, EMPTY_ZIP)
		assert(traversal.status === 200, 'a traversal-shaped filename is accepted (sanitised, not rejected)')
		assert(traversal.body.package.original_filename === 'evil.zip', `the traversal prefix is stripped from original_filename (got ${traversal.body.package.original_filename})`)
		assert(!fs.existsSync(path.join(tmpDir, 'evil.zip')) && !fs.existsSync(path.join(tmpDir, '..', 'evil.zip')), 'nothing was written outside the library root')

		// ── Listing + filtering ─────────────────────────────────────────────────
		console.log('\n[4] Listing, filtering and supplier counts')
		const all = await api(`/api/sourcing/packages?supplier_id=${supId}`)
		assert(all.status === 200 && all.body.packages.length === 3, `all 3 accepted packages are listed (got ${all.body.packages.length})`)
		const byCat = await api(`/api/sourcing/packages?supplier_id=${supId}&category=phone_case`)
		assert(byCat.body.packages.length === 1, `filtering by category narrows the list (got ${byCat.body.packages.length})`)
		const byQuery = await api(`/api/sourcing/packages?supplier_id=${supId}&q=Spring`)
		assert(byQuery.body.packages.length === 1 && byQuery.body.packages[0].id === pkg.id, 'free-text search matches the title')
		const noMatch = await api(`/api/sourcing/packages?supplier_id=${supId}&q=zzz-nothing`)
		assert(noMatch.body.packages.length === 0, 'a search with no match returns an empty list')

		const supList = await api('/api/sourcing/suppliers')
		const supRow = (supList.body.suppliers || []).find((s) => s.id === supId)
		assert(supRow && supRow.package_count === 3, `the supplier list carries a live package count (got ${supRow && supRow.package_count})`)
		assert(supRow && supRow.package_counts.phone_case === 1 && supRow.package_counts.charm === 1, 'and the per-category breakdown')

		// ── Download ────────────────────────────────────────────────────────────
		console.log('\n[5] Download')
		const dl = await fetch(`${BASE}/api/sourcing/packages/${pkg.id}/download`)
		const dlBuf = Buffer.from(await dl.arrayBuffer())
		assert(dl.status === 200, `download returns 200 (got ${dl.status})`)
		assert(Buffer.compare(dlBuf, BIG_ZIP) === 0, 'the downloaded bytes are identical to what was uploaded')
		assert(String(dl.headers.get('content-type')).includes('zip'), 'download is served as a zip')
		assert(String(dl.headers.get('content-disposition')).includes('Spring Cases.zip'), `download restores the ORIGINAL filename (got ${dl.headers.get('content-disposition')})`)
		const dlMissing = await api('/api/sourcing/packages/99999/download')
		assert(dlMissing.status === 404, `downloading an unknown package is 404 (got ${dlMissing.status})`)

		// A row whose bytes vanished from disk must report 410 Gone, not stream a 200
		// of nothing (the operator needs to know the file, not the record, is lost).
		const orphanRow = (await api(`/api/sourcing/packages?supplier_id=${supId}&category=charm`)).body.packages[0]
		fs.unlinkSync(path.join(storeRoot, String(supId), 'charm', orphanRow.stored_name))
		const dlGone = await api(`/api/sourcing/packages/${orphanRow.id}/download`)
		assert(dlGone.status === 410, `a package whose file is missing downloads as 410 Gone (got ${dlGone.status})`)

		// ── Re-categorise moves the file ────────────────────────────────────────
		console.log('\n[6] Re-categorise moves the stored file')
		const moved = await api(`/api/sourcing/packages/${pkg.id}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ category: 'grip', status: 'listed', title: 'Spring Cases v2' }),
		})
		assert(moved.status === 200 && moved.body.package.category === 'grip' && moved.body.package.status === 'listed', 'PUT re-categorises and re-statuses the package')
		assert(moved.body.package.title === 'Spring Cases v2', 'PUT renames the title')
		const newPath = path.join(storeRoot, String(supId), 'grip', pkg.stored_name)
		assert(fs.existsSync(newPath) && !fs.existsSync(onDisk), 'the stored file MOVED into the new category folder — index and disk agree')
		assert(Buffer.compare(fs.readFileSync(newPath), BIG_ZIP) === 0, 'the moved file is still byte-identical')
		const stillDownloads = await fetch(`${BASE}/api/sourcing/packages/${pkg.id}/download`)
		assert(stillDownloads.status === 200, 'the package still downloads from its new location')

		const badCat = await api(`/api/sourcing/packages/${pkg.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ category: 'weapons' }) })
		assert(badCat.status === 400, `PUT with an invalid category is rejected (got ${badCat.status})`)
		const badStatus = await api(`/api/sourcing/packages/${pkg.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'deleted' }) })
		assert(badStatus.status === 400, `PUT with an invalid status is rejected (got ${badStatus.status})`)
		const pkgAfterBad = (await api(`/api/sourcing/packages?supplier_id=${supId}`)).body.packages.find((p) => p.id === pkg.id)
		assert(pkgAfterBad && pkgAfterBad.category === 'grip' && pkgAfterBad.status === 'listed', 'a rejected PUT changed nothing')
		const putMissing = await api('/api/sourcing/packages/99999', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'new' }) })
		assert(putMissing.status === 404, `PUT on a missing package is 404 (got ${putMissing.status})`)

		// ── Delete takes the file with it ───────────────────────────────────────
		console.log('\n[7] Delete + cascade clean up the on-disk store')
		const del = await api(`/api/sourcing/packages/${pkg.id}`, { method: 'DELETE' })
		assert(del.status === 200, `DELETE /packages/:id succeeds (got ${del.status})`)
		assert(!fs.existsSync(newPath), 'deleting a package removes its file from disk')
		const delMissing = await api(`/api/sourcing/packages/${pkg.id}`, { method: 'DELETE' })
		assert(delMissing.status === 404, `deleting the same package again is 404 (got ${delMissing.status})`)

		const remaining = (await api(`/api/sourcing/packages?supplier_id=${supId}`)).body.packages
		assert(remaining.length === 2, `2 packages remain before the cascade (got ${remaining.length})`)

		const cascade = await api(`/api/sourcing/suppliers/${supId}`, { method: 'DELETE' })
		assert(cascade.status === 200 && cascade.body.removed_packages === 2, `deleting the supplier cascades to its 2 packages (got ${cascade.body && cascade.body.removed_packages})`)
		assert((await api(`/api/sourcing/packages?supplier_id=${supId}`)).body.packages.length === 0, 'no package rows survive the cascade')
		assert(!fs.existsSync(path.join(storeRoot, String(supId))), "the supplier's whole folder is removed from disk")
		assert(walkStore().length === 0, `the on-disk store is empty — no orphaned files anywhere (found ${walkStore().join(', ') || 'none'})`)
		const cascadeAgain = await api(`/api/sourcing/suppliers/${supId}`, { method: 'DELETE' })
		assert(cascadeAgain.status === 404, `deleting the same supplier again is 404 (got ${cascadeAgain.status})`)

		// ── The catalog projection ──────────────────────────────────────────────
		// Everything below is the SECOND half of the Sourcing page: the product
		// catalog. It is served by GET /api/sourcing/catalog but written through
		// the /api/route/* endpoints, and the point of testing it over HTTP is
		// precisely that split — an edit posted to one endpoint has to show up in
		// the other's response, or the page's "save then refresh" cycle silently
		// discards the operator's work. scripts/test-sourcing-catalog.js covers
		// the projection's own logic in depth against a direct database.
		console.log('\n[8] Catalog projection — write on /api/route/*, read on /api/sourcing/catalog')

		const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

		// The server imports supplier_catalog.xlsx on boot. Without listing photos
		// those product_map rows are excluded from this projection, so the baseline
		// may be 0 on a throwaway DB — that is the filter under test, not a failure.
		const baselineCat = await api('/api/sourcing/catalog')
		const baseline = baselineCat.body.totals.products
		assert(baselineCat.status === 200 && baselineCat.body.ok === true, `GET /api/sourcing/catalog returns the read model (got ${baselineCat.status})`)
		assert(
			baselineCat.body.products.every((p) => p.image_url),
			'the baseline catalog contains only products with a photo',
		)

		const SHOP = 'QA Case Lab'
		const GHOST = 'QA Unregistered Shop'
		const supDir = await api('/api/route/suppliers', json('POST', { shop_name: SHOP, stall: 'A2-29', mall: '通信' }))
		assert(supDir.status === 200, `POST /api/route/suppliers registers a stall supplier (got ${supDir.status})`)

		const CASE_TITLE = 'QA Fixture Cherry "Sweet" Case, Pink for iPhone 16'
		const AIRPODS_TITLE = 'QA Fixture Kawaii AirPods Pro 2 Case'
		const mkCase = await api('/api/route/product-map', json('POST', { title: CASE_TITLE, shop_name: SHOP.toLowerCase(), cost_case: '4.505' }))
		assert(mkCase.status === 201, `POST /api/route/product-map creates a catalog product (got ${mkCase.status})`)
		const mkAirpods = await api('/api/route/product-map', json('POST', { title: AIRPODS_TITLE, shop_name: GHOST, stall: 'X1' }))
		assert(mkAirpods.status === 201, `POST creates the AirPods fixture (got ${mkAirpods.status})`)

		// No photo yet → the projection must refuse to list them. They stay in
		// product_map for the Route tab; Sourcing only shows what a buyer can see.
		let cat = await api('/api/sourcing/catalog')
		assert(cat.body.totals.products === baseline, `imageless products are excluded from the catalog (${baseline} → ${cat.body.totals.products})`)
		assert(!cat.body.products.some((p) => p.title === CASE_TITLE || p.title === AIRPODS_TITLE), 'neither fixture title appears without a photo')
		assert(!(cat.body.gap_types || []).some((g) => g.id === 'no_image'), 'the "no image" gap chip is gone — those rows are filtered, not flagged')

		// Attach listing photos the same way a live sync would, then both appear.
		const Database = require('better-sqlite3')
		const seedDb = new Database(dbPath)
		try {
			const ins = seedDb.prepare(
				`INSERT INTO listings (listing_id, shop_id, title, primary_image_url, state)
				 VALUES (?, 'S1', ?, ?, 'active')`,
			)
			ins.run(900001, CASE_TITLE, 'https://example.test/case.png')
			ins.run(900002, AIRPODS_TITLE, 'https://example.test/airpods.png')
		} finally {
			seedDb.close()
		}

		cat = await api('/api/sourcing/catalog')
		assert(cat.body.totals.products === baseline + 2, `both photographed products are projected (${baseline} → ${cat.body.totals.products})`)
		assert(cat.body.totals.with_image === cat.body.totals.products, 'with_image always equals the product count')
		assert(Array.isArray(cat.body.supplier_product_groups), 'the API ships the read-only physical-product groups used by the supplier drawer')

		const caseRow = cat.body.products.find((p) => p.title === CASE_TITLE)
		assert(caseRow && caseRow.image_url === 'https://example.test/case.png', `the case carries its photo (got ${caseRow && caseRow.image_url})`)
		assert(caseRow && caseRow.product_type === 'iphone_case' && caseRow.product_type_source === 'derived', `the type is derived from the title (got ${caseRow && caseRow.product_type})`)
		assert(caseRow && caseRow.cost_case === 4.51, `the price posted alongside the mapping is stored, rounded to money (got ${caseRow && caseRow.cost_case})`)
		assert(caseRow && caseRow.stall_effective === 'A2-29' && caseRow.stall_source === 'directory', 'the stall is borrowed from the directory the other endpoint wrote')
		assert(caseRow && caseRow.location.building_id === 'tongxin' && caseRow.location.floor === 2, `and resolved to a building and floor (got ${caseRow && caseRow.location.building_id})`)
		assert(caseRow && caseRow.supplier_in_directory === true, 'the supplier is matched case-insensitively against the directory')
		const caseGroup = cat.body.supplier_product_groups.find((g) => g.product_ids.includes(caseRow.id))
		assert(caseGroup && caseGroup.representative_id === caseRow.id && caseGroup.listing_count === 1, 'the supplier drawer group addresses the underlying listing row by id')
		const caseSupplier = cat.body.suppliers.find((s) => s.shop_name === SHOP)
		assert(caseSupplier && caseSupplier.unique_product_count === 1, 'the supplier exposes a distinct physical-product count without changing product_count')
		const activePicker = await api('/api/route/products')
		const pickerCase = (activePicker.body.products || []).find((p) => p.title === CASE_TITLE)
		assert(activePicker.status === 200 && pickerCase, 'the shared Design Switch/Add Order picker includes the active catalog product')
		assert(
			pickerCase && pickerCase.shop_name === SHOP.toLowerCase() && pickerCase.stall === '',
			'the picker carries the same stored supplier identity as product_map (directory inference stays projection-only)',
		)

		const ghostRow = cat.body.products.find((p) => p.shop_name === GHOST)
		assert(ghostRow && ghostRow.product_type === 'airpods_case', `an AirPods listing is not filed as a phone case (got ${ghostRow && ghostRow.product_type})`)
		assert(ghostRow && ghostRow.gaps.includes('unlisted_supplier') && ghostRow.gaps.includes('no_price'), `its gaps name what is missing (got ${ghostRow && ghostRow.gaps.join(' ')})`)
		assert(ghostRow && !ghostRow.gaps.includes('no_image'), 'a photographed product never carries a no_image gap')

		const metaTypes = await api('/api/sourcing/meta')
		assert(
			(metaTypes.body.product_types || []).map((t) => t.id).join(',') === 'iphone_case,airpods_case,apple_watch_band,ipad_case,grip,charm,other',
			'GET /meta serves the product taxonomy the page filters on',
		)
		assert((metaTypes.body.gap_types || []).some((g) => g.id === 'no_supplier'), 'and the gap taxonomy behind the filter chips')
		assert(!(metaTypes.body.gap_types || []).some((g) => g.id === 'no_image'), 'meta no longer advertises a no_image chip')

		// A typo must never become a permanent override rendering a dead badge.
		const badType = await api('/api/route/product-map', json('POST', { title: 'QA Fixture Typo Product', product_type: 'iphone-case' }))
		assert(badType.status === 400, `an unknown product_type is rejected with 400 (got ${badType.status})`)
		assert((await api('/api/sourcing/catalog')).body.totals.products === baseline + 2, 'and the rejected write created nothing')

		// The override + a price change, applied through the route endpoint and
		// read back off the projection — the page's exact save/refresh cycle.
		const edit = { id: caseRow.id, title: CASE_TITLE, shop_name: SHOP, stall: 'A2-29' }
		const edited = await api('/api/route/product-map', json('PUT', { ...edit, product_type: 'airpods_case', cost_case: 9, cost_grip: 1.25 }))
		assert(edited.status === 200, `PUT /api/route/product-map saves the edit (got ${edited.status})`)
		const afterEdit = (await api('/api/sourcing/catalog')).body.products.find((p) => p.id === caseRow.id)
		assert(afterEdit.product_type === 'airpods_case' && afterEdit.product_type_source === 'override', 'the operator override survives to the projection')
		assert(afterEdit.cost_total === 10.25, `the unit cost sums the components that have a price (got ${afterEdit.cost_total})`)
		const cleared = await api('/api/route/product-map', json('PUT', { ...edit, product_type: '' }))
		assert(cleared.status === 200 && (await api('/api/sourcing/catalog')).body.products.find((p) => p.id === caseRow.id).product_type === 'iphone_case', 'clearing the override re-derives from the title')
		const renameAttempt = await api(
			'/api/route/product-map',
			json('PUT', { ...edit, title: CASE_TITLE + ' renamed' }),
		)
		assert(renameAttempt.status === 409 && renameAttempt.body.code === 'IMMUTABLE', 'a product title cannot be renamed out from under historical orders')

		// ── CSV export ──────────────────────────────────────────────────────────
		const csvRes = await fetch(`${BASE}/api/sourcing/catalog/export.csv`)
		// Read the BYTES: Response.text() strips a leading BOM as part of decoding,
		// so the thing under test would be invisible through it.
		const csvBytes = Buffer.from(await csvRes.arrayBuffer())
		assert(csvRes.status === 200, `GET /catalog/export.csv returns 200 (got ${csvRes.status})`)
		assert(String(csvRes.headers.get('content-type')).includes('text/csv'), 'served as CSV')
		assert(String(csvRes.headers.get('content-disposition')).includes('attachment'), 'and as a download')
		assert(csvBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'it opens with a UTF-8 BOM, so Excel does not mojibake the Chinese stall names')
		const lines = csvBytes.toString('utf8').replace(/^\uFEFF/, '').split('\r\n')
		const totalNow = (await api('/api/sourcing/catalog')).body.totals.products
		assert(lines.length === totalNow + 1, `a header plus one line per product (${lines.length} lines for ${totalNow} products)`)
		assert(lines[0].startsWith('"Product Title","Product Type"'), `the header names the columns (got ${lines[0].slice(0, 40)})`)
		// The fixture title carries both CSV hazards. Getting either wrong shifts
		// every following column, which an operator only notices once in Excel.
		const caseLine = lines.find((l) => l.startsWith('"QA Fixture Cherry '))
		assert(caseLine === undefined ? false : caseLine.startsWith('"QA Fixture Cherry ""Sweet"" Case, Pink for iPhone 16",'), 'quotes are doubled and a comma inside a cell does not split it')
		assert(caseLine && caseLine.includes('"Tongxin","2"'), 'the resolved building and floor are exported')
		const ghostLine = lines.find((l) => l.startsWith(`"${AIRPODS_TITLE}"`))
		assert(ghostLine && ghostLine.includes('"Tongxin",""'), 'an unreadable floor exports as blank, never as the 999 sentinel')
		assert(ghostLine && ghostLine.includes('"no"'), 'and a supplier missing from the directory is called out in the export')

		// ── Delete ──────────────────────────────────────────────────────────────
		const delProduct = await api('/api/route/product-map', json('DELETE', { id: caseRow.id }))
		assert(delProduct.status === 200, `DELETE /api/route/product-map removes a product (got ${delProduct.status})`)
		const shrunk = await api('/api/sourcing/catalog')
		assert(shrunk.body.totals.products === baseline + 1, `the projection shrinks with it (${baseline + 2} → ${shrunk.body.totals.products})`)
		assert(shrunk.body.suppliers.find((s) => s.shop_name === SHOP).product_count === 0, 'and the supplier rollup drops back to zero')
		assert(
			!(await api('/api/route/products')).body.products.some((p) => p.title === CASE_TITLE),
			'the same retirement immediately removes the product from Design Switch/Add Order',
		)
		const staleEdit = await api('/api/route/product-map', json('PUT', edit))
		assert(staleEdit.status === 409 && staleEdit.body.code === 'CONFLICT', 'a stale editor cannot resurrect the retired product')
		const staleManualOrder = await api(
			'/api/route/manual-order',
			json('POST', {
				items: [
					{
						source: 'catalog',
						catalog_id: caseRow.id,
						title: CASE_TITLE,
						listing_id: 900001,
						quantity: 1,
					},
				],
			}),
		)
		assert(
			staleManualOrder.status === 409 &&
				staleManualOrder.body.code === 'CATALOG_PRODUCT_UNAVAILABLE',
			'a stale Add Order card is rejected atomically by the server',
		)
	} catch (e) {
		failures++
		console.error(`  FAIL — ${e.message}`)
		if (stderr.trim()) console.error('  --- server stderr ---\n' + stderr.split('\n').slice(-15).join('\n'))
	} finally {
		child.kill('SIGKILL')
	}
}

main()
	.catch((e) => {
		failures++
		console.error('  FATAL —', e.message)
	})
	.finally(() => {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true })
		} catch {
			/* ignore */
		}
		console.log('')
		if (failures > 0) {
			console.error(`${failures} assertion(s) FAILED`)
			process.exit(1)
		}
		console.log('All Sourcing API assertions passed.')
	})
