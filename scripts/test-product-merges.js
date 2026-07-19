'use strict';

/**
 * Regression test — operator-declared "same product" merges.
 *
 * The shopping route unifies orders of one physical product by a perceptual
 * hash of each listing's image. That is conservative by design: two listings
 * that are the SAME item on the supplier's shelf but carry different Etsy
 * photos can't be linked automatically, so their orders split into two product
 * cards. `src/route/product-merges.js` is the durable human-in-the-loop override
 * for those false negatives, and `reconcileCanonicalProductKeys` honours its
 * edges as forced unions.
 *
 * This guards the module's storage + graph invariants:
 *   • edges are stored undirected and de-duplicated (listing_a < listing_b),
 *   • merging is idempotent and composes into connected components,
 *   • unlinking removes a listing's edges,
 *   • invalid / non-positive (manual-order) ids are rejected.
 *
 * Run: `node scripts/test-product-merges.js`
 * Exit code 0 = all assertions pass, 1 = a regression was detected.
 */

const Database = require('better-sqlite3');
const pm = require('../src/route/product-merges');

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  ok  — ${msg}`);
  } else {
    failures++;
    console.error(`  FAIL — ${msg}`);
  }
}

// Mirror of the product_merges schema in src/db/setup.js (kept in lockstep).
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE product_merges (
      listing_a  INTEGER NOT NULL,
      listing_b  INTEGER NOT NULL,
      note       TEXT    DEFAULT '',
      created_by TEXT    DEFAULT '',
      created_at INTEGER DEFAULT (strftime('%s','now')),
      PRIMARY KEY (listing_a, listing_b),
      CHECK (listing_a < listing_b)
    );
  `);
  return db;
}

console.log('Product-merge (same-product override) regression test\n');

const db = makeDb();

// — Basic merge stores one normalised edge regardless of argument order. —
assert(pm.linkProducts(db, [4498110919, 4490497497]) === 1, 'merging two listings inserts exactly one edge');
{
  const edges = pm.getMergeEdges(db);
  assert(edges.length === 1, 'exactly one edge is stored');
  assert(edges[0].listing_a === 4490497497 && edges[0].listing_b === 4498110919,
    'edge is normalised to (min, max) so order of arguments does not matter');
}

// — Merging is idempotent (re-declaring the same pair inserts nothing). —
assert(pm.linkProducts(db, [4490497497, 4498110919]) === 0, 're-merging the same pair is a no-op (idempotent)');
assert(pm.getMergeEdges(db).length === 1, 'no duplicate edge was created');

// — A group of three composes into one connected component. —
assert(pm.linkProducts(db, [4490497497, 4498110919, 4500000000]) === 1,
  'extending an existing group only adds the missing edge');
{
  const adj = pm.getMergeAdjacency(db);
  // Union-find over the adjacency: all three must land in one component.
  const seen = new Set();
  const stack = [4490497497];
  while (stack.length) {
    const n = stack.pop();
    if (seen.has(n)) continue;
    seen.add(n);
    for (const m of adj.get(n) || []) stack.push(m);
  }
  assert(seen.size === 3 && seen.has(4498110919) && seen.has(4500000000),
    'the three listings form a single connected component (one product)');
}

// — Invalid inputs are rejected loudly, not silently stored. —
function throws(fn) {
  try { fn(); return false; } catch { return true; }
}
assert(throws(() => pm.linkProducts(db, [4490497497])), 'merging fewer than two listings is rejected');
assert(throws(() => pm.linkProducts(db, [0, -8])), 'non-positive (manual/synthetic) ids are rejected');
assert(throws(() => pm.linkProducts(db, [123, 123])),
  'a self-merge (one distinct id) is rejected and stores no edge');

// — Unlinking a listing removes every edge that touched it. —
{
  const removed = pm.unlinkProduct(db, 4490497497);
  assert(removed === 2, 'unlinking the anchor removes both of its edges');
  assert(pm.getMergeEdges(db).length === 0, 'the star group is fully dissolved');
}

// — removeMergePair drops a single specific equivalence. —
pm.linkProducts(db, [10, 20, 30]); // edges (10,20) and (10,30)
assert(pm.removeMergePair(db, 30, 10) === true, 'removeMergePair deletes the (10,30) edge irrespective of order');
assert(pm.getMergeEdges(db).length === 1, 'only the targeted edge is removed');

db.close();

console.log('');
if (failures > 0) {
  console.error(`${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log('All assertions passed.');
