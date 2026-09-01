'use strict'

/**
 * The trust boundary between values a vision model produced and everything that
 * later displays, stores, or ships them.
 *
 * The failure this exists to kill, observed in production:
 *
 *   A provider satisfied the Phase-1 JSON schema *structurally* but filled two
 *   scalar slots with the schema fragment itself —
 *
 *     { "character_name": {"type":"string"}, "character_franchise": {"type":"string"} }
 *
 *   Nothing downstream validated the slot types. `character_name` hit a bare
 *   String() and became the literal text "[object Object]", which was written
 *   into the listing preview and shown to the operator. `character_franchise`
 *   had no coercion at all, so a live object was persisted into preview_json,
 *   travelled through the API, and reached the Inspector's HTML escaper — which
 *   called .replace() on it and threw "str.replace is not a function", blanking
 *   the entire panel for all 37 products in that run.
 *
 * Both symptoms share one root cause: a schema-shaped object where a scalar was
 * promised. This module owns that concern in one place, in three layers:
 *
 *   scrubSchemaEchoes()  at the model boundary — drops non-scalars out of
 *                        scalar slots so the garbage never enters the pipeline.
 *   plainText()          at every field that will be displayed — the one
 *                        definition of "is this usable as text", including the
 *                        "[object Object]" artefact left by earlier coercions.
 *   sanitisePreview()    at read time — heals previews that were persisted
 *                        before the layers above existed, so historical runs
 *                        open correctly with no migration.
 *
 * These are pure functions with no I/O, so they are cheap enough to apply on
 * every read and are exhaustively unit-tested in scripts/test-preview-sanitize.js.
 */

// A stringified object/array/function is never meaningful content — it is the
// fingerprint of a coercion that should not have happened.
const STRINGIFIED_OBJECT = /^\[object [A-Z][A-Za-z]*\]$/

// JSON Schema types that promise a single non-container value.
const SCALAR_SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean'])

/** True for objects and arrays — the values that must never fill a scalar slot. */
function isContainer(value) {
	return value !== null && typeof value === 'object'
}

/**
 * Coerce an untrusted value into text that is safe to display.
 *
 * Strings and finite numbers are content. Everything else — objects, arrays,
 * null, undefined, NaN, booleans — is absence, and returns ''. Callers can
 * therefore keep using their existing `|| fallback` idiom and get the fallback
 * instead of rendering garbage.
 *
 * @param {*} value
 * @returns {string} trimmed text, or '' when the value carries no content
 */
function plainText(value) {
	if (typeof value === 'string') {
		const trimmed = value.trim()
		return STRINGIFIED_OBJECT.test(trimmed) ? '' : trimmed
	}
	// Numbers are legitimate content (a tag of "2025", a numeric colour code).
	if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
	return ''
}

/**
 * Coerce an untrusted value into a list of non-empty display strings.
 * Non-arrays yield []; unusable entries are dropped rather than blanked, so a
 * count rendered next to the list ("Tags (13)") stays truthful.
 *
 * @param {*} value
 * @returns {string[]}
 */
function plainTextList(value) {
	if (!Array.isArray(value)) return []
	const out = []
	for (const entry of value) {
		const text = plainText(entry)
		if (text) out.push(text)
	}
	return out
}

/**
 * Recursively remove schema-echo values from a parsed model response.
 *
 * Walks the payload *against the JSON schema that was requested*, so the rule is
 * driven by the contract rather than by guesswork about field names. Wherever
 * the schema promised a scalar and the model supplied an object or an array,
 * the key is deleted outright rather than replaced with a placeholder: every
 * consumer in this codebase already reads these fields through a `|| default`
 * or a Number.isFinite() guard, so an absent key degrades gracefully to the
 * intended default, whereas a substituted '' or 0 would masquerade as a real
 * answer the model never gave.
 *
 * Deliberately conservative: a number arriving as the string "85", or a string
 * slot holding 2025, is left alone. Those are coercible and the existing
 * call sites already handle them. Only genuinely unusable containers go.
 *
 * Mutates and returns `value` — it is a freshly parsed payload owned by the
 * caller, and mutating avoids deep-cloning large multi-image responses.
 *
 * @param {*} value  parsed model response (or a sub-tree of it)
 * @param {object} node  the JSON Schema node describing `value`
 * @returns {*} value
 */
