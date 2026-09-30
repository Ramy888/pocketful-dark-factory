'use strict';

const { AppError } = require('../lib/errors');
const { sendJson } = require('../lib/http');
const { toIso } = require('../lib/time');
const { requireAuth } = require('../lib/auth');
const { runIdempotent } = require('../lib/idempotency');
const { checkAmount, checkNote } = require('../lib/money');
const { serializeRequest } = require('./requests');

// R8.28/R5.2: absent is 422 (required field), a present wrong-typed value
// (not an array, or containing a non-string element) is 400 -- the general
// rule, since participant_handles is not one of R5.10's carved-out fields.
function requireParticipantHandles(body) {
  const v = body.participant_handles;
  if (v === undefined) throw new AppError(422, 'validation_failed', 'participant_handles is required');
  if (!Array.isArray(v)) throw new AppError(400, 'malformed_request', 'participant_handles must be an array');
  for (const h of v) {
    if (typeof h !== 'string') throw new AppError(400, 'malformed_request', 'participant_handles must contain only strings');
  }
  return v;
}

// R9.1/R9.2: every share is floor(amount / n); the remainder (amount mod n)
// gives one extra minor unit each to the first `remainder` participants in
// the order given. All of §9's table falls out of this one rule.
function computeShares(amount, handles) {
  const n = handles.length;
  const base = Math.floor(amount / n);
  const remainder = amount - base * n;
  return handles.map((handle, i) => ({ handle, amount: base + (i < remainder ? 1 : 0) }));
}

function serializeSplit(store, split) {
  return {
    split_id: split.id,
    amount: split.amount,
    currency: store.state.currency,
    note: split.note,
    shares: split.shares,
    // R8.30/criterion 13: each element is a full request object, read live
    // rather than frozen at split-creation time -- a split request already
    // paid through POST /requests/{id}/pay must show that status here too.
    requests: split.requestIds.map((id) => {
      const r = store.state.requests.get(id);
      const requester = store.state.usersById.get(r.requesterId);
      const payer = store.state.usersById.get(r.payerId);
      return serializeRequest(store, r, requester, payer);
    }),
    created_at: toIso(split.createdAt),
  };
}

function registerSplitsRoutes(router, store) {
  router.add('POST', '/splits', async (req, res) => {
    const user = requireAuth(req, store);
    const rawKey = req.headers['idempotency-key'];
    const body = req.jsonBody;

    // D22: key resolution -> field validation 422 (amount, note,
    // participant_handles' shape, non-empty, no duplicate -- D22/criterion
    // 7: an array-internal check like a duplicate handle counts as field
    // validation and so precedes resource resolution, which is why
    // ["ghost","ghost"] is 422 for the duplicate, never 404) -> resource
    // resolution 404 (each handle must exist). §8 states plainly that
    // nothing about a split checks a balance, so there is no funds step.
    const result = runIdempotent(
      store,
      { user, method: req.method, path: req.pathname, rawKey, body },
      () => {
        const amount = checkAmount(body);
        const note = checkNote(body);
        const handles = requireParticipantHandles(body);
        if (handles.length === 0) throw new AppError(422, 'validation_failed', 'participant_handles must not be empty');

        const seen = new Set();
        for (const h of handles) {
          if (seen.has(h)) throw new AppError(422, 'validation_failed', `duplicate participant handle: ${h}`);
          seen.add(h);
        }

        const participants = handles.map((h) => {
          const u = store.state.usersByHandle.get(h);
          if (!u) throw new AppError(404, 'not_found', `no user with handle ${h}`);
          return u;
        });

        const shares = computeShares(amount, handles);
        const now = new Date();

        // R8.29/R4.15: a request for every participant except the caller,
        // in the same order, each for that participant's share -- a share
        // of 0 is legal and still produces one (R9.4/criterion 5).
        const requestIds = [];
        for (let i = 0; i < participants.length; i += 1) {
          if (participants[i].id === user.id) continue;
          const rid = store.nextId('rq');
          store.state.requests.set(rid, {
            id: rid,
            requesterId: user.id,
            payerId: participants[i].id,
            amount: shares[i].amount,
            note,
            status: 'pending',
            paymentId: null,
            createdAt: now,
            sequence: store.nextSequence(),
          });
          requestIds.push(rid);
        }

        const splitId = store.nextId('sp');
        const split = {
          id: splitId,
          callerId: user.id,
          amount,
          note,
          shares,
          requestIds,
          createdAt: now,
          sequence: store.nextSequence(),
        };
        store.state.splits.set(splitId, split);

        return { status: 201, body: serializeSplit(store, split) };
      },
    );

    sendJson(res, result.status, result.body);
  });
}

module.exports = { registerSplitsRoutes, serializeSplit };
