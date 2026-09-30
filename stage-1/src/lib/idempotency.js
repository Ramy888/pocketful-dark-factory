'use strict';

const { AppError } = require('./errors');

// R7.10: "same body" is the same JSON value after parsing -- key order and
// whitespace never matter. Canonicalizing (sort object keys, recurse)
// before comparing or storing makes key order irrelevant while array
// element order -- which is semantically meaningful, e.g. a settlement's
// transfers -- is preserved untouched.
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonicalize(value[k]);
    return out;
  }
  return value;
}

// A record is scoped to (user, key, method, path): R7.3 says the key is
// per-user, and R7.4 says the same key and body on a different path (or a
// different {id} path under the same collection) is a different request,
// not a replay -- so two records for the same (user, key) but different
// paths coexist independently rather than colliding.
function mapKey(userId, key, method, path) {
  return JSON.stringify([userId, key, method, path]);
}

// The gate for every specification-7 write path. `handler` performs
// endpoint field validation, resource resolution and the state mutation; it
// must be synchronous. D2 requires no await between claiming a key and
// committing its effect, so "exactly one concurrent request returns 201"
// (R7.11) holds because Node runs one handler to completion before another
// can start, not because of a lock. A key is claimed only after `handler`
// succeeds -- a first use that fails with 4xx leaves no record (R7.9) -- and
// the claim and the mutation happen in the same synchronous turn, so no
// other request's code can observe the gap between them.
function runIdempotent(store, { user, method, path, rawKey, body }, handler) {
  if (rawKey === undefined || rawKey === null || rawKey === '' || typeof rawKey !== 'string') {
    throw new AppError(400, 'missing_idempotency_key', 'Idempotency-Key header is required');
  }
  // D20: counted in code points; spreading a string iterates by code point,
  // correctly counting a surrogate pair as one character.
  const length = [...rawKey].length;
  if (length < 1 || length > 255) {
    throw new AppError(422, 'validation_failed', 'Idempotency-Key must be 1 to 255 characters');
  }

  const canonical = JSON.stringify(canonicalize(body));
  const key = mapKey(user.id, rawKey, method, path);
  const existing = store.state.idempotency.get(key);
  if (existing) {
    if (existing.bodyCanonical === canonical) {
      // R7.7/R7.12: the replay is always 200, carrying the original
      // response body verbatim, whatever the resource's state has become.
      return { status: 200, body: existing.responseBody };
    }
    // R7.13: this beats endpoint field validation and resource resolution
    // by construction -- `handler` (where those checks live) is never
    // called on this path.
    throw new AppError(409, 'idempotency_key_reuse', 'Idempotency-Key already used with a different request body');
  }

  const result = handler();
  if (result && typeof result.then === 'function') {
    // Enforces D2 at the call site: a handler that returned a Promise would
    // mean an await could land between claim and commit, breaking the
    // exactly-once guarantee this gate exists to provide.
    throw new Error('idempotent handler must be synchronous (D2): no await between claim and commit');
  }

  store.state.idempotency.set(key, {
    userId: user.id, key: rawKey, method, path,
    bodyCanonical: canonical, status: result.status, responseBody: result.body,
  });
  return result;
}

module.exports = { runIdempotent, canonicalize };
