'use strict';

/**
 * Product-type registry for the Bulk Listing Creator.
 *
 * A "product type" is the single source of truth for everything that differs
 * between the physical products this shop sells — the variation axes, the
 * variation vocabulary, the Etsy taxonomy to resolve, the copy vocabulary, and
 * the storefront section keywords. The rest of the pipeline (scanner → AI →
 * variation matrix → Etsy create) is product-type agnostic and simply reads
 * from the descriptor returned here.
 *
 * Every listing has ONE priced "choice" axis — Etsy custom property 514 —
 * whose values carry the price, quantity and variation photo. A product type
 * MAY also declare a fit axis on custom property 513. For an iPhone case those
 * are "Styles" + "Phone Model"; for an Apple Watch band they are the
 * vision-grouped "Band Style" + the fixed "Band Size" catalogue. Etsy requires
 * a buyer to select a value on every axis before adding the item to the cart.
 *
 * Adding a new product type is a matter of appending one descriptor below — no
 * changes to the pipeline are required.
 *
 * `iphone_case` reproduces the historical behaviour exactly and is the default,
 * so any caller that does not specify a product type keeps working unchanged.
 */

// ── Canonical case-bundle vocabulary ─────────────────────────────────────────
// The six accessory bundles a phone/AirPods case can be sold as. `label` is the
// buyer-facing Etsy variation value; `descriptionLabel` is the (slightly richer)
// wording used in the listing's "What's Included" section. `hasGrip`/`hasCharm`
// tell the copy pipeline which accessories a bundle physically contains.
const CANONICAL_STYLES = [
  { key: 'Case+Grip+Charm', label: 'Case + Grip + Charm', descriptionLabel: 'Full Set (Case + Grip + Charm)', hasGrip: true,  hasCharm: true  },
  { key: 'Case+Grip',       label: 'Case + Grip',         descriptionLabel: 'Case + Grip',                    hasGrip: true,  hasCharm: false },
  { key: 'Case+Charm',      label: 'Case + Charm',        descriptionLabel: 'Case + Charm',                   hasGrip: false, hasCharm: true  },
  { key: 'Case Only',       label: 'Case Only',           descriptionLabel: 'Case Only',                      hasGrip: false, hasCharm: false },
  { key: 'Grip Only',       label: 'Grip Only',           descriptionLabel: 'Grip Only',                      hasGrip: true,  hasCharm: false },
  { key: 'Charm Only',      label: 'Charm Only',          descriptionLabel: 'Charm Only',                     hasGrip: false, hasCharm: true  },
];

// Canonical style keys shared with pricing.js / variation-builder.js.
const ALL_STYLE_KEYS = CANONICAL_STYLES.map((s) => s.key);

// Etsy custom variation property IDs (Custom Property 1 / 2). 514 always
// carries price + quantity; 513 is the optional device-model axis.
const PROP_DEVICE = 513;
const PROP_CHOICE = 514;

// Stable family ids used by fulfilment (model-fix, shopping route) so an
// AirPods line can never be "corrected" into an iPhone generation, or vice
// versa. Declared before the descriptors because each one names its family:
// that link is what lets fulfilment go from a live order line back to the
// product line that created it without a second lookup table.
const FAMILY_IPHONE = 'iphone';
const FAMILY_AIRPODS = 'airpods';
const FAMILY_WATCH = 'watch';
const FAMILY_IPAD = 'ipad';

/** The canonical bundle descriptors for a list of style keys, in canonical order. */
function canonicalStyles(keys) {
  const wanted = new Set(keys);
  return CANONICAL_STYLES.filter((s) => wanted.has(s.key)).map((s) => ({ ...s }));
}

// ── Descriptors ──────────────────────────────────────────────────────────────

const IPHONE_CASE = {
  id: 'iphone_case',
  label: 'iPhone Case',
  // The fulfilment family an order line of this type belongs to.
  family: FAMILY_IPHONE,
  // Device family + nouns used to parameterise the AI prompts.
  deviceWord: 'iPhone',
  deviceNoun: 'phone case',
  deviceShort: 'iPhone case',
  deviceLabel: 'iPhone models',
  // How the title states what the product fits, e.g. "… Cover for iPhone 17 16".
  titleFitPhrase: 'Cover for',
  // Section titles that unambiguously belong to THIS product type. Used to stop
  // a run from publishing into another line's storefront section.
  deviceAliases: ['iPhone'],
  // Ordered "Phone Model" variation values (newest first). "iPhone 14/13" is a
  // single combined offering. New drafts emit this full list; live listings
  // receive newly released generations through DEVICE_GENERATION_ADDITIONS.
  models: [
    'iPhone 18 Pro Max', 'iPhone 18 Pro',
    'iPhone 17 Pro Max', 'iPhone 17 Pro', 'iPhone 17',
    'iPhone 16 Pro Max', 'iPhone 16 Pro', 'iPhone 16',
    'iPhone 15 Pro Max', 'iPhone 15 Pro', 'iPhone 15',
    'iPhone 14 Pro Max', 'iPhone 14 Pro', 'iPhone 14/13',
  ],
  // How a variation model expands into buyer-facing compatibility names.
  modelDescriptionNames: { 'iPhone 14/13': ['iPhone 14', 'iPhone 13'] },
  // Etsy custom variation property (Custom Property 1).
  deviceProperty: { id: PROP_DEVICE, name: 'Phone Model' },
  // The priced axis (Custom Property 2) and its vocabulary.
  styleProperty: { id: PROP_CHOICE, name: 'Styles' },
  styles: canonicalStyles(ALL_STYLE_KEYS),
  // 'bundle' means the choice axis lists what the buyer physically receives, so
  // the description's "What's Included" section IS the offering list.
  styleAxis: 'bundle',
  // Which offerings to enable by default: 'accessory' derives them from the
  // grip/charm the photos show; 'all' offers every value (nothing to detect).
  styleSelection: 'accessory',
  // Taxonomy resolution candidates (tried in order by findTaxonomyId).
  taxonomyKeywords: [['phone case'], ['cell phone case'], ['phone', 'case']],
  // Which shop section to auto-select as the default for this product type.
  sectionKeywords: /iphone|phone|case/i,
  // Business pricing rule: "Grip Only" always carries the same default price as
  // "Case Only" — the grip attaches for free, so the two bundles are priced
  // identically regardless of currency. Declared here as a link (dependent →
  // anchor) rather than a hardcoded per-currency figure, so it tracks whatever
  // "Case Only" resolves to (shop price or master-sheet price) forever, and
  // survives future re-pricing of the anchor without a second edit.
  priceLinks: { 'Grip Only': 'Case Only' },
  materials: ['Silicone'],
  supportsGrip: true,
  supportsCharm: true,
  supportsMagsafe: true,
  // Extra "these models are NOT available" note appended to the description.
  unavailableNote: ['all Plus, Mini, Air and "e" models', 'iPhone 13 Pro / Pro Max'],
  // Universal SEO tags the AI must always include for this device.
  universalTags: ['kawaii phone case', 'cute iphone case', 'y2k phone case'],
  deviceTagExamples: ['iphone 18 pro max', 'iphone 17 case'],
  seoFallbackTags: ['iphone accessories', 'iphone cover', 'silicone phone case', 'protective case'],
};

