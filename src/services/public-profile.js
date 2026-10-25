import { runQuery } from '../db.js';
import { errors } from '../errors.js';
import { scannedCredentialHash } from './credential.js';

const one = (value) => (Array.isArray(value) ? value[0] : value);

export function publicCredential(value) {
  const credential = String(value ?? '').trim();
  if (credential.length < 6 || credential.length > 512) {
    throw errors.validation({ credential: 'Scan a valid attendee QR code.' });
  }
  return credential;
}

function organisation(attendee, snapshots) {
  const names = snapshots.map((item) => item.name).filter(Boolean);
  return names.join(', ') || attendee.organisation_name || 'Not provided';
}

export async function loadPublicProfile(db, value) {
  const hash = scannedCredentialHash(publicCredential(value));
  const credentials = await runQuery(db.from('registration_credentials')
    .select('registration_id, status')
    .or(`token_hash.eq.${hash},fallback_code_hash.eq.${hash}`)
    .limit(1));
  const credential = credentials[0];
  if (!credential || credential.status !== 'active') return null;

  const registrations = await runQuery(db.from('event_registrations')
    .select(`id, status,
      attendees(id, name, email, designation, from_type, organisation_name, photo_path),
      events(name, subtitle),
      registration_orgs(kind, name)`)
    .eq('id', credential.registration_id)
    .limit(1));
  const registration = registrations[0];
  const attendee = one(registration?.attendees);
  const event = one(registration?.events);
  if (!registration || registration.status !== 'confirmed' || !attendee) return null;

  return {
    profile: {
      name: attendee.name || 'Unnamed attendee',
      email: attendee.email || '',
      designation: attendee.designation || '',
      attendee_type: attendee.from_type || 'other',
      organisation: organisation(attendee, registration.registration_orgs ?? []),
      event: event?.name || '',
      event_subtitle: event?.subtitle || '',
      has_photo: Boolean(attendee.photo_path),
    },
    photoPath: attendee.photo_path || null,
  };
}
