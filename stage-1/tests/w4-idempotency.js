'use strict';

// Durable evidence for board item W4 (the idempotency gate), committed per
// D28. Exercises stage-1/src/lib/idempotency.js over real HTTP against a
// throwaway test-only harness: two probe routes wired through the gate,
// built here rather than added to the delivered route table, since no real
// write endpoint exists until W5. The harness reuses the real router, auth
// and store code (createRouter, registerAuthRoutes, requireAuth) so the
// gate is proven against the same request-handling path W5+ will use, just
// without spec-facing business logic behind it.
//
// Covers acceptance criteria 1-10 for W4. Criterion 11 (D2: no await
// between claim and commit) is a grep, pasted in the handoff, not run here.
// Criterion 12 (the D30 export guard) lives in export-coverage-guard.js.
// Criterion 13 (no regression on suites 01-03) is the acceptance suite,
// run separately.

const http = require('http');

const { createRouter } = require('../src/lib/router');
const { Store } = require('../src/store');
const { registerAuthRoutes } = require('../src/routes/auth');
const { requireAuth } = require('../src/lib/auth');
const { sendJson, sendError, readJsonBody } = require('../src/lib/http');
const { AppError } = require('../src/lib/errors');
const { runIdempotent } = require('../src/lib/idempotency');

function buildProbeRouter(store) {
  const router = createRouter();
  registerAuthRoutes(router, store);

  let counter = 0;
  const probeHandler = () => (req, res) => {
    const user = requireAuth(req, store);
    const rawKey = req.headers['idempotency-key'];
    const result = runIdempotent(
      store,
      { user, method: req.method, path: req.pathname, rawKey, body: req.jsonBody },
      () => {
        const body = req.jsonBody || {};
        // A synthetic stand-in for "endpoint field validation" and
        // "resource resolution", so R7.13 (an already-claimed key beats
        // both) is provable without needing a real domain endpoint.
        if (body.fail === 'validation') throw new AppError(422, 'validation_failed', 'probe: synthetic field failure');
        if (body.fail === 'not_found') throw new AppError(404, 'not_found', 'probe: synthetic unknown resource');
        counter += 1;
        return { status: 201, body: { probe_id: store.nextId('probe'), n: counter, echo: body } };
      },
    );
    sendJson(res, result.status, result.body);
  };

  router.add('POST', '/_test/idem-probe', async (req, res) => probeHandler()(req, res));
  router.add('POST', '/_test/idem-probe-2', async (req, res) => probeHandler()(req, res));
  return { router, counter: () => counter };
}

function createProbeServer() {
  const store = new Store();
  const { router, counter } = buildProbeRouter(store);
  const app = async (req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://internal').pathname;
    } catch {
      sendError(res, 400, 'malformed_request', 'unparseable request URL');
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendError(res, err.status || 400, err.code || 'malformed_request', err.message);
      return;
    }
    req.jsonBody = body;
    req.pathname = pathname;
    try {
      const { handler, params } = router.resolve(req.method, pathname);
      await handler(req, res, params);
    } catch (err) {
      if (res.headersSent) return;
      if (err instanceof AppError) sendError(res, err.status, err.code, err.message);
      else sendError(res, 400, 'malformed_request', 'internal error');
    }
  };
  const server = http.createServer((req, res) => app(req, res));
  server.store = store;
  server.counter = counter;
  return server;
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

function probe(server, tok, body, key, path = '/_test/idem-probe') {
  const headers = { Authorization: `Bearer ${tok}` };
  if (key !== undefined) headers['Idempotency-Key'] = key;
  return req(server, 'POST', path, body, headers);
}

let seq = 0;
function key(prefix = 'k') {
  seq += 1;
  return `${prefix}-${process.pid}-${Date.now().toString(36)}-${seq}`;
}

let passCount = 0;
let failCount = 0;
function assert(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (cond) passCount++; else { failCount++; process.exitCode = 1; }
}

async function signup(server, email) {
  const r = await req(server, 'POST', '/auth/signup', { email, password: 'correct horse', display_name: 'Probe User' });
  if (r.status !== 201) throw new Error(`setup signup failed: ${r.status} ${r.raw}`);
  return r.json.token;
}

