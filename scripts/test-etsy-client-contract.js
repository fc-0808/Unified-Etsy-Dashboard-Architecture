'use strict';

/**
 * Offline contract tests for Etsy request serialization and ambiguous-write
 * reconciliation. No credentials, database, proxy, or network are used.
 */
const assert = require('node:assert/strict');
const {
  createDraftListingForm,
  createReceiptShipment,
  createShopReadinessStateDefinition,
  findMatchingDraftListing,
  getReceipts,
  getListingImageCatalogBatch,
  getListingVariationImages,
  normalizeEtsySortOrder,
  RateLimiter,
  QpdExhaustedError,
  uploadListingImage,
  uploadListingVideo,
  updateListing,
} = require('../src/etsy/client');
const { fetchShopListingSettings, getShopListingSettings } = require('../src/listings/shop-settings');

const realSetTimeout = global.setTimeout;
global.setTimeout = (fn) => { fn(); return 0; };

let clientSeq = 0;
function client(overrides = {}) {
  clientSeq += 1;
  return {
    defaults: {
      headers: { 'x-api-key': `offline-key-${clientSeq}:secret` },
      __etsyPriority: 'normal',
    },
    get: overrides.get || (async () => ({ data: {} })),
    post: overrides.post || (async () => ({ data: {} })),
    patch: overrides.patch || (async () => ({ data: {} })),
  };
}

function networkError() {
  return Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
}

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  — ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.error(`  FAIL — ${name}\n       ${err.stack || err.message}`);
  }
}

