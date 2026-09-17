import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../../src/create-app.js';
import { fakeDb, testConfig } from '../helpers/fake-db.js';

const body = () => ({
  from_type: 'factory',
  name: ' Rahim Uddin ',
  email: 'rahim@example.com',
  phone: '+880 1711-000000',
  website: '',
  orgs: [{ kind: 'supplier', org_id: 1, code: 'S1' }, { kind: 'factory', org_id: 2, code: 'F1' }],
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

test('POST /api/register saves the validated payload and returns 201', async () => {
  const db = fakeDb({ rpc: { register_attendee: () => ({ data: 'new-id', error: null }) } });
  const res = await request(appWith(db)).post('/api/register').send(body());
  assert.equal(res.status, 201);
  assert.deepEqual(res.body, { id: 'new-id' });
  assert.equal(db.calls.length, 1);
  assert.equal(db.calls[0].fn, 'register_attendee');
  assert.equal(db.calls[0].args.p.name, 'Rahim Uddin');
  assert.equal('website' in db.calls[0].args.p, false);
});

test('an invalid body returns 400 with field messages and never reaches the database', async () => {
  const db = fakeDb();
  const res = await request(appWith(db)).post('/api/register').send({ ...body(), email: 'nope', orgs: [] });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'VALIDATION');
  assert.ok(res.body.fields.email);
  assert.ok(res.body.fields.suppliers);
  assert.equal(db.calls.length, 0);
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
    message: 'Already full (2 factory attendees): Aspire (24040). Remove them or contact the event team.',
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
  assert.match(res.text, /<title>Primark Event Registration<\/title>/);
  assert.match(res.text, /src="\/js\/register\.js"/);
});
