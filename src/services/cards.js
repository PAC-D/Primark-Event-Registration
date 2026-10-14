import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { callRpc, runQuery } from '../db.js';
import { createCredential } from './credential.js';
import { PHOTO_BUCKET } from './photo.js';

const MM = 72 / 25.4;
export const CARD_WIDTH_MM = 85.6;
export const CARD_HEIGHT_MM = 54;
export const CARD_PAGE_SIZE = [CARD_WIDTH_MM * MM, CARD_HEIGHT_MM * MM];

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOGOS = {
  primark: path.join(projectRoot, 'identitycard assets', 'Primark_Logo.png'),
  allportPacd: path.join(projectRoot, 'identitycard assets', 'allport-pacd-logo.png'),
};

const one = (value) => (Array.isArray(value) ? value[0] : value);

function eventDate(startsAt, timezone) {
  if (!startsAt) return 'EVENT DATE TO BE CONFIRMED';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone || 'Asia/Dhaka', day: '2-digit', month: 'long', year: 'numeric',
  }).format(new Date(startsAt)).toUpperCase();
}

export function cardCompany(attendee, organisations = []) {
  if (attendee.from_type === 'other') return attendee.organisation_name || '—';
  const matching = organisations.filter((organisation) => organisation.kind === attendee.from_type);
  const selected = matching.length ? matching : organisations;
  return selected.map((organisation) => organisation.name).filter(Boolean).join(', ') || '—';
}

