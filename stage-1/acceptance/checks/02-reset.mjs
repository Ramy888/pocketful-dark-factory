// Specification 3.3 and 4: reset, the fixture format and the seeded-total baseline.

import { suite, test, fixtureObject, seededTotal } from '../lib/runner.mjs';
import { api, reset, resetWith, login, loginAll, sumBalances, me, key, PW } from '../lib/helpers.mjs';

function eurCopy() {
  return fixtureObject('eur');
}

suite('02 reset and fixture', () => {
  test('a valid fixture returns 204 and the service stays healthy', ['R3.3'], async (t) => {
    await reset(t, 'eur');
    const h = await api(t, { path: '/health' });
    t.status(h, 200, { ref: 'R3.2', what: 'GET /health after a reset' });
  });

  test('reset needs no Authorization header', ['R3.3'], async (t) => {
    const res = await t.req({
      method: 'POST', path: '/_test/reset',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(eurCopy()),
    });
    t.status(res, 204, { ref: 'R3.3', what: 'POST /_test/reset with no bearer token' });
  });

  test('after 204 only the new fixture is visible', ['R3.3'], async (t) => {
    await reset(t, 'eur');
    const ada = await login(t, 'ada@example.com');
    if (!ada) return;
    await reset(t, 'minimal');

    const stale = await me(t, ada.token);
    t.err(stale, 401, 'unauthenticated', {
      ref: 'R3.3', what: 'GET /me with a token issued before the reset',
    });
    const gone = await api(t, { method: 'POST', path: '/auth/login', body: { email: 'ada@example.com', password: PW } });
    t.err(gone, 401, 'unauthenticated', {
      ref: 'R3.3', what: 'login as a user the new fixture does not contain',
    });
    const solo = await login(t, 'solo@example.com');
    if (!solo) return;
    const feed = await api(t, { path: '/activity', token: solo.token });
    if (t.status(feed, 200, { ref: 'R3.3', what: 'GET /activity after reset' })) {
      t.eq((feed.json.payments || []).length, 0, {
        ref: 'R3.3', what: 'payments carried over from the previous fixture', res: feed,
      });
    }
    const reqs = await api(t, { path: '/requests', token: solo.token });
    if (t.status(reqs, 200, { ref: 'R3.3', what: 'GET /requests after reset' })) {
      t.eq((reqs.json.requests || []).length, 0, {
        ref: 'R3.3', what: 'requests carried over from the previous fixture', res: reqs,
      });
    }
  });

  test('repeated resets are supported', ['R3.3'], async (t) => {
    for (const name of ['eur', 'minimal', 'eur', 'jpy', 'eur']) await reset(t, name);
    const ada = await login(t, 'ada@example.com');
    if (!ada) return;
    const r = await me(t, ada.token);
    if (t.status(r, 200, { ref: 'R8.1', what: 'GET /me after five resets' })) {
      t.eq(r.json.balance, 10000, { ref: 'R4.20', what: 'ada balance after the last reset', res: r });
    }
  });

  test('seeded users log in with the fixture password immediately', ['R4.19', 'R6.2'], async (t) => {
    const fx = await reset(t, 'eur');
    for (const u of fx.users) {
      const res = await api(t, { method: 'POST', path: '/auth/login', body: { email: u.email, password: u.password } });
      if (t.status(res, 200, { ref: 'R4.19', what: `login as ${u.email}` })) {
        t.eq(res.json.user_id, u.id, { ref: 'R4.5', what: `user_id for ${u.email}`, res });
        t.eq(res.json.display_name, u.display_name, { ref: 'R4.18', what: `display_name for ${u.email}`, res });
      }
    }
  });

  test('seeded balances are used as given and never re-derived from seeded payments', ['R4.20', 'R4.5'], async (t) => {
    const { fx, tokens } = await loginAll(t, 'eur');
    for (const u of fx.users) {
      if (!tokens[u.handle]) continue;
      const r = await me(t, tokens[u.handle]);
      if (t.status(r, 200, { ref: 'R8.1', what: `GET /me for ${u.handle}` })) {
        t.eq(r.json.balance, u.balance, {
          ref: 'R4.20', what: `${u.handle} balance (fixture says ${u.balance})`, res: r,
        });
        t.eq(r.json.handle, u.handle, { ref: 'R4.5', what: `${u.handle} handle`, res: r });
        t.eq(r.json.currency, fx.currency, { ref: 'R4.1', what: 'currency', res: r });
        t.eq(r.json.minor_units, fx.minor_units, { ref: 'R4.1', what: 'minor_units', res: r });
      }
    }
  });

  test('the sum of wallet balances equals the seeded total', ['R1.7'], async (t) => {
    const { tokens } = await loginAll(t, 'eur');
    const sum = await sumBalances(t, tokens);
    t.eq(sum, seededTotal('eur'), {
      ref: 'R1.7', what: 'sum of every wallet balance immediately after reset',
    });
  });

  test('seeded payments and requests are visible with their seeded values', ['R4.18'], async (t) => {
    const fx = await reset(t, 'eur');
    const ada = await login(t, 'ada@example.com');
    if (!ada) return;
    const feed = await api(t, { path: '/activity', token: ada.token, query: { limit: 200 } });
    if (!t.status(feed, 200, { ref: 'R8.35', what: 'GET /activity' })) return;
    const seededAdaPayments = fx.payments.filter((p) => p.from_user_id === 'u_ada');
    for (const p of seededAdaPayments) {
      const found = (feed.json.payments || []).find((x) => x.amount === p.amount && x.note === p.note);
      if (!t.ok(found, {
        ref: 'R4.18', what: `seeded payment ${p.id} in ada's feed`, res: feed,
        expected: `a payment of ${p.amount} with note ${JSON.stringify(p.note)}`,
        actual: JSON.stringify(feed.json.payments),
      })) continue;
      t.eq(found.visibility, p.visibility, { ref: 'R4.18', what: `${p.id} visibility`, res: feed });
      t.eq(found.from_user_id, p.from_user_id, { ref: 'R4.18', what: `${p.id} from_user_id`, res: feed });
      t.eq(found.to_user_id, p.to_user_id, { ref: 'R4.18', what: `${p.id} to_user_id`, res: feed });
      t.eq(found.request_id, null, { ref: 'R8.3', what: `${p.id} request_id`, res: feed });
    }

    const reqs = await api(t, { path: '/requests', token: ada.token, query: { limit: 200 } });
    if (!t.status(reqs, 200, { ref: 'R8.22', what: 'GET /requests' })) return;
    const adaSeeded = fx.requests.filter((r) => r.requester_id === 'u_ada' || r.payer_id === 'u_ada');
    t.eq((reqs.json.requests || []).length, adaSeeded.length, {
      ref: 'R4.18', what: "number of seeded requests visible to ada", res: reqs,
    });
    for (const r of adaSeeded) {
      const found = (reqs.json.requests || []).find((x) => x.amount === r.amount && x.note === r.note);
      if (!t.ok(found, {
        ref: 'R4.18', what: `seeded request ${r.id} visible to ada`, res: reqs,
        expected: `a request of ${r.amount} with note ${JSON.stringify(r.note)}`,
        actual: JSON.stringify(reqs.json.requests),
      })) continue;
      t.eq(found.status, r.status, { ref: 'R4.18', what: `${r.id} status`, res: reqs });
      t.eq(found.payment_id, null, { ref: 'R8.13', what: `${r.id} payment_id while pending`, res: reqs });
    }
  });

  test('a seeded request may arrive in a terminal status', ['R4.18'], async (t) => {
    const fx = await reset(t, 'seeded-statuses');
    const bob = await login(t, 'bob@example.com');
    if (!bob) return;
    const res = await api(t, { path: '/requests', token: bob.token, query: { limit: 200 } });
    if (!t.status(res, 200, { ref: 'R4.18', what: 'GET /requests' })) return;
    for (const seeded of fx.requests) {
      const found = (res.json.requests || []).find((r) => r.amount === seeded.amount);
      if (!t.ok(found, {
        ref: 'R4.18', what: `the seeded ${seeded.status} request of ${seeded.amount}`, res,
        expected: 'present in the list', actual: JSON.stringify(res.json.requests),
      })) continue;
      t.eq(found.status, seeded.status, {
        ref: 'R4.18', what: `the status of the seeded request of ${seeded.amount}`, res,
      });
    }
    // A seeded terminal request cannot be transitioned again.
    const declined = (res.json.requests || []).find((r) => r.status === 'declined');
    if (declined) {
      const again = await api(t, { method: 'POST', path: `/requests/${declined.request_id}/pay`, token: bob.token, idemKey: key('seeded'), body: {} });
      t.err(again, 409, 'request_not_pending', {
        ref: 'R8.18', what: 'paying a request seeded as declined',
      });
    }
    // And the seeded balances are still exactly what the fixture said.
    const m = await me(t, bob.token);
    t.eq(m.json && m.json.balance, 2500, {
      ref: 'R4.20', what: 'a seeded balance alongside terminal seeded requests', res: m,
    });
  }, {
    severity: 'advisory',
    why: 'spec 4 shows status on a seeded request and lists all four statuses in the model, so a '
       + 'terminal seeded request is within the format. But the specification never says what '
       + 'payment_id a seeded paid request carries, so a service that accepts only pending seeds is '
       + 'not clearly contradicting the text. This check asserts only the status and that balances '
       + 'are untouched.',
  });

  test('a fixture balance below zero is 422 validation_failed and changes nothing', ['R4.21'], async (t) => {
    await reset(t, 'eur');
    const before = await login(t, 'ada@example.com');
    if (!before) return;

    const res = await resetWith(t, fixtureObject('negative-balance'), null);
    t.err(res, 422, 'validation_failed', {
      ref: 'R4.21', what: 'POST /_test/reset with a negative seeded balance',
    });

    // "and change nothing": the previous fixture must still be the live state.
    const still = await me(t, before.token);
    if (t.status(still, 200, { ref: 'R4.21', what: 'GET /me with the pre-reset token' })) {
      t.eq(still.json.balance, 10000, { ref: 'R4.21', what: 'ada balance unchanged', res: still });
    }
    const neg = await api(t, { method: 'POST', path: '/auth/login', body: { email: 'neg@example.com', password: PW } });
    t.err(neg, 401, 'unauthenticated', {
      ref: 'R4.21', what: 'login as a user from the rejected fixture',
    });
  });

  test('minor_units 0, 2 and 3 are all accepted and reported', ['R4.22'], async (t) => {
    for (const [name, currency, units] of [['jpy', 'JPY', 0], ['eur', 'EUR', 2], ['bhd', 'BHD', 3]]) {
      await reset(t, name);
      const ada = await login(t, 'ada@example.com');
      if (!ada) continue;
      const r = await me(t, ada.token);
      if (t.status(r, 200, { ref: 'R8.1', what: `GET /me under ${currency}` })) {
        t.eq(r.json.currency, currency, { ref: 'R4.22', what: 'currency', res: r });
        t.eq(r.json.minor_units, units, { ref: 'R4.22', what: 'minor_units', res: r });
      }
    }
  });

  test('amounts stay plain integer minor units whatever minor_units says', ['R4.1'], async (t) => {
    for (const name of ['jpy', 'bhd']) {
      await reset(t, name);
      const ada = await login(t, 'ada@example.com');
      if (!ada) continue;
      const p = await api(t, {
        method: 'POST', path: '/payments', token: ada.token, idemKey: key('mu'),
        body: { to_handle: 'bob', amount: 1 },
      });
      if (!t.status(p, 201, { ref: 'R4.1', what: `POST /payments of 1 minor unit under ${name}` })) continue;
      t.eq(p.json.amount, 1, { ref: 'R4.1', what: 'amount echoed', res: p });
      const bob = await login(t, 'bob@example.com');
      if (!bob) continue;
      const r = await me(t, bob.token);
      t.eq(r.json && r.json.balance, 2, { ref: 'R4.1', what: `bob balance under ${name} after receiving 1`, res: r });
    }
  });

  test('settlement_operator_ids defaults to an empty array', ['R11.1'], async (t) => {
    await reset(t, 'eur-no-operators');
    const ada = await login(t, 'ada@example.com');
    if (!ada) return;
    const res = await api(t, {
      method: 'POST', path: '/settlements', token: ada.token, idemKey: key('noop'),
      body: { transfers: [{ from_handle: 'ada', to_handle: 'bob', amount: 1 }] },
    });
    t.err(res, 403, 'forbidden', {
      ref: 'R11.1', what: 'POST /settlements when the fixture declares no operators',
    });
  });

  test('settlement_operator_ids is retained when the fixture supplies it', ['R11.1'], async (t) => {
    await reset(t, 'eur');
    const op = await login(t, 'op@example.com');
    const bob = await login(t, 'bob@example.com');
    if (!op || !bob) return;
    const ok = await api(t, {
      method: 'POST', path: '/settlements', token: op.token, idemKey: key('isop'),
      body: { transfers: [{ from_handle: 'ada', to_handle: 'bob', amount: 1 }] },
    });
    t.status(ok, 201, { ref: 'R11.1', what: 'POST /settlements as the seeded operator' });
    const no = await api(t, {
      method: 'POST', path: '/settlements', token: bob.token, idemKey: key('notop'),
      body: { transfers: [{ from_handle: 'ada', to_handle: 'bob', amount: 1 }] },
    });
    t.err(no, 403, 'forbidden', { ref: 'R11.3', what: 'POST /settlements as a non-operator' });
  });

  test('unknown top-level fixture fields are ignored', ['R3.4c'], async (t) => {
    const fx = eurCopy();
    fx.future_stage_field = { anything: [1, 2, 3] };
    await resetWith(t, fx, 204);
    const ada = await login(t, 'ada@example.com');
    if (!ada) return;
    const r = await me(t, ada.token);
    t.eq(r.json && r.json.balance, 10000, { ref: 'R3.4c', what: 'state loaded despite an unknown field', res: r });
  });

  test('a fixture missing users is 422 validation_failed', ['R5.8'], async (t) => {
    await reset(t, 'eur');
    const res = await resetWith(t, { currency: 'EUR', minor_units: 2 }, null);
    t.err(res, 422, 'validation_failed', {
      ref: 'R5.8', what: 'POST /_test/reset with no users field',
    });
  });

  test('a fixture field of the wrong JSON type is 400 malformed_request', ['R5.2'], async (t) => {
    await reset(t, 'eur');
    const fx = eurCopy();
    fx.users = 'not an array';
    const res = await resetWith(t, fx, null);
    t.oneOfErr(res, [[400, 'malformed_request'], [422, 'validation_failed']], {
      ref: 'R5.2', what: 'POST /_test/reset with users as a string',
    });
  }, {
    severity: 'advisory',
    why: 'spec 5 reserves 400 malformed_request for a field of the wrong JSON type, but the fixture '
       + 'is not an endpoint field list and 422 validation_failed is a defensible reading for a '
       + 'structurally invalid fixture. Either answer is accepted; a 5xx or a 204 is not.',
  });

  test('a structurally inconsistent fixture is rejected without changing state', ['R5.8'], async (t) => {
    const cases = [
      ['minor_units of 1', (fx) => { fx.minor_units = 1; }],
      ['a handle that fails ^[a-z0-9_]{1,20}$', (fx) => { fx.users[1].handle = 'Bob!'; }],
      ['a handle longer than 20 characters', (fx) => { fx.users[1].handle = 'b'.repeat(21); }],
      ['two users sharing one handle', (fx) => { fx.users[1].handle = fx.users[0].handle; }],
      ['two users sharing one id', (fx) => { fx.users[1].id = fx.users[0].id; }],
      ['two users sharing one email', (fx) => { fx.users[1].email = fx.users[0].email; }],
      ['a seeded payment referencing an unknown user id', (fx) => { fx.payments[0].from_user_id = 'u_nobody'; }],
      ['a seeded request referencing an unknown user id', (fx) => { fx.requests[0].payer_id = 'u_nobody'; }],
      ['a seeded request with an unknown status', (fx) => { fx.requests[0].status = 'weird'; }],
      ['a seeded amount of zero', (fx) => { fx.payments[0].amount = 0; }],
    ];
    for (const [label, mutate] of cases) {
      await reset(t, 'eur');
      const fx = eurCopy();
      mutate(fx);
      const res = await resetWith(t, fx, null);
      t.err(res, 422, 'validation_failed', { ref: 'R5.8', what: `a fixture with ${label}` });
      const ada = await login(t, 'ada@example.com');
      if (ada) {
        const r = await me(t, ada.token);
        t.eq(r.json && r.json.balance, 10000, {
          ref: 'R5.8', what: `state unchanged after rejecting a fixture with ${label}`, res: r,
        });
      }
    }
  }, {
    severity: 'advisory',
    why: 'spec 4 states these as rules on the fixture ("unique across the service", the handle '
       + 'pattern, "minor_units is 0, 2 or 3", "seeded numbers are consistent"), and spec 5 maps a '
       + 'violated stated rule to 422. But spec 4 also promises the harness only sends consistent '
       + 'fixtures, so a service that trusts its input is not contradicting the text. Only the '
       + 'negative-balance case (R4.21) is stated as a reset error, and that check is blocking.',
  });
});
