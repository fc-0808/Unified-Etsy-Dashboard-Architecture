'use strict';

/**
 * Centralised configuration for the Bulk Listing Creator feature.
 *
 * Reads from environment variables (.env at the project root). Loading dotenv
 * here makes every listings/* module self-sufficient when required outside the
 * server process (e.g. ad-hoc scripts or tests).
 */

const path = require('path');

try {
  require('dotenv').config();
} catch {
  /* dotenv optional — env vars may be set by the shell/PM2 instead */
}

const PROJECT_ROOT = path.resolve(__dirname, '../../');

function bool(value, fallback) {
  if (value == null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

const config = {
  projectRoot: PROJECT_ROOT,

  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model:  process.env.OPENAI_MODEL || 'gpt-5',
  },

  bulk: {
    defaultState: (process.env.LISTING_DEFAULT_STATE || 'draft').toLowerCase() === 'published'
      ? 'published'
      : 'draft',
    concurrency:      Math.max(1, int(process.env.BULK_CONCURRENCY, 1)),
    restockQuantity:  Math.max(0, int(process.env.BULK_RESTOCK_QUANTITY, 3)),
  },

  pricingWorkbookPath:
    process.env.PRICING_WORKBOOK_PATH ||
    path.join(PROJECT_ROOT, 'Y2KASE_Pricing_Master_4_Currencies.xlsx'),
};

/** @returns {boolean} true when an OpenAI key is configured */
function hasOpenAiKey() {
  return Boolean(config.openai.apiKey && config.openai.apiKey.trim());
}

module.exports = { config, hasOpenAiKey, bool, int };
