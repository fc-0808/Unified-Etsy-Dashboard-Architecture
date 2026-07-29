/**
 * shop-sync.js — durable offline write-queue for Shopping Mode.
 *
 * ONE shared module, THREE consumers (a single source of truth so they can never
 * drift):
 *   1. The page (shop.html)   — enqueues each purchase/cost tap, flushes live.
 *   2. The service worker     — replays the queue via Background Sync when the OS
 *                               restores connectivity, even if the app is closed.
 *   3. A Node regression test — exercises the pure coalescing / id logic.
 *
 * WHY THIS EXISTS
 * ----------------------------------------------------------------------------
 * Shopping Mode already applies each tap optimistically and retries over the
 * network. But the retry queue used to live only in a RAM `Map`: if the phone
 * evicted the backgrounded tab (routine on mobile between mall stalls), crashed,
 * or rebooted while offline, every un-synced "Purchased" tap was silently lost —
 * the UI had already shown it as bought, so the next server reconcile quietly
 * reverted it, causing double-buys or missed packing.
 *
 * The fix is the industry-standard offline-first pattern (cf. Workbox Background
 * Sync): persist every mutation to IndexedDB the instant it's made, replay it
 * (idempotently, last-writer-wins) until the server acknowledges it, and only then
 * delete it. Nothing a shopper taps can be lost to a dead battery or a dead zone.
 *
 * DESIGN NOTES
 *   • Entries are keyed so repeated taps on the SAME target COALESCE into one
 *     pending write (the latest desired state), instead of a growing backlog of
 *     superseded ops — the queue stays O(distinct targets), not O(taps).
 *   • Server writes are idempotent: /api/shop/assign upserts absolute component
 *     statuses and /api/shop/cost sets an absolute price, so replaying an op any
 *     number of times converges to the same state. This is what makes at-least-once
 *     Background Sync delivery safe.
 *   • No DOM / window access here, so the exact same code runs in the page, in the
 *     service-worker global, and under Node (which lacks IndexedDB — the IDB
 *     helpers simply reject there, and the pure helpers are what the test drives).
 */
