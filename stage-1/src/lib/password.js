'use strict';

const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

// D26: cost tuned so a 500-seeded-user reset (worst case: 500 distinct
// passwords, one scrypt call per password) has real headroom under the
// 10 s test-control budget on the smallest permitted container (2 vCPU,
// 2 GiB) -- measured at ~1.3 s for 500 hashes at this cost under
// --cpus=2 --memory=2g, against Node's default (N=16384) measuring
// ~18 s extrapolated at the same concurrency. r and p stay at Node's
// defaults; only the work factor N moves.
const DEFAULT_COST = 2048;

// D26/R10.11/D16: the hash carries its own cost parameters, not just the
// salt and digest. The exported state (D16) includes this string verbatim,
// and R10.11 requires hashed-password login to survive import -- a hash
// that only records "scrypt" is verifiable only by a service that happens
// to share today's defaults. A hash made under one cost stays verifiable
// even after DEFAULT_COST changes.
async function hashPassword(password, cost = DEFAULT_COST) {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const derivedKey = await scrypt(password, salt, KEY_LENGTH, { cost });
  return `scrypt:${cost}:${salt.toString('hex')}:${derivedKey.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const parts = typeof stored === 'string' ? stored.split(':') : [];
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const [, costStr, saltHex, hashHex] = parts;
  const cost = Number(costStr);
  if (!Number.isInteger(cost) || cost <= 0) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const derivedKey = await scrypt(password, salt, expected.length, { cost });
  return expected.length === derivedKey.length && crypto.timingSafeEqual(derivedKey, expected);
}

module.exports = { hashPassword, verifyPassword };
