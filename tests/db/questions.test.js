import { randomUUID } from 'node:crypto';
import { before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../../src/create-app.js';
import { testConfig } from '../helpers/fake-db.js';
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
  // --- seed_event_agenda (migration 018) ---

  const seedAgenda = async () => {
    const [bare] = await check(db.from('events').insert({
      code: 'agenda-seed', name: 'Agenda Seed', status: 'open', timezone: 'Asia/Dhaka',
    }).select('id'));
    const inserted = await check(db.rpc('seed_event_agenda', {
      p_event_id: bare.id, p_date: '2026-11-04',
    }));
    return { eventId: bare.id, inserted };
  };

  test('seed_event_agenda inserts the 15 agenda rows and is idempotent', async () => {
    const { eventId, inserted } = await seedAgenda();
    assert.equal(inserted, 15);
    const again = await check(db.rpc('seed_event_agenda', { p_event_id: eventId, p_date: '2026-11-04' }));
    assert.equal(again, 0);
    assert.equal((await check(db.from('event_sessions').select('id').eq('event_id', eventId))).length, 15);
  });

  test('the agenda holds 12 sessions and 3 breaks', async () => {
    const { eventId } = await seedAgenda();
    const rows = await check(db.from('event_sessions').select('kind').eq('event_id', eventId));
    assert.equal(rows.filter((row) => row.kind === 'session').length, 12);
    assert.equal(rows.filter((row) => row.kind === 'break').length, 3);
  });

  test('local agenda times are resolved against the event timezone', async () => {
    const { eventId } = await seedAgenda();
    const rows = await check(db.from('event_sessions')
      .select('position, title, starts_at, ends_at').eq('event_id', eventId).order('position'));
    // 09:30 Asia/Dhaka (UTC+6) is 03:30Z.
    assert.equal(new Date(rows[0].starts_at).toISOString(), '2026-11-04T03:30:00.000Z');
    assert.equal(new Date(rows[0].ends_at).toISOString(), '2026-11-04T04:00:00.000Z');
    assert.equal(rows[0].title, 'Primark Supply Chain & Bangladesh Carton Nomination Overview');
    // Lunch, 13:05-15:00 local.
    assert.equal(new Date(rows[7].starts_at).toISOString(), '2026-11-04T07:05:00.000Z');
    assert.equal(new Date(rows[7].ends_at).toISOString(), '2026-11-04T09:00:00.000Z');
  });

  test('the closing row is open-ended and the Carton Connect title is kept verbatim', async () => {
    const { eventId } = await seedAgenda();
    const rows = await check(db.from('event_sessions')
      .select('position, title, kind, ends_at').eq('event_id', eventId).order('position'));
    assert.equal(rows[14].title, 'Closing Remarks & Networking');
    assert.equal(rows[14].kind, 'break');
    assert.equal(rows[14].ends_at, null);
    assert.equal(
      rows[3].title,
      'From Nomination to Order: Garment Supplier & Packaging Supplier Integration [Carton Connect]',
    );
  });

  test('seed_event_agenda raises NOT_FOUND for an unknown event', async () => {
    const { error } = await db.rpc('seed_event_agenda', { p_event_id: randomUUID(), p_date: '2026-11-04' });
    assert.equal(error?.message, 'NOT_FOUND');
  });
  // --- public API: the attendee's own page ---

  const app = () => createApp({ db, config: testConfig });
  const profile = (credential = fixture.credential.token) =>
    request(app()).post('/api/attendee-profile').send({ credential });
  const post = (body) => request(app()).post('/api/questions').send(body);
  const question = (sessionId, body = 'What is the edge crush tolerance?', credential = null) =>
    post({ credential: credential ?? fixture.credential.token, session_id: sessionId, body });

  test('the profile carries the agenda, the resolved live session and no-store', async () => {
    const res = await profile().expect(200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.body.qa.checked_in, true);
    assert.equal(res.body.qa.sessions.length, 3);
    assert.deepEqual(res.body.qa.sessions.map((s) => s.position), [1, 2, 3]);
    assert.deepEqual(res.body.qa.sessions.map((s) => s.kind), ['session', 'break', 'session']);
    // Every fixture session is in 2030, so the clock is before the first one.
    assert.equal(res.body.qa.live_session_id, fixture.session.id);
    assert.deepEqual(res.body.qa.my_questions, []);
  });

  test('the profile reports not checked in once the check-in is deleted', async () => {
    await check(db.rpc('delete_attendance', {
      p_registration_id: fixture.registration.id,
      p_event_day_id: fixture.days[0].id,
    }));
    const res = await profile().expect(200);
    assert.equal(res.body.qa.checked_in, false);
  });

  test('the profile has no qa payload when the event has no agenda', async () => {
    await check(db.from('event_sessions').delete().eq('event_id', fixture.event.id));
    const res = await profile().expect(200);
    assert.equal(res.body.qa, null);
  });

  test('the profile lists the attendee own questions, newest first', async () => {
    await check(ask(fixture.session.id, 'First question'));
    await check(backdate(5));
    await check(ask(fixture.dayTwoSession.id, 'Second question'));
    const res = await profile().expect(200);
    assert.deepEqual(res.body.qa.my_questions.map((q) => q.body), ['Second question', 'First question']);
    assert.equal(res.body.qa.my_questions[0].session_title, 'Second Day Session');
  });

  test('posting a question returns 201 and the stored question', async () => {
    const res = await question(fixture.session.id).expect(201);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.ok(res.body.id);
    assert.equal(res.body.session_id, fixture.session.id);
    assert.equal(res.body.body, 'What is the edge crush tolerance?');
  });

  test('a fallback code is accepted as the credential', async () => {
    await question(fixture.session.id, 'Asked by code', fixture.credential.fallback).expect(201);
  });

  test('not being checked in is a 409 the page can show', async () => {
    await check(db.rpc('delete_attendance', {
      p_registration_id: fixture.registration.id,
      p_event_day_id: fixture.days[0].id,
    }));
    const res = await question(fixture.session.id).expect(409);
    assert.equal(res.body.error, 'CONFLICT');
    assert.match(res.body.message, /check in/i);
  });

  test('a break is a 409', async () => {
    const res = await question(fixture.brk.id).expect(409);
    assert.equal(res.body.error, 'CONFLICT');
  });

  test('a second question too soon is a 409', async () => {
    await question(fixture.session.id, 'First question').expect(201);
    const res = await question(fixture.session.id, 'Second question').expect(409);
    assert.equal(res.body.error, 'CONFLICT');
  });

  test('a closed event is a 409', async () => {
    await check(db.from('events').update({ status: 'closed' }).eq('id', fixture.event.id));
    const res = await question(fixture.session.id).expect(409);
    assert.equal(res.body.error, 'CONFLICT');
  });

  test('an unknown credential is a 404', async () => {
    const res = await question(fixture.session.id, 'Anybody there?', 'ER1.definitely-not-a-real-token').expect(404);
    // An unmatched /api path is also a 404 NOT_FOUND; only the message proves the route ran.
    assert.match(res.body.message, /QR code/i);
  });

  test('a revoked credential is a 404', async () => {
    const replacement = createCredential();
    await check(db.rpc('issue_registration_credential', {
      p_registration_id: fixture.registration.id,
      p_token_hash: replacement.tokenHash,
      p_fallback_code_hash: replacement.fallbackHash,
    }));
    const res = await question(fixture.session.id, 'Asked on the old card').expect(404);
    assert.match(res.body.message, /QR code/i);
  });

  test('a session from another event is a 404', async () => {
    const [other] = await check(db.from('events').insert({
      code: 'public-other', name: 'Public Other', status: 'open',
    }).select('id'));
    const [otherSession] = await check(db.from('event_sessions').insert({
      event_id: other.id, position: 1, title: 'Elsewhere', kind: 'session',
      starts_at: '2030-01-01T03:30:00Z', ends_at: '2030-01-01T04:00:00Z',
    }).select('id'));
    const res = await question(otherSession.id).expect(404);
    assert.match(res.body.message, /QR code/i);
  });

  test('a body over the limit is rejected before the database', async () => {
    const res = await question(fixture.session.id, 'x'.repeat(10001)).expect(400);
    assert.equal(res.body.error, 'VALIDATION');
    assert.ok(res.body.fields.body);
    assert.equal((await check(db.from('session_questions').select('id'))).length, 0);
  });

  test('a missing session id is rejected', async () => {
    await post({ credential: fixture.credential.token, body: 'A real question' }).expect(400);
  });
});
