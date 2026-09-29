// Specification 8 (POST /payments) and the atomicity clauses of specifications 1 and 8.

import { suite, test, seededTotal } from '../lib/runner.mjs';
import { api, reset, login, loginAll, me, balance, sumBalances, pay, activity, key, PAYMENT_FIELDS } from '../lib/helpers.mjs';

suite('04 payments', () => {
  test('a payment returns the documented object and moves money', ['R1.1', 'R8.2', 'R8.3', 'R4.9'], async (t) => {
    await reset(t, 'eur');
    const ada = await login(t, 'ada@example.com');
    const bob = await login(t, 'bob@example.com');
    if (!ada || !bob) return;
    const res = await pay(t, ada.token, { to_handle: 'bob', amount: 1500, note: 'dinner', visibility: 'public' });
    if (!t.status(res, 201, { ref: 'R8.3', what: 'POST /payments' })) return;
    t.fields(res.json, PAYMENT_FIELDS, { ref: 'R8.3', what: 'payment object', res });
    t.deep(
      {
        from_user_id: res.json.from_user_id, from_handle: res.json.from_handle,
        to_user_id: res.json.to_user_id, to_handle: res.json.to_handle,
        amount: res.json.amount, currency: res.json.currency,
        note: res.json.note, visibility: res.json.visibility, request_id: res.json.request_id,
      },
      {
        from_user_id: 'u_ada', from_handle: 'ada', to_user_id: 'u_bob', to_handle: 'bob',
        amount: 1500, currency: 'EUR', note: 'dinner', visibility: 'public', request_id: null,
      },
      { ref: 'R8.3', what: 'payment field values', res },
    );
    t.eq(await balance(t, ada.token), 8500, { ref: 'R4.9', what: 'sender balance after paying 1500' });
    t.eq(await balance(t, bob.token), 4000, { ref: 'R4.9', what: 'receiver balance after being paid 1500' });
  });

  test('note defaults to "" and visibility defaults to public', ['R8.2'], async (t) => {
    await reset(t, 'eur');
    const ada = await login(t, 'ada@example.com');
    if (!ada) return;
    const res = await pay(t, ada.token, { to_handle: 'bob', amount: 10 });
    if (!t.status(res, 201, { ref: 'R8.2', what: 'POST /payments with note and visibility omitted' })) return;
    t.eq(res.json.note, '', { ref: 'R8.2', what: 'default note', res });
    t.eq(res.json.visibility, 'public', { ref: 'R8.2', what: 'default visibility', res });
  });

  test('a balance below amount is 409 insufficient_funds and moves nothing', ['R8.4', 'R8.10'], async (t) => {
    const { tokens } = await loginAll(t, 'eur');
    const before = await sumBalances(t, tokens);
    const res = await pay(t, tokens.dee, { to_handle: 'ada', amount: 101 }); // dee holds 100
    t.err(res, 409, 'insufficient_funds', { ref: 'R8.4', what: 'paying 101 from a wallet holding 100' });
    t.eq(await balance(t, tokens.dee), 100, { ref: 'R8.10', what: 'payer balance after a refused payment' });
    t.eq(await balance(t, tokens.ada), 10000, { ref: 'R8.10', what: 'payee balance after a refused payment' });
    t.eq(await sumBalances(t, tokens), before, { ref: 'R1.7', what: 'total after a refused payment' });

    // "a failed payment leaves no trace in either" wallet: no feed entry either.
    const feed = await activity(t, tokens.dee, { limit: 200 });
    if (t.status(feed, 200, { ref: 'R8.35', what: 'GET /activity' })) {
      t.ok(!(feed.json.payments || []).some((p) => p.amount === 101), {
        ref: 'R8.10', what: 'a refused payment appearing in the feed', res: feed,
        expected: 'no payment of 101 in the feed',
        actual: JSON.stringify(feed.json.payments),
      });
    }
  });

  test('a payment may spend the whole balance but not one unit more', ['R8.4', 'R1.8'], async (t) => {
    await reset(t, 'eur');
    const ada = await login(t, 'ada@example.com');
    if (!ada) return;
    const all = await pay(t, ada.token, { to_handle: 'bob', amount: 10000 });
    t.status(all, 201, { ref: 'R8.4', what: 'paying the entire balance' });
    t.eq(await balance(t, ada.token), 0, { ref: 'R1.8', what: 'balance after spending everything' });
    const one = await pay(t, ada.token, { to_handle: 'bob', amount: 1 });
    t.err(one, 409, 'insufficient_funds', { ref: 'R8.4', what: 'paying 1 from an empty wallet' });
    t.eq(await balance(t, ada.token), 0, { ref: 'R1.8', what: 'balance stays at 0, never negative' });
  });

  test('1000, 1000.0 and 1e3 are the same valid amount', ['R4.2'], async (t) => {
    await reset(t, 'eur');
    const ada = await login(t, 'ada@example.com');
    if (!ada) return;
    for (const literal of ['1000', '1000.0', '1e3', '1E3', '0.1e4']) {
      const res = await api(t, {
        method: 'POST', path: '/payments', token: ada.token, idemKey: key('num'),
        rawBody: `{"to_handle":"bob","amount":${literal}}`,
      });
      if (!t.status(res, 201, { ref: 'R4.2', what: `POST /payments with amount ${literal}` })) continue;
      t.eq(res.json.amount, 1000, { ref: 'R4.2', what: `amount for literal ${literal}`, res });
    }
    t.eq(await balance(t, ada.token), 10000 - 5000, { ref: 'R4.2', what: 'balance after five payments of 1000' });
  });

  test('an amount that is not an integral number is 422', ['R8.5', 'R4.2', 'R5.9'], async (t) => {
    await reset(t, 'eur');
    const ada = await login(t, 'ada@example.com');
    if (!ada) return;
    const literals = ['0', '-1', '-1000', '1000000001', '0.5', '1000.5', '1e-3', '1e999', '"1000"', 'true', 'false', 'null', '[1]', '{"a":1}'];
    for (const literal of literals) {
      const res = await api(t, {
        method: 'POST', path: '/payments', token: ada.token, idemKey: key('bad'),
        rawBody: `{"to_handle":"bob","amount":${literal}}`,
      });
      t.err(res, 422, 'validation_failed', { ref: 'R8.5', what: `POST /payments with amount ${literal}` });
    }
    const missing = await api(t, { method: 'POST', path: '/payments', token: ada.token, idemKey: key('bad'), body: { to_handle: 'bob' } });
    t.err(missing, 422, 'validation_failed', { ref: 'R5.8', what: 'POST /payments with no amount' });
    t.eq(await balance(t, ada.token), 10000, { ref: 'R8.10', what: 'balance after only rejected payments' });
  });

  test('the maximum single amount of 1000000000 is accepted', ['R4.17'], async (t) => {
    await reset(t, 'eur');
    const rich = await login(t, 'rich@example.com');
    const bob = await login(t, 'bob@example.com');
    if (!rich || !bob) return;
    const res = await pay(t, rich.token, { to_handle: 'bob', amount: 1000000000 });
    if (!t.status(res, 201, { ref: 'R4.17', what: 'POST /payments of 1000000000' })) return;
    t.eq(res.json.amount, 1000000000, { ref: 'R4.17', what: 'amount echoed', res });
    t.eq(await balance(t, bob.token), 2500 + 1000000000, { ref: 'R4.17', what: 'receiver balance' });
  });

  test('minor-unit arithmetic stays exact at the top of the range', ['R4.17'], async (t) => {
    await reset(t, 'big');
    const ada = await login(t, 'ada@example.com');
    const bob = await login(t, 'bob@example.com');
    if (!ada || !bob) return;
    const res = await pay(t, ada.token, { to_handle: 'bob', amount: 1 });
    if (!t.status(res, 201, { ref: 'R4.17', what: 'POST /payments of 1 from a 2^53-1 balance' })) return;
    t.eq(await balance(t, ada.token), 9007199254740990, { ref: 'R4.17', what: 'sender balance stays exact' });
    t.eq(await balance(t, bob.token), 1, { ref: 'R4.17', what: 'receiver balance' });
    const b = await pay(t, ada.token, { to_handle: 'bob', amount: 1000000000 });
    if (!t.status(b, 201, { ref: 'R4.17', what: 'a second large payment' })) return;
    t.eq(await balance(t, ada.token), 9007199254740990 - 1000000000, { ref: 'R4.17', what: 'sender balance after 1e9' });
    t.eq(await balance(t, bob.token), 1000000001, { ref: 'R4.17', what: 'receiver balance after 1e9' });
    t.eq(await sumBalances(t, { ada: ada.token, bob: bob.token }), seededTotal('big'), {
      ref: 'R1.7', what: 'total across the pair',
    });
  });

  test('paying your own handle is 422 self_payment', ['R8.6'], async (t) => {
    await reset(t, 'eur');
    const ada = await login(t, 'ada@example.com');
    if (!ada) return;
    const res = await pay(t, ada.token, { to_handle: 'ada', amount: 100 });
    t.err(res, 422, 'self_payment', { ref: 'R8.6', what: 'POST /payments to the caller own handle' });
    t.eq(await balance(t, ada.token), 10000, { ref: 'R8.10', what: 'balance after a self payment attempt' });
  });

  test('self_payment is decided before the balance is consulted', ['R8.6'], async (t) => {
    await reset(t, 'eur');
    const cy = await login(t, 'cy@example.com'); // balance 0
    if (!cy) return;
    const res = await pay(t, cy.token, { to_handle: 'cy', amount: 100 });
    t.err(res, 422, 'self_payment', {
      ref: 'R8.6', what: 'a self payment of 100 from a wallet holding 0',
    });
  }, {
    severity: 'advisory',
    why: 'The specification lists insufficient_funds and self_payment in one table without ordering '
       + 'them. spec 11 states entry errors precede insufficient funds for settlements, which '
       + 'suggests the same order here, but spec 8 does not say so.',
  });

  test('an unknown handle is 404, ahead of any balance question', ['R8.9'], async (t) => {
    await reset(t, 'eur');
    const cy = await login(t, 'cy@example.com'); // balance 0
    if (!cy) return;
    for (const handle of ['nobody', 'ada_missing', 'zzz']) {
      const res = await pay(t, cy.token, { to_handle: handle, amount: 100 });
      t.err(res, 404, 'not_found', { ref: 'R8.9', what: `POST /payments to unknown handle ${handle}` });
    }
  });

  test('a handle differing only in case does not resolve', ['R4.3'], async (t) => {
    await reset(t, 'eur');
    const ada = await login(t, 'ada@example.com');
    if (!ada) return;
    for (const handle of ['BOB', 'Bob', 'bOb']) {
      const res = await pay(t, ada.token, { to_handle: handle, amount: 1 });
      t.oneOfErr(res, [[404, 'not_found'], [422, 'validation_failed']], {
        ref: 'R4.3', what: `POST /payments to ${handle} when the handle is "bob"`,
      });
    }
  });

  test('a syntactically impossible handle is rejected, never resolved', ['R4.3', 'R8.9'], async (t) => {
    await reset(t, 'eur');
    const ada = await login(t, 'ada@example.com');
    if (!ada) return;
    for (const handle of ['', 'ada!', 'a'.repeat(21), 'has space', 'ada\n']) {
      const res = await pay(t, ada.token, { to_handle: handle, amount: 1 });
      t.oneOfErr(res, [[404, 'not_found'], [422, 'validation_failed']], {
        ref: 'R8.9', what: `POST /payments to handle ${JSON.stringify(handle)}`,
      });
    }
  }, {
    severity: 'advisory',
    why: 'spec 5 maps a correctly typed field with an invalid format to 422 while spec 8 maps an '
       + 'unresolvable handle to 404. Both readings are available for a handle that cannot exist; '
       + 'the blocking requirement is that no money moves and the status is one of the two.',
  });

  test('to_handle of the wrong JSON type is 400, and absent is 422', ['R5.2', 'R5.8'], async (t) => {
    await reset(t, 'eur');
    const ada = await login(t, 'ada@example.com');
    if (!ada) return;
    for (const literal of ['5', 'true', 'null', '["bob"]', '{"h":"bob"}']) {
      const res = await api(t, {
        method: 'POST', path: '/payments', token: ada.token, idemKey: key('th'),
        rawBody: `{"to_handle":${literal},"amount":10}`,
      });
      t.err(res, 400, 'malformed_request', { ref: 'R5.2', what: `POST /payments with to_handle ${literal}` });
    }
    const absent = await api(t, { method: 'POST', path: '/payments', token: ada.token, idemKey: key('th'), body: { amount: 10 } });
    t.err(absent, 422, 'validation_failed', { ref: 'R5.8', what: 'POST /payments with no to_handle' });
  });

  test('a note longer than 200 characters is 422 and 200 is accepted', ['R8.7'], async (t) => {
    await reset(t, 'eur');
    const ada = await login(t, 'ada@example.com');
    if (!ada) return;
    const ok = await pay(t, ada.token, { to_handle: 'bob', amount: 1, note: 'x'.repeat(200) });
    if (t.status(ok, 201, { ref: 'R8.7', what: 'a note of exactly 200 characters' })) {
      t.eq(ok.json.note.length, 200, { ref: 'R8.11', what: 'the 200-character note round trip', res: ok });
    }
    const tooLong = await pay(t, ada.token, { to_handle: 'bob', amount: 1, note: 'x'.repeat(201) });
    t.err(tooLong, 422, 'validation_failed', { ref: 'R8.7', what: 'a note of 201 characters' });
  });

  test('a note of the wrong JSON type, including null, is 422', ['R5.10'], async (t) => {
    await reset(t, 'eur');
    const ada = await login(t, 'ada@example.com');
    if (!ada) return;
    for (const literal of ['null', '5', 'true', '["a"]', '{"a":1}']) {
      const res = await api(t, {
        method: 'POST', path: '/payments', token: ada.token, idemKey: key('note'),
        rawBody: `{"to_handle":"bob","amount":1,"note":${literal}}`,
      });
      t.err(res, 422, 'validation_failed', { ref: 'R5.10', what: `POST /payments with note ${literal}` });
    }
  });

  test('a note is stored and returned verbatim', ['R8.11'], async (t) => {
    await reset(t, 'eur');
    const ada = await login(t, 'ada@example.com');
    const bob = await login(t, 'bob@example.com');
    if (!ada || !bob) return;
    const notes = [
      '  leading and trailing  ',
      'line\nbreak\ttab',
      'emoji 👍🏽 and 🇪🇺 flags',
      'zalgo ñ combining',
      'rtl مرحبا mixed',
      'quotes " \' and backslash \\ and </script>',
      'nul\u0000inside',
      '​ zero width ​',
      'é vs é',
    ];
    for (const note of notes) {
      const res = await pay(t, ada.token, { to_handle: 'bob', amount: 1, note });
      if (!t.status(res, 201, { ref: 'R8.11', what: `POST /payments with note ${JSON.stringify(note)}` })) continue;
      t.eq(res.json.note, note, { ref: 'R8.11', what: `note echoed for ${JSON.stringify(note)}`, res });
      // And it must survive the read path too, byte for byte.
      const feed = await activity(t, bob.token, { limit: 200 });
      const found = (feed.json && feed.json.payments || []).find((p) => p.payment_id === res.json.payment_id);
      t.ok(found && found.note === note, {
        ref: 'R8.11', what: `note read back from /activity for ${JSON.stringify(note)}`, res: feed,
        expected: JSON.stringify(note),
        actual: found ? JSON.stringify(found.note) : 'the payment was not in the feed',
      });
    }
  });

  test('a 200-code-point note of astral characters is accepted', ['R8.7'], async (t) => {
    await reset(t, 'eur');
    const ada = await login(t, 'ada@example.com');
    if (!ada) return;
    const note = '\u{1F600}'.repeat(200); // 200 code points, 400 UTF-16 code units
    const res = await pay(t, ada.token, { to_handle: 'bob', amount: 1, note });
    if (!t.status(res, 201, { ref: 'R8.7', what: 'a note of 200 astral code points' })) return;
    t.eq(res.json.note, note, { ref: 'R8.11', what: 'the astral note round trip', res });
  }, {
    severity: 'advisory',
    why: 'spec 8 says "longer than 200 characters" without defining character. Code points is the '
       + 'natural reading; an implementation counting UTF-16 code units rejects this at 422 without '
       + 'contradicting the text. The ASCII 200/201 boundary is the blocking check.',
  });

  test('visibility must be public or private', ['R8.8'], async (t) => {
    await reset(t, 'eur');
    const ada = await login(t, 'ada@example.com');
    if (!ada) return;
    const priv = await pay(t, ada.token, { to_handle: 'bob', amount: 1, visibility: 'private' });
    if (t.status(priv, 201, { ref: 'R8.8', what: 'visibility private' })) {
      t.eq(priv.json.visibility, 'private', { ref: 'R8.8', what: 'visibility echoed', res: priv });
    }
    for (const literal of ['"Public"', '"PRIVATE"', '"secret"', '""', 'null', '1', 'true', '["public"]']) {
      const res = await api(t, {
        method: 'POST', path: '/payments', token: ada.token, idemKey: key('vis'),
        rawBody: `{"to_handle":"bob","amount":1,"visibility":${literal}}`,
      });
      t.err(res, 422, 'validation_failed', { ref: 'R8.8', what: `POST /payments with visibility ${literal}` });
    }
  });

  test('an ordinary payment carries settlement_id null', ['D4'], async (t) => {
    await reset(t, 'eur');
    const ada = await login(t, 'ada@example.com');
    if (!ada) return;
    const res = await pay(t, ada.token, { to_handle: 'bob', amount: 1 });
    if (!t.status(res, 201, { ref: 'D4', what: 'POST /payments' })) return;
    t.ok('settlement_id' in res.json && res.json.settlement_id === null, {
      ref: 'D4', what: 'settlement_id on a non-settlement payment', res,
      expected: 'the field present and null',
      actual: 'settlement_id' in res.json ? JSON.stringify(res.json.settlement_id) : 'the field is absent',
    });
  }, {
    severity: 'advisory',
    why: 'spec 11 says nonmembers expose null for the settlement_id field, which implies the field '
       + 'exists on ordinary payments; spec 8 example objects do not list it. Decision D4 requires '
       + 'it always present. A service that omits it on non-members reads spec 8 literally.',
  });

  test('every wallet total is preserved across a run of payments', ['R1.7'], async (t) => {
    const { tokens } = await loginAll(t, 'eur');
    const total = seededTotal('eur');
    t.eq(await sumBalances(t, tokens), total, { ref: 'R1.7', what: 'total after reset' });
    const moves = [
      ['ada', 'bob', 1], ['bob', 'cy', 2500], ['cy', 'dee', 2500], ['dee', 'eve', 2600],
      ['eve', 'rich', 3100], ['rich', 'ada', 1000000000], ['ada', 'op', 5], ['op', 'bob', 5],
    ];
    for (const [from, to, amount] of moves) {
      const res = await pay(t, tokens[from], { to_handle: to, amount });
      t.status(res, 201, { ref: 'R1.7', what: `${from} -> ${to} of ${amount}` });
      t.eq(await sumBalances(t, tokens), total, { ref: 'R1.7', what: `total after ${from} -> ${to}` });
    }
  });
});
