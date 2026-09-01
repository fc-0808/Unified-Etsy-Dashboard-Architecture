'use strict';

/**
 * Marketplace-collected import tax — the one place that answers
 * "what tax identifier and what declared value does this parcel need?".
 *
 * WHY THIS EXISTS
 * ----------------------------------------------------------------------------
 * Etsy is the marketplace facilitator for most of our export destinations: it
 * charges the buyer VAT/GST at checkout and remits it itself. For the parcel to
 * clear customs WITHOUT the buyer being billed a second time, the shipment has
 * to carry Etsy's registration number for that destination plus the order value
 * in the destination currency. Get it wrong and the buyer pays twice, refuses
 * the parcel, and the shop eats a case.
 *
 * The numbers used to live as string literals inside the dashboard's inline
 * <script>, which failed in both directions: they were unreviewable (a typo in
 * a tax number is invisible), and when they were later stripped out the packing
 * bench was left telling the packer to "look it up on the Etsy order page" for
 * every single parcel. Both are the same root cause — no owned source of truth.
 *
 * So: one registry, server-side, with per-scheme provenance, format/checksum
 * validation, and an operator override in config.json. The server serves it to
 * the browser (GET /api/compliance/destination-tax) and uses the SAME entries
 * when it hands tax data to 4PX, so what the label transmits and what the
 * packer writes on the box cannot disagree.
 *
 * THE ONE RULE THAT IS EASY TO GET WRONG
 * ----------------------------------------------------------------------------
 * Whether the identifier may be written on the parcel is NOT uniform:
 *
 *   • EU (IOSS) — Etsy forbids it. "Never write this number on your packages";
 *     it must be transmitted electronically by the carrier. Printing IM… on a
 *     box is a policy breach, not a belt-and-braces extra.
 *   • UK (VAT)  — Etsy instructs the opposite, verbatim on the receipt:
 *     "Please write Etsy's UK VAT number, 370 6004 28, on your package."
 *   • CH / NZ — the identifier belongs on the CN22/CN23 customs form.
 *   • AU — Etsy collects GST at checkout, but on our 4PX lane the carrier
 *     declares it: the packer writes nothing, and nothing forbids the number
 *     either. That is `disclosure: CARRIER`, and the bench shows no notice for
 *     it. The ARN stays here because it is still the number for the
 *     destination — what changed is who writes it down, not what it is.
 *   • NO (VOEC) — same, and Norway additionally requires the carrier to submit
 *     it digitally: labelling alone stopped being sufficient. That hand-off
 *     happens when the shipment is booked, so the notice says so rather than
 *     implying we transmit it (we do not — only the EU IOSS number is sent).
 *
 * That distinction is modelled as `disclosure` so the UI can never render the
 * EU number as something to copy onto a box.
 *
 * SOURCES (re-check when REVIEWED_AT goes stale)
 *   • EU IOSS   Etsy Seller Handbook — "Sail through customs" (IOSS number is
 *               shown per order under Orders & Delivery; never write on parcel)
 *   • UK VAT    Etsy receipt customs instructions / etsy/open-api#697
 *   • NO VOEC   Skatteetaten — "Sending goods under the VOEC scheme"
 *               (7 digits, must be supplied digitally, also on CN22/23)
 *   • CH / AU / NZ  Etsy Help — "Will I have to pay tax, customs or tariffs"
 *
 * Every built-in value that has a national checksum is verified by the
 * validators below, so a wrong digit cannot ship: the UK number satisfies
 * HMRC mod-9755, the Swiss UID satisfies mod-11, the NZ GST number satisfies
 * the IRD mod-11. The AU value is a 12-digit ARN, which carries no checksum.
 */

/** Month the registry was last reconciled against the sources above. */
const REVIEWED_AT = '2026-08';

/** The 27 EU member states — the IOSS customs union, sorted for reviewability. */
const EU27 = Object.freeze([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR',
  'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI',
  'SK',
]);

