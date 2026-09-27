# Unified Dashboard

Private, single-tenant operations software for order fulfilment, listing drafts,
4PX shipping, purchasing routes, and reporting. The Node.js/Express process uses
SQLite locally and invokes the vendored Python route engine when requested.

## Operating notes

- The dashboard calls Etsy's documented Open API.
- Default to draft listings and complete manual review before publishing.
- Never run live Etsy checks as part of the default test suite.
- Keep `config.json`, `tokens.json`, SQLite files, logs, and backups out of Git.
- Keep both the dashboard and route-engine SQLite/catalog data outside OneDrive,
  Dropbox, and other sync folders. With processes stopped, use
  `npm run relocate-db` and `npm run relocate-route-data`.

## Local setup

1. Install current Node.js and Python.
2. Run `npm install`.
3. Run `python -m pip install -r route-engine/requirements.txt`.
4. Copy `config.example.json` to `config.json` and fill only approved settings.
   The current Efan setup uses its real loopback SOCKS5 listener:
   `network_transport.mode = "local_socks5"` on `127.0.0.1:7897`. Keep Efan's
   **Allow LAN access** disabled.
5. Copy `.env.example` to `.env`, generate a session secret with
   `npm run auth:generate-secret`, then set authentication secrets:

   ```text
   DASHBOARD_OWNER_PASSWORD=<strong owner passphrase>
   DASHBOARD_AUTH_SECRET=<at least 32 cryptographically random bytes>
   ```

6. Complete the documented, user-driven OAuth flow with `npm run oauth:setup`.
7. Start locally with `npm start`.

When authentication is disabled, the server binds to loopback only. LAN exposure
without authentication requires the explicit
`DASHBOARD_ALLOW_UNAUTHENTICATED_NETWORK=1` override and is not recommended.
Cross-origin browser access is disabled by default. If a separate trusted origin
is genuinely required, list exact origins in the comma-separated
`DASHBOARD_CORS_ORIGINS` variable; never use a wildcard.
Forwarded client IP/protocol headers are trusted from loopback proxies only by
default. Configure `DASHBOARD_TRUST_PROXY` explicitly for any other reverse proxy.
Employee desktop capabilities are enforced as office-network-only at the API
layer; remote employee sessions retain only the mobile shopper capability set.

## Verification

`npm test` is the safe default gate. It uses in-memory or temporary databases,
offline mocks, an isolated server fixture, and no live Etsy writes.

```powershell
npm test
npm run audit:dependencies
```

Before enabling sync after a VPN or proxy change, verify the transport without
calling Etsy:

```powershell
npm run proxy:verify
```

In the current `local_socks5` mode, UED explicitly connects through Efan's
loopback SOCKS5 listener and then the configured IPFoxy SOCKS5 endpoint. IPFoxy
remains the mandatory final public exit; there is no direct Etsy fallback.
`system_tunnel` remains available for VPN clients that own the OS route but do
not expose a real SOCKS5 listener.

For manual AdsPower seller-site access, configure the read-only Local API key
and run:

```powershell
npm run browser:verify
```

This checks profile-to-proxy metadata without opening a browser or contacting
Etsy. Follow the [manual browser network runbook](docs/manual-browser-network.md).
If it reports that the configured AdsPower Local API port is reachable off-loopback, run
`npm run browser:secure-api` from an Administrator PowerShell.

The `Safe CI` GitHub Actions workflow runs the same gate on Windows with Node 22
and Python 3.12. Dependabot proposes grouped minor/patch maintenance updates;
major upgrades remain isolated for explicit review.

The live read integration is separately gated because it spends Etsy quota and
writes fetched receipts to the configured database:

```powershell
$env:ALLOW_LIVE_ETSY_READ_TEST = '1'
npm run integration:etsy-read
```

Do not set that flag in CI.

## Growth analytics (manual by default)

Opening or refreshing the **Growth** tab makes zero Etsy API calls. The default
workflow is to copy aggregate figures from Etsy Shop Manager and use **Import
Etsy Stats**:

1. Select one shop.
2. Enter equal, adjacent 7-day or 28-day current and previous periods.
3. Enter orders plus the same traffic metric (visits or views) for both periods.
4. Optionally enter revenue, conversion, favorites, ad spend, rating, listing
   counts, and vacation status.

