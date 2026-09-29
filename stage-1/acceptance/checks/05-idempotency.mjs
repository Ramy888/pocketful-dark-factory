// Specification 7, clause by clause, applied to each of the five idempotent write paths.

import { suite, test, deepEqual } from '../lib/runner.mjs';
import { api, loginAll, balance, requests, activity, key, concurrently, describeStatuses } from '../lib/helpers.mjs';

// A readable fingerprint of everything an accidental second application would disturb.
async function signature(t, c) {
  const a = await balance(t, c.tokens.ada);
  const b = await balance(t, c.tokens.bob);
  const rq = await requests(t, c.tokens.ada, { limit: 200 });
  const ac = await activity(t, c.tokens.ada, { limit: 200 });
  const nr = ((rq.json || {}).requests || []).length;
  const nf = ((ac.json || {}).payments || []).length;
  return `ada=${a} bob=${b} requests=${nr} feed=${nf}`;
}

async function pendingRequestFrom(t, c, requesterHandle, payerHandle, amount) {
  const res = await api(t, {
    method: 'POST', path: '/requests', token: c.tokens[requesterHandle], idemKey: key('setup'),
    body: { payer_handle: payerHandle, amount },
  });
  if (res.status !== 201) {
    t.record({
      ref: 'R8.12', what: `setup: ${requesterHandle} requests ${amount} from ${payerHandle}`,
      expected: 'HTTP 201', actual: `HTTP ${res.status}: ${res.text}`, res,
    });
    return null;
  }
  return res.json.request_id;
}

// The five paths of spec 7, each with a valid body, a different valid body and a body
// that would fail endpoint field validation.
const PATHS = [
  {
    name: 'POST /payments',
    async prepare(t, c) {
      return {
        method: 'POST', path: '/payments', token: c.tokens.ada,
        body: { to_handle: 'bob', amount: 100 },
        altBody: { to_handle: 'bob', amount: 101 },
        invalidBody: { to_handle: 'bob', amount: 0 },
      };
    },
  },
  {
    name: 'POST /requests',
    async prepare(t, c) {
      return {
        method: 'POST', path: '/requests', token: c.tokens.ada,
        body: { payer_handle: 'bob', amount: 100 },
        altBody: { payer_handle: 'bob', amount: 101 },
        invalidBody: { payer_handle: 'bob', amount: 0 },
      };
    },
  },
  {
    name: 'POST /requests/{id}/pay',
    async prepare(t, c) {
      const id = await pendingRequestFrom(t, c, 'ada', 'bob', 100);
      if (!id) return null;
      return {
        method: 'POST', path: `/requests/${id}/pay`, token: c.tokens.bob,
        body: {},
        altBody: { visibility: 'public' },
        invalidBody: { visibility: 'not-a-visibility' },
      };
    },
  },
  {
    name: 'POST /splits',
    async prepare(t, c) {
      return {
        method: 'POST', path: '/splits', token: c.tokens.ada,
        body: { amount: 100, participant_handles: ['ada', 'bob'] },
        altBody: { amount: 101, participant_handles: ['ada', 'bob'] },
        invalidBody: { amount: 100, participant_handles: ['ada', 'ada'] },
      };
    },
  },
  {
    name: 'POST /settlements',
    async prepare(t, c) {
      return {
        method: 'POST', path: '/settlements', token: c.tokens.op,
        body: { transfers: [{ from_handle: 'ada', to_handle: 'bob', amount: 100 }] },
        altBody: { transfers: [{ from_handle: 'ada', to_handle: 'bob', amount: 101 }] },
        invalidBody: { transfers: [] },
      };
    },
  },
];

