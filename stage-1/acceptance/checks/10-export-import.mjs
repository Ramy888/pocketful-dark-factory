// Specification 10: export and import, and the preservation list item by item.

import { suite, test, ALT_BASE_URL } from '../lib/runner.mjs';
import { api, reset, login, loginAll, me, balance, activity, requests, key, PW } from '../lib/helpers.mjs';

async function exportState(t, base) {
  const res = await api(t, { path: '/_test/export', base });
  return res;
}

async function importState(t, obj, base, expect = 204) {
  const res = await t.req({
    method: 'POST', path: '/_test/import', base,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  });
  if (expect !== null) t.status(res, expect, { ref: 'R10.4', what: 'POST /_test/import' });
  return res;
}

// A state worth preserving: several accounts, several sessions each, payments of both
// visibilities, requests in every terminal state, a split, a settlement, claimed
// idempotency keys on all five write paths, and one key left free by a 4xx.
async function buildRichState(t) {
  const c = await loginAll(t, 'eur');
  const extra = {};
  for (const handle of ['ada', 'bob']) {
    const email = `${handle}@example.com`;
    const second = await login(t, email);
    extra[handle] = second ? second.token : null;
  }
  const fresh = await api(t, { method: 'POST', path: '/auth/signup', body: { email: 'joiner@example.com', password: 'a joiner passphrase', display_name: 'Joiner' } });
  if (fresh.status !== 201) {
    t.record({ ref: 'R6.1', what: 'setup signup', expected: 'HTTP 201', actual: `HTTP ${fresh.status}`, res: fresh });
    return null;
  }
  c.tokens.joiner = fresh.json.token;
  c.ids.joiner = fresh.json.user_id;

  const keys = {};
  const artifacts = {};

  keys.payment = key('exp-pay');
  artifacts.payment = await api(t, { method: 'POST', path: '/payments', token: c.tokens.ada, idemKey: keys.payment, body: { to_handle: 'bob', amount: 321, note: 'kept 👍', visibility: 'private' } });

  keys.request = key('exp-req');
  artifacts.request = await api(t, { method: 'POST', path: '/requests', token: c.tokens.ada, idemKey: keys.request, body: { payer_handle: 'bob', amount: 654, note: 'kept too' } });

  const payable = await api(t, { method: 'POST', path: '/requests', token: c.tokens.ada, idemKey: key('exp-setup'), body: { payer_handle: 'bob', amount: 111 } });
  keys.pay = key('exp-rpay');
  artifacts.pay = await api(t, { method: 'POST', path: `/requests/${payable.json.request_id}/pay`, token: c.tokens.bob, idemKey: keys.pay, body: { visibility: 'private' } });
  artifacts.payPath = `/requests/${payable.json.request_id}/pay`;

  const declined = await api(t, { method: 'POST', path: '/requests', token: c.tokens.ada, idemKey: key('exp-setup'), body: { payer_handle: 'bob', amount: 222 } });
  await api(t, { method: 'POST', path: `/requests/${declined.json.request_id}/decline`, token: c.tokens.bob, body: {} });
  const cancelled = await api(t, { method: 'POST', path: '/requests', token: c.tokens.ada, idemKey: key('exp-setup'), body: { payer_handle: 'bob', amount: 333 } });
  await api(t, { method: 'POST', path: `/requests/${cancelled.json.request_id}/cancel`, token: c.tokens.ada, body: {} });

  keys.split = key('exp-split');
  artifacts.split = await api(t, { method: 'POST', path: '/splits', token: c.tokens.ada, idemKey: keys.split, body: { amount: 1000, participant_handles: ['ada', 'bob', 'joiner'], note: 'shared' } });

  keys.settlement = key('exp-stl');
  artifacts.settlement = await api(t, { method: 'POST', path: '/settlements', token: c.tokens.op, idemKey: keys.settlement, body: { transfers: [{ from_handle: 'ada', to_handle: 'bob', amount: 40 }, { from_handle: 'rich', to_handle: 'joiner', amount: 50, visibility: 'private' }] } });

  // A key the service must leave reusable: the request failed with a 4xx.
  keys.failed = key('exp-failed');
  artifacts.failed = await api(t, { method: 'POST', path: '/payments', token: c.tokens.ada, idemKey: keys.failed, body: { to_handle: 'bob', amount: 0 } });

  for (const [name, res] of Object.entries(artifacts)) {
    if (name === 'failed' || name === 'payPath') continue;
    if (!res || res.status !== 201) {
      t.record({ ref: 'R10.11', what: `setup ${name}`, expected: 'HTTP 201', actual: res ? `HTTP ${res.status}: ${res.text}` : 'no response', res });
      return null;
    }
  }
  if (artifacts.failed.status !== 422) {
    t.record({ ref: 'R10.13', what: 'setup: a payment that fails with 4xx', expected: 'HTTP 422', actual: `HTTP ${artifacts.failed.status}`, res: artifacts.failed });
    return null;
  }
  return { c, extra, keys, artifacts };
}

