# Unified Dashboard

Private, single-tenant operations software for order fulfilment, listing drafts,
4PX shipping, purchasing routes, and reporting. The Node.js/Express process uses
SQLite locally and invokes the vendored Python route engine when requested.

## Safety boundaries

- Use only Etsy's documented Open API. Do not scrape or automate Etsy webpages.
- Use the API key and shop topology Etsy approved for this application's declared
  purpose. Multiple keys in one application require written Etsy approval.
- Default to draft listings and complete manual review before publishing.
- Never run live Etsy checks as part of the default test suite.
- Keep `config.json`, `tokens.json`, SQLite files, logs, and backups out of Git.
- Keep both the dashboard and route-engine SQLite/catalog data outside OneDrive,
  Dropbox, and other sync folders. With processes stopped, use
  `npm run relocate-db` and `npm run relocate-route-data`.

Relevant safeguards are based on:

- [Etsy API Terms](https://www.etsy.com/legal/api/)
- [Etsy API Testing Policy](https://www.etsy.com/legal/policy/api-testing-policy/169130941112)

## Local setup

1. Install current Node.js and Python.
2. Run `npm install`.
3. Run `python -m pip install -r route-engine/requirements.txt`.
4. Copy `config.example.json` to `config.json` and fill only approved settings.
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

Zero calls removes API request-volume, rate-limit, scraping, and bot-detection
risk from this workflow; it is not an Etsy authorization guarantee. API Terms
§5(24) also use broad language about automated systems analyzing “any Etsy
data.” Because this dashboard is an API-integrated application, the lowest-risk
contractual posture is to obtain and retain Etsy's written confirmation that
seller-directed local analysis of manually entered shop data is permitted.

Optional listing/review API collection is disabled by default:

```json
{
  "catalog_health_sync": false,
  "etsy_api_analytics_approved": false
}
```

Etsy's API Terms (updated August 18, 2026) require express written authorization
for the activities described in §§5(24)–(25), including requesting Etsy API
content for analytics. Set
`etsy_api_analytics_approved` to `true` only after retaining that written
authorization, then set `catalog_health_sync` to `true` as a separate opt-in.
Both gates are required. Even then, the UI requires selecting one shop and
confirming each on-demand collection. Existing Orders and Earnings
synchronization are separate operational workflows and are unchanged by this
Growth setting. Operational Listings sync can still refresh listing content and
inventory, but it does not persist or overwrite API view/favorite metrics while
the analytics gates are off.

Open API v3 does not expose visits, conversion rate, traffic sources, Etsy
search terms, or the Shop Manager listing-Stats table. Therefore API collection
is neither a substitute for Shop Manager Stats nor recommended for Growth unless
Etsy approves the exact analytics use in writing.

Use the review-ready
[analytics authorization request](docs/etsy-analytics-authorization-request.md)
to ask Etsy about both the local manual workflow (§5(24)) and optional API
collection (§5(25)). Ordinary API access, OAuth consent, or a successful response
does not by itself constitute analytics authorization.

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

### Marketplace policy gates

- API-based Growth collection requires both a retained Etsy written
  authorization and explicit configuration; manual imports require neither.
- A dashboard using multiple API keys remains a high-risk configuration until
  Etsy approves that exact topology in writing. `etsy_multi_key_approved` records
  retained approval; it does not create permission.
- Every bulk listing starts as a local-only preview. No generated preview can
  become an Etsy draft or be published until an owner reviews it and records the
  versioned marketplace-policy attestation.
- Safe previews use cached shop settings and cannot hide an Etsy settings fetch.
  Refreshing those settings is a separate, explicit operator action.
- Character recognition identifies a possible third-party rights holder; it
  never represents that the seller owns a license. Supplier availability is not
  proof of authorization.
- The attestation covers original design or documented authorization, Creativity
  Standards eligibility, production-partner disclosure, and accurate
  images/claims. Retain the underlying license and original-design records
  outside this application.

Policy references:

- [Etsy API Terms](https://www.etsy.com/legal/api/)
- [Etsy Seller Policy](https://www.etsy.com/legal/sellers)
- [Etsy Creativity Standards](https://www.etsy.com/legal/creativity)
- [Etsy Intellectual Property Policy](https://www.etsy.com/legal/ip/)

## Production

PM2 runs exactly one process so embedded schedulers cannot duplicate API work:

```powershell
npm run auto:start
npm run auto:status
npm run auto:logs
```

Before exposing the dashboard beyond localhost, verify authentication, firewall
rules, the configured bind address, database backups, and the compliance report.

The term “Etsy” is a trademark of Etsy, Inc. This Application uses Etsy's API,
but is not endorsed or certified by Etsy.
