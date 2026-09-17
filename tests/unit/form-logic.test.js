import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPayload, escapeHtml, isListed, orderRows, pickerOptions, seatInfo } from '../../public/shared/form-logic.js';

const factory = (id, seats_used, name = `Factory ${id}`) => ({ id, kind: 'factory', name, seats_used });
const supplier = (id, seats_used, name = `Supplier ${id}`) => ({ id, kind: 'supplier', name, seats_used });

test('escapeHtml escapes the five HTML-special characters and handles null', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(escapeHtml(null), '');
});

test('seatInfo shows hints only for the side the person is from', () => {
  assert.deepEqual(seatInfo(factory(1, 0), null), { left: null, full: false, label: '' });
  assert.deepEqual(seatInfo(factory(1, 0), 'supplier'), { left: null, full: false, label: '' });
  assert.deepEqual(seatInfo(factory(1, 0), 'factory'), { left: 2, full: false, label: '· 2 seats left' });
  assert.deepEqual(seatInfo(factory(1, 1), 'factory'), { left: 1, full: false, label: '· 1 seat left' });
  assert.deepEqual(seatInfo(factory(1, 2), 'factory'), { left: 0, full: true, label: '(full)' });
  assert.deepEqual(seatInfo(factory(1, 3), 'factory'), { left: 0, full: true, label: '(full)' });
});

test('seatInfo ignores the edited person\'s own seat', () => {
  assert.deepEqual(seatInfo(factory(1, 2), 'factory', true), { left: 1, full: false, label: '· 1 seat left' });
});

test('seatInfo never marks an org full where the person already holds a seat (e.g. after merge anyway)', () => {
  assert.deepEqual(seatInfo(factory(1, 3), 'factory', true), { left: 1, full: false, label: '· 1 seat left' });
});

test('pickerOptions filters by kind, hides selected ones and disables full ones', () => {
  const orgs = [supplier(1, 2), factory(2, 2), factory(3, 0), factory(4, 1)];
  assert.deepEqual(
    pickerOptions(orgs, { kind: 'factory', fromType: 'factory', selectedIds: new Set([4]) }),
    [
      { value: '2', text: 'Factory 2', hint: '(full)', disabled: true },
      { value: '3', text: 'Factory 3', hint: '· 2 seats left', disabled: false },
    ],
  );
  assert.deepEqual(
    pickerOptions(orgs, { kind: 'supplier', fromType: 'factory' }),
    [{ value: '1', text: 'Supplier 1', hint: '', disabled: false }],
  );
  assert.equal(
    pickerOptions(orgs, { kind: 'factory', fromType: 'factory', ownSeatIds: new Set([2]) })[0].disabled,
    false,
  );
});

test('buildPayload turns rows into listed and new organisation entries', () => {
  assert.deepEqual(buildPayload({
    fromType: 'factory', name: 'N', email: 'e', phone: 'p', website: '',
    rows: [
      { key: 1, kind: 'supplier', org_id: 7, name: 'Padma', code: 'S' },
      { key: 2, kind: 'factory', other_name: 'Rainbow', code: 'F' },
    ],
  }), {
    from_type: 'factory', name: 'N', email: 'e', phone: 'p', website: '',
    orgs: [
      { kind: 'supplier', org_id: 7, code: 'S' },
      { kind: 'factory', other_name: 'Rainbow', code: 'F' },
    ],
  });
});

test('orderRows puts suppliers before factories and keeps order within each kind', () => {
  const rows = [
    { key: 1, kind: 'factory' }, { key: 2, kind: 'supplier' }, { key: 3, kind: 'factory' }, { key: 4, kind: 'supplier' },
  ];
  assert.deepEqual(orderRows(rows).map((r) => r.key), [2, 4, 1, 3]);
});

test('isListed is true only for rows picked from the list (org_id present, including 0)', () => {
  assert.equal(isListed({ kind: 'supplier', org_id: 7 }), true);
  assert.equal(isListed({ kind: 'supplier', org_id: 0 }), true);
  assert.equal(isListed({ kind: 'supplier', org_id: null, other_name: 'New' }), false);
  assert.equal(isListed({ kind: 'supplier', other_name: 'New' }), false);
});
