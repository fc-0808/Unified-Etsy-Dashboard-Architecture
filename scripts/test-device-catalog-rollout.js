'use strict'

/**
 * Device-generation catalog + additive live-listing rollout.
 *
 * Guards:
 *   · the registry lists iPhone 18 Pro / 18 Pro Max and AirPods 5
 *   · live listings are patched by cloning a sibling model, never rebuilt
 *   · models an operator turned off are not back-filled
 *   · watch / iPad listings are never touched
 *   · copy updates only rewrite an existing compact device phrase
 *
 * Pure unit tests: no network. The job manager dry-run is exercised against
 * an in-memory SQLite cache.
 *
 * Run: node scripts/test-device-catalog-rollout.js
 */

const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const Database = require('better-sqlite3')

const productTypes = require('../src/listings/product-types')
const rollout = require('../src/listings/device-catalog-rollout')
const ai = require('../src/listings/ai-generator')
const { CatalogRolloutManager, ensureSchema, DEFAULT_DELAY_MS, DELAY_JITTER_MS, CONSECUTIVE_FAILURE_PAUSE, LIVE_MIN_DELAY_MS } = require('../src/listings/catalog-rollout')
const { buildInventory } = require('../src/listings/variation-builder')

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'
let passed = 0
let failed = 0
const failures = []
const queue = []
const group = (name) => queue.push({ group: name })
const test = (name, fn) => queue.push({ name, fn })

function iphoneProduct(model, style, opts = {}) {
	const price = opts.price ?? 18.5
	return {
		product_id: opts.product_id ?? Math.floor(Math.random() * 1e7) + 1,
		property_values: [
			{ property_id: 513, property_name: 'Phone Model', values: [model], value_ids: [opts.modelValueId ?? 100] },
			{ property_id: 514, property_name: 'Styles', values: [style], value_ids: [opts.styleValueId ?? 200] },
		],
		offerings: [
			{
				offering_id: opts.offering_id ?? 1,
				price: { amount: Math.round(price * 100), divisor: 100, currency_code: 'USD' },
				quantity: opts.qty ?? 3,
				is_enabled: opts.enabled !== false,
				readiness_state_id: 42,
			},
		],
	}
}

function airpodsProduct(model, style, opts = {}) {
	const row = iphoneProduct(model, style, opts)
	row.property_values[0].property_name = 'AirPods Model'
	return row
}

function inventory(products, extra = {}) {
	return {
		products,
		price_on_property: [514],
		quantity_on_property: [514],
		sku_on_property: [],
		readiness_state_on_property: [],
		...extra,
	}
}

group('Registry')

test('iPhone 18 Pro and iPhone 18 Pro Max are first in the Phone Model list', () => {
	const models = productTypes.getProductType('iphone_case').models
	assert.equal(models[0], 'iPhone 18 Pro Max')
	assert.equal(models[1], 'iPhone 18 Pro')
	assert.ok(models.includes('iPhone 17 Pro Max'))
	assert.ok(models.includes('iPhone 14/13'))
})

test('AirPods 5 sits with the standard (non-Pro) generations', () => {
	const models = productTypes.getProductType('airpods_case').models
	assert.ok(models.includes('AirPods 5'))
	assert.ok(models.indexOf('AirPods 5') < models.indexOf('AirPods 4'))
	assert.ok(models.includes('AirPods Pro 3'))
})

test('the live-listing rollout only injects the new generations, not older ones', () => {
	assert.deepEqual(productTypes.generationAdditionsFor('iphone_case'), ['iPhone 18 Pro Max', 'iPhone 18 Pro'])
	assert.deepEqual(productTypes.generationAdditionsFor('airpods_case'), ['AirPods 5'])
	assert.deepEqual(productTypes.generationAdditionsFor('apple_watch_band'), [])
	assert.deepEqual(productTypes.generationAdditionsFor('ipad_case'), [])
})

test('every rollout addition is a real catalog model', () => {
	for (const [typeId, added] of Object.entries(productTypes.DEVICE_GENERATION_ADDITIONS)) {
		const models = productTypes.getProductType(typeId).models
		for (const model of added) assert.ok(models.includes(model), `${typeId} ${model}`)
	}
})

test('new drafts emit the new models in the variation matrix', () => {
	const { body } = buildInventory({
		prices: { 'Case Only': 12, 'Case+Charm': 16 },
		enabledStyles: { 'Case Only': true, 'Case+Charm': true },
		enabledModels: { 'iPhone 18 Pro': true, 'iPhone 18 Pro Max': true },
		productType: 'iphone_case',
		readinessStateId: 1,
	})
	const models = [...new Set(body.products.map((p) => p.property_values[0].values[0]))]
	assert.deepEqual(models, ['iPhone 18 Pro Max', 'iPhone 18 Pro'])
})

test('new iPhone drafts include 18 Pro and 18 Pro Max by default', () => {
	const { body } = buildInventory({
		prices: { 'Case Only': 12 },
		enabledStyles: { 'Case Only': true },
		productType: 'iphone_case',
		readinessStateId: 1,
	})
	const models = [...new Set(body.products.map((p) => p.property_values[0].values[0]))]
	assert.ok(models.includes('iPhone 18 Pro Max'))
	assert.ok(models.includes('iPhone 18 Pro'))
	assert.ok(models.includes('iPhone 17 Pro Max'))
	assert.equal(models[0], 'iPhone 18 Pro Max')
	assert.equal(models[1], 'iPhone 18 Pro')
})