function scrubSchemaEchoes(value, node) {
	if (!node || typeof node !== 'object') return value

	if (node.type === 'array') {
		if (!Array.isArray(value)) return value
		const items = node.items
		if (!items || typeof items !== 'object') return value
		if (SCALAR_SCHEMA_TYPES.has(items.type)) {
			// Drop container entries in place; keep everything else untouched.
			const kept = value.filter((entry) => !isContainer(entry))
			if (kept.length !== value.length) value.splice(0, value.length, ...kept)
			return value
		}
		for (const entry of value) scrubSchemaEchoes(entry, items)
		return value
	}

	if (node.type === 'object') {
		if (!value || typeof value !== 'object' || Array.isArray(value)) return value
		const properties = node.properties || {}
		for (const key of Object.keys(properties)) {
			if (!Object.prototype.hasOwnProperty.call(value, key)) continue
			const child = properties[key]
			if (!child || typeof child !== 'object') continue
			if (SCALAR_SCHEMA_TYPES.has(child.type)) {
				if (isContainer(value[key])) delete value[key]
				continue
			}
			scrubSchemaEchoes(value[key], child)
		}
		return value
	}

	return value
}

// Preview fields the Inspector renders as text. Kept explicit rather than
// inferred: this list is the contract for "what the operator actually reads",
// and a new field should be a deliberate addition here.
const PREVIEW_TEXT_FIELDS = [
	'title',
	'description',
	'primaryColor',
	'secondaryColor',
	'character',
	'characterDetected',
	'characterFranchise',
	'characterEvidence',
	'currency',
	'videoFilename',
	'productType',
]

/**
 * Heal a persisted listing preview so it is safe and sensible to display.
 *
 * Applied on read, which means previews written before the model-boundary
 * scrubbing existed render correctly without a database migration, and a future
 * provider regression degrades to a missing field instead of a broken panel.
 * Empty text fields are deleted rather than set to '' so the Inspector's
 * `field ? renderChip() : ''` conditionals correctly hide the chip entirely.
 *
 * Mutates and returns `preview` (the caller owns a freshly parsed object).
 *
 * @param {*} preview  parsed preview_json, or any non-object (returned as-is)
 * @returns {*} preview
 */
function sanitisePreview(preview) {
	if (!preview || typeof preview !== 'object' || Array.isArray(preview)) return preview

	for (const field of PREVIEW_TEXT_FIELDS) {
		if (!(field in preview)) continue
		const text = plainText(preview[field])
		if (text) preview[field] = text
		else delete preview[field]
	}

	if ('tags' in preview) preview.tags = plainTextList(preview.tags)

	if (Array.isArray(preview.characterAlternatives)) {
		preview.characterAlternatives = preview.characterAlternatives
			.filter((alt) => alt && typeof alt === 'object' && !Array.isArray(alt))
			.map((alt) => ({ ...alt, name: plainText(alt.name) }))
			.filter((alt) => alt.name)
	}

	if (Array.isArray(preview.images)) {
		for (const image of preview.images) {
			if (image && typeof image === 'object') image.filename = plainText(image.filename)
		}
	}

	const settings = preview.settings
	if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
		if ('who_made' in settings) settings.who_made = plainText(settings.who_made)
		if ('when_made' in settings) settings.when_made = plainText(settings.when_made)
		if ('materials' in settings) settings.materials = plainTextList(settings.materials)
	}

	return preview
}

module.exports = {
	plainText,
	plainTextList,
	scrubSchemaEchoes,
	sanitisePreview,
	PREVIEW_TEXT_FIELDS,
	SCALAR_SCHEMA_TYPES,
}
