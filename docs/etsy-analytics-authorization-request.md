# Etsy analytics authorization request

Do not enable `etsy_api_analytics_approved` or `catalog_health_sync` merely
because this request was sent. Save Etsy's affirmative written response with
the app's compliance records, and enable the flags only if the response clearly
covers the proposed use.

Send to the developer-support address listed in Etsy's current developer
materials (currently `developer@etsy.com`). Replace every bracketed item.

## Suggested request

**Subject:** Written scope confirmation for first-party multi-shop seller dashboard

Hello Etsy Developer Support,

I am requesting written scope confirmation for `[APPLICATION NAME]`, keystring
ending in `[LAST FOUR CHARACTERS ONLY]`. This is a private, first-party
operations dashboard used only by the owner of `[NUMBER]` Etsy shops. It is not
sold, distributed, or made available to other sellers.

The application currently uses OAuth-authorized operational endpoints for order
fulfilment and listing management. We will not scrape Etsy, call internal/AJAX
endpoints, automate a browser, rotate identities, create duplicate apps to
bypass limits, or manipulate engagement.

Please confirm the following separately:

1. Under API Terms §5(24), may this private application analyze shop-level and
   per-listing Stats that the seller manually copies from their own Shop Manager?
   The software does not access Etsy to obtain this data. Raw pasted text is
   discarded, and only aggregate metrics such as visits, views, favorites,
   orders, revenue, and equal-period changes are stored locally.
2. Under API Terms §5(25), do you expressly authorize this application to
   request API content for first-party seller analytics using:
   - `GET /v3/application/shops/{shop_id}`
   - `GET /v3/application/shops/{shop_id}/listings`
   - `GET /v3/application/shops/{shop_id}/reviews`
3. Does one designated application key have permission to serve all of the
   owner's OAuth-authorized shops? If Etsy has already assigned multiple keys,
   please confirm the exact approved key-to-shop topology. We will not use
   multiple keys to multiply or evade rate limits.
4. What retention period does Etsy approve for daily aggregate listing-view,
   favorite, listing-state, shop-health, and review-quality snapshots? No buyer
   ID, address, email, message, or payment credential is stored for Growth.

If API analytics is authorized, the controls will be:

- disabled by default behind two independent configuration gates;
- zero calls when the Growth page opens or refreshes;
- one explicitly selected shop per on-demand run;
- a fresh human confirmation before each on-demand run;
- cache-first collection no more often than once per shop per 24 hours;
- a hard 15-page listing cap, QPD reserve, centralized QPS pacing, exponential
  backoff, and `Retry-After` handling;
- local encrypted/access-controlled deployment with owner-only Growth access;
- no onward sale, advertising integration, model training, or cross-seller
  benchmarking.

Please state any additional review, access tier, privacy terms, retention limits,
or App Quality Standards we must meet. Until affirmative written authorization
is retained, API-based Growth collection will remain disabled.

Thank you,

`[LEGAL NAME]`  
`[DEVELOPER ACCOUNT EMAIL]`  
`[APPLICATION NAME]`

## Evidence to retain

- Full support thread, including headers and date.
- Application name and masked keystring covered by the response.
- Exact shops/use case and endpoints Etsy approved.
- Approved retention period and data classes.
- Any conditions, expiry date, or required re-review.
- Date the configuration flags were enabled and by whom.

An automated reply, ordinary Personal/Commercial Access, OAuth consent, or a
successful API response is not express analytics authorization.
