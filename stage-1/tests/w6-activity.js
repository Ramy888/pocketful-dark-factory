'use strict';

// Durable evidence for W6 (GET /activity), committed per D28. Exercises
// the delivered server (src/server.js's createServer()) over real HTTP.
//
// D47/D50 discipline: every assertion here records a real comparison, no
// bare early return on an expected-failure branch, and status/code checks
// that an absent route could also produce are preceded by a control call
// proving the route exists first (criterion 7's 401 is not one of these --
// an absent route answers 404, not 401, so no control is needed there).

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

async function pay(server, tok, body) {
  const r = await req(server, 'POST', '/payments', body, { ...auth(tok), 'Idempotency-Key': key('pay') });
  if (r.status !== 201) throw new Error(`payment setup failed: ${r.status} ${r.raw}`);
  return r.json;
}

function activity(server, tok, qs = '') {
  return req(server, 'GET', `/activity${qs}`, undefined, auth(tok));
}

const threeUsers = [
  { id: 'u_a', email: 'a@example.com', password: 'correct horse', display_name: 'A', handle: 'a', balance: 100000 },
  { id: 'u_b', email: 'b@example.com', password: 'correct horse', display_name: 'B', handle: 'b', balance: 100000 },
  { id: 'u_c', email: 'c@example.com', password: 'correct horse', display_name: 'C', handle: 'c', balance: 100000 },
];

