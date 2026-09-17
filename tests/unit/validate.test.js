import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRegistration, MAX_ORGS_PER_KIND } from '../../public/shared/validate.js';

const base = () => ({
  from_type: 'factory',
  name: '  Rahim Uddin ',
  email: ' rahim@example.com ',
  phone: '+880 1711-000000',
  website: '',
  orgs: [
    { kind: 'supplier', org_id: 1, code: ' S-1 ' },
    { kind: 'factory', other_name: ' Rainbow Knit Ltd ', code: '30001' },
  ],
});

const fieldsFor = (overrides) => {
  const result = validateRegistration({ ...base(), ...overrides });
  return result.ok ? {} : result.fields;
};

const twoOrgs = (supplierEntry) => [supplierEntry, { kind: 'factory', org_id: 2, code: 'F' }];

test('accepts a valid payload, trims every string and drops unknown keys', () => {
  const result = validateRegistration(base());
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    from_type: 'factory',
    name: 'Rahim Uddin',
    email: 'rahim@example.com',
    phone: '+880 1711-000000',
    orgs: [
      { kind: 'supplier', org_id: 1, code: 'S-1' },
      { kind: 'factory', other_name: 'Rainbow Knit Ltd', code: '30001' },
    ],
  });
});

test('from_type must be supplier or factory', () => {
  assert.ok(fieldsFor({ from_type: 'buyer' }).from_type);
  assert.ok(fieldsFor({ from_type: undefined }).from_type);
});

test('name must be 2–100 characters', () => {
  assert.ok(fieldsFor({ name: 'A' }).name);
  assert.equal(fieldsFor({ name: 'Ab' }).name, undefined);
  assert.equal(fieldsFor({ name: 'a'.repeat(100) }).name, undefined);
  assert.ok(fieldsFor({ name: 'a'.repeat(101) }).name);
});

test('email must look valid and be at most 254 characters', () => {
  assert.ok(fieldsFor({ email: 'not-an-email' }).email);
  assert.ok(fieldsFor({ email: 'a b@example.com' }).email);
  assert.ok(fieldsFor({ email: '' }).email);
  assert.equal(fieldsFor({ email: `${'a'.repeat(242)}@example.com` }).email, undefined);
  assert.ok(fieldsFor({ email: `${'a'.repeat(243)}@example.com` }).email);
});

test('phone allows digits, spaces, + - ( ) and needs 7–15 digits', () => {
  assert.equal(fieldsFor({ phone: '1234567' }).phone, undefined);
  assert.ok(fieldsFor({ phone: '123456' }).phone);
  assert.equal(fieldsFor({ phone: '+1 (234) 567-890-12345' }).phone, undefined);
  assert.ok(fieldsFor({ phone: '1234567890123456' }).phone);
  assert.ok(fieldsFor({ phone: '12345678x' }).phone);
});

test('each organisation needs a 1–30 character code', () => {
  const withCode = (code) => fieldsFor({ orgs: twoOrgs({ kind: 'supplier', org_id: 1, code }) });
  assert.ok(withCode('  ')['orgs.0.code']);
  assert.equal(withCode('c'.repeat(30))['orgs.0.code'], undefined);
  assert.ok(withCode('c'.repeat(31))['orgs.0.code']);
});

test('a new organisation name must be 2–150 characters', () => {
  const withOther = (other_name) => fieldsFor({ orgs: twoOrgs({ kind: 'supplier', other_name, code: 'S' }) });
  assert.ok(withOther('A')['orgs.0.other_name']);
  assert.equal(withOther('Ab')['orgs.0.other_name'], undefined);
  assert.equal(withOther('a'.repeat(150))['orgs.0.other_name'], undefined);
  assert.ok(withOther('a'.repeat(151))['orgs.0.other_name']);
});

test('each entry needs exactly one of org_id or other_name, and org_id must be a positive integer', () => {
  const entry = (extra) => fieldsFor({ orgs: twoOrgs({ kind: 'supplier', code: 'S', ...extra }) });
  assert.ok(entry({})['orgs.0']);
  assert.ok(entry({ org_id: 1, other_name: 'Both' })['orgs.0']);
  assert.ok(entry({ org_id: '1' })['orgs.0']);
  assert.ok(entry({ org_id: 0 })['orgs.0']);
  assert.ok(entry({ org_id: 1, kind: 'buyer' })['orgs.0.kind']);
});

test('needs 1–10 suppliers and 1–10 factories', () => {
  assert.ok(fieldsFor({ orgs: [{ kind: 'factory', org_id: 2, code: 'F' }] }).suppliers);
  assert.ok(fieldsFor({ orgs: [{ kind: 'supplier', org_id: 1, code: 'S' }] }).factories);
  const factories = (n) => Array.from({ length: n }, (_, i) => ({ kind: 'factory', org_id: i + 10, code: 'F' }));
  const supplier = { kind: 'supplier', org_id: 1, code: 'S' };
  assert.equal(fieldsFor({ orgs: [supplier, ...factories(MAX_ORGS_PER_KIND)] }).factories, undefined);
  assert.ok(fieldsFor({ orgs: [supplier, ...factories(MAX_ORGS_PER_KIND + 1)] }).factories);
});

test('handles missing or malformed input without throwing', () => {
  assert.equal(validateRegistration(undefined).ok, false);
  assert.equal(validateRegistration({ orgs: [null, 'x'] }).ok, false);
});
