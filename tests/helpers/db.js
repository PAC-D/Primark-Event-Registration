import { createClient } from '@supabase/supabase-js';

const clientOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionTokenInUrl: false } };

// false when the test DB is configured, otherwise a reason string for node:test's `skip` option.
export const skipReason = process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY
  ? false
  : 'test database not configured (.env.test)';

export function testDb() {
  if (process.env.ALLOW_DB_WIPE !== 'yes') {
    throw new Error('Refusing to run database tests without ALLOW_DB_WIPE=yes: they delete all data.');
  }
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, clientOptions);
}

export function anonDb() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY, clientOptions);
}

export async function check(request) {
  const { data, error } = await request;
  if (error) throw new Error(`${error.code ?? ''} ${error.message} ${error.details ?? ''}`.trim());
  return data;
}

export async function wipe(db) {
  await check(db.from('attendee_orgs').delete().not('attendee_id', 'is', null));
  await check(db.from('attendees').delete().not('id', 'is', null));
  await check(db.from('organisations').delete().gt('id', 0));
}

// spec: { alias: { kind, name, status?, source?, code? } } → { alias: row }
export async function seedOrgs(db, spec) {
  const entries = Object.entries(spec);
  const rows = await check(
    db.from('organisations')
      .insert(entries.map(([, o]) => ({
        kind: o.kind,
        name: o.name,
        code: o.code ?? null,
        status: o.status ?? 'approved',
        source: o.source ?? 'list',
      })))
      .select('id, kind, name, match_key, status, source, code'),
  );
  const byName = new Map(rows.map((row) => [row.name, row]));
  return Object.fromEntries(entries.map(([alias, o]) => [alias, byName.get(o.name)]));
}

// Pick a listed organisation for a payload. Codes are resolved server-side from organisations.code.
export const pick = (org) => ({ kind: org.kind, org_id: org.id });

export function payload({
  from = 'factory', email = 'person@example.com', name = 'Test Person', phone = '+8801711000000',
  designation = 'Test Officer', photo_path = null, organisation_name = null, orgs,
}) {
  const p = { from_type: from, name, email, phone, designation, orgs };
  if (photo_path) p.photo_path = photo_path;
  if (from === 'other') p.organisation_name = organisation_name;
  return p;
}

export const register = (db, p) => db.rpc('register_attendee', { p });

export async function seats(db, orgId) {
  const [row] = await check(db.from('org_status').select('seats_used, linked_count').eq('id', orgId));
  return row;
}

export async function findOrgs(db, filters) {
  let request = db.from('organisations').select('id, kind, name, match_key, status, source, code');
  for (const [column, value] of Object.entries(filters)) request = request.eq(column, value);
  return check(request);
}
