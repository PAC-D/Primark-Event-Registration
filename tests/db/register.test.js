import { describe, test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  anonDb, check, findOrgs, other, payload, pick, register, seats, seedOrgs, skipReason, testDb, wipe,
} from '../helpers/db.js';

describe('register_attendee', { skip: skipReason }, () => {
  let db;
  let o;

  before(() => { db = testDb(); });
  beforeEach(async () => {
    await wipe(db);
    o = await seedOrgs(db, {
      padma: { kind: 'supplier', name: 'Padma Textiles Ltd' },
      pearl: { kind: 'supplier', name: 'Pearl Global' },
      aspire: { kind: 'factory', name: 'Aspire Garments (24040)' },
      windy: { kind: 'factory', name: 'Windy Apparels (20096)' },
      nkm: { kind: 'factory', name: 'NKM Fashion (27798)' },
      hidden: { kind: 'factory', name: 'Hidden Pending Factory', status: 'pending', source: 'attendee' },
    });
  });

  test('a factory attendee with 3 factories uses a seat at each and counts as one participant', async () => {
    const id = await check(register(db, payload({
      from: 'factory',
      orgs: [pick(o.padma), pick(o.aspire), pick(o.windy), pick(o.nkm)],
    })));
    assert.match(id, /^[0-9a-f-]{36}$/);
    for (const factory of [o.aspire, o.windy, o.nkm]) {
      assert.equal((await seats(db, factory.id)).seats_used, 1);
    }
    assert.deepEqual(await seats(db, o.padma.id), { seats_used: 0, linked_count: 1 });
    assert.equal((await check(db.from('attendees').select('id'))).length, 1);
  });

  test('supplier-side attendees do not use factory seats', async () => {
    for (const n of [1, 2]) {
      await check(register(db, payload({ from: 'supplier', email: `s${n}@example.com`, orgs: [pick(o.padma), pick(o.aspire)] })));
    }
    for (const n of [1, 2]) {
      await check(register(db, payload({ from: 'factory', email: `f${n}@example.com`, orgs: [pick(o.pearl), pick(o.aspire)] })));
    }
    assert.deepEqual(await seats(db, o.aspire.id), { seats_used: 2, linked_count: 4 });
  });

  test('a third attendee from the same side is rejected with SEAT_FULL and nothing is saved', async () => {
    for (const n of [1, 2]) {
      await check(register(db, payload({ email: `p${n}@example.com`, orgs: [pick(o.padma), pick(o.aspire)] })));
    }
    const { error } = await register(db, payload({
      email: 'p3@example.com',
      orgs: [pick(o.padma), pick(o.aspire), pick(o.windy)],
    }));
    assert.equal(error.message, 'SEAT_FULL');
    assert.deepEqual(JSON.parse(error.details), { side: 'factory', orgs: ['Aspire Garments (24040)'] });
    assert.equal((await seats(db, o.windy.id)).linked_count, 0);
  });

  test('5 parallel registrations for the last seat: exactly one succeeds', async () => {
    await check(register(db, payload({ email: 'first@example.com', orgs: [pick(o.padma), pick(o.aspire)] })));
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) =>
      register(db, payload({ email: `race${n}@example.com`, orgs: [pick(o.padma), pick(o.aspire)] }))));
    assert.equal(results.filter((r) => !r.error).length, 1);
    assert.ok(results.filter((r) => r.error).every((r) => r.error.message === 'SEAT_FULL'));
    assert.equal((await seats(db, o.aspire.id)).seats_used, 2);
  });

  test('the same email in different case is rejected with DUPLICATE_EMAIL', async () => {
    await check(register(db, payload({ email: 'Rahim@Example.com', orgs: [pick(o.padma), pick(o.aspire)] })));
    const { error } = await register(db, payload({ email: 'rahim@example.com', orgs: [pick(o.pearl), pick(o.windy)] }));
    assert.equal(error.message, 'DUPLICATE_EMAIL');
  });

  test('a typed name matching an approved organisation links to it and creates nothing', async () => {
    const id = await check(register(db, payload({
      orgs: [other('supplier', 'PADMA TEXTILES LIMITED'), pick(o.aspire)],
    })));
    const links = await check(db.from('attendee_orgs').select('org_id').eq('attendee_id', id));
    assert.deepEqual(links.map((l) => l.org_id).sort((a, b) => a - b), [o.padma.id, o.aspire.id].sort((a, b) => a - b));
    assert.equal((await findOrgs(db, { status: 'pending' })).length, 1); // only the seeded hidden one
  });

  test('typed names matching a pending organisation reuse it, and its seat limit applies', async () => {
    await check(register(db, payload({ email: 'r1@example.com', orgs: [pick(o.padma), other('factory', 'Rainbow Knit Ltd')] })));
    await check(register(db, payload({ email: 'r2@example.com', orgs: [pick(o.padma), other('factory', 'rainbow knit limited')] })));
    const { error } = await register(db, payload({ email: 'r3@example.com', orgs: [pick(o.padma), other('factory', 'Rainbow-Knit')] }));
    assert.equal(error.message, 'SEAT_FULL');
    const rainbow = await findOrgs(db, { match_key: 'rainbow knit' });
    assert.equal(rainbow.length, 1);
    assert.equal(rainbow[0].status, 'pending');
    assert.equal(rainbow[0].source, 'attendee');
    assert.equal(rainbow[0].name, 'Rainbow Knit Ltd');
  });

  test('a failed registration leaves no new pending organisation behind', async () => {
    for (const n of [1, 2]) {
      await check(register(db, payload({ email: `p${n}@example.com`, orgs: [pick(o.padma), pick(o.aspire)] })));
    }
    const { error } = await register(db, payload({
      email: 'p3@example.com',
      orgs: [pick(o.padma), other('factory', 'Brand New Factory'), pick(o.aspire)],
    }));
    assert.equal(error.message, 'SEAT_FULL');
    assert.equal((await findOrgs(db, { match_key: 'brand new factory' })).length, 0);
  });

  test('picking the same organisation twice creates one link and keeps the first code', async () => {
    const id = await check(register(db, payload({
      orgs: [pick(o.padma, 'FIRST'), other('supplier', 'Padma Textiles', 'SECOND'), pick(o.aspire)],
    })));
    const links = await check(db.from('attendee_orgs').select('org_id, code').eq('attendee_id', id).eq('org_id', o.padma.id));
    assert.deepEqual(links, [{ org_id: o.padma.id, code: 'FIRST' }]);
  });

  test('a pending organisation cannot be picked by id from the public form', async () => {
    const { error } = await register(db, payload({ orgs: [pick(o.padma), pick(o.hidden)] }));
    assert.equal(error.message, 'ORG_NOT_FOUND');
  });

  test('a payload without a factory is rejected with VALIDATION', async () => {
    const { error } = await register(db, payload({ orgs: [pick(o.padma)] }));
    assert.equal(error.message, 'VALIDATION');
  });

  test('the publishable (anon) key cannot call register_attendee', async () => {
    const { error } = await anonDb().rpc('register_attendee', { p: payload({ orgs: [pick(o.padma), pick(o.aspire)] }) });
    assert.ok(error);
    assert.equal((await check(db.from('attendees').select('id'))).length, 0);
  });
});
