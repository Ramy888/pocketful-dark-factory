'use strict';

const { AppError } = require('../lib/errors');
const { sendJson } = require('../lib/http');
const { toIso } = require('../lib/time');
const { requireAuth } = require('../lib/auth');
const { runIdempotent } = require('../lib/idempotency');
const { checkAmount, checkNote, checkVisibility } = require('../lib/money');
const { parseLimit, parseOffset } = require('../lib/pagination');
const { serializePayment } = require('./payments');

const VALID_STATUSES = new Set(['pending', 'paid', 'declined', 'cancelled']);
const VALID_DIRECTIONS = new Set(['incoming', 'outgoing']);

// Same convention as to_handle at W5: absent is 422 (R5.8), a present
// wrong-typed value is 400 (R5.2) -- payer_handle is not one of R5.10's
// carved-out fields.
function requirePayerHandle(body) {
  const v = body.payer_handle;
  if (v === undefined) throw new AppError(422, 'validation_failed', 'payer_handle is required');
  if (typeof v !== 'string') throw new AppError(400, 'malformed_request', 'payer_handle must be a string');
  return v;
}

function serializeRequest(store, request, requesterUser, payerUser) {
  return {
    request_id: request.id,
    requester_id: requesterUser.id,
    requester_handle: requesterUser.handle,
    payer_id: payerUser.id,
    payer_handle: payerUser.handle,
    amount: request.amount,
    currency: store.state.currency,
    note: request.note,
    status: request.status,
    payment_id: request.paymentId,
    created_at: toIso(request.createdAt),
  };
}

function resolveRequest(store, requestId) {
  const request = store.state.requests.get(requestId);
  if (!request) throw new AppError(404, 'not_found', 'no such request');
  return request;
}

