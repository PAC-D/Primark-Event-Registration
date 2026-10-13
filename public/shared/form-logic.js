// Pure helpers for the registration form. No DOM access, so they can be unit tested in Node.
import { SEAT_LIMITS } from './constants.js';

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// ownSeat: the person being edited already holds a seat here. The server does not re-check such
// organisations, so they are never full for that person (even over the limit after "merge anyway").
export function seatInfo(org, fromType, ownSeat = false) {
  const limit = SEAT_LIMITS[org.kind];
  if (!limit || !fromType || org.kind !== fromType) return { left: null, full: false, label: '' };
  const used = org.seats_used - (ownSeat ? 1 : 0);
  const left = Math.max(ownSeat ? 1 : 0, limit - used);
  if (left === 0) return { left, full: true, label: '(full)' };
  return { left, full: false, label: `· ${left} seat${left === 1 ? '' : 's'} left` };
}

// Dropdown options deliberately carry no seat status: which organisations are full is not
// disclosed at a glance. Fullness is only remarked on after the visitor picks such an org
// (see the "already filled" note on full rows in the registration form).
export function pickerOptions(orgs, { kind, selectedIds = new Set() }) {
  return orgs
    .filter((o) => o.kind === kind && !selectedIds.has(o.id))
    .map((o) => ({ value: String(o.id), text: o.name }));
}

export function buildPayload({
  fromType, name, email, phone, designation, website = '', rows = [], photoPath = null, organisationName = '',
}) {
  const payload = { from_type: fromType, name, email, phone, designation, website };
  if (photoPath) payload.photo_path = photoPath;
  if (fromType === 'other') {
    payload.organisation_name = organisationName;
    payload.orgs = [];
  } else {
    payload.orgs = rows.map((r) => ({ kind: r.kind, org_id: r.org_id }));
  }
  return payload;
}

export function orderRows(rows) {
  return [...rows.filter((r) => r.kind === 'supplier'), ...rows.filter((r) => r.kind === 'factory')];
}
