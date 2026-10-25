import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const base = process.env.APP_URL || 'http://localhost:3000';
if (!process.env.ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD is required.');

const credentials = JSON.parse(await readFile(new URL('../.demo/credentials.json', import.meta.url), 'utf8'));
const credential = credentials.credentials.find((item) => item.expectedStatus === 'ACTIVE');
assert.ok(credential, 'No active demo credential found. Run npm run seed:demo first.');

const login = await fetch(`${base}/api/admin/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: process.env.ADMIN_PASSWORD }),
});
assert.equal(login.status, 200, 'Admin login failed.');
const cookie = login.headers.get('set-cookie')?.split(';')[0];
assert.ok(cookie, 'Login did not return a session cookie.');
const headers = { Cookie: cookie };

for (const path of ['/scanner.html', '/vendor/html5-qrcode.min.js']) {
  const response = await fetch(`${base}${path}`, { headers });
  assert.equal(response.status, 200, `${path} is not available.`);
}

const dayResponse = await fetch(`${base}/api/admin/attendance-days`, { headers });
assert.equal(dayResponse.status, 200, 'Attendance day list failed.');
const { days } = await dayResponse.json();
const day = days.find((item) => item.scan_enabled && item.event_id === credentials.event.id);
assert.ok(day, 'No open demo event day found.');

const scanResponse = await fetch(`${base}/api/admin/attendance/check-in`, {
  method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    credential: credential.token,
    event_day_id: day.id,
    scan_id: crypto.randomUUID(),
    device_id: 'automated-smoke-test',
    scanned_at_device: new Date().toISOString(),
  }),
});
assert.equal(scanResponse.status, 200, 'Check-in request failed.');
const scan = await scanResponse.json();
assert.ok(['CHECKED_IN', 'ALREADY_CHECKED_IN'].includes(scan.status), `Unexpected scan status: ${scan.status}`);
assert.equal(scan.name, credential.name);
assert.ok(scan.checked_in_at, 'Scanner result is missing first check-in time.');

const rosterResponse = await fetch(`${base}/api/admin/attendance?event_day_id=${encodeURIComponent(day.id)}`, { headers });
assert.equal(rosterResponse.status, 200, 'Attendance roster failed.');
const roster = await rosterResponse.json();
const row = roster.rows.find((item) => item.registration_id === credential.registrationId);
assert.equal(row?.attendance_status, 'present', 'Scanned attendee did not appear as present.');

const exportResponse = await fetch(`${base}/api/admin/attendance/export?event_day_id=${encodeURIComponent(day.id)}`, { headers });
assert.equal(exportResponse.status, 200, 'Attendance export failed.');
assert.match(exportResponse.headers.get('content-type') ?? '', /spreadsheetml/);
assert.ok((await exportResponse.arrayBuffer()).byteLength > 1000, 'Attendance export is empty.');

console.log(`Attendance smoke test passed: ${scan.name} → ${scan.status}; present ${roster.summary.present}/${roster.summary.registered}.`);