/**
 * How the identifier reaches customs — and therefore what, if anything, the
 * packer does with it. This is the field the bench renders from, so it decides
 * whether a notice appears at all.
 *
 *   ELECTRONIC — carrier data only, and writing it on the parcel is PROHIBITED.
 *                Worth a notice precisely because it is a "do not".
 *   PACKAGE    — write it on the parcel / customs form. The notice is the task.
 *   BOTH       — carrier data is mandatory and the customs form expects it too.
 *   CARRIER    — the carrier declares it for us: nothing to write, and nothing
 *                prohibited either. There is no packer action, so the bench
 *                stays silent — a panel that asks for nothing is noise on a
 *                screen where every panel is meant to mean "do this".
 */
const DISCLOSURE = Object.freeze({
  ELECTRONIC: 'electronic',
  PACKAGE: 'package',
  BOTH: 'both',
  CARRIER: 'carrier',
});

/**
 * Where the value in use came from. Drives how much the UI hedges.
 *   OPERATOR    — config.json. The operator asserted it; treat as authoritative.
 *   MARKETPLACE — Etsy states this number in the order's own customs instructions.
 *   REFERENCE   — compiled from published guidance rather than from a receipt.
 *                 Correct as far as we can verify, but worth confirming against
 *                 the Etsy order page the first time a destination comes up.
 */
const SOURCE = Object.freeze({
  OPERATOR: 'operator',
  MARKETPLACE: 'marketplace',
  REFERENCE: 'reference',
});

// ── Identifier formats ───────────────────────────────────────────────────────
//
// Each format normalises a human-typed value to a canonical display form and
// rejects anything that cannot be a real registration number. These run over
// config.json at load time, which is the only moment a typo is still cheap: a
// bad UK VAT number that reaches the bench gets copied onto every parcel.

const ok = (value) => ({ ok: true, value, reason: null });
const bad = (reason) => ({ ok: false, value: null, reason });

/** Strip the punctuation humans add to tax numbers, and upper-case the rest. */
function compact(raw) {
  return String(raw == null ? '' : raw).toUpperCase().replace(/[\s.\-/]+/g, '');
}

/** Digits only — for schemes whose canonical form is purely numeric. */
function digitsOnly(raw) {
  return String(raw == null ? '' : raw).replace(/\D+/g, '');
}

/**
 * EU IOSS: "IM" + 10 digits (3-digit member-state code + 7 serial digits).
 * No published check digit, so this is a format gate only.
 */
function validateIoss(raw) {
  const value = compact(raw).replace(/^IOSS/, '');
  if (!/^IM\d{10}$/.test(value)) {
    return bad('an IOSS number is "IM" followed by 10 digits, e.g. IM3720000224');
  }
  return ok(value);
}

/**
 * UK VAT: 9 digits, optionally + a 3-digit branch code, optionally "GB"-prefixed.
 *
 * HMRC publishes two check-digit algorithms and a number is valid under either:
 * the original mod-97, and the "mod-9755" variant introduced when the original
 * range ran out. Etsy's own number validates under mod-9755 only, so accepting
 * just one of them would reject the very value this registry ships.
 */
function validateUkVat(raw) {
  const value = compact(raw).replace(/^GB/, '');
  if (!/^\d{9}(\d{3})?$/.test(value)) {
    return bad('a UK VAT number is 9 digits (optionally plus a 3-digit branch code), e.g. 370 6004 28');
  }
  const d = value.slice(0, 9).split('').map(Number);
  // Weights 8…2 over the first seven digits; the last two digits are the check.
  const weighted = d.slice(0, 7).reduce((sum, n, i) => sum + n * (8 - i), 0);
  const check = d[7] * 10 + d[8];
  const mod97 = (weighted + check) % 97 === 0;
  const mod9755 = (weighted + 55 + check) % 97 === 0;
  if (!mod97 && !mod9755) {
    return bad('the check digits do not match (HMRC mod-97 / mod-9755) — re-read the number');
  }
  const branch = value.length === 12 ? ` ${value.slice(9)}` : '';
  return ok(`${value.slice(0, 3)} ${value.slice(3, 7)} ${value.slice(7, 9)}${branch}`);
}

