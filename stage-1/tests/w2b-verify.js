'use strict';

// Durable evidence for board item #13 (W2b), committed per D28 rather than
// left in /tmp. Exercises the built server over real HTTP (never reaches
// into server.store.state except where noted, and each such case says so),
// covering:
//   1. 500 seeded users with 500 DISTINCT passwords reset under 3s -- run
//      this file itself inside `docker run --cpus=2 --memory=2g` for the
//      number that counts; a local run only smoke-tests correctness.
//   2. the stored hash format carries its own scrypt parameters
//   3. minted ids never collide with seeded ids, by construction (D27)
//   4. GET /_test/export shape (§10)
//   5. settlement_operator_ids retained through export, incl. default []
//   6. no plaintext password anywhere in the export
//
// Excluded from the delivered image by .dockerignore, same as acceptance/.

const http = require('http');
const path = require('path');

const { createServer } = require('../src/server');

const FIX_DIR = path.join(__dirname, '..', 'acceptance', 'fixtures');

function req(server, method, reqPath, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    const h = Object.assign({}, headers);
    if (payload !== undefined && h['Content-Type'] === undefined) h['Content-Type'] = 'application/json';
    if (payload !== undefined) h['Content-Length'] = Buffer.byteLength(payload);
    const r = http.request({ host: '127.0.0.1', port: server.address().port, method, path: reqPath, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = raw ? JSON.parse(raw) : undefined; } catch { json = undefined; }
        resolve({ status: res.statusCode, json, raw });
      });
    });
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

