import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { createCredential, credentialHash } from '../src/services/credential.js';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function assertDemoAllowed() {
  if (process.env.ALLOW_DUMMY_SEED !== 'yes') {
    throw new Error('Refusing to seed without ALLOW_DUMMY_SEED=yes.');
  }
}

async function check(request, context) {
  const { data, error } = await request;
  if (error) throw new Error(`${context}: ${error.message}${error.details ? ` (${error.details})` : ''}`);
  return data;
}

async function attendeeByEmail(db, email) {
  const rows = await check(db.from('attendees').select('id').ilike('email', email), `Find ${email}`);
  return rows[0]?.id ?? null;
}

async function ensureAttendee(db, person) {
  const existing = await attendeeByEmail(db, person.email);
  if (existing) return existing;
  return check(db.rpc('register_attendee', { p: person }), `Register ${person.email}`);
}

async function snapshotOrganisations(db, registrationId, attendeeId) {
  const links = await check(
    db.from('attendee_orgs').select('org_id, code, organisations(kind, name)').eq('attendee_id', attendeeId),
    'Load registration organisations',
  );
  await check(db.from('registration_orgs').delete().eq('registration_id', registrationId), 'Refresh organisation snapshot');
  if (!links.length) return;
  await check(db.from('registration_orgs').insert(links.map((link) => ({
    registration_id: registrationId,
    org_id: link.org_id,
    kind: link.organisations.kind,
    name: link.organisations.name,
    code: link.code,
  }))), 'Save organisation snapshot');
}

async function main() {
  assertDemoAllowed();
  const db = createDb(loadConfig());

  const event = await check(db.from('events').upsert({
    code: 'demo-2026',
    name: 'Primark Bangladesh Origin Event',
    subtitle: 'Identity card and attendance demonstration',
    timezone: 'Asia/Dhaka',
    starts_at: '2026-11-04T09:00:00+06:00',
    ends_at: '2026-11-05T17:00:00+06:00',
    status: 'open',
  }, { onConflict: 'code' }).select('id, code, name').single(), 'Create demo event');

  const days = await check(db.from('event_days').upsert([
    { event_id: event.id, event_date: '2026-11-04', label: 'Day 1' },
    { event_id: event.id, event_date: '2026-11-05', label: 'Day 2' },
  ], { onConflict: 'event_id,event_date' }).select('id, event_date, label'), 'Create demo event days');
  days.sort((a, b) => a.event_date.localeCompare(b.event_date));

  const suppliers = await check(
    db.from('organisations').select('id, kind, name').eq('kind', 'supplier').eq('status', 'approved').order('name').limit(3),
    'Load suppliers',
  );
  const factories = await check(
    db.from('organisations').select('id, kind, name').eq('kind', 'factory').eq('status', 'approved').order('name').limit(5),
    'Load factories',
  );
  if (suppliers.length < 2 || factories.length < 5) throw new Error('Import organisation catalogues before demo seeding.');

  const people = [
    ...factories.map((org, index) => ({
      name: ['Aminul Islam', 'Farzana Akter', 'Mahmud Hasan', 'Nusrat Jahan', 'Tanvir Ahmed'][index],
      email: `demo.factory${index + 1}@example.test`,
      phone: `+88017000000${String(index + 1).padStart(2, '0')}`,
      designation: ['Production Manager', 'Compliance Officer', 'Quality Manager', 'Merchandiser', 'Factory Director'][index],
      from_type: 'factory', organisation_name: null, orgs: [{ kind: 'factory', org_id: org.id }],
    })),
    ...Array.from({ length: 4 }, (_, index) => ({
      name: ['Sadia Rahman', 'Imran Hossain', 'Jannatul Ferdous', 'Rakib Chowdhury'][index],
      email: `demo.supplier${index + 1}@example.test`,
      phone: `+88018000000${String(index + 1).padStart(2, '0')}`,
      designation: ['Account Manager', 'Sourcing Manager', 'Sustainability Lead', 'Commercial Director'][index],
      from_type: 'supplier', organisation_name: null,
      orgs: [{ kind: 'supplier', org_id: suppliers[Math.floor(index / 2)].id }],
    })),
    ...[
      ['Maya Sultana', 'Programme Coordinator', 'Primark Limited'],
      ['David Miller', 'Event Facilitator', 'Allport Cargo Services'],
      ['Sharmeen Kabir', 'Guest Speaker', 'PACD Bangladesh'],
    ].map(([name, designation, organisationName], index) => ({
      name, email: `demo.guest${index + 1}@example.test`, phone: `+88019000000${String(index + 1).padStart(2, '0')}`,
      designation, from_type: 'other', organisation_name: organisationName, orgs: [],
    })),
  ];

  const credentials = [];
  for (const [index, person] of people.entries()) {
    const attendeeId = await ensureAttendee(db, person);
    const registration = await check(db.from('event_registrations').upsert({
      event_id: event.id, attendee_id: attendeeId, status: 'confirmed',
    }, { onConflict: 'event_id,attendee_id' }).select('id').single(), `Create registration for ${person.email}`);
    await snapshotOrganisations(db, registration.id, attendeeId);

    const credential = createCredential();
    const credentialId = await check(db.rpc('issue_registration_credential', {
      p_registration_id: registration.id,
      p_token_hash: credential.tokenHash,
      p_fallback_code_hash: credential.fallbackHash,
    }), `Issue credential for ${person.email}`);
    credentials.push({
      name: person.name,
      email: person.email,
      registrationId: registration.id,
      credentialId,
      token: credential.token,
      fallback: credential.fallback,
      expectedStatus: 'ACTIVE',
    });

    if (index === 2) {
      await check(db.from('registration_credentials').update({
        status: 'revoked', revoked_at: new Date().toISOString(),
      }).eq('id', credentialId), 'Create revoked-card scenario');
      credentials[index].expectedStatus = 'REVOKED';
    }
    if (index === 3) {
      await check(db.from('event_registrations').update({ status: 'cancelled' }).eq('id', registration.id), 'Create cancelled-registration scenario');
      credentials[index].expectedStatus = 'REVOKED';
    }
  }

  for (const index of [0, 1]) {
    const result = await check(db.rpc('check_in_registration', {
      p_credential_hash: credentialHash(credentials[index].token),
      p_event_day_id: days[0].id,
      p_scan_id: randomUUID(),
      p_device_id: 'demo-seeder',
      p_scanned_at_device: new Date().toISOString(),
      p_source: 'online',
    }), `Seed attendance for ${credentials[index].email}`);
    if (!['CHECKED_IN', 'ALREADY_CHECKED_IN'].includes(result.status)) {
      throw new Error(`Seed attendance returned ${result.status}`);
    }
    credentials[index].expectedStatus = 'ALREADY_CHECKED_IN';
  }

  const outputDirectory = path.join(projectRoot, '.demo');
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, 'credentials.json'), `${JSON.stringify({
    generatedAt: new Date().toISOString(), event, days, credentials,
  }, null, 2)}\n`, { encoding: 'utf8' });

  console.log(`Seeded ${people.length} attendees, ${days.length} event days, and ${credentials.length} QR credentials.`);
  console.log('Dummy QR values were written to .demo/credentials.json (ignored by Git).');
}

try {
  await main();
} catch (error) {
  console.error(`Demo seed failed: ${error.message}`);
  process.exitCode = 1;
}