/** Norway VOEC: 7 digits, first digit 2 or 3 (Skatteetaten allocation rule). */
function validateVoec(raw) {
  const value = digitsOnly(compact(raw).replace(/^VOEC/, ''));
  if (!/^[23]\d{6}$/.test(value)) {
    return bad('a Norwegian VOEC number is 7 digits starting with 2 or 3, e.g. 2021137');
  }
  return ok(value);
}

/** Switzerland UID/VAT: "CHE" + 9 digits, mod-11 check digit. */
function validateCheUid(raw) {
  const value = compact(raw);
  if (!/^CHE\d{9}$/.test(value)) {
    return bad('a Swiss VAT/UID number is "CHE" followed by 9 digits, e.g. CHE-373.086.513');
  }
  const d = value.slice(3).split('').map(Number);
  const weights = [5, 4, 3, 2, 7, 6, 5, 4];
  const sum = weights.reduce((acc, w, i) => acc + w * d[i], 0);
  let expected = 11 - (sum % 11);
  if (expected === 11) expected = 0;
  if (expected === 10 || expected !== d[8]) {
    return bad('the check digit does not match (Swiss UID mod-11) — re-read the number');
  }
  const n = value.slice(3);
  return ok(`CHE-${n.slice(0, 3)}.${n.slice(3, 6)}.${n.slice(6, 9)}`);
}

/**
 * Australia: an 11-digit ABN or a 12-digit ARN (the identifier the ATO issues
 * to non-resident marketplaces, which is what Etsy holds). ABNs carry a mod-89
 * checksum; ARNs do not, so those are format-checked only.
 */
function validateAuTaxId(raw) {
  const value = digitsOnly(raw);
  if (value.length === 12) return ok(value);
  if (value.length !== 11) {
    return bad('an Australian identifier is an 11-digit ABN or a 12-digit ARN, e.g. 300009207152');
  }
  const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  const d = value.split('').map(Number);
  d[0] -= 1;
  const sum = weights.reduce((acc, w, i) => acc + w * d[i], 0);
  if (sum % 89 !== 0) {
    return bad('the ABN checksum does not match (mod-89) — re-read the number');
  }
  return ok(value);
}

/**
 * New Zealand GST (IRD) number: 8–9 digits in the range 10,000,000–150,000,000
 * with an IRD mod-11 check digit. The primary weighting is tried first; a
 * calculated check digit of 10 falls back to the secondary weighting.
 */
function validateNzIrd(raw) {
  const value = digitsOnly(raw);
  if (!/^\d{8,9}$/.test(value)) {
    return bad('a New Zealand GST number is 8 or 9 digits, e.g. 122669181');
  }
  const numeric = Number(value);
  if (numeric < 10000000 || numeric > 150000000) {
    return bad('outside the valid IRD number range (10,000,000–150,000,000)');
  }
  const base = value.slice(0, -1).padStart(8, '0');
  const check = Number(value.slice(-1));
  const checkDigit = (weights) => {
    const sum = weights.reduce((acc, w, i) => acc + w * Number(base[i]), 0);
    const remainder = sum % 11;
    return remainder === 0 ? 0 : 11 - remainder;
  };
  let expected = checkDigit([3, 2, 7, 6, 5, 4, 3, 2]);
  if (expected === 10) expected = checkDigit([7, 4, 3, 2, 5, 2, 7, 6]);
  if (expected === 10 || expected !== check) {
    return bad('the check digit does not match (IRD mod-11) — re-read the number');
  }
  return ok(value);
}

