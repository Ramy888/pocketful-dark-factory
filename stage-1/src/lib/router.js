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
      route.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(match[i + 1]);
      });
      return { handler: route.handler, params };
    }
    throw new AppError(404, 'not_found', 'no such resource');
  }

  return { add, resolve };
}

module.exports = { createRouter };
