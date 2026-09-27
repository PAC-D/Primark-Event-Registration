import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../../src/create-app.js';
import { fakeDb, testConfig } from '../helpers/fake-db.js';

const body = () => ({
  from_type: 'factory',
  name: ' Rahim Uddin ',
  designation: ' Merchandiser ',
  email: 'rahim@example.com',
  phone: '+880 1711-000000',
  website: '',
  orgs: [{ kind: 'factory', org_id: 2 }, { kind: 'supplier', org_id: 1 }],
});

const appWith = (db) => createApp({ db, config: testConfig });
const rpcError = (message, details = null, code = 'P0001') => () => ({ data: null, error: { message, details, hint: null, code } });

test('GET /api/organisations returns the event title and organisations without caching', async () => {
  const organisations = [{ id: 1, kind: 'supplier', name: 'Padma', seats_used: 0 }];
  const db = fakeDb({ tables: { org_status: { data: organisations, error: null } } });
  const res = await request(appWith(db)).get('/api/organisations');
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(res.body, { event_title: 'Test Event', organisations });
});

test('a full organisation lists its seat-holders (name and designation only)', async () => {
  const db = fakeDb({
    tables: {
      org_status: {
        data: [
          { id: 1, kind: 'supplier', name: 'Padma', seats_used: 2 },
          { id: 2, kind: 'factory', name: 'Aspire', seats_used: 0 },
        ],
        error: null,
      },
      attendee_orgs: {
        data: [
          { org_id: 1, attendees: { name: 'Rahim Uddin', designation: 'Merchandiser', from_type: 'supplier' } },
          { org_id: 1, attendees: { name: 'Salma Khatun', designation: 'QA Manager', from_type: 'supplier' } },
          // Linked from the other side: holds no seat at Padma, so must not be listed.
          { org_id: 1, attendees: { name: 'Linked Person', designation: 'Visitor', from_type: 'factory' } },
        ],
        error: null,
      },
    },
  });
  const res = await request(appWith(db)).get('/api/organisations');
  const padma = res.body.organisations.find((o) => o.id === 1);
  assert.deepEqual(padma.registrants, [
    { name: 'Rahim Uddin', designation: 'Merchandiser' },
    { name: 'Salma Khatun', designation: 'QA Manager' },
  ]);
  const aspire = res.body.organisations.find((o) => o.id === 2);
  assert.equal('registrants' in aspire, false, 'an organisation with seats left exposes nothing');
});

test('POST /api/register saves the validated payload and returns 201', async () => {
  const db = fakeDb({ rpc: { register_attendee: () => ({ data: 'new-id', error: null }) } });
  const res = await request(appWith(db)).post('/api/register').send(body());
  assert.equal(res.status, 201);
  assert.deepEqual(res.body, { id: 'new-id' });
  const call = db.calls.find((c) => c.fn === 'register_attendee');
  assert.equal(call.args.p.name, 'Rahim Uddin');
  assert.equal(call.args.p.designation, 'Merchandiser');
  assert.equal('website' in call.args.p, false);
  assert.equal('code' in call.args.p.orgs[0], false);
});

test('a successful registration posts a confirmation to the Power Automate webhook', async (t) => {
  const posted = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    posted.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 202 };
  });
  const db = fakeDb({
    rpc: { register_attendee: () => ({ data: 'new-id', error: null }) },
    tables: { organisations: { data: [{ id: 2, name: 'AB Apparels Ltd' }, { id: 1, name: 'ABA FASHIONS LTD' }], error: null } },
  });
  const config = { ...testConfig, powerAutomateWebhookUrl: 'https://flows.example.com/trigger/abc' };
  const res = await request(createApp({ db, config })).post('/api/register').send(body());
  assert.equal(res.status, 201);
  await new Promise((r) => setTimeout(r, 20)); // fire-and-forget flush
  assert.equal(posted.length, 1);
  assert.equal(posted[0].url, 'https://flows.example.com/trigger/abc');
  assert.equal(posted[0].body.type, 'registration_confirmation');
  assert.equal(posted[0].body.email, 'rahim@example.com');
  assert.equal(posted[0].body.event_name, 'Primark Carton Nomination Program');
  assert.deepEqual(posted[0].body.organisations.sort(), ['AB Apparels Ltd', 'ABA FASHIONS LTD'].sort());
});

