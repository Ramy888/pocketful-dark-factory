// Domain helpers. Every scenario is built from POST /_test/reset fixtures and the
// public HTTP API only -- the suite never reaches into service internals.

import { fixture, fixtureObject } from './runner.mjs';

export const PW = 'correct horse';

// The relative path used in printed reproduction commands. Run them from the repo root.
const FIXTURE_CURL_DIR = 'stage-1/acceptance/fixtures';

let keySeq = 0;
export function key(prefix = 'k') {
  keySeq += 1;
  return `${prefix}-${process.pid}-${Date.now().toString(36)}-${keySeq}`;
}

export function qs(query) {
  if (!query) return '';
  const parts = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    // Deliberately not encodeURIComponent for values under test: the suite needs to
    // send exactly what a client would type, including "+4" and "4.0".
    parts.push(`${k}=${v === null ? '' : String(v)}`);
  }
  return parts.length ? '?' + parts.join('&') : '';
}

// One API call. `body` is JSON-encoded; `rawBody` is sent verbatim (for malformed input).
export async function api(t, spec) {
  const { method = 'GET', path, token, idemKey, body, rawBody, query, base, headers: extra } = spec;
  const headers = { ...(extra || {}) };
  if (token !== undefined && token !== null) headers.Authorization = `Bearer ${token}`;
  if (idemKey !== undefined && idemKey !== null) headers['Idempotency-Key'] = idemKey;
  let payload;
  if (rawBody !== undefined) payload = rawBody;
  else if (body !== undefined) payload = JSON.stringify(body);
  if (payload !== undefined) headers['Content-Type'] = 'application/json';
  return t.req({ method, path: path + qs(query), headers, body: payload, base });
}

export async function reset(t, name = 'eur') {
  const res = await t.req({
    method: 'POST',
    path: '/_test/reset',
    headers: { 'Content-Type': 'application/json' },
    body: fixture(name),
    curlBody: `--data-binary @${FIXTURE_CURL_DIR}/${name}.json`,
  });
  t.status(res, 204, { ref: 'R3.3', what: `POST /_test/reset with ${name}.json` });
  return fixtureObject(name);
}

// Reset with a fixture built in memory (used for invalid and one-off fixtures).
export async function resetWith(t, obj, expectStatus = 204) {
  const res = await t.req({
    method: 'POST',
    path: '/_test/reset',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  });
  if (expectStatus !== null) {
    t.status(res, expectStatus, { ref: 'R3.3', what: 'POST /_test/reset with an inline fixture' });
  }
  return res;
}

export async function login(t, email, password = PW) {
  const res = await api(t, { method: 'POST', path: '/auth/login', body: { email, password } });
  if (!t.status(res, 200, { ref: 'R6.2', what: `POST /auth/login for ${email}` })) return null;
  return res.json;
}

export async function token(t, email, password = PW) {
  const out = await login(t, email, password);
  return out ? out.token : null;
}

// Reset to a fixture and log in every seeded user.
// Returns the fixture, { handle: token } and { handle: user_id }.
export async function loginAll(t, fixtureName = 'eur') {
  const fx = await reset(t, fixtureName);
  const tokens = {};
  const ids = {};
  for (const u of fx.users) {
    const out = await login(t, u.email, u.password);
    tokens[u.handle] = out ? out.token : null;
    ids[u.handle] = u.id;
  }
  return { fx, tokens, ids };
}

export async function signup(t, email, display_name = 'New User', password = PW) {
  return api(t, { method: 'POST', path: '/auth/signup', body: { email, password, display_name } });
}

export async function me(t, tok) {
  return api(t, { path: '/me', token: tok });
}

export async function balance(t, tok) {
  const res = await me(t, tok);
  return res.json && typeof res.json.balance === 'number' ? res.json.balance : NaN;
}

// The spec-1.1 invariant: the sum over every wallet must equal the seeded total.
export async function sumBalances(t, tokens) {
  let sum = 0;
  for (const [handle, tok] of Object.entries(tokens)) {
    const b = await balance(t, tok);
    if (!Number.isFinite(b)) {
      t.record({
        ref: 'R8.1', what: `GET /me for ${handle}`,
        expected: 'a numeric balance', actual: 'no readable balance',
      });
      return NaN;
    }
    sum += b;
  }
  return sum;
}

export async function pay(t, tok, body, idemKey = null) {
  return api(t, { method: 'POST', path: '/payments', token: tok, idemKey: idemKey || key('pay'), body });
}

export async function makeRequest(t, tok, body, idemKey = null) {
  return api(t, { method: 'POST', path: '/requests', token: tok, idemKey: idemKey || key('req'), body });
}

export async function payRequest(t, tok, id, body = {}, idemKey = null) {
  return api(t, { method: 'POST', path: `/requests/${id}/pay`, token: tok, idemKey: idemKey || key('rpay'), body });
}

export async function split(t, tok, body, idemKey = null) {
  return api(t, { method: 'POST', path: '/splits', token: tok, idemKey: idemKey || key('split'), body });
}

export async function settle(t, tok, transfers, idemKey = null) {
  return api(t, {
    method: 'POST', path: '/settlements', token: tok,
    idemKey: idemKey || key('stl'),
    body: Array.isArray(transfers) ? { transfers } : transfers,
  });
}

export async function activity(t, tok, query) {
  return api(t, { path: '/activity', token: tok, query });
}

export async function requests(t, tok, query) {
  return api(t, { path: '/requests', token: tok, query });
}

export const PAYMENT_FIELDS = [
  'payment_id', 'from_user_id', 'from_handle', 'to_user_id', 'to_handle',
  'amount', 'currency', 'note', 'visibility', 'request_id', 'created_at',
];

export const REQUEST_FIELDS = [
  'request_id', 'requester_id', 'requester_handle', 'payer_id', 'payer_handle',
  'amount', 'currency', 'note', 'status', 'payment_id', 'created_at',
];

export const SPLIT_FIELDS = ['split_id', 'amount', 'currency', 'note', 'shares', 'requests', 'created_at'];

// The equal-split rule of spec 9, computed independently of the implementation:
// whole minor units, summing exactly to amount, larger shares to the earliest
// participants in participant_handles order.
export function expectedShares(amount, n) {
  const base = Math.floor(amount / n);
  const extra = amount - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

export function ids(list, field) {
  return (list || []).map((x) => (x ? x[field] : undefined));
}

// Run `fn` for each of n indexes, all in flight at once.
export function concurrently(n, fn) {
  return Promise.all(Array.from({ length: n }, (_, i) => fn(i)));
}

export function countStatuses(responses) {
  const out = {};
  for (const r of responses) {
    const code = r.json && r.json.error ? `${r.status} ${r.json.error.code}` : String(r.status);
    out[code] = (out[code] || 0) + 1;
  }
  return out;
}

export function describeStatuses(responses) {
  return JSON.stringify(countStatuses(responses));
}
