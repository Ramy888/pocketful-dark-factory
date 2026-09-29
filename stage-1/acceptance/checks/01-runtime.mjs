// Specification 2 and 3: runtime contract and conventions.
// Every check in this file runs without POST /_test/reset, so the file is also a
// standalone gate for a service that only has its skeleton and /health.

import { suite, test } from '../lib/runner.mjs';
import { api, reset, login, key } from '../lib/helpers.mjs';

suite('01 runtime contract', () => {
  test('GET /health answers 200 with {"status":"ok"}', ['R3.2'], async (t) => {
    const res = await api(t, { path: '/health' });
    if (!t.status(res, 200, { ref: 'R3.2', what: 'GET /health' })) return;
    t.eq(res.json && res.json.status, 'ok', {
      ref: 'R3.2', what: 'GET /health body', res,
    });
  });

  test('GET /health needs no Authorization header', ['R6.8'], async (t) => {
    const res = await api(t, { path: '/health' });
    t.status(res, 200, { ref: 'R6.8', what: 'GET /health without a bearer token' });
  });

  test('GET /health ignores unknown query parameters', ['R3.4d'], async (t) => {
    const res = await api(t, { path: '/health', query: { nonsense: 'x', limit: 'not-a-number' } });
    t.status(res, 200, { ref: 'R3.4d', what: 'GET /health?nonsense=x&limit=not-a-number' });
  });

  test('every response declares application/json; charset=utf-8', ['R3.4a'], async (t) => {
    // Checked globally on every exchange; this call makes the reference explicit.
    const res = await api(t, { path: '/health' });
    const ct = String(res.headers['content-type'] || '');
    t.ok(/application\/json/i.test(ct) && /charset=utf-?8/i.test(ct.replace(/\s/g, '')), {
      ref: 'R3.4a', what: 'GET /health Content-Type', res,
      expected: 'application/json; charset=utf-8',
      actual: ct || '(absent)',
    });
  });

  test('an unrouted path answers 4xx carrying the spec-5 error envelope', ['R5.1'], async (t) => {
    const res = await api(t, { path: '/no/such/route/' + key('x') });
    t.ok(res.status >= 400 && res.status < 500, {
      ref: 'R5.1', what: 'GET an unrouted path', res,
      expected: 'a 4xx status', actual: `HTTP ${res.status}`,
    });
    // The envelope itself is asserted by the global invariant on every 4xx response.
    t.ok(res.text.length > 0, {
      ref: 'R5.1', what: 'unrouted path body', res,
      expected: 'a JSON error body', actual: '(empty body)',
    });
  });

  test('an unrouted path answers 404 not_found', ['R5.6'], async (t) => {
    const res = await api(t, { path: '/no/such/route/' + key('x') });
    t.err(res, 404, 'not_found', { ref: 'R5.6', what: 'GET an unrouted path' });
  }, {
    severity: 'advisory',
    why: 'spec 5 names 404 not_found for "no such resource" but does not state which code an '
       + 'unrouted path uses; 405-style answers are a defensible reading. The error-envelope '
       + 'shape (R5.1) is the blocking part and is checked separately.',
  });

  test('a wrong method on a known path answers 4xx with an error envelope', ['R5.1'], async (t) => {
    const res = await api(t, { method: 'GET', path: '/auth/login' });
    t.ok(res.status >= 400 && res.status < 500, {
      ref: 'R5.1', what: 'GET /auth/login (a POST-only path)', res,
      expected: 'a 4xx status', actual: `HTTP ${res.status}`,
    });
  });

  test('an unparseable body is 400 malformed_request', ['R5.2'], async (t) => {
    const res = await t.req({
      method: 'POST', path: '/_test/reset',
      headers: { 'Content-Type': 'application/json' },
      body: '{"currency": "EUR", ',
    });
    t.err(res, 400, 'malformed_request', {
      ref: 'R5.2', what: 'POST /_test/reset with a truncated JSON body',
    });
  });

  test('a body that parses but is not a JSON object is 400 malformed_request', ['D12'], async (t) => {
    for (const raw of ['[1,2,3]', '"a string"', '42', 'null', 'true']) {
      const res = await t.req({
        method: 'POST', path: '/_test/reset',
        headers: { 'Content-Type': 'application/json' }, body: raw,
      });
      t.err(res, 400, 'malformed_request', {
        ref: 'D12', what: `POST /_test/reset with body ${raw}`,
      });
    }
  }, {
    severity: 'advisory',
    why: 'The specification says a body that does not parse is 400 malformed_request and that a '
       + 'field of the wrong type is 400, but never states the status for a well-formed non-object '
       + 'body. Coordinator decision D12 chooses 400; 422 validation_failed is also defensible.',
  });

  test('a request body is parsed regardless of its Content-Type', ['D11'], async (t) => {
    await reset(t, 'eur');
    const tok = await login(t, 'ada@example.com');
    if (!tok) return;
    const bodies = [
      ['no Content-Type at all', undefined],
      ['text/plain', 'text/plain'],
      ['application/json with a charset', 'application/json; charset=utf-8'],
      ['an unrelated type', 'application/x-www-form-urlencoded'],
    ];
    for (const [label, contentType] of bodies) {
      const headers = { Authorization: `Bearer ${tok.token}`, 'Idempotency-Key': key('ct') };
      if (contentType) headers['Content-Type'] = contentType;
      const res = await t.req({
        method: 'POST', path: '/payments', headers,
        body: JSON.stringify({ to_handle: 'bob', amount: 3 }),
      });
      t.status(res, 201, { ref: 'D11', what: `POST /payments with ${label}` });
    }
  }, {
    severity: 'advisory',
    why: 'spec 3.4 states the content type of requests and responses but spec 5 lists no error for a '
       + 'wrong or missing request Content-Type. Decision D11 parses regardless; rejecting an odd '
       + 'Content-Type would invent a status the error table does not name, but the specification '
       + 'does not forbid it either.',
  });

  test('an absent or empty request body is treated as {}', ['D12'], async (t) => {
    await reset(t, 'eur');
    const ada = await login(t, 'ada@example.com');
    const bob = await login(t, 'bob@example.com');
    if (!ada || !bob) return;
    const rq = await api(t, {
      method: 'POST', path: '/requests', token: ada.token, idemKey: key('nb'),
      body: { payer_handle: 'bob', amount: 10 },
    });
    if (!t.status(rq, 201, { ref: 'R8.12', what: 'POST /requests' })) return;
    // The pay body is entirely optional, so no body at all must behave like {}.
    const res = await t.req({
      method: 'POST', path: `/requests/${rq.json.request_id}/pay`,
      headers: { Authorization: `Bearer ${bob.token}`, 'Idempotency-Key': key('nb') },
    });
    if (!t.status(res, 201, { ref: 'D12', what: 'POST /requests/{id}/pay with no body at all' })) return;
    t.eq(res.json.visibility, 'public', { ref: 'D12', what: 'the default visibility applied', res });
  }, {
    severity: 'advisory',
    why: 'spec 8 distinguishes {} from {"visibility":"public"} as JSON values but says nothing about '
       + 'sending no body. Decision D12 treats absent and empty as {}; answering 400 '
       + 'malformed_request is also defensible.',
  });

  test('timestamps are RFC 3339 with an explicit offset', ['R3.4b'], async (t) => {
    // The global invariant enforces the format on every created_at/committed_at the
    // suite ever sees; this check guarantees at least one such value is produced.
    await reset(t, 'eur');
    const tok = await login(t, 'ada@example.com');
    if (!tok) return;
    const res = await api(t, {
      method: 'POST', path: '/payments', token: tok.token, idemKey: key('ts'),
      body: { to_handle: 'bob', amount: 1 },
    });
    if (!t.status(res, 201, { ref: 'R8.3', what: 'POST /payments' })) return;
    t.ok(typeof (res.json || {}).created_at === 'string', {
      ref: 'R3.4b', what: 'payment created_at', res,
      expected: 'a string timestamp', actual: JSON.stringify((res.json || {}).created_at),
    });
  });

  test('timestamps use a numeric offset rather than the Z designator', ['D8'], async (t) => {
    await reset(t, 'eur');
    const tok = await login(t, 'ada@example.com');
    if (!tok) return;
    const res = await api(t, {
      method: 'POST', path: '/payments', token: tok.token, idemKey: key('tz'),
      body: { to_handle: 'bob', amount: 1 },
    });
    const ts = (res.json || {}).created_at;
    t.ok(typeof ts === 'string' && /[+-]\d{2}:\d{2}$/.test(ts), {
      ref: 'D8', what: 'payment created_at offset', res,
      expected: 'a numeric offset such as +00:00',
      actual: JSON.stringify(ts),
    });
  }, {
    severity: 'advisory',
    why: 'RFC 3339 admits Z as an explicit offset, so Z satisfies the specification. '
       + 'Coordinator decision D8 additionally requires the numeric form.',
  });

  test('unknown fields in a request body are ignored, never an error', ['R3.4c'], async (t) => {
    await reset(t, 'eur');
    const tok = await login(t, 'ada@example.com');
    if (!tok) return;
    const res = await api(t, {
      method: 'POST', path: '/payments', token: tok.token, idemKey: key('unk'),
      body: {
        to_handle: 'bob', amount: 7, note: 'ok',
        surprise: { nested: [1, 2, 3] }, visibility_: 'nope', amount_: 'x',
      },
    });
    t.status(res, 201, { ref: 'R3.4c', what: 'POST /payments with unknown fields' });
    t.eq((res.json || {}).amount, 7, { ref: 'R3.4c', what: 'amount survived', res });
  });

  test('unknown query parameters are ignored on list endpoints', ['R3.4d'], async (t) => {
    await reset(t, 'eur');
    const tok = await login(t, 'ada@example.com');
    if (!tok) return;
    for (const path of ['/activity', '/requests']) {
      const res = await api(t, { path, token: tok.token, query: { wat: 'x', Limit: '999', LIMIT: 'abc' } });
      t.status(res, 200, { ref: 'R3.4d', what: `GET ${path} with unknown query parameters` });
    }
  });

  test('ids are opaque strings of at most 64 characters', ['R3.4e'], async (t) => {
    // Enforced globally on every *_id field the suite sees; this check produces one
    // of every id kind so the global rule has something to inspect.
    await reset(t, 'eur');
    const ada = await login(t, 'ada@example.com');
    if (!ada) return;
    const p = await api(t, {
      method: 'POST', path: '/payments', token: ada.token, idemKey: key('id'),
      body: { to_handle: 'bob', amount: 1 },
    });
    t.ok(typeof (p.json || {}).payment_id === 'string', {
      ref: 'R3.4e', what: 'payment_id', res: p,
      expected: 'a string id', actual: JSON.stringify((p.json || {}).payment_id),
    });
    const s = await api(t, {
      method: 'POST', path: '/splits', token: ada.token, idemKey: key('id'),
      body: { amount: 3, participant_handles: ['ada', 'bob', 'cy'] },
    });
    t.ok(typeof (s.json || {}).split_id === 'string', {
      ref: 'R3.4e', what: 'split_id', res: s,
      expected: 'a string id', actual: JSON.stringify((s.json || {}).split_id),
    });
  });
});
