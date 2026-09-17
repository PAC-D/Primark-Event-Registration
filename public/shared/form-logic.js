// Pure helpers for the registration form. No DOM access, so they can be unit tested in Node.
import { SEAT_LIMIT } from './constants.js';

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// ownSeat: the person being edited already holds a seat here. The server does not re-check such
// organisations, so they are never full for that person (even over the limit after "merge anyway").
export function seatInfo(org, fromType, ownSeat = false) {
  if (!fromType || org.kind !== fromType) return { left: null, full: false, label: '' };
  const used = org.seats_used - (ownSeat ? 1 : 0);
  const left = Math.max(ownSeat ? 1 : 0, SEAT_LIMIT - used);
  if (left === 0) return { left, full: true, label: '(full)' };
  return { left, full: false, label: `· ${left} seat${left === 1 ? '' : 's'} left` };
}

export function pickerOptions(orgs, { kind, fromType = null, selectedIds = new Set(), ownSeatIds = new Set() }) {
  return orgs
    .filter((o) => o.kind === kind && !selectedIds.has(o.id))
    .map((o) => {
      const info = seatInfo(o, fromType, ownSeatIds.has(o.id));
      return { value: String(o.id), text: o.name, hint: info.label, disabled: info.full };
    });
}

// A row picked from the organisation list (as opposed to a typed "Not in the list" name).
export const isListed = (row) => row.org_id !== undefined && row.org_id !== null;

export function buildPayload({ fromType, name, email, phone, website = '', rows }) {
  return {
    from_type: fromType,
    name,
    email,
    phone,
    website,
    orgs: rows.map((r) => (isListed(r)
      ? { kind: r.kind, org_id: r.org_id, code: r.code }
      : { kind: r.kind, other_name: r.other_name, code: r.code })),
  };
}

export function orderRows(rows) {
  return [...rows.filter((r) => r.kind === 'supplier'), ...rows.filter((r) => r.kind === 'factory')];
}
