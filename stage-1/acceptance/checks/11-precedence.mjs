// Specification 5: which status and code wins when two error conditions apply at once.
//
// Where the specification settles the order, the check is blocking. Where it does not,
// the check is advisory and names the reading it is testing. In every case the blocking
// floor is that the answer is a documented 4xx with the spec-5 envelope and that no
// money moves -- which the global invariants and the balance assertions here enforce.

import { suite, test } from '../lib/runner.mjs';
import { api, loginAll, balance, sumBalances, key } from '../lib/helpers.mjs';
import { seededTotal } from '../lib/runner.mjs';

suite('11 error precedence', () => {
  test('an unresolvable recipient beats a balance the caller does not have', ['R8.9', 'R8.4'], async (t) => {
    const c = await loginAll(t);
    const res = await api(t, { method: 'POST', path: '/payments', token: c.tokens.cy, idemKey: key('pr'), body: { to_handle: 'nobody', amount: 1000000 } });
    t.err(res, 404, 'not_found', {
      ref: 'R8.9', what: 'a wallet holding 0 paying 1000000 to a handle that does not exist',
    });
  });

  test('a body of the wrong JSON type beats every later check', ['R5.12'], async (t) => {
    const c = await loginAll(t);
    // to_handle is the wrong type and the amount is also invalid and the wallet is empty.
    const res = await api(t, {
      method: 'POST', path: '/payments', token: c.tokens.cy, idemKey: key('pr'),
      rawBody: '{"to_handle":7,"amount":0}',
    });
    t.err(res, 400, 'malformed_request', {
      ref: 'R5.12', what: 'a wrongly typed to_handle together with an invalid amount',
    });
  });

  test('an unparseable body beats a missing idempotency key', ['R5.2', 'D14'], async (t) => {
    const c = await loginAll(t);
    const res = await api(t, { method: 'POST', path: '/payments', token: c.tokens.ada, rawBody: '{"to_handle":' });
    t.err(res, 400, 'malformed_request', {
      ref: 'R5.2', what: 'an unparseable body with no Idempotency-Key header',
    });
  }, {
    severity: 'advisory',
    why: 'Both conditions map to 400. spec 7 says key resolution happens after the body has parsed, '
       + 'which implies the parse error is reported first, but the two codes are not ordered '
       + 'explicitly. Decision D14 parses first.',
  });

  test('an unparseable body beats a missing token', ['R5.2'], async (t) => {
    const res = await api(t, { method: 'POST', path: '/payments', rawBody: '{"to_handle":' });
    t.err(res, 400, 'malformed_request', { ref: 'R5.2', what: 'an unparseable body with no token' });
  }, {
    severity: 'advisory',
    why: 'spec 7 places both parsing and authentication before key resolution but does not order '
       + 'them against each other. Decision D14 parses first; answering 401 first is equally '
       + 'consistent with the text.',
  });

  test('a missing idempotency key beats endpoint field validation', ['R7.5', 'D14'], async (t) => {
    const c = await loginAll(t);
    const res = await api(t, { method: 'POST', path: '/payments', token: c.tokens.ada, body: { to_handle: 'nobody', amount: 0 } });
    t.err(res, 400, 'missing_idempotency_key', {
      ref: 'R7.5', what: 'no Idempotency-Key together with an invalid amount and an unknown handle',
    });
  }, {
    severity: 'advisory',
    why: 'spec 7 states the missing-key 400 unconditionally for these paths but does not order it '
       + 'against endpoint field validation. Decision D14 checks the key first.',
  });

  test('an over-long idempotency key beats endpoint field validation', ['R5.13', 'D14'], async (t) => {
    const c = await loginAll(t);
    const res = await api(t, {
      method: 'POST', path: '/payments', token: c.tokens.ada, idemKey: 'k'.repeat(256),
      body: { to_handle: 'nobody', amount: 5 },
    });
    t.err(res, 422, 'validation_failed', {
      ref: 'R5.13', what: 'a 256-character key together with an unknown handle',
    });
  }, {
    severity: 'advisory',
    why: 'Both conditions are 4xx but with different statuses (422 against 404). spec 5 states the '
       + 'key range as a shared rule enforced on every endpoint that takes one; decision D14 '
       + 'evaluates it before endpoint validation.',
  });

  test('an unknown bearer token beats an invalid query parameter', ['R5.4'], async (t) => {
    const res = await api(t, { path: '/requests', token: 'not-a-token', query: { limit: '0' } });
    t.err(res, 401, 'unauthenticated', {
      ref: 'R5.4', what: 'an unknown token together with limit=0',
    });
  }, {
    severity: 'advisory',
    why: 'spec 5 lists both conditions without ordering them. Answering 401 before inspecting query '
       + 'parameters is the conventional reading and the one the rest of the suite assumes.',
  });

  test('a self payment beats a balance the caller does not have', ['R8.6'], async (t) => {
    const c = await loginAll(t);
    const res = await api(t, { method: 'POST', path: '/payments', token: c.tokens.cy, idemKey: key('pr'), body: { to_handle: 'cy', amount: 1000000 } });
    t.err(res, 422, 'self_payment', {
      ref: 'R8.6', what: 'a self payment of 1000000 from a wallet holding 0',
    });
  }, {
    severity: 'advisory',
    why: 'spec 8 lists insufficient_funds and self_payment in one table with no stated order. '
       + 'spec 11 does state that entry errors precede insufficient funds for a settlement, which '
       + 'is the same shape of decision.',
  });

  test('body field validation beats resource resolution', ['D22'], async (t) => {
    const c = await loginAll(t);
    const cases = [
      ['an amount of 0 with an unknown to_handle', '/payments', 'ada', { to_handle: 'nobody', amount: 0 }],
      ['a negative amount with an unknown to_handle', '/payments', 'ada', { to_handle: 'nobody', amount: -1 }],
      ['an over-maximum amount with an unknown to_handle', '/payments', 'ada', { to_handle: 'nobody', amount: 1000000001 }],
      ['a 201-character note with an unknown to_handle', '/payments', 'ada', { to_handle: 'nobody', amount: 10, note: 'x'.repeat(201) }],
      ['an invalid visibility with an unknown to_handle', '/payments', 'ada', { to_handle: 'nobody', amount: 10, visibility: 'loud' }],
      ['an amount of 0 with an unknown payer_handle', '/requests', 'ada', { payer_handle: 'nobody', amount: 0 }],
      ['a 201-character note with an unknown payer_handle', '/requests', 'ada', { payer_handle: 'nobody', amount: 10, note: 'x'.repeat(201) }],
      ['an amount of 0 with an unknown participant', '/splits', 'ada', { amount: 0, participant_handles: ['ada', 'nobody'] }],
    ];
    for (const [label, path, who, body] of cases) {
      const res = await api(t, { method: 'POST', path, token: c.tokens[who], idemKey: key('pr'), body });
      t.err(res, 422, 'validation_failed', { ref: 'D22', what: label });
    }
  }, {
    severity: 'advisory',
    why: 'Decision D22 fixes one chain: body field validation 422 before resource resolution 404. '
       + 'The specification orders neither, and the row order of its own error tables is not '
       + 'evidence either way -- the payments table lists 409 insufficient_funds first, which no '
       + 'reading treats as the highest precedence. 404 not_found is an equally documented answer '
       + 'to each of these requests.',
  });

  test('a duplicate participant beats an unknown participant', ['D22'], async (t) => {
    const c = await loginAll(t);
    for (const handles of [['ghost', 'ghost'], ['ada', 'ghost', 'ghost'], ['ghost', 'ghost', 'ada']]) {
      const res = await api(t, { method: 'POST', path: '/splits', token: c.tokens.ada, idemKey: key('pr'), body: { amount: 10, participant_handles: handles } });
      t.err(res, 422, 'validation_failed', {
        ref: 'D22', what: `participant_handles ${JSON.stringify(handles)}: a duplicate that is also unknown`,
      });
    }
  }, {
    severity: 'advisory',
    why: 'Decision D22 treats an array-internal check as field validation, so the duplicate is '
       + 'reported before the handles are looked up. 404 not_found is equally available: the '
       + 'handles genuinely do not exist.',
  });

  test('an invalid visibility beats a balance the caller does not have', ['R8.8'], async (t) => {
    const c = await loginAll(t);
    const res = await api(t, { method: 'POST', path: '/payments', token: c.tokens.cy, idemKey: key('pr'), body: { to_handle: 'bob', amount: 500, visibility: 'loud' } });
    t.err(res, 422, 'validation_failed', {
      ref: 'R8.8', what: 'an invalid visibility from a wallet that could not pay anyway',
    });
  }, {
    severity: 'advisory',
    why: 'Field validation before the funds check is the natural reading of spec 5, but spec 8 does '
       + 'not order the two rows of its table.',
  });

  test('the wrong caller on a settled request is 403, not the state error', ['D13'], async (t) => {
    const c = await loginAll(t);
    const rq = await api(t, { method: 'POST', path: '/requests', token: c.tokens.ada, idemKey: key('pr'), body: { payer_handle: 'bob', amount: 10 } });
    if (!t.status(rq, 201, { ref: 'R8.12', what: 'POST /requests' })) return;
    const id = rq.json.request_id;
    const paid = await api(t, { method: 'POST', path: `/requests/${id}/pay`, token: c.tokens.bob, idemKey: key('pr'), body: {} });
    if (!t.status(paid, 201, { ref: 'R8.17', what: 'pay it' })) return;

    // cy is neither party, and the request is no longer pending.
    const res = await api(t, { method: 'POST', path: `/requests/${id}/pay`, token: c.tokens.cy, idemKey: key('pr'), body: {} });
    t.err(res, 403, 'forbidden', {
      ref: 'D13', what: 'a third party paying a request that is already paid',
    });
    const dec = await api(t, { method: 'POST', path: `/requests/${id}/decline`, token: c.tokens.cy, body: {} });
    t.err(dec, 403, 'forbidden', { ref: 'D13', what: 'a third party declining an already paid request' });
    const can = await api(t, { method: 'POST', path: `/requests/${id}/cancel`, token: c.tokens.bob, body: {} });
    t.err(can, 403, 'forbidden', { ref: 'D13', what: 'the payer cancelling an already paid request' });
  }, {
    severity: 'advisory',
    why: 'Both 403 forbidden and 409 request_not_pending are documented for this call, and spec 5 '
       + 'also permits 404 for a resource not visible to the caller. Decision D13, and D22 step 7, '
       + 'put resource-level authorisation after resource resolution and before the state check.',
  });

  test('a terminal status beats a balance the payer does not have', ['D24', 'R8.18'], async (t) => {
    const c = await loginAll(t);
    // dee holds 100, so 5000 is unaffordable in every one of these cases. Each request
    // is driven into a different terminal status, then paid.
    const terminal = [
      ['declined', 'R8.20', async (id) => api(t, { method: 'POST', path: `/requests/${id}/decline`, token: c.tokens.dee, body: {} })],
      ['cancelled', 'R8.21', async (id) => api(t, { method: 'POST', path: `/requests/${id}/cancel`, token: c.tokens.ada, body: {} })],
    ];
    for (const [status, transitionRef, transition] of terminal) {
      const rq = await api(t, { method: 'POST', path: '/requests', token: c.tokens.ada, idemKey: key('pr'), body: { payer_handle: 'dee', amount: 5000 } });
      if (!t.status(rq, 201, { ref: 'R8.12', what: `a request dee cannot afford, to be ${status}` })) continue;
      const id = rq.json.request_id;
      const moved = await transition(id);
      if (!t.status(moved, 200, { ref: transitionRef, what: `driving it to ${status}` })) continue;
      const res = await api(t, { method: 'POST', path: `/requests/${id}/pay`, token: c.tokens.dee, idemKey: key('pr'), body: {} });
      t.err(res, 409, 'request_not_pending', {
        ref: 'D24', what: `paying a ${status} request that the payer could not afford either`,
      });
    }
    // And the paid case: a request already paid, retried by a payer now too short.
    const rq = await api(t, { method: 'POST', path: '/requests', token: c.tokens.ada, idemKey: key('pr'), body: { payer_handle: 'dee', amount: 100 } });
    if (!t.status(rq, 201, { ref: 'R8.12', what: 'a request dee can just afford' })) return;
    const first = await api(t, { method: 'POST', path: `/requests/${rq.json.request_id}/pay`, token: c.tokens.dee, idemKey: key('pr'), body: {} });
    if (!t.status(first, 201, { ref: 'R8.17', what: 'dee paying it, emptying the wallet' })) return;
    const again = await api(t, { method: 'POST', path: `/requests/${rq.json.request_id}/pay`, token: c.tokens.dee, idemKey: key('pr'), body: {} });
    t.err(again, 409, 'request_not_pending', {
      ref: 'D24', what: 'paying an already paid request under a fresh key, with the wallet now empty',
    });
  }, {
    severity: 'advisory',
    why: 'Decision D24. spec 8 lists request_not_pending and insufficient_funds in one table with '
       + 'no stated order. Reporting the status first is the reading that matches spec 4, which '
       + 'makes a terminal status final, and spec 1.9, which is a status rule rather than a funds '
       + 'rule; but the text does not settle it.',
  });

  test('body field validation beats resource resolution on the pay path too', ['D22'], async (t) => {
    const c = await loginAll(t);
    // An invalid visibility in the body and a request id that does not exist.
    const res = await api(t, {
      method: 'POST', path: '/requests/rq_no_such_thing/pay', token: c.tokens.bob,
      idemKey: key('pr'), body: { visibility: 'loud' },
    });
    t.err(res, 422, 'validation_failed', {
      ref: 'D22', what: 'an invalid visibility against an unknown request id',
    });
  }, {
    severity: 'advisory',
    why: 'Decision D22 places body field validation ahead of resource resolution. 404 not_found is '
       + 'an equally documented answer, since the request genuinely does not exist.',
  });

  test('an unknown request id beats a missing idempotency key', ['R8.18'], async (t) => {
    const c = await loginAll(t);
    const res = await api(t, { method: 'POST', path: '/requests/rq_no_such_thing/pay', token: c.tokens.bob, body: {} });
    t.oneOfErr(res, [[400, 'missing_idempotency_key'], [404, 'not_found']], {
      ref: 'R8.18', what: 'paying an unknown request with no Idempotency-Key header',
    });
  }, {
    severity: 'advisory',
    why: 'Both are documented answers and the specification orders neither. Decision D14 checks the '
       + 'key first, which gives 400.',
  });

  test('a non-operator is refused a malformed settlement without validating it', ['R11.3'], async (t) => {
    const c = await loginAll(t);
    const res = await api(t, { method: 'POST', path: '/settlements', token: c.tokens.ada, idemKey: key('pr'), body: { transfers: 'not an array' } });
    t.err(res, 403, 'forbidden', {
      ref: 'R11.3', what: 'a non-operator sending a malformed batch',
    });
  }, {
    severity: 'advisory',
    why: 'spec 11 names the operator gate and the malformed-shape 422 without ordering them. '
       + 'Decision D15 puts the permission check first, which also stops a non-operator from '
       + 'probing the endpoint.',
  });

  test('no precedence question ever moves money', ['R1.7', 'R1.8'], async (t) => {
    const c = await loginAll(t);
    const total = seededTotal('eur');
    const attempts = [
      ['POST', '/payments', 'cy', { to_handle: 'nobody', amount: 1000000 }],
      ['POST', '/payments', 'cy', { to_handle: 'cy', amount: 1000000 }],
      ['POST', '/payments', 'ada', { to_handle: 'nobody', amount: 0 }],
      ['POST', '/payments', 'cy', { to_handle: 'bob', amount: 500, visibility: 'loud' }],
      ['POST', '/payments', 'ada', { to_handle: 'nobody', amount: 10, note: 'x'.repeat(201) }],
      ['POST', '/splits', 'cy', { amount: 0, participant_handles: ['nobody'] }],
      ['POST', '/settlements', 'op', { transfers: [{ from_handle: 'cy', to_handle: 'nobody', amount: 1 }] }],
      ['POST', '/settlements', 'ada', { transfers: 'not an array' }],
    ];
    for (const [method, path, who, body] of attempts) {
      const res = await api(t, { method, path, token: c.tokens[who], idemKey: key('pr'), body });
      t.ok(res.status >= 400 && res.status < 500, {
        ref: 'R5.1', what: `${method} ${path} as ${who} with ${JSON.stringify(body)}`, res,
        expected: 'a 4xx status', actual: `HTTP ${res.status}`,
      });
    }
    t.eq(await sumBalances(t, c.tokens), total, { ref: 'R1.7', what: 'the total after every rejected attempt' });
    t.eq(await balance(t, c.tokens.cy), 0, { ref: 'R1.8', what: "cy's balance never went negative" });
  });
});