Pasted source text is parsed in memory and is not stored. SQLite retains only the
validated aggregate comparison, its provenance, the importing dashboard user,
and any data-quality warnings. No buyer/order/listing identity is accepted by
this aggregate import.

For listing-level diagnosis, expand **Optional per-listing deep dive**:

1. In Shop Manager → Stats, choose the same current period and copy the listing
   performance table (Listing ID/title, views, favorites, orders, and revenue).
2. Repeat for the previous equal period and paste both tables under the
   `CURRENT LISTINGS` and `PREVIOUS LISTINGS` headings.
3. Preview the match before saving. Listing ID is preferred; an exact normalized
   title is used only when Etsy does not expose the ID in copied rows.

The raw paste is discarded and only normalized per-listing aggregates are
stored. The report separates viewed-without-orders, traffic losses, favorites
without order growth, current winners, and no-traction listings. It never
accepts buyer, address, message, payment, or order-level data. Etsy's downloadable
active-listings CSV contains listing content but not views/favorites performance,
so it is not presented as a Stats export and the dashboard does not scrape Shop
Manager.

Optional listing/review API collection is disabled by default:

```json
{
  "catalog_health_sync": false
}
```

Set `catalog_health_sync` to `true` to opt into the once-per-shop listing/review
walk. Opening Growth does not call Etsy. The on-demand fetch still asks you to
select one shop and confirm the run. Existing Orders and Earnings
synchronization are separate workflows.

Open API v3 does not expose visits, conversion rate, traffic sources, Etsy
search terms, or the Shop Manager listing-Stats table.

### Listing experiment cadence

The Growth tab treats new listings as measured product/search experiments—not an
algorithm quota. Etsy documents a small, temporary recency boost while it learns
engagement, but explicitly says creating or renewing listings solely for that
boost is not an effective search strategy. The planner therefore recommends at
most one or two genuinely distinct listings per ready shop per week, and pauses
that suggestion when conversion, rating, vacation, expiry, or dispatch problems
should be fixed first.

Review indexing after 48 hours, then compare qualified visits, conversion, and
orders at 14 and 28 days. Prefer Etsy's current guidance:

- [How Etsy Search Works](https://www.etsy.com/seller-handbook/article/how-etsy-search-works/375461474487)
- [New Guidance for Listing Titles](https://www.etsy.com/seller-handbook/article/1399426136697)
- [Etsy Search Visibility](https://help.etsy.com/hc/en-us/articles/25869947521175-How-to-Use-the-Etsy-Search-Visibility-Page)
- [Marketplace Insights](https://help.etsy.com/hc/en-us/articles/35122361353239-How-Do-I-Use-Etsy-s-Marketplace-Insights-Tool)
- [Share & Save](https://help.etsy.com/hc/en-us/articles/16981332744087-How-to-Save-on-Etsy-Fees-with-the-Share-Save-Program)

## Public mobile link

Tailscale Funnel exposes the authenticated mobile route without requiring
Tailscale on the phone:

```powershell
npm run funnel
npm run funnel:check
```

`npm run funnel` does not trust saved configuration alone. It verifies
`/api/health` through the public Funnel relay addresses, preserving the real TLS
hostname while bypassing this computer's private MagicDNS answer. If the local
dashboard is healthy but every public relay drops the connection, the command
performs one guarded `tailscale down`/`tailscale up`, restores Funnel, and
verifies it again. An inconclusive DNS check never restarts the network.

The PM2 production definition also runs `etsy-funnel-watchdog`. It checks an
already-enabled Funnel every two minutes and repairs only after two consecutive
public-path failures, with a 30-minute repair cooldown. It never turns Funnel
back on after `npm run funnel:stop`.

## Production

PM2 runs exactly one dashboard process so embedded schedulers cannot duplicate
API work, plus the independent public-link watchdog:

```powershell
npm run auto:start
npm run auto:status
npm run auto:logs
```

Before exposing the dashboard beyond localhost, verify authentication, firewall
rules, the configured bind address, and database backups.

The term “Etsy” is a trademark of Etsy, Inc. This Application uses Etsy's API,
but is not endorsed or certified by Etsy.
