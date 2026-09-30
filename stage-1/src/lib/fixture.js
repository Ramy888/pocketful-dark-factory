'use strict';

const { AppError } = require('./errors');
const { hashPassword } = require('./password');

const HANDLE_RE = /^[a-z0-9_]{1,20}$/;
const VALID_MINOR_UNITS = new Set([0, 2, 3]);
const VALID_STATUSES = new Set(['pending', 'paid', 'declined', 'cancelled']);
const VALID_VISIBILITIES = new Set(['public', 'private']);
const MAX_AMOUNT = 1000000000;
const MAX_SAFE_BALANCE = 2 ** 53;
const NOTE_MAX_CODE_POINTS = 200;

function fail(message) {
  throw new AppError(422, 'validation_failed', message);
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function isIntegralNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && Math.trunc(v) === v;
}

function codePointLength(s) {
  return [...s].length;
}

function checkAmount(v, label) {
  if (!isIntegralNumber(v)) fail(`${label} must be an integral number`);
  if (v < 1 || v > MAX_AMOUNT) fail(`${label} must be between 1 and ${MAX_AMOUNT}`);
}

function checkNote(v, label) {
  if (v === undefined) return '';
  if (typeof v !== 'string') fail(`${label} must be a string`);
  if (codePointLength(v) > NOTE_MAX_CODE_POINTS) fail(`${label} exceeds ${NOTE_MAX_CODE_POINTS} characters`);
  return v;
}