async function main() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  // ---- criterion 1: 500 users, 500 DISTINCT passwords ----
  const users500 = Array.from({ length: 500 }, (_, i) => ({
    id: `u_${i}`, email: `u${i}@example.com`, password: `distinct-password-${i}`,
    display_name: `User ${i}`, handle: `u${i}`, balance: 100,
  }));
  const fx500 = { currency: 'EUR', minor_units: 2, users: users500, payments: [], requests: [] };
  const t0 = Date.now();
  let r = await req(server, 'POST', '/_test/reset', fx500);
  const elapsedMs = Date.now() - t0;
  assert(r.status === 204, `criterion 1: 500-distinct-password reset -> 204 (got ${r.status})`);
  console.log(`MEASURED  criterion 1: 500 users / 500 distinct passwords reset in ${elapsedMs}ms (budget: under 3000ms inside --cpus=2 --memory=2g)`);
  assert(elapsedMs < 3000, `criterion 1: under 3000ms (got ${elapsedMs}ms) -- only authoritative when this process itself runs inside --cpus=2 --memory=2g`);

  // ---- criterion 2: hash format carries its own cost parameters ----
  const exp500 = await req(server, 'GET', '/_test/export');
  const hash0 = exp500.json.state.users[0].password_hash;
  const parts = hash0.split(':');
  assert(parts.length === 4 && parts[0] === 'scrypt' && Number.isInteger(Number(parts[1])),
    `criterion 2: stored hash is scrypt:N:salt:hash shaped (got ${JSON.stringify(hash0)})`);
  const login0 = await req(server, 'POST', '/auth/login', { email: 'u0@example.com', password: 'distinct-password-0' });
  assert(login0.status === 200, `criterion 2: a hash produced by this code verifies through login (got ${login0.status})`);
  console.log('NOTE criterion 2: no pre-change hash exists anywhere to test backward compatibility against -- this service holds no state across a reset or restart, so there is no earlier-format hash in existence to verify.');

  // ---- criterion 3: id collision impossible by construction (D27) ----
  const collisionFx = {
    currency: 'EUR', minor_units: 2,
    users: [
      { id: 'u_1', email: 'one@example.com', password: 'correct horse', display_name: 'One', handle: 'one', balance: 10 },
      { id: 'u_2', email: 'two@example.com', password: 'correct horse', display_name: 'Two', handle: 'two', balance: 10 },
      // Edge-shaped seeded ids the fix must not depend on to stay safe:
      { id: 'u_non_numeric_suffix', email: 'three@example.com', password: 'correct horse', display_name: 'Three', handle: 'three', balance: 10 },
      { id: 'u_999999999999', email: 'four@example.com', password: 'correct horse', display_name: 'Four', handle: 'four', balance: 10 },
      { id: 'totally-different-shape', email: 'five@example.com', password: 'correct horse', display_name: 'Five', handle: 'five', balance: 10 },
    ],
    payments: [{ id: 'p_1', from_user_id: 'u_1', to_user_id: 'u_2', amount: 5, note: 'seed', visibility: 'public' }],
    requests: [{ id: 'rq_1', requester_id: 'u_2', payer_id: 'u_1', amount: 5, note: 'seed', status: 'pending' }],
  };
  r = await req(server, 'POST', '/_test/reset', collisionFx);
  assert(r.status === 204, `criterion 3: collision-test fixture -> 204 (got ${r.status})`);
  const seededIds = new Set(['u_1', 'u_2', 'u_non_numeric_suffix', 'u_999999999999', 'totally-different-shape', 'p_1', 'rq_1']);

  const signup = await req(server, 'POST', '/auth/signup', { email: 'six@example.com', password: 'correct horse', display_name: 'Six' });
  assert(signup.status === 201, `criterion 3: signup after collision fixture -> 201 (got ${signup.status})`);
  assert(!seededIds.has(signup.json.user_id), `criterion 3: minted user id does not collide with any seeded id (got ${signup.json.user_id})`);

  // POST /payments and POST /requests don't exist until W4/W6, so the
  // payment/request half of this criterion is exercised at the store
  // level directly -- the same nextId() every future endpoint will call.
  const mintedPaymentId = server.store.nextId('p');
  const mintedRequestId = server.store.nextId('rq');
  assert(!seededIds.has(mintedPaymentId), `criterion 3 (store-level, no POST /payments yet): minted payment id distinct from seeded (got ${mintedPaymentId})`);
  assert(!seededIds.has(mintedRequestId), `criterion 3 (store-level, no POST /requests yet): minted request id distinct from seeded (got ${mintedRequestId})`);

  // ---- criterion 4: GET /_test/export shape ----
  await req(server, 'POST', '/_test/reset', JSON.parse(require('fs').readFileSync(path.join(FIX_DIR, 'eur.json'), 'utf8')));
  const exp = await req(server, 'GET', '/_test/export');
  assert(exp.status === 200, `criterion 4: GET /_test/export -> 200 (got ${exp.status})`);
  assert(exp.json.track === 'pocketful', `criterion 4: track === "pocketful" (got ${JSON.stringify(exp.json.track)})`);
  assert(exp.json.format_version === 1, `criterion 4: format_version === 1 (got ${JSON.stringify(exp.json.format_version)})`);
  assert(typeof exp.json.state === 'object' && exp.json.state !== null, 'criterion 4: state is an object');
  const noAuthExp = await req(server, 'GET', '/_test/export', undefined, {});
  assert(noAuthExp.status === 200, `criterion 4: export needs no Authorization header (got ${noAuthExp.status})`);

  // ---- criterion 5: settlement_operator_ids retained through export ----
  assert(Array.isArray(exp.json.state.settlement_operator_ids)
    && exp.json.state.settlement_operator_ids.includes('u_op')
    && exp.json.state.settlement_operator_ids.includes('u_op2'),
    `criterion 5: eur.json's operator ids visible through export (got ${JSON.stringify(exp.json.state.settlement_operator_ids)})`);

  const noOpFx = JSON.parse(require('fs').readFileSync(path.join(FIX_DIR, 'eur-no-operators.json'), 'utf8'));
  await req(server, 'POST', '/_test/reset', noOpFx);
  const expNoOp = await req(server, 'GET', '/_test/export');
  assert(Array.isArray(expNoOp.json.state.settlement_operator_ids) && expNoOp.json.state.settlement_operator_ids.length === 0,
    `criterion 5: default [] visible through export when the fixture omits settlement_operator_ids (got ${JSON.stringify(expNoOp.json.state.settlement_operator_ids)})`);

  // ---- criterion 6: no plaintext password anywhere in the export ----
  await req(server, 'POST', '/_test/reset', JSON.parse(require('fs').readFileSync(path.join(FIX_DIR, 'eur.json'), 'utf8')));
  await req(server, 'POST', '/auth/signup', { email: 'plaintext-check@example.com', password: 'a very secret passphrase', display_name: 'Check' });
  const expForLeak = await req(server, 'GET', '/_test/export');
  for (const secret of ['correct horse', 'a very secret passphrase']) {
    assert(!expForLeak.raw.includes(secret), `criterion 6: literal password ${JSON.stringify(secret)} absent from export body`);
  }
  const b64 = Buffer.from('correct horse', 'utf8').toString('base64');
  const hex = Buffer.from('correct horse', 'utf8').toString('hex');
  assert(!expForLeak.raw.includes(b64) && !expForLeak.raw.toLowerCase().includes(hex),
    'criterion 6: no reversible (base64/hex) encoding of a fixture password in the export');

  server.close();
  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
}

main().catch((e) => { console.error(e); process.exit(1); });