test('a fresh iPhone bulk upload selects 18 Pro and 18 Pro Max and leaves the 14 family off', () => {
	const enabled = productTypes.defaultEnabledModels('iphone_case')
	assert.equal(enabled['iPhone 18 Pro Max'], true)
	assert.equal(enabled['iPhone 18 Pro'], true)
	for (const model of ['iPhone 17 Pro Max', 'iPhone 17 Pro', 'iPhone 17', 'iPhone 16 Pro Max', 'iPhone 16 Pro', 'iPhone 16', 'iPhone 15 Pro Max', 'iPhone 15 Pro', 'iPhone 15']) {
		assert.equal(enabled[model], true, model)
	}
	assert.equal(enabled['iPhone 14 Pro Max'], false)
	assert.equal(enabled['iPhone 14 Pro'], false)
	assert.equal(enabled['iPhone 14/13'], false)
	assert.equal(productTypes.titleDevicePhrase('iphone_case', enabled), 'iPhone 18 17 16 15 Pro Max')
	assert.equal(productTypes.titleListingPhraseFor('iphone_case', enabled), 'Cover for iPhone 18 17 16 15 Pro Max')

	const { body } = buildInventory({
		prices: { 'Case Only': 12 },
		enabledStyles: { 'Case Only': true },
		enabledModels: enabled,
		productType: 'iphone_case',
		readinessStateId: 1,
	})
	const models = body.products.map((p) => p.property_values[0].values[0])
	assert.ok(models.includes('iPhone 18 Pro Max'))
	assert.ok(models.includes('iPhone 18 Pro'))
	assert.ok(!models.includes('iPhone 14 Pro Max'))
	assert.ok(!models.includes('iPhone 14/13'))
})

test('an operator can still turn iPhone 18 Pro and 18 Pro Max off after upload', () => {
	const uploaded = productTypes.defaultEnabledModels('iphone_case')
	const turnedOff = productTypes.normaliseEnabledModels('iphone_case', {
		...uploaded,
		'iPhone 18 Pro Max': false,
		'iPhone 18 Pro': false,
	})
	assert.equal(turnedOff['iPhone 18 Pro Max'], false)
	assert.equal(turnedOff['iPhone 18 Pro'], false)
	assert.equal(turnedOff['iPhone 17 Pro Max'], true)
})

test('upload defaults keep every newly released generation selected', () => {
	for (const [typeId, added] of Object.entries(productTypes.DEVICE_GENERATION_ADDITIONS)) {
		const enabled = productTypes.defaultEnabledModels(typeId)
		for (const model of added) assert.equal(enabled[model], true, `${typeId} ${model}`)
	}
	const meta = productTypes.productMeta('iphone_case')
	assert.equal(meta.default_enabled_models['iPhone 18 Pro Max'], true)
	assert.equal(meta.default_enabled_models['iPhone 18 Pro'], true)
	assert.equal(meta.default_enabled_models['iPhone 14/13'], false)
})

test('new AirPods drafts include AirPods 5 by default', () => {
	const { body } = buildInventory({
		prices: { 'Case Only': 12 },
		enabledStyles: { 'Case Only': true },
		productType: 'airpods_case',
		readinessStateId: 1,
	})
	const models = [...new Set(body.products.map((p) => p.property_values[0].values[0]))]
	assert.ok(models.includes('AirPods 5'))
	assert.ok(models.includes('AirPods 4'))
	assert.ok(models.indexOf('AirPods 5') < models.indexOf('AirPods 4'))
})

test('the compact title phrase includes 18 and AirPods 5', () => {
	const iphone = productTypes.titleDevicePhrase('iphone_case')
	assert.match(iphone, /iPhone 18 17 16 15 14 13 Pro Max/)
	const airpods = productTypes.titleDevicePhrase('airpods_case')
	assert.match(airpods, /AirPods 5/)
	assert.match(airpods, /AirPods Pro/)
})

group('Classification')

test('Phone Model inventory is an iPhone case; AirPods Model is AirPods', () => {
	assert.equal(rollout.classifyInventory(inventory([iphoneProduct('iPhone 17 Pro', 'Case Only')])), 'iphone_case')
	assert.equal(rollout.classifyInventory(inventory([airpodsProduct('AirPods 4', 'Case Only')])), 'airpods_case')
})

test('watch and iPad listings are refused', () => {
	const watch = inventory([
		{
			property_values: [
				{ property_id: 513, property_name: 'Band Size', values: ['38/40/41mm'], value_ids: [1] },
				{ property_id: 514, property_name: 'Band Style', values: ['Band 1'], value_ids: [2] },
			],
			offerings: [{ price: 20, quantity: 3, is_enabled: true }],
		},
	])
	assert.equal(rollout.classifyInventory(watch), null)
	const ipad = inventory([
		{
			property_values: [{ property_id: 514, property_name: 'iPad Model', values: ['Pro 2022 11"'], value_ids: [1] }],
			offerings: [{ price: 20, quantity: 3, is_enabled: true }],
		},
	])
	assert.equal(rollout.classifyInventory(ipad), null)
})

test('cached rows with no inventory are uncached, not guessed into iPhone', () => {
	const got = rollout.classifyCachedListing({ title: 'Cute Cherry Case', inventoryRows: [] })
	assert.equal(got.productType, null)
	assert.equal(got.reason, 'uncached')
})

group('Clone source')

test('iPhone 18 Pro Max clones from iPhone 17 Pro Max when present', () => {
	assert.equal(
		rollout.pickCloneSource(['iPhone 17 Pro', 'iPhone 17 Pro Max', 'iPhone 16'], 'iPhone 18 Pro Max'),
		'iPhone 17 Pro Max',
	)
})

