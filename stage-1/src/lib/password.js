'use strict';

const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

// Async scrypt runs on the libuv threadpool, off the event loop, so it
// never blocks other in-flight requests.
async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const derivedKey = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt:${salt.toString('hex')}:${derivedKey.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const parts = typeof stored === 'string' ? stored.split(':') : [];
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, saltHex, hashHex] = parts;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const derivedKey = await scrypt(password, salt, expected.length);
  return expected.length === derivedKey.length && crypto.timingSafeEqual(derivedKey, expected);
}

module.exports = { hashPassword, verifyPassword };
