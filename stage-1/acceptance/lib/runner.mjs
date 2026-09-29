// Suite registry, per-test context and the failure report.
//
// Failures print: the specification reference, expected, actual, and a curl trail
// that reproduces the scenario from a clean container.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { request, curlFor } from './http.mjs';

export const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
export const ALT_BASE_URL = process.env.ALT_BASE_URL ? process.env.ALT_BASE_URL.replace(/\/+$/, '') : null;

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
const FIXTURE_DIR = path.join(ROOT, 'fixtures');
const fixtureCache = new Map();

export function fixture(name) {
  if (!fixtureCache.has(name)) {
    fixtureCache.set(name, readFileSync(path.join(FIXTURE_DIR, name + '.json'), 'utf8'));
  }
  return fixtureCache.get(name);
}

export function fixtureObject(name) {
  return JSON.parse(fixture(name));
}

// Sum of every seeded balance: the constant the spec-1.1 invariant is measured against.
export function seededTotal(name) {
  return fixtureObject(name).users.reduce((sum, u) => sum + u.balance, 0);
}

export const suites = [];
let currentSuite = null;

export function suite(name, body) {
  currentSuite = { name, tests: [] };
  suites.push(currentSuite);
  body();
  currentSuite = null;
}

// severity: 'blocking' (default) rejects a handoff; 'advisory' is reported but never rejects.
// An advisory check is one where the specification text does not settle the answer -- it
// tests a coordinator interpretation or one of several defensible readings. Every advisory
// check carries a `why` explaining which part of the reading is not determined by the spec.
export function test(name, refs, fn, opts = {}) {
  if (!currentSuite) throw new Error('test() called outside suite()');
  currentSuite.tests.push({
    name,
    refs: Array.isArray(refs) ? refs : [refs],
    fn,
    severity: opts.severity === 'advisory' ? 'advisory' : 'blocking',
    why: opts.why || null,
    slow: !!opts.slow,
  });
}

const RFC3339_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

class Ctx {
  constructor(testCase) {
    this.testCase = testCase;
    this.failures = [];
    this.trail = [];
    this.seenGlobal = new Set();
    this.aborted = null;
    this.base = BASE_URL;
  }

  note(line) {
    this.trail.push({ comment: line });
  }

  record(failure) {
    const res = failure.res;
    this.failures.push({
      ref: failure.ref,
      what: failure.what || '',
      expected: failure.expected,
      actual: failure.actual,
      severity: failure.severity || this.testCase.severity,
      curl: res && res.curl ? res.curl : (this.lastCurl() || null),
    });
  }

  lastCurl() {
    for (let i = this.trail.length - 1; i >= 0; i--) {
      if (this.trail[i].curl) return this.trail[i].curl;
    }
    return null;
  }

  // ---- HTTP -------------------------------------------------------------

  async req(spec) {
    const base = spec.base || this.base;
    const isTestControl = spec.path.startsWith('/_test/');
    const res = await request({
      timeoutMs: isTestControl ? 20000 : 15000,
      ...spec,
      base,
    });
    this.trail.push({ curl: res.curl, status: res.status, ms: res.ms });
    this.globalInvariants(res);
    return res;
  }

