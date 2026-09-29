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

  test('an invalid amount beats an unknown recipient', ['R5.10'], async (t) => {
    const c = await loginAll(t);
    for (const body of [
      { to_handle: 'nobody', amount: 0 },
      { to_handle: 'nobody', amount: -1 },
      { to_handle: 'nobody', amount: 1000000001 },
    ]) {
      const res = await api(t, { method: 'POST', path: '/payments', token: c.tokens.ada, idemKey: key('pr'), body });
      t.oneOfErr(res, [[422, 'validation_failed'], [404, 'not_found']], {
        ref: 'R5.10', what: `amount ${body.amount} with an unknown to_handle`,
      });
    }
  }, {
    severity: 'advisory',
    why: 'spec 5 says endpoint-specific field rules take precedence, which points at 422 for the '
       + 'amount; spec 8 maps the unknown handle to 404. Both are documented answers for this '
       + 'request and the specification does not order them.',
  });

  test('an over-long note beats an unknown recipient', ['R8.7'], async (t) => {
    const c = await loginAll(t);
    const res = await api(t, { method: 'POST', path: '/payments', token: c.tokens.ada, idemKey: key('pr'), body: { to_handle: 'nobody', amount: 10, note: 'x'.repeat(201) } });
    t.oneOfErr(res, [[422, 'validation_failed'], [404, 'not_found']], {
      ref: 'R8.7', what: 'a 201-character note with an unknown to_handle',
    });
  }, {
    severity: 'advisory',
    why: 'As above: a field rule and a resource lookup both apply and the specification orders '
       + 'neither.',
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
       + 'also permits 404 for a resource not visible to the caller. Decision D13 puts the '
       + 'permission check first.',
  });

  test('a request not pending beats a balance the payer does not have', ['R8.18'], async (t) => {
    const c = await loginAll(t);
    const rq = await api(t, { method: 'POST', path: '/requests', token: c.tokens.ada, idemKey: key('pr'), body: { payer_handle: 'dee', amount: 5000 } });
    if (!t.status(rq, 201, { ref: 'R8.12', what: 'a request dee cannot afford' })) return;
    const id = rq.json.request_id;
    const declined = await api(t, { method: 'POST', path: `/requests/${id}/decline`, token: c.tokens.dee, body: {} });
    if (!t.status(declined, 200, { ref: 'R8.20', what: 'dee declining it' })) return;
    const res = await api(t, { method: 'POST', path: `/requests/${id}/pay`, token: c.tokens.dee, idemKey: key('pr'), body: {} });
    t.err(res, 409, 'request_not_pending', {
      ref: 'R8.18', what: 'paying a declined request that the payer could not afford either',
    });
  }, {
    severity: 'advisory',
    why: 'spec 8 lists request_not_pending and insufficient_funds in one table with no stated '
       + 'order. Reporting the lifecycle state first is the reading that matches spec 4, which '
       + 'makes the terminal state final.',
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