test('iPhone 18 Pro clones from iPhone 17 Pro when present', () => {
	assert.equal(
		rollout.pickCloneSource(['iPhone 17 Pro Max', 'iPhone 17 Pro', 'iPhone 17'], 'iPhone 18 Pro'),
		'iPhone 17 Pro',
	)
})

test('AirPods 5 clones from AirPods 4, not from a Pro generation', () => {
	assert.equal(
		rollout.pickCloneSource(['AirPods Pro 3', 'AirPods 4', 'AirPods 3'], 'AirPods 5'),
		'AirPods 4',
	)
})

group('Additive inventory PUT')

test('an iPhone listing gains 18 Pro and 18 Pro Max and keeps every existing row', () => {
	const existing = [
		iphoneProduct('iPhone 17 Pro Max', 'Case Only', { product_id: 1, price: 12, modelValueId: 501, styleValueId: 701 }),
		iphoneProduct('iPhone 17 Pro Max', 'Case + Charm', { product_id: 2, price: 16, modelValueId: 501, styleValueId: 702 }),
		iphoneProduct('iPhone 17 Pro', 'Case Only', { product_id: 3, price: 12, modelValueId: 502, styleValueId: 701 }),
		iphoneProduct('iPhone 17 Pro', 'Case + Charm', { product_id: 4, price: 16, modelValueId: 502, styleValueId: 702 }),
	]
	const plan = rollout.applyRollout(inventory(existing))
	assert.equal(plan.changed, true)
	assert.deepEqual(plan.addedModels, ['iPhone 18 Pro Max', 'iPhone 18 Pro'])
	assert.equal(plan.cloneSources['iPhone 18 Pro Max'], 'iPhone 17 Pro Max')
	assert.equal(plan.cloneSources['iPhone 18 Pro'], 'iPhone 17 Pro')
	assert.equal(plan.body.products.length, 8)

	const models = [...new Set(plan.body.products.map((p) => p.property_values[0].values[0]))]
	assert.deepEqual(models.slice(0, 4), ['iPhone 18 Pro Max', 'iPhone 18 Pro', 'iPhone 17 Pro Max', 'iPhone 17 Pro'])

	const eighteenMaxCase = plan.body.products.find(
		(p) => p.property_values[0].values[0] === 'iPhone 18 Pro Max' && p.property_values[1].values[0] === 'Case Only',
	)
	assert.equal(eighteenMaxCase.offerings[0].price, 12)
	assert.equal(eighteenMaxCase.offerings[0].quantity, 3)
	assert.equal(eighteenMaxCase.offerings[0].readiness_state_id, 42)
	assert.deepEqual(eighteenMaxCase.property_values[0].value_ids, [])
	assert.deepEqual(eighteenMaxCase.property_values[1].value_ids, [701])
	assert.equal(eighteenMaxCase.product_id, undefined)

	const kept = plan.body.products.find(
		(p) => p.property_values[0].values[0] === 'iPhone 17 Pro Max' && p.property_values[1].values[0] === 'Case Only',
	)
	assert.equal(kept.offerings[0].price, 12)
	assert.deepEqual(kept.property_values[0].value_ids, [501])
})

test('disabled styles stay disabled on the cloned model', () => {
	const existing = [
		iphoneProduct('iPhone 17 Pro', 'Case Only', { enabled: true, qty: 5 }),
		iphoneProduct('iPhone 17 Pro', 'Grip Only', { enabled: false, qty: 0, price: 12 }),
	]
	const plan = rollout.applyRollout(inventory(existing))
	const clonedGrip = plan.body.products.find(
		(p) => p.property_values[0].values[0] === 'iPhone 18 Pro' && p.property_values[1].values[0] === 'Grip Only',
	)
	assert.equal(clonedGrip.offerings[0].is_enabled, false)
	assert.equal(clonedGrip.offerings[0].quantity, 0)
	const clonedCase = plan.body.products.find(
		(p) => p.property_values[0].values[0] === 'iPhone 18 Pro' && p.property_values[1].values[0] === 'Case Only',
	)
	assert.equal(clonedCase.offerings[0].quantity, 5)
})

test('custom style rows are cloned along with canonical ones', () => {
	const custom = iphoneProduct('iPhone 17 Pro', 'Case1 + Charm1', { price: 22, styleValueId: 909 })
	const plan = rollout.applyRollout(inventory([iphoneProduct('iPhone 17 Pro', 'Case Only'), custom]))
	const clonedCustom = plan.body.products.find(
		(p) => p.property_values[0].values[0] === 'iPhone 18 Pro' && p.property_values[1].values[0] === 'Case1 + Charm1',
	)
	assert.ok(clonedCustom)
	assert.equal(clonedCustom.offerings[0].price, 22)
	assert.deepEqual(clonedCustom.property_values[1].value_ids, [909])
})

test('a listing that already has the new models is a no-op', () => {
	const existing = [
		iphoneProduct('iPhone 18 Pro Max', 'Case Only'),
		iphoneProduct('iPhone 18 Pro', 'Case Only'),
		iphoneProduct('iPhone 17 Pro', 'Case Only'),
	]
	const plan = rollout.applyRollout(inventory(existing))
	assert.equal(plan.changed, false)
	assert.equal(plan.reason, 'already_current')
})

