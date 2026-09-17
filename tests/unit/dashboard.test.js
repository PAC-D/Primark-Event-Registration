import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboard, registrationStatus } from '../../src/services/dashboard.js';
import { fixtureAttendees, fixtureNow, fixtureOrgs } from '../helpers/dashboard-fixture.js';

const data = () => buildDashboard({ orgs: fixtureOrgs, attendees: fixtureAttendees, now: fixtureNow });

test('registrationStatus: full at 2+ seats, registered when linked, otherwise missing', () => {
  assert.equal(registrationStatus({ seats_used: 2, linked_count: 2 }), 'full');
  assert.equal(registrationStatus({ seats_used: 3, linked_count: 3 }), 'full');
  assert.equal(registrationStatus({ seats_used: 0, linked_count: 1 }), 'registered');
  assert.equal(registrationStatus({ seats_used: 0, linked_count: 0 }), 'missing');
});

test('summary counts participants, list coverage, missing, full and pending', () => {
  const d = data();
  assert.equal(d.generated_at, '2026-09-17T08:30:00.000Z');
  assert.deepEqual(d.summary, {
    participants: { total: 3, supplier: 1, factory: 2 },
    suppliers: { list_total: 2, list_registered: 1, missing: 2, full: 0 },
    factories: { list_total: 2, list_registered: 1, missing: 1, full: 1 },
    pending: 1,
  });
});

test('participants carry their organisations split by kind, sorted by name, with seat usage', () => {
  const [rahim] = data().participants;
  assert.equal(rahim.email, 'rahim@example.com');
  assert.deepEqual(rahim.suppliers, [
    { org_id: 1, name: 'Padma Textiles Ltd', code: 'S-1', status: 'approved', uses_seat: false },
  ]);
  assert.deepEqual(rahim.factories, [
    { org_id: 3, name: 'Aspire Garments (24040)', code: 'F-3', status: 'approved', uses_seat: true },
    { org_id: 5, name: 'Rainbow Knit Ltd', code: 'R-5', status: 'pending', uses_seat: true },
  ]);
});

test('organisations list only approved ones, with status and people', () => {
  const d = data();
  assert.deepEqual(d.organisations.map((o) => o.name), [
    'Aspire Garments (24040)', 'New Supplier Co', 'Padma Textiles Ltd', 'Pearl Global', 'Windy Apparels (20096)',
  ]);
  const aspire = d.organisations[0];
  assert.equal(aspire.reg_status, 'full');
  assert.deepEqual(aspire.people, [
    { id: 'a1', name: 'Rahim Uddin', from_type: 'factory', code: 'F-3' },
    { id: 'a2', name: 'Karim Ahmed', from_type: 'factory', code: 'F-3b' },
  ]);
  assert.equal(d.organisations.find((o) => o.name === 'Pearl Global').reg_status, 'missing');
});

test('pending organisations are listed separately with the codes people typed', () => {
  const { pending } = data();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].name, 'Rainbow Knit Ltd');
  assert.deepEqual(pending[0].people, [{ id: 'a1', name: 'Rahim Uddin', from_type: 'factory', code: 'R-5' }]);
});

test('links to organisations missing from the org list are ignored', () => {
  const attendees = [{ ...fixtureAttendees[1], attendee_orgs: [{ org_id: 999, code: 'X' }, { org_id: 3, code: 'F' }] }];
  const d = buildDashboard({ orgs: fixtureOrgs, attendees, now: fixtureNow });
  assert.deepEqual(d.participants[0].factories.map((f) => f.org_id), [3]);
});
