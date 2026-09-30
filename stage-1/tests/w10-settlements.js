'use strict';

// Durable evidence for W10 (POST /settlements), committed per D28.
//
// D47/D50 discipline: every assertion records a real comparison, no bare
// early return. A control call precedes any check whose expected
// status/code an absent route could also produce.

const http = require('http');

const { createServer } = require('../src/server');
const { checkExportCoverage, checkRecordFieldCoverage } = require('../src/lib/exportGuard');
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
    currency: 'EUR', minor_units: 2, payments: [], requests: [], settlement_operator_ids: [], ...fixture,
  });
  if (r.status !== 204) throw new Error(`reset failed: ${r.status} ${r.raw}`);
}
async function login(server, email) {
  const r = await req(server, 'POST', '/auth/login', { email, password: 'correct horse' });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${r.raw}`);
  return r.json.token;
}
function auth(tok) { return { Authorization: `Bearer ${tok}` }; }
function settle(server, tok, body, k) {
  const headers = { ...auth(tok) };
  if (k !== undefined) headers['Idempotency-Key'] = k;
  return req(server, 'POST', '/settlements', body, headers);
}
async function settleOk(server, tok, body) {
  const r = await settle(server, tok, body, key('stl'));
  if (r.status !== 201) throw new Error(`settlement setup failed: ${r.status} ${r.raw}`);
  return r.json;
}
async function balance(server, tok) {
  const r = await req(server, 'GET', '/me', undefined, auth(tok));
  return r.json.balance;
}
async function activity(server, tok) {
  return req(server, 'GET', '/activity', undefined, auth(tok));
}

let seq = 0;
function key(prefix = 'k') { seq += 1; return `${prefix}-${process.pid}-${Date.now().toString(36)}-${seq}`; }

function users(specs) {
  return specs.map(([handle, balanceAmt]) => ({
    id: `u_${handle}`, email: `${handle}@example.com`, password: 'correct horse',
    display_name: handle, handle, balance: balanceAmt,
  }));
}

async function main() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  // ---- route-exists control (D47/D50) ----
  {
    await reset(server, { users: users([['a', 1000], ['b', 0]]), settlement_operator_ids: ['u_a'] });
    const tokA = await login(server, 'a@example.com');
    const control = await settle(server, tokA, { transfers: [{ from_handle: 'a', to_handle: 'b', amount: 10 }] }, key('ctrl'));
    assert(control.status === 201, `route-exists control: POST /settlements -> 201 (got ${control.status})`);
  }

  // ---- criterion 1: shape, input order, shared timestamp ----
  {
    await reset(server, { users: users([['a', 1000], ['b', 0], ['c', 0]]), settlement_operator_ids: ['u_a'] });
    const tokA = await login(server, 'a@example.com');
    const r = await settle(server, tokA, { transfers: [
      { from_handle: 'a', to_handle: 'b', amount: 40 },
      { from_handle: 'a', to_handle: 'c', amount: 60 },
    ] }, key('c1'));
    assert(r.status === 201, `criterion 1: 2 transfers -> 201 (got ${r.status})`);
    assert(typeof r.json.settlement_id === 'string' && typeof r.json.committed_at === 'string', 'criterion 1: settlement_id and committed_at present');
    assert(r.json.payments.length === 2 && r.json.payments[0].to_handle === 'b' && r.json.payments[1].to_handle === 'c', `criterion 1: payments in input order (got ${JSON.stringify(r.json.payments.map((p) => p.to_handle))})`);
    for (const p of r.json.payments) {
      assert(p.settlement_id === r.json.settlement_id, `criterion 1: member carries the batch settlement_id (got ${p.settlement_id})`);
      assert(p.request_id === null, 'criterion 1: member request_id is null');
      assert(p.created_at === r.json.committed_at, `criterion 1: member created_at equals committed_at (got ${p.created_at} vs ${r.json.committed_at})`);
    }
    assert(r.json.payments[0].created_at === r.json.payments[1].created_at, 'criterion 1: all members share one created_at stamp');
  }

  // ---- criterion 2: an ordinary payment has settlement_id: null ----
  {
    await reset(server, { users: users([['a', 1000], ['b', 0]]) });
    const tokA = await login(server, 'a@example.com');
    const p = await req(server, 'POST', '/payments', { to_handle: 'b', amount: 10 }, { ...auth(tokA), 'Idempotency-Key': key('c2') });
    assert(p.status === 201 && p.json.settlement_id === null, `criterion 2: an ordinary payment has settlement_id null (got ${p.status} ${p.json && p.json.settlement_id})`);
  }

  // ---- criterion 3: no token -> 401; authenticated non-operator -> 403 ----
  {
    await reset(server, { users: users([['a', 1000], ['b', 0]]), settlement_operator_ids: [] });
    const noToken = await req(server, 'POST', '/settlements', { transfers: [{ from_handle: 'a', to_handle: 'b', amount: 10 }] }, { 'Idempotency-Key': key('c3a') });
    assert(noToken.status === 401 && noToken.json.error.code === 'unauthenticated', `criterion 3: no token -> 401 (got ${noToken.status})`);
    const tokA = await login(server, 'a@example.com');
    const nonOperator = await settle(server, tokA, { transfers: [{ from_handle: 'a', to_handle: 'b', amount: 10 }] }, key('c3b'));
    assert(nonOperator.status === 403 && nonOperator.json.error.code === 'forbidden', `criterion 3: authenticated non-operator -> 403 forbidden (got ${nonOperator.status} ${nonOperator.json && nonOperator.json.error && nonOperator.json.error.code})`);
  }

  // ---- criterion 4/7 net affordability: a matched pair, both orderings ----
  {
    await reset(server, { users: users([['a', 10000], ['b', 2500], ['c', 0]]), settlement_operator_ids: ['u_a'] });
    const tokA = await login(server, 'a@example.com');
    const forward = await settle(server, tokA, { transfers: [
      { from_handle: 'a', to_handle: 'b', amount: 10000 },
      { from_handle: 'b', to_handle: 'c', amount: 12500 },
    ] }, key('c4a'));
    assert(forward.status === 201, `criterion 4: a->b 10000 then b->c 12500 (draining after refill) commits -> 201 (got ${forward.status})`);
    const balA1 = await balance(server, tokA);
    const balB1 = await balance(server, await login(server, 'b@example.com'));
    const balC1 = await balance(server, await login(server, 'c@example.com'));
    assert(balA1 === 0 && balB1 === 0 && balC1 === 12500, `criterion 4: end state ada 0, bob 0, cy 12500 (got ${balA1}, ${balB1}, ${balC1})`);

    await reset(server, { users: users([['a', 10000], ['b', 2500], ['c', 0]]), settlement_operator_ids: ['u_a'] });
    const tokA2 = await login(server, 'a@example.com');
    const backward = await settle(server, tokA2, { transfers: [
      { from_handle: 'b', to_handle: 'c', amount: 12500 },
      { from_handle: 'a', to_handle: 'b', amount: 10000 },
    ] }, key('c4b'));
    assert(backward.status === 201, `criterion 4 (D23 net check): the SAME batch with the draining transfer FIRST also commits -> 201 (got ${backward.status})`);
  }

  // ---- criterion 5: an unaffordable batch -> 409, nothing moved, key not claimed ----
  {
    await reset(server, { users: users([['a', 100], ['b', 0]]), settlement_operator_ids: ['u_a'] });
    const tokA = await login(server, 'a@example.com');
    const k = key('c5');
    const before = await balance(server, tokA);
    const bad = await settle(server, tokA, { transfers: [{ from_handle: 'a', to_handle: 'b', amount: 1000 }] }, k);
    assert(bad.status === 409 && bad.json.error.code === 'insufficient_funds', `criterion 5: collectively unaffordable -> 409 (got ${bad.status} ${bad.json && bad.json.error && bad.json.error.code})`);
    const after = await balance(server, tokA);
    assert(before === after, `criterion 5: no balance moved (before ${before}, after ${after})`);
    const activityAfter = await activity(server, tokA);
    assert(activityAfter.json.payments.length === 0, 'criterion 5: no payment created');
    const retry = await settle(server, tokA, { transfers: [{ from_handle: 'a', to_handle: 'b', amount: 50 }] }, k);
    assert(retry.status === 201, `criterion 5: the key was never claimed -- the same key with a valid body now succeeds (got ${retry.status})`);
  }

  // ---- criterion 6: transfers count bounds ----
  {
    await reset(server, { users: users([['a', 1000000000], ...Array.from({ length: 32 }, (_, i) => [`p${i}`, 0])]), settlement_operator_ids: ['u_a'] });
    const tokA = await login(server, 'a@example.com');
    const empty = await settle(server, tokA, { transfers: [] }, key('c6a'));
    assert(empty.status === 422 && empty.json.error.code === 'validation_failed', `criterion 6: empty transfers -> 422 (got ${empty.status})`);
    const absent = await settle(server, tokA, {}, key('c6b'));
    assert(absent.status === 422 && absent.json.error.code === 'validation_failed', `criterion 6: absent transfers -> 422 (got ${absent.status})`);
    const notArray = await settle(server, tokA, { transfers: 'nope' }, key('c6c'));
    assert(notArray.status === 422 && notArray.json.error.code === 'validation_failed', `criterion 6 (R11.7): transfers not an array -> 422 validation_failed, the "malformed batch shape" case, not the general R5.2 wrong-type-is-400 rule (got ${notArray.status} ${notArray.json && notArray.json.error && notArray.json.error.code})`);
    const thirtyThree = await settle(server, tokA, { transfers: Array.from({ length: 33 }, (_, i) => ({ from_handle: 'a', to_handle: `p${i % 32}`, amount: 1 })) }, key('c6d'));
    assert(thirtyThree.status === 422 && thirtyThree.json.error.code === 'validation_failed', `criterion 6: 33 transfers -> 422 (got ${thirtyThree.status})`);
    const thirtyTwo = await settle(server, tokA, { transfers: Array.from({ length: 32 }, (_, i) => ({ from_handle: 'a', to_handle: `p${i}`, amount: 1 })) }, key('c6e'));
    assert(thirtyTwo.status === 201 && thirtyTwo.json.payments.length === 32, `criterion 6: 32 transfers succeed with 32 receipts (got ${thirtyTwo.status}, ${thirtyTwo.json && thirtyTwo.json.payments.length})`);
  }

  // ---- criterion 7: entry errors in input order, before insufficient funds ----
  {
    await reset(server, { users: users([['a', 5], ['b', 0], ['c', 0]]), settlement_operator_ids: ['u_a'] });
    const tokA = await login(server, 'a@example.com');
    const r = await settle(server, tokA, { transfers: [
      { from_handle: 'a', to_handle: 'b', amount: 20000 }, // looks unaffordable alone
      { from_handle: 'ghost', to_handle: 'c', amount: 1 }, // unknown handle, entry 2
      { from_handle: 'c', to_handle: 'c', amount: 1 }, // self-transfer, entry 3
    ] }, key('c7'));
    assert(r.status === 404 && r.json.error.code === 'not_found', `criterion 7: unknown handle in entry 2 -> 404, even with an unaffordable entry 1 and a self-transfer entry 3 (got ${r.status} ${r.json && r.json.error && r.json.error.code})`);
  }

  // ---- criterion 8: self-transfer -> 422 self_payment ----
  {
    await reset(server, { users: users([['a', 1000]]), settlement_operator_ids: ['u_a'] });
    const tokA = await login(server, 'a@example.com');
    const r = await settle(server, tokA, { transfers: [{ from_handle: 'a', to_handle: 'a', amount: 10 }] }, key('c8'));
    assert(r.status === 422 && r.json.error.code === 'self_payment', `criterion 8: self-transfer -> 422 self_payment (got ${r.status} ${r.json && r.json.error && r.json.error.code})`);
  }

  // ---- criterion 9: unknown fields inside a transfer ignored ----
  {
    await reset(server, { users: users([['a', 1000], ['b', 0]]), settlement_operator_ids: ['u_a'] });
    const tokA = await login(server, 'a@example.com');
    const r = await settle(server, tokA, { transfers: [{ from_handle: 'a', to_handle: 'b', amount: 10, bogus: 'field', another: 42 }] }, key('c9'));
    assert(r.status === 201, `criterion 9: unknown fields inside a transfer are ignored -> 201 (got ${r.status})`);
  }

  // ---- criterion 10: feed visibility per member; response still has every receipt ----
  {
    await reset(server, { users: users([['a', 1000], ['b', 0], ['c', 0]]), settlement_operator_ids: ['u_a'] });
    const tokA = await login(server, 'a@example.com');
    const tokC = await login(server, 'c@example.com');
    const r = await settle(server, tokA, { transfers: [{ from_handle: 'a', to_handle: 'b', amount: 10, visibility: 'private' }] }, key('c10'));
    assert(r.status === 201 && r.json.payments.length === 1, `criterion 10 setup: private member settlement -> 201 with its receipt present in the response (got ${r.status}, ${r.json && r.json.payments.length})`);
    const feedC = await activity(server, tokC);
    assert(!feedC.json.payments.find((p) => p.payment_id === r.json.payments[0].payment_id), 'criterion 10: a private member is hidden from an unrelated third party\'s feed');
  }

  // ---- criterion 11: replay -> 200 original complete response, no further movement ----
  {
    await reset(server, { users: users([['a', 1000], ['b', 0]]), settlement_operator_ids: ['u_a'] });
    const tokA = await login(server, 'a@example.com');
    const k = key('c11');
    const body = { transfers: [{ from_handle: 'a', to_handle: 'b', amount: 10 }] };
    const first = await settle(server, tokA, body, k);
    assert(first.status === 201, `criterion 11 setup: first use -> 201 (got ${first.status})`);
    const balBefore = await balance(server, tokA);
    const replay = await settle(server, tokA, body, k);
    assert(replay.status === 200, `criterion 11: replay -> 200 (got ${replay.status})`);
    assert(replay.raw === first.raw, 'criterion 11: replay is byte-identical to the original complete response');
    const balAfter = await balance(server, tokA);
    assert(balBefore === balAfter, `criterion 11: the replay moved no further money (before ${balBefore}, after ${balAfter})`);
  }

  // ---- criterion 12: operator permission grants no access to others' requests/private items ----
  {
    await reset(server, { users: users([['a', 1000], ['b', 1000], ['c', 1000]]), settlement_operator_ids: ['u_a'] });
    const tokA = await login(server, 'a@example.com');
    const tokB = await login(server, 'b@example.com');
    const rq = await req(server, 'POST', '/requests', { payer_handle: 'a', amount: 10 }, { ...auth(tokB), 'Idempotency-Key': key('c12rq') });
    assert(rq.status === 201, `criterion 12 setup: a request between b and a -> 201 (got ${rq.status})`);
    const listAsOperatorC = await req(server, 'GET', '/requests', undefined, auth(await login(server, 'c@example.com')));
    assert(listAsOperatorC.json.requests.length === 0, 'criterion 12: an unrelated caller (even though a exists as operator) sees none of b\'s request');
    const pay = await req(server, 'POST', '/payments', { to_handle: 'c', amount: 5, visibility: 'private' }, { ...auth(tokB), 'Idempotency-Key': key('c12pay') });
    assert(pay.status === 201, `criterion 12 setup: a private payment b->c -> 201 (got ${pay.status})`);
    const feedAsOperator = await activity(server, tokA);
    assert(!feedAsOperator.json.payments.find((p) => p.payment_id === pay.json.payment_id), 'criterion 12: being an operator grants no visibility into an unrelated private payment');
  }

  // ---- criterion 13: 20 concurrent settlements over overlapping wallets ----
  {
    const ringUsers = users(Array.from({ length: 10 }, (_, i) => [`r${i}`, 1000]));
    await reset(server, { users: ringUsers, settlement_operator_ids: ['u_r0'] });
    const tokOp = await login(server, 'r0@example.com');
    const seededTotal = ringUsers.reduce((s, u) => s + u.balance, 0);
    const calls = Array.from({ length: 20 }, (_, i) => {
      const from = `r${i % 10}`;
      const to = `r${(i + 1) % 10}`;
      return settle(server, tokOp, { transfers: [{ from_handle: from, to_handle: to, amount: 10 }] }, key('c13'));
    });
    const results = await Promise.all(calls);
    assert(results.every((r) => r.status < 500), `criterion 13: no 5xx under 20 concurrent settlements (got ${JSON.stringify(results.map((r) => r.status))})`);
    const balances = await Promise.all(ringUsers.map((u) => login(server, u.email).then((t) => balance(server, t))));
    assert(balances.every((b) => b >= 0), `criterion 13: no wallet ever negative (got ${JSON.stringify(balances)})`);
    assert(balances.reduce((s, b) => s + b, 0) === seededTotal, `criterion 13: total conserved (seeded ${seededTotal}, got ${balances.reduce((s, b) => s + b, 0)})`);
  }

  // ---- criterion 14: R11.19's preservation half, two containers ----
  // A second, independent createServer() instance stands in for the second
  // container -- real HTTP, real JSON serialization on both sides, same
  // reasoning as tests/w9-export-import.js.
  {
    const serverB = createServer();
    await new Promise((resolve) => serverB.listen(0, '127.0.0.1', resolve));

    const fixtureUsers = users([['a', 1000], ['b', 0], ['c', 0]]);
    await reset(server, { users: fixtureUsers, settlement_operator_ids: ['u_a'] });
    const tokA = await login(server, 'a@example.com');
    const k = key('c14');
    const settled = await settle(server, tokA, { transfers: [
      { from_handle: 'a', to_handle: 'b', amount: 30 },
      { from_handle: 'a', to_handle: 'c', amount: 20 },
    ] }, k);
    assert(settled.status === 201, `criterion 14 setup: a settlement on A -> 201 (got ${settled.status})`);

    const exp = await req(server, 'GET', '/_test/export');
    await reset(serverB, { users: fixtureUsers });
    const imp = await req(serverB, 'POST', '/_test/import', exp.json);
    assert(imp.status === 204, `criterion 14 setup: import into B -> 204 (got ${imp.status})`);

    const memberIds = settled.json.payments.map((p) => p.payment_id);
    const nonMemberPay = await req(server, 'POST', '/payments', { to_handle: 'b', amount: 1 }, { ...auth(tokA), 'Idempotency-Key': key('c14np') });
    const exp2 = await req(server, 'GET', '/_test/export');
    await reset(serverB, { users: fixtureUsers });
    const imp2 = await req(serverB, 'POST', '/_test/import', exp2.json);
    assert(imp2.status === 204, `criterion 14: re-import with the non-member payment included -> 204 (got ${imp2.status})`);

    const expB = await req(serverB, 'GET', '/_test/export');
    const settlementOnB = expB.json.state.settlements.find((s) => s.id === settled.json.settlement_id);
    assert(!!settlementOnB, `criterion 14: the settlement still exists on B with the same id (got ${JSON.stringify(expB.json.state.settlements.map((s) => s.id))})`);
    assert(
      JSON.stringify(settlementOnB.payment_ids) === JSON.stringify(memberIds),
      `criterion 14: the batch still resolves to its members, same ids, same order (got ${JSON.stringify(settlementOnB.payment_ids)})`,
    );
    for (const id of memberIds) {
      const memberOnB = expB.json.state.payments.find((p) => p.id === id);
      assert(memberOnB && memberOnB.settlement_id === settled.json.settlement_id, `criterion 14: member ${id} still carries its settlement_id on B (got ${memberOnB && memberOnB.settlement_id})`);
    }
    const nonMemberOnB = expB.json.state.payments.find((p) => p.id === nonMemberPay.json.payment_id);
    assert(nonMemberOnB && nonMemberOnB.settlement_id === null, `criterion 14: a non-member still exposes settlement_id null on B (got ${nonMemberOnB && nonMemberOnB.settlement_id})`);

    // "original payments, requests and retry responses" (§11's last sentence, in full): replay the settlement on B.
    const balBBefore = await balance(serverB, await login(serverB, 'b@example.com'));
    const replayOnB = await settle(serverB, await login(serverB, 'a@example.com'), { transfers: [
      { from_handle: 'a', to_handle: 'b', amount: 30 },
      { from_handle: 'a', to_handle: 'c', amount: 20 },
    ] }, k);
    assert(replayOnB.status === 200, `criterion 14: a settlement replayed on B after the import -> 200 (got ${replayOnB.status})`);
    assert(JSON.stringify(replayOnB.json) === JSON.stringify(settled.json), 'criterion 14: the replay on B returns the original complete response');
    const balBAfter = await balance(serverB, await login(serverB, 'b@example.com'));
    assert(balBBefore === balBAfter, `criterion 14: the replay on B moved no money (before ${balBBefore}, after ${balBAfter})`);

    // Operator permission itself survives too (R11.19's other named case).
    const nonOperatorOnB = await settle(serverB, await login(serverB, 'b@example.com'), { transfers: [{ from_handle: 'a', to_handle: 'b', amount: 1 }] }, key('c14perm'));
    assert(nonOperatorOnB.status === 403, `criterion 14: a non-operator on A is still a non-operator on B (got ${nonOperatorOnB.status})`);
    const operatorOnB = await settle(serverB, await login(serverB, 'a@example.com'), { transfers: [{ from_handle: 'a', to_handle: 'b', amount: 1 }] }, key('c14perm2'));
    assert(operatorOnB.status === 201, `criterion 14: the operator on A is still an operator on B (got ${operatorOnB.status})`);

    serverB.close();
  }

  // ---- criterion 15: the fifth idempotent write path ----
  {
    await reset(server, { users: users([['a', 1000], ['b', 0]]), settlement_operator_ids: ['u_a'] });
    const tokA = await login(server, 'a@example.com');
    const missing = await req(server, 'POST', '/settlements', { transfers: [{ from_handle: 'a', to_handle: 'b', amount: 1 }] }, auth(tokA));
    assert(missing.status === 400 && missing.json.error.code === 'missing_idempotency_key', `criterion 15: missing key -> 400 (got ${missing.status})`);
    const empty = await settle(server, tokA, { transfers: [{ from_handle: 'a', to_handle: 'b', amount: 1 }] }, '');
    assert(empty.status === 400 && empty.json.error.code === 'missing_idempotency_key', `criterion 15: empty key -> 400 (got ${empty.status})`);
    const tooLong = await settle(server, tokA, { transfers: [{ from_handle: 'a', to_handle: 'b', amount: 1 }] }, 'k'.repeat(256));
    assert(tooLong.status === 422 && tooLong.json.error.code === 'validation_failed', `criterion 15: 256-char key -> 422 (got ${tooLong.status})`);
    const k = key('c15');
    const orig = await settle(server, tokA, { transfers: [{ from_handle: 'a', to_handle: 'b', amount: 1 }] }, k);
    assert(orig.status === 201, `criterion 15 setup: first use -> 201 (got ${orig.status})`);
    const clash = await settle(server, tokA, { transfers: [{ from_handle: 'a', to_handle: 'b', amount: 2 }] }, k);
    assert(clash.status === 409 && clash.json.error.code === 'idempotency_key_reuse', `criterion 15: same key, different body -> 409 (got ${clash.status} ${clash.json && clash.json.error && clash.json.error.code})`);
  }

  // ---- criterion 16 (D15): a non-operator with NO key gets 403, not 400 ----
  {
    await reset(server, { users: users([['a', 1000], ['b', 0]]), settlement_operator_ids: [] });
    const tokA = await login(server, 'a@example.com');
    const r = await req(server, 'POST', '/settlements', { transfers: [{ from_handle: 'a', to_handle: 'b', amount: 1 }] }, auth(tokA));
    assert(r.status === 403 && r.json.error.code === 'forbidden', `criterion 16 (D15): non-operator, no key -> 403 forbidden, not 400 (got ${r.status} ${r.json && r.json.error && r.json.error.code})`);
  }

  // ---- criterion 17: note/visibility per entry, ordinary defaults ----
  {
    await reset(server, { users: users([['a', 1000], ['b', 0]]), settlement_operator_ids: ['u_a'] });
    const tokA = await login(server, 'a@example.com');
    const r = await settle(server, tokA, { transfers: [{ from_handle: 'a', to_handle: 'b', amount: 1, note: 'hi', visibility: 'private' }] }, key('c17a'));
    assert(r.status === 201 && r.json.payments[0].note === 'hi' && r.json.payments[0].visibility === 'private', `criterion 17: note and visibility honoured (got ${JSON.stringify(r.json.payments[0])})`);
    const r2 = await settle(server, tokA, { transfers: [{ from_handle: 'a', to_handle: 'b', amount: 1 }] }, key('c17b'));
    assert(r2.status === 201 && r2.json.payments[0].note === '' && r2.json.payments[0].visibility === 'public', `criterion 17: omitted note/visibility default to ""/public (got ${JSON.stringify(r2.json.payments[0])})`);
    const badVis = await settle(server, tokA, { transfers: [{ from_handle: 'a', to_handle: 'b', amount: 1, visibility: 'weird' }] }, key('c17c'));
    assert(badVis.status === 422 && badVis.json.error.code === 'validation_failed', `criterion 17: an invalid visibility -> 422 (got ${badVis.status})`);
  }

  // ---- criterion 18 (D30/C8): settlements as the fifth mapped collection ----
  {
    await reset(server, { users: users([['a', 1000], ['b', 0]]), settlement_operator_ids: ['u_a'] });
    const tokA = await login(server, 'a@example.com');
    await settleOk(server, tokA, { transfers: [{ from_handle: 'a', to_handle: 'b', amount: 5 }] });

    const topLevel = checkExportCoverage(emptyState, serializeState);
    assert(topLevel.ok, `criterion 18 (D30): top-level guard passes with settlements populated (missing: ${JSON.stringify(topLevel.missing)})`);

    const fieldLevel = checkRecordFieldCoverage(server.store.state, serializeState);
    assert(fieldLevel.ok, `criterion 18 (C8): field-level guard passes with a live settlement record (missing: ${JSON.stringify(fieldLevel.missing)})`);

    function droppingSerializeState(s) {
      const out = serializeState(s);
      out.settlements = out.settlements.map((st) => { const { payment_ids, ...rest } = st; return rest; });
      return out;
    }
    const dropped = checkRecordFieldCoverage(server.store.state, droppingSerializeState);
    assert(!dropped.ok && dropped.missing.includes('settlements.paymentIds'), `criterion 18 (C8): fires on a settlements mapper with a field genuinely removed (got ok=${dropped.ok}, missing=${JSON.stringify(dropped.missing)})`);
  }

  server.close();
  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
}

main().catch((e) => { console.error(e); process.exit(1); });