const AIRPODS_CASE = {
  id: 'airpods_case',
  label: 'AirPods Case',
  family: FAMILY_AIRPODS,
  deviceWord: 'AirPods',
  deviceNoun: 'AirPods case',
  deviceShort: 'AirPods case',
  deviceLabel: 'AirPods models',
  titleFitPhrase: 'Cover for',
  deviceAliases: ['AirPods', 'AirPod'],
  // Ordered "AirPods Model" variation values (newest first). "AirPods Pro" is
  // the 1st-generation Pro (no numeric suffix).
  models: [
    'AirPods Pro 3', 'AirPods Pro 2', 'AirPods Pro',
    'AirPods 5', 'AirPods 4', 'AirPods 3', 'AirPods 2', 'AirPods 1',
  ],
  modelDescriptionNames: {}, // AirPods model names are already buyer-facing.
  deviceProperty: { id: PROP_DEVICE, name: 'AirPods Model' },
  styleProperty: { id: PROP_CHOICE, name: 'Styles' },
  // Only the case and an optional dangling charm/keychain clip apply.
  styles: canonicalStyles(['Case+Charm', 'Case Only', 'Charm Only']),
  styleAxis: 'bundle',
  styleSelection: 'accessory',
  // Etsy taxonomy for AirPods/earbud cases. Several candidates so we resolve
  // whichever node this seller taxonomy exposes; the operator can override.
  taxonomyKeywords: [
    ['earbud', 'case'], ['headphone', 'case'], ['earphone', 'case'],
    ['airpod'], ['earbud'], ['headphone'],
  ],
  sectionKeywords: /airpod|earbud|earphone|headphone/i,
  materials: ['Silicone'],
  // AirPods cases don't take a phone grip, and MagSafe is not a selling point.
  supportsGrip: false,
  supportsCharm: true,
  supportsMagsafe: false,
  unavailableNote: ['AirPods Max', 'any non-listed generation'],
  universalTags: ['airpods case', 'cute airpods case', 'kawaii airpods case'],
  deviceTagExamples: ['airpods 5 case', 'airpods pro 2 case'],
  seoFallbackTags: ['earbud case', 'airpods accessory', 'wireless earbud case', 'airpods cover', 'earbud accessories'],
};

// Apple Watch bands have two buyer choices:
//   513 "Band Size"  — the three fixed compatibility groups below. They are
//                      always emitted and intentionally not operator-editable.
//   514 "Band Style" — distinct physical bands grouped from this listing's
//                      photos and named Band 1, Band 2, ... deterministically.
//
// Keeping size on the fit axis makes it behave exactly like "Phone Model" on an
// iPhone case: Etsy requires the buyer to pick it, while the bulk editor can
// safely keep the invariant in the background instead of showing three repeated
// controls on every listing.
//
// `compatibilityName` is the buyer-facing "does it fit my watch?" wording used in
// the description; `descriptionLabel` names the size itself.
const APPLE_WATCH_BAND_SIZES = [
  {
    key: '38/40/41mm', label: '38/40/41mm',
    descriptionLabel: 'Band size 38mm / 40mm / 41mm',
    compatibilityName: 'Apple Watch 38mm, 40mm & 41mm',
    hasGrip: false, hasCharm: false,
  },
  {
    key: '42mm [Series 10/11]', label: '42mm [Series 10/11]',
    descriptionLabel: 'Band size 42mm (Series 10 & 11)',
    compatibilityName: 'Apple Watch 42mm (Series 10 & 11)',
    hasGrip: false, hasCharm: false,
  },
  {
    key: '42/44/45/46/49mm', label: '42/44/45/46/49mm',
    descriptionLabel: 'Band size 42mm / 44mm / 45mm / 46mm / 49mm',
    compatibilityName: 'Apple Watch 42mm, 44mm, 45mm, 46mm & 49mm',
    hasGrip: false, hasCharm: false,
  },
];

// A deliberately conservative fallback for when vision cannot distinguish a
// physical option with sufficient confidence. Normally it is replaced by
// deterministic Band 1 / Band 2 values. Retaining a fallback means an AI outage
// never invents variants or leaves the listing with empty inventory.
const APPLE_WATCH_STYLE_FALLBACK = [
  {
    key: 'As Shown',
    label: 'As Shown',
    priceLabel: 'All detected bands',
    descriptionLabel: 'Band shown in the selected photo',
    hasGrip: false,
    hasCharm: false,
  },
];

const APPLE_WATCH_BAND = {
  id: 'apple_watch_band',
  label: 'Apple Watch Band',
  family: FAMILY_WATCH,
  deviceWord: 'Apple Watch',
  deviceNoun: 'Apple Watch band',
  deviceShort: 'Apple Watch band',
  deviceLabel: 'Apple Watch sizes',
  titleFitPhrase: 'Strap for',
  // Etsy's strongest, buyer-readable item phrase. Unlike "Band … Strap for
  // Apple Watch", this names the item exactly once and matches the core query.
  titleListingPhrase: 'Apple Watch Band',
  deviceAliases: ['Apple Watch', 'Watch Band', 'Watch Strap', 'Smart Watch', 'Smartwatch'],
  // Fixed fit catalogue. `fixedDeviceAxis` is a server-enforced invariant:
  // incoming saved/UI maps can never switch one of these sizes off.
  models: APPLE_WATCH_BAND_SIZES.map((s) => s.key),
  modelDescriptionNames: Object.fromEntries(
    APPLE_WATCH_BAND_SIZES.map((s) => [s.key, [s.compatibilityName]])
  ),
  deviceProperty: { id: PROP_DEVICE, name: 'Band Size' },
  fixedDeviceAxis: true,
  styleProperty: { id: PROP_CHOICE, name: 'Band Style' },
  // Read-only compatibility for drafts produced by the immediately preceding
  // implementation. New inventory always writes Band Style.
  legacyStylePropertyNames: ['Band Color'],
  styles: APPLE_WATCH_STYLE_FALLBACK.map((s) => ({ ...s })),
  // A visual-variant axis is neither a bundle nor a fit. Every value is one
  // complete band design, whether single-colour, multicolour or patterned.
  styleAxis: 'variant',
  choiceNoun: 'band styles',
  singleUnit: true,
  // Ask the focused vision classifier to replace "As Shown" with per-listing
  // physical-band groups. The string is a strategy id, not display copy.
  visionStyle: 'band_variant',
  replaceFallbackWithVisionStyles: true,
  // Nouns the copy must never use for this product. A band is routinely
  // mis-described as a case because every other line in the shop is one.
  confusableNouns: ['phone case', 'AirPods case', 'cover', 'shell'],
  includedItems: ['1 x Apple Watch band in the size you select', '1 x matching buckle / clasp hardware'],
  // The fallback is offered only if vision cannot safely materialise concrete
  // band groups. Fixed sizes are controlled independently above.
  styleSelection: 'all',
  // Etsy exposes watch bands under more than one branch depending on the seller
  // taxonomy version; try the most specific node first.
  taxonomyKeywords: [
    ['smart watch band'], ['watch band'], ['watch bands'],
    ['watch strap'], ['watch', 'band'], ['watch'],
  ],
  sectionKeywords: /watch|band|strap/i,
  materials: ['Silicone'],
  supportsGrip: false,
  supportsCharm: false,
  supportsMagsafe: false,
  unavailableNote: [],
  // Fixed per-currency retail price for every numbered band. The 4-currency master
  // workbook only covers the case bundles, so this line carries its own price
  // book; a currency that is absent here is left blank for the operator to fill
  // in the Variation Prices card rather than being silently guessed.
  defaultPrices: { HKD: 350.11, CAD: 63.15 },
  universalTags: ['apple watch band', 'watch band', 'kawaii watch band'],
  deviceTagExamples: ['apple watch strap', 'watch band 41mm'],
  seoFallbackTags: ['smart watch band', 'watch bracelet', 'apple watch jewelry', 'watch accessories', 'replacement band'],
};