(async () => {
  await test('background traffic stops at the 300-call fulfilment reserve', async () => {
    const limiter = new RateLimiter(302, 'offline-reserve', 1000);
    limiter.check('normal');
    limiter.check('normal');
    assert.throws(
      () => limiter.check('normal'),
      (err) => err instanceof QpdExhaustedError && err.code === 'ETSY_QPD_EXHAUSTED' && /reserved for order fulfilment/.test(err.message),
    );
    assert.doesNotThrow(() => limiter.check('critical'));
  });

  await test('server-reported low budget overrides a larger local estimate', async () => {
    const limiter = new RateLimiter(4900, 'offline-server', 1000);
    limiter.updateFromHeaders({ 'x-remaining-today': '300' }, 'Offline test');
    assert.equal(limiter.serverRemaining, 300);
    assert.throws(() => limiter.check('normal'), (err) => err?.code === 'ETSY_QPD_EXHAUSTED');
    assert.doesNotThrow(() => limiter.check('critical'));
  });

  await test('429 cooldown is honored and then permits one half-open probe', async () => {
    const realNow = Date.now;
    let clock = 1_800_000_000_000;
    Date.now = () => clock;
    try {
      const limiter = new RateLimiter(4900, 'offline-cooldown', 1000);
      limiter.noteCooldown(10);
      assert.equal(limiter.blockedForMs, 10_000);
      assert.throws(() => limiter.check('normal'), (err) => err?.code === 'ETSY_QPD_EXHAUSTED');
      clock += 10_001;
      assert.doesNotThrow(() => limiter.check('normal'));
      assert.equal(limiter.blockedForMs, 0);
      assert.equal(limiter.serverRemaining, null);
    } finally {
      Date.now = realNow;
    }
  });

  await test('concurrent QPS callers reserve distinct paced slots', async () => {
    const realNow = Date.now;
    Date.now = () => 2_000_000;
    try {
      const limiter = new RateLimiter(4900, 'offline-qps', 4);
      await Promise.all([
        limiter.throttleQps(),
        limiter.throttleQps(),
        limiter.throttleQps(),
      ]);
      assert.equal(limiter._minRequestIntervalMs, 250);
      assert.equal(limiter._nextRequestAt, 2_000_750);
    } finally {
      Date.now = realNow;
    }
  });

  await test('normalizes Etsy sort-order aliases to up/down', async () => {
    assert.equal(normalizeEtsySortOrder('desc'), 'down');
    assert.equal(normalizeEtsySortOrder('ascending'), 'up');
    assert.equal(normalizeEtsySortOrder('invalid'), 'down');
  });

  await test('receipt requests never send undocumented desc', async () => {
    let request;
    const c = client({
      get: async (url, options) => {
        request = { url, options };
        return { data: { count: 0, results: [] } };
      },
    });
    await getReceipts(c, 123, { sort_order: 'desc' });
    assert.equal(request.url, '/application/shops/123/receipts');
    assert.equal(request.options.params.sort_order, 'down');
  });

  await test('listing PATCH uses the documented form encoding', async () => {
    let request;
    const c = client({
      patch: async (url, body, options) => {
        request = { url, body, options };
        return { data: { listing_id: 7 } };
      },
    });
    await updateListing(c, 123, 7, {
      title: 'A & B',
      tags: ['phone case', 'blue'],
      state: 'active',
    });
    const form = new URLSearchParams(request.body);
    assert.equal(request.url, '/application/shops/123/listings/7');
    assert.equal(form.get('title'), 'A & B');
    assert.equal(form.get('tags'), 'phone case,blue');
    assert.equal(form.get('state'), 'active');
    assert.equal(request.options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  });

  await test('manual draft create shares the documented array/boolean encoding', async () => {
    let request;
    const c = client({
      post: async (url, body, options) => {
        request = { url, body, options };
        return { data: { listing_id: 8 } };
      },
    });
    await createDraftListingForm(c, 123, {
      title: 'Fixture',
      tags: ['one', 'two'],
      production_partner_ids: [10, 11],
      should_auto_renew: true,
    }, { reconcile: false });
    const form = new URLSearchParams(request.body);
    assert.equal(form.get('tags'), 'one,two');
    assert.deepEqual(form.getAll('production_partner_ids'), ['10', '11']);
    assert.equal(form.get('should_auto_renew'), 'true');
    assert.equal(request.options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  });

  await test('lost draft-create response adopts the exact recent draft', async () => {
    const createdAfter = Math.floor(Date.now() / 1000);
    const body = {
      quantity: 3,
      title: 'Exact offline fixture',
      description: 'Exact fixture description',
      price: 12.34,
      who_made: 'someone_else',
      when_made: 'made_to_order',
      taxonomy_id: 1,
    };
    let posts = 0;
    let postedUrl = '';
    const c = client({
      post: async (url) => {
        posts += 1;
        postedUrl = url;
        throw networkError();
      },
      get: async () => ({
        data: {
          results: [{
            listing_id: 998,
            state: 'draft',
            title: body.title,
            description: body.description,
            taxonomy_id: body.taxonomy_id,
            price: { amount: 1234, divisor: 100, currency_code: 'USD' },
            created_timestamp: createdAfter,
          }],
        },
      }),
    });
    const result = await createDraftListingForm(c, 123, body, {
      createdAfter,
      legacy: true, // legacy callers must not put an undocumented query on wire
    });
    assert.equal(result.listing_id, 998);
    assert.equal(posts, 1);
    assert.equal(postedUrl, '/application/shops/123/listings');
  });

  await test('ambiguous draft create fails closed when no match is visible', async () => {
    let posts = 0;
    const c = client({
      post: async () => {
        posts += 1;
        throw networkError();
      },
      get: async () => ({ data: { count: 0, results: [] } }),
    });
    await assert.rejects(
      createDraftListingForm(c, 123, {
        quantity: 1,
        title: 'Unknown outcome',
        description: 'Must not be re-sent blindly',
        price: 9.99,
        who_made: 'someone_else',
        when_made: 'made_to_order',
        taxonomy_id: 1,
      }),
      (err) =>
        err
        && err.code === 'ETSY_CREATE_STATE_UNKNOWN'
        && /socket hang up/.test(err.cause?.message || '')
    );
    assert.equal(posts, 1);
  });

  await test('draft reconcile skips a matching listing claimed by another item', async () => {
    const createdAfter = Math.floor(Date.now() / 1000);
    const body = {
      title: 'Identical generated copy',
      description: 'Two products can receive the same text',
      taxonomy_id: 1,
      price: 10,
    };
    const listing = (listingId) => ({
      listing_id: listingId,
      title: body.title,
      description: body.description,
      taxonomy_id: body.taxonomy_id,
      price: { amount: 1000, divisor: 100 },
      created_timestamp: createdAfter,
    });
    const c = client({
      get: async () => ({ data: { results: [listing(100), listing(101)] } }),
    });
    const result = await findMatchingDraftListing(c, 123, body, {
      createdAfter,
      acceptListing: (candidate) => candidate.listing_id !== 100,
    });
    assert.equal(result.listing_id, 101);
  });

  await test('429 create response still reconciles before any re-send', async () => {
    const createdAfter = Math.floor(Date.now() / 1000);
    const body = {
      title: 'Rate limited response',
      description: 'The write may still have landed',
      taxonomy_id: 1,
      price: 10,
    };
    let posts = 0;
    const c = client({
      post: async () => {
        posts += 1;
        throw Object.assign(new Error('rate limited'), {
          response: { status: 429, headers: { 'retry-after': '1' } },
        });
      },
      get: async () => ({
        data: {
          results: [{
            listing_id: 202,
            ...body,
            price: { amount: 1000, divisor: 100 },
            created_timestamp: createdAfter,
          }],
        },
      }),
    });
    const result = await createDraftListingForm(c, 123, body, { createdAfter });
    assert.equal(result.listing_id, 202);
    assert.equal(posts, 1);
  });

  await test('shipment payload normalizes carrier and ship_date', async () => {
    let payload;
    const c = client({
      post: async (_url, body) => {
        payload = body;
        return { data: { receipt_id: 44 } };
      },
    });
    await createReceiptShipment(c, 123, 44, {
      tracking_code: 'T-44',
      carrier_name: '4PX',
      ship_date: 1_787_000_000,
    });
    assert.equal(payload.carrier_name, '4px');
    assert.match(payload.ship_date, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(new Date(payload.ship_date).getTime(), 1_787_000_000_000);
  });

  await test('edit-tracking response loss adopts only the new shipment', async () => {
    let reads = 0;
    let posts = 0;
    const oldShipment = { receipt_shipping_id: 1, tracking_code: 'EDIT-1' };
    const newShipment = { receipt_shipping_id: 2, tracking_code: 'EDIT-1' };
    const c = client({
      get: async () => {
        reads += 1;
        return {
          data: {
            receipt_id: 55,
            shipments: reads === 1 ? [oldShipment] : [oldShipment, newShipment],
          },
        };
      },
      post: async () => {
        posts += 1;
        throw networkError();
      },
    });
    const result = await createReceiptShipment(c, 123, 55, {
      tracking_code: 'EDIT-1',
      carrier_name: '4px',
      idempotent: false,
    });
    assert.equal(result.receipt_shipping_id, 2);
    assert.equal(posts, 1);
    assert.equal(reads, 2);
  });

  await test('video reconcile adopts only an ID created after the upload attempt', async () => {
    let posts = 0;
    const c = client({
      post: async () => {
        posts += 1;
        throw networkError();
      },
      get: async () => ({
        data: {
          results: [
            { video_id: 10, video_state: 'active' },
            { video_id: 11, video_state: 'active' },
          ],
        },
      }),
    });
    const result = await uploadListingVideo(c, 123, 456, {
      buffer: Buffer.from('video fixture'),
      filename: 'fixture.mp4',
      baselineVideoIds: ['10'],
    });
    assert.equal(result.video_id, 11);
    assert.equal(posts, 1);
  });

  await test('append-style image upload is never blindly re-sent', async () => {
    let posts = 0;
    const c = client({
      post: async () => {
        posts += 1;
        throw networkError();
      },
    });
    await assert.rejects(
      uploadListingImage(c, 123, 456, {
        buffer: Buffer.from('image fixture'),
        filename: 'fixture.jpg',
        rank: 1,
        overwrite: false,
      }),
      /socket hang up/
    );
    assert.equal(posts, 1);
  });

  await test('video upload fails closed when no new video can be identified', async () => {
    let posts = 0;
    const c = client({
      post: async () => {
        posts += 1;
        throw networkError();
      },
      get: async () => ({
        data: { results: [{ video_id: 10, video_state: 'active' }] },
      }),
    });
    await assert.rejects(
      uploadListingVideo(c, 123, 456, {
        buffer: Buffer.from('video fixture'),
        filename: 'fixture.mp4',
        baselineVideoIds: ['10'],
      }),
      (err) => err && err.code === 'ETSY_VIDEO_STATE_UNKNOWN'
    );
    assert.equal(posts, 1);
  });

  await test('processing-profile create adopts only a newly-created definition', async () => {
    let reads = 0;
    let posts = 0;
    const existing = {
      readiness_state_id: 1,
      readiness_state: 'made_to_order',
      min_processing_days: 3,
      max_processing_days: 5,
    };
    const created = { ...existing, readiness_state_id: 2 };
    const c = client({
      get: async () => {
        reads += 1;
        return { data: { results: reads === 1 ? [existing] : [existing, created] } };
      },
      post: async () => {
        posts += 1;
        throw networkError();
      },
    });
    const result = await createShopReadinessStateDefinition(c, 123, {
      readiness_state: 'made_to_order',
      min_processing_time: 3,
      max_processing_time: 5,
    });
    assert.equal(result.readiness_state_id, 2);
    assert.equal(posts, 1);
    assert.equal(reads, 2);
  });

  await test('variation-images GET uses the documented shop listing path', async () => {
    let request;
    const c = client({
      get: async (url) => {
        request = { url };
        return { data: { count: 1, results: [{ property_id: 514, value_id: 1, value: 'Case 1 + Grip 1', image_id: 11 }] } };
      },
    });
    const results = await getListingVariationImages(c, 123, 424242);
    assert.equal(request.url, '/application/shops/123/listings/424242/variation-images');
    assert.equal(results[0].image_id, 11);
  });

  await test('listing image catalog maps listing_image_id to CDN URL and keeps hero', async () => {
    let request;
    const c = client({
      get: async (url, options) => {
        request = { url, options };
        return {
          data: {
            results: [{
              listing_id: 424242,
              images: [
                { listing_image_id: 10, rank: 1, url_570xN: 'https://cdn.example/hero.jpg' },
                { listing_image_id: 11, rank: 2, url_570xN: 'https://cdn.example/case1.jpg' },
              ],
            }],
          },
        };
      },
    });
    const catalog = await getListingImageCatalogBatch(c, [424242]);
    assert.equal(request.url, '/application/listings/batch');
    assert.equal(request.options.params.get('listing_ids'), '424242');
    assert.equal(request.options.params.get('includes'), 'Images');
    const entry = catalog.get(424242);
    assert.equal(entry.heroUrl, 'https://cdn.example/hero.jpg');
    assert.equal(entry.byImageId.get(11), 'https://cdn.example/case1.jpg');
  });

  const { paginateListings, getListingsCountByState, paginateReviewsByShop } = require('../src/etsy/client');

  await test('catalog listing walks omit sort and inventory includes', async () => {
    let request;
    const c = client({
      get: async (url, options) => {
        request = { url, options };
        return { data: { count: 0, results: [] } };
      },
    });
    for await (const _ of paginateListings(c, 99, { state: 'active', includeInventory: false, sort: false })) {
      /* empty */
    }
    assert.equal(request.url, '/application/shops/99/listings');
    assert.equal(request.options.params.state, 'active');
    assert.equal(request.options.params.includes, 'Images');
    assert.equal(request.options.params.sort_on, undefined);
  });

  await test('listing state count probe uses limit 1 and reads count', async () => {
    let request;
    const c = client({
      get: async (url, options) => {
        request = { url, options };
        return { data: { count: 17, results: [{ listing_id: 1 }] } };
      },
    });
    const n = await getListingsCountByState(c, 99, 'expired');
    assert.equal(request.url, '/application/shops/99/listings');
    assert.equal(request.options.params.limit, 1);
    assert.equal(request.options.params.state, 'expired');
    assert.equal(n, 17);
  });

  await test('shop reviews pagination sends documented min_created', async () => {
    let request;
    const c = client({
      get: async (url, options) => {
        request = { url, options };
        return { data: { count: 1, results: [{ transaction_id: 1, rating: 5 }] } };
      },
    });
    const pages = [];
    for await (const batch of paginateReviewsByShop(c, 99, { min_created: 1700000000, maxPages: 1 })) {
      pages.push(batch);
    }
    assert.equal(request.url, '/application/shops/99/reviews');
    assert.equal(request.options.params.min_created, 1700000000);
    assert.equal(pages[0][0].rating, 5);
  });

  await test('reading listing settings never auto-creates a processing profile', async () => {
    let posts = 0;
    const c = client({
      get: async (url) => {
        if (url === '/application/shops/123') {
          return { data: { shop_id: 123, shop_name: 'Test', currency_code: 'HKD' } };
        }
        return { data: { results: [] } };
      },
      post: async () => {
        posts += 1;
        return { data: {} };
      },
    });
    const settings = await fetchShopListingSettings(c, 123, 'iphone_case');
    assert.equal(posts, 0);
    assert.equal(settings.defaults.readiness_state_id, null);
    assert.ok(settings.warnings.some((warning) => /Create one explicitly/.test(warning)));
  });

  await test('safe previews never hide an Etsy settings fetch', async () => {
    let networkCalls = 0;
    const db = {
      prepare: () => ({ get: () => null }),
    };
    const c = client({
      get: async () => {
        networkCalls += 1;
        return { data: {} };
      },
    });
    await assert.rejects(
      () => getShopListingSettings({
        db,
        shopClient: c,
        shopId: 123,
        shopKey: 'shop-a',
        productType: 'iphone_case',
        cacheOnly: true,
      }),
      (err) => err && err.code === 'SHOP_SETTINGS_CACHE_REQUIRED' && err.status === 409,
    );
    assert.equal(networkCalls, 0);
  });

  global.setTimeout = realSetTimeout;
  console.log(`\n${failures.length ? 'FAIL' : 'PASS'} — ${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
})().catch((err) => {
  global.setTimeout = realSetTimeout;
  console.error(err);
  process.exitCode = 1;
});
