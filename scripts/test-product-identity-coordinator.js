'use strict'

const assert = require('assert')
const { ProductIdentityCoordinator } = require('../src/route/product-identity-coordinator')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let passed = 0
let failed = 0
const tests = []
function test(name, fn) { tests.push({ name, fn }) }

test('a burst of dirty signals produces one reconcile', async () => {
	let runs = 0
	const coordinator = new ProductIdentityCoordinator({
		delayMs: 10,
		defer: (fn) => fn(),
		reconcile: () => ({ groups: 1, updated: ++runs }),
	})
	coordinator.schedule('backfill')
	coordinator.schedule('hydration')
	coordinator.schedule('self-heal')
	await sleep(25)
	assert.strictEqual(runs, 1)
	assert.strictEqual(coordinator.lastResult.updated, 1)
})

test('the debounce is trailing across adjacent hydration batches', async () => {
	let runs = 0
	const coordinator = new ProductIdentityCoordinator({
		delayMs: 20,
		defer: (fn) => fn(),
		reconcile: () => ({ groups: 1, updated: ++runs }),
	})
	coordinator.schedule('batch-1')
	await sleep(12)
	coordinator.schedule('batch-2')
	await sleep(12)
	assert.strictEqual(runs, 0)
	await sleep(18)
	assert.strictEqual(runs, 1)
})

test('operator work cancels the debounce and reconciles immediately', async () => {
	let runs = 0
	const coordinator = new ProductIdentityCoordinator({
		delayMs: 25,
		defer: (fn) => fn(),
		reconcile: () => ({ groups: 2, updated: ++runs }),
	})
	coordinator.schedule('background')
	const result = coordinator.runNow('operator-merge')
	assert.deepStrictEqual(result, { groups: 2, updated: 1 })
	await sleep(35)
	assert.strictEqual(runs, 1)
})

test('updated results are surfaced once to the observer', () => {
	const seen = []
	const coordinator = new ProductIdentityCoordinator({
		reconcile: () => ({ groups: 3, updated: 4 }),
		onResult: (result, reasons) => seen.push({ result, reasons }),
	})
	coordinator.runNow('test')
	assert.strictEqual(seen.length, 1)
	assert.deepStrictEqual(seen[0].result, { groups: 3, updated: 4 })
	assert.ok(seen[0].reasons.includes('test'))
})

;(async () => {
	for (const entry of tests) {
		try {
			await entry.fn()
			passed++
			console.log(`  \x1b[32m✓\x1b[0m ${entry.name}`)
		} catch (error) {
			failed++
			console.log(`  \x1b[31m✗\x1b[0m ${entry.name}: ${error.message}`)
		}
	}
	console.log()
	if (failed) {
		console.error(`${failed} failed, ${passed} passed`)
		process.exit(1)
	}
	console.log(`All ${passed} product identity coordinator tests passed.`)
})()
