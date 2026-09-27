'use strict'

const assert = require('node:assert/strict')
const {
	createForcedLookup,
	extractDnsAddresses,
	isPublicAddress,
	probePublicFunnel,
	resolvePublicIngress,
} = require('../src/server/funnel-health')
const { isFunnelEnabled } = require('./funnel')

const tests = []
function test(name, fn) {
	tests.push({ name, fn })
}

test('accepts public relay addresses and rejects private/MagicDNS answers', () => {
	assert.equal(isPublicAddress('208.111.34.11'), true)
	assert.equal(isPublicAddress('2607:f740:0:3f::2f0'), true)
	assert.equal(isPublicAddress('100.64.127.53'), false, 'Tailscale CGNAT address must never verify Funnel')
	assert.equal(isPublicAddress('fd7a:115c:a1e0::5b01:7fc0'), false, 'Tailscale IPv6 address must never verify Funnel')
	assert.equal(isPublicAddress('127.0.0.1'), false)
	assert.equal(isPublicAddress('192.168.1.32'), false)
	assert.equal(isPublicAddress('not-an-ip'), false)
})

test('extracts unique public A answers only', () => {
	const addresses = extractDnsAddresses({
		Status: 0,
		Answer: [
			{ type: 5, data: 'alias.example.com.' },
			{ type: 1, data: '100.64.127.53' },
			{ type: 1, data: '208.111.34.11' },
			{ type: 1, data: '208.111.34.11' },
			{ type: 1, data: '208.111.35.209' },
		],
	})
	assert.deepEqual(addresses, ['208.111.34.11', '208.111.35.209'])
	assert.deepEqual(extractDnsAddresses({ Status: 2, Answer: [{ type: 1, data: '208.111.34.11' }] }), [])
})

test('recognizes only the exact enabled public Funnel host', () => {
	const config = {
		AllowFunnel: {
			'walter.tail657e74.ts.net:443': true,
			'other.tail657e74.ts.net:443': false,
		},
	}
	assert.equal(isFunnelEnabled(config, 'walter.tail657e74.ts.net'), true)
	assert.equal(isFunnelEnabled(config, 'other.tail657e74.ts.net'), false)
	assert.equal(isFunnelEnabled({}, 'walter.tail657e74.ts.net'), false)
})

test('merges independent DoH answers and tolerates one provider failure', async () => {
	let calls = 0
	const result = await resolvePublicIngress('node.example.ts.net', {
		providers: [
			() => ({ url: 'https://resolver-one.test', headers: {} }),
			() => ({ url: 'https://resolver-two.test', headers: {} }),
			() => ({ url: 'https://resolver-three.test', headers: {} }),
		],
		fetchJson: async (url) => {
			calls += 1
			if (url.includes('two')) throw new Error('resolver unavailable')
			return {
				Status: 0,
				Answer: [
					{ type: 1, data: url.includes('one') ? '208.111.34.11' : '208.111.35.209' },
					{ type: 1, data: '100.64.127.53' },
				],
			}
		},
	})
	assert.equal(calls, 3)
	assert.deepEqual(result.addresses, ['208.111.34.11', '208.111.35.209'])
	assert.equal(result.providersAnswered, 2)
	assert.equal(result.providersQueried, 3)
	assert.deepEqual(result.errors, ['resolver unavailable'])
})

test('forced lookup preserves one selected relay address', async () => {
	const lookup = createForcedLookup('208.111.34.11')
	await new Promise((resolve, reject) => {
		lookup('node.example.ts.net', {}, (err, address, family) => {
			try {
				assert.ifError(err)
				assert.equal(address, '208.111.34.11')
				assert.equal(family, 4)
				resolve()
			} catch (error) {
				reject(error)
			}
		})
	})
	await new Promise((resolve, reject) => {
		lookup('node.example.ts.net', { all: true }, (err, addresses) => {
			try {
				assert.ifError(err)
				assert.deepEqual(addresses, [{ address: '208.111.34.11', family: 4 }])
				resolve()
			} catch (error) {
				reject(error)
			}
		})
	})
})

test('passes when any public ingress serves the authenticated health contract', async () => {
	const seen = []
	const result = await probePublicFunnel('node.example.ts.net', {
		resolveIngress: async () => ({
			addresses: ['208.111.34.11', '208.111.35.209'],
			errors: [],
		}),
		probeAddress: async ({ address }) => {
			seen.push(address)
			return address.endsWith('.209')
				? { address, ok: true, statusCode: 200 }
				: { address, ok: false, statusCode: 0, error: 'TLS reset' }
		},
	})
	assert.deepEqual(seen.sort(), ['208.111.34.11', '208.111.35.209'])
	assert.equal(result.ok, true)
	assert.equal(result.conclusive, true)
	assert.equal(result.healthyAddress, '208.111.35.209')
})

test('fails conclusively only after public DNS answered and every relay failed', async () => {
	const result = await probePublicFunnel('node.example.ts.net', {
		resolveIngress: async () => ({ addresses: ['208.111.34.11', '208.111.35.209'], errors: [] }),
		probeAddress: async ({ address }) => ({ address, ok: false, statusCode: 0, error: 'TLS reset' }),
	})
	assert.equal(result.ok, false)
	assert.equal(result.conclusive, true)
	assert.match(result.reason, /208\.111\.34\.11: TLS reset/)
	assert.match(result.reason, /208\.111\.35\.209: TLS reset/)
})

test('returns an inconclusive result when public DNS cannot establish ingress', async () => {
	const result = await probePublicFunnel('node.example.ts.net', {
		resolveIngress: async () => ({ addresses: [], errors: ['resolver one timed out', 'resolver two timed out'] }),
		probeAddress: async () => {
			throw new Error('must not probe without a public address')
		},
	})
	assert.equal(result.ok, false)
	assert.equal(result.conclusive, false)
	assert.match(result.reason, /no globally routable/i)
	assert.match(result.reason, /resolver one timed out/)
})

;(async () => {
	let passed = 0
	for (const { name, fn } of tests) {
		try {
			await fn()
			console.log(`PASS — ${name}`)
			passed += 1
		} catch (err) {
			console.error(`FAIL — ${name}`)
			console.error(err)
			process.exitCode = 1
		}
	}
	if (passed === tests.length) console.log(`\nPASS — ${passed} Funnel health tests`)
})()