test('older models the operator omitted are not back-filled', () => {
	const existing = [iphoneProduct('iPhone 17 Pro', 'Case Only'), iphoneProduct('iPhone 17', 'Case Only')]
	const plan = rollout.applyRollout(inventory(existing))
	const models = [...new Set(plan.body.products.map((p) => p.property_values[0].values[0]))]
	assert.ok(!models.includes('iPhone 16'))
	assert.ok(!models.includes('iPhone 14/13'))
	assert.ok(models.includes('iPhone 18 Pro'))
	assert.ok(models.includes('iPhone 17'))
})

test('cloned rows drop the source SKU so Etsy does not see duplicates', () => {
	const existing = [
		iphoneProduct('iPhone 17 Pro', 'Case Only', { product_id: 1 }),
	]
	existing[0].sku = 'CHERRY-17P-CASE'
	const plan = rollout.applyRollout(inventory(existing))
	const kept = plan.body.products.find((p) => p.property_values[0].values[0] === 'iPhone 17 Pro')
	const cloned = plan.body.products.find((p) => p.property_values[0].values[0] === 'iPhone 18 Pro')
	assert.equal(kept.sku, 'CHERRY-17P-CASE')
	assert.equal(cloned.sku, undefined)
})

test('cloned offerings inherit readiness_state_id when the source row omitted it', () => {
	const source = iphoneProduct('iPhone 17 Pro', 'Case Only')
	delete source.offerings[0].readiness_state_id
	const sibling = iphoneProduct('iPhone 17 Pro Max', 'Case Only')
	const plan = rollout.applyRollout(inventory([source, sibling]))
	const cloned = plan.body.products.find((p) => p.property_values[0].values[0] === 'iPhone 18 Pro')
	assert.equal(cloned.offerings[0].readiness_state_id, 42)
})

test('an iPhone-only filter does not rewrite AirPods inventory', () => {
	const plan = rollout.applyRollout(
		inventory([airpodsProduct('AirPods 4', 'Case Only')]),
		{ product_types: ['iphone_case'] },
	)
	assert.equal(plan.changed, false)
	assert.equal(plan.reason, 'filtered_out')
})

test('AirPods listings only receive AirPods 5', () => {
	const existing = [
		airpodsProduct('AirPods 4', 'Case Only', { price: 9 }),
		airpodsProduct('AirPods Pro 3', 'Case + Charm', { price: 14 }),
	]
	const plan = rollout.applyRollout(inventory(existing))
	assert.deepEqual(plan.addedModels, ['AirPods 5'])
	assert.equal(plan.cloneSources['AirPods 5'], 'AirPods 4')
	const added = plan.body.products.filter((p) => p.property_values[0].values[0] === 'AirPods 5')
	assert.equal(added.length, 1)
	assert.equal(added[0].offerings[0].price, 9)
	assert.ok(!plan.body.products.some((p) => /iPhone/i.test(p.property_values[0].values[0])))
})

test('a watch listing is not_applicable', () => {
	const watch = inventory([
		{
			property_values: [
				{ property_id: 513, property_name: 'Band Size', values: ['42/44/45/46/49mm'], value_ids: [1] },
				{ property_id: 514, property_name: 'Band Style', values: ['Band 1'], value_ids: [2] },
			],
			offerings: [{ price: 20, quantity: 3, is_enabled: true, readiness_state_id: 1 }],
		},
	])
	const plan = rollout.applyRollout(watch)
	assert.equal(plan.changed, false)
	assert.equal(plan.reason, 'not_applicable')
})

group('Copy')

test('an iPhone title range is rewritten to include 18', () => {
	const title = 'Cherry Bow Clear Cover for iPhone 17 16 15 14 13 Pro Max, Gift'
	const next = ai.retitleForModels(title, {
		'iPhone 18 Pro Max': true,
		'iPhone 18 Pro': true,
		'iPhone 17 Pro Max': true,
		'iPhone 17 Pro': true,
		'iPhone 17': true,
		'iPhone 16 Pro Max': true,
		'iPhone 16 Pro': true,
		'iPhone 16': true,
		'iPhone 15 Pro Max': true,
		'iPhone 15 Pro': true,
		'iPhone 15': true,
		'iPhone 14 Pro Max': true,
		'iPhone 14 Pro': true,
		'iPhone 14/13': true,
	}, 'iphone_case')
	assert.match(next, /Cover for iPhone 18 17 16 15 14 13 Pro Max/)
})

test('an AirPods compact phrase picks up generation 5', () => {
	const title = 'Kuromi Case, Cover for AirPods Pro 3 2 1 & AirPods 4 3 2 1'
	const next = ai.retitleForModels(title, {
		'AirPods Pro 3': true,
		'AirPods Pro 2': true,
		'AirPods Pro': true,
		'AirPods 5': true,
		'AirPods 4': true,
		'AirPods 3': true,
		'AirPods 2': true,
		'AirPods 1': true,
	}, 'airpods_case')
	assert.match(next, /AirPods 5 4 3 2 1/)
})

test('titles without a compact device range are left alone', () => {
	const title = 'Cute Cherry Phone Case with Bow'
	assert.equal(ai.retitleForModels(title, { 'iPhone 18 Pro': true }, 'iphone_case'), title)
})

test('Device Compatibility bullets gain the new models in catalog order', () => {
	const description = [
		'A kawaii case.',
		'Device Compatibility',
		'- iPhone 17 Pro Max',
		'- iPhone 17 Pro',
		'- iPhone 17',
		'What\'s Included',
		'- Case Only',
	].join('\n')
	const next = ai.insertMissingModelsInDescription(description, {
		'iPhone 18 Pro Max': true,
		'iPhone 18 Pro': true,
		'iPhone 17 Pro Max': true,
		'iPhone 17 Pro': true,
		'iPhone 17': true,
	}, 'iphone_case')
	assert.match(next, /- iPhone 18 Pro Max\n- iPhone 18 Pro\n- iPhone 17 Pro Max/)
})

