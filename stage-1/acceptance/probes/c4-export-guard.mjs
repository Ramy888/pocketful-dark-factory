// C4 — does the D30 export-coverage guard check EXPORT, or only READ?
//
// D30/criterion 12: "fail if a key is neither exported nor on a commented
// exclusion list". The guard at 3d00527 records which top-level keys
// serializeState() *reads*, via a Proxy. A key that is read and then dropped
// satisfies read-tracking and fails the criterion. This script runs the
// direct test rather than arguing about it.
//
//   node stage-1/acceptance/probes/c4-export-guard.mjs /path/to/stage-1
//
// Exits 0 when the guard catches a read-but-unexported key, 1 when it does not.
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

// Baseline: the shipped serializer must pass, or the probe proves nothing.
check('the guard passes on the shipped serializeState',
  checkExportCoverage(emptyState, serializeState).ok,
  'baseline broken; the rest of this probe is meaningless');

// A key nothing touches must be named. This is the case the guard does catch.
{
  const withNew = () => ({ ...emptyState(), brandNewLedger: new Map() });
  const r = checkExportCoverage(withNew, serializeState);
  check('a key serializeState never touches is reported and named',
    !r.ok && r.missing.includes('brandNewLedger'), JSON.stringify(r.missing));
}

// C4 itself: read into a local, dropped from the output.
{
  const readsAndDrops = (state) => {
    const out = serializeState(state);
    const ignored = state.splits;   // read...
    void ignored;                   // ...and dropped
    delete out.splits;              // never reaches the caller
    return out;
  };
  const r = checkExportCoverage(emptyState, readsAndDrops);
  check('C4: a key READ but absent from the emitted export is caught',
    !r.ok && r.missing.includes('splits'),
    `guard ok=${r.ok}, missing=${JSON.stringify(r.missing)} -- the Proxy recorded the read, `
    + 'so a key that never reaches the output is reported as covered');
}

// D37 as ruled: every exclusion entry names the exported field import rebuilds from.
{
  const unnamed = Object.entries(EXCLUSIONS).filter(([, why]) => !/\w+\[\]/.test(why));
  check('every exclusion entry names its rebuild source', unnamed.length === 0, JSON.stringify(unnamed));
}

console.log(`\n${failures === 0 ? 'guard meets criterion 12' : `${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
