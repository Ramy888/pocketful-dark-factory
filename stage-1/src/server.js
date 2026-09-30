'use strict';

const http = require('http');

const { createRouter } = require('./lib/router');
const { AppError } = require('./lib/errors');
const { sendError, readJsonBody } = require('./lib/http');
const { registerHealthRoutes } = require('./routes/health');
const { registerTestResetRoutes } = require('./routes/testReset');
const { registerTestExportRoutes } = require('./routes/testExport');
const { registerAuthRoutes } = require('./routes/auth');
const { registerMeRoutes } = require('./routes/me');
const { registerPaymentsRoutes } = require('./routes/payments');
const { registerActivityRoutes } = require('./routes/activity');
const { Store } = require('./store');

function buildRouter(store) {
  const router = createRouter();
  registerHealthRoutes(router);
  registerTestResetRoutes(router, store);
  registerTestExportRoutes(router, store);
  registerAuthRoutes(router, store);
  registerMeRoutes(router, store);
  registerPaymentsRoutes(router, store);
  registerActivityRoutes(router, store);
  return router;
}

function createApp(router) {
  return async function handleRequest(req, res) {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://internal').pathname;
    } catch {
      sendError(res, 400, 'malformed_request', 'unparseable request URL');
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      if (err instanceof AppError) {
        sendError(res, err.status, err.code, err.message);
      } else {
        sendError(res, 400, 'malformed_request', 'could not read request body');
      }
      return;
    }

    req.query = new URL(req.url, 'http://internal').searchParams;
    req.jsonBody = body;
    // The idempotency gate (lib/idempotency.js) scopes a record by the
    // concrete request path, not the route pattern -- two different {id}
    // paths under one collection are different requests (R7.4).
    req.pathname = pathname;

    try {
      const { handler, params } = router.resolve(req.method, pathname);
      await handler(req, res, params);
    } catch (err) {
      if (res.headersSent) return;
      if (err instanceof AppError) {
        sendError(res, err.status, err.code, err.message);
      } else {
        // Binding constraint: no response may be 5xx, even for a bug we did
        // not anticipate. This is the last-resort net, not a designed path.
        sendError(res, 400, 'malformed_request', 'internal error');
      }
    }
  };
}

function createServer() {
  const store = new Store();
  const router = buildRouter(store);
  const app = createApp(router);
  const server = http.createServer((req, res) => {
    app(req, res);
  });
  server.store = store;
  return server;
}

function start() {
  const server = createServer();
  const port = Number(process.env.PORT) || 8080;
  server.listen(port, '0.0.0.0', () => {
    console.log(`pocketful stage-1 listening on 0.0.0.0:${port}`);
  });
  return server;
}

if (require.main === module) {
  start();
}

module.exports = { createServer, start };
