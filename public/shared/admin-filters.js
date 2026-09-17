// Pure search/filter helpers for the admin dashboard tables.
const norm = (value) => String(value ?? '').toLowerCase();
const matches = (query, values) => !query || values.some((value) => norm(value).includes(query));

export function filterParticipants(participants, { search = '', side = 'all' } = {}) {
  const query = norm(search).trim();
  return participants.filter((p) =>
    (side === 'all' || p.from_type === side)
    && matches(query, [p.name, p.email, p.phone, ...p.suppliers.map((o) => o.name), ...p.factories.map((o) => o.name)]));
}

export function filterOrganisations(organisations, { kind, search = '', status = 'all' }) {
  const query = norm(search).trim();
  return organisations.filter((o) =>
    o.kind === kind
    && (status === 'all' || o.reg_status === status)
    && matches(query, [o.name, ...o.people.map((p) => p.name)]));
}

export function filterPending(pending, { search = '' } = {}) {
  const query = norm(search).trim();
  return pending.filter((o) => matches(query, [o.name]));
}
