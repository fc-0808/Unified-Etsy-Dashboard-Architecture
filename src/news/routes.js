'use strict'

const { createBriefingService, parseNewsQuery, filterBriefing } = require('./etsy-news')

/**
 * GET /api/news?window=90&kind=all&refresh=1
 *
 * Owner-only because the route is not in the employee ACL. The handler still
 * validates the query: window and kind are a fixed set, and refresh is a flag.
 * The briefing itself never accepts a URL from the client.
 */
function installRoutes(app, { cacheDir, networkTransport, service, log } = {}) {
	const briefing = service || createBriefingService({ cacheDir, networkTransport, log })

	app.get('/api/news', async (req, res) => {
		const parsed = parseNewsQuery(req.query || {})
		if (parsed.error) return res.status(400).json({ error: parsed.error })
		try {
			const loaded = await briefing.load({ refresh: parsed.refresh })
			res.json(filterBriefing(loaded, { windowDays: parsed.windowDays, kind: parsed.kind }))
		} catch (err) {
			console.error('[news] briefing failed:', err && err.message ? err.message : err)
			res.status(502).json({ error: 'Could not load the Etsy briefing' })
		}
	})
}

module.exports = { installRoutes }
