import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterOrganisations, filterParticipants, filterPending } from '../../public/shared/admin-filters.js';
import { buildDashboard } from '../../src/services/dashboard.js';
import { fixtureAttendees, fixtureNow, fixtureOrgs } from '../helpers/dashboard-fixture.js';

const data = buildDashboard({ orgs: fixtureOrgs, attendees: fixtureAttendees, now: fixtureNow });
const names = (list) => list.map((x) => x.name);

test('filterParticipants by side', () => {
  assert.deepEqual(names(filterParticipants(data.participants, { side: 'supplier' })), ['Salma Begum']);
  assert.equal(filterParticipants(data.participants, {}).length, 3);
});

test('filterParticipants searches name, email, phone and organisation names, ignoring case', () => {
  assert.deepEqual(names(filterParticipants(data.participants, { search: 'KARIM' })), ['Karim Ahmed']);
  assert.deepEqual(names(filterParticipants(data.participants, { search: 'salma@' })), ['Salma Begum']);
  assert.deepEqual(names(filterParticipants(data.participants, { search: '000001' })), ['Rahim Uddin']);
  assert.deepEqual(names(filterParticipants(data.participants, { search: 'rainbow' })), ['Rahim Uddin']);
  assert.deepEqual(names(filterParticipants(data.participants, { search: 'aspire', side: 'factory' })), ['Rahim Uddin', 'Karim Ahmed']);
});

test('filterOrganisations by kind, status and search over name and people', () => {
  assert.deepEqual(names(filterOrganisations(data.organisations, { kind: 'supplier' })), ['New Supplier Co', 'Padma Textiles Ltd', 'Pearl Global']);
  assert.deepEqual(names(filterOrganisations(data.organisations, { kind: 'supplier', status: 'missing' })), ['New Supplier Co', 'Pearl Global']);
  assert.deepEqual(names(filterOrganisations(data.organisations, { kind: 'factory', status: 'full' })), ['Aspire Garments (24040)']);
  assert.deepEqual(names(filterOrganisations(data.organisations, { kind: 'supplier', search: 'salma' })), ['Padma Textiles Ltd']);
});

test('filterPending searches by name', () => {
  assert.equal(filterPending(data.pending, { search: 'RAIN' }).length, 1);
  assert.equal(filterPending(data.pending, { search: 'zzz' }).length, 0);
});
