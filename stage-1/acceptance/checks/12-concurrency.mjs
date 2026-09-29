// Specification 1: the three invariants under sustained concurrency, and specification 5's
// "requests must not produce 5xx responses, including under concurrent load".
//
// The specification allows up to 50 requests in flight (spec 2); these checks stay at or
// below 40 so a failure is a failure of the service, not of the stated limit.

import { suite, test, seededTotal } from '../lib/runner.mjs';
import {
  api, loginAll, balance, sumBalances, requests, activity,
  key, concurrently, describeStatuses,
} from '../lib/helpers.mjs';

const FAN = 20;

// Read every balance at once, so the sample is as close to simultaneous as HTTP allows.
async function balancesNow(t, tokens) {
  const entries = Object.entries(tokens).filter(([, tok]) => tok);
  const seen = await Promise.all(entries.map(async ([handle, tok]) => {
    const res = await api(t, { path: '/me', token: tok });
    return [handle, res.status === 200 ? res.json.balance : NaN];
  }));
  return Object.fromEntries(seen);
}

function negatives(balances) {
  return Object.entries(balances).filter(([, v]) => !(v >= 0));
}

suite('12 invariants under concurrency', () => {
  test('a sustained mixed load never breaks the seeded total or goes negative', ['R1.7', 'R1.8', 'R5.16', 'R2.6'], async (t) => {
    const c = await loginAll(t);
    const total = seededTotal('eur');
    const handles = ['ada', 'bob', 'cy', 'dee', 'eve', 'rich'];

    for (let round = 1; round <= 6; round++) {
      t.note(`round ${round}`);
      const work = [];
      for (let i = 0; i < FAN; i++) {
        const from = handles[i % handles.length];
        const to = handles[(i + 1 + round) % handles.length];
        if (from === to) continue;
        const amount = 1 + ((i * 7 + round) % 40);
        // A deliberate mix: ordinary payments, requests, splits, settlements, and
        // some that must fail. All of them are in flight together.
        if (i % 5 === 0) {
          work.push(api(t, { method: 'POST', path: '/payments', token: c.tokens[from], idemKey: key('load'), body: { to_handle: to, amount, visibility: i % 2 ? 'private' : 'public' } }));
        } else if (i % 5 === 1) {
          work.push(api(t, { method: 'POST', path: '/requests', token: c.tokens[from], idemKey: key('load'), body: { payer_handle: to, amount } }));
        } else if (i % 5 === 2) {
          work.push(api(t, { method: 'POST', path: '/splits', token: c.tokens[from], idemKey: key('load'), body: { amount: amount * 3, participant_handles: [from, to] } }));
        } else if (i % 5 === 3) {
          work.push(api(t, { method: 'POST', path: '/settlements', token: c.tokens.op, idemKey: key('load'), body: { transfers: [{ from_handle: from, to_handle: to, amount }] } }));
        } else {
          // Guaranteed to be refused: an empty wallet cannot pay.
          work.push(api(t, { method: 'POST', path: '/payments', token: c.tokens.cy, idemKey: key('load'), body: { to_handle: 'bob', amount: 1000000000 } }));
        }
      }
      const done = await Promise.all(work);
      const server = done.filter((r) => r.status >= 500);
      t.eq(server.length, 0, {
        ref: 'R5.16', what: `round ${round}: 5xx responses under ${work.length} concurrent requests`,
        expected: 'none', actual: describeStatuses(done),
      });

      const balances = await balancesNow(t, c.tokens);
      const neg = negatives(balances);
      t.eq(neg.length, 0, {
        ref: 'R1.8', what: `round ${round}: negative balances`,
        expected: 'none', actual: JSON.stringify(neg),
      });
      const sum = Object.values(balances).reduce((a, b) => a + b, 0);
      t.eq(sum, total, {
        ref: 'R1.7', what: `round ${round}: the sum of every wallet balance`,
        expected: String(total), actual: `${sum} (${JSON.stringify(balances)})`,
      });
    }
  }, { slow: true });

  test('balances sampled while money is moving are never negative', ['R1.8'], async (t) => {
    const c = await loginAll(t);
    // dee holds 100. Fire many payments of 100 and sample dee's balance throughout.
    const samples = [];
    const sampling = (async () => {
      for (let i = 0; i < 40; i++) {
        const res = await api(t, { path: '/me', token: c.tokens.dee });
        if (res.status === 200) samples.push(res.json.balance);
      }
    })();
    const spending = concurrently(FAN, () =>
      api(t, { method: 'POST', path: '/payments', token: c.tokens.dee, idemKey: key('drain'), body: { to_handle: 'bob', amount: 100 } }));
    const [, responses] = await Promise.all([sampling, spending]);

    const bad = samples.filter((v) => !(v >= 0));
    t.eq(bad.length, 0, {
      ref: 'R1.8', what: 'balance samples taken while a wallet was being drained concurrently',
      expected: 'every sample at or above 0', actual: JSON.stringify(bad),
    });
    const created = responses.filter((r) => r.status === 201);
    t.eq(created.length, 1, {
      ref: 'R1.8', what: `${FAN} concurrent payments of 100 from a wallet holding 100`,
      expected: 'exactly one accepted', actual: describeStatuses(responses),
    });
    const refused = responses.filter((r) => r.status === 409 && r.json && r.json.error.code === 'insufficient_funds');
    t.eq(refused.length, FAN - 1, {
      ref: 'R8.4', what: 'the rest of the concurrent payments',
      expected: `${FAN - 1} responses with 409 insufficient_funds`, actual: describeStatuses(responses),
    });
    t.eq(await balance(t, c.tokens.dee), 0, { ref: 'R1.8', what: 'the drained wallet ends at exactly 0' });
  }, { slow: true });

  test('a request under concurrent payment attempts moves money once', ['R1.9'], async (t) => {
    const c = await loginAll(t);
    const rq = await api(t, { method: 'POST', path: '/requests', token: c.tokens.ada, idemKey: key('r'), body: { payer_handle: 'bob', amount: 250 } });
    if (!t.status(rq, 201, { ref: 'R8.12', what: 'POST /requests' })) return;
    const id = rq.json.request_id;
    const before = { ada: await balance(t, c.tokens.ada), bob: await balance(t, c.tokens.bob) };

    // Distinct keys, so each is a separate request, not a replay.
    const all = await concurrently(FAN, () =>
      api(t, { method: 'POST', path: `/requests/${id}/pay`, token: c.tokens.bob, idemKey: key('race'), body: {} }));
    const created = all.filter((r) => r.status === 201);
    t.eq(created.length, 1, {
      ref: 'R1.9', what: `${FAN} concurrent payments of one request under distinct keys`,
      expected: 'exactly one HTTP 201', actual: describeStatuses(all),
    });
    const notPending = all.filter((r) => r.status === 409 && r.json && r.json.error.code === 'request_not_pending');
    t.eq(notPending.length, FAN - 1, {
      ref: 'R1.9', what: 'the remaining attempts',
      expected: `${FAN - 1} responses with 409 request_not_pending`, actual: describeStatuses(all),
    });
    t.eq(await balance(t, c.tokens.bob), before.bob - 250, { ref: 'R1.9', what: 'the payer paid exactly once' });
    t.eq(await balance(t, c.tokens.ada), before.ada + 250, { ref: 'R1.9', what: 'the requester was paid exactly once' });

    const list = await requests(t, c.tokens.ada, { limit: 200 });
    const one = ((list.json || {}).requests || []).filter((r) => r.request_id === id);
    t.eq(one.length, 1, { ref: 'R1.9', what: 'the request still appears exactly once', res: list });
    t.eq(one[0] && one[0].status, 'paid', { ref: 'R1.9', what: 'its final status', res: list });
    const feed = await activity(t, c.tokens.ada, { limit: 200 });
    const settling = ((feed.json || {}).payments || []).filter((p) => p.request_id === id);
    t.eq(settling.length, 1, { ref: 'R1.9', what: 'exactly one payment references the request', res: feed });
  }, { slow: true });

  test('concurrent pay, decline and cancel on one request produce one outcome', ['R4.10', 'R1.9'], async (t) => {
    const c = await loginAll(t);
    for (let round = 0; round < 3; round++) {
      const rq = await api(t, { method: 'POST', path: '/requests', token: c.tokens.ada, idemKey: key('r'), body: { payer_handle: 'bob', amount: 30 } });
      if (!t.status(rq, 201, { ref: 'R8.12', what: 'POST /requests' })) return;
      const id = rq.json.request_id;
      const before = { ada: await balance(t, c.tokens.ada), bob: await balance(t, c.tokens.bob) };

      const attempts = [
        ...Array.from({ length: 6 }, () => api(t, { method: 'POST', path: `/requests/${id}/pay`, token: c.tokens.bob, idemKey: key('race'), body: {} })),
        ...Array.from({ length: 6 }, () => api(t, { method: 'POST', path: `/requests/${id}/decline`, token: c.tokens.bob, body: {} })),
        ...Array.from({ length: 6 }, () => api(t, { method: 'POST', path: `/requests/${id}/cancel`, token: c.tokens.ada, body: {} })),
      ];
      const all = await Promise.all(attempts);
      t.eq(all.filter((r) => r.status >= 500).length, 0, {
        ref: 'R5.16', what: `round ${round}: 5xx under conflicting transitions`,
        expected: 'none', actual: describeStatuses(all),
      });

      const list = await requests(t, c.tokens.ada, { limit: 200 });
      const found = ((list.json || {}).requests || []).find((r) => r.request_id === id);
      if (!t.ok(found, {
        ref: 'R4.10', what: `round ${round}: the request after the race`, res: list,
        expected: 'still present', actual: 'missing',
      })) continue;
      t.ok(['paid', 'declined', 'cancelled'].includes(found.status), {
        ref: 'R4.10', what: `round ${round}: the final status`, res: list,
        expected: 'exactly one of paid, declined, cancelled',
        actual: JSON.stringify(found.status),
      });

      const bob = await balance(t, c.tokens.bob);
      const ada = await balance(t, c.tokens.ada);
      if (found.status === 'paid') {
        t.eq(bob, before.bob - 30, { ref: 'R1.9', what: `round ${round}: the payer moved 30 exactly once` });
        t.eq(ada, before.ada + 30, { ref: 'R1.9', what: `round ${round}: the requester received 30 exactly once` });
      } else {
        t.eq(bob, before.bob, { ref: 'R1.9', what: `round ${round}: no money moved on a ${found.status} request` });
        t.eq(ada, before.ada, { ref: 'R1.9', what: `round ${round}: no money moved to the requester` });
      }
    }
  }, { slow: true });

  test('concurrent settlements competing for the same funds stay consistent', ['R1.7', 'R1.8', 'R11.11'], async (t) => {
    const c = await loginAll(t);
    const total = seededTotal('eur');
    // Each batch alone would drain ada; together they cannot all commit.
    const all = await concurrently(FAN, (i) =>
      api(t, {
        method: 'POST', path: '/settlements', token: c.tokens.op, idemKey: key('stlrace'),
        body: { transfers: [{ from_handle: 'ada', to_handle: 'bob', amount: 2000 }, { from_handle: 'bob', to_handle: 'cy', amount: 100 + i }] },
      }));
    t.eq(all.filter((r) => r.status >= 500).length, 0, {
      ref: 'R5.16', what: 'concurrent settlements',
      expected: 'no 5xx', actual: describeStatuses(all),
    });
    const committed = all.filter((r) => r.status === 201);
    t.ok(committed.length >= 1 && committed.length <= 5, {
      ref: 'R11.10', what: 'settlements committed out of 20 batches each taking 2000 from a wallet holding 10000',
      expected: 'between 1 and 5 commits',
      actual: `${committed.length} commits; ${describeStatuses(all)}`,
    });
    const balances = await balancesNow(t, c.tokens);
    t.eq(negatives(balances).length, 0, {
      ref: 'R1.8', what: 'negative balances after concurrent settlements',
      expected: 'none', actual: JSON.stringify(negatives(balances)),
    });
    const sum = Object.values(balances).reduce((a, b) => a + b, 0);
    t.eq(sum, total, {
      ref: 'R1.7', what: 'the total after concurrent settlements',
      expected: String(total), actual: `${sum} (${JSON.stringify(balances)})`,
    });
    // Every commit is fully applied: ada's outflow is a clean multiple of 2000.
    t.eq((10000 - balances.ada) % 2000, 0, {
      ref: 'R11.11', what: "ada's outflow is a whole number of committed batches",
      expected: 'a multiple of 2000', actual: String(10000 - balances.ada),
    });
  }, { slow: true });

  test('concurrent signups for one email create one account', ['R6.3'], async (t) => {
    await loginAll(t);
    const all = await concurrently(10, () =>
      api(t, { method: 'POST', path: '/auth/signup', body: { email: 'racer@example.com', password: 'correct horse', display_name: 'Racer' } }));
    const created = all.filter((r) => r.status === 201);
    t.eq(created.length, 1, {
      ref: 'R6.3', what: '10 concurrent signups for one email',
      expected: 'exactly one HTTP 201', actual: describeStatuses(all),
    });
    const taken = all.filter((r) => r.status === 409);
    t.eq(taken.length, 9, {
      ref: 'R6.3', what: 'the other nine',
      expected: '9 responses with 409', actual: describeStatuses(all),
    });
  }, { slow: true });

  test('concurrent signups deriving one handle create one account', ['R6.7'], async (t) => {
    await loginAll(t);
    const all = await concurrently(8, (i) =>
      api(t, { method: 'POST', path: '/auth/signup', body: { email: `same.handle@d${i}.example.com`, password: 'correct horse', display_name: 'H' } }));
    const created = all.filter((r) => r.status === 201);
    t.eq(created.length, 1, {
      ref: 'R6.7', what: '8 concurrent signups whose emails all derive the handle same_handle',
      expected: 'exactly one HTTP 201', actual: describeStatuses(all),
    });
    const refused = all.filter((r) => r.status === 409 && r.json && r.json.error.code === 'handle_taken');
    t.eq(refused.length, 7, {
      ref: 'R6.7', what: 'the other seven',
      expected: '7 responses with 409 handle_taken', actual: describeStatuses(all),
    });
  }, { slow: true });

  test('reads stay coherent while writes are in flight', ['R8.10', 'R5.16'], async (t) => {
    const c = await loginAll(t);
    const total = seededTotal('eur');
    const reads = [];
    const reading = (async () => {
      for (let i = 0; i < 30; i++) {
        const feed = await api(t, { path: '/activity', token: c.tokens.ada, query: { limit: 200 } });
        const list = await api(t, { path: '/requests', token: c.tokens.ada, query: { limit: 200 } });
        reads.push([feed, list]);
      }
    })();
    const writing = concurrently(FAN, (i) =>
      api(t, { method: 'POST', path: '/payments', token: c.tokens.rich, idemKey: key('rw'), body: { to_handle: 'ada', amount: 1 + i } }));
    const [, writes] = await Promise.all([reading, writing]);

    t.eq(writes.filter((r) => r.status !== 201).length, 0, {
      ref: 'R8.10', what: 'writes from a wallet with ample funds',
      expected: 'every one accepted', actual: describeStatuses(writes),
    });
    for (const [feed, list] of reads) {
      if (feed.status !== 200 || list.status !== 200) {
        t.record({
          ref: 'R5.16', what: 'a read taken during concurrent writes',
          expected: 'HTTP 200', actual: `activity ${feed.status}, requests ${list.status}`,
          res: feed.status !== 200 ? feed : list,
        });
        break;
      }
      // A debit and its credit are one step: no half-applied payment is ever visible.
      const half = (feed.json.payments || []).filter((p) => !p.from_user_id || !p.to_user_id || typeof p.amount !== 'number');
      if (half.length) {
        t.record({
          ref: 'R8.10', what: 'a feed item read during concurrent writes',
          expected: 'every payment complete', actual: JSON.stringify(half.slice(0, 2)), res: feed,
        });
        break;
      }
    }
    t.eq(await sumBalances(t, c.tokens), total, { ref: 'R1.7', what: 'the total after concurrent reads and writes' });
  }, { slow: true });
});
