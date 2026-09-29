'use strict';

// §4: exactly one @, non-empty local and domain parts. Nothing stricter (D7).
function splitEmail(email) {
  const at = email.indexOf('@');
  if (at === -1) return null;
  if (email.indexOf('@', at + 1) !== -1) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length === 0 || domain.length === 0) return null;
  return { local, domain };
}

function isValidEmailForm(email) {
  return splitEmail(email) !== null;
}

// §4: lowercase, THEN replace every character outside [a-z0-9_] with _, THEN
// truncate to 20. Order is load-bearing (C3): some lowercase mappings expand
// to more than one code point (U+0130 -> "i" + U+0307), which replace-first
// would destroy. D21: the unit is the Unicode code point, not the UTF-16
// code unit, so an astral character (surrogate pair) becomes one _, not two.
function deriveHandle(localPart) {
  const codePoints = [...localPart.toLowerCase()];
  const replaced = codePoints.map((cp) => (/[a-z0-9_]/.test(cp) ? cp : '_'));
  return replaced.slice(0, 20).join('');
}

module.exports = { splitEmail, isValidEmailForm, deriveHandle };
