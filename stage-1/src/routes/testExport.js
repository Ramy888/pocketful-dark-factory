'use strict';

const { AppError } = require('../lib/errors');
const { sendJson, sendNoContent } = require('../lib/http');
const { toIso } = require('../lib/time');
const { canonicalize, mapKey } = require('../lib/idempotency');

// §10. Unauthenticated, like reset (R10.1). D16: a full serialisation of
// the store -- every field a later item adds to state belongs here too, so
// this function is expected to grow with the store rather than be
// revisited per item.
function serializeState(state) {
  return {
    currency: state.currency,
    minor_units: state.minorUnits,
    seeded_total: state.seededTotal,
    users: [...state.usersById.values()].map((u) => ({
      id: u.id,
      email: u.email,
      password_hash: u.passwordHash,
      display_name: u.displayName,
      handle: u.handle,
      balance: u.balance,
      tokens: [...u.tokens],
    })),
    payments: [...state.payments.values()].map((p) => ({
      id: p.id,
      from_user_id: p.fromUserId,
      to_user_id: p.toUserId,
      amount: p.amount,
      note: p.note,
      visibility: p.visibility,
      request_id: p.requestId,
      settlement_id: p.settlementId,
      created_at: toIso(p.createdAt),
      sequence: p.sequence,
    })),
    requests: [...state.requests.values()].map((r) => ({
      id: r.id,
      requester_id: r.requesterId,
      payer_id: r.payerId,
      amount: r.amount,
      note: r.note,
      status: r.status,
      payment_id: r.paymentId,
      created_at: toIso(r.createdAt),
      sequence: r.sequence,
    })),
    settlement_operator_ids: [...state.operatorIds],
    // D30: splits now has real content (W8); mapped like payments/requests
    // above rather than passed through raw. Requests are referenced by id,
    // not embedded -- they already have their own top-level export entry,
    // and re-embedding a duplicate copy here (frozen at split-creation
    // time) would drift from the live status a later payment can produce.
    splits: [...state.splits.values()].map((s) => ({
      id: s.id,
      caller_id: s.callerId,
      amount: s.amount,
      note: s.note,
      shares: s.shares,
      request_ids: s.requestIds,
      created_at: toIso(s.createdAt),
      sequence: s.sequence,
    })),
    // settlements is still empty ahead of W10; the same "not populated
    // yet" reasoning D30 already accepted for splits applies here too.
    settlements: [...state.settlements.values()],
    // R10.11/R11.19: every completed idempotent request's original body and
    // response, so import restores retries exactly (R10.13/R10.14).
    idempotency: [...state.idempotency.values()].map((r) => ({
      user_id: r.userId,
      key: r.key,
      method: r.method,
      path: r.path,
      body: JSON.parse(r.bodyCanonical),
      status: r.status,
      response: r.responseBody,
    })),
    sequence_counter: state.sequenceCounter,
  };
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// The exact inverse of serializeState: rebuilds emptyState()'s shape field
// for field from an exported `state` object. R10.3/R10.12: state is opaque
// and nothing here is regenerated -- ids, timestamps and sequence numbers
// are taken verbatim from the export, not re-minted, and a stored password
// hash is restored as the string it already is, never re-hashed from a
// plaintext that was never exported in the first place (R6.11).
//
// Throws (a plain Error, not AppError) on any structurally invalid input --
// a missing array, a record missing a field a later step reads -- so the
// caller can convert every such failure into one 422 validation_failed
// without this function needing to hand-validate each field's shape
// itself. Building the whole state before returning is what makes the
// route's replace atomic: nothing here mutates the live store.
function deserializeState(raw) {
  if (!isPlainObject(raw)) throw new Error('state must be an object');
  if (!Array.isArray(raw.users)) throw new Error('state.users must be an array');
  if (!Array.isArray(raw.payments)) throw new Error('state.payments must be an array');
  if (!Array.isArray(raw.requests)) throw new Error('state.requests must be an array');
  if (!Array.isArray(raw.splits)) throw new Error('state.splits must be an array');
  if (!Array.isArray(raw.settlement_operator_ids)) throw new Error('state.settlement_operator_ids must be an array');
  if (!Array.isArray(raw.idempotency)) throw new Error('state.idempotency must be an array');

  const usersById = new Map();
  const usersByHandle = new Map();
  const usersByEmail = new Map();
  const tokensByValue = new Map();
  for (const u of raw.users) {
    if (!isPlainObject(u) || typeof u.id !== 'string' || typeof u.handle !== 'string' || typeof u.email !== 'string') {
      throw new Error('invalid user record');
    }
    const record = {
      id: u.id,
      email: u.email,
      passwordHash: u.password_hash,
      displayName: u.display_name,
      handle: u.handle,
      balance: u.balance,
      tokens: new Set(u.tokens),
    };
    usersById.set(record.id, record);
    usersByHandle.set(record.handle, record);
    usersByEmail.set(record.email, record);
    for (const t of record.tokens) tokensByValue.set(t, record.id);
  }

  const payments = new Map();
  for (const p of raw.payments) {
    if (!isPlainObject(p) || typeof p.id !== 'string') throw new Error('invalid payment record');
    payments.set(p.id, {
      id: p.id,
      fromUserId: p.from_user_id,
      toUserId: p.to_user_id,
      amount: p.amount,
      note: p.note,
      visibility: p.visibility,
      requestId: p.request_id,
      settlementId: p.settlement_id,
      createdAt: new Date(p.created_at),
      sequence: p.sequence,
    });
  }

  const requests = new Map();
  for (const r of raw.requests) {
    if (!isPlainObject(r) || typeof r.id !== 'string') throw new Error('invalid request record');
    requests.set(r.id, {
      id: r.id,
      requesterId: r.requester_id,
      payerId: r.payer_id,
      amount: r.amount,
      note: r.note,
      status: r.status,
      paymentId: r.payment_id,
      createdAt: new Date(r.created_at),
      sequence: r.sequence,
    });
  }

  const splits = new Map();
  for (const s of raw.splits) {
    if (!isPlainObject(s) || typeof s.id !== 'string' || !Array.isArray(s.request_ids) || !Array.isArray(s.shares)) {
      throw new Error('invalid split record');
    }
    splits.set(s.id, {
      id: s.id,
      callerId: s.caller_id,
      amount: s.amount,
      note: s.note,
      shares: s.shares,
      requestIds: s.request_ids,
      createdAt: new Date(s.created_at),
      sequence: s.sequence,
    });
  }

  // W10 gives settlements real content; nothing produces any yet (R11.19
  // is carried to W10, D61b), so this stays an empty reconstruction, same
  // reasoning D30 already accepted for the export side.
  const settlements = new Map();

  const idempotency = new Map();
  for (const rec of raw.idempotency) {
    if (!isPlainObject(rec) || typeof rec.user_id !== 'string' || typeof rec.key !== 'string') {
      throw new Error('invalid idempotency record');
    }
    idempotency.set(mapKey(rec.user_id, rec.key, rec.method, rec.path), {
      userId: rec.user_id,
      key: rec.key,
      method: rec.method,
      path: rec.path,
      bodyCanonical: JSON.stringify(canonicalize(rec.body)),
      status: rec.status,
      responseBody: rec.response,
    });
  }

  if (typeof raw.sequence_counter !== 'number') throw new Error('state.sequence_counter must be a number');

  return {
    currency: raw.currency,
    minorUnits: raw.minor_units,
    seededTotal: raw.seeded_total,
    usersById,
    usersByHandle,
    usersByEmail,
    payments,
    requests,
    splits,
    settlements,
    operatorIds: new Set(raw.settlement_operator_ids),
    idempotency,
    tokensByValue,
    sequenceCounter: raw.sequence_counter,
  };
}

function registerTestExportRoutes(router, store) {
  router.add('GET', '/_test/export', async (req, res) => {
    sendJson(res, 200, {
      track: 'pocketful',
      format_version: 1,
      state: serializeState(store.state),
    });
  });

  // R10.4/R10.8: takes the entire exported object, atomically replaces
  // state, 204. track/format_version/state-shape problems are 422
  // validation_failed without touching the destination -- deserializeState
  // is built to fail before store.replace is ever called, not partway
  // through it, so a bad import can never leave a half-built state live.
  router.add('POST', '/_test/import', async (req, res) => {
    const body = req.jsonBody;
    if (body.track !== 'pocketful') throw new AppError(422, 'validation_failed', 'unrecognised track');
    if (body.format_version !== 1) throw new AppError(422, 'validation_failed', 'unsupported format_version');
    if (!isPlainObject(body.state)) throw new AppError(422, 'validation_failed', 'state must be a JSON object');

    let newState;
    try {
      newState = deserializeState(body.state);
    } catch {
      throw new AppError(422, 'validation_failed', 'state is not a valid exported state');
    }

    store.replace(newState);
    sendNoContent(res, 204);
  });
}

module.exports = { registerTestExportRoutes, serializeState, deserializeState };
