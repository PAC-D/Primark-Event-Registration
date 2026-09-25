import { describe, test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../../src/create-app.js';
import { testConfig } from '../helpers/fake-db.js';
import { check, findOrgs, pick, seedOrgs, skipReason, testDb, wipe } from '../helpers/db.js';

describe('public API against the test database', { skip: skipReason }, () => {
  let db;
  let app;
  let o;

  before(() => {
    db = testDb();
    app = createApp({ db, config: testConfig });
  });
  beforeEach(async () => {
    await wipe(db);
    o = await seedOrgs(db, {
      padma: { kind: 'supplier', name: 'Padma Textiles Ltd', code: '83760' },
      aspire: { kind: 'factory', name: 'Aspire Garments (24040)', code: '24040' },
    });
  });

  const person = (email, orgs) => ({
    from_type: 'factory', name: 'Rahim Uddin', designation: 'Merchandiser', email,
    phone: '+8801711000000', orgs,
  });
  const orgList = async () => (await request(app).get('/api/organisations')).body.organisations;

  test('registers through the API and reports seats used', async () => {
    await request(app).post('/api/register').send(person('a@example.com', [pick(o.padma), pick(o.aspire)])).expect(201);
    const res = await request(app).get('/api/organisations').expect(200);
    assert.equal(res.body.organisations.find((x) => x.id === o.aspire.id).seats_used, 1);
  });

  test('/api/organisations never exposes organisation codes', async () => {
    const orgs = await orgList();
    assert.ok(orgs.every((x) => !('code' in x)));
  });

  test('a full factory (limit 1) returns 409 SEAT_FULL for the second attendee', async () => {
    await request(app).post('/api/register').send(person('a@example.com', [pick(o.aspire)])).expect(201);
    const res = await request(app).post('/api/register').send(person('b@example.com', [pick(o.aspire)]));
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'SEAT_FULL');
    assert.equal(res.body.message, 'Already full (factory limit 1): Aspire Garments (24040). Remove them or contact the event team.');
  });

  test('an "other" registration passes the API validation and is stored', async () => {
    const res = await request(app).post('/api/register').send({
      from_type: 'other', name: 'Nadia Islam', designation: 'Sourcing Lead',
      email: 'n@example.com', phone: '+8801711000000', organisation_name: 'Maersk Bangladesh', orgs: [],
    });
    assert.equal(res.status, 201);
    const [row] = await check(db.from('attendees').select('from_type, organisation_name').eq('email', 'n@example.com'));
    assert.deepEqual(row, { from_type: 'other', organisation_name: 'Maersk Bangladesh' });
  });

  test('pending organisations are hidden until approved', async () => {
    const pending = (await seedOrgs(db, {
      rainbow: { kind: 'factory', name: 'Rainbow Knit Ltd', status: 'pending', source: 'attendee' },
    })).rainbow;
    assert.equal((await orgList()).some((x) => x.id === pending.id), false);
    await check(db.rpc('approve_org', { p_id: pending.id }));
    assert.equal((await orgList()).some((x) => x.id === pending.id), true);
  });
});
