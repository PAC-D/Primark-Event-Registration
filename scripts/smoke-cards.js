import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';

const base = process.env.APP_URL || 'http://localhost:3000';
const db = createDb(loadConfig());
const login = await fetch(`${base}/api/admin/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: process.env.ADMIN_PASSWORD }),
});
assert.equal(login.status, 200);
const cookie = login.headers.get('set-cookie')?.split(';')[0];
const headers = { Cookie: cookie };

const eventsResponse = await fetch(`${base}/api/admin/card-events`, { headers });
const { events } = await eventsResponse.json();
const event = events.find((item) => item.confirmed_registrations > 1);
assert.ok(event, 'No event with confirmed registrations found.');

const choicesResponse = await fetch(`${base}/api/admin/events/${event.id}/card-registrations`, { headers });
assert.equal(choicesResponse.status, 200);
const { registrations } = await choicesResponse.json();
const selected = registrations[0];
assert.ok(selected);

async function activeCredentials() {
  const { data, error } = await db.from('registration_credentials')
    .select('id, registration_id, token_hash')
    .eq('status', 'active')
    .in('registration_id', registrations.map((item) => item.id));
  if (error) throw error;
  return new Map(data.map((item) => [item.registration_id, item]));
}

async function printSelected() {
  const response = await fetch(`${base}/api/admin/events/${event.id}/cards.pdf`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/pdf' },
    body: JSON.stringify({ registration_ids: [selected.id] }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /application\/pdf/);
  assert.ok((await response.arrayBuffer()).byteLength > 10_000);
  return response;
}

const before = await activeCredentials();
const first = await printSelected();
const afterFirst = await activeCredentials();
const second = await printSelected();
const afterSecond = await activeCredentials();

assert.equal(second.headers.get('x-card-credentials-issued'), '0');
assert.equal(second.headers.get('x-card-credentials-reused'), '1');
assert.equal(afterFirst.get(selected.id).id, afterSecond.get(selected.id).id);
assert.equal(afterFirst.get(selected.id).token_hash, afterSecond.get(selected.id).token_hash);
for (const registration of registrations.slice(1)) {
  assert.equal(before.get(registration.id)?.id, afterSecond.get(registration.id)?.id, `Unselected card changed: ${registration.name}`);
}

console.log(`Permanent QR smoke test passed: ${selected.name}; first issued ${first.headers.get('x-card-credentials-issued')}, second reused 1; ${registrations.length - 1} unselected cards unchanged.`);