const VALIDATORS = Object.freeze({
  ioss: validateIoss,
  uk_vat: validateUkVat,
  no_voec: validateVoec,
  che_uid: validateCheUid,
  au_tax_id: validateAuTaxId,
  nz_ird: validateNzIrd,
});

// ── The registry ─────────────────────────────────────────────────────────────
//
// `threshold` is the ceiling up to which the MARKETPLACE collects the tax. Above
// it the tax is collected at the border instead, the identifier must NOT be used
// and the buyer WILL be billed on delivery — a different parcel and a different
// instruction to the packer. `basis` names what the ceiling is measured on,
// because it is never the grand total.

const SCHEMES = Object.freeze({
  EU_IOSS: Object.freeze({
    key: 'EU_IOSS',
    region: 'EU',
    short_label: 'IOSS',
    title: 'EU Import — Etsy pays the VAT (IOSS)',
    border_title: 'EU Import — VAT is collected at the border',
    identifier_label: 'Etsy EU IOSS number',
    default_identifier: 'IM3720000224',
    default_source: SOURCE.MARKETPLACE,
    format: 'ioss',
    disclosure: DISCLOSURE.ELECTRONIC,
    customs_currency: 'EUR',
    threshold: Object.freeze({ amount: 150, currency: 'EUR', basis: 'intrinsic value, excluding delivery' }),
    // Etsy is explicit and this is the one scheme where labelling is a breach.
    electronic_note: 'It travels with the 4PX shipment, so customs sees the VAT as prepaid.',
    package_instruction: null,
    reference_url: 'https://www.etsy.com/seller-handbook/article/1014946249688',
  }),

  UK_VAT: Object.freeze({
    key: 'UK_VAT',
    region: 'GB',
    short_label: 'UK VAT',
    title: 'UK Import — Etsy pays the VAT',
    border_title: 'UK Import — VAT is collected at the border',
    identifier_label: 'Etsy UK VAT number',
    default_identifier: '370 6004 28',
    default_source: SOURCE.MARKETPLACE,
    format: 'uk_vat',
    disclosure: DISCLOSURE.PACKAGE,
    customs_currency: 'GBP',
    threshold: Object.freeze({ amount: 135, currency: 'GBP', basis: 'package value, excluding delivery' }),
    electronic_note: null,
    package_instruction: 'Write this number on the parcel. Use it for this purpose only.',
    reference_url: 'https://help.etsy.com/hc/en-us/articles/115015691007',
  }),

  NO_VOEC: Object.freeze({
    key: 'NO_VOEC',
    region: 'NO',
    short_label: 'VOEC',
    title: 'Norway Import — Etsy pays the VAT (VOEC)',
    border_title: 'Norway Import — VAT is collected at the border',
    identifier_label: 'Etsy VOEC number',
    default_identifier: '2021137',
    default_source: SOURCE.REFERENCE,
    format: 'no_voec',
    disclosure: DISCLOSURE.BOTH,
    customs_currency: 'NOK',
    threshold: Object.freeze({ amount: 3000, currency: 'NOK', basis: 'value of any single item' }),
    // Skatteetaten withdrew the "labelling is enough" option, so the digital
    // hand-off is on the operator when booking with 4PX — we do not send it.
    electronic_note: 'Norway also needs this from the carrier digitally — labelling alone no longer clears the parcel.',
    package_instruction: 'Write it on the CN22/CN23, labelled "VOEC no".',
    reference_url: 'https://www.skatteetaten.no/en/business-and-organisation/vat-and-duties/vat/foreign/e-commerce-voec/sending-goods-under-the-voec-scheme/',
  }),

  CH_VAT: Object.freeze({
    key: 'CH_VAT',
    region: 'CH',
    short_label: 'CH VAT',
    title: 'Switzerland Import — Etsy pays the VAT',
    border_title: 'Switzerland Import — VAT is collected at the border',
    identifier_label: 'Etsy Swiss VAT (UID) number',
    default_identifier: 'CHE-373.086.513',
    default_source: SOURCE.REFERENCE,
    format: 'che_uid',
    disclosure: DISCLOSURE.PACKAGE,
    customs_currency: 'CHF',
    // Swiss import VAT has no marketplace ceiling comparable to IOSS/UK.
    threshold: null,
    electronic_note: null,
    package_instruction: 'Write it on the customs form.',
    reference_url: 'https://help.etsy.com/hc/en-us/articles/115015691007',
  }),

  AU_GST: Object.freeze({
    key: 'AU_GST',
    region: 'AU',
    short_label: 'AU GST',
    title: 'Australia Import — Etsy pays the GST',
    border_title: 'Australia Import — GST and duty are collected at the border',
    identifier_label: 'Etsy Australian tax ID (ARN)',
    default_identifier: '300009207152',
    default_source: SOURCE.REFERENCE,
    format: 'au_tax_id',
    // 4PX declares the AU lane from the order data, so there is nothing for the
    // packer to write and no notice to show. Keep the ARN: it is what we would
    // transmit, and it is what a future hand-declared lane would need.
    disclosure: DISCLOSURE.CARRIER,
    customs_currency: 'AUD',
    threshold: Object.freeze({ amount: 1000, currency: 'AUD', basis: 'customs value of the consignment' }),
    electronic_note: '4PX declares it with the shipment — there is nothing to write on the parcel.',
    package_instruction: null,
    reference_url: 'https://help.etsy.com/hc/en-us/articles/115015691007',
  }),

  NZ_GST: Object.freeze({
    key: 'NZ_GST',
    region: 'NZ',
    short_label: 'NZ GST',
    title: 'New Zealand Import — Etsy pays the GST',
    border_title: 'New Zealand Import — GST and duty are collected at the border',
    identifier_label: 'Etsy New Zealand GST number',
    default_identifier: '122669181',
    default_source: SOURCE.REFERENCE,
    format: 'nz_ird',
    disclosure: DISCLOSURE.PACKAGE,
    customs_currency: 'NZD',
    threshold: Object.freeze({ amount: 1000, currency: 'NZD', basis: 'customs value of the consignment' }),
    electronic_note: null,
    package_instruction: 'Note "GST paid" and this number on the customs form.',
    reference_url: 'https://help.etsy.com/hc/en-us/articles/115015691007',
  }),
});

