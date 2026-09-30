'use strict';

// Durable evidence for W9 (export/import), committed per D28. Uses two
// independent createServer() instances (A and B) with their own in-process
// HTTP listeners and their own Store -- genuinely separate processes would
// prove nothing this doesn't, since R10.6 requires no dependency on the
// source process, files, or address, and going over real HTTP with real
// JSON serialization on both sides already rules out any shared-reference
// shortcut between the two. The actual two-container Docker run (via
// ALT_BASE_URL) is exercised separately for the handoff.
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
    currency: 'EUR', minor_units: 2, payments: [], requests: [], ...fixture,
  });
  if (r.status !== 204) throw new Error(`reset failed: ${r.status} ${r.raw}`);
}
async function login(server, email) {
  const r = await req(server, 'POST', '/auth/login', { email, password: 'correct horse' });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${r.raw}`);
  return r.json.token;
}
function auth(tok) { return { Authorization: `Bearer ${tok}` }; }
async function exportState(server) {
  const r = await req(server, 'GET', '/_test/export');
  if (r.status !== 200) throw new Error(`export failed: ${r.status} ${r.raw}`);
  return r.json;
}
async function importState(server, exported) {
  return req(server, 'POST', '/_test/import', exported);
}
async function balance(server, tok) {
  const r = await req(server, 'GET', '/me', undefined, auth(tok));
  return r.json.balance;
}

let seq = 0;
function key(prefix = 'k') { seq += 1; return `${prefix}-${process.pid}-${Date.now().toString(36)}-${seq}`; }

const baseUsers = [
  { id: 'u_a', email: 'a@example.com', password: 'correct horse', display_name: 'A', handle: 'a', balance: 10000 },
  { id: 'u_b', email: 'b@example.com', password: 'correct horse', display_name: 'B', handle: 'b', balance: 5000 },
];

async function main() {
  const serverA = createServer();
  const serverB = createServer();
  await Promise.all([
    new Promise((resolve) => serverA.listen(0, '127.0.0.1', resolve)),
    new Promise((resolve) => serverB.listen(0, '127.0.0.1', resolve)),
  ]);

  // ---- criterion 12 control: neither endpoint requires a token ----
  {
    await reset(serverA, { users: baseUsers });
    const exp = await req(serverA, 'GET', '/_test/export');
    assert(exp.status === 200, `criterion 12 control: GET /_test/export needs no token -> 200 (got ${exp.status})`);
  }

  // ---- criterion 1: export shape ----
  {
    const exp = await exportState(serverA);
    assert(exp.track === 'pocketful' && exp.format_version === 1 && typeof exp.state === 'object' && exp.state !== null, `criterion 1: export -> track/format_version/state (got ${JSON.stringify({ track: exp.track, format_version: exp.format_version, stateType: typeof exp.state })})`);
  }

  // ---- criterion 9: unparseable body -> 400 ----
  {
    const r = await req(serverB, 'POST', '/_test/import', '{not json', { 'Content-Type': 'application/json' });
    assert(r.status === 400 && r.json.error.code === 'malformed_request', `criterion 9: unparseable import body -> 400 (got ${r.status})`);
  }

  // ---- criterion 8: envelope validation, B unchanged ----
  {
    await reset(serverB, { users: baseUsers });
    const before = await exportState(serverB);
    const cases = [
      { format_version: 1, state: {} }, // missing track
      { track: 'other', format_version: 1, state: {} },
      { track: 'pocketful', format_version: 2, state: {} },
      { track: 'pocketful', format_version: 1, state: 'not an object' },
      { track: 'pocketful', format_version: 1, state: ['also', 'not'] },
    ];
    for (const c of cases) {
      const r = await importState(serverB, c);
      assert(r.status === 422 && r.json.error.code === 'validation_failed', `criterion 8: ${JSON.stringify(c).slice(0, 60)} -> 422 (got ${r.status} ${r.json && r.json.error && r.json.error.code})`);
    }
    const after = await exportState(serverB);
    assert(JSON.stringify(before) === JSON.stringify(after), 'criterion 8: none of the rejected imports changed B\'s state');
  }

  // ---- criteria 2, 15: the full two-container round trip ----
  let exportedFromA;
  let tokA;
  {
    await reset(serverA, { users: baseUsers, settlement_operator_ids: ['u_a'] });
    tokA = await login(serverA, 'a@example.com');
    const pay = await req(serverA, 'POST', '/payments', { to_handle: 'b', amount: 250, note: 'w9' }, { ...auth(tokA), 'Idempotency-Key': key('pay') });
    assert(pay.status === 201, `criteria 2/15 setup: a payment on A -> 201 (got ${pay.status})`);
    const rq = await req(serverA, 'POST', '/requests', { payer_handle: 'b', amount: 40 }, { ...auth(tokA), 'Idempotency-Key': key('rq') });
    assert(rq.status === 201, `criteria 2/15 setup: a request on A -> 201 (got ${rq.status})`);

    exportedFromA = await exportState(serverA);
    const imp = await importState(serverB, exportedFromA);
    assert(imp.status === 204, `criterion 2: import into B -> 204 (got ${imp.status})`);

    const tokBFresh = await login(serverB, 'a@example.com');
    assert(!!tokBFresh, 'criterion 2: a seeded password logs in on B after import');

    const meOnB = await req(serverB, 'GET', '/me', undefined, auth(tokA));
    assert(meOnB.status === 200, `criterion 2: A's original token authenticates against B (got ${meOnB.status})`);
    assert(meOnB.json.balance === 10000 - 250, `criterion 15: A's balance carries over exactly (got ${meOnB.json.balance})`);

    const bOnA = await login(serverA, 'b@example.com');
    const bBalanceA = await balance(serverA, bOnA);
    const bOnB = await login(serverB, 'b@example.com');
    const bBalanceB = await balance(serverB, bOnB);
    assert(bBalanceA === bBalanceB, `criterion 2: B's own balance matches between A and B (A ${bBalanceA}, B ${bBalanceB})`);

    const expB = await exportState(serverB);
    assert(
      JSON.stringify(expB.state.payments) === JSON.stringify(exportedFromA.state.payments)
      && JSON.stringify(expB.state.requests) === JSON.stringify(exportedFromA.state.requests),
      'criterion 2: payments and requests match between A\'s export and B\'s post-import export',
    );
    assert(
      expB.state.payments[0].id === exportedFromA.state.payments[0].id
      && expB.state.payments[0].created_at === exportedFromA.state.payments[0].created_at,
      `criterion 15: payment id and created_at are identical, not regenerated (A ${JSON.stringify(exportedFromA.state.payments[0])}, B ${JSON.stringify(expB.state.payments[0])})`,
    );
  }

  // ---- criterion 3: an idempotent request replayed against B ----
  {
    await reset(serverA, { users: baseUsers });
    const tokA2 = await login(serverA, 'a@example.com');
    const k = key('c3replay');
    const original = await req(serverA, 'POST', '/payments', { to_handle: 'b', amount: 77 }, { ...auth(tokA2), 'Idempotency-Key': k });
    assert(original.status === 201, `criterion 3 setup: original payment on A -> 201 (got ${original.status})`);
    const bBalanceBefore = await balance(serverA, await login(serverA, 'b@example.com'));

    const exp = await exportState(serverA);
    await importState(serverB, exp);
    const replay = await req(serverB, 'POST', '/payments', { to_handle: 'b', amount: 77 }, { ...auth(tokA2), 'Idempotency-Key': k });
    assert(replay.status === 200, `criterion 3: replay against B -> 200 (got ${replay.status})`);
    assert(JSON.stringify(replay.json) === JSON.stringify(original.json), 'criterion 3: replay body identical to the original response (R10.11)');
    const bBalanceAfter = await balance(serverB, await login(serverB, 'b@example.com'));
    assert(bBalanceAfter === bBalanceBefore, `criterion 3: the replay on B moved no money (before ${bBalanceBefore}, after ${bBalanceAfter})`);
  }

  // ---- criterion 4: a key that failed with 4xx before export is still reusable on B ----
  {
    await reset(serverA, { users: baseUsers });
    const tokA2 = await login(serverA, 'a@example.com');
    const k = key('c4');
    const failed = await req(serverA, 'POST', '/payments', { to_handle: 'ghost', amount: 1 }, { ...auth(tokA2), 'Idempotency-Key': k });
    assert(failed.status === 404, `criterion 4 setup: first use fails 404 on A (got ${failed.status})`);
    const exp = await exportState(serverA);
    await importState(serverB, exp);
    const reused = await req(serverB, 'POST', '/payments', { to_handle: 'b', amount: 1 }, { ...auth(tokA2), 'Idempotency-Key': k });
    assert(reused.status === 201, `criterion 4: the same key, reused on B, is still free -> 201 (got ${reused.status})`);
  }

  // ---- criterion 5: operator permission survives ----
  {
    await reset(serverA, { users: baseUsers, settlement_operator_ids: ['u_a'] });
    const exp = await exportState(serverA);
    assert(exp.state.settlement_operator_ids.includes('u_a'), 'criterion 5 setup: A exports u_a as an operator');
    await importState(serverB, exp);
    const expB = await exportState(serverB);
    assert(expB.state.settlement_operator_ids.includes('u_a'), `criterion 5: the operator id survives the import (got ${JSON.stringify(expB.state.settlement_operator_ids)})`);
    assert(!expB.state.settlement_operator_ids.includes('u_b'), 'criterion 5: a non-operator is still not an operator on B');
  }

  // ---- criterion 6: importing the same export twice leaves identical state ----
  {
    await reset(serverA, { users: baseUsers });
    const tokA2 = await login(serverA, 'a@example.com');
    await req(serverA, 'POST', '/payments', { to_handle: 'b', amount: 5 }, { ...auth(tokA2), 'Idempotency-Key': key('c6') });
    const exp = await exportState(serverA);
    await importState(serverB, exp);
    const firstImportExport = await exportState(serverB);
    await importState(serverB, exp);
    const secondImportExport = await exportState(serverB);
    assert(JSON.stringify(firstImportExport) === JSON.stringify(secondImportExport), 'criterion 6: importing the same export twice leaves byte-identical state, nothing duplicated');
    assert(secondImportExport.state.payments.length === 1, `criterion 6: exactly one payment, not two (got ${secondImportExport.state.payments.length})`);
  }

  // ---- criterion 7 / 16: import wipes the destination ----
  {
    await reset(serverB, { users: baseUsers });
    const signup = await req(serverB, 'POST', '/auth/signup', { email: 'fresh@example.com', password: 'correct horse', display_name: 'Fresh' });
    assert(signup.status === 201, `criteria 7/16 setup: a fresh signup on B -> 201 (got ${signup.status})`);
    const freshTokB = signup.json.token;
    const meBeforeImport = await req(serverB, 'GET', '/me', undefined, auth(freshTokB));
    assert(meBeforeImport.status === 200, 'criteria 7/16 setup: the fresh B token works before import');

    await reset(serverA, { users: baseUsers });
    const exp = await exportState(serverA);
    await importState(serverB, exp);

    const loginAfter = await req(serverB, 'POST', '/auth/login', { email: 'fresh@example.com', password: 'correct horse' });
    assert(loginAfter.status === 401, `criterion 7: a user created on B before the import can no longer log in (got ${loginAfter.status})`);
    const meAfterImport = await req(serverB, 'GET', '/me', undefined, auth(freshTokB));
    assert(meAfterImport.status === 401, `criterion 16: a token issued by B before the import no longer authenticates (got ${meAfterImport.status})`);
  }

  // ---- criterion 10: export is a point-in-time snapshot ----
  {
    await reset(serverA, { users: baseUsers });
    const tokA2 = await login(serverA, 'a@example.com');
    const exp1 = await exportState(serverA);
    const exp1Text = JSON.stringify(exp1);
    await req(serverA, 'POST', '/payments', { to_handle: 'b', amount: 33 }, { ...auth(tokA2), 'Idempotency-Key': key('c10') });
    assert(JSON.stringify(exp1) === exp1Text, 'criterion 10: the already-captured export object does not change when A is written to afterward');
    const exp2 = await exportState(serverA);
    assert(JSON.stringify(exp1) !== JSON.stringify(exp2), 'criterion 10: a fresh export afterward does reflect the new write (proving the first was a real snapshot, not a live reference)');
  }

  // ---- criterion 11: reset after import clears the imported state ----
  {
    await reset(serverA, { users: baseUsers });
    const exp = await exportState(serverA);
    await importState(serverB, exp);
    const beforeReset = await exportState(serverB);
    assert(beforeReset.state.users.length === 2, `criterion 11 setup: B holds the imported users (got ${beforeReset.state.users.length})`);
    await reset(serverB, { users: [baseUsers[0]] });
    const afterReset = await exportState(serverB);
    assert(afterReset.state.users.length === 1, `criterion 11: reset after import clears the imported state (got ${afterReset.state.users.length})`);
  }

  // ---- criterion 13 (C8): the field-level export-coverage guard ----
  {
    await reset(serverA, { users: baseUsers, settlement_operator_ids: ['u_a'] });
    const tokA2 = await login(serverA, 'a@example.com');
    await req(serverA, 'POST', '/payments', { to_handle: 'b', amount: 10 }, { ...auth(tokA2), 'Idempotency-Key': key('c13a') });
    await req(serverA, 'POST', '/requests', { payer_handle: 'b', amount: 5 }, { ...auth(tokA2), 'Idempotency-Key': key('c13b') });
    await req(serverA, 'POST', '/splits', { amount: 6, participant_handles: ['a', 'b'] }, { ...auth(tokA2), 'Idempotency-Key': key('c13c') });

    const real = checkRecordFieldCoverage(serverA.store.state, serializeState);
    assert(real.ok, `criterion 13: the real mappers drop no field of any live record (missing: ${JSON.stringify(real.missing)})`);

    function droppingSerializeState(s) {
      const out = serializeState(s);
      out.payments = out.payments.map((p) => { const { note, ...rest } = p; return rest; });
      return out;
    }
    const dropped = checkRecordFieldCoverage(serverA.store.state, droppingSerializeState);
    assert(!dropped.ok && dropped.missing.includes('payments.note'), `criterion 13: fires on a mapper with a field genuinely removed (got ok=${dropped.ok}, missing=${JSON.stringify(dropped.missing)})`);
    assert(real.missing.every((m) => !m.startsWith('idempotency.')), 'criterion 13: does not fire on the real renames (bodyCanonical->body, responseBody->response)');

    // D30's own top-level guard still holds too (unaffected by C8's addition).
    const topLevel = checkExportCoverage(emptyState, serializeState);
    assert(topLevel.ok, `criterion 15 (D30, top-level): still passes (missing: ${JSON.stringify(topLevel.missing)})`);
  }

  // ---- criterion 14 (D60): split request_ids resolve after import, with live status ----
  {
    await reset(serverA, { users: baseUsers });
    const tokA2 = await login(serverA, 'a@example.com');
    const split = await req(serverA, 'POST', '/splits', { amount: 20, participant_handles: ['a', 'b'] }, { ...auth(tokA2), 'Idempotency-Key': key('c14') });
    assert(split.status === 201, `criterion 14 setup: split on A -> 201 (got ${split.status})`);
    const targetRequestId = split.json.requests[0].request_id;
    const tokB2 = await login(serverA, 'b@example.com');
    const paid = await req(serverA, 'POST', `/requests/${targetRequestId}/pay`, {}, { ...auth(tokB2), 'Idempotency-Key': key('c14pay') });
    assert(paid.status === 201, `criterion 14 setup: paying the split request on A -> 201 (got ${paid.status})`);

    const exp = await exportState(serverA);
    const splitExport = exp.state.splits.find((s) => s.id === split.json.split_id);
    assert(splitExport.request_ids.includes(targetRequestId), 'criterion 14 setup: the export references the request by id');

    await reset(serverB, { users: baseUsers });
    await importState(serverB, exp);
    const listB = await req(serverB, 'GET', '/requests', undefined, auth(await login(serverB, 'a@example.com')));
    const importedRequest = listB.json.requests.find((r) => r.request_id === targetRequestId);
    assert(!!importedRequest, `criterion 14 (D60): the split's referenced request exists on B with the same id (got ${JSON.stringify(listB.json.requests.map((r) => r.request_id))})`);
    assert(importedRequest.status === 'paid', `criterion 14: it carries its live status (paid), not a frozen copy from split-creation time (got ${importedRequest.status})`);
  }

  serverA.close();
  serverB.close();
  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
}

main().catch((e) => { console.error(e); process.exit(1); });
