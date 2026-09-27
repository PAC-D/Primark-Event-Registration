import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPayload, escapeHtml, orderRows, pickerOptions, seatInfo } from '../../public/shared/form-logic.js';

const supplierOrg = (seats_used) => ({ id: 1, kind: 'supplier', name: 'A Supplier', seats_used });
const factoryOrg = (seats_used) => ({ id: 2, kind: 'factory', name: 'A Factory', seats_used });

test('escapeHtml escapes the five HTML-special characters and handles null', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(escapeHtml(null), '');
});

test('suppliers allow 2 seats, factories 1', () => {
  assert.deepEqual(seatInfo(supplierOrg(0), 'supplier'), { left: 2, full: false, label: '· 2 seats left' });
  assert.deepEqual(seatInfo(supplierOrg(2), 'supplier'), { left: 0, full: true, label: '(full)' });
  assert.deepEqual(seatInfo(factoryOrg(0), 'factory'), { left: 1, full: false, label: '· 1 seat left' });
  assert.deepEqual(seatInfo(factoryOrg(1), 'factory'), { left: 0, full: true, label: '(full)' });
});

test('no hints for the other side, other attendees, or a null from-type', () => {
  assert.deepEqual(seatInfo(supplierOrg(0), 'factory'), { left: null, full: false, label: '' });
  assert.deepEqual(seatInfo(supplierOrg(0), 'other'), { left: null, full: false, label: '' });
  assert.deepEqual(seatInfo(supplierOrg(0), null), { left: null, full: false, label: '' });
});

test('an own seat never counts as full even when at the limit', () => {
  assert.deepEqual(seatInfo(factoryOrg(1), 'factory', true), { left: 1, full: false, label: '· 1 seat left' });
  assert.deepEqual(seatInfo(supplierOrg(2), 'supplier', true), { left: 1, full: false, label: '· 1 seat left' });
});

test('pickerOptions lists org names only — seat status is not disclosed upfront', () => {
  const options = pickerOptions([supplierOrg(2), factoryOrg(1)], { kind: 'factory', fromType: 'factory' });
  assert.deepEqual(options, [{ value: '2', text: 'A Factory' }]);
});

test('buildPayload sends org_ids without codes for supplier/factory attendees', () => {
  const payload = buildPayload({
    fromType: 'factory', name: 'N', email: 'e@x.com', phone: '1234567', designation: 'D',
    rows: [{ kind: 'factory', org_id: 2 }, { kind: 'supplier', org_id: 1 }],
  });
  assert.deepEqual(payload, {
    from_type: 'factory', name: 'N', email: 'e@x.com', phone: '1234567', designation: 'D', website: '',
    orgs: [{ kind: 'factory', org_id: 2 }, { kind: 'supplier', org_id: 1 }],
  });
});

test('buildPayload for other attendees carries organisation_name, no orgs; photo_path only when set', () => {
  const baseArgs = { fromType: 'other', name: 'N', email: 'e@x.com', phone: '1234567', designation: 'D', organisationName: 'Primark Limited' };
  assert.deepEqual(buildPayload(baseArgs), {
    from_type: 'other', name: 'N', email: 'e@x.com', phone: '1234567', designation: 'D', website: '',
    organisation_name: 'Primark Limited', orgs: [],
  });
  const withPhoto = buildPayload({ ...baseArgs, photoPath: '123e4567-e89b-42d3-a456-426614174000.png' });
  assert.equal(withPhoto.photo_path, '123e4567-e89b-42d3-a456-426614174000.png');
});

test('orderRows puts suppliers before factories and keeps order within each kind', () => {
  const rows = [
    { key: 1, kind: 'factory' }, { key: 2, kind: 'supplier' }, { key: 3, kind: 'factory' }, { key: 4, kind: 'supplier' },
  ];
  assert.deepEqual(orderRows(rows).map((r) => r.key), [2, 4, 1, 3]);
});
