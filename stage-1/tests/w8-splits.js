'use strict';

// Durable evidence for W8 (POST /splits), committed per D28. Exercises the
// delivered server (src/server.js's createServer()) over real HTTP.
//
// D47/D50 discipline: every assertion records a real comparison, no bare
// early return on an expected-failure branch. A control call precedes any
// check whose expected status/code an absent route could also produce.

const http = require('http');

const { createServer } = require('../src/server');
const { checkExportCoverage } = require('../src/lib/exportGuard');
const { emptyState } = require('../src/store');
const { serializeState } = require('../src/routes/testExport');

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

async function reset(server, fixture) {
  const r = await req(server, 'POST', '/_test/reset', {
    currency: 'EUR', minor_units: 2, payments: [], requests: [], ...fixture,
  });
  if (r.status !== 204) throw new Error(`reset failed: ${r.status} ${r.raw}`);
}

async function login(server, email) {
  const r = await req(server, 'POST', '/auth/login', { email, password: 'correct horse' });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${r.raw}`);
  return r.json.token;
}

function auth(tok) {
  return { Authorization: `Bearer ${tok}` };
}

let seq = 0;
function key(prefix = 'k') {
  seq += 1;
  return `${prefix}-${process.pid}-${Date.now().toString(36)}-${seq}`;
}

function split(server, tok, body, k) {
  const headers = { ...auth(tok) };
  if (k !== undefined) headers['Idempotency-Key'] = k;
  return req(server, 'POST', '/splits', body, headers);
}
async function splitOk(server, tok, body) {
  const r = await split(server, tok, body, key('s'));
  if (r.status !== 201) throw new Error(`split setup failed: ${r.status} ${r.raw}`);
  return r.json;
}
function payReq(server, tok, id, body, k) {
  const headers = { ...auth(tok) };
  if (k !== undefined) headers['Idempotency-Key'] = k;
  return req(server, 'POST', `/requests/${id}/pay`, body === undefined ? {} : body, headers);
}
function listReqs(server, tok, qs = '') {
  return req(server, 'GET', `/requests${qs}`, undefined, auth(tok));
}
async function balance(server, tok) {
  const r = await req(server, 'GET', '/me', undefined, auth(tok));
  return r.json.balance;
}
async function activity(server, tok) {
  return req(server, 'GET', '/activity', undefined, auth(tok));
}

function usersOf(n, balance = 100000) {
  return Array.from({ length: n }, (_, i) => ({
    id: `u_${i}`, email: `u${i}@example.com`, password: 'correct horse',
    display_name: `User ${i}`, handle: `u${i}`, balance,
  }));
}

async function main() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  // ---- route-exists control (D47/D50) ----
  {
    await reset(server, { users: usersOf(2) });
    const tok0 = await login(server, 'u0@example.com');
    const control = await split(server, tok0, { amount: 10, participant_handles: ['u0'] }, key('ctrl'));
    assert(control.status === 201, `route-exists control: POST /splits -> 201 (got ${control.status})`);
  }

  // ---- criterion 1: §9's table reproduced exactly, in order ----
  {
    await reset(server, { users: usersOf(5) });
    const tok0 = await login(server, 'u0@example.com');
    const cases = [
      { amount: 1000, n: 3, want: [334, 333, 333] },
      { amount: 1, n: 3, want: [1, 0, 0] },
      { amount: 10, n: 3, want: [4, 3, 3] },
      { amount: 999, n: 3, want: [333, 333, 333] },
      { amount: 5, n: 5, want: [1, 1, 1, 1, 1] },
    ];
    for (const c of cases) {
      const handles = Array.from({ length: c.n }, (_, i) => `u${i}`);
      const r = await splitOk(server, tok0, { amount: c.amount, participant_handles: handles });
      const got = r.shares.map((s) => s.amount);
      assert(JSON.stringify(got) === JSON.stringify(c.want), `criterion 1: ${c.amount}/${c.n} -> ${JSON.stringify(c.want)} (got ${JSON.stringify(got)})`);
    }
  }

  // ---- criterion 2: reversing participant order moves the extra unit ----
  {
    await reset(server, { users: usersOf(3) });
    const tok0 = await login(server, 'u0@example.com');
    const forward = await splitOk(server, tok0, { amount: 10, participant_handles: ['u0', 'u1', 'u2'] });
    const backward = await splitOk(server, tok0, { amount: 10, participant_handles: ['u2', 'u1', 'u0'] });
    assert(
      JSON.stringify(forward.shares.map((s) => s.amount)) === '[4,3,3]' && JSON.stringify(backward.shares.map((s) => s.amount)) === '[4,3,3]',
      `criterion 2: both orders give the shape [4,3,3] in their own order (got ${JSON.stringify(forward.shares)} / ${JSON.stringify(backward.shares)})`,
    );
    assert(forward.shares[0].handle === 'u0' && backward.shares[0].handle === 'u2', 'criterion 2: the extra unit follows participant order, not a fixed identity');
  }

  // ---- criterion 3: shares includes the caller (in order given); requests excludes the caller ----
  {
    await reset(server, { users: usersOf(4) });
    const tok0 = await login(server, 'u0@example.com');
    const r = await splitOk(server, tok0, { amount: 400, participant_handles: ['u1', 'u0', 'u2'] });
    assert(
      JSON.stringify(r.shares.map((s) => s.handle)) === JSON.stringify(['u1', 'u0', 'u2']) && r.shares.reduce((s, x) => s + x.amount, 0) === 400,
      `criterion 3: shares covers every given participant including the caller, in order, summing to amount (got ${JSON.stringify(r.shares)})`,
    );
    assert(
      JSON.stringify(r.requests.map((x) => x.payer_handle)) === JSON.stringify(['u1', 'u2']),
      `criterion 3: requests covers every participant except the caller, same order (got ${JSON.stringify(r.requests.map((x) => x.payer_handle))})`,
    );
  }

  // ---- criterion 4: a caller-only split is valid ----
  {
    await reset(server, { users: usersOf(2) });
    const tok0 = await login(server, 'u0@example.com');
    const r = await split(server, tok0, { amount: 50, participant_handles: ['u0'] }, key('c4'));
    assert(r.status === 201, `criterion 4: caller-only split -> 201 (got ${r.status})`);
    assert(r.json.shares.length === 1 && r.json.shares[0].handle === 'u0' && r.json.shares[0].amount === 50, `criterion 4: one share (got ${JSON.stringify(r.json.shares)})`);
    assert(Array.isArray(r.json.requests) && r.json.requests.length === 0, `criterion 4: requests: [] (got ${JSON.stringify(r.json.requests)})`);
  }

  // ---- criterion 5: a share of 0 is legal and still produces a request ----
  {
    await reset(server, { users: usersOf(6) });
    const tok0 = await login(server, 'u0@example.com');
    const r = await splitOk(server, tok0, { amount: 1, participant_handles: ['u0', 'u1', 'u2', 'u3', 'u4', 'u5'] });
    const zeroShare = r.shares.find((s) => s.amount === 0);
    assert(!!zeroShare, `criterion 5: a 6-way split of 1 produces at least one zero share (got ${JSON.stringify(r.shares)})`);
    const zeroReq = r.requests.find((x) => x.payer_handle === zeroShare.handle);
    assert(!!zeroReq && zeroReq.amount === 0, `criterion 5: the zero-share participant still gets a request, for 0 (got ${JSON.stringify(zeroReq)})`);
    assert(r.requests.length === 5, `criterion 5: a request for every non-caller participant, zero share included (got ${r.requests.length})`);
  }

  // ---- criterion 6: field validation per §8's table ----
  {
    await reset(server, { users: usersOf(3) });
    const tok0 = await login(server, 'u0@example.com');
    for (const bad of [0, -1, 1000000001, 1.5, '100', true, null]) {
      const r = await split(server, tok0, { amount: bad, participant_handles: ['u0'] }, key('c6a'));
      assert(r.status === 422 && r.json.error.code === 'validation_failed', `criterion 6: amount ${JSON.stringify(bad)} -> 422 (got ${r.status} ${r.json && r.json.error && r.json.error.code})`);
    }
    const emptyHandles = await split(server, tok0, { amount: 10, participant_handles: [] }, key('c6b'));
    assert(emptyHandles.status === 422 && emptyHandles.json.error.code === 'validation_failed', `criterion 6: empty participant_handles -> 422 (got ${emptyHandles.status})`);
    const dupHandles = await split(server, tok0, { amount: 10, participant_handles: ['u0', 'u1', 'u0'] }, key('c6c'));
    assert(dupHandles.status === 422 && dupHandles.json.error.code === 'validation_failed', `criterion 6: duplicate participant_handles -> 422 (got ${dupHandles.status})`);
    const longNote = await split(server, tok0, { amount: 10, participant_handles: ['u0'], note: 'x'.repeat(201) }, key('c6d'));
    assert(longNote.status === 422 && longNote.json.error.code === 'validation_failed', `criterion 6: note > 200 code points -> 422 (got ${longNote.status})`);
    const okNote = await split(server, tok0, { amount: 10, participant_handles: ['u0'], note: '🎉'.repeat(200) }, key('c6e'));
    assert(okNote.status === 201, `criterion 6: a 200-code-point note is accepted (got ${okNote.status})`);
    const unknownHandle = await split(server, tok0, { amount: 10, participant_handles: ['ghost'] }, key('c6f'));
    assert(unknownHandle.status === 404 && unknownHandle.json.error.code === 'not_found', `criterion 6: unknown handle -> 404 (got ${unknownHandle.status})`);
  }

  // ---- criterion 7 (D22): ["ghost","ghost"] -> 422 for the duplicate, not 404 ----
  {
    await reset(server, { users: usersOf(2) });
    const tok0 = await login(server, 'u0@example.com');
    const r = await split(server, tok0, { amount: 10, participant_handles: ['ghost', 'ghost'] }, key('c7'));
    assert(r.status === 422 && r.json.error.code === 'validation_failed', `criterion 7: ["ghost","ghost"] -> 422 for the duplicate, not 404 (got ${r.status} ${r.json && r.json.error && r.json.error.code})`);
  }

  // ---- criterion 8: nothing about a split checks a balance ----
  {
    await reset(server, { users: usersOf(3, 0) });
    const tok0 = await login(server, 'u0@example.com');
    const r = await split(server, tok0, { amount: 999999, participant_handles: ['u0', 'u1', 'u2'] }, key('c8'));
    assert(r.status === 201, `criterion 8: a split among zero-balance participants still succeeds -> 201 (got ${r.status})`);
  }

  // ---- criterion 9 (R9.5): balances sum to seeded total after splits are paid in full ----
  {
    const users = usersOf(4, 1000);
    await reset(server, { users });
    const seededTotal = users.reduce((s, u) => s + u.balance, 0);
    const tok0 = await login(server, 'u0@example.com');
    const r = await splitOk(server, tok0, { amount: 100, participant_handles: ['u0', 'u1', 'u2', 'u3'] });
    for (const req_ of r.requests) {
      const payerTok = await login(server, `${req_.payer_handle}@example.com`);
      // eslint-disable-next-line no-await-in-loop -- sequential on purpose: paying each in turn, not a concurrency check
      const paid = await payReq(server, payerTok, req_.request_id, {}, key('c9pay'));
      assert(paid.status === 201, `criterion 9 setup: paying ${req_.request_id} -> 201 (got ${paid.status})`);
    }
    const balances = await Promise.all(users.map((u) => login(server, u.email).then((t) => balance(server, t))));
    const total = balances.reduce((s, b) => s + b, 0);
    assert(total === seededTotal, `criterion 9 (R9.5): balances still sum to the seeded total after the split is paid in full (seeded ${seededTotal}, got ${total})`);
  }

  // ---- criterion 10 (R4.15): a split is not a feed item; its requests are visible only to their two parties ----
  {
    await reset(server, { users: usersOf(4) });
    const tok0 = await login(server, 'u0@example.com');
    const tok3 = await login(server, 'u3@example.com');
    const r = await splitOk(server, tok0, { amount: 300, participant_handles: ['u0', 'u1', 'u2'] });
    const feed0 = await activity(server, tok0);
    assert(feed0.json.payments.length === 0, `criterion 10: a fresh split creates no feed items (got ${feed0.json.payments.length})`);
    const list1 = await listReqs(server, await login(server, 'u1@example.com'));
    const list3 = await listReqs(server, tok3);
    const reqId = r.requests.find((x) => x.payer_handle === 'u1').request_id;
    assert(!!list1.json.requests.find((x) => x.request_id === reqId), 'criterion 10: the split request is visible to its own payer');
    assert(!list3.json.requests.find((x) => x.request_id === reqId), `criterion 10: an unrelated third party cannot see it (got ${list3.json.requests.length} items)`);
  }

  // ---- criterion 11: POST /splits is an idempotent write path ----
  {
    await reset(server, { users: usersOf(3) });
    const tok0 = await login(server, 'u0@example.com');
    const missing = await req(server, 'POST', '/splits', { amount: 10, participant_handles: ['u0'] }, auth(tok0));
    assert(missing.status === 400 && missing.json.error.code === 'missing_idempotency_key', `criterion 11: missing key -> 400 (got ${missing.status})`);
    const empty = await split(server, tok0, { amount: 10, participant_handles: ['u0'] }, '');
    assert(empty.status === 400 && empty.json.error.code === 'missing_idempotency_key', `criterion 11: empty key -> 400 (got ${empty.status})`);

    const k = key('c11');
    const body = { amount: 90, participant_handles: ['u0', 'u1', 'u2'], note: 'idem' };
    const first = await split(server, tok0, body, k);
    assert(first.status === 201, `criterion 11 setup: first use -> 201 (got ${first.status})`);
    const listBefore = await listReqs(server, tok0, '?direction=outgoing');
    const replay = await split(server, tok0, body, k);
    assert(replay.status === 200, `criterion 11: replay -> 200 (got ${replay.status})`);
    assert(replay.raw === first.raw, 'criterion 11: replay body is byte-identical to the original response (R7.7)');
    const listAfter = await listReqs(server, tok0, '?direction=outgoing');
    assert(listBefore.json.requests.length === listAfter.json.requests.length, `criterion 11: the replay created no second set of requests (before ${listBefore.json.requests.length}, after ${listAfter.json.requests.length})`);

    const clash = await split(server, tok0, { ...body, amount: 91 }, k);
    assert(clash.status === 409 && clash.json.error.code === 'idempotency_key_reuse', `criterion 11: same key, different body -> 409 (got ${clash.status} ${clash.json && clash.json.error && clash.json.error.code})`);
  }

  // ---- criterion 12: the 201 envelope, and D8's literal +00:00 offset ----
  {
    await reset(server, { users: usersOf(2) });
    const tok0 = await login(server, 'u0@example.com');
    const r = await split(server, tok0, { amount: 10, participant_handles: ['u0'] }, key('c12'));
    assert(
      Object.keys(r.json).sort().join(',') === ['split_id', 'amount', 'currency', 'note', 'shares', 'requests', 'created_at'].sort().join(','),
      `criterion 12: the envelope is exactly split_id/amount/currency/note/shares/requests/created_at (got ${JSON.stringify(Object.keys(r.json))})`,
    );
    assert(r.json.created_at.endsWith('+00:00'), `criterion 12 (D8): created_at carries a literal +00:00 offset (got ${r.json.created_at})`);
  }

  // ---- criterion 13: each request is payable, moving exactly that share ----
  {
    await reset(server, { users: usersOf(3, 100000) });
    const tok0 = await login(server, 'u0@example.com');
    const r = await splitOk(server, tok0, { amount: 100, participant_handles: ['u0', 'u1', 'u2'] });
    const target = r.requests[0];
    const payerTok = await login(server, `${target.payer_handle}@example.com`);
    const before = await balance(server, payerTok);
    const paid = await payReq(server, payerTok, target.request_id, {}, key('c13'));
    assert(paid.status === 201 && paid.json.amount === target.amount, `criterion 13: a split request is payable through POST /requests/{id}/pay for exactly its share (got status ${paid.status}, amount ${paid.json && paid.json.amount}, want ${target.amount})`);
    const after = await balance(server, payerTok);
    assert(before - after === target.amount, `criterion 13: the payer's balance moved by exactly that share (before ${before}, after ${after})`);
  }

  // ---- criterion 14 (R9.4): independence -- two identical splits produce identical shares ----
  {
    await reset(server, { users: usersOf(3) });
    const tok0 = await login(server, 'u0@example.com');
    const first = await splitOk(server, tok0, { amount: 10, participant_handles: ['u0', 'u1', 'u2'] });
    const second = await splitOk(server, tok0, { amount: 10, participant_handles: ['u0', 'u1', 'u2'] });
    assert(
      JSON.stringify(first.shares) === JSON.stringify(second.shares),
      `criterion 14 (R9.4): two splits of the same amount and handles produce identical shares, independent of each other (got ${JSON.stringify(first.shares)} vs ${JSON.stringify(second.shares)})`,
    );
  }

  // ---- criterion 15 (D30): the export guard still passes ----
  {
    await reset(server, { users: usersOf(2) });
    const tok0 = await login(server, 'u0@example.com');
    await splitOk(server, tok0, { amount: 10, participant_handles: ['u0', 'u1'] });
    const coverage = checkExportCoverage(emptyState, serializeState);
    assert(coverage.ok, `criterion 15: D30 export-coverage guard still passes (missing: ${JSON.stringify(coverage.missing)})`);
    const exp = await req(server, 'GET', '/_test/export');
    assert(Array.isArray(exp.json.state.splits) && exp.json.state.splits.length === 1, `criterion 15: the export carries the split (got ${JSON.stringify(exp.json.state.splits)})`);
  }

  server.close();
  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
}

main().catch((e) => { console.error(e); process.exit(1); });