// ── iPad cases ───────────────────────────────────────────────────────────────
// The second SINGLE-AXIS line, and the first whose one axis is priced in TIERS:
// a 13" shell costs more to buy than an 11" one, so the buyer's model choice is
// also the price carrier. Everything about the line is declared in the one table
// below — the dropdown option, the real iPads it fits, and which tier it is
// priced in — because those three facts going out of sync is how a shop ends up
// selling a 13" case at the 11" price.
//
// `option` is the buyer-facing Etsy variation value (what the "iPad Model"
// dropdown shows). `fits` is the exhaustive list of real iPad models that option
// covers, which becomes the description's compatibility bullets: a shopper
// searches for the iPad they own ("iPad Pro 12.9-inch (2021)"), not for the
// grouping we buy it under.
const IPAD_PRICE_TIERS = {
  // 10.2" – 11" shells.
  standard: { HKD: 328.89, CAD: 58.12 },
  // 12.9" – 13" shells.
  large: { HKD: 349.50, CAD: 61.76 },
};

const IPAD_CASE_OPTIONS = [
  { option: '2019/2020/2021 10.2"',              tier: 'standard', fits: ['iPad 10.2/10.5 2019 Universal'] },
  { option: 'iPad 7/8/9 10.2"',                  tier: 'standard', fits: ['iPad 10.2-inch (iPad 8th Gen)', 'iPad 10.2-inch 2021 (iPad 9th Gen)'] },
  { option: '10th Gen 10.9" / 11th Gen 2025 11"', tier: 'standard', fits: ['iPad 10th Gen 10.9" 2022 / iPad 11 (A16) 2025 Universal'] },
  { option: 'Air 6 2024 11" / Air 7 2025 11"',   tier: 'standard', fits: ['iPad 10.9/11" / Air (M2) / Air 11 (M3) 2025 11" Universal'] },
  { option: 'Air 4/5 10.9"',                     tier: 'standard', fits: ['iPad Air 10.9-inch (Air 4th Gen)', 'iPad Air 10.9-inch (2022) (Air 5th Gen)'] },
  { option: 'Pro 2020/2021 11"',                 tier: 'standard', fits: ['iPad Pro 11-inch (2020)', 'iPad Pro 11-inch (2021)'] },
  { option: 'Pro 2022 11"',                      tier: 'standard', fits: ['iPad Pro 11-inch (2022)'] },
  { option: 'Air 6 2024 11"',                    tier: 'standard', fits: ['iPad Air (M2) 11-inch 2024 (iPad Air 6 11")'] },
  { option: 'Air 7 2025 11"',                    tier: 'standard', fits: ['iPad Air 7 11-inch 2025'] },
  { option: '11" Air Category',                  tier: 'standard', fits: ['iPad Air 8 (M4) 11-inch 2026'] },
  { option: 'Pro 2025 11"',                      tier: 'standard', fits: ['iPad Pro (M5) 11-inch 2025'] },
  { option: 'Pro 2024 11"',                      tier: 'standard', fits: ['iPad Pro (M4) 11-inch 2024'] },
  { option: 'Pro 2024 13" / Air 6 2024 13"',     tier: 'large',    fits: ['iPad Pro 12.9 / Air (M2) / Air (M3) 2025 13" Universal'] },
  { option: 'Pro 2020/2021 12.9"',               tier: 'large',    fits: ['iPad Pro 12.9-inch (2020)', 'iPad Pro 12.9-inch 2018 (Without Home Button)', 'iPad Pro 12.9-inch (2021)'] },
  { option: 'Pro 2022 12.9"',                    tier: 'large',    fits: ['iPad Pro 12.9-inch 2022'] },
  { option: 'Air 6 2024 13"',                    tier: 'large',    fits: ['iPad Air (M2) 13-inch 2024 (iPad Air 6 13")'] },
  { option: '13" Air Category',                  tier: 'large',    fits: ['iPad Air 8 (M4) 13-inch 2026'] },
  { option: 'Pro 2025 13"',                      tier: 'large',    fits: ['iPad Pro (M5) 13-inch 2025'] },
  { option: 'Pro 2024 13"',                      tier: 'large',    fits: ['iPad Pro (M4) 13-inch 2024'] },
];

const IPAD_CASE_STYLES = IPAD_CASE_OPTIONS.map((o) => ({
  key: o.option,
  label: o.option,
  descriptionLabel: o.option,
  // Several real iPads share one option, so this axis states MANY compatibility
  // names per value rather than the single one a band size states.
  compatibilityNames: o.fits.slice(),
  hasGrip: false,
  hasCharm: false,
}));

// Fold the tier table into the {currency: {option: price}} shape the price book
// reads, so a tier change is a one-number edit that reprices every option in it.
const IPAD_DEFAULT_PRICES = IPAD_CASE_OPTIONS.reduce((acc, o) => {
  for (const [currency, price] of Object.entries(IPAD_PRICE_TIERS[o.tier])) {
    (acc[currency] || (acc[currency] = {}))[o.option] = price;
  }
  return acc;
}, {});