async function main() {
  const server = createProbeServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const tokA = await signup(server, 'proba@example.com');
  const tokB = await signup(server, 'probb@example.com');

  // ---- criterion 1: missing / empty / whitespace Idempotency-Key ----
  {
    const r = await probe(server, tokA, { v: 1 }, undefined);
    assert(r.status === 400 && r.json.error.code === 'missing_idempotency_key', `criterion 1: missing header -> 400 missing_idempotency_key (got ${r.status} ${r.json && r.json.error && r.json.error.code})`);
  }
  {
    const r = await probe(server, tokA, { v: 1 }, '');
    assert(r.status === 400 && r.json.error.code === 'missing_idempotency_key', `criterion 1: empty header -> 400 missing_idempotency_key (got ${r.status} ${r.json && r.json.error && r.json.error.code})`);
  }
  {
    // Not actually a design choice: RFC 9110 §5.5 requires leading/trailing
    // optional whitespace to be stripped from a header field value before
    // the application ever sees it, and every compliant HTTP client and
    // server does this. A whitespace-only Idempotency-Key therefore always
    // arrives as the empty string -- there is no wire-observable difference
    // between "whitespace-only" and "empty" to make a choice about. The
    // gate's own code never trims (nothing here special-cases whitespace);
    // this 400 falls out of HTTP itself, confirmed empirically below.
    const r = await probe(server, tokA, { v: 1 }, ' ');
    assert(r.status === 400 && r.json.error.code === 'missing_idempotency_key', `criterion 1: whitespace-only header arrives as empty over HTTP (OWS stripping, RFC 9110 5.5) -> 400 missing_idempotency_key (got ${r.status} ${r.json && r.json.error && r.json.error.code})`);
  }

  // ---- criterion 2: key length boundaries ----
  {
    const r255 = await probe(server, tokA, { v: 2 }, 'k'.repeat(255));
    assert(r255.status === 201, `criterion 2: 255-char key accepted (got ${r255.status})`);
    const r1 = await probe(server, tokA, { v: 3 }, 'x');
    assert(r1.status === 201, `criterion 2: 1-char key accepted (got ${r1.status})`);
    const r256 = await probe(server, tokA, { v: 4 }, 'k'.repeat(256));
    assert(r256.status === 422 && r256.json.error.code === 'validation_failed', `criterion 2: 256-char key -> 422 validation_failed (got ${r256.status} ${r256.json && r256.json.error && r256.json.error.code})`);
  }

  // ---- criterion 3: first use 201, replay 200 identical, no second mutation ----
  {
    const k = key('c3');
    const before = server.counter();
    const first = await probe(server, tokA, { v: 5 }, k);
    assert(first.status === 201, `criterion 3: first use -> 201 (got ${first.status})`);
    const afterFirst = server.counter();
    const replay = await probe(server, tokA, { v: 5 }, k);
    assert(replay.status === 200, `criterion 3: replay -> 200 (got ${replay.status})`);
    assert(JSON.stringify(replay.json) === JSON.stringify(first.json), 'criterion 3: replay body identical to the first response as a JSON value');
    assert(server.counter() === afterFirst, `criterion 3: replay caused no second mutation (counter ${before}->${afterFirst}->${server.counter()})`);
  }

  // ---- criterion 4: replay recognised across key order and whitespace ----
  {
    const k = key('c4');
    const first = await probe(server, tokA, { a: 1, b: 2 }, k);
    assert(first.status === 201, `criterion 4: first use -> 201 (got ${first.status})`);
    const reordered = '{\n  "b":    2,\n  "a": 1\n}';
    const r = await req(server, 'POST', '/_test/idem-probe', reordered, { Authorization: `Bearer ${tokA}`, 'Idempotency-Key': k, 'Content-Type': 'application/json' });
    assert(r.status === 200, `criterion 4: reordered/whitespaced replay -> 200 (got ${r.status})`);
    assert(JSON.stringify(r.json) === JSON.stringify(first.json), 'criterion 4: reordered/whitespaced replay body identical to the first response');
  }

  // ---- criterion 5: same key, different body -> 409 ----
  {
    const k = key('c5');
    const first = await probe(server, tokA, { v: 10 }, k);
    assert(first.status === 201, `criterion 5: first use -> 201 (got ${first.status})`);
    const clash = await probe(server, tokA, { v: 11 }, k);
    assert(clash.status === 409 && clash.json.error.code === 'idempotency_key_reuse', `criterion 5: different body -> 409 idempotency_key_reuse (got ${clash.status} ${clash.json && clash.json.error && clash.json.error.code})`);
  }

  // ---- criterion 6: same key, same body, different path -> succeeds normally ----
  {
    const k = key('c6');
    const first = await probe(server, tokA, { v: 20 }, k, '/_test/idem-probe');
    assert(first.status === 201, `criterion 6: first path -> 201 (got ${first.status})`);
    const second = await probe(server, tokA, { v: 20 }, k, '/_test/idem-probe-2');
    assert(second.status === 201, `criterion 6: same key + same body, different path -> 201, not a replay/conflict (got ${second.status})`);
  }

  // ---- criterion 7: same key string, different user -> no interaction ----
  {
    const k = key('c7');
    const a = await probe(server, tokA, { v: 30 }, k);
    const b = await probe(server, tokB, { v: 30 }, k);
    assert(a.status === 201 && b.status === 201, `criterion 7: both users get 201 with the shared key (got ${a.status}, ${b.status})`);
    assert(a.json.probe_id !== b.json.probe_id, 'criterion 7: the two users produced independent resources');
  }

  // ---- criterion 8: a key whose first use is 4xx is reusable ----
  {
    const k = key('c8');
    const failed = await probe(server, tokA, { fail: 'validation' }, k);
    assert(failed.status === 422, `criterion 8: first use fails 422 (got ${failed.status})`);
    const reused = await probe(server, tokA, { v: 40 }, k);
    assert(reused.status === 201, `criterion 8: key reused after a 4xx -> 201, treated as first use (got ${reused.status})`);
  }

  // ---- criterion 9: a claimed key beats endpoint validation and resource resolution ----
  {
    const k = key('c9a');
    const first = await probe(server, tokA, { v: 50 }, k);
    assert(first.status === 201, `criterion 9a setup: first use -> 201 (got ${first.status})`);
    const cBefore = server.counter();
    const invalid = await probe(server, tokA, { fail: 'validation' }, k);
    assert(invalid.status === 409 && invalid.json.error.code === 'idempotency_key_reuse', `criterion 9a: claimed key + a body that would 422 -> 409 idempotency_key_reuse, not 422 (got ${invalid.status} ${invalid.json && invalid.json.error && invalid.json.error.code})`);
    assert(server.counter() === cBefore, 'criterion 9a: the synthetic validator was never reached (no mutation)');
  }
  {
    const k = key('c9b');
    const first = await probe(server, tokA, { v: 51 }, k);
    assert(first.status === 201, `criterion 9b setup: first use -> 201 (got ${first.status})`);
    const notFound = await probe(server, tokA, { fail: 'not_found' }, k);
    assert(notFound.status === 409 && notFound.json.error.code === 'idempotency_key_reuse', `criterion 9b: claimed key + a body that would 404 -> 409 idempotency_key_reuse, not 404 (got ${notFound.status} ${notFound.json && notFound.json.error && notFound.json.error.code})`);
  }

  // ---- criterion 10: 20 concurrent identical requests, one unused key ----
  // Run several rounds so this means something, not a single lucky pass.
  {
    const ROUNDS = 20;
    const N = 20;
    let allRoundsOk = true;
    for (let round = 0; round < ROUNDS; round++) {
      const k = key(`race${round}`);
      const before = server.counter();
      const all = await Promise.all(
        Array.from({ length: N }, () => probe(server, tokA, { round, v: 'race' }, k)),
      );
      const created = all.filter((r) => r.status === 201);
      const replayed = all.filter((r) => r.status === 200);
      const after = server.counter();
      const ok = created.length === 1 && replayed.length === N - 1 && (after - before) === 1
        && replayed.every((r) => JSON.stringify(r.json) === JSON.stringify(created[0].json));
      if (!ok) {
        allRoundsOk = false;
        console.log(`  round ${round}: created=${created.length} replayed=${replayed.length} mutation=${after - before} statuses=${JSON.stringify(all.map((r) => r.status))}`);
      }
    }
    assert(allRoundsOk, `criterion 10: ${ROUNDS} rounds of ${N} concurrent identical requests each produced exactly one 201, ${N - 1} identical 200s, and exactly one mutation`);
  }

  // Different keys concurrently must each take effect -- the counterpart
  // check that the gate does not over-serialise unrelated requests.
  {
    const N = 15;
    const before = server.counter();
    const all = await Promise.all(
      Array.from({ length: N }, () => probe(server, tokA, { v: 'distinct' }, key('distinct'))),
    );
    const created = all.filter((r) => r.status === 201);
    assert(created.length === N, `sanity: ${N} concurrent requests with ${N} distinct keys each take effect (got ${created.length} of ${N})`);
    assert(server.counter() - before === N, 'sanity: the operation happened exactly N times, once per distinct key');
  }

  server.close();
  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
}

main().catch((e) => { console.error(e); process.exit(1); });
