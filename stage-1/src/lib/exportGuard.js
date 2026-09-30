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

// C8/criterion 13 (W9): checkExportCoverage only proves a *collection*
// reaches the export -- the `payments` key being emitted says nothing
// about whether every field of a payment survives the mapper. A field a
// mapper forgets would still pass every check above it while silently
// losing data on every export.
//
// The verifier built the naive version of this first: compare a live
// record's own keys against its exported counterpart's keys by exact
// string match. It fired on `idempotency`'s bodyCanonical/responseBody --
// correctly renamed (to body/response, content preserved), not dropped.
// A key-name-only comparison cannot tell rename from drop, and four of
// the five mappers here rename at least one field by the camelCase (Node
// internals) vs snake_case (the wire format) convention alone. So a plain
// key name is first normalised camelCase -> snake_case before comparing
// (which is not a rename this project makes a decision about, it is a
// mechanical fact of the two naming conventions in play), and only a
// genuine rename -- a different word, not just a different case
// convention -- needs an entry in `renames`, the same "the excuse must
// name something real" discipline D44 already applies one level up: a
// rename target that is not actually a key of the exported record still
// counts as missing.
const RECORD_RENAMES = {
  idempotency: { bodyCanonical: 'body', responseBody: 'response' },
};

function toSnakeCase(key) {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function fieldCovered(key, exportedKeys, collectionRenames) {
  if (exportedKeys.has(key) || exportedKeys.has(toSnakeCase(key))) return true;
  const target = collectionRenames[key];
  return !!target && exportedKeys.has(target);
}

// `state` must hold real records (from emptyState()'s Maps, e.g. built by
// exercising the real routes) -- this checks what those live records'
// *own* keys are, not a hypothetical shape. Records are matched to their
// exported counterpart by `id` for users/payments/requests/splits (both
// sides use `id` as the primary key); idempotency records carry no id, so
// they are matched positionally, which serializeState's [...map.values()]
// iteration keeps aligned with the live Map's own iteration order.
//
// Returns { ok, missing }. `missing` names every `collection.field` whose
// live value could not be found, under any allowed name, in its exported
// counterpart. An empty collection contributes nothing to check -- there
// is no live record to demand coverage of (settlements, pre-W10).
function checkRecordFieldCoverage(state, serializeState, renames = RECORD_RENAMES) {
  const exported = serializeState(state);
  const missing = [];

  function checkByOwnId(collection, liveMap) {
    const exportedById = new Map((exported[collection] || []).map((r) => [r.id, r]));
    const collectionRenames = renames[collection] || {};
    for (const live of liveMap.values()) {
      const exportedRecord = exportedById.get(live.id);
      const exportedKeys = new Set(Object.keys(exportedRecord || {}));
      for (const key of Object.keys(live)) {
        if (!fieldCovered(key, exportedKeys, collectionRenames)) missing.push(`${collection}.${key}`);
      }
    }
  }

  checkByOwnId('users', state.usersById);
  checkByOwnId('payments', state.payments);
  checkByOwnId('requests', state.requests);
  checkByOwnId('splits', state.splits);

  {
    const collectionRenames = renames.idempotency || {};
    const exportedList = exported.idempotency || [];
    [...state.idempotency.values()].forEach((live, i) => {
      const exportedKeys = new Set(Object.keys(exportedList[i] || {}));
      for (const key of Object.keys(live)) {
        if (!fieldCovered(key, exportedKeys, collectionRenames)) missing.push(`idempotency.${key}`);
      }
    });
  }

  return { ok: missing.length === 0, missing };
}

module.exports = {
  checkExportCoverage, isEmitted, EXCLUSIONS,
  checkRecordFieldCoverage, RECORD_RENAMES,
};
