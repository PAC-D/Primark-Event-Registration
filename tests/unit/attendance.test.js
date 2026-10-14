import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../../src/errors.js';
import {
  attendanceFilename, buildAttendanceWorkbook, checkIn, mapAttendanceRows, validateScan,
} from '../../src/services/attendance.js';
import { scannedCredentialHash } from '../../src/services/credential.js';
import { fakeDb } from '../helpers/fake-db.js';

const DAY_ID = '11111111-1111-4111-8111-111111111111';
const SCAN_ID = '22222222-2222-4222-8222-222222222222';

test('scan input is validated and manual fallback codes are normalised before the RPC', async () => {
  const db = fakeDb({ rpc: { check_in_registration: () => ({ data: { status: 'CHECKED_IN' }, error: null }) } });
  const result = await checkIn(db, {
    credential: ' abcd-efgh ', event_day_id: DAY_ID, scan_id: SCAN_ID,
    device_id: ' phone-1 ', scanned_at_device: '2026-11-04T04:00:00.000Z',
  });
  assert.equal(result.status, 'CHECKED_IN');
  const call = db.calls.find((item) => item.fn === 'check_in_registration');
  assert.deepEqual(call.args, {
    p_credential_hash: scannedCredentialHash('ABCD-EFGH'),
    p_event_day_id: DAY_ID,
    p_scan_id: SCAN_ID,
    p_device_id: 'phone-1',
    p_scanned_at_device: '2026-11-04T04:00:00.000Z',
    p_source: 'online',
  });
});

test('bad scan payloads fail before touching the database', () => {
  assert.throws(() => validateScan({ credential: 'x' }), (error) => error instanceof AppError && error.status === 400);
});

test('attendance adapter combines people, organisation snapshots and scans', () => {
  const rows = mapAttendanceRows([
    {
      id: 'r1', status: 'confirmed',
      attendees: { id: 'a1', name: 'Amina', designation: 'Manager', organisation_name: null },
      registration_orgs: [{ kind: 'factory', name: 'Factory One' }],
    },
    {
      id: 'r2', status: 'confirmed',
      attendees: { id: 'a2', name: 'Bashir', designation: null, organisation_name: 'Guest Org' }, registration_orgs: [],
    },
  ], [{ registration_id: 'r2', first_scanned_at: '2026-11-04T04:00:00Z', device_id: 'phone', source: 'online' }]);
  assert.equal(rows[0].name, 'Bashir');
  assert.equal(rows[0].attendance_status, 'present');
  assert.equal(rows[0].organisation, 'Guest Org');
  assert.equal(rows[1].organisation, 'Factory One');
  assert.equal(rows[1].attendance_status, 'pending');
});

test('attendance workbook and filename are ready for download', async () => {
  const data = {
    generated_at: '2026-11-04T04:00:00Z',
    day: { event_date: '2026-11-04', event: { code: 'demo-2026' } },
    rows: [{ name: 'Amina', designation: 'Manager', organisation: 'Factory One', registration_status: 'confirmed', attendance_status: 'present', checked_in_at: '2026-11-04T04:01:00Z', device_id: 'phone', source: 'online' }],
  };
  const workbook = buildAttendanceWorkbook(data);
  assert.equal(workbook.getWorksheet('Attendance').rowCount, 2);
  assert.ok((await workbook.xlsx.writeBuffer()).byteLength > 1000);
  assert.equal(attendanceFilename(data), 'demo-2026-2026-11-04-attendance.xlsx');
});