// Validates a whole fixture and returns a fully-built, self-contained state
// object. Never mutates any existing store: the caller commits it with a
// single synchronous Store#replace, so a failed validation (thrown as
// AppError before this returns) leaves the live state untouched.
async function validateFixture(fixture) {
  if (!isPlainObject(fixture)) fail('fixture must be a JSON object');

  if (!isNonEmptyString(fixture.currency)) fail('currency is required and must be a non-empty string');
  if (!VALID_MINOR_UNITS.has(fixture.minor_units)) fail('minor_units must be 0, 2 or 3');

  if (fixture.users === undefined) fail('users is required');
  const usersInput = fixture.users;
  if (!Array.isArray(usersInput)) fail('users must be an array');
  const paymentsInput = fixture.payments === undefined ? [] : fixture.payments;
  if (!Array.isArray(paymentsInput)) fail('payments must be an array');
  const requestsInput = fixture.requests === undefined ? [] : fixture.requests;
  if (!Array.isArray(requestsInput)) fail('requests must be an array');
  const operatorIdsInput = fixture.settlement_operator_ids === undefined ? [] : fixture.settlement_operator_ids;
  if (!Array.isArray(operatorIdsInput)) fail('settlement_operator_ids must be an array');

  const usersById = new Map();
  const usersByHandle = new Map();
  const usersByEmail = new Map();
  let seededTotal = 0;
  const pendingUsers = [];

  for (const u of usersInput) {
    if (!isPlainObject(u)) fail('each user must be an object');
    if (!isNonEmptyString(u.id)) fail('user id is required and must be a non-empty string');
    if (usersById.has(u.id)) fail(`duplicate user id: ${u.id}`);
    if (!isNonEmptyString(u.email)) fail('user email is required and must be a non-empty string');
    if (usersByEmail.has(u.email)) fail(`duplicate user email: ${u.email}`);
    if (!isNonEmptyString(u.password)) fail('user password is required and must be a non-empty string');
    if (!isNonEmptyString(u.display_name)) fail('user display_name is required and must be a non-empty string');
    if (!isNonEmptyString(u.handle) || !HANDLE_RE.test(u.handle)) fail(`user handle is invalid: ${JSON.stringify(u.handle)}`);
    if (usersByHandle.has(u.handle)) fail(`duplicate handle: ${u.handle}`);
    if (!isIntegralNumber(u.balance)) fail('user balance must be an integral number');
    if (u.balance < 0) fail('user balance must not be negative');
    if (u.balance > MAX_SAFE_BALANCE) fail('user balance exceeds the safe range');

    const record = {
      id: u.id,
      email: u.email,
      plainPassword: u.password,
      displayName: u.display_name,
      handle: u.handle,
      balance: u.balance,
      tokens: new Set(),
    };
    usersById.set(record.id, record);
    usersByHandle.set(record.handle, record);
    usersByEmail.set(record.email, record);
    seededTotal += record.balance;
    pendingUsers.push(record);
  }

  const seenPaymentIds = new Set();
  for (const p of paymentsInput) {
    if (!isPlainObject(p)) fail('each payment must be an object');
    if (!isNonEmptyString(p.id)) fail('payment id is required and must be a non-empty string');
    if (seenPaymentIds.has(p.id)) fail(`duplicate payment id: ${p.id}`);
    seenPaymentIds.add(p.id);
    if (!isNonEmptyString(p.from_user_id) || !usersById.has(p.from_user_id)) {
      fail(`payment references unknown from_user_id: ${p.from_user_id}`);
    }
    if (!isNonEmptyString(p.to_user_id) || !usersById.has(p.to_user_id)) {
      fail(`payment references unknown to_user_id: ${p.to_user_id}`);
    }
    checkAmount(p.amount, 'payment amount');
    checkNote(p.note, 'payment note');
    if (p.visibility !== undefined && !VALID_VISIBILITIES.has(p.visibility)) {
      fail(`invalid payment visibility: ${p.visibility}`);
    }
  }

  const seenRequestIds = new Set();
  for (const r of requestsInput) {
    if (!isPlainObject(r)) fail('each request must be an object');
    if (!isNonEmptyString(r.id)) fail('request id is required and must be a non-empty string');
    if (seenRequestIds.has(r.id)) fail(`duplicate request id: ${r.id}`);
    seenRequestIds.add(r.id);
    if (!isNonEmptyString(r.requester_id) || !usersById.has(r.requester_id)) {
      fail(`request references unknown requester_id: ${r.requester_id}`);
    }
    if (!isNonEmptyString(r.payer_id) || !usersById.has(r.payer_id)) {
      fail(`request references unknown payer_id: ${r.payer_id}`);
    }
    checkAmount(r.amount, 'request amount');
    checkNote(r.note, 'request note');
    if (!VALID_STATUSES.has(r.status)) fail(`invalid request status: ${r.status}`);
  }

  for (const opId of operatorIdsInput) {
    if (!isNonEmptyString(opId) || !usersById.has(opId)) {
      fail(`settlement_operator_ids references unknown user id: ${opId}`);
    }
  }

  // Only now, after every synchronous check has passed, do the (async,
  // parallel) work of hashing seeded passwords. Nothing above this line
  // touches the live store, so a validation failure never gets here.
  //
  // R6.11: one hash per *record*, never shared across users who happen to
  // seed the same password value. hashPassword draws a fresh random salt
  // per call, so this alone makes two equal passwords produce unrelated
  // stored strings. An earlier version memoized by password value to save
  // scrypt calls when a fixture repeats one password across many users --
  // rejected on review: GET /_test/export is unauthenticated (R10.1) and
  // publishes password_hash verbatim, so a shared hash string let any
  // caller partition seeded users into password-equality classes for free.
  // The worst case for cost was already "every user has a distinct
  // password" (memoization buys nothing then), measured at ~1.4-1.5s for
  // 500 users against a 3s budget -- hashing every record independently
  // costs no more than that measured worst case.
  await Promise.all(pendingUsers.map(async (record) => {
    record.passwordHash = await hashPassword(record.plainPassword);
    delete record.plainPassword;
  }));

  const now = new Date();
  let sequence = 0;

  // D10: fixture-array order determines recency, via the sequence tie-break.
  const payments = new Map();
  for (const p of paymentsInput) {
    sequence += 1;
    payments.set(p.id, {
      id: p.id,
      fromUserId: p.from_user_id,
      toUserId: p.to_user_id,
      amount: p.amount,
      note: p.note === undefined ? '' : p.note,
      visibility: p.visibility === undefined ? 'public' : p.visibility,
      requestId: null,
      settlementId: null,
      createdAt: now,
      sequence,
    });
  }

  const requests = new Map();
  for (const r of requestsInput) {
    sequence += 1;
    requests.set(r.id, {
      id: r.id,
      requesterId: r.requester_id,
      payerId: r.payer_id,
      amount: r.amount,
      note: r.note === undefined ? '' : r.note,
      status: r.status,
      paymentId: null,
      createdAt: now,
      sequence,
    });
  }

  return {
    currency: fixture.currency,
    minorUnits: fixture.minor_units,
    seededTotal,
    usersById,
    usersByHandle,
    usersByEmail,
    payments,
    requests,
    splits: new Map(),
    settlements: new Map(),
    operatorIds: new Set(operatorIdsInput),
    idempotency: new Map(),
    tokensByValue: new Map(),
    sequenceCounter: sequence,
  };
}

module.exports = { validateFixture };
