// Self-test for the runner's zero-assertion guard (D47, generalised).
//
// The guard makes any check that records no assertion fail as blocking. It is
// itself a check written before the thing it guards against recurs, so by its
// own rule it has to be shown failing rather than assumed to work: a guard that
// has never fired is indistinguishable from one that cannot.
//
//   node stage-1/acceptance/probes/runner-vacuity-guard.mjs
//
// Exits 0 when the guard catches both known vacuity shapes and leaves a genuine
// check passing; 1 otherwise.
import { suite, test, runAll } from '../lib/runner.mjs';

suite('runner vacuity self test', () => {
  // Shape 1: the bare early return. Found nine times in this suite during the
  // D47 audit; records nothing and reports pass.
  test('early return, asserts nothing', ['D47'], async (t) => {
    const impossible = { status: 404 };
    if (impossible.status !== 201) return;
    t.ok(true, { ref: 'D47', what: 'unreachable' });
  });

  // Shape 2: every assertion reachable only inside a loop over a collection
  // that turns out to be empty.
  test('empty loop, asserts nothing', ['D47'], async (t) => {
    for (const item of []) t.ok(true, { ref: 'D47', what: 'unreachable', actual: item });
  });

  // Control: a check that really does assert must still pass, or the guard is
  // just failing everything.
  test('a genuine assertion still passes', ['D47'], async (t) => {
    t.ok(true, { ref: 'D47', what: 'a real assertion' });
  });
});

const out = await runAll({ only: 'runner vacuity self test' });
const byName = new Map((out && out.results ? out.results : []).map((r) => [r.test.name, r.state]));
const expected = [
  ['early return, asserts nothing', 'FAIL'],
  ['empty loop, asserts nothing', 'FAIL'],
  ['a genuine assertion still passes', 'pass'],
];
let bad = 0;
for (const [name, want] of expected) {
  const got = byName.get(name);
  const okOne = got === want;
  if (!okOne) bad += 1;
  console.log(`${okOne ? 'PASS' : 'FAIL'}  ${name}: expected ${want}, got ${got}`);
}
console.log(bad === 0 ? '\nthe zero-assertion guard fires on both vacuity shapes' : `\n${bad} failure(s)`);
process.exit(bad === 0 ? 0 : 1);
