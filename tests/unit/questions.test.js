import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../../src/errors.js';
import {
  buildQuestionsWorkbook, mapQuestionRows, questionsFilename, resolveLiveSessionId, validateQuestion,
} from '../../src/services/questions.js';

const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const CREDENTIAL = 'ER1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

// The real agenda on 2026-11-04, Asia/Dhaka (UTC+6): 09:30 local is 03:30Z.
const session = (id, kind, starts, ends) => ({
  id, kind, title: `Session ${id}`, position: Number(id.slice(1)),
  starts_at: starts, ends_at: ends,
});
const AGENDA = [
  session('s1', 'session', '2026-11-04T03:30:00.000Z', '2026-11-04T04:00:00.000Z'),
  session('s2', 'session', '2026-11-04T04:15:00.000Z', '2026-11-04T05:15:00.000Z'),
  session('b1', 'break', '2026-11-04T05:15:00.000Z', '2026-11-04T05:45:00.000Z'),
  session('s3', 'session', '2026-11-04T05:45:00.000Z', '2026-11-04T06:15:00.000Z'),
];
const at = (iso) => new Date(iso);
// assert.throws requires exactly true, not a truthy message.
const rejects = (field) => (error) => error instanceof AppError && Boolean(error.extra.fields?.[field]);

test('an unexpired pin wins over the clock', () => {
  assert.equal(resolveLiveSessionId(AGENDA, 's3', at('2026-11-04T04:30:00.000Z')), 's3');
});

test('a pin whose session has ended is ignored', () => {
  assert.equal(resolveLiveSessionId(AGENDA, 's1', at('2026-11-04T06:00:00.000Z')), 's3');
});

test('the clock returns the latest session already started', () => {
  assert.equal(resolveLiveSessionId(AGENDA, null, at('2026-11-04T04:30:00.000Z')), 's2');
});

test('during a break the clock returns the session that just ended', () => {
  assert.equal(resolveLiveSessionId(AGENDA, null, at('2026-11-04T05:30:00.000Z')), 's2');
});

test('before the first session the clock returns the first session', () => {
  assert.equal(resolveLiveSessionId(AGENDA, null, at('2026-11-04T03:00:00.000Z')), 's1');
});

test('after the last session the clock returns the last session', () => {
  assert.equal(resolveLiveSessionId(AGENDA, null, at('2026-11-04T23:00:00.000Z')), 's3');
});

test('at exactly a session ends_at the clock still returns that session', () => {
  assert.equal(resolveLiveSessionId(AGENDA, null, at('2026-11-04T05:15:00.000Z')), 's2');
});

test('a pin expires at exactly its ends_at', () => {
  // Only observable where one session starts the instant another ends.
  const back_to_back = [
    session('a1', 'session', '2026-11-04T00:00:00.000Z', '2026-11-04T01:00:00.000Z'),
    session('a2', 'session', '2026-11-04T01:00:00.000Z', '2026-11-04T02:00:00.000Z'),
  ];
  assert.equal(resolveLiveSessionId(back_to_back, 'a1', at('2026-11-04T00:59:59.000Z')), 'a1');
  assert.equal(resolveLiveSessionId(back_to_back, 'a1', at('2026-11-04T01:00:00.000Z')), 'a2');
});

test('a pinned session with no ends_at never expires', () => {
  const open_ended = [session('c1', 'session', '2026-11-04T11:30:00.000Z', null)];
  assert.equal(resolveLiveSessionId(open_ended, 'c1', at('2027-01-01T00:00:00.000Z')), 'c1');
});

test('an agenda with no sessions resolves to null', () => {
  assert.equal(resolveLiveSessionId([], null, at('2026-11-04T04:30:00.000Z')), null);
});

test('an agenda of breaks only resolves to null', () => {
  assert.equal(resolveLiveSessionId([AGENDA[2]], null, at('2026-11-04T05:30:00.000Z')), null);
});

test('a pin naming a session that is not on the agenda is ignored', () => {
  assert.equal(resolveLiveSessionId(AGENDA, 'gone', at('2026-11-04T04:30:00.000Z')), 's2');
});

test('validateQuestion returns the trimmed body, credential and session id', () => {
  const result = validateQuestion({ credential: ` ${CREDENTIAL} `, session_id: SESSION_ID, body: '  Why?  ' });
  assert.deepEqual(result, { credential: CREDENTIAL, sessionId: SESSION_ID, body: 'Why?' });
});

test('validateQuestion rejects a missing session id', () => {
  assert.throws(
    () => validateQuestion({ credential: CREDENTIAL, body: 'A real question' }),
    rejects('session_id'),
  );
});

test('validateQuestion rejects a whitespace-only body', () => {
  assert.throws(
    () => validateQuestion({ credential: CREDENTIAL, session_id: SESSION_ID, body: '   \n\t ' }),
    rejects('body'),
  );
});

