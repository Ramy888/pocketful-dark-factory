'use strict';

const { sendNoContent } = require('../lib/http');
const { validateFixture } = require('../lib/fixture');

function registerTestResetRoutes(router, store) {
  router.add('POST', '/_test/reset', async (req, res) => {
    const newState = await validateFixture(req.jsonBody);
    store.replace(newState);
    sendNoContent(res, 204);
  });
}

module.exports = { registerTestResetRoutes };
