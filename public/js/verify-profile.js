import { EVENT_TIME_ZONE } from '/shared/constants.js';

const $ = (selector) => document.querySelector(selector);
const TYPE_LABELS = { supplier: 'Supplier', factory: 'Factory', other: 'Other' };
let photoUrl = null;

function credentialFromFragment() {
  const value = window.location.hash.slice(1);
  if (!value) return '';
  try { return decodeURIComponent(value).trim(); } catch { return value.trim(); }
}

async function request(path, payload) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: path.endsWith('/photo') ? 'image/*' : 'application/json' },
    body: JSON.stringify(payload),
    cache: 'no-store',
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || 'This QR code is invalid or no longer active.');
  }
  return response;
}

function initials(name) {
  return String(name).trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '?';
}

function showError(message) {
  $('#profile-loading').hidden = true;
  $('#profile-result').hidden = true;
  $('#profile-error-message').textContent = message;
  $('#profile-error').hidden = false;
}

async function loadPhoto(credential, profile) {
  const image = $('#profile-photo');
  const placeholder = $('#profile-initials');
  placeholder.textContent = initials(profile.name);
  if (!profile.has_photo) return;
  try {
    const response = await request('/api/attendee-profile/photo', { credential });
    photoUrl = URL.createObjectURL(await response.blob());
    image.src = photoUrl;
    image.alt = `Photo of ${profile.name}`;
    image.hidden = false;
    placeholder.hidden = true;
  } catch {
    // The verified profile remains useful when its optional photo is unavailable.
  }
}

const clock = (value, options) => new Date(value).toLocaleString('en-GB', { timeZone: EVENT_TIME_ZONE, ...options });
const timeOnly = (value) => clock(value, { hour: '2-digit', minute: '2-digit' });

function sessionOption(session) {
  const option = document.createElement('option');
  option.value = session.id;
  const isBreak = session.kind !== 'session';
  option.textContent = `${timeOnly(session.starts_at)} · ${session.title}${isBreak ? ' (break)' : ''}`;
  option.disabled = isBreak;
  return option;
}

// User-written text, so every value goes in as a text node: never innerHTML.
function questionItem(question) {
  const item = document.createElement('li');
  const head = document.createElement('span');
  head.className = 'qa-list-meta';
  head.textContent = `${question.session_title} · ${clock(question.asked_at, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  })}`;
  const body = document.createElement('p');
  body.textContent = question.body;
  item.append(head, body);
  return item;
}

function addQuestion(question) {
  $('#qa-list').prepend(questionItem(question));
  $('#qa-mine').hidden = false;
}

function renderQa(credential, qa) {
  if (!qa) return;
  $('#qa').hidden = false;
  qa.my_questions.forEach(addQuestion);

  // Asking needs a check-in; the programme and earlier questions stay readable without one.
  if (!qa.checked_in) {
    $('#qa-locked').hidden = false;
    return;
  }

  const form = $('#qa-form');
  const select = $('#qa-session');
  select.append(...qa.sessions.map(sessionOption));
  if (qa.live_session_id) select.value = qa.live_session_id;
  form.hidden = false;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const send = $('#qa-send');
    const bodyField = $('#qa-body');
    const error = $('#qa-error');
    error.hidden = true;
    $('#qa-sent').hidden = true;
    send.disabled = true;
    try {
      const response = await request('/api/questions', {
        credential, session_id: select.value, body: bodyField.value,
      });
      addQuestion(await response.json());
      bodyField.value = '';
      $('#qa-sent').hidden = false;
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
    } finally {
      send.disabled = false;
    }
  });
}

async function loadProfile() {
  const credential = credentialFromFragment();
  if (!credential) {
    showError('Scan the attendee QR code to open this verification page.');
    return;
  }
  try {
    const response = await request('/api/attendee-profile', { credential });
    const profile = await response.json();
    const isOther = profile.attendee_type === 'other';
    $('#profile-name').textContent = profile.name;
    $('#profile-role').textContent = profile.designation || 'Registered attendee';
    $('#profile-supplier').textContent = profile.supplier || '—';
    $('#profile-factory').textContent = profile.factory || '—';
    $('#profile-organisation').textContent = profile.organisation_name || 'Not provided';
    $('#profile-supplier-row').hidden = isOther;
    $('#profile-factory-row').hidden = isOther;
    $('#profile-organisation-row').hidden = !isOther;
    $('#profile-type-row').hidden = isOther;
    $('#profile-type').textContent = TYPE_LABELS[profile.attendee_type] || 'Other';
    const email = $('#profile-email');
    email.textContent = profile.email || 'Not provided';
    if (profile.email) email.href = `mailto:${profile.email}`; else email.removeAttribute('href');
    $('#profile-loading').hidden = true;
    $('#profile-result').hidden = false;
    renderQa(credential, profile.qa);
    await loadPhoto(credential, profile);
  } catch (error) {
    showError(error.message);
  }
}

window.addEventListener('pagehide', () => { if (photoUrl) URL.revokeObjectURL(photoUrl); });
loadProfile();