function registerRequestsRoutes(router, store) {
  router.add('POST', '/requests', async (req, res) => {
    const user = requireAuth(req, store);
    const rawKey = req.headers['idempotency-key'];
    const body = req.jsonBody;

    // D22, specialised: key resolution (runIdempotent) -> field validation
    // 422 (payer_handle's shape, amount, note, then self_request -- a
    // plain string comparison against the caller's own handle, no lookup
    // needed, same reasoning as self_payment at W5) -> resource resolution
    // 404 (the payer_handle lookup). R8.15: no funds check at creation.
    const result = runIdempotent(
      store,
      { user, method: req.method, path: req.pathname, rawKey, body },
      () => {
        const payerHandle = requirePayerHandle(body);
        const amount = checkAmount(body);
        const note = checkNote(body);

        if (payerHandle === user.handle) {
          throw new AppError(422, 'self_request', 'cannot request money from yourself');
        }

        const payer = store.state.usersByHandle.get(payerHandle);
        if (!payer) throw new AppError(404, 'not_found', 'no user with that handle');

        const id = store.nextId('rq');
        const request = {
          id,
          requesterId: user.id,
          payerId: payer.id,
          amount,
          note,
          status: 'pending',
          paymentId: null,
          createdAt: new Date(),
          sequence: store.nextSequence(),
        };
        store.state.requests.set(id, request);

        return { status: 201, body: serializeRequest(store, request, user, payer) };
      },
    );

    sendJson(res, result.status, result.body);
  });

  router.add('POST', '/requests/:id/pay', async (req, res, params) => {
    const user = requireAuth(req, store);
    const rawKey = req.headers['idempotency-key'];
    const body = req.jsonBody;

    // D22: key resolution -> field validation 422 (visibility, the only
    // field this body carries) -> resource resolution 404 -> resource-level
    // authorisation 403 (D13: a known request with the wrong caller is
    // 403, not a privacy-driven 404) -> state 409 (D24: a terminal request
    // is request_not_pending whatever the balance, checked before funds --
    // the sharp case is a payer who spent its last funds paying this
    // request and retries under a fresh key against an empty wallet; state
    // answers first, so funds are never asked about a request that could
    // not have moved money at any balance) -> funds 409.
    //
    // R8.19's replay exception (a successful pay replayed after the
    // request is already paid still returns 200, never
    // request_not_pending) needs no special code here: runIdempotent
    // resolves a claimed key before this handler ever runs again, so the
    // state check below is never reached on a replay.
    const result = runIdempotent(
      store,
      { user, method: req.method, path: req.pathname, rawKey, body },
      () => {
        const visibility = checkVisibility(body);
        const request = resolveRequest(store, params.id);
        if (request.payerId !== user.id) throw new AppError(403, 'forbidden', 'only the payer may pay this request');
        if (request.status !== 'pending') throw new AppError(409, 'request_not_pending', 'request is not pending');

        const payer = user;
        const requester = store.state.usersById.get(request.requesterId);
        if (payer.balance < request.amount) {
          throw new AppError(409, 'insufficient_funds', "balance is below the request's amount");
        }

        payer.balance -= request.amount;
        requester.balance += request.amount;

        const paymentId = store.nextId('p');
        const payment = {
          id: paymentId,
          fromUserId: payer.id,
          toUserId: requester.id,
          amount: request.amount,
          // The pay body carries only visibility (R8.16) -- the settling
          // payment's note comes from the request it settles, not from
          // this body, so the receipt still says why the money moved.
          note: request.note,
          visibility,
          requestId: request.id,
          settlementId: null,
          createdAt: new Date(),
          sequence: store.nextSequence(),
        };
        store.state.payments.set(paymentId, payment);

        request.status = 'paid';
        request.paymentId = paymentId;

        return { status: 201, body: serializePayment(store, payment, payer, requester) };
      },
    );

    sendJson(res, result.status, result.body);
  });

  router.add('POST', '/requests/:id/decline', async (req, res, params) => {
    // R8.20: no idempotency key. Idempotent by its own status logic
    // instead: declining an already-declined request is 200, not a second
    // state transition.
    const user = requireAuth(req, store);
    const request = resolveRequest(store, params.id);
    if (request.payerId !== user.id) throw new AppError(403, 'forbidden', 'only the payer may decline this request');
    if (request.status === 'pending') request.status = 'declined';
    else if (request.status !== 'declined') throw new AppError(409, 'request_not_pending', 'request is not pending');

    const requester = store.state.usersById.get(request.requesterId);
    sendJson(res, 200, serializeRequest(store, request, requester, user));
  });

  router.add('POST', '/requests/:id/cancel', async (req, res, params) => {
    // R8.21: no idempotency key, same idempotent-by-status shape as decline.
    const user = requireAuth(req, store);
    const request = resolveRequest(store, params.id);
    if (request.requesterId !== user.id) throw new AppError(403, 'forbidden', 'only the requester may cancel this request');
    if (request.status === 'pending') request.status = 'cancelled';
    else if (request.status !== 'cancelled') throw new AppError(409, 'request_not_pending', 'request is not pending');

    const payer = store.state.usersById.get(request.payerId);
    sendJson(res, 200, serializeRequest(store, request, user, payer));
  });

  router.add('GET', '/requests', async (req, res) => {
    const user = requireAuth(req, store);

    const directionRaw = req.query.get('direction');
    if (directionRaw !== null && !VALID_DIRECTIONS.has(directionRaw)) {
      throw new AppError(422, 'validation_failed', 'direction must be "incoming" or "outgoing"');
    }
    const statusRaw = req.query.get('status');
    if (statusRaw !== null && !VALID_STATUSES.has(statusRaw)) {
      throw new AppError(422, 'validation_failed', 'status must be one of pending, paid, declined, cancelled');
    }
    const limit = parseLimit(req.query);
    const offset = parseOffset(req.query);

    // R8.22/R4.14: only requests where the caller is requester or payer.
    // D9: unlike /activity (R8.36's exemption), a same-second tie here is
    // broken deterministically by the creation sequence -- required, not
    // merely available.
    const visible = [...store.state.requests.values()]
      .filter((r) => r.requesterId === user.id || r.payerId === user.id)
      .filter((r) => {
        if (directionRaw === 'incoming') return r.payerId === user.id;
        if (directionRaw === 'outgoing') return r.requesterId === user.id;
        return true;
      })
      .filter((r) => statusRaw === null || r.status === statusRaw)
      .sort((a, b) => b.createdAt - a.createdAt || b.sequence - a.sequence);

    const page = visible.slice(offset, offset + limit);
    const requests = page.map((r) => {
      const requester = store.state.usersById.get(r.requesterId);
      const payer = store.state.usersById.get(r.payerId);
      return serializeRequest(store, r, requester, payer);
    });

    sendJson(res, 200, { requests, has_more: offset + limit < visible.length });
  });
}

module.exports = { registerRequestsRoutes, serializeRequest };
