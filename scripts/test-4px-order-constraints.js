'use strict';

/**
 * Regression test — 4PX `ds.xms.order.create` field-constraint normalisation.
 *
 * Guards the rules that previously rejected real orders:
 *   1. Consignee name (rule 010101005) must be a SURNAME + GIVEN name, each ≥2
 *      letters, with no repeated words and a combined length of 4–30 chars.
 *      Single-token Etsy names ("Stella") are split in half so both parts exist.
 *   2. Recipient phone is required for many destinations — Etsy never supplies a
 *      buyer phone, so a default contact number is used when empty.
 *   3. Shipper street must be 10–90 chars — a too-short configured street (e.g. a
 *      province name) is completed with real city/state/postcode context.
 *   4. Consignee province is required for some destinations (UK) — Etsy omits it,
 *      so it is filled from real address data (city, then country name).
 *
 * Run: `node scripts/test-4px-order-constraints.js`  (exit 0 = pass, 1 = fail)
 */

const {
  enforceConsigneeName,
  enforceSenderStreet,
  resolveRecipientState,
  generateRecipientPhone,
  DEFAULT_RECIPIENT_PHONE,
} = require('../src/fourpx/orders');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ok  — ${msg}`); }
  else { failures++; console.error(`  FAIL — ${msg}`); }
}

console.log('4PX order field-constraint regression test\n');

// 1. Consignee name — surname + given name, each ≥2 letters, no repeats, 4–30.
//    Reusable invariant checker covering every sub-clause of rule 010101005.
{
  const LETTERS = (s) => (String(s).match(/\p{L}/gu) || []).length;
  function assertValid(label, input) {
    const { first_name: f, last_name: l } = input;
    const combinedLen = `${f}${l}`.replace(/\s+/g, '').length;
    assert(!!f && !!l, `${label}: both surname and given name present (got "${f}"/"${l}")`);
    assert(LETTERS(f) >= 2, `${label}: given name has >=2 letters (got "${f}")`);
    assert(LETTERS(l) >= 2, `${label}: surname has >=2 letters (got "${l}")`);
    assert(f.toLowerCase() !== l.toLowerCase(), `${label}: parts are not a repeated word (got "${f}"/"${l}")`);
    assert(combinedLen >= 4 && combinedLen <= 30, `${label}: combined length 4–30 (got ${combinedLen})`);
  }

  // The reported bug: a single-token name to Canada ("Stella") was shipped with
  // an empty last_name and rejected with 010101005.
  assertValid('"Stella" (single token)', enforceConsigneeName('Stella', ''));

  // Other single-token / short names that previously emitted an empty surname.
  assertValid('"Ava"',  enforceConsigneeName('Ava', ''));
  assertValid('"Li"',   enforceConsigneeName('Li', ''));
  assertValid('"Jo"',   enforceConsigneeName('Jo', ''));
  assertValid('"A"',    enforceConsigneeName('A', ''));

  // Already-valid two-part name is preserved verbatim.
  const ok = enforceConsigneeName('Charlotte', 'Wong');
  assert(ok.first_name === 'Charlotte' && ok.last_name === 'Wong', 'already-valid name is unchanged');
  assertValid('"Charlotte Wong"', ok);

  // Full name dumped into first_name (how the UI prefills it) is split correctly.
  const dumped = enforceConsigneeName('Julie Zaring', '');
  assert(dumped.first_name === 'Julie' && dumped.last_name === 'Zaring', '"Julie Zaring" in first_name -> split given/surname');

  // Repeated words are de-duplicated before splitting (no "Stella Stella").
  assertValid('"Stella Stella"', enforceConsigneeName('Stella', 'Stella'));

  // A lone middle initial gets padded to >=2 letters rather than dropped.
  assertValid('"J Smith"', enforceConsigneeName('J', 'Smith'));

  // Multi-token given name keeps the trailing word as the surname.
  const mj = enforceConsigneeName('Mary Jane', 'Watson');
  assert(mj.last_name === 'Watson' && mj.first_name === 'Mary Jane', '"Mary Jane Watson" -> given "Mary Jane" / surname "Watson"');

  // Non-letter noise (digits, symbols, emoji) is stripped before validation.
  assertValid('"User123 ★"', enforceConsigneeName('User123 ★', ''));
  assertValid('all-symbol name', enforceConsigneeName('★☆##', ''));

  // Over-long names are capped at 30 while staying a valid two-part name.
  assertValid('over-long name', enforceConsigneeName('Maximiliana Alexandrina', 'Featherstonehaughxxxxx'));
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

// 4. Recipient province (consignee's province) — required for UK (010104001).
{
  // Supplied province is always used verbatim, regardless of country.
  assert(resolveRecipientState('US', 'CA', 'Los Angeles') === 'CA', 'supplied US state is kept verbatim');
  assert(resolveRecipientState('GB', 'Greater London', 'London') === 'Greater London', 'supplied UK county is kept verbatim');

  // UK with no province falls back to the city (a real, deliverable value).
  assert(resolveRecipientState('GB', '', 'London') === 'London', 'empty UK province -> city ("London")');
  assert(resolveRecipientState('GB', '   ', 'Manchester') === 'Manchester', 'whitespace UK province -> city ("Manchester")');

  // The colloquial "UK" code is handled identically to "GB".
  assert(resolveRecipientState('uk', '', 'Bristol') === 'Bristol', 'lowercase "uk" code -> city ("Bristol")');

  // UK with neither province nor city falls back to the country name.
  assert(resolveRecipientState('GB', '', '') === 'United Kingdom', 'empty UK province + city -> "United Kingdom"');

  // Non-UK destinations without a province stay empty (field omitted as before),
  // so countries that validate the province enum never get a substituted value.
  assert(resolveRecipientState('US', '', 'Seattle') === '', 'empty US province stays empty (field omitted)');
  assert(resolveRecipientState('DE', '', 'Berlin') === '', 'empty DE province stays empty (field omitted)');
}

// 5. Recipient phone generation — unique per order, destination-localized, stable.
//    Prevents the shared-phone "申报收件人黑名单" blacklist (DS000000).
{
  // Deterministic: same country + seed -> identical number (idempotent retries).
  assert(
    generateRecipientPhone('US', 'ETSY-4080498885') === generateRecipientPhone('US', 'ETSY-4080498885'),
    'same (country, seed) is deterministic'
  );

  // Unique: different orders -> different numbers (no shared contact accrues).
  assert(
    generateRecipientPhone('US', 'ETSY-1') !== generateRecipientPhone('US', 'ETSY-2'),
    'different seeds -> different numbers'
  );

  // No order ever reuses the legacy shared constant.
  assert(
    generateRecipientPhone('US', 'ETSY-4080498885') !== DEFAULT_RECIPIENT_PHONE,
    'generated number is never the legacy shared phone'
  );

  // Destination-localized formats (digits-only, incl. country code).
  const us = generateRecipientPhone('US', 'ETSY-100');
  assert(/^1[2-9]\d{2}[2-9]\d{6}$/.test(us), `US -> valid NANP (got ${us})`);
  const gb = generateRecipientPhone('GB', 'ETSY-100');
  assert(/^447[1-9]\d{8}$/.test(gb), `GB -> valid UK mobile (got ${gb})`);
  const au = generateRecipientPhone('AU', 'ETSY-100');
  assert(/^614\d{8}$/.test(au), `AU -> valid AU mobile (got ${au})`);
  const nz = generateRecipientPhone('NZ', 'ETSY-100');
  assert(/^6421\d{7}$/.test(nz), `NZ -> valid NZ mobile (got ${nz})`);

  // Unknown country -> valid-format CN mobile fallback, still unique per seed.
  const de1 = generateRecipientPhone('DE', 'ETSY-1');
  const de2 = generateRecipientPhone('DE', 'ETSY-2');
  assert(/^861[3-9]\d{9}$/.test(de1), `DE fallback -> valid CN mobile shape (got ${de1})`);
  assert(de1 !== de2, 'fallback numbers are unique per seed');
}

console.log('');
if (failures > 0) {
  console.error(`${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log('All assertions passed.');
