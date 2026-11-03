import { credentialHash } from './credential.js';
import { callRpc, runQuery } from '../db.js';
import { errors } from '../errors.js';

const TOKEN_RE = /^ER1\.[A-Za-z0-9_-]{32}$/;
const one = (value) => (Array.isArray(value) ? value[0] : value);

export function parseVerificationUrl(value, baseUrl, field = 'url') {
  const input = String(value ?? '').trim();
  if (!input || input.length > 2048) {
    throw errors.validation({ [field]: 'Paste the complete verification URL.' });
  }
  let url;
  try {
    url = new URL(input);
  } catch {
    throw errors.validation({ [field]: 'Paste a valid full URL beginning with https://.' });
  }
  const expected = new URL(baseUrl);
  let token;
  try {
    token = decodeURIComponent(url.hash.slice(1));
  } catch {
    token = '';
  }
  if (url.origin !== expected.origin || url.pathname !== '/verify.html' || url.search
      || !TOKEN_RE.test(token)) {
    throw errors.validation({ [field]: `Paste a complete ${expected.origin}/verify.html#ER1... URL.` });
  }
  return { url: url.href, token, tokenHash: credentialHash(token) };
}

async function lookupToken(db, tokenHash) {
  const credentials = await runQuery(db.from('registration_credentials')
    .select('id, registration_id, status')
    .eq('token_hash', tokenHash)
    .eq('status', 'active'));
  const credential = credentials[0];
  if (!credential) throw errors.notFound('No active attendee was found for this QR URL.');

  const registrations = await runQuery(db.from('event_registrations')
    .select('id, event_id, attendee_id, status')
    .eq('id', credential.registration_id));
  const registration = registrations[0];
  if (!registration) throw errors.notFound('The QR registration no longer exists.');

  const [attendees, events, organisations] = await Promise.all([
    runQuery(db.from('attendees')
      .select('id, name, email, phone, designation, from_type, organisation_name')
      .eq('id', registration.attendee_id)),
    runQuery(db.from('events').select('id, code, name').eq('id', registration.event_id)),
    runQuery(db.from('registration_orgs').select('kind, name').eq('registration_id', registration.id)),
  ]);
  const attendee = attendees[0];
  if (!attendee) throw errors.notFound('The attendee linked to this QR no longer exists.');

  return {
    credential_id: credential.id,
    registration_id: registration.id,
    registration_status: registration.status,
    attendee,
    event: events[0] ?? null,
    organisations,
  };
}

export async function previewCredentialRecovery(db, fullUrl, baseUrl) {
  const current = parseVerificationUrl(fullUrl, baseUrl, 'current_url');
  return lookupToken(db, current.tokenHash);
}

export async function restoreDistributedCredential(db, input, baseUrl) {
  const current = parseVerificationUrl(input?.current_url, baseUrl, 'current_url');
  const distributed = parseVerificationUrl(input?.distributed_url, baseUrl, 'distributed_url');
  if (current.tokenHash === distributed.tokenHash) {
    throw errors.validation({ distributed_url: 'The distributed URL must be different from the current URL.' });
  }

  const preview = await lookupToken(db, current.tokenHash);
  if (preview.registration_status !== 'confirmed') {
    throw errors.conflict('This attendee registration is not confirmed.');
  }
  const registrationId = await callRpc(db, 'restore_distributed_credential', {
    p_current_token_hash: current.tokenHash,
    p_distributed_token_hash: distributed.tokenHash,
    p_distributed_token: distributed.token,
  });
  if (one(registrationId) !== preview.registration_id) {
    throw errors.conflict('The credential changed during recovery. Look it up again.');
  }
  return lookupToken(db, distributed.tokenHash);
}
