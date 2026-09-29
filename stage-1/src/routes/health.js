'use strict';

const { sendJson } = require('../lib/http');

// Once the process is listening, in-memory state is already initialised
// synchronously, so the service is ready to serve requests immediately.
function registerHealthRoutes(router) {
  router.add('GET', '/health', async (req, res) => {
    sendJson(res, 200, { status: 'ok' });
  });
}

module.exports = { registerHealthRoutes };
