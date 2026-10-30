import { randomUUID } from 'node:crypto';
import { before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createCredential, credentialHash } from '../../src/services/credential.js';
import { check, payload, pick, register, seedOrgs, skipReason, testDb, wipe } from '../helpers/db.js';

describe('session questions', { skip: skipReason }, () => {
  let db;
  let fixture;

  before(() => { db = testDb(); });

  beforeEach(async () => {
    await wipe(db);
    const { factory } = await seedOrgs(db, {
      factory: { kind: 'factory', name: 'Questions Test Factory', code: 'QT-1' },
    });
    const attendeeId = await check(register(db, payload({
      email: 'questions@example.test', orgs: [pick(factory)],
    })));
    const [event] = await check(db.from('events').insert({
      code: 'questions-test', name: 'Questions Test', status: 'open',
    }).select('id'));
    const days = await check(db.from('event_days').insert([
      { event_id: event.id, event_date: '2030-01-01', label: 'Day 1' },
      { event_id: event.id, event_date: '2030-01-02', label: 'Day 2' },
    ]).select('id, label'));
    const sessions = await check(db.from('event_sessions').insert([
      {
        event_id: event.id, position: 1, title: 'Morning Overview', kind: 'session',
        starts_at: '2030-01-01T03:30:00Z', ends_at: '2030-01-01T04:00:00Z',
      },
      {
        event_id: event.id, position: 2, title: 'Refreshment Break', kind: 'break',
        starts_at: '2030-01-01T04:00:00Z', ends_at: '2030-01-01T04:30:00Z',
      },
      {
        event_id: event.id, position: 3, title: 'Second Day Session', kind: 'session',
        starts_at: '2030-01-02T03:30:00Z', ends_at: '2030-01-02T04:00:00Z',
      },
    ]).select('id, position, kind, title'));
    const [registration] = await check(db.from('event_registrations')
      .insert({ event_id: event.id, attendee_id: attendeeId }).select('id'));
    const credential = createCredential();
    await check(db.rpc('issue_registration_credential', {
      p_registration_id: registration.id,
      p_token_hash: credential.tokenHash,
      p_fallback_code_hash: credential.fallbackHash,
    }));
    // Checked in on Day 1 only. Q&A is not day-scoped, so this unlocks every session.
    await check(db.rpc('check_in_registration', {
      p_credential_hash: credential.tokenHash,
      p_event_day_id: days[0].id,
      p_scan_id: randomUUID(),
      p_device_id: 'questions-test',
      p_scanned_at_device: new Date().toISOString(),
      p_source: 'online',
    }));
    fixture = {
      attendeeId, event, days, registration, credential,
      session: sessions.find((row) => row.position === 1),
      brk: sessions.find((row) => row.position === 2),
      dayTwoSession: sessions.find((row) => row.position === 3),
    };
  });

  const ask = (sessionId, body = 'What is the edge crush tolerance?', hash = null) => db.rpc('ask_session_question', {
    p_credential_hash: hash ?? fixture.credential.tokenHash,
    p_session_id: sessionId,
    p_body: body,
  });
  const askStatus = async (...args) => (await check(ask(...args))).status;
  const backdate = (seconds) => db.from('session_questions')
    .update({ asked_at: new Date(Date.now() - seconds * 1000).toISOString() })
    .eq('registration_id', fixture.registration.id);

  test('a checked-in attendee asks a question and the row is stored', async () => {
    const result = await check(ask(fixture.session.id));
    assert.equal(result.status, 'ASKED');
    assert.ok(result.question_id);
    assert.ok(result.asked_at);
    const rows = await check(db.from('session_questions').select('session_id, registration_id, body'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].session_id, fixture.session.id);
    assert.equal(rows[0].registration_id, fixture.registration.id);
    assert.equal(rows[0].body, 'What is the edge crush tolerance?');
  });

  test('a fallback code works as well as the printed QR token', async () => {
    assert.equal(await askStatus(fixture.session.id, 'Asked by code', fixture.credential.fallbackHash), 'ASKED');
  });

  test('attendance on day 1 unlocks a session scheduled on day 2', async () => {
    assert.equal(await askStatus(fixture.dayTwoSession.id), 'ASKED');
  });

  test('an unknown credential returns INVALID', async () => {
    assert.equal(await askStatus(fixture.session.id, 'Anybody there?', credentialHash('ER1.unknown')), 'INVALID');
  });

  test('an unknown session returns INVALID', async () => {
    assert.equal(await askStatus(randomUUID()), 'INVALID');
  });

  test('a rotated credential returns REVOKED', async () => {
    const replacement = createCredential();
    await check(db.rpc('issue_registration_credential', {
      p_registration_id: fixture.registration.id,
      p_token_hash: replacement.tokenHash,
      p_fallback_code_hash: replacement.fallbackHash,
    }));
    assert.equal(await askStatus(fixture.session.id), 'REVOKED');
    assert.equal(await askStatus(fixture.session.id, 'Asked on the new card', replacement.tokenHash), 'ASKED');
  });

  test('a cancelled registration returns REVOKED', async () => {
    await check(db.from('event_registrations').update({ status: 'cancelled' }).eq('id', fixture.registration.id));
    assert.equal(await askStatus(fixture.session.id), 'REVOKED');
  });

  test('a session belonging to another event returns WRONG_EVENT', async () => {
    const [other] = await check(db.from('events').insert({
      code: 'other-event', name: 'Other Event', status: 'open',
    }).select('id'));
    const [otherSession] = await check(db.from('event_sessions').insert({
      event_id: other.id, position: 1, title: 'Elsewhere', kind: 'session',
      starts_at: '2030-01-01T03:30:00Z', ends_at: '2030-01-01T04:00:00Z',
    }).select('id'));
    assert.equal(await askStatus(otherSession.id), 'WRONG_EVENT');
  });

  test('an attendee who was never scanned in returns NOT_CHECKED_IN', async () => {
    await check(db.rpc('delete_attendance', {
      p_registration_id: fixture.registration.id,
      p_event_day_id: fixture.days[0].id,
    }));
    assert.equal(await askStatus(fixture.session.id), 'NOT_CHECKED_IN');
  });

  test('a break takes no questions', async () => {
    assert.equal(await askStatus(fixture.brk.id), 'BREAK');
  });

  test('an event that is no longer open returns CLOSED', async () => {
    await check(db.from('events').update({ status: 'closed' }).eq('id', fixture.event.id));
    assert.equal(await askStatus(fixture.session.id), 'CLOSED');
  });

  test('a second question one second later returns TOO_FAST', async () => {
    assert.equal(await askStatus(fixture.session.id, 'First question'), 'ASKED');
    await check(backdate(1));
    assert.equal(await askStatus(fixture.session.id, 'Second question'), 'TOO_FAST');
    assert.equal((await check(db.from('session_questions').select('id'))).length, 1);
  });

  test('a second question three seconds later is allowed', async () => {
    assert.equal(await askStatus(fixture.session.id, 'First question'), 'ASKED');
    await check(backdate(3));
    assert.equal(await askStatus(fixture.session.id, 'Second question'), 'ASKED');
  });

  test('there is no cap on how many questions one attendee asks', async () => {
    for (let index = 0; index < 5; index += 1) {
      assert.equal(await askStatus(fixture.session.id, `Question number ${index}`), 'ASKED');
      await check(backdate(5));
    }
    assert.equal((await check(db.from('session_questions').select('id'))).length, 5);
  });

  test('a whitespace-only body raises VALIDATION', async () => {
    const { error } = await ask(fixture.session.id, '   \n\t  ');
    assert.equal(error?.message, 'VALIDATION');
  });

  test('a body of 10001 characters raises VALIDATION', async () => {
    const { error } = await ask(fixture.session.id, 'x'.repeat(10001));
    assert.equal(error?.message, 'VALIDATION');
  });

  test('a body of 10000 multi-byte characters is accepted', async () => {
    assert.equal(await askStatus(fixture.session.id, 'অ'.repeat(10000)), 'ASKED');
  });

  test('a malformed credential hash raises VALIDATION', async () => {
    const { error } = await ask(fixture.session.id, 'A real question', 'not-a-hash');
    assert.equal(error?.message, 'VALIDATION');
  });
  // --- set_live_session / delete_session_question ---
  // "deleting a pinned session nulls live_session_id" lives in tests/db/schema.test.js, where the
  // `on delete set null` reference is defined; not duplicated here.

  const liveSessionId = async () => {
    const [row] = await check(db.from('events').select('live_session_id').eq('id', fixture.event.id));
    return row.live_session_id;
  };

  test('set_live_session pins a session on the event', async () => {
    await check(db.rpc('set_live_session', { p_event_id: fixture.event.id, p_session_id: fixture.session.id }));
    assert.equal(await liveSessionId(), fixture.session.id);
  });

  test('set_live_session with a null session returns to the clock', async () => {
    await check(db.rpc('set_live_session', { p_event_id: fixture.event.id, p_session_id: fixture.session.id }));
    await check(db.rpc('set_live_session', { p_event_id: fixture.event.id, p_session_id: null }));
    assert.equal(await liveSessionId(), null);
  });

  test('set_live_session refuses a session belonging to another event', async () => {
    const [other] = await check(db.from('events').insert({
      code: 'live-other', name: 'Live Other', status: 'open',
    }).select('id'));
    const [otherSession] = await check(db.from('event_sessions').insert({
      event_id: other.id, position: 1, title: 'Elsewhere', kind: 'session',
      starts_at: '2030-01-01T03:30:00Z', ends_at: '2030-01-01T04:00:00Z',
    }).select('id'));
    const { error } = await db.rpc('set_live_session', {
      p_event_id: fixture.event.id, p_session_id: otherSession.id,
    });
    assert.equal(error?.message, 'VALIDATION');
    assert.equal(await liveSessionId(), null);
  });

  test('set_live_session refuses a break', async () => {
    const { error } = await db.rpc('set_live_session', {
      p_event_id: fixture.event.id, p_session_id: fixture.brk.id,
    });
    assert.equal(error?.message, 'VALIDATION');
    assert.equal(await liveSessionId(), null);
  });

  test('set_live_session raises NOT_FOUND for an unknown event', async () => {
    const { error } = await db.rpc('set_live_session', {
      p_event_id: randomUUID(), p_session_id: fixture.session.id,
    });
    assert.equal(error?.message, 'NOT_FOUND');
  });

  test('delete_session_question removes one question and leaves the rest', async () => {
    const first = await check(ask(fixture.session.id, 'First question'));
    await check(backdate(5));
    await check(ask(fixture.session.id, 'Second question'));
    await check(db.rpc('delete_session_question', { p_id: first.question_id }));
    const remaining = await check(db.from('session_questions').select('body'));
    assert.deepEqual(remaining.map((row) => row.body), ['Second question']);
  });

  test('delete_session_question raises NOT_FOUND when the question is already gone', async () => {
    const { error } = await db.rpc('delete_session_question', { p_id: randomUUID() });
    assert.equal(error?.message, 'NOT_FOUND');
  });
});
