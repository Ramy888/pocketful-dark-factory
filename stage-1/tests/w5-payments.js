'use strict';

// Durable evidence for W5 (POST /payments), committed per D28. Exercises
// the delivered server (src/server.js's createServer(), the same routes
// the shipped image serves) over real HTTP -- never reaches into
// server.store.state except where a check says so.
//
// Criteria 1-9 are the endpoint's own behaviour. Criterion 10 is the
// concurrency/conservation check. Criterion 11 proves the W4 gate is wired
// to this real path, not only to W4's own throwaway probe harness, and
// that a completed idempotency record reaches GET /_test/export through
// the delivered image. Criterion 12 (D30) is proven separately by
// tests/export-coverage-guard.js and re-confirmed here against the live
// server's own serializeState.

const http = require('http');

const { createServer } = require('../src/server');
const { checkExportCoverage } = require('../src/lib/exportGuard');
const { emptyState } = require('../src/store');
const { serializeState } = require('../src/routes/testExport');
const { canonicalize } = require('../src/lib/idempotency');

// R7.10: "same JSON value" ignores key order. The export's stored body is
// canonicalised (sorted keys) per src/lib/idempotency.js, so comparing it
// against the original request object literally (insertion-order
// JSON.stringify) is the wrong check -- canonicalize both sides first.
function sameJsonValue(a, b) {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

function req(server, method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    const h = Object.assign({}, headers);
    if (payload !== undefined && h['Content-Type'] === undefined) h['Content-Type'] = 'application/json';
    if (payload !== undefined) h['Content-Length'] = Buffer.byteLength(payload);
    const r = http.request(
      { host: '127.0.0.1', port: server.address().port, method, path, headers: h },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json;
          try { json = raw ? JSON.parse(raw) : undefined; } catch { json = undefined; }
          resolve({ status: res.statusCode, json, raw });
        });
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

let passCount = 0;
let failCount = 0;
function assert(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (cond) passCount++; else { failCount++; process.exitCode = 1; }
}

async function reset(server, users) {
  const r = await req(server, 'POST', '/_test/reset', {
    currency: 'EUR', minor_units: 2, users, payments: [], requests: [],
  });
  if (r.status !== 204) throw new Error(`reset failed: ${r.status} ${r.raw}`);
}

async function login(server, email) {
  const r = await req(server, 'POST', '/auth/login', { email, password: 'correct horse' });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${r.raw}`);
  return r.json.token;
}

function pay(server, tok, body, key, path = '/payments') {
  const headers = { Authorization: `Bearer ${tok}` };
  if (key !== undefined) headers['Idempotency-Key'] = key;
  return req(server, 'POST', path, body, headers);
}

async function balance(server, tok) {
  const r = await req(server, 'GET', '/me', undefined, { Authorization: `Bearer ${tok}` });
  return r.json.balance;
}

let seq = 0;
function key(prefix = 'k') {
  seq += 1;
  return `${prefix}-${process.pid}-${Date.now().toString(36)}-${seq}`;
}

async function main() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const baseUsers = [
    { id: 'u_ada', email: 'ada@example.com', password: 'correct horse', display_name: 'Ada', handle: 'ada', balance: 10000 },
    { id: 'u_cy', email: 'cy@example.com', password: 'correct horse', display_name: 'Cy', handle: 'cy', balance: 500 },
  ];

  // ---- criterion 1: a valid payment ----
  {
    await reset(server, baseUsers);
    const tokA = await login(server, 'ada@example.com');
    const before = Date.now();
    const r = await pay(server, tokA, { to_handle: 'cy', amount: 250 }, key());
    assert(r.status === 201, `criterion 1: valid payment -> 201 (got ${r.status} ${r.raw})`);
    const b = r.json;
    assert(
      typeof b.payment_id === 'string' && b.from_user_id === 'u_ada' && b.from_handle === 'ada'
      && b.to_user_id === 'u_cy' && b.to_handle === 'cy' && b.amount === 250 && b.currency === 'EUR'
      && b.note === '' && b.visibility === 'public' && b.request_id === null && b.settlement_id === null,
      `criterion 1: every R8.3 field present and correct (got ${JSON.stringify(b)})`,
    );
    assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}:\d{2}$/.test(b.created_at), `criterion 1: created_at is RFC 3339 with an explicit offset (got ${b.created_at})`);
    assert(Date.now() >= before, 'criterion 1: sanity clock check');
    const meA = await req(server, 'GET', '/me', undefined, { Authorization: `Bearer ${tokA}` });
    assert(meA.json.balance === 9750, `criterion 1: sender balance moved by exactly amount (got ${meA.json.balance})`);
    const tokC = await login(server, 'cy@example.com');
    const meC = await req(server, 'GET', '/me', undefined, { Authorization: `Bearer ${tokC}` });
    assert(meC.json.balance === 750, `criterion 1: recipient balance moved by exactly amount (got ${meC.json.balance})`);
  }

  // ---- criterion 2: insufficient funds ----
  {
    await reset(server, baseUsers);
    const tokC = await login(server, 'cy@example.com'); // balance 500
    const r = await pay(server, tokC, { to_handle: 'ada', amount: 501 }, key());
    assert(r.status === 409 && r.json.error.code === 'insufficient_funds', `criterion 2: -> 409 insufficient_funds (got ${r.status} ${r.json && r.json.error && r.json.error.code})`);
    const meC = await req(server, 'GET', '/me', undefined, { Authorization: `Bearer ${tokC}` });
    const meA = await req(server, 'GET', '/me', undefined, { Authorization: `Bearer ${await login(server, 'ada@example.com')}` });
    assert(meC.json.balance === 500 && meA.json.balance === 10000, `criterion 2: no balance change on either side (got ${meC.json.balance}, ${meA.json.balance})`);
  }

  // ---- criterion 3: amount edge cases ----
  {
    await reset(server, baseUsers);
    const tokA = await login(server, 'ada@example.com');
    for (const bad of [0, -1, 1000000001, 1.5, '100', true, null]) {
      const r = await pay(server, tokA, { to_handle: 'cy', amount: bad }, key());
      assert(r.status === 422 && r.json.error.code === 'validation_failed', `criterion 3: amount ${JSON.stringify(bad)} -> 422 validation_failed (got ${r.status} ${r.json && r.json.error && r.json.error.code})`);
    }
    const r1 = await req(server, 'POST', '/payments', '{"to_handle":"cy","amount":1000.0}', { Authorization: `Bearer ${tokA}`, 'Idempotency-Key': key(), 'Content-Type': 'application/json' });
    assert(r1.status === 201 && r1.json.amount === 1000, `criterion 3: amount 1000.0 -> 201, amount 1000 (got ${r1.status} ${r1.json && r1.json.amount})`);
    const r2 = await req(server, 'POST', '/payments', '{"to_handle":"cy","amount":1e3}', { Authorization: `Bearer ${tokA}`, 'Idempotency-Key': key(), 'Content-Type': 'application/json' });
    assert(r2.status === 201 && r2.json.amount === 1000, `criterion 3: amount 1e3 -> 201, amount 1000 (got ${r2.status} ${r2.json && r2.json.amount})`);
  }

  // ---- criterion 4: self payment ----
  {
    await reset(server, baseUsers);
    const tokA = await login(server, 'ada@example.com');
    const r = await pay(server, tokA, { to_handle: 'ada', amount: 10 }, key());
    assert(r.status === 422 && r.json.error.code === 'self_payment', `criterion 4: to_handle === own handle -> 422 self_payment (got ${r.status} ${r.json && r.json.error && r.json.error.code})`);
  }

  // ---- criterion 5: D20 note boundary and type checks ----
  {
    await reset(server, baseUsers);
    const tokA = await login(server, 'ada@example.com');
    const note200 = '🎉'.repeat(200); // 200 code points, 400 UTF-16 units
    const ok = await pay(server, tokA, { to_handle: 'cy', amount: 1, note: note200 }, key());
    assert(ok.status === 201 && ok.json.note === note200, `criterion 5: a 200-code-point note succeeds (got ${ok.status})`);
    const note201 = note200 + '🎉';
    const bad = await pay(server, tokA, { to_handle: 'cy', amount: 1, note: note201 }, key());
    assert(bad.status === 422 && bad.json.error.code === 'validation_failed', `criterion 5: a 201-code-point note -> 422 (got ${bad.status})`);
    const nullNote = await pay(server, tokA, { to_handle: 'cy', amount: 1, note: null }, key());
    assert(nullNote.status === 422 && nullNote.json.error.code === 'validation_failed', `criterion 5: note: null -> 422 (got ${nullNote.status})`);
    const numNote = await pay(server, tokA, { to_handle: 'cy', amount: 1, note: 5 }, key());
    assert(numNote.status === 422 && numNote.json.error.code === 'validation_failed', `criterion 5: note: 5 -> 422 (got ${numNote.status})`);
    const omitted = await pay(server, tokA, { to_handle: 'cy', amount: 1 }, key());
    assert(omitted.status === 201 && omitted.json.note === '', `criterion 5: omitted note defaults to "" (got ${omitted.status} ${JSON.stringify(omitted.json && omitted.json.note)})`);
  }

  // ---- criterion 6: visibility default and validation ----
  {
    await reset(server, baseUsers);
    const tokA = await login(server, 'ada@example.com');
    const omitted = await pay(server, tokA, { to_handle: 'cy', amount: 1 }, key());
    assert(omitted.status === 201 && omitted.json.visibility === 'public', `criterion 6: omitted visibility defaults to "public" (got ${omitted.status} ${omitted.json && omitted.json.visibility})`);
    const bad = await pay(server, tokA, { to_handle: 'cy', amount: 1, visibility: 'secret' }, key());
    assert(bad.status === 422 && bad.json.error.code === 'validation_failed', `criterion 6: visibility "secret" -> 422 (got ${bad.status})`);
    const priv = await pay(server, tokA, { to_handle: 'cy', amount: 1, visibility: 'private' }, key());
    assert(priv.status === 201 && priv.json.visibility === 'private', `criterion 6: visibility "private" accepted (got ${priv.status})`);
  }

  // ---- criterion 7: unknown to_handle ----
  {
    // D47: an absent /payments route also answers 404 not_found, on the
    // same status and the same code -- a check for this criterion that
    // does not first prove the route exists would pass vacuously before
    // the route was ever registered. The control payment below must
    // succeed (201) before the unknown-handle case is asked to mean
    // anything.
    await reset(server, baseUsers);
    const tokA = await login(server, 'ada@example.com');
    const control = await pay(server, tokA, { to_handle: 'cy', amount: 1 }, key());
    assert(control.status === 201, `criterion 7 control: a real handle succeeds -> 201, proving the route exists (got ${control.status})`);
    const r = await pay(server, tokA, { to_handle: 'ghost', amount: 1 }, key());
    assert(r.status === 404 && r.json.error.code === 'not_found', `criterion 7: unknown to_handle -> 404 not_found (got ${r.status} ${r.json && r.json.error && r.json.error.code})`);
  }

  // ---- criterion 8: D22 -- invalid amount beats an unknown to_handle ----
  {
    await reset(server, baseUsers);
    const tokA = await login(server, 'ada@example.com');
    const r = await pay(server, tokA, { to_handle: 'ghost', amount: -1 }, key());
    assert(r.status === 422 && r.json.error.code === 'validation_failed', `criterion 8: invalid amount + unknown to_handle -> 422, not 404 (got ${r.status} ${r.json && r.json.error && r.json.error.code})`);
  }

  // ---- criterion 9: note round-trips byte for byte ----
  {
    await reset(server, baseUsers);
    const tokA = await login(server, 'ada@example.com');
    const note = 'é́ 🇬🇧 👨‍👩‍👧‍👦 \u0000 "quoted" \\backslash\\';
    const r = await pay(server, tokA, { to_handle: 'cy', amount: 1, note }, key());
    assert(r.status === 201 && r.json.note === note, `criterion 9: emoji/combining-mark note round-trips byte for byte in the response (got ${JSON.stringify(r.json && r.json.note)})`);
  }

  // ---- criterion 10: 50 concurrent payments across a ring of wallets ----
  {
    const ringUsers = Array.from({ length: 10 }, (_, i) => ({
      id: `u_ring${i}`, email: `ring${i}@example.com`, password: 'correct horse',
      display_name: `Ring ${i}`, handle: `ring${i}`, balance: 1000,
    }));
    await reset(server, ringUsers);
    const tokens = await Promise.all(ringUsers.map((u) => login(server, u.email)));
    const seededTotal = ringUsers.reduce((s, u) => s + u.balance, 0);

    const N = 50;
    const calls = Array.from({ length: N }, (_, i) => {
      const from = i % ringUsers.length;
      const to = (i + 1) % ringUsers.length;
      return pay(server, tokens[from], { to_handle: `ring${to}`, amount: 10 }, key('ring'));
    });
    const results = await Promise.all(calls);
    assert(results.every((r) => r.status < 500), `criterion 10: no 5xx under 50 concurrent payments (got statuses ${JSON.stringify(results.map((r) => r.status))})`);

    const balances = await Promise.all(tokens.map((t) => balance(server, t)));
    assert(balances.every((b) => b >= 0), `criterion 10: no wallet ever negative (got ${JSON.stringify(balances)})`);
    const total = balances.reduce((s, b) => s + b, 0);
    assert(total === seededTotal, `criterion 10: total conserved (seeded ${seededTotal}, got ${total})`);
  }

  // ---- criterion 11: the W4 gate wired to this real path ----
  {
    await reset(server, baseUsers);
    const tokA = await login(server, 'ada@example.com');
    const tokC = await login(server, 'cy@example.com');

    // missing / empty key -> 400
    {
      const r = await req(server, 'POST', '/payments', { to_handle: 'cy', amount: 1 }, { Authorization: `Bearer ${tokA}` });
      assert(r.status === 400 && r.json.error.code === 'missing_idempotency_key', `criterion 11: missing key -> 400 (got ${r.status})`);
    }
    {
      const r = await pay(server, tokA, { to_handle: 'cy', amount: 1 }, '');
      assert(r.status === 400 && r.json.error.code === 'missing_idempotency_key', `criterion 11: empty key -> 400 (got ${r.status})`);
    }
    // key length boundaries
    {
      const r255 = await pay(server, tokA, { to_handle: 'cy', amount: 1 }, 'k'.repeat(255));
      assert(r255.status === 201, `criterion 11: 255-char key accepted (got ${r255.status})`);
      const r256 = await pay(server, tokA, { to_handle: 'cy', amount: 1 }, 'k'.repeat(256));
      assert(r256.status === 422 && r256.json.error.code === 'validation_failed', `criterion 11: 256-char key -> 422 (got ${r256.status})`);
    }
    // first use 201, identical replay 200 same body, no second balance move
    {
      const k = key('c11-3');
      const before = await balance(server, tokA);
      const first = await pay(server, tokA, { to_handle: 'cy', amount: 5 }, k);
      assert(first.status === 201, `criterion 11: first use -> 201 (got ${first.status})`);
      const afterFirst = await balance(server, tokA);
      const replay = await pay(server, tokA, { to_handle: 'cy', amount: 5 }, k);
      assert(replay.status === 200, `criterion 11: replay -> 200 (got ${replay.status})`);
      assert(JSON.stringify(replay.json) === JSON.stringify(first.json), 'criterion 11: replay body identical to the original response');
      const afterReplay = await balance(server, tokA);
      assert(before - afterFirst === 5 && afterFirst === afterReplay, `criterion 11: money moved once (before ${before}, afterFirst ${afterFirst}, afterReplay ${afterReplay})`);
    }
    // reordered/whitespaced body replay -> 200 identical
    {
      const k = key('c11-4');
      const first = await pay(server, tokA, { to_handle: 'cy', amount: 6, note: 'x' }, k);
      const reordered = `{\n  "note": "x",\n  "amount":    6,\n  "to_handle": "cy"\n}`;
      const r = await req(server, 'POST', '/payments', reordered, { Authorization: `Bearer ${tokA}`, 'Idempotency-Key': k, 'Content-Type': 'application/json' });
      assert(r.status === 200 && JSON.stringify(r.json) === JSON.stringify(first.json), `criterion 11: reordered/whitespaced replay -> 200, identical (got ${r.status})`);
    }
    // different body, same key -> 409
    {
      const k = key('c11-5');
      const first = await pay(server, tokA, { to_handle: 'cy', amount: 7 }, k);
      assert(first.status === 201, `criterion 11 setup: first use -> 201 (got ${first.status})`);
      const clash = await pay(server, tokA, { to_handle: 'cy', amount: 8 }, k);
      assert(clash.status === 409 && clash.json.error.code === 'idempotency_key_reuse', `criterion 11: same key, different body -> 409 (got ${clash.status})`);
    }
    // same key, different user -> independent
    {
      const k = key('c11-6');
      const a = await pay(server, tokA, { to_handle: 'cy', amount: 1 }, k);
      const c = await pay(server, tokC, { to_handle: 'ada', amount: 1 }, k);
      assert(a.status === 201 && c.status === 201 && a.json.payment_id !== c.json.payment_id, `criterion 11: same key string, different users, independent (got ${a.status}, ${c.status})`);
    }
    // a key whose first use 4xx'd is reusable
    {
      const k = key('c11-7');
      const failed = await pay(server, tokA, { to_handle: 'ghost', amount: 1 }, k);
      assert(failed.status === 404, `criterion 11 setup: first use fails 404 (got ${failed.status})`);
      const reused = await pay(server, tokA, { to_handle: 'cy', amount: 1 }, k);
      assert(reused.status === 201, `criterion 11: key reused after a 4xx -> 201 (got ${reused.status})`);
    }
    // R7.13: a claimed key beats field validation and resource resolution
    {
      const k = key('c11-8a');
      const first = await pay(server, tokA, { to_handle: 'cy', amount: 1 }, k);
      assert(first.status === 201, `criterion 11 setup: first use -> 201 (got ${first.status})`);
      const invalid = await pay(server, tokA, { to_handle: 'cy', amount: -1 }, k);
      assert(invalid.status === 409 && invalid.json.error.code === 'idempotency_key_reuse', `criterion 11 (R7.13): claimed key + invalid amount -> 409, not 422 (got ${invalid.status} ${invalid.json && invalid.json.error && invalid.json.error.code})`);
    }
    {
      const k = key('c11-8b');
      const first = await pay(server, tokA, { to_handle: 'cy', amount: 1 }, k);
      assert(first.status === 201, `criterion 11 setup: first use -> 201 (got ${first.status})`);
      const notFound = await pay(server, tokA, { to_handle: 'ghost', amount: 1 }, k);
      assert(notFound.status === 409 && notFound.json.error.code === 'idempotency_key_reuse', `criterion 11 (R7.13): claimed key + unknown to_handle -> 409, not 404 (got ${notFound.status} ${notFound.json && notFound.json.error && notFound.json.error.code})`);
    }
    // 20 concurrent identical requests, one unused key -> exactly one 201
    {
      const k = key('c11-9');
      const before = await balance(server, tokA);
      const all = await Promise.all(Array.from({ length: 20 }, () => pay(server, tokA, { to_handle: 'cy', amount: 2 }, k)));
      const created = all.filter((r) => r.status === 201);
      const replayed = all.filter((r) => r.status === 200);
      const after = await balance(server, tokA);
      assert(
        created.length === 1 && replayed.length === 19 && before - after === 2
        && replayed.every((r) => JSON.stringify(r.json) === JSON.stringify(created[0].json)),
        `criterion 11: 20 concurrent identical requests -> exactly one 201, 19 identical 200s, one movement (created ${created.length}, replayed ${replayed.length}, moved ${before - after})`,
      );
    }
    // a completed idempotency record reaches the export through the delivered image
    {
      const k = key('c11-export');
      const body = { to_handle: 'cy', amount: 3, note: 'export-me' };
      const paid = await pay(server, tokA, body, k);
      assert(paid.status === 201, `criterion 11 (export) setup: payment -> 201 (got ${paid.status})`);
      const exp = await req(server, 'GET', '/_test/export');
      const records = exp.json.state.idempotency;
      const rec = records.find((r) => r.key === k && r.user_id === 'u_ada');
      assert(!!rec, `criterion 11: a completed idempotency record reaches GET /_test/export (found in ${records.length} records)`);
      assert(rec && rec.method === 'POST' && rec.path === '/payments', `criterion 11: record carries the real method/path (got ${rec && rec.method} ${rec && rec.path})`);
      assert(rec && sameJsonValue(rec.body, body), `criterion 11: record carries the original request body as the same JSON value (got ${JSON.stringify(rec && rec.body)})`);
      assert(rec && rec.status === 201 && JSON.stringify(rec.response) === JSON.stringify(paid.json), 'criterion 11: record carries the original response, through the delivered image (not a test harness)');
    }
  }

  // ---- criterion 12 (D30): the export guard still passes with payments live ----
  {
    await reset(server, baseUsers);
    const tokA = await login(server, 'ada@example.com');
    await pay(server, tokA, { to_handle: 'cy', amount: 1 }, key());
    const coverage = checkExportCoverage(emptyState, serializeState);
    assert(coverage.ok, `criterion 12: D30 export-coverage guard still passes with a live payment (missing: ${JSON.stringify(coverage.missing)})`);
  }

  // ---- C6/D49: a fixture whose seeded balances sum above 2^53 is refused ----
  // Each individual balance staying within +-2^53 does not bound their sum.
  // Above 2^53 the integer grid is no longer unit-spaced: a credit of 1 to a
  // balance already at 2^53 rounds away in IEEE-754 double arithmetic while
  // the matching debit lands exactly, destroying money (R1.7) through an
  // operation the spec requires to succeed. Reproduced against the
  // delivered route (not a unit test of fixture.js in isolation) so this
  // proves the money is actually safe end to end, not just that reset
  // answers the right status code.
  const TWO_POW_53 = 9007199254740992;
  {
    const rejected = await req(server, 'POST', '/_test/reset', {
      currency: 'EUR', minor_units: 2, payments: [], requests: [],
      users: [
        { id: 'u_big1', email: 'big1@example.com', password: 'correct horse', display_name: 'Big1', handle: 'big1', balance: TWO_POW_53 },
        { id: 'u_big2', email: 'big2@example.com', password: 'correct horse', display_name: 'Big2', handle: 'big2', balance: TWO_POW_53 },
      ],
    });
    assert(
      rejected.status === 422 && rejected.json.error.code === 'validation_failed',
      `C6/D49: a fixture whose balances sum to 2^54 (each individually <= 2^53) -> 422 validation_failed (got ${rejected.status} ${rejected.json && rejected.json.error && rejected.json.error.code})`,
    );
  }
  // The boundary itself -- sum exactly 2^53 -- must still be accepted, and
  // money must actually survive fifty payments there: the verifier's own
  // repro, reproduced here as a regression rather than taken on report.
  {
    await reset(server, [
      { id: 'u_edge1', email: 'edge1@example.com', password: 'correct horse', display_name: 'Edge1', handle: 'edge1', balance: TWO_POW_53 - 50 },
      { id: 'u_edge2', email: 'edge2@example.com', password: 'correct horse', display_name: 'Edge2', handle: 'edge2', balance: 50 },
    ]);
    const tok1 = await login(server, 'edge1@example.com');
    const results = [];
    for (let i = 0; i < 50; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- sequential on purpose: each payment must actually land before the next, this is not a concurrency check
      results.push(await pay(server, tok1, { to_handle: 'edge2', amount: 1 }, key('c6')));
    }
    assert(results.every((r) => r.status === 201), `C6/D49: fifty payments of 1 at the 2^53 boundary all -> 201 (got ${JSON.stringify(results.map((r) => r.status))})`);
    const b1 = await balance(server, tok1);
    const b2 = await balance(server, await login(server, 'edge2@example.com'));
    assert(b1 === TWO_POW_53 - 100, `C6/D49: sender debited by exactly 50, no rounding loss (got ${b1}, want ${TWO_POW_53 - 100})`);
    assert(b2 === 100, `C6/D49: receiver credited by exactly 50, no rounding loss (got ${b2})`);
    assert(b1 + b2 === TWO_POW_53, `C6/D49 (R1.7): total conserved exactly at the boundary (got ${b1 + b2}, seeded ${TWO_POW_53})`);
  }

  server.close();
  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
}

main().catch((e) => { console.error(e); process.exit(1); });