;(function (root, factory) {
	if (typeof module === 'object' && module.exports) {
		module.exports = factory() // Node (tests)
	} else {
		root.ShopSync = factory() // browser window + service-worker self
	}
})(typeof self !== 'undefined' ? self : this, function () {
	'use strict'

	const DB_NAME = 'shop-sync'
	const DB_VERSION = 1
	const STORE = 'ops'
	// Background Sync tag — the SW listens for this to drain the queue.
	const SYNC_TAG = 'shop-sync-flush'
	const ASSIGN_URL = '/api/shop/assign'
	const COST_URL = '/api/shop/cost'
	const SEP = '\u0000' // NUL — safe key separator (never appears in titles/keys)

	// ── Pure helpers (deterministic; unit-tested in Node) ───────────────────────

	/** Stable coalescing key for a per-line purchase-status write. */
	function assignOpId(receiptId, itemKey) {
		return 'assign' + SEP + receiptId + SEP + itemKey
	}

	/** Stable coalescing key for a price write (per product-component, or per charm). */
	function costOpId(body) {
		if (body && body.kind === 'product') {
			return 'cost' + SEP + 'p' + SEP + String(body.title) + SEP + String(body.part || '')
		}
		return 'cost' + SEP + 'c' + SEP + String(body && body.code)
	}

	/**
	 * Build/merge an assign queue entry. Merging preserves the line identity and any
	 * previously-queued-but-unsent component changes, layering the newest patch on
	 * top — so a case-then-charm tap on the same line becomes ONE write carrying
	 * both, and the last value for any given component always wins.
	 *
	 * @param {object|null} prev   the existing queued entry for this line, if any.
	 * @param {{receipt_id:(number|string), item_key:string, title:*, patch:object}} change
	 * @param {number} now         Date.now() (injectable for tests).
	 */
	function makeAssignEntry(prev, change, now) {
		const base = prev && prev.body ? Object.assign({}, prev.body) : {}
		const body = Object.assign(base, change.patch)
		body.receipt_id = change.receipt_id
		body.item_key = change.item_key
		if (change.title != null) body.title = change.title
		return { id: assignOpId(change.receipt_id, change.item_key), url: ASSIGN_URL, body: body, ts: now }
	}

	/** Build a cost queue entry (replaces any prior queued price for the same target). */
	function makeCostEntry(body, now) {
		return { id: costOpId(body), url: COST_URL, body: Object.assign({}, body), ts: now }
	}

	// ── IndexedDB persistence (browser + service worker only) ────────────────────
	// In Node (no indexedDB global) these reject; callers there use the pure helpers.

	function hasIDB() {
		return typeof indexedDB !== 'undefined' && indexedDB !== null
	}

	function open() {
		return new Promise(function (resolve, reject) {
			if (!hasIDB()) return reject(new Error('IndexedDB unavailable'))
			const req = indexedDB.open(DB_NAME, DB_VERSION)
			req.onupgradeneeded = function () {
				const db = req.result
				if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
			}
			req.onsuccess = function () {
				resolve(req.result)
			}
			req.onerror = function () {
				reject(req.error || new Error('IndexedDB open failed'))
			}
		})
	}

	function tx(db, mode) {
		return db.transaction(STORE, mode).objectStore(STORE)
	}

	function reqToPromise(request) {
		return new Promise(function (resolve, reject) {
			request.onsuccess = function () {
				resolve(request.result)
			}
			request.onerror = function () {
				reject(request.error)
			}
		})
	}

	/** Persist one entry (idempotent upsert by id). Best-effort; never throws to caller. */
	async function putEntry(entry) {
		const db = await open()
		try {
			await reqToPromise(tx(db, 'readwrite').put(entry))
		} finally {
			db.close()
		}
	}

	/** Remove one entry once the server has acknowledged it. */
	async function deleteEntry(id) {
		const db = await open()
		try {
			await reqToPromise(tx(db, 'readwrite').delete(id))
		} finally {
			db.close()
		}
	}

	/** Every queued entry (oldest-first by insertion is not guaranteed; order-agnostic replay). */
	async function getAll() {
		const db = await open()
		try {
			return (await reqToPromise(tx(db, 'readonly').getAll())) || []
		} finally {
			db.close()
		}
	}

	async function count() {
		const db = await open()
		try {
			return (await reqToPromise(tx(db, 'readonly').count())) || 0
		} finally {
			db.close()
		}
	}

	/**
	 * Drain the durable queue against the network. Used by the service worker's
	 * Background Sync handler (the page has its own UI-aware flush that shares this
	 * store). Idempotent + at-least-once: an entry is deleted ONLY on a definitive
	 * server acknowledgement (2xx, or 4xx that isn't auth — a malformed op must not
	 * wedge the queue forever). A network failure or 401 leaves the entry queued to
	 * retry later. Returns a small summary.
	 *
	 * @param {typeof fetch} [fetchImpl] injectable fetch (defaults to global fetch).
	 */
	async function replayAll(fetchImpl) {
		const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null)
		if (!doFetch) throw new Error('fetch unavailable')
		const entries = await getAll()
		let sent = 0
		let authFailed = false
		for (const entry of entries) {
			try {
				const resp = await doFetch(entry.url, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					credentials: 'same-origin',
					body: JSON.stringify(entry.body),
				})
				if (resp.status === 401 || resp.status === 403) {
					authFailed = true
					continue // keep the op; the user must re-authenticate first
				}
				// 2xx = applied; other 4xx = permanently rejected (drop so it can't wedge
				// the queue). 5xx throws below and is retried.
				if (resp.ok || (resp.status >= 400 && resp.status < 500)) {
					await deleteEntry(entry.id)
					if (resp.ok) sent++
				} else {
					throw new Error('HTTP ' + resp.status)
				}
			} catch (e) {
				// Network/5xx — leave queued for the next sync attempt.
			}
		}
		const remaining = await count()
		return { sent: sent, remaining: remaining, authFailed: authFailed }
	}

	return {
		DB_NAME: DB_NAME,
		DB_VERSION: DB_VERSION,
		STORE: STORE,
		SYNC_TAG: SYNC_TAG,
		ASSIGN_URL: ASSIGN_URL,
		COST_URL: COST_URL,
		assignOpId: assignOpId,
		costOpId: costOpId,
		makeAssignEntry: makeAssignEntry,
		makeCostEntry: makeCostEntry,
		hasIDB: hasIDB,
		open: open,
		putEntry: putEntry,
		deleteEntry: deleteEntry,
		getAll: getAll,
		count: count,
		replayAll: replayAll,
	}
})