test('planCopyUpdates fits iPhone 18 by dropping the oldest generation under the 140 cap', () => {
	const title = 'Cute Hello Kitty Sanrio Case & Lens Stand, Glitter Cover iPhone 17 16 15 14 13 Pro Max, Kawaii Pink My Melody Kuromi Coquette Gift For Her'
	assert.equal(title.length, 138)
	const plan = rollout.planCopyUpdates({
		title,
		description: '',
		productType: 'iphone_case',
		existingModels: ['iPhone 17 Pro Max', 'iPhone 17 Pro', 'iPhone 17', 'iPhone 16 Pro Max', 'iPhone 16 Pro', 'iPhone 16', 'iPhone 15 Pro Max', 'iPhone 15 Pro', 'iPhone 15', 'iPhone 14 Pro Max', 'iPhone 14 Pro', 'iPhone 14/13'],
		addedModels: ['iPhone 18 Pro Max', 'iPhone 18 Pro'],
	})
	assert.equal(plan.skipped, null)
	assert.equal(plan.titleChanged, true)
	assert.equal(plan.compacted, true)
	assert.ok(plan.title.length <= 140)
	assert.match(plan.title, /iPhone 18 17 16 15 14 Pro Max/)
	assert.doesNotMatch(plan.title, /iPhone 18 17 16 15 14 13 Pro Max/)
	assert.equal(rollout.describeCopyPlan(plan), 'Update title (fitted to 140-char cap)')
})

test('planCopyUpdates refuses a title that cannot fit even after dropping older generations', () => {
	const title = 'x'.repeat(130) + ' iPhone 17'
	assert.equal(title.length, 140)
	const plan = rollout.planCopyUpdates({
		title,
		description: '',
		productType: 'iphone_case',
		existingModels: ['iPhone 17 Pro Max', 'iPhone 17 Pro', 'iPhone 17', 'iPhone 16 Pro Max', 'iPhone 16 Pro', 'iPhone 16', 'iPhone 15 Pro Max', 'iPhone 15 Pro', 'iPhone 15', 'iPhone 14 Pro Max', 'iPhone 14 Pro', 'iPhone 14/13'],
		addedModels: ['iPhone 18 Pro Max', 'iPhone 18 Pro'],
	})
	assert.equal(plan.titleChanged, false)
	assert.equal(plan.title, title)
	assert.equal(plan.skipped, 'title_would_exceed_limit')
	assert.equal(rollout.describeCopyPlan(plan), 'Title unchanged (Etsy 140-char cap)')
})

test('enrichReviewPlan turns a stored title_would_exceed_limit into a fitted label', () => {
	const title = 'Cute Hello Kitty Sanrio Case & Lens Stand, Glitter Cover iPhone 17 16 15 14 13 Pro Max, Kawaii Pink My Melody Kuromi Coquette Gift For Her'
	const plan = rollout.enrichReviewPlan({
		copy_title: false,
		copy_description: true,
		copy_skipped: 'title_would_exceed_limit',
	}, {
		title,
		product_type: 'iphone_case',
		existing_models: ['iPhone 17 Pro Max', 'iPhone 17 Pro', 'iPhone 17', 'iPhone 16 Pro Max', 'iPhone 16 Pro', 'iPhone 16', 'iPhone 15 Pro Max', 'iPhone 15 Pro', 'iPhone 15', 'iPhone 14 Pro Max', 'iPhone 14 Pro', 'iPhone 14/13'],
		added_models: ['iPhone 18 Pro Max', 'iPhone 18 Pro'],
	})
	assert.equal(plan.copy_title, true)
	assert.equal(plan.copy_compacted, true)
	assert.equal(plan.copy_skipped, null)
	assert.equal(plan.copy_description, true)
	assert.match(plan.copy_label, /fitted to 140-char cap/)
	assert.match(plan.next_title, /iPhone 18 17 16 15 14 Pro Max/)
})

group('Pacing helpers')

test('planFromCachedListing clones from cached Phone Model rows without calling Etsy', () => {
	const planned = rollout.planFromCachedListing({
		title: 'Cherry Cover for iPhone 17 16 15 Pro Max',
		description: 'Device Compatibility\n- iPhone 17 Pro\n',
		inventoryRows: [{
			product_id: 1,
			property_values: JSON.stringify([
				{ property_id: 513, property_name: 'Phone Model', values: ['iPhone 17 Pro'], value_ids: [1] },
				{ property_id: 514, property_name: 'Styles', values: ['Case Only'], value_ids: [2] },
			]),
			secondary_value: 'iPhone 17 Pro',
			style_value: 'Case Only',
			quantity: 3,
			is_enabled: 1,
			price_amount: 12,
		}],
		existingModels: ['iPhone 17 Pro'],
		missingModels: ['iPhone 18 Pro Max', 'iPhone 18 Pro'],
		updateCopy: true,
	})
	assert.equal(planned.changed, true)
	assert.deepEqual(planned.addedModels, ['iPhone 18 Pro Max', 'iPhone 18 Pro'])
	assert.equal(planned.cloneSources['iPhone 18 Pro'], 'iPhone 17 Pro')
	assert.equal(planned.review.copy_description, true)
	assert.equal(planned.block, false)
})

