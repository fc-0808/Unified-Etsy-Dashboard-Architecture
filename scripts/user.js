#!/usr/bin/env node
/**
 * user.js — command-line management of dashboard accounts.
 *
 *   npm run user -- add <username> <owner|packer|shopper> [password]
 *   npm run user -- list
 *   npm run user -- disable <username>      (offboard: revokes live sessions too)
 *   npm run user -- enable  <username>
 *   npm run user -- passwd  <username> [password]
 *   npm run user -- revoke  <username>      (force-logout everywhere)
 *
 * If no password is given, a strong one is generated and printed once.
 * This is the reliable backbone for onboarding/offboarding; the same actions are
 * also available in the dashboard's owner-only "Team" panel.
 */

require('dotenv').config({ quiet: true })
const crypto = require('crypto')
const { loadConfig } = require('../src/config/schema')
const { initDb } = require('../src/db/setup')
const { createUserStore } = require('../src/auth/user-store')

const cfg = loadConfig()
const db = initDb(cfg.db_path)
const store = createUserStore(db)

const [, , cmd, ...args] = process.argv
const genPassword = () => crypto.randomBytes(9).toString('base64url') // ~12 chars

function usage() {
	console.log(
		`\nDashboard user management\n\n` +
			`  npm run user -- add <username> <owner|packer|shopper> [password]\n` +
			`  npm run user -- list\n` +
			`  npm run user -- disable <username>\n` +
			`  npm run user -- enable  <username>\n` +
			`  npm run user -- passwd  <username> [password]\n` +
			`  npm run user -- revoke  <username>\n`,
	)
}

function fmtRow(u) {
	const last = u.last_login_at ? new Date(u.last_login_at).toLocaleString() : 'never'
	return `  #${u.id}  ${u.username.padEnd(20)} ${u.role.padEnd(7)} ${u.active ? 'ACTIVE ' : 'DISABLED'}  last login: ${last}`
}

function requireUser(name) {
	const u = store.getByName(name)
	if (!u) {
		console.error(`✗ No such user: ${name}`)
		process.exit(1)
	}
	return u
}

try {
	switch (cmd) {
		case 'add': {
			const [username, role, pwArg] = args
			if (!username || !role) return usage()
			const password = pwArg || genPassword()
			const u = store.add({ username, password, role, createdBy: 'cli' })
			console.log(`✓ Created ${u.role} account "${u.username}"`)
			if (!pwArg) console.log(`  Password (save this now, it won't be shown again):  ${password}`)
			if (!process.env.DASHBOARD_AUTH_SECRET) {
				console.warn('  Before restarting the dashboard, set DASHBOARD_AUTH_SECRET (generate with npm run auth:generate-secret).')
			}
			break
		}
		case 'list': {
			const users = store.list()
			if (!users.length) {
				console.log('  (no named users yet — add one with `npm run user -- add`)')
			} else {
				users.forEach((u) => console.log(fmtRow(u)))
			}
			break
		}
		case 'disable': {
			const u = requireUser(args[0])
			if (u.role === 'owner' && u.active && store.activeOwnerCount() <= 1) {
				console.error('✗ Refusing to disable the last active owner.')
				process.exit(1)
			}
			store.setActive(u.id, false)
			console.log(`✓ Disabled "${u.username}" and revoked their live sessions.`)
			break
		}
		case 'enable': {
			const u = requireUser(args[0])
			store.setActive(u.id, true)
			console.log(`✓ Enabled "${u.username}".`)
			break
		}
		case 'passwd': {
			const u = requireUser(args[0])
			const password = args[1] || genPassword()
			store.setPassword(u.id, password)
			console.log(`✓ Password updated for "${u.username}" (existing sessions revoked).`)
			if (!args[1]) console.log(`  New password:  ${password}`)
			break
		}
		case 'revoke': {
			const u = requireUser(args[0])
			store.revokeSessions(u.id)
			console.log(`✓ Revoked all live sessions for "${u.username}".`)
			break
		}
		default:
			usage()
	}
} catch (e) {
	console.error(`✗ ${e.message}`)
	process.exit(1)
}
