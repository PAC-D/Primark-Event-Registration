import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import JSZip from 'jszip';
import {
  generateQrPdf, generateQrPng, generateQrZip, prepareQrPdfStream,
  qrPdfFilename, qrPngFilename, qrZipFilename,
} from '../../src/services/qr.js';
import { createCredential } from '../../src/services/credential.js';
import { fakeDb } from '../helpers/fake-db.js';

test('QR downloads use safe filenames', () => {
  assert.equal(qrPngFilename({ name: 'Aminul Islam' }), 'aminul-islam-qr.png');
  assert.equal(qrPdfFilename({ code: 'event-2026' }), 'event-2026-qr-codes.pdf');
  assert.equal(qrZipFilename({ code: 'event-2026' }), 'event-2026-qr-codes.zip');
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
      registration_credentials: ({ operation, payload }) => ({
        data: operation === 'insert' ? [payload] : [], error: null,
      }),
    },
  });
  const options = { registrationId, baseUrl: 'https://registration.example.com' };
  const png = await generateQrPng(db, eventId, options);
  assert.deepEqual([...png.png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const pdf = await generateQrPdf(db, eventId, { ...options, registrationIds: [registrationId] });
  assert.equal(pdf.pdf.subarray(0, 5).toString(), '%PDF-');
  const streamed = await prepareQrPdfStream(db, eventId, { ...options, registrationIds: [registrationId] });
  const output = new PassThrough();
  const chunks = [];
  output.on('data', (chunk) => chunks.push(chunk));
  await streamed.streamTo(output);
  assert.equal(Buffer.concat(chunks).subarray(0, 5).toString(), '%PDF-');
  const zipped = await generateQrZip(db, eventId, options);
  const zip = await JSZip.loadAsync(zipped.zip);
  assert.deepEqual(Object.keys(zip.files), ['aminul-islam-example-qr.png']);
});

test('bulk ZIP rendering is bounded to four QR images at a time', async () => {
  const eventId = '11111111-1111-4111-8111-111111111111';
  const registrations = Array.from({ length: 20 }, (_, index) => ({
    id: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`,
    attendees: {
      id: `attendee-${index}`,
      name: `Attendee ${index}`,
      from_type: 'other',
      organisation_name: 'Example',
    },
    registration_orgs: [],
  }));
  const db = fakeDb({
    tables: {
      events: { data: [{ id: eventId, code: 'event-2026', name: 'Event 2026' }], error: null },
      event_registrations: { data: registrations, error: null },
      registration_credentials: ({ operation, payload }) => ({
        data: operation === 'insert' ? [payload] : [], error: null,
      }),
    },
  });
  let active = 0;
  let maximumActive = 0;
  const renderQrCode = async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return Buffer.from('fake png');
  };
  const result = await generateQrZip(db, eventId, {
    baseUrl: 'https://registration.example.com',
    renderQrCode,
  });
  const zip = await JSZip.loadAsync(result.zip);
  assert.equal(Object.keys(zip.files).length, registrations.length);
  assert.equal(maximumActive, 4);
});

test('existing printable credentials render without calling the preparation RPC', async () => {
  const eventId = '11111111-1111-4111-8111-111111111111';
  const registrationId = '22222222-2222-4222-8222-222222222222';
  const credential = createCredential({ tokenBytes: Buffer.alloc(24, 7), fallbackBytes: Buffer.alloc(8, 8) });
  const db = fakeDb({
    tables: {
      events: { data: [{ id: eventId, code: 'event-2026', name: 'Event 2026' }], error: null },
      event_registrations: { data: [{
        id: registrationId,
        attendees: { id: 'attendee-1', name: 'Aminul Islam', from_type: 'other', organisation_name: 'Example' },
        registration_orgs: [],
      }], error: null },
      registration_credentials: { data: [{
        registration_id: registrationId,
        token_hash: credential.tokenHash,
        fallback_code_hash: credential.fallbackHash,
        print_token: credential.token,
        fallback_code: credential.fallback,
        status: 'active',
      }], error: null },
    },
    rpc: {
      prepare_event_credentials: () => { throw new Error('preparation RPC must not run'); },
    },
  });
  const result = await generateQrPng(db, eventId, {
    registrationId,
    baseUrl: 'https://registration.pac-d.com',
  });
  assert.equal(result.png.subarray(1, 4).toString(), 'PNG');
  assert.equal(db.calls.some((call) => call.op === 'insert'), false);
});

test('new registrations receive permanent printable credentials without the preparation RPC', async () => {
  const eventId = '11111111-1111-4111-8111-111111111111';
  const registrationId = '22222222-2222-4222-8222-222222222222';
  const db = fakeDb({
    tables: {
      events: { data: [{ id: eventId, code: 'event-2026', name: 'Event 2026' }], error: null },
      event_registrations: { data: [{
        id: registrationId,
        attendees: { id: 'attendee-1', name: 'Dummy User', from_type: 'other', organisation_name: 'Placeholder' },
        registration_orgs: [],
      }], error: null },
      registration_credentials: ({ operation, payload }) => ({
        data: operation === 'insert' ? [payload] : [], error: null,
      }),
    },
    rpc: {
      prepare_event_credentials: () => { throw new Error('preparation RPC must not run'); },
    },
  });

  const result = await generateQrPng(db, eventId, {
    registrationId,
    baseUrl: 'https://registration.pac-d.com',
  });

  const insertion = db.calls.find((call) => call.op === 'insert');
  assert.equal(result.png.subarray(1, 4).toString(), 'PNG');
  assert.equal(insertion.payload.registration_id, registrationId);
  assert.match(insertion.payload.print_token, /^ER1\.[A-Za-z0-9_-]{32}$/);
  assert.equal(db.calls.some((call) => call.fn === 'prepare_event_credentials'), false);
});

test('legacy active credentials missing printable values are repaired in place', async () => {
  const eventId = '11111111-1111-4111-8111-111111111111';
  const registrationId = '22222222-2222-4222-8222-222222222222';
  const legacy = {
    registration_id: registrationId,
    token_hash: '1'.repeat(64),
    fallback_code_hash: '2'.repeat(64),
    print_token: null,
    fallback_code: null,
    status: 'active',
  };
  const db = fakeDb({
    tables: {
      events: { data: [{ id: eventId, code: 'event-2026', name: 'Event 2026' }], error: null },
      event_registrations: { data: [{
        id: registrationId,
        attendees: { id: 'attendee-1', name: 'Legacy User', from_type: 'other', organisation_name: 'Placeholder' },
        registration_orgs: [],
      }], error: null },
      registration_credentials: ({ operation, payload }) => {
        if (operation !== 'update') return { data: [legacy], error: null };
        return { data: [{ ...legacy, ...payload }], error: null };
      },
    },
  });

  const result = await generateQrPng(db, eventId, {
    registrationId,
    baseUrl: 'https://registration.pac-d.com',
  });

  const repair = db.calls.find((call) => call.op === 'update');
  assert.equal(result.png.subarray(1, 4).toString(), 'PNG');
  assert.match(repair.payload.print_token, /^ER1\.[A-Za-z0-9_-]{32}$/);
  assert.equal(db.calls.some((call) => call.op === 'insert'), false);
});
