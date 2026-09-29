'use strict';

const { AppError } = require('./errors');

const BEARER_RE = /^Bearer (.+)$/;

// §6: every protected endpoint needs `Authorization: Bearer <token>`. A
// missing header, wrong scheme, empty token or unknown token are all the
// same 401 unauthenticated -- none of them get a more specific code, since
// §5 offers none and distinguishing them would leak which part was wrong.
function requireAuth(req, store) {
  const header = req.headers.authorization;
  const match = typeof header === 'string' ? BEARER_RE.exec(header) : null;
  if (!match) throw new AppError(401, 'unauthenticated', 'missing or malformed bearer token');
  const userId = store.state.tokensByValue.get(match[1]);
  const user = userId ? store.state.usersById.get(userId) : undefined;
  if (!user) throw new AppError(401, 'unauthenticated', 'unknown bearer token');
  return user;
}

module.exports = { requireAuth };
