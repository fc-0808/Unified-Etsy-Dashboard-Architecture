'use strict'

/**
 * Regression — Orders tab must show Case/Grip/Charm purchase chips alongside an
 * open model fix when those pieces are still shoppable.
 *
 * The bug: flagging "Fix model" (especially BUY — buy the corrected generation)
 * replaced ALL component chips with a single exchange chip, so nobody could mark
 * the case/charm purchased from the Orders view.
 *
 * Mirrors the helpers in public/index.html (_txExchangeHeldComps /
 * _txShoppableComponents) against routeDashboard.exchangeHeldComponents.
 *
 * Run: node scripts/test-orders-exchange-chips.js
 */

const rd = require('../src/route/dashboard')

let failures = 0
function assert(cond, msg) {
	if (cond) console.log(`  ok  — ${msg}`)
	else {
		failures++
		console.error(`  FAIL — ${msg}`)
	}
}

/** Copy of Orders-tab _txExchangeHeldComps (must stay in sync). */
function txExchangeHeldComps(tx) {
	const have = String((tx.exchange && tx.exchange.have_model) || '').trim()
	if (!tx.exchange || tx.exchange.status !== 'open' || !have) {
		return { case: false, grip: false, charm: false }
	}
	const present = {
		has_case: (tx.components || []).some((c) => c.comp === 'case'),
		has_grip: (tx.components || []).some((c) => c.comp === 'grip'),
		has_charm: (tx.components || []).some((c) => c.comp === 'charm'),
	}
	const set = new Set(
		String(tx.exchange.components || '')
			.split(',')
			.map((c) => c.trim().toLowerCase())
			.filter(Boolean),
	)
	const airpods = tx.device_family === 'airpods' || !!tx.charm_integral
	if (!set.size) {
		if (airpods && !present.has_case && present.has_charm) set.add('charm')
		else set.add('case')
	}
	if (airpods && present.has_charm) {
		if (set.has('case')) set.add('charm')
		if (!present.has_case) {
			set.delete('case')
			set.add('charm')
		}
	}
	return { case: set.has('case'), grip: set.has('grip'), charm: set.has('charm') }
}

function txShoppableComponents(tx) {
	const held = txExchangeHeldComps(tx)
	return (tx.components || []).filter((c) => c.comp && !held[c.comp]).map((c) => c.comp)
}

function rowFromTx(tx) {
	const present = {
		has_case: (tx.components || []).some((c) => c.comp === 'case'),
		has_grip: (tx.components || []).some((c) => c.comp === 'grip'),
		has_charm: (tx.components || []).some((c) => c.comp === 'charm'),
	}
	return {
		needs_exchange: tx.exchange && tx.exchange.status === 'open',
		exchange_have_model: tx.exchange ? tx.exchange.have_model : '',
		exchange_components: tx.exchange ? tx.exchange.components : '',
		has_case: present.has_case,
		has_grip: present.has_grip,
		has_charm: present.has_charm,
		charm_integral: !!tx.charm_integral,
		device_family: tx.device_family,
		phone_model: tx.phone_model || '',
		title: tx.title || '',
	}
}

function compsMatch(tx) {
	const held = txExchangeHeldComps(tx)
	const rowHeld = rd.exchangeHeldComponents(rowFromTx(tx))
	for (const c of ['case', 'grip', 'charm']) {
		if (held[c] !== rowHeld.has(c)) return false
	}
	return true
}

console.log('Orders exchange × component chips regression\n')

// AirPods Case+Charm BUY — both case and charm must stay shoppable (the reported bug).
{
	const tx = {
		title: 'Pompompurin AirPods Case with Charm',
		phone_model: 'AirPods Pro 2',
		device_family: 'airpods',
		charm_integral: true,
		components: [
			{ comp: 'case', label: 'Case', status: 'Pending' },
			{ comp: 'charm', label: 'Charm', status: 'Pending' },
		],
		exchange: { status: 'open', have_model: '', need_model: 'AirPods Pro', components: 'case,charm' },
	}
	assert(compsMatch(tx), 'Orders held-set matches route dashboard for AirPods BUY')
	assert(JSON.stringify(txShoppableComponents(tx)) === '["case","charm"]', 'AirPods Case+Charm BUY shows case + charm chips')
}

// iPhone Case+Grip+Charm SWAP — grip stays shoppable.
{
	const tx = {
		title: 'Kawaii Case',
		phone_model: 'iPhone 17 Pro Max',
		device_family: 'iphone',
		components: [
			{ comp: 'case', label: 'Case', status: 'Pending' },
			{ comp: 'grip', label: 'Grip', status: 'Pending' },
			{ comp: 'charm', label: 'Charm', status: 'Pending' },
		],
		exchange: { status: 'open', have_model: 'iPhone 15 Pro Max', need_model: 'iPhone 17 Pro Max', components: 'case' },
	}
	assert(compsMatch(tx), 'Orders held-set matches route dashboard for iPhone SWAP combo')
	assert(JSON.stringify(txShoppableComponents(tx)) === '["grip","charm"]', 'iPhone SWAP combo keeps grip + charm chips')
}

// AirPods Case+Charm SWAP — nothing shoppable (whole unit held).
{
	const tx = {
		title: 'Bunny AirPods Case with Charm',
		phone_model: 'AirPods Pro',
		device_family: 'airpods',
		charm_integral: true,
		components: [
			{ comp: 'case', label: 'Case', status: 'Pending' },
			{ comp: 'charm', label: 'Charm', status: 'Pending' },
		],
		exchange: { status: 'open', have_model: 'AirPods Pro', need_model: 'AirPods Pro 2', components: 'case,charm' },
	}
	assert(compsMatch(tx), 'Orders held-set matches route dashboard for AirPods SWAP')
	assert(txShoppableComponents(tx).length === 0, 'AirPods Case+Charm SWAP shows no purchase chips')
}

console.log('')
if (failures > 0) {
	console.error(`${failures} assertion(s) FAILED`)
	process.exit(1)
}
console.log('All assertions passed.')
