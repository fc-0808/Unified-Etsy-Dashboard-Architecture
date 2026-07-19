'use strict';

/**
 * Operator-declared "same product" merges (human-in-the-loop dedup override).
 *
 * The shopping route unifies orders of the SAME physical supplier product by a
 * perceptual hash of each listing's image (see `reconcileCanonicalProductKeys`
 * in the server). That is fully automatic but, by design, conservative: it only
 * links listings whose photos look alike. Two listings can be the exact same
 * item on the supplier's shelf yet carry different Etsy photos (a different
 * angle, phone model, or a seasonal promo shot), which the hash cannot see —
 * so their orders show up as two separate product cards on the route.
 *
 * This module owns the durable override for those false negatives: an operator
 * records that two (or more) listings are the same product, and the canonical
 * reconciler honours it as a FORCED union edge. Because the edges live in their
 * own table — not in the hash cache — the decision survives image re-hashing,
 * catalog re-imports, and full re-syncs.
 *
 * Storage model: an undirected, de-duplicated edge list (`listing_a < listing_b`).
 * A connected component of that graph is one product. Callers that need product
 * identity resolve components with a union-find over these edges.
 */

/**
 * Normalise a raw listing id to a positive integer, or return null.
 * (Manual/synthetic order rows use non-positive ids and can't be merged.)
 */
function normId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Ordered [a, b] with a < b, or null when the pair is invalid/degenerate. */
function orderedPair(x, y) {
  const a = normId(x);
  const b = normId(y);
  if (a == null || b == null || a === b) return null;
  return a < b ? [a, b] : [b, a];
}

/** Every stored merge edge, as `{ listing_a, listing_b }` (a < b). */
function getMergeEdges(db) {
  try {
    return db.prepare('SELECT listing_a, listing_b FROM product_merges').all();
  } catch {
    return [];
  }
}

/**
 * The full adjacency of manual merges: `Map<listingId, Set<listingId>>`.
 * Undirected — every edge is recorded in both directions for easy traversal.
 */
function getMergeAdjacency(db) {
  const adj = new Map();
  const add = (from, to) => {
    if (!adj.has(from)) adj.set(from, new Set());
    adj.get(from).add(to);
  };
  for (const { listing_a, listing_b } of getMergeEdges(db)) {
    add(listing_a, listing_b);
    add(listing_b, listing_a);
  }
  return adj;
}

/**
 * Record that a set of listings are the SAME product. Any two of them becoming
 * connected merges their whole components, so passing an existing member is a
 * safe way to extend a group. Edges are stored star-wise from the group's
 * smallest id, which keeps the table compact while preserving connectivity.
 * Idempotent. Returns the number of new edges inserted.
 */
function linkProducts(db, listingIds, opts = {}) {
  const ids = [...new Set((Array.isArray(listingIds) ? listingIds : []).map(normId).filter((n) => n != null))];
  if (ids.length < 2) {
    throw Object.assign(new Error('Provide at least two distinct listing ids to merge.'), { status: 400 });
  }
  const note = String(opts.note || '').slice(0, 500);
  const createdBy = String(opts.createdBy || '').slice(0, 120);
  const anchor = Math.min(...ids);
  const insert = db.prepare(
    'INSERT OR IGNORE INTO product_merges (listing_a, listing_b, note, created_by) VALUES (?, ?, ?, ?)',
  );
  let inserted = 0;
  const tx = db.transaction(() => {
    for (const id of ids) {
      if (id === anchor) continue;
      const pair = orderedPair(anchor, id);
      if (!pair) continue;
      inserted += insert.run(pair[0], pair[1], note, createdBy).changes;
    }
  });
  tx();
  return inserted;
}

/**
 * Remove a listing from all of its merges (fully unlink it). Returns the number
 * of edges removed. Remaining members stay linked to each other only if other
 * edges still connect them — for a star group anchored on `listingId` this
 * dissolves the group, which is the least-surprising behaviour for an "unmerge".
 */
function unlinkProduct(db, listingId) {
  const id = normId(listingId);
  if (id == null) return 0;
  return db.prepare('DELETE FROM product_merges WHERE listing_a = ? OR listing_b = ?').run(id, id).changes;
}

/** Remove a single specific edge. Returns true when a row was deleted. */
function removeMergePair(db, x, y) {
  const pair = orderedPair(x, y);
  if (!pair) return false;
  return db.prepare('DELETE FROM product_merges WHERE listing_a = ? AND listing_b = ?').run(pair[0], pair[1]).changes > 0;
}

module.exports = {
  normId,
  orderedPair,
  getMergeEdges,
  getMergeAdjacency,
  linkProducts,
  unlinkProduct,
  removeMergePair,
};
