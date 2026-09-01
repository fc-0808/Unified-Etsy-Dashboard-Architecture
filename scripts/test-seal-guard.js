'use strict';

/** Offline parity tests for every path that marks an order physically packaged. */
const assert = require('node:assert/strict');
const {
  initDb,
  syncConfigToDb,
  setRouteVerified,
  upsertOrderExchange,
  upsertRouteAssignment,
} = require('../src/db/setup');
const routeDashboard = require('../src/route/dashboard');
const { unsealableReasons } = require('../src/orders/seal-guard');

const db = initDb(':memory:');

function insertReceipt(receiptId, listingId, title) {
  const transaction = {
    listing_id: listingId,
    title,
    quantity: 1,
    variations: [{ formatted_name: 'Style', formatted_value: 'Case Only' }],
  };
  db.prepare(`
    INSERT INTO receipts
      (receipt_id, shop_id, group_id, status, is_paid, all_transactions)
    VALUES (?, 'test-shop', 'test-group', 'Paid', 1, ?)
  `).run(receiptId, JSON.stringify([transaction]));
  return {
    transaction,
    itemKey: routeDashboard.lineItemKey(title, listingId),
  };
}

try {
  syncConfigToDb(db, {
    groups: [{
      group_id: 'test-group',
      label: 'Test Group',
      proxy: 'direct',
      shops: [{
        shop_id: 'test-shop',
        shop_name: 'Test Shop',
        api_key: 'test-key',
        shared_secret: 'test-secret',
      }],
    }],
  });

  insertReceipt(1, 101, 'Pending case');
  assert.match(
    unsealableReasons(db, [1]).get(1),
    /not yet purchased/
  );

  const buyFix = insertReceipt(2, 102, 'Corrected model to buy');
  upsertRouteAssignment(db, {
    receipt_id: 2,
    item_key: buyFix.itemKey,
    title: buyFix.transaction.title,
    status_case: 'Purchased',
  });
  upsertOrderExchange(db, {
    receipt_id: 2,
    item_key: buyFix.itemKey,
    listing_id: 102,
    title: buyFix.transaction.title,
    have_model: '',
    need_model: 'iPhone 16',
    components: ['case'],
  });
  assert.equal(
    unsealableReasons(db, [2]).has(2),
    false,
    'BUY-shaped correction should be governed by purchase state, not swap hold'
  );
  assert.match(
    unsealableReasons(db, [2], { require_verify_before_pack: true }).get(2),
    /not been physically verified/
  );
  setRouteVerified(db, {
    receipt_id: 2,
    item_key: buyFix.itemKey,
    title: buyFix.transaction.title,
    verified: true,
    by: 'test-packer',
  });
  assert.equal(
    unsealableReasons(db, [2], { require_verify_before_pack: true }).has(2),
    false
  );

  const swap = insertReceipt(3, 103, 'Wrong model in hand');
  upsertRouteAssignment(db, {
    receipt_id: 3,
    item_key: swap.itemKey,
    title: swap.transaction.title,
    status_case: 'Purchased',
  });
  upsertOrderExchange(db, {
    receipt_id: 3,
    item_key: swap.itemKey,
    listing_id: 103,
    title: swap.transaction.title,
    have_model: 'iPhone 14',
    need_model: 'iPhone 16',
    components: ['case'],
  });
  assert.match(
    unsealableReasons(db, [3]).get(3),
    /supplier swap/
  );

  db.prepare(`
    INSERT INTO receipts
      (receipt_id, shop_id, group_id, status, is_paid, all_transactions)
    VALUES (4, 'test-shop', 'test-group', 'Paid', 1, NULL)
  `).run();
  assert.match(
    unsealableReasons(db, [4]).get(4),
    /no complete line-item data/
  );
  assert.match(
    unsealableReasons({ prepare() { throw new Error('db unavailable'); } }, [99]).get(99),
    /could not be verified/
  );

  console.log('PASS — seal guard matches purchase state and BUY/SWAP exchange intent');
} finally {
  db.close();
}
