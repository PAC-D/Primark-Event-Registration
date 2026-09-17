import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COOKIE_NAME, SESSION_SECONDS, clearCookieOptions, cookieOptions, passwordMatches, requireAdmin, signSession, verifySession,
} from '../../src/auth.js';

const secret = 's'.repeat(32);
const now = 1_800_000_000;

test('a freshly signed session verifies until it expires', () => {
  const value = signSession(secret, now);
  assert.equal(verifySession(value, secret, now), true);
  assert.equal(verifySession(value, secret, now + SESSION_SECONDS - 1), true);
  assert.equal(verifySession(value, secret, now + SESSION_SECONDS), false);
});

test('tampered, foreign or malformed sessions are rejected', () => {
  const value = signSession(secret, now);
  const [expiry, signature] = value.split('.');
  const flippedLast = signature.at(-1) === 'A' ? 'B' : 'A';
  assert.equal(verifySession(`${Number(expiry) + 9999}.${signature}`, secret, now), false);
  assert.equal(verifySession(`${expiry}.${signature.slice(0, -1)}${flippedLast}`, secret, now), false);
  assert.equal(verifySession(value, 'x'.repeat(32), now), false);
  for (const junk of [undefined, '', 'abc', 'a.b.c', '.']) assert.equal(verifySession(junk, secret, now), false);
});

test('passwordMatches compares exactly and tolerates missing input', () => {
  assert.equal(passwordMatches('correct horse', 'correct horse'), true);
  assert.equal(passwordMatches('correct horse ', 'correct horse'), false);
  assert.equal(passwordMatches(undefined, 'correct horse'), false);
});

test('cookie options follow the spec', () => {
  assert.deepEqual(cookieOptions({ isProduction: true }), {
    httpOnly: true, sameSite: 'strict', path: '/', maxAge: SESSION_SECONDS * 1000, secure: true,
  });
  assert.deepEqual(clearCookieOptions({ isProduction: false }), { httpOnly: true, sameSite: 'strict', path: '/', secure: false });
});

test('requireAdmin passes a valid cookie and rejects everything else with UNAUTHORISED', () => {
  const guard = requireAdmin({ sessionSecret: secret });
  const run = (cookies) => {
    let received = 'not called';
    guard({ cookies }, {}, (err) => { received = err; });
    return received;
  };
  assert.equal(run({ [COOKIE_NAME]: signSession(secret) }), undefined);
  assert.equal(run({}).code, 'UNAUTHORISED');
  assert.equal(run({ [COOKIE_NAME]: 'forged.value' }).status, 401);
});
