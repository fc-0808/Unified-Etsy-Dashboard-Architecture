'use strict'

const assert = require('node:assert/strict')
const os = require('os')
const path = require('path')
const { isEditorBundledNode, resolveDashboardNode } = require('../src/server/system-node')

assert.equal(isEditorBundledNode('C:\\Users\\w088s\\AppData\\Local\\Programs\\cursor\\resources\\app\\resources\\helpers\\node.exe'), true)
assert.equal(isEditorBundledNode('C:\\Program Files\\nodejs\\node.exe'), false)
assert.equal(isEditorBundledNode('/usr/local/bin/node'), false)

const systemNode = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe')
const resolved = resolveDashboardNode({
	...process.env,
	DASHBOARD_NODE: undefined,
	ProgramFiles: process.env.ProgramFiles || 'C:\\Program Files',
}, 'C:\\Users\\me\\AppData\\Local\\Programs\\cursor\\resources\\helpers\\node.exe')

if (process.platform === 'win32') {
	assert.equal(resolved, systemNode)
}

const pinned = path.join(os.tmpdir(), 'definitely-missing-node.exe')
assert.notEqual(resolveDashboardNode({ DASHBOARD_NODE: pinned, ProgramFiles: process.env.ProgramFiles }, process.execPath), pinned)

const forced = path.join(os.tmpdir(), 'dashboard-node-pin-test')
require('fs').writeFileSync(forced, '')
try {
	assert.equal(resolveDashboardNode({ DASHBOARD_NODE: forced }, process.execPath), forced)
} finally {
	require('fs').unlinkSync(forced)
}

console.log('test-system-node: ok')
