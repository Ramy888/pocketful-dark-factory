'use strict';

const { AppError } = require('../lib/errors');
const { sendJson } = require('../lib/http');
const { toIso } = require('../lib/time');
const { requireAuth } = require('../lib/auth');
const { runIdempotent } = require('../lib/idempotency');
const { checkAmount, checkNote, checkVisibility } = require('../lib/money');
const { serializePayment } = require('./payments');

const MIN_TRANSFERS = 1;
const MAX_TRANSFERS = 32;

// Same convention as to_handle/payer_handle: absent is 422, a present
// wrong-typed value is 400 -- neither is one of R5.10's carved-out fields.
function requireHandleField(entry, field) {
  const v = entry[field];
  if (v === undefined) throw new AppError(422, 'validation_failed', `${field} is required`);
  if (typeof v !== 'string') throw new AppError(400, 'malformed_request', `${field} must be a string`);
  return v;
}

// R11.5/R11.7: the batch shape itself, before any entry is examined.
// Unlike to_handle/payer_handle elsewhere, R11.7 names "malformed batch
// shape" as its own 422 case rather than falling to the general R5.2
// wrong-type-is-400 rule -- confirmed against the acceptance suite, which
// expects 422 for transfers: "x"/5/true/null/{} alike, not just for a
// present-but-empty or oversized array.
function requireTransfers(body) {
  const v = body.transfers;
  if (v === undefined) throw new AppError(422, 'validation_failed', 'transfers is required');
  if (!Array.isArray(v)) throw new AppError(422, 'validation_failed', 'transfers must be an array');
  if (v.length < MIN_TRANSFERS || v.length > MAX_TRANSFERS) {
    throw new AppError(422, 'validation_failed', `transfers must contain ${MIN_TRANSFERS} to ${MAX_TRANSFERS} objects`);
  }
  for (const entry of v) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new AppError(422, 'validation_failed', 'each transfer must be an object');
    }
  }
  return v;
}

function serializeSettlement(store, settlement) {
  return {
    settlement_id: settlement.id,
    committed_at: toIso(settlement.committedAt),
    payments: settlement.paymentIds.map((id) => {
      const p = store.state.payments.get(id);
      const fromUser = store.state.usersById.get(p.fromUserId);
      const toUser = store.state.usersById.get(p.toUserId);
      return serializePayment(store, p, fromUser, toUser);
    }),
  };
}

function registerSettlementsRoutes(router, store) {
  router.add('POST', '/settlements', async (req, res) => {
    const user = requireAuth(req, store);
    // D15/criterion 16: the operator check is endpoint-level authorisation
    // (D22), which precedes idempotency-key resolution -- an authenticated
    // non-operator sending no Idempotency-Key still gets 403, not 400,
    // because this check runs before the key is ever examined.
    if (!store.state.operatorIds.has(user.id)) {
      throw new AppError(403, 'forbidden', 'settlement requires operator permission');
    }

    const rawKey = req.headers['idempotency-key'];
    const body = req.jsonBody;

    const result = runIdempotent(
      store,
      { user, method: req.method, path: req.pathname, rawKey, body },
      () => {
        const rawTransfers = requireTransfers(body);

        // D23/criterion 7: entry errors -- amount/note/visibility shape,
        // self-transfer, an unknown handle -- are checked per entry, in
        // input order, and the first entry with any such error determines
        // the response, before the batch's collective affordability is
        // ever considered. An entry error later in the batch does not
        // pre-empt one earlier, and an unaffordable-looking earlier entry
        // never gets the chance to report 409 if a later entry has a
        // field error -- the whole array is validated entry by entry
        // first, affordability is judged only once, after all of it
        // passes.
        const resolved = rawTransfers.map((entry) => {
          const fromHandle = requireHandleField(entry, 'from_handle');
          const toHandle = requireHandleField(entry, 'to_handle');
          const amount = checkAmount(entry);
          const note = checkNote(entry);
          const visibility = checkVisibility(entry);

          if (fromHandle === toHandle) throw new AppError(422, 'self_payment', 'cannot transfer to the same handle');

          const fromUser = store.state.usersByHandle.get(fromHandle);
          if (!fromUser) throw new AppError(404, 'not_found', `no user with handle ${fromHandle}`);
          const toUser = store.state.usersByHandle.get(toHandle);
          if (!toUser) throw new AppError(404, 'not_found', `no user with handle ${toHandle}`);

          return { fromUser, toUser, amount, note, visibility };
        });

        // R11.10: affordable when every wallet's balance after ALL
        // incoming and outgoing transfers is nonnegative -- judged on the
        // net position of the whole batch, not transfer by transfer. A
        // chain that drains a wallet and later refills it must commit
        // even though checking sequentially would reject it partway.
        const netByUser = new Map();
        for (const t of resolved) {
          netByUser.set(t.fromUser.id, (netByUser.get(t.fromUser.id) || 0) - t.amount);
          netByUser.set(t.toUser.id, (netByUser.get(t.toUser.id) || 0) + t.amount);
        }
        for (const [userId, net] of netByUser) {
          const wallet = store.state.usersById.get(userId);
          if (wallet.balance + net < 0) {
            throw new AppError(409, 'insufficient_funds', 'settlement is not collectively affordable');
          }
        }

        // R11.11/D2: all movements commit together or none do. No await
        // anywhere in this handler, so this loop and the idempotency claim
        // around it are one synchronous step -- nothing else can observe a
        // partially-applied batch.
        const now = new Date();
        const settlementId = store.nextId('stl');
        const paymentIds = resolved.map((t) => {
          t.fromUser.balance -= t.amount;
          t.toUser.balance += t.amount;

          const paymentId = store.nextId('p');
          store.state.payments.set(paymentId, {
            id: paymentId,
            fromUserId: t.fromUser.id,
            toUserId: t.toUser.id,
            amount: t.amount,
            note: t.note,
            visibility: t.visibility,
            requestId: null,
            settlementId,
            createdAt: now,
            sequence: store.nextSequence(),
          });
          return paymentId;
        });

        const settlement = {
          id: settlementId,
          operatorId: user.id,
          paymentIds,
          committedAt: now,
          sequence: store.nextSequence(),
        };
        store.state.settlements.set(settlementId, settlement);

        return { status: 201, body: serializeSettlement(store, settlement) };
      },
    );

    sendJson(res, result.status, result.body);
  });
}

module.exports = { registerSettlementsRoutes, serializeSettlement };
