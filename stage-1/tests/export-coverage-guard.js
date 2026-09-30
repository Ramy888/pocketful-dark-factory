'use strict';

// Durable evidence for D30(b), committed per D28.
//
// The guard is derived from what serializeState() actually emits (see
// src/lib/exportGuard.js), not from a hand-maintained list of fields
// someone has to remember to export, and not from merely reading a key
// either -- a key read into a local and then dropped from the output is
// not emission, per the verifier's C4 finding against the first version
// of this guard (probed permanently at
// stage-1/acceptance/probes/c4-export-guard.mjs). Three things are
// demonstrated:
//   1. today's real state shape passes -- every emptyState() key actually
//      surfaces in serializeState()'s output, or carries a commented
//      exclusion.
//   2. the guard fails, and names the field, when a key is added to state
//      but serializeState() is never told about it -- the exact failure
//      mode that let splits, settlements and idempotency go unexported.
//   3. C4 itself: a key that IS read but then dropped from the returned
//      object is still reported missing, unlike the read-tracking version.
//   4. D44: an exclusion whose comment names no real, currently-emitted
//      rebuild field does not silence the guard -- closing the hole the
//      verifier's advisory 2 named (an unreasoned exclusion entry passing
//      silently forever).

const { emptyState } = require('../src/store');
const { serializeState } = require('../src/routes/testExport');
const { checkExportCoverage, EXCLUSIONS } = require('../src/lib/exportGuard');

let passCount = 0;
let failCount = 0;
function assert(cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (cond) passCount++; else { failCount++; process.exitCode = 1; }
}

// ---- 1. today's shape must pass ----
const real = checkExportCoverage(emptyState, serializeState);
assert(real.ok, `every emptyState() key is exported or excluded (missing: ${JSON.stringify(real.missing)})`);
console.log(`NOTE  emitted keys: ${JSON.stringify(real.emitted)}`);
console.log(`NOTE  excluded keys: ${JSON.stringify(Object.keys(EXCLUSIONS))}`);
for (const k of Object.keys(EXCLUSIONS)) {
  assert(real.keys.includes(k), `exclusion "${k}" still names a real emptyState() key (a stale exclusion is a silent hole)`);
}

// ---- 2. demonstrate the guard failing: a field added to state, forgotten in export ----
// Scoped to this assertion only -- nothing is added to store.js, so there is
// nothing to remove afterward.
function emptyStateWithScratchField() {
  return { ...emptyState(), scratchField: 'not exported anywhere' };
}
const scratch = checkExportCoverage(emptyStateWithScratchField, serializeState);
assert(!scratch.ok, 'guard fails when a field exists on state but serializeState() never emits it');
assert(
  scratch.missing.length === 1 && scratch.missing[0] === 'scratchField',
  `guard names exactly the missing field (got ${JSON.stringify(scratch.missing)})`,
);

// ---- 3. C4: a key that IS read, then dropped from the output, must still be reported ----
// The verifier's permanent probe (acceptance/probes/c4-export-guard.mjs) checks this
// against the shipped serializeState directly; this repeats it inline against a
// synthetic serializer so the failure mode is pinned here too.
function readsAndDrops(state) {
  const out = serializeState(state);
  const ignored = state.splits; // read...
  void ignored;
  delete out.splits; // ...and dropped before it reaches the caller
  return out;
}
const c4 = checkExportCoverage(emptyState, readsAndDrops);
assert(
  !c4.ok && c4.missing.includes('splits'),
  `C4: a key read but absent from the emitted output is caught (got ok=${c4.ok}, missing=${JSON.stringify(c4.missing)})`,
);

// ---- 4. D44: an exclusion naming no real rebuild field does not silence the guard ----
// A key nothing touches, "excused" by a reason that names no field the
// export emits at all -- the exact "secretLedger: 'no reason given'" shape.
function emptyStateWithUnexcusedField() {
  return { ...emptyState(), secretLedger: new Map() };
}
const unreasoned = checkExportCoverage(emptyStateWithUnexcusedField, serializeState, {
  ...EXCLUSIONS,
  secretLedger: 'no reason given',
});
assert(
  !unreasoned.ok && unreasoned.invalidExclusions.includes('secretLedger') && unreasoned.missing.includes('secretLedger'),
  `D44: an exclusion with no real rebuild-source field does not silence the guard (got ok=${unreasoned.ok}, invalidExclusions=${JSON.stringify(unreasoned.invalidExclusions)})`,
);
// The converse: an exclusion naming a field that IS emitted still passes.
const reasoned = checkExportCoverage(emptyStateWithUnexcusedField, serializeState, {
  ...EXCLUSIONS,
  secretLedger: 'derived index; import can rebuild it from users[]',
});
assert(
  reasoned.invalidExclusions.length === 0 && !reasoned.missing.includes('secretLedger'),
  `D44: an exclusion naming a field the export does emit is accepted (got invalidExclusions=${JSON.stringify(reasoned.invalidExclusions)})`,
);

console.log(`\n${passCount} PASS, ${failCount} FAIL`);
