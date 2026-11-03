import { api } from './api.js';
import { escapeHtml } from '/shared/form-logic.js';
import { EVENT_TIME_ZONE } from '/shared/constants.js';

const $ = (selector) => document.querySelector(selector);
const DEFAULT_ATTENDANCE_DATE = '2026-11-04';
let days = [];
let scanner = null;
let busy = false;
let manualCandidates = [];
let selectedManualRegistration = null;

function randomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const value = Math.random() * 16 | 0;
    return (char === 'x' ? value : (value & 3) | 8).toString(16);
  });
}

function deviceId() {
  const key = 'pacd-attendance-device-id';
  let value = localStorage.getItem(key);
  if (!value) {
    value = `mobile-${randomId()}`;
    localStorage.setItem(key, value);
  }
  return value;
}

const formatDate = (date) => new Date(`${date}T00:00:00`).toLocaleDateString('en-GB', {
  day: '2-digit', month: 'short', year: 'numeric',
});
const formatTime = (iso) => new Date(iso).toLocaleString('en-GB', {
  timeZone: EVENT_TIME_ZONE, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function updateNetwork() {
  $('#network-state').textContent = navigator.onLine ? 'Online · scans save immediately' : 'Offline · reconnect before scanning';
  $('#network-state').classList.toggle('offline', !navigator.onLine);
}

function showLogin(message = '') {
  stopScanner();
  $('#scanner-app').hidden = true;
  $('#scanner-login').hidden = false;
  const error = $('#scanner-login-error');
  error.textContent = message;
  error.hidden = !message;
  $('#scanner-password').focus();
}

function showError(message) {
  const box = $('#scanner-error');
  box.textContent = message;
  box.hidden = !message;
}

function selectedDay() {
  return days.find((day) => day.id === $('#event-day').value);
}

async function loadScanner() {
  const response = await api('/api/admin/attendance-days');
  days = response.days;
  $('#scanner-login').hidden = true;
  $('#scanner-app').hidden = false;
  if (!days.length) {
    showError('No event days exist. Seed or create an event before taking attendance.');
    $('#scan-panel').hidden = true;
    return;
  }
  const openDays = days.filter((day) => day.scan_enabled);
  let selectable = openDays.length ? openDays : days;
  const preferredDay = days.find((day) => day.event_date === DEFAULT_ATTENDANCE_DATE && day.scan_enabled)
    ?? days.find((day) => day.event_date === DEFAULT_ATTENDANCE_DATE);
  if (preferredDay && !selectable.some((day) => day.id === preferredDay.id)) {
    selectable = [preferredDay, ...selectable];
  }
  $('#event-day').innerHTML = selectable.map((day) =>
    `<option value="${escapeHtml(day.id)}">${escapeHtml(day.event.name)} · ${escapeHtml(day.label)} · ${formatDate(day.event_date)}</option>`).join('');
  if (preferredDay) $('#event-day').value = preferredDay.id;
  $('#scan-panel').hidden = false;
  showError(openDays.length ? '' : 'No event is open. Scans will be rejected until an event is opened.');
  await loadManualCandidates();
  startScanner();
}

function resetManualSearch() {
  selectedManualRegistration = null;
  $('#manual-name').value = '';
  $('#manual-submit').disabled = true;
  $('#manual-results').hidden = true;
  $('#manual-name').setAttribute('aria-expanded', 'false');
}

async function loadManualCandidates() {
  const day = selectedDay();
  manualCandidates = [];
  resetManualSearch();
  if (!day) return;
  const result = await api(`/api/admin/attendance/attendees?event_day_id=${encodeURIComponent(day.id)}`);
  manualCandidates = result.attendees;
}

function renderManualMatches() {
  selectedManualRegistration = null;
  $('#manual-submit').disabled = true;
  const results = $('#manual-results');
  const query = $('#manual-name').value.trim().toLocaleLowerCase();
  if (!query) {
    results.hidden = true;
    $('#manual-name').setAttribute('aria-expanded', 'false');
    return;
  }
  const matches = manualCandidates
    .filter((item) => `${item.name} ${item.designation} ${item.organisation}`.toLocaleLowerCase().includes(query))
    .sort((a, b) => (a.attendance_status === b.attendance_status ? a.name.localeCompare(b.name)
      : a.attendance_status === 'pending' ? -1 : 1))
    .slice(0, 8);
  results.innerHTML = matches.length ? matches.map((item) => `
    <button type="button" role="option" data-manual-registration="${escapeHtml(item.registration_id)}">
      <strong>${escapeHtml(item.name)}</strong>
      <span>${escapeHtml(item.designation || item.organisation || 'No details')}</span>
      <small>${escapeHtml(item.organisation || '')}${item.attendance_status === 'present' ? ' / Already present' : ''}</small>
    </button>`).join('') : '<p class="muted">No attendee found.</p>';
  results.hidden = false;
  $('#manual-name').setAttribute('aria-expanded', 'true');
}

async function stopScanner() {
  if (!scanner) return;
  const current = scanner;
  scanner = null;
  try { await current.clear(); } catch { /* scanner may not have started */ }
}

async function startScanner() {
  await stopScanner();
  $('#scan-result').hidden = true;
  $('#scan-panel').hidden = false;
  busy = false;
  if (!window.Html5QrcodeScanner) {
    showError('QR scanner could not load. Refresh the page or use attendee name search.');
    return;
  }
  scanner = new window.Html5QrcodeScanner('qr-reader', {
    fps: 10,
    qrbox: (width, height) => {
      const size = Math.floor(Math.min(width, height) * 0.72);
      return { width: size, height: size };
    },
    rememberLastUsedCamera: true,
    supportedScanTypes: [window.Html5QrcodeScanType.SCAN_TYPE_CAMERA, window.Html5QrcodeScanType.SCAN_TYPE_FILE],
  }, false);
  scanner.render((decodedText) => submitScan(decodedText), () => {});
}

const STATUS = {
  INVALID: ['Invalid QR code', 'This QR code is not recognised.', 'bad'],
  REVOKED: ['Credential revoked', 'This credential was replaced or the registration was cancelled.', 'bad'],
  WRONG_EVENT: ['Wrong event', 'This credential does not belong to the selected event day.', 'bad'],
  OUTSIDE_CHECKIN_WINDOW: ['Check-in closed', 'The event or its check-in window is not open.', 'warn'],
};

function renderResult(result) {
  const accepted = result.status === 'CHECKED_IN' || result.status === 'ALREADY_CHECKED_IN';
  const [title, detail, kind] = accepted
    ? [result.status === 'CHECKED_IN' ? 'Attendance taken' : 'Already checked in', result.status === 'CHECKED_IN' ? 'Verified and saved successfully.' : 'No duplicate was created.', result.status === 'CHECKED_IN' ? 'good' : 'warn']
    : (STATUS[result.status] ?? ['Scan rejected', 'The server could not verify this credential.', 'bad']);
  const photo = accepted && result.has_photo
    ? `<img class="scanner-photo" src="/api/admin/participants/${escapeHtml(result.attendee_id)}/photo" alt="Attendee photo">`
    : accepted ? '<div class="scanner-photo placeholder" aria-hidden="true">✓</div>' : '';
  $('#scan-panel').hidden = true;
  const panel = $('#scan-result');
  panel.className = `card scanner-result ${kind}`;
  panel.innerHTML = `
    <div class="result-mark" aria-hidden="true">${kind === 'good' ? '✓' : kind === 'warn' ? '!' : '×'}</div>
    <h2>${escapeHtml(title)}</h2><p>${escapeHtml(detail)}</p>
    ${accepted ? `<div class="scanner-person">${photo}<div><strong>${escapeHtml(result.name)}</strong><span>${escapeHtml(result.designation || '—')}</span><span>${escapeHtml(result.email || '—')}</span><span>${escapeHtml(result.organisation || '—')}</span><span>${escapeHtml(result.event)} · ${escapeHtml(result.day)}</span><small>First check-in: ${result.checked_in_at ? formatTime(result.checked_in_at) : 'just now'}</small></div></div>` : ''}
    <button class="btn primary scanner-main-button" id="scan-next" type="button">Scan next attendee</button>`;
  panel.hidden = false;
  $('#scan-next').addEventListener('click', startScanner);
  if (navigator.vibrate) navigator.vibrate(kind === 'good' ? 120 : [100, 80, 100]);
}

async function submitManualCheckIn(registrationId) {
  if (busy) return;
  if (!navigator.onLine) { showError('You are offline. Reconnect before checking in.'); return; }
  const day = selectedDay();
  if (!day) { showError('Choose an event day.'); return; }
  busy = true;
  showError('');
  await stopScanner();
  try {
    const result = await api('/api/admin/attendance/check-in-manual', {
      method: 'POST',
      body: {
        registration_id: registrationId,
        event_day_id: day.id,
        scan_id: randomId(),
        device_id: deviceId(),
        scanned_at_device: new Date().toISOString(),
      },
    });
    const candidate = manualCandidates.find((item) => item.registration_id === registrationId);
    if (candidate && ['CHECKED_IN', 'ALREADY_CHECKED_IN'].includes(result.status)) {
      candidate.attendance_status = 'present';
    }
    resetManualSearch();
    renderResult(result);
  } catch (error) {
    busy = false;
    if (error.status === 401) showLogin('Your session expired. Log in again.');
    else {
      showError(error.message);
      $('#scan-panel').hidden = false;
      startScanner();
    }
  }
}

function credentialFromScan(value) {
  const raw = String(value).trim();
  try {
    const url = new URL(raw);
    if (url.pathname.endsWith('/verify.html') && url.hash.length > 1) {
      return decodeURIComponent(url.hash.slice(1)).trim();
    }
  } catch {
    // Raw QR credentials and manual fallback codes are not URLs.
  }
  return raw;
}

async function submitScan(credential) {
  if (busy) return;
  if (!navigator.onLine) { showError('You are offline. Reconnect before scanning.'); return; }
  const day = selectedDay();
  if (!day) { showError('Choose an event day.'); return; }
  busy = true;
  showError('');
  await stopScanner();
  try {
    const result = await api('/api/admin/attendance/check-in', {
      method: 'POST',
      body: {
        credential: credentialFromScan(credential), event_day_id: day.id,
        scan_id: randomId(), device_id: deviceId(), scanned_at_device: new Date().toISOString(),
      },
    });
    renderResult(result);
  } catch (error) {
    busy = false;
    if (error.status === 401) showLogin('Your session expired. Log in again.');
    else {
      showError(error.message);
      $('#scan-panel').hidden = false;
      startScanner();
    }
  }
}

$('#scanner-login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    await api('/api/admin/login', { method: 'POST', body: { password: $('#scanner-password').value } });
    $('#scanner-password').value = '';
    await loadScanner();
  } catch (error) {
    showLogin(error.message);
  } finally { button.disabled = false; }
});

$('#manual-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!selectedManualRegistration) { showError('Search for and select an attendee.'); return; }
  submitManualCheckIn(selectedManualRegistration);
});

$('#manual-name').addEventListener('input', renderManualMatches);
$('#manual-results').addEventListener('click', (event) => {
  const option = event.target.closest('[data-manual-registration]');
  if (!option) return;
  const candidate = manualCandidates.find((item) => item.registration_id === option.dataset.manualRegistration);
  if (!candidate) return;
  selectedManualRegistration = candidate.registration_id;
  $('#manual-name').value = candidate.name;
  $('#manual-submit').disabled = false;
  $('#manual-results').hidden = true;
  $('#manual-name').setAttribute('aria-expanded', 'false');
  showError('');
});

$('#event-day').addEventListener('change', async () => {
  try {
    await loadManualCandidates();
    await startScanner();
  } catch (error) {
    showError(error.message);
  }
});
$('#scanner-logout').addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});
window.addEventListener('online', updateNetwork);
window.addEventListener('offline', updateNetwork);
window.addEventListener('pagehide', stopScanner);

updateNetwork();
loadScanner().catch((error) => error.status === 401 ? showLogin() : showLogin(error.message));