async function main() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  // ---- criterion 7 control: prove the route exists before anything that could 401/404-confuse ----
  {
    await reset(server, { users: threeUsers });
    const tokA = await login(server, 'a@example.com');
    const control = await activity(server, tokA);
    assert(control.status === 200, `route-exists control: GET /activity with a valid token -> 200 (got ${control.status})`);
  }

  // ---- criterion 1: a public payment is visible to sender, receiver and an unrelated caller ----
  {
    await reset(server, { users: threeUsers });
    const tokA = await login(server, 'a@example.com');
    const tokB = await login(server, 'b@example.com');
    const tokC = await login(server, 'c@example.com');
    const p = await pay(server, tokA, { to_handle: 'b', amount: 10, visibility: 'public' });
    for (const [label, tok] of [['sender', tokA], ['receiver', tokB], ['unrelated', tokC]]) {
      const r = await activity(server, tok);
      const found = r.json.payments.find((x) => x.payment_id === p.payment_id);
      assert(!!found, `criterion 1: public payment visible to ${label} (got ${r.json.payments.length} items)`);
    }
  }

  // ---- criterion 2: a private payment is visible to sender+receiver, absent for an unrelated caller ----
  {
    await reset(server, { users: threeUsers });
    const tokA = await login(server, 'a@example.com');
    const tokB = await login(server, 'b@example.com');
    const tokC = await login(server, 'c@example.com');
    const p = await pay(server, tokA, { to_handle: 'b', amount: 10, visibility: 'private' });
    const rA = await activity(server, tokA);
    const rB = await activity(server, tokB);
    const rC = await activity(server, tokC);
    assert(!!rA.json.payments.find((x) => x.payment_id === p.payment_id), 'criterion 2: private payment visible to sender');
    assert(!!rB.json.payments.find((x) => x.payment_id === p.payment_id), 'criterion 2: private payment visible to receiver');
    assert(!rC.json.payments.find((x) => x.payment_id === p.payment_id), `criterion 2: private payment absent for an unrelated caller (got ${rC.json.payments.length} items)`);
  }

  // ---- criterion 3: newest-first, and repeated calls with no writes agree ----
  {
    await reset(server, { users: threeUsers });
    const tokA = await login(server, 'a@example.com');
    const p1 = await pay(server, tokA, { to_handle: 'b', amount: 1 });
    const p2 = await pay(server, tokA, { to_handle: 'b', amount: 2 });
    const p3 = await pay(server, tokA, { to_handle: 'b', amount: 3 });
    const r1 = await activity(server, tokA);
    const ids1 = r1.json.payments.map((p) => p.payment_id);
    assert(
      ids1.indexOf(p3.payment_id) < ids1.indexOf(p2.payment_id) && ids1.indexOf(p2.payment_id) < ids1.indexOf(p1.payment_id),
      `criterion 3: newest-first order (got ${JSON.stringify(ids1)})`,
    );
    const r2 = await activity(server, tokA);
    const ids2 = r2.json.payments.map((p) => p.payment_id);
    assert(JSON.stringify(ids1) === JSON.stringify(ids2), 'criterion 3: two identical calls with no writes in between return the same order');
  }

  // ---- criterion 4: limit/offset walk, has_more exactly while items remain ----
  {
    await reset(server, { users: threeUsers });
    const tokA = await login(server, 'a@example.com');
    const p1 = await pay(server, tokA, { to_handle: 'b', amount: 1 });
    const p2 = await pay(server, tokA, { to_handle: 'b', amount: 2 });
    const page0 = await activity(server, tokA, '?limit=1&offset=0');
    assert(page0.json.payments.length === 1 && page0.json.payments[0].payment_id === p2.payment_id, `criterion 4: limit=1&offset=0 returns the newest (got ${JSON.stringify(page0.json.payments.map((p) => p.payment_id))})`);
    assert(page0.json.has_more === true, 'criterion 4: has_more true while an item remains');
    const page1 = await activity(server, tokA, '?limit=1&offset=1');
    assert(page1.json.payments.length === 1 && page1.json.payments[0].payment_id === p1.payment_id, `criterion 4: limit=1&offset=1 returns the next (got ${JSON.stringify(page1.json.payments.map((p) => p.payment_id))})`);
    assert(page1.json.has_more === false, 'criterion 4: has_more false once nothing remains');
  }

  // ---- criterion 5: limit/offset validation ----
  {
    await reset(server, { users: threeUsers });
    const tokA = await login(server, 'a@example.com');
    for (const qs of ['?limit=0', '?limit=201', '?limit=-1', '?offset=-1', '?limit=1e9', '?limit=4.0', '?limit=%2B4']) {
      const r = await activity(server, tokA, qs);
      assert(r.status === 422 && r.json.error.code === 'validation_failed', `criterion 5: ${qs} -> 422 validation_failed (got ${r.status} ${r.json && r.json.error && r.json.error.code})`);
    }
    const ok200 = await activity(server, tokA, '?limit=200');
    assert(ok200.status === 200, `criterion 5: limit=200 accepted (got ${ok200.status})`);
    const ok1 = await activity(server, tokA, '?limit=1');
    assert(ok1.status === 200, `criterion 5: limit=1 accepted (got ${ok1.status})`);
    const okOffset0 = await activity(server, tokA, '?offset=0');
    assert(okOffset0.status === 200, `criterion 5: offset=0 accepted (got ${okOffset0.status})`);
  }

  // ---- criterion 6: unknown query parameters ignored ----
  {
    await reset(server, { users: threeUsers });
    const tokA = await login(server, 'a@example.com');
    const r = await activity(server, tokA, '?bogus=1&another=thing');
    assert(r.status === 200, `criterion 6: unknown query params ignored -> 200 (got ${r.status})`);
  }

  // ---- criterion 7: no token -> 401 ----
  {
    await reset(server, { users: threeUsers });
    const r = await req(server, 'GET', '/activity');
    assert(r.status === 401 && r.json.error.code === 'unauthenticated', `criterion 7: no token -> 401 unauthenticated (got ${r.status} ${r.json && r.json.error && r.json.error.code})`);
  }

  // ---- criterion 8 (D48): a note round-trips byte for byte through /activity ----
  {
    await reset(server, { users: threeUsers });
    const tokA = await login(server, 'a@example.com');
    const note = 'é́ 🇬🇧 👨‍👩‍👧‍👦 combining ñ zalgo';
    const p = await pay(server, tokA, { to_handle: 'b', amount: 1, note });
    const r = await activity(server, tokA);
    const found = r.json.payments.find((x) => x.payment_id === p.payment_id);
    assert(!!found && found.note === note, `criterion 8: emoji/combining-mark note round-trips byte for byte through /activity (got ${JSON.stringify(found && found.note)})`);
  }

  // ---- criterion 9: envelope shape and item-identical-to-POST-response ----
  {
    await reset(server, { users: threeUsers });
    const tokA = await login(server, 'a@example.com');
    const p = await pay(server, tokA, { to_handle: 'b', amount: 7, note: 'nine' });
    const r = await activity(server, tokA);
    assert(Object.keys(r.json).sort().join(',') === 'has_more,payments', `criterion 9: envelope is exactly {payments, has_more} (got keys ${JSON.stringify(Object.keys(r.json))})`);
    assert(typeof r.json.has_more === 'boolean', 'criterion 9: has_more is a boolean');
    assert(Array.isArray(r.json.payments), 'criterion 9: payments is an array');
    const found = r.json.payments.find((x) => x.payment_id === p.payment_id);
    assert(JSON.stringify(found) === JSON.stringify(p), `criterion 9: the feed item is byte-identical to what POST /payments returned (got ${JSON.stringify(found)} vs ${JSON.stringify(p)})`);
  }

  // ---- criterion 10: defaults (limit 50, offset 0), observable with 51 visible payments ----
  {
    await reset(server, { users: threeUsers });
    const tokA = await login(server, 'a@example.com');
    for (let i = 0; i < 51; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- sequential on purpose: newest-first ordering must be deterministic, not raced
      await pay(server, tokA, { to_handle: 'b', amount: 1 });
    }
    const r = await activity(server, tokA);
    assert(r.json.payments.length === 50, `criterion 10: absent limit defaults to 50 (got ${r.json.payments.length})`);
    assert(r.json.has_more === true, 'criterion 10: has_more true with 51 visible and only 50 returned');
  }

  // ---- criterion 11: a seeded request never appears in /activity ----
  {
    await reset(server, {
      users: threeUsers,
      requests: [{ id: 'rq_1', requester_id: 'u_a', payer_id: 'u_b', amount: 500, note: 'seeded', status: 'pending' }],
    });
    const tokA = await login(server, 'a@example.com');
    const r = await activity(server, tokA);
    const leaked = r.json.payments.find((x) => x.payment_id === 'rq_1' || x.request_id === 'rq_1');
    assert(!leaked, `criterion 11: a seeded request never appears in /activity (payments: ${JSON.stringify(r.json.payments.map((p) => p.payment_id))})`);
    assert(r.json.payments.length === 0, 'criterion 11: no payments exist yet, so the feed is empty, not the seeded request masquerading as one');
  }

  // ---- criterion 12 (R4.16): a public payment's object is byte-identical to sender, receiver and an unrelated caller ----
  {
    await reset(server, { users: threeUsers });
    const tokA = await login(server, 'a@example.com');
    const tokB = await login(server, 'b@example.com');
    const tokC = await login(server, 'c@example.com');
    const p = await pay(server, tokA, { to_handle: 'b', amount: 42, note: 'shared', visibility: 'public' });
    const rA = await activity(server, tokA);
    const rB = await activity(server, tokB);
    const rC = await activity(server, tokC);
    const itemA = rA.json.payments.find((x) => x.payment_id === p.payment_id);
    const itemB = rB.json.payments.find((x) => x.payment_id === p.payment_id);
    const itemC = rC.json.payments.find((x) => x.payment_id === p.payment_id);
    assert(
      JSON.stringify(itemA) === JSON.stringify(itemB) && JSON.stringify(itemB) === JSON.stringify(itemC),
      `criterion 12: one visibility value seen identically by sender, receiver and an unrelated caller (got ${JSON.stringify(itemA)}, ${JSON.stringify(itemB)}, ${JSON.stringify(itemC)})`,
    );
  }

  // ---- criterion 13 (D30): the export guard still passes with the activity route live ----
  {
    await reset(server, { users: threeUsers });
    const tokA = await login(server, 'a@example.com');
    await pay(server, tokA, { to_handle: 'b', amount: 1 });
    await activity(server, tokA);
    const coverage = checkExportCoverage(emptyState, serializeState);
    assert(coverage.ok, `criterion 13: D30 export-coverage guard still passes (missing: ${JSON.stringify(coverage.missing)})`);
  }

  server.close();
  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
}

main().catch((e) => { console.error(e); process.exit(1); });
