// Specification 4 (the feed contract) and specification 8 (GET /activity).

import { suite, test } from '../lib/runner.mjs';
import { api, reset, login, loginAll, activity, key, PAYMENT_FIELDS } from '../lib/helpers.mjs';

function nonIncreasing(list, field) {
  for (let i = 1; i < list.length; i++) {
    const prev = Date.parse(list[i - 1][field]);
    const next = Date.parse(list[i][field]);
    if (!Number.isFinite(prev) || !Number.isFinite(next)) return false;
    if (prev < next) return false;
  }
  return true;
}

// The feed rule, computed independently: visible iff public, or the caller is a party.
function shouldSee(payment, userId) {
  return payment.visibility === 'public'
    || payment.from_user_id === userId
    || payment.to_user_id === userId;
}

suite('07 activity feed', () => {
  test('the feed shows a payment if and only if it is public or the caller is a party', ['R1.4', 'R4.13'], async (t) => {
    const c = await loginAll(t);
    // A payment of every combination: public and private, between two pairs.
    const made = [];
    const plan = [
      ['ada', 'bob', 11, 'public'],
      ['ada', 'bob', 12, 'private'],
      ['cy', 'dee', 13, 'public'],
      ['cy', 'dee', 14, 'private'],
      ['eve', 'rich', 15, 'private'],
      ['rich', 'eve', 16, 'public'],
    ];
    // cy holds 0; fund the wallets that need to send.
    for (const [who, amount] of [['cy', 100], ['eve', 100]]) {
      const f = await api(t, { method: 'POST', path: '/payments', token: c.tokens.rich, idemKey: key('fund'), body: { to_handle: who, amount, visibility: 'public' } });
      if (!t.status(f, 201, { ref: 'R8.3', what: `funding ${who}` })) return;
      made.push(f.json);
    }
    for (const [from, to, amount, visibility] of plan) {
      const res = await api(t, { method: 'POST', path: '/payments', token: c.tokens[from], idemKey: key('feed'), body: { to_handle: to, amount, visibility } });
      if (!t.status(res, 201, { ref: 'R8.3', what: `${from} -> ${to} ${visibility}` })) return;
      made.push(res.json);
    }

    for (const [handle, userId] of Object.entries(c.ids)) {
      const feed = await activity(t, c.tokens[handle], { limit: 200 });
      if (!t.status(feed, 200, { ref: 'R8.35', what: `GET /activity as ${handle}` })) continue;
      const visible = new Set((feed.json.payments || []).map((p) => p.payment_id));
      for (const p of made) {
        const expected = shouldSee(p, userId);
        t.eq(visible.has(p.payment_id), expected, {
          ref: 'R4.13',
          what: `${handle} seeing the ${p.visibility} payment ${p.from_handle} -> ${p.to_handle} of ${p.amount}`,
          res: feed,
          expected: expected ? 'visible' : 'not visible',
          actual: visible.has(p.payment_id) ? 'visible' : 'not visible',
        });
      }
      // Nothing beyond the rule may appear either.
      for (const p of feed.json.payments || []) {
        t.ok(p.visibility === 'public' || p.from_user_id === userId || p.to_user_id === userId, {
          ref: 'R4.13', what: `an item in ${handle}'s feed`, res: feed,
          expected: 'public, or the caller is sender or receiver',
          actual: `visibility ${p.visibility}, from ${p.from_user_id}, to ${p.to_user_id}`,
        });
      }
    }
  });

  test('a private payment is visible to its own receiver and sender', ['R4.16'], async (t) => {
    const c = await loginAll(t);
    const res = await api(t, { method: 'POST', path: '/payments', token: c.tokens.ada, idemKey: key('priv'), body: { to_handle: 'bob', amount: 99, visibility: 'private', note: 'between us' } });
    if (!t.status(res, 201, { ref: 'R8.3', what: 'a private payment' })) return;
    const id = res.json.payment_id;
    for (const who of ['ada', 'bob']) {
      const feed = await activity(t, c.tokens[who], { limit: 200 });
      const found = ((feed.json || {}).payments || []).find((p) => p.payment_id === id);
      t.ok(found, {
        ref: 'R4.16', what: `the private payment in ${who}'s feed`, res: feed,
        expected: 'visible to a party of the payment', actual: 'not present',
      });
      // "seen identically by both parties and by everyone else"
      if (found) t.deep(found, res.json, { ref: 'R4.16', what: `the payment object as ${who} sees it`, res: feed });
    }
    for (const who of ['cy', 'eve', 'op']) {
      const feed = await activity(t, c.tokens[who], { limit: 200 });
      t.ok(!((feed.json || {}).payments || []).some((p) => p.payment_id === id), {
        ref: 'R4.16', what: `the private payment in ${who}'s feed`, res: feed,
        expected: 'hidden from third parties', actual: 'present',
      });
    }
  });

  test('a public payment is seen identically by parties and third parties', ['R4.16'], async (t) => {
    const c = await loginAll(t);
    const res = await api(t, { method: 'POST', path: '/payments', token: c.tokens.ada, idemKey: key('pub'), body: { to_handle: 'bob', amount: 98, visibility: 'public', note: 'for everyone' } });
    if (!t.status(res, 201, { ref: 'R8.3', what: 'a public payment' })) return;
    for (const who of ['ada', 'bob', 'cy', 'op']) {
      const feed = await activity(t, c.tokens[who], { limit: 200 });
      const found = ((feed.json || {}).payments || []).find((p) => p.payment_id === res.json.payment_id);
      if (!t.ok(found, {
        ref: 'R4.16', what: `the public payment in ${who}'s feed`, res: feed,
        expected: 'visible', actual: 'not present',
      })) continue;
      t.deep(found, res.json, { ref: 'R4.16', what: `the payment object as ${who} sees it`, res: feed });
    }
  });

  test('a feed item is a full payment object', ['R8.35', 'R8.38'], async (t) => {
    const c = await loginAll(t);
    const feed = await activity(t, c.tokens.ada, { limit: 200 });
    if (!t.status(feed, 200, { ref: 'R8.35', what: 'GET /activity' })) return;
    t.fields(feed.json, ['payments', 'has_more'], { ref: 'R8.35', what: 'GET /activity body', res: feed });
    t.ok((feed.json.payments || []).length > 0, {
      ref: 'R8.35', what: 'the seeded feed', res: feed,
      expected: 'the seeded payments to be listed', actual: '0 items',
    });
    for (const p of feed.json.payments || []) {
      t.fields(p, PAYMENT_FIELDS, { ref: 'R8.35', what: 'a feed item', res: feed });
    }
  });

  test('payments settling a request appear in the feed under the ordinary rule', ['R4.15'], async (t) => {
    const c = await loginAll(t);
    const rq = await api(t, { method: 'POST', path: '/requests', token: c.tokens.ada, idemKey: key('fr'), body: { payer_handle: 'bob', amount: 77 } });
    if (!t.status(rq, 201, { ref: 'R8.12', what: 'POST /requests' })) return;
    const paid = await api(t, { method: 'POST', path: `/requests/${rq.json.request_id}/pay`, token: c.tokens.bob, idemKey: key('fp'), body: { visibility: 'private' } });
    if (!t.status(paid, 201, { ref: 'R8.17', what: 'pay it privately' })) return;
    for (const who of ['ada', 'bob']) {
      const feed = await activity(t, c.tokens[who], { limit: 200 });
      t.ok(((feed.json || {}).payments || []).some((p) => p.payment_id === paid.json.payment_id), {
        ref: 'R4.15', what: `the settling payment in ${who}'s feed`, res: feed,
        expected: 'visible to a party', actual: 'not present',
      });
    }
    const third = await activity(t, c.tokens.cy, { limit: 200 });
    t.ok(!((third.json || {}).payments || []).some((p) => p.payment_id === paid.json.payment_id), {
      ref: 'R4.15', what: "the private settling payment in cy's feed", res: third,
      expected: 'hidden from third parties', actual: 'present',
    });
  });

  test('the feed is ordered newest first', ['R8.35'], async (t) => {
    const c = await loginAll(t);
    for (let i = 0; i < 6; i++) {
      const res = await api(t, { method: 'POST', path: '/payments', token: c.tokens.ada, idemKey: key('ord'), body: { to_handle: 'bob', amount: 1 + i } });
      if (res.status !== 201) return;
    }
    const feed = await activity(t, c.tokens.ada, { limit: 200 });
    if (!t.status(feed, 200, { ref: 'R8.35', what: 'GET /activity' })) return;
    t.ok(nonIncreasing(feed.json.payments, 'created_at'), {
      ref: 'R8.35', what: 'created_at order in the feed', res: feed,
      expected: 'created_at non-increasing down the list',
      actual: JSON.stringify((feed.json.payments || []).map((p) => p.created_at)),
    });
  });

  test('seeded payments are ordered by their position in the fixture array', ['D10'], async (t) => {
    const fx = await reset(t, 'eur');
    const ada = await login(t, 'ada@example.com');
    if (!ada) return;
    const feed = await activity(t, ada.token, { limit: 200 });
    if (!t.status(feed, 200, { ref: 'D10', what: 'GET /activity' })) return;
    const expected = fx.payments
      .filter((p) => p.visibility === 'public' || p.from_user_id === 'u_ada' || p.to_user_id === 'u_ada')
      .map((p) => p.amount)
      .reverse();
    t.deep(feed.json.payments.map((p) => p.amount), expected, {
      ref: 'D10', what: 'seeded feed order for ada (later in the fixture array is newer)', res: feed,
    });
  }, {
    severity: 'advisory',
    why: 'The fixture carries no timestamps, and spec 8 leaves the relative order of payments '
       + 'created within the same second unspecified. Decision D10 assigns seeded timestamps in '
       + 'fixture-array order.',
  });

  test('limit, offset and has_more behave as on GET /requests', ['R8.37', 'R8.26'], async (t) => {
    const c = await loginAll(t);
    for (let i = 0; i < 6; i++) {
      const res = await api(t, { method: 'POST', path: '/payments', token: c.tokens.ada, idemKey: key('pg'), body: { to_handle: 'bob', amount: 1 } });
      if (res.status !== 201) return;
    }
    const all = await activity(t, c.tokens.ada, { limit: 200 });
    if (!t.status(all, 200, { ref: 'R8.37', what: 'the unpaged feed' })) return;
    const n = all.json.payments.length;
    t.eq(all.json.has_more, false, { ref: 'R8.26', what: 'has_more on a complete page', res: all });

    const page = await activity(t, c.tokens.ada, { limit: 2, offset: 0 });
    if (t.status(page, 200, { ref: 'R8.37', what: 'limit=2&offset=0' })) {
      t.eq(page.json.payments.length, 2, { ref: 'R8.37', what: 'page size', res: page });
      t.eq(page.json.has_more, true, { ref: 'R8.26', what: 'has_more with more items behind', res: page });
    }
    const last = await activity(t, c.tokens.ada, { limit: 2, offset: n - 2 });
    if (t.status(last, 200, { ref: 'R8.37', what: `limit=2&offset=${n - 2}` })) {
      t.eq(last.json.has_more, false, { ref: 'R8.26', what: 'has_more on the final page', res: last });
    }
    const past = await activity(t, c.tokens.ada, { limit: 5, offset: n + 5 });
    if (t.status(past, 200, { ref: 'R8.37', what: 'an offset past the end' })) {
      t.eq(past.json.payments.length, 0, { ref: 'R8.37', what: 'items past the end', res: past });
      t.eq(past.json.has_more, false, { ref: 'R8.26', what: 'has_more past the end', res: past });
    }
    const dflt = await activity(t, c.tokens.ada, {});
    if (t.status(dflt, 200, { ref: 'R8.37', what: 'no limit given' })) {
      t.ok(dflt.json.payments.length <= 50, {
        ref: 'R8.37', what: 'the default limit', res: dflt,
        expected: 'at most 50 items', actual: String(dflt.json.payments.length),
      });
    }
    for (const limit of [1, 200]) {
      t.status(await activity(t, c.tokens.ada, { limit }), 200, { ref: 'R8.37', what: `limit=${limit}` });
    }
    for (const limit of ['0', '-1', '201', '1e2', '4.0', '+4', 'abc', '']) {
      const res = await activity(t, c.tokens.ada, { limit });
      t.err(res, 422, 'validation_failed', { ref: 'R8.37', what: `limit=${JSON.stringify(limit)}` });
    }
    for (const offset of ['-1', '1e1', '2.0', '+2', 'abc', '']) {
      const res = await activity(t, c.tokens.ada, { offset });
      t.err(res, 422, 'validation_failed', { ref: 'R8.37', what: `offset=${JSON.stringify(offset)}` });
    }
  });

  test('a brand new account has an empty feed except for public payments', ['R4.13'], async (t) => {
    const c = await loginAll(t);
    const fresh = await api(t, { method: 'POST', path: '/auth/signup', body: { email: 'watcher@example.com', password: 'correct horse', display_name: 'Watcher' } });
    if (!t.status(fresh, 201, { ref: 'R6.1', what: 'signup' })) return;
    const feed = await activity(t, fresh.json.token, { limit: 200 });
    if (!t.status(feed, 200, { ref: 'R4.13', what: 'GET /activity as a brand new account' })) return;
    const nonPublic = (feed.json.payments || []).filter((p) => p.visibility !== 'public');
    t.eq(nonPublic.length, 0, {
      ref: 'R4.13', what: 'private payments visible to an unrelated new account', res: feed,
      expected: 'none', actual: JSON.stringify(nonPublic),
    });
    t.ok((feed.json.payments || []).length > 0, {
      ref: 'R4.13', what: 'the public seeded payments', res: feed,
      expected: 'the public seeded payments to be visible to anyone', actual: '0 items',
    });
  });
});