// All assumptions about the current schema are isolated here. If the final database distributes
// person/registration/organisation fields differently, this adapter is the only mapping to replace.
export function mapCardRows(event, rows) {
  return rows.map((row) => {
    const attendee = one(row.attendees) ?? {};
    const organisations = row.registration_orgs ?? [];
    return {
      registrationId: row.id,
      name: attendee.name || 'Unnamed attendee',
      company: cardCompany(attendee, organisations),
      photoPath: attendee.photo_path ?? null,
      photo: null,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export async function listCardEvents(db) {
  const [events, registrations] = await Promise.all([
    runQuery(db.from('events')
      .select('id, code, name, starts_at, status')
      .order('starts_at', { ascending: true, nullsFirst: false })),
    runQuery(db.from('event_registrations').select('event_id').eq('status', 'confirmed')),
  ]);
  const counts = new Map();
  registrations.forEach(({ event_id: id }) => counts.set(id, (counts.get(id) ?? 0) + 1));
  return events.map((event) => ({ ...event, confirmed_registrations: counts.get(event.id) ?? 0 }));
}

export async function loadCardBatch(db, eventId) {
  const [events, rows] = await Promise.all([
    runQuery(db.from('events')
      .select('id, code, name, subtitle, venue, organiser, timezone, starts_at, status')
      .eq('id', eventId)),
    runQuery(db.from('event_registrations')
      .select('id, attendees(name, from_type, organisation_name, photo_path), registration_orgs(kind, name, code)')
      .eq('event_id', eventId)
      .eq('status', 'confirmed')),
  ]);
  const event = events[0];
  if (!event) return null;
  return { event, cards: mapCardRows(event, rows) };
}

async function loadPhoto(db, card) {
  if (!card.photoPath) return card;
  const { data, error } = await db.storage.from(PHOTO_BUCKET).download(card.photoPath);
  if (error || !data) {
    console.warn(`Card photo unavailable (${card.photoPath}): ${error?.message ?? 'not found'}`);
    return card;
  }
  return { ...card, photo: Buffer.from(await data.arrayBuffer()) };
}

async function loadPhotos(db, cards) {
  const output = [];
  for (let index = 0; index < cards.length; index += 8) {
    output.push(...await Promise.all(cards.slice(index, index + 8).map((card) => loadPhoto(db, card))));
  }
  return output;
}

function fitText(doc, text, maxWidth, preferred, minimum) {
  let size = preferred;
  doc.fontSize(size);
  while (size > minimum && doc.widthOfString(text) > maxWidth) {
    size -= 0.25;
    doc.fontSize(size);
  }
  return size;
}

function drawCoverImage(doc, image, x, y, width, height) {
  doc.save();
  doc.roundedRect(x, y, width, height, 3).clip();
  doc.image(image, x, y, { cover: [width, height], align: 'center', valign: 'center' });
  doc.restore();
  doc.roundedRect(x, y, width, height, 3).lineWidth(0.5).stroke('#0b356c');
}

function drawPhoto(doc, card, x, y, width, height) {
  if (card.photo) {
    try {
      drawCoverImage(doc, card.photo, x, y, width, height);
      return;
    } catch (error) {
      console.warn(`Could not render photo for ${card.name}: ${error.message}`);
    }
  }
  doc.roundedRect(x, y, width, height, 3).fillAndStroke('#eaf2f8', '#0b356c');
  const initials = card.name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  doc.fillColor('#41658f').font('Helvetica-Bold').fontSize(13)
    .text(initials || 'PHOTO', x, y + height / 2 - 7, { width, align: 'center' });
}

function drawLabel(doc, text, x, y) {
  doc.fillColor('#0b356c').font('Helvetica-Bold').fontSize(4.1).text(text, x, y);
}

async function drawCard(doc, event, card, credential) {
  const w = CARD_PAGE_SIZE[0];
  const h = CARD_PAGE_SIZE[1];
  const headerHeight = 20.25 * MM;
  const footerY = 43.45 * MM;

  doc.rect(0, 0, w, h).fill('#ffffff');
  doc.rect(0, 0, w, headerHeight).fill('#169dd2');
  doc.rect(0, footerY, w, h - footerY).fill('#f2f7fa');

  const left = 4.45 * MM;
  const title = String(event.name || 'CARTON NOMINATION PROGRAM').toUpperCase();
  doc.fillColor('#ffffff').font('Helvetica-Bold');
  fitText(doc, title, 68 * MM, 8.2, 6.2);
  doc.text(title, left, 6.6 * MM, { width: 72 * MM, lineBreak: false });

  const date = eventDate(event.starts_at, event.timezone);
  const venue = event.venue || event.subtitle || 'VENUE TO BE CONFIRMED';
  doc.font('Helvetica').fontSize(3.5)
    .text(`${date}   |   ${venue}`, left, 12.1 * MM, { width: 76 * MM, lineBreak: false, ellipsis: true });
  doc.fontSize(3.5)
    .text(`ORGANIZED BY ${(event.organiser || 'PAC-D BANGLADESH').toUpperCase()}`, left, 15.45 * MM, {
      width: 76 * MM, lineBreak: false, ellipsis: true,
    });

  const photoX = 3.85 * MM;
  const photoY = 21.85 * MM;
  const photoW = 17.85 * MM;
  const photoH = 20.05 * MM;
  drawPhoto(doc, card, photoX, photoY, photoW, photoH);

  const textX = 24.55 * MM;
  const textW = 39.2 * MM;
  drawLabel(doc, 'ATTENDEE NAME', textX, 23.45 * MM);
  doc.fillColor('#0b356c').font('Helvetica-Bold');
  fitText(doc, card.name.toUpperCase(), textW, 11.2, 6.5);
  doc.text(card.name.toUpperCase(), textX, 25.75 * MM, { width: textW, lineBreak: false, ellipsis: true });

  drawLabel(doc, 'COMPANY / FACTORY', textX, 31.15 * MM);
  doc.fillColor('#0b356c').font('Helvetica-Bold');
  fitText(doc, card.company.toUpperCase(), textW, 7.8, 5.2);
  doc.text(card.company.toUpperCase(), textX, 33.45 * MM, { width: textW, height: 7.1 * MM, ellipsis: true });

  const qrSize = 12.45 * MM;
  const qrX = 67.05 * MM;
  const qrY = 26.55 * MM;
  const qr = await QRCode.toBuffer(credential.token, {
    type: 'png', width: 300, margin: 1, errorCorrectionLevel: 'H', color: { dark: '#000000', light: '#ffffff' },
  });
  doc.rect(qrX - 0.3 * MM, qrY - 0.3 * MM, qrSize + 0.6 * MM, qrSize + 0.6 * MM)
    .lineWidth(0.35).stroke('#0b356c');
  doc.image(qr, qrX, qrY, { width: qrSize, height: qrSize });
  doc.fillColor('#0b356c').font('Helvetica').fontSize(3.2)
    .text('SCAN TO VERIFY', 65.5 * MM, 39.65 * MM, { width: 15.5 * MM, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(2.9)
    .text(credential.fallback, 65.5 * MM, 41.15 * MM, { width: 15.5 * MM, align: 'center' });

  doc.image(LOGOS.primark, 5.2 * MM, 47.1 * MM, { fit: [17.5 * MM, 3.7 * MM], align: 'left', valign: 'center' });
  doc.image(LOGOS.allportPacd, 58.2 * MM, 46.25 * MM, { fit: [22.2 * MM, 5.2 * MM], align: 'right', valign: 'center' });
}

export async function renderCardsPdf({ event, cards, credentials }) {
  if (!cards.length || cards.length !== credentials.length) throw new Error('Card data and credentials do not match.');
  const doc = new PDFDocument({ autoFirstPage: false, compress: true, info: { Title: `${event.name} identity cards` } });
  const chunks = [];
  const complete = new Promise((resolve, reject) => {
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  for (let index = 0; index < cards.length; index += 1) {
    doc.addPage({ size: CARD_PAGE_SIZE, margin: 0 });
    await drawCard(doc, event, cards[index], credentials[index]);
  }
  doc.end();
  return complete;
}

export async function generateCardBatch(db, eventId) {
  const batch = await loadCardBatch(db, eventId);
  if (!batch) return null;
  if (!batch.cards.length) return { ...batch, empty: true };

  const cards = await loadPhotos(db, batch.cards);
  const credentials = cards.map(() => createCredential());
  const pdf = await renderCardsPdf({ event: batch.event, cards, credentials });
  await callRpc(db, 'issue_event_credentials', {
    p_event_id: eventId,
    p_items: cards.map((card, index) => ({
      registration_id: card.registrationId,
      token_hash: credentials[index].tokenHash,
      fallback_code_hash: credentials[index].fallbackHash,
    })),
  });
  return { ...batch, cards, pdf };
}

export function cardPdfFilename(event) {
  const code = String(event.code || 'event').replace(/[^a-z0-9-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  return `${code || 'event'}-identity-cards.pdf`;
}
