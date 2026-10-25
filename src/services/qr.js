import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { callRpc, runQuery } from '../db.js';
import {
  createCredential, credentialHash, normaliseFallbackCode, openCredential, sealCredential,
} from './credential.js';

const A4 = [595.28, 841.89];
const one = (value) => (Array.isArray(value) ? value[0] : value);

function company(attendee, organisations = []) {
  if (attendee.from_type === 'other') return attendee.organisation_name || '—';
  const matching = organisations.filter((organisation) => organisation.kind === attendee.from_type);
  const selected = matching.length ? matching : organisations;
  return selected.map((organisation) => organisation.name).filter(Boolean).join(', ') || '—';
}

function mapRows(rows) {
  return rows.map((row) => {
    const attendee = one(row.attendees) ?? {};
    return {
      registrationId: row.id,
      attendeeId: attendee.id,
      name: attendee.name || 'Unnamed attendee',
      company: company(attendee, row.registration_orgs ?? []),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export async function listQrEvents(db) {
  const [events, registrations] = await Promise.all([
    runQuery(db.from('events').select('id, code, name, starts_at, status')),
    runQuery(db.from('event_registrations').select('event_id').eq('status', 'confirmed')),
  ]);
  const counts = new Map();
  registrations.forEach(({ event_id: id }) => counts.set(id, (counts.get(id) ?? 0) + 1));
  const priority = { open: 0, draft: 1, closed: 2, archived: 3 };
  return events.map((event) => ({ ...event, confirmed_registrations: counts.get(event.id) ?? 0 }))
    .sort((a, b) => (priority[a.status] ?? 9) - (priority[b.status] ?? 9)
      || String(b.starts_at ?? '').localeCompare(String(a.starts_at ?? ''))
      || a.name.localeCompare(b.name));
}

async function loadBatch(db, eventId, registrationIds) {
  let query = db.from('event_registrations')
    .select('id, attendees(id, name, from_type, organisation_name), registration_orgs(kind, name)')
    .eq('event_id', eventId)
    .eq('status', 'confirmed');
  if (registrationIds?.length) query = query.in('id', registrationIds);
  const [events, rows] = await Promise.all([
    runQuery(db.from('events').select('id, code, name').eq('id', eventId)),
    runQuery(query),
  ]);
  if (!events[0]) return null;
  return { event: events[0], registrations: mapRows(rows) };
}

export async function listQrRegistrations(db, eventId) {
  const batch = await loadBatch(db, eventId);
  if (!batch) return null;
  const active = batch.registrations.length ? await runQuery(db.from('registration_credentials')
    .select('registration_id, print_payload')
    .in('registration_id', batch.registrations.map((item) => item.registrationId))
    .eq('status', 'active')) : [];
  const existing = new Set(active.filter((row) => row.print_payload).map((row) => row.registration_id));
  return {
    event: batch.event,
    registrations: batch.registrations.map((item) => ({
      id: item.registrationId,
      attendee_id: item.attendeeId,
      name: item.name,
      company: item.company,
      has_qr: existing.has(item.registrationId),
    })),
  };
}

function candidate(registration, secret) {
  const credential = createCredential();
  return {
    registration_id: registration.registrationId,
    token_hash: credential.tokenHash,
    fallback_code_hash: credential.fallbackHash,
    print_payload: sealCredential(credential, secret),
  };
}

function recover(row, secret) {
  const credential = openCredential(row.print_payload, secret);
  if (credentialHash(credential.token) !== row.token_hash
      || credentialHash(normaliseFallbackCode(credential.fallback)) !== row.fallback_code_hash) {
    throw new Error('Stored QR credential failed its integrity check.');
  }
  return credential;
}

function qrUrl(baseUrl, token) {
  const url = new URL('/verify.html', baseUrl);
  url.hash = encodeURIComponent(token);
  return url.href;
}

async function prepareBatch(db, eventId, { registrationIds, secret } = {}) {
  const batch = await loadBatch(db, eventId, registrationIds);
  if (!batch) return null;
  if (!batch.registrations.length) return { ...batch, empty: true };
  if (registrationIds?.length && batch.registrations.length !== registrationIds.length) {
    return { ...batch, invalidSelection: true };
  }
  const prepared = await callRpc(db, 'prepare_event_credentials', {
    p_event_id: eventId,
    p_items: batch.registrations.map((registration) => candidate(registration, secret)),
  });
  const byRegistration = new Map(prepared.map((row) => [row.registration_id, row]));
  return {
    ...batch,
    credentials: batch.registrations.map((registration) => recover(byRegistration.get(registration.registrationId), secret)),
  };
}

export async function generateQrPng(db, eventId, { registrationId, secret, baseUrl }) {
  const batch = await prepareBatch(db, eventId, { registrationIds: [registrationId], secret });
  if (!batch || batch.empty || batch.invalidSelection) return batch;
  const credential = batch.credentials[0];
  return {
    ...batch,
    png: await QRCode.toBuffer(qrUrl(baseUrl, credential.token), {
      type: 'png', width: 1200, margin: 4, errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#ffffff' },
    }),
  };
}

export async function generateQrPdf(db, eventId, { registrationIds, secret, baseUrl }) {
  const batch = await prepareBatch(db, eventId, { registrationIds, secret });
  if (!batch || batch.empty || batch.invalidSelection) return batch;
  const doc = new PDFDocument({ autoFirstPage: false, size: A4, margin: 0, info: { Title: `${batch.event.name} QR codes` } });
  const chunks = [];
  const complete = new Promise((resolve, reject) => {
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  for (let index = 0; index < batch.registrations.length; index += 1) {
    const registration = batch.registrations[index];
    const credential = batch.credentials[index];
    const qr = await QRCode.toBuffer(qrUrl(baseUrl, credential.token), {
      type: 'png', width: 1200, margin: 3, errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#ffffff' },
    });
    doc.addPage({ size: A4, margin: 0 });
    doc.fillColor('#002b61').font('Helvetica-Bold').fontSize(24)
      .text(registration.name, 70, 130, { width: A4[0] - 140, align: 'center' });
    doc.image(qr, (A4[0] - 300) / 2, 205, { width: 300, height: 300 });
    doc.fillColor('#334e70').font('Helvetica').fontSize(13)
      .text(credential.fallback, 70, 530, { width: A4[0] - 140, align: 'center' });
  }
  doc.end();
  return { ...batch, pdf: await complete };
}

function safeName(value) {
  return String(value || 'attendee').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'attendee';
}

export const qrPngFilename = (registration) => `${safeName(registration.name)}-qr.png`;
export const qrPdfFilename = (event) => `${safeName(event.code || event.name || 'event')}-qr-codes.pdf`;
