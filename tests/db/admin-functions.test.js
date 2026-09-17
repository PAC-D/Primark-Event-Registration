import { describe, test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  anonDb, check, findOrgs, other, payload, pick, register, seats, seedOrgs, skipReason, testDb, wipe,
} from '../helpers/db.js';

const MISSING_UUID = '00000000-0000-4000-8000-000000000000';

describe('admin database functions', { skip: skipReason }, () => {
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
    });
  });

  const reg = (fields) => check(register(db, payload(fields)));
  const pendingOrg = async (matchKey) => (await findOrgs(db, { match_key: matchKey }))[0];

  describe('update_attendee', () => {
    test('does not count the person\'s own seats', async () => {
      const p1 = await reg({ email: 'p1@example.com', orgs: [pick(o.padma), pick(o.aspire)] });
      await reg({ email: 'p2@example.com', orgs: [pick(o.padma), pick(o.aspire)] });
      await check(db.rpc('update_attendee', {
        p_id: p1,
        p: payload({ name: 'Renamed', email: 'p1@example.com', orgs: [pick(o.padma), pick(o.aspire, 'NEW')] }),
      }));
      const [row] = await check(db.from('attendees').select('name').eq('id', p1));
      assert.equal(row.name, 'Renamed');
      assert.equal((await seats(db, o.aspire.id)).seats_used, 2);
    });

    test('switching from_type re-checks seats on the other side', async () => {
      await reg({ from: 'supplier', email: 's1@example.com', orgs: [pick(o.padma), pick(o.aspire)] });
      await reg({ from: 'supplier', email: 's2@example.com', orgs: [pick(o.padma), pick(o.aspire)] });
      const f = await reg({ from: 'factory', email: 'f@example.com', orgs: [pick(o.padma), pick(o.windy)] });
      const { error } = await db.rpc('update_attendee', {
        p_id: f,
        p: payload({ from: 'supplier', email: 'f@example.com', orgs: [pick(o.padma), pick(o.windy)] }),
      });
      assert.equal(error.message, 'SEAT_FULL');
      assert.deepEqual(JSON.parse(error.details), { side: 'supplier', orgs: ['Padma Textiles Ltd'] });
    });

    test('rejects another person\'s email with DUPLICATE_EMAIL', async () => {
      await reg({ email: 'taken@example.com', orgs: [pick(o.padma), pick(o.aspire)] });
      const p = await reg({ email: 'me@example.com', orgs: [pick(o.pearl), pick(o.windy)] });
      const { error } = await db.rpc('update_attendee', {
        p_id: p, p: payload({ email: 'TAKEN@example.com', orgs: [pick(o.pearl), pick(o.windy)] }),
      });
      assert.equal(error.message, 'DUPLICATE_EMAIL');
    });

    test('may keep a link to a pending organisation by id', async () => {
      const p = await reg({ orgs: [pick(o.padma), other('factory', 'Rainbow Knit Ltd')] });
      const rainbow = await pendingOrg('rainbow knit');
      await check(db.rpc('update_attendee', {
        p_id: p, p: payload({ orgs: [pick(o.padma), pick(rainbow, 'R-2')] }),
      }));
      const links = await check(db.from('attendee_orgs').select('code').eq('attendee_id', p).eq('org_id', rainbow.id));
      assert.deepEqual(links, [{ code: 'R-2' }]);
    });

    test('removing the last link to a pending organisation deletes it', async () => {
      const p = await reg({ orgs: [pick(o.padma), other('factory', 'Rainbow Knit Ltd')] });
      await check(db.rpc('update_attendee', { p_id: p, p: payload({ orgs: [pick(o.padma), pick(o.aspire)] }) }));
      assert.equal(await pendingOrg('rainbow knit'), undefined);
    });

    test('an unknown attendee raises NOT_FOUND', async () => {
      const { error } = await db.rpc('update_attendee', {
        p_id: MISSING_UUID, p: payload({ orgs: [pick(o.padma), pick(o.aspire)] }),
      });
      assert.equal(error.message, 'NOT_FOUND');
    });

    test('an attendee at an over-limit org (after merge anyway) can still be edited', async () => {
      const f1 = await reg({ email: 'f1@example.com', orgs: [pick(o.padma), pick(o.aspire)] });
      await reg({ email: 'f2@example.com', orgs: [pick(o.padma), pick(o.aspire)] });
      await reg({ email: 'f3@example.com', orgs: [pick(o.padma), other('factory', 'Aspire Copy')] });
      const source = await pendingOrg('aspire copy');
      await check(db.rpc('merge_org', { p_source: source.id, p_target: o.aspire.id, p_allow_over_limit: true }));
      assert.equal((await seats(db, o.aspire.id)).seats_used, 3);

      await check(db.rpc('update_attendee', {
        p_id: f1,
        p: payload({ name: 'Renamed', email: 'f1@example.com', orgs: [pick(o.padma), pick(o.aspire)] }),
      }));
      const [row] = await check(db.from('attendees').select('name').eq('id', f1));
      assert.equal(row.name, 'Renamed');

      const f4 = await reg({ email: 'f4@example.com', orgs: [pick(o.padma), pick(o.windy)] });
      const { error } = await db.rpc('update_attendee', {
        p_id: f4,
        p: payload({ email: 'f4@example.com', orgs: [pick(o.padma), pick(o.windy), pick(o.aspire)] }),
      });
      assert.equal(error.message, 'SEAT_FULL');
      assert.deepEqual(JSON.parse(error.details), { side: 'factory', orgs: ['Aspire Garments (24040)'] });
    });

    test('only removes pending organisations the person was linked to', async () => {
      const { unrelated } = await seedOrgs(db, { unrelated: { kind: 'factory', name: 'Unrelated Pending', status: 'pending', source: 'attendee' } });
      const p = await reg({ orgs: [pick(o.padma), other('factory', 'Rainbow Knit Ltd')] });
      await check(db.rpc('update_attendee', { p_id: p, p: payload({ orgs: [pick(o.padma), pick(o.aspire)] }) }));
      assert.equal(await pendingOrg('rainbow knit'), undefined);
      assert.ok(await pendingOrg(unrelated.match_key), 'an edit must not delete unrelated pending organisations');
      await check(db.rpc('delete_attendee', { p_id: p }));
      assert.ok(await pendingOrg(unrelated.match_key), 'a delete must not delete unrelated pending organisations');
    });
  });

  describe('delete_attendee', () => {
    test('frees seats and removes pending organisations left with no links', async () => {
      const p = await reg({ orgs: [pick(o.padma), pick(o.aspire), other('factory', 'Rainbow Knit Ltd')] });
      await check(db.rpc('delete_attendee', { p_id: p }));
      assert.deepEqual(await seats(db, o.aspire.id), { seats_used: 0, linked_count: 0 });
      assert.equal(await pendingOrg('rainbow knit'), undefined);
    });

    test('an unknown attendee raises NOT_FOUND', async () => {
      const { error } = await db.rpc('delete_attendee', { p_id: MISSING_UUID });
      assert.equal(error.message, 'NOT_FOUND');
    });
  });

  describe('approve_org', () => {
    test('approves a pending organisation once', async () => {
      await reg({ orgs: [pick(o.padma), other('factory', 'Rainbow Knit Ltd')] });
      const rainbow = await pendingOrg('rainbow knit');
      await check(db.rpc('approve_org', { p_id: rainbow.id }));
      assert.equal((await pendingOrg('rainbow knit')).status, 'approved');
      const again = await db.rpc('approve_org', { p_id: rainbow.id });
      assert.equal(again.error.message, 'NOT_FOUND');
    });
  });

  describe('merge_org', () => {
    test('moves links, removes duplicates, keeps the target code and deletes the source', async () => {
      const both = await reg({ email: 'both@example.com', orgs: [pick(o.padma), pick(o.aspire, 'TARGET'), other('factory', 'Aspire Garment X', 'SOURCE')] });
      const onlySource = await reg({ email: 'src@example.com', orgs: [pick(o.pearl), other('factory', 'Aspire Garment X', 'S2')] });
      const source = await pendingOrg('aspire garment x');

      const count = await check(db.rpc('merge_org', { p_source: source.id, p_target: o.aspire.id, p_allow_over_limit: false }));
      assert.equal(count, 2);

      const links = await check(db.from('attendee_orgs').select('attendee_id, code').eq('org_id', o.aspire.id));
      const byPerson = Object.fromEntries(links.map((l) => [l.attendee_id, l.code]));
      assert.deepEqual(byPerson, { [both]: 'TARGET', [onlySource]: 'S2' });
      assert.equal(await pendingOrg('aspire garment x'), undefined);
    });

    test('refuses to go over the limit unless allowed', async () => {
      await reg({ email: 'f1@example.com', orgs: [pick(o.padma), pick(o.aspire)] });
      await reg({ email: 'f2@example.com', orgs: [pick(o.padma), pick(o.aspire)] });
      await reg({ email: 'f3@example.com', orgs: [pick(o.padma), other('factory', 'Aspire Copy')] });
      const source = await pendingOrg('aspire copy');

      const refused = await db.rpc('merge_org', { p_source: source.id, p_target: o.aspire.id, p_allow_over_limit: false });
      assert.equal(refused.error.message, 'MERGE_OVER_LIMIT');
      assert.deepEqual(JSON.parse(refused.error.details), { target: 'Aspire Garments (24040)', side: 'factory', count: 3 });
      assert.ok(await pendingOrg('aspire copy'), 'source must remain after a refused merge');

      const unset = await db.rpc('merge_org', { p_source: source.id, p_target: o.aspire.id, p_allow_over_limit: null });
      assert.equal(unset.error?.message, 'MERGE_OVER_LIMIT', 'a NULL allow flag must count as false');

      const count = await check(db.rpc('merge_org', { p_source: source.id, p_target: o.aspire.id, p_allow_over_limit: true }));
      assert.equal(count, 3);
      assert.equal((await seats(db, o.aspire.id)).seats_used, 3);
    });

    test('rejects a target of another kind and a source that is not pending', async () => {
      await reg({ orgs: [pick(o.padma), other('factory', 'Rainbow Knit Ltd')] });
      const rainbow = await pendingOrg('rainbow knit');
      const wrongKind = await db.rpc('merge_org', { p_source: rainbow.id, p_target: o.padma.id, p_allow_over_limit: false });
      assert.equal(wrongKind.error.message, 'VALIDATION');
      const notPending = await db.rpc('merge_org', { p_source: o.windy.id, p_target: o.aspire.id, p_allow_over_limit: false });
      assert.equal(notPending.error.message, 'NOT_FOUND');
    });
  });

  test('the publishable (anon) key cannot call admin functions', async () => {
    const p = await reg({ orgs: [pick(o.padma), pick(o.aspire)] });
    const anon = anonDb();
    assert.ok((await anon.rpc('delete_attendee', { p_id: p })).error);
    assert.ok((await anon.rpc('approve_org', { p_id: o.padma.id })).error);
    assert.ok((await anon.rpc('merge_org', { p_source: o.windy.id, p_target: o.aspire.id, p_allow_over_limit: true })).error);
    assert.ok((await anon.rpc('update_attendee', { p_id: p, p: payload({ orgs: [pick(o.padma), pick(o.aspire)] }) })).error);
    assert.equal((await check(db.from('attendees').select('id'))).length, 1);
  });
});
