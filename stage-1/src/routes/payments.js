'use strict';

const { AppError } = require('../lib/errors');
const { sendJson } = require('../lib/http');
const { toIso } = require('../lib/time');
const { requireAuth } = require('../lib/auth');
const { runIdempotent } = require('../lib/idempotency');
const { checkAmount, checkNote, checkVisibility } = require('../lib/money');

// R8.2: to_handle follows the general field-validation rule (R5.2/R5.8) --
// absent is 422, a present wrong-typed value is 400 -- unlike amount, note
// and visibility, which R5.10 carves out to always answer 422.
function requireToHandle(body) {
  const v = body.to_handle;
  if (v === undefined) throw new AppError(422, 'validation_failed', 'to_handle is required');
  if (typeof v !== 'string') throw new AppError(400, 'malformed_request', 'to_handle must be a string');
  return v;
}

function serializePayment(store, payment, fromUser, toUser) {
  return {
    payment_id: payment.id,
    from_user_id: fromUser.id,
    from_handle: fromUser.handle,
    to_user_id: toUser.id,
    to_handle: toUser.handle,
    amount: payment.amount,
    currency: store.state.currency,
    note: payment.note,
    visibility: payment.visibility,
    request_id: payment.requestId,
    settlement_id: payment.settlementId,
    created_at: toIso(payment.createdAt),
  };
}

function registerPaymentsRoutes(router, store) {
  router.add('POST', '/payments', async (req, res) => {
    const user = requireAuth(req, store);
    const rawKey = req.headers['idempotency-key'];
    const body = req.jsonBody;

    // D22's chain, specialised to this endpoint: parse body / authenticate
    // already happened above the gate; runIdempotent itself covers key
    // presence (400), key length (422) and key resolution (200 replay /
    // 409 reuse) before ever calling this handler (R7.13). Inside the
    // handler: field validation 422 (to_handle's shape, amount, note,
    // visibility, then self_payment -- derivable from the body and the
    // caller alone, no lookup needed) -> resource resolution 404 (the
    // to_handle lookup) -> funds 409. There is no resource-level
    // authorisation step for a payment: any authenticated user may pay any
    // other, so nothing sits between resolution and the funds check.
    const result = runIdempotent(
      store,
      { user, method: req.method, path: req.pathname, rawKey, body },
      () => {
        const toHandle = requireToHandle(body);
        const amount = checkAmount(body);
        const note = checkNote(body);
        const visibility = checkVisibility(body);

        // R8.6: self_payment is a plain string comparison against the
        // caller's own handle -- no directory lookup required -- so it
        // belongs in the field-validation tier, before resource
        // resolution. That ordering is what makes criterion 8 (D22) hold:
        // an invalid amount together with an unknown to_handle is 422,
        // never 404, because every field check above already ran and
        // would have thrown first.
        if (toHandle === user.handle) {
          throw new AppError(422, 'self_payment', 'cannot send a payment to yourself');
        }

        const recipient = store.state.usersByHandle.get(toHandle);
        if (!recipient) throw new AppError(404, 'not_found', 'no user with that handle');

        // R1.8/R8.4: the funds check runs before any mutation, so a
        // rejected payment changes neither wallet.
        if (user.balance < amount) {
          throw new AppError(409, 'insufficient_funds', "balance is below the payment's amount");
        }

        // R8.10/D2: debit and credit happen in the same synchronous step
        // as the idempotency claim above them (no await anywhere in this
        // handler) -- Node runs this to completion before any other
        // request's handler can observe an in-between state, so the two
        // wallets move together or not at all, by construction rather
        // than by an explicit lock.
        user.balance -= amount;
        recipient.balance += amount;

        const id = store.nextId('p');
        const payment = {
          id,
          fromUserId: user.id,
          toUserId: recipient.id,
          amount,
          note,
          visibility,
          requestId: null,
          // D4: every payment carries settlement_id, null unless a
          // settlement member -- no settlement path exists yet (W10), so
          // every payment minted here is null by construction.
          settlementId: null,
          createdAt: new Date(),
          sequence: store.nextSequence(),
        };
        store.state.payments.set(id, payment);

        return { status: 201, body: serializePayment(store, payment, user, recipient) };
      },
    );

    sendJson(res, result.status, result.body);
  });
}

module.exports = { registerPaymentsRoutes };
