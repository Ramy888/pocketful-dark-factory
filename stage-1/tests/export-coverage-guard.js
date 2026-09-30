'use strict';

// Durable evidence for D30(b), committed per D28.
//
// The guard is derived from actual property access inside serializeState()
// (see src/lib/exportGuard.js) rather than a hand-maintained list of
// fields someone has to remember to export. Two things are demonstrated:
//   1. today's real state shape passes -- every emptyState() key is either
//      read by serializeState() or carries a commented exclusion.
//   2. the guard fails, and names the field, when a key is added to state
//      but serializeState() is never told about it -- the exact failure
//      mode that let splits, settlements and idempotency go unexported.

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
console.log(`NOTE  exported/derived keys: ${JSON.stringify(real.accessed)}`);
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
assert(!scratch.ok, 'guard fails when a field exists on state but serializeState() never reads it');
assert(
  scratch.missing.length === 1 && scratch.missing[0] === 'scratchField',
  `guard names exactly the missing field (got ${JSON.stringify(scratch.missing)})`,
);

console.log(`\n${passCount} PASS, ${failCount} FAIL`);
