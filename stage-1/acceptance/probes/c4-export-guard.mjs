// Criterion 12 (as restated after C4) and D44, derived from the decisions
// rather than from whatever the guard happens to be implemented as.
//
// Criterion 12: derive the check from what the export EMITS, not from what
// serializeState() reads; fail if an emptyState() key is neither emitted nor
// excluded; demonstrate the failure on BOTH shapes -- a key nothing touches,
// and a key read and dropped.
//
// D44: an exclusion entry's value must name a field the export actually
// emits, and the guard must fail when that named field is absent from the
// output. A free-text comment is a hand-maintained list with prose in it.
//
// Written against the decisions before the fix exists, so it is a check the
// fix has to satisfy rather than a description of what the fix did.
//
//   node stage-1/acceptance/probes/c4-export-guard.mjs /path/to/stage-1
//
// Exits 0 when every assertion holds, 1 otherwise.
import { createRequire } from 'node:module';
import path from 'node:path';

const root = path.resolve(process.argv[2] || 'stage-1');
const require = createRequire(path.join(root, 'src/'));
const { checkExportCoverage, EXCLUSIONS } = require(path.join(root, 'src/lib/exportGuard.js'));
const { serializeState } = require(path.join(root, 'src/routes/testExport.js'));
const { Store } = require(path.join(root, 'src/store.js'));

const emptyState = () => new Store().state;
let failures = 0;
const check = (name, condition, detail) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : `\n      ${detail}`}`);
  if (!condition) failures += 1;
};
// checkExportCoverage's third argument is the exclusion map at 3d00527. A fix
// may change the shape; fall back to the module default when it is not taken.
const coverage = (emptyFn, serializeFn, exclusions) => {
  try { return checkExportCoverage(emptyFn, serializeFn, exclusions); }
  catch (err) { return { ok: false, missing: [`guard threw: ${err.message}`] }; }
};

// Baseline. If the shipped serializer does not pass, nothing below means anything.
check('baseline: the guard passes on the shipped serializeState',
  coverage(emptyState, serializeState).ok,
  'baseline broken; the rest of this probe proves nothing');

// --- criterion 12, shape one: a key nothing touches ---------------------
{
  const withNew = () => ({ ...emptyState(), brandNewLedger: new Map() });
  const r = coverage(withNew, serializeState);
  check('criterion 12 shape 1: a key serializeState never touches is caught and named',
    !r.ok && r.missing.includes('brandNewLedger'), JSON.stringify(r.missing));
}

// --- criterion 12, shape two: read, then dropped (C4 itself) ------------
{
  const readsAndDrops = (state) => {
    const out = serializeState(state);
    const ignored = state.splits;   // read...
    void ignored;                   // ...and dropped
    delete out.splits;              // never reaches the caller
    return out;
  };
  const r = coverage(emptyState, readsAndDrops);
  check('criterion 12 shape 2 (C4): a key READ but absent from the emitted export is caught',
    !r.ok && r.missing.includes('splits'),
    `guard ok=${r.ok}, missing=${JSON.stringify(r.missing)} -- read-tracking reports a key `
    + 'that never reaches the output as covered');
}

// A third shape, mine: emitted but empty-by-construction must still count as
// emitted. Guards against a fix that over-corrects and calls an empty
// collection "not exported", which would fail on today's legitimately empty
// splits and settlements.
{
  const r = coverage(emptyState, serializeState);
  check('an emitted key whose value is legitimately empty still counts as exported',
    r.ok, `the shipped serializer emits splits/settlements/idempotency as [] and must pass: ${JSON.stringify(r.missing)}`);
}

// --- D44: the exclusion value must name a field the export emits --------
{
  const emitted = new Set(Object.keys(serializeState(emptyState())));
  // The rebuild source named in each exclusion, e.g. "users[]" or "users[].tokens",
  // reduced to its top-level exported field name.
  const namedField = (why) => {
    const m = /([A-Za-z_][A-Za-z0-9_]*)\s*\[\]/.exec(String(why));
    return m ? m[1] : null;
  };
  const unnamed = Object.entries(EXCLUSIONS).filter(([, why]) => namedField(why) === null);
  check('D44: every exclusion entry names a rebuild source field',
    unnamed.length === 0, JSON.stringify(unnamed));

  const dangling = Object.entries(EXCLUSIONS)
    .map(([k, why]) => [k, namedField(why)])
    .filter(([, field]) => field !== null && !emitted.has(field));
  check('D44: every named rebuild source is a field the export actually emits',
    dangling.length === 0,
    `named but not emitted: ${JSON.stringify(dangling)}; export emits ${JSON.stringify([...emitted])}`);
}

// --- D44: a bare exclusion must not silence the guard -------------------
{
  const withSecret = () => ({ ...emptyState(), secretLedger: new Map() });
  const silenced = coverage(withSecret, serializeState, { ...EXCLUSIONS, secretLedger: 'no reason given' });
  check('D44: an exclusion entry naming no source field does not silence the guard',
    !silenced.ok,
    'adding one prose line to EXCLUSIONS hides a key with no stated rebuild source -- '
    + 'the failure mode D37 named and D44 closes');
}
{
  const withSecret = () => ({ ...emptyState(), secretLedger: new Map() });
  const dangled = coverage(withSecret, serializeState, { ...EXCLUSIONS, secretLedger: 'rebuilt from nowhere[]' });
  check('D44: an exclusion naming a field the export does not emit does not silence the guard',
    !dangled.ok,
    'an exclusion may cite any invented field name and still pass');
}

console.log(`\n${failures === 0 ? 'criterion 12 and D44 satisfied' : `${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
