'use strict';

const { sendJson } = require('../lib/http');
const { toIso } = require('../lib/time');

// §10, read half only (import stays W9). Unauthenticated, like reset. D16:
// a full serialisation of the store -- every field a later item adds to
// state belongs here too, so this function is expected to grow with the
// store rather than be revisited per item.
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
    sequence_counter: state.sequenceCounter,
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
}

module.exports = { registerTestExportRoutes, serializeState };
