'use strict';

// The single owner of all mutable service state. `state` is replaced
// wholesale, in one synchronous step, by reset (and later import) so a
// partially-built state is never observable to a concurrent request.
function emptyState() {
  return {
    currency: null,
    minorUnits: null,
    seededTotal: 0,
    usersById: new Map(),
    usersByHandle: new Map(),
    usersByEmail: new Map(),
    payments: new Map(),
    requests: new Map(),
    splits: new Map(),
    settlements: new Map(),
    operatorIds: new Set(),
    idempotency: new Map(),
    tokensByValue: new Map(),
    idCounter: 0,
    sequenceCounter: 0,
  };
}

class Store {
  constructor() {
    this.state = emptyState();
  }

  replace(newState) {
    this.state = newState;
  }

  // Monotonic tie-break for newest-first ordering (D9).
  nextSequence() {
    this.state.sequenceCounter += 1;
    return this.state.sequenceCounter;
  }

  // Opaque id for a server-created resource, <= 64 chars (§3.4).
  nextId(prefix) {
    this.state.idCounter += 1;
    return `${prefix}_${this.state.idCounter}`;
  }
}

module.exports = { Store, emptyState };
