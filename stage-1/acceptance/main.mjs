#!/usr/bin/env node
// Pocketful stage-1 acceptance suite.
//
//   BASE_URL=http://127.0.0.1:8080 node main.mjs            run everything
//   node main.mjs --fast                                    skip the slow concurrency checks
//   node main.mjs --only "idempotency"                       run matching checks only
//   node main.mjs --list                                     list every check and its references
//   node main.mjs --coverage                                 print COVERAGE.md
//
// Exits non-zero if any blocking check fails. Advisory failures are reported and do not
// affect the exit code.

import { suites, runAll, BASE_URL, ALT_BASE_URL } from './lib/runner.mjs';
import { waitForHealth } from './lib/http.mjs';
import { REQUIREMENTS, DECISIONS, DELIBERATE_GAPS } from './lib/inventory.mjs';

// Importing a check file registers its suite. Order matters only for readability.
await import('./checks/01-runtime.mjs');
await import('./checks/02-reset.mjs');
await import('./checks/03-auth.mjs');
await import('./checks/04-payments.mjs');
await import('./checks/05-idempotency.mjs');
await import('./checks/06-requests.mjs');
await import('./checks/07-activity.mjs');
await import('./checks/08-splits.mjs');
await import('./checks/09-settlements.mjs');
await import('./checks/10-export-import.mjs');
await import('./checks/11-precedence.mjs');
await import('./checks/12-concurrency.mjs');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  if (i === -1) return null;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : null;
};

function allChecks() {
  const out = [];
  for (const s of suites) for (const tc of s.tests) out.push({ suite: s.name, ...tc });
  return out;
}

function coverageIndex() {
  const index = new Map();
  for (const check of allChecks()) {
    for (const ref of check.refs) {
      if (!index.has(ref)) index.set(ref, []);
      index.get(ref).push(check);
    }
  }
  return index;
}

if (has('--list')) {
  for (const s of suites) {
    process.stdout.write(`\n${s.name}\n`);
    for (const tc of s.tests) {
      process.stdout.write(`  [${tc.refs.join(' ')}] ${tc.name}${tc.severity === 'advisory' ? '  (advisory)' : ''}${tc.slow ? '  (slow)' : ''}\n`);
    }
  }
  const checks = allChecks();
  process.stdout.write(`\n${checks.length} checks in ${suites.length} suites; ${checks.filter((c) => c.severity === 'advisory').length} advisory, ${checks.filter((c) => c.slow).length} slow.\n`);
  process.exit(0);
}

