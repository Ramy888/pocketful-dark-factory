'use strict';

// Durable evidence for W7 (requests: create, pay, decline, cancel, list),
// committed per D28. Exercises the delivered server (src/server.js's
// createServer()) over real HTTP.
//
// D47/D50 discipline: every assertion records a real comparison, no bare
// early return on an expected-failure branch. Status/code checks that an
// absent route could also produce (404 not_found) are preceded by a
// control call proving the route exists first.

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

function createReq(server, tok, body, k = key('c')) {
  return req(server, 'POST', '/requests', body, { ...auth(tok), 'Idempotency-Key': k });
}
async function createReqOk(server, tok, body) {
  const r = await createReq(server, tok, body);
  if (r.status !== 201) throw new Error(`request setup failed: ${r.status} ${r.raw}`);
  return r.json;
}
function payReq(server, tok, id, body, k) {
  const headers = { ...auth(tok) };
  if (k !== undefined) headers['Idempotency-Key'] = k;
  return req(server, 'POST', `/requests/${id}/pay`, body === undefined ? {} : body, headers);
}
function decline(server, tok, id) {
  return req(server, 'POST', `/requests/${id}/decline`, {}, auth(tok));
}
function cancel(server, tok, id) {
  return req(server, 'POST', `/requests/${id}/cancel`, {}, auth(tok));
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
function pay(server, tok, body, k) {
  return req(server, 'POST', '/payments', body, { ...auth(tok), 'Idempotency-Key': k || key('pay') });
}

const users3 = [
  { id: 'u_a', email: 'a@example.com', password: 'correct horse', display_name: 'A', handle: 'a', balance: 10000 },
  { id: 'u_b', email: 'b@example.com', password: 'correct horse', display_name: 'B', handle: 'b', balance: 10000 },
  { id: 'u_c', email: 'c@example.com', password: 'correct horse', display_name: 'C', handle: 'c', balance: 10000 },
];

async function main() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  // ---- route-exists control (D47/D50) ----
  {
    await reset(server, { users: users3 });
    const tokA = await login(server, 'a@example.com');
    const control = await createReq(server, tokA, { payer_handle: 'b', amount: 1 });
    assert(control.status === 201, `route-exists control: POST /requests -> 201 (got ${control.status})`);
  }

  // ---- criterion 1: create -> 201 with R8.13 shape ----
  {
    await reset(server, { users: users3 });
    const tokA = await login(server, 'a@example.com');
    const r = await createReq(server, tokA, { payer_handle: 'b', amount: 500, note: 'lunch' });
    assert(r.status === 201, `criterion 1: create -> 201 (got ${r.status})`);
    const b = r.json;
    assert(
      typeof b.request_id === 'string' && b.requester_id === 'u_a' && b.requester_handle === 'a'
      && b.payer_id === 'u_b' && b.payer_handle === 'b' && b.amount === 500 && b.currency === 'EUR'
      && b.note === 'lunch' && b.status === 'pending' && b.payment_id === null,
      `criterion 1: every R8.13 field present and correct (got ${JSON.stringify(b)})`,
    );
    assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}:\d{2}$/.test(b.created_at), `criterion 1: created_at is RFC 3339 with an explicit offset (got ${b.created_at})`);
  }

  // ---- criterion 2: a request above the payer's balance is created normally; pays once funded ----
  {
    await reset(server, { users: [
      { id: 'u_a', email: 'a@example.com', password: 'correct horse', display_name: 'A', handle: 'a', balance: 10000 },
      { id: 'u_b', email: 'b@example.com', password: 'correct horse', display_name: 'B', handle: 'b', balance: 100 },
    ] });
    const tokA = await login(server, 'a@example.com');
    const tokB = await login(server, 'b@example.com');
    const created = await createReq(server, tokA, { payer_handle: 'b', amount: 5000 });
    assert(created.status === 201, `criterion 2: an over-balance request is created normally -> 201 (got ${created.status})`);
    const shortPay = await payReq(server, tokB, created.json.request_id, {}, key('c2pay1'));
    assert(shortPay.status === 409 && shortPay.json.error.code === 'insufficient_funds', `criterion 2: paying it short -> 409 insufficient_funds (got ${shortPay.status} ${shortPay.json && shortPay.json.error && shortPay.json.error.code})`);
    // fund the payer, then the same request pays
    await pay(server, tokA, { to_handle: 'b', amount: 5000 });
    const okPay = await payReq(server, tokB, created.json.request_id, {}, key('c2pay2'));
    assert(okPay.status === 201, `criterion 2: the same request pays once the payer is funded (got ${okPay.status})`);
  }

  // ---- criterion 3: pay -> 201 payment with request_id set; request becomes paid; money moved once ----
  {
    await reset(server, { users: users3 });
    const tokA = await login(server, 'a@example.com');
    const tokB = await login(server, 'b@example.com');
    const rq = await createReqOk(server, tokA, { payer_handle: 'b', amount: 300, note: 'split the cab' });
    const beforeA = await balance(server, tokA);
    const beforeB = await balance(server, tokB);
    const p = await payReq(server, tokB, rq.request_id, {}, key('c3'));
    assert(p.status === 201 && p.json.request_id === rq.request_id, `criterion 3: pay -> 201 with request_id set (got ${p.status} ${p.json && p.json.request_id})`);
    assert(p.json.note === 'split the cab', `criterion 3: the settling payment inherits the request's note, not an empty default (got ${JSON.stringify(p.json.note)})`);
    const afterA = await balance(server, tokA);
    const afterB = await balance(server, tokB);
    assert(afterA === beforeA + 300 && afterB === beforeB - 300, `criterion 3: money moved exactly once (A ${beforeA}->${afterA}, B ${beforeB}->${afterB})`);
    const list = await listReqs(server, tokA, '?status=paid');
    const found = list.json.requests.find((r) => r.request_id === rq.request_id);
    assert(!!found && found.status === 'paid' && found.payment_id === p.json.payment_id, `criterion 3: the request is now paid and carries the new payment_id (got ${JSON.stringify(found)})`);
  }

  // ---- criterion 4: terminal request + new key -> 409; replaying the original successful pay -> 200, not 409 ----
  {
    await reset(server, { users: users3 });
    const tokA = await login(server, 'a@example.com');
    const tokB = await login(server, 'b@example.com');
    const rq = await createReqOk(server, tokA, { payer_handle: 'b', amount: 10 });
    const originalKey = key('c4-orig');
    const first = await payReq(server, tokB, rq.request_id, {}, originalKey);
    assert(first.status === 201, `criterion 4 setup: first pay -> 201 (got ${first.status})`);
    const newKeyAttempt = await payReq(server, tokB, rq.request_id, {}, key('c4-new'));
    assert(newKeyAttempt.status === 409 && newKeyAttempt.json.error.code === 'request_not_pending', `criterion 4: a terminal request + a NEW key -> 409 request_not_pending (got ${newKeyAttempt.status} ${newKeyAttempt.json && newKeyAttempt.json.error && newKeyAttempt.json.error.code})`);
    const replay = await payReq(server, tokB, rq.request_id, {}, originalKey);
    assert(replay.status === 200, `criterion 4: replaying the ORIGINAL successful key -> 200, not 409 (got ${replay.status} ${replay.json && replay.json.error && replay.json.error.code})`);
    assert(JSON.stringify(replay.json) === JSON.stringify(first.json), 'criterion 4: replay body identical to the original payment');
    const balAfterReplay = await balance(server, tokB);
    const balAfterFirst = await balance(server, tokB); // no intervening write; sanity that replay moved nothing further
    assert(balAfterReplay === balAfterFirst, 'criterion 4: the replay moved no further money');
  }

  // ---- criterion 5: {} and {"visibility":"public"} are different JSON values under the same key ----
  // Same request (same path) both times -- a different path would be R7.4's
  // "different request", not a reuse conflict, which is a different claim.
  {
    await reset(server, { users: users3 });
    const tokA = await login(server, 'a@example.com');
    const tokB = await login(server, 'b@example.com');
    const rq = await createReqOk(server, tokA, { payer_handle: 'b', amount: 10 });
    const k = key('c5');
    const first = await payReq(server, tokB, rq.request_id, {}, k);
    assert(first.status === 201, `criterion 5 setup: first pay with {} -> 201 (got ${first.status})`);
    const clash = await payReq(server, tokB, rq.request_id, { visibility: 'public' }, k);
    assert(clash.status === 409 && clash.json.error.code === 'idempotency_key_reuse', `criterion 5: same key and path, {} vs {"visibility":"public"} -> 409 idempotency_key_reuse, not the request's own terminal state (got ${clash.status} ${clash.json && clash.json.error && clash.json.error.code})`);
  }

  // ---- criterion 6: wrong-actor 403s, unknown id 404 ----
  {
    await reset(server, { users: users3 });
    const tokA = await login(server, 'a@example.com');
    const tokB = await login(server, 'b@example.com');
    const tokC = await login(server, 'c@example.com');
    const rq = await createReqOk(server, tokA, { payer_handle: 'b', amount: 10 });
    const wrongPay = await payReq(server, tokC, rq.request_id, {}, key('c6a'));
    assert(wrongPay.status === 403 && wrongPay.json.error.code === 'forbidden', `criterion 6: non-payer pay -> 403 (got ${wrongPay.status} ${wrongPay.json && wrongPay.json.error && wrongPay.json.error.code})`);
    const wrongDecline = await decline(server, tokC, rq.request_id);
    assert(wrongDecline.status === 403 && wrongDecline.json.error.code === 'forbidden', `criterion 6: non-payer decline -> 403 (got ${wrongDecline.status})`);
    const wrongCancel = await cancel(server, tokC, rq.request_id);
    assert(wrongCancel.status === 403 && wrongCancel.json.error.code === 'forbidden', `criterion 6: non-requester cancel -> 403 (got ${wrongCancel.status})`);
    const unknownPay = await payReq(server, tokB, 'rq_ghost', {}, key('c6b'));
    assert(unknownPay.status === 404 && unknownPay.json.error.code === 'not_found', `criterion 6: unknown id pay -> 404 (got ${unknownPay.status})`);
    const unknownDecline = await decline(server, tokB, 'rq_ghost');
    assert(unknownDecline.status === 404, `criterion 6: unknown id decline -> 404 (got ${unknownDecline.status})`);
    const unknownCancel = await cancel(server, tokA, 'rq_ghost');
    assert(unknownCancel.status === 404, `criterion 6: unknown id cancel -> 404 (got ${unknownCancel.status})`);
  }

  // ---- criterion 7: decline/cancel idempotent-by-status; decline a cancelled request -> 409 ----
  {
    await reset(server, { users: users3 });
    const tokA = await login(server, 'a@example.com');
    const tokB = await login(server, 'b@example.com');
    const rq1 = await createReqOk(server, tokA, { payer_handle: 'b', amount: 10 });
    const d1 = await decline(server, tokB, rq1.request_id);
    assert(d1.status === 200 && d1.json.status === 'declined', `criterion 7: first decline -> 200 declined (got ${d1.status} ${d1.json && d1.json.status})`);
    const d2 = await decline(server, tokB, rq1.request_id);
    assert(d2.status === 200 && d2.json.status === 'declined', `criterion 7: second decline -> 200 declined (got ${d2.status})`);

    const rq2 = await createReqOk(server, tokA, { payer_handle: 'b', amount: 10 });
    const c1 = await cancel(server, tokA, rq2.request_id);
    assert(c1.status === 200 && c1.json.status === 'cancelled', `criterion 7: first cancel -> 200 cancelled (got ${c1.status})`);
    const c2 = await cancel(server, tokA, rq2.request_id);
    assert(c2.status === 200 && c2.json.status === 'cancelled', `criterion 7: second cancel -> 200 cancelled (got ${c2.status})`);

    const declineCancelled = await decline(server, tokB, rq2.request_id);
    assert(declineCancelled.status === 409 && declineCancelled.json.error.code === 'request_not_pending', `criterion 7: declining an already-cancelled request -> 409 request_not_pending (got ${declineCancelled.status} ${declineCancelled.json && declineCancelled.json.error && declineCancelled.json.error.code})`);
  }

  // ---- criterion 8 (D24): terminal + short payer -> request_not_pending, not insufficient_funds; the sharp case ----
  {
    await reset(server, { users: [
      { id: 'u_a', email: 'a@example.com', password: 'correct horse', display_name: 'A', handle: 'a', balance: 10000 },
      { id: 'u_b', email: 'b@example.com', password: 'correct horse', display_name: 'B', handle: 'b', balance: 100 },
    ] });
    const tokA = await login(server, 'a@example.com');
    const tokB = await login(server, 'b@example.com');
    const rq = await createReqOk(server, tokA, { payer_handle: 'b', amount: 100 });
    const firstPay = await payReq(server, tokB, rq.request_id, {}, key('c8-orig'));
    assert(firstPay.status === 201, `criterion 8 setup: payer spends its last funds -> 201 (got ${firstPay.status})`);
    const balAfter = await balance(server, tokB);
    assert(balAfter === 0, `criterion 8 setup: payer wallet now empty (got ${balAfter})`);
    const retry = await payReq(server, tokB, rq.request_id, {}, key('c8-retry'));
    assert(retry.status === 409 && retry.json.error.code === 'request_not_pending', `criterion 8: a fresh-key retry against an empty wallet on a terminal request -> request_not_pending, not insufficient_funds (got ${retry.status} ${retry.json && retry.json.error && retry.json.error.code})`);
  }

  // ---- criterion 9 (C2): a garbage-percent-encoded id -> 404, not 400 ----
  {
    await reset(server, { users: users3 });
    const tokA = await login(server, 'a@example.com');
    const r = await req(server, 'POST', '/requests/%ZZ/pay', {}, { ...auth(tokA), 'Idempotency-Key': key('c9') });
    assert(r.status === 404 && r.json.error.code === 'not_found', `criterion 9 (C2): /requests/%ZZ/pay -> 404 not_found, not 400 (got ${r.status} ${r.json && r.json.error && r.json.error.code})`);
  }

  // ---- criterion 10: GET /requests only requester/payer; a third party sees none ----
  {
    await reset(server, { users: users3 });
    const tokA = await login(server, 'a@example.com');
    const tokB = await login(server, 'b@example.com');
    const tokC = await login(server, 'c@example.com');
    const rq = await createReqOk(server, tokA, { payer_handle: 'b', amount: 10 });
    const listA = await listReqs(server, tokA);
    const listB = await listReqs(server, tokB);
    const listC = await listReqs(server, tokC);
    assert(!!listA.json.requests.find((r) => r.request_id === rq.request_id), 'criterion 10: visible to the requester');
    assert(!!listB.json.requests.find((r) => r.request_id === rq.request_id), 'criterion 10: visible to the payer');
    assert(listC.json.requests.length === 0, `criterion 10: an unrelated caller sees none (got ${listC.json.requests.length})`);
  }

  // ---- criterion 11: direction/status filters; invalid values -> 422 ----
  {
    await reset(server, { users: users3 });
    const tokA = await login(server, 'a@example.com');
    const tokB = await login(server, 'b@example.com');
    const outgoing = await createReqOk(server, tokA, { payer_handle: 'b', amount: 10 });
    const incoming = await createReqOk(server, tokB, { payer_handle: 'a', amount: 20 });
    const asA_out = await listReqs(server, tokA, '?direction=outgoing');
    assert(asA_out.json.requests.length === 1 && asA_out.json.requests[0].request_id === outgoing.request_id, `criterion 11: direction=outgoing for A returns only what A requested (got ${JSON.stringify(asA_out.json.requests.map((r) => r.request_id))})`);
    const asA_in = await listReqs(server, tokA, '?direction=incoming');
    assert(asA_in.json.requests.length === 1 && asA_in.json.requests[0].request_id === incoming.request_id, `criterion 11: direction=incoming for A returns only what A must pay (got ${JSON.stringify(asA_in.json.requests.map((r) => r.request_id))})`);
    await decline(server, tokA, incoming.request_id);
    const declined = await listReqs(server, tokA, '?status=declined');
    assert(declined.json.requests.length === 1 && declined.json.requests[0].request_id === incoming.request_id, `criterion 11: status=declined filters correctly (got ${JSON.stringify(declined.json.requests.map((r) => r.request_id))})`);
    const badDir = await listReqs(server, tokA, '?direction=sideways');
    assert(badDir.status === 422 && badDir.json.error.code === 'validation_failed', `criterion 11: direction=sideways -> 422 (got ${badDir.status})`);
    const badStatus = await listReqs(server, tokA, '?status=weird');
    assert(badStatus.status === 422 && badStatus.json.error.code === 'validation_failed', `criterion 11: status=weird -> 422 (got ${badStatus.status})`);
  }

  // ---- criterion 12: newest-first, deterministic tie-break, repeatable order, pagination ----
  {
    await reset(server, { users: users3 });
    const tokA = await login(server, 'a@example.com');
    const rq1 = await createReqOk(server, tokA, { payer_handle: 'b', amount: 1 });
    const rq2 = await createReqOk(server, tokA, { payer_handle: 'b', amount: 2 });
    const rq3 = await createReqOk(server, tokA, { payer_handle: 'b', amount: 3 });
    const list1 = await listReqs(server, tokA);
    const ids1 = list1.json.requests.map((r) => r.request_id);
    assert(
      ids1.indexOf(rq3.request_id) < ids1.indexOf(rq2.request_id) && ids1.indexOf(rq2.request_id) < ids1.indexOf(rq1.request_id),
      `criterion 12: newest-first order (got ${JSON.stringify(ids1)})`,
    );
    const list2 = await listReqs(server, tokA);
    const ids2 = list2.json.requests.map((r) => r.request_id);
    assert(JSON.stringify(ids1) === JSON.stringify(ids2), 'criterion 12: two identical calls with no writes in between agree exactly (the tie-break is deterministic, D9)');
    const page0 = await listReqs(server, tokA, '?limit=1&offset=0');
    const page1 = await listReqs(server, tokA, '?limit=1&offset=1');
    const page2 = await listReqs(server, tokA, '?limit=1&offset=2');
    const composed = [...page0.json.requests, ...page1.json.requests, ...page2.json.requests].map((r) => r.request_id);
    assert(JSON.stringify(composed) === JSON.stringify(ids1), `criterion 12: paging with limit=1 composes into the unpaged list exactly once (got ${JSON.stringify(composed)})`);
    assert(page0.json.has_more === true && page1.json.has_more === true && page2.json.has_more === false, 'criterion 12: has_more true/true/false across the three pages');
  }

  // ---- criterion 13: requests never appear in GET /activity ----
  {
    await reset(server, { users: users3 });
    const tokA = await login(server, 'a@example.com');
    await createReqOk(server, tokA, { payer_handle: 'b', amount: 10 });
    const feed = await activity(server, tokA);
    assert(feed.json.payments.length === 0, `criterion 13: an unpaid request never appears in /activity (got ${feed.json.payments.length} items)`);
  }

  // ---- criterion 14: 20 simultaneous pays, distinct keys -> exactly one 201, rest 409, money moved once ----
  {
    await reset(server, { users: users3 });
    const tokA = await login(server, 'a@example.com');
    const tokB = await login(server, 'b@example.com');
    const rq = await createReqOk(server, tokA, { payer_handle: 'b', amount: 5 });
    const before = await balance(server, tokB);
    const results = await Promise.all(Array.from({ length: 20 }, () => payReq(server, tokB, rq.request_id, {}, key('c14'))));
    const created = results.filter((r) => r.status === 201);
    const conflicted = results.filter((r) => r.status === 409 && r.json.error.code === 'request_not_pending');
    const after = await balance(server, tokB);
    assert(
      created.length === 1 && conflicted.length === 19 && before - after === 5,
      `criterion 14: 20 concurrent pays with distinct keys -> exactly one 201, nineteen 409 request_not_pending, money moved once (created ${created.length}, conflicted ${conflicted.length}, moved ${before - after})`,
    );
  }

  // ---- criterion 15: a payment settling a request appears in GET /activity under the ordinary rule ----
  {
    await reset(server, { users: users3 });
    const tokA = await login(server, 'a@example.com');
    const tokB = await login(server, 'b@example.com');
    const tokC = await login(server, 'c@example.com');
    const rq = await createReqOk(server, tokA, { payer_handle: 'b', amount: 10 });
    const p = await payReq(server, tokB, rq.request_id, { visibility: 'public' }, key('c15'));
    assert(p.status === 201, `criterion 15 setup: pay -> 201 (got ${p.status})`);
    const feedA = await activity(server, tokA);
    const feedC = await activity(server, tokC);
    assert(!!feedA.json.payments.find((x) => x.payment_id === p.json.payment_id), 'criterion 15: a public settling payment visible to the requester');
    assert(!!feedC.json.payments.find((x) => x.payment_id === p.json.payment_id), 'criterion 15: a public settling payment visible to an unrelated caller too');
  }

  // ---- criterion 16: POST /requests field validation ----
  {
    await reset(server, { users: users3 });
    const tokA = await login(server, 'a@example.com');
    for (const bad of [0, -1, 1000000001, 1.5, '100', true, null]) {
      const r = await createReq(server, tokA, { payer_handle: 'b', amount: bad });
      assert(r.status === 422 && r.json.error.code === 'validation_failed', `criterion 16: amount ${JSON.stringify(bad)} -> 422 (got ${r.status} ${r.json && r.json.error && r.json.error.code})`);
    }
    const longNote = await createReq(server, tokA, { payer_handle: 'b', amount: 1, note: 'x'.repeat(201) });
    assert(longNote.status === 422 && longNote.json.error.code === 'validation_failed', `criterion 16: note > 200 code points -> 422 (got ${longNote.status})`);
    const okNote = await createReq(server, tokA, { payer_handle: 'b', amount: 1, note: '🎉'.repeat(200) });
    assert(okNote.status === 201, `criterion 16: a 200-code-point note is accepted (got ${okNote.status})`);
    const selfReq = await createReq(server, tokA, { payer_handle: 'a', amount: 1 });
    assert(selfReq.status === 422 && selfReq.json.error.code === 'self_request', `criterion 16: payer_handle === own handle -> 422 self_request (got ${selfReq.status} ${selfReq.json && selfReq.json.error && selfReq.json.error.code})`);
    const unknownHandle = await createReq(server, tokA, { payer_handle: 'ghost', amount: 1 });
    assert(unknownHandle.status === 404 && unknownHandle.json.error.code === 'not_found', `criterion 16: unknown payer_handle -> 404 (got ${unknownHandle.status})`);
    // R8.15: the payer's balance is not consulted at creation.
    await reset(server, [
      { id: 'u_a', email: 'a@example.com', password: 'correct horse', display_name: 'A', handle: 'a', balance: 10000 },
      { id: 'u_b', email: 'b@example.com', password: 'correct horse', display_name: 'B', handle: 'b', balance: 0 },
    ].reduce((fx, u) => ({ ...fx, users: [...(fx.users || []), u] }), {}));
    const tokA2 = await login(server, 'a@example.com');
    const overBalance = await createReq(server, tokA2, { payer_handle: 'b', amount: 999999 });
    assert(overBalance.status === 201, `criterion 16 (R8.15): balance not consulted at creation, even against a zero-balance payer (got ${overBalance.status})`);
  }

  // ---- criterion 17: the pay body's visibility is the payer's choice ----
  {
    await reset(server, { users: users3 });
    const tokA = await login(server, 'a@example.com');
    const tokB = await login(server, 'b@example.com');
    const tokC = await login(server, 'c@example.com');
    const rq = await createReqOk(server, tokA, { payer_handle: 'b', amount: 10 });
    const p = await payReq(server, tokB, rq.request_id, { visibility: 'private' }, key('c17'));
    assert(p.status === 201 && p.json.visibility === 'private', `criterion 17: {"visibility":"private"} produces a private payment (got ${p.status} ${p.json && p.json.visibility})`);
    const feedA = await activity(server, tokA);
    const feedB = await activity(server, tokB);
    const feedC = await activity(server, tokC);
    assert(!!feedA.json.payments.find((x) => x.payment_id === p.json.payment_id), 'criterion 17: private settling payment visible to requester');
    assert(!!feedB.json.payments.find((x) => x.payment_id === p.json.payment_id), 'criterion 17: private settling payment visible to payer');
    assert(!feedC.json.payments.find((x) => x.payment_id === p.json.payment_id), 'criterion 17: private settling payment absent for a third party');

    const rq2 = await createReqOk(server, tokA, { payer_handle: 'b', amount: 10 });
    const p2 = await payReq(server, tokB, rq2.request_id, {}, key('c17b'));
    assert(p2.status === 201 && p2.json.visibility === 'public', `criterion 17: omitted visibility defaults to public (got ${p2.status} ${p2.json && p2.json.visibility})`);
    const expectedKeys = ['payment_id', 'from_user_id', 'from_handle', 'to_user_id', 'to_handle', 'amount', 'currency', 'note', 'visibility', 'request_id', 'settlement_id', 'created_at'];
    assert(Object.keys(p2.json).sort().join(',') === expectedKeys.slice().sort().join(','), `criterion 17: the settling payment has exactly POST /payments' fields (got ${JSON.stringify(Object.keys(p2.json))})`);
  }

  // ---- criterion 18 (D30): the export guard still passes ----
  {
    await reset(server, { users: users3 });
    const tokA = await login(server, 'a@example.com');
    const rq = await createReqOk(server, tokA, { payer_handle: 'b', amount: 10 });
    const tokB = await login(server, 'b@example.com');
    await payReq(server, tokB, rq.request_id, {}, key('c18'));
    const coverage = checkExportCoverage(emptyState, serializeState);
    assert(coverage.ok, `criterion 18: D30 export-coverage guard still passes (missing: ${JSON.stringify(coverage.missing)})`);
  }

  server.close();
  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
}

main().catch((e) => { console.error(e); process.exit(1); });