// Every path, every clause: the loop is the point -- spec 7 says "everything below
// applies to each of them independently".
suite('05 idempotency', () => {
  test('an absent Idempotency-Key is 400 missing_idempotency_key', ['R7.1', 'R7.5', 'R5.3'], async (t) => {
    const c = await loginAll(t);
    for (const p of PATHS) {
      const s = await p.prepare(t, c);
      if (!s) continue;
      const res = await api(t, { method: s.method, path: s.path, token: s.token, body: s.body });
      t.err(res, 400, 'missing_idempotency_key', { ref: 'R7.5', what: `${p.name} with no Idempotency-Key header` });
    }
  });

  test('an empty Idempotency-Key is 400 missing_idempotency_key', ['R7.5'], async (t) => {
    const c = await loginAll(t);
    for (const p of PATHS) {
      const s = await p.prepare(t, c);
      if (!s) continue;
      const res = await api(t, { method: s.method, path: s.path, token: s.token, body: s.body, idemKey: '' });
      t.err(res, 400, 'missing_idempotency_key', { ref: 'R7.5', what: `${p.name} with an empty Idempotency-Key` });
    }
  });

  test('a key of 1 and of 255 characters is accepted', ['R7.2', 'R5.13'], async (t) => {
    const c = await loginAll(t);
    for (const p of PATHS) {
      for (const [label, k] of [['1 character', 'a'], ['255 characters', 'k'.repeat(255)]]) {
        const s = await p.prepare(t, c);
        if (!s) continue;
        const res = await api(t, { method: s.method, path: s.path, token: s.token, body: s.body, idemKey: k });
        t.status(res, 201, { ref: 'R7.2', what: `${p.name} with a key of ${label}` });
      }
    }
  });

  // The unit in which an Idempotency-Key is counted is not observable over HTTP. A header
  // value carries octets, and a character outside ASCII cannot be sent raw at all, so for
  // every key a client can actually transmit, code points, UTF-16 units and bytes coincide.
  // The boundary checks below are therefore the whole of the testable rule.
  test('a key of 256 characters is 422 validation_failed', ['R5.13', 'D20'], async (t) => {
    const c = await loginAll(t);
    for (const p of PATHS) {
      const s = await p.prepare(t, c);
      if (!s) continue;
      const res = await api(t, { method: s.method, path: s.path, token: s.token, body: s.body, idemKey: 'k'.repeat(256) });
      t.err(res, 422, 'validation_failed', { ref: 'R5.13', what: `${p.name} with a 256-character key` });
    }
  });

  test('first use returns 201 and a replay of the same body returns 200 with the identical value', ['R7.6', 'R7.7'], async (t) => {
    const c = await loginAll(t);
    for (const p of PATHS) {
      const s = await p.prepare(t, c);
      if (!s) continue;
      const k = key('replay');
      const first = await api(t, { method: s.method, path: s.path, token: s.token, body: s.body, idemKey: k });
      if (!t.status(first, 201, { ref: 'R7.6', what: `${p.name} first use` })) continue;
      const before = await signature(t, c);
      const again = await api(t, { method: s.method, path: s.path, token: s.token, body: s.body, idemKey: k });
      t.status(again, 200, { ref: 'R7.7', what: `${p.name} replay` });
      t.deep(again.json, first.json, { ref: 'R7.7', what: `${p.name} replay body`, res: again });
      t.eq(await signature(t, c), before, { ref: 'R7.12', what: `${p.name} state after a replay` });
    }
  });

  test('a replay is recognised across key order and whitespace', ['R7.10'], async (t) => {
    const c = await loginAll(t);
    for (const p of PATHS) {
      const s = await p.prepare(t, c);
      if (!s) continue;
      const k = key('shape');
      const first = await api(t, { method: s.method, path: s.path, token: s.token, body: s.body, idemKey: k });
      if (!t.status(first, 201, { ref: 'R7.6', what: `${p.name} first use` })) continue;

      const reordered = Object.fromEntries(Object.entries(s.body).reverse());
      const spaced = Object.keys(reordered).length
        ? JSON.stringify(reordered, null, 4).replace(/\n/g, '\n  ')
        : '{\n   \n}';
      const again = await api(t, { method: s.method, path: s.path, token: s.token, rawBody: spaced, idemKey: k });
      t.status(again, 200, { ref: 'R7.10', what: `${p.name} replay with reordered keys and added whitespace` });
      t.deep(again.json, first.json, { ref: 'R7.10', what: `${p.name} replay body`, res: again });
    }
  });

  test('the same key with a different body is 409 idempotency_key_reuse', ['R7.8', 'R5.7'], async (t) => {
    const c = await loginAll(t);
    for (const p of PATHS) {
      const s = await p.prepare(t, c);
      if (!s) continue;
      const k = key('reuse');
      const first = await api(t, { method: s.method, path: s.path, token: s.token, body: s.body, idemKey: k });
      if (!t.status(first, 201, { ref: 'R7.6', what: `${p.name} first use` })) continue;
      const before = await signature(t, c);
      const clash = await api(t, { method: s.method, path: s.path, token: s.token, body: s.altBody, idemKey: k });
      t.err(clash, 409, 'idempotency_key_reuse', { ref: 'R7.8', what: `${p.name} same key, different body` });
      t.eq(await signature(t, c), before, { ref: 'R7.8', what: `${p.name} state after a rejected reuse` });
    }
  });

  test('an already claimed key resolves before endpoint field validation', ['R7.13'], async (t) => {
    const c = await loginAll(t);
    for (const p of PATHS) {
      const s = await p.prepare(t, c);
      if (!s) continue;
      const k = key('r713');
      const first = await api(t, { method: s.method, path: s.path, token: s.token, body: s.body, idemKey: k });
      if (!t.status(first, 201, { ref: 'R7.6', what: `${p.name} first use` })) continue;
      const invalid = await api(t, { method: s.method, path: s.path, token: s.token, body: s.invalidBody, idemKey: k });
      t.err(invalid, 409, 'idempotency_key_reuse', {
        ref: 'R7.13', what: `${p.name} replaying a claimed key with a body that would fail validation`,
      });
    }
  });

  test('an already claimed key resolves before the unknown-handle lookup', ['R7.13'], async (t) => {
    const c = await loginAll(t);
    const cases = [
      ['POST /payments', 'POST', '/payments', 'ada', { to_handle: 'bob', amount: 100 }, { to_handle: 'nobody', amount: 100 }],
      ['POST /requests', 'POST', '/requests', 'ada', { payer_handle: 'bob', amount: 100 }, { payer_handle: 'nobody', amount: 100 }],
      ['POST /splits', 'POST', '/splits', 'ada', { amount: 10, participant_handles: ['ada', 'bob'] }, { amount: 10, participant_handles: ['ada', 'nobody'] }],
      ['POST /settlements', 'POST', '/settlements', 'op', { transfers: [{ from_handle: 'ada', to_handle: 'bob', amount: 10 }] }, { transfers: [{ from_handle: 'ada', to_handle: 'nobody', amount: 10 }] }],
    ];
    for (const [name, method, path, who, good, bad] of cases) {
      const k = key('r713b');
      const first = await api(t, { method, path, token: c.tokens[who], body: good, idemKey: k });
      if (!t.status(first, 201, { ref: 'R7.6', what: `${name} first use` })) continue;
      const res = await api(t, { method, path, token: c.tokens[who], body: bad, idemKey: k });
      t.err(res, 409, 'idempotency_key_reuse', {
        ref: 'R7.13', what: `${name} replaying a claimed key with an unknown handle in the body`,
      });
    }
  });

  test('an already claimed key resolves before the current-resource check', ['R7.13', 'R8.19'], async (t) => {
    const c = await loginAll(t);
    const id = await pendingRequestFrom(t, c, 'ada', 'bob', 100);
    if (!id) return;
    const k = key('paid');
    const first = await api(t, { method: 'POST', path: `/requests/${id}/pay`, token: c.tokens.bob, body: {}, idemKey: k });
    if (!t.status(first, 201, { ref: 'R8.17', what: 'paying a pending request' })) return;

    // The request is now paid. A replay must return the original payment, never 409 request_not_pending.
    const replay = await api(t, { method: 'POST', path: `/requests/${id}/pay`, token: c.tokens.bob, body: {}, idemKey: k });
    t.status(replay, 200, { ref: 'R8.19', what: 'replaying the pay of an already paid request' });
    t.deep(replay.json, first.json, { ref: 'R8.19', what: 'the replayed payment body', res: replay });

    // And the same claimed key with a different body is the key conflict, not the resource state.
    const clash = await api(t, { method: 'POST', path: `/requests/${id}/pay`, token: c.tokens.bob, body: { visibility: 'private' }, idemKey: k });
    t.err(clash, 409, 'idempotency_key_reuse', {
      ref: 'R7.13', what: 'a claimed key with a different body against an already paid request',
    });
  });

  test('{} and {"visibility":"public"} are different bodies on the pay path', ['R8.16'], async (t) => {
    const c = await loginAll(t);
    const id = await pendingRequestFrom(t, c, 'ada', 'bob', 100);
    if (!id) return;
    const k = key('bodies');
    const first = await api(t, { method: 'POST', path: `/requests/${id}/pay`, token: c.tokens.bob, body: {}, idemKey: k });
    if (!t.status(first, 201, { ref: 'R8.17', what: 'pay with an empty body' })) return;
    const clash = await api(t, { method: 'POST', path: `/requests/${id}/pay`, token: c.tokens.bob, body: { visibility: 'public' }, idemKey: k });
    t.err(clash, 409, 'idempotency_key_reuse', {
      ref: 'R8.16', what: 'the same key with {"visibility":"public"} after {}',
    });
  });

  test('a key is scoped to the authenticated user', ['R7.3'], async (t) => {
    const c = await loginAll(t);
    const shared = key('shared');
    const cases = [
      ['POST /payments', 'POST', '/payments', ['ada', 'bob'], { to_handle: 'cy', amount: 100 }],
      ['POST /requests', 'POST', '/requests', ['ada', 'bob'], { payer_handle: 'cy', amount: 100 }],
      ['POST /splits', 'POST', '/splits', ['ada', 'bob'], { amount: 100, participant_handles: ['cy', 'dee'] }],
      ['POST /settlements', 'POST', '/settlements', ['op', 'op2'], { transfers: [{ from_handle: 'ada', to_handle: 'bob', amount: 100 }] }],
    ];
    for (const [name, method, path, [who1, who2], body] of cases) {
      const a = await api(t, { method, path, token: c.tokens[who1], body, idemKey: shared });
      t.status(a, 201, { ref: 'R7.3', what: `${name} as ${who1} with the shared key` });
      const b = await api(t, { method, path, token: c.tokens[who2], body, idemKey: shared });
      t.status(b, 201, { ref: 'R7.3', what: `${name} as ${who2} with the same key string` });
      if (a.json && b.json) {
        const idField = Object.keys(a.json).find((f) => f.endsWith('_id') && a.json[f]);
        if (idField) {
          t.ok(a.json[idField] !== b.json[idField], {
            ref: 'R7.3', what: `${name} produced two independent resources`, res: b,
            expected: 'two different resource ids',
            actual: `both are ${JSON.stringify(a.json[idField])}`,
          });
        }
      }
    }
  });

  test('the same key and body on a different path is a different request', ['R7.4'], async (t) => {
    const c = await loginAll(t);
    // Unknown fields are ignored, so one body is valid on both paths (spec 3.4).
    const body = { to_handle: 'bob', payer_handle: 'bob', amount: 100 };
    const k = key('crosspath');
    const payment = await api(t, { method: 'POST', path: '/payments', token: c.tokens.ada, body, idemKey: k });
    t.status(payment, 201, { ref: 'R7.4', what: 'POST /payments with the shared key' });
    const request = await api(t, { method: 'POST', path: '/requests', token: c.tokens.ada, body, idemKey: k });
    t.status(request, 201, { ref: 'R7.4', what: 'POST /requests with the same key and the same body' });

    // Two different {id} paths under the same collection are also different paths.
    const r1 = await pendingRequestFrom(t, c, 'ada', 'bob', 10);
    const r2 = await pendingRequestFrom(t, c, 'ada', 'bob', 20);
    if (!r1 || !r2) return;
    const k2 = key('crosspay');
    const p1 = await api(t, { method: 'POST', path: `/requests/${r1}/pay`, token: c.tokens.bob, body: {}, idemKey: k2 });
    t.status(p1, 201, { ref: 'R7.4', what: 'paying the first request' });
    const p2 = await api(t, { method: 'POST', path: `/requests/${r2}/pay`, token: c.tokens.bob, body: {}, idemKey: k2 });
    t.status(p2, 201, { ref: 'R7.4', what: 'paying a different request with the same key and body' });
  });

  test('a key used by a request that failed with 4xx is free again', ['R7.9'], async (t) => {
    const c = await loginAll(t);
    const cases = [
      ['a 422 validation failure', 'POST', '/payments', 'ada', { to_handle: 'bob', amount: 0 }, 422, { to_handle: 'bob', amount: 100 }],
      ['a 404 unknown handle', 'POST', '/payments', 'ada', { to_handle: 'nobody', amount: 100 }, 404, { to_handle: 'bob', amount: 100 }],
      ['a 409 insufficient funds', 'POST', '/payments', 'dee', { to_handle: 'bob', amount: 101 }, 409, { to_handle: 'bob', amount: 50 }],
      ['a 422 self payment', 'POST', '/payments', 'ada', { to_handle: 'ada', amount: 100 }, 422, { to_handle: 'bob', amount: 100 }],
      ['a 422 duplicate participant', 'POST', '/splits', 'ada', { amount: 10, participant_handles: ['bob', 'bob'] }, 422, { amount: 10, participant_handles: ['ada', 'bob'] }],
      ['a 409 collectively unaffordable settlement', 'POST', '/settlements', 'op', { transfers: [{ from_handle: 'cy', to_handle: 'bob', amount: 5 }] }, 409, { transfers: [{ from_handle: 'ada', to_handle: 'bob', amount: 5 }] }],
    ];
    for (const [label, method, path, who, failBody, failStatus, okBody] of cases) {
      const k = key('after4xx');
      const failed = await api(t, { method, path, token: c.tokens[who], body: failBody, idemKey: k });
      if (!t.status(failed, failStatus, { ref: 'R7.9', what: `${path} ${label}` })) continue;
      const reused = await api(t, { method, path, token: c.tokens[who], body: okBody, idemKey: k });
      // The retry body differs from the failed one; if the key had been claimed this
      // would be 409. It must instead be treated as a first use.
      t.status(reused, 201, {
        ref: 'R7.9', what: `${path} reusing the key after ${label} (expecting a fresh first use)`,
      });
      t.ok(!(reused.json && reused.json.error && reused.json.error.code === 'idempotency_key_reuse'), {
        ref: 'R7.9', what: `${path} the key after ${label}`, res: reused,
        expected: 'the key treated as unused', actual: '409 idempotency_key_reuse',
      });
    }
  });

  test('a successful replay still returns the original response after the resource changes', ['R7.12'], async (t) => {
    const c = await loginAll(t);

    // A request that has since been cancelled still replays as it was created.
    const k = key('changed');
    const created = await api(t, { method: 'POST', path: '/requests', token: c.tokens.ada, body: { payer_handle: 'bob', amount: 100 }, idemKey: k });
    if (!t.status(created, 201, { ref: 'R8.12', what: 'POST /requests' })) return;
    const cancel = await api(t, { method: 'POST', path: `/requests/${created.json.request_id}/cancel`, token: c.tokens.ada, body: {} });
    if (!t.status(cancel, 200, { ref: 'R8.21', what: 'cancelling it' })) return;
    t.eq(cancel.json.status, 'cancelled', { ref: 'R8.21', what: 'status after cancel', res: cancel });

    const replay = await api(t, { method: 'POST', path: '/requests', token: c.tokens.ada, body: { payer_handle: 'bob', amount: 100 }, idemKey: k });
    t.status(replay, 200, { ref: 'R7.12', what: 'replaying the create of a cancelled request' });
    t.deep(replay.json, created.json, {
      ref: 'R7.12', what: 'the replay returns the original response, including status "pending"', res: replay,
    });

    // The replay must not resurrect it either.
    const after = await api(t, { path: '/requests', token: c.tokens.ada, query: { limit: 200 } });
    const live = ((after.json || {}).requests || []).find((r) => r.request_id === created.json.request_id);
    t.eq(live && live.status, 'cancelled', {
      ref: 'R7.12', what: 'the live request status after the replay', res: after,
    });
  });

  test('concurrent identical requests apply once: exactly one 201, the rest 200', ['R7.11'], async (t) => {
    const c = await loginAll(t);
    const N = 10;
    for (const p of PATHS) {
      const s = await p.prepare(t, c);
      if (!s) continue;
      const before = await signature(t, c);
      const k = key('race');
      const all = await concurrently(N, () =>
        api(t, { method: s.method, path: s.path, token: s.token, body: s.body, idemKey: k }));
      const created = all.filter((r) => r.status === 201);
      const replayed = all.filter((r) => r.status === 200);
      t.eq(created.length, 1, {
        ref: 'R7.11', what: `${p.name}: ${N} concurrent identical requests`,
        expected: 'exactly one HTTP 201',
        actual: `${created.length} created; statuses ${describeStatuses(all)}`,
      });
      t.eq(replayed.length, N - 1, {
        ref: 'R7.11', what: `${p.name}: the other ${N - 1} responses`,
        expected: `${N - 1} responses with HTTP 200`,
        actual: `statuses ${describeStatuses(all)}`,
      });
      if (created.length === 1) {
        const canonical = created[0].json;
        const mismatch = replayed.filter((r) => !deepEqual(r.json, canonical));
        t.eq(mismatch.length, 0, {
          ref: 'R7.11', what: `${p.name}: every replay body equals the created one`,
          expected: 'all replay bodies identical to the 201 body',
          actual: mismatch.length ? `${mismatch.length} differ; first: ${mismatch[0].text}` : 'none',
        });
      }
      const after = await signature(t, c);
      t.ok(after !== before || created.length === 0, {
        ref: 'R7.11', what: `${p.name}: the operation had an effect`,
        expected: 'state changed exactly once',
        actual: `unchanged (${after})`,
      });
    }
  }, { slow: true });

  test('concurrent requests with different keys each take effect once', ['R7.11', 'R1.7'], async (t) => {
    const c = await loginAll(t);
    const N = 8;
    const before = await balance(t, c.tokens.ada);
    const all = await concurrently(N, () =>
      api(t, { method: 'POST', path: '/payments', token: c.tokens.ada, body: { to_handle: 'bob', amount: 10 }, idemKey: key('distinct') }));
    const created = all.filter((r) => r.status === 201);
    t.eq(created.length, N, {
      ref: 'R7.11', what: `${N} concurrent payments with ${N} distinct keys`,
      expected: `${N} responses with HTTP 201`, actual: describeStatuses(all),
    });
    const ids = new Set(created.map((r) => r.json.payment_id));
    t.eq(ids.size, created.length, {
      ref: 'R7.11', what: 'distinct keys produce distinct payments',
      expected: `${created.length} distinct payment ids`, actual: `${ids.size} distinct`,
    });
    t.eq(await balance(t, c.tokens.ada), before - 10 * N, {
      ref: 'R1.7', what: 'the sender balance reflects each payment exactly once',
    });
  }, { slow: true });
});