if (has('--coverage')) {
  const index = coverageIndex();
  const checks = allChecks();
  const covered = REQUIREMENTS.filter(([id]) => index.has(id));
  const gaps = REQUIREMENTS.filter(([id]) => !index.has(id));
  const undeclared = gaps.filter(([id]) => !DELIBERATE_GAPS[id]);
  const refless = [...index.keys()].filter((ref) => !REQUIREMENTS.some(([id]) => id === ref) && !DECISIONS.some(([id]) => id === ref));

  const out = [];
  out.push('# Coverage map — Pocketful stage 1');
  out.push('');
  out.push('Generated from the suite itself: `node main.mjs --coverage`. Every reference below comes');
  out.push('from `lib/inventory.mjs`, which was written from `spec/stage-1.md` alone. A reference with');
  out.push('no check is listed as a gap, and every gap must carry a reason.');
  out.push('');
  out.push('| | |');
  out.push('|---|---|');
  out.push(`| requirement references | ${REQUIREMENTS.length} |`);
  out.push(`| references with at least one check | ${covered.length} |`);
  out.push(`| references deliberately left to out-of-band verification | ${gaps.length} |`);
  out.push(`| references with no check and no stated reason | ${undeclared.length} |`);
  out.push(`| coordinator interpretations checked (advisory only) | ${DECISIONS.filter(([id]) => index.has(id)).length} of ${DECISIONS.length} |`);
  out.push(`| checks | ${checks.length} (${checks.filter((c) => c.severity === 'blocking').length} blocking, ${checks.filter((c) => c.severity === 'advisory').length} advisory) |`);
  out.push('');
  out.push('A **blocking** check fails the suite and rejects a handoff. An **advisory** check is one');
  out.push('where the specification text does not settle the answer: it records what the service did');
  out.push('and why the question is open, and never rejects on its own. Each advisory check carries');
  out.push('its reasoning in the source and prints it on failure.');
  out.push('');
  out.push('## Requirements to checks');
  out.push('');
  for (const section of [...new Set(REQUIREMENTS.map(([, s]) => s))]) {
    out.push(`### Specification ${section}`);
    out.push('');
    out.push('| ref | requirement | checks |');
    out.push('|---|---|---|');
    for (const [id, sec, text] of REQUIREMENTS) {
      if (sec !== section) continue;
      const hits = index.get(id) || [];
      const cell = hits.length
        ? hits.map((h) => `${h.suite.split(' ')[0]}: ${h.name}${h.severity === 'advisory' ? ' *(advisory)*' : ''}`).join('<br>')
        : `**not checked over HTTP** — ${DELIBERATE_GAPS[id] || 'NO REASON RECORDED'}`;
      out.push(`| ${id} | ${text.replace(/\|/g, '\\|')} | ${cell.replace(/\|/g, '\\|')} |`);
    }
    out.push('');
  }
  out.push('## Coordinator interpretations');
  out.push('');
  out.push('These are not specification text. Each is checked as advisory, so a service that reads the');
  out.push('specification differently is reported but not rejected.');
  out.push('');
  out.push('| ref | interpretation | checks |');
  out.push('|---|---|---|');
  for (const [id, text] of DECISIONS) {
    const hits = index.get(id) || [];
    out.push(`| ${id} | ${text.replace(/\|/g, '\\|')} | ${hits.length ? hits.map((h) => `${h.suite.split(' ')[0]}: ${h.name}`).join('<br>') : '**not checked**'} |`);
  }
  out.push('');
  out.push('## Deliberately not covered by this suite');
  out.push('');
  out.push('Named here so the record is explicit. None of these is dropped: each is either a');
  out.push('statement of scope with no behaviour to test, an explicit relaxation the suite relies on,');
  out.push('or a property of the container and the delivered tree that is verified out of band by');
  out.push('building and starting the image.');
  out.push('');
  for (const [id, , text] of REQUIREMENTS) {
    if (index.has(id)) continue;
    out.push(`- **${id}** — ${text}`);
    out.push(`  - ${DELIBERATE_GAPS[id] || '**NO REASON RECORDED — this is a gap in the suite.**'}`);
  }
  out.push('');
  if (undeclared.length) {
    out.push('## Unexplained gaps');
    out.push('');
    out.push('The following references have no check and no recorded reason. This section must be empty.');
    out.push('');
    for (const [id] of undeclared) out.push(`- ${id}`);
    out.push('');
  }
  if (refless.length) {
    out.push('## Checks citing an unknown reference');
    out.push('');
    for (const ref of refless) out.push(`- ${ref}`);
    out.push('');
  }
  out.push('## Running it');
  out.push('');
  out.push('```sh');
  out.push('# against a container started however you like, on any port');
  out.push('BASE_URL=http://127.0.0.1:8080 node stage-1/acceptance/main.mjs');
  out.push('');
  out.push('# or let the script wait for health first');
  out.push('BASE_URL=http://127.0.0.1:8080 ./stage-1/acceptance/run.sh');
  out.push('```');
  out.push('');
  out.push('The suite talks HTTP and nothing else, so it runs unchanged against a container that has');
  out.push('no network interfaces at all. The method matters: `--network none` makes a published port');
  out.push('inert, so the suite cannot reach the service from the host. Mount this directory read-only');
  out.push('and run it *inside* the container against loopback:');
  out.push('');
  out.push('    docker run -d --name iso --network none -e PORT=8080 \\');
  out.push('      -v "$(pwd)/stage-1/acceptance:/suite:ro" <image>');
  out.push('    docker exec -e BASE_URL=http://127.0.0.1:8080 iso node /suite/main.mjs');
  out.push('');
  out.push('Set `ALT_BASE_URL` to a second, independently started container to additionally exercise');
  out.push('R10.6 (an export that carries no dependency on its source).');
  out.push('');
  process.stdout.write(out.join('\n'));
  process.exit(0);
}

const only = valueOf('--only');
const includeSlow = !has('--fast');

process.stdout.write(`Pocketful stage-1 acceptance suite\n`);
process.stdout.write(`  target      ${BASE_URL}\n`);
if (ALT_BASE_URL) process.stdout.write(`  second node ${ALT_BASE_URL}\n`);
process.stdout.write(`  checks      ${allChecks().length} in ${suites.length} suites${includeSlow ? '' : ' (skipping slow)'}${only ? `, filtered by ${JSON.stringify(only)}` : ''}\n`);

if (!has('--no-wait')) {
  // Specification 3.2: 200 within 60 s of container start; non-200 before then is allowed.
  const health = await waitForHealth(BASE_URL, 60000);
  if (!health.ok) {
    process.stdout.write(`\nFAIL  spec ref R3.2\n`);
    process.stdout.write(`    expected  GET ${BASE_URL}/health to answer 200 within 60000 ms of start\n`);
    process.stdout.write(`    actual    ${health.res.status === 0 ? `no response: ${health.res.networkError}` : `HTTP ${health.res.status}: ${health.res.text}`}\n`);
    process.stdout.write(`    reproduce curl -sS -i ${BASE_URL}/health\n`);
    process.exit(1);
  }
}

const started = Date.now();
const result = await runAll({ only, includeSlow });
process.stdout.write(`elapsed ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
process.exit(result.exitCode);