test('API-call estimate is GET+PUT at minimum, never a per-listing storm', () => {
	const est = rollout.estimateApiCalls(100, { updateCopy: true })
	assert.equal(est.min, 200)
	assert.ok(est.max <= 400)
})

test('delay clamps stay inside the polite window', () => {
	assert.equal(rollout.clampDelayMs(50, 2000, 1000, 8000), 1000)
	assert.equal(rollout.clampDelayMs(99999, 2000, 1000, 8000), 8000)
	assert.equal(rollout.clampDelayMs('nope', 2000, 1000, 8000), 2000)
})

test('jittered pacing is base plus a bounded random offset', () => {
	assert.equal(rollout.pacedDelayMs(2500, 1000, () => 0), 2500)
	assert.equal(rollout.pacedDelayMs(2500, 1000, () => 0.999), 3499)
	assert.ok(DEFAULT_DELAY_MS >= LIVE_MIN_DELAY_MS)
	assert.equal(DELAY_JITTER_MS, 1000)
	assert.equal(CONSECUTIVE_FAILURE_PAUSE, 5)
})

test('omitted product_types means both lines; an empty list stays empty', () => {
	assert.deepEqual(rollout.normalizeProductTypes(undefined), ['iphone_case', 'airpods_case'])
	assert.deepEqual(rollout.normalizeProductTypes(['iphone_case', 'watch']), ['iphone_case'])
	assert.deepEqual(rollout.normalizeProductTypes([]), [])
})

group('Dry-run job against the listings cache')

test('preview counts only listings that are missing the new generations', () => {
	const db = new Database(':memory:')
	db.exec(`
		CREATE TABLE shops (shop_id TEXT PRIMARY KEY, shop_name TEXT);
		CREATE TABLE listings (
			listing_id INTEGER PRIMARY KEY, shop_id TEXT, title TEXT, description TEXT,
			state TEXT, price_currency TEXT
		);
		CREATE TABLE listing_inventory (
			listing_id INTEGER, product_id INTEGER, offering_id INTEGER,
			style_value TEXT, secondary_value TEXT, property_values TEXT,
			quantity INTEGER, is_enabled INTEGER, price_amount REAL, price_currency TEXT,
			PRIMARY KEY (listing_id, product_id)
		);
	`)
	ensureSchema(db)
	db.prepare('INSERT INTO shops VALUES (?, ?)').run('shop-a', 'Alpha')
	db.prepare('INSERT INTO listings (listing_id, shop_id, title, state) VALUES (?,?,?,?)').run(11, 'shop-a', 'Cherry iPhone Case Cover for iPhone 17 16 15 14 13 Pro Max', 'active')
	db.prepare('INSERT INTO listings (listing_id, shop_id, title, state) VALUES (?,?,?,?)').run(12, 'shop-a', 'Kuromi AirPods Case Cover for AirPods Pro 3 2 1 & AirPods 4 3 2 1', 'active')
	db.prepare('INSERT INTO listings (listing_id, shop_id, title, state) VALUES (?,?,?,?)').run(13, 'shop-a', 'Watch Band', 'active')
	const props = (name, model) => JSON.stringify([
		{ property_id: 513, property_name: name, values: [model], value_ids: [1] },
		{ property_id: 514, property_name: 'Styles', values: ['Case Only'], value_ids: [2] },
	])
	db.prepare('INSERT INTO listing_inventory (listing_id, product_id, style_value, secondary_value, property_values, quantity, is_enabled) VALUES (?,?,?,?,?,?,1)')
		.run(11, 1, 'Case Only', 'iPhone 17 Pro', props('Phone Model', 'iPhone 17 Pro'), 3)
	db.prepare('INSERT INTO listing_inventory (listing_id, product_id, style_value, secondary_value, property_values, quantity, is_enabled) VALUES (?,?,?,?,?,?,1)')
		.run(12, 2, 'Case Only', 'AirPods 4', props('AirPods Model', 'AirPods 4'), 3)
	db.prepare('INSERT INTO listing_inventory (listing_id, product_id, style_value, secondary_value, property_values, quantity, is_enabled) VALUES (?,?,?,?,?,?,1)')
		.run(13, 3, 'Band 1', '38/40/41mm', JSON.stringify([
			{ property_id: 513, property_name: 'Band Size', values: ['38/40/41mm'], value_ids: [1] },
			{ property_id: 514, property_name: 'Band Style', values: ['Band 1'], value_ids: [2] },
		]), 3)

	const manager = new CatalogRolloutManager({
		db,
		resolveShopClient: async () => { throw new Error('Etsy must not be called during preview'); },
		listAuthorizedShops: () => [{ shop_id: 'shop-a', shop_name: 'Alpha' }],
		isEtsyWorkRunning: () => false,
	})
	const preview = manager.preview({ state: 'active', shop_ids: ['shop-a'] })
	assert.equal(preview.summary.needed, 2)
	assert.equal(preview.summary.skipped, 1)
	assert.equal(preview.summary.by_type.iphone_case.needed, 1)
	assert.equal(preview.summary.by_type.airpods_case.needed, 1)
	assert.ok(preview.spec.additions.iphone_case.includes('iPhone 18 Pro'))
	assert.equal(preview.one_shop, true)
	assert.throws(() => manager.start({ dry_run: true }), /one shop at a time/)
	assert.throws(() => manager.start({ dry_run: true, shop_ids: ['missing-shop'] }), /No authorized shop matched/)
	const iphoneOnly = manager.preview({ state: 'active', shop_ids: ['shop-a'], product_types: ['iphone_case'] })
	assert.equal(iphoneOnly.summary.needed, 1)
	assert.equal(iphoneOnly.summary.by_type.iphone_case.needed, 1)
	assert.equal(iphoneOnly.summary.by_type.airpods_case, undefined)
	const none = manager.preview({ state: 'active', shop_ids: ['shop-a'], product_types: [] })
	assert.equal(none.summary.needed, 0)
	assert.throws(
		() => manager.start({ dry_run: true, shop_ids: ['shop-a'], product_types: [] }),
		/at least one product line/,
	)
	db.close()
})

