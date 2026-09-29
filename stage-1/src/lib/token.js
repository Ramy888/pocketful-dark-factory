'use strict';

const crypto = require('crypto');

// Opaque, unguessable, <= 64 chars (§3.4): 32 random bytes as 64 hex chars.
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { generateToken };
