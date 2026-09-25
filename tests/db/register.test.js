import { describe, test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  anonDb, check, findOrgs, payload, pick, register, seats, seedOrgs, skipReason, testDb, wipe,
} from '../helpers/db.js';

const PHOTO = '123e4567-e89b-42d3-a456-426614174000.jpg';

describe('register_attendee', { skip: skipReason }, () => {
  let db;
  let o;

  before(() => { db = testDb(); });
  beforeEach(async () => {
    await wipe(db);
    o = await seedOrgs(db, {
      padma: { kind: 'supplier', name: 'Padma Textiles Ltd', code: '83760' },
      pearl: { kind: 'supplier', name: 'Pearl Global', code: '83810' },
      aspire: { kind: 'factory', name: 'Aspire Garments (24040)', code: '24040' },
      windy: { kind: 'factory', name: 'Windy Apparels (20096)', code: '20096' },
      nkm: { kind: 'factory', name: 'NKM Fashion (27798)', code: '27798' },
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

  test('the server resolves each organisation code from the list and snapshots it into the link', async () => {
    const id = await check(register(db, payload({ orgs: [pick(o.aspire)] })));
    const links = await check(db.from('attendee_orgs').select('org_id, code').eq('attendee_id', id));
    assert.deepEqual(links, [{ org_id: o.aspire.id, code: '24040' }]);
  });

  test('supplier-side attendees do not use factory seats', async () => {
    await check(register(db, payload({ from: 'supplier', email: 's@example.com', orgs: [pick(o.padma), pick(o.aspire)] })));
    assert.deepEqual(await seats(db, o.aspire.id), { seats_used: 0, linked_count: 1 });
  });

  test('a second factory-side attendee at the same factory is rejected (limit 1)', async () => {
    await check(register(db, payload({ orgs: [pick(o.aspire)] })));
    const { error } = await register(db, payload({ email: 'second@example.com', orgs: [pick(o.aspire)] }));
    assert.equal(error.message, 'SEAT_FULL');
    assert.deepEqual(JSON.parse(error.details), { side: 'factory', orgs: ['Aspire Garments (24040)'] });
    assert.equal((await seats(db, o.aspire.id)).seats_used, 1);
  });

  test('a third supplier-side attendee at the same supplier is rejected (limit 2)', async () => {
    for (const n of [1, 2]) {
      await check(register(db, payload({ from: 'supplier', email: `s${n}@example.com`, orgs: [pick(o.padma)] })));
    }
    const { error } = await register(db, payload({ from: 'supplier', email: 's3@example.com', orgs: [pick(o.padma), pick(o.pearl)] }));
    assert.equal(error.message, 'SEAT_FULL');
    assert.deepEqual(JSON.parse(error.details), { side: 'supplier', orgs: ['Padma Textiles Ltd'] });
    assert.equal((await seats(db, o.pearl.id)).linked_count, 0);
  });

  test('5 parallel registrations for the last supplier seat: exactly one succeeds', async () => {
    await check(register(db, payload({ from: 'supplier', email: 'first@example.com', orgs: [pick(o.padma)] })));
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) =>
      register(db, payload({ from: 'supplier', email: `race${n}@example.com`, orgs: [pick(o.padma)] }))));
    assert.equal(results.filter((r) => !r.error).length, 1);
    assert.ok(results.filter((r) => r.error).every((r) => r.error.message === 'SEAT_FULL'));
    assert.equal((await seats(db, o.padma.id)).seats_used, 2);
  });

  test('the same email in different case is rejected with DUPLICATE_EMAIL', async () => {
    await check(register(db, payload({ email: 'Rahim@Example.com', orgs: [pick(o.aspire)] })));
    const { error } = await register(db, payload({ email: 'rahim@example.com', orgs: [pick(o.windy)] }));
    assert.equal(error.message, 'DUPLICATE_EMAIL');
  });

  test('designation is required', async () => {
    const { error } = await register(db, payload({ designation: '', orgs: [pick(o.aspire)] }));
    assert.equal(error.message, 'VALIDATION');
    assert.equal(error.details, 'contact');
    assert.equal((await check(db.from('attendees').select('id'))).length, 0);
  });

  test('an "other" attendee stores designation and organisation name, links nothing, uses no seats', async () => {
    const id = await check(register(db, payload({
      from: 'other', email: 'other@example.com', orgs: [], organisation_name: 'WAC - Bangladesh', designation: 'Sourcing Lead',
    })));
    const [row] = await check(db.from('attendees')
      .select('from_type, organisation_name, designation, photo_path').eq('id', id));
    assert.deepEqual(row, { from_type: 'other', organisation_name: 'WAC - Bangladesh', designation: 'Sourcing Lead', photo_path: null });
    const links = await check(db.from('attendee_orgs').select('org_id').eq('attendee_id', id));
    assert.equal(links.length, 0);
  });

  test('an "other" attendee without an organisation name is rejected', async () => {
    const { error } = await register(db, payload({ from: 'other', orgs: [] }));
    assert.equal(error.message, 'VALIDATION');
    assert.equal(error.details, 'organisation_name');
  });

  test('a photo_path is stored as given when it matches the upload shape', async () => {
    const id = await check(register(db, payload({ orgs: [pick(o.aspire)], photo_path: PHOTO })));
    const [row] = await check(db.from('attendees').select('photo_path').eq('id', id));
    assert.equal(row.photo_path, PHOTO);
  });

  test('a junk photo_path is rejected with VALIDATION', async () => {
    const { error } = await register(db, payload({ orgs: [pick(o.aspire)], photo_path: '../etc/passwd' }));
    assert.equal(error.message, 'VALIDATION');
    assert.equal(error.details, 'photo');
  });

  test('a payload without the from-kind organisation is rejected', async () => {
    const { error } = await register(db, payload({ orgs: [pick(o.padma)] }));
    assert.equal(error.message, 'VALIDATION');
    assert.equal(error.details, 'orgs');
  });

  test('a pending organisation cannot be picked by id from the public form', async () => {
    const { error } = await register(db, payload({ orgs: [pick(o.hidden)] }));
    assert.equal(error.message, 'ORG_NOT_FOUND');
  });

  test('the publishable (anon) key cannot call register_attendee', async () => {
    const { error } = await anonDb().rpc('register_attendee', { p: payload({ orgs: [pick(o.aspire)] }) });
    assert.ok(error);
    assert.equal((await check(db.from('attendees').select('id'))).length, 0);
  });

  test('supplier-side and factory-side registrations over the same pairs run concurrently without deadlock', async () => {
    const spec = {};
    for (let i = 1; i <= 5; i += 1) {
      spec[`sup${i}`] = { kind: 'supplier', name: `Concurrent Supplier ${i}`, code: `90${i}` };
      spec[`fac${i}`] = { kind: 'factory', name: `Concurrent Factory ${i}`, code: `80${i}` };
    }
    const pairs = await seedOrgs(db, spec);

    const jobs = [];
    for (let i = 1; i <= 5; i += 1) {
      const supplier = pairs[`sup${i}`];
      const factory = pairs[`fac${i}`];
      jobs.push(register(db, payload({
        from: 'supplier', email: `cs${i}@example.com`, orgs: [pick(supplier), pick(factory)],
      })));
      jobs.push(register(db, payload({
        from: 'factory', email: `cf${i}@example.com`, orgs: [pick(supplier), pick(factory)],
      })));
    }
    const results = await Promise.all(jobs);

    results.forEach((r, idx) => {
      assert.equal(r.error, null, `job ${idx} failed: ${r.error?.code ?? ''} ${r.error?.message ?? ''}`.trim());
    });
    for (let i = 1; i <= 5; i += 1) {
      assert.equal((await seats(db, pairs[`sup${i}`].id)).seats_used, 1);
      assert.equal((await seats(db, pairs[`fac${i}`].id)).seats_used, 1);
    }
  });
});