test('a dry-run job records would_update without calling Etsy', async () => {
	const db = new Database(':memory:')
	db.exec(`
		CREATE TABLE shops (shop_id TEXT PRIMARY KEY, shop_name TEXT);
		CREATE TABLE listings (
			listing_id INTEGER PRIMARY KEY, shop_id TEXT, title TEXT, description TEXT,
			state TEXT, price_currency TEXT
		);
		CREATE TABLE listing_inventory (
			listing_id INTEGER, product_id INTEGER, offering_id INTEGER,
			style_value TEXT, secondary_value TEXT, property_values TEXT,
			quantity INTEGER, is_enabled INTEGER, price_amount REAL, price_currency TEXT,
			PRIMARY KEY (listing_id, product_id)
		);
		CREATE TABLE events (
			id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT, shop_name TEXT,
			listing_id INTEGER, listing_title TEXT, style_value TEXT, detail TEXT, meta TEXT, created_at INTEGER
		);
	`)
	ensureSchema(db)
	db.prepare('INSERT INTO shops VALUES (?, ?)').run('shop-a', 'Alpha')
	db.prepare('INSERT INTO listings (listing_id, shop_id, title, state) VALUES (?,?,?,?)')
		.run(11, 'shop-a', 'Cherry Cover for iPhone 17 16 15 Pro Max', 'active')
	db.prepare('INSERT INTO listing_inventory (listing_id, product_id, style_value, secondary_value, property_values, quantity, is_enabled) VALUES (?,?,?,?,?,?,1)')
		.run(11, 1, 'Case Only', 'iPhone 17 Pro', JSON.stringify([
			{ property_id: 513, property_name: 'Phone Model', values: ['iPhone 17 Pro'], value_ids: [1] },
			{ property_id: 514, property_name: 'Styles', values: ['Case Only'], value_ids: [2] },
		]), 3)

	let etsyCalls = 0
	const manager = new CatalogRolloutManager({
		db,
		resolveShopClient: async () => { etsyCalls++; throw new Error('Etsy must not be called during a dry run'); },
		listAuthorizedShops: () => [{ shop_id: 'shop-a', shop_name: 'Alpha' }],
		isEtsyWorkRunning: () => false,
	})
	const job = manager.start({ dry_run: true, delay_ms: 1000, shop_ids: ['shop-a'] })
	assert.equal(job.needed, 1)
	for (let i = 0; i < 40; i++) {
		const latest = manager.getJob(job.job_id)
		if (latest.state === 'done') {
			assert.equal(latest.updated, 1)
			assert.equal(etsyCalls, 0)
			const item = db.prepare('SELECT status, clone_sources, plan_json FROM catalog_rollout_items WHERE job_id = ?').get(job.job_id)
			assert.equal(item.status, 'would_update')
			const clones = JSON.parse(item.clone_sources)
			assert.equal(clones['iPhone 18 Pro'], 'iPhone 17 Pro')
			assert.ok(clones['iPhone 18 Pro Max'])
			const plan = JSON.parse(item.plan_json)
			assert.ok(plan.added_models.includes('iPhone 18 Pro'))
			assert.equal(etsyCalls, 0)

			assert.throws(
				() => manager.start({ shop_ids: ['shop-a'] }),
				/dry-run first/,
			)
			assert.throws(
				() => manager.apply('missing'),
				/not found/i,
			)
			let applyRuns = 0
			manager._run = async () => { applyRuns += 1 }
			const applied = manager.apply(job.job_id, { listing_ids: [11] })
			assert.equal(applied.dry_run, false)
			assert.equal(applied.state, 'running')
			const pending = db.prepare('SELECT status FROM catalog_rollout_items WHERE job_id = ? AND listing_id = 11').get(job.job_id)
			assert.equal(pending.status, 'pending')
			await new Promise((r) => setTimeout(r, 80))
			assert.equal(applyRuns, 1)
			db.close()
			return
		}
		if (latest.state === 'error') throw new Error(latest.error)
		await new Promise((r) => setTimeout(r, 50))
	}
	throw new Error('dry-run job did not finish')
})

