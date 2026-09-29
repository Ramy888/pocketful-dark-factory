'use strict';

const crypto = require('crypto');

// Opaque id, <= 64 chars (§3.4). Format is ours; a prefix keeps ids
// human-scannable in logs and fixtures without meaning anything to clients.
function genId(prefix) {
  const raw = crypto.randomUUID().replace(/-/g, '');
  const id = prefix ? `${prefix}_${raw}` : raw;
  return id.slice(0, 64);
}

module.exports = { genId };
