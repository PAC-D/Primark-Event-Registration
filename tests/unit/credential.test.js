import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCredential, credentialHash, normaliseFallbackCode, openCredential, scannedCredentialHash, sealCredential,
} from '../../src/services/credential.js';

test('creates an opaque versioned credential and printable fallback code', () => {
  const credential = createCredential({ tokenBytes: Buffer.alloc(24, 1), fallbackBytes: Buffer.alloc(8, 2) });
  assert.match(credential.token, /^ER1\.[A-Za-z0-9_-]{32}$/);
  assert.match(credential.fallback, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(credential.tokenHash, credentialHash(credential.token));
  assert.equal(credential.fallbackHash, credentialHash(normaliseFallbackCode(credential.fallback)));
  assert.notEqual(credential.tokenHash, credential.fallbackHash);
});

test('manual fallback hashing ignores spaces, hyphens and letter case', () => {
  const expected = credentialHash('ABCD2345');
  assert.equal(scannedCredentialHash(' abcd-2345 '), expected);
  assert.equal(scannedCredentialHash('ABCD 2345'), expected);
});

test('QR token hashing preserves the opaque token exactly', () => {
  const token = 'ER1.AbCd_-123';
  assert.equal(scannedCredentialHash(token), credentialHash(token));
});

test('print credentials can be recovered unchanged for stable reprints', () => {
  const credential = createCredential({ tokenBytes: Buffer.alloc(24, 3), fallbackBytes: Buffer.alloc(8, 4) });
  const payload = sealCredential(credential, 's'.repeat(32), Buffer.alloc(12, 5));
  assert.deepEqual(openCredential(payload, 's'.repeat(32)), { token: credential.token, fallback: credential.fallback });
  assert.throws(() => openCredential(payload, 'x'.repeat(32)));
});

