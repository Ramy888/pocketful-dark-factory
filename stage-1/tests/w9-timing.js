'use strict';

// D45/D28 durable evidence for W9 criterion 17: export and import of a
// 500-user fixture with payments, requests and splits each complete
// inside the 10s test-control budget (R10.9). Run this file itself inside
// `docker run --cpus=2 --memory=2g` for the number that counts; a local
// run only smoke-tests correctness. Report five runs as min/median/max
// per D45, not a single figure -- host load moves this number by a wide
// margin run to run.

const http = require('http');
const { createServer } = require('../src/server');

function req(server, method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const h = Object.assign({}, headers);
    if (payload !== undefined) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(payload); }
    const r = http.request({ host: '127.0.0.1', port: server.address().port, method, path, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json; try { json = raw ? JSON.parse(raw) : undefined; } catch { json = undefined; }
        resolve({ status: res.statusCode, json, raw });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function buildFixture(n) {
  const users = Array.from({ length: n }, (_, i) => ({
    id: `u_${i}`, email: `u${i}@example.com`, password: `distinct-password-${i}`,
    display_name: `User ${i}`, handle: `u${i}`, balance: 100000,
  }));
  return { currency: 'EUR', minor_units: 2, users, payments: [], requests: [] };
}

async function main() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const r = await req(server, 'POST', '/_test/reset', buildFixture(500));
  if (r.status !== 204) throw new Error(`reset failed: ${r.status} ${r.raw}`);

  const tok0 = (await req(server, 'POST', '/auth/login', { email: 'u0@example.com', password: 'distinct-password-0' })).json.token;
  // A modest amount of live traffic on top of the seeded users, so the
  // fixture being exported/imported isn't just 500 bare accounts.
  for (let i = 1; i <= 50; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- sequential seeding, not the thing under measurement
    await req(server, 'POST', '/payments', { to_handle: `u${i}`, amount: 10 }, { Authorization: `Bearer ${tok0}`, 'Idempotency-Key': `pay-${i}` });
  }
  for (let i = 51; i <= 100; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await req(server, 'POST', '/requests', { payer_handle: `u${i}`, amount: 5 }, { Authorization: `Bearer ${tok0}`, 'Idempotency-Key': `req-${i}` });
  }
  await req(server, 'POST', '/splits', { amount: 100, participant_handles: ['u0', 'u1', 'u2', 'u3', 'u4'] }, { Authorization: `Bearer ${tok0}`, 'Idempotency-Key': 'split-1' });

  const exportMs = [];
  const importMs = [];
  const server2 = createServer();
  await new Promise((resolve) => server2.listen(0, '127.0.0.1', resolve));

  for (let round = 0; round < 5; round += 1) {
    const t0 = Date.now();
    // eslint-disable-next-line no-await-in-loop -- measuring sequential rounds on purpose
    const exp = await req(server, 'GET', '/_test/export');
    exportMs.push(Date.now() - t0);
    if (exp.status !== 200) throw new Error(`export failed: ${exp.status}`);

    const t1 = Date.now();
    // eslint-disable-next-line no-await-in-loop
    const imp = await req(server2, 'POST', '/_test/import', exp.json);
    importMs.push(Date.now() - t1);
    if (imp.status !== 204) throw new Error(`import failed: ${imp.status}`);
  }

  function stats(arr) {
    const sorted = [...arr].sort((a, b) => a - b);
    return { min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], max: sorted[sorted.length - 1] };
  }
  const es = stats(exportMs);
  const is = stats(importMs);
  console.log(`MEASURED  export (500 users + 50 payments + 50 requests + 1 split), 5 rounds: ${JSON.stringify(exportMs)}ms -> min ${es.min} / median ${es.median} / max ${es.max}, budget 10000ms`);
  console.log(`MEASURED  import, 5 rounds: ${JSON.stringify(importMs)}ms -> min ${is.min} / median ${is.median} / max ${is.max}, budget 10000ms`);

  let passCount = 0;
  let failCount = 0;
  function assert(cond, label) {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
    if (cond) passCount++; else { failCount++; process.exitCode = 1; }
  }
  assert(es.max < 10000, `criterion 17: export max ${es.max}ms is under the 10s budget (only authoritative inside --cpus=2 --memory=2g)`);
  assert(is.max < 10000, `criterion 17: import max ${is.max}ms is under the 10s budget (only authoritative inside --cpus=2 --memory=2g)`);

  server.close();
  server2.close();
  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
}

main().catch((e) => { console.error(e); process.exit(1); });