/**
 * Destination ISO-2 → scheme key: which destinations have import tax collected by
 * the marketplace. This is a statement about the world, not about the UI — AU is
 * here because Etsy does collect Australian GST. Whether a packer ever sees a
 * notice for it is `disclosure`'s job.
 */
const COUNTRY_SCHEME = Object.freeze({
  ...Object.fromEntries(EU27.map((iso) => [iso, 'EU_IOSS'])),
  GB: 'UK_VAT',
  NO: 'NO_VOEC',
  CH: 'CH_VAT',
  AU: 'AU_GST',
  NZ: 'NZ_GST',
});

/** Scheme keys an operator may override in config.json. */
const SCHEME_KEYS = Object.freeze(Object.keys(SCHEMES));

/** Destinations covered by IOSS — the set the 4PX order path keys off. */
const EU_IOSS_COUNTRIES = Object.freeze(new Set(EU27));

// ── Resolution ───────────────────────────────────────────────────────────────

/** @returns {string} normalised ISO-2 country code ('' when absent/malformed). */
function normalizeCountry(countryIso) {
  const iso = String(countryIso == null ? '' : countryIso).trim().toUpperCase();
  return /^[A-Z]{2}$/.test(iso) ? iso : '';
}

/**
 * Validate an operator-supplied identifier for a scheme.
 *
 * @param {string} schemeKey
 * @param {unknown} raw
 * @returns {{ ok: boolean, value: string|null, reason: string|null }}
 */
