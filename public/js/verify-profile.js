const $ = (selector) => document.querySelector(selector);
const TYPE_LABELS = { supplier: 'Supplier', factory: 'Factory', other: 'Other' };
let photoUrl = null;

function credentialFromFragment() {
  const value = window.location.hash.slice(1);
  if (!value) return '';
  try { return decodeURIComponent(value).trim(); } catch { return value.trim(); }
}

async function request(path, credential) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: path.endsWith('/photo') ? 'image/*' : 'application/json' },
    body: JSON.stringify({ credential }),
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
    const response = await request('/api/attendee-profile/photo', credential);
    photoUrl = URL.createObjectURL(await response.blob());
    image.src = photoUrl;
    image.alt = `Photo of ${profile.name}`;
    image.hidden = false;
    placeholder.hidden = true;
  } catch {
    // The verified profile remains useful when its optional photo is unavailable.
  }
}

async function loadProfile() {
  const credential = credentialFromFragment();
  if (!credential) {
    showError('Scan the attendee QR code to open this verification page.');
    return;
  }
  try {
    const response = await request('/api/attendee-profile', credential);
    const profile = await response.json();
    $('#profile-name').textContent = profile.name;
    $('#profile-role').textContent = profile.designation || 'Registered attendee';
    $('#profile-company').textContent = profile.organisation;
    $('#profile-type').textContent = TYPE_LABELS[profile.attendee_type] || 'Other';
    $('#profile-event').textContent = [profile.event, profile.event_subtitle].filter(Boolean).join(' · ') || 'Current event';
    const email = $('#profile-email');
    email.textContent = profile.email || 'Not provided';
    if (profile.email) email.href = `mailto:${profile.email}`; else email.removeAttribute('href');
    $('#profile-loading').hidden = true;
    $('#profile-result').hidden = false;
    await loadPhoto(credential, profile);
  } catch (error) {
    showError(error.message);
  }
}

window.addEventListener('pagehide', () => { if (photoUrl) URL.revokeObjectURL(photoUrl); });
loadProfile();
