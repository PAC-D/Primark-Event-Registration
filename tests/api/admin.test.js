import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../../src/create-app.js';
import { COOKIE_NAME, SESSION_SECONDS, signSession } from '../../src/auth.js';
import { fakeDb, testConfig } from '../helpers/fake-db.js';
import { fixtureAttendees, fixtureOrgs } from '../helpers/dashboard-fixture.js';

const PERSON_ID = '3f0c1d2e-4b5a-4c6d-8e7f-0123456789ab';
const validCookie = () => `${COOKIE_NAME}=${signSession(testConfig.sessionSecret)}`;
const appWith = (db) => createApp({ db, config: testConfig, loginDelayMs: 0 });
const body = () => ({
  from_type: 'supplier', name: 'Rahim Uddin', email: 'rahim@example.com', phone: '+8801711000000',
  orgs: [{ kind: 'supplier', org_id: 1, code: 'S1' }, { kind: 'factory', org_id: 2, code: 'F1' }],
});
const rpcError = (message, details = null) => () => ({ data: null, error: { message, details, hint: null, code: 'P0001' } });

const protectedRoutes = [
  ['get', '/api/admin/data'],
  ['put', `/api/admin/participants/${PERSON_ID}`],
  ['delete', `/api/admin/participants/${PERSON_ID}`],
  ['post', '/api/admin/organisations/1/approve'],
  ['post', '/api/admin/organisations/1/merge'],
];

test('protected admin routes return 401 without a valid cookie and never touch the database', async () => {
  const db = fakeDb();
  const app = appWith(db);
  const expired = `${COOKIE_NAME}=${signSession(testConfig.sessionSecret, Math.floor(Date.now() / 1000) - SESSION_SECONDS - 1)}`;
  const forged = `${COOKIE_NAME}=${signSession('x'.repeat(32))}`;
  for (const [method, path] of protectedRoutes) {
    for (const cookie of [null, expired, forged]) {
      const req = request(app)[method](path);
      if (cookie) req.set('Cookie', cookie);
      const res = await req;
      assert.equal(res.status, 401, `${method} ${path} with ${cookie ? 'bad cookie' : 'no cookie'}`);
      assert.deepEqual(res.body, { error: 'UNAUTHORISED', message: 'Please log in again.' });
    }
  }
  assert.equal(db.calls.length, 0);
});

test('login with the wrong password returns 401 and sets no cookie', async () => {
  const res = await request(appWith(fakeDb())).post('/api/admin/login').send({ password: 'wrong' });
  assert.equal(res.status, 401);
  assert.equal(res.body.message, 'Wrong password.');
  assert.equal(res.headers['set-cookie'], undefined);
});

test('login with the right password sets a strict, http-only session cookie that unlocks /data', async () => {
  const db = fakeDb({
    tables: { org_status: { data: fixtureOrgs, error: null }, attendees: { data: fixtureAttendees, error: null } },
  });
  const agent = request.agent(appWith(db));
  const login = await agent.post('/api/admin/login').send({ password: testConfig.adminPassword });
  assert.equal(login.status, 200);
  const cookie = login.headers['set-cookie'][0];
  assert.match(cookie, /^admin_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Max-Age=43200/);

  const data = await agent.get('/api/admin/data');
  assert.equal(data.status, 200);
  assert.equal(data.headers['cache-control'], 'no-store');
  assert.equal(data.body.summary.participants.total, 3);
});

test('logout clears the cookie even without a session', async () => {
  const res = await request(appWith(fakeDb())).post('/api/admin/logout');
  assert.equal(res.status, 200);
  assert.match(res.headers['set-cookie'][0], /^admin_session=;/);
});

test('PUT /participants/:id validates the body and calls update_attendee', async () => {
  const db = fakeDb();
  const app = appWith(db);
  const bad = await request(app).put(`/api/admin/participants/${PERSON_ID}`).set('Cookie', validCookie()).send({ ...body(), phone: 'x' });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.fields.phone);
  assert.equal(db.calls.length, 0);

  const ok = await request(app).put(`/api/admin/participants/${PERSON_ID}`).set('Cookie', validCookie()).send(body());
  assert.equal(ok.status, 200);
  assert.equal(db.calls[0].fn, 'update_attendee');
  assert.equal(db.calls[0].args.p_id, PERSON_ID);
  assert.equal(db.calls[0].args.p.email, 'rahim@example.com');
});

test('a malformed participant id returns 404 without calling the database', async () => {
  const db = fakeDb();
  const res = await request(appWith(db)).delete('/api/admin/participants/not-a-uuid').set('Cookie', validCookie());
  assert.equal(res.status, 404);
  assert.equal(db.calls.length, 0);
});

test('DELETE /participants/:id calls delete_attendee and maps NOT_FOUND to 404', async () => {
  const db = fakeDb({ rpc: { delete_attendee: rpcError('NOT_FOUND') } });
  const res = await request(appWith(db)).delete(`/api/admin/participants/${PERSON_ID}`).set('Cookie', validCookie());
  assert.equal(res.status, 404);
  assert.deepEqual(db.calls[0], { fn: 'delete_attendee', args: { p_id: PERSON_ID } });
});

test('POST /organisations/:id/approve calls approve_org with a numeric id', async () => {
  const db = fakeDb();
  const res = await request(appWith(db)).post('/api/admin/organisations/42/approve').set('Cookie', validCookie());
  assert.equal(res.status, 200);
  assert.deepEqual(db.calls[0], { fn: 'approve_org', args: { p_id: 42 } });
});

test('POST /organisations/:id/merge passes allow_over_limit and maps MERGE_OVER_LIMIT to 409', async () => {
  let allow = false;
  const db = fakeDb({
    rpc: {
      merge_org: (args) => {
        allow = args.p_allow_over_limit;
        return allow
          ? { data: 3, error: null }
          : rpcError('MERGE_OVER_LIMIT', '{"target":"Aspire (24040)","side":"factory","count":3}')();
      },
    },
  });
  const app = appWith(db);

  const refused = await request(app).post('/api/admin/organisations/7/merge').set('Cookie', validCookie()).send({ target_id: 3 });
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body, {
    error: 'MERGE_OVER_LIMIT', message: 'Aspire (24040) would have 3 factory attendees (limit 2). Merge anyway?', count: 3,
  });

  const merged = await request(app).post('/api/admin/organisations/7/merge').set('Cookie', validCookie()).send({ target_id: 3, allow_over_limit: true });
  assert.equal(merged.status, 200);
  assert.deepEqual(merged.body, { ok: true, seats_used: 3 });
  assert.deepEqual(db.calls.at(-1).args, { p_source: 7, p_target: 3, p_allow_over_limit: true });
});

test('merge without a valid target_id returns 400', async () => {
  const db = fakeDb();
  const res = await request(appWith(db)).post('/api/admin/organisations/7/merge').set('Cookie', validCookie()).send({});
  assert.equal(res.status, 400);
  assert.ok(res.body.fields.target_id);
  assert.equal(db.calls.length, 0);
});