function validateIdentifier(schemeKey, raw) {
  const scheme = SCHEMES[schemeKey];
  if (!scheme) return bad(`unknown tax scheme "${schemeKey}" (expected one of ${SCHEME_KEYS.join(', ')})`);
  if (raw == null || String(raw).trim() === '') return bad('the value is empty');
  return VALIDATORS[scheme.format](raw);
}

/**
 * Normalise the `marketplace_tax_ids` block from config.json.
 *
 * Invalid and unknown entries are DROPPED rather than thrown on: a mistyped tax
 * number must not stop the server from booting and shipping parcels, but it must
 * never be presented as fact either — so the built-in value is used and the
 * problem is reported for the caller to log.
 *
 * @param {Record<string, unknown>|null|undefined} raw
 * @returns {{ identifiers: Record<string, string>, problems: string[] }}
 */
function normalizeTaxIdOverrides(raw) {
  const identifiers = {};
  const problems = [];
  if (raw == null) return { identifiers, problems };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { identifiers, problems: ['marketplace_tax_ids must be an object keyed by scheme (e.g. { "UK_VAT": "370 6004 28" })'] };
  }
  for (const [key, value] of Object.entries(raw)) {
    const schemeKey = String(key).trim().toUpperCase();
    if (value == null || String(value).trim() === '') continue; // an explicit "use the default"
    if (!SCHEMES[schemeKey]) {
      problems.push(`marketplace_tax_ids.${key}: unknown scheme — expected one of ${SCHEME_KEYS.join(', ')}`);
      continue;
    }
    const result = validateIdentifier(schemeKey, value);
    if (!result.ok) {
      problems.push(`marketplace_tax_ids.${schemeKey}: ${result.reason}. Ignoring it and using the built-in value.`);
      continue;
    }
    identifiers[schemeKey] = result.value;
  }
  return { identifiers, problems };
}

/**
 * Build the resolved registry: every scheme with the identifier actually in use
 * and where it came from. This is the payload the browser renders from and the
 * value the 4PX order path transmits, so there is exactly one answer per scheme.
 *
 * @param {{ marketplace_tax_ids?: Record<string, string> }|null|undefined} config
 * @returns {{ reviewed_at: string, schemes: object, countries: object, problems: string[] }}
 */
function buildDestinationTaxRegistry(config) {
  const { identifiers, problems } = normalizeTaxIdOverrides(config?.marketplace_tax_ids);
  const schemes = {};
  for (const key of SCHEME_KEYS) {
    const scheme = SCHEMES[key];
    const override = identifiers[key];
    // The built-in default is validated here too, so a bad edit to this file
    // surfaces as a missing identifier rather than as a wrong one on a parcel.
    const builtIn = validateIdentifier(key, scheme.default_identifier);
    if (!builtIn.ok && !override) {
      problems.push(`built-in ${key} identifier "${scheme.default_identifier}" is invalid: ${builtIn.reason}`);
    }
    const identifier = override || (builtIn.ok ? builtIn.value : null);
    schemes[key] = {
      key,
      short_label: scheme.short_label,
      title: scheme.title,
      border_title: scheme.border_title,
      identifier,
      identifier_label: scheme.identifier_label,
      identifier_source: override ? SOURCE.OPERATOR : scheme.default_source,
      disclosure: scheme.disclosure,
      customs_currency: scheme.customs_currency,
      threshold: scheme.threshold ? { ...scheme.threshold } : null,
      electronic_note: scheme.electronic_note,
      package_instruction: scheme.package_instruction,
      reference_url: scheme.reference_url,
    };
  }
  return { reviewed_at: REVIEWED_AT, schemes, countries: { ...COUNTRY_SCHEME }, problems };
}

/**
 * The resolved scheme for one destination, or null when the destination has no
 * marketplace-collected import tax we know about (the US, Canada, …). Callers
 * treat null as "no notice, nothing to transmit" — never as an error.
 *
 * @param {string} countryIso
 * @param {object|null|undefined} config
 * @returns {object|null}
 */
