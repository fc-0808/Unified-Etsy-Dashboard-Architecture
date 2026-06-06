'use strict';

/**
 * Regression test — 4PX `ds.xms.order.create` field-constraint normalisation.
 *
 * Guards the three rules that previously rejected real orders:
 *   1. Consignee name must be 4–30 chars  — short Etsy names ("Ava") are padded
 *      by repeating the final letter ("Avaa"); long names are capped at 30.
 *   2. Recipient phone is required for many destinations — Etsy never supplies a
 *      buyer phone, so a default contact number is used when empty.
 *   3. Shipper street must be 10–90 chars — a too-short configured street (e.g. a
 *      province name) is completed with real city/state/postcode context.
 *
 * Run: `node scripts/test-4px-order-constraints.js`  (exit 0 = pass, 1 = fail)
 */

const {
  enforceConsigneeName,
  enforceSenderStreet,
  DEFAULT_RECIPIENT_PHONE,
} = require('../src/fourpx/orders');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ok  — ${msg}`); }
  else { failures++; console.error(`  FAIL — ${msg}`); }
}

console.log('4PX order field-constraint regression test\n');

// 1. Consignee name 4–30.
{
  const ava = enforceConsigneeName('Ava', '');
  assert(ava.first_name === 'Avaa', `"Ava" -> "Avaa" (got "${ava.first_name}")`);

  const li = enforceConsigneeName('Li', '');
  assert(li.first_name === 'Liii', `"Li" -> "Liii" (got "${li.first_name}")`);

  const jo = enforceConsigneeName('Jo', '');
  assert(jo.first_name.length >= 4 && jo.first_name.startsWith('Jo'), `"Jo" padded to >=4 (got "${jo.first_name}")`);

  const ok = enforceConsigneeName('Charlotte', 'Wong');
  assert(ok.first_name === 'Charlotte' && ok.last_name === 'Wong', 'already-valid name is unchanged');

  // Padding lands on the last name when present.
  const al = enforceConsigneeName('A', 'B');
  assert((al.first_name + al.last_name).replace(/\s/g, '').length >= 4, `"A B" padded to >=4 (got "${al.first_name}"/"${al.last_name}")`);

  const long = enforceConsigneeName('Maximiliana Alexandrina', 'Featherstonehaughxxxxx');
  assert((long.first_name + ' ' + long.last_name).trim().length <= 30, 'over-long name capped at 30');
}

// 2. Default recipient phone.
{
  assert(DEFAULT_RECIPIENT_PHONE === '8613058082917', 'default recipient phone is 8613058082917');
}

// 3. Sender street 10–90.
{
  const fixed = enforceSenderStreet('GUANGDONG', { city: 'Guangzhou', state: 'Guangdong', post_code: '511186', country: 'CN' });
  assert(fixed.length >= 10 && fixed.length <= 90, `short street completed to 10–90 (got ${fixed.length}: "${fixed}")`);
  assert(/GUANGDONG/.test(fixed), 'original street content is preserved');

  const good = 'Xintang Town, Zengcheng District, Guangzhou';
  assert(enforceSenderStreet(good, {}) === good, 'already-valid street is unchanged');

  const tiny = enforceSenderStreet('A', {});
  assert(tiny.length >= 10, `single-char street padded to >=10 (got "${tiny}")`);

  const empty = enforceSenderStreet('', { city: 'Guangzhou' });
  assert(empty.length >= 10, `empty street completed to >=10 (got "${empty}")`);

  const huge = enforceSenderStreet('x'.repeat(200), {});
  assert(huge.length === 90, `over-long street truncated to 90 (got ${huge.length})`);
}

console.log('');
if (failures > 0) {
  console.error(`${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log('All assertions passed.');