const IPAD_CASE = {
  id: 'ipad_case',
  label: 'iPad Case',
  family: FAMILY_IPAD,
  deviceWord: 'iPad',
  deviceNoun: 'iPad case',
  deviceShort: 'iPad case',
  deviceLabel: 'iPad models',
  titleFitPhrase: 'Cover for',
  deviceAliases: ['iPad', 'Tablet'],
  // Single-axis: the iPad model IS the only choice the buyer makes, and it is
  // what carries the price. There is no accessory bundle to cross it with.
  models: [],
  modelDescriptionNames: {},
  deviceProperty: null,
  styleProperty: { id: PROP_CHOICE, name: 'iPad Model' },
  styles: IPAD_CASE_STYLES.map((s) => ({ ...s })),
  styleAxis: 'size',
  choiceNoun: 'models',
  // An iPad case IS a case, so unlike a band the only wrong nouns are the other
  // lines' devices — never the word "case" itself.
  confusableNouns: ['phone case', 'iPhone case', 'AirPods case'],
  includedItems: ['1 x iPad case for the iPad model you select'],
  // Every model is always offered: no photo can tell you which iPad sizes a
  // design is produced in — only the supplier's catalogue can.
  styleSelection: 'all',
  taxonomyKeywords: [
    ['ipad case'], ['tablet case'], ['ipad'],
    ['tablet', 'case'], ['tablet'],
  ],
  sectionKeywords: /ipad|tablet/i,
  materials: ['Plastic', 'Silicone'],
  supportsGrip: false,
  supportsCharm: false,
  supportsMagsafe: false,
  // Models outside the offered list entirely — the two families of iPad a
  // shopper is most likely to try to buy for and be disappointed.
  unavailableNote: ['iPad mini (all generations)', 'iPad 9.7-inch and earlier'],
  // The master workbook prices case BUNDLES, which this line does not have, so
  // it carries its own two-tier book. A currency the book omits is left blank
  // for the operator rather than guessed.
  defaultPrices: IPAD_DEFAULT_PRICES,
  universalTags: ['ipad case', 'cute ipad case', 'kawaii ipad case'],
  deviceTagExamples: ['ipad pro 11 case', 'ipad air 5 case'],
  seoFallbackTags: ['tablet case', 'ipad cover', 'tablet accessories', 'protective ipad case'],
};

const PRODUCT_TYPES = {
  [IPHONE_CASE.id]: IPHONE_CASE,
  [AIRPODS_CASE.id]: AIRPODS_CASE,
  [APPLE_WATCH_BAND.id]: APPLE_WATCH_BAND,
  [IPAD_CASE.id]: IPAD_CASE,
};

const DEFAULT_PRODUCT_TYPE = IPHONE_CASE.id;

/**
 * Newly released generations to ADD onto existing live listings.
 *
 * New drafts already pick up the full `models` list on each descriptor. Live
 * listings are never rebuilt from that list — an operator may have turned a
 * generation off on purpose. The catalog-rollout job injects only this set:
 * additive, never a backfill of older models, never a cross-family write.
 *
 * Every value here MUST also appear in that product type's `models` array.
 */
const DEVICE_GENERATION_ADDITIONS = Object.freeze({
  [IPHONE_CASE.id]: Object.freeze(['iPhone 18 Pro Max', 'iPhone 18 Pro']),
  [AIRPODS_CASE.id]: Object.freeze(['AirPods 5']),
});

/**
 * Models a NEW bulk-listing draft offers before the operator touches the picker.
 *
 * `models` is the catalog (everything that can be turned on). This list is the
 * commercial default for a fresh upload. iPhone 18 currently ships as Pro and
 * Pro Max only, so those two values are the whole 18 family and they start
 * selected. The 15–17 families stay selected — that is the set a new upload
 * already offered. The 14 family stays in the catalog but starts off; an
 * operator can still tick it.
 *
 * A type omitted here defaults to every catalog model. An explicit operator
 * map always wins over this list, including one that turns 18 Pro off.
 */
const UPLOAD_DEFAULT_ON = Object.freeze({
  [IPHONE_CASE.id]: Object.freeze([
    'iPhone 18 Pro Max', 'iPhone 18 Pro',
    'iPhone 17 Pro Max', 'iPhone 17 Pro', 'iPhone 17',
    'iPhone 16 Pro Max', 'iPhone 16 Pro', 'iPhone 16',
    'iPhone 15 Pro Max', 'iPhone 15 Pro', 'iPhone 15',
  ]),
});

// The product line each fulfilment family is sold as. Built from the registry so
// a new line is reachable from an order line the moment it declares its family.
const TYPE_BY_FAMILY = new Map(
  Object.values(PRODUCT_TYPES).filter((p) => p.family).map((p) => [p.family, p])
);

// A device-model value that names an Apple Watch case size ("42mm", "38/40/41mm").
// iPhone and AirPods generations never carry a millimetre measurement, so this
// cannot misfire on them.
const WATCH_MODEL_RE = /apple\s*watch|\b\d{2}(?:\s*\/\s*\d{2})*\s*mm\b/i;
const WATCH_TITLE_RE = /apple\s*watch|watch\s*band|watch\s*strap/i;

