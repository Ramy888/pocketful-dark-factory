// Specification 11: atomic net settlements.

import { suite, test, seededTotal } from '../lib/runner.mjs';
import {
  api, loginAll, balance, sumBalances, requests, activity,
  key, PAYMENT_FIELDS,
} from '../lib/helpers.mjs';

async function settle(t, c, who, transfers, idemKey) {
  return api(t, {
    method: 'POST', path: '/settlements', token: c.tokens[who],
    idemKey: idemKey || key('stl'), body: { transfers },
  });
}

const T = (from, to, amount, extra = {}) => ({ from_handle: from, to_handle: to, amount, ...extra });

suite('09 settlements', () => {
  test('a settlement returns settlement_id, committed_at and payments in input order', ['R1.5', 'R11.12', 'R11.16'], async (t) => {
    const c = await loginAll(t);
    const transfers = [T('ada', 'bob', 100), T('bob', 'cy', 50), T('rich', 'eve', 7)];
    const res = await settle(t, c, 'op', transfers);
    if (!t.status(res, 201, { ref: 'R11.12', what: 'POST /settlements' })) return;
    t.fields(res.json, ['settlement_id', 'committed_at', 'payments'], {
      ref: 'R11.12', what: 'settlement response', res,
    });
    t.eq(res.json.payments.length, transfers.length, {
      ref: 'R11.16', what: 'one receipt per transfer', res,
    });
    t.deep(
      res.json.payments.map((p) => [p.from_handle, p.to_handle, p.amount]),
      transfers.map((x) => [x.from_handle, x.to_handle, x.amount]),
      { ref: 'R11.12', what: 'payments in input order', res },
    );
    for (const p of res.json.payments) {
      t.fields(p, PAYMENT_FIELDS, { ref: 'R11.13', what: 'a settlement member is an ordinary payment', res });
    }
  });

  test('members carry the settlement id, a null request_id and one shared created_at', ['R11.13', 'R11.14'], async (t) => {
    const c = await loginAll(t);
    const res = await settle(t, c, 'op', [T('ada', 'bob', 100), T('bob', 'cy', 50)]);
    if (!t.status(res, 201, { ref: 'R11.13', what: 'POST /settlements' })) return;
    for (const p of res.json.payments) {
      t.eq(p.settlement_id, res.json.settlement_id, {
        ref: 'R11.13', what: `settlement_id on the ${p.from_handle} -> ${p.to_handle} member`, res,
      });
      t.eq(p.request_id, null, {
        ref: 'R11.14', what: `request_id on the ${p.from_handle} -> ${p.to_handle} member`, res,
      });
      t.eq(p.created_at, res.json.committed_at, {
        ref: 'R11.14', what: `created_at equals committed_at on the ${p.from_handle} -> ${p.to_handle} member`, res,
      });
    }
    const stamps = new Set(res.json.payments.map((p) => p.created_at));
    t.eq(stamps.size, 1, {
      ref: 'R11.14', what: 'every member shares one created_at', res,
      expected: '1 distinct created_at', actual: `${stamps.size}: ${JSON.stringify([...stamps])}`,
    });

    // Reading the members back through the feed must show the same linkage.
    const feed = await activity(t, c.tokens.ada, { limit: 200 });
    const member = ((feed.json || {}).payments || []).find((p) => p.payment_id === res.json.payments[0].payment_id);
    t.eq(member && member.settlement_id, res.json.settlement_id, {
      ref: 'R11.13', what: 'settlement_id as read from the activity feed', res: feed,
    });
  });

  test('settlements require an operator: 401 without a token, 403 without the permission', ['R11.3'], async (t) => {
    const c = await loginAll(t);
    const body = { transfers: [T('ada', 'bob', 1)] };
    const anon = await api(t, { method: 'POST', path: '/settlements', idemKey: key('a'), body });
    t.err(anon, 401, 'unauthenticated', { ref: 'R11.3', what: 'POST /settlements with no token' });
    const garbage = await api(t, { method: 'POST', path: '/settlements', token: 'nonsense', idemKey: key('a'), body });
    t.err(garbage, 401, 'unauthenticated', { ref: 'R11.3', what: 'POST /settlements with an unknown token' });
    for (const who of ['ada', 'bob', 'cy']) {
      const res = await api(t, { method: 'POST', path: '/settlements', token: c.tokens[who], idemKey: key('a'), body });
      t.err(res, 403, 'forbidden', { ref: 'R11.3', what: `POST /settlements as ${who}, who is not an operator` });
    }
    const ok = await settle(t, c, 'op', [T('ada', 'bob', 1)]);
    t.status(ok, 201, { ref: 'R11.3', what: 'POST /settlements as an operator' });
  });

  test('an operator still needs an idempotency key', ['R11.3', 'R7.5'], async (t) => {
    const c = await loginAll(t);
    const res = await api(t, { method: 'POST', path: '/settlements', token: c.tokens.op, body: { transfers: [T('ada', 'bob', 1)] } });
    t.err(res, 400, 'missing_idempotency_key', { ref: 'R7.5', what: 'POST /settlements with no Idempotency-Key' });
  });

  test('a non-operator is refused before the idempotency key is examined', ['D15'], async (t) => {
    const c = await loginAll(t);
    const res = await api(t, { method: 'POST', path: '/settlements', token: c.tokens.ada, body: { transfers: [T('ada', 'bob', 1)] } });
    t.err(res, 403, 'forbidden', {
      ref: 'D15', what: 'POST /settlements as a non-operator with no Idempotency-Key',
    });
  }, {
    severity: 'advisory',
    why: 'spec 11 names both 401 and 403 as the gate on the endpoint but does not order the 403 '
       + 'against the 400 for a missing key. Decision D15 puts the operator check first.',
  });

  test('transfers must contain 1 to 32 objects', ['R11.5'], async (t) => {
    const c = await loginAll(t);
    const empty = await settle(t, c, 'op', []);
    t.err(empty, 422, 'validation_failed', { ref: 'R11.5', what: 'a settlement with 0 transfers' });

    const one = await settle(t, c, 'op', [T('ada', 'bob', 1)]);
    t.status(one, 201, { ref: 'R11.5', what: 'a settlement with 1 transfer' });

    const thirtyTwo = Array.from({ length: 32 }, () => T('rich', 'ada', 1));
    const max = await settle(t, c, 'op', thirtyTwo);
    if (t.status(max, 201, { ref: 'R11.5', what: 'a settlement with 32 transfers' })) {
      t.eq(max.json.payments.length, 32, { ref: 'R11.16', what: '32 receipts', res: max });
    }
    const thirtyThree = Array.from({ length: 33 }, () => T('rich', 'ada', 1));
    const over = await settle(t, c, 'op', thirtyThree);
    t.err(over, 422, 'validation_failed', { ref: 'R11.5', what: 'a settlement with 33 transfers' });
  });

  test('a malformed batch shape is 422 validation_failed', ['R11.7'], async (t) => {
    const c = await loginAll(t);
    const noField = await api(t, { method: 'POST', path: '/settlements', token: c.tokens.op, idemKey: key('m'), body: {} });
    t.err(noField, 422, 'validation_failed', { ref: 'R11.7', what: 'POST /settlements with no transfers field' });
    for (const literal of ['"x"', '5', 'true', 'null', '{"0":{"from_handle":"ada"}}']) {
      const res = await api(t, {
        method: 'POST', path: '/settlements', token: c.tokens.op, idemKey: key('m'),
        rawBody: `{"transfers":${literal}}`,
      });
      t.err(res, 422, 'validation_failed', { ref: 'R11.7', what: `transfers as ${literal}` });
    }
    for (const literal of ['[5]', '["x"]', '[null]', '[[]]', '[{}]']) {
      const res = await api(t, {
        method: 'POST', path: '/settlements', token: c.tokens.op, idemKey: key('m'),
        rawBody: `{"transfers":${literal}}`,
      });
      t.err(res, 422, 'validation_failed', { ref: 'R11.7', what: `a transfers entry of ${literal}` });
    }
    const missingFields = [
      ['no from_handle', { to_handle: 'bob', amount: 1 }],
      ['no to_handle', { from_handle: 'ada', amount: 1 }],
      ['no amount', { from_handle: 'ada', to_handle: 'bob' }],
    ];
    for (const [label, entry] of missingFields) {
      const res = await settle(t, c, 'op', [entry]);
      t.err(res, 422, 'validation_failed', { ref: 'R11.7', what: `a transfer with ${label}` });
    }
  });

  test('each entry follows the ordinary amount rules', ['R11.6'], async (t) => {
    const c = await loginAll(t);
    for (const literal of ['0', '-1', '1000000001', '1.5', '"10"', 'true', 'null']) {
      const res = await api(t, {
        method: 'POST', path: '/settlements', token: c.tokens.op, idemKey: key('amt'),
        rawBody: `{"transfers":[{"from_handle":"ada","to_handle":"bob","amount":${literal}}]}`,
      });
      t.err(res, 422, 'validation_failed', { ref: 'R11.6', what: `a transfer amount of ${literal}` });
    }
    for (const literal of ['1000', '1000.0', '1e3']) {
      const res = await api(t, {
        method: 'POST', path: '/settlements', token: c.tokens.op, idemKey: key('amt'),
        rawBody: `{"transfers":[{"from_handle":"ada","to_handle":"bob","amount":${literal}}]}`,
      });
      if (t.status(res, 201, { ref: 'R4.2', what: `a transfer amount written as ${literal}` })) {
        t.eq(res.json.payments[0].amount, 1000, { ref: 'R4.2', what: `amount for ${literal}`, res });
      }
    }
  });

  test('each entry follows the ordinary note and visibility rules', ['R11.6'], async (t) => {
    const c = await loginAll(t);
    const defaults = await settle(t, c, 'op', [T('ada', 'bob', 5)]);
    if (t.status(defaults, 201, { ref: 'R11.6', what: 'a transfer with no note or visibility' })) {
      t.eq(defaults.json.payments[0].note, '', { ref: 'R11.6', what: 'the default note is empty', res: defaults });
      t.eq(defaults.json.payments[0].visibility, 'public', { ref: 'R11.6', what: 'the default visibility is public', res: defaults });
    }
    const given = await settle(t, c, 'op', [T('ada', 'bob', 5, { note: 'netting 👍', visibility: 'private' })]);
    if (t.status(given, 201, { ref: 'R11.6', what: 'a transfer with a note and visibility' })) {
      t.eq(given.json.payments[0].note, 'netting 👍', { ref: 'R11.6', what: 'the note verbatim', res: given });
      t.eq(given.json.payments[0].visibility, 'private', { ref: 'R11.6', what: 'the visibility', res: given });
    }
    const longNote = await settle(t, c, 'op', [T('ada', 'bob', 5, { note: 'x'.repeat(201) })]);
    t.err(longNote, 422, 'validation_failed', { ref: 'R11.6', what: 'a transfer note of 201 characters' });
    const okNote = await settle(t, c, 'op', [T('ada', 'bob', 5, { note: 'x'.repeat(200) })]);
    t.status(okNote, 201, { ref: 'R11.6', what: 'a transfer note of exactly 200 characters' });
    for (const literal of ['null', '5', 'true']) {
      const res = await api(t, {
        method: 'POST', path: '/settlements', token: c.tokens.op, idemKey: key('n'),
        rawBody: `{"transfers":[{"from_handle":"ada","to_handle":"bob","amount":5,"note":${literal}}]}`,
      });
      t.err(res, 422, 'validation_failed', { ref: 'R11.6', what: `a transfer note of ${literal}` });
    }
    for (const literal of ['"Public"', '"nope"', 'null', '3']) {
      const res = await api(t, {
        method: 'POST', path: '/settlements', token: c.tokens.op, idemKey: key('v'),
        rawBody: `{"transfers":[{"from_handle":"ada","to_handle":"bob","amount":5,"visibility":${literal}}]}`,
      });
      t.err(res, 422, 'validation_failed', { ref: 'R11.6', what: `a transfer visibility of ${literal}` });
    }
  });

  test('unknown fields inside a transfer are ignored', ['R11.9'], async (t) => {
    const c = await loginAll(t);
    const res = await settle(t, c, 'op', [T('ada', 'bob', 5, { memo: 'ignored', request_id: 'rq_x', settlement_id: 'sp_x' })]);
    if (!t.status(res, 201, { ref: 'R11.9', what: 'a transfer carrying unknown fields' })) return;
    t.eq(res.json.payments[0].request_id, null, { ref: 'R11.14', what: 'request_id is not taken from the input', res });
    t.eq(res.json.payments[0].settlement_id, res.json.settlement_id, {
      ref: 'R11.13', what: 'settlement_id is server assigned, not taken from the input', res,
    });
  });

  test('an unknown handle is 404 and a self transfer is 422 self_payment', ['R11.7'], async (t) => {
    const c = await loginAll(t);
    for (const entry of [T('nobody', 'bob', 1), T('ada', 'nobody', 1), T('ghost', 'ghost2', 1)]) {
      const res = await settle(t, c, 'op', [entry]);
      t.err(res, 404, 'not_found', { ref: 'R11.7', what: `a transfer ${entry.from_handle} -> ${entry.to_handle}` });
    }
    for (const handle of ['ada', 'op', 'cy']) {
      const res = await settle(t, c, 'op', [T(handle, handle, 1)]);
      t.err(res, 422, 'self_payment', { ref: 'R11.7', what: `a self transfer on ${handle}` });
    }
  });

  test('within one entry, a self transfer is reported ahead of the unknown handle', ['D23'], async (t) => {
    const c = await loginAll(t);
    // from_handle and to_handle are the same string, and that string is not a handle.
    // The entry is both a self transfer and an unknown-handle reference.
    for (const handle of ['ghost', 'nobody', 'not_a_user']) {
      const res = await settle(t, c, 'op', [T(handle, handle, 1)]);
      t.err(res, 422, 'self_payment', {
        ref: 'D23', what: `a transfer from ${handle} to ${handle}, where ${handle} does not exist`,
      });
    }
  }, {
    severity: 'advisory',
    why: 'Decision D23 orders self-transfer, a property of the entry itself, ahead of the handle '
       + 'lookup. spec 11 states both mappings in one sentence and orders only entries against '
       + 'each other, not the checks within an entry. 404 not_found is at least as defensible '
       + 'here: nothing can be transferred out of a wallet that does not exist, and unlike '
       + 'spec 8 self_payment, there is no caller handle involved that is known to exist. This '
       + 'is the only case where the two readings differ, and no money moves either way.',
  });

  test('entry errors take precedence in input order, ahead of insufficient funds', ['R11.8'], async (t) => {
    const c = await loginAll(t);
    // ada holds 10000; a transfer of 20000 out of ada is collectively unaffordable.
    const cases = [
      ['an unaffordable transfer then a self transfer', [T('ada', 'bob', 20000), T('ada', 'ada', 100)], 422, 'self_payment'],
      ['an unaffordable transfer then an unknown handle', [T('ada', 'bob', 20000), T('nobody', 'bob', 1)], 404, 'not_found'],
      ['an unaffordable transfer then a bad amount', [T('ada', 'bob', 20000), T('ada', 'bob', 0)], 422, 'validation_failed'],
      ['a self transfer then an unknown handle', [T('ada', 'ada', 1), T('nobody', 'bob', 1)], 422, 'self_payment'],
      ['an unknown handle then a self transfer', [T('nobody', 'bob', 1), T('ada', 'ada', 1)], 404, 'not_found'],
      ['a bad amount then an unknown handle', [T('ada', 'bob', 0), T('nobody', 'bob', 1)], 422, 'validation_failed'],
      ['an unknown handle then a bad amount', [T('nobody', 'bob', 1), T('ada', 'bob', 0)], 404, 'not_found'],
      ['a valid entry, then a self transfer, then an unknown handle', [T('ada', 'bob', 1), T('ada', 'ada', 1), T('nobody', 'bob', 1)], 422, 'self_payment'],
      ['a valid entry, then an unknown handle, then a self transfer', [T('ada', 'bob', 1), T('nobody', 'bob', 1), T('ada', 'ada', 1)], 404, 'not_found'],
    ];
    const before = await sumBalances(t, c.tokens);
    for (const [label, transfers, status, code] of cases) {
      const res = await settle(t, c, 'op', transfers);
      t.err(res, status, code, { ref: 'R11.8', what: label });
    }
    t.eq(await sumBalances(t, c.tokens), before, {
      ref: 'R11.11', what: 'the total after only rejected settlements',
    });
    t.eq(await balance(t, c.tokens.ada), 10000, {
      ref: 'R11.11', what: "ada's balance after only rejected settlements",
    });
  });

  test('affordability is judged on the net position of every wallet', ['R11.10'], async (t) => {
    const c = await loginAll(t);
    // bob holds 2500 and could not send 12500 on its own, but nets to exactly 0.
    const res = await settle(t, c, 'op', [T('ada', 'bob', 10000), T('bob', 'cy', 12500)]);
    if (!t.status(res, 201, { ref: 'R11.10', what: 'a chain that only nets out' })) return;
    t.eq(await balance(t, c.tokens.ada), 0, { ref: 'R11.10', what: 'ada ends at 0' });
    t.eq(await balance(t, c.tokens.bob), 0, { ref: 'R11.10', what: 'bob ends at 0' });
    t.eq(await balance(t, c.tokens.cy), 12500, { ref: 'R11.10', what: 'cy ends at 12500' });
    t.eq(await sumBalances(t, c.tokens), seededTotal('eur'), { ref: 'R1.7', what: 'the seeded total' });
  });

  test('net affordability does not depend on the order of the transfers', ['R11.10'], async (t) => {
    const c = await loginAll(t);
    // The same net effect, with the draining transfer listed first.
    const res = await settle(t, c, 'op', [T('bob', 'cy', 12500), T('ada', 'bob', 10000)]);
    if (!t.status(res, 201, { ref: 'R11.10', what: 'the same chain in the opposite order' })) return;
    t.eq(await balance(t, c.tokens.bob), 0, { ref: 'R11.10', what: 'bob ends at 0' });
    t.eq(await balance(t, c.tokens.cy), 12500, { ref: 'R11.10', what: 'cy ends at 12500' });
  });

  test('a collectively unaffordable settlement is 409 and commits nothing', ['R11.10', 'R11.11'], async (t) => {
    const c = await loginAll(t);
    const before = await sumBalances(t, c.tokens);
    const feedBefore = await activity(t, c.tokens.ada, { limit: 200 });
    const cases = [
      ['one wallet one unit short', [T('ada', 'bob', 10001)]],
      ['a chain one unit short', [T('ada', 'bob', 10000), T('bob', 'cy', 12501)]],
      ['a wallet that would go negative mid-net', [T('cy', 'bob', 1)]],
      ['a large unaffordable transfer', [T('ada', 'bob', 1000000000)]],
    ];
    for (const [label, transfers] of cases) {
      const res = await settle(t, c, 'op', transfers);
      t.err(res, 409, 'insufficient_funds', { ref: 'R11.10', what: label });
    }
    t.eq(await sumBalances(t, c.tokens), before, { ref: 'R11.11', what: 'the total after refused settlements' });
    t.eq(await balance(t, c.tokens.ada), 10000, { ref: 'R11.11', what: "ada's balance" });
    t.eq(await balance(t, c.tokens.bob), 2500, { ref: 'R11.11', what: "bob's balance" });
    t.eq(await balance(t, c.tokens.cy), 0, { ref: 'R1.8', what: "cy's balance never went negative" });
    const feedAfter = await activity(t, c.tokens.ada, { limit: 200 });
    t.eq((feedAfter.json.payments || []).length, (feedBefore.json.payments || []).length, {
      ref: 'R11.11', what: 'the feed length after refused settlements', res: feedAfter,
    });
  });

  test('a failed settlement claims no idempotency key', ['R11.11'], async (t) => {
    const c = await loginAll(t);
    for (const [label, badTransfers] of [
      ['a collectively unaffordable batch', [T('ada', 'bob', 10001)]],
      ['a self transfer', [T('ada', 'ada', 1)]],
      ['an unknown handle', [T('nobody', 'bob', 1)]],
      ['an empty batch', []],
    ]) {
      const k = key('freekey');
      const failed = await settle(t, c, 'op', badTransfers, k);
      t.ok(failed.status >= 400 && failed.status < 500, {
        ref: 'R11.11', what: `${label} was refused`, res: failed,
        expected: 'a 4xx status', actual: `HTTP ${failed.status}`,
      });
      // A different body under the same key must be treated as a first use.
      const retry = await settle(t, c, 'op', [T('ada', 'bob', 1)], k);
      t.status(retry, 201, { ref: 'R11.11', what: `reusing the key after ${label}` });
    }
  });

  test('either every movement commits or none does', ['R11.11'], async (t) => {
    const c = await loginAll(t);
    const before = {
      ada: await balance(t, c.tokens.ada),
      bob: await balance(t, c.tokens.bob),
      cy: await balance(t, c.tokens.cy),
    };
    // The last entry is what makes the whole batch unaffordable.
    const res = await settle(t, c, 'op', [T('ada', 'bob', 100), T('bob', 'cy', 50), T('cy', 'ada', 999999)]);
    t.err(res, 409, 'insufficient_funds', { ref: 'R11.11', what: 'a batch whose last entry is unaffordable' });
    t.eq(await balance(t, c.tokens.ada), before.ada, { ref: 'R11.11', what: "ada's balance is untouched" });
    t.eq(await balance(t, c.tokens.bob), before.bob, { ref: 'R11.11', what: "bob's balance is untouched" });
    t.eq(await balance(t, c.tokens.cy), before.cy, { ref: 'R11.11', what: "cy's balance is untouched" });
    const feed = await activity(t, c.tokens.ada, { limit: 200 });
    t.ok(!((feed.json || {}).payments || []).some((p) => p.amount === 100 && p.to_handle === 'bob' && p.settlement_id), {
      ref: 'R11.11', what: 'a partial member in the feed', res: feed,
      expected: 'no settlement member from the refused batch',
      actual: JSON.stringify((feed.json || {}).payments),
    });
  });

  test('a cycle that nets to zero commits and leaves balances unchanged', ['R11.10'], async (t) => {
    const c = await loginAll(t);
    const before = { ada: await balance(t, c.tokens.ada), bob: await balance(t, c.tokens.bob) };
    const res = await settle(t, c, 'op', [T('ada', 'bob', 100), T('bob', 'ada', 100)]);
    if (!t.status(res, 201, { ref: 'R11.10', what: 'a two-step cycle netting to zero' })) return;
    t.eq(res.json.payments.length, 2, { ref: 'R11.16', what: 'both movements produced receipts', res });
    t.eq(await balance(t, c.tokens.ada), before.ada, { ref: 'R11.10', what: "ada's net position" });
    t.eq(await balance(t, c.tokens.bob), before.bob, { ref: 'R11.10', what: "bob's net position" });
    // And both are real, separately visible payments.
    const feed = await activity(t, c.tokens.ada, { limit: 200 });
    const members = ((feed.json || {}).payments || []).filter((p) => p.settlement_id === res.json.settlement_id);
    t.eq(members.length, 2, { ref: 'R11.15', what: 'both members appear in the feed', res: feed });
  });

  test('a batch may repeat an identical transfer and both apply', ['R11.12'], async (t) => {
    const c = await loginAll(t);
    const res = await settle(t, c, 'op', [T('ada', 'bob', 100), T('ada', 'bob', 100)]);
    if (!t.status(res, 201, { ref: 'R11.12', what: 'a batch with two identical transfers' })) return;
    t.eq(res.json.payments.length, 2, { ref: 'R11.16', what: 'two receipts', res });
    t.ok(res.json.payments[0].payment_id !== res.json.payments[1].payment_id, {
      ref: 'R11.12', what: 'the two members are distinct payments', res,
      expected: 'two different payment ids',
      actual: `both ${res.json.payments[0].payment_id}`,
    });
    t.eq(await balance(t, c.tokens.ada), 10000 - 200, { ref: 'R11.12', what: "ada's balance after both" });
    t.eq(await balance(t, c.tokens.bob), 2500 + 200, { ref: 'R11.12', what: "bob's balance after both" });
  });

  test('members follow the ordinary feed visibility rule', ['R11.15'], async (t) => {
    const c = await loginAll(t);
    const res = await settle(t, c, 'op', [
      T('ada', 'bob', 10, { visibility: 'private', note: 'quiet' }),
      T('rich', 'eve', 11, { visibility: 'public', note: 'loud' }),
    ]);
    if (!t.status(res, 201, { ref: 'R11.15', what: 'a settlement with one private and one public member' })) return;
    const priv = res.json.payments[0];
    const pub = res.json.payments[1];

    for (const who of ['ada', 'bob']) {
      const feed = await activity(t, c.tokens[who], { limit: 200 });
      t.ok(((feed.json || {}).payments || []).some((p) => p.payment_id === priv.payment_id), {
        ref: 'R11.15', what: `the private member in ${who}'s feed`, res: feed,
        expected: 'visible to a party', actual: 'not present',
      });
    }
    // Not even the operator sees a private movement it is not a party to.
    for (const who of ['cy', 'op']) {
      const feed = await activity(t, c.tokens[who], { limit: 200 });
      t.ok(!((feed.json || {}).payments || []).some((p) => p.payment_id === priv.payment_id), {
        ref: 'R11.2', what: `the private member in ${who}'s feed`, res: feed,
        expected: 'hidden from a non-party, including an operator', actual: 'present',
      });
      t.ok(((feed.json || {}).payments || []).some((p) => p.payment_id === pub.payment_id), {
        ref: 'R11.15', what: `the public member in ${who}'s feed`, res: feed,
        expected: 'visible to everyone', actual: 'not present',
      });
    }
  });

  test('operator permission grants no access to other users requests or private activity', ['R11.2'], async (t) => {
    const c = await loginAll(t);
    // Private activity between two other users.
    const priv = await api(t, { method: 'POST', path: '/payments', token: c.tokens.ada, idemKey: key('op1'), body: { to_handle: 'bob', amount: 5, visibility: 'private' } });
    if (!t.status(priv, 201, { ref: 'R8.3', what: 'a private payment between ada and bob' })) return;
    const rq = await api(t, { method: 'POST', path: '/requests', token: c.tokens.ada, idemKey: key('op2'), body: { payer_handle: 'bob', amount: 6 } });
    if (!t.status(rq, 201, { ref: 'R8.12', what: 'a request between ada and bob' })) return;

    const feed = await activity(t, c.tokens.op, { limit: 200 });
    if (t.status(feed, 200, { ref: 'R11.2', what: "GET /activity as the operator" })) {
      t.ok(!(feed.json.payments || []).some((p) => p.payment_id === priv.json.payment_id), {
        ref: 'R11.2', what: "the private payment in the operator's feed", res: feed,
        expected: 'not visible to an operator who is not a party', actual: 'present',
      });
      const leaked = (feed.json.payments || []).filter((p) => p.visibility !== 'public' && p.from_user_id !== 'u_op' && p.to_user_id !== 'u_op');
      t.eq(leaked.length, 0, {
        ref: 'R11.2', what: "private items in the operator's feed", res: feed,
        expected: 'none', actual: JSON.stringify(leaked),
      });
    }
    const reqs = await requests(t, c.tokens.op, { limit: 200 });
    if (t.status(reqs, 200, { ref: 'R11.2', what: 'GET /requests as the operator' })) {
      const leaked = (reqs.json.requests || []).filter((r) => r.requester_id !== 'u_op' && r.payer_id !== 'u_op');
      t.eq(leaked.length, 0, {
        ref: 'R11.2', what: "other users' requests in the operator's list", res: reqs,
        expected: 'none', actual: JSON.stringify(leaked),
      });
    }
    // And an operator still may not act on someone else's request.
    const pay = await api(t, { method: 'POST', path: `/requests/${rq.json.request_id}/pay`, token: c.tokens.op, idemKey: key('op3'), body: {} });
    t.err(pay, 403, 'forbidden', { ref: 'R11.2', what: 'an operator paying a request it is not the payer of' });
    const cancel = await api(t, { method: 'POST', path: `/requests/${rq.json.request_id}/cancel`, token: c.tokens.op, body: {} });
    t.err(cancel, 403, 'forbidden', { ref: 'R11.2', what: 'an operator cancelling a request it did not raise' });
  });

  test('a settlement replay returns 200 with the original complete response', ['R11.17'], async (t) => {
    const c = await loginAll(t);
    const transfers = [T('ada', 'bob', 100), T('bob', 'cy', 50)];
    const k = key('rep');
    const first = await settle(t, c, 'op', transfers, k);
    if (!t.status(first, 201, { ref: 'R11.12', what: 'the first settlement' })) return;
    const after = { ada: await balance(t, c.tokens.ada), bob: await balance(t, c.tokens.bob), cy: await balance(t, c.tokens.cy) };

    const replay = await settle(t, c, 'op', transfers, k);
    t.status(replay, 200, { ref: 'R11.17', what: 'replaying the settlement' });
    t.deep(replay.json, first.json, { ref: 'R11.17', what: 'the replayed settlement response', res: replay });
    t.eq(await balance(t, c.tokens.ada), after.ada, { ref: 'R11.17', what: "ada's balance after a replay" });
    t.eq(await balance(t, c.tokens.bob), after.bob, { ref: 'R11.17', what: "bob's balance after a replay" });
    t.eq(await balance(t, c.tokens.cy), after.cy, { ref: 'R11.17', what: "cy's balance after a replay" });

    // A reordered but equal JSON value is still the same body.
    const spaced = JSON.stringify({ transfers }, null, 2);
    const again = await api(t, { method: 'POST', path: '/settlements', token: c.tokens.op, idemKey: k, rawBody: spaced });
    t.status(again, 200, { ref: 'R7.10', what: 'replaying with added whitespace' });
    // A different batch under the same key is a conflict.
    const clash = await settle(t, c, 'op', [T('ada', 'bob', 100)], k);
    t.err(clash, 409, 'idempotency_key_reuse', { ref: 'R7.8', what: 'the same key with a different batch' });
  });

  test('the seeded total survives a run of settlements', ['R1.7'], async (t) => {
    const c = await loginAll(t);
    const total = seededTotal('eur');
    const batches = [
      [T('ada', 'bob', 100), T('bob', 'cy', 50)],
      [T('rich', 'ada', 1000000000), T('ada', 'eve', 500)],
      [T('eve', 'dee', 900), T('dee', 'op', 1000), T('op', 'rich', 1000)],
      Array.from({ length: 32 }, (_, i) => T('rich', i % 2 ? 'ada' : 'bob', i + 1)),
    ];
    for (const transfers of batches) {
      const res = await settle(t, c, 'op', transfers);
      t.status(res, 201, { ref: 'R1.7', what: `a settlement of ${transfers.length} transfers` });
      t.eq(await sumBalances(t, c.tokens), total, {
        ref: 'R1.7', what: `the total after a settlement of ${transfers.length} transfers`,
      });
    }
  });
});
