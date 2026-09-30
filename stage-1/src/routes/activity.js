'use strict';

const { sendJson } = require('../lib/http');
const { requireAuth } = require('../lib/auth');
const { parseLimit, parseOffset } = require('../lib/pagination');
const { serializePayment } = require('./payments');

// R4.13: visible iff public, or the caller is sender or receiver. No other
// rule -- no follow graph, no mute list. R4.15 (a split is not a feed
// item) is carried to W8 (D52): nothing here reads state.splits at all, so
// there is nothing that could leak one prematurely.
function isVisible(payment, userId) {
  return payment.visibility === 'public' || payment.fromUserId === userId || payment.toUserId === userId;
}

function registerActivityRoutes(router, store) {
  router.add('GET', '/activity', async (req, res) => {
    const user = requireAuth(req, store);
    const limit = parseLimit(req.query);
    const offset = parseOffset(req.query);

    // D51: newest-first by created_at; R8.36 excuses any particular order
    // for a same-second tie, but repeated calls with no writes in between
    // must agree, which a stable sort over an unchanged array already
    // guarantees on its own. The sequence tie-break falls out of what W5
    // already assigns every payment (D9's monotonic counter) rather than
    // being built for this criterion, so it costs nothing to keep.
    const visible = [...store.state.payments.values()]
      .filter((p) => isVisible(p, user.id))
      .sort((a, b) => b.createdAt - a.createdAt || b.sequence - a.sequence);

    const page = visible.slice(offset, offset + limit);
    const payments = page.map((p) => {
      const fromUser = store.state.usersById.get(p.fromUserId);
      const toUser = store.state.usersById.get(p.toUserId);
      return serializePayment(store, p, fromUser, toUser);
    });

    sendJson(res, 200, { payments, has_more: offset + limit < visible.length });
  });
}

module.exports = { registerActivityRoutes };
