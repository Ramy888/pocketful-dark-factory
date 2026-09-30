'use strict';

const { AppError } = require('./errors');

// R5.11: an integer query parameter is plain decimal digits -- `1e9`,
// `4.0` and `+4` are all 422 whatever the numeric value they'd parse to.
// Number()/parseInt() accept all three, so the shape has to be checked
// before the value is.
const DIGITS_RE = /^\d+$/;

function parseIntQueryParam(query, name, { min, max, defaultValue }) {
  const raw = query.get(name);
  if (raw === null) return defaultValue;
  if (!DIGITS_RE.test(raw)) throw new AppError(422, 'validation_failed', `${name} must be a plain non-negative integer`);
  const n = Number(raw);
  if (n < min || (max !== undefined && n > max)) {
    throw new AppError(422, 'validation_failed', `${name} out of range`);
  }
  return n;
}

// R5.14/R8.37: 1..200, default 50.
function parseLimit(query) {
  return parseIntQueryParam(query, 'limit', { min: 1, max: 200, defaultValue: 50 });
}

// R5.15/R8.37: 0 or more, default 0.
function parseOffset(query) {
  return parseIntQueryParam(query, 'offset', { min: 0, defaultValue: 0 });
}

module.exports = { parseLimit, parseOffset };