// Everything the API exposes about the state, for an exact before/after comparison.
async function capture(t, c, base) {
  const out = { me: {}, feed: {}, reqs: {} };
  for (const [handle, tok] of Object.entries(c.tokens)) {
    if (!tok) continue;
    const m = await api(t, { path: '/me', token: tok, base });
    out.me[handle] = m.status === 200 ? m.json : `HTTP ${m.status}`;
    const f = await api(t, { path: '/activity', token: tok, query: { limit: 200 }, base });
    out.feed[handle] = f.status === 200 ? f.json : `HTTP ${f.status}`;
    const r = await api(t, { path: '/requests', token: tok, query: { limit: 200 }, base });
    out.reqs[handle] = r.status === 200 ? r.json : `HTTP ${r.status}`;
  }
  return out;
}

function compare(t, before, after, ref, label) {
  for (const section of ['me', 'feed', 'reqs']) {
    for (const handle of Object.keys(before[section])) {
      t.deep(after[section][handle], before[section][handle], {
        ref, what: `${label}: ${section} for ${handle}`,
      });
    }
  }
}

suite('10 export and import', () => {
  test('export returns track, format_version and an opaque state object', ['R10.1', 'R10.2'], async (t) => {
    await reset(t, 'eur');
    const res = await exportState(t);
    if (!t.status(res, 200, { ref: 'R10.2', what: 'GET /_test/export with no bearer token' })) return;
    t.eq(res.json && res.json.track, 'pocketful', { ref: 'R10.2', what: 'track', res });
    t.eq(res.json && res.json.format_version, 1, { ref: 'R10.2', what: 'format_version', res });
    const state = res.json && res.json.state;
    t.ok(state !== null && typeof state === 'object' && !Array.isArray(state), {
      ref: 'R10.2', what: 'state', res,
      expected: 'a JSON object', actual: JSON.stringify(state),
    });
  });

  test('import accepts an unchanged export and needs no bearer token', ['R10.3', 'R10.4', 'R10.5'], async (t) => {
    await reset(t, 'eur');
    const dump = await exportState(t);
    if (!t.status(dump, 200, { ref: 'R10.2', what: 'GET /_test/export' })) return;
    await importState(t, dump.json, undefined, 204);
    const ada = await login(t, 'ada@example.com');
    if (!ada) return;
    const m = await me(t, ada.token);
    t.eq(m.json && m.json.balance, 10000, { ref: 'R10.5', what: 'a balance after re-importing the same state', res: m });
  });

  test('an unchanged export restores every observable fact about the state', ['R10.11', 'R10.12', 'R10.13', 'R10.14', 'R10.15', 'R11.19'], async (t) => {
    const built = await buildRichState(t);
    if (!built) return;
    const { c, extra, keys, artifacts } = built;

    const before = await capture(t, c, undefined);
    const dump = await exportState(t);
    if (!t.status(dump, 200, { ref: 'R10.2', what: 'GET /_test/export' })) return;

    // Move the state on, so a lazy import that merely "keeps going" is caught.
    const drift = await api(t, { method: 'POST', path: '/payments', token: c.tokens.ada, idemKey: key('drift'), body: { to_handle: 'bob', amount: 7 } });
    t.status(drift, 201, { ref: 'R10.10', what: 'a write after the export' });
    const ghost = await api(t, { method: 'POST', path: '/auth/signup', body: { email: 'ghost@example.com', password: 'ghost passphrase', display_name: 'Ghost' } });
    t.status(ghost, 201, { ref: 'R10.15', what: 'an account created after the export' });

    await importState(t, dump.json, undefined, 204);

    // R10.11 / R10.12: balances, payments, requests, identities and timestamps come back
    // exactly, not regenerated and not replayed against an already-net balance.
    const after = await capture(t, c, undefined);
    compare(t, before, after, 'R10.11', 'after importing the unchanged export');

    // R10.11 / R10.14: existing bearer tokens, including a second session, still work.
    for (const [handle, tok] of Object.entries(extra)) {
      if (!tok) continue;
      const m = await api(t, { path: '/me', token: tok });
      t.status(m, 200, { ref: 'R10.14', what: `a second session token for ${handle} after import` });
    }

    // R10.11: hashed-password login still works, for a seeded and a signed-up account.
    for (const [email, password] of [['ada@example.com', PW], ['joiner@example.com', 'a joiner passphrase']]) {
      const res = await api(t, { method: 'POST', path: '/auth/login', body: { email, password } });
      t.status(res, 200, { ref: 'R10.11', what: `login as ${email} after import` });
    }

    // R10.11: every completed idempotent request replays with its original response.
    const replays = [
      ['POST /payments', 'POST', '/payments', c.tokens.ada, keys.payment, { to_handle: 'bob', amount: 321, note: 'kept 👍', visibility: 'private' }, artifacts.payment],
      ['POST /requests', 'POST', '/requests', c.tokens.ada, keys.request, { payer_handle: 'bob', amount: 654, note: 'kept too' }, artifacts.request],
      ['POST /requests/{id}/pay', 'POST', artifacts.payPath, c.tokens.bob, keys.pay, { visibility: 'private' }, artifacts.pay],
      ['POST /splits', 'POST', '/splits', c.tokens.ada, keys.split, { amount: 1000, participant_handles: ['ada', 'bob', 'joiner'], note: 'shared' }, artifacts.split],
      ['POST /settlements', 'POST', '/settlements', c.tokens.op, keys.settlement, { transfers: [{ from_handle: 'ada', to_handle: 'bob', amount: 40 }, { from_handle: 'rich', to_handle: 'joiner', amount: 50, visibility: 'private' }] }, artifacts.settlement],
    ];
    for (const [label, method, path, tok, k, body, original] of replays) {
      const res = await api(t, { method, path, token: tok, idemKey: k, body });
      t.status(res, 200, { ref: 'R10.11', what: `replaying ${label} after import` });
      t.deep(res.json, original.json, { ref: 'R10.11', what: `the replayed ${label} response after import`, res });
    }

    // R11.19: settlement membership survives.
    const settlementId = artifacts.settlement.json.settlement_id;
    const feed = await activity(t, c.tokens.ada, { limit: 200 });
    const members = ((feed.json || {}).payments || []).filter((p) => p.settlement_id === settlementId);
    t.eq(members.length, 1, {
      ref: 'R11.19', what: "settlement members visible to ada after import", res: feed,
      expected: '1 (the ada -> bob member; the other is private between rich and joiner)',
      actual: String(members.length),
    });

    // R11.19: operator permissions survive.
    const stillOperator = await api(t, { method: 'POST', path: '/settlements', token: c.tokens.op, idemKey: key('post'), body: { transfers: [{ from_handle: 'ada', to_handle: 'bob', amount: 1 }] } });
    t.status(stillOperator, 201, { ref: 'R11.19', what: 'the operator can still settle after import' });
    const notOperator = await api(t, { method: 'POST', path: '/settlements', token: c.tokens.ada, idemKey: key('post'), body: { transfers: [{ from_handle: 'ada', to_handle: 'bob', amount: 1 }] } });
    t.err(notOperator, 403, 'forbidden', { ref: 'R11.19', what: 'a non-operator is still refused after import' });

    // R10.15: everything created after the export is gone, credentials included.
    const ghostToken = await api(t, { path: '/me', token: ghost.json.token });
    t.err(ghostToken, 401, 'unauthenticated', {
      ref: 'R10.15', what: 'a token issued after the export',
    });
    const ghostLogin = await api(t, { method: 'POST', path: '/auth/login', body: { email: 'ghost@example.com', password: 'ghost passphrase' } });
    t.err(ghostLogin, 401, 'unauthenticated', {
      ref: 'R10.15', what: 'logging in as an account created after the export',
    });

    // R10.13: the key left free by a 4xx is still free.
    const reuse = await api(t, { method: 'POST', path: '/payments', token: c.tokens.ada, idemKey: keys.failed, body: { to_handle: 'bob', amount: 9 } });
    t.status(reuse, 201, { ref: 'R10.13', what: 'reusing a key whose original request failed, after import' });
  });

  test('export is a snapshot: later writes do not change what it restores', ['R10.10'], async (t) => {
    const c = await loginAll(t);
    const before = await capture(t, c, undefined);
    const dump = await exportState(t);
    if (!t.status(dump, 200, { ref: 'R10.10', what: 'GET /_test/export' })) return;
    const frozen = JSON.parse(JSON.stringify(dump.json));

    for (let i = 0; i < 3; i++) {
      const res = await api(t, { method: 'POST', path: '/payments', token: c.tokens.ada, idemKey: key('after'), body: { to_handle: 'bob', amount: 10 + i } });
      if (!t.status(res, 201, { ref: 'R10.10', what: `write number ${i + 1} after the export` })) return;
    }
    t.deep(dump.json, frozen, {
      ref: 'R10.10', what: 'the exported object as held by the caller',
      expected: 'unchanged by later writes on the source',
    });
    await importState(t, frozen, undefined, 204);
    const after = await capture(t, c, undefined);
    compare(t, before, after, 'R10.10', 'after importing a snapshot taken before three writes');
  });

  test('import is replacement, not merge, and repeats without duplicating', ['R10.7', 'R10.15'], async (t) => {
    const c = await loginAll(t);
    const seed = await api(t, { method: 'POST', path: '/payments', token: c.tokens.ada, idemKey: key('dup'), body: { to_handle: 'bob', amount: 42 } });
    if (!t.status(seed, 201, { ref: 'R8.3', what: 'a payment before the export' })) return;
    const dump = await exportState(t);
    if (!t.status(dump, 200, { ref: 'R10.2', what: 'GET /_test/export' })) return;
    const expected = await capture(t, c, undefined);

    for (let round = 1; round <= 3; round++) {
      await importState(t, dump.json, undefined, 204);
      const after = await capture(t, c, undefined);
      compare(t, expected, after, 'R10.7', `after import number ${round}`);
      const feed = await activity(t, c.tokens.ada, { limit: 200 });
      const dupes = ((feed.json || {}).payments || []).filter((p) => p.amount === 42);
      t.eq(dupes.length, 1, {
        ref: 'R10.7', what: `copies of the 42 payment after import number ${round}`, res: feed,
        expected: 'exactly 1', actual: String(dupes.length),
      });
    }
  });

  test('an invalid import is 422 and leaves the destination untouched', ['R10.8'], async (t) => {
    const c = await loginAll(t);
    const dump = await exportState(t);
    if (!t.status(dump, 200, { ref: 'R10.2', what: 'GET /_test/export' })) return;
    const good = dump.json;
    const expected = await capture(t, c, undefined);

    const bad = [
      ['no state field', { track: 'pocketful', format_version: 1 }],
      ['no track field', { format_version: 1, state: good.state }],
      ['no format_version field', { track: 'pocketful', state: good.state }],
      ['the wrong track', { track: 'not-pocketful', format_version: 1, state: good.state }],
      ['a future format_version', { track: 'pocketful', format_version: 2, state: good.state }],
      ['a format_version of 0', { track: 'pocketful', format_version: 0, state: good.state }],
      ['a state that is not an object', { track: 'pocketful', format_version: 1, state: 'nonsense' }],
      ['a state that is an array', { track: 'pocketful', format_version: 1, state: [1, 2, 3] }],
      ['a null state', { track: 'pocketful', format_version: 1, state: null }],
      ['an empty object', {}],
    ];
    for (const [label, body] of bad) {
      const res = await importState(t, body, undefined, null);
      t.err(res, 422, 'validation_failed', { ref: 'R10.8', what: `POST /_test/import with ${label}` });
      const after = await capture(t, c, undefined);
      compare(t, expected, after, 'R10.8', `after a rejected import (${label})`);
    }

    const unparseable = await t.req({
      method: 'POST', path: '/_test/import',
      headers: { 'Content-Type': 'application/json' }, body: '{"track":"pocketful",',
    });
    t.err(unparseable, 400, 'malformed_request', { ref: 'R10.8', what: 'POST /_test/import with an unparseable body' });
    const afterAll = await capture(t, c, undefined);
    compare(t, expected, afterAll, 'R10.8', 'after an unparseable import');
  });

  test('a state that did not come from this service is rejected, not half applied', ['R10.8'], async (t) => {
    const c = await loginAll(t);
    const expected = await capture(t, c, undefined);
    const nonsense = [
      ['an empty state object', {}],
      ['a state of unrelated keys', { hello: 'world', users: 'not a list' }],
      ['a state with an empty user list where accounts are expected', { users: [], payments: [], requests: [] }],
    ];
    for (const [label, state] of nonsense) {
      const res = await importState(t, { track: 'pocketful', format_version: 1, state }, undefined, null);
      t.ok(res.status === 422 || res.status === 204, {
        ref: 'R10.8', what: `POST /_test/import with ${label}`, res,
        expected: '422 validation_failed, or 204 if the service can legitimately represent that state',
        actual: `HTTP ${res.status}: ${res.text}`,
      });
      if (res.status === 422) {
        const after = await capture(t, c, undefined);
        compare(t, expected, after, 'R10.8', `after rejecting ${label}`);
      } else {
        // It accepted it; re-establish a known state for the remaining cases.
        const re = await loginAll(t);
        Object.assign(c.tokens, re.tokens);
        Object.assign(expected, await capture(t, c, undefined));
      }
    }
  }, {
    severity: 'advisory',
    why: 'spec 10 requires 422 for "an invalid state" but the state format is implementation '
       + 'defined, so which foreign objects are invalid is the service\'s own judgement. The '
       + 'blocking requirement is that a rejection changes nothing, which is what this check '
       + 'verifies when a rejection happens.',
  });

  test('reset clears imported state', ['R10.16'], async (t) => {
    const c = await loginAll(t);
    const marker = await api(t, { method: 'POST', path: '/payments', token: c.tokens.ada, idemKey: key('mark'), body: { to_handle: 'bob', amount: 4321, note: 'import marker' } });
    if (!t.status(marker, 201, { ref: 'R8.3', what: 'a marker payment' })) return;
    const dump = await exportState(t);
    if (!t.status(dump, 200, { ref: 'R10.2', what: 'GET /_test/export' })) return;
    await importState(t, dump.json, undefined, 204);

    await reset(t, 'minimal');
    const solo = await login(t, 'solo@example.com');
    if (!solo) return;
    const feed = await activity(t, solo.token, { limit: 200 });
    if (t.status(feed, 200, { ref: 'R10.16', what: 'GET /activity after reset' })) {
      t.eq((feed.json.payments || []).length, 0, {
        ref: 'R10.16', what: 'payments surviving a reset after an import', res: feed,
      });
    }
    const stale = await api(t, { path: '/me', token: c.tokens.ada });
    t.err(stale, 401, 'unauthenticated', { ref: 'R10.16', what: 'an imported token after a reset' });
    const staleLogin = await api(t, { method: 'POST', path: '/auth/login', body: { email: 'ada@example.com', password: PW } });
    t.err(staleLogin, 401, 'unauthenticated', { ref: 'R10.16', what: 'an imported account after a reset' });
  });

  test('test control endpoints answer within the 10 second budget', ['R10.9'], async (t) => {
    const built = await buildRichState(t);
    if (!built) return;
    const dump = await exportState(t);
    if (!t.status(dump, 200, { ref: 'R10.9', what: 'GET /_test/export' })) return;
    t.ok(dump.ms <= 10000, {
      ref: 'R10.9', what: 'GET /_test/export duration', res: dump,
      expected: 'at most 10000 ms', actual: `${dump.ms} ms`,
    });
    const imp = await importState(t, dump.json, undefined, 204);
    t.ok(imp.ms <= 10000, {
      ref: 'R10.9', what: 'POST /_test/import duration', res: imp,
      expected: 'at most 10000 ms', actual: `${imp.ms} ms`,
    });
  });

  test('an export moves to another container with no dependency on the source', ['R10.6'], async (t) => {
    if (!ALT_BASE_URL) {
      t.record({
        ref: 'R10.6', severity: 'advisory',
        what: 'a second container to import into',
        expected: 'ALT_BASE_URL pointing at a second, independently started container',
        actual: 'ALT_BASE_URL is not set, so cross-container import was not exercised',
      });
      return;
    }
    const built = await buildRichState(t);
    if (!built) return;
    const { c, keys, artifacts } = built;
    const before = await capture(t, c, undefined);
    const dump = await exportState(t);
    if (!t.status(dump, 200, { ref: 'R10.6', what: 'GET /_test/export from the source' })) return;

    // Give the destination a different state first, so a no-op import is caught.
    const alt = await t.req({
      method: 'POST', path: '/_test/reset', base: ALT_BASE_URL,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currency: 'JPY', minor_units: 0, users: [{ id: 'u_other', email: 'other@example.com', password: PW, display_name: 'Other', handle: 'other', balance: 5 }], payments: [], requests: [] }),
    });
    t.status(alt, 204, { ref: 'R10.6', what: 'resetting the destination to a different state' });

    await importState(t, dump.json, ALT_BASE_URL, 204);
    const after = await capture(t, c, ALT_BASE_URL);
    compare(t, before, after, 'R10.6', 'the destination container after importing the source export');

    const replay = await api(t, {
      method: 'POST', path: '/payments', token: c.tokens.ada, idemKey: keys.payment,
      body: { to_handle: 'bob', amount: 321, note: 'kept 👍', visibility: 'private' }, base: ALT_BASE_URL,
    });
    t.status(replay, 200, { ref: 'R10.6', what: 'replaying a source idempotency key on the destination' });
    t.deep(replay.json, artifacts.payment.json, {
      ref: 'R10.6', what: 'the replayed response on the destination', res: replay,
    });
    const otherGone = await api(t, { method: 'POST', path: '/auth/login', body: { email: 'other@example.com', password: PW }, base: ALT_BASE_URL });
    t.err(otherGone, 401, 'unauthenticated', {
      ref: 'R10.15', what: "the destination's own account after the import",
    });
  });
});
