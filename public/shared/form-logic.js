// Pure helpers for the registration form. No DOM access, so they can be unit tested in Node.
export const SEAT_LIMIT = 2;

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// ownSeat: the person being edited already holds a seat here, so don't count it against them.
export function seatInfo(org, fromType, ownSeat = false) {
  if (!fromType || org.kind !== fromType) return { left: null, full: false, label: '' };
  const used = org.seats_used - (ownSeat ? 1 : 0);
  const left = Math.max(0, SEAT_LIMIT - used);
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

export function buildPayload({ fromType, name, email, phone, website = '', rows }) {
  return {
    from_type: fromType,
    name,
    email,
    phone,
    website,
    orgs: rows.map((r) => (r.org_id != null
      ? { kind: r.kind, org_id: r.org_id, code: r.code }
      : { kind: r.kind, other_name: r.other_name, code: r.code })),
  };
}

export function orderRows(rows) {
  return [...rows.filter((r) => r.kind === 'supplier'), ...rows.filter((r) => r.kind === 'factory')];
}
