import { describe, test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../../src/create-app.js';
import { testConfig } from '../helpers/fake-db.js';
import { check, findOrgs, other, pick, seedOrgs, skipReason, testDb, wipe } from '../helpers/db.js';

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
      padma: { kind: 'supplier', name: 'Padma Textiles Ltd' },
      aspire: { kind: 'factory', name: 'Aspire Garments (24040)' },
    });
  });

  const person = (email, orgs) => ({ from_type: 'factory', name: 'Rahim Uddin', email, phone: '+8801711000000', orgs });
  const orgNames = async () => (await request(app).get('/api/organisations')).body.organisations.map((x) => x.name);

  test('registers through the API and reports seats used', async () => {
    await request(app).post('/api/register').send(person('a@example.com', [pick(o.padma), pick(o.aspire)])).expect(201);
    const res = await request(app).get('/api/organisations').expect(200);
    assert.equal(res.body.organisations.find((x) => x.id === o.aspire.id).seats_used, 1);
  });

  test('a full organisation returns 409 SEAT_FULL', async () => {
    for (const email of ['a@example.com', 'b@example.com']) {
      await request(app).post('/api/register').send(person(email, [pick(o.padma), pick(o.aspire)])).expect(201);
    }
    const res = await request(app).post('/api/register').send(person('c@example.com', [pick(o.padma), pick(o.aspire)]));
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'SEAT_FULL');
  });

  test('pending organisations are hidden until approved', async () => {
    await request(app).post('/api/register')
      .send(person('a@example.com', [pick(o.padma), other('factory', 'Rainbow Knit Ltd')]))
      .expect(201);
    assert.equal((await orgNames()).includes('Rainbow Knit Ltd'), false);
    const [rainbow] = await findOrgs(db, { match_key: 'rainbow knit' });
    await check(db.rpc('approve_org', { p_id: rainbow.id }));
    assert.equal((await orgNames()).includes('Rainbow Knit Ltd'), true);
  });
});
