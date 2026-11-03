import { randomUUID } from 'node:crypto';
import { before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createCredential, credentialHash } from '../../src/services/credential.js';
import { check, payload, pick, register, seedOrgs, skipReason, testDb, wipe } from '../helpers/db.js';

describe('credentials and attendance', { skip: skipReason }, () => {
  let db;
  let fixture;

  before(() => { db = testDb(); });
  beforeEach(async () => {
    await wipe(db);
    const { factory } = await seedOrgs(db, {
      factory: { kind: 'factory', name: 'Attendance Test Factory', code: 'AT-1' },
    });
    const attendeeId = await check(register(db, payload({ orgs: [pick(factory)] })));
    const [event] = await check(db.from('events').insert({
      code: 'attendance-test', name: 'Attendance Test', status: 'open',
    }).select('id'));
    const days = await check(db.from('event_days').insert([
      { event_id: event.id, event_date: '2030-01-01', label: 'Day 1' },
      { event_id: event.id, event_date: '2030-01-02', label: 'Day 2' },
    ]).select('id, label'));
    const [registration] = await check(db.from('event_registrations').insert({
      event_id: event.id, attendee_id: attendeeId,
    }).select('id'));
    const credential = createCredential();
    await check(db.rpc('issue_registration_credential', {
      p_registration_id: registration.id,
      p_token_hash: credential.tokenHash,
      p_fallback_code_hash: credential.fallbackHash,
    }));
    fixture = { attendeeId, event, days, registration, credential };
  });

  const scan = (hash, dayId, scanId = randomUUID()) => db.rpc('check_in_registration', {
    p_credential_hash: hash,
    p_event_day_id: dayId,
    p_scan_id: scanId,
    p_device_id: 'test-device',
    p_scanned_at_device: new Date().toISOString(),
    p_source: 'online',
  });

  test('first scan checks in, repeats are idempotent, and another day is independent', async () => {
    const firstId = randomUUID();
    assert.equal((await check(scan(fixture.credential.tokenHash, fixture.days[0].id, firstId))).status, 'CHECKED_IN');
    assert.equal((await check(scan(fixture.credential.tokenHash, fixture.days[0].id, firstId))).status, 'ALREADY_CHECKED_IN');
    assert.equal((await check(scan(fixture.credential.tokenHash, fixture.days[0].id))).status, 'ALREADY_CHECKED_IN');
    assert.equal((await check(scan(fixture.credential.tokenHash, fixture.days[1].id))).status, 'CHECKED_IN');
    assert.equal((await check(db.from('attendance').select('id'))).length, 2);
  });

  test('manual name selection checks in the selected registration without a credential', async () => {
    const result = await check(db.rpc('check_in_registration_manual', {
      p_registration_id: fixture.registration.id,
      p_event_day_id: fixture.days[0].id,
      p_scan_id: randomUUID(),
      p_device_id: 'manual-test',
      p_scanned_at_device: new Date().toISOString(),
    }));
    assert.equal(result.status, 'CHECKED_IN');
    assert.equal(result.registration_id, fixture.registration.id);
    const [row] = await check(db.from('attendance')
      .select('source').eq('registration_id', fixture.registration.id));
    assert.equal(row.source, 'manual');
  });

  test('a registration credential cannot be rotated', async () => {
    const replacement = createCredential();
    const { error } = await db.rpc('issue_registration_credential', {
      p_registration_id: fixture.registration.id,
      p_token_hash: replacement.tokenHash,
      p_fallback_code_hash: replacement.fallbackHash,
    });
    assert.equal(error?.message, 'IMMUTABLE_CREDENTIAL');
    assert.equal((await check(scan(fixture.credential.tokenHash, fixture.days[0].id))).status, 'CHECKED_IN');
    assert.equal((await check(scan(replacement.tokenHash, fixture.days[0].id))).status, 'INVALID');
    const credentials = await check(db.from('registration_credentials').select('status').eq('registration_id', fixture.registration.id));
    assert.deepEqual(credentials.map((row) => row.status), ['active']);
  });

  test('emergency recovery restores a distributed token on the same credential UUID', async () => {
    const distributed = createCredential();
    const [before] = await check(db.from('registration_credentials')
      .select('id').eq('registration_id', fixture.registration.id));
    const restoredRegistrationId = await check(db.rpc('restore_distributed_credential', {
      p_current_token_hash: fixture.credential.tokenHash,
      p_distributed_token_hash: distributed.tokenHash,
      p_distributed_token: distributed.token,
    }));
    assert.equal(restoredRegistrationId, fixture.registration.id);
    const [after] = await check(db.from('registration_credentials')
      .select('id, token_hash, print_token').eq('registration_id', fixture.registration.id));
    assert.equal(after.id, before.id);
    assert.equal(after.token_hash, distributed.tokenHash);
    assert.equal(after.print_token, distributed.token);
    assert.equal((await check(scan(fixture.credential.tokenHash, fixture.days[0].id))).status, 'INVALID');
    assert.equal((await check(scan(distributed.tokenHash, fixture.days[0].id))).status, 'CHECKED_IN');
    const logs = await check(db.from('credential_recovery_log').select('credential_id, registration_id'));
    assert.deepEqual(logs, [{ credential_id: before.id, registration_id: fixture.registration.id }]);
  });

  test('print preparation cannot replace a hash-only credential', async () => {
    const first = createCredential();
    const prepare = (credential) => db.rpc('prepare_event_credentials', {
      p_event_id: fixture.event.id,
      p_items: [{
        registration_id: fixture.registration.id,
        token_hash: credential.tokenHash,
        fallback_code_hash: credential.fallbackHash,
        print_token: credential.token,
        fallback_code: credential.fallback,
      }],
    });
    const { error } = await prepare(first);
    assert.equal(error?.message, 'IMMUTABLE_CREDENTIAL');
    const [stored] = await check(db.from('registration_credentials')
      .select('token_hash, status').eq('registration_id', fixture.registration.id));
    assert.equal(stored.token_hash, fixture.credential.tokenHash);
    assert.equal(stored.status, 'active');
  });

  test('new attendees automatically join the current event with organisation snapshots', async () => {
    const { factory } = await seedOrgs(db, {
      factory: { kind: 'factory', name: 'New Registration Factory', code: 'NEW-1' },
    });
    const attendeeId = await check(register(db, payload({ email: 'new-event-link@example.com', orgs: [pick(factory)] })));
    const registrations = await check(db.from('event_registrations')
      .select('id, registration_orgs(kind, name, code)')
      .eq('event_id', fixture.event.id)
      .eq('attendee_id', attendeeId));
    assert.equal(registrations.length, 1);
    assert.deepEqual(registrations[0].registration_orgs, [{ kind: 'factory', name: 'New Registration Factory', code: 'NEW-1' }]);
  });

  test('invalid, wrong-event, cancelled, and closed-event scans return stable statuses', async () => {
    assert.equal((await check(scan(credentialHash('ER1.unknown'), fixture.days[0].id))).status, 'INVALID');
    assert.equal((await check(scan(fixture.credential.tokenHash, randomUUID()))).status, 'WRONG_EVENT');
    await check(db.from('event_registrations').update({ status: 'cancelled' }).eq('id', fixture.registration.id));
    assert.equal((await check(scan(fixture.credential.tokenHash, fixture.days[0].id))).status, 'REVOKED');
    await check(db.from('event_registrations').update({ status: 'confirmed' }).eq('id', fixture.registration.id));
    await check(db.from('events').update({ status: 'closed' }).eq('id', fixture.event.id));
    assert.equal((await check(scan(fixture.credential.tokenHash, fixture.days[0].id))).status, 'OUTSIDE_CHECKIN_WINDOW');
  });
  test('delete_attendance removes the row for that registration and day', async () => {
    await check(scan(fixture.credential.tokenHash, fixture.days[0].id));
    assert.equal((await check(db.from('attendance').select('id').eq('event_day_id', fixture.days[0].id))).length, 1);
    await check(db.rpc('delete_attendance', {
      p_registration_id: fixture.registration.id,
      p_event_day_id: fixture.days[0].id,
    }));
    assert.equal((await check(db.from('attendance').select('id').eq('event_day_id', fixture.days[0].id))).length, 0);
  });

  test('delete_attendance leaves another day untouched', async () => {
    await check(scan(fixture.credential.tokenHash, fixture.days[0].id));
    await check(scan(fixture.credential.tokenHash, fixture.days[1].id));
    await check(db.rpc('delete_attendance', {
      p_registration_id: fixture.registration.id,
      p_event_day_id: fixture.days[0].id,
    }));
    const remaining = await check(db.from('attendance').select('event_day_id'));
    assert.deepEqual(remaining.map((row) => row.event_day_id), [fixture.days[1].id]);
  });

  test('delete_attendance raises NOT_FOUND when there is no check-in to delete', async () => {
    const { error } = await db.rpc('delete_attendance', {
      p_registration_id: fixture.registration.id,
      p_event_day_id: fixture.days[0].id,
    });
    assert.equal(error?.message, 'NOT_FOUND');
  });

  test('a deleted check-in can be scanned again', async () => {
    await check(scan(fixture.credential.tokenHash, fixture.days[0].id));
    await check(db.rpc('delete_attendance', {
      p_registration_id: fixture.registration.id,
      p_event_day_id: fixture.days[0].id,
    }));
    assert.equal((await check(scan(fixture.credential.tokenHash, fixture.days[0].id))).status, 'CHECKED_IN');
  });
});
