// Specification 6 and the handle rules of specification 4.

import { suite, test } from '../lib/runner.mjs';
import { api, reset, resetWith, login, signup, me, key, PW } from '../lib/helpers.mjs';

const HANDLE_RE = /^[a-z0-9_]{1,20}$/;

// The derivation stated in spec 4: local part, lowercased, every character outside
// [a-z0-9_] replaced with _, truncated to 20 characters.
const DERIVATIONS = [
  ['Ada.Lovelace+x@example.com', 'ada_lovelace_x'],
  ['UPPER@example.com', 'upper'],
  ['a.b-c_d@example.com', 'a_b_c_d'],
  ['123@example.com', '123'],
  ['_@example.com', '_'],
  ['abcdefghij0123456789klmnopqrst@example.com', 'abcdefghij0123456789'],
  ["o'brien@example.com", 'o_brien'],
  ['a+b=c@example.com', 'a_b_c'],
];

suite('03 authentication and handles', () => {
  test('signup returns 201 with a working token and a zero balance', ['R6.1', 'R4.8'], async (t) => {
    await reset(t, 'eur');
    const res = await signup(t, 'newbie@example.com', 'Newbie');
    if (!t.status(res, 201, { ref: 'R6.1', what: 'POST /auth/signup' })) return;
    t.fields(res.json, ['user_id', 'display_name', 'token'], { ref: 'R6.1', what: 'signup response', res });
    t.eq(res.json.display_name, 'Newbie', { ref: 'R6.1', what: 'display_name echoed', res });
    t.ok(typeof res.json.token === 'string' && res.json.token.length > 0, {
      ref: 'R6.1', what: 'signup token', res,
      expected: 'a non-empty string token', actual: JSON.stringify(res.json.token),
    });
    const m = await me(t, res.json.token);
    if (!t.status(m, 200, { ref: 'R6.1', what: 'GET /me with the signup token' })) return;
    t.eq(m.json.balance, 0, { ref: 'R4.8', what: 'a new user starts at balance 0', res: m });
    t.eq(m.json.user_id, res.json.user_id, { ref: 'R6.1', what: 'user_id agrees with signup', res: m });
  });

  test('GET /me returns exactly the documented fields', ['R8.1'], async (t) => {
    await reset(t, 'eur');
    const ada = await login(t, 'ada@example.com');
    if (!ada) return;
    const m = await me(t, ada.token);
    if (!t.status(m, 200, { ref: 'R8.1', what: 'GET /me' })) return;
    t.fields(m.json, ['user_id', 'display_name', 'handle', 'balance', 'currency', 'minor_units'], {
      ref: 'R8.1', what: 'GET /me body', res: m,
    });
    t.deep(
      { user_id: m.json.user_id, display_name: m.json.display_name, handle: m.json.handle, balance: m.json.balance, currency: m.json.currency, minor_units: m.json.minor_units },
      { user_id: 'u_ada', display_name: 'Ada', handle: 'ada', balance: 10000, currency: 'EUR', minor_units: 2 },
      { ref: 'R8.1', what: 'GET /me values for the seeded ada', res: m },
    );
  });

  test('the handle is derived from the email exactly as spec 4 states', ['R4.6'], async (t) => {
    await reset(t, 'minimal');
    for (const [email, expected] of DERIVATIONS) {
      const res = await signup(t, email, 'X');
      if (!t.status(res, 201, { ref: 'R4.6', what: `signup ${email}` })) continue;
      const m = await me(t, res.json.token);
      if (!t.status(m, 200, { ref: 'R4.6', what: `GET /me after signup ${email}` })) continue;
      t.eq(m.json.handle, expected, { ref: 'R4.6', what: `handle derived from ${email}`, res: m });
      t.ok(HANDLE_RE.test(String(m.json.handle)), {
        ref: 'R4.3', what: `derived handle for ${email} matches ^[a-z0-9_]{1,20}$`, res: m,
        expected: 'a handle matching ^[a-z0-9_]{1,20}$', actual: JSON.stringify(m.json.handle),
      });
    }
  });

  test('a non-ASCII local part is lowercased then replaced character by character', ['R4.6'], async (t) => {
    await reset(t, 'minimal');
    const res = await signup(t, 'ÜBER@example.com', 'Uber');
    if (!t.status(res, 201, { ref: 'R4.6', what: 'signup ÜBER@example.com' })) return;
    const m = await me(t, res.json.token);
    t.eq(m.json && m.json.handle, '_ber', {
      ref: 'R4.6', what: 'handle derived from ÜBER@example.com (lowercase to über, then Ü->_)', res: m,
    });
  }, {
    severity: 'advisory',
    why: 'spec 4 orders the derivation lowercase-then-replace, which gives _ber. Decision D21 fixes '
       + 'the unit as the code point. A handle matching ^[a-z0-9_]{1,20}$ is the blocking part and '
       + 'is checked above.',
  });

  test('derivation replaces one underscore per code point, not per UTF-16 unit', ['D21'], async (t) => {
    await reset(t, 'minimal');
    // An astral emoji is one code point and two UTF-16 units.
    const res = await signup(t, '\u{1F600}a@example.com', 'Emoji');
    if (!t.status(res, 201, { ref: 'D21', what: 'signup with an astral character in the local part' })) return;
    const m = await me(t, res.json.token);
    t.eq(m.json && m.json.handle, '_a', {
      ref: 'D21', what: 'handle derived from an emoji plus "a" (one underscore, not two)', res: m,
    });
  }, {
    severity: 'advisory',
    why: 'Decision D21. spec 4 does not define the unit, so one underscore per UTF-16 unit ("__a") '
       + 'is also a reading of the text.',
  });

  test('derivation lowercases before replacing, even when lowercasing expands', ['D21', 'R4.6'], async (t) => {
    await reset(t, 'minimal');
    // U+0130 lowercases to two code points, "i" followed by a combining dot above.
    // spec 4 orders lowercase first, so the "i" survives and only the combining mark
    // becomes an underscore. Replacing before lowercasing would give "_" instead.
    const res = await signup(t, '\u0130@example.com', 'Dotted');
    if (!t.status(res, 201, { ref: 'D21', what: 'signup with U+0130 as the whole local part' })) return;
    const m = await me(t, res.json.token);
    t.eq(m.json && m.json.handle, 'i_', {
      ref: 'D21', what: 'handle derived from U+0130 (lowercase to i + U+0307, then replace)', res: m,
    });
  }, {
    severity: 'advisory',
    why: 'spec 4 states the order lowercase-then-replace, so this case is settled by the text more '
       + 'than by decision D21. It is advisory only because Unicode case mapping is locale and '
       + 'library dependent, and the specification names no case-mapping standard.',
  });

  test('a duplicate email is 409 email_taken', ['R6.3'], async (t) => {
    await reset(t, 'minimal');
    const first = await signup(t, 'dup@example.com', 'First');
    t.status(first, 201, { ref: 'R6.1', what: 'first signup' });
    const second = await signup(t, 'dup@example.com', 'Second');
    t.err(second, 409, 'email_taken', { ref: 'R6.3', what: 'signup with an email already registered' });
  });

  test('a seeded email is also 409 email_taken', ['R6.3'], async (t) => {
    await reset(t, 'eur');
    const res = await signup(t, 'ada@example.com', 'Impostor');
    t.err(res, 409, 'email_taken', { ref: 'R6.3', what: 'signup with a seeded email' });
  });

  test('an email deriving a taken handle is 409 handle_taken and creates no account', ['R6.7'], async (t) => {
    await reset(t, 'eur');
    const res = await signup(t, 'ada@other.example.com', 'Other Ada');
    t.err(res, 409, 'handle_taken', {
      ref: 'R6.7', what: 'signup whose derived handle "ada" is already taken',
    });
    // "and no account is created"
    const attempt = await api(t, { method: 'POST', path: '/auth/login', body: { email: 'ada@other.example.com', password: PW } });
    t.err(attempt, 401, 'unauthenticated', {
      ref: 'R6.7', what: 'login with the rejected signup email',
    });
  });

  test('handle collision by truncation is 409 handle_taken', ['R6.7'], async (t) => {
    await reset(t, 'minimal');
    const a = await signup(t, 'abcdefghij0123456789xxxx@example.com', 'A');
    t.status(a, 201, { ref: 'R6.1', what: 'first 24-character local part' });
    const b = await signup(t, 'abcdefghij0123456789yyyy@example.com', 'B');
    t.err(b, 409, 'handle_taken', {
      ref: 'R6.7', what: 'a second local part truncating to the same 20 characters',
    });
  });

  test('a case variant of a registered email collides at the derived handle', ['D5'], async (t) => {
    await reset(t, 'eur');
    const res = await signup(t, 'ADA@example.com', 'Shouty Ada');
    t.err(res, 409, 'handle_taken', {
      ref: 'D5', what: 'signup ADA@example.com when ada@example.com is seeded',
    });
  }, {
    severity: 'advisory',
    why: 'The specification never states whether email equality is case sensitive. Decision D5 '
       + 'chooses exact comparison, which makes this 409 handle_taken; treating emails as '
       + 'case-insensitive makes it 409 email_taken. Both reject the signup, which is the part '
       + 'the specification determines.',
  });

  test('a password shorter than 8 characters is 422', ['R6.4'], async (t) => {
    await reset(t, 'minimal');
    const short = await api(t, { method: 'POST', path: '/auth/signup', body: { email: 'p7@example.com', password: '1234567', display_name: 'P7' } });
    t.err(short, 422, 'validation_failed', { ref: 'R6.4', what: 'signup with a 7-character password' });
    const empty = await api(t, { method: 'POST', path: '/auth/signup', body: { email: 'p0@example.com', password: '', display_name: 'P0' } });
    t.err(empty, 422, 'validation_failed', { ref: 'R6.4', what: 'signup with an empty password' });
    const eight = await api(t, { method: 'POST', path: '/auth/signup', body: { email: 'p8@example.com', password: '12345678', display_name: 'P8' } });
    t.status(eight, 201, { ref: 'R6.4', what: 'signup with an 8-character password' });
    const back = await api(t, { method: 'POST', path: '/auth/login', body: { email: 'p8@example.com', password: '12345678' } });
    t.status(back, 200, { ref: 'R6.2', what: 'login with the 8-character password' });
  });

  test('an email not of the form local@domain is 422', ['R6.5'], async (t) => {
    await reset(t, 'minimal');
    for (const email of ['notanemail', '@example.com', 'a@', 'a@@b', '', 'a@b@c', '@']) {
      const res = await api(t, { method: 'POST', path: '/auth/signup', body: { email, password: PW, display_name: 'X' } });
      t.err(res, 422, 'validation_failed', { ref: 'R6.5', what: `signup with email ${JSON.stringify(email)}` });
    }
  });

  test('an email with one @ and both parts non-empty is accepted', ['D7'], async (t) => {
    await reset(t, 'minimal');
    for (const [email, handle] of [['zz@b', 'zz'], ['a b@example.com', 'a_b'], ['x@localhost', 'x']]) {
      const res = await api(t, { method: 'POST', path: '/auth/signup', body: { email, password: PW, display_name: 'X' } });
      if (!t.status(res, 201, { ref: 'D7', what: `signup with email ${JSON.stringify(email)}` })) continue;
      const m = await me(t, res.json.token);
      t.eq(m.json && m.json.handle, handle, { ref: 'R4.6', what: `handle derived from ${email}`, res: m });
    }
  }, {
    severity: 'advisory',
    why: 'spec 6 says only "not of the form local@domain". Decision D7 reads that as exactly one @ '
       + 'with both parts non-empty, so a dotless domain and a space in the local part are valid. A '
       + 'stricter validator would return 422 here without contradicting the text.',
  });

  test('a wrong password or an unknown email on login is 401', ['R6.6'], async (t) => {
    await reset(t, 'eur');
    const wrong = await api(t, { method: 'POST', path: '/auth/login', body: { email: 'ada@example.com', password: 'wrong horse' } });
    t.err(wrong, 401, 'unauthenticated', { ref: 'R6.6', what: 'login with the wrong password' });
    const unknown = await api(t, { method: 'POST', path: '/auth/login', body: { email: 'nobody@example.com', password: PW } });
    t.err(unknown, 401, 'unauthenticated', { ref: 'R6.6', what: 'login with an unknown email' });
    const nearly = await api(t, { method: 'POST', path: '/auth/login', body: { email: 'ada@example.com', password: PW + ' ' } });
    t.err(nearly, 401, 'unauthenticated', { ref: 'R6.6', what: 'login with a trailing space on the password' });
  });

  test('an account may hold several valid tokens at once', ['R6.10'], async (t) => {
    await reset(t, 'eur');
    const a = await login(t, 'ada@example.com');
    const b = await login(t, 'ada@example.com');
    const c = await login(t, 'ada@example.com');
    if (!a || !b || !c) return;
    t.ok(new Set([a.token, b.token, c.token]).size === 3, {
      ref: 'R6.10', what: 'three logins yield three distinct tokens',
      expected: '3 distinct tokens', actual: JSON.stringify([a.token, b.token, c.token]),
    });
    for (const [label, tok] of [['first', a.token], ['second', b.token], ['third', c.token]]) {
      const m = await me(t, tok);
      t.status(m, 200, { ref: 'R6.10', what: `GET /me with the ${label} token` });
    }
    // A write through one session must be visible through another.
    const p = await api(t, { method: 'POST', path: '/payments', token: a.token, idemKey: key('multi'), body: { to_handle: 'bob', amount: 100 } });
    t.status(p, 201, { ref: 'R6.10', what: 'POST /payments with the first token' });
    const m = await me(t, c.token);
    t.eq(m.json && m.json.balance, 9900, { ref: 'R6.10', what: 'balance seen through the third token', res: m });
  });

  test('a signup token and a login token for the same account both work', ['R6.10'], async (t) => {
    await reset(t, 'minimal');
    const s = await signup(t, 'both@example.com', 'Both');
    if (!t.status(s, 201, { ref: 'R6.1', what: 'signup' })) return;
    const l = await login(t, 'both@example.com');
    if (!l) return;
    t.eq(l.user_id, s.json.user_id, { ref: 'R6.2', what: 'login user_id matches signup', res: l });
    for (const [label, tok] of [['signup', s.json.token], ['login', l.token]]) {
      const m = await me(t, tok);
      t.status(m, 200, { ref: 'R6.10', what: `GET /me with the ${label} token` });
    }
  });

  test('protected endpoints reject a missing, malformed or unknown token with 401', ['R5.4', 'R6.8'], async (t) => {
    await reset(t, 'eur');
    const ada = await login(t, 'ada@example.com');
    if (!ada) return;
    const rq = await api(t, { method: 'POST', path: '/requests', token: ada.token, idemKey: key('auth'), body: { payer_handle: 'bob', amount: 10 } });
    const rqId = rq.json && rq.json.request_id;

    const protectedCalls = [
      ['GET', '/me'],
      ['GET', '/activity'],
      ['GET', '/requests'],
      ['POST', '/payments', { to_handle: 'bob', amount: 1 }],
      ['POST', '/requests', { payer_handle: 'bob', amount: 1 }],
      ['POST', '/splits', { amount: 2, participant_handles: ['ada', 'bob'] }],
      ['POST', '/settlements', { transfers: [{ from_handle: 'ada', to_handle: 'bob', amount: 1 }] }],
      ['POST', `/requests/${rqId}/pay`, {}],
      ['POST', `/requests/${rqId}/decline`, {}],
      ['POST', `/requests/${rqId}/cancel`, {}],
    ];

    const headerCases = [
      ['no Authorization header', undefined],
      ['an unknown bearer token', { Authorization: 'Bearer not-a-real-token' }],
      ['an empty bearer token', { Authorization: 'Bearer ' }],
      ['the scheme alone', { Authorization: 'Bearer' }],
      ['no scheme', { Authorization: 'just-a-token' }],
      ['the wrong scheme', { Authorization: 'Basic YWRhOnB3' }],
      ['an empty header', { Authorization: '' }],
    ];

    for (const [method, path, body] of protectedCalls) {
      for (const [label, headers] of headerCases) {
        const res = await api(t, { method, path, body, headers, idemKey: key('auth') });
        t.err(res, 401, 'unauthenticated', { ref: 'R5.4', what: `${method} ${path} with ${label}` });
      }
    }
  });

  test('an idempotency key is never required before authentication is settled', ['R5.4'], async (t) => {
    await reset(t, 'eur');
    // No token and no Idempotency-Key: authentication is the failure the spec names,
    // and 401 must not be masked by a 400 about the key.
    const res = await api(t, { method: 'POST', path: '/payments', body: { to_handle: 'bob', amount: 1 } });
    t.err(res, 401, 'unauthenticated', {
      ref: 'R5.4', what: 'POST /payments with neither a token nor an idempotency key',
    });
  }, {
    severity: 'advisory',
    why: 'spec 7 puts authentication before key resolution but does not order the '
       + '"header absent" 400 against the 401. Decision D14 puts 401 first.',
  });

  test('signup and login reject missing fields with 422 and wrong types with 400', ['R5.2', 'R5.8'], async (t) => {
    await reset(t, 'minimal');
    const missing = [
      ['no email', { password: PW, display_name: 'X' }],
      ['no password', { email: 'm1@example.com', display_name: 'X' }],
    ];
    for (const [label, body] of missing) {
      const res = await api(t, { method: 'POST', path: '/auth/signup', body });
      t.err(res, 422, 'validation_failed', { ref: 'R5.8', what: `signup with ${label}` });
    }
    const wrongType = [
      ['a numeric email', { email: 123, password: PW, display_name: 'X' }],
      ['a numeric password', { email: 'm2@example.com', password: 12345678, display_name: 'X' }],
      ['a null email', { email: null, password: PW, display_name: 'X' }],
      ['an object email', { email: { a: 1 }, password: PW, display_name: 'X' }],
    ];
    for (const [label, body] of wrongType) {
      const res = await api(t, { method: 'POST', path: '/auth/signup', body });
      t.err(res, 400, 'malformed_request', { ref: 'R5.2', what: `signup with ${label}` });
    }
    for (const [label, body] of [['no email', { password: PW }], ['no password', { email: 'ada@example.com' }]]) {
      const res = await api(t, { method: 'POST', path: '/auth/login', body });
      t.err(res, 422, 'validation_failed', { ref: 'R5.8', what: `login with ${label}` });
    }
  });

  test('field validation precedes the email and handle conflict checks', ['D6'], async (t) => {
    await reset(t, 'eur');
    const short = await api(t, { method: 'POST', path: '/auth/signup', body: { email: 'ada@example.com', password: 'short', display_name: 'X' } });
    t.err(short, 422, 'validation_failed', {
      ref: 'D6', what: 'signup with a seeded email and a 5-character password',
    });
    const both = await api(t, { method: 'POST', path: '/auth/signup', body: { email: 'ada@example.com', password: PW, display_name: 'X' } });
    t.err(both, 409, 'email_taken', {
      ref: 'D6', what: 'signup where the email and the derived handle are both taken',
    });
  }, {
    severity: 'advisory',
    why: 'The specification lists the signup cases in a table without stating an evaluation order. '
       + 'Decision D6 fixes validation -> email_taken -> handle_taken.',
  });

  test('a signup never mints a user id the fixture already seeded', ['R4.3', 'R1.7', 'R6.10'], async (t) => {
    // The specification's own signup example returns "user_id": "u_1", and its fixture
    // example seeds ids of exactly that shape, so a fixture seeding u_1 is ordinary input.
    // If a generated id can collide with a seeded one, the seeded account is displaced and
    // its bearer token starts resolving to somebody else.
    for (const seededId of ['u_1', 'u_2', 'u_3']) {
      const fx = {
        currency: 'EUR', minor_units: 2,
        users: [{ id: seededId, email: 'seeded@example.com', password: PW, display_name: 'Seeded', handle: 'seeded', balance: 777 }],
        payments: [], requests: [],
      };
      await resetWith(t, fx, 204);
      const seeded = await login(t, 'seeded@example.com');
      if (!seeded) continue;
      const before = await me(t, seeded.token);
      if (!t.status(before, 200, { ref: 'R8.1', what: `GET /me for the seeded user (fixture id ${seededId})` })) continue;

      const minted = [];
      for (let i = 0; i < 4; i++) {
        const res = await signup(t, `fresh${i}-${seededId}@example.com`, `Fresh ${i}`);
        if (!t.status(res, 201, { ref: 'R6.1', what: `signup number ${i + 1}` })) break;
        minted.push(res.json.user_id);
      }
      t.ok(!minted.includes(seededId), {
        ref: 'R4.3', what: `ids minted by signup while ${seededId} was seeded`,
        expected: `no minted id equal to the seeded id ${seededId}`,
        actual: `minted ${JSON.stringify(minted)}`,
      });

      // The decisive check: the seeded user's own token must still be the seeded user.
      const after = await me(t, seeded.token);
      if (!t.status(after, 200, { ref: 'R6.10', what: "the seeded user's token after four signups" })) continue;
      t.deep(
        { user_id: after.json.user_id, handle: after.json.handle, balance: after.json.balance },
        { user_id: before.json.user_id, handle: before.json.handle, balance: before.json.balance },
        {
          ref: 'R6.10',
          what: `the seeded user's own bearer token still identifies the seeded user (fixture id ${seededId})`,
          res: after,
        },
      );
    }
  });

  test('reset stays inside the budget even when no two seeded passwords match', ['R10.9', 'R2.6'], async (t) => {
    // The companion blocking check seeds one shared password, which is what this repo's
    // fixtures and the specification's example do. This one removes that regularity: the
    // specification permits it, and nothing about a fixture promises repeated passwords.
    const users = [];
    for (let i = 0; i < 500; i++) {
      users.push({
        id: `u_${i}`, email: `u${i}@example.com`, password: `distinct-password-${i}`,
        display_name: `User ${i}`, handle: `u${i}`, balance: 100,
      });
    }
    const res = await resetWith(t, { currency: 'EUR', minor_units: 2, users, payments: [], requests: [] }, null);
    t.status(res, 204, { ref: 'R3.3', what: 'POST /_test/reset with 500 distinct passwords' });
    t.ok(res.ms <= 10000, {
      ref: 'R10.9', what: 'POST /_test/reset duration with 500 distinct seeded passwords', res,
      expected: 'at most 10000 ms', actual: `${res.ms} ms`,
    });
  }, {
    slow: true,
    severity: 'advisory',
    why: 'The 10 s budget is stated, and a fixture of 500 distinct passwords is permitted, so '
       + 'strictly this is the same requirement as the blocking shared-password check. It is '
       + 'advisory because the input compounds two choices the specification never makes: how '
       + 'many users a fixture seeds, and that none of their passwords repeat. Recorded so the '
       + 'residual cost of per-password hashing stays visible rather than being hidden by a '
       + 'memoisation that the common case happens to satisfy.',
  });

  test('no plaintext password is recoverable from the exported state', ['R6.11'], async (t) => {
    await reset(t, 'eur');
    await signup(t, 'hashme@example.com', 'Hash Me', 'a very secret passphrase');
    const res = await api(t, { path: '/_test/export' });
    if (!t.status(res, 200, { ref: 'R10.2', what: 'GET /_test/export' })) return;
    for (const secret of [PW, 'a very secret passphrase']) {
      t.ok(!res.text.includes(secret), {
        ref: 'R6.11', what: `the literal password ${JSON.stringify(secret)} in the export`, res,
        expected: 'the password not to appear anywhere in the exported state',
        actual: 'the plaintext password appears in the export body',
      });
    }
    // A reversible encoding is not hashing either.
    const b64 = Buffer.from(PW, 'utf8').toString('base64');
    const hex = Buffer.from(PW, 'utf8').toString('hex');
    t.ok(!res.text.includes(b64) && !res.text.toLowerCase().includes(hex), {
      ref: 'R6.11', what: 'the password base64- or hex-encoded in the export', res,
      expected: 'no reversible encoding of the password in the exported state',
      actual: 'a base64 or hex encoding of the fixture password appears in the export body',
    });
  });

  test('a new account can receive money and be asked for money immediately', ['R4.8'], async (t) => {
    await reset(t, 'eur');
    const fresh = await signup(t, 'fresh@example.com', 'Fresh');
    if (!t.status(fresh, 201, { ref: 'R6.1', what: 'signup' })) return;
    const ada = await login(t, 'ada@example.com');
    if (!ada) return;
    const paid = await api(t, { method: 'POST', path: '/payments', token: ada.token, idemKey: key('fresh'), body: { to_handle: 'fresh', amount: 250 } });
    t.status(paid, 201, { ref: 'R4.8', what: 'paying a brand new account' });
    const m = await me(t, fresh.json.token);
    t.eq(m.json && m.json.balance, 250, { ref: 'R4.8', what: 'the new account balance after receiving', res: m });
    const asked = await api(t, { method: 'POST', path: '/requests', token: ada.token, idemKey: key('fresh'), body: { payer_handle: 'fresh', amount: 10 } });
    t.status(asked, 201, { ref: 'R4.8', what: 'requesting money from a brand new account' });
  });
});
