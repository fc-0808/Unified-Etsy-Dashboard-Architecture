'use strict';

/**
 * One-time database setup script.
 * Creates the SQLite database, all tables, and seeds groups/shops from config.json.
 *
 * Run: npm run db:setup
 *
 * Safe to re-run — uses IF NOT EXISTS and UPSERT throughout.
 */

const path = require('path');
const { loadConfig } = require('../src/config/schema');
const { initDb, syncConfigToDb } = require('../src/db/setup');

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`\nConfig error: ${err.message}\n`);
    process.exit(1);
  }

  console.log('\n  Setting up Etsy Dashboard database...');
  console.log(`  Database path: ${config.db_path}`);

  const db = initDb(config.db_path);
  syncConfigToDb(db, config);

  const groupCount = db.prepare('SELECT COUNT(*) as n FROM groups').get().n;
  const shopCount = db.prepare('SELECT COUNT(*) as n FROM shops').get().n;

  console.log(`\n  Database ready.`);
  console.log(`  Groups: ${groupCount}`);
  console.log(`  Shops:  ${shopCount}`);
  console.log(`\n  Tables created: groups, shops, receipts, transactions, sync_log`);
  console.log('  WAL mode enabled for concurrent read/write.\n');

  db.close();
}

main();
