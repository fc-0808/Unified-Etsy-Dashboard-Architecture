'use strict'

/**
 * Unit tests for the Shipping tab's 4PX compensation desk.
 *
 * The desk is the working list of tracking numbers the operator will send to
 * 4PX for refund / compensation. These tests pin the rules that make that list
 * trustworthy:
 *
 *   · classic 4PX ids are harvested out of a messy paste;
 *   · names and currency labels in a ticket dump are not stored;
 *   · a matching parcel is linked for shop / buyer / health context;
 *   · unmatched 4PX ids still land on the desk;
 *   · duplicates are reported, never doubled;
 *   · status transitions keep contacted/resolved timestamps honest;
 *   · the shipped UI escapes operator-controlled text.
 *
 * Run: node scripts/test-shipping-compensation.js
 */

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const express = require('express')

const { initDb } = require('../src/db/setup')
const comp = require('../src/orders/shipping-compensation')

let failed = 0
function check(name, fn) {
	try {
		fn()
		console.log(`  ✓ ${name}`)
	} catch (err) {
		failed += 1
		console.error(`  ✗ ${name}`)
		console.error(`    ${err.message}`)
	}
}

async function checkAsync(name, fn) {
	try {
		await fn()
		console.log(`  ✓ ${name}`)
	} catch (err) {
		failed += 1
		console.error(`  ✗ ${name}`)
		console.error(`    ${err.message}`)
	}
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ued-ship-comp-'))
const db = initDb(path.join(tmpDir, 'test.db'))
const now = 1_800_000_000

db.prepare('INSERT INTO groups (group_id, label) VALUES (?, ?)').run('g1', 'Group 1')
db.prepare('INSERT INTO shops (shop_id, group_id, shop_name) VALUES (?, ?, ?)').run('1', 'g1', 'Y2KiPhoneCases')

function seedParcel({ id, tracking, health = 'critical', disposed = 1, status = 'exception', name = 'Elisabeth Johnson' }) {
	db.prepare(
		`
    INSERT INTO receipts (
      receipt_id, shop_id, group_id, name, etsy_created_at, etsy_updated_at,
      tracking_code, fourpx_consignment_no, fourpx_tracking_no,
      tracking_status, tracking_last_event, tracking_last_event_at,
      tracking_health, tracking_is_disposed, tracking_checked_at, shipment_notified_at
    ) VALUES (
      @id, '1', 'g1', @name, @now, @now,
      @tracking, @consignment, @tracking,
      @status, 'Parcel Disposal', @now,
      @health, @disposed, @now, @now
    )
  `,
	).run({
		id,
		name,
		now,
		tracking,
		consignment: `C-${id}`,
		status,
		health,
		disposed,
	})
}

seedParcel({ id: 501, tracking: '4PX3003001181713CN' })
seedParcel({ id: 502, tracking: '4PX3003024171982CN', disposed: 0, health: 'critical', status: 'in_transit', name: 'Maggie Smith' })

console.log('Paste extraction')

check('classic 4PX ids are harvested from a ticket dump', () => {
	const { classic, lookup } = comp.extractTrackingCandidates(
		'Hi 4PX,\nplease check 4PX3003001181713CN and 4px3003024171982cn\nBuyer Elisabeth Johnson · CN¥29.27',
	)
	assert.deepStrictEqual(classic, ['4PX3003001181713CN', '4PX3003024171982CN'])
	assert.deepStrictEqual(lookup, [])
})

check('comma / tab / Chinese punctuation separated ids still parse', () => {
	const { classic } = comp.extractTrackingCandidates('4PX3003001181713CN，4PX3003024171982CN\t4PX3003006517302CN')
	assert.deepStrictEqual(classic, ['4PX3003001181713CN', '4PX3003024171982CN', '4PX3003006517302CN'])
})

check('duplicate ids in one paste collapse to first seen', () => {
	const { classic } = comp.extractTrackingCandidates('4PX3003001181713CN\n4PX3003001181713CN')
	assert.deepStrictEqual(classic, ['4PX3003001181713CN'])
})

check('bare names and currency labels are not lookup candidates', () => {
	const { classic, lookup } = comp.extractTrackingCandidates('Elisabeth Johnson  CNY3808.56  3808.56  Y2KiPhoneCases')
	assert.deepStrictEqual(classic, [])
	assert.deepStrictEqual(lookup, [])
})

console.log('Adding to the desk')

check('a matching 4PX id links shop, buyer and disposed reason', () => {
	const result = comp.addCases(db, { tracking_number: '4PX3003001181713CN' }, { actor: 'owner', now })
	assert.strictEqual(result.added_count, 1)
	assert.strictEqual(result.duplicates.length, 0)
	const row = result.added[0]
	assert.strictEqual(row.tracking_no, '4PX3003001181713CN')
	assert.strictEqual(row.status, 'queued')
	assert.strictEqual(row.linked, true)
	assert.strictEqual(row.receipt_id, 501)
	assert.strictEqual(row.shop_name, 'Y2KiPhoneCases')
	assert.strictEqual(row.buyer_name, 'Elisabeth Johnson')
	assert.strictEqual(row.reason, 'disposed')
	assert.strictEqual(row.created_by, 'owner')
})

check('re-adding the same id is a duplicate, not a second row', () => {
	const result = comp.addCases(db, { tracking_numbers: '4PX3003001181713CN' }, { now })
	assert.strictEqual(result.added_count, 0)
	assert.strictEqual(result.duplicate_count, 1)
	assert.strictEqual(result.duplicates[0].tracking_no, '4PX3003001181713CN')
	assert.strictEqual(comp.listCases(db, { status: 'all' }).summary.total, 1)
})

check('an unmatched classic 4PX id still lands on the desk', () => {
	const result = comp.addCases(db, { tracking_number: '4PX9999999999999CN', note: 'portal dump' }, { now: now + 1 })
	assert.strictEqual(result.added_count, 1)
	const row = result.added[0]
	assert.strictEqual(row.linked, false)
	assert.strictEqual(row.receipt_id, null)
	assert.strictEqual(row.note, 'portal dump')
	assert.strictEqual(row.status, 'queued')
})

check('a bulk paste is partial-success: new + duplicate + invalid reported together', () => {
	const result = comp.addCases(
		db,
		{
			tracking_numbers: '4PX3003024171982CN\n4PX3003001181713CN\nnot-a-tracking\nElisabeth',
			note: 'Aug stuck batch',
		},
		{ now: now + 2 },
	)
	assert.strictEqual(result.added_count, 1, 'the stuck parcel is new')
	assert.strictEqual(result.duplicate_count, 1, 'the disposed parcel was already on the desk')
	assert.ok(result.added[0].reason === 'stuck')
	assert.strictEqual(result.added[0].note, 'Aug stuck batch')
})

check('a paste with nothing 4PX-shaped is refused', () => {
	assert.throws(
		() => comp.addCases(db, { tracking_numbers: 'hello CNY 12.00' }, { now }),
		(err) => err && err.status === 400 && /4PX tracking/.test(err.message),
	)
})

check('an empty paste is refused', () => {
	assert.throws(() => comp.addCases(db, { tracking_numbers: '   ' }, { now }), (err) => err && err.status === 400)
})

check('a non-text tracking payload is refused', () => {
	assert.throws(
		() => comp.addCases(db, { tracking_numbers: { nested: true } }, { now }),
		(err) => err && err.code === 'COMPENSATION_INPUT_TYPE',
	)
})

check('a note that is too long is refused', () => {
	assert.throws(
		() => comp.addCases(db, { tracking_number: '4PX3003006517302CN', note: 'x'.repeat(comp.MAX_NOTE_LENGTH + 1) }, { now }),
		(err) => err && err.code === 'COMPENSATION_NOTE_TOO_LONG',
	)
})

check('hostile note text is stored as text, not executed', () => {
	const result = comp.addCases(
		db,
		{ tracking_number: '4PX3003006517302CN', note: '<img src=x onerror=alert(1)>' },
		{ now: now + 3 },
	)
	assert.strictEqual(result.added[0].note, '<img src=x onerror=alert(1)>')
})

console.log('Status workflow')

check('queued → contacted stamps contacted_at and leaves resolved_at empty', () => {
	const queued = comp.listCases(db, { status: 'queued' }).cases.find((row) => row.tracking_no === '4PX3003024171982CN')
	const patched = comp.patchCase(db, queued.id, { status: 'contacted' }, { actor: 'owner', now: now + 10 })
	assert.strictEqual(patched.status, 'contacted')
	assert.strictEqual(patched.contacted_at, now + 10)
	assert.strictEqual(patched.resolved_at, null)
	assert.strictEqual(patched.updated_by, 'owner')
})

check('contacted → compensated stamps resolved_at and keeps contacted_at', () => {
	const row = comp.listCases(db, { status: 'contacted' }).cases.find((c) => c.tracking_no === '4PX3003024171982CN')
	const patched = comp.patchCase(db, row.id, { status: 'compensated' }, { now: now + 20 })
	assert.strictEqual(patched.status, 'compensated')
	assert.strictEqual(patched.contacted_at, now + 10)
	assert.strictEqual(patched.resolved_at, now + 20)
})

check('reopening a settled row returns it to To contact', () => {
	const row = comp.listCases(db, { status: 'compensated' }).cases[0]
	const patched = comp.patchCase(db, row.id, { status: 'queued' }, { now: now + 30 })
	assert.strictEqual(patched.status, 'queued')
	assert.strictEqual(patched.contacted_at, null)
	assert.strictEqual(patched.resolved_at, null)
})

check('open / settled filters match the summary counts', () => {
	const all = comp.listCases(db, { status: 'all' })
	assert.strictEqual(all.cases.length, all.summary.total)
	assert.strictEqual(comp.listCases(db, { status: 'open' }).total, all.summary.open)
	assert.strictEqual(comp.listCases(db, { status: 'settled' }).total, all.summary.settled)
})

check('removing a row deletes it and it can be added again', () => {
	const row = comp.listCases(db, { status: 'all' }).cases.find((c) => c.tracking_no === '4PX9999999999999CN')
	const removed = comp.removeCase(db, row.id)
	assert.strictEqual(removed.tracking_no, '4PX9999999999999CN')
	const again = comp.addCases(db, { tracking_number: '4PX9999999999999CN' }, { now: now + 40 })
	assert.strictEqual(again.added_count, 1)
})

check('copy helpers emit one tracking number per line', () => {
	const cases = [{ tracking_no: '4PXAAA' }, { tracking_no: '4PXBBB' }, { tracking_no: '4PXAAA' }]
	assert.strictEqual(comp.formatTrackingList(cases), '4PXAAA\n4PXBBB')
	assert.match(comp.formatFourpxMessage(cases), /1\. 4PXAAA/)
	assert.match(comp.formatFourpxMessage(cases), /请协助处理/)
})

console.log('HTTP surface')

;(async () => {
	const app = express()
	app.use(express.json())
	app.use((req, _res, next) => {
		req.auth = { user: 'owner', role: 'owner' }
		next()
	})
	comp.installRoutes(app, { db })
	const server = http.createServer(app)
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
	const { port } = server.address()
	const base = `http://127.0.0.1:${port}`
	const json = async (pathname, options) => {
		const response = await fetch(base + pathname, options)
		return { response, body: await response.json().catch(() => ({})) }
	}

	await checkAsync('GET lists the desk and includes tracking_keys', async () => {
		const { response, body } = await json('/api/4px/compensation-cases?status=all')
		assert.strictEqual(response.status, 200)
		assert.ok(Array.isArray(body.cases))
		assert.ok(body.summary && Number.isInteger(body.summary.total))
		assert.ok(Array.isArray(body.tracking_keys))
		assert.ok(body.tracking_keys.includes('4PX3003001181713CN'))
	})

	await checkAsync('POST adds a number and PATCH moves it', async () => {
		const created = await json('/api/4px/compensation-cases', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ tracking_number: '4PX3003000000001CN' }),
		})
		assert.strictEqual(created.response.status, 201)
		const id = created.body.added[0].id
		const patched = await json(`/api/4px/compensation-cases/${id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'contacted' }),
		})
		assert.strictEqual(patched.response.status, 200)
		assert.strictEqual(patched.body.case.status, 'contacted')
		const deleted = await json(`/api/4px/compensation-cases/${id}`, { method: 'DELETE' })
		assert.strictEqual(deleted.response.status, 200)
	})

	await checkAsync('POST rejects a non-string note', async () => {
		const { response } = await json('/api/4px/compensation-cases', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ tracking_number: '4PX3003000000002CN', note: { nested: true } }),
		})
		assert.strictEqual(response.status, 400)
	})

	await checkAsync('unknown status filter is 400, missing id is 404', async () => {
		const bad = await json('/api/4px/compensation-cases?status=drop-table')
		assert.strictEqual(bad.response.status, 400)
		const missing = await json('/api/4px/compensation-cases/999999', { method: 'DELETE' })
		assert.strictEqual(missing.response.status, 404)
	})

	await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))

	console.log('Shipped UI')
	{
		const { JSDOM, VirtualConsole } = require('jsdom')
		const html = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8')
		check('the desk markup and script sentinels ship together', () => {
			assert.ok(html.includes('id="shipCompDesk"') && html.includes('id="shipCompPaste"'))
			assert.ok(html.includes('// ══ SHIPPING COMPENSATION DESK ══'))
			assert.ok(html.includes('// ══ END SHIPPING COMPENSATION DESK ══'))
			assert.ok(html.includes('loadShipCompCases()'))
			assert.ok(!html.includes('id="shipAlertBanner"'))
			assert.ok(!html.includes('id="shipBalanceCard"'))
			assert.ok(!html.includes('.ship-balance'))
			assert.ok(!html.includes('class="ship-balance"'))
		})
		check('tracking numbers on the desk are data attributes, never inline JS', () => {
			assert.ok(/class="ship-comp-track ship-track-link" data-tracking="\$\{safeNo\}"/.test(html))
			assert.ok(!/open4pxTrackModal\('\$\{/.test(html.slice(html.indexOf('SHIPPING COMPENSATION DESK'))))
			assert.ok(html.includes("'.ship-comp-track[data-tracking]'") || html.includes('.ship-comp-track[data-tracking]'))
		})

		const jsStart = html.indexOf('// ══ SHIPPING COMPENSATION DESK ══')
		const jsEnd = html.indexOf('// ══ END SHIPPING COMPENSATION DESK ══')
		const moduleSource = html.slice(jsStart, jsEnd)
		const markupStart = html.indexOf('<section class="ship-comp-desk"')
		const markupEnd = html.indexOf('</section>', markupStart) + '</section>'.length
		const deskMarkup = html.slice(markupStart, markupEnd)
		const virtualConsole = new VirtualConsole()
		virtualConsole.on('jsdomError', () => {})
		const dom = new JSDOM(`<!doctype html><html><body>${deskMarkup}</body></html>`, {
			pretendToBeVisual: true,
			runScripts: 'dangerously',
			virtualConsole,
		})
		const { window } = dom
		window.eval(`
      const API = ''
      function showToast() {}
      function escHtml(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') }
      function escAttr(s) { return escHtml(s).replace(/'/g, '&#39;') }
      function fetchJson() { return Promise.reject(new Error('offline')) }
      ${moduleSource}
      window.renderShipCompDesk = renderShipCompDesk
    `)
		const hostile = {
			id: 9,
			tracking_no: '4PX3003001181713CN',
			status: 'queued',
			reason: 'disposed',
			note: '"/><img src=x onerror=alert(1)>',
			shop_name: '<script>alert(2)</script>',
			buyer_name: '"><img src=x onerror=alert(3)>',
			tracking_health_reason: '</div><script>alert(4)</script>',
			linked: true,
		}
		check('hostile shop, buyer and note text cannot escape the desk markup', () => {
			window.renderShipCompDesk({
				cases: [hostile],
				summary: { queued: 1, contacted: 0, settled: 0, total: 1 },
				tracking_keys: ['4PX3003001181713CN'],
			})
			const root = window.document.getElementById('shipCompList')
			assert.strictEqual(root.querySelectorAll('script, img').length, 0)
			assert.ok(root.textContent.includes('<script>alert(2)</script>'))
			assert.ok(root.querySelector('.ship-comp-row-note').value.includes('<img src=x'))
		})
		check('an empty queued list explains how to add numbers', () => {
			window._shipCompFilter = 'queued'
			window.renderShipCompDesk({ cases: [], summary: { queued: 0, contacted: 0, settled: 0, total: 0 } })
			assert.match(window.document.getElementById('shipCompList').textContent, /Paste 4PX codes/)
		})
		dom.window.close()
	}

	db.close()
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true })
	} catch {}

	if (failed) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log('\nPASS — 4PX compensation desk')
})().catch((err) => {
	console.error(err)
	process.exit(1)
})
