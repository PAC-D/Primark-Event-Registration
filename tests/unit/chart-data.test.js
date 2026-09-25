import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COVERAGE_ORDER, coverageBreakdown, dhakaDay, registrationTimeline } from '../../public/shared/chart-data.js';
import { buildDashboard } from '../../src/services/dashboard.js';
import { fixtureAttendees, fixtureNow, fixtureOrgs } from '../helpers/dashboard-fixture.js';

const data = buildDashboard({ orgs: fixtureOrgs, attendees: fixtureAttendees, now: fixtureNow });

test('dhakaDay buckets timestamps by the Asia/Dhaka calendar day', () => {
  assert.equal(dhakaDay('2026-09-17T17:59:00Z'), '2026-09-17');
  assert.equal(dhakaDay('2026-09-17T18:00:00Z'), '2026-09-18');
});

test('registrationTimeline is empty when nobody has registered', () => {
  assert.deepEqual(registrationTimeline([]), []);
});

test('registrationTimeline counts per Dhaka day with a running total', () => {
  assert.deepEqual(registrationTimeline(data.participants), [{ day: '2026-09-17', count: 4, total: 4 }]);
});

test('registrationTimeline fills days without registrations and ignores input order', () => {
  const participants = [
    { created_at: '2026-09-17T05:00:00Z' },
    { created_at: '2026-09-15T10:00:00Z' },
    { created_at: '2026-09-16T19:30:00Z' }, // 01:30 on 17 Sep in Dhaka
  ];
  assert.deepEqual(registrationTimeline(participants), [
    { day: '2026-09-15', count: 1, total: 1 },
    { day: '2026-09-16', count: 0, total: 1 },
    { day: '2026-09-17', count: 2, total: 3 },
  ]);
});

test('coverageBreakdown counts approved organisations of one kind by registration status', () => {
  assert.deepEqual(coverageBreakdown(data.organisations, 'supplier'), { missing: 2, registered: 1, full: 0, total: 3 });
  assert.deepEqual(coverageBreakdown(data.organisations, 'factory'), { missing: 1, registered: 0, full: 1, total: 2 });
});

test('COVERAGE_ORDER runs from empty to full', () => {
  assert.deepEqual(COVERAGE_ORDER, ['missing', 'registered', 'full']);
});
