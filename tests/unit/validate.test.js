import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRegistration, MAX_ORGS_PER_KIND } from '../../public/shared/validate.js';

const UUID_PATH = '123e4567-e89b-42d3-a456-426614174000.jpg';

const base = () => ({
  from_type: 'factory',
  name: '  Rahim Uddin ',
  designation: ' Merchandiser ',
  email: ' rahim@example.com ',
  phone: '+880 1711-000000',
  website: '',
  orgs: [
    { kind: 'factory', org_id: 2 },
    { kind: 'supplier', org_id: 1 },
  ],
});

const fieldsFor = (overrides) => {
  const result = validateRegistration({ ...base(), ...overrides });
  return result.ok ? {} : result.fields;
};

test('accepts a valid payload, trims strings and drops unknown keys', () => {
  const result = validateRegistration(base());
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    from_type: 'factory',
    name: 'Rahim Uddin',
    designation: 'Merchandiser',
    email: 'rahim@example.com',
    phone: '+880 1711-000000',
    photo_path: null,
    organisation_name: null,
    orgs: [
      { kind: 'factory', org_id: 2 },
      { kind: 'supplier', org_id: 1 },
    ],
  });
});

test('from_type accepts supplier, factory or other and rejects anything else', () => {
  assert.ok(fieldsFor({ from_type: 'buyer' }).from_type);
  assert.ok(fieldsFor({ from_type: undefined }).from_type);
  assert.equal(fieldsFor({ from_type: 'supplier' }).from_type, undefined);
  assert.equal(fieldsFor({ from_type: 'other', organisation_name: 'Primark Limited', orgs: [] }).from_type, undefined);
});

test('designation must be 2–100 characters', () => {
  assert.ok(fieldsFor({ designation: 'A' }).designation);
  assert.equal(fieldsFor({ designation: 'QA Lead' }).designation, undefined);
  assert.equal(fieldsFor({ designation: 'a'.repeat(100) }).designation, undefined);
  assert.ok(fieldsFor({ designation: 'a'.repeat(101) }).designation);
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

test('photo_path is optional but must match the upload-path shape', () => {
  assert.equal(fieldsFor({ photo_path: UUID_PATH }).photo, undefined);
  assert.equal(fieldsFor({ photo_path: null }).photo, undefined);
  assert.equal(fieldsFor({ photo_path: '' }).photo, undefined);
  assert.ok(fieldsFor({ photo_path: 'photos/pic.jpg' }).photo);
  assert.ok(fieldsFor({ photo_path: '123e4567-e89b-42d3-a456-426614174000.gif' }).photo);
});

test('the from-kind needs 1..MAX entries; the other kind is optional up to MAX', () => {
  const factory = (id) => ({ kind: 'factory', org_id: id });
  const supplier = (id) => ({ kind: 'supplier', org_id: id });
  assert.equal(fieldsFor({ orgs: [factory(1)] }).factories, undefined);
  assert.ok(fieldsFor({ orgs: [supplier(1)] }).factories);
  assert.ok(fieldsFor({ orgs: [] }).factories);
  assert.ok(fieldsFor({ orgs: Array.from({ length: 11 }, (_, i) => factory(i + 1)) }).factories);
  assert.equal(fieldsFor({ orgs: [factory(1), ...Array.from({ length: 10 }, (_, i) => supplier(i + 1))] }).suppliers, undefined);
  assert.ok(fieldsFor({ orgs: [factory(1), ...Array.from({ length: 11 }, (_, i) => supplier(i + 1))] }).suppliers);
});

test('supplier-side attendees need a supplier, not a factory', () => {
  assert.equal(fieldsFor({ from_type: 'supplier', orgs: [{ kind: 'supplier', org_id: 1 }] }).suppliers, undefined);
  assert.ok(fieldsFor({ from_type: 'supplier', orgs: [{ kind: 'factory', org_id: 1 }] }).suppliers);
});

test('org entries only take a listed org_id — no codes, no other_name', () => {
  assert.ok(fieldsFor({ orgs: [{ kind: 'factory' }] })['orgs.0']);
  assert.ok(fieldsFor({ orgs: [{ kind: 'factory', org_id: 'x' }] })['orgs.0']);
  assert.ok(fieldsFor({ orgs: [{ kind: 'buyer', org_id: 1 }] })['orgs.0.kind']);
  assert.equal(fieldsFor({ orgs: [{ kind: 'factory', org_id: 2, code: 'IGNORED', other_name: 'dropped' }] }).orgs, undefined);
  const result = validateRegistration({ ...base(), orgs: [{ kind: 'factory', org_id: 2, code: 'IGNORED' }] });
  assert.deepEqual(result.value.orgs, [{ kind: 'factory', org_id: 2 }]);
});

test('"other" attendees need an organisation name of 2–150 chars and no orgs', () => {
  const other = (overrides) => fieldsFor({ from_type: 'other', orgs: [], organisation_name: 'Primark Limited', ...overrides });
  assert.equal(other({}).organisation_name, undefined);
  assert.ok(other({ organisation_name: 'x' }).organisation_name);
  assert.ok(other({ organisation_name: 'a'.repeat(151) }).organisation_name);
  assert.ok(other({ orgs: [{ kind: 'factory', org_id: 1 }] }).orgs);
  const result = validateRegistration({ ...base(), from_type: 'other', orgs: [], organisation_name: ' WAC - Bangladesh ' });
  assert.equal(result.value.organisation_name, 'WAC - Bangladesh');
  assert.deepEqual(result.value.orgs, []);
});
