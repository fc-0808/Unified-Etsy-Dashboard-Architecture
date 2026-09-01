'use strict';

/**
 * Regression tests for shopping-route product image URLs.
 *
 * Root cause #1 (same-origin): the /shop service worker cache-firsts image
 * fetches, but CSP connect-src is 'self', so SW fetch() to i.etsystatic.com
 * fails and every direct CDN thumbnail hits onerror → placeholder. Listing
 * photos must be same-origin (/api/route/listing-image/:id).
 *
 * Root cause #2 (WHICH listing): the proxy used to be built from the row's
 * `listing_id` — the listing the buyer ORDERED. After a design switch the line
 * is bought as a DIFFERENT listing, so the shopping floor served the design the
 * buyer had just moved away from, while the Orders and Route tabs (which render
 * `image_url` verbatim) correctly showed the replacement. The proxy must key off
 * `product_listing_id`: the listing the line is actually BOUGHT as.
 */

const assert = require('assert');
const { etsyThumb, shopRouteImageUrl, SHOP_CARD_WIDTH } = require('../src/route/shop-images');

const ETSY = 'https://i.etsystatic.com/12345678/r/il/abc123/4567890123/il_570xN.4567890123_qwer.jpg';
/** The photo of the design the buyer switched AWAY from — must never be served. */
const ORIGINAL_CDN = 'https://i.etsystatic.com/11111111/r/il/aaa111/1111111111/il_570xN.1111111111_orig.jpg';
/** The replacement design the operator switched the line TO. */
const REPLACEMENT_CDN = 'https://i.etsystatic.com/22222222/r/il/bbb222/2222222222/il_570xN.2222222222_repl.jpg';

const ORIGINAL_LISTING = 111;
const REPLACEMENT_LISTING = 222;

assert.strictEqual(
  etsyThumb(ETSY),
  'https://i.etsystatic.com/12345678/r/il/abc123/4567890123/il_300x300.4567890123_qwer.jpg',
  'etsyThumb rewrites Etsy CDN size token',
);

// ── Unswitched lines ────────────────────────────────────────────────────────
// product_listing_id === listing_id, so nothing observable changes.

assert.strictEqual(
  shopRouteImageUrl({ listing_id: 4242, product_listing_id: 4242, image_url: ETSY }),
  `/api/route/listing-image/4242?w=${SHOP_CARD_WIDTH}`,
  'listing rows proxy through same-origin listing-image endpoint',
);

assert.strictEqual(
  shopRouteImageUrl({ listing_id: 99, product_listing_id: 99, image_url: '/api/route/style-image/7?v=1700000000' }),
  '/api/route/style-image/7?v=1700000000',
  'local /api/ image URLs pass through unchanged',
);

assert.strictEqual(
  shopRouteImageUrl({
    listing_id: 99,
    product_listing_id: 99,
    image_url: '/api/route/variation-image/99?k=Case%201%20%2B%20Grip%201&v=1',
  }),
  '/api/route/variation-image/99?k=Case%201%20%2B%20Grip%201&v=1',
  'Etsy style-variation photos stay on the same-origin proxy',
);

assert.strictEqual(
  shopRouteImageUrl({ listing_id: null, product_listing_id: null, image_url: ETSY }),
  etsyThumb(ETSY),
  'rows with no product listing fall back to CDN thumb',
);

assert.strictEqual(
  shopRouteImageUrl({ listing_id: 1, product_listing_id: 1, image_url: null }),
  null,
  'null image_url stays null',
);

// ── Switched lines — the bug this file exists to keep dead ───────────────────

{
  // A CATALOG switch: the row still carries the ORDERED listing, but its photo
  // and its product identity belong to the replacement.
  const proxied = shopRouteImageUrl({
    listing_id: ORIGINAL_LISTING,
    product_listing_id: REPLACEMENT_LISTING,
    image_url: REPLACEMENT_CDN,
  });
  assert.strictEqual(
    proxied,
    `/api/route/listing-image/${REPLACEMENT_LISTING}?w=${SHOP_CARD_WIDTH}`,
    'a catalog design switch proxies the REPLACEMENT listing',
  );
  assert.ok(
    !proxied.includes(String(ORIGINAL_LISTING)),
    'a catalog design switch NEVER proxies the originally ordered listing',
  );
}

assert.strictEqual(
  shopRouteImageUrl({
    listing_id: ORIGINAL_LISTING,
    product_listing_id: null,
    image_url: '/api/route/substitution-image/9?v=1700000000',
  }),
  '/api/route/substitution-image/9?v=1700000000',
  'a custom switch serves its uploaded photo, not the ordered listing',
);

assert.strictEqual(
  shopRouteImageUrl({
    listing_id: ORIGINAL_LISTING,
    product_listing_id: null,
    image_url: REPLACEMENT_CDN,
  }),
  etsyThumb(REPLACEMENT_CDN),
  'a switch with no known replacement listing keeps the replacement CDN photo',
);

// Fail-safe: a caller that forgets product_listing_id must degrade to the CDN
// url, never guess a listing. A thumbnail that may not load through the PWA is
// far better than a confident photo of the wrong product — the shopper buys
// what they see.
assert.strictEqual(
  shopRouteImageUrl({ listing_id: ORIGINAL_LISTING, image_url: ORIGINAL_CDN }),
  etsyThumb(ORIGINAL_CDN),
  'a row missing product_listing_id never proxies a guessed listing',
);

console.log('test-shop-images: all assertions passed');
