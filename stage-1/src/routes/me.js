'use strict';

const { sendJson } = require('../lib/http');
const { requireAuth } = require('../lib/auth');

function registerMeRoutes(router, store) {
  router.add('GET', '/me', async (req, res) => {
    const user = requireAuth(req, store);
    sendJson(res, 200, {
      user_id: user.id,
      display_name: user.displayName,
      handle: user.handle,
      balance: user.balance,
      currency: store.state.currency,
      minor_units: store.state.minorUnits,
    });
  });
}

module.exports = { registerMeRoutes };
