'use strict';
/**
 * The charm manifest OSP exports fills every new charm's Notes with an
 * instruction sheet for the operator, in one of two shapes:
 *
 *   "Auto-import 2026-04-03 05:49 UTC. Fill SKU (C) and optional Default Charm Shop (D)."
 *   "Imported 2026-04-03 05:49 UTC.…• Fill SKU (C).…• Optional: Default shop (D)."
 *
 * Both tell the operator to fill in a SKU, a field the dashboard no longer has,
 * so they are now stale instructions occupying the one free-text field a charm
 * has. This recognises them so they can be dropped on import and cleared from
 * charms that already carry them.
 *
 * The pattern is deliberately narrow — an import verb AND a machine timestamp
 * AND the "Fill SKU (C)" instruction — because the cost of a false positive is
 * erasing something an operator wrote by hand.
 */

const IMPORT_BOILERPLATE = /^\s*(?:auto-import|imported)\b[^\n]*?\d{4}-\d{2}-\d{2}[\s\S]*?fill\s+sku\s*\(\s*c\s*\)/i;

/** True when `notes` is the manifest's generated "fill in the SKU" instruction. */
function isImportBoilerplateNote(notes) {
  return IMPORT_BOILERPLATE.test(String(notes == null ? '' : notes));
}

/** The note worth keeping: '' for the generated instruction, else the note itself. */
function cleanCharmNote(notes) {
  const text = String(notes == null ? '' : notes);
  return isImportBoilerplateNote(text) ? '' : text;
}

module.exports = { isImportBoilerplateNote, cleanCharmNote };