test('validateQuestion rejects a body of 10001 characters', () => {
  assert.throws(
    () => validateQuestion({ credential: CREDENTIAL, session_id: SESSION_ID, body: 'a'.repeat(10001) }),
    rejects('body'),
  );
});

test('validateQuestion accepts 10000 multi-byte characters', () => {
  const body = 'অ'.repeat(10000);
  assert.equal(validateQuestion({ credential: CREDENTIAL, session_id: SESSION_ID, body }).body, body);
});

test('validateQuestion rejects a too-short credential', () => {
  assert.throws(
    () => validateQuestion({ credential: 'ab', session_id: SESSION_ID, body: 'A real question' }),
    rejects('credential'),
  );
});

const questionRow = (overrides = {}) => ({
  id: 'q1',
  session_id: 's2',
  body: 'What is the edge crush tolerance?',
  asked_at: '2026-11-04T10:05:00.000Z',
  event_sessions: { title: 'Carton Quality Performance', position: 11 },
  event_registrations: {
    attendees: {
      name: 'Mohammad Rahman', designation: 'Packaging Manager',
      organisation_name: null, from_type: 'supplier', email: 'm.rahman@example.com',
    },
    registration_orgs: [{ kind: 'supplier', name: 'Bengal Carton Ltd' }],
  },
  ...overrides,
});

test('mapQuestionRows flattens the session and asker onto one row', () => {
  const [row] = mapQuestionRows([questionRow()]);
  assert.equal(row.session_title, 'Carton Quality Performance');
  assert.equal(row.session_position, 11);
  assert.equal(row.name, 'Mohammad Rahman');
  assert.equal(row.designation, 'Packaging Manager');
  assert.equal(row.organisation, 'Bengal Carton Ltd');
  assert.equal(row.attendee_type, 'supplier');
  assert.equal(row.email, 'm.rahman@example.com');
});

test('mapQuestionRows joins several organisation snapshots', () => {
  const [row] = mapQuestionRows([questionRow({
    event_registrations: {
      attendees: { name: 'A', designation: '', organisation_name: null, from_type: 'factory', email: '' },
      registration_orgs: [{ kind: 'supplier', name: 'Bengal Carton Ltd' }, { kind: 'factory', name: 'Dhaka Apparels' }],
    },
  })]);
  assert.equal(row.organisation, 'Bengal Carton Ltd, Dhaka Apparels');
});

test('mapQuestionRows falls back to organisation_name for an "other" attendee', () => {
  const [row] = mapQuestionRows([questionRow({
    event_registrations: {
      attendees: { name: 'A', designation: '', organisation_name: 'Primark', from_type: 'other', email: '' },
      registration_orgs: [],
    },
  })]);
  assert.equal(row.organisation, 'Primark');
});

test('mapQuestionRows accepts Supabase joins returned as arrays', () => {
  const [row] = mapQuestionRows([questionRow({
    event_sessions: [{ title: 'Ethical Team Updates', position: 6 }],
    event_registrations: [{
      attendees: [{ name: 'B', designation: 'QA', organisation_name: null, from_type: 'supplier', email: '' }],
      registration_orgs: [{ kind: 'supplier', name: 'Bengal Carton Ltd' }],
    }],
  })]);
  assert.equal(row.session_title, 'Ethical Team Updates');
  assert.equal(row.name, 'B');
});

const workbookData = (rows) => ({
  generated_at: '2026-11-04T12:00:00.000Z',
  event: { id: 'e1', code: 'bangladesh-origin', name: 'Bangladesh Origin' },
  rows,
});

test('buildQuestionsWorkbook writes a header row and one row per question', () => {
  const data = workbookData(mapQuestionRows([questionRow(), questionRow({ id: 'q2' })]));
  const sheet = buildQuestionsWorkbook(data).getWorksheet('Questions');
  assert.equal(sheet.rowCount, 3);
  assert.equal(sheet.getRow(1).font.bold, true);
});

test('buildQuestionsWorkbook formats asked_at in Asia/Dhaka', () => {
  const data = workbookData(mapQuestionRows([questionRow()]));
  const sheet = buildQuestionsWorkbook(data).getWorksheet('Questions');
  const values = sheet.getRow(2).values.map(String);
  assert.ok(values.some((value) => value.includes('2026-11-04 16:05')), values.join(' | '));
});

test('questionsFilename uses the event code', () => {
  assert.equal(questionsFilename(workbookData([])), 'bangladesh-origin-questions.xlsx');
});

test('questionsFilename sanitises an unusable event code', () => {
  const data = workbookData([]);
  data.event.code = null;
  assert.equal(questionsFilename(data), 'event-questions.xlsx');
});