// A device-model value that names an iPad. Every iPad option states a screen
// size in INCHES ('Pro 2022 11"', 'Air 4/5 10.9"'), which no iPhone generation,
// AirPods generation or millimetre band size ever does — so the inch mark is a
// safe discriminator even on the options that omit the word "iPad".
const IPAD_MODEL_RE = /\bipad\b|\b\d{1,2}(?:\.\d)?\s*(?:"|″|”|-?\s?inch\b)/i;
const IPAD_TITLE_RE = /\bipad\b|\btablet\b/i;

// ── Accessors ────────────────────────────────────────────────────────────────

/** Resolve a product-type descriptor from an id (or a descriptor). Defaults to iPhone. */
function getProductType(idOrPt) {
  if (idOrPt && typeof idOrPt === 'object' && idOrPt.id) return idOrPt;
  return PRODUCT_TYPES[idOrPt] || PRODUCT_TYPES[DEFAULT_PRODUCT_TYPE];
}

/** True when `id` names a product type this build knows about. */
function isKnownProductType(id) {
  return Object.prototype.hasOwnProperty.call(PRODUCT_TYPES, String(id || ''));
}

/** Public list for UI dropdowns. */
function listProductTypes() {
  return Object.values(PRODUCT_TYPES).map((p) => ({
    id: p.id,
    label: p.label,
    deviceWord: p.deviceWord,
    deviceLabel: p.deviceLabel,
    models: p.models.slice(),
    supportsGrip: !!p.supportsGrip,
    hasDeviceAxis: hasDeviceAxis(p),
    fixedDeviceAxis: isDeviceAxisFixed(p),
    styleProperty: stylePropertyFor(p).name,
    styles: stylesFor(p).map(({ key, label, priceLabel }) => ({ key, label, priceLabel })),
  }));
}

// ── Variation-axis helpers ───────────────────────────────────────────────────

/** The priced variation axis ({ id, name }) for a product type. */
function stylePropertyFor(idOrPt) {
  const pt = getProductType(idOrPt);
  return pt.styleProperty || { id: PROP_CHOICE, name: 'Styles' };
}

/** True when this product type also varies by device model (Etsy property 513). */
function hasDeviceAxis(idOrPt) {
  const pt = getProductType(idOrPt);
  return Boolean(pt.deviceProperty && pt.models && pt.models.length);
}

/** True when every declared device/fit value must always be offered. */
function isDeviceAxisFixed(idOrPt) {
  const pt = getProductType(idOrPt);
  return hasDeviceAxis(pt) && pt.fixedDeviceAxis === true;
}

/** The priced axis's ordered value descriptors ({ key, label, … }). */
function stylesFor(idOrPt) {
  const pt = getProductType(idOrPt);
  return (pt.styles && pt.styles.length ? pt.styles : CANONICAL_STYLES).map((s) => ({ ...s }));
}

/** The priced axis's ordered value KEYS. */
function styleKeysFor(idOrPt) {
  return stylesFor(idOrPt).map((s) => s.key);
}

/** The buyer-facing Etsy value for a style key (falls back to the key itself). */
function styleLabelFor(idOrPt, key) {
  const found = stylesFor(idOrPt).find((s) => s.key === key);
  return found ? found.label : String(key);
}

/**
 * Coerce an arbitrary {styleKey: truthy} map into a clean boolean map over the
 * product type's OWN style keys.
 *
 * This is a FAITHFUL, side-effect-free normaliser: it reflects the operator's
 * exact selection and never re-enables a value on its own. The "a listing must
 * offer at least one value" invariant lives with the layers that also know
 * about custom variation values (buildInventory + the bulk editor), because a
 * custom-only listing is legitimate and forcing a canonical value back on here
 * would resurrect an option the operator deliberately removed.
 */
function normaliseEnabledStyles(idOrPt, input = {}) {
  const out = {};
  for (const key of styleKeysFor(idOrPt)) out[key] = Boolean(input && input[key]);
  return out;
}

/**
 * Which values to offer by default.
 *   'accessory' — a case: derived from what the photos actually show. "Case
 *                 Only" is always offered; grip/charm bundles only when the
 *                 corresponding accessory was detected.
 *   'all'       — every declared value (e.g. a fixed fit option or safe fallback).
 */
function defaultEnabledStyles(idOrPt, { hasGrip = false, hasCharm = false } = {}) {
  const pt = getProductType(idOrPt);
  const out = {};
  const all = pt.styleSelection === 'all';
  for (const s of stylesFor(pt)) {
    if (all) { out[s.key] = true; continue; }
    if (s.key === 'Case Only') { out[s.key] = true; continue; } // always offered
    const wantsGrip = Boolean(s.hasGrip);
    const wantsCharm = Boolean(s.hasCharm);
    out[s.key] = (!wantsGrip || Boolean(hasGrip)) && (!wantsCharm || Boolean(hasCharm)) && (wantsGrip || wantsCharm);
  }
  return out;
}

/**
 * The value to fall back to when an operator (or a bad payload) would otherwise
 * leave a listing with zero offerings. Prefers "Case Only" where it exists —
 * the historical behaviour — else the type's first value.
 */
function fallbackStyleKey(idOrPt) {
  const keys = styleKeysFor(idOrPt);
  return keys.includes('Case Only') ? 'Case Only' : keys[0];
}

/**
 * The type's built-in per-style price book for a currency, or null when the
 * type prices from the 4-currency master workbook instead.
 *
 * A descriptor may give either one number (the same price for every value) or
 * an explicit {styleKey: price} map per currency.
 *
 * @param {string|object} idOrPt
 * @param {string} currencyCode  Etsy shop currency_code (USD/CAD/HKD/CNY…)
 * @returns {Record<string, number>|null}
 */
function defaultStylePricesFor(idOrPt, currencyCode) {
  const pt = getProductType(idOrPt);
  if (!pt.defaultPrices) return null;
  const entry = pt.defaultPrices[String(currencyCode || '').toUpperCase()];
  if (entry == null) return {};
  const out = {};
  for (const key of styleKeysFor(pt)) {
    const raw = typeof entry === 'object' ? entry[key] : entry;
    const price = Number(raw);
    if (Number.isFinite(price) && price > 0) out[key] = Math.round(price * 100) / 100;
  }
  return out;
}

/**
 * The product-type contract the UI renders against: what the variation axes are
 * called, which values each offers, and which accessory copy applies. One
 * function so the Bulk Listings setup card, the Inspector and the shop-settings
 * payload can never describe the same product type differently.
 */
function productMeta(idOrPt) {
  const pt = getProductType(idOrPt);
  const styleProp = stylePropertyFor(pt);
  return {
    product_type: pt.id,
    label: pt.label,
    device_label: pt.deviceLabel,
    has_device_axis: hasDeviceAxis(pt),
    fixed_device_axis: isDeviceAxisFixed(pt),
    device_property_name: pt.deviceProperty ? pt.deviceProperty.name : null,
    models: pt.models.slice(),
    style_property_name: styleProp.name,
    style_axis: styleAxisOf(pt),
    vision_style: pt.visionStyle || null,
    replace_fallback_with_vision_styles: pt.replaceFallbackWithVisionStyles === true,
    fallback_style_key: fallbackStyleKey(pt),
    styles: stylesFor(pt).map(({ key, label, priceLabel }) => ({
      key,
      label,
      price_label: priceLabel || label,
    })),
    // Retained for older clients that only read the key list.
    style_keys: styleKeysFor(pt),
    supports_grip: Boolean(pt.supportsGrip),
    supports_charm: pt.supportsCharm !== false,
    supports_magsafe: Boolean(pt.supportsMagsafe),
    price_book_currencies: priceBookCurrencies(pt),
    // What a fresh bulk upload ticks before the operator edits the picker.
    // The inspector uses this when a preview has no saved model map yet, so
    // the checkboxes, the title and the variation matrix cannot disagree.
    default_enabled_models: defaultEnabledModels(pt),
  };
}

/**
 * What the priced choice axis means to the buyer:
 *   'bundle' — values name what is in the box (a case's accessory bundles).
 *   'size'   — values name the only fit dimension (an iPad model).
 *   'variant'— values name a visual variant; fit lives on property 513.
 */
function styleAxisOf(idOrPt) {
  const axis = getProductType(idOrPt).styleAxis;
  return axis === 'size' || axis === 'variant' ? axis : 'bundle';
}

/**
 * The fixed "What's Included" contents for a non-bundle type (every buyer
 * receives the same physical item). Empty for bundle types, whose contents are
 * the offered bundles themselves.
 */
function includedItemsFor(idOrPt) {
  return (getProductType(idOrPt).includedItems || []).slice();
}

/**
 * What the copy should call the priced-axis values in prose. Their meaning is
 * line-specific — a watch band has numbered styles, an iPad case has models — and they
 * must never be presented as several physical items in the box.
 */
function choiceNounFor(idOrPt) {
  return getProductType(idOrPt).choiceNoun || 'options';
}

/**
 * Nouns the copy must never use for this product, because a neighbouring line in
 * the same shop legitimately owns them. Empty when nothing is confusable.
 */
function confusableNounsFor(idOrPt) {
  return (getProductType(idOrPt).confusableNouns || []).slice();
}

/** True when the type prices from its own descriptor rather than the workbook. */
function hasOwnPriceBook(idOrPt) {
  return Boolean(getProductType(idOrPt).defaultPrices);
}

/** The currencies the type's own price book covers (empty when it has none). */
function priceBookCurrencies(idOrPt) {
  const pt = getProductType(idOrPt);
  return pt.defaultPrices ? Object.keys(pt.defaultPrices) : [];
}

/**
 * Declared default-price links for a type: `{ dependentKey: anchorKey }`.
 *
 * A dependent style's default price must always equal its anchor's resolved
 * price (e.g. an iPhone case's "Grip Only" always matches "Case Only"), no
 * matter which source — the shop's own live listings or the master sheet —
 * priced the anchor. This is a pricing POLICY, distinct from `defaultPrices`
 * (a type's own curated price book): a link is resolved AFTER shop/sheet
 * precedence has already picked the anchor's value, so it never goes stale
 * when that value changes. Empty for a type with no linked styles.
 *
 * @param {string|object} idOrPt
 * @returns {Record<string,string>}
 */
function priceLinksFor(idOrPt) {
  return { ...(getProductType(idOrPt).priceLinks || {}) };
}

// ── Device-family classification (fulfilment) ────────────────────────────────

/**
 * Which device family a line belongs to, from its model variation
 * (authoritative) or title (fallback for legacy/manual lines with no model).
 *
 * An iPhone case never carries an "AirPods …" model, a millimetre band size or
 * an inch screen size, so a model match cannot misfire across families. Title is
 * only consulted when the model is blank.
 *
 * @param {string} [model]
 * @param {string} [title]
 * @returns {'iphone'|'airpods'|'watch'|'ipad'}
 */
function deviceFamilyOf(model, title) {
  const m = String(model ?? '').trim();
  if (m) {
    if (WATCH_MODEL_RE.test(m)) return FAMILY_WATCH;
    if (IPAD_MODEL_RE.test(m)) return FAMILY_IPAD;
    return /air\s*pods?/i.test(m) ? FAMILY_AIRPODS : FAMILY_IPHONE;
  }
  const t = String(title ?? '');
  if (/air\s*pods?/i.test(t)) return FAMILY_AIRPODS;
  if (WATCH_TITLE_RE.test(t)) return FAMILY_WATCH;
  if (IPAD_TITLE_RE.test(t)) return FAMILY_IPAD;
  return FAMILY_IPHONE;
}

/**
 * Family implied by a typed model string, or null when it is not recognisably
 * an iPhone, AirPods, Apple Watch or iPad value (a custom stall nickname is
 * allowed and inherits the line).
 *
 * @param {string} [model]
 * @returns {'iphone'|'airpods'|'watch'|'ipad'|null}
 */
function typedModelFamily(model) {
  const m = String(model ?? '').trim();
  if (!m) return null;
  if (WATCH_MODEL_RE.test(m)) return FAMILY_WATCH;
  if (IPAD_MODEL_RE.test(m)) return FAMILY_IPAD;
  if (/air\s*pods?/i.test(m)) return FAMILY_AIRPODS;
  if (/iphone/i.test(m)) return FAMILY_IPHONE;
  return null;
}

const FAMILY_NOUNS = {
  [FAMILY_AIRPODS]: { line: 'an AirPods case', typed: 'AirPods' },
  [FAMILY_WATCH]:   { line: 'an Apple Watch band', typed: 'Apple Watch' },
  [FAMILY_IPAD]:    { line: 'an iPad case', typed: 'iPad' },
  [FAMILY_IPHONE]:  { line: 'an iPhone case', typed: 'iPhone' },
};

/**
 * Error message when a typed model belongs to a different device family, else
 * null. Used by the model-fix endpoint so "AirPods Pro 2 → iPhone 15 Pro Max"
 * (or "42mm → iPhone 17") is refused.
 *
 * @param {'iphone'|'airpods'|'watch'} lineFamily
 * @param {string} typedModel
 * @returns {string|null}
 */
function crossFamilyModelError(lineFamily, typedModel) {
  const typed = typedModelFamily(typedModel);
  if (!typed || !lineFamily || typed === lineFamily) return null;
  const lineNoun = (FAMILY_NOUNS[lineFamily] || FAMILY_NOUNS[FAMILY_IPHONE]).line;
  const typedNoun = (FAMILY_NOUNS[typed] || FAMILY_NOUNS[FAMILY_IPHONE]).typed;
  return `"${String(typedModel).trim()}" is ${/^[aeiou]/i.test(typedNoun) ? 'an' : 'a'} ${typedNoun} value, but this line is ${lineNoun}. Pick a matching option.`;
}

/**
 * Canonical variation values for a family, in the order the line declares them.
 *
 * When a dedicated fit axis exists those are its device generations/sizes. For
 * a single-axis size line (iPad), the priced axis itself supplies the models.
 * Read from the registry rather than enumerated, so a family becomes answerable
 * here the moment its line declares itself.
 *
 * @param {'iphone'|'airpods'|'watch'|'ipad'} family
 * @returns {string[]}
 */
function canonicalModelsForFamily(family) {
  const pt = TYPE_BY_FAMILY.get(family) || IPHONE_CASE;
  return hasDeviceAxis(pt) ? pt.models.slice() : styleKeysFor(pt);
}

/**
 * True when a line in this family has exactly ONE physical unit and no bundle
 * variation to say so — a watch band, an iPad case. Its variations describe
 * fit/appearance rather than components, so fulfilment has to infer the single
 * unit or the item is never shopped at all.
 *
 * @param {'iphone'|'airpods'|'watch'|'ipad'} family
 * @returns {boolean}
 */
function familyIsSingleUnit(family) {
  const pt = TYPE_BY_FAMILY.get(family);
  return Boolean(pt) && (pt.singleUnit === true || styleAxisOf(pt) === 'size');
}

/**
 * The priced-axis property names of every single-axis SIZE line ("iPad Model"),
 * lowercased. Retained for older inventory callers; new code should use
 * pricedAxisPropertyNames(), which also includes Styles and Band Style.
 *
 * @returns {string[]}
 */
function sizeAxisPropertyNames() {
  return Object.values(PRODUCT_TYPES)
    .filter((p) => p.styleAxis === 'size' && p.styleProperty)
    .map((p) => p.styleProperty.name.trim().toLowerCase());
}

/** Every priced-axis property name, lowercased ("Styles", "Band Style", …). */
function pricedAxisPropertyNames() {
  return [...new Set(
    Object.values(PRODUCT_TYPES).flatMap((p) => [
      ...(p.styleProperty ? [p.styleProperty.name] : []),
      ...(p.legacyStylePropertyNames || []),
    ]).map((name) => name.trim().toLowerCase())
  )];
}

// ── Order-line variation roles (fulfilment) ──────────────────────────────────

// A fit is either the dedicated device property (Phone Model / Band Size) or
// the priced property of a single-axis size line (iPad Model).
const FIT_AXIS_PROPERTY_NAMES = new Set(
  Object.values(PRODUCT_TYPES).flatMap((p) => [
    ...(p.deviceProperty ? [p.deviceProperty.name] : []),
    ...(p.styleAxis === 'size' && p.styleProperty ? [p.styleProperty.name] : []),
  ]).map((name) => name.trim().toLowerCase())
);

// A priced non-size axis states the buyer's product choice. This includes the
// ordinary "Styles" bundle and a watch band's "Band Style".
const CHOICE_AXIS_PROPERTY_NAMES = new Set(
  Object.values(PRODUCT_TYPES)
    .filter((p) => p.styleAxis !== 'size')
    .flatMap((p) => [
      ...(p.styleProperty ? [p.styleProperty.name] : []),
      ...(p.legacyStylePropertyNames || []),
    ])
    .map((name) => name.trim().toLowerCase())
);

/** Property names that state WHICH generation/size the buyer chose. */
const FIT_PROP_RE = /model|iphone|phone|airpod|device/i;
/** Property names that state WHAT is in the box (a case's accessory bundle). */
const CHOICE_PROP_RE = /style/i;

/**
 * The role an Etsy variation property plays on an ORDER LINE:
 *
 *   'fit'    — which device generation or band size to buy ("Phone Model",
 *              "AirPods Model", "Band Size").
 *   'choice' — which priced product option was chosen ("Styles", "Band Style").
 *   null     — a property fulfilment has no opinion about (e.g. "Gift wrap").
 *
 * A watch band's "Band Size" is its fit and "Band Style" is its choice. This is
 * the single source of truth shared by the route builder and Orders API, so no
 * surface can read those two dimensions differently.
 *
 * @param {string} [name] - Etsy `formatted_name` / `property_name`
 * @returns {'fit'|'choice'|null}
 */
function variationPropertyRole(name) {
  const n = String(name ?? '').trim().toLowerCase();
  if (!n) return null;
  if (FIT_AXIS_PROPERTY_NAMES.has(n)) return 'fit';
  if (CHOICE_AXIS_PROPERTY_NAMES.has(n)) return 'choice';
  if (CHOICE_PROP_RE.test(n)) return 'choice';
  if (FIT_PROP_RE.test(n)) return 'fit';
  return null;
}

/**
 * What to call a line's PRIMARY physical unit — the thing the `case` component
 * slot tracks. The slot is named for the shop's original product, but on an
 * Apple Watch line the unit is a band, and calling it a "case" in front of an
 * operator is how wrong items get bought.
 *
 * @param {'iphone'|'airpods'|'watch'} family
 * @returns {string}
 */
function primaryComponentLabel(family) {
  return family === FAMILY_WATCH ? 'Band' : 'Case';
}

// ── Device-model helpers (parameterised by product type) ─────────────────────

/**
 * The model selection a fresh bulk upload starts with.
 *
 * Fixed catalogues (Apple Watch sizes) are always fully on. An iPhone upload
 * starts with 18 Pro, 18 Pro Max and the 15–17 families on, and the 14 family
 * off. Every other line starts with its whole catalog on. The returned map is
 * a new object; callers may store it without mutating the registry.
 *
 * This is not what `normaliseEnabledModels` does with an empty input. An empty
 * input there still means "the whole catalog", so title helpers and inventory
 * built without a selection keep describing every model the line can sell.
 * Upload code must call this function when the operator has not chosen.
 *
 * @param {string|object} idOrPt
 * @returns {Record<string, boolean>}
 */
function defaultEnabledModels(idOrPt) {
  const pt = getProductType(idOrPt);
  const order = pt.models;
  if (!order.length) return {};
  if (isDeviceAxisFixed(pt)) {
    return Object.fromEntries(order.map((m) => [m, true]));
  }
  const explicit = UPLOAD_DEFAULT_ON[pt.id];
  if (!explicit) return Object.fromEntries(order.map((m) => [m, true]));
  const on = new Set(explicit);
  return Object.fromEntries(order.map((m) => [m, on.has(m)]));
}

/**
 * Coerce an arbitrary {model: truthy} map into a clean boolean map over the
 * type's known models. If the input enables nothing, every model is enabled — a
 * listing must always offer at least one device model. A type with no device
 * axis always returns an empty map.
 *
 * A missing key on a non-empty map is off. That is how an operator unticks one
 * model without the normaliser silently turning it back on. New uploads that
 * have no map yet must use `defaultEnabledModels` first, which is what turns
 * iPhone 18 Pro and 18 Pro Max on.
 */
function normaliseEnabledModels(idOrPt, input) {
  const pt = getProductType(idOrPt);
  const order = pt.models;
  if (!order.length) return {};
  // A fixed fit catalogue is policy, not operator state. Always reconstruct it
  // from the registry so stale previews or hand-crafted API payloads cannot
  // silently remove a mandatory Apple Watch size.
  if (isDeviceAxisFixed(pt)) {
    return Object.fromEntries(order.map((m) => [m, true]));
  }
  if (!input || typeof input !== 'object' || !Object.keys(input).length) {
    const all = {};
    for (const m of order) all[m] = true;
    return all;
  }
  const out = {};
  let anyOn = false;
  for (const m of order) {
    out[m] = Boolean(input[m]);
    if (out[m]) anyOn = true;
  }
  if (!anyOn) for (const m of order) out[m] = true;
  return out;
}

/** The enabled variation models, in display order (empty for single-axis types). */
function enabledModelList(idOrPt, enabledModels) {
  const pt = getProductType(idOrPt);
  if (!pt.models.length) return [];
  const norm = normaliseEnabledModels(pt, enabledModels);
  return pt.models.filter((m) => norm[m]);
}

/**
 * Buyer-facing description model names for the enabled models (combined models
 * expand). A type with no device axis falls back to its declared
 * `compatibilityNames`, which is the equivalent statement of what the product
 * fits (e.g. the Apple Watch case sizes).
 */
function compatibilityNamesFor(idOrPt, enabledModels, enabledStyles) {
  const pt = getProductType(idOrPt);
  if (!pt.models.length) {
    // Single-axis types state compatibility through the choice axis itself
    // (a band size IS the fit), so only the offered values may be advertised.
    const sized = styleCompatibilityNames(pt, enabledStyles);
    if (sized) return sized;
    return (pt.compatibilityNames || []).slice();
  }
  const out = [];
  for (const m of enabledModelList(pt, enabledModels)) {
    const names = pt.modelDescriptionNames[m] || [m];
    for (const n of names) out.push(n);
  }
  return out;
}

/**
 * The buyer-facing compatibility names one value of a size axis stands for.
 *
 * A band size states one thing it fits; an iPad option stands for SEVERAL real
 * iPads ("Pro 2020/2021 11"" covers the 2020 and the 2021 iPad Pro 11-inch), and
 * a shopper searches for the iPad they own, not for our grouping. So a value may
 * declare a list, and falls back to its single name when it does not.
 */
function styleCompatibilityNamesOf(style) {
  if (Array.isArray(style.compatibilityNames) && style.compatibilityNames.length) {
    return style.compatibilityNames.slice();
  }
  return [style.compatibilityName || style.descriptionLabel || style.label];
}

/**
 * The compatibility names carried by a size-style axis, or null when the type's
 * choice axis is a bundle (a case's "Case + Grip" says nothing about fit).
 * Passing no selection yields every model the type can be sold for.
 */
function styleCompatibilityNames(idOrPt, enabledStyles) {
  const pt = getProductType(idOrPt);
  if (pt.styleAxis !== 'size') return null;
  const all = !enabledStyles || !Object.keys(enabledStyles).length;
  const out = [];
  for (const style of stylesFor(pt)) {
    if (!all && !enabledStyles[style.key]) continue;
    for (const name of styleCompatibilityNamesOf(style)) {
      if (!out.includes(name)) out.push(name);
    }
  }
  return out;
}

/** Every possible buyer-facing description model name across all models. */
function allDescriptionNames(idOrPt) {
  const pt = getProductType(idOrPt);
  if (!pt.models.length) return styleCompatibilityNames(pt) || (pt.compatibilityNames || []).slice();
  const out = [];
  for (const m of pt.models) {
    const names = pt.modelDescriptionNames[m] || [m];
    for (const n of names) out.push(n);
  }
  return out;
}

/**
 * The compact device string for the TITLE, derived from the enabled models.
 *   iPhone : all → "iPhone 18 17 16 15 14 13 Pro Max";
 *            upload default → "iPhone 18 17 16 15 Pro Max";
 *            15-17 → "iPhone 17 16 15 Pro Max".
 *   AirPods: "AirPods Pro 3 2 1 & AirPods 5 4 3 2 1" (only the offered generations).
 *   Apple Watch: fixed sizes stay in the dropdown; the title simply says "Apple Watch".
 */
function titleDevicePhrase(idOrPt, enabledModels) {
  const pt = getProductType(idOrPt);
  if (!pt.models.length) return pt.deviceWord;
  // Band sizes are mandatory in the Etsy dropdown and fully enumerated in the
  // compatibility section; spelling all millimetre groups into the title would
  // make it unreadable and does not improve the required choice.
  if (pt.id === 'apple_watch_band') return pt.deviceWord;
  const names = compatibilityNamesFor(pt, enabledModels);
  if (!names.length) return pt.deviceWord;

  if (pt.id === 'airpods_case') {
    const proNums = [];
    const baseNums = [];
    for (const n of names) {
      const pro = /pro/i.test(n);
      const m = n.match(/(\d+)/);
      const num = m ? Number(m[1]) : 1; // "AirPods Pro" (no number) = gen 1
      if (pro) proNums.push(num);
      else if (m) baseNums.push(num);
    }
    const desc = (a) => [...new Set(a)].sort((x, y) => y - x);
    const parts = [];
    if (proNums.length) parts.push(`AirPods Pro ${desc(proNums).join(' ')}`);
    if (baseNums.length) parts.push(`AirPods ${desc(baseNums).join(' ')}`);
    return parts.join(' & ') || 'AirPods';
  }

  // iPhone (and any numeric phone-style device).
  const nums = [];
  for (const n of names) {
    const m = n.match(/(\d+)/);
    if (m && !nums.includes(m[1])) nums.push(m[1]);
  }
  nums.sort((a, b) => Number(b) - Number(a));
  const anyProMax = names.some((n) => /pro max/i.test(n));
  if (!nums.length) return pt.deviceWord;
  return `${pt.deviceWord} ${nums.join(' ')}${anyProMax ? ' Pro Max' : ''}`;
}

/**
 * Device generations the live-listing rollout should inject for this line.
 * Empty for lines with no pending launch (watch, iPad, unknown).
 *
 * @param {string|object} [idOrPt]
 * @returns {string[]}
 */
function generationAdditionsFor(idOrPt) {
  const pt = getProductType(idOrPt);
  return (DEVICE_GENERATION_ADDITIONS[pt.id] || []).slice();
}

;(function assertGenerationAdditions() {
  for (const [typeId, added] of Object.entries(DEVICE_GENERATION_ADDITIONS)) {
    const pt = PRODUCT_TYPES[typeId];
    if (!pt) {
      throw new Error(`DEVICE_GENERATION_ADDITIONS refers to unknown product type "${typeId}"`);
    }
    for (const model of added) {
      if (!pt.models.includes(model)) {
        throw new Error(`DEVICE_GENERATION_ADDITIONS.${typeId} includes "${model}" which is not in ${typeId}.models`);
      }
    }
  }
  for (const [typeId, on] of Object.entries(UPLOAD_DEFAULT_ON)) {
    const pt = PRODUCT_TYPES[typeId];
    if (!pt) {
      throw new Error(`UPLOAD_DEFAULT_ON refers to unknown product type "${typeId}"`);
    }
    const offered = new Set(on);
    for (const model of on) {
      if (!pt.models.includes(model)) {
        throw new Error(`UPLOAD_DEFAULT_ON.${typeId} includes "${model}" which is not in ${typeId}.models`);
      }
    }
    // A generation we inject onto live listings must also start selected on a
    // brand-new upload. Otherwise the rollout and the bulk creator disagree
    // about whether iPhone 18 Pro exists.
    for (const model of DEVICE_GENERATION_ADDITIONS[typeId] || []) {
      if (!offered.has(model)) {
        throw new Error(`UPLOAD_DEFAULT_ON.${typeId} omits new generation "${model}"`);
      }
    }
  }
})();

/**
 * Exact buyer-readable phrase every title must contain.
 *
 * Most lines express compatibility after the product noun ("Cover for iPhone
 * 18…"). A watch band is clearer and matches its strongest query when the item
 * phrase itself is "Apple Watch Band", without repeating it as "Band … Strap
 * for Apple Watch".
 */
function titleListingPhraseFor(idOrPt, enabledModels) {
  const pt = getProductType(idOrPt);
  if (pt.titleListingPhrase) return pt.titleListingPhrase;
  return `${pt.titleFitPhrase || 'Cover for'} ${titleDevicePhrase(pt, enabledModels)}`.trim();
}

module.exports = {
  ALL_STYLE_KEYS,
  CANONICAL_STYLES,
  PROP_DEVICE,
  PROP_CHOICE,
  PRODUCT_TYPES,
  DEFAULT_PRODUCT_TYPE,
  DEVICE_GENERATION_ADDITIONS,
  FAMILY_IPHONE,
  FAMILY_AIRPODS,
  FAMILY_WATCH,
  FAMILY_IPAD,
  getProductType,
  isKnownProductType,
  listProductTypes,
  stylePropertyFor,
  hasDeviceAxis,
  isDeviceAxisFixed,
  stylesFor,
  styleKeysFor,
  styleLabelFor,
  normaliseEnabledStyles,
  defaultEnabledStyles,
  fallbackStyleKey,
  defaultStylePricesFor,
  hasOwnPriceBook,
  priceBookCurrencies,
  priceLinksFor,
  deviceFamilyOf,
  typedModelFamily,
  crossFamilyModelError,
  canonicalModelsForFamily,
  familyIsSingleUnit,
  sizeAxisPropertyNames,
  pricedAxisPropertyNames,
  variationPropertyRole,
  primaryComponentLabel,
  defaultEnabledModels,
  normaliseEnabledModels,
  enabledModelList,
  compatibilityNamesFor,
  styleCompatibilityNames,
  allDescriptionNames,
  titleDevicePhrase,
  titleListingPhraseFor,
  generationAdditionsFor,
  styleAxisOf,
  includedItemsFor,
  choiceNounFor,
  confusableNounsFor,
  productMeta,
};
