'use strict';

// D30: every emptyState() key must be visible through serializeState()'s
// export, or carry an explicit, reasoned exclusion. Derived from actual
// property access -- a Proxy records every top-level key serializeState()
// reads while producing the export -- rather than a hand-maintained list
// of "fields to remember to export". A hand-written list only guards what
// someone remembered to add, which is exactly how splits, settlements and
// idempotency went unexported until this was built.
const EXCLUSIONS = {
  usersByHandle: 'derived index; import can rebuild it from users[]',
  usersByEmail: 'derived index; import can rebuild it from users[]',
  tokensByValue: 'derived index; import can rebuild it from users[].tokens',
};

function accessedTopLevelKeys(serializeState, sampleState) {
  const accessed = new Set();
  const proxy = new Proxy(sampleState, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(target, prop)) {
        accessed.add(prop);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  serializeState(proxy);
  return accessed;
}

// Returns { ok, missing, keys, accessed }. `missing` is every emptyState()
// key that serializeState() never read while exporting and that carries no
// exclusion entry -- the set that must be empty for the export to be trusted.
function checkExportCoverage(emptyState, serializeState, exclusions = EXCLUSIONS) {
  const keys = Object.keys(emptyState());
  const accessed = accessedTopLevelKeys(serializeState, emptyState());
  const missing = keys.filter((k) => !accessed.has(k) && !Object.prototype.hasOwnProperty.call(exclusions, k));
  return { ok: missing.length === 0, missing, keys, accessed: [...accessed] };
}

module.exports = { checkExportCoverage, accessedTopLevelKeys, EXCLUSIONS };
