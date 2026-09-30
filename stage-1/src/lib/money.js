'use strict';

const { AppError } = require('./errors');

const MAX_AMOUNT = 1000000000;
const NOTE_MAX_CODE_POINTS = 200;
const VALID_VISIBILITIES = new Set(['public', 'private']);

function isIntegralNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v);
}

// D20: "characters" for the note limit means Unicode code points, not
// UTF-16 units, so a note of 200 astral emoji is 200 characters, not 400.
function codePointLength(s) {
  return [...s].length;
}

// R8.5/R5.10: amount's type and range checks all resolve to 422, never
// 400 -- the one field-validation carve-out from the general "wrong JSON
// type is 400" rule (R5.2). A string, boolean or null amount is exactly as
// invalid as an out-of-range one, so every failure shares one code rather
// than splitting across 400/422 depending on which check happens to fire.
// R4.2: 1000, 1000.0 and 1e3 all parse to the same JS number 1000 -- there
// is nothing left to normalise by the time JSON.parse has run.
function checkAmount(body) {
  const v = body.amount;
  if (v === undefined) throw new AppError(422, 'validation_failed', 'amount is required');
  if (!isIntegralNumber(v)) throw new AppError(422, 'validation_failed', 'amount must be an integral number');
  if (v < 1 || v > MAX_AMOUNT) throw new AppError(422, 'validation_failed', `amount must be between 1 and ${MAX_AMOUNT}`);
  return v;
}

// R8.7/R5.10: note is optional, defaulting to "" when omitted, but a
// *present* value must be a string -- explicitly including null, which the
// usual "absent field selects the default" leniency does not cover -- and
// at most 200 Unicode code points (D20).
function checkNote(body) {
  const v = body.note;
  if (v === undefined) return '';
  if (typeof v !== 'string') throw new AppError(422, 'validation_failed', 'note must be a string');
  if (codePointLength(v) > NOTE_MAX_CODE_POINTS) {
    throw new AppError(422, 'validation_failed', `note exceeds ${NOTE_MAX_CODE_POINTS} characters`);
  }
  return v;
}

// R8.8/R5.10: visibility is optional, defaulting to "public"; any present
// value outside the two-item enum is 422, whatever its JSON type.
function checkVisibility(body) {
  const v = body.visibility;
  if (v === undefined) return 'public';
  if (!VALID_VISIBILITIES.has(v)) throw new AppError(422, 'validation_failed', 'visibility must be "public" or "private"');
  return v;
}

module.exports = { checkAmount, checkNote, checkVisibility, MAX_AMOUNT, NOTE_MAX_CODE_POINTS };