test('registration still succeeds when the webhook fails, and the honeypot never emails', async (t) => {
  const posted = [];
  t.mock.method(globalThis, 'fetch', async () => { posted.push(1); throw new Error('flow down'); });
  const db = fakeDb({ rpc: { register_attendee: () => ({ data: 'ok', error: null }) } });
  const config = { ...testConfig, powerAutomateWebhookUrl: 'https://flows.example.com/trigger/abc' };
  const app = createApp({ db, config });

  t.mock.method(console, 'warn', () => {});
  const ok = await request(app).post('/api/register').send(body());
  assert.equal(ok.status, 201);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(posted.length, 1, 'webhook attempted even though it failed');

  const honey = await request(app).post('/api/register').send({ ...body(), website: 'http://spam.example' });
  assert.equal(honey.status, 201);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(posted.length, 1, 'honeypot registration must not trigger the webhook');
});

test('an invalid body returns 400 with field messages and never reaches the database', async () => {
  const db = fakeDb();
  const res = await request(appWith(db)).post('/api/register').send({ ...body(), email: 'nope', orgs: [] });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'VALIDATION');
  assert.ok(res.body.fields.email);
  assert.ok(res.body.fields.factories);
  assert.equal(db.calls.filter((c) => c.fn).length, 0);
});

test('a junk photo_path is rejected before the database is called', async () => {
  const db = fakeDb();
  const res = await request(appWith(db)).post('/api/register').send({ ...body(), photo_path: '../etc/passwd' });
  assert.equal(res.status, 400);
  assert.ok(res.body.fields.photo);
  assert.equal(db.calls.filter((c) => c.fn).length, 0);
});

test('a filled honeypot returns 201 without saving', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const db = fakeDb();
  const res = await request(appWith(db)).post('/api/register').send({ ...body(), website: 'http://spam.example' });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body, { id: null });
  assert.equal(db.calls.length, 0);
});

test('a filled honeypot is logged with the name and email', async (t) => {
  const warned = t.mock.method(console, 'warn', () => {});
  const res = await request(appWith(fakeDb())).post('/api/register')
    .send({ ...body(), email: ' bot@example.com ', website: 'http://spam.example' });
  assert.equal(res.status, 201);
  assert.equal(warned.mock.callCount(), 1);
  const [message, details] = warned.mock.calls[0].arguments;
  assert.equal(message, 'Honeypot hit — registration discarded');
  assert.deepEqual(details, { name: 'Rahim Uddin', email: 'bot@example.com' });
});

test('SEAT_FULL from the database becomes 409 with a friendly message', async () => {
  const db = fakeDb({ rpc: { register_attendee: rpcError('SEAT_FULL', '{"side":"factory","orgs":["Aspire (24040)"]}') } });
  const res = await request(appWith(db)).post('/api/register').send(body());
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, {
    error: 'SEAT_FULL',
    message: 'Already full (factory limit 1): Aspire (24040). Remove them or contact the event team.',
  });
});

test('DUPLICATE_EMAIL becomes 409', async () => {
  const db = fakeDb({ rpc: { register_attendee: rpcError('DUPLICATE_EMAIL') } });
  const res = await request(appWith(db)).post('/api/register').send(body());
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'DUPLICATE_EMAIL');
});

test('a network failure becomes 503', async (t) => {
  t.mock.method(console, 'error', () => {});
  const db = fakeDb({ rpc: { register_attendee: rpcError('TypeError: fetch failed', '', '') } });
  const res = await request(appWith(db)).post('/api/register').send(body());
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'DB_UNAVAILABLE');
});

test('an unexpected database error returns a generic 500 without details', async (t) => {
  t.mock.method(console, 'error', () => {});
  const db = fakeDb({ rpc: { register_attendee: rpcError('relation "attendees" does not exist', null, '42P01') } });
  const res = await request(appWith(db)).post('/api/register').send(body());
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'INTERNAL', message: 'Something went wrong, please try again.' });
});

test('malformed JSON returns 400 VALIDATION', async () => {
  const res = await request(appWith(fakeDb()))
    .post('/api/register')
    .set('Content-Type', 'application/json')
    .send('{"name":');
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'VALIDATION');
});

test('an unknown /api route returns 404 JSON', async () => {
  const res = await request(appWith(fakeDb())).get('/api/nope');
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'NOT_FOUND');
});

test('GET / serves the registration page (Vercel does not map / to public/index.html)', async () => {
  const res = await request(appWith(fakeDb())).get('/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/html/);
  assert.match(res.text, /<title>Primark Carton Nomination Program<\/title>/);
  assert.match(res.text, /src="\/js\/register\.js"/);
});
