'use strict';

const crypto = require('crypto');

// D30: every emptyState() key must actually reach GET /_test/export's
// output, or carry an explicit, reasoned exclusion. Derived from what
// serializeState() emits, not from a hand-maintained list of "fields to
// remember to export" -- a hand-written list only guards what someone
// remembered to add, which is exactly how splits, settlements and
// idempotency went unexported until this was built.
//
// C4 (verifier finding on the first version of this guard): reading a key
// is not the same claim as emitting it. A key read into a local and then
// dropped from the returned object satisfies read-tracking and slips
// through. This version replaces each key's value with a probe and checks
// whether the probe actually surfaces in serializeState()'s *output*,
// which a mere property read cannot fake.
const EXCLUSIONS = {
  usersByHandle: 'derived index; import can rebuild it from users[]',
  usersByEmail: 'derived index; import can rebuild it from users[]',
  tokensByValue: 'derived index; import can rebuild it from users[].tokens',
};

function randomToken() {
  return crypto.randomBytes(6).toString('hex');
}

// A value that answers every read with the same marker, however deep the
// access chain goes, so it survives an unknown field-mapping shape without
// the caller needing to know that shape in advance:
//   - JSON.stringify resolves it via toJSON before inspecting its own
//     properties, so it renders as the marker string wherever it lands as
//     an object property or array element (the payments/requests/idempotency
//     mappers' case).
//   - toISOString/toString/valueOf/Symbol.toPrimitive cover code that treats
//     the field as date-like or coerces it directly (created_at via toIso).
//   - Symbol.iterator makes it a safe (empty) spread target, so a mapper
//     that does `[...record.someCollection]` does not throw.
//   - any other property access recurses into another probe with the same
//     marker, so an arbitrarily deep, unknown field-mapping chain still
//     bottoms out at a leaf that renders as the marker.
function makeProbe(marker) {
  // JSON.parse(someField) is a real thing this codebase does (the
  // idempotency mapper does JSON.parse(r.bodyCanonical)): it coerces a
  // non-string argument via ToPrimitive/ToString first. A bare marker
  // string is not valid JSON and would throw there, so generic coercion
  // (toString/valueOf/Symbol.toPrimitive) hands back a *JSON string
  // literal* -- JSON.parse('"marker"') validly yields the plain marker
  // string back out, and that string still carries the marker substring
  // wherever it ends up.
  const target = {};
  const jsonSafeMarker = JSON.stringify(marker);
  const handler = {
    get(_t, prop) {
      if (prop === 'toJSON') return () => marker;
      if (prop === 'toISOString') return () => `${marker}T00:00:00.000Z`;
      if (prop === 'toString') return () => jsonSafeMarker;
      if (prop === 'valueOf') return () => jsonSafeMarker;
      if (prop === Symbol.toPrimitive) return () => jsonSafeMarker;
      if (prop === Symbol.iterator) return function* () {};
      if (prop === 'then') return undefined;
      return makeProbe(marker);
    },
  };
  return new Proxy(target, handler);
}

// Builds a perturbed copy of `original` (a value from emptyState()) that is
// structurally compatible with however serializeState() consumes it, paired
// with the marker that must show up in the output if this value is emitted.
function perturbValue(original) {
  const marker = `__export_probe_${randomToken()}__`;
  if (original instanceof Map) {
    const copy = new Map(original);
    copy.set(`__probe_key_${randomToken()}__`, makeProbe(marker));
    return { perturbed: copy, marker };
  }
  if (original instanceof Set) {
    const copy = new Set(original);
    copy.add(marker);
    return { perturbed: copy, marker };
  }
  if (typeof original === 'number') {
    const numericMarker = -(900000000 + Math.floor(Math.random() * 90000000));
    return { perturbed: numericMarker, marker: String(numericMarker) };
  }
  if (typeof original === 'string' || typeof original === 'boolean' || original === null || original === undefined) {
    return { perturbed: marker, marker };
  }
  // Unknown shape: fall back to the generic probe as the whole value.
  return { perturbed: makeProbe(marker), marker };
}

// True when replacing emptyState()[key] with a probe changes what
// serializeState() emits in a way that carries the probe's marker --
// i.e. the value is actually reachable from the export, not merely read
// on the way to being built.
function isEmitted(key, emptyState, serializeState) {
  const state = emptyState();
  const { perturbed, marker } = perturbValue(state[key]);
  state[key] = perturbed;
  let output;
  try {
    output = serializeState(state);
  } catch {
    // The probe could not flow through whatever this key's mapper does
    // without crashing it. That is not evidence of emission either way,
    // so this key still needs an explicit exclusion or a working export.
    return false;
  }
  let text;
  try {
    text = JSON.stringify(output);
  } catch {
    return false;
  }
  return typeof text === 'string' && text.includes(marker);
}

// D37 asked every exclusion's comment to name the field import rebuilds it
// from ("derived index; import can rebuild it from users[]"). D44: that is
// still just a convention someone has to follow -- an entry with no rebuild
// source at all ("secretLedger: 'no reason given'") silences the guard for
// that key with nothing checking the excuse. Extracts the `name[]` token an
// exclusion reason names, so the guard can confirm that field is a real
// top-level key in the shipped output rather than trusting the prose.
function exclusionRebuildField(reason) {
  const m = /(\w+)\[\]/.exec(String(reason));
  return m ? m[1] : null;
}

// Returns { ok, missing, keys, emitted, invalidExclusions }. `missing` is
// every emptyState() key that serializeState() does not actually emit and
// that carries no *valid* exclusion entry. `invalidExclusions` names any
// exclusion whose comment does not point at a field the export actually
// emits -- the set that must both be empty for the export to be trusted.
function checkExportCoverage(emptyState, serializeState, exclusions = EXCLUSIONS) {
  const keys = Object.keys(emptyState());
  const emitted = [];
  const missing = [];
  const invalidExclusions = [];
  const outputKeys = new Set(Object.keys(serializeState(emptyState())));
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(exclusions, key)) {
      const rebuildField = exclusionRebuildField(exclusions[key]);
      if (!rebuildField || !outputKeys.has(rebuildField)) {
        invalidExclusions.push(key);
        missing.push(key);
      }
      continue;
    }
    if (isEmitted(key, emptyState, serializeState)) emitted.push(key);
    else missing.push(key);
  }
  return { ok: missing.length === 0, missing, keys, emitted, invalidExclusions };
}

module.exports = { checkExportCoverage, isEmitted, EXCLUSIONS };
