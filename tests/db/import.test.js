import { describe, test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { importOrganisations } from '../../src/services/import.js';
import { check, findOrgs, seedOrgs, skipReason, testDb, wipe } from '../helpers/db.js';

describe('importOrganisations against the test database', { skip: skipReason }, () => {
  let db;
  before(() => { db = testDb(); });
  beforeEach(() => wipe(db));

  test('inserts list organisations once, with codes, and is safe to re-run', async () => {
    const orgs = [
      { kind: 'supplier', name: 'PADMA TEXTILES LTD', code: '83760' },
      { kind: 'factory', name: 'Aspire Garments Ltd PJT (24040)', code: '24040' },
      { kind: 'supplier', name: 'Padma Textiles Limited', code: '99999' },
    ];
    assert.deepEqual(await importOrganisations(db, orgs), { read: 3, inserted: 2, pruned: 0 });
    assert.deepEqual(await importOrganisations(db, orgs), { read: 3, inserted: 0, pruned: 0 });
    const rows = await findOrgs(db, { source: 'list' });
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.status === 'approved'));
    const padma = rows.find((row) => row.match_key === 'padma textiles');
    assert.equal(padma.code, '83760');
  });

  test('refreshes the code of an existing list organisation', async () => {
    await importOrganisations(db, [{ kind: 'supplier', name: 'Padma Textiles Ltd', code: '83760' }]);
    assert.deepEqual(
      await importOrganisations(db, [{ kind: 'supplier', name: 'PADMA TEXTILES LTD', code: '11111' }]),
      { read: 1, inserted: 0, pruned: 0 },
    );
    const [padma] = await findOrgs(db, { match_key: 'padma textiles' });
    assert.equal(padma.code, '11111');
    assert.equal(padma.name, 'Padma Textiles Ltd');
  });

  test('prunes list organisations that left the files, unless an attendee links to them', async () => {
    const { old, linked } = await seedOrgs(db, {
      old: { kind: 'supplier', name: 'Old Supplier', code: '00001' },
      linked: { kind: 'supplier', name: 'Linked Supplier', code: '00002' },
    });
    const [person] = await check(db.from('attendees')
      .insert({ name: 'P', email: 'p@example.com', phone: '1234567', from_type: 'supplier', designation: 'D' })
      .select('id'));
    await check(db.from('attendee_orgs').insert({ attendee_id: person.id, org_id: linked.id, code: '00002' }));

    const result = await importOrganisations(db, [{ kind: 'supplier', name: 'Fresh Supplier', code: '00003' }]);
    assert.deepEqual(result, { read: 1, inserted: 1, pruned: 1 });

    const names = (await findOrgs(db, {})).map((row) => row.name);
    assert.ok(!names.includes('Old Supplier'), 'an unlinked stale org is pruned');
    assert.ok(names.includes('Linked Supplier'), 'a linked stale org is kept');
  });

  test('leaves an existing pending organisation with the same key untouched', async () => {
    await seedOrgs(db, { rainbow: { kind: 'factory', name: 'Rainbow Knit Ltd', status: 'pending', source: 'attendee' } });
    assert.deepEqual(
      await importOrganisations(db, [{ kind: 'factory', name: 'RAINBOW KNIT LIMITED', code: '42424' }]),
      { read: 1, inserted: 0, pruned: 0 },
    );
    const [row] = await findOrgs(db, { match_key: 'rainbow knit' });
    assert.equal(row.status, 'pending');
    assert.equal(row.source, 'attendee');
    assert.equal(row.name, 'Rainbow Knit Ltd');
    assert.equal(row.code, null);
  });
});
