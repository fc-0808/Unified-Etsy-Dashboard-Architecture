'use strict'

/**
 * Coalesces bursty perceptual-hash updates into one canonical identity pass.
 * The expensive resolver remains synchronous and authoritative; this class only
 * controls when it runs.
 */
class ProductIdentityCoordinator {
	constructor({ reconcile, onResult = null, delayMs = 750, defer = setImmediate } = {}) {
		if (typeof reconcile !== 'function') throw new TypeError('reconcile function is required')
		this.reconcile = reconcile
		this.onResult = onResult
		this.delayMs = delayMs
		this.defer = defer
		this.timer = null
		this.reasons = new Set()
		this.running = false
		this.lastResult = { groups: 0, updated: 0 }
	}

	schedule(reason = 'background', delayMs = this.delayMs) {
		this.reasons.add(reason)
		if (this.timer) clearTimeout(this.timer)
		this.timer = setTimeout(() => {
			this.timer = null
			this.defer(() => this._run())
		}, Math.max(0, Number(delayMs) || 0))
	}

	runNow(reason = 'operator') {
		this.reasons.add(reason)
		if (this.timer) {
			clearTimeout(this.timer)
			this.timer = null
		}
		return this._run()
	}

	_run() {
		if (this.running) {
			// A synchronous reconcile cannot normally be re-entered, but retaining the
			// reason guarantees a trailing pass if a callback ever schedules one.
			return this.lastResult
		}
		this.running = true
		const reasons = [...this.reasons]
		this.reasons.clear()
		try {
			this.lastResult = this.reconcile({ reasons }) || { groups: 0, updated: 0 }
			if (typeof this.onResult === 'function') this.onResult(this.lastResult, reasons)
			return this.lastResult
		} finally {
			this.running = false
			if (this.reasons.size) this.schedule('trailing')
		}
	}

	cancel() {
		if (this.timer) clearTimeout(this.timer)
		this.timer = null
		this.reasons.clear()
	}
}

module.exports = { ProductIdentityCoordinator }
