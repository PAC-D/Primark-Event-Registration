import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateQrPdf, generateQrPng, qrPdfFilename, qrPngFilename } from '../../src/services/qr.js';
import { fakeDb } from '../helpers/fake-db.js';

test('QR downloads use safe filenames', () => {
  assert.equal(qrPngFilename({ name: 'Aminul Islam' }), 'aminul-islam-qr.png');
  assert.equal(qrPdfFilename({ code: 'event-2026' }), 'event-2026-qr-codes.pdf');
});

test('generates a plain QR PNG and a one-page QR PDF', async () => {
  const eventId = '11111111-1111-4111-8111-111111111111';
  const registrationId = '22222222-2222-4222-8222-222222222222';
  const db = fakeDb({
    tables: {
      events: { data: [{ id: eventId, code: 'event-2026', name: 'Event 2026' }], error: null },
      event_registrations: { data: [{
        id: registrationId,
        attendees: { id: 'attendee-1', name: 'Aminul Islam', from_type: 'other', organisation_name: 'Example' },
        registration_orgs: [],
      }], error: null },
    },
    rpc: {
      prepare_event_credentials: ({ p_items: items }) => ({
        data: items.map((item) => ({ ...item, issued: true })), error: null,
      }),
    },
  });
  const options = { registrationId, secret: 's'.repeat(32), baseUrl: 'https://registration.example.com' };
  const png = await generateQrPng(db, eventId, options);
  assert.deepEqual([...png.png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const pdf = await generateQrPdf(db, eventId, { ...options, registrationIds: [registrationId] });
  assert.equal(pdf.pdf.subarray(0, 5).toString(), '%PDF-');
});
