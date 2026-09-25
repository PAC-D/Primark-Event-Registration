import { describe, test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  anonDb, check, findOrgs, payload, pick, register, seats, seedOrgs, skipReason, testDb, wipe,
} from '../helpers/db.js';

const MISSING_UUID = '00000000-0000-4000-8000-000000000000';
const PHOTO_A = '123e4567-e89b-42d3-a456-426614174000.jpg';
const PHOTO_B = '123e4567-e89b-42d3-a456-426614174001.png';

describe('admin database functions', { skip: skipReason }, () => {
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
    });
  });

  const reg = (fields) => check(register(db, payload(fields)));
  const pendingOrg = async (matchKey) => (await findOrgs(db, { match_key: matchKey }))[0];

  describe('update_attendee', () => {
    test('does not count the person\'s own seats', async () => {
      const p1 = await reg({ from: 'supplier', email: 'p1@example.com', orgs: [pick(o.padma)] });
      await reg({ from: 'supplier', email: 'p2@example.com', orgs: [pick(o.padma)] });
      await check(db.rpc('update_attendee', {
        p_id: p1,
        p: payload({ from: 'supplier', name: 'Renamed', email: 'p1@example.com', orgs: [pick(o.padma)] }),
      }));
      const [row] = await check(db.from('attendees').select('name').eq('id', p1));
      assert.equal(row.name, 'Renamed');
      assert.equal((await seats(db, o.padma.id)).seats_used, 2);
    });

    test('switching from_type re-checks seats on the other side (per-kind limits)', async () => {
      const f = await reg({ email: 'f@example.com', orgs: [pick(o.windy)] });
      const { error } = await db.rpc('update_attendee', {
        p_id: f,
        p: payload({ from: 'supplier', email: 'f@example.com', orgs: [pick(o.windy)] }),
      });
      assert.equal(error.message, 'VALIDATION'); // no supplier selected
      const { error: seatError } = await db.rpc('update_attendee', {
        p_id: f,
        p: payload({ from: 'supplier', email: 'f@example.com', orgs: [pick(o.padma), pick(o.windy)] }),
      });
      assert.equal(seatError, null, 'a supplier-side person may cross-link a factory');
      assert.deepEqual(await seats(db, o.windy.id), { seats_used: 0, linked_count: 1 });
    });

    test('rejects another person\'s email with DUPLICATE_EMAIL', async () => {
      await reg({ email: 'taken@example.com', orgs: [pick(o.aspire)] });
      const p = await reg({ email: 'me@example.com', orgs: [pick(o.windy)] });
      const { error } = await db.rpc('update_attendee', {
        p_id: p, p: payload({ email: 'TAKEN@example.com', orgs: [pick(o.windy)] }),
      });
      assert.equal(error.message, 'DUPLICATE_EMAIL');
    });

    test('may keep a link to a pending organisation by id', async () => {
      const rainbow = (await seedOrgs(db, {
        rainbow: { kind: 'factory', name: 'Rainbow Knit Ltd', status: 'pending', source: 'attendee', code: 'RNB' },
      })).rainbow;
      const p = await reg({ email: 'r@example.com', orgs: [pick(o.aspire)] });
      await check(db.rpc('update_attendee', {
        p_id: p, p: payload({ orgs: [pick(o.aspire), pick(rainbow)] }),
      }));
      const links = await check(db.from('attendee_orgs').select('code').eq('attendee_id', p).eq('org_id', rainbow.id));
      assert.deepEqual(links, [{ code: 'RNB' }]);
    });

    test('removing the last link to a pending organisation deletes it', async () => {
      const rainbow = (await seedOrgs(db, {
        rainbow: { kind: 'factory', name: 'Rainbow Knit Ltd', status: 'pending', source: 'attendee', code: 'RNB' },
      })).rainbow;
      const p = await reg({ email: 'r@example.com', orgs: [pick(o.aspire)] });
      await check(db.rpc('update_attendee', { p_id: p, p: payload({ orgs: [pick(o.aspire), pick(rainbow)] }) }));
      await check(db.rpc('update_attendee', { p_id: p, p: payload({ orgs: [pick(o.aspire)] }) }));
      assert.equal(await pendingOrg('rainbow knit'), undefined);
    });

    test('an unknown attendee raises NOT_FOUND', async () => {
      const { error } = await db.rpc('update_attendee', {
        p_id: MISSING_UUID, p: payload({ orgs: [pick(o.aspire)] }),
      });
      assert.equal(error.message, 'NOT_FOUND');
    });

    test('an attendee at an over-limit org (after merge anyway) can still be edited', async () => {
      const f1 = await reg({ email: 'f1@example.com', orgs: [pick(o.aspire)] });
      const copy = (await seedOrgs(db, {
        copy: { kind: 'factory', name: 'Aspire Copy', status: 'pending', source: 'attendee', code: 'COPY' },
      })).copy;
      const f2 = await reg({ email: 'f2@example.com', orgs: [pick(o.windy)] });
      await check(db.rpc('update_attendee', { p_id: f2, p: payload({ email: 'f2@example.com', orgs: [pick(o.windy), pick(copy)] }) }));
      await check(db.rpc('merge_org', { p_source: copy.id, p_target: o.aspire.id, p_allow_over_limit: true }));
      assert.equal((await seats(db, o.aspire.id)).seats_used, 2);

      await check(db.rpc('update_attendee', {
        p_id: f1,
        p: payload({ name: 'Renamed', email: 'f1@example.com', orgs: [pick(o.aspire)] }),
      }));
      const [row] = await check(db.from('attendees').select('name').eq('id', f1));
      assert.equal(row.name, 'Renamed');

      const f4 = await reg({ from: 'supplier', email: 'f4@example.com', orgs: [pick(o.padma)] });
      const { error } = await db.rpc('update_attendee', {
        p_id: f4,
        p: payload({ from: 'factory', email: 'f4@example.com', orgs: [pick(o.padma), pick(o.aspire)] }),
      });
      assert.equal(error.message, 'SEAT_FULL');
      assert.deepEqual(JSON.parse(error.details), { side: 'factory', orgs: ['Aspire Garments (24040)'] });
    });

    test('an attendee can be switched to "other": links removed, seats freed, organisation stored', async () => {
      const p = await reg({ orgs: [pick(o.aspire)] });
      await check(db.rpc('update_attendee', {
        p_id: p,
        p: payload({ from: 'other', orgs: [], organisation_name: 'Primark Limited' }),
      }));
      assert.equal((await seats(db, o.aspire.id)).seats_used, 0);
      const [row] = await check(db.from('attendees').select('from_type, organisation_name').eq('id', p));
      assert.deepEqual(row, { from_type: 'other', organisation_name: 'Primark Limited' });
    });

    test('updating the photo_path replaces the stored value', async () => {
      const p = await reg({ orgs: [pick(o.aspire)], photo_path: PHOTO_A });
      await check(db.rpc('update_attendee', {
        p_id: p, p: payload({ orgs: [pick(o.aspire)], photo_path: PHOTO_B }),
      }));
      const [row] = await check(db.from('attendees').select('photo_path').eq('id', p));
      assert.equal(row.photo_path, PHOTO_B);
    });

    test('only removes pending organisations the person was linked to', async () => {
      const { unrelated } = await seedOrgs(db, { unrelated: { kind: 'factory', name: 'Unrelated Pending', status: 'pending', source: 'attendee' } });
      const rainbow = (await seedOrgs(db, {
        rainbow: { kind: 'factory', name: 'Rainbow Knit Ltd', status: 'pending', source: 'attendee' },
      })).rainbow;
      const p = await reg({ email: 'r@example.com', orgs: [pick(o.aspire)] });
      await check(db.rpc('update_attendee', { p_id: p, p: payload({ orgs: [pick(o.aspire), pick(rainbow)] }) }));
      await check(db.rpc('update_attendee', { p_id: p, p: payload({ orgs: [pick(o.aspire)] }) }));
      assert.equal(await pendingOrg('rainbow knit'), undefined);
      assert.ok(await pendingOrg(unrelated.match_key), 'an edit must not delete unrelated pending organisations');
      await check(db.rpc('delete_attendee', { p_id: p }));
      assert.ok(await pendingOrg(unrelated.match_key), 'a delete must not delete unrelated pending organisations');
    });
  });

  describe('delete_attendee', () => {
    test('frees seats and removes pending organisations left with no links', async () => {
      const p = await reg({ orgs: [pick(o.aspire)] });
      await check(db.rpc('delete_attendee', { p_id: p }));
      assert.deepEqual(await seats(db, o.aspire.id), { seats_used: 0, linked_count: 0 });
    });

    test('an unknown attendee raises NOT_FOUND', async () => {
      const { error } = await db.rpc('delete_attendee', { p_id: MISSING_UUID });
      assert.equal(error.message, 'NOT_FOUND');
    });
  });

  describe('approve_org', () => {
    test('approves a pending organisation once', async () => {
      const rainbow = (await seedOrgs(db, {
        rainbow: { kind: 'factory', name: 'Rainbow Knit Ltd', status: 'pending', source: 'attendee' },
      })).rainbow;
      await check(db.rpc('approve_org', { p_id: rainbow.id }));
      assert.equal((await pendingOrg('rainbow knit')).status, 'approved');
      const again = await db.rpc('approve_org', { p_id: rainbow.id });
      assert.equal(again.error.message, 'NOT_FOUND');
    });
  });

  describe('merge_org', () => {
    test('moves links, removes duplicates, keeps the target code and deletes the source', async () => {
      const source = (await seedOrgs(db, {
        copy: { kind: 'supplier', name: 'Padma Textiles Copy', status: 'pending', source: 'attendee', code: 'COPY' },
      })).copy;
      const both = await reg({ from: 'supplier', email: 'both@example.com', orgs: [pick(o.padma)] });
      const onlySource = await reg({ from: 'supplier', email: 'src@example.com', orgs: [pick(o.pearl)] });
      await check(db.rpc('update_attendee', { p_id: both, p: payload({ from: 'supplier', email: 'both@example.com', orgs: [pick(o.padma), pick(source)] }) }));
      await check(db.rpc('update_attendee', { p_id: onlySource, p: payload({ from: 'supplier', email: 'src@example.com', orgs: [pick(o.pearl), pick(source)] }) }));

      const count = await check(db.rpc('merge_org', { p_source: source.id, p_target: o.padma.id, p_allow_over_limit: false }));
      assert.equal(count, 2);

      const links = await check(db.from('attendee_orgs').select('attendee_id, code').eq('org_id', o.padma.id));
      const byPerson = Object.fromEntries(links.map((l) => [l.attendee_id, l.code]));
      assert.deepEqual(byPerson, { [both]: '83760', [onlySource]: 'COPY' });
      assert.equal(await pendingOrg('padma textiles copy'), undefined);
    });

    test('refuses to go over the per-kind limit unless allowed', async () => {
      const source = (await seedOrgs(db, {
        copy: { kind: 'factory', name: 'Aspire Copy', status: 'pending', source: 'attendee', code: 'COPY' },
      })).copy;
      await reg({ email: 'f1@example.com', orgs: [pick(o.aspire)] });
      const p2 = await reg({ email: 'f2@example.com', orgs: [pick(o.windy)] });
      await check(db.rpc('update_attendee', { p_id: p2, p: payload({ email: 'f2@example.com', orgs: [pick(o.windy), pick(source)] }) }));

      const refused = await db.rpc('merge_org', { p_source: source.id, p_target: o.aspire.id, p_allow_over_limit: false });
      assert.equal(refused.error.message, 'MERGE_OVER_LIMIT');
      assert.deepEqual(JSON.parse(refused.error.details), { target: 'Aspire Garments (24040)', side: 'factory', count: 2 });
      assert.ok(await pendingOrg('aspire copy'), 'source must remain after a refused merge');

      const unset = await db.rpc('merge_org', { p_source: source.id, p_target: o.aspire.id, p_allow_over_limit: null });
      assert.equal(unset.error?.message, 'MERGE_OVER_LIMIT', 'a NULL allow flag must count as false');

      const count = await check(db.rpc('merge_org', { p_source: source.id, p_target: o.aspire.id, p_allow_over_limit: true }));
      assert.equal(count, 2);
      assert.equal((await seats(db, o.aspire.id)).seats_used, 2);
    });

    test('rejects a target of another kind and a source that is not pending', async () => {
      const rainbow = (await seedOrgs(db, {
        rainbow: { kind: 'factory', name: 'Rainbow Knit Ltd', status: 'pending', source: 'attendee' },
      })).rainbow;
      const wrongKind = await db.rpc('merge_org', { p_source: rainbow.id, p_target: o.padma.id, p_allow_over_limit: false });
      assert.equal(wrongKind.error.message, 'VALIDATION');
      const notPending = await db.rpc('merge_org', { p_source: o.windy.id, p_target: o.aspire.id, p_allow_over_limit: false });
      assert.equal(notPending.error.message, 'NOT_FOUND');
    });
  });

  test('the publishable (anon) key cannot call admin functions', async () => {
    const p = await reg({ orgs: [pick(o.aspire)] });
    const anon = anonDb();
    assert.ok((await anon.rpc('delete_attendee', { p_id: p })).error);
    assert.ok((await anon.rpc('approve_org', { p_id: o.padma.id })).error);
    assert.ok((await anon.rpc('merge_org', { p_source: o.windy.id, p_target: o.aspire.id, p_allow_over_limit: true })).error);
    assert.ok((await anon.rpc('update_attendee', { p_id: p, p: payload({ orgs: [pick(o.aspire)] }) })).error);
    assert.equal((await check(db.from('attendees').select('id'))).length, 1);
  });
});
