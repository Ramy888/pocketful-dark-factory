// Specification 8 (POST /splits) and specification 9 (money and rounding).

import { suite, test, seededTotal } from '../lib/runner.mjs';
import {
  api, loginAll, balance, sumBalances, requests, activity,
  key, expectedShares, SPLIT_FIELDS, REQUEST_FIELDS,
} from '../lib/helpers.mjs';

async function doSplit(t, c, caller, body) {
  return api(t, { method: 'POST', path: '/splits', token: c.tokens[caller], idemKey: key('sp'), body });
}

suite('08 splits and rounding', () => {
  test('a split returns the documented object and one request per other participant', ['R1.3', 'R8.28', 'R8.29', 'R8.30', 'R8.31'], async (t) => {
    const c = await loginAll(t);
    const res = await doSplit(t, c, 'ada', { amount: 3000, participant_handles: ['ada', 'bob', 'cy'], note: 'dinner' });
    if (!t.status(res, 201, { ref: 'R8.30', what: 'POST /splits' })) return;
    t.fields(res.json, SPLIT_FIELDS, { ref: 'R8.30', what: 'split object', res });
    t.eq(res.json.amount, 3000, { ref: 'R8.30', what: 'amount', res });
    t.eq(res.json.currency, 'EUR', { ref: 'R8.30', what: 'currency', res });
    t.eq(res.json.note, 'dinner', { ref: 'R8.30', what: 'note', res });
    t.deep(res.json.shares, [
      { handle: 'ada', amount: 1000 }, { handle: 'bob', amount: 1000 }, { handle: 'cy', amount: 1000 },
    ], { ref: 'R8.31', what: 'shares including the caller, in the order given', res });
    t.eq(res.json.requests.length, 2, { ref: 'R8.31', what: 'one request per participant except the caller', res });
    t.deep(res.json.requests.map((r) => r.payer_handle), ['bob', 'cy'], {
      ref: 'R8.31', what: 'requests in participant order, caller excluded', res,
    });
    for (const r of res.json.requests) {
      t.fields(r, REQUEST_FIELDS, { ref: 'R8.13', what: 'a request inside the split response', res });
      t.eq(r.requester_handle, 'ada', { ref: 'R8.29', what: 'the caller is the requester', res });
      t.eq(r.status, 'pending', { ref: 'R8.29', what: 'the created request is pending', res });
      t.eq(r.amount, 1000, { ref: 'R8.29', what: `the share asked of ${r.payer_handle}`, res });
      t.eq(r.note, 'dinner', { ref: 'R8.29', what: 'the note carried onto the request', res });
    }
    // And they are real, readable requests.
    const list = await requests(t, c.tokens.bob, { direction: 'incoming', limit: 200 });
    t.ok(((list.json || {}).requests || []).some((r) => r.request_id === res.json.requests[0].request_id), {
      ref: 'R8.29', what: "the split's request in bob's incoming list", res: list,
      expected: 'present', actual: JSON.stringify((list.json || {}).requests),
    });
  });

  test('note defaults to "" on a split', ['R8.28'], async (t) => {
    const c = await loginAll(t);
    const res = await doSplit(t, c, 'ada', { amount: 10, participant_handles: ['ada', 'bob'] });
    if (!t.status(res, 201, { ref: 'R8.28', what: 'POST /splits with no note' })) return;
    t.eq(res.json.note, '', { ref: 'R8.28', what: 'default note', res });
    t.eq(res.json.requests[0].note, '', { ref: 'R8.29', what: 'default note on the created request', res });
  });

  test('the caller may be omitted from participant_handles', ['R8.28', 'R8.31'], async (t) => {
    const c = await loginAll(t);
    const res = await doSplit(t, c, 'ada', { amount: 10, participant_handles: ['bob', 'cy'] });
    if (!t.status(res, 201, { ref: 'R8.28', what: 'POST /splits with the caller omitted' })) return;
    t.deep(res.json.shares, [{ handle: 'bob', amount: 5 }, { handle: 'cy', amount: 5 }], {
      ref: 'R8.31', what: 'shares cover exactly the listed participants', res,
    });
    t.eq(res.json.requests.length, 2, {
      ref: 'R8.31', what: 'a request for each participant, none of whom is the caller', res,
    });
    t.deep(res.json.requests.map((r) => r.payer_handle), ['bob', 'cy'], {
      ref: 'R8.31', what: 'request order', res,
    });
  });

  test('the share table of specification 9 is reproduced exactly', ['R9.1', 'R9.2', 'R9.3'], async (t) => {
    const c = await loginAll(t);
    const table = [
      [1000, ['ada', 'bob', 'cy'], [334, 333, 333]],
      [1, ['ada', 'bob', 'cy'], [1, 0, 0]],
      [10, ['ada', 'bob', 'cy'], [4, 3, 3]],
      [999, ['ada', 'bob', 'cy'], [333, 333, 333]],
      [5, ['ada', 'bob', 'cy', 'dee', 'eve'], [1, 1, 1, 1, 1]],
    ];
    for (const [amount, handles, shares] of table) {
      const res = await doSplit(t, c, 'ada', { amount, participant_handles: handles });
      if (!t.status(res, 201, { ref: 'R9.3', what: `POST /splits amount=${amount} n=${handles.length}` })) continue;
      t.deep(res.json.shares, handles.map((h, i) => ({ handle: h, amount: shares[i] })), {
        ref: 'R9.3', what: `shares for amount ${amount} among ${handles.length}`, res,
      });
      const sum = res.json.shares.reduce((a, s) => a + s.amount, 0);
      t.eq(sum, amount, { ref: 'R9.1', what: `shares sum for amount ${amount}`, res });
      const values = res.json.shares.map((s) => s.amount);
      t.ok(Math.max(...values) - Math.min(...values) <= 1, {
        ref: 'R9.1', what: `share spread for amount ${amount}`, res,
        expected: 'shares differ by at most one minor unit', actual: JSON.stringify(values),
      });
      t.ok(values.every((v) => Number.isInteger(v)), {
        ref: 'R9.1', what: `whole minor units for amount ${amount}`, res,
        expected: 'every share an integer', actual: JSON.stringify(values),
      });
    }
  });

  test('the extra unit follows participant order', ['R9.2', 'R9.4'], async (t) => {
    const c = await loginAll(t);
    const orders = [
      ['ada', 'bob', 'cy'],
      ['bob', 'cy', 'ada'],
      ['cy', 'ada', 'bob'],
      ['cy', 'bob', 'ada'],
    ];
    for (const handles of orders) {
      const res = await doSplit(t, c, 'ada', { amount: 10, participant_handles: handles });
      if (!t.status(res, 201, { ref: 'R9.2', what: `POST /splits order ${handles.join(',')}` })) continue;
      t.deep(res.json.shares, [
        { handle: handles[0], amount: 4 },
        { handle: handles[1], amount: 3 },
        { handle: handles[2], amount: 3 },
      ], { ref: 'R9.2', what: `the extra unit goes to ${handles[0]}`, res });
      // The requests must carry the same per-participant amounts, caller excluded.
      const expectedRequests = handles
        .map((h, i) => ({ handle: h, amount: i === 0 ? 4 : 3 }))
        .filter((x) => x.handle !== 'ada');
      t.deep(res.json.requests.map((r) => ({ handle: r.payer_handle, amount: r.amount })), expectedRequests, {
        ref: 'R9.2', what: `requests for order ${handles.join(',')}`, res,
      });
    }
  });

  test('a share of 0 is legal and still creates a request', ['R9.4'], async (t) => {
    const c = await loginAll(t);
    const res = await doSplit(t, c, 'ada', { amount: 1, participant_handles: ['ada', 'bob', 'cy'] });
    if (!t.status(res, 201, { ref: 'R9.4', what: 'POST /splits amount=1 among 3' })) return;
    t.deep(res.json.shares.map((s) => s.amount), [1, 0, 0], { ref: 'R9.4', what: 'shares', res });
    t.eq(res.json.requests.length, 2, { ref: 'R9.4', what: 'two requests created despite zero shares', res });
    t.deep(res.json.requests.map((r) => r.amount), [0, 0], {
      ref: 'R9.4', what: 'each zero-share participant gets a request for 0', res,
    });
    const list = await requests(t, c.tokens.bob, { direction: 'incoming', limit: 200 });
    const found = ((list.json || {}).requests || []).find((r) => r.request_id === res.json.requests[0].request_id);
    t.eq(found && found.amount, 0, { ref: 'R9.4', what: 'the zero request is readable', res: list });
  });

  test('a split whose only participant is the caller creates no requests', ['R8.33'], async (t) => {
    const c = await loginAll(t);
    const res = await doSplit(t, c, 'ada', { amount: 1000, participant_handles: ['ada'] });
    if (!t.status(res, 201, { ref: 'R8.33', what: 'POST /splits with only the caller' })) return;
    t.deep(res.json.shares, [{ handle: 'ada', amount: 1000 }], { ref: 'R8.33', what: 'one share', res });
    t.deep(res.json.requests, [], { ref: 'R8.33', what: 'requests is an empty array', res });
  });

  test('nothing about a split checks a balance', ['R8.34'], async (t) => {
    const c = await loginAll(t);
    const before = await sumBalances(t, c.tokens);
    // cy holds 0 and splits the maximum amount among wallets that cannot pay either.
    const res = await doSplit(t, c, 'cy', { amount: 1000000000, participant_handles: ['cy', 'dee', 'eve'] });
    if (!t.status(res, 201, { ref: 'R8.34', what: 'a 1000000000 split by a wallet holding 0' })) return;
    t.deep(res.json.shares.map((s) => s.amount), expectedShares(1000000000, 3), {
      ref: 'R9.1', what: 'shares for 1000000000 among 3', res,
    });
    t.eq(await sumBalances(t, c.tokens), before, { ref: 'R8.34', what: 'no balance moved' });
    t.eq(await balance(t, c.tokens.cy), 0, { ref: 'R8.34', what: 'the caller balance' });
  });

  test('split errors follow the documented table', ['R8.32'], async (t) => {
    const c = await loginAll(t);
    for (const literal of ['0', '-1', '1000000001', '2.5', '"10"', 'true', 'null']) {
      const res = await api(t, {
        method: 'POST', path: '/splits', token: c.tokens.ada, idemKey: key('serr'),
        rawBody: `{"amount":${literal},"participant_handles":["ada","bob"]}`,
      });
      t.err(res, 422, 'validation_failed', { ref: 'R8.32', what: `POST /splits with amount ${literal}` });
    }
    const empty = await doSplit(t, c, 'ada', { amount: 10, participant_handles: [] });
    t.err(empty, 422, 'validation_failed', { ref: 'R8.32', what: 'an empty participant_handles' });
    for (const handles of [['ada', 'ada'], ['bob', 'bob'], ['ada', 'bob', 'ada'], ['bob', 'cy', 'bob']]) {
      const res = await doSplit(t, c, 'ada', { amount: 10, participant_handles: handles });
      t.err(res, 422, 'validation_failed', { ref: 'R8.32', what: `duplicate handles ${JSON.stringify(handles)}` });
    }
    const longNote = await doSplit(t, c, 'ada', { amount: 10, participant_handles: ['ada', 'bob'], note: 'x'.repeat(201) });
    t.err(longNote, 422, 'validation_failed', { ref: 'R8.32', what: 'a note of 201 characters' });
    const okNote = await doSplit(t, c, 'ada', { amount: 10, participant_handles: ['ada', 'bob'], note: 'x'.repeat(200) });
    t.status(okNote, 201, { ref: 'R8.32', what: 'a note of exactly 200 characters' });
    for (const handles of [['nobody'], ['ada', 'nobody'], ['ada', 'bob', 'ghost']]) {
      const res = await doSplit(t, c, 'ada', { amount: 10, participant_handles: handles });
      t.err(res, 404, 'not_found', { ref: 'R8.32', what: `an unknown handle in ${JSON.stringify(handles)}` });
    }
    const missing = await api(t, { method: 'POST', path: '/splits', token: c.tokens.ada, idemKey: key('serr'), body: { amount: 10 } });
    t.err(missing, 422, 'validation_failed', { ref: 'R5.8', what: 'POST /splits with no participant_handles' });
    for (const literal of ['null', '5', 'true', '"ada"', '{"0":"ada"}']) {
      const res = await api(t, {
        method: 'POST', path: '/splits', token: c.tokens.ada, idemKey: key('serr'),
        rawBody: `{"amount":10,"participant_handles":${literal}}`,
      });
      t.err(res, 400, 'malformed_request', { ref: 'R5.2', what: `participant_handles as ${literal}` });
    }
  });

  test('a non-string element inside participant_handles is rejected', ['R5.2'], async (t) => {
    const c = await loginAll(t);
    for (const literal of ['[1,2]', '["ada",null]', '["ada",{"h":"bob"}]', '[["ada"]]']) {
      const res = await api(t, {
        method: 'POST', path: '/splits', token: c.tokens.ada, idemKey: key('elem'),
        rawBody: `{"amount":10,"participant_handles":${literal}}`,
      });
      t.oneOfErr(res, [[400, 'malformed_request'], [422, 'validation_failed'], [404, 'not_found']], {
        ref: 'R5.2', what: `participant_handles ${literal}`,
      });
    }
  }, {
    severity: 'advisory',
    why: 'spec 5 assigns 400 to a field of the wrong type and 422 to a correctly typed field with an '
       + 'invalid value; an element of the wrong type inside a correctly typed array is neither case '
       + 'exactly. A 404 for an unresolvable handle is also defensible. Only a 2xx or a 5xx is wrong.',
  });

  test('each split computes its shares independently of previous splits', ['R9.5'], async (t) => {
    const c = await loginAll(t);
    for (let i = 0; i < 4; i++) {
      const res = await doSplit(t, c, 'ada', { amount: 10, participant_handles: ['ada', 'bob', 'cy'] });
      if (!t.status(res, 201, { ref: 'R9.5', what: `split number ${i + 1} of 10 among 3` })) continue;
      t.deep(res.json.shares.map((s) => s.amount), [4, 3, 3], {
        ref: 'R9.5', what: `shares on split number ${i + 1} (no remainder carried over)`, res,
      });
    }
  });

  test('shares always sum to the amount across a range of sizes', ['R9.1'], async (t) => {
    const c = await loginAll(t);
    const handles = ['ada', 'bob', 'cy', 'dee', 'eve'];
    const amounts = [1, 2, 3, 4, 7, 11, 99, 100, 101, 1000, 1001, 999999999, 1000000000];
    for (const amount of amounts) {
      for (const n of [1, 2, 3, 4, 5]) {
        const use = handles.slice(0, n);
        const res = await doSplit(t, c, 'ada', { amount, participant_handles: use });
        if (res.status !== 201) {
          t.record({
            ref: 'R9.1', what: `POST /splits amount=${amount} n=${n}`, res,
            expected: 'HTTP 201', actual: `HTTP ${res.status}: ${res.text}`,
          });
          continue;
        }
        const values = res.json.shares.map((s) => s.amount);
        t.deep(values, expectedShares(amount, n), {
          ref: 'R9.1', what: `shares for amount=${amount} n=${n}`, res,
        });
        t.eq(values.reduce((a, b) => a + b, 0), amount, {
          ref: 'R9.1', what: `sum for amount=${amount} n=${n}`, res,
        });
      }
    }
  }, { slow: true });

  test('a split is not a feed item', ['R4.15'], async (t) => {
    const c = await loginAll(t);
    const before = await activity(t, c.tokens.ada, { limit: 200 });
    if (!t.status(before, 200, { ref: 'R8.35', what: 'GET /activity before the split' })) return;
    const res = await doSplit(t, c, 'ada', { amount: 3000, participant_handles: ['ada', 'bob', 'cy'], note: 'not a feed item' });
    if (!t.status(res, 201, { ref: 'R4.15', what: 'POST /splits' })) return;
    for (const who of ['ada', 'bob', 'cy', 'eve']) {
      const feed = await activity(t, c.tokens[who], { limit: 200 });
      t.ok(!((feed.json || {}).payments || []).some((p) => p.note === 'not a feed item'), {
        ref: 'R4.15', what: `a split entry in ${who}'s feed`, res: feed,
        expected: 'no feed item for a split', actual: JSON.stringify((feed.json || {}).payments),
      });
    }
    const after = await activity(t, c.tokens.ada, { limit: 200 });
    t.eq(after.json.payments.length, before.json.payments.length, {
      ref: 'R4.15', what: "ada's feed length across a split", res: after,
    });
  });

  test("a split's requests are visible only to their own two parties", ['R4.15', 'R8.22'], async (t) => {
    const c = await loginAll(t);
    const res = await doSplit(t, c, 'ada', { amount: 30, participant_handles: ['ada', 'bob', 'cy'] });
    if (!t.status(res, 201, { ref: 'R8.29', what: 'POST /splits' })) return;
    const bobReq = res.json.requests.find((r) => r.payer_handle === 'bob');
    const cyReq = res.json.requests.find((r) => r.payer_handle === 'cy');
    if (!bobReq || !cyReq) return;

    const bobList = await requests(t, c.tokens.bob, { limit: 200 });
    const bobIds = ((bobList.json || {}).requests || []).map((r) => r.request_id);
    t.ok(bobIds.includes(bobReq.request_id), {
      ref: 'R8.22', what: "bob's own split request", res: bobList,
      expected: 'visible to bob', actual: 'not present',
    });
    t.ok(!bobIds.includes(cyReq.request_id), {
      ref: 'R8.22', what: "cy's split request in bob's list", res: bobList,
      expected: 'not visible to bob', actual: 'present',
    });
    const eveList = await requests(t, c.tokens.eve, { limit: 200 });
    const eveIds = ((eveList.json || {}).requests || []).map((r) => r.request_id);
    t.ok(!eveIds.includes(bobReq.request_id) && !eveIds.includes(cyReq.request_id), {
      ref: 'R8.22', what: "the split's requests in an unrelated user's list", res: eveList,
      expected: 'not visible to eve', actual: JSON.stringify(eveIds),
    });
  });

  test('balances still sum to the seeded total after many splits are paid in full', ['R9.5', 'R1.7'], async (t) => {
    const c = await loginAll(t);
    const total = seededTotal('eur');
    // Every participant must be able to pay its share, so fund the thin wallets first.
    for (const who of ['cy', 'dee', 'eve']) {
      const f = await api(t, { method: 'POST', path: '/payments', token: c.tokens.rich, idemKey: key('fund'), body: { to_handle: who, amount: 100000 } });
      if (!t.status(f, 201, { ref: 'R8.3', what: `funding ${who}` })) return;
    }
    const groups = [
      ['ada', ['ada', 'bob', 'cy'], 1000],
      ['bob', ['bob', 'dee', 'eve'], 7],
      ['rich', ['rich', 'ada', 'bob', 'cy', 'dee'], 1001],
      ['eve', ['eve', 'ada'], 3],
    ];
    for (const [caller, handles, amount] of groups) {
      const res = await doSplit(t, c, caller, { amount, participant_handles: handles });
      if (!t.status(res, 201, { ref: 'R9.5', what: `a split of ${amount} among ${handles.length}` })) continue;
      for (const r of res.json.requests) {
        const paid = await api(t, {
          method: 'POST', path: `/requests/${r.request_id}/pay`,
          token: c.tokens[r.payer_handle], idemKey: key('spay'), body: {},
        });
        t.status(paid, 201, { ref: 'R9.5', what: `${r.payer_handle} paying a share of ${r.amount}` });
      }
      t.eq(await sumBalances(t, c.tokens), total, {
        ref: 'R9.5', what: `the seeded total after the split of ${amount} was paid in full`,
      });
    }
  });

  test('a zero-share request can be paid', ['R9.4'], async (t) => {
    const c = await loginAll(t);
    const res = await doSplit(t, c, 'ada', { amount: 1, participant_handles: ['ada', 'bob'] });
    if (!t.status(res, 201, { ref: 'R9.4', what: 'POST /splits amount=1 among 2' })) return;
    const zero = res.json.requests.find((r) => r.amount === 0);
    if (!t.ok(zero, {
      ref: 'R9.4', what: 'a zero-amount request from the split', res,
      expected: 'a request of amount 0 for bob', actual: JSON.stringify(res.json.requests),
    })) return;
    const before = await balance(t, c.tokens.bob);
    const paid = await api(t, { method: 'POST', path: `/requests/${zero.request_id}/pay`, token: c.tokens.bob, idemKey: key('zp'), body: {} });
    t.status(paid, 201, { ref: 'R9.4', what: 'paying a zero-amount request' });
    if (paid.status === 201) t.eq(paid.json.amount, 0, { ref: 'R9.4', what: 'the zero payment amount', res: paid });
    t.eq(await balance(t, c.tokens.bob), before, { ref: 'R1.7', what: 'no money moved by a zero payment' });
  }, {
    severity: 'advisory',
    why: 'spec 9 requires a zero share to produce a request, and the pay path takes no amount of its '
       + 'own, so paying it should succeed. But spec 8 also says an amount below 1 is invalid, so '
       + 'refusing the payment is a defensible reading. The blocking part -- that the zero request '
       + 'exists -- is checked separately.',
  });
});
