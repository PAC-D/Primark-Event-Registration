import ExcelJS from 'exceljs';
import { callRpc, runQuery } from '../db.js';
import { errors } from '../errors.js';
import { scannedCredentialHash } from './credential.js';
import { formatDhaka } from './export.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const one = (value) => (Array.isArray(value) ? value[0] : value);

export function attendanceDayId(value) {
  if (!UUID_RE.test(value ?? '')) throw errors.validation({ event_day_id: 'Choose an event day.' });
  return value;
}

export function validateScan(body = {}) {
  const credential = String(body.credential ?? '').trim();
  const eventDayId = String(body.event_day_id ?? '');
  const scanId = String(body.scan_id ?? '');
  const deviceId = String(body.device_id ?? '').trim();
  const scannedAt = new Date(body.scanned_at_device);
  const fields = {};
  if (credential.length < 6 || credential.length > 512) fields.credential = 'Scan a valid QR code or enter its fallback code.';
  if (!UUID_RE.test(eventDayId)) fields.event_day_id = 'Choose an event day.';
  if (!UUID_RE.test(scanId)) fields.scan_id = 'Invalid scan identifier.';
  if (deviceId.length < 2 || deviceId.length > 100) fields.device_id = 'Invalid scanner identifier.';
  if (Number.isNaN(scannedAt.valueOf())) fields.scanned_at_device = 'Invalid scan time.';
  if (Object.keys(fields).length) throw errors.validation(fields);
  return { credential, eventDayId, scanId, deviceId, scannedAt: scannedAt.toISOString() };
}

export async function checkIn(db, body) {
  const input = validateScan(body);
  const result = await callRpc(db, 'check_in_registration', {
    p_credential_hash: scannedCredentialHash(input.credential),
    p_event_day_id: input.eventDayId,
    p_scan_id: input.scanId,
    p_device_id: input.deviceId,
    p_scanned_at_device: input.scannedAt,
    p_source: 'online',
  });
  if (!['CHECKED_IN', 'ALREADY_CHECKED_IN'].includes(result?.status) || !result.attendee_id) return result;
  const attendees = await runQuery(db.from('attendees').select('email').eq('id', result.attendee_id).limit(1));
  return { ...result, email: attendees[0]?.email || '' };
}

// A mis-scan, a test scan during setup, or the wrong card: the row has to be removable so the
// person returns to Pending and can be scanned again.
export async function deleteAttendance(db, body = {}) {
  const registrationId = String(body.registration_id ?? '');
  const eventDayId = String(body.event_day_id ?? '');
  const fields = {};
  if (!UUID_RE.test(registrationId)) fields.registration_id = 'Choose an attendee.';
  if (!UUID_RE.test(eventDayId)) fields.event_day_id = 'Choose an event day.';
  if (Object.keys(fields).length) throw errors.validation(fields);
  await callRpc(db, 'delete_attendance', {
    p_registration_id: registrationId,
    p_event_day_id: eventDayId,
  });
}

export async function listAttendanceDays(db) {
  const rows = await runQuery(db.from('event_days')
    .select('id, event_id, event_date, label, check_in_opens_at, check_in_closes_at, events(id, code, name, status, timezone)')
    .order('event_date', { ascending: false }));
  return rows.map((row) => {
    const event = one(row.events) ?? {};
    return {
      id: row.id,
      event_id: row.event_id,
      event_date: row.event_date,
      label: row.label,
      check_in_opens_at: row.check_in_opens_at,
      check_in_closes_at: row.check_in_closes_at,
      event: { id: event.id, code: event.code, name: event.name, status: event.status, timezone: event.timezone },
      scan_enabled: event.status === 'open',
    };
  });
}

function organisation(attendee, snapshots) {
  const names = snapshots.map((item) => item.name).filter(Boolean);
  return names.join(', ') || attendee.organisation_name || '—';
}

// This is the only adapter that joins attendance to the current person/organisation schema.
// When the production database arrives, its field distribution can be remapped here.
export function mapAttendanceRows(registrations, scans) {
  const byRegistration = new Map(scans.map((scan) => [scan.registration_id, scan]));
  return registrations.map((registration) => {
    const attendee = one(registration.attendees) ?? {};
    const scan = byRegistration.get(registration.id);
    return {
      registration_id: registration.id,
      attendee_id: attendee.id,
      name: attendee.name || 'Unnamed attendee',
      designation: attendee.designation || '',
      organisation: organisation(attendee, registration.registration_orgs ?? []),
      registration_status: registration.status,
      attendance_status: scan ? 'present' : 'pending',
      checked_in_at: scan?.first_scanned_at ?? null,
      device_id: scan?.device_id ?? null,
      source: scan?.source ?? null,
    };
  }).sort((a, b) => {
    if (a.attendance_status !== b.attendance_status) return a.attendance_status === 'present' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export async function loadAttendance(db, dayId) {
  attendanceDayId(dayId);
  const days = await listAttendanceDays(db);
  const day = days.find((item) => item.id === dayId);
  if (!day) throw errors.notFound();
  const [registrations, scans] = await Promise.all([
    runQuery(db.from('event_registrations')
      .select('id, status, attendees(id, name, designation, organisation_name), registration_orgs(kind, name)')
      .eq('event_id', day.event_id)
      .in('status', ['confirmed', 'cancelled', 'revoked'])),
    runQuery(db.from('attendance')
      .select('registration_id, first_scanned_at, scanned_at_device, received_at, device_id, source')
      .eq('event_day_id', dayId)
      .order('first_scanned_at', { ascending: true })),
  ]);
  const rows = mapAttendanceRows(registrations, scans);
  const confirmed = rows.filter((row) => row.registration_status === 'confirmed');
  return {
    generated_at: new Date().toISOString(), day, rows,
    summary: {
      registered: confirmed.length,
      present: confirmed.filter((row) => row.attendance_status === 'present').length,
      pending: confirmed.filter((row) => row.attendance_status === 'pending').length,
      inactive: rows.length - confirmed.length,
    },
  };
}

export function buildAttendanceWorkbook(data) {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date(data.generated_at);
  const sheet = workbook.addWorksheet('Attendance', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = [
    ['Name', 'name', 26], ['Designation', 'designation', 24], ['Organisation', 'organisation', 44],
    ['Registration', 'registration_status', 14], ['Attendance', 'attendance_status', 14],
    ['Checked in (Asia/Dhaka)', 'checked_in_at', 24], ['Scanner', 'device_id', 24], ['Source', 'source', 12],
  ].map(([header, key, width]) => ({ header, key, width }));
  sheet.getRow(1).font = { bold: true };
  sheet.autoFilter = { from: 'A1', to: 'H1' };
  sheet.addRows(data.rows.map((row) => ({
    ...row,
    attendance_status: row.attendance_status === 'present' ? 'Present' : 'Pending',
    registration_status: row.registration_status[0].toUpperCase() + row.registration_status.slice(1),
    checked_in_at: row.checked_in_at ? formatDhaka(row.checked_in_at) : '',
    device_id: row.device_id ?? '', source: row.source ?? '',
  })));
  return workbook;
}

export function attendanceFilename(data) {
  const eventCode = String(data.day.event.code || 'event').replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
  return `${eventCode}-${data.day.event_date}-attendance.xlsx`;
}
