import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notifyRegistration, registrationConfirmation } from '../../src/services/notify.js';

const details = {
  type: 'registration_confirmation',
  name: 'Rahim Uddin',
  email: 'rahim@example.com',
  phone: '+8801711000000',
  designation: 'Merchandiser',
  from_type: 'factory',
  organisation_name: null,
  organisations: ['AB Apparels Ltd'],
  event_name: 'Primark Carton Nomination Program',
  event_subtitle: 'Bangladesh Origin',
  event_date: 'Nov 04, 2026',
  event_time: '9:00 AM – 3:30 PM (GMT+6)',
};

const configWith = { powerAutomateWebhookUrl: 'https://flows.example.com/trigger/abc123' };

test('no webhook configured: sends nothing, never throws', async () => {
  let calls = 0;
  const restore = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; return { ok: true, status: 200 }; };
  try {
    await notifyRegistration({ powerAutomateWebhookUrl: '' }, details);
  } finally {
    globalThis.fetch = restore;
  }
  assert.equal(calls, 0);
});

test('posts the registration JSON to the webhook', async () => {
  let seen = null;
  const restore = globalThis.fetch;
  globalThis.fetch = async (url, init) => { seen = { url, init }; return { ok: true, status: 200 }; };
  try {
    await notifyRegistration(configWith, details);
  } finally {
    globalThis.fetch = restore;
  }
  assert.equal(seen.url, configWith.powerAutomateWebhookUrl);
  assert.equal(seen.init.method, 'POST');
  assert.match(seen.init.headers['Content-Type'], /application\/json/);
  assert.deepEqual(JSON.parse(seen.init.body), details);
});

test('a webhook failure logs a warning but never throws', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const restore = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('connection refused'); };
  try {
    await notifyRegistration(configWith, details);
  } finally {
    globalThis.fetch = restore;
  }
  assert.equal(warn.mock.callCount(), 1);
});

test('a non-2xx webhook response logs a warning but never throws', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const restore = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 502 });
  try {
    await notifyRegistration(configWith, details);
  } finally {
    globalThis.fetch = restore;
  }
  assert.equal(warn.mock.callCount(), 1);
});

test('registrationConfirmation maps the payload to the flow shape and trims nulls for non-other attendees', () => {
  const body = registrationConfirmation({
    eventTitle: 'Bangladesh Origin',
    payload: { name: 'Rahim', email: 'r@x.com', phone: '1', designation: 'M', from_type: 'factory', organisation_name: null },
    orgNames: ['AB Apparels Ltd'],
  });
  assert.equal(body.type, 'registration_confirmation');
  assert.equal(body.event_name, 'Primark Carton Nomination Program');
  assert.equal(body.event_subtitle, 'Bangladesh Origin');
  assert.equal(body.organisation_name, null);
  assert.deepEqual(body.organisations, ['AB Apparels Ltd']);
});
