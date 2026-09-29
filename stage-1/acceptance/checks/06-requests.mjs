// Specification 8: POST /requests, pay, decline, cancel and GET /requests.
// Specification 4: the request lifecycle and the "at most once" invariant of spec 1.

import { suite, test } from '../lib/runner.mjs';
import {
  api, reset, login, loginAll, balance, sumBalances, requests, activity,
  key, REQUEST_FIELDS, PAYMENT_FIELDS,
} from '../lib/helpers.mjs';
import { seededTotal } from '../lib/runner.mjs';

async function create(t, c, requester, payer, amount, note) {
  const body = { payer_handle: payer, amount };
  if (note !== undefined) body.note = note;
  const res = await api(t, { method: 'POST', path: '/requests', token: c.tokens[requester], idemKey: key('c'), body });
  return res;
}

// Newest first: each timestamp is at or before the one above it. Equal values are
// allowed -- the specification states no timestamp resolution.
function nonIncreasing(list, field) {
  for (let i = 1; i < list.length; i++) {
    const prev = Date.parse(list[i - 1][field]);
    const next = Date.parse(list[i][field]);
    if (!Number.isFinite(prev) || !Number.isFinite(next)) return false;
    if (prev < next) return false;
  }
  return true;
}

suite('06 requests', () => {
  test('a request returns the documented object with the caller as requester', ['R1.2', 'R8.12', 'R8.13'], async (t) => {
    const c = await loginAll(t);
    const res = await create(t, c, 'bob', 'ada', 1200, 'taxi');
    if (!t.status(res, 201, { ref: 'R8.13', what: 'POST /requests' })) return;
    t.fields(res.json, REQUEST_FIELDS, { ref: 'R8.13', what: 'request object', res });
    t.deep(
      {
        requester_id: res.json.requester_id, requester_handle: res.json.requester_handle,
        payer_id: res.json.payer_id, payer_handle: res.json.payer_handle,
        amount: res.json.amount, currency: res.json.currency, note: res.json.note,
        status: res.json.status, payment_id: res.json.payment_id,
      },
      {
        requester_id: 'u_bob', requester_handle: 'bob', payer_id: 'u_ada', payer_handle: 'ada',
        amount: 1200, currency: 'EUR', note: 'taxi', status: 'pending', payment_id: null,
      },
      { ref: 'R8.13', what: 'request field values', res },
    );
    t.eq(res.json.note, 'taxi', { ref: 'R8.12', what: 'note', res });
    const noNote = await create(t, c, 'bob', 'ada', 5);
    if (t.status(noNote, 201, { ref: 'R8.12', what: 'POST /requests with no note' })) {
      t.eq(noNote.json.note, '', { ref: 'R8.12', what: 'default note', res: noNote });
    }
  });

  test('creating a request never touches a balance', ['R8.15', 'R4.11'], async (t) => {
    const c = await loginAll(t);
    const before = await sumBalances(t, c.tokens);
    // cy holds 0 and is asked for far more than exists in the wallet.
    const res = await create(t, c, 'bob', 'cy', 1000000000, 'yacht');
    if (!t.status(res, 201, { ref: 'R8.15', what: 'requesting 1000000000 from a wallet holding 0' })) return;
    t.eq(res.json.status, 'pending', { ref: 'R4.11', what: 'the over-balance request is pending', res });
    t.eq(await balance(t, c.tokens.cy), 0, { ref: 'R8.15', what: 'payer balance after being asked' });
    t.eq(await balance(t, c.tokens.bob), 2500, { ref: 'R8.15', what: 'requester balance after asking' });
    t.eq(await sumBalances(t, c.tokens), before, { ref: 'R1.7', what: 'total after creating requests' });
  });

  test('request errors follow the documented table', ['R8.14'], async (t) => {
    const c = await loginAll(t);
    for (const literal of ['0', '-5', '1000000001', '1.5', '"100"', 'true', 'null']) {
      const res = await api(t, {
        method: 'POST', path: '/requests', token: c.tokens.ada, idemKey: key('rerr'),
        rawBody: `{"payer_handle":"bob","amount":${literal}}`,
      });
      t.err(res, 422, 'validation_failed', { ref: 'R8.14', what: `POST /requests with amount ${literal}` });
    }
    const self = await create(t, c, 'ada', 'ada', 100);
    t.err(self, 422, 'self_request', { ref: 'R8.14', what: 'requesting from your own handle' });
    const longNote = await create(t, c, 'ada', 'bob', 100, 'x'.repeat(201));
    t.err(longNote, 422, 'validation_failed', { ref: 'R8.14', what: 'a note of 201 characters' });
    const okNote = await create(t, c, 'ada', 'bob', 100, 'x'.repeat(200));
    t.status(okNote, 201, { ref: 'R8.14', what: 'a note of exactly 200 characters' });
    const unknown = await create(t, c, 'ada', 'nobody', 100);
    t.err(unknown, 404, 'not_found', { ref: 'R8.14', what: 'requesting from an unknown handle' });
    const missing = await api(t, { method: 'POST', path: '/requests', token: c.tokens.ada, idemKey: key('rerr'), body: { amount: 10 } });
    t.err(missing, 422, 'validation_failed', { ref: 'R5.8', what: 'POST /requests with no payer_handle' });
    const wrongType = await api(t, { method: 'POST', path: '/requests', token: c.tokens.ada, idemKey: key('rerr'), rawBody: '{"payer_handle":7,"amount":10}' });
    t.err(wrongType, 400, 'malformed_request', { ref: 'R5.2', what: 'POST /requests with a numeric payer_handle' });
    for (const literal of ['null', '5', 'true']) {
      const res = await api(t, {
        method: 'POST', path: '/requests', token: c.tokens.ada, idemKey: key('rerr'),
        rawBody: `{"payer_handle":"bob","amount":10,"note":${literal}}`,
      });
      t.err(res, 422, 'validation_failed', { ref: 'R5.10', what: `POST /requests with note ${literal}` });
    }
  });

  test('paying a request returns a payment and marks the request paid', ['R8.17'], async (t) => {
    const c = await loginAll(t);
    const rq = await create(t, c, 'ada', 'bob', 1000, 'split the cab');
    if (!t.status(rq, 201, { ref: 'R8.12', what: 'POST /requests' })) return;
    const id = rq.json.request_id;

    const paid = await api(t, { method: 'POST', path: `/requests/${id}/pay`, token: c.tokens.bob, idemKey: key('p'), body: {} });
    if (!t.status(paid, 201, { ref: 'R8.17', what: `POST /requests/${id}/pay` })) return;
    t.fields(paid.json, PAYMENT_FIELDS, { ref: 'R8.17', what: 'the payment returned by pay', res: paid });
    t.deep(
      {
        from_handle: paid.json.from_handle, to_handle: paid.json.to_handle,
        amount: paid.json.amount, note: paid.json.note,
        visibility: paid.json.visibility, request_id: paid.json.request_id,
      },
      {
        from_handle: 'bob', to_handle: 'ada', amount: 1000, note: 'split the cab',
        visibility: 'public', request_id: id,
      },
      { ref: 'R8.17', what: 'the payment created by paying a request', res: paid },
    );
    t.eq(await balance(t, c.tokens.bob), 1500, { ref: 'R8.17', what: 'payer balance after paying 1000' });
    t.eq(await balance(t, c.tokens.ada), 11000, { ref: 'R8.17', what: 'requester balance after being paid' });

    const list = await requests(t, c.tokens.ada, { limit: 200 });
    const after = ((list.json || {}).requests || []).find((r) => r.request_id === id);
    t.eq(after && after.status, 'paid', { ref: 'R8.17', what: 'the request status after payment', res: list });
    t.eq(after && after.payment_id, paid.json.payment_id, {
      ref: 'R8.17', what: 'the request carries the new payment_id', res: list,
    });
  });

  test('the payer chooses the visibility of the payment that settles a request', ['R4.12', 'R8.16'], async (t) => {
    const c = await loginAll(t);
    const rq = await create(t, c, 'ada', 'bob', 100);
    if (!t.status(rq, 201, { ref: 'R8.12', what: 'POST /requests' })) return;
    t.ok(!('visibility' in rq.json), {
      ref: 'R4.12', what: 'visibility on a request object', res: rq,
      expected: 'a request carries no visibility of its own',
      actual: `visibility: ${JSON.stringify(rq.json.visibility)}`,
    });
    const paid = await api(t, {
      method: 'POST', path: `/requests/${rq.json.request_id}/pay`, token: c.tokens.bob,
      idemKey: key('vis'), body: { visibility: 'private' },
    });
    if (!t.status(paid, 201, { ref: 'R8.16', what: 'pay with visibility private' })) return;
    t.eq(paid.json.visibility, 'private', { ref: 'R8.16', what: 'the payment visibility', res: paid });

    // The request itself never becomes a feed item for a third party.
    const third = await activity(t, c.tokens.cy, { limit: 200 });
    t.ok(!((third.json || {}).payments || []).some((p) => p.request_id === rq.json.request_id), {
      ref: 'R4.12', what: 'a private request-settling payment in a third party feed', res: third,
      expected: 'not visible to cy',
      actual: JSON.stringify((third.json || {}).payments),
    });
  });

  test('an invalid visibility on the pay path is 422', ['R8.8'], async (t) => {
    const c = await loginAll(t);
    const rq = await create(t, c, 'ada', 'bob', 100);
    if (!t.status(rq, 201, { ref: 'R8.12', what: 'POST /requests' })) return;
    for (const literal of ['"Public"', '"nope"', 'null', '3', '["public"]']) {
      const res = await api(t, {
        method: 'POST', path: `/requests/${rq.json.request_id}/pay`, token: c.tokens.bob,
        idemKey: key('badvis'), rawBody: `{"visibility":${literal}}`,
      });
      t.err(res, 422, 'validation_failed', { ref: 'R8.8', what: `pay with visibility ${literal}` });
    }
  });

  test('a short payer gets 409 insufficient_funds and the request stays payable', ['R4.11', 'R8.18'], async (t) => {
    const c = await loginAll(t);
    const rq = await create(t, c, 'bob', 'dee', 500); // dee holds 100
    if (!t.status(rq, 201, { ref: 'R8.12', what: 'POST /requests' })) return;
    const id = rq.json.request_id;
    const short = await api(t, { method: 'POST', path: `/requests/${id}/pay`, token: c.tokens.dee, idemKey: key('short'), body: {} });
    t.err(short, 409, 'insufficient_funds', { ref: 'R8.18', what: 'paying 500 from a wallet holding 100' });
    t.eq(await balance(t, c.tokens.dee), 100, { ref: 'R4.11', what: 'payer balance after the refusal' });
    t.eq(await balance(t, c.tokens.bob), 2500, { ref: 'R4.11', what: 'requester balance after the refusal' });

    const list = await requests(t, c.tokens.dee, { limit: 200 });
    const still = ((list.json || {}).requests || []).find((r) => r.request_id === id);
    t.eq(still && still.status, 'pending', {
      ref: 'R4.11', what: 'the request status after a refused payment', res: list,
    });

    // Money arrives later; the same request becomes payable.
    const topUp = await api(t, { method: 'POST', path: '/payments', token: c.tokens.rich, idemKey: key('top'), body: { to_handle: 'dee', amount: 400 } });
    if (!t.status(topUp, 201, { ref: 'R4.11', what: 'topping dee up to 500' })) return;
    const now = await api(t, { method: 'POST', path: `/requests/${id}/pay`, token: c.tokens.dee, idemKey: key('now'), body: {} });
    t.status(now, 201, { ref: 'R4.11', what: 'paying the same request once the money has arrived' });
    t.eq(await balance(t, c.tokens.dee), 0, { ref: 'R4.11', what: 'payer balance after paying' });
  });

  test('a request moves money at most once', ['R1.9'], async (t) => {
    const c = await loginAll(t);
    const rq = await create(t, c, 'ada', 'bob', 100);
    if (!t.status(rq, 201, { ref: 'R8.12', what: 'POST /requests' })) return;
    const id = rq.json.request_id;
    const first = await api(t, { method: 'POST', path: `/requests/${id}/pay`, token: c.tokens.bob, idemKey: key('once'), body: {} });
    if (!t.status(first, 201, { ref: 'R8.17', what: 'first pay' })) return;
    // A *different* key is a different request, not a replay: the resource is no longer pending.
    const second = await api(t, { method: 'POST', path: `/requests/${id}/pay`, token: c.tokens.bob, idemKey: key('once'), body: {} });
    t.err(second, 409, 'request_not_pending', {
      ref: 'R1.9', what: 'paying an already paid request under a fresh idempotency key',
    });
    t.eq(await balance(t, c.tokens.bob), 2400, { ref: 'R1.9', what: 'the payer balance moved exactly once' });
    t.eq(await balance(t, c.tokens.ada), 10100, { ref: 'R1.9', what: 'the requester balance moved exactly once' });
  });

  test('only the payer may pay; others get 403 and unknown ids get 404', ['R8.18', 'R5.5'], async (t) => {
    const c = await loginAll(t);
    const rq = await create(t, c, 'ada', 'bob', 100);
    if (!t.status(rq, 201, { ref: 'R8.12', what: 'POST /requests' })) return;
    const id = rq.json.request_id;
    for (const who of ['ada', 'cy', 'op']) {
      const res = await api(t, { method: 'POST', path: `/requests/${id}/pay`, token: c.tokens[who], idemKey: key('f'), body: {} });
      t.err(res, 403, 'forbidden', { ref: 'R8.18', what: `${who} paying a request whose payer is bob` });
    }
    const unknown = await api(t, { method: 'POST', path: '/requests/rq_does_not_exist/pay', token: c.tokens.bob, idemKey: key('f'), body: {} });
    t.err(unknown, 404, 'not_found', { ref: 'R8.18', what: 'paying an unknown request id' });
  });

  test('decline is the payer only, is idempotent by itself, and moves no money', ['R8.20'], async (t) => {
    const c = await loginAll(t);
    const rq = await create(t, c, 'ada', 'bob', 100);
    if (!t.status(rq, 201, { ref: 'R8.12', what: 'POST /requests' })) return;
    const id = rq.json.request_id;

    for (const who of ['ada', 'cy']) {
      const res = await api(t, { method: 'POST', path: `/requests/${id}/decline`, token: c.tokens[who], body: {} });
      t.err(res, 403, 'forbidden', { ref: 'R8.20', what: `${who} declining a request whose payer is bob` });
    }
    const unknown = await api(t, { method: 'POST', path: '/requests/rq_nope/decline', token: c.tokens.bob, body: {} });
    t.err(unknown, 404, 'not_found', { ref: 'R8.20', what: 'declining an unknown request id' });

    // No Idempotency-Key header at all.
    const first = await api(t, { method: 'POST', path: `/requests/${id}/decline`, token: c.tokens.bob, body: {} });
    if (!t.status(first, 200, { ref: 'R8.20', what: 'decline with no Idempotency-Key' })) return;
    t.fields(first.json, REQUEST_FIELDS, { ref: 'R8.20', what: 'the declined request object', res: first });
    t.eq(first.json.status, 'declined', { ref: 'R8.20', what: 'status after decline', res: first });
    t.eq(first.json.payment_id, null, { ref: 'R8.20', what: 'payment_id on a declined request', res: first });

    const twice = await api(t, { method: 'POST', path: `/requests/${id}/decline`, token: c.tokens.bob, body: {} });
    if (t.status(twice, 200, { ref: 'R8.20', what: 'declining an already declined request' })) {
      t.eq(twice.json.status, 'declined', { ref: 'R8.20', what: 'status after the second decline', res: twice });
    }
    t.eq(await balance(t, c.tokens.bob), 2500, { ref: 'R8.20', what: 'payer balance after declining' });
    t.eq(await balance(t, c.tokens.ada), 10000, { ref: 'R8.20', what: 'requester balance after declining' });

    // A declined request can no longer be paid or cancelled.
    const pay = await api(t, { method: 'POST', path: `/requests/${id}/pay`, token: c.tokens.bob, idemKey: key('d'), body: {} });
    t.err(pay, 409, 'request_not_pending', { ref: 'R8.18', what: 'paying a declined request' });
    const cancel = await api(t, { method: 'POST', path: `/requests/${id}/cancel`, token: c.tokens.ada, body: {} });
    t.err(cancel, 409, 'request_not_pending', { ref: 'R8.21', what: 'cancelling a declined request' });
  });

  test('cancel is the requester only, is idempotent by itself, and moves no money', ['R8.21'], async (t) => {
    const c = await loginAll(t);
    const rq = await create(t, c, 'ada', 'bob', 100);
    if (!t.status(rq, 201, { ref: 'R8.12', what: 'POST /requests' })) return;
    const id = rq.json.request_id;

    for (const who of ['bob', 'cy']) {
      const res = await api(t, { method: 'POST', path: `/requests/${id}/cancel`, token: c.tokens[who], body: {} });
      t.err(res, 403, 'forbidden', { ref: 'R8.21', what: `${who} cancelling a request whose requester is ada` });
    }
    const unknown = await api(t, { method: 'POST', path: '/requests/rq_nope/cancel', token: c.tokens.ada, body: {} });
    t.err(unknown, 404, 'not_found', { ref: 'R8.21', what: 'cancelling an unknown request id' });

    const first = await api(t, { method: 'POST', path: `/requests/${id}/cancel`, token: c.tokens.ada, body: {} });
    if (!t.status(first, 200, { ref: 'R8.21', what: 'cancel with no Idempotency-Key' })) return;
    t.eq(first.json.status, 'cancelled', { ref: 'R8.21', what: 'status after cancel', res: first });
    const twice = await api(t, { method: 'POST', path: `/requests/${id}/cancel`, token: c.tokens.ada, body: {} });
    if (t.status(twice, 200, { ref: 'R8.21', what: 'cancelling an already cancelled request' })) {
      t.eq(twice.json.status, 'cancelled', { ref: 'R8.21', what: 'status after the second cancel', res: twice });
    }
    t.eq(await balance(t, c.tokens.bob), 2500, { ref: 'R8.21', what: 'payer balance after cancellation' });

    const pay = await api(t, { method: 'POST', path: `/requests/${id}/pay`, token: c.tokens.bob, idemKey: key('cx'), body: {} });
    t.err(pay, 409, 'request_not_pending', { ref: 'R8.18', what: 'paying a cancelled request' });
    const decline = await api(t, { method: 'POST', path: `/requests/${id}/decline`, token: c.tokens.bob, body: {} });
    t.err(decline, 409, 'request_not_pending', { ref: 'R8.20', what: 'declining a cancelled request' });
  });

  test('a paid request can no longer be declined or cancelled', ['R8.20', 'R8.21'], async (t) => {
    const c = await loginAll(t);
    const rq = await create(t, c, 'ada', 'bob', 100);
    if (!t.status(rq, 201, { ref: 'R8.12', what: 'POST /requests' })) return;
    const id = rq.json.request_id;
    const paid = await api(t, { method: 'POST', path: `/requests/${id}/pay`, token: c.tokens.bob, idemKey: key('pp'), body: {} });
    if (!t.status(paid, 201, { ref: 'R8.17', what: 'pay' })) return;
    const decline = await api(t, { method: 'POST', path: `/requests/${id}/decline`, token: c.tokens.bob, body: {} });
    t.err(decline, 409, 'request_not_pending', { ref: 'R8.20', what: 'declining a paid request' });
    const cancel = await api(t, { method: 'POST', path: `/requests/${id}/cancel`, token: c.tokens.ada, body: {} });
    t.err(cancel, 409, 'request_not_pending', { ref: 'R8.21', what: 'cancelling a paid request' });
  });

  test('decline and cancel accept an Idempotency-Key header without requiring one', ['R3.4c'], async (t) => {
    const c = await loginAll(t);
    const a = await create(t, c, 'ada', 'bob', 100);
    const b = await create(t, c, 'ada', 'bob', 200);
    if (a.status !== 201 || b.status !== 201) return;
    const d = await api(t, { method: 'POST', path: `/requests/${a.json.request_id}/decline`, token: c.tokens.bob, idemKey: key('extra'), body: {} });
    t.status(d, 200, { ref: 'R3.4c', what: 'decline with an unnecessary Idempotency-Key' });
    const x = await api(t, { method: 'POST', path: `/requests/${b.json.request_id}/cancel`, token: c.tokens.ada, idemKey: key('extra'), body: {} });
    t.status(x, 200, { ref: 'R3.4c', what: 'cancel with an unnecessary Idempotency-Key' });
  }, {
    severity: 'advisory',
    why: 'The specification says these two paths take no idempotency key, and that unknown request '
       + 'fields are never an error, but it does not state what an unexpected header does. Ignoring '
       + 'it is the reading consistent with spec 3.4.',
  });

  test('GET /requests returns only requests where the caller is requester or payer', ['R8.22', 'R4.14', 'R8.27', 'R8.39'], async (t) => {
    const c = await loginAll(t);
    const res = await requests(t, c.tokens.cy, { limit: 200 });
    if (!t.status(res, 200, { ref: 'R8.22', what: 'GET /requests as cy' })) return;
    t.fields(res.json, ['requests', 'has_more'], { ref: 'R8.27', what: 'GET /requests body', res });
    const list = res.json.requests;
    // The eur fixture gives cy exactly one request (rq_over, where cy is payer).
    t.eq(list.length, 1, { ref: 'R8.22', what: "requests visible to cy", res });
    for (const r of list) {
      t.ok(r.requester_id === 'u_cy' || r.payer_id === 'u_cy', {
        ref: 'R8.22', what: 'a request visible to cy', res,
        expected: 'cy is requester or payer',
        actual: `requester ${r.requester_id}, payer ${r.payer_id}`,
      });
      t.fields(r, REQUEST_FIELDS, { ref: 'R8.13', what: 'a listed request object', res });
    }

    // A third party sees nothing of a request between two others.
    const rq = await create(t, c, 'ada', 'bob', 777);
    if (rq.status !== 201) return;
    const outsider = await requests(t, c.tokens.eve, { limit: 200 });
    t.ok(!((outsider.json || {}).requests || []).some((r) => r.request_id === rq.json.request_id), {
      ref: 'R8.22', what: "a request between ada and bob in eve's list", res: outsider,
      expected: 'not visible to eve',
      actual: JSON.stringify((outsider.json || {}).requests),
    });
  });

  test('requests never appear in the activity feed', ['R4.14'], async (t) => {
    const c = await loginAll(t);
    const rq = await create(t, c, 'ada', 'bob', 4242, 'never in a feed');
    if (rq.status !== 201) return;
    for (const who of ['ada', 'bob', 'cy']) {
      const feed = await activity(t, c.tokens[who], { limit: 200 });
      if (!t.status(feed, 200, { ref: 'R8.35', what: `GET /activity as ${who}` })) continue;
      t.ok(!(feed.json.payments || []).some((p) => p.amount === 4242 || p.note === 'never in a feed'), {
        ref: 'R4.14', what: `the pending request in ${who}'s feed`, res: feed,
        expected: 'no feed entry for a request',
        actual: JSON.stringify(feed.json.payments),
      });
      for (const p of feed.json.payments || []) {
        t.fields(p, PAYMENT_FIELDS, { ref: 'R8.35', what: 'a feed item is a payment object', res: feed });
      }
    }
  });

  test('direction and status filters select exactly what they name', ['R8.23', 'R8.24'], async (t) => {
    const c = await loginAll(t);
    // ada is requester on two and payer on one of the seeded requests; add known runtime ones.
    const out1 = await create(t, c, 'ada', 'bob', 11);
    const out2 = await create(t, c, 'ada', 'cy', 12);
    const in1 = await create(t, c, 'eve', 'ada', 13);
    if (out1.status !== 201 || out2.status !== 201 || in1.status !== 201) return;

    // Move one of each into a terminal state.
    await api(t, { method: 'POST', path: `/requests/${out2.json.request_id}/cancel`, token: c.tokens.ada, body: {} });
    await api(t, { method: 'POST', path: `/requests/${in1.json.request_id}/decline`, token: c.tokens.ada, body: {} });
    const payable = await create(t, c, 'eve', 'ada', 14);
    if (payable.status !== 201) return;
    await api(t, { method: 'POST', path: `/requests/${payable.json.request_id}/pay`, token: c.tokens.ada, idemKey: key('flt'), body: {} });

    const all = await requests(t, c.tokens.ada, { limit: 200 });
    if (!t.status(all, 200, { ref: 'R8.22', what: 'GET /requests with no filter' })) return;
    const total = all.json.requests;

    const outgoing = await requests(t, c.tokens.ada, { direction: 'outgoing', limit: 200 });
    if (t.status(outgoing, 200, { ref: 'R8.23', what: 'direction=outgoing' })) {
      const bad = outgoing.json.requests.filter((r) => r.requester_id !== 'u_ada');
      t.eq(bad.length, 0, {
        ref: 'R8.23', what: 'direction=outgoing returns only requests ada raised', res: outgoing,
        expected: 'every item has requester_id u_ada', actual: JSON.stringify(bad),
      });
      t.eq(outgoing.json.requests.length, total.filter((r) => r.requester_id === 'u_ada').length, {
        ref: 'R8.23', what: 'outgoing count', res: outgoing,
      });
    }

    const incoming = await requests(t, c.tokens.ada, { direction: 'incoming', limit: 200 });
    if (t.status(incoming, 200, { ref: 'R8.23', what: 'direction=incoming' })) {
      const bad = incoming.json.requests.filter((r) => r.payer_id !== 'u_ada');
      t.eq(bad.length, 0, {
        ref: 'R8.23', what: 'direction=incoming returns only requests ada is asked to pay', res: incoming,
        expected: 'every item has payer_id u_ada', actual: JSON.stringify(bad),
      });
      t.eq(incoming.json.requests.length, total.filter((r) => r.payer_id === 'u_ada').length, {
        ref: 'R8.23', what: 'incoming count', res: incoming,
      });
    }

    for (const status of ['pending', 'paid', 'declined', 'cancelled']) {
      const res = await requests(t, c.tokens.ada, { status, limit: 200 });
      if (!t.status(res, 200, { ref: 'R8.24', what: `status=${status}` })) continue;
      const bad = res.json.requests.filter((r) => r.status !== status);
      t.eq(bad.length, 0, {
        ref: 'R8.24', what: `status=${status} returns only that status`, res,
        expected: `every item has status ${status}`, actual: JSON.stringify(bad),
      });
      t.eq(res.json.requests.length, total.filter((r) => r.status === status).length, {
        ref: 'R8.24', what: `status=${status} count`, res,
      });
      t.ok(res.json.requests.length > 0, {
        ref: 'R8.24', what: `the scenario produced at least one ${status} request`, res,
        expected: 'at least one item', actual: '0 items',
      });
    }

    const combo = await requests(t, c.tokens.ada, { direction: 'outgoing', status: 'pending', limit: 200 });
    if (t.status(combo, 200, { ref: 'R8.24', what: 'direction and status together' })) {
      const bad = combo.json.requests.filter((r) => r.requester_id !== 'u_ada' || r.status !== 'pending');
      t.eq(bad.length, 0, {
        ref: 'R8.24', what: 'both filters applied', res: combo,
        expected: 'outgoing and pending only', actual: JSON.stringify(bad),
      });
    }
  });

  test('an unknown direction or status value is 422', ['R8.25'], async (t) => {
    const c = await loginAll(t);
    for (const direction of ['sideways', 'Incoming', 'INCOMING', '', 'incoming,outgoing']) {
      const res = await requests(t, c.tokens.ada, { direction });
      t.err(res, 422, 'validation_failed', { ref: 'R8.25', what: `direction=${JSON.stringify(direction)}` });
    }
    for (const status of ['weird', 'Pending', 'PAID', '', 'pending,paid']) {
      const res = await requests(t, c.tokens.ada, { status });
      t.err(res, 422, 'validation_failed', { ref: 'R8.25', what: `status=${JSON.stringify(status)}` });
    }
  });

  test('requests are ordered newest first', ['R8.22'], async (t) => {
    const c = await loginAll(t);
    for (let i = 0; i < 5; i++) {
      const r = await create(t, c, 'ada', 'bob', 100 + i, `order ${i}`);
      if (r.status !== 201) return;
    }
    const res = await requests(t, c.tokens.ada, { direction: 'outgoing', limit: 200 });
    if (!t.status(res, 200, { ref: 'R8.22', what: 'GET /requests?direction=outgoing' })) return;
    t.ok(nonIncreasing(res.json.requests, 'created_at'), {
      ref: 'R8.22', what: 'created_at order', res,
      expected: 'created_at non-increasing down the list',
      actual: JSON.stringify(res.json.requests.map((r) => r.created_at)),
    });
  });

  test('requests created in the same second are still ordered newest first', ['D9'], async (t) => {
    const c = await loginAll(t);
    const made = [];
    for (let i = 0; i < 5; i++) {
      const r = await create(t, c, 'ada', 'bob', 100 + i, `seq ${i}`);
      if (r.status !== 201) return;
      made.push(r.json.request_id);
    }
    const res = await requests(t, c.tokens.ada, { direction: 'outgoing', status: 'pending', limit: 200 });
    if (!t.status(res, 200, { ref: 'D9', what: 'GET /requests' })) return;
    const got = res.json.requests.map((r) => r.request_id).filter((id) => made.includes(id));
    t.deep(got, [...made].reverse(), {
      ref: 'D9', what: 'five requests created back to back, newest first', res,
    });
  }, {
    severity: 'advisory',
    why: 'spec 8 requires newest first by created_at but states no timestamp resolution, so five '
       + 'requests created in the same second may legitimately share a created_at. Decision D9 adds '
       + 'a creation-sequence tie-break. The blocking check is only that created_at is '
       + 'non-increasing.',
  });

  test('seeded requests are ordered by their position in the fixture array', ['D10'], async (t) => {
    const fx = await reset(t, 'eur');
    const ada = await login(t, 'ada@example.com');
    if (!ada) return;
    const res = await requests(t, ada.token, { limit: 200 });
    if (!t.status(res, 200, { ref: 'D10', what: 'GET /requests' })) return;
    const seededForAda = fx.requests.filter((r) => r.requester_id === 'u_ada' || r.payer_id === 'u_ada');
    const expectedAmounts = seededForAda.map((r) => r.amount).reverse();
    t.deep(res.json.requests.map((r) => r.amount), expectedAmounts, {
      ref: 'D10', what: 'seeded request order for ada (later in the fixture array is newer)', res,
    });
  }, {
    severity: 'advisory',
    why: 'The fixture carries no timestamps, so the order of seeded requests is not determined by '
       + 'the specification. Decision D10 assigns them in fixture-array order.',
  });

  test('limit, offset and has_more behave as specified', ['R8.25', 'R8.26', 'R5.11'], async (t) => {
    const c = await loginAll(t);
    for (let i = 0; i < 6; i++) {
      const r = await create(t, c, 'ada', 'bob', 200 + i, `page ${i}`);
      if (r.status !== 201) return;
    }
    const all = await requests(t, c.tokens.ada, { direction: 'outgoing', status: 'pending', limit: 200 });
    if (!t.status(all, 200, { ref: 'R8.25', what: 'the unpaged list' })) return;
    const n = all.json.requests.length;
    t.ok(n >= 6, {
      ref: 'R8.25', what: 'the scenario produced enough requests to page', res: all,
      expected: 'at least 6', actual: String(n),
    });
    t.eq(all.json.has_more, false, { ref: 'R8.26', what: 'has_more on a complete page', res: all });

    const first = await requests(t, c.tokens.ada, { direction: 'outgoing', status: 'pending', limit: 2, offset: 0 });
    if (t.status(first, 200, { ref: 'R8.25', what: 'limit=2&offset=0' })) {
      t.eq(first.json.requests.length, 2, { ref: 'R8.25', what: 'page size', res: first });
      t.eq(first.json.has_more, true, { ref: 'R8.26', what: 'has_more with items beyond the page', res: first });
      t.deep(first.json.requests.map((r) => r.request_id), all.json.requests.slice(0, 2).map((r) => r.request_id), {
        ref: 'R8.25', what: 'the first page matches the head of the full list', res: first,
      });
    }
    const last = await requests(t, c.tokens.ada, { direction: 'outgoing', status: 'pending', limit: 2, offset: n - 2 });
    if (t.status(last, 200, { ref: 'R8.25', what: `limit=2&offset=${n - 2}` })) {
      t.eq(last.json.has_more, false, { ref: 'R8.26', what: 'has_more on the final page', res: last });
    }
    const past = await requests(t, c.tokens.ada, { direction: 'outgoing', status: 'pending', limit: 2, offset: n + 10 });
    if (t.status(past, 200, { ref: 'R8.25', what: 'an offset past the end' })) {
      t.eq(past.json.requests.length, 0, { ref: 'R8.25', what: 'items past the end', res: past });
      t.eq(past.json.has_more, false, { ref: 'R8.26', what: 'has_more past the end', res: past });
    }
    const dflt = await requests(t, c.tokens.ada, {});
    if (t.status(dflt, 200, { ref: 'R8.25', what: 'no limit given' })) {
      t.ok(dflt.json.requests.length <= 50, {
        ref: 'R8.25', what: 'the default limit', res: dflt,
        expected: 'at most 50 items by default', actual: String(dflt.json.requests.length),
      });
    }
    for (const limit of [1, 200]) {
      const res = await requests(t, c.tokens.ada, { limit });
      t.status(res, 200, { ref: 'R8.25', what: `limit=${limit} (a boundary value)` });
    }
    for (const limit of ['0', '-1', '201', '1e2', '4.0', '+4', 'abc', '', ' 4', '0x10', 'null', '1_0']) {
      const res = await requests(t, c.tokens.ada, { limit });
      t.err(res, 422, 'validation_failed', { ref: 'R8.25', what: `limit=${JSON.stringify(limit)}` });
    }
    const zeroOffset = await requests(t, c.tokens.ada, { offset: 0 });
    t.status(zeroOffset, 200, { ref: 'R8.25', what: 'offset=0' });
    for (const offset of ['-1', '1e1', '2.0', '+2', 'abc', '']) {
      const res = await requests(t, c.tokens.ada, { offset });
      t.err(res, 422, 'validation_failed', { ref: 'R8.25', what: `offset=${JSON.stringify(offset)}` });
    }
  });

  test('a request lifecycle preserves the seeded total throughout', ['R1.7'], async (t) => {
    const c = await loginAll(t);
    const total = seededTotal('eur');
    const a = await create(t, c, 'ada', 'bob', 500);
    const b = await create(t, c, 'bob', 'ada', 600);
    const d = await create(t, c, 'eve', 'ada', 700);
    if (a.status !== 201 || b.status !== 201 || d.status !== 201) return;
    t.eq(await sumBalances(t, c.tokens), total, { ref: 'R1.7', what: 'total after three requests' });
    await api(t, { method: 'POST', path: `/requests/${a.json.request_id}/pay`, token: c.tokens.bob, idemKey: key('lc'), body: {} });
    t.eq(await sumBalances(t, c.tokens), total, { ref: 'R1.7', what: 'total after a payment' });
    await api(t, { method: 'POST', path: `/requests/${b.json.request_id}/decline`, token: c.tokens.ada, body: {} });
    t.eq(await sumBalances(t, c.tokens), total, { ref: 'R1.7', what: 'total after a decline' });
    await api(t, { method: 'POST', path: `/requests/${d.json.request_id}/cancel`, token: c.tokens.eve, body: {} });
    t.eq(await sumBalances(t, c.tokens), total, { ref: 'R1.7', what: 'total after a cancel' });
  });
});
