import { describe, test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { anonDb, check, seedOrgs, seats, skipReason, testDb, wipe } from '../helpers/db.js';

describe('schema', { skip: skipReason }, () => {
  let db;
  before(() => { db = testDb(); });
  beforeEach(() => wipe(db));

  test('match_key ignores case, punctuation and Ltd/Limited', async () => {
    const orgs = await seedOrgs(db, {
      hopLun: { kind: 'supplier', name: 'Hop Lun (H.K.) LTD.' },
      modele: { kind: 'factory', name: 'Modele De Capital Ind Ltd (Unit 2) (26088)' },
      colour: { kind: 'factory', name: 'Colour & Co Limited' },
      htl: { kind: 'supplier', name: 'HTL FASHION HAZIR GIYIM SAN.TIC.LTD.STI' },
    });
    assert.equal(orgs.hopLun.match_key, 'hop lun h k');
    assert.equal(orgs.modele.match_key, 'modele de capital ind unit 2 26088');
    assert.equal(orgs.colour.match_key, 'colour and co');
    assert.equal(orgs.htl.match_key, 'htl fashion hazir giyim san tic sti');
  });

  test('a match_key is unique per kind but may repeat across kinds', async () => {
    await seedOrgs(db, { padma: { kind: 'supplier', name: 'Padma Textiles Ltd' } });
    const duplicate = await db.from('organisations')
      .insert({ kind: 'supplier', name: 'PADMA TEXTILES LIMITED', source: 'list', status: 'approved' });
    assert.equal(duplicate.error?.code, '23505');
    const otherKind = await db.from('organisations')
      .insert({ kind: 'factory', name: 'Padma Textiles', source: 'list', status: 'approved' });
    assert.equal(otherKind.error, null);
  });

  test('attendee email is unique regardless of letter case', async () => {
    await check(db.from('attendees').insert({ name: 'A', email: 'Rahim@Example.com', phone: '1234567', from_type: 'factory' }));
    const duplicate = await db.from('attendees')
      .insert({ name: 'B', email: 'rahim@example.com', phone: '1234567', from_type: 'supplier' });
    assert.equal(duplicate.error?.code, '23505');
  });

  test('from_type accepts supplier, factory and other but nothing else', async () => {
    await check(db.from('attendees').insert({ name: 'A', email: 'a@example.com', phone: '1234567', from_type: 'other', organisation_name: 'Primark Limited' }));
    const bad = await db.from('attendees')
      .insert({ name: 'B', email: 'b@example.com', phone: '1234567', from_type: 'buyer' });
    assert.equal(bad.error?.code, '23514');
  });

  test('designation defaults to an empty string and photo_path is nullable', async () => {
    const [row] = await check(db.from('attendees')
      .insert({ name: 'A', email: 'a@example.com', phone: '1234567', from_type: 'supplier' })
      .select('designation, organisation_name, photo_path'));
    assert.deepEqual(row, { designation: '', organisation_name: null, photo_path: null });
  });

  test('organisations carry an optional list code', async () => {
    const orgs = await seedOrgs(db, {
      coded: { kind: 'supplier', name: 'Padma Textiles Ltd', code: '83760' },
      uncoded: { kind: 'supplier', name: 'Pearl Global' },
    });
    assert.equal(orgs.coded.code, '83760');
    assert.equal(orgs.uncoded.code, null);
  });

  test('org_status counts seats only for attendees from the matching side', async () => {
    const orgs = await seedOrgs(db, { aspire: { kind: 'factory', name: 'Aspire Garments (24040)', code: '24040' } });
    const people = await check(db.from('attendees').insert([
      { name: 'Factory Person', email: 'f@example.com', phone: '1234567', from_type: 'factory', designation: 'F' },
      { name: 'Supplier Person', email: 's@example.com', phone: '1234567', from_type: 'supplier', designation: 'S' },
    ]).select('id'));
    await check(db.from('attendee_orgs').insert(
      people.map((p) => ({ attendee_id: p.id, org_id: orgs.aspire.id, code: '24040' })),
    ));
    assert.deepEqual(await seats(db, orgs.aspire.id), { seats_used: 1, linked_count: 2 });
  });

  test('the attendee-photos bucket accepts, serves and deletes a JPEG via the service key', async () => {
    const PROBE = 'probe-00000000-0000-4000-8000-000000000000.jpg';
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.alloc(64)]);
    const up = await db.storage.from('attendee-photos').upload(PROBE, buf, { contentType: 'image/jpeg' });
    assert.equal(up.error, null, `upload failed: ${up.error?.message}`);
    const down = await db.storage.from('attendee-photos').download(PROBE);
    assert.equal(down.error, null, `download failed: ${down.error?.message}`);
    assert.equal((await down.data.arrayBuffer()).byteLength, buf.length);
    const del = await db.storage.from('attendee-photos').remove([PROBE]);
    assert.equal(del.error, null, `remove failed: ${del.error?.message}`);
  });

  test('the publishable (anon) key cannot read or write any table or the view', async () => {
    await seedOrgs(db, { aspire: { kind: 'factory', name: 'Aspire Garments (24040)' } });
    const anon = anonDb();
    for (const table of ['organisations', 'attendees', 'attendee_orgs', 'org_status']) {
      const { data, error } = await anon.from(table).select('*');
      assert.ok(error || data.length === 0, `${table} must not be readable with the anon key`);
    }
    const write = await anon.from('organisations')
      .insert({ kind: 'factory', name: 'Sneaky', source: 'list', status: 'approved' });
    assert.ok(write.error, 'anon insert must fail');
  });
});