  // Invariants the specification states for *every* response, checked on every
  // exchange the suite makes. Reported once per test per reference.
  globalInvariants(res) {
    const once = (key, failure) => {
      if (this.seenGlobal.has(key)) return;
      this.seenGlobal.add(key);
      this.record(failure);
    };

    if (res.status === 0) {
      once('net', {
        ref: 'R3.2', what: 'HTTP exchange', severity: 'blocking',
        expected: 'an HTTP response',
        actual: 'no response: ' + (res.networkError || 'unknown transport error'),
        res,
      });
      this.aborted = 'transport error: ' + (res.networkError || '?');
      return;
    }

    // spec 5: "Requests must not produce 5xx responses, including under concurrent load."
    if (res.status >= 500) {
      once('5xx ' + res.path, {
        ref: 'R5.16', what: `${res.method} ${res.path}`, severity: 'blocking',
        expected: 'any status below 500',
        actual: `${res.status}; body: ${truncate(res.text, 300)}`,
        res,
      });
    }

    // spec 2 resource limits: per-request timeout 5 s, 10 s for POST /_test/reset.
    const budget = res.path.startsWith('/_test/') ? 10000 : 5000;
    if (res.ms > budget) {
      once('slow ' + res.path, {
        ref: 'R2.6', what: `${res.method} ${res.path} latency`, severity: 'blocking',
        expected: `a response within ${budget} ms`,
        actual: `${res.ms} ms`,
        res,
      });
    }

    // spec 5: every 4xx and 5xx response carries {"error":{"code":..,"message":..}}.
    if (res.status >= 400) {
      const e = res.json && typeof res.json === 'object' && !Array.isArray(res.json) ? res.json.error : undefined;
      const ok = e && typeof e === 'object' && !Array.isArray(e)
        && typeof e.code === 'string' && e.code.length > 0
        && typeof e.message === 'string';
      if (!ok) {
        once('errbody ' + res.status + ' ' + res.path, {
          ref: 'R5.1', what: `${res.method} ${res.path} -> ${res.status} error body`, severity: 'blocking',
          expected: '{"error":{"code":<non-empty string>,"message":<string>}}',
          actual: truncate(res.text, 300) || '(empty body)',
          res,
        });
      }
    }

    if (res.status === 204 && res.raw.length > 0) {
      once('204body ' + res.path, {
        ref: 'R3.3', what: `${res.method} ${res.path} -> 204`, severity: 'blocking',
        expected: 'an empty body on 204 No Content',
        actual: truncate(res.text, 200),
        res,
      });
    }

    // spec 3.4: requests and responses are application/json; charset=utf-8.
    if (res.raw.length > 0) {
      const ct = String(res.headers['content-type'] || '').toLowerCase().replace(/\s+/g, '');
      if (!ct.includes('application/json') || !ct.includes('charset=utf-8')) {
        once('ct ' + res.path, {
          ref: 'R3.4a', what: `${res.method} ${res.path} Content-Type`, severity: 'blocking',
          expected: 'application/json; charset=utf-8',
          actual: res.headers['content-type'] === undefined ? '(absent)' : res.headers['content-type'],
          res,
        });
      }
      if (res.jsonError) {
        once('parse ' + res.path, {
          ref: 'R3.4a', what: `${res.method} ${res.path} body`, severity: 'blocking',
          expected: 'a parseable JSON body',
          actual: `JSON.parse failed (${res.jsonError}); body: ${truncate(res.text, 200)}`,
          res,
        });
      }
    }

    // GET /_test/export returns an implementation-defined opaque `state` object;
    // the shape rules below do not apply inside it (spec 10).
    if (res.path.startsWith('/_test/export')) return;

    if (res.json !== undefined) {
      for (const { key, value, where } of walk(res.json)) {
        // spec 3.4: timestamps are RFC 3339 with an explicit offset.
        if ((key === 'created_at' || key === 'committed_at') && typeof value === 'string') {
          if (!RFC3339_WITH_OFFSET.test(value)) {
            once('ts ' + res.path, {
              ref: 'R3.4b', what: `${res.method} ${res.path} ${where}`, severity: 'blocking',
              expected: 'an RFC 3339 timestamp with an explicit offset, e.g. 2026-09-24T19:00:00+02:00',
              actual: JSON.stringify(value),
              res,
            });
          }
        }
        // spec 3.4: IDs are opaque strings of at most 64 characters.
        if (/(^|_)id$/.test(key) && value !== null && value !== undefined) {
          if (typeof value !== 'string') {
            once('idtype ' + res.path + key, {
              ref: 'R3.4e', what: `${res.method} ${res.path} ${where}`, severity: 'blocking',
              expected: 'an id that is a string (or null where the spec allows null)',
              actual: `${typeof value}: ${JSON.stringify(value)}`,
              res,
            });
          } else if ([...value].length > 64) {
            once('idlen ' + res.path + key, {
              ref: 'R3.4e', what: `${res.method} ${res.path} ${where}`, severity: 'blocking',
              expected: 'an id of at most 64 characters',
              actual: `${[...value].length} characters: ${JSON.stringify(value)}`,
              res,
            });
          }
        }
      }
    }
  }

  // ---- assertions -------------------------------------------------------

  ok(cond, failure) {
    if (!cond) this.record(failure);
    return !!cond;
  }

  eq(actual, expected, failure) {
    return this.ok(actual === expected, {
      ...failure,
      expected: failure.expected !== undefined ? failure.expected : show(expected),
      actual: failure.actual !== undefined ? failure.actual : show(actual),
    });
  }

  deep(actual, expected, failure) {
    return this.ok(deepEqual(actual, expected), {
      ...failure,
      expected: failure.expected !== undefined ? failure.expected : show(expected),
      actual: failure.actual !== undefined ? failure.actual : show(actual),
    });
  }

  status(res, expected, failure) {
    return this.ok(res.status === expected, {
      res, ...failure,
      expected: `HTTP ${expected}`,
      actual: `HTTP ${res.status}; body: ${truncate(res.text, 240)}`,
    });
  }

  // An error response: exact status and exact spec `code`.
  err(res, expected, code, failure) {
    const actualCode = res.json && res.json.error ? res.json.error.code : undefined;
    return this.ok(res.status === expected && actualCode === code, {
      res, ...failure,
      expected: `HTTP ${expected} with error.code "${code}"`,
      actual: `HTTP ${res.status} with error.code ${JSON.stringify(actualCode)}; body: ${truncate(res.text, 240)}`,
    });
  }

  // Where the specification permits more than one answer, accept any of them.
  oneOfErr(res, allowed, failure) {
    const actualCode = res.json && res.json.error ? res.json.error.code : undefined;
    const hit = allowed.some(([s, c]) => res.status === s && actualCode === c);
    return this.ok(hit, {
      res, ...failure,
      expected: 'any of ' + allowed.map(([s, c]) => `HTTP ${s} ${c}`).join(' | '),
      actual: `HTTP ${res.status} with error.code ${JSON.stringify(actualCode)}; body: ${truncate(res.text, 240)}`,
    });
  }