test('a live start refuses two shops and resume does not spawn a second runner', async () => {
	const db = new Database(':memory:')
	db.exec(`
		CREATE TABLE shops (shop_id TEXT PRIMARY KEY, shop_name TEXT);
		CREATE TABLE listings (
			listing_id INTEGER PRIMARY KEY, shop_id TEXT, title TEXT, description TEXT,
			state TEXT, price_currency TEXT
		);
		CREATE TABLE listing_inventory (
			listing_id INTEGER, product_id INTEGER, offering_id INTEGER,
			style_value TEXT, secondary_value TEXT, property_values TEXT,
			quantity INTEGER, is_enabled INTEGER, price_amount REAL, price_currency TEXT,
			PRIMARY KEY (listing_id, product_id)
		);
		CREATE TABLE events (
			id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT, shop_name TEXT,
			listing_id INTEGER, listing_title TEXT, style_value TEXT, detail TEXT, meta TEXT, created_at INTEGER
		);
	`)
	ensureSchema(db)
	db.prepare('INSERT INTO shops VALUES (?, ?)').run('shop-a', 'Alpha')
	db.prepare('INSERT INTO shops VALUES (?, ?)').run('shop-b', 'Beta')
	db.prepare('INSERT INTO listings (listing_id, shop_id, title, state) VALUES (?,?,?,?)')
		.run(11, 'shop-a', 'Cherry Cover for iPhone 17 16 15 Pro Max', 'active')
	db.prepare('INSERT INTO listing_inventory (listing_id, product_id, style_value, secondary_value, property_values, quantity, is_enabled) VALUES (?,?,?,?,?,?,1)')
		.run(11, 1, 'Case Only', 'iPhone 17 Pro', JSON.stringify([
			{ property_id: 513, property_name: 'Phone Model', values: ['iPhone 17 Pro'], value_ids: [1] },
			{ property_id: 514, property_name: 'Styles', values: ['Case Only'], value_ids: [2] },
		]), 3)

	const manager = new CatalogRolloutManager({
		db,
		resolveShopClient: async () => { throw new Error('Etsy must not be called during a dry run'); },
		listAuthorizedShops: () => [
			{ shop_id: 'shop-a', shop_name: 'Alpha' },
			{ shop_id: 'shop-b', shop_name: 'Beta' },
		],
		isEtsyWorkRunning: () => false,
	})
	assert.throws(
		() => manager.start({ dry_run: true, shop_ids: ['shop-a', 'shop-b'] }),
		/one shop at a time/,
	)

	let runCount = 0
	const origRun = manager._run.bind(manager)
	manager._run = async function wrapped(jobId) {
		runCount++
		return origRun(jobId)
	}
	const job = manager.start({ dry_run: true, shop_ids: ['shop-a'] })
	manager.resume(job.job_id)
	for (let i = 0; i < 40; i++) {
		const latest = manager.getJob(job.job_id)
		if (latest.state === 'done') {
			assert.equal(runCount, 1)
			db.close()
			return
		}
		if (latest.state === 'error') throw new Error(latest.error)
		await new Promise((r) => setTimeout(r, 50))
	}
	throw new Error('dry-run job did not finish')
})

group('Dashboard wiring')

test('the Listings tab exposes the rollout control and API', () => {
	const html = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8')
	assert.ok(html.includes('id="catalogRolloutBtn"'))
	assert.ok(html.includes('Add device models'))
	assert.ok(html.includes('/api/listings/catalog-rollout/preview'))
	assert.ok(html.includes('/api/listings/catalog-rollout/stream/'))
	assert.ok(!html.includes('id="catalogRolloutAllShops"'))
	assert.ok(html.includes('id="catalogRolloutIphone"'))
	assert.ok(html.includes('id="catalogRolloutAirpods"'))
	assert.ok(html.includes('one shop at a time'))
	assert.ok(html.includes('Start dry run'))
	assert.ok(html.includes('Apply reviewed plan to Etsy'))
	assert.ok(html.includes('id="catalogRolloutReview"'))
	assert.ok(html.includes('/api/listings/catalog-rollout/${encodeURIComponent(jobId)}/apply'))
	assert.ok(html.includes('delay_ms: 2500'))
	assert.ok(html.includes('_catalogRolloutCopyHtml'))
	assert.ok(html.includes('Clone from'))
	assert.ok(html.includes('copy_label'))
	assert.ok(!html.includes("copyBits.push(_escHtml(row.plan.copy_skipped))"))
})

test('Bulk Listings fallbacks include iPhone 18 Pro / 18 Pro Max and AirPods 5', () => {
	const html = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8')
	const bulkModels = html.match(/let BULK_MODELS = (\[[^\]]+\])/)
	assert.ok(bulkModels, 'BULK_MODELS fallback is declared')
	assert.match(bulkModels[1], /iPhone 18 Pro Max/)
	assert.match(bulkModels[1], /iPhone 18 Pro/)
	const catalog = html.match(/let DEVICE_MODEL_CATALOG = \{[\s\S]*?airpods: (\[[^\]]+\])/)
	assert.ok(catalog, 'DEVICE_MODEL_CATALOG airpods fallback is declared')
	assert.match(catalog[1], /AirPods 5/)
	assert.ok(html.includes('selectedType.models'))
	assert.ok(html.includes("if (!Object.prototype.hasOwnProperty.call(em, model)) return true"))
	assert.ok(html.includes('default_enabled_models'))
	assert.ok(html.includes('iPhone 18 Pro / 18 Pro Max plus 15–17'))
})

;(async () => {
	for (const entry of queue) {
		if (entry.group) {
			console.log(`\n${BOLD}${entry.group}${RESET}`)
			continue
		}
		try {
			await entry.fn()
			passed++
			console.log(`${GREEN}  ok${RESET}  ${entry.name}`)
		} catch (err) {
			failed++
			failures.push({ name: entry.name, error: err })
			console.log(`${RED}  FAIL${RESET} ${entry.name}`)
			console.log(`${DIM}        ${err.stack || err.message}${RESET}`)
		}
	}
	console.log()
	if (failed) {
		console.log(`${RED}${BOLD}${failed} failed${RESET}, ${passed} passed`)
		process.exit(1)
	}
	console.log(`${GREEN}${BOLD}All ${passed} tests passed.${RESET}`)
})()
