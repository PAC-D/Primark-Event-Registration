// Rows shaped like org_status (ordered by name) and attendees with embedded attendee_orgs.
export const fixtureNow = new Date('2026-09-17T08:30:00Z');

export const fixtureOrgs = [
  { id: 3, kind: 'factory', name: 'Aspire Garments (24040)', source: 'list', status: 'approved', seats_used: 2, linked_count: 2, created_at: '2026-09-01T00:00:00Z' },
  { id: 6, kind: 'supplier', name: 'New Supplier Co', source: 'attendee', status: 'approved', seats_used: 0, linked_count: 0, created_at: '2026-09-10T00:00:00Z' },
  { id: 1, kind: 'supplier', name: 'Padma Textiles Ltd', source: 'list', status: 'approved', seats_used: 1, linked_count: 2, created_at: '2026-09-01T00:00:00Z' },
  { id: 2, kind: 'supplier', name: 'Pearl Global', source: 'list', status: 'approved', seats_used: 0, linked_count: 0, created_at: '2026-09-01T00:00:00Z' },
  { id: 5, kind: 'factory', name: 'Rainbow Knit Ltd', source: 'attendee', status: 'pending', seats_used: 1, linked_count: 1, created_at: '2026-09-17T06:15:00Z' },
  { id: 4, kind: 'factory', name: 'Windy Apparels (20096)', source: 'list', status: 'approved', seats_used: 0, linked_count: 0, created_at: '2026-09-01T00:00:00Z' },
];

export const fixtureAttendees = [
  {
    id: 'a1', name: 'Rahim Uddin', email: 'rahim@example.com', phone: '+8801711000001', from_type: 'factory',
    created_at: '2026-09-17T08:00:00Z', updated_at: '2026-09-17T08:00:00Z',
    attendee_orgs: [{ org_id: 1, code: 'S-1' }, { org_id: 5, code: 'R-5' }, { org_id: 3, code: 'F-3' }],
  },
  {
    id: 'a2', name: 'Karim Ahmed', email: 'karim@example.com', phone: '+8801711000002', from_type: 'factory',
    created_at: '2026-09-17T09:00:00Z', updated_at: '2026-09-17T09:00:00Z',
    attendee_orgs: [{ org_id: 3, code: 'F-3b' }],
  },
  {
    id: 'a3', name: 'Salma Begum', email: 'salma@example.com', phone: '+8801711000003', from_type: 'supplier',
    created_at: '2026-09-17T10:00:00Z', updated_at: '2026-09-17T10:00:00Z',
    attendee_orgs: [{ org_id: 1, code: 'S-1c' }],
  },
];
