'use strict';

// RFC 3339 with an explicit +00:00 offset. Date#toISOString always emits a
// trailing 'Z', which §3.4 / D8 forbid, so the offset is substituted in.
function toIso(date) {
  return date.toISOString().replace(/\.\d+Z$/, '+00:00');
}

function nowIso() {
  return toIso(new Date());
}

module.exports = { toIso, nowIso };
