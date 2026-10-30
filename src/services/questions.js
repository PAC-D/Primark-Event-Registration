import ExcelJS from 'exceljs';
import { errors } from '../errors.js';
import { formatDhaka } from './export.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BODY_MIN = 3;
const BODY_MAX = 10000;
const one = (value) => (Array.isArray(value) ? value[0] : value);

// Breaks are on the agenda so the attendee's list reads like the printed programme, but they
// are never the live session. `sessions` arrives ordered by starts_at.
export function resolveLiveSessionId(sessions, liveSessionId, now = new Date()) {
  const speakable = (sessions ?? []).filter((session) => session.kind === 'session');
  if (!speakable.length) return null;

  // An administrator's pin stops counting once that session has ended, so a pin set and
  // forgotten before lunch does not collect the whole afternoon's questions.
  const pinned = liveSessionId ? speakable.find((session) => session.id === liveSessionId) : null;
  if (pinned && (!pinned.ends_at || now < new Date(pinned.ends_at))) return pinned.id;

  const started = speakable.filter((session) => new Date(session.starts_at) <= now);
  return (started.at(-1) ?? speakable[0]).id;
}

export function validateQuestion(body = {}) {
  const credential = String(body.credential ?? '').trim();
  const sessionId = String(body.session_id ?? '');
  const text = String(body.body ?? '').trim();
  // Characters, not UTF-16 units, to agree with the column's char_length check on Bengali input.
  const length = [...text].length;
  const fields = {};
  if (credential.length < 6 || credential.length > 512) fields.credential = 'Scan a valid attendee QR code.';
  if (!UUID_RE.test(sessionId)) fields.session_id = 'Choose a session.';
  if (length < BODY_MIN || length > BODY_MAX) fields.body = `Write a question of ${BODY_MIN} to ${BODY_MAX} characters.`;
  if (Object.keys(fields).length) throw errors.validation(fields);
  return { credential, sessionId, body: text };
}

function organisation(attendee, snapshots) {
  const names = snapshots.map((item) => item.name).filter(Boolean);
  return names.join(', ') || attendee.organisation_name || '—';
}

export function mapQuestionRows(questions) {
  return questions.map((question) => {
    const session = one(question.event_sessions) ?? {};
    const registration = one(question.event_registrations) ?? {};
    const attendee = one(registration.attendees) ?? {};
    return {
      id: question.id,
      session_id: question.session_id,
      session_title: session.title || '—',
      session_position: session.position ?? null,
      body: question.body,
      asked_at: question.asked_at,
      name: attendee.name || 'Unnamed attendee',
      designation: attendee.designation || '',
      organisation: organisation(attendee, registration.registration_orgs ?? []),
      attendee_type: attendee.from_type || 'other',
      email: attendee.email || '',
    };
  });
}

export function buildQuestionsWorkbook(data) {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date(data.generated_at);
  const sheet = workbook.addWorksheet('Questions', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = [
    ['Question', 'body', 80], ['Session', 'session_title', 44], ['#', 'session_position', 6],
    ['Asked (Asia/Dhaka)', 'asked_at', 22], ['Name', 'name', 26], ['Designation', 'designation', 24],
    ['Organisation', 'organisation', 44], ['Attending from', 'attendee_type', 16], ['Email', 'email', 30],
  ].map(([header, key, width]) => ({ header, key, width }));
  sheet.getRow(1).font = { bold: true };
  sheet.autoFilter = { from: 'A1', to: 'I1' };
  sheet.addRows(data.rows.map((row) => ({ ...row, asked_at: formatDhaka(row.asked_at) })));
  return sheet.workbook;
}

export function questionsFilename(data) {
  const eventCode = String(data.event.code || 'event').replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
  return `${eventCode}-questions.xlsx`;
}
