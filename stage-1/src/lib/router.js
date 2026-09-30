'use strict';

const { AppError } = require('./errors');

function escapeRegExp(segment) {
  return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createRouter() {
  const routes = [];

  function add(method, pattern, handler) {
    const paramNames = [];
    const segments = pattern.split('/').filter(Boolean).map((segment) => {
      if (segment.startsWith(':')) {
        paramNames.push(segment.slice(1));
        return '([^/]+)';
      }
      return escapeRegExp(segment);
    });
    const regex = segments.length
      ? new RegExp(`^/${segments.join('/')}/?$`)
      : /^\/?$/;
    routes.push({ method, regex, paramNames, handler });
  }

  function resolve(method, pathname) {
    for (const route of routes) {
      if (route.method !== method) continue;
      const match = route.regex.exec(pathname);
      if (!match) continue;
      const params = {};
      try {
        route.paramNames.forEach((name, i) => {
          params[name] = decodeURIComponent(match[i + 1]);
        });
      } catch {
        // C2: an undecodable path segment (e.g. /requests/%ZZ/pay) cannot
        // identify any resource. Falling through to the next route (and
        // ultimately this function's own 404) keeps the error inside §5's
        // malformed_request/not_found split -- malformed_request is
        // reserved for a body, and a decode failure here is neither a body
        // problem nor a route the generic catch-all should have to guess
        // about.
        continue;
      }
      return { handler: route.handler, params };
    }
    throw new AppError(404, 'not_found', 'no such resource');
  }

  return { add, resolve };
}

module.exports = { createRouter };
