import { SEAT_LIMIT } from '../../public/shared/constants.js';
import { runQuery } from '../db.js';

const KINDS = ['supplier', 'factory'];

export function registrationStatus({ seats_used, linked_count }) {
  if (seats_used >= SEAT_LIMIT) return 'full';
  if (linked_count >= 1) return 'registered';
  return 'missing';
}

export async function loadDashboard(db) {
  const [orgs, attendees] = await Promise.all([
    runQuery(db.from('org_status')
      .select('id, kind, name, source, status, created_at, seats_used, linked_count')
      .order('name')),
    runQuery(db.from('attendees')
      .select('id, name, email, phone, from_type, created_at, updated_at, attendee_orgs(org_id, code)')
      .order('created_at')),
  ]);
  return buildDashboard({ orgs, attendees, now: new Date() });
}

export function buildDashboard({ orgs, attendees, now }) {
  const orgById = new Map(orgs.map((o) => [o.id, o]));
  const peopleByOrg = new Map(orgs.map((o) => [o.id, []]));

  const participants = attendees.map((a) => {
    const links = a.attendee_orgs
      .filter((link) => orgById.has(link.org_id))
      .map((link) => ({ ...link, org: orgById.get(link.org_id) }))
      .sort((x, y) => x.org.name.localeCompare(y.org.name));

    for (const link of links) {
      peopleByOrg.get(link.org_id).push({ id: a.id, name: a.name, from_type: a.from_type, code: link.code });
    }

    const side = (kind) => links
      .filter((link) => link.org.kind === kind)
      .map((link) => ({
        org_id: link.org_id,
        name: link.org.name,
        code: link.code,
        status: link.org.status,
        uses_seat: kind === a.from_type,
      }));

    return {
      id: a.id,
      name: a.name,
      email: a.email,
      phone: a.phone,
      from_type: a.from_type,
      created_at: a.created_at,
      updated_at: a.updated_at,
      suppliers: side('supplier'),
      factories: side('factory'),
    };
  });

  const toRow = (o) => ({ ...o, reg_status: registrationStatus(o), people: peopleByOrg.get(o.id) });
  const organisations = orgs.filter((o) => o.status === 'approved').map(toRow);
  const pending = orgs.filter((o) => o.status === 'pending').map(toRow);

  const kindSummary = (kind) => {
    const approved = organisations.filter((o) => o.kind === kind);
    const list = approved.filter((o) => o.source === 'list');
    return {
      list_total: list.length,
      list_registered: list.filter((o) => o.linked_count >= 1).length,
      missing: approved.filter((o) => o.reg_status === 'missing').length,
      full: approved.filter((o) => o.reg_status === 'full').length,
    };
  };

  const [suppliers, factories] = KINDS.map(kindSummary);
  return {
    generated_at: now.toISOString(),
    summary: {
      participants: {
        total: participants.length,
        supplier: participants.filter((p) => p.from_type === 'supplier').length,
        factory: participants.filter((p) => p.from_type === 'factory').length,
      },
      suppliers,
      factories,
      pending: pending.length,
    },
    participants,
    organisations,
    pending,
  };
}
