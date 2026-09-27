'use strict'

const fs = require('fs')
const path = require('path')

/**
 * Resolve the Node binary that should run the dashboard under PM2.
 *
 * Cursor agent shells ship their own Node (currently 24.x). If PM2 inherits
 * that interpreter, native addons such as better-sqlite3 — compiled for the
 * system Node 22 install — fail with ERR_DLOPEN_FAILED and the dashboard
 * never binds :4000.
 */
function isEditorBundledNode(nodePath) {
	const normalized = String(nodePath || '').replace(/\//g, '\\').toLowerCase()
	return normalized.includes('\\cursor\\') || normalized.includes('\\vscode\\')
}

function resolveDashboardNode(env = process.env, execPath = process.execPath) {
	const pinned = env.DASHBOARD_NODE
	if (pinned && fs.existsSync(pinned) && !isEditorBundledNode(pinned)) return pinned

	if (process.platform === 'win32') {
		const programFiles = env.ProgramFiles || 'C:\\Program Files'
		const systemNode = path.join(programFiles, 'nodejs', 'node.exe')
		if (fs.existsSync(systemNode)) return systemNode
	}

	if (execPath && fs.existsSync(execPath) && !isEditorBundledNode(execPath)) return execPath
	return 'node'
}

module.exports = {
	isEditorBundledNode,
	resolveDashboardNode,
}
