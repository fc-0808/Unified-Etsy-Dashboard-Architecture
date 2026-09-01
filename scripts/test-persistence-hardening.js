'use strict';

/** Offline regression tests for partial persistence updates. */
const assert = require('node:assert/strict');
const {
  acquireLock,
  initDb,
  recordFourpxShipmentInputs,
  releaseLock,
  syncConfigToDb,
  upsertFourpxShipment,
  upsertReceipt,
} = require('../src/db/setup');

const db = initDb(':memory:');
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
  const bulkColumns = new Set(db.pragma('table_info(bulk_job_items)').map((column) => column.name));
  assert.ok(bulkColumns.has('policy_confirmed_at'));
  assert.ok(bulkColumns.has('policy_confirmed_by'));
  assert.ok(bulkColumns.has('policy_attestation'));
  db.prepare(
    'INSERT INTO receipts (receipt_id, shop_id, group_id, status) VALUES (?, ?, ?, ?)'
  ).run(1, 'test-shop', 'test-group', 'Paid');

  upsertFourpxShipment(db, 1, {
    consignmentNo: 'C-1',
    trackingNo: 'T-1',
    labelUrl: 'https://labels.example.test/C-1.pdf',
    status: 'label_fetched',
  });
  // A status-only update must not erase the previously cached label.
  upsertFourpxShipment(db, 1, { status: 'cancelled' });

  const row = db.prepare(
    'SELECT fourpx_consignment_no, fourpx_tracking_no, fourpx_label_url, fourpx_order_status FROM receipts WHERE receipt_id = 1'
  ).get();
  assert.equal(row.fourpx_consignment_no, 'C-1');
  assert.equal(row.fourpx_tracking_no, 'T-1');
  assert.equal(row.fourpx_label_url, 'https://labels.example.test/C-1.pdf');
  assert.equal(row.fourpx_order_status, 'cancelled');

  db.prepare(`
    UPDATE receipts SET
      fourpx_product_code = 'OLD',
      fourpx_weight_g = 10,
      fourpx_freight_amount = 99,
      fourpx_freight_currency = 'CNY',
      fourpx_freight_status = 'billed',
      tracking_status = 'delivered',
      tracking_is_disposed = 1,
      shipping_claim_note = 'old parcel claim',
      shipping_claim_status = 'open'
    WHERE receipt_id = 1
  `).run();
  upsertFourpxShipment(db, 1, {
    refNo: 'ETSY-1-R1',
    consignmentNo: 'C-2',
    trackingNo: 'T-2',
    status: 'created',
    replaceExisting: true,
  });
  recordFourpxShipmentInputs(db, 1, {
    productCode: 'NEW',
    weightG: 25,
    replaceExisting: true,
  });
  const replacement = db.prepare(`
    SELECT fourpx_ref_no, fourpx_consignment_no, fourpx_tracking_no,
           fourpx_label_url, fourpx_product_code, fourpx_weight_g,
           fourpx_freight_amount, fourpx_freight_status,
           tracking_status, tracking_is_disposed, shipping_claim_note
    FROM receipts WHERE receipt_id = 1
  `).get();
  assert.equal(replacement.fourpx_ref_no, 'ETSY-1-R1');
  assert.equal(replacement.fourpx_consignment_no, 'C-2');
  assert.equal(replacement.fourpx_tracking_no, 'T-2');
  assert.equal(replacement.fourpx_label_url, null);
  assert.equal(replacement.fourpx_product_code, 'NEW');
  assert.equal(replacement.fourpx_weight_g, 25);
  assert.equal(replacement.fourpx_freight_amount, null);
  assert.equal(replacement.fourpx_freight_status, 'pending');
  assert.equal(replacement.tracking_status, null);
  assert.equal(replacement.tracking_is_disposed, 0);
  assert.equal(replacement.shipping_claim_note, null);

  upsertReceipt(db, 'test-shop', 'test-group', {
    receipt_id: 2,
    status: 'completed',
    is_paid: true,
    is_shipped: true,
    grandtotal: { amount: 4995, divisor: 100, currency_code: 'USD' },
    transactions: [],
    shipments: [{ tracking_code: 'T-2', carrier_name: '4px', shipment_notification_timestamp: 100 }],
  });
  upsertReceipt(db, 'test-shop', 'test-group', {
    receipt_id: 2,
    status: 'completed',
    is_paid: false, // stale/sparse follow-up payload
    is_shipped: false, // stale/sparse follow-up payload
    buyer_email: 'buyer@example.test',
    transactions: [],
    shipments: [],
  });
  const monotonic = db.prepare(
    'SELECT is_shipped, is_paid, buyer_email, grandtotal_amount FROM receipts WHERE receipt_id = 2'
  ).get();
  assert.equal(monotonic.is_shipped, 1);
  assert.equal(monotonic.is_paid, 1);
  assert.equal(monotonic.buyer_email, 'buyer@example.test');
  assert.equal(monotonic.grandtotal_amount, 49.95);

  assert.equal(acquireLock(db, 'fourpx_create:1', 'process-a', 600), true);
  assert.equal(acquireLock(db, 'fourpx_create:1', 'process-b', 600), false);
  releaseLock(db, 'fourpx_create:1', 'process-a');
  assert.equal(acquireLock(db, 'fourpx_create:1', 'process-b', 600), true);
  releaseLock(db, 'fourpx_create:1', 'process-b');

  console.log('PASS — persistence is monotonic and cross-process create locks are exclusive');
} finally {
  db.close();
}