function resolveDestinationTax(countryIso, config) {
  const iso = normalizeCountry(countryIso);
  const key = COUNTRY_SCHEME[iso];
  if (!key) return null;
  const registry = buildDestinationTaxRegistry(config);
  const scheme = registry.schemes[key];
  return scheme && scheme.identifier ? { country: iso, ...scheme } : null;
}

/**
 * Compare an order's declared value against the scheme ceiling.
 *
 * Above the ceiling the marketplace did NOT collect the tax, so the identifier
 * must not be used and the buyer pays at the border. When the value cannot be
 * converted (no live FX) we say so rather than guessing — a wrong "prepaid"
 * claim is the expensive direction of this decision.
 *
 * @param {object|null} scheme                 entry from buildDestinationTaxRegistry
 * @param {number|null|undefined} valueInSchemeCurrency
 * @returns {'prepaid'|'border'|'unverified'}
 */
function classifyDeclaredValue(scheme, valueInSchemeCurrency) {
  if (!scheme) return 'unverified';
  if (!scheme.threshold) return 'prepaid';
  if (!Number.isFinite(valueInSchemeCurrency) || valueInSchemeCurrency <= 0) return 'unverified';
  return valueInSchemeCurrency > scheme.threshold.amount ? 'border' : 'prepaid';
}

/**
 * The packing-bench declaration for one order: destination currency, converted
 * amount, and which side of the ceiling it sits on.
 *
 * This is what a packer is allowed to see. Shop-currency revenue (HKD subtotal)
 * is stripped from employee order payloads; without this object the bench has
 * nothing to convert from and every international parcel renders with no value.
 *
 * Carrier-declared lanes (Australia) return null — there is no notice to hang
 * a figure on.
 *
 * @param {object|null} scheme
 * @param {number|null|undefined} amountInSchemeCurrency
 * @returns {{ currency: string, amount: number|null, state: string }|null}
 */
function shapeCustomsDeclaration(scheme, amountInSchemeCurrency) {
  if (!scheme || scheme.disclosure === DISCLOSURE.CARRIER) return null;
  const n = typeof amountInSchemeCurrency === 'number' ? amountInSchemeCurrency : Number(amountInSchemeCurrency);
  const amount = Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
  return {
    currency: scheme.customs_currency,
    amount,
    state: classifyDeclaredValue(scheme, amount),
  };
}

/**
 * The IOSS number to transmit to 4PX for an EU-bound shipment.
 *
 * `fourpx_ioss_no` stays authoritative for back-compatibility — an operator who
 * set it did so deliberately — but an install that never set it now gets the
 * registry value instead of a shipment 4PX rejects for a missing IOSS number.
 *
 * @param {object|null|undefined} config
 * @returns {{ value: string|null, source: string|null }}
 */
function resolveShipmentIoss(config) {
  const explicit = config?.fourpx_ioss_no ? String(config.fourpx_ioss_no).trim() : '';
  if (explicit) {
    const result = validateIdentifier('EU_IOSS', explicit);
    // An operator's value is transmitted as written even if it fails our format
    // gate: 4PX is the authority on what it accepts, and refusing to ship on our
    // own opinion of the format would be worse than a warning.
    return { value: result.ok ? result.value : explicit, source: SOURCE.OPERATOR };
  }
  const scheme = buildDestinationTaxRegistry(config).schemes.EU_IOSS;
  return { value: scheme.identifier, source: scheme.identifier ? scheme.identifier_source : null };
}

module.exports = {
  REVIEWED_AT,
  EU27,
  EU_IOSS_COUNTRIES,
  DISCLOSURE,
  SOURCE,
  SCHEMES,
  SCHEME_KEYS,
  COUNTRY_SCHEME,
  normalizeCountry,
  validateIdentifier,
  normalizeTaxIdOverrides,
  buildDestinationTaxRegistry,
  resolveDestinationTax,
  classifyDeclaredValue,
  shapeCustomsDeclaration,
  resolveShipmentIoss,
};
