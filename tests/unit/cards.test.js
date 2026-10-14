import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CARD_HEIGHT_MM, CARD_PAGE_SIZE, CARD_WIDTH_MM, cardCompany, mapCardRows, renderCardsPdf,
} from '../../src/services/cards.js';
import { createCredential } from '../../src/services/credential.js';

test('card page is exactly 8.56 cm by 5.4 cm', () => {
  assert.equal(CARD_WIDTH_MM, 85.6);
  assert.equal(CARD_HEIGHT_MM, 54);
  assert.ok(Math.abs(CARD_PAGE_SIZE[0] - 242.645669) < 0.0001);
  assert.ok(Math.abs(CARD_PAGE_SIZE[1] - 153.070866) < 0.0001);
});

test('company display follows attendee type and supports final-schema adapter mapping', () => {
  const organisations = [
    { kind: 'supplier', name: 'Supplier One' },
    { kind: 'factory', name: 'Factory One' },
  ];
  assert.equal(cardCompany({ from_type: 'factory' }, organisations), 'Factory One');
  assert.equal(cardCompany({ from_type: 'supplier' }, organisations), 'Supplier One');
  assert.equal(cardCompany({ from_type: 'other', organisation_name: 'Primark' }, []), 'Primark');

  const [card] = mapCardRows({}, [{
    id: 'registration-1',
    attendees: { name: 'Rahim Uddin', from_type: 'factory', photo_path: 'photo.jpg' },
    registration_orgs: organisations,
  }]);
  assert.deepEqual(card, {
    registrationId: 'registration-1', name: 'Rahim Uddin', company: 'Factory One', photoPath: 'photo.jpg', photo: null,
  });
});

test('renders a PDF card with the supplied logos and QR credential', async () => {
  const pdf = await renderCardsPdf({
    event: {
      name: 'Carton Nomination Program', starts_at: '2026-11-04T09:00:00+06:00', timezone: 'Asia/Dhaka',
      venue: 'Crowne Plaza Dhaka Airport by IHG', organiser: 'PAC-D Bangladesh',
    },
    cards: [{ registrationId: 'r1', name: 'Your Name Here', company: 'Your Company Name', photo: null }],
    credentials: [createCredential({ tokenBytes: Buffer.alloc(24, 1), fallbackBytes: Buffer.alloc(8, 2) })],
  });
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 10_000);
});