  // Exact key set on an object: catches both missing and unexpected response fields.
  fields(obj, expectedKeys, failure) {
    const actual = obj && typeof obj === 'object' && !Array.isArray(obj) ? Object.keys(obj).sort() : null;
    if (actual === null) {
      return this.record({ ...failure, expected: 'a JSON object', actual: show(obj) });
    }
    const want = [...expectedKeys].sort();
    const missing = want.filter((k) => !actual.includes(k));
    if (missing.length) {
      this.record({ ...failure, expected: `fields ${want.join(', ')}`, actual: `missing ${missing.join(', ')}; present: ${actual.join(', ')}` });
      return false;
    }
    return true;
  }
}

export function truncate(s, n) {
  s = String(s === undefined ? '' : s);
  return s.length <= n ? s : s.slice(0, n) + `… (${s.length} bytes total)`;
}

function show(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

function* walk(node, where = '$') {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) yield* walk(node[i], `${where}[${i}]`);
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      yield { key: k, value: v, where: `${where}.${k}` };
      yield* walk(v, `${where}.${k}`);
    }
  }
}

export async function runAll({ only = null, verbose = false, includeSlow = true } = {}) {
  const results = [];
  let passed = 0, failedBlocking = 0, failedAdvisory = 0, skipped = 0;

  for (const s of suites) {
    let announced = false;
    for (const tc of s.tests) {
      const label = `${s.name} :: ${tc.name}`;
      if (only && !label.toLowerCase().includes(only.toLowerCase())) { skipped++; continue; }
      if (tc.slow && !includeSlow) { skipped++; continue; }
      if (!announced) { process.stdout.write(`\n  ${s.name}\n`); announced = true; }

      const ctx = new Ctx(tc);
      const started = Date.now();
      try {
        await tc.fn(ctx);
      } catch (err) {
        ctx.record({
          ref: tc.refs[0], what: 'the check itself raised',
          expected: 'the check to run to completion',
          actual: `${err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : err}`,
          severity: tc.severity,
        });
      }
      const ms = Date.now() - started;
      const blocking = ctx.failures.filter((f) => f.severity === 'blocking');
      const advisory = ctx.failures.filter((f) => f.severity !== 'blocking');
      const state = blocking.length ? 'FAIL' : advisory.length ? 'ADVISORY' : 'pass';
      if (state === 'pass') passed++;
      else if (state === 'FAIL') failedBlocking++;
      else failedAdvisory++;

      const mark = state === 'pass' ? '  ok  ' : state === 'FAIL' ? ' FAIL ' : ' adv  ';
      process.stdout.write(`   ${mark} [${tc.refs.join(' ')}] ${tc.name}${verbose ? ` (${ms} ms)` : ''}\n`);
      results.push({ suite: s.name, test: tc, ms, failures: ctx.failures, trail: ctx.trail, state });

      if (ctx.aborted) {
        process.stdout.write(`\n!! aborting: ${ctx.aborted}\n   the service at ${BASE_URL} stopped answering.\n`);
        return report(results, { passed, failedBlocking, failedAdvisory, skipped, aborted: ctx.aborted });
      }
    }
  }
  return report(results, { passed, failedBlocking, failedAdvisory, skipped, aborted: null });
}

function report(results, totals) {
  const failing = results.filter((r) => r.failures.length > 0);
  if (failing.length) {
    process.stdout.write('\n' + '='.repeat(78) + '\nFAILURE DETAIL\n' + '='.repeat(78) + '\n');
    let n = 0;
    for (const r of failing) {
      for (const f of r.failures) {
        n++;
        process.stdout.write(`\n[${n}] ${f.severity.toUpperCase()}  spec ref ${f.ref}\n`);
        process.stdout.write(`    check     ${r.suite} :: ${r.test.name}\n`);
        if (f.what) process.stdout.write(`    subject   ${f.what}\n`);
        process.stdout.write(`    expected  ${f.expected}\n`);
        process.stdout.write(`    actual    ${f.actual}\n`);
        if (r.test.severity === 'advisory' && r.test.why) {
          process.stdout.write(`    advisory  ${r.test.why}\n`);
        }
        if (f.curl) process.stdout.write(`    reproduce ${f.curl}\n`);
      }
      process.stdout.write(`    ---- full request trail for this check ----\n`);
      for (const step of r.trail.slice(-14)) {
        if (step.comment) process.stdout.write(`      # ${step.comment}\n`);
        else process.stdout.write(`      ${step.curl}   # -> ${step.status} (${step.ms} ms)\n`);
      }
    }
  }
  process.stdout.write('\n' + '='.repeat(78) + '\n');
  process.stdout.write(`SUMMARY  pass ${totals.passed}   FAIL(blocking) ${totals.failedBlocking}   advisory-only ${totals.failedAdvisory}   skipped ${totals.skipped}\n`);
  process.stdout.write('='.repeat(78) + '\n');
  return { ...totals, results, exitCode: totals.failedBlocking > 0 || totals.aborted ? 1 : 0 };
}

export { Ctx };
