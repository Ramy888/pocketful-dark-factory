'use strict';

const { AppError } = require('../lib/errors');
const { sendJson } = require('../lib/http');
const { hashPassword, verifyPassword } = require('../lib/password');
const { generateToken } = require('../lib/token');
const { splitEmail, isValidEmailForm, deriveHandle } = require('../lib/handle');

const MIN_PASSWORD_LENGTH = 8;

// A present field of the wrong JSON type is 400 malformed_request (R5.2); an
// absent required field is 422 validation_failed (R5.8). The two are not the
// same error, so presence and type are checked as two separate questions.
function requireStringField(body, field) {
  const value = body[field];
  if (value === undefined) throw new AppError(422, 'validation_failed', `${field} is required`);
  if (typeof value !== 'string') throw new AppError(400, 'malformed_request', `${field} must be a string`);
  return value;
}

function issueToken(store, user) {
  const token = generateToken();
  store.state.tokensByValue.set(token, user.id);
  user.tokens.add(token);
  return token;
}

function registerAuthRoutes(router, store) {
  router.add('POST', '/auth/signup', async (req, res) => {
    const body = req.jsonBody;
    const email = requireStringField(body, 'email');
    const password = requireStringField(body, 'password');
    const displayName = requireStringField(body, 'display_name');

    // D6: all field validation before any conflict check.
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new AppError(422, 'validation_failed', `password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    const parts = splitEmail(email);
    if (!parts) throw new AppError(422, 'validation_failed', 'email must be of the form local@domain');
    if (displayName.length === 0) throw new AppError(422, 'validation_failed', 'display_name must not be empty');

    const handle = deriveHandle(parts.local);

    // D3: password hashing is the only await in this handler. Every check
    // that guards uniqueness runs again, synchronously, after it resolves --
    // nothing else in this handler can run between that check and the
    // insert, so two concurrent signups racing on the same email or derived
    // handle cannot both win.
    const passwordHash = await hashPassword(password);

    if (store.state.usersByEmail.has(email)) {
      throw new AppError(409, 'email_taken', 'email is already registered');
    }
    if (store.state.usersByHandle.has(handle)) {
      throw new AppError(409, 'handle_taken', 'derived handle is already taken');
    }

    const id = store.nextId('u');
    const user = {
      id,
      email,
      passwordHash,
      displayName,
      handle,
      balance: 0,
      tokens: new Set(),
    };
    store.state.usersById.set(id, user);
    store.state.usersByEmail.set(email, user);
    store.state.usersByHandle.set(handle, user);

    const token = issueToken(store, user);
    sendJson(res, 201, { user_id: id, display_name: displayName, token });
  });

  router.add('POST', '/auth/login', async (req, res) => {
    const body = req.jsonBody;
    const email = requireStringField(body, 'email');
    const password = requireStringField(body, 'password');

    const user = store.state.usersByEmail.get(email);
    const ok = user ? await verifyPassword(password, user.passwordHash) : false;
    if (!user || !ok) throw new AppError(401, 'unauthenticated', 'wrong password or unknown email');

    const token = issueToken(store, user);
    sendJson(res, 200, { user_id: user.id, display_name: user.displayName, token });
  });
}

module.exports = { registerAuthRoutes, requireStringField };
